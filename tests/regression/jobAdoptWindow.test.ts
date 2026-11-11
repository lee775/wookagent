/**
 * taskkill 대체 러너 + 작업 개체 도우미의 "넣기 전 창" (stage-5 process-sleep 결함 1·2·4, 곁가지 2·5 — AC-29·36, CTL-03·07·11, 15.5).
 * 대체 러너는 CLI를 Node로 띄운 뒤 도우미(Windows PowerShell)에게 작업 개체에 넣어 달라고 한다(ADD). 넣기 전에 CLI의 중간 프로세스가
 * 분리된 개발 서버(고아)를 띄우고 먼저 끝나면 그 고아는 작업 개체 밖에 남는다 — 그런데도 정지·스스로 끝난 실행을 '종료 확인'으로 보고하면 안 된다.
 *  - 새 러너(앱 시작 직후 첫 실행): 러너를 만들 때 도우미를 미리 띄워 두므로 띄우자마자 넣어 고아까지 끝낸다 (예전: 첫 ADD가 PowerShell 시작을 기다려
 *    300ms 뒤에 들어가 고아가 빠졌는데 ok·remaining 0)
 *  - 느린 도우미(넣기가 늦음): 작업 개체가 비어 보여도 종료를 확인하지 못한 것(-1)으로 알린다. 정지가 넣기를 기다리지 못하면 늦게 넣은 작업 개체도
 *    끝내고 닫는다
 *  - PID 재사용: 넣기 전에 이미 끝난 루트의 PID 번호를 쓰던 남의 자식은 넣지 않는다 (시각 여유 1초 → 수십 ms). 넣은 결과(루트·함께 넣은 수)를 알린다
 *  - 재시작 복구의 killTree: 작업 개체 러너가 없으면 트리를 끊어도 종료 확인으로 치지 않는다
 * 실제 PowerShell 도우미와 실제 프로세스로 확인한다 (Windows 전용).
 * 뒷정리 (리드 결정 S5-69): 러너로 띄운 실행과 직접 띄운 자식은 그 핸들로 끝낸다. PID 파일·표준 출력에서 읽은 고아·자식이 이미 끝났어야 하면 끝내지 않고
 * 상한까지 기다리기만 한다 — 끝난 PID는 Windows가 다른 프로세스에 다시 준다. 작업 개체에 들지 않는 고아(느린 도우미 경우)는 사는 시간을 짧게(3초) 주고,
 * 다 끝나기를 기다린 뒤 폴더를 지운다(지우지 못하면 그 오류를 그대로 낸다). 그래서 이 파일만 돌려도 프로세스·폴더가 남지 않는다
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createProcessRunner, JOB_ADOPT_LATE_MS } from '../../src/main/process/processRunner';
import { createJobHelper, type JobHandle, type JobHelper } from '../../src/main/process/jobHelper';
import type { ManagedProcess, ProcessRunner, RunSpec } from '../../src/main/process/types';

const isWin = process.platform === 'win32';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/**
 * 시험이 끝날 때 살아 있어야 하는 우리 고아(살아 있음을 그 시험이 확인한 것)의 그만 파일 — 정리 때 그 파일을 만들면 스스로 끝난다. 예전처럼 기록한 PID로
 * 죽이지 않는다: 시험이 실패해 그 고아가 이미 끝났으면 그 번호는 다른 프로세스가 다시 쓸 수 있다 (S7-20 TI-8)
 */
const quits: string[] = [];
/** 이미 끝났어야 하는 프로세스(PID 파일·표준 출력에서 읽은 고아·자식) — 끝내지 않고 끝나기를 기다리기만 한다 (리드 결정 S5-69) */
const gone = new Set<number>();
/** 러너로 띄운 실행 — 러너가 가진 핸들로 끝낸다 (리드 결정 S5-52.4) */
const procs: ManagedProcess[] = [];
/** 직접 띄운 자식 — 그 핸들로 끝낸다 */
const children: ChildProcess[] = [];

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** 그 PID들이 모두 끝날 때까지 상한(ms)만큼 기다린다 — 끝내지는 않는다. 남은 PID를 돌려준다 */
async function waitGone(pids: Iterable<number>, ms: number): Promise<number[]> {
  const until = Date.now() + ms;
  let left = [...pids].filter(alive);
  while (left.length && Date.now() < until) {
    await sleep(100);
    left = left.filter(alive);
  }
  return left;
}

// 고아(개발 서버 대역): PID를 적고 산다 — 셋째 인자가 사는 시간(ms, 없으면 안전장치 60초) (리드 결정 S5-69)
const SERVER = `require('fs').writeFileSync(process.argv[2], String(process.pid)); setTimeout(() => {}, Number(process.argv[3] || 60000));`;
// 중간 프로세스: 분리된 서버를 띄우고 LAUNCHER_MS 뒤 끝난다 (셸 start /b·이중 fork처럼 곧바로 끝나는 중간). 서버의 사는 시간은 ORPHAN_MS를 넘긴다
const LAUNCHER = `const c = require('child_process').spawn(process.execPath, [process.argv[2], process.argv[3], process.env.ORPHAN_MS || '60000'], { detached: true, stdio: 'ignore', windowsHide: true }); c.unref(); setTimeout(() => process.exit(0), Number(process.env.LAUNCHER_MS || 30));`;
// CLI 대역: 시작하고 CLI_DELAY_MS 뒤 중간 프로세스를 띄운다. STAY_MS 뒤 스스로 끝나거나(0이면) 계속 산다
const CLI = `const { spawn } = require('child_process'); const path = require('path'); const [, , dir, out] = process.argv;
setTimeout(() => spawn(process.execPath, [path.join(dir, 'launcher.cjs'), path.join(dir, 'server.cjs'), out], { stdio: 'ignore', windowsHide: true }), Number(process.env.CLI_DELAY_MS || 0));
const stay = Number(process.env.STAY_MS || 0); if (stay > 0) setTimeout(() => process.exit(0), stay); else setTimeout(() => {}, 60000);`;

/** 실제 도우미 앞에 넣기 지연을 둔다 (바쁜 PC·백신 검사로 ADD가 늦게 들어가는 경우). 늦게 받은 작업 개체 핸들의 끝내기·닫기를 센다 */
function slowHelper(delayMs: number): JobHelper & { lateCalls: string[] } {
  const real = createJobHelper({ log: () => undefined });
  const lateCalls: string[] = [];
  return {
    lateCalls,
    ready: (t) => real.ready(t),
    isReady: () => real.isReady(),
    problem: () => real.problem(),
    onProblem: (cb) => real.onProblem(cb),
    dispose: () => real.dispose(),
    async adopt(pid, window) {
      await sleep(delayMs);
      const h = await real.adopt(pid, window);
      if (!h) return null;
      const wrapped: JobHandle = {
        id: h.id,
        root: h.root,
        swept: h.swept,
        scopeAt: h.scopeAt,
        list: () => h.list(),
        terminate: () => {
          lateCalls.push('terminate');
          return h.terminate();
        },
        close: () => {
          lateCalls.push('close');
          h.close();
        },
      };
      return wrapped;
    },
  };
}

describe.skipIf(!isWin)('taskkill 대체 러너: 작업 개체에 넣기 전 창의 고아 (AC-29·36, CTL-03·11)', () => {
  let root: string;
  const runners: ProcessRunner[] = [];

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'wook-test-adopt-window-'));
    await mkdir(join(root, 'w'), { recursive: true });
    await writeFile(join(root, 'server.cjs'), SERVER);
    await writeFile(join(root, 'launcher.cjs'), LAUNCHER);
    await writeFile(join(root, 'cli.cjs'), CLI);
  });

  afterEach(async () => {
    await Promise.all(procs.splice(0).map((p) => p.terminate({ timeoutMs: 3000 }).catch(() => undefined)));
    for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill();
    for (const q of quits.splice(0)) await writeFile(q, '').catch(() => undefined);
    // 이미 끝났어야 하는 것은 끝내지 않는다 — 상한까지 기다리기만 한다(남으면 그 시험의 단언이 이미 실패했고, 고아는 제 사는 시간에 끝난다)
    await waitGone(gone, 5000);
    gone.clear();
  });

  afterAll(async () => {
    for (const r of runners) r.dispose?.();
    // PID 파일(*.pid)에 적힌 고아가 모두 끝나기를 상한까지 기다린 뒤 지운다 — 끝내지 않는다. 지우지 못하면(아직 그 폴더를 쥔 고아) 그 오류를 그대로 낸다
    const files = (await readdir(root)).filter((f) => f.endsWith('.pid'));
    const pids = (await Promise.all(files.map((f) => readFile(join(root, f), 'utf8')))).map((t) => Number(t.trim())).filter((n) => n > 0);
    await waitGone(pids, 20_000);
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }, 60_000);

  /** 테스트마다 새 러너 — 앱 시작 직후·도우미가 막 뜬 상태의 첫 실행 */
  async function fresh(jobHelper?: JobHelper): Promise<ProcessRunner> {
    const r = await createProcessRunner({ dataDir: join(root, `d${runners.length}`), forceMode: 'taskkill', log: () => undefined, ...(jobHelper ? { jobHelper } : {}) });
    runners.push(r);
    return r;
  }

  function start(runner: ProcessRunner, name: string, env: Record<string, string>): { proc: ManagedProcess; out: string } {
    const out = join(root, `${name}.pid`);
    // CLI 대역이므로 앱이 CLI를 띄우듯 프롬프트를 준다 (러너는 넣은 뒤에 준다). 입력 없이 띄운 실행은 늘 확인 불가(-1)다 — taskkillAdoptGate.test.ts
    const spec: RunSpec = {
      command: process.execPath,
      args: [join(root, 'cli.cjs'), root, out],
      cwd: join(root, 'w'),
      env: { ...process.env, ...env },
      stdinText: '프롬프트',
      label: `시험 ${name}`,
    };
    const proc = runner.start(spec);
    procs.push(proc);
    return { proc, out };
  }

  /** 고아가 적은 PID — 끝내지 않는다: 작업 개체가 끝냈거나 제 사는 시간에 끝난다 (리드 결정 S5-69) */
  async function orphanPid(file: string): Promise<number> {
    const until = Date.now() + 10_000;
    while (Date.now() < until) {
      if (existsSync(file)) {
        const t = (await readFile(file, 'utf8')).trim();
        if (t) {
          const pid = Number(t);
          gone.add(pid);
          return pid;
        }
      }
      await sleep(10);
    }
    throw new Error(`고아 PID 없음: ${file}`);
  }

  it('새 러너의 첫 실행: 띄운 직후 중간 프로세스가 고아를 남기고 30ms 뒤 끝나도 정지(terminate)는 고아까지 끝내고, 고아가 남았는데 종료 확인이라 하지 않는다', async () => {
    for (let i = 0; i < 2; i++) {
      const runner = await fresh();
      const { proc, out } = start(runner, `stop${i}`, { CLI_DELAY_MS: '50', LAUNCHER_MS: '30', STAY_MS: '0' });
      const orphan = await orphanPid(out);
      await sleep(400); // 중간 프로세스가 먼저 끝나 고아가 됐다
      const res = await proc.terminate({ reason: '시험 긴급 정지' });
      await sleep(300);
      expect({ ok: res.ok, remaining: res.remaining, orphanAlive: alive(orphan) }, res.detail).toEqual({ ok: true, remaining: 0, orphanAlive: false });
    }
  }, 60_000);

  it('새 러너의 첫 실행: 스스로 끝난 CLI가 남긴 고아는 작업 개체로 정리되고, 고아가 남았는데 remaining 0이라 하지 않는다', async () => {
    for (let i = 0; i < 2; i++) {
      const runner = await fresh();
      const { proc, out } = start(runner, `exit${i}`, { CLI_DELAY_MS: '50', LAUNCHER_MS: '30', STAY_MS: '800' });
      const orphan = await orphanPid(out);
      const info = await proc.exited;
      await sleep(300);
      expect({ remaining: info.remaining, orphanAlive: alive(orphan) }, info.detail).toEqual({ remaining: 0, orphanAlive: false });
      expect(info.leftoverKilled).toBeGreaterThanOrEqual(1);
    }
  }, 60_000);

  it(`도우미가 늦게 넣으면(${JOB_ADOPT_LATE_MS}ms 넘게) 작업 개체가 비어 보여도 정지·스스로 끝남 모두 종료를 확인하지 못한 것(-1)으로 알린다`, async () => {
    const runner = await fresh(slowHelper(1500));
    // 정지: 늦은 넣기가 끝난 뒤 (예전: 빈 작업 개체를 보고 ok·remaining 0, 고아는 남음). 고아는 작업 개체 밖이라 사는 시간을 짧게 준다 (리드 결정 S5-69)
    const a = start(runner, 'slow-stop', { CLI_DELAY_MS: '0', LAUNCHER_MS: '30', STAY_MS: '0', ORPHAN_MS: '3000' });
    await orphanPid(a.out);
    await sleep(2500);
    const res = await a.proc.terminate({ reason: '시험 긴급 정지' });
    expect({ ok: res.ok, remaining: res.remaining }).toEqual({ ok: false, remaining: -1 });
    expect(res.detail).toContain('뒤에야 작업 개체에 넣었습니다');
    expect(res.detail).toContain('종료를 확인하지 못했습니다');
    // 스스로 끝남
    const b = start(runner, 'slow-exit', { CLI_DELAY_MS: '0', LAUNCHER_MS: '30', STAY_MS: '2500', ORPHAN_MS: '3000' });
    await orphanPid(b.out);
    const info = await b.proc.exited;
    expect(info.remaining).toBe(-1);
    expect(info.detail).toContain('뒤에야 작업 개체에 넣었습니다');
  }, 60_000);

  it('정지가 작업 개체에 넣기를 기다리지 못하고 지나가면, 늦게 넣은 작업 개체도 끝내고 핸들을 닫는다 (예전: 닫지 않음)', async () => {
    const helper = slowHelper(1500);
    const runner = await fresh(helper);
    // 늦은 작업 개체에 들지 않는 고아는 3초 뒤 스스로 끝난다 — afterAll이 그 PID 파일(late-handle.pid)로 끝나기를 기다린 뒤 폴더를 지운다 (리드 결정 S5-69)
    const { proc } = start(runner, 'late-handle', { CLI_DELAY_MS: '0', LAUNCHER_MS: '30', STAY_MS: '0', ORPHAN_MS: '3000' });
    await sleep(200);
    const res = await proc.terminate({ reason: '시험 정지' });
    expect({ ok: res.ok, remaining: res.remaining }).toEqual({ ok: false, remaining: -1 });
    const until = Date.now() + 5000;
    while (Date.now() < until && !helper.lateCalls.includes('close')) await sleep(25);
    expect(helper.lateCalls).toEqual(['terminate', 'close']);
  }, 60_000);

  it('준비된 도우미는 첫 넣기도 곧바로 한다 — 첫 실행 준비(함수·P/Invoke, 약 0.1초)를 준비 전에 마쳐 다시 뜬 도우미의 넣기 전 창이 수십 ms를 넘지 않는다', async () => {
    const firsts: number[] = [];
    for (let i = 0; i < 3; i++) {
      const helper = createJobHelper({ log: () => undefined });
      try {
        expect(await helper.ready(15_000)).toBe(true);
        const t0 = Date.now();
        const c = spawn(process.execPath, ['-e', 'setTimeout(()=>{},5000)'], { stdio: 'ignore', windowsHide: true });
        children.push(c);
        const h = await helper.adopt(c.pid!, { notBefore: t0, notAfter: Date.now() });
        expect(h?.root).toBe('in');
        firsts.push(h!.scopeAt - t0);
        await h!.terminate();
        h!.close();
      } finally {
        helper.dispose();
      }
    }
    // 예전: 다시 뜬 도우미의 첫 넣기는 80~95ms (부하) — 그 사이 Node 중간 프로세스가 고아를 남기고 끝날 수 있었다
    expect(Math.min(...firsts), JSON.stringify(firsts)).toBeLessThan(40);
  }, 60_000);

  it('PID 재사용: 넣기 전에 끝난 루트의 PID 번호를 쓰던 남의 프로세스의 자식은 넣지도 끝내지도 않는다 (예전: 1초 여유로 넣고 정리 때 끝냄)', async () => {
    const helper = createJobHelper({ log: () => undefined });
    try {
      expect(await helper.ready(15_000)).toBe(true);
      // P: 분리된 C를 띄우고 C의 PID를 알린 뒤 끝난다 (C의 부모 PID 칸 = P의 PID)
      // C는 그만 파일(quit)이 생기면 스스로 끝난다 — 정리는 C의 PID로 죽이지 않는다 (S7-20 TI-8)
      const quitFile = join(root, `pidreuse-${Date.now()}.quit`);
      quits.push(quitFile);
      const pCode = `const c=require('child_process').spawn(process.execPath,['-e',"const f=require('fs');const q=process.argv[1];setInterval(()=>{if(f.existsSync(q))process.exit(0)},100);setTimeout(()=>process.exit(0),60000)",process.argv[1]],{detached:true,stdio:'ignore',windowsHide:true});c.unref();process.stdout.write(String(c.pid))`;
      const p = spawn(process.execPath, ['-e', pCode, quitFile], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
      let out = '';
      p.stdout.setEncoding('utf8');
      p.stdout.on('data', (d: string) => (out += d));
      await new Promise((r) => p.on('close', r));
      const tC = Date.now(); // C가 생긴 뒤
      const cPid = Number(out);
      // C는 이 시험이 끝날 때 살아 있어야 한다(아래에서 확인) — 끝낼 때는 그만 파일로 끝낸다
      await sleep(100);
      // 우리 CLI가 P의 PID 번호를 받아 C보다 800ms 늦게 떴고 넣기 전에 끝났다고 친다 — C는 우리 CLI보다 먼저 생긴 남의 프로세스다
      const h = await helper.adopt(p.pid!, { notBefore: tC + 800, notAfter: tC + 810 });
      expect(h).not.toBeNull();
      expect(await h!.list()).not.toContain(cPid);
      await h!.terminate();
      await sleep(300);
      expect(alive(cPid)).toBe(true);
      expect(h!.root).not.toBe('in');
      expect(h!.swept).toBe(0);
      h!.close();
    } finally {
      helper.dispose();
    }
  }, 60_000);

  it('넣은 결과를 알린다: 살아 있는 루트는 넣고(in), 넣기 전에 이미 생긴 자식은 함께 넣은 수로, 목록 시각은 띄운 뒤', async () => {
    const helper = createJobHelper({ log: () => undefined });
    try {
      expect(await helper.ready(15_000)).toBe(true);
      const notBefore = Date.now();
      const q = spawn(process.execPath, ['-e', "const c=require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:'ignore',windowsHide:true});process.stdout.write(String(c.pid));setTimeout(()=>{},60000)"], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
      const notAfter = Date.now();
      children.push(q);
      let out = '';
      q.stdout.setEncoding('utf8');
      await new Promise<void>((r) => q.stdout.on('data', (d: string) => ((out += d), r())));
      const child = Number(out);
      gone.add(child);
      const h = await helper.adopt(q.pid!, { notBefore, notAfter });
      expect(h).not.toBeNull();
      expect(h!.root).toBe('in');
      // 함께 넣은 수에는 자식의 콘솔 호스트(conhost.exe)도 들 수 있다
      expect(h!.swept).toBeGreaterThanOrEqual(1);
      expect(h!.scopeAt).toBeGreaterThanOrEqual(notBefore);
      expect(h!.scopeAt).toBeLessThanOrEqual(Date.now());
      expect(await h!.list()).toEqual(expect.arrayContaining([q.pid!, child]));
      await h!.terminate();
      h!.close();
    } finally {
      helper.dispose();
    }
  }, 60_000);

  it('재시작 복구의 killTree: 작업 개체 러너가 없는 taskkill 방식은 트리를 끊어도 종료 확인으로 치지 않는다 (ok=false, -1)', async () => {
    const runner = await fresh();
    const tree = spawn(process.execPath, ['-e', "const c=require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:'ignore',windowsHide:true});process.stdout.write(String(c.pid));setTimeout(()=>{},60000)"], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
    children.push(tree);
    let out = '';
    tree.stdout.setEncoding('utf8');
    await new Promise<void>((r) => tree.stdout.on('data', (d: string) => ((out += d), r())));
    const child = Number(out);
    gone.add(child);
    const r = await runner.killTree(tree.pid!);
    expect({ ok: r.ok, remaining: r.remaining }).toEqual({ ok: false, remaining: -1 });
    expect(r.detail).toContain('부모가 먼저 끝난 후손은 확인할 수 없습니다');
    await sleep(300);
    expect([tree.pid!, child].filter(alive)).toEqual([]); // 트리 자체는 끊었다
  }, 60_000);
});
