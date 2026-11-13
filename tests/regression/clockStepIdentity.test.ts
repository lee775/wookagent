/**
 * 벽시계가 움직여도 같은 프로세스는 같은 프로세스다 (S2-22 → 리드 결정 S10-5.1). 리뷰 프로브 zz-lc2-clockstep을 회귀 시험으로 옮긴 것.
 * Linux의 생성 시각(ps lstart = 부팅 시각 btime + 시작 틱)은 NTP 보정·VM 재개·손으로 바꾼 시각에 btime과 함께 움직인다. 예전 판정(생성 시각 ±1초)은
 * 그 뒤 살아 있는 주인을 끝난 것으로 봤다 — 둘째 서버가 잠금을 넘겨받고(살아 있는 서버의 admin.sock까지 지움), 데이터 주인 확인을 지나고, 재시작 복구는
 * 앞으로 움직인 시계에 살아 있는 이전 CLI를 남의 것으로 보고 같은 작업 폴더에 둘째 CLI를 띄웠다.
 * 이제 기록에 부팅 기준 신원(start = boot id + /proc 시작 틱)을 함께 적고, 둘 다 있으면 그것으로 정확히 견준다. 가짜 /proc 루트의 btime을 옮겨 시계 이동을
 * 흉내 낸다 — 커널이 하는 일과 같다. 그래서 Windows에서도 돈다.
 * 잡는 결함: 신원을 기록하지 않음·견주지 않음(시계 이동 뒤 잠금 넘겨받기·데이터 주인 통과·이전 CLI를 남의 것으로), 신원을 느슨하게 견줌(재부팅·PID 재사용 뒤
 * 남의 프로세스를 우리 것으로), 예전 기록(신원 없음)의 판정을 바꿈
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExecRecord, Turn } from '@shared/domain';
import { acquireInstanceLock, holderAlive, lockFilePath, toRecord } from '../../src/main/backend/instanceLock';
import { claimDataOwner, DATA_IN_USE, INSTANCE_KEY } from '../../src/main/orchestrator/dataOwner';
import { openStore } from '../../src/main/db/store';
import { createProcessLiveness } from '../../src/main/process/processRunner';
import type { ProcessRunner } from '../../src/main/process/types';
import { createFakeProcRoot, FAKE_BOOT_ID, type FakeProcRoot } from '../../src/main/process/__fixtures__/fakeProcRoot';
import { bootOrch, FakeProc, startReview, type OrchEnv } from './orchHarness';
import { MAIN_KEY } from './hostExecRig';

const kids: ChildProcess[] = [];
const dirs: string[] = [];
const roots: FakeProcRoot[] = [];
let env: OrchEnv | null = null;
afterEach(async () => {
  // 이 시험이 띄운 자식만 그 핸들로 끝낸다
  for (const k of kids.splice(0)) if (k.exitCode === null && k.signalCode === null) k.kill();
  for (const r of roots.splice(0)) r.cleanup();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  await env?.close();
  env = null;
});

const BTIME = 1_762_900_000;
const TICKS = 123_456;
const OTHER_BOOT = '99999999-8888-4777-8666-555555555555';

/** 살아 있는 잠금 주인 (실제 프로세스 — 생존 확인은 실제 신호 0) 과 그 프로세스의 가짜 /proc 항목 */
function liveHolder(): { pid: number; proc: FakeProcRoot } {
  const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30); setTimeout(() => process.exit(0), 120000)'], { stdio: 'ignore', windowsHide: true });
  kids.push(holder);
  const proc = createFakeProcRoot({ btime: BTIME }).add({ pid: holder.pid!, ticks: TICKS });
  roots.push(proc);
  return { pid: holder.pid!, proc };
}

function tempData(): string {
  const d = mkdtempSync(join(tmpdir(), 'wook-test-clockstep-'));
  dirs.push(d);
  return d;
}

describe('실행 잠금·데이터 주인: 벽시계가 움직여도 살아 있는 주인을 끝난 것으로 보지 않는다 (프로브 zz-lc2-clockstep)', () => {
  it('잠금에 부팅 기준 신원을 적고, 시계가 5초 앞·뒤로 움직여 생성 시각이 바뀌어도 둘째 잡기는 거부되고 holderAlive는 참이다', async () => {
    const { pid, proc } = liveHolder();
    const live = createProcessLiveness({ procRoot: proc.root });
    const dataDir = tempData();
    const first = await acquireInstanceLock({ dataDir, kind: 'server', liveness: live, pid });
    if (!first.ok) throw new Error(first.message);
    const createdAt = (BTIME + Math.floor(TICKS / 100)) * 1000;
    expect(first.record).toMatchObject({ pid, createdAt, start: { bootId: FAKE_BOOT_ID, ticks: TICKS }, kind: 'server' });
    const written = toRecord(JSON.parse(readFileSync(lockFilePath(dataDir), 'utf8')));
    expect(written?.start).toEqual({ bootId: FAKE_BOOT_ID, ticks: TICKS });

    for (const step of [5, -5]) {
      proc.setBtime(BTIME + step);
      // 시계 이동: 같은 프로세스의 생성 시각이 그만큼 움직였다 (예전 판정의 ±1초를 넘는다)
      expect((await live.processCreatedAt([pid])).get(pid)).toBe(createdAt + step * 1000);
      const second = await acquireInstanceLock({ dataDir, kind: 'desktop', liveness: live, pid: 2222 });
      if (second.ok) second.release();
      expect(second, `시계 ${step}초`).toMatchObject({ ok: false, reason: 'held', kind: 'server', pid });
      expect(await holderAlive(written!, live), `시계 ${step}초`).toBe(true);
    }
    first.release();
  });

  it('데이터 주인 기록(kv instance)에도 신원이 실리고, 시계가 움직인 뒤에도 살아 있는 주인의 데이터면 시작하지 않는다', async () => {
    const { pid, proc } = liveHolder();
    const live = createProcessLiveness({ procRoot: proc.root });
    const dataDir = tempData();
    const lock = await acquireInstanceLock({ dataDir, kind: 'desktop', liveness: live, pid });
    if (!lock.ok) throw new Error(lock.message);
    lock.release();
    const store = openStore(join(dataDir, 'wook.db'));
    try {
      // 껍데기가 넘기는 모양 그대로 ({...잠금 내용, dataDir}) — 그 주인이 저장소에 적혀 있다
      store.kv.set(INSTANCE_KEY, { ...lock.record, dataDir: '/srv/원래' });
      expect(toRecord(store.kv.get<unknown>(INSTANCE_KEY))?.start).toEqual({ bootId: FAKE_BOOT_ID, ticks: TICKS });
      proc.setBtime(BTIME + 5);
      const self = { pid: 2222, createdAt: 1, kind: 'server' as const, startedAt: new Date().toISOString(), dataDir };
      await expect(claimDataOwner({ store, self, liveness: live })).rejects.toMatchObject({ code: DATA_IN_USE });
      expect(toRecord(store.kv.get<unknown>(INSTANCE_KEY))?.pid).toBe(pid); // 바꾸지 않았다
    } finally {
      store.close();
    }
  });

  it('재부팅(부팅이 다름)·같은 부팅의 PID 재사용(틱이 다름)은 생성 시각이 같아도 끝난 잠금이다 — 정확히 견준다', async () => {
    const { pid, proc } = liveHolder();
    const live = createProcessLiveness({ procRoot: proc.root });
    const createdAt = (BTIME + Math.floor(TICKS / 100)) * 1000;
    for (const start of [{ bootId: OTHER_BOOT, ticks: TICKS }, { bootId: FAKE_BOOT_ID, ticks: TICKS - 1 }]) {
      const dataDir = tempData();
      writeFileSync(lockFilePath(dataDir), JSON.stringify({ pid, createdAt, start, kind: 'server', startedAt: new Date(createdAt + 100).toISOString() }));
      const r = await acquireInstanceLock({ dataDir, kind: 'desktop', liveness: live, pid: 2222 });
      expect(r.ok, JSON.stringify(start)).toBe(true);
      if (r.ok) r.release();
    }
  });

  it('예전 기록(신원 없음)은 예전 규칙 그대로다: 생성 시각 ±1초 — 신원이 없으면 시계 이동을 막지 못한다 (잠금은 시작마다 새로 적혀 한 번의 재시작 동안만)', async () => {
    const { pid, proc } = liveHolder();
    const live = createProcessLiveness({ procRoot: proc.root });
    const createdAt = (BTIME + Math.floor(TICKS / 100)) * 1000;
    const legacy = (dataDir: string) =>
      writeFileSync(lockFilePath(dataDir), JSON.stringify({ pid, createdAt, kind: 'server', startedAt: new Date(createdAt + 100).toISOString() }));
    const same = tempData();
    legacy(same);
    expect(await acquireInstanceLock({ dataDir: same, kind: 'desktop', liveness: live, pid: 2222 })).toMatchObject({ ok: false, reason: 'held', pid });
    proc.setBtime(BTIME + 5);
    const stepped = tempData();
    legacy(stepped);
    const r = await acquireInstanceLock({ dataDir: stepped, kind: 'desktop', liveness: live, pid: 2222 });
    expect(r.ok).toBe(true);
    if (r.ok) r.release();
  });
});

// ───────────────────────── 재시작 복구 ─────────────────────────

const PID = 77_123;
const START = { bootId: FAKE_BOOT_ID, ticks: TICKS };

/** 앱이 비정상 종료해 끝 기록이 없는 실행 중 턴 */
function runningTurn(e: OrchEnv, o: { spawnedAt: string; start?: Turn['process']['start'] }): Turn {
  const now = e.ctx.now();
  const t: Turn = {
    id: e.ctx.store.nextId('turn'),
    sessionId: 'S-prev',
    memberId: e.devId,
    projectId: e.projectId,
    taskId: null,
    directiveId: null,
    sessionKind: 'task',
    slotClass: 'general',
    queueEntryIds: [],
    isResume: false,
    aiKind: 'codex',
    mock: false,
    startedAt: now,
    endedAt: null,
    lastActivityAt: now,
    process: { state: 'running', pid: PID, spawnedAt: o.spawnedAt, ...(o.start ? { start: o.start } : {}), exitCode: null, stopRequestedAt: null, stopMode: null, killDetail: null },
    endReason: null,
    endDetail: '',
    stepsCompleted: 0,
    toolCalls: 0,
    usage: null,
    bypass: 'requested',
    mcp: 'unknown',
    eventsFile: '',
    eventCount: 0,
    finalText: null,
  };
  e.ctx.store.turns.insert(t);
  return t;
}

/**
 * 재시작 뒤의 PID 모습: 살아 있고, 지금 신원은 live(없으면 읽지 못함), 생성 시각은 createdAt. 트리 종료와 생성 시각 조회를 기록한다
 */
function pidNow(e: OrchEnv, o: { live: typeof START | null; createdAt: number }): { kills: number[]; createdQueries: number[][] } {
  const kills: number[] = [];
  const createdQueries: number[][] = [];
  Object.assign(e.ctx.deps.runner as ProcessRunner, {
    isAlive: async (pid: number) => pid === PID,
    processStart: async (pids: number[]) => new Map(o.live ? pids.filter((p) => p === PID).map((p) => [p, o.live!]) : []),
    processCreatedAt: async (pids: number[]) => (createdQueries.push(pids), new Map(pids.map((p) => [p, o.createdAt]))),
    killTree: async (pid: number) => (kills.push(pid), { ok: true, remaining: 0, detail: '', durationMs: 1 }),
  });
  return { kills, createdQueries };
}

describe('띄운 기록: 턴의 process.start (S10-5.1)', () => {
  it('러너가 알려 준 신원을 턴 기록에 그대로 적고, 알려 주지 않으면(Windows·macOS·가짜) 키를 만들지 않는다', async () => {
    try {
      for (const start of [START, null]) {
        FakeProc.startForNew = start;
        const e = (env = await bootOrch());
        const r = await startReview(e, e.qaId);
        const recorded = e.ctx.store.turns.require(r.turnId).process;
        if (start) expect(recorded.start).toEqual(START);
        else expect(recorded).not.toHaveProperty('start');
        await e.close();
        env = null;
      }
    } finally {
      FakeProc.startForNew = null;
    }
  });
});

describe('재시작 복구: 이전 턴·서버 명령의 PID를 부팅 기준 신원으로 정확히 대조한다', () => {
  it('시계가 앞으로 움직여 생성 시각이 시작 기록보다 늦어 보여도, 신원이 같으면 그 턴의 CLI다 — 트리를 끝낸다 (예전엔 남의 것으로 두고 둘째 CLI를 띄웠다)', async () => {
    const e = (env = await bootOrch());
    const spawnedAt = new Date(Date.now() - 60_000).toISOString();
    const t = runningTurn(e, { spawnedAt, start: START });
    const { kills } = pidNow(e, { live: START, createdAt: Date.parse(spawnedAt) + 5_000 });
    const r = await e.core.recovery.run();
    expect(kills).toEqual([PID]);
    expect(r.killed).toBe(1);
    expect(e.ctx.store.turns.require(t.id).endDetail).toContain('남은 프로세스 종료 확인');
  });

  it('예전 기록(신원 없음)은 예전 규칙 그대로 — 같은 시계 이동이면 남의 것으로 두고 건드리지 않는다', async () => {
    const e = (env = await bootOrch());
    const spawnedAt = new Date(Date.now() - 60_000).toISOString();
    const t = runningTurn(e, { spawnedAt });
    const { kills } = pidNow(e, { live: START, createdAt: Date.parse(spawnedAt) + 5_000 });
    await e.core.recovery.run();
    expect(kills).toEqual([]);
    expect(e.ctx.store.turns.require(t.id).endDetail).toContain(`PID ${PID}는 다른 프로세스가 쓰고 있어 건드리지 않음`);
  });

  it('부팅이 다르거나(재부팅) 시작 틱이 다르면(PID 재사용) 생성 시각이 맞아 보여도 남의 프로세스 — 생성 시각을 묻지도 않는다', async () => {
    for (const live of [{ bootId: OTHER_BOOT, ticks: TICKS }, { bootId: FAKE_BOOT_ID, ticks: TICKS + 1 }]) {
      const e = (env = await bootOrch());
      const spawnedAt = new Date(Date.now() - 60_000).toISOString();
      const t = runningTurn(e, { spawnedAt, start: START });
      const { kills, createdQueries } = pidNow(e, { live, createdAt: Date.parse(spawnedAt) - 500 });
      await e.core.recovery.run();
      expect(kills, JSON.stringify(live)).toEqual([]);
      expect(createdQueries).toEqual([]);
      expect(e.ctx.store.turns.require(t.id).endDetail).toContain('다른 프로세스가 쓰고 있어 건드리지 않음');
      await e.close();
      env = null;
    }
  });

  it('지금 신원을 읽지 못하면(예: 다른 사용자의 /proc가 가려짐) 예전 규칙으로 판정한다', async () => {
    const e = (env = await bootOrch());
    const spawnedAt = new Date(Date.now() - 60_000).toISOString();
    runningTurn(e, { spawnedAt, start: START });
    const { kills, createdQueries } = pidNow(e, { live: null, createdAt: Date.parse(spawnedAt) - 500 });
    await e.core.recovery.run();
    expect(createdQueries).toEqual([[PID]]);
    expect(kills).toEqual([PID]);
  });

  it('서버 명령(host_exec 실행 기록의 result.start)도 같은 판정 — 시계가 움직여도 그 명령의 트리를 끝낸다', async () => {
    const e = (env = await bootOrch({ workspace: true }));
    const at = new Date(Date.now() - 60_000).toISOString();
    const rec: ExecRecord = {
      requestId: e.ctx.store.nextId('request'),
      kind: 'host_exec',
      projectId: null,
      taskId: null,
      cwd: e.mainWorkDir!,
      command: 'npm run build',
      target: '빌드',
      state: 'started',
      startedAt: at,
      endedAt: null,
      result: { toolRequestId: 'rq-build', turnId: 'TN-prev', sessionKey: MAIN_KEY, generation: 1, timeoutS: 600, pid: PID, spawnedAt: at, start: START },
    };
    e.ctx.store.execs.put(rec);
    const { kills } = pidNow(e, { live: START, createdAt: Date.parse(at) + 5_000 });
    await e.core.recovery.run();
    expect(kills).toEqual([PID]);
    expect(e.ctx.store.execs.get(rec.requestId)).toMatchObject({ state: 'failed', result: { processes: 'killed' } });
  });
});
