/**
 * 실제 AI 시험의 두 모드 (리드 결정 S9-10, SERVER_DESIGN 10.9 '서버 모드에서 … 통과한다'): `WOOK_REAL_MODE=server`면 realFeedback·realTeam(과 realHostExec)이
 * 서버 모드로 돈다. 기본은 desktop(예전 그대로).
 * - desktop: buildOrchestratorDeps(데스크톱 모드) → createOrchestrator → 개발 모드 로그인 → 운영 설정은 운영자 내부 API(settings.update)로. 대표 호출은
 *   Backend.invoke
 * - server: buildOrchestratorDeps({mode:'server'}, 화면 조작 끔, 임시 작업 폴더) — 운영 설정(메인 AI·모의 실행)은 시작 전에 저장소에 넣는다(처음 메인 자리
 *   보유자가 그 설정으로 앉고, 실제 메인 턴이 먼저 뜨지 않게 — 리드 결정 S6-19). 그 위에 프로세스 안 startServer({allowTestSession:true})를 열고
 *   operator.openTestSession()의 기기 세션 토큰(Bearer)으로 대표 호출을 HTTP(/api/invoke)로 보낸다 — 원격 길의 대표 게이트를 거친다. 설정·팀 준비는
 *   두 모드 모두 운영자 내부 API(10.11)
 * 토큰은 출력·실패 글에 넣지 않는다. 사용량이 드는 시험만 이 파일을 쓴다 — 에이전트는 돌리지 않는다 (리드 결정 S9-13·S9-17)
 */
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AiKind, Settings } from '@shared/domain';
import type { DeepPartial, WookMethod, WookParams, WookResult } from '@shared/ipc';
import { buildOrchestratorDeps, type BuildDepsOptions } from '../../src/main/backend/buildDeps';
import { createBackendOperator } from '../../src/main/backend/operator';
import { normalizeSettings } from '../../src/main/orchestrator/defaults';
import { createOrchestrator, type Orchestrator } from '../../src/main/orchestrator/orchestrator';
import type { Core } from '../../src/main/orchestrator/core';
import type { LogFn } from '../../src/main/orchestrator/context';
import { startServer, type RunningServer, type ServerBackend } from '../../src/server/server';
import { internalInvoker, type Invoker } from '../regression/mainOps';
import { invokeHttp, memoryLogger } from '../server/helpers';

export type RealMode = 'desktop' | 'server';

/** WOOK_REAL_MODE — 'server'·'desktop'만 받고, 없으면 fallback */
export function realMode(env: NodeJS.ProcessEnv = process.env, fallback: RealMode = 'desktop'): RealMode {
  const v = env['WOOK_REAL_MODE']?.trim();
  if (!v) return fallback;
  if (v === 'server' || v === 'desktop') return v;
  throw new Error('WOOK_REAL_MODE는 server나 desktop이어야 합니다');
}

/** 시작 전에 넣을 운영 설정 (서버 모드) — 데스크톱 모드는 시작 뒤 settings.update로 같은 값을 넣는다 */
export interface RealSettings {
  general?: Partial<Settings['general']>;
  developer?: Partial<Settings['developer']>;
}

export interface RealApp {
  mode: RealMode;
  orch: Orchestrator;
  core: Core;
  /** 대표 호출 — desktop은 Backend.invoke, server는 HTTP(Bearer 기기 세션) */
  invoke: Invoker;
  /** 운영자 내부 API (설정·팀 준비, SERVER_DESIGN 10.11) */
  internal: Invoker;
  close(): Promise<void>;
}

export interface BootRealOptions {
  mode: RealMode;
  dataDir: string;
  settings: RealSettings;
  logger?: LogFn;
  /** 시작 전에 설치·로그인을 볼 CLI — 하나라도 쓸 수 없으면 아무것도 시작하지 않고 skip에 그 까닭을 준다 */
  requireCli?: AiKind[];
}

/** 하네스 없이 띄운 백엔드를 서버가 쓰는 모양으로 (tests/server/helpers.ts remoteBackendOf와 같은 조립) */
function serverBackendOf(orch: Orchestrator): ServerBackend {
  const b = orch.backend;
  const core = orch.core;
  return {
    invoke: b.invoke,
    onTopicRaw: b.onTopicRaw,
    topicFor: b.topicFor,
    snapshotFor: b.snapshotFor,
    hasActiveWork: b.hasActiveWork,
    operator: createBackendOperator(() => core),
    sessions: core.deviceSessions,
    files: core.serverFiles,
    ...(b.agents ? { agents: b.agents } : {}),
  };
}

/** 실제 시험의 앱을 띄운다. requireCli의 CLI를 쓸 수 없으면 { skip } */
export async function bootReal(o: BootRealOptions): Promise<RealApp | { skip: string }> {
  const server = o.mode === 'server';
  const workRoot = server ? mkdtempSync(join(tmpdir(), 'wook-real-ws-')) : null;
  const options: BuildDepsOptions = {
    dataDir: o.dataDir,
    appRoot: process.cwd(),
    isPackaged: false,
    nodeExecPath: process.execPath,
    nodeExecEnv: {},
    shell: null,
    memorySecrets: true,
    ...(o.logger ? { logger: o.logger } : {}),
    // 서버 모드: 화면 조작 끔(이 PC의 화면을 쓰지 않는다), 작업 폴더는 임시 폴더 (실제 ~/wook-workspace에 만들지 않는다)
    ...(server ? { mode: 'server' as const, screen: { enabled: false }, workspaceRoot: workRoot! } : {}),
  };
  const deps = await buildOrchestratorDeps(options);
  for (const kind of o.requireCli ?? []) {
    const status = await deps.adapters[kind].detect();
    if (!status.installed || status.loggedIn === false) {
      deps.store.close();
      deps.runner.dispose?.();
      if (workRoot) await rm(workRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
      return { skip: `${kind}: ${status.detail}` };
    }
  }
  if (server) {
    // 시작 전에 — 처음 메인 자리 보유자와 모의 실행 여부가 이 값으로 정해진다
    const seeded = normalizeSettings(deps.store.kv.get<Settings>('settings'));
    deps.store.kv.set('settings', {
      ...seeded,
      general: { ...seeded.general, ...o.settings.general },
      developer: { ...seeded.developer, ...o.settings.developer },
    });
  }
  const orch = await createOrchestrator(deps).catch(async (error: unknown) => {
    // 시작하지 못했으면 임시 작업 폴더를 남기지 않는다 (리드 결정 S9-22 TI-1)
    if (workRoot) await rm(workRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
    throw error;
  });
  const core = orch.core;
  const internal = internalInvoker(core);
  if (!server) {
    const invoke = (<M extends WookMethod>(method: M, ...args: WookParams<M>): Promise<WookResult<M>> => orch.backend.invoke(method, args)) as Invoker;
    try {
      await invoke('auth.devLogin');
      await internal('settings.update', o.settings as DeepPartial<Settings>);
    } catch (error) {
      await orch.stop().catch(() => undefined);
      throw error;
    }
    return { mode: 'desktop', orch, core, invoke, internal, close: () => orch.stop() };
  }
  let running: RunningServer | null = null;
  try {
    const backend = serverBackendOf(orch);
    running = await startServer({ backend, dataDir: o.dataDir, port: 0, allowTestSession: true, logger: memoryLogger(), version: 'real-test' });
    const token = backend.operator.openTestSession().token;
    const url = running.url;
    const invoke = (async <M extends WookMethod>(method: M, ...args: WookParams<M>): Promise<WookResult<M>> => {
      const r = await invokeHttp(url, token, method, args);
      const body = r.json<{ ok: boolean; value?: unknown; error?: { code: string; message: string } }>();
      if (!body.ok) throw new Error(`대표 호출 ${method} 실패 (HTTP ${r.status} ${body.error?.code ?? '?'}): ${body.error?.message ?? ''}`);
      return body.value as WookResult<M>;
    }) as Invoker;
    const srv = running;
    return {
      mode: 'server',
      orch,
      core,
      invoke,
      internal,
      async close() {
        try {
          await srv.close().catch(() => undefined);
          await orch.stop();
        } finally {
          // 멈추기가 실패해도 임시 작업 폴더는 지운다 (리드 결정 S9-22 TI-1)
          await rm(workRoot!, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
        }
      },
    };
  } catch (error) {
    await running?.close().catch(() => undefined);
    await orch.stop().catch(() => undefined);
    await rm(workRoot!, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
    throw error;
  }
}
