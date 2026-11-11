/**
 * taskkill 대체 러너: 띄우자마자 일을 시작하는 명령의 "넣기 전 창" (stage-6 리뷰 process-shutdown D1 → S7-C1 — AC-29 '긴급 정지 후 CLI가 띄운
 * 하위 프로세스가 하나도 남지 않는다', AC-15·CTL-03 '남은 프로세스가 있으면 정지 완료로 표시하지 않는다', CTL-11).
 * 자동 검사는 cmd.exe /d /s /c로 표준 입력 없이 바로 돈다. 검사 명령이 `start "" /b cmd /d /c inner.cmd`(inner: `start "" /b node server`)면 중간 cmd가
 * 띄운 뒤 약 20ms 안에 끝나 서버의 부모가 사라진다. 그 검사를 띄우기 바로 전에 다른 프로세스가 떠 도우미의 ADD가 그 뒤에 줄을 서면 검사의 ADD는
 * 30~60ms 뒤에 들어가 서버를 놓친다 — 예전에는 그래도 상한(100ms) 안이라 '바로 넣음'으로 쳐서 스스로 끝남 remaining 0, 정지 ok:true였고 서버는 남았다.
 *  - 자동 검사 형태(autocheck.shellCommand의 adoptGate — 시작 신호를 읽기 전에는 아무것도 띄우지 않음): 넣은 뒤에 시작하므로 사슬 전체가 작업 개체 안 →
 *    스스로 끝나면 정리, 정지하면 끝냄, 그리고 종료 확인
 *  - 붙잡을 입력이 없는 실행(adoptGate 없음·입력 없음): 같은 사슬에서 종료를 확인했다고 하지 않는다(-1)
 *  - 도우미가 시작 신호 형태의 루트를 '넣기 전에 끝남'이라고 알렸는데 러너는 그 끝남을 보지 못했다(루트를 열지 못함): 한 번 다시 넣고, 그래도 못 넣었으면
 *    확인하지 못한 것(-1)으로 다룬다 — 예전: 한 번의 OpenProcess 실패로 사슬 전체가 작업 개체 밖에서 도는데 ok·0 (S7-20 P1)
 *  - 앱: 그 검사를 돌리는 작업을 긴급 정지하면 서버까지 끝나고 완료로 표시된다 (예전: 서버가 남았는데 완료)
 * 고아 서버가 살아 있는지는 PID가 아니라 서버 자신의 박동 파일로 본다 — PID 번호는 끝난 뒤 다른 프로세스에 곧 다시 쓰여 '살아 있음'으로 읽힐 수 있다.
 * 정리도 PID로 죽이지 않는다: 고아는 그만 파일(또는 제 PID 파일이 지워지면)로 스스로 끝나고, 러너로 띄운 실행은 러너가 가진 핸들로 끝낸다 (S7-20 T2c·TI-8).
 * 실제 PowerShell 도우미·실제 프로세스 (Windows 전용)
 */
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createProcessRunner } from '../../src/main/process/processRunner';
import { createJobHelper, type JobHelper } from '../../src/main/process/jobHelper';
import type { ExitInfo, ManagedProcess, ProcessRunner, RunSpec, TerminateResult } from '../../src/main/process/types';
import { shellCommand } from '../../src/main/orchestrator/autocheck';
import { createHarness, sendCommand, type Harness } from '../e2e/harness';
import { sleep } from '../acceptance/stops-helpers';

const isWin = process.platform === 'win32';
const runnerSource = fileURLToPath(new URL('../../resources/jobrunner/JobRunner.cs', import.meta.url));

// 고아(개발 서버 대역): PID 파일을 쓰고 50ms마다 박동 파일(<PID 파일>.beat)에 한 글자를 붙인다. 그만 파일(<PID 파일>.quit)이 생기거나 제 PID 파일이
// 지워지면(시험 폴더 정리) 스스로 끝난다 (안전장치 60초)
const SERVER = `const fs=require('fs');const f=process.argv[2];fs.writeFileSync(f,String(process.pid));setInterval(()=>{try{fs.appendFileSync(f+'.beat','.')}catch{}if(fs.existsSync(f+'.quit')||!fs.existsSync(f))process.exit(0)},50);setTimeout(()=>process.exit(0),60000);`;
// 중간 cmd: 서버를 start /b로 띄우고 곧 끝난다 → 서버의 부모가 사라진다
const INNER_CMD = '@echo off\r\nstart "" /b "%TK_NODE%" "%TK_SRV%" "%TK_OUT%"\r\n';
// 검사 명령: 중간 cmd를 start /b로 띄우고 TK_STAY-1초 산다
const CHAIN_CMD = '@echo off\r\nstart "" /b cmd /d /c "%~dp0inner.cmd"\r\nping -n %TK_STAY% 127.0.0.1 >nul\r\n';

/**
 * 그 서버가 ms 동안 박동했는지 — 그 서버 자신만 쓰는 파일이라 PID가 다시 쓰여도 속지 않는다. 끝났다고 볼 때(false)는 박동 8번 넘는 동안 한 번도 자라지
 * 않은 것이다
 */
async function beating(out: string, ms = 400): Promise<boolean> {
  const size = (): number => (existsSync(`${out}.beat`) ? statSync(`${out}.beat`).size : 0);
  const a = size();
  await sleep(ms);
  return size() > a;
}

/** 고아 서버를 그만 파일로 끝낸다 (PID로 죽이지 않는다) */
function quit(outs: string[]): void {
  for (const o of outs.splice(0)) {
    try {
      writeFileSync(`${o}.quit`, '');
    } catch {
      // 폴더가 이미 지워졌다 — 서버는 제 PID 파일이 없어져 스스로 끝난다
    }
  }
}

/** 서버가 적은 PID (작업 개체가 서버가 PID를 쓰기 전에 끝냈으면 null) */
async function serverPid(file: string, ms: number): Promise<number | null> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (existsSync(file)) {
      const t = readFileSync(file, 'utf8').trim();
      if (t) return Number(t);
    }
    await sleep(10);
  }
  return null;
}

describe.skipIf(!isWin)('taskkill 대체 러너: 띄우자마자 일을 시작하는 명령의 넣기 전 창 (S7-C1, AC-29·15, CTL-03·11)', () => {
  let root: string;
  const runners: ProcessRunner[] = [];
  /** 이 시험이 쓴 고아 서버의 PID 파일 — 그만 파일로 끝낸다 */
  const outs: string[] = [];
  /** 러너로 띄운 실행 — 러너가 가진 핸들로 끝낸다 (이미 끝났으면 아무것도 하지 않는다) */
  const procs: ManagedProcess[] = [];

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'wook-test-adopt-gate-'));
    await mkdir(join(root, 'w'), { recursive: true });
    await writeFile(join(root, 'server.cjs'), SERVER);
    await writeFile(join(root, 'w', 'inner.cmd'), INNER_CMD);
    await writeFile(join(root, 'w', 'chain.cmd'), CHAIN_CMD);
  });

  afterEach(async () => {
    quit(outs);
    await Promise.all(procs.splice(0).map((p) => p.terminate({ timeoutMs: 3000, reason: '시험 정리' }).catch(() => undefined)));
  });

  afterAll(async () => {
    quit(outs);
    await sleep(300);
    for (const r of runners) r.dispose?.();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
  });

  async function fresh(jobHelper?: JobHelper): Promise<ProcessRunner> {
    const r = await createProcessRunner({ dataDir: join(root, `d${runners.length}`), forceMode: 'taskkill', log: () => undefined, ...(jobHelper ? { jobHelper } : {}) });
    runners.push(r);
    await r.start({ command: process.execPath, args: ['-e', '0'], cwd: join(root, 'w'), env: { ...process.env }, stdinText: null, label: '데움' }).exited;
    return r;
  }

  function start(runner: ProcessRunner, spec: RunSpec): ManagedProcess {
    const p = runner.start(spec);
    procs.push(p);
    return p;
  }

  /** 검사 명령 그대로의 명세 (gated: 자동 검사가 쓰는 adoptGate까지, raw: 시작 신호 형태 없이). out은 고아 서버의 PID 파일 */
  function chainSpec(out: string, stay: number, gated: boolean): RunSpec {
    outs.push(out);
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
    return start(runner, { command: process.execPath, args: ['-e', 'setTimeout(() => {}, 1500)'], cwd: join(root, 'w'), env: { ...process.env }, stdinText: null, label: '다른 실행' });
  }

  it('자동 검사 형태는 다른 실행 바로 뒤에 띄워도 사슬의 고아까지 작업 개체에 담는다 — 스스로 끝나면 정리하고 종료 확인(0), 정지하면 끝내고 ok', async () => {
    const results: unknown[] = [];
    for (let i = 0; i < 3; i++) {
      // 스스로 끝남: 검사 셸이 1초 살다 끝난다 — 그사이 중간 cmd는 끝나 서버가 고아가 된다
      const runner = await fresh();
      const first = other(runner);
      const out = join(root, `exit-${i}.pid`);
      const proc = start(runner, chainSpec(out, 2, true));
      const server = await serverPid(out, 5000);
      const info: ExitInfo = await proc.exited;
      await first.exited;
      const serverBeating = await beating(out);
      results.push({ case: 'exit', remaining: info.remaining, detail: info.detail ?? null, server: server !== null, serverBeating });
      expect(server, '검사 명령이 서버를 띄웠다 (시작 신호를 받아 검사가 돌았다)').not.toBeNull();
      expect({ remaining: info.remaining, serverBeating }, info.detail).toEqual({ remaining: 0, serverBeating: false });
      expect(info.leftoverKilled).toBeGreaterThanOrEqual(1);

      // 정지: 검사 셸이 살아 있는 동안 긴급 정지처럼 끝낸다 (리뷰어 탐침 zz-s7tests-integrity-taskkill — 서버의 박동으로 본다)
      const r2 = await fresh();
      const first2 = other(r2);
      const out2 = join(root, `stop-${i}.pid`);
      const proc2 = start(r2, chainSpec(out2, 30, true));
      expect(await serverPid(out2, 5000)).not.toBeNull();
      expect(await beating(out2), '서버가 돌기 시작했다 (박동)').toBe(true);
      await sleep(300); // 중간 cmd가 끝나 서버가 고아가 됐다
      const res: TerminateResult = await proc2.terminate({ reason: '시험 긴급 정지' });
      await first2.exited;
      const beat2 = await beating(out2);
      results.push({ case: 'stop', ok: res.ok, remaining: res.remaining, detail: res.detail, serverBeating: beat2 });
      expect({ ok: res.ok, remaining: res.remaining, serverBeating: beat2 }, res.detail).toEqual({ ok: true, remaining: 0, serverBeating: false });
    }
    console.log(JSON.stringify(results));
  }, 120_000);

  it('붙잡을 입력이 없는 실행(시작 신호 형태 없음)은 같은 사슬에서 스스로 끝나든 정지하든 종료를 확인했다고 하지 않는다 (-1, 예전: 0·ok인데 서버가 남음)', async () => {
    for (let i = 0; i < 2; i++) {
      const runner = await fresh();
      const first = other(runner);
      const proc = start(runner, chainSpec(join(root, `raw-exit-${i}.pid`), 1, false));
      const info = await proc.exited;
      await first.exited;
      await serverPid(join(root, `raw-exit-${i}.pid`), 1000);
      expect(info.remaining, info.detail).toBe(-1);
      expect(info.detail).toContain('입력 없이 띄우자마자 일을 시작하는 실행');

      const r2 = await fresh();
      const first2 = other(r2);
      const proc2 = start(r2, chainSpec(join(root, `raw-stop-${i}.pid`), 30, false));
      await serverPid(join(root, `raw-stop-${i}.pid`), 5000);
      await sleep(300);
      const res = await proc2.terminate({ reason: '시험 긴급 정지' });
      await first2.exited;
      expect({ ok: res.ok, remaining: res.remaining }, res.detail).toEqual({ ok: false, remaining: -1 });
      expect(res.detail).toContain('종료를 확인하지 못했습니다');
    }
  }, 120_000);

  /**
   * 실제 도우미이되 failNext(n) 뒤 n번의 넣기는 루트 PID를 열지 못한 것처럼 답하게 한다. 도우미는 루트를 열지 못하면(OpenProcess 실패) 그 루트를 '넣기 전에
   * 끝남(gone)'으로 알린다 — PID 0은 열리지 않으므로 그 길 그대로의 답(빈 작업 개체, 함께 넣은 후손 0)이 나온다. roots: failNext 뒤 넣기마다 돌려준 루트 처지
   */
  function openFails(): JobHelper & { roots: string[]; failNext: (n: number) => void } {
    const real = createJobHelper({ log: () => undefined });
    const roots: string[] = [];
    let left = 0;
    return {
      roots,
      failNext: (n) => {
        left = n;
        roots.length = 0;
      },
      ready: (t) => real.ready(t),
      isReady: () => real.isReady(),
      problem: () => real.problem(),
      onProblem: (cb) => real.onProblem(cb),
      dispose: () => real.dispose(),
      async adopt(pid, window) {
        const h = await real.adopt(left-- > 0 ? 0 : pid, window);
        roots.push(h?.root ?? 'null');
        return h;
      },
    };
  }

  it('도우미가 시작 신호 형태의 루트를 한 번 열지 못해도(gone으로 알림) 러너가 그 끝남을 보지 못했으면 다시 넣는다 — 사슬 전체가 작업 개체 안이라 정지하면 서버까지 끝나고 ok (S7-20 P1)', async () => {
    for (let i = 0; i < 2; i++) {
      const failing = openFails();
      const r = await fresh(failing);
      failing.failNext(1);
      const out = join(root, `gone-once-${i}.pid`);
      const proc = start(r, chainSpec(out, 30, true));
      expect(await serverPid(out, 5000)).not.toBeNull();
      expect(await beating(out), '서버가 돌기 시작했다 (박동)').toBe(true);
      await sleep(300); // 중간 cmd가 끝나 서버가 고아가 됐다
      const res = await proc.terminate({ reason: '시험 긴급 정지' });
      const beat = await beating(out);
      expect({ ok: res.ok, remaining: res.remaining, serverBeating: beat, roots: failing.roots }, res.detail).toEqual({ ok: true, remaining: 0, serverBeating: false, roots: ['gone', 'in'] });
    }
  }, 120_000);

  it('다시 넣어도 루트를 열지 못하면 넣은 것으로 치지 않는다 — 사슬이 작업 개체 밖에서 돌았으니 정지도 스스로 끝남도 종료를 확인하지 못한 것(-1)이다 (예전: 서버가 박동하는데 ok·0, S7-20 P1)', async () => {
    // 정지
    const failing = openFails();
    const r = await fresh(failing);
    failing.failNext(1000);
    const out = join(root, 'gone-stop.pid');
    const proc = start(r, chainSpec(out, 30, true));
    expect(await serverPid(out, 5000), '시작 신호는 그대로 준다 — 검사는 돈다').not.toBeNull();
    await sleep(300);
    const res = await proc.terminate({ reason: '시험 긴급 정지' });
    const beat = await beating(out);
    expect({ ok: res.ok, remaining: res.remaining, roots: failing.roots }, `${res.detail} (서버 박동 ${String(beat)})`).toEqual({ ok: false, remaining: -1, roots: ['gone', 'gone'] });
    expect(res.detail).toContain('실행 중인 프로세스를 작업 개체에 넣지 못했습니다');
    expect(res.detail).toContain('종료를 확인하지 못했습니다');

    // 스스로 끝남
    const out2 = join(root, 'gone-exit.pid');
    const proc2 = start(r, chainSpec(out2, 2, true));
    const info = await proc2.exited;
    expect(await serverPid(out2, 1000)).not.toBeNull();
    expect(info.remaining, info.detail).toBe(-1);
    expect(info.detail).toContain('실행 중인 프로세스를 작업 개체에 넣지 못했습니다');
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
  let out = '';
  afterEach(async () => {
    // 고아 서버는 그만 파일로 끝낸다 (PID로 죽이지 않는다). 하네스를 닫으면 러너가 제가 띄운 검사·턴을 끝낸다
    if (out) quit([out]);
    out = '';
    await h?.close().catch(() => undefined);
    h = null;
    if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
  });

  it('검사를 띄우는 순간 다른 프로세스가 떠도 그 검사가 이중 start로 띄운 서버까지 긴급 정지로 끝나고 완료로 표시된다 (예전: 서버가 남았는데 완료)', async () => {
    dir = await mkdtemp(join(tmpdir(), 'wook-test-adopt-gate-app-'));
    out = join(dir, 'server.pid');
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
        extras.push(orig({ command: process.execPath, args: ['-e', 'setTimeout(() => {}, 1500)'], cwd: dir, env: { ...process.env }, stdinText: null, label: '다른 턴 대역' }));
      }
      return orig(spec);
    };
    await sendCommand(harness, '로그인 화면을 만들어 줘');
    await harness.waitFor(() => harness.core.checks.running.size === 1 && existsSync(out) && readFileSync(out, 'utf8').trim() !== '', { timeoutMs: 150_000, label: '자동 검사의 서버' });
    expect(await beating(out), '서버가 돌기 시작했다 (박동)').toBe(true);
    await sleep(500); // 중간 cmd가 끝나 서버가 고아가 됐다
    const summary = await harness.invoke('stop.emergency');
    const beat = await beating(out, 500);
    expect(summary.completed && beat, '서버가 남았는데 긴급 정지 요약이 완료').toBe(false);
    expect(beat).toBe(false);
    expect(summary.completed).toBe(true);
    for (const p of extras) await p.exited;
  }, 300_000);
});
