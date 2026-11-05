/**
 * 교체 직후 모든 M-MAIN 세션이 새 AI 종류다 (SERVER_DESIGN 4.3 5번·10.4 seatSwapMixed, 리드 결정 S4-3): 모의 Claude 메인에서 모의 Codex 메인으로.
 * 예전에는 키마다 다음 턴에 가서야 세션이 바뀌어 Claude 세션과 Codex 세션이 한동안 섞였다. 이제 교체 5번이 열린 M-MAIN 세션(main:*와 메인이 검수자인
 * review:*)을 한꺼번에 닫는다(교체 사유 '메인 자리 교체(세대 n)'). 모의 에이전트는 실제 프로세스로 CLI 형식(claude·codex)을 그대로 내고 앱의 실제 파서가 읽는다.
 * 교체 4번은 남은 메인 토큰(main:*와 메인 검수 review:*)을 실제 앱 도구 서버에서 지운다 — 그 뒤 요청은 401이다
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID, type AgentSession } from '@shared/domain';
import { createHarness, type Harness } from './harness';

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const mainSessions = (x: Harness) => x.core.ctx.store.sessions.list({ ref1: MAIN_AGENT_ID });
const endedMainTurns = (x: Harness) => x.core.ctx.store.turns.list({ ref1: MAIN_AGENT_ID }).filter((t) => !!t.endedAt);

describe('메인 자리 교체와 세션 (seatSwapMixed)', () => {
  it('모의 Claude 메인에서 모의 Codex 메인으로 바꾸면 열린 M-MAIN 세션이 모두 닫히고, 그 뒤의 메인 세션은 모두 Codex다', async () => {
    const x = (h = await createHarness({ noProject: true }));
    const ctx = x.core.ctx;
    await x.invoke('command.send', { target: 'main', text: '안녕하세요, 지금 상태를 알려 주세요' });
    await x.waitFor(() => endedMainTurns(x).length === 1 && x.core.turns.count() === 0, { label: '모의 Claude 메인 턴', timeoutMs: 60_000 });
    // 메인이 검수자인 검수 세션도 하나 열려 있다 — 교체가 main:*와 함께 닫아야 한다
    const review: AgentSession = {
      ...mainSessions(x)[0]!,
      id: ctx.store.nextId('session'),
      kind: 'review',
      workKey: 'review:T-9999',
      cliSessionId: null,
      turnCount: 0,
      closedAt: null,
      replaceReason: null,
    };
    ctx.store.sessions.insert(review);
    expect(mainSessions(x).filter((s) => !s.closedAt).map((s) => [s.workKey, s.aiKind])).toEqual([
      ['main:general', 'claude'],
      ['review:T-9999', 'claude'],
    ]);

    // 끝나지 않은 메인 토큰이 하나 남아 있다고 하자 — 교체 4번(revokeWhere)이 앱 도구 서버에서 지운다
    const stray = x.core.toolServer.issueToken({
      turnId: 'TN-stray',
      sessionId: review.id,
      sessionKey: 'main:general',
      sessionKind: 'main_general',
      memberId: MAIN_AGENT_ID,
      projectId: null,
      isMain: true,
      isProducer: false,
      canReview: false,
      seatGeneration: 1,
    });
    const callWith = (token: string) =>
      fetch(x.core.toolServer.url!, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_memory', arguments: {} } }),
      });
    expect((await callWith(stray)).status).toBe(200);
    await x.core.seat.assign({ holder: { kind: 'launched', ai: { kind: 'codex', model: null, effortTier: 'high', effortOverride: null } }, by: 'operator', reason: '모의 Codex로' }).done;
    expect((await callWith(stray)).status).toBe(401);
    expect(ctx.store.activity.search({ kinds: ['seat'], limit: 20 }).map((r) => r.text)).toContainEqual(expect.stringContaining('메인 토큰 1개 폐기'));
    // 교체 직후: 열린 M-MAIN 세션이 하나도 없다 — 모두 교체 사유로 닫혔다
    expect(mainSessions(x).filter((s) => !s.closedAt)).toEqual([]);
    expect(mainSessions(x).map((s) => [s.workKey, s.replaceReason])).toEqual([
      ['main:general', '메인 자리 교체(세대 2)'],
      ['review:T-9999', '메인 자리 교체(세대 2)'],
    ]);

    await x.invoke('command.send', { target: 'main', text: '다시 상태를 알려 주세요' });
    await x.waitFor(() => endedMainTurns(x).length === 3 && x.core.turns.count() === 0, { label: '모의 Codex 메인 턴', timeoutMs: 60_000 });
    const turns = ctx.store.turns.list({ ref1: MAIN_AGENT_ID });
    // 두 형식 모두 실제 파서가 읽고 정상으로 끝났다 — 가운데는 운영자 교체가 나가는 모의 Claude 메인에게 준 인계 메모 턴이다 (4.3 3번, S4b)
    expect(turns.map((t) => [t.aiKind, t.mock, t.endReason, t.eventCount > 0])).toEqual([
      ['claude', true, 'completed', true],
      ['claude', true, 'completed', true],
      ['codex', true, 'completed', true],
    ]);
    const openNow = mainSessions(x).filter((s) => !s.closedAt);
    expect(openNow.map((s) => [s.workKey, s.aiKind, s.replaceReason])).toEqual([['main:general', 'codex', '메인 자리 교체(세대 2)']]);
    expect(openNow.every((s) => s.aiKind === 'codex')).toBe(true);
    expect(x.snapshot().seat).toMatchObject({ generation: 2, state: 'active', holder: { label: 'Codex CLI' } });
  }, 150_000);

  it('교체 4번(revokeWhere)은 메인 검수(review:*) 토큰도 앱 도구 서버에서 지운다 — 메인 대화(main:*) 토큰과 함께 (S4-22 3번)', async () => {
    const x = (h = await createHarness({ noProject: true }));
    const issue = (sessionKey: string, sessionKind: 'main_general' | 'review') =>
      x.core.toolServer.issueToken({
        turnId: `TN-stray-${sessionKind}`,
        sessionId: `S-stray-${sessionKind}`,
        sessionKey,
        sessionKind,
        memberId: MAIN_AGENT_ID,
        projectId: null,
        isMain: true,
        isProducer: false,
        canReview: sessionKind === 'review',
        seatGeneration: 1,
      });
    const tokens = [issue('main:general', 'main_general'), issue('review:T-9999', 'review')];
    const status = async (token: string) =>
      (
        await fetch(x.core.toolServer.url!, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_memory', arguments: {} } }),
        })
      ).status;
    expect(await Promise.all(tokens.map(status))).toEqual([200, 200]);
    await x.core.seat.assign({ holder: { kind: 'launched', ai: { kind: 'codex', model: null, effortTier: 'high', effortOverride: null } }, by: 'operator', reason: '모의 Codex로', force: true }).done;
    expect(await Promise.all(tokens.map(status))).toEqual([401, 401]);
    expect(x.core.ctx.store.activity.search({ kinds: ['seat'], limit: 20 }).map((r) => r.text)).toContainEqual(expect.stringContaining('메인 토큰 2개 폐기'));
  }, 120_000);
});
