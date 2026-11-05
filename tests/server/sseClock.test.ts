/**
 * SSE 만료는 벽시계로도 본다 (SERVER_DESIGN 3.4, S2-2·S2-8·S2-20 — 리뷰 security-surface N5의 프로브 zz-s2f1sec-n5-sseclock을 옮김, 리드 결정 S3-4).
 * 기기 세션의 만료(DeviceSessionStore.verify)는 벽시계(Date.now)다. 연결 때 건 만료 타이머는 단조 시계라, 벽시계가 앞으로 뛰면(Linux 절전에서 깨어남 —
 * CLOCK_MONOTONIC은 절전 시간을 세지 않는다, NTP 보정) 늦게 울린다. 그동안 그 토큰으로 연 연결이 알림·살아 있음 신호를 받으면 안 된다 — 보낼 때와
 * 살아 있음 신호마다 벽시계로 보고 닫는다. 서버와 기기 세션에 같은 시계를 넘겨 앞으로 돌려 흉내 낸다
 */
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { SESSION_IDLE_MS } from '../../src/main/auth/deviceSessions';
import { createHttpSurface, type HttpSurface } from '../../src/server/http';
import { fakeTopicBackend, invokeHttp, memoryLogger, memorySessions, openSse, sleep } from './helpers';

interface Rig {
  url: string;
  surface: HttpSurface;
  token: string;
  /** 벽시계를 앞으로 */
  jump(ms: number): void;
  emit(topic: string, payload: unknown): void;
  close(): Promise<void>;
}

let rig: Rig | null = null;
afterEach(async () => {
  await rig?.close();
  rig = null;
});

async function open(heartbeatMs: number): Promise<Rig> {
  let skew = 0;
  const now = () => Date.now() + skew;
  const fake = fakeTopicBackend({ snapshotVersion: 1 });
  const mem = memorySessions({ now });
  let port = 0;
  const surface = createHttpSurface({ backend: fake.backend, sessions: mem.sessions, logger: memoryLogger(), runId: 'run-시계', port: () => port, webDir: null, now, heartbeatMs });
  const server: Server = createServer((req, res) => surface.handle(req, res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as { port: number }).port;
  rig = {
    url: `http://127.0.0.1:${port}`,
    surface,
    token: mem.issue(),
    jump: (ms) => (skew += ms),
    emit: fake.emit,
    close: async () => {
      surface.closeStreams();
      surface.dispose();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      mem.close();
    },
  };
  return rig;
}

/** 쉬는 만료(14일) + 1시간 — 세션이 벽시계로 만료된 뒤 */
const PAST_EXPIRY = SESSION_IDLE_MS + 60 * 60 * 1000;

describe('SSE 만료와 벽시계 (S2-20)', () => {
  it('벽시계로 만료가 지난 토큰의 연결에는 알림을 보내지 않고 닫는다 — 같은 토큰의 invoke가 401인 것처럼', async () => {
    // 살아 있음 신호는 오지 않게(1분) — 보낼 때 보는지만 본다
    const r = await open(60_000);
    const sse = await openSse(r.url, r.token);
    expect(sse.status).toBe(200);
    await sse.waitFor((ev) => ev.some((e) => e.event === 'snapshot'), '첫 스냅숏', 10_000);
    r.emit('notification', { id: 'N-만료-전' });
    await sse.waitFor((ev) => ev.some((e) => e.event === 'notification'), '만료 전 알림', 10_000);
    r.jump(PAST_EXPIRY);
    r.emit('notification', { id: 'N-만료-뒤' });
    await sleep(300);
    expect(sse.events.filter((e) => e.event === 'notification').map((e) => (e.data.payload as { id: string }).id)).toEqual(['N-만료-전']);
    expect(sse.ended()).toBe(true);
    expect(r.surface.streamCount()).toBe(0);
    expect((await invokeHttp(r.url, r.token, 'auth.getState')).status).toBe(401);
  });

  it('보낼 이벤트가 없어도 살아 있음 신호 때 벽시계로 보고 닫는다 — 만료 뒤에는 살아 있음 신호도 가지 않는다', async () => {
    const r = await open(100);
    const sse = await openSse(r.url, r.token);
    await sse.waitFor((ev) => ev.some((e) => e.event === 'snapshot'), '첫 스냅숏', 10_000);
    await sleep(250);
    expect((sse.raw().match(/^: ping$/gm) ?? []).length, '만료 전에는 살아 있음 신호가 온다').toBeGreaterThan(0);
    r.jump(PAST_EXPIRY);
    // 뛰기 전에 보낸 신호가 오는 동안을 지나 센다
    await sleep(150);
    const seen = sse.raw().length;
    await sleep(450);
    expect(sse.raw().slice(seen).includes(': ping'), '만료 뒤 살아 있음 신호').toBe(false);
    expect(sse.ended()).toBe(true);
    expect(r.surface.streamCount()).toBe(0);
  });
});
