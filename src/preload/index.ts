/**
 * window.wook (WookBridge) — 데스크톱 허용 목록(DESKTOP_METHODS·IPC_TOPICS)에 있는 이름만 통과시킨다.
 * 데스크톱 허용 목록은 대표 메서드(OWNER_METHODS)와 운영자 로컬 메서드다 (SERVER_DESIGN 2.5). 대표 권한에서 뺀 메서드는 IPC를 보내지 않고
 * `forbidden`으로 거부한다 — main 쪽 Backend.invoke도 같은 목록으로 다시 거부하고 기록한다.
 * sandbox: true 로 실행되므로 'electron'과 공용 IPC 상수만 쓴다 (빌드 결과는 CommonJS 한 파일).
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { DESKTOP_METHODS, IPC_INVOKE_CHANNEL, IPC_METHODS, IPC_TOPICS, IPC_TOPIC_PREFIX, type WookBridge } from '@shared/ipc';

const METHODS: ReadonlySet<string> = new Set<string>(DESKTOP_METHODS);
/**
 * 화면 약속에는 있지만 대표 권한에서 뺀 메서드 (메인 도구·운영자로 옮긴 것 — 내부 API가 같은 처리기를 쓴다). 기능 자체를 없앤 메서드는 화면
 * 약속에서 지웠으므로 여기 없고, 다른 모르는 이름처럼 unknown_method다 (리드 결정 21)
 */
const REMOVED: ReadonlySet<string> = new Set<string>(IPC_METHODS.filter((m) => !METHODS.has(m)));
const TOPICS: ReadonlySet<string> = new Set<string>(IPC_TOPICS);

type WookError = Error & { code: string };

function wookError(code: string, message: string): WookError {
  const error = new Error(message) as WookError;
  error.name = 'WookError';
  error.code = code;
  return error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** main 응답 { ok, value } | { ok: false, error } 풀기 */
function unwrapResponse(response: unknown): unknown {
  if (isRecord(response) && response['ok'] === true) return response['value'];
  if (isRecord(response) && response['ok'] === false && isRecord(response['error'])) {
    const { code, message } = response['error'];
    if (typeof message === 'string' && message.length > 0) {
      throw wookError(typeof code === 'string' ? code : 'unknown', message);
    }
  }
  throw wookError('bad_response', '프로그램 내부 응답 형식이 올바르지 않습니다.');
}

async function invoke(method: unknown, ...args: unknown[]): Promise<unknown> {
  if (typeof method === 'string' && REMOVED.has(method)) {
    throw wookError('forbidden', '대표 화면에서 하는 일이 아닙니다. 팀 운영·설정·작업 조작은 메인 에이전트가 맡습니다 — 명령창으로 메인 에이전트에게 말하세요.');
  }
  if (typeof method !== 'string' || !METHODS.has(method)) {
    throw wookError('unknown_method', '허용되지 않은 요청입니다.');
  }
  let response: unknown;
  try {
    response = await ipcRenderer.invoke(IPC_INVOKE_CHANNEL, method, args);
  } catch (error) {
    // 복제할 수 없는 인자이거나 main 처리기가 없을 때
    console.error(`[욱채] IPC 호출 실패: ${method}`, error);
    throw wookError('ipc_failed', '프로그램 내부 통신에 실패했습니다. 잠시 후 다시 시도해 주세요.');
  }
  return unwrapResponse(response);
}

function subscribe(topic: unknown, cb: unknown): () => void {
  if (typeof topic !== 'string' || !TOPICS.has(topic)) {
    throw wookError('unknown_topic', '허용되지 않은 구독입니다.');
  }
  if (typeof cb !== 'function') {
    throw wookError('invalid_callback', '구독 처리 함수가 필요합니다.');
  }
  const channel = IPC_TOPIC_PREFIX + topic;
  // 화면에는 내용만 넘긴다 (event 객체는 ipcRenderer에 닿을 수 있어 넘기지 않음)
  const listener = (_event: IpcRendererEvent, payload: unknown): void => {
    try {
      (cb as (payload: unknown) => void)(payload);
    } catch (error) {
      // 한 구독자의 오류가 같은 주제의 다른 구독자를 막지 않게
      console.error(`[욱채] '${topic}' 구독 처리 중 오류`, error);
    }
  };
  ipcRenderer.on(channel, listener);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    ipcRenderer.removeListener(channel, listener);
  };
}

const platform: WookBridge['platform'] = process.platform === 'win32' || process.platform === 'darwin' ? process.platform : 'linux';

const bridge: WookBridge = {
  invoke: invoke as WookBridge['invoke'],
  subscribe: subscribe as WookBridge['subscribe'],
  platform,
};

contextBridge.exposeInMainWorld('wook', bridge);
