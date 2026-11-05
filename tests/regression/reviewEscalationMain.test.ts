/**
 * 검수 지연 → 검수자 재배정이 막다른 길이 되지 않는다 (리드 결정 11, 10-29 — flows M1, 프로브 zz-s1fg-escalate):
 * - 검수 턴이 판정 없이 반복해서 끝나면 프로듀서에게 검수자 재배정 업무(reviewer_assign)가 간다. 안내는 실제로 통하는 길만 말한다
 * - 같은 검수자를 다시 정하면(assign_reviewer — 메인 에이전트가 유일한 대체 검수자면 "main") 검수 중·통과 전이고 대기·실행 중인 검수가 없을 때 그 검수자에게
 *   검수를 다시 등록한다. 예전에는 검수자가 같다며 아무것도 하지 않아 작업이 검수 중인 채 아무도 검수하지 않았다
 * - 프로듀서가 재배정 업무를 처리하지 않고 턴을 마치면 다시 재촉하고, 재촉 상한이면 메인 에이전트에게 업무로 넘긴다 — 검수 중 작업에는 늘 대기·실행 중인
 *   검수나, 처리할 수 있는 쪽의 업무가 있다
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID, type Task } from '@shared/domain';
import { directiveKey, mainKey, reviewKey } from '../../src/main/orchestrator/records';
import { reviewerAssignHint } from '../../src/main/orchestrator/turns';
import type { OrchEnv } from './orchHarness';
import { bootOrch, seedDirective, seedInReviewTask, sleep, startReview, waitFor } from './orchHarness';

let env: OrchEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const producerTool = (e: OrchEnv, directiveId: string, tool: string, args: Record<string, unknown>) =>
  e.core.tools.handle(
    { turnId: 'TN-producer-x', sessionId: 'S-producer-x', sessionKey: directiveKey(directiveId), sessionKind: 'directive', memberId: e.producerId, projectId: e.projectId, isMain: false, isProducer: true, canReview: true },
    tool,
    args,
  );
const reviewItems = (e: OrchEnv, taskId: string) => e.ctx.store.queue.list({ ref2: reviewKey(taskId), state: ['queued', 'running'] }).filter((q) => q.kind === 'review');
const assignItems = (e: OrchEnv, taskId: string) => e.ctx.store.queue.list({ state: ['queued', 'running'] }).filter((q) => q.kind === 'reviewer_assign' && q.taskId === taskId);
const reviewLaunches = (e: OrchEnv, taskId: string) => e.launches.filter((l) => l.workKey === reviewKey(taskId));
async function ticks(e: OrchEnv, n: number) {
  for (let i = 0; i < n; i++) {
    e.tick();
    await sleep(30);
  }
}

/** 적격 팀원이 없어 메인 에이전트가 검수자인 프로듀서 직접 작업 — 메인 검수 턴은 가짜 CLI라 판정 없이 끝난다 */
async function mainOnlyReviewer(e: OrchEnv, directiveId: string): Promise<Task> {
  const t = seedInReviewTask(e, MAIN_AGENT_ID, { outputMode: 'repo', directiveId });
  e.ctx.store.tasks.patch(t.id, { assigneeId: e.producerId, contributors: [e.producerId] });
  return e.ctx.store.tasks.require(t.id);
}

describe('검수 지연 → 같은 검수자 재지정은 검수를 다시 등록한다 (리드 결정 11)', () => {
  it('메인 에이전트가 유일한 검수자일 때: 판정 없는 메인 검수 턴 3번 → 재배정 업무의 안내대로 "main"을 다시 정하면 메인 검수가 다시 등록되고 메인 검수 턴이 뜬다', async () => {
    const e = (env = await bootOrch());
    await e.internal('members.remove', e.qaId);
    const d = seedDirective(e);
    const t = await mainOnlyReviewer(e, d.id);
    e.hold.add(directiveKey(d.id)); // 프로듀서 턴은 띄우지 않고 재배정 업무를 그대로 본다
    e.core.tasks.dispatchReview(e.ctx.store.tasks.require(t.id));
    await waitFor(
      () => {
        e.tick();
        return assignItems(e, t.id).length > 0;
      },
      '검수자 재배정 업무',
      20_000,
    );
    await waitFor(() => !e.core.turns.hasLiveSession(reviewKey(t.id)), '메인 검수 턴 종료');
    const ra = assignItems(e, t.id);
    expect(ra.map((q) => [q.memberId, q.sessionKey])).toEqual([[e.producerId, directiveKey(d.id)]]);
    // 안내는 실제로 통하는 길만: 같은 "main"을 다시 정하면 메인 검수를 다시 시작한다 (예전 안내 '"main"으로 메인 에이전트 검수를 요청'은 아무 일도 하지 않았다)
    expect(ra[0]!.message).toContain('(검수자 메인 에이전트)');
    expect(ra[0]!.message).toContain('같은 검수자 "main"을 다시 정해 메인 에이전트 검수를 다시 시작하세요');
    expect(ra[0]!.message).not.toContain('"main"으로 메인 에이전트 검수를 요청');
    expect(e.ctx.store.tasks.require(t.id)).toMatchObject({ state: 'in_review', reviewerId: MAIN_AGENT_ID });
    expect(reviewItems(e, t.id)).toEqual([]);

    const before = reviewLaunches(e, t.id).length;
    expect(before).toBe(3);
    const r = await producerTool(e, d.id, 'assign_reviewer', { task_id: t.id, reviewer_id: 'main' });
    expect(r).toMatchObject({ ok: true, data: { reviewerId: MAIN_AGENT_ID, reviewRequeued: true } });
    // 검수가 메인 에이전트에게 다시 등록되고 기록이 남는다
    expect(reviewItems(e, t.id).map((q) => [q.memberId, q.state])).toEqual([[MAIN_AGENT_ID, 'queued']]);
    expect(e.ctx.store.activity.search({ text: '대기·실행 중인 검수가 없어 검수를 다시 등록', limit: 10 }).map((a) => a.taskId)).toEqual([t.id]);
    expect(e.ctx.store.activity.search({ text: '검수자 배정 → 메인 에이전트 (같은 검수자 — 검수를 다시 등록)', limit: 10 }).map((a) => a.actor)).toEqual([e.producerId]);
    // 메인 검수 턴이 다시 뜬다
    await waitFor(
      () => {
        e.tick();
        return reviewLaunches(e, t.id).length > before;
      },
      '다시 뜬 메인 검수 턴',
      10_000,
    );
    expect(reviewLaunches(e, t.id)[before]!.memberId).toBe(MAIN_AGENT_ID);
  });

  it('팀원 검수자(QA)도 같다 — 헛돈 검수의 재배정 업무에서 같은 QA를 다시 정하면 검수가 다시 등록되고, 이미 검수가 대기 중이면 겹쳐 만들지 않는다', async () => {
    const e = (env = await bootOrch());
    const { task, turnId, proc } = await startReview(e, e.qaId);
    e.hold.add(directiveKey(task.directiveId));
    for (let i = 0; i < 5; i++) proc.emit({ kind: 'error', text: '같은 오류', data: {} });
    await e.idle();
    expect(e.ctx.store.turns.require(turnId).endReason).toBe('spin');
    const ra = assignItems(e, task.id);
    expect(ra).toHaveLength(1);
    expect(ra[0]!.message).toContain(`같은 검수자(${e.qaId})를 다시 정해 검수를 다시 시작하세요`);
    expect(ra[0]!.message).toContain('"main"(메인 에이전트)');
    expect(reviewItems(e, task.id)).toEqual([]);

    const r = await producerTool(e, task.directiveId, 'assign_reviewer', { task_id: task.id, reviewer_id: e.qaId });
    expect(r).toMatchObject({ ok: true, data: { reviewerId: e.qaId, reviewRequeued: true } });
    expect(reviewItems(e, task.id).map((q) => [q.memberId, q.state])).toEqual([[e.qaId, 'queued']]);
    // 이미 검수가 대기 중이면 같은 검수자 재지정은 아무것도 더 하지 않는다 (항목 하나, 다시 등록 표시 없음)
    const again = await producerTool(e, task.directiveId, 'assign_reviewer', { task_id: task.id, reviewer_id: e.qaId });
    expect(again.ok).toBe(true);
    expect(again.ok && (again.data as Record<string, unknown>).reviewRequeued).toBeUndefined();
    expect(reviewItems(e, task.id)).toHaveLength(1);
  });

  it('안내 글: 메인 에이전트가 검수할 수 없는 작업(기여자)이면 "main"을 권하지 않는다', () => {
    const base = { id: 'T-0009', reviewerId: 'M-0003', assigneeId: 'M-0002', contributors: ['M-0002'] } as unknown as Task;
    expect(reviewerAssignHint(base)).toBe('assign_reviewer로 다른 적격 검수자나 "main"(메인 에이전트)을 정하거나, 같은 검수자(M-0003)를 다시 정해 검수를 다시 시작하세요.');
    const mainContributed = { ...base, contributors: ['M-0002', MAIN_AGENT_ID] } as Task;
    expect(reviewerAssignHint(mainContributed)).toBe('assign_reviewer로 다른 적격 검수자를 정하거나, 같은 검수자(M-0003)를 다시 정해 검수를 다시 시작하세요. 메인 에이전트는 이 작업에 기여해 검수할 수 없습니다.');
    expect(reviewerAssignHint(mainContributed)).not.toContain('"main"');
    expect(reviewerAssignHint({ ...base, reviewerId: MAIN_AGENT_ID } as Task)).toContain('같은 검수자 "main"을 다시 정해');
  });

  it('프로듀서가 재배정 업무를 처리하지 않고 턴을 마치면 다시 재촉하고(2번), 그래도 정하지 않으면 메인 에이전트에게 업무로 넘긴다 — 검수 중 작업이 할 일 없이 남지 않는다', async () => {
    const e = (env = await bootOrch());
    await e.internal('members.remove', e.qaId);
    const d = seedDirective(e);
    const t = await mainOnlyReviewer(e, d.id);
    e.hold.add(mainKey(e.projectId)); // 메인 에이전트의 프로젝트 세션 턴은 띄운 채 둔다 (넘겨받은 업무를 본다)
    e.core.tasks.dispatchReview(e.ctx.store.tasks.require(t.id));
    const mainItems = () => e.ctx.store.queue.list({ ref2: mainKey(e.projectId), state: ['queued', 'running'] }).filter((q) => q.kind === 'message' && q.taskId === t.id);
    // 메인 검수 턴 3번 → 재배정 업무 → 프로듀서 턴(가짜 CLI, 아무것도 하지 않음) 3번 → 메인 에이전트에게
    await waitFor(
      () => {
        e.tick();
        return mainItems().length > 0;
      },
      '메인 에이전트에게 넘긴 업무',
      30_000,
    );
    const producerTurns = e.launches.filter((l) => l.workKey === directiveKey(d.id));
    expect(producerTurns).toHaveLength(3);
    expect(producerTurns[0]!.message).toContain(`${t.id} 검수 결과가 반복해서 등록되지 않았습니다 (검수자 메인 에이전트)`);
    for (const l of producerTurns.slice(1)) expect(l.message).toContain(`${t.id} 검수가 멈춰 있습니다 — 아직 검수자(지금 메인 에이전트)를 다시 정하지 않았습니다`);
    const item = mainItems()[0]!;
    expect(item).toMatchObject({ memberId: MAIN_AGENT_ID, priority: 'high', directiveId: d.id });
    expect(item.message).toContain(`${t.id} "${t.title}" 검수가 멈췄습니다`);
    expect(item.message).toContain('3번의 턴에서 정하지 않았습니다');
    // 이 작업은 프로듀서가 직접 한 작업이라 프로듀서에게 보내는 지시는 검수 중인 이 작업 세션으로 가 처리되지 않는다 — 그 길은 권하지 않고
    // add_member 다음 메인의 assign_reviewer를 앞세운다 (리드 결정 45·48·S5-11, 프로브 zz-s1fx5fg-handoff-instruct-own-task)
    expect(item.message).toMatch(/add_member로 더한 뒤 assign_reviewer\(task_id="T-\d+".*cancel_task/);
    expect(item.message).not.toMatch(/지시하거나\(instruct_member\)|지시하세요\(instruct_member\)|instruct_member로 assign_reviewer를 지시/);
    expect(e.ctx.store.notifications.list().filter((n) => n.title === '프로듀서 처리 지연').map((n) => n.body)).toEqual([
      `${d.id}: ${t.id} 검수자를 다시 정하지 않아 메인 에이전트에게 넘겼습니다. 메인 에이전트가 확인하고 이어 갑니다 — 서둘러야 하면 명령창으로 메인 에이전트에게 알려 주세요`,
    ]);
    expect(e.ctx.store.tasks.require(t.id)).toMatchObject({ state: 'in_review', reviewerId: MAIN_AGENT_ID });
    // 더 재촉하지 않는다 (프로듀서 턴이 더 뜨지 않는다)
    await ticks(e, 10);
    expect(e.launches.filter((l) => l.workKey === directiveKey(d.id))).toHaveLength(3);
    expect(assignItems(e, t.id)).toEqual([]);
  });

  it('재배정 업무를 실은 프로듀서 턴이 비정상 종료 재시도를 다 쓰면(그 업무는 다시 넣지 않는다) 멈춘 검수를 곧바로 메인 에이전트에게 넘긴다', async () => {
    const e = (env = await bootOrch());
    await e.internal('members.remove', e.qaId);
    const d = seedDirective(e);
    const t = await mainOnlyReviewer(e, d.id);
    e.hold.add(mainKey(e.projectId));
    e.script.set(directiveKey(d.id), (p) => p.exit(1)); // 프로듀서 턴은 매번 결과 없이 끝난다
    e.core.tasks.dispatchReview(e.ctx.store.tasks.require(t.id));
    const mainItems = () => e.ctx.store.queue.list({ ref2: mainKey(e.projectId), state: ['queued', 'running'] }).filter((q) => q.kind === 'message' && q.taskId === t.id);
    await waitFor(
      () => {
        e.tick();
        return mainItems().length > 0;
      },
      '메인 에이전트에게 넘긴 업무',
      30_000,
    );
    const producerTurns = e.ctx.store.turns.list().filter((x) => x.directiveId === d.id && x.memberId === e.producerId);
    expect(producerTurns.map((x) => x.endReason)).toEqual(['crashed', 'crashed', 'crashed']);
    expect(mainItems()[0]!.message).toContain('프로듀서 턴이 비정상 종료로 반복해서 끝났습니다');
    expect(e.ctx.store.tasks.require(t.id)).toMatchObject({ state: 'in_review', reviewerId: MAIN_AGENT_ID });
    expect(assignItems(e, t.id)).toEqual([]);
  });

  it('이미 통과한 검수 중 작업(병합 판단 대기)에 같은 검수자를 다시 정하면 검수를 다시 등록하지 않는다 — 다시 등록은 통과 전일 때만 (리드 결정 11·20)', async () => {
    const e = (env = await bootOrch());
    const d = seedDirective(e);
    const t = seedInReviewTask(e, e.qaId, { outputMode: 'repo', directiveId: d.id });
    const cur = e.ctx.store.tasks.require(t.id);
    // QA가 이 버전을 이미 통과시켰다 — 다음 단계는 프로듀서의 병합 판단이다
    e.ctx.store.tasks.patch(t.id, { review: { ...cur.review, passed: { reviewId: 'RV-pass', reviewerId: e.qaId, at: e.ctx.now(), target: cur.review.target! } } });
    expect(reviewItems(e, t.id)).toEqual([]);
    const r = await producerTool(e, d.id, 'assign_reviewer', { task_id: t.id, reviewer_id: e.qaId });
    expect(r).toMatchObject({ ok: true, data: { taskId: t.id, reviewerId: e.qaId } });
    expect(r.ok && (r.data as Record<string, unknown>).reviewRequeued).toBeUndefined();
    // 새 검수 항목이 생기지 않고, 통과 기록은 그대로다
    expect(reviewItems(e, t.id)).toEqual([]);
    expect(e.ctx.store.queue.list({ ref2: reviewKey(t.id) })).toEqual([]);
    expect(e.ctx.store.tasks.require(t.id)).toMatchObject({ state: 'in_review', review: { passed: { reviewId: 'RV-pass', reviewerId: e.qaId } } });
    expect(e.ctx.store.activity.search({ text: '검수를 다시 등록', limit: 10 })).toEqual([]);
  });
});
