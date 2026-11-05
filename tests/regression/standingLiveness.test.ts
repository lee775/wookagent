/**
 * 남는 업무(멈춘 검수 넘김·프로그램이 일시정지한 팀원의 재개)가 아직 필요한지는 한 판정으로 본다 (리드 결정 31, 10-30 — flows 재리뷰 medium '낡은 다시 넣기'와
 * 그 low들, 프로브 zz-s1fx3fg-stale-renudge·ask-owner-escalates·pause-lifecycle (3)):
 * - 예전에는 다시 넣을 때만 대상을 보고 머리말('지금 대기·실행 중인 검수도 … 없습니다')을 저장했다. 스케줄러는 작업이 검수를 벗어났을 때만 지웠으므로, 그
 *   사이 검수가 다시 등록돼도 그 거짓 머리말이 메인 에이전트에게 갔다. 다시 넣기는 곧바로 해서, 메인이 대표에게 묻거나 프로듀서에게 지시하고 기다리는 동안에도
 *   세 번 전달되고 대표에게 '메인 에이전트 처리 지연'이 갔다. 메인이 직접 다시 일시정지한 팀원의 재개 업무도 남아 재촉했다
 * - 이제 넣을 때·전달하기 전·다시 넣을 때·재시작 복구가 같은 판정(deadWorkReason)을 쓰고, 필요 없어진 항목은 기록 한 줄과 함께 지운다. 머리말은 전달할 때
 *   계산해 붙이고 저장하지 않는다(쌓이지 않음). 메인이 그 일로 시작한 진행(대표에게 한 질문, 팀원에게 보낸 지시)이 끝나지 않았으면 다시 전달하지 않고 기다리며
 *   세지도 않는다 — 대표 알림은 매번 대상이 그대로이고 기다리는 진행도 없는 전달 세 번 뒤에만 간다
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID, type QueueEntry, type Task } from '@shared/domain';
import { directiveKey, enqueue, mainKey, reviewKey } from '../../src/main/orchestrator/records';
import type { FakeProc, OrchEnv } from './orchHarness';
import { bootOrch, seedDirective, seedInReviewTask, sleep, waitFor } from './orchHarness';

let env: OrchEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const live = (e: OrchEnv) => e.ctx.store.queue.list({ state: ['queued', 'running'] });
const handOffs = (e: OrchEnv, t: Task) => live(e).filter((q) => q.memberId === MAIN_AGENT_ID && q.sessionKey.startsWith('main:') && q.taskId === t.id);
const pauseItems = (e: OrchEnv, memberId: string) => live(e).filter((q) => q.memberId === MAIN_AGENT_ID && q.pausedMemberId === memberId);
const notices = (e: OrchEnv, key: string) => e.ctx.store.notifications.list().filter((n) => n.key === key);
const launchesOf = (e: OrchEnv, key: string) => e.launches.filter((l) => l.workKey === key);
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

/**
 * 메인 에이전트가 검수자인 작업(담당은 개발자)의 검수가 멈춰 메인에게 넘어간다. 메인 프로젝트 세션은 띄운 채 둔다. 그 뒤 프로듀서 턴도 띄운 채 둔다.
 * producerWorks: 프로듀서를 그 작업의 담당으로 둔다 — 그러면 프로듀서에게 보내는 지시는 검수 중인 그 작업 세션으로 가서 재작업 전에는 전달되지 않는다
 */
async function handedToMain(e: OrchEnv, o: { producerWorks?: boolean } = {}): Promise<Task> {
  await e.internal('members.remove', e.qaId);
  const d = seedDirective(e);
  const t0 = seedInReviewTask(e, MAIN_AGENT_ID, { outputMode: 'repo', directiveId: d.id });
  if (o.producerWorks) e.ctx.store.tasks.patch(t0.id, { assigneeId: e.producerId, contributors: [e.producerId] });
  const t = e.ctx.store.tasks.require(t0.id);
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
  return t;
}

/** 프로듀서 턴이 하위 프로세스 1개를 남겨 프로그램이 프로듀서를 일시정지하고, 메인 에이전트에게 재개 업무가 간다 (programPauseToMain과 같은 준비) */
async function producerPausedByProgram(e: OrchEnv): Promise<Task> {
  await e.internal('members.remove', e.qaId);
  const d = seedDirective(e);
  const t = seedInReviewTask(e, MAIN_AGENT_ID, { outputMode: 'repo', directiveId: d.id });
  let n = 0;
  e.script.set(directiveKey(d.id), (p) => {
    n += 1;
    if (n === 1) {
      p.emit({ kind: 'result', text: '확인 중', data: {} });
      p.exit(0, { remaining: 1 });
      return;
    }
    void e.tool(p.turnId, 'assign_reviewer', { task_id: t.id, reviewer_id: 'main' }).finally(() => p.finishOk());
  });
  e.core.tasks.dispatchReview(e.ctx.store.tasks.require(t.id));
  await waitFor(
    () => {
      e.tick();
      return !!e.ctx.stop().members[e.producerId]?.paused && pauseItems(e, e.producerId).length > 0;
    },
    '프로듀서 일시정지와 메인 에이전트 재개 업무',
    40_000,
  );
  await sleep(50);
  return e.ctx.store.tasks.require(t.id);
}

describe('남는 업무는 전달하기 전에 다시 본다 (리드 결정 31)', () => {
  it('메인이 프로듀서에게 지시한 사이 검수가 다시 등록되면, 기다리던 넘김은 전달하지 않고 지운다 — 거짓 머리말이 메인에게 가지 않는다 (프로브 stale-renudge)', async () => {
    const e = (env = await bootOrch());
    const t = await handedToMain(e);
    const pKey = mainKey(e.projectId);
    e.hold.add(mainKey(null));
    e.hold.add(reviewKey(t.id));
    const handOffTurn = e.liveProc(pKey, MAIN_AGENT_ID)!;
    // 메인은 넘김 안내의 첫 길대로 프로듀서에게 검수자를 다시 정하라고 지시하고 턴을 마친다. 그 사이 대표 명령이 main:general로 온다
    await e.tool(handOffTurn.turnId, 'instruct_member', { member_id: e.producerId, text: `${t.id} 검수자를 "main"으로 다시 정해 주세요 (assign_reviewer)` });
    await e.invoke('command.send', { target: 'main', text: '오늘 일정 정리해 줘' });
    handOffTurn.finishOk('프로듀서에게 검수자 재지정을 지시했습니다');
    await ended(e, handOffTurn);
    // 넘김은 다시 들어오지만(전달 1) 지시가 처리되는 동안은 기다린다 — 메인은 대표 명령 턴을 받는다
    expect(handOffs(e, t).map((q) => [q.state, q.deliveries])).toEqual([['queued', 1]]);
    const { p: general } = await nextTurn(e, mainKey(null), MAIN_AGENT_ID, '대표 명령 턴');
    // 프로듀서가 지시를 받아 같은 검수자 "main"을 다시 정한다 → 검수가 다시 등록됨
    const { p: prod } = await nextTurn(e, directiveKey(t.directiveId), e.producerId, '프로듀서 턴');
    expect((await e.tool(prod.turnId, 'assign_reviewer', { task_id: t.id, reviewer_id: 'main' })).ok).toBe(true);
    prod.finishOk('검수자 다시 정함');
    await ended(e, prod);
    expect(e.core.tasks.reviewPending(t.id)).toBe(true);
    general.finishOk('정리했습니다');
    await ended(e, general);
    await ticks(e, 10);
    // 넘김은 메인 턴에 실리지 않고 지워진다(기록 한 줄). 메인 에이전트는 다시 등록된 자기 검수 턴을 받는다
    expect(launchesOf(e, pKey)).toHaveLength(1);
    expect(handOffs(e, t)).toEqual([]);
    expect(e.ctx.store.activity.search({ text: '끝난 일의 메시지 확인 업무 정리', limit: 10 }).map((a) => a.text)).toEqual([
      `끝난 일의 메시지 확인 업무 정리 — ${t.id}의 검수가 다시 등록됨 (${pKey}, 다시 전달하지 않음)`,
    ]);
    expect(e.liveProc(reviewKey(t.id), MAIN_AGENT_ID)).toBeTruthy();
    expect(notices(e, `handoff-stuck:${t.id}`)).toEqual([]);
  });

  it('메인이 프로듀서에게 지시하고 프로듀서가 오래 걸리면 기다린다 — 그동안은 전달도 대표 알림도 없고, 매번 대상이 그대로이고 기다리는 것도 없는 전달 세 번 뒤에야 대표에게 알린다', async () => {
    const e = (env = await bootOrch());
    const t = await handedToMain(e);
    const pKey = mainKey(e.projectId);
    const dKey = directiveKey(t.directiveId);
    for (let i = 0; i < 3; i++) {
      const { p } = await nextTurn(e, pKey, MAIN_AGENT_ID, `넘김 전달 ${i + 1}`);
      const launched = e.launches.find((x) => x.turnId === p.turnId)!.message;
      if (i > 0) {
        // 머리말은 전달하는 지금 확인한 사실이다 — 기다리는 지시도 없고 검수도 재배정도 없다
        expect(launched).toContain(
          `> (${i + 1}번째 알림 — ${t.id} 검수가 아직 다시 시작되지 않았습니다) 지금 이 작업에는 대기·실행 중인 검수도, 검수자 재배정 업무도 없습니다. 팀원에게 보낸 지시나 대표에게 한 질문 가운데 처리를 기다리는 것도 지금은 없습니다`,
        );
        expect(launched.match(/번째 알림 —/g)).toHaveLength(1);
      }
      await e.tool(p.turnId, 'instruct_member', { member_id: e.producerId, text: `${t.id} 검수자를 다시 정해 주세요` });
      p.finishOk('프로듀서에게 지시했습니다');
      await ended(e, p);
      // 프로듀서가 지시를 처리하는 동안(그 턴이 도는 동안): 다시 전달하지 않고 세지도 않고 대표에게 알리지도 않는다
      const { p: prod } = await nextTurn(e, dKey, e.producerId, `프로듀서 턴 ${i + 1}`);
      const before = launchesOf(e, pKey).length;
      await ticks(e, 15);
      expect(launchesOf(e, pKey)).toHaveLength(before);
      expect(handOffs(e, t).map((q) => [q.state, q.deliveries])).toEqual([['queued', i + 1]]);
      expect(notices(e, `handoff-stuck:${t.id}`)).toEqual([]);
      // 프로듀서가 검수자를 정하지 않고 턴을 마친다 — 진행은 끝났고 대상은 그대로
      prod.finishOk('확인했습니다');
      await ended(e, prod);
    }
    // 세 번 모두 대상이 그대로였고 이제 기다리는 진행도 없다 → 네 번째로 전달하지 않고 대표에게 알린다
    await ticks(e, 10);
    expect(launchesOf(e, pKey)).toHaveLength(3);
    expect(handOffs(e, t)).toEqual([]);
    expect(notices(e, `handoff-stuck:${t.id}`).map((n) => n.body)).toEqual([expect.stringContaining('메인 에이전트에게 3번 넘겼지만 검수가 다시 시작되지 않았습니다')]);
  });

  it('메인이 대표에게 물은(ask_owner) 동안은 재개 업무를 다시 전달하지 않는다 — 대표가 답하면 답과 함께 두 번째로 전달하고, 메인이 재개하면 끝 (프로브 ask-owner-escalates)', async () => {
    const e = (env = await bootOrch());
    const pKey = mainKey(e.projectId);
    e.hold.add(pKey);
    const t = await producerPausedByProgram(e);
    const producer = e.ctx.store.members.require(e.producerId);
    const { p } = await nextTurn(e, pKey, MAIN_AGENT_ID, '재개 업무를 실은 메인 턴');
    expect((await e.tool(p.turnId, 'ask_owner', { question: `${producer.name} 실행에서 남은 프로세스가 작업 관리자에 남아 있는지 확인해 주실 수 있나요?` })).ok).toBe(true);
    p.finishOk('대표에게 확인을 부탁했습니다');
    await ended(e, p);
    await ticks(e, 20);
    expect(launchesOf(e, pKey)).toHaveLength(1);
    expect(pauseItems(e, e.producerId).map((q) => [q.state, q.deliveries])).toEqual([['queued', 1]]);
    expect(notices(e, `pause-stuck:${e.producerId}`)).toEqual([]);
    // 대표가 답한다 → 기다리던 진행이 끝났다
    const question = e.ctx.store.questions.list({ state: 'open' }).find((q) => q.fromId === MAIN_AGENT_ID)!;
    await e.invoke('questions.answer', question.id, '작업 관리자에서 남은 node.exe를 끝냈습니다');
    const { p: p2, carried } = await nextTurn(e, pKey, MAIN_AGENT_ID, '답과 재개 업무를 실은 메인 턴');
    expect(carried.map((q) => [q.kind, q.deliveries ?? 0]).sort()).toEqual([
      ['main_command', 0],
      ['message', 1],
    ]);
    // 머리말은 전달할 때 그 팀원 앞에 기다리는 업무를 적는다 (리드 결정 37)
    expect(e.launches.find((x) => x.turnId === p2.turnId)!.message).toContain(
      `> (2번째 알림 — ${producer.name}(${producer.id})은(는) 아직 일시정지돼 있습니다) 지금 ${producer.name}(${producer.id}) 앞에 기다리는 업무: 검수자 배정 ${t.id} — 재개하기 전까지 처리되지 않습니다. 팀원에게 보낸 지시나 대표에게 한 질문 가운데 처리를 기다리는 것은 지금 없습니다.`,
    );
    await e.tool(p2.turnId, 'resume_member', { member_id: e.producerId, reason: '대표가 남은 프로세스를 정리했다고 확인' });
    p2.finishOk('재개했습니다');
    await ended(e, p2);
    expect(pauseItems(e, e.producerId)).toEqual([]);
    expect(notices(e, `pause-stuck:${e.producerId}`)).toEqual([]);
    expect(e.ctx.store.activity.search({ text: '남는 업무 끝', limit: 10 }).map((a) => a.text)).toEqual([`남는 업무 끝 — ${producer.name}(${producer.id})이(가) 이미 재개됨 (${pKey}, 다시 넣지 않음)`]);
  });

  it('메인이 그 팀원을 직접 다시 일시정지하면 재개 업무는 끝난다 — 전달하지 않고 기록 한 줄, 대표 알림 없음 (프로브 pause-lifecycle (3))', async () => {
    const e = (env = await bootOrch());
    const pKey = mainKey(e.projectId);
    e.hold.add(pKey);
    await producerPausedByProgram(e);
    const producer = e.ctx.store.members.require(e.producerId);
    // 첫 전달은 재개하지 않고 끝난다 → 다시 들어와 기다린다(전달 1)
    const { p } = await nextTurn(e, pKey, MAIN_AGENT_ID, '재개 업무 첫 전달');
    p.finishOk('확인했습니다');
    await ended(e, p);
    expect(pauseItems(e, e.producerId).map((q) => [q.state, q.deliveries])).toEqual([['queued', 1]]);
    // 메인 에이전트가 자기 까닭으로 같은 팀원을 다시 일시정지한다 — 이제 프로그램이 건 정지가 아니다
    await e.main('pause_member', { member_id: e.producerId, mode: 'graceful', reason: '계획을 다시 검토할 때까지 멈춤' });
    expect(e.ctx.stop().members[e.producerId]).toMatchObject({ paused: true, by: MAIN_AGENT_ID });
    await ticks(e, 20);
    expect(launchesOf(e, pKey)).toHaveLength(1);
    expect(pauseItems(e, e.producerId)).toEqual([]);
    expect(e.ctx.store.activity.search({ text: '끝난 일의 메시지 확인 업무 정리', limit: 10 }).map((a) => a.text)).toEqual([
      `끝난 일의 메시지 확인 업무 정리 — ${producer.name}(${producer.id})을(를) 메인 에이전트가 직접 일시정지함 — 프로그램이 건 정지가 아님 (${pKey}, 다시 전달하지 않음)`,
    ]);
    expect(notices(e, `pause-stuck:${e.producerId}`)).toEqual([]);
  });

  it('지금 전달될 수 없는 지시(검수 중 작업의 세션으로 간 지시)는 기다리지 않는다 — 넘김은 곧바로 다시 전달된다 (끝없이 미루지 않음)', async () => {
    const e = (env = await bootOrch());
    const t = await handedToMain(e, { producerWorks: true });
    const pKey = mainKey(e.projectId);
    const p = e.liveProc(pKey, MAIN_AGENT_ID)!;
    const res = await e.tool(p.turnId, 'instruct_member', { member_id: e.producerId, text: `${t.id} 검수자를 다시 정해 주세요` });
    expect(res).toMatchObject({ ok: true, data: { delivered: `task:${t.id}` } });
    p.finishOk('프로듀서에게 지시했습니다');
    await ended(e, p);
    expect(e.core.turns.mainProgressPending(e.projectId)).toBe(false);
    const { p: p2, carried } = await nextTurn(e, pKey, MAIN_AGENT_ID, '넘김 두 번째 전달');
    expect(carried.filter((q) => q.taskId === t.id).map((q) => q.deliveries)).toEqual([1]);
    // 그 지시는 아직 전달 전이므로 '처리됐다'거나 '기다리는 것이 없다'고 쓰지 않는다 — 지금 확인한 사실(전달되지 않은 지시)을 쓴다
    const launched = e.launches.find((x) => x.turnId === p2.turnId)!.message;
    const producer = e.ctx.store.members.require(e.producerId);
    expect(launched).toContain(
      // 받을 수 없는 까닭은 스케줄러와 같은 판정으로 그때 확인한 것이다 (리드 결정 38)
      `> (2번째 알림 — ${t.id} 검수가 아직 다시 시작되지 않았습니다) 지금 이 작업에는 대기·실행 중인 검수도, 검수자 재배정 업무도 없습니다. 앞서 ${producer.name}에게 보낸 지시가 아직 전달되지 않았습니다 — 받는 쪽이 지금 그 업무를 받을 수 없어(${producer.name}: ${t.id}이(가) 검수 상태라 그 작업 세션이 뜨지 않음) 그 까닭이 풀리기 전에는 처리되지 않습니다. 아래 안내대로 처리하세요.`,
    );
    expect(launched).not.toContain('처리됐지만');
  });

  it('비정상 종료로 다시 넣어도 머리말이 쌓이지 않는다 — 전달할 때 하나만 붙이고, 저장된 글은 원래 안내로 돌아온다', async () => {
    const e = (env = await bootOrch());
    const t = await handedToMain(e);
    const pKey = mainKey(e.projectId);
    const original = handOffs(e, t)[0]!.message;
    const { p: p1 } = await nextTurn(e, pKey, MAIN_AGENT_ID, '넘김 첫 전달');
    p1.finishOk('확인했습니다');
    await ended(e, p1);
    const { p: p2 } = await nextTurn(e, pKey, MAIN_AGENT_ID, '넘김 두 번째 전달');
    p2.exit(1); // 한 번 비정상 종료 → 같은 전달을 다시 넣는다(전달 횟수는 그대로)
    await ended(e, p2);
    expect(handOffs(e, t).map((q) => [q.deliveries, q.attempts, q.message.startsWith('이전 턴이 비정상 종료로 끝났습니다. 이어서 처리하세요.\n\n(다시 전달) ')])).toEqual([[1, 1, true]]);
    const { p: p3 } = await nextTurn(e, pKey, MAIN_AGENT_ID, '다시 넣은 두 번째 전달');
    const launched = e.launches.find((x) => x.turnId === p3.turnId)!.message;
    expect(launched.match(/번째 알림 —/g)).toHaveLength(1);
    expect(launched).toContain(`> (2번째 알림 — ${t.id} 검수가 아직 다시 시작되지 않았습니다)`);
    expect(launched).not.toContain('(다시 전달)');
    p3.finishOk('확인했습니다');
    await ended(e, p3);
    expect(handOffs(e, t).map((q) => [q.deliveries, q.attempts, q.message])).toEqual([[2, 0, original]]);
  });

  it('기다리던 넘김은 그 작업에 검수자 재배정 업무가 생겨도 전달하지 않고 지운다 — 처리할 수 있는 쪽(프로듀서)의 업무가 있다', async () => {
    const e = (env = await bootOrch());
    const t = await handedToMain(e);
    const pKey = mainKey(e.projectId);
    const { p } = await nextTurn(e, pKey, MAIN_AGENT_ID, '넘김 첫 전달');
    p.finishOk('확인했습니다');
    await ended(e, p);
    expect(handOffs(e, t).map((q) => [q.state, q.deliveries])).toEqual([['queued', 1]]);
    // 메인 턴이 뜨기 전에 프로그램이 프로듀서에게 그 작업의 검수자 재배정을 넣는다(띄운 채 둔다)
    enqueue(e.ctx, { kind: 'reviewer_assign', memberId: e.producerId, sessionKey: directiveKey(t.directiveId), projectId: e.projectId, directiveId: t.directiveId, taskId: t.id, priority: 'high', message: `${t.id} 검수자를 다시 정하세요` });
    await ticks(e, 10);
    expect(launchesOf(e, pKey)).toHaveLength(1);
    expect(handOffs(e, t)).toEqual([]);
    expect(e.ctx.store.activity.search({ text: '끝난 일의 메시지 확인 업무 정리', limit: 10 }).map((a) => a.text)).toEqual([
      `끝난 일의 메시지 확인 업무 정리 — ${t.id}의 검수자 재배정 업무가 프로듀서에게 있음 (${pKey}, 다시 전달하지 않음)`,
    ]);
  });

  it('넘길 때도 같은 판정이다: 그 작업에 검수자 재배정 업무가 이미 있으면 메인에게 넘기지 않고 기록만 남긴다', async () => {
    const e = (env = await bootOrch());
    await e.internal('members.remove', e.qaId);
    const d = seedDirective(e);
    const t = seedInReviewTask(e, MAIN_AGENT_ID, { outputMode: 'repo', directiveId: d.id });
    // 같은 검수자 "main"으로 이미 한 번 다시 등록한 검수 — 이번에도 판정 없이 끝나면 프로듀서가 아니라 메인에게 넘기는 길이다 (리드 결정 17)
    e.ctx.store.kv.set(`reviewredispatch:${t.id}`, { reviewerId: MAIN_AGENT_ID, count: 1 });
    e.hold.add(directiveKey(d.id));
    enqueue(e.ctx, { kind: 'reviewer_assign', memberId: e.producerId, sessionKey: directiveKey(d.id), projectId: e.projectId, directiveId: d.id, taskId: t.id, priority: 'high', message: `${t.id} 검수자를 다시 정하세요` });
    e.script.set(reviewKey(t.id), (p) => p.exit(1));
    e.core.tasks.dispatchReview(e.ctx.store.tasks.require(t.id));
    await waitFor(
      () => {
        e.tick();
        return e.ctx.store.activity.search({ text: '멈춘 검수를 메인 에이전트에게 넘기지 않음', limit: 5 }).length > 0;
      },
      '메인 검수 턴 비정상 종료 상한',
      40_000,
    );
    expect(e.ctx.store.activity.search({ text: '멈춘 검수를 메인 에이전트에게 넘기지 않음', limit: 5 }).map((a) => a.text)).toEqual([
      `${t.id} 멈춘 검수를 메인 에이전트에게 넘기지 않음 — ${t.id}의 검수자 재배정 업무가 프로듀서에게 있음`,
    ]);
    expect(handOffs(e, e.ctx.store.tasks.require(t.id))).toEqual([]);
    expect(live(e).filter((q) => q.kind === 'reviewer_assign' && q.taskId === t.id)).toHaveLength(1);
  });

  it('재개 업무는 그 정지에만 묶인다: 재개된 뒤 프로그램이 다시 일시정지하면 앞 업무는 지우고(기록) 새 정지의 업무를 넣는다', async () => {
    const e = (env = await bootOrch());
    e.hold.add(mainKey(e.projectId));
    const name = e.ctx.store.members.require(e.producerId).name;
    await e.core.stops.pauseMember(e.producerId, 'graceful', 'system', '프로세스 종료를 확인하지 못함 (첫 실행)');
    e.core.turns.handPauseToMain(e.producerId, null);
    const [first] = pauseItems(e, e.producerId);
    // 재개된 뒤(그 업무는 아직 대기 중) 다른 실행의 종료를 확인하지 못해 다시 일시정지
    e.core.stops.resumeMember(e.producerId, MAIN_AGENT_ID);
    await sleep(5);
    await e.core.stops.pauseMember(e.producerId, 'graceful', 'system', '프로세스 종료를 확인하지 못함 (둘째 실행)');
    e.core.turns.handPauseToMain(e.producerId, null);
    const items = pauseItems(e, e.producerId);
    expect(items).toHaveLength(1);
    expect(items[0]!.id).not.toBe(first!.id);
    expect(items[0]!.message).toContain('둘째 실행');
    expect(e.ctx.store.queue.get(first!.id)!.state).toBe('cancelled');
    expect(e.ctx.store.activity.search({ text: '끝난 일의 메시지 확인 업무 정리', limit: 10 }).map((a) => a.text)).toEqual([
      `끝난 일의 메시지 확인 업무 정리 — ${name}(${e.producerId})이(가) 그 뒤 다른 까닭으로 다시 일시정지됨 (${mainKey(e.projectId)}, 다시 전달하지 않음)`,
    ]);
    // 메인 에이전트가 직접 건 정지에는 재개 업무를 넣지 않는다 (넣을 때도 같은 판정)
    await e.main('pause_member', { member_id: e.devId, mode: 'graceful', reason: '잠깐 멈춤' });
    e.core.turns.handPauseToMain(e.devId, null);
    expect(pauseItems(e, e.devId)).toEqual([]);
  });
});
