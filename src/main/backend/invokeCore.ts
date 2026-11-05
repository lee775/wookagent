/**
 * 대표 요청 처리의 Electron과 무관한 부분 (SERVER_DESIGN 3.4, S2-8): 데스크톱 IPC(shell/ipc.ts)와 서버 HTTP(`POST /api/invoke`)가 같이 쓴다.
 * - 허용 목록(IPC_METHODS)에 없는 메서드와 배열이 아닌 인자는 백엔드를 부르지 않고 거부한다
 * - 응답은 늘 { ok, value } | { ok: false, error } — 예외를 밖으로 던지지 않는다
 * - BackendError(다른 모듈 사본도 이름·code로 판별)는 code·한국어 메시지를 그대로, 그 밖의 오류는 internal과 일반 메시지로 바꾼다
 * - 인자는 기록하지 않는다 — API 키 같은 비밀 값을 담을 수 있다 (SEC-10). 메서드 이름만 남긴다
 * - 원격 호출자(서버 HTTP)면 부른 쪽이 정한 글(모르는 메서드 이름, 인자를 되풀이하는 오류 메시지)도 기록하지 않는다 (S2-13, omitCallerText)
 * 발신자 확인(데스크톱의 메인 창, 서버의 연결별 세션)은 길마다 이 앞에서 한다
 */
import { IPC_METHODS, type WookErrorPayload, type WookMethod, type WookParams } from '@shared/ipc';
import { BackendError, type Backend, type RemoteCaller } from './types';
import type { Logger } from '../shell/logger';

export type InvokeResponse = { ok: true; value: unknown } | { ok: false; error: WookErrorPayload };

/** 길과 무관한 거부 응답 (데스크톱 IPC_ERRORS도 이것을 담는다) */
export const INVOKE_ERRORS = {
  unknownMethod: { code: 'unknown_method', message: '허용되지 않은 요청입니다.' },
  invalidArgs: { code: 'invalid_args', message: '요청 형식이 올바르지 않습니다.' },
  backendUnavailable: {
    code: 'backend_unavailable',
    message: '프로그램 핵심 기능을 시작하지 못했습니다. 프로그램을 다시 시작해 주세요.',
  },
  internal: { code: 'internal', message: '요청을 처리하는 중 문제가 발생했습니다. 잠시 후 다시 시도해 주세요.' },
} as const satisfies Record<string, WookErrorPayload>;

const METHODS: ReadonlySet<string> = new Set<string>(IPC_METHODS);

/** 기록에 쓰는 메서드 이름 (문자열이 아니면 그 형식만, 길면 자른다) */
export function methodLabel(method: unknown): string {
  return typeof method === 'string' ? method.slice(0, 80) : `(${typeof method})`;
}

export function isBackendError(error: unknown): error is BackendError {
  if (error instanceof BackendError) return true;
  // 모듈이 두 번 적재돼도 같은 오류로 본다
  return (
    error instanceof Error &&
    error.name === 'BackendError' &&
    typeof (error as { code?: unknown }).code === 'string' &&
    error.message.length > 0
  );
}

export const failResponse = (error: WookErrorPayload): InvokeResponse => ({ ok: false, error: { code: error.code, message: error.message } });

export interface InvokeCoreDeps {
  /** 백엔드 준비 전에 온 요청은 준비될 때까지 기다린다 */
  backend: Pick<Backend, 'invoke'> | Promise<Pick<Backend, 'invoke'>>;
  logger: Logger;
  /** 기록에 붙는 길 이름 ('IPC', 'HTTP') */
  channel: string;
  /**
   * 부른 쪽이 정한 글을 기록에 넣지 않는다 (S2-13) — 서버 HTTP처럼 호출자가 원격이면 켠다. 기록에는 아는 메서드 이름(모르면 '(알 수 없는 메서드)')과
   * 오류 code만 남기고, 오류 메시지(not_found 글은 인자를 되풀이한다)·인자·요청 ID는 남기지 않는다. 응답 본문은 그대로 메시지를 담는다.
   * 데스크톱 IPC는 호출자가 이 PC의 화면이라 끄고 예전 기록 그대로다
   */
  omitCallerText?: boolean;
}

/** 원격 호출자의 모르는 메서드 이름 대신 기록에 쓰는 말 */
export const UNKNOWN_METHOD_LABEL = '(알 수 없는 메서드)';

/**
 * 오류의 스택 줄만 (메시지 없이) — 메시지가 부른 쪽의 글을 담을 수 있을 때 기록에 쓴다. 메시지 안의 줄바꿈이 스택 줄처럼 보이지 않게 머리(`이름: 메시지`)를
 * 통째로 떼고 본다. 머리가 맞지 않으면(만든 뒤 메시지를 바꿈) 아무것도 남기지 않는다
 */
function stackFrames(error: unknown): string {
  if (!(error instanceof Error) || typeof error.stack !== 'string') return '';
  const header = error.message ? `${error.name}: ${error.message}` : error.name;
  if (!error.stack.startsWith(header)) return '';
  return error.stack
    .slice(header.length)
    .split('\n')
    .filter((l) => /^\s+at /.test(l))
    .join('\n');
}

/** (메서드, 인자[, 원격 호출자]) → 응답. 발신자는 이미 확인했다고 본다 — 서버 HTTP는 확인한 기기 세션으로 만든 호출자를 넘긴다 (S3-3) */
export function createInvokeCore(deps: InvokeCoreDeps) {
  const { logger, channel } = deps;
  const omit = deps.omitCallerText === true;
  return async (method: unknown, args: unknown, caller?: RemoteCaller): Promise<InvokeResponse> => {
    const name = methodLabel(method);
    if (typeof method !== 'string' || !METHODS.has(method)) {
      logger.warn(`허용 목록에 없는 ${channel} 메서드를 거부했습니다: ${omit ? UNKNOWN_METHOD_LABEL : name}`);
      return failResponse(INVOKE_ERRORS.unknownMethod);
    }
    if (!Array.isArray(args)) {
      logger.warn(`${channel} 인자 형식 오류: ${name}`);
      return failResponse(INVOKE_ERRORS.invalidArgs);
    }
    let backend: Pick<Backend, 'invoke'>;
    try {
      backend = await deps.backend;
    } catch (error) {
      logger.error(`백엔드를 쓸 수 없어 ${channel} 요청을 처리하지 못했습니다: ${name}`, error);
      return failResponse(INVOKE_ERRORS.backendUnavailable);
    }
    try {
      const value: unknown = caller
        ? await backend.invoke(method as WookMethod, args as WookParams<WookMethod>, caller)
        : await backend.invoke(method as WookMethod, args as WookParams<WookMethod>);
      return { ok: true, value };
    } catch (error) {
      if (isBackendError(error)) {
        // 인자는 비밀 값(API 키 등)을 담을 수 있어 남기지 않는다. 원격 호출자면 메시지도 — 메시지가 인자를 되풀이할 수 있다 (S2-13)
        logger.warn(omit ? `${channel} 요청 실패: ${name} [${error.code}]` : `${channel} 요청 실패: ${name} [${error.code}] ${error.message}`);
        return failResponse({ code: error.code, message: error.message });
      }
      if (omit) {
        // 오류 종류와 스택 줄만 — 메시지에 부른 쪽의 글이 섞일 수 있다 (S2-13)
        const kind = error instanceof Error ? error.name : typeof error;
        logger.error(`${channel} 요청 처리 중 예기치 않은 오류: ${name} [internal] ${kind}`, stackFrames(error));
      } else {
        logger.error(`${channel} 요청 처리 중 예기치 않은 오류: ${name}`, error);
      }
      return failResponse(INVOKE_ERRORS.internal);
    }
  };
}
