/**
 * 같은 세션의 대기 업무를 합칠 때 다른 작업의 업무와는 합치지 않는다 (리드 결정 13 — flows L3, 프로브 zz-s1fg-noreviewer-dedupe; 리드 결정 11의 다른 길 점검).
 * 예전에는 같은 세션·같은 종류면 작업이 달라도 첫 항목에 글만 덧붙여 합쳤다 — 합친 항목은 첫 작업의 taskId만 가져, 그 작업을 취소하면(taskId로 지움)
 * 아직 기다리는 다른 작업의 업무까지 사라졌다:
 * - 검수자 없음(no_reviewer, 메인 main:P): B는 검수자 없음 보류인데 메인에게 알릴 업무가 없다
 * - 검수자 재배정(reviewer_assign, 프로듀서 directive:D): B는 검수 중인데 검수도 재배정 업무도 없다
 * - 병합 판단(merge_decision, 프로듀서 directive:D): B는 통과했는데 병합 판단 업무가 없다
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID, type WorkKind } from '@shared/domain';
import { directiveKey, mainKey } from '../../src/main/orchestrator/records';
import type { OrchEnv } from './orchHarness';
import { bootOrch, seedDirective, seedInReviewTask, waitFor } from './orchHarness';

let env: OrchEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const items = (e: OrchEnv, kind: WorkKind, sessionKey: string) => e.ctx.store.queue.list({ ref2: sessionKey, state: ['queued', 'running'] }).filter((q) => q.kind === kind);

describe('대기 업무 합치기는 같은 작업끼리만 (리드 결정 11·13)', () => {
  it('검수자 없음: 두 작업이 각자 메인 에이전트 업무를 갖고, 한 작업을 취소해도 다른 작업의 검수자 없음 업무는 남는다', async () => {
    const e = (env = await bootOrch());
    await e.internal('members.remove', e.qaId);
    const d = seedDirective(e);
    const mk = () => {
      const t = seedInReviewTask(e, MAIN_AGENT_ID, { outputMode: 'repo', directiveId: d.id });
      // 프로듀서 직접 작업이고 메인 에이전트도 기여자 → 적격 검수자 없음
      e.ctx.store.tasks.patch(t.id, { assigneeId: e.producerId, contributors: [e.producerId, MAIN_AGENT_ID] });
      e.core.tasks.dispatchReview(e.ctx.store.tasks.require(t.id));
      return t;
    };
    const a = mk();
    const b = mk();
    for (const t of [a, b]) expect(e.ctx.store.tasks.require(t.id).hold.reasons.map((r) => r.refId)).toEqual(['no_reviewer']);
    const noReviewer = () => items(e, 'no_reviewer', mainKey(e.projectId));
    expect(noReviewer().map((q) => [q.taskId, q.message.includes(q.taskId!)])).toEqual([
      [a.id, true],
      [b.id, true],
    ]);
    await e.main('cancel_task', { task_id: a.id, reason: 'A는 필요 없음' });
    expect(e.ctx.store.tasks.require(a.id).state).toBe('cancelled');
    expect(e.ctx.store.tasks.require(b.id).hold.reasons.map((r) => r.refId)).toEqual(['no_reviewer']);
    expect(noReviewer().map((q) => q.taskId)).toEqual([b.id]);
    expect(noReviewer()[0]!.message).toContain(`${b.id} "${b.title}" 검수자 없음`);
  });

  it('검수자 재배정: 같은 지시의 두 작업이 각자 프로듀서 업무를 갖고, 한 작업을 취소해도 다른 작업의 재배정 업무는 남는다 (검수 중 작업에 할 일이 남는다)', async () => {
    const e = (env = await bootOrch());
    await e.internal('members.remove', e.qaId);
    const d = seedDirective(e);
    // 프로듀서의 지시 세션에 다른 일(병합 판단) 턴을 띄워 둔다 — 그동안 들어오는 재배정 업무는 대기열에 그대로 있다 (세션당 턴 하나)
    const c = seedInReviewTask(e, MAIN_AGENT_ID, { outputMode: 'repo', directiveId: d.id });
    e.core.merges.queueMergeDecision(e.ctx.store.tasks.require(c.id));
    e.hold.add(directiveKey(d.id));
    e.tick();
    await waitFor(() => e.core.turns.hasLiveSession(directiveKey(d.id)), '프로듀서 턴');
    const mk = () => {
      const t = seedInReviewTask(e, MAIN_AGENT_ID, { outputMode: 'repo', directiveId: d.id });
      e.ctx.store.tasks.patch(t.id, { assigneeId: e.producerId, contributors: [e.producerId] });
      return t;
    };
    const a = mk();
    const b = mk();
    for (const t of [a, b]) e.core.tasks.dispatchReview(e.ctx.store.tasks.require(t.id));
    const assign = () => items(e, 'reviewer_assign', directiveKey(d.id)).filter((q) => q.state === 'queued');
    // 메인 검수 턴(가짜 CLI)이 판정 없이 3번씩 끝나 두 작업 모두 재배정 업무로
    await waitFor(
      () => {
        e.tick();
        return assign().length === 2;
      },
      '두 작업의 재배정 업무',
      20_000,
    );
    expect(assign().map((q) => q.taskId).sort()).toEqual([a.id, b.id].sort());
    await e.main('cancel_task', { task_id: a.id, reason: 'A는 필요 없음' });
    expect(e.ctx.store.tasks.require(b.id)).toMatchObject({ state: 'in_review', reviewerId: MAIN_AGENT_ID });
    expect(assign().map((q) => q.taskId)).toEqual([b.id]);
    expect(assign()[0]!.message).toContain(`${b.id} 검수 결과가 반복해서 등록되지 않았습니다`);
  });

  it('병합 판단: 같은 지시의 두 통과 작업이 각자 병합 판단 업무를 갖고, 한 작업을 취소해도 다른 작업의 병합 판단 업무는 남는다 — 같은 작업은 그대로 하나로 묶인다', async () => {
    const e = (env = await bootOrch());
    const d = seedDirective(e);
    const a = seedInReviewTask(e, e.qaId, { outputMode: 'repo', directiveId: d.id });
    const b = seedInReviewTask(e, e.qaId, { outputMode: 'repo', directiveId: d.id });
    for (const t of [a, b, a]) e.core.merges.queueMergeDecision(e.ctx.store.tasks.require(t.id));
    const merges = () => items(e, 'merge_decision', directiveKey(d.id));
    expect(merges().map((q) => q.taskId)).toEqual([a.id, b.id]);
    await e.main('cancel_task', { task_id: a.id, reason: 'A는 필요 없음' });
    expect(merges().map((q) => q.taskId)).toEqual([b.id]);
    expect(merges()[0]!.message).toContain(`request_merge(task_id="${b.id}")`);
  });
});
