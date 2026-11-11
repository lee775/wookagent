/**
 * externalFinishSettle (리드 결정 S7-17 F1·F3): 외부 보유자가 finish한 턴의 마무리 중에 온 긴급 정지와 다시 온 finish.
 * - 마무리를 열어 둔다: 그 턴이 화면을 썼고(가짜 도우미 무장), 가짜 도우미가 마무리의 RELEASE에 답하지 않는다(3초 상한) — 턴 흐름은 desktop.settleTurn에서 기다린다.
 *   실제 화면 도우미는 띄우지 않는다 (tests/fixtures/desktop의 가짜)
 * - F1: 정지가 오기 전에 실행이 끝난 턴은 멈추지 않는다 — finish 먼저면 200 completed·답 한 번·다시 넣지 않음·정지 요약의 멈춘 턴에 없음, 정지 먼저면 409 stopped·
 *   한 번 다시 넣음. 같은 틱(한 동기 구간)에서 두 순서 모두. 정지 자체(화면 도우미 STOP, 외부 보유자의 '종료 확인 불가' 줄, 토큰·임대 폐기)는 그대로
 * - F3: 마무리 중에 다시 온 finish·progress는 '턴 …은(는) 이미 끝났습니다 (마무리 중)', 기록까지 끝난 뒤에는 끝 까닭의 한국어 이름
 * 메인 모의 실행은 하네스가 시작 전에 켜고, close()가 모든 M-MAIN 턴이 모의 실행이거나 외부 보유자의 턴인지 본다 (리드 결정 S6-19)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID, OWNER } from '@shared/domain';
import type { EmergencySummary } from '@shared/views';
import { BackendError } from '../../src/main/backend/types';
import { EXTERNAL_STOP } from '../../src/main/orchestrator/externalAgents';
import { createFakeDesktop, killFakePids, type FakeDesktop } from '../fixtures/desktop/fakeDesktop';
import { LOOSE_LIMITS } from '../regression/guiRig';
import { agentCall, bootExternal, claimAs, errCode, nextWork, situation, until, type AgentReply, type ExternalEnv, type Work } from './externalRig';

const AGENT = 'X-0001';
const EXTERNAL_LINE = { memberId: MAIN_AGENT_ID, memberName: '메인 에이전트(그록봇 — 외부)', detail: EXTERNAL_STOP, remaining: -1 };

let x: ExternalEnv;
let fake: FakeDesktop;
let key = '';
let leaseId = '';

const ctx = () => x.h.core.ctx;
const queued = () => ctx().store.queue.list({ ref1: MAIN_AGENT_ID, state: 'queued' });
const replies = (text: string) => ctx().store.conversation.list({ ref1: 'main' }).filter((m) => m.role === 'main_agent' && m.text === text).length;
const releases = () => fake.received().filter((l) => /^\d+ RELEASE$/.test(l)).length;
const stopLines = () => fake.received().filter((l) => l === 'STOP').length;
const actsSeen = () => fake.log().filter((e) => e.dir === 'note' && e.line === 'act set').length;
const message = (r: AgentReply) => r.json<{ error?: { message: string } }>().error?.message;
const finishHttp = (turnId: string, finalText: string) => agentCall(x.api, key, `/work/${turnId}/finish`, { body: { leaseId, finalText, outcome: 'completed' } });

async function tool(w: Work, name: string, args: Record<string, unknown> = {}): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  const r = await agentCall(x.api, key, `/tool/${name}`, { body: args, headers: { 'X-Wook-Turn-Token': w.mcp.token } });
  return r.json<{ ok: boolean; data: Record<string, unknown> }>();
}

/** 대표 명령 하나를 받아 화면을 쓴(도우미 무장) 턴 — 그 뒤 마무리의 RELEASE에 도우미가 답하지 않는다 */
async function armedTurn(text: string): Promise<Work> {
  await x.owner$('command.send', { target: 'main', text });
  const w = await nextWork(x.api, key, leaseId);
  expect(w.message).toContain(text);
  const cap = await tool(w, 'screen_capture');
  expect(cap.ok).toBe(true);
  const mv = await tool(w, 'gui_input', { action: 'move', capture_id: cap.data.capture_id, x: 5, y: 5, request_id: `rq-${w.turnId}` });
  expect(mv.ok).toBe(true);
  // 떠 있는 도우미에게 (40ms 주기로 읽는다) — 그 도우미가 받았다고 적을 때까지 기다린다
  const seen = actsSeen();
  fake.act({ do: 'set', value: { noAck: ['RELEASE'] } });
  await until(() => actsSeen() > seen, '도우미가 RELEASE에 답하지 않게 함', 10_000);
  return w;
}

/** 도우미가 다시 RELEASE에 답하게 한다 — 떠 있는 도우미와 그 뒤에 띄우는 도우미 모두 */
function releaseAnswered(): void {
  fake.act({ do: 'set', value: { noAck: [] } });
}

/** 정지를 풀고 도우미를 되돌린 뒤 다시 claim한다. 다시 넣은 명령이 있으면 받아 마친다 */
async function afterStop(redelivered: string | null): Promise<void> {
  await x.owner$('stop.release');
  releaseAnswered();
  leaseId = (await claimAs(x.api, key)).leaseId;
  if (redelivered) {
    const again = await nextWork(x.api, key, leaseId);
    expect(again.message).toContain(redelivered);
    expect((await finishHttp(again.turnId, `${redelivered} — 다시 받아 마침`)).status).toBe(200);
    await until(() => x.h.core.turns.count() === 0, '다시 받은 턴 정리', 30_000, () => situation(x));
  }
  // 넘길 일이 남지 않았다 — 롱폴은 204
  const idle = await agentCall(x.api, key, '/work/next', { body: { leaseId, waitMs: 800 } });
  expect(idle.status).toBe(204);
}

beforeAll(async () => {
  fake = createFakeDesktop({});
  x = await bootExternal({ desktop: { launcher: fake.launcher, timeouts: { READY: 5000, RELEASE: 3000 }, limits: LOOSE_LIMITS } });
  // 첫 보유자(모의 CLI)의 시작 때 화면 확인 턴이 끝나기를 기다린다
  await until(() => x.h.core.turns.count() === 0 && queued().length === 0, '시작 때 화면 확인', 60_000, () => situation(x));
  key = x.operator.addExternalAgent('그록봇').key;
  await x.operator.assignSeat(`external:${AGENT}`, true);
  leaseId = (await claimAs(x.api, key)).leaseId;
  // 보유자가 바뀌어 새 보유자에게 온 화면 확인 업무 — 답하지 않고 마친다
  const check = await nextWork(x.api, key, leaseId);
  expect(ctx().store.queue.list({ ref1: MAIN_AGENT_ID }).filter((q) => q.turnId === check.turnId).map((q) => q.kind)).toEqual(['screen_check']);
  expect((await finishHttp(check.turnId, '확인하지 않음')).status).toBe(200);
  await until(() => x.h.core.turns.count() === 0 && queued().length === 0, '화면 확인 턴 정리', 30_000, () => situation(x));
}, 120_000);

afterAll(async () => {
  const pids = fake?.pids() ?? [];
  await x?.close();
  killFakePids(pids);
  await fake?.cleanup();
});

describe('F1 — 정지가 오기 전에 실행이 끝난 턴은 멈추지 않는다 (리드 결정 S7-17)', () => {
  it('finish를 받은 턴의 마무리(RELEASE를 기다림) 중에 긴급 정지: finish 200 completed, 답 한 번, 다시 넣지 않음, 요약의 멈춘 턴에 없음 — STOP·외부 줄·토큰 폐기는 그대로', async () => {
    const answer = '화면을 보고 답했습니다';
    const w = await armedTurn('화면 보고 답해 줘');
    const r0 = releases();
    const s0 = stopLines();
    const fin = finishHttp(w.turnId, answer);
    // 마무리가 RELEASE에서 기다린다 — 턴은 아직 실행 중 목록에 있다
    await until(() => releases() > r0, '마무리의 RELEASE', 10_000);
    expect(x.h.core.turns.liveTurnIds()).toContain(w.turnId);
    expect(ctx().store.turns.get(w.turnId)!.endedAt).toBeNull();

    const summary = await x.owner$<EmergencySummary>('stop.emergency');
    const f = await fin;
    await until(() => x.h.core.turns.count() === 0, '마무리 끝', 20_000, () => situation(x));

    expect([f.status, f.json<{ endReason: string }>().endReason]).toEqual([200, 'completed']);
    const t = ctx().store.turns.get(w.turnId)!;
    expect([t.endReason, t.endDetail, t.process.stopRequestedAt]).toEqual(['completed', '', null]);
    expect(replies(answer)).toBe(1);
    expect(queued()).toEqual([]);
    // 이 정지가 끝낸 턴이 아니다 — 요약·활동 기록의 '턴 N개 종료'에 들지 않는다
    expect(summary.stoppedTurns).toEqual([]);
    expect(ctx().store.activity.search({ kinds: ['stop'], limit: 5 }).some((a) => a.text.includes('턴 0개 종료'))).toBe(true);
    // 정지 자체는 그대로: 살아 있던 임대의 '종료 확인 불가' 줄(완료 아님), 화면 도우미 STOP, 턴 토큰 폐기
    expect(summary.completed).toBe(false);
    expect(summary.failures).toEqual([EXTERNAL_LINE]);
    expect(stopLines()).toBeGreaterThan(s0);
    const dead = await agentCall(x.api, key, '/tool/get_overview', { body: {}, headers: { 'X-Wook-Turn-Token': w.mcp.token } });
    expect([dead.status, errCode(dead)]).toEqual([401, 'unauthorized']);
    const hb = await agentCall(x.api, key, '/seat/heartbeat', { body: { leaseId } });
    expect([hb.status, errCode(hb)]).toEqual([409, 'stopped']);

    // 풀어도 그 명령은 다시 오지 않는다 (답은 이미 남았다)
    await afterStop(null);
    expect(replies(answer)).toBe(1);
  }, 90_000);

  it('같은 틱 — finish 먼저, 긴급 정지 다음: finish는 completed, 답 한 번, 다시 넣지 않음, 요약의 멈춘 턴에 없음', async () => {
    const answer = '같은 틱에 먼저 마침';
    const w = await armedTurn('같은 틱 시험 하나');
    const agents = x.h.core.externalAgents;
    // 한 동기 구간: finish가 외부 실행을 끝낸 바로 뒤(턴 흐름의 마무리는 아직 시작 전)에 정지가 온다
    const f = agents.finish(AGENT, leaseId, w.turnId, answer, 'completed');
    const s = x.h.core.stops.emergency(OWNER);
    const [fr, summary] = await Promise.all([f, s]);
    await until(() => x.h.core.turns.count() === 0, '마무리 끝', 20_000, () => situation(x));

    expect(fr).toEqual({ endReason: 'completed' });
    expect(ctx().store.turns.get(w.turnId)!.endReason).toBe('completed');
    expect(replies(answer)).toBe(1);
    expect(queued()).toEqual([]);
    expect(summary.stoppedTurns).toEqual([]);
    expect(summary.failures).toEqual([EXTERNAL_LINE]);
    await afterStop(null);
    expect(replies(answer)).toBe(1);
  }, 90_000);

  it('같은 틱 — 긴급 정지 먼저, finish 다음: finish는 stopped(HTTP 409), 턴은 user_stop, 명령은 한 번 다시 넣는다 — 풀고 나면 한 번 다시 온다', async () => {
    const answer = '정지 뒤에 보낸 답';
    const text = '같은 틱 시험 둘';
    const w = await armedTurn(text);
    const agents = x.h.core.externalAgents;
    const s = x.h.core.stops.emergency(OWNER);
    const f = agents.finish(AGENT, leaseId, w.turnId, answer, 'completed').then(
      () => null,
      (e: unknown) => e,
    );
    const [summary, err] = await Promise.all([s, f]);
    expect(err).toBeInstanceOf(BackendError);
    expect((err as BackendError).code).toBe('stopped');
    // HTTP로 보내도 같은 답 — 409 stopped
    const http = await finishHttp(w.turnId, answer);
    expect([http.status, errCode(http)]).toEqual([409, 'stopped']);
    await until(() => x.h.core.turns.count() === 0, '정지한 턴 정리', 20_000, () => situation(x));

    const t = ctx().store.turns.get(w.turnId)!;
    expect([t.endReason, t.endDetail, t.process.state, t.process.killDetail]).toEqual(['user_stop', '긴급 정지', 'exited', EXTERNAL_STOP]);
    expect(replies(answer)).toBe(0);
    const again = queued().filter((q) => q.message.includes(text));
    expect(again.map((q) => q.kind)).toEqual(['main_command']);
    expect(again[0]!.message).toContain('정지로 중단된 업무입니다');
    expect(summary.stoppedTurns).toEqual([expect.objectContaining({ turnId: w.turnId, ok: true, detail: EXTERNAL_STOP })]);
    expect(summary.failures).toEqual([EXTERNAL_LINE]);

    // 풀면 새 임대로 그 턴에 finish를 보내도 끝난 턴이다 — 끝 까닭은 한국어 이름과 끝 글 (F3)
    await x.owner$('stop.release');
    releaseAnswered();
    leaseId = (await claimAs(x.api, key)).leaseId;
    const late = await finishHttp(w.turnId, answer);
    expect([late.status, errCode(late), message(late)]).toEqual([409, 'turn_ended', `턴 ${w.turnId}은(는) 이미 끝났습니다 (정지 요청으로 종료: 긴급 정지)`]);
    // 다시 넣은 명령은 한 번 온다
    const redo = await nextWork(x.api, key, leaseId);
    expect(redo.message).toContain(text);
    expect((await finishHttp(redo.turnId, `${text} — 다시 받아 마침`)).status).toBe(200);
    await until(() => x.h.core.turns.count() === 0, '다시 받은 턴 정리', 30_000, () => situation(x));
    const idle = await agentCall(x.api, key, '/work/next', { body: { leaseId, waitMs: 800 } });
    expect(idle.status).toBe(204);
  }, 90_000);
});

describe('F3 — 마무리 중에 다시 온 finish·progress는 참인 글을 받는다 (리드 결정 S7-17)', () => {
  it("마무리 중: '이미 끝났습니다 (마무리 중)' — 기록까지 끝난 뒤: '(정상 종료)'. 답은 한 번", async () => {
    const answer = '첫 finish의 답';
    const w = await armedTurn('두 번 마치기');
    const r0 = releases();
    const first = finishHttp(w.turnId, answer);
    await until(() => releases() > r0, '마무리의 RELEASE', 10_000);
    expect(ctx().store.turns.get(w.turnId)!.endedAt).toBeNull();

    const settling = `턴 ${w.turnId}은(는) 이미 끝났습니다 (마무리 중)`;
    const second = await finishHttp(w.turnId, '두 번째 finish의 답');
    expect([second.status, errCode(second), message(second)]).toEqual([409, 'turn_ended', settling]);
    const progress = await agentCall(x.api, key, `/work/${w.turnId}/progress`, { body: { leaseId, text: '늦은 진행' } });
    expect([progress.status, errCode(progress), message(progress)]).toEqual([409, 'turn_ended', settling]);

    const f = await first;
    expect([f.status, f.json<{ endReason: string }>().endReason]).toEqual([200, 'completed']);
    await until(() => x.h.core.turns.count() === 0, '마무리 끝', 20_000, () => situation(x));
    const third = await finishHttp(w.turnId, '세 번째 finish의 답');
    expect([third.status, errCode(third), message(third)]).toEqual([409, 'turn_ended', `턴 ${w.turnId}은(는) 이미 끝났습니다 (정상 종료)`]);
    expect([replies(answer), replies('두 번째 finish의 답'), replies('세 번째 finish의 답')]).toEqual([1, 0, 0]);
    releaseAnswered();
  }, 90_000);
});
