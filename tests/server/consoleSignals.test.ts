/**
 * Windows 콘솔 신호 (SERVER_DESIGN 3.2, S2-5, S2-17): 운영자가 콘솔에서 띄운 서버(`npm run start:server`)를 Ctrl+C·Ctrl+Break로 끝내는 길.
 * 빌드한 서버를 숨은 콘솔에 붙여 띄우고(console/launch.ps1 → console/wrapper.mjs), 그 콘솔에 콘솔 제어 이벤트를 낸다(console/send-ctrl.ps1 —
 * AttachConsole + GenerateConsoleCtrlEvent, 시험을 돌리는 쪽 콘솔에는 가지 않는다). Node는 Ctrl+C를 SIGINT로, Ctrl+Break를 SIGBREAK로 받는다.
 * - 모의 CLI가 도는 중에 Ctrl+C를 잇달아 두 번: 두 번 다 받고 종료 흐름은 한 번 — backend.shutdown이 끝나고 남은 프로세스 0, 잠금·관리 토큰 없음, 턴 닫힘, 코드 0
 * - 쉬는 서버에 Ctrl+Break: 같은 종료 흐름, 코드 0
 * - 대표의 체험 도구 local(scripts/try-server.mjs)을 같은 콘솔에서 띄우고 Ctrl+C: 도구가 끝나고(130) 띄운 서버도 끝나며, 남은 자손 프로세스·실행 잠금·중계 파일이
 *   없다 (리드 결정 S9-19 6). 브라우저는 띄우지 않는다(시험 전용 WOOK_TRY_NO_BROWSER) — 체험 뿌리는 임시 폴더, 모의 메인 에이전트를 켠 데이터 폴더
 * POSIX 신호(kill)는 shutdown.test가 본다. Windows에 없는 SIGTERM과, 콘솔 창을 닫을 때의 SIGHUP(CTRL_CLOSE_EVENT — 이 API로 낼 수 없다)은 보지 않는다.
 * 서버가 준비 줄을 내기 전에 실패해도(시간 초과·먼저 끝남) 띄운 줄기(도우미·wrapper·서버)를 끝낸 뒤에야 데이터 폴더를 지운다 (S2-20)
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID, type Settings } from '@shared/domain';
import type { AppSnapshot } from '@shared/views';
import { createHarness } from '../e2e/harness';
import { stillRunning } from '../acceptance/stops-helpers';
import { openStore } from '../../src/main/db/store';
import { dataPaths } from '../../src/main/orchestrator/paths';
import { processLiveness } from '../../src/main/process/processRunner';
import { WEB_BUILD_MARKER } from '../../src/server/webScreen';
import { buildServerTo, clientJson, descendantsOf, invokeHttp, issueTokenBuilt, removeDir, REPO, runClient, seedServerHelper, sleep, testBuildDir, workspaceArgs } from './helpers';

const isWin = process.platform === 'win32';
const SKIP_REASON = 'Windows 콘솔 제어 이벤트(Ctrl+C·Ctrl+Break) 시험 — POSIX 신호는 shutdown.test가 본다';
const CONSOLE_DIR = join(REPO, 'tests', 'server', 'console');
const CTRL_C = 0;
const CTRL_BREAK = 1;
const READY_RE = /욱채 서버 준비 완료: 주소 (http:\/\/\S+)(?: \([^)]*\))? · 실행 ID (\S+) · 데이터 폴더 /;

let buildDir = '';
let entry = '';
const dirs: string[] = [];
const launched: Launched[] = [];
/** 띄운 콘솔 도우미 모두 — 준비 줄을 받기 전에 실패한 것도 afterAll이 끝낸다 (S2-20) */
const launches: { launcher: ChildProcess; outDir: string; dataDir: string }[] = [];

interface Launched {
  outDir: string;
  dataDir: string;
  launcher: ChildProcess;
  wrapperPid: number;
  serverPid: number;
  url: string;
}

beforeAll(() => {
  if (!isWin) return;
  buildDir = testBuildDir('console');
  entry = buildServerTo(buildDir);
}, 120_000);

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * 이 시험이 띄운 콘솔 도우미 줄기(launch.ps1 → wrapper.mjs → 서버)를 끝낸다. 도우미는 그 핸들로(끝나지 않았을 때만), 남은 줄기는 지금 명령줄에 이 줄기의
 * 폴더가 든 프로세스만 하나씩 끝낸다 — 도우미·wrapper의 명령줄에는 설정 파일(outDir), 서버의 명령줄에는 데이터 폴더가 든다(wrapper가 끝나면 그 자식은
 * Node의 작업 개체가 함께 끝낸다). 기록한 PID(pids.json)로 죽이지 않고 트리째(taskkill /T)도 끝내지 않는다: 끝난 프로세스의 번호, 또는 그 번호를 부모로
 * 적은 남의 프로세스를 끝낼 수 있다 (리드 결정 S7-20 TI-8). 서버가 끝났다는 기록(exit.json)이 있으면 wrapper도 끝났다
 */
function stopLaunch(launcher: ChildProcess, outDir: string, dataDir: string): void {
  if (launcher.exitCode === null && launcher.signalCode === null) launcher.kill();
  if (existsSync(join(outDir, 'exit.json'))) return;
  const script =
    "$a=$env:WOOK_KILL_OUT; $b=$env:WOOK_KILL_DATA; Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and ($_.CommandLine.Contains($a) -or $_.CommandLine.Contains($b)) -and $_.ProcessId -ne $PID } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
  spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, WOOK_KILL_OUT: outDir, WOOK_KILL_DATA: dataDir }, windowsHide: true, stdio: 'ignore', timeout: 60_000 });
}

afterAll(async () => {
  // 시험이 중간에 실패해 남은 서버는 관리 채널로 끈다 — 끝났다는 기록(exit.json)을 기다리기만 한다. 그래도 남은 것은 stopLaunch가 이 시험이 띄운 프로세스만
  // 끝낸다 (기록한 PID로 죽이지 않는다, S7-20 TI-8)
  for (const l of launched) {
    const ended = (): boolean => existsSync(join(l.outDir, 'exit.json')) || !alive(l.serverPid);
    if (ended()) continue;
    runClient(entry, ['shutdown', '--data-dir', l.dataDir]);
    for (let i = 0; i < 80 && !ended(); i++) await sleep(500);
  }
  // 준비 줄을 받기 전에 실패한 도우미도 끝낸다 — 살아 있는 서버의 잠금·관리 토큰을 데이터 폴더와 함께 지우지 않게, 끝낸 뒤에야 폴더를 지운다 (S2-20)
  for (const x of launches) stopLaunch(x.launcher, x.outDir, x.dataDir);
  await sleep(300);
  for (const d of dirs) await removeDir(d);
  if (buildDir) await removeDir(buildDir);
}, 120_000);

const tempDir = (tag: string): string => {
  const d = mkdtempSync(join(tmpdir(), `wook-test-console-${tag}-`));
  dirs.push(d);
  return d;
};

/** 숨은 콘솔 하나에 빌드한 서버를 붙여 띄우고 준비 줄을 기다린다 */
async function launchInConsole(dataDir: string, extra: string[] = []): Promise<Launched> {
  const outDir = tempDir('out');
  const config = join(outDir, 'config.json');
  const ws = workspaceArgs(dataDir, extra);
  // 서버가 만드는 작업 폴더(<데이터 폴더>-ws)도 afterAll이 지운다 — 데이터 폴더 옆이라 실행 폴더 정리만으로는 남는다 (리드 결정 S9-22 TI-1)
  if (ws.length) dirs.push(ws[1]!);
  writeFileSync(config, JSON.stringify({ outDir, argv: [entry, 'serve', '--data-dir', dataDir, '--port', '0', ...ws, ...extra] }));
  // 모든 표준 입출력을 파이프로 주면 libuv가 CREATE_NO_WINDOW를 붙여 launch.ps1이 새 숨은 콘솔을 받는다 — 시험을 돌리는 쪽 콘솔과 나뉜다
  const launcher = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(CONSOLE_DIR, 'launch.ps1'), '-Node', process.execPath, '-Wrapper', join(CONSOLE_DIR, 'wrapper.mjs'), '-Config', config],
    { cwd: REPO, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
  );
  // 기다리기 전에 적어 둔다 — 준비 전에 실패해도 afterAll이 이 줄기를 끝낸다
  launches.push({ launcher, outDir, dataDir });
  let launcherErr = '';
  launcher.stderr!.setEncoding('utf8').on('data', (c: string) => (launcherErr += c));
  /** 준비 전 실패: 띄운 줄기를 끝낸 뒤 던진다 — 숨은 콘솔의 서버가 HTTP·관리 채널·잠금을 쥔 채 남지 않게 */
  const fail = (message: string): never => {
    stopLaunch(launcher, outDir, dataDir);
    throw new Error(message);
  };
  const deadline = Date.now() + 90_000;
  for (;;) {
    const out = existsSync(join(outDir, 'stdout.txt')) ? readFileSync(join(outDir, 'stdout.txt'), 'utf8') : '';
    const m = READY_RE.exec(out);
    if (m && existsSync(join(outDir, 'pids.json'))) {
      const pids = JSON.parse(readFileSync(join(outDir, 'pids.json'), 'utf8')) as { wrapper: number; server: number };
      const l: Launched = { outDir, dataDir, launcher, wrapperPid: pids.wrapper, serverPid: pids.server, url: m[1]! };
      launched.push(l);
      return l;
    }
    const err = existsSync(join(outDir, 'stderr.txt')) ? readFileSync(join(outDir, 'stderr.txt'), 'utf8') : '';
    if (existsSync(join(outDir, 'exit.json'))) fail(`서버가 준비 전에 끝났습니다: ${readFileSync(join(outDir, 'exit.json'), 'utf8')} ${err}`);
    if (launcher.exitCode !== null && !existsSync(join(outDir, 'pids.json'))) fail(`콘솔 도우미가 서버를 띄우지 못했습니다 (코드 ${launcher.exitCode}): ${launcherErr}`);
    if (Date.now() > deadline) fail(`서버 준비 시간 초과: ${err} ${launcherErr}`);
    await sleep(100);
  }
}

const KIT = join(REPO, 'scripts', 'try-server.mjs');

interface KitLaunch {
  outDir: string;
  launcher: ChildProcess;
  /** 콘솔에 붙은 체험 도구 (wrapper의 자식) */
  kitPid: number;
}

/**
 * 숨은 콘솔 하나에 대표의 체험 도구(scripts/try-server.mjs)를 붙여 띄우고, 도구가 서버를 띄워 '창이 열렸습니다' 줄을 낼 때까지 기다린다. env는 도구가 받는다
 * (wrapper·도구·도구가 띄운 서버가 물려받는다). 준비 전에 실패하면 띄운 줄기를 끝낸 뒤 던진다 — 도구가 띄운 서버의 명령줄에는 데이터 폴더(dataDir)가 든다
 */
async function launchKitInConsole(args: string[], env: Record<string, string>, dataDir: string): Promise<KitLaunch> {
  const outDir = tempDir('kit');
  const config = join(outDir, 'config.json');
  writeFileSync(config, JSON.stringify({ outDir, argv: [KIT, ...args] }));
  const launcher = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(CONSOLE_DIR, 'launch.ps1'), '-Node', process.execPath, '-Wrapper', join(CONSOLE_DIR, 'wrapper.mjs'), '-Config', config],
    { cwd: REPO, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, ...env } },
  );
  launches.push({ launcher, outDir, dataDir });
  let launcherErr = '';
  launcher.stderr!.setEncoding('utf8').on('data', (c: string) => (launcherErr += c));
  const fail = (message: string): never => {
    // 도구가 띄운 서버가 남지 않게 관리 채널로 먼저 끈다 — 그래도 남은 줄기는 stopLaunch가 (기록한 PID로 죽이지 않는다)
    runClient(entry, ['shutdown', '--data-dir', dataDir]);
    stopLaunch(launcher, outDir, dataDir);
    throw new Error(message);
  };
  // 준비 기다림은 넉넉하게 — 서버 준비(첫 시작의 도우미 준비 포함)와 운영자 명령 몇 개 (리드 결정 S9-18)
  const deadline = Date.now() + 180_000;
  for (;;) {
    const out = existsSync(join(outDir, 'stdout.txt')) ? readFileSync(join(outDir, 'stdout.txt'), 'utf8') : '';
    if (out.includes('창이 열렸습니다') && existsSync(join(outDir, 'pids.json'))) {
      const pids = JSON.parse(readFileSync(join(outDir, 'pids.json'), 'utf8')) as { wrapper: number; server: number };
      return { outDir, launcher, kitPid: pids.server };
    }
    const err = existsSync(join(outDir, 'stderr.txt')) ? readFileSync(join(outDir, 'stderr.txt'), 'utf8') : '';
    if (existsSync(join(outDir, 'exit.json'))) fail(`체험 도구가 준비 전에 끝났습니다: ${readFileSync(join(outDir, 'exit.json'), 'utf8')}\n${out}\n${err}`);
    if (launcher.exitCode !== null && !existsSync(join(outDir, 'pids.json'))) fail(`콘솔 도우미가 체험 도구를 띄우지 못했습니다 (코드 ${launcher.exitCode}): ${launcherErr}`);
    if (Date.now() > deadline) fail(`체험 도구 준비 시간 초과:\n${out}\n${err}\n${launcherErr}`);
    await sleep(100);
  }
}

/**
 * 서버의 콘솔에 콘솔 제어 이벤트를 count번 낸다 — 도우미의 결과 줄('sent N'). after를 주면 둘째부터는 앞 이벤트를 받았다는 줄(after.text)이 after.file에
 * 그 수만큼 생긴 뒤에 낸다 (콘솔에 붙은 채로 기다린다 — 리드 결정 S6-21 J5: Node는 이벤트 루프가 앞 이벤트를 받기 전에 온 둘째를 하나로 합친다)
 */
function sendCtrl(pid: number, event: typeof CTRL_C | typeof CTRL_BREAK, count = 1, after?: { file: string; text: string }): string {
  const resultFile = join(tempDir('ctrl'), 'result.txt');
  const wait = after ? ['-WaitFile', after.file, '-WaitTextB64', Buffer.from(after.text, 'utf8').toString('base64')] : [];
  const r = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(CONSOLE_DIR, 'send-ctrl.ps1'), '-TargetPid', String(pid), '-Event', String(event), '-Count', String(count), '-ResultFile', resultFile, ...wait],
    { encoding: 'utf8', windowsHide: true, timeout: 60_000 },
  );
  return existsSync(resultFile) ? readFileSync(resultFile, 'utf8').replace(/^﻿/, '').trim() : `결과 없음 (코드 ${r.status}) ${r.stderr}`;
}

async function waitExit(l: Launched, ms = 90_000): Promise<{ code: number | null; signal: string | null }> {
  const file = join(l.outDir, 'exit.json');
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as { code: number | null; signal: string | null };
    await sleep(100);
  }
  throw new Error('서버가 끝나지 않았습니다');
}

const serverLog = (dataDir: string): string => readFileSync(join(dataDir, 'logs', 'server.log'), 'utf8');

function turnsLeftOpen(dataDir: string): number {
  const store = openStore(dataPaths(dataDir).db);
  try {
    return store.turns.list().filter((t) => t.endedAt === null).length;
  } finally {
    store.close();
  }
}

describe('Windows 콘솔에서 끝내기 (S2-5)', () => {
  it('모의 CLI가 도는 중에 Ctrl+C를 잇달아 두 번 — 두 번 다 받고 종료는 한 번, 남은 프로세스 0, 잠금·관리 토큰 없음, 턴 닫힘, 코드 0', { timeout: 300_000 }, async (ctx) => {
    if (!isWin) ctx.skip(SKIP_REASON);
    // 대표는 팀을 꾸리지 못한다 — 하네스로 hang 개발자가 있는 프로젝트를 준비한다
    const h = await createHarness({ team: ['developer'], scenarios: { developer: 'hang' } });
    const { dataDir, projectId } = h;
    dirs.push(h.dataDir, join(h.projectDir, '..'));
    await h.close({ keepDirs: true });
    const startedAt = Date.now();
    const l = await launchInConsole(dataDir, ['--allow-test-session']);
    const token = issueTokenBuilt(entry, dataDir);
    expect((await invokeHttp(l.url, token, 'command.send', [{ target: projectId, text: '로그인 화면을 만들어 줘' }])).status).toBe(200);
    const deadline = Date.now() + 120_000;
    for (;;) {
      const snap = (await invokeHttp(l.url, token, 'snapshot.get')).json<{ value: AppSnapshot }>().value;
      if (snap.tasks.some((t) => t.state === 'in_progress') && snap.running.total > 0) break;
      if (Date.now() > deadline) throw new Error('모의 CLI 턴이 시작되지 않았습니다');
      await sleep(200);
    }
    await sleep(500);
    const all = descendantsOf(l.serverPid);
    const created = await processLiveness.processCreatedAt(all);
    // 서버보다 먼저 생긴 것(부모 pid가 다시 쓰인 남의 프로세스)은 빼고 센다
    const pids = all.filter((p) => (created.get(p) ?? 0) >= startedAt - 2000);
    expect(pids.length).toBeGreaterThan(0);

    const stopAt = Date.now();
    // 둘째 Ctrl+C는 서버가 첫째를 받았다는 줄을 쓴 뒤에 — 종료 흐름이 도는 동안 온 둘째 신호를 받고도 흐름을 다시 시작하지 않는지를 본다. 잇달아 내면 PC가 바쁠 때
    // Node가 둘을 하나로 합쳐 이 시험이 부하에 따라 실패했다 (리드 결정 S6-21 J5)
    const sent = sendCtrl(l.serverPid, CTRL_C, 2, { file: join(dataDir, 'logs', 'server.log'), text: '종료 신호 받음 (SIGINT)' });
    // 서버는 첫 신호 뒤 수십 ms 안에 종료를 마친다 — 바쁜 PC에서 신호 도우미가 그보다 늦게 돌면 둘째를 낼 때 서버가 이미 끝났다('late 1'). 그때는 둘째 줄을
    // 바랄 수 없다 — 서버의 종료와 경주하지 않게 도우미가 알려 준 대로 본다 (S6F2b, 리드 결정 S6-23 T3)
    expect(sent).toMatch(/^sent 2( late 1)?$/);
    const late = sent.endsWith('late 1');
    const exit = await waitExit(l);
    expect(exit).toEqual({ code: 0, signal: null });
    expect(stillRunning(pids, stopAt)).toEqual([]);
    expect(existsSync(join(dataDir, 'server.lock'))).toBe(false);
    expect(existsSync(join(dataDir, 'admin.token'))).toBe(false);
    const log = serverLog(dataDir);
    // 두 번째 Ctrl+C도 받았지만 종료 흐름을 다시 시작하지 않았다 (둘째를 낼 때 서버가 살아 있었으면 두 줄 — 이미 끝났으면 첫 줄뿐일 수 있다). 종료 흐름은 늘 한 번이다
    const received = log.match(/종료 신호 받음 \(SIGINT\)/g)?.length ?? 0;
    expect({ late, received }).toEqual({ late, received: late && received === 1 ? 1 : 2 });
    expect(log.match(/완전 종료 시작/g)).toHaveLength(1);
    expect(log).toContain('완전 종료 시작 (SIGINT)');
    expect(log).toContain('체크포인트 저장·실행 정리 완료');
    expect(log).toContain('욱채 서버 종료 (코드 0)');
    expect(turnsLeftOpen(dataDir)).toBe(0);
  });

  it('신호 도우미는 둘째 Ctrl+C를 첫째를 받았다는 줄이 생긴 뒤에 낸다 — 이벤트 루프가 막혀 있어도(바쁜 PC) 두 신호가 하나로 합쳐지지 않는다 (S6-21 J5)', { timeout: 120_000 }, async (ctx) => {
    if (!isWin) ctx.skip(SKIP_REASON);
    // 서버 대신 아주 작은 Node 프로세스 — 이벤트 루프를 1초씩 막는다 (Atomics.wait: CPU를 쓰지 않고 잠든다). 잇달아 낸 두 Ctrl+C는 그 사이에 같이 와 하나로
    // 합쳐진다. 받은 신호마다 한 줄, 둘째 신호를 받으면 곧 끝난다 (둘째가 오지 않으면 첫 신호 6초 뒤에)
    const child = [
      'const lock = new Int32Array(new SharedArrayBuffer(4)); let n = 0;',
      "process.on('SIGINT', () => { n++; console.log('SIGINT ' + n); setTimeout(() => process.exit(0), n === 1 ? 6000 : 50); });",
      'setInterval(() => Atomics.wait(lock, 0, 0, 1000), 1);',
      'setTimeout(() => process.exit(3), 60000);',
      "console.log('ready');",
    ].join('\n');
    const outDir = tempDir('sig');
    const config = join(outDir, 'config.json');
    writeFileSync(config, JSON.stringify({ outDir, argv: ['-e', child] }));
    const launcher = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(CONSOLE_DIR, 'launch.ps1'), '-Node', process.execPath, '-Wrapper', join(CONSOLE_DIR, 'wrapper.mjs'), '-Config', config],
      { cwd: REPO, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    );
    // 작은 Node 프로세스의 명령줄에는 이 폴더가 없다 — wrapper(설정 파일이 outDir)가 끝나면 함께 끝난다 (안전장치 60초)
    launches.push({ launcher, outDir, dataDir: outDir });
    const stdout = join(outDir, 'stdout.txt');
    const read = (): string => (existsSync(stdout) ? readFileSync(stdout, 'utf8') : '');
    const deadline = Date.now() + 60_000;
    while (!(read().includes('ready') && existsSync(join(outDir, 'pids.json')))) {
      if (Date.now() > deadline) throw new Error('작은 Node 프로세스가 준비되지 않았습니다');
      await sleep(100);
    }
    const pid = (JSON.parse(readFileSync(join(outDir, 'pids.json'), 'utf8')) as { server: number }).server;
    expect(sendCtrl(pid, CTRL_C, 2, { file: stdout, text: 'SIGINT 1' })).toBe('sent 2');
    const end = Date.now() + 30_000;
    while (!existsSync(join(outDir, 'exit.json')) && Date.now() < end) await sleep(100);
    expect(read().match(/^SIGINT \d+/gm)).toEqual(['SIGINT 1', 'SIGINT 2']);
  });

  it('쉬는 서버에 Ctrl+Break — 같은 종료 흐름(SIGBREAK), 잠금·관리 토큰 없음, 코드 0', { timeout: 180_000 }, async (ctx) => {
    if (!isWin) ctx.skip(SKIP_REASON);
    const dataDir = tempDir('idle');
    const l = await launchInConsole(dataDir);
    expect(sendCtrl(l.serverPid, CTRL_BREAK)).toBe('sent 1');
    expect(await waitExit(l)).toEqual({ code: 0, signal: null });
    expect(existsSync(join(dataDir, 'server.lock'))).toBe(false);
    expect(existsSync(join(dataDir, 'admin.token'))).toBe(false);
    const log = serverLog(dataDir);
    expect(log.match(/완전 종료 시작/g)).toHaveLength(1);
    expect(log).toContain('완전 종료 시작 (SIGBREAK)');
    expect(log).toContain('욱채 서버 종료 (코드 0)');
  });

  it('체험 도구 local을 콘솔에서 Ctrl+C — 도구는 130으로 끝나고, 띄운 서버도 정상 종료했으며, 남은 자손 프로세스·실행 잠금·중계 파일이 없다 (S9-19 6)', { timeout: 300_000 }, async (ctx) => {
    if (!isWin) ctx.skip(SKIP_REASON);
    // 체험 뿌리는 이 시험의 임시 폴더 — 대표의 %LOCALAPPDATA%\wookagent-try를 쓰지 않는다
    const root = tempDir('tryroot');
    const dataDir = join(root, 'server');
    // 모의 메인 에이전트를 켠 데이터 폴더를 먼저 만든다 — 도구가 띄우는 서버가 이 PC의 실제 Claude CLI로 메인 턴을 띄우지 않게 (시작 전에, S6-19)
    const h = await createHarness({ noProject: true, mode: 'server', dataDir });
    dirs.push(resolve(h.projectDir, '..'));
    await h.close({ keepDirs: true });
    seedServerHelper(dataDir);
    // 서버용 빌드 표시만 있는 웹 화면 폴더 — 브라우저를 띄우지 않으므로 화면 파일은 쓰지 않는다
    const webDir = tempDir('web');
    writeFileSync(join(webDir, 'index.html'), `<!doctype html><html><head>${WEB_BUILD_MARKER}</head><body></body></html>`);

    const startedAt = Date.now();
    const kit = await launchKitInConsole(['local'], { WOOK_TRY_ROOT: root, WOOK_TRY_SERVER_ENTRY: entry, WOOK_TRY_WEB_DIR: webDir, WOOK_TRY_NO_BROWSER: '1' }, dataDir);
    const before = readFileSync(join(kit.outDir, 'stdout.txt'), 'utf8');
    // 도구가 쓴 자리는 이 시험의 체험 뿌리다
    expect(before).toContain(`데이터 폴더: ${dataDir}`);
    expect(clientJson(entry, ['status', '--data-dir', dataDir]).reply.ok).toBe(true);
    expect(existsSync(join(dataDir, 'try-front.json'))).toBe(true);
    // 도구의 자손(서버와 그 도우미)을 Ctrl+C 전에 적어 둔다 — 도구보다 먼저 생긴 것(부모 pid가 다시 쓰인 남의 프로세스)은 뺀다
    const all = descendantsOf(kit.kitPid);
    const created = await processLiveness.processCreatedAt(all);
    const pids = all.filter((p) => (created.get(p) ?? 0) >= startedAt - 2000);
    expect(pids.length).toBeGreaterThan(0);

    const stopAt = Date.now();
    expect(sendCtrl(kit.kitPid, CTRL_C)).toBe('sent 1');
    // 도구는 관리 채널로 서버를 끄고 그 끝을 기다린 뒤에 끝난다 — 넉넉히 기다린다 (S9-18)
    const file = join(kit.outDir, 'exit.json');
    const deadline = Date.now() + 150_000;
    while (!existsSync(file) && Date.now() < deadline) await sleep(100);
    const out = readFileSync(join(kit.outDir, 'stdout.txt'), 'utf8');
    const err = existsSync(join(kit.outDir, 'stderr.txt')) ? readFileSync(join(kit.outDir, 'stderr.txt'), 'utf8') : '';
    expect(existsSync(file), `체험 도구가 Ctrl+C 뒤 150초 안에 끝나지 않았습니다\n${out}\n${err}`).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ code: 130, signal: null });
    expect(out).toContain('Ctrl+C — 모두 끕니다');
    expect(out).toContain(`모두 껐습니다. 데이터는 ${dataDir}에 남아 있습니다`);
    expect(err).not.toContain('서버 프로세스를 끝냅니다');
    expect(`${out}${err}`).not.toMatch(/wos_[A-Za-z0-9_-]{20,}/);

    // 남은 것이 없다: 자손 프로세스, 실행 잠금, 중계 파일 — 서버는 제 종료 흐름으로 끝났다. 자손은 넉넉히(30초) 기다려 본다 (S9-18)
    let left = stillRunning(pids, stopAt);
    for (let i = 0; i < 60 && left.length > 0; i++) {
      await sleep(500);
      left = stillRunning(pids, stopAt);
    }
    expect(left).toEqual([]);
    expect(clientJson(entry, ['status', '--data-dir', dataDir]).reply.error?.code).toBe('not_running');
    expect(existsSync(join(dataDir, 'server.lock'))).toBe(false);
    expect(existsSync(join(dataDir, 'try-front.json'))).toBe(false);
    // 도구가 띄운 서버는 콘솔 없이 돈다(창 없이 띄움) — 도구가 관리 채널의 shutdown으로 끄고, 서버는 제 종료 흐름으로 0으로 끝났다
    const log = serverLog(dataDir);
    expect(log).toContain('관리 채널: shutdown 처리');
    expect(log).toContain('욱채 서버 종료 (코드 0)');
    // 메인 턴은 모두 모의다 (모의 메인 에이전트가 끝까지 켜져 있었다)
    const store = openStore(dataPaths(dataDir).db);
    try {
      expect(store.turns.list().filter((t) => t.memberId === MAIN_AGENT_ID && !t.mock).map((t) => t.id)).toEqual([]);
      expect(store.kv.get<Settings>('settings')?.developer.mainAgentMock).toBe(true);
    } finally {
      store.close();
    }
  });
});
