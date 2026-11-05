/**
 * CLI 재로그인 필요(authRequired)가 메인 에이전트의 AI 종류에 걸려도 대표 쪽 길로 풀린다 (리드 결정 7, 10-29 — owner-surface 리뷰 H2, 프로브 P2).
 * 재로그인 필요가 걸리면 그 AI 종류의 새 턴이 모두 막힌다(실행 허용 검사 'auth'). 메인도 그 종류를 쓰면 메인 턴이 뜨지 않아 recheck_ai를 부를 수 없다.
 * - system.recheckAi는 대표 메서드다 (CLI 상태를 다시 읽을 뿐 팀·작업·설정을 바꾸지 않는 보기) — 대표가 CLI에 다시 로그인하고 '다시 확인'하면 풀린다
 * - 시작 때 CLI 확인도 로그인 상태를 맞춘다: 로그인 확인(true)이면 풀고, 로그인 필요(false)면 걸되 처음 걸린 때를 그대로 두며, 알 수 없으면(null) 그대로 둔다
 * - 메인의 recheck_ai는 그대로 있다
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID } from '@shared/domain';
import { createRedactor } from '@core/redact';
import { systemClock } from '@core/time';
import { openStore } from '../../src/main/db/store';
import { createGitService } from '../../src/main/git/gitService';
import type { AgentAdapter, CliStatus } from '../../src/main/agents/types';
import type { ProcessRunner } from '../../src/main/process/types';
import type { OrchestratorDeps } from '../../src/main/orchestrator/context';
import { createOrchestrator, type Orchestrator } from '../../src/main/orchestrator/orchestrator';
import { dataPaths } from '../../src/main/orchestrator/paths';
import { bootRestartable, sleep, waitUntil, type RestartableEnv } from '../acceptance/stops-helpers';

let env: RestartableEnv | null = null;
const dirs: string[] = [];
afterEach(async () => {
  await env?.close();
  env = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const mainLaunches = (e: RestartableEnv) => e.launches.filter((l) => l.memberId === MAIN_AGENT_ID).length;

describe('재로그인 필요는 대표의 다시 확인과 시작 때 CLI 확인으로 풀린다 (리드 결정 7)', () => {
  it('메인의 AI 종류가 재로그인 필요로 막혀도, 대표가 다시 로그인하고 system.recheckAi를 부르면 풀려 쌓인 명령이 처리된다 — 기록은 대표', async () => {
    env = await bootRestartable({ mock: false });
    const e = env;
    const kind = e.ctx.store.members.require(MAIN_AGENT_ID).ai.kind;
    // 턴이 auth_required로 끝났을 때 judge가 하는 일
    e.ctx.saveAi({ ...e.ctx.ai(kind), authRequired: true, authRequiredSince: e.ctx.now() });
    expect(e.core.views.snapshot().ownerTodos.map((t) => t.kind)).toContain('auth_required');
    // 메인에게 명령해도 메인 턴이 뜨지 않는다 (실행 허용 검사 'auth') — 메인은 recheck_ai를 부를 수 없다
    await e.invoke('command.send', { target: 'main', text: 'CLI 다시 확인해 줘' });
    e.tick();
    await sleep(300);
    expect(mainLaunches(e)).toBe(0);
    // 대표가 터미널에서 다시 로그인한 뒤 홈의 '다시 확인' (가짜 어댑터 detect: loggedIn true)
    await e.invoke('system.recheckAi', kind);
    expect(e.ctx.ai(kind)).toMatchObject({ authRequired: false, authRequiredSince: null });
    expect(e.ctx.store.activity.search({ text: `${kind} CLI 다시 확인`, limit: 5 }).map((r) => r.actor)).toEqual(['owner']);
    expect(e.core.views.snapshot().ownerTodos.map((t) => t.kind)).not.toContain('auth_required');
    e.tick();
    await waitUntil(() => mainLaunches(e) === 1, '쌓인 대표 명령 처리');
  });

  it('재시작하면 시작 때 CLI 확인이 로그인을 확인해 재로그인 필요를 풀고 메인이 다시 돈다', async () => {
    env = await bootRestartable({ mock: false });
    let e = env;
    const kind = e.ctx.store.members.require(MAIN_AGENT_ID).ai.kind;
    e.ctx.saveAi({ ...e.ctx.ai(kind), authRequired: true, authRequiredSince: e.ctx.now() });
    await e.invoke('command.send', { target: 'main', text: '현황 알려 줘' });
    e.tick();
    await sleep(300);
    expect(mainLaunches(e)).toBe(0);
    const checkedAt = e.ctx.ai(kind).checkedAt;
    env = await e.stopGracefully();
    e = env;
    await waitUntil(() => e.ctx.ai(kind).checkedAt !== checkedAt, '재시작 뒤 CLI 확인');
    expect(e.ctx.ai(kind)).toMatchObject({ authRequired: false, authRequiredSince: null });
    expect(e.ctx.store.activity.search({ text: '재로그인 필요를 풂', limit: 5 }).map((r) => r.text)).toEqual([`${kind} CLI 로그인 확인 (시작 때 확인) — 재로그인 필요를 풂`]);
    e.tick();
    await waitUntil(() => mainLaunches(e) === 1, '재시작 뒤 메인 턴');
  });

  it('시작 때 CLI 확인: 로그인 필요(false)면 걸고 처음 걸린 때를 그대로 두며, 알 수 없으면(null) 그대로 두고, 확인되면(true) 푼다', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'wook-test-auth-start-'));
    dirs.push(dataDir);
    const loggedIn: { claude: boolean | null; codex: boolean | null } = { claude: true, codex: true };
    // 앱을 시작하고 시작 때 CLI 확인이 끝날 때까지 기다린다
    const start = async (): Promise<Orchestrator> => {
      const adapter = (kind: 'claude' | 'codex' | 'mock'): AgentAdapter => ({
        kind,
        detect: async (): Promise<CliStatus> => ({ installed: true, path: 'fake', version: '9.9.9', loggedIn: kind === 'mock' ? true : loggedIn[kind], problem: null, detail: '가짜' }),
        prepare: async () => {
          throw new Error('이 시험은 CLI를 띄우지 않습니다');
        },
        createParser: () => ({ pushLine: () => [], pushStderr: () => [], finish: () => [] }),
      });
      const runner: ProcessRunner = {
        mode: 'pgroup',
        detail: '이 시험은 프로세스를 띄우지 않습니다',
        start() {
          throw new Error('이 시험은 프로세스를 띄우지 않습니다');
        },
        isAlive: async () => false,
        processCreatedAt: async () => new Map(),
        killTree: async () => ({ ok: true, remaining: 0, detail: '', durationMs: 0 }),
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
        createToolServer: () => ({
          url: 'http://127.0.0.1:9/mcp',
          start: async () => ({ url: 'http://127.0.0.1:9/mcp', port: 9 }),
          stop: async () => undefined,
          issueToken: () => 'tok',
          revokeToken: () => undefined,
          revokeTurn: () => undefined,
        }),
        secrets: { get: async () => null, set: async () => undefined, delete: async () => undefined },
        redactor: createRedactor(),
        shell: null,
        logger: () => undefined,
        timing: { watchdogMs: 100, snapshotThrottleMs: 20 },
      } as unknown as OrchestratorDeps;
      const store = deps.store as { kv: { get<T>(k: string): T | null } };
      const before = { claude: store.kv.get<{ checkedAt: string | null }>('ai.claude')?.checkedAt ?? null, codex: store.kv.get<{ checkedAt: string | null }>('ai.codex')?.checkedAt ?? null };
      const orch = await createOrchestrator(deps);
      orch.core.scheduler.stop();
      await waitUntil(() => orch.core.ctx.ai('claude').checkedAt !== before.claude && orch.core.ctx.ai('codex').checkedAt !== before.codex, '시작 때 CLI 확인');
      return orch;
    };

    let orch = await start();
    const since = '2026-10-01T00:00:00.000Z';
    orch.core.ctx.saveAi({ ...orch.core.ctx.ai('claude'), authRequired: true, authRequiredSince: since });
    await orch.stop();

    // 로그인 필요(false): claude는 걸린 채 처음 걸린 때 그대로, codex는 새로 걸린다
    loggedIn.claude = false;
    loggedIn.codex = false;
    orch = await start();
    expect([orch.core.ctx.ai('claude').authRequired, orch.core.ctx.ai('claude').authRequiredSince]).toEqual([true, since]);
    expect(orch.core.ctx.ai('codex').authRequired).toBe(true);
    expect(orch.core.ctx.ai('codex').authRequiredSince).not.toBeNull();
    await orch.stop();

    // 알 수 없음(null): 그대로 둔다 — claude는 걸린 채, 그리고 아래에서 codex를 풀어 둔 값도 그대로
    loggedIn.claude = null;
    loggedIn.codex = true;
    orch = await start();
    expect([orch.core.ctx.ai('claude').authRequired, orch.core.ctx.ai('claude').authRequiredSince]).toEqual([true, since]);
    expect([orch.core.ctx.ai('codex').authRequired, orch.core.ctx.ai('codex').authRequiredSince]).toEqual([false, null]);
    await orch.stop();
    loggedIn.codex = null;
    orch = await start();
    expect([orch.core.ctx.ai('codex').authRequired, orch.core.ctx.ai('codex').authRequiredSince]).toEqual([false, null]);
    await orch.stop();

    // 로그인 확인(true): 푼다
    loggedIn.claude = true;
    orch = await start();
    expect([orch.core.ctx.ai('claude').authRequired, orch.core.ctx.ai('claude').authRequiredSince]).toEqual([false, null]);
    await orch.stop();
  });
});
