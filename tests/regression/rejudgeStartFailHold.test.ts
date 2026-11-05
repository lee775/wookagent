/**
 * 다시 판정 턴의 세 번째 시작 시도 도중 정지·보류가 걸린 경우 (S10-B1 — CTL-06, CTL-10, ERR-04).
 * 통과 뒤 대표 메시지로 미룬 다시 판정 턴이 시작에 두 번 실패하고, 세 번째 시도 도중 작업이 보류됐다. 예전에는 그 시도의 실패를 시작 실패로 세어 상한에
 * 닿았고, 작업이 검수 중(in_review)이 아니라 보류라서 대표 메시지까지 지웠다('전달 못 함'). 재개하면 다시 판정 턴이 메시지 없이 돌아 이전 통과로 병합
 * 판단이 들어갔다.
 * - 정지·보류 요청을 받은 턴(대표 중단·긴급 정지 등)의 턴 기록 전 실패는 시작 실패로 세지 않는다. 턴 기록 뒤 실패가 user_stop으로 끝나는 것과 같다.
 * - 검수 턴을 멈추지 않는 보류(작업자 일시정지)라 실제 시작 실패로 상한에 닿아도, 풀리면 검수로 돌아올 작업이면 대표 메시지를 남긴다.
 * 어느 쪽이든 풀린 뒤 다시 판정 턴이 그 메시지를 싣고, 그 턴을 마친 뒤에야 병합 판단이 들어간다.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID, OWNER, type Task } from '@shared/domain';
import { reviewKey } from '../../src/main/orchestrator/records';
import { notices, sleep, startReview, waitFor } from './orchHarness';
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
  return { task, rk, messageId: sent.messageId };
}

/**
 * 다시 판정 턴이 세 번 시작에 실패하게 하고, 세 번째 시도 도중 hold를 부른다. 'pre': 턴 기록 전(검수 사본 준비, git), 'post': 턴 기록 뒤(어댑터 준비).
 * 돌려준 함수로 실패를 멈춘다
 */
async function threeFailedStarts(e: SessEnv, rk: string, where: 'pre' | 'post', hold: () => void): Promise<() => void> {
  const tasks = e.core.tasks as unknown as { reviewCopyOf: (x: Task) => string | null; prepareReviewCopy: (...a: unknown[]) => Promise<string> };
  const real = { reviewCopyOf: tasks.reviewCopyOf, prepareReviewCopy: tasks.prepareReviewCopy };
  let calls = 0;
  if (where === 'pre') {
    tasks.reviewCopyOf = () => null;
    tasks.prepareReviewCopy = async () => {
      calls++;
      if (calls === 3) hold();
      await sleep(30);
      throw new Error('회귀: 검수 사본을 만들지 못함 (git)');
    };
  } else {
    e.prepareHook = (_launch, who) => {
      if (who.sessionKey !== rk) return;
      calls++;
      if (calls === 3) hold();
      throw new Error('회귀: 첨부 오류');
    };
  }
  for (let i = 1; i <= 3; i++) {
    e.tick();
    await waitFor(() => calls === i && !e.core.turns.hasLiveSession(rk), `시작 실패 ${i}`, 15_000);
    await sleep(80);
  }
  return () => {
    tasks.reviewCopyOf = real.reviewCopyOf;
    tasks.prepareReviewCopy = real.prepareReviewCopy;
    e.prepareHook = null;
  };
}

/** 풀린 뒤: 다시 판정 턴이 대표 메시지를 싣고, 그 턴을 마친 뒤에야 병합 판단 */
async function rejudgeCarriesMessage(e: SessEnv, task: Task, rk: string, messageId: string): Promise<void> {
  await sleep(100);
  expect(mergeDecisions(e, task.id)).toEqual([]);
  e.hold.add(rk);
  e.tick();
  await waitFor(() => liveCount(e, rk) === 1, '풀린 뒤 다시 판정 턴', 15_000);
  const launched = launchesOfKey(e, rk).at(-1)!.message;
  expect(launched).toContain(TEXT);
  expect(launched).toContain('이미 통과로 판정');
  expect(e.ctx.store.messages.get(messageId)!.deliveredAt).not.toBeNull();
  expect(mergeDecisions(e, task.id)).toEqual([]);
  e.liveProc(rk)!.finishOk('메시지를 보고 판정은 그대로입니다');
  await waitFor(() => mergeDecisions(e, task.id).length === 1, '다시 판정 턴을 마친 뒤 병합 판단');
}

function messageKept(e: SessEnv, messageId: string): void {
  const msg = e.ctx.store.messages.get(messageId)!;
  expect([msg.deliveredAt, msg.undeliveredAt ?? null]).toEqual([null, null]);
  expect(notices(e, '긴급 지시 전달 못 함')).toEqual([]);
}

describe('정지·보류 요청을 받은 다시 판정 턴의 시작 전 실패는 세지 않는다 (S10-B1, ERR-04)', () => {
  const STOPS: { name: string; hold: (e: SessEnv, t: Task) => void; release: (e: SessEnv, t: Task) => void; reason: string }[] = [
    { name: '대표 중단', hold: (e, t) => void e.core.tasks.interrupt(t.id, 'hold', MAIN_AGENT_ID), release: (e, t) => void e.core.tasks.resumeByOwner(t.id, MAIN_AGENT_ID), reason: 'interrupted' },
    {
      name: '긴급 정지',
      hold: (e) => void e.core.stops.emergency(OWNER),
      release: (e, t) => {
        e.core.stops.release(OWNER);
        e.core.tasks.resumeByOwner(t.id, MAIN_AGENT_ID);
      },
      reason: 'emergency_stop',
    },
  ];
  for (const s of STOPS) {
    it(`${s.name}: 그 시도의 실패는 횟수에 들지 않고 긴급 지시는 남는다 — 재개하면 다시 판정 턴이 그 메시지를 싣는다`, async () => {
      const e = (env = await bootSessions());
      const { task, rk, messageId } = await passThenOwnerMessage(e);
      const restore = await threeFailedStarts(e, rk, 'pre', () => s.hold(e, task));
      const held = e.ctx.store.tasks.require(task.id);
      expect(held.state).toBe('on_hold');
      // 정지 보류만 — '턴 시작 3회 실패' 오류 보류나 '업무 시작 실패' 알림이 없다
      expect(held.hold.reasons.map((r) => r.kind)).toEqual([s.reason]);
      expect(notices(e, '업무 시작 실패')).toEqual([]);
      expect(
        queuedOn(e, rk)
          .map((q) => `${q.kind}:${q.startFails ?? 0}`)
          .sort(),
      ).toEqual(['message:2', 'review:2']);
      messageKept(e, messageId);
      restore();
      s.release(e, task);
      await rejudgeCarriesMessage(e, task, rk, messageId);
    }, 90_000);
  }
});

describe('검수 턴을 멈추지 않는 보류 중 상한에 닿아도 검수로 돌아올 작업은 긴급 지시를 남긴다 (S10-B1, CTL-06, CTL-10)', () => {
  for (const where of ['pre', 'post'] as const) {
    it(`작업자 일시정지 (턴 기록 ${where === 'pre' ? '전' : '뒤'} 실패): 상한은 알리되 메시지는 남고, 작업자 재개 뒤 다시 판정 턴이 그 메시지를 싣는다`, async () => {
      const e = (env = await bootSessions());
      const { task, rk, messageId } = await passThenOwnerMessage(e);
      const restore = await threeFailedStarts(e, rk, where, () => void e.core.stops.pauseMember(e.devId, 'immediate', MAIN_AGENT_ID));
      const held = e.ctx.store.tasks.require(task.id);
      expect([held.state, held.hold.returnState, held.hold.reasons.map((r) => r.kind)]).toEqual(['on_hold', 'in_review', ['paused']]);
      // 검수자 턴은 멈추지 않았으므로 실제 시작 실패 3회 — 상한 알림은 가고, 대표 메시지는 다시 센다
      expect(notices(e, '업무 시작 실패').length).toBeGreaterThan(0);
      expect(queuedOn(e, rk).map((q) => ({ kind: q.kind, messageId: q.messageId, startFails: q.startFails ?? 0 }))).toEqual([{ kind: 'message', messageId, startFails: 0 }]);
      messageKept(e, messageId);
      restore();
      e.core.stops.resumeMember(e.devId, MAIN_AGENT_ID);
      await rejudgeCarriesMessage(e, task, rk, messageId);
    }, 90_000);
  }
});
