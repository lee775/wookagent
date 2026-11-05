/**
 * API 키 방식(account.authMode = api_key)으로 쓰는 AI 종류가 앱을 켤 때마다 '재로그인 필요'로 막히지 않는다 (리드 결정 16, 10-29 —
 * owner-surface 재리뷰 medium N2, 프로브 zz-s1fix-os-n2-apikey-auth N2a·N2b).
 * - 앱 조립(buildDeps)이 두 어댑터에 상태 확인 환경(statusEnv)을 넘긴다: API 키 방식이고 키가 등록돼 있으면 턴과 같은 변수(ANTHROPIC_API_KEY·OPENAI_API_KEY),
 *   아니면 없음. 키는 메모리 사본 — 시작 때 저장소에서 채우고 settings.setApiKey가 바꾼다
 * - API 키 방식이고 키가 등록돼 있으면 상태 확인의 '로그인 안 됨'은 알 수 없음으로 본다: 시작 때 확인은 그대로 두고, system.recheckAi는 푼다(한 번 더 시도)
 * - settings.setApiKey로 키를 새로 넣으면 API 키 방식의 재로그인 필요를 푼다 (데스크톱 운영자가 틀린 키를 바로잡는 길)
 * - 키 값은 활동 기록·알림·로그에 남지 않는다
 * 실제 Claude CLI는 돌리지 않는다: 실제 어댑터의 detect에 실행 파일 해석과 명령 실행만 대역을 쓴다(대역은 키가 환경에 있을 때만 로그인됨이라고 답한다)
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAIN_AGENT_ID, type Settings } from '@shared/domain';
import type { ParsedCliEvent } from '@shared/events';
import { createClaudeAdapter, type ClaudeAdapterOptions } from '../../src/main/agents';
import type { AgentAdapter, CliStatus, PreparedRun, TurnLaunch } from '../../src/main/agents/types';
import type { RunCommand } from '../../src/main/agents/resolveCli';
import type { ProcessRunner, RunSpec } from '../../src/main/process/types';
import type { TokenIdentity } from '../../src/main/mcp/types';
import type { OrchestratorDeps } from '../../src/main/orchestrator/context';
import { createOrchestrator, type Orchestrator } from '../../src/main/orchestrator/orchestrator';
import { normalizeSettings } from '../../src/main/orchestrator/defaults';
import { buildOrchestratorDeps } from '../../src/main/backend/buildDeps';
import { SECRET_KEYS } from '../../src/main/auth/types';
import { FakeProc } from './orchHarness';
import { sleep, waitUntil } from '../acceptance/stops-helpers';

/** 앱 조립이 어댑터에 넘긴 옵션을 잡는다 (감싸기만 하고 그대로 만든다) */
const captured = vi.hoisted(() => ({ claude: undefined as unknown, codex: undefined as unknown }));
vi.mock('../../src/main/agents', async (importOriginal) => {
  const m = await importOriginal<typeof import('../../src/main/agents')>();
  return {
    ...m,
    createClaudeAdapter: (o: Parameters<typeof m.createClaudeAdapter>[0]) => {
      captured.claude = o;
      return m.createClaudeAdapter(o);
    },
    createCodexAdapter: (o: Parameters<typeof m.createCodexAdapter>[0]) => {
      captured.codex = o;
      return m.createCodexAdapter(o);
    },
  };
});

type StatusEnvFn = () => Record<string, string>;
const statusEnvOf = (o: unknown): StatusEnvFn | undefined => (o as { statusEnv?: StatusEnvFn } | undefined)?.statusEnv;

const KEY = 'sk-ant-api03-regression-key-1234567890abcdef';
const NEW_KEY = 'sk-ant-api03-regression-new-key-0987654321fedcba';

const dirs: string[] = [];
const orchs: Orchestrator[] = [];
afterEach(async () => {
  for (const o of orchs.splice(0)) await o.stop().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const buildOpts = (dataDir: string) => ({
  dataDir,
  appRoot: process.cwd(),
  isPackaged: false,
  nodeExecPath: process.execPath,
  nodeExecEnv: {},
  shell: null,
  memorySecrets: true,
  runnerMode: process.platform === 'win32' ? ('taskkill' as const) : ('pgroup' as const),
  jobHelper: null,
});

interface App {
  orch: Orchestrator;
  /** 대역 CLI가 상태 확인 때 받은 키 (없으면 null) */
  statusKeys: (string | null)[];
  launches: { memberId: string; key: string | undefined }[];
  logs: string[];
}

/**
 * 앱 조립(buildOrchestratorDeps)을 그대로 쓰고 CLI 쪽만 대역으로: Claude는 앱이 넘긴 옵션(statusEnv 포함)으로 만든 실제 어댑터의 detect를 쓰되
 * 실행 파일 해석·명령 실행만 대역. statusEnv: 'product'면 앱이 넘긴 것, 'none'이면 빼서 상태 확인이 키를 못 보는 CLI를 흉내 낸다.
 * 비밀 저장소는 재시작 사이에 남도록 시험의 Map을 쓴다
 */
async function startApp(dataDir: string, secrets: Map<string, string>, o: { statusEnv: 'product' | 'none' }): Promise<App> {
  const deps = await buildOrchestratorDeps(buildOpts(dataDir));
  const prodOpts = captured.claude as ClaudeAdapterOptions;
  const statusKeys: (string | null)[] = [];
  const launches: App['launches'] = [];
  const logs: string[] = [];
  const cli: RunCommand = async (_file, args, opts) => {
    if (args[0] === '--version') return { code: 0, stdout: '2.1.30 (Claude Code)\n', stderr: '', timedOut: false, error: null };
    const key = opts.env.ANTHROPIC_API_KEY ?? null;
    statusKeys.push(key);
    // 구독 로그인은 없고, 등록된 키가 환경에 있을 때만 로그인됨 (API 키 방식)
    return key === KEY || key === NEW_KEY
      ? { code: 0, stdout: '{"loggedIn":true,"authMethod":"api_key"}', stderr: '', timedOut: false, error: null }
      : { code: 1, stdout: '{"loggedIn":false,"authMethod":"none"}', stderr: '', timedOut: false, error: null };
  };
  const realClaude = createClaudeAdapter({
    ...prodOpts,
    ...(o.statusEnv === 'none' ? { statusEnv: undefined } : {}),
    resolveExecutable: async () => ({ kind: 'claude', path: 'C:/fake/claude.exe', source: 'path', npmPackageRoot: null, note: '' }),
    runCommand: cli,
  });
  const byToken = new Map<string, TokenIdentity>();
  const fake = (kind: 'claude' | 'codex' | 'mock', detect: () => Promise<CliStatus>): AgentAdapter => ({
    kind,
    detect,
    async prepare(launch: TurnLaunch): Promise<PreparedRun> {
      const who = byToken.get(launch.mcp.token)!;
      launches.push({ memberId: who.memberId, key: launch.env.ANTHROPIC_API_KEY });
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
  const runner: ProcessRunner = {
    mode: 'pgroup',
    detail: '회귀 시험: 가짜 러너',
    start(spec: RunSpec) {
      const p = new FakeProc(String(spec.args[0]), String(spec.args[1]), String(spec.args[2]));
      setTimeout(() => p.finishOk(), 5);
      return p;
    },
    isAlive: async () => false,
    processCreatedAt: async () => new Map(),
    killTree: async () => ({ ok: true, remaining: 0, detail: '', durationMs: 0 }),
  };
  await deps.runner.dispose?.();
  const fullDeps = {
    ...deps,
    runner,
    adapters: {
      claude: fake('claude', () => realClaude.detect()),
      codex: fake('codex', async () => ({ installed: true, path: 'fake', version: '0.50.0', loggedIn: true, problem: null, detail: '가짜' })),
      mock: fake('mock', async () => ({ installed: true, path: 'fake', version: '9.9.9', loggedIn: true, problem: null, detail: '가짜' })),
    },
    createToolServer: () => ({
      url: 'http://127.0.0.1:9/mcp',
      start: async () => ({ url: 'http://127.0.0.1:9/mcp', port: 9 }),
      stop: async () => undefined,
      issueToken: (identity: TokenIdentity) => {
        const token = `tok-${identity.turnId}`;
        byToken.set(token, identity);
        return token;
      },
      revokeToken: () => undefined,
      revokeTurn: () => undefined,
    }),
    secrets: {
      backend: 'memory' as const,
      get: async (k: string) => secrets.get(k) ?? null,
      set: async (k: string, v: string) => void secrets.set(k, v),
      delete: async (k: string) => void secrets.delete(k),
    },
    logger: (level: string, msg: string, extra?: unknown) => logs.push(`${level} ${msg} ${extra instanceof Error ? extra.message : JSON.stringify(extra ?? '')}`),
    timing: { watchdogMs: 100, snapshotThrottleMs: 20 },
  } as unknown as OrchestratorDeps;
  const store = fullDeps.store as unknown as { kv: { get<T>(k: string): T | null } };
  const before = store.kv.get<{ checkedAt: string | null }>('ai.claude')?.checkedAt ?? null;
  const orch = await createOrchestrator(fullDeps);
  orch.core.scheduler.stop();
  orchs.push(orch);
  await waitUntil(() => orch.core.ctx.ai('claude').checkedAt !== before, '시작 때 CLI 확인');
  await orch.backend.invoke('auth.devLogin', []);
  return { orch, statusKeys, launches, logs };
}

async function stopApp(app: App): Promise<void> {
  await app.orch.stop();
  orchs.splice(orchs.indexOf(app.orch), 1);
}

const mainLaunches = (app: App) => app.launches.filter((l) => l.memberId === MAIN_AGENT_ID);

/** 처음 설치: 데스크톱 운영자가 Claude를 API 키 방식으로 두고 키를 등록한다 (메인은 실제 CLI 경로 — 모의 아님) */
async function installApiKeyMode(dataDir: string, secrets: Map<string, string>, o: { statusEnv: 'product' | 'none'; key?: string | null }): Promise<void> {
  const app = await startApp(dataDir, secrets, o);
  await app.orch.backend.invoke('settings.update', [{ account: { authMode: { claude: 'api_key', codex: 'subscription' } } }]);
  if (o.key !== null) await app.orch.backend.invoke('settings.setApiKey', ['claude', o.key ?? KEY]);
  expect(app.orch.core.ctx.settings().developer.mainAgentMock).toBe(false);
  expect(app.orch.core.ctx.store.members.require(MAIN_AGENT_ID).ai.kind).toBe('claude');
  await stopApp(app);
}

const setAuthRequired = (app: App, since: string | null): void => {
  const ctx = app.orch.core.ctx;
  ctx.saveAi({ ...ctx.ai('claude'), authRequired: since !== null, authRequiredSince: since });
};

describe('API 키 방식은 상태 확인에도 키를 쓰고, 재로그인 필요로 영영 막히지 않는다 (리드 결정 16)', () => {
  it('앱 조립이 두 어댑터에 statusEnv를 넘긴다 — API 키 방식이고 키가 있을 때만 턴과 같은 변수(claude ANTHROPIC_API_KEY, codex OPENAI_API_KEY)', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'wook-test-apikey-env-'));
    dirs.push(dataDir);
    const deps = await buildOrchestratorDeps(buildOpts(dataDir));
    try {
      const claudeEnv = statusEnvOf(captured.claude);
      const codexEnv = statusEnvOf(captured.codex);
      expect([typeof claudeEnv, typeof codexEnv]).toEqual(['function', 'function']);
      expect(deps.apiKeys).toBeDefined();
      // 키 없음 → 없음 (구독 방식 기본값)
      expect([claudeEnv!(), codexEnv!()]).toEqual([{}, {}]);
      deps.apiKeys!.set('claude', KEY);
      deps.apiKeys!.set('codex', 'sk-proj-regression-codex-key-000000000000');
      // 구독 방식이면 키가 있어도 넣지 않는다
      expect([claudeEnv!(), codexEnv!()]).toEqual([{}, {}]);
      const s = normalizeSettings(null);
      deps.store.kv.set('settings', { ...s, account: { ...s.account, authMode: { claude: 'api_key', codex: 'api_key' } } } satisfies Settings);
      expect(claudeEnv!()).toEqual({ ANTHROPIC_API_KEY: KEY });
      expect(codexEnv!()).toEqual({ OPENAI_API_KEY: 'sk-proj-regression-codex-key-000000000000' });
      // 키를 지우면 다시 없음
      deps.apiKeys!.set('claude', null);
      expect(claudeEnv!()).toEqual({});
    } finally {
      await deps.runner.dispose?.();
      (deps.store as unknown as { close(): void }).close();
    }
  });

  it('키를 등록한 API 키 방식 PC를 다시 켜면 상태 확인이 키로 로그인을 확인해 재로그인 필요가 풀리고, 메인 턴이 키를 받아 뜬다 (N2b)', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'wook-test-apikey-start-'));
    dirs.push(dataDir);
    const secrets = new Map<string, string>();
    await installApiKeyMode(dataDir, secrets, { statusEnv: 'product' });
    // 지난 실행에서 턴이 auth_required로 끝나 재로그인 필요가 걸려 있었다
    let app = await startApp(dataDir, secrets, { statusEnv: 'product' });
    setAuthRequired(app, '2026-10-01T00:00:00.000Z');
    await stopApp(app);

    app = await startApp(dataDir, secrets, { statusEnv: 'product' });
    // 시작 때 상태 확인이 등록된 키를 환경으로 받았다 (메모리 사본은 시작 때 저장소에서 채움)
    expect(app.statusKeys).toEqual([KEY]);
    expect(app.orch.core.ctx.ai('claude')).toMatchObject({ authRequired: false, authRequiredSince: null });
    expect(app.orch.core.ctx.store.activity.search({ text: '(시작 때 확인) — 재로그인 필요를 풂', limit: 5 }).map((r) => r.text)).toEqual(['claude CLI 로그인 확인 (시작 때 확인) — 재로그인 필요를 풂']);
    await app.orch.backend.invoke('command.send', [{ target: 'main', text: '현황 알려 줘' }]);
    app.orch.core.scheduler.tick();
    await waitUntil(() => mainLaunches(app).length === 1, '메인 턴');
    expect(mainLaunches(app)[0]!.key).toBe(KEY);
    // 대표의 다시 확인도 같은 키로 확인한다
    await app.orch.backend.invoke('system.recheckAi', ['claude']);
    expect(app.statusKeys.at(-1)).toBe(KEY);
    expect(app.orch.core.ctx.ai('claude').authRequired).toBe(false);
  });

  it('상태 확인이 키를 보지 못해도(로그인 안 됨) API 키 방식이고 키가 있으면: 시작 때 확인은 걸지 않고 그대로 두며, 대표의 다시 확인은 푼다', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'wook-test-apikey-unknown-'));
    dirs.push(dataDir);
    const secrets = new Map<string, string>();
    await installApiKeyMode(dataDir, secrets, { statusEnv: 'none' });

    // 걸려 있지 않으면 시작 때 확인이 걸지 않는다 → 메인 턴이 뜬다
    let app = await startApp(dataDir, secrets, { statusEnv: 'none' });
    expect(app.statusKeys).toEqual([null]);
    expect(app.orch.core.ctx.ai('claude').authRequired).toBe(false);
    await app.orch.backend.invoke('command.send', [{ target: 'main', text: '현황 알려 줘' }]);
    app.orch.core.scheduler.tick();
    await waitUntil(() => mainLaunches(app).length === 1, '메인 턴');
    expect(mainLaunches(app)[0]!.key).toBe(KEY);
    // 턴이 틀린 키로 auth_required로 끝나 걸렸다 → 재시작해도 그대로(알 수 없음) → 대표의 다시 확인이 푼다(한 번 더 시도)
    setAuthRequired(app, '2026-10-02T00:00:00.000Z');
    await stopApp(app);
    app = await startApp(dataDir, secrets, { statusEnv: 'none' });
    expect(app.orch.core.ctx.ai('claude')).toMatchObject({ authRequired: true, authRequiredSince: '2026-10-02T00:00:00.000Z' });
    await app.orch.backend.invoke('command.send', [{ target: 'main', text: '다시' }]);
    app.orch.core.scheduler.tick();
    await sleep(300);
    expect(mainLaunches(app)).toHaveLength(0);
    await app.orch.backend.invoke('system.recheckAi', ['claude']);
    expect(app.orch.core.ctx.ai('claude')).toMatchObject({ authRequired: false, authRequiredSince: null });
    const recheck = app.orch.core.ctx.store.activity.search({ text: 'claude CLI 다시 확인', limit: 5 });
    expect(recheck.map((r) => r.actor)).toEqual(['owner']);
    expect(recheck[0]!.text).toContain('API 키 방식');
    app.orch.core.scheduler.tick();
    await waitUntil(() => mainLaunches(app).length === 1, '다시 확인 뒤 메인 턴');
  });

  it('구독 방식이거나 키가 등록되지 않은 API 키 방식에서는 로그인 안 됨이 그대로 재로그인 필요를 건다 (결정 7 그대로)', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'wook-test-apikey-nokey-'));
    dirs.push(dataDir);
    const secrets = new Map<string, string>();
    await installApiKeyMode(dataDir, secrets, { statusEnv: 'product', key: null });
    let app = await startApp(dataDir, secrets, { statusEnv: 'product' });
    expect(app.orch.core.ctx.ai('claude').authRequired).toBe(true);
    await app.orch.backend.invoke('system.recheckAi', ['claude']);
    expect(app.orch.core.ctx.ai('claude').authRequired).toBe(true);
    // 키는 있지만 구독 방식
    await app.orch.backend.invoke('settings.update', [{ account: { authMode: { claude: 'subscription' } } }]);
    secrets.set(SECRET_KEYS.apiKeyClaude, KEY);
    await stopApp(app);
    app = await startApp(dataDir, secrets, { statusEnv: 'product' });
    expect(app.statusKeys).toEqual([null]);
    expect(app.orch.core.ctx.ai('claude').authRequired).toBe(true);
    await app.orch.backend.invoke('system.recheckAi', ['claude']);
    expect(app.orch.core.ctx.ai('claude').authRequired).toBe(true);
  });

  it('데스크톱 운영자가 API 키를 새로 등록하면 재로그인 필요가 풀리고(기록), 상태 확인도 곧바로 새 키를 쓴다 — 키 값은 기록·알림·로그에 남지 않는다', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'wook-test-apikey-set-'));
    dirs.push(dataDir);
    const secrets = new Map<string, string>();
    await installApiKeyMode(dataDir, secrets, { statusEnv: 'product', key: null });
    const app = await startApp(dataDir, secrets, { statusEnv: 'product' });
    const ctx = app.orch.core.ctx;
    expect(ctx.ai('claude').authRequired).toBe(true);
    await app.orch.backend.invoke('command.send', [{ target: 'main', text: '현황 알려 줘' }]);
    app.orch.core.scheduler.tick();
    await sleep(300);
    expect(mainLaunches(app)).toHaveLength(0);

    // 빈 키는 풀지 않는다
    await app.orch.backend.invoke('settings.setApiKey', ['claude', '   ']);
    expect(ctx.ai('claude').authRequired).toBe(true);
    await app.orch.backend.invoke('settings.setApiKey', ['claude', NEW_KEY]);
    expect(ctx.ai('claude')).toMatchObject({ authRequired: false, authRequiredSince: null });
    const freed = ctx.store.activity.search({ text: 'API 키를 새로 등록해 재로그인 필요를 풂', limit: 5 });
    expect(freed.map((r) => [r.actor, r.kind])).toEqual([['owner', 'auth']]);
    // 다시 확인: 메모리 사본이 바뀌어 상태 확인이 새 키로 로그인을 확인한다 (재시작 없이)
    await app.orch.backend.invoke('system.recheckAi', ['claude']);
    expect(app.statusKeys.at(-1)).toBe(NEW_KEY);
    expect(ctx.ai('claude').authRequired).toBe(false);
    app.orch.core.scheduler.tick();
    await waitUntil(() => mainLaunches(app).length === 1, '키 등록 뒤 메인 턴');
    expect(mainLaunches(app)[0]!.key).toBe(NEW_KEY);

    // 구독 방식이면 키를 넣어도 재로그인 필요를 건드리지 않는다
    await app.orch.backend.invoke('settings.update', [{ account: { authMode: { claude: 'subscription' } } }]);
    ctx.saveAi({ ...ctx.ai('claude'), authRequired: true, authRequiredSince: ctx.now() });
    await app.orch.backend.invoke('settings.setApiKey', ['claude', KEY]);
    expect(ctx.ai('claude').authRequired).toBe(true);
    expect(ctx.store.activity.search({ text: 'API 키를 새로 등록해 재로그인 필요를 풂', limit: 5 })).toHaveLength(1);

    // 키 값은 어디에도 남지 않는다
    const texts = [
      ...ctx.store.activity.search({ limit: 500 }).map((r) => `${r.text} ${r.result ?? ''}`),
      ...ctx.store.notifications.list({}).map((n) => `${n.title} ${n.body}`),
      ...app.logs,
    ].join('\n');
    expect(texts).not.toContain(KEY);
    expect(texts).not.toContain(NEW_KEY);
  });
});
