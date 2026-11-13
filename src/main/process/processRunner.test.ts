import { execFileSync, spawn, spawnSync, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { RUNNER_PROTOCOL_VERSION, runnerPaths } from './compileRunner';
import { createJobHelper } from './jobHelper';
import { createProcessRunner, lineSplitter, LINUX_SWEEP_LIMIT, PacedReader, processLiveness, READ_SLICE_LINES, READ_SLICE_MS, type RunnerLog } from './processRunner';
import { environHas, readProcStat, RUN_TAG_ENV } from './procfs';
import { createFakeProcRoot } from './__fixtures__/fakeProcRoot';
import type { ManagedProcess, ProcessRunner, RunSpec } from './types';

const isWin = process.platform === 'win32';
const fixturesDir = fileURLToPath(new URL('./__fixtures__/', import.meta.url));
const echoFixture = join(fixturesDir, 'echo.mjs');
const treeFixture = join(fixturesDir, 'tree.mjs');
const outputFixture = join(fixturesDir, 'output.mjs');
const runnerSource = fileURLToPath(new URL('../../../resources/jobrunner/JobRunner.cs', import.meta.url));

/**
 * 테스트가 중간에 실패해도 프로세스를 남기지 않도록 끝에 정리한다 (killLeftovers). 기록한 PID로는 죽이지 않는다 — 끝난 프로세스의 번호는 다른 프로세스(다른
 * 시험의 자식·대표의 프로그램)가 곧 다시 쓴다 (리드 결정 S7-20 TI-8). seenPids는 끝나기를 기다리기만 하는 번호다
 */
const seenPids = new Set<number>();
/** 러너로 띄운 실행 — 러너가 가진 핸들로 끝낸다 */
const liveProcs: ManagedProcess[] = [];
/** 이 시험이 직접 띄운 자식 — 그 핸들로, 끝나지 않았을 때만 끝낸다 */
const liveChildren: ChildProcess[] = [];
/** 후손(tree.mjs의 sleeper·고아)은 이 차례의 그만 파일(WOOK_TREE_QUIT)이 생기면 스스로 끝난다 — 정리할 때마다 새 경로로 바꾼다 */
let quitGen = 0;
const quitPath = (): string => join(tmpdir(), `wook-test-tree-quit-${process.pid}-${quitGen}`);
process.env.WOOK_TREE_QUIT = quitPath();
const timings: Record<string, number[]> = {};

function record(name: string, value: number): void {
  (timings[name] ??= []).push(Math.round(value));
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function stillAliveAfter(pids: number[], timeoutMs: number): Promise<number[]> {
  const deadline = performance.now() + timeoutMs;
  let rest = pids.filter(alive);
  while (rest.length > 0 && performance.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
    rest = rest.filter(alive);
  }
  return rest;
}

async function killLeftovers(): Promise<void> {
  const quit = quitPath();
  await writeFile(quit, '').catch(() => undefined);
  quitGen += 1;
  process.env.WOOK_TREE_QUIT = quitPath();
  await Promise.all(liveProcs.splice(0).map((p) => p.terminate({ timeoutMs: 3000, reason: '시험 정리' }).catch(() => undefined)));
  for (const c of liveChildren.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill();
  // 끝내지 않고 끝나기를 잠깐 기다리기만 한다 (그 번호를 다른 프로세스가 다시 쓰고 있으면 상한까지 기다릴 뿐이다)
  await stillAliveAfter([...seenPids], 1500);
  seenPids.clear();
  await rm(quit, { force: true }).catch(() => undefined);
}

afterAll(async () => {
  await killLeftovers();
  console.log(`[프로세스 러너 타이밍 ms] ${JSON.stringify(timings)}`);
});

interface Collected {
  proc: ManagedProcess;
  out: string[];
  err: string[];
  waitLine(pred: (line: string) => boolean, timeoutMs?: number): Promise<string>;
}

function startCollect(runner: ProcessRunner, spec: RunSpec): Collected {
  const proc = runner.start(spec);
  const out: string[] = [];
  const err: string[] = [];
  const waiters: Array<{ pred: (line: string) => boolean; done: (line: string) => void }> = [];
  proc.onStdoutLine((line) => {
    out.push(line);
    for (const w of [...waiters]) {
      if (w.pred(line)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.done(line);
      }
    }
  });
  proc.onStderrLine((line) => err.push(line));
  liveProcs.push(proc);
  if (proc.pid !== null) seenPids.add(proc.pid);
  void proc.childPid.then((pid) => {
    if (pid !== null) seenPids.add(pid);
  });
  return {
    proc,
    out,
    err,
    waitLine(pred, timeoutMs = 15_000) {
      const hit = out.find(pred);
      if (hit !== undefined) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`줄을 기다리다 시간 초과. 받은 줄: ${JSON.stringify(out)} / stderr: ${JSON.stringify(err)}`)), timeoutMs);
        waiters.push({
          pred,
          done: (line) => {
            clearTimeout(timer);
            resolve(line);
          },
        });
      });
    },
  };
}

/** tree.mjs가 알린 [부모, ...후손] PID */
async function treeOf(c: Collected): Promise<number[]> {
  const line = await c.waitLine((l) => l.startsWith('{"tree"'));
  const parsed = JSON.parse(line) as { tree: number[]; self: number };
  const pids = [parsed.self, ...parsed.tree];
  for (const pid of pids) seenPids.add(pid);
  return pids;
}

function nodeSpec(cwd: string, args: string[], extra: Partial<RunSpec> = {}): RunSpec {
  return { command: process.execPath, args, cwd, env: { ...process.env }, stdinText: null, label: '테스트', ...extra };
}

function envWithPathPrefix(prefix: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  let pathValue = '';
  for (const [key, value] of Object.entries(process.env)) {
    if (key.toUpperCase() === 'PATH') pathValue = value ?? '';
    else env[key] = value;
  }
  env.Path = `${prefix};${pathValue}`;
  return env;
}

function runTaskkill(args: string[]): Promise<number | null> {
  return new Promise((resolve) => {
    const c = spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), args, { windowsHide: true });
    c.stdout.resume();
    c.stderr.resume();
    c.on('close', resolve);
  });
}

function lineReader(stream: Readable): { all: string[]; wait(pred: (l: string) => boolean): Promise<string> } {
  const decoder = new StringDecoder('utf8');
  const all: string[] = [];
  let buf = '';
  const waiters: Array<{ pred: (l: string) => boolean; done: (l: string) => void }> = [];
  stream.on('data', (chunk: Buffer) => {
    buf += decoder.write(chunk);
    let nl: number;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      all.push(line);
      for (const w of [...waiters]) {
        if (w.pred(line)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.done(line);
        }
      }
    }
  });
  return {
    all,
    wait(pred) {
      const hit = all.find(pred);
      if (hit !== undefined) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`줄 대기 시간 초과: ${JSON.stringify(all)}`)), 15_000);
        waiters.push({
          pred,
          done: (l) => {
            clearTimeout(timer);
            resolve(l);
          },
        });
      });
    },
  };
}

describe.skipIf(!isWin)('jobobject 방식 (Windows Job Object 러너)', () => {
  let root: string;
  let dataDir: string;
  let workDir: string;
  let runner: ProcessRunner;
  const logs: Array<[string, string]> = [];
  const log: RunnerLog = (level, msg) => {
    logs.push([level, msg]);
  };

  beforeAll(async () => {
    // 공백·한글이 든 경로: 러너 exe·작업 폴더·표준 입력 파일 모두 이 아래
    root = await mkdtemp(join(tmpdir(), 'wook-test-프로세스 러너 '));
    dataDir = join(root, '앱 데이터');
    workDir = join(root, '작업 폴더 (한글)');
    await mkdir(workDir, { recursive: true });
    const t0 = performance.now();
    runner = await createProcessRunner({ dataDir, forceMode: 'jobobject', runnerSource, log });
    record('createProcessRunner(컴파일+확인)', performance.now() - t0);
  });

  afterEach(() => killLeftovers());

  afterAll(async () => {
    await killLeftovers();
    // Windows: 방금 끝낸 프로세스(그 콘솔 호스트 conhost.exe 포함)가 작업 폴더를 잠깐 더 잡고 있을 수 있다 — 다른 시험 정리와 같게 다시 시도
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it('러너가 준비되어 jobobject 방식으로 동작한다', () => {
    expect(runner.mode).toBe('jobobject');
    expect(runner.detail).toContain('WookJobRunner.exe');
  });

  it('한국어 표준 입력 왕복, 까다로운 인자, 환경 변수, 작업 폴더, 종료 코드', async () => {
    const stdinText = '안녕하세요, 욱채입니다 🙂\n둘째 줄\r\n셋째 줄 "따옴표" \\역슬래시\\';
    const tricky = [
      '',
      'a b',
      'a"b',
      'a\\',
      'a\\\\"b',
      '한글 인자',
      'C:\\path with space\\',
      '\\\\server\\share',
      'tab\there',
      '{"json":"x"}',
      '"',
      '\\"',
      'end\\\\',
    ];
    const t0 = performance.now();
    const c = startCollect(
      runner,
      nodeSpec(workDir, [echoFixture, ...tricky], {
        stdinText,
        env: { ...process.env, WOOK_FIXTURE_EXIT: '7', WOOK_FIXTURE_VALUE: '환경 값' },
      }),
    );
    const info = await c.proc.exited;
    record('echo 왕복 시작→exited', performance.now() - t0);
    expect(c.err).toEqual([]);
    expect(c.out).toHaveLength(1);
    const reply = JSON.parse(c.out[0]) as { stdin: string; argv: string[]; cwd: string; env: string; pid: number };
    expect(reply.stdin).toBe(stdinText);
    expect(reply.argv).toEqual(tricky);
    expect(reply.cwd).toBe(workDir);
    expect(reply.env).toBe('환경 값');
    expect(await c.proc.childPid).toBe(reply.pid);
    expect(c.proc.pid).not.toBe(reply.pid);
    expect(info).toMatchObject({ code: 7, signal: null, leftoverKilled: 0, remaining: 0, terminated: false });
    expect(await readdir(join(dataDir, 'tmp', 'stdin'))).toEqual([]);
  });

  it('stdinText가 null이면 자식의 표준 입력이 바로 닫힌다', async () => {
    const c = startCollect(runner, nodeSpec(workDir, [echoFixture]));
    const info = await c.proc.exited;
    expect(JSON.parse(c.out[0]).stdin).toBe('');
    expect(info.code).toBe(0);
  });

  it('표준 입력 임시 파일은 자식이 시작되면(실행 중에도) 지워진다', async () => {
    const c = startCollect(runner, nodeSpec(workDir, [treeFixture, '0', 'stay'], { stdinText: '지울 내용' }));
    await treeOf(c);
    expect(await readdir(join(dataDir, 'tmp', 'stdin'))).toEqual([]);
    expect((await c.proc.terminate()).ok).toBe(true);
  });

  it('부모가 끝나며 남긴 후손 2개를 정리한다 (파이프를 물고 있어도)', async () => {
    for (const variant of [[], ['hold']]) {
      const t0 = performance.now();
      const c = startCollect(runner, nodeSpec(workDir, [treeFixture, '2', 'exit', ...variant]));
      const pids = await treeOf(c);
      const info = await c.proc.exited;
      record(`남은 후손 정리 시작→exited (${variant[0] ?? 'ignore'})`, performance.now() - t0);
      expect(info).toMatchObject({ code: 0, leftoverKilled: 2, remaining: 0, terminated: false });
      expect(pids.slice(1).filter(alive)).toEqual([]);
      expect(c.out.filter((l) => l.startsWith('{"__wookRunner"'))).toEqual([]);
    }
  });

  it('terminate(): 부모·후손·고아(중간 부모가 먼저 끝난 후손)까지 3초 안에 모두 종료', async () => {
    const c = startCollect(runner, nodeSpec(workDir, [treeFixture, '2', 'stay', 'orphan', 'hold']));
    const pids = await treeOf(c);
    expect(pids).toHaveLength(4);
    expect(pids.filter(alive)).toEqual(pids);
    const t0 = performance.now();
    const result = await c.proc.terminate({ reason: '테스트 종료' });
    record('terminate() jobobject (부모+후손3)', performance.now() - t0);
    expect(result).toMatchObject({ ok: true, remaining: 0 });
    expect(result.durationMs).toBeLessThan(3000);
    expect(pids.filter(alive)).toEqual([]);
    const info = await c.proc.exited;
    expect(info).toMatchObject({ code: null, signal: 'SIGKILL', leftoverKilled: 0, remaining: 0, terminated: true });
    expect(c.out.filter((l) => l.startsWith('{"__wookRunner"'))).toEqual([]);
  });

  it('terminate()를 시작 직후(자식이 뜨기 전) 불러도 정리된다', async () => {
    const c = startCollect(runner, nodeSpec(workDir, [treeFixture, '2', 'stay'], { stdinText: '입력' }));
    const t0 = performance.now();
    const result = await c.proc.terminate();
    record('terminate() 시작 직후', performance.now() - t0);
    expect(result).toMatchObject({ ok: true, remaining: 0 });
    const info = await c.proc.exited;
    expect(info.terminated).toBe(true);
    const childPid = await c.proc.childPid;
    if (childPid !== null) expect(alive(childPid)).toBe(false);
    expect(await readdir(join(dataDir, 'tmp', 'stdin'))).toEqual([]);
  });

  it('terminate()를 여러 번 불러도 같은 약속·같은 결과', async () => {
    const c = startCollect(runner, nodeSpec(workDir, [treeFixture, '1', 'stay']));
    await treeOf(c);
    const first = c.proc.terminate();
    const second = c.proc.terminate({ timeoutMs: 10 });
    expect(second).toBe(first);
    const [a, b] = await Promise.all([first, second]);
    expect(b).toBe(a);
    expect(a.ok).toBe(true);
    await c.proc.exited;
    expect(c.proc.terminate()).toBe(first);
  });

  it('러너가 제한 시간 안에 보고하지 않으면 taskkill로 러너째 끊고 ok=false로 알린다', async () => {
    const c = startCollect(runner, nodeSpec(workDir, [treeFixture, '2', 'stay', 'hold']));
    const pids = await treeOf(c);
    const result = await c.proc.terminate({ timeoutMs: 0 });
    expect(result.ok).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.detail).toContain('보고하지 않아 taskkill /T /F로 러너를 강제 종료했습니다');
    expect(await stillAliveAfter(pids, 2000)).toEqual([]);
    const info = await c.proc.exited;
    expect(info.terminated).toBe(true);
  });

  it('긴급 정지처럼 5개 트리를 동시에 끝내도 모두 3초 안에 확인된다 (CTL-03)', async () => {
    const all = Array.from({ length: 5 }, () => startCollect(runner, nodeSpec(workDir, [treeFixture, '2', 'stay', 'orphan'])));
    const pids = (await Promise.all(all.map(treeOf))).flat();
    expect(pids.filter(alive)).toHaveLength(20);
    const t0 = performance.now();
    const results = await Promise.all(all.map((c) => c.proc.terminate({ reason: '긴급 정지' })));
    record('동시 terminate 5개 트리(20개 프로세스)', performance.now() - t0);
    expect(results.every((r) => r.ok && r.remaining === 0)).toBe(true);
    expect(performance.now() - t0).toBeLessThan(3000);
    expect(pids.filter(alive)).toEqual([]);
  });

  it('환경 변수를 거의 주지 않아도 실행된다 (필수 Windows 변수는 Node가 채움)', async () => {
    const c = startCollect(runner, nodeSpec(workDir, [echoFixture], { env: { WOOK_FIXTURE_VALUE: '최소 환경' }, stdinText: 'x' }));
    const info = await c.proc.exited;
    expect(c.err).toEqual([]);
    expect(info.code).toBe(0);
    expect(JSON.parse(c.out[0]).env).toBe('최소 환경');
  });

  it('이미 끝난 프로세스의 terminate()는 바로 ok', async () => {
    const c = startCollect(runner, nodeSpec(workDir, [echoFixture]));
    await c.proc.exited;
    const result = await c.proc.terminate();
    expect(result).toMatchObject({ ok: true, remaining: 0 });
    expect(result.durationMs).toBeLessThan(50);
  });

  it('러너만 taskkill /F로 강제 종료해도 job 핸들이 닫혀 후손이 모두 끝난다', async () => {
    const c = startCollect(runner, nodeSpec(workDir, [treeFixture, '2', 'stay', 'orphan']));
    const pids = await treeOf(c);
    const runnerPid = c.proc.pid;
    expect(runnerPid).not.toBeNull();
    const t0 = performance.now();
    expect(await runTaskkill(['/PID', String(runnerPid), '/F'])).toBe(0); // /T 없이 러너 하나만
    const info = await c.proc.exited;
    const left = await stillAliveAfter(pids, 3000);
    record('러너 강제 종료→트리 소멸', performance.now() - t0);
    expect(left).toEqual([]);
    expect(info).toMatchObject({ code: null, remaining: -1, terminated: false });
    expect(c.err.some((l) => l.includes('종료 보고 없이'))).toBe(true);
  });

  it('러너 stdin이 닫히면(앱 비정상 종료) 트리 전체를 끝내고 terminated 줄을 쓴다', async () => {
    const exe = runnerPaths(dataDir).exePath;
    const child: ChildProcessWithoutNullStreams = spawn(exe, ['--', process.execPath, treeFixture, '2', 'stay', 'orphan'], {
      cwd: workDir,
      windowsHide: true,
    });
    liveChildren.push(child);
    if (child.pid !== undefined) seenPids.add(child.pid);
    child.stderr.resume();
    const lines = lineReader(child.stdout);
    const tree = JSON.parse(await lines.wait((l) => l.startsWith('{"tree"'))) as { tree: number[]; self: number };
    const pids = [tree.self, ...tree.tree];
    for (const pid of pids) seenPids.add(pid);
    expect(JSON.parse(lines.all[0])).toEqual({ __wookRunner: 'started', pid: tree.self });
    const closed = new Promise<number | null>((resolve) => child.on('close', resolve));
    const t0 = performance.now();
    child.stdin.destroy();
    const code = await closed;
    record('stdin 닫힘→러너 종료', performance.now() - t0);
    expect(lines.all.at(-1)).toBe('{"__wookRunner":"terminated","remaining":0}');
    expect(code).toBe(1);
    expect(pids.filter(alive)).toEqual([]);
  });

  it('요청하지 않은 terminated(러너 stdin 끊김)는 terminated=false·SIGKILL로 알린다 (비정상 종료로 처리되게)', async () => {
    const c = startCollect(runner, nodeSpec(workDir, [treeFixture, '1', 'stay']));
    const pids = await treeOf(c);
    // 내부 접근: 앱 쪽 파이프가 끊긴 상황을 흉내 낸다
    (c.proc as unknown as { child: ChildProcessWithoutNullStreams }).child.stdin.destroy();
    const info = await c.proc.exited;
    expect(info).toMatchObject({ code: null, signal: 'SIGKILL', remaining: 0, terminated: false });
    expect(pids.filter(alive)).toEqual([]);
  });

  it('러너 --probe와 잘못된 사용법', async () => {
    const exe = runnerPaths(dataDir).exePath;
    const run = (args: string[]): Promise<{ code: number | null; out: string; err: string }> =>
      new Promise((resolve) => {
        const child = spawn(exe, args, { windowsHide: true });
        child.stdin.end();
        let out = '';
        let err = '';
        child.stdout.setEncoding('utf8').on('data', (d: string) => (out += d));
        child.stderr.setEncoding('utf8').on('data', (d: string) => (err += d));
        child.on('close', (code) => resolve({ code, out, err }));
      });
    const probe = await run(['--probe']);
    expect(probe.code).toBe(0);
    expect(JSON.parse(probe.out)).toMatchObject({ __wookRunner: 'probe', ok: true, version: RUNNER_PROTOCOL_VERSION });
    expect(RUNNER_PROTOCOL_VERSION).toBe(2); // 2 = --verbatim-args (windows:F4)
    const usage = await run(['--stdin-file']);
    expect(usage.code).toBe(2);
    expect(usage.out).toBe('{"__wookRunner":"exit","code":-1,"leftover":0,"remaining":0}\n');
    expect(usage.err).toContain('--stdin-file 뒤에 파일 경로가 없습니다');
  });

  it('1MB 한 줄과 여러 조각(한글 바이트 중간, CRLF 경계)으로 나뉜 줄이 그대로 도착한다', async () => {
    const t0 = performance.now();
    const big = startCollect(runner, nodeSpec(workDir, [outputFixture, 'big']));
    expect((await big.proc.exited).code).toBe(0);
    record('1MiB 줄 시작→exited', performance.now() - t0);
    expect(big.out).toHaveLength(2);
    expect(big.out[0].length).toBe(1024 * 1024);
    expect(big.out[0] === '0123456789abcdef'.repeat(65536)).toBe(true);
    expect(big.out[1]).toBe('끝');

    const chunks = startCollect(runner, nodeSpec(workDir, [outputFixture, 'chunks']));
    expect((await chunks.proc.exited).code).toBe(0);
    expect(chunks.out).toEqual(['part1-한글-tail', 'second', 'third', 'no-newline-at-end']);
  });

  it('stderr 줄: CRLF 제거, 마지막 줄바꿈 없는 줄도 전달', async () => {
    const c = startCollect(runner, nodeSpec(workDir, [outputFixture, 'stderr']));
    const info = await c.proc.exited;
    expect(info.code).toBe(1);
    expect(c.err).toEqual(['오류 줄 1', '오류 줄 2']);
    expect(c.out).toEqual([]);
  });

  it('러너 제어 줄은 전달하지 않고, 자식이 흉내 낸 제어 줄은 자식 출력으로 그대로 전달한다', async () => {
    const c = startCollect(runner, nodeSpec(workDir, [outputFixture, 'spoof']));
    const info = await c.proc.exited;
    expect(c.out).toEqual([
      '{"__wookRunner":"started","pid":1}',
      '{"__wookRunner":"exit","code":5,"leftover":9,"remaining":9}',
      'after',
      '{"__wookRunner":"terminated","remaining":7}',
    ]);
    expect(info).toMatchObject({ code: 3, leftoverKilled: 0, remaining: 0, terminated: false });
    expect(await c.proc.childPid).not.toBe(1);
  });

  it('없는 실행 파일: 곧바로 종료 코드 -1 (멈추지 않음)', async () => {
    const t0 = performance.now();
    const c = startCollect(runner, nodeSpec(workDir, [], { command: 'C:\\없는 폴더\\nothere.exe' }));
    const info = await c.proc.exited;
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(info).toMatchObject({ code: -1, leftoverKilled: 0, remaining: 0, terminated: false });
    expect(c.proc.pid).toBeNull();
    expect(await c.proc.childPid).toBeNull();
    expect(c.err.join('\n')).toContain('실행 파일을 찾을 수 없습니다');
    expect((await c.proc.terminate()).ok).toBe(true);
  });

  it('러너가 자식을 띄우지 못하면(올바른 exe가 아님) exit -1과 러너 오류 줄', async () => {
    const fake = join(workDir, '가짜 실행.exe');
    await writeFile(fake, '실행 파일이 아닙니다');
    const c = startCollect(runner, nodeSpec(workDir, ['x'], { command: fake }));
    const info = await c.proc.exited;
    expect(info).toMatchObject({ code: -1, leftoverKilled: 0, remaining: 0, terminated: false });
    expect(await c.proc.childPid).toBeNull();
    expect(c.out).toEqual([]);
    expect(c.err.some((l) => l.startsWith('[WookJobRunner] 실행하지 못했습니다'))).toBe(true);
  });

  it('.cmd·.bat은 거부하고, PATH 이름은 .exe로 찾아 실행한다', async () => {
    const batch = startCollect(runner, nodeSpec(workDir, [], { command: 'C:\\도구\\run.cmd' }));
    expect((await batch.proc.exited).code).toBe(-1);
    expect(batch.err[0]).toContain('배치 파일');

    const byName = startCollect(
      runner,
      nodeSpec(workDir, [echoFixture], { command: 'node', env: envWithPathPrefix(dirname(process.execPath)) }),
    );
    expect((await byName.proc.exited).code).toBe(0);
    expect(byName.out).toHaveLength(1);
  });

  it('작업 폴더가 없으면 곧바로 실패', async () => {
    const c = startCollect(runner, nodeSpec(join(root, '없는 폴더'), [echoFixture]));
    expect((await c.proc.exited).code).toBe(-1);
    expect(c.err[0]).toContain('작업 폴더가 없습니다');
  });

  it('줄 처리기가 오류를 던져도 다른 처리기와 종료 처리는 계속된다', async () => {
    const proc = runner.start(nodeSpec(workDir, [outputFixture, 'chunks']));
    proc.onStdoutLine(() => {
      throw new Error('처리기 오류');
    });
    const lines: string[] = [];
    proc.onStdoutLine((l) => lines.push(l));
    await proc.exited;
    expect(lines).toHaveLength(4);
    expect(logs.some(([level, msg]) => level === 'error' && msg.includes('줄 처리기 오류'))).toBe(true);
  });

  it('isAlive·killTree: 러너 밖에서 띄운 트리도 끝낸다 (재시작 복구)', async () => {
    const parent = spawn(process.execPath, [treeFixture, '2', 'stay'], { cwd: workDir, windowsHide: true });
    if (parent.pid === undefined) throw new Error('부모를 띄우지 못함');
    liveChildren.push(parent);
    seenPids.add(parent.pid);
    parent.stderr.resume();
    const tree = JSON.parse(await lineReader(parent.stdout).wait((l) => l.startsWith('{"tree"'))) as { tree: number[] };
    for (const pid of tree.tree) seenPids.add(pid);
    expect(await runner.isAlive(parent.pid)).toBe(true);
    const t0 = performance.now();
    const result = await runner.killTree(parent.pid);
    record('killTree (taskkill /T, 부모+후손2)', performance.now() - t0);
    expect(result).toMatchObject({ ok: true, remaining: 0 });
    expect(await runner.isAlive(parent.pid)).toBe(false);
    expect(tree.tree.filter(alive)).toEqual([]);
    expect(await runner.killTree(parent.pid)).toMatchObject({ ok: true, remaining: 0 });
    expect(await runner.killTree(process.pid)).toMatchObject({ ok: false });
    expect(await runner.killTree(0)).toMatchObject({ ok: false });
    expect(await runner.isAlive(0)).toBe(false);
  });
});

describe.skipIf(!isWin)('taskkill 방식 (Windows 대체)', () => {
  let root: string;
  let workDir: string;
  let runner: ProcessRunner;
  /** 러너가 알린 경고 — 종료를 확인하지 못한 까닭(작업 개체에 늦게 넣음 등)이 여기 있다. 단언이 실패하면 함께 보인다 */
  const warns: string[] = [];
  const why = (): string => `러너 경고: ${JSON.stringify(warns)}`;
  /**
   * 이 실행 뒤로(from번째 경고부터) 러너가 '작업 개체에 늦게 넣음'을 알렸는지 (리드 결정 S5-52.5). 아주 바쁜 PC에서 넣기가 상한(JOB_ADOPT_LATE_MS)을 넘으면 러너는
   * 안전하게 종료를 확인하지 못한 것(-1)으로 다룬다 — 그때는 보수적 결과를, 아니면 확인된 결과(0)를 단언한다. 어느 쪽이든 프로세스는 끝난다(보수적 쪽은 fail-safe)
   */
  const adoptedLate = (from: number): boolean => warns.slice(from).some((w) => w.startsWith('작업 개체가 이 프로세스 트리를'));

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'wook-test-taskkill 방식 '));
    workDir = join(root, '작업 폴더');
    await mkdir(workDir, { recursive: true });
    // 작업 개체 도우미가 준비된 뒤에 시험한다 (리드 결정 S5-46): 러너가 만들 때 기다리는 10초(HELPER_READY_WAIT_MS)는 바쁜 PC에서 PowerShell 시작보다 짧을 수
    // 있다 — 준비 전에 띄운 실행은 러너가 종료를 확인하지 못한 것(-1)으로 다루고, 그것이 맞다. 그래서 준비를 넉넉히 기다리고(시간이 아니라 준비를 기다린다), 도우미의
    // 첫 넣기(처음 도는 코드라 느리다 — 넣기가 띄운 뒤 JOB_ADOPT_LATE_MS를 넘으면 역시 -1)는 단언하는 시험 밖에서 한 번 치른다
    const helper = createJobHelper({ log: () => undefined });
    expect(await helper.ready(60_000), '작업 개체 도우미 준비').toBe(true);
    runner = await createProcessRunner({
      dataDir: join(root, '데이터'),
      forceMode: 'taskkill',
      jobHelper: helper,
      log: (level, msg) => {
        if (level !== 'info') warns.push(msg);
      },
    });
    const warm = startCollect(runner, nodeSpec(workDir, [echoFixture], { stdinText: '준비' }));
    await warm.proc.exited;
    warns.length = 0;
  }, 120_000);

  afterEach(async () => {
    await killLeftovers();
    warns.length = 0;
  });

  afterAll(async () => {
    await killLeftovers();
    runner.dispose?.();
    // Windows: 방금 끝낸 프로세스(그 콘솔 호스트 conhost.exe 포함)가 작업 폴더를 잠깐 더 잡고 있을 수 있다 — 다른 시험 정리와 같게 다시 시도
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it('표준 입력 왕복과 종료 코드 — 작업 개체 도우미로 남은 후손이 없음을 확인한다(늦게 넣었으면 -1)', async () => {
    expect(runner.mode).toBe('taskkill');
    const w0 = warns.length;
    const c = startCollect(
      runner,
      nodeSpec(workDir, [echoFixture, 'a b', '한글'], { stdinText: '입력 🙂', env: { ...process.env, WOOK_FIXTURE_EXIT: '5' } }),
    );
    const info = await c.proc.exited;
    const reply = JSON.parse(c.out[0]) as { stdin: string; argv: string[]; pid: number };
    expect(reply.stdin).toBe('입력 🙂');
    expect(reply.argv).toEqual(['a b', '한글']);
    expect(await c.proc.childPid).toBe(reply.pid);
    expect(c.proc.pid).toBe(reply.pid);
    // 늦게 넣었으면 확인 불가(-1), 아니면 확인(0). 어느 쪽이든 자연 종료 코드 5다 (리드 결정 S5-52.5)
    expect(info, why()).toMatchObject({ code: 5, signal: null, remaining: adoptedLate(w0) ? -1 : 0, terminated: false });
    // 이 대역은 아무것도 띄우지 않는다. 시험 프로세스에 콘솔이 없으면(앱도 그렇다 — Electron) Windows가 콘솔 자식마다 콘솔 호스트(conhost.exe)를
    // 그 자식으로 띄워 함께 작업 개체에 들고, 끝난 직후 정리가 그것을 하나 끝낼 수 있다 — 그 밖의 후손은 없어야 한다
    expect(info.leftoverKilled).toBeLessThanOrEqual(1);
  });

  // 아래 세 시험의 트리는 CLI 대역이다: 앱이 띄우는 CLI처럼 프롬프트(표준 입력)를 읽은 뒤에 후손을 만든다. 입력 없이 띄우자마자 일을 시작하는
  // 실행은 넣기 전에 생긴 고아를 확인할 수 없어 늘 -1이다 (S7-C1 — taskkillAdoptGate.test.ts)
  it('부모가 끝나며 남긴 후손과 고아(중간 부모가 먼저 끝난 후손)를 작업 개체로 정리한다 (파이프를 물고 있어도, AC-36)', async () => {
    for (const variant of [[], ['hold']]) {
      const w0 = warns.length;
      const c = startCollect(runner, nodeSpec(workDir, [treeFixture, '2', 'exit', 'orphan', 'prompt', ...variant], { stdinText: '프롬프트' }));
      const pids = await treeOf(c);
      expect(pids).toHaveLength(4);
      const info = await c.proc.exited;
      // 늦게 넣었으면 확인 불가(-1), 아니면 확인(0). 어느 쪽이든 후손은 끝나 있고 정리 수는 그대로다 (리드 결정 S5-52.5, fail-safe)
      expect(info, why()).toMatchObject({ code: 0, remaining: adoptedLate(w0) ? -1 : 0, terminated: false });
      expect(info.leftoverKilled).toBeGreaterThanOrEqual(3);
      expect(await stillAliveAfter(pids, 1000)).toEqual([]);
    }
  });

  it('terminate(): 부모·후손·고아(중간 부모가 먼저 끝난 후손)까지 작업 개체로 종료 확인 (AC-29)', async () => {
    const w0 = warns.length;
    const c = startCollect(runner, nodeSpec(workDir, [treeFixture, '2', 'stay', 'orphan', 'hold', 'prompt'], { stdinText: '프롬프트' }));
    const pids = await treeOf(c);
    expect(pids).toHaveLength(4);
    expect(pids.filter(alive)).toEqual(pids);
    const t0 = performance.now();
    const result = await c.proc.terminate({ reason: '테스트 종료' });
    record('terminate() taskkill+작업 개체 (부모+후손3)', performance.now() - t0);
    // 늦게 넣었으면 확인 불가(ok:false·-1), 아니면 확인(ok:true·0). 어느 쪽이든 트리는 3초 안에 끝났다 (리드 결정 S5-52.5, fail-safe)
    const late = adoptedLate(w0);
    expect(result, why()).toMatchObject({ ok: !late, remaining: late ? -1 : 0 });
    expect(result.durationMs).toBeLessThan(3000);
    expect(pids.filter(alive)).toEqual([]);
    expect(await c.proc.exited).toMatchObject({ code: null, signal: 'SIGKILL', remaining: late ? -1 : 0, terminated: true });
  });

  it('작업 개체 도우미를 쓸 수 없으면 부모가 먼저 끝난 후손을 확인하지 못한 것으로 알린다 (종료 확인 실패, -1)', async () => {
    const bare = await createProcessRunner({ dataDir: join(root, '도우미 없음'), forceMode: 'taskkill', jobHelper: null, log: () => undefined });
    const done = startCollect(bare, nodeSpec(workDir, [echoFixture]));
    expect(await done.proc.exited).toMatchObject({ code: 0, remaining: -1, terminated: false });
    const c = startCollect(bare, nodeSpec(workDir, [treeFixture, '1', 'stay']));
    const pids = await treeOf(c);
    const result = await c.proc.terminate();
    expect(result.ok).toBe(false);
    expect(result.remaining).toBe(-1);
    expect(result.detail).toContain('부모가 먼저 끝난 후손');
    expect(pids.slice(0, 1).filter(alive)).toEqual([]); // CLI 자신은 taskkill /T로 끝났다
    expect(await c.proc.exited).toMatchObject({ terminated: true, remaining: -1 });
  });

  it('terminate(): taskkill /T /F로 부모·후손 종료 확인', async () => {
    const w0 = warns.length;
    const c = startCollect(runner, nodeSpec(workDir, [treeFixture, '2', 'stay', 'hold', 'prompt'], { stdinText: '프롬프트' }));
    const pids = await treeOf(c);
    const t0 = performance.now();
    const result = await c.proc.terminate();
    record('terminate() taskkill (부모+후손2)', performance.now() - t0);
    // 늦게 넣었으면 확인 불가(ok:false·-1), 아니면 확인(ok:true·0). 어느 쪽이든 트리는 끝났다 (리드 결정 S5-52.5, fail-safe)
    const late = adoptedLate(w0);
    expect(result, why()).toMatchObject({ ok: !late, remaining: late ? -1 : 0 });
    expect(pids.filter(alive)).toEqual([]);
    const info = await c.proc.exited;
    expect(info).toMatchObject({ code: null, signal: 'SIGKILL', remaining: late ? -1 : 0, terminated: true });
    expect(c.proc.terminate()).toBe(c.proc.terminate());
  });

  it('없는 실행 파일 → 종료 코드 -1', async () => {
    const c = startCollect(runner, nodeSpec(workDir, [], { command: 'C:\\없음\\nothere.exe' }));
    expect((await c.proc.exited).code).toBe(-1);
    expect(c.err[0]).toContain('실행 파일을 찾을 수 없습니다');
  });

  it('jobobject 준비에 실패하면 taskkill로 대체하고 사유를 알린다 (강제 지정이면 오류)', async () => {
    const missing = join(root, '없음', 'JobRunner.cs');
    const warned: string[] = [];
    const fallback = await createProcessRunner({
      dataDir: join(root, '대체'),
      runnerSource: missing,
      log: (level, msg) => {
        if (level === 'warn') warned.push(msg);
      },
    });
    expect(fallback.mode).toBe('taskkill');
    expect(fallback.detail).toContain('러너 소스를 읽지 못했습니다');
    expect(warned.length).toBe(1);
    await expect(
      createProcessRunner({ dataDir: join(root, '강제'), runnerSource: missing, forceMode: 'jobobject', log: () => undefined }),
    ).rejects.toThrow('작업 개체 러너를 준비하지 못했습니다');
    await expect(createProcessRunner({ dataDir: join(root, '그룹'), forceMode: 'pgroup' })).rejects.toThrow('Windows');
  });
});

describe.skipIf(!isWin)('cmd 명령줄 그대로 넘기기·콘솔 코드 페이지 출력 (windows:F4·F10, 두 방식)', () => {
  let root: string;
  let workDir: string;
  const runners: Partial<Record<'jobobject' | 'taskkill', ProcessRunner>> = {};
  const comspec = process.env.ComSpec || 'C:\Windows\System32\cmd.exe';
  const node = `"${process.execPath}"`;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'wook-test-cmd 명령줄 '));
    workDir = join(root, '작업 폴더');
    await mkdir(workDir, { recursive: true });
    runners.jobobject = await createProcessRunner({ dataDir: join(root, '데이터 job'), forceMode: 'jobobject', runnerSource, log: () => undefined });
    runners.taskkill = await createProcessRunner({ dataDir: join(root, '데이터 tk'), forceMode: 'taskkill', log: () => undefined });
  });

  afterEach(() => killLeftovers());

  afterAll(async () => {
    await killLeftovers();
    // Windows: 방금 끝낸 프로세스(그 콘솔 호스트 conhost.exe 포함)가 작업 폴더를 잠깐 더 잡고 있을 수 있다 — 다른 시험 정리와 같게 다시 시도
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  const cmdSpec = (cmd: string, extra: Partial<RunSpec> = {}): RunSpec => ({
    command: comspec,
    args: ['/d', '/s', '/c', `"${cmd}"`],
    verbatimArgs: true,
    cwd: workDir,
    env: { ...process.env },
    stdinText: null,
    label: 'cmd 시험',
    ...extra,
  });

  for (const mode of ['jobobject', 'taskkill'] as const) {
    it(`${mode}: verbatimArgs — 명령 속 큰따옴표·공백 경로·종료 코드·%변수%가 셸에서 친 것과 같다`, async () => {
      const runner = runners[mode]!;
      const json = startCollect(runner, cmdSpec(`${node} -e "console.log(JSON.stringify(process.argv.slice(1)))" "a b" c`));
      expect((await json.proc.exited).code).toBe(0);
      expect(json.out).toEqual(['["a b","c"]']);

      const fail = startCollect(runner, cmdSpec(`${node} -e "process.exit(3)"`));
      expect((await fail.proc.exited).code).toBe(3);
      const chain = startCollect(runner, cmdSpec(`${node} -e "process.exit(0)" && ${node} -e "process.exit(4)"`));
      expect((await chain.proc.exited).code).toBe(4);

      const env = startCollect(runner, cmdSpec('echo [%COMPUTERNAME%]'));
      await env.proc.exited;
      expect(env.out[0]).toBe(`[${process.env.COMPUTERNAME}]`);

      // 대조: 일반 인용이면 cmd가 \" 를 몰라 인자가 깨진다 (예전 동작)
      const quoted = startCollect(runner, cmdSpec(`${node} -e "console.log(JSON.stringify(process.argv.slice(1)))" "a b" c`, { args: ['/d', '/s', '/c', `${node} -e "console.log(JSON.stringify(process.argv.slice(1)))" "a b" c`], verbatimArgs: false }));
      await quoted.proc.exited;
      expect(quoted.out).not.toEqual(['["a b","c"]']);
    });

    it(`${mode}: consoleOutput — cmd 자체 오류 문구(콘솔 코드 페이지)와 UTF-8 출력을 줄마다 맞게 읽는다`, async () => {
      const runner = runners[mode]!;
      const missing = startCollect(runner, cmdSpec('wook-no-such-command-xyz', { consoleOutput: true }));
      expect((await missing.proc.exited).code).not.toBe(0);
      const text = missing.err.join('\n');
      expect(text).toContain('wook-no-such-command-xyz');
      expect(text).not.toContain('\uFFFD');
      if (/[가-힣]/.test(text)) {
        // 한국어 Windows: 예전처럼 UTF-8로만 읽으면 깨진다
        const raw = startCollect(runner, cmdSpec('wook-no-such-command-xyz'));
        await raw.proc.exited;
        expect(raw.err.join('\n')).toContain('\uFFFD');
      }
      // 한 프로그램이 CP949 줄과 UTF-8 줄을 섞어 써도 줄마다 맞게
      const mixed = startCollect(runner, {
        ...cmdSpec(''),
        command: process.execPath,
        args: ['-e', "process.stdout.write(Buffer.from([0xc7, 0xd1, 0xb1, 0xdb, 0x0d, 0x0a])); process.stdout.write('한글 utf8' + String.fromCharCode(10) + '끝')"],
        verbatimArgs: false,
        consoleOutput: true,
      });
      expect((await mixed.proc.exited).code).toBe(0);
      expect(mixed.out).toEqual(['한글', '한글 utf8', '끝']);
    });
  }

  it('processCreatedAt: 살아 있는 PID는 생성 시각(시작 직후 기록보다 같거나 이름), 끝난·잘못된 PID는 빠진다 (windows:F2)', async () => {
    const runner = runners.jobobject!;
    const before = Date.now();
    const c = startCollect(runner, nodeSpec(workDir, ['-e', 'setTimeout(() => {}, 20000)']));
    const after = Date.now();
    const runnerPid = c.proc.pid!;
    const child = (await c.proc.childPid)!;
    const created = await runner.processCreatedAt([runnerPid, child, runnerPid]);
    expect(created.get(runnerPid)).toBeGreaterThanOrEqual(before - 1000);
    expect(created.get(runnerPid)).toBeLessThanOrEqual(after + 1000);
    expect(created.get(child)).toBeGreaterThanOrEqual(created.get(runnerPid)! - 1000);
    expect((await c.proc.terminate()).ok).toBe(true);
    const gone = await runner.processCreatedAt([runnerPid, child]);
    expect(gone.has(runnerPid) || gone.has(child)).toBe(false);
    expect((await runner.processCreatedAt([0, -5, 1.5, 1])).size).toBe(0);
  });
});

describe.skipIf(isWin)('pgroup 방식 (macOS·Linux 프로세스 그룹)', () => {
  let root: string;
  let workDir: string;
  let runner: ProcessRunner;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'wook-test-pgroup '));
    workDir = join(root, '작업 폴더');
    await mkdir(workDir, { recursive: true });
    runner = await createProcessRunner({ dataDir: join(root, '데이터'), log: () => undefined });
  });

  afterEach(() => killLeftovers());

  afterAll(async () => {
    await killLeftovers();
    // Windows: 방금 끝낸 프로세스(그 콘솔 호스트 conhost.exe 포함)가 작업 폴더를 잠깐 더 잡고 있을 수 있다 — 다른 시험 정리와 같게 다시 시도
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it('표준 입력 왕복과 종료 코드', async () => {
    expect(runner.mode).toBe('pgroup');
    const c = startCollect(runner, nodeSpec(workDir, [echoFixture, 'a b'], { stdinText: '입력', env: { ...process.env, WOOK_FIXTURE_EXIT: '4' } }));
    const info = await c.proc.exited;
    expect(JSON.parse(c.out[0]).stdin).toBe('입력');
    expect(info).toMatchObject({ code: 4, leftoverKilled: 0, remaining: 0, terminated: false });
  });

  it('부모가 끝나며 남긴 후손을 그룹 신호로 정리한다', async () => {
    const c = startCollect(runner, nodeSpec(workDir, [treeFixture, '2', 'exit']));
    const pids = await treeOf(c);
    const info = await c.proc.exited;
    expect(info.leftoverKilled).toBe(2);
    expect(info.remaining).toBe(0);
    expect(await stillAliveAfter(pids.slice(1), 1000)).toEqual([]);
  });

  it('terminate(): 그룹 전체(고아 포함)를 종료하고 확인한다', async () => {
    const c = startCollect(runner, nodeSpec(workDir, [treeFixture, '2', 'stay', 'orphan']));
    const pids = await treeOf(c);
    const result = await c.proc.terminate();
    expect(result).toMatchObject({ ok: true, remaining: 0 });
    expect(await stillAliveAfter(pids, 1000)).toEqual([]);
    expect((await c.proc.exited).terminated).toBe(true);
  });

  it('killTree (재시작 복구, strict): 이전 실행의 그룹은 끝내고, 그룹 리더가 아닌 같은 번호의 프로세스는 건드리지 않는다', async () => {
    // 이전 실행처럼 러너 밖에서 띄운 그룹 리더 (후손 2개가 그룹 안)
    const leader = spawn(process.execPath, [treeFixture, '2', 'stay'], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    liveChildren.push(leader);
    const tree = JSON.parse(await lineReader(leader.stdout).wait((l) => l.startsWith('{"tree"'))) as { tree: number[]; self: number };
    for (const p of [tree.self, ...tree.tree]) seenPids.add(p);
    expect(await runner.isAlive(leader.pid!)).toBe(true);
    expect(await runner.killTree(leader.pid!)).toMatchObject({ ok: true, remaining: 0 });
    expect(await stillAliveAfter([tree.self, ...tree.tree], 1000)).toEqual([]);
    // 그룹 리더가 아닌 프로세스(이 시험의 그룹에 든 자식): 그 번호의 그룹은 없다 — 건드리지 않는다
    const plain = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    liveChildren.push(plain);
    const r = await runner.killTree(plain.pid!);
    expect(r).toMatchObject({ ok: true, remaining: 0 });
    expect(r.detail).toContain('그룹이 없습니다');
    expect(alive(plain.pid!)).toBe(true);
  });
});

/**
 * Linux /proc (리드 결정 S10-5): 실제 /proc와 실제 자식으로. 잡는 결함: 신원·생성 시각을 ps로 읽음(ps·pgrep 없는 서버에서 잠금이 영영 '쓰는 중'),
 * 생성 시각 식이 ps lstart와 다름(예전 기록과 어긋남), 그룹을 떠난 후손을 확인 없이 '종료 확인'(setsid·timeout·tmux로 남은 개발 서버), 확인하지 못한 것을
 * 0으로 셈, 욱채 자신의 그룹에 신호
 */
/** Linux 시험의 조건 (이름에 까닭을 단다): python3, systemd 사용자 관리자(덧없는 systemd-run --user 유닛 — 리드 결정 S10-9가 허락한 것) */
const isLinux = process.platform === 'linux';
const hasPython3 = isLinux && existsSync('/usr/bin/python3');
const userManager = isLinux && spawnSync('systemd-run', ['--user', '--quiet', '--wait', '--collect', 'true'], { stdio: 'ignore', timeout: 20_000 }).status === 0;
const daemonizeFixture = join(fixturesDir, 'daemonize.py');

/** 지금 살아 있는(좀비 빼고) 프로세스 가운데 환경에 그 실행의 표시가 있는 것 — 읽기만 한다 */
function taggedLive(tag: string): number[] {
  const out: number[] = [];
  for (const n of readdirSync('/proc')) {
    if (!/^\d+$/.test(n)) continue;
    const s = readProcStat(Number(n), '/proc');
    if (!s || s.state === 'Z') continue;
    try {
      if (environHas(readFileSync(`/proc/${n}/environ`), `${RUN_TAG_ENV}=${tag}`)) out.push(Number(n));
    } catch {
      // 읽지 못함
    }
  }
  return out;
}

describe.skipIf(process.platform !== 'linux')('Linux /proc — 신원·그룹 구성원·그룹을 떠난 후손 (Linux 전용: 실제 /proc가 필요하다)', () => {
  let root: string;
  let workDir: string;
  let runner: ProcessRunner;
  const leaverFixture = join(fixturesDir, 'leaver.mjs');

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'wook-test-procfs '));
    workDir = join(root, '작업 폴더');
    await mkdir(workDir, { recursive: true });
    runner = await createProcessRunner({ dataDir: join(root, '데이터'), log: () => undefined });
  });

  afterEach(() => killLeftovers());

  afterAll(async () => {
    await killLeftovers();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  /** leaver.mjs가 알린 떠난 후손 PID (정리 때 끝나기를 기다린다) */
  async function leaverOf(c: Collected): Promise<{ leaver: number; self: number }> {
    const info = JSON.parse(await c.waitLine((l) => l.startsWith('{"leaver"'))) as { leaver: number; self: number };
    seenPids.add(info.leaver);
    seenPids.add(info.self);
    return info;
  }

  it('실제 /proc 읽기: 띄운 직후 신원(start) = processStart = boot id 파일 + stat 22번째 칸, 두 번 읽어도 같고 나중 자식의 틱이 크거나 같다', async () => {
    const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    const a = startCollect(runner, nodeSpec(workDir, ['-e', 'setTimeout(() => {}, 30000)']));
    const b = startCollect(runner, nodeSpec(workDir, ['-e', 'setTimeout(() => {}, 30000)']));
    const [pa, pb] = [a.proc.pid!, b.proc.pid!];
    expect(a.proc.start).toEqual({ bootId, ticks: expect.any(Number) });
    const first = await runner.processStart!([pa, pb, 0, -1]);
    expect(first.get(pa)).toEqual(a.proc.start);
    expect(first.get(pb)).toEqual(b.proc.start);
    expect(first.size).toBe(2);
    expect((await runner.processStart!([pa])).get(pa)).toEqual(first.get(pa));
    expect(first.get(pb)!.ticks).toBeGreaterThanOrEqual(first.get(pa)!.ticks);
    expect((await processLiveness.processStart([pa])).get(pa)).toEqual(a.proc.start);
    expect((await Promise.all([a.proc.terminate(), b.proc.terminate()])).every((r) => r.ok)).toBe(true);
    expect((await runner.processStart!([pa, pb])).size).toBe(0);
  });

  it('생성 시각은 /proc로 계산해 ps -o lstart와 같다 (1초 안 — 같은 식이라 보통 0)', async () => {
    const c = startCollect(runner, nodeSpec(workDir, ['-e', 'setTimeout(() => {}, 30000)']));
    const pids = [c.proc.pid!, process.pid, process.ppid];
    const fromProc = await runner.processCreatedAt(pids);
    const fromLiveness = await processLiveness.processCreatedAt(pids);
    const out = execFileSync('ps', ['-o', 'pid=,lstart=', '-p', pids.join(',')], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', LANG: 'C' } });
    const fromPs = new Map(
      out
        .trim()
        .split('\n')
        .map((l) => /^\s*(\d+)\s+(.+?)\s*$/.exec(l)!)
        .map((m) => [Number(m[1]), Date.parse(m[2]!)] as const),
    );
    for (const p of pids) {
      expect(Math.abs(fromProc.get(p)! - fromPs.get(p)!), `PID ${p}`).toBeLessThanOrEqual(1000);
      expect(fromLiveness.get(p)).toBe(fromProc.get(p));
    }
    expect((await c.proc.terminate()).ok).toBe(true);
  });

  it('PATH에 ps·pgrep이 없어도 그룹 구성원을 /proc로 센다 — 남긴 후손 수(leftoverKilled)가 -1이 아니다 (S10-5.3·5.4)', async () => {
    const spec = nodeSpec(workDir, [treeFixture, '2', 'exit']);
    const savedPath = process.env.PATH;
    const empty = join(root, '빈 PATH');
    await mkdir(empty, { recursive: true });
    process.env.PATH = empty; // 러너가 ps·pgrep을 부르면 찾지 못한다 (자식은 절대 경로의 node로 뜬다)
    try {
      const c = startCollect(runner, spec);
      const pids = await treeOf(c);
      const info = await c.proc.exited;
      expect(info).toMatchObject({ leftoverKilled: 2, remaining: 0 });
      expect(await stillAliveAfter(pids.slice(1), 1000)).toEqual([]);
      expect((await runner.processCreatedAt([process.pid])).has(process.pid)).toBe(true);
    } finally {
      process.env.PATH = savedPath;
    }
  });

  it('정지: setsid로 그룹을 떠난 후손(환경을 물려받음)도 같은 정지 시간 안에 끝내고 센다', async () => {
    const c = startCollect(runner, nodeSpec(workDir, [leaverFixture, 'stay', 'env', 'orphan', quitPath()]));
    const { leaver } = await leaverOf(c);
    expect(alive(leaver)).toBe(true);
    const result = await c.proc.terminate({ timeoutMs: 2800 });
    expect(result).toMatchObject({ ok: true, remaining: 0 });
    expect(result.detail).toContain('그룹을 떠난 이 실행의 후손 1개도 끝냈습니다');
    expect(await stillAliveAfter([leaver], 500)).toEqual([]);
  });

  it('스스로 끝남: 그룹을 떠난 후손을 남기고 끝난 실행 — 끝날 때 찾아 끝내고 leftoverKilled에 센다', async () => {
    const c = startCollect(runner, nodeSpec(workDir, [leaverFixture, 'exit', 'env', 'direct', quitPath()]));
    const { leaver } = await leaverOf(c);
    const info = await c.proc.exited;
    expect(info).toMatchObject({ code: 0, leftoverKilled: 1, remaining: 0, terminated: false });
    expect(await stillAliveAfter([leaver], 500)).toEqual([]);
  });

  it('정지: timeout(새 프로세스 그룹)으로 띄운 sleep도 표시로 찾아 끝낸다', async () => {
    const c = startCollect(runner, {
      command: '/bin/sh',
      args: ['-c', 'timeout 50 sleep 50 & echo "{\\"timeout\\":$!}"; wait'],
      cwd: workDir,
      env: { ...process.env },
      stdinText: null,
      label: '시험 timeout',
    });
    const t = (JSON.parse(await c.waitLine((l) => l.startsWith('{"timeout"'))) as { timeout: number }).timeout;
    seenPids.add(t);
    await new Promise((r) => setTimeout(r, 200)); // timeout이 setpgid로 그룹을 바꿀 때까지
    const result = await c.proc.terminate({ timeoutMs: 2800 });
    expect(result).toMatchObject({ ok: true, remaining: 0 });
    expect(result.detail).toMatch(/그룹을 떠난 이 실행의 후손 [12]개도 끝냈습니다/);
    expect(await stillAliveAfter([t], 500)).toEqual([]);
  });

  it('정지: 환경을 지우고 setsid한 후손도 그 부모가 살아 있으면(부모 PID로 이어짐) 찾아 끝낸다', async () => {
    const c = startCollect(runner, nodeSpec(workDir, [leaverFixture, 'stay', 'scrub', 'direct', quitPath()]));
    const { leaver } = await leaverOf(c);
    const result = await c.proc.terminate({ timeoutMs: 2800 });
    expect(result).toMatchObject({ ok: true, remaining: 0 });
    expect(result.detail).toContain('그룹을 떠난 이 실행의 후손 1개도 끝냈습니다');
    expect(await stillAliveAfter([leaver], 500)).toEqual([]);
  });

  it('한계: 환경을 지우고 setsid한 뒤 부모가 먼저 끝난 후손(조상이 모두 끝나 찾은 것에 닿지 않음)은 찾을 수 없어 살아남는다 — 제품은 그것까지 확인했다고 하지 않는다 (설정 설명에 한계를 쓴다)', async () => {
    const c = startCollect(runner, nodeSpec(workDir, [leaverFixture, 'stay', 'scrub', 'orphan', quitPath()]));
    const { leaver } = await leaverOf(c);
    const result = await c.proc.terminate({ timeoutMs: 2800 });
    // 찾지 못한 것을 셌다고 하지 않는다: 끝낸 것은 그룹뿐이다
    expect(result.detail).not.toContain('그룹을 떠난 이 실행의 후손');
    expect(alive(leaver)).toBe(true);
    expect(runner.detail).toContain(LINUX_SWEEP_LIMIT);
    expect(LINUX_SWEEP_LIMIT).toContain('부모 PID를 따라 올라가도 그룹 구성원이나 표시로 찾은 프로세스에 닿지 않는 것');
    expect(LINUX_SWEEP_LIMIT).toContain('환경을 지우고 띄운 뒤 띄운 쪽이 먼저 끝난 프로그램');
    // 그 후손은 시험의 그만 파일로 스스로 끝난다 (afterEach)
  });

  /** daemonize.py로 떠난 후손을 만든다 (python3 — Ubuntu에 늘 있다) */
  async function daemonRun(
    mode: 'dump' | 'nodump' | 'clobber' | 'wrap-scrub' | 'wrap-clobber',
    then: 'stay' | 'exit',
  ): Promise<{ c: Collected; leaver: number; child: number; tag: string }> {
    const tagFile = join(root, `tag-${mode}-${then}-${Date.now()}`);
    const c = startCollect(runner, {
      command: '/bin/sh',
      args: ['-c', `python3 -I "$1" "$2" "$3" "$4"; ${then === 'stay' ? 'exec sleep 30' : 'sleep 1; exit 0'}`, 'sh', daemonizeFixture, quitPath(), mode, tagFile],
      cwd: workDir,
      env: { ...process.env },
      stdinText: null,
      label: `시험 데몬 ${mode}`,
    });
    const { leaver, child } = JSON.parse(await c.waitLine((l) => l.startsWith('{"leaver"'))) as { leaver: number; child: number };
    seenPids.add(leaver);
    if (child) seenPids.add(child);
    for (let i = 0; i < 60 && !existsSync(tagFile); i++) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 100));
    return { c, leaver, child, tag: readFileSync(tagFile, 'utf8') };
  }

  /** 감싸개의 자식이 표시를 보이지 않게 될 때까지(빈 환경으로 다시 실행·제목 덮어쓰기) 기다린다 */
  async function untilHidden(pid: number, tag: string): Promise<boolean> {
    const hidden = (): boolean => {
      try {
        return !environHas(readFileSync(`/proc/${pid}/environ`), `${RUN_TAG_ENV}=${tag}`);
      } catch {
        return true;
      }
    };
    for (let i = 0; i < 60 && !hidden(); i++) await new Promise((r) => setTimeout(r, 50));
    return hidden();
  }

  /**
   * 리뷰 프로브 V1 (S10-16 FPS-1): 표시를 가진 감싸개가 그룹을 떠나고 그 부모는 끝났다(고아 — 정지 전 스냅숏으로는 닿지 않음). 그 자식은 표시를 보이지
   * 않는다. 정지 전 사실을 확인해 돌려준다
   */
  async function orphanWrapper(inner: 'scrub' | 'clobber', then: 'stay' | 'exit'): Promise<{ c: Collected; wrapper: number; child: number }> {
    const d = await daemonRun(`wrap-${inner}`, then);
    const tag = d.c.proc.runTag!;
    const ws = readProcStat(d.leaver, '/proc')!;
    expect(d.tag).toBe(tag);
    expect(environHas(readFileSync(`/proc/${d.leaver}/environ`), `${RUN_TAG_ENV}=${tag}`)).toBe(true);
    expect(ws.pgrp).not.toBe(d.c.proc.pid);
    expect(ws.ppid).not.toBe(d.c.proc.pid);
    expect(readProcStat(d.child, '/proc')!.ppid).toBe(d.leaver);
    expect(readProcStat(d.child, '/proc')!.startTicks).toBeGreaterThanOrEqual(d.c.proc.start!.ticks);
    expect(await untilHidden(d.child, tag)).toBe(true);
    return { c: d.c, wrapper: d.leaver, child: d.child };
  }

  for (const inner of ['scrub', 'clobber'] as const) {
    it.skipIf(!hasPython3)(`정지: 표시로 찾은 고아 감싸개의 자식은 표시가 보이지 않아도(${inner === 'scrub' ? '빈 환경 — env -i' : '프로세스 제목을 환경 자리에 덮어씀'}) 감싸개에 신호하기 전에 부모로 이어 함께 끝낸다 — 리뷰 프로브 V1${inner === 'scrub' ? 'a' : 'b'} (S10-16 FPS-1)${hasPython3 ? '' : ' [건너뜀: python3 없음]'}`, async () => {
      const w = await orphanWrapper(inner, 'stay');
      const r = await w.c.proc.terminate({ timeoutMs: 2800 });
      expect(await stillAliveAfter([w.wrapper, w.child], 500)).toEqual([]);
      expect(r).toMatchObject({ ok: true, remaining: 0 });
      expect(Number(/후손 (\d+)개도 끝냈습니다/.exec(r.detail)?.[1] ?? '0')).toBeGreaterThanOrEqual(2);
    });
  }

  it.skipIf(!hasPython3)(`스스로 끝남: 표시로 찾은 고아 감싸개와 빈 환경의 그 자식을 남기고 끝난 실행 — 둘 다 끝내고 센다 — 리뷰 프로브 V1d (S10-16 FPS-1)${hasPython3 ? '' : ' [건너뜀: python3 없음]'}`, async () => {
    const w = await orphanWrapper('scrub', 'exit'); // 실행은 1초 뒤 스스로 끝난다 — 그 전에 자식이 표시를 감췄다
    const info = await w.c.proc.exited;
    expect(await stillAliveAfter([w.wrapper, w.child], 500)).toEqual([]);
    expect(info.remaining).toBe(0);
    expect(info.leftoverKilled).toBeGreaterThanOrEqual(2);
  });

  it('정지: SIGTERM을 견디는 고아 감싸개가 견디는 동안 띄운, 표시가 보이지 않는(env -i) 자식도 KILL 전에 멈추고 찾아 함께 끝낸다 — 정지 시간 안에 (S10-16 FPS-1)', async () => {
    const script = join(root, `grace-${Date.now()}.sh`);
    const pidsFile = `${script}.pids`;
    await writeFile(
      script,
      [
        "trap '' TERM",
        'i=0',
        'while [ $i -lt 200 ]; do',
        `  env -i /bin/sh -c 'echo $$ >> "$1"; exec /bin/sleep 20' sh "$1" &`,
        '  /bin/sleep 0.1',
        '  i=$((i+1))',
        'done',
        '',
      ].join('\n'),
    );
    const c = startCollect(runner, {
      command: '/bin/sh',
      args: ['-c', '( setsid /bin/sh "$1" "$2" </dev/null >/dev/null 2>&1 & ); echo ready; exec sleep 30', 'sh', script, pidsFile],
      cwd: workDir,
      env: { ...process.env },
      stdinText: null,
      label: '시험 견디는 감싸개',
    });
    await c.waitLine((l) => l === 'ready');
    await new Promise((r) => setTimeout(r, 600));
    const recorded = (): number[] => (existsSync(pidsFile) ? readFileSync(pidsFile, 'utf8').split('\n').filter(Boolean).map(Number) : []);
    const before = recorded().length;
    expect(before).toBeGreaterThan(0);
    const t0 = performance.now();
    const r = await c.proc.terminate({ timeoutMs: 2800 });
    const took = performance.now() - t0;
    const all = recorded();
    for (const p of all) seenPids.add(p);
    // 감싸개가 SIGTERM을 견디는 동안에도 자식을 띄웠다 — 그 자식들도 남지 않았다
    expect(all.length).toBeGreaterThan(before);
    expect(await stillAliveAfter(all, 500)).toEqual([]);
    expect(r).toMatchObject({ ok: true, remaining: 0 });
    expect(took).toBeLessThan(2800 + 700);
  });

  /** 표시를 가진 고아 감싸개(시작한 서브셸이 곧바로 끝남)가 빈 환경(env -i)의 자식 스크립트를 띄운다 — 리뷰 프로브 W2·W3 (S10-18 F2-2) */
  async function orphanScript(name: string, body: string, wrapperBody: string, arg: string): Promise<Collected> {
    const stamp = `${name}-${Date.now()}`;
    const child = join(root, `${stamp}.sh`);
    const wrapper = join(root, `${stamp}-wrapper.sh`);
    await writeFile(child, body);
    await writeFile(wrapper, wrapperBody);
    const c = startCollect(runner, {
      command: '/bin/sh',
      args: ['-c', '( setsid /bin/sh "$1" "$2" "$3" "$4" </dev/null >/dev/null 2>&1 & ); echo ready; exec sleep 30', 'sh', wrapper, child, arg, quitPath()],
      cwd: workDir,
      env: { ...process.env },
      stdinText: null,
      label: `시험 ${name}`,
    });
    await c.waitLine((l) => l === 'ready');
    return c;
  }

  it('정지: 멈춘(SIGSTOP) 후손도 SIGTERM 뒤 SIGCONT를 받아 제 SIGTERM 처리를 마친다 — 고아 감싸개의 빈 환경 자식이 표시 파일을 쓰고 끝난다 (리뷰 프로브 W2, S10-18 F2-2)', async () => {
    const marker = join(root, `graceful-${Date.now()}.marker`);
    const pidFile = `${marker}.pid`;
    const c = await orphanScript(
      'graceful',
      ['trap \'echo graceful > "$1"; exit 0\' TERM', 'echo $$ > "$1.pid"', 't=0', 'while [ ! -e "$2" ] && [ $t -lt 300 ]; do /bin/sleep 0.1; t=$((t+1)); done', ''].join('\n'),
      ['env -i /bin/sh "$1" "$2" "$3" &', 'wait', ''].join('\n'),
      marker,
    );
    for (let i = 0; i < 60 && !existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 50));
    const child = Number(readFileSync(pidFile, 'utf8'));
    seenPids.add(child);
    expect(environHas(readFileSync(`/proc/${child}/environ`), `${RUN_TAG_ENV}=${c.proc.runTag}`)).toBe(false);
    const r = await c.proc.terminate({ timeoutMs: 2800 });
    expect(await stillAliveAfter([child], 500)).toEqual([]);
    expect(existsSync(marker)).toBe(true); // KILL로 끝났거나 멈춘 채 남았으면 표시 파일이 없다
    expect(r).toMatchObject({ ok: true, remaining: 0 });
  });

  it('정지 시간이 모자라도(300ms) SIGTERM을 무시하며 자식을 계속 띄우는 고아 감싸개의 프로세스를 멈춘 채(T) 남기지 않는다 — 남은 것이 있으면 종료 확인이라고 하지 않는다 (리뷰 프로브 W3, S10-18 F2-2)', async () => {
    const list = join(root, `stubborn-${Date.now()}.pids`);
    const c = await orphanScript(
      'stubborn',
      ["trap '' TERM", 'echo $$ >> "$1"', 't=0', 'while [ ! -e "$2" ] && [ $t -lt 100 ]; do /bin/sleep 0.1; t=$((t+1)); done', ''].join('\n'),
      ["trap '' TERM", 'i=0', 'while [ $i -lt 150 ] && [ ! -e "$3" ]; do', '  env -i /bin/sh "$1" "$2" "$3" &', '  /bin/sleep 0.03', '  i=$((i+1))', 'done', ''].join('\n'),
      list,
    );
    await new Promise((r) => setTimeout(r, 700));
    const r = await c.proc.terminate({ timeoutMs: 300 });
    await new Promise((r2) => setTimeout(r2, 300));
    const pids = existsSync(list) ? readFileSync(list, 'utf8').split('\n').filter(Boolean).map(Number) : [];
    for (const p of pids) seenPids.add(p);
    expect(pids.length).toBeGreaterThan(5);
    const frozen = pids.filter((p) => ['T', 't'].includes(readProcStat(p, '/proc')?.state ?? ''));
    expect(frozen).toEqual([]);
    const left = await stillAliveAfter(pids, 0);
    if (left.length > 0) expect(r.ok && r.remaining === 0, `남은 것 ${left.length}개인데 종료 확인`).toBe(false);
  });

  const hasTmux = isLinux && spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0;
  it.skipIf(!hasTmux)(`정지: 실행이 띄운 tmux 서버(표시로 찾음)의 창은 SIGHUP을 무시해도, 자기 scope(다른 cgroup)에 있어도 부모로 이어 함께 끝낸다 — 리뷰 프로브 V1e (S10-16 FPS-1)${hasTmux ? '' : ' [건너뜀: tmux 없음]'}`, async () => {
    const sock = join(root, `tmux-${Date.now()}`);
    const c = startCollect(runner, {
      command: '/bin/sh',
      args: ['-c', `tmux -S "$1" -f /dev/null new-session -d "trap '' HUP; exec sleep 25" && echo ready; exec sleep 30`, 'sh', sock],
      cwd: workDir,
      env: { ...process.env },
      stdinText: null,
      label: '시험 tmux',
    });
    try {
      await c.waitLine((l) => l === 'ready');
      const tmux = (...a: string[]): string => execFileSync('tmux', ['-S', sock, ...a], { encoding: 'utf8', timeout: 5000 }).trim();
      let pane = 0;
      for (let i = 0; i < 40 && !(pane > 0 && readProcStat(pane, '/proc')?.ppid); i++) {
        await new Promise((r) => setTimeout(r, 50));
        pane = Number(tmux('list-panes', '-a', '-F', '#{pane_pid}')) || 0;
      }
      const server = Number(tmux('display', '-p', '#{pid}'));
      seenPids.add(pane);
      seenPids.add(server);
      expect(environHas(readFileSync(`/proc/${server}/environ`), `${RUN_TAG_ENV}=${c.proc.runTag}`)).toBe(true);
      expect(readProcStat(pane, '/proc')!.ppid).toBe(server);
      // Ubuntu 24.04의 tmux 3.4는 창을 app.slice/app-tmux.slice/tmux-spawn-*.scope에 둔다 — 그러면 표시로는 찾지 않고(cgroup 밖) 부모로만 닿는다
      const paneCg = readFileSync(`/proc/${pane}/cgroup`, 'utf8').trim();
      const r = await c.proc.terminate({ timeoutMs: 2800 });
      expect(await stillAliveAfter([pane, server], 500), `창 cgroup ${paneCg}`).toEqual([]);
      expect(r).toMatchObject({ ok: true, remaining: 0 });
    } finally {
      spawnSync('tmux', ['-S', sock, 'kill-server'], { stdio: 'ignore', timeout: 5000 }); // 이미 끝났으면 아무 일도 하지 않는다
    }
  });

  it.skipIf(!hasPython3 || !userManager)(`덤프 불가(ssh-agent처럼) 후손은 찾은 것에 부모로 이어지지 않으면 신호하지 않고 결과도 바꾸지 않는다 — 정지는 종료 확인, 스스로 끝남도 남은 것 0이고, 결과 글과 경고가 PID를 적는다. 표시로 찾은 감싸개의 덤프 불가 자식은 끝낸다. 다른 시험의 결과 글에 끼지 않게 덧없는 사용자 scope 안에서 (S10-14·S10-16)${hasPython3 && userManager ? '' : ' [건너뜀: python3 또는 systemd 사용자 관리자 없음]'}`, async () => {
    // 같은 cgroup(WSL은 /non-systemd를 모두가 나눈다)의 덤프 불가 프로세스는 그 cgroup의 모든 실행의 결과 글에 이름이 남는다 — 이 시험의 '서버'를 자기 scope에 둔다
    const { build } = await import('rolldown');
    const bundle = join(root, `nodump-scope-${Date.now()}.mjs`);
    await build({ input: join(fixturesDir, 'nodumpScope.ts'), platform: 'node', logLevel: 'silent', output: { file: bundle, format: 'esm' } });
    const tagDir = join(root, `nodump-tags-${Date.now()}`);
    await mkdir(tagDir, { recursive: true });
    const quit = join(tagDir, 'quit');
    const out = await new Promise<string>((resolve, reject) => {
      const child = spawn('systemd-run', ['--user', '--scope', '--quiet', '--collect', '-p', 'RuntimeMaxSec=120', '--', process.execPath, bundle, join(root, '데이터-scope'), workDir, daemonizeFixture, quit, tagDir], { stdio: ['ignore', 'pipe', 'pipe'] });
      liveChildren.push(child);
      let text = '';
      let err = '';
      child.stdout.setEncoding('utf8').on('data', (d: string) => (text += d));
      child.stderr.setEncoding('utf8').on('data', (d: string) => (err += d));
      child.on('close', (code) => (code === 0 ? resolve(text) : reject(new Error(`scope 스크립트 종료 코드 ${String(code)}: ${err.slice(0, 500)}`))));
    });
    const r = JSON.parse(out.trim().split('\n').at(-1)!) as {
      cgroup: string;
      stay: { result: { ok: boolean; remaining: number; detail: string }; leaver: number; aliveAfter: boolean; tagMatches: boolean; environError: string };
      exit: { info: { remaining: number; detail?: string }; leaver: number; aliveAfter: boolean; tagMatches: boolean };
      wrap: {
        result: { ok: boolean; remaining: number; detail: string };
        wrapper: number;
        child: number;
        childParent: number;
        childEnvironError: string;
        tagMatches: boolean;
        childAliveAfter: boolean;
        wrapperAliveAfter: boolean;
      };
      leftAlive: boolean;
      warnings: string[];
    };
    expect(r.cgroup).toMatch(/\.scope$/);
    // 그 후손은 그 실행의 표시를 가졌고(덤프 불가가 되기 전에 적음), 같은 사용자도 환경을 읽지 못한다 — 러너는 그것이 이 실행의 것인지 알 수 없다
    expect([r.stay.tagMatches, r.stay.environError]).toEqual([true, 'EACCES']);
    const named = (pid: number) => new RegExp(`이 실행의 것인지 알 수 없어 그대로 두었습니다 \\([^)]*PID ${pid}: 환경을 읽지 못함`);
    // 정지: 결과는 그룹과 표시 찾기가 말하는 대로 (종료 확인) — 이름만 붙는다. 신호하지 않았다: 기본 처리의 그 후손이 살아 있다
    expect(r.stay.aliveAfter).toBe(true);
    expect(r.stay.result).toMatchObject({ ok: true, remaining: 0 });
    expect(r.stay.result.detail).toMatch(named(r.stay.leaver));
    expect(r.stay.result.detail).not.toContain('확인하지 못했습니다');
    // 스스로 끝남: 남은 것 0 — 결과 글에 이름이 남는다
    expect(r.exit.tagMatches).toBe(true);
    expect(r.exit.aliveAfter).toBe(true);
    expect(r.exit.info.remaining).toBe(0);
    expect(r.exit.info.detail).toMatch(named(r.exit.leaver));
    // 러너가 경고를 남긴다 (서버 기록)
    expect(r.warnings.some((w) => named(r.stay.leaver).test(w))).toBe(true);
    expect(r.warnings.some((w) => named(r.exit.leaver).test(w))).toBe(true);
    // 부모로 이어진 덤프 불가 자식 (S10-16): 표시를 가진 고아 감싸개의 자식 — 환경은 읽지 못해도 이 실행의 것이다. 끝내고, 이름을 남기지 않는다
    expect([r.wrap.tagMatches, r.wrap.childParent, r.wrap.childEnvironError]).toEqual([true, r.wrap.wrapper, 'EACCES']);
    expect([r.wrap.childAliveAfter, r.wrap.wrapperAliveAfter]).toEqual([false, false]);
    expect(r.wrap.result).toMatchObject({ ok: true, remaining: 0 });
    expect(r.wrap.result.detail).toContain('그룹을 떠난 이 실행의 후손 2개도 끝냈습니다');
    expect(r.wrap.result.detail).not.toContain(`PID ${r.wrap.child}`);
    expect(r.warnings.some((w) => w.includes(`PID ${r.wrap.child}`))).toBe(false);
    expect(r.leftAlive).toBe(false); // 안쪽 스크립트가 그만 파일로 끝나게 했다
  });

  it.skipIf(!hasPython3)(`한계(문서): 프로세스 제목을 환경 자리에 덮어쓰고 부모가 끝난 데몬은 찾지 못한다 — 결과는 그룹만 끝냈다고 말하고, 설정 설명이 그 부류를 적는다 (S10-13 LP-3)${hasPython3 ? '' : ' [건너뜀: python3 없음]'}`, async () => {
    const d = await daemonRun('clobber', 'stay');
    expect(d.tag).toBe(d.c.proc.runTag); // 그 데몬은 실행의 표시를 가졌다 (제 메모리 안에서는 지금도)
    expect(readFileSync(`/proc/${d.leaver}/environ`, 'latin1')).toContain('myserver: master process');
    const r = await d.c.proc.terminate({ timeoutMs: 2800 });
    expect(r).toMatchObject({ ok: true, remaining: 0 });
    // 그룹 밖 후손을 찾았거나 확인했다고 하지 않는다 — 같은 cgroup의 다른 프로그램이 남긴 덤프 불가 프로세스의 이름(S10-14)만 붙을 수 있다
    expect(r.detail).toMatch(/^프로세스 그룹을 SIGTERM으로 종료했습니다(\. 이 서버의 cgroup 안에서 이 실행 뒤에 시작한 프로세스 \d+개는 이 실행의 것인지 알 수 없어 그대로 두었습니다 \(.*\))?$/);
    expect(alive(d.leaver)).toBe(true);
    expect(runner.detail).toContain('스스로 데몬이 되어 부모가 먼저 끝난 nginx·PostgreSQL·Redis');
    expect(runner.detail).toContain('정지가 종료 확인으로 보일 수 있습니다');
  });

  it('SIGTERM을 무시하며 자식을 계속 띄우는 후손: 한 번 찾은 뒤 생긴 자식도 다시 찾아 끝내고 센다 — 정지 뒤 이 실행의 표시가 있는 프로세스가 남지 않는다 (S10-13 LP-4)', async () => {
    const c = startCollect(runner, {
      command: '/bin/sh',
      args: ['-c', `setsid sh -c 'trap "" TERM; while :; do sleep 4 & sleep 0.2; done' </dev/null >/dev/null 2>&1 & echo ready; exec sleep 30`],
      cwd: workDir,
      env: { ...process.env },
      stdinText: null,
      label: '시험 되살리기',
    });
    await c.waitLine((l) => l === 'ready');
    await new Promise((r) => setTimeout(r, 800));
    const tag = c.proc.runTag!;
    const before = taggedLive(tag);
    for (const p of before) seenPids.add(p);
    expect(before.length).toBeGreaterThan(2);
    const r = await c.proc.terminate({ timeoutMs: 2800 });
    const after = taggedLive(tag);
    expect(after).toEqual([]);
    expect(r).toMatchObject({ ok: true, remaining: 0 });
    // 처음 찾은 것보다 많이 끝냈다 — 늦게 생긴 자식도 셌다
    const ended = Number(/후손 (\d+)개도 끝냈습니다/.exec(r.detail)?.[1] ?? '0');
    expect(ended).toBeGreaterThanOrEqual(before.length);
  });

  it.skipIf(!userManager)(`이 서버의 cgroup 밖에서 표시를 받은 프로세스(사용자 관리자가 띄운 유닛)는 정지가 신호하지 않는다 — 리뷰 프로브 P2 (S10-13 LP-1)${userManager ? '' : ' [건너뜀: systemd 사용자 관리자(systemd-run --user) 없음]'}`, async () => {
    const c = startCollect(runner, nodeSpec(workDir, ['-e', 'setTimeout(() => {}, 30000)']));
    const tag = c.proc.runTag!;
    await new Promise((r) => setTimeout(r, 50));
    // 실행이 시작한 뒤, 사용자 관리자가 그 실행의 환경(표시)을 가진 유닛을 띄운다 — 실행의 후손이 아니다 (systemctl --user import-environment 뒤의 모습)
    const quit = join(root, `unit-quit-${Date.now()}`);
    const unitName = `wook-test-s10a-${process.pid}-${Date.now()}`;
    const keep = "const q=process.argv[1];setInterval(()=>{if(require('fs').existsSync(q))process.exit(0)},100);setTimeout(()=>process.exit(0),30000)";
    execFileSync('systemd-run', ['--user', '--quiet', '--collect', `--unit=${unitName}`, `--setenv=${RUN_TAG_ENV}=${tag}`, '-p', 'RuntimeMaxSec=60', process.execPath, '-e', keep, quit], { stdio: 'ignore' });
    let unitPid = 0;
    for (let i = 0; i < 60 && !unitPid; i++) {
      unitPid = Number(execFileSync('systemctl', ['--user', 'show', '-p', 'MainPID', '--value', `${unitName}.service`], { encoding: 'utf8' }).trim());
      if (!unitPid) await new Promise((r) => setTimeout(r, 50));
    }
    try {
      expect(unitPid).toBeGreaterThan(1);
      expect(readFileSync(`/proc/${unitPid}/environ`, 'latin1').split('\0')).toContain(`${RUN_TAG_ENV}=${tag}`);
      expect(readFileSync(`/proc/${unitPid}/cgroup`, 'utf8')).toContain(`${unitName}.service`);
      expect(readProcStat(unitPid, '/proc')!.startTicks).toBeGreaterThanOrEqual(c.proc.start!.ticks);
      const r = await c.proc.terminate({ timeoutMs: 2800 });
      expect(r).toMatchObject({ ok: true, remaining: 0 });
      expect(r.detail).not.toContain('그룹을 떠난 이 실행의 후손');
      expect(alive(unitPid)).toBe(true);
    } finally {
      await writeFile(quit, '');
      const deadline = performance.now() + 5000;
      while (unitPid > 1 && alive(unitPid) && performance.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      await rm(quit, { force: true });
    }
  });

  it('/proc를 읽지 못하면 그룹을 떠난 후손을 확인하지 못한 것(-1)으로 알린다 — 0이라고 하지 않고, 정리한 수(leftoverKilled)는 -1이 아니다', async () => {
    // 이 러너가 읽는 /proc 루트가 없다 (마운트되지 않은 /proc 흉내) — 그룹 신호는 실제로 보낸다
    const blind = await createProcessRunner({ dataDir: join(root, '데이터3'), log: () => undefined, procRoot: join(root, '없는 proc') });
    const stopped = startCollect(blind, nodeSpec(workDir, ['-e', 'setTimeout(() => {}, 30000)']));
    expect(stopped.proc.start).toBeNull();
    const r = await stopped.proc.terminate({ timeoutMs: 2800 });
    expect(r).toMatchObject({ ok: false, remaining: -1 });
    expect(r.detail).toContain('/proc를 읽지 못해 그룹을 떠난 후손이 남았는지 확인하지 못했습니다');
    const exited = startCollect(blind, nodeSpec(workDir, [treeFixture, '1', 'exit']));
    const pids = await treeOf(exited);
    const info = await exited.proc.exited;
    expect(info).toMatchObject({ remaining: -1, leftoverKilled: 1 });
    expect(info.detail).toContain('/proc를 읽지 못해');
    expect(await stillAliveAfter(pids.slice(1), 1000)).toEqual([]);
  });

  it('욱채 자신의 프로세스 그룹에는 신호를 보내지 않는다 (재시작 복구의 PID가 그 번호와 같을 때) — 가짜 /proc로 자기 그룹 번호를 정한다', async () => {
    const fakeProc = createFakeProcRoot();
    try {
      // 이 프로세스의 그룹 번호를 PID 범위 밖(pid_max 4194304 위)으로 정해, 검사가 없어도 실제 그룹에 닿지 않게 한다
      const own = 5_000_001;
      fakeProc.add({ pid: process.pid, pgrp: own, ticks: 1 });
      const guarded = await createProcessRunner({ dataDir: join(root, '데이터2'), log: () => undefined, procRoot: fakeProc.root });
      const r = await guarded.killTree(own);
      expect(r).toMatchObject({ ok: false, remaining: -1 });
      expect(r.detail).toContain('욱채 자신의 프로세스 그룹');
    } finally {
      fakeProc.cleanup();
    }
  });
});

/** 자식 출력 스트림 대역 — 시험이 'data'를 직접 내고, 읽기가 멈추면(pause) 다음 조각을 내지 않는다. read()는 스트림 버퍼에 남은 조각을 돌려준다 */
class FakeOut extends EventEmitter {
  paused = false;
  pauses = 0;
  resumes = 0;
  destroyed = false;
  /** 멈춘 사이 스트림 버퍼에 쌓인 조각 (Node는 멈춘 뒤에도 조각 하나쯤을 버퍼에 받는다) */
  buffered: Buffer[] = [];
  pause(): this {
    this.paused = true;
    this.pauses++;
    return this;
  }
  resume(): this {
    this.paused = false;
    this.resumes++;
    return this;
  }
  read(): Buffer | null {
    const c = this.buffered.shift() ?? null;
    if (c) this.emit('data', c);
    return c;
  }
}

const nextTurn = (): Promise<void> => new Promise((r) => setImmediate(r));

/** 조각들을 읽기에 낸다 — 멈춰 있으면 다음 차례까지 기다렸다가 낸다(실제 파이프처럼). 다 내면 끝(end) */
async function feed(reader: PacedReader, out: FakeOut, chunks: Buffer[]): Promise<void> {
  for (const c of chunks) {
    while (out.paused) await nextTurn();
    out.emit('data', c);
  }
  while (out.paused) await nextTurn();
  reader.end();
}

/** 같은 조각을 한꺼번에 줄 나누기에 넘긴 줄 (읽기가 바꾸면 안 되는 기준) */
function plainLines(consoleOutput: boolean, chunks: Buffer[]): string[] {
  const lines: string[] = [];
  const s = lineSplitter(consoleOutput, (l) => lines.push(l));
  for (const c of chunks) s.push(c);
  s.end();
  return lines;
}

/** 짧은 줄 n개 ('line 000001' …) 한 조각 */
const manyLines = (n: number, from = 0): Buffer => Buffer.from(Array.from({ length: n }, (_, i) => `line ${String(from + i).padStart(6, '0')}\n`).join(''));

describe('자식 출력 읽기는 한 차례에 정해진 만큼만 동기로 일한다 (리드 결정 S5-42)', () => {
  // 조각 경계에 걸친 CRLF·한글 UTF-8 바이트, 여러 조각에 걸친 1MiB 한 줄, 빈 줄, 한 조각의 짧은 줄 25만 개, 줄바꿈 없는 마지막 줄
  const han = Buffer.from('한글 줄\n', 'utf8');
  const chunks = [
    Buffer.from('첫 줄\r'),
    Buffer.from('\n둘째 줄\r\n'),
    han.subarray(0, 4),
    han.subarray(4),
    ...Array.from({ length: 16 }, (_, i) => Buffer.alloc(65_536, 97 + i)),
    Buffer.from('\n\n\n'),
    manyLines(250_000),
    Buffer.from('끝 줄바꿈 없음'),
  ];

  for (const consoleOutput of [false, true]) {
    it(`${consoleOutput ? '콘솔 코드 페이지' : 'UTF-8'} 줄 나누기: 줄의 차례와 내용은 한꺼번에 나눈 것과 같다`, async () => {
      const got: string[] = [];
      const out = new FakeOut();
      const reader = new PacedReader((emit) => lineSplitter(consoleOutput, emit), (l) => got.push(l));
      reader.attach(out as unknown as Readable);
      // 콘솔 출력이면 CP949 바이트 줄도 ('한글' = C7 D1 B1 DB)
      const all = consoleOutput && isWin ? [...chunks.slice(0, -1), Buffer.from([0xc7, 0xd1, 0xb1, 0xdb, 0x0a]), chunks.at(-1)!] : chunks;
      await feed(reader, out, all);
      const want = plainLines(consoleOutput, all);
      expect(got.length).toBe(want.length);
      expect(got).toEqual(want);
      expect(got.at(-1)).toBe('끝 줄바꿈 없음');
      if (consoleOutput && isWin) expect(got).toContain('한글');
      // 25만 줄 조각은 한 차례에 다 나누지 않았다 — 멈췄다가 다시 읽었다
      expect(out.pauses).toBeGreaterThan(0);
      expect(out.resumes).toBe(out.pauses);
    });
  }

  it('짧은 줄이 촘촘한 조각 하나도 한 차례에 줄 수 상한까지만 넘기고 스트림을 멈춘다 — 그사이 타이머가 돈다', async () => {
    const got: string[] = [];
    const out = new FakeOut();
    const reader = new PacedReader((emit) => lineSplitter(false, emit), (l) => got.push(l));
    reader.attach(out as unknown as Readable);
    let timerAt = -1;
    setTimeout(() => (timerAt = got.length), 0);
    out.emit('data', manyLines(300_000));
    // 같은 동기 차례에 넘긴 줄 — 줄 수 상한(과 조각 하나)까지
    expect(got.length).toBeGreaterThan(0);
    expect(got.length).toBeLessThanOrEqual(READ_SLICE_LINES + 1024);
    expect(out.paused).toBe(true);
    while (got.length < 300_000) await nextTurn();
    expect(timerAt, '타이머가 다 넘기기 전에 돌았다').toBeGreaterThanOrEqual(0);
    expect(timerAt).toBeLessThan(300_000);
    expect(got[0]).toBe('line 000000');
    expect(got.at(-1)).toBe('line 299999');
    expect(out.paused).toBe(false);
  });

  it('줄마다 무거운 소비자에게도 한 차례의 동기 일은 시간 상한(약 5ms) 근처에서 멈춘다 — 한꺼번에 하면 400ms인 조각, 처음부터 큰 조각(8KiB ≈ 80ms)으로 넘기지 않는다', async () => {
    const got: string[] = [];
    const out = new FakeOut();
    // 줄마다 0.2ms (실제 시계로 바쁘게 기다린다 — 부하에도 같은 시간)
    const reader = new PacedReader(
      (emit) => lineSplitter(false, emit),
      (l) => {
        const until = performance.now() + 0.2;
        while (performance.now() < until);
        got.push(l);
      },
    );
    reader.attach(out as unknown as Readable);
    const t0 = performance.now();
    out.emit('data', manyLines(2000));
    const sync = performance.now() - t0;
    expect(sync, `같은 차례에 ${Math.round(sync)}ms, ${got.length}줄`).toBeLessThan(READ_SLICE_MS * 8);
    expect(got.length).toBeLessThan(2000);
    while (got.length < 2000) await nextTurn();
    expect(got.at(-1)).toBe('line 001999');
  });

  it('멈춘 채 스트림이 닫히면 미룬 줄과 스트림 버퍼에 남은 조각을 그 자리에서 차례대로 모두 넘긴다 — 줄바꿈 없는 마지막 줄까지', async () => {
    const got: string[] = [];
    const out = new FakeOut();
    const reader = new PacedReader((emit) => lineSplitter(false, emit), (l) => got.push(l));
    reader.attach(out as unknown as Readable);
    out.emit('data', manyLines(300_000));
    expect(out.paused).toBe(true);
    out.buffered.push(manyLines(10, 300_000), Buffer.from('마지막'));
    reader.end();
    expect(got.length).toBe(300_011);
    expect(got.slice(-3)).toEqual(['line 300008', 'line 300009', '마지막']);
    // 닫힌 뒤에는 다음 차례가 와도, 조각이 와도 더 넘기지 않는다
    await nextTurn();
    out.emit('data', Buffer.from('늦은 줄\n'));
    expect(got.length).toBe(300_011);
  });

  it('한 번에 다 넘긴 작은 조각은 다음 차례 setImmediate를 한 번만 건다 — 자식이 사는 내내 도는 setImmediate 고리가 아니다 (프로브 zz-s5f3ti-reader-kills)', async () => {
    const got: string[] = [];
    const out = new FakeOut();
    const reader = new PacedReader((emit) => lineSplitter(false, emit), (l) => got.push(l));
    reader.attach(out as unknown as Readable);
    const spy = vi.spyOn(globalThis, 'setImmediate');
    out.emit('data', Buffer.from('one\ntwo\n'));
    await new Promise((r) => setTimeout(r, 100));
    const calls = spy.mock.calls.length;
    spy.mockRestore();
    reader.end();
    expect(got).toEqual(['one', 'two']);
    // 멈추지 않은 차례는 끝나면 다음 차례를 걸지 않는다 (nextTurn이 멈춘 때만 pump)
    expect(calls, `100ms 동안 setImmediate ${calls}번`).toBeLessThan(20);
  });
});
