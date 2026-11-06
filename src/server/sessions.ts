/**
 * 기기 세션의 HTTP 전송 (SERVER_DESIGN 3.4·3.5, 리드 결정 S3-4): 토큰을 어디서 읽고 어떻게 돌려주는지. 세션 저장소는 백엔드에 있다(auth/deviceSessions.ts).
 * - 브라우저는 쿠키 `__Host-wos_session`(HttpOnly, Secure, SameSite=Strict, Path=/, Domain 없음), 브라우저가 아닌 쪽(운영자 명령·시험)은
 *   `Authorization: Bearer <토큰>`
 * - 쿠키 이름은 `__Host-`로 시작한다 (리드 결정 S3-38): ts.net은 공공 접미사라 한 tailnet의 기계는 모두 같은 사이트이고, 형제 기계의 페이지가
 *   `Domain=<tailnet>.ts.net`으로 같은 이름의 쿠키를 던져 넣을 수 있다. 브라우저는 Domain을 붙인 `__Host-` 쿠키를 받지 않는다. 그래도 같은 이름이 여럿
 *   오면 값을 모두 본다 — 세션은 살아 있는 첫 값, 로그인은 어느 값으로든 찾는다
 * - 주소(쿼리)에 든 토큰은 늘 거부한다 — 방문 기록·앞단 접근 기록·복사한 링크에 남는다
 * - 쿠키를 실은 상태 변경 요청(GET·HEAD 밖)은 `X-Wook-Client: 1`과 허용한 Origin이 있어야 한다 — 없으면 403 (CSRF 막기). 허용 Origin은 서버 포트의
 *   루프백 주소와 공개 주소(--public-origin·server.json network.publicOrigin, S3-7 — 그 Host도 받는다)
 * - Tailscale 사용자 목록(server.json owner.tailscaleLogins)이 있으면 그 사용자의 요청만 받는다 — 추가 방어 (S3-7·3.6)
 * 토큰 원문은 기록·응답 본문에 넣지 않는다 — 세션 쿠키 머리로만 나간다
 */
import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { SESSION_TOKEN_RE, type DeviceSessionRecord } from '../main/auth/deviceSessions';

/** 세션 쿠키 (S3-4) — `__Host-`라 Secure·Path=/·Domain 없음이어야 브라우저가 받는다 (S3-38) */
export const SESSION_COOKIE = '__Host-wos_session';
/** 로그인 전 쿠키 — 기기 코드 로그인을 시작한 브라우저를 묶는다 (S3-5, issueLoginCookie). 세션 쿠키처럼 `__Host-` (S3-38) */
export const LOGIN_COOKIE = '__Host-wos_login';
/** 욱채 화면이 상태 변경 요청에 싣는 머리 (값 '1') — 다른 사이트의 페이지는 사전 요청 없이 이 머리를 보내지 못한다 */
export const CLIENT_HEADER = 'x-wook-client';
/**
 * 주소에 실리면 거부하는 이름(소문자로 견준다) — 토큰은 머리·쿠키로만 받는다. 세션 쿠키의 예전 이름 wos_session도 넣어 둔다 (S3-38 — 내보낸 적은 없지만
 * 그 이름으로 토큰을 붙인 주소가 기록에 남지 않게)
 */
const QUERY_TOKEN_NAMES = new Set(['token', 'access_token', 'session', 'wos_session', SESSION_COOKIE.toLowerCase()]);

/** 요청이 실은 인증 수단 */
export type Credential =
  /** 아무것도 싣지 않음 — 세션 없는 호출자 */
  | { kind: 'none' }
  /** Authorization 머리 — 방식이 Bearer가 아니거나 토큰이 비면 token null (그대로 401) */
  | { kind: 'bearer'; token: string | null }
  /** 쿠키 __Host-wos_session — 같은 이름이 여럿 왔으면 온 차례대로 모두 (S3-38, 비지 않는다) */
  | { kind: 'cookie'; tokens: string[] };

/** Cookie 머리 → 이름별 값 (같은 이름이 여럿이면 앞의 것 — 여럿을 다 볼 때는 cookieValues) */
export function parseCookies(header: string | string[] | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const [name, value] of cookiePairs(header)) if (!out.has(name)) out.set(name, value);
  return out;
}

/**
 * 그 이름의 쿠키 값을 온 차례대로 모두 (빈 값은 뺀다) — 형제 기계가 던진 쿠키가 앞에 와도 대표의 쿠키를 놓치지 않게 (리드 결정 S3-38). 브라우저는 경로가
 * 긴 쿠키를 먼저 보내므로(RFC 6265 5.4) 던진 `Path=/api` 쿠키가 대표의 `Path=/` 쿠키보다 앞에 온다
 */
export function cookieValues(header: string | string[] | undefined, name: string): string[] {
  return cookiePairs(header)
    .filter(([n, v]) => n === name && v.length > 0)
    .map(([, v]) => v);
}

function cookiePairs(header: string | string[] | undefined): [name: string, value: string][] {
  const text = Array.isArray(header) ? header.join('; ') : (header ?? '');
  const out: [string, string][] = [];
  for (const part of text.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    if (name) out.push([name, part.slice(eq + 1).trim()]);
  }
  return out;
}

/**
 * 요청의 인증 수단: Authorization 머리가 있으면 그것만 본다(방식 이름 Bearer는 대소문자를 가리지 않는다 — RFC 9110). 없으면 쿠키 __Host-wos_session의
 * 값 모두 — HTTP 층이 살아 있는 첫 값을 쓴다 (S3-38). 예전 이름 wos_session은 내보낸 적이 없어 읽지 않는다. 둘 다 없으면 세션 없는 호출자다
 */
export function readCredential(req: IncomingMessage): Credential {
  const auth = req.headers.authorization;
  if (auth !== undefined) {
    const m = typeof auth === 'string' ? /^Bearer\s+(\S+)\s*$/i.exec(auth) : null;
    return { kind: 'bearer', token: m ? m[1]! : null };
  }
  const tokens = cookieValues(req.headers.cookie, SESSION_COOKIE);
  return tokens.length > 0 ? { kind: 'cookie', tokens } : { kind: 'none' };
}

const NO_VALUE_EXEMPT: ReadonlySet<string> = new Set();

/**
 * 주소에 토큰이 실렸는지 — 토큰 이름의 쿼리이거나, 값이 세션 토큰과 꼭 같은 모양(`wos_` + base64url 43자)이면 (리드 결정 S3-24). `wos_`로 시작하기만
 * 하는 값(업로드 파일 이름 `wos_notes.txt` 등)은 토큰이 아니다. `valueExempt`의 쿼리 이름(대소문자 그대로)은 값의 모양을 보지 않는다 — 이름 검사는 그대로다.
 * HTTP 층은 `POST /api/uploads`의 `name`(파일 이름)만 넘긴다(리드 결정 S8-21 b — 업로드 주소는 방문 기록에 남지 않고, 접근 기록에는 쿼리를 쓰지 않는다)
 */
export function queryCarriesToken(url: URL, valueExempt: ReadonlySet<string> = NO_VALUE_EXEMPT): boolean {
  for (const [name, value] of url.searchParams) {
    if (QUERY_TOKEN_NAMES.has(name.toLowerCase())) return true;
    if (!valueExempt.has(name) && SESSION_TOKEN_RE.test(value)) return true;
  }
  return false;
}

/** `POST /api/uploads`에서 값의 토큰 모양을 보지 않는 쿼리 — 파일 이름 (S8-21 b) */
export const UPLOAD_NAME_QUERY: ReadonlySet<string> = new Set(['name']);

/**
 * 욱채 쿠키(__Host-wos_…, 예전 이름 wos_…)를 실었는지 — 세션이 살아 있든 아니든 이 브라우저가 욱채 화면의 것이다. 예전 이름은 자격으로 읽지 않지만
 * CSRF 막기에서는 브라우저 쿠키로 친다 (S3-38)
 */
export function carriesWookCookie(req: IncomingMessage): boolean {
  return [...parseCookies(req.headers.cookie).keys()].some((name) => name.startsWith('wos_') || name.startsWith('__Host-wos_'));
}

/** 상태를 바꿀 수 있는 HTTP 메서드인지 (GET·HEAD 밖) */
export const isStateChange = (method: string | undefined): boolean => method !== 'GET' && method !== 'HEAD';

/** 이 PC 안을 가리키는 Host 이름 — localhost(이름.localhost 포함), 127.0.0.0/8, [::1] */
const LOOPBACK_HOSTNAME = /^(?:localhost|.+\.localhost|127(?:\.\d{1,3}){3}|\[::1\])$/;

/**
 * 공개 주소(--public-origin·server.json network.publicOrigin, S3-7)의 모양: `https://<이름>[:포트]`만 받는다 — 경로·쿼리·조각·사용자 정보가 없어야 한다.
 * 세션 쿠키가 Secure라 http 주소로는 로그인이 되지 않는다. 이 PC 안의 이름(localhost·127.0.0.1·[::1])도 받지 않는다 — 브라우저 로그인은 공개 주소에서만
 * 받는데(S3-31) 그 이름의 쿠키는 같은 PC의 다른 포트에도 간다. 맞으면 정리한 주소(소문자 origin), 틀리면 까닭
 */
export function parsePublicOrigin(value: string): { ok: true; origin: string } | { ok: false; message: string } {
  const text = value.trim();
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, message: `공개 주소가 주소 모양이 아닙니다 — https://<서버 PC 이름>.<tailnet>.ts.net 꼴로 넣으세요` };
  }
  if (url.protocol !== 'https:') return { ok: false, message: '공개 주소는 https여야 합니다 — tailscale serve가 만든 https://<서버 PC 이름>.<tailnet>.ts.net 주소를 넣으세요' };
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    return { ok: false, message: '공개 주소에는 경로·쿼리·사용자 정보 없이 https://<이름>[:포트]만 넣으세요' };
  }
  if (LOOPBACK_HOSTNAME.test(url.hostname.toLowerCase())) {
    return { ok: false, message: '공개 주소에는 이 PC 안의 주소(localhost·127.0.0.1·[::1])를 넣지 않습니다 — tailscale serve가 만든 https://<서버 PC 이름>.<tailnet>.ts.net 주소를 넣으세요' };
  }
  return { ok: true, origin: url.origin.toLowerCase() };
}

/**
 * 쿠키(wos_login·wos_session)를 실어도 되는 요청인지 (리드 결정 S3-31): Host가 공개 주소의 Host일 때만. 쿠키는 포트로 나뉘지 않아 루프백 Host(127.0.0.1·
 * localhost·[::1])에 실은 쿠키는 같은 PC에서 다른 포트로 듣는 프로그램(다른 계정의 프로세스 포함 — S2-14)에도 간다. 쿠키 지우기(Max-Age=0)는 어디서나 된다
 */
export function cookieHostAllowed(host: string | undefined, publicOrigin: string | null | undefined): boolean {
  return typeof host === 'string' && publicHosts(publicOrigin).includes(host.toLowerCase());
}

/** 루프백 Host로 온 기기 코드 로그인을 받지 않는 글 (S3-31) — 되는 길(공개 주소)을 말한다 */
export function loopbackLoginRefusal(publicOrigin: string | null | undefined): string {
  return publicOrigin
    ? `이 PC 안의 주소로는 브라우저 로그인을 받지 않습니다. 같은 PC의 다른 프로그램이 로그인 쿠키를 받아 갈 수 있기 때문입니다. 공개 주소(${publicOrigin})로 여세요.`
    : '브라우저 로그인은 공개 주소에서만 받습니다. 서버 PC의 server.json에 network.publicOrigin(tailscale serve 주소)을 정한 뒤 그 주소로 여세요.';
}

/** 공개 주소로 온 요청의 Host 값들 — 기본 포트(443)를 적어 보낸 앞단도 받는다 (S3-7) */
export function publicHosts(publicOrigin: string | null | undefined): string[] {
  if (!publicOrigin) return [];
  try {
    const url = new URL(publicOrigin);
    const host = url.host.toLowerCase();
    return url.port ? [host] : [host, `${host}:443`];
  } catch {
    return [];
  }
}

/**
 * Tailscale 사용자 목록 검사 (server.json owner.tailscaleLogins, S3-7·3.6): 목록이 있으면 `Tailscale-User-Login` 머리가 그 목록에 있어야 한다(대소문자를
 * 가리지 않는다). 머리가 없거나 목록 밖이면 false. 목록이 없거나 비면 늘 true — 인증이 아니라 추가 방어다(같은 PC의 프로세스는 머리를 꾸밀 수 있다)
 */
export function tailscaleUserAllowed(req: IncomingMessage, logins: readonly string[] | null | undefined): boolean {
  return tailscaleLoginAllowed(tailscaleLoginOf(req), logins);
}

/** 같은 검사를 요청 대신 그 머리 값으로 — 열린 SSE를 운영자 설정이 바뀐 뒤 다시 볼 때 (S3-34) */
export function tailscaleLoginAllowed(login: string | null, logins: readonly string[] | null | undefined): boolean {
  if (!logins || logins.length === 0) return true;
  const who = login?.toLowerCase();
  return !!who && logins.some((l) => l.trim().toLowerCase() === who);
}

/** 상태 변경 요청에 받는 Origin — 서버 포트의 루프백 주소 셋과 공개 주소 (S3-7) */
export function allowedOrigins(port: number, publicOrigin?: string | null): Set<string> {
  const set = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`]);
  if (publicOrigin) {
    try {
      set.add(new URL(publicOrigin).origin.toLowerCase());
    } catch {
      // 모양이 틀린 공개 주소는 받는 Origin을 넓히지 않는다 (S3-7이 시작 때 거부한다)
    }
  }
  return set;
}

/** 쿠키를 실은 상태 변경 요청이 욱채 화면에서 왔는지 (S3-4): `X-Wook-Client: 1`과 허용한 Origin 둘 다 */
export function fromWookScreen(req: IncomingMessage, origins: ReadonlySet<string>): boolean {
  const origin = req.headers.origin;
  return req.headers[CLIENT_HEADER] === '1' && typeof origin === 'string' && origins.has(origin.toLowerCase());
}

/**
 * 호출자 열쇠 (S3-3 RemoteCaller.clientKey) — 횟수 제한과 로그인 묶기에 쓴다. 세션이 있으면 그 세션, 없으면 로그인 전 쿠키(__Host-wos_login — 여럿이면
 * 첫 값)의 해시, 그것도 없으면 Tailscale 사용자, 그것도 없으면 'anonymous'. 로그인 전 쿠키가 여럿 오면 나머지 값의 열쇠도 함께 넘긴다(loginKeysOf, S3-38).
 * 브라우저가 아닌 쪽(운영자 도구·시험)도 같다 (S3b): 기기 세션이 있으면 Bearer 세션의 열쇠이고, 없으면 auth.deviceLogin 응답의 Set-Cookie로 받은
 * __Host-wos_login을 Cookie 머리로 다시 보낸다. 그 묻기는 쿠키를 실은 상태 변경이라 브라우저처럼 `X-Wook-Client: 1`과 허용 Origin(서버 포트의 루프백
 * 주소나 공개 주소)도 함께 보내야 한다 — 없으면 403 forbidden_origin (리드 결정 S3-25, CSRF 막기는 그대로)
 */
export function clientKeyOf(req: IncomingMessage, session: Pick<DeviceSessionRecord, 'id'> | null): string {
  if (session) return `session:${session.id}`;
  const [login] = cookieValues(req.headers.cookie, LOGIN_COOKIE);
  if (login) return loginClientKey(login);
  const ts = tailscaleLoginOf(req);
  return ts ? `tailscale:${ts}` : 'anonymous';
}

/**
 * 이 요청이 실은 로그인 전 쿠키 값마다의 열쇠 (리드 결정 S3-38, RemoteCaller.loginKeys) — 같은 이름이 여럿 와도(형제 기계가 던진 쿠키가 앞에 와도) 그
 * 가운데 어느 값으로 시작한 로그인이든 찾는다. 값을 모르면 남의 로그인을 찾지 못하는 것은 그대로다
 */
export function loginKeysOf(req: IncomingMessage): string[] {
  return [...new Set(cookieValues(req.headers.cookie, LOGIN_COOKIE).map(loginClientKey))];
}

/** 로그인 전 쿠키 값 → 호출자 열쇠 (원문이 아니라 해시 — 열쇠가 기록에 남아도 쿠키를 되살리지 못하게) */
export function loginClientKey(value: string): string {
  return `login:${createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 32)}`;
}

/** 로그인 전 쿠키가 사는 시간 — 기기 코드 로그인 하나의 최대(10분, S3-5) */
export const LOGIN_COOKIE_MAX_AGE_SEC = 600;

/**
 * 새 로그인 전 쿠키를 이 응답에 싣고 그 열쇠를 돌려준다 (S3-5, RemoteCaller.newLoginKey) — 기기 코드 로그인을 시작한 브라우저만 그 결과를 묻게 한다.
 * 세션 쿠키와 같은 속성(HttpOnly, Secure, SameSite=Strict, Path=/)
 */
export function issueLoginCookie(res: ServerResponse): string {
  const value = randomBytes(32).toString('base64url');
  appendSetCookie(res, `${LOGIN_COOKIE}=${value}; ${cookieAttrs}; Max-Age=${LOGIN_COOKIE_MAX_AGE_SEC}`);
  return loginClientKey(value);
}

/** `tailscale serve`가 붙인 Tailscale 사용자 (없으면 null) — 인증이 아니다 (3.6) */
export function tailscaleLoginOf(req: IncomingMessage): string | null {
  const v = req.headers['tailscale-user-login'];
  const text = typeof v === 'string' ? v.trim() : '';
  return text ? text.slice(0, 200) : null;
}

const cookieAttrs = 'Path=/; HttpOnly; Secure; SameSite=Strict';

/** 세션 쿠키 (S3-4) — 브라우저에서 사는 시간은 세션의 최대 만료까지, 쉬는 만료는 서버가 본다 */
export function sessionCookie(token: string, maxAgeSec: number): string {
  return `${SESSION_COOKIE}=${token}; ${cookieAttrs}; Max-Age=${Math.max(0, Math.floor(maxAgeSec))}`;
}

/** 세션 쿠키 지우기 — 로그아웃·끊긴 세션·끝난 쿠키 */
export const CLEAR_SESSION_COOKIE = `${SESSION_COOKIE}=; ${cookieAttrs}; Max-Age=0`;

/**
 * 응답에 세션 쿠키를 싣는다 — 로그인에 성공한 응답 하나에서만 (S3-5: 기기 코드 로그인의 'ok' 응답). 같은 응답의 다른 Set-Cookie는 둔다
 */
export function setSessionCookie(res: ServerResponse, grant: { token: string; absoluteExpiresAt: string }, nowMs: number): void {
  appendSetCookie(res, sessionCookie(grant.token, (Date.parse(grant.absoluteExpiresAt) - nowMs) / 1000));
}

export function appendSetCookie(res: ServerResponse, cookie: string): void {
  const prev = res.getHeader('Set-Cookie');
  const list = prev === undefined ? [] : Array.isArray(prev) ? prev.map(String) : [String(prev)];
  // 같은 이름의 앞선 값(예: 끝난 쿠키 지우기)은 뒤의 값으로 바꾼다
  const name = cookie.slice(0, cookie.indexOf('='));
  res.setHeader('Set-Cookie', [...list.filter((c) => !c.startsWith(`${name}=`)), cookie]);
}

/** 서버 기록 가리기: 세션 토큰 모양(`wos_…`)을 지운다 */
export function redactSessionTokens(text: string): string {
  return text.replace(/wos_[A-Za-z0-9_-]{8,}/g, 'wos_[가림]');
}
