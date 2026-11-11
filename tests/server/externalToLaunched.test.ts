/**
 * externalToLaunched (SERVER_DESIGN 4.4·10.7, 리드 결정 S4-5·S7-4·S7-7 — 초안의 '대표가 Claude로 교체'를 대신한다): 외부 보유자(모의 외부 에이전트 silent)가
 * 응답하지 않아도 서버는 자리를 바꾸지 않고 응답 없음만 알린다. 운영자가 `seat assign launched:claude`로 배정하면(강제 아님) 나가는 외부 보유자에게는 인계 메모 턴을
 * 주지 않고('외부 보유자가 연결돼 있지 않음') Claude(모의 메인)가 쌓여 있던 명령을 이어받는다
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID } from '@shared/domain';
import type { SeatView } from '@shared/views';
import { bootExternal, situation, sleep, until, type ExternalEnv } from './externalRig';

let x: ExternalEnv;

beforeAll(async () => {
  x = await bootExternal({ timing: { agentLeaseMs: 1500 } });
}, 120_000);

afterAll(async () => {
  await x?.close();
});

describe('externalToLaunched — 서버는 바꾸지 않고, 운영자 배정이 Claude에게 쌓인 일을 넘긴다 (S4-5·S7-4)', () => {
  it('silent 외부 보유자 → 응답 없음(자리 그대로) → seat assign launched:claude → Claude가 쌓인 명령을 처리한다', async () => {
    const ctx = x.h.core.ctx;
    const { key } = x.operator.addExternalAgent('그록봇');
    await x.operator.assignSeat('external:X-0001', true);
    const mock = x.spawnMock(key, ['--scenario', 'silent']);
    await until(() => x.mockLog(mock.log).some((e) => e.ev === 'silent'), 'claim 뒤 조용해짐');
    await x.owner$('command.send', { target: 'main', text: '쌓아 둘 명령' });
    await until(() => !!ctx.store.seat.get('main')!.unresponsiveSince, '응답 없음', 30_000, () => situation(x, mock.log));
    // 서버는 자리를 바꾸지 않는다 — 몇 차례 스케줄러가 돌아도 그대로
    await sleep(3_000);
    const seat = await x.owner$<SeatView>('seat.get');
    expect(seat).toMatchObject({ generation: 2, state: 'active', holder: { kind: 'external', agentId: 'X-0001' }, unresponsiveReason: '외부 에이전트 임대 만료 — 1.5초 동안 heartbeat 없음' });
    expect(ctx.store.queue.list({ ref1: MAIN_AGENT_ID, state: 'queued' }).map((q) => q.kind)).toEqual(['main_command']);
    expect(ctx.store.turns.list({ ref1: MAIN_AGENT_ID })).toEqual([]);

    // 운영자 배정 (강제 아님) — 외부 보유자에게 살아 있는 임대가 없어 메모 턴 없이 곧바로 넘어간다
    const t0 = Date.now();
    const r = await x.operator.assignSeat('launched:claude', false);
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(r).toMatchObject({ outcome: 'swap', generation: 3, holder: 'Claude CLI', state: 'active' });
    expect(ctx.store.activity.search({ kinds: ['seat'], limit: 50 }).some((a) => a.text === '메인 자리 교체 (세대 2 → 3): 인계 메모 턴을 주지 않음 — 외부 보유자가 연결돼 있지 않음')).toBe(true);
    expect(ctx.store.seatHistory.get('G-0002')!.endReason).toContain('응답하지 않음');

    // Claude(모의 메인)가 쌓여 있던 명령을 처리한다
    await until(() => ctx.store.queue.list({ ref1: MAIN_AGENT_ID }).some((q) => q.kind === 'main_command' && q.state === 'done'), 'Claude가 쌓인 명령을 처리', 60_000, () => situation(x, mock.log));
    await until(() => x.h.core.turns.count() === 0, '턴 정리');
    const turns = ctx.store.turns.list({ ref1: MAIN_AGENT_ID });
    expect(turns.map((t) => [t.runner, t.aiKind, t.mock, t.seatGeneration, t.endReason])).toEqual([['cli', 'claude', true, 3, 'completed']]);
    expect(ctx.store.conversation.list({ ref1: 'main' }).some((m) => m.role === 'main_agent')).toBe(true);
    // 옛 보유자의 임대는 교체 4번에서 거뒀다 — 다시 claim은 403(지금 보유자 Claude CLI)
    const seatNow = await x.owner$<SeatView>('seat.get');
    expect([seatNow.unresponsiveSince, seatNow.holder?.kind]).toEqual([null, 'launched']);
  }, 120_000);
});
