/**
 * 검수자 재배정 업무를 실은 프로듀서 턴이 어떻게 끝나도 멈춘 검수가 사라지지 않는다 (리드 결정 18, 10-29 — flows 재리뷰 medium, 프로브 zz-s1fxfg-assign-dropped):
 * - (A) CLI 안전 검사 거부(개별 명령 거부) 상한: 예전에는 검수 세션만 재배정으로 넘기고 프로듀서 턴의 재배정 업무는 그냥 버렸다
 * - (B) 시작 실패 상한(recordStartFailure): 예전에는 항목을 지우고 '업무 시작 실패' 알림만 남겼다
 *   둘 다 검수 중 작업에 대기·실행 중인 검수도, 재배정 업무도, 메인 업무도 남지 않았다(리드 결정 11의 규칙 위반). 이제 버리기 전에 메인 에이전트에게 넘긴다
 * - 시작 때 안전망(재시작 복구에서만): 검수 중·통과 전인데 할 일이 아무것도 없는 작업은 검수를 다시 등록하고 활동 기록을 남긴다. 다시 돌려도 같다
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID, type Task } from '@shared/domain';
import { directiveKey, enqueue, mainKey, reviewKey } from '../../src/main/orchestrator/records';
import { bootRestartable, seedDirective as seedRestartDirective, seedInReviewTask as seedRestartReview, type RestartableEnv } from '../acceptance/stops-helpers';
import type { OrchEnv } from './orchHarness';
import { bootOrch, seedDirective, seedInReviewTask, sleep, waitFor } from './orchHarness';

let env: OrchEnv | null = null;
let renv: RestartableEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
  await renv?.close();
  renv = null;
});

function mainOnlyTask(e: OrchEnv, directiveId: string): Task {
  const t = seedInReviewTask(e, MAIN_AGENT_ID, { outputMode: 'repo', directiveId });
  e.ctx.store.tasks.patch(t.id, { assigneeId: e.producerId, contributors: [e.producerId] });
  return e.ctx.store.tasks.require(t.id);
}

/** 그 작업에 남은 일 — 대기·실행 중인 검수, 검수자 재배정 업무, 그 작업의 메인 에이전트 업무 */
function workFor(e: OrchEnv, t: Task) {
  const live = e.ctx.store.queue.list({ state: ['queued', 'running'] });
  return {
    state: e.ctx.store.tasks.require(t.id).state,
    review: live.filter((q) => q.sessionKey === reviewKey(t.id) && q.kind === 'review').length + (e.core.turns.hasLiveSession(reviewKey(t.id)) ? 1 : 0),
    reviewerAssign: live.filter((q) => q.kind === 'reviewer_assign' && q.taskId === t.id).length,
    mainWork: live.filter((q) => q.memberId === MAIN_AGENT_ID && q.sessionKey.startsWith('main:') && q.taskId === t.id).length,
  };
}
const mainWorkOf = (e: OrchEnv, t: Task) => e.ctx.store.queue.list({ state: ['queued', 'running'] }).filter((q) => q.memberId === MAIN_AGENT_ID && q.sessionKey.startsWith('main:') && q.taskId === t.id);

describe('검수자 재배정 업무를 실은 프로듀서 턴의 끝마다 멈춘 검수를 메인 에이전트에게 넘긴다 (리드 결정 18)', () => {
  it('(A) 프로듀서 턴이 CLI 안전 검사 거부로 상한까지 끝나면 그 재배정 업무를 버리지 않고 메인 에이전트에게 넘긴다', async () => {
    const e = (env = await bootOrch({ mock: false }));
    await e.internal('members.remove', e.qaId);
    const d = seedDirective(e);
    const t = mainOnlyTask(e, d.id);
    e.hold.add(mainKey(e.projectId));
    // 프로듀서 턴은 바이패스를 확인한 뒤 개별 명령이 CLI 안전 검사에 거부돼 끝난다
    e.script.set(directiveKey(d.id), (p) => {
      p.emit({ kind: 'session', text: 'init', data: { permissionMode: 'bypassPermissions' } });
      p.emit({ kind: 'error', text: 'rm -rf "$OUT"/* — 안전 검사 거부', data: { errorKind: 'permission' } });
    });
    e.core.tasks.dispatchReview(t);
    const producerTurns = () => e.ctx.store.turns.list().filter((x) => x.directiveId === d.id && x.memberId === e.producerId && x.endReason);
    await waitFor(
      () => {
        e.tick();
        return producerTurns().length >= 3 && mainWorkOf(e, t).length > 0;
      },
      '프로듀서 턴 3번과 메인 에이전트에게 넘긴 업무',
      40_000,
    );
    expect(producerTurns().map((x) => x.endReason)).toEqual(['bypass_mismatch', 'bypass_mismatch', 'bypass_mismatch']);
    const item = mainWorkOf(e, t)[0]!;
    expect(item).toMatchObject({ kind: 'message', sessionKey: mainKey(e.projectId), priority: 'high', directiveId: d.id });
    expect(item.message).toContain(`${t.id} "${t.title}" 검수가 멈췄습니다`);
    expect(item.message).toContain('프로듀서 턴이 CLI 안전 검사 거부로 반복해서 끝났습니다');
    expect(e.ctx.store.notifications.list().filter((n) => n.title === '프로듀서 처리 지연').map((n) => n.key)).toEqual([`review-stuck:${t.id}:${MAIN_AGENT_ID}`]);
    expect(e.ctx.store.notifications.list().some((n) => n.title === 'CLI 안전 검사 거부')).toBe(true);
    // 검수 중 작업에는 처리할 수 있는 쪽의 업무가 있다
    expect(workFor(e, t)).toMatchObject({ state: 'in_review', reviewerAssign: 0, mainWork: 1 });
  });

  it('(B) 프로듀서 턴이 시작 실패 상한에 닿으면 재배정 업무를 지우기 전에 메인 에이전트에게 넘긴다', async () => {
    const e = (env = await bootOrch());
    await e.internal('members.remove', e.qaId);
    const d = seedDirective(e);
    const t = mainOnlyTask(e, d.id);
    e.hold.add(mainKey(e.projectId));
    let fails = 0;
    e.prepareHook = (_launch, who) => {
      if (who.sessionKey === directiveKey(d.id)) {
        fails++;
        throw new Error('모델 이름을 쓸 수 없습니다');
      }
    };
    e.core.tasks.dispatchReview(t);
    await waitFor(
      () => {
        e.tick();
        return fails >= 3 && mainWorkOf(e, t).length > 0;
      },
      '시작 실패 3번과 메인 에이전트에게 넘긴 업무',
      40_000,
    );
    await sleep(50);
    // 재배정 업무는 시작 실패 상한으로 멈췄고(대표 '업무 시작 실패' 알림 그대로), 멈춘 검수는 메인 에이전트에게 갔다
    expect(e.ctx.store.queue.list({ ref2: directiveKey(d.id) }).filter((q) => q.kind === 'reviewer_assign').map((q) => [q.state, q.startFails])).toEqual([['cancelled', 3]]);
    expect(e.ctx.store.notifications.list().some((n) => n.title === '업무 시작 실패')).toBe(true);
    const item = mainWorkOf(e, t)[0]!;
    expect(item.message).toContain('프로듀서 턴이 3번 시작하지 못했습니다 (모델 이름을 쓸 수 없습니다)');
    expect(e.ctx.store.activity.search({ text: '검수자 재배정이 처리되지 않아 메인 에이전트에게 넘김 (프로듀서 턴이 3번 시작하지 못했습니다', limit: 10 }).map((a) => a.taskId)).toEqual([t.id]);
    expect(workFor(e, t)).toMatchObject({ state: 'in_review', reviewerAssign: 0, mainWork: 1 });
  });
});

describe('시작 때 안전망: 검수 중인데 할 일이 아무것도 없는 작업의 업무를 다시 만든다 (리드 결정 18)', () => {
  it('잃은 업무만 다시 만들고(검수 다시 등록 + 활동 기록), 재배정·메인 업무가 남은 작업은 건드리지 않으며, 다시 재시작해도 기록이 늘지 않는다', async () => {
    let e = (renv = await bootRestartable({ holdAll: true }));
    const d = seedRestartDirective(e);
    const lost = seedRestartReview(e, { directiveId: d.id, assigneeId: e.devId, reviewerId: e.qaId, title: '잃은 검수' });
    const assigning = seedRestartReview(e, { directiveId: d.id, assigneeId: e.devId, reviewerId: e.qaId, title: '재배정 대기' });
    const handed = seedRestartReview(e, { directiveId: d.id, assigneeId: e.devId, reviewerId: e.qaId, title: '메인에게 넘김' });
    enqueue(e.ctx, { kind: 'reviewer_assign', memberId: e.producerId, sessionKey: directiveKey(d.id), projectId: e.projectId, directiveId: d.id, taskId: assigning.id, message: `${assigning.id} 검수 지연` });
    enqueue(e.ctx, { kind: 'message', memberId: MAIN_AGENT_ID, sessionKey: mainKey(e.projectId), projectId: e.projectId, directiveId: d.id, taskId: handed.id, message: `${handed.id} 검수가 멈췄습니다` });
    const rows = () => e.ctx.store.activity.search({ text: '검수 중인데 대기·실행 중인 검수도', limit: 50 });
    e.crash();
    e = renv = await e.reboot();
    // 잃은 작업만: 지금 검수자에게 검수를 다시 등록하고 활동 기록 1줄
    expect(rows().map((a) => [a.taskId, a.text])).toEqual([
      [lost.id, `재시작 복구: ${lost.id} 검수 중인데 대기·실행 중인 검수도, 검수자 재배정이나 메인 에이전트 업무도 없어 검수자 ${e.qaId}에게 검수를 다시 등록`],
    ]);
    const reviewOf = (id: string) => e.ctx.store.queue.list({ ref2: reviewKey(id), state: ['queued', 'running'] }).filter((q) => q.kind === 'review');
    expect(reviewOf(lost.id).map((q) => q.memberId)).toEqual([e.qaId]);
    // 재배정 업무·메인 업무는 그대로 남는다
    expect(e.ctx.store.queue.list({ state: ['queued', 'running'] }).filter((q) => q.taskId === assigning.id && q.kind === 'reviewer_assign')).toHaveLength(1);
    expect(e.ctx.store.queue.list({ state: ['queued', 'running'] }).filter((q) => q.taskId === handed.id && q.memberId === MAIN_AGENT_ID)).toHaveLength(1);
    // 다시 재시작해도(멱등) 기록이 늘지 않고 검수는 하나다
    e.crash();
    e = renv = await e.reboot();
    expect(rows()).toHaveLength(1);
    expect(reviewOf(lost.id)).toHaveLength(1);
  });
});
