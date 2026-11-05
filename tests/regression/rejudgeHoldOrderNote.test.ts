/**
 * 같은 검수자에게 '다시 판정 실패' 보류가 여럿일 때 보류 사유가 사실대로 (S9-B3 — CTL-11, CTL-06).
 * 대표가 그 검수자에게 보내는 긴급 지시는 먼저 보류된 작업으로 간다(rejudgeHeldTaskFor — 그대로). 그런데 나중에 보류된 작업의 보류 사유도 "(이 보류 중에
 * {검수자}에게 보내는 긴급 지시는 이 작업의 다시 판정으로 감)"이라고 해서, 그대로 메시지를 보내고 그 작업을 재개하면 메시지 없이 이전 통과로 병합 판단이 들어갔다.
 * 이제 보류 사유가 지금 메시지를 받는 작업(먼저 보류된 작업)과, 이 작업은 그 작업을 재개(또는 취소)한 뒤에 받는다는 것을 말한다.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { UrgentInstructionResult } from '../../src/main/orchestrator/urgent';
import { MAIN_AGENT_ID } from '@shared/domain';
import { reviewKey } from '../../src/main/orchestrator/records';
import { REJUDGE_HOLD_REF } from '../../src/main/orchestrator/tasks';
import { sleep, startReview, waitFor } from './orchHarness';
import { bootSessions, launchesOfKey, liveCount, toolOk, type SessEnv } from '../acceptance/sessions-helpers';

let env: SessEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const PASS = { verdict: 'pass', criteria: [{ criterion: '문서가 있다', pass: true, note: '확인' }], reason: '' };
const mergeDecisions = (e: SessEnv, taskId: string) => e.ctx.store.queue.list({ state: ['queued', 'running'] }).filter((q) => q.kind === 'merge_decision' && q.taskId === taskId);
const send = (e: SessEnv, text: string) => e.main('instruct_member', { member_id: e.qaId, text: text, urgent: true }) as unknown as Promise<UrgentInstructionResult>;
const holdNote = (e: SessEnv, taskId: string) => e.ctx.store.tasks.require(taskId).hold.reasons.find((r) => r.refId === REJUDGE_HOLD_REF)!.note;

/** QA가 통과 → 대표가 QA에게 메시지 → 그 턴 종료(병합 판단을 미룸). 다음 작업의 검수 동안 끼어들지 않게 잠깐 대표 중단으로 멈춰 둔다 */
async function deferredPass(e: SessEnv, text: string) {
  const { task, proc } = await startReview(e, e.qaId, { outputMode: 'repo' });
  const rk = reviewKey(task.id);
  expect((await toolOk(e, proc.turnId, 'submit_review', { task_id: task.id, ...PASS })).verdict).toBe('pass');
  expect((await send(e, text)).sessionKey).toBe(rk);
  proc.finishOk();
  await waitFor(() => !e.core.turns.hasLiveSession(rk), '검수 턴 종료');
  e.core.tasks.hold(task.id, 'interrupted', 'task', '회귀: 잠깐 멈춤', MAIN_AGENT_ID);
  return { id: task.id, rk };
}

describe('같은 검수자의 다시 판정 실패 보류가 여럿이면 보류 사유가 메시지가 가는 곳을 그대로 말한다 (S9-B3, CTL-11)', () => {
  it('나중 보류는 지금 받는 작업과 그 작업을 재개한 뒤에 받는다는 것을 말하고, 그대로 하면 그 작업이 메시지를 보고 다시 판정한다', async () => {
    const e = (env = await bootSessions());
    const who = e.ctx.store.members.require(e.qaId).name;
    const a = await deferredPass(e, '첫 작업 확인');
    const b = await deferredPass(e, '둘째 작업 확인');
    const c = await deferredPass(e, '셋째 작업 확인');
    for (const t of [a, b, c]) e.core.tasks.resumeByOwner(t.id, MAIN_AGENT_ID);
    for (const t of [a, b, c]) {
      e.core.tasks.holdRejudgeStuck(t.id, '비정상 종료', 3);
      await sleep(15);
    }
    for (const t of [a, b, c]) expect(e.ctx.store.tasks.require(t.id).hold.reasons).toMatchObject([{ kind: 'error', refId: REJUDGE_HOLD_REF }]);
    // 먼저 보류된 작업: 그대로 이 작업으로
    expect(holdNote(e, a.id)).toContain(`(이 보류 중에 ${who}에게 보내는 긴급 지시는 이 작업의 다시 판정으로 감)`);
    // 둘째: 지금 받는 작업(a)과, a를 재개(또는 취소)한 뒤에 이 작업으로
    expect(holdNote(e, b.id)).toContain(`(${who}에게 보내는 긴급 지시는 먼저 보류된 ${a.id}을(를) 재개하거나 취소할 때까지 ${a.id}의 다시 판정으로 가고, 그 뒤에 이 작업의 다시 판정으로 감)`);
    expect(holdNote(e, b.id)).not.toContain('이 보류 중에');
    // 셋째: 앞의 둘 모두, 지금 받는 것은 a
    expect(holdNote(e, c.id)).toContain(`(${who}에게 보내는 긴급 지시는 먼저 보류된 ${a.id}·${b.id}을(를) 모두 재개하거나 취소할 때까지 그중 먼저 보류된 작업(지금은 ${a.id})의 다시 판정으로 가고, 그 뒤에 이 작업의 다시 판정으로 감)`);

    // 보류 사유대로: 지금은 a가 받는다
    expect((await send(e, 'a를 결제 화면까지 보고 다시 판정해 주세요')).sessionKey).toBe(a.rk);
    // a를 재개한 뒤에 b의 다시 판정으로 간다 (c가 아니라) — 보낸 뒤 b를 재개하면 그 메시지로 다시 판정한 뒤에야 병합 판단
    e.core.tasks.resumeByOwner(a.id, MAIN_AGENT_ID);
    // a의 다시 판정 턴이 b보다 먼저 검수자를 쓰지 않게 다시 잠깐 멈춘다 (대표 중단 — 다시 판정 실패 보류가 아니다)
    e.core.tasks.hold(a.id, 'interrupted', 'task', '회귀: 잠깐 멈춤', MAIN_AGENT_ID);
    const r = await send(e, 'b를 결제 화면까지 보고 다시 판정해 주세요');
    expect(r.sessionKey).toBe(b.rk);
    e.core.tasks.resumeByOwner(b.id, MAIN_AGENT_ID);
    await sleep(100);
    expect(mergeDecisions(e, b.id)).toEqual([]);
    e.hold.add(b.rk);
    e.tick();
    await waitFor(() => liveCount(e, b.rk) === 1, 'b의 다시 판정 턴', 15_000);
    expect(launchesOfKey(e, b.rk).at(-1)!.message).toContain('b를 결제 화면까지 보고 다시 판정해 주세요');
    expect(mergeDecisions(e, b.id)).toEqual([]);
    e.liveProc(b.rk)!.finishOk('메시지를 보고 판정은 그대로입니다');
    await waitFor(() => mergeDecisions(e, b.id).length === 1, 'b의 다시 판정 턴 뒤 병합 판단');
    // a·b가 풀렸으니 이제 c가 받는다 (c의 보류 사유대로)
    expect((await send(e, 'c도 다시 봐 주세요')).sessionKey).toBe(c.rk);
  }, 120_000);
});
