/**
 * 관리 채널 자리를 남이 먼저 차지하지 못한다 (SERVER_DESIGN 3.2, S2-4·S2-5·S2-20 — 리뷰 security-surface N4의 프로브 zz-s2f1sec-n4-pipesquat을 옮김).
 * 이름 있는 파이프는 아무 계정이나 새 이름으로 만들 수 있다. 예전 이름(사용자 + 데이터 폴더 해시)은 누구나 계산할 수 있어, 다른 계정이 먼저 만들면 서버가
 * 'EADDRINUSE'로만 시작하지 못했고, 비정상 종료 뒤에는 운영자 명령이 남은 admin.token을 그쪽에 보내고 꾸민 답을 믿었다.
 * - Windows 파이프 이름에는 시작마다 새 난수가 들어간다. 서버는 연 자리를 그 사용자만 읽는 admin.endpoint에 적고, 운영자 명령은 계산하지 않고 그 파일을 읽는다
 * - 남이 계산할 수 있는 이름을 먼저 차지해도 서버는 뜨고, 운영자 명령은 그쪽에 아무것도 보내지 않는다(비정상 종료 뒤에도)
 * - 자리를 남이 이미 쓰면 그렇다고 말하며 시작하지 않는다
 * - 시작하며 새 토큰을 쓰는 순간에도 운영자 명령이 새 토큰을 죽은 서버가 남긴 자리로 보내지 않는다 — 남은 자리 파일을 토큰보다 먼저 지운다
 * 차지하는 쪽은 같은 계정의 듣는 쪽으로 흉내 낸다(다른 OS 계정은 이 PC에 없다 — 이름 있는 파이프의 '아무 계정이나 새 이름' 규칙에 기댄다)
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  adminEndpoint,
  adminEndpointPath,
  adminRequest,
  adminTokenPath,
  AdminClientError,
  readAdminEndpoint,
} from '../../src/server/admin';
import { ServerStartError, startServer, type RunningServer } from '../../src/server/server';
import { fakeServerBackend, memoryLogger, removeDir, windowsAcl, windowsMe } from './helpers';

// 시작 중 새 관리 토큰을 쓴 바로 그 순간에 할 일 (마지막 시험) — 그 밖에는 실제 writeAdminToken 그대로다
const seam = vi.hoisted(() => ({ afterTokenWrite: null as null | (() => void) }));
vi.mock('../../src/server/admin', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/server/admin')>();
  return {
    ...real,
    writeAdminToken: (...args: Parameters<typeof real.writeAdminToken>) => {
      const token = real.writeAdminToken(...args);
      seam.afterTokenWrite?.();
      return token;
    },
  };
});

const isWin = process.platform === 'win32';
const WIN_ONLY = 'Windows 이름 있는 파이프 시험 — POSIX의 admin.sock은 그 사용자만 여는 데이터 폴더 안이라 다른 계정이 먼저 만들 수 없다';
const dirs: string[] = [];
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  seam.afterTokenWrite = null;
  for (const c of closers.splice(0).reverse()) await c();
  for (const d of dirs.splice(0)) await removeDir(d);
});

const tempDir = (tag: string): string => {
  const d = mkdtempSync(join(tmpdir(), `wook-test-admin-endpoint-${tag}-`));
  dirs.push(d);
  return d;
};

async function start(dataDir: string, extra: { adminEndpoint?: string } = {}): Promise<RunningServer> {
  const fake = fakeServerBackend();
  closers.push(async () => fake.close());
  const s = await startServer({ backend: fake.backend, dataDir, port: 0, allowTestSession: true, logger: memoryLogger(), version: 'test', ...extra });
  closers.push(() => s.close());
  return s;
}

/** 남이 차지한 자리 흉내: 받은 요청 줄을 모으고 꾸민 성공 답을 준다 (프로브의 work/squatter.cjs). 모은 줄은 출력하지 않는다 — 토큰이 들어 있다 */
async function squat(endpoint: string): Promise<{ received(): number }> {
  const lines: string[] = [];
  const server = createServer((s) => {
    let buf = '';
    s.setEncoding('utf8');
    s.on('error', () => undefined);
    s.on('data', (c: string) => {
      buf += c;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      lines.push(buf.slice(0, nl));
      s.end(`${JSON.stringify({ ok: true, result: { forged: true } })}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(endpoint, () => resolve());
  });
  closers.push(() => new Promise<void>((r) => server.close(() => r())));
  return { received: () => lines.length };
}

describe('관리 채널 자리 (S2-20)', () => {
  it('Windows 파이프 이름은 시작마다 새 난수가 들어가 누구나 계산할 수 있는 이름이 아니다 — 서버가 연 자리는 admin.endpoint에 적힌다', async (ctx) => {
    if (!isWin) ctx.skip(WIN_ONLY);
    const dir = tempDir('random');
    const fixed = adminEndpoint(dir);
    const names: string[] = [];
    for (let i = 0; i < 2; i++) {
      const s = await start(dir);
      expect(readAdminEndpoint(dir)).toBe(s.adminEndpoint);
      names.push(s.adminEndpoint);
      await s.close();
      expect(existsSync(adminEndpointPath(dir)), '닫으면 자리 파일을 지운다').toBe(false);
    }
    for (const n of names) {
      expect(n).not.toBe(fixed);
      expect(n).toMatch(/^\\\\\.\\pipe\\wook-admin-[A-Za-z0-9._-]+-[0-9a-f]{32}-[0-9a-f]{8}$/);
      // 데이터 폴더 해시는 그대로 붙는다 — 같은 PC의 서버를 이름으로도 가릴 수 있게
      expect(n.slice(-8)).toBe(fixed.slice(-8));
    }
    expect(names[0]).not.toBe(names[1]);
  });

  it('자리 파일은 관리 토큰처럼 그 사용자만 읽는다 (Windows 상속 끊고 지금 사용자만, POSIX 0600) — POSIX는 admin.sock 그대로', async () => {
    const dir = tempDir('acl');
    const s = await start(dir);
    const file = adminEndpointPath(dir);
    expect(readFileSync(file, 'utf8')).toBe(s.adminEndpoint);
    if (isWin) {
      const acl = windowsAcl(file);
      expect(acl.protected).toBe(true);
      expect(acl.rules.map((r) => [r.id, r.inherited, r.rights, r.type])).toEqual([[windowsMe(), false, 'FullControl', 'Allow']]);
    } else {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(s.adminEndpoint).toBe(join(dir, 'admin.sock'));
    }
  });

  it('남이 계산할 수 있는 이름을 먼저 차지해도 서버는 뜨고, 운영자 명령은 서버에 닿는다 — 차지한 쪽은 아무것도 받지 않는다', async (ctx) => {
    if (!isWin) ctx.skip(WIN_ONLY);
    const dir = tempDir('squat');
    const sq = await squat(adminEndpoint(dir));
    const s = await start(dir);
    const r = await adminRequest({ dataDir: dir, command: 'status' });
    expect(r.ok).toBe(true);
    expect((r as { result: { runId: string } }).result.runId).toBe(s.runId);
    expect(sq.received(), '차지한 쪽이 받은 요청 수').toBe(0);
  });

  it('비정상 종료가 남긴 admin.token·admin.endpoint가 있어도 운영자 명령은 남이 차지한 이름으로 토큰을 보내지 않고 꾸민 답을 믿지 않는다', async (ctx) => {
    if (!isWin) ctx.skip(WIN_ONLY);
    const dir = tempDir('crash');
    const s = await start(dir);
    const leftToken = readFileSync(adminTokenPath(dir), 'utf8');
    const leftEndpoint = readFileSync(adminEndpointPath(dir), 'utf8');
    await s.close();
    // 강제 종료·전원 끊김이면 두 파일이 남는다
    writeFileSync(adminTokenPath(dir), leftToken);
    writeFileSync(adminEndpointPath(dir), leftEndpoint);
    const sq = await squat(adminEndpoint(dir));
    const err = await adminRequest({ dataDir: dir, command: 'session.test', timeoutMs: 5000 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdminClientError);
    expect((err as AdminClientError).code).toBe('not_running');
    expect(sq.received(), '차지한 쪽이 받은 요청 수').toBe(0);
  });

  it('자리를 남이 이미 쓰면 그렇다고 말하며 시작하지 않는다 — 관리 토큰·자리 파일을 남기지 않는다', async (ctx) => {
    if (!isWin) ctx.skip(`${WIN_ONLY}. POSIX 서버는 실행 잠금을 잡은 뒤 남은 소켓 파일을 지우고 연다`);
    const dir = tempDir('inuse');
    const taken = `\\\\.\\pipe\\wook-admin-test-${randomBytes(8).toString('hex')}-00000000`;
    await squat(taken);
    const err = await start(dir, { adminEndpoint: taken }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServerStartError);
    expect((err as Error).message).toBe(`관리 채널 파이프 이름(${taken})을 이미 다른 프로그램이 쓰고 있습니다 — 다시 시작하면 새 이름을 고릅니다`);
    expect(existsSync(adminTokenPath(dir))).toBe(false);
    expect(existsSync(adminEndpointPath(dir))).toBe(false);
  });

  it('자리 파일이 없거나 모양이 틀리면 운영자 명령은 아무 데도 연결하지 않는다', async () => {
    const dir = tempDir('missing');
    writeFileSync(adminTokenPath(dir), 'x'.repeat(43));
    const missing = await adminRequest({ dataDir: dir, command: 'status' }).catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(AdminClientError);
    expect((missing as AdminClientError).message).toBe(`이 데이터 폴더(${dir})로 실행 중인 욱채 서버가 없습니다 (admin.endpoint 없음)`);
    for (const bad of ['127.0.0.1:7317', 'relative.sock', '']) {
      writeFileSync(adminEndpointPath(dir), bad);
      const err = await adminRequest({ dataDir: dir, command: 'status' }).catch((e: unknown) => e);
      expect(err, bad).toBeInstanceOf(AdminClientError);
      expect((err as AdminClientError).code, bad).toBe('no_access');
    }
  });

  it('시작하며 새 토큰을 쓰는 순간에 온 운영자 명령도 새 토큰을 죽은 서버가 남긴 자리로 보내지 않는다 — 남은 자리 파일을 토큰보다 먼저 지운다', async () => {
    const dir = tempDir('window');
    // 죽은 서버가 남긴 자리 — 그사이 남이 차지했다
    const old = isWin ? `\\\\.\\pipe\\wook-admin-old-${randomBytes(8).toString('hex')}-00000000` : join(tempDir('old'), 'old.sock');
    const sq = await squat(old);
    writeFileSync(adminTokenPath(dir), 'S'.repeat(43));
    writeFileSync(adminEndpointPath(dir), old);
    const during: { result?: Promise<unknown> } = {};
    // 운영자 명령은 부르는 즉시 그때의 토큰과 자리 파일을 읽는다
    seam.afterTokenWrite = () => {
      during.result ??= adminRequest({ dataDir: dir, command: 'session.test', timeoutMs: 5000 }).catch((e: unknown) => e);
    };
    const s = await start(dir);
    seam.afterTokenWrite = null;
    expect(during.result, '새 토큰을 쓴 순간에 명령을 보냈다').toBeDefined();
    const r = await during.result;
    expect(r).toBeInstanceOf(AdminClientError);
    expect((r as AdminClientError).code).toBe('not_running');
    expect(sq.received(), '남은 자리로 간 요청 수').toBe(0);
    expect(readAdminEndpoint(dir)).toBe(s.adminEndpoint);
  });
});
