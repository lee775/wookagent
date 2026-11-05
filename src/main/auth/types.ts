/**
 * 구글 로그인·비밀 값 저장 계약 (15.1, SEC-09, CLI-14).
 * - 로그인: 시스템 기본 브라우저 + 루프백 임시 주소(127.0.0.1) + PKCE (AUTH-05). 내장 웹 화면 금지
 * - 비밀 값: OS 보안 저장소 (Windows 자격 증명 관리자, macOS 키체인) — @napi-rs/keyring
 * - CLI 구독 로그인 토큰은 읽거나 복사하지 않는다 (CLI-14)
 * 구현: ./googleAuth.ts 의 googleLogin(), ./secretStore.ts 의 createSecretStore()
 */

export interface GoogleProfile {
  /** 구글 계정 고유 ID */
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string;
}

export interface GoogleLoginOptions {
  clientId: string;
  /** 데스크톱 앱 클라이언트 보안 비밀 (구글 데스크톱 OAuth는 비밀이 아님을 전제로 하지만 키체인에 보관) */
  clientSecret: string | null;
  /** 시스템 기본 브라우저로 열기 (Electron shell.openExternal) */
  openExternal: (url: string) => Promise<void>;
  /** 기본 5분 */
  timeoutMs?: number;
  /** 테스트용 주입 */
  fetchImpl?: typeof fetch;
  /** 테스트용: 인증 URL을 받는 즉시 호출 */
  onAuthUrl?: (url: string) => void;
}

export class GoogleLoginError extends Error {
  /** network: 구글 서버에 닿지 못함(연결 실패·5xx) — 기기 코드 로그인은 다음 확인 때 다시 묻는다 (googleDevice.ts) */
  constructor(
    public readonly code: 'timeout' | 'denied' | 'state_mismatch' | 'token_exchange' | 'invalid_token' | 'email_unverified' | 'cancelled' | 'network',
    message: string,
  ) {
    super(message);
    this.name = 'GoogleLoginError';
  }
}

export interface SecretStore {
  readonly backend: 'keyring' | 'memory';
  /** OS 보안 저장소를 못 써서 메모리로 대신할 때 그 이유 (secretStore.ts). 서버 관리 채널 status가 보여 준다 (S2-4) */
  readonly fallbackReason?: string | null;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** 키 이름 */
export const SECRET_KEYS = {
  googleClientSecret: 'google-client-secret',
  /**
   * 서버의 기기 코드 로그인용 구글 클라이언트('TV 및 입력 제한 기기')의 보안 비밀 (S3-5·S3-8, 운영자 `wook-server secret set google-client-secret`).
   * 데스크톱 앱의 루프백 로그인 클라이언트('데스크톱 앱')와 종류가 달라 따로 둔다 — 같은 데이터 폴더를 쓰는 데스크톱 앱의 로그인을 덮어쓰지 않게
   */
  googleDeviceClientSecret: 'google-device-client-secret',
  ownerSession: 'owner-session',
  apiKeyClaude: 'api-key-claude',
  apiKeyCodex: 'api-key-codex',
} as const;
