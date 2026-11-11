/**
 * 임대가 끝나는 때가 지난 뒤의 도구·화면 호출 (SERVER_DESIGN 4.5, 리드 결정 S7-4·S7-8·S7-17 F4 — 검토 external-flows 4):
 * 예전에는 tool·screens 길과 MCP tools/call이 턴 토큰만 보아, 끝나는 때가 지난 임대의 토큰이 다음 sweep(스케줄러 차례 2초·5초 타이머)까지 살아 있었다 — 그 사이의
 * 상태를 바꾸는 도구(journal_write)가 반영된 뒤 턴이 비정상 종료로 끝나 일이 다시 돌았다. 이제 세 길 모두 먼저 sweep한다: 임대 길이 lease_expired로 답하는 바로 그때
 * 토큰도 죽고(401), 그 호출은 아무것도 바꾸지 않는다. 그 호출이 sweep한 것이므로 턴은 그 자리에서 임대 만료로 끝난다.
 * 시계를 앞당기고 스케줄러와 5초 타이머를 멈춰 둔 채 본다 (그 둘이 끼어들지 않게). 시험 자신이 에이전트다(HTTP). 메인 턴은 모두 모의 실행이거나 외부 턴이다
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID } from '@shared/domain';
import { agentCall, bootExternal, claimAs, errCode, mcpCall, nextWork, offsetClock, until, type ExternalEnv, type Work } from './externalRig';

const LEASE_MS = 60_000;
const clock = offsetClock();
let x: ExternalEnv;
let key = '';

beforeAll(async () => {
  x = await bootExternal({ clock, timing: { agentLeaseMs: LEASE_MS } });
  key = x.operator.addExternalAgent('그록봇').key;
  await x.operator.assignSeat('external:X-0001', true);
  await x.owner$('command.send', { target: 'main', text: '만료 뒤 도구 시험' });
}, 120_000);

afterAll(async () => {
  await x?.close();
});

/** 시험이 스케줄러를 멈춰 두었는지 (다시 켤 때만 start — 두 번 켜면 주기가 겹친다) */
let schedulerStopped = false;

/** 일을 받고, 그 뒤 스케줄러·5초 타이머를 멈추고 시계를 임대 끝 너머로 앞당긴다 — 아직 아무도 sweep하지 않았다 */
async function expiredWork(): Promise<{ w: Work; leaseId: string }> {
  const core = x.h.core;
  if (schedulerStopped) core.scheduler.start();
  schedulerStopped = false;
  core.externalAgents.start();
  const lease = await claimAs(x.api, key);
  const w = await nextWork(x.api, key, lease.leaseId);
  // 토큰은 살아 있다
  expect((await mcpCall(x.mcp, w.mcp.token, 'get_overview')).status).toBe(200);
  core.scheduler.stop();
  schedulerStopped = true;
  core.externalAgents.stopTimers();
  clock.advance(LEASE_MS + 1_000);
  // 스케줄러도 타이머도 멈췄다 — 턴은 아직 살아 있다 (예전 길의 틈)
  expect(core.ctx.store.turns.get(w.turnId)!.endedAt).toBeNull();
  return { w, leaseId: lease.leaseId };
}

const journalRows = (): number => x.h.core.ctx.store.journal.count({ author: 'agent' });
const toolRows = (turnId: string): string[] => x.h.core.ctx.store.activity.search({ kinds: ['app_tool'], turnId, limit: 200 }).map((a) => a.text);
const expiredTurn = (turnId: string): unknown => {
  const t = x.h.core.ctx.store.turns.get(turnId)!;
  return { endReason: t.endReason, endDetail: t.endDetail };
};
const EXPIRED = { endReason: 'crashed', endDetail: expect.stringContaining('외부 에이전트 임대 만료 — 60초 동안 heartbeat 없음') };
const NOTE = { kind: 'note', text: '임대가 끝난 뒤의 기록', request_id: 'rq-expired' };

describe('externalExpiredTool — 끝나는 때가 지난 임대의 토큰은 다음 sweep을 기다리지 않고 죽는다 (S7-17 F4)', () => {
  it('REST tool/{name}: 상태를 바꾸는 도구가 401로 거부되고 아무것도 바꾸지 않는다 — 그 호출이 임대를 끝낸다', async () => {
    const { w, leaseId } = await expiredWork();
    const before = journalRows();
    const r = await agentCall(x.api, key, '/tool/journal_write', { body: NOTE, headers: { 'X-Wook-Turn-Token': w.mcp.token } });
    expect([r.status, errCode(r)]).toEqual([401, 'unauthorized']);
    expect(journalRows()).toBe(before);
    // 처리된 journal_write는 없다 (에이전트 API의 401은 DB에 쓰지 않는다)
    expect(toolRows(w.turnId).filter((t) => t.startsWith('journal_write'))).toEqual([]);
    expect(expiredTurn(w.turnId)).toEqual(EXPIRED);
    // 임대 길도 같은 때를 말한다
    const hb = await agentCall(x.api, key, '/seat/heartbeat', { body: { leaseId } });
    expect([hb.status, errCode(hb)]).toEqual([409, 'lease_expired']);
  }, 120_000);

  it('MCP tools/call: 같은 도구가 401로 거부되고 아무것도 바꾸지 않는다 — 그 호출이 임대를 끝낸다', async () => {
    const { w } = await expiredWork();
    const before = journalRows();
    const r = await mcpCall(x.mcp, w.mcp.token, 'journal_write', NOTE);
    expect(r.status).toBe(401);
    expect(journalRows()).toBe(before);
    // 처리된 journal_write는 없다 — 그 턴의 토큰이 막 폐기돼 그 턴의 거부 한 줄만 (끝난 턴의 토큰은 요청마다 한 줄, S7-17 A1)
    expect(toolRows(w.turnId).filter((t) => t.startsWith('journal_write'))).toEqual(['journal_write 거부']);
    expect(expiredTurn(w.turnId)).toEqual(EXPIRED);
  }, 120_000);

  it('GET screens/{id}: 401 — 그 호출이 임대를 끝낸다 (예전에는 토큰이 살아 있어 캡처를 찾았다)', async () => {
    const { w } = await expiredWork();
    const r = await agentCall(x.api, key, '/screens/SC-000001', { headers: { 'X-Wook-Turn-Token': w.mcp.token } });
    expect([r.status, errCode(r)]).toEqual([401, 'unauthorized']);
    expect(expiredTurn(w.turnId)).toEqual(EXPIRED);
    // 세 번의 임대 만료는 비정상 종료 규칙대로 센다 — 일은 사라지지 않고 기록대로 다뤄진다
    await until(() => x.h.core.turns.count() === 0, '턴 정리');
    expect(x.h.core.ctx.store.turns.list({ ref1: MAIN_AGENT_ID }).filter((t) => t.runner === 'external').map((t) => t.endReason)).toEqual(['crashed', 'crashed', 'crashed']);
  }, 120_000);
});
