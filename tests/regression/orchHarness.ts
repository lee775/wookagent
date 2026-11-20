/**
 * 턴 단위 회귀 테스트 하네스: 실제 오케스트레이터(저장소·git·스케줄러·턴 실행기·앱 도구 처리기·복구)를 띄우고
 * CLI 쪽만 가짜로 둔다 — 프로세스 러너·어댑터·앱 도구 서버(HTTP 대신 처리기를 직접 부름).
 * 스케줄러의 자동 실행(2초 주기·tick 신호)은 끄고, 테스트가 tick()으로 한 번씩 돌린다 — 어떤 턴이 언제 뜨는지 테스트가 정한다.
 * 가짜 프로세스는 기본으로 곧바로 result 이벤트를 내고 정상 종료한다. hold에 넣은 세션 키는 종료(terminate)될 때까지 살아 있다.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Directive, ReviewTarget, Settings, SkillEntry, Task } from '@shared/domain';
import type { ParsedCliEvent } from '@shared/events';
import type { DeepPartial, WookMethod, WookParams, WookResult } from '@shared/ipc';
import { createRedactor } from '@core/redact';
import type { Clock } from '@core/time';
import { harnessClock } from './steadyClock';
import { openStore } from '../../src/main/db/store';
import { createGitService } from '../../src/main/git/gitService';
import type { AgentAdapter, PreparedRun, TurnLaunch } from '../../src/main/agents/types';
import type { ExitInfo, ManagedProcess, ProcessRunner, RunSpec, TerminateResult } from '../../src/main/process/types';
import type { ProcStart } from '../../src/main/process/procfs';
import type { AppToolServer, TokenIdentity, ToolCallResult } from '../../src/main/mcp/types';
import type { OrchestratorDeps } from '../../src/main/orchestrator/context';
import type { DesktopDeps } from '../../src/main/desktop/service';
import type { ScreenOff } from '../../src/main/desktop/safety';
import { createOrchestrator, type Orchestrator } from '../../src/main/orchestrator/orchestrator';
import { dataPaths, reviewCopyPath } from '../../src/main/orchestrator/paths';
import { internalInvoker, mainOp, seedStoredSettings } from './mainOps';

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(pred: () => boolean, label = '조건', ms = 15_000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`시간 초과: ${label}`);
    await sleep(10);
  }
}

/** 가짜 CLI 프로세스. 테스트가 이벤트를 내고 끝낸다 */
export class FakeProc implements ManagedProcess {
  private static nextPid = 70_000;
  /** 시험: 새로 만드는 가짜 프로세스의 부팅 기준 신원 (Linux 러너가 띄운 직후 /proc에서 읽는 값의 흉내, S10-5.1). 기본 없음 — 쓴 시험이 되돌린다 */
  static startForNew: ProcStart | null = null;
  /** 시험: 새로 만드는 가짜 프로세스의 실행 표시 값 (Linux 러너가 환경에 넣는 값의 흉내, S10-10.2). 기본 없음 — 쓴 시험이 되돌린다 */
  static runTagForNew: string | null = null;
  readonly pid = FakeProc.nextPid++;
  readonly start: ProcStart | null = FakeProc.startForNew;
  readonly runTag: string | null = FakeProc.runTagForNew;
  readonly childPid = Promise.resolve(null);
  private readonly outs: ((l: string) => void)[] = [];
  private readonly errs: ((l: string) => void)[] = [];
  private resolveExit!: (e: ExitInfo) => void;
  readonly exited: Promise<ExitInfo> = new Promise((r) => (this.resolveExit = r));
  done = false;
  terminatedByApp = false;
  /** terminate()가 돌려줄 결과 (기본: 종료 확인) */
  terminateResult: TerminateResult = { ok: true, remaining: 0, detail: '가짜 종료', durationMs: 1 };

  constructor(
    readonly workKey: string,
    readonly memberId: string,
    readonly turnId: string,
  ) {}

  onStdoutLine(cb: (l: string) => void): void {
    this.outs.push(cb);
  }
  onStderrLine(cb: (l: string) => void): void {
    // 가짜 프로세스는 errLine을 부를 때만 표준 오류를 낸다
    this.errs.push(cb);
  }
  /** 날 글 한 줄을 표준 출력으로 낸다 (서버 명령 host_exec의 출력 흉내 — 해석하지 않는다) */
  line(text: string): void {
    for (const cb of this.outs) cb(text);
  }
  /** 날 글 한 줄을 표준 오류로 낸다 (host_exec의 출력 흉내) */
  errLine(text: string): void {
    for (const cb of this.errs) cb(text);
  }
  /** 해석된 CLI 이벤트 하나를 낸다 (가짜 파서가 JSON을 그대로 돌려준다) */
  emit(ev: ParsedCliEvent): void {
    const line = JSON.stringify(ev);
    for (const cb of this.outs) cb(line);
  }
  /** result 이벤트 후 정상 종료 */
  finishOk(text = '끝'): void {
    if (this.done) return;
    this.emit({ kind: 'result', text, data: {} });
    this.exit(0);
  }
  exit(code: number | null, o: { terminated?: boolean; remaining?: number } = {}): void {
    if (this.done) return;
    this.done = true;
    this.resolveExit({ code, signal: null, leftoverKilled: 0, remaining: o.remaining ?? 0, durationMs: 1, terminated: !!o.terminated });
  }
  async terminate(): Promise<TerminateResult> {
    this.terminatedByApp = true;
    this.exit(null, { terminated: true });
    return this.terminateResult;
  }
}

export interface LaunchRecord {
  turnId: string;
  workKey: string;
  memberId: string;
  model: string | null;
  effort: string | null;
  resume: string | null;
  newSessionId: string | null;
  message: string;
  mock: boolean;
}

export interface OrchEnv {
  orch: Orchestrator;
  core: Orchestrator['core'];
  ctx: Orchestrator['core']['ctx'];
  dataDir: string;
  projectDir: string;
  projectId: string;
  producerId: string;
  devId: string;
  qaId: string;
  procs: FakeProc[];
  /** 러너가 받은 실행 명세 (자동 검사 제외) — 자식 환경 검사용 */
  specs: RunSpec[];
  launches: LaunchRecord[];
  /** 이 세션 키의 가짜 프로세스는 종료될 때까지 살아 있다 */
  hold: Set<string>;
  /** 세션 키별 가짜 프로세스 동작 (hold보다 우선). 없으면 곧바로 정상 종료 */
  script: Map<string, (p: FakeProc) => void>;
  /** 어댑터 prepare에서 부른다 — 던지면 시작 실패 (실행 값 검사 실패 흉내) */
  prepareHook: ((launch: TurnLaunch, who: TokenIdentity) => void) | null;
  /** 자동 검사 프로세스 동작 (없으면 곧바로 성공). checkProcs에 기록된다 */
  check: ((p: FakeProc) => void) | null;
  /**
   * 가짜 스킬 찾기(scanSkills)가 돌려주는 목록 — 시험이 바꿀 수 있다(방금 설치한 스킬 등). skills: null로 띄우면 scanSkills가 없어 빈 목록이다 (리드 결정 S5-14)
   */
  skills: SkillEntry[];
  /** 가짜 스킬 찾기를 부른 횟수 (찾은 스킬 캐시 확인용) */
  skillScans: number;
  checkProcs: FakeProc[];
  /** 서버 명령(host_exec, 러너 이름 '서버 명령 ')의 실행 명세 — 띄운 차례대로 */
  hostSpecs: RunSpec[];
  /** 서버 명령 프로세스 (hostExec가 없을 때 만든 가짜) */
  hostProcs: FakeProc[];
  /** 서버 명령을 띄우는 법 — 없으면 가짜 프로세스가 곧바로 0으로 끝난다. 실제 러너를 넘기면 실제 프로세스 트리가 돈다 (리드 결정 S5-18) */
  hostExec: ((spec: RunSpec) => ManagedProcess) | null;
  /** 메인 에이전트 작업 폴더 (workspace: true로 띄웠을 때 — 데이터 폴더 밖 임시 폴더 아래 main, 리드 결정 S5-20). 아니면 null */
  mainWorkDir: string | null;
  errors: string[];
  /** 대표가 부르는 길 (Backend.invoke — 대표 메서드만, SERVER_DESIGN 2.5) */
  invoke<M extends WookMethod>(method: M, ...args: WookParams<M>): Promise<WookResult<M>>;
  /** 운영자 내부 API (시험 준비 — 프로젝트·팀원·모의 설정 등, createInternalApi) */
  internal<M extends WookMethod>(method: M, ...args: WookParams<M>): Promise<WookResult<M>>;
  /** 메인 에이전트 운영 도구 (SERVER_DESIGN 2.6). 거부되면 code를 가진 오류로 던진다 */
  main(tool: string, args?: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** 스케줄러를 한 번 돌린다 */
  tick(): void;
  /** 실행 중 턴이 모두 끝날 때까지 */
  idle(label?: string): Promise<void>;
  /** tick → 모든 턴 종료를 n번 */
  drain(rounds?: number): Promise<void>;
  identity(turnId: string): TokenIdentity;
  /** 그 턴의 신원으로 앱 도구 처리기 호출 (에이전트 대신) */
  tool(turnId: string, name: string, args?: Record<string, unknown>): Promise<ToolCallResult>;
  liveProc(key: string, memberId?: string): FakeProc | undefined;
  close(): Promise<void>;
}

export interface OrchOptions {
  /** 프로젝트·메인 에이전트 모의 실행 (기본 true). false면 claude·codex 어댑터 경로 (AI 가용성 기록·검사 포함) */
  mock?: boolean;
  settings?: DeepPartial<Settings>;
  checkCommands?: string[];
  /** 앱 시계 (기본 시스템 시계) — 긴 시간이 지나는 것을 보는 시험(응답 없음의 5분·30분·2시간 알림 등)이 앞당겨 쓴다 */
  clock?: Clock;
  /**
   * 로그인 방식 (BackendDeps.mode, 기본 데스크톱). 'server'면 대표에게 가는 글이 서버 대표에게 맞는지 보는 시험이 쓴다 — kv 대표 세션이 없어 개발 모드 로그인을
   * 하지 않으므로 invoke(대표의 길)는 로그인 전 거부다. 그 시험은 core·internal로 부른다
   */
  mode?: 'desktop' | 'server';
  /** 가짜 스킬 찾기가 돌려줄 스킬 (기본 FAKE_SKILLS). null이면 scanSkills를 넘기지 않는다 — 찾은 스킬이 없는 앱 (리드 결정 S5-14) */
  skills?: SkillEntry[] | null;
  /**
   * 메인 에이전트 작업 폴더를 데이터 폴더 밖 임시 폴더(작업 폴더 위치) 아래 main으로 (리드 결정 S5-20 — 제품과 같은 배치). 함수면 그 데이터 폴더로 정한 폴더를 그대로
   * 넘긴다(시작 때 확인에 걸리는 폴더 시험). 없으면 예전 자리 <dataDir>/main-agent
   */
  workspace?: boolean | ((dataDir: string) => string);
  /** 가짜 러너에 더할 것 (실행 환경 문제 problem·onProblem 등 — 오케스트레이터가 시작할 때 구독하므로 띄우기 전에 준다, 리드 결정 S6-5) */
  runnerPatch?: Partial<Pick<ProcessRunner, 'problem' | 'onProblem' | 'detail'>>;
  /** 화면 도우미 (리드 결정 S6-3) — 가짜 도우미(tests/fixtures/desktop/fakeDesktop.ts)의 launcher. 없으면 화면 도구는 unavailable이고 화면 확인 업무가 없다 */
  desktop?: DesktopDeps;
  /** 이 실행에서 화면 조작을 쓰지 않는 까닭 (리드 결정 S6-11 — 제품에서는 앱 조립 buildDeps가 정한다: 데스크톱 앱·Windows 밖·운영자가 끔) */
  screenOff?: ScreenOff;
  /** 이 PC의 최근 CPU 사용률을 흉내 낸다 (cpuGuard.ts — 제품에서는 앱 조립 buildDeps가 실제 측정으로 채운다). 없으면 CPU 상한이 미루지 않는다 */
  cpuLoad?: () => number | null;
  /** host_exec가 CPU가 내려가기를 기다리는 동안 다시 보는 간격 (기본 1초) */
  cpuPollMs?: number;
  /** 앱과 함께 실린 Claude 플러그인 폴더들을 흉내 낸다 (제품에서는 앱 조립 buildDeps가 앱 폴더의 claude-plugins에서 찾는다). 없으면 플러그인 없는 앱 */
  claudePlugins?: string[];
}

/** 가짜 스킬 찾기의 기본 목록 — 실제 사용자 폴더를 읽지 않는다 */
export const FAKE_SKILLS: readonly SkillEntry[] = [
  { name: 'some-skill', description: '시험용 스킬', source: 'claude', path: 'C:/fake/skills/some-skill/SKILL.md', mode: 'auto' },
  { name: 'sound-gen', description: '효과음 만들기 (시험용)', source: 'codex', path: 'C:/fake/skills/sound-gen/SKILL.md', mode: 'manual' },
];

export async function bootOrch(o: OrchOptions = {}): Promise<OrchEnv> {
  const mock = o.mock ?? true;
  const dataDir = mkdtempSync(join(tmpdir(), 'wook-test-orch-data-'));
  const projRoot = mkdtempSync(join(tmpdir(), 'wook-test-orch-proj-'));
  const projectDir = join(projRoot, 'proj');
  const procs: FakeProc[] = [];
  const launches: LaunchRecord[] = [];
  const identities = new Map<string, TokenIdentity>();
  const byToken = new Map<string, TokenIdentity>();
  const errors: string[] = [];
  const env = {} as OrchEnv;
  env.hold = new Set();
  env.script = new Map();
  env.prepareHook = null;
  env.check = null;
  env.checkProcs = [];
  env.specs = [];
  env.skills = o.skills === null ? [] : [...(o.skills ?? FAKE_SKILLS)];
  env.skillScans = 0;
  env.hostSpecs = [];
  env.hostProcs = [];
  env.hostExec = null;
  const wsRoot = o.workspace === true ? mkdtempSync(join(tmpdir(), 'wook-test-orch-ws-')) : null;
  env.mainWorkDir = typeof o.workspace === 'function' ? o.workspace(dataDir) : wsRoot ? join(wsRoot, 'main') : null;

  const runner: ProcessRunner = {
    mode: 'pgroup',
    detail: '회귀 테스트: 가짜 러너',
    start(spec: RunSpec): ManagedProcess {
      if (spec.label.startsWith('서버 명령 ')) {
        // 메인 에이전트의 서버 명령 (host_exec — hostExec.ts의 이름 앞말). 시험이 띄우는 법을 정하지 않았으면 곧바로 0으로 끝나는 가짜
        env.hostSpecs.push(spec);
        if (env.hostExec) return env.hostExec(spec);
        const h = new FakeProc('host', '', spec.label);
        env.hostProcs.push(h);
        setTimeout(() => h.exit(0), 5);
        return h;
      }
      if (spec.label.startsWith('검사 ')) {
        // 자동 검사 (autocheck.ts) — 셸 명령은 실행하지 않는다
        const c = new FakeProc('check', '', spec.label);
        env.checkProcs.push(c);
        const run = env.check;
        setTimeout(() => (run ? run(c) : c.exit(0)), 5);
        return c;
      }
      env.specs.push(spec);
      const p = new FakeProc(String(spec.args[0]), String(spec.args[1]), String(spec.args[2]));
      procs.push(p);
      const scripted = env.script.get(p.workKey);
      if (scripted) setTimeout(() => scripted(p), 5);
      else if (!env.hold.has(p.workKey)) setTimeout(() => p.finishOk(), 5);
      return p;
    },
    isAlive: async () => false,
    processCreatedAt: async () => new Map(),
    killTree: async () => ({ ok: true, remaining: 0, detail: '', durationMs: 0 }),
    ...(o.runnerPatch ?? {}),
  };

  const adapter = (kind: 'claude' | 'codex' | 'mock'): AgentAdapter => ({
    kind,
    detect: async () => ({ installed: true, path: 'fake', version: '9.9.9', loggedIn: true, problem: null, detail: '가짜' }),
    async prepare(launch: TurnLaunch): Promise<PreparedRun> {
      const who = byToken.get(launch.mcp.token);
      if (!who) throw new Error('회귀 테스트: 토큰 없는 실행');
      launches.push({
        turnId: who.turnId,
        workKey: who.sessionKey,
        memberId: who.memberId,
        model: launch.model,
        effort: launch.effort,
        resume: launch.resumeCliSessionId,
        newSessionId: launch.newSessionId,
        message: launch.message,
        mock: !!launch.mock,
      });
      env.prepareHook?.(launch, who);
      return {
        spec: { command: 'fake-cli', args: [who.sessionKey, who.memberId, who.turnId], cwd: launch.cwd, env: {}, stdinText: launch.message, label: 'fake' },
        expectedCliSessionId: launch.newSessionId,
        cleanup: [],
        display: 'fake-cli',
      };
    },
    createParser: () => ({
      pushLine: (line: string) => [JSON.parse(line) as ParsedCliEvent],
      pushStderr: (line: string) => [{ kind: 'stderr', text: line }],
      finish: () => [],
    }),
  });

  const toolServer: AppToolServer = {
    url: 'http://127.0.0.1:9/mcp',
    start: async () => ({ url: 'http://127.0.0.1:9/mcp', port: 9 }),
    stop: async () => undefined,
    issueToken(identity: TokenIdentity) {
      const token = `tok-${identity.turnId}`;
      identities.set(identity.turnId, identity);
      byToken.set(token, identity);
      return token;
    },
    revokeToken: () => undefined,
    revokeTurn: () => undefined,
  };

  const deps = {
    dataDir,
    appRoot: process.cwd(),
    isPackaged: false,
    store: openStore(dataPaths(dataDir).db),
    // 기본은 뒤로 가지 않는 벽시계 (리드 결정 S10-10.2, ./steadyClock.ts) — 시험이 준 시계는 그대로
    clock: o.clock ?? harnessClock,
    git: createGitService(),
    runner,
    adapters: { claude: adapter('claude'), codex: adapter('codex'), mock: adapter('mock') },
    createToolServer: () => toolServer,
    secrets: { get: async () => null, set: async () => undefined, delete: async () => undefined },
    redactor: createRedactor(),
    shell: null,
    logger: (level: string, msg: string, extra?: unknown) => {
      if (level === 'error') errors.push(`${msg}${extra instanceof Error ? ` :: ${extra.message}` : ''}`);
    },
    timing: { watchdogMs: 100, snapshotThrottleMs: 20, ...(o.cpuPollMs !== undefined ? { cpuPollMs: o.cpuPollMs } : {}) },
    ...(o.cpuLoad ? { cpuLoad: o.cpuLoad } : {}),
    ...(o.claudePlugins ? { claudePlugins: o.claudePlugins } : {}),
    ...(o.mode ? { mode: o.mode } : {}),
    ...(env.mainWorkDir ? { mainWorkDir: env.mainWorkDir } : {}),
    ...(o.desktop ? { desktop: o.desktop } : {}),
    ...(o.screenOff ? { screenOff: o.screenOff } : {}),
    ...(o.skills === null
      ? {}
      : {
          scanSkills: async () => {
            env.skillScans++;
            return env.skills.map((x) => ({ ...x }));
          },
        }),
  } as unknown as OrchestratorDeps;

  const orch = await createOrchestrator(deps);
  const core = orch.core;
  core.scheduler.stop(); // 자동 실행 끔 — 테스트가 tick()으로 돌린다
  const invoke = (<M extends WookMethod>(method: M, ...args: WookParams<M>) => orch.backend.invoke(method, args)) as OrchEnv['invoke'];
  // 준비는 운영자 내부 API로 (대표 세션에는 팀·프로젝트 조작이 없다, SERVER_DESIGN 2.5). 운영자가 넣은 팀원에게는 메인 에이전트 AI 결정 요청을
  // 넣지 않는다 — 예전에 끄던 'AI 결정 끄기' 설정은 없앴다 (2.7)
  const internal = internalInvoker(core) as OrchEnv['internal'];
  if (o.mode !== 'server') await invoke('auth.devLogin');
  // 시험이 주는 실행 설정(감시를 빠르게 — 제품 범위 밖일 수 있음)은 검사 없이 저장된 설정에 바로 넣는다 (리드 결정 15, seedStoredSettings)
  const { execution: seedExecution, ...settings } = o.settings ?? {};
  await internal('settings.update', {
    developer: { mainAgentMock: mock, mockSpeed: 25 },
    ...settings,
  } as DeepPartial<Settings>);
  if (seedExecution) seedStoredSettings(core, { execution: seedExecution });
  const p = await internal('projects.create', { mode: 'new', path: projectDir, name: '턴 회귀', checkCommands: o.checkCommands ?? [] });
  if (mock) await internal('projects.setMock', p.id, { enabled: true, speed: 25, defaultScenario: 'normal' });
  const dev = await internal('members.add', { projectId: p.id, roleId: 'developer' });
  const qa = await internal('members.add', { projectId: p.id, roleId: 'qa' });
  // CLI 확인(비동기)이 끝나 AI 가용성이 기록될 때까지
  await waitFor(() => core.ctx.ai('claude').checkedAt !== null && core.ctx.ai('codex').checkedAt !== null, 'CLI 확인');

  Object.assign(env, {
    orch,
    core,
    ctx: core.ctx,
    dataDir,
    projectDir,
    projectId: p.id,
    producerId: p.producerId,
    devId: dev.id,
    qaId: qa.id,
    procs,
    launches,
    errors,
    invoke,
    internal,
    main: (tool: string, args: Record<string, unknown> = {}) => mainOp(core, tool, args),
    tick: () => core.scheduler.tick(),
    async idle(label = '턴 종료') {
      await sleep(5);
      await waitFor(() => core.turns.count() === 0, label);
      await sleep(5);
    },
    async drain(rounds = 1) {
      for (let i = 0; i < rounds; i++) {
        core.scheduler.tick();
        await env.idle();
      }
    },
    identity(turnId: string) {
      const id = identities.get(turnId);
      if (!id) throw new Error(`턴 ${turnId}의 신원이 없습니다`);
      return id;
    },
    tool: (turnId: string, name: string, args: Record<string, unknown> = {}) => core.tools.handle(env.identity(turnId), name, args),
    liveProc: (key: string, memberId?: string) => procs.find((x) => x.workKey === key && !x.done && (!memberId || x.memberId === memberId)),
    async close() {
      // 턴 마무리(판정·기록)가 끝난 뒤에 저장소를 닫는다 — 닫힌 DB에 쓰다 실패하지 않게
      env.hold.clear();
      env.script.clear();
      for (const x of [...procs, ...env.checkProcs, ...env.hostProcs]) x.exit(null, { terminated: true });
      await waitFor(() => core.turns.count() === 0, '종료 전 턴 정리').catch(() => undefined);
      await sleep(150);
      await orch.stop().catch(() => undefined);
      for (const d of [dataDir, projRoot, ...(wsRoot ? [wsRoot] : [])]) {
        try {
          rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        } catch {
          // 윈도우에서 잠긴 파일이 남으면 다음 정리에 맡긴다
        }
      }
    },
  } satisfies Partial<OrchEnv>);
  return env;
}

/** 진행 상태 지시를 직접 넣는다 (프로듀서 계획 턴을 거치지 않게) */
export function seedDirective(env: OrchEnv, title = '회귀 지시'): Directive {
  const ctx = env.ctx;
  const now = ctx.now();
  const d: Directive = {
    id: ctx.store.nextId('directive'),
    projectId: env.projectId,
    title,
    text: title,
    attachments: [],
    round: 1,
    state: 'in_progress',
    rounds: [{ round: 1, requestedAt: now, text: title, anchored: [], reportId: null }],
    finalResult: null,
    planApprovalRequired: false,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    cancelledAt: null,
  };
  ctx.store.directives.insert(d);
  return d;
}

/** 검수 상태(산출물형, 대상 고정)인 개발자 작업을 직접 넣는다. 검수 사본 폴더도 만든다 */
export function seedInReviewTask(env: OrchEnv, reviewerId: string, o: { directiveId?: string; outputMode?: 'artifact' | 'repo' } = {}): Task {
  const ctx = env.ctx;
  const now = ctx.now();
  const directiveId = o.directiveId ?? seedDirective(env).id;
  const id = ctx.store.nextId('task');
  const target: ReviewTarget =
    o.outputMode === 'repo'
      ? { kind: 'repo', taskCommitSha: 'a'.repeat(40), baseMainSha: 'b'.repeat(40), pinnedAt: now }
      : { kind: 'artifact', files: [{ path: 'a.md', sha256: 'abc', size: 1 }], version: 1, pinnedAt: now };
  const t: Task = {
    id,
    projectId: env.projectId,
    directiveId,
    round: 1,
    title: '검수 대상 작업',
    goal: '검수 회귀',
    type: 'docs',
    priority: 'normal',
    assigneeId: env.devId,
    reviewerId,
    prerequisiteIds: [],
    acceptanceCriteria: ['문서가 있다'],
    plannedAreas: [],
    outputMode: o.outputMode ?? 'artifact',
    state: 'in_review',
    hold: { reasons: [], returnState: null },
    workspace: null,
    review: { round: 1, rejectsInRound: 0, rejectsTotal: 0, target, passed: null, autoCheck: { status: 'not_applicable', detail: '', at: now } },
    contributors: [env.devId],
    merge: null,
    artifact: null,
    revertOfTaskId: null,
    revertedByTaskId: null,
    skillsUsed: [],
    pendingSubmit: null,
    conflict: null,
    crashRetries: 0,
    noProgressResumes: 0,
    createdBy: env.producerId,
    createdAt: now,
    updatedAt: now,
    queuedAt: now,
    activatedAt: now,
    completedAt: null,
    cancelledAt: null,
  };
  ctx.store.tasks.insert(t);
  mkdirSync(reviewCopyPath(ctx.paths, env.projectId, id, 1, o.outputMode === 'repo' ? 'a'.repeat(8) : 'v1'), { recursive: true });
  return t;
}

/** 검수 업무를 등록하고 그 검수 턴을 띄워 실행 중으로 둔다 */
export async function startReview(env: OrchEnv, reviewerId: string, o: Parameters<typeof seedInReviewTask>[2] = {}): Promise<{ task: Task; proc: FakeProc; turnId: string }> {
  const task = seedInReviewTask(env, reviewerId, o);
  const key = `review:${task.id}`;
  env.hold.add(key);
  env.core.tasks.dispatchReview(env.ctx.store.tasks.require(task.id));
  env.tick();
  await waitFor(() => !!env.liveProc(key, reviewerId), '검수 턴 시작');
  const proc = env.liveProc(key, reviewerId)!;
  return { task, proc, turnId: proc.turnId };
}

export function queuedOf(env: OrchEnv, pred: (q: { kind: string; sessionKey: string; taskId: string | null; memberId: string }) => boolean) {
  return env.ctx.store.queue.list({ state: 'queued' }).filter(pred);
}

export function notices(env: OrchEnv, title: string) {
  return env.ctx.store.notifications.list().filter((n) => n.title === title);
}
