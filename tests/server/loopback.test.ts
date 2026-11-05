/**
 * 두 루프백을 함께 잡는다 (SERVER_DESIGN 3.2·3.6, S2-3·S2-14 — 리뷰 security-surface E2의 프로브를 옮김).
 * Host 검사는 localhost·[::1]도 이 서버로 받는데 Windows에서 localhost는 ::1이 먼저다. 서버가 127.0.0.1 하나만 잡으면 같은 PC의 다른 계정이
 * [::1]:<포트>에서 듣다가 localhost로 보낸 Bearer 토큰을 받는다. 그래서 같은 포트의 127.0.0.1과 ::1을 모두 잡고, 하나라도 이미 쓰이면 시작하지 않는다.
 * 이 PC에 IPv6 루프백이 없으면 127.0.0.1만 연다(그때 localhost는 127.0.0.1로만 간다). 빈 포트를 고를 때 ::1의 같은 번호가 쓰이면 새 번호로 다시 한다
 */
import { lookup } from 'node:dns/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../e2e/harness';
import { adminRequest, adminTokenPath } from '../../src/server/admin';
import { listenLoopback, ServerStartError, startServer, type AdminStatus, type RunningServer } from '../../src/server/server';
import { memoryLogger, remoteBackendOf, removeDir } from './helpers';

let h: Harness;
let server: RunningServer;
let token = '';
const dirs: string[] = [];

/** 이 PC에 IPv6 루프백이 있는지 */
async function hasV6(): Promise<boolean> {
  const s = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      s.once('error', reject);
      s.listen(0, '::1', () => resolve());
    });
    return true;
  } catch {
    return false;
  } finally {
    await new Promise<void>((r) => (s.listening ? s.close(() => r()) : r()));
  }
}

/** host:port에서 들어 본다 — 이미 쓰이면 그 오류 code */
function tryListen(host: string, port: number): Promise<{ server: Server | null; code: string | null }> {
  return new Promise((resolve) => {
    const s = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true,"value":{"loggedIn":true}}');
    });
    s.once('error', (e: NodeJS.ErrnoException) => resolve({ server: null, code: e.code ?? 'error' }));
    s.listen({ host, port, exclusive: true }, () => resolve({ server: s, code: null }));
  });
}
const closeServer = (s: Server | null) => new Promise<void>((r) => (s ? s.close(() => r()) : r()));

beforeAll(async () => {
  h = await createHarness({ noProject: true });
  server = await startServer({ backend: remoteBackendOf(h), dataDir: h.dataDir, port: 0, allowTestSession: true, logger: memoryLogger(), version: 'test' });
  const reply = await adminRequest({ dataDir: h.dataDir, command: 'session.test' });
  if (!reply.ok) throw new Error('시험용 세션을 받지 못했습니다');
  token = (reply.result as { token: string }).token;
}, 120_000);

afterAll(async () => {
  await server?.close();
  await h?.close();
  for (const d of dirs) await removeDir(d);
});

describe('같은 포트의 두 루프백 (S2-14)', () => {
  it('서버가 뜨면 같은 포트의 127.0.0.1과 ::1을 남이 잡을 수 없고, localhost로 보낸 요청은 이 서버만 받는다', async (ctx) => {
    if (!(await hasV6())) ctx.skip('이 PC에는 IPv6 루프백(::1)이 없다 — 그때 서버는 127.0.0.1만 열고 localhost도 127.0.0.1로만 간다');
    expect(server.addresses).toEqual(['127.0.0.1', '::1']);
    const v6 = await tryListen('::1', server.port);
    const v4 = await tryListen('127.0.0.1', server.port);
    await closeServer(v6.server);
    await closeServer(v4.server);
    expect({ v6: v6.code, v4: v4.code }).toEqual({ v6: 'EADDRINUSE', v4: 'EADDRINUSE' });
    // localhost가 어느 주소로 먼저 가든 (이 PC에서는 ::1이 먼저일 수 있다) 이 서버가 답한다 — 이 서버만 아는 토큰으로 확인
    const order = (await lookup('localhost', { all: true })).map((a) => a.address);
    expect(order.length).toBeGreaterThan(0);
    for (const host of ['localhost', '[::1]', '127.0.0.1']) {
      const r = await fetch(`http://${host}:${server.port}/api/invoke`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: '1', method: 'auth.getState', args: [] }),
      });
      expect(r.status, host).toBe(200);
    }
    const st = await adminRequest({ dataDir: h.dataDir, command: 'status' });
    expect((st as { result: AdminStatus }).result.addresses).toEqual(['127.0.0.1', '::1']);
  });

  it('같은 포트의 ::1을 다른 프로그램이 먼저 잡고 있으면 시작하지 않는다 — 127.0.0.1도 놓고, 관리 토큰을 쓰지 않는다', async (ctx) => {
    if (!(await hasV6())) ctx.skip('이 PC에는 IPv6 루프백(::1)이 없다');
    // ::1에서 빈 포트를 받아 그 번호를 남이 잡은 채로 둔다
    const squat = await tryListen('::1', 0);
    const port = (squat.server!.address() as { port: number }).port;
    const dir = mkdtempSync(join(tmpdir(), 'wook-test-loopback-squat-'));
    dirs.push(dir);
    try {
      const err = await startServer({ backend: remoteBackendOf(h), dataDir: dir, port, allowTestSession: false, logger: memoryLogger(), version: 'test' }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ServerStartError);
      expect((err as Error).message).toBe(
        `포트 ${port}의 IPv6 루프백 자리([::1]:${port})를 이미 다른 프로그램이 쓰고 있습니다 — localhost로 온 요청이 그쪽으로 갈 수 있어 시작하지 않습니다. --port로 다른 포트를 고르세요`,
      );
      expect(existsSync(adminTokenPath(dir))).toBe(false);
      // 127.0.0.1의 같은 포트는 놓았다
      const v4 = await tryListen('127.0.0.1', port);
      expect(v4.code).toBeNull();
      await closeServer(v4.server);
    } finally {
      await closeServer(squat.server);
    }
  });

  it('--bind localhost·::1도 두 루프백을 모두 잡는다 — 주소는 고른 이름으로 보인다', async (ctx) => {
    if (!(await hasV6())) ctx.skip('이 PC에는 IPv6 루프백(::1)이 없다');
    for (const bind of ['localhost', '::1']) {
      const dir = mkdtempSync(join(tmpdir(), 'wook-test-loopback-bind-'));
      dirs.push(dir);
      const s = await startServer({ backend: remoteBackendOf(h), dataDir: dir, bind, port: 0, allowTestSession: false, logger: memoryLogger(), version: 'test' });
      try {
        expect(s.addresses, bind).toEqual(['127.0.0.1', '::1']);
        expect(s.url).toBe(bind === '::1' ? `http://[::1]:${s.port}` : `http://localhost:${s.port}`);
        for (const host of ['127.0.0.1', '::1']) expect((await tryListen(host, s.port)).code, `${bind} ${host}`).toBe('EADDRINUSE');
      } finally {
        await s.close();
      }
    }
  });
});

describe('listenLoopback', () => {
  /** n번째(1부터)로 만든 서버의 listen이 code로 실패하게 한다 */
  function maker(fail: (n: number) => string | null): { make: () => Server; made: () => number; servers: Server[] } {
    let made = 0;
    const servers: Server[] = [];
    return {
      made: () => made,
      servers,
      make: () => {
        made += 1;
        const s = createServer();
        servers.push(s);
        const code = fail(made);
        if (code) {
          s.listen = ((..._args: unknown[]) => {
            process.nextTick(() => s.emit('error', Object.assign(new Error(`시험: ${code}`), { code })));
            return s;
          }) as unknown as Server['listen'];
        }
        return s;
      },
    };
  }
  const closeAll = async (servers: Server[]) => {
    for (const s of servers) if (s.listening) await closeServer(s);
  };

  it('빈 포트를 고를 때 ::1의 같은 번호가 이미 쓰이면 새 번호로 다시 한다', async () => {
    const m = maker((n) => (n === 2 ? 'EADDRINUSE' : null));
    const r = await listenLoopback({ make: m.make, port: 0, logger: memoryLogger() });
    try {
      expect({ made: m.made(), v6: r.v6, servers: r.servers.length }).toEqual({ made: 4, v6: true, servers: 2 });
      expect(r.servers.every((s) => s.listening)).toBe(true);
      // 처음 잡은 127.0.0.1은 놓았다
      expect(m.servers[0]!.listening).toBe(false);
    } finally {
      await closeAll(m.servers);
    }
  });

  it('정한 포트에서 ::1이 이미 쓰이면 다시 하지 않고 시작하지 않는다', async () => {
    const m = maker((n) => (n === 2 ? 'EADDRINUSE' : null));
    const free = await tryListen('127.0.0.1', 0);
    const port = (free.server!.address() as { port: number }).port;
    await closeServer(free.server);
    const err = await listenLoopback({ make: m.make, port, logger: memoryLogger() }).catch((e: unknown) => e);
    await closeAll(m.servers);
    expect(err).toBeInstanceOf(ServerStartError);
    expect(m.made()).toBe(2);
    expect(m.servers.some((s) => s.listening)).toBe(false);
  });

  it('이 PC에 IPv6 루프백이 없으면(EADDRNOTAVAIL·EAFNOSUPPORT) 127.0.0.1만 열고 한 번 기록한다', async () => {
    for (const code of ['EADDRNOTAVAIL', 'EAFNOSUPPORT']) {
      const m = maker((n) => (n % 2 === 0 ? code : null));
      const log = memoryLogger();
      const r = await listenLoopback({ make: m.make, port: 0, logger: log });
      try {
        expect({ v6: r.v6, servers: r.servers.length, made: m.made() }, code).toEqual({ v6: false, servers: 1, made: 2 });
        expect(log.lines).toEqual([`[INFO] 이 PC에는 IPv6 루프백(::1)이 없어 127.0.0.1에서만 받습니다 — localhost도 127.0.0.1로만 갑니다 (${code})`]);
      } finally {
        await closeAll(m.servers);
      }
    }
  });

  it('::1의 다른 오류는 시작하지 않는다', async () => {
    const m = maker((n) => (n === 2 ? 'EACCES' : null));
    const err = await listenLoopback({ make: m.make, port: 0, logger: memoryLogger() }).catch((e: unknown) => e);
    await closeAll(m.servers);
    expect(err).toBeInstanceOf(ServerStartError);
    expect((err as Error).message).toMatch(/^HTTP를 열지 못했습니다 \(\[::1\]:\d+\): EACCES$/);
  });
});
