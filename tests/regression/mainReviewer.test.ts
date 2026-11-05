/**
 * 메인 에이전트 대체 검수 (REV-06 v0.6, SERVER_DESIGN 2.6·2.7·10.1 mainReviewer):
 * - 적격 검수 팀원이 없으면 M-MAIN이 검수자다 — 검수 업무가 메인의 검수 세션(review:T)으로 가고, 그 턴은 검수 사본에서 검수 도구만 열린 채(역할 reviewer) 돈다.
 *   메인 판정 전에는 병합 요청이 거부되고, 대표 할 일·대표 검수 알림은 없다. 메인이 통과하면 그 검수 턴 마무리가 병합 판단을 프로듀서에게 넣는다
 * - 재시작해도 자동 통과되지 않는다 — 메인의 검수 업무가 되살아날 뿐이다
 * - M-MAIN이 그 작업의 기여자면 대신 검수하지 않는다: 보류(검수자 없음) + 메인에게 '검수자 없음' 업무. 검수 권한 팀원을 더해 재개하면 그 팀원에게 간다
 * - assign_reviewer의 "main"은 메인 에이전트이고 "owner"(대표 검수)는 거부된다
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Task } from '@shared/domain';
import { MAIN_AGENT_ID } from '@shared/domain';
import { rolesFor, TOOL_SPECS } from '../../src/main/mcp/catalog';
import { directiveKey, reviewKey } from '../../src/main/orchestrator/records';
import { notices, seedDirective, seedInReviewTask, startReview, waitFor, type OrchEnv } from './orchHarness';
import { bootSessions, type SessEnv } from '../acceptance/sessions-helpers';
import { bootRestartable, seedDirective as seedRestartDirective, seedInReviewTask as seedRestartReview, waitUntil, type RestartableEnv } from '../acceptance/stops-helpers';

let env: SessEnv | null = null;
let renv: RestartableEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
  await renv?.close();
  renv = null;
});

const PASS = (t: Task) => ({ task_id: t.id, verdict: 'pass', criteria: t.acceptanceCriteria.map((c) => ({ criterion: c, pass: true, note: '확인' })), reason: '' });
const visibleTools = (who: Parameters<typeof rolesFor>[0]) => TOOL_SPECS.filter((t) => t.roles.some((r) => rolesFor(who).includes(r))).map((t) => t.name).sort();
/** 프로듀서 지시 세션 신원으로 앱 도구 호출 (병합 요청 시험) */
const producerTool = (e: OrchEnv, directiveId: string, tool: string, args: Record<string, unknown>) =>
  e.core.tools.handle(
    { turnId: 'TN-producer-x', sessionId: 'S-producer-x', sessionKey: directiveKey(directiveId), sessionKind: 'directive', memberId: e.producerId, projectId: e.projectId, isMain: false, isProducer: true, canReview: true },
    tool,
    args,
  );

describe('적격 검수 팀원이 없으면 메인 에이전트가 검수한다 (REV-06 v0.6)', () => {
  it('기본 검수자 규칙의 마지막은 M-MAIN — 검수 업무가 메인의 review:T 세션으로 가고, 검수 사본에서 검수 도구만 열린 채 판정하며, 판정 전에는 병합 요청이 거부된다', async () => {
    const e = (env = await bootSessions());
    await e.internal('members.remove', e.qaId); // 검수 권한 팀원이 없다 (개발자만)
    const d = seedDirective(e);
    const own = e.core.tasks.create({ directiveId: d.id, title: '프로듀서 직접 작업', goal: '목표', type: 'development', assigneeId: e.producerId, acceptanceCriteria: ['동작'], outputMode: 'repo' }, e.producerId);
    expect(own.reviewerId).toBe(MAIN_AGENT_ID);

    const { task, proc, turnId } = await startReview(e, MAIN_AGENT_ID, { outputMode: 'repo', directiveId: d.id });
    const who = e.identity(turnId);
    expect([who.memberId, who.sessionKind, who.sessionKey]).toEqual([MAIN_AGENT_ID, 'review', reviewKey(task.id)]);
    // 그 세션의 역할은 reviewer — 검수 도구만 (메인 운영 도구는 없다)
    expect(visibleTools(who)).toEqual(['get_review_target', 'get_work_context', 'submit_review']);
    // 실행 위치는 그 버전의 검수 사본, 지침에 검수 규칙
    expect(e.ctx.store.sessions.list({ ref2: reviewKey(task.id) })[0]!.cwd).toBe(e.core.tasks.reviewCopyOf(e.ctx.store.tasks.require(task.id)));
    expect(e.prompts.get(turnId)).toContain('## 검수 규칙 (메인 에이전트 대체 검수)');
    // 대표 할 일·대표 검수 알림은 없다
    expect(e.core.views.ownerTodos().map((x) => x.kind as string)).not.toContain('owner_review');
    expect(notices(e, '대표 검수 요청')).toEqual([]);
    // 대표 검수 대기 칸은 타입에서도 지웠다 (리드 결정 21)
    expect(e.core.views.taskView(e.ctx.store.tasks.require(task.id)).review).not.toHaveProperty('awaitingOwner');
    // 메인 판정 전에는 병합 요청이 거부된다
    const early = await producerTool(e, d.id, 'request_merge', { task_id: task.id });
    expect(early.ok).toBe(false);
    // 메인이 검수 도구로 판정한다
    const target = await e.tool(turnId, 'get_review_target', { task_id: task.id });
    expect(target.ok).toBe(true);
    if (target.ok) expect((target.data as { reviewCopyPath: string }).reviewCopyPath).toBe(e.core.tasks.reviewCopyOf(e.ctx.store.tasks.require(task.id)));
    const r = await e.tool(turnId, 'submit_review', PASS(task));
    expect(r.ok).toBe(true);
    expect(e.ctx.store.reviews.list({ ref1: task.id }).map((x) => `${x.reviewerId}:${x.verdict}`)).toEqual([`${MAIN_AGENT_ID}:pass`]);
    // 검수 턴을 마치면 병합 판단이 프로듀서에게 간다 (다른 검수자와 같은 마무리)
    proc.finishOk('통과');
    await waitFor(() => e.ctx.store.queue.list({ state: 'queued' }).some((q) => q.kind === 'merge_decision' && q.taskId === task.id), '병합 판단');
    expect(e.ctx.store.queue.list({ state: 'queued' }).filter((q) => q.kind === 'merge_decision' && q.taskId === task.id).map((q) => q.memberId)).toEqual([e.producerId]);
  });

  it('assign_reviewer: "main"은 메인 에이전트를 검수자로 정하고, "owner"(대표 검수)는 거부된다', async () => {
    const e = (env = await bootSessions());
    const d = seedDirective(e);
    const t = e.core.tasks.create({ directiveId: d.id, title: '작업', goal: '목표', type: 'development', assigneeId: e.devId, acceptanceCriteria: ['동작'], outputMode: 'repo' }, e.producerId);
    const owner = await producerTool(e, d.id, 'assign_reviewer', { task_id: t.id, reviewer_id: 'owner' });
    expect(owner.ok ? null : owner.code).toBe('invalid');
    expect(e.ctx.store.tasks.require(t.id).reviewerId).toBe(e.producerId);
    const main = await producerTool(e, d.id, 'assign_reviewer', { task_id: t.id, reviewer_id: 'main' });
    expect(main).toMatchObject({ ok: true, data: { reviewerId: MAIN_AGENT_ID } });
    expect(e.ctx.store.tasks.require(t.id).reviewerId).toBe(MAIN_AGENT_ID);
  });

  it('M-MAIN이 그 작업의 기여자면 대신 검수하지 않는다 — 작업 보류(검수자 없음)와 메인 업무, 검수 권한 팀원을 더하고 resume_task로 재개하면 그 팀원에게 검수가 간다', async () => {
    const e = (env = await bootSessions());
    await e.internal('members.remove', e.qaId);
    const t = seedInReviewTask(e, MAIN_AGENT_ID, { outputMode: 'repo' });
    e.ctx.store.tasks.patch(t.id, { assigneeId: e.producerId, contributors: [e.producerId, MAIN_AGENT_ID] });
    e.core.tasks.dispatchReview(e.ctx.store.tasks.require(t.id));
    const held = e.ctx.store.tasks.require(t.id);
    expect([held.reviewerId, held.state, held.hold.returnState, held.hold.reasons.map((r) => `${r.kind}/${r.refId}`)]).toEqual([null, 'on_hold', 'in_review', ['error/no_reviewer']]);
    expect(e.ctx.store.queue.list({ ref2: reviewKey(t.id), state: ['queued', 'running'] })).toEqual([]);
    const items = e.ctx.store.queue.list({ ref1: MAIN_AGENT_ID }).filter((q) => q.kind === 'no_reviewer');
    expect(items.map((q) => [q.sessionKey, q.taskId])).toEqual([[`main:${e.projectId}`, t.id]]);
    expect(items[0]!.message).toContain(`resume_task(task_id="${t.id}")`);
    // 같은 작업을 다시 등록해도(재시작 복구 등) 보류·업무는 하나
    e.core.tasks.dispatchReview(e.ctx.store.tasks.require(t.id));
    expect(e.ctx.store.queue.list({ ref1: MAIN_AGENT_ID }).filter((q) => q.kind === 'no_reviewer')).toHaveLength(1);
    // 메인이 검수 권한 팀원을 더하고 재개한다
    const qa = await e.main('add_member', { project_id: e.projectId, role_id: 'qa', reason: '검수자 없음' });
    await e.main('resume_task', { task_id: t.id });
    const cur = e.ctx.store.tasks.require(t.id);
    expect([cur.state, cur.reviewerId]).toEqual(['in_review', qa.memberId]);
    expect(e.ctx.store.queue.list({ ref2: reviewKey(t.id), state: 'queued' }).map((q) => q.memberId)).toEqual([qa.memberId]);
  });
});

describe('메인 검수는 재시작해도 자동 통과되지 않는다', () => {
  it('메인 검수 대기 중 PC가 꺼졌다 켜져도 판정·병합 없이 검수 중 그대로이고, 메인의 검수 업무가 되살아나 메인이 판정해야 이어 간다', async () => {
    let e = (renv = await bootRestartable());
    const d = seedRestartDirective(e);
    const t = seedRestartReview(e, { directiveId: d.id, assigneeId: e.producerId, reviewerId: MAIN_AGENT_ID, title: '메인 검수 대기' });
    e.core.tasks.dispatchReview(e.ctx.store.tasks.require(t.id));
    expect(e.ctx.store.queue.list({ ref2: reviewKey(t.id), state: 'queued' }).map((q) => q.memberId)).toEqual([MAIN_AGENT_ID]);
    // 재시작 전에 그 업무가 사라졌어도(끊긴 턴 정리 등) 재시작 복구가 메인에게 다시 넣는다
    for (const q of e.ctx.store.queue.list({ ref2: reviewKey(t.id), state: 'queued' })) e.ctx.store.queue.put({ ...q, state: 'done', doneAt: e.ctx.now() });
    e.crash();
    e = renv = await e.reboot({ holdAll: true });
    const cur = e.ctx.store.tasks.require(t.id);
    expect([cur.state, cur.reviewerId, cur.review.passed, cur.merge, cur.artifact]).toEqual(['in_review', MAIN_AGENT_ID, null, null, null]);
    expect(e.ctx.store.reviews.list({ ref1: t.id })).toEqual([]);
    expect(e.ctx.store.queue.list({ ref2: reviewKey(t.id), state: ['queued', 'running'] }).map((q) => q.memberId)).toEqual([MAIN_AGENT_ID]);
    await waitUntil(() => !!e.liveProc(reviewKey(t.id), MAIN_AGENT_ID), '메인 검수 턴');
    expect(e.ctx.store.tasks.require(t.id).review.passed).toBeNull();
  });
});
