/**
 * 같은 요청은 한 번만 (리드 결정 S3-9, SERVER_DESIGN 3.4·9.1 AC-45): 원격 호출자(서버 HTTP)의 상태를 바꾸는 대표 요청은 (기기 세션, 요청 ID)마다 한 번만
 * 처리하고, 첫 결과(성공한 값이든 거부·오류든)를 DB(request_replies)에 24시간 남긴다. 같은 ID가 다시 오면 처리하지 않고 저장한 답을 그대로 준다 —
 * 휴대폰이 네트워크가 끊겨 다시 보내도, 그사이 서버를 다시 시작해도 명령이 두 번 들어가지 않는다.
 * - 대상: REPLAY_METHODS (명령·질문 답변·결과 승인·수정 요청·정지 해제·기기 끊기). 긴급 정지는 여러 번 불러도 같아 넣지 않는다
 * - 같은 ID로 다른 요청(메서드나 인자가 다름)을 보내면 처리하지 않고 conflict — 새 요청을 저장한 답으로 조용히 덮지 않는다
 * - 첫 요청이 아직 처리 중이면 끝날 때까지 기다렸다가 그 답을 준다 (두 번 처리하지 않는다)
 * - 저장하는 것: 요청 ID와 인자의 SHA-256(원문은 두지 않는다 — 요청 ID에 무엇이 들어와도 DB에 남지 않게, AC-20), 메서드, 답(값 또는 오류 code·글).
 *   기록에는 남기지 않는다
 * 데스크톱 IPC는 요청 ID가 없어 이 길을 쓰지 않는다
 */
import { createHash } from 'node:crypto';
import type { WookMethod } from '@shared/ipc';
import type { Store } from '../db/store';
import { BackendError } from './types';

/** 같은 요청 ID를 한 번만 처리하는 대표 메서드 (S3-9) */
export const REPLAY_METHODS = ['command.send', 'questions.answer', 'reports.approve', 'reports.requestChanges', 'stop.release', 'auth.revokeDevice'] as const satisfies readonly WookMethod[];
const REPLAY_SET: ReadonlySet<string> = new Set<string>(REPLAY_METHODS);

export const isReplayMethod = (method: string): boolean => REPLAY_SET.has(method);

/** 답을 남기는 시간 (24시간) */
export const REPLY_KEEP_MS = 24 * 60 * 60 * 1000;

/** 저장한 답 — 값이 없는 성공(void)은 value 칸이 없다 (HTTP 본문 `{ok:true}`와 같게) */
export type ReplyOutcome = { ok: true; value?: unknown } | { ok: false; code: string; message: string };

export const REQUEST_ID_REUSED = '이 요청 ID는 다른 요청에 이미 썼습니다 — 새 요청에는 새 ID를 쓰세요 (처리하지 않았습니다)';

/** 인자의 지문 — 같은 ID로 다른 요청이 왔는지 가린다. 원문은 저장하지 않는다 */
export function argsDigest(args: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(args) ?? '', 'utf8').digest('hex');
}

/** 요청 ID → 저장 열쇠 (원문은 저장하지 않는다) */
const requestKey = (requestId: string): string => createHash('sha256').update(requestId, 'utf8').digest('hex');

export interface ReplayOnce {
  sessionId: string;
  requestId: string;
  method: string;
  digest: string;
  /** 처음 온 요청의 처리 */
  run(): Promise<unknown>;
  /** 처리가 던진 것 → 저장할 답 (게이트가 invokeCore와 같은 답을 만든다) */
  outcomeOfError(error: unknown): ReplyOutcome;
}

export interface RequestReplies {
  /** 처음이면 처리하고 답을 남긴다. 저장한 답이 있으면 처리하지 않고 그 답 — 성공이면 값, 거부·오류면 같은 code·글의 BackendError */
  once(o: ReplayOnce): Promise<unknown>;
  /** 24시간이 지난 답을 지운다 — 지운 수 */
  sweep(): number;
}

export interface RequestRepliesOptions {
  store: Pick<Store, 'requestReplies'>;
  /** 벽시계 (epoch ms) */
  now?: () => number;
  keepMs?: number;
  /** 답을 저장하지 못했을 때 (처리는 이미 끝났다 — 답은 그대로 준다) */
  onSaveError?(error: unknown): void;
}

export function createRequestReplies(o: RequestRepliesOptions): RequestReplies {
  const repo = o.store.requestReplies;
  const now = o.now ?? Date.now;
  const keepMs = o.keepMs ?? REPLY_KEEP_MS;
  const inflight = new Map<string, Promise<unknown>>();
  const cutoff = (): string => new Date(now() - keepMs).toISOString();

  const replay = (stored: { method: string; argsDigest: string; outcome: ReplyOutcome }, x: ReplayOnce): unknown => {
    if (stored.method !== x.method || stored.argsDigest !== x.digest) throw new BackendError('conflict', REQUEST_ID_REUSED);
    if (stored.outcome.ok) return stored.outcome.value;
    throw new BackendError(stored.outcome.code, stored.outcome.message);
  };

  const save = (x: ReplayOnce, rid: string, outcome: ReplyOutcome): void => {
    try {
      repo.purgeOlderThan(cutoff());
      repo.insert({ sessionId: x.sessionId, requestId: rid, method: x.method, argsDigest: x.digest, outcome, createdAt: new Date(now()).toISOString() });
    } catch (error) {
      o.onSaveError?.(error);
    }
  };

  return {
    async once(x) {
      const rid = requestKey(x.requestId);
      const key = `${x.sessionId}\n${rid}`;
      for (;;) {
        const stored = repo.get(x.sessionId, rid, cutoff());
        if (stored) return replay(stored, x);
        const running = inflight.get(key);
        if (!running) break;
        // 첫 요청이 처리 중 — 끝나면 저장한 답을 본다
        await running.catch(() => undefined);
        if (!repo.get(x.sessionId, rid, cutoff())) {
          // 저장하지 못했으면(저장소 오류) 첫 요청의 결과를 그대로 따른다 — 두 번 처리하지 않는다
          return running;
        }
      }
      const task = (async () => {
        try {
          const value = await x.run();
          save(x, rid, value === undefined ? { ok: true } : { ok: true, value });
          return value;
        } catch (error) {
          save(x, rid, x.outcomeOfError(error));
          throw error;
        }
      })();
      inflight.set(key, task);
      try {
        return await task;
      } finally {
        inflight.delete(key);
      }
    },
    sweep: () => repo.purgeOlderThan(cutoff()),
  };
}
