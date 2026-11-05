/**
 * 살아 있는 세션의 SSE는 연결 때의 만료에 닫히지 않는다 (SERVER_DESIGN 3.4 밀어주기, 리드 결정 S3-27 — 검토 프로브 zz-s3fl-inproc P1을 옮김).
 * 연결 때 건 만료 타이머는 그때 알던 쉬는 만료에 맞춰져 있다. 같은 기기가 다른 요청으로 세션을 쓰면 쉬는 만료가 늦춰진다 — 타이머가 울려도 세션을 벽시계로
 * 다시 보고 살아 있으면 다시 건다. 살아 있음 신호가 늦춰진 만료를 보면 그때 다시 건다. 정말 끝난 세션은 예전처럼 닫는다.
 * 기기 세션과 서버에 같은 손 시계를 넘긴다 — 쉬는 만료를 60.3초로 줄여, 연결은 마지막 사용 59.999초 뒤에 열어 타이머가 301ms 뒤에 울리게 한다
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startServer, type RunningServer } from '../../src/server/server';
import { fakeServerBackend, fakeTopicBackend, invokeHttp, memoryLogger, memorySessions, openSse, removeDir, sleep, type SseClient } from './helpers';

const T0 = 1_700_000_000_000;
const IDLE_MS = 60_300;
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function open(heartbeatMs: number) {
  let t = T0;
  const clock = { now: () => t, set: (ms: number) => (t = ms) };
  const mem = memorySessions({ now: clock.now, idleMs: IDLE_MS });
  cleanups.push(mem.close);
  const token = mem.issue(); // 마지막 사용 T0 → 쉬는 만료 T0 + 60.3초
  const fake = fakeTopicBackend();
  const op = fakeServerBackend();
  cleanups.push(op.close);
  const log = memoryLogger();
  const dir = mkdtempSync(join(tmpdir(), 'wook-test-sse-expiry-'));
  cleanups.push(() => removeDir(dir));
  const server: RunningServer = await startServer({
    backend: { ...fake.backend, hasActiveWork: () => false, sessions: mem.sessions, operator: op.backend.operator },
    dataDir: dir,
    port: 0,
    allowTestSession: false,
    logger: log,
    version: 'test',
    now: clock.now,
    sse: { heartbeatMs },
  });
  cleanups.push(() => server.close());
  const id = mem.sessions.list()[0]!.id;
  /** 연결은 마지막 사용 59.999초 뒤 — verify는 1분이 안 돼 늦추지 않는다 → 이 연결이 아는 만료는 301ms 뒤 */
  const connect = async (): Promise<SseClient> => {
    clock.set(T0 + 59_999);
    const sse = await openSse(server.url, token);
    cleanups.push(() => sse.close());
    await sse.waitFor((ev) => ev.some((e) => e.event === 'snapshot'), '첫 스냅숏', 5_000);
    return sse;
  };
  /** 같은 기기의 다른 요청 — 마지막 사용 60.001초 뒤라 verify가 쉬는 만료를 T0 + 120.301초로 늦춘다 */
  const touch = async (): Promise<void> => {
    clock.set(T0 + 60_001);
    expect((await invokeHttp(server.url, token, 'auth.getState')).status).toBe(200);
    expect(Date.parse(mem.sessions.live(id)!.idleExpiresAt)).toBe(T0 + 120_301);
  };
  const closedAsExpired = (): number => log.lines.filter((l) => l.includes('SSE 연결 닫음 (기기 세션 만료)')).length;
  return { clock, mem, id, server, connect, touch, closedAsExpired };
}

describe('SSE 만료는 살아 있는 세션을 따른다 (S3-27)', () => {
  it('만료 타이머가 울려도 세션이 늦춰졌으면 닫지 않는다 — 살아 있음 신호가 오기 전에도 (타이머가 세션을 다시 본다)', async () => {
    // 살아 있음 신호는 오지 않게(1분) — 타이머의 다시 보기만 본다
    const r = await open(60_000);
    const sse = await r.connect();
    await r.touch();
    await sleep(700); // 연결 때의 만료(301ms 뒤)를 지나도록 — 벽시계는 T0 + 60.001초 그대로, 세션은 내내 살아 있다
    expect(r.mem.sessions.live(r.id)).not.toBeNull();
    expect({ streamEnded: sse.ended(), closedAsExpired: r.closedAsExpired() }).toEqual({ streamEnded: false, closedAsExpired: 0 });
    // 벽시계도 연결 때의 만료를 지나간다(늦춘 만료 전) — 그 만료만 보고 닫지 않고 저장소의 세션을 다시 본다
    r.clock.set(T0 + 61_000);
    await sleep(400);
    expect({ streamEnded: sse.ended(), closedAsExpired: r.closedAsExpired() }).toEqual({ streamEnded: false, closedAsExpired: 0 });
  });

  it('살아 있음 신호가 늦춰진 만료를 보면 타이머를 다시 건다 — 연결이 그대로 받는다', async () => {
    const r = await open(50);
    const sse = await r.connect();
    await r.touch();
    await sleep(700);
    expect({ streamEnded: sse.ended(), closedAsExpired: r.closedAsExpired() }).toEqual({ streamEnded: false, closedAsExpired: 0 });
    expect(sse.events.length).toBeGreaterThan(0);
  });

  it('정말 끝난 세션은 예전처럼 닫는다 — 늦춘 만료를 지난 벽시계, 늦추지 않은 세션의 타이머', async () => {
    const r = await open(50);
    const sse = await r.connect();
    await r.touch();
    r.clock.set(T0 + 120_301); // 늦춘 만료에 닿음
    await sse.waitFor(() => sse.ended(), '늦춘 만료 뒤 닫힘', 5_000);
    expect(r.closedAsExpired()).toBe(1);
    // 늦추지 않은 세션: 연결 때의 만료(301ms 뒤)에 손 시계도 닿으면 타이머가 닫는다
    const r2 = await open(60_000);
    const sse2 = await r2.connect();
    r2.clock.set(T0 + IDLE_MS);
    await sse2.waitFor(() => sse2.ended(), '타이머가 닫음', 5_000);
    expect(r2.closedAsExpired()).toBe(1);
  });
});
