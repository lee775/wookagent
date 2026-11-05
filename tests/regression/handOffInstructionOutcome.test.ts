/**
 * 멈춘 검수 넘김의 머리말은 앞서 보낸 지시가 정말 처리됐을 때만 '처리됐지만'이라고 쓴다 (리드 결정 40, 10-30 — flows 4차 재리뷰 관찰 4):
 * - 예전 머리말은 기다리는 진행이 없으면 늘 '앞서 프로듀서에게 지시했다면 그 지시는 처리됐지만 검수가 다시 시작되지 않은 것입니다'라고 썼다. 그 지시가
 *   프로듀서의 비정상 종료 상한으로 버려졌거나, 시작 실패로 취소돼 전달되지 않았어도 같았다 — 메인 에이전트는 처리된 지시를 기다리거나 다시 보내지 않는다
 * - 이제 전달할 때, 앞서 그 넘김을 실은 메인 턴부터 메인 에이전트가 보낸 지시를 하나하나 본다. 그 지시를 실은 마지막 항목이 마쳤고 그 턴이 정상으로
 *   끝났으면 '처리됐지만', 취소·전달 못 함이거나 그 턴이 다른 끝으로 끝나 다시 넣지 않았으면 받는 쪽에 닿지 못했다고 쓴다. 보낸 지시가 없으면 짐작하지 않는다
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID, type Task } from '@shared/domain';
import { directiveKey, mainKey } from '../../src/main/orchestrator/records';
import type { FakeProc, OrchEnv } from './orchHarness';
import { bootOrch, seedDirective, seedInReviewTask, sleep, waitFor } from './orchHarness';

let env: OrchEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const handOffs = (e: OrchEnv, t: Task) => e.ctx.store.queue.list({ state: ['queued', 'running'] }).filter((q) => q.memberId === MAIN_AGENT_ID && q.sessionKey.startsWith('main:') && q.taskId === t.id);

/** 메인 에이전트가 유일한 검수자인 작업의 검수가 멈춰 메인에게 넘어간다. 메인 프로젝트 세션 턴은 띄운 채 둔다 (standingLiveness와 같은 준비) */
async function handedToMain(e: OrchEnv): Promise<Task> {
  await e.internal('members.remove', e.qaId);
  const d = seedDirective(e);
  const t = seedInReviewTask(e, MAIN_AGENT_ID, { outputMode: 'repo', directiveId: d.id });
  e.hold.add(mainKey(e.projectId));
  e.script.set(directiveKey(d.id), (p) => {
    void e.tool(p.turnId, 'assign_reviewer', { task_id: t.id, reviewer_id: 'main' }).finally(() => p.finishOk());
  });
  e.core.tasks.dispatchReview(t);
  await waitFor(
    () => {
      e.tick();
      return !!e.liveProc(mainKey(e.projectId), MAIN_AGENT_ID) && handOffs(e, t).length > 0;
    },
    '메인 에이전트에게 넘김',
    40_000,
  );
  e.script.delete(directiveKey(d.id));
  e.hold.add(directiveKey(d.id));
  await sleep(50);
  return e.ctx.store.tasks.require(t.id);
}

async function ended(e: OrchEnv, p: FakeProc): Promise<void> {
  await waitFor(() => !e.core.turns.liveTurnIds().includes(p.turnId), '턴 마무리');
  await sleep(30);
}

/** 넘김을 실은 메인 턴에서 프로듀서에게 지시하고 그 턴을 마친다 */
async function instructProducerAndEnd(e: OrchEnv, t: Task): Promise<void> {
  const p = e.liveProc(mainKey(e.projectId), MAIN_AGENT_ID)!;
  expect((await e.tool(p.turnId, 'instruct_member', { member_id: e.producerId, text: `${t.id} 검수자를 다시 정해 주세요` })).ok).toBe(true);
  p.finishOk('프로듀서에게 지시했습니다');
  await ended(e, p);
}

/** 기다리던 진행이 끝난 뒤 다시 전달된 넘김의 메시지 */
async function secondDelivery(e: OrchEnv, label: string): Promise<string> {
  const key = mainKey(e.projectId);
  await waitFor(
    () => {
      if (!e.liveProc(key, MAIN_AGENT_ID)) e.tick();
      return !!e.liveProc(key, MAIN_AGENT_ID);
    },
    label,
    40_000,
  );
  const p = e.liveProc(key, MAIN_AGENT_ID)!;
  return e.launches.find((x) => x.turnId === p.turnId)!.message;
}

const SETTLED = '팀원에게 보낸 지시나 대표에게 한 질문 가운데 처리를 기다리는 것도 지금은 없습니다';

describe("넘김 머리말의 '처리됐지만'은 사실일 때만 (리드 결정 40)", () => {
  it('프로듀서가 지시를 받은 턴을 정상으로 마쳤으면 그 지시는 처리됐다고 쓴다', async () => {
    const e = (env = await bootOrch());
    const t = await handedToMain(e);
    const producer = e.ctx.store.members.require(e.producerId);
    await instructProducerAndEnd(e, t);
    // 프로듀서는 지시를 받아 검수자를 정하지 않고 턴을 마친다
    e.hold.delete(directiveKey(t.directiveId));
    const msg = await secondDelivery(e, '넘김 두 번째 전달');
    expect(msg).toContain(`${SETTLED} — 앞서 ${producer.name}에게 보낸 지시는 처리됐지만 검수가 다시 시작되지 않은 것입니다. 아래 안내대로 처리하세요.`);
    expect(msg).not.toContain('닿지 못했습니다');
  });

  it('프로듀서 턴이 비정상 종료 상한까지 끝나 지시가 버려졌으면 처리됐다고 쓰지 않고 받는 쪽에 닿지 못했다고 쓴다', async () => {
    const e = (env = await bootOrch());
    const t = await handedToMain(e);
    const producer = e.ctx.store.members.require(e.producerId);
    await instructProducerAndEnd(e, t);
    const dKey = directiveKey(t.directiveId);
    e.script.set(dKey, (p) => p.exit(1));
    e.hold.delete(dKey);
    const msg = await secondDelivery(e, '프로듀서 비정상 종료 상한 뒤 넘김 두 번째 전달');
    expect(e.ctx.store.turns.list().filter((x) => x.memberId === e.producerId && x.endReason === 'crashed')).toHaveLength(e.ctx.settings().execution.crashRetryMax + 1);
    expect(msg).toContain(`${SETTLED}. 앞서 ${producer.name}에게 보낸 지시는 받는 쪽에 닿지 못했습니다(${producer.name}: 받은 턴이 비정상 종료로 끝나 처리하지 못함). 아래 안내대로 처리하세요.`);
    expect(msg).not.toContain('처리됐지만');
  });

  it('프로듀서 턴이 시작하지 못해 지시가 취소됐으면 전달되지 못했다고 그 까닭과 함께 쓴다', async () => {
    const e = (env = await bootOrch());
    const t = await handedToMain(e);
    const producer = e.ctx.store.members.require(e.producerId);
    await instructProducerAndEnd(e, t);
    const dKey = directiveKey(t.directiveId);
    e.prepareHook = (_launch, who) => {
      if (who.sessionKey === dKey) throw new Error('모델 이름을 찾을 수 없습니다 (시험)');
    };
    e.hold.delete(dKey);
    const msg = await secondDelivery(e, '프로듀서 시작 실패 상한 뒤 넘김 두 번째 전달');
    expect(msg).toContain(`${SETTLED}. 앞서 ${producer.name}에게 보낸 지시는 받는 쪽에 닿지 못했습니다(${producer.name}: 전달되지 못함 — 업무 시작이 3회 실패해 그 업무를 멈춤`);
    expect(msg).not.toContain('처리됐지만');
  });

  it('보낸 지시가 없으면 처리됐다고 짐작하지 않는다', async () => {
    const e = (env = await bootOrch());
    const t = await handedToMain(e);
    const p = e.liveProc(mainKey(e.projectId), MAIN_AGENT_ID)!;
    p.finishOk('확인했습니다');
    await ended(e, p);
    const msg = await secondDelivery(e, '넘김 두 번째 전달');
    expect(msg).toContain(`(2번째 알림 — ${t.id} 검수가 아직 다시 시작되지 않았습니다) 지금 이 작업에는 대기·실행 중인 검수도, 검수자 재배정 업무도 없습니다. ${SETTLED}. 아래 안내대로 처리하세요.`);
    expect(msg).not.toContain('처리됐지만');
  });
});
