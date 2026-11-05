/**
 * 검수 흐름이 끊기지 않는지 (spec:F5, spec:F6 판정 부분, concurrency:CONC-11).
 * - 검수자 정지·중단·삭제·교체, update_task·assign_reviewer로 검수자를 바꿔도 검수가 새 검수자에게 정확히 한 번 다시 간다
 * - 검수 통과 뒤 그 검수 턴이 어떻게 끝나든(정지·비정상 종료·헛돌기) 병합 판단이 프로듀서에게 간다
 * - 판정 없이 헛돌거나 재시도를 다 쓴 검수는 알림만이 아니라 프로듀서의 검수자 재배정 업무로 넘어간다
 * 실제 오케스트레이터(스케줄러·턴 실행기·도구 처리기) + 가짜 CLI 프로세스 (orchHarness).
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Task } from '@shared/domain';
import type { OrchEnv } from './orchHarness';
import { bootOrch, notices, queuedOf, seedInReviewTask, sleep, startReview, waitFor } from './orchHarness';

let env: OrchEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const reviewKey = (t: Task | string) => `review:${typeof t === 'string' ? t : t.id}`;
/** 이 작업의 검수 항목 (대기·실행 중) */
const reviewEntries = (e: OrchEnv, taskId: string) => e.ctx.store.queue.list({ ref2: reviewKey(taskId), state: ['queued', 'running'] }).filter((q) => q.kind === 'review');
const mergeDecisions = (e: OrchEnv, taskId: string) => e.ctx.store.queue.list({ state: ['queued', 'running'] }).filter((q) => q.kind === 'merge_decision' && q.taskId === taskId);
const pass = (e: OrchEnv, turnId: string, taskId: string) =>
  e.tool(turnId, 'submit_review', { task_id: taskId, verdict: 'pass', criteria: [{ criterion: '문서가 있다', pass: true, note: '확인' }], reason: '' });

describe('검수자 정지·중단 (F5)', () => {
  for (const mode of ['immediate', 'graceful'] as const) {
    it(`검수 중 검수자 일시정지(${mode}) → 정지 중엔 실행하지 않고, 재개하면 같은 검수가 한 번 다시 돈다`, async () => {
      env = await bootOrch();
      const e = env;
      const { task, proc } = await startReview(e, e.qaId);
      await e.main('pause_member', { member_id: e.qaId, mode });
      await e.idle();
      expect(proc.terminatedByApp).toBe(true);
      // 작업은 보류되지 않았다 (남의 작업) — 검수는 대기열에 남아 정지가 풀리기를 기다린다
      expect(e.ctx.store.tasks.require(task.id).state).toBe('in_review');
      expect(reviewEntries(e, task.id).map((q) => `${q.memberId}:${q.state}`)).toEqual([`${e.qaId}:queued`]);
      e.tick();
      await sleep(50);
      expect(e.liveProc(reviewKey(task))).toBeUndefined();

      await e.main('resume_member', { member_id: e.qaId });
      expect(reviewEntries(e, task.id)).toHaveLength(1); // 재개의 재등록은 대기 항목에 합쳐진다
      e.tick();
      await waitFor(() => !!e.liveProc(reviewKey(task), e.qaId), '재개 후 검수');
      expect(reviewEntries(e, task.id)).toHaveLength(1);
    });
  }

  it('남의 작업만 검수하던 팀원 [중단 → 보류] → 검수 대상 작업이 중단 보류, 대표 재개로 검수가 다시 돈다', async () => {
    env = await bootOrch();
    const e = env;
    const { task, proc } = await startReview(e, e.qaId);
    await e.main('interrupt_member', { member_id: e.qaId, then: 'hold' });
    await e.idle();
    expect(proc.terminatedByApp).toBe(true);
    const held = e.ctx.store.tasks.require(task.id);
    expect(held.state).toBe('on_hold');
    expect(held.hold.reasons.map((r) => r.kind)).toEqual(['interrupted']);
    expect(reviewEntries(e, task.id)).toEqual([]); // 보류된 작업의 검수는 다시 넣지 않는다 (재개가 넣는다)

    await e.main('resume_task', { task_id: task.id });
    e.tick();
    await waitFor(() => !!e.liveProc(reviewKey(task), e.qaId), '재개 후 검수');
    expect(reviewEntries(e, task.id)).toHaveLength(1);
  });

  it('남의 작업만 검수하던 팀원 [중단 → 취소] → 검수 대상 작업이 취소되고 새 검수 턴·대기 항목이 없다', async () => {
    env = await bootOrch();
    const e = env;
    const { task } = await startReview(e, e.qaId);
    await e.main('interrupt_member', { member_id: e.qaId, then: 'cancel' });
    await e.idle();
    expect(e.ctx.store.tasks.require(task.id).state).toBe('cancelled');
    e.tick();
    await sleep(50);
    expect(e.liveProc(reviewKey(task))).toBeUndefined();
    expect(e.ctx.store.queue.list({ state: 'queued' }).filter((q) => q.taskId === task.id || q.sessionKey === reviewKey(task))).toEqual([]);
  });

  it('긴급 정지 → 해제 → 작업 재개는 검수를 한 번만 다시 등록한다', async () => {
    env = await bootOrch();
    const e = env;
    const { task } = await startReview(e, e.qaId);
    await e.invoke('stop.emergency');
    await e.idle();
    expect(e.ctx.store.tasks.require(task.id).state).toBe('on_hold');
    expect(reviewEntries(e, task.id)).toEqual([]);
    await e.invoke('stop.release');
    await e.main('resume_task', { task_id: task.id });
    e.tick();
    await waitFor(() => !!e.liveProc(reviewKey(task), e.qaId), '재개 후 검수');
    expect(reviewEntries(e, task.id)).toHaveLength(1);
  });
});

describe('검수 통과 뒤 턴이 비정상으로 끝나도 병합 판단으로 (F6)', () => {
  it('통과 직후 검수자 일시정지(정지 종료) → 병합 판단이 바로 프로듀서에게 가고, 검수는 다시 넣지 않는다', async () => {
    env = await bootOrch();
    const e = env;
    const { task, turnId } = await startReview(e, e.qaId, { outputMode: 'repo' });
    expect((await pass(e, turnId, task.id)).ok).toBe(true);
    await e.main('pause_member', { member_id: e.qaId, mode: 'immediate' });
    await e.idle();
    expect(mergeDecisions(e, task.id).map((q) => q.memberId)).toEqual([e.producerId]);
    expect(reviewEntries(e, task.id)).toEqual([]);
  });

  it('통과 직후 검수 턴 비정상 종료 → 다시 검수하지 않고 병합 판단', async () => {
    env = await bootOrch();
    const e = env;
    const { task, turnId, proc } = await startReview(e, e.qaId, { outputMode: 'repo' });
    expect((await pass(e, turnId, task.id)).ok).toBe(true);
    proc.exit(1); // result 없이 끝남 → crashed
    await e.idle();
    expect(e.ctx.store.turns.require(turnId).endReason).toBe('crashed');
    expect(mergeDecisions(e, task.id)).toHaveLength(1);
    expect(reviewEntries(e, task.id)).toEqual([]);
  });

  it('통과 직후 헛돌기 → 병합 판단', async () => {
    env = await bootOrch();
    const e = env;
    const { task, turnId, proc } = await startReview(e, e.qaId, { outputMode: 'repo' });
    expect((await pass(e, turnId, task.id)).ok).toBe(true);
    for (let i = 0; i < 5; i++) proc.emit({ kind: 'error', text: '같은 오류', data: {} });
    await e.idle();
    expect(e.ctx.store.turns.require(turnId).endReason).toBe('spin');
    expect(mergeDecisions(e, task.id)).toHaveLength(1);
  });

  it('판정 없이 헛돈 검수 → 프로듀서에게 검수자 재배정 업무 (알림만 하지 않음)', async () => {
    env = await bootOrch();
    const e = env;
    const { task, turnId, proc } = await startReview(e, e.qaId);
    for (let i = 0; i < 5; i++) proc.emit({ kind: 'error', text: '같은 오류', data: {} });
    await e.idle();
    expect(e.ctx.store.turns.require(turnId).endReason).toBe('spin');
    const assign = queuedOf(e, (q) => q.kind === 'reviewer_assign' && q.taskId === task.id);
    expect(assign.map((q) => q.memberId)).toEqual([e.producerId]);
  });

  it('판정 없이 비정상 종료 재시도를 다 쓴 검수 → 긴급 알림 + 검수자 재배정 업무', async () => {
    env = await bootOrch();
    const e = env;
    const task = seedInReviewTask(e, e.qaId);
    e.script.set(reviewKey(task), (p) => p.exit(1)); // 매번 결과 없이 끝남
    e.core.tasks.dispatchReview(e.ctx.store.tasks.require(task.id));
    await e.drain(3); // 1·2번째는 다시 넣고, 3번째(재시도 2회 소진)에서 멈춘다
    const turns = e.ctx.store.turns.list().filter((t) => t.taskId === task.id && t.sessionKind === 'review');
    expect(turns.map((t) => t.endReason)).toEqual(['crashed', 'crashed', 'crashed']);
    expect(reviewEntries(e, task.id)).toEqual([]);
    expect(queuedOf(e, (q) => q.kind === 'reviewer_assign' && q.taskId === task.id)).toHaveLength(1);
    expect(notices(e, '자동 복구 실패')).toHaveLength(1);
  });
});

describe('검수자 교체·삭제가 대기·실행 중 검수를 옮긴다 (F5, CONC-11)', () => {
  it('대기 중 검수의 검수자 삭제 → 새 검수자(프로듀서)가 검수한다', async () => {
    env = await bootOrch();
    const e = env;
    const task = seedInReviewTask(e, e.qaId);
    e.hold.add(reviewKey(task));
    e.core.tasks.dispatchReview(e.ctx.store.tasks.require(task.id));
    await e.main('remove_member', { member_id: e.qaId });
    expect(e.ctx.store.tasks.require(task.id).reviewerId).toBe(e.producerId);
    expect(reviewEntries(e, task.id).map((q) => q.memberId)).toEqual([e.producerId]);
    e.tick();
    await waitFor(() => !!e.liveProc(reviewKey(task), e.producerId), '프로듀서 검수');
  });

  it('실행 중 검수의 검수자 삭제 → 그 턴을 끝내고(삭제 팀원 몫으로 다시 넣지 않음) 프로듀서가 검수한다', async () => {
    env = await bootOrch();
    const e = env;
    const { task, proc } = await startReview(e, e.qaId);
    await e.main('remove_member', { member_id: e.qaId });
    await e.idle();
    expect(proc.terminatedByApp).toBe(true);
    expect(reviewEntries(e, task.id).map((q) => q.memberId)).toEqual([e.producerId]);
    e.tick();
    await waitFor(() => !!e.liveProc(reviewKey(task), e.producerId), '프로듀서 검수');
    expect(e.ctx.store.queue.list({ ref1: e.qaId, state: ['queued', 'running'] })).toEqual([]);
  });

  it('프로듀서가 검수하던 중 프로듀서 교체 → 새 프로듀서가 검수한다', async () => {
    env = await bootOrch();
    const e = env;
    const { task, proc } = await startReview(e, e.producerId);
    const fresh = { id: (await e.main('replace_producer', { project_id: e.projectId })).producerId as string };
    await e.idle();
    expect(proc.terminatedByApp).toBe(true);
    expect(e.ctx.store.tasks.require(task.id).reviewerId).toBe(fresh.id);
    e.tick();
    await waitFor(() => !!e.liveProc(reviewKey(task), fresh.id), '새 프로듀서 검수');
    expect(reviewEntries(e, task.id)).toHaveLength(1);
  });

  it('update_task(reviewer_id)로 바꾸면 대기 중이던 이전 검수자의 항목이 새 검수자 것으로 바뀐다', async () => {
    env = await bootOrch();
    const e = env;
    const task = seedInReviewTask(e, e.producerId);
    e.hold.add(reviewKey(task));
    e.core.tasks.dispatchReview(e.ctx.store.tasks.require(task.id));
    expect(reviewEntries(e, task.id).map((q) => q.memberId)).toEqual([e.producerId]);
    e.core.tasks.update(task.id, { reviewerId: e.qaId }, e.producerId);
    expect(reviewEntries(e, task.id).map((q) => q.memberId)).toEqual([e.qaId]);
    e.tick();
    await waitFor(() => !!e.liveProc(reviewKey(task), e.qaId), '새 검수자 검수');
  });

  it('assign_reviewer로 검수 중 검수자 변경 → 이전 턴은 끝나고 새 검수자만 한 번 실행', async () => {
    env = await bootOrch();
    const e = env;
    const { task, proc } = await startReview(e, e.qaId);
    // 프로듀서 지시 턴의 신원으로 도구 호출 (턴을 띄우지 않고 처리기만)
    const identity = {
      turnId: 'TN-test',
      sessionId: 'S-test',
      sessionKey: `directive:${task.directiveId}`,
      sessionKind: 'directive' as const,
      memberId: e.producerId,
      projectId: e.projectId,
      isMain: false,
      isProducer: true,
      canReview: true,
    };
    const r = await e.core.tools.handle(identity, 'assign_reviewer', { task_id: task.id, reviewer_id: e.producerId });
    expect(r.ok).toBe(true);
    await e.idle();
    expect(proc.terminatedByApp).toBe(true);
    expect(reviewEntries(e, task.id).map((q) => q.memberId)).toEqual([e.producerId]);
    e.tick();
    await waitFor(() => !!e.liveProc(reviewKey(task), e.producerId), '새 검수자 검수');
    expect(reviewEntries(e, task.id)).toHaveLength(1);
  });

  it('이전 검수자 몫으로 남은 낡은 항목은 dispatchReview가 정리한다 (중복 묶기에 흡수되지 않음)', async () => {
    env = await bootOrch();
    const e = env;
    const task = seedInReviewTask(e, e.qaId);
    e.core.tasks.dispatchReview(e.ctx.store.tasks.require(task.id));
    // 검수자만 바뀐 상태 (예: 예전 버전에서 남은 기록)
    e.ctx.store.tasks.patch(task.id, { reviewerId: e.producerId });
    e.core.tasks.dispatchReview(e.ctx.store.tasks.require(task.id));
    expect(reviewEntries(e, task.id).map((q) => q.memberId)).toEqual([e.producerId]);
  });
});
