/**
 * 완료 기준(17장) 'flow' 묶음용 하네스.
 * tests/e2e/harness.ts와 같은 실제 구성(SQLite·git·프로세스 러너·앱 도구 서버·모의 에이전트 프로세스)을 쓰되
 * - 화면 푸시 주기는 제품 기본값(150ms)을 그대로 둔다 — '2초 안에 화면 반영(ENV-08, AC-07)'을 실제 주기로 잰다
 * - 껍데기(OS 알림)를 기록용 가짜로 둔다 — 알림이 OS 알림 경계까지 가는지 확인
 * - 프로세스 러너를 감싸 실제로 띄운 CLI의 실행 명세(작업 폴더·형식·세션 키)를 남긴다
 * - 화면 푸시(snapshot·cliEvents·notification)를 받은 시각과 함께 남긴다
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { RoleId, Settings } from '@shared/domain';
import type { CliEvent } from '@shared/events';
import type { DeepPartial, WookMethod, WookParams, WookResult } from '@shared/ipc';
import type { AppSnapshot, NotificationView } from '@shared/views';
import { buildOrchestratorDeps } from '../../src/main/backend/buildDeps';
import type { ShellServices } from '../../src/main/backend/types';
import type { ProcessRunner, RunSpec } from '../../src/main/process/types';
import { createOrchestrator, type Orchestrator } from '../../src/main/orchestrator/orchestrator';
import { internalInvoker, mainOp } from '../regression/mainOps';

export interface Received<T> {
  /** 받은 시각 (Date.now) */
  at: number;
  payload: T;
}

export interface SpawnRecord {
  at: number;
  spec: RunSpec;
  /** 모의 에이전트 환경 변수의 세션 키 (예: task:T-0001) */
  workKey: string | null;
  memberId: string | null;
  /** --format 값 (claude | codex) */
  format: string | null;
}

export interface OsNotice {
  at: number;
  level: 'urgent' | 'normal';
  title: string;
  body: string;
}

export interface FlowApp {
  orch: Orchestrator;
  core: Orchestrator['core'];
  dataDir: string;
  projectDir: string;
  projectId: string;
  /** 역할 → 팀원 ID (producer 포함) */
  members: Record<string, string>;
  snapshots: Received<AppSnapshot>[];
  cliEvents: Received<{ memberId: string; turnId: string; events: CliEvent[] }>[];
  notifications: Received<NotificationView>[];
  osNotices: OsNotice[];
  spawns: SpawnRecord[];
  invoke<M extends WookMethod>(method: M, ...args: WookParams<M>): Promise<WookResult<M>>;
  /** 운영자 내부 API — 시험 준비 (SERVER_DESIGN 10.11 '준비 → 내부 API') */
  internal<M extends WookMethod>(method: M, ...args: WookParams<M>): Promise<WookResult<M>>;
  /** 메인 에이전트 운영 도구 (10.11 '대표 조작 → 메인 도구'). 거부되면 code를 가진 오류로 던진다 */
  main(tool: string, args?: Record<string, unknown>): Promise<Record<string, unknown>>;
  waitFor(pred: () => boolean, label: string, timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

/** 표준 실행 환경: 실제 저장소·git·러너·앱 도구 서버·모의 에이전트, 제품 기본 화면 푸시 주기 */
export async function createFlowApp(o: { team?: RoleId[]; speed?: number; settings?: DeepPartial<Settings> } = {}): Promise<FlowApp> {
  const dataDir = mkdtempSync(join(tmpdir(), 'wook-test-acc-data-'));
  const projectDir = join(mkdtempSync(join(tmpdir(), 'wook-test-acc-proj-')), '프로젝트 폴더');
  const osNotices: OsNotice[] = [];
  const shell: ShellServices = {
    openExternal: async () => undefined,
    openPath: async () => undefined,
    pickFiles: async () => [],
    showOsNotification: (n) => osNotices.push({ at: Date.now(), level: n.level, title: n.title, body: n.body }),
    focusWindow: () => undefined,
  };
  const deps = await buildOrchestratorDeps({
    dataDir,
    appRoot: process.cwd(),
    isPackaged: false,
    nodeExecPath: process.execPath,
    nodeExecEnv: {},
    shell,
    memorySecrets: true,
    logger: (level, msg, extra) => {
      if (level === 'error' && process.env.WOOK_TEST_LOG) console.error(`[${level}] ${msg}`, extra ?? '');
    },
    // timing 생략 = 제품 기본값 (화면 푸시 150ms, 감시 5초)
  });
  const spawns: SpawnRecord[] = [];
  const real = deps.runner;
  deps.runner = new Proxy(real, {
    get(target, prop) {
      if (prop === 'start') {
        return (spec: RunSpec) => {
          const fi = spec.args.indexOf('--format');
          spawns.push({
            at: Date.now(),
            spec,
            workKey: spec.env.WOOK_MOCK_WORKKEY ?? null,
            memberId: spec.env.WOOK_MOCK_MEMBER ?? null,
            format: fi >= 0 ? (spec.args[fi + 1] ?? null) : null,
          });
          return target.start(spec);
        };
      }
      const v = Reflect.get(target, prop, target) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  }) as ProcessRunner;

  const orch = await createOrchestrator(deps);
  const core = orch.core;
  const invoke = <M extends WookMethod>(method: M, ...args: WookParams<M>): Promise<WookResult<M>> => orch.backend.invoke(method, args);
  const snapshots: FlowApp['snapshots'] = [];
  const cliEvents: FlowApp['cliEvents'] = [];
  const notifications: FlowApp['notifications'] = [];
  const offs = [
    orch.backend.onTopic('snapshot', (s) => snapshots.push({ at: Date.now(), payload: s })),
    orch.backend.onTopic('cliEvents', (p) => cliEvents.push({ at: Date.now(), payload: p })),
    orch.backend.onTopic('notification', (n) => notifications.push({ at: Date.now(), payload: n })),
  ];
  const internal = internalInvoker(core) as FlowApp['internal'];
  await invoke('auth.devLogin');
  const speed = o.speed ?? 10;
  await internal('settings.update', { developer: { mainAgentMock: true, mockSpeed: speed }, execution: { maxConcurrent: 5 }, ...(o.settings ?? {}) } as DeepPartial<Settings>);
  const p = await internal('projects.create', { mode: 'new', path: projectDir, name: '흐름 프로젝트', checkCommands: [] });
  await internal('projects.setMock', p.id, { enabled: true, speed, defaultScenario: 'normal' });
  const members: Record<string, string> = { producer: p.producerId };
  for (const roleId of o.team ?? ['developer', 'qa']) {
    const m = await internal('members.add', { projectId: p.id, roleId });
    members[members[roleId] ? `${roleId}2` : roleId] = m.id;
  }

  const app: FlowApp = {
    orch,
    core,
    dataDir,
    projectDir,
    projectId: p.id,
    members,
    snapshots,
    cliEvents,
    notifications,
    osNotices,
    spawns,
    invoke,
    internal,
    main: (tool: string, args: Record<string, unknown> = {}) => mainOp(core, tool, args),
    async waitFor(pred, label, timeoutMs = 60_000) {
      const t0 = Date.now();
      while (!pred()) {
        if (Date.now() - t0 > timeoutMs) {
          const snap = core.views.snapshot();
          const dump = {
            tasks: snap.tasks.map((t) => `${t.id} ${t.state} ${t.hold?.reasons.map((r) => r.kind).join('+') ?? ''}`),
            directives: snap.directives.map((d) => `${d.id} ${d.state} r${d.round}`),
            queue: core.ctx.store.queue.list({ state: ['queued', 'running'] }).map((q) => `${q.id} ${q.kind} ${q.sessionKey} ${q.state}`),
            activity: core.ctx.store.activity.search({ limit: 20 }).map((e) => `${e.ts.slice(11, 19)} ${e.kind} ${e.text}`),
          };
          throw new Error(`시간 초과: ${label} (${timeoutMs}ms)\n${JSON.stringify(dump, null, 2)}`);
        }
        await sleep(25);
      }
    },
    async close() {
      for (const off of offs) off();
      await orch.stop();
      for (const d of [dataDir, resolve(projectDir, '..')]) {
        try {
          rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        } catch {
          // 윈도우에서 잠긴 파일이 남으면 다음 정리에 맡긴다
        }
      }
    },
  };
  return app;
}

/** 대표 명령을 보내고 메인 에이전트가 지시를 등록할 때까지 기다린다 */
export async function sendCommand(app: FlowApp, text: string): Promise<string> {
  const before = new Set(app.core.ctx.store.directives.list().map((d) => d.id));
  await app.invoke('command.send', { target: app.projectId, text });
  let id = '';
  await app.waitFor(() => {
    const d = app.core.ctx.store.directives.list().find((x) => !before.has(x.id));
    if (d) id = d.id;
    return !!d;
  }, '지시 등록');
  return id;
}

/** 화면 렌더링용 최소 window (React 서버 렌더링으로 화면 컴포넌트를 그릴 때) */
export function installWindowStub(): void {
  (globalThis as unknown as { window: unknown }).window = {
    wook: { invoke: async () => null, subscribe: () => () => undefined, platform: 'win32' },
    location: { search: '', hash: '' },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return true;
    },
    setTimeout,
    clearTimeout,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    getSelection: () => null,
  };
}

/** 보고서 마크다운에서 '## 제목' 구간 본문 */
export function section(markdown: string, heading: string): string {
  const lines = markdown.split('\n');
  const start = lines.findIndex((l) => l.trim() === heading);
  if (start < 0) return '';
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,2} /.test(lines[i]!)) break;
    out.push(lines[i]!);
  }
  return out.join('\n').trim();
}
