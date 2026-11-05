/**
 * Fable 주간 한도는 모델별 한도다 (리드 결정 29, 10-30 — owner-surface 3차 재리뷰 F1, 프로브 zz-s1fix3-os-f1-fable-limit).
 * 설치된 Claude CLI는 Fable 주간 한도를 rate_limit_event의 rateLimitType 'seven_day_overage_included'로 알리고 'Fable limit'이라 부른다.
 * 예전에는 이 값을 모델별 한도로 보지 않아(modelLimitFamily → null) Claude 종류 전체를 기한(며칠 뒤)까지 막았다. 기본 모델 목록의 첫 항목이
 * Fable이라 메인이 어려운 일을 맡은 팀원에게 Fable을 주는 것은 평범한 흐름인데, 그 팀원이 한도에 닿으면 Sonnet으로 도는 메인까지 막혔다.
 * 파서는 이 한도를 '주간 포함 한도'라고 불렀다.
 * - 이제 계열 'fable'(이름 'Fable')이다. 모델 id에 'fable'이 들어가면 그 계열이고, 정하지 않은 모델은 결정 22처럼 그 계열로 본다
 * - 파서 이름은 'Fable 주간 한도', 알림 key는 usage:claude:fable
 * - 'overage'(추가 사용 한도)와 앱이 모르는 한도 종류는 종류 전체 한도 그대로다
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID, type AiAvailability } from '@shared/domain';
import type { ParsedCliEvent } from '@shared/events';
import { checkRunGate } from '@core/runGate';
import { modelLimitFamily } from '@core/usageLimits';
import { createClaudeParser } from '../../src/main/agents/parsers/claudeParser';
import { defaultSettings } from '../../src/main/orchestrator/defaults';
import { directiveKey, enqueue } from '../../src/main/orchestrator/records';
import { bootRestartable, seedDirective, sleep, waitUntil, type RestartableEnv } from '../acceptance/stops-helpers';
import { aiOk, clearStop, makeMember, NOW_MS, taskIn } from '../unit/core/fixtures';

let env: RestartableEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const DAY = 24 * 3600_000;
const SONNET_MAIN = { kind: 'claude', model: 'claude-sonnet-4-5', effortTier: 'high', effortOverride: null } as const;
const FABLE_AI = { kind: 'claude', model: 'fable', effortTier: 'high', effortOverride: null } as const;

/** 가짜 CLI가 claudeParser가 거부된 rate_limit_event에서 내는 것과 같은 사용량 한도 오류를 낸다 */
const limitEvent = (rateLimitType: string, resetAt: string, label: string): ParsedCliEvent =>
  ({ kind: 'error', text: `사용량 한도: ${label}에 도달했습니다 (해제 예정 ${resetAt})`, data: { errorKind: 'usage_limit', resetAt, rateLimitType } }) as ParsedCliEvent;

async function ticks(e: RestartableEnv, n = 5, ms = 80): Promise<void> {
  for (let i = 0; i < n; i++) {
    e.tick();
    await sleep(ms);
  }
}

/** Fable 모델로 도는 프로듀서의 지시 턴이 그 한도 이벤트로 끝난다 */
async function producerHitsLimit(e: RestartableEnv, rateLimitType: string, label: string, resetAt: string): Promise<string> {
  await e.internal('members.update', e.producerId, { ai: FABLE_AI });
  expect(e.ctx.store.members.require(e.producerId).ai.model).toBe('fable');
  const d = seedDirective(e, '어려운 설계');
  e.script.set(directiveKey(d.id), (p) => p.emit(limitEvent(rateLimitType, resetAt, label)));
  enqueue(e.ctx, { kind: 'plan', memberId: e.producerId, sessionKey: directiveKey(d.id), projectId: e.projectId, directiveId: d.id, priority: 'high', message: '계획' });
  e.tick();
  await waitUntil(() => e.launchesOf(directiveKey(d.id)).length === 1, '프로듀서 턴');
  await waitUntil(() => e.core.turns.count() === 0, '프로듀서 턴 끝', 5000);
  return d.id;
}

describe('Fable 주간 한도는 Fable 계열의 턴만 막는다 (리드 결정 29)', () => {
  it('Claude 파서: seven_day_overage_included를 Fable 주간 한도로 부르고 한도 종류를 싣는다 — 계열은 fable, overage와 모르는 종류는 종류 전체', () => {
    const p = createClaudeParser({ serverName: 'wook', now: () => new Date('2026-10-30T00:00:00Z') });
    const lines = [
      { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1793091600, rateLimitType: 'seven_day_overage_included', isUsingOverage: false } },
      { type: 'result', subtype: 'error_during_execution', is_error: true, result: "You've hit your Fable limit", session_id: 's' },
    ];
    const ev = lines.flatMap((l) => p.pushLine(JSON.stringify(l)));
    const err = ev.find((x) => x.kind === 'error')!;
    expect(err.text).toContain('Fable 주간 한도에 도달했습니다');
    expect(err.text).not.toContain('주간 포함 한도');
    expect(err.data).toMatchObject({ errorKind: 'usage_limit', rateLimitType: 'seven_day_overage_included' });
    expect(ev.find((x) => x.kind === 'result')!.data).toMatchObject({ errorKind: 'usage_limit', rateLimitType: 'seven_day_overage_included' });
    expect(modelLimitFamily('seven_day_overage_included')).toBe('fable');
    // 기본 모델 목록의 첫 항목이 Fable이다 — 메인이 팀원에게 Fable을 주는 것은 평범한 흐름이다
    expect(defaultSettings().team.modelCatalog?.claude[0]?.id).toBe('fable');
    // 추가 사용 한도와 앱이 모르는 종류는 종류 전체 한도로 다룬다
    for (const t of ['overage', 'five_hour', 'seven_day', 'seven_day_new_model', undefined, null]) expect(modelLimitFamily(t), String(t)).toBeNull();
  });

  it('허용 검사: Fable 한도는 fable 모델과 정하지 않은 모델의 턴만 막는다', () => {
    const until = new Date(NOW_MS + 5 * DAY).toISOString();
    const gate = (ai: AiAvailability, model: string | null | undefined) =>
      checkRunGate({ stop: clearStop(), member: makeMember('M-DEV', 'developer'), kind: 'task_work', task: taskIn('in_progress'), taskBound: true, recoveryPending: false, ai, model, prereqsDone: null, nowMs: NOW_MS });
    const fable = aiOk({ modelUsageLimits: { fable: until } });
    for (const m of ['fable', 'claude-fable-5', null, undefined]) expect(gate(fable, m), String(m)).toMatchObject({ ok: false, block: 'usage_limit' });
    expect((gate(fable, 'fable') as { detail: string }).detail).toContain('Fable 주간 한도');
    for (const m of ['claude-sonnet-4-5', 'opus', 'haiku']) expect(gate(fable, m), m).toEqual({ ok: true });
  });

  it('(F1) Fable 팀원이 Fable 주간 한도에 닿아도 Claude 전체는 막히지 않는다 — Sonnet 메인이 대표 명령을 처리하고, Fable 팀원의 업무만 기다린다', async () => {
    env = await bootRestartable({ mock: false });
    const e = env;
    // 데스크톱 운영자가 메인 AI를 Sonnet으로 (리드 결정 8)
    await e.invoke('settings.update', { general: { mainAgent: SONNET_MAIN } });
    const resetAt = new Date(Date.now() + 5 * DAY).toISOString();
    const directiveId = await producerHitsLimit(e, 'seven_day_overage_included', 'Fable 주간 한도', resetAt);
    // 모델별로 기록되고, 종류 전체는 비어 있다
    expect(e.ctx.ai('claude').usageLimitedUntil).toBeNull();
    expect(e.ctx.ai('claude').modelUsageLimits).toEqual({ fable: resetAt });
    const view = (await e.invoke('snapshot.get')).ai.find((a) => a.kind === 'claude')!;
    expect(view).toMatchObject({ usageLimitedUntil: null, blocked: false, modelLimits: [{ family: 'fable', label: 'Fable', until: resetAt }] });
    expect(e.ctx.store.notifications.list({ ref1: 'usage:claude' })).toEqual([]);
    const notice = e.ctx.store.notifications.list({ ref1: 'usage:claude:fable' });
    expect(notice).toHaveLength(1);
    expect(notice[0]!.title).toBe('Fable 주간 한도');
    expect(notice[0]!.body).toContain('Fable 모델의 턴만 쉽니다');

    // 대표 명령: Sonnet 메인은 뜬다. Fable 팀원의 업무는 기다린다
    await e.invoke('command.send', { target: 'main', text: '오늘 할 일 정리해 줘' });
    await ticks(e);
    expect(e.launchesOf('main:general').length).toBeGreaterThan(0);
    expect(e.launchesOf('main:general')[0]!.model).toBe('claude-sonnet-4-5');
    await waitUntil(() => e.core.turns.count() === 0, '메인 턴 끝', 5000);
    expect(e.ctx.store.queue.list({ ref1: MAIN_AGENT_ID, state: 'queued' })).toEqual([]);
    expect(e.launchesOf(directiveKey(directiveId))).toHaveLength(1);
    expect(e.ctx.store.queue.list({ ref1: e.producerId, state: 'queued' }).map((q) => q.kind)).toContain('plan');
    // 팀원 상태와 메인이 보는 AI 선택지에 Fable 한도가 보인다
    const producerView = (await e.invoke('snapshot.get')).members.find((m) => m.id === e.producerId)!;
    expect(producerView.statusReasons.join(' ')).toContain('Fable 주간 한도');
    const opts = await e.core.tools.handle(e.identity(e.launchesOf('main:general')[0]!.turnId), 'list_ai_options', {});
    expect((opts as { ok: true; data: { usageLimits: unknown } }).data.usageLimits).toMatchObject({ claude: { until: null, models: { fable: resetAt } } });
  });

  it('앱이 모르는 한도 종류는 종류 전체 한도로 다룬다 — 어느 모델의 한도인지 모르면 Claude의 모든 턴을 막는다', async () => {
    env = await bootRestartable({ mock: false });
    const e = env;
    await e.invoke('settings.update', { general: { mainAgent: SONNET_MAIN } });
    const resetAt = new Date(Date.now() + 2 * DAY).toISOString();
    await producerHitsLimit(e, 'seven_day_new_model', 'seven_day_new_model', resetAt);
    expect(e.ctx.ai('claude').usageLimitedUntil).toBe(resetAt);
    expect(e.ctx.ai('claude').modelUsageLimits ?? {}).toEqual({});
    expect(e.ctx.store.notifications.list({ ref1: 'usage:claude' })).toHaveLength(1);
    await e.invoke('command.send', { target: 'main', text: '오늘 할 일 정리해 줘' });
    await ticks(e);
    expect(e.launchesOf('main:general')).toHaveLength(0);
  });
});
