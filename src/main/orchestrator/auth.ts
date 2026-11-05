/**
 * 대표 로그인 (15.1). 처음 로그인한 구글 계정을 대표로 등록하고 이후 다른 계정은 거부한다 (AUTH-03).
 * 로그아웃해도 작업은 계속되고 화면 접근만 막힌다 (AUTH-04).
 *
 * 대표 기록에는 구글 계정만 들어간다. 개발 모드 로그인은 세션만 남기고(dev) 대표 자리를 차지하지 않으며,
 * 개발 모드 로그인을 받지 않는 실행(deps.allowDevLogin false — 패키징된 데스크톱, 서버)은 그 세션을 인정하지 않는다 —
 * 개발 실행과 같은 앱 데이터 폴더를 써도 구글 로그인을 건너뛰지 못한다 (SERVER_DESIGN 3.5, S2-2).
 * 대표는 설정만으로 갇히지 않는다 (AC-01): 구글 설정이 대표 로그인으로 확인되지 않았으면 로그인 화면이 설정을 다시 받는다 (googleSetupOpen).
 *
 * 서버 모드(deps.mode 'server', 리드 결정 S3-2)는 kv `auth.session`을 읽지도 쓰지도 않는다. 로그인은 호출자마다 — 원격 호출자(RemoteCaller)가
 * 지금 등록된 대표의 살아 있는 기기 세션을 가졌는지다 (S3-3, auth/deviceSessions.ts). 로그아웃은 그 기기 세션만 끊는다 (S3-4). 서버의 기기 코드 로그인·대표
 * 이메일·설정 코드는 serverLogin.ts가 맡고(S3-5·S3-6), 대표 기록은 여기(recordDeviceOwner·clearOwner)로 쓴다
 */
import type { Owner } from '@shared/domain';
import { OPERATOR, OWNER } from '@shared/domain';
import type { AuthState, DeviceSessionView } from '@shared/views';
import { BackendError, type RemoteCaller, type TestSessionGrant } from '../backend/types';
import { SECRET_KEYS } from '../auth/types';
import { deviceSessionView, sessionExpiresAt } from '../auth/deviceSessions';
import type { Core } from './core';

const OWNER_KEY = 'owner';
const SESSION_KEY = 'auth.session';
/** 구글 로그인 설정(클라이언트 ID·보안 비밀)을 바꾼 차례 — 바꾸기 직전에 올린다 (markGoogleChanged) */
const GOOGLE_REV_KEY = 'auth.google.rev';
/** 대표 로그인에 성공한 설정의 차례 — GOOGLE_REV_KEY와 같으면 지금 설정이 대표 로그인으로 확인된 것이다 */
const GOOGLE_PROVEN_KEY = 'auth.google.provenRev';
/** 예전 개발 모드 로그인이 대표 자리에 남긴 값. 구글 계정이 아니라서 등록된 대표로 보지 않는다 */
const DEV_SUB = 'dev-local';
const DEV_PROFILE = { email: 'dev@localhost', name: '대표(개발 모드)' };
/**
 * 시험용 대표 (S3-4): 등록된 대표가 없을 때 --allow-test-session 서버의 운영자 시험 세션이 만든다. 구글 계정이 아니다 — 시험용 서버에서만 생긴다.
 * 그 데이터 폴더의 실제 대표를 정하는 일은 운영자 몫이다 (대표 이메일, S3-6)
 */
export const TEST_OWNER = { sub: 'operator-test', email: 'operator-test@wook.local', name: '시험용 대표' } as const;
/** 운영자 시험 세션의 기기 이름 (S3-4) */
export const TEST_SESSION_DEVICE = '운영자 시험 세션';
/** 서버 모드에서 쓰지 않는 데스크톱 로그인 길을 거부하는 글 (S3-2) */
export const SERVER_BROWSER_LOGIN = '서버에 접속한 화면은 이 PC의 브라우저 로그인을 쓰지 않습니다 — 기기 코드로 로그인합니다';
export const SERVER_DEV_LOGIN = '서버에는 개발 모드 로그인이 없습니다 — 기기 코드로 로그인합니다';

interface Session {
  sub: string;
  at: string;
  /** 개발 모드 로그인 세션 (개발 모드 로그인을 받는 실행에서만 유효 — devLoginAllowed) */
  dev?: boolean;
}

export class AuthService {
  constructor(private readonly core: Core) {}

  private get ctx() {
    return this.core.ctx;
  }

  /** 서버 모드 (S3-2) — kv `auth.session`을 쓰지 않는다 */
  private serverMode(): boolean {
    return this.ctx.deps.mode === 'server';
  }

  /**
   * 개발 모드 로그인을 받는지 (SERVER_DESIGN 3.5, S2-2): 패키징 여부(isPackaged)가 아니라 deps.allowDevLogin을 본다. 서버 모드는 늘 끈다 (S3-2).
   * 이 칸 없이 손으로 의존성을 만든 예전 시험 하네스(`as OrchestratorDeps`)는 예전 판정(!isPackaged)을 따른다
   */
  private devLoginAllowed(): boolean {
    if (this.serverMode()) return false;
    return this.ctx.deps.allowDevLogin ?? !this.ctx.deps.isPackaged;
  }

  /** 등록된 대표 (구글 계정). 아직 없으면 null — 처음 로그인한 구글 계정이 대표가 된다 */
  owner(): Owner | null {
    const o = this.ctx.store.kv.get<Owner>(OWNER_KEY);
    return o && o.sub !== DEV_SUB ? o : null;
  }

  /**
   * 로그인했는지. caller: 원격 호출자(서버 HTTP, S3-3) — 그 호출자의 기기 세션이 지금 등록된 대표의 살아 있는 세션인지만 본다.
   * 호출자가 없으면 데스크톱 길(kv `auth.session`, 예전 그대로) — 서버 모드에서는 늘 false다 (S3-2)
   */
  isLoggedIn(caller?: RemoteCaller): boolean {
    if (caller) return !!caller.session && this.core.deviceSessions.live(caller.session.id) !== null;
    if (this.serverMode()) return false;
    const s = this.ctx.store.kv.get<Session | null>(SESSION_KEY);
    if (!s) return false;
    if (s.dev || s.sub === DEV_SUB) return this.devLoginAllowed();
    const o = this.owner();
    return !!o && s.sub === o.sub;
  }

  /** 로그인 상태. caller가 있거나 서버 모드면 그 호출자의 상태다 (S3-3 — 호출자 없는 서버 요청은 세션 없음) */
  state(caller?: RemoteCaller): AuthState {
    if (caller || this.serverMode()) return this.remoteState(caller);
    const o = this.owner();
    const logged = this.isLoggedIn();
    const account = this.ctx.settings().account;
    return {
      loggedIn: logged,
      owner: !logged ? null : o ? { email: o.email, name: o.name } : { ...DEV_PROFILE },
      googleConfigured: !!account.googleClientId.trim(),
      googleSecretSet: !!account.googleClientSecretSet,
      ownerRegistered: o !== null,
      devLoginAllowed: this.devLoginAllowed(),
      googleSetupOpen: this.googleSetupOpen(),
    };
  }

  /**
   * 원격 호출자의 로그인 상태 (S3-3): 기기 코드 로그인과 기기별 세션(mode 'server'). 개발 모드 로그인은 없고, 구글 설정은 운영자가 서버에서 넣으므로
   * 로그인 화면이 설정을 받지 않는다(googleSetupOpen false). 서버 모드의 구글 설정은 서버의 기기 코드 로그인 클라이언트이고, 대표 이메일이 정해지기
   * 전이면 setupRequired다 (S3-6, serverLogin.ts)
   */
  private remoteState(caller?: RemoteCaller): AuthState {
    const o = this.owner();
    const logged = caller ? this.isLoggedIn(caller) : false;
    const account = this.ctx.settings().account;
    const server = this.serverMode() ? this.core.serverLogin : null;
    return {
      loggedIn: logged,
      owner: logged && o ? { email: o.email, name: o.name } : null,
      googleConfigured: server ? server.googleConfigured() : !!account.googleClientId.trim(),
      googleSecretSet: server ? server.googleSecretSet() : !!account.googleClientSecretSet,
      ownerRegistered: o !== null,
      devLoginAllowed: false,
      googleSetupOpen: false,
      mode: 'server',
      ...(server ? { setupRequired: server.setupRequired() } : {}),
    };
  }

  private googleRev(): number {
    return this.ctx.store.kv.get<number>(GOOGLE_REV_KEY) ?? 0;
  }

  /** 지금 구글 로그인 설정이 대표 로그인으로 확인됐는지 (마지막 대표 로그인 뒤 바뀌지 않았는지). 예전 기록(차례 없음)은 확인된 것으로 본다 */
  googleProven(): boolean {
    return (this.ctx.store.kv.get<number>(GOOGLE_PROVEN_KEY) ?? 0) === this.googleRev();
  }

  /**
   * 구글 로그인 설정을 바꾸기 직전에 부른다 — 바꾼 값은 대표 로그인으로 확인될 때까지 '확인 안 됨'이고 그동안 로그인 화면이 설정을 다시 받는다.
   * 바꾸기 전에 올리므로 그 사이에 앱이 꺼져도 확인 안 됨으로 남는다 (확인 안 됨은 설정 입력란이 더 열릴 뿐 대표를 가두지 않는다)
   */
  markGoogleChanged(): void {
    this.ctx.store.kv.set(GOOGLE_REV_KEY, this.googleRev() + 1);
  }

  /**
   * 로그인 없이 구글 로그인 설정(api.isGoogleSetupCall: 클라이언트 ID·보안 비밀)을 받는지 (AUTH-01·03, ENV-04, AC-01). 대표 등록 전, 그리고
   * 대표가 있어도 지금 설정이 대표 로그인으로 확인되지 않았을 때 — 클라이언트 ID가 없거나, 마지막 대표 로그인 뒤 바뀌었거나(잘못 넣은 ID·비밀),
   * 등록해 둔 보안 비밀이 OS 보안 저장소에서 사라졌을 때(syncSecretFlag가 바뀐 것으로 표시). 그렇지 않으면 대표가 로그아웃한 뒤 다시 들어올
   * 길이 없다 — 패키징 실행에는 개발 모드 로그인이 없고 운영 설정 화면은 로그인이 필요하다. 로그인은 그래도 등록된 대표의 구글 계정으로만
   * 된다(establish) — 다른 사람이 설정을 바꿔도 얻는 것이 없다. 대표 로그인에 성공한 설정은 다시 닫힌다 — 로그아웃 중 다른 사람이 확인된
   * 설정을 바꿔 대표를 막지 못하게
   */
  googleSetupOpen(): boolean {
    if (!this.owner()) return true;
    return !this.ctx.settings().account.googleClientId.trim() || !this.googleProven();
  }

  /**
   * 등록됨으로 적힌 구글 보안 비밀이 OS 보안 저장소에 없으면(저장소가 지워짐 등) 등록 안 됨으로 맞추고 설정이 바뀐 것으로 표시한다 — 로그인
   * 화면이 설정을 다시 받게 (googleSetupOpen). 시작할 때와 로그인할 때 부른다. 저장소를 읽지 못하면 그대로 둔다
   */
  async syncSecretFlag(stored?: string | null): Promise<void> {
    const ctx = this.ctx;
    if (!ctx.settings().account.googleClientSecretSet) return;
    let value = stored;
    if (value === undefined) {
      try {
        value = await ctx.deps.secrets.get(SECRET_KEYS.googleClientSecret);
      } catch (e) {
        ctx.log('warn', '구글 로그인 보안 비밀을 OS 보안 저장소에서 읽지 못했습니다', e);
        return;
      }
    }
    if (value?.trim()) return;
    this.markGoogleChanged();
    const s = ctx.settings();
    ctx.saveSettings({ ...s, account: { ...s.account, googleClientSecretSet: false } });
    ctx.activity({ kind: 'auth', level: 'warn', text: '구글 로그인 보안 비밀이 OS 보안 저장소에 없어 등록 안 됨으로 바꿨습니다 — 로그인 화면에서 다시 등록할 수 있습니다' });
  }

  /** 대표 로그인 확정. provenRev: 이 로그인에 쓴 구글 설정의 차례 — 대표로 로그인했으니 그 설정이 확인됐다 */
  private establish(profile: { sub: string; email: string; name: string }, provenRev: number): AuthState {
    const ctx = this.ctx;
    const existing = this.owner();
    if (existing && existing.sub !== profile.sub) {
      ctx.activity({ kind: 'auth', level: 'warn', text: `대표가 아닌 계정의 로그인 거부: ${profile.email}` });
      throw new BackendError('forbidden', `대표 계정(${existing.email})만 로그인할 수 있습니다`);
    }
    const now = ctx.now();
    const owner: Owner = existing ? { ...existing, email: profile.email, name: profile.name, lastLoginAt: now } : { ...profile, registeredAt: now, lastLoginAt: now };
    ctx.store.kv.set(OWNER_KEY, owner);
    ctx.store.kv.set(SESSION_KEY, { sub: owner.sub, at: now } satisfies Session);
    ctx.store.kv.set(GOOGLE_PROVEN_KEY, provenRev);
    ctx.activity({ kind: 'auth', actor: OWNER, text: existing ? `대표 로그인 (${owner.email})` : `대표 등록 및 로그인 (${owner.email})` });
    ctx.bus.changed();
    return this.state();
  }

  async login(): Promise<AuthState> {
    const ctx = this.ctx;
    // 서버 모드는 이 PC의 브라우저 로그인(루프백)을 쓰지 않고 kv 대표 세션도 쓰지 않는다 (S3-2)
    if (this.serverMode()) throw new BackendError('forbidden', SERVER_BROWSER_LOGIN);
    // 안내는 로그인 화면만 가리킨다 — 운영 설정 화면은 로그인이 필요하다 (로그인 화면은 googleSetupOpen이면 설정 입력란을 보여 준다)
    const setupHint = this.owner()
      ? '로그인 화면의 구글 로그인 설정에서 OAuth 클라이언트 ID와 보안 비밀을 다시 등록하세요 (로그인 없이 등록할 수 있고, 등록된 대표 계정으로만 로그인됩니다)'
      : 'OAuth 클라이언트 ID와 보안 비밀을 먼저 등록하세요 (대표가 등록되기 전에는 로그인하지 않고 등록할 수 있습니다)';
    const clientId = ctx.settings().account.googleClientId.trim();
    if (!clientId) throw new BackendError('not_configured', `구글 로그인 설정(OAuth 클라이언트 ID)이 없습니다. ${setupHint}`);
    if (!ctx.deps.googleLogin || !ctx.deps.shell) throw new BackendError('not_ready', '구글 로그인을 사용할 수 없는 환경입니다');
    // 로그인을 시작할 때의 설정 차례 — 대표 로그인에 성공하면 이 설정이 확인된 것이다 (그사이 바뀌었으면 바뀐 설정은 확인 안 됨으로 남는다)
    const rev = this.googleRev();
    const secret = await ctx.deps.secrets.get(SECRET_KEYS.googleClientSecret);
    if (!secret?.trim() && ctx.settings().account.googleClientSecretSet) {
      await this.syncSecretFlag(secret);
      throw new BackendError('not_configured', `등록해 둔 구글 로그인 보안 비밀이 OS 보안 저장소에 없습니다. ${setupHint}`);
    }
    const shell = ctx.deps.shell;
    let profile;
    try {
      profile = await ctx.deps.googleLogin({ clientId, clientSecret: secret, openExternal: (url) => shell.openExternal(url) });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      ctx.activity({ kind: 'auth', level: 'warn', text: `구글 로그인 실패: ${msg}` });
      // 마지막 대표 로그인 뒤 바꾼 설정이면 그 설정이 틀렸을 수 있다 — 로그인 화면에서 다시 넣을 수 있다 (googleSetupOpen)
      const unproven = this.owner() && !this.googleProven() ? ` 마지막 로그인 뒤 바꾼 구글 로그인 설정이 맞지 않을 수 있습니다. ${setupHint}` : '';
      throw new BackendError('login_failed', `구글 로그인 실패: ${msg}${unproven}`);
    }
    if (!profile.emailVerified) throw new BackendError('login_failed', '이메일 인증이 안 된 구글 계정입니다');
    // 대표로 로그인하면 이 로그인에 쓴 구글 설정이 확인된다 — 로그인 없이 받던 설정 입력은 (그사이 바뀌지 않았으면) 다시 닫힌다
    return this.establish({ sub: profile.sub, email: profile.email, name: profile.name }, rev);
  }

  /**
   * 개발 모드 로그인 (개발 모드 로그인을 받는 실행에서만 — devLoginAllowed). 대표를 등록하지 않는다 — 등록하면 그 뒤 실제 대표의 구글 로그인이 거부된다.
   * 구글 대표가 이미 있으면 그 대표로 화면을 연다. 서버 모드에는 없다 (S3-2)
   */
  devLogin(): AuthState {
    const ctx = this.ctx;
    if (this.serverMode()) throw new BackendError('forbidden', SERVER_DEV_LOGIN);
    if (!this.devLoginAllowed()) throw new BackendError('forbidden', '개발 모드 로그인은 개발 실행에서만 쓸 수 있습니다');
    const o = this.owner();
    ctx.store.kv.set(SESSION_KEY, { sub: o?.sub ?? DEV_SUB, at: ctx.now(), dev: true } satisfies Session);
    ctx.activity({ kind: 'auth', actor: OWNER, text: o ? `개발 모드 로그인 (대표 ${o.email})` : '개발 모드 로그인 (구글 대표 등록 전 — 처음 로그인한 구글 계정이 대표가 됩니다)' });
    ctx.bus.changed();
    return this.state();
  }

  logout(): AuthState {
    const ctx = this.ctx;
    // 서버 모드의 로그아웃은 그 기기 세션만 끊는다(logoutDevice) — kv 대표 세션은 쓰지 않는다 (S3-2·S3-4)
    if (this.serverMode()) throw new BackendError('forbidden', '서버 접속의 로그아웃은 그 기기 세션만 끊습니다');
    ctx.store.kv.set(SESSION_KEY, null);
    ctx.activity({ kind: 'auth', actor: OWNER, text: '대표 로그아웃 (진행 중인 작업은 계속됨)' });
    ctx.bus.changed();
    return this.state();
  }

  // ───── 기기 세션 (서버 모드, S3-4) ─────

  /**
   * 기기 코드 로그인으로 확인한 대표를 적는다 (서버 모드, S3-5 — serverLogin.ts가 대표 이메일과 등록된 sub를 본 뒤에만 부른다). 등록된 구글 대표가 없으면
   * (시험용 대표 포함) 이 계정이 대표가 된다 — 처음 맞는 로그인이 sub를 등록한다. kv `auth.session`은 쓰지 않는다. registered: 이번에 새로 등록했는지
   */
  recordDeviceOwner(profile: { sub: string; email: string; name: string }): { owner: Owner; registered: boolean } {
    const now = this.ctx.now();
    const existing = this.owner();
    const same = existing && existing.sub === profile.sub ? existing : null;
    const owner: Owner = same ? { ...same, email: profile.email, name: profile.name, lastLoginAt: now } : { ...profile, registeredAt: now, lastLoginAt: now };
    this.ctx.store.kv.set(OWNER_KEY, owner);
    return { owner, registered: !same };
  }

  /** 등록된 대표를 지운다 (서버 모드 — 대표 이메일이 바뀜, S3-6). 그 대표의 기기 세션은 저절로 죽는다 (deviceSessions — 대표 sub로 판정) */
  clearOwner(): boolean {
    if (!this.ctx.store.kv.get<Owner | null>(OWNER_KEY)) return false;
    this.ctx.store.kv.set(OWNER_KEY, null);
    return true;
  }

  /** 이 기기만 로그아웃 (S3-4): 그 호출자의 기기 세션을 끊는다. 다른 기기는 그대로이고 진행 중인 작업도 계속된다 (AUTH-04) */
  logoutDevice(caller: RemoteCaller): AuthState {
    const ctx = this.ctx;
    const ended = caller.session ? this.core.deviceSessions.revoke(caller.session.id, OWNER) : null;
    if (ended) {
      ctx.activity({ kind: 'auth', actor: OWNER, text: `대표 로그아웃 — 이 기기(${ended.deviceName})만 (다른 기기와 진행 중인 작업은 그대로)` });
      ctx.bus.changed();
    }
    return this.remoteState({ ...caller, session: null });
  }

  /** 대표의 살아 있는 기기 세션 목록 — 부른 기기에 표시 (S3-4) */
  listDevices(caller: RemoteCaller): DeviceSessionView[] {
    const current = caller.session?.id ?? null;
    return this.core.deviceSessions.list().map((r) => deviceSessionView(r, current));
  }

  /** 기기 세션 하나를 끊는다 (S3-4) — 그 세션의 SSE도 닫힌다. 없거나 이미 끝났으면 not_found */
  revokeDevice(caller: RemoteCaller, sessionId: unknown): DeviceSessionView[] {
    const ctx = this.ctx;
    if (typeof sessionId !== 'string' || !sessionId) throw new BackendError('invalid_args', '끊을 기기 세션 ID가 필요합니다');
    const ended = this.core.deviceSessions.revoke(sessionId, OWNER);
    if (!ended) throw new BackendError('not_found', '그 기기 세션이 없거나 이미 끝났습니다');
    const self = ended.id === caller.session?.id;
    ctx.activity({ kind: 'auth', actor: OWNER, text: `기기 세션 끊음: ${ended.deviceName}${self ? ' (이 기기)' : ''}` });
    ctx.bus.changed();
    return this.listDevices(caller);
  }

  /**
   * 운영자 시험 세션 (S3-4, 관리 채널 `session test` — --allow-test-session 서버만 부른다): 등록된 대표의 실제 기기 세션을 연다. 등록된 대표가 없으면
   * 시험용 대표(TEST_OWNER)를 만들고 활동 기록에 그렇게 적는다. 행위자는 operator. kv `auth.session`은 건드리지 않는다
   */
  openTestSession(): TestSessionGrant {
    const ctx = this.ctx;
    let owner = this.owner();
    const ownerCreated = owner === null;
    if (!owner) {
      owner = { ...TEST_OWNER, registeredAt: ctx.now(), lastLoginAt: null };
      ctx.store.kv.set(OWNER_KEY, owner);
    }
    const { token, session } = this.core.deviceSessions.issue({ deviceName: TEST_SESSION_DEVICE, tailscaleLogin: null });
    ctx.activity({
      kind: 'auth',
      actor: OPERATOR,
      text: ownerCreated
        ? `운영자 시험 세션 발급 — 등록된 대표가 없어 시험용 대표(${owner.email})를 만들었습니다 (--allow-test-session)`
        : `운영자 시험 세션 발급 (대표 ${owner.email})`,
    });
    ctx.bus.changed();
    return { token, expiresAt: new Date(sessionExpiresAt(session)).toISOString(), sessionId: session.id, ownerCreated };
  }
}
