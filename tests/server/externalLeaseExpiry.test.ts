/**
 * externalLeaseExpiry (SERVER_DESIGN 4.4·4.5·10.7, 리드 결정 S7-4·S7-7): 외부 보유자가 heartbeat를 멈추면(모의 외부 에이전트 silent — 일 하나를 받은 뒤 아무것도
 * 보내지 않는다) 임대(시험 1.5초)가 끝나는 때 그 턴은 비정상 종료로 끝나 다시 들어가고(attempts+1), 자리는 바뀌지 않고 응답 없음이 된다 — 까닭은 임대 만료.
 * 5분 다시 알림은 앞당긴 시계로 본다. 다시 claim하면 응답 없음이 풀리고 쌓인 일을 이어 받는다
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID } from '@shared/domain';
import type { SeatView } from '@shared/views';
import { EXTERNAL_STOP } from '../../src/main/orchestrator/externalAgents';
import { agentCall, bootExternal, claimAs, nextWork, offsetClock, situation, until, type ExternalEnv } from './externalRig';

const EXPIRED = '외부 에이전트 임대 만료 — 1.5초 동안 heartbeat 없음';
const clock = offsetClock();
let x: ExternalEnv;

beforeAll(async () => {
  x = await bootExternal({ timing: { agentLeaseMs: 1500 }, clock });
}, 120_000);

afterAll(async () => {
  await x?.close();
});

describe('externalLeaseExpiry — 임대 만료 → 다시 넣기·응답 없음, 서버는 자리를 바꾸지 않는다 (S7-4)', () => {
  it('silent 보유자의 턴은 임대 만료로 비정상 종료·다시 넣기(attempts+1), 자리는 응답 없음 — 5분에 다시 알리고, 다시 claim하면 풀린다', async () => {
    const ctx = x.h.core.ctx;
    const { key } = x.operator.addExternalAgent('그록봇');
    await x.operator.assignSeat('external:X-0001', true);
    await x.owner$('command.send', { target: 'main', text: '보고서를 정리해 줘' });
    const mock = x.spawnMock(key, ['--scenario', 'silent', '--wait-ms', '8000']);
    await until(() => x.mockLog(mock.log).some((e) => e.ev === 'silent' && e.status === 200), 'silent 보유자가 턴을 받음', 30_000, () => situation(x, mock.log));
    const taken = String(x.mockLog(mock.log).find((e) => e.ev === 'silent')!.turnId);

    // 임대가 끝나면 그 턴은 비정상 종료로 끝난다 — 끝남은 확인할 수 없다고 적고(exited), 일은 attempts+1로 다시 들어간다.
    // 만료를 본 sweep이 자리를 응답 없음으로 둔다 — 그것을 기다린 뒤, 같은 sweep이 끝낸 턴은 짧게만 기다린다 (리드 결정 S7-20 TI-6)
    await until(() => !!ctx.store.seat.get('main')!.unresponsiveSince, '임대 만료로 자리가 응답 없음', 30_000, () => situation(x, mock.log));
    await until(() => !!ctx.store.turns.get(taken)?.endedAt, '임대 만료로 턴이 끝남', 5_000, () => situation(x, mock.log));
    await until(() => x.h.core.turns.count() === 0, '턴 정리', 10_000, () => situation(x, mock.log));
    const t = ctx.store.turns.get(taken)!;
    expect({ end: t.endReason, detail: t.endDetail, state: t.process.state, kill: t.process.killDetail }).toEqual({ end: 'crashed', detail: EXPIRED, state: 'exited', kill: EXTERNAL_STOP });
    const commands = ctx.store.queue.list({ ref1: MAIN_AGENT_ID }).filter((q) => q.kind === 'main_command');
    expect(commands.map((q) => [q.state, q.attempts])).toEqual([
      ['done', 0],
      ['queued', 1],
    ]);
    expect(commands[1]!.message).toContain('(다시 전달) ');

    // 자리는 그대로 — 응답 없음, 까닭은 임대 만료. 서버는 자리를 바꾸지 않는다
    let seat = await x.owner$<SeatView>('seat.get');
    expect(seat).toMatchObject({ generation: 2, state: 'active', holder: { kind: 'external', agentId: 'X-0001' }, unresponsiveReason: EXPIRED });
    expect(seat.unresponsiveSince).not.toBeNull();
    expect(ctx.store.activity.search({ kinds: ['seat'], limit: 50 }).some((a) => a.text === `메인 에이전트 응답 없음: 그록봇 (세대 2) — ${EXPIRED}. 서버는 메인 자리를 바꾸지 않습니다`)).toBe(true);
    expect((await x.owner$<{ connected: boolean }[]>('agents.list'))[0]!.connected).toBe(false);

    // 5분 뒤 (앞당긴 시계) 대표에게 다시 알린다 — 같은 key
    clock.advance(5 * 60_000 + 1_000);
    await until(() => ctx.store.notifications.list({ ref1: 'seat-unresponsive:2' }).length > 0, '5분 다시 알림', 30_000);
    const notice = ctx.store.notifications.list({ ref1: 'seat-unresponsive:2' })[0]!;
    expect(notice.title).toBe('메인 에이전트 응답 없음');
    expect(notice.body.startsWith(`메인 에이전트 그록봇(세대 2)이 5분째 응답하지 않습니다 — ${EXPIRED}. 서버는 메인 자리를 다른 AI에게 넘기지 않습니다`)).toBe(true);
    seat = await x.owner$<SeatView>('seat.get');
    expect(seat).toMatchObject({ generation: 2, holder: { agentId: 'X-0001' } });

    // 다시 claim하면 응답 없음이 풀리고(다시 응답함), 쌓인 일이 온다
    mock.child.kill();
    const lease = await claimAs(x.api, key);
    seat = await x.owner$<SeatView>('seat.get');
    expect([seat.unresponsiveSince, seat.unresponsiveReason]).toEqual([null, null]);
    expect(ctx.store.activity.search({ kinds: ['seat'], limit: 50 }).some((a) => a.text.startsWith('메인 에이전트가 다시 응답함: 그록봇 (세대 2'))).toBe(true);
    expect(ctx.store.notifications.list({ ref1: 'seat-unresponsive:2' })[0]!.title).toBe('메인 에이전트가 다시 응답합니다');
    const work = await nextWork(x.api, key, lease.leaseId);
    expect(work.message).toContain('보고서를 정리해 줘');
    const done = await agentCall(x.api, key, `/work/${work.turnId}/finish`, { body: { leaseId: lease.leaseId, finalText: '다시 받아 마쳤습니다', outcome: 'completed' } });
    expect([done.status, done.json().endReason]).toEqual([200, 'completed']);
    expect(ctx.store.conversation.list({ ref1: 'main' }).filter((m) => m.role === 'main_agent').map((m) => m.text)).toEqual(['다시 받아 마쳤습니다']);
  }, 120_000);

  it('앉은 뒤 한 번도 claim하지 않은 외부 보유자는 앉은 때 + 임대 시간부터 응답 없음이다 (S7-4)', async () => {
    const ctx = x.h.core.ctx;
    x.operator.addExternalAgent('늦은봇');
    await x.operator.assignSeat('external:X-0002', true);
    expect(ctx.store.seat.get('main')).toMatchObject({ generation: 3, unresponsiveSince: null });
    await until(() => !!ctx.store.seat.get('main')!.unresponsiveSince, '한 번도 claim하지 않은 보유자의 응답 없음', 30_000, () => situation(x));
    const seat = await x.owner$<SeatView>('seat.get');
    expect(seat).toMatchObject({ generation: 3, holder: { agentId: 'X-0002' }, unresponsiveReason: '외부 에이전트가 메인 자리를 잡지 않음 — 1.5초 동안 claim하지 않음' });
    expect(Date.parse(seat.unresponsiveSince!) - Date.parse(seat.since!)).toBeGreaterThanOrEqual(1500);
  }, 60_000);
});
