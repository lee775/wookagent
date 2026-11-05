/**
 * v0.6 데이터 이전 — 대표 검수를 메인 에이전트 검수로 (SERVER_DESIGN 2.7·10.1 'DB 이전: 검수자 owner는 M-MAIN으로 바꾸고 검수 업무를 넣는다', migrations.ts).
 * 예전 DB에서 검수자가 'owner'(대표)이던 끝나지 않은 작업은 시작 때 M-MAIN 검수로 바뀌고, 검수 중이면 메인 에이전트의 검수 세션(review:T)에 검수 업무가
 * 들어가 메인이 판정해야 이어 간다(자동 통과 없음). M-MAIN이 그 작업의 기여자면 검수자 없음으로 보류하고 메인에게 알린다. 끝난 작업의 검수자 칸·대표
 * 판정 기록은 이력으로 둔다. 남은 '대표 검수 요청' 알림은 읽음으로. 다시 시작해도(중간에 꺼져도) 같은 결과이고 이전 기록·업무는 늘지 않는다
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { ReviewRecord, Task } from '@shared/domain';
import { MAIN_AGENT_ID, OWNER } from '@shared/domain';
import { rolesFor } from '../../src/main/mcp/catalog';
import { bootRestartable, seedDirective, seedInReviewTask, waitUntil, type RestartableEnv } from '../acceptance/stops-helpers';

let env: RestartableEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const migrationRows = (e: RestartableEnv) => e.ctx.store.activity.search({ text: '대표 검수 작업', limit: 50 }).filter((a) => a.text.startsWith('데이터 이전 (v0.6 권한 모델)'));
const reviewEntries = (e: RestartableEnv, taskId: string) => e.ctx.store.queue.list({ ref2: `review:${taskId}` }).filter((q) => q.kind === 'review' && q.state !== 'cancelled');
const PASS = (t: Task) => ({ task_id: t.id, verdict: 'pass', criteria: t.acceptanceCriteria.map((c) => ({ criterion: c, pass: true, note: '확인' })), reason: '' });

describe('대표 검수 → 메인 에이전트 검수 (v0.6 데이터 이전)', () => {
  it('검수자가 대표이던 작업은 시작 때 M-MAIN 검수로 이어지고(검수 중이면 메인 검수 업무, 자동 통과 없음), 끝난 작업은 이력 그대로이며, 다시 시작해도 같다', async () => {
    let e = (env = await bootRestartable());
    const d = seedDirective(e);
    // 예전 앱이 남긴 데이터: 적격 검수자가 없어 대표 검수로 남은 작업들
    const reviewing = seedInReviewTask(e, { directiveId: d.id, assigneeId: e.producerId, reviewerId: OWNER, title: '프로듀서 직접 작업' });
    const waiting = e.core.tasks.create({ directiveId: d.id, title: '기다리는 작업', goal: '목표', type: 'docs', assigneeId: e.producerId, acceptanceCriteria: ['문서가 있다'], outputMode: 'artifact' }, e.producerId);
    e.ctx.store.tasks.patch(waiting.id, { reviewerId: OWNER });
    const done = seedInReviewTask(e, { directiveId: d.id, assigneeId: e.producerId, reviewerId: OWNER, title: '끝난 작업' });
    const ownerPass: ReviewRecord = { id: e.ctx.store.nextId('review'), taskId: done.id, reviewRound: 1, reviewerId: OWNER, target: done.review.target!, verdict: 'pass', criteria: [], reason: '', requestId: null, createdAt: e.ctx.now() };
    e.ctx.store.reviews.insert(ownerPass);
    e.ctx.store.tasks.patch(done.id, { state: 'done', completedAt: e.ctx.now() });
    e.ctx.notify({ level: 'normal', title: '대표 검수 요청', body: `${reviewing.id} — 대표 검수가 필요합니다`, link: null, key: `owner-review:${reviewing.id}` });
    expect(migrationRows(e)).toEqual([]);

    // 전원이 꺼졌다 켜진다 → 시작 때 이전 (메인 검수 턴은 띄운 채로 둔다)
    e.crash();
    e = env = await e.reboot({ holdAll: true });
    expect(e.ctx.store.tasks.require(reviewing.id)).toMatchObject({ reviewerId: MAIN_AGENT_ID, state: 'in_review', review: { passed: null } });
    expect(e.ctx.store.tasks.require(waiting.id).reviewerId).toBe(MAIN_AGENT_ID);
    // 끝난 작업의 검수자 칸·대표 판정 기록은 이력으로 남는다
    expect(e.ctx.store.tasks.require(done.id).reviewerId).toBe(OWNER);
    expect(e.ctx.store.reviews.list({ ref1: done.id }).map((r) => r.reviewerId)).toEqual([OWNER]);
    // 메인 에이전트의 검수 업무 (검수 세션 review:T) — 대표 할 일·대표 검수 알림은 없다
    expect(reviewEntries(e, reviewing.id).map((q) => [q.memberId, q.reviewPinnedAt])).toEqual([[MAIN_AGENT_ID, reviewing.review.target!.pinnedAt]]);
    expect(e.core.views.ownerTodos().map((x) => x.kind as string)).not.toContain('owner_review');
    expect(e.ctx.store.notifications.list({ ref1: `owner-review:${reviewing.id}` }).map((n) => !!n.readAt)).toEqual([true]);
    const rows = migrationRows(e);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text).toContain('대표 검수 작업 2건');
    for (const t of [reviewing, waiting]) expect(rows[0]!.text).toContain(t.id);
    expect(rows[0]!.text).not.toContain(done.id);

    // 메인 에이전트가 그 검수 세션에서 검수한다: 검수 사본에서 돌고 검수 도구만 열린다
    await waitUntil(() => !!e.liveProc(`review:${reviewing.id}`, MAIN_AGENT_ID), '메인 검수 턴');
    const proc = e.liveProc(`review:${reviewing.id}`, MAIN_AGENT_ID)!;
    const who = e.identity(proc.turnId);
    expect([who.memberId, who.sessionKind, rolesFor(who)]).toEqual([MAIN_AGENT_ID, 'review', ['reviewer']]);
    const session = e.ctx.store.sessions.list({ ref2: `review:${reviewing.id}` })[0]!;
    expect(session.cwd).toBe(e.core.tasks.reviewCopyOf(e.ctx.store.tasks.require(reviewing.id)));
    // 재시작해도 자동 통과는 없다 — 판정은 메인이 등록할 때만
    expect(e.ctx.store.reviews.list({ ref1: reviewing.id })).toEqual([]);

    // 다시 시작해도 같은 결과 — 이전 기록·검수 업무는 늘지 않는다
    e = env = await e.stopGracefully({ holdAll: true });
    expect(migrationRows(e)).toHaveLength(1);
    expect(reviewEntries(e, reviewing.id).filter((q) => q.state === 'queued' || q.state === 'running').map((q) => q.memberId)).toEqual([MAIN_AGENT_ID]);
    expect(e.ctx.store.tasks.require(done.id).reviewerId).toBe(OWNER);
    expect(e.ctx.store.tasks.require(reviewing.id).review.passed).toBeNull();

    // 메인이 그 검수 세션에서 통과를 등록해야 통과가 된다
    await waitUntil(() => !!e.liveProc(`review:${reviewing.id}`, MAIN_AGENT_ID), '다시 띄운 메인 검수 턴');
    const p2 = e.liveProc(`review:${reviewing.id}`, MAIN_AGENT_ID)!;
    const r = await e.tool(p2.turnId, 'submit_review', PASS(e.ctx.store.tasks.require(reviewing.id)));
    expect(r.ok).toBe(true);
    expect(e.ctx.store.reviews.list({ ref1: reviewing.id }).map((x) => `${x.reviewerId}:${x.verdict}`)).toEqual([`${MAIN_AGENT_ID}:pass`]);
  });

  it('M-MAIN이 기여자로 기록된 대표 검수 작업은 대신 검수할 수 없다 — 시작 때 검수자 없음으로 보류하고 메인에게 알린다 (다시 시작해도 한 번)', async () => {
    let e = (env = await bootRestartable());
    await e.internal('members.remove', e.qaId); // 적격 검수 팀원이 없다 (개발자는 검수 권한 없음, 프로듀서는 작업자)
    const d = seedDirective(e);
    const contributed = seedInReviewTask(e, { directiveId: d.id, assigneeId: e.producerId, reviewerId: OWNER, title: '메인이 손댄 작업' });
    e.ctx.store.tasks.patch(contributed.id, { contributors: [e.producerId, MAIN_AGENT_ID] });
    e.crash();
    e = env = await e.reboot();
    const held = e.ctx.store.tasks.require(contributed.id);
    expect([held.reviewerId, held.state, held.hold.returnState, held.hold.reasons.map((r) => `${r.kind}/${r.refId}`)]).toEqual([null, 'on_hold', 'in_review', ['error/no_reviewer']]);
    // 메인에게 '검수자 없음' 업무 (그 업무를 실은 메인 턴이 끝나며 다시 넣은 항목은 같은 업무다 — 보류·알림은 한 번)
    const noReviewer = () => e.ctx.store.queue.list({ ref1: MAIN_AGENT_ID }).filter((q) => q.kind === 'no_reviewer' && q.taskId === contributed.id && q.state !== 'cancelled');
    const holdLogs = () => e.ctx.store.activity.search({ taskId: contributed.id, text: '검수자 없음 — 보류하고 메인 에이전트에게 알림', limit: 50 }).length;
    expect(noReviewer().length).toBeGreaterThan(0);
    expect(noReviewer()[0]!.message).toContain(`resume_task(task_id="${contributed.id}")`);
    expect(holdLogs()).toBe(1);
    expect(reviewEntries(e, contributed.id)).toEqual([]);
    expect(migrationRows(e).map((a) => a.text.includes(contributed.id))).toEqual([true]);
    e = env = await e.stopGracefully();
    expect(migrationRows(e)).toHaveLength(1);
    expect(holdLogs()).toBe(1);
    expect(e.ctx.store.tasks.require(contributed.id).hold.reasons.map((r) => r.refId)).toEqual(['no_reviewer']);
  });
});
