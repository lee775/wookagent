/**
 * 원격 브리지 (SERVER_DESIGN 3.4 '원격 브리지', 리드 결정 S8-3·S8-4) — 서버가 내준 웹 화면의 `window.wook`. preload(`src/preload/index.ts`)와 모양이
 * 같고(invoke·subscribe·platform) 웹 도구(`web`)를 더 가진다. 서버용 빌드(VITE_WOOK_REMOTE=1)에서 install.ts가 화면보다 먼저 넣는다.
 * - invoke: `POST /api/invoke` `{id, method, args}` (X-Wook-Client: 1, 같은 출처 쿠키). 대표 메서드(OWNER_METHODS)만 보내고, 화면 약속에는 있지만 대표 권한
 *   밖인 것은 보내지 않고 `forbidden`, 모르는 이름은 `unknown_method`다(preload와 같은 글). 상태 코드와 관계없이 본문의 InvokeResponse를 풀고, 본문이
 *   InvokeResponse가 아니면(앞단의 502 쪽 등) `bad_response`, 연결 자체가 안 되면 `network`다
 * - 요청 ID는 논리적 호출마다 새 난수다(crypto.randomUUID) — 세는 수는 새로 고친 화면이 같은 ID를 다시 써 서버가 24시간 남긴 옛 답을 돌려준다.
 *   같은 ID는 같은 호출을 다시 보낼 때만 쓴다: 네트워크 실패·408·503에 한해, 보기 메서드와 같은 ID를 한 번만 처리하는 메서드와 긴급 정지만 두 번까지
 *   (0.5초·2초 뒤). 그 밖의 4xx(409 포함)와 다른 메서드는 다시 보내지 않는다. 429는 기다리지 않고 Retry-After를 오류 글에 넣는다
 * - subscribe: 토픽 6개(IPC_TOPICS)만, 구독자 오류는 다른 구독자를 막지 않는다. 이벤트 연결은 remoteEvents.ts
 * - web.upload: XMLHttpRequest로 `POST /api/uploads?name=`(올린 바이트 진행을 보려고), 다시 보내지 않는다. web.downloadUrl: 같은 출처의 `/api/…` 주소
 */
import {
  IPC_METHODS,
  IPC_TOPICS,
  OWNER_METHODS,
  type OwnerMethod,
  type WebDownloadTarget,
  type WebUploadedFile,
  type WebUploadOptions,
  type WookBridge,
  type WookTopic,
  type WookWebBridge,
} from '../../../shared/ipc';
import { createEventStream, type EventStream } from './remoteEvents';
import { browserEnv, isRecord, isWookError, retryAfterSeconds, wookError, type RemoteEnv, type WookError } from './remoteEnv';

const ALLOWED: ReadonlySet<string> = new Set<string>(OWNER_METHODS);
/** 화면 약속에는 있지만 대표 권한 밖인 메서드 — 보내지 않고 forbidden (preload의 REMOVED와 같은 규칙) */
const REMOVED: ReadonlySet<string> = new Set<string>(IPC_METHODS.filter((m) => !ALLOWED.has(m)));
const TOPICS: ReadonlySet<string> = new Set<string>(IPC_TOPICS);

/**
 * 같은 요청 ID로 다시 보내도 되는 메서드 (리드 결정 S8-4): 보기, 서버가 같은 ID를 한 번만 처리하는 것(requestReplies), 원래 여러 번 불러도 같은 긴급 정지.
 * auth.listDevices는 결정의 보기 이름 규칙(*.list…)에 들지 않지만 기기 목록을 읽기만 하는 보기라 넣었다
 */
export const RETRYABLE_METHODS: ReadonlySet<string> = new Set<OwnerMethod>([
  // 보기
  'auth.getState',
  'auth.deviceLoginPoll',
  'auth.listDevices',
  'snapshot.get',
  'members.getDetail',
  'members.getEvents',
  'command.history',
  'directives.get',
  'tasks.get',
  'tasks.getDiff',
  'reports.list',
  'reports.get',
  'notifications.list',
  'seat.get',
  'seat.history',
  'seat.handover',
  'journal.list',
  'recovery.list',
  'settings.get',
  'roles.list',
  'skills.list',
  'logs.search',
  'system.prereqs',
  'system.info',
  // 같은 ID를 한 번만 처리한다 (서버 requestReplies)
  'command.send',
  'questions.answer',
  'reports.approve',
  'reports.requestChanges',
  'stop.release',
  'auth.revokeDevice',
  // 여러 번 불러도 같다
  'stop.emergency',
]);

/** 다시 보내기 전 기다림 (두 번까지) */
export const INVOKE_RETRY_DELAYS_MS: readonly number[] = [500, 2_000];

/**
 * 다시 보내도 되는 요청 한 번의 시간 상한 — 서버가 연결은 받고 답하지 않으면(바쁘거나 멈춤) 요청이 끝없이 걸려, 명령창의 '보내기'가 꺼진 채 멈춰 있었다
 * (2026-11-18 대표 화면). 넘으면 끊고 네트워크 실패처럼 다시 보낸다(같은 요청 ID — 서버는 한 번만 처리한다). 다시 보낼 수 없는 요청에는 걸지 않는다 —
 * 끊으면 처리됐는지 알 수 없다
 */
export const INVOKE_TIMEOUT_MS = 30_000;

export const REMOTE_ERRORS = {
  forbidden: '대표 화면에서 하는 일이 아닙니다. 팀 운영·설정·작업 조작은 메인 에이전트가 맡습니다 — 명령창으로 메인 에이전트에게 말하세요.',
  unknownMethod: '허용되지 않은 요청입니다.',
  unknownTopic: '허용되지 않은 구독입니다.',
  invalidCallback: '구독 처리 함수가 필요합니다.',
  invalidArgs: '요청 인자를 서버로 보낼 수 있는 모양으로 바꾸지 못했습니다.',
  network: '서버에 연결하지 못했습니다 — 네트워크를 확인하고 다시 시도해 주세요.',
  timeout: '서버가 답하지 않습니다 — 서버가 바쁘거나 멈춘 것일 수 있습니다. 잠시 뒤 다시 시도해 주세요(보낸 명령은 이미 전달됐을 수 있으니 대화 기록을 먼저 확인해 주세요).',
  uploadNetwork: '파일을 올리지 못했습니다 — 연결을 확인하고 다시 올려 주세요.',
  aborted: '파일 올리기를 멈췄습니다.',
} as const;

const badResponse = (status: number): WookError =>
  wookError('bad_response', `서버의 응답을 읽지 못했습니다 (HTTP ${status}). 잠시 뒤 다시 시도해 주세요 — 계속되면 서버와 그 앞의 연결(tailscale serve)을 확인해 주세요.`);

/** InvokeResponse 풀기 (preload unwrapResponse와 같은 규칙). 429의 Retry-After는 글에 넣는다 */
function unwrap(body: unknown, status: number, retryAfterSec: number | null): unknown {
  if (isRecord(body) && body['ok'] === true) return body['value'];
  if (isRecord(body) && body['ok'] === false && isRecord(body['error'])) {
    const { code, message } = body['error'];
    if (typeof message === 'string' && message.length > 0) {
      const later = status === 429 && retryAfterSec !== null;
      const error = wookError(typeof code === 'string' ? code : 'unknown', later ? `${message} (${retryAfterSec}초 뒤에 다시 할 수 있습니다)` : message);
      if (later) error.retryAfterSec = retryAfterSec;
      throw error;
    }
  }
  throw badResponse(status);
}

function parseJson(text: string, status: number): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw badResponse(status);
  }
}

const loggedInOf = (auth: unknown): boolean | null => (isRecord(auth) && typeof auth['loggedIn'] === 'boolean' ? auth['loggedIn'] : null);

/** 답에서 알 수 있는 로그인 상태 (모르면 null) — 이벤트 연결을 그 상태로 다시 열지 정한다 */
function loginFactOf(method: string, value: unknown): boolean | null {
  switch (method) {
    case 'auth.getState':
    case 'auth.login':
    case 'auth.logout':
    case 'auth.setupOwner':
      return loggedInOf(value);
    case 'snapshot.get':
      return isRecord(value) ? loggedInOf(value['auth']) : null;
    case 'auth.deviceLoginPoll':
      return isRecord(value) && value['status'] === 'ok' ? (loggedInOf(value['auth']) ?? true) : null;
    default:
      return null;
  }
}

/** 내려받기 주소 (리드 결정 S8-4) — 모양이 맞는 대상만, 아니면 null */
export function downloadUrlFor(target: WebDownloadTarget): string | null {
  if (!isRecord(target)) return null;
  switch (target.kind) {
    case 'attachment':
      return typeof target.id === 'string' && /^A-\d+$/.test(target.id) ? `/api/attachments/${target.id}` : null;
    case 'reportFile':
      return typeof target.reportId === 'string' && /^R-\d+$/.test(target.reportId) ? `/api/reports/${target.reportId}/file` : null;
    case 'export': {
      if (typeof target.path !== 'string') return null;
      const name = target.path.split(/[\\/]/).pop() ?? '';
      if (name.length === 0 || name.includes('..') || name.includes('\0')) return null;
      return `/api/exports/${encodeURIComponent(name)}`;
    }
    default:
      return null;
  }
}

export interface RemoteBridge extends WookBridge {
  web: WookWebBridge;
  /** 연결·타이머를 모두 닫는다 (시험) */
  dispose(): void;
}

export function createRemoteBridge(envOverride?: Partial<RemoteEnv>): RemoteBridge {
  const env: RemoteEnv = { ...browserEnv(), ...envOverride };
  const listeners = Object.fromEntries(IPC_TOPICS.map((t) => [t, new Set<(payload: unknown) => void>()])) as Record<WookTopic, Set<(payload: unknown) => void>>;
  const events: EventStream = createEventStream({
    env,
    deliver(topic, payload) {
      for (const listener of [...listeners[topic]]) listener(payload);
    },
  });
  const sleep = (ms: number): Promise<void> => new Promise((done) => env.setTimeout(done, ms));

  /** 한 번 보내고 답을 푼다 — 다시 보내도 되는 메서드면 네트워크 실패·408·503에 같은 본문(같은 ID)으로 두 번까지 */
  const send = async (body: string, retryable: boolean): Promise<unknown> => {
    let everTimedOut = false;
    for (let tries = 0; ; tries++) {
      let status = 0;
      let retryAfter: number | null = null;
      let text: string | null = null;
      // 다시 보내도 되는 요청은 답을 기다리는 시간에 상한을 둔다 — 넘으면 끊는다 (INVOKE_TIMEOUT_MS)
      const abort = retryable && typeof AbortController === 'function' ? new AbortController() : null;
      let timedOut = false;
      const timer = abort
        ? env.setTimeout(() => {
            timedOut = true;
            abort.abort();
          }, INVOKE_TIMEOUT_MS)
        : null;
      try {
        const res = await env.fetch('/api/invoke', {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { 'Content-Type': 'application/json', 'X-Wook-Client': '1' },
          body,
          ...(abort ? { signal: abort.signal } : {}),
        });
        status = res.status;
        retryAfter = retryAfterSeconds(res.headers.get('retry-after'));
        text = await res.text();
      } catch {
        text = null;
      } finally {
        if (timer !== null) env.clearTimeout(timer);
      }
      everTimedOut = everTimedOut || timedOut;
      const transient = text === null || status === 408 || status === 503;
      if (transient && retryable && tries < INVOKE_RETRY_DELAYS_MS.length) {
        await sleep(INVOKE_RETRY_DELAYS_MS[tries]!);
        continue;
      }
      if (text === null) throw wookError('network', everTimedOut ? REMOTE_ERRORS.timeout : REMOTE_ERRORS.network);
      return unwrap(parseJson(text, status), status, retryAfter);
    }
  };

  const invoke = async (method: unknown, ...args: unknown[]): Promise<unknown> => {
    if (typeof method === 'string' && REMOVED.has(method)) throw wookError('forbidden', REMOTE_ERRORS.forbidden);
    if (typeof method !== 'string' || !ALLOWED.has(method)) throw wookError('unknown_method', REMOTE_ERRORS.unknownMethod);
    let body: string;
    try {
      // 요청 ID는 이 호출의 것 하나 — 다시 보낼 때도 같은 본문을 쓴다
      body = JSON.stringify({ id: env.randomId(), method, args });
    } catch {
      throw wookError('invalid_args', REMOTE_ERRORS.invalidArgs);
    }
    // 로그아웃·기기 끊기 중에 서버가 이벤트 연결을 닫을 수 있다 — 답을 볼 때까지 끊김으로 치지 않는다
    const finish = method === 'auth.logout' ? events.beginAuthCall('logout') : method === 'auth.revokeDevice' ? events.beginAuthCall('revoke') : null;
    let fact: boolean | null = null;
    try {
      const value = await send(body, RETRYABLE_METHODS.has(method));
      fact = loginFactOf(method, value);
      return value;
    } catch (error) {
      if (isWookError(error) && error.code === 'unauthorized') fact = false;
      throw error;
    } finally {
      if (finish) finish(fact);
      else if (fact !== null) events.noteLogin(fact);
    }
  };

  const subscribe = (topic: unknown, cb: unknown): (() => void) => {
    if (typeof topic !== 'string' || !TOPICS.has(topic)) throw wookError('unknown_topic', REMOTE_ERRORS.unknownTopic);
    if (typeof cb !== 'function') throw wookError('invalid_callback', REMOTE_ERRORS.invalidCallback);
    const listener = (payload: unknown): void => {
      try {
        (cb as (payload: unknown) => void)(payload);
      } catch (error) {
        // 한 구독자의 오류가 같은 주제의 다른 구독자를 막지 않게
        env.error(`[욱채] '${topic}' 구독 처리 중 오류`, error);
      }
    };
    const set = listeners[topic as WookTopic];
    set.add(listener);
    events.start();
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      set.delete(listener);
    };
  };

  const upload = (file: Blob, name: string, options: WebUploadOptions = {}): Promise<WebUploadedFile> =>
    new Promise<WebUploadedFile>((resolve, reject) => {
      const { signal, onProgress } = options;
      if (signal?.aborted) return reject(wookError('aborted', REMOTE_ERRORS.aborted));
      const xhr = env.createXhr();
      let settled = false;
      const progress = (sent: number, total: number): void => {
        try {
          onProgress?.(sent, total);
        } catch (error) {
          env.error('[욱채] 올리기 진행 처리 중 오류', error);
        }
      };
      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        fn();
      };
      const onAbort = (): void => {
        settle(() => reject(wookError('aborted', REMOTE_ERRORS.aborted)));
        xhr.abort();
      };
      xhr.open('POST', `/api/uploads?name=${encodeURIComponent(name)}`);
      xhr.setRequestHeader('X-Wook-Client', '1');
      xhr.upload.onprogress = (e: ProgressEvent) => {
        if (!settled) progress(e.loaded, e.lengthComputable ? e.total : file.size);
      };
      xhr.onload = () =>
        settle(() => {
          try {
            const value = unwrap(parseJson(xhr.responseText, xhr.status), xhr.status, retryAfterSeconds(xhr.getResponseHeader('Retry-After')));
            if (!isRecord(value) || typeof value['uploadId'] !== 'string' || typeof value['name'] !== 'string' || typeof value['size'] !== 'number' || typeof value['expiresAt'] !== 'string') {
              throw badResponse(xhr.status);
            }
            progress(file.size, file.size);
            resolve({ uploadId: value['uploadId'], name: value['name'], size: value['size'], expiresAt: value['expiresAt'] });
          } catch (error) {
            if (isWookError(error) && error.code === 'unauthorized') events.noteLogin(false);
            reject(error);
          }
        });
      xhr.onerror = () => settle(() => reject(wookError('network', REMOTE_ERRORS.uploadNetwork)));
      xhr.onabort = () => settle(() => reject(wookError('aborted', REMOTE_ERRORS.aborted)));
      signal?.addEventListener('abort', onAbort, { once: true });
      xhr.send(file);
    });

  const web: WookWebBridge = {
    onConnection: (cb) => events.onConnection(cb),
    watchMembers: (ids) => events.watchMembers(ids),
    onResync: (cb) => events.onResync(cb),
    upload,
    downloadUrl: downloadUrlFor,
  };

  return {
    invoke: invoke as WookBridge['invoke'],
    subscribe: subscribe as WookBridge['subscribe'],
    platform: 'web',
    web,
    dispose: () => events.dispose(),
  };
}
