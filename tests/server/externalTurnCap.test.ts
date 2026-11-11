/**
 * externalTurnCap (리드 결정 S7-4 '턴 시간 상한(deadlineAt)은 걸리고 출력 없음 감시는 걸리지 않는다', S7-16 5 → S7-17 G1) — 앞당긴 시계로.
 * - 외부 보유자의 턴이 heartbeat만 하고 아무것도 쓰지 않는다(진행·도구 호출 없음). 출력 없음 기준(noOutputMin)과 상태 확인(healthCheckMin)을 넘겨도 그 턴은 계속 돌고
 *   '응답 확인 중' 기록도 없다 — 임대가 살아 있는지가 그 확인이다
 * - 턴 시간 상한(turnTimeoutMin)을 넘기면 상한의 까닭으로 끝나고(timeout '턴 시간 상한 N분 초과', 끝남은 확인할 수 없다는 글) 그 턴 토큰은 REST·MCP 모두 401이다.
 *   그 명령은 메인 턴이 상한으로 끝날 때의 규칙 그대로다(judgeMain — 다시 넣지 않고 받은 것으로 둔다)
 * 임대는 시험에서 길게 둔다(3시간) — 시계를 앞당겨도 임대 만료가 먼저 오지 않게. 그래도 시계를 앞당길 때마다 heartbeat를 보낸다
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID } from '@shared/domain';
import { EXTERNAL_STOP } from '../../src/main/orchestrator/externalAgents';
import { agentCall, bootExternal, claimAs, errCode, mcpCall, nextWork, offsetClock, situation, sleep, until, type ExternalEnv } from './externalRig';

const clock = offsetClock();
let x: ExternalEnv;

beforeAll(async () => {
  x = await bootExternal({ clock, timing: { agentLeaseMs: 3 * 3600_000 } });
}, 120_000);

afterAll(async () => {
  await x?.close();
});

describe('externalTurnCap — 외부 턴에는 턴 시간 상한만 걸린다 (S7-4)', () => {
  it('heartbeat만 하는 외부 턴: 출력 없음 기준을 넘겨도 계속 돈다 — 턴 시간 상한을 넘기면 그 까닭으로 끝나고 토큰이 죽는다', async () => {
    const ctx = x.h.core.ctx;
    const s = ctx.settings().execution;
    expect([s.noOutputMin, s.healthCheckMin, s.turnTimeoutMin]).toEqual([10, 3, 60]);
    const { key } = x.operator.addExternalAgent('그록봇');
    await x.operator.assignSeat('external:X-0001', true);
    const lease = await claimAs(x.api, key);
    await x.owner$('command.send', { target: 'main', text: '오래 생각할 일을 맡아 줘' });
    const w = await nextWork(x.api, key, lease.leaseId);
    const startedMs = Date.parse(ctx.store.turns.get(w.turnId)!.startedAt);
    expect(Date.parse(w.deadlineAt) - startedMs).toBe(s.turnTimeoutMin * 60_000);
    const entry = ctx.store.queue.list({ ref1: MAIN_AGENT_ID }).find((q) => q.turnId === w.turnId && q.kind === 'main_command')!;
    expect(entry.state).toBe('running');

    const beat = async () => {
      const r = await agentCall(x.api, key, '/seat/heartbeat', { body: { leaseId: lease.leaseId } });
      expect(r.status).toBe(200);
    };
    // 감시 차례 몇 번 (하네스 watchdogMs 200ms)
    const watchdogTicks = () => sleep(1_000);
    const quietWarnings = () => ctx.store.activity.search({ limit: 300 }).filter((a) => a.turnId === w.turnId && a.text.startsWith('응답 확인 중'));

    // 출력 없음 기준을 넘긴다 — CLI 턴이면 여기서 '응답 확인 중'이 적힌다
    clock.advance((s.noOutputMin + 1) * 60_000);
    await beat();
    await watchdogTicks();
    // 상태 확인 시간까지 넘긴다 — CLI 턴이면 여기서 no_response로 끝난다
    clock.advance((s.healthCheckMin + 1) * 60_000);
    await beat();
    await watchdogTicks();
    expect(x.h.core.turns.liveTurnIds()).toContain(w.turnId);
    expect(ctx.store.turns.get(w.turnId)!.endedAt).toBeNull();
    expect(quietWarnings()).toEqual([]);
    // 토큰은 살아 있다
    expect((await mcpCall(x.mcp, w.mcp.token, 'get_overview')).status).toBe(200);

    // 턴 시간 상한을 넘긴다
    const elapsed = clock.ms() - startedMs;
    clock.advance(s.turnTimeoutMin * 60_000 - elapsed + 60_000);
    await beat();
    await until(() => !!ctx.store.turns.get(w.turnId)?.endedAt, '턴 시간 상한으로 끝남', 10_000).catch(() => undefined);
    const t = ctx.store.turns.get(w.turnId)!;
    expect([t.endReason, t.endDetail, t.process.state, t.process.killDetail]).toEqual(['timeout', `턴 시간 상한 ${s.turnTimeoutMin}분 초과`, 'exited', EXTERNAL_STOP]);
    await until(() => x.h.core.turns.count() === 0, '턴 정리', 10_000, () => situation(x));
    expect(quietWarnings()).toEqual([]);

    // 그 턴 토큰은 죽었다 — REST·MCP 모두 401. 늦은 finish는 끝난 턴이라는 참인 글 (F3의 한국어 이름)
    const rest = await agentCall(x.api, key, '/tool/get_overview', { body: {}, headers: { 'X-Wook-Turn-Token': w.mcp.token } });
    expect([rest.status, errCode(rest)]).toEqual([401, 'unauthorized']);
    expect((await mcpCall(x.mcp, w.mcp.token, 'get_overview')).status).toBe(401);
    const late = await agentCall(x.api, key, `/work/${w.turnId}/finish`, { body: { leaseId: lease.leaseId, finalText: '늦은 답', outcome: 'completed' } });
    expect([late.status, errCode(late), late.json<{ error: { message: string } }>().error.message]).toEqual([
      409,
      'turn_ended',
      `턴 ${w.turnId}은(는) 이미 끝났습니다 (시간 상한 초과: 턴 시간 상한 ${s.turnTimeoutMin}분 초과)`,
    ]);

    // 메인 턴이 상한으로 끝날 때의 규칙: 다시 넣지 않는다 (받은 것으로 둔다) — CLI 메인 턴과 같다
    expect(ctx.store.queue.get(entry.id)!.state).toBe('done');
    expect(ctx.store.queue.list({ ref1: MAIN_AGENT_ID, state: 'queued' })).toEqual([]);
    // 임대는 그대로 — 자리는 응답 없음이 아니다
    expect(ctx.store.seat.get('main')!.unresponsiveSince).toBeNull();
  }, 90_000);
});
