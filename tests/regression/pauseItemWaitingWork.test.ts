/**
 * 팀원 재개 업무의 '기다리는 업무'는 전달할 때 계산한다 (리드 결정 37, 10-30 — flows 4차 재리뷰 medium, 프로브 zz-s1fx4fg-pause-item-stale-body):
 * - 예전에는 handPauseToMain이 넣는 때(턴 판정 전) '- 멈춘 업무: …'를 글에 저장했고, 글은 그 업무가 멈춰 있다고 말했다. 프로듀서 턴이 정상으로 끝났으면 그
 *   업무는 이미 처리됐는데도 첫 전달부터 멈춰 있다고 했고, 다시 전달할 때마다 같은 낡은 목록을 되풀이했다 — 그 사이 그 팀원에게 온 검수자 재배정은 빠졌다
 * - 이제 저장된 글에는 업무 목록이 없다. 전달할 때마다(첫 전달 포함) 머리말이 그 팀원 앞에 지금 기다리는 업무를 종류와 지시·작업 ID로 적고, 없으면 없다고
 *   쓴다. 멈춘 턴이 실었던 업무는 아직 대기 중일 때만 나온다. 머리말은 쌓이지 않는다 (리드 결정 31)
 * - 업그레이드 전에 저장된 재개 업무의 낡은 목록도 전달할 때 떼어 낸다
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID, type Task } from '@shared/domain';
import { directiveKey, enqueue, mainKey } from '../../src/main/orchestrator/records';
import { bootOrch, seedDirective, seedInReviewTask, sleep, waitFor, type FakeProc, type OrchEnv } from './orchHarness';

let env: OrchEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const pauseItems = (e: OrchEnv, memberId: string) => e.ctx.store.queue.list({ state: ['queued', 'running'] }).filter((q) => q.memberId === MAIN_AGENT_ID && q.pausedMemberId === memberId);

async function nextTurn(e: OrchEnv, key: string, seen: Set<string>): Promise<FakeProc> {
  await waitFor(
    () => {
      e.tick();
      return e.procs.some((p) => p.workKey === key && !seen.has(p.turnId) && !p.done);
    },
    `턴 ${key}`,
    20_000,
  );
  const p = e.procs.find((x) => x.workKey === key && !seen.has(x.turnId) && !x.done)!;
  seen.add(p.turnId);
  return p;
}
const launchedOf = (e: OrchEnv, p: FakeProc) => e.launches.find((l) => l.turnId === p.turnId)!.message;

/**
 * 메인 에이전트가 프로듀서에게 지시하고, 그 지시를 실은 프로듀서 턴이 하위 프로세스 1개를 남긴 채 끝나 프로그램이 프로듀서를 일시정지한다.
 * end: 그 프로듀서 턴이 어떻게 끝나는지 — 정상(지시는 처리됨) 또는 비정상 종료(지시는 다시 대기)
 */
async function producerPausedAfterInstruction(e: OrchEnv, end: 'ok' | 'crash'): Promise<{ t: Task; d: string }> {
  await e.internal('members.remove', e.qaId);
  const d = seedDirective(e);
  const t = seedInReviewTask(e, MAIN_AGENT_ID, { outputMode: 'repo', directiveId: d.id });
  e.hold.add(mainKey(e.projectId));
  e.script.set(directiveKey(d.id), (p) => {
    if (end === 'ok') {
      p.emit({ kind: 'result', text: '지시 확인했습니다', data: {} });
      p.exit(0, { remaining: 1 });
    } else p.exit(1, { remaining: 1 });
  });
  await e.main('instruct_member', { member_id: e.producerId, text: '이번 주 계획을 정리해 주세요' });
  // 프로듀서 턴이 끝나고 판정(다시 넣기)까지 마칠 때까지는 메인 턴을 띄우지 않는다 — 전달할 때의 머리말이 판정 뒤의 대기열을 보게
  await waitFor(
    () => {
      const prod = e.procs.filter((p) => p.workKey === directiveKey(d.id));
      if (!prod.length) e.tick();
      return prod.length > 0 && prod.every((p) => p.done);
    },
    '프로듀서 턴',
    30_000,
  );
  await sleep(150);
  expect(e.ctx.stop().members[e.producerId]).toMatchObject({ paused: true, by: 'system' });
  expect(pauseItems(e, e.producerId)).toHaveLength(1);
  e.script.delete(directiveKey(d.id));
  return { t, d: d.id };
}

describe("팀원 재개 업무의 '기다리는 업무'는 전달할 때 계산한다 (리드 결정 37)", () => {
  it('정상으로 끝난 턴의 처리된 지시는 첫 전달부터 멈춘 업무로 적지 않고, 그 뒤 온 검수자 재배정은 다시 전달할 때 적는다 (프로브 pause-item-stale-body)', async () => {
    const e = (env = await bootOrch());
    const { t, d } = await producerPausedAfterInstruction(e, 'ok');
    const producer = e.ctx.store.members.require(e.producerId);
    const mkey = mainKey(e.projectId);
    // 준비 확인: 그 프로듀서 턴이 실은 지시는 처리됐다
    expect(e.ctx.store.queue.list().filter((q) => q.memberId === e.producerId && q.kind === 'message').map((q) => q.state)).toEqual(['done']);
    // 저장된 글에는 업무 목록이 없다
    const [item] = pauseItems(e, e.producerId);
    expect(item!.message).not.toContain('멈춘 업무');
    expect(item!.message).not.toContain('멈춰 있습니다');
    const seen = new Set<string>();
    const m1 = await nextTurn(e, mkey, seen);
    const msg1 = launchedOf(e, m1);
    expect(msg1).toContain(`> (지금 ${producer.name}(${producer.id}) 앞에 기다리는 업무는 없습니다 — 새로 오는 업무도 재개할 때까지 기다립니다)`);
    // 그 지시는 정지의 까닭(그 턴)으로만 나온다 — 멈춘·기다리는 업무로 적지 않는다
    expect(msg1).toContain(`— ${producer.name} 메시지 확인 ${d}의 프로세스 종료를 확인하지 못했습니다.`);
    expect(msg1.match(new RegExp(`메시지 확인 ${d}`, 'g'))).toHaveLength(1);
    expect(msg1).not.toContain('멈춘 업무');
    expect(msg1).not.toContain('번째 알림');
    // 메인 턴이 도는 사이 검수가 멈춰 그 프로듀서에게 검수자 재배정이 간다
    (e.core.turns as unknown as { escalateReview(task: Task, why: string): void }).escalateReview(e.ctx.store.tasks.require(t.id), '검수 결과가 반복해서 등록되지 않았습니다');
    m1.finishOk('확인했습니다'); // 재개하지 않는다
    await sleep(80);
    const m2 = await nextTurn(e, mkey, seen);
    const msg2 = launchedOf(e, m2);
    expect(msg2).toContain(
      `> (2번째 알림 — ${producer.name}(${producer.id})은(는) 아직 일시정지돼 있습니다) 지금 ${producer.name}(${producer.id}) 앞에 기다리는 업무: 검수자 배정 ${t.id} — 재개하기 전까지 처리되지 않습니다.`,
    );
    expect(msg2.match(new RegExp(`메시지 확인 ${d}`, 'g'))).toHaveLength(1);
    expect(msg2).not.toContain('멈춘 업무');
    expect(msg2.match(/번째 알림 —/g)).toHaveLength(1);
    expect(msg2.match(/앞에 기다리는 업무/g)).toHaveLength(1);
    // 다시 넣은 항목도 목록 없이 원래 안내만 저장한다
    expect(pauseItems(e, e.producerId).map((q) => q.message)).toEqual([item!.message]);
    m2.finishOk('확인');
  });

  it('멈춘 턴이 실었던 업무는 아직 대기 중일 때만 적는다 — 비정상 종료로 다시 들어간 지시는 첫 전달에 나온다', async () => {
    const e = (env = await bootOrch());
    const { d } = await producerPausedAfterInstruction(e, 'crash');
    const producer = e.ctx.store.members.require(e.producerId);
    expect(e.ctx.store.queue.list({ state: 'queued' }).filter((q) => q.memberId === e.producerId && q.kind === 'message').map((q) => q.attempts)).toEqual([1]);
    const m1 = await nextTurn(e, mainKey(e.projectId), new Set());
    expect(launchedOf(e, m1)).toContain(`> (지금 ${producer.name}(${producer.id}) 앞에 기다리는 업무: 메시지 확인 ${d} — 재개하기 전까지 처리되지 않습니다)`);
    m1.finishOk('확인');
  });

  // 시험 빈틈 (리드 결정 45, tests-integrity 5차 재리뷰 변이 N5-paused-shared): 공유 사본은 그 자체로 턴을 띄우지 않는 정보라 기다리는 업무가 아니다
  it('그 팀원 앞의 공유 사본(다른 팀원에게 간 긴급 지시의 [공유])은 기다리는 업무로 적지 않는다', async () => {
    const e = (env = await bootOrch());
    const { d } = await producerPausedAfterInstruction(e, 'ok');
    const producer = e.ctx.store.members.require(e.producerId);
    // 메인 에이전트가 작업자(검수 중 작업을 맡은 팀원)에게 긴급 지시를 보낸다 — 프로듀서 앞에 공유 사본이 생긴다
    await e.main('instruct_member', { member_id: e.devId, text: '로그인 문구를 존댓말로 바꿔 주세요', urgent: true });
    expect(e.ctx.store.queue.list({ ref1: producer.id, state: 'queued' }).map((q) => [q.kind, q.sessionKey, !!q.ownerShared])).toEqual([['message', directiveKey(d), true]]);
    const m1 = await nextTurn(e, mainKey(e.projectId), new Set());
    const msg1 = launchedOf(e, m1);
    expect(msg1).toContain(`> (지금 ${producer.name}(${producer.id}) 앞에 기다리는 업무는 없습니다 — 새로 오는 업무도 재개할 때까지 기다립니다)`);
    // 그 지시는 정지의 까닭(멈춘 턴)으로만 한 번 나온다 — 공유 사본을 '메시지 확인'으로 적지 않는다
    expect(msg1.match(new RegExp(`메시지 확인 ${d}`, 'g'))).toHaveLength(1);
    m1.finishOk('확인');
  });

  it('업그레이드 전에 저장된 재개 업무의 낡은 목록은 전달할 때 떼어 내고, 다시 넣을 때도 저장하지 않는다', async () => {
    const e = (env = await bootOrch());
    const mkey = mainKey(e.projectId);
    e.hold.add(mkey);
    await e.core.stops.pauseMember(e.producerId, 'graceful', 'system', '프로세스 종료를 확인하지 못함 (서진 계획 D-0001)');
    const producer = e.ctx.store.members.require(e.producerId);
    const head = `프로그램이 ${producer.name}(${producer.id}, 프로듀서)을(를) 일시정지했습니다 — 프로세스 종료를 확인하지 못함 (서진 계획 D-0001).\n- 프로세스: 알 수 없음 (정지 기록만 남음)`;
    const ask = `남은 프로세스가 모두 사라졌는지 확인한 뒤 resume_member(member_id="${producer.id}", reason="…")로 재개하세요. 직접 확인할 길이 없으면 ask_owner로 대표에게 작업 관리자에서 확인해 달라고 부탁하세요.`;
    // 예전 코드가 넣은 모양 그대로: 넣는 때의 '멈춘 업무' 목록과 '…는 멈춰 있습니다' 끝 문장
    enqueue(e.ctx, {
      kind: 'message',
      memberId: MAIN_AGENT_ID,
      sessionKey: mkey,
      projectId: e.projectId,
      pausedMemberId: producer.id,
      priority: 'high',
      message: `${head}\n- 멈춘 업무: 계획 D-0001\n${ask} 재개하기 전까지 ${producer.name}의 업무(검수자 재배정 포함)는 멈춰 있습니다.`,
    });
    const m1 = await nextTurn(e, mkey, new Set());
    const msg1 = launchedOf(e, m1);
    expect(msg1).not.toContain('멈춘 업무');
    expect(msg1).not.toContain('멈춰 있습니다');
    expect(msg1).toContain(`> (지금 ${producer.name}(${producer.id}) 앞에 기다리는 업무는 없습니다 — 새로 오는 업무도 재개할 때까지 기다립니다)`);
    m1.finishOk('확인했습니다');
    await waitFor(() => e.core.turns.count() === 0, '메인 턴 마무리');
    await sleep(30);
    expect(pauseItems(e, producer.id).map((q) => [q.deliveries, q.message])).toEqual([[1, `${head}\n${ask}`]]);
  });
});
