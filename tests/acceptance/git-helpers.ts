/**
 * git 그룹 인수 테스트 도우미 (AC-10·11·12·42·45).
 * 서비스 단계(tests/regression/helpers.ts의 boot)와 전체 흐름(tests/e2e/harness.ts) 양쪽에서 쓴다.
 * 제품 코드는 바꾸지 않는다 — 필요한 관찰 지점은 git 서비스 메서드를 감싸서 만든다.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Member, Project, Task } from '@shared/domain';
import { MAIN_AGENT_ID } from '@shared/domain';
import { createRedactor } from '@core/redact';
import { harnessClock } from '../regression/steadyClock';
import { openStore } from '../../src/main/db/store';
import { createGitService } from '../../src/main/git/gitService';
import type { GitService } from '../../src/main/git/types';
import type { TokenIdentity } from '../../src/main/mcp/types';
import type { OrchestratorDeps } from '../../src/main/orchestrator/context';
import { Core } from '../../src/main/orchestrator/core';
import { dataPaths } from '../../src/main/orchestrator/paths';
import type { ProcessRunner } from '../../src/main/process/types';
import { stubAdapter, type Env } from '../regression/helpers';

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitUntil(pred: () => boolean, label = '조건', ms = 30_000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`시간 초과: ${label}`);
    await sleep(15);
  }
}

/** 열어 두었다가 풀어 주는 관문 (경합 강제) */
export function gate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((r) => (release = r));
  return { promise, release };
}

export function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

export function gitOk(cwd: string, args: string[]): boolean {
  try {
    execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

export const samePath = (a: string, b: string) => resolve(a).toLowerCase() === resolve(b).toLowerCase();

// ───────────────────────── 프로젝트·작업 만들기 (서비스 단계) ─────────────────────────

export function project(core: Core, projectId: string): Project {
  return core.ctx.store.projects.require(projectId);
}

export function producerOf(core: Core, projectId: string): Member {
  return core.ctx.store.members.require(project(core, projectId).producerId);
}

/** 두 번째 프로젝트 (같은 Core). 정리는 돌려준 close로 */
export async function addProject(core: Core, name: string, roles: string[] = ['developer']): Promise<{ project: Project; producer: Member; members: Member[]; close: () => void }> {
  const root = mkdtempSync(join(tmpdir(), 'wook-test-acc-p2-'));
  const p = await core.projects.create({ mode: 'new', path: join(root, 'proj'), name, checkCommands: [] }, MAIN_AGENT_ID);
  const members = roles.map((roleId) => core.team.add({ projectId: p.id, roleId }, MAIN_AGENT_ID));
  return {
    project: core.ctx.store.projects.require(p.id),
    producer: core.ctx.store.members.require(p.producerId),
    members,
    close: () => {
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {
        // 윈도우에서 잠긴 파일이 남으면 다음 정리에 맡긴다
      }
    },
  };
}

export function newDirectiveIn(core: Core, projectId: string, title = '인수 지시'): string {
  return core.directives.register({ projectId, title, text: title }, MAIN_AGENT_ID, null).id;
}

/** 이 세션의 대기 항목을 턴이 받아 처리한 것으로 본다 */
export function consumeQueued(core: Core, sessionKey: string): void {
  const ctx = core.ctx;
  for (const q of ctx.store.queue.list({ ref2: sessionKey, state: 'queued' })) ctx.store.queue.put({ ...q, state: 'done', doneAt: ctx.now() });
}

export interface RepoTaskInput {
  projectId: string;
  assignee: Member;
  /** 작업 폴더에 쓸 파일 (상대 경로 → 내용) */
  files: Record<string, string>;
  /** 지울 파일 */
  remove?: string[];
  /** 'main' = 메인 에이전트 대체 검수 (REV-06 v0.6) */
  reviewer?: 'main' | string | null;
  prerequisiteIds?: string[];
  directiveId?: string;
  title?: string;
}

/** 저장소 변경형 작업을 만들고 활성화(worktree)까지 */
export async function activeRepoTask(core: Core, o: Omit<RepoTaskInput, 'files'>): Promise<Task> {
  const directiveId = o.directiveId ?? newDirectiveIn(core, o.projectId);
  const t = core.tasks.create(
    {
      directiveId,
      title: o.title ?? '인수 작업',
      goal: '인수 테스트 작업',
      type: 'development',
      assigneeId: o.assignee.id,
      reviewerId: o.reviewer === 'main' ? MAIN_AGENT_ID : (o.reviewer ?? null),
      acceptanceCriteria: ['동작한다'],
      outputMode: 'repo',
      prerequisiteIds: o.prerequisiteIds,
    },
    project(core, o.projectId).producerId,
  );
  if (!(await core.tasks.activateForLaunch(t.id))) throw new Error(`활성화 실패 ${t.id}`);
  consumeQueued(core, `task:${t.id}`);
  return core.ctx.store.tasks.require(t.id);
}

export function writeFiles(dir: string, files: Record<string, string>, remove: string[] = []): void {
  for (const [f, c] of Object.entries(files)) {
    const abs = join(dir, f);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, c, 'utf8');
  }
  for (const f of remove) rmSync(join(dir, f), { force: true });
}

/** 저장소 변경형 작업: 생성 → 활성화(worktree) → 파일 변경 → 단계 완료(프로그램 커밋) → 제출 처리(최신 main 반영·검사·대상 고정) → 검수 상태 */
export async function submitRepoTask(core: Core, o: RepoTaskInput): Promise<Task> {
  const ctx = core.ctx;
  const t = await activeRepoTask(core, o);
  core.tasks.setSteps(t.id, ['단계 1']);
  writeFiles(t.workspace!.worktreePath, o.files, o.remove);
  await core.tasks.completeStep(t.id, 0, '완료', o.assignee, null);
  core.tasks.requestSubmit(t.id, '제출', o.assignee);
  await core.tasks.processSubmission(t.id);
  const cur = ctx.store.tasks.require(t.id);
  if (cur.state !== 'in_review') throw new Error(`제출 처리 후 검수 상태가 아님: ${t.id} ${cur.state} ${JSON.stringify(cur.hold.reasons.map((r) => r.note))}`);
  return cur;
}

const criteria = (t: Task, pass: boolean) => t.acceptanceCriteria.map((c) => ({ criterion: c, pass, note: pass ? '확인' : '다시' }));

/** 배정된 검수자(팀원 또는 메인 에이전트)로 통과 — 메인 에이전트면 그 검수 턴의 마무리(병합 판단 등록, turns.settleReview)까지 */
export function passBy(core: Core, taskId: string): Task {
  const ctx = core.ctx;
  const t = ctx.store.tasks.require(taskId);
  const reviewer = ctx.store.members.require(t.reviewerId!);
  const passed = core.tasks.submitReview(taskId, reviewer, { verdict: 'pass', criteria: criteria(t, true), reason: '' }, null).task;
  const cur = ctx.store.tasks.require(taskId);
  if (cur.reviewerId === MAIN_AGENT_ID && cur.state === 'in_review' && cur.review.passed && cur.outputMode === 'repo') core.merges.queueMergeDecision(cur);
  return passed;
}

export async function passedRepoTask(core: Core, o: RepoTaskInput): Promise<Task> {
  const t = await submitRepoTask(core, o);
  return passBy(core, t.id);
}

/** 병합·제출 처리가 모두 끝날 때까지 */
export async function settled(core: Core, taskId: string, ms = 30_000): Promise<Task> {
  await sleep(10);
  await waitUntil(() => !core.merges.isPending(taskId) && !core.tasks.isSubmitting(taskId), `${taskId} 처리 끝`, ms);
  await sleep(10);
  return core.ctx.store.tasks.require(taskId);
}

/** 프로듀서 병합 요청 → 처리 끝까지 */
export async function mergeBy(core: Core, taskId: string, requestId: string | null = null): Promise<Task> {
  const t = core.ctx.store.tasks.require(taskId);
  core.merges.requestMerge(taskId, producerOf(core, t.projectId), requestId);
  return settled(core, taskId);
}

/** 검수 → 병합 → (기준 main이 바뀌었으면 재검사·재검수) → 완료까지 대표·프로듀서 쪽 조작을 대신한다 */
export async function driveToDone(core: Core, taskId: string, ms = 45_000): Promise<Task> {
  const deadline = Date.now() + ms;
  for (;;) {
    const t = await settled(core, taskId);
    if (t.state === 'done') return t;
    if (Date.now() > deadline) throw new Error(`완료되지 않음 ${taskId}: ${t.state} ${t.hold.reasons.map((r) => `${r.kind}:${r.note}`).join(' / ')}`);
    if (t.state === 'in_review' && !t.review.passed) passBy(core, taskId);
    else if (t.state === 'in_review') await mergeBy(core, taskId);
    else if (t.state === 'in_progress' && t.pendingSubmit) await core.tasks.processSubmission(taskId);
    else throw new Error(`진행할 수 없는 상태 ${taskId}: ${t.state} ${t.hold.reasons.map((r) => `${r.kind}:${r.note}`).join(' / ')}`);
  }
}

// ───────────────────────── git 관찰 ─────────────────────────

export function mainSha(core: Core, projectId: string): string {
  const p = project(core, projectId);
  return git(p.path, ['rev-parse', `refs/heads/${p.baseBranch}`]);
}

/** main의 이 작업 병합 커밋 수 */
export function mergeCommitsFor(repo: string, branch: string, taskId: string): number {
  const log = git(repo, ['log', '--merges', '--format=%s', `refs/heads/${branch}`]);
  return log.split(/\r?\n/).filter((l) => l.startsWith(`[${taskId}] 병합`)).length;
}

export function fileAt(repo: string, rev: string, path: string): string | null {
  try {
    return execFileSync('git', ['-C', repo, 'show', `${rev}:${path}`], { encoding: 'utf8', stdio: 'pipe' });
  } catch {
    return null;
  }
}

export function parentsOf(repo: string, sha: string): string[] {
  return git(repo, ['rev-list', '--parents', '-n', '1', sha]).split(/\s+/).slice(1);
}

/** 두 커밋 사이에 바뀐 파일 (상태\t경로) */
export function changedFiles(repo: string, from: string, to: string): string[] {
  return git(repo, ['diff', '--name-status', '--no-renames', from, to]).split(/\r?\n/).filter(Boolean).sort();
}

export function treeFiles(repo: string, rev: string): string[] {
  return git(repo, ['ls-tree', '-r', '--name-only', rev]).split(/\r?\n/).filter(Boolean);
}

/**
 * main이 과거로 강제 이동한 적이 없는지: 브랜치 reflog(모든 이동 기록)에서 각 값이 다음 값의 조상이어야 한다 (7.1 선택 되돌리기)
 */
export function baseMovedOnlyForward(repo: string, branch: string): { ok: boolean; moves: number; detail: string } {
  const shas = git(repo, ['reflog', 'show', '--format=%H', `refs/heads/${branch}`]).split(/\r?\n/).filter(Boolean).reverse();
  for (let i = 1; i < shas.length; i++) {
    if (!gitOk(repo, ['merge-base', '--is-ancestor', shas[i - 1]!, shas[i]!])) {
      return { ok: false, moves: shas.length - 1, detail: `${shas[i - 1]!.slice(0, 8)} → ${shas[i]!.slice(0, 8)} (조상 아님)` };
    }
  }
  return { ok: true, moves: shas.length - 1, detail: '' };
}

// ───────────────────────── git 서비스 감싸기 ─────────────────────────

export interface MainChangeEvent {
  repo: string;
  phase: 'in' | 'out';
  at: number;
  holder: string | null;
  label: string;
  /** 'merge' = mergeIntoBase(main 이동), 'sync' = syncCheckedOutBase(체크아웃된 프로젝트 폴더를 main에 맞춤) */
  op: 'merge' | 'sync';
}

/**
 * main을 바꾸는 구간(mergeIntoBase)과 프로젝트 폴더를 main에 맞추는 구간(syncCheckedOutBase)을 기록한다.
 * hold(repo)가 약속을 돌려주면 그 병합 구간 안에서 기다린다 (경합 강제)
 */
export function watchMainChanges(
  g: GitService,
  holderOf: (repo: string) => string | null,
  hold?: (repo: string, message: string) => Promise<void> | null,
): MainChangeEvent[] {
  const events: MainChangeEvent[] = [];
  const origMerge = g.mergeIntoBase.bind(g);
  g.mergeIntoBase = async (repo, o) => {
    const label = o.message.split('\n')[0] ?? '';
    events.push({ repo, phase: 'in', at: Date.now(), holder: holderOf(repo), label, op: 'merge' });
    try {
      const wait = hold?.(repo, o.message);
      if (wait) await wait;
      return await origMerge(repo, o);
    } finally {
      events.push({ repo, phase: 'out', at: Date.now(), holder: holderOf(repo), label, op: 'merge' });
    }
  };
  const origSync = g.syncCheckedOutBase.bind(g);
  g.syncCheckedOutBase = async (repo, base, oldSha, newSha) => {
    const label = `sync ${oldSha.slice(0, 8)}→${newSha.slice(0, 8)}`;
    events.push({ repo, phase: 'in', at: Date.now(), holder: holderOf(repo), label, op: 'sync' });
    try {
      return await origSync(repo, base, oldSha, newSha);
    } finally {
      events.push({ repo, phase: 'out', at: Date.now(), holder: holderOf(repo), label, op: 'sync' });
    }
  };
  return events;
}

/** 같은 저장소 안에서 겹친 main 변경 구간의 최대 수 */
export function maxOverlap(events: MainChangeEvent[], repo: string): number {
  let cur = 0;
  let max = 0;
  for (const e of events) {
    if (!samePath(e.repo, repo)) continue;
    cur += e.phase === 'in' ? 1 : -1;
    max = Math.max(max, cur);
  }
  return max;
}

// ───────────────────────── 앱 도구 신원·호출 ─────────────────────────

export function identityOf(m: Member, sessionKey: string, o: Partial<TokenIdentity> = {}): TokenIdentity {
  const kind = sessionKey.startsWith('task:')
    ? 'task'
    : sessionKey.startsWith('review:')
      ? 'review'
      : sessionKey.startsWith('directive:')
        ? 'directive'
        : sessionKey === 'main:general'
          ? 'main_general'
          : 'main_project';
  return {
    turnId: `TN-acc-${m.id}-${Math.random().toString(36).slice(2, 8)}`,
    sessionId: `S-acc-${m.id}`,
    sessionKey,
    sessionKind: kind,
    memberId: m.id,
    projectId: m.projectId,
    isMain: m.isMain,
    isProducer: m.isProducer,
    canReview: m.isProducer || m.roleId === 'qa' || m.roleId === 'architect',
    ...o,
  };
}

/** 실제 앱 도구 서버(HTTP·MCP)로 tools/call 한 번 */
export async function mcpCall(
  url: string,
  token: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; code: string; message: string }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }),
  });
  const body = (await res.json()) as { result?: { isError?: boolean; content?: { text: string }[] }; error?: { message: string } };
  if (!body.result) return { ok: false, code: `http_${res.status}`, message: body.error?.message ?? '' };
  const parsed = JSON.parse(body.result.content?.[0]?.text ?? '{}') as Record<string, unknown>;
  if (body.result.isError) return { ok: false, code: String(parsed.error), message: String(parsed.message) };
  return { ok: true, data: parsed };
}

// ───────────────────────── 서비스 단계 재시작 ─────────────────────────

const noRunner: ProcessRunner = {
  mode: process.platform === 'win32' ? 'taskkill' : 'pgroup',
  detail: '인수 테스트: 러너 없음',
  start() {
    throw new Error('인수 테스트: 이 테스트는 프로세스를 띄우지 않습니다');
  },
  isAlive: async () => false,
  processCreatedAt: async () => new Map(),
  killTree: async () => ({ ok: true, remaining: 0, detail: '', durationMs: 0 }),
};

/**
 * 서비스 단계 앱 재시작: 이전 Core를 닫고(DB 닫기, 폴더는 그대로) 같은 데이터 폴더·DB로 새 Core를 만든 뒤
 * 앱 시작 때와 같은 재시작 복구(recovery.run)를 돌린다. 메모리 상태(처리 중 요청 목록·잠금)는 모두 새로 시작한다.
 * 돌려준 Env의 close()가 두 폴더를 지운다 (이전 Env의 close는 부르지 않는다)
 */
export async function restartServices(prev: Env): Promise<Env> {
  await prev.core.checks.terminateFor(() => true);
  await prev.core.turns.stopAll('인수 테스트 재시작');
  prev.ctx.bus.dispose();
  prev.ctx.store.close();
  const store = openStore(dataPaths(prev.dataDir).db);
  const errors: string[] = [];
  const deps = {
    dataDir: prev.dataDir,
    appRoot: process.cwd(),
    isPackaged: false,
    store,
    // 뒤로 가지 않는 벽시계 — 다른 하네스와 같다 (리드 결정 S10-10.2·S10-12, regression/steadyClock.ts)
    clock: harnessClock,
    git: createGitService(),
    runner: noRunner,
    adapters: { claude: stubAdapter('claude'), codex: stubAdapter('codex'), mock: stubAdapter('mock') },
    createToolServer: () => {
      throw new Error('인수 테스트: 앱 도구 서버를 띄우지 않습니다');
    },
    secrets: { get: async () => null, set: async () => undefined, delete: async () => undefined },
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
  core.team.ensureMainAgent();
  await core.recovery.run();
  const projRoot = resolve(prev.projectDir, '..');
  return {
    core,
    ctx,
    dataDir: prev.dataDir,
    projectDir: prev.projectDir,
    project: ctx.store.projects.require(prev.project.id),
    producer: ctx.store.members.require(prev.producer.id),
    members: prev.members.map((m) => ctx.store.members.require(m.id)),
    errors,
    async close() {
      await core.checks.terminateFor(() => true);
      await core.turns.stopAll('테스트 종료');
      ctx.bus.dispose();
      store.close();
      for (const d of [prev.dataDir, projRoot]) {
        try {
          rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        } catch {
          // 윈도우에서 잠긴 파일이 남으면 다음 정리에 맡긴다
        }
      }
    },
  };
}
