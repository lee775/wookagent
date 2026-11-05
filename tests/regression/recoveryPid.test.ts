/**
 * 재시작 복구의 PID 주인 대조 (windows:F2, ERR-06·08, CTL-11, 8장 앱·PC 재시작).
 * 이전 실행 턴의 PID를 지금 다른 프로세스가 쓰면(재부팅·재시작 뒤 PID 재사용) 그 프로세스 트리를 끊지 않는다.
 * 그 턴이 띄운 바로 그 프로세스(생성 시각 ≤ 기록한 시작 시각)만 종료한다. 확인하지 못하면 건드리지 않고 알린다.
 * 실제 프로세스 러너(생성 시각 조회·트리 종료)와 실제 프로세스로 확인한다.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import os from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import type { Turn } from '@shared/domain';
import type { Env } from './helpers';
import { boot, notices, sleep, waitFor } from './helpers';

let env: Env | null = null;
const procs: ChildProcess[] = [];
afterEach(async () => {
  for (const p of procs.splice(0)) {
    if (p.pid && alive(p.pid)) {
      try {
        process.kill(p.pid);
      } catch {
        // 이미 끝났다
      }
    }
  }
  await env?.close();
  env = null;
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** 대표의 편집기·브라우저처럼 욱채와 무관한 프로세스 (자식 하나를 둔 트리). POSIX는 그룹 리더로 띄운다 (재시작 복구의 그룹 종료 대상 모양) */
async function startTree(): Promise<{ parent: ChildProcess; child: number }> {
  const code = "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(c.pid);setInterval(()=>{},1000)";
  const parent = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, detached: process.platform !== 'win32' });
  procs.push(parent);
  const [chunk] = (await once(parent.stdout!, 'data')) as [Buffer];
  const child = Number(chunk.toString('utf8').trim());
  procs.push({ pid: child } as ChildProcess);
  return { parent, child };
}

/** 앱이 비정상 종료해 끝 기록이 없는 실행 중 턴 (재시작 복구 대상) */
function runningTurn(e: Env, pid: number, spawnedAt: string | null | undefined): Turn {
  const now = e.ctx.now();
  const t: Turn = {
    id: e.ctx.store.nextId('turn'),
    sessionId: 'S-prev',
    memberId: e.members[0]!.id,
    projectId: e.project.id,
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
    // spawnedAt이 없는 것 = 이 기록이 생기기 전에 저장된 턴
    process: { state: 'running', pid, ...(spawnedAt === undefined ? {} : { spawnedAt }), exitCode: null, stopRequestedAt: null, stopMode: null, killDetail: null },
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

const isoAgo = (ms: number) => new Date(Date.now() - ms).toISOString();

describe('재시작 복구는 같은 PID를 쓰는 다른 프로세스를 끊지 않는다 (windows:F2)', () => {
  it('턴이 시작된 뒤에 생긴 프로세스가 그 PID를 쓰면 건드리지 않는다 — 트리 전체가 살아 있고 종료 수에 넣지 않는다', async () => {
    env = await boot({ runner: true });
    const e = env;
    const { parent, child } = await startTree();
    // 10분 전에 시작한 턴의 PID를 지금은 방금 뜬 무관한 프로세스가 쓴다
    const t = runningTurn(e, parent.pid!, isoAgo(10 * 60_000));
    const r = await e.core.recovery.run();
    await sleep(300);
    expect(alive(parent.pid!)).toBe(true);
    expect(alive(child)).toBe(true);
    expect(r.killed).toBe(0);
    const after = e.ctx.store.turns.require(t.id);
    expect(after).toMatchObject({ endReason: 'app_restart', process: { state: 'exited' } });
    expect(after.endDetail).toContain(`PID ${parent.pid}는 다른 프로세스가 쓰고 있어 건드리지 않음`);
  });

  it('PC가 다시 켜진 뒤면(시작 기록이 부팅보다 이르면) 생성 시각을 조회하지 않고 다른 프로세스로 본다', async () => {
    env = await boot({ runner: true });
    const e = env;
    const { parent } = await startTree();
    const runner = e.ctx.deps.runner;
    const queried: number[][] = [];
    const orig = runner.processCreatedAt.bind(runner);
    runner.processCreatedAt = async (pids) => {
      queried.push(pids);
      return orig(pids);
    };
    const bootMs = Date.now() - os.uptime() * 1000;
    runningTurn(e, parent.pid!, new Date(bootMs - 60_000).toISOString());
    await e.core.recovery.run();
    expect(queried).toEqual([]);
    expect(alive(parent.pid!)).toBe(true);
  });

  it('시작 시각 기록이 없는 이전 기록·생성 시각을 읽지 못한 PID는 건드리지 않고 복구 알림에 적는다 (fail-safe)', async () => {
    env = await boot({ runner: true });
    const e = env;
    const legacy = await startTree();
    const unreadable = await startTree();
    const runner = e.ctx.deps.runner;
    const orig = runner.processCreatedAt.bind(runner);
    // 조회가 실패한 PID는 결과에서 빠진다 (권한·PowerShell 없음 등)
    runner.processCreatedAt = async (pids) => {
      const m = await orig(pids);
      m.delete(unreadable.parent.pid!);
      return m;
    };
    const t1 = runningTurn(e, legacy.parent.pid!, undefined);
    const t2 = runningTurn(e, unreadable.parent.pid!, isoAgo(1000));
    const r = await e.core.recovery.run();
    await sleep(300);
    expect(r.killed).toBe(0);
    expect(alive(legacy.parent.pid!)).toBe(true);
    expect(alive(unreadable.parent.pid!)).toBe(true);
    expect(e.ctx.store.turns.require(t1.id).endDetail).toContain('이 턴의 프로세스인지 확인하지 못해 건드리지 않음 (시작 시각 기록이 없는 이전 기록)');
    expect(e.ctx.store.turns.require(t2.id).endDetail).toContain('이 턴의 프로세스인지 확인하지 못해 건드리지 않음 (프로세스 생성 시각을 읽지 못함)');
    expect(notices(e, '재시작 복구').at(-1)?.body).toContain('이전 프로세스 2개는 같은 프로세스인지 확인하지 못해 그대로 둠');
  });

  it('그 턴이 띄운 프로세스가 남아 있으면(생성 시각 ≤ 시작 기록) 트리째 종료한다 — 종료를 확인하면 세고, 확인할 수 없으면(작업 개체 러너 없는 taskkill 방식) 종료 확인 실패로 남기고 막는다 (CTL-11)', async () => {
    env = await boot({ runner: true });
    const e = env;
    const { parent, child } = await startTree();
    // 턴 실행기는 spawn 직후 시각을 적는다 → 실제 생성 시각보다 같거나 늦다
    const t = runningTurn(e, parent.pid!, new Date().toISOString());
    const exited = once(parent, 'exit');
    const r = await e.core.recovery.run();
    await exited;
    await waitFor(() => !alive(child), '자식 프로세스 종료', 5000);
    const turn = e.ctx.store.turns.require(t.id);
    if (e.ctx.deps.runner.mode === 'taskkill') {
      // taskkill /T는 지금 살아 있는 부모-자식 연결만 따라가 부모가 먼저 끝난 후손은 확인할 수 없다 — 트리는 끊었지만 종료 확인으로 세지 않는다
      expect(r.killed).toBe(0);
      expect(turn.process.state).toBe('kill_failed');
      expect(turn.endDetail).toContain('부모가 먼저 끝난 후손은 확인할 수 없습니다');
      expect(notices(e, '프로세스 종료 확인 실패').map((n) => n.level)).toEqual(['urgent']);
      // 작업 세션의 이전 실행은 작업 보류 쪽 글이다 — 메인 에이전트 업무가 없으니 명령창으로 알려 달라고 한다 (리드 결정 32)
      expect(notices(e, '프로세스 종료 확인 실패')[0]!.body).toContain('명령창으로 메인 에이전트에게 알려 주세요. 메인 에이전트가 확인하고 이어 갑니다');
      expect(notices(e, '프로세스 종료 확인 실패')[0]!.body).not.toContain('메인 에이전트가 다시 이어 갑니다');
      expect(notices(e, '재시작 복구').at(-1)?.body).toContain('하위 프로세스 종료를 확인하지 못해 그 일을 멈춤');
    } else {
      expect(r.killed).toBe(1);
      expect(turn.process.state).toBe('exited');
      expect(turn.endDetail).toContain('남은 프로세스 종료 확인');
      expect(notices(e, '재시작 복구').at(-1)?.body).toContain('남은 프로세스 1개 종료');
    }
  });
});
