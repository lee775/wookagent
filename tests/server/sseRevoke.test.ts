/**
 * 끊긴 기기 세션의 SSE를 닫는다 (SERVER_DESIGN 3.4, S2-8 '토큰이 끝나면 닫는다', S2-16 — 리뷰 security-surface E3의 프로브를 옮김, 리드 결정 S3-4).
 * 끊은 세션의 토큰은 invoke에서 401인데, 그 토큰으로 이미 연 SSE가 처음 정한 만료까지 이벤트를 받으면 안 된다. 연결마다 세션 ID를 붙여 두고, 세션을
 * 끊으면(그 기기 로그아웃·기기 끊기·모두 끊기) 그 세션으로 연 연결만 닫는다. 2단계의 50개 상한으로 버리기는 기기 세션에 없다 — 끊기가 그 자리를 잇는다.
 * 백엔드는 토픽을 손으로 내는 가짜다
 */
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { DeviceSessionStore } from '../../src/main/auth/deviceSessions';
import { createHttpSurface, type HttpSurface } from '../../src/server/http';
import { fakeTopicBackend, invokeHttp, memoryLogger, memorySessions, openSse, sleep } from './helpers';

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

async function rig(): Promise<{ url: string; surface: HttpSurface; sessions: DeviceSessionStore; emit(topic: string, payload: unknown): void; log: ReturnType<typeof memoryLogger> }> {
  const fake = fakeTopicBackend({ snapshotVersion: 1 });
  const mem = memorySessions();
  const log = memoryLogger();
  let port = 0;
  const surface = createHttpSurface({ backend: fake.backend, sessions: mem.sessions, logger: log, runId: 'run-시험', port: () => port, webDir: null });
  const server: Server = createServer((req, res) => surface.handle(req, res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as { port: number }).port;
  cleanup = async () => {
    surface.closeStreams();
    surface.dispose();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    mem.close();
  };
  return { url: `http://127.0.0.1:${port}`, surface, sessions: mem.sessions, log, emit: fake.emit };
}

describe('끊긴 기기 세션의 SSE (S2-16, S3-4)', () => {
  it('끊은 세션의 SSE는 닫히고 그 뒤 알림을 받지 않는다 — 다른 세션의 연결은 그대로', async () => {
    const r = await rig();
    const first = r.sessions.issue({ deviceName: '휴대폰' });
    const revoked = await openSse(r.url, first.token);
    expect(revoked.status).toBe(200);
    expect((await invokeHttp(r.url, first.token, 'auth.getState')).status).toBe(200);
    const second = r.sessions.issue({ deviceName: '노트북' }).token;
    const kept = await openSse(r.url, second);
    expect(r.surface.streamCount()).toBe(2);
    expect(r.sessions.revoke(first.session.id, 'owner')).not.toBeNull();
    expect(r.sessions.verify(first.token)).toBeNull();
    expect((await invokeHttp(r.url, first.token, 'auth.getState')).status).toBe(401);
    r.emit('notification', { id: 'N-AFTER-REVOKE', title: '끊은 뒤 알림' });
    await kept.waitFor((ev) => ev.some((e) => e.event === 'notification'), '남은 연결의 알림', 10_000);
    await sleep(200);
    expect({ ended: revoked.ended(), gotAfter: revoked.events.filter((e) => e.event === 'notification').length, open: r.surface.streamCount() }).toEqual({ ended: true, gotAfter: 0, open: 1 });
    expect(kept.ended()).toBe(false);
    expect(r.log.text()).toContain('SSE 연결 닫음 (기기 세션이 끝남)');
    kept.close();
  });

  it('세션을 모두 끊으면(revokeAll) 그 세션들로 연 연결이 닫힌다', async () => {
    const r = await rig();
    const a = await openSse(r.url, r.sessions.issue({ deviceName: 'a' }).token);
    const b = await openSse(r.url, r.sessions.issue({ deviceName: 'b' }).token, '?members=M-0001');
    expect(r.surface.streamCount()).toBe(2);
    expect(r.sessions.revokeAll('operator')).toBe(2);
    await sleep(200);
    expect([a.ended(), b.ended(), r.surface.streamCount()]).toEqual([true, true, 0]);
  });
});
