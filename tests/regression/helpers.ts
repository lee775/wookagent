/**
 * 회귀 테스트 하네스: 실제 저장소(SQLite)·git·(필요하면) 실제 프로세스 러너로 오케스트레이터 서비스(Core)를 띄운다.
 * 스케줄러·앱 도구 서버·CLI(모의 에이전트 포함)는 띄우지 않는다 — 턴 없이 서비스 경계를 직접 몰아 결과를 확인한다.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Member, OutputMode, Project, Task, TaskType } from '@shared/domain';
import { MAIN_AGENT_ID } from '@shared/domain';
import { createRedactor } from '@core/redact';
import { harnessClock } from './steadyClock';
import { openStore } from '../../src/main/db/store';
import { createGitService } from '../../src/main/git/gitService';
import { createProcessRunner } from '../../src/main/process/processRunner';
import type { ProcessRunner } from '../../src/main/process/types';
import type { AgentAdapter } from '../../src/main/agents/types';
import type { OrchestratorDeps } from '../../src/main/orchestrator/context';
import { Core } from '../../src/main/orchestrator/core';
import { defaultRoles } from '../../src/main/orchestrator/defaults';
import { dataPaths } from '../../src/main/orchestrator/paths';

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(pred: () => boolean, label = '조건', ms = 30_000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`시간 초과: ${label}`);
    await sleep(20);
  }
}

export function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

/** CLI를 띄우지 않는 어댑터. prepare를 넘기면 그걸 쓴다 */
export function stubAdapter(kind: 'claude' | 'codex' | 'mock', prepare?: AgentAdapter['prepare']): AgentAdapter {
  return {
    kind,
    detect: async () => ({ installed: true, path: null, version: 'stub', loggedIn: true, problem: null, detail: 'stub' }),
    prepare:
      prepare ??
      (async () => {
        throw new Error('회귀 테스트: CLI를 띄우지 않습니다');
      }),
    createParser: () => ({ pushLine: () => [], pushStderr: () => [], finish: () => [] }),
  };
}

const noRunner: ProcessRunner = {
  mode: process.platform === 'win32' ? 'taskkill' : 'pgroup',
  detail: '회귀 테스트: 러너 없음',
  start() {
    throw new Error('회귀 테스트: 이 테스트는 프로세스를 띄우지 않습니다');
  },
  isAlive: async () => false,
  processCreatedAt: async () => new Map(),
  killTree: async () => ({ ok: true, remaining: 0, detail: '', durationMs: 0 }),
};

export interface BootOptions {
  /** 실제 프로세스 러너 (자동 검사 실행) */
  runner?: boolean;
  checkCommands?: string[];
  team?: ('developer' | 'qa')[];
  adapters?: Partial<Record<'claude' | 'codex' | 'mock', AgentAdapter>>;
}

export interface Env {
  core: Core;
  ctx: Core['ctx'];
  dataDir: string;
  projectDir: string;
  project: Project;
  producer: Member;
  members: Member[];
  errors: string[];
  close(): Promise<void>;
}

export async function boot(o: BootOptions = {}): Promise<Env> {
  const dataDir = mkdtempSync(join(tmpdir(), 'wook-test-reg-data-'));
  const projRoot = mkdtempSync(join(tmpdir(), 'wook-test-reg-proj-'));
  const projectDir = join(projRoot, 'proj');
  const store = openStore(dataPaths(dataDir).db);
  const runner = o.runner ? await createProcessRunner({ dataDir, forceMode: process.platform === 'win32' ? 'taskkill' : 'pgroup' }) : noRunner;
  const errors: string[] = [];
  const deps = {
    dataDir,
    appRoot: process.cwd(),
    isPackaged: false,
    store,
    // 뒤로 가지 않는 벽시계 (리드 결정 S10-10.2, ./steadyClock.ts)
    clock: harnessClock,
    git: createGitService(),
    runner,
    adapters: { claude: o.adapters?.claude ?? stubAdapter('claude'), codex: o.adapters?.codex ?? stubAdapter('codex'), mock: o.adapters?.mock ?? stubAdapter('mock') },
    createToolServer: () => {
      throw new Error('회귀 테스트: 앱 도구 서버를 띄우지 않습니다');
    },
    secrets: {
      get: async () => null,
      set: async () => undefined,
      delete: async () => undefined,
    },
    redactor: createRedactor(),
    shell: null,
    logger: (level: string, msg: string, extra?: unknown) => {
      if (level === 'error') errors.push(`${msg}${extra instanceof Error ? ` :: ${extra.message}` : ''}`);
    },
    timing: { watchdogMs: 200, snapshotThrottleMs: 20 },
  } as unknown as OrchestratorDeps;
  const core = new Core(deps);
  const ctx = core.ctx;
  for (const dir of Object.values(ctx.paths)) if (!dir.endsWith('.db')) mkdirSync(dir, { recursive: true });
  for (const r of defaultRoles(ctx.now())) ctx.store.roles.insert(r);
  ctx.saveSettings(ctx.settings());
  core.team.ensureMainAgent();
  core.memory.ensure(null, '일반');
  const project = await core.projects.create({ mode: 'new', path: projectDir, name: '회귀', checkCommands: o.checkCommands ?? [] }, MAIN_AGENT_ID);
  const members = (o.team ?? ['developer']).map((roleId) => core.team.add({ projectId: project.id, roleId }, MAIN_AGENT_ID));
  const producer = ctx.store.members.require(project.producerId);
  return {
    core,
    ctx,
    dataDir,
    projectDir,
    project: ctx.store.projects.require(project.id),
    producer,
    members,
    errors,
    async close() {
      await core.checks.terminateFor(() => true);
      await core.turns.stopAll('테스트 종료');
      ctx.bus.dispose();
      store.close();
      for (const d of [dataDir, projRoot]) {
        try {
          rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        } catch {
          // 윈도우에서 잠긴 파일이 남으면 다음 정리에 맡긴다
        }
      }
    },
  };
}

export function newDirective(env: Env, title = '회귀 지시'): string {
  return env.core.directives.register({ projectId: env.project.id, title, text: title }, MAIN_AGENT_ID, null).id;
}

export function newTask(
  env: Env,
  /** reviewer 'main' = 메인 에이전트 대체 검수 (REV-06 v0.6). 대표 검수('owner')는 없다 — 넘기면 검수자 결정이 invalid로 거부한다 */
  o: { directiveId?: string; assignee?: Member; reviewer?: 'main' | string | null; type?: TaskType; outputMode?: OutputMode; title?: string; prerequisiteIds?: string[] } = {},
): Task {
  const directiveId = o.directiveId ?? newDirective(env);
  return env.core.tasks.create(
    {
      directiveId,
      title: o.title ?? '회귀 작업',
      goal: '회귀 테스트 작업',
      type: o.type ?? 'development',
      assigneeId: (o.assignee ?? env.members[0]!).id,
      reviewerId: o.reviewer === 'main' ? MAIN_AGENT_ID : (o.reviewer ?? null),
      acceptanceCriteria: ['동작한다'],
      outputMode: o.outputMode ?? 'repo',
      prerequisiteIds: o.prerequisiteIds,
    },
    env.producer.id,
  );
}

/** 팀원 턴이 이 세션의 대기 항목을 받아 처리한 것으로 본다 (턴 종료 시 finish()가 하는 일) */
export function consumeQueued(env: Env, sessionKey: string): void {
  for (const q of env.ctx.store.queue.list({ ref2: sessionKey, state: 'queued' })) env.ctx.store.queue.put({ ...q, state: 'done', doneAt: env.ctx.now() });
}

/** 활성화 (작업 카드는 첫 턴이 받은 것으로 본다) */
export async function activate(env: Env, taskId: string): Promise<Task> {
  if (!(await env.core.tasks.activateForLaunch(taskId))) throw new Error('활성화 실패');
  consumeQueued(env, `task:${taskId}`);
  return env.ctx.store.tasks.require(taskId);
}

/** 작업 활성화 → (변경이 있으면 파일 쓰기) → 단계 완료 → 제출 처리까지. 검수 상태가 된 작업을 돌려준다 */
export async function submittedTask(env: Env, o: Parameters<typeof newTask>[1] & { file?: string | null; content?: string } = {}): Promise<Task> {
  const { core, ctx } = env;
  const t = newTask(env, o);
  await activate(env, t.id);
  core.tasks.setSteps(t.id, ['단계 1']);
  const assignee = ctx.store.members.require(t.assigneeId);
  const ws = ctx.store.tasks.require(t.id).workspace!;
  const file = o.file === undefined ? `${t.id}.txt` : o.file;
  if (file) writeFileSync(join(ws.worktreePath, file), o.content ?? `${t.id} 변경\n`, 'utf8');
  await core.tasks.completeStep(t.id, 0, '완료', assignee, null);
  core.tasks.requestSubmit(t.id, '제출', assignee);
  await core.tasks.processSubmission(t.id);
  const cur = ctx.store.tasks.require(t.id);
  if (cur.state !== 'in_review') throw new Error(`제출 처리 후 검수 상태가 아님: ${cur.state} ${JSON.stringify(cur.hold.reasons.map((r) => r.note))}`);
  return cur;
}

const PASS = (t: Task) => ({ verdict: 'pass' as const, criteria: t.acceptanceCriteria.map((c) => ({ criterion: c, pass: true, note: '확인' })), reason: '' });
const REJECT = (t: Task) => ({ verdict: 'reject' as const, criteria: t.acceptanceCriteria.map((c) => ({ criterion: c, pass: false, note: '다시' })), reason: '다시 확인' });

/**
 * 메인 에이전트 검수 턴의 마무리 — 통과한 저장소 변경형 작업의 병합 판단을 프로듀서에게 넣는다 (turns.settleReview가 검수 턴이 끝날 때 하는 일).
 * 서비스 경계 시험은 검수 턴 없이 판정하므로 메인 대체 검수(REV-06 v0.6 — 옛 대표 검수 자리)의 통과 뒤에 이것까지 한다
 */
export function settleMainReview(env: { core: Env['core'] }, taskId: string): void {
  const t = env.core.ctx.store.tasks.require(taskId);
  if (t.reviewerId === MAIN_AGENT_ID && t.state === 'in_review' && t.review.passed && t.outputMode === 'repo') env.core.merges.queueMergeDecision(t);
}

/** 지정된 검수자(팀원 또는 메인 에이전트)로 통과 — 메인 에이전트면 그 검수 턴의 마무리(병합 판단 등록)까지 */
export function pass(env: Env, taskId: string): Task {
  const t = env.ctx.store.tasks.require(taskId);
  const reviewer = env.ctx.store.members.require(t.reviewerId!);
  const passed = env.core.tasks.submitReview(taskId, reviewer, PASS(t), null).task;
  settleMainReview(env, taskId);
  return passed;
}

export function reject(env: Env, taskId: string) {
  const t = env.ctx.store.tasks.require(taskId);
  const reviewer = env.ctx.store.members.require(t.reviewerId!);
  return env.core.tasks.submitReview(taskId, reviewer, REJECT(t), null);
}

export async function passedTask(env: Env, o: Parameters<typeof submittedTask>[1] = {}): Promise<Task> {
  const t = await submittedTask(env, o);
  return pass(env, t.id);
}

/** 프로듀서 턴이 병합 판단 항목을 받아 처리한 것으로 본다 (턴 종료 시 finish()가 하는 일) */
export function consumeMergeDecisions(env: Env, taskId: string): void {
  for (const q of env.ctx.store.queue.list({ state: 'queued' })) {
    if (q.kind === 'merge_decision' && q.taskId === taskId) env.ctx.store.queue.put({ ...q, state: 'done', doneAt: env.ctx.now() });
  }
}

/** 병합 요청 후 처리(잠금 안 + 잠금 뒤 재제출 시작)가 끝날 때까지 */
export async function mergeAndSettle(env: Env, taskId: string): Promise<Task> {
  consumeMergeDecisions(env, taskId);
  const r = env.core.merges.requestMerge(taskId, env.ctx.store.members.require(env.project.producerId), null);
  if (r.status === 'queued') await waitFor(() => !env.core.merges.isPending(taskId), '병합 처리');
  await sleep(20);
  return env.ctx.store.tasks.require(taskId);
}

export function mainSha(env: Env): string {
  return git(env.projectDir, ['rev-parse', `refs/heads/${env.project.baseBranch}`]);
}

/** main에 있는 이 작업의 병합 커밋 수 */
export function mergeCommitsFor(env: Env, taskId: string): number {
  const log = git(env.projectDir, ['log', '--merges', '--format=%s', `refs/heads/${env.project.baseBranch}`]);
  return log.split(/\r?\n/).filter((l) => l.startsWith(`[${taskId}] 병합`)).length;
}

export function queued(env: Env, pred: (q: { kind: string; taskId: string | null; sessionKey: string; directiveId: string | null; questionId: string | null }) => boolean) {
  return env.ctx.store.queue.list({ state: 'queued' }).filter(pred);
}

export function notices(env: Env, title: string) {
  return env.ctx.store.notifications.list().filter((n) => n.title === title);
}

/** 프로젝트 폴더(main 체크아웃)에 직접 커밋 — 다른 작업이 main을 바꾼 상황 */
export function commitOnMain(env: Env, file: string, content: string): string {
  writeFileSync(join(env.projectDir, file), content, 'utf8');
  git(env.projectDir, ['add', file]);
  git(env.projectDir, ['-c', 'user.name=other', '-c', 'user.email=o@o', 'commit', '-q', '-m', `main: ${file}`]);
  return mainSha(env);
}
