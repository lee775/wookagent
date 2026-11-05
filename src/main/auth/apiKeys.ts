/**
 * API 키 방식(account.authMode = 'api_key')의 상태 확인 (리드 결정 16).
 * - 턴은 등록된 키를 환경 변수로 받는다(turns.ts): claude는 ANTHROPIC_API_KEY, codex는 OPENAI_API_KEY. CLI 상태 확인(detect)도 같은 변수를 넣어야
 *   구독 로그인이 없는 PC에서 로그인 상태가 맞게 나온다 — 앱 조립(buildDeps)이 어댑터의 statusEnv로 넣는다
 * - statusEnv는 동기 함수라 키를 메모리 사본(ApiKeyCache)에 둔다. 시작 때 registerStoredSecrets가 OS 보안 저장소에서 채우고, settings.setApiKey가 바꾸거나
 *   지운다. 키 값은 활동 기록·알림·모델이 보는 글에 넣지 않는다 (가리개에는 이미 등록돼 있다)
 */
import type { AiKind } from '@shared/domain';
import { SECRET_KEYS, type SecretStore } from './types';

/** 턴과 상태 확인이 키를 넣는 환경 변수 (turns.ts의 턴 환경과 같아야 한다) */
export const API_KEY_ENV: Readonly<Record<AiKind, string>> = { claude: 'ANTHROPIC_API_KEY', codex: 'OPENAI_API_KEY' };

/** OS 보안 저장소의 키 이름 */
export const API_KEY_SECRET: Readonly<Record<AiKind, string>> = { claude: SECRET_KEYS.apiKeyClaude, codex: SECRET_KEYS.apiKeyCodex };

export type AuthMode = 'subscription' | 'api_key';

/** 등록된 API 키의 메모리 사본 */
export interface ApiKeyCache {
  get(kind: AiKind): string | null;
  /** 빈 값·null이면 지운다 */
  set(kind: AiKind, key: string | null | undefined): void;
}

export function createApiKeyCache(): ApiKeyCache {
  const keys = new Map<AiKind, string>();
  return {
    get: (kind) => keys.get(kind) ?? null,
    set: (kind, key) => {
      const value = key?.trim();
      if (value) keys.set(kind, value);
      else keys.delete(kind);
    },
  };
}

/** 상태 확인에 더할 환경: API 키 방식이고 키가 있으면 턴과 같은 변수, 아니면 없음 */
export function apiKeyStatusEnv(kind: AiKind, mode: AuthMode, key: string | null): Record<string, string> {
  return mode === 'api_key' && key ? { [API_KEY_ENV[kind]]: key } : {};
}

/**
 * 상태 확인의 로그인 여부를 재로그인 필요 판정에 쓸 값으로 바꾼다. API 키 방식이고 키가 등록돼 있으면 '로그인 안 됨'(false)은 알 수 없음(null)으로 본다 —
 * 구독 로그인이 없어도 턴은 키로 돌고, 키가 맞는지는 실제 턴만 안다(틀린 키면 그 턴이 auth_required로 끝나 다시 건다). 시작 때 CLI 확인과
 * system.recheckAi가 함께 쓴다
 */
export async function loginStateForAuth(kind: AiKind, loggedIn: boolean | null, mode: AuthMode, secrets: SecretStore): Promise<boolean | null> {
  if (loggedIn !== false || mode !== 'api_key') return loggedIn;
  let key: string | null = null;
  try {
    key = await secrets.get(API_KEY_SECRET[kind]);
  } catch {
    key = null; // 저장소를 읽지 못하면 키가 없는 것으로 본다 — 상태 확인 결과 그대로
  }
  return key?.trim() ? null : false;
}
