/**
 * Codex 팀원 실행의 개인 설정 격리와 모델·노력치 (windows:F1·F7, CLI-04·18·21, 19.1).
 * - 팀원 Codex 턴은 대표 개인 config.toml·훅·내장 연결 서버를 쓰지 않는다 (--ignore-user-config --disable hooks --disable apps)
 * - 그래서 모델을 정하지 않은 Codex 팀원은 운영 설정 모델 목록 첫 항목으로 실행하고, 화면·list_ai_options도 같은 값을 보여 준다
 * - 노력치는 설치된 모델이 받는 값만 (none·minimal 없음, max 있음). 예전에 저장된 none·minimal은 읽을 때 low로
 * 실제 턴 실행기와 실제 Codex 어댑터(prepare)를 쓰고, CLI 프로세스만 가짜로 둔다.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { Settings } from '@shared/domain';
import { MAIN_AGENT_ID } from '@shared/domain';
import { CODEX_ISOLATION_ARGS, createCodexAdapter } from '../../src/main/agents/codexAdapter';
import type { AppToolServer, TokenIdentity } from '../../src/main/mcp/types';
import type { ExitInfo, ManagedProcess, RunSpec, TerminateResult } from '../../src/main/process/types';
import { createApi } from '../../src/main/orchestrator/api';
import type { Env } from './helpers';
import { boot, newTask, waitFor } from './helpers';

let env: Env | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

/** CLI 대신: thread.started → turn.completed를 내고 정상 종료 */
class FakeCodex implements ManagedProcess {
  private static next = 81_000;
  readonly pid = FakeCodex.next++;
  readonly childPid = Promise.resolve(null);
  private readonly outs: ((l: string) => void)[] = [];
  private resolveExit!: (e: ExitInfo) => void;
  readonly exited = new Promise<ExitInfo>((r) => (this.resolveExit = r));
  constructor(threadId: string) {
    setTimeout(() => {
      for (const l of [`{"type":"thread.started","thread_id":"${threadId}"}`, '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}']) for (const cb of this.outs) cb(l);
      this.resolveExit({ code: 0, signal: null, leftoverKilled: 0, remaining: 0, durationMs: 1, terminated: false });
    }, 5);
  }
  onStdoutLine(cb: (l: string) => void): void {
    this.outs.push(cb);
  }
  onStderrLine(): void {
    // 가짜 CLI는 표준 오류를 쓰지 않는다
  }
  async terminate(): Promise<TerminateResult> {
    return { ok: true, remaining: 0, detail: '가짜', durationMs: 0 };
  }
}

/** 실제 Codex 어댑터로 팀원 턴을 띄울 수 있는 환경. CLI 프로세스 대신 실행 값(RunSpec)을 기록한다 */
async function bootCodex(): Promise<{ e: Env; specs: RunSpec[] }> {
  const codex = createCodexAdapter({
    resolveExecutable: async () => ({ kind: 'codex', path: 'C:\\fake\\codex.exe', source: 'path', npmPackageRoot: null, note: '' }),
    baseEnv: () => ({ PATH: process.env.PATH }),
  });
  env = await boot({ team: ['developer', 'qa'], adapters: { codex } });
  const e = env;
  e.core.toolServer = {
    url: 'http://127.0.0.1:9/mcp',
    start: async () => ({ url: 'http://127.0.0.1:9/mcp', port: 9 }),
    stop: async () => undefined,
    issueToken: () => `tok-${randomUUID()}`,
    revokeToken: () => undefined,
    revokeTurn: () => undefined,
  } satisfies AppToolServer;
  const specs: RunSpec[] = [];
  const thread = randomUUID();
  e.ctx.deps.runner = {
    mode: 'pgroup',
    detail: '기록용',
    start(spec) {
      specs.push(spec);
      return new FakeCodex(thread);
    },
    isAlive: async () => false,
    processCreatedAt: async () => new Map(),
    killTree: async () => ({ ok: true, remaining: 0, detail: '', durationMs: 0 }),
  };
  e.core.started = true; // 스케줄러는 테스트가 tick()으로 한 번씩
  return { e, specs };
}

const mainIdentity: TokenIdentity = {
  turnId: 'TN-main-test',
  sessionId: 'S-main-test',
  sessionKey: 'main:general',
  sessionKind: 'main_general',
  memberId: MAIN_AGENT_ID,
  projectId: null,
  isMain: true,
  isProducer: false,
  canReview: false,
};

const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

describe('Codex 팀원 실행은 대표 개인 설정과 떨어져 있고, 정하지 않은 모델은 목록 첫 모델 (windows:F1)', () => {
  it('첫 턴: 개인 config·훅·내장 연결 서버를 끄고 -m <목록 첫 모델>로 실행, 세션에 그 값을 고정한다', async () => {
    const { e, specs } = await bootCodex();
    const dev = e.members[0]!;
    expect(dev.ai).toMatchObject({ kind: 'codex', model: null });
    const t = newTask(e);
    e.core.scheduler.tick();
    await waitFor(() => specs.length === 1, 'Codex 첫 턴');
    await waitFor(() => e.core.turns.count() === 0, '턴 종료');
    const args = specs[0]!.args;
    expect(args.slice(0, 1)).toEqual(['exec']);
    const i = args.indexOf('--ignore-user-config');
    expect(args.slice(i, i + CODEX_ISOLATION_ARGS.length)).toEqual([...CODEX_ISOLATION_ARGS]);
    expect(after(args, '-m')).toBe('gpt-6-sol');
    expect(args).toContain('model_reasoning_effort="medium"');
    // 설정은 그대로 '정하지 않음', 세션에는 실제로 넘긴 값을 고정 (19.1, F9)
    expect(e.ctx.store.members.require(dev.id).ai.model).toBeNull();
    const session = e.ctx.store.sessions.list({ ref2: `task:${t.id}` })[0]!;
    expect(session).toMatchObject({ model: 'gpt-6-sol', effort: 'medium' });
  });

  it('이어하기: 예전에 모델 null·노력치 minimal로 고정된 세션도 지금 실행할 수 있는 값(목록 첫 모델·low)으로 이어 간다 (windows:F1·F7)', async () => {
    const { e, specs } = await bootCodex();
    const t = newTask(e);
    e.core.scheduler.tick();
    await waitFor(() => specs.length === 1, 'Codex 첫 턴');
    await waitFor(() => e.core.turns.count() === 0, '턴 종료');
    const session = e.ctx.store.sessions.list({ ref2: `task:${t.id}` })[0]!;
    // 이 수정 전 기록: config.toml의 기본 모델을 뜻하던 null, 이제 없는 노력치 값
    e.ctx.store.sessions.patch(session.id, { model: null, effort: 'minimal' });
    e.core.tasks.continueWork(t.id, '계속 진행하세요', 'task_work');
    e.core.scheduler.tick();
    await waitFor(() => specs.length === 2, 'Codex 이어하기');
    await waitFor(() => e.core.turns.count() === 0, '턴 종료');
    const args = specs[1]!.args;
    expect(args.slice(0, 2)).toEqual(['exec', 'resume']);
    expect(args).toContain('--ignore-user-config');
    expect(after(args, '-m')).toBe('gpt-6-sol');
    expect(args).toContain('model_reasoning_effort="low"');
    expect(args.at(-2)).toBe(session.cliSessionId ?? e.ctx.store.sessions.require(session.id).cliSessionId);
  });

  it('list_ai_options·팀원 화면은 실제로 넘기는 모델을 보여 준다 (설정값 null은 그대로)', async () => {
    const { e } = await bootCodex();
    const [dev, qa] = e.members;
    const r = await e.core.tools.handle(mainIdentity, 'list_ai_options', {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const data = r.data as { defaultModels: Record<string, string | null>; members: { memberId: string; ai: { model: string | null }; model: string | null; effort: string }[] };
    expect(data.defaultModels).toEqual({ claude: null, codex: 'gpt-6-sol' });
    expect(data.members.find((m) => m.memberId === dev!.id)).toMatchObject({ ai: { model: null }, model: 'gpt-6-sol', effort: 'medium' });
    expect(data.members.find((m) => m.memberId === qa!.id)).toMatchObject({ ai: { model: null }, model: null });
    const views = e.core.views.snapshot().members;
    expect(views.find((m) => m.id === dev!.id)?.ai).toMatchObject({ model: null, modelValue: 'gpt-6-sol', effortValue: 'medium' });
    expect(views.find((m) => m.id === qa!.id)?.ai).toMatchObject({ model: null, modelValue: null });
  });
});

describe('Codex 노력치는 설치된 모델 목록이 받는 값만 (windows:F7)', () => {
  it('메인 에이전트: minimal·none·ultra는 저장 전에 거부, max는 받아서 다음 턴에 그대로 넘긴다', async () => {
    const { e, specs } = await bootCodex();
    const dev = e.members[0]!;
    for (const bad of ['minimal', 'none', 'ultra']) {
      const r = await e.core.tools.handle(mainIdentity, 'set_member_ai', { member_id: dev.id, effort: bad, reason: '시험' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toContain('low|medium|high|xhigh|max');
    }
    const ok = await e.core.tools.handle(mainIdentity, 'set_member_ai', { member_id: dev.id, effort: 'max', reason: '어려운 디버깅' });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.data).toMatchObject({ model: 'gpt-6-sol', effort: 'max' });
    newTask(e);
    e.core.scheduler.tick();
    await waitFor(() => specs.length === 1, 'Codex 첫 턴');
    await waitFor(() => e.core.turns.count() === 0, '턴 종료');
    expect(specs[0]!.args).toContain('model_reasoning_effort="max"');
  });

  it('운영 설정: 새 minimal 연결은 거부하고, 예전에 저장된 none·minimal은 읽을 때 low로 바꿔 다른 설정 저장을 막지 않는다', async () => {
    const { e } = await bootCodex();
    const api = createApi(e.core);
    expect(() => api['settings.update']({ team: { effortMapping: { codex: { low: 'minimal' } } } })).toThrow(/low\|medium\|high\|xhigh\|max/);

    // 이 수정 전에 저장된 설정 (설정 화면이 minimal을 보여 줬다) → 앱 재시작 = 설정을 다시 읽음
    const saved = e.ctx.store.kv.get<Settings>('settings')!;
    e.ctx.store.kv.set('settings', {
      ...saved,
      general: { ...saved.general, mainAgent: { kind: 'codex', model: null, effortTier: 'low', effortOverride: 'none' } },
      team: { ...saved.team, effortMapping: { ...saved.team.effortMapping, codex: { high: 'xhigh', normal: 'medium', low: 'minimal' } } },
    });
    Reflect.set(e.ctx, 'settingsCache', null);
    expect(e.ctx.settings().team.effortMapping.codex).toEqual({ high: 'xhigh', normal: 'medium', low: 'low' });
    expect(e.ctx.settings().general.mainAgent.effortOverride).toBe('low');
    const next = api['settings.update']({ execution: { maxConcurrent: 4 } }) as Settings;
    expect(next.execution.maxConcurrent).toBe(4);
    expect(e.ctx.store.kv.get<Settings>('settings')!.team.effortMapping.codex.low).toBe('low');

    // 예전에 저장된 팀원 직접 값도 실행·화면에서는 low
    const dev = e.ctx.store.members.require(e.members[0]!.id);
    e.ctx.store.members.put({ ...dev, ai: { ...dev.ai, effortOverride: 'minimal' } });
    expect(e.core.team.effortValue(e.ctx.store.members.require(dev.id).ai)).toBe('low');
    expect(e.core.views.snapshot().members.find((m) => m.id === dev.id)?.ai.effortValue).toBe('low');
  });
});
