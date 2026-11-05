/**
 * 검수 판정은 검수자가 본 버전에만 묶인다 (REV-07·08, AC-43).
 * - 지금 대상이 고정되기 전에 시작한 검수 턴의 판정(통과·반려)은 받지 않고, 그 턴이 끝나도 새 버전 검수를 겹쳐 넣거나 재촉·재배정하지 않는다
 * - 검수 중 완료 조건이 바뀌면 돌던 검수 턴을 끝내고 그 버전의 대기 검수를 지운다
 * - 메인 에이전트 대체 검수도 같다 — 그 검수 턴을 띄울 때의 고정(Turn.reviewPinnedAt)과 지금 대상이 다르면 판정을 받지 않는다 (옛 대표 검수의 화면 고정 시각 대신)
 * 실제 오케스트레이터 + 가짜 CLI 프로세스 (orchHarness).
 */
import { mkdirSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { Task } from '@shared/domain';
import { MAIN_AGENT_ID } from '@shared/domain';
import { enqueue, transitionTask } from '../../src/main/orchestrator/records';
import { reviewCopyPath } from '../../src/main/orchestrator/paths';
import type { OrchEnv } from './orchHarness';
import { bootOrch, queuedOf, seedInReviewTask, sleep, startReview, waitFor } from './orchHarness';

let env: OrchEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const reviewKey = (t: Task | string) => `review:${typeof t === 'string' ? t : t.id}`;
const verdict = (taskId: string, v: 'pass' | 'reject') => ({
  task_id: taskId,
  verdict: v,
  criteria: [{ criterion: '문서가 있다', pass: v === 'pass', note: v === 'pass' ? '확인' : '부족' }],
  reason: v === 'pass' ? '' : '다시',
});

describe('검수 판정과 검수 대상 버전 (REV-07, AC-43)', () => {
  it('지금 대상이 고정되기 전에 시작한 검수 턴의 통과·반려는 받지 않고, 그 턴이 끝나도 새 버전 검수를 겹쳐 넣거나 재촉·재배정하지 않는다', async () => {
    env = await bootOrch();
    const e = env;
    const { task, proc, turnId } = await startReview(e, e.qaId, { outputMode: 'repo' });
    await sleep(5); // 새 고정 시각이 그 턴의 시작보다 뒤가 되게
    const v1 = task.review.target!;
    if (v1.kind !== 'repo') throw new Error('repo');
    const v2 = { ...v1, taskCommitSha: 'c'.repeat(40), pinnedAt: e.ctx.now() };
    mkdirSync(reviewCopyPath(e.ctx.paths, e.projectId, task.id, 1, 'c'.repeat(8)), { recursive: true });
    transitionTask(e.ctx, task.id, { type: 'repin', target: v2 }, 'system');
    e.core.tasks.dispatchReview(e.ctx.store.tasks.require(task.id));

    for (const v of ['pass', 'reject'] as const) {
      const late = await e.tool(turnId, 'submit_review', verdict(task.id, v));
      expect(late.ok, v).toBe(false);
      if (!late.ok) expect(late.code).toBe('conflict');
    }
    proc.finishOk();
    await e.idle();
    const cur = e.ctx.store.tasks.require(task.id);
    expect(cur.review).toMatchObject({ passed: null, rejectsInRound: 0, rejectsTotal: 0 });
    expect(e.ctx.store.reviews.list({ ref1: task.id })).toEqual([]);
    const reviews = queuedOf(e, (q) => q.sessionKey === reviewKey(task) && q.kind === 'review');
    expect(reviews.map((q) => q.memberId)).toEqual([e.qaId]);
    expect(reviews[0]!.message).not.toContain('검수 결과가 아직 등록되지 않았습니다');
    expect(queuedOf(e, (q) => q.kind === 'reviewer_assign' || q.kind === 'merge_decision')).toEqual([]);

    // 새 버전은 그 뒤에 시작한 검수 턴이 판정한다
    e.tick();
    await waitFor(() => !!e.liveProc(reviewKey(task), e.qaId), '새 버전 검수 턴');
    const fresh = e.liveProc(reviewKey(task), e.qaId)!;
    expect(fresh.turnId).not.toBe(turnId);
    expect((await e.tool(fresh.turnId, 'submit_review', verdict(task.id, 'pass'))).ok).toBe(true);
    expect(e.ctx.store.tasks.require(task.id).review.passed?.target).toEqual(v2);
  });

  it('검수 중 완료 조건이 바뀌면 돌던 검수 턴을 끝내고 그 버전의 대기 검수를 지운다 — 끝난 턴 몫으로 다시 넣지 않고 작업자에게 재작업을 넘긴다', async () => {
    env = await bootOrch();
    const e = env;
    const { task, proc, turnId } = await startReview(e, e.qaId, { outputMode: 'repo' });
    enqueue(e.ctx, { kind: 'review', memberId: e.qaId, sessionKey: reviewKey(task), projectId: e.projectId, taskId: task.id, message: '이전 버전 검수 재촉' });
    e.core.tasks.update(task.id, { acceptanceCriteria: ['문서가 있다', '목차가 있다'] }, e.producerId);
    await e.idle();
    expect(proc.terminatedByApp).toBe(true);
    expect(e.ctx.store.turns.require(turnId).endReason).toBe('user_stop');
    expect(e.ctx.store.tasks.require(task.id)).toMatchObject({ state: 'in_progress', review: { target: null, passed: null } });
    expect(e.ctx.store.queue.list({ ref2: reviewKey(task), state: ['queued', 'running'] })).toEqual([]);
    expect(queuedOf(e, (q) => q.sessionKey === `task:${task.id}`).map((q) => q.kind)).toEqual(['task_work']);
  });

  it('메인 에이전트 검수: 그 검수 턴이 띄워질 때의 고정이 지금 대상과 다르면 받지 않고, 지금 버전에 띄운 메인 검수 턴의 판정은 등록한다', async () => {
    env = await bootOrch();
    const e = env;
    const { task, proc, turnId } = await startReview(e, MAIN_AGENT_ID, { outputMode: 'repo' });
    expect(e.ctx.store.turns.require(turnId).reviewPinnedAt).toBe(task.review.target!.pinnedAt);
    await sleep(5);
    const v1 = task.review.target!;
    if (v1.kind !== 'repo') throw new Error('repo');
    const v2 = { ...v1, taskCommitSha: 'd'.repeat(40), pinnedAt: e.ctx.now() };
    mkdirSync(reviewCopyPath(e.ctx.paths, e.projectId, task.id, 1, 'd'.repeat(8)), { recursive: true });
    transitionTask(e.ctx, task.id, { type: 'repin', target: v2 }, 'system');
    e.core.tasks.dispatchReview(e.ctx.store.tasks.require(task.id));
    // 이전 버전에 띄운 메인 검수 턴의 판정(통과·반려)은 받지 않는다
    for (const v of ['pass', 'reject'] as const) {
      const late = await e.tool(turnId, 'submit_review', verdict(task.id, v));
      expect(late.ok ? null : late.code, v).toBe('conflict');
    }
    expect(e.ctx.store.tasks.require(task.id).review.passed).toBeNull();
    proc.finishOk();
    await e.idle();
    expect(queuedOf(e, (q) => q.sessionKey === reviewKey(task) && q.kind === 'review').map((q) => q.memberId)).toEqual([MAIN_AGENT_ID]);
    // 지금 버전에 띄운 메인 검수 턴의 판정은 받는다
    e.tick();
    await waitFor(() => !!e.liveProc(reviewKey(task), MAIN_AGENT_ID), '새 버전 메인 검수 턴');
    const fresh = e.liveProc(reviewKey(task), MAIN_AGENT_ID)!;
    expect(fresh.turnId).not.toBe(turnId);
    expect((await e.tool(fresh.turnId, 'submit_review', verdict(task.id, 'pass'))).ok).toBe(true);
    expect(e.ctx.store.tasks.require(task.id).review.passed).toMatchObject({ reviewerId: MAIN_AGENT_ID, target: v2 });
  });
});
