/**
 * 완료 기준(AC) 검수 그룹 도우미 — AC-09·38·39·43·47.
 * 회귀 하네스(boot: 서비스+실제 git, bootOrch: 실제 오케스트레이터+가짜 CLI)와 통합 하네스(createHarness: 실제 모의 에이전트) 위에서
 * 팀원·메인 에이전트가 하는 일(단계 완료·제출·검수 판정·재작업)을 짧게 쓰기 위한 것만 둔다. 제품 코드는 바꾸지 않는다.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Member, Task } from '@shared/domain';
import type { TokenIdentity, ToolCallResult } from '../../src/main/mcp/types';
import { artifactWorkDir } from '../../src/main/orchestrator/paths';
import type { Env } from '../regression/helpers';
import type { OrchEnv } from '../regression/orchHarness';
import { seedDirective } from '../regression/orchHarness';

type AnyEnv = Env | OrchEnv;

export function gitIn(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

/** 앱 도구 처리기 신원 (토큰 서버가 확인해 넘기는 호출자). 세션 키로 종류를 정한다 */
export function identityOf(e: AnyEnv, m: Member, sessionKey: string, turnId = `TN-acc-${m.id}`): TokenIdentity {
  const role = e.ctx.store.roles.get(m.roleId);
  const prefix = sessionKey.split(':')[0];
  const sessionKind = (prefix === 'main' ? (sessionKey === 'main:general' ? 'main_general' : 'main_project') : prefix) as TokenIdentity['sessionKind'];
  return {
    turnId,
    sessionId: `S-acc-${m.id}`,
    sessionKey,
    sessionKind,
    memberId: m.id,
    projectId: m.projectId,
    isMain: m.isMain,
    isProducer: m.isProducer,
    canReview: !!role?.canReview || m.isProducer,
  };
}

export function member(e: AnyEnv, id: string): Member {
  return e.ctx.store.members.require(id);
}

export function task(e: AnyEnv, id: string): Task {
  return e.ctx.store.tasks.require(id);
}

/** submit_review 도구 인자 (완료 조건마다 판정) */
export function verdictArgs(t: Task, verdict: 'pass' | 'reject', reason = '', requestId?: string): Record<string, unknown> {
  return {
    task_id: t.id,
    verdict,
    criteria: t.acceptanceCriteria.map((c, i) => ({ criterion: c, pass: verdict === 'pass' || i !== 0, note: verdict === 'pass' || i !== 0 ? '확인함' : reason || '부족함' })),
    reason: verdict === 'reject' ? reason || '첫 완료 조건을 만족하지 않습니다' : '',
    ...(requestId ? { request_id: requestId } : {}),
  };
}

export async function callTool(e: AnyEnv, who: TokenIdentity, tool: string, args: Record<string, unknown>): Promise<ToolCallResult> {
  return e.core.tools.handle(who, tool, args);
}

/** 이 세션의 대기 항목을 턴이 받아 처리한 것으로 본다 (스케줄러가 엉뚱한 턴을 띄우지 않게) */
export function consumeQueued(e: AnyEnv, sessionKey: string): void {
  for (const q of e.ctx.store.queue.list({ ref2: sessionKey, state: 'queued' })) e.ctx.store.queue.put({ ...q, state: 'done', doneAt: e.ctx.now() });
}

export function queuedFor(e: AnyEnv, pred: (q: { kind: string; sessionKey: string; taskId: string | null; memberId: string }) => boolean) {
  return e.ctx.store.queue.list({ state: 'queued' }).filter(pred);
}

export function reviewsOf(e: AnyEnv, taskId: string) {
  return e.ctx.store.reviews.list({ ref1: taskId });
}

export function execKinds(e: AnyEnv, taskId: string): string[] {
  return e.ctx.store.execs.list({ ref1: taskId }).map((x) => x.kind);
}

/** 작업 폴더에서 단계 하나 추가 → (파일 쓰기) → 단계 완료 → 제출 처리. 진행 상태 작업에만 */
export async function workAndSubmit(e: AnyEnv, taskId: string, o: { label: string; file?: string | null; content?: string; artifactFile?: string } = { label: '작업' }): Promise<Task> {
  const t = task(e, taskId);
  if (t.state !== 'in_progress') throw new Error(`진행 상태가 아님: ${t.id} ${t.state}`);
  const steps = e.core.tasks.addSteps(taskId, [o.label]);
  const idx = steps[steps.length - 1]!.idx;
  if (o.file !== null) {
    const rel = o.file ?? `${taskId}-${idx}.txt`;
    const abs = join(t.workspace!.worktreePath, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, o.content ?? `${o.label}\n`, 'utf8');
  }
  if (o.artifactFile) {
    const abs = join(artifactWorkDir(e.ctx.paths, t.projectId, t.id), o.artifactFile);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, o.content ?? `${o.label}\n`, 'utf8');
  }
  const m = member(e, t.assigneeId);
  await e.core.tasks.completeStep(taskId, idx, o.label, m, null);
  e.core.tasks.requestSubmit(taskId, o.label, m);
  await e.core.tasks.processSubmission(taskId);
  return task(e, taskId);
}

/** 산출물 작업 폴더에 파일 쓰기 */
export function writeArtifact(e: AnyEnv, t: Task, rel: string, content: string): string {
  const abs = join(artifactWorkDir(e.ctx.paths, t.projectId, t.id), rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
  return abs;
}

/**
 * 실제 오케스트레이터(bootOrch)에서 실제 git 작업 폴더를 가진 저장소 변경형 작업을 검수 상태까지 몬다.
 * 작업 턴은 띄우지 않고(대기 항목 소비) 팀원이 할 일을 서비스로 직접 한다 — 검수 턴만 테스트가 tick으로 띄운다
 */
export async function orchRepoTaskInReview(env: OrchEnv, o: { assigneeId: string; reviewerId?: string | null; criteria?: string[] }): Promise<Task> {
  const d = seedDirective(env, '검수 완료 기준 지시');
  const t = env.core.tasks.create(
    {
      directiveId: d.id,
      title: '검수 대상 작업',
      goal: '검수 완료 기준 확인',
      type: 'development',
      assigneeId: o.assigneeId,
      reviewerId: o.reviewerId ?? null,
      acceptanceCriteria: o.criteria ?? ['동작한다'],
      outputMode: 'repo',
    },
    env.producerId,
  );
  if (!(await env.core.tasks.activateForLaunch(t.id))) throw new Error('활성화 실패');
  consumeQueued(env, `task:${t.id}`);
  env.core.tasks.setSteps(t.id, []);
  const cur = await workAndSubmit(env, t.id, { label: '구현', file: `${t.id}.txt`, content: 'v1\n' });
  if (cur.state !== 'in_review') throw new Error(`검수 상태가 아님: ${cur.state} ${JSON.stringify(cur.hold.reasons)}`);
  return cur;
}
