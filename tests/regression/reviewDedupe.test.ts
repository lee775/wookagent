/**
 * 검수 판정 중복 처리 (spec:F7, REV-04: 같은 요청의 재전송만 중복으로 본다, AC-09).
 * 반려 뒤 변경 없이 다시 제출하면 같은 커밋이 다시 고정된다. 예전에는 같은 검수자의 새 판정이 이전 반려의 중복으로
 * 버려져 대표 검수가 영원히 끝나지 않았다. 이제는 지금 고정(제출·재고정) 안의 두 번째 판정만 중복이다.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID } from '@shared/domain';
import { REJECT_LIMIT } from '@core/taskMachine';
import type { Env } from './helpers';
import { boot, pass, reject, submittedTask } from './helpers';

let env: Env | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

/** 반려된 작업을 파일을 바꾸지 않고 다시 제출 */
async function resubmitUnchanged(e: Env, taskId: string): Promise<void> {
  const t = e.ctx.store.tasks.require(taskId);
  expect(t.state).toBe('in_progress');
  e.core.tasks.requestSubmit(taskId, '변경 불필요 — 기준대로입니다', e.ctx.store.members.require(t.assigneeId));
  await e.core.tasks.processSubmission(taskId);
  expect(e.ctx.store.tasks.require(taskId).state).toBe('in_review');
}

describe.each(['main', 'member'] as const)('반려 → 변경 없는 재제출 → 새 판정 (%s 검수자)', (who) => {
  it('같은 버전의 재제출에 대한 통과가 기록되고, 같은 고정 안의 재전송만 중복으로 본다', async () => {
    env = await boot();
    const e = env;
    const t = await submittedTask(e, { reviewer: who === 'main' ? 'main' : null });
    expect(e.ctx.store.tasks.require(t.id).reviewerId).toBe(who === 'main' ? MAIN_AGENT_ID : e.producer.id);
    const first = e.ctx.store.tasks.require(t.id).review.target;
    reject(e, t.id);
    await resubmitUnchanged(e, t.id);
    const again = e.ctx.store.tasks.require(t.id).review.target;
    // 같은 커밋·같은 기준 main이 다시 고정된다
    expect(again?.kind === 'repo' && first?.kind === 'repo' && again.taskCommitSha === first.taskCommitSha).toBe(true);

    const passed = pass(e, t.id);
    expect(passed.review.passed).not.toBeNull();
    const records = e.ctx.store.reviews.list({ ref1: t.id });
    expect(records.map((r) => r.verdict)).toEqual(['reject', 'pass']);
    if (who === 'main') expect(e.core.views.ownerTodos().map((x) => x.kind as string)).not.toContain('owner_review');

    // 같은 고정 안에서 다시 보낸 통과는 중복 (새 기록 없음)
    const reviewer = who === 'main' ? e.ctx.store.members.require(MAIN_AGENT_ID) : e.producer;
    const dup = e.core.tasks.submitReview(t.id, reviewer, { verdict: 'pass', criteria: [{ criterion: '동작한다', pass: true, note: '' }], reason: '' }, null);
    expect(dup.duplicate).toBe(true);
    expect(dup.review.id).toBe(records[1]!.id);
    expect(e.ctx.store.reviews.list({ ref1: t.id })).toHaveLength(2);
  });
});

describe('반려 횟수 (REV-04)', () => {
  it(`변경 없는 재제출을 거듭해도 반려는 매번 세어지고 ${REJECT_LIMIT}번째에 재계획 보류`, async () => {
    env = await boot();
    const e = env;
    const t = await submittedTask(e, { reviewer: 'main' });
    for (let i = 1; i < REJECT_LIMIT; i++) {
      reject(e, t.id);
      await resubmitUnchanged(e, t.id);
    }
    reject(e, t.id);
    const held = e.ctx.store.tasks.require(t.id);
    expect(held.state).toBe('on_hold');
    expect(held.hold.reasons.map((r) => r.kind)).toEqual(['replan']);
    expect(held.review.rejectsInRound).toBe(REJECT_LIMIT);
  });

  it('통과 뒤 완료 조건이 바뀌어 변경 없이 다시 제출해도 새 판정을 받는다', async () => {
    env = await boot();
    const e = env;
    const t = await submittedTask(e, { reviewer: 'main' });
    pass(e, t.id);
    e.core.tasks.update(t.id, { acceptanceCriteria: ['동작한다', '문서가 있다'] }, e.producer.id);
    await resubmitUnchanged(e, t.id);
    const r = e.core.tasks.submitReview(
      t.id,
      e.ctx.store.members.require(MAIN_AGENT_ID),
      { verdict: 'pass', criteria: [{ criterion: '동작한다', pass: true, note: '' }, { criterion: '문서가 있다', pass: true, note: '' }], reason: '' },
      null,
    );
    expect(r.duplicate).toBe(false);
    expect(e.ctx.store.tasks.require(t.id).review.passed?.reviewId).toBe(r.review.id);
  });
});
