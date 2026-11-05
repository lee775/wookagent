/**
 * 검수 판정·검수 업무를 고정 버전의 "같은 고정인지"로 묶는다 (REV-03·07·08, AC-43, ERR-04).
 * - 판정 묶기는 두 벽시계 값의 순서가 아니라 그 검수 턴을 띄울 때 고정돼 있던 대상과 지금 대상이 같은지로 본다: 시계가 뒤로 맞춰져 고정 시각이
 *   지금보다 앞이어도 바뀐 것이 없으면 판정을 받고, 시계가 앞뒤로 움직여도 다른 버전에 띄워진 턴의 판정은 받지 않는다
 * - 판정 전에 버전이 바뀌어 끝나는 검수 턴이 이어지면 상한에서 프로듀서에게 넘긴다
 * - 검수 업무는 그 버전에 묶인다: 시작 중인 검수 턴·정전으로 끊긴 검수 턴의 이전 버전 항목이 다음 버전 검수 요청에 섞이지 않는다
 * - 통과는 지금 완료 조건마다 통과 결과가 있어야 한다 (팀원 검수·메인 에이전트 대체 검수)
 * 실제 오케스트레이터 + 가짜 CLI 프로세스 (orchHarness, stops-helpers.bootRestartable).
 */
import { mkdirSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { ReviewTarget, Task } from '@shared/domain';
import { MAIN_AGENT_ID } from '@shared/domain';
import { uncoveredCriteria } from '@core/reviewRules';
import { enqueue, transitionTask } from '../../src/main/orchestrator/records';
import { reviewCopyPath } from '../../src/main/orchestrator/paths';
import type { OrchEnv } from './orchHarness';
import { bootOrch, queuedOf, seedInReviewTask, startReview, waitFor } from './orchHarness';
import { bootRestartable, seedDirective as seedRestartDirective, seedInReviewTask as seedRestartInReview, waitUntil, type RestartableEnv } from '../acceptance/stops-helpers';

let env: OrchEnv | null = null;
let restartable: RestartableEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
  await restartable?.close();
  restartable = null;
});

const reviewKey = (t: Task | string) => `review:${typeof t === 'string' ? t : t.id}`;
const pass = (taskId: string, criteria: string[], note = '확인') => ({ task_id: taskId, verdict: 'pass', criteria: criteria.map((criterion) => ({ criterion, pass: true, note })), reason: '' });

/** 검수 중인 저장소 변경형 대상을 새 커밋으로 다시 고정한다 (사본 폴더도 만든다) — 제출 처리의 고정과 같은 결과 */
function repin(e: OrchEnv, taskId: string, sha: string, pinnedAt = e.ctx.now()): Extract<ReviewTarget, { kind: 'repo' }> {
  const target = { kind: 'repo' as const, taskCommitSha: sha.repeat(40).slice(0, 40), baseMainSha: 'b'.repeat(40), pinnedAt };
  mkdirSync(reviewCopyPath(e.ctx.paths, e.projectId, taskId, 1, target.taskCommitSha.slice(0, 8)), { recursive: true });
  transitionTask(e.ctx, taskId, { type: 'repin', target }, 'system');
  return target;
}

describe('판정 묶기는 같은 고정인지로 본다 (REV-07, AC-43)', () => {
  it('고정 시각이 지금 시계보다 앞이어도(시계가 뒤로 맞춰짐) 바뀐 것이 없으면 그 버전을 본 검수 턴의 판정을 받는다', async () => {
    env = await bootOrch();
    const e = env;
    const t = seedInReviewTask(e, e.qaId, { outputMode: 'repo' });
    const cur = e.ctx.store.tasks.require(t.id);
    const ahead = new Date(Date.now() + 3_600_000).toISOString(); // 고정할 때 PC 시계가 한 시간 빨랐다
    e.ctx.store.tasks.put({ ...cur, review: { ...cur.review, target: { ...cur.review.target!, pinnedAt: ahead } } });
    e.hold.add(reviewKey(t));
    e.core.tasks.dispatchReview(e.ctx.store.tasks.require(t.id));
    e.tick();
    await waitFor(() => !!e.liveProc(reviewKey(t), e.qaId), '검수 턴');
    const p = e.liveProc(reviewKey(t), e.qaId)!;
    expect(e.ctx.store.turns.require(p.turnId).reviewPinnedAt).toBe(ahead);
    const r = await e.tool(p.turnId, 'submit_review', pass(t.id, ['문서가 있다']));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    p.finishOk();
    await e.idle();
    const after = e.ctx.store.tasks.require(t.id);
    expect(after.review.passed?.target.pinnedAt).toBe(ahead);
    expect(queuedOf(e, (q) => q.sessionKey === reviewKey(t))).toEqual([]);
    expect(queuedOf(e, (q) => q.kind === 'merge_decision' && q.taskId === t.id)).toHaveLength(1);
  });

  it('다른 버전이 고정되면 이전 버전에 띄워진 턴의 판정은 받지 않는다 — 새 고정 시각이 그 턴의 시작보다 앞(시계가 뒤로 감)이어도', async () => {
    env = await bootOrch();
    const e = env;
    const { task, proc, turnId } = await startReview(e, e.qaId, { outputMode: 'repo' });
    const started = e.ctx.store.turns.require(turnId).startedAt;
    const v2 = repin(e, task.id, 'c', new Date(Date.parse(started) - 3_600_000).toISOString());
    e.core.tasks.dispatchReview(e.ctx.store.tasks.require(task.id));
    const late = await e.tool(turnId, 'submit_review', pass(task.id, ['문서가 있다']));
    expect(late).toMatchObject({ ok: false, code: 'conflict' });
    proc.finishOk();
    await e.idle();
    expect(e.ctx.store.tasks.require(task.id).review.passed).toBeNull();
    const queued = queuedOf(e, (q) => q.sessionKey === reviewKey(task) && q.kind === 'review');
    expect(queued.map((q) => [q.memberId, (q as { reviewPinnedAt?: string }).reviewPinnedAt])).toEqual([[e.qaId, v2.pinnedAt]]);
  });

  it('판정 전에 버전이 바뀌어 끝나는 검수 턴이 이어지면 3번째에 프로듀서에게 검수자 재배정을 넘긴다 (자동 재시도 상한, ERR-04)', async () => {
    env = await bootOrch();
    const e = env;
    const { task } = await startReview(e, e.qaId, { outputMode: 'repo' });
    for (const [i, sha] of ['c', 'd', 'e'].entries()) {
      const live = e.liveProc(reviewKey(task), e.qaId)!;
      repin(e, task.id, sha);
      e.core.tasks.dispatchReview(e.ctx.store.tasks.require(task.id));
      live.finishOk();
      await e.idle();
      const escalated = queuedOf(e, (q) => q.kind === 'reviewer_assign' && q.taskId === task.id);
      expect(escalated, `이전 버전에서 끝난 검수 턴 ${i + 1}번째`).toHaveLength(i < 2 ? 0 : 1);
      if (i < 2) {
        e.tick();
        await waitFor(() => !!e.liveProc(reviewKey(task), e.qaId), `${sha} 버전 검수 턴`);
      }
    }
    expect(queuedOf(e, (q) => q.kind === 'reviewer_assign' && q.taskId === task.id)[0]!.message).toContain('판정 전에 검수 대상 버전이 바뀌어');
    // 지금 버전 검수는 그대로 등록돼 있다
    expect(queuedOf(e, (q) => q.sessionKey === reviewKey(task) && q.kind === 'review').map((q) => q.memberId)).toEqual([e.qaId]);
  });
});

describe('검수 업무는 그 버전에 묶인다 (REV-07·08)', () => {
  it('검수 턴이 시작 중(프로세스를 띄우기 전)일 때 완료 조건이 바뀌면 그 버전의 검수 항목이 남지 않고, 다음 버전 검수 요청에 이전 사본·조건이 섞이지 않는다', async () => {
    env = await bootOrch();
    const e = env;
    const t = seedInReviewTask(e, e.qaId, { outputMode: 'repo' });
    const key = reviewKey(t);
    const v1Copy = reviewCopyPath(e.ctx.paths, e.projectId, t.id, 1, 'a'.repeat(8));
    e.hold.add(key);
    let fired = false;
    e.prepareHook = (_launch, who) => {
      if (who.sessionKey !== key || fired) return;
      fired = true;
      e.core.tasks.update(t.id, { acceptanceCriteria: ['문서가 있다', '목차가 있다'] }, e.producerId);
    };
    e.core.tasks.dispatchReview(e.ctx.store.tasks.require(t.id));
    e.tick();
    await e.idle();
    e.prepareHook = null;
    expect(fired).toBe(true);
    expect(e.ctx.store.tasks.require(t.id).state).toBe('in_progress');
    expect(e.ctx.store.queue.list({ ref2: key, state: ['queued', 'running'] })).toEqual([]);

    // 작업자가 새 버전을 제출해 고정된다 (제출 처리와 같은 전이 + 검수 등록)
    const v2 = { kind: 'repo' as const, taskCommitSha: 'c'.repeat(40), baseMainSha: 'b'.repeat(40), pinnedAt: e.ctx.now() };
    mkdirSync(reviewCopyPath(e.ctx.paths, e.projectId, t.id, 1, 'c'.repeat(8)), { recursive: true });
    transitionTask(e.ctx, t.id, { type: 'submit', target: v2 }, 'system');
    e.core.tasks.dispatchReview(e.ctx.store.tasks.require(t.id));
    e.tick();
    await waitFor(() => !!e.liveProc(key, e.qaId), '새 버전 검수 턴');
    const p = e.liveProc(key, e.qaId)!;
    const launch = e.launches.filter((l) => l.workKey === key).pop()!;
    expect(launch.message).not.toContain(v1Copy);
    expect(launch.message).toContain(reviewCopyPath(e.ctx.paths, e.projectId, t.id, 1, 'c'.repeat(8)));
    expect(launch.message.match(/완료 조건:/g)).toHaveLength(1);
    expect(launch.message).toContain('2. 목차가 있다');

    // 지금 완료 조건(목차가 있다)의 결과가 없는 통과는 받지 않는다 (REV-03)
    const partial = await e.tool(p.turnId, 'submit_review', pass(t.id, ['문서가 있다']));
    expect(partial).toMatchObject({ ok: false, code: 'invalid' });
    expect(partial.ok ? '' : partial.message).toContain('"목차가 있다"');
    expect(e.ctx.store.tasks.require(t.id).review.passed).toBeNull();
    const full = await e.tool(p.turnId, 'submit_review', pass(t.id, ['문서가 있다', '목차가 있다']));
    expect(full.ok).toBe(true);
    expect(e.ctx.store.tasks.require(t.id).review.passed?.target).toEqual(v2);
  });

  it('완료 조건이 바뀐 뒤 검수 턴이 끝났다고 기록되기 전에 전원이 꺼져도, 재시작 복구가 이전 버전의 검수 항목을 되살리지 않는다 — 다음 버전 요청에 이전 사본이 섞이지 않는다', async () => {
    restartable = await bootRestartable();
    let e = restartable;
    const d = seedRestartDirective(e);
    const t = seedRestartInReview(e, { directiveId: d.id, assigneeId: e.devId, reviewerId: e.qaId });
    const key = reviewKey(t);
    const v1Copy = reviewCopyPath(e.ctx.paths, e.projectId, t.id, 1, 'v1');
    e.hold.add(key);
    e.core.tasks.dispatchReview(e.ctx.store.tasks.require(t.id));
    e.tick();
    await waitUntil(() => !!e.liveProc(key, e.qaId), 'V1 검수 턴');
    e.core.tasks.update(t.id, { acceptanceCriteria: ['문서가 있다', '목차가 있다'] }, e.producerId);
    expect(e.ctx.store.tasks.require(t.id).state).toBe('in_progress');
    e.crash();
    e = restartable = await e.reboot({ holdAll: true });
    expect(e.ctx.store.queue.list({ ref2: key, state: ['queued', 'running'] })).toEqual([]);

    const v2 = { kind: 'artifact' as const, files: [{ path: 'a.md', sha256: 'def', size: 2 }], version: 2, pinnedAt: e.ctx.now() };
    const v2Copy = reviewCopyPath(e.ctx.paths, e.projectId, t.id, 1, 'v2');
    mkdirSync(v2Copy, { recursive: true });
    transitionTask(e.ctx, t.id, { type: 'submit', target: v2 }, 'system');
    e.core.tasks.dispatchReview(e.ctx.store.tasks.require(t.id));
    e.tick();
    await waitUntil(() => !!e.liveProc(key, e.qaId), 'V2 검수 턴');
    const launch = e.launchesOf(key).pop()!;
    expect(launch.message).not.toContain(v1Copy);
    expect(launch.message).toContain(v2Copy);
  });

  it('검수 턴이 도는 중에 재배정으로 검수 대상이 지워지고 그 턴이 끝났다고 기록되기 전에 전원이 꺼지면, 재시작 복구가 그 버전의 검수 항목을 되살리지 않는다', async () => {
    restartable = await bootRestartable();
    let e = restartable;
    const d = seedRestartDirective(e);
    const t = seedRestartInReview(e, { directiveId: d.id, assigneeId: e.devId, reviewerId: e.qaId });
    const key = reviewKey(t);
    e.hold.add(key);
    e.core.tasks.dispatchReview(e.ctx.store.tasks.require(t.id));
    e.tick();
    await waitUntil(() => !!e.liveProc(key, e.qaId), 'V1 검수 턴');
    const [running] = e.ctx.store.queue.list({ ref2: key, state: 'running' });
    expect(running?.kind).toBe('review');
    // 프로듀서가 작업을 다른 팀원에게 넘긴다 → 검수 대상이 지워진다. 그 검수 턴이 끝났다고 기록되기 전에 전원이 꺼진다
    e.core.tasks.reassign(t.id, e.producerId, e.producerId);
    expect(e.ctx.store.tasks.require(t.id).review.target).toBeNull();
    expect(e.ctx.store.queue.get(running!.id)?.state).toBe('running');
    e.crash();
    e = restartable = await e.reboot({ holdAll: true });
    expect(e.ctx.store.queue.get(running!.id)?.state).toBe('cancelled');
    expect(e.ctx.store.queue.list({ ref2: key, state: ['queued', 'running'] })).toEqual([]);
  });

  it('이전 버전에 묶인 검수 항목은 새 버전 요청에 합쳐지지 않고, 그 버전 검수 턴을 띄울 때 지워진다 (실리지 않음)', async () => {
    env = await bootOrch();
    const e = env;
    const t = seedInReviewTask(e, e.qaId, { outputMode: 'repo' });
    const key = reviewKey(t);
    const v1 = e.ctx.store.tasks.require(t.id).review.target!;
    enqueue(e.ctx, { kind: 'review', memberId: e.qaId, sessionKey: key, projectId: e.projectId, taskId: t.id, message: 'V1 검수 요청 (이전 사본)', reviewPinnedAt: v1.pinnedAt, dedupeKind: true });
    const v2 = repin(e, t.id, 'c');
    // 새 버전 항목은 이전 버전 항목에 합치지 않는다 (같은 세션·종류라도)
    enqueue(e.ctx, { kind: 'review', memberId: e.qaId, sessionKey: key, projectId: e.projectId, taskId: t.id, message: 'V2 검수 요청', reviewPinnedAt: v2.pinnedAt, dedupeKind: true });
    expect(queuedOf(e, (q) => q.sessionKey === key).map((q) => q.message)).toEqual(['V1 검수 요청 (이전 사본)', 'V2 검수 요청']);
    e.hold.add(key);
    e.tick();
    await waitFor(() => !!e.liveProc(key, e.qaId), 'V2 검수 턴');
    const launch = e.launches.filter((l) => l.workKey === key).pop()!;
    expect(launch.message).toContain('V2 검수 요청');
    expect(launch.message).not.toContain('V1 검수 요청');
    expect(e.ctx.store.queue.list({ ref2: key }).find((q) => q.message.startsWith('V1'))?.state).toBe('cancelled');
  });
});

describe('통과는 지금 완료 조건마다 결과가 있어야 한다 (REV-03)', () => {
  it('조건 판정 맞추기: 같은 글(공백·번호 정리) 또는 같은 자리의 통과 결과가 조건을 덮고, 다른 조건의 글로 적힌 자리는 덮지 않는다', () => {
    const criteria = ['문서가 있다', '목차가 있다'];
    const r = (criterion: string, ok = true) => ({ criterion, pass: ok, note: '' });
    expect(uncoveredCriteria(criteria, [r('문서가 있다'), r('목차가 있다')])).toEqual([]);
    expect(uncoveredCriteria(criteria, [r('목차가 있다'), r(' 1. 문서가  있다 ')])).toEqual([]);
    expect(uncoveredCriteria(criteria, [r('문서 확인'), r('목차 확인')])).toEqual([]); // 자리로 덮음 (글을 조금 바꿔 적음)
    expect(uncoveredCriteria(criteria, [r('문서가 있다')])).toEqual(['목차가 있다']);
    expect(uncoveredCriteria(criteria, [r('문서가 있다'), r('문서가 있다')])).toEqual(['목차가 있다']);
    expect(uncoveredCriteria(criteria, [])).toEqual(criteria);
    expect(uncoveredCriteria(criteria, [r('문서가 있다'), r('목차가 있다'), r('덤 확인')])).toEqual([]); // 남는 결과는 무시
  });

  it('메인 에이전트 대체 검수도 지금 완료 조건마다 결과가 있어야 통과를 받는다 (그 검수 세션의 submit_review)', async () => {
    env = await bootOrch();
    const e = env;
    const { task: seeded, turnId } = await startReview(e, MAIN_AGENT_ID, { outputMode: 'repo' });
    e.ctx.store.tasks.patch(seeded.id, { acceptanceCriteria: ['문서가 있다', '목차가 있다'] });
    const verdict = (criteria: string[]) => ({ task_id: seeded.id, verdict: 'pass', criteria: criteria.map((criterion) => ({ criterion, pass: true, note: '메인 확인' })), reason: '' });
    const partial = await e.tool(turnId, 'submit_review', verdict(['문서가 있다']));
    expect(partial.ok ? null : partial.code).toBe('invalid');
    expect(e.ctx.store.tasks.require(seeded.id).review.passed).toBeNull();
    expect((await e.tool(turnId, 'submit_review', verdict(['문서가 있다', '목차가 있다']))).ok).toBe(true);
    expect(e.ctx.store.tasks.require(seeded.id).review.passed?.reviewerId).toBe(MAIN_AGENT_ID);
  });
});
