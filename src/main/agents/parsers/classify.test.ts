import { describe, expect, it } from 'vitest';
import { classifyErrorText, isPermissionPromptText, isTransientRetryText, parseResetAt, wallTimeToUtc } from './classify';

// 2026-10-27 12:00 서울 (= 03:00Z)
const NOON_KST = new Date('2026-10-27T03:00:00.000Z');
const SEOUL = { now: NOON_KST, timeZone: 'Asia/Seoul' };

describe('classifyErrorText — 사용량 한도', () => {
  it.each([
    ['Claude AI usage limit reached|1761580800', '2025-10-27T16:00:00.000Z'],
    ['5-hour limit reached ∙ resets 3pm', '2026-10-27T06:00:00.000Z'],
    ["You've hit your session limit · resets 3pm (Asia/Seoul)", '2026-10-27T06:00:00.000Z'],
    ["You've hit your weekly limit · resets Oct 30, 3pm (Asia/Seoul)", '2026-10-30T06:00:00.000Z'],
    ["You've hit your weekly limit · resets Oct 30 at 3:30pm", '2026-10-30T06:30:00.000Z'],
    ['You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at 3:15 PM.', '2026-10-27T06:15:00.000Z'],
    ['You’ve hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits or try again at Oct 30th, 2026 3:15 PM.', '2026-10-30T06:15:00.000Z'],
    ['You’ve hit your usage limit. Try again in 2 hours 13 minutes.', '2026-10-27T05:13:00.000Z'],
    ['spend limit reached (daily; resets 2026-08-08 00:00 UTC)', '2026-08-08T00:00:00.000Z'],
  ])('%s', (text, resetAt) => {
    expect(classifyErrorText(text, SEOUL)).toEqual({ kind: 'usage_limit', resetAt });
  });

  it('해제 시각이 없으면 resetAt 없이 사용량 한도 (호출자가 30분 적용)', () => {
    expect(classifyErrorText('You’ve hit your usage limit.', SEOUL)).toEqual({ kind: 'usage_limit' });
    expect(classifyErrorText('Your credit balance is too low to access the Anthropic API.', SEOUL)).toEqual({ kind: 'usage_limit' });
    expect(classifyErrorText('Your workspace is out of credits. Add credits to continue.', SEOUL)).toEqual({ kind: 'usage_limit' });
  });

  it('Claude assistant.error 코드가 rate_limit·billing_error면 문구와 무관하게 사용량 한도', () => {
    expect(classifyErrorText('API Error: Request rejected', { ...SEOUL, code: 'rate_limit' }).kind).toBe('usage_limit');
    expect(classifyErrorText('API Error', { ...SEOUL, code: 'billing_error' }).kind).toBe('usage_limit');
  });

  it('"not your usage limit"(서버 혼잡)은 사용량 한도가 아니다', () => {
    expect(classifyErrorText('Server is temporarily limiting requests (not your usage limit)', SEOUL).kind).toBe('other');
  });

  it('이미 지난 시각이면 다음 날, 괄호 안 시간대가 설정 시간대보다 우선', () => {
    const now = new Date('2026-10-27T07:00:00.000Z'); // 16:00 KST
    expect(classifyErrorText("You've hit your session limit · resets 3pm (Asia/Seoul)", { now, timeZone: 'UTC' }).resetAt).toBe('2026-10-28T06:00:00.000Z');
  });

  it('연도 없는 날짜가 지났으면 다음 해', () => {
    const now = new Date('2026-12-30T00:00:00.000Z');
    expect(parseResetAt('resets Jan 2, 3pm (UTC)', now)).toBe('2027-01-02T15:00:00.000Z');
  });

  it('일광 절약 시간 전환 전후를 각각 맞게 계산', () => {
    const now = new Date('2026-10-28T00:00:00.000Z');
    expect(parseResetAt('resets Oct 30, 3pm (America/New_York)', now)).toBe('2026-10-30T19:00:00.000Z'); // EDT
    expect(parseResetAt('resets Nov 2, 3pm (America/New_York)', now)).toBe('2026-11-02T20:00:00.000Z'); // EST
    expect(wallTimeToUtc(2026, 2, 8, 12, 0, 'America/New_York')).toBe(Date.parse('2026-03-08T16:00:00.000Z'));
  });

  it('알 수 없는 시간대 이름은 설정 시간대로 해석', () => {
    expect(parseResetAt('resets 3pm (Mars/Olympus)', NOON_KST, 'Asia/Seoul')).toBe('2026-10-27T06:00:00.000Z');
  });

  it('밀리초 epoch와 24시간 표기', () => {
    expect(parseResetAt('usage limit reached|1761580800000', NOON_KST)).toBe('2025-10-27T16:00:00.000Z');
    expect(parseResetAt('limit reached · resets 15:30', NOON_KST, 'Asia/Seoul')).toBe('2026-10-27T06:30:00.000Z');
  });
});

describe('classifyErrorText — 인증·권한·MCP·이어하기', () => {
  it.each([
    'Invalid API key · Please run /login',
    'Not logged in · Please run /login',
    'Not logged in',
    'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses',
    'Your access token could not be refreshed. Please log out and sign in again.',
    'OAuth token has expired. Please obtain a new token or refresh your existing token.',
    'Failed to refresh token: invalid_grant',
  ])('인증: %s', (text) => {
    expect(classifyErrorText(text, SEOUL)).toEqual({ kind: 'auth' });
  });

  it('Claude assistant.error=authentication_failed', () => {
    expect(classifyErrorText('API Error', { ...SEOUL, code: 'authentication_failed' }).kind).toBe('auth');
  });

  it.each([
    "Claude requested permissions to use Bash, but you haven't granted it yet.",
    'Permission to use Bash has been denied.',
    'Permission for this tool use was denied. It requires approval, and this session has no approval surface',
    'exec command rejected by user',
  ])('권한 확인: %s', (text) => {
    expect(classifyErrorText(text, SEOUL).kind).toBe('permission');
    expect(isPermissionPromptText(text)).toBe(true);
  });

  it('명령 출력의 "Permission denied"는 권한 확인이 아니다', () => {
    expect(classifyErrorText('cat: /root/secret: Permission denied', SEOUL).kind).toBe('other');
    expect(isPermissionPromptText('Access is denied.')).toBe(false);
  });

  it('앱 도구 서버 401은 CLI 인증 만료가 아니라 MCP 오류', () => {
    expect(classifyErrorText('MCP client for `wook` failed to start: handshaking with MCP server failed: 401 Unauthorized', SEOUL)).toEqual({ kind: 'mcp' });
  });

  it.each([
    'No conversation found with session ID: 8e46490a-3671-4cf9-99af-a3fe6aeba22f',
    'Error: thread/resume: thread/resume failed: no rollout found for thread id 79cbd8c2 (code -32600)',
    'No saved session found with ID 1234. Run `codex resume` without an ID to choose from existing sessions.',
  ])('이어하기 실패: %s', (text) => {
    expect(classifyErrorText(text, SEOUL)).toEqual({ kind: 'other', resumeFailed: true });
  });

  it('분류 안 되는 오류', () => {
    expect(classifyErrorText('API Error: 500 Internal server error', SEOUL)).toEqual({ kind: 'other' });
    expect(classifyErrorText('', SEOUL)).toEqual({ kind: 'other' });
  });

  it('Codex 재시도 안내는 일시적', () => {
    expect(isTransientRetryText('Reconnecting... 2/5 (unexpected status 401 Unauthorized: Missing bearer)')).toBe(true);
    expect(isTransientRetryText('Falling back from WebSockets to HTTPS transport. unexpected status 401')).toBe(true);
    expect(isTransientRetryText('unexpected status 401 Unauthorized')).toBe(false);
  });
});
