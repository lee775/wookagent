/**
 * 긴 사용량 한도가 메인 에이전트를 며칠 동안 막지 않게 (리드 결정 22, 10-30 — owner-surface 2차 재리뷰 U1·U1b, 프로브 zz-s1fix2-os-u1-usage-limit).
 * Claude CLI는 5시간 한도 말고도 주간 한도(seven_day)와 모델별 주간 한도(seven_day_opus·seven_day_sonnet)를 알려 준다. 예전에는 어떤 한도든 그 AI 종류
 * 전체를 기한(며칠 뒤)까지 막았고, 그 값을 지우는 길은 시간뿐이었다 — Opus 한도에 Sonnet을 쓰는 메인까지 막히고, 결제를 API 키로 바꿔도 풀리지 않았다.
 * - 모델별 주간 한도는 그 모델 계열의 턴만 막는다. 모델을 정하지 않은 턴은 CLI 기본 모델을 알 수 없어 그 계열로 본다 — 메인의 출구는 설치 설정에서
 *   메인 AI 모델을 다른 계열로 정하는 것이다. 종류 전체 한도(five_hour·seven_day 등)는 지금처럼 종류 전체를 막는다
 * - 결제 방식(account.authMode)을 바꾸거나 API 키 방식에서 키를 새로 등록하면 그 종류의 한도 기록(종류 전체·모델별)을 지우고 한 번 다시 시도한다
 *   (활동 기록). 한도가 그대로면 다음 턴이 다시 건다
 * - CLI 다시 확인(system.recheckAi)과 정지 해제는 한도를 지우지 않는다 — CLI가 끝나는 때와 함께 알려 준 사실이다
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID, type AiAvailability } from '@shared/domain';
import type { ParsedCliEvent } from '@shared/events';
import { checkRunGate } from '@core/runGate';
import { createClaudeParser } from '../../src/main/agents/parsers/claudeParser';
import { directiveKey, enqueue } from '../../src/main/orchestrator/records';
import { bootRestartable, seedDirective, sleep, waitUntil, type RestartableEnv } from '../acceptance/stops-helpers';
import { aiOk, clearStop, makeMember, NOW_MS, taskIn } from '../unit/core/fixtures';

let env: RestartableEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const codeOf = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (err: { code?: string }) => err.code ?? 'error',
  );

const DAY = 24 * 3600_000;
const SONNET_MAIN = { kind: 'claude', model: 'claude-sonnet-4-5', effortTier: 'high', effortOverride: null } as const;

/** 가짜 CLI가 claudeParser가 거부된 rate_limit_event에서 내는 것과 같은 사용량 한도 오류를 낸다 */
const limitEvent = (rateLimitType: string, resetAt: string, label: string): ParsedCliEvent =>
  ({ kind: 'error', text: `사용량 한도: ${label}에 도달했습니다 (해제 예정 ${resetAt})`, data: { errorKind: 'usage_limit', resetAt, rateLimitType } }) as ParsedCliEvent;

const mainLaunches = (e: RestartableEnv) => e.launchesOf('main:general');

async function ticks(e: RestartableEnv, n = 5, ms = 80): Promise<void> {
  for (let i = 0; i < n; i++) {
    e.tick();
    await sleep(ms);
  }
}

const clearRows = (e: RestartableEnv, seq0: number) =>
  e.ctx.store.activity.search({ text: '사용량 한도 기록을 지우고', limit: 50 }).filter((r) => r.seq > seq0);

describe('사용량 한도의 범위와 출구 (리드 결정 22)', () => {
  it('Claude 파서는 거부된 rate_limit_event의 한도 종류(seven_day_opus)를 오류와 결과 이벤트에 싣는다', () => {
    const p = createClaudeParser({ serverName: 'wook', now: () => new Date('2026-10-30T00:00:00Z') });
    const lines = [
      { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1793091600, rateLimitType: 'seven_day_opus', isUsingOverage: false } },
      { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Opus weekly limit reached', session_id: 's' },
    ];
    const ev = lines.flatMap((l) => p.pushLine(JSON.stringify(l)));
    const err = ev.filter((x) => x.kind === 'error');
    expect(err[0]!.data).toMatchObject({ errorKind: 'usage_limit', rateLimitType: 'seven_day_opus', resetAt: '2026-10-27T09:00:00.000Z' });
    expect(err[0]!.text).toContain('Opus 주간 한도');
    expect(ev.find((x) => x.kind === 'result')!.data).toMatchObject({ errorKind: 'usage_limit', rateLimitType: 'seven_day_opus' });
  });

  it('허용 검사: 모델별 주간 한도는 그 계열 모델과 정하지 않은 모델의 턴만 막고, 종류 전체 한도는 모든 모델을 막는다', () => {
    const until = new Date(NOW_MS + 5 * DAY).toISOString();
    const gate = (ai: AiAvailability, model: string | null | undefined) =>
      checkRunGate({ stop: clearStop(), member: makeMember('M-DEV', 'developer'), kind: 'task_work', task: taskIn('in_progress'), taskBound: true, recoveryPending: false, ai, model, prereqsDone: null, nowMs: NOW_MS });
    const opus = aiOk({ modelUsageLimits: { opus: until } });
    expect(gate(opus, 'claude-opus-4-1')).toMatchObject({ ok: false, block: 'usage_limit' });
    expect(gate(opus, 'opus')).toMatchObject({ ok: false, block: 'usage_limit' });
    // 정하지 않은 모델 = CLI 기본 모델 — 무엇인지 모르므로 막는다
    expect(gate(opus, null)).toMatchObject({ ok: false, block: 'usage_limit' });
    expect(gate(opus, undefined)).toMatchObject({ ok: false, block: 'usage_limit' });
    expect(gate(opus, 'claude-sonnet-4-5')).toEqual({ ok: true });
    expect(gate(opus, 'haiku')).toEqual({ ok: true });
    const sonnet = aiOk({ modelUsageLimits: { sonnet: until } });
    expect(gate(sonnet, 'sonnet')).toMatchObject({ ok: false, block: 'usage_limit' });
    expect(gate(sonnet, 'claude-opus-4-1')).toEqual({ ok: true });
    // 기한이 지난 모델별 한도는 막지 않는다
    expect(gate(aiOk({ modelUsageLimits: { opus: new Date(NOW_MS - 1).toISOString() } }), null)).toEqual({ ok: true });
    // 종류 전체 한도는 모델과 상관없이
    const kindWide = aiOk({ usageLimitedUntil: until });
    for (const m of ['claude-sonnet-4-5', 'claude-opus-4-1', 'haiku', null]) expect(gate(kindWide, m), String(m)).toMatchObject({ ok: false, block: 'usage_limit' });
  });

  it('(U1b) 팀원의 Opus 주간 한도는 Claude 전체를 막지 않는다 — Sonnet으로 도는 메인은 대표 명령을 처리하고, 한도는 화면·팀원 상태·list_ai_options에 보인다', async () => {
    env = await bootRestartable({ mock: false });
    const e = env;
    expect(e.ctx.store.members.require(e.producerId).ai).toMatchObject({ kind: 'claude', model: null });
    // 메인 AI는 설치 설정에서 Sonnet으로 (데스크톱 운영자, 리드 결정 8)
    await e.invoke('settings.update', { general: { mainAgent: SONNET_MAIN } });
    const resetAt = new Date(Date.now() + 5 * DAY).toISOString();
    const d = seedDirective(e, '지시');
    e.script.set(directiveKey(d.id), (p) => p.emit(limitEvent('seven_day_opus', resetAt, 'Opus 주간 한도')));
    enqueue(e.ctx, { kind: 'plan', memberId: e.producerId, sessionKey: directiveKey(d.id), projectId: e.projectId, directiveId: d.id, priority: 'high', message: '계획' });
    e.tick();
    await waitUntil(() => e.launchesOf(directiveKey(d.id)).length === 1, '프로듀서 턴');
    await waitUntil(() => e.core.turns.count() === 0, '프로듀서 턴 끝', 5000);
    // 모델별로 기록되고, 종류 전체는 막지 않는다
    expect(e.ctx.ai('claude').usageLimitedUntil).toBeNull();
    expect(e.ctx.ai('claude').modelUsageLimits).toEqual({ opus: resetAt });
    const view = (await e.invoke('snapshot.get')).ai.find((a) => a.kind === 'claude')!;
    expect(view).toMatchObject({ usageLimitedUntil: null, blocked: false, modelLimits: [{ family: 'opus', label: 'Opus', until: resetAt }] });
    const notice = e.ctx.store.notifications.list({ ref1: 'usage:claude:opus' });
    expect(notice).toHaveLength(1);
    expect(notice[0]!.body).toContain('설치 설정에서 메인 AI 모델');

    // 대표 명령: Sonnet 메인은 뜬다. 모델을 정하지 않은 프로듀서의 업무는 기다린다
    await e.invoke('command.send', { target: 'main', text: '프로듀서를 Sonnet으로 바꿔 줘' });
    await ticks(e);
    expect(mainLaunches(e).length).toBeGreaterThan(0);
    expect(mainLaunches(e)[0]!.model).toBe('claude-sonnet-4-5');
    expect(e.launchesOf(directiveKey(d.id))).toHaveLength(1);
    expect(e.ctx.store.queue.list({ ref1: e.producerId, state: 'queued' }).map((q) => q.kind)).toContain('plan');
    // 팀원 상태와 메인이 보는 AI 선택지에 그 한도가 보인다
    const producerView = (await e.invoke('snapshot.get')).members.find((m) => m.id === e.producerId)!;
    expect(producerView.statusReasons.join(' ')).toContain('Opus 주간 한도');
    const turnId = mainLaunches(e)[0]!.turnId;
    const opts = await e.core.tools.handle(e.identity(turnId), 'list_ai_options', {});
    expect(opts.ok).toBe(true);
    expect((opts as { ok: true; data: { usageLimits: unknown } }).data.usageLimits).toMatchObject({ claude: { until: null, models: { opus: resetAt } }, codex: { until: null, models: {} } });
  });

  it('메인의 모델을 정하지 않았으면 Opus 주간 한도에 메인도 쉰다 — 데스크톱 운영자가 설치 설정에서 메인 AI 모델을 Sonnet으로 정하면 쌓인 명령이 처리된다', async () => {
    env = await bootRestartable({ mock: false });
    const e = env;
    expect(e.ctx.store.members.require(MAIN_AGENT_ID).ai.model).toBeNull();
    const resetAt = new Date(Date.now() + 5 * DAY).toISOString();
    e.script.set('main:general', (p) => p.emit(limitEvent('seven_day_opus', resetAt, 'Opus 주간 한도')));
    await e.invoke('command.send', { target: 'main', text: '오늘 할 일 정리해 줘' });
    e.tick();
    await waitUntil(() => mainLaunches(e).length === 1, '메인 턴');
    await waitUntil(() => e.core.turns.count() === 0, '메인 턴 끝', 5000);
    e.script.delete('main:general');
    expect(e.ctx.ai('claude')).toMatchObject({ usageLimitedUntil: null, modelUsageLimits: { opus: resetAt } });
    await ticks(e);
    expect(mainLaunches(e)).toHaveLength(1);
    // 출구: 설치 설정의 메인 AI 모델 (리드 결정 22·8)
    expect(await codeOf(e.invoke('settings.update', { general: { mainAgent: SONNET_MAIN } }))).toBe('ok');
    await ticks(e);
    expect(mainLaunches(e)).toHaveLength(2);
    expect(mainLaunches(e)[1]!.model).toBe('claude-sonnet-4-5');
    await waitUntil(() => e.core.turns.count() === 0, '메인 턴 끝', 5000);
    expect(e.ctx.store.queue.list({ ref1: MAIN_AGENT_ID, state: 'queued' })).toEqual([]);
    // 한도 기록은 그대로다 (메인 모델을 바꾼 것이지 한도를 지운 것이 아니다)
    expect(e.ctx.ai('claude').modelUsageLimits).toEqual({ opus: resetAt });
  });

  it('(U1) 종류 전체의 긴 한도: 다시 확인·정지 해제·메인 모델 바꾸기는 한도를 지우지 않고, 결제 방식을 바꾸거나 API 키 방식에서 키를 새로 등록하면 한 번 다시 시도한다 — 한도가 그대로면 다음 턴이 다시 건다', async () => {
    env = await bootRestartable({ mock: false });
    const e = env;
    // Claude만 있는 PC (메인 AI 종류를 바꾸는 출구가 없다)
    e.ctx.deps.adapters.codex.detect = async () => ({ installed: false, path: null, version: null, loggedIn: null, problem: null, detail: '설치되지 않음' });
    await e.invoke('system.recheckAi', 'codex');
    const resetAt = new Date(Date.now() + 5 * DAY).toISOString();
    e.script.set('main:general', (p) => p.emit(limitEvent('seven_day', resetAt, '주간 한도')));
    await e.invoke('command.send', { target: 'main', text: '오늘 할 일 정리해 줘' });
    e.tick();
    await waitUntil(() => mainLaunches(e).length === 1, '메인 턴');
    await waitUntil(() => e.core.turns.count() === 0, '메인 턴 끝', 5000);
    expect(e.ctx.ai('claude').usageLimitedUntil).toBe(resetAt);
    const notice = e.ctx.store.notifications.list({ ref1: 'usage:claude' });
    expect(notice[0]!.body).toContain('결제 방식');
    const seq0 = e.ctx.store.activity.search({ limit: 1 })[0]!.seq;

    // 다시 확인·정지 해제·메인 모델 바꾸기는 지우지 않는다
    expect(await codeOf(e.invoke('system.recheckAi', 'claude'))).toBe('ok');
    expect(await codeOf(e.invoke('stop.release'))).toBe('ok');
    expect(await codeOf(e.invoke('settings.update', { general: { mainAgent: SONNET_MAIN } }))).toBe('ok');
    await ticks(e);
    expect(e.ctx.ai('claude').usageLimitedUntil).toBe(resetAt);
    expect(mainLaunches(e)).toHaveLength(1);
    expect(clearRows(e, seq0)).toEqual([]);

    // 구독 방식에서 키를 넣어도 지우지 않는다 (결제 방식이 바뀌지 않았다)
    expect(await codeOf(e.invoke('settings.setApiKey', 'claude', 'sk-ant-api03-usage-scope-0000000000000000'))).toBe('ok');
    expect(e.ctx.ai('claude').usageLimitedUntil).toBe(resetAt);

    // 결제 방식을 API 키로 → 지우고 한 번 다시 시도한다. 한도가 그대로면(가짜 CLI가 다시 알림) 다음 턴이 다시 건다
    expect(await codeOf(e.invoke('settings.update', { account: { authMode: { claude: 'api_key', codex: 'subscription' } } }))).toBe('ok');
    const rows1 = clearRows(e, seq0);
    expect(rows1).toHaveLength(1);
    expect(rows1[0]).toMatchObject({ kind: 'auth', actor: 'owner' });
    expect(rows1[0]!.text).toContain('claude AI 인증 방식 변경(구독 → API 키)');
    await ticks(e, 3);
    await waitUntil(() => mainLaunches(e).length === 2, '다시 시도한 메인 턴');
    await waitUntil(() => e.core.turns.count() === 0, '메인 턴 끝', 5000);
    expect(e.ctx.ai('claude').usageLimitedUntil).toBe(resetAt);

    // API 키 방식에서 키를 새로 등록 → 다시 지운다. 이번에는 한도가 풀려 있어 명령이 처리된다
    e.script.delete('main:general');
    expect(await codeOf(e.invoke('settings.setApiKey', 'claude', 'sk-ant-api03-usage-scope-1111111111111111'))).toBe('ok');
    const rows2 = clearRows(e, seq0);
    expect(rows2).toHaveLength(2);
    expect(rows2[0]!.text).toContain('API 키를 새로 등록함');
    await ticks(e, 3);
    await waitUntil(() => mainLaunches(e).length === 3, '메인 턴');
    await waitUntil(() => e.core.turns.count() === 0, '메인 턴 끝', 5000);
    expect(e.ctx.store.queue.list({ ref1: MAIN_AGENT_ID, state: 'queued' })).toEqual([]);
    expect(e.ctx.ai('claude')).toMatchObject({ usageLimitedUntil: null, modelUsageLimits: {} });

    // 한도가 없을 때 결제 방식을 바꾸면 지울 것이 없어 기록하지 않는다. 키 값은 기록에 없다
    expect(await codeOf(e.invoke('settings.update', { account: { authMode: { claude: 'subscription', codex: 'subscription' } } }))).toBe('ok');
    expect(clearRows(e, seq0)).toHaveLength(2);
    expect(JSON.stringify(e.ctx.store.activity.search({ limit: 500 }))).not.toContain('sk-ant-api03-usage-scope');
  });

  it('결제 방식 변경은 모델별 주간 한도도 지운다 — 메인 에이전트의 update_settings로 바꿔도 같다 (기록 행위자 메인)', async () => {
    env = await bootRestartable({ mock: false });
    const e = env;
    const until = new Date(Date.now() + 5 * DAY).toISOString();
    e.ctx.saveAi({ ...e.ctx.ai('claude'), modelUsageLimits: { opus: until, sonnet: until } });
    const seq0 = e.ctx.store.activity.search({ limit: 1 })[0]!.seq;
    await e.main('update_settings', { patch: { account: { authMode: { claude: 'api_key' } } }, reason: '대표 명령: 결제를 API 키로' });
    expect(e.ctx.ai('claude')).toMatchObject({ usageLimitedUntil: null, modelUsageLimits: {} });
    expect(clearRows(e, seq0).map((r) => r.actor)).toEqual([MAIN_AGENT_ID]);
    // 다른 종류의 한도는 그대로다
    e.ctx.saveAi({ ...e.ctx.ai('codex'), usageLimitedUntil: until });
    await e.main('update_settings', { patch: { account: { authMode: { claude: 'subscription' } } }, reason: '되돌림' });
    expect(e.ctx.ai('codex').usageLimitedUntil).toBe(until);
  });
});
