/**
 * Windows 콘솔 신호 (SERVER_DESIGN 3.2, S2-5, S2-17): 운영자가 콘솔에서 띄운 서버(`npm run start:server`)를 Ctrl+C·Ctrl+Break로 끝내는 길.
 * 빌드한 서버를 숨은 콘솔에 붙여 띄우고(console/launch.ps1 → console/wrapper.mjs), 그 콘솔에 콘솔 제어 이벤트를 낸다(console/send-ctrl.ps1 —
 * AttachConsole + GenerateConsoleCtrlEvent, 시험을 돌리는 쪽 콘솔에는 가지 않는다). Node는 Ctrl+C를 SIGINT로, Ctrl+Break를 SIGBREAK로 받는다.
 * - 모의 CLI가 도는 중에 Ctrl+C를 잇달아 두 번: 두 번 다 받고 종료 흐름은 한 번 — backend.shutdown이 끝나고 남은 프로세스 0, 잠금·관리 토큰 없음, 턴 닫힘, 코드 0
 * - 쉬는 서버에 Ctrl+Break: 같은 종료 흐름, 코드 0
 * POSIX 신호(kill)는 shutdown.test가 본다. Windows에 없는 SIGTERM과, 콘솔 창을 닫을 때의 SIGHUP(CTRL_CLOSE_EVENT — 이 API로 낼 수 없다)은 보지 않는다.
 * 서버가 준비 줄을 내기 전에 실패해도(시간 초과·먼저 끝남) 띄운 줄기(도우미·wrapper·서버)를 끝낸 뒤에야 데이터 폴더를 지운다 (S2-20)
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppSnapshot } from '@shared/views';
import { createHarness } from '../e2e/harness';
import { stillRunning } from '../acceptance/stops-helpers';
import { openStore } from '../../src/main/db/store';
import { dataPaths } from '../../src/main/orchestrator/paths';
import { processLiveness } from '../../src/main/process/processRunner';
import { buildServerTo, descendantsOf, invokeHttp, issueTokenBuilt, removeDir, REPO, runClient, sleep, testBuildDir, workspaceArgs } from './helpers';

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
const launches: { launcher: ChildProcess; outDir: string }[] = [];

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
 * 이 시험이 띄운 콘솔 도우미 줄기(launch.ps1 → wrapper.mjs → 서버)를 끝낸다. 도우미가 살아 있으면 그 줄기째(taskkill /T — 도우미는 wrapper가, wrapper는
 * 서버가 끝날 때까지 기다리므로 줄기가 이어져 있다). 서버가 끝났다는 기록(exit.json)이 없는데 줄기 밖에 남은 wrapper·서버(pids.json)도 끝낸다
 */
function stopLaunch(launcher: ChildProcess, outDir: string): void {
  const killTree = (pid: number): void => void spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 30_000 });
  if (launcher.pid !== undefined && launcher.exitCode === null && launcher.signalCode === null) killTree(launcher.pid);
  const pidsFile = join(outDir, 'pids.json');
  if (!existsSync(pidsFile) || existsSync(join(outDir, 'exit.json'))) return;
  try {
    const pids = JSON.parse(readFileSync(pidsFile, 'utf8')) as { wrapper: number; server: number };
    for (const pid of [pids.server, pids.wrapper]) if (alive(pid)) killTree(pid);
  } catch {
    // 쓰다 만 pids.json — 줄기는 위에서 끝냈다
  }
}

afterAll(async () => {
  // 시험이 중간에 실패해 남은 서버는 관리 채널로 끄고, 그래도 남으면 이 시험이 띄운 프로세스만 끝낸다
  for (const l of launched) {
    if (alive(l.serverPid)) {
      runClient(entry, ['shutdown', '--data-dir', l.dataDir]);
      for (let i = 0; i < 80 && alive(l.serverPid); i++) await sleep(500);
      if (alive(l.serverPid)) process.kill(l.serverPid);
    }
    if (alive(l.wrapperPid)) process.kill(l.wrapperPid);
    if (l.launcher.exitCode === null && l.launcher.signalCode === null) l.launcher.kill();
  }
  // 준비 줄을 받기 전에 실패한 도우미도 끝낸다 — 살아 있는 서버의 잠금·관리 토큰을 데이터 폴더와 함께 지우지 않게, 끝낸 뒤에야 폴더를 지운다 (S2-20)
  for (const x of launches) stopLaunch(x.launcher, x.outDir);
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
  writeFileSync(config, JSON.stringify({ outDir, argv: [entry, 'serve', '--data-dir', dataDir, '--port', '0', ...workspaceArgs(dataDir, extra), ...extra] }));
  // 모든 표준 입출력을 파이프로 주면 libuv가 CREATE_NO_WINDOW를 붙여 launch.ps1이 새 숨은 콘솔을 받는다 — 시험을 돌리는 쪽 콘솔과 나뉜다
  const launcher = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(CONSOLE_DIR, 'launch.ps1'), '-Node', process.execPath, '-Wrapper', join(CONSOLE_DIR, 'wrapper.mjs'), '-Config', config],
    { cwd: REPO, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
  );
  // 기다리기 전에 적어 둔다 — 준비 전에 실패해도 afterAll이 이 줄기를 끝낸다
  launches.push({ launcher, outDir });
  let launcherErr = '';
  launcher.stderr!.setEncoding('utf8').on('data', (c: string) => (launcherErr += c));
  /** 준비 전 실패: 띄운 줄기를 끝낸 뒤 던진다 — 숨은 콘솔의 서버가 HTTP·관리 채널·잠금을 쥔 채 남지 않게 */
  const fail = (message: string): never => {
    stopLaunch(launcher, outDir);
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

/** 서버의 콘솔에 콘솔 제어 이벤트를 count번 잇달아 낸다 — 도우미의 결과 줄('sent N') */
function sendCtrl(pid: number, event: typeof CTRL_C | typeof CTRL_BREAK, count = 1): string {
  const resultFile = join(tempDir('ctrl'), 'result.txt');
  const r = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(CONSOLE_DIR, 'send-ctrl.ps1'), '-TargetPid', String(pid), '-Event', String(event), '-Count', String(count), '-ResultFile', resultFile],
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
    expect(sendCtrl(l.serverPid, CTRL_C, 2)).toBe('sent 2');
    const exit = await waitExit(l);
    expect(exit).toEqual({ code: 0, signal: null });
    expect(stillRunning(pids, stopAt)).toEqual([]);
    expect(existsSync(join(dataDir, 'server.lock'))).toBe(false);
    expect(existsSync(join(dataDir, 'admin.token'))).toBe(false);
    const log = serverLog(dataDir);
    // 두 번째 Ctrl+C도 받았지만 종료 흐름을 다시 시작하지 않았다
    expect(log.match(/종료 신호 받음 \(SIGINT\)/g)).toHaveLength(2);
    expect(log.match(/완전 종료 시작/g)).toHaveLength(1);
    expect(log).toContain('완전 종료 시작 (SIGINT)');
    expect(log).toContain('체크포인트 저장·실행 정리 완료');
    expect(log).toContain('욱채 서버 종료 (코드 0)');
    expect(turnsLeftOpen(dataDir)).toBe(0);
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
});
