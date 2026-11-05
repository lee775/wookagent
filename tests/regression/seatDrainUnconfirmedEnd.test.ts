/**
 * 교체가 나가는 메인 턴의 마무리를 기다리는 동안 그 턴이 교체 밖의 정지(대표의 긴급 정지 등)로 끝났는데 종료를 확인하지 못했으면, 교체가 스스로 멈춘 때와
 * 같이 새 보유자를 앉히지 않는다 (리드 결정 S4-26, SERVER_DESIGN 4.3 2번, CTL-11):
 * - 표시는 turns.blockUnconfirmedRun이 쓰는 것과 같다 — 턴 기록의 kill_failed. 교체를 청한 뒤에 끝난 M-MAIN의 main:*·review:* 턴을 본다
 * - 멈춤은 holdUnconfirmed 그대로다: 단계 unconfirmed, M-MAIN에 CTL-11 일시정지(이미 있으면 그대로), 정지 해제 한 번이 교체를 잇는다
 * - 교체를 청하기 전에 끝난 턴의 종료 확인 실패는 이 교체를 멈추지 않는다 (그 실행은 그때 이미 막혔다)
 * - 찾는 턴은 M-MAIN의 것만, 최근 것부터다 — 다른 팀원의 검수 턴은 이 교체를 멈추지 않고, 앞서 끝난 M-MAIN 턴이 많아도 나가는 턴을 찾는다. 교체가 스스로
 *   멈춘 정지가 ok를 돌려줘도 턴 마무리가 남은 하위 프로세스를 셌으면 멈춘다 (S4F3 6절, 리드 결정 S4-34·S4-35 1번)
 * - 앱이 2번 중에 끝나 다음 시작이 이어 가는 교체도 같다 (리드 결정 S4-32): 재시작 복구가 끊은 턴의 종료를 확인하면(exited) 앉히고, 확인하지 못하면
 *   (kill_failed) 멈춘다. 앞 실행이 이미 kill_failed로 적은 턴도 멈춘다. 정지 해제로 이미 이어 가던 교체는 다시 멈추지 않는다 (리드 결정 S4-38)
 * - 교체가 끝나면 멈췄다는 알림은 읽음이 된다 (리드 결정 S4-36)
 * 탐침 zz-sa2-new S2(server-s4fix1-seat-authority), fix2Gaps G2·G3·G4·G7(server-s4fix2-tests-integrity), zz-close-resume R1·R2(server-s4close-check)에서 왔다
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID, type AiConfig, type Turn } from '@shared/domain';
import type { ProcessRunner } from '../../src/main/process/types';
import { bootOrch, notices, sleep, startReview, waitFor, type OrchEnv } from './orchHarness';
import { hostExec, liveMainTurn, scriptedHost } from './hostExecRig';

let env: OrchEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const CODEX: AiConfig = { kind: 'codex', model: null, effortTier: 'high', effortOverride: null };
const KEY = 'main:general';
const UNCONFIRMED = { ok: false, remaining: -1, detail: '가짜 종료 확인 실패', durationMs: 1 } as const;
const operatorSwap = (e: OrchEnv) => e.core.seat.assign({ holder: { kind: 'launched', ai: CODEX }, by: 'operator', reason: '운영자 교체' });
const seatRows = (e: OrchEnv) => e.ctx.store.activity.search({ kinds: ['seat'], limit: 50 }).map((r) => r.text);

/** 멈춘 교체 — 새 보유자는 앉지 않았고 M-MAIN이 일시정지돼 화면에 '정지 해제'가 있다 */
function held(e: OrchEnv) {
  const v = e.core.seat.view();
  return {
    stage: e.ctx.store.seat.get('main')!.swap?.stage ?? null,
    state: v.state,
    holder: v.holder?.label,
    pending: v.pendingHolder?.label ?? null,
    mainPaused: !!e.ctx.stop().members[MAIN_AGENT_ID]?.paused,
  };
}

/** 정지 해제 한 번이 교체를 한 번만 잇는다 */
async function releaseContinuesOnce(e: OrchEnv): Promise<void> {
  await e.invoke('stop.release');
  await e.core.seat.settled();
  expect(e.core.seat.view()).toMatchObject({ generation: 2, state: 'active', holder: { label: 'Codex CLI' } });
  expect(e.ctx.stop().global.active).toBe(false);
  expect(e.ctx.stop().members[MAIN_AGENT_ID]).toBeUndefined();
  expect(e.core.seat.history().map((h) => `${h.generation}:${h.holder.label}`)).toEqual(['2:Codex CLI', '1:Claude CLI']);
  expect(notices(e, '메인 에이전트가 바뀌었습니다')).toHaveLength(1);
  expect(seatRows(e).filter((t) => t.startsWith('메인 자리 교체 끝'))).toHaveLength(1);
  // 멈췄다는 알림('다시 정지 해제를 누르세요')은 교체가 끝나면 읽음이 되고, 바뀌었다는 알림은 읽지 않은 채 남는다 (리드 결정 S4-36)
  expect(notices(e, '메인 자리 교체가 멈췄습니다').filter((n) => !n.readAt)).toEqual([]);
  expect(notices(e, '메인 에이전트가 바뀌었습니다')).toMatchObject([{ key: 'seat-change:2', readAt: null }]);
}

/** 앞 실행이 교체 2번 중에 끝난 모습 — 자리 한 줄은 switching·draining, 새 세대의 이력 줄이 열려 있다 (seatMemoTurn의 재시작 시험과 같은 흉내) */
function seatLeftDraining(e: OrchEnv, requestedAt: string): void {
  const row = e.ctx.store.seat.get('main')!;
  const codex = { kind: 'launched' as const, ai: CODEX };
  e.ctx.store.seat.put({
    ...row,
    generation: 2,
    state: 'switching',
    pendingHolder: codex,
    swap: { from: 1, to: 2, by: 'operator', reason: '운영자 교체', note: null, force: false, callerTurnId: null, requestedAt, stage: 'draining' },
  });
  e.ctx.store.seatHistory.insert({ id: 'G-0002', generation: 2, holder: codex, startedAt: requestedAt, endedAt: null, startReason: '운영자 교체', endReason: null, changedBy: 'operator', handoverId: null });
}

/** 앱이 비정상 종료해 끝 기록이 없는 이전 메인 대화 턴 (그 PID는 아직 이 실행의 프로세스다 — mainPauseRelease의 재시작 복구 시험과 같은 모양) */
function runningPrevMainTurn(e: OrchEnv, killTree: { ok: boolean; remaining: number; detail: string }): string {
  const now = e.ctx.now();
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
    process: { state: 'running', pid: 99_902, spawnedAt: now, exitCode: null, stopRequestedAt: null, stopMode: null, killDetail: null },
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
  Object.assign(e.ctx.deps.runner as ProcessRunner, {
    isAlive: async () => true,
    processCreatedAt: async (pids: number[]) => new Map(pids.map((p) => [p, Date.parse(now) - 500])),
    killTree: async () => ({ ...killTree, durationMs: 1 }),
  });
  return prev.id;
}

describe('교체 밖의 정지로 끝난 나가는 메인 턴 (seatDrainUnconfirmedEnd)', () => {
  it('기다리던 메인 검수 턴을 긴급 정지가 끝냈는데 종료를 확인하지 못하면 새 보유자를 앉히지 않고 멈춘다 — 정지 해제 한 번이 잇는다 (탐침 S2)', async () => {
    const e = (env = await bootOrch());
    e.core.seat.applyOperatorConfig({ holders: null, drainMs: 60_000, initialHolder: null }, '시험');
    const { proc, turnId } = await startReview(e, MAIN_AGENT_ID);
    proc.terminateResult = { ...UNCONFIRMED };
    const swap = operatorSwap(e);
    await sleep(100);
    expect(e.core.seat.view().state).toBe('switching');
    // 교체가 아니라 대표의 긴급 정지가 그 검수 턴을 끝낸다 — 종료 확인 실패(검수 턴은 작업 보류로만 막힌다)
    await e.invoke('stop.emergency');
    await swap.done;
    expect(e.ctx.store.turns.require(turnId).process.state).toBe('kill_failed');
    expect(held(e)).toEqual({ stage: 'unconfirmed', state: 'switching', holder: 'Claude CLI', pending: 'Codex CLI', mainPaused: true });
    expect(e.ctx.stop().members[MAIN_AGENT_ID]).toMatchObject({ by: 'system', mode: 'graceful', reason: '메인 자리 교체 멈춤 (세대 1 → 2) — 나가는 메인 턴의 종료를 확인하지 못함' });
    expect(seatRows(e)).toContain(`메인 자리 교체 멈춤 (세대 1 → 2): 나가는 메인 턴의 종료를 확인하지 못해 Codex CLI가 앉지 않았습니다 — 턴 ${turnId}(긴급 정지): 가짜 종료 확인 실패`);
    expect(notices(e, '메인 자리 교체가 멈췄습니다')).toMatchObject([{ key: 'seat-switch:2', link: { tab: 'seat' } }]);
    expect(notices(e, '메인 에이전트가 바뀌었습니다')).toEqual([]);
    // 긴급 정지의 해제가 그 확인 지점이다 — 한 번에 정지와 멈춘 교체를 함께 잇는다
    await releaseContinuesOnce(e);
  });

  it('메인 대화 턴(main:*)도 같다 — 이미 걸린 종료 확인 실패의 일시정지를 그대로 두고 멈춘다', async () => {
    const e = (env = await bootOrch());
    e.core.seat.applyOperatorConfig({ holders: null, drainMs: 60_000, initialHolder: null }, '시험');
    e.hold.add(KEY);
    await e.invoke('command.send', { target: 'main', text: '상태 알려줘' });
    e.tick();
    await waitFor(() => !!e.liveProc(KEY, MAIN_AGENT_ID), '메인 턴 시작');
    const p = e.liveProc(KEY, MAIN_AGENT_ID)!;
    p.terminateResult = { ...UNCONFIRMED };
    const swap = operatorSwap(e);
    await sleep(100);
    await e.invoke('stop.emergency');
    await swap.done;
    expect(e.ctx.store.turns.require(p.turnId).process.state).toBe('kill_failed');
    expect(held(e)).toEqual({ stage: 'unconfirmed', state: 'switching', holder: 'Claude CLI', pending: 'Codex CLI', mainPaused: true });
    // 메인 대화 턴의 종료 확인 실패는 blockUnconfirmedRun이 먼저 M-MAIN을 일시정지했다 — 교체는 그 정지를 덮어쓰지 않는다
    expect(e.ctx.stop().members[MAIN_AGENT_ID]!.reason).toMatch(/^프로세스 종료를 확인하지 못함/);
    expect(seatRows(e).some((t) => t.startsWith('메인 자리 교체 멈춤 (세대 1 → 2):') && t.endsWith(`턴 ${p.turnId}(긴급 정지): 가짜 종료 확인 실패`))).toBe(true);
    e.hold.clear();
    await releaseContinuesOnce(e);
  });

  it('교체를 청하기 전에 종료 확인 실패로 끝난 메인 검수 턴은 이 교체를 멈추지 않는다 — 기다린 메인 턴이 정상으로 끝나면 넘어간다', async () => {
    const e = (env = await bootOrch());
    e.core.seat.applyOperatorConfig({ holders: null, drainMs: 60_000, initialHolder: null }, '시험');
    // 앞서 끝난 검수 턴: 종료를 확인하지 못해 그 작업이 보류됐다
    const { proc, turnId } = await startReview(e, MAIN_AGENT_ID);
    proc.terminateResult = { ...UNCONFIRMED };
    await e.core.turns.stopMember(MAIN_AGENT_ID, '시험 정지', true);
    await waitFor(() => !e.core.turns.hasMemberFlow(MAIN_AGENT_ID), '검수 턴 끝');
    expect(e.ctx.store.turns.require(turnId).process.state).toBe('kill_failed');
    await sleep(20);
    // 그 보류는 메인 에이전트에게 알림 업무로 간다(alert kill-failed, 리드 결정 S5-7) — 그 메인 턴을 먼저 정상으로 마친다(교체를 청하기 전)
    expect(e.ctx.store.queue.list({ ref1: MAIN_AGENT_ID, state: 'queued' }).map((q) => q.kind)).toEqual(['alert']);
    await e.drain(1);
    // 교체가 기다리는 메인 턴은 정상으로 끝난다
    e.hold.add(KEY);
    await e.invoke('command.send', { target: 'main', text: '상태 알려줘' });
    e.tick();
    await waitFor(() => !!e.liveProc(KEY, MAIN_AGENT_ID), '메인 턴 시작');
    const swap = operatorSwap(e);
    await sleep(50);
    e.hold.clear();
    e.liveProc(KEY, MAIN_AGENT_ID)!.finishOk();
    await swap.done;
    expect(e.core.seat.view()).toMatchObject({ generation: 2, state: 'active', holder: { label: 'Codex CLI' } });
    expect(seatRows(e).some((t) => t.startsWith('메인 자리 교체 멈춤'))).toBe(false);
    expect(notices(e, '메인 자리 교체가 멈췄습니다')).toEqual([]);
  });

  it('앞서 끝난 M-MAIN 턴이 200개를 넘어도 최근 것부터 찾는다 — 나가는 메인 검수 턴의 종료 확인 실패로 멈춘다 (탐침 G2)', async () => {
    const e = (env = await bootOrch());
    e.core.seat.applyOperatorConfig({ holders: null, drainMs: 60_000, initialHolder: null }, '시험');
    await e.invoke('command.send', { target: 'main', text: '지금 상황은?' });
    await e.drain(1);
    const [done] = e.ctx.store.turns.list({ ref1: MAIN_AGENT_ID, state: 'ended' });
    expect(done).toBeDefined();
    // 오래 쓴 설치: 앞서 끝난 메인 턴이 많다 — 모두 종료를 확인했다
    for (let i = 0; i < 220; i++) e.ctx.store.turns.insert({ ...done!, id: `TN-OLD${String(i).padStart(4, '0')}` });
    const { proc, turnId } = await startReview(e, MAIN_AGENT_ID);
    proc.terminateResult = { ...UNCONFIRMED };
    const swap = operatorSwap(e);
    await sleep(100);
    await e.invoke('stop.emergency');
    await swap.done;
    expect(e.ctx.store.turns.require(turnId).process.state).toBe('kill_failed');
    expect(held(e)).toEqual({ stage: 'unconfirmed', state: 'switching', holder: 'Claude CLI', pending: 'Codex CLI', mainPaused: true });
    expect(seatRows(e)).toContain(`메인 자리 교체 멈춤 (세대 1 → 2): 나가는 메인 턴의 종료를 확인하지 못해 Codex CLI가 앉지 않았습니다 — 턴 ${turnId}(긴급 정지): 가짜 종료 확인 실패`);
  });

  it('다른 팀원의 검수 턴이 교체 중에 종료를 확인하지 못한 채 끝나도 이 교체는 멈추지 않는다 — 나가는 메인 턴은 종료를 확인했다 (탐침 G3)', async () => {
    const e = (env = await bootOrch());
    e.core.seat.applyOperatorConfig({ holders: null, drainMs: 60_000, initialHolder: null }, '시험');
    const qa = await startReview(e, e.qaId);
    qa.proc.terminateResult = { ...UNCONFIRMED };
    e.hold.add(KEY);
    await e.invoke('command.send', { target: 'main', text: '상태 알려줘' });
    e.tick();
    await waitFor(() => !!e.liveProc(KEY, MAIN_AGENT_ID), '메인 턴 시작');
    const swap = operatorSwap(e);
    await sleep(100);
    expect(e.core.seat.view().state).toBe('switching');
    await e.invoke('stop.emergency');
    await swap.done;
    expect(e.ctx.store.turns.require(qa.turnId).process.state).toBe('kill_failed');
    expect(e.core.seat.view()).toMatchObject({ generation: 2, state: 'active', holder: { label: 'Codex CLI' } });
    expect(seatRows(e).some((t) => t.startsWith('메인 자리 교체 멈춤'))).toBe(false);
    expect(notices(e, '메인 자리 교체가 멈췄습니다')).toEqual([]);
  });

  it('교체가 스스로 멈춘 정지가 ok를 돌려줘도 턴 마무리가 남은 하위 프로세스를 셌으면 앉히지 않고 멈춘다 — 정지 해제 한 번이 잇는다 (S4F3 6절, 탐침 G4)', async () => {
    const e = (env = await bootOrch());
    e.core.seat.applyOperatorConfig({ holders: null, drainMs: 200, initialHolder: null }, '시험');
    e.ctx.deps.timing!.memoTurnMs = 1_000;
    e.hold.add(KEY);
    await e.invoke('command.send', { target: 'main', text: '상태 알려줘' });
    e.tick();
    await waitFor(() => !!e.liveProc(KEY, MAIN_AGENT_ID), '메인 턴 시작');
    const p = e.liveProc(KEY, MAIN_AGENT_ID)!;
    p.terminate = async () => {
      p.terminatedByApp = true;
      p.exit(null, { terminated: true, remaining: 1 });
      return { ok: true, remaining: 0, detail: '가짜 종료', durationMs: 1 };
    };
    await operatorSwap(e).done;
    expect(p.terminatedByApp).toBe(true);
    expect(e.ctx.store.turns.require(p.turnId).process.state).toBe('kill_failed');
    expect(held(e)).toEqual({ stage: 'unconfirmed', state: 'switching', holder: 'Claude CLI', pending: 'Codex CLI', mainPaused: true });
    expect(seatRows(e).filter((t) => t.startsWith('메인 자리 교체 멈춤'))).toEqual([
      `메인 자리 교체 멈춤 (세대 1 → 2): 나가는 메인 턴의 종료를 확인하지 못해 Codex CLI가 앉지 않았습니다 — 턴 ${p.turnId}(메인 자리 교체(세대 2) — 마무리 시간 0.2초를 넘김): 정리 후 남은 프로세스 1개`,
    ]);
    e.hold.clear();
    await releaseContinuesOnce(e);
  });

  it('재시작으로 이어 가는 교체: 앞 실행이 종료를 확인하지 못한 채 끝낸 나가는 메인 검수 턴이 있으면 앉히지 않고 멈춘다 — 정지 해제 한 번이 잇는다 (리드 결정 S4-32, 탐침 G7)', async () => {
    const e = (env = await bootOrch());
    // 교체를 청할 때 나가는 메인 검수 턴이 돌고 있었다
    const { proc, turnId } = await startReview(e, MAIN_AGENT_ID);
    const requestedAt = e.ctx.now();
    await sleep(5);
    // 앱이 끝날 때 그 턴을 끊었지만 종료를 확인하지 못했다 — 검수 턴의 종료 확인 실패는 작업 보류로만 막는다(M-MAIN은 일시정지되지 않는다)
    proc.terminateResult = { ...UNCONFIRMED };
    await e.core.turns.stopMember(MAIN_AGENT_ID, '앱 종료 흉내', true);
    await waitFor(() => !e.core.turns.hasMemberFlow(MAIN_AGENT_ID), '검수 턴 끝');
    expect(e.ctx.store.turns.require(turnId).process.state).toBe('kill_failed');
    expect(e.ctx.stop().members[MAIN_AGENT_ID]).toBeUndefined();
    seatLeftDraining(e, requestedAt);
    e.core.seat.resumeAfterRestart();
    await e.core.seat.settled();
    expect(held(e)).toEqual({ stage: 'unconfirmed', state: 'switching', holder: 'Claude CLI', pending: 'Codex CLI', mainPaused: true });
    // 화면에 '정지 해제'가 보이게 교체가 M-MAIN 일시정지를 건다 (S4-18)
    expect(e.ctx.stop().members[MAIN_AGENT_ID]).toMatchObject({ by: 'system', mode: 'graceful', reason: '메인 자리 교체 멈춤 (세대 1 → 2) — 나가는 메인 턴의 종료를 확인하지 못함' });
    expect(seatRows(e)).toContain(`메인 자리 교체 멈춤 (세대 1 → 2): 나가는 메인 턴의 종료를 확인하지 못해 Codex CLI가 앉지 않았습니다 — 턴 ${turnId}(앱 종료 흉내): 가짜 종료 확인 실패`);
    // 메모 턴(새 Claude CLI)도 새 보유자의 턴도 띄우지 않았다
    expect(e.ctx.store.turns.list({ ref1: MAIN_AGENT_ID })).toHaveLength(1);
    expect(notices(e, '메인 자리 교체가 멈췄습니다')).toMatchObject([{ key: 'seat-switch:2', readAt: null }]);
    expect(notices(e, '메인 에이전트가 바뀌었습니다')).toEqual([]);
    await releaseContinuesOnce(e);
  });

  it('재시작으로 이어 가는 교체: 재시작 복구가 끊은 나가는 메인 대화 턴의 종료를 확인하지 못하면(kill_failed) 앉히지 않고 멈춘다 — 정지 해제 한 번이 잇는다 (리드 결정 S4-32)', async () => {
    const e = (env = await bootOrch());
    seatLeftDraining(e, e.ctx.now());
    await sleep(5);
    const turnId = runningPrevMainTurn(e, { ok: false, remaining: -1, detail: '남은 후손을 확인하지 못함' });
    await e.core.recovery.run();
    expect(e.ctx.store.turns.require(turnId).process).toMatchObject({ state: 'kill_failed', killDetail: '남은 후손을 확인하지 못함' });
    e.core.seat.resumeAfterRestart();
    await e.core.seat.settled();
    expect(held(e)).toEqual({ stage: 'unconfirmed', state: 'switching', holder: 'Claude CLI', pending: 'Codex CLI', mainPaused: true });
    // 메인 대화 턴의 종료 확인 실패는 재시작 복구(blockUnconfirmedRun)가 먼저 M-MAIN을 일시정지했다 — 교체는 그 정지를 그대로 둔다
    expect(e.ctx.stop().members[MAIN_AGENT_ID]!.reason).toMatch(/^프로세스 종료를 확인하지 못함/);
    expect(seatRows(e).filter((t) => t.startsWith('메인 자리 교체 멈춤'))).toEqual([
      `메인 자리 교체 멈춤 (세대 1 → 2): 나가는 메인 턴의 종료를 확인하지 못해 Codex CLI가 앉지 않았습니다 — 턴 ${turnId}(앱 재시작으로 끊김 — 종료 확인 실패: 남은 후손을 확인하지 못함): 남은 후손을 확인하지 못함`,
    ]);
    expect(e.ctx.store.turns.list({ ref1: MAIN_AGENT_ID })).toHaveLength(1);
    Object.assign(e.ctx.deps.runner as ProcessRunner, { isAlive: async () => false });
    await releaseContinuesOnce(e);
  });

  it('재시작으로 이어 가는 교체: 재시작 복구가 끊은 나가는 메인 대화 턴의 종료를 확인했으면(exited) 그 기록을 따라 멈추지 않고 앉힌다 (리드 결정 S4-32)', async () => {
    const e = (env = await bootOrch());
    seatLeftDraining(e, e.ctx.now());
    await sleep(5);
    const turnId = runningPrevMainTurn(e, { ok: true, remaining: 0, detail: '' });
    await e.core.recovery.run();
    expect(e.ctx.store.turns.require(turnId).process.state).toBe('exited');
    expect(e.ctx.stop().members[MAIN_AGENT_ID]).toBeUndefined();
    e.core.seat.resumeAfterRestart();
    await e.core.seat.settled();
    expect(e.core.seat.view()).toMatchObject({ generation: 2, state: 'active', holder: { label: 'Codex CLI' } });
    expect(seatRows(e).some((t) => t.startsWith('메인 자리 교체 멈춤'))).toBe(false);
    expect(seatRows(e).filter((t) => t.startsWith('메인 자리 교체 끝'))).toHaveLength(1);
    expect(notices(e, '메인 자리 교체가 멈췄습니다')).toEqual([]);
  });

  it('재시작으로 이어 가는 교체: 정지 해제로 이미 이어 가던 교체가 4번 전에 끊겼으면 다시 멈추지 않고 마친다 — 대표에게 정지 해제를 또 청하지 않는다 (리드 결정 S4-38, 탐침 R1)', async () => {
    const e = (env = await bootOrch());
    e.core.seat.applyOperatorConfig({ holders: null, drainMs: 60_000, initialHolder: null }, '시험');
    const { proc } = await startReview(e, MAIN_AGENT_ID);
    proc.terminateResult = { ...UNCONFIRMED };
    const swap = operatorSwap(e);
    await sleep(100);
    await e.invoke('stop.emergency');
    await swap.done;
    expect(held(e)).toMatchObject({ stage: 'unconfirmed', mainPaused: true });
    // 정지 해제가 finishing·memoSkip을 저장한 바로 뒤, 4번 전에 앱이 끝난 흉내 — finish가 코어 종료 중으로 보고 그냥 돌아간다
    const seat = e.core.seat as unknown as { finish: (s: unknown) => void };
    const orig = seat.finish;
    seat.finish = function (this: unknown, s: unknown) {
      (e.core as { stopping: boolean }).stopping = true;
      return orig.call(this, s);
    };
    await e.invoke('stop.release');
    await e.core.seat.settled();
    seat.finish = orig;
    (e.core as { stopping: boolean }).stopping = false;
    expect(e.ctx.store.seat.get('main')!.swap).toMatchObject({ stage: 'finishing', memoSkip: expect.stringContaining('정지 해제') });
    expect(e.ctx.stop().members[MAIN_AGENT_ID]).toBeUndefined();
    const stalledRows = seatRows(e).filter((t) => t.startsWith('메인 자리 교체 멈춤')).length;
    // 다음 시작(재시작 복구 뒤)이 교체를 이어 간다 — 앞의 종료 확인 실패 턴은 대표가 이미 확인하고 푼 것이다
    e.core.seat.resumeAfterRestart();
    await e.core.seat.settled();
    expect(held(e)).toEqual({ stage: null, state: 'active', holder: 'Codex CLI', pending: null, mainPaused: false });
    expect(seatRows(e).filter((t) => t.startsWith('메인 자리 교체 멈춤'))).toHaveLength(stalledRows);
    expect(seatRows(e).filter((t) => t.startsWith('메인 자리 교체 끝'))).toHaveLength(1);
    expect(notices(e, '메인 자리 교체가 멈췄습니다').filter((n) => !n.readAt)).toEqual([]);
  });

  it('흐름 없이 바로 끝나는 새 교체: 교체를 청하기 전에 종료 확인 실패로 끝난 M-MAIN 턴은 멈추지 않는다 (리드 결정 S4-32, 탐침 R2)', async () => {
    const e = (env = await bootOrch());
    const { proc, turnId } = await startReview(e, MAIN_AGENT_ID);
    proc.terminateResult = { ...UNCONFIRMED };
    await e.core.turns.stopMember(MAIN_AGENT_ID, '시험 정지', true);
    await waitFor(() => !e.core.turns.hasMemberFlow(MAIN_AGENT_ID), '검수 턴 끝');
    expect(e.ctx.store.turns.require(turnId).process.state).toBe('kill_failed');
    await sleep(5);
    await operatorSwap(e).done;
    expect(e.core.seat.view()).toMatchObject({ generation: 2, state: 'active', holder: { label: 'Codex CLI' } });
    expect(seatRows(e).some((t) => t.startsWith('메인 자리 교체 멈춤'))).toBe(false);
  });

  it('나가는 메인 턴의 서버 명령(host_exec)을 교체의 정지가 끝냈는데 종료를 확인하지 못하면 앉히지 않고 멈춘다 — 정지 해제 한 번이 잇는다 (리드 결정 S5-18)', async () => {
    const e = (env = await bootOrch({ workspace: true }));
    e.core.seat.applyOperatorConfig({ holders: null, drainMs: 200, initialHolder: null }, '시험');
    e.ctx.deps.timing!.memoTurnMs = 1_000;
    scriptedHost(e, { exitAfterMs: null, onStart: (p) => (p.terminateResult = { ...UNCONFIRMED }) });
    const { turnId } = await liveMainTurn(e);
    const pending = hostExec(e, turnId, { command: 'npm run dev' });
    await waitFor(() => e.core.hostExec.count() === 1, '서버 명령 시작');
    const execId = e.ctx.store.execs.list({ ref2: 'host_exec' })[0]!.requestId;
    await operatorSwap(e).done;
    expect(await pending).toMatchObject({ ok: true, data: { stopped: '메인 자리 교체', leftover: -1 } });
    expect(e.ctx.store.turns.require(turnId).process).toMatchObject({ state: 'kill_failed', killDetail: `서버 명령 ${execId}: 가짜 종료 확인 실패` });
    expect(held(e)).toEqual({ stage: 'unconfirmed', state: 'switching', holder: 'Claude CLI', pending: 'Codex CLI', mainPaused: true });
    expect(seatRows(e).filter((t) => t.startsWith('메인 자리 교체 멈춤'))).toEqual([
      `메인 자리 교체 멈춤 (세대 1 → 2): 나가는 메인 턴의 종료를 확인하지 못해 Codex CLI가 앉지 않았습니다 — 턴 ${turnId}(메인 자리 교체(세대 2) — 마무리 시간 0.2초를 넘김): 서버 명령 ${execId}: 가짜 종료 확인 실패`,
    ]);
    e.hold.clear();
    await releaseContinuesOnce(e);
  });

  it('나가는 메인 턴의 서버 명령이 스스로 끝나며 남긴 하위 프로세스도 그 턴의 종료 확인 실패다 — 턴이 정상으로 끝나도 앉히지 않고 멈춘다 (리드 결정 S5-18·S4-26)', async () => {
    const e = (env = await bootOrch({ workspace: true }));
    e.core.seat.applyOperatorConfig({ holders: null, drainMs: 60_000, initialHolder: null }, '시험');
    scriptedHost(e, { code: 0, remaining: 1 });
    const { proc, turnId } = await liveMainTurn(e);
    expect(await hostExec(e, turnId, { command: 'start-server.cmd' })).toMatchObject({ ok: true, data: { leftover: 1 } });
    const swap = operatorSwap(e);
    await sleep(50);
    e.hold.clear();
    proc.finishOk();
    await swap.done;
    expect(e.ctx.store.turns.require(turnId).process.state).toBe('kill_failed');
    expect(held(e)).toEqual({ stage: 'unconfirmed', state: 'switching', holder: 'Claude CLI', pending: 'Codex CLI', mainPaused: true });
    await releaseContinuesOnce(e);
  });
});
