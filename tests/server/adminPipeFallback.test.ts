/**
 * adminPipeFallback (리드 결정 S9-7·S9-11, Q7): 서버 도우미를 쓸 수 없으면 관리 채널은 Node 파이프로 물러난다 — 시작은 막지 않는다.
 * 까닭(csc 없음·컴파일 실패, 해시가 다름, FAIL INIT, 10초(시험은 0.3초) 안에 READY 없음 — 리드 결정 S9-19, 판이 다름, 약속 밖 줄)마다: 운영자 명령은 닿고, status의 adminPipe가
 * {mode:'node', rejectsRemote:false, userOnlyAcl:false, reason}을 말하고, 서버 기록에 경고 한 줄('관리 채널이 다른 기기(SMB)의 연결을 거부하지 못합니다
 * (<까닭>) — Tailscale 쪽 TCP 445를 막아 두세요'), 운영자 활동 기록 한 줄이 남는다. 띄운 가짜는 남지 않는다.
 * 빌드한 서버(Windows): 실행 파일 자리에 해시만 맞춘 실행할 수 없는 파일을 두면 띄우지 못해 물러난다 — wook-server status --json, server.log, 활동 기록.
 * check 글(SMB 항목)은 deployCheck.test가 본다 (S9b)
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { formatToolHashFile, toolSourceHash } from '../../src/main/process/compiledTool';
import { openStore } from '../../src/main/db/store';
import { dataPaths } from '../../src/main/orchestrator/paths';
import { adminRequest, readAdminEndpoint } from '../../src/server/admin';
import { ADMIN_PIPE_READY_MS, adminPipeFallbackWarning, type AdminPipeInfo } from '../../src/server/adminPipe';
import { POWER_ACK_MS, POWER_READY_MS } from '../../src/server/power';
import { startServer, type AdminStatus, type RunningServer } from '../../src/server/server';
import { SERVER_HELPER_TOOL } from '../../src/server/serverHelper';
import { createHarness } from '../e2e/harness';
import { fakeServerLauncher, type FakeServerLauncherOptions } from '../fixtures/serverhelper/fakeServer';
import { pidAlive } from '../setup/runTemp';
import { buildServerTo, clientJson, fakeServerBackend, memoryLogger, removeDir, runClient, startBuilt, testBuildDir, type BuiltServer } from './helpers';

const GENEROUS = 60_000;
const dirs: string[] = [];
const servers: RunningServer[] = [];
const closers: (() => void)[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const c of closers.splice(0)) c();
});
afterAll(async () => {
  for (const d of dirs) await removeDir(d);
});

const tempDir = (tag: string): string => {
  const d = mkdtempSync(join(tmpdir(), `wook-test-pipefb-${tag}-`));
  dirs.push(d);
  return d;
};

const fallbackNote = (reason: string): string => `관리 채널을 서버 도우미 없이 Node 파이프로 열었습니다 — 다른 기기(SMB)의 연결을 거부하지 못합니다 (${reason})`;

/** 가짜 백엔드로 연 서버 — 운영자 활동 기록(note)을 모은다 */
async function boot(fakeOpts: Omit<FakeServerLauncherOptions, 'dir'>, readyTimeoutMs = GENEROUS, askStatus = true) {
  const dir = tempDir('boot');
  const fake = fakeServerLauncher({ dir, ...fakeOpts });
  const fb = fakeServerBackend();
  closers.push(fb.close);
  const notes: string[] = [];
  const backend = { ...fb.backend, operator: { ...fb.backend.operator, note: (t: string) => void notes.push(t) } };
  const log = memoryLogger();
  const server = await startServer({ backend, dataDir: dir, port: 0, allowTestSession: false, logger: log, version: 'test', adminTransport: { helper: fake, readyTimeoutMs } });
  servers.push(server);
  const status = askStatus ? await adminRequest({ dataDir: dir, command: 'status' }) : null;
  if (status && !status.ok) throw new Error('status 실패');
  return { dir, fake, notes, log, server, status: (status?.ok ? status.result : {}) as AdminStatus };
}

const NODE = (reason: string): AdminPipeInfo => ({ mode: 'node', rejectsRemote: false, userOnlyAcl: false, reason });

describe('서버 도우미를 쓸 수 없으면 Node 파이프로 물러난다 (프로세스 안, 가짜 도우미)', () => {
  const cases: { name: string; opts: Omit<FakeServerLauncherOptions, 'dir'>; reason: string | RegExp; readyMs?: number; launched: number }[] = [
    { name: 'csc 없음(준비 실패)', opts: { prepareFails: 'C# 컴파일러(csc.exe, .NET Framework 4.x)를 찾을 수 없습니다' }, reason: 'C# 컴파일러(csc.exe, .NET Framework 4.x)를 찾을 수 없습니다', launched: 0 },
    { name: '해시가 다름(띄우기 거부)', opts: { refuse: '서버 도우미 파일(WookServerHelper.exe)이 준비할 때와 다릅니다 — 해시 다름' }, reason: '서버 도우미 파일(WookServerHelper.exe)이 준비할 때와 다릅니다 — 해시 다름', launched: 0 },
    { name: 'FAIL INIT', opts: { scenario: 'fail-init' }, reason: '서버 도우미가 파이프를 만들지 못했습니다 (fake)', launched: 1 },
    // 오지 않을 READY를 기다리는 창은 짧게 둔다 (리드 결정 S9-18)
    { name: 'READY 없음', opts: { scenario: 'no-ready' }, reason: '0.3초 안에 READY가 오지 않았습니다', readyMs: 300, launched: 1 },
    { name: '판이 다름', opts: { scenario: 'bad-version' }, reason: /^서버 도우미의 첫 줄을 알 수 없습니다 \(판이 다를 수 있습니다: READY 9 pipe\)$/, launched: 1 },
  ];
  for (const c of cases) {
    it(`${c.name}: 시작은 되고 운영자 명령이 닿는다 — status·경고 한 줄·활동 기록 한 줄이 까닭을 말하고, 띄운 가짜는 남지 않는다`, async () => {
      const b = await boot(c.opts, c.readyMs);
      const info = b.status.adminPipe!;
      if (typeof c.reason === 'string') expect(info).toEqual(NODE(c.reason));
      else expect(info).toMatchObject({ mode: 'node', rejectsRemote: false, userOnlyAcl: false, reason: expect.stringMatching(c.reason) });
      expect(readAdminEndpoint(b.dir)).toBe(b.server.adminEndpoint);
      expect(b.log.lines.filter((l) => l.startsWith('[WARN]') && l.includes('관리 채널이 다른 기기(SMB)'))).toEqual([`[WARN] ${adminPipeFallbackWarning(info.reason!)}`]);
      expect(b.notes).toEqual([fallbackNote(info.reason!)]);
      expect(b.log.text()).toContain(`관리 채널 ${b.server.adminEndpoint} (Node 파이프)`);
      expect(b.fake.launches('pipe')).toBe(c.launched);
      expect(b.fake.pids('pipe').filter(pidAlive)).toEqual([]);
    }, 120_000);
  }

  it('제품의 기다리는 창은 넉넉하다 — 관리 채널 READY 10초, 절전 방지 READY 10초·OK 5초 (리드 결정 S9-19 — 느린 시작 하나가 그 실행 내내 SMB로 닿는 파이프를 남기지 않게)', () => {
    expect([ADMIN_PIPE_READY_MS, POWER_READY_MS, POWER_ACK_MS]).toEqual([10_000, 10_000, 5_000]);
  });

  it('약속 밖 줄(READY 뒤): 도우미를 버리고 물러난다', async () => {
    const b = await boot({ scenario: 'garbage' }, GENEROUS, false);
    expect(b.server.adminEndpoint).toBe(readAdminEndpoint(b.dir));
    // 첫 연결이 약속 밖 줄을 부른다 — 그 연결은 버려지고(닫힘) 운영자 명령은 물러난 Node 파이프로 다시 닿는다
    const first = await adminRequest({ dataDir: b.dir, command: 'status' }).catch((e: unknown) => e);
    expect(first).toMatchObject({ code: 'closed' });
    const deadline = Date.now() + GENEROUS;
    let info: AdminPipeInfo | undefined;
    for (;;) {
      const r = await adminRequest({ dataDir: b.dir, command: 'status' }).catch(() => null);
      info = r?.ok ? (r.result as AdminStatus).adminPipe : undefined;
      if (info?.mode === 'node' || Date.now() > deadline) break;
      await new Promise((r2) => setTimeout(r2, 50));
    }
    expect(info).toEqual(NODE('서버 도우미가 약속에 없는 줄을 보냈습니다 (HELLO)'));
    expect(b.notes).toEqual([fallbackNote(info!.reason!)]);
    expect(b.fake.pids('pipe').filter(pidAlive)).toEqual([]);
  }, 120_000);

  it('도우미를 쓰는 서버의 status는 helper·원격 거부·지금 사용자만을 말한다 (활동 기록·경고 없음)', async () => {
    const b = await boot({});
    expect(b.status.adminPipe).toEqual({ mode: 'helper', rejectsRemote: true, userOnlyAcl: true, reason: null });
    expect(b.notes).toEqual([]);
    expect(b.log.lines.filter((l) => l.startsWith('[WARN]'))).toEqual([]);
    expect(b.log.text()).toContain(`관리 채널 ${b.server.adminEndpoint} (서버 도우미)`);
  }, 120_000);

  it('도우미 없이 연 프로세스 안 서버(기본)는 Node 파이프 그대로 — status가 그렇다고 말한다', async () => {
    const dir = tempDir('plain');
    const fb = fakeServerBackend();
    closers.push(fb.close);
    const server = await startServer({ backend: fb.backend, dataDir: dir, port: 0, allowTestSession: false, logger: memoryLogger(), version: 'test' });
    servers.push(server);
    const r = await adminRequest({ dataDir: dir, command: 'status' });
    const info = (r as { result: AdminStatus }).result.adminPipe;
    if (process.platform === 'win32') expect(info).toEqual(NODE('서버 도우미 없이 Node 파이프로 열었습니다'));
    else expect(info).toEqual({ mode: 'socket', rejectsRemote: true, userOnlyAcl: true, reason: null });
    expect((r as { result: AdminStatus }).result.power).toBeUndefined();
  }, 120_000);
});

describe.runIf(process.platform === 'win32')('빌드한 서버 — 서버 도우미를 띄우지 못하면 물러난다 (Windows)', () => {
  let buildDir = '';
  let entry = '';
  let srv: BuiltServer | null = null;

  afterAll(async () => {
    if (srv && srv.child.exitCode === null && srv.child.signalCode === null) {
      runClient(entry, ['shutdown', '--data-dir', srv.dataDir]);
      await Promise.race([srv.exited, new Promise((r) => setTimeout(r, 40_000))]);
      // 시험이 띄운 서버만, 쥔 핸들로
      if (srv.child.exitCode === null && srv.child.signalCode === null) srv.child.kill();
    }
    if (buildDir) await removeDir(buildDir);
  });

  it('해시만 맞춘 실행할 수 없는 파일: status --json·server.log·활동 기록이 까닭을 말하고, 운영자 명령은 닿으며, 메인 턴은 모두 모의다', async () => {
    buildDir = testBuildDir('pipefb');
    entry = buildServerTo(buildDir);
    // 모의 메인으로 데이터 폴더를 준비한다 — 빌드한 서버가 이 PC의 실제 Claude·Codex CLI 턴을 띄우지 않게 (리드 결정 S6-19)
    const h = await createHarness({ noProject: true });
    const dataDir = h.dataDir;
    dirs.push(dataDir, join(h.projectDir, '..'));
    await h.close({ keepDirs: true });
    // 원본 해시는 맞고 실행 파일 해시도 맞지만 실행할 수 없는 바이트 — 서버는 csc 없이 재사용하고 띄우다 실패한다
    const bin = join(dataDir, 'bin');
    mkdirSync(bin, { recursive: true });
    const junk = Buffer.from('not a program — S9a fallback test\n');
    writeFileSync(join(bin, SERVER_HELPER_TOOL.exeName), junk);
    const source = readFileSync(resolve('resources', 'serverhelper', 'ServerHelper.cs'));
    const exeHash = (await import('node:crypto')).createHash('sha256').update(junk).digest('hex');
    writeFileSync(join(bin, SERVER_HELPER_TOOL.hashName), formatToolHashFile(toolSourceHash(SERVER_HELPER_TOOL, source), exeHash));
    srv = await startBuilt({ entry, dataDir });
    const { code, reply } = clientJson(entry, ['status', '--data-dir', dataDir]);
    expect(code).toBe(0);
    const info = (reply.result as AdminStatus).adminPipe!;
    expect(info).toMatchObject({ mode: 'node', rejectsRemote: false, userOnlyAcl: false });
    expect(info.reason).toMatch(/^서버 도우미를 띄우지 못했습니다 \(/);
    const log = readFileSync(join(dataDir, 'logs', 'server.log'), 'utf8');
    expect(log).toContain(adminPipeFallbackWarning(info.reason!));
    expect(log.split('\n').filter((l) => l.includes('관리 채널이 다른 기기(SMB)의 연결을 거부하지 못합니다'))).toHaveLength(1);
    const down = runClient(entry, ['shutdown', '--data-dir', dataDir]);
    expect([down.code, down.stdout.trim()]).toEqual([0, '서버를 종료했습니다.']);
    expect((await srv.exited).code).toBe(0);
    const store = openStore(dataPaths(dataDir).db);
    try {
      expect(store.activity.search({ limit: 200 }).filter((e) => e.actor === 'operator' && e.text === fallbackNote(info.reason!))).toHaveLength(1);
      expect(store.turns.list({ ref1: 'M-MAIN' }).filter((t) => !t.mock)).toEqual([]);
    } finally {
      store.close();
    }
  }, 240_000);
});
