/**
 * 도구 중복 캐시와 메인 자리 세대 (SERVER_DESIGN 4.3 '같이 고칠 것'·10.4 seatToolCache, 리드 결정 S4-4):
 * - 같은 세대 안에서는 같은 request_id를 한 번만 처리한다 (AC-45 그대로)
 * - 세대가 바뀌면 새 메인이 이전 메인과 같은 request_id를 써도 다시 처리한다 — 예전에는 예전 결과만 받고 실제 행동은 일어나지 않았다
 * - 이전 세대 토큰은 캐시를 보기 전에 seat_changed로 거부된다 — 메인 검수(review:*) 턴도 같다
 * - 키의 세대는 그 턴의 세대다: 교체 중 나가는 턴의 요청은 나가는 세대로 캐시되어, 새 보유자의 같은 request_id를 막지 않는다
 * - 캐시는 7일 보관한다 — 지난 것은 정리가 지운다. 팀원의 캐시 키는 예전 모양 그대로다
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID, type AiConfig } from '@shared/domain';
import type { TokenIdentity } from '../../src/main/mcp/types';
import { purgeToolCache, TOOL_CACHE_KEEP_MS, toolCacheKey } from '../../src/main/orchestrator/tools';
import { bootOrch, startReview, waitFor, type OrchEnv } from './orchHarness';
import { mainOpsIdentity } from './mainOps';

let env: OrchEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const mainOf = (generation: number): TokenIdentity => ({ ...mainOpsIdentity(), seatGeneration: generation });
const CODEX: AiConfig = { kind: 'codex', model: null, effortTier: 'high', effortOverride: null };
const KEY = 'main:general';

describe('도구 중복 캐시와 메인 자리 세대 (seatToolCache)', () => {
  it('같은 세대에서는 한 번만 처리하고, 세대가 바뀌면 같은 request_id라도 다시 처리한다 — 이전 세대 토큰은 캐시보다 먼저 거부된다', async () => {
    const e = (env = await bootOrch());
    const ask = (who: TokenIdentity) => e.core.tools.handle(who, 'ask_owner', { question: '이대로 진행할까요?', request_id: 'rq-same' });
    const questions = () => e.ctx.store.questions.list().length;

    const a = await ask(mainOf(1));
    const b = await ask(mainOf(1));
    expect([a.ok, b.ok]).toEqual([true, true]);
    expect((b as { data: { duplicateRequest?: boolean } }).data.duplicateRequest).toBe(true);
    expect(questions()).toBe(1);

    // 교체 (실행 중인 메인 턴이 없어 바로 끝난다)
    await e.core.seat.assign({ holder: { kind: 'launched', ai: { kind: 'codex', model: null, effortTier: 'high', effortOverride: null } }, by: 'operator', reason: '시험' }).done;
    expect(e.core.seat.generation()).toBe(2);

    // 이전 세대: 캐시가 있어도 처리하지 않고 seat_changed
    expect(await ask(mainOf(1))).toMatchObject({ ok: false, code: 'seat_changed' });
    expect(questions()).toBe(1);

    // 새 세대: 같은 request_id라도 실제로 처리하고, 그 세대 안에서는 한 번만
    const c = await ask(mainOf(2));
    expect(c.ok).toBe(true);
    expect((c as { data: { duplicateRequest?: boolean } }).data.duplicateRequest).toBeUndefined();
    expect(questions()).toBe(2);
    const d = await ask(mainOf(2));
    expect((d as { data: { duplicateRequest?: boolean } }).data.duplicateRequest).toBe(true);
    expect(questions()).toBe(2);
    // 세대를 적지 않은 프로세스 안 신원은 지금 세대로 본다
    const f = await ask(mainOpsIdentity());
    expect((f as { data: { duplicateRequest?: boolean } }).data.duplicateRequest).toBe(true);
    expect(questions()).toBe(2);

    // 키: 메인은 세대가 들어가고, 팀원은 예전 모양 그대로
    expect([toolCacheKey(MAIN_AGENT_ID, 1, 'ask_owner', 'rq-same'), toolCacheKey('M-0002', null, 'send_message', 'rq-1')]).toEqual([
      'toolreq:M-MAIN:g1:ask_owner:rq-same',
      'toolreq:M-0002:send_message:rq-1',
    ]);
    expect(e.ctx.store.kv.get(toolCacheKey(MAIN_AGENT_ID, 1, 'ask_owner', 'rq-same'))).toMatchObject({ at: expect.any(String) });
    expect(e.ctx.store.kv.get(toolCacheKey(MAIN_AGENT_ID, 2, 'ask_owner', 'rq-same'))).toMatchObject({ at: expect.any(String) });
    const producer: TokenIdentity = {
      turnId: 'TN-p',
      sessionId: 'S-p',
      sessionKey: 'directive:D-0000',
      sessionKind: 'directive',
      memberId: e.producerId,
      projectId: e.projectId,
      isMain: false,
      isProducer: true,
      canReview: true,
    };
    expect((await e.core.tools.handle(producer, 'send_message', { to: 'main', text: '확인 부탁드립니다', request_id: 'rq-p' })).ok).toBe(true);
    expect(e.ctx.store.kv.get(toolCacheKey(e.producerId, null, 'send_message', 'rq-p'))).toMatchObject({ at: expect.any(String) });
  });

  it('교체 중 나가는 턴이 보낸 요청은 그 턴의 세대로 캐시된다 — 새 보유자가 같은 request_id를 써도 다시 처리한다 (S4-22 4번)', async () => {
    const e = (env = await bootOrch());
    e.core.seat.applyOperatorConfig({ holders: null, drainMs: 10_000, initialHolder: null }, '시험');
    e.hold.add(KEY);
    await e.invoke('command.send', { target: 'main', text: '상태 알려줘' });
    e.tick();
    await waitFor(() => !!e.liveProc(KEY, MAIN_AGENT_ID), '메인 턴 시작');
    const outgoing = e.liveProc(KEY, MAIN_AGENT_ID)!.turnId;
    const swap = e.core.seat.assign({ holder: { kind: 'launched', ai: CODEX }, by: 'operator', reason: '시험' });
    expect(e.core.seat.view()).toMatchObject({ generation: 2, state: 'switching' });
    // 마무리 중인 나가는 턴(세대 1)의 요청 — 지금 자리는 세대 2지만 그 턴의 세대로 캐시된다
    expect((await e.tool(outgoing, 'ask_owner', { question: '넘기기 전에 물어볼 것', request_id: 'rq-x' })).ok).toBe(true);
    expect([e.ctx.store.kv.get(toolCacheKey(MAIN_AGENT_ID, 1, 'ask_owner', 'rq-x')) !== null, e.ctx.store.kv.get(toolCacheKey(MAIN_AGENT_ID, 2, 'ask_owner', 'rq-x'))]).toEqual([true, null]);
    // 뒤따르는 인계 메모 턴의 가짜 프로세스는 곧바로 끝난다
    e.hold.delete(KEY);
    e.liveProc(KEY, MAIN_AGENT_ID)!.finishOk();
    await swap.done;
    expect(e.core.seat.view()).toMatchObject({ generation: 2, state: 'active' });
    // 새 보유자의 같은 request_id는 실제로 처리된다 — 예전 결과만 받고 아무것도 하지 않는 일이 없다
    const fresh = await e.core.tools.handle(mainOf(2), 'ask_owner', { question: '새 메인의 질문', request_id: 'rq-x' });
    expect(fresh.ok).toBe(true);
    expect((fresh as { data: { duplicateRequest?: boolean } }).data.duplicateRequest).toBeUndefined();
    expect(e.ctx.store.questions.list().map((q) => q.text).sort()).toEqual(['넘기기 전에 물어볼 것', '새 메인의 질문']);
  });

  it('이전 세대의 메인 검수 턴(review:*)도 seat_changed로 거부된다 — 메인 대화 턴(main:*)과 같다 (S4-22 2번)', async () => {
    const e = (env = await bootOrch());
    const { turnId } = await startReview(e, MAIN_AGENT_ID);
    expect(e.identity(turnId)).toMatchObject({ sessionKind: 'review', isMain: true, seatGeneration: 1 });
    expect((await e.tool(turnId, 'read_memory', {})).ok).toBe(true);
    await e.core.seat.assign({ holder: { kind: 'launched', ai: CODEX }, by: 'operator', reason: '시험', force: true }).done;
    expect(e.core.seat.view()).toMatchObject({ generation: 2, state: 'active' });
    expect(await e.tool(turnId, 'read_memory', {})).toEqual({
      ok: false,
      code: 'seat_changed',
      message: '메인 자리가 바뀌었습니다 (이 턴은 세대 1, 지금은 세대 2) — 이 요청(read_memory)은 처리하지 않았습니다. 지금 턴을 마치세요',
    });
    expect(e.ctx.store.activity.search({ kinds: ['seat'], limit: 50 }).map((r) => r.text)).toContain('이전 세대(1) 메인 토큰의 도구 요청을 거부함: read_memory — 지금 메인 자리는 세대 2입니다');
  });

  it('캐시는 7일 보관한다 — 지난 것만 지우고, 지운 뒤 같은 요청은 다시 처리된다', async () => {
    const e = (env = await bootOrch());
    const ask = () => e.core.tools.handle(mainOf(1), 'ask_owner', { question: '진행할까요?', request_id: 'rq-old' });
    await ask();
    await e.core.tools.handle(mainOf(1), 'ask_owner', { question: '이건 새것', request_id: 'rq-new' });
    const oldKey = toolCacheKey(MAIN_AGENT_ID, 1, 'ask_owner', 'rq-old');
    const newKey = toolCacheKey(MAIN_AGENT_ID, 1, 'ask_owner', 'rq-new');
    const old = e.ctx.store.kv.get<{ data: unknown; at: string }>(oldKey)!;
    e.ctx.store.kv.set(oldKey, { ...old, at: new Date(Date.now() - TOOL_CACHE_KEEP_MS - 60_000).toISOString() });
    // 7일이 조금 안 된 것은 남는다
    const recent = e.ctx.store.kv.get<{ data: unknown; at: string }>(newKey)!;
    e.ctx.store.kv.set(newKey, { ...recent, at: new Date(Date.now() - TOOL_CACHE_KEEP_MS + 60_000).toISOString() });
    expect(purgeToolCache(e.ctx)).toBe(1);
    expect([e.ctx.store.kv.get(oldKey), e.ctx.store.kv.get(newKey) !== null]).toEqual([null, true]);
    expect(e.ctx.store.questions.list()).toHaveLength(2);
    expect((await ask()).ok).toBe(true);
    expect(e.ctx.store.questions.list()).toHaveLength(3);
  });
});
