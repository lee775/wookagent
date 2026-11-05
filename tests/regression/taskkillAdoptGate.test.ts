/**
 * taskkill 대체 러너: 띄우자마자 일을 시작하는 명령의 "넣기 전 창" (stage-6 리뷰 process-shutdown D1 → S7-C1 — AC-29 '긴급 정지 후 CLI가 띄운
 * 하위 프로세스가 하나도 남지 않는다', AC-15·CTL-03 '남은 프로세스가 있으면 정지 완료로 표시하지 않는다', CTL-11).
 * 자동 검사는 cmd.exe /d /s /c로 표준 입력 없이 바로 돈다. 검사 명령이 `start "" /b cmd /d /c inner.cmd`(inner: `start "" /b node server`)면 중간 cmd가
 * 띄운 뒤 약 20ms 안에 끝나 서버의 부모가 사라진다. 그 검사를 띄우기 바로 전에 다른 프로세스가 떠 도우미의 ADD가 그 뒤에 줄을 서면 검사의 ADD는
 * 30~60ms 뒤에 들어가 서버를 놓친다 — 예전에는 그래도 상한(100ms) 안이라 '바로 넣음'으로 쳐서 스스로 끝남 remaining 0, 정지 ok:true였고 서버는 남았다.
 *  - 자동 검사 형태(autocheck.shellCommand의 adoptGate — 시작 신호를 읽기 전에는 아무것도 띄우지 않음): 넣은 뒤에 시작하므로 사슬 전체가 작업 개체 안 →
 *    스스로 끝나면 정리, 정지하면 끝냄, 그리고 종료 확인
 *  - 붙잡을 입력이 없는 실행(adoptGate 없음·입력 없음): 같은 사슬에서 종료를 확인했다고 하지 않는다(-1)
 *  - 앱: 그 검사를 돌리는 작업을 긴급 정지하면 서버까지 끝나고 완료로 표시된다 (예전: 서버가 남았는데 완료)
 * 실제 PowerShell 도우미·실제 프로세스 (Windows 전용)
 */
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createProcessRunner } from '../../src/main/process/processRunner';
import type { ExitInfo, ManagedProcess, ProcessRunner, RunSpec, TerminateResult } from '../../src/main/process/types';
import { shellCommand } from '../../src/main/orchestrator/autocheck';
import { createHarness, sendCommand, type Harness } from '../e2e/harness';
import { sleep } from '../acceptance/stops-helpers';

const isWin = process.platform === 'win32';
const runnerSource = fileURLToPath(new URL('../../resources/jobrunner/JobRunner.cs', import.meta.url));
const seen = new Set<number>();

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

// 고아(개발 서버 대역): PID를 적고 산다 (안전장치 60초)
const SERVER = `require('fs').writeFileSync(process.argv[2], String(process.pid)); setTimeout(() => {}, 60000);`;
// 중간 cmd: 서버를 start /b로 띄우고 곧 끝난다 → 서버의 부모가 사라진다
const INNER_CMD = '@echo off\r\nstart "" /b "%TK_NODE%" "%TK_SRV%" "%TK_OUT%"\r\n';
// 검사 명령: 중간 cmd를 start /b로 띄우고 TK_STAY-1초 산다
const CHAIN_CMD = '@echo off\r\nstart "" /b cmd /d /c "%~dp0inner.cmd"\r\nping -n %TK_STAY% 127.0.0.1 >nul\r\n';

describe.skipIf(!isWin)('taskkill 대체 러너: 띄우자마자 일을 시작하는 명령의 넣기 전 창 (S7-C1, AC-29·15, CTL-03·11)', () => {
  let root: string;
  const runners: ProcessRunner[] = [];

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'wook-test-adopt-gate-'));
    await mkdir(join(root, 'w'), { recursive: true });
    await writeFile(join(root, 'server.cjs'), SERVER);
    await writeFile(join(root, 'w', 'inner.cmd'), INNER_CMD);
    await writeFile(join(root, 'w', 'chain.cmd'), CHAIN_CMD);
  });

  afterEach(() => {
    for (const pid of seen) {
      try {
        if (alive(pid)) process.kill(pid);
      } catch {
        // 정리
      }
    }
    seen.clear();
  });

  afterAll(async () => {
    for (const r of runners) r.dispose?.();
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  });

  async function fresh(): Promise<ProcessRunner> {
    const r = await createProcessRunner({ dataDir: join(root, `d${runners.length}`), forceMode: 'taskkill', log: () => undefined });
    runners.push(r);
    await r.start({ command: process.execPath, args: ['-e', '0'], cwd: join(root, 'w'), env: { ...process.env }, stdinText: null, label: '데움' }).exited;
    return r;
  }

  /** 검사 명령 그대로의 명세 (gated: 자동 검사가 쓰는 adoptGate까지, raw: 시작 신호 형태 없이) */
  function chainSpec(out: string, stay: number, gated: boolean): RunSpec {
    const sh = shellCommand(`"${join(root, 'w', 'chain.cmd')}"`);
    return {
      command: sh.command,
      args: sh.args,
      verbatimArgs: sh.verbatimArgs,
      consoleOutput: sh.consoleOutput,
      ...(gated && sh.adoptGate ? { adoptGate: sh.adoptGate } : {}),
      cwd: join(root, 'w'),
      env: { ...process.env, TK_NODE: process.execPath, TK_SRV: join(root, 'server.cjs'), TK_OUT: out, TK_STAY: String(stay) },
      stdinText: null,
      label: '검사 사슬',
    };
  }

  /** 같은 순간 다른 턴·검사가 뜬 것처럼 자식 없는 프로세스 하나를 먼저 띄운다 (그 ADD가 먼저 줄을 선다) */
  function other(runner: ProcessRunner): ManagedProcess {
    const p = runner.start({ command: process.execPath, args: ['-e', 'setTimeout(() => {}, 1500)'], cwd: join(root, 'w'), env: { ...process.env }, stdinText: null, label: '다른 실행' });
    if (p.pid) seen.add(p.pid);
    return p;
  }

  /** 서버가 적은 PID (작업 개체가 서버가 PID를 쓰기 전에 끝냈으면 null) */
  async function serverPid(file: string, ms: number): Promise<number | null> {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (existsSync(file)) {
        const t = readFileSync(file, 'utf8').trim();
        if (t) {
          const pid = Number(t);
          seen.add(pid);
          return pid;
        }
      }
      await sleep(10);
    }
    return null;
  }

  it('자동 검사 형태는 다른 실행 바로 뒤에 띄워도 사슬의 고아까지 작업 개체에 담는다 — 스스로 끝나면 정리하고 종료 확인(0), 정지하면 끝내고 ok', async () => {
    const results: unknown[] = [];
    for (let i = 0; i < 3; i++) {
      // 스스로 끝남: 검사 셸이 1초 살다 끝난다 — 그사이 중간 cmd는 끝나 서버가 고아가 된다
      const runner = await fresh();
      const first = other(runner);
      const out = join(root, `exit-${i}.pid`);
      const proc = runner.start(chainSpec(out, 2, true));
      if (proc.pid) seen.add(proc.pid);
      const server = await serverPid(out, 5000);
      const info: ExitInfo = await proc.exited;
      await first.exited;
      await sleep(300);
      results.push({ case: 'exit', remaining: info.remaining, detail: info.detail ?? null, server: server !== null, serverAlive: server !== null && alive(server) });
      expect(server, '검사 명령이 서버를 띄웠다 (시작 신호를 받아 검사가 돌았다)').not.toBeNull();
      expect({ remaining: info.remaining, serverAlive: alive(server!) }, info.detail).toEqual({ remaining: 0, serverAlive: false });
      expect(info.leftoverKilled).toBeGreaterThanOrEqual(1);

      // 정지: 검사 셸이 살아 있는 동안 긴급 정지처럼 끝낸다
      const r2 = await fresh();
      const first2 = other(r2);
      const out2 = join(root, `stop-${i}.pid`);
      const proc2 = r2.start(chainSpec(out2, 30, true));
      if (proc2.pid) seen.add(proc2.pid);
      const server2 = await serverPid(out2, 5000);
      expect(server2).not.toBeNull();
      await sleep(300); // 중간 cmd가 끝나 서버가 고아가 됐다
      const res: TerminateResult = await proc2.terminate({ reason: '시험 긴급 정지' });
      await first2.exited;
      await sleep(300);
      results.push({ case: 'stop', ok: res.ok, remaining: res.remaining, detail: res.detail, serverAlive: alive(server2!) });
      expect({ ok: res.ok, remaining: res.remaining, serverAlive: alive(server2!) }, res.detail).toEqual({ ok: true, remaining: 0, serverAlive: false });
    }
    console.log(JSON.stringify(results));
  }, 120_000);

  it('붙잡을 입력이 없는 실행(시작 신호 형태 없음)은 같은 사슬에서 스스로 끝나든 정지하든 종료를 확인했다고 하지 않는다 (-1, 예전: 0·ok인데 서버가 남음)', async () => {
    for (let i = 0; i < 2; i++) {
      const runner = await fresh();
      const first = other(runner);
      const proc = runner.start(chainSpec(join(root, `raw-exit-${i}.pid`), 1, false));
      if (proc.pid) seen.add(proc.pid);
      const info = await proc.exited;
      await first.exited;
      await serverPid(join(root, `raw-exit-${i}.pid`), 1000);
      expect(info.remaining, info.detail).toBe(-1);
      expect(info.detail).toContain('입력 없이 띄우자마자 일을 시작하는 실행');

      const r2 = await fresh();
      const first2 = other(r2);
      const proc2 = r2.start(chainSpec(join(root, `raw-stop-${i}.pid`), 30, false));
      if (proc2.pid) seen.add(proc2.pid);
      await serverPid(join(root, `raw-stop-${i}.pid`), 5000);
      await sleep(300);
      const res = await proc2.terminate({ reason: '시험 긴급 정지' });
      await first2.exited;
      expect({ ok: res.ok, remaining: res.remaining }, res.detail).toEqual({ ok: false, remaining: -1 });
      expect(res.detail).toContain('종료를 확인하지 못했습니다');
    }
  }, 120_000);
});

describe.skipIf(!isWin)('시작 신호 형태는 taskkill 대체 방식에서만 쓴다 — 작업 개체 러너(기본 방식)·도우미 없는 taskkill은 그대로 (S7-C1)', () => {
  let root: string;
  const runners: ProcessRunner[] = [];
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'wook-test-adopt-gate-modes-'));
  });
  afterAll(async () => {
    for (const r of runners) r.dispose?.();
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  });

  /** 일반 형태는 PLAIN, 시작 신호 형태는 GATED를 찍는 명세 */
  const spec = (): RunSpec => ({
    command: process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe',
    args: ['/d', '/s', '/c', '"echo PLAIN"'],
    verbatimArgs: true,
    consoleOutput: true,
    adoptGate: { args: ['/d', '/s', '/c', '"pause>nul& echo GATED"'], go: '\n' },
    cwd: root,
    env: { ...process.env },
    stdinText: null,
    label: '형태 확인',
  });

  async function output(r: ProcessRunner): Promise<{ lines: string[]; info: ExitInfo }> {
    const lines: string[] = [];
    const p = r.start(spec());
    p.onStdoutLine((l) => lines.push(l.trim()));
    return { lines, info: await p.exited };
  }

  it('작업 개체 러너는 adoptGate를 쓰지 않고 그대로 띄운다 (넣기 전 창이 없다 — 일시 중지 상태로 넣은 뒤 시작)', async () => {
    const r = await createProcessRunner({ dataDir: join(root, 'job'), forceMode: 'jobobject', runnerSource, log: () => undefined });
    runners.push(r);
    const { lines, info } = await output(r);
    expect(lines).toEqual(['PLAIN']);
    expect(info).toMatchObject({ code: 0, remaining: 0 });
  }, 120_000);

  it('도우미가 없는 taskkill 러너는 넣지 않으므로 붙잡지 않고 그대로 띄운다 (확인 불가 -1)', async () => {
    const r = await createProcessRunner({ dataDir: join(root, 'bare'), forceMode: 'taskkill', jobHelper: null, log: () => undefined });
    runners.push(r);
    const { lines, info } = await output(r);
    expect(lines).toEqual(['PLAIN']);
    expect(info).toMatchObject({ code: 0, remaining: -1 });
  }, 60_000);

  it('도우미가 있는 taskkill 러너는 시작 신호 형태로 띄워 넣은 뒤 시작한다', async () => {
    const r = await createProcessRunner({ dataDir: join(root, 'tk'), forceMode: 'taskkill', log: () => undefined });
    runners.push(r);
    const { lines, info } = await output(r);
    expect(lines).toEqual(['GATED']);
    expect(info).toMatchObject({ code: 0, remaining: 0 });
  }, 60_000);
});

describe.skipIf(!isWin)('앱: taskkill 대체 방식의 자동 검사가 띄운 고아 (S7-C1, AC-29)', () => {
  let h: Harness | null = null;
  let dir = '';
  afterEach(async () => {
    for (const pid of seen) {
      try {
        if (alive(pid)) process.kill(pid);
      } catch {
        // 정리
      }
    }
    seen.clear();
    await h?.close().catch(() => undefined);
    h = null;
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  it('검사를 띄우는 순간 다른 프로세스가 떠도 그 검사가 이중 start로 띄운 서버까지 긴급 정지로 끝나고 완료로 표시된다 (예전: 서버가 남았는데 완료)', async () => {
    dir = await mkdtemp(join(tmpdir(), 'wook-test-adopt-gate-app-'));
    const out = join(dir, 'server.pid');
    await writeFile(join(dir, 'server.cjs'), SERVER);
    await writeFile(join(dir, 'inner.cmd'), `@echo off\r\nstart "" /b "${process.execPath}" "${join(dir, 'server.cjs')}" "${out}"\r\n`);
    await writeFile(join(dir, 'chainstay.cmd'), `@echo off\r\nstart "" /b cmd /d /c "${join(dir, 'inner.cmd')}"\r\nping -n 40 127.0.0.1 >nul\r\n`);
    h = await createHarness({ team: ['developer'], runnerMode: 'taskkill', checkCommands: [`"${join(dir, 'chainstay.cmd')}"`] });
    const harness = h;
    const runner = harness.core.ctx.deps.runner;
    const orig = runner.start.bind(runner);
    const extras: ManagedProcess[] = [];
    runner.start = (spec: RunSpec) => {
      if (spec.label.startsWith('검사 ')) {
        // 같은 순간 다른 턴이 뜬 것처럼: 자식 없는 프로세스 하나 (그 ADD가 먼저 줄을 선다)
        const p = orig({ command: process.execPath, args: ['-e', 'setTimeout(() => {}, 1500)'], cwd: dir, env: { ...process.env }, stdinText: null, label: '다른 턴 대역' });
        if (p.pid) seen.add(p.pid);
        extras.push(p);
      }
      return orig(spec);
    };
    await sendCommand(harness, '로그인 화면을 만들어 줘');
    await harness.waitFor(() => harness.core.checks.running.size === 1 && existsSync(out) && readFileSync(out, 'utf8').trim() !== '', { timeoutMs: 150_000, label: '자동 검사의 서버' });
    const server = Number(readFileSync(out, 'utf8').trim());
    seen.add(server);
    await sleep(500); // 중간 cmd가 끝나 서버가 고아가 됐다
    const summary = await harness.invoke('stop.emergency');
    await sleep(500);
    expect(summary.completed && alive(server), '서버가 남았는데 긴급 정지 요약이 완료').toBe(false);
    expect(alive(server)).toBe(false);
    expect(summary.completed).toBe(true);
    for (const p of extras) await p.exited;
  }, 300_000);
});
