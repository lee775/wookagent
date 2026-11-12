/**
 * 빌드한 서버의 시험용 미리 불러오기 — 배포 점검 (리드 결정 S9-4·S9-11 deployCheck). 시험이 `node --require <이 파일> out/…/index.mjs serve …`로 띄운다.
 * 제품 코드에는 시험 스위치를 두지 않는다 — 바꾸는 것은 이 프로세스 안의 child_process.execFile뿐이다(ESM 이름도 맞춘다 — syncBuiltinESMExports).
 * - powershell.exe(점검 스크립트) → 실제로 띄우지 않고 WOOK_TEST_PROBE_LOG에 한 줄 적은 뒤, WOOK_TEST_PROBE_RELEASE 파일이 생길 때까지 답하지 않는다.
 *   생기면 WOOK_TEST_PROBE_ANSWER 파일의 글(점검 JSON)로 답한다(WOOK_TEST_PROBE_DELAY_MS만큼 늦게 — 늦춘 시험). 서버가 그만두게 하면(AbortSignal)
 *   'powershell aborted'를 적고 AbortError
 * - claude·codex(CLI 상태 확인과 시작 때 CLI 확인) → 띄우지 않고 한 줄 적은 뒤 ENOENT로 답한다 — 이 PC의 실제 CLI를 부르지 않는다
 * - WOOK_TEST_HOLD_READY_MS가 있으면 준비 줄('욱채 서버 준비 완료')의 표준 출력 쓰기는 바로 내보내되 그 끝(콜백)을 점검 스크립트가 불릴 때까지(그 ms까지만)
 *   붙잡는다 — 그리고 'ready-written after-probe|timeout'을 적는다. 서버가 준비 줄 쓰기를 기다리지 않고 점검을 거는지 본다 (리드 결정 S9-22 DF-11)
 * 그 밖의 execFile(git·icacls 등)은 그대로다
 */
'use strict';
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { syncBuiltinESMExports } = require('node:module');

const log = process.env.WOOK_TEST_PROBE_LOG;
const release = process.env.WOOK_TEST_PROBE_RELEASE;
const answer = process.env.WOOK_TEST_PROBE_ANSWER;
const delay = Number(process.env.WOOK_TEST_PROBE_DELAY_MS || '0');
if (!log || !release || !answer) throw new Error('fakeProbePreload: WOOK_TEST_PROBE_LOG·WOOK_TEST_PROBE_RELEASE·WOOK_TEST_PROBE_ANSWER가 있어야 합니다');

const fakeChild = () => ({ pid: 0, kill: () => false, on: () => undefined, once: () => undefined });
const realExecFile = cp.execFile;
/** 점검 스크립트가 불렸는지 (준비 줄 붙잡기가 본다) */
let probeCalled = false;

const holdReadyMs = Number(process.env.WOOK_TEST_HOLD_READY_MS || '0');
if (holdReadyMs > 0) {
  const realWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = function write(chunk, encoding, callback) {
    const cb = typeof encoding === 'function' ? encoding : callback;
    if (typeof chunk !== 'string' || !chunk.includes('욱채 서버 준비 완료') || typeof cb !== 'function') return realWrite(chunk, encoding, callback);
    // 글은 바로 내보내고(시험이 준비 줄을 본다), 끝은 점검이 불릴 때까지 붙잡는다
    const ok = realWrite(chunk, typeof encoding === 'string' ? encoding : 'utf8');
    const until = Date.now() + holdReadyMs;
    const timer = setInterval(() => {
      if (!probeCalled && Date.now() < until) return;
      clearInterval(timer);
      fs.appendFileSync(log, `ready-written ${probeCalled ? 'after-probe' : 'timeout'}\n`);
      cb();
    }, 20);
    return ok;
  };
}
cp.execFile = function execFile(file, args, options, callback) {
  if (typeof args === 'function') {
    callback = args;
    args = [];
    options = {};
  } else if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  const base = path.basename(String(file)).toLowerCase();
  if (base === 'powershell.exe') {
    probeCalled = true;
    fs.appendFileSync(log, `powershell ${(args || []).slice(0, 3).join(' ')}\n`);
    const signal = options && options.signal;
    let done = false;
    const timer = setInterval(() => {
      if (!done && fs.existsSync(release)) {
        done = true;
        clearInterval(timer);
        setTimeout(() => callback(null, fs.readFileSync(answer, 'latin1'), ''), delay);
      }
    }, 50);
    // 그만두기는 abort() 그 자리에서(동기로) 적는다 — 서버가 바로 끝나도 적힌다 (폴링으로 보면 끝나는 빠르기에 달린다 — 늦춘 시험에서 찾음)
    if (signal) {
      signal.addEventListener(
        'abort',
        () => {
          if (done) return;
          done = true;
          clearInterval(timer);
          fs.appendFileSync(log, 'powershell aborted\n');
          const e = new Error('The operation was aborted');
          e.name = 'AbortError';
          e.code = 'ABORT_ERR';
          callback(e, '', '');
        },
        { once: true },
      );
    }
    return fakeChild();
  }
  if (/^(claude|codex)(\.exe|\.cmd)?$/.test(base)) {
    fs.appendFileSync(log, `${base} ${(args || []).join(' ')}\n`);
    process.nextTick(() => {
      const e = new Error('가짜 CLI — 시험은 이 PC의 실제 CLI를 부르지 않습니다');
      e.code = 'ENOENT';
      callback(e, '', '');
    });
    return fakeChild();
  }
  return realExecFile.apply(this, arguments);
};
syncBuiltinESMExports();
