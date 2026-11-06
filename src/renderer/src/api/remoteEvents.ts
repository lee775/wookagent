/**
 * 원격 브리지의 이벤트 연결 (리드 결정 S8-3·S8-4) — `GET /api/events`를 fetch 흐름으로 열어 두고, 끊기면 다시 잇는다.
 * - 감시: 바이트가 50초 오지 않으면(서버의 살아 있음 신호는 20초마다) 끊긴 것으로 본다
 * - 다시 잇기: 끊기면 ≈1·2·5·10·30초(흔들림 ±20%, 30초에서 멈춤) 뒤에 다시 연다. 429·503의 Retry-After가 더 길면 그만큼 기다린다. 온라인이 되거나
 *   화면이 다시 보이면 기다리지 않고 바로 연다. 다시 보일 때 30초 넘게 아무것도 오지 않은 연결은 죽은 것으로 보고 새로 연다(휴대폰 잠자기)
 * - 상태(WebConnectionState): 처음 여는 중·로그인 상태가 바뀌어 다시 여는 중은 connecting, 끊겨 다시 잇는 중은 reconnecting, 첫 이벤트(runId)가
 *   오면 open
 * - 보는 팀원(?members=): watchMembers가 목록을 통째로 바꾼다. 바뀌면 새 연결을 먼저 열고 그 연결의 첫 바이트가 오면 그 연결로 바꾼다 — 빈틈이 없다.
 *   옛 연결은 바로 닫지 않고 WATCH_DRAIN_MS 동안 더 듣는다(리드 결정 S8-26 a): 새 연결이 받아 들여지기 전에 서버가 옛 연결로만 보낸 알림·CLI 이벤트가
 *   늦게 와도 건넨다. 그동안 옛 연결의 스냅숏은 건네지 않고(새 연결의 것이 가장 새것), 두 연결로 함께 온 것은 처음 것만 건넨다 — 알림은 ID,
 *   CLI 이벤트는 (팀원, turnId, seq), 그 밖의 토픽은 같은 data. 옛 연결이 끝나도 끊김이 아니고, 끊김·로그인 상태 바뀜·dispose에는 바로 닫는다.
 *   물러나는 연결은 하나만 둔다(HTTP/1.1의 연결 수). 잦은 호출은 0.2초 모아서 한 번.
 *   watchMembers가 돌려주는 약속(리드 결정 S8-17)은 그 팀원을 모두 싣는 연결의 첫 바이트가 왔을 때 풀린다(서버가 그 연결을 받아 들인 뒤라, 그 뒤의 이벤트는
 *   연결로 온다 — 화면은 그때 한 번 더 읽어 처음 읽은 때와의 틈을 채운다). 지금 연결이 이미 싣고 있으면 바로, 뒤의 watchMembers가 목록을 바꾸면 그때,
 *   끊겨서 onResync가 올 때(열린 적이 있는 연결이 끊김)는 끊긴 때 풀린다. 열린 적이 없어 onResync가 오지 않는 끊김에서는 다시 이어진 연결의 첫 바이트까지
 *   기다린다. 거부하지 않고, dispose하면 모두 풀린다
 * - 로그인 상태: 연결은 연 때의 호출자로 계속 걸러지므로(로그인 전에 연 연결은 로그인 뒤에도 업무 내용을 받지 못한다) 로그인 상태가 바뀌면 다시 연다.
 *   연결의 로그인 상태는 그 연결의 스냅숏 `auth.loggedIn`이고, 화면이 아는 로그인 상태는 요청의 답(auth.*·snapshot.get·unauthorized 오류)과 창 이벤트
 *   wook:authorized·wook:unauthorized다. 연결을 연 뒤에 알게 된 상태가 연결의 것과 다르면 옛 연결을 바로 닫고(로그인 전 스냅숏이 로그인한 화면을
 *   덮지 않게) 새로 연다 — connecting이고 끊김이 아니다(onResync 없음). 로그아웃·기기 끊기 요청 중에 서버가 연결을 닫으면 그 답이 올 때까지(5초까지)
 *   끊김으로 치지 않는다
 * - onResync: 연결이 끊겼다가 다시 이어진 뒤, 새 연결의 첫 스냅숏을 snapshot 구독자에게 건넨 다음 한 번 부른다(처음 연결과 일부러 다시 연 때는 부르지 않는다)
 */
import { IPC_TOPICS, type WebConnectionState, type WebResyncInfo, type WookTopic } from '../../../shared/ipc';
import { createSseParser } from './remoteSse';
import { isRecord, retryAfterSeconds, type RemoteEnv } from './remoteEnv';

/** 바이트가 이만큼 오지 않으면 끊긴 것으로 본다 (서버 살아 있음 신호 20초) */
export const SSE_WATCHDOG_MS = 50_000;
/** 다시 잇기 간격 (시도마다, 마지막 값에서 멈춘다) */
export const RECONNECT_DELAYS_MS: readonly number[] = [1_000, 2_000, 5_000, 10_000, 30_000];
/** 보는 팀원이 바뀐 뒤 다시 열기까지 모으는 시간 */
export const WATCH_DEBOUNCE_MS = 200;
/** 보는 팀원을 바꾼 뒤 옛 연결을 더 듣는 시간 — 새 연결의 첫 바이트부터 (S8-26 a) */
export const WATCH_DRAIN_MS = 3_000;
/** 두 연결로 같은 것이 오면 하나만 건네려고 기억하는 수 — 넘으면 오래된 것부터 잊는다 (S8-26 a) */
export const DELIVERED_MEMORY = 4_096;
/** 로그아웃·기기 끊기 요청 중에 닫힌 연결을 끊김으로 치기 전 기다리는 상한 */
export const AUTH_HOLD_MS = 5_000;
/** 화면이 다시 보일 때 이만큼 조용했던 연결은 죽은 것으로 본다 */
export const STALE_ON_VISIBLE_MS = 30_000;
/** ?members= 상한 (서버와 같다) */
export const MAX_WATCHED_MEMBERS = 50;
const MEMBER_ID_RE = /^M-(?:\d{4,9}|MAIN)$/;
const TOPICS: ReadonlySet<string> = new Set<string>(IPC_TOPICS);

type Purpose = 'connect' | 'reconnect' | 'watch' | 'auth';

interface Stream {
  readonly id: number;
  readonly controller: AbortController;
  readonly membersKey: string;
  /** 이 연결이 싣는 팀원 (membersKey를 나눈 것) */
  readonly members: ReadonlySet<string>;
  readonly purpose: Purpose;
  /** 연 때의 차례 — 그 뒤에 알게 된 로그인 상태와만 견준다 */
  readonly openSeq: number;
  /** 첫 바이트가 왔음 (서버가 연결을 받아 들였다) */
  connected: boolean;
  lastByteAt: number;
  runId: string | null;
  /** 이 연결의 스냅숏이 말한 로그인 상태 */
  auth: boolean | null;
  gotSnapshot: boolean;
  watchdog: unknown;
  /** 닫았거나 끝났음 — 더는 이벤트를 건네지 않는다 */
  dead: boolean;
}

export interface EventStreamOptions {
  env: RemoteEnv;
  /** 토픽 이벤트 하나를 구독자에게 건넨다 (payload만) */
  deliver(topic: WookTopic, payload: unknown): void;
}

export interface EventStream {
  /** 연결을 연다 (처음 한 번만 — 구독·상태 듣기·watchMembers가 부른다) */
  start(): void;
  /** 보는 팀원을 통째로 바꾼다. 약속은 그 팀원을 모두 싣는 연결이 받기 시작하면(또는 바뀜·끊김·dispose에) 풀린다 — 맨 위 설명 */
  watchMembers(ids: readonly string[]): Promise<void>;
  onConnection(cb: (state: WebConnectionState) => void): () => void;
  onResync(cb: (info: WebResyncInfo) => void): () => void;
  /** 요청의 답으로 알게 된 로그인 상태 */
  noteLogin(loggedIn: boolean): void;
  /**
   * 로그아웃·기기 끊기 요청의 시작 — 그동안 서버가 닫은 연결은 답을 볼 때까지 끊김으로 치지 않는다. 돌려준 함수를 요청이 끝날 때 그 답의 로그인 상태
   * (모르면 null)와 함께 부른다. revoke면 그 요청 중에 연결이 닫힌 것을 이 기기가 끊긴 것으로 본다(서버는 끊긴 세션의 연결만 닫는다)
   */
  beginAuthCall(kind: 'logout' | 'revoke'): (loggedIn: boolean | null) => void;
  state(): WebConnectionState;
  dispose(): void;
}

export function createEventStream(o: EventStreamOptions): EventStream {
  const { env } = o;
  let started = false;
  let disposed = false;
  let seq = 0;
  let streamIds = 0;
  let active: Stream | null = null;
  /** 보는 팀원이 바뀌어 새로 여는 연결 — 첫 바이트가 오면 active가 된다 */
  let pending: Stream | null = null;
  /** 보는 팀원을 바꿔 물러나는 옛 연결 — WATCH_DRAIN_MS 동안 스냅숏이 아닌 토픽을 더 건넨다 (S8-26 a) */
  let draining: { s: Stream; timer: unknown } | null = null;
  /** 건넨 것의 열쇠 → 건넨 연결 — 다른 연결로 같은 것이 오면 건너뛴다 (S8-26 a) */
  const delivered = new Map<string, number>();
  let watchFailures = 0;
  let state: WebConnectionState = { status: 'connecting' };
  const stateListeners = new Set<(s: WebConnectionState) => void>();
  const resyncListeners = new Set<(i: WebResyncInfo) => void>();
  let watched: string[] = [];
  /** 마지막으로 열렸던 연결의 서버 실행 ID */
  let lastRunId: string | null = null;
  let lost: { lostAt: number; attempt: number } | null = null;
  /** 끊긴 뒤 다시 이어지면 부를 onResync (끊기기 전 실행 ID) */
  let resyncDue: { runIdBefore: string } | null = null;
  let retryTimer: unknown = null;
  let watchTimer: unknown = null;
  let loginFact: { loggedIn: boolean; seq: number } | null = null;
  let authCalls = 0;
  let held: { at: number; timer: unknown; streamAuth: boolean | null; retryAfterMs: number | null } | null = null;
  /** watchMembers의 기다리는 약속 (S8-17) — 그 팀원을 모두 싣는 연결이 받기 시작하면 푼다 */
  let watchWaiters: { ids: readonly string[]; done: () => void }[] = [];
  const unlisten: (() => void)[] = [];

  const keyOf = (ids: readonly string[]): string => ids.join(',');

  /** 이 연결이 이 팀원을 모두 싣고 이미 받고 있는지 (첫 바이트가 왔음 — 서버가 연결을 받아 들였다) */
  const delivering = (s: Stream | null, ids: readonly string[]): boolean => !!s && !s.dead && s.connected && ids.every((id) => s.members.has(id));

  /** 기다리는 watchMembers 약속을 푼다 — all이면 모두(바뀜·끊김·dispose), 아니면 지금 연결이 싣고 받는 것만 */
  const releaseWatchers = (all: boolean): void => {
    if (watchWaiters.length === 0) return;
    const waiting = watchWaiters;
    watchWaiters = [];
    for (const w of waiting) {
      if (all || delivering(active, w.ids)) w.done();
      else watchWaiters.push(w);
    }
  };

  const setState = (next: WebConnectionState): void => {
    const same =
      next.status === state.status &&
      (next.status === 'connecting' ||
        (next.status === 'open' && state.status === 'open' && next.runId === state.runId && next.since === state.since) ||
        (next.status === 'reconnecting' && state.status === 'reconnecting' && next.lostAt === state.lostAt && next.attempt === state.attempt && next.retryAt === state.retryAt));
    if (same) return;
    state = next;
    for (const cb of [...stateListeners]) {
      try {
        cb(next);
      } catch (error) {
        env.error('[욱채] 연결 상태 처리 중 오류', error);
      }
    }
  };

  const clearTimer = (handle: unknown): null => {
    if (handle !== null) env.clearTimeout(handle);
    return null;
  };

  const armWatchdog = (s: Stream): void => {
    s.watchdog = clearTimer(s.watchdog);
    s.watchdog = env.setTimeout(() => {
      s.watchdog = null;
      if (s.dead) return;
      env.warn(`[욱채] 이벤트 연결에서 ${SSE_WATCHDOG_MS / 1000}초 동안 아무것도 오지 않아 다시 엽니다`);
      fail(s, null);
    }, SSE_WATCHDOG_MS);
  };

  /** 우리가 닫는다 — 끝으로 치지 않는다 */
  const close = (s: Stream | null): void => {
    if (!s || s.dead) return;
    s.dead = true;
    s.watchdog = clearTimer(s.watchdog);
    s.controller.abort();
  };

  /** 물러나는 옛 연결을 닫는다 (S8-26 a) */
  const closeDraining = (): void => {
    if (!draining) return;
    const d = draining;
    draining = null;
    clearTimer(d.timer);
    close(d.s);
  };

  /** 이 연결이 이것을 처음 건네는가 — 다른 연결이 이미 건넸으면 false. 같은 연결이 다시 보낸 것은 그대로 건넨다 (S8-26 a) */
  const firstFrom = (key: string, s: Stream): boolean => {
    const by = delivered.get(key);
    if (by !== undefined) return by === s.id;
    delivered.set(key, s.id);
    if (delivered.size > DELIVERED_MEMORY) delivered.delete(delivered.keys().next().value as string);
    return true;
  };

  /** 두 연결로 함께 온 것을 뺀 payload (모두 이미 건넸으면 undefined) — 알림은 ID, CLI 이벤트는 (팀원, turnId, seq), 그 밖은 같은 data (S8-26 a) */
  const once = (s: Stream, topic: string, runId: string, payload: unknown, data: string): unknown => {
    if (topic === 'notification' && isRecord(payload) && typeof payload['id'] === 'string') return firstFrom(JSON.stringify(['n', runId, payload['id']]), s) ? payload : undefined;
    if (topic === 'cliEvents' && isRecord(payload) && Array.isArray(payload['events'])) {
      const turn = JSON.stringify(['c', runId, payload['memberId'], payload['turnId']]);
      const events = payload['events'] as unknown[];
      const fresh = events.filter((e) => !isRecord(e) || typeof e['seq'] !== 'number' || firstFrom(`${turn}${e['seq']}`, s));
      if (fresh.length === events.length) return payload;
      return fresh.length === 0 ? undefined : { ...payload, events: fresh };
    }
    return firstFrom(JSON.stringify(['t', runId, topic]) + data, s) ? payload : undefined;
  };

  const urlFor = (key: string): string => (key ? `/api/events?members=${key}` : '/api/events');

  const open = (purpose: Purpose): Stream => {
    const s: Stream = {
      id: ++streamIds,
      controller: new AbortController(),
      membersKey: keyOf(watched),
      members: new Set(watched),
      purpose,
      openSeq: ++seq,
      connected: false,
      lastByteAt: env.now(),
      runId: null,
      auth: null,
      gotSnapshot: false,
      watchdog: null,
      dead: false,
    };
    armWatchdog(s);
    void run(s);
    return s;
  };

  const run = async (s: Stream): Promise<void> => {
    let res: Response;
    try {
      res = await env.fetch(urlFor(s.membersKey), {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { Accept: 'text/event-stream' },
        signal: s.controller.signal,
      });
    } catch {
      return ended(s, null);
    }
    const type = res.headers.get('content-type') ?? '';
    if (res.status !== 200 || !res.body || !type.toLowerCase().startsWith('text/event-stream')) {
      const after = retryAfterSeconds(res.headers.get('retry-after'));
      try {
        await res.body?.cancel();
      } catch {
        // 이미 닫힘
      }
      if (!s.dead) env.warn(`[욱채] 이벤트 연결을 열지 못했습니다 (HTTP ${res.status})`);
      return ended(s, after === null ? null : after * 1000);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const parser = createSseParser({ onEvent: (event, data) => frame(s, event, data) });
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done || s.dead) break;
        bytes(s);
        parser.feed(decoder.decode(value, { stream: true }));
      }
    } catch {
      // 닫았거나 연결이 끊김 — 아래에서 본다
    }
    if (s.dead) {
      try {
        await reader.cancel();
      } catch {
        // 이미 닫힘
      }
    }
    ended(s, null);
  };

  const bytes = (s: Stream): void => {
    if (s.dead) return;
    s.lastByteAt = env.now();
    armWatchdog(s);
    if (s.connected) return;
    s.connected = true;
    if (s === pending) {
      // 새 연결을 서버가 받았다 — 이제 이 연결로 바꾼다 (빈틈 없이 바꾸기). 옛 연결은 WATCH_DRAIN_MS 동안 더 들은 뒤 닫는다 — 새 연결이 받아 들여지기 전에
      // 옛 연결로만 나간 알림·CLI 이벤트가 늦게 와도 건넨다 (S8-26 a). 앞서 물러나던 연결은 지금 닫는다 (하나만)
      const old = active;
      active = s;
      pending = null;
      watchFailures = 0;
      closeDraining();
      if (old && !old.dead) {
        const timer = env.setTimeout(() => {
          if (draining?.s === old) closeDraining();
        }, WATCH_DRAIN_MS);
        draining = { s: old, timer };
      }
    }
    // 이 연결이 싣는 팀원을 기다리던 watchMembers를 푼다 (S8-17)
    if (s === active) releaseWatchers(false);
  };

  const frame = (s: Stream, event: string, data: string): void => {
    if (s.dead) return;
    // 물러나는 옛 연결은 스냅숏이 아닌 토픽만 더 건넨다 — 스냅숏은 새 연결의 것이 가장 새것이다 (S8-26 a)
    const drained = s !== active;
    if (drained && (draining?.s !== s || event === 'snapshot')) return;
    if (!TOPICS.has(event)) {
      env.warn(`[욱채] 모르는 이벤트를 건너뜁니다: ${event.slice(0, 40)}`);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      env.warn(`[욱채] '${event}' 이벤트를 읽지 못해 건너뜁니다`);
      return;
    }
    if (!isRecord(parsed) || typeof parsed['runId'] !== 'string' || !('payload' in parsed)) {
      env.warn(`[욱채] '${event}' 이벤트의 모양이 맞지 않아 건너뜁니다`);
      return;
    }
    const runId = parsed['runId'];
    const payload = parsed['payload'];
    if (event === 'snapshot') {
      const loggedIn = isRecord(payload) && isRecord(payload['auth']) ? payload['auth']['loggedIn'] : undefined;
      if (typeof loggedIn === 'boolean') s.auth = loggedIn;
      // 연 뒤에 알게 된 로그인 상태와 다르면 이 연결은 옛 호출자의 것이다 — 그 스냅숏은 건네지 않고(로그인한 화면을 로그인 전 스냅숏이 덮지 않게) 다시 연다
      if (loginFact && loginFact.seq > s.openSeq && s.auth !== null && s.auth !== loginFact.loggedIn) return reopenForAuth();
    }
    if (s.runId === null && !drained) {
      s.runId = runId;
      opened(s, runId);
    }
    const value = event === 'snapshot' ? payload : once(s, event, runId, payload, data);
    if (value === undefined) return;
    o.deliver(event as WookTopic, value);
    if (event !== 'snapshot' || s.dead || s !== active) return;
    if (!s.gotSnapshot) {
      s.gotSnapshot = true;
      if (resyncDue) {
        const before = resyncDue.runIdBefore;
        resyncDue = null;
        const info: WebResyncInfo = { runId, runChanged: before !== runId };
        for (const cb of [...resyncListeners]) {
          try {
            cb(info);
          } catch (error) {
            env.error('[욱채] 다시 맞추기 처리 중 오류', error);
          }
        }
      }
      // 여는 동안 보는 팀원이 바뀌었으면 맞춘다
      if (s.membersKey !== keyOf(watched)) scheduleWatch(0);
    }
  };

  const opened = (s: Stream, runId: string): void => {
    lost = null;
    retryTimer = clearTimer(retryTimer);
    lastRunId = runId;
    if (state.status === 'open' && state.runId === runId && s.purpose === 'watch') return;
    setState({ status: 'open', runId, since: env.now() });
  };

  /** 감시가 끊김을 알아챘다 — 흐름을 버리고 끝으로 친다 */
  const fail = (s: Stream, retryAfterMs: number | null): void => {
    if (s.dead) return;
    s.controller.abort();
    ended(s, retryAfterMs);
  };

  /** 흐름이 끝났다 (서버가 닫음·네트워크·200이 아님·감시) */
  const ended = (s: Stream, retryAfterMs: number | null): void => {
    if (s.dead || disposed) return;
    s.dead = true;
    s.watchdog = clearTimer(s.watchdog);
    if (s === pending) {
      // 보는 팀원을 바꾸려던 새 연결이 실패했다 — 옛 연결은 그대로 두고 조금 뒤 다시 바꿔 본다
      pending = null;
      watchFailures++;
      scheduleWatch(Math.max(delayFor(watchFailures), retryAfterMs ?? 0));
      return;
    }
    // 물러나던 옛 연결이 끝난 것은 끊김이 아니다 (S8-26 a)
    if (s !== active) return;
    active = null;
    // 지금 연결이 끝나면 물러나던 옛 연결도 닫는다 — 이어지면 onResync가 채운다 (S8-26 a)
    closeDraining();
    if (authCalls > 0) {
      // 로그아웃·기기 끊기 중 — 서버가 그 세션의 연결을 닫았을 수 있다. 답을 보고 정한다
      held = { at: env.now(), streamAuth: s.auth, retryAfterMs, timer: env.setTimeout(releaseHold, AUTH_HOLD_MS) };
      return;
    }
    lose(retryAfterMs, env.now());
  };

  const delayFor = (attempt: number): number => {
    const base = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length) - 1]!;
    return Math.round(base * (0.8 + 0.4 * env.random()));
  };

  /** 끊김 — 다시 잇기를 건다. 열려 있던 적이 있으면 이어진 뒤 onResync */
  const lose = (retryAfterMs: number | null, at: number): void => {
    close(pending);
    pending = null;
    watchTimer = clearTimer(watchTimer);
    if (!lost) {
      lost = { lostAt: at, attempt: 0 };
      if (lastRunId !== null && !resyncDue) resyncDue = { runIdBefore: lastRunId };
    }
    // 끊김 — 이어지면 onResync가 보는 팀원의 이벤트를 채우므로 기다리던 watchMembers를 푼다. 열린 적이 없어 onResync가 오지 않으면 이어진 연결의
    // 첫 바이트까지 기다린다 (S8-17)
    if (resyncDue) releaseWatchers(true);
    lost.attempt++;
    const delay = Math.max(delayFor(lost.attempt), retryAfterMs ?? 0);
    setState({ status: 'reconnecting', lostAt: lost.lostAt, attempt: lost.attempt, retryAt: env.now() + delay });
    retryTimer = clearTimer(retryTimer);
    retryTimer = env.setTimeout(() => {
      retryTimer = null;
      attempt();
    }, delay);
  };

  const attempt = (): void => {
    if (!lost || active || disposed) return;
    setState({ status: 'reconnecting', lostAt: lost.lostAt, attempt: lost.attempt, retryAt: null });
    active = open('reconnect');
  };

  /** 기다리지 않고 바로 다시 잇는다 (온라인, 화면이 다시 보임) */
  const retryNow = (): void => {
    if (!lost || retryTimer === null) return;
    retryTimer = clearTimer(retryTimer);
    attempt();
  };

  const releaseHold = (): void => {
    if (!held) return;
    const h = held;
    held = null;
    clearTimer(h.timer);
    // 그사이 로그인 상태가 바뀌어 새로 열었으면 끊김이 아니다
    if (active || disposed) return;
    lose(h.retryAfterMs, h.at);
  };

  /** 로그인 상태가 바뀜 — 옛 연결을 바로 닫고 새로 연다 (끊김이 아니다) */
  const reopenForAuth = (): void => {
    if (disposed) return;
    close(pending);
    pending = null;
    // 물러나던 옛 연결도 옛 호출자의 것이다 — 로그아웃 뒤에 업무 내용을 건네지 않게 바로 닫는다 (S8-26 a)
    closeDraining();
    close(active);
    active = null;
    watchTimer = clearTimer(watchTimer);
    retryTimer = clearTimer(retryTimer);
    lost = null;
    setState({ status: 'connecting' });
    active = open('auth');
  };

  const scheduleWatch = (delay: number): void => {
    watchTimer = clearTimer(watchTimer);
    watchTimer = env.setTimeout(() => {
      watchTimer = null;
      reopenForWatch();
    }, delay);
  };

  const reopenForWatch = (): void => {
    const want = keyOf(watched);
    // 끊긴 동안이면 다음 시도가 지금 목록으로 연다
    if (!active || lost || disposed) return;
    if (pending) {
      if (pending.membersKey === want) return;
      close(pending);
      pending = null;
    }
    if (active.membersKey === want) return;
    if (!active.connected) {
      // 아직 받아 들여지지 않은 연결은 새 목록으로 다시 연다
      const purpose = active.purpose;
      close(active);
      active = open(purpose);
      return;
    }
    pending = open('watch');
  };

  const noteLogin = (loggedIn: boolean): void => {
    loginFact = { loggedIn, seq: ++seq };
    if (!started || disposed) return;
    // 물러나던 옛 연결이 다른 로그인 상태로 연 것이면 바로 닫는다 (S8-26 a)
    if (draining && draining.s.auth !== null && draining.s.auth !== loggedIn) closeDraining();
    if (held) {
      if (held.streamAuth !== null && held.streamAuth !== loggedIn) reopenForAuth();
      return;
    }
    if (active && active.auth !== null && active.auth !== loggedIn) reopenForAuth();
  };

  const onVisible = (): void => {
    if (!env.visible()) return;
    if (lost) return retryNow();
    if (active && active.connected && state.status === 'open' && env.now() - active.lastByteAt > STALE_ON_VISIBLE_MS) {
      env.warn('[욱채] 화면이 다시 보였는데 이벤트 연결이 조용해 새로 엽니다');
      fail(active, null);
      retryNow();
    }
  };

  const start = (): void => {
    if (started || disposed) return;
    started = true;
    unlisten.push(
      env.listen('window', 'online', retryNow),
      env.listen('document', 'visibilitychange', onVisible),
      env.listen('window', 'wook:authorized', () => noteLogin(true)),
      env.listen('window', 'wook:unauthorized', () => noteLogin(false)),
    );
    active = open('connect');
  };

  return {
    start,
    watchMembers(ids) {
      if (disposed) return Promise.resolve();
      const valid = [...new Set(ids)].filter((id) => typeof id === 'string' && MEMBER_ID_RE.test(id)).sort();
      const dropped = new Set(ids).size - valid.length;
      if (dropped > 0) env.warn(`[욱채] 팀원 ID 모양이 아닌 ${dropped}개는 CLI 이벤트를 받을 목록에서 뺐습니다`);
      if (valid.length > MAX_WATCHED_MEMBERS) env.warn(`[욱채] CLI 이벤트는 ${MAX_WATCHED_MEMBERS}명까지만 받습니다 — ${valid.length - MAX_WATCHED_MEMBERS}명은 뺐습니다`);
      const next = valid.slice(0, MAX_WATCHED_MEMBERS);
      const changed = keyOf(next) !== keyOf(watched);
      // 목록이 바뀌면 앞의 약속은 이제 볼 일이 없다 — 푼다 (S8-17)
      if (changed) {
        releaseWatchers(true);
        watched = next;
      }
      // 빈 목록, 지금 연결이 이미 싣고 받는 목록, onResync가 채울 끊김 중이면 바로 푼다. 아니면 그 팀원을 싣는 연결의 첫 바이트까지 기다린다
      const ready = new Promise<void>((done) => {
        if (next.length === 0 || delivering(active, next) || (lost !== null && resyncDue !== null)) return done();
        watchWaiters.push({ ids: next, done });
      });
      if (changed) {
        if (!started) start();
        else scheduleWatch(WATCH_DEBOUNCE_MS);
      }
      return ready;
    },
    onConnection(cb) {
      stateListeners.add(cb);
      start();
      try {
        cb(state);
      } catch (error) {
        env.error('[욱채] 연결 상태 처리 중 오류', error);
      }
      let on = true;
      return () => {
        if (!on) return;
        on = false;
        stateListeners.delete(cb);
      };
    },
    onResync(cb) {
      const wrapped = (info: WebResyncInfo): void => cb(info);
      resyncListeners.add(wrapped);
      let on = true;
      return () => {
        if (!on) return;
        on = false;
        resyncListeners.delete(wrapped);
      };
    },
    noteLogin,
    beginAuthCall(kind) {
      authCalls++;
      const since = env.now();
      let done = false;
      return (loggedIn) => {
        if (done) return;
        done = true;
        authCalls--;
        // 기기 끊기 중에 이 연결이 닫혔으면 끊긴 것은 이 기기다
        const fact = loggedIn ?? (kind === 'revoke' && held && held.at >= since ? false : null);
        if (fact !== null) noteLogin(fact);
        if (authCalls === 0) releaseHold();
      };
    },
    state: () => state,
    dispose() {
      disposed = true;
      closeDraining();
      close(pending);
      close(active);
      pending = null;
      active = null;
      retryTimer = clearTimer(retryTimer);
      watchTimer = clearTimer(watchTimer);
      if (held) held.timer = clearTimer(held.timer);
      held = null;
      releaseWatchers(true);
      for (const off of unlisten.splice(0)) off();
      stateListeners.clear();
      resyncListeners.clear();
    },
  };
}
