/**
 * adminPipeRemote (리드 결정 S9-7·S9-11, SERVER_DESIGN 10.9 완료 기준 '관리 채널 파이프에 다른 기기(SMB)가 붙지 못한다'): 3단계 검토 프로브
 * `zz-s3sec-pipe-remote`(프로브 보관함 server-s3-security-surface — Node 파이프는 `\\127.0.0.1\pipe\…`로 붙은 SMB 클라이언트에게 증명까지 줬다)를 옮긴
 * 회귀 시험. Windows에서 실제 서버 도우미(시험 실행이 한 번 컴파일한 것)로 빌드한 서버를 띄운다.
 * - 대조: Node 파이프가 `\\127.0.0.1\pipe\…`를 받아야 한다 — 이 PC의 SMB(LanmanServer)가 꺼져 있으면 무엇도 증명하지 못하므로 까닭을 말하고 건너뛴다
 * - 로컬 인사는 서버의 증명을 받는다. `\\127.0.0.1\pipe\…`와 `\\<PC 이름>\pipe\…`로 연 연결은 5초 안에 증명을 받지 못한다(연결부터 거부)
 * - status: adminPipe {mode 'helper', rejectsRemote true, userOnlyAcl true}. 파이프의 DACL은 지금 사용자 하나뿐이고 상속하지 않는다 (verify — Get-Acl은
 *   PowerShell 5.1에서 파이프 경로를 열지 못해, 파이프 클라이언트 핸들의 GetAccessControl로 읽는다)
 * 빌드한 서버는 모의 메인으로 준비한 데이터 폴더로 띄우고, 끝나면 모든 메인 턴이 모의인지 본다. 그 서버와 도우미는 shutdown으로 끝내고 남지 않았는지 본다
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_PROTOCOL, readAdminEndpoint } from '../../src/server/admin';
import type { AdminStatus } from '../../src/server/server';
import { openStore } from '../../src/main/db/store';
import { dataPaths } from '../../src/main/orchestrator/paths';
import { createHarness } from '../e2e/harness';
import { stillRunning } from '../acceptance/stops-helpers';
import { buildServerTo, clientJson, descendantsOf, removeDir, runClient, startBuilt, testBuildDir, type BuiltServer } from './helpers';

const isWin = process.platform === 'win32';
const haveHelper = isWin && !!process.env['WOOK_TEST_SERVER_HELPER_BIN'];
/** 오지 않을 증명을 기다리는 창 — 짧게 둔다 (리드 결정 S9-18: 답이 오지 않아야 하는 창) */
const NO_PROOF_MS = 5_000;
/** 와야 하는 답의 창 — 넉넉하게 */
const ANSWER_MS = 30_000;
/** 느린 PC 흉내 (리드 결정 S9-18) — 단계 사이에 이만큼 쉰다 */
const PAUSE = Number(process.env['WOOK_TEST_PAUSE_MS'] ?? 0) || 0;
const pause = (): Promise<void> => new Promise((r) => setTimeout(r, PAUSE));

/** 인사를 보내고 서버의 증명을 기다린다 — 연결됐는지, 증명을 받았는지, 오류 */
function hello(endpoint: string, ms: number): Promise<{ connected: boolean; gotProof: boolean; error: string | null }> {
  return new Promise((resolveIt) => {
    const s = connect(endpoint);
    let connected = false;
    let text = '';
    let done = false;
    const finish = (error: string | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      s.destroy();
      resolveIt({ connected, gotProof: /"proof"\s*:/.test(text), error });
    };
    const timer = setTimeout(() => finish('no_answer'), ms);
    s.setEncoding('utf8');
    s.on('connect', () => {
      connected = true;
      s.write(`${JSON.stringify({ hello: ADMIN_PROTOCOL, nonce: randomBytes(32).toString('base64url') })}\n`);
    });
    s.on('data', (c: string) => {
      text += c;
      if (text.includes('\n')) finish(null);
    });
    s.on('error', (e: NodeJS.ErrnoException) => finish(e.code ?? e.message));
    s.on('close', () => finish(null));
  });
}

const smbPath = (endpoint: string, host: string): string => endpoint.replace(/^\\\\\.\\pipe\\/, `\\\\${host}\\pipe\\`);

/** 대조: Node 파이프가 SMB 루프백으로 붙는 연결을 받는지 — 받지 못하면 그 까닭 */
async function smbControl(): Promise<string | null> {
  const name = `\\\\.\\pipe\\wook-s9a-control-${randomBytes(8).toString('hex')}`;
  const server = createServer((s) => {
    s.on('error', () => undefined);
    s.on('data', () => s.end('{"proof":"control"}\n'));
  });
  await new Promise<void>((r) => server.listen(name, () => r()));
  try {
    const r = await hello(smbPath(name, '127.0.0.1'), ANSWER_MS);
    return r.gotProof ? null : `Node 파이프도 \\\\127.0.0.1\\pipe\\…로 붙지 못합니다 (${r.error ?? '답 없음'}) — 이 PC의 SMB(LanmanServer)가 꺼져 있으면 원격 거부를 볼 수 없습니다`;
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

/** 파이프의 DACL(SDDL)과 상속 보호 — 파이프 클라이언트 핸들로 읽는다 (Get-Acl은 PowerShell 5.1에서 \\.\pipe\ 경로를 열지 못한다) */
function pipeAcl(endpoint: string): { sddl: string; protected: boolean; me: string } {
  const short = endpoint.replace(/^\\\\\.\\pipe\\/, '');
  const script =
    "$c = New-Object System.IO.Pipes.NamedPipeClientStream('.', $env:WOOK_PIPE_SHORT, [System.IO.Pipes.PipeDirection]::InOut); $c.Connect(20000); " +
    "$s = $c.GetAccessControl(); $o = [pscustomobject]@{ sddl = $s.GetSecurityDescriptorSddlForm('Access'); protected = $s.AreAccessRulesProtected; me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value }; $c.Dispose(); $o | ConvertTo-Json -Compress";
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, env: { ...process.env, WOOK_PIPE_SHORT: short } });
  return JSON.parse(out) as { sddl: string; protected: boolean; me: string };
}

describe.runIf(haveHelper)('관리 채널 파이프는 다른 기기(SMB)의 연결을 증명 전에 거부한다 — 실제 서버 도우미 (Windows)', () => {
  let buildDir = '';
  let entry = '';
  let dataDir = '';
  const dirs: string[] = [];
  let srv: BuiltServer | null = null;
  let skipWhy: string | null = null;

  beforeAll(async () => {
    skipWhy = await smbControl();
    if (skipWhy) return;
    buildDir = testBuildDir('piperemote');
    entry = buildServerTo(buildDir);
    // 모의 메인으로 데이터 폴더를 준비한다 — 빌드한 서버가 이 PC의 실제 Claude·Codex CLI 턴을 띄우지 않게 (리드 결정 S6-19)
    const h = await createHarness({ noProject: true });
    dataDir = h.dataDir;
    dirs.push(dataDir, join(h.projectDir, '..'));
    await h.close({ keepDirs: true });
    srv = await startBuilt({ entry, dataDir });
  }, 180_000);

  afterAll(async () => {
    if (srv && srv.child.exitCode === null && srv.child.signalCode === null) {
      runClient(entry, ['shutdown', '--data-dir', dataDir]);
      await Promise.race([srv.exited, new Promise((r) => setTimeout(r, 40_000))]);
      // 시험이 띄운 서버만, 쥔 핸들로
      if (srv.child.exitCode === null && srv.child.signalCode === null) srv.child.kill();
    }
    for (const d of dirs) await removeDir(d);
    if (buildDir) await removeDir(buildDir);
  });

  it('로컬 인사는 증명을 받고, \\\\127.0.0.1\\pipe\\…와 \\\\<PC 이름>\\pipe\\…는 증명을 받지 못한다 — status는 helper·원격 거부·지금 사용자만', async (ctx) => {
    if (skipWhy) {
      console.warn(`[adminPipeRemote] 건너뜀: ${skipWhy}`);
      ctx.skip(skipWhy);
    }
    const status = clientJson(entry, ['status', '--data-dir', dataDir]);
    expect(status.code).toBe(0);
    expect((status.reply.result as AdminStatus).adminPipe).toEqual({ mode: 'helper', rejectsRemote: true, userOnlyAcl: true, reason: null });
    // 절전 방지도 서버 프로세스가 붙였다 — 일이 없으니 도우미를 띄우지 않고 idle (S9-5)
    expect((status.reply.result as AdminStatus).power).toEqual({ state: 'idle', reason: null });
    const endpoint = readAdminEndpoint(dataDir);
    await pause();
    const local = await hello(endpoint, ANSWER_MS);
    expect(local).toMatchObject({ connected: true, gotProof: true });
    for (const host of ['127.0.0.1', hostname()]) {
      await pause();
      const remote = await hello(smbPath(endpoint, host), NO_PROOF_MS);
      expect({ host, connected: remote.connected, gotProof: remote.gotProof }).toEqual({ host, connected: false, gotProof: false });
    }
    // 원격 시도 뒤에도 로컬은 그대로 받는다
    expect((await hello(endpoint, ANSWER_MS)).gotProof).toBe(true);
  }, 120_000);

  it('파이프의 DACL은 지금 사용자 하나에게만 모든 권한이고 상속하지 않는다 (verify)', (ctx) => {
    if (skipWhy) ctx.skip(skipWhy);
    const acl = pipeAcl(readAdminEndpoint(dataDir));
    expect(acl.sddl).toBe(`D:P(A;;FA;;;${acl.me})`);
    expect(acl.protected).toBe(true);
  }, 60_000);

  it('shutdown하면 서버와 서버 도우미가 모두 끝난다 — 메인 턴은 모두 모의다', async (ctx) => {
    if (skipWhy) ctx.skip(skipWhy);
    const s = srv!;
    // 서버의 자손 — 관리 채널 도우미가 그 가운데 하나다
    const children = descendantsOf(s.child.pid);
    expect(children.length).toBeGreaterThan(0);
    await pause();
    const stopAt = Date.now();
    const down = runClient(entry, ['shutdown', '--data-dir', dataDir]);
    expect([down.code, down.stdout.trim()]).toEqual([0, '서버를 종료했습니다.']);
    expect((await s.exited).code).toBe(0);
    // 서버가 끝나기 전에 도우미를 끝내고 확인했다 — 남은 자손이 없고, 기록에서 도우미를 끝낸 줄이 서버 종료 줄보다 앞이다 (보기만 한다)
    // 끝난 도우미의 콘솔 호스트는 조금 늦게 끝날 수 있다 — 끝남은 넉넉한 창으로 본다(보기만 한다). 부하 속 이웃 시험 묶음에서 serverPower가 찾은 것과 같다 (S9-18)
    const deadline = Date.now() + 60_000;
    let left = stillRunning(children, stopAt);
    while (left.length && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
      left = stillRunning(children, stopAt);
    }
    expect(left).toEqual([]);
    const log = readFileSync(join(dataDir, 'logs', 'server.log'), 'utf8');
    const helperEnded = log.indexOf('관리 채널: 서버 도우미를 끝냈습니다 (pid ');
    expect(helperEnded).toBeGreaterThan(0);
    expect(helperEnded).toBeLessThan(log.indexOf('욱채 서버 종료 (코드 0)'));
    expect(log).not.toContain('끝남을 확인하지 못함');
    const store = openStore(dataPaths(dataDir).db);
    try {
      expect(store.turns.list({ ref1: 'M-MAIN' }).filter((t) => !t.mock)).toEqual([]);
    } finally {
      store.close();
    }
  }, 120_000);
});
