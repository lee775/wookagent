/**
 * 종료 확인 실패 알림은 사실만 말한다 — 남은 프로세스를 셌을 때만 '남았다', 확인하지 못했으면(-1) '확인하지 못했다' (stage-6 리뷰 process-shutdown D4 →
 * S7-D3, stage-6 회귀 — S6-E5 '남은 수 -1의 알림은 확인하지 못했다고', 12장 알림 '대표가 할 일을 알 수 있게').
 * taskkill 대체 러너에서 CLI를 작업 개체에 넣은 뒤 도우미(PowerShell)가 끝나면 작업 개체 안을 읽을 수 없다. 정지(긴급·즉시)의 결과는 정직하게
 * 확인 불가(-1)였지만 그 까닭 글이 '종료되지 않은 프로세스가 있습니다 (작업 개체 확인 불가; …)'라서, 턴 종료 확인 실패 알림·보류 사유가 '확인하지
 * 못했습니다'와 '종료되지 않은 프로세스가 있습니다'를 한 글에 담았고, 긴급 정지 요약·알림도 '남은 프로세스가 있습니다'라고 했다. 작업 개체 러너도
 * 작업 개체 상태를 읽지 못한 종료(-1)를 '하지만 남은 프로세스가 있습니다 (개수 확인 불가)'라고 썼다.
 * 원래 탐침: probe-archive/stage6-process-shutdown-review/tests-acceptance__zz-s6psr-helpercrash-e2e.probe.ts,
 *            src-main-process__zz-s6psr-attack.probe.ts -t HELPER-CRASH
 */
import { readFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { OWNER } from '@shared/domain';
import { createProcessRunner } from '../../src/main/process/processRunner';
import { createJobHelper } from '../../src/main/process/jobHelper';
import type { ManagedProcess, ProcessRunner } from '../../src/main/process/types';
import { createHarness, sendCommand, type Harness } from '../e2e/harness';
import { bootOrch, seedDirective, waitFor, type OrchEnv } from './orchHarness';
import { directiveKey, enqueue, taskKey } from '../../src/main/orchestrator/records';

const isWin = process.platform === 'win32';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const CLAIM = '종료되지 않은 프로세스가 있습니다';
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe.skipIf(!isWin)('taskkill 대체 러너: 넣은 뒤 작업 개체 도우미가 끝나면 정지 결과는 확인하지 못했다고 쓴다 (S7-D3)', () => {
  let root: string;
  const runners: ProcessRunner[] = [];
  /** 러너로 띄운 실행 — 러너가 가진 핸들로 끝낸다 (이미 끝났으면 아무것도 하지 않는다). 기록한 PID로 죽이지 않는다: 끝난 프로세스의 번호는 다른 프로세스가 다시 쓸 수 있다 (S7-20 TI-8) */
  const procs: ManagedProcess[] = [];

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'wook-test-killworded-'));
    await mkdir(join(root, 'w'), { recursive: true });
  });
  afterEach(async () => {
    await Promise.all(procs.splice(0).map((p) => p.terminate({ timeoutMs: 3000, reason: '시험 정리' }).catch(() => undefined)));
  });
  afterAll(async () => {
    for (const r of runners) r.dispose?.();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
  });

  it('도우미가 끝난 뒤 정지: ok=false·remaining -1, 까닭은 "작업 개체 안을 확인하지 못했습니다" — "종료되지 않은 프로세스가 있습니다"라고 하지 않는다. CLI는 끝났다', async () => {
    const helper = createJobHelper({ log: () => undefined });
    const runner = await createProcessRunner({ dataDir: join(root, 'd'), forceMode: 'taskkill', log: () => undefined, jobHelper: helper });
    runners.push(runner);
    // CLI 대역: 프롬프트를 받고 오래 돈다 (앱이 CLI를 띄우듯 프롬프트를 준다 — 넣은 뒤에 준다)
    const proc = runner.start({ command: process.execPath, args: ['-e', 'process.stdin.resume(); setInterval(() => {}, 1000)'], cwd: join(root, 'w'), env: { ...process.env }, stdinText: '프롬프트', label: 'CLI 대역' });
    procs.push(proc);
    await sleep(800); // 넣기 끝
    helper.dispose(); // 도우미가 끝났다 (작업 개체 안 프로세스는 그대로 — KILL_ON_JOB_CLOSE 없음)
    await sleep(300);
    const res = await proc.terminate({ reason: '시험 정지' });
    expect({ ok: res.ok, remaining: res.remaining }, res.detail).toEqual({ ok: false, remaining: -1 });
    expect(res.detail).toContain('작업 개체 도우미가 답하지 않아 작업 개체 안을 확인하지 못했습니다');
    expect(res.detail).toContain('taskkill /T /F로 프로세스');
    expect(res.detail).not.toContain(CLAIM);
    expect(alive(proc.pid!)).toBe(false);
  }, 60_000);
});

describe.skipIf(!isWin)('작업 개체 러너: 작업 개체 상태를 읽지 못한 종료(-1)는 확인하지 못했다고 쓴다 (S7-D3)', () => {
  let root: string;
  let runner: ProcessRunner | null = null;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'wook-test-killworded-job-'));
    await mkdir(join(root, 'w'), { recursive: true });
  });
  afterAll(async () => {
    runner?.dispose?.();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
  });

  it('종료 보고의 남은 수가 -1이면: ok=false·remaining -1, "하지만 남은 프로세스가 있습니다"라고 하지 않는다', async () => {
    // 러너가 끝낸 뒤 작업 개체 상태 조회가 실패한 경우(QueryInformationJobObject 실패 → -1)를 흉내: 종료 보고만 -1로 바꾼 러너 원본
    const source = await readFile(fileURLToPath(new URL('../../resources/jobrunner/JobRunner.cs', import.meta.url)), 'utf8');
    const patched = source.replace(/(DrainRelays\(outRelay, errRelay, KillDrainMs\);\s*)WriteFinal\(TerminatedJson\(ActiveProcesses\(\)\)\);/, '$1WriteFinal(TerminatedJson(-1));');
    expect(patched).not.toBe(source);
    const file = join(root, 'JobRunner.cs');
    await writeFile(file, patched, 'utf8');
    runner = await createProcessRunner({ dataDir: join(root, 'd'), forceMode: 'jobobject', runnerSource: file, log: () => undefined });
    const proc = runner.start({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], cwd: join(root, 'w'), env: { ...process.env }, stdinText: null, label: '오래 도는 프로세스' });
    await sleep(500);
    const res = await proc.terminate({ reason: '시험 정지' });
    expect({ ok: res.ok, remaining: res.remaining }, res.detail).toEqual({ ok: false, remaining: -1 });
    expect(res.detail).toBe('작업 개체로 프로세스 트리를 종료했습니다. 하지만 작업 개체 상태를 읽지 못해 남은 프로세스가 없는지 확인하지 못했습니다');
    expect(res.detail).not.toContain('남은 프로세스가 있습니다');
  }, 180_000);
});

describe.skipIf(!isWin)('앱: 턴 도중 작업 개체 도우미가 끝난 뒤 긴급 정지 — 알림·보류 사유·요약이 같은 사실을 말한다 (S7-D3)', () => {
  let h: Harness | null = null;
  afterEach(async () => {
    await h?.close().catch(() => undefined);
    h = null;
  });

  it('턴 종료 확인 실패 알림·보류 사유는 "확인하지 못했습니다"만, 긴급 정지 요약·알림도 "남은 프로세스를 확인하지 못했습니다"', async () => {
    const helper = createJobHelper({ log: () => undefined });
    h = await createHarness({ team: ['developer'], scenarios: { developer: 'hang' }, runnerMode: 'taskkill', jobHelper: helper });
    const hh = h;
    await sendCommand(hh, '로그인 화면을 만들어 줘');
    await hh.waitFor(() => hh.core.turns.running().some((r) => r.sessionKey.startsWith('task:')), { timeoutMs: 90_000, label: '작업 턴' });
    // CLI가 프롬프트를 받아 첫 줄을 낸 뒤 — 프롬프트는 작업 개체에 넣은 뒤에 주므로 이때는 넣기가 끝났다 (부하에서 띄우기가 늦어도)
    await hh.waitFor(() => !!hh.core.turns.lastLineOf(hh.members.developer!)?.text.includes('업무를 시작합니다'), { timeoutMs: 90_000, label: 'CLI 첫 줄' });
    await sleep(300);
    helper.dispose(); // 도우미가 턴 도중에 끝났다
    await sleep(300);
    const summary = await hh.invoke('stop.emergency');
    await hh.waitFor(() => hh.core.turns.count() === 0, { timeoutMs: 30_000, label: '턴 종료' });
    await sleep(300);
    const devName = hh.core.ctx.store.members.require(hh.members.developer!).name;

    expect(summary.completed).toBe(false);
    const failure = summary.failures.find((f) => f.memberId === hh.members.developer);
    expect(failure?.detail).toContain('작업 개체 도우미가 답하지 않아 작업 개체 안을 확인하지 못했습니다');
    expect(failure?.detail).not.toContain(CLAIM);

    const killNotices = hh.core.ctx.store.notifications.list().filter((n) => (n.key ?? '').startsWith('kill-failed:task:'));
    expect(killNotices).toHaveLength(1);
    expect(killNotices[0]!.body).toContain('턴 종료 뒤 남은 하위 프로세스를 확인하지 못했습니다');
    expect(killNotices[0]!.body).not.toContain(CLAIM);
    const task = hh.tasks().find((t) => t.assigneeId === hh.members.developer);
    const holdNote = task?.hold.reasons.find((r) => r.kind === 'error')?.note ?? '';
    expect(holdNote).toContain('확인하지 못했습니다');
    expect(holdNote).not.toContain(CLAIM);

    const emergency = hh.core.ctx.store.notifications.list().filter((n) => n.title === '긴급 정지 — 종료 실패');
    expect(emergency.map((n) => n.body)).toEqual([`남은 프로세스를 확인하지 못했습니다: ${devName}`]);
  }, 180_000);
});

describe('긴급 정지 알림: 남은 프로세스를 센 실행과 확인하지 못한 실행을 나눠 쓴다 (S7-D3, AC-15)', () => {
  let e: OrchEnv | null = null;
  afterEach(async () => {
    await e?.close().catch(() => undefined);
    e = null;
  });

  it('하나는 남은 2개, 하나는 확인 불가(-1) — 알림은 "남은 프로세스가 있습니다: <남긴 팀원> / 남은 프로세스를 확인하지 못했습니다: <확인 못 한 팀원>"', async () => {
    e = await bootOrch();
    const env = e;
    const d = seedDirective(env);
    const t = env.core.tasks.create(
      { directiveId: d.id, title: '개발 서버를 띄운 작업', goal: '목표', type: 'development', assigneeId: env.devId, acceptanceCriteria: ['동작한다'], outputMode: 'repo' },
      env.producerId,
    );
    env.hold.add(taskKey(t.id));
    env.hold.add(directiveKey(d.id));
    enqueue(env.ctx, { kind: 'message', memberId: env.producerId, sessionKey: directiveKey(d.id), projectId: env.projectId, directiveId: d.id, message: '진행 상황을 정리해 주세요' });
    env.tick();
    await waitFor(() => !!env.liveProc(taskKey(t.id)) && !!env.liveProc(directiveKey(d.id)), '작업·관리 턴');
    const counted = env.liveProc(taskKey(t.id))!;
    counted.terminate = async () => {
      counted.terminatedByApp = true;
      counted.exit(null, { terminated: true, remaining: 2 });
      return { ok: false, remaining: 2, detail: '작업 개체로 프로세스 트리를 종료했습니다. 하지만 남은 프로세스가 있습니다 (2개)', durationMs: 2800 };
    };
    const unknown = env.liveProc(directiveKey(d.id))!;
    unknown.terminate = async () => {
      unknown.terminatedByApp = true;
      unknown.exit(null, { terminated: true, remaining: -1 });
      return { ok: false, remaining: -1, detail: '작업 개체 도우미가 답하지 않아 작업 개체 안을 확인하지 못했습니다', durationMs: 2800 };
    };
    const summary = await env.core.stops.emergency(OWNER);
    expect(summary.completed).toBe(false);
    expect(summary.failures).toHaveLength(2);
    const name = (id: string) => env.ctx.store.members.require(id).name;
    const notice = env.ctx.store.notifications.list().filter((n) => n.title === '긴급 정지 — 종료 실패');
    expect(notice.map((n) => n.body)).toEqual([`남은 프로세스가 있습니다: ${name(env.devId)} / 남은 프로세스를 확인하지 못했습니다: ${name(env.producerId)}`]);
  });
});
