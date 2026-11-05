/**
 * 인계 메모 턴(4.3 3번)이 종료를 확인하지 못한 채 끝나면 새 보유자를 앉히지 않는다 (리드 결정 S4-31, S4-26, CTL-11):
 * - 메모 턴은 나가는 보유자의 main:* 턴이고 교체를 청한 뒤에 끝난다 — 2번 마무리 뒤와 같은 표시(턴 기록의 kill_failed)로 본다. 교체가 메모 턴을 스스로
 *   멈추지 않은 경우(대표의 긴급 정지가 끝냄, 스스로 끝났는데 하위 프로세스가 남음)와, 교체의 메모 시간 초과 정지가 ok를 돌려줬지만 턴 마무리가 남은 하위
 *   프로세스를 센 경우 모두
 * - 멈춤은 holdUnconfirmed 그대로다: 단계 unconfirmed, M-MAIN의 CTL-11 일시정지(메인 대화 턴이라 turns.blockUnconfirmedRun이 먼저 건 것을 그대로 둔다),
 *   '메인 에이전트가 바뀌었습니다'는 없다. 정지 해제 한 번이 교체를 한 번만 잇고, 그때 멈췄다는 알림은 읽음이 된다 (S4-36)
 * 탐침 zz-sa3-new N1·N1b(server-s4fix2-seat-authority), zz-s4f2fl-memo-unconfirmed A·B(server-s4fix2-flows-lifecycle)에서 왔다
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID, type AiConfig } from '@shared/domain';
import { bootOrch, notices, waitFor, type OrchEnv } from './orchHarness';

let env: OrchEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const CODEX: AiConfig = { kind: 'codex', model: null, effortTier: 'high', effortOverride: null };
const KEY = 'main:general';
const operatorSwap = (e: OrchEnv) => e.core.seat.assign({ holder: { kind: 'launched', ai: CODEX }, by: 'operator', reason: '운영자 교체' });
const seatRows = (e: OrchEnv) => e.ctx.store.activity.search({ kinds: ['seat'], limit: 50 }).map((r) => r.text);

/** 메인 턴 하나를 끝내 둔다 (나가는 보유자의 열린 대화 세션) */
async function priorTurn(e: OrchEnv): Promise<void> {
  await e.invoke('command.send', { target: 'main', text: '지금 상황은?' });
  await e.drain(1);
}

/** 멈춘 교체 — 새 보유자는 앉지 않았고 M-MAIN이 일시정지돼 화면에 '정지 해제'가 있다 */
function held(e: OrchEnv) {
  const v = e.core.seat.view();
  return {
    generation: v.generation,
    stage: e.ctx.store.seat.get('main')!.swap?.stage ?? null,
    state: v.state,
    holder: v.holder?.label,
    pending: v.pendingHolder?.label ?? null,
    mainPaused: !!e.ctx.stop().members[MAIN_AGENT_ID]?.paused,
  };
}

const HELD = { generation: 2, stage: 'unconfirmed', state: 'switching', holder: 'Claude CLI', pending: 'Codex CLI', mainPaused: true };

/** 멈춘 교체의 기록·알림 — 메모 턴의 글로 멈췄고, 바뀌었다는 알림은 없다 */
function expectHeldOnMemo(e: OrchEnv, memoTurn: string, detail: string): void {
  expect(e.ctx.store.turns.require(memoTurn).process.state).toBe('kill_failed');
  expect(held(e)).toEqual(HELD);
  // 메모 턴은 메인 대화 턴이다 — blockUnconfirmedRun이 먼저 건 M-MAIN 일시정지를 교체가 덮어쓰지 않는다
  expect(e.ctx.stop().members[MAIN_AGENT_ID]!.reason).toMatch(/^프로세스 종료를 확인하지 못함/);
  expect(seatRows(e).filter((t) => t.startsWith('메인 자리 교체 멈춤'))).toEqual([
    `메인 자리 교체 멈춤 (세대 1 → 2): 나가는 메인 턴의 종료를 확인하지 못해 Codex CLI가 앉지 않았습니다 — 턴 ${memoTurn}${detail}`,
  ]);
  expect(seatRows(e).filter((t) => t.startsWith('메인 자리 교체 끝'))).toEqual([]);
  expect(notices(e, '메인 자리 교체가 멈췄습니다')).toMatchObject([{ key: 'seat-switch:2', link: { tab: 'seat' }, readAt: null }]);
  expect(notices(e, '메인 에이전트가 바뀌었습니다')).toEqual([]);
}

/** 정지 해제 한 번이 교체를 한 번만 잇는다 — 메모 턴은 다시 주지 않고, 멈췄다는 알림은 읽음이 되며 바뀌었다는 알림은 읽지 않은 채 하나 (S4-36) */
async function releaseContinuesOnce(e: OrchEnv): Promise<void> {
  const mainTurns = e.ctx.store.turns.list({ ref1: MAIN_AGENT_ID }).length;
  await e.invoke('stop.release');
  await e.core.seat.settled();
  expect(e.core.seat.view()).toMatchObject({ generation: 2, state: 'active', holder: { label: 'Codex CLI' } });
  expect(e.ctx.stop().global.active).toBe(false);
  expect(e.ctx.stop().members[MAIN_AGENT_ID]).toBeUndefined();
  expect(e.core.seat.history().map((h) => `${h.generation}:${h.holder.label}`)).toEqual(['2:Codex CLI', '1:Claude CLI']);
  expect(seatRows(e).filter((t) => t.startsWith('메인 자리 교체 끝'))).toHaveLength(1);
  expect(e.ctx.store.turns.list({ ref1: MAIN_AGENT_ID })).toHaveLength(mainTurns);
  expect(notices(e, '메인 자리 교체가 멈췄습니다').filter((n) => !n.readAt)).toEqual([]);
  expect(notices(e, '메인 에이전트가 바뀌었습니다')).toMatchObject([{ key: 'seat-change:2', readAt: null }]);
  // 다시 눌러도 더 잇지 않는다
  await e.invoke('stop.release');
  await e.core.seat.settled();
  expect(e.core.seat.view().generation).toBe(2);
  expect(seatRows(e).filter((t) => t.startsWith('메인 자리 교체 끝'))).toHaveLength(1);
}

describe('종료를 확인하지 못한 인계 메모 턴 (seatMemoUnconfirmedEnd)', () => {
  it('대표의 긴급 정지가 메모 턴을 끝냈는데 종료를 확인하지 못하면 새 보유자를 앉히지 않고 멈춘다 — 정지 해제 한 번이 긴급 정지와 함께 잇는다 (탐침 N1·A)', async () => {
    const e = (env = await bootOrch());
    e.ctx.deps.timing!.memoTurnMs = 30_000;
    await priorTurn(e);
    e.hold.add(KEY);
    const swap = operatorSwap(e);
    await waitFor(() => !!e.liveProc(KEY, MAIN_AGENT_ID), '메모 턴 시작');
    const p = e.liveProc(KEY, MAIN_AGENT_ID)!;
    expect(e.core.seat.isMemoTurn(p.turnId)).toBe(true);
    p.terminateResult = { ok: false, remaining: -1, detail: '가짜 종료 확인 실패', durationMs: 1 };
    // 교체가 아니라 대표의 긴급 정지가 메모 턴을 끝낸다
    await e.invoke('stop.emergency');
    await swap.done;
    expectHeldOnMemo(e, p.turnId, '(긴급 정지): 가짜 종료 확인 실패');
    expect(e.ctx.stop().global.active).toBe(true);
    e.hold.clear();
    await releaseContinuesOnce(e);
  });

  it('메모 턴이 스스로 끝났지만 하위 프로세스가 남았으면(kill_failed) 앉히지 않고 멈춘다 — 정지 해제 한 번이 잇는다 (탐침 N1b)', async () => {
    const e = (env = await bootOrch());
    e.ctx.deps.timing!.memoTurnMs = 30_000;
    await priorTurn(e);
    e.script.set(KEY, (p) => {
      p.emit({ kind: 'result', text: '메모 끝', data: {} });
      p.exit(0, { remaining: 2 });
    });
    await operatorSwap(e).done;
    e.script.clear();
    const memo = e.ctx.store.turns.list({ ref1: MAIN_AGENT_ID }).at(-1)!;
    expect(e.ctx.store.seat.get('main')!.swap?.memoTurnId).toBe(memo.id);
    // 스스로 끝난 턴은 끝 글이 없어 끝 까닭의 한국어 이름을 쓴다
    expectHeldOnMemo(e, memo.id, '(정상 종료): 정리 후 남은 프로세스 2개');
    expect(e.ctx.stop().global.active).toBe(false);
    await releaseContinuesOnce(e);
  });

  it('교체의 메모 시간 초과 정지가 ok를 돌려줘도 턴 마무리가 남은 하위 프로세스를 셌으면 앉히지 않고 멈춘다 — 정지 해제 한 번이 잇는다 (탐침 B)', async () => {
    const e = (env = await bootOrch());
    e.ctx.deps.timing!.memoTurnMs = 1_000;
    await priorTurn(e);
    e.hold.add(KEY);
    const swap = operatorSwap(e);
    await waitFor(() => !!e.liveProc(KEY, MAIN_AGENT_ID), '메모 턴 시작');
    const p = e.liveProc(KEY, MAIN_AGENT_ID)!;
    p.terminate = async () => {
      p.terminatedByApp = true;
      p.exit(null, { terminated: true, remaining: 2 });
      return { ok: true, remaining: 0, detail: '가짜 종료', durationMs: 1 };
    };
    await swap.done;
    expect(p.terminatedByApp).toBe(true);
    expectHeldOnMemo(e, p.turnId, '(메인 자리 교체(세대 2) — 인계 메모 시간(1초)을 넘김): 정리 후 남은 프로세스 2개');
    e.hold.clear();
    await releaseContinuesOnce(e);
  });
});
