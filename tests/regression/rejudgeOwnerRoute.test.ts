/**
 * '다시 판정 실패' 보류의 안내가 사실이 되게 (S8-B1 — CTL-06, CTL-10, CTL-11), 병합 후보와 request_merge가 같은 미룸 조건을 보게 (S8-B3 — GIT-04),
 * 통과한 작업의 검수 턴이 프로세스 전에 실패하면 시작 실패로 세게 (S8-B4 — ERR-04, CONC-01).
 * - B1: 예전에는 보류 알림이 "판정을 다시 받으려면 검수자에게 메시지를 보낸 뒤 재개하세요"라고 했지만, 대표 메시지는 검수자의 지금 턴·맡은 작업으로만 갔다.
 *   작업이 보류 중이라 그 검수 세션(review:T)으로 갈 길이 없어 메시지는 거부되거나 검수자의 다른 작업으로 갔고, 재개하면 이전 통과로 병합 판단이 바로 들어갔다.
 *   이제 다시 판정 실패로 보류된 작업의 검수자에게 보내는 긴급 지시는 그 작업의 검수 세션으로 가고(지금 턴·맡은 작업보다 먼저, 여럿이면 먼저 보류된 작업),
 *   안내가 어디로 갔는지 알린다. 재개하면 그 메시지로 다시 판정한 뒤에야 병합 판단을 넣는다. 지시 없이 재개하면 등록한 통과로 이어 간다.
 * - B3: 다시 판정 턴이 도는 동안(메시지는 그 턴에 실려 대기열에 없음) 프로듀서의 병합 후보·병합 판단 재촉은 그 작업을 내놓았고 request_merge는 거부했다.
 * - B4: 그 다시 판정 턴이 프로세스를 띄우기 전에 실패하면(검수 사본·첨부·모델·비밀 값 문제) 턴 마무리가 업무를 다시 넣어 시작 실패로 세지 못한 채 틱마다
 *   다시 띄웠다. 이제 시작 실패 상한(3회)에서 보류(오류)하고 '업무 시작 실패'를 알린다.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { UrgentInstructionResult } from '../../src/main/orchestrator/urgent';
import { MAIN_AGENT_ID } from '@shared/domain';
import { directiveKey, enqueue, reviewKey, taskKey } from '../../src/main/orchestrator/records';
import { REJUDGE_HOLD_REF } from '../../src/main/orchestrator/tasks';
import { notices, sleep, startReview, waitFor, type FakeProc } from './orchHarness';
import { bootSessions, launchesOfKey, liveCount, makeTask, toolOk, type SessEnv } from '../acceptance/sessions-helpers';
import { callTool, identityOf, member } from '../acceptance/review-helpers';

let env: SessEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const PASS = { verdict: 'pass', criteria: [{ criterion: '문서가 있다', pass: true, note: '확인' }], reason: '' };
const TEXT = '통과시키지 말고 결제 화면까지 확인한 뒤 다시 판정해 주세요';
const AGAIN = '결제 화면의 취소 버튼도 보고 다시 판정해 주세요';

const mergeDecisions = (e: SessEnv, taskId: string) => e.ctx.store.queue.list({ state: ['queued', 'running'] }).filter((q) => q.kind === 'merge_decision' && q.taskId === taskId);
const queuedOn = (e: SessEnv, key: string) => e.ctx.store.queue.list({ ref2: key, state: 'queued' });

/** QA가 통과 → 대표가 QA에게 메시지 → 그 턴 종료: 병합 판단을 미루고 [대표 메시지, 다시 판정] */
async function passThenOwnerMessage(e: SessEnv) {
  const { task, proc } = await startReview(e, e.qaId, { outputMode: 'repo' });
  const rk = reviewKey(task.id);
  expect((await toolOk(e, proc.turnId, 'submit_review', { task_id: task.id, ...PASS })).verdict).toBe('pass');
  await e.main('instruct_member', { member_id: e.qaId, text: TEXT, urgent: true });
  proc.finishOk();
  await waitFor(() => !e.core.turns.hasLiveSession(rk), '첫 검수 턴 종료');
  return { task, rk };
}

async function nextReviewTurn(e: SessEnv, rk: string, label: string): Promise<FakeProc> {
  e.tick();
  await waitFor(() => liveCount(e, rk) === 1, label, 15_000);
  return e.liveProc(rk)!;
}

/** 다시 판정 턴을 상한(crashRetryMax)을 넘겨 이어서 끊는다 → 다시 판정 실패 보류 */
async function rejudgeHeld(e: SessEnv) {
  const max = e.ctx.settings().execution.crashRetryMax;
  const r = await passThenOwnerMessage(e);
  for (let n = 0; n <= max; n++) {
    const p = await nextReviewTurn(e, r.rk, `다시 판정 턴 ${n + 1}`);
    p.exit(1);
    await waitFor(() => p.done && !e.core.turns.hasLiveSession(r.rk), `다시 판정 턴 ${n + 1} 종료`);
    await sleep(50);
  }
  expect(e.ctx.store.tasks.require(r.task.id).hold.reasons).toMatchObject([{ kind: 'error', refId: REJUDGE_HOLD_REF }]);
  expect(queuedOn(e, r.rk)).toEqual([]);
  return r;
}

const send = (e: SessEnv, text: string, interrupt = false) => e.main('instruct_member', { member_id: e.qaId, text: text, urgent: interrupt ? 'interrupt' : true }) as unknown as Promise<UrgentInstructionResult>;

describe("'다시 판정 실패' 보류의 안내대로 하면 다시 판정한다 (S8-B1, CTL-06, CTL-10)", () => {
  it('알림·보류 사유가 두 길을 그대로 말하고, 안내대로 검수자에게 보낸 메시지는 그 작업의 검수 세션으로 간다 — 재개하면 그 메시지로 다시 판정한 뒤에야 병합 판단을 넣는다', async () => {
    const e = (env = await bootSessions());
    const { task, rk } = await rejudgeHeld(e);
    const held = e.ctx.store.tasks.require(task.id);
    expect(held.hold.reasons[0]!.note).toContain('긴급 지시를 보낸 뒤 재개하면 검수자가 그 지시를 보고 다시 판정한 뒤에 그 판정대로 이어 가고');
    expect(held.hold.reasons[0]!.note).toContain('지시 없이 재개하면 등록한 통과로 병합 판단을(를) 이어 갑니다');
    const notice = notices(e, '다시 판정 실패')[0]!;
    expect(notice.body).toContain('판정을 다시 받으려면 메인 에이전트가 검수자에게 긴급 지시를 보낸 뒤 재개합니다');
    // 이 보류는 메인 에이전트에게 알림 업무로 간다(alert rejudge-stuck) — 대표 알림은 넘긴 사실과 서두를 때의 명령창 길을 적는다. 따로 전해지지 않는다는 옛 글은 거짓이 됐다
    // (리드 결정 32·S5-8·S5-9)
    expect(notice.body).toContain('다시 판정을 받을지 등록한 통과로 이어 갈지 정하도록 메인 에이전트에게 넘겼습니다. 메인 에이전트가 확인하고 이어 갑니다 — 서둘러야 하면 명령창으로 메인 에이전트에게 알려 주세요.');
    expect(notice.body).not.toContain('따로 전해지지 않');
    const alerts = e.ctx.store.queue.list({ ref1: MAIN_AGENT_ID }).filter((q) => q.kind === 'alert');
    expect(alerts.map((q) => q.alertKey)).toEqual([`alert:rejudge-stuck:${task.id}`]);
    // 메인에게 가는 글은 두 길을 정확한 도구 호출로 적는다
    expect(alerts[0]!.message).toContain(`instruct_member(member_id="${e.qaId}", text="…", urgent=true)`);
    expect(alerts[0]!.message).toContain('등록한 통과로 이어 가려면 지시 없이');
    expect(notice.body).toContain('이 작업의 다시 판정으로 가고');
    expect(notice.body).toContain('지시 없이 재개하면 등록한 통과로 병합 판단을(를) 이어 갑니다');

    // 안내대로: 검수자(지금 맡은 일 없음)에게 메시지를 보낸다 — 예전에는 '진행 중인 업무가 없습니다'로 거부됐다
    const r = await send(e, AGAIN);
    expect(r.sessionKey).toBe(rk);
    expect(r.note).toMatch(new RegExp(`^${task.id} 다시 판정으로 전달`));
    expect(r.note).toContain('재개하기 전에는 병합 판단을(를) 하지 않습니다');
    expect(e.ctx.store.messages.get(r.messageId)).toMatchObject({ sessionKey: rk, deliveredAt: null });
    // 보류 중에는 띄우지 않고 병합 판단도 없다
    e.tick();
    await sleep(150);
    expect(liveCount(e, rk)).toBe(0);
    expect(mergeDecisions(e, task.id)).toEqual([]);

    // 재개 → 병합 판단 없이 그 메시지를 실은 다시 판정 턴 (시도 횟수는 처음부터)
    e.core.tasks.resumeByOwner(task.id, MAIN_AGENT_ID);
    await sleep(100);
    expect(mergeDecisions(e, task.id)).toEqual([]);
    expect(
      queuedOn(e, rk)
        .map((q) => `${q.kind}:${q.attempts}`)
        .sort(),
    ).toEqual(['message:0', 'review:0']);
    e.hold.add(rk);
    const p = await nextReviewTurn(e, rk, '재개 뒤 다시 판정 턴');
    expect(launchesOfKey(e, rk).at(-1)!.message).toContain(AGAIN);
    expect(launchesOfKey(e, rk).at(-1)!.message).toContain('이미 통과로 판정');
    expect(e.ctx.store.messages.get(r.messageId)!.deliveredAt).not.toBeNull();
    expect(mergeDecisions(e, task.id)).toEqual([]);
    // 그 턴이 끊기면 처음부터 센다 (1/max)
    p.exit(1);
    await waitFor(() => p.done && !e.core.turns.hasLiveSession(rk), '재개 뒤 끊긴 다시 판정 턴');
    await sleep(50);
    expect(mergeDecisions(e, task.id)).toEqual([]);
    expect(queuedOn(e, rk).every((q) => q.attempts === 1 && q.message.includes(`(다시 전달 1/`))).toBe(true);
    // 다음 턴을 정상으로 마치면(판정 그대로) 그때 병합 판단
    const p2 = await nextReviewTurn(e, rk, '다시 전달된 다시 판정 턴');
    p2.finishOk('메시지를 보고 판정은 그대로입니다');
    await waitFor(() => mergeDecisions(e, task.id).length === 1, '정상으로 마친 다시 판정 턴 뒤 병합 판단');
    expect(e.ctx.store.activity.search({ text: '다시 판정 턴 마침', limit: 10 }).some((a) => a.taskId === task.id)).toBe(true);
  }, 90_000);

  it('검수자가 자기 작업을 맡고 있어도(턴이 돌아도) 정해진 대로 그 보류 작업의 검수 세션으로 가고, 안내가 어느 업무로 가지 않았는지 말한다 — 즉시 전달을 골라도 그 턴을 끊지 않는다', async () => {
    const e = (env = await bootSessions());
    const { task, rk } = await rejudgeHeld(e);
    // QA 자신의 작업이 시작돼 턴이 돈다
    const own = makeTask(e, { directiveId: task.directiveId, assignee: e.qaId, title: 'QA 자기 작업' });
    const ok = taskKey(own.id);
    e.hold.add(ok);
    e.tick();
    await waitFor(() => liveCount(e, ok) === 1, 'QA 자기 작업 턴');
    const live = e.liveProc(ok)!;
    const r = await send(e, AGAIN, true);
    expect(r.sessionKey).toBe(rk);
    expect(r.note).toContain(`${task.id} 다시 판정으로 전달`);
    expect(r.note).toContain(`(${own.id} 작업에는 보내지 않음, 지금 턴도 중단하지 않음)`);
    expect(queuedOn(e, ok).filter((q) => q.kind === 'message')).toEqual([]);
    await sleep(200);
    expect(live.done).toBe(false);
    live.finishOk();
    await waitFor(() => !e.core.turns.hasLiveSession(ok), 'QA 자기 작업 턴 종료');
    // 맡은 작업만 있고 턴이 없을 때도 같다
    const r2 = await send(e, '하나 더 확인해 주세요');
    expect(r2.sessionKey).toBe(rk);
    expect(r2.note).toContain(`(${own.id} 작업에는 보내지 않음)`);
    // 재개 → 두 메시지를 실은 다시 판정 턴, 그 전에는 병합 판단 없음
    e.core.tasks.resumeByOwner(task.id, MAIN_AGENT_ID);
    await sleep(100);
    expect(mergeDecisions(e, task.id)).toEqual([]);
    e.hold.add(rk);
    await nextReviewTurn(e, rk, '재개 뒤 다시 판정 턴');
    const msg = launchesOfKey(e, rk).at(-1)!.message;
    expect(msg).toContain(AGAIN);
    expect(msg).toContain('하나 더 확인해 주세요');
  }, 90_000);

  it('지시 없이 재개하면 등록한 통과로 병합 판단을 이어 간다 (메인 에이전트가 정함) — 보류가 풀린 뒤의 메시지는 원래대로 간다', async () => {
    const e = (env = await bootSessions());
    const { task } = await rejudgeHeld(e);
    e.core.tasks.resumeByOwner(task.id, MAIN_AGENT_ID);
    await waitFor(() => mergeDecisions(e, task.id).length === 1, '메시지 없이 재개 → 병합 판단');
    expect(e.core.tasks.rejudgeHeldTaskFor(e.qaId)).toBeNull();
    await expect(send(e, '이제는 할 일이 없습니다')).rejects.toThrow('진행 중인 업무가 없습니다');
  }, 90_000);

  it('같은 검수자에게 다시 판정 실패 보류가 둘이면 먼저 보류된 작업으로 간다 — 그 작업을 재개하면 다음 메시지는 남은 보류 작업으로', async () => {
    const e = (env = await bootSessions());
    // 두 작업 모두 통과 뒤 대표 메시지로 미룬 채 다시 판정 턴이 상한에 닿은 것으로 둔다 (끊는 과정은 위에서 확인). 둘째 작업을 검수하는 동안 첫 작업의
    // 다시 판정 턴이 끼어들지 않게 첫 작업은 잠깐 대표 중단으로 멈춰 둔다
    const a = await passThenOwnerMessage(e);
    e.core.tasks.hold(a.task.id, 'interrupted', 'task', '회귀: 잠깐 멈춤', MAIN_AGENT_ID);
    const b = await passThenOwnerMessage(e);
    e.core.tasks.resumeByOwner(a.task.id, MAIN_AGENT_ID);
    expect(mergeDecisions(e, a.task.id)).toEqual([]);
    e.core.tasks.holdRejudgeStuck(a.task.id, '비정상 종료', 4);
    await sleep(20);
    e.core.tasks.holdRejudgeStuck(b.task.id, '비정상 종료', 4);
    for (const t of [a.task, b.task]) expect(e.ctx.store.tasks.require(t.id).hold.reasons).toMatchObject([{ kind: 'error', refId: REJUDGE_HOLD_REF }]);
    expect((await send(e, '첫 메시지')).sessionKey).toBe(a.rk);
    expect((await send(e, '둘째 메시지')).sessionKey).toBe(a.rk);
    e.core.tasks.resumeByOwner(a.task.id, MAIN_AGENT_ID);
    const r = await send(e, '셋째 메시지');
    expect(r.sessionKey).toBe(b.rk);
    expect(r.note).toContain(`${b.task.id} 다시 판정으로 전달`);
    expect(mergeDecisions(e, a.task.id)).toEqual([]);
    expect(e.ctx.store.tasks.require(a.task.id).state).toBe('in_review');
  }, 90_000);
});

describe('다시 판정 턴이 도는 동안 프로듀서에게 병합 후보로 주지 않는다 (S8-B3, CTL-06, GIT-04)', () => {
  it('get_work_context의 병합 후보에 없고 request_merge는 거부하며, 그동안 끝난 병합 판단 턴은 그 작업을 재촉하지 않는다', async () => {
    const e = (env = await bootSessions());
    const { task, rk } = await passThenOwnerMessage(e);
    e.hold.add(rk);
    const p2 = await nextReviewTurn(e, rk, '다시 판정 턴');
    expect(launchesOfKey(e, rk).at(-1)!.message).toContain('결제 화면까지 확인');
    // 메시지는 그 턴에 실렸다 — 대기열에 없고, 미룸 기록만 남았다
    expect(queuedOn(e, rk)).toEqual([]);
    const producer = member(e, e.producerId);
    const who = identityOf(e, producer, directiveKey(task.directiveId));
    const ctxRes = await callTool(e, who, 'get_work_context', {});
    expect(ctxRes.ok).toBe(true);
    const cands = ((ctxRes.ok ? (ctxRes.data as { mergeCandidates?: { taskId: string }[] }).mergeCandidates : []) ?? []).map((c) => c.taskId);
    expect(cands).not.toContain(task.id);
    expect((await callTool(e, who, 'request_merge', { task_id: task.id })).ok).toBe(false);
    // 그 작업의 병합 판단을 실은 지시 턴이 request_merge 없이 끝나도 재촉(병합 판단 다시 넣기·'프로듀서 처리 지연')하지 않는다
    const dk = directiveKey(task.directiveId);
    for (const q of e.ctx.store.queue.list({ ref2: dk, state: 'queued' })) e.ctx.store.queue.put({ ...q, state: 'done', doneAt: e.ctx.now() });
    enqueue(e.ctx, { kind: 'merge_decision', memberId: e.producerId, sessionKey: dk, projectId: task.projectId, taskId: task.id, directiveId: task.directiveId, priority: 'normal', message: `${task.id} 병합 판단` });
    e.hold.add(dk);
    e.tick();
    await waitFor(() => liveCount(e, dk) === 1, '병합 판단 턴');
    e.liveProc(dk)!.finishOk('병합할 작업이 없습니다');
    await waitFor(() => !e.core.turns.hasLiveSession(dk), '병합 판단 턴 종료');
    expect(e.ctx.store.queue.list({ ref2: dk, state: 'queued' }).filter((q) => q.kind === 'merge_decision')).toEqual([]);
    expect(notices(e, '프로듀서 처리 지연')).toEqual([]);
    p2.finishOk('메시지를 보고 판정은 그대로입니다');
    await waitFor(() => mergeDecisions(e, task.id).length === 1, '다시 판정 턴을 마친 뒤 병합 판단');
  }, 60_000);
});

describe('통과한 작업의 검수 턴이 프로세스 전에 실패하면 시작 실패로 센다 (S8-B4, ERR-04, CONC-01)', () => {
  it('다시 판정 턴이 시작 단계에서 이어서 실패하면 3회에서 멈추고 보류(오류) + 업무 시작 실패 알림 — 병합 판단 없음, 원인을 고치고 재개하면 다시 판정 턴부터', async () => {
    const e = (env = await bootSessions());
    const { task, rk } = await passThenOwnerMessage(e);
    let broken = true;
    e.prepareHook = (_launch, who) => {
      if (broken && who.sessionKey === rk) throw new Error('회귀: 검수 사본 폴더 없음');
    };
    const before = launchesOfKey(e, rk).length;
    for (let i = 0; i < 10; i++) {
      e.tick();
      await sleep(250);
    }
    expect(launchesOfKey(e, rk).length - before).toBe(3);
    const held = e.ctx.store.tasks.require(task.id);
    expect(held.state).toBe('on_hold');
    expect(held.hold.reasons).toMatchObject([{ kind: 'error' }]);
    expect(held.hold.reasons[0]!.note).toContain('턴 시작 3회 실패');
    expect(notices(e, '업무 시작 실패').length).toBeGreaterThan(0);
    expect(mergeDecisions(e, task.id)).toEqual([]);
    // 대표 메시지는 지우지 않고 그 검수 세션에 남긴다 — 재개 뒤 다시 판정 턴이 싣는다 (S9-B1)
    expect(queuedOn(e, rk).map((q) => q.kind)).toEqual(['message']);
    // 원인을 고치고 대표가 재개 → 병합 판단 없이 다시 판정 턴, 그 턴을 정상으로 마치면 병합 판단
    broken = false;
    e.core.tasks.resumeByOwner(task.id, MAIN_AGENT_ID);
    await sleep(100);
    expect(mergeDecisions(e, task.id)).toEqual([]);
    e.hold.add(rk);
    const p = await nextReviewTurn(e, rk, '재개 뒤 다시 판정 턴');
    expect(launchesOfKey(e, rk).at(-1)!.message).toContain('이미 통과로 판정');
    expect(launchesOfKey(e, rk).at(-1)!.message).toContain(TEXT);
    p.finishOk('판정은 그대로입니다');
    await waitFor(() => mergeDecisions(e, task.id).length === 1, '다시 판정 턴을 마친 뒤 병합 판단');
    expect(e.ctx.store.tasks.require(task.id).hold.reasons.some((x) => x.by === MAIN_AGENT_ID)).toBe(false);
  }, 60_000);
});
