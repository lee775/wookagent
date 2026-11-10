/**
 * 보안 그룹 완료 기준(AC-01·02·18·19·20·30·31·32·33) 검증 도구.
 *
 * - bootApp: e2e 하네스처럼 실제 저장소(SQLite)·git·프로세스 러너·앱 도구 서버(실제 HTTP, 127.0.0.1)·모의 에이전트로
 *   오케스트레이터를 띄운다. 테스트가 패키징 여부·구글 로그인(가짜 주입)·껍데기 기능·비밀 값 저장소(재시작에도 유지)·
 *   CLI 출력 주입(실제 모의 에이전트 출력에 비밀 값 이벤트를 끼움)·스케줄러 정지를 정한다.
 *   백엔드 로그는 실제 앱(createBackend)처럼 <앱데이터>/logs/backend.log 에 가리개를 끼운 파일 로거로 남긴다.
 * - callTool: 앱 도구 서버에 실제 HTTP(JSON-RPC tools/call)로 보낸다 — 거부 기록(onCall → 활동 기록)까지 실제 경로를 탄다.
 * - listeners: 이 프로세스(와 하위 프로세스)가 연 수신 포트 (Windows netstat / POSIX lsof).
 * - scanFiles·dumpDb: 앱 데이터 폴더의 모든 파일·DB 표에서 값을 찾는다.
 * - slowKill: 고른 턴의 프로세스 종료를 늦춘다. 정지가 저장된 뒤 종료 확인(제품 상한 2.8초)을 기다리는 동안 그 CLI가 아직 살아
 *   유효한 턴 토큰으로 앱 도구를 부를 수 있는 창을 실제 프로세스·실제 토큰으로 재현한다.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { connect as netConnect } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import type { MockScenario, RoleId, Settings } from '@shared/domain';
import { MAIN_AGENT_ID } from '@shared/domain';
import type { DeepPartial, WookMethod, WookParams, WookResult, WookTopic, WookTopics } from '@shared/ipc';
import { buildOrchestratorDeps } from '../../src/main/backend/buildDeps';
import type { ShellServices } from '../../src/main/backend/types';
import type { DesktopDeps } from '../../src/main/desktop/service';
import type { AgentAdapter, CliStatus } from '../../src/main/agents/types';
import type { ManagedProcess, ProcessRunner, RunSpec, TerminateResult } from '../../src/main/process/types';
import type { GoogleLoginOptions, GoogleProfile, SecretStore } from '../../src/main/auth/types';
import { createSecretStore } from '../../src/main/auth/secretStore';
import type { TokenIdentity } from '../../src/main/mcp/types';
import { createOrchestrator, type Orchestrator } from '../../src/main/orchestrator/orchestrator';
import { parseKey } from '../../src/main/orchestrator/records';
import { roleOf } from '../../src/main/orchestrator/lookups';
import { createFileLogger, type FileLogger } from '../../src/main/shell/logger';
import { internalInvoker, mainOp } from '../regression/mainOps';

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(pred: () => boolean | Promise<boolean>, label = '조건', ms = 45_000, intervalMs = 25): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (await pred()) return;
    if (Date.now() - t0 > ms) throw new Error(`시간 초과: ${label} (${ms}ms)`);
    await sleep(intervalMs);
  }
}

/** 임시 폴더 (한글 경로는 Node 24.13 Windows rmSync 문제로 피한다) */
export function tempDir(tag: string): string {
  return mkdtempSync(join(tmpdir(), `wook-test-acc-${tag}-`));
}

export async function removeDirs(dirs: string[]): Promise<void> {
  for (const d of dirs) {
    try {
      await rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // 윈도우에서 잠긴 파일이 남으면 다음 정리에 맡긴다
    }
  }
}

/** 재시작해도 남는 비밀 값 저장소 (OS 보안 저장소 대신 — 같은 객체를 다음 부팅에 넘긴다) */
export function persistentSecrets(): SecretStore {
  return createSecretStore({ service: 'wookagent-acceptance-test', forceMemory: true });
}

/** 가짜 껍데기 기능: 브라우저 열기·OS 알림을 기록만 한다 */
export function fakeShell(): ShellServices & { opened: string[]; toasts: { level: string; title: string; body: string }[] } {
  const opened: string[] = [];
  const toasts: { level: string; title: string; body: string }[] = [];
  return {
    opened,
    toasts,
    openExternal: async (url: string) => {
      opened.push(url);
    },
    openPath: async () => undefined,
    pickFiles: async () => [],
    showOsNotification: (n) => {
      toasts.push({ level: n.level, title: n.title, body: n.body });
    },
    focusWindow: () => undefined,
  };
}

/** 구글 로그인 가짜: 시스템 브라우저 열기(openExternal)를 거친 뒤 줄 세운 프로필을 하나씩 돌려준다 */
export function fakeGoogle(): { login: (o: GoogleLoginOptions) => Promise<GoogleProfile>; queue: GoogleProfile[]; calls: GoogleLoginOptions[] } {
  const queue: GoogleProfile[] = [];
  const calls: GoogleLoginOptions[] = [];
  return {
    queue,
    calls,
    async login(o) {
      calls.push(o);
      await o.openExternal(`https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(o.clientId)}&redirect_uri=http%3A%2F%2F127.0.0.1%3A1%2Fcallback`);
      const p = queue.shift();
      if (!p) throw new Error('가짜 구글: 줄 세운 프로필이 없습니다');
      return p;
    },
  };
}

// ───────────────────────── CLI 출력 주입 (AC-20) ─────────────────────────

/**
 * 실제 모의 에이전트를 자식으로 띄우고 그 표준 출력을 그대로 넘기면서, 끝 이벤트(Claude result / Codex turn.completed) 바로 앞에
 * 비밀 값이 든 CLI 이벤트(답변 문장·셸 명령·명령 결과)와 표준 오류 한 줄을 끼워 넣는다. Claude 형식은 result 문장에도 덧붙인다.
 * 작업 세션이면 작업 폴더에 비밀 값이 든 파일을 남겨 다음 단계 완료 때 커밋되게 한다 (변경 내용 화면).
 */
const LEAK_WRAPPER = String.raw`'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const [real, ...args] = process.argv.slice(2);
const leaks = JSON.parse(process.env.WOOK_TEST_LEAKS || '[]');
const reads = JSON.parse(process.env.WOOK_TEST_READ_IMAGES || '[]').filter((f) => fs.existsSync(f));
const fi = args.indexOf('--format');
const format = fi >= 0 ? args[fi + 1] : 'claude';
const workKey = process.env.WOOK_MOCK_WORKKEY || '';
const joined = leaks.join(' / ');
if (leaks.length && workKey.startsWith('task:') && fs.existsSync(path.join(process.cwd(), '.git'))) {
  fs.writeFileSync(path.join(process.cwd(), 'wook-leak-note.txt'), leaks.join('\n') + '\n', 'utf8');
}
const env = Object.assign({}, process.env);
delete env.WOOK_TEST_LEAKS;
delete env.WOOK_TEST_READ_IMAGES;
const child = spawn(process.execPath, [real, ...args], { stdio: ['pipe', 'pipe', 'pipe'], env, windowsHide: true });
child.stdin.on('error', () => {});
process.stdin.pipe(child.stdin);
child.stderr.pipe(process.stderr, { end: false });
let injected = false;
// Claude Code가 이미지 파일을 Read로 열 때 내는 두 줄 (실제 2.1.x 스트림의 모양) — 같은 이미지가 한 줄에 두 번 실린다: 도구 결과의 이미지 블록과
// tool_use_result.file.base64 (리드 결정 S6-21 C1)
function injectReads() {
  if (format === 'codex') return;
  reads.forEach((file, i) => {
    const b64 = fs.readFileSync(file).toString('base64');
    const id = 'toolu_wookread_' + i;
    const lines = [
      { type: 'assistant', message: { id: 'msg_wookread_' + i, type: 'message', role: 'assistant', content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: file } }] } },
      {
        type: 'user',
        message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content: [{ type: 'image', source: { type: 'base64', data: b64, media_type: 'image/png' } }] }] },
        tool_use_result: { type: 'image', file: { base64: b64, type: 'image/png', originalSize: Math.floor((b64.length * 3) / 4), dimensions: { originalWidth: 1280, originalHeight: 720, displayWidth: 1280, displayHeight: 720 } } },
      },
    ];
    for (const l of lines) process.stdout.write(JSON.stringify(l) + '\n');
  });
}
function inject() {
  if (injected) return;
  injected = true;
  injectReads();
  if (!leaks.length) return;
  const lines = format === 'codex'
    ? [
        { type: 'item.completed', item: { id: 'item_wookleak_1', type: 'agent_message', text: '확인한 값: ' + joined } },
        { type: 'item.started', item: { id: 'item_wookleak_2', type: 'command_execution', command: 'echo ' + joined, aggregated_output: '', status: 'in_progress' } },
        { type: 'item.completed', item: { id: 'item_wookleak_2', type: 'command_execution', command: 'echo ' + joined, aggregated_output: leaks.join('\n') + '\n', exit_code: 0, status: 'completed' } },
      ]
    : [
        { type: 'assistant', message: { id: 'msg_wookleak_1', type: 'message', role: 'assistant', content: [{ type: 'text', text: '확인한 값: ' + joined }] } },
        { type: 'assistant', message: { id: 'msg_wookleak_2', type: 'message', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_wookleak', name: 'Bash', input: { command: 'echo ' + joined } }] } },
        { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_wookleak', content: leaks.join('\n') + '\n', is_error: false }] } },
      ];
  for (const l of lines) process.stdout.write(JSON.stringify(l) + '\n');
  process.stderr.write('경고: 환경에서 읽은 값 ' + joined + '\n');
}
function isFinal(o) {
  return format === 'codex' ? o.type === 'turn.completed' || o.type === 'turn.failed' : o.type === 'result';
}
let buf = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    let line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    let o = null;
    try { o = JSON.parse(line); } catch (e) { o = null; }
    if (o && typeof o === 'object' && isFinal(o)) {
      inject();
      if (format !== 'codex' && typeof o.result === 'string' && leaks.length) {
        o.result = o.result + '\n(참고 값: ' + joined + ')';
        line = JSON.stringify(o);
      }
    }
    process.stdout.write(line + '\n');
  }
});
child.on('close', (code) => {
  if (buf) process.stdout.write(buf);
  process.exitCode = code === null ? 1 : code;
});
`;

export interface CapturedLaunch {
  token: string;
  url: string;
  workKey: string;
  memberId: string;
  role: string;
}

// ───────────────────────── 앱 띄우기 ─────────────────────────

export interface AppOptions {
  dataDir?: string;
  isPackaged?: boolean;
  googleLogin?: (o: GoogleLoginOptions) => Promise<GoogleProfile>;
  shell?: ShellServices | null;
  secrets?: SecretStore;
  /**
   * 모의 에이전트 출력에 끼울 비밀 값들 — 턴을 띄울 때마다 읽는다(부팅 뒤에 생기는 값도 더할 수 있다: 서버의 기기 세션 토큰·설정 코드, 10.11 AC-20 행).
   * 비어 있으면 끼우지 않는다
   */
  leak?: string[];
  /**
   * 메인 턴의 CLI 출력에 'Claude가 이 이미지 파일을 Read로 열었다'는 줄을 끼운다 (실제 Claude Code 스트림의 모양 — 이미지가 한 줄에 두 번 실린다, S6-21 C1).
   * 턴을 띄울 때마다 읽는다 — 부팅 뒤에 찍은 캡처 파일의 경로를 더한다. 그때 없는 파일은 건너뛴다
   */
  readImages?: string[];
  /** 로그인 방식 (리드 결정 S3-2) — 'server'면 개발 모드 로그인을 하지 않는다(대표 요청은 기기 세션을 가진 원격 호출자로). 없으면 'desktop' */
  mode?: 'desktop' | 'server';
  /** 스케줄러 자동 실행을 끈다 (턴을 띄우지 않는 경계 시험) */
  stopScheduler?: boolean;
  /** 개발 모드 로그인 (기본: 패키징 아니면 함) */
  devLogin?: boolean;
  /** 로그인 뒤 설정 */
  settings?: DeepPartial<Settings>;
  /** 부팅 전에 DB에 넣어 둘 설정 (로그인 전 상태 시험) */
  preSettings?: DeepPartial<Settings>;
  /** 실제 Claude·Codex CLI 확인 대신 고정 결과 (기본 true — 이 그룹은 실제 CLI를 띄우지 않는다) */
  stubCliDetect?: boolean;
  runnerMode?: 'jobobject' | 'taskkill' | 'pgroup';
  speed?: number;
  /** 이 실행 명세의 프로세스 종료를 몇 ms 늦출지 (0이면 그대로). 모의 에이전트 명세의 env에 WOOK_MOCK_WORKKEY·WOOK_MOCK_MEMBER가 있다 */
  slowKill?: (spec: RunSpec) => number;
  /** 화면 도우미 (리드 결정 S6-13 AC-20) — 가짜 도우미의 launcher. 없으면 화면 도구는 쓸 수 없다 */
  desktop?: DesktopDeps;
}

/** terminate()만 delayMs 늦게 시작하는 프로세스 (그동안 CLI는 살아 있고 턴 토큰도 유효하다) */
function withSlowTerminate(p: ManagedProcess, delayMs: number): ManagedProcess {
  let pending: Promise<TerminateResult> | null = null;
  return {
    get pid() {
      return p.pid;
    },
    childPid: p.childPid,
    onStdoutLine: (cb) => p.onStdoutLine(cb),
    onStderrLine: (cb) => p.onStderrLine(cb),
    exited: p.exited,
    terminate(opts) {
      pending ??= sleep(delayMs).then(() => p.terminate(opts));
      return pending;
    },
  };
}

function slowKillRunner(real: ProcessRunner, pick: (spec: RunSpec) => number): ProcessRunner {
  return {
    get mode() {
      return real.mode;
    },
    get detail() {
      return real.detail;
    },
    start(spec) {
      const proc = real.start(spec);
      const delay = pick(spec);
      return delay > 0 ? withSlowTerminate(proc, delay) : proc;
    },
    isAlive: (pid) => real.isAlive(pid),
    processCreatedAt: (pids) => real.processCreatedAt(pids),
    killTree: (pid) => real.killTree(pid),
  };
}

/** 같은 폴더인지 (Windows는 대소문자 무시) */
export function samePath(a: string, b: string): boolean {
  const n = (p: string) => resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
}

/** git rev-parse (없으면 null) */
export function revParse(dir: string, ref: string): string | null {
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', '--verify', '--quiet', ref], { encoding: 'utf8', windowsHide: true }).trim() || null;
  } catch {
    return null;
  }
}

export interface App {
  orch: Orchestrator;
  core: Orchestrator['core'];
  ctx: Orchestrator['core']['ctx'];
  dataDir: string;
  logger: FileLogger;
  launches: CapturedLaunch[];
  errors: string[];
  invoke<M extends WookMethod>(method: M, ...args: WookParams<M>): Promise<WookResult<M>>;
  /** 운영자 내부 API — 시험 준비 (SERVER_DESIGN 10.11 '준비 → 내부 API') */
  internal<M extends WookMethod>(method: M, ...args: WookParams<M>): Promise<WookResult<M>>;
  /** 메인 에이전트 운영 도구 (10.11 '대표 조작 → 메인 도구'). 거부되면 code를 가진 오류로 던진다 */
  main(tool: string, args?: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** 화면으로 나간 푸시를 모은다 */
  pushed: { topic: WookTopic; payload: unknown }[];
  /** 오케스트레이터만 멈춘다 (데이터 폴더 유지 — 재시작 시험). 화면 도우미를 붙인 실행에 모의 실행이 아닌 메인 턴이 있었으면 멈춘 뒤 던진다 (S6-23 T1) */
  stop(): Promise<void>;
  /** 멈추고 만든 폴더를 지운다. 그 뒤 stop()과 같은 확인으로 던진다 */
  close(extra?: string[]): Promise<void>;
}

const STUB_STATUS: CliStatus = { installed: true, path: 'stub', version: '9.9.9', loggedIn: true, problem: null, detail: '시험용 고정 CLI 상태' };

export async function bootApp(o: AppOptions = {}): Promise<App> {
  /** 이 실행이 시작한 때 — 같은 데이터 폴더의 앞선 실행이 남긴 턴은 세지 않는다 (close의 메인 턴 확인) */
  const bootedMs = Date.now();
  const ownDataDir = !o.dataDir;
  const dataDir = o.dataDir ?? tempDir('data');
  const logger = createFileLogger({ dir: join(dataDir, 'logs'), fileName: 'backend.log' });
  const errors: string[] = [];
  const deps = await buildOrchestratorDeps({
    dataDir,
    appRoot: process.cwd(),
    isPackaged: o.isPackaged ?? false,
    nodeExecPath: process.execPath,
    nodeExecEnv: {},
    shell: o.shell ?? null,
    memorySecrets: true,
    runnerMode: o.runnerMode,
    ...(o.mode ? { mode: o.mode } : {}),
    desktop: o.desktop ?? null,
    timing: { watchdogMs: 200, snapshotThrottleMs: 20 },
    logger: (level, msg, extra) => {
      if (extra === undefined) logger[level](msg);
      else logger[level](msg, extra);
      if (level === 'error') errors.push(`${msg}${extra instanceof Error ? ` :: ${extra.message}` : ''}`);
    },
  });
  // 실제 앱(createBackend)처럼 로그 파일에도 대표 등록 값·턴 토큰까지 가린 값만 남긴다
  logger.setRedactor((t) => deps.redactor.text(t));
  if (o.secrets) deps.secrets = o.secrets;
  if (o.googleLogin) deps.googleLogin = o.googleLogin;
  if (o.slowKill) deps.runner = slowKillRunner(deps.runner, o.slowKill);
  if (o.stubCliDetect !== false) {
    deps.adapters.claude = { ...deps.adapters.claude, detect: async () => ({ ...STUB_STATUS, detail: 'claude 시험용' }) };
    deps.adapters.codex = { ...deps.adapters.codex, detect: async () => ({ ...STUB_STATUS, detail: 'codex 시험용' }) };
  }
  if (o.preSettings) deps.store.kv.set('settings', o.preSettings);
  // 화면 도우미를 붙이면 첫 보유자의 화면 확인 업무(screen_check)가 시작 때 들어가 곧바로 메인 턴이 뜬다 (리드 결정 S6-10) — 그 턴이 실제 CLI로 뜨지 않게
  // 모의 실행을 시작 전에 켠다. 로그인 뒤의 설정(아래)은 그대로 덮는다
  if (o.desktop) {
    const pre = (o.preSettings ?? {}) as DeepPartial<Settings>;
    deps.store.kv.set('settings', { ...pre, developer: { ...(pre.developer ?? {}), mainAgentMock: true, mockSpeed: o.speed ?? 25 } });
  }

  const launches: CapturedLaunch[] = [];
  const realMock = deps.adapters.mock;
  let wrapper: string | null = null;
  if (o.leak || o.readImages) {
    const dir = tempDir('wrap');
    wrapper = join(dir, 'leak-wrapper.cjs');
    writeFileSync(wrapper, LEAK_WRAPPER, 'utf8');
  }
  const mock: AgentAdapter = {
    kind: 'mock',
    detect: () => realMock.detect(),
    createParser: (launch) => realMock.createParser(launch),
    async prepare(launch) {
      const run = await realMock.prepare(launch);
      launches.push({ token: launch.mcp.token, url: launch.mcp.url, workKey: launch.mock?.workKey ?? '', memberId: launch.mock?.memberId ?? '', role: launch.mock?.role ?? '' });
      if (!wrapper) return run;
      // 이미지 Read 줄은 메인 턴에만 끼운다 (캡처 파일을 여는 것은 메인이다)
      const reads = launch.mock?.memberId === MAIN_AGENT_ID ? (o.readImages ?? []) : [];
      return { ...run, spec: { ...run.spec, args: [wrapper, ...run.spec.args], env: { ...run.spec.env, WOOK_TEST_LEAKS: JSON.stringify(o.leak ?? []), WOOK_TEST_READ_IMAGES: JSON.stringify(reads) } } };
    },
  };
  deps.adapters.mock = mock;

  const orch = await createOrchestrator(deps);
  if (o.stopScheduler) orch.core.scheduler.stop();
  const pushed: App['pushed'] = [];
  const offs: (() => void)[] = [];
  for (const topic of ['snapshot', 'cliEvents', 'notification', 'navigate', 'emergency', 'openSettings'] as WookTopic[]) {
    offs.push(orch.backend.onTopic(topic, (payload: WookTopics[typeof topic]) => pushed.push({ topic, payload })));
  }
  const invoke = (<M extends WookMethod>(method: M, ...args: WookParams<M>) => orch.backend.invoke(method, args)) as App['invoke'];
  const internal = internalInvoker(orch.core) as App['internal'];
  if (o.devLogin ?? !o.isPackaged) {
    // 서버 모드에는 개발 모드 로그인이 없다 (S3-2) — 모의 실행 설정만 넣는다
    if (o.mode !== 'server') await invoke('auth.devLogin');
    await internal('settings.update', {
      developer: { mainAgentMock: true, mockSpeed: o.speed ?? 25 },
      ...(o.settings ?? {}),
    } as DeepPartial<Settings>);
  }
  // 고정 CLI 상태가 기록될 때까지 (시작 시 비동기 확인)
  await waitFor(() => orch.core.ctx.ai('claude').checkedAt !== null && orch.core.ctx.ai('codex').checkedAt !== null, 'CLI 확인', 30_000).catch(() => undefined);

  /**
   * 화면 도우미를 붙인 실행은 시작하자마자 메인 턴(화면 확인)이 뜬다 — 이 실행이 띄운 메인 턴이 모두 모의 실행이었는지 끝낼 때 확인한다 (리드 결정 S6-19·S6-21 J4).
   * 실제 Claude·Codex CLI로 뜬 메인 턴이 하나라도 있으면(모의 실행 설정을 잃었다) 사용량이 든다. 멈추기 전에 본다 — 멈추면 DB가 닫힌다
   */
  const realMainTurns = (): string | null => {
    if (!o.desktop) return null;
    const turns = orch.core.ctx.store.turns.list({ ref1: MAIN_AGENT_ID }).filter((t) => Date.parse(t.startedAt) >= bootedMs);
    // 기록이 모의가 아닌 메인 턴은 뜨는 중이어도 잘못이다
    const real = turns.filter((t) => !t.mock).map((t) => `${t.id}(${t.aiKind})`);
    // 띄운 수와 견주는 것은 프로세스가 뜬 턴뿐이다 — 막 뜨는 모의 턴(줄은 있고 모의 어댑터의 prepare가 아직 끝나지 않았다)을 '모의가 아니다'로 읽지 않는다. 모의
    // 어댑터는 prepare가 끝날 때(프로세스를 띄우기 전에) 센다 — 모의 어댑터를 거치지 않고 프로세스가 뜬 턴이 있으면 띄운 수가 모자란다 (S6-25 P1)
    const started = turns.filter((t) => t.process.pid !== null || t.process.spawnedAt !== null).length;
    const viaMock = launches.filter((l) => l.memberId === MAIN_AGENT_ID).length;
    if (!real.length && viaMock >= started) return null;
    return `화면 도우미를 붙인 시험에서 모의 실행이 아닌 메인 턴이 떴습니다 — 실제 CLI를 띄웠을 수 있습니다 (프로세스가 뜬 메인 턴 ${started}개 가운데 모의 어댑터로 띄운 것 ${viaMock}개${real.length ? `, 모의 실행이 아닌 턴: ${real.join(', ')}` : ''})`;
  };
  let mainProblem: string | null = null;
  let stopped = false;
  /** 오케스트레이터를 한 번만 멈추고, 멈추기 전에 메인 턴이 모두 모의였는지 잰다 (던지지 않는다 — stop·close가 던진다) */
  const halt = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    for (const off of offs) off();
    try {
      mainProblem = realMainTurns();
    } catch (e) {
      mainProblem = `메인 턴이 모의 실행이었는지 확인하지 못했습니다: ${e instanceof Error ? e.message : String(e)}`;
    }
    await orch.stop().catch(() => undefined);
    logger.close();
  };
  const app: App = {
    orch,
    core: orch.core,
    ctx: orch.core.ctx,
    dataDir,
    logger,
    launches,
    errors,
    invoke,
    internal,
    main: (tool: string, args: Record<string, unknown> = {}) => mainOp(orch.core, tool, args),
    pushed,
    async stop() {
      await halt();
      // 다시 시작 시험은 앞 실행을 stop()만 하고 새 실행을 띄운다 — 그 앞 실행이 띄운 메인 턴도 여기서 확인을 받는다 (S6F2b, 리드 결정 S6-23 T1)
      if (mainProblem) throw new Error(mainProblem);
    },
    async close(extra = []) {
      await halt();
      await removeDirs([...(ownDataDir ? [dataDir] : []), ...(wrapper ? [join(wrapper, '..')] : []), ...extra]);
      // 폴더를 지운 뒤에 알린다 — 시험이 실패해도 남는 것이 없게
      if (mainProblem) throw new Error(mainProblem);
    },
  };
  return app;
}

// ───────────────────────── 프로젝트·팀 ─────────────────────────

export interface ProjectFixture {
  id: string;
  dir: string;
  root: string;
  producerId: string;
  members: Record<string, string>;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

/**
 * 프로젝트를 만든다. files가 있으면 그 파일을 커밋한 기존 저장소를 연결(existing), 없으면 새 폴더(new).
 * team은 프로듀서 외 팀원 역할 (같은 역할이 두 번이면 developer2처럼).
 */
export async function addProject(
  app: App,
  o: { name?: string; team?: RoleId[]; mock?: boolean; scenarios?: Partial<Record<string, MockScenario>>; checkCommands?: string[]; files?: Record<string, string>; speed?: number } = {},
): Promise<ProjectFixture> {
  const root = tempDir('proj');
  const dir = join(root, 'proj');
  let mode: 'new' | 'existing' = 'new';
  if (o.files) {
    mkdirSync(dir, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main', dir]);
    for (const [name, content] of Object.entries(o.files)) writeFileSync(join(dir, name), content, 'utf8');
    git(dir, ['add', '-A']);
    git(dir, ['-c', 'user.name=owner', '-c', 'user.email=owner@example.invalid', 'commit', '-q', '-m', 'init']);
    mode = 'existing';
  }
  const p = await app.internal('projects.create', { mode, path: dir, name: o.name ?? '보안 시험', checkCommands: o.checkCommands ?? [] });
  if (o.mock !== false) await app.internal('projects.setMock', p.id, { enabled: true, speed: o.speed ?? 25, defaultScenario: 'normal' });
  const members: Record<string, string> = { producer: p.producerId };
  const counts: Record<string, number> = {};
  for (const roleId of o.team ?? []) {
    const m = await app.internal('members.add', { projectId: p.id, roleId });
    counts[roleId] = (counts[roleId] ?? 0) + 1;
    members[counts[roleId] === 1 ? roleId : `${roleId}${counts[roleId]}`] = m.id;
  }
  for (const [role, scenario] of Object.entries(o.scenarios ?? {})) {
    const id = members[role];
    if (id && scenario) await app.internal('members.update', id, { mockScenario: scenario });
  }
  return { id: p.id, dir, root, producerId: p.producerId, members };
}

/** 대표 명령을 보내고 새 지시가 생길 때까지 */
export async function sendCommand(app: App, projectId: string, text: string): Promise<string> {
  const before = new Set(app.ctx.store.directives.list().map((d) => d.id));
  await app.invoke('command.send', { target: projectId, text });
  let id = '';
  await waitFor(() => {
    const d = app.ctx.store.directives.list().find((x) => !before.has(x.id));
    if (d) id = d.id;
    return !!d;
  }, '지시 등록');
  return id;
}

// ───────────────────────── 앱 도구 (실제 HTTP) ─────────────────────────

let turnSeq = 0;

/** 턴 실행기가 토큰을 발급할 때와 같은 신원 (orchestrator/turns.ts launch) */
export function identityFor(app: App, memberId: string, sessionKey: string): TokenIdentity {
  const m = app.ctx.store.members.require(memberId);
  const role = m.isMain ? null : roleOf(app.ctx, m.roleId);
  turnSeq += 1;
  return {
    turnId: `TN-ACC${String(turnSeq).padStart(4, '0')}`,
    sessionId: `S-ACC${String(turnSeq).padStart(4, '0')}`,
    sessionKey,
    sessionKind: parseKey(sessionKey).kind,
    memberId: m.id,
    projectId: m.projectId,
    isMain: m.isMain,
    isProducer: m.isProducer,
    canReview: !!role?.canReview || m.isProducer,
  };
}

export function tokenFor(app: App, memberId: string, sessionKey: string): string {
  return app.core.toolServer.issueToken(identityFor(app, memberId, sessionKey));
}

export const mainToken = (app: App, projectId: string | null) => tokenFor(app, MAIN_AGENT_ID, projectId ? `main:${projectId}` : 'main:general');

export interface ToolResponse {
  status: number;
  ok: boolean;
  code?: string;
  message?: string;
  data?: Record<string, unknown>;
}

let rpcId = 0;

/** 앱 도구 서버에 tools/call 한 번 (Authorization 헤더는 token이 null이면 빼고, raw가 있으면 그 값 그대로) */
export async function callTool(app: App, token: string | null, name: string, args: Record<string, unknown> = {}, o: { authorization?: string } = {}): Promise<ToolResponse> {
  const url = app.core.toolServer.url;
  if (!url) throw new Error('앱 도구 서버가 열려 있지 않습니다');
  rpcId += 1;
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  if (o.authorization !== undefined) headers.Authorization = o.authorization;
  else if (token !== null) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: rpcId, method: 'tools/call', params: { name, arguments: args } }) });
  const body = (await res.json()) as { result?: { isError?: boolean; content?: { text?: string }[] }; error?: { code: number; message: string } };
  if (res.status !== 200 || body.error) return { status: res.status, ok: false, code: res.status === 401 ? 'unauthorized' : 'http', message: body.error?.message };
  const text = body.result?.content?.[0]?.text ?? '';
  const parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (body.result?.isError) return { status: 200, ok: false, code: String(parsed.error), message: String(parsed.message) };
  return { status: 200, ok: true, data: parsed };
}

/** 앱 도구 거부 기록 (orchestrator.ts onCall → 활동 기록 kind 'app_tool', '<도구> 거부') */
export function toolRejections(app: App): { tool: string; memberId: string | null; result: string | null; level: string; seq: number }[] {
  return app.ctx.store.activity
    .search({ kinds: ['app_tool'], limit: 5000 })
    .filter((e) => e.text.endsWith(' 거부'))
    .map((e) => ({ tool: e.text.slice(0, -' 거부'.length), memberId: e.memberId, result: e.result, level: e.level, seq: e.seq }));
}

// ───────────────────────── 수신 포트 (AC-02) ─────────────────────────

export interface Listener {
  proto: 'TCP' | 'UDP';
  address: string;
  port: number;
  pid: number;
}

function parseEndpoint(s: string): { address: string; port: number } {
  const i = s.lastIndexOf(':');
  let address = s.slice(0, i);
  if (address.startsWith('[') && address.endsWith(']')) address = address.slice(1, -1);
  return { address, port: Number(s.slice(i + 1)) };
}

/** 이 PC에서 지금 열린 수신 소켓 (TCP LISTEN + UDP 바인딩) 중 pids 것 */
export function listeners(pids: number[]): Listener[] {
  const want = new Set(pids);
  const out: Listener[] = [];
  if (process.platform === 'win32') {
    const text = execFileSync('netstat', ['-ano'], { encoding: 'latin1', windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
    for (const line of text.split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/);
      if (parts[0] === 'TCP' && parts.length >= 5 && parts[3] === 'LISTENING') {
        const pid = Number(parts[4]);
        if (want.has(pid)) out.push({ proto: 'TCP', ...parseEndpoint(parts[1]!), pid });
      } else if (parts[0] === 'UDP' && parts.length >= 4) {
        const pid = Number(parts[parts.length - 1]);
        if (want.has(pid)) out.push({ proto: 'UDP', ...parseEndpoint(parts[1]!), pid });
      }
    }
    return out;
  }
  for (const [flag, proto] of [
    ['-iTCP -sTCP:LISTEN', 'TCP'],
    ['-iUDP', 'UDP'],
  ] as const) {
    let text = '';
    try {
      text = execFileSync('lsof', ['-nP', ...flag.split(' '), '-a', '-p', pids.join(','), '-F', 'pn'], { encoding: 'utf8' });
    } catch {
      continue; // 열린 소켓이 없으면 lsof는 1로 끝난다
    }
    let pid = 0;
    for (const l of text.split('\n')) {
      if (l.startsWith('p')) pid = Number(l.slice(1));
      else if (l.startsWith('n')) out.push({ proto, ...parseEndpoint(l.slice(1).split('->')[0]!), pid });
    }
  }
  return out;
}

export const isLoopback = (address: string) => address === '::1' || /^127\./.test(address) || address === 'localhost';

/** pid와 그 아래 모든 하위 프로세스 */
export function processTree(root: number): number[] {
  let rows: [number, number][] = [];
  if (process.platform === 'win32') {
    const text = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }'],
      { encoding: 'utf8', windowsHide: true, timeout: 60_000 },
    );
    rows = text
      .split(/\r?\n/)
      .map((l) => l.trim().split(/\s+/).map(Number) as [number, number])
      .filter((r) => r.length === 2 && Number.isFinite(r[0]) && Number.isFinite(r[1]));
  } else {
    const text = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' });
    rows = text
      .split('\n')
      .map((l) => l.trim().split(/\s+/).map(Number) as [number, number])
      .filter((r) => r.length === 2);
  }
  const out = new Set([root]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [pid, ppid] of rows) {
      if (out.has(ppid) && !out.has(pid) && pid !== ppid) {
        out.add(pid);
        grew = true;
      }
    }
  }
  return [...out];
}

/** 루프백이 아닌 이 PC의 주소들 (다른 기기에서 접속할 때 쓰는 주소) */
export function lanAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((a): a is NonNullable<typeof a> => !!a && !a.internal && a.family === 'IPv4')
    .map((a) => a.address);
}

/** 그 주소·포트로 TCP 연결이 되는지 */
export function canConnect(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = netConnect({ host, port });
    const done = (v: boolean) => {
      socket.destroy();
      resolve(v);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

// ───────────────────────── 값 찾기 (AC-20·33) ─────────────────────────

export interface Hit {
  file: string;
  needle: string;
}

/** root 아래 모든 파일의 바이트에서 needles(UTF-8)를 찾는다. exclude는 root 기준 첫 폴더 이름 */
export function scanFiles(root: string, needles: string[], o: { exclude?: string[] } = {}): Hit[] {
  const hits: Hit[] = [];
  const bufs = needles.map((n) => ({ n, b: Buffer.from(n, 'utf8') }));
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(dir, name);
      const rel = relative(root, full);
      if (o.exclude?.includes(rel.split(sep)[0]!)) continue;
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full);
      else if (st.isFile()) {
        let data: Buffer;
        try {
          data = readFileSync(full);
        } catch {
          continue;
        }
        for (const { n, b } of bufs) if (data.includes(b)) hits.push({ file: rel, needle: n });
      }
    }
  };
  if (existsSync(root)) walk(root);
  return hits;
}

/** DB의 모든 표를 문자열로 */
export function dumpDb(app: App): string {
  const db = app.ctx.store.db;
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[];
  const out: Record<string, unknown[]> = {};
  for (const { name } of tables) out[name] = db.prepare(`SELECT * FROM "${name}"`).all() as unknown[];
  return JSON.stringify(out);
}

/** 대표 화면에서 볼 수 있는 모든 것 (스냅샷·팀원 상세·CLI 원본 형식·작업 상세·diff·지시·보고서·알림·대화·기록·설정) */
export async function screenDump(app: App): Promise<string> {
  const inv = app.invoke;
  const snap = await inv('snapshot.get');
  const memberIds = [MAIN_AGENT_ID, ...app.ctx.store.members.list().filter((m) => !m.isMain).map((m) => m.id)];
  const members: unknown[] = [];
  for (const id of memberIds) {
    members.push(await inv('members.getDetail', id).catch((e: Error) => `오류 ${e.message}`));
    for (const t of app.ctx.store.turns.list({ ref1: id })) members.push(await inv('members.getEvents', id, { turnId: t.id, limit: 1000 }));
  }
  const tasks: unknown[] = [];
  for (const t of app.ctx.store.tasks.list()) {
    tasks.push(await inv('tasks.get', t.id));
    tasks.push(await inv('tasks.getDiff', t.id));
  }
  const directives: unknown[] = [];
  for (const d of app.ctx.store.directives.list()) directives.push(await inv('directives.get', d.id));
  const reports: unknown[] = [await inv('reports.list', {})];
  for (const r of app.ctx.store.reports.list()) reports.push(await inv('reports.get', r.id));
  const conversations: unknown[] = [];
  for (const target of ['main', ...app.ctx.store.projects.list().map((p) => p.id)]) conversations.push(await inv('command.history', target, { limit: 500 }));
  return JSON.stringify({
    snap,
    members,
    tasks,
    directives,
    reports,
    conversations,
    notifications: await inv('notifications.list', { limit: 500 }),
    logs: await inv('logs.search', { limit: 5000 }),
    recovery: await inv('recovery.list'),
    settings: await inv('settings.get'),
    info: await inv('system.info'),
    roles: await inv('roles.list'),
    pushed: app.pushed,
  });
}
