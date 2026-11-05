/**
 * AI 인증 방식(account.authMode)은 구독(subscription)·API 키(api_key)만 받는다 (리드 결정 34, 10-30 — S1F6 알아 둘 것 5).
 * 결제 방식은 메인 에이전트의 update_settings와 데스크톱 운영자(설치 설정)가 함께 바꾸는 값이다(리드 결정 9). 예전에는 값 자체를 보지 않아 'free'·
 * 'API_KEY'·숫자·객체가 그대로 저장됐다. 다른 값은 구독처럼 돌아 결제 방식이 화면과 다르게 보이고, 결제 방식이 '바뀌었다'며 사용량 한도 기록을
 * 지우고(리드 결정 22) 그 값을 활동 기록 글에 그대로 적었다.
 * - 이제 settings.update의 형식 검사(settingsShapeProblems, 리드 결정 27과 같은 길)가 본다: AI 종류는 claude·codex만, 값은 subscription·api_key만.
 *   틀리면 invalid이고 아무것도 저장하지 않는다(같은 요청의 다른 값도). 메인의 update_settings, 데스크톱 운영자, 운영자 내부 API 모두 같은 처리기다
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID } from '@shared/domain';
import { TOOL_SPECS } from '../../src/main/mcp/catalog';
import { bootRestartable, type RestartableEnv } from '../acceptance/stops-helpers';

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
const BAD: unknown[] = [
  { claude: 'free' },
  { claude: 'API_KEY' },
  { codex: 'apikey' },
  { claude: '' },
  { claude: null },
  { claude: 1 },
  { claude: true },
  { claude: { mode: 'api_key' } },
  { claude: ['api_key'] },
  { gemini: 'api_key' },
  'api_key',
  null,
  [],
  7,
];

describe('AI 인증 방식은 subscription·api_key만 (리드 결정 34)', () => {
  it('틀린 값은 메인·데스크톱 운영자·운영자 내부 API 모두 invalid — 아무것도 저장하지 않고, 한도 기록을 지우거나 기록을 남기지 않는다', async () => {
    env = await bootRestartable({ mock: false });
    const e = env;
    // 걸려 있던 사용량 한도 — 결제 방식이 정말 바뀌었을 때만 지운다 (리드 결정 22)
    const until = new Date(Date.now() + 5 * DAY).toISOString();
    e.ctx.saveAi({ ...e.ctx.ai('claude'), usageLimitedUntil: until });
    const before = e.ctx.settings();
    const seq0 = e.ctx.store.activity.search({ limit: 1 })[0]!.seq;
    for (const bad of BAD) {
      const label = JSON.stringify(bad);
      expect(await codeOf(e.main('update_settings', { patch: { account: { authMode: bad } }, reason: '시험' })), `main ${label}`).toBe('invalid');
      expect(await codeOf(e.invoke('settings.update', { account: { authMode: bad as never } })), `desktop ${label}`).toBe('invalid');
      expect(await codeOf(e.internal('settings.update', { account: { authMode: bad as never } })), `operator ${label}`).toBe('invalid');
    }
    // 섞인 요청은 함께 온 맞는 값도 저장하지 않는다
    expect(await codeOf(e.main('update_settings', { patch: { execution: { maxConcurrent: 6 }, account: { authMode: { claude: 'api_key', codex: 'free' } } }, reason: '시험' }))).toBe('invalid');
    expect(e.ctx.settings()).toEqual(before);
    expect(e.ctx.ai('claude').usageLimitedUntil).toBe(until);
    const rows = e.ctx.store.activity.search({ limit: 500 }).filter((r) => r.seq > seq0);
    expect(rows.filter((r) => r.text.includes('운영 설정 변경') || r.text.includes('AI 인증 방식 변경'))).toEqual([]);
    // 거부 글이 받을 수 있는 값을 말한다
    const err = await e.main('update_settings', { patch: { account: { authMode: { claude: 'free' } } }, reason: '시험' }).catch((x: { message: string }) => x);
    expect((err as { message: string }).message).toContain('AI 인증 방식(account.authMode.claude) 문자열 "free" — subscription(구독)·api_key(API 키)만');
  });

  it('맞는 값은 두 길 모두 받는다 — 한쪽만 바꾸는 부분 갱신도 된다', async () => {
    env = await bootRestartable({ mock: false });
    const e = env;
    await e.main('update_settings', { patch: { account: { authMode: { claude: 'api_key' } } }, reason: '대표 명령: 결제를 API 키로' });
    expect(e.ctx.settings().account.authMode).toEqual({ claude: 'api_key', codex: 'subscription' });
    expect(await codeOf(e.invoke('settings.update', { account: { authMode: { codex: 'api_key' } } }))).toBe('ok');
    expect(e.ctx.settings().account.authMode).toEqual({ claude: 'api_key', codex: 'api_key' });
    expect(await codeOf(e.invoke('settings.update', { account: { authMode: { claude: 'subscription', codex: 'subscription' } } }))).toBe('ok');
    expect(e.ctx.settings().account.authMode).toEqual({ claude: 'subscription', codex: 'subscription' });
    expect(e.ctx.store.activity.search({ text: '운영 설정 변경', limit: 10 }).some((r) => r.actor === MAIN_AGENT_ID)).toBe(true);
    // 메인이 보는 도구 설명이 받는 값을 말한다
    expect(TOOL_SPECS.find((t) => t.name === 'update_settings')!.description).toContain('account.authMode(AI 종류별 "subscription"(구독)·"api_key"(API 키 방식)');
  });
});
