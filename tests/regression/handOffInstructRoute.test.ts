/**
 * 멈춘 검수 넘김은 닿지 않는 지시를 권하지 않는다 (리드 결정 11·45, 10-30 — flows 5차 재리뷰 low, 프로브 zz-s1fx5fg-handoff-instruct-own-task):
 * - 넘김 글(handReviewToMain)은 메인에게 프로듀서에게 assign_reviewer를 지시하라고(instruct_member) 권했다. 그런데 메인의 instruct_member는 받는 팀원의 활성
 *   작업 세션으로 먼저 간다(tools.sessionFor). 멈춘 작업이 프로듀서가 직접 한 작업이면 그 지시는 검수 중인 그 작업 세션(task:T)에 쌓이고, 스케줄러는 작업
 *   세션을 작업이 진행 중일 때만 띄우므로 처리되지 않는다 — 바로 그 멈춘 상태다. 결정 11: 아무것도 하지 않는 길을 권하지 않는다
 * - 이제 넘김 글은 메인의 instruct_member와 같은 판정(lookups.messageSessionOf)으로 프로듀서에게 보낸 지시가 바로 뜨지 못하는 작업 세션으로 가는지 보고
 *   (deferredMessageTask), 그렇다면 그 길을 빼고 interrupt_task 뒤 resume_task와 add_member를 앞세우며 까닭을 넣을 때 확인한 사실로 적는다
 * - 미뤄지지 않으면 예전 글 그대로다 — 메인 에이전트가 검수자인 재등록 뒤의 넘김도 결정 17의 세 길을 적는다 (리드 결정 48, 프로브
 *   zz-s1fix6-ti-main-again-unparked)
 * 5단계 S5b (리드 결정 48·S5-11): 메인 에이전트가 assign_reviewer를 직접 쓴다. 넘김 글은 add_member(검수 권한 팀원이 없을 때) 다음 assign_reviewer를 앞세우고 —
 * 지금 검수자가 자격이 있으면 팀원을 더하기만 해서는 바뀌지 않는다 — 프로듀서에게 맡기는 지시는 그 지시가 닿을 때만 마지막에 둔다. 미뤄지는 지시는 여전히 권하지 않는다
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID, type Task } from '@shared/domain';
import { directiveKey, mainKey, reviewKey, taskKey } from '../../src/main/orchestrator/records';
import type { OrchEnv } from './orchHarness';
import { bootOrch, seedDirective, seedInReviewTask } from './orchHarness';

let env: OrchEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

type HandOff = { handReviewToMain(t: Task, d: string, p: string | null, c: { producer: string } | { again: number; why: string }): void };
const handOffOf = (e: OrchEnv, taskId: string) => e.ctx.store.queue.list({ ref2: mainKey(e.projectId), state: 'queued' }).find((q) => q.taskId === taskId && q.memberId === MAIN_AGENT_ID && q.kind === 'message')!;

describe('멈춘 검수 넘김은 프로듀서에게 닿지 않는 지시를 권하지 않는다 (리드 결정 45)', () => {
  it('멈춘 작업이 프로듀서가 직접 한 작업이면 instruct_member를 권하지 않고 add_member·assign_reviewer를 앞세운다 — 메인의 assign_reviewer는 실제로 검수를 다시 등록한다 (S5-11)', async () => {
    const e = (env = await bootOrch());
    const d = seedDirective(e);
    const t = seedInReviewTask(e, e.qaId, { outputMode: 'repo', directiveId: d.id });
    // 프로듀서가 이 작업을 직접 했다 (활성화, 지금 검수 중)
    e.ctx.store.tasks.patch(t.id, { assigneeId: e.producerId, contributors: [e.producerId], activatedAt: e.ctx.now() });
    e.hold.add(mainKey(e.projectId));
    const producer = e.ctx.store.members.require(e.producerId);
    (e.core.turns as unknown as HandOff).handReviewToMain(e.ctx.store.tasks.require(t.id), d.id, e.projectId, { producer: '3번의 턴에서 정하지 않았습니다' });
    const msg = handOffOf(e, t.id).message;
    expect(msg).toBe(
      `${t.id} "${t.title}" 검수가 멈췄습니다 — 검수자(${e.qaId})의 검수 턴이 판정 없이 반복해서 끝나 프로듀서에게 검수자 재배정을 맡겼지만 3번의 턴에서 정하지 않았습니다. 검수 권한 팀원이 없으면 add_member로 더한 뒤 assign_reviewer(task_id="${t.id}", reviewer_id="…")로 검수자를 정하세요(지금 검수자를 다시 정하면 그 검수자에게 검수를 다시 등록합니다). 필요 없으면 cancel_task로 취소하세요. 이 업무를 넣을 때 프로듀서 ${producer.name}이 맡은 작업 ${t.id}이(가) 검수 중이었습니다 — 프로듀서에게 보내는 지시(instruct_member)는 그 작업 세션으로 가서 그 작업이 다시 진행될 때까지 처리되지 않으므로 그 길은 적지 않았습니다.`,
    );
    // 권하지 않은 까닭이 사실이다: 메인의 instruct_member는 같은 판정으로 검수 중인 이 작업 세션에 저장만 하고, 프로듀서 턴은 뜨지 않는다
    const r = await e.main('instruct_member', { member_id: e.producerId, text: `${t.id}의 검수자를 다시 정해 주세요` });
    expect(r).toMatchObject({ delivered: taskKey(t.id) });
    expect(String(r.note)).toContain(`${t.id}이(가) 검수 중이라`);
    e.tick();
    expect(e.launches.filter((l) => l.workKey === directiveKey(d.id) || l.workKey === taskKey(t.id))).toEqual([]);
    // 앞세운 길은 무언가를 한다: 메인의 assign_reviewer(같은 검수자)면 검수가 그 검수자에게 다시 등록된다 — 다른 프로젝트 일도 메인이 직접 (리드 결정 S5-11)
    expect(await e.main('assign_reviewer', { task_id: t.id, reviewer_id: e.qaId, reason: '넘김 안내대로 검수를 다시 등록' })).toMatchObject({ taskId: t.id, reviewerId: e.qaId, reviewRequeued: true });
    expect(e.ctx.store.tasks.require(t.id).state).toBe('in_review');
    expect(e.ctx.store.queue.list({ ref2: reviewKey(t.id), state: ['queued', 'running'] }).map((q) => [q.kind, q.memberId])).toEqual([['review', e.qaId]]);
    // 운영 조작이라 사유가 활동 기록·대표 알림에 남는다
    expect(e.ctx.store.notifications.list().filter((n) => n.key === `main-op:assign_reviewer:${t.id}`).map((n) => n.body)).toEqual([
      `작업 ${t.id} 검수자 → ${e.ctx.store.members.require(e.qaId).name}(${e.qaId}) (같은 검수자 — 검수를 다시 등록) — 사유: 넘김 안내대로 검수를 다시 등록`,
    ]);
  });

  it('같은 검수자 재등록 뒤의 넘김(팀원 검수자)도 같다 — 목록에서 프로듀서 지시를 빼고 까닭을 끝에 적는다', async () => {
    const e = (env = await bootOrch());
    const d = seedDirective(e);
    const t = seedInReviewTask(e, e.qaId, { outputMode: 'repo', directiveId: d.id });
    e.ctx.store.tasks.patch(t.id, { assigneeId: e.producerId, contributors: [e.producerId], activatedAt: e.ctx.now() });
    e.hold.add(mainKey(e.projectId));
    const producer = e.ctx.store.members.require(e.producerId);
    (e.core.turns as unknown as HandOff).handReviewToMain(e.ctx.store.tasks.require(t.id), d.id, e.projectId, { again: 1, why: '검수 결과가 반복해서 등록되지 않았습니다' });
    const lines = handOffOf(e, t.id).message.split('\n');
    expect(lines.slice(1)).toEqual([
      `- 검수 권한 팀원이 없으면 add_member로 더한 뒤 assign_reviewer(task_id="${t.id}", reviewer_id="…")로 다른 적격 검수자나 "main"(메인 에이전트)을 정하세요 — 같은 검수자(${e.qaId})로 다시 등록한 검수도 판정 없이 끝났습니다.`,
      '- 필요 없는 작업이면 cancel_task로 까닭을 적어 취소하세요.',
      `이 업무를 넣을 때 프로듀서 ${producer.name}이 맡은 작업 ${t.id}이(가) 검수 중이었습니다 — 프로듀서에게 보내는 지시(instruct_member)는 그 작업 세션으로 가서 그 작업이 다시 진행될 때까지 처리되지 않으므로 그 길은 적지 않았습니다.`,
    ]);
  });

  it('프로듀서가 맡은 다른 작업이 보류 중이어도 같다 — 그 작업 세션은 보류가 풀릴 때까지 뜨지 않는다', async () => {
    const e = (env = await bootOrch());
    const d = seedDirective(e);
    const t = seedInReviewTask(e, e.qaId, { outputMode: 'repo', directiveId: d.id });
    const own = seedInReviewTask(e, e.qaId, { outputMode: 'repo', directiveId: d.id });
    e.ctx.store.tasks.patch(own.id, {
      assigneeId: e.producerId,
      contributors: [e.producerId],
      activatedAt: e.ctx.now(),
      state: 'on_hold',
      hold: { reasons: [{ kind: 'interrupted', scope: 'task', note: '시험', since: e.ctx.now(), by: MAIN_AGENT_ID, refId: null }], returnState: 'in_progress' },
    } as never);
    e.hold.add(mainKey(e.projectId));
    const producer = e.ctx.store.members.require(e.producerId);
    (e.core.turns as unknown as HandOff).handReviewToMain(e.ctx.store.tasks.require(t.id), d.id, e.projectId, { producer: '3번의 턴에서 정하지 않았습니다' });
    const msg = handOffOf(e, t.id).message;
    expect(msg).not.toContain('instruct_member로 assign_reviewer를 지시');
    expect(msg).toContain(`이 업무를 넣을 때 프로듀서 ${producer.name}이 맡은 작업 ${own.id}이(가) 보류 중이었습니다`);
    const r = await e.main('instruct_member', { member_id: e.producerId, text: `${t.id}의 검수자를 다시 정해 주세요` });
    expect(r).toMatchObject({ delivered: taskKey(own.id) });
  });

  it('프로듀서가 맡은 작업이 진행 중이면(그 작업 세션이 뜬다) 프로듀서에게 지시하는 길도 마지막에 적는다 — 앞은 add_member·assign_reviewer (S5-11)', async () => {
    const e = (env = await bootOrch());
    const d = seedDirective(e);
    const t = seedInReviewTask(e, e.qaId, { outputMode: 'repo', directiveId: d.id });
    const own = seedInReviewTask(e, e.qaId, { outputMode: 'repo', directiveId: d.id });
    e.ctx.store.tasks.patch(own.id, { assigneeId: e.producerId, contributors: [e.producerId], activatedAt: e.ctx.now(), state: 'in_progress' } as never);
    e.hold.add(mainKey(e.projectId));
    e.hold.add(taskKey(own.id));
    (e.core.turns as unknown as HandOff).handReviewToMain(e.ctx.store.tasks.require(t.id), d.id, e.projectId, { producer: '3번의 턴에서 정하지 않았습니다' });
    const msg = handOffOf(e, t.id).message;
    expect(msg).toMatch(/add_member로 더한 뒤 assign_reviewer\(task_id=.*cancel_task로 취소하세요\. 프로듀서에게 맡기려면 instruct_member로 assign_reviewer를 지시해도 됩니다\.$/);
    expect(msg).not.toContain('그 길은 적지 않았습니다');
    const r = await e.main('instruct_member', { member_id: e.producerId, text: `${t.id}의 검수자를 다시 정해 주세요` });
    expect(r).toMatchObject({ delivered: taskKey(own.id) });
    expect(r.note).toBeUndefined();
  });

  it('프로듀서에게 진행 중인 작업이 없으면(지시가 지시 세션으로 간다) 프로듀서에게 지시하는 길도 마지막에 적고, 그 지시는 프로듀서의 지시 세션으로 간다 (S5-11)', async () => {
    const e = (env = await bootOrch());
    const d = seedDirective(e);
    const t = seedInReviewTask(e, e.qaId, { outputMode: 'repo', directiveId: d.id });
    e.hold.add(mainKey(e.projectId));
    e.hold.add(directiveKey(d.id));
    (e.core.turns as unknown as HandOff).handReviewToMain(e.ctx.store.tasks.require(t.id), d.id, e.projectId, { producer: '3번의 턴에서 정하지 않았습니다' });
    const msg = handOffOf(e, t.id).message;
    expect(msg).toContain(
      `검수 권한 팀원이 없으면 add_member로 더한 뒤 assign_reviewer(task_id="${t.id}", reviewer_id="…")로 검수자를 정하세요(지금 검수자를 다시 정하면 그 검수자에게 검수를 다시 등록합니다). 필요 없으면 cancel_task로 취소하세요. 프로듀서에게 맡기려면 instruct_member로 assign_reviewer를 지시해도 됩니다.`,
    );
    expect(msg).not.toContain('그 길은 적지 않았습니다');
    const r = await e.main('instruct_member', { member_id: e.producerId, text: `${t.id}의 검수자를 다시 정해 주세요` });
    expect(r).toMatchObject({ delivered: directiveKey(d.id) });
  });

  // 시험 빈틈 (리드 결정 48, tests-integrity 6차 재리뷰 — 변이 N6-main-again-unparked): 메인 에이전트가 검수자인 같은 검수자 재등록 뒤의 넘김에서 프로듀서
  // 지시가 미뤄지지 않는 갈래를 본 시험은 reviewRedispatchCap의 예전 단언 하나였고, 그 준비(프로듀서 직접 작업)가 결정 45로 미뤄지는 갈래가 됐다
  it('메인 에이전트가 검수자인 재등록 뒤의 넘김도 프로듀서 지시가 닿으면 결정 17의 길을 적는다 — 검수 팀원 더하기와 assign_reviewer(메인이 직접), 판정 직접 남기기, 취소, 프로듀서 지시 (S5-11)', async () => {
    const e = (env = await bootOrch());
    const d = seedDirective(e);
    // 팀원(dev)이 한 작업이고 메인 에이전트가 검수자다 — 프로듀서에게는 활성 작업이 없다
    const t = seedInReviewTask(e, MAIN_AGENT_ID, { outputMode: 'repo', directiveId: d.id });
    e.hold.add(mainKey(e.projectId));
    e.hold.add(directiveKey(d.id));
    (e.core.turns as unknown as HandOff).handReviewToMain(e.ctx.store.tasks.require(t.id), d.id, e.projectId, { again: 1, why: '검수 결과가 반복해서 등록되지 않았습니다' });
    const lines = handOffOf(e, t.id).message.split('\n');
    expect(lines[0]).toContain('메인 에이전트 자신의 검수 턴이 판정 없이 반복해서 끝납니다');
    // 같은 "main"을 다시 정하라고 권하지 않고(결정 11·17), 미루는 까닭 줄도 없다
    expect(lines.slice(1)).toEqual([
      `- 검수 권한 팀원이 없으면 add_member로 더한 뒤 assign_reviewer(task_id="${t.id}", reviewer_id="…")로 다른 적격 검수자를 정하세요 — 같은 검수자(메인 에이전트)로 다시 등록한 검수도 판정 없이 끝났습니다.`,
      `- 판정을 직접 남기려면 interrupt_task 뒤 resume_task(task_id="${t.id}")로 검수를 다시 등록하고, 그 검수 턴에서 submit_review로 결과를 꼭 등록하세요.`,
      '- 필요 없는 작업이면 cancel_task로 까닭을 적어 취소하세요.',
      '- 프로듀서에게 맡기려면 instruct_member로 assign_reviewer를 지시해도 됩니다.',
    ]);
    // 안내한 지시는 프로듀서의 지시 세션으로 간다 — 미뤄지지 않는다
    const r = await e.main('instruct_member', { member_id: e.producerId, text: `${t.id} 검수자를 새 팀원으로 정해 주세요 (assign_reviewer)` });
    expect(r).toMatchObject({ delivered: directiveKey(d.id) });
    expect(r.note).toBeUndefined();
  });
});
