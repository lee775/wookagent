import http from 'node:http';
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { GoogleLoginError, type GoogleProfile } from './types';
import { GOOGLE_AUTH_ENDPOINT, GOOGLE_JWKS_URI, GOOGLE_TOKEN_ENDPOINT, LOGIN_SUCCESS_MESSAGE, googleLogin, type GoogleLoginRunOptions } from './googleAuth';

const CLIENT_ID = '1234567890-test.apps.googleusercontent.com';
const KID = 'test-kid-1';

let privateKey: KeyObject;
let otherPrivateKey: KeyObject;
let jwk: Record<string, unknown>;

beforeAll(() => {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  privateKey = pair.privateKey;
  jwk = { ...(pair.publicKey.export({ format: 'jwk' }) as Record<string, unknown>), kid: KID, alg: 'RS256', use: 'sig' };
  otherPrivateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
});

const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');

function signToken(claims: Record<string, unknown>, opts: { key?: KeyObject; header?: Record<string, unknown> } = {}): string {
  const header = opts.header ?? { alg: 'RS256', kid: KID, typ: 'JWT' };
  const data = `${b64(header)}.${b64(claims)}`;
  const sig = header.alg === 'none' ? '' : sign('sha256', Buffer.from(data), opts.key ?? privateKey).toString('base64url');
  return `${data}.${sig}`;
}

interface AuthParams {
  url: URL;
  state: string;
  nonce: string;
  redirectUri: string;
  challenge: string;
}

function parseAuthUrl(raw: string): AuthParams {
  const url = new URL(raw);
  const q = url.searchParams;
  return { url, state: q.get('state')!, nonce: q.get('nonce')!, redirectUri: q.get('redirect_uri')!, challenge: q.get('code_challenge')! };
}

interface Scenario {
  /** id_token 내용 바꾸기 (기본: 올바른 토큰) */
  claims?: (auth: AuthParams, nowSec: number) => Record<string, unknown>;
  tokenOptions?: { key?: KeyObject; header?: Record<string, unknown> };
  /** 브라우저가 콜백에 붙일 쿼리 (기본: code + state) */
  callbackQuery?: (auth: AuthParams) => string;
  /** 콜백 전에 보낼 다른 요청들 */
  before?: (auth: AuthParams) => Promise<void>;
  tokenResponse?: { status: number; body: unknown };
  browser?: false;
  options?: Partial<GoogleLoginRunOptions>;
}

interface Run {
  result: Promise<GoogleProfile>;
  auth: Promise<AuthParams>;
  page: Promise<{ status: number; text: string } | null>;
  tokenRequests: URLSearchParams[];
}

function run(sc: Scenario = {}): Run {
  const tokenRequests: URLSearchParams[] = [];
  let authResolve!: (a: AuthParams) => void;
  const auth = new Promise<AuthParams>((r) => (authResolve = r));
  let current: AuthParams | null = null;

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === GOOGLE_TOKEN_ENDPOINT) {
      const body = new URLSearchParams(String(init?.body ?? ''));
      tokenRequests.push(body);
      if (sc.tokenResponse) return new Response(JSON.stringify(sc.tokenResponse.body), { status: sc.tokenResponse.status });
      const nowSec = Math.floor(Date.now() / 1000);
      const claims = sc.claims
        ? sc.claims(current!, nowSec)
        : {
            iss: 'https://accounts.google.com',
            aud: CLIENT_ID,
            azp: CLIENT_ID,
            sub: '109876543210',
            email: 'owner@example.com',
            email_verified: true,
            name: '김대표',
            nonce: current!.nonce,
            iat: nowSec,
            exp: nowSec + 3600,
          };
      return new Response(JSON.stringify({ access_token: 'at', expires_in: 3599, id_token: signToken(claims, sc.tokenOptions), token_type: 'Bearer' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url === GOOGLE_JWKS_URI) return new Response(JSON.stringify({ keys: [{ kty: 'RSA', kid: 'other', n: 'AQAB', e: 'AQAB' }, jwk] }), { status: 200 });
    throw new Error(`예상하지 않은 요청: ${url}`);
  }) as typeof fetch;

  const page = auth.then(async (a) => {
    if (sc.browser === false) return null;
    await sc.before?.(a);
    const query = sc.callbackQuery ? sc.callbackQuery(a) : `code=4%2F0AbCdEf&state=${encodeURIComponent(a.state)}&scope=openid`;
    const res = await fetch(`${a.redirectUri}?${query}`);
    return { status: res.status, text: await res.text() };
  });

  const result = googleLogin({
    clientId: CLIENT_ID,
    clientSecret: 'GOCSPX-test-secret',
    openExternal: async () => undefined,
    fetchImpl,
    onAuthUrl: (u) => {
      current = parseAuthUrl(u);
      authResolve(current);
    },
    ...sc.options,
  });
  return { result, auth, page, tokenRequests };
}

async function expectClosed(redirectUri: string): Promise<void> {
  await expect(fetch(redirectUri)).rejects.toThrow();
}

async function expectLoginError(r: Run, code: GoogleLoginError['code']): Promise<GoogleLoginError> {
  const err = await r.result.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(GoogleLoginError);
  expect((err as GoogleLoginError).code).toBe(code);
  expect((err as GoogleLoginError).message).toMatch(/[가-힣]/);
  await expectClosed((await r.auth).redirectUri);
  return err as GoogleLoginError;
}

function rawRequest(port: number, reqPath: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: reqPath, method: 'GET', headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('googleLogin', () => {
  it('성공: PKCE·state·nonce로 로그인하고 프로필을 돌려준 뒤 임시 서버를 닫는다', async () => {
    const r = run();
    const profile = await r.result;
    expect(profile).toEqual({ sub: '109876543210', email: 'owner@example.com', emailVerified: true, name: '김대표' });

    const a = await r.auth;
    expect(`${a.url.origin}${a.url.pathname}`).toBe(GOOGLE_AUTH_ENDPOINT);
    const q = a.url.searchParams;
    expect(q.get('client_id')).toBe(CLIENT_ID);
    expect(q.get('response_type')).toBe('code');
    expect(q.get('scope')).toBe('openid email profile');
    expect(q.get('prompt')).toBe('select_account');
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(a.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(a.state.length).toBeGreaterThanOrEqual(32);
    expect(a.nonce.length).toBeGreaterThanOrEqual(32);
    expect(a.state).not.toBe(a.nonce);

    expect(r.tokenRequests).toHaveLength(1);
    const body = r.tokenRequests[0]!;
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('4/0AbCdEf');
    expect(body.get('client_id')).toBe(CLIENT_ID);
    expect(body.get('client_secret')).toBe('GOCSPX-test-secret');
    expect(body.get('redirect_uri')).toBe(a.redirectUri);
    const verifier = body.get('code_verifier')!;
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(a.challenge);

    const page = await r.page;
    expect(page?.status).toBe(200);
    expect(page?.text).toContain(LOGIN_SUCCESS_MESSAGE);
    await expectClosed(a.redirectUri);
  });

  it('client_secret이 없으면 보내지 않는다', async () => {
    const r = run({ options: { clientSecret: null } });
    await r.result;
    expect(r.tokenRequests[0]!.has('client_secret')).toBe(false);
  });

  it('state가 다르면 state_mismatch', async () => {
    const r = run({ callbackQuery: () => 'code=abc&state=forged-state-value' });
    await expectLoginError(r, 'state_mismatch');
    expect((await r.page)?.status).toBe(400);
    expect(r.tokenRequests).toHaveLength(0);
  });

  it('사용자가 거부하면 denied', async () => {
    const r = run({ callbackQuery: (a) => `error=access_denied&state=${encodeURIComponent(a.state)}` });
    await expectLoginError(r, 'denied');
    const page = await r.page;
    expect(page?.text).toContain('거부');
  });

  it('대상(aud)이 다르면 invalid_token', async () => {
    const r = run({
      claims: (a, now) => ({ iss: 'accounts.google.com', aud: 'other-client', sub: '1', email: 'o@e.com', email_verified: true, nonce: a.nonce, exp: now + 600 }),
    });
    await expectLoginError(r, 'invalid_token');
  });

  it('만료된 토큰은 invalid_token, 허용 오차(60초) 안은 통과', async () => {
    const expired = run({
      claims: (a, now) => ({ iss: 'accounts.google.com', aud: CLIENT_ID, sub: '1', email: 'o@e.com', email_verified: true, nonce: a.nonce, exp: now - 120 }),
    });
    const err = await expectLoginError(expired, 'invalid_token');
    expect(err.message).toContain('만료');

    const withinSkew = run({
      claims: (a, now) => ({ iss: 'accounts.google.com', aud: CLIENT_ID, sub: '1', email: 'o@e.com', email_verified: 'true', nonce: a.nonce, exp: now - 30 }),
    });
    await expect(withinSkew.result).resolves.toMatchObject({ sub: '1', emailVerified: true, name: 'o' });
  });

  it('이메일 미인증 계정은 email_unverified', async () => {
    const r = run({
      claims: (a, now) => ({ iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: '1', email: 'o@e.com', email_verified: false, nonce: a.nonce, exp: now + 600 }),
    });
    await expectLoginError(r, 'email_unverified');
  });

  it('다른 키로 서명·nonce 불일치·alg none·다른 발급자는 invalid_token', async () => {
    const good = (a: AuthParams, now: number) => ({ iss: 'accounts.google.com', aud: CLIENT_ID, sub: '1', email: 'o@e.com', email_verified: true, nonce: a.nonce, exp: now + 600 });
    await expectLoginError(run({ claims: good, tokenOptions: { key: otherPrivateKey } }), 'invalid_token');
    await expectLoginError(run({ claims: (a, now) => ({ ...good(a, now), nonce: 'replayed-nonce' }) }), 'invalid_token');
    await expectLoginError(run({ claims: good, tokenOptions: { header: { alg: 'none', kid: KID } } }), 'invalid_token');
    await expectLoginError(run({ claims: (a, now) => ({ ...good(a, now), iss: 'https://evil.example' }) }), 'invalid_token');
    await expectLoginError(run({ claims: good, tokenOptions: { header: { alg: 'RS256', kid: 'unknown-kid' } } }), 'invalid_token');
  });

  it('토큰 교환이 실패하면 token_exchange (토큰·코드는 메시지에 넣지 않음)', async () => {
    const r = run({ tokenResponse: { status: 400, body: { error: 'invalid_grant', error_description: 'Bad Request' } } });
    const err = await expectLoginError(r, 'token_exchange');
    expect(err.message).toContain('invalid_grant');
    expect(err.message).not.toContain('4/0AbCdEf');
  });

  it('제한 시간이 지나면 timeout', async () => {
    const r = run({ browser: false, options: { timeoutMs: 150 } });
    const err = await expectLoginError(r, 'timeout');
    expect(err.message).toContain('제한 시간');
  });

  it('취소 신호를 받으면 cancelled', async () => {
    const ac = new AbortController();
    const r = run({ browser: false, options: { signal: ac.signal } });
    await r.auth;
    ac.abort();
    await expectLoginError(r, 'cancelled');
  });

  it('로그인 결과가 아닌 요청(파비콘, 다른 Host, 빈 콜백)은 무시하고 계속 기다린다', async () => {
    const statuses: number[] = [];
    const r = run({
      before: async (a) => {
        const port = Number(new URL(a.redirectUri).port);
        statuses.push((await fetch(`http://127.0.0.1:${port}/favicon.ico`)).status);
        statuses.push(await rawRequest(port, `/callback?code=x&state=${encodeURIComponent(a.state)}`, { Host: `evil.example:${port}` }));
        statuses.push((await fetch(a.redirectUri)).status);
      },
    });
    await expect(r.result).resolves.toMatchObject({ email: 'owner@example.com' });
    expect(statuses).toEqual([404, 400, 400]);
    expect(r.tokenRequests).toHaveLength(1);
  });

  it('브라우저를 열지 못하면 한국어 오류로 끝나고 임시 서버를 닫는다', async () => {
    let redirect = '';
    const err = await googleLogin({
      clientId: CLIENT_ID,
      clientSecret: null,
      onAuthUrl: (u) => (redirect = new URL(u).searchParams.get('redirect_uri')!),
      openExternal: () => {
        throw new Error('no browser');
      },
      fetchImpl: (async () => new Response('{}')) as typeof fetch,
    }).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('브라우저를 열지 못해');
    await expectClosed(redirect);
  });

  it('클라이언트 ID가 없으면 시작하지 않는다', async () => {
    await expect(googleLogin({ clientId: '  ', clientSecret: null, openExternal: async () => undefined })).rejects.toThrow('클라이언트 ID');
  });
});
