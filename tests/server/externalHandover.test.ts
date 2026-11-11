/**
 * externalHandover (SERVER_DESIGN 4.3·4.5·10.7, 리드 결정 S7-2·S7-4·S7-20 TI-5 — 검토 tests-integrity 5): 외부 보유자가 받는 인계와 일의 정확한 칸.
 * - seat/claim의 handover는 그 세대의 인계 꾸러미다 (자리를 그 에이전트에게 옮긴 뒤 — 마지막 줄 '새 보유자: <이름> (세대 n)')
 * - WorkItem.instructions는 서버가 띄우는 CLI의 메인 대화(main_general) 시스템 프롬프트 — claim이 준 rules와 같은 글이다
 * - 새로 앉은 외부 에이전트는 앞 외부 에이전트의 세션을 잇지 않고 제 세션을 열며, 그 첫 턴의 글에 인계 꾸러미가 실린다
 * - 일을 받으러 와 있는(롱폴) 외부 보유자에게서 자리를 옮기면(강제 아님) 그 에이전트가 인계 메모 턴을 받고, 그 턴을 마치면 교체가 끝난다
 * 시험 자신이 에이전트다(HTTP, 실제 루프백 리스너). 메인 턴은 모두 모의 실행이거나 외부 턴이다 (externalRig close())
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID } from '@shared/domain';
import type { SeatHandoverView } from '@shared/views';
import { MEMO_MARK } from '../../src/main/orchestrator/handover';
import { agentCall, bootExternal, claimAs, nextWork, situation, until, type ExternalEnv } from './externalRig';

let x: ExternalEnv;
let keyA = '';
let keyB = '';

beforeAll(async () => {
  x = await bootExternal({ timing: { memoTurnMs: 20_000 } });
  keyA = x.operator.addExternalAgent('그록봇').key;
  keyB = x.operator.addExternalAgent('남는봇').key;
}, 120_000);

afterAll(async () => {
  await x?.close();
});

const ctx = () => x.h.core.ctx;
const finish = (key: string, leaseId: string, turnId: string, finalText: string) => agentCall(x.api, key, `/work/${turnId}/finish`, { body: { leaseId, finalText, outcome: 'completed' } });
const settled = () => until(() => x.h.core.turns.count() === 0, '턴 정리', 20_000, () => situation(x));

describe('externalHandover — 외부 보유자의 인계 꾸러미·규칙·세션·메모 턴 (S7-2·S7-4)', () => {
  it('seat/claim의 handover는 그 세대의 인계 꾸러미이고, 첫 메인 일의 instructions는 claim의 rules와 같은 글이다', async () => {
    await x.operator.assignSeat('external:X-0001', true);
    const r = await agentCall(x.api, keyA, '/seat/claim', { body: {} });
    expect(r.status).toBe(200);
    const c = r.json<{ leaseId: string; generation: number; rules: string; handover: SeatHandoverView | null }>();
    expect(c.generation).toBe(2);
    // 꾸러미 — 그 세대(2)의 것, 받은 보유자는 이 에이전트, 마지막 줄은 새 보유자
    expect(c.handover).not.toBeNull();
    expect({ generation: c.handover!.generation, holder: c.handover!.holder, chars: c.handover!.chars }).toEqual({
      generation: 2,
      holder: x.h.core.seat.handover(2)!.holder,
      chars: x.h.core.seat.handover(2)!.chars,
    });
    expect(c.handover!.sections[0]!.lines.at(-1)).toBe('새 보유자: 그록봇 (세대 2)');
    // rules는 서버가 띄우는 CLI의 메인 대화 시스템 프롬프트 — 긴 글이다
    expect(c.rules).toBe(x.h.core.turns.mainRules().rules);
    expect(c.rules.length).toBeGreaterThan(500);

    await x.owner$('command.send', { target: 'main', text: '규칙을 따라 정리해 줘' });
    const w = await nextWork(x.api, keyA, c.leaseId);
    expect(w.kind).toBe('main_general');
    expect(w.instructions).toBe(c.rules);
    // 첫 턴의 글에도 꾸러미가 실린다
    expect(w.message).toContain('새 보유자: 그록봇 (세대 2)');
    expect((await finish(keyA, c.leaseId, w.turnId, '정리함')).status).toBe(200);
    await settled();
  }, 60_000);

  it('새로 앉은 외부 에이전트는 앞 외부 에이전트의 세션을 잇지 않고 제 세션을 열며, 그 첫 턴에 인계 꾸러미가 실린다', async () => {
    const aSession = ctx().store.turns.list({ ref1: MAIN_AGENT_ID }).filter((t) => t.externalAgentId === 'X-0001').at(-1)!.sessionId;
    await x.operator.assignSeat('external:X-0002', true);
    const lease = await claimAs(x.api, keyB);
    expect(lease.generation).toBe(3);
    await x.owner$('command.send', { target: 'main', text: '새 보유자의 첫 일' });
    const w = await nextWork(x.api, keyB, lease.leaseId);
    const t = ctx().store.turns.get(w.turnId)!;
    expect([t.externalAgentId, t.sessionId === aSession, t.isResume]).toEqual(['X-0002', false, false]);
    expect(w.message).toContain('새 보유자: 남는봇 (세대 3)');
    expect((await finish(keyB, lease.leaseId, w.turnId, '첫 일 마침')).status).toBe(200);
    await settled();
  }, 60_000);

  it('일을 받으러 와 있는 외부 보유자에게서 자리를 옮기면(강제 아님) 그 롱폴이 인계 메모 턴을 받고, 그 턴을 마치면 교체가 끝난다', async () => {
    const lease = await claimAs(x.api, keyB);
    const poll = agentCall(x.api, keyB, '/work/next', { body: { leaseId: lease.leaseId, waitMs: 15_000 } });
    await until(() => x.h.core.externalAgents.pollOpen('X-0002', 3), '롱폴이 열림', 10_000);
    const swap = x.h.core.seat.operatorAssign('launched:claude', false);
    const got = await poll;
    expect(got.status).toBe(200);
    const memo = got.json<{ turnId: string; generation: number; message: string }>();
    expect(memo.generation).toBe(3);
    expect(memo.message).toContain(`${MEMO_MARK} 메인 자리가 Claude CLI에게 넘어갑니다 (세대 3 → 4`);
    // 메모 턴을 마치기 전에는 교체가 끝나지 않는다
    expect(ctx().store.seat.get('main')!.state).toBe('switching');
    expect((await finish(keyB, lease.leaseId, memo.turnId, '인계 메모를 남김')).status).toBe(200);
    await swap.done;
    expect(ctx().store.seat.get('main')).toMatchObject({ generation: 4, state: 'active', holder: { kind: 'launched' } });
    expect(ctx().store.activity.search({ kinds: ['seat'], limit: 50 }).some((a) => a.text.startsWith('메인 자리 교체 (세대 3 → 4): 인계 메모 턴을 주지 않음'))).toBe(false);
    await settled();
  }, 60_000);
});
