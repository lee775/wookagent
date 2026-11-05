/**
 * 관리 채널을 서로 증명한 뒤에만 쓴다 (SERVER_DESIGN 3.2, 리드 결정 S3-16):
 * - 운영자 명령은 관리 토큰 원문을 보내지 않는다. 난수를 보내고 → 서버가 두 난수 위의 HMAC(토큰)으로 먼저 증명하고 → 그 증명을 확인한 뒤에야 제 증명과
 *   명령(과 표준 입력으로 받은 비밀 값)을 보낸다
 * - 운영자 명령은 붙기 전에 server.lock이 살아 있는 서버 프로세스를 가리키는지 본다 — 비정상 종료한 서버의 파이프 이름을 차지한 쪽(squatter)은
 *   아무것도 받지 못하고, 붙어도 난수 말고는 받지 못하며 답을 꾸미지 못한다 (자리 파일이 가리키는 이름에 가짜 서버를 띄워 본다)
 * - 서버는 증명이 틀린 연결(틀린 토큰·지난 연결의 증명 다시 쓰기·옛 {token, command} 줄)에 아무것도 하지 않는다
 * 토큰·비밀 값은 시험 출력에 내지 않는다 — 참거짓으로만 본다
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ADMIN_BAD_SERVER,
  ADMIN_PROTOCOL,
  ADMIN_UNAUTHORIZED,
  adminEndpointPath,
  adminProof,
  adminRequest,
  adminTokenPath,
  AdminClientError,
  newAdminEndpoint,
  operatorRequest,
  startAdminChannel,
  type AdminChannel,
  type AdminRequestBody,
} from '../../src/server/admin';
import { lockFilePath } from '../../src/main/backend/instanceLock';
import { processLiveness } from '../../src/main/process/processRunner';
import { readSecretInput, runCli, SECRET_USAGE } from '../../src/server/cli';
import { adminHandshake, memoryLogger, removeDir } from './helpers';

const TOKEN = 'T'.repeat(43);
const SECRET = 'GOCSPX-admin-auth-secret-7f3a';
const dirs: string[] = [];
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
  for (const d of dirs.splice(0)) await removeDir(d);
});

const tempDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'wook-test-admin-auth-'));
  dirs.push(d);
  return d;
};

/** 이 시험 프로세스를 가리키는 실행 잠금 (살아 있는 서버 흉내) */
async function lockSelf(dir: string, kind: 'server' | 'desktop' = 'server'): Promise<void> {
  const createdAt = (await processLiveness.processCreatedAt([process.pid])).get(process.pid) ?? null;
  writeFileSync(lockFilePath(dir), JSON.stringify({ pid: process.pid, createdAt, kind, startedAt: new Date().toISOString() }));
}

/** 이미 끝난 프로세스의 pid */
function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8', windowsHide: true });
  return Number(r.stdout);
}

/** 처리기를 부른 기록을 남기는 진짜 관리 채널 */
async function realChannel(dir: string): Promise<{ channel: AdminChannel; calls: { command: string; req: AdminRequestBody }[] }> {
  const calls: { command: string; req: AdminRequestBody }[] = [];
  const h = (command: string) => async (req: AdminRequestBody) => (calls.push({ command, req }), { done: command });
  const channel = await startAdminChannel({
    dataDir: dir,
    token: TOKEN,
    handlers: { status: h('status'), stop: h('stop'), shutdown: h('shutdown'), 'session.test': h('session.test'), 'secret.set': h('secret.set') },
    logger: memoryLogger(),
  });
  writeFileSync(adminTokenPath(dir), TOKEN);
  closers.push(() => channel.close());
  return { channel, calls };
}

/**
 * 관리 채널 자리에 띄운 가짜 서버 — 받은 바이트를 모은다. honest: 관리 토큰을 알고 약속대로 증명하는 쪽(운영자 명령이 무엇을 보내는지 보려고),
 * 아니면 토큰을 모르는 쪽(squatter — 꾸민 증명이나 꾸민 성공 답을 준다)
 */
async function fakeServer(endpoint: string, mode: 'honest' | 'forged-proof' | 'forged-reply' | { replay: { nonce: string; proof: string } }): Promise<{ bytes(): string; connections(): number }> {
  let bytes = '';
  let connections = 0;
  const server: Server = createServer((s) => {
    connections++;
    let buf = '';
    let stage = 0;
    s.setEncoding('utf8');
    s.on('error', () => undefined);
    s.on('data', (c: string) => {
      bytes += c;
      buf += c;
      while (buf.includes('\n')) {
        const line = buf.slice(0, buf.indexOf('\n'));
        buf = buf.slice(buf.indexOf('\n') + 1);
        if (stage === 0) {
          stage = 1;
          const hello = JSON.parse(line) as { nonce: string };
          const nonce = 'S'.repeat(43);
          if (mode === 'honest') s.write(`${JSON.stringify({ nonce, proof: adminProof(TOKEN, 'server', hello.nonce, nonce) })}\n`);
          else if (mode === 'forged-proof') s.write(`${JSON.stringify({ nonce, proof: adminProof('squatter-guess', 'server', hello.nonce, nonce) })}\n`);
          else if (mode === 'forged-reply') s.end(`${JSON.stringify({ ok: true, result: { forged: true } })}\n`);
          else s.write(`${JSON.stringify(mode.replay)}\n`);
        } else {
          s.end(`${JSON.stringify({ ok: true, result: { done: true } })}\n`);
        }
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(endpoint, () => resolve());
  });
  closers.push(() => new Promise<void>((r) => server.close(() => r())));
  return { bytes: () => bytes, connections: () => connections };
}

/** 운영자 명령을 프로세스 안에서 돌린다 (표준 입력의 비밀 값을 넣어 준다) */
async function cli(argv: string[], secret = SECRET): Promise<{ code: number | null; out: string; err: string }> {
  let out = '';
  let err = '';
  const code = await runCli(argv, {
    out: async (t) => void (out += t),
    err: async (t) => void (err += t),
    exit: () => undefined,
    readSecret: async () => secret,
  });
  return { code, out, err };
}

describe('운영자 명령은 토큰 원문을 보내지 않는다 (S3-16)', () => {
  it('서버의 증명을 확인한 뒤에야 증명·명령·비밀 값을 보낸다 — 오간 바이트 어디에도 관리 토큰이 없다', async () => {
    const dir = tempDir();
    await lockSelf(dir);
    writeFileSync(adminTokenPath(dir), TOKEN);
    const endpoint = newAdminEndpoint(dir);
    writeFileSync(adminEndpointPath(dir), endpoint);
    const honest = await fakeServer(endpoint, 'honest');
    const r = await cli(['secret', 'set', 'google-client-secret', '--data-dir', dir]);
    expect(r.code).toBe(0);
    const lines = honest.bytes().trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.map((l) => Object.keys(l).sort())).toEqual([
      ['hello', 'nonce'],
      ['args', 'command', 'proof', 'secret'],
    ]);
    expect([lines[0]!['hello'], lines[1]!['command'], lines[1]!['args']]).toEqual([ADMIN_PROTOCOL, 'secret.set', ['google-client-secret']]);
    expect(lines[1]!['secret'] === SECRET).toBe(true);
    expect(honest.bytes().includes(TOKEN)).toBe(false);
  });

  it('진짜 관리 채널: 맞게 증명하면 처리기가 명령·낱말·비밀 값을 받는다', async () => {
    const dir = tempDir();
    const { calls } = await realChannel(dir);
    expect(await adminRequest({ dataDir: dir, command: 'secret.set', args: ['google-client-secret'], secret: SECRET })).toEqual({ ok: true, result: { done: 'secret.set' } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe('secret.set');
    expect(calls[0]!.req.args).toEqual(['google-client-secret']);
    expect(calls[0]!.req.secret === SECRET).toBe(true);
  });
});

describe('서버를 흉내 낸 쪽에는 아무것도 보내지 않는다 (S3-16 회귀 — 자리 파일이 가리키는 이름의 가짜 파이프 서버)', () => {
  for (const mode of ['forged-proof', 'forged-reply'] as const) {
    it(`${mode === 'forged-proof' ? '틀린 증명' : '증명 없이 꾸민 성공 답'}: 운영자 명령은 거부하고 난수 한 줄 말고는 보내지 않는다 — 토큰도 비밀 값도`, async () => {
      const dir = tempDir();
      await lockSelf(dir);
      writeFileSync(adminTokenPath(dir), TOKEN);
      const endpoint = newAdminEndpoint(dir);
      writeFileSync(adminEndpointPath(dir), endpoint);
      const squatter = await fakeServer(endpoint, mode);
      const r = await cli(['secret', 'set', 'google-client-secret', '--data-dir', dir]);
      expect([r.code, r.err]).toEqual([1, `${ADMIN_BAD_SERVER}\n`]);
      const got = squatter.bytes();
      expect(got.trim().split('\n')).toHaveLength(1);
      expect(Object.keys(JSON.parse(got.trim()) as object).sort()).toEqual(['hello', 'nonce']);
      expect({ token: got.includes(TOKEN), secret: got.includes(SECRET), command: got.includes('secret.set') }).toEqual({ token: false, secret: false, command: false });
    });
  }

  it('예전 연결에서 엿본 서버의 증명을 다시 내밀어도 받지 않는다 — 운영자 명령의 난수가 연결마다 새롭다', async () => {
    const dir = tempDir();
    const { channel } = await realChannel(dir);
    const seen = await adminHandshake(channel.endpoint, { proofToken: 'x', command: 'status' });
    expect(seen.challenge).not.toBeNull();
    const squatDir = tempDir();
    await lockSelf(squatDir);
    writeFileSync(adminTokenPath(squatDir), TOKEN);
    const endpoint = newAdminEndpoint(squatDir);
    writeFileSync(adminEndpointPath(squatDir), endpoint);
    const squatter = await fakeServer(endpoint, { replay: { nonce: seen.challenge!.nonce, proof: seen.challenge!.proof } });
    const err = await operatorRequest({ dataDir: squatDir, command: 'status' }).catch((e: unknown) => e);
    expect((err as AdminClientError).code).toBe('bad_server');
    expect(squatter.bytes().trim().split('\n')).toHaveLength(1);
  });

  it('엿본 운영자 난수로 진짜 서버에서 받아 둔 증명도 쓸모없다 — 운영자 명령의 난수가 연결마다 새롭다', async () => {
    const dir = tempDir();
    const { channel } = await realChannel(dir);
    const squatDir = tempDir();
    await lockSelf(squatDir);
    writeFileSync(adminTokenPath(squatDir), TOKEN);
    const endpoint = newAdminEndpoint(squatDir);
    writeFileSync(adminEndpointPath(squatDir), endpoint);
    // 1) 차지한 쪽이 운영자 명령의 난수를 엿본다
    const first = await fakeServer(endpoint, 'forged-reply');
    expect(((await operatorRequest({ dataDir: squatDir, command: 'status' }).catch((e: unknown) => e)) as AdminClientError).code).toBe('bad_server');
    const seenNonce = (JSON.parse(first.bytes().trim()) as { nonce: string }).nonce;
    await closers.pop()!();
    // 2) 그 난수로 진짜 서버의 증명을 받아 둔다
    const proof = await adminHandshake(channel.endpoint, { proofToken: 'x', command: 'status', clientNonce: seenNonce });
    // 3) 다음 연결에 그 증명을 내민다 — 운영자 명령의 난수가 달라 맞지 않는다
    const second = await fakeServer(endpoint, { replay: { nonce: proof.challenge!.nonce, proof: proof.challenge!.proof } });
    const err = await operatorRequest({ dataDir: squatDir, command: 'secret.set', args: ['google-client-secret'], secret: SECRET }).catch((e: unknown) => e);
    expect((err as AdminClientError).code).toBe('bad_server');
    expect(second.bytes().trim().split('\n')).toHaveLength(1);
    expect(second.bytes().includes(SECRET)).toBe(false);
  });

  it('server.lock이 끝난 프로세스를 가리키면(비정상 종료) 붙지도 않는다 — 가짜 서버는 연결 하나 받지 못한다', async () => {
    const dir = tempDir();
    writeFileSync(lockFilePath(dir), JSON.stringify({ pid: deadPid(), createdAt: Date.now() - 60_000, kind: 'server', startedAt: new Date(Date.now() - 60_000).toISOString() }));
    writeFileSync(adminTokenPath(dir), TOKEN);
    const endpoint = newAdminEndpoint(dir);
    writeFileSync(adminEndpointPath(dir), endpoint);
    const squatter = await fakeServer(endpoint, 'honest');
    const r = await cli(['status', '--data-dir', dir]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/^이 데이터 폴더\(.+\)로 실행 중인 욱채 서버가 없습니다 \(server\.lock의 서버 pid \d+는 끝났습니다\)\n$/);
    expect(squatter.connections()).toBe(0);
  });

  it('server.lock이 없거나 데스크톱 앱이면 붙지 않는다', async () => {
    const dir = tempDir();
    writeFileSync(adminTokenPath(dir), TOKEN);
    const endpoint = newAdminEndpoint(dir);
    writeFileSync(adminEndpointPath(dir), endpoint);
    const squatter = await fakeServer(endpoint, 'honest');
    const none = await operatorRequest({ dataDir: dir, command: 'status' }).catch((e: unknown) => e);
    expect([(none as AdminClientError).code, (none as AdminClientError).message]).toEqual(['not_running', `이 데이터 폴더(${dir})로 실행 중인 욱채 서버가 없습니다 (server.lock 없음)`]);
    await lockSelf(dir, 'desktop');
    const desktop = await operatorRequest({ dataDir: dir, command: 'status' }).catch((e: unknown) => e);
    expect([(desktop as AdminClientError).code, (desktop as AdminClientError).message]).toEqual(['not_running', `이 데이터 폴더는 데스크톱 앱(pid ${process.pid})이 쓰고 있습니다 — 운영자 명령은 욱채 서버에만 씁니다`]);
    expect(squatter.connections()).toBe(0);
  });
});

describe('서버는 증명하지 못한 연결에 아무것도 하지 않는다 (S3-16)', () => {
  it('틀린 토큰의 증명, 증명 없음, 지난 연결의 증명 다시 쓰기, 옛 {token, command} 줄 — 모두 unauthorized이고 처리기를 부르지 않는다', async () => {
    const dir = tempDir();
    const { channel, calls } = await realChannel(dir);
    const wrong = await adminHandshake(channel.endpoint, { proofToken: 'W'.repeat(43), command: 'stop' });
    expect(wrong.reply).toEqual({ ok: false, error: ADMIN_UNAUTHORIZED });
    const missing = await adminHandshake(channel.endpoint, { proofToken: TOKEN, command: 'stop', line2: () => JSON.stringify({ command: 'stop' }) });
    expect(missing.reply).toEqual({ ok: false, error: ADMIN_UNAUTHORIZED });
    // 맞는 연결의 둘째 줄을 엿봤다가 새 연결에 그대로 다시 보낸다 — 서버 난수가 달라 맞지 않는다
    let captured = '';
    const ok = await adminHandshake(channel.endpoint, {
      proofToken: TOKEN,
      command: 'status',
      line2: (c) => (captured = JSON.stringify({ proof: adminProof(TOKEN, 'client', c.clientNonce, c.nonce), command: 'stop' })),
    });
    expect(ok.reply).toEqual({ ok: true, result: { done: 'stop' } });
    const replay = await adminHandshake(channel.endpoint, { proofToken: TOKEN, command: 'stop', line2: () => captured });
    expect(replay.reply).toEqual({ ok: false, error: ADMIN_UNAUTHORIZED });
    // 엿본 연결의 운영자 난수까지 그대로 되풀이해도 서버 난수가 새로워 맞지 않는다
    const sameNonce = await adminHandshake(channel.endpoint, { proofToken: TOKEN, command: 'stop', clientNonce: ok.challenge!.clientNonce, line2: () => captured });
    expect(sameNonce.challenge!.nonce === ok.challenge!.nonce).toBe(false);
    expect(sameNonce.reply).toEqual({ ok: false, error: ADMIN_UNAUTHORIZED });
    // 서버의 증명을 운영자 쪽 증명으로 되돌려 써도 받지 않는다 (쪽 이름이 다르다)
    const reflected = await adminHandshake(channel.endpoint, { proofToken: TOKEN, command: 'stop', line2: (c) => JSON.stringify({ proof: c.proof, command: 'stop' }) });
    expect(reflected.reply).toEqual({ ok: false, error: ADMIN_UNAUTHORIZED });
    expect(calls.map((c) => c.command)).toEqual(['stop']);
  });

  it('맞게 증명해도 낱말 모양이 틀리면 처리하지 않는다', async () => {
    const dir = tempDir();
    const { channel, calls } = await realChannel(dir);
    for (const [args, secret] of [
      ['google-client-secret', undefined],
      [[1], undefined],
      [Array.from({ length: 9 }, () => 'x'), undefined],
      [['google-client-secret'], 42],
    ] as const) {
      const r = await adminHandshake(channel.endpoint, { proofToken: TOKEN, command: 'secret.set', args, secret });
      expect(r.reply).toMatchObject({ ok: false, error: { code: 'invalid_args' } });
    }
    expect(calls).toEqual([]);
  });
});

describe('표준 입력의 비밀 값 (S3-8)', () => {
  it('파이프로 넘긴 값은 끝까지 읽고 끝의 줄바꿈만 뗀다', async () => {
    const input = new PassThrough() as unknown as NodeJS.ReadStream;
    (input as unknown as PassThrough).end(`${SECRET}\r\n`);
    expect((await readSecretInput(input, async () => undefined)) === SECRET).toBe(true);
  });

  it('터미널이면 묻는 글을 내고 화면에 보이지 않게(raw) 한 줄을 받는다 — 지우기 글자를 따르고, Ctrl+C면 그만둔다', async () => {
    const tty = () => {
      const s = new PassThrough({ encoding: 'utf8' });
      const raw: boolean[] = [];
      Object.assign(s, { isTTY: true, setRawMode: (on: boolean) => void raw.push(on) });
      return { input: s as unknown as NodeJS.ReadStream, s, raw };
    };
    const prompts: string[] = [];
    const a = tty();
    const typed = readSecretInput(a.input, async (t) => void prompts.push(t));
    a.s.write(`${SECRET}x\u007f`);
    a.s.write('\r남은 글');
    expect((await typed) === SECRET).toBe(true);
    expect(a.raw).toEqual([true, false]);
    expect(prompts[0]).toBe('보안 비밀을 붙여 넣고 Enter를 누르세요 (화면에 보이지 않습니다): ');
    expect(prompts.some((p) => p.includes(SECRET))).toBe(false);
    const b = tty();
    const cancelled = readSecretInput(b.input, async () => undefined);
    b.s.write('abc\u0003');
    await expect(cancelled).rejects.toThrow('보안 비밀 입력을 그만두었습니다');
    expect(b.raw).toEqual([true, false]);
  });

  it('비밀 값은 명령 줄로 받지 않는다 — 값을 붙이면 쓰임새 오류이고, 비어 있으면 서버에 붙지 않는다', async () => {
    const dir = tempDir();
    const extra = await cli(['secret', 'set', 'google-client-secret', SECRET, '--data-dir', dir]);
    expect(extra.code).toBe(2);
    expect(extra.err.startsWith(`${SECRET_USAGE}\n`)).toBe(true);
    // 명령 줄에 붙인 값을 화면(stderr)에 되풀이하지 않는다
    expect(extra.err.includes(SECRET) || extra.out.includes(SECRET)).toBe(false);
    const empty = await cli(['secret', 'set', 'google-client-secret', '--data-dir', dir], '  \n');
    expect([empty.code, empty.err]).toEqual([1, '표준 입력으로 받은 보안 비밀이 비었습니다 — 값을 파이프로 넘기거나 붙여 넣으세요\n']);
  });
});
