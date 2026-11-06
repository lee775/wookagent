/**
 * 원격 브리지 (리드 결정 S8-4·S8-7) — 가짜 fetch·흐름·XHR·타이머로 본다. 실제 네트워크는 쓰지 않는다.
 * 시계는 시험이 움직인다(clock.advance). 흔들림은 random()=0.5로 없앤다(간격 ×1.0)
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IPC_METHODS, OWNER_METHODS, type WebConnectionState, type WebResyncInfo } from '../../../shared/ipc';
import { createRemoteBridge, downloadUrlFor, RETRYABLE_METHODS, type RemoteBridge } from './remote';
import { WATCH_DRAIN_MS } from './remoteEvents';
import { createSseParser } from './remoteSse';
import type { RemoteEnv } from './remoteEnv';

const encoder = new TextEncoder();
/** 기다리는 약속(흐름 읽기·fetch)이 모두 돌게 — 가짜 흐름과 가짜 fetch는 마이크로태스크만 쓴다 */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 100; i++) await Promise.resolve();
};

function fakeClock() {
  let now = 1_700_000_000_000;
  let ids = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimeout: (fn: () => void, ms: number): unknown => {
      const id = ++ids;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (handle: unknown): void => {
      timers.delete(handle as number);
    },
    /** 시계를 ms만큼 움직이며 그사이 울릴 타이머를 차례로 부른다 */
    async advance(ms: number): Promise<void> {
      const end = now + ms;
      await settle();
      for (;;) {
        const next = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].fn();
        await settle();
      }
      now = end;
      await settle();
    },
  };
}

interface FakeResponseInit {
  status?: number;
  headers?: Record<string, string>;
  text?: string;
  body?: ReadableStream<Uint8Array> | null;
  /** 본문 읽기가 실패 (연결이 중간에 끊김) */
  textFails?: boolean;
}

function fakeResponse(o: FakeResponseInit): Response {
  const headers = new Headers(o.headers ?? {});
  return {
    status: o.status ?? 200,
    headers,
    body: o.body ?? null,
    text: async () => {
      if (o.textFails) throw new TypeError('network error');
      return o.text ?? '';
    },
  } as unknown as Response;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  fakeResponse({ status, text: JSON.stringify(body), headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });

/** 서버 쪽에서 보내는 SSE 연결 하나 */
interface SseConn {
  url: string;
  aborted: boolean;
  send(text: string): void;
  sendBytes(bytes: Uint8Array): void;
  end(): void;
  fail(): void;
}

const frameText = (topic: string, payload: unknown, runId = 'run-1'): string => `event: ${topic}\ndata: ${JSON.stringify({ runId, payload })}\n\n`;
const snap = (loggedIn: boolean, version = 1): unknown => ({ version, auth: { loggedIn } });

type InvokeHandler = (body: { id: unknown; method: string; args: unknown[] }) => Response | Promise<Response>;

function setup(o: { invoke?: InvokeHandler; events?: (url: string, signal: AbortSignal) => Response | Promise<Response> | null; env?: Partial<RemoteEnv> } = {}) {
  const clock = fakeClock();
  const conns: SseConn[] = [];
  const invokes: { id: unknown; method: string; args: unknown[] }[] = [];
  const fetches: string[] = [];
  const listeners = new Map<string, Set<() => void>>();
  let visible = true;
  const warn = vi.fn();
  const error = vi.fn();
  let idSeq = 0;
  const openSse = (url: string, signal: AbortSignal): Response => {
    let ctrl!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        ctrl = c;
      },
    });
    // 브리지가 닫은(abort) 연결로 서버가 더 보내도 브라우저에 오지 않는다 — 보내기·끝내기는 아무 일도 하지 않는다
    const conn: SseConn = {
      url,
      aborted: false,
      send: (text) => {
        if (!conn.aborted) ctrl.enqueue(encoder.encode(text));
      },
      sendBytes: (bytes) => {
        if (!conn.aborted) ctrl.enqueue(bytes);
      },
      end: () => {
        if (!conn.aborted) ctrl.close();
      },
      fail: () => {
        if (!conn.aborted) ctrl.error(new TypeError('network error'));
      },
    };
    signal.addEventListener('abort', () => {
      conn.aborted = true;
      try {
        ctrl.error(new DOMException('aborted', 'AbortError'));
      } catch {
        // 이미 닫힘
      }
    });
    conns.push(conn);
    return fakeResponse({ status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8' }, body });
  };
  const fetch = vi.fn(async (url: string, init: RequestInit): Promise<Response> => {
    fetches.push(url);
    if (url.startsWith('/api/events')) {
      const custom = o.events?.(url, init.signal!);
      if (custom) return custom;
      return openSse(url, init.signal!);
    }
    if (url === '/api/invoke') {
      const body = JSON.parse(String(init.body)) as { id: unknown; method: string; args: unknown[] };
      invokes.push(body);
      expect(init.method).toBe('POST');
      expect(init.credentials).toBe('same-origin');
      expect(new Headers(init.headers).get('X-Wook-Client')).toBe('1');
      expect(new Headers(init.headers).get('Content-Type')).toBe('application/json');
      if (!o.invoke) return json(200, { ok: true, value: null });
      return o.invoke(body);
    }
    throw new Error(`예상하지 않은 fetch: ${url}`);
  });
  const env: Partial<RemoteEnv> = {
    fetch,
    randomId: () => `req-${++idSeq}`,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    random: () => 0.5,
    listen(_target, type, fn) {
      let set = listeners.get(type);
      if (!set) listeners.set(type, (set = new Set()));
      set.add(fn);
      return () => set.delete(fn);
    },
    visible: () => visible,
    warn,
    error,
    ...o.env,
  };
  const bridge = createRemoteBridge(env);
  const states: WebConnectionState[] = [];
  const resyncs: WebResyncInfo[] = [];
  const emit = (type: string): void => {
    for (const fn of [...(listeners.get(type) ?? [])]) fn();
  };
  return {
    bridge,
    clock,
    conns,
    invokes,
    fetches,
    fetch,
    warn,
    error,
    states,
    resyncs,
    emit,
    setVisible(v: boolean) {
      visible = v;
    },
    /** 연결 상태와 다시 맞추기를 듣고 이벤트 연결을 연다 */
    watch() {
      bridge.web.onConnection((s) => states.push(s));
      bridge.web.onResync((i) => resyncs.push(i));
    },
    last: (): SseConn => conns[conns.length - 1]!,
  };
}

let current: RemoteBridge | null = null;
const track = <T extends { bridge: RemoteBridge }>(t: T): T => {
  current = t.bridge;
  return t;
};
afterEach(() => {
  current?.dispose();
  current = null;
});

/** 인자 타입을 보지 않고 부른다 — 틀린 이름·인자를 일부러 보내는 시험 */
const call = (b: RemoteBridge, method: unknown, ...args: unknown[]): Promise<unknown> => (b.invoke as unknown as (m: unknown, ...a: unknown[]) => Promise<unknown>)(method, ...args);

async function rejection(p: Promise<unknown>): Promise<Error & { code?: string; retryAfterSec?: number }> {
  try {
    await p;
  } catch (error) {
    return error as Error & { code?: string };
  }
  throw new Error('거부되지 않았습니다');
}

describe('invoke: 답 풀기와 오류 code (preload와 같은 규칙)', () => {
  it('본문의 InvokeResponse를 상태 코드와 관계없이 풀고, 아닌 본문은 상태를 말하는 bad_response다', async () => {
    const replies: Response[] = [
      json(200, { ok: true, value: { a: 1 } }),
      json(404, { ok: false, error: { code: 'not_found', message: '보고서 R-0009을(를) 찾을 수 없습니다' } }),
      json(409, { ok: false, error: { code: 7, message: '코드가 글이 아님' } }),
      json(400, { ok: false, error: { code: 'invalid_args', message: '' } }),
      fakeResponse({ status: 502, text: '<html><body>502 Bad Gateway</body></html>', headers: { 'Content-Type': 'text/html' } }),
      json(200, { something: 'else' }),
    ];
    const t = track(setup({ invoke: () => replies.shift()! }));
    await expect(t.bridge.invoke('reports.get', 'R-0001')).resolves.toEqual({ a: 1 });
    const notFound = await rejection(t.bridge.invoke('reports.get', 'R-0009'));
    expect([notFound.name, notFound.code, notFound.message]).toEqual(['WookError', 'not_found', '보고서 R-0009을(를) 찾을 수 없습니다']);
    expect((await rejection(t.bridge.invoke('reports.markRead', 'R-0001'))).code).toBe('unknown');
    expect((await rejection(t.bridge.invoke('reports.markRead', 'R-0001'))).code).toBe('bad_response');
    const html = await rejection(t.bridge.invoke('reports.markRead', 'R-0001'));
    expect([html.name, html.code]).toEqual(['WookError', 'bad_response']);
    expect(html.message).toContain('HTTP 502');
    const odd = await rejection(t.bridge.invoke('reports.markRead', 'R-0001'));
    expect([odd.code, odd.message.includes('HTTP 200')]).toEqual(['bad_response', true]);
    // 인자는 JSON 배열로 — undefined는 null이 된다
    expect(t.invokes[0]!.args).toEqual(['R-0001']);
  });

  it('연결 자체가 안 되면 network, 본문을 읽다 끊겨도 network다 (다시 보내지 않는 메서드는 한 번만)', async () => {
    const t = track(
      setup({
        invoke: (b) => {
          if (b.method === 'reports.markRead') throw new TypeError('Failed to fetch');
          return fakeResponse({ status: 200, textFails: true });
        },
      }),
    );
    const offline = await rejection(t.bridge.invoke('reports.markRead', 'R-0001'));
    expect([offline.name, offline.code]).toEqual(['WookError', 'network']);
    expect(offline.message).toBe('서버에 연결하지 못했습니다 — 네트워크를 확인하고 다시 시도해 주세요.');
    expect((await rejection(call(t.bridge, 'logs.export'))).code).toBe('network');
    expect(t.invokes.map((b) => b.method)).toEqual(['reports.markRead', 'logs.export']);
  });

  it('429는 기다리지 않고 Retry-After를 오류 글과 retryAfterSec에 넣는다 — 다시 보내기 간격이 지나도 한 번만 보낸다', async () => {
    const t = track(setup({ invoke: () => json(429, { ok: false, error: { code: 'rate_limited', message: '요청이 너무 잦습니다 — 잠시 뒤에 다시 해 주세요' } }, { 'Retry-After': '30' }) }));
    const p = rejection(t.bridge.invoke('snapshot.get'));
    // 다시 보내는 메서드의 간격(0.5초·2초)을 다 지나게 시계를 움직인다 — 429를 다시 보내면 여기서 3번이 된다
    await t.clock.advance(5_000);
    expect(t.invokes).toHaveLength(1);
    const limited = await p;
    expect([limited.code, limited.retryAfterSec]).toEqual(['rate_limited', 30]);
    expect(limited.message).toBe('요청이 너무 잦습니다 — 잠시 뒤에 다시 해 주세요 (30초 뒤에 다시 할 수 있습니다)');
    expect(t.invokes).toHaveLength(1);
  });
});

describe('invoke: 보내지 않고 거부하는 이름 (preload와 같은 글)', () => {
  it('대표 권한 밖의 화면 약속 메서드는 forbidden, 모르는 이름은 unknown_method — 서버로 보내지 않는다', async () => {
    const t = track(setup());
    const outside = IPC_METHODS.filter((m) => !(OWNER_METHODS as readonly string[]).includes(m));
    expect(outside).toContain('settings.update');
    for (const m of outside) {
      const e = await rejection(call(t.bridge, m));
      expect([e.name, e.code, e.message], m).toEqual([
        'WookError',
        'forbidden',
        '대표 화면에서 하는 일이 아닙니다. 팀 운영·설정·작업 조작은 메인 에이전트가 맡습니다 — 명령창으로 메인 에이전트에게 말하세요.',
      ]);
    }
    for (const m of ['nope.method', 'system.pickFolder', 42, undefined]) {
      const e = await rejection(call(t.bridge, m));
      expect([e.code, e.message], String(m)).toEqual(['unknown_method', '허용되지 않은 요청입니다.']);
    }
    // JSON으로 보낼 수 없는 인자
    expect((await rejection(call(t.bridge, 'snapshot.get', 1n))).code).toBe('invalid_args');
    expect(t.fetch).not.toHaveBeenCalled();
    expect(t.bridge.platform).toBe('web');
  });
});

describe('invoke: 요청 ID와 다시 보내기 (S8-4)', () => {
  it('기본 요청 ID는 호출마다 새 UUID다 — 세는 수가 아니다', async () => {
    const t = track(setup());
    // randomId를 넘기지 않으면 기본(crypto.randomUUID)을 쓴다
    const bridge = createRemoteBridge({ fetch: t.fetch, setTimeout: t.clock.setTimeout, clearTimeout: t.clock.clearTimeout, now: t.clock.now });
    try {
      await bridge.invoke('stop.release');
      await bridge.invoke('stop.release');
    } finally {
      bridge.dispose();
    }
    const [a, b] = t.invokes.map((x) => x.id);
    for (const id of [a, b]) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a).not.toBe(b);
  });

  it('command.send: 네트워크 실패·503 뒤 같은 ID로 0.5초·2초 뒤에 다시 보내 한 번만 처리된다', async () => {
    const replies: (() => Response)[] = [
      () => {
        throw new TypeError('Failed to fetch');
      },
      () => json(503, { ok: false, error: { code: 'shutting_down', message: '서버를 끝내는 중입니다' } }),
      () => json(200, { ok: true, value: { directiveId: 'D-0001' } }),
    ];
    const t = track(setup({ invoke: () => (replies.shift() ?? (() => json(200, { ok: true, value: { directiveId: 'D-0002' } })))() }));
    const sent = t.bridge.invoke('command.send', { target: 'P-0001', text: '안녕' });
    await t.clock.advance(499);
    expect(t.invokes).toHaveLength(1);
    await t.clock.advance(1);
    expect(t.invokes).toHaveLength(2);
    await t.clock.advance(1999);
    expect(t.invokes).toHaveLength(2);
    await t.clock.advance(1);
    await expect(sent).resolves.toEqual({ directiveId: 'D-0001' });
    expect(t.invokes.map((b) => b.id)).toEqual(['req-1', 'req-1', 'req-1']);
    // 다음 호출은 새 ID
    await t.bridge.invoke('command.send', { target: 'P-0001', text: '또' });
    expect(t.invokes[3]!.id).toBe('req-2');
  });

  it('다시 보내기는 두 번까지 — 세 번 다 실패하면 마지막 실패를 던진다', async () => {
    const t = track(setup({ invoke: () => json(408, { ok: false, error: { code: 'timeout', message: '요청이 제시간에 다 오지 않아 끊었습니다.' } }) }));
    const p = rejection(t.bridge.invoke('reports.get', 'R-0001'));
    await t.clock.advance(5_000);
    expect((await p).code).toBe('timeout');
    expect(t.invokes).toHaveLength(3);
  });

  it('409와 그 밖의 4xx·500은 다시 보내지 않는다 — 읽기·같은 ID를 한 번만 처리하는 메서드도', async () => {
    const statuses = [409, 400, 401, 404, 500];
    for (const status of statuses) {
      const t = track(setup({ invoke: () => json(status, { ok: false, error: { code: 'x', message: '안 됨' } }) }));
      const p = rejection(t.bridge.invoke('command.send', { target: 'P-0001', text: 'x' }));
      await t.clock.advance(10_000);
      await p;
      expect(t.invokes, String(status)).toHaveLength(1);
      t.bridge.dispose();
    }
  });

  it('목록 밖 메서드는 네트워크 실패·503에도 다시 보내지 않는다', async () => {
    const notRetried = ['reports.markRead', 'notifications.markRead', 'logs.export', 'auth.deviceLogin', 'auth.logout', 'auth.setupOwner', 'auth.login', 'system.recheckAi'];
    for (const m of notRetried) expect(RETRYABLE_METHODS.has(m), m).toBe(false);
    const t = track(setup({ invoke: () => json(503, { ok: false, error: { code: 'shutting_down', message: '서버를 끝내는 중입니다' } }) }));
    for (const m of notRetried) {
      const p = rejection(call(t.bridge, m));
      await t.clock.advance(5_000);
      expect((await p).code, m).toBe('shutting_down');
    }
    expect(t.invokes.map((b) => b.method)).toEqual(notRetried);
  });

  it('다시 보내는 목록: 보기, 같은 ID를 한 번만 처리하는 여섯, 긴급 정지 — 모두 대표 메서드다', () => {
    for (const m of ['command.send', 'questions.answer', 'reports.approve', 'reports.requestChanges', 'stop.release', 'auth.revokeDevice', 'stop.emergency', 'snapshot.get', 'members.getEvents', 'seat.handover', 'auth.deviceLoginPoll']) {
      expect(RETRYABLE_METHODS.has(m), m).toBe(true);
    }
    for (const m of RETRYABLE_METHODS) expect(OWNER_METHODS as readonly string[], m).toContain(m);
  });
});

describe('subscribe (preload와 같은 규칙)', () => {
  it('모르는 토픽·함수가 아닌 처리기는 던지고, 구독자 오류는 다른 구독자를 막지 않고, 풀기는 한 번만이다', async () => {
    const t = track(setup());
    expect(() => t.bridge.subscribe('nope' as never, () => undefined)).toThrow(expect.objectContaining({ code: 'unknown_topic', name: 'WookError' }));
    expect(() => t.bridge.subscribe('snapshot', 'x' as never)).toThrow(expect.objectContaining({ code: 'invalid_callback' }));
    const got: unknown[] = [];
    const off1 = t.bridge.subscribe('notification', () => {
      throw new Error('구독자 오류');
    });
    const off2 = t.bridge.subscribe('notification', (p) => got.push(p));
    await settle();
    t.last().send(frameText('snapshot', snap(true)));
    t.last().send(frameText('notification', { id: 'N-1', title: '알림' }));
    await settle();
    // payload만 넘긴다 (runId 겉봉 없이)
    expect(got).toEqual([{ id: 'N-1', title: '알림' }]);
    expect(t.error).toHaveBeenCalledWith("[욱채] 'notification' 구독 처리 중 오류", expect.any(Error));
    off2();
    off2();
    off1();
    t.last().send(frameText('notification', { id: 'N-2' }));
    await settle();
    expect(got).toHaveLength(1);
  });
});

describe('SSE 읽기', () => {
  it('조각 경계·CRLF·CR·주석·여러 줄 data·앞 공백 하나·data 없는 이벤트', () => {
    const events: [string, string][] = [];
    const comments: string[] = [];
    const p = createSseParser({ onEvent: (e, d) => events.push([e, d]), onComment: (c) => comments.push(c) });
    for (const piece of [': conn', 'ected\n\nev', 'ent: snap', 'shot\r', '\ndata: {"a":', '1}\r\n\r\n', 'event: cliEvents\ndata:  두 칸\ndata:x\n\n', 'event: nothing\n\n', ': ping\r\r', 'data: plain\n\n']) {
      p.feed(piece);
    }
    expect(events).toEqual([
      ['snapshot', '{"a":1}'],
      ['cliEvents', ' 두 칸\nx'],
      ['message', 'plain'],
    ]);
    expect(comments).toEqual([' connected', ' ping']);
  });

  it('조각으로 나뉜 프레임과 바이트 중간에서 갈라진 한글을 그대로 건넨다', async () => {
    const t = track(setup());
    const got: unknown[] = [];
    t.bridge.subscribe('snapshot', (p) => got.push(p));
    await settle();
    const bytes = encoder.encode(frameText('snapshot', { version: 3, auth: { loggedIn: true }, title: '욱채 작업실' }));
    const cut1 = 7;
    const cut2 = bytes.indexOf(0xec) + 1; // '욱'의 첫 바이트 뒤
    t.last().send(': connected\n\n');
    t.last().sendBytes(bytes.slice(0, cut1));
    t.last().sendBytes(bytes.slice(cut1, cut2));
    await settle();
    expect(got).toEqual([]);
    t.last().sendBytes(bytes.slice(cut2));
    await settle();
    expect(got).toEqual([{ version: 3, auth: { loggedIn: true }, title: '욱채 작업실' }]);
  });

  it('모르는 이벤트·읽지 못하는 data는 건너뛰고 연결은 그대로다', async () => {
    const t = track(setup());
    const got: unknown[] = [];
    t.bridge.subscribe('snapshot', (p) => got.push(p));
    await settle();
    t.last().send('event: weird\ndata: {}\n\nevent: snapshot\ndata: not json\n\nevent: snapshot\ndata: {"payload":1}\n\n');
    t.last().send(frameText('snapshot', snap(false)));
    await settle();
    expect(got).toEqual([snap(false)]);
    expect(t.warn).toHaveBeenCalledTimes(3);
    expect(t.conns).toHaveLength(1);
  });
});

describe('이벤트 연결: 감시·다시 잇기 (S8-4)', () => {
  it('처음 연결은 connecting → 첫 이벤트에 open(runId)이고 onResync는 없다', async () => {
    const t = track(setup());
    t.watch();
    await settle();
    expect(t.fetches).toEqual(['/api/events']);
    expect(t.states).toEqual([{ status: 'connecting' }]);
    t.last().send(': connected\n\n');
    await settle();
    expect(t.states).toHaveLength(1);
    t.last().send(frameText('snapshot', snap(false)));
    await settle();
    expect(t.states.at(-1)).toEqual({ status: 'open', runId: 'run-1', since: t.clock.now() });
    expect(t.resyncs).toEqual([]);
  });

  it('50초 동안 바이트가 없으면 끊긴 것으로 보고 다시 잇는다 — 20초마다 살아 있음 신호가 오면 그대로다', async () => {
    const t = track(setup());
    t.watch();
    await settle();
    t.last().send(frameText('snapshot', snap(false)));
    for (let i = 0; i < 6; i++) {
      await t.clock.advance(20_000);
      t.last().send(': ping\n\n');
    }
    await settle();
    expect(t.conns).toHaveLength(1);
    expect(t.states.at(-1)!.status).toBe('open');
    await t.clock.advance(49_999);
    expect(t.states.at(-1)!.status).toBe('open');
    const lostAt = t.clock.now() + 1;
    await t.clock.advance(1);
    expect(t.conns[0]!.aborted).toBe(true);
    expect(t.states.at(-1)).toEqual({ status: 'reconnecting', lostAt, attempt: 1, retryAt: lostAt + 1_000 });
    expect(t.warn).toHaveBeenCalledWith('[욱채] 이벤트 연결에서 50초 동안 아무것도 오지 않아 다시 엽니다');
  });

  it('감시는 fetch를 시작할 때부터 — 답이 오지 않는 fetch도 50초 뒤 끊긴 것으로 보고 새로 연다', async () => {
    let hang = true;
    // 실제 fetch처럼 abort에만 거부하고 그 밖에는 끝나지 않는다 (앞단이 TCP만 받고 답하지 않는 경우)
    const hung = (signal: AbortSignal): Promise<Response> => new Promise((_, fail) => signal.addEventListener('abort', () => fail(new DOMException('aborted', 'AbortError'))));
    const t = track(setup({ events: (_url, signal) => (hang ? hung(signal) : null) }));
    t.watch();
    await t.clock.advance(49_999);
    expect(t.fetches).toEqual(['/api/events']);
    expect(t.states).toEqual([{ status: 'connecting' }]);
    hang = false;
    const lostAt = t.clock.now() + 1;
    await t.clock.advance(1);
    expect(t.states.at(-1)).toEqual({ status: 'reconnecting', lostAt, attempt: 1, retryAt: lostAt + 1_000 });
    await t.clock.advance(1_000);
    expect(t.fetches).toEqual(['/api/events', '/api/events']);
    t.last().send(frameText('snapshot', snap(false)));
    await settle();
    expect(t.states.at(-1)!.status).toBe('open');
    // 열린 적이 없던 연결이라 onResync는 없다
    expect(t.resyncs).toEqual([]);
  });

  it('감시는 fetch를 시작할 때부터 — 200을 받았지만 본문이 한 바이트도 오지 않아도 50초 뒤 새로 연다', async () => {
    const t = track(setup());
    t.watch();
    await t.clock.advance(49_999);
    expect(t.conns).toHaveLength(1);
    expect(t.conns[0]!.aborted).toBe(false);
    expect(t.states).toEqual([{ status: 'connecting' }]);
    await t.clock.advance(1);
    expect(t.conns[0]!.aborted).toBe(true);
    expect(t.states.at(-1)).toMatchObject({ status: 'reconnecting', attempt: 1 });
    await t.clock.advance(1_000);
    expect(t.conns).toHaveLength(2);
  });

  it('다시 잇기 간격은 1·2·5·10·30초에서 멈추고(흔들림 ±20%), 시도 중에는 retryAt이 null이다', async () => {
    let fail = true;
    const t = track(setup({ events: () => (fail ? fakeResponse({ status: 503, text: '{}' }) : null) }));
    t.watch();
    await settle();
    const gaps: number[] = [];
    for (let i = 0; i < 6; i++) {
      const s = t.states.at(-1)!;
      expect(s.status).toBe('reconnecting');
      if (s.status !== 'reconnecting') return;
      expect(s.attempt).toBe(i + 1);
      gaps.push(s.retryAt! - t.clock.now());
      await t.clock.advance(s.retryAt! - t.clock.now());
    }
    expect(gaps).toEqual([1_000, 2_000, 5_000, 10_000, 30_000, 30_000]);
    expect(t.states.some((s) => s.status === 'reconnecting' && s.retryAt === null)).toBe(true);
    // 처음 연결부터 실패했으니 열린 적이 없다 — 이어져도 onResync는 없다
    fail = false;
    await t.clock.advance(30_000);
    t.last().send(frameText('snapshot', snap(false)));
    await settle();
    expect(t.states.at(-1)!.status).toBe('open');
    expect(t.resyncs).toEqual([]);
  });

  it('흔들림: random 0이면 0.8배, 1에 가까우면 1.2배', async () => {
    for (const [r, gap] of [
      [0, 800],
      [0.999999, 1_200],
    ] as const) {
      const t = track(setup({ events: () => fakeResponse({ status: 503, text: '' }), env: { random: () => r } }));
      t.watch();
      await settle();
      const s = t.states.at(-1)!;
      expect(s.status === 'reconnecting' ? s.retryAt! - t.clock.now() : null).toBe(gap);
      t.bridge.dispose();
    }
  });

  it('429·503의 Retry-After가 더 길면 그만큼 기다린다', async () => {
    const t = track(setup({ events: () => fakeResponse({ status: 429, text: '{}', headers: { 'Retry-After': '30' } }) }));
    t.watch();
    await settle();
    const s = t.states.at(-1)!;
    expect(s.status === 'reconnecting' ? s.retryAt! - t.clock.now() : null).toBe(30_000);
  });

  it('온라인이 되거나 화면이 다시 보이면 기다리지 않고 바로 잇는다', async () => {
    const t = track(setup());
    t.watch();
    await settle();
    t.last().send(frameText('snapshot', snap(true)));
    await settle();
    t.last().end();
    await settle();
    expect(t.states.at(-1)!.status).toBe('reconnecting');
    t.emit('online');
    await settle();
    expect(t.conns).toHaveLength(2);
    t.last().end();
    await settle();
    t.setVisible(false);
    t.emit('visibilitychange');
    await settle();
    expect(t.conns).toHaveLength(2);
    t.setVisible(true);
    t.emit('visibilitychange');
    await settle();
    expect(t.conns).toHaveLength(3);
  });

  it('화면이 다시 보일 때 30초 넘게 조용했던 연결은 버리고 바로 새로 연다 (휴대폰 잠자기)', async () => {
    const t = track(setup());
    t.watch();
    await settle();
    t.last().send(frameText('snapshot', snap(true)));
    await t.clock.advance(20_000);
    t.emit('visibilitychange');
    await settle();
    expect(t.conns).toHaveLength(1);
    await t.clock.advance(11_000);
    t.emit('visibilitychange');
    await settle();
    expect(t.conns[0]!.aborted).toBe(true);
    expect(t.conns).toHaveLength(2);
  });
});

describe('이벤트 연결: 다시 맞추기 (onResync)', () => {
  it('끊겼다가 이어지면 새 연결의 첫 스냅숏을 건넨 뒤 한 번 부른다 — 서버가 다시 시작했으면 runChanged', async () => {
    const t = track(setup());
    t.watch();
    const order: string[] = [];
    t.bridge.subscribe('snapshot', () => order.push('snapshot'));
    t.bridge.web.onResync(() => order.push('resync'));
    await settle();
    t.last().send(frameText('snapshot', snap(true), 'run-1'));
    await settle();
    t.last().end();
    await t.clock.advance(1_000);
    expect(t.conns).toHaveLength(2);
    t.last().send(': connected\n\n');
    t.last().send(frameText('cliEvents', { memberId: 'M-0001', seq: 1 }, 'run-2'));
    await settle();
    expect(t.resyncs).toEqual([]);
    t.last().send(frameText('snapshot', snap(true, 1), 'run-2'));
    t.last().send(frameText('snapshot', snap(true, 2), 'run-2'));
    await settle();
    expect(t.resyncs).toEqual([{ runId: 'run-2', runChanged: true }]);
    expect(order).toEqual(['snapshot', 'snapshot', 'resync', 'snapshot']);
    // 같은 서버에 다시 이어지면 runChanged false
    t.last().fail();
    await t.clock.advance(1_000);
    t.last().send(frameText('snapshot', snap(true), 'run-2'));
    await settle();
    expect(t.resyncs).toEqual([
      { runId: 'run-2', runChanged: true },
      { runId: 'run-2', runChanged: false },
    ]);
  });

  it('끊긴 뒤 여러 번 실패해도 이어질 때 한 번만 부른다', async () => {
    let failing = false;
    const t = track(setup({ events: () => (failing ? fakeResponse({ status: 503, text: '' }) : null) }));
    t.watch();
    await settle();
    t.last().send(frameText('snapshot', snap(true)));
    await settle();
    failing = true;
    t.last().end();
    await t.clock.advance(1_000 + 2_000 + 5_000);
    failing = false;
    await t.clock.advance(10_000);
    t.last().send(frameText('snapshot', snap(true)));
    t.last().send(frameText('snapshot', snap(true, 2)));
    await settle();
    expect(t.resyncs).toEqual([{ runId: 'run-1', runChanged: false }]);
  });
});

describe('이벤트 연결: 보는 팀원 (?members=)', () => {
  it('목록이 바뀌면 새 연결을 먼저 열고, 그 연결이 받아 들여지면 바꾼 뒤 옛 연결은 WATCH_DRAIN_MS 더 듣고 닫는다 (빈틈 없음, onResync 없음)', async () => {
    const t = track(setup());
    t.watch();
    const got: unknown[] = [];
    t.bridge.subscribe('cliEvents', (p) => got.push(p));
    await settle();
    const a = t.last();
    a.send(frameText('snapshot', snap(true)));
    await settle();
    const openState = t.states.at(-1);
    t.bridge.web.watchMembers(['M-0002', 'M-0001', 'M-0001']);
    await t.clock.advance(199);
    expect(t.conns).toHaveLength(1);
    await t.clock.advance(1);
    expect(t.conns).toHaveLength(2);
    const b = t.last();
    expect(b.url).toBe('/api/events?members=M-0001,M-0002');
    // 새 연결이 아직 받아 들여지지 않았다 — 옛 연결이 계속 건넨다
    a.send(frameText('cliEvents', { memberId: 'M-0001', seq: 1 }));
    await settle();
    expect(a.aborted).toBe(false);
    b.send(': connected\n\n');
    await settle();
    expect(a.aborted).toBe(false);
    b.send(frameText('snapshot', snap(true)));
    b.send(frameText('cliEvents', { memberId: 'M-0001', seq: 2 }));
    await settle();
    expect(got).toEqual([
      { memberId: 'M-0001', seq: 1 },
      { memberId: 'M-0001', seq: 2 },
    ]);
    expect(t.states.at(-1)).toEqual(openState);
    expect(t.resyncs).toEqual([]);
    // 옛 연결은 새 연결의 첫 바이트부터 WATCH_DRAIN_MS 뒤에 닫는다 (S8-26 a)
    await t.clock.advance(WATCH_DRAIN_MS - 1);
    expect(a.aborted).toBe(false);
    await t.clock.advance(1);
    expect(a.aborted).toBe(true);
    expect(t.states.at(-1)).toEqual(openState);
    // 같은 목록(순서·겹침만 다름)은 다시 열지 않는다
    t.bridge.web.watchMembers(['M-0001', 'M-0002']);
    await t.clock.advance(1_000);
    expect(t.conns).toHaveLength(2);
  });

  it('잦은 바꿈은 0.2초 모아 한 번만 열고, 모양이 아닌 ID와 50명 넘는 것은 빼고 알린다', async () => {
    const t = track(setup());
    t.watch();
    await settle();
    t.last().send(frameText('snapshot', snap(true)));
    await settle();
    t.bridge.web.watchMembers(['M-0001']);
    await t.clock.advance(100);
    t.bridge.web.watchMembers(['M-0003']);
    await t.clock.advance(100);
    t.bridge.web.watchMembers(['M-0004', 'x', 'M-1', 'M-MAIN']);
    await t.clock.advance(200);
    expect(t.conns.map((c) => c.url)).toEqual(['/api/events', '/api/events?members=M-0004,M-MAIN']);
    expect(t.warn).toHaveBeenCalledWith('[욱채] 팀원 ID 모양이 아닌 2개는 CLI 이벤트를 받을 목록에서 뺐습니다');
    const many = Array.from({ length: 55 }, (_, i) => `M-${String(i + 1).padStart(4, '0')}`);
    t.last().send(': connected\n\n');
    await settle();
    t.bridge.web.watchMembers(many);
    await t.clock.advance(200);
    expect(t.last().url.split('=')[1]!.split(',')).toHaveLength(50);
    expect(t.warn).toHaveBeenCalledWith('[욱채] CLI 이벤트는 50명까지만 받습니다 — 5명은 뺐습니다');
  });

  it('빈 목록이면 members 없이 연다', async () => {
    const t = track(setup());
    t.bridge.web.watchMembers(['M-0001']);
    await settle();
    expect(t.fetches).toEqual(['/api/events?members=M-0001']);
    t.last().send(frameText('snapshot', snap(true)));
    await settle();
    t.bridge.web.watchMembers([]);
    await t.clock.advance(200);
    expect(t.last().url).toBe('/api/events');
  });

  it('바꾸려던 새 연결이 실패하면 옛 연결은 두고 조금 뒤 다시 바꿔 본다', async () => {
    let refuse = false;
    const t = track(setup({ events: () => (refuse ? fakeResponse({ status: 503, text: '' }) : null) }));
    t.watch();
    await settle();
    const a = t.last();
    a.send(frameText('snapshot', snap(true)));
    await settle();
    refuse = true;
    t.bridge.web.watchMembers(['M-0001']);
    await t.clock.advance(200);
    expect(a.aborted).toBe(false);
    expect(t.states.at(-1)!.status).toBe('open');
    refuse = false;
    await t.clock.advance(1_000);
    expect(t.last().url).toBe('/api/events?members=M-0001');
    expect(t.last()).not.toBe(a);
  });

  it('끊긴 동안 바뀐 목록은 다음 시도가 쓴다', async () => {
    const t = track(setup());
    t.watch();
    await settle();
    t.last().send(frameText('snapshot', snap(true)));
    await settle();
    t.last().end();
    await settle();
    t.bridge.web.watchMembers(['M-0009']);
    await t.clock.advance(1_000);
    expect(t.conns.map((c) => c.url)).toEqual(['/api/events', '/api/events?members=M-0009']);
  });
});

describe('보는 팀원을 바꾼 뒤 옛 연결을 잠깐 더 듣는다 (S8-26 a)', () => {
  const note = (id: string, body = '본문'): unknown => ({ id, level: 'info', title: '알림', body, link: null, key: null, createdAt: '2026-11-05T12:00:00.000Z', read: false });
  /** 연결에 보내고 건네질 때까지 돌린다 — 두 연결 사이의 순서를 시험이 정한다 */
  const push = async (c: SseConn, text: string): Promise<void> => {
    c.send(text);
    await settle();
  };
  /** 처음 연결 a(로그인 스냅숏, 또는 첫 바이트만)와 목록을 바꿔 연 b — b의 첫 바이트가 오면 b로 바뀐다 */
  async function switched(o: { aSnapshot?: boolean } = {}) {
    const t = track(setup());
    t.watch();
    const notes: unknown[] = [];
    const snaps: unknown[] = [];
    const emergencies: unknown[] = [];
    t.bridge.subscribe('notification', (p) => notes.push(p));
    t.bridge.subscribe('snapshot', (p) => snaps.push(p));
    t.bridge.subscribe('emergency', (p) => emergencies.push(p));
    await settle();
    const a = t.last();
    await push(a, o.aSnapshot === false ? ': connected\n\n' : frameText('snapshot', snap(true, 1)));
    void t.bridge.web.watchMembers(['M-0001']);
    await t.clock.advance(200);
    const b = t.last();
    expect(b).not.toBe(a);
    return { t, a, b, notes, snaps, emergencies };
  }

  it('새 연결이 받아 들여지기 전에 옛 연결로만 나간 알림이 그 뒤에 늦게 와도 한 번 건넨다 — 두 연결로 함께 온 알림·긴급 정지 결과는 하나만, 옛 연결의 스냅숏은 건네지 않는다', async () => {
    const { t, a, b, notes, snaps, emergencies } = await switched();
    const openState = t.states.at(-1);
    await push(b, ': connected\n\n');
    // 서버가 새 연결을 받기 전에 옛 연결로만 보낸 알림 — 느린 옛 연결이라 새 연결의 첫 바이트보다 늦게 왔다 (review2 web-flows low 2, 프로브 A8)
    await push(a, frameText('notification', note('N-0001')));
    // 새 연결의 스냅숏 뒤에 옛 연결의 스냅숏이 와도 건네지 않는다
    await push(b, frameText('snapshot', snap(true, 2)));
    await push(a, frameText('snapshot', snap(true, 1)));
    // 두 연결로 함께 온 것은 어느 쪽이 먼저 와도 하나만 — 알림은 ID로 본다(본문이 달라도)
    await push(a, frameText('notification', note('N-0002')));
    await push(b, frameText('notification', note('N-0002')));
    await push(b, frameText('notification', note('N-0003')));
    await push(a, frameText('notification', note('N-0003', '다른 본문')));
    const summary = { at: '2026-11-05T12:00:01.000Z', completed: true, stoppedTurns: [], heldTasks: [], failures: [] };
    await push(a, frameText('emergency', summary));
    await push(b, frameText('emergency', summary));
    expect(notes.map((n) => (n as { id: string }).id)).toEqual(['N-0001', 'N-0002', 'N-0003']);
    expect((notes[2] as { body: string }).body).toBe('본문');
    expect(snaps).toEqual([snap(true, 1), snap(true, 2)]);
    expect(emergencies).toEqual([summary]);
    // 처음 건넨 연결이 다시 보낸 것은 그대로 건넨다 — 두 연결의 겹침만 뺀다
    const again = { ...summary, at: '2026-11-05T12:00:02.000Z' };
    await push(b, frameText('emergency', again));
    await push(b, frameText('emergency', again));
    expect(emergencies).toEqual([summary, again, again]);
    expect(t.states.at(-1)).toEqual(openState);
    expect(t.resyncs).toEqual([]);
    // WATCH_DRAIN_MS 뒤에 옛 연결을 닫는다. 새 연결은 그대로 건넨다
    await t.clock.advance(WATCH_DRAIN_MS);
    expect([a.aborted, b.aborted]).toEqual([true, false]);
    await push(b, frameText('notification', note('N-0004')));
    expect(notes).toHaveLength(4);
    expect(t.states.some((s) => s.status === 'reconnecting')).toBe(false);
  });

  it('CLI 이벤트는 (팀원, turnId, seq)로 하나만 건넨다 — 겹친 묶음은 처음 온 이벤트만 빼고 건넨다', async () => {
    const t = track(setup());
    const cli: unknown[] = [];
    t.bridge.subscribe('cliEvents', (p) => cli.push(p));
    void t.bridge.web.watchMembers(['M-0001']);
    await settle();
    const a = t.last();
    await push(a, frameText('snapshot', snap(true)));
    void t.bridge.web.watchMembers(['M-0001', 'M-0002']);
    await t.clock.advance(200);
    const b = t.last();
    expect(b.url).toBe('/api/events?members=M-0001,M-0002');
    const batch = (memberId: string, turnId: string, seqs: number[]): unknown => ({
      memberId,
      turnId,
      events: seqs.map((seq) => ({ kind: 'text', text: `줄 ${seq}`, seq, ts: '2026-11-05T12:00:00.000Z', turnId })),
    });
    // 새 연결이 받아 들여지기 전에는 옛 연결이 건넨다 — 새 연결에도 같은 것이 온다
    await push(a, frameText('cliEvents', batch('M-0001', 'TN-1', [1, 2])));
    await push(b, ': connected\n\n');
    await push(b, frameText('cliEvents', batch('M-0001', 'TN-1', [1, 2])));
    await push(b, frameText('cliEvents', batch('M-0001', 'TN-1', [3])));
    await push(a, frameText('cliEvents', batch('M-0001', 'TN-1', [3, 4])));
    // turnId·팀원이 다르면 seq가 같아도 다른 이벤트다
    await push(a, frameText('cliEvents', batch('M-0001', 'TN-2', [1])));
    await push(b, frameText('cliEvents', batch('M-0002', 'TN-1', [1])));
    await push(b, frameText('cliEvents', batch('M-0001', 'TN-2', [1, 2])));
    expect(cli).toEqual([
      batch('M-0001', 'TN-1', [1, 2]),
      batch('M-0001', 'TN-1', [3]),
      batch('M-0001', 'TN-1', [4]),
      batch('M-0001', 'TN-2', [1]),
      batch('M-0002', 'TN-1', [1]),
      batch('M-0001', 'TN-2', [2]),
    ]);
  });

  it('옛 연결이 끝나도 끊김이 아니다 — 새 연결이 끊기면 물러나던 옛 연결도 바로 닫는다', async () => {
    const { t, a, b, notes } = await switched();
    await push(b, ': connected\n\n');
    await push(b, frameText('snapshot', snap(true, 2)));
    const openState = t.states.at(-1);
    a.end();
    await settle();
    expect(t.states.at(-1)).toEqual(openState);
    await push(b, frameText('notification', note('N-0001')));
    expect(notes).toHaveLength(1);
    // 다시 바꿔 c로 — 그 사이에 c가 끊기면 물러나던 b도 닫는다 (이어지면 onResync가 채운다)
    void t.bridge.web.watchMembers(['M-0003']);
    await t.clock.advance(200);
    const c = t.last();
    await push(c, ': connected\n\n');
    expect(b.aborted).toBe(false);
    c.fail();
    await settle();
    expect(b.aborted).toBe(true);
    expect(t.states.at(-1)!.status).toBe('reconnecting');
  });

  it('로그인 상태가 바뀌면 물러나던 옛 연결도 바로 닫는다 — 옛 호출자의 연결이 로그아웃 뒤에 건네지 않게', async () => {
    // (1) 새 연결이 로그인 스냅숏을 받은 뒤 로그아웃 — 다시 열면서 옛 연결도 닫는다 (옛 연결은 스냅숏 전이라 그 로그인 상태를 모른다)
    {
      const { t, a, b, notes } = await switched({ aSnapshot: false });
      await push(b, ': connected\n\n');
      await push(b, frameText('snapshot', snap(true)));
      const openState = t.states.at(-1);
      expect(openState!.status).toBe('open');
      await t.clock.advance(10);
      // 물러나는 동안 첫 프레임이 온 옛 연결은 연결 상태(open since)를 바꾸지 않는다
      await push(a, frameText('notification', note('N-0001')));
      expect(notes).toHaveLength(1);
      expect(t.states.at(-1)).toEqual(openState);
      t.emit('wook:unauthorized');
      await settle();
      expect([a.aborted, b.aborted]).toEqual([true, true]);
      expect(t.states.at(-1)).toEqual({ status: 'connecting' });
      t.bridge.dispose();
    }
    // (2) 새 연결은 아직 스냅숏 전, 옛 연결은 로그인한 연결 — 로그아웃을 알면 옛 연결을 닫는다
    {
      const { t, a, b } = await switched();
      await push(b, ': connected\n\n');
      t.emit('wook:unauthorized');
      await settle();
      expect([a.aborted, b.aborted]).toEqual([true, false]);
    }
  });

  it('물러나는 연결은 하나만 — 다시 바꾸면 앞서 물러나던 연결을 바로 닫는다', async () => {
    const { t, a, b } = await switched();
    await push(b, ': connected\n\n');
    void t.bridge.web.watchMembers(['M-0002']);
    await t.clock.advance(200);
    const c = t.last();
    expect([a.aborted, b.aborted]).toEqual([false, false]);
    await push(c, ': connected\n\n');
    expect([a.aborted, b.aborted, c.aborted]).toEqual([true, false, false]);
    await t.clock.advance(WATCH_DRAIN_MS);
    expect([b.aborted, c.aborted]).toEqual([true, false]);
  });
});

/** 약속이 풀렸는지 본다 (거부하면 rejected) */
function watchState(p: Promise<void>): { state: 'pending' | 'resolved' | 'rejected'; value?: unknown } {
  const r: { state: 'pending' | 'resolved' | 'rejected'; value?: unknown } = { state: 'pending' };
  p.then(
    (v) => {
      r.state = 'resolved';
      r.value = v;
    },
    () => {
      r.state = 'rejected';
    },
  );
  return r;
}

describe('watchMembers의 약속 (S8-17 — 그 팀원을 싣는 연결이 받기 시작했을 때)', () => {
  it('새 목록의 연결은 첫 바이트가 와야 풀린다 — 열기만 했거나 옛 연결이 이벤트를 건네도 아직이다', async () => {
    const t = track(setup());
    t.watch();
    await settle();
    const a = t.last();
    a.send(frameText('snapshot', snap(true)));
    await settle();
    const w = watchState(t.bridge.web.watchMembers(['M-0001']));
    await t.clock.advance(200);
    expect(t.conns).toHaveLength(2);
    const b = t.last();
    // 헤더(200)는 왔지만 본문 바이트는 아직 — 서버가 연결을 받아 들였는지 모른다
    a.send(frameText('cliEvents', { memberId: 'M-0002', seq: 1 }));
    a.send(': ping\n\n');
    await t.clock.advance(5_000);
    expect(w.state).toBe('pending');
    b.send(': connected\n\n');
    await settle();
    expect(w).toEqual({ state: 'resolved', value: undefined });
    await t.clock.advance(WATCH_DRAIN_MS);
    expect(a.aborted).toBe(true);
  });

  it('처음 연결도 그 연결의 첫 바이트에 풀린다', async () => {
    const t = track(setup());
    const w = watchState(t.bridge.web.watchMembers(['M-0003']));
    await settle();
    expect(t.fetches).toEqual(['/api/events?members=M-0003']);
    expect(w.state).toBe('pending');
    t.last().send(': connected\n\n');
    await settle();
    expect(w.state).toBe('resolved');
  });

  it('지금 연결이 이미 싣고 받고 있으면 바로 풀린다 — 같은 목록, 그 안의 일부, 빈 목록', async () => {
    const t = track(setup());
    t.watch();
    await settle();
    t.last().send(frameText('snapshot', snap(true)));
    await settle();
    void t.bridge.web.watchMembers(['M-0001', 'M-0002']);
    await t.clock.advance(200);
    t.last().send(': connected\n\n');
    await settle();
    const same = watchState(t.bridge.web.watchMembers(['M-0002', 'M-0001']));
    await settle();
    expect(same.state).toBe('resolved');
    // 일부로 줄이면 새 연결(M-0002만)을 열지만, 지금 연결이 이미 그 팀원을 싣고 있다
    const part = watchState(t.bridge.web.watchMembers(['M-0002']));
    await settle();
    expect(part.state).toBe('resolved');
    await t.clock.advance(200);
    expect(t.last().url).toBe('/api/events?members=M-0002');
    const none = watchState(t.bridge.web.watchMembers([]));
    await settle();
    expect(none.state).toBe('resolved');
  });

  it('뒤의 watchMembers가 목록을 바꾸면 앞의 약속은 풀린다 — 같은 목록을 다시 부른 약속은 그 연결을 함께 기다린다', async () => {
    const t = track(setup());
    t.watch();
    await settle();
    t.last().send(frameText('snapshot', snap(true)));
    await settle();
    const first = watchState(t.bridge.web.watchMembers(['M-0001']));
    await t.clock.advance(200);
    const again = watchState(t.bridge.web.watchMembers(['M-0001']));
    await settle();
    expect([first.state, again.state]).toEqual(['pending', 'pending']);
    const next = watchState(t.bridge.web.watchMembers(['M-0004']));
    await settle();
    expect([first.state, again.state, next.state]).toEqual(['resolved', 'resolved', 'pending']);
    await t.clock.advance(200);
    expect(t.last().url).toBe('/api/events?members=M-0004');
    t.last().send(': connected\n\n');
    await settle();
    expect(next.state).toBe('resolved');
  });

  it('열린 적이 있는 연결이 끊기면 풀린다(onResync가 채운다) — 끊긴 동안 부른 것도 바로', async () => {
    const t = track(setup());
    t.watch();
    await settle();
    t.last().send(frameText('snapshot', snap(true)));
    await settle();
    const before = watchState(t.bridge.web.watchMembers(['M-0001']));
    await t.clock.advance(200);
    expect(before.state).toBe('pending');
    t.conns[0]!.end();
    await settle();
    expect(t.states.at(-1)!.status).toBe('reconnecting');
    expect(before.state).toBe('resolved');
    const during = watchState(t.bridge.web.watchMembers(['M-0005']));
    await settle();
    expect(during.state).toBe('resolved');
    // 이어지면 지금 목록으로 열고 onResync가 온다
    await t.clock.advance(1_000);
    expect(t.last().url).toBe('/api/events?members=M-0005');
    t.last().send(frameText('snapshot', snap(true)));
    await settle();
    expect(t.resyncs).toEqual([{ runId: 'run-1', runChanged: false }]);
  });

  it('열린 적이 없는 연결이 끊기면(onResync가 오지 않는다) 다시 이어진 연결의 첫 바이트까지 기다린다', async () => {
    let refuse = true;
    const t = track(setup({ events: () => (refuse ? fakeResponse({ status: 503, text: '' }) : null) }));
    t.watch();
    const w = watchState(t.bridge.web.watchMembers(['M-0001']));
    await settle();
    expect(t.states.at(-1)!.status).toBe('reconnecting');
    expect(w.state).toBe('pending');
    refuse = false;
    await t.clock.advance(1_000);
    expect(t.last().url).toBe('/api/events?members=M-0001');
    expect(w.state).toBe('pending');
    t.last().send(': connected\n\n');
    await settle();
    expect(w.state).toBe('resolved');
    expect(t.resyncs).toEqual([]);
  });

  it('열린 적이 없는 연결이 다시 잇는 동안 부른 watchMembers도 다시 이어진 연결의 첫 바이트까지 기다린다 — 같은 목록을 다시 불러도 (S8-26 b)', async () => {
    let refuse = true;
    const t = track(setup({ events: () => (refuse ? fakeResponse({ status: 503, text: '' }) : null) }));
    t.watch();
    await settle();
    expect(t.states.at(-1)!.status).toBe('reconnecting');
    // 끊긴 동안 부른 것 — onResync가 오지 않으니(열린 적 없음) 바로 풀리면 그 팀원의 틈을 채울 것이 없다
    const during = watchState(t.bridge.web.watchMembers(['M-0002']));
    await t.clock.advance(200);
    expect(t.fetches).toEqual(['/api/events']);
    expect(during.state).toBe('pending');
    const again = watchState(t.bridge.web.watchMembers(['M-0002']));
    await settle();
    expect([during.state, again.state]).toEqual(['pending', 'pending']);
    // 두 번째 시도도 실패 — 아직 기다린다
    await t.clock.advance(800);
    expect(t.fetches).toEqual(['/api/events', '/api/events?members=M-0002']);
    expect([during.state, again.state, t.states.at(-1)!.status]).toEqual(['pending', 'pending', 'reconnecting']);
    refuse = false;
    await t.clock.advance(2_000);
    expect(t.last().url).toBe('/api/events?members=M-0002');
    expect([during.state, again.state]).toEqual(['pending', 'pending']);
    t.last().send(': connected\n\n');
    await settle();
    expect([during.state, again.state]).toEqual(['resolved', 'resolved']);
    expect(t.resyncs).toEqual([]);
  });

  it('바꾸려던 새 연결이 실패하면 다시 바꾼 연결이 받기 시작할 때까지 기다린다 — 옛 연결은 그 팀원을 싣지 않는다', async () => {
    let refuse = false;
    const t = track(setup({ events: () => (refuse ? fakeResponse({ status: 503, text: '' }) : null) }));
    t.watch();
    await settle();
    t.last().send(frameText('snapshot', snap(true)));
    await settle();
    refuse = true;
    const w = watchState(t.bridge.web.watchMembers(['M-0001']));
    await t.clock.advance(200);
    expect(w.state).toBe('pending');
    refuse = false;
    await t.clock.advance(1_000);
    expect(t.last().url).toBe('/api/events?members=M-0001');
    expect(w.state).toBe('pending');
    t.last().send(': connected\n\n');
    await settle();
    expect(w.state).toBe('resolved');
  });

  it('남는 약속이 없다 — dispose하면 기다리던 것이 모두 풀리고, 어느 것도 거부하지 않는다', async () => {
    const t = track(setup());
    t.watch();
    await settle();
    t.last().send(frameText('snapshot', snap(true)));
    await settle();
    const all = [['M-0001'], ['M-0002'], ['M-0002'], ['M-0003', 'M-0002'], ['M-0003', 'M-0002']].map((ids) => watchState(t.bridge.web.watchMembers(ids)));
    await t.clock.advance(200);
    // 마지막 목록의 둘만 아직 기다린다 (앞의 셋은 목록이 바뀌어 풀림)
    expect(all.map((w) => w.state)).toEqual(['resolved', 'resolved', 'resolved', 'pending', 'pending']);
    t.bridge.dispose();
    await settle();
    expect(all.map((w) => w.state)).toEqual(['resolved', 'resolved', 'resolved', 'resolved', 'resolved']);
    // dispose 뒤에 부른 것도 바로 풀린다
    const late = watchState(t.bridge.web.watchMembers(['M-0009']));
    await settle();
    expect(late.state).toBe('resolved');
  });
});

describe('이벤트 연결: 로그인 상태가 바뀌면 다시 연다 — 끊김이 아니다', () => {
  it('기기 코드 로그인이 끝나면 로그인 전 연결을 바로 닫고 새로 연다 (connecting, onResync 없음)', async () => {
    const t = track(setup({ invoke: (b) => json(200, { ok: true, value: b.method === 'auth.deviceLoginPoll' ? { status: 'ok', auth: { loggedIn: true } } : null }) }));
    t.watch();
    const snaps: unknown[] = [];
    t.bridge.subscribe('snapshot', (p) => snaps.push(p));
    await settle();
    const a = t.last();
    a.send(frameText('snapshot', snap(false)));
    await settle();
    await t.bridge.invoke('auth.deviceLoginPoll', 'L-1');
    await settle();
    expect(a.aborted).toBe(true);
    expect(t.conns).toHaveLength(2);
    expect(t.states.at(-1)).toEqual({ status: 'connecting' });
    t.last().send(frameText('snapshot', snap(true, 2)));
    await settle();
    expect(t.states.at(-1)!.status).toBe('open');
    expect(t.states.some((s) => s.status === 'reconnecting')).toBe(false);
    expect(snaps).toEqual([snap(false), snap(true, 2)]);
    expect(t.resyncs).toEqual([]);
    // 같은 상태를 다시 알게 돼도 다시 열지 않는다
    await t.bridge.invoke('auth.deviceLoginPoll', 'L-1');
    t.emit('wook:authorized');
    await settle();
    expect(t.conns).toHaveLength(2);
  });

  it('로그아웃 중에 서버가 연결을 먼저 닫아도 끊김(reconnecting)으로 치지 않고 다시 연다', async () => {
    let answer!: (r: Response) => void;
    const t = track(setup({ invoke: (b) => (b.method === 'auth.logout' ? new Promise<Response>((r) => (answer = r)) : json(200, { ok: true, value: null })) }));
    t.watch();
    await settle();
    t.last().send(frameText('snapshot', snap(true)));
    await settle();
    const out = t.bridge.invoke('auth.logout');
    await settle();
    t.last().end(); // 서버가 끊긴 세션의 연결을 닫음
    await t.clock.advance(1_500);
    expect(t.conns).toHaveLength(1);
    answer(json(200, { ok: true, value: { loggedIn: false } }));
    await out;
    await settle();
    expect(t.conns).toHaveLength(2);
    t.last().send(frameText('snapshot', snap(false)));
    await settle();
    expect(t.states.map((s) => s.status)).toEqual(['connecting', 'open', 'connecting', 'open']);
    expect(t.resyncs).toEqual([]);
  });

  it('이 기기를 끊으면(기기 끊기 중에 연결이 닫힘) 로그아웃처럼 다시 열고, 다른 기기를 끊으면 그대로다', async () => {
    let answer!: (r: Response) => void;
    const t = track(setup({ invoke: () => new Promise<Response>((r) => (answer = r)) }));
    t.watch();
    await settle();
    t.last().send(frameText('snapshot', snap(true)));
    await settle();
    const other = t.bridge.invoke('auth.revokeDevice', 'S-other');
    await settle();
    answer(json(200, { ok: true, value: [] }));
    await other;
    await settle();
    expect(t.conns).toHaveLength(1);
    const mine = t.bridge.invoke('auth.revokeDevice', 'S-mine');
    await settle();
    t.last().end();
    await settle();
    answer(json(200, { ok: true, value: [] }));
    await mine;
    await settle();
    expect(t.conns).toHaveLength(2);
    expect(t.states.at(-1)).toEqual({ status: 'connecting' });
    expect(t.states.some((s) => s.status === 'reconnecting')).toBe(false);
  });

  it('로그아웃 답이 5초 안에 오지 않으면 닫힌 연결을 끊김으로 친다', async () => {
    const t = track(setup({ invoke: (b) => (b.method === 'auth.logout' ? new Promise<Response>(() => undefined) : json(200, { ok: true, value: null })) }));
    t.watch();
    await settle();
    t.last().send(frameText('snapshot', snap(true)));
    await settle();
    void t.bridge.invoke('auth.logout');
    await settle();
    const at = t.clock.now();
    t.last().end();
    await t.clock.advance(4_999);
    expect(t.states.at(-1)!.status).toBe('open');
    await t.clock.advance(1);
    expect(t.states.at(-1)).toMatchObject({ status: 'reconnecting', lostAt: at, attempt: 1 });
  });

  it('unauthorized 답과 wook:unauthorized는 로그인한 연결을 다시 연다 — 이미 로그인 전 연결이면 그대로다', async () => {
    const t = track(setup({ invoke: () => json(401, { ok: false, error: { code: 'unauthorized', message: '로그인이 필요합니다' } }) }));
    t.watch();
    await settle();
    t.last().send(frameText('snapshot', snap(true)));
    await settle();
    await rejection(t.bridge.invoke('notifications.list', {}));
    await settle();
    expect(t.conns).toHaveLength(2);
    t.last().send(frameText('snapshot', snap(false)));
    await settle();
    await rejection(t.bridge.invoke('notifications.list', {}));
    t.emit('wook:unauthorized');
    await settle();
    expect(t.conns).toHaveLength(2);
    // 로그인한 연결에 wook:unauthorized
    const t2 = track(setup());
    t2.watch();
    await settle();
    t2.last().send(frameText('snapshot', snap(true)));
    await settle();
    t2.emit('wook:unauthorized');
    await settle();
    expect(t2.conns).toHaveLength(2);
    t.bridge.dispose();
  });

  it('wook:authorized는 로그인 전 연결을 바로 닫고 새로 연다 (connecting, onResync 없음) — 로그인한 연결이면 그대로다', async () => {
    const t = track(setup());
    t.watch();
    await settle();
    const a = t.last();
    a.send(frameText('snapshot', snap(false)));
    await settle();
    t.emit('wook:authorized');
    await settle();
    expect(a.aborted).toBe(true);
    expect(t.conns).toHaveLength(2);
    expect(t.states.at(-1)).toEqual({ status: 'connecting' });
    t.last().send(frameText('snapshot', snap(true, 2)));
    await settle();
    expect(t.states.map((s) => s.status)).toEqual(['connecting', 'open', 'connecting', 'open']);
    expect(t.resyncs).toEqual([]);
    // 이제 로그인한 연결 — 같은 알림을 다시 받아도 다시 열지 않는다
    t.emit('wook:authorized');
    await settle();
    expect(t.conns).toHaveLength(2);
  });

  it('연결이 열리는 동안 로그인이 끝나면 그 연결의 로그인 전 스냅숏은 건네지 않고 한 번만 다시 연다', async () => {
    const t = track(setup({ invoke: () => json(200, { ok: true, value: { status: 'ok', auth: { loggedIn: true } } }) }));
    t.watch();
    const snaps: unknown[] = [];
    t.bridge.subscribe('snapshot', (p) => snaps.push(p));
    await settle();
    await t.bridge.invoke('auth.deviceLoginPoll', 'L-1');
    // 한 조각에 스냅숏 둘 — 첫 것에서 다시 열면 둘째도 건네지 않는다
    t.last().send(frameText('snapshot', snap(false, 1)) + frameText('snapshot', snap(false, 2)));
    await settle();
    expect(t.conns).toHaveLength(2);
    expect(t.conns[0]!.aborted).toBe(true);
    expect(snaps).toEqual([]);
    expect(t.states.map((s) => s.status)).toEqual(['connecting']);
    // 새 연결이 그래도 로그인 전이라고 하면(쿠키가 없었다) 그대로 보이고 더는 다시 열지 않는다 — 고리 없음
    t.last().send(frameText('snapshot', snap(false, 3)));
    t.last().send(frameText('snapshot', snap(false, 4)));
    await settle();
    expect(t.conns).toHaveLength(2);
    expect(snaps).toEqual([snap(false, 3), snap(false, 4)]);
  });
});

describe('web.upload (XMLHttpRequest)', () => {
  class FakeXhr {
    static last: FakeXhr;
    method = '';
    url = '';
    headers: Record<string, string> = {};
    sent: unknown = null;
    aborted = false;
    status = 0;
    responseText = '';
    responseHeaders: Record<string, string> = {};
    upload: { onprogress: ((e: ProgressEvent) => void) | null } = { onprogress: null };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    constructor() {
      FakeXhr.last = this;
    }
    open(method: string, url: string) {
      this.method = method;
      this.url = url;
    }
    setRequestHeader(k: string, v: string) {
      this.headers[k] = v;
    }
    send(body: unknown) {
      this.sent = body;
    }
    abort() {
      this.aborted = true;
      this.onabort?.();
    }
    getResponseHeader(name: string) {
      return this.responseHeaders[name] ?? null;
    }
    progress(loaded: number, total: number) {
      this.upload.onprogress?.({ loaded, total, lengthComputable: true } as ProgressEvent);
    }
    respond(status: number, text: string, headers: Record<string, string> = {}) {
      this.status = status;
      this.responseText = text;
      this.responseHeaders = headers;
      this.onload?.();
    }
  }
  const make = () => track(setup({ env: { createXhr: () => new FakeXhr() as unknown as XMLHttpRequest } }));
  const file = new Blob(['x'.repeat(1000)], { type: 'image/png' });

  it('이름을 주소에 싣고 X-Wook-Client를 붙여 바이트를 그대로 보내며, 진행과 결과를 알린다', async () => {
    const t = make();
    const seen: [number, number][] = [];
    const p = t.bridge.web.upload(file, '보고 서/a&b.png', { onProgress: (s, total) => seen.push([s, total]) });
    const x = FakeXhr.last;
    expect([x.method, x.url, x.headers['X-Wook-Client'], x.sent]).toEqual(['POST', `/api/uploads?name=${encodeURIComponent('보고 서/a&b.png')}`, '1', file]);
    x.progress(400, 1000);
    x.progress(1000, 1000);
    x.respond(200, JSON.stringify({ ok: true, value: { uploadId: 'up_abc', name: 'a.png', size: 1000, expiresAt: '2026-11-06T00:00:00.000Z' } }));
    await expect(p).resolves.toEqual({ uploadId: 'up_abc', name: 'a.png', size: 1000, expiresAt: '2026-11-06T00:00:00.000Z' });
    expect(seen[0]).toEqual([400, 1000]);
    expect(seen.at(-1)).toEqual([1000, 1000]);
  });

  it('서버의 오류 code를 그대로 던진다 — too_large, 429는 Retry-After를 글에', async () => {
    const t = make();
    const p1 = rejection(t.bridge.web.upload(file, 'big.bin'));
    FakeXhr.last.respond(413, JSON.stringify({ ok: false, error: { code: 'too_large', message: '올리는 파일이 너무 큽니다 (50MB까지)' } }));
    expect([(await p1).code, (await p1).message]).toEqual(['too_large', '올리는 파일이 너무 큽니다 (50MB까지)']);
    const p2 = rejection(t.bridge.web.upload(file, 'b.bin'));
    FakeXhr.last.respond(429, JSON.stringify({ ok: false, error: { code: 'rate_limited', message: '이 기기에서 올리는 파일이 이미 여러 개입니다 — 끝난 뒤에 올려 주세요' } }), { 'Retry-After': '5' });
    expect([(await p2).code, (await p2).retryAfterSec]).toEqual(['rate_limited', 5]);
    const p3 = rejection(t.bridge.web.upload(file, 'c.bin'));
    FakeXhr.last.respond(502, '<html>bad gateway</html>');
    expect((await p3).code).toBe('bad_response');
    const p4 = rejection(t.bridge.web.upload(file, 'd.bin'));
    FakeXhr.last.respond(200, JSON.stringify({ ok: true, value: { uploadId: 1 } }));
    expect((await p4).code).toBe('bad_response');
    const p5 = rejection(t.bridge.web.upload(file, 'e.bin'));
    FakeXhr.last.onerror?.();
    expect((await p5).code).toBe('network');
  });

  it('올리기가 unauthorized면 로그인한 이벤트 연결을 다시 연다 (connecting, onResync 없음) — 세션이 끝난 연결이 남지 않게', async () => {
    const t = make();
    t.watch();
    await settle();
    const a = t.last();
    a.send(frameText('snapshot', snap(true)));
    await settle();
    const p = rejection(t.bridge.web.upload(file, 'a.bin'));
    FakeXhr.last.respond(401, JSON.stringify({ ok: false, error: { code: 'unauthorized', message: '로그인이 필요합니다' } }));
    expect((await p).code).toBe('unauthorized');
    await settle();
    expect(a.aborted).toBe(true);
    expect(t.conns).toHaveLength(2);
    expect(t.states.at(-1)).toEqual({ status: 'connecting' });
    t.last().send(frameText('snapshot', snap(false)));
    await settle();
    expect(t.states.map((s) => s.status)).toEqual(['connecting', 'open', 'connecting', 'open']);
    expect(t.resyncs).toEqual([]);
  });

  it('signal로 멈추면 XHR을 끊고 aborted — 이미 멈춘 signal이면 보내지도 않는다', async () => {
    const t = make();
    const c = new AbortController();
    const seen: number[] = [];
    const p = rejection(t.bridge.web.upload(file, 'a.bin', { signal: c.signal, onProgress: (s) => seen.push(s) }));
    const x = FakeXhr.last;
    x.progress(10, 1000);
    c.abort();
    const e = await p;
    expect([e.name, e.code, x.aborted]).toEqual(['WookError', 'aborted', true]);
    x.progress(20, 1000);
    expect(seen).toEqual([10]);
    const before = FakeXhr.last;
    const done = new AbortController();
    done.abort();
    expect((await rejection(t.bridge.web.upload(file, 'b.bin', { signal: done.signal }))).code).toBe('aborted');
    expect(FakeXhr.last).toBe(before);
  });
});

describe('web.downloadUrl', () => {
  it('모양이 맞는 대상만 같은 출처의 /api 주소로', () => {
    expect(downloadUrlFor({ kind: 'attachment', id: 'A-12' as never })).toBe('/api/attachments/A-12');
    expect(downloadUrlFor({ kind: 'reportFile', reportId: 'R-0009' as never })).toBe('/api/reports/R-0009/file');
    expect(downloadUrlFor({ kind: 'export', path: 'D:\\wook-data\\exports\\욱채 기록 2026.zip' })).toBe(`/api/exports/${encodeURIComponent('욱채 기록 2026.zip')}`);
    expect(downloadUrlFor({ kind: 'export', path: '/srv/wook/exports/logs-1.zip' })).toBe('/api/exports/logs-1.zip');
    for (const bad of [
      { kind: 'attachment', id: '../A-1' },
      { kind: 'attachment', id: 'A-1/../../x' },
      { kind: 'attachment', id: 'A-' },
      { kind: 'reportFile', reportId: 'R-1?x' },
      { kind: 'reportFile', reportId: 'r-1' },
      { kind: 'export', path: '' },
      { kind: 'export', path: 'C:\\exports\\' },
      { kind: 'export', path: '/exports/..' },
      { kind: 'export', path: 'a..zip' },
      { kind: 'other', id: 'x' },
      null,
    ]) {
      expect(downloadUrlFor(bad as never), JSON.stringify(bad)).toBeNull();
    }
    const t = track(setup());
    expect(t.bridge.web.downloadUrl({ kind: 'attachment', id: 'A-3' as never })).toBe('/api/attachments/A-3');
  });
});
