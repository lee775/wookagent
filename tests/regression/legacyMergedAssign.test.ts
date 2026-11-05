/**
 * 합쳐 둔 옛 검수자 재배정 항목 (리드 결정 27, 10-30 — flows 재리뷰 low, 프로브 zz-s1fx2fg-legacy-merged-assign):
 * - 1단계 전 코드는 같은 지시 세션의 검수자 재배정 업무(reviewer_assign)를 작업과 상관없이 한 항목으로 합쳤다 — 첫 작업의 taskId만 남고 다른 작업은 글에만 있다.
 * - 끝난 업무 판정(deadWorkReason, 리드 결정 19)이 taskId만 보아, 첫 작업이 검수를 통과하면 스케줄러가 그 항목을 통째로 지워 둘째 작업의 재배정 업무도
 *   사라졌다 — 둘째 작업은 검수 중인데 검수도, 재배정도, 메인 업무도 없었다(다음 재시작까지).
 * - 이제 그 항목이 가리키는 작업(taskId와 글의 작업 ID)이 모두 끝났을 때만 끝난 업무다
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { QueueEntry, Task } from '@shared/domain';
import { directiveKey, enqueue } from '../../src/main/orchestrator/records';
import { deadWorkReason } from '../../src/main/orchestrator/turns';
import { bootOrch, seedDirective, seedInReviewTask, sleep, type OrchEnv } from './orchHarness';

let env: OrchEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

/** T1·T2가 검수 중인 지시와, 옛 코드가 합쳐 둔 재배정 항목(taskId는 T1, 글에는 T1·T2) */
function mergedEntry(e: OrchEnv): { t1: Task; t2: Task; q: QueueEntry; directiveId: string } {
  const d = seedDirective(e);
  const t1 = seedInReviewTask(e, e.qaId, { outputMode: 'repo', directiveId: d.id });
  const t2 = seedInReviewTask(e, e.qaId, { outputMode: 'repo', directiveId: d.id });
  const line = (t: Task) => `${t.id} 검수 결과가 반복해서 등록되지 않았습니다 (검수자 ${e.qaId}). assign_reviewer로 다른 적격 검수자를 정하세요.`;
  const q0 = enqueue(e.ctx, { kind: 'reviewer_assign', memberId: e.producerId, sessionKey: directiveKey(d.id), projectId: e.projectId, taskId: t1.id, directiveId: d.id, message: line(t1) });
  const q = e.ctx.store.queue.patch(q0.id, { message: `${q0.message}\n\n${line(t2)}` });
  return { t1, t2, q, directiveId: d.id };
}
function pass(e: OrchEnv, t: Task) {
  const cur = e.ctx.store.tasks.require(t.id);
  e.ctx.store.tasks.patch(t.id, { review: { ...cur.review, passed: { reviewId: 'RV-x', reviewerId: e.qaId, target: cur.review.target!, at: e.ctx.now() } as never } });
}

describe('합쳐 둔 옛 검수자 재배정 항목은 가리키는 작업이 모두 끝났을 때만 끝난 업무다 (리드 결정 27)', () => {
  it('첫 작업만 통과했으면 스케줄러가 지우지 않고 프로듀서 턴에 싣는다 — 둘째 작업의 재배정 업무가 남는다', async () => {
    const e = (env = await bootOrch());
    const { t1, t2, q, directiveId } = mergedEntry(e);
    pass(e, t1);
    expect(deadWorkReason(e.ctx, e.ctx.store.queue.require(q.id))).toBeNull();
    e.hold.add(directiveKey(directiveId));
    for (let i = 0; i < 5; i++) {
      e.tick();
      await sleep(25);
    }
    // 지워지지 않고 프로듀서 턴에 실렸다 — 그 글에 둘째 작업이 있다
    const entry = e.ctx.store.queue.require(q.id);
    expect(entry.state).toBe('running');
    const launch = e.launches.find((l) => l.workKey === directiveKey(directiveId))!;
    expect(launch.message).toContain(t2.id);
    expect(e.ctx.store.activity.search({ text: '끝난 일의', limit: 10 })).toEqual([]);
    expect(e.ctx.store.tasks.require(t2.id).state).toBe('in_review');
  });

  it('가리키는 작업이 모두 통과했으면 끝난 업무로 지운다 (첫 작업의 까닭으로 기록)', async () => {
    const e = (env = await bootOrch());
    const { t1, t2, q, directiveId } = mergedEntry(e);
    pass(e, t1);
    pass(e, t2);
    expect(deadWorkReason(e.ctx, e.ctx.store.queue.require(q.id))).toBe(`${t1.id}이(가) 이미 검수를 통과함`);
    e.hold.add(directiveKey(directiveId));
    e.tick();
    await sleep(50);
    expect(e.ctx.store.queue.require(q.id).state).toBe('cancelled');
    expect(e.launches.filter((l) => l.workKey === directiveKey(directiveId))).toEqual([]);
    expect(e.ctx.store.activity.search({ text: '끝난 일의', limit: 10 }).map((a) => a.text)).toEqual([
      `끝난 일의 검수자 배정 업무 정리 — ${t1.id}이(가) 이미 검수를 통과함 (${directiveKey(directiveId)}, 다시 전달하지 않음)`,
    ]);
  });
});
