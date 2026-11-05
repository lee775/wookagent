/**
 * 화면 ↔ main IPC 연결 (ENV-02: 프로그램 내부 통신만).
 * - 요청: 발신자(메인 창 최상위 프레임)를 확인한 뒤 요청 처리 공용 부분(backend/invokeCore.ts — 허용 목록 IPC_METHODS·인자·오류 바꾸기·인자 기록 않기)으로.
 *   그 공용 부분은 서버 HTTP와 같이 쓴다 (SERVER_DESIGN 3.4, S2-8)
 * - 응답은 항상 { ok, value } | { ok: false, error } — IPC 너머로 예외를 던지지 않는다
 * - 푸시: backend.onTopic → webContents.send(IPC_TOPIC_PREFIX + topic)
 */
import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { IPC_INVOKE_CHANNEL, IPC_TOPICS, IPC_TOPIC_PREFIX, type WookErrorPayload, type WookTopic, type WookTopics } from '@shared/ipc';
import type { Backend } from '../backend/types';
import { createInvokeCore, failResponse, INVOKE_ERRORS, methodLabel, type InvokeResponse } from '../backend/invokeCore';
import type { Logger } from './logger';

export type { InvokeResponse } from '../backend/invokeCore';

export const IPC_ERRORS = {
  forbiddenSender: { code: 'forbidden_sender', message: '허용되지 않은 화면에서 온 요청이라 처리하지 않았습니다.' },
  ...INVOKE_ERRORS,
} as const satisfies Record<string, WookErrorPayload>;

/** 메인 창의 최상위 프레임이 앱 주소를 띄운 상태에서 보낸 요청만 받는다 */
export function isTrustedIpcSender(
  event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>,
  win: BrowserWindow | null,
  isAppUrl: (url: string) => boolean,
): boolean {
  if (!win || win.isDestroyed()) return false;
  if (event.sender !== win.webContents) return false;
  try {
    const frame = event.senderFrame;
    if (!frame || frame.parent !== null) return false;
    return isAppUrl(frame.url);
  } catch {
    // 이미 사라진 프레임 — 신뢰하지 않음
    return false;
  }
}

export interface InvokeHandlerDeps {
  /** 백엔드 준비 전에 온 요청은 준비될 때까지 기다린다 */
  backend: Backend | Promise<Backend>;
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean;
  logger: Logger;
}

export function createInvokeHandler(deps: InvokeHandlerDeps) {
  const invoke = createInvokeCore({ backend: deps.backend, logger: deps.logger, channel: 'IPC' });
  return async (event: IpcMainInvokeEvent, method: unknown, args: unknown): Promise<InvokeResponse> => {
    const name = methodLabel(method);
    let trusted: boolean;
    try {
      trusted = deps.isTrustedSender(event);
    } catch (error) {
      deps.logger.error(`IPC 발신자 확인 실패: ${name}`, error);
      trusted = false;
    }
    if (!trusted) {
      deps.logger.warn(`허용되지 않은 발신자의 IPC 요청을 거부했습니다: ${name}`);
      return failResponse(IPC_ERRORS.forbiddenSender);
    }
    return invoke(method, args);
  };
}

/** ipcMain에 요청 처리기를 건다. 반환 함수로 해제 */
export function registerInvokeHandler(deps: InvokeHandlerDeps): () => void {
  const handler = createInvokeHandler(deps);
  ipcMain.handle(IPC_INVOKE_CHANNEL, handler);
  return () => ipcMain.removeHandler(IPC_INVOKE_CHANNEL);
}

// 같은 긴급 정지 요약이 백엔드 푸시와 트레이·단축키 경로로 두 번 가지 않게 화면별 마지막 시각을 기억한다
const lastEmergencyAt = new WeakMap<object, string>();

/** 창이 살아 있을 때만 푸시. 보냈으면(또는 이미 보낸 긴급 정지 요약이면) true */
export function sendTopic<T extends WookTopic>(win: BrowserWindow | null, topic: T, payload: WookTopics[T], logger: Logger): boolean {
  if (!win || win.isDestroyed()) return false;
  const contents = win.webContents;
  if (contents.isDestroyed() || contents.isCrashed()) return false;
  const at: unknown = topic === 'emergency' ? (payload as { at?: unknown } | null)?.at : undefined;
  const emergencyAt = typeof at === 'string' && at.length > 0 ? at : null;
  if (emergencyAt !== null && lastEmergencyAt.get(contents) === emergencyAt) return true;
  try {
    contents.send(IPC_TOPIC_PREFIX + topic, payload);
    if (emergencyAt !== null) lastEmergencyAt.set(contents, emergencyAt);
    return true;
  } catch (error) {
    logger.error(`화면으로 '${topic}' 푸시 실패`, error);
    return false;
  }
}

/** 백엔드의 모든 푸시 주제를 창으로 전달한다. 반환 함수로 구독 해제 */
export function forwardTopics(deps: { backend: Pick<Backend, 'onTopic'>; getWindow: () => BrowserWindow | null; logger: Logger }): () => void {
  const unsubscribers = IPC_TOPICS.map((topic) =>
    deps.backend.onTopic(topic, (payload) => {
      sendTopic(deps.getWindow(), topic, payload, deps.logger);
    }),
  );
  return () => {
    for (const off of unsubscribers) {
      try {
        off();
      } catch (error) {
        deps.logger.error('푸시 구독 해제 실패', error);
      }
    }
  };
}
