/**
 * CLI 프로세스 실행·종료 (계약 ./types.ts, ARCHITECTURE.md 13장, 기획서 CTL-03·CTL-07·CTL-11·15.5).
 *
 * - jobobject (Windows 기본): WookJobRunner.exe가 Job Object로 자식·후손을 묶는다.
 *   러너 stdin = 제어 채널(KILL 줄 또는 EOF → job 종료). 러너 stdout의 제어 줄은 가로채고 전달하지 않는다.
 * - taskkill (Windows 대체, 러너를 컴파일·실행할 수 없을 때): CLI를 직접 실행하고, 작업 개체 도우미(./jobHelper.ts — PowerShell)가
 *   띄우자마자 작업 개체에 넣는다. 도우미는 러너를 만들 때 미리 띄워 두고(ready), 띄우기 전에 준비를 기다린다 — 넣기 전 창에 중간
 *   프로세스가 먼저 끝나면 그 고아는 작업 개체 밖에 남기 때문이다. 그 창에 일이 시작되지 않게 표준 입력은 넣은 뒤에 준다: CLI는 프롬프트를,
 *   띄우자마자 일을 시작하는 명령(자동 검사 셸)은 그것을 읽기 전에는 아무것도 띄우지 않는 형태(RunSpec.adoptGate)로 띄워 시작 신호를.
 *   붙잡는 시간에는 상한(INPUT_HOLD_MAX_MS)이 있다 — CLI가 입력을 기다리다 포기하지 않게.
 *   종료는 작업 개체째 끝내고 taskkill /T /F로 트리를 한 번 더 끊은 뒤 작업 개체가 비었는지 확인한다.
 *   스스로 끝났으면 작업 개체에 남은 후손(부모가 먼저 끝난 고아 포함)을 정리한다. 도우미를 쓸 수 없거나, 넣지 못했거나, 넣기 전에 일이
 *   시작됐을 수 있으면(입력이 없는 실행·넣기 전에 입력을 먼저 줌·프롬프트 CLI를 준비 전에 띄우거나 JOB_ADOPT_LATE_MS 넘어 넣음) 그 전에
 *   부모가 끝난 후손은 찾지 못하므로 종료를 확인하지 못한 것(ok=false, remaining=-1)으로 알린다 — 작업 개체가 비어 보여도 완료로 치지
 *   않는다 (CTL-03·11, AC-15·29·36).
 * - pgroup (macOS·Linux): 새 세션(프로세스 그룹)으로 실행하고 그룹 전체에 SIGTERM → SIGKILL.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { readdir, rm, stat } from 'node:fs/promises';
import { delimiter, extname, isAbsolute, join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { ensureJobRunner } from './compileRunner';
import { createJobHelper, type JobHandle, type JobHelper } from './jobHelper';
import { checkPinned, type FilePin } from './pinnedFile';
import type { ExitInfo, ManagedProcess, ProcessRunner, RunnerProblem, RunSpec, TerminateResult } from './types';

export type RunnerMode = ProcessRunner['mode'];
/** orchestrator/context.ts 의 LogFn과 같은 모양 */
export type RunnerLog = (level: 'info' | 'warn' | 'error', msg: string, extra?: unknown) => void;

export interface CreateProcessRunnerOptions {
  /** 앱 데이터 폴더 (러너는 <dataDir>/bin, 표준 입력 임시 파일은 <dataDir>/tmp/stdin) */
  dataDir: string;
  /** 지정하면 그 방식만 쓴다 (jobobject 준비 실패 시 대체하지 않고 오류) */
  forceMode?: RunnerMode;
  /** JobRunner.cs 경로. 없으면 resources/jobrunner/JobRunner.cs 를 찾는다 */
  runnerSource?: string;
  log?: RunnerLog;
  /** 테스트: taskkill 방식의 작업 개체 도우미를 바꾼다 (null = 도우미를 쓸 수 없는 환경) */
  jobHelper?: JobHelper | null;
}

const DEFAULT_TERMINATE_TIMEOUT_MS = 3000;
/** 재시작 복구의 프로세스 생성 시각 조회 제한 (PowerShell 시작 + CIM 조회는 보통 1초 안팎) */
const CREATED_AT_TIMEOUT_MS = 15_000;
/** 'exit' 뒤 stdio가 닫히길 기다리는 시간 (러너 없는 방식에선 후손이 파이프를 물고 있을 수 있다) */
const CLOSE_GRACE_MS = 2000;
const SPAWN_ERROR_GRACE_MS = 1000;
const PGROUP_SIGKILL_AFTER_MS = 1000;
const PGROUP_LEFTOVER_KILL_WAIT_MS = 1500;
/** taskkill 방식: 정지 요청 때 작업 개체에 넣기(도우미가 막 뜨는 중일 수 있다)를 기다리는 상한 */
const JOB_ADOPT_WAIT_MS = 1000;
/** taskkill 방식: 프로세스를 띄우기 전에 작업 개체 도우미가 준비되기를 기다리는 상한 (PowerShell 시작 — 보통 0.2~1초) */
const HELPER_READY_WAIT_MS = 10_000;
/**
 * taskkill 방식, 프롬프트를 받는 CLI: 띄운 뒤 이보다 늦게 작업 개체에 넣었으면(넣는 순간 프로세스 목록을 찍은 시각 기준) 종료를 확인하지 못한
 * 것(-1)으로 다룬다. 프롬프트는 넣은 뒤에 주고 CLI는 프롬프트를 읽기 전에는 일을 시작하지 않으므로, 이 상한은 CLI 자신의 시작 단계(입력을
 * 읽기 전)만을 위한 여유다 — 도우미가 느려 그 시작 단계가 길게 작업 개체 밖에서 돈 실행을 확인으로 치지 않는다. 고아를 만드는 사슬을 막는
 * 상한이 아니다: cmd 이중 start 사슬은 띄운 뒤 약 20ms(실측 21~29ms에 빠짐)면 고아를 남기는데 준비된 도우미의 넣기도 보통 3~5ms, 첫 넣기·
 * 부하에서 15ms를 넘기도 한다(실측) — 시각 상한으로는 가를 수 없다. 그래서 띄우자마자 일을 시작하는 실행은 시작 신호로 붙잡고(adoptGate),
 * 붙잡을 것이 없는 실행(입력 없음)은 늘 확인하지 못한 것으로 다룬다 (adoptGap)
 */
export const JOB_ADOPT_LATE_MS = 100;
/**
 * taskkill 방식: 작업 개체에 넣을 때까지 표준 입력(프롬프트·시작 신호)을 붙잡는 상한. 넘으면 먼저 주고 그 실행은 확인 불가(-1)로 다룬다 —
 * Claude CLI는 표준 입력을 3초 기다리고 오지 않으면 입력 없이 진행하므로(프롬프트를 잃는다) 그보다 넉넉히 짧게 (S7-C3)
 */
export const INPUT_HOLD_MAX_MS = 1500;
/** taskkill 방식: CLI가 스스로 끝난 뒤 작업 개체에 남은 후손을 끝내고 비기를 기다리는 상한 (작업 개체 러너의 2초와 같다) */
const JOB_LEFTOVER_KILL_WAIT_MS = 2000;
const POLL_MS = 25;
/** 줄바꿈 없이 이보다 길면 나눠 전달한다 (메모리 보호) */
const MAX_LINE_CHARS = 32 * 1024 * 1024;
const STALE_STDIN_MS = 60 * 60 * 1000;
const CONTROL_PREFIX = '{"__wookRunner":';
/** 이 모듈이 stderr로 덧붙이는 진단 줄 */
const DIAG_PREFIX = '[욱채 프로세스]';

export async function createProcessRunner(opts: CreateProcessRunnerOptions): Promise<ProcessRunner> {
  const log = opts.log ?? defaultLog;
  const win = process.platform === 'win32';
  const forced = opts.forceMode;
  if (forced === 'pgroup' && win) throw new Error('pgroup(프로세스 그룹) 방식은 Windows에서 쓸 수 없습니다');
  if ((forced === 'jobobject' || forced === 'taskkill') && !win) {
    throw new Error(`${forced} 방식은 Windows 전용입니다`);
  }
  const ctx: Ctx = { dataDir: opts.dataDir, log };
  await removeStaleStdinFiles(opts.dataDir, log);

  if (!win) {
    return new Runner('pgroup', '프로세스 그룹 방식: 새 세션으로 실행하고 종료 때 그룹 전체에 신호를 보냅니다', ctx, null);
  }
  if (forced === 'taskkill') {
    return readyRunner(new Runner('taskkill', `taskkill 방식(설정으로 지정). ${TASKKILL_JOB_NOTE}`, ctx, null, jobHelperFor(opts, log)));
  }

  let reason: string;
  try {
    const compiled = await ensureJobRunner({ dataDir: opts.dataDir, sourcePath: opts.runnerSource });
    if (compiled.ok) {
      const runner = new Runner('jobobject', `작업 개체(Job Object) 러너: ${compiled.exePath} — ${compiled.detail}`, ctx, compiled.exePath);
      // 띄울 때마다 실행 파일 바이트를 준비할 때의 해시와 견준다 (S5-21). 다르면 한 번만 원본에서 다시 컴파일한다
      runner.pinRunner(compiled.pin, async () => {
        const again = await ensureJobRunner({ dataDir: opts.dataDir, sourcePath: opts.runnerSource, force: true });
        return again.ok ? { ok: true, pin: again.pin } : { ok: false, reason: again.reason };
      });
      return runner;
    }
    reason = compiled.reason;
  } catch (err) {
    reason = `러너 준비 중 오류: ${errorText(err)}`;
  }
  if (forced === 'jobobject') throw new Error(`작업 개체 러너를 준비하지 못했습니다: ${reason}`);
  log('warn', `작업 개체 러너를 쓸 수 없어 taskkill 방식으로 대체합니다: ${reason}`);
  return readyRunner(
    new Runner(
      'taskkill',
      `작업 개체 러너를 쓸 수 없어 taskkill 방식으로 대체했습니다 (${reason}). ${TASKKILL_JOB_NOTE}`,
      ctx,
      null,
      jobHelperFor(opts, log),
    ),
  );
}

const TASKKILL_JOB_NOTE =
  'CLI는 작업 개체 도우미(Windows PowerShell)가 작업 개체에 넣어 부모가 먼저 끝난 후손까지 정리합니다. 도우미를 쓸 수 없으면 그런 후손의 종료를 확인하지 못해 정지를 완료로 표시하지 않습니다';

/** taskkill 방식의 작업 개체 도우미. 테스트는 바꾸거나 없앨 수 있다 */
function jobHelperFor(opts: CreateProcessRunnerOptions, log: RunnerLog): JobHelper | null {
  return opts.jobHelper === undefined ? createJobHelper({ log }) : opts.jobHelper;
}

/** 도우미를 미리 띄워 준비를 기다린 뒤 러너를 돌려준다 — 첫 프로세스부터 띄우자마자 작업 개체에 넣게 (못 띄우면 그 까닭은 problem()) */
async function readyRunner(runner: Runner): Promise<Runner> {
  await runner.ready();
  return runner;
}

interface Ctx {
  dataDir: string;
  log: RunnerLog;
}

/** taskkill 방식인데 작업 개체 도우미 자체가 없을 때(테스트 이음매)의 까닭 */
const NO_HELPER = '작업 개체 도우미를 쓸 수 없는 환경입니다';
/** 작업 개체 안을 읽지 못함 (도우미가 도중에 끝남·응답 없음) */
const JOB_UNREADABLE = '작업 개체 도우미가 답하지 않아 작업 개체 안을 확인하지 못했습니다';

/** 러너 실행 파일을 원본에서 한 번 다시 컴파일한다 (해시가 달라졌을 때) */
type RunnerReensure = () => Promise<{ ok: true; pin: FilePin } | { ok: false; reason: string }>;

/** 러너 실행 파일 바꿔치기의 처지 (S5-21, 리드 결정 S6-5) */
type PinState =
  /** 준비할 때와 같다 (또는 아직 달라진 적이 없다) */
  | { kind: 'ok' }
  /** 달라져 원본에서 다시 컴파일하는 중 — 끝날 때까지 띄우지 않는다 */
  | { kind: 'reensuring' }
  /** 다시 컴파일을 이미 한 번 썼거나 실패했다 — 다시 시작할 때까지 띄우지 않는다 */
  | { kind: 'dead' };

/** 러너 파일이 달라졌을 때의 사실 글 (알림·거부·설정 화면이 같은 글을 쓴다) */
export const RUNNER_BINARY_CHANGED = '작업 개체 러너 파일(WookJobRunner.exe)이 준비할 때와 다릅니다';

class Runner implements ProcessRunner {
  private pin: FilePin | null = null;
  private reensure: RunnerReensure | null = null;
  private pinState: PinState = { kind: 'ok' };
  private reensureUsed = false;
  /** 러너 파일이 달라진 문제 (binary_changed). 다시 컴파일이 성공하면 지운다 */
  private binaryProblem: RunnerProblem | null = null;
  private readonly problemListeners = new Set<(problem: RunnerProblem) => void>();

  constructor(
    readonly mode: RunnerMode,
    private readonly baseDetail: string,
    private readonly ctx: Ctx,
    private runnerExe: string | null,
    /** taskkill 방식의 작업 개체 도우미 (러너를 만들 때 미리 띄운다) */
    private readonly jobs: JobHelper | null = null,
  ) {}

  /** jobobject 방식: 띄울 때마다 견줄 실행 파일 해시와, 달라졌을 때 한 번 쓸 다시 컴파일 */
  pinRunner(pin: FilePin, reensure: RunnerReensure): void {
    this.pin = pin;
    this.reensure = reensure;
  }

  /** 설정 화면 설명 — 지금의 실행 환경 문제(작업 개체 도우미를 쓸 수 없음·러너 파일이 달라짐)가 있으면 그 까닭을 붙인다 */
  get detail(): string {
    const problem = this.problem();
    if (!problem) return this.baseDetail;
    if (problem.kind === 'binary_changed') return `${this.baseDetail} — 지금은 러너로 아무것도 띄우지 않습니다: ${problem.text}`;
    return `${this.baseDetail} — 지금은 작업 개체 도우미를 쓸 수 없습니다: ${problem.text}`;
  }

  async ready(): Promise<void> {
    if (this.jobs) await this.jobs.ready(HELPER_READY_WAIT_MS);
  }

  problem(): RunnerProblem | null {
    if (this.mode === 'jobobject') return this.binaryProblem;
    if (this.mode !== 'taskkill') return null;
    const text = this.jobs ? this.jobs.problem() : NO_HELPER;
    return text ? { kind: 'helper_unavailable', text } : null;
  }

  onProblem(cb: (problem: RunnerProblem) => void): () => void {
    this.problemListeners.add(cb);
    const offJobs = this.jobs ? this.jobs.onProblem((text) => cb({ kind: 'helper_unavailable', text })) : () => undefined;
    return () => {
      this.problemListeners.delete(cb);
      offJobs();
    };
  }

  start(spec: RunSpec): ManagedProcess {
    return new ManagedChild(spec, this.mode, this.ctx, this.runnerExe, this.jobs, () => this.launchRefusal());
  }

  /**
   * jobobject 방식: 띄우기 바로 전(ManagedChild 생성자의 같은 동기 구간)에 러너 파일을 다시 읽어 준비할 때의 해시와 견준다 (S5-21).
   * 같으면 null. 다르면 띄우지 않을 까닭 — 처음 다르면 실행 환경 문제(binary_changed)를 알리고 원본에서 한 번 다시 컴파일한다.
   * 다시 컴파일하는 동안과, 그 한 번을 쓴 뒤 또 다르거나 다시 컴파일이 실패하면 다시 시작할 때까지 띄우지 않는다
   */
  private launchRefusal(): string | null {
    if (this.mode !== 'jobobject' || !this.pin) return null;
    if (this.pinState.kind === 'dead') return `${this.binaryProblem?.text ?? RUNNER_BINARY_CHANGED} — 이 러너로는 띄우지 않았습니다`;
    if (this.pinState.kind === 'reensuring') return `${RUNNER_BINARY_CHANGED} — 원본에서 다시 컴파일하는 중이라 띄우지 않았습니다`;
    const check = checkPinned(this.pin);
    if (check.ok) return null;
    if (this.reensureUsed || !this.reensure) {
      this.pinState = { kind: 'dead' };
      this.raiseBinaryProblem(`${RUNNER_BINARY_CHANGED} (${check.reason}) — 한 번 다시 컴파일한 뒤에도 또 달라 다시 시작할 때까지 러너로 아무것도 띄우지 않습니다`);
      return `${RUNNER_BINARY_CHANGED} (${check.reason}) — 이 러너로는 띄우지 않았습니다`;
    }
    this.reensureUsed = true;
    this.pinState = { kind: 'reensuring' };
    this.raiseBinaryProblem(`${RUNNER_BINARY_CHANGED} (${check.reason}) — 누군가 앱 데이터 폴더의 실행 파일을 바꿨을 수 있습니다. 그 파일로는 띄우지 않고 원본에서 한 번 다시 컴파일합니다`);
    const reensure = this.reensure;
    void reensure()
      .catch((err: unknown): { ok: false; reason: string } => ({ ok: false, reason: errorText(err) }))
      .then((r) => {
        if (r.ok) {
          this.pin = r.pin;
          this.runnerExe = r.pin.path;
          this.pinState = { kind: 'ok' };
          this.binaryProblem = null;
          this.ctx.log('info', `작업 개체 러너를 원본에서 다시 컴파일해 다시 씁니다: ${r.pin.path}`);
          return;
        }
        this.pinState = { kind: 'dead' };
        this.raiseBinaryProblem(`${RUNNER_BINARY_CHANGED} — 원본에서 다시 컴파일하지 못해(${r.reason}) 다시 시작할 때까지 러너로 아무것도 띄우지 않습니다`);
      });
    return `${RUNNER_BINARY_CHANGED} (${check.reason}) — 이 러너로는 띄우지 않았습니다`;
  }

  private raiseBinaryProblem(text: string): void {
    const problem: RunnerProblem = { kind: 'binary_changed', text };
    this.binaryProblem = problem;
    this.ctx.log('error', `실행 환경 문제: ${text}`);
    for (const cb of this.problemListeners) {
      try {
        cb(problem);
      } catch (err) {
        this.ctx.log('error', '실행 환경 문제 알림 처리 오류', err);
      }
    }
  }

  dispose(): void {
    this.jobs?.dispose();
  }

  async isAlive(pid: number): Promise<boolean> {
    // 0·1·음수는 POSIX에서 그룹·전체 신호가 되므로 조회도 하지 않는다
    if (!Number.isSafeInteger(pid) || pid <= 1) return false;
    // POSIX: 우리 프로세스는 늘 그룹 리더 — 리더가 끝나도 그룹이 남아 있으면 살아 있는 것으로 본다
    if (process.platform !== 'win32') return isGroupAlive(pid) || isPidAlive(pid);
    return isPidAlive(pid);
  }

  async processCreatedAt(pids: number[]): Promise<Map<number, number>> {
    const valid = unique(pids.filter((p) => Number.isSafeInteger(p) && p > 1));
    if (valid.length === 0) return new Map();
    try {
      return process.platform === 'win32' ? await createdAtWindows(valid) : await createdAtPosix(valid);
    } catch (err) {
      // 모르면 빈 결과 — 호출자는 같은 프로세스인지 확인하지 못한 것으로 보고 종료하지 않는다
      this.ctx.log('warn', `프로세스 생성 시각을 읽지 못했습니다 (PID ${valid.join(', ')})`, err);
      return new Map();
    }
  }

  async killTree(pid: number): Promise<TerminateResult> {
    const invalid = invalidTargetReason(pid);
    if (invalid) return { ok: false, remaining: -1, detail: invalid, durationMs: 0 };
    try {
      if (process.platform === 'win32') {
        const r = await killTreeWindows(pid, [], DEFAULT_TERMINATE_TIMEOUT_MS);
        // taskkill /T는 지금 살아 있는 부모-자식 연결만 따라간다. 작업 개체 러너의 트리면 러너가 끝나며 작업 개체가 닫혀 커널이 나머지를
        // 끝내지만, 작업 개체 러너가 없는 이전 실행은 부모가 먼저 끝난 후손을 확인할 수 없다 — 트리를 끊어도 종료 확인으로 치지 않는다 (CTL-03·11)
        if (this.mode === 'taskkill' && r.ok) {
          return { ok: false, remaining: -1, detail: `${r.detail}. 부모가 먼저 끝난 후손은 확인할 수 없습니다 (작업 개체 러너 없음)`, durationMs: r.durationMs };
        }
        return r;
      }
      return await killGroup(pid, DEFAULT_TERMINATE_TIMEOUT_MS, true);
    } catch (err) {
      this.ctx.log('error', `프로세스 트리 종료 중 오류 (PID ${pid})`, err);
      return { ok: false, remaining: -1, detail: `프로세스 트리 종료 중 오류: ${errorText(err)}`, durationMs: 0 };
    }
  }
}

type ControlLine =
  | { kind: 'started'; pid: number }
  | { kind: 'exit'; code: number; leftover: number; remaining: number }
  | { kind: 'terminated'; remaining: number };

type Launch = { ok: true; file: string; args: string[]; detached: boolean } | { ok: false; reason: string };

class ManagedChild implements ManagedProcess {
  readonly pid: number | null;
  readonly childPid: Promise<number | null>;
  readonly exited: Promise<ExitInfo>;

  private readonly t0 = performance.now();
  private readonly label: string;
  private readonly stdoutFan: LineFanout;
  private readonly stderrFan: LineFanout;
  /** stdout·stderr 읽기와 줄 나누기 — 이벤트 루프 한 차례에 정해진 만큼만 나눠 넘긴다 (리드 결정 S5-42) */
  private readonly stdoutLines: PacedReader;
  private readonly stderrLines: PacedReader;
  private readonly router: RunnerStdoutRouter | null;
  private readonly childPidDeferred = deferred<number | null>();
  private readonly exitedDeferred = deferred<ExitInfo>();
  /** 프로세스가 끝났다 ('exit' 또는 시작 실패) */
  private readonly exitSeen = deferred<void>();
  /** stdio까지 닫혔다 — 이후 줄은 더 오지 않는다 */
  private readonly closed = deferred<void>();
  private child: ChildProcessWithoutNullStreams | null = null;
  private launchFile = '';
  private stdinFile: string | null = null;
  private knownChildPid: number | null = null;
  private spawnError: Error | null = null;
  private exitCode: number | null = null;
  private exitSignal: NodeJS.Signals | null = null;
  /** terminate() 요청 뒤에 프로세스가 끝났는지 = ExitInfo.terminated */
  private exitAfterTerminate = false;
  private closeHandled = false;
  private graceTimer: NodeJS.Timeout | null = null;
  private finalControl: ControlLine | null = null;
  /** pgroup: 리더가 끝나자마자 시작한 남은 후손 정리 (후손이 파이프를 물고 있으면 그래야 stdio가 닫힌다) */
  private leftoverCleanup: Promise<{ leftover: number; remaining: number }> | null = null;
  private terminateRequested = false;
  private terminatePromise: Promise<TerminateResult> | null = null;
  private exitInfo: ExitInfo | null = null;
  /** taskkill 방식: 이 프로세스(와 후손)를 넣은 작업 개체. 도우미를 쓸 수 없으면 null — 부모가 먼저 끝난 후손은 확인 불가 */
  private job: Promise<JobHandle | null> = Promise.resolve(null);
  /**
   * taskkill 방식: 작업 개체가 이 트리를 다 담지 못했을 수 있는 까닭 (못 넣음·다른 프로세스·넣기 전에 일이 시작됐을 수 있음, adoptGap).
   * null이면 일이 시작되기 전에 넣었다. job이 풀릴 때 정해진다 — 까닭이 있으면 작업 개체가 비어도 종료를 확인하지 못한 것(-1)이다
   */
  private jobGap: string | null = null;
  /** taskkill 방식인데 작업 개체 도우미가 없다 (테스트 이음매·도우미 없는 환경) */
  private readonly jobsAbsent: boolean;
  /** taskkill 방식: 넣기 전에 일이 시작되지 않게 무엇으로 붙잡는지 (adoptGap) */
  private hold: InputHold = 'none';
  /** taskkill 방식: 넣기를 INPUT_HOLD_MAX_MS 넘게 기다려 넣기 전에 입력을 실제로 썼다 — 붙잡은 일이 넣기 전에 시작됐을 수 있다 (정지 요청으로 주지 않았으면 false) */
  private inputEarly = false;

  constructor(
    spec: RunSpec,
    private readonly mode: RunnerMode,
    private readonly ctx: Ctx,
    runnerExe: string | null,
    jobs: JobHelper | null = null,
    /** jobobject 방식: 띄우기 바로 전 러너 파일 해시 확인 (S5-21). 띄우지 않을 까닭 또는 null */
    private readonly launchCheck: () => string | null = () => null,
  ) {
    this.jobsAbsent = mode === 'taskkill' && !jobs;
    this.label = spec.label;
    this.childPid = this.childPidDeferred.promise;
    this.exited = this.exitedDeferred.promise;
    this.stdoutFan = new LineFanout(ctx, spec.label, 'stdout');
    this.stderrFan = new LineFanout(ctx, spec.label, 'stderr');
    this.router =
      mode === 'jobobject' ? new RunnerStdoutRouter((line) => this.stdoutFan.emit(line), (pid) => this.onStarted(pid)) : null;
    const router = this.router;
    const splitter = (emit: (line: string) => void): Splitter => lineSplitter(spec.consoleOutput === true, emit);
    this.stdoutLines = new PacedReader(splitter, router ? (line) => router.push(line) : (line) => this.stdoutFan.emit(line));
    this.stderrLines = new PacedReader(splitter, (line) => this.stderrFan.emit(line));

    const launch = this.prepareLaunch(spec, runnerExe);
    if (!launch.ok) {
      this.pid = null;
      this.failEarly(launch.reason);
      return;
    }
    this.launchFile = launch.file;
    // taskkill 방식에서 cmd 명령줄을 그대로 넘긴다 (windows:F4). jobobject 방식은 러너가 --verbatim-args로 같은 일을 한다
    const verbatim = this.mode === 'taskkill' && spec.verbatimArgs === true;
    // 띄우는 순간 도우미가 준비돼 있어야 넣기 전 창이 수십 ms로 짧다 (준비 전이면 PowerShell 시작을 기다리는 동안 고아가 빠질 수 있다)
    const helperReady = this.mode === 'taskkill' && jobs ? jobs.isReady() : false;
    // taskkill 방식: 넣기 전에 일이 시작되지 않게 입력을 넣은 뒤에 준다. 띄우자마자 일을 시작하는 명령(자동 검사 셸)은 시작 신호를 읽고서야
    // 시작하는 형태로 띄운다 — 작업 개체 러너가 자식을 일시 중지 상태로 넣은 뒤 시작하는 것과 같은 효과 (S7-C1)
    const adopting = this.mode === 'taskkill' && jobs !== null;
    const gate = adopting && spec.stdinText === null && spec.adoptGate ? spec.adoptGate : null;
    const args = gate ? gate.args : launch.args;
    const input = gate ? gate.go : spec.stdinText;
    if (adopting) this.hold = gate ? 'gate' : input !== null ? 'prompt' : 'none';
    const spawnStart = Date.now();
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(launch.file, args, {
        cwd: spec.cwd,
        env: spec.env,
        windowsHide: true,
        detached: launch.detached,
        windowsVerbatimArguments: verbatim,
        // verbatim이면 argv[0]도 그대로 들어가므로 공백 있는 경로는 직접 감싼다
        ...(verbatim && /\s/.test(launch.file) ? { argv0: `"${launch.file}"` } : {}),
      });
    } catch (err) {
      this.pid = null;
      this.failEarly(`실행하지 못했습니다: ${launch.file} (${errorText(err)})`);
      return;
    }
    // 넣기 늦음(JOB_ADOPT_LATE_MS)은 자식이 생긴 뒤(spawn()이 돌아온 뒤)부터 잰다 — spawn() 자체가 바쁜 PC에서 오래 걸려도 그 시간은 넣기 지연이 아니다
    // (리드 결정 S5-52.5). 작업 개체 창의 아래 끝(notBefore)은 spawnStart 그대로다 — 자식은 spawn() 도중에 생겨 그보다 늦지 않다
    const spawnReturned = Date.now();
    this.child = child;
    this.pid = child.pid ?? null;
    if (this.mode === 'taskkill' && jobs && this.pid !== null) {
      // 띄우자마자 작업 개체에 넣는다 — 그 뒤 생기는 후손은 부모가 먼저 끝나도 작업 개체에 남는다 (넣기 전 후손은 도우미가 함께 넣는다).
      // 넣기 전에 중간 프로세스가 먼저 끝나 남긴 고아는 찾을 수 없으므로, 넣은 결과로 그런 창이 있었는지 정한다 (adoptGap)
      this.job = jobs.adopt(this.pid, { notBefore: spawnStart, notAfter: Date.now() }).then(
        (h) => {
          this.jobGap = adoptGap(h, { hold: this.hold, helperReady, spawnReturned, inputEarly: this.inputEarly });
          if (this.jobGap) this.ctx.log('warn', `작업 개체가 이 프로세스 트리를 다 담지 못했을 수 있습니다 (${this.label}): ${this.jobGap}`);
          return h;
        },
        (err: unknown) => {
          this.ctx.log('warn', `작업 개체에 넣지 못했습니다 (${this.label})`, err);
          this.jobGap = '작업 개체에 넣지 못했습니다';
          return null;
        },
      );
    }
    this.wire(child, input, adopting);
  }

  onStdoutLine(cb: (line: string) => void): void {
    this.stdoutFan.add(cb);
  }

  onStderrLine(cb: (line: string) => void): void {
    this.stderrFan.add(cb);
  }

  terminate(opts?: { timeoutMs?: number; reason?: string }): Promise<TerminateResult> {
    if (!this.terminatePromise) {
      this.terminatePromise = this.doTerminate(opts?.timeoutMs ?? DEFAULT_TERMINATE_TIMEOUT_MS, opts?.reason);
    }
    return this.terminatePromise;
  }

  // ---- 시작 ----

  private prepareLaunch(spec: RunSpec, runnerExe: string | null): Launch {
    const resolved = resolveCommand(spec);
    if (!resolved.ok) return resolved;
    if (!isDirectory(spec.cwd)) return { ok: false, reason: `작업 폴더가 없습니다: ${spec.cwd}` };
    if (this.mode === 'jobobject') {
      if (!runnerExe) return { ok: false, reason: '작업 개체 러너 경로가 없습니다' };
      // 러너 파일이 준비할 때와 같은지 — spawn과 같은 동기 구간 (await 없음). 다르면 표준 입력 임시 파일도 만들지 않는다
      const refused = this.launchCheck();
      if (refused) return { ok: false, reason: refused };
      const args: string[] = [];
      if (spec.stdinText !== null) {
        try {
          this.stdinFile = writeStdinFile(this.ctx.dataDir, spec.stdinText);
        } catch (err) {
          return { ok: false, reason: `표준 입력 임시 파일을 만들지 못했습니다 (${errorText(err)})` };
        }
        args.push('--stdin-file', this.stdinFile);
      }
      // 러너 자신은 일반 인용으로 띄운다 — 러너가 원래 문자열을 그대로 돌려받아 자식 명령줄에 인용 없이 붙인다 (windows:F4)
      if (spec.verbatimArgs) args.push('--verbatim-args');
      args.push('--', resolved.path, ...spec.args);
      return { ok: true, file: runnerExe, args, detached: false };
    }
    // pgroup: detached → setsid()로 새 세션·그룹의 리더가 된다
    return { ok: true, file: resolved.path, args: spec.args, detached: this.mode === 'pgroup' };
  }

  private wire(child: ChildProcessWithoutNullStreams, input: string | null, adopting: boolean): void {
    child.on('spawn', () => {
      if (this.mode !== 'jobobject') this.setChildPid(child.pid ?? null);
    });
    child.on('error', (err) => this.onChildError(err));
    child.on('exit', (code, signal) => this.onExit(code, signal));
    child.on('close', () => this.onClose());
    // 줄바꿈이 촘촘한 빠른 출력에도 한 차례에 정해진 만큼만 나누고 다음 차례로 넘긴다 — 타이머·요청·긴급 정지가 차례를 얻는다 (리드 결정 S5-42)
    this.stdoutLines.attach(child.stdout);
    this.stderrLines.attach(child.stderr);
    child.stdout.on('error', (err) => this.ctx.log('warn', `stdout 읽기 오류 (${this.label})`, err));
    child.stderr.on('error', (err) => this.ctx.log('warn', `stderr 읽기 오류 (${this.label})`, err));
    child.stdin.on('error', (err) => {
      // 프로세스가 입력을 다 읽기 전에 끝나면 파이프가 닫혀 있다 — 정상적인 경우
      if (!isPipeClosedError(err)) this.ctx.log('warn', `stdin 쓰기 오류 (${this.label})`, err);
    });
    if (this.mode === 'jobobject') return; // 러너 stdin은 제어 채널: 열어 둔다 (닫히면 러너가 트리를 끝낸다)
    if (input === null) {
      child.stdin.end();
      return;
    }
    const give = (beforeAdoption = false): void => {
      // 넣기를 기다리는 사이 정지 요청이 왔으면 주지 않는다 — 시작 신호(또는 입력 끝)를 받으면 정지된 실행이 일을 시작한다. 프로세스는 정지가 끝낸다.
      // 주지 않은 입력은 먼저 준 것이 아니다: 붙잡은 일은 시작되지 않았으므로 확인 불가의 까닭(inputEarly)으로 적지 않는다 (S8-C2)
      if (this.terminateRequested) return;
      if (beforeAdoption) {
        // 넣기 전에 실제로 입력을 쓴다 — 이때만 붙잡은 일이 넣기 전에 시작됐을 수 있다 (adoptGap). 상한 타이머의 같은 차례 안이라 넣은 결과보다 먼저 적힌다
        this.inputEarly = true;
        this.ctx.log('warn', `작업 개체에 ${INPUT_HOLD_MAX_MS}ms 안에 넣지 못해 입력을 먼저 줍니다 (${this.label}) — 이 실행의 후손 종료는 확인하지 못한 것으로 다룹니다`);
      }
      try {
        child.stdin.end(input, 'utf8');
      } catch (err) {
        if (!isPipeClosedError(err as Error)) this.ctx.log('warn', `stdin 쓰기 오류 (${this.label})`, err);
      }
    };
    // taskkill 방식: 작업 개체에 넣은 뒤에 입력(프롬프트·시작 신호)을 준다 — 그것을 읽고서야 일을 시작하는 실행은 넣기 전에 후손을 만들지 못한다
    if (adopting) void this.holdInputUntilAdopted().then((adopted) => give(!adopted));
    else give();
  }

  /**
   * taskkill 방식: 작업 개체에 넣을 때까지(상한 INPUT_HOLD_MAX_MS) 입력을 붙잡는다. 넣었으면 true. 상한이 먼저면 false — CLI가 입력을 기다리다
   * 포기하지 않게(Claude CLI는 3초) 입력을 먼저 주되, 실제로 주면 붙잡은 일이 넣기 전에 시작됐으므로 그 실행은 확인 불가(-1)가 된다
   * (give → inputEarly, adoptGap, S7-C3). 그사이 정지 요청이 왔으면 주지 않으므로 확인 불가의 까닭도 아니다 (S8-C2)
   */
  private holdInputUntilAdopted(): Promise<boolean> {
    return settlesWithin(this.job, INPUT_HOLD_MAX_MS);
  }

  private onStarted(pid: number): void {
    this.setChildPid(pid);
    // 러너가 내용을 이미 메모리로 읽었으므로 바로 지운다
    void this.removeStdinFile();
  }

  private setChildPid(pid: number | null): void {
    if (pid !== null && this.knownChildPid === null) this.knownChildPid = pid;
    this.childPidDeferred.resolve(pid);
  }

  private onChildError(err: Error): void {
    if (this.child && this.child.pid === undefined && !this.spawnError) {
      // 시작 실패: 보통 'close'가 뒤따르지만 안 오면 직접 마무리한다
      this.spawnError = err;
      this.exitSeen.resolve();
      setTimeout(() => this.onClose(), SPAWN_ERROR_GRACE_MS).unref();
      return;
    }
    this.ctx.log('warn', `프로세스 오류 (${this.label})`, err);
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.exitCode = code;
    this.exitSignal = signal;
    this.exitAfterTerminate = this.terminateRequested;
    this.exitSeen.resolve();
    if (this.mode === 'pgroup' && !this.terminateRequested && this.pid !== null) {
      this.leftoverCleanup = cleanupLeftoverGroup(this.pid);
    }
    // taskkill 방식도 CLI가 끝나자마자 작업 개체에 남은 후손을 정리한다 (후손이 파이프를 물고 있으면 그래야 stdio가 닫힌다)
    if (this.mode === 'taskkill' && !this.terminateRequested) this.leftoverCleanup = this.cleanupJobLeftovers();
    if (!this.closeHandled && !this.graceTimer) {
      this.graceTimer = setTimeout(() => this.onClose(), CLOSE_GRACE_MS);
      this.graceTimer.unref();
    }
  }

  private onClose(): void {
    if (this.closeHandled) return;
    this.closeHandled = true;
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = null;
    // 다음 차례로 미룬 것(스트림에 쌓인 조각·이 차례에 다 넘기지 못한 줄)과 줄바꿈 없는 마지막 조각은 닫기 전에 모두 넘긴다 — 줄의 차례와 내용은 그대로다
    // (리드 결정 S5-42)
    this.stdoutLines.end();
    this.stderrLines.end();
    const child = this.child;
    if (child) {
      // 후손이 파이프를 물고 있어 닫히지 않았으면 더 기다리지 않는다
      if (!child.stdout.destroyed) child.stdout.destroy();
      if (!child.stderr.destroyed) child.stderr.destroy();
      if (!child.stdin.destroyed) child.stdin.destroy();
    }
    if (this.router) this.finalControl = this.router.end();
    this.exitSeen.resolve();
    this.closed.resolve();
    void this.finalize();
  }

  private failEarly(reason: string): void {
    this.setChildPid(null);
    this.exitSeen.resolve();
    this.closed.resolve();
    // 호출자가 start() 직후 등록한 처리기가 진단 줄을 받도록 다음 차례에 알린다
    setImmediate(() => {
      void this.removeStdinFile().then(() => {
        this.stderrFan.emit(`${DIAG_PREFIX} ${reason}`);
        this.settle({ code: -1, signal: null, leftoverKilled: 0, remaining: 0, durationMs: this.elapsed(), terminated: false });
      });
    });
  }

  // ---- 종료 정보 ----

  private async finalize(): Promise<void> {
    let info: ExitInfo;
    try {
      info = await this.computeExitInfo();
    } catch (err) {
      this.ctx.log('error', `종료 정보 계산 중 오류 (${this.label})`, err);
      info = {
        code: this.exitCode,
        signal: this.exitSignal,
        leftoverKilled: 0,
        remaining: -1,
        durationMs: this.elapsed(),
        terminated: this.exitAfterTerminate,
      };
    }
    await this.removeStdinFile();
    this.setChildPid(null);
    this.settle(info);
  }

  private settle(info: ExitInfo): void {
    if (this.exitInfo) return;
    this.exitInfo = info;
    this.exitedDeferred.resolve(info);
  }

  private async computeExitInfo(): Promise<ExitInfo> {
    if (this.spawnError) {
      const what = this.mode === 'jobobject' ? '작업 개체 러너를 실행하지 못했습니다' : '실행하지 못했습니다';
      this.stderrFan.emit(`${DIAG_PREFIX} ${what}: ${this.launchFile} (${errorText(this.spawnError)})`);
      return { code: -1, signal: null, leftoverKilled: 0, remaining: 0, durationMs: this.elapsed(), terminated: false };
    }
    if (this.mode === 'jobobject') return this.jobExitInfo();
    if (this.mode === 'taskkill') {
      if (this.exitAfterTerminate && this.terminatePromise) {
        // taskkill /F로 끝난 프로세스의 종료 코드(1)는 CLI 결과가 아니다
        const result = await this.terminatePromise;
        return {
          code: null,
          signal: 'SIGKILL',
          leftoverKilled: 0,
          remaining: result.remaining,
          durationMs: this.elapsed(),
          terminated: true,
          ...(result.remaining !== 0 ? { detail: result.detail } : {}),
        };
      }
      // 스스로 끝남: 작업 개체에 남은 후손(부모가 먼저 끝난 고아 포함)을 정리한 결과. 작업 개체가 없거나 다 담지 못했으면 확인 불가(-1)
      const { leftover, remaining } = await (this.leftoverCleanup ?? this.cleanupJobLeftovers());
      return {
        code: this.exitCode,
        signal: this.exitSignal,
        leftoverKilled: leftover,
        remaining,
        durationMs: this.elapsed(),
        terminated: false,
        ...(remaining < 0 ? { detail: this.unconfirmedDetail() } : {}),
      };
    }
    // pgroup: 종료 요청 뒤에 끝났으면 그 확인 결과, 스스로 끝났으면 남은 후손 정리 결과
    if (this.exitAfterTerminate && this.terminatePromise) {
      const result = await this.terminatePromise;
      return {
        code: this.exitCode,
        signal: this.exitSignal,
        leftoverKilled: 0,
        remaining: result.remaining,
        durationMs: this.elapsed(),
        terminated: true,
      };
    }
    const cleanup =
      this.leftoverCleanup ?? (this.pid === null ? Promise.resolve({ leftover: 0, remaining: 0 }) : cleanupLeftoverGroup(this.pid));
    const { leftover, remaining } = await cleanup;
    return {
      code: this.exitCode,
      signal: this.exitSignal,
      leftoverKilled: leftover,
      remaining,
      durationMs: this.elapsed(),
      terminated: this.exitAfterTerminate,
    };
  }

  private async jobExitInfo(): Promise<ExitInfo> {
    const control = this.finalControl;
    if (control?.kind === 'exit') {
      return {
        code: control.code,
        signal: null,
        leftoverKilled: control.leftover,
        remaining: control.remaining,
        durationMs: this.elapsed(),
        terminated: this.exitAfterTerminate,
      };
    }
    if (control?.kind === 'terminated') {
      return {
        code: null,
        signal: 'SIGKILL',
        leftoverKilled: 0,
        remaining: control.remaining,
        durationMs: this.elapsed(),
        terminated: this.exitAfterTerminate,
      };
    }
    // 러너가 보고 없이 끝남 (외부에서 강제 종료 등): job 핸들이 닫혀 커널이 job을 정리하지만 확인은 못 했다
    this.stderrFan.emit(
      `${DIAG_PREFIX} 작업 개체 러너가 종료 보고 없이 끝났습니다 (러너 종료 코드 ${String(this.exitCode)}${
        this.exitSignal ? `, 신호 ${this.exitSignal}` : ''
      })`,
    );
    let remaining = -1;
    if (this.exitAfterTerminate && this.terminatePromise) remaining = (await this.terminatePromise).remaining;
    return {
      code: null,
      signal: this.exitSignal,
      leftoverKilled: 0,
      remaining,
      durationMs: this.elapsed(),
      terminated: this.exitAfterTerminate,
    };
  }

  // ---- 종료 요청 ----

  private async doTerminate(timeoutMs: number, reason: string | undefined): Promise<TerminateResult> {
    const t0 = performance.now();
    try {
      if (this.exitInfo) return alreadyExited(this.exitInfo, ms(t0));
      this.terminateRequested = true;
      if (reason) this.ctx.log('info', `프로세스 종료 요청 (${this.label}): ${reason}`);
      if (!this.child || this.pid === null) {
        // 시작 실패(pid 없음): 'close'·failEarly가 곧 마무리한다
        await this.closed.promise;
        return { ok: true, remaining: 0, detail: '시작하지 못한 프로세스라 끝낼 것이 없습니다', durationMs: ms(t0) };
      }
      if (this.mode === 'jobobject') return await this.terminateJob(this.pid, timeoutMs, t0);
      if (this.mode === 'taskkill') return await this.terminateTaskkill(this.pid, timeoutMs, t0);
      return await this.terminateGroup(this.pid, timeoutMs, t0);
    } catch (err) {
      this.ctx.log('error', `프로세스 종료 중 오류 (${this.label})`, err);
      return { ok: false, remaining: -1, detail: `종료 처리 중 오류: ${errorText(err)}`, durationMs: ms(t0) };
    }
  }

  private async terminateJob(runnerPid: number, timeoutMs: number, t0: number): Promise<TerminateResult> {
    this.sendKill();
    if (await settlesWithin(this.closed.promise, timeoutMs)) {
      const control = this.finalControl;
      const childAlive = this.knownChildPid !== null && isPidAlive(this.knownChildPid);
      if (control && control.kind !== 'started') {
        const remaining = childAlive ? Math.max(1, control.remaining) : control.remaining;
        const what =
          control.kind === 'terminated'
            ? '작업 개체로 프로세스 트리를 종료했습니다'
            : '종료 요청 중 CLI가 먼저 끝나 남은 후손을 정리했습니다';
        if (remaining === 0) return { ok: true, remaining: 0, detail: what, durationMs: ms(t0) };
        // 러너가 작업 개체 상태를 읽지 못했다(-1) — 남았다고 쓰지 않고 확인하지 못했다고 쓴다 (S7-D3, CTL-11)
        if (remaining < 0) return { ok: false, remaining: -1, detail: `${what}. 하지만 작업 개체 상태를 읽지 못해 남은 프로세스가 없는지 확인하지 못했습니다`, durationMs: ms(t0) };
        return {
          ok: false,
          remaining,
          detail: `${what}. 하지만 남은 프로세스가 있습니다 (${remaining}개${childAlive ? `, CLI PID ${String(this.knownChildPid)} 생존` : ''})`,
          durationMs: ms(t0),
        };
      }
      return {
        ok: false,
        remaining: -1,
        detail: '러너가 종료 보고 없이 끝났습니다. 작업 개체가 닫혀 커널이 남은 프로세스를 끝내지만 확인하지 못했습니다',
        durationMs: ms(t0),
      };
    }
    // 러너가 응답하지 않음 → 러너째 강제 종료 (job 핸들이 닫히며 job 안 프로세스도 종료된다)
    const extra = this.knownChildPid !== null ? [this.knownChildPid] : [];
    const fallback = await killTreeWindows(runnerPid, extra, DEFAULT_TERMINATE_TIMEOUT_MS);
    return {
      ok: false,
      remaining: fallback.remaining,
      detail: `러너가 ${timeoutMs}ms 안에 종료를 보고하지 않아 taskkill /T /F로 러너를 강제 종료했습니다: ${fallback.detail}`,
      durationMs: ms(t0),
    };
  }

  /**
   * taskkill 방식 종료: 작업 개체째 끝내고(부모가 먼저 끝난 후손까지) taskkill /T /F로 트리를 한 번 더 끊은 뒤, CLI 종료와 작업 개체가
   * 빈 것까지 확인해야 ok. 작업 개체가 없으면(도우미를 쓸 수 없음) 부모가 먼저 끝난 후손은 찾지 못하므로 ok=false·remaining=-1로
   * 알린다 — 긴급 정지는 이를 완료로 표시하지 않는다 (CTL-03·07, 15.5, AC-15·29)
   */
  private async terminateTaskkill(pid: number, timeoutMs: number, t0: number): Promise<TerminateResult> {
    const deadline = t0 + timeoutMs;
    const left = (): number => Math.max(0, deadline - performance.now());
    if (this.leftoverCleanup) {
      // CLI가 이미 스스로 끝나 작업 개체에 남은 후손을 정리하는 중이다 — 그 결과로 답한다
      const r = await settleOr(this.leftoverCleanup, left(), { leftover: 0, remaining: -1 });
      if (r.remaining === 0) return { ok: true, remaining: 0, detail: '이미 종료됐고 남은 후손도 정리했습니다', durationMs: ms(t0) };
      return { ok: false, remaining: r.remaining, detail: `이미 종료됐지만 남은 후손 프로세스를 ${r.remaining < 0 ? '확인하지 못했습니다' : `${r.remaining}개 끝내지 못했습니다`}`, durationMs: ms(t0) };
    }
    const job = await settleOr(this.job, Math.min(JOB_ADOPT_WAIT_MS, left()), null);
    // 넣기를 기다리지 못했으면, 늦게라도 넣은 작업 개체는 그 안을 끝내고 닫는다 (정지 요청이 있었다 — 핸들도 남기지 않는다)
    if (!job) this.finishLateJob();
    const jobKilled = job ? await settleOr(job.terminate(), left(), false) : false;
    const tree = await killTreeWindows(pid, [], Math.max(500, left()));
    const exitedInTime = await settlesWithin(this.exitSeen.promise, left());
    if (!exitedInTime) {
      if (job) job.close();
      return {
        ok: false,
        remaining: Math.max(1, tree.remaining),
        detail: `${timeoutMs}ms 안에 CLI 프로세스 종료를 확인하지 못했습니다 (${tree.detail})`,
        durationMs: ms(t0),
      };
    }
    if (!job) {
      return {
        ok: false,
        remaining: tree.ok ? -1 : tree.remaining,
        detail: `${tree.detail}. ${this.unconfirmedDetail()}`,
        durationMs: ms(t0),
      };
    }
    const remaining = await waitJobEmpty(job, deadline);
    job.close();
    if (remaining === 0 && tree.ok && this.jobGap) {
      // 작업 개체는 비었지만 넣기 전 창에 부모가 먼저 끝난 후손은 그 안에 없다 — 종료 확인으로 치지 않는다 (CTL-03, AC-15·29)
      return { ok: false, remaining: -1, detail: `작업 개체로 프로세스 트리를 종료했지만 ${this.unconfirmedDetail()}`, durationMs: ms(t0) };
    }
    if (remaining === 0 && tree.ok) {
      return { ok: true, remaining: 0, detail: `작업 개체로 프로세스 트리를 종료했습니다${jobKilled ? '' : ` (${tree.detail})`}`, durationMs: ms(t0) };
    }
    if (remaining < 0 && tree.ok) {
      // 작업 개체 안을 읽지 못했다(도우미가 도중에 끝남·응답 없음): taskkill로 끊은 트리는 끝났지만 부모가 먼저 끝난 후손은 확인하지 못했다 —
      // 남았다고 쓰지 않고 확인하지 못했다고 쓴다 (S7-D3, CTL-11, 12장). '종료되지 않은 프로세스가 있습니다'는 남은 프로세스를 셌을 때만 쓴다
      return { ok: false, remaining: -1, detail: `${JOB_UNREADABLE}. ${tree.detail}`, durationMs: ms(t0) };
    }
    // 남은 프로세스를 셌다 — 작업 개체 안에 남았거나, 작업 개체를 읽지 못했어도 taskkill 뒤에 살아 있는 트리 프로세스를 봤다 (그 수 이상 남음)
    return {
      ok: false,
      remaining: Math.max(remaining, tree.ok ? 0 : tree.remaining),
      detail: `종료되지 않은 프로세스가 있습니다 (작업 개체 ${remaining < 0 ? '확인 불가' : `${remaining}개`}; ${tree.detail})`,
      durationMs: ms(t0),
    };
  }

  /**
   * taskkill 방식: CLI가 스스로 끝난 뒤 작업 개체에 남은 후손(개발 서버·부모가 먼저 끝난 고아)을 끝내고 비었는지 확인한다
   * (작업 개체 러너의 exit 처리와 같다, CTL-07·11, AC-36). 작업 개체가 없으면 확인 불가(-1)
   */
  private async cleanupJobLeftovers(): Promise<{ leftover: number; remaining: number }> {
    const job = await this.job;
    if (!job) return { leftover: 0, remaining: -1 };
    // 넣기 전 창이 있었으면 작업 개체를 비워도 그 밖에 남은 고아는 확인하지 못한 것이다 (-1, CTL-11 — 다음 턴을 겹쳐 띄우지 않게)
    const gap = this.jobGap !== null;
    const listed = await job.list();
    if (listed === null) {
      job.close();
      this.jobGap ??= JOB_UNREADABLE;
      return { leftover: 0, remaining: -1 };
    }
    if (listed.length === 0) {
      job.close();
      return { leftover: 0, remaining: gap ? -1 : 0 };
    }
    const leftover = listed.filter((p) => p !== this.pid).length;
    await job.terminate();
    const remaining = await waitJobEmpty(job, performance.now() + JOB_LEFTOVER_KILL_WAIT_MS);
    job.close();
    if (remaining < 0) this.jobGap ??= JOB_UNREADABLE;
    if (leftover > 0) {
      this.ctx.log('info', `CLI가 끝난 뒤 남은 하위 프로세스 ${leftover}개를 작업 개체로 정리했습니다 (${this.label})${remaining ? ` — 남음 ${remaining < 0 ? '확인 불가' : remaining}` : ''}`);
    }
    return { leftover, remaining: gap && remaining === 0 ? -1 : remaining };
  }

  /** 정지가 넣기를 기다리지 못하고 지나간 뒤에 넣은 작업 개체: 그 안을 끝내고 핸들을 닫는다 */
  private finishLateJob(): void {
    void this.job.then((h) => {
      if (!h) return;
      void h.terminate().finally(() => h.close());
    });
  }

  /** 남은 후손을 확인하지 못한 까닭 (기록·종료 결과용) */
  private unconfirmedDetail(): string {
    const why = this.jobGap ?? (this.jobsAbsent ? '작업 개체 도우미를 쓸 수 없습니다' : '작업 개체에 아직 넣지 못했습니다');
    return `${why} — 부모가 먼저 끝난 후손 프로세스는 종료를 확인하지 못했습니다`;
  }

  private async terminateGroup(pgid: number, timeoutMs: number, t0: number): Promise<TerminateResult> {
    const result = await killGroup(pgid, timeoutMs, false);
    const exitedInTime = await settlesWithin(this.exitSeen.promise, Math.max(0, timeoutMs - ms(t0)));
    if (!exitedInTime) {
      return {
        ok: false,
        remaining: Math.max(1, result.remaining),
        detail: `${timeoutMs}ms 안에 CLI 프로세스 종료를 확인하지 못했습니다 (${result.detail})`,
        durationMs: ms(t0),
      };
    }
    return { ...result, durationMs: ms(t0) };
  }

  /** KILL을 쓰고 닫는다: 쓰기가 실패해도 EOF가 같은 효과를 낸다 */
  private sendKill(): void {
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed || stdin.writableEnded) return;
    stdin.end('KILL\n');
  }

  private async removeStdinFile(): Promise<void> {
    const file = this.stdinFile;
    if (!file) return;
    try {
      await rm(file, { force: true });
      if (this.stdinFile === file) this.stdinFile = null;
    } catch (err) {
      this.ctx.log('warn', `표준 입력 임시 파일을 지우지 못했습니다: ${file}`, err);
    }
  }

  private elapsed(): number {
    return ms(this.t0);
  }
}

// ---- 줄 처리 ----

export interface Splitter {
  push(chunk: Buffer): void;
  /** 스트림 끝: 줄바꿈 없는 마지막 조각도 한 줄로 전달 */
  end(): void;
}

/** 줄 나누기 — 콘솔 코드 페이지로 쓰는 프로그램(cmd 등)은 줄마다 UTF-8 → CP949 순서로 읽는다 (windows:F10). 그 밖은 UTF-8 스트림 */
export function lineSplitter(consoleOutput: boolean, emit: (line: string) => void): Splitter {
  return consoleOutput && process.platform === 'win32' ? new ConsoleLineSplitter(emit) : new LineSplitter(emit);
}

/** 자식 출력 읽기의 한 차례 상한 — 시간. 넘으면 스트림을 멈추고 다음 차례(setImmediate)에 잇는다 (리드 결정 S5-42) */
export const READ_SLICE_MS = 5;
/**
 * 같은 상한 — 줄 수. 짧은 줄을 가장 싸게 받는 소비자(UTF-8 줄 나누기 + 줄 세기)는 이 PC에서 5ms에 17만~20만 줄을 넘겼고(실측) 그때만 줄 수가 먼저 닿는다 —
 * 처리량은 상한이 없을 때와 같았다. host_exec(콘솔 코드 페이지 + 출력 모으기)는 5ms에 약 1만 7천 줄이라 시간 상한이 먼저다. 시계는 조각마다 본다
 */
export const READ_SLICE_LINES = 100_000;
/**
 * 한 번에 줄 나누기에 넘기는 크기의 범위 — 조각마다(줄 경계에서 자른다) 시계와 줄 수를 본다. 조각 하나가 READ_PIECE_TARGET_MS를 넘기면 다음 조각을 반으로,
 * 한참 밑돌면 두 배로 한다: 줄마다 무거운 소비자도 한 차례가 5ms 근처에서 멈추고, 가벼운 소비자는 큰 조각으로 확인을 줄인다(몇십 줄마다 보면 가장 싼 소비자에게는
 * 그 확인 — Buffer 찾기·조각마다의 해석 — 이 일의 절반이 됐다, 실측)
 */
const READ_PIECE_MIN_BYTES = 256;
const READ_PIECE_MAX_BYTES = 8 * 1024;
const READ_PIECE_TARGET_MS = 1;

/**
 * 자식 출력 한 갈래(stdout·stderr)의 읽기와 줄 나누기 (리드 결정 S5-42). 받은 조각을 줄 경계에서 잘라 줄 나누기에 넘기되, 이벤트 루프 한 차례에 READ_SLICE_MS
 * 또는 READ_SLICE_LINES줄까지만 한다. 남으면 스트림을 멈추고(읽기를 멈춰 파이프는 찬 채로 둔다 — Node의 파이프 읽기도 그 차례에서 빠져나온다) setImmediate로 다음
 * 차례에 잇고, 다 넘기면 다시 읽는다. 줄바꿈이 촘촘한 빠른 출력(큰 로그의 type·git log -p·출력 반복)은 파이프가 늘 차 있어 읽기와 줄 나누기가 쉬지 않고
 * 이어졌다 — 그동안 타이머·HTTP·IPC·앱 도구 호출이 차례를 얻지 못해 대표의 긴급 정지조차 받지 못했다(S5-36은 긴 한 줄만 봤다). 줄의 차례와 내용은 그대로이고
 * 때만 바뀐다. 상한은 조각 사이에도 이어 센다 — Node가 한 차례에 조각을 여럿 넘겨도 그 합이 상한이다. 모든 실행 방식(작업 개체·taskkill·프로세스 그룹)과 두 줄
 * 나누기(UTF-8·콘솔 코드 페이지)가 이것을 거친다
 */
export class PacedReader {
  private readonly splitter: Splitter;
  private stream: Readable | null = null;
  private readonly queue: Buffer[] = [];
  /** queue[0]에서 아직 넘기지 않은 첫 바이트 */
  private offset = 0;
  /** 다음 차례를 기다리느라 스트림을 멈췄다 */
  private paused = false;
  /** 지금 차례의 기한(performance.now()). 열린 차례가 없으면 null — 받은 조각이 차례를 열고, 그때 건 setImmediate가 닫는다 */
  private sliceEnd: number | null = null;
  /** 지금 차례에 넘긴 줄 수 */
  private sliceLines = 0;
  /** 다음에 넘길 조각 크기 (READ_PIECE_MIN_BYTES~READ_PIECE_MAX_BYTES) */
  private pieceBytes = READ_PIECE_MIN_BYTES;
  private finished = false;

  constructor(makeSplitter: (emit: (line: string) => void) => Splitter, emit: (line: string) => void) {
    this.splitter = makeSplitter((line) => {
      this.sliceLines++;
      emit(line);
    });
  }

  /** 읽기 시작 */
  attach(stream: Readable): void {
    this.stream = stream;
    stream.on('data', (chunk: Buffer) => this.take(chunk));
  }

  /**
   * 스트림 끝(닫힘): 멈춘 사이 스트림에 쌓인 조각과 미룬 줄을 지금 모두 넘기고, 줄바꿈 없는 마지막 조각도 한 줄로 넘긴다. 남은 것은 많아야 조각 몇 개다(스트림
   * 버퍼 상한 + 멈추기 직전에 받은 것)
   */
  end(): void {
    if (this.finished) return;
    this.finished = true;
    const s = this.stream;
    // read()는 돌려주는 조각을 'data'로도 알린다 — finished라 take가 받지 않는다
    if (s && !s.destroyed) for (let c: unknown = s.read(); c !== null; c = s.read()) this.queue.push(c as Buffer);
    this.work(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
    this.splitter.end();
  }

  private take(chunk: Buffer): void {
    if (this.finished) return;
    this.queue.push(chunk);
    // 멈춘 사이에 온 조각(멈추기 직전 스트림이 넘긴 것)은 다음 차례가 잇는다
    if (!this.paused) this.pump();
  }

  private pump(): void {
    if (this.sliceEnd === null) {
      this.sliceEnd = performance.now() + READ_SLICE_MS;
      this.sliceLines = 0;
      setImmediate(() => this.nextTurn());
    }
    if (this.work(this.sliceEnd, READ_SLICE_LINES)) {
      if (this.paused) {
        this.paused = false;
        this.stream?.resume();
      }
    } else if (!this.paused) {
      this.paused = true;
      this.stream?.pause();
    }
  }

  private nextTurn(): void {
    this.sliceEnd = null;
    if (this.paused && !this.finished) this.pump();
  }

  /** 맡은 조각을 줄 경계에서 pieceBytes쯤씩 잘라 넘긴다 — 기한이 지났거나 줄 수 상한에 닿았으면 멈춘다. 다 넘겼으면 true */
  private work(deadline: number, maxLines: number): boolean {
    for (;;) {
      const chunk = this.queue[0];
      if (!chunk) return true;
      if (this.offset >= chunk.length) {
        this.queue.shift();
        this.offset = 0;
        continue;
      }
      const t = performance.now();
      if (this.sliceLines >= maxLines || t >= deadline) return false;
      const end = pieceEnd(chunk, this.offset, this.pieceBytes);
      const piece = this.offset === 0 && end === chunk.length ? chunk : chunk.subarray(this.offset, end);
      this.offset = end;
      this.splitter.push(piece);
      const took = performance.now() - t;
      if (took > READ_PIECE_TARGET_MS) this.pieceBytes = Math.max(READ_PIECE_MIN_BYTES, this.pieceBytes >> 1);
      else if (took < READ_PIECE_TARGET_MS / 4) this.pieceBytes = Math.min(READ_PIECE_MAX_BYTES, this.pieceBytes * 2);
    }
  }
}

/** chunk의 from부터 size 안의 마지막 줄 경계(줄바꿈 바로 뒤). 그 안에 줄바꿈이 없으면(긴 줄) 다음 줄바꿈 뒤, 그것도 없으면 끝 */
function pieceEnd(chunk: Buffer, from: number, size: number): number {
  if (chunk.length - from <= size) return chunk.length;
  const nl = chunk.lastIndexOf(0x0a, from + size - 1);
  if (nl >= from) return nl + 1;
  const next = chunk.indexOf(0x0a, from + size);
  return next === -1 ? chunk.length : next + 1;
}

class LineSplitter implements Splitter {
  private readonly decoder = new StringDecoder('utf8');
  private pending: string[] = [];
  private pendingLength = 0;

  constructor(private readonly emit: (line: string) => void) {}

  push(chunk: Buffer): void {
    this.consume(this.decoder.write(chunk));
  }

  /** 스트림 끝: 줄바꿈 없는 마지막 조각도 한 줄로 전달 */
  end(): void {
    this.consume(this.decoder.end());
    if (this.pendingLength > 0) this.emit(stripCr(this.take('')));
  }

  private consume(text: string): void {
    let start = 0;
    while (start < text.length) {
      const nl = text.indexOf('\n', start);
      if (nl === -1) {
        const rest = text.slice(start);
        this.pending.push(rest);
        this.pendingLength += rest.length;
        if (this.pendingLength >= MAX_LINE_CHARS) this.emit(this.take(''));
        return;
      }
      this.emit(stripCr(this.take(text.slice(start, nl))));
      start = nl + 1;
    }
  }

  private take(tail: string): string {
    if (this.pending.length === 0) return tail;
    const line = this.pending.join('') + tail;
    this.pending = [];
    this.pendingLength = 0;
    return line;
  }
}

/**
 * 바이트에서 줄을 나눈 뒤 줄마다 해석한다 (UTF-8 → 안 되면 콘솔 코드 페이지, decodeConsoleOutput).
 * 줄바꿈(0x0A)은 UTF-8·CP949 다중 바이트 문자 안에 나오지 않으므로 바이트에서 나눠도 글자가 잘리지 않는다 (windows:F10)
 */
class ConsoleLineSplitter implements Splitter {
  private pending: Buffer[] = [];
  private pendingBytes = 0;

  constructor(private readonly emit: (line: string) => void) {}

  push(chunk: Buffer): void {
    let start = 0;
    while (start < chunk.length) {
      const nl = chunk.indexOf(0x0a, start);
      if (nl === -1) {
        const rest = Buffer.from(chunk.subarray(start));
        this.pending.push(rest);
        this.pendingBytes += rest.length;
        if (this.pendingBytes >= MAX_LINE_CHARS) this.emit(this.take(EMPTY));
        return;
      }
      this.emit(stripCr(this.take(chunk.subarray(start, nl))));
      start = nl + 1;
    }
  }

  end(): void {
    if (this.pendingBytes > 0) this.emit(stripCr(this.take(EMPTY)));
  }

  private take(tail: Buffer): string {
    const bytes = this.pending.length === 0 ? tail : Buffer.concat([...this.pending, tail]);
    this.pending = [];
    this.pendingBytes = 0;
    return decodeConsoleOutput(bytes);
  }
}

const EMPTY = Buffer.alloc(0);

/**
 * 러너 stdout에서 제어 줄을 가려낸다. 자식이 제어 줄 모양을 흉내 내도 속지 않게:
 * started는 첫 줄일 때만, exit·terminated는 마지막 줄(뒤에 아무 줄도 없이 EOF)일 때만 제어 줄로 본다.
 */
class RunnerStdoutRouter {
  private index = 0;
  private held: { line: string; control: ControlLine } | null = null;

  constructor(
    private readonly forward: (line: string) => void,
    private readonly onStarted: (pid: number) => void,
  ) {}

  push(line: string): void {
    const held = this.held;
    if (held) {
      // 뒤에 줄이 더 왔으니 앞의 줄은 자식 출력이었다
      this.held = null;
      this.forward(held.line);
    }
    const index = this.index++;
    const control = line.startsWith(CONTROL_PREFIX) ? parseControlLine(line) : null;
    if (control?.kind === 'started') {
      if (index === 0) {
        this.onStarted(control.pid);
        return;
      }
    } else if (control) {
      this.held = { line, control };
      return;
    }
    this.forward(line);
  }

  end(): ControlLine | null {
    const held = this.held;
    this.held = null;
    return held ? held.control : null;
  }
}

function parseControlLine(line: string): ControlLine | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null; // 제어 줄 모양이지만 JSON이 아니면 자식 출력
  }
  if (typeof value !== 'object' || value === null) return null;
  const o = value as Record<string, unknown>;
  const keys = Object.keys(o).length;
  switch (o.__wookRunner) {
    case 'started':
      return keys === 2 && isInt(o.pid) && o.pid > 0 ? { kind: 'started', pid: o.pid } : null;
    case 'exit':
      return keys === 4 && isInt(o.code) && isInt(o.leftover) && isInt(o.remaining)
        ? { kind: 'exit', code: o.code, leftover: o.leftover, remaining: o.remaining }
        : null;
    case 'terminated':
      return keys === 2 && isInt(o.remaining) ? { kind: 'terminated', remaining: o.remaining } : null;
    default:
      return null;
  }
}

class LineFanout {
  private readonly listeners: Array<(line: string) => void> = [];

  constructor(
    private readonly ctx: Ctx,
    private readonly label: string,
    private readonly stream: 'stdout' | 'stderr',
  ) {}

  add(cb: (line: string) => void): void {
    this.listeners.push(cb);
  }

  emit(line: string): void {
    for (const cb of this.listeners) {
      try {
        cb(line);
      } catch (err) {
        // 처리기 하나의 오류로 출력 읽기(=앱 전체)가 죽지 않게 한다
        this.ctx.log('error', `${this.stream} 줄 처리기 오류 (${this.label})`, err);
      }
    }
  }
}

// ---- Windows 트리 종료 (taskkill) ----

/**
 * taskkill /PID <pid> /T /F 후 종료 확인. 확인 대상 = 루트 + extraPids + taskkill이 알린 PID.
 * taskkill /T는 부모가 이미 끝난 후손(고아)을 찾지 못한다 — detail에 범위를 밝힌다.
 */
async function killTreeWindows(pid: number, extraPids: number[], timeoutMs: number): Promise<TerminateResult> {
  const t0 = performance.now();
  const deadline = t0 + timeoutMs;
  const roots = unique([pid, ...extraPids]).filter((p) => invalidTargetReason(p) === null);
  if (roots.every((p) => !isPidAlive(p))) {
    return { ok: true, remaining: 0, detail: '이미 종료된 프로세스입니다', durationMs: ms(t0) };
  }
  const listed: number[] = [];
  const problems: string[] = [];
  for (const root of roots) {
    if (!isPidAlive(root)) continue;
    const tk = await runTaskkill(root, Math.max(500, deadline - performance.now()));
    listed.push(...tk.killedPids);
    if (tk.error) problems.push(`taskkill 실행 실패: ${tk.error}`);
    // 128 = 이미 끝나 찾을 수 없음
    else if (tk.exitCode !== 0 && tk.exitCode !== 128) problems.push(`taskkill 종료 코드 ${String(tk.exitCode)}: ${tk.summary}`);
  }
  const targets = unique([...roots, ...listed]).filter((p) => invalidTargetReason(p) === null);
  const alive = await waitPidsGone(targets, deadline);
  const note = problems.length > 0 ? ` (${problems.join('; ')})` : '';
  if (alive.length === 0) {
    return {
      ok: true,
      remaining: 0,
      detail: `taskkill /T /F로 프로세스 ${targets.length}개 종료 확인 (부모가 먼저 끝난 후손은 확인 범위 밖)${note}`,
      durationMs: ms(t0),
    };
  }
  return {
    ok: false,
    remaining: alive.length,
    detail: `종료되지 않은 프로세스가 있습니다: PID ${alive.join(', ')}${note}`,
    durationMs: ms(t0),
  };
}

interface TaskkillResult {
  exitCode: number | null;
  killedPids: number[];
  summary: string;
  error: string | null;
}

function runTaskkill(pid: number, timeoutMs: number): Promise<TaskkillResult> {
  const exe = join(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? process.env.windir ?? 'C:\\Windows', 'System32', 'taskkill.exe');
  return new Promise((resolvePromise) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(exe, ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    } catch (err) {
      resolvePromise({ exitCode: null, killedPids: [], summary: '', error: errorText(err) });
      return;
    }
    child.stdin.end();
    const chunks: Buffer[] = [];
    let error: string | null = null;
    child.stdout.on('data', (d: Buffer) => chunks.push(d));
    child.stderr.on('data', (d: Buffer) => chunks.push(d));
    child.on('error', (err) => {
      error = errorText(err);
    });
    const timer = setTimeout(() => {
      error = `${timeoutMs}ms 안에 끝나지 않았습니다`;
      child.kill();
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      const text = decodeConsoleOutput(Buffer.concat(chunks));
      resolvePromise({
        exitCode: code,
        killedPids: parseTaskkillPids(text),
        summary: text.split(/\r?\n/).filter(Boolean).slice(0, 3).join(' / '),
        error,
      });
    });
  });
}

/** 줄마다 첫 "PID n"이 종료 대상이다 (둘째는 그 부모 — 앱 자신일 수 있어 세지 않는다). 언어와 무관 */
function parseTaskkillPids(text: string): number[] {
  const out: number[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /PID\s+(\d+)/i.exec(line);
    if (m) out.push(Number(m[1]));
  }
  return out;
}

const UTF8_STRICT = new TextDecoder('utf-8', { fatal: true });
let consoleDecoder: { decode(input: Uint8Array): string } | null | undefined;

/** taskkill·cmd 출력은 콘솔 코드 페이지(한국어 Windows는 CP949)다. UTF-8로 읽히면 UTF-8로 */
function decodeConsoleOutput(buf: Buffer): string {
  try {
    return UTF8_STRICT.decode(buf);
  } catch {
    // UTF-8이 아니면 한국어 콘솔 코드 페이지로 읽는다
  }
  if (consoleDecoder === undefined) {
    try {
      consoleDecoder = new TextDecoder('euc-kr');
    } catch {
      consoleDecoder = null; // ICU 없는 빌드
    }
  }
  return consoleDecoder ? consoleDecoder.decode(buf) : buf.toString('latin1');
}

// ---- 재시작 복구: 프로세스 생성 시각 (windows:F2) ----

/**
 * 러너를 만들지 않고 쓰는 생존·생성 시각 확인 (SERVER_DESIGN 3.2, S2-6): 실행 잠금(backend/instanceLock.ts)은 백엔드(러너)를 만들기 전에 잡는다.
 * 판정은 러너의 isAlive·processCreatedAt과 같다. 다만 POSIX 그룹 판정은 뺀다 — 잠금이 적는 PID는 CLI 그룹 리더가 아니라 욱채 프로세스 자신이다.
 * 생성 시각을 읽지 못한 PID는 결과에서 빠지고, 조회가 실패하면 빈 결과다 — 호출자는 '모름'으로 다룬다
 */
export const processLiveness: Pick<ProcessRunner, 'isAlive' | 'processCreatedAt'> = {
  async isAlive(pid) {
    return Number.isSafeInteger(pid) && pid > 1 && isPidAlive(pid);
  },
  async processCreatedAt(pids) {
    const valid = unique(pids.filter((p) => Number.isSafeInteger(p) && p > 1));
    if (valid.length === 0) return new Map();
    try {
      return process.platform === 'win32' ? await createdAtWindows(valid) : await createdAtPosix(valid);
    } catch {
      return new Map();
    }
  },
};

/** FILETIME(1601-01-01부터 100ns) → epoch ms */
const FILETIME_EPOCH_MS = 11_644_473_600_000;

/** Win32_Process.CreationDate를 한 번에 조회한다. 생성 시각을 읽지 못한 프로세스(보호 프로세스 등)는 빠진다 */
async function createdAtWindows(pids: number[]): Promise<Map<number, number>> {
  const root = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? process.env.windir ?? 'C:\\Windows';
  const exe = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const filter = pids.map((p) => `ProcessId=${p}`).join(' OR ');
  const script = `Get-CimInstance -ClassName Win32_Process -Filter '${filter}' | ForEach-Object { if ($_.CreationDate) { '{0} {1}' -f $_.ProcessId, $_.CreationDate.ToFileTimeUtc() } }`;
  const out = await runQuiet(exe, ['-NoProfile', '-NonInteractive', '-Command', script], process.env, CREATED_AT_TIMEOUT_MS);
  const map = new Map<number, number>();
  for (const line of out.split(/\r?\n/)) {
    const m = /^(\d+)\s+(\d+)$/.exec(line.trim());
    if (!m) continue;
    map.set(Number(m[1]), Number(BigInt(m[2]!) / 10_000n) - FILETIME_EPOCH_MS);
  }
  return map;
}

/** ps -o lstart (초 단위, 이 PC 시간대) */
async function createdAtPosix(pids: number[]): Promise<Map<number, number>> {
  const out = await runQuiet('ps', ['-o', 'pid=,lstart=', '-p', pids.join(',')], { ...process.env, LC_ALL: 'C', LANG: 'C' }, CREATED_AT_TIMEOUT_MS, [0, 1]);
  const map = new Map<number, number>();
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const at = Date.parse(m[2]!);
    if (Number.isFinite(at)) map.set(Number(m[1]), at);
  }
  return map;
}

/** 짧은 조회 명령 실행: 표준 출력을 돌려주고, 실행 실패·시간 초과·예상 밖 종료 코드면 던진다 */
function runQuiet(file: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number, okCodes: number[] = [0]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(file, args, { windowsHide: true, env });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    child.stdin.end();
    const chunks: Buffer[] = [];
    let errText = '';
    let failed: Error | null = null;
    child.stdout.on('data', (d: Buffer) => chunks.push(d));
    child.stderr.on('data', (d: Buffer) => {
      if (errText.length < 2000) errText += d.toString('utf8');
    });
    child.on('error', (err) => {
      failed = err;
    });
    const timer = setTimeout(() => {
      failed = new Error(`${timeoutMs}ms 안에 끝나지 않았습니다`);
      child.kill();
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (failed) return reject(failed);
      if (code === null || !okCodes.includes(code)) return reject(new Error(`종료 코드 ${String(code)}: ${firstLine(errText)}`));
      resolvePromise(Buffer.concat(chunks).toString('utf8'));
    });
  });
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).find((l) => l.trim() !== '')?.trim().slice(0, 300) ?? '';
}

// ---- POSIX 프로세스 그룹 ----

/**
 * 그룹 전체 SIGTERM → (1초 뒤에도 남으면) SIGKILL → 사라질 때까지 확인.
 * strict: 재시작 복구용 — 그룹이 없으면 같은 번호의 다른 프로세스는 건드리지 않는다.
 */
async function killGroup(pgid: number, timeoutMs: number, strict: boolean): Promise<TerminateResult> {
  const t0 = performance.now();
  const deadline = t0 + timeoutMs;
  if (!isGroupAlive(pgid)) {
    const detail =
      strict && isPidAlive(pgid)
        ? `PID ${pgid}의 프로세스 그룹이 없습니다 (같은 번호의 다른 프로세스는 건드리지 않음)`
        : '이미 종료된 프로세스 그룹입니다';
    return { ok: true, remaining: 0, detail, durationMs: ms(t0) };
  }
  const term = signalGroup(pgid, 'SIGTERM');
  if (term === 'denied') {
    return { ok: false, remaining: await countGroup(pgid), detail: `프로세스 그룹 ${pgid}에 신호를 보낼 권한이 없습니다`, durationMs: ms(t0) };
  }
  let gone = await waitGroupGone(pgid, Math.min(t0 + PGROUP_SIGKILL_AFTER_MS, deadline));
  let escalated = false;
  if (!gone) {
    escalated = true;
    signalGroup(pgid, 'SIGKILL');
    gone = await waitGroupGone(pgid, deadline);
  }
  if (gone) {
    return {
      ok: true,
      remaining: 0,
      detail: escalated ? '프로세스 그룹을 SIGKILL로 종료했습니다' : '프로세스 그룹을 SIGTERM으로 종료했습니다',
      durationMs: ms(t0),
    };
  }
  const remaining = await countGroup(pgid);
  return { ok: false, remaining, detail: `프로세스 그룹 ${pgid}에 ${remaining}개가 남아 있습니다`, durationMs: ms(t0) };
}

/** 리더가 정상 종료한 뒤 그룹에 남은 후손(개발 서버 등) 정리 */
async function cleanupLeftoverGroup(pgid: number): Promise<{ leftover: number; remaining: number }> {
  if (!isGroupAlive(pgid)) return { leftover: 0, remaining: 0 };
  const members = await listGroup(pgid);
  const leftover = members === null ? -1 : members.length;
  if (signalGroup(pgid, 'SIGTERM') === 'gone') return { leftover, remaining: 0 };
  const t0 = performance.now();
  if (!(await waitGroupGone(pgid, t0 + PGROUP_SIGKILL_AFTER_MS))) {
    signalGroup(pgid, 'SIGKILL');
    await waitGroupGone(pgid, t0 + PGROUP_SIGKILL_AFTER_MS + PGROUP_LEFTOVER_KILL_WAIT_MS);
  }
  return { leftover, remaining: isGroupAlive(pgid) ? await countGroup(pgid) : 0 };
}

function signalGroup(pgid: number, signal: NodeJS.Signals): 'sent' | 'gone' | 'denied' {
  try {
    process.kill(-pgid, signal);
    return 'sent';
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return 'gone';
    if (code === 'EPERM') return 'denied';
    throw err;
  }
}

function isGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function waitGroupGone(pgid: number, deadline: number): Promise<boolean> {
  while (isGroupAlive(pgid)) {
    if (performance.now() >= deadline) return false;
    await sleep(POLL_MS);
  }
  return true;
}

/** 남은 그룹 구성원 수. 알 수 없으면(pgrep 없음) 그룹이 살아 있으니 최소 1 */
async function countGroup(pgid: number): Promise<number> {
  if (!isGroupAlive(pgid)) return 0;
  const members = await listGroup(pgid);
  return members === null ? 1 : Math.max(1, members.length);
}

function listGroup(pgid: number): Promise<number[] | null> {
  return new Promise((resolvePromise) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn('pgrep', ['-g', String(pgid)]);
    } catch {
      resolvePromise(null);
      return;
    }
    child.stdin.end();
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => (out += d));
    child.stderr.resume();
    let failed = false;
    child.on('error', () => {
      failed = true; // pgrep이 없는 환경: 개수를 모를 뿐 종료 판정은 kill(-pgid, 0)으로 한다
    });
    child.on('close', (code) => {
      if (failed || (code !== 0 && code !== 1)) return resolvePromise(null);
      resolvePromise(
        out
          .split(/\s+/)
          .filter(Boolean)
          .map(Number)
          .filter((n) => Number.isSafeInteger(n) && n > 0),
      );
    });
  });
}

// ---- 공통 도우미 ----

function resolveCommand(spec: RunSpec): { ok: true; path: string } | { ok: false; reason: string } {
  const command = spec.command;
  if (!command) return { ok: false, reason: '실행 파일이 비어 있습니다' };
  if (process.platform !== 'win32') return { ok: true, path: command };
  if (/\.(cmd|bat)$/i.test(command)) {
    return { ok: false, reason: `배치 파일(.cmd·.bat)은 직접 실행하지 않습니다: ${command} — 실제 .exe 경로를 넘겨야 합니다` };
  }
  // 현재 폴더는 찾지 않는다 (작업 폴더에 같은 이름의 exe를 두어 바꿔치기하는 것을 막는다)
  if (isAbsolute(command) || /[\\/]/.test(command)) {
    const full = resolve(spec.cwd, command);
    return isFile(full) ? { ok: true, path: full } : { ok: false, reason: `실행 파일을 찾을 수 없습니다: ${full}` };
  }
  const pathValue = envValue(spec.env, 'PATH') ?? '';
  const exts = extname(command) ? [''] : ['.exe', '.com'];
  for (const rawDir of pathValue.split(delimiter)) {
    const dir = rawDir.trim().replace(/^"(.*)"$/, '$1');
    if (!dir || !isAbsolute(dir)) continue;
    for (const ext of exts) {
      const candidate = join(dir, command + ext);
      if (isFile(candidate)) return { ok: true, path: candidate };
    }
  }
  return { ok: false, reason: `PATH에서 실행 파일을 찾을 수 없습니다: ${command} (.exe·.com만 찾음)` };
}

/** Windows 환경 변수 이름은 대소문자를 가리지 않는다 */
function envValue(env: Record<string, string | undefined>, name: string): string | undefined {
  const upper = name.toUpperCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toUpperCase() === upper && value !== undefined) return value;
  }
  return undefined;
}

function writeStdinFile(dataDir: string, text: string): string {
  const dir = join(dataDir, 'tmp', 'stdin');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${Date.now().toString(36)}-${randomBytes(6).toString('hex')}.txt`);
  writeFileSync(file, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return file;
}

/** 앱이 비정상 종료해 남은 표준 입력 임시 파일 정리 */
async function removeStaleStdinFiles(dataDir: string, log: RunnerLog): Promise<void> {
  const dir = join(dataDir, 'tmp', 'stdin');
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log('warn', `표준 입력 임시 폴더를 읽지 못했습니다: ${dir}`, err);
    return;
  }
  const now = Date.now();
  for (const name of names) {
    const file = join(dir, name);
    try {
      if (now - (await stat(file)).mtimeMs >= STALE_STDIN_MS) await rm(file, { force: true });
    } catch (err) {
      log('warn', `오래된 표준 입력 임시 파일을 지우지 못했습니다: ${file}`, err);
    }
  }
}

function alreadyExited(info: ExitInfo, durationMs: number): TerminateResult {
  if (info.remaining > 0) {
    return { ok: false, remaining: info.remaining, detail: `이미 종료됐지만 남은 프로세스가 ${info.remaining}개 있습니다`, durationMs };
  }
  // 남은 후손을 확인하지 못했으면(-1) 종료 확인으로 치지 않는다 (CTL-03)
  if (info.remaining < 0) return { ok: false, remaining: -1, detail: '이미 종료됐지만 남은 후손 프로세스는 확인하지 못했습니다', durationMs };
  return { ok: true, remaining: 0, detail: '이미 종료됐습니다', durationMs };
}

/** 앱 자신·부모나 잘못된 번호는 종료 대상이 아니다 (부모를 끊으면 앱도 끝난다, POSIX의 0·1·음수는 그룹 전체 신호) */
function invalidTargetReason(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 1) return `잘못된 PID입니다: ${String(pid)}`;
  if (pid === process.pid || pid === process.ppid) return `앱 자신(또는 부모) 프로세스는 종료하지 않습니다: PID ${pid}`;
  return null;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM 등: 프로세스는 있는데 권한이 없다 → 살아 있는 것으로 본다
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function waitPidsGone(pids: number[], deadline: number): Promise<number[]> {
  let alive = pids.filter(isPidAlive);
  while (alive.length > 0 && performance.now() < deadline) {
    await sleep(POLL_MS);
    alive = alive.filter(isPidAlive);
  }
  return alive;
}

function isPipeClosedError(err: Error): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'EPIPE' || code === 'EOF' || code === 'ECONNRESET' || code === 'ERR_STREAM_DESTROYED';
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v);
}

function stripCr(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

function unique(values: number[]): number[] {
  return [...new Set(values)];
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolveFn!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolveFn = r;
  });
  return { promise, resolve: resolveFn };
}

/** 제한 시간 안에 풀리면 그 값, 아니면 fallback */
async function settleOr<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((r) => {
    timer = setTimeout(() => r(fallback), Math.max(0, timeoutMs));
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * taskkill 방식: 넣기 전에 일이 시작되지 않게 무엇으로 붙잡았는지 — gate: 시작 신호를 읽기 전에는 아무것도 띄우지 않는 형태(RunSpec.adoptGate)
 * · prompt: 프롬프트(표준 입력)를 읽기 전에는 일을 시작하지 않는 CLI · none: 붙잡을 입력이 없다(띄우자마자 일을 시작한다)
 */
type InputHold = 'gate' | 'prompt' | 'none';

/**
 * taskkill 방식: 작업 개체에 넣은 결과로 그 작업 개체가 이 프로세스 트리를 다 담지 못했을 수 있는 까닭. 없으면 null.
 * 넣는 순간의 프로세스 목록에서 부모를 따라 찾으므로, 그보다 앞서 중간 프로세스가 끝나며 남긴 고아는 빠지고 목록을 찍은 뒤 넣기를 마치기 전에
 * 생긴 손자도 빠질 수 있다. cmd 이중 start 사슬은 띄운 뒤 약 20ms면 고아를 남기는데(실측) 넣기도 그만큼 걸릴 수 있어 시각으로는 가를 수 없다 —
 * 그래서 넣기 전에 일이 시작되지 않았다고 말할 수 있을 때만 확인으로 친다:
 *  - 넣지 못함 · 루트 PID를 다른 프로세스가 씀 · 실행 중인 루트를 못 넣음 · 넣기를 기다리다 상한이 지나 입력을 먼저 줌 → 까닭
 *  - gate: 넣은 뒤에 시작 신호를 줬으면 확인 (늦게 넣었어도, 도우미가 준비 중이었어도 — 신호를 읽기 전에는 아무것도 띄우지 않았다. 루트가 이미
 *    끝났으면 신호를 읽기 전에 끝나 아무것도 띄우지 않았다)
 *  - none: 띄우자마자 일을 시작했으니 늘 까닭
 *  - prompt: CLI의 시작 단계(프롬프트를 읽기 전)만 작업 개체 밖에서 돈다 — 도우미가 준비된 채 띄웠고 JOB_ADOPT_LATE_MS 안에 넣었으면 확인.
 *    루트가 넣기 전에 끝났어도(프롬프트를 받기 전에 끝난 CLI) 그 자식은 부모 PID로 찾았다
 */
function adoptGap(h: JobHandle | null, o: { hold: InputHold; helperReady: boolean; spawnReturned: number; inputEarly: boolean }): string | null {
  if (!h) return '작업 개체에 넣지 못했습니다';
  if (h.root === 'other') return '같은 PID를 이미 다른 프로세스가 써서 작업 개체에 넣지 못했습니다';
  if (h.root === 'denied') return '실행 중인 프로세스를 작업 개체에 넣지 못했습니다';
  // spawn()이 돌아온 뒤(자식이 생긴 뒤)부터 잰다 (리드 결정 S5-52.5)
  const lateBy = Math.max(0, Math.round(h.scopeAt - o.spawnReturned));
  if (o.inputEarly) {
    return `띄운 뒤 ${lateBy}ms 뒤에야 작업 개체에 넣었습니다 — 넣기를 ${INPUT_HOLD_MAX_MS}ms 넘게 기다려 ${o.hold === 'gate' ? '시작 신호' : '입력(프롬프트)'}를 먼저 줬습니다`;
  }
  if (o.hold === 'gate') return null;
  if (o.hold === 'none') return `입력 없이 띄우자마자 일을 시작하는 실행이라 작업 개체에 넣기(띄운 뒤 ${lateBy}ms) 전에 생긴 후손을 다 찾았는지 알 수 없습니다`;
  if (!o.helperReady) return `작업 개체 도우미가 준비되기 전에 띄워 ${lateBy}ms 뒤에야 작업 개체에 넣었습니다`;
  if (lateBy > JOB_ADOPT_LATE_MS) return `띄운 뒤 ${lateBy}ms 뒤에야 작업 개체에 넣었습니다 (상한 ${JOB_ADOPT_LATE_MS}ms)`;
  return null;
}

/** 작업 개체가 빌 때까지 기다린다. 남은 수 (조회하지 못하면 -1) */
async function waitJobEmpty(job: JobHandle, deadline: number): Promise<number> {
  for (;;) {
    const listed = await settleOr(job.list(), Math.max(50, deadline - performance.now()), null);
    if (listed === null) return -1;
    if (listed.length === 0) return 0;
    if (performance.now() >= deadline) return listed.length;
    await sleep(POLL_MS);
  }
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((r) => {
    timer = setTimeout(() => r(false), Math.max(0, timeoutMs));
  });
  try {
    return await Promise.race([promise.then(() => true as const), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function sleep(msValue: number): Promise<void> {
  return new Promise((r) => setTimeout(r, msValue));
}

function ms(t0: number): number {
  return Math.round(performance.now() - t0);
}

function errorText(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    return code && !err.message.includes(code) ? `${code}: ${err.message}` : err.message;
  }
  return String(err);
}

const defaultLog: RunnerLog = (level, msg, extra) => {
  const line = `[process] ${msg}`;
  if (level === 'error') console.error(line, extra ?? '');
  else if (level === 'warn') console.warn(line, extra ?? '');
  else console.info(line, extra ?? '');
};
