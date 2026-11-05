/**
 * 처리되지 않은 오류 (SERVER_DESIGN 3.2, S2-5, S2-11 rejection): 서버가 준비된 뒤 처리되지 않은 Promise 거부와 예외가 나도 가린 기록만 남기고 계속 답한다.
 * Node는 처리기가 없으면 거부 하나에도 프로세스를 끝낸다. 오류는 `--import`로 먼저 불러온 시험 모듈이 서버 준비(관리 토큰 파일) 뒤에 낸다 — 제품 코드에 시험용 길을 두지 않는다
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServerTo, clientJson, invokeHttp, issueTokenBuilt, removeDir, runClient, sleep, startBuilt, testBuildDir, type BuiltServer } from './helpers';

const SECRET = 'wook-hook-secret-value-9d27';
const FAKE_TOKEN = `wos_${'Q'.repeat(43)}`;
const HOOK = `import { existsSync } from 'node:fs';
import { join } from 'node:path';
const dir = process.argv[process.argv.indexOf('--data-dir') + 1];
const timer = setInterval(() => {
  if (!existsSync(join(dir, 'admin.token'))) return;
  clearInterval(timer);
  Promise.reject(new Error('시험용 거부 api_key=${SECRET}'));
  setTimeout(() => { throw new Error('시험용 예외 ${FAKE_TOKEN}'); }, 50);
}, 50);
timer.unref();
`;

let buildDir = '';
let entry = '';
let dataDir = '';
let hookDir = '';
let srv: BuiltServer | null = null;

beforeAll(() => {
  buildDir = testBuildDir('rejection');
  entry = buildServerTo(buildDir);
  hookDir = mkdtempSync(join(tmpdir(), 'wook-test-hook-'));
  writeFileSync(join(hookDir, 'reject-hook.mjs'), HOOK);
  dataDir = mkdtempSync(join(tmpdir(), 'wook-test-rejection-'));
}, 120_000);

afterAll(async () => {
  if (srv && srv.child.exitCode === null && srv.child.signalCode === null) {
    runClient(entry, ['shutdown', '--data-dir', dataDir]);
    await Promise.race([srv.exited, new Promise((r) => setTimeout(r, 40_000))]);
    if (srv.child.exitCode === null) srv.child.kill();
  }
  for (const d of [dataDir, hookDir, buildDir]) if (d) await removeDir(d);
});

describe('처리되지 않은 오류', () => {
  it('처리되지 않은 거부와 예외를 가려서 기록하고, 서버는 계속 HTTP와 관리 채널에 답한다', async () => {
    srv = await startBuilt({ entry, dataDir, args: ['--allow-test-session'], nodeArgs: ['--import', pathToFileURL(join(hookDir, 'reject-hook.mjs')).href] });
    const logFile = join(dataDir, 'logs', 'server.log');
    const deadline = Date.now() + 20_000;
    let log = '';
    while (Date.now() < deadline) {
      log = readFileSync(logFile, 'utf8');
      if (log.includes('처리되지 않은 Promise 거부 (서버)') && log.includes('처리되지 않은 예외 (서버)')) break;
      await sleep(100);
    }
    expect(log).toContain('처리되지 않은 Promise 거부 (서버)');
    expect(log).toContain('처리되지 않은 예외 (서버)');
    expect(log).toContain('시험용 거부');
    // 기록에는 가린 값만
    expect(log.includes(SECRET)).toBe(false);
    expect(log.includes(FAKE_TOKEN)).toBe(false);
    expect(log).toContain('wos_[가림]');

    // 프로세스가 살아 있고 계속 답한다
    await sleep(300);
    expect(srv.child.exitCode).toBeNull();
    const st = clientJson(entry, ['status', '--data-dir', dataDir]);
    expect([st.code, (st.reply.result as { runId?: string })?.runId]).toEqual([0, srv.runId]);
    const token = issueTokenBuilt(entry, dataDir);
    expect((await invokeHttp(srv.url, token, 'auth.getState')).status).toBe(200);

    expect(runClient(entry, ['shutdown', '--data-dir', dataDir]).code).toBe(0);
    expect((await srv.exited).code).toBe(0);
  }, 120_000);
});
