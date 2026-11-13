/**
 * adminPipeHelper (리드 결정 S9-7·S9-11): 관리 채널을 서버 도우미가 연다 — 가짜 도우미(tests/fixtures/serverhelper/fakeServerHelper.mjs, 실제 Node 파이프를
 * 열고 바이트를 OPEN·DATA·END로 넘긴다)로 Node 쪽(src/server/adminPipe.ts)을 본다. 처리기·서로 증명은 그대로 admin.ts의 것이다.
 * - 나뉜 줄(도우미 표준 출력의 한 줄이 두 번에, 요청 한 줄이 여러 DATA에)도 그대로 맞춰 읽는다 · 48KiB보다 큰 답은 여러 DATA로 보낸다
 * - 연결 20개: 차례로 20번 모두 답하고(칸을 돌려준다), 함께 20개면 16개까지만 받고 나머지는 KILL
 * - END와 KILL: 답한 연결은 END(다 쓰고 닫기), 시간 초과로 끊는 연결은 KILL
 * - 1 MiB 넘는 줄 → 도우미를 끝내고 Node 파이프로 물러남 · 도중에 끝남 → 새 이름으로 다시 띄우고 admin.endpoint를 다시 씀 · 상한(3번)을 넘으면 물러남 —
 *   상한은 잇단 끝남만 센다(READY 뒤 10분 넘게 돈 도우미의 끝남은 처음부터, 옮긴 시계로 — 리드 결정 S9-22)
 * - FAIL INUSE → '이미 다른 프로그램이 쓰고 있습니다'로 시작하지 않음 · 기록에 증명·난수·토큰·바이트가 없음 · 닫으면 도우미가 남지 않음(CLOSE를 무시해도)
 * 띄운 가짜는 제품이 쥔 ChildProcess로만 끝난다 — 이 시험은 pid로 살았는지 보기만 하고 끝내지 않는다 (리드 결정 S9-18). 가짜는 표준 입력이 끝나면 스스로 끝난다
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ADMIN_PROTOCOL, adminEndpointInUseMessage, adminRequest, newAdminEndpoint, readAdminEndpoint, startAdminChannel, type AdminChannel, type AdminHandlers } from '../../src/server/admin';
import { ADMIN_PIPE_STABLE_MS, adminPipeFallbackWarning, type AdminHelperTransport } from '../../src/server/adminPipe';
import { startServer } from '../../src/server/server';
import { pidAlive } from '../setup/runTemp';
import { fakeServerLauncher, type FakeServerLauncher } from '../fixtures/serverhelper/fakeServer';
import { adminHandshake, fakeServerBackend, memoryLogger, removeDir, sleep } from './helpers';

const TOKEN = 'pipe-helper-test-token';
/** 답이 올 것을 기다리는 창 — 넉넉하게 (느린 PC·늦춘 가짜에서도) */
const GENEROUS = 60_000;
const channels: AdminChannel[] = [];
const dirs: string[] = [];
const sockets: Socket[] = [];

afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy();
  for (const c of channels.splice(0)) await c.close();
  for (const d of dirs.splice(0)) await removeDir(d);
});

const tempDir = (tag: string): string => {
  const d = mkdtempSync(join(tmpdir(), `wook-test-pipehelper-${tag}-`));
  dirs.push(d);
  return d;
};

const PAD = 'x'.repeat(60_000);
const handlers: AdminHandlers = {
  // 60KB 답 — 48KiB씩 나눠 DATA 둘로 간다
  status: async () => ({ pad: PAD }),
  stop: async () => ({}),
  shutdown: async () => ({}),
  'session.test': async () => ({ small: true }),
};

async function open(o: { dir: string; fake: FakeServerLauncher; transport?: Partial<AdminHelperTransport>; requestTimeoutMs?: number; notes?: string[]; log?: ReturnType<typeof memoryLogger> }): Promise<{ channel: AdminChannel; log: ReturnType<typeof memoryLogger>; notes: string[] }> {
  const log = o.log ?? memoryLogger();
  const notes = o.notes ?? [];
  const channel = await startAdminChannel({
    dataDir: o.dir,
    token: TOKEN,
    handlers,
    logger: log,
    requestTimeoutMs: o.requestTimeoutMs ?? GENEROUS,
    transport: { helper: o.fake, readyTimeoutMs: GENEROUS, ...o.transport },
    notify: (t) => notes.push(t),
  });
  channels.push(channel);
  return { channel, log, notes };
}

async function waitFor(pred: () => boolean, label: string, ms = GENEROUS): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`기다리다 시간이 지났습니다: ${label}`);
    await sleep(25);
  }
}

/** 인사만 보내고 서버의 증명 줄을 기다린다 — 연결은 열어 둔다. 증명을 받으면 'proof', 받기 전에 끊기면 'closed' */
function holdHello(endpoint: string): Promise<'proof' | 'closed'> {
  return new Promise((resolve) => {
    const s = connect(endpoint);
    sockets.push(s);
    let text = '';
    s.setEncoding('utf8');
    s.on('connect', () => s.write(`${JSON.stringify({ hello: ADMIN_PROTOCOL, nonce: randomBytes(32).toString('base64url') })}\n`));
    s.on('data', (d: string) => {
      text += d;
      if (/"proof"/.test(text)) resolve('proof');
    });
    s.on('error', () => undefined);
    s.on('close', () => resolve(/"proof"/.test(text) ? 'proof' : 'closed'));
  });
}

const cmds = (fake: FakeServerLauncher, verb: string): string[] => fake.log().filter((l) => l.startsWith(`cmd ${verb} `)).map((l) => l.split(' ')[2]!);

describe('서버 도우미 관리 채널 — 가짜 도우미 (리드 결정 S9-7)', () => {
  it('나뉜 줄과 나뉜 DATA를 맞춰 읽고, 60KB 답은 여러 DATA로 보낸 뒤 END로 닫는다 — 자리 파일은 READY 뒤의 이름, 상태는 helper', async () => {
    const dir = tempDir('split');
    const fake = fakeServerLauncher({ dir, scenario: 'split' });
    const { channel } = await open({ dir, fake });
    expect(channel.info()).toEqual({ mode: 'helper', rejectsRemote: true, userOnlyAcl: true, reason: null });
    expect(readAdminEndpoint(dir)).toBe(channel.endpoint);
    expect(channel.address()).toBe(channel.endpoint);
    expect(await adminRequest({ dataDir: dir, command: 'status', token: TOKEN })).toEqual({ ok: true, result: { pad: PAD } });
    expect(await adminRequest({ dataDir: dir, command: 'session.test', token: TOKEN })).toEqual({ ok: true, result: { small: true } });
    // 서버의 답은 DATA 여러 개(60KB > 48KiB)와 END — KILL은 없다
    await waitFor(() => cmds(fake, 'END').length === 2, 'END 둘');
    expect(cmds(fake, 'DATA').filter((id) => id === '1').length).toBeGreaterThanOrEqual(3);
    expect(cmds(fake, 'KILL')).toEqual([]);
    expect(fake.launches('pipe')).toBe(1);
  }, 120_000);

  it('연결 20개: 차례로 20번은 모두 답한다(칸을 돌려준다). 함께 20개면 16개까지만 받고 나머지 4개는 증명 없이 KILL — 그 뒤에도 새 연결은 답을 받는다', async () => {
    const dir = tempDir('twenty');
    const fake = fakeServerLauncher({ dir });
    const { channel, log } = await open({ dir, fake });
    for (let i = 0; i < 20; i++) expect((await adminRequest({ dataDir: dir, command: 'session.test', token: TOKEN })).ok, `차례 ${i}`).toBe(true);
    // 답을 받은 클라이언트가 끊은 뒤 도우미가 END를 알려 칸이 모두 돌아온다 (돌려주지 않으면 여기서 멈춘다)
    await waitFor(() => channel.connections() === 0, '열린 연결 0');
    // 20개를 함께 열고 인사만 한 채 쥔다 — 받은 16개는 증명을 받고(열린 채), 넘친 4개는 증명 없이 닫힌다
    const held = await Promise.all(Array.from({ length: 20 }, () => holdHello(channel.endpoint)));
    expect([held.filter((h) => h === 'proof').length, held.filter((h) => h === 'closed').length]).toEqual([16, 4]);
    expect(cmds(fake, 'KILL')).toHaveLength(4);
    expect(log.text()).toContain('관리 채널: 연결이 16개를 넘어 새 연결을 닫았습니다');
    expect(log.lines.filter((l) => l.includes('연결이 16개를 넘어')).length).toBe(1);
    for (const s of sockets.splice(0)) s.destroy();
    // 끊은 연결의 END가 와야 칸이 돌아온다 — 그 전에 온 새 연결은 상한에 걸려 닫히는 것이 맞다 (그래서 기다린다)
    await waitFor(() => channel.connections() === 0, '열린 연결 0 (끊은 뒤)');
    expect((await adminRequest({ dataDir: dir, command: 'session.test', token: TOKEN })).ok).toBe(true);
  }, 180_000);

  it('END와 KILL: 답한 연결은 END로, 요청 시간 상한에 걸린 연결은 KILL로 닫는다 — 끊긴 클라이언트는 아무것도 받지 않는다', async () => {
    const dir = tempDir('endkill');
    const fake = fakeServerLauncher({ dir });
    // 시간 상한은 일부러 짧다 — 답이 오지 않을 창이다 (리드 결정 S9-18)
    const { channel } = await open({ dir, fake, requestTimeoutMs: 300 });
    const s = connect(channel.endpoint);
    sockets.push(s);
    let got = '';
    let closed = false;
    s.on('data', (d) => (got += d));
    s.on('error', () => undefined);
    s.on('close', () => (closed = true));
    // KILL이 가야 닫힌다 — 이름 붙인 기다림으로 (KILL이 없으면 여기서 그 까닭으로 실패한다)
    await waitFor(() => closed, '시간 초과로 끊은 연결이 KILL로 닫힘', 20_000);
    expect(got).toBe('');
    await waitFor(() => cmds(fake, 'KILL').length === 1, 'KILL 하나');
    expect(cmds(fake, 'END')).toEqual([]);
  }, 120_000);

  it('END: 답한 연결은 END(KILL 아님)로 닫는다', async () => {
    const dir = tempDir('end');
    const fake = fakeServerLauncher({ dir });
    await open({ dir, fake });
    expect((await adminRequest({ dataDir: dir, command: 'session.test', token: TOKEN })).ok).toBe(true);
    await waitFor(() => cmds(fake, 'END').length === 1, 'END 하나');
    expect([cmds(fake, 'END'), cmds(fake, 'KILL')]).toEqual([['1'], []]);
  }, 120_000);

  it.skipIf(process.platform !== 'win32')('1 MiB 넘는 줄: 도우미를 끝내고 새 이름의 Node 파이프로 물러난다 — 상태·경고 한 줄·운영자 활동 기록 한 줄, 운영자 명령은 다시 닿는다 (Windows — 서버 도우미의 파이프 이름은 다시 띄울 때마다 바뀐다. POSIX의 관리 채널은 소켓 한 자리이고 서버 도우미를 쓰지 않는다)', async () => {
    const dir = tempDir('huge');
    const fake = fakeServerLauncher({ dir, scenario: 'huge-line' });
    const { channel, log, notes } = await open({ dir, fake });
    const first = channel.endpoint;
    // 첫 연결이 큰 줄을 부른다
    void holdHello(first);
    await waitFor(() => channel.info().mode === 'node', 'Node 파이프로 물러남');
    const reason = '서버 도우미의 줄이 1 MiB를 넘었습니다';
    expect(channel.info()).toEqual({ mode: 'node', rejectsRemote: false, userOnlyAcl: false, reason });
    expect(channel.endpoint).not.toBe(first);
    expect(readAdminEndpoint(dir)).toBe(channel.endpoint);
    expect(log.lines.filter((l) => l.includes(adminPipeFallbackWarning(reason)))).toHaveLength(1);
    expect(notes).toEqual([`관리 채널을 서버 도우미 없이 Node 파이프로 열었습니다 — 다른 기기(SMB)의 연결을 거부하지 못합니다 (${reason})`]);
    expect(await adminRequest({ dataDir: dir, command: 'session.test', token: TOKEN })).toEqual({ ok: true, result: { small: true } });
    // 버린 도우미는 남지 않았다 (보기만 한다)
    expect(fake.pids('pipe').filter(pidAlive)).toEqual([]);
    expect(fake.launches('pipe')).toBe(1);
  }, 120_000);

  it.skipIf(process.platform !== 'win32')('도중에 끝나면 새 이름으로 다시 띄우고 admin.endpoint를 다시 쓴다 — 운영자 명령은 새 자리로 닿는다 (Windows — 서버 도우미의 파이프 이름은 다시 띄울 때마다 바뀐다. POSIX의 관리 채널은 소켓 한 자리이고 서버 도우미를 쓰지 않는다)', async () => {
    const dir = tempDir('death');
    const dieFile = join(dir, 'die-now');
    const fake = fakeServerLauncher({ dir, scenario: 'die-on-file,ok', dieFile });
    const { channel, log, notes } = await open({ dir, fake });
    const first = channel.endpoint;
    expect((await adminRequest({ dataDir: dir, command: 'session.test', token: TOKEN })).ok).toBe(true);
    writeFileSync(dieFile, 'x');
    await waitFor(() => fake.launches('pipe') === 2 && channel.endpoint !== first && existsSync(join(dir, 'admin.endpoint')) && readAdminEndpoint(dir) === channel.endpoint, '새 이름으로 다시 띄움');
    expect(channel.info()).toEqual({ mode: 'helper', rejectsRemote: true, userOnlyAcl: true, reason: null });
    expect(await adminRequest({ dataDir: dir, command: 'session.test', token: TOKEN })).toEqual({ ok: true, result: { small: true } });
    expect(log.text()).toContain('관리 채널: 서버 도우미가 끝났습니다 (코드 9) — 새 이름으로 다시 띄웁니다 (1/3)');
    expect(notes).toEqual([]);
    expect(fake.pids('pipe').filter(pidAlive)).toHaveLength(1);
  }, 120_000);

  it('다시 띄우기 상한(3번)을 넘으면 Node 파이프로 물러난다 — 모두 4번 띄웠다', async () => {
    const dir = tempDir('cap');
    const fake = fakeServerLauncher({ dir, scenario: 'die-after-ready' });
    const { channel, log, notes } = await open({ dir, fake });
    await waitFor(() => channel.info().mode === 'node', 'Node 파이프로 물러남');
    expect(fake.launches('pipe')).toBe(4);
    const info = channel.info();
    expect(info).toMatchObject({ mode: 'node', rejectsRemote: false, userOnlyAcl: false });
    expect(info.reason).toContain('서버 도우미가 3번 다시 띄운 뒤에도 끝났습니다');
    expect(log.lines.filter((l) => l.includes('새 이름으로 다시 띄웁니다'))).toHaveLength(3);
    expect(log.lines.filter((l) => l.includes(adminPipeFallbackWarning(info.reason!)))).toHaveLength(1);
    expect(notes).toHaveLength(1);
    expect(readAdminEndpoint(dir)).toBe(channel.endpoint);
    expect((await adminRequest({ dataDir: dir, command: 'session.test', token: TOKEN })).ok).toBe(true);
    expect(fake.pids('pipe').filter(pidAlive)).toEqual([]);
  }, 120_000);

  it.skipIf(process.platform !== 'win32')('다시 띄우기 상한은 잇단 끝남만 센다: READY 뒤 10분(옮긴 시계) 넘게 돈 도우미가 끝나면 처음부터 센다 — 곧바로 다시 끝나면 물러난다 (S9-22) (Windows — 서버 도우미의 파이프 이름은 다시 띄울 때마다 바뀐다. POSIX의 관리 채널은 소켓 한 자리이고 서버 도우미를 쓰지 않는다)', async () => {
    let clock = 1_000_000;
    const dir = tempDir('stable');
    const dieFile = join(dir, 'die');
    const fake = fakeServerLauncher({ dir, scenario: 'die-on-file-n', dieFile });
    // 상한 1: 잇단 끝남 하나는 다시 띄우고, 둘이면 물러난다
    const { channel, log, notes } = await open({ dir, fake, transport: { restartCap: 1, now: () => clock } });
    const ask = async (): Promise<boolean> => (await adminRequest({ dataDir: dir, command: 'session.test', token: TOKEN })).ok;
    const published = (): boolean => existsSync(join(dir, 'admin.endpoint')) && readAdminEndpoint(dir) === channel.endpoint;
    expect(await ask()).toBe(true);
    const first = channel.endpoint;
    // 1분 돈 첫 도우미가 끝난다 — 잇단 끝남 1 (1/1), 새 이름으로 다시 띄운다
    clock += 60_000;
    writeFileSync(`${dieFile}-1`, 'x');
    await waitFor(() => fake.launches('pipe') === 2 && channel.endpoint !== first && published(), '둘째 도우미를 새 이름으로');
    expect(await ask()).toBe(true);
    const second = channel.endpoint;
    // 둘째는 10분 넘게 돌고 끝난다 — 처음부터 (1/1), 다시 띄운다 (세기를 이어 가면 여기서 Node 파이프로 물러난다)
    clock += ADMIN_PIPE_STABLE_MS;
    writeFileSync(`${dieFile}-2`, 'x');
    await waitFor(() => (fake.launches('pipe') === 3 && channel.endpoint !== second && published()) || channel.info().mode === 'node', '셋째를 띄우거나 물러남');
    expect(channel.info().mode).toBe('helper');
    expect(await ask()).toBe(true);
    // 셋째가 곧바로 끝난다 — 잇단 끝남 2 > 상한 1 → Node 파이프로 물러난다(더 띄우지 않는다)
    writeFileSync(`${dieFile}-3`, 'x');
    await waitFor(() => channel.info().mode === 'node' || fake.launches('pipe') === 4, '물러나거나 넷째를 띄움');
    expect([fake.launches('pipe'), channel.info().mode]).toEqual([3, 'node']);
    expect(channel.info().reason).toContain('서버 도우미가 1번 다시 띄운 뒤에도 끝났습니다');
    expect(log.lines.filter((l) => l.includes('새 이름으로 다시 띄웁니다')).map((l) => l.slice(-5))).toEqual(['(1/1)', '(1/1)']);
    expect(notes).toHaveLength(1);
    await waitFor(() => published(), '물러난 자리를 알림');
    expect(await ask()).toBe(true);
    expect(fake.pids('pipe').filter(pidAlive)).toEqual([]);
  }, 180_000);

  it.skipIf(process.platform !== 'win32')('10분 창은 단조 시계로 잰다(기본 시계) — 벽시계(Date.now)가 11분 뛰어도 곧바로 다시 끝난 도우미는 잇단 끝남으로 센다 (S9-24) (Windows — 서버 도우미의 파이프 이름은 다시 띄울 때마다 바뀐다. POSIX의 관리 채널은 소켓 한 자리이고 서버 도우미를 쓰지 않는다)', async () => {
    const dir = tempDir('mono');
    const dieFile = join(dir, 'die');
    const fake = fakeServerLauncher({ dir, scenario: 'die-on-file-n', dieFile });
    // 벽시계(Date.now)를 먼저 갈아 끼운다 — 제품이 Date.now를 쥐어 두어도 이것을 쥔다. 처음에는 실제 시각 그대로
    const realNow = Date.now.bind(Date);
    let offset = 0;
    const jump = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
    try {
      // 시계를 넣지 않는다 — 제품의 기본 시계
      const { channel } = await open({ dir, fake, transport: { restartCap: 1 } });
      const first = channel.endpoint;
      writeFileSync(`${dieFile}-1`, 'x');
      await waitFor(() => fake.launches('pipe') === 2 && channel.endpoint !== first && existsSync(join(dir, 'admin.endpoint')) && readAdminEndpoint(dir) === channel.endpoint, '둘째 도우미 (1/1)');
      // 벽시계만 11분 앞으로 — 단조 시계는 그대로다
      offset = 11 * 60_000;
      writeFileSync(`${dieFile}-2`, 'x');
      await waitFor(() => channel.info().mode === 'node' || fake.launches('pipe') === 3, '물러나거나 셋째를 띄움');
      expect([fake.launches('pipe'), channel.info().mode]).toEqual([2, 'node']);
    } finally {
      jump.mockRestore();
    }
  }, 120_000);

  it.skipIf(process.platform !== 'win32')('자리 파일(admin.endpoint)은 READY 뒤에만 쓴다 — READY를 기다리는 동안 없고, READY가 오지 않으면 도우미의 이름은 한 번도 적히지 않는다 (Windows — 서버 도우미의 파이프 이름은 다시 띄울 때마다 바뀐다. POSIX의 관리 채널은 소켓 한 자리이고 서버 도우미를 쓰지 않는다)', async () => {
    const dir = tempDir('beforeready');
    const fake = fakeServerLauncher({ dir, scenario: 'no-ready' });
    const helperName = newAdminEndpoint(dir);
    const endpointFile = join(dir, 'admin.endpoint');
    let settled = false;
    // 오지 않을 READY를 기다리는 창 — 그동안 자리 파일을 본다 (창은 짧게, 리드 결정 S9-18)
    const opening = startAdminChannel({ dataDir: dir, token: TOKEN, handlers, logger: memoryLogger(), endpoint: helperName, transport: { helper: fake, readyTimeoutMs: 1_500 } }).finally(() => (settled = true));
    await waitFor(() => fake.launches('pipe') === 1, '가짜가 떴다');
    const seen: string[] = [];
    while (!settled) {
      if (existsSync(endpointFile)) seen.push(readAdminEndpoint(dir));
      await sleep(20);
    }
    const channel = await opening;
    channels.push(channel);
    expect(seen.filter((s) => s === helperName)).toEqual([]);
    expect(channel.info().mode).toBe('node');
    expect(readAdminEndpoint(dir)).toBe(channel.endpoint);
    expect(channel.endpoint).not.toBe(helperName);
  }, 120_000);

  it('FAIL INUSE: 서버는 이름을 이미 쓴다고 말하고 시작하지 않는다 — 자리 파일이 없고 도우미가 남지 않는다', async () => {
    const dir = tempDir('inuse');
    const fake = fakeServerLauncher({ dir, scenario: 'fail-inuse' });
    const fb = fakeServerBackend();
    const endpoint = newAdminEndpoint(dir);
    try {
      await expect(
        startServer({ backend: fb.backend, dataDir: dir, port: 0, allowTestSession: false, logger: memoryLogger(), version: 'test', adminEndpoint: endpoint, adminTransport: { helper: fake, readyTimeoutMs: GENEROUS } }),
      ).rejects.toThrow(adminEndpointInUseMessage(endpoint));
    } finally {
      fb.close();
    }
    expect(existsSync(join(dir, 'admin.endpoint'))).toBe(false);
    expect(existsSync(join(dir, 'admin.token'))).toBe(false);
    await waitFor(() => fake.pids('pipe').filter(pidAlive).length === 0, '가짜 끝남');
  }, 120_000);

  it('기록에는 증명·난수·토큰·연결의 바이트가 없다', async () => {
    const dir = tempDir('nolog');
    const fake = fakeServerLauncher({ dir, scenario: 'split' });
    const { channel, log } = await open({ dir, fake });
    const clientNonce = randomBytes(32).toString('base64url');
    const r = await adminHandshake(channel.endpoint, { proofToken: TOKEN, command: 'session.test', clientNonce });
    expect(r.reply).toEqual({ ok: true, result: { small: true } });
    const c = r.challenge!;
    const text = log.text();
    for (const secret of [TOKEN, clientNonce, c.nonce, c.proof, Buffer.from(clientNonce).toString('base64'), Buffer.from(c.proof).toString('base64'), 'small']) {
      expect(text.includes(secret), '기록에 비밀·바이트가 있다').toBe(false);
    }
  }, 120_000);

  it('닫으면 도우미가 남지 않는다 — CLOSE에 스스로 끝나면 그대로, CLOSE를 무시하면 상한 뒤 끝낸다(쥔 핸들로)', async () => {
    for (const scenario of ['ok', 'ignore-close']) {
      const dir = tempDir(scenario);
      const fake = fakeServerLauncher({ dir, scenario });
      // 스스로 끝나는 쪽('ok')의 기다림은 넉넉하게 — 느린 PC에서 끝내 버리지 않게. 끝내야 끝나는 쪽만 짧다 (리드 결정 S9-22 TI-2)
      const { channel } = await open({ dir, fake, transport: { closeGraceMs: scenario === 'ok' ? GENEROUS : 300 } });
      expect((await adminRequest({ dataDir: dir, command: 'session.test', token: TOKEN })).ok).toBe(true);
      const pids = fake.pids('pipe');
      expect(pids).toHaveLength(1);
      await channel.close();
      // close()는 도우미가 끝난 것을 확인한 뒤에 돌아온다
      expect(pids.filter(pidAlive), scenario).toEqual([]);
      expect(existsSync(join(dir, 'admin.endpoint'))).toBe(false);
      // 스스로 끝났으면 가짜가 끝 줄을 남겼다, 무시했으면 끝내졌다
      expect(fake.log().some((l) => l.startsWith('exit ')), scenario).toBe(scenario === 'ok');
    }
  }, 120_000);
});
