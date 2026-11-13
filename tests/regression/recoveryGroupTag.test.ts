/**
 * 재시작 복구: 리더(그 턴의 CLI)는 끝났는데 그 프로세스 그룹이 남은 경우 (리드 결정 S10-5.4 → S10-10.2).
 * Linux는 그룹 번호를 쓰는 동안 그 번호를 새 PID로 주지 않는다 — 남은 그룹은 그 턴의 것이거나, 그 턴의 그룹이 다 끝난 뒤 같은 번호를 받은 다른 프로세스가
 * 만든 그룹이다. 시작 틱으로는 둘을 가를 수 없다. 그래서 띄울 때 실행 표시(WOOK_RUN_TAG 값)를 턴·서버 명령 기록에 남기고, 남은 구성원 **모두**의 환경을
 * 읽을 수 있고 모두 그 표시를 가졌을 때만 그 그룹을 끝낸다. 표시 없는 구성원이 있으면 다른 그룹, 읽지 못하면 확인하지 못함 — 둘 다 건드리지 않고 그렇게 적는다.
 * 잡는 결함: 남은 그룹을 표시 없이(또는 일부만 보고) 끝냄 — 같은 번호를 받은 남의 프로세스 그룹을 끊음, 표시를 기록하지 않음·보지 않음 — 리더가 끝난
 * 그 턴의 개발 서버가 재시작 뒤에도 남음
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExecRecord, Turn } from '@shared/domain';
import type { ProcessRunner } from '../../src/main/process/types';
import { PROC_ROOT, procStartOf, RUN_TAG_ENV, type GroupOwnership } from '../../src/main/process/procfs';
import { bootOrch, FakeProc, startReview, type OrchEnv } from './orchHarness';
import { MAIN_KEY } from './hostExecRig';
import { boot, notices, type Env } from './helpers';

const TAG = '0123456789abcdef';
const PID = 77_321;
const START = { bootId: '0f6c2a3e-5b7d-4c1e-9a8b-112233445566', ticks: 4_242 };

let orch: OrchEnv | null = null;
let env: Env | null = null;
const kids: ChildProcess[] = [];
const dirs: string[] = [];
afterEach(async () => {
  // 그룹 구성원은 그만 파일이 생기면 스스로 끝난다 (기록한 PID로 죽이지 않는다)
  const made = dirs.splice(0);
  for (const d of made) {
    try {
      writeFileSync(join(d, 'quit'), '');
    } catch {
      // 이미 지움
    }
  }
  for (const k of kids.splice(0)) if (k.exitCode === null && k.signalCode === null) k.kill();
  await orch?.close();
  orch = null;
  await env?.close();
  env = null;
  await new Promise((r) => setTimeout(r, 300));
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

type TurnShape = { memberId: string; projectId: string; pid: number; runTag?: string | null; start?: Turn['process']['start'] };

/** 앱이 비정상 종료해 끝 기록이 없는 실행 중 턴 */
function runningTurn(ctx: OrchEnv['ctx'], o: TurnShape): Turn {
  const now = ctx.now();
  const t: Turn = {
    id: ctx.store.nextId('turn'),
    sessionId: 'S-prev',
    memberId: o.memberId,
    projectId: o.projectId,
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
    process: {
      state: 'running',
      pid: o.pid,
      spawnedAt: new Date().toISOString(),
      ...(o.start ? { start: o.start } : {}),
      ...(o.runTag ? { runTag: o.runTag } : {}),
      exitCode: null,
      stopRequestedAt: null,
      stopMode: null,
      killDetail: null,
    },
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
  ctx.store.turns.insert(t);
  return t;
}

/** 가짜 러너: 그 PID의 리더는 끝났고 그룹이 남았다 — 그룹 판정은 verdict. 판정·트리 종료를 부른 기록 */
function leaderGone(e: OrchEnv, verdict: GroupOwnership | null): { kills: number[]; asked: [number, string][] } {
  const kills: number[] = [];
  const asked: [number, string][] = [];
  Object.assign(e.ctx.deps.runner as ProcessRunner, {
    isAlive: async (pid: number) => pid === PID,
    processStart: async () => new Map(),
    processCreatedAt: async () => new Map(),
    groupOwnership: async (pgid: number, tag: string) => (asked.push([pgid, tag]), verdict),
    killTree: async (pid: number) => (kills.push(pid), { ok: true, remaining: 0, detail: '', durationMs: 1 }),
  });
  return { kills, asked };
}

describe('남은 그룹의 판정 (가짜 러너 — 모든 플랫폼)', () => {
  it('구성원 모두가 그 턴의 표시를 가졌으면 그 턴의 것 — 그룹을 끝낸다', async () => {
    const e = (orch = await bootOrch());
    const t = runningTurn(e.ctx, { memberId: e.devId, projectId: e.projectId, pid: PID, runTag: TAG, start: START });
    const { kills, asked } = leaderGone(e, { verdict: 'ours' });
    const r = await e.core.recovery.run();
    expect(asked).toEqual([[PID, TAG]]);
    expect(kills).toEqual([PID]);
    expect(r.killed).toBe(1);
    expect(e.ctx.store.turns.require(t.id).endDetail).toContain('남은 프로세스 종료 확인');
  });

  it('표시 없는 구성원이 있으면(같은 번호를 받은 다른 그룹) 건드리지 않고, 환경을 읽지 못하면 확인하지 못했다고 적는다', async () => {
    const e = (orch = await bootOrch());
    const other = runningTurn(e.ctx, { memberId: e.devId, projectId: e.projectId, pid: PID, runTag: TAG });
    const { kills } = leaderGone(e, { verdict: 'other', why: '표시 없음' });
    await e.core.recovery.run();
    expect(kills).toEqual([]);
    expect(e.ctx.store.turns.require(other.id).endDetail).toContain(`PID ${PID}는 다른 프로세스가 쓰고 있어 건드리지 않음`);
    await e.close();
    const e2 = (orch = await bootOrch());
    const unknown = runningTurn(e2.ctx, { memberId: e2.devId, projectId: e2.projectId, pid: PID, runTag: TAG });
    const why = '리더가 끝난 그룹의 구성원 1개의 환경을 읽지 못해 그 실행의 것인지 확인하지 못함';
    const second = leaderGone(e2, { verdict: 'unknown', why });
    await e2.core.recovery.run();
    expect(second.kills).toEqual([]);
    expect(e2.ctx.store.turns.require(unknown.id).endDetail).toContain(`이 턴의 프로세스인지 확인하지 못해 건드리지 않음 (${why})`);
  });

  it('표시를 남기지 않은 턴(다른 플랫폼·이전 기록)은 그룹을 판정하지 않고 예전처럼 둔다', async () => {
    const e = (orch = await bootOrch());
    const t = runningTurn(e.ctx, { memberId: e.devId, projectId: e.projectId, pid: PID, start: START });
    const { kills, asked } = leaderGone(e, { verdict: 'ours' });
    await e.core.recovery.run();
    expect(asked).toEqual([]);
    expect(kills).toEqual([]);
    expect(e.ctx.store.turns.require(t.id).endDetail).toContain('확인하지 못해 건드리지 않음 (프로세스 생성 시각을 읽지 못함)');
  });

  it('서버 명령(host_exec 실행 기록의 result.runTag)도 같다', async () => {
    const e = (orch = await bootOrch({ workspace: true }));
    const at = e.ctx.now();
    const rec: ExecRecord = {
      requestId: e.ctx.store.nextId('request'),
      kind: 'host_exec',
      projectId: null,
      taskId: null,
      cwd: e.mainWorkDir!,
      command: 'npm run dev',
      target: '개발 서버',
      state: 'started',
      startedAt: at,
      endedAt: null,
      result: { toolRequestId: 'rq-dev', turnId: 'TN-prev', sessionKey: MAIN_KEY, generation: 1, timeoutS: 600, pid: PID, spawnedAt: at, runTag: TAG },
    };
    e.ctx.store.execs.put(rec);
    const { kills, asked } = leaderGone(e, { verdict: 'ours' });
    await e.core.recovery.run();
    expect(asked).toEqual([[PID, TAG]]);
    expect(kills).toEqual([PID]);
    expect(e.ctx.store.execs.get(rec.requestId)).toMatchObject({ result: { processes: 'killed' } });
  });

  it('띄운 기록: 러너가 알려 준 표시를 턴 기록에 적고, 없으면 키를 만들지 않는다', async () => {
    try {
      for (const tag of [TAG, null]) {
        FakeProc.runTagForNew = tag;
        const e = (orch = await bootOrch());
        const r = await startReview(e, e.qaId);
        const recorded = e.ctx.store.turns.require(r.turnId).process;
        if (tag) expect(recorded.runTag).toBe(TAG);
        else expect(recorded).not.toHaveProperty('runTag');
        await e.close();
        orch = null;
      }
    } finally {
      FakeProc.runTagForNew = null;
    }
  });
});

/**
 * 실제 프로세스 (Linux 전용 — 실제 /proc가 필요하다): 시험이 setsid로 띄운 리더가 구성원 하나를 남기고 끝난다. 구성원은 그만 파일이 생기면 스스로 끝난다
 */
const LEADER = `const { spawn } = require('child_process');
const dir = process.argv[1];
const keep = "const f=require('fs');const d=process.argv[1];setInterval(()=>{if(f.existsSync(d+'/quit')||!f.existsSync(d))process.exit(0)},100);setTimeout(()=>process.exit(0),60000)";
const c = spawn(process.execPath, ['-e', keep, dir], { stdio: 'ignore' });
c.unref();
process.stdout.write(String(c.pid) + '\\n');`;

async function leaderLeavingMember(envTag: string | null): Promise<{ leader: number; member: number; start: ReturnType<typeof procStartOf> }> {
  const dir = mkdtempSync(join(tmpdir(), 'wook-test-grouptag-'));
  dirs.push(dir);
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  delete childEnv[RUN_TAG_ENV];
  if (envTag) childEnv[RUN_TAG_ENV] = envTag;
  const leader = spawn(process.execPath, ['-e', LEADER, dir], { detached: true, stdio: ['ignore', 'pipe', 'ignore'], env: childEnv });
  kids.push(leader);
  const start = procStartOf(leader.pid!, PROC_ROOT);
  const [chunk] = (await once(leader.stdout!, 'data')) as [Buffer];
  const member = Number(chunk.toString('utf8').trim());
  await once(leader, 'exit'); // 리더는 끝났고 거둬졌다 — 그룹은 구성원 하나로 남는다
  return { leader: leader.pid!, member, start };
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ESRCH';
  }
};

describe.skipIf(process.platform !== 'linux')('실제 프로세스 (Linux 전용: 실제 /proc가 필요하다)', () => {
  it('리더가 끝나고 그 턴의 표시를 가진 구성원이 남은 그룹은 끝낸다', async () => {
    const e = (env = await boot({ runner: true }));
    const g = await leaderLeavingMember(TAG);
    expect(alive(g.member)).toBe(true);
    const t = runningTurn(e.ctx, { memberId: e.members[0]!.id, projectId: e.project.id, pid: g.leader, runTag: TAG, start: g.start });
    const r = await e.core.recovery.run();
    expect(r.killed).toBe(1);
    expect(e.ctx.store.turns.require(t.id).endDetail).toContain('남은 프로세스 종료 확인');
    const deadline = performance.now() + 3000;
    while (alive(g.member) && performance.now() < deadline) await new Promise((res) => setTimeout(res, 25));
    expect(alive(g.member)).toBe(false);
  });

  it('같은 번호의 다른 그룹(구성원에 그 턴의 표시가 없음)은 건드리지 않고 그렇게 적는다', async () => {
    const e = (env = await boot({ runner: true }));
    const g = await leaderLeavingMember('ffffeeeeddddcccc');
    const t = runningTurn(e.ctx, { memberId: e.members[0]!.id, projectId: e.project.id, pid: g.leader, runTag: TAG, start: g.start });
    const r = await e.core.recovery.run();
    await new Promise((res) => setTimeout(res, 300));
    expect(r.killed).toBe(0);
    expect(alive(g.member)).toBe(true);
    expect(e.ctx.store.turns.require(t.id).endDetail).toContain(`PID ${g.leader}는 다른 프로세스가 쓰고 있어 건드리지 않음`);
    expect(notices(e, '재시작 복구').at(-1)?.body ?? '').not.toContain('남은 프로세스');
  });
});

