/**
 * 원격 브리지가 쓰는 브라우저 기능 (리드 결정 S8-4) — 시험이 fetch·XHR·타이머·창 이벤트를 가짜로 바꿔 넣을 수 있게 한곳에 모은다.
 * 오류 모양도 여기 둔다: preload와 같이 `name='WookError'`와 `.code`를 가진 Error다
 */

export interface RemoteEnv {
  fetch(input: string, init: RequestInit): Promise<Response>;
  createXhr(): XMLHttpRequest;
  /** 요청 ID — 논리적 호출마다 새 난수(같은 호출을 다시 보낼 때만 같은 ID) */
  randomId(): string;
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /** 0 이상 1 미만 (다시 잇기 간격의 흔들림) */
  random(): number;
  /** 창(online, wook:authorized, wook:unauthorized)·문서(visibilitychange) 이벤트 듣기 — 끄는 함수를 돌려준다 */
  listen(target: 'window' | 'document', type: string, fn: () => void): () => void;
  /** 화면이 보이는지 (document.visibilityState) */
  visible(): boolean;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export type WookError = Error & { code: string; retryAfterSec?: number };

export function wookError(code: string, message: string): WookError {
  const error = new Error(message) as WookError;
  error.name = 'WookError';
  error.code = code;
  return error;
}

export function isWookError(value: unknown): value is WookError {
  return value instanceof Error && typeof (value as { code?: unknown }).code === 'string';
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Retry-After 머리(초) — 없거나 수가 아니면 null */
export function retryAfterSeconds(value: string | null): number | null {
  if (value === null || !/^\d{1,6}$/.test(value.trim())) return null;
  return Number(value.trim());
}

/** crypto.randomUUID가 없는 곳(안전하지 않은 출처)에서도 쓰는 v4 UUID */
function randomUuid(): string {
  const c = globalThis.crypto;
  if (typeof c.randomUUID === 'function') return c.randomUUID();
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** 실제 브라우저 */
export function browserEnv(): RemoteEnv {
  return {
    fetch: (input, init) => window.fetch(input, init),
    createXhr: () => new XMLHttpRequest(),
    randomId: randomUuid,
    now: () => Date.now(),
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (handle) => window.clearTimeout(handle as number),
    random: () => Math.random(),
    listen(target, type, fn) {
      const t: EventTarget = target === 'window' ? window : document;
      t.addEventListener(type, fn);
      return () => t.removeEventListener(type, fn);
    },
    visible: () => document.visibilityState !== 'hidden',
    warn: (...args) => console.warn(...args),
    error: (...args) => console.error(...args),
  };
}
