/**
 * 통과 뒤 대표 메시지로 미룬 다시 판정 턴의 시작 실패 (S9-B1, S9-B2 — CTL-06, CTL-10, ERR-04).
 * - B1: 다시 판정 턴이 프로세스를 띄우기 전에 3번 실패하면 시작 실패 상한이 그 턴의 항목을 모두 지웠다 — 대표 메시지는 '전달 못 함'이 됐고, 원인을 고친 뒤
 *   재개하면 다시 판정 턴이 메시지 없이 "위 대표 메시지를 확인하세요"만 받아 이전 통과로 병합 판단이 들어갔다(검수자는 메시지를 끝내 보지 못함).
 *   이제 작업은 보류(오류)하되 대표 직접 메시지는 그 검수 세션에 남긴다 — 재개하면 같은 검수 세션의 다시 판정 턴이 그 메시지를 싣는다. 재개 뒤에는 다시 센다.
 * - B2: 시작 실패 상한이 재전달 횟수(attempts)를 같이 셌다 — 다시 판정 턴이 두 번 끊긴 뒤(attempts 2) 시작 실패 한 번이면 '턴 시작 3회 실패'로 보류했고,
 *   거꾸로 시작 실패 두 번 뒤 한 번 끊기면 '검수 턴이 3번 이어서 … 끝남'으로 보류했다. 이제 시작 실패는 따로 센다(startFails).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID } from '@shared/domain';
import { reviewKey } from '../../src/main/orchestrator/records';
import { notices, sleep, startReview, waitFor, type FakeProc } from './orchHarness';
import { bootSessions, launchesOfKey, liveCount, toolOk, type SessEnv } from '../acceptance/sessions-helpers';

let env: SessEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const PASS = { verdict: 'pass', criteria: [{ criterion: '문서가 있다', pass: true, note: '확인' }], reason: '' };
const TEXT = '통과시키지 말고 결제 화면까지 확인한 뒤 다시 판정해 주세요';

const mergeDecisions = (e: SessEnv, taskId: string) => e.ctx.store.queue.list({ state: ['queued', 'running'] }).filter((q) => q.kind === 'merge_decision' && q.taskId === taskId);
const queuedOn = (e: SessEnv, key: string) => e.ctx.store.queue.list({ ref2: key, state: 'queued' });

/** QA가 통과 → 대표가 QA에게 메시지 → 그 턴 종료: 병합 판단을 미루고 [대표 메시지, 다시 판정] */
async function passThenOwnerMessage(e: SessEnv) {
  const { task, proc } = await startReview(e, e.qaId, { outputMode: 'repo' });
  const rk = reviewKey(task.id);
  expect((await toolOk(e, proc.turnId, 'submit_review', { task_id: task.id, ...PASS })).verdict).toBe('pass');
  const sent = (await e.main('instruct_member', { member_id: e.qaId, text: TEXT, urgent: true })) as { messageId: string; sessionKey: string };
  expect(sent.sessionKey).toBe(rk);
  proc.finishOk();
  await waitFor(() => !e.core.turns.hasLiveSession(rk), '첫 검수 턴 종료');
  expect(queuedOn(e, rk).map((q) => q.kind).sort()).toEqual(['message', 'review']);
  return { task, rk, messageId: sent.messageId };
}

async function nextReviewTurn(e: SessEnv, rk: string, label: string): Promise<FakeProc> {
  e.tick();
  await waitFor(() => liveCount(e, rk) === 1, label, 15_000);
  return e.liveProc(rk)!;
}

/** 프로세스를 띄우기 전에 실패하는 다시 판정 턴 한 번 (시작 → 실패 처리까지) */
async function failedStart(e: SessEnv, rk: string, label: string): Promise<void> {
  const before = launchesOfKey(e, rk).length;
  e.tick();
  await waitFor(() => launchesOfKey(e, rk).length === before + 1 && !e.core.turns.hasLiveSession(rk), label, 15_000);
  await sleep(20);
}

describe('다시 판정 턴의 시작 실패 상한은 긴급 지시를 지우지 않는다 (S9-B1, CTL-06, CTL-10)', () => {
  it('3번 실패하면 보류(오류)하지만 긴급 지시는 그 검수 세션에 남는다 — 원인을 고쳐 재개하면 다시 판정 턴이 그 메시지를 싣고, 재개 뒤에는 다시 센다', async () => {
    const e = (env = await bootSessions());
    const { task, rk, messageId } = await passThenOwnerMessage(e);
    let fails = Infinity;
    e.prepareHook = (_launch, who) => {
      if (who.sessionKey === rk && fails > 0) {
        fails--;
        throw new Error('회귀: 검수 사본 폴더 없음');
      }
    };
    for (let i = 1; i <= 3; i++) await failedStart(e, rk, `시작 실패 ${i}`);
    const held = e.ctx.store.tasks.require(task.id);
    expect(held.state).toBe('on_hold');
    expect(held.hold.reasons).toMatchObject([{ kind: 'error', refId: null }]);
    expect(held.hold.reasons[0]!.note).toContain('턴 시작 3회 실패');
    expect(notices(e, '업무 시작 실패').length).toBeGreaterThan(0);
    // 대표 메시지는 지우지 않았다 — 전달 못 함으로 적거나 알리지 않고, 그 검수 세션에서 기다린다 (재개 뒤 시작 실패는 처음부터 센다)
    const msg = e.ctx.store.messages.get(messageId)!;
    expect([msg.deliveredAt, msg.undeliveredAt ?? null]).toEqual([null, null]);
    expect(notices(e, '긴급 지시 전달 못 함')).toEqual([]);
    expect(queuedOn(e, rk).map((q) => ({ kind: q.kind, urgent: q.urgent, messageId: q.messageId, startFails: q.startFails ?? 0 }))).toEqual([
      { kind: 'message', urgent: true, messageId, startFails: 0 },
    ]);
    expect(mergeDecisions(e, task.id)).toEqual([]);
    // 보류 중에는 띄우지 않는다
    e.tick();
    await sleep(100);
    expect(liveCount(e, rk)).toBe(0);
    expect(launchesOfKey(e, rk)).toHaveLength(4);

    // 대표가 재개(원인은 아직 일부 남음): 시작 실패 한 번으로 바로 멈추지 않는다 — 재개 뒤 다시 센다
    fails = 1;
    e.core.tasks.resumeByOwner(task.id, MAIN_AGENT_ID);
    await sleep(50);
    expect(mergeDecisions(e, task.id)).toEqual([]);
    await failedStart(e, rk, '재개 뒤 시작 실패 1');
    expect(e.ctx.store.tasks.require(task.id).state).toBe('in_review');
    expect(mergeDecisions(e, task.id)).toEqual([]);

    // 다음 다시 판정 턴이 대표 메시지를 싣는다 — 그 턴을 마친 뒤에야 병합 판단
    e.hold.add(rk);
    const p = await nextReviewTurn(e, rk, '재개 뒤 다시 판정 턴');
    const launched = launchesOfKey(e, rk).at(-1)!.message;
    expect(launched).toContain(TEXT);
    expect(launched).toContain('이미 통과로 판정');
    expect(e.ctx.store.messages.get(messageId)!.deliveredAt).not.toBeNull();
    expect(mergeDecisions(e, task.id)).toEqual([]);
    p.finishOk('메시지를 보고 판정은 그대로입니다');
    await waitFor(() => mergeDecisions(e, task.id).length === 1, '다시 판정 턴을 마친 뒤 병합 판단');
  }, 90_000);
});

describe('시작 실패 상한은 시작 실패만 센다 (S9-B2, ERR-04)', () => {
  it('다시 판정 턴이 두 번 끊긴 뒤에도 시작 실패 한 번으로 멈추지 않는다 — 세 번째 시작 실패에서 실제 횟수로 보류', async () => {
    const e = (env = await bootSessions());
    const { task, rk } = await passThenOwnerMessage(e);
    const max = e.ctx.settings().execution.crashRetryMax;
    expect(max).toBe(2);
    for (let n = 1; n <= max; n++) {
      const p = await nextReviewTurn(e, rk, `다시 판정 턴 ${n}`);
      p.exit(1);
      await waitFor(() => p.done && !e.core.turns.hasLiveSession(rk), `다시 판정 턴 ${n} 끊김`);
      await sleep(20);
    }
    expect(queuedOn(e, rk).map((q) => `${q.kind}:${q.attempts}`).sort()).toEqual(['message:2', 'review:2']);
    e.prepareHook = (_launch, who) => {
      if (who.sessionKey === rk) throw new Error('회귀: 일시적인 첨부 오류');
    };
    await failedStart(e, rk, '시작 실패 1');
    await failedStart(e, rk, '시작 실패 2');
    expect(e.ctx.store.tasks.require(task.id).state).toBe('in_review');
    expect(notices(e, '업무 시작 실패')).toEqual([]);
    expect(queuedOn(e, rk).map((q) => `${q.kind}:${q.attempts}:${q.startFails}`).sort()).toEqual(['message:2:2', 'review:2:2']);
    await failedStart(e, rk, '시작 실패 3');
    const held = e.ctx.store.tasks.require(task.id);
    expect(held.state).toBe('on_hold');
    expect(held.hold.reasons[0]!.note).toContain('턴 시작 3회 실패');
    expect(notices(e, '업무 시작 실패').length).toBeGreaterThan(0);
    expect(mergeDecisions(e, task.id)).toEqual([]);
  }, 90_000);

  it('거꾸로 시작 실패 두 번 뒤 한 번 끊긴 다시 판정 턴은 끊김 1회로 센다 — 다시 판정 실패 보류(검수 턴 3번 끊김)로 가지 않는다', async () => {
    const e = (env = await bootSessions());
    const { task, rk } = await passThenOwnerMessage(e);
    let fails = 2;
    e.prepareHook = (_launch, who) => {
      if (who.sessionKey === rk && fails > 0) {
        fails--;
        throw new Error('회귀: 일시적인 첨부 오류');
      }
    };
    await failedStart(e, rk, '시작 실패 1');
    await failedStart(e, rk, '시작 실패 2');
    const p = await nextReviewTurn(e, rk, '다시 판정 턴');
    p.exit(1);
    await waitFor(() => p.done && !e.core.turns.hasLiveSession(rk), '다시 판정 턴 끊김');
    await sleep(20);
    const t = e.ctx.store.tasks.require(task.id);
    expect(t.state).toBe('in_review');
    expect(notices(e, '다시 판정 실패')).toEqual([]);
    expect(queuedOn(e, rk).every((q) => q.attempts === 1 && q.message.includes('(다시 전달 1/'))).toBe(true);
    expect(mergeDecisions(e, task.id)).toEqual([]);
  }, 90_000);
});
