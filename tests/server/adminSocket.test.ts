/**
 * 관리 채널 (SERVER_DESIGN 3.2, S2-4, S2-11 adminSocket): 하네스 백엔드를 감싼 서버를 프로세스 안에서 연다.
 * - TCP가 아니다(이름 있는 파이프·유닉스 소켓), 관리 토큰 파일은 그 사용자만. 운영자 명령은 서버가 적은 자리 파일(admin.endpoint)로 찾는다 (S2-20)
 * - 토큰이 없거나 틀리면(서로 증명하지 못하면, S3-16) 아무것도 하지 않고 끊고, 토큰 값 없이 기록한다. 비정상 종료가 남긴 admin.token은 시작 때 새 토큰으로 바뀐다 (S2-4·S2-20)
 * - stop은 대표의 긴급 정지와 같은 결과(행위자만 operator), session test는 --allow-test-session 없이 거부, shutdown은 응답 뒤 종료 흐름을 부른다
 * - 다른 OS 사용자는 붙지 못한다 (할 수 있는 환경에서만)
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OPERATOR, OWNER } from '@shared/domain';
import type { EmergencySummary } from '@shared/views';
import { createHarness, sendCommand, type Harness } from '../e2e/harness';
import { ADMIN_UNAUTHORIZED, adminEndpoint, adminEndpointPath, adminRequest, adminTokenPath, AdminClientError, readAdminEndpoint, type AdminReply } from '../../src/server/admin';
import { startServer, type AdminStatus, type RunningServer } from '../../src/server/server';
import { adminHandshake, invokeHttp, memoryLogger, remoteBackendOf, removeDir, sleep } from './helpers';

const isWin = process.platform === 'win32';

/** 관리 채널에 줄 하나를 보내고 응답 줄(없으면 null)과 연결이 닫혔는지 */
function rawAdmin(endpoint: string, line: string | Buffer): Promise<{ reply: AdminReply | null; closed: boolean }> {
  return new Promise((resolve) => {
    const socket = connect(endpoint);
    let text = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(line));
    socket.on('data', (c: string) => (text += c));
    socket.on('error', () => undefined);
    socket.on('close', () => {
      const first = text.split('\n')[0] ?? '';
      let reply: AdminReply | null = null;
      try {
        reply = first ? (JSON.parse(first) as AdminReply) : null;
      } catch {
        reply = null;
      }
      resolve({ reply, closed: true });
    });
  });
}

describe('자리와 토큰 파일', () => {
  let h: Harness;
  let server: RunningServer;
  const log = memoryLogger();

  beforeAll(async () => {
    h = await createHarness({ noProject: true });
    server = await startServer({ backend: remoteBackendOf(h), dataDir: h.dataDir, port: 0, allowTestSession: false, logger: log, version: 'test' });
  }, 120_000);
  afterAll(async () => {
    await server?.close();
    await h?.close();
  });

  it('관리 채널은 TCP 포트가 아니다 — Windows는 이름 있는 파이프, 그 밖은 데이터 폴더의 소켓 파일', () => {
    const address = server.adminAddress();
    expect(typeof address).toBe('string');
    // 운영자 명령이 찾는 자리는 서버가 적은 자리 파일이다 — 계산하지 않는다 (S2-20)
    expect(server.adminEndpoint).toBe(readAdminEndpoint(h.dataDir));
    if (isWin) {
      expect(server.adminEndpoint).toMatch(/^\\\\\.\\pipe\\wook-admin-[A-Za-z0-9._-]+-[0-9a-f]{8}$/);
    } else {
      expect(server.adminEndpoint).toBe(join(h.dataDir, 'admin.sock'));
      const st = statSync(server.adminEndpoint);
      expect(st.isSocket()).toBe(true);
      expect(st.mode & 0o777).toBe(0o600);
    }
  });

  it('자리는 데이터 폴더마다 다르다 (Windows는 경로 대소문자를 가리지 않는다)', () => {
    expect(adminEndpoint('C:\\a\\data', 'win32', 'u')).not.toBe(adminEndpoint('C:\\a\\data2', 'win32', 'u'));
    if (isWin) expect(adminEndpoint('C:\\A\\Data', 'win32', 'u')).toBe(adminEndpoint('c:\\a\\data', 'win32', 'u'));
    expect(adminEndpoint('/srv/a', 'linux')).toBe(join(resolve('/srv/a'), 'admin.sock'));
    expect(adminEndpoint('C:\\a', 'win32', '사용자 이름')).toMatch(/^\\\\\.\\pipe\\wook-admin-[A-Za-z0-9._-]+-[0-9a-f]{8}$/);
  });

  it('관리 토큰 파일은 32바이트 난수이고 그 사용자만 읽는다 (POSIX 0600, Windows 상속 끊고 지금 사용자만)', () => {
    const file = adminTokenPath(h.dataDir);
    const token = readFileSync(file, 'utf8');
    expect(/^[A-Za-z0-9_-]{43}$/.test(token)).toBe(true);
    if (!isWin) {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      return;
    }
    const script =
      "[Console]::OutputEncoding = [Text.Encoding]::UTF8; $a = Get-Acl -LiteralPath $env:WOOK_ACL_PATH; " +
      "[pscustomobject]@{ protected = $a.AreAccessRulesProtected; rules = @($a.Access | ForEach-Object { [pscustomobject]@{ id = $_.IdentityReference.Value; inherited = $_.IsInherited; rights = $_.FileSystemRights.ToString(); type = $_.AccessControlType.ToString() } }) } | ConvertTo-Json -Depth 4 -Compress";
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, env: { ...process.env, WOOK_ACL_PATH: file } });
    const acl = JSON.parse(out) as { protected: boolean; rules: { id: string; inherited: boolean; rights: string; type: string }[] };
    const me = `${process.env['USERDOMAIN']}\\${process.env['USERNAME']}`.toLowerCase();
    expect(acl.protected).toBe(true);
    expect(acl.rules.map((r) => ({ ...r, id: r.id.toLowerCase() }))).toEqual([{ id: me, inherited: false, rights: 'FullControl', type: 'Allow' }]);
  });

  it('토큰이 없거나 틀리면 아무것도 하지 않고 끊고, 토큰 값 없이 기록한다', async () => {
    const real = readFileSync(adminTokenPath(h.dataDir), 'utf8');
    const wrong = `${real.slice(0, -2)}${real.endsWith('AA') ? 'BB' : 'AA'}`;
    const stopBefore = JSON.stringify(h.core.ctx.stop());
    // 서로 증명하는 첫 줄(난수)이 아닌 것 — 옛 {token, command} 줄(틀린 토큰·토큰 없음·빈 토큰)과 깨진 줄 (S3-16)
    for (const line of [`${JSON.stringify({ token: wrong, command: 'stop' })}\n`, `${JSON.stringify({ command: 'stop' })}\n`, 'not json\n', `${JSON.stringify({ token: '', command: 'shutdown' })}\n`]) {
      const r = await rawAdmin(server.adminEndpoint, line);
      expect(r.closed).toBe(true);
      expect(r.reply).toEqual({ ok: false, error: ADMIN_UNAUTHORIZED });
    }
    // 약속대로 붙어도 틀린 토큰으로 만든 증명이면 같다 (S3-16)
    expect((await adminHandshake(server.adminEndpoint, { proofToken: wrong, command: 'stop' })).reply).toEqual({ ok: false, error: ADMIN_UNAUTHORIZED });
    // 긴급 정지가 걸리지 않았다
    expect(JSON.stringify(h.core.ctx.stop())).toBe(stopBefore);
    expect(h.core.ctx.stop().global.active).toBe(false);
    const text = log.text();
    expect(text).toContain('관리 채널: 관리 토큰이 없거나 맞지 않아 연결을 끊었습니다 (명령 stop)');
    expect(text.includes(wrong)).toBe(false);
    expect(text.includes(real)).toBe(false);
  });

  it('맞는 토큰이라도 모르는 명령은 거부하고, 너무 큰 줄은 끊는다', async () => {
    const real = readFileSync(adminTokenPath(h.dataDir), 'utf8');
    // 맞는 토큰으로 서로 증명한 뒤의 모르는 명령 (S3-16). agent.add는 7단계에서 생긴 명령이라(리드 결정 S7-2) 없는 명령(키 회전 — 범위 밖, S7-1)으로 본다
    const unknown = await adminHandshake(server.adminEndpoint, { proofToken: real, command: 'agent.rotate' });
    expect(unknown.reply).toMatchObject({ ok: false, error: { code: 'unknown_command' } });
    const big = await rawAdmin(server.adminEndpoint, Buffer.alloc(70 * 1024, 0x61));
    expect(big.reply).toMatchObject({ ok: false, error: { code: 'too_large' } });
  });

  it('--allow-test-session 없이 띄운 서버는 session test를 거부하고, /api/*는 어떤 토큰이든 401', async () => {
    const r = await adminRequest({ dataDir: h.dataDir, command: 'session.test' });
    expect(r).toEqual({ ok: false, error: { code: 'forbidden', message: '이 서버는 --allow-test-session 없이 시작해서 운영자 시험 세션을 발급하지 않습니다' } });
    expect(h.core.ctx.store.activity.search({ limit: 200 }).some((e) => e.text.startsWith('운영자 시험 세션 발급'))).toBe(false);
    expect(h.core.deviceSessions.list()).toEqual([]);
    for (const t of [`wos_${'A'.repeat(43)}`, `wos_test_${'A'.repeat(43)}`, 'x']) expect((await invokeHttp(server.url, t, 'auth.getState')).status).toBe(401);
  });

  it('status는 pid·주소·데이터 폴더·실행 ID·작업·긴급 정지·비밀 값 저장소·버전·시험용 세션을 준다', async () => {
    const r = await adminRequest({ dataDir: h.dataDir, command: 'status' });
    expect(r.ok).toBe(true);
    const s = (r as { result: AdminStatus }).result;
    expect(s).toMatchObject({
      pid: process.pid,
      bind: '127.0.0.1',
      port: server.port,
      url: server.url,
      dataDir: h.dataDir,
      runId: server.runId,
      activeWork: false,
      version: 'test',
      testSessions: { allowed: false, active: 0 },
      emergencyStop: { active: false, since: null },
      secretStore: { backend: 'memory', fallbackReason: null },
    });
    expect(s.uptimeSec).toBeGreaterThanOrEqual(0);
  });

  it('다른 OS 사용자는 붙지 못한다', (ctx) => {
    if (isWin) {
      // 위에서 토큰 파일이 지금 사용자만인지 보고, 모든 연결이 토큰을 먼저 보내야 한다
      ctx.skip('Windows: 시험 중에 다른 OS 사용자로 프로세스를 띄울 수 없다(그 사용자의 암호가 필요하다)');
    }
    if (typeof process.getuid !== 'function' || process.getuid() !== 0) {
      // 소켓·토큰 파일이 0600인지는 위에서 본다
      ctx.skip('다른 OS 사용자로 바꾸려면 root로 시험을 돌려야 한다');
    }
    const probe = `const s=require('net').connect(${JSON.stringify(server.adminEndpoint)});s.on('connect',()=>{console.log('connected');process.exit(0)});s.on('error',e=>{console.log(e.code);process.exit(0)})`;
    const r = spawnSync(process.execPath, ['-e', probe], { uid: 65534, gid: 65534, encoding: 'utf8' });
    expect(r.stdout.trim()).toBe('EACCES');
  });

  it('서버가 없으면 운영자 명령은 not_running, 닫으면 관리 토큰(과 소켓 파일)이 없어진다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wook-test-admin-none-'));
    try {
      const err = await adminRequest({ dataDir: dir, command: 'status' }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AdminClientError);
      expect((err as AdminClientError).code).toBe('not_running');
      const s = await startServer({ backend: remoteBackendOf(h), dataDir: dir, port: 0, allowTestSession: false, logger: memoryLogger(), version: 'test' });
      expect((await adminRequest({ dataDir: dir, command: 'status' })).ok).toBe(true);
      await s.close();
      expect(existsSync(adminTokenPath(dir))).toBe(false);
      expect(existsSync(adminEndpointPath(dir))).toBe(false);
      if (!isWin) expect(existsSync(join(dir, 'admin.sock'))).toBe(false);
      const after = await adminRequest({ dataDir: dir, command: 'status' }).catch((e: unknown) => e);
      expect((after as AdminClientError).code).toBe('not_running');
    } finally {
      await removeDir(dir);
    }
  });

  it('비정상 종료가 남긴 admin.token은 시작 때 새 토큰으로 바뀌고, 남은 토큰으로는 관리 채널이 열리지 않는다 (S2-4 시작마다 새 토큰, S2-20)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wook-test-admin-stale-'));
    const stale = 'S'.repeat(43);
    writeFileSync(adminTokenPath(dir), stale);
    const s = await startServer({ backend: remoteBackendOf(h), dataDir: dir, port: 0, allowTestSession: false, logger: memoryLogger(), version: 'test' });
    try {
      const now = readFileSync(adminTokenPath(dir), 'utf8');
      // 실패 글에 토큰이 들어가지 않게 참·거짓만 비교한다
      expect(now === stale, 'admin.token이 남은 토큰 그대로다').toBe(false);
      expect(/^[A-Za-z0-9_-]{43}$/.test(now)).toBe(true);
      // 남은 토큰으로는 서로 증명이 되지 않는다 (S3-16): 운영자 명령은 서버의 증명을 맞출 수 없어 명령을 보내지 않고, 서버는 그 토큰의 증명을 받지 않는다
      const refused = await adminRequest({ dataDir: dir, command: 'status', token: stale }).catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(AdminClientError);
      expect((refused as AdminClientError).code).toBe('bad_server');
      expect((await adminHandshake(readAdminEndpoint(dir), { proofToken: stale, command: 'status' })).reply).toEqual({ ok: false, error: ADMIN_UNAUTHORIZED });
      expect((await adminRequest({ dataDir: dir, command: 'status' })).ok).toBe(true);
    } finally {
      await s.close();
      await removeDir(dir);
    }
  });
});

describe('shutdown과 session test', () => {
  let h: Harness;
  let server: RunningServer;
  let shutdownCalls = 0;

  beforeAll(async () => {
    h = await createHarness({ noProject: true });
    server = await startServer({
      backend: remoteBackendOf(h),
      dataDir: h.dataDir,
      port: 0,
      allowTestSession: true,
      logger: memoryLogger(),
      version: 'test',
      onShutdownRequest: () => (shutdownCalls += 1),
    });
  }, 120_000);
  afterAll(async () => {
    await server?.close();
    await h?.close();
  });

  it('session test는 대표의 기기 세션을 열고(활동 기록은 operator) 토큰을 한 번만 낸다 — 그 토큰으로 HTTP가 된다 (S3-4)', async () => {
    const r = await adminRequest({ dataDir: h.dataDir, command: 'session.test' });
    expect(r.ok).toBe(true);
    const grant = (r as { result: { token: string; expiresAt: string; sessionId: string } }).result;
    expect(/^wos_[A-Za-z0-9_-]{43}$/.test(grant.token)).toBe(true);
    // 기기 세션: 쓰지 않고 14일 (최대 90일)
    expect(Date.parse(grant.expiresAt) - Date.now()).toBeGreaterThan(13.9 * 24 * 3600 * 1000);
    expect(h.core.deviceSessions.live(grant.sessionId)).toMatchObject({ deviceName: '운영자 시험 세션' });
    const resp = await invokeHttp(server.url, grant.token, 'auth.getState');
    expect(resp.json()).toMatchObject({ ok: true, value: { loggedIn: true } });
    const row = h.core.ctx.store.activity.search({ limit: 50 }).find((e) => e.text.startsWith('운영자 시험 세션'));
    expect({ actor: row?.actor, text: row?.text }).toEqual({
      actor: OPERATOR,
      text: '운영자 시험 세션 발급 — 등록된 대표가 없어 시험용 대표(operator-test@wook.local)를 만들었습니다 (--allow-test-session)',
    });
  });

  it('shutdown은 응답을 먼저 보내고 종료 흐름을 부르며, 행위자 operator로 기록한다', async () => {
    const r = await adminRequest({ dataDir: h.dataDir, command: 'shutdown' });
    expect(r).toEqual({ ok: true, result: { shuttingDown: true } });
    await sleep(100);
    expect(shutdownCalls).toBe(1);
    const row = h.core.ctx.store.activity.search({ limit: 50 }).find((e) => e.text === '운영자가 관리 채널로 서버 종료를 요청함');
    expect(row?.actor).toBe(OPERATOR);
  });

  it('종료가 시작되면 status 밖의 명령(두 번째 shutdown·stop·session test)은 거부하고 종료 흐름을 다시 부르지 않는다', async () => {
    const refused = { ok: false, error: { code: 'shutting_down', message: '서버를 끝내는 중입니다' } };
    expect(await adminRequest({ dataDir: h.dataDir, command: 'shutdown' })).toEqual(refused);
    expect(await adminRequest({ dataDir: h.dataDir, command: 'stop' })).toEqual(refused);
    expect(await adminRequest({ dataDir: h.dataDir, command: 'session.test' })).toEqual(refused);
    await sleep(100);
    expect(shutdownCalls).toBe(1);
    expect(h.core.ctx.stop().global.active).toBe(false);
    expect(h.core.ctx.store.activity.search({ limit: 100 }).filter((e) => e.text === '운영자가 관리 채널로 서버 종료를 요청함')).toHaveLength(1);
    expect((await adminRequest({ dataDir: h.dataDir, command: 'status' })).ok).toBe(true);
  });
});

/** hang 시나리오 개발자가 작업 턴을 실제로 돌리는 하네스 */
async function hangingHarness(): Promise<{ h: Harness; pid: number }> {
  const h = await createHarness({ team: ['developer'], scenarios: { developer: 'hang' } });
  try {
    await sendCommand(h, '로그인 화면을 만들어 줘');
    const dev = h.members.developer!;
    await h.waitFor(() => h.core.turns.isMemberRunning(dev) && !!h.core.turns.lastLineOf(dev)?.text.includes('업무를 시작합니다'), { timeoutMs: 90_000, label: '개발자 hang 턴' });
    const turn = h.core.ctx.store.turns.list().find((t) => t.memberId === dev && t.endedAt === null && t.process.pid !== null);
    return { h, pid: turn!.process.pid! };
  } catch (error) {
    await h.close();
    throw error;
  }
}

/** 긴급 정지 결과를 비교할 수 있는 모양으로 (ID·시각·이름은 하네스마다 다르다) */
const shapeOf = (s: EmergencySummary) => ({
  completed: s.completed,
  stoppedTurns: s.stoppedTurns.map((t) => ({ ok: t.ok, task: !!t.taskId })),
  heldTasks: s.heldTasks.map((t) => t.previousState),
  failures: s.failures.length,
});

describe('stop = 대표의 긴급 정지 (S2-4)', () => {
  it('관리 채널 stop은 HTTP의 stop.emergency와 같은 결과를 낸다 — 행위자만 operator', async () => {
    const settled = await Promise.allSettled([hangingHarness(), hangingHarness()]);
    const ready = settled.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
    if (ready.length < 2) {
      for (const x of ready) await x.h.close();
      throw (settled.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason;
    }
    const [a, b] = ready as [Awaited<ReturnType<typeof hangingHarness>>, Awaited<ReturnType<typeof hangingHarness>>];
    // 서버 열기가 실패해도(두 번째에서 던져도) 연 서버와 하네스 둘을 닫도록 try 안에서 연다 (S2-20)
    let sa: RunningServer | null = null;
    let sb: RunningServer | null = null;
    try {
      sa = await startServer({ backend: remoteBackendOf(a.h), dataDir: a.h.dataDir, port: 0, allowTestSession: true, logger: memoryLogger(), version: 'test' });
      sb = await startServer({ backend: remoteBackendOf(b.h), dataDir: b.h.dataDir, port: 0, allowTestSession: true, logger: memoryLogger(), version: 'test' });
      // 운영자: 관리 채널 stop
      const operatorReply = await adminRequest({ dataDir: a.h.dataDir, command: 'stop' });
      expect(operatorReply.ok).toBe(true);
      const operatorSummary = (operatorReply as { result: EmergencySummary }).result;
      // 대표: HTTP stop.emergency
      const grant = await adminRequest({ dataDir: b.h.dataDir, command: 'session.test' });
      const t = (grant as { result: { token: string } }).result.token;
      const ownerResp = await invokeHttp(sb.url, t, 'stop.emergency');
      expect(ownerResp.status).toBe(200);
      const ownerSummary = ownerResp.json<{ value: EmergencySummary }>().value;

      expect(shapeOf(operatorSummary)).toEqual(shapeOf(ownerSummary));
      expect(shapeOf(operatorSummary)).toEqual({ completed: true, stoppedTurns: [{ ok: true, task: true }], heldTasks: ['in_progress'], failures: 0 });
      for (const [x, by] of [
        [a, OPERATOR],
        [b, OWNER],
      ] as const) {
        const stop = x.h.core.ctx.stop().global;
        expect({ active: stop.active, by: stop.by }).toEqual({ active: true, by });
        expect(x.h.core.turns.isMemberRunning(x.h.members.developer!)).toBe(false);
        const row = x.h.core.ctx.store.activity.search({ limit: 100 }).find((e) => e.text === '긴급 정지 실행');
        expect(row?.actor).toBe(by);
        expect(x.h.core.ctx.store.notifications.list().some((n) => n.title === '긴급 정지 완료')).toBe(true);
        const task = x.h.tasks().find((tk) => tk.assigneeId === x.h.members.developer);
        expect(task?.state).toBe('on_hold');
      }
      // 멈춘 CLI 프로세스가 남지 않았다
      for (const pid of [a.pid, b.pid]) {
        let alive = true;
        try {
          process.kill(pid, 0);
        } catch {
          alive = false;
        }
        expect(alive).toBe(false);
      }
    } finally {
      await sa?.close();
      await sb?.close();
      for (const x of [a, b]) await x.h.close();
    }
  }, 240_000);
});
