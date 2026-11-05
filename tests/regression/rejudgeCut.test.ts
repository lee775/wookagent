/**
 * 통과 뒤 검수자에게 온 대표 메시지로 미룬 병합 판단과 판정 기회 없이 끝난 '다시 판정' 턴 (S7-B3 — CTL-06, AC-36, CLI-10, ERR-04).
 * 예전에는 미룸이 '그 검수자에게 아직 전달하지 않은 대표 메시지가 있는가'로만 정해졌다. 다시 판정 턴이 메시지를 싣고 뜨면 그 메시지는 전달됨이 되고,
 * 그 턴이 모델이 읽기 전에 끝나도(CLI 비정상 종료·사용량 한도·이어하기 실패) 턴 마무리가 미룸을 풀어 이전 통과로 병합 판단을 넣었다 — 검수자는
 * 메시지를 보고 다시 판정하지 못했는데 main에 이전 통과가 들어갔다. 이제 미룸은 그 검수자가 다시 판정 업무를 실은 검수 턴을 정상으로 마쳐야(또는 대표가
 * 정해야) 풀린다: 판정 기회 없이 끝난 턴은 대표 메시지와 다시 판정 요청을 '(다시 전달)'로 다시 넣고(crashRetryMax까지), 상한이면 병합하지 않고
 * 보류(오류)해 대표에게 알린다 — 대표가 재개하면 그 통과로 이어 간다. 기록(kv)이라 재시작해도 그대로다.
 */
import { mkdirSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { ReviewTarget, Task } from '@shared/domain';
import { MAIN_AGENT_ID, OWNER } from '@shared/domain';
import { reviewKey } from '../../src/main/orchestrator/records';
import { reviewCopyPath } from '../../src/main/orchestrator/paths';
import { REJUDGE_HOLD_REF } from '../../src/main/orchestrator/tasks';
import { notices, startReview, waitFor, type FakeProc } from './orchHarness';
import { bootSessions, liveCount, launchesOfKey, toolOk, type SessEnv } from '../acceptance/sessions-helpers';
import { bootRestartable, seedDirective, waitUntil, type RestartableEnv } from '../acceptance/stops-helpers';

let env: SessEnv | null = null;
let renv: { v: RestartableEnv } | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
  await renv?.v.close();
  renv = null;
});

const PASS = { verdict: 'pass', criteria: [{ criterion: '문서가 있다', pass: true, note: '확인' }], reason: '' };
const TEXT = '통과시키지 말고 결제 화면까지 확인한 뒤 다시 판정해 주세요';
type Cut = 'crash' | 'usage_limit' | 'resume_failed';

/** QA가 통과 → 대표가 QA에게 메시지 → 그 턴 종료: 병합 판단을 미루고 [대표 메시지, 다시 판정] */
async function passThenOwnerMessage(e: SessEnv) {
  const { task, proc } = await startReview(e, e.qaId, { outputMode: 'repo' });
  const rk = reviewKey(task.id);
  expect((await toolOk(e, proc.turnId, 'submit_review', { task_id: task.id, ...PASS })).verdict).toBe('pass');
  await e.main('instruct_member', { member_id: e.qaId, text: TEXT, urgent: true });
  proc.finishOk();
  await waitFor(() => !e.core.turns.hasLiveSession(rk), '첫 검수 턴 종료');
  expect(e.ctx.store.queue.list({ ref2: rk, state: 'queued' }).map((q) => q.kind)).toEqual(['message', 'review']);
  return { task, rk };
}

async function nextReviewTurn(e: SessEnv, rk: string, label: string): Promise<FakeProc> {
  e.tick();
  await waitFor(() => liveCount(e, rk) === 1, label, 15_000);
  const p = e.liveProc(rk)!;
  expect(launchesOfKey(e, rk).at(-1)!.message).toContain('결제 화면까지 확인');
  return p;
}

function cut(p: FakeProc, how: Cut): void {
  if (how === 'crash') p.exit(1);
  else if (how === 'usage_limit') p.emit({ kind: 'error', text: '사용량 한도에 도달했습니다', data: { errorKind: 'usage_limit' } });
  else {
    p.emit({ kind: 'error', text: 'No conversation found with session ID: gone', data: { errorKind: 'other', resumeFailed: true } });
    p.exit(1);
  }
}

const mergeDecisions = (e: SessEnv, taskId: string) => e.ctx.store.queue.list({ state: ['queued', 'running'] }).filter((q) => q.kind === 'merge_decision' && q.taskId === taskId);

describe('판정 기회 없이 끝난 다시 판정 턴은 미룸을 풀지 않는다 (S7-B3, CTL-06)', () => {
  it.each([
    ['CLI 비정상 종료', 'crash'],
    ['사용량 한도', 'usage_limit'],
    ['이어하기 실패', 'resume_failed'],
  ] as const)('%s — 병합 판단을 넣지 않고 대표 메시지와 다시 판정 요청을 다시 전달하며, 다음 다시 판정 턴을 정상으로 마치면(판정 그대로) 그 통과로 병합 판단을 넣는다', async (_label, how) => {
    const e = (env = await bootSessions());
    const { task, rk } = await passThenOwnerMessage(e);
    const p2 = await nextReviewTurn(e, rk, '다시 판정 턴');
    cut(p2, how);
    await waitFor(() => p2.done && !e.core.turns.hasLiveSession(rk), '다시 판정 턴 종료');
    await new Promise((r) => setTimeout(r, 100));
    expect(mergeDecisions(e, task.id)).toEqual([]);
    const again = e.ctx.store.queue.list({ ref2: rk, state: 'queued' });
    expect(again.map((q) => q.kind).sort()).toEqual(['message', 'review']);
    // 다시 판정의 다시 전달은 전달 횟수(deliveries)로 센다 — 비정상 종료형 끝(CLI 비정상 종료)만 비정상 종료 횟수(attempts)도 올린다 (리드 결정 30)
    expect(again.every((q) => q.message.includes('(다시 전달)') && q.deliveries === 1 && q.attempts === (how === 'crash' ? 1 : 0))).toBe(true);
    expect(e.ctx.store.tasks.require(task.id)).toMatchObject({ state: 'in_review', review: { passed: { reviewerId: e.qaId } } });
    expect(e.ctx.store.activity.search({ text: '다시 판정 턴이', limit: 10 }).some((a) => a.taskId === task.id && a.text.includes('다시 넣음'))).toBe(true);
    // 사용량 한도(모의 실행 2초)가 풀린 뒤 다음 턴
    const p3 = await nextReviewTurn(e, rk, '다시 전달된 다시 판정 턴');
    expect(launchesOfKey(e, rk).at(-1)!.message).toContain('(다시 전달)');
    p3.finishOk('메시지를 확인했고 판정은 그대로입니다');
    await waitFor(() => mergeDecisions(e, task.id).length === 1, '정상으로 마친 다시 판정 턴 뒤 병합 판단');
    expect(e.ctx.store.activity.search({ text: '다시 판정 턴 마침', limit: 10 }).some((a) => a.taskId === task.id)).toBe(true);
  }, 60_000);

  it('다시 판정 턴이 상한(crashRetryMax)을 넘겨 이어서 판정 기회 없이 끝나면 병합하지 않고 보류(오류) + 긴급 알림 — 메인 에이전트가 재개하면 그 통과로 병합 판단을 넣는다', async () => {
    const e = (env = await bootSessions());
    const max = e.ctx.settings().execution.crashRetryMax;
    const { task, rk } = await passThenOwnerMessage(e);
    for (let n = 0; n <= max; n++) {
      const p = await nextReviewTurn(e, rk, `다시 판정 턴 ${n + 1}`);
      cut(p, 'crash');
      await waitFor(() => p.done && !e.core.turns.hasLiveSession(rk), `다시 판정 턴 ${n + 1} 종료`);
      await new Promise((r) => setTimeout(r, 50));
      expect(mergeDecisions(e, task.id)).toEqual([]);
    }
    const held = e.ctx.store.tasks.require(task.id);
    expect(held.state).toBe('on_hold');
    expect(held.hold.reasons).toMatchObject([{ kind: 'error', refId: REJUDGE_HOLD_REF }]);
    expect(held.hold.reasons[0]!.note).toContain('재개하면 등록한 통과로 병합 판단을(를) 이어 갑니다');
    expect(held.review.passed?.reviewerId).toBe(e.qaId);
    expect(notices(e, '다시 판정 실패')).toHaveLength(1);
    // 더 띄우지 않는다
    e.tick();
    await new Promise((r) => setTimeout(r, 150));
    expect(liveCount(e, rk)).toBe(0);
    // 대표가 정한다: 재개 → 그 통과로 이어 간다
    e.core.tasks.resumeByOwner(task.id, MAIN_AGENT_ID);
    await waitFor(() => mergeDecisions(e, task.id).length === 1, '대표 재개 뒤 병합 판단');
    expect(e.ctx.store.tasks.require(task.id).state).toBe('in_review');
  }, 60_000);

  it('다시 판정 턴이 질문으로 끝나면(답변 대기 보류) 미룸이 그대로다 — 답을 받은 다음 검수 턴을 정상으로 마쳐야 병합 판단을 넣는다', async () => {
    const e = (env = await bootSessions());
    e.ctx.deps.timing!.questionEndGraceMs = 300;
    e.ctx.deps.timing!.questionEndCapMs = 3000;
    const { task, rk } = await passThenOwnerMessage(e);
    const p2 = await nextReviewTurn(e, rk, '다시 판정 턴');
    const q = await toolOk(e, p2.turnId, 'ask_producer', { question: '결제 화면도 완료 조건에 들어가나요?' });
    await waitFor(() => p2.done && !e.core.turns.hasLiveSession(rk), '질문한 턴 종료');
    expect(mergeDecisions(e, task.id)).toEqual([]);
    e.core.tasks.answer(String(q.questionId), '네, 들어갑니다', e.producerId);
    await waitFor(() => e.ctx.store.tasks.require(task.id).state === 'in_review', '답변 뒤 검수로');
    expect(mergeDecisions(e, task.id)).toEqual([]);
    e.tick();
    await waitFor(() => liveCount(e, rk) === 1, '답을 실은 검수 턴');
    e.liveProc(rk)!.finishOk('답을 보고 판정은 그대로입니다');
    await waitFor(() => mergeDecisions(e, task.id).length === 1, '정상으로 마친 검수 턴 뒤 병합 판단');
  }, 60_000);

  it('다시 판정 턴이 긴급 정지로 끊긴 뒤(메시지는 이미 그 턴에 전달됨) 앱이 다시 시작돼도 미룸이 그대로다 — 메인 에이전트가 재개하면 다시 판정 턴을 띄우고, 그 턴을 정상으로 마친 뒤에야 병합 판단을 넣는다', async () => {
    renv = { v: await bootRestartable() };
    let e = renv.v;
    const d = seedDirective(e);
    const t = seedRepoInReview(e, d.id);
    const rk = reviewKey(t.id);
    e.hold.add(rk);
    e.core.tasks.dispatchReview(e.ctx.store.tasks.require(t.id));
    e.tick();
    await waitUntil(() => !!e.liveProc(rk, e.qaId), '검수 턴');
    const p1 = e.liveProc(rk, e.qaId)!;
    expect((await e.tool(p1.turnId, 'submit_review', { task_id: t.id, ...PASS })).ok).toBe(true);
    await e.main('instruct_member', { member_id: e.qaId, text: TEXT, urgent: true });
    p1.finishOk();
    await waitUntil(() => !e.core.turns.hasLiveSession(rk), '첫 검수 턴 종료');
    e.tick();
    await waitUntil(() => !!e.liveProc(rk, e.qaId), '다시 판정 턴');
    expect(e.launchesOf(rk).at(-1)!.message).toContain('결제 화면까지 확인');
    // 모델이 읽기 전에 대표가 긴급 정지 — 그 턴의 대표 메시지는 전달됨으로 끝났다
    await e.core.stops.emergency(OWNER);
    await waitUntil(() => !e.core.turns.hasLiveSession(rk), '다시 판정 턴 정지');
    expect(e.ctx.store.queue.list({ ref2: rk, state: 'queued' }).filter((q) => q.kind === 'message')).toEqual([]);
    e.crash();
    e = renv.v = await e.reboot({ holdAll: true });
    e.core.stops.release(OWNER);
    e.core.tasks.resumeByOwner(t.id, MAIN_AGENT_ID);
    e.tick();
    await waitUntil(() => !!e.liveProc(rk, e.qaId), '재개 뒤 다시 판정 턴');
    const pending = () => e.ctx.store.queue.list({ state: ['queued', 'running'] }).filter((q) => q.kind === 'merge_decision');
    expect(pending()).toEqual([]);
    expect(e.launchesOf(rk).at(-1)!.message).toContain('이미 통과로 판정');
    e.liveProc(rk, e.qaId)!.finishOk('메시지를 확인했고 판정은 그대로입니다');
    await waitUntil(() => pending().length === 1, '정상으로 마친 다시 판정 턴 뒤 병합 판단');
  }, 60_000);
});

/** 검수 중인 저장소 변경형 작업 (검수 사본 폴더 포함) — 재시작 환경용 */
function seedRepoInReview(e: RestartableEnv, directiveId: string): Task {
  const ctx = e.ctx;
  const now = ctx.now();
  const id = ctx.store.nextId('task');
  const target: ReviewTarget = { kind: 'repo', taskCommitSha: 'a'.repeat(40), baseMainSha: 'b'.repeat(40), pinnedAt: now };
  const t: Task = {
    id,
    projectId: e.projectId,
    directiveId,
    round: 1,
    title: '검수 대상 작업',
    goal: '검수 회귀',
    type: 'docs',
    priority: 'normal',
    assigneeId: e.devId,
    reviewerId: e.qaId,
    prerequisiteIds: [],
    acceptanceCriteria: ['문서가 있다'],
    plannedAreas: [],
    outputMode: 'repo',
    state: 'in_review',
    hold: { reasons: [], returnState: null },
    workspace: null,
    review: { round: 1, rejectsInRound: 0, rejectsTotal: 0, target, passed: null, autoCheck: { status: 'not_applicable', detail: '', at: now } },
    contributors: [e.devId],
    merge: null,
    artifact: null,
    revertOfTaskId: null,
    revertedByTaskId: null,
    skillsUsed: [],
    pendingSubmit: null,
    conflict: null,
    crashRetries: 0,
    noProgressResumes: 0,
    createdBy: e.producerId,
    createdAt: now,
    updatedAt: now,
    queuedAt: now,
    activatedAt: now,
    completedAt: null,
    cancelledAt: null,
  };
  ctx.store.tasks.insert(t);
  mkdirSync(reviewCopyPath(ctx.paths, e.projectId, id, 1, 'a'.repeat(8)), { recursive: true });
  return t;
}
