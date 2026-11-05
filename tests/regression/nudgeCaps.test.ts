/**
 * 프로듀서 재촉의 상한 (리드 결정 30·40, 10-30 — tests-integrity 4차 재리뷰 [4], 프로브 zz-s1fix4-ti-plan-nudge-cap, 변이 N4-plan-cap·N4-producer-cap):
 * - 계획 재촉(directives.afterPlanTurn)과 프로듀서 재촉(turns.judgeDirective — 질문 응답·병합 판단·최종 결과·재계획)은 결정 30부터 그 항목의 다시 전달 횟수
 *   (QueueEntry.deliveries)로 센다. 상한(2번 재촉) 뒤에는 대표에게 '계획 지연'·'프로듀서 처리 지연'을 한 번 알리고 같은 종류 항목을 더 넣지 않는다
 * - 이 상한을 보는 시험이 없어, 횟수를 저장하지 않는 회귀(같은 재촉 턴이 끝없이 돌고 대표 알림은 가지 않음)가 살아남았다
 * - 상한 뒤의 알림('계획 지연'·'프로듀서 처리 지연'·'보고서 작성 지연')은 사실만 말하고 출구가 없었다 — 그 일은 아무에게도 가지 않으므로 결정 32의 문장으로
 *   끝낸다 (리드 결정 45, owner-surface 5차 재리뷰 NX, 프로브 zz-s1fix5-os-nx-no-exit-notices)
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID } from '@shared/domain';
import { directiveKey, enqueue, mainKey } from '../../src/main/orchestrator/records';
import type { OrchEnv } from './orchHarness';
import { bootOrch, seedDirective, sleep, waitFor } from './orchHarness';

/** 결정 32의 문장 — 재촉 상한 뒤 그 일이 메인에게도 가지 않으면 대표가 명령창으로 메인 에이전트에게 알리는 길 (리드 결정 45) */
const TELL = '명령창으로 메인 에이전트에게 알려 주세요. 메인 에이전트가 확인하고 이어 갑니다';
/**
 * 5단계 S5b(리드 결정 S5-8): '계획 지연'·'프로듀서 처리 지연'은 메인 에이전트에게 알림 업무로 한 번 넘긴다(alert plan-stuck:<지시>, producer-stuck:<지시>:<종류> —
 * 지금 회차마다 한 번). 알림은 넘긴 사실로 끝난다. '보고서 작성 지연'은 메인이 이미 세 번 받은 일이라 대표 알림만 그대로다 (결정 32의 문장)
 */
const HANDED = '메인 에이전트에게 넘겼습니다. 메인 에이전트가 확인하고 이어 갑니다 — 서둘러야 하면 명령창으로 메인 에이전트에게 알려 주세요';
const mainAlerts = (e: OrchEnv) => e.ctx.store.queue.list({ ref1: MAIN_AGENT_ID }).filter((q) => q.kind === 'alert').map((q) => q.alertKey);

let env: OrchEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const turnsOf = (e: OrchEnv, key: string) => e.launches.filter((l) => l.workKey === key).length;
async function ticks(e: OrchEnv, n: number) {
  for (let i = 0; i < n; i++) {
    e.tick();
    await sleep(25);
  }
}

describe('프로듀서 재촉은 두 번까지 — 그 뒤 대표 알림 하나, 더 넣지 않는다 (리드 결정 30·40)', () => {
  it('계획 재촉: 작업을 만들지 않는 계획 턴 세 번 뒤 계획 지연 알림 하나, 네 번째 계획 턴은 없다', async () => {
    const e = (env = await bootOrch());
    const d = seedDirective(e, '계획 지시');
    e.ctx.store.directives.put({ ...e.ctx.store.directives.require(d.id), state: 'planning' });
    const key = directiveKey(d.id);
    e.script.set(key, (p) => p.finishOk('검토 중입니다'));
    enqueue(e.ctx, { kind: 'plan', memberId: e.producerId, sessionKey: key, projectId: e.projectId, directiveId: d.id, priority: 'high', message: '계획을 세우세요' });
    await waitFor(
      () => {
        e.tick();
        return e.ctx.store.notifications.list().some((n) => n.key === `plan-stuck:${d.id}`) || turnsOf(e, key) > 5;
      },
      '계획 지연 알림 (또는 끝없는 재촉)',
      40_000,
    );
    await ticks(e, 20);
    expect(turnsOf(e, key)).toBe(3);
    expect(e.ctx.store.queue.list({ ref2: key, state: ['queued', 'running'] }).filter((q) => q.kind === 'plan')).toEqual([]);
    const n = e.ctx.store.notifications.list().filter((x) => x.key === `plan-stuck:${d.id}`);
    // 지시는 계획 중으로 남고 그 일은 아무에게도 가지 않는다 — 대표가 명령창으로 메인 에이전트에게 알리는 길을 적는다 (리드 결정 45, 프로브 NX-a)
    expect(n.map((x) => [x.title, x.body])).toEqual([['계획 지연', `${d.id} ${d.title} — 프로듀서가 작업을 만들지 못했습니다. ${HANDED}`]]);
    // 그 일은 메인 에이전트에게 알림 업무로 한 번 간다 (리드 결정 S5-8)
    expect(mainAlerts(e)).toEqual([`alert:plan-stuck:${d.id}`]);
    expect(e.ctx.store.directives.require(d.id).state).toBe('planning');
  });

  it('질문 응답 재촉: 프로듀서가 팀원 질문에 답하지 않는 턴 세 번 뒤 프로듀서 처리 지연 알림 하나, 네 번째 턴은 없다', async () => {
    const e = (env = await bootOrch());
    const d = seedDirective(e, '질문 지시');
    const key = directiveKey(d.id);
    e.hold.add(key);
    // 팀원이 프로듀서에게 물었고, 프로듀서 턴은 답하지 않고 끝난다
    const now = e.ctx.now();
    e.ctx.store.questions.insert({
      id: e.ctx.store.nextId('question'),
      projectId: e.projectId,
      directiveId: d.id,
      taskId: null,
      fromId: e.devId,
      to: 'producer',
      sessionKey: key,
      text: '어느 결제 API를 쓰나요?',
      status: 'open',
      answer: null,
      answeredBy: null,
      createdAt: now,
      answeredAt: null,
    } as never);
    e.hold.delete(key);
    e.script.set(key, (p) => p.finishOk('확인했습니다'));
    enqueue(e.ctx, { kind: 'answer', memberId: e.producerId, sessionKey: key, projectId: e.projectId, directiveId: d.id, priority: 'high', message: '질문에 답하세요' });
    await waitFor(
      () => {
        e.tick();
        return e.ctx.store.notifications.list().some((n) => n.key === `producer-stuck:${d.id}:answer`) || turnsOf(e, key) > 5;
      },
      '프로듀서 처리 지연 알림 (또는 끝없는 재촉)',
      40_000,
    );
    await ticks(e, 20);
    expect(turnsOf(e, key)).toBe(3);
    expect(e.ctx.store.queue.list({ ref2: key, state: ['queued', 'running'] }).filter((q) => q.kind === 'answer')).toEqual([]);
    const n = e.ctx.store.notifications.list().filter((x) => x.key === `producer-stuck:${d.id}:answer`);
    expect(n.map((x) => x.title)).toEqual(['프로듀서 처리 지연']);
    // 그 일은 메인 에이전트에게 알림 업무로 한 번 간다 — 글에 기다리는 일과 프로듀서에게 할 수 있는 것 (리드 결정 S5-8)
    const alerts = e.ctx.store.queue.list({ ref1: MAIN_AGENT_ID }).filter((q) => q.kind === 'alert');
    expect(alerts.map((q) => [q.alertKey, q.sessionKey])).toEqual([[`alert:producer-stuck:${d.id}:answer`, mainKey(e.projectId)]]);
    expect(alerts[0]!.message).toContain('answer_question으로 답하세요');
    expect(alerts[0]!.message).toContain(`instruct_member`);
    // 무엇을 처리하지 않았는지와 명령창 길을 적는다 (리드 결정 45)
    expect(n[0]!.body).toBe(
      `${d.id}: 프로듀서가 같은 요청을 세 번 받고도 처리하지 않았습니다 (아직 답하지 않은 질문: ${e.ctx.store.questions.list({ state: 'open' })[0]!.id}: 어느 결제 API를 쓰나요?. answer_question으로 답하세요). ${HANDED}`,
    );
  });

  it('보고서 작성 재촉: 메인 에이전트가 보고서를 내지 않는 턴 세 번 뒤 보고서 작성 지연 알림 하나 — 명령창 길을 적는다 (리드 결정 45, 프로브 NX-b)', async () => {
    const e = (env = await bootOrch());
    const d = seedDirective(e, '보고 지시');
    e.ctx.store.directives.put({ ...e.ctx.store.directives.require(d.id), state: 'reporting' });
    const key = mainKey(e.projectId);
    e.script.set(key, (p) => p.finishOk('정리 중입니다'));
    enqueue(e.ctx, { kind: 'main_report', memberId: MAIN_AGENT_ID, sessionKey: key, projectId: e.projectId, directiveId: d.id, priority: 'high', message: `${d.id} 보고서를 submit_report로 제출하세요` });
    await waitFor(
      () => {
        e.tick();
        return e.ctx.store.notifications.list().some((n) => n.key === `report-stuck:${d.id}`) || turnsOf(e, key) > 5;
      },
      '보고서 작성 지연 알림 (또는 끝없는 재촉)',
      40_000,
    );
    await ticks(e, 20);
    expect(turnsOf(e, key)).toBe(3);
    expect(e.ctx.store.queue.list({ ref2: key, state: ['queued', 'running'] }).filter((q) => q.kind === 'main_report')).toEqual([]);
    expect(e.ctx.store.directives.require(d.id).state).toBe('reporting');
    const n = e.ctx.store.notifications.list().filter((x) => x.key === `report-stuck:${d.id}`);
    expect(n.map((x) => [x.title, x.body])).toEqual([['보고서 작성 지연', `${d.id} 보고서가 제출되지 않았습니다 — 메인 에이전트에게 세 번 요청했지만 내지 않았습니다. 어떻게 할지 ${TELL}`]]);
  });
});
