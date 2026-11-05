/**
 * 서버의 대표 로그인 (SERVER_DESIGN 3.5, 리드 결정 S3-5·S3-6·S3-8). 서버 모드(deps.mode 'server')에서만 쓴다 — 데스크톱 앱은 이 PC의 브라우저로
 * 로그인하고(auth.ts) 이 길을 쓰지 않는다.
 * - 대표 이메일 (S3-6): 운영자 설정(server.json owner.email·--owner-email)이 먼저, 없으면 설정 코드로 한 번 정한다(kv `server.ownerEmail`). 바뀌면
 *   등록된 구글 계정(sub)을 지우고 기기 세션을 모두 끊는다. 정해지기 전에는 기기 코드 로그인을 시작하지 않는다 — 처음 들어온 사람이 대표가 되지 않게
 * - 설정 코드: 헷갈리지 않는 글자 8자, 1시간, 한 번만. 원문은 서버 콘솔과 `<dataDir>/setup-code.txt`(서버가 그 사용자만 읽게 쓴다)에만 나온다.
 *   10분 안에 5번 틀리면 그 코드는 버린다. 맞으면 대표 이메일만 정하고 코드 파일을 지운다
 * - 구글 클라이언트 (S3-8): 'TV 및 입력 제한 기기' 종류. ID는 kv `server.google`(운영자 설정 google.clientId가 덮어쓴다), 보안 비밀은 OS 보안 저장소
 *   (SECRET_KEYS.googleDeviceClientSecret). 데스크톱 앱의 구글 설정(설정 account.googleClientId — '데스크톱 앱' 종류)과 따로 둔다 — 같은 데이터
 *   폴더를 쓰는 데스크톱 앱의 로그인을 덮어쓰지 않게
 * - 기기 코드 로그인 (S3-5, auth/googleDevice.ts): 결과는 그 로그인을 시작한 호출자에게만 간다 — 시작 응답에 새로 실은 로그인 전 쿠키
 *   __Host-wos_login, 기기 세션이 있으면 그 세션의 호출자 열쇠. 로그인 전 쿠키가 여럿 오면 그 가운데 어느 값으로든 찾는다(S3-38 — 형제 기계가 던진
 *   쿠키가 앞에 와도). 시작 횟수는 기기 세션 또는 Tailscale 사용자마다 센다(쿠키로는 세지 않는다 — 지어낼 수 있다).
 *   공개 주소로 온 요청만 시작하고 마친다 — HTTP 층이 루프백 Host로 온 요청에 거부 글(RemoteCaller.loginRefusal)을 싣는다 (S3-31).
 *   구글 계정의 이메일이 대표 이메일(소문자로 견줌)이어야 하고, 등록된 sub가 있으면 그 sub여야 한다. 처음 맞는 로그인이 sub를 등록한다.
 *   성공하면 그 응답에 세션 쿠키를 싣고(RemoteCaller.grantSession) 다른 기기에 알린다(알림 key `device-login:<세션 ID>`). 대표가 아닌 계정은 거부하고
 *   이메일 도메인만 적는다
 * 토큰·device_code·id_token·보안 비밀·설정 코드는 기록·활동 기록·알림·JSON 응답에 넣지 않는다
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Actor } from '@shared/domain';
import { OPERATOR, OWNER } from '@shared/domain';
import type { AuthState, DeviceLoginPoll, DeviceLoginStart } from '@shared/views';
import type { WookTopic } from '@shared/ipc';
import { BackendError, type RemoteCaller, type ServerAuthStatus, type ServerConfigChange, type ServerConfigValues, type SetupCodeGrant } from '../backend/types';
import { SECRET_KEYS, GoogleLoginError } from '../auth/types';
import { cleanDeviceName, deviceSessionView } from '../auth/deviceSessions';
import { DEVICE_LOGIN_LIMITS, DeviceLoginFlows, pollDeviceToken, requestDeviceCode, type PendingDeviceLogin } from '../auth/googleDevice';
import { TEST_OWNER } from './auth';
import { seatConfigProblem } from './seat';
import type { Core } from './core';

const OWNER_EMAIL_KEY = 'server.ownerEmail';
const GOOGLE_KEY = 'server.google';
/** 앞서 쓰던 접속 허용 (S3-19 — 바뀐 것을 알아보는 데만 쓴다. HTTP는 운영자 설정에서 읽는다) */
const ACCESS_KEY = 'server.access';
/** 설정 코드 파일 (`<dataDir>/setup-code.txt`) — 서버가 쓰고, 코드를 쓰거나 버리면 백엔드가 지운다 */
export const SETUP_CODE_FILE = 'setup-code.txt';
/** 헷갈리지 않는 글자 — 0·O·1·I·L이 없다 */
export const SETUP_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const SETUP_CODE_LENGTH = 8;
export const SETUP_CODE_TTL_MS = 60 * 60_000;
/** 이 창 안에 SETUP_CODE_MAX_FAILURES번 틀리면 그 코드를 버린다 */
export const SETUP_CODE_TRY_WINDOW_MS = 10 * 60_000;
export const SETUP_CODE_MAX_FAILURES = 5;
/** 이메일 모양 (대표 이메일) */
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
/** 구글 OAuth 클라이언트 ID 모양 (api.ts와 같다) */
const GOOGLE_CLIENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.apps\.googleusercontent\.com$/;

export type OwnerEmailSource = 'config' | 'flag' | 'setup';
interface OwnerEmailRecord {
  email: string;
  source: OwnerEmailSource;
  setAt: string;
}
interface ServerGoogleRecord {
  clientId: string;
  secretSet: boolean;
}
interface ServerAccessRecord {
  publicOrigin: string | null;
  /** 받는 Tailscale 사용자 — 수와 지문(소문자로 고른 목록의 SHA-256 앞 16자)만. 검사하지 않으면 null */
  tailscaleLogins: { count: number; digest: string } | null;
}

/** 받는 Tailscale 사용자 목록의 수와 지문 — 대소문자·차례·겹침은 같은 목록으로 본다(HTTP 검사와 같다). 비면 null */
function tailscaleFingerprint(list: readonly string[] | null): ServerAccessRecord['tailscaleLogins'] {
  const users = [...new Set((list ?? []).map((l) => l.trim().toLowerCase()).filter(Boolean))].sort();
  return users.length ? { count: users.length, digest: createHash('sha256').update(users.join('\n'), 'utf8').digest('hex').slice(0, 16) } : null;
}

const SOURCE_LABEL: Record<OwnerEmailSource, string> = { config: '운영자 설정', flag: '--owner-email', setup: '설정 코드' };

export const SETUP_NOT_DONE = '서버 설정이 끝나지 않았습니다 — 대표 이메일이 아직 정해지지 않았습니다. 서버 PC에 나온 설정 코드와 대표 이메일을 먼저 넣으세요';
const OWNER_EMAIL_SET = '대표 이메일이 이미 정해졌습니다 — 바꾸는 일은 서버 PC의 운영자가 합니다 (wook-server config owner-email)';
const NEW_CODE_HINT = '서버 PC의 운영자가 서버를 다시 시작하면 새 코드가 나옵니다 (운영자가 wook-server config owner-email로 바로 정할 수도 있습니다)';
/** 기기 코드 로그인에 빠진 서버 설정 — 시작과 묻기가 같은 글을 쓴다 (S3-5·S3-28) */
const CLIENT_ID_MISSING = '서버에 구글 로그인 설정(클라이언트 ID)이 없습니다 — 서버 PC의 운영자가 wook-server config google-client-id로 넣습니다';
const CLIENT_SECRET_MISSING = '서버에 구글 로그인 보안 비밀이 없습니다 — 서버 PC의 운영자가 wook-server secret set google-client-secret으로 넣습니다';
const CLIENT_SECRET_UNREADABLE =
  '서버가 구글 로그인 보안 비밀을 OS 보안 저장소에서 읽지 못했습니다 — 잠시 뒤 다시 시작하세요. 계속되면 서버 PC의 운영자가 서버 기록을 확인합니다';
const DESKTOP_REFUSAL = '데스크톱 앱은 이 PC의 브라우저로 구글 로그인합니다 — 기기 코드 로그인은 서버 접속에서만 씁니다';

/** 대표 이메일 다듬기 — 모양이 아니면 null */
export function normalizeOwnerEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim();
  return email.length <= 254 && EMAIL_RE.test(email) ? email : null;
}

/** 구글 OAuth 클라이언트 ID 모양인지 (운영자 명령 config google-client-id가 파일에 쓰기 전에도 본다) */
export const isGoogleClientId = (v: string): boolean => GOOGLE_CLIENT_ID_RE.test(v);

/** 모양이 틀린 --owner-email (S3-35) — 명령 줄 인자를 읽을 때(cli.ts, 사용법 오류 2)와 적용할 때 같은 글 */
export const OWNER_EMAIL_FLAG_INVALID = '--owner-email: 대표 이메일 모양이 아닙니다';

/**
 * 운영자 설정 값 확인 (리드 결정 S3-35) — 저장소에 닿지 않는 순수 함수다. 대표 이메일(--owner-email·server.json owner.email), 구글 클라이언트 ID,
 * CLI 실행 파일 위치의 모양을 본다. 서버 시작의 미리 보기(잠금·백엔드보다 먼저 — config.ts precheckServerConfig)와 적용(applyServerConfig)이 같은 확인을
 * 쓴다. 틀린 값이 있으면 그 값이 온 곳(--owner-email이면 그 인자, 아니면 origin — server.json)을 말하는 글, 다 맞으면 null. 넣은 값은 글에 되풀이하지 않는다
 */
export function serverConfigValueError(values: ServerConfigValues, origin: string): string | null {
  if (values.ownerEmail && !normalizeOwnerEmail(values.ownerEmail.email)) {
    return values.ownerEmail.source === 'flag' ? OWNER_EMAIL_FLAG_INVALID : `${origin}의 대표 이메일(owner.email) 모양이 아닙니다`;
  }
  const clientId = values.googleClientId?.trim();
  if (clientId !== undefined && !isGoogleClientId(clientId)) {
    return `${origin}의 구글 클라이언트 ID(google.clientId)가 구글 OAuth 클라이언트 ID 모양(…apps.googleusercontent.com)이 아닙니다`;
  }
  for (const [kind, label] of [
    ['claudePath', 'Claude'],
    ['codexPath', 'Codex'],
  ] as const) {
    const v = values.cli?.[kind];
    if (v !== undefined && (!v.trim() || v.length > 1024 || /[\u0000-\u001f\u007f]/.test(v))) return `${origin}의 ${label} CLI 실행 파일 위치(cli.${kind})가 올바르지 않습니다`;
  }
  // 메인 자리 정책·처음 보유자 (S4-12) — 외부 보유자는 처음 보유자로 둘 수 없다 (S4-1)
  return values.seat ? seatConfigProblem(values.seat, origin) : null;
}

const sameEmail = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const codeHash = (code: string): Buffer => createHash('sha256').update(code, 'utf8').digest();

/**
 * 설정 코드의 꼴 (리드 결정 S3-18·S3-33): 받는 꼴과 가리는 꼴을 이 한 곳에서 정한다 — 둘이 어긋나면 받는 꼴인데 원문으로 저장되는 코드가 생긴다.
 * 받는 꼴: 코드의 글자들이 차례대로, 대소문자는 가리지 않고, 글자 사이에 띄어쓰기·줄표가 있어도 된다(화면·콘솔·setup-code.txt는 'ABCD-EFGH').
 *   ASCII만 받는다 — 코드 알파벳과 구분 글자(띄어쓰기 ' '·줄표 '-') 밖의 글자가 하나라도 있으면 맞춰 보지 않고, 대문자로는 a-z만 바꾼다. 유니코드
 *   대소문자 바꾸기('ſ'→S, 'ﬀ'→FF, 'ﬅ'·'ﬆ'→ST, 'ß'→SS)와 전각 글자로 쓴 코드는 받지 않는다 (S3-33)
 * 가리는 꼴: 같은 글자들 사이에 구분 글자가 있어도 되는 정규식(ASCII 대소문자만 무시 — u 깃발이 없어 ASCII 밖 글자를 ASCII에 겹쳐 보지 않는다).
 *   구분 글자는 받는 꼴보다 넓게(공백 글자 모두와 줄표) 본다 — 받는 꼴은 늘 가리는 꼴 안에 있다. 백엔드 가리개(ctx.redact)와 서버 기록 가리기(serve.ts)가 쓴다
 */
const SETUP_CODE_SEPARATOR = '[ -]';
const SETUP_CODE_REDACT_SEPARATOR = '[\\s-]';
/** 받는 꼴의 글자 — 코드 알파벳(대문자·ASCII 소문자)과 구분 글자만 */
const SETUP_CODE_INPUT = new RegExp(`^(?:[${SETUP_CODE_ALPHABET}${SETUP_CODE_ALPHABET.toLowerCase()}]|${SETUP_CODE_SEPARATOR})*$`);
/** 넣은 코드 다듬기: 받는 꼴의 글자만 있으면 a-z를 대문자로, 구분 글자(띄어쓰기·줄표)를 빼고 — 그 밖의 글자가 있으면 null (S3-33) */
export const normalizeSetupCode = (raw: string): string | null =>
  SETUP_CODE_INPUT.test(raw) ? raw.replace(/[a-z]/g, (c) => c.toUpperCase()).replace(new RegExp(SETUP_CODE_SEPARATOR, 'g'), '') : null;
/** 사람에게 보이는 꼴 (ABCD-EFGH) — 서버 콘솔과 setup-code.txt */
export const showSetupCode = (code: string): string => `${code.slice(0, 4)}-${code.slice(4)}`;
/** 낸 코드가 받는 모든 꼴로 들어간 자리 (영숫자 경계, ASCII 대소문자 무시) */
export function setupCodePattern(code: string): RegExp {
  const letters = [...(normalizeSetupCode(code) ?? code)].map((c) => c.replace(/[^A-Z0-9]/g, (x) => `\\${x}`));
  return new RegExp(`(?<![A-Za-z0-9])${letters.join(`${SETUP_CODE_REDACT_SEPARATOR}*`)}(?![A-Za-z0-9])`, 'gi');
}

export type SetupCheck = { ok: true } | { ok: false; reason: 'none' | 'expired' | 'burnt' | 'wrong'; left?: number; justBurnt?: boolean };

/** 설정 코드 하나 (메모리 — 해시만). 시각은 넣어 준 시계로 잰다 */
export class SetupCodes {
  private current: { hash: Buffer; expiresAt: number; failures: number[]; burnt: boolean } | null = null;

  constructor(private readonly now: () => number) {}

  /** 새 코드 (앞의 코드는 버린다) */
  issue(): { code: string; expiresAt: number } {
    let code = '';
    while (code.length < SETUP_CODE_LENGTH) {
      // 고르게 뽑는다 — 알파벳 길이의 배수 밖 바이트는 버린다
      for (const b of randomBytes(16)) {
        if (b < 256 - (256 % SETUP_CODE_ALPHABET.length) && code.length < SETUP_CODE_LENGTH) code += SETUP_CODE_ALPHABET[b % SETUP_CODE_ALPHABET.length];
      }
    }
    const expiresAt = this.now() + SETUP_CODE_TTL_MS;
    this.current = { hash: codeHash(code), expiresAt, failures: [], burnt: false };
    return { code, expiresAt };
  }

  /** 지금 쓸 수 있는 코드의 만료 (없거나 끝났거나 버렸으면 null) */
  activeUntil(): number | null {
    const c = this.current;
    return c && !c.burnt && this.now() < c.expiresAt ? c.expiresAt : null;
  }

  /** 넣은 코드 확인 — 맞으면 그 코드는 쓰인 것이다(한 번만). 틀린 것은 10분 창 안에서 세고 5번이면 버린다 */
  check(input: string): SetupCheck {
    const c = this.current;
    if (!c) return { ok: false, reason: 'none' };
    if (c.burnt) return { ok: false, reason: 'burnt' };
    const t = this.now();
    if (t >= c.expiresAt) {
      this.current = null;
      return { ok: false, reason: 'expired' };
    }
    c.failures = c.failures.filter((f) => t - f < SETUP_CODE_TRY_WINDOW_MS);
    // 받는 꼴이 아닌 글(ASCII 밖 글자 등)은 맞춰 보지 않고 틀린 것으로 센다 (S3-33)
    const normalized = normalizeSetupCode(input);
    if (normalized !== null && timingSafeEqual(codeHash(normalized), c.hash)) {
      this.current = null;
      return { ok: true };
    }
    c.failures.push(t);
    if (c.failures.length >= SETUP_CODE_MAX_FAILURES) {
      c.burnt = true;
      return { ok: false, reason: 'burnt', justBurnt: true };
    }
    return { ok: false, reason: 'wrong', left: SETUP_CODE_MAX_FAILURES - c.failures.length };
  }

  clear(): void {
    this.current = null;
  }
}

/**
 * 그 연결에 보내지 않을 알림인지 (S3-5): 새 기기 로그인 알림은 '다른' 기기에 가는 것이다 — 막 로그인한 그 기기의 연결에는 밀어주지 않는다
 * (알림 목록에는 남는다). orchestrator.ts topicFor가 쓴다
 */
export function isOwnLoginNotice(topic: WookTopic, payload: unknown, caller: RemoteCaller): boolean {
  if (topic !== 'notification' || !caller.session) return false;
  const key = typeof payload === 'object' && payload !== null ? (payload as { key?: unknown }).key : undefined;
  return key === `device-login:${caller.session.id}`;
}

/**
 * 그 호출자의 로그인을 찾는 열쇠들 — 호출자 열쇠와, 세션이 없으면 실은 로그인 전 쿠키 값마다의 열쇠 (리드 결정 S3-38). 기기 세션이 있는 호출자는 세션
 * 열쇠로만 묶는다(clientKeyOf와 같다) — 세션을 받은 브라우저는 끝난 로그인을 다시 찾지 않는다
 */
const callerKeys = (caller: RemoteCaller): string[] => (caller.session ? [caller.clientKey] : [caller.clientKey, ...(caller.loginKeys ?? [])]);

/** 기다림 답 — 다음에 물을 간격(slow_down으로 늘었으면 늘어난 값)을 싣는다 (DeviceLoginPoll.intervalSec). 화면은 이 값으로 다음 묻기를 미룬다 */
const pendingReply =(login: PendingDeviceLogin, message?: string): DeviceLoginPoll => ({ status: 'pending', intervalSec: login.intervalSec, ...(message ? { message } : {}) });

export class ServerLoginService {
  readonly setupCodes: SetupCodes;
  private readonly flows: DeviceLoginFlows;

  constructor(private readonly core: Core) {
    const now = () => core.ctx.clock.ms();
    this.setupCodes = new SetupCodes(now);
    this.flows = new DeviceLoginFlows(now);
  }

  private get ctx() {
    return this.core.ctx;
  }

  private serverMode(): boolean {
    return this.ctx.deps.mode === 'server';
  }

  private requireServer(): void {
    if (!this.serverMode()) throw new BackendError('unavailable', DESKTOP_REFUSAL);
  }

  // ───── 대표 이메일 (S3-6) ─────

  private ownerEmailRecord(): OwnerEmailRecord | null {
    const r = this.ctx.store.kv.get<OwnerEmailRecord | null>(OWNER_EMAIL_KEY);
    return r && typeof r.email === 'string' && r.email ? r : null;
  }

  ownerEmail(): string | null {
    return this.ownerEmailRecord()?.email ?? null;
  }

  /** 대표 이메일이 아직 정해지지 않아 로그인을 열지 않는지 (서버 모드만) */
  setupRequired(): boolean {
    return this.serverMode() && this.ownerEmail() === null;
  }

  /**
   * 대표 이메일을 정한다. 앞의 이메일과 다르면(대소문자 무시) 등록된 구글 계정(sub)을 지우고 기기 세션을 모두 끊는다. 처음 정할 때도 이미 등록된 대표가
   * 다른 이메일이면(데스크톱 앱이 등록한 다른 계정, 시험용 대표) 그 대표를 지운다. 쓸 수 있던 설정 코드는 버린다. 바뀌었으면 true.
   * 같은 이메일을 다시 정해도 등록된 대표(시험용 대표 말고)의 이메일이 그와 다르면 그 등록을 지운다 — 같은 데이터 폴더의 데스크톱 앱이 다른 구글 계정을
   * 등록해 대표가 막혔을 때 운영자가 `config owner-email`을 다시 실행하면 풀린다 (리드 결정 S3-29). 이것도 true
   */
  setOwnerEmail(raw: string, source: OwnerEmailSource, actor: Actor): boolean {
    const ctx = this.ctx;
    const email = normalizeOwnerEmail(raw);
    if (!email) throw new BackendError('invalid', '대표 이메일 모양이 아닙니다 — 대표가 로그인할 구글 계정의 이메일을 넣으세요');
    const prev = this.ownerEmailRecord();
    if (prev && sameEmail(prev.email, email)) {
      if (prev.source !== source || prev.email !== email) ctx.store.kv.set(OWNER_EMAIL_KEY, { ...prev, email, source } satisfies OwnerEmailRecord);
      const registered = this.core.auth.owner();
      if (!registered || registered.sub === TEST_OWNER.sub || sameEmail(registered.email, email)) return false;
      // 등록된 대표가 대표 이메일과 다른 계정이다 — 이메일을 바꿀 때처럼 지우고 끊고 남긴다 (그 계정은 도메인만)
      const revoked = this.core.deviceSessions.list().length;
      this.core.auth.clearOwner();
      this.core.deviceSessions.revokeAll(actor);
      ctx.activity({
        kind: 'auth',
        actor,
        level: 'warn',
        text: `대표 이메일 다시 정함: ${email} (${SOURCE_LABEL[source]}) — 등록된 대표 계정(@${registered.email.split('@').pop() ?? '?'})이 대표 이메일과 달라 지우고 기기 세션 ${revoked}개를 끊었습니다`,
      });
      ctx.bus.changed();
      return true;
    }
    ctx.store.kv.set(OWNER_EMAIL_KEY, { email, source, setAt: ctx.now() } satisfies OwnerEmailRecord);
    this.setupCodes.clear();
    this.removeSetupFile();
    const owner = this.core.auth.owner();
    const clear = prev !== null || (owner !== null && !sameEmail(owner.email, email));
    let revoked = 0;
    if (clear) {
      // 글에는 살아 있던 세션 수만 — 이미 죽은 세션(대표가 바뀐 시험용 대표의 세션 등)도 끊은 것으로 적지만 세지 않는다
      revoked = this.core.deviceSessions.list().length;
      this.core.auth.clearOwner();
      this.core.deviceSessions.revokeAll(actor);
    }
    const tail = clear ? ` — 등록된 대표 계정을 지우고 기기 세션 ${revoked}개를 끊었습니다` : '';
    ctx.activity({
      kind: 'auth',
      actor,
      level: clear ? 'warn' : 'info',
      text: prev ? `대표 이메일 바꿈: ${prev.email} → ${email} (${SOURCE_LABEL[source]})${tail}` : `대표 이메일 정함: ${email} (${SOURCE_LABEL[source]})${tail}`,
    });
    ctx.bus.changed();
    return true;
  }

  // ───── 설정 코드 (S3-6) ─────

  /** 새 설정 코드 — 대표 이메일이 이미 정해졌으면 null. 가리개에도 넣는다(원문이 기록·활동 기록에 들어가지 않게) — 받는 모든 꼴로 (S3-18) */
  issueSetupCode(): SetupCodeGrant | null {
    if (!this.serverMode() || this.ownerEmail()) return null;
    const { code, expiresAt } = this.setupCodes.issue();
    this.ctx.redact.addSecret(code, 'setup-code');
    this.ctx.redact.addPattern(setupCodePattern(code), 'setup-code');
    this.ctx.activity({ kind: 'auth', actor: OPERATOR, text: '대표 이메일 설정 코드를 냄 (서버 콘솔과 setup-code.txt — 1시간, 한 번만)' });
    return { code, expiresAt: new Date(expiresAt).toISOString() };
  }

  private removeSetupFile(): void {
    try {
      unlinkSync(join(this.ctx.paths.root, SETUP_CODE_FILE));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.ctx.log('warn', '설정 코드 파일을 지우지 못했습니다', error);
    }
  }

  /** 설정 코드로 대표 이메일을 정한다 (auth.setupOwner, 로그인 전) — 대표 이메일 말고는 아무것도 바꾸지 않는다 */
  setupOwner(caller: RemoteCaller, code: unknown, email: unknown): AuthState {
    this.requireServer();
    if (typeof code !== 'string' || typeof email !== 'string' || code.length > 64) throw new BackendError('invalid_args', '설정 코드와 대표 이메일이 필요합니다');
    if (this.ownerEmail()) throw new BackendError('conflict', OWNER_EMAIL_SET);
    const normalized = normalizeOwnerEmail(email);
    if (!normalized) throw new BackendError('invalid', '대표 이메일 모양이 아닙니다 — 대표가 로그인할 구글 계정의 이메일을 넣으세요');
    const check = this.setupCodes.check(code);
    if (!check.ok) {
      switch (check.reason) {
        case 'none':
          throw new BackendError('conflict', `쓸 수 있는 설정 코드가 없습니다 — ${NEW_CODE_HINT}`);
        case 'expired':
          this.removeSetupFile();
          throw new BackendError('conflict', `설정 코드가 끝났습니다(1시간) — ${NEW_CODE_HINT}`);
        case 'burnt':
          if (check.justBurnt) {
            this.removeSetupFile();
            this.ctx.activity({ kind: 'auth', level: 'warn', text: `대표 이메일 설정 코드를 10분 안에 ${SETUP_CODE_MAX_FAILURES}번 틀려 그 코드를 버림` });
          }
          throw new BackendError('rate_limited', `설정 코드를 10분 안에 ${SETUP_CODE_MAX_FAILURES}번 틀려 그 코드는 더 쓸 수 없습니다 — ${NEW_CODE_HINT}`);
        case 'wrong':
          throw new BackendError('invalid', `설정 코드가 맞지 않습니다 — 서버 PC의 콘솔이나 setup-code.txt에 나온 코드를 넣으세요 (이 코드로 ${check.left}번 더 해 볼 수 있습니다)`);
      }
    }
    // 코드 파일은 setOwnerEmail이 지운다 — 대표 이메일이 없던 서버라 늘 바뀐 것이다
    this.setOwnerEmail(normalized, 'setup', OWNER);
    return this.core.auth.state(caller);
  }

  // ───── 구글 클라이언트 (S3-8) ─────

  private google(): ServerGoogleRecord {
    const g = this.ctx.store.kv.get<Partial<ServerGoogleRecord> | null>(GOOGLE_KEY);
    return { clientId: typeof g?.clientId === 'string' ? g.clientId : '', secretSet: g?.secretSet === true };
  }

  googleConfigured(): boolean {
    return !!this.google().clientId;
  }

  googleSecretSet(): boolean {
    return this.google().secretSet;
  }

  /** 운영자 명령 `secret set|clear google-client-secret` — 값은 OS 보안 저장소에만, 서버 설정에는 등록 여부만 (SEC-09) */
  async setGoogleClientSecret(value: string | null): Promise<void> {
    const ctx = this.ctx;
    if (value !== null) {
      const v = value.trim();
      if (!v || v.length > 4096 || /[\u0000-\u001f\u007f]/.test(v)) throw new BackendError('invalid', '보안 비밀이 비었거나 쓸 수 없는 글자가 있습니다');
      await ctx.deps.secrets.set(SECRET_KEYS.googleDeviceClientSecret, v);
      // 형식 규칙(GOCSPX-)에 없는 값도 가린다 — 시작 때도 저장소에서 다시 넣는다 (SEC-10, orchestrator.ts registerStoredSecrets)
      ctx.redact.addSecret(v, 'google-secret');
    } else {
      await ctx.deps.secrets.delete(SECRET_KEYS.googleDeviceClientSecret);
    }
    ctx.store.kv.set(GOOGLE_KEY, { ...this.google(), secretSet: value !== null } satisfies ServerGoogleRecord);
    ctx.activity({ kind: 'settings', actor: OPERATOR, text: `서버 구글 로그인 보안 비밀 ${value !== null ? '등록' : '지움'} (운영자 명령)` });
    ctx.bus.changed();
  }

  /** 등록됨으로 적힌 보안 비밀이 OS 보안 저장소에 없으면 등록 안 됨으로 맞춘다 (시작 때). 저장소를 읽지 못하면 그대로 둔다 */
  async syncSecretFlag(): Promise<void> {
    const ctx = this.ctx;
    if (!this.google().secretSet) return;
    let value: string | null;
    try {
      value = await ctx.deps.secrets.get(SECRET_KEYS.googleDeviceClientSecret);
    } catch (e) {
      ctx.log('warn', '서버 구글 로그인 보안 비밀을 OS 보안 저장소에서 읽지 못했습니다', e);
      return;
    }
    if (value?.trim()) return;
    ctx.store.kv.set(GOOGLE_KEY, { ...this.google(), secretSet: false } satisfies ServerGoogleRecord);
    ctx.activity({ kind: 'auth', level: 'warn', text: '서버 구글 로그인 보안 비밀이 OS 보안 저장소에 없어 등록 안 됨으로 바꿨습니다 — 운영자가 wook-server secret set google-client-secret으로 다시 넣습니다' });
  }

  /** 서버 구글 보안 비밀 — 없으면 'missing', OS 보안 저장소를 읽지 못하면 'unreadable' (글이 그 까닭을 말하게, S3-28) */
  private async clientSecret(): Promise<{ ok: true; value: string } | { ok: false; reason: 'missing' | 'unreadable' }> {
    try {
      const value = (await this.ctx.deps.secrets.get(SECRET_KEYS.googleDeviceClientSecret))?.trim();
      return value ? { ok: true, value } : { ok: false, reason: 'missing' };
    } catch (e) {
      this.ctx.log('warn', '서버 구글 로그인 보안 비밀을 읽지 못했습니다', e);
      return { ok: false, reason: 'unreadable' };
    }
  }

  /**
   * 기기 코드 로그인에 필요한 서버 설정 — 빠진 것이 있으면 그 항목을 말하는 글: 대표 이메일, 구글 클라이언트 ID, 보안 비밀(없음·읽지 못함).
   * 시작(startDeviceLogin)과 묻기(askGoogle)가 같은 글을 쓴다 — 보안 비밀만 사라졌는데 대표 이메일이 없다고 말하지 않게 (S3-28)
   */
  private async loginConfig(): Promise<{ ok: true; clientId: string; secret: string } | { ok: false; message: string }> {
    if (!this.ownerEmail()) return { ok: false, message: SETUP_NOT_DONE };
    const clientId = this.google().clientId;
    if (!clientId) return { ok: false, message: CLIENT_ID_MISSING };
    const secret = await this.clientSecret();
    if (!secret.ok) return { ok: false, message: secret.reason === 'missing' ? CLIENT_SECRET_MISSING : CLIENT_SECRET_UNREADABLE };
    return { ok: true, clientId, secret: secret.value };
  }

  // ───── 운영자 설정 (S3-8) ─────

  /** 운영자 설정 값 적용 — 모든 값을 먼저 확인하고, DB와 다른 값만 덮어쓰며 덮어쓴 것마다 활동 기록(행위자 operator)에 남긴다 */
  applyServerConfig(values: ServerConfigValues, origin: string): ServerConfigChange[] {
    const ctx = this.ctx;
    // 시작의 미리 보기와 같은 확인 — 틀린 값의 글은 그 값이 온 곳(--owner-email·server.json)을 말한다 (S3-35)
    const invalid = serverConfigValueError(values, origin);
    if (invalid) throw new BackendError('invalid', invalid);
    const email = values.ownerEmail ? normalizeOwnerEmail(values.ownerEmail.email) : null;
    const clientId = values.googleClientId?.trim();
    const paths: [kind: 'claudePath' | 'codexPath', label: string, value: string][] = [];
    for (const [kind, label] of [
      ['claudePath', 'Claude'],
      ['codexPath', 'Codex'],
    ] as const) {
      const v = values.cli?.[kind];
      if (v !== undefined) paths.push([kind, label, v.trim()]);
    }
    const changes: ServerConfigChange[] = [];
    const emailBefore = this.ownerEmail();
    if (values.ownerEmail && email && this.setOwnerEmail(email, values.ownerEmail.source, OPERATOR)) {
      // 같은 이메일이면 등록된 다른 계정을 지운 것이다 (S3-29)
      changes.push({ item: 'owner.email', text: emailBefore && sameEmail(emailBefore, email) ? `대표 이메일 ${email} 다시 정함 — 대표 이메일과 다른 등록된 계정을 지웠습니다` : `대표 이메일 → ${email}` });
    }
    if (clientId !== undefined && clientId !== this.google().clientId) {
      ctx.store.kv.set(GOOGLE_KEY, { ...this.google(), clientId } satisfies ServerGoogleRecord);
      ctx.activity({ kind: 'settings', actor: OPERATOR, text: `${origin}: 서버 구글 클라이언트 ID를 바꿈 (${clientId})` });
      changes.push({ item: 'google.clientId', text: `구글 클라이언트 ID → ${clientId}` });
    }
    for (const [kind, label, v] of paths) {
      const s = ctx.settings();
      if (s.cli[kind] === v) continue;
      ctx.saveSettings({ ...s, cli: { ...s.cli, [kind]: v } });
      ctx.activity({ kind: 'settings', actor: OPERATOR, text: `${origin}: ${label} CLI 실행 파일 위치를 바꿈 (${v})` });
      changes.push({ item: `cli.${kind}`, text: `${label} CLI 위치 → ${v}` });
    }
    if (values.access) changes.push(...this.recordAccess(values.access, origin));
    // 메인 자리 정책 (S4-12) — 처음 보유자는 자리가 비었을 때만 쓴다
    if (values.seat) changes.push(...this.core.seat.applyOperatorConfig(values.seat, origin));
    if (changes.length) ctx.bus.changed();
    return changes;
  }

  private accessRecord(): ServerAccessRecord {
    const r = this.ctx.store.kv.get<Partial<ServerAccessRecord> | null>(ACCESS_KEY);
    const t = r?.tailscaleLogins;
    return {
      publicOrigin: typeof r?.publicOrigin === 'string' ? r.publicOrigin : null,
      tailscaleLogins: t && typeof t.count === 'number' && typeof t.digest === 'string' ? { count: t.count, digest: t.digest } : null,
    };
  }

  /**
   * 접속 허용이 바뀐 것을 남긴다 (리드 결정 S3-19): 공개 주소와 받는 Tailscale 사용자는 DB 설정이 아니라 HTTP가 운영자 설정에서 요청마다 읽는다. 앞서
   * 쓰던 값은 kv `server.access`에 두고(Tailscale 사용자는 수와 지문만 — 주소는 남기지 않는다) 시작과 config reload 때 견준다. 바뀐 것마다 활동 기록
   * (행위자 operator)과 바뀐 것 한 줄 — 켬·끔·수만 말하고 사용자 주소는 말하지 않는다. server.json을 지우면 파일이 주던 값이 꺼진 것으로 본다
   */
  private recordAccess(access: NonNullable<ServerConfigValues['access']>, origin: string): ServerConfigChange[] {
    const ctx = this.ctx;
    const prev = this.accessRecord();
    const next: ServerAccessRecord = { publicOrigin: access.publicOrigin?.origin ?? null, tailscaleLogins: tailscaleFingerprint(access.tailscaleLogins) };
    const changes: ServerConfigChange[] = [];
    if (prev.publicOrigin !== next.publicOrigin) {
      const where = access.publicOrigin?.source === 'flag' ? '--public-origin' : origin;
      ctx.activity({
        kind: 'settings',
        actor: OPERATOR,
        text: next.publicOrigin ? `${where}: 공개 주소를 바꿈 (${prev.publicOrigin ?? '없음'} → ${next.publicOrigin})` : `${where}: 공개 주소를 없앰 (${prev.publicOrigin}) — 이 PC 안(루프백)에서만 받습니다`,
      });
      changes.push({ item: 'network.publicOrigin', text: next.publicOrigin ? `공개 주소 → ${next.publicOrigin}` : '공개 주소 → 없음 (이 PC 안에서만 받습니다)' });
    }
    const a = prev.tailscaleLogins;
    const b = next.tailscaleLogins;
    if ((a?.digest ?? null) !== (b?.digest ?? null)) {
      const [did, shown] = !b
        ? ['받는 Tailscale 사용자 검사를 끔', '끔 (Tailscale-User-Login 머리를 보지 않습니다)']
        : !a
          ? [`받는 Tailscale 사용자 검사를 켬 (${b.count}명)`, `켬 (${b.count}명)`]
          : a.count !== b.count
            ? [`받는 Tailscale 사용자 목록을 바꿈 (${a.count}명 → ${b.count}명)`, `${b.count}명 (앞 ${a.count}명)`]
            : [`받는 Tailscale 사용자 목록을 바꿈 (${b.count}명, 수는 같음)`, `목록이 바뀜 (${b.count}명)`];
      ctx.activity({ kind: 'settings', actor: OPERATOR, text: `${origin}: ${did}` });
      changes.push({ item: 'owner.tailscaleLogins', text: `받는 Tailscale 사용자 → ${shown}` });
    }
    if (changes.length) ctx.store.kv.set(ACCESS_KEY, next satisfies ServerAccessRecord);
    return changes;
  }

  status(): ServerAuthStatus {
    const rec = this.ownerEmailRecord();
    const owner = this.core.auth.owner();
    const until = this.setupCodes.activeUntil();
    const g = this.google();
    const cli = this.ctx.settings().cli;
    return {
      ownerEmail: rec?.email ?? null,
      ownerEmailSource: rec?.source ?? null,
      ownerRegistered: owner !== null && owner.sub !== TEST_OWNER.sub,
      setupCodeExpiresAt: until === null ? null : new Date(until).toISOString(),
      google: { clientId: g.clientId || null, secretSet: g.secretSet },
      cli: { claudePath: cli.claudePath ?? null, codexPath: cli.codexPath ?? null },
      deviceSessions: this.core.deviceSessions.list().length,
      seat: this.core.seat.policy(),
    };
  }

  // ───── 기기 코드 로그인 (S3-5) ─────

  private googleOptions() {
    const g = this.ctx.deps.googleDevice;
    return { endpoints: g?.endpoints, fetchImpl: g?.fetchImpl, now: () => this.ctx.clock.ms() };
  }

  /** 기기 코드 로그인 시작 (auth.deviceLogin, 로그인 전) */
  async startDeviceLogin(caller: RemoteCaller, deviceName: unknown): Promise<DeviceLoginStart> {
    this.requireServer();
    const ctx = this.ctx;
    if (deviceName !== undefined && deviceName !== null && typeof deviceName !== 'string') throw new BackendError('invalid_args', '기기 이름은 글이어야 합니다');
    // 브라우저 로그인은 공개 주소로 온 요청만 받는다 — 루프백 주소에 실은 쿠키는 같은 PC의 다른 프로그램에도 간다 (S3-31). 구글에 묻지도 자리를 쓰지도 않는다
    if (caller.loginRefusal) throw new BackendError('forbidden', caller.loginRefusal);
    const config = await this.loginConfig();
    if (!config.ok) throw new BackendError('not_configured', config.message);
    // 시작 횟수는 호출자마다 센다 — 기기 세션이 있으면 그 세션, 없으면 Tailscale 사용자(없으면 이름 없는 쪽 하나). 로그인 전 쿠키(__Host-wos_login)로는 세지 않는다:
    // 시작마다 새로 나가고 아무 값이나 지어 보낼 수 있어, 그것으로 세면 쿠키를 버리거나 지어내 횟수 제한을 피한다. 이 호출자(쿠키)가 앞서 시작한 기다림은
    // 새 시작이 대신한다 — 같은 화면에서 다시 시작해도 자리를 막지 않게.
    // 기다림의 자리는 묶음마다 2개까지다 — 묶음은 Tailscale 사용자, 머리가 없으면 'local' (S3-22). 대표가 아닌 쪽 하나가 모든 자리를 쥐지 못한다
    const bucket = caller.session ? caller.clientKey : caller.tailscaleLogin ? `tailscale:${caller.tailscaleLogin}` : 'anonymous';
    const holder = caller.tailscaleLogin ? `tailscale:${caller.tailscaleLogin.toLowerCase()}` : 'local';
    const admission = this.flows.admit(bucket, callerKeys(caller), holder);
    if (!admission.ok) {
      throw new BackendError(
        'rate_limited',
        admission.reason === 'rate'
          ? `로그인 시작이 너무 잦습니다 (1분에 ${DEVICE_LOGIN_LIMITS.startsPerWindow}번까지) — 잠시 뒤 다시 시작하세요`
          : admission.reason === 'bucket'
            ? `${caller.tailscaleLogin ? '이 Tailscale 사용자로' : 'Tailscale을 거치지 않은 접속으로'} 진행 중인 기기 코드 로그인이 이미 ${DEVICE_LOGIN_LIMITS.maxPendingPerBucket}개입니다 — 그 로그인이 끝나거나 10분이 지나면 다시 시작할 수 있습니다`
            : `진행 중인 기기 코드 로그인이 이미 ${DEVICE_LOGIN_LIMITS.maxPending}개입니다 — 끝나거나 10분이 지나면 다시 시작할 수 있습니다`,
      );
    }
    let grant;
    try {
      grant = await requestDeviceCode(config.clientId, this.googleOptions());
    } catch (error) {
      const message = error instanceof GoogleLoginError ? error.message : '구글 기기 코드를 받지 못했습니다';
      ctx.log('warn', `기기 코드 로그인 시작 실패 [${error instanceof GoogleLoginError ? error.code : 'unknown'}]`);
      throw new BackendError('login_failed', message);
    }
    // 결과는 이 호출자에게만: 기기 세션이 있으면 그 세션 열쇠, 없으면 새 로그인 전 쿠키(__Host-wos_login)의 열쇠
    const clientKey = !caller.session && caller.newLoginKey ? caller.newLoginKey() : caller.clientKey;
    const login = this.flows.add(clientKey, grant, cleanDeviceName(deviceName), holder);
    return {
      loginId: login.loginId,
      userCode: login.userCode,
      verificationUrl: login.verificationUrl,
      expiresAt: new Date(login.expiresAt).toISOString(),
      intervalSec: login.intervalSec,
    };
  }

  /** 기기 코드 로그인 결과 묻기 (auth.deviceLoginPoll, 로그인 전) — 그 로그인을 시작한 호출자만 찾는다 */
  async pollDeviceLogin(caller: RemoteCaller, loginId: unknown): Promise<DeviceLoginPoll> {
    this.requireServer();
    if (typeof loginId !== 'string' || !loginId || loginId.length > 100) throw new BackendError('invalid_args', '로그인 ID가 필요합니다');
    // 루프백 주소로 온 묻기는 다른 곳에서 시작한 로그인이라도 세션을 주지 않는다 (S3-31) — 구글에 묻지 않고 그 로그인은 그대로 둔다(공개 주소에서 물으면 된다)
    if (caller.loginRefusal) throw new BackendError('forbidden', caller.loginRefusal);
    // 로그인 전 쿠키가 여럿 왔으면(형제 기계가 던진 쿠키가 앞에) 그 가운데 어느 값으로 시작한 로그인이든 찾는다 (S3-38)
    const login = this.flows.find(loginId, callerKeys(caller));
    if (!login) throw new BackendError('not_found', '그 로그인을 찾을 수 없습니다 — 끝났거나 이 화면에서 시작한 로그인이 아닙니다. 다시 시작하세요');
    const step = this.flows.next(login);
    if (step === 'done') return this.replay(login, caller);
    if (step === 'wait') return pendingReply(login);
    try {
      return await this.askGoogle(caller, login);
    } catch (error) {
      // 예기치 않은 실패도 그 로그인을 끝낸다 — 묻는 중 표시가 남아 영영 기다리지 않게
      this.ctx.log('error', '기기 코드 로그인 결과를 처리하지 못했습니다', error);
      return this.flows.finish(login, { status: 'error', message: '로그인 결과를 처리하지 못했습니다 — 다시 시작하세요' });
    }
  }

  /** 끝난 로그인을 다시 물으면 같은 답 — 'ok'면 그 호출자의 지금 상태를 붙인다(세션 값은 다시 주지 않는다) */
  private replay(login: PendingDeviceLogin, caller: RemoteCaller): DeviceLoginPoll {
    const outcome = login.outcome!;
    return outcome.status === 'ok' ? { status: 'ok', auth: this.core.auth.state(caller) } : outcome;
  }

  private async askGoogle(caller: RemoteCaller, login: PendingDeviceLogin): Promise<DeviceLoginPoll> {
    const ctx = this.ctx;
    // 그사이 설정이 빠졌으면(보안 비밀을 지움, OS 보안 저장소를 읽지 못함) 그 항목을 말하고 끝낸다 — 시작 때와 같은 글 (S3-28)
    const config = await this.loginConfig();
    if (!config.ok) return this.flows.finish(login, { status: 'error', message: config.message });
    let result;
    try {
      result = await pollDeviceToken({ clientId: config.clientId, clientSecret: config.secret, deviceCode: login.deviceCode }, this.googleOptions());
    } catch (error) {
      const e = error instanceof GoogleLoginError ? error : null;
      if (e?.code === 'network') {
        // 잠깐 닿지 못했다 — 기다림 그대로, 다음 확인 때 다시 묻는다
        this.flows.waitMore(login, false);
        return pendingReply(login, '구글 서버에 잠시 닿지 못했습니다 — 계속 확인합니다');
      }
      ctx.log('warn', `기기 코드 로그인 실패 [${e?.code ?? 'unknown'}]`);
      ctx.activity({ kind: 'auth', level: 'warn', text: `기기 코드 로그인 실패: ${e?.message ?? '구글 응답을 처리하지 못함'}` });
      return this.flows.finish(login, { status: 'error', message: `${e?.message ?? '구글 로그인 결과를 처리하지 못했습니다'} — 다시 시작하세요` });
    }
    switch (result.kind) {
      case 'pending':
        this.flows.waitMore(login, false);
        return pendingReply(login);
      case 'slow_down':
        this.flows.waitMore(login, true);
        return pendingReply(login);
      case 'denied':
        return this.flows.finish(login, { status: 'denied', message: '구글 로그인을 허락하지 않았습니다 — 다시 시작할 수 있습니다' });
      case 'expired':
        return this.flows.finish(login, { status: 'expired', message: '로그인 코드가 끝났습니다 — 다시 시작하세요' });
      case 'ok':
        return this.complete(caller, login, result.profile);
    }
  }

  /** 구글이 확인한 계정 — 대표 이메일·등록된 sub를 본 뒤 기기 세션을 그 응답에 싣는다 */
  private complete(caller: RemoteCaller, login: PendingDeviceLogin, profile: { sub: string; email: string; name: string }): DeviceLoginPoll {
    const ctx = this.ctx;
    const ownerEmail = this.ownerEmail()!;
    const domain = `@${profile.email.split('@').pop() ?? '?'}`;
    if (!sameEmail(profile.email, ownerEmail)) {
      ctx.activity({ kind: 'auth', level: 'warn', text: `기기 코드 로그인 거부: 대표 이메일이 아닌 구글 계정 (${domain})` });
      return this.flows.finish(login, { status: 'denied', message: '대표 계정이 아닌 구글 계정이라 로그인하지 않았습니다 — 대표 구글 계정으로 다시 시작하세요' });
    }
    const owner = this.core.auth.owner();
    const registered = owner && owner.sub !== TEST_OWNER.sub ? owner : null;
    if (registered && registered.sub !== profile.sub) {
      ctx.activity({ kind: 'auth', level: 'warn', text: `기기 코드 로그인 거부: 대표 이메일은 같지만 처음 등록한 구글 계정이 아님 (${domain})` });
      // 되는 길을 말한다 (S3-29): 등록된 계정이 다른 이메일이면(같은 데이터 폴더의 데스크톱 앱이 등록) 운영자가 config owner-email을 다시 실행하면 풀린다.
      // 같은 이메일의 다른 계정이면 그 실행으로는 풀리지 않는다 — 처음 등록한 계정으로 로그인하거나, 운영자가 대표 이메일을 바꿨다가 되돌려야 한다
      return this.flows.finish(login, {
        status: 'denied',
        message: sameEmail(registered.email, ownerEmail)
          ? '대표 이메일은 맞지만 처음 등록한 구글 계정이 아닙니다 — 처음 등록한 구글 계정으로 로그인하세요. 그 계정을 더 쓰지 않으면 서버 PC의 운영자가 대표 이메일을 다른 이메일로 바꿨다가 되돌려 등록을 풀어야 합니다'
          : '대표 이메일은 맞지만 이 서버에는 다른 이메일의 구글 계정이 대표로 등록되어 있습니다 — 서버 PC의 운영자가 wook-server config owner-email로 대표 이메일을 다시 정하면 그 등록이 풀리고, 그다음 로그인한 대표 계정이 등록됩니다',
      });
    }
    const { owner: recorded, registered: fresh } = this.core.auth.recordDeviceOwner(profile);
    const { token, session } = this.core.deviceSessions.issue({ deviceName: login.deviceName, tailscaleLogin: caller.tailscaleLogin ?? null });
    // 세션 값은 이 응답의 쿠키로만 나간다 — 본문·기록에 넣지 않는다 (S3-4)
    caller.grantSession?.({ token, absoluteExpiresAt: session.absoluteExpiresAt });
    ctx.activity({
      kind: 'auth',
      actor: OWNER,
      text: fresh ? `대표 등록 및 로그인 (${recorded.email}) — 기기 코드 로그인, 기기 ${session.deviceName}` : `대표 로그인 — 기기 코드 로그인, 새 기기 ${session.deviceName}`,
    });
    const when = new Date(Date.parse(session.createdAt)).toLocaleString('ko-KR');
    ctx.notify({
      level: 'normal',
      title: '새 기기 로그인',
      body: [
        `${session.deviceName} 기기가 로그인했습니다.`,
        `Tailscale 사용자: ${session.tailscaleLogin ?? '알 수 없음 (Tailscale을 거치지 않은 접속)'}`,
        `로그인 시각: ${when}`,
        '대표님이 한 로그인이 아니면 내 계정의 기기 목록에서 이 기기를 바로 끊으세요.',
      ].join('\n'),
      link: { tab: 'settings', section: 'account' },
      key: `device-login:${session.id}`,
    });
    ctx.bus.changed();
    this.flows.finish(login, { status: 'ok' });
    return { status: 'ok', auth: this.core.auth.state({ ...caller, session: deviceSessionView(session, session.id) }) };
  }
}
