import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { RUNNER_PROTOCOL_VERSION, runnerPaths } from './compileRunner';
import { createJobHelper } from './jobHelper';
import { createProcessRunner, lineSplitter, PacedReader, READ_SLICE_LINES, READ_SLICE_MS, type RunnerLog } from './processRunner';
import type { ManagedProcess, ProcessRunner, RunSpec } from './types';

const isWin = process.platform === 'win32';
const fixturesDir = fileURLToPath(new URL('./__fixtures__/', import.meta.url));
const echoFixture = join(fixturesDir, 'echo.mjs');
const treeFixture = join(fixturesDir, 'tree.mjs');
const outputFixture = join(fixturesDir, 'output.mjs');
const runnerSource = fileURLToPath(new URL('../../../resources/jobrunner/JobRunner.cs', import.meta.url));

/** 테스트가 중간에 실패해도 프로세스를 남기지 않도록 본 PID를 모아 끝에 정리한다 */
const seenPids = new Set<number>();
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

function killLeftovers(): void {
  for (const pid of seenPids) {
    if (!alive(pid)) continue;
    try {
      process.kill(pid);
    } catch {
      // 이미 끝났거나 권한 없음: 정리용이라 넘어간다
    }
  }
  seenPids.clear();
}

afterAll(() => {
  killLeftovers();
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
    killLeftovers();
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

  afterEach(() => {
    killLeftovers();
    warns.length = 0;
  });

  afterAll(async () => {
    killLeftovers();
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
    killLeftovers();
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
    killLeftovers();
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
