/**
 * host_exec의 끝내기 (SERVER_DESIGN 8.2, 리드 결정 S5-17·S5-18, AC-15·29):
 * - 긴급 정지는 턴·자동 검사와 함께 서버 명령의 프로세스 트리(직접 자식·고아 개발 서버)를 3초 안에 끝내고 확인한다 — 실제 러너(Windows 작업 개체, POSIX 프로세스 그룹)
 * - 종료를 확인하지 못하면 정지 요약이 완료가 아니고(메인 에이전트의 실패로 적는다), 부른 턴이 kill_failed로 끝나 메인 에이전트가 일시정지된다(CTL-11)
 * - 스스로 끝났는데 하위 프로세스가 남으면 부른 턴에 접는다 — 그 턴에는 더 실행하지 않고, 턴이 끝나면 메인 에이전트가 일시정지된다
 * - 턴이 끝나면(CLI가 먼저 끝나도) 서버 명령을 끝내고 그 기록을 마친 뒤에 턴을 마무리한다. 도는 동안 감시는 응답 없음 대신 명령 상한을 쓴다
 * - 시간 상한, 띄우기 전 거부(실행 환경 문제·백그라운드·다른 서버 명령·자리 교체·거부 목록·request_id), 같은 request_id는 한 번만, 앱 종료도 끝낸다
 * - 아주 긴 한 줄(S5-36)이나 줄바꿈이 촘촘한 빠른 출력(S5-42), 개인 키 표시만 줄바꿈 없이 쏟는 출력(S5-65) 중에도 이벤트 루프가 돌아 타이머가 제때 돌고 긴급
 *   정지가 3초 안에 끝낸다 — 실제 러너. 떠돌이 시작 표시 뒤에 공백 없이 이어 쓴 대입을 쏟아도 가리개가 던지지 않아 결과는 긴급 정지다(S5-83)
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID, type AiConfig } from '@shared/domain';
import { createProcessRunner } from '../../src/main/process/processRunner';
import type { ManagedProcess, ProcessRunner } from '../../src/main/process/types';
import { createProcRig, stillRunning, type ProcRig } from '../acceptance/stops-helpers';
import { bootOrch, sleep, startReview, waitFor, type OrchEnv } from './orchHarness';
import { mainOpsIdentity } from './mainOps';
import { hostExec, hostRecords, liveMainTurn, MAIN_KEY, okData, scriptedHost } from './hostExecRig';

let env: OrchEnv | null = null;
let rig: ProcRig | null = null;
let real: ProcessRunner | null = null;
/** 출력 홍수 시험의 자식 프로세스 핸들과 임시 폴더 — 시험이 실패해도 러너가 가진 핸들로 끝내고 지운다. pid.txt로 끝내지 않는다: 그 자식이 이미 끝났으면 그 PID를 다른
 * 프로세스가 쓸 수 있다(Windows는 PID를 되쓴다 — 리드 결정 S5-52.4) */
const floodProcs: ManagedProcess[] = [];
const floodDirs: string[] = [];
afterEach(async () => {
  await Promise.all(floodProcs.splice(0).map((p) => p.terminate({ timeoutMs: 3000 }).catch(() => undefined)));
  env?.hold.clear();
  await env?.close();
  env = null;
  rig?.cleanup();
  rig = null;
  real?.dispose?.();
  real = null;
  for (const d of floodDirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const win = process.platform === 'win32';
const UNCONFIRMED = { ok: false, remaining: -1, detail: '가짜 종료 확인 실패', durationMs: 1 } as const;
const mainPause = (e: OrchEnv) => e.ctx.stop().members[MAIN_AGENT_ID] ?? null;

/**
 * 줄바꿈이 촘촘한 출력을 쏟는 자식 (리드 결정 S5-42): PID 파일을 쓰고 0.3초 기다린 뒤 짧은 줄(19바이트) 1MiB 묶음을 벽시계로 floodMs 동안 내고, 끝에
 * 'flood end <줄 수>'. 막히는 쓰기라 읽지 않으면 멈춘다 — 시험이 끝나면 afterEach가 끝낸다
 */
const FLOODER = [
  "const fs = require('node:fs');",
  'fs.writeFileSync(process.argv[2], String(process.pid));',
  'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);',
  'const per = 55189;',
  "const b = Buffer.from('build step ok 0123\\n'.repeat(per));",
  'const all = (buf) => { let off = 0; while (off < buf.length) { try { off += fs.writeSync(1, buf, off); } catch (e) { if (e.code !== "EAGAIN") throw e; } } };',
  'const end = Date.now() + Number(process.argv[3]);',
  'let lines = 0;',
  'while (Date.now() < end) { all(b); lines += per; }',
  "all(Buffer.from('flood end ' + lines + '\\n'));",
].join('\n');

/**
 * 개인 키 시작·끝 표시만 줄바꿈 없이 쏟는 자식 (리드 결정 S5-65, 프로브 zz-xs5f5-floodmarkers의 markers-nonl): PID 파일을 쓰고 0.3초 뒤부터 `BEGIN…END` 짝을
 * 1MiB씩 벽시계로 floodMs 동안 낸다. 러너는 이것을 32MiB마다 한 줄로 넘긴다 — 줄마다 표시가 약 110만 개
 */
const FLOODER_MARKERS = [
  "const fs = require('node:fs');",
  'fs.writeFileSync(process.argv[2], String(process.pid));',
  'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);',
  "const b = Buffer.from('-----BEGIN RSA PRIVATE KEY----------END RSA PRIVATE KEY-----'.repeat(17476));",
  'const all = (buf) => { let off = 0; while (off < buf.length) { try { off += fs.writeSync(1, buf, off); } catch (e) { if (e.code !== "EAGAIN") throw e; } } };',
  'const end = Date.now() + Number(process.argv[3]);',
  'while (Date.now() < end) all(b);',
].join('\n');

/**
 * 떠돌이 개인 키 시작 표시 한 줄 뒤에 공백 없이 이어 쓴 대입 줄(`key:` 1,200번·2,500번 + 값 + ' end.')을 번갈아 쏟는 자식 (리드 결정 S5-83, 프로브
 * zz-xs5f8es-floodredact의 redact-near·redact-throw): PID 파일을 쓰고 0.3초 뒤부터 벽시계로 floodMs 동안. 셋째 인자가 줄 끝의 값(만든 가짜 값)이다
 */
const FLOODER_CHAIN = [
  "const fs = require('node:fs');",
  'fs.writeFileSync(process.argv[2], String(process.pid));',
  'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);',
  "const near = Buffer.from('key:'.repeat(1200) + process.argv[4] + ' end.\\n');",
  "const over = Buffer.from('key:'.repeat(2500) + process.argv[4] + ' end.\\n');",
  'const all = (buf) => { let off = 0; while (off < buf.length) { try { off += fs.writeSync(1, buf, off); } catch (e) { if (e.code !== "EAGAIN") throw e; } } };',
  "all(Buffer.from('-----BEGIN RSA PRIVATE KEY-----\\n'));",
  'const end = Date.now() + Number(process.argv[3]);',
  'for (let i = 0; Date.now() < end; i++) all(i % 2 ? over : near);',
].join('\n');

/** 실제 러너로 host_exec를 받는 하네스와 출력 홍수 명령 */
async function floodRig(flooder = FLOODER): Promise<{ env: OrchEnv; pidFile: string; command: (floodMs: number) => string }> {
  const e = (env = await bootOrch({ workspace: true }));
  real = await createProcessRunner({ dataDir: e.dataDir, forceMode: win ? 'jobobject' : 'pgroup', runnerSource: join(process.cwd(), 'resources', 'jobrunner', 'JobRunner.cs') });
  const r = real;
  e.hostExec = (spec) => {
    const p = r.start(spec);
    floodProcs.push(p);
    return p;
  };
  const dir = mkdtempSync(join(tmpdir(), 'wook-test-hxs-flood-'));
  const pidFile = join(dir, 'pid.txt');
  floodDirs.push(dir);
  writeFileSync(join(dir, 'flood.cjs'), flooder);
  return { env: e, pidFile, command: (floodMs) => `"${process.execPath}" "${join(dir, 'flood.cjs')}" "${pidFile}" ${floodMs}` };
}

/** 20ms 타이머의 가장 긴 틈 */
function gapWatch(): () => { worstGapMs: number; ticks: number } {
  let worst = 0;
  let ticks = 0;
  let last = performance.now();
  const iv = setInterval(() => {
    const now = performance.now();
    worst = Math.max(worst, now - last);
    last = now;
    ticks++;
  }, 20);
  return () => {
    clearInterval(iv);
    return { worstGapMs: Math.round(Math.max(worst, performance.now() - last)), ticks };
  };
}

describe('host_exec 끝내기 (hostExecStop)', () => {
  it('긴급 정지가 서버 명령의 실제 프로세스 트리(직접 자식·고아 개발 서버)를 3초 안에 끝내고 확인한다 — 완료 요약, 결과는 긴급 정지로 끝남', async () => {
    const e = (env = await bootOrch({ workspace: true }));
    real = await createProcessRunner({ dataDir: e.dataDir, forceMode: win ? 'jobobject' : 'pgroup', runnerSource: join(process.cwd(), 'resources', 'jobrunner', 'JobRunner.cs') });
    const r = real;
    e.hostExec = (spec) => {
      const p = r.start(spec);
      floodProcs.push(p);
      return p;
    };
    rig = createProcRig();
    const { turnId } = await liveMainTurn(e);
    const pending = hostExec(e, turnId, { command: rig.checkCommand(), timeout_s: 600, request_id: 'rq-tree' });
    await waitFor(() => rig!.records('check-').filter((x) => x.port).length === 2 && rig!.records('check-').length === 3, '서버 명령의 개발 서버 2개', 60_000);
    const recs = rig.records('check-');
    expect(e.core.hostExec.count()).toBe(1);
    // 재시작 복구가 그 트리를 찾게 도는 동안에도 PID와 시작 시각이 실행 기록에 있다
    expect(hostRecords(e)[0]).toMatchObject({ state: 'started', result: { pid: expect.any(Number), spawnedAt: expect.any(String) } });
    expect(e.orch.backend.hasActiveWork()).toBe(true);
    const stopAt = Date.now();
    const t0 = performance.now();
    const summary = await e.invoke('stop.emergency');
    const took = performance.now() - t0;
    expect(took, `긴급 정지 요약까지 ${Math.round(took)}ms`).toBeLessThan(3000);
    expect(summary.completed).toBe(true);
    expect(summary.failures).toEqual([]);
    const d = okData(await pending);
    expect(d).toMatchObject({ request_id: 'rq-tree', stopped: '긴급 정지', timed_out: false, leftover: 0 });
    expect(stillRunning(recs.map((x) => x.pid), stopAt)).toEqual([]);
    const rec = hostRecords(e)[0]!;
    expect(rec).toMatchObject({ kind: 'host_exec', state: 'failed', taskId: null, projectId: null, target: '시험 명령' });
    expect(rec.result).toMatchObject({ stopReason: '긴급 정지', terminated: true, timedOut: false, toolRequestId: 'rq-tree', turnId, sessionKey: MAIN_KEY });
    expect(typeof rec.result.pid).toBe('number');
    expect(typeof rec.result.spawnedAt).toBe('string');
    // 기록: 시작·끝 활동 기록(행위자 M-MAIN), 끝에 메인 일지 한 줄. 대표 알림은 없다
    const rows = e.ctx.store.activity.search({ kinds: ['exec'], limit: 50 }).filter((x) => x.text.includes(`host_exec ${rec.requestId}`));
    expect(rows.map((x) => x.text.split(' (')[0])).toEqual(['메인 에이전트 서버 명령 끝', '메인 에이전트 서버 명령 시작']);
    expect(rows.every((x) => x.actor === MAIN_AGENT_ID && x.requestId === rec.requestId)).toBe(true);
    expect(rows[0]!.text).toContain('긴급 정지로 끝냄');
    const journal = e.ctx.store.journal.query({ kinds: ['action'], limit: 20 }).filter((j) => j.text.startsWith(`서버 명령 실행 (host_exec ${rec.requestId})`));
    expect(journal).toHaveLength(1);
    expect(journal[0]!.text).toContain('긴급 정지로 끝냄');
    expect(e.ctx.store.notifications.list().filter((n) => n.title === '메인 에이전트 조작')).toEqual([]);
    // 부른 메인 턴도 끝났고 종료를 확인했다 — 메인 에이전트는 일시정지되지 않는다
    await waitFor(() => !!e.ctx.store.turns.require(turnId).endedAt, '메인 턴 끝');
    expect(e.ctx.store.turns.require(turnId).process.state).toBe('exited');
    expect(mainPause(e)).toBeNull();
  }, 120_000);

  it('아주 긴 한 줄(약 30MB)을 내는 서버 명령 중에도 긴급 정지가 3초 안에 끝낸다 — 출력 모으기가 그 줄을 가리느라 이벤트 루프를 막지 않는다 (리드 결정 S5-36)', async () => {
    const e = (env = await bootOrch({ workspace: true }));
    real = await createProcessRunner({ dataDir: e.dataDir, forceMode: win ? 'jobobject' : 'pgroup', runnerSource: join(process.cwd(), 'resources', 'jobrunner', 'JobRunner.cs') });
    const r = real;
    e.hostExec = (spec) => {
      const p = r.start(spec);
      floodProcs.push(p);
      return p;
    };
    const dir = mkdtempSync(join(tmpdir(), 'wook-test-hxs-long-'));
    const pidFile = join(dir, 'pid.txt');
    try {
      // 키=값이 촘촘한 한 줄(줄바꿈은 끝에 하나) — 줄마다 가리면 가장 오래 걸리는 꼴. 러너는 32MiB까지 한 줄로 넘긴다
      writeFileSync(join(dir, 'doc.txt'), 'API_KEY=abc PASS=x '.repeat(Math.ceil(30_000_000 / 19)));
      writeFileSync(
        join(dir, 'dump.cjs'),
        [
          "const fs = require('node:fs');",
          'fs.writeFileSync(process.argv[2], String(process.pid));',
          'const doc = fs.readFileSync(process.argv[3]);',
          "setTimeout(() => { process.stdout.write(doc); process.stdout.write('\\n'); setInterval(() => {}, 1000); }, 300);",
        ].join('\n'),
      );
      const { turnId } = await liveMainTurn(e);
      const pending = hostExec(e, turnId, { command: `"${process.execPath}" "${join(dir, 'dump.cjs')}" "${pidFile}" "${join(dir, 'doc.txt')}"`, timeout_s: 120, request_id: 'rq-long-line' });
      await waitFor(() => existsSync(pidFile), '명령 시작', 60_000);
      let worst = 0;
      let last = performance.now();
      const iv = setInterval(() => {
        const now = performance.now();
        worst = Math.max(worst, now - last - 20);
        last = now;
      }, 20);
      // 대표가 긴급 정지를 누른 때 — 줄이 다 온 바로 뒤가 되게 0.6초 뒤. 그때 이벤트 루프가 막혀 있으면 정지가 늦게 시작한다
      const pressed = performance.now() + 600;
      await sleep(600);
      const summary = await e.invoke('stop.emergency');
      const took = performance.now() - pressed;
      clearInterval(iv);
      const d = okData(await pending);
      expect(took, `누른 때부터 정지 요약까지 ${Math.round(took)}ms, 이벤트 루프가 가장 길게 막힌 때 ${Math.round(worst)}ms`).toBeLessThan(3000);
      expect(summary.completed).toBe(true);
      expect(d).toMatchObject({ request_id: 'rq-long-line', stopped: '긴급 정지', timed_out: false, leftover: 0 });
    } finally {
      // 자식은 긴급 정지가(또는 afterEach의 floodProcs 핸들이) 끝낸다 — pid.txt로 끝내지 않는다(그 PID를 다른 프로세스가 쓸 수 있다, 리드 결정 S5-52.4)
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    }
  }, 180_000);

  it('줄바꿈이 촘촘한 빠른 출력을 약 10초 내는 서버 명령 중에도 20ms 타이머의 가장 긴 틈이 500ms 안이다 — 출력은 하나도 빠지지 않고 차례대로 모인다 (리드 결정 S5-42)', async () => {
    const e = await floodRig();
    const { turnId } = await liveMainTurn(e.env);
    const pending = hostExec(e.env, turnId, { command: e.command(10_000), timeout_s: 300, request_id: 'rq-flood-gap' });
    await waitFor(() => existsSync(e.pidFile), '명령 시작', 60_000);
    const gap = gapWatch();
    const d = okData(await pending);
    const g = gap();
    expect(g.worstGapMs, `가장 긴 틈 ${g.worstGapMs}ms, 타이머 ${g.ticks}번`).toBeLessThan(500);
    expect(d).toMatchObject({ request_id: 'rq-flood-gap', exit_code: 0, stopped: null, timed_out: false, leftover: 0, output_truncated: true });
    // 자식이 마지막에 적은 줄 수 — 모은 바이트(19바이트 줄 n개 + 끝 줄)가 그와 같고 끝 줄이 결과의 마지막 줄이다
    const lastLine = d.output.split('\n').at(-1)!;
    const n = Number(/^flood end (\d+)$/.exec(lastLine)?.[1]);
    expect(n).toBeGreaterThan(1_000_000);
    expect(hostRecords(e.env)[0]!.result.outputBytes).toBe(n * 19 + Buffer.byteLength(lastLine) + 1);
  }, 180_000);

  it('그런 출력 중 약 0.6초에 잡아 둔 긴급 정지가 잡은 때부터 3초 안에 끝낸다 — 정지 요청이 이벤트 루프를 기다리지 않는다 (리드 결정 S5-42, AC-15·29)', async () => {
    const e = await floodRig();
    const { turnId } = await liveMainTurn(e.env);
    const pending = hostExec(e.env, turnId, { command: e.command(20_000), timeout_s: 300, request_id: 'rq-flood-stop' });
    await waitFor(() => existsSync(e.pidFile), '명령 시작', 60_000);
    // 자식은 PID 파일을 쓰고 0.3초 뒤부터 쏟아낸다 — 정지는 쏟아지기 시작한 지 약 0.6초에. 고치기 전에는 출력이 끝난 뒤에야 이 타이머가 돌았다
    const scheduled = performance.now() + 900;
    const stopped = new Promise<{ completed: boolean; at: number }>((done) => {
      setTimeout(() => void e.env.invoke('stop.emergency').then((s) => done({ completed: s.completed, at: performance.now() })), 900);
    });
    const s = await stopped;
    const d = okData(await pending);
    expect(s.at - scheduled, `잡은 때부터 정지 요약까지 ${Math.round(s.at - scheduled)}ms`).toBeLessThan(3000);
    expect(s.completed).toBe(true);
    expect(d).toMatchObject({ request_id: 'rq-flood-stop', stopped: '긴급 정지', timed_out: false, leftover: 0 });
    expect(d.duration_ms).toBeLessThan(10_000);
  }, 180_000);

  it('개인 키 시작·끝 표시만 줄바꿈 없이 쏟는 서버 명령(32MiB 줄마다 표시 약 110만 개) 중에도 20ms 타이머의 가장 긴 틈이 500ms 안이고, 약 2.5초에 잡아 둔 긴급 정지가 3초 안에 끝낸다 (리드 결정 S5-65, 프로브 zz-xs5f5-floodmarkers)', async () => {
    const e = await floodRig(FLOODER_MARKERS);
    const { turnId } = await liveMainTurn(e.env);
    const pending = hostExec(e.env, turnId, { command: e.command(8_000), timeout_s: 300, request_id: 'rq-flood-markers' });
    await waitFor(() => existsSync(e.pidFile), '명령 시작', 60_000);
    const gap = gapWatch();
    // 자식은 PID 파일을 쓰고 0.3초 뒤부터 쏟는다 — 정지는 쏟기 시작한 지 약 2.5초에. 표시를 다 걸으면 줄마다 0.5~1초가 들어 틈이 500ms를 넘었다
    const scheduled = performance.now() + 2800;
    const stopped = new Promise<{ completed: boolean; at: number }>((done) => {
      setTimeout(() => void e.env.invoke('stop.emergency').then((s) => done({ completed: s.completed, at: performance.now() })), 2800);
    });
    const s = await stopped;
    const d = okData(await pending);
    const g = gap();
    expect(g.worstGapMs, `가장 긴 틈 ${g.worstGapMs}ms, 타이머 ${g.ticks}번`).toBeLessThan(500);
    expect(s.at - scheduled, `잡은 때부터 정지 요약까지 ${Math.round(s.at - scheduled)}ms`).toBeLessThan(3000);
    expect(s.completed).toBe(true);
    expect(d).toMatchObject({ request_id: 'rq-flood-markers', stopped: '긴급 정지', timed_out: false, leftover: 0, output_truncated: true });
  }, 180_000);

  it("떠돌이 시작 표시 뒤에 공백 없이 이어 쓴 대입(4.8KB·10KB 줄)을 쏟는 서버 명령도 긴급 정지가 3초 안에 끝내고 결과는 '긴급 정지'다 — 가리개가 던져 '띄우지 못했습니다'가 되지 않고, 값은 가려지며 실행 기록에 PID가 남는다 (리드 결정 S5-83, 프로브 zz-xs5f8es-floodredact)", async () => {
    // 줄 끝의 값 (만든 가짜 값) — 숫자도 16자 넘는 영숫자 이어짐도 없어 토큰처럼 보이지 않는다: 토큰처럼 보이면 예전 가리개도 바깥 대입에서 바로 가려
    // 되부름이 깊어지지 않았다(검토자의 'x'와 같은 쪽)
    const value = ['plum', 'orchard', 'zebra'].join('-');
    const e = await floodRig(FLOODER_CHAIN);
    const { turnId } = await liveMainTurn(e.env);
    const pending = hostExec(e.env, turnId, { command: `${e.command(8_000)} ${value}`, timeout_s: 300, request_id: 'rq-flood-chain' });
    await waitFor(() => existsSync(e.pidFile), '명령 시작', 60_000);
    const gap = gapWatch();
    const scheduled = performance.now() + 2800;
    const stopped = new Promise<{ completed: boolean; at: number }>((done) => {
      setTimeout(() => void e.env.invoke('stop.emergency').then((s) => done({ completed: s.completed, at: performance.now() })), 2800);
    });
    const s = await stopped;
    const d = okData(await pending);
    const g = gap();
    expect(s.at - scheduled, `잡은 때부터 정지 요약까지 ${Math.round(s.at - scheduled)}ms`).toBeLessThan(3000);
    expect(s.completed).toBe(true);
    expect(g.worstGapMs, `가장 긴 틈 ${g.worstGapMs}ms, 타이머 ${g.ticks}번`).toBeLessThan(500);
    expect(d).toMatchObject({ request_id: 'rq-flood-chain', stopped: '긴급 정지', timed_out: false, leftover: 0, output_truncated: true });
    expect(d.output.includes(value) || d.output.includes('[가림:가리기 실패]')).toBe(false);
    expect(d.output).toContain(`${'key:'.repeat(17)}[가림:비밀 값] end.`);
    const rec = hostRecords(e.env)[0]!;
    expect(rec).toMatchObject({ state: 'failed', result: { stopReason: '긴급 정지', pid: expect.any(Number), spawnedAt: expect.any(String) } });
    // 값은 명령 줄의 인자라 실행 기록의 명령에는 있다 — 출력 끝에만 없다
    expect(String(rec.result.outputTail).includes(value)).toBe(false);
  }, 180_000);

  it('긴급 정지가 서버 명령의 종료를 확인하지 못하면 요약은 완료가 아니고 메인 에이전트의 실패로 적는다 — 부른 턴이 kill_failed로 끝나 메인 에이전트가 일시정지된다', async () => {
    const e = (env = await bootOrch({ workspace: true }));
    scriptedHost(e, { exitAfterMs: null, onStart: (p) => (p.terminateResult = { ...UNCONFIRMED }) });
    const { turnId } = await liveMainTurn(e);
    const pending = hostExec(e, turnId, { command: 'npm run dev' });
    await waitFor(() => e.core.hostExec.count() === 1, '서버 명령 시작');
    const execId = hostRecords(e)[0]!.requestId;
    const summary = await e.invoke('stop.emergency');
    expect(summary.completed).toBe(false);
    expect(summary.failures).toEqual([{ memberId: MAIN_AGENT_ID, memberName: '메인 에이전트', detail: `서버 명령 ${execId}: 가짜 종료 확인 실패`, remaining: -1 }]);
    const d = okData(await pending);
    expect(d).toMatchObject({ stopped: '긴급 정지', leftover: -1 });
    await waitFor(() => !!e.ctx.store.turns.require(turnId).endedAt, '메인 턴 끝');
    const turn = e.ctx.store.turns.require(turnId);
    expect(turn.process.state).toBe('kill_failed');
    expect(turn.process.killDetail).toBe(`서버 명령 ${execId}: 가짜 종료 확인 실패`);
    await waitFor(() => !!mainPause(e)?.paused, '메인 에이전트 일시정지');
    expect(mainPause(e)).toMatchObject({ paused: true, by: 'system' });
    expect(e.ctx.store.notifications.list().find((n) => n.key === `kill-failed:${MAIN_KEY}`)?.body).toContain("'정지 해제'를 누르세요");
  });

  it('스스로 끝났는데 하위 프로세스가 남으면 부른 턴에 접는다 — 그 턴에는 더 실행하지 않고, 턴이 끝나면 kill_failed와 메인 에이전트 일시정지', async () => {
    const e = (env = await bootOrch({ workspace: true }));
    scriptedHost(e, { lines: ['started dev server'], code: 0, remaining: 2 });
    const { proc, turnId } = await liveMainTurn(e);
    const d = okData(await hostExec(e, turnId, { command: 'start-dev.cmd' }));
    expect(d).toMatchObject({ exit_code: 0, stopped: null, leftover: 2 });
    expect(d.message).toContain('하위 프로세스 2개가 남았습니다 (종료 확인 실패) — 이 턴에는 서버 명령을 더 실행하지 않고, 턴이 끝나면 메인 에이전트가 일시정지됩니다');
    const again = await hostExec(e, turnId, { command: 'echo again' });
    expect(again).toMatchObject({ ok: false, code: 'conflict' });
    expect(again.ok ? '' : again.message).toContain('이 턴에는 서버 명령을 더 실행하지 않습니다');
    expect(e.hostSpecs).toHaveLength(1);
    expect(mainPause(e)).toBeNull();
    e.hold.clear();
    proc.finishOk();
    await waitFor(() => !!e.ctx.store.turns.require(turnId).endedAt, '메인 턴 끝');
    const execId = hostRecords(e)[0]!.requestId;
    expect(e.ctx.store.turns.require(turnId).process).toMatchObject({ state: 'kill_failed', killDetail: `서버 명령 ${execId}: 남은 프로세스 2개` });
    await waitFor(() => !!mainPause(e)?.paused, '메인 에이전트 일시정지');
    expect(hostRecords(e)[0]).toMatchObject({ state: 'failed', result: { remaining: 2 } });
  });

  it('CLI가 먼저 끝나도 그 턴의 서버 명령을 끝내고, 그 기록을 마친 뒤 턴을 마무리한다 — 결과는 턴 종료로 끝남', async () => {
    const e = (env = await bootOrch({ workspace: true }));
    scriptedHost(e, { exitAfterMs: null });
    const { proc, turnId } = await liveMainTurn(e);
    const pending = hostExec(e, turnId, { command: 'npm install' });
    await waitFor(() => e.core.hostExec.count() === 1, '서버 명령 시작');
    e.hold.clear();
    proc.finishOk();
    const d = okData(await pending);
    expect(d).toMatchObject({ stopped: '턴 종료', timed_out: false, leftover: 0 });
    await waitFor(() => !!e.ctx.store.turns.require(turnId).endedAt, '메인 턴 끝');
    const rec = hostRecords(e)[0]!;
    expect(rec.endedAt! <= e.ctx.store.turns.require(turnId).endedAt!).toBe(true);
    expect(e.core.hostExec.count()).toBe(0);
    expect(e.ctx.store.turns.require(turnId).process.state).toBe('exited');
  });

  it('턴 마무리는 서버 명령의 기록과 남은 프로세스 접기가 끝날 때까지 기다린다 — 그 명령의 종료 확인이 늦게 실패해도 턴이 kill_failed다', async () => {
    const e = (env = await bootOrch({ workspace: true }));
    scriptedHost(e, {
      exitAfterMs: null,
      onStart: (p) => {
        let calls = 0;
        // 처음 부른 끝내기(턴 마무리)는 곧바로 돌아오고, 그 실행이 결과를 볼 때의 확인은 늦게 실패한다
        p.terminate = async () => {
          calls++;
          p.terminatedByApp = true;
          p.exit(null, { terminated: true });
          if (calls > 1) await sleep(300);
          return { ok: false, remaining: -1, detail: '늦은 종료 확인 실패', durationMs: 1 };
        };
      },
    });
    const { proc, turnId } = await liveMainTurn(e);
    const pending = hostExec(e, turnId, { command: 'npm run watch' });
    await waitFor(() => e.core.hostExec.count() === 1, '서버 명령 시작');
    e.hold.clear();
    proc.finishOk();
    expect(await pending).toMatchObject({ ok: true, data: { stopped: '턴 종료', leftover: -1 } });
    await waitFor(() => !!e.ctx.store.turns.require(turnId).endedAt, '메인 턴 끝');
    const execId = hostRecords(e)[0]!.requestId;
    expect(e.ctx.store.turns.require(turnId).process).toMatchObject({ state: 'kill_failed', killDetail: `서버 명령 ${execId}: 늦은 종료 확인 실패` });
    await waitFor(() => !!mainPause(e)?.paused, '메인 에이전트 일시정지');
  });

  it('서버 명령이 도는 동안 감시는 응답 없음 대신 명령 상한을 쓴다 — 출력 없이 길게 도는 설치에 턴을 끊지 않는다', async () => {
    const e = (env = await bootOrch({ workspace: true, settings: { execution: { noOutputMin: 0.005, healthCheckMin: 0.005, commandMaxMin: 1 } } }));
    const procs = scriptedHost(e, { exitAfterMs: null });
    const { turnId } = await liveMainTurn(e);
    const pending = hostExec(e, turnId, { command: 'winget install x --accept-source-agreements --accept-package-agreements' });
    await waitFor(() => e.core.hostExec.count() === 1, '서버 명령 시작');
    await sleep(2000);
    expect(e.ctx.store.turns.require(turnId).endedAt).toBeNull();
    procs[0]!.exit(0);
    expect(okData(await pending)).toMatchObject({ exit_code: 0, stopped: null });
  });

  it('러너 준비를 기다리는 동안 부른 턴이 끝나면 띄우지 않는다 — 턴이 끝난 뒤에 남는 서버 명령이 없다', async () => {
    const e = (env = await bootOrch({ workspace: true }));
    const { proc, turnId } = await liveMainTurn(e);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    (e.ctx.deps.runner as ProcessRunner).ready = () => gate;
    const pending = hostExec(e, turnId, { command: 'npm install' });
    await sleep(30);
    e.hold.clear();
    proc.finishOk();
    await waitFor(() => !!e.ctx.store.turns.require(turnId).endedAt, '메인 턴 끝');
    release();
    expect(await pending).toEqual({ ok: false, code: 'stopped', message: '이 턴의 종료 요청 뒤에는 서버 명령을 시작하지 않습니다. 지금 턴을 마치세요' });
    expect(e.hostSpecs).toEqual([]);
    expect(e.core.hostExec.count()).toBe(0);
  });

  it('턴 마무리를 시작한 바로 뒤에 러너 준비가 끝난 서버 명령도 띄우지 않는다 — 마무리가 실행 중 목록을 거두기 전이라도', async () => {
    const e = (env = await bootOrch({ workspace: true }));
    const { proc, turnId } = await liveMainTurn(e);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    (e.ctx.deps.runner as ProcessRunner).ready = () => gate;
    const pending = hostExec(e, turnId, { command: 'npm install' });
    await sleep(30);
    e.hold.clear();
    // 같은 동기 구간: CLI가 끝나고(턴 마무리가 먼저 시작된다) 곧바로 러너 준비가 끝난다
    proc.finishOk();
    release();
    expect(await pending).toEqual({ ok: false, code: 'stopped', message: '이 턴의 종료 요청 뒤에는 서버 명령을 시작하지 않습니다. 지금 턴을 마치세요' });
    expect(e.hostSpecs).toEqual([]);
    await waitFor(() => !!e.ctx.store.turns.require(turnId).endedAt, '메인 턴 끝');
  });

  it('시간 상한이 지나면 끝내고 그때까지의 출력을 돌려준다 — timed_out, stopped 없음', async () => {
    const e = (env = await bootOrch({ workspace: true }));
    scriptedHost(e, { lines: ['downloading…'], exitAfterMs: null });
    const { turnId } = await liveMainTurn(e);
    const d = okData(await hostExec(e, turnId, { command: 'curl -O big.iso', timeout_s: 1 }));
    expect(d).toMatchObject({ timed_out: true, stopped: null, output: 'downloading…', leftover: 0 });
    expect(d.message).toContain('시간 상한(1초)이 지나 명령을 끝냈습니다');
    expect(hostRecords(e)[0]).toMatchObject({ state: 'failed', result: { timedOut: true } });
  });

  it('띄우기 전에 거부한다: 실행 환경 문제·백그라운드·거부 목록·request_id·시간 범위·메인이 아닌 호출 — 띄우지 않는다', async () => {
    const e = (env = await bootOrch({ workspace: true }));
    const { turnId } = await liveMainTurn(e);
    const expectRefused = async (args: Record<string, unknown>, code: string, fragment: string, identity = e.identity(turnId)) => {
      const r = await e.core.tools.handle(identity, 'host_exec', { purpose: '시험', request_id: `rq-${Math.random()}`, command: 'echo hi', ...args });
      expect(r, JSON.stringify(args)).toMatchObject({ ok: false, code });
      expect(r.ok ? '' : r.message).toContain(fragment);
    };
    await expectRefused({ background: true }, 'invalid', '백그라운드 실행(background)은 6단계에서 붙습니다');
    await expectRefused({ command: 'format c: /q' }, 'forbidden', '서버 PC를 멈추게 할 수 있는 명령이라 실행하지 않았습니다 (디스크 포맷: "format c: /q")');
    await expectRefused({ request_id: undefined }, 'invalid', 'request_id를 주세요');
    for (const timeout_s of [0, 1801, 1.5]) await expectRefused({ timeout_s }, 'invalid', 'timeout_s는 1~1800 사이의 정수(초)입니다');
    await expectRefused({ purpose: '' }, 'invalid', 'purpose(이 명령을 돌리는 까닭)를 적으세요');
    await expectRefused({}, 'forbidden', '메인 에이전트만 쓸 수 있는 도구입니다', { ...e.identity(turnId), memberId: e.devId, isMain: false, seatGeneration: undefined });
    (e.ctx.deps.runner as ProcessRunner & { problem: () => string | null }).problem = () => '도우미를 띄우지 못함 (시험)';
    await expectRefused({}, 'conflict', '하위 프로세스가 모두 끝났는지 확인할 수 없어 실행하지 않았습니다 — 작업 개체 도우미를 쓸 수 없음: 도우미를 띄우지 못함 (시험)');
    expect(e.hostSpecs).toEqual([]);
    expect(hostRecords(e)).toEqual([]);
  });

  it('한 번에 하나만 돈다 — 도는 동안 다른 호출은 그 request_id를 말하며 거부한다', async () => {
    const e = (env = await bootOrch({ workspace: true }));
    const procs = scriptedHost(e, { exitAfterMs: null });
    const { turnId } = await liveMainTurn(e);
    const first = hostExec(e, turnId, { command: 'npm install', request_id: 'rq-first' });
    await waitFor(() => e.core.hostExec.count() === 1, '서버 명령 시작');
    const second = await hostExec(e, turnId, { command: 'npm test' });
    expect(second).toMatchObject({ ok: false, code: 'conflict' });
    expect(second.ok ? '' : second.message).toBe('다른 서버 명령(request_id rq-first)이 아직 돌고 있습니다 — host_exec는 한 번에 하나만 돕니다. 그 명령이 끝난 뒤 다시 하세요');
    procs[0]!.exit(0);
    okData(await first);
    expect(e.hostSpecs).toHaveLength(1);
  });

  it('메인 자리가 넘어가는 중이면 거부한다', async () => {
    const e = (env = await bootOrch({ workspace: true }));
    e.core.seat.applyOperatorConfig({ holders: null, drainMs: 60_000, initialHolder: null }, '시험');
    const { turnId } = await liveMainTurn(e);
    const codex: AiConfig = { kind: 'codex', model: null, effortTier: 'high', effortOverride: null };
    const swap = e.core.seat.assign({ holder: { kind: 'launched', ai: codex }, by: 'operator', reason: '운영자 교체' });
    await sleep(50);
    expect(e.core.seat.view().state).toBe('switching');
    const r = await hostExec(e, turnId, { command: 'echo hi' });
    expect(r).toEqual({ ok: false, code: 'conflict', message: '메인 자리가 넘어가는 중이라 서버 명령을 실행하지 않았습니다 — 턴을 마치세요' });
    expect(e.hostSpecs).toEqual([]);
    e.hold.clear();
    e.liveProc(MAIN_KEY, MAIN_AGENT_ID)?.finishOk();
    await swap.done;
  });

  it('같은 request_id는 한 번만 돈다 — 다시 보내면 앞 결과, 서버 재시작으로 끊긴 호출의 request_id는 다시 돌지 않는다', async () => {
    const e = (env = await bootOrch({ workspace: true }));
    const { turnId } = await liveMainTurn(e);
    okData(await hostExec(e, turnId, { command: 'npm i -g pnpm', request_id: 'rq-once' }));
    const again = await hostExec(e, turnId, { command: 'npm i -g pnpm', request_id: 'rq-once' });
    expect(again).toMatchObject({ ok: true, data: { duplicateRequest: true, request_id: 'rq-once' } });
    expect(e.hostSpecs).toHaveLength(1);
    // 재시작으로 끊긴 호출 (중복 캐시는 처리가 끝나야 남는다 — 실행 기록으로 본다)
    const gen = e.identity(turnId).seatGeneration ?? e.core.seat.generation();
    e.ctx.store.execs.put({
      requestId: 'X-cut',
      kind: 'host_exec',
      projectId: null,
      taskId: null,
      cwd: e.mainWorkDir!,
      command: 'winget install x',
      target: '설치',
      state: 'failed',
      startedAt: e.ctx.now(),
      endedAt: e.ctx.now(),
      result: { toolRequestId: 'rq-cut', generation: gen, recovered: 'interrupted_by_restart' },
    });
    const cut = await hostExec(e, turnId, { command: 'winget install x', request_id: 'rq-cut' });
    expect(cut).toEqual({ ok: false, code: 'conflict', message: '이 request_id(rq-cut)의 서버 명령은 이미 돌다가 서버 재시작으로 끊겼습니다 (X-cut) — 같은 명령을 다시 돌리려면 새 request_id를 쓰세요' });
    expect(e.hostSpecs).toHaveLength(1);
    // 띄우지도 못한 호출(러너가 던짐)은 돈 적이 없다 — 같은 request_id로 다시 하면 돈다
    e.hostExec = () => {
      throw new Error('가짜 러너 실패');
    };
    expect(await hostExec(e, turnId, { command: 'npm ci', request_id: 'rq-nolaunch' })).toMatchObject({ ok: false, code: 'error', message: '서버 명령을 띄우지 못했습니다: 가짜 러너 실패' });
    e.hostExec = null;
    expect(await hostExec(e, turnId, { command: 'npm ci', request_id: 'rq-nolaunch' })).toMatchObject({ ok: true, data: { exit_code: 0 } });
  });

  it('같은 request_id 확인은 자리 세대마다다 — 앞 세대의 실행 기록은 이 세대의 호출을 막지 않고, 같은 세대의 것은 막는다 (리드 결정 S4-4·S5-40.1, 프로브 zz-s5f1ti-earlier-generation)', async () => {
    const e = (env = await bootOrch({ workspace: true }));
    const { turnId } = await liveMainTurn(e);
    const gen = e.identity(turnId).seatGeneration ?? e.core.seat.generation();
    const put = (requestId: string, toolRequestId: string, generation: number) =>
      e.ctx.store.execs.put({
        requestId,
        kind: 'host_exec',
        projectId: null,
        taskId: null,
        cwd: e.mainWorkDir!,
        command: 'npm i -g pnpm',
        target: '설치',
        state: 'succeeded',
        startedAt: e.ctx.now(),
        endedAt: e.ctx.now(),
        result: { toolRequestId, generation, pid: 4242, spawnedAt: e.ctx.now() },
      });
    // 앞 자리(세대 gen − 1)가 같은 request_id로 돌린 기록 — 중복 캐시는 세대마다라 실행 기록만 남은 경우
    put('X-old-gen', 'rq-gen', gen - 1);
    scriptedHost(e, { lines: ['ok'] });
    const r = await hostExec(e, turnId, { command: 'npm i -g pnpm', request_id: 'rq-gen' });
    expect(r.ok ? 'ran' : `${r.code}: ${r.message}`).toBe('ran');
    expect(okData(r).exit_code).toBe(0);
    expect(e.hostSpecs).toHaveLength(1);
    // 같은 세대의 기록은 막는다 — 확인 자체가 켜져 있다
    put('X-same-gen', 'rq-gen2', gen);
    expect(await hostExec(e, turnId, { command: 'npm i -g pnpm', request_id: 'rq-gen2' })).toEqual({
      ok: false,
      code: 'conflict',
      message: '이 request_id(rq-gen2)의 서버 명령은 이미 한 번 돌았습니다 (X-same-gen) — 같은 명령을 다시 돌리려면 새 request_id를 쓰세요',
    });
    expect(e.hostSpecs).toHaveLength(1);
  });

  it('턴 없이(프로세스 안 시험 신원) 도는 서버 명령도 진행 중 작업이고, 남긴 하위 프로세스는 그 실행을 바로 막는다 — 앱 종료가 끝낸다', async () => {
    const e = (env = await bootOrch({ workspace: true }));
    scriptedHost(e, { code: 0, remaining: 3 });
    expect(await e.main('host_exec', { command: 'start-dev.cmd', purpose: '턴 없는 시험', request_id: 'rq-noturn-1' })).toMatchObject({ leftover: 3 });
    await waitFor(() => !!mainPause(e)?.paused, '메인 에이전트 일시정지');
    expect(e.ctx.store.notifications.list().find((n) => n.key === `kill-failed:${MAIN_KEY}`)?.body).toContain('서버 명령 종료 뒤 하위 프로세스 3개가 남았습니다 (종료 확인 실패).');
    await e.invoke('stop.release');
    expect(mainPause(e)).toBeNull();
    scriptedHost(e, { exitAfterMs: null });
    // 앞 호출의 신원(TN-main-ops)은 종료 확인 실패로 더 받지 않는다 — 다른 시험 신원으로
    const pending = e.core.tools.handle(mainOpsIdentity(MAIN_KEY, 'TN-main-ops-2'), 'host_exec', { command: 'npm install', purpose: '턴 없는 시험', request_id: 'rq-noturn-2' });
    await waitFor(() => e.core.hostExec.count() === 1, '서버 명령 시작');
    expect(e.core.turns.count()).toBe(0);
    expect(e.orch.backend.hasActiveWork()).toBe(true);
    await e.orch.stop();
    expect(await pending).toMatchObject({ ok: true, data: { stopped: '앱 종료' } });
  });

  it('메인 대화 턴만 CLI가 앱 도구를 host_exec 상한 + 60초 기다린다 — 팀원 턴은 CLI 기본값 그대로', async () => {
    const e = (env = await bootOrch({ workspace: true }));
    const seen: { key: string; timeout: number | undefined }[] = [];
    e.prepareHook = (launch, who) => void seen.push({ key: who.sessionKey, timeout: launch.mcp.toolTimeoutSec });
    await liveMainTurn(e);
    e.hold.clear();
    e.liveProc(MAIN_KEY, MAIN_AGENT_ID)!.finishOk();
    await e.idle();
    // 팀원(QA)의 검수 턴과 메인 에이전트의 검수 턴 — host_exec가 없는 세션
    await startReview(e, e.qaId);
    await startReview(e, MAIN_AGENT_ID);
    expect(seen.find((s) => s.key === MAIN_KEY)?.timeout).toBe(1860);
    const reviews = seen.filter((s) => s.key.startsWith('review:'));
    expect(reviews).toHaveLength(2);
    expect(reviews.map((s) => s.timeout)).toEqual([undefined, undefined]);
  });

  it('앱 종료도 서버 명령을 끝낸다 — 도는 동안은 진행 중 작업이다', async () => {
    const e = (env = await bootOrch({ workspace: true }));
    scriptedHost(e, { exitAfterMs: null });
    const { turnId } = await liveMainTurn(e);
    const pending = hostExec(e, turnId, { command: 'npm install' });
    await waitFor(() => e.core.hostExec.count() === 1, '서버 명령 시작');
    expect(e.orch.backend.hasActiveWork()).toBe(true);
    e.hold.clear();
    await e.orch.stop();
    expect(okData(await pending)).toMatchObject({ stopped: '앱 종료' });
    expect(e.core.hostExec.count()).toBe(0);
  });

  // 리뷰 tests-integrity가 찾은 빈틈 (리드 결정 S5-31, 프로브 zz-s5ti-hostexec-gaps)
  it('스스로 끝나며 남은 하위 프로세스를 확인하지 못해도(-1) 부른 턴에 접는다 — 턴은 kill_failed, 메인 에이전트 일시정지', async () => {
    const e = (env = await bootOrch({ workspace: true }));
    scriptedHost(e, { code: 0, remaining: -1 });
    const { proc, turnId } = await liveMainTurn(e);
    const d = okData(await hostExec(e, turnId, { command: 'start-dev.cmd' }));
    expect(d).toMatchObject({ exit_code: 0, stopped: null, leftover: -1 });
    expect(d.message).toContain('하위 프로세스가 모두 끝났는지 확인하지 못했습니다 (종료 확인 실패)');
    e.hold.clear();
    proc.finishOk();
    await waitFor(() => !!e.ctx.store.turns.require(turnId).endedAt, '메인 턴 끝');
    expect(e.ctx.store.turns.require(turnId).process.state).toBe('kill_failed');
    await waitFor(() => !!mainPause(e)?.paused, '메인 에이전트 일시정지');
    expect(hostRecords(e)[0]).toMatchObject({ state: 'failed', result: { remaining: -1 } });
  });

  it('시간 상한은 실행 명령 상한(commandMaxMin) 안으로 줄어든다 — timeout_s가 더 길어도', async () => {
    const e = (env = await bootOrch({ workspace: true, settings: { execution: { commandMaxMin: 0.02 } } }));
    scriptedHost(e, { exitAfterMs: null });
    const { turnId } = await liveMainTurn(e);
    const t0 = Date.now();
    const d = okData(await hostExec(e, turnId, { command: 'npm install', timeout_s: 600 }));
    expect(d.timed_out).toBe(true);
    expect(d.message).toContain('시간 상한(1초)이 지나 명령을 끝냈습니다');
    expect(Date.now() - t0).toBeLessThan(20_000);
  });

  it('시간 상한은 이 턴의 시간 상한까지 남은 시간 − 30초 안으로 줄어든다 — timeout_s가 더 길어도', async () => {
    const e = (env = await bootOrch({ workspace: true, settings: { execution: { turnTimeoutMin: 0.55 } } }));
    scriptedHost(e, { exitAfterMs: null });
    const { turnId } = await liveMainTurn(e);
    const t0 = Date.now();
    const d = okData(await hostExec(e, turnId, { command: 'npm install', timeout_s: 600 }));
    expect(d.timed_out).toBe(true);
    expect(Date.now() - t0).toBeLessThan(20_000);
  });

  it('감시의 명령 상한은 서버 명령이 시작한 때부터 센다 — CLI가 앞서 오래 조용했어도 명령을 일찍 끊지 않는다 (리드 결정 S5-33)', async () => {
    let offset = 0;
    const clock = {
      now: () => new Date(Date.now() + offset),
      iso: () => new Date(Date.now() + offset).toISOString(),
      ms: () => Date.now() + offset,
    };
    const e = (env = await bootOrch({ workspace: true, clock, settings: { execution: { commandMaxMin: 1, healthCheckMin: 0.005 } } }));
    const procs = scriptedHost(e, { exitAfterMs: null });
    const { turnId } = await liveMainTurn(e);
    // CLI가 50초 동안 아무것도 내지 않다가(응답 없음 상한 안) host_exec를 부른다
    offset += 50_000;
    const pending = hostExec(e, turnId, { command: 'winget install x --accept-source-agreements --accept-package-agreements' });
    await waitFor(() => e.core.hostExec.count() === 1, '서버 명령 시작');
    // 명령이 15초 돌았다 — CLI의 마지막 출력부터는 65초(명령 상한 1분을 넘음), 명령 시작부터는 15초
    offset += 15_000;
    await sleep(1500);
    expect(e.ctx.store.turns.require(turnId).endedAt).toBeNull();
    expect(e.core.hostExec.count()).toBe(1);
    procs[0]!.exit(0);
    expect(okData(await pending)).toMatchObject({ exit_code: 0, stopped: null, timed_out: false });
  });

  it('긴급 정지가 시간 상한보다 먼저 끝내기 시작했으면 결과는 긴급 정지다 — 그 사이 시간 상한이 와도 timed_out이 아니다 (리드 결정 S5-33)', async () => {
    const e = (env = await bootOrch({ workspace: true }));
    scriptedHost(e, {
      exitAfterMs: null,
      onStart: (p) => {
        // 끝내기가 1.5초 걸린다 — 그 사이 1초 시간 상한이 온다
        p.terminate = async () => {
          p.terminatedByApp = true;
          await sleep(1500);
          p.exit(null, { terminated: true });
          return { ok: true, remaining: 0, detail: '느린 종료', durationMs: 1500 };
        };
      },
    });
    const { turnId } = await liveMainTurn(e);
    const pending = hostExec(e, turnId, { command: 'npm install', timeout_s: 1 });
    await waitFor(() => e.core.hostExec.count() === 1, '서버 명령 시작');
    await sleep(200);
    const summary = await e.invoke('stop.emergency');
    expect(summary.completed).toBe(true);
    const d = okData(await pending);
    expect(d).toMatchObject({ stopped: '긴급 정지', timed_out: false, leftover: 0 });
    expect(d.message).toContain('긴급 정지로 명령을 끝냈습니다');
    expect(hostRecords(e)[0]!.result).toMatchObject({ stopReason: '긴급 정지', timedOut: false, terminated: true });
  });
});
