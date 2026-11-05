/**
 * 메인 에이전트의 '진행'은 스케줄러의 허용 검사로 본다 (리드 결정 38, 10-30 — owner-surface 4차 재리뷰 P2, 프로브 zz-s1fix4-os-p2-parked-ai-blocked):
 * - 남는 업무(멈춘 검수 넘김·팀원 재개)는 메인이 그 일로 팀원에게 보낸 지시가 아직 전달 전이면 다시 전달하지 않고 기다린다(리드 결정 31). 받는 쪽이 지금 받을
 *   수 없는 지시는 진행으로 보지 않는다 — 끝없이 미루지 않게. 그런데 예전 판정(turns.mainProgress의 deliverable)은 정지와 세션 상태만 보고, 받는 팀원의 AI
 *   쪽 막힘(재로그인 필요, CLI 없음·문제, 사용량 한도, 그 팀원 모델의 모델별 주간 한도)은 보지 않았다. 스케줄러는 그 지시를 띄우지 않는데 넘김은 그것을
 *   진행으로 세어, 막힘이 풀릴 때까지(재로그인이면 기한 없이, 모델별 주간 한도면 며칠) 다시 전달되지 않았고 대표에게도 '메인 에이전트 처리 지연'이 가지 않았다
 * - 이제 진행 판정은 스케줄러와 같은 허용 검사(entryRunGate — 받는 팀원의 AI 가용성과 그 팀원·세션이 쓸 모델, 모의 실행이면 AI는 보지 않음)를 쓴다. 막히면
 *   진행이 아니다: 넘김은 다시 전달되고, 머리말은 그 지시가 왜 전달되지 않는지 그때 확인한 까닭을 적으며, 세 번 뒤 대표에게 알린다
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID, type QueueEntry, type Task } from '@shared/domain';
import { directiveKey, mainKey } from '../../src/main/orchestrator/records';
import type { FakeProc, OrchEnv } from './orchHarness';
import { bootOrch, seedDirective, seedInReviewTask, sleep, waitFor } from './orchHarness';

let env: OrchEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const live = (e: OrchEnv) => e.ctx.store.queue.list({ state: ['queued', 'running'] });
const handOffs = (e: OrchEnv, t: Task) => live(e).filter((q) => q.memberId === MAIN_AGENT_ID && q.sessionKey.startsWith('main:') && q.taskId === t.id);
async function ticks(e: OrchEnv, n: number) {
  for (let i = 0; i < n; i++) {
    e.tick();
    await sleep(25);
  }
}
async function nextTurn(e: OrchEnv, key: string, memberId: string, label: string): Promise<{ p: FakeProc; carried: QueueEntry[] }> {
  await waitFor(
    () => {
      if (!e.liveProc(key, memberId)) e.tick();
      return !!e.liveProc(key, memberId);
    },
    label,
  );
  const p = e.liveProc(key, memberId)!;
  return { p, carried: e.ctx.store.turns.get(p.turnId)!.queueEntryIds.map((id) => e.ctx.store.queue.get(id)!) };
}
async function ended(e: OrchEnv, p: FakeProc): Promise<void> {
  await waitFor(() => !e.core.turns.liveTurnIds().includes(p.turnId), '턴 마무리');
  await sleep(30);
}

/** 메인 에이전트가 유일한 검수자인 작업의 검수가 멈춰 메인 에이전트에게 넘어간다. 메인 프로젝트 세션의 턴은 띄운 채 둔다 */
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

/**
 * 넘김을 실은 메인 턴이 프로듀서에게 검수자를 다시 정하라고 지시한 사이 프로듀서 쪽 AI가 막힌다(block). 그 뒤 대표가 명령을 세 번 보내 메인 턴이 세 번 돈다.
 * 받을 수 없는 지시는 진행이 아니므로 넘김은 두 번 더 전달되고(머리말이 그 까닭을 적음), 세 번째 전달 뒤 대표에게 알린다
 */
async function blockedReceiverFlow(e: OrchEnv, block: () => void, unblock: () => void, why: string): Promise<void> {
  const t = await handedToMain(e);
  const pKey = mainKey(e.projectId);
  const producer = e.ctx.store.members.require(e.producerId);
  const { p } = await nextTurn(e, pKey, MAIN_AGENT_ID, '넘김 첫 전달');
  await e.tool(p.turnId, 'instruct_member', { member_id: e.producerId, text: `${t.id} 검수자를 다시 정해 주세요` });
  block();
  p.finishOk('프로듀서에게 지시했습니다');
  await ended(e, p);
  // 받는 쪽이 막혀 스케줄러가 그 지시를 띄우지 않는다 — 진행이 아니다. 같은 지시가 받을 수 있게 되면 진행이다 (판정을 가르는 것은 허용 검사다)
  expect(e.core.turns.mainProgressPending(e.projectId)).toBe(false);
  unblock();
  expect(e.core.turns.mainProgressPending(e.projectId)).toBe(true);
  block();
  const mainMessages: string[] = [];
  for (let i = 0; i < 3; i++) {
    await e.invoke('command.send', { target: e.projectId, text: `명령 ${i + 1}: 진행 상황 알려 줘` });
    const { p: m } = await nextTurn(e, pKey, MAIN_AGENT_ID, `대표 명령 ${i + 1}`);
    mainMessages.push(e.launches.find((x) => x.turnId === m.turnId)!.message);
    m.finishOk('정리했습니다');
    await ended(e, m);
  }
  await ticks(e, 20);
  // 지시는 여전히 전달되지 못했고 작업은 검수 중인데 검수도 없다 — 그래서 넘김이 처리할 수 있는 쪽(메인, 그다음 대표)에게 가야 한다
  expect(live(e).filter((q) => q.memberId === e.producerId && !!q.messageId).map((q) => q.state)).toEqual(['queued']);
  expect(e.ctx.store.tasks.require(t.id).state).toBe('in_review');
  expect(e.core.tasks.reviewPending(t.id)).toBe(false);
  // 넘김은 기다리지 않고 두 번 더 전달된다 — 머리말은 그때 확인한 까닭을 적는다
  const heads = mainMessages.map((m) => m.split('\n').find((x) => x.includes('번째 알림 —')) ?? null);
  expect(heads.map((h) => h?.match(/\((\d)번째 알림/)?.[1] ?? null)).toEqual(['2', '3', null]);
  for (const h of heads.slice(0, 2)) {
    expect(h).toContain(`앞서 ${producer.name}에게 보낸 지시가 아직 전달되지 않았습니다 — 받는 쪽이 지금 그 업무를 받을 수 없어(${producer.name}: ${why}`);
    expect(h).toContain('그 까닭이 풀리기 전에는 처리되지 않습니다.');
    expect(h).not.toContain('처리됐지만');
  }
  // 세 번째 전달 뒤 대표에게 그 작업을 알리고 넘김은 끝난다
  expect(handOffs(e, t)).toEqual([]);
  expect(e.ctx.store.notifications.list().filter((n) => n.key === `handoff-stuck:${t.id}`).map((n) => n.body)).toEqual([expect.stringContaining('메인 에이전트에게 3번 넘겼지만 검수가 다시 시작되지 않았습니다')]);
}

describe('메인 에이전트의 진행 판정은 스케줄러의 허용 검사를 쓴다 (리드 결정 38)', () => {
  it('Codex 프로듀서가 재로그인 필요인 동안 보낸 지시는 진행이 아니다 — 넘김이 다시 전달되고 세 번 뒤 대표에게 알린다 (프로브 P2)', async () => {
    const e = (env = await bootOrch({ mock: false }));
    const prod = e.ctx.store.members.require(e.producerId);
    e.ctx.store.members.put({ ...prod, ai: { ...prod.ai, kind: 'codex', model: null } });
    await blockedReceiverFlow(
      e,
      () => e.ctx.saveAi({ ...e.ctx.ai('codex'), authRequired: true, authRequiredSince: e.ctx.now() }),
      () => e.ctx.saveAi({ ...e.ctx.ai('codex'), authRequired: false, authRequiredSince: null }),
      'codex 인증 만료 — 재로그인 필요',
    );
  });

  it('프로듀서 모델이 모델별 주간 한도에 걸린 동안 보낸 지시도 진행이 아니다 — 다른 모델로 도는 메인은 그대로 일하고 넘김을 다시 받는다', async () => {
    const e = (env = await bootOrch({ mock: false }));
    // 메인은 Sonnet, 프로듀서는 Opus — Opus 주간 한도는 프로듀서의 턴만 막는다 (리드 결정 22)
    const main = e.ctx.store.members.require(MAIN_AGENT_ID);
    e.ctx.store.members.put({ ...main, ai: { ...main.ai, kind: 'claude', model: 'claude-sonnet-4-5' } });
    const prod = e.ctx.store.members.require(e.producerId);
    e.ctx.store.members.put({ ...prod, ai: { ...prod.ai, kind: 'claude', model: 'claude-opus-4-1' } });
    const until = new Date(Date.now() + 5 * 24 * 3600_000).toISOString();
    await blockedReceiverFlow(
      e,
      () => e.ctx.saveAi({ ...e.ctx.ai('claude'), modelUsageLimits: { opus: until } }),
      () => e.ctx.saveAi({ ...e.ctx.ai('claude'), modelUsageLimits: {} }),
      `claude Opus 주간 한도 (${until}까지, 이 모델 계열의 턴만)`,
    );
    expect(e.ctx.ai('claude').usageLimitedUntil ?? null).toBeNull();
  });
});
