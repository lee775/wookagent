/**
 * 구글 기기 코드 로그인 (SERVER_DESIGN 3.5, 리드 결정 S3-5 — Google OAuth 2.0 device authorization grant). 서버에 접속한 화면(휴대폰 등)이 쓴다.
 * 데스크톱 앱은 이 PC의 브라우저와 루프백으로 로그인한다(googleAuth.ts).
 * - requestDeviceCode: `POST device/code`(client_id, scope=openid email profile) → device_code·user_code·verification_url·expires_in·interval
 * - pollDeviceToken: `POST token`(grant_type device_code, client_id, client_secret, device_code). authorization_pending → 기다림, slow_down → 간격 +5초,
 *   access_denied → 거부, expired_token → 만료. id_token을 받으면 verifyIdToken(googleAuth.ts)으로 서명·aud=client_id·iss·exp·email_verified를 본다 —
 *   기기 코드 방식에는 nonce가 없다(토큰이 리다이렉트 없이 서버와 구글 사이의 TLS로 바로 온다)
 * - DeviceLoginFlows: 진행 중인 로그인. 메모리에만 둔다 — device_code는 서버 밖으로 나가지 않는다. 모두 합쳐 동시에 6개, 자리 묶음(Tailscale 사용자,
 *   머리가 없으면 'local')마다 2개(S3-22), 하나에 10분(구글 코드가 더 빨리 끝나면 그쪽), 한 호출자 열쇠당 1분에 시작 5번. 결과는 그 로그인을 시작한
 *   호출자 열쇠로만 찾는다 — 다른 호출자는 그 로그인을 찾지 못한다
 * 구글 주소는 바꿔 넣을 수 있다 — 시험이 가짜 구글 서버를 쓴다. 토큰·device_code·보안 비밀은 기록하거나 오류 글에 넣지 않는다
 */
import { randomBytes } from 'node:crypto';
import type { DeviceLoginPoll } from '@shared/views';
import { GOOGLE_JWKS_URI, GOOGLE_TOKEN_ENDPOINT, verifyIdToken, type FetchContext } from './googleAuth';
import { GoogleLoginError, type GoogleProfile } from './types';

export const GOOGLE_DEVICE_CODE_ENDPOINT = 'https://oauth2.googleapis.com/device/code';
export const DEVICE_LOGIN_SCOPE = 'openid email profile';
export const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

/** 구글 주소 — 시험은 가짜 구글 서버로 바꾼다 */
export interface GoogleDeviceEndpoints {
  deviceCode: string;
  token: string;
  jwks: string;
}

export const GOOGLE_DEVICE_ENDPOINTS: GoogleDeviceEndpoints = { deviceCode: GOOGLE_DEVICE_CODE_ENDPOINT, token: GOOGLE_TOKEN_ENDPOINT, jwks: GOOGLE_JWKS_URI };

export interface GoogleDeviceOptions {
  endpoints?: Partial<GoogleDeviceEndpoints>;
  fetchImpl?: typeof fetch;
  /** id_token 만료 검사용 지금 시각 (epoch ms) */
  now?: () => number;
  /** 구글 요청 하나의 상한 (기본 30초) */
  timeoutMs?: number;
}

/** 구글이 내준 기기 코드 — device_code는 서버만 가진다 */
export interface DeviceCodeGrant {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresInSec: number;
  intervalSec: number;
}

export type DeviceTokenResult = { kind: 'pending' } | { kind: 'slow_down' } | { kind: 'denied' } | { kind: 'expired' } | { kind: 'ok'; profile: GoogleProfile };

const FETCH_TIMEOUT_MS = 30_000;
/** 구글이 interval을 주지 않을 때 (RFC 8628 기본 5초) */
const DEFAULT_INTERVAL_SEC = 5;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function deviceError(code: GoogleLoginError['code'], message: string, cause?: unknown): GoogleLoginError {
  const err = new GoogleLoginError(code, message);
  if (cause !== undefined) Object.defineProperty(err, 'cause', { value: cause, enumerable: false, writable: true, configurable: true });
  return err;
}

/** 구글 오류 이름 (authorization_pending 등) — 이름 모양이 아니면 null. 구글이 준 글을 그대로 옮기지 않는다 */
function googleErrorName(json: unknown): string | null {
  const v = isRecord(json) ? json['error'] : undefined;
  return typeof v === 'string' && /^[a-z_]{1,64}$/.test(v) ? v : null;
}

async function postForm(url: string, form: Record<string, string>, o: GoogleDeviceOptions, what: string): Promise<{ status: number; ok: boolean; json: unknown }> {
  const fetchImpl = o.fetchImpl ?? globalThis.fetch;
  let res: Response;
  let text: string;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(o.timeoutMs ?? FETCH_TIMEOUT_MS),
    });
    text = await res.text();
  } catch (err) {
    throw deviceError('network', `${what}에 연결하지 못했습니다 — 서버 PC의 인터넷 연결을 확인하세요`, err);
  }
  let json: unknown = null;
  if (text.length > 0) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  // 구글 쪽 잠깐의 장애(5xx, 오류 이름 없음)는 연결 실패와 같게 본다 — 기다리는 로그인은 다음 확인 때 다시 묻는다
  if (res.status >= 500 && googleErrorName(json) === null) throw deviceError('network', `${what}가 잠시 답하지 못했습니다 (HTTP ${res.status})`);
  return { status: res.status, ok: res.ok, json };
}

/** 기기 코드를 받는다. 실패하면 GoogleLoginError — network(연결 실패), token_exchange(구글이 거부), invalid_token(응답 모양이 틀림) */
export async function requestDeviceCode(clientId: string, o: GoogleDeviceOptions = {}): Promise<DeviceCodeGrant> {
  const ep = { ...GOOGLE_DEVICE_ENDPOINTS, ...o.endpoints };
  const r = await postForm(ep.deviceCode, { client_id: clientId, scope: DEVICE_LOGIN_SCOPE }, o, '구글 기기 코드 서버');
  if (!r.ok) {
    const name = googleErrorName(r.json);
    if (name === 'invalid_client' || name === 'unauthorized_client') {
      throw deviceError('token_exchange', `구글이 이 클라이언트 ID로 기기 코드를 내주지 않았습니다 (${name}) — 'TV 및 입력 제한 기기' 종류의 클라이언트 ID인지 확인하세요`);
    }
    throw deviceError('token_exchange', `구글이 기기 코드 요청을 거부했습니다 (HTTP ${r.status}${name ? `, ${name}` : ''})`);
  }
  const j = isRecord(r.json) ? r.json : {};
  const deviceCode = j['device_code'];
  const userCode = j['user_code'];
  // 구글은 verification_url을 쓴다 (RFC 8628 이름은 verification_uri)
  const url = j['verification_url'] ?? j['verification_uri'];
  const expires = j['expires_in'];
  const interval = j['interval'] ?? DEFAULT_INTERVAL_SEC;
  let https = false;
  try {
    https = typeof url === 'string' && new URL(url).protocol === 'https:';
  } catch {
    https = false;
  }
  if (
    typeof deviceCode !== 'string' ||
    deviceCode.length === 0 ||
    deviceCode.length > 2048 ||
    typeof userCode !== 'string' ||
    !/^[A-Za-z0-9-]{4,32}$/.test(userCode) ||
    !https ||
    typeof expires !== 'number' ||
    !(expires > 0) ||
    typeof interval !== 'number' ||
    !(interval > 0)
  ) {
    throw deviceError('invalid_token', '구글 기기 코드 응답의 모양이 올바르지 않습니다');
  }
  return { deviceCode, userCode, verificationUrl: url as string, expiresInSec: expires, intervalSec: interval };
}

/**
 * 구글에 결과를 한 번 묻는다. 대표가 허락했으면 id_token을 확인한 프로필(대표 이메일·sub 확인은 부른 쪽이 한다).
 * 실패하면 GoogleLoginError — network(연결 실패 — 다음 확인 때 다시 묻는다), token_exchange(구글이 거부), invalid_token·email_unverified(토큰 확인 실패)
 */
export async function pollDeviceToken(p: { clientId: string; clientSecret: string; deviceCode: string }, o: GoogleDeviceOptions = {}): Promise<DeviceTokenResult> {
  const ep = { ...GOOGLE_DEVICE_ENDPOINTS, ...o.endpoints };
  const r = await postForm(
    ep.token,
    { client_id: p.clientId, client_secret: p.clientSecret, device_code: p.deviceCode, grant_type: DEVICE_GRANT_TYPE },
    o,
    '구글 토큰 서버',
  );
  if (!r.ok) {
    const name = googleErrorName(r.json);
    switch (name) {
      case 'authorization_pending':
        return { kind: 'pending' };
      case 'slow_down':
        return { kind: 'slow_down' };
      case 'access_denied':
        return { kind: 'denied' };
      case 'expired_token':
        return { kind: 'expired' };
      default:
        throw deviceError('token_exchange', `구글이 로그인 확인을 거부했습니다 (HTTP ${r.status}${name ? `, ${name}` : ''})`);
    }
  }
  const idToken = isRecord(r.json) ? r.json['id_token'] : undefined;
  if (typeof idToken !== 'string' || idToken.length === 0) throw deviceError('invalid_token', '구글 응답에 ID 토큰이 없습니다');
  const ctx: FetchContext = { fetchImpl: o.fetchImpl ?? globalThis.fetch, signal: AbortSignal.timeout(o.timeoutMs ?? FETCH_TIMEOUT_MS), jwksUri: ep.jwks };
  const profile = await verifyIdToken(ctx, idToken, { clientId: p.clientId, nonce: null, nowMs: (o.now ?? Date.now)() });
  return { kind: 'ok', profile };
}

// ───────────────────────── 진행 중인 로그인 ─────────────────────────

/** 상한 (리드 결정 S3-5, S3-22) */
export const DEVICE_LOGIN_LIMITS = {
  /** 동시에 기다리는 로그인 (모두 합쳐) */
  maxPending: 6,
  /** 한 자리 묶음(Tailscale 사용자, 머리가 없으면 'local')이 동시에 가진 기다림 — 한쪽이 모든 자리를 쥐어 대표의 로그인을 막지 못하게 (S3-22) */
  maxPendingPerBucket: 2,
  /** 로그인 하나가 사는 시간 (구글 코드가 더 빨리 끝나면 그쪽) */
  maxLifetimeMs: 10 * 60_000,
  /** 한 호출자 열쇠가 창 안에 시작할 수 있는 수 */
  startsPerWindow: 5,
  startWindowMs: 60_000,
  /** slow_down마다 늘리는 간격 */
  slowDownSec: 5,
} as const;

export type DeviceLoginLimits = { [K in keyof typeof DEVICE_LOGIN_LIMITS]: number };

/** 기다리다 끝난 로그인의 답 */
export const EXPIRED_MESSAGE = '로그인 코드가 끝났습니다 — 다시 시작하세요';

/** 끝난 로그인을 끝난 답으로 남겨 두는 시간 (그 뒤 묻으면 찾지 못한다) */
const FINISHED_KEEP_MS = 60_000;

export interface PendingDeviceLogin {
  loginId: string;
  /** 이 로그인을 시작한 호출자 열쇠 — 결과는 이 열쇠의 호출자에게만 간다 */
  clientKey: string;
  /** 자리 묶음 — 묶음마다 동시에 maxPendingPerBucket개까지 (S3-22) */
  bucket: string;
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  deviceName: string;
  startedAt: number;
  expiresAt: number;
  intervalSec: number;
  /** 구글에 다시 물어도 되는 때 */
  nextPollAt: number;
  /** 구글에 묻는 중 — 겹친 묻기는 기다림으로 답한다 */
  polling: boolean;
  /** 끝난 답 (기다리는 중이면 null). 끝난 뒤 다시 물어도 같은 답이다 */
  outcome: DeviceLoginPoll | null;
  /** 끝난 때 */
  endedAt: number | null;
}

export type DeviceLoginAdmission = { ok: true } | { ok: false; reason: 'rate' | 'full' | 'bucket' };

/** 진행 중인 로그인 (메모리) — 시각은 넣어 준 시계로 잰다 */
export class DeviceLoginFlows {
  private readonly logins = new Map<string, PendingDeviceLogin>();
  private readonly starts = new Map<string, number[]>();
  private readonly limits: DeviceLoginLimits;

  constructor(
    private readonly now: () => number,
    limits: Partial<DeviceLoginLimits> = {},
  ) {
    this.limits = { ...DEVICE_LOGIN_LIMITS, ...limits };
  }

  /** 시간이 지난 기다림은 만료로 끝내고, 끝난 지 오래된 것과 오래된 시작 기록은 치운다 */
  private sweep(t: number): void {
    for (const [id, l] of this.logins) {
      if (!l.outcome && t >= l.expiresAt) this.finish(l, { status: 'expired', message: EXPIRED_MESSAGE }, l.expiresAt);
      if (l.endedAt !== null && t - l.endedAt >= FINISHED_KEEP_MS) this.logins.delete(id);
    }
    for (const [key, list] of this.starts) {
      const recent = list.filter((s) => t - s < this.limits.startWindowMs);
      if (recent.length) this.starts.set(key, recent);
      else this.starts.delete(key);
    }
  }

  /** 지금 기다리는 로그인 수 */
  pending(): number {
    const t = this.now();
    this.sweep(t);
    return [...this.logins.values()].filter((l) => !l.outcome).length;
  }

  /**
   * 새 로그인을 시작해도 되는지 — 열쇠(bucket)마다 창 안에 5번(거부된 시작도 센다), 모두 합쳐 동시에 6개, 자리 묶음(holder — 없으면 열쇠)마다 동시에
   * 2개 (S3-22). replaces: 이 호출자가 앞서 시작한 기다림의 열쇠(여럿이면 그 어느 것 — 로그인 전 쿠키가 여럿 온 호출자, S3-38) — 새 시작이 대신하므로 먼저
   * 끝낸다(같은 화면에서 다시 시작해도 자리를 막지 않게). 횟수에 걸리면 앞선 기다림은 그대로 둔다
   */
  admit(bucket: string, replaces: string | readonly string[] | null, holder: string = bucket): DeviceLoginAdmission {
    const t = this.now();
    this.sweep(t);
    const recent = this.starts.get(bucket) ?? [];
    if (recent.length >= this.limits.startsPerWindow) return { ok: false, reason: 'rate' };
    this.starts.set(bucket, [...recent, t]);
    if (replaces !== null) {
      const keys = typeof replaces === 'string' ? [replaces] : replaces;
      for (const [id, l] of this.logins) if (keys.includes(l.clientKey) && !l.outcome) this.logins.delete(id);
    }
    const waiting = [...this.logins.values()].filter((l) => !l.outcome);
    if (waiting.filter((l) => l.bucket === holder).length >= this.limits.maxPendingPerBucket) return { ok: false, reason: 'bucket' };
    if (waiting.length >= this.limits.maxPending) return { ok: false, reason: 'full' };
    return { ok: true };
  }

  /** 받은 기기 코드로 기다림을 만든다. 사는 시간은 10분과 구글 코드의 만료 가운데 이른 쪽. holder: 자리 묶음 (admit에 넘긴 것, 없으면 열쇠) */
  add(clientKey: string, grant: DeviceCodeGrant, deviceName: string, holder: string = clientKey): PendingDeviceLogin {
    const t = this.now();
    const intervalSec = Math.min(Math.max(Math.ceil(grant.intervalSec), 1), 60);
    const login: PendingDeviceLogin = {
      loginId: `dl_${randomBytes(18).toString('base64url')}`,
      clientKey,
      bucket: holder,
      deviceCode: grant.deviceCode,
      userCode: grant.userCode,
      verificationUrl: grant.verificationUrl,
      deviceName,
      startedAt: t,
      expiresAt: t + Math.min(grant.expiresInSec * 1000, this.limits.maxLifetimeMs),
      intervalSec,
      nextPollAt: t + intervalSec * 1000,
      polling: false,
      outcome: null,
      endedAt: null,
    };
    this.logins.set(login.loginId, login);
    return login;
  }

  /** 그 호출자 열쇠가 시작한 로그인 (없거나 다른 호출자가 시작했으면 null). 열쇠가 여럿이면 그 가운데 어느 것이든 (로그인 전 쿠키가 여럿 온 호출자, S3-38) */
  find(loginId: string, clientKey: string | readonly string[]): PendingDeviceLogin | null {
    this.sweep(this.now());
    const l = this.logins.get(loginId);
    const keys = typeof clientKey === 'string' ? [clientKey] : clientKey;
    return l && keys.includes(l.clientKey) ? l : null;
  }

  /**
   * 구글에 물을 차례인지: 끝났으면 'done'(끝난 답 그대로), 간격 전이거나 다른 묻기가 진행 중이면 'wait'(구글에 묻지 않고 기다림으로 답한다),
   * 아니면 'go' — 묻는 중으로 표시한다. 끝나면 waitMore나 finish를 부른다
   */
  next(l: PendingDeviceLogin): 'done' | 'wait' | 'go' {
    const t = this.now();
    this.sweep(t);
    if (l.outcome) return 'done';
    if (l.polling || t < l.nextPollAt) return 'wait';
    l.polling = true;
    return 'go';
  }

  /** 아직이다 — 다음 묻기는 간격 뒤. slowDown이면 간격을 5초 늘린다 */
  waitMore(l: PendingDeviceLogin, slowDown: boolean): void {
    if (slowDown) l.intervalSec += this.limits.slowDownSec;
    l.polling = false;
    l.nextPollAt = this.now() + l.intervalSec * 1000;
  }

  /** 끝낸다 — 그 뒤의 묻기는 같은 답을 받는다 */
  finish(l: PendingDeviceLogin, outcome: DeviceLoginPoll, at: number = this.now()): DeviceLoginPoll {
    l.polling = false;
    l.outcome = outcome;
    l.endedAt = at;
    l.deviceCode = '';
    return outcome;
  }
}
