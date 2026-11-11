/**
 * externalSwapSettle (SERVER_DESIGN 4.3·4.5, 리드 결정 S7-17 F1·S7-19 R2): 자리 교체의 마무리 시간(drainMs)이 다 됐을 때 나가는 외부 턴이 finish를 받고 마무리 중이면 —
 * F1의 교체 쪽(긴급 정지 대신 교체 2번의 멈춤).
 * - 교체의 멈춤은 그 턴을 멈추지 않는다('이미 마친 턴') — 그 턴의 마무리가 끝나기를 기다린 뒤에 교체를 이어 간다
 * - 그 턴은 completed(정지 요청 기록 없음), 답은 대화에 한 번, 명령은 다시 넣지 않는다 — 새 보유자(Claude, 모의 실행)는 같은 명령을 받지 않는다
 * 마무리는 턴 흐름의 hostExec.settleTurn을 문으로 붙잡아 열어 둔다(보유자와 상관없는 마무리 단계). 시험 자신이 에이전트다(HTTP, 실제 루프백 리스너).
 * 메인 턴은 모두 모의 실행이거나 외부 턴이다 (externalRig close())
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MAIN_AGENT_ID } from '@shared/domain';
import type { StopResult } from '../../src/main/orchestrator/turns';
import { agentCall, bootExternal, claimAs, nextWork, situation, sleep, until, type ExternalEnv } from './externalRig';

/** 교체 2번이 나가는 턴의 마무리를 기다리는 시간 (seat.drainMs, 시험값) */
const DRAIN_MS = 1000;
/** 인계 메모 턴의 상한 (timing.memoTurnMs, 시험값) */
const MEMO_MS = 300;
let x: ExternalEnv;
let key = '';
/** 시험이 붙잡은 문 — 단언이 먼저 실패해도 정리 전에 연다 */
const gates: (() => void)[] = [];

beforeAll(async () => {
  // 인계 메모 턴의 상한은 짧게 — 교체가 멈춘 턴의 마무리를 기다리지 않으면 이 상한 뒤에 곧바로 넘어가 버린다(아래에서 그보다 길게 본다)
  x = await bootExternal({ timing: { memoTurnMs: MEMO_MS } });
  key = x.operator.addExternalAgent('그록봇').key;
  await x.operator.assignSeat('external:X-0001', true);
  x.h.core.seat.applyOperatorConfig({ holders: null, drainMs: DRAIN_MS, initialHolder: null }, '시험');
}, 120_000);

afterAll(async () => {
  for (const open of gates.splice(0)) open();
  vi.restoreAllMocks();
  await x?.close();
});

const ctx = () => x.h.core.ctx;
const replies = (text: string) => ctx().store.conversation.list({ ref1: 'main' }).filter((m) => m.role === 'main_agent' && m.text === text).length;

describe('externalSwapSettle — 교체의 마무리 시간이 다 됐을 때 finish를 받고 마무리 중인 나가는 외부 턴 (S7-19 R2)', () => {
  it("교체의 멈춤은 그 턴을 멈추지 않고('이미 마친 턴') 마무리를 기다린다 — completed, 답 한 번, 다시 넣지 않음, 새 보유자는 같은 명령을 받지 않는다", async () => {
    const core = x.h.core;
    const lease = await claimAs(x.api, key);
    const text = '넘기기 전에 마칠 일';
    const answer = '넘기기 전에 마쳤습니다';
    await x.owner$('command.send', { target: 'main', text });
    const w = await nextWork(x.api, key, lease.leaseId);
    expect(w.message).toContain(text);

    // 그 턴의 마무리를 붙잡는다 — finish를 받은 뒤 턴 흐름이 settleTurn에서 기다린다
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    gates.push(() => open());
    let held = 0;
    const settle = core.hostExec.settleTurn.bind(core.hostExec);
    vi.spyOn(core.hostExec, 'settleTurn').mockImplementation(async (turnId, why) => {
      if (turnId === w.turnId) {
        held += 1;
        await gate;
      }
      return settle(turnId, why);
    });
    // 교체 2번의 멈춤이 돌려준 결과
    const stops: StopResult[] = [];
    const stopMember = core.turns.stopMember.bind(core.turns);
    vi.spyOn(core.turns, 'stopMember').mockImplementation(async (memberId, reason, user) => {
      const r = await stopMember(memberId, reason, user);
      stops.push(...r);
      return r;
    });

    // finish — 실행은 끝났고 마무리가 붙잡혀 있다 (턴은 아직 실행 중 목록에, 기록은 끝나지 않음)
    const fin = agentCall(x.api, key, `/work/${w.turnId}/finish`, { body: { leaseId: lease.leaseId, finalText: answer, outcome: 'completed' } });
    await until(() => held > 0, '마무리가 붙잡힘', 10_000, () => situation(x));
    expect(core.turns.liveTurnIds()).toContain(w.turnId);
    expect(ctx().store.turns.get(w.turnId)!.endedAt).toBeNull();

    // 교체 (외부 → Claude, 강제 아님): 2번이 마무리를 1초 기다리고 넘으면 멈춘다 — 그 턴은 이미 실행을 마쳤다
    const swap = core.seat.operatorAssign('launched:claude', false);
    await until(() => stops.some((s) => s.turnId === w.turnId), '마무리 시간을 넘겨 교체가 멈춤', 15_000, () => situation(x));
    expect(stops.filter((s) => s.turnId === w.turnId)).toEqual([expect.objectContaining({ ok: true, detail: '이미 마친 턴', alreadyEnded: true })]);
    // 교체는 그 턴의 마무리를 기다린다 — 메모 턴의 상한(0.3초)을 넉넉히 넘겨도 아직 넘어가지 않았다
    await sleep(MEMO_MS + 1_700);
    expect([ctx().store.seat.get('main')!.state, ctx().store.seat.get('main')!.generation, ctx().store.turns.get(w.turnId)!.endedAt]).toEqual(['switching', 3, null]);

    open();
    const f = await fin;
    expect([f.status, f.json<{ endReason: string }>().endReason]).toEqual([200, 'completed']);
    await swap.done;
    expect(ctx().store.seat.get('main')).toMatchObject({ generation: 3, state: 'active', holder: { kind: 'launched' } });

    // 그 턴은 정상 종료 — 정지 요청 기록 없음, 답은 한 번, 명령은 끝났고 다시 넣지 않았다
    const t = ctx().store.turns.get(w.turnId)!;
    expect([t.endReason, t.endDetail, t.process.stopRequestedAt]).toEqual(['completed', '', null]);
    expect(replies(answer)).toBe(1);
    const commands = ctx().store.queue.list({ ref1: MAIN_AGENT_ID }).filter((q) => q.kind === 'main_command');
    expect(commands.map((q) => [q.state, q.attempts])).toEqual([['done', 0]]);
    // 새 보유자(Claude)는 같은 명령을 받지 않는다 — 스케줄러가 몇 차례 돌아도 세대 3의 메인 턴이 없다
    await sleep(2_500);
    await until(() => core.turns.count() === 0, '턴 정리', 10_000, () => situation(x));
    expect(ctx().store.turns.list({ ref1: MAIN_AGENT_ID }).filter((x3) => x3.seatGeneration === 3)).toEqual([]);
    expect(ctx().store.queue.list({ ref1: MAIN_AGENT_ID, state: 'queued' }).filter((q) => q.kind === 'main_command')).toEqual([]);
    expect(replies(answer)).toBe(1);
  }, 90_000);
});
