/**
 * 메인 에이전트(M-MAIN)가 일시정지되면 대표의 '정지 해제'가 푼다 (리드 결정 6, 10-29 — owner-surface 리뷰 H1, 프로브 P1·P1b).
 * 메인은 자기를 일시정지하지 못한다(pause_member 거부). 그래도 메인이 정지되는 길이 있다: 메인 턴이 하위 프로세스를 남기고 끝나거나, 긴급 정지·재시작
 * 복구가 이전 메인 실행의 종료를 확인하지 못하면 프로그램이 M-MAIN을 일시정지한다(CTL-11, 관리 세션 규칙). 예전 DB에 대표가 걸어 둔 M-MAIN 정지도 있다.
 * 정지된 메인은 턴이 뜨지 않아 resume_member를 부를 수 없고, 대표 세션의 members.resume은 없다. 그래서:
 * - stop.release(대표)가 M-MAIN의 일시정지를 함께 푼다 — 긴급 정지가 없어도. 기록(행위자 대표)·알림을 남기고, 쌓인 대표 명령이 처리된다
 * - 메인 실행의 종료 확인 실패 알림은 남은 프로세스가 사라졌는지 확인한 뒤 '정지 해제'를 누르라고 쓴다
 * - 풀린 상태는 재시작 뒤에도 그대로이고, 풀 것이 없으면 정지 해제는 아무것도 하지 않는다
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID, type Turn } from '@shared/domain';
import type { ProcessRunner } from '../../src/main/process/types';
import { bootRestartable, sleep, waitUntil, type RestartableEnv } from '../acceptance/stops-helpers';

let env: RestartableEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const mainLaunches = (e: RestartableEnv) => e.launches.filter((l) => l.memberId === MAIN_AGENT_ID).length;
const codeOf = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (err: { code?: string }) => err.code ?? 'error',
  );
const releaseRows = (e: RestartableEnv) => e.ctx.store.activity.search({ text: '정지 해제로 메인 에이전트 일시정지를 풂', limit: 20 });
const queuedMainCommands = (e: RestartableEnv) => e.ctx.store.queue.list({ ref1: MAIN_AGENT_ID, state: 'queued' }).filter((q) => q.kind === 'main_command');

/** 대표 명령을 보내고 한 번 돌려 메인 턴이 몇 번 떴는지 */
async function commandLaunches(e: RestartableEnv, text: string): Promise<number> {
  const before = mainLaunches(e);
  await e.invoke('command.send', { target: 'main', text });
  e.tick();
  await sleep(300);
  return mainLaunches(e) - before;
}

describe('메인 에이전트 일시정지는 대표의 정지 해제로 풀린다 (리드 결정 6)', () => {
  it('메인 턴이 하위 프로세스를 남겨 프로그램이 M-MAIN을 일시정지하면 — 알림이 정지 해제를 안내하고, 긴급 정지 없이 누른 정지 해제가 풀어 쌓인 명령이 처리되며 재시작 뒤에도 풀린 채다', async () => {
    env = await bootRestartable();
    let e = env;
    e.script.set('main:general', (p) => {
      p.emit({ kind: 'result', text: '끝', data: {} });
      p.exit(0, { remaining: 2 });
    });
    await e.invoke('command.send', { target: 'main', text: '현황 알려 줘' });
    await e.drain(2);
    e.script.clear();
    expect(e.ctx.stop().members[MAIN_AGENT_ID]).toMatchObject({ paused: true, by: 'system' });
    // 긴급 알림: 남은 프로세스가 사라졌는지 확인한 뒤 '정지 해제'를 누르라고 (메인이 스스로 풀 수 없다)
    const notice = e.ctx.store.notifications.list().filter((n) => n.key === 'kill-failed:main:general');
    expect(notice.map((n) => n.level)).toEqual(['urgent']);
    expect(notice[0]!.body).toContain('하위 프로세스 2개가 남았습니다');
    expect(notice[0]!.body).toContain("모두 사라졌는지 확인한 뒤 '정지 해제'를 누르세요");
    expect(notice[0]!.body).not.toContain('재개하세요');
    // 정지된 동안: 대표 세션에는 팀원 재개가 없고, 메인 도구는 정지 검사에 막히며, 대표 명령은 쌓이기만 한다
    expect(await codeOf(e.invoke('members.resume', MAIN_AGENT_ID))).toBe('forbidden');
    expect(await codeOf(e.main('resume_member', { member_id: MAIN_AGENT_ID, reason: '정리 확인' }))).toBe('stopped');
    expect(await commandLaunches(e, '메인 일시정지를 풀어 줘')).toBe(0);
    expect(queuedMainCommands(e)).toHaveLength(1);
    expect(e.ctx.stop().global.active).toBe(false);

    // 대표가 남은 프로세스를 확인하고 정지 해제 (긴급 정지는 걸려 있지 않다)
    await e.invoke('stop.release');
    expect(e.ctx.stop().members[MAIN_AGENT_ID]).toBeUndefined();
    expect(releaseRows(e).map((r) => [r.actor, r.memberId])).toEqual([['owner', MAIN_AGENT_ID]]);
    expect(releaseRows(e)[0]!.text).toContain('프로세스 종료를 확인하지 못함');
    expect(e.ctx.store.notifications.list().filter((n) => n.key === 'main-paused').map((n) => [n.level, n.title])).toEqual([['info', '메인 에이전트 다시 시작']]);
    // 쌓인 명령이 처리된다
    const before = mainLaunches(e);
    e.tick();
    await waitUntil(() => mainLaunches(e) > before, '쌓인 대표 명령 처리');
    await e.idle();
    expect(queuedMainCommands(e)).toEqual([]);

    // 재시작해도 풀린 채다
    env = await e.stopGracefully();
    e = env;
    expect(e.ctx.stop().members[MAIN_AGENT_ID]).toBeUndefined();
    expect(await commandLaunches(e, '다시 시작했어?')).toBe(1);
  });

  it('긴급 정지 중 메인 턴의 종료를 확인하지 못해 M-MAIN이 일시정지돼도, 정지 해제 한 번으로 전역 정지와 메인 일시정지가 함께 풀려 대표 명령이 처리된다', async () => {
    env = await bootRestartable();
    const e = env;
    e.hold.add('main:general');
    await e.invoke('command.send', { target: 'main', text: '현황 알려 줘' });
    e.tick();
    await waitUntil(() => !!e.liveProc('main:general', MAIN_AGENT_ID), '메인 턴 시작');
    e.liveProc('main:general', MAIN_AGENT_ID)!.terminateResult = { ok: false, remaining: 1, detail: '하위 프로세스 1개 남음', durationMs: 1 };
    await e.invoke('stop.emergency');
    await waitUntil(() => e.core.turns.count() === 0, '메인 턴 정리');
    await waitUntil(() => !!e.ctx.stop().members[MAIN_AGENT_ID], '메인 일시정지');
    e.hold.clear();
    expect(e.ctx.stop().members[MAIN_AGENT_ID]).toMatchObject({ paused: true, by: 'system' });
    await e.invoke('stop.release');
    expect(e.ctx.stop().global.active).toBe(false);
    expect(e.ctx.stop().members[MAIN_AGENT_ID]).toBeUndefined();
    expect(releaseRows(e).map((r) => r.actor)).toEqual(['owner']);
    expect(await commandLaunches(e, '다시 해 줘')).toBe(1);
  });

  it('예전 DB에 대표가 걸어 둔 M-MAIN 일시정지도 재시작 뒤 남아 있다가 정지 해제로 풀린다 — 다시 누르면 아무것도 하지 않는다', async () => {
    env = await bootRestartable();
    let e = env;
    const s = e.ctx.stop();
    s.members[MAIN_AGENT_ID] = { paused: true, mode: 'graceful', since: e.ctx.now(), by: 'owner' };
    e.ctx.saveStop(s);
    env = await e.stopGracefully();
    e = env;
    expect(e.ctx.stop().members[MAIN_AGENT_ID]).toMatchObject({ paused: true, by: 'owner' });
    expect(await commandLaunches(e, '현황 알려 줘')).toBe(0);
    await e.invoke('stop.release');
    expect(e.ctx.stop().members[MAIN_AGENT_ID]).toBeUndefined();
    expect(releaseRows(e).map((r) => r.text)).toEqual(['정지 해제로 메인 에이전트 일시정지를 풂 — 대표의 일시정지']);
    e.tick();
    await waitUntil(() => mainLaunches(e) === 1, '쌓인 대표 명령 처리');
    await e.idle();
    // 풀 것이 없으면 정지 해제는 기록도 알림도 남기지 않는다
    const notices = e.ctx.store.notifications.list().length;
    const seq0 = e.ctx.store.activity.search({ limit: 1 })[0]!.seq;
    await e.invoke('stop.release');
    expect(releaseRows(e)).toHaveLength(1);
    expect(e.ctx.store.notifications.list()).toHaveLength(notices);
    expect(e.ctx.store.activity.search({ limit: 50 }).filter((r) => r.seq > seq0 && r.actor === 'owner')).toEqual([]);
  });

  it('재시작 복구가 이전 메인 실행의 종료를 확인하지 못하면 M-MAIN을 일시정지하고 정지 해제를 안내한다 — 정지 해제가 푼다', async () => {
    env = await bootRestartable();
    const e = env;
    // 앱이 비정상 종료해 끝 기록이 없는 이전 메인 실행 (그 PID는 아직 이 실행의 프로세스다)
    const now = e.ctx.now();
    const spawnedMs = Date.parse(now);
    const prev: Turn = {
      id: e.ctx.store.nextId('turn'),
      sessionId: 'S-prev-main',
      memberId: MAIN_AGENT_ID,
      projectId: null,
      taskId: null,
      directiveId: null,
      sessionKind: 'main_general',
      slotClass: 'management',
      queueEntryIds: [],
      isResume: false,
      aiKind: 'claude',
      mock: true,
      startedAt: now,
      endedAt: null,
      lastActivityAt: now,
      process: { state: 'running', pid: 99_901, spawnedAt: now, exitCode: null, stopRequestedAt: null, stopMode: null, killDetail: null },
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
    e.ctx.store.turns.insert(prev);
    const runner = e.ctx.deps.runner as ProcessRunner;
    Object.assign(runner, {
      isAlive: async () => true,
      processCreatedAt: async (pids: number[]) => new Map(pids.map((p) => [p, spawnedMs - 500])),
      killTree: async () => ({ ok: false, remaining: -1, detail: '남은 후손을 확인하지 못함', durationMs: 1 }),
    });
    await e.core.recovery.run();
    expect(e.ctx.store.turns.require(prev.id).process.state).toBe('kill_failed');
    expect(e.ctx.stop().members[MAIN_AGENT_ID]).toMatchObject({ paused: true, by: 'system' });
    const notice = e.ctx.store.notifications.list().filter((n) => n.key === 'kill-failed:S-prev-main');
    expect(notice).toHaveLength(1);
    expect(notice[0]!.body).toContain('이전 실행 종료 뒤 남은 하위 프로세스를 확인하지 못했습니다');
    expect(notice[0]!.body).toContain("모두 사라졌는지 확인한 뒤 '정지 해제'를 누르세요");
    Object.assign(runner, { isAlive: async () => false });
    await e.invoke('stop.release');
    expect(e.ctx.stop().members[MAIN_AGENT_ID]).toBeUndefined();
    expect(await commandLaunches(e, '현황 알려 줘')).toBe(1);
  });
});
