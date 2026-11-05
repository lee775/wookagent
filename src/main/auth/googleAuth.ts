/**
 * 구글 로그인 (15.1 AUTH-01·05, ENV-02).
 * 시스템 기본 브라우저 + 루프백 임시 주소(127.0.0.1:<임의 포트>/callback) + PKCE(S256) + state·nonce.
 * 받은 id_token은 구글 공개 키(JWKS)로 RS256 서명을 확인하고 iss·aud·azp·exp·nonce·email_verified를 검사한다.
 * 토큰·인증 코드는 기록하거나 오류 메시지에 넣지 않는다.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify as verifySignature } from 'node:crypto';
import { GoogleLoginError, type GoogleLoginOptions, type GoogleProfile } from './types';

export const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
export const GOOGLE_JWKS_URI = 'https://www.googleapis.com/oauth2/v3/certs';
export const LOGIN_SUCCESS_MESSAGE = '로그인되었습니다. 이 창을 닫고 욱채로 돌아가세요.';

const GOOGLE_ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);
const CALLBACK_PATH = '/callback';
const CLOCK_SKEW_SEC = 60;
const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 30_000;

/** 계약(GoogleLoginOptions)에 더한 선택 항목 */
export interface GoogleLoginRunOptions extends GoogleLoginOptions {
  /** 대표가 로그인 진행 중 [취소]를 누르면 abort — GoogleLoginError('cancelled') */
  signal?: AbortSignal;
  /** 토큰 만료 검사용 현재 시각(ms). 테스트에서 주입 */
  now?: () => number;
}

// ───────────────────────── 도우미 ─────────────────────────

const b64url = (buf: Buffer): string => buf.toString('base64url');
const BASE64URL_RE = /^[A-Za-z0-9_-]*$/;

function loginError(code: GoogleLoginError['code'], message: string, cause?: unknown): GoogleLoginError {
  const err = new GoogleLoginError(code, message);
  if (cause !== undefined) Object.defineProperty(err, 'cause', { value: cause, enumerable: false, writable: true, configurable: true });
  return err;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function decodeJsonSegment(seg: string, what: string): Record<string, unknown> {
  if (seg.length === 0 || !BASE64URL_RE.test(seg)) throw loginError('invalid_token', `ID 토큰의 ${what} 형식이 올바르지 않습니다`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(seg, 'base64url').toString('utf8'));
  } catch (err) {
    throw loginError('invalid_token', `ID 토큰의 ${what}를 해석할 수 없습니다`, err);
  }
  if (!isRecord(parsed)) throw loginError('invalid_token', `ID 토큰의 ${what}가 객체가 아닙니다`);
  return parsed;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function resultPage(ok: boolean, message: string): string {
  const heading = ok ? '욱채 로그인 완료' : '로그인하지 못했습니다';
  return [
    '<!doctype html>',
    '<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>욱채 로그인</title>',
    '<style>',
    "body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f5f6f8;color:#1f2430;font-family:'Pretendard','Malgun Gothic','Apple SD Gothic Neo',system-ui,sans-serif}",
    'main{background:#fff;border-radius:16px;padding:32px 40px;max-width:440px;box-shadow:0 6px 28px rgba(15,23,42,.08);text-align:center}',
    'h1{margin:0 0 12px;font-size:20px}p{margin:0;line-height:1.7;color:#4b5363}.ok{color:#15803d}.fail{color:#c62828}',
    '@media (prefers-color-scheme: dark){body{background:#14161b;color:#e7e9ee}main{background:#1d2027;box-shadow:none}p{color:#b6bcc8}}',
    '</style></head>',
    `<body><main><h1 class="${ok ? 'ok' : 'fail'}">${escapeHtml(heading)}</h1><p>${escapeHtml(message)}</p></main></body></html>`,
  ].join('');
}

const PAGE_HEADERS: http.OutgoingHttpHeaders = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  Connection: 'close',
};

function sendPage(res: http.ServerResponse, status: number, ok: boolean, message: string): void {
  const body = resultPage(ok, message);
  res.writeHead(status, { ...PAGE_HEADERS, 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

// ───────────────────────── 구글 서버 호출 ─────────────────────────

export interface FetchContext {
  fetchImpl: typeof fetch;
  signal: AbortSignal;
  /** 구글 공개 키 주소 (기본 GOOGLE_JWKS_URI) — 기기 코드 로그인 시험이 가짜 구글 서버로 바꾼다 (googleDevice.ts, S3-5) */
  jwksUri?: string;
}

async function fetchJson(ctx: FetchContext, url: string, init: RequestInit, what: string): Promise<{ status: number; ok: boolean; json: unknown }> {
  let res: Response;
  try {
    res = await ctx.fetchImpl(url, { ...init, signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]) });
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    throw loginError('token_exchange', `${what}에 연결하지 못했습니다. 인터넷 연결을 확인하세요.`, err);
  }
  const text = await res.text();
  let json: unknown = null;
  if (text.length > 0) {
    try {
      json = JSON.parse(text);
    } catch (err) {
      if (res.ok) throw loginError('token_exchange', `${what}의 응답을 해석할 수 없습니다 (HTTP ${res.status})`, err);
      // 실패 응답 본문이 JSON이 아니면 상태 코드만으로 알린다
    }
  }
  return { status: res.status, ok: res.ok, json };
}

async function exchangeCode(
  ctx: FetchContext,
  p: { clientId: string; clientSecret: string | null; code: string; verifier: string; redirectUri: string },
): Promise<string> {
  const body = new URLSearchParams({
    client_id: p.clientId,
    code: p.code,
    code_verifier: p.verifier,
    grant_type: 'authorization_code',
    redirect_uri: p.redirectUri,
  });
  if (p.clientSecret) body.set('client_secret', p.clientSecret);
  const r = await fetchJson(
    ctx,
    GOOGLE_TOKEN_ENDPOINT,
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: body.toString() },
    '구글 토큰 서버',
  );
  if (!r.ok) {
    const code = isRecord(r.json) && typeof r.json.error === 'string' ? r.json.error.slice(0, 64) : null;
    const desc = isRecord(r.json) && typeof r.json.error_description === 'string' ? r.json.error_description.slice(0, 160) : null;
    throw loginError('token_exchange', `구글 토큰 교환에 실패했습니다 (HTTP ${r.status}${code ? `, ${code}` : ''}${desc ? `: ${desc}` : ''})`);
  }
  const idToken = isRecord(r.json) ? r.json.id_token : undefined;
  if (typeof idToken !== 'string' || idToken.length === 0) throw loginError('invalid_token', '구글 응답에 ID 토큰이 없습니다');
  return idToken;
}

interface Jwk {
  kty: string;
  kid?: string;
  n?: string;
  e?: string;
  alg?: string;
  use?: string;
}

async function fetchJwks(ctx: FetchContext): Promise<Jwk[]> {
  const r = await fetchJson(ctx, ctx.jwksUri ?? GOOGLE_JWKS_URI, { method: 'GET', headers: { Accept: 'application/json' } }, '구글 공개 키 서버');
  if (!r.ok) throw loginError('token_exchange', `구글 공개 키를 가져오지 못했습니다 (HTTP ${r.status})`);
  if (!isRecord(r.json) || !Array.isArray(r.json.keys)) throw loginError('token_exchange', '구글 공개 키 응답 형식이 올바르지 않습니다');
  return r.json.keys.filter((k): k is Jwk => isRecord(k) && typeof k.kty === 'string');
}

/**
 * id_token 서명·내용 확인 → 대표 프로필. nonce: 데스크톱(루프백) 로그인의 nonce. 기기 코드 로그인에는 nonce가 없어 null을 넘긴다 — 토큰이 리다이렉트 없이
 * 서버와 구글 사이의 TLS로 바로 온다 (SERVER_DESIGN 3.5, googleDevice.ts)
 */
export async function verifyIdToken(ctx: FetchContext, idToken: string, expect: { clientId: string; nonce: string | null; nowMs: number }): Promise<GoogleProfile> {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw loginError('invalid_token', 'ID 토큰 형식이 올바르지 않습니다');
  const [h, p, s] = parts as [string, string, string];
  const header = decodeJsonSegment(h, '머리');
  const claims = decodeJsonSegment(p, '내용');
  if (header.alg !== 'RS256') throw loginError('invalid_token', `지원하지 않는 ID 토큰 서명 방식입니다: ${String(header.alg)}`);
  if (typeof header.kid !== 'string' || header.kid.length === 0) throw loginError('invalid_token', 'ID 토큰에 서명 키 정보가 없습니다');
  if (s.length === 0 || !BASE64URL_RE.test(s)) throw loginError('invalid_token', 'ID 토큰 서명 형식이 올바르지 않습니다');

  const jwk = (await fetchJwks(ctx)).find((k) => k.kid === header.kid);
  if (!jwk || jwk.kty !== 'RSA' || typeof jwk.n !== 'string' || typeof jwk.e !== 'string') {
    throw loginError('invalid_token', 'ID 토큰을 서명한 구글 공개 키를 찾지 못했습니다');
  }
  if ((jwk.use !== undefined && jwk.use !== 'sig') || (jwk.alg !== undefined && jwk.alg !== 'RS256')) {
    throw loginError('invalid_token', '구글 공개 키의 용도가 서명 확인이 아닙니다');
  }
  let key;
  try {
    key = createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' });
  } catch (err) {
    throw loginError('invalid_token', '구글 공개 키를 읽을 수 없습니다', err);
  }
  const signedOk = verifySignature('sha256', Buffer.from(`${h}.${p}`, 'utf8'), key, Buffer.from(s, 'base64url'));
  if (!signedOk) throw loginError('invalid_token', 'ID 토큰 서명이 올바르지 않습니다');

  if (typeof claims.iss !== 'string' || !GOOGLE_ISSUERS.has(claims.iss)) throw loginError('invalid_token', 'ID 토큰 발급자가 구글이 아닙니다');
  const aud = claims.aud;
  const audOk = typeof aud === 'string' ? aud === expect.clientId : Array.isArray(aud) && aud.includes(expect.clientId);
  if (!audOk) throw loginError('invalid_token', '이 프로그램에 발급된 ID 토큰이 아닙니다 (대상 불일치)');
  if ((Array.isArray(aud) || claims.azp !== undefined) && claims.azp !== expect.clientId) {
    throw loginError('invalid_token', '이 프로그램에 발급된 ID 토큰이 아닙니다 (요청자 불일치)');
  }
  if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)) throw loginError('invalid_token', 'ID 토큰에 만료 시각이 없습니다');
  if (expect.nowMs / 1000 > claims.exp + CLOCK_SKEW_SEC) {
    throw loginError('invalid_token', 'ID 토큰이 만료되었습니다. PC 시계가 맞는지 확인하고 다시 로그인하세요.');
  }
  if (expect.nonce !== null && (typeof claims.nonce !== 'string' || !safeEqual(claims.nonce, expect.nonce))) {
    throw loginError('invalid_token', 'ID 토큰이 이 로그인 요청의 것이 아닙니다 (nonce 불일치)');
  }
  if (typeof claims.sub !== 'string' || claims.sub.length === 0) throw loginError('invalid_token', 'ID 토큰에 계정 ID가 없습니다');
  if (typeof claims.email !== 'string' || claims.email.length === 0) throw loginError('invalid_token', 'ID 토큰에 이메일이 없습니다');
  if (claims.email_verified !== true && claims.email_verified !== 'true') {
    throw loginError('email_unverified', '이메일 인증이 끝나지 않은 구글 계정입니다. 구글 계정에서 이메일을 인증한 뒤 다시 로그인하세요.');
  }
  const given = typeof claims.given_name === 'string' ? claims.given_name : '';
  const family = typeof claims.family_name === 'string' ? claims.family_name : '';
  const name = (typeof claims.name === 'string' && claims.name.trim()) || [given, family].filter(Boolean).join(' ').trim() || claims.email.split('@')[0]!;
  return { sub: claims.sub, email: claims.email, emailVerified: true, name };
}

// ───────────────────────── 로그인 ─────────────────────────

function listenLoopback(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => reject(new Error(`로그인용 임시 주소(127.0.0.1)를 열지 못했습니다: ${err.message}`, { cause: err }));
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
    // 결과 응답은 이미 보냈다 — 브라우저가 붙잡고 있는 연결 때문에 닫기가 늦어지지 않게 끊는다
    server.closeAllConnections();
  });
}

/**
 * 시스템 브라우저로 구글 로그인을 진행하고 확인된 프로필을 돌려준다.
 * 실패하면 GoogleLoginError(code), 설정·환경 문제(클라이언트 ID 없음, 임시 주소·브라우저 열기 실패)는 Error.
 * 어떤 경우든 임시 서버를 닫은 뒤에 끝난다.
 */
export async function googleLogin(opts: GoogleLoginRunOptions): Promise<GoogleProfile> {
  const clientId = (opts.clientId ?? '').trim();
  if (clientId.length === 0) throw new Error('구글 로그인 설정이 없습니다. 운영 설정 > 계정에서 구글 클라이언트 ID를 입력하세요.');
  if (typeof opts.openExternal !== 'function') throw new Error('브라우저 열기 기능이 연결되지 않았습니다');
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('이 환경에는 fetch가 없습니다');
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error(`로그인 제한 시간이 올바르지 않습니다: ${String(timeoutMs)}`);
  const now = opts.now ?? Date.now;
  if (opts.signal?.aborted) throw loginError('cancelled', '로그인을 취소했습니다');

  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const state = b64url(randomBytes(24));
  const nonce = b64url(randomBytes(24));
  const internal = new AbortController();
  const ctx: FetchContext = { fetchImpl, signal: internal.signal };

  const server = http.createServer();
  const port = await listenLoopback(server);
  const host = `127.0.0.1:${port}`;
  const redirectUri = `http://${host}${CALLBACK_PATH}`;
  const authUrl = new URL(GOOGLE_AUTH_ENDPOINT);
  authUrl.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    nonce,
    prompt: 'select_account',
  }).toString();

  return new Promise<GoogleProfile>((resolve, reject) => {
    let settled = false;
    let handling = false;
    let stopReason: GoogleLoginError | null = null;

    const finish = (err: Error | null, profile: GoogleProfile | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      internal.abort();
      void closeServer(server).then(() => (err ? reject(err) : resolve(profile!)));
    };
    const stop = (err: GoogleLoginError): void => {
      stopReason = err;
      // 처리 중인 콜백이 있어도 기다리지 않는다 — 진행 중인 구글 요청은 internal.abort()로 끊는다
      finish(err, null);
    };
    const onAbort = (): void => stop(loginError('cancelled', '로그인을 취소했습니다'));
    const timer = setTimeout(
      () => stop(loginError('timeout', `로그인 제한 시간(${Math.round(timeoutMs / 1000)}초)이 지났습니다. 다시 시도하세요.`)),
      timeoutMs,
    );
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    server.on('error', (err) => finish(new Error(`로그인용 임시 서버에 오류가 났습니다: ${err.message}`, { cause: err }), null));
    server.on('request', (req, res) => {
      // 브라우저 연결 끊김은 로그인 결과와 무관하다 — 처리하지 않은 'error'로 프로그램이 죽지 않게만 받는다
      req.on('error', () => undefined);
      res.on('error', () => undefined);
      if (settled) return sendPage(res, 410, false, '이미 끝난 로그인 요청입니다. 욱채에서 다시 시도하세요.');
      // DNS 리바인딩 등 다른 이름으로 들어온 요청은 거절한다 (로그인은 계속 기다림)
      if (req.headers.host !== host) return sendPage(res, 400, false, '잘못된 요청입니다.');
      if (req.method !== 'GET') return sendPage(res, 405, false, '잘못된 요청입니다.');
      const url = new URL(req.url ?? '/', `http://${host}`);
      if (url.pathname !== CALLBACK_PATH) return sendPage(res, 404, false, '페이지를 찾을 수 없습니다.');
      const q = url.searchParams;
      const gotState = q.get('state');
      const code = q.get('code');
      const error = q.get('error');
      if (gotState === null && code === null && error === null) return sendPage(res, 400, false, '구글 로그인 결과가 아닙니다.');
      if (handling) return sendPage(res, 409, false, '로그인을 처리하고 있습니다. 잠시 기다려 주세요.');
      handling = true;

      void (async () => {
        let profile: GoogleProfile | null = null;
        let failure: Error | null = null;
        try {
          if (gotState === null || !safeEqual(gotState, state)) {
            throw loginError('state_mismatch', '로그인 요청 정보(state)가 맞지 않습니다. 욱채에서 로그인을 다시 시작하세요.');
          }
          const iss = q.get('iss');
          if (iss !== null && !GOOGLE_ISSUERS.has(iss)) throw loginError('state_mismatch', '구글이 아닌 곳에서 온 로그인 결과입니다.');
          if (error !== null) {
            throw error === 'access_denied'
              ? loginError('denied', '구글 로그인을 거부했습니다.')
              : loginError('denied', `구글이 로그인 요청을 거부했습니다 (${error.slice(0, 64)}).`);
          }
          if (code === null || code.length === 0) throw loginError('token_exchange', '구글 응답에 인증 코드가 없습니다.');
          const idToken = await exchangeCode(ctx, { clientId, clientSecret: opts.clientSecret, code, verifier, redirectUri });
          profile = await verifyIdToken(ctx, idToken, { clientId, nonce, nowMs: now() });
        } catch (err) {
          failure =
            stopReason ??
            (err instanceof GoogleLoginError ? err : loginError('token_exchange', '로그인 결과를 처리하지 못했습니다.', err));
        }
        if (settled) return;
        res.on('close', () => finish(failure, profile));
        if (profile) sendPage(res, 200, true, LOGIN_SUCCESS_MESSAGE);
        else sendPage(res, 400, false, `${failure!.message} 욱채로 돌아가 다시 시도하세요.`);
      })();
    });

    const url = authUrl.toString();
    // 동기적으로 던지는 구현도 같은 경로로 처리해 임시 서버가 남지 않게 한다
    Promise.resolve()
      .then(() => opts.onAuthUrl?.(url))
      .then(() => opts.openExternal(url))
      .catch((err: unknown) => {
        const reason = err instanceof Error ? err.message : String(err);
        finish(new Error(`브라우저를 열지 못해 로그인을 진행할 수 없습니다: ${reason}`, { cause: err }), null);
      });
  });
}
