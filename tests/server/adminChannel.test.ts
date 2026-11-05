/**
 * 관리 채널 연결 다루기 (SERVER_DESIGN 3.2, S2-4·S2-16):
 * - 연결마다 받은 때부터 요청 줄을 다 받을 때까지 한 번의 시간 상한 — 조금씩 보내도 늘어나지 않는다 (리뷰 security-surface E4의 프로브를 옮김)
 * - 인증 없는 연결·시간 초과·너무 큰 줄의 경고는 창마다 한 줄로 모은다 — 파이프를 여는 쪽(같은 PC, Windows는 SMB로 다른 기기도)이 기록을 채우지 못하게
 * - 자리(Windows 파이프 이름)는 데이터 폴더의 실제 경로로 정한다 — 접합(junction)처럼 같은 폴더의 다른 이름으로도 같은 서버에 닿는다
 *   (리뷰 lifecycle-guarantees의 zz-lc-artifact 'data dir alias'를 옮김. 빌드한 운영자 명령으로 보는 시험은 dataGuards.test)
 */
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { adminEndpoint, adminRequest, startAdminChannel, type AdminChannel } from '../../src/server/admin';
import { memoryLogger, removeDir, sleep } from './helpers';

const isWin = process.platform === 'win32';
let channel: AdminChannel | null = null;
const dirs: string[] = [];
afterEach(async () => {
  await channel?.close();
  channel = null;
  for (const d of dirs.splice(0)) await removeDir(d);
});

const tempDir = (tag: string): string => {
  const d = mkdtempSync(join(tmpdir(), `wook-test-admin-${tag}-`));
  dirs.push(d);
  return d;
};

function counter() {
  let ran = 0;
  const handlers = {
    status: async () => (ran++, { pong: true }),
    stop: async () => (ran++, {}),
    shutdown: async () => (ran++, {}),
    'session.test': async () => (ran++, {}),
  };
  return { handlers, ran: () => ran };
}

/** 줄 하나를 보내고 닫힐 때까지 */
function sendLine(endpoint: string, line: string): Promise<void> {
  return new Promise((resolve) => {
    const socket = connect(endpoint);
    socket.on('connect', () => socket.write(line));
    socket.on('data', () => undefined);
    socket.on('error', () => resolve());
    socket.on('close', () => resolve());
  });
}

describe('요청 시간 상한 (S2-16)', () => {
  it('요청 줄을 상한 안에 다 보내지 않으면 끊는다 — 조금씩 보내도 상한이 늘어나지 않는다', async () => {
    const dir = tempDir('deadline');
    const c = counter();
    const log = memoryLogger();
    channel = await startAdminChannel({ dataDir: dir, token: 'test-token', handlers: c.handlers, logger: log, requestTimeoutMs: 500 });
    const socket = connect(channel.endpoint);
    let closedAt: number | null = null;
    const t0 = Date.now();
    socket.on('error', () => undefined);
    socket.on('close', () => (closedAt = Date.now() - t0));
    await new Promise<void>((r) => socket.once('connect', () => r()));
    // 200ms마다 한 바이트 — 쉬는 시간은 상한보다 짧다. 2.5초(상한의 5배) 동안
    while (Date.now() - t0 < 2500 && closedAt === null) {
      socket.write('x');
      await sleep(200);
    }
    socket.destroy();
    expect(c.ran()).toBe(0);
    expect(closedAt !== null && closedAt < 1500, `closedAt=${closedAt}`).toBe(true);
    expect(log.text()).toContain('[WARN] 관리 채널: 요청이 시간 안에 오지 않아 연결을 끊었습니다');
  });

  it('상한 안에 온 요청은 처리한다 — 처리(긴급 정지 등)가 상한보다 오래 걸려도 끊지 않는다', async () => {
    const dir = tempDir('ok');
    const c = counter();
    const handlers = { ...c.handlers, status: async () => (await sleep(800), c.handlers.status()) };
    channel = await startAdminChannel({ dataDir: dir, token: 'test-token', handlers, logger: memoryLogger(), requestTimeoutMs: 300 });
    expect(await adminRequest({ dataDir: dir, command: 'status', token: 'test-token' })).toEqual({ ok: true, result: { pong: true } });
    expect(c.ran()).toBe(1);
  });
});

describe('인증 없는 연결 경고는 모은다 (S2-16)', () => {
  it('창 안의 같은 경고는 첫 줄 하나, 나머지는 창이 끝날 때 수만 한 줄 — 닫을 때 남은 수도 쓴다', async () => {
    const dir = tempDir('warn');
    const c = counter();
    const log = memoryLogger();
    channel = await startAdminChannel({ dataDir: dir, token: 'test-token', handlers: c.handlers, logger: log, requestTimeoutMs: 150, warnWindowMs: 2000 });
    const bad = `${JSON.stringify({ token: 'wrong', command: 'stop' })}\n`;
    for (let i = 0; i < 5; i++) await sendLine(channel.endpoint, bad);
    // 시간 초과도 따로 모은다 — 아무것도 보내지 않는 연결 셋
    await Promise.all([0, 1, 2].map(() => sendLine(channel!.endpoint, '')));
    const warns = () => log.lines.filter((l) => l.startsWith('[WARN]'));
    expect(warns()).toEqual(['[WARN] 관리 채널: 관리 토큰이 없거나 맞지 않아 연결을 끊었습니다 (명령 stop)', '[WARN] 관리 채널: 요청이 시간 안에 오지 않아 연결을 끊었습니다']);
    // 두 창이 끝날 때까지 (창은 각 종류의 첫 경고부터 2초)
    const until = Date.now() + 8_000;
    while (warns().length < 4 && Date.now() < until) await sleep(50);
    expect(warns().slice(2).sort()).toEqual(
      ['[WARN] 관리 채널: 관리 토큰이 없거나 맞지 않아 끊은 연결이 지난 2초 동안 4번 더 있었습니다', '[WARN] 관리 채널: 요청이 시간 안에 오지 않아 끊은 연결이 지난 2초 동안 2번 더 있었습니다'].sort(),
    );
    // 계속 오면 다음 창도 수만 — 닫을 때 남은 수를 쓴다
    await sendLine(channel.endpoint, bad);
    expect(warns()).toHaveLength(4);
    await channel.close();
    channel = null;
    expect(warns().slice(4)).toEqual(['[WARN] 관리 채널: 관리 토큰이 없거나 맞지 않아 끊은 연결이 지난 2초 동안 1번 더 있었습니다']);
    expect(c.ran()).toBe(0);
  });

  it('기본 창은 1분이다', async () => {
    const { ADMIN_WARN_WINDOW_MS } = await import('../../src/server/admin');
    expect(ADMIN_WARN_WINDOW_MS).toBe(60_000);
  });
});

describe('같은 폴더의 다른 이름 (S2-16)', () => {
  it('데이터 폴더를 접합(심볼릭 링크)으로 적어도 같은 관리 채널에 닿는다', async () => {
    const dir = tempDir('alias-target');
    const parent = tempDir('alias-parent');
    const alias = join(parent, '다른 이름');
    // Windows 접합은 관리자 권한 없이 만든다
    symlinkSync(dir, alias, isWin ? 'junction' : 'dir');
    if (isWin) expect(adminEndpoint(alias)).toBe(adminEndpoint(dir));
    const c = counter();
    channel = await startAdminChannel({ dataDir: dir, token: 'test-token', handlers: c.handlers, logger: memoryLogger() });
    writeFileSync(join(dir, 'admin.token'), 'test-token');
    expect(await adminRequest({ dataDir: alias, command: 'status' })).toEqual({ ok: true, result: { pong: true } });
    expect(c.ran()).toBe(1);
  });

  it('아직 없는 폴더는 적은 경로 그대로 해시한다 (대소문자만 다른 이름은 같은 자리)', () => {
    const missing = join(tmpdir(), `wook-test-없는-${process.pid}`, 'Data');
    expect(adminEndpoint(missing, 'win32', 'u')).toBe(adminEndpoint(missing.toLowerCase(), 'win32', 'u'));
  });
});
