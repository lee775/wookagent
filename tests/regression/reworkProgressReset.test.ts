/**
 * 검수 대상이 된 버전은 진척이다 — 진척 없는 자동 재개 수(헛돌기 3회)는 대상 고정·검수 판정에서 다시 센다 (CLI-18, 8장 헛돌기, ERR-04).
 * - 제출 요청만으로는 세지도 되돌리지도 않는다 (검사가 계속 실패하는 작업의 쉬는 턴·제출 턴 번갈기는 [1,1,2,2,3]으로 막힌다 — conflictCounting.test.ts)
 * - 검사를 거쳐 대상이 고정된 뒤 반려되면 재작업의 첫 쉬는 턴은 처음부터 센다 — 제출 전 쉬는 턴에 이어 세어 헛돌기로 보류되지 않는다
 * - 반려가 아니라 진행으로 돌린 경우(완료 조건 변경 등)도 고정 때 다시 셌으므로 같다. 재작업이 계속 쉬면 3번째에 헛돌기로 막힌다
 * - 상태 전이: 고정(submit·repin)과 판정(review_pass·reject)이 진척 없는 재개·비정상 종료 재시도·이어진 제출 거부 수를 0으로
 * 턴 단위 하네스(orchHarness: 실제 오케스트레이터 + 가짜 CLI) + 순수 전이 함수.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Task } from '@shared/domain';
import { applyTaskEvent, emptyReviewState } from '@core/taskMachine';
import { activeRepoTask } from '../acceptance/git-helpers';
import { bootOrch, waitFor, type FakeProc, type OrchEnv } from './orchHarness';

let env: OrchEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

/** 단계를 다 마친 진행 작업 */
async function doneSteps(o: OrchEnv): Promise<Task> {
  const dev = o.ctx.store.members.require(o.devId);
  const t = await activeRepoTask(o.core, { projectId: o.projectId, assignee: dev });
  o.core.tasks.setSteps(t.id, ['단계 1']);
  writeFileSync(join(t.workspace!.worktreePath, 'a.txt'), 'a\n', 'utf8');
  await o.core.tasks.completeStep(t.id, 0, '완료', dev, null);
  return t;
}

function scripted(o: OrchEnv, key: string, body: (p: FakeProc, i: number) => Promise<void>): void {
  let n = 0;
  o.script.set(key, (p) => {
    const i = n++;
    void body(p, i)
      .then(() => p.finishOk())
      .catch((e: unknown) => {
        o.errors.push(String(e));
        p.finishOk('대본 오류');
      });
  });
}

/** 작업 세션 턴 하나 → 그 판정(다음 업무 등록·제출 처리·보류)이 끝날 때까지 */
async function oneTurn(o: OrchEnv, taskId: string): Promise<Task> {
  await o.drain(1);
  await waitFor(() => {
    const x = o.ctx.store.tasks.require(taskId);
    return !o.core.tasks.isSubmitting(taskId) && (x.state !== 'in_progress' || o.ctx.store.queue.list({ ref2: `task:${taskId}`, state: 'queued' }).length > 0);
  }, `${taskId} 판정`, 20_000);
  return o.ctx.store.tasks.require(taskId);
}

/** 쉬는 턴 2번 → 3번째 턴에 제출(검사 통과, 대상 고정)까지 — 그동안의 진척 없는 재개 수 */
async function idleIdleSubmit(o: OrchEnv, t: Task): Promise<number[]> {
  scripted(o, `task:${t.id}`, async (p, i) => {
    if (i === 2) {
      const r = await o.tool(p.turnId, 'submit_for_review', { note: '제출' });
      if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
    }
  });
  o.core.tasks.continueWork(t.id, '시작');
  const counts: number[] = [];
  for (let i = 0; i < 3; i++) counts.push((await oneTurn(o, t.id)).noProgressResumes);
  return counts;
}

describe('검수 대상이 된 버전은 진척이다 (CLI-18)', () => {
  it('쉬는 턴 2번 뒤 제출해 검사를 통과하고 고정된 버전이 반려되면, 재작업의 첫 쉬는 턴은 처음부터 센다 — 헛돌기 보류가 아니다 (계속 쉬면 3번째에 헛돌기)', async () => {
    const o = (env = await bootOrch());
    const t = await doneSteps(o);
    const counts = await idleIdleSubmit(o, t);
    expect(counts).toEqual([1, 2, 0]); // 대상 고정이 다시 셌다
    const inReview = o.ctx.store.tasks.require(t.id);
    expect(inReview.state).toBe('in_review');
    const reviewer = o.ctx.store.members.require(inReview.reviewerId!);
    o.core.tasks.submitReview(t.id, reviewer, { verdict: 'reject', criteria: inReview.acceptanceCriteria.map((c) => ({ criterion: c, pass: false, note: '고칠 것' })), reason: '고칠 것' }, null);
    expect(o.ctx.store.tasks.require(t.id)).toMatchObject({ state: 'in_progress', noProgressResumes: 0 });
    // 재작업 턴: 아직 고치는 중이라 단계·제출 없이 끝난다
    const r1 = await oneTurn(o, t.id);
    expect(o.errors).toEqual([]);
    expect(r1).toMatchObject({ state: 'in_progress', noProgressResumes: 1 });
    expect(r1.hold.reasons).toEqual([]);
    // 계속 쉬기만 하면 상한은 그대로 — 재작업의 3번째 쉬는 턴에 헛돌기
    await oneTurn(o, t.id);
    const r3 = await oneTurn(o, t.id);
    expect(r3.state).toBe('on_hold');
    expect(r3.hold.reasons.map((r) => [r.kind, r.note])).toEqual([['replan', '진척 없는 자동 재개 3회']]);
  }, 120_000);

  it('고정된 버전이 반려가 아니라 진행으로 돌아가도(검수 중 완료 조건 변경) 고정 때 다시 셌으므로 다음 쉬는 턴은 1이다', async () => {
    const o = (env = await bootOrch());
    const t = await doneSteps(o);
    expect(await idleIdleSubmit(o, t)).toEqual([1, 2, 0]);
    o.core.tasks.update(t.id, { acceptanceCriteria: ['동작한다', '문서가 있다'] }, o.producerId);
    expect(o.ctx.store.tasks.require(t.id)).toMatchObject({ state: 'in_progress', noProgressResumes: 0 });
    const r1 = await oneTurn(o, t.id);
    expect(o.errors).toEqual([]);
    expect(r1).toMatchObject({ state: 'in_progress', noProgressResumes: 1 });
  }, 120_000);
});

describe('고정·판정 전이가 재시도 수를 다시 센다 (taskMachine)', () => {
  const base = (state: Task['state']): Task => ({
    id: 'T-0001',
    projectId: 'P-0001',
    directiveId: 'D-0001',
    round: 1,
    title: '전이',
    goal: '전이',
    type: 'development',
    priority: 'normal',
    assigneeId: 'M-0002',
    reviewerId: 'M-0001',
    prerequisiteIds: [],
    acceptanceCriteria: ['동작한다'],
    plannedAreas: [],
    outputMode: 'repo',
    state,
    hold: { reasons: [], returnState: null },
    workspace: null,
    review: emptyReviewState(),
    contributors: ['M-0002'],
    merge: null,
    artifact: null,
    revertOfTaskId: null,
    revertedByTaskId: null,
    skillsUsed: [],
    pendingSubmit: state === 'in_progress' ? { requestedAt: 'x', note: '' } : null,
    conflict: null,
    crashRetries: 2,
    noProgressResumes: 2,
    checkFailStreak: 4,
    createdBy: 'M-0001',
    createdAt: 'x',
    updatedAt: 'x',
    queuedAt: 'x',
    activatedAt: 'x',
    completedAt: null,
    cancelledAt: null,
  });
  const target = { kind: 'repo' as const, taskCommitSha: 'a'.repeat(40), baseMainSha: 'b'.repeat(40), pinnedAt: 'p' };

  it('대상 고정(submit·repin)은 진척 없는 재개·비정상 종료 재시도·이어진 제출 거부 수를 0으로, 판정(review_pass·reject)은 재개·재시도 수를 0으로', () => {
    const pinned = applyTaskEvent(base('in_progress'), { type: 'submit', target }, 'now', 'system').task;
    expect(pinned).toMatchObject({ state: 'in_review', noProgressResumes: 0, crashRetries: 0, checkFailStreak: 0 });
    const inReview = { ...base('in_review'), review: { ...emptyReviewState(), target } };
    expect(applyTaskEvent(inReview, { type: 'repin', target: { ...target, pinnedAt: 'q' } }, 'now', 'system').task).toMatchObject({ noProgressResumes: 0, crashRetries: 0, checkFailStreak: 0 });
    expect(applyTaskEvent(inReview, { type: 'reject', reason: '다시' }, 'now', 'M-0001').task).toMatchObject({ state: 'in_progress', noProgressResumes: 0, crashRetries: 0 });
    expect(applyTaskEvent(inReview, { type: 'review_pass', reviewId: 'R-1', reviewerId: 'M-0001', target }, 'now', 'M-0001').task).toMatchObject({ noProgressResumes: 0, crashRetries: 0 });
    // 진행으로 돌리기(reopen)는 진척이 아니다 — 그 버전을 고정할 때 이미 다시 셌다
    expect(applyTaskEvent({ ...inReview, noProgressResumes: 1 }, { type: 'reopen', reason: '기준 변경' }, 'now', 'system').task.noProgressResumes).toBe(1);
  });
});
