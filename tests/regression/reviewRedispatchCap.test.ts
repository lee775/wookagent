/**
 * 같은 검수자 재지정의 상한 (리드 결정 17, 10-29 — flows 재리뷰 medium, 프로브 zz-s1fxfg-reassign-loop):
 * - 리드 결정 11로 같은 검수자를 다시 정하면 검수를 다시 등록한다. 그 검수도 판정 없이 끝나면 예전에는 다시 프로듀서에게 같은 검수자를 권해, 메인 에이전트가
 *   유일한 검수자일 때 '메인 검수 턴 3번 → 재배정 업무 → "main" → …'이 끝없이 돌았다(검수 턴 24번 동안 메인 업무 0, 대표 알림 0)
 * - 이제 같은 검수자로 다시 등록한 횟수를 세고, 다시 등록한 검수가 또 판정 없이 끝나면 프로듀서에게 같은 검수자를 권하지 않고 메인 에이전트에게 넘긴다:
 *   main:<P> 업무와 대표 알림(작업·검수자마다 한 번). 메인이 검수자면 업무 글이 '메인 자신의 검수가 판정 없이 끝난다'고 말하고, 할 수 있는 일(검수 팀원 더하기,
 *   판정 직접 남기기, 까닭과 함께 취소)을 적는다
 * - 판정이 기록되거나 다른 검수자가 정해지면 횟수를 지운다
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID, type Task } from '@shared/domain';
import { directiveKey, mainKey, reviewKey } from '../../src/main/orchestrator/records';
import type { OrchEnv } from './orchHarness';
import { bootOrch, seedDirective, seedInReviewTask, sleep, waitFor } from './orchHarness';

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
const live = (e: OrchEnv) => e.ctx.store.queue.list({ state: ['queued', 'running'] });
const reviewItems = (e: OrchEnv, taskId: string) => live(e).filter((q) => q.sessionKey === reviewKey(taskId) && q.kind === 'review');
const assignItems = (e: OrchEnv, taskId: string) => live(e).filter((q) => q.kind === 'reviewer_assign' && q.taskId === taskId);
const mainItems = (e: OrchEnv, taskId: string) => live(e).filter((q) => q.memberId === MAIN_AGENT_ID && q.sessionKey.startsWith('main:') && q.taskId === taskId);
const reviewTurns = (e: OrchEnv, taskId: string) => e.launches.filter((l) => l.workKey === reviewKey(taskId)).length;
const producerTurns = (e: OrchEnv, directiveId: string) => e.launches.filter((l) => l.workKey === directiveKey(directiveId)).length;
const stuckNotices = (e: OrchEnv) => e.ctx.store.notifications.list().filter((n) => n.title === '검수 멈춤');
async function ticks(e: OrchEnv, n: number) {
  for (let i = 0; i < n; i++) {
    e.tick();
    await sleep(30);
  }
}
/** 띄운 채 두는 세션(hold) 밖의 턴이 모두 마무리될 때까지 */
async function settled(e: OrchEnv) {
  await sleep(10);
  await waitFor(() => {
    const open = e.procs.filter((p) => !p.done);
    return open.every((p) => e.hold.has(p.workKey)) && e.core.turns.count() === open.length;
  }, '턴 마무리');
  await sleep(10);
}
/** 틱을 돌리다 조건이 맞거나 검수 턴이 상한에 닿으면 멈춘다 (고치기 전 코드는 끝없이 돈다) */
async function tickUntil(e: OrchEnv, done: () => boolean, label: string, taskId: string, maxReviewTurns: number) {
  await waitFor(
    () => {
      e.tick();
      return done() || reviewTurns(e, taskId) >= maxReviewTurns;
    },
    label,
    30_000,
  );
  await settled(e);
}

/** 적격 팀원이 없어 메인 에이전트가 검수자인 프로듀서 직접 작업 — 메인 검수 턴(가짜 CLI)은 판정 없이 끝난다 */
async function mainOnlyReviewer(e: OrchEnv, directiveId: string): Promise<Task> {
  await e.internal('members.remove', e.qaId);
  const t = seedInReviewTask(e, MAIN_AGENT_ID, { outputMode: 'repo', directiveId });
  e.ctx.store.tasks.patch(t.id, { assigneeId: e.producerId, contributors: [e.producerId] });
  return e.ctx.store.tasks.require(t.id);
}

describe('같은 검수자로 다시 등록한 검수가 또 판정 없이 끝나면 메인 에이전트에게 넘긴다 (리드 결정 17)', () => {
  it('메인 에이전트가 유일한 검수자이고 프로듀서가 안내대로 "main"만 다시 고르면: 두 번째 지연에서 메인 업무와 대표 알림 하나로 넘기고 더 돌지 않는다', async () => {
    const e = (env = await bootOrch());
    const d = seedDirective(e);
    const t = await mainOnlyReviewer(e, d.id);
    // 메인 에이전트의 프로젝트·일반 세션 턴은 띄운 채 둔다 — 넘겨받은 업무가 대기·실행 중으로 그대로 보인다
    e.hold.add(mainKey(e.projectId));
    e.hold.add(mainKey(null));
    // 프로듀서는 재배정 업무를 받을 때마다 안내대로 같은 검수자 "main"을 다시 정한다 (모의 프로듀서와 같다)
    const picks: Record<string, unknown>[] = [];
    e.script.set(directiveKey(d.id), (p) => {
      void e
        .tool(p.turnId, 'assign_reviewer', { task_id: t.id, reviewer_id: 'main' })
        .then((r) => picks.push((r.ok ? r.data : {}) as Record<string, unknown>))
        .finally(() => p.finishOk());
    });
    e.core.tasks.dispatchReview(e.ctx.store.tasks.require(t.id));
    await tickUntil(e, () => mainItems(e, t.id).length > 0, '메인 에이전트에게 넘긴 업무', t.id, 12);

    // 메인 검수 턴 3번 → 프로듀서가 "main"을 다시 정함(검수 다시 등록) → 메인 검수 턴 3번 → 메인 에이전트에게. 프로듀서에게 다시 권하지 않는다
    expect(reviewTurns(e, t.id)).toBe(6);
    expect(producerTurns(e, d.id)).toBe(1);
    expect(picks).toEqual([{ taskId: t.id, reviewerId: MAIN_AGENT_ID, reviewRequeued: true }]);
    const items = mainItems(e, t.id);
    expect(items.map((q) => [q.kind, q.sessionKey, q.priority, q.directiveId])).toEqual([['message', mainKey(e.projectId), 'high', d.id]]);
    const msg = items[0]!.message;
    expect(msg).toContain(`${t.id} "${t.title}" 검수가 멈췄습니다 — 메인 에이전트 자신의 검수 턴이 판정 없이 반복해서 끝납니다 (검수 결과가 반복해서 등록되지 않았습니다)`);
    expect(msg).toContain('같은 검수자 "main"을 다시 정해 검수를 1번 다시 등록했지만 이번에도 판정이 없어');
    // 할 수 있는 일: 검수 팀원 더하기와 메인의 assign_reviewer, 판정 직접 남기기, 까닭과 함께 취소 — 같은 "main"을 다시 정하라고 권하지 않는다. 이 작업은 프로듀서가
    // 직접 한 작업이라 프로듀서에게 보내는 지시는 검수 중인 이 작업 세션으로 가 처리되지 않으므로 프로듀서에게 지시하라고도 권하지 않는다 (리드 결정 45·S5-11)
    expect(msg).toMatch(/add_member로 더한 뒤 assign_reviewer.*interrupt_task 뒤 resume_task.*cancel_task/s);
    expect(msg).not.toContain('instruct_member로 assign_reviewer를 지시');
    expect(msg).toContain(`interrupt_task 뒤 resume_task(task_id="${t.id}")로 검수를 다시 등록하고, 그 검수 턴에서 submit_review로 결과를 꼭 등록하세요`);
    expect(msg).toContain('cancel_task로 까닭을 적어 취소');
    expect(msg).not.toContain('"main"을 다시 정해 메인 에이전트 검수를 다시 시작하세요');
    expect(msg).not.toContain('지시하세요(instruct_member)');
    // 대표 알림 하나, 활동 기록
    expect(stuckNotices(e).map((n) => [n.body, n.key])).toEqual([
      [
        `${d.id}: ${t.id} 검수가 같은 검수자(메인 에이전트)로 다시 해도 판정 없이 끝나 메인 에이전트에게 넘겼습니다. 메인 에이전트가 확인하고 이어 갑니다 — 서둘러야 하면 명령창으로 메인 에이전트에게 알려 주세요`,
        `review-stuck:${t.id}:${MAIN_AGENT_ID}`,
      ],
    ]);
    expect(e.ctx.store.activity.search({ text: '같은 검수자(메인 에이전트)로 다시 등록한 검수도 판정 없이 끝나 메인 에이전트에게 넘김', limit: 10 }).map((a) => a.taskId)).toEqual([t.id]);
    // 검수 중 작업에는 처리할 수 있는 쪽(메인 에이전트)의 업무가 있다 (리드 결정 11). 재배정 업무·검수는 없다
    expect(e.ctx.store.tasks.require(t.id)).toMatchObject({ state: 'in_review', reviewerId: MAIN_AGENT_ID });
    expect(assignItems(e, t.id)).toEqual([]);
    expect(reviewItems(e, t.id)).toEqual([]);
    // 더 돌지 않는다
    await ticks(e, 10);
    expect([reviewTurns(e, t.id), producerTurns(e, d.id)]).toEqual([6, 1]);

    // 대표가 알림을 읽은 뒤, 메인 에이전트가 판정을 직접 남기려고 검수를 다시 등록했는데(interrupt_task → resume_task) 그 검수도 판정 없이 끝나면 다시 메인에게
    // 넘긴다 — 프로듀서는 거치지 않고, 같은 작업·검수자의 대표 알림은 다시 보내지 않는다
    await e.invoke('notifications.markRead', stuckNotices(e)[0]!.id);
    // 메인 에이전트가 넘겨받은 업무의 턴을 마친다 (한 팀원은 한 번에 한 턴 — 메인 검수 턴이 뜰 수 있게)
    e.hold.clear();
    for (const p of e.procs.filter((x) => x.workKey.startsWith('main:') && !x.done)) p.finishOk();
    await settled(e);
    await e.main('interrupt_task', { task_id: t.id, then: 'hold' });
    await e.main('resume_task', { task_id: t.id });
    expect(reviewItems(e, t.id).map((q) => q.memberId)).toEqual([MAIN_AGENT_ID]);
    const mainTurnsBefore = e.launches.filter((l) => l.workKey === mainKey(e.projectId)).length;
    await tickUntil(e, () => reviewTurns(e, t.id) >= 9 && reviewItems(e, t.id).length === 0 && !e.core.turns.hasLiveSession(reviewKey(t.id)), '다시 등록한 메인 검수 턴 3번', t.id, 15);
    await ticks(e, 10);
    await settled(e);
    expect([reviewTurns(e, t.id), producerTurns(e, d.id)]).toEqual([9, 1]);
    expect(assignItems(e, t.id)).toEqual([]);
    // 다시 메인 에이전트의 프로젝트 세션 턴에 실린다
    const again = e.launches.filter((l) => l.workKey === mainKey(e.projectId)).slice(mainTurnsBefore);
    expect(again.some((l) => l.message.includes(`${t.id} "${t.title}" 검수가 멈췄습니다 — 메인 에이전트 자신의 검수 턴이 판정 없이 반복해서 끝납니다`))).toBe(true);
    expect(stuckNotices(e)).toHaveLength(1);
    expect(e.ctx.store.activity.search({ text: '같은 검수자(메인 에이전트)로 다시 등록한 검수도 판정 없이 끝나 메인 에이전트에게 넘김', limit: 10 })).toHaveLength(2);
  });

  it('팀원 검수자(QA)도 같다 — 다시 등록한 QA 검수가 또 판정 없이 끝나면 메인 에이전트에게 넘기고, 업무 글은 같은 QA를 다시 권하지 않는다', async () => {
    const e = (env = await bootOrch());
    const d = seedDirective(e);
    const t = seedInReviewTask(e, e.qaId, { outputMode: 'repo', directiveId: d.id });
    e.hold.add(mainKey(e.projectId));
    e.script.set(directiveKey(d.id), (p) => {
      void e.tool(p.turnId, 'assign_reviewer', { task_id: t.id, reviewer_id: e.qaId }).finally(() => p.finishOk());
    });
    e.core.tasks.dispatchReview(e.ctx.store.tasks.require(t.id));
    await tickUntil(e, () => mainItems(e, t.id).length > 0, '메인 에이전트에게 넘긴 업무', t.id, 12);

    expect([reviewTurns(e, t.id), producerTurns(e, d.id)]).toEqual([6, 1]);
    const msg = mainItems(e, t.id)[0]!.message;
    expect(msg).toContain(`검수자 ${e.qaId}의 검수 턴이 판정 없이 반복해서 끝납니다`);
    expect(msg).toContain('같은 검수자를 다시 정해 검수를 1번 다시 등록했지만');
    // 메인이 assign_reviewer로 직접 다른 검수자를 정한다 — add_member 다음 (리드 결정 48·S5-11). 프로듀서에게 맡기는 길은 마지막에
    expect(msg).toContain(`검수 권한 팀원이 없으면 add_member로 더한 뒤 assign_reviewer(task_id="${t.id}", reviewer_id="…")로 다른 적격 검수자나 "main"(메인 에이전트)을 정하세요`);
    expect(msg).toContain('프로듀서에게 맡기려면 instruct_member로 assign_reviewer를 지시해도 됩니다.');
    expect(msg).not.toContain(`같은 검수자(${e.qaId})를 다시 정해 검수를 다시 시작하세요`);
    expect(stuckNotices(e).map((n) => n.key)).toEqual([`review-stuck:${t.id}:${e.qaId}`]);
    expect(stuckNotices(e)[0]!.body).toContain(`같은 검수자(${e.qaId})로 다시 해도 판정 없이 끝나`);
    expect(assignItems(e, t.id)).toEqual([]);
    await ticks(e, 10);
    expect([reviewTurns(e, t.id), producerTurns(e, d.id)]).toEqual([6, 1]);
  });

  it('다른 검수자를 정하면 횟수를 지운다 — "main" → QA → "main"으로 바꾼 뒤의 첫 지연은 다시 프로듀서에게 간다(같은 "main"을 권함)', async () => {
    const e = (env = await bootOrch());
    const d = seedDirective(e);
    const t = seedInReviewTask(e, MAIN_AGENT_ID, { outputMode: 'repo', directiveId: d.id });
    e.hold.add(directiveKey(d.id)); // 프로듀서 턴은 띄운 채 둔다 — 재배정 업무가 대기·실행 중으로 보인다
    e.hold.add(mainKey(e.projectId));
    e.core.tasks.dispatchReview(e.ctx.store.tasks.require(t.id));
    await tickUntil(e, () => assignItems(e, t.id).length > 0, '첫 재배정 업무', t.id, 6);
    expect(await producerTool(e, d.id, 'assign_reviewer', { task_id: t.id, reviewer_id: 'main' })).toMatchObject({ ok: true, data: { reviewRequeued: true } });
    // QA로 바꿨다가 다시 "main"으로 — 같은 검수자 다시 등록이 아니라 검수자 변경이다
    expect(await producerTool(e, d.id, 'assign_reviewer', { task_id: t.id, reviewer_id: e.qaId })).toMatchObject({ ok: true, data: { reviewerId: e.qaId } });
    const back = await producerTool(e, d.id, 'assign_reviewer', { task_id: t.id, reviewer_id: 'main' });
    expect(back.ok && (back.data as Record<string, unknown>).reviewRequeued).toBeUndefined();
    for (const p of e.procs.filter((x) => x.workKey === directiveKey(d.id))) p.finishOk();
    await settled(e);
    const before = reviewTurns(e, t.id);
    await tickUntil(e, () => reviewTurns(e, t.id) >= before + 3 && !e.core.turns.hasLiveSession(reviewKey(t.id)) && reviewItems(e, t.id).length === 0, '메인 검수 턴 3번', t.id, before + 6);
    // 다시 등록한 적이 없는 것으로 보고 프로듀서에게 같은 "main"도 권한다 — 메인 에이전트에게 넘기지 않는다
    const ra = assignItems(e, t.id);
    expect(ra).toHaveLength(1);
    expect(ra[0]!.message).toContain('같은 검수자 "main"을 다시 정해 메인 에이전트 검수를 다시 시작하세요');
    expect(mainItems(e, t.id)).toEqual([]);
    expect(stuckNotices(e)).toEqual([]);
  });

  it('판정이 기록되면 횟수를 지운다 — 반려 뒤 다시 검수에 온 작업의 첫 지연은 다시 프로듀서에게 간다', async () => {
    const e = (env = await bootOrch());
    const d = seedDirective(e);
    const t = await mainOnlyReviewer(e, d.id);
    e.hold.add(directiveKey(d.id));
    e.hold.add(mainKey(e.projectId));
    e.core.tasks.dispatchReview(e.ctx.store.tasks.require(t.id));
    await tickUntil(e, () => assignItems(e, t.id).length > 0, '첫 재배정 업무', t.id, 6);
    expect(await producerTool(e, d.id, 'assign_reviewer', { task_id: t.id, reviewer_id: 'main' })).toMatchObject({ ok: true, data: { reviewRequeued: true } });
    // 다시 등록한 메인 검수 턴에서 메인 에이전트가 반려를 등록한다
    e.script.set(reviewKey(t.id), (p) => {
      void e
        .tool(p.turnId, 'submit_review', { task_id: t.id, verdict: 'reject', criteria: [{ criterion: '문서가 있다', pass: false, note: '없음' }], reason: '문서가 없습니다' })
        .finally(() => p.finishOk());
    });
    await tickUntil(e, () => e.ctx.store.tasks.require(t.id).state !== 'in_review', '메인 검수 반려', t.id, 12);
    expect(e.ctx.store.reviews.list({ ref1: t.id }).map((r) => [r.reviewerId, r.verdict])).toEqual([[MAIN_AGENT_ID, 'reject']]);
    e.script.delete(reviewKey(t.id));
    for (const p of e.procs.filter((x) => x.workKey === directiveKey(d.id))) p.finishOk();
    await settled(e);
    // 작업자가 고쳐 다시 제출했다 — 다시 고정돼 검수 중 (검수 사본 폴더가 있는 같은 커밋 값, 새 고정 시각)
    const cur = e.ctx.store.tasks.require(t.id);
    const target = { kind: 'repo' as const, taskCommitSha: 'a'.repeat(40), baseMainSha: 'b'.repeat(40), pinnedAt: e.ctx.now() };
    e.ctx.store.tasks.put({ ...cur, state: 'in_review', review: { ...cur.review, target, passed: null } });
    for (const q of e.ctx.store.queue.list({ state: 'queued' }).filter((x) => x.taskId === t.id)) e.ctx.store.queue.put({ ...q, state: 'cancelled', doneAt: e.ctx.now() });
    const before = reviewTurns(e, t.id);
    e.core.tasks.dispatchReview(e.ctx.store.tasks.require(t.id));
    await tickUntil(e, () => assignItems(e, t.id).length > 0 || mainItems(e, t.id).length > 0, '새 버전 검수 지연', t.id, before + 6);
    expect(reviewTurns(e, t.id)).toBe(before + 3);
    expect(assignItems(e, t.id)).toHaveLength(1);
    expect(mainItems(e, t.id)).toEqual([]);
  });
});
