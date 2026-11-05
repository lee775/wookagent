/**
 * 검수 자격을 잃은 검수자 다시 정하기 (리드 결정 S5-13): 역할의 검수 권한을 끄거나(update_role) 검수자를 검수 권한이 없는 역할로 옮기면(update_member)
 * 끝나지 않은 작업의 검수자를 바로 기본 규칙으로 다시 고른다 — 팀원 삭제(team.remove)와 같은 길. 그대로 두면 대기·실행 중인 그 검수는 submit_review가
 * '검수 권한이 없는 역할입니다'로 거부된 뒤에야 재배정 길로 간다. 아직 검수할 수 있는 검수자(검수 권한 역할로 옮김, 프로듀서)는 그대로 둔다
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Task } from '@shared/domain';
import type { OrchEnv } from './orchHarness';
import { bootOrch, seedDirective, seedInReviewTask, startReview, waitFor } from './orchHarness';

let env: OrchEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const reviewKey = (t: Task | string) => `review:${typeof t === 'string' ? t : t.id}`;
const reviewEntries = (e: OrchEnv, taskId: string) => e.ctx.store.queue.list({ ref2: reviewKey(taskId), state: ['queued', 'running'] }).filter((q) => q.kind === 'review');

/** 개발자 작업(대기)을 검수자를 정해 만든다 */
function waitingTask(e: OrchEnv, reviewerId: string, title = '대기 작업'): Task {
  const d = seedDirective(e);
  return e.core.tasks.create({ directiveId: d.id, title, goal: title, type: 'development', assigneeId: e.devId, reviewerId, acceptanceCriteria: ['동작'], outputMode: 'repo' }, e.producerId);
}

describe('검수 자격을 잃은 검수자는 바로 다시 정한다 (S5-13)', () => {
  it('update_role로 QA 역할의 검수 권한을 끄면 QA가 맡은 대기·검수 중 작업의 검수자가 프로듀서로 바뀌고 대기 중 검수도 옮겨 간다', async () => {
    const e = (env = await bootOrch());
    const queued = seedInReviewTask(e, e.qaId);
    e.hold.add(reviewKey(queued));
    e.core.tasks.dispatchReview(e.ctx.store.tasks.require(queued.id));
    expect(reviewEntries(e, queued.id).map((q) => q.memberId)).toEqual([e.qaId]);
    const waiting = waitingTask(e, e.qaId);
    const byProducer = waitingTask(e, e.producerId, '프로듀서 검수 작업');
    expect(e.ctx.store.tasks.require(waiting.id).reviewerId).toBe(e.qaId);

    await e.main('update_role', { role_id: 'qa', can_review: false, reason: '대표 명령: QA는 테스트만' });
    expect(e.ctx.store.tasks.require(queued.id).reviewerId).toBe(e.producerId);
    expect(e.ctx.store.tasks.require(waiting.id).reviewerId).toBe(e.producerId);
    expect(e.ctx.store.tasks.require(byProducer.id).reviewerId).toBe(e.producerId);
    // 대기 중이던 QA의 검수는 새 검수자 것으로 (CONC-11)
    expect(reviewEntries(e, queued.id).map((q) => q.memberId)).toEqual([e.producerId]);
    expect(e.ctx.store.queue.list({ ref1: e.qaId, state: ['queued', 'running'] }).filter((q) => q.kind === 'review')).toEqual([]);
    e.tick();
    await waitFor(() => !!e.liveProc(reviewKey(queued), e.producerId), '프로듀서 검수');
    // 대표 알림·활동 기록에 검수 권한 해제가 보인다
    expect(e.ctx.store.activity.search({ text: '(update_role) — 사유:' }).map((r) => r.text)).toEqual([expect.stringContaining('역할 수정 qa QA (검수 권한 해제)')]);
  });

  it('실행 중인 QA 검수 턴은 끝나고(QA 몫으로 다시 넣지 않음) 프로듀서가 검수한다', async () => {
    const e = (env = await bootOrch());
    const { task, proc } = await startReview(e, e.qaId);
    await e.main('update_role', { role_id: 'qa', can_review: false });
    await e.idle();
    expect(proc.terminatedByApp).toBe(true);
    expect(e.ctx.store.tasks.require(task.id).reviewerId).toBe(e.producerId);
    expect(reviewEntries(e, task.id).map((q) => q.memberId)).toEqual([e.producerId]);
    e.tick();
    await waitFor(() => !!e.liveProc(reviewKey(task), e.producerId), '프로듀서 검수');
    expect(e.ctx.store.queue.list({ ref1: e.qaId, state: ['queued', 'running'] })).toEqual([]);
  });

  it('검수 권한을 그대로 두거나 켜는 수정, 다른 항목만 고친 수정은 검수자를 바꾸지 않는다', async () => {
    const e = (env = await bootOrch());
    const t = waitingTask(e, e.qaId);
    await e.main('update_role', { role_id: 'qa', instructions: '테스트를 꼼꼼히' });
    await e.main('update_role', { role_id: 'qa', can_review: true });
    await e.main('update_role', { role_id: 'developer', can_review: true });
    await e.main('update_role', { role_id: 'developer', can_review: false });
    expect(e.ctx.store.tasks.require(t.id).reviewerId).toBe(e.qaId);
  });

  it('update_member로 검수자를 검수 권한이 없는 역할로 옮기면 그 검수를 다시 정한다 — 검수 권한 역할로 옮기면 그대로', async () => {
    const e = (env = await bootOrch());
    const { roleId } = await e.main('create_role', { name: '보안 검토', instructions: '보안을 검토한다', task_types: ['test'], default_ai: { kind: 'claude', effort_tier: 'high' }, can_review: true });
    const sec = String((await e.main('add_member', { project_id: e.projectId, role_id: roleId, reason: '보안 검토자' })).memberId);
    const queued = seedInReviewTask(e, sec);
    e.hold.add(reviewKey(queued));
    e.core.tasks.dispatchReview(e.ctx.store.tasks.require(queued.id));
    const waiting = waitingTask(e, sec);
    // 검수 권한이 있는 역할(설계자)로 옮기면 그대로
    await e.main('update_member', { member_id: sec, role_id: 'architect', reason: '설계도 맡김' });
    expect(e.ctx.store.tasks.require(waiting.id).reviewerId).toBe(sec);
    expect(reviewEntries(e, queued.id).map((q) => q.memberId)).toEqual([sec]);
    // 검수 권한이 없는 역할(개발자)로 옮기면 바로 다시 정한다
    await e.main('update_member', { member_id: sec, role_id: 'developer', reason: '개발로 옮김' });
    expect(e.ctx.store.tasks.require(waiting.id).reviewerId).toBe(e.producerId);
    expect(e.ctx.store.tasks.require(queued.id).reviewerId).toBe(e.producerId);
    expect(reviewEntries(e, queued.id).map((q) => q.memberId)).toEqual([e.producerId]);
    // 다른 팀원(QA)의 검수는 그대로
    const qaTask = waitingTask(e, e.qaId, 'QA 검수 작업');
    await e.main('update_member', { member_id: e.devId, role_id: 'docs', reason: '문서로 옮김' });
    expect(e.ctx.store.tasks.require(qaTask.id).reviewerId).toBe(e.qaId);
  });
});
