/**
 * 완료 기준 'stops' 묶음(AC-13·14·15·16·29·44·46) 도우미.
 *
 * 1) bootRestartable — tests/regression/orchHarness.ts의 bootOrch와 같은 구성(실제 오케스트레이터·저장소·git·스케줄러·턴 실행기·
 *    앱 도구 처리기·복구 + 가짜 CLI)이지만 같은 데이터 폴더로 다시 띄울 수 있다.
 *    - crash(): PC 전원이 꺼진 것처럼 끝낸다 — 턴을 정리하지 않고(턴·대기 항목이 'running'으로 남음) 저장소만 닫는다.
 *    - reboot(): 같은 데이터 폴더로 새 오케스트레이터를 띄운다 (시작 때 재시작 복구 → 스케줄러 첫 tick이 실제로 돈다).
 *    - stopGracefully(): 앱 종료(orch.stop) 후 reboot() — 앱 재시작.
 * 2) seedDirective·seedInReviewTask·holdOf — 진행 지시, 검수 중 작업(담당·검수자 지정)을 직접 넣고 보류 상태를 비교한다.
 * 3) 실제 프로세스 도구 — createProcRig·wrapTurnsWithRig: 모의 에이전트 앞에 개발 서버(직접 자식·손자·고아)를 띄우는 CLI 대역과
 *    개발 서버를 띄우는 자동 검사 명령. pidAlive·portOpen·portHeldBy(그 포트를 기록한 개발 서버가 아직 듣는지)·markedProcesses(명령줄 표식)로 남은 프로세스를
 *    확인하고 killMarked로 정리한다.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Directive, ReviewTarget, Settings, Task, TaskState } from '@shared/domain';
import type { ParsedCliEvent } from '@shared/events';
import type { DeepPartial, WookMethod, WookParams, WookResult } from '@shared/ipc';
import { createRedactor } from '@core/redact';
import { systemClock } from '@core/time';
import { openStore } from '../../src/main/db/store';
import { createGitService } from '../../src/main/git/gitService';
import type { AgentAdapter, PreparedRun, TurnLaunch } from '../../src/main/agents/types';
import type { ProcessRunner, RunSpec } from '../../src/main/process/types';
import type { AppToolServer, TokenIdentity, ToolCallResult } from '../../src/main/mcp/types';
import type { OrchestratorDeps } from '../../src/main/orchestrator/context';
import { createOrchestrator, type Orchestrator } from '../../src/main/orchestrator/orchestrator';
import { dataPaths, reviewCopyPath } from '../../src/main/orchestrator/paths';
import { FakeProc, type LaunchRecord } from '../regression/orchHarness';
import { internalInvoker, mainOp } from '../regression/mainOps';
import type { Harness } from '../e2e/harness';

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitUntil(pred: () => boolean, label = '조건', ms = 15_000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`시간 초과: ${label}`);
    await sleep(10);
  }
}

// ───────────────────────── 1) 다시 띄울 수 있는 가짜 CLI 오케스트레이터 ─────────────────────────

export interface RestartOptions {
  settings?: DeepPartial<Settings>;
  checkCommands?: string[];
  /** 프로젝트·메인 에이전트 모의 실행 (기본 true) */
  mock?: boolean;
  /** 모든 가짜 CLI 프로세스를 종료될 때까지 살려 둔다 (재시작 직후 스케줄러 첫 tick이 띄운 턴을 관찰) */
  holdAll?: boolean;
}

interface Reuse {
  dataDir: string;
  projRoot: string;
  projectId: string;
  producerId: string;
  devId: string;
  qaId: string;
}

export interface RestartableEnv {
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
  specs: RunSpec[];
  launches: LaunchRecord[];
  hold: Set<string>;
  holdAll: boolean;
  script: Map<string, (p: FakeProc) => void>;
  errors: string[];
  invoke<M extends WookMethod>(method: M, ...args: WookParams<M>): Promise<WookResult<M>>;
  /** 운영자 내부 API — 시험 준비 (SERVER_DESIGN 10.11 '준비 → 내부 API') */
  internal<M extends WookMethod>(method: M, ...args: WookParams<M>): Promise<WookResult<M>>;
  /** 메인 에이전트 운영 도구 (10.11 '대표 조작 → 메인 도구'). 거부되면 code를 가진 오류로 던진다 */
  main(tool: string, args?: Record<string, unknown>): Promise<Record<string, unknown>>;
  tick(): void;
  idle(label?: string): Promise<void>;
  drain(rounds?: number): Promise<void>;
  identity(turnId: string): TokenIdentity;
  tool(turnId: string, name: string, args?: Record<string, unknown>): Promise<ToolCallResult>;
  liveProc(key: string, memberId?: string): FakeProc | undefined;
  /** 이 세션 키의 턴이 몇 번 시작됐는지 (이 인스턴스 기준) */
  launchesOf(key: string): LaunchRecord[];
  /** PC 전원이 꺼진 것처럼 끝낸다: 턴 정리·종료 판정 없이 저장소만 닫는다 */
  crash(): void;
  /** 같은 데이터 폴더로 새 인스턴스 (crash 또는 stop 뒤에) */
  reboot(o?: RestartOptions): Promise<RestartableEnv>;
  /** 앱 종료(턴 정지·마무리) 후 같은 데이터 폴더로 다시 시작 */
  stopGracefully(o?: RestartOptions): Promise<RestartableEnv>;
  /** 끝: 턴 정리 후 종료하고 폴더를 지운다 (crash한 인스턴스는 폴더만) */
  close(): Promise<void>;
}

export async function bootRestartable(o: RestartOptions = {}, reuse?: Reuse): Promise<RestartableEnv> {
  const mock = o.mock ?? true;
  const dataDir = reuse?.dataDir ?? mkdtempSync(join(tmpdir(), 'wook-test-acc-data-'));
  const projRoot = reuse?.projRoot ?? mkdtempSync(join(tmpdir(), 'wook-test-acc-proj-'));
  const projectDir = join(projRoot, 'proj');
  const procs: FakeProc[] = [];
  const launches: LaunchRecord[] = [];
  const identities = new Map<string, TokenIdentity>();
  const byToken = new Map<string, TokenIdentity>();
  const errors: string[] = [];
  const env = {} as RestartableEnv;
  env.hold = new Set();
  env.holdAll = !!o.holdAll;
  env.script = new Map();
  env.specs = [];
  let crashed = false;
  let stopped = false;

  const runner: ProcessRunner = {
    mode: 'pgroup',
    detail: '완료 기준 테스트: 가짜 러너',
    start(spec: RunSpec) {
      if (spec.label.startsWith('검사 ')) {
        const c = new FakeProc('check', '', spec.label);
        setTimeout(() => c.exit(0), 5);
        return c;
      }
      env.specs.push(spec);
      const p = new FakeProc(String(spec.args[0]), String(spec.args[1]), String(spec.args[2]));
      procs.push(p);
      const scripted = env.script.get(p.workKey);
      if (scripted) setTimeout(() => scripted(p), 5);
      else if (!env.holdAll && !env.hold.has(p.workKey)) setTimeout(() => p.finishOk(), 5);
      return p;
    },
    // 가짜 프로세스: 재시작 뒤 이전 PID는 모두 끝난 것으로 본다 (PC 재시작)
    isAlive: async () => false,
    processCreatedAt: async () => new Map(),
    killTree: async () => ({ ok: true, remaining: 0, detail: '', durationMs: 0 }),
  };

  const adapter = (kind: 'claude' | 'codex' | 'mock'): AgentAdapter => ({
    kind,
    detect: async () => ({ installed: true, path: 'fake', version: '9.9.9', loggedIn: true, problem: null, detail: '가짜' }),
    async prepare(launch: TurnLaunch): Promise<PreparedRun> {
      const who = byToken.get(launch.mcp.token);
      if (!who) throw new Error('완료 기준 테스트: 토큰 없는 실행');
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
    clock: systemClock,
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
    timing: { watchdogMs: 100, snapshotThrottleMs: 20 },
  } as unknown as OrchestratorDeps;

  // 재시작이면 여기서 재시작 복구가 돌고, 스케줄러가 첫 tick을 실제로 한 번 돈다 (앱 시작과 같다)
  const orch = await createOrchestrator(deps);
  const core = orch.core;
  core.scheduler.stop(); // 그 뒤의 자동 실행은 끔 — 테스트가 tick()으로 돌린다
  const invoke = (<M extends WookMethod>(method: M, ...args: WookParams<M>) => orch.backend.invoke(method, args)) as RestartableEnv['invoke'];
  const internal = internalInvoker(core) as RestartableEnv['internal'];
  await invoke('auth.devLogin');

  let ids: Omit<Reuse, 'dataDir' | 'projRoot'>;
  if (reuse) {
    ids = { projectId: reuse.projectId, producerId: reuse.producerId, devId: reuse.devId, qaId: reuse.qaId };
  } else {
    await internal('settings.update', {
      developer: { mainAgentMock: mock, mockSpeed: 25 },
      ...(o.settings ?? {}),
    } as DeepPartial<Settings>);
    const p = await internal('projects.create', { mode: 'new', path: projectDir, name: '정지 완료 기준', checkCommands: o.checkCommands ?? [] });
    if (mock) await internal('projects.setMock', p.id, { enabled: true, speed: 25, defaultScenario: 'normal' });
    const dev = await internal('members.add', { projectId: p.id, roleId: 'developer' });
    const qa = await internal('members.add', { projectId: p.id, roleId: 'qa' });
    ids = { projectId: p.id, producerId: p.producerId, devId: dev.id, qaId: qa.id };
    await waitUntil(() => core.ctx.ai('claude').checkedAt !== null && core.ctx.ai('codex').checkedAt !== null, 'CLI 확인');
  }
  const reuseOf = (): Reuse => ({ dataDir, projRoot, ...ids });

  Object.assign(env, {
    orch,
    core,
    ctx: core.ctx,
    dataDir,
    projectDir,
    ...ids,
    procs,
    launches,
    errors,
    invoke,
    internal,
    main: (tool: string, args: Record<string, unknown> = {}) => mainOp(core, tool, args),
    tick: () => core.scheduler.tick(),
    async idle(label = '턴 종료') {
      await sleep(5);
      await waitUntil(() => core.turns.count() === 0, label);
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
    launchesOf: (key: string) => launches.filter((l) => l.workKey === key),
    crash() {
      // 전원 차단: 턴 마무리·종료 판정·대기열 정리를 하지 않는다. 가짜 CLI는 영원히 끝나지 않은 채 버린다
      crashed = true;
      core.stopping = true;
      core.scheduler.stop();
      core.turns.stopTimers();
      core.ctx.bus.dispose();
      core.ctx.store.close();
    },
    async reboot(next: RestartOptions = o) {
      if (!crashed && !stopped) throw new Error('reboot 전에 crash() 또는 stopGracefully()가 필요합니다');
      return bootRestartable({ ...o, ...next }, reuseOf());
    },
    async stopGracefully(next: RestartOptions = o) {
      env.hold.clear();
      env.holdAll = false;
      await orch.stop();
      stopped = true;
      return bootRestartable({ ...o, ...next }, reuseOf());
    },
    async close() {
      if (!crashed && !stopped) {
        env.hold.clear();
        env.holdAll = false;
        env.script.clear();
        for (const x of procs) x.exit(null, { terminated: true });
        await waitUntil(() => core.turns.count() === 0, '종료 전 턴 정리').catch(() => undefined);
        await sleep(150);
        await orch.stop().catch(() => undefined);
      }
      for (const d of [dataDir, projRoot]) {
        try {
          rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        } catch {
          // 윈도우에서 잠긴 파일이 남으면 다음 정리에 맡긴다
        }
      }
    },
  } satisfies Partial<RestartableEnv>);
  return env;
}

// ───────────────────────── 2) 직접 넣는 지시·작업 ─────────────────────────

/** 진행 상태 지시 */
export function seedDirective(env: { ctx: RestartableEnv['ctx']; projectId: string }, title = '정지 완료 기준 지시'): Directive {
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

/**
 * 검수 상태(산출물형, 대상 고정)인 작업을 직접 넣는다 — 담당·검수자를 고른다. 검수 사본 폴더도 만든다.
 * (orchHarness.seedInReviewTask와 같지만 담당이 개발자로 고정돼 있지 않다)
 */
export function seedInReviewTask(env: { ctx: RestartableEnv['ctx']; projectId: string; producerId: string }, o: { directiveId: string; assigneeId: string; reviewerId: string; title?: string }): Task {
  const ctx = env.ctx;
  const now = ctx.now();
  const id = ctx.store.nextId('task');
  const target: ReviewTarget = { kind: 'artifact', files: [{ path: 'a.md', sha256: 'abc', size: 1 }], version: 1, pinnedAt: now };
  const t: Task = {
    id,
    projectId: env.projectId,
    directiveId: o.directiveId,
    round: 1,
    title: o.title ?? '검수 대상 작업',
    goal: '검수 중 정지',
    type: 'docs',
    priority: 'normal',
    assigneeId: o.assigneeId,
    reviewerId: o.reviewerId,
    prerequisiteIds: [],
    acceptanceCriteria: ['문서가 있다'],
    plannedAreas: [],
    outputMode: 'artifact',
    state: 'in_review',
    hold: { reasons: [], returnState: null },
    workspace: null,
    review: { round: 1, rejectsInRound: 0, rejectsTotal: 0, target, passed: null, autoCheck: { status: 'not_applicable', detail: '', at: now } },
    contributors: [o.assigneeId],
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
  mkdirSync(reviewCopyPath(ctx.paths, env.projectId, id, 1, 'v1'), { recursive: true });
  return t;
}

/** 작업 상태·보류 요약 (비교용) */
export function holdOf(t: Task): { state: TaskState; reasons: string[]; returnState: TaskState | null } {
  return { state: t.state, reasons: t.hold.reasons.map((r) => `${r.kind}/${r.scope ?? '-'}`).sort(), returnState: t.hold.returnState };
}

// ───────────────────────── 3) 실제 프로세스 도구 ─────────────────────────

/** PID가 살아 있는지 (Windows·POSIX 공통: 신호 0) */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * 기록해 둔 PID 중 그 프로세스가 아직 살아 있는 것 (since: 그 프로세스들이 모두 생긴 뒤의 시각 — 보통 정지 직전).
 * Windows는 끝난 프로세스의 PID 번호를 곧 다른 프로세스에 준다 — 전체 시험이 돌며 프로세스를 많이 띄우면 1초 안에도 (실측: 긴급 정지 0.9초 뒤 브라우저
 * 렌더러가 끝난 CLI 대역의 번호를 받음). 번호만 보면 남의 프로세스를 남은 프로세스로 센다. 그래서 살아 있는 번호는 지금 주인의 생성 시각을 보고
 * since 뒤에 생긴 것은 다른 프로세스로 뺀다. 생성 시각을 읽지 못한 번호는 아직 살아 있으면 남은 것으로 센다 (보수적으로)
 */
export function stillRunning(pids: number[], since: number): number[] {
  const alive = [...new Set(pids)].filter((p) => Number.isSafeInteger(p) && p > 0 && pidAlive(p));
  if (alive.length === 0) return [];
  const created = new Map<number, number>();
  try {
    if (process.platform === 'win32') {
      const filter = alive.map((p) => `ProcessId=${p}`).join(' OR ');
      const script = `Get-CimInstance Win32_Process -Filter '${filter}' | ForEach-Object { '{0} {1}' -f $_.ProcessId, $_.CreationDate.ToFileTimeUtc() }`;
      const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true });
      for (const line of out.split(/\r?\n/)) {
        const m = /^(\d+)\s+(\d+)$/.exec(line.trim());
        if (m) created.set(Number(m[1]), Number(BigInt(m[2]!) / 10_000n) - 11_644_473_600_000);
      }
    } else {
      // ps lstart는 초 단위 — 같은 초에 생긴 것은 남은 것으로 센다. 그사이 끝난 PID가 있으면 종료 코드 1 (출력은 그대로 쓴다)
      const out = spawnSync('ps', ['-o', 'pid=,lstart=', '-p', alive.join(',')], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', LANG: 'C' } }).stdout ?? '';
      for (const line of out.split('\n')) {
        const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
        const at = m ? Date.parse(m[2]!) : NaN;
        if (m && Number.isFinite(at)) created.set(Number(m[1]), at);
      }
    }
  } catch {
    // 조회 실패 — 살아 있는 번호를 모두 남은 것으로 센다
  }
  return alive.filter((p) => {
    const at = created.get(p);
    return at === undefined ? pidAlive(p) : at <= since;
  });
}

/** 127.0.0.1:port에 연결되면 true */
export function portOpen(port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ host: '127.0.0.1', port });
    const done = (v: boolean) => {
      s.destroy();
      resolve(v);
    };
    s.setTimeout(timeoutMs, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

/** 127.0.0.1의 그 포트를 듣는 프로세스 (Windows: Get-NetTCPConnection, POSIX: lsof). 알아내지 못하면 null */
export function listeningPids(port: number): number[] | null {
  const pids = (out: string): number[] => [...new Set(out.split(/\r?\n/).map((l) => Number(l.trim())).filter((n) => Number.isSafeInteger(n) && n > 0))];
  try {
    if (process.platform === 'win32') {
      const script = `Get-NetTCPConnection -State Listen -LocalPort ${Number(port)} -ErrorAction SilentlyContinue | ForEach-Object { $_.OwningProcess }`;
      return pids(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true }));
    }
    // lsof는 찾은 것이 없으면 1로 끝난다
    const r = spawnSync('lsof', ['-nP', `-iTCP:${Number(port)}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' });
    if (r.error || (r.status !== 0 && r.status !== 1)) return null;
    return pids(r.stdout ?? '');
  } catch {
    return null;
  }
}

/**
 * 그 포트를 아직 기록한 개발 서버(pid)가 듣고 있는지 (리드 결정 S3-17, SERVER_DESIGN 10.11 AC-15 행). 끝난 개발 서버가 비운 포트 번호를 동시에 도는 다른
 * 시험 프로세스가 곧바로 받으면 portOpen만으로는 열린 것으로 보여 실패했다(3단계 전 KNOWN_ISSUES 항목). 포트가 닫혔으면 false. 열려 있으면 그 포트를 듣는 프로세스를 OS에서
 * 찾아, 기록한 pid가 듣고 있고 그 pid가 since 전부터 살아 있는 같은 프로세스면(stillRunning — 생성 시각) true, 다른 프로세스만 듣고 있으면 false.
 * 듣는 프로세스를 알아내지 못하면(조회 실패, 열려 있는데 듣는 쪽이 보이지 않음) true — 예전 단언과 같다. 멈춘 프로세스에 대해 단언이 약해지지 않는다.
 * lookup은 듣는 프로세스 조회(기본 listeningPids) — 조회 실패 갈래를 회귀 시험이 흉내 낼 때만 바꾼다(리드 결정 S3-30, 10.11 AC-15 행). AC-15는 세 인자로 부른다
 */
export async function portHeldBy(port: number, pid: number, since: number, lookup: (port: number) => number[] | null = listeningPids): Promise<boolean> {
  if (!(await portOpen(port))) return false;
  const owners = lookup(port);
  if (owners === null || owners.length === 0) return owners === null ? true : portOpen(port);
  if (!owners.includes(pid)) return false;
  return stillRunning([pid], since).length > 0;
}

/**
 * 명령줄에 표식이 들어 있는 살아 있는 프로세스 (Windows: CIM 한 번, POSIX: ps). 표식은 환경 변수로 넘겨
 * 조회하는 PowerShell 자신의 명령줄에 표식이 들어가지 않게 한다
 */
export function markedProcesses(marker: string): { pid: number; cmd: string }[] {
  if (process.platform === 'win32') {
    const script =
      "$m=$env:WOOK_ACC_MARK; $r=@(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($m) -and $_.ProcessId -ne $PID } | ForEach-Object { [pscustomobject]@{ pid=$_.ProcessId; cmd=$_.CommandLine } }); ConvertTo-Json -InputObject $r -Compress";
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      env: { ...process.env, WOOK_ACC_MARK: marker },
      windowsHide: true,
    }).trim();
    if (!out) return [];
    const parsed = JSON.parse(out) as { pid: number; cmd: string }[] | { pid: number; cmd: string };
    return Array.isArray(parsed) ? parsed : [parsed];
  }
  const out = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.includes(marker))
    .map((l) => ({ pid: Number(l.split(/\s+/, 1)[0]), cmd: l }));
}

/**
 * 끝까지 남은 표식 프로세스 정리 (테스트가 실패해도 사용자 PC에 남기지 않게). 지금 명령줄에 이 표식이 든 프로세스만 하나씩 끝낸다 — 기록해 둔 PID로는
 * 죽이지 않고(그 프로세스가 끝났으면 번호를 다른 프로세스가 다시 쓴다), 트리째(taskkill /T)도 끝내지 않는다(부모 PID 칸만 보고 따라가면 그 번호를 예전에 쓰던
 * 남의 프로세스의 자식까지 끝낼 수 있다). 묶음의 프로세스는 모두 명령줄에 표식이 있고, 표식 없는 자식(모의 에이전트)은 부모와 함께 끝난다 (리드 결정 S7-20 TI-8).
 * 조회가 실패하면 아무것도 죽이지 않는다 — 묶음의 프로세스는 그 폴더가 지워지면 스스로 끝난다 (createProcRig)
 */
export function killMarked(marker: string): void {
  let pids: number[] = [];
  try {
    pids = markedProcesses(marker).map((p) => p.pid);
  } catch {
    return;
  }
  for (const pid of pids) {
    try {
      if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore', windowsHide: true });
      else process.kill(pid, 'SIGKILL');
    } catch {
      // 이미 끝났다
    }
  }
}


export interface ProcRecord {
  file: string;
  pid: number;
  port?: number;
}

/**
 * 실제 하위 프로세스 묶음 (경로·명령줄에 표식이 들어 있다). 개발 서버 대역은 루프백 포트를 열고 PID·포트를 기록 폴더에 적는다.
 * - cliWrap: 작업 턴의 CLI 대역 — 직접 자식 개발 서버, 손자(CLI → 중간 → 개발 서버), 고아(중간이 먼저 끝남) 개발 서버를 띄운 뒤
 *   실제 모의 에이전트를 자식으로 실행 (턴마다 cli·agent·direct·grandchild·middle·orphan 6개 기록)
 * - checkCommand: 자동 검사 명령 — 개발 서버(직접 자식)·고아 개발 서버를 띄우고 끝나지 않는다 (check·direct·orphan 3개 기록)
 */
export interface ProcRig {
  dir: string;
  marker: string;
  records(prefix?: string): ProcRecord[];
  checkCommand(): string;
  cleanup(): void;
}

// 묶음의 프로세스는 그 폴더가 지워지면(정리) 스스로 끝난다 — 표식 조회가 실패해도 남지 않게. 정리는 기록한 PID로 죽이지 않는다 (S7-20 TI-8)
const QUIT_WATCH = `const quitWatch = (dir) => setInterval(() => { if (!require('fs').existsSync(dir)) process.exit(0); }, 200);`;

const DEV_SERVER = `// 개발 서버 대역: 루프백 포트를 열고 PID·포트를 적은 뒤 끝나지 않는다 (그 폴더가 지워지면 끝남)
const http = require('http');
const fs = require('fs');
${QUIT_WATCH}
const s = http.createServer((q, r) => r.end('ok'));
s.listen(0, '127.0.0.1', () => fs.writeFileSync(process.argv[2], JSON.stringify({ pid: process.pid, port: s.address().port })));
quitWatch(require('path').dirname(process.argv[2]));
`;

const MIDDLE = `// 중간 프로세스: 개발 서버를 자식으로 띄우고 계속 산다 (CLI → 중간 → 개발 서버, 그 폴더가 지워지면 끝남)
const { spawn } = require('child_process');
const fs = require('fs');
${QUIT_WATCH}
const [, , server, out, middleOut, marker] = process.argv;
spawn(process.execPath, [server, out, marker], { stdio: 'ignore', windowsHide: true });
fs.writeFileSync(middleOut, JSON.stringify({ pid: process.pid }));
quitWatch(require('path').dirname(middleOut));
`;

const LAUNCHER = `// 고아 만들기: 분리(detached)된 개발 서버를 띄우고 곧바로 끝난다 (부모가 먼저 끝난 후손)
const { spawn } = require('child_process');
const [, , server, out, marker] = process.argv;
const c = spawn(process.execPath, [server, out, marker], { detached: true, stdio: 'ignore', windowsHide: true });
c.unref();
setTimeout(() => process.exit(0), 300);
`;

const CHECK = `// 자동 검사 대역: 테스트 중 개발 서버를 띄우는 검사 (직접 자식 + 고아), 끝나지 않는다
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const [, , dir, marker] = process.argv;
${QUIT_WATCH}
const f = (n) => path.join(dir, 'check-' + process.pid + '-' + n + '.json');
fs.writeFileSync(f('check'), JSON.stringify({ pid: process.pid }));
spawn(process.execPath, [path.join(dir, 'devserver.cjs'), f('direct'), marker], { stdio: 'ignore', windowsHide: true });
spawn(process.execPath, [path.join(dir, 'launcher.cjs'), path.join(dir, 'devserver.cjs'), f('orphan'), marker], { stdio: 'ignore', windowsHide: true });
quitWatch(dir);
`;

const CLI_WRAPPER = `// CLI 대역: 실제 CLI가 명령 도구로 띄우는 것처럼 하위 프로세스(개발 서버 등)를 띄운 뒤 실제 모의 에이전트를 자식으로 실행한다
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [, , dir, marker, mockScript, ...rest] = process.argv;
const tag = ('turn-' + (process.env.WOOK_MOCK_WORKKEY || 'x') + '-t' + (process.env.WOOK_MOCK_TURN || '0')).replace(/[^A-Za-z0-9-]/g, '_');
const node = process.execPath;
const f = (n) => join(dir, tag + '-' + n + '.json');
writeFileSync(f('cli'), JSON.stringify({ pid: process.pid }));
// 1) CLI의 직접 자식 개발 서버
spawn(node, [join(dir, 'devserver.cjs'), f('direct'), marker], { stdio: 'ignore', windowsHide: true });
// 2) 손자: CLI → 중간 프로세스 → 개발 서버
spawn(node, [join(dir, 'middle.cjs'), join(dir, 'devserver.cjs'), f('grandchild'), f('middle'), marker], { stdio: 'ignore', windowsHide: true });
// 3) 고아: 중간 프로세스가 분리된 개발 서버를 띄우고 먼저 끝난다
spawn(node, [join(dir, 'launcher.cjs'), join(dir, 'devserver.cjs'), f('orphan'), marker], { stdio: 'ignore', windowsHide: true });
// 실제 모의 에이전트 (표준 입력·출력·오류를 그대로 물려준다)
const agent = spawn(node, [mockScript, ...rest], { stdio: 'inherit', windowsHide: true });
writeFileSync(f('agent'), JSON.stringify({ pid: agent.pid }));
agent.on('exit', (code) => process.exit(code ?? 1));
`;

export function createProcRig(): ProcRig {
  const marker = `wookacc${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const dir = mkdtempSync(join(tmpdir(), `wook-test-${marker}-`));
  writeFileSync(join(dir, 'devserver.cjs'), DEV_SERVER);
  writeFileSync(join(dir, 'middle.cjs'), MIDDLE);
  writeFileSync(join(dir, 'launcher.cjs'), LAUNCHER);
  writeFileSync(join(dir, 'check.cjs'), CHECK);
  writeFileSync(join(dir, 'cli-wrapper.mjs'), CLI_WRAPPER);
  const rig: ProcRig = {
    dir,
    marker,
    records(prefix = '') {
      const out: ProcRecord[] = [];
      for (const f of existsSync(dir) ? readdirSync(dir) : []) {
        if (!f.endsWith('.json') || !f.startsWith(prefix)) continue;
        try {
          const v = JSON.parse(readFileSync(join(dir, f), 'utf8')) as { pid: number; port?: number };
          out.push({ file: f, pid: v.pid, port: v.port });
        } catch {
          // 쓰는 중인 파일
        }
      }
      return out;
    },
    checkCommand: () => `"${process.execPath}" "${join(dir, 'check.cjs')}" "${dir}" ${marker}`,
    cleanup() {
      // 남은 묶음 프로세스는 표식으로 찾아 끝내고, 그래도 남은 것은 아래에서 폴더를 지우면 스스로 끝난다 — 기록한 PID로는 죽이지 않는다 (S7-20 TI-8)
      killMarked(marker);
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      } catch {
        // 다음 정리에 맡긴다
      }
    },
  };
  return rig;
}

/**
 * e2e 하네스(실제 러너·실제 모의 에이전트)에서 고른 세션(기본: 작업 세션)의 턴을 CLI 대역으로 감싼다.
 * 이 호출 뒤에 시작하는 턴부터 적용된다
 */
export function wrapTurnsWithRig(h: Harness, rig: ProcRig, pick: (workKey: string) => boolean = (k) => k.startsWith('task:')): void {
  const adapter = h.core.ctx.deps.adapters.mock;
  const orig = adapter.prepare.bind(adapter);
  adapter.prepare = async (launch) => {
    const r = await orig(launch);
    if (!launch.mock || !pick(launch.mock.workKey)) return r;
    return { ...r, spec: { ...r.spec, args: [join(rig.dir, 'cli-wrapper.mjs'), rig.dir, rig.marker, ...r.spec.args] } };
  };
}
