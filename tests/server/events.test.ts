/**
 * 밀어주기 `GET /api/events` (SERVER_DESIGN 3.4, S2-8): 표준 라이브러리 SSE.
 * - 연결하자마자 지금 스냅숏, 모든 이벤트에 서버 실행 ID (`data: {"runId", "payload"}`), 20초마다 살아 있음 신호(여기서는 짧게)
 * - `cliEvents`는 `?members=`로 고른 팀원 것만, 고르지 않으면 보내지 않는다. 잘못된 ID는 400
 * - 느린 연결: 스냅숏은 가장 최근 것 하나만 두고, 다른 토픽은 상한까지 쌓았다가 넘으면 끊는다 — 연결을 둔 채 알림을 버리지 않는다
 * - 기기 세션이 끝나거나 서버가 끝나면 닫는다
 * 백엔드는 토픽을 손으로 내는 가짜(fakeTopicBackend)이고 세션은 메모리 저장소의 기기 세션이다 — 연결 쪽 동작만 본다. 실제 백엔드와 함께 도는 흐름은
 * mockFlow.test, 세션 없는 연결의 거르기는 sessionGate.test가 본다
 */
import { createServer, type Server } from 'node:http';
import { connect } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { WookTopic } from '@shared/ipc';
import { createHttpSurface, type HttpSurface } from '../../src/server/http';
import { fakeTopicBackend, httpCall, memoryLogger, memorySessions, openSse, sleep, type SseClient } from './helpers';

interface Rig {
  url: string;
  port: number;
  surface: HttpSurface;
  token: string;
  emit(topic: WookTopic, payload: unknown): void;
  listeners(): number;
  close(): Promise<void>;
}

const rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.close();
});

async function rig(o: { heartbeatMs?: number; queueLimit?: number; ttlMs?: number; snapshotVersion?: number; snapshotDelayMs?: number } = {}): Promise<Rig> {
  const fake = fakeTopicBackend({ snapshotVersion: o.snapshotVersion, snapshotDelayMs: o.snapshotDelayMs });
  const mem = memorySessions({ idleMs: o.ttlMs });
  let port = 0;
  const surface = createHttpSurface({ backend: fake.backend, sessions: mem.sessions, logger: memoryLogger(), runId: 'run-시험', port: () => port, webDir: null, heartbeatMs: o.heartbeatMs, sseQueueLimit: o.queueLimit });
  const server: Server = createServer((req, res) => surface.handle(req, res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as { port: number }).port;
  const r: Rig = {
    url: `http://127.0.0.1:${port}`,
    port,
    surface,
    token: mem.issue(),
    emit: fake.emit,
    listeners: fake.listeners,
    close: async () => {
      surface.closeStreams();
      surface.dispose();
      server.closeAllConnections();
      await new Promise<void>((res) => server.close(() => res()));
      mem.close();
    },
  };
  rigs.push(r);
  return r;
}

const payloads = (c: SseClient, topic: string) => c.events.filter((e) => e.event === topic).map((e) => e.data.payload);

describe('연결과 형식', () => {
  it('연결하자마자 지금 스냅숏을 보내고, 모든 이벤트에 실행 ID가 붙는다', async () => {
    const r = await rig();
    const c = await openSse(r.url, r.token);
    expect(c.status).toBe(200);
    await c.waitFor((ev) => ev.some((e) => e.event === 'snapshot'), '첫 스냅숏', 10_000);
    expect(c.events[0]).toEqual({ event: 'snapshot', data: { runId: 'run-시험', payload: { version: 5, from: 'invoke' } } });
    r.emit('notification', { id: 'N-1', title: '알림' });
    r.emit('emergency', { at: 'x' });
    r.emit('snapshot', { version: 6 });
    await c.waitFor((ev) => ev.length >= 4, '토픽 셋');
    expect(c.events.slice(1)).toEqual([
      { event: 'notification', data: { runId: 'run-시험', payload: { id: 'N-1', title: '알림' } } },
      { event: 'emergency', data: { runId: 'run-시험', payload: { at: 'x' } } },
      { event: 'snapshot', data: { runId: 'run-시험', payload: { version: 6 } } },
    ]);
    c.close();
  });

  it('연결 때 읽은 스냅숏보다 새 스냅숏이 먼저 갔으면 옛것을 뒤에 보내지 않는다', async () => {
    // 연결 때 읽는 스냅숏(3)이 늦게 와서 버스 스냅숏(9, 더 새것)이 먼저 나가는 순서를 만든다
    const r = await rig({ snapshotVersion: 3, snapshotDelayMs: 300 });
    const c = await openSse(r.url, r.token);
    r.emit('snapshot', { version: 9 });
    await sleep(600);
    const versions = payloads(c, 'snapshot').map((p) => (p as { version: number }).version);
    expect(versions).toEqual([9]);
    c.close();
  });

  it('살아 있음 신호를 주기마다 보낸다', async () => {
    const r = await rig({ heartbeatMs: 40 });
    const c = await openSse(r.url, r.token);
    await sleep(300);
    expect((c.raw().match(/^: ping$/gm) ?? []).length).toBeGreaterThanOrEqual(3);
    c.close();
  });

  it('토픽은 서버가 한 번만 구독한다 — 연결 수와 상관없이', async () => {
    const r = await rig();
    const n = r.listeners();
    const a = await openSse(r.url, r.token);
    const b = await openSse(r.url, r.token);
    expect(r.listeners()).toBe(n);
    expect(n).toBe(6);
    a.close();
    b.close();
  });
});

describe('cliEvents는 고른 팀원 것만', () => {
  it('?members=로 고른 팀원의 CLI 이벤트만, 고르지 않으면 하나도 보내지 않는다', async () => {
    const r = await rig();
    const one = await openSse(r.url, r.token, '?members=M-0001');
    const two = await openSse(r.url, r.token, '?members=M-0002,M-MAIN');
    const none = await openSse(r.url, r.token);
    for (const m of ['M-0001', 'M-0002', 'M-MAIN', 'M-0003']) r.emit('cliEvents', { memberId: m, turnId: 't', events: [] });
    r.emit('notification', { id: 'N-끝' });
    for (const c of [one, two, none]) await c.waitFor((ev) => ev.some((e) => e.event === 'notification'), '끝 표시');
    expect(payloads(one, 'cliEvents').map((p) => (p as { memberId: string }).memberId)).toEqual(['M-0001']);
    expect(payloads(two, 'cliEvents').map((p) => (p as { memberId: string }).memberId)).toEqual(['M-0002', 'M-MAIN']);
    expect(payloads(none, 'cliEvents')).toEqual([]);
    for (const c of [one, two, none]) c.close();
  });

  it('팀원 ID는 정확히 같아야 한다 — M-0001이 M-00010의 이벤트를 받지 않고, M-00010도 M-0001의 것을 받지 않는다 (S2-17)', async () => {
    // 팀원 ID는 M-와 숫자 4~9자리라 한 ID가 다른 ID의 앞부분일 수 있다 — 앞부분·포함으로 고르면 남의 CLI 출력이 간다
    const r = await rig();
    const short = await openSse(r.url, r.token, '?members=M-0001');
    const long = await openSse(r.url, r.token, '?members=M-00010');
    for (const m of ['M-00010', 'M-0001', 'M-00100', 'M-001']) r.emit('cliEvents', { memberId: m, turnId: 't', events: [] });
    r.emit('notification', { id: 'N-끝' });
    for (const c of [short, long]) await c.waitFor((ev) => ev.some((e) => e.event === 'notification'), '끝 표시');
    expect(payloads(short, 'cliEvents').map((p) => (p as { memberId: string }).memberId)).toEqual(['M-0001']);
    expect(payloads(long, 'cliEvents').map((p) => (p as { memberId: string }).memberId)).toEqual(['M-00010']);
    for (const c of [short, long]) c.close();
  });

  it('?members=에 팀원 ID가 아닌 것이 있으면 400', async () => {
    const r = await rig();
    for (const q of ['?members=../x', '?members=M-0001,DROP', '?members=m-0001', `?members=${Array.from({ length: 51 }, (_, i) => `M-${String(i).padStart(4, '0')}`).join(',')}`]) {
      const res = await httpCall({ url: r.url, path: `/api/events${q}`, headers: { Authorization: `Bearer ${r.token}` } });
      expect(res.status, q).toBe(400);
      expect(res.json()).toMatchObject({ ok: false, error: { code: 'invalid_args' } });
    }
  });
});

/** 읽지 않는 SSE 클라이언트 — 받은 바이트는 다시 읽기 시작할 때까지 커널에 쌓인다 */
async function stalledClient(r: Rig): Promise<{ resume(): Promise<string>; closed(): boolean }> {
  const socket = connect(r.port, '127.0.0.1');
  await new Promise<void>((res) => socket.once('connect', () => res()));
  socket.write(`GET /api/events HTTP/1.1\r\nHost: 127.0.0.1:${r.port}\r\nAuthorization: Bearer ${r.token}\r\n\r\n`);
  let text = '';
  let closed = false;
  socket.on('close', () => (closed = true));
  socket.on('error', () => (closed = true));
  socket.setEncoding('utf8');
  // 머리와 첫 스냅숏을 받은 뒤 읽기를 멈춘다
  await new Promise<void>((res) => {
    const onData = (c: string) => {
      text += c;
      if (text.includes('event: snapshot')) {
        socket.off('data', onData);
        socket.pause();
        res();
      }
    };
    socket.on('data', onData);
  });
  return {
    closed: () => closed,
    async resume() {
      socket.on('data', (c: string) => (text += c));
      socket.resume();
      let last = -1;
      while (text.length !== last) {
        last = text.length;
        await sleep(400);
      }
      socket.destroy();
      return text;
    },
  };
}

const parseFrames = (text: string) =>
  text
    .split('\n\n')
    .map((b) => ({ event: /^event: (.+)$/m.exec(b)?.[1], data: /^data: (.+)$/m.exec(b)?.[1] }))
    .filter((f): f is { event: string; data: string } => !!f.event && !!f.data)
    .map((f) => ({ event: f.event, payload: (JSON.parse(f.data) as { payload: { version?: number; id?: string } }).payload }));

describe('느린 연결 (S2-8)', () => {
  it('막힌 동안 스냅숏은 가장 최근 것 하나만 남기고, 알림은 하나도 버리지 않고 차례대로 보낸다', async () => {
    const r = await rig();
    const c = await stalledClient(r);
    const big = 'x'.repeat(512 * 1024);
    // 커널 버퍼를 넘길 만큼 큰 스냅숏을 보내 쓰기가 막히게 한다
    for (let v = 10; v < 70; v++) r.emit('snapshot', { version: v, big });
    for (let i = 1; i <= 5; i++) r.emit('notification', { id: `N-${i}` });
    r.emit('snapshot', { version: 999 });
    const frames = parseFrames(await c.resume());
    const snapshots = frames.filter((f) => f.event === 'snapshot').map((f) => f.payload.version);
    // 받은 스냅숏은 보낸 61개보다 적다(합쳐짐), 마지막은 가장 최근 것, 줄어들지 않는다
    expect(snapshots.length).toBeLessThan(40);
    expect(snapshots[snapshots.length - 1]).toBe(999);
    expect([...snapshots].sort((a, b) => a! - b!)).toEqual(snapshots);
    expect(frames.filter((f) => f.event === 'notification').map((f) => f.payload.id)).toEqual(['N-1', 'N-2', 'N-3', 'N-4', 'N-5']);
  }, 60_000);

  it('막힌 동안 다른 토픽이 상한을 넘으면 연결을 끊는다 — 둔 채 버리지 않는다', async () => {
    const r = await rig({ queueLimit: 5 });
    const c = await stalledClient(r);
    const big = 'x'.repeat(512 * 1024);
    for (let v = 10; v < 70; v++) r.emit('snapshot', { version: v, big });
    expect(r.surface.streamCount()).toBe(1);
    for (let i = 1; i <= 8; i++) r.emit('notification', { id: `N-${i}` });
    expect(r.surface.streamCount()).toBe(0);
    const frames = parseFrames(await c.resume());
    const ids = frames.filter((f) => f.event === 'notification').map((f) => f.payload.id);
    // 끊긴 연결에는 넘친 알림이 오지 않는다 — 화면은 다시 연결해 스냅숏과 notifications.list로 맞춘다
    expect(ids.length).toBeLessThan(8);
  }, 60_000);
});

describe('닫기', () => {
  it('기기 세션이 끝나면 연결을 닫고, 그 토큰은 더는 받지 않는다', async () => {
    const r = await rig({ ttlMs: 400 });
    const c = await openSse(r.url, r.token);
    await sleep(800);
    expect(c.ended()).toBe(true);
    expect(r.surface.streamCount()).toBe(0);
    expect((await httpCall({ url: r.url, path: '/api/events', headers: { Authorization: `Bearer ${r.token}` } })).status).toBe(401);
  });

  it('서버가 끝나면(closeStreams) 열린 연결을 모두 닫는다', async () => {
    const r = await rig();
    const a = await openSse(r.url, r.token);
    const b = await openSse(r.url, r.token, '?members=M-0001');
    expect(r.surface.streamCount()).toBe(2);
    r.surface.closeStreams();
    await sleep(200);
    expect([a.ended(), b.ended(), r.surface.streamCount()]).toEqual([true, true, 0]);
  });

  it('클라이언트가 끊으면 연결 목록에서 빠진다', async () => {
    const r = await rig();
    const a = await openSse(r.url, r.token);
    expect(r.surface.streamCount()).toBe(1);
    a.close();
    await sleep(200);
    expect(r.surface.streamCount()).toBe(0);
  });
});
