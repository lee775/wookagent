/**
 * 기기 세션의 HTTP 전송 (SERVER_DESIGN 3.4·3.5, 리드 결정 S3-4·S3-38): 쿠키 `__Host-wos_session`(HttpOnly·Secure·SameSite=Strict·Path=/)과 Bearer, 주소의
 * 토큰 거부, 쿠키를 실은 상태 변경의 `X-Wook-Client: 1`·허용 Origin, 호출자 열쇠, 같은 이름의 쿠키가 여럿일 때, 기록 가리기. 실제 서버와 함께 도는 쪽은
 * tests/server/sessionGate.test·cookieToss.test가 본다
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  allowedOrigins,
  appendSetCookie,
  carriesWookCookie,
  CLEAR_SESSION_COOKIE,
  clientKeyOf,
  cookieValues,
  fromWookScreen,
  isStateChange,
  LOGIN_COOKIE,
  loginClientKey,
  loginKeysOf,
  parseCookies,
  queryCarriesToken,
  readCredential,
  redactSessionTokens,
  SESSION_COOKIE,
  sessionCookie,
  setSessionCookie,
  tailscaleLoginOf,
} from './sessions';

const TOKEN = `wos_${'T'.repeat(43)}`;
const req = (headers: Record<string, string>, method = 'POST') => ({ headers, method }) as unknown as IncomingMessage;

function fakeResponse(): ServerResponse & { cookies(): string[] } {
  const headers = new Map<string, unknown>();
  return {
    getHeader: (n: string) => headers.get(n.toLowerCase()),
    setHeader: (n: string, v: unknown) => headers.set(n.toLowerCase(), v),
    cookies: () => (headers.get('set-cookie') as string[] | undefined) ?? [],
  } as unknown as ServerResponse & { cookies(): string[] };
}

describe('토큰을 읽는 곳 (S3-4)', () => {
  it('Authorization 머리가 있으면 그것만 본다 — Bearer(대소문자 무관)만 토큰, 다른 방식·빈 값은 토큰 없음(401감)', () => {
    expect(readCredential(req({ authorization: `Bearer ${TOKEN}` }))).toEqual({ kind: 'bearer', token: TOKEN });
    expect(readCredential(req({ authorization: `bearer ${TOKEN}` }))).toEqual({ kind: 'bearer', token: TOKEN });
    for (const bad of [TOKEN, `Basic ${TOKEN}`, `Bearer${TOKEN}`, 'Bearer', `Bearer ${TOKEN} x`]) {
      expect(readCredential(req({ authorization: bad })), bad.slice(0, 12)).toEqual({ kind: 'bearer', token: null });
    }
    // 머리가 있으면 쿠키는 보지 않는다
    expect(readCredential(req({ authorization: 'Basic x', cookie: `__Host-wos_session=${TOKEN}` }))).toEqual({ kind: 'bearer', token: null });
  });

  it('머리가 없으면 쿠키 __Host-wos_session, 둘 다 없으면 세션 없는 호출자', () => {
    expect(readCredential(req({ cookie: `a=1; __Host-wos_session=${TOKEN}; b=2` }))).toEqual({ kind: 'cookie', tokens: [TOKEN] });
    expect(readCredential(req({ cookie: '__Host-wos_login=abc' }))).toEqual({ kind: 'none' });
    expect(readCredential(req({ cookie: '__Host-wos_session=' }))).toEqual({ kind: 'none' });
    expect(readCredential(req({}))).toEqual({ kind: 'none' });
    expect(parseCookies(`x=1; wos_session=${TOKEN}; wos_session=second`).get('wos_session')).toBe(TOKEN);
  });

  it('주소에 실린 토큰은 이름이 무엇이든 알아본다 — 토큰 이름의 쿼리이거나 값이 세션 토큰 모양이면', () => {
    for (const q of [`?token=${TOKEN}`, `?access_token=x`, `?TOKEN=x`, `?session=x`, `?wos_session=x`, `?members=M-0001&x=${TOKEN}`]) {
      expect(queryCarriesToken(new URL(`http://h/api/events${q}`)), q.slice(0, 16)).toBe(true);
    }
    expect(queryCarriesToken(new URL('http://h/api/events?members=M-0001,M-MAIN'))).toBe(false);
  });

  it('wos_로 시작하기만 하는 값은 토큰이 아니다 — 세션 토큰과 꼭 같은 모양(wos_ + base64url 43자)만 거부한다 (리드 결정 S3-24)', () => {
    const q = (v: string) => queryCarriesToken(new URL(`http://h/api/uploads?name=${encodeURIComponent(v)}`));
    expect([q('wos_notes.txt'), q('wos_'), q(`wos_${'T'.repeat(42)}`), q(`wos_${'T'.repeat(44)}`), q(`${TOKEN}.txt`), q(TOKEN), q(`wos_${'a-_Z'.repeat(10)}xyz`)]).toEqual([
      false,
      false,
      false,
      false,
      false,
      true,
      true,
    ]);
  });
});

describe('세션 쿠키 (S3-4)', () => {
  it('HttpOnly·Secure·SameSite=Strict·Path=/ 이고 Max-Age는 세션의 최대 만료까지 — 지우는 쿠키는 Max-Age=0', () => {
    expect(sessionCookie(TOKEN, 3600.9)).toBe(`__Host-wos_session=${TOKEN}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=3600`);
    expect(CLEAR_SESSION_COOKIE).toBe('__Host-wos_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0');
    const res = fakeResponse();
    setSessionCookie(res, { token: TOKEN, absoluteExpiresAt: '2026-10-30T01:00:00.000Z' }, Date.parse('2026-10-30T00:00:00.000Z'));
    expect(res.cookies()).toEqual([`__Host-wos_session=${TOKEN}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=3600`]);
  });

  it('같은 응답에서 끝난 쿠키를 지운 뒤 새 세션을 주면 새 것 하나만 남는다 — 다른 이름의 쿠키는 그대로', () => {
    const res = fakeResponse();
    appendSetCookie(res, '__Host-wos_login=abc; Path=/');
    appendSetCookie(res, CLEAR_SESSION_COOKIE);
    setSessionCookie(res, { token: TOKEN, absoluteExpiresAt: '2026-10-30T01:00:00.000Z' }, Date.parse('2026-10-30T00:00:00.000Z'));
    expect(res.cookies()).toEqual(['__Host-wos_login=abc; Path=/', `__Host-wos_session=${TOKEN}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=3600`]);
  });
});

describe('쿠키를 실은 상태 변경 (S3-4·S3-7)', () => {
  const origins = allowedOrigins(7317, 'https://grok-pc.tailnet.ts.net/');

  it('받는 Origin은 서버 포트의 루프백 주소 셋과 공개 주소다 (모양이 틀린 공개 주소는 넓히지 않는다)', () => {
    expect([...origins].sort()).toEqual(['http://127.0.0.1:7317', 'http://[::1]:7317', 'http://localhost:7317', 'https://grok-pc.tailnet.ts.net'].sort());
    expect([...allowedOrigins(7317, 'not a url')].sort()).toEqual(['http://127.0.0.1:7317', 'http://[::1]:7317', 'http://localhost:7317'].sort());
  });

  it('X-Wook-Client: 1과 허용 Origin이 둘 다 있어야 욱채 화면의 요청이다', () => {
    expect(fromWookScreen(req({ 'x-wook-client': '1', origin: 'http://127.0.0.1:7317' }), origins)).toBe(true);
    expect(fromWookScreen(req({ 'x-wook-client': '1', origin: 'https://GROK-PC.tailnet.ts.net' }), origins)).toBe(true);
    for (const [label, h] of [
      ['머리 없음', { origin: 'http://127.0.0.1:7317' }],
      ['머리 값 틀림', { 'x-wook-client': 'true', origin: 'http://127.0.0.1:7317' }],
      ['Origin 없음', { 'x-wook-client': '1' }],
      ['다른 Origin', { 'x-wook-client': '1', origin: 'https://evil.example' }],
      ['다른 포트', { 'x-wook-client': '1', origin: 'http://127.0.0.1:7318' }],
      ['null Origin', { 'x-wook-client': '1', origin: 'null' }],
    ] as const) {
      expect(fromWookScreen(req(h), origins), label).toBe(false);
    }
  });

  it('상태 변경은 GET·HEAD 밖의 메서드, 욱채 쿠키는 wos_로 시작하는 쿠키', () => {
    expect(['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'].every(isStateChange)).toBe(true);
    expect(['GET', 'HEAD'].some(isStateChange)).toBe(false);
    expect(carriesWookCookie(req({ cookie: 'wos_login=x' }))).toBe(true);
    expect(carriesWookCookie(req({ cookie: 'other=wos_x' }))).toBe(false);
  });
});

describe('호출자 열쇠와 기록 가리기', () => {
  it('세션이 있으면 그 세션, 없으면 로그인 전 쿠키의 해시, 그다음 Tailscale 사용자, 그다음 anonymous — 쿠키 값은 그대로 들어가지 않는다', () => {
    expect(clientKeyOf(req({ cookie: '__Host-wos_login=비밀값' }), { id: 'ds_1' })).toBe('session:ds_1');
    const login = clientKeyOf(req({ cookie: '__Host-wos_login=비밀값', 'tailscale-user-login': 'a@b' }), null);
    expect(login).toMatch(/^login:[0-9a-f]{32}$/);
    expect(login.includes('비밀값')).toBe(false);
    expect(clientKeyOf(req({ 'tailscale-user-login': ' owner@github ' }), null)).toBe('tailscale:owner@github');
    expect(clientKeyOf(req({}), null)).toBe('anonymous');
    expect(tailscaleLoginOf(req({ 'tailscale-user-login': '   ' }))).toBeNull();
  });

  it('기록에 섞인 세션 토큰은 가린다 (2단계 모양 wos_test_…도)', () => {
    const out = redactSessionTokens(`Cookie: wos_session=${TOKEN}; Authorization: Bearer wos_test_${'Q'.repeat(43)} 끝`);
    expect(out).toBe('Cookie: wos_session=wos_[가림]; Authorization: Bearer wos_[가림] 끝');
  });
});

describe('같은 이름의 쿠키가 여럿 — 한 tailnet의 형제 기계가 던진 쿠키 (리드 결정 S3-38)', () => {
  const JUNK = `wos_${'A'.repeat(43)}`;

  it('두 쿠키 이름은 __Host-로 시작한다 — 브라우저는 Domain을 붙인 그 이름의 쿠키를 받지 않는다', () => {
    expect([SESSION_COOKIE, LOGIN_COOKIE]).toEqual(['__Host-wos_session', '__Host-wos_login']);
  });

  it('값을 온 차례대로 모두 읽는다 — 빈 값은 빼고, 세션은 그 값들을 모두 넘긴다. 예전 이름 wos_session은 자격으로 읽지 않는다', () => {
    const header = `__Host-wos_session=${JUNK}; x=1; __Host-wos_session=; __Host-wos_session=${TOKEN}`;
    expect(cookieValues(header, '__Host-wos_session')).toEqual([JUNK, TOKEN]);
    expect(cookieValues([`__Host-wos_session=${JUNK}`, `__Host-wos_session=${TOKEN}`], '__Host-wos_session')).toEqual([JUNK, TOKEN]);
    expect(readCredential(req({ cookie: header }))).toEqual({ kind: 'cookie', tokens: [JUNK, TOKEN] });
    expect(readCredential(req({ cookie: `wos_session=${TOKEN}` }))).toEqual({ kind: 'none' });
    expect(readCredential(req({ cookie: `wos_session=${TOKEN}; __Host-wos_session=${JUNK}` }))).toEqual({ kind: 'cookie', tokens: [JUNK] });
  });

  it('로그인 전 쿠키도 값마다 열쇠를 낸다 — 호출자 열쇠는 첫 값, 같은 값은 한 번만', () => {
    const r = req({ cookie: '__Host-wos_login=던진값; __Host-wos_login=내값; __Host-wos_login=내값' });
    expect(loginKeysOf(r)).toEqual([loginClientKey('던진값'), loginClientKey('내값')]);
    expect(clientKeyOf(r, null)).toBe(loginClientKey('던진값'));
    expect(loginKeysOf(req({ cookie: 'wos_login=예전이름' }))).toEqual([]);
    expect(loginKeysOf(req({}))).toEqual([]);
  });

  it('CSRF 막기는 새 이름과 예전 이름의 욱채 쿠키를 모두 브라우저 쿠키로 친다', () => {
    expect(carriesWookCookie(req({ cookie: '__Host-wos_login=x' }))).toBe(true);
    expect(carriesWookCookie(req({ cookie: '__Host-wos_session=x' }))).toBe(true);
    expect(carriesWookCookie(req({ cookie: 'wos_session=x' }))).toBe(true);
    expect(carriesWookCookie(req({ cookie: '__Host-other=wos_x' }))).toBe(false);
  });

  it('주소에 든 토큰 거부는 예전 이름과 새 이름을 모두 막는다 (대소문자 무관)', () => {
    for (const q of ['?wos_session=x', '?__Host-wos_session=x', '?__HOST-WOS_SESSION=x']) {
      expect(queryCarriesToken(new URL(`http://h/api/events${q}`)), q).toBe(true);
    }
  });
});
