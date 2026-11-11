/**
 * externalScreens (SERVER_DESIGN 4.5·8.3, 리드 결정 S7-2·S7-7·S7-13·S7-14 — S6의 캡처 규칙 그대로): 가짜 화면 도우미(tests/fixtures/desktop — 화면을 찍거나 입력을
 * 보내지 않는다)를 붙인 서버 모드에서 외부 보유자가
 * - 화면 확인 업무를 다른 메인 턴처럼 받아 get_screen_check·answer_screen_check로 답한다 — 모델 키는 `external:X-0001` (S7-14)
 * - screen_capture(REST 도구)의 캡처를 `GET /agent/v1/screens/{id}`로 키와 턴 토큰을 함께 보내 받는다 (보관 중이고 해시가 맞는 것만). 토큰이 없거나, 다른 에이전트의
 *   키거나, 다른 세대의 캡처·토큰이면 거부한다
 * - 턴 끝·임대 만료·긴급 정지·자리 교체가 화면 도우미를 CLI 보유자와 똑같이 RELEASE·STOP한다 (리드 결정 S7-13 — S6의 길은 보유자를 가리지 않는다)
 * - REST 도구 길은 이미지를 싣지 않으므로 image가 'file_only'이고, 외부 보유자에게 주는 안내는 Read가 아니라 file과 GET screens/{id}다. MCP 길은 이미지를 붙인다 (S7-17 F6)
 * 시험 자신이 에이전트다(HTTP) — 캡처 ID·턴 토큰을 손에 쥐어야 한다.
 * 임대는 기본 60초이고, 임대 만료는 시계를 앞당겨 만든다 (리드 결정 S7-18 T1): 예전의 2초 임대는 무거운 PC에서 캡처·무장 두 번의 도구 호출(임대를 늘리지 않는다)만으로도
 * 끝나, 교체 1번의 STOP을 보기 전에 나가는 외부 턴이 임대 만료로 끝나 버렸다(전체 시험에서 한 번 :134). 제품은 맞다 — 시험이 시간에 기대지 않게 했다
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID } from '@shared/domain';
import { createFakeDesktop, type FakeDesktop } from '../fixtures/desktop/fakeDesktop';
import { LOOSE_LIMITS } from '../regression/guiRig';
import { agentCall, bootExternal, claimAs, cleanupAll, errCode, nextWork, offsetClock, situation, until, type ExternalEnv, type Work } from './externalRig';

let x: ExternalEnv;
let fake: FakeDesktop;
let key = '';
let otherKey = '';
/** 임대 (기본값 — 시험 중에 저절로 끝나지 않는다) */
const LEASE_MS = 60_000;
const clock = offsetClock();

beforeAll(async () => {
  fake = createFakeDesktop({});
  x = await bootExternal({ desktop: { launcher: fake.launcher, timeouts: { READY: 5000 }, limits: LOOSE_LIMITS }, timing: { agentLeaseMs: LEASE_MS, memoTurnMs: 1500 }, clock });
  // 시작 때 Claude(모의 메인)의 화면 확인 업무가 돈다 — 끝날 때까지
  await until(() => x.h.core.turns.count() === 0 && x.h.core.ctx.store.queue.list({ ref1: MAIN_AGENT_ID, state: 'queued' }).length === 0, '시작 때 화면 확인', 60_000);
  key = x.operator.addExternalAgent('그록봇').key;
  otherKey = x.operator.addExternalAgent('남는봇').key;
}, 120_000);

afterAll(async () => {
  // close()가 던져도(모의 실행이 아닌 메인 턴 등) 가짜 도우미의 정리는 건너뛰지 않는다 (리드 결정 S7-20 TI-9)
  await cleanupAll([() => x?.close(), () => fake?.cleanup()]);
});

const tool = async <T = Record<string, unknown>>(w: Work, name: string, args: Record<string, unknown> = {}): Promise<T> => {
  const r = await agentCall(x.api, key, `/tool/${name}`, { body: args, headers: { 'X-Wook-Turn-Token': w.mcp.token } });
  const j = r.json<{ ok: boolean; data: T; error?: { code: string; message: string } }>();
  if (r.status !== 200 || !j.ok) throw new Error(`${name} 거부: ${r.status} ${j.error?.code} ${j.error?.message}`);
  return j.data;
};
/** MCP tools/call 한 번 — 글 블록의 data와 이미지 블록 수 */
const mcpTool = async <T = Record<string, unknown>>(w: Work, name: string, args: Record<string, unknown> = {}): Promise<{ data: T; images: number }> => {
  const r = await fetch(w.mcp.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${w.mcp.token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const j = (await r.json()) as { result?: { isError?: boolean; content: { type: string; text?: string }[] } };
  if (r.status !== 200 || !j.result || j.result.isError) throw new Error(`${name} 거부(MCP): ${r.status}`);
  return { data: JSON.parse(j.result.content[0]!.text!) as T, images: j.result.content.filter((c) => c.type === 'image').length };
};
const stops = (): number => fake.received().filter((l) => l === 'STOP').length;
const releases = (): number => fake.received().filter((l) => /^\d+ RELEASE$/.test(l)).length;
const arms = (): number => fake.received().filter((l) => / ARM /.test(l) || / ARM$/.test(l)).length;
let rq = 0;
/** 캡처 → 이동 하나 (도우미가 무장한다) */
const armWith = async (w: Work): Promise<string> => {
  const before = arms();
  const cap = await tool<{ capture_id: string }>(w, 'screen_capture', {});
  await tool(w, 'gui_input', { action: 'move', capture_id: cap.capture_id, x: 5, y: 5, request_id: `rq-ext-${++rq}` });
  expect(arms()).toBeGreaterThan(before);
  return cap.capture_id;
};

describe('externalScreens — 외부 보유자의 화면 확인·캡처 받기 (S7-2·S7-14)', () => {
  let lease = { leaseId: '', generation: 0 };
  let gen2Capture = '';
  let gen2Token = '';

  it('화면 확인 업무가 외부 보유자에게 가고, 그 답은 external:X-0001 모델 키로 남는다', async () => {
    const ctx = x.h.core.ctx;
    await x.operator.assignSeat('external:X-0001', true);
    lease = await claimAs(x.api, key);
    const w = await nextWork(x.api, key, lease.leaseId);
    expect(w.message).toContain('(화면 확인 g2:external:X-0001)');
    expect(w.message).toContain('외부 에이전트 그록봇(X-0001)');
    // REST는 이미지를 싣지 않는다 — 'file_only'가 참이고, 안내는 Read가 아니라 file의 PNG다 (S7-17 F6. 예전에는 'attached'·'file을 Read로 여세요')
    const check = await tool<{ image: string; file: string; instruction: string }>(w, 'get_screen_check');
    expect(check.image).toBe('file_only');
    expect(check.instruction).toContain('이미지가 결과에 보이지 않으면 file의 PNG 파일을 여세요');
    expect(check.instruction).not.toMatch(/Read|view_image/);
    // MCP는 이미지를 붙인다 — 그대로 'attached'
    const viaMcp = await mcpTool<{ image: string; file: string }>(w, 'get_screen_check');
    expect([viaMcp.data.image, viaMcp.images, viaMcp.data.file]).toEqual(['attached', 1, check.file]);
    // 화면 보기를 아직 확인하지 않은 보유자의 캡처: REST는 'file_only'와 file·GET screens/{id} 안내, MCP는 이미지가 붙는다
    const capRest = await tool<{ capture_id: string; image: string; note: string | null }>(w, 'screen_capture', {});
    expect(capRest.image).toBe('file_only');
    expect(capRest.note).toContain(`이미지가 보이지 않으면 file의 PNG 파일을 열거나 GET /agent/v1/screens/${capRest.capture_id}(키와 이 턴의 토큰)로 받으세요`);
    expect(capRest.note).not.toMatch(/Read|view_image/);
    const capMcp = await mcpTool<{ image: string }>(w, 'screen_capture', {});
    expect([capMcp.data.image, capMcp.images]).toEqual(['attached', 1]);
    const answer = await tool<{ result: string }>(w, 'answer_screen_check', { code: '0000', request_id: 'rq-check-1' });
    expect(['verified', 'failed']).toContain(answer.result);
    expect(ctx.store.seat.get('main')).toMatchObject({ vision: answer.result, visionModel: 'external:X-0001' });
    const fin = await agentCall(x.api, key, `/work/${w.turnId}/finish`, { body: { leaseId: lease.leaseId, finalText: '확인함', outcome: 'completed' } });
    expect(fin.status).toBe(200);
  }, 60_000);

  it('캡처는 키와 그 턴의 토큰으로만 받는다 — 토큰 없음·다른 에이전트의 키·모르는 ID는 거부', async () => {
    await x.owner$('command.send', { target: 'main', text: '화면을 봐 줘' });
    const w = await nextWork(x.api, key, lease.leaseId);
    const cap = await tool<{ capture_id: string }>(w, 'screen_capture', {});
    const ok = await agentCall(x.api, key, `/screens/${cap.capture_id}`, { headers: { 'X-Wook-Turn-Token': w.mcp.token } });
    expect([ok.status, ok.headers['content-type']]).toEqual([200, 'image/png']);
    expect(ok.body.equals(x.h.core.desktop.keptPng(cap.capture_id)!.bytes)).toBe(true);
    const none = await agentCall(x.api, key, `/screens/${cap.capture_id}`);
    const other = await agentCall(x.api, otherKey, `/screens/${cap.capture_id}`, { headers: { 'X-Wook-Turn-Token': w.mcp.token } });
    const noKey = await agentCall(x.api, null, `/screens/${cap.capture_id}`, { headers: { 'X-Wook-Turn-Token': w.mcp.token } });
    const bad = await agentCall(x.api, key, '/screens/not-an-id', { headers: { 'X-Wook-Turn-Token': w.mcp.token } });
    const unknown = await agentCall(x.api, key, '/screens/SC-999999', { headers: { 'X-Wook-Turn-Token': w.mcp.token } });
    expect([none.status, errCode(none), other.status, errCode(other), noKey.status, bad.status, unknown.status]).toEqual([401, 'unauthorized', 401, 'unauthorized', 401, 404, 404]);
    expect(other.json<{ error: { message: string } }>().error.message).toBe('턴 토큰이 이 키의 에이전트 것이 아닙니다');
    // 다른 에이전트의 키로는 도구도 못 부른다
    const otherTool = await agentCall(x.api, otherKey, '/tool/get_overview', { body: {}, headers: { 'X-Wook-Turn-Token': w.mcp.token } });
    expect(otherTool.status).toBe(401);
    gen2Capture = cap.capture_id;
    gen2Token = w.mcp.token;
    const fin = await agentCall(x.api, key, `/work/${w.turnId}/finish`, { body: { leaseId: lease.leaseId, finalText: '봤습니다', outcome: 'completed' } });
    expect(fin.status).toBe(200);
  }, 60_000);

  it('턴 끝·임대 만료·긴급 정지·자리 교체가 외부 보유자의 화면 도우미를 CLI 보유자와 같이 RELEASE·STOP한다 (S7-13)', async () => {
    const ctx = x.h.core.ctx;
    // ① 턴 끝 → RELEASE
    await x.owner$('command.send', { target: 'main', text: '하나' });
    let w = await nextWork(x.api, key, lease.leaseId);
    await armWith(w);
    let r0 = releases();
    // 그 턴은 finish로 정상 종료했다 — 임대 만료가 아니다 (그 RELEASE가 턴 끝의 것이다, 리드 결정 S7-20)
    const fin1 = await agentCall(x.api, key, `/work/${w.turnId}/finish`, { body: { leaseId: lease.leaseId, finalText: '끝', outcome: 'completed' } });
    expect([fin1.status, fin1.json<{ endReason: string }>().endReason]).toEqual([200, 'completed']);
    await until(() => releases() > r0, '턴 끝의 RELEASE', 30_000, () => situation(x));

    // ② 임대 만료 → 턴이 비정상 종료로 끝나며 RELEASE. 임대가 끝나는 때를 시계로 넘긴다 — 만료는 스케줄러 차례·5초 타이머의 sweep이 본다
    await x.owner$('command.send', { target: 'main', text: '둘' });
    w = await nextWork(x.api, key, lease.leaseId);
    await armWith(w);
    r0 = releases();
    expect(ctx.store.turns.get(w.turnId)!.endedAt).toBeNull();
    clock.advance(LEASE_MS + 1_000);
    await until(() => !!ctx.store.turns.get(w.turnId)?.endedAt, '임대 만료로 턴이 끝남', 30_000, () => situation(x));
    expect(ctx.store.turns.get(w.turnId)).toMatchObject({ endReason: 'crashed', endDetail: expect.stringContaining('외부 에이전트 임대 만료 — 60초 동안 heartbeat 없음') });
    await until(() => releases() > r0, '임대 만료의 RELEASE', 30_000, () => situation(x));

    // ③ 긴급 정지 → STOP
    lease = await claimAs(x.api, key);
    w = await nextWork(x.api, key, lease.leaseId);
    await armWith(w);
    let s0 = stops();
    await x.owner$('stop.emergency');
    expect(stops()).toBeGreaterThan(s0);
    await until(() => x.h.core.turns.count() === 0, '턴 정리');
    await x.owner$('stop.release');

    // ④ 자리 교체 (외부 → Claude, 강제 아님) → 1번에서 곧바로 STOP — 나가는 외부 턴이 아직 마무리하는 동안. 그 턴이 끝나면 넘어간다
    lease = await claimAs(x.api, key);
    w = await nextWork(x.api, key, lease.leaseId);
    await armWith(w);
    s0 = stops();
    const swap = x.h.core.seat.operatorAssign('launched:claude', false);
    await until(() => stops() > s0, '교체 1번의 STOP', 30_000, () => situation(x));
    expect(ctx.store.turns.get(w.turnId)!.endedAt).toBeNull();
    expect(ctx.store.seat.get('main')!.state).toBe('switching');
    // 나가는 세대의 임대는 교체 중에도 받는다 — 그 턴을 마치면 교체가 이어진다 (메모 턴은 그 에이전트가 오지 않아 건너뛴다)
    const fin = await agentCall(x.api, key, `/work/${w.turnId}/finish`, { body: { leaseId: lease.leaseId, finalText: '넘기기 전 마무리', outcome: 'completed' } });
    expect([fin.status, fin.json<{ endReason: string }>().endReason]).toEqual([200, 'completed']);
    await swap.done;
    await until(() => ctx.store.seat.get('main')!.generation === 3 && ctx.store.seat.get('main')!.state === 'active', '세대 3');
  }, 120_000);

  it('다른 세대의 캡처·토큰은 거부한다 — 옛 토큰은 401, 지금 세대의 토큰으로 옛 세대 캡처는 403 seat_changed', async () => {
    const ctx = x.h.core.ctx;
    await until(() => x.h.core.turns.count() === 0 && ctx.store.queue.list({ ref1: MAIN_AGENT_ID, state: 'queued' }).length === 0, 'Claude(모의)가 남은 일을 마침', 60_000, () => situation(x));
    await x.operator.assignSeat('external:X-0001', true);
    await until(() => ctx.store.seat.get('main')!.generation === 4, '세대 4');
    const old = await agentCall(x.api, key, `/screens/${gen2Capture}`, { headers: { 'X-Wook-Turn-Token': gen2Token } });
    expect([old.status, errCode(old)]).toEqual([401, 'unauthorized']);
    lease = await claimAs(x.api, key);
    await x.owner$('command.send', { target: 'main', text: '셋' });
    const w = await nextWork(x.api, key, lease.leaseId);
    expect(w.generation).toBe(4);
    const cross = await agentCall(x.api, key, `/screens/${gen2Capture}`, { headers: { 'X-Wook-Turn-Token': w.mcp.token } });
    expect([cross.status, errCode(cross)]).toEqual([403, 'seat_changed']);
    // 지금 세대의 캡처는 받는다
    const cap = await tool<{ capture_id: string }>(w, 'screen_capture', {});
    expect((await agentCall(x.api, key, `/screens/${cap.capture_id}`, { headers: { 'X-Wook-Turn-Token': w.mcp.token } })).status).toBe(200);
    const fin = await agentCall(x.api, key, `/work/${w.turnId}/finish`, { body: { leaseId: lease.leaseId, finalText: '끝', outcome: 'completed' } });
    expect([fin.status, fin.json<{ endReason: string }>().endReason]).toEqual([200, 'completed']);
  }, 120_000);
});
