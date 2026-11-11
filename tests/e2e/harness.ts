/**
 * 통합 테스트 하네스: 실제 저장소·git·프로세스 러너·앱 도구 서버 + 모의 에이전트로 오케스트레이터를 띄운다.
 * 각 테스트는 임시 앱 데이터 폴더와 임시 프로젝트 폴더를 쓰고 close()로 정리한다.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { MockScenario, RoleId, Settings, Task } from '@shared/domain';
import type { DeepPartial, WookMethod, WookParams, WookResult } from '@shared/ipc';
import type { AppSnapshot } from '@shared/views';
import { buildOrchestratorDeps, type BuildDepsOptions } from '../../src/main/backend/buildDeps';
import { createOrchestrator, type Orchestrator } from '../../src/main/orchestrator/orchestrator';
import type { Core } from '../../src/main/orchestrator/core';
import type { JobHelper } from '../../src/main/process/jobHelper';
import type { InstanceIdentity } from '../../src/main/backend/instanceLock';
import { internalInvoker, mainOp, seedStoredSettings } from '../regression/mainOps';
import { normalizeSettings } from '../../src/main/orchestrator/defaults';

export interface HarnessOptions {
  /** 팀 구성 (프로듀서는 자동). 기본: 개발자 1, QA 1 */
  team?: RoleId[];
  /** 역할별 모의 시나리오 */
  scenarios?: Partial<Record<RoleId | 'producer' | 'main', MockScenario>>;
  /** 모의 속도 배수 (기본 25) */
  speed?: number;
  maxConcurrent?: number;
  checkCommands?: string[];
  settings?: DeepPartial<Settings>;
  /** 프로젝트를 만들지 않음 */
  noProject?: boolean;
  /** 프로세스 러너 방식 고정 */
  runnerMode?: 'jobobject' | 'taskkill' | 'pgroup';
  /** taskkill 방식의 작업 개체 도우미를 바꾼다 (null = 도우미를 쓸 수 없는 환경) */
  jobHelper?: JobHelper | null;
  /** 기존 데이터 폴더 재사용 (재시작 테스트) */
  dataDir?: string;
  projectDir?: string;
  /**
   * 실행 잠금을 잡은 껍데기처럼 이 프로세스(잠금 내용)를 데이터의 주인으로 적는다 (S2-15 — 데스크톱·서버가 BackendDeps.instance로 넘기는 것).
   * 데이터 폴더는 하네스가 채운다
   */
  instance?: Omit<InstanceIdentity, 'dataDir'>;
  /**
   * 로그인 방식 (리드 결정 S3-2, BackendDeps.mode). 'server'면 kv 대표 세션을 쓰지 않으므로 개발 모드 로그인을 하지 않는다 — 대표 요청은 기기 세션을 가진
   * 원격 호출자로 부른다(서버 시험). 없으면 'desktop'
   */
  mode?: 'desktop' | 'server';
  /** 기기 코드 로그인의 구글 주소 (서버 모드 시험, S3-5) — 가짜 구글 서버로 */
  googleDevice?: BuildDepsOptions['googleDevice'];
  /** 서버의 메인 자리 운영자 설정 (server.json의 seat, 리드 결정 S4-12) — 시작 때 자리 정책과 새 DB의 처음 보유자로 쓴다 */
  seat?: BuildDepsOptions['seat'];
  /** 화면 도우미 (시험은 가짜 — tests/fixtures/desktop/fakeDesktop.ts). 서버 모드에서 주지 않으면 시험 중에는 실제 도우미가 닫혀 있어 화면 도구가 없다 */
  desktop?: BuildDepsOptions['desktop'];
  /** 시험 주기 (하네스 기본 watchdogMs·snapshotThrottleMs 위에 더한다 — 외부 에이전트 임대 agentLeaseMs 등, 리드 결정 S7-4) */
  timing?: BuildDepsOptions['timing'];
  /** 앱 시계 (긴 시간이 지나는 것을 보는 시험이 앞당겨 쓴다) */
  clock?: BuildDepsOptions['clock'];
}

export interface Harness {
  orch: Orchestrator;
  core: Core;
  dataDir: string;
  projectDir: string;
  projectId: string;
  members: Record<string, string>;
  /** 대표가 부르는 길 (Backend.invoke — 대표 메서드만, SERVER_DESIGN 2.5) */
  invoke<M extends WookMethod>(method: M, ...args: WookParams<M>): Promise<WookResult<M>>;
  /** 운영자 내부 API — 시험 준비 (createInternalApi) */
  internal<M extends WookMethod>(method: M, ...args: WookParams<M>): Promise<WookResult<M>>;
  /** 메인 에이전트 운영 도구 (SERVER_DESIGN 2.6). 거부되면 code를 가진 오류로 던진다 */
  main(tool: string, args?: Record<string, unknown>): Promise<Record<string, unknown>>;
  snapshot(): AppSnapshot;
  waitFor(pred: () => boolean | Promise<boolean>, opts?: { timeoutMs?: number; label?: string; intervalMs?: number }): Promise<void>;
  task(id: string): Task;
  tasks(): Task[];
  /** 같은 데이터 폴더로 다시 시작 (재시작 테스트) — 이전 인스턴스는 종료 */
  restart(): Promise<Harness>;
  close(opts?: { keepDirs?: boolean }): Promise<void>;
}

export async function createHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const dataDir = opts.dataDir ?? mkdtempSync(join(tmpdir(), 'wook-test-e2e-data-'));
  const projectDir = opts.projectDir ?? join(mkdtempSync(join(tmpdir(), 'wook-test-e2e-proj-')), '프로젝트 폴더');
  const deps = await buildOrchestratorDeps({
    dataDir,
    appRoot: process.cwd(),
    isPackaged: false,
    nodeExecPath: process.execPath,
    nodeExecEnv: {},
    shell: null,
    memorySecrets: true,
    runnerMode: opts.runnerMode,
    ...(opts.jobHelper !== undefined ? { jobHelper: opts.jobHelper } : {}),
    ...(opts.instance ? { instance: { ...opts.instance, dataDir } } : {}),
    ...(opts.mode ? { mode: opts.mode } : {}),
    ...(opts.googleDevice ? { googleDevice: opts.googleDevice } : {}),
    ...(opts.seat ? { seat: opts.seat } : {}),
    ...(opts.desktop !== undefined ? { desktop: opts.desktop } : {}),
    ...(opts.clock ? { clock: opts.clock } : {}),
    timing: { watchdogMs: 200, snapshotThrottleMs: 20, ...opts.timing },
    logger: (level, msg, extra) => {
      if (level === 'error' && process.env.WOOK_TEST_LOG) console.error(`[${level}] ${msg}`, extra ?? '');
    },
  });
  // 모의 메인을 시작 전에 켠다 (리드 결정 S6-19): 시작하자마자 뜰 수 있는 메인 턴(화면 확인 업무 등)이 실제 CLI로 뜨지 않게 — 아래 settings.update는 그대로 다시 켠다
  const seeded = normalizeSettings(deps.store.kv.get<Settings>('settings'));
  deps.store.kv.set('settings', { ...seeded, developer: { ...seeded.developer, mainAgentMock: true } });
  const orch = await createOrchestrator(deps);
  const core = orch.core;
  const invoke = <M extends WookMethod>(method: M, ...args: WookParams<M>): Promise<WookResult<M>> =>
    orch.backend.invoke(method, args);
  const internal = internalInvoker(core) as Harness['internal'];
  if (opts.mode !== 'server') await invoke('auth.devLogin');
  const speed = opts.speed ?? 25;
  // 시험이 주는 실행 설정(턴 시간 상한 0.1분 등 — 제품 범위 밖일 수 있음)은 검사 없이 저장된 설정에 바로 넣는다 (리드 결정 15, seedStoredSettings)
  const { execution: seedExecution, ...settings } = opts.settings ?? {};
  await internal('settings.update', {
    developer: { mainAgentMock: true, mockSpeed: speed },
    execution: { maxConcurrent: opts.maxConcurrent ?? 5 },
    ...settings,
  } as DeepPartial<Settings>);
  if (seedExecution) seedStoredSettings(core, { execution: seedExecution });

  let projectId = '';
  const members: Record<string, string> = {};
  if (!opts.noProject && !opts.dataDir) {
    const p = await internal('projects.create', { mode: 'new', path: projectDir, name: '테스트 프로젝트', checkCommands: opts.checkCommands ?? [] });
    projectId = p.id;
    await internal('projects.setMock', p.id, { enabled: true, speed, defaultScenario: 'normal' });
    members.producer = p.producerId;
    const team = opts.team ?? ['developer', 'qa'];
    const counts: Record<string, number> = {};
    for (const roleId of team) {
      const m = await internal('members.add', { projectId: p.id, roleId });
      counts[roleId] = (counts[roleId] ?? 0) + 1;
      members[counts[roleId] === 1 ? roleId : `${roleId}${counts[roleId]}`] = m.id;
    }
    for (const [role, scenario] of Object.entries(opts.scenarios ?? {})) {
      if (role === 'main' || !scenario) continue;
      const id = members[role];
      if (id) await internal('members.update', id, { mockScenario: scenario });
    }
  } else if (opts.dataDir) {
    const p = core.ctx.store.projects.list()[0];
    if (p) {
      projectId = p.id;
      members.producer = p.producerId;
      for (const m of core.ctx.store.members.list({ project_id: p.id, state: 'active' })) if (!m.isProducer) members[m.roleId] ??= m.id;
    }
  }

  const h: Harness = {
    orch,
    core,
    dataDir,
    projectDir,
    projectId,
    members,
    invoke,
    internal,
    main: (tool: string, args: Record<string, unknown> = {}) => mainOp(core, tool, args),
    snapshot: () => core.views.snapshot(),
    async waitFor(pred, o = {}) {
      const timeout = o.timeoutMs ?? 60_000;
      const start = Date.now();
      for (;;) {
        if (await pred()) return;
        if (Date.now() - start > timeout) {
          const snap = core.views.snapshot();
          const dump = {
            tasks: snap.tasks.map((t) => `${t.id} ${t.state} ${t.hold?.reasons.map((r) => r.kind).join('+') ?? ''}`),
            directives: snap.directives.map((d) => `${d.id} ${d.state} r${d.round}`),
            queue: core.ctx.store.queue.list({ state: ['queued', 'running'] }).map((q) => `${q.id} ${q.kind} ${q.sessionKey} ${q.state}`),
            activity: core.ctx.store.activity.search({ limit: 25 }).map((e) => `${e.ts.slice(11, 19)} ${e.kind} ${e.text}`),
          };
          throw new Error(`waitFor 시간 초과 (${o.label ?? '조건'}, ${timeout}ms)\n${JSON.stringify(dump, null, 2)}`);
        }
        await new Promise((r) => setTimeout(r, o.intervalMs ?? 50));
      }
    },
    task: (id) => core.ctx.store.tasks.require(id),
    tasks: () => core.ctx.store.tasks.list(),
    async restart() {
      await orch.stop();
      return createHarness({ ...opts, dataDir, projectDir });
    },
    async close(o = {}) {
      await orch.stop();
      if (!o.keepDirs) {
        for (const d of [dataDir, resolve(projectDir, '..')]) {
          try {
            rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
          } catch {
            // 윈도우에서 잠긴 파일이 남으면 다음 정리에 맡긴다
          }
        }
      }
    },
  };
  return h;
}

/** 대표 명령을 보내고 지시가 생길 때까지 기다린다 */
export async function sendCommand(h: Harness, text: string): Promise<string> {
  const before = new Set(h.core.ctx.store.directives.list().map((d) => d.id));
  await h.invoke('command.send', { target: h.projectId, text });
  let id = '';
  await h.waitFor(
    () => {
      const d = h.core.ctx.store.directives.list().find((x) => !before.has(x.id));
      if (d) id = d.id;
      return !!d;
    },
    { label: '지시 등록' },
  );
  return id;
}
