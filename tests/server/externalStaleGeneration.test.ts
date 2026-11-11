/**
 * externalStaleGeneration (SERVER_DESIGN 4.1·4.3, 리드 결정 S7-3·S7-4·S7-7): 외부 보유자에서 서버가 띄우는 CLI로 갔다가(seat assign launched:claude --force) 다시 같은
 * 에이전트로 돌아오면(세대 2 → 3 → 4), 옛 임대·옛 턴·옛 턴 토큰은 모두 거부되고 DB는 바뀌지 않는다 — 임대·턴 길은 409 seat_changed(세대와 지금 보유자를 말한다),
 * 토큰은 MCP·REST·화면 모두 401. 이 시험은 옛 임대와 토큰을 손에 쥐어야 해서 시험 자신이 에이전트다(HTTP)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID } from '@shared/domain';
import { agentCall, bootExternal, claimAs, errCode, mcpCall, nextWork, until, type ExternalEnv } from './externalRig';

let x: ExternalEnv;

beforeAll(async () => {
  x = await bootExternal({});
}, 120_000);

afterAll(async () => {
  await x?.close();
});

const dbPrint = (): string => {
  const ctx = x.h.core.ctx;
  return JSON.stringify({
    seat: ctx.store.seat.get('main'),
    history: ctx.store.seatHistory.list(),
    queue: ctx.store.queue.list(),
    turns: ctx.store.turns.list(),
    sessions: ctx.store.sessions.list(),
    conversation: ctx.store.conversation.list({ ref1: 'main' }),
    agents: ctx.store.externalAgents.list().map((a) => ({ ...a, lastSeenAt: null })),
  });
};

describe('externalStaleGeneration — 옛 세대의 임대·턴·토큰은 거부되고 DB는 그대로다 (S7-3)', () => {
  it('세대 2의 임대·턴·토큰을 세대 4에서 쓰면 409 seat_changed와 401 — DB는 바뀌지 않는다', async () => {
    const ctx = x.h.core.ctx;
    const { key } = x.operator.addExternalAgent('그록봇');
    await x.operator.assignSeat('external:X-0001', true);
    await x.owner$('command.send', { target: 'main', text: '첫 일' });
    const lease = await claimAs(x.api, key);
    const work = await nextWork(x.api, key, lease.leaseId);
    expect([lease.generation, work.generation]).toEqual([2, 2]);
    expect((await mcpCall(x.mcp, work.mcp.token, 'get_overview')).status).toBe(200);

    // 서버가 띄우는 CLI로 (강제 — 외부 턴은 토큰을 폐기해 멈춘다) → 다시 같은 에이전트로
    await x.operator.assignSeat('launched:claude', true);
    await until(() => ctx.store.seat.get('main')!.generation === 3 && ctx.store.seat.get('main')!.state === 'active', '세대 3');
    await until(() => x.h.core.turns.count() === 0 && ctx.store.queue.list({ ref1: MAIN_AGENT_ID, state: 'queued' }).length === 0, '다시 넣은 일을 Claude(모의)가 마침', 60_000);
    await x.operator.assignSeat('external:X-0001', true);
    await until(() => ctx.store.seat.get('main')!.generation === 4 && ctx.store.seat.get('main')!.state === 'active', '세대 4');

    const before = dbPrint();
    const activityBefore = ctx.store.activity.search({ limit: 5000 }).length;
    const seatChanged = '메인 자리가 바뀌었습니다 (이 임대는 세대 2, 지금은 세대 4 — 그록봇)';
    for (const [path, body] of [
      ['/seat/heartbeat', { leaseId: lease.leaseId }],
      ['/work/next', { leaseId: lease.leaseId, waitMs: 0 }],
      [`/work/${work.turnId}/progress`, { leaseId: lease.leaseId, text: '옛 턴의 진행' }],
      [`/work/${work.turnId}/finish`, { leaseId: lease.leaseId, finalText: '옛 턴의 답', outcome: 'completed' }],
      ['/seat/release', { leaseId: lease.leaseId }],
    ] as const) {
      const r = await agentCall(x.api, key, path, { body });
      expect([path, r.status, errCode(r), r.json<{ error: { message: string } }>().error.message]).toEqual([path, 409, 'seat_changed', seatChanged]);
    }
    // 옛 턴 토큰 — MCP·REST·화면 모두 401
    expect((await mcpCall(x.mcp, work.mcp.token, 'get_overview')).status).toBe(401);
    const tool = await agentCall(x.api, key, '/tool/get_overview', { body: {}, headers: { 'X-Wook-Turn-Token': work.mcp.token } });
    const screen = await agentCall(x.api, key, '/screens/SC-000001', { headers: { 'X-Wook-Turn-Token': work.mcp.token } });
    expect([tool.status, errCode(tool), screen.status, errCode(screen)]).toEqual([401, 'unauthorized', 401, 'unauthorized']);

    // DB는 그대로 — 바뀐 것은 MCP 401의 거부 기록(app_tool) 한 줄뿐이다: 이 실행에서 폐기한 토큰(끝난 턴)이라 그 턴(M-MAIN)의 이름으로 요청마다 한 줄이다
    // (리드 결정 S7-17 A1 — 모르는 토큰이면 DB에 쓰지 않는다. REST·화면의 401은 줄이 없다)
    expect(dbPrint()).toBe(before);
    const added = ctx.store.activity.search({ limit: 5000 }).slice(0, ctx.store.activity.search({ limit: 5000 }).length - activityBefore);
    expect(added.map((a) => [a.kind, a.text, a.memberId, a.turnId])).toEqual([['app_tool', 'get_overview 거부', MAIN_AGENT_ID, work.turnId]]);

    // 옛 턴은 세대 3으로 갈 때 멈췄다 (user_stop) — 새 세대의 claim은 된다
    expect(ctx.store.turns.get(work.turnId)).toMatchObject({ endReason: 'user_stop', seatGeneration: 2 });
    const fresh = await claimAs(x.api, key);
    expect(fresh.generation).toBe(4);
  }, 120_000);
});
