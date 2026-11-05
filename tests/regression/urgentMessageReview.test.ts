/**
 * 대표 직접 메시지와 검수 (CTL-06 대표 지시 우선, CTL-05·AC-17 공유, AC-36 우선 전달, REV-06):
 * - 대표가 작업자에게 보낸 지시는 그 작업을 검수하는 쪽(프로듀서든 QA든)이 판정 전에 본다 — 검수 턴 메시지의 '대표 지시' 절, get_review_target·
 *   get_work_context의 urgentInstructions. 관리 턴을 더 띄우지 않고(AC-41), 다른 작업의 검수에는 섞지 않는다(AC-40). 검수 턴이 시작된 뒤 온 지시를
 *   보지 않은 판정은 받지 않고 그 지시를 거부 안내로 보인다 — 다시 판정하면 받는다(턴은 끝내지 않는다)
 * - 통과 뒤 그 검수자에게 온 대표 메시지는 병합·확정 전에 그 검수 세션에 먼저 전달하고(그동안 병합 판단·병합·확정을 미룬다) 검수자의 새 판정이
 *   통과를 대신한다. 바꾸지 않으면 그 통과로 이어 간다. 보낸 뒤 안내는 사실대로
 * - 대표 메시지를 먼저 전달하려고 프로그램이 끝낸 검수 턴은 판정 재촉의 재시도·검수자 교체 요청(reviewer_assign)으로 세지 않는다
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID } from '@shared/domain';
import { directiveKey, enqueue, mainKey, reviewKey, taskKey, transitionTask } from '../../src/main/orchestrator/records';
import { artifactWorkDir } from '../../src/main/orchestrator/paths';
import { notices, seedDirective, seedInReviewTask, sleep, startReview, waitFor } from './orchHarness';
import { bootSessions, launchesOfKey, liveCount, makeTask, toolOk, turnsOfKey, type SessEnv } from '../acceptance/sessions-helpers';

let env: SessEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const OWNER_FIRST = /이번 턴에 전달된 일 \d건\n\n### 1\. 메시지 확인 \(긴급 지시 우선 전달\)\n> 메인 에이전트 긴급 지시/;
const git = (cwd: string, args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
const criteria = (pass: boolean, note = '확인') => [{ criterion: '동작한다', pass, note }];
const PASS = { verdict: 'pass', criteria: criteria(true), reason: '' };
const queuedKinds = (e: SessEnv, pred: (q: { kind: string; taskId: string | null }) => boolean) =>
  e.ctx.store.queue
    .list({ state: 'queued' })
    .filter(pred)
    .map((q) => q.kind);

/** 산출물형 작업: 작업자 턴에 대표 메시지를 보내 다음 턴(같은 세션)에 전달받고 반영해 제출한다 → 검수 대기 */
async function ownerInstructedSubmission(e: SessEnv, o: { reviewerId?: string; text: string }) {
  const d = seedDirective(e);
  const t = makeTask(e, { directiveId: d.id, assignee: e.devId, title: '로그인 안내서', type: 'docs', outputMode: 'artifact', reviewerId: o.reviewerId ?? null });
  const key = taskKey(t.id);
  const rk = reviewKey(t.id);
  const doc = join(artifactWorkDir(e.ctx.paths, e.projectId, t.id), 'guide.md');
  e.hold.add(key);
  e.hold.add(rk);
  e.tick();
  await waitFor(() => liveCount(e, key) === 1, '작업 턴');
  const p1 = e.liveProc(key)!;
  await toolOk(e, p1.turnId, 'set_steps', { steps: ['안내서 작성'] });
  writeFileSync(doc, '# 로그인 안내\n버튼: 빨간색\n', 'utf8');
  await toolOk(e, p1.turnId, 'complete_step', { step_index: 0, note: '작성' });
  await e.main('instruct_member', { member_id: e.devId, text: o.text, urgent: true });
  p1.finishOk('1단계 마침');
  await waitFor(() => !e.core.turns.hasLiveSession(key), '첫 턴 종료');
  e.tick();
  await waitFor(() => turnsOfKey(e, key).length === 2 && liveCount(e, key) === 1, '대표 메시지 전달 턴');
  expect(launchesOfKey(e, key)[1]!.message).toContain(o.text);
  const p2 = e.liveProc(key)!;
  writeFileSync(doc, '# 로그인 안내\n버튼: 파란색 (대표 지시)\n', 'utf8');
  await toolOk(e, p2.turnId, 'submit_for_review', { note: '대표 지시대로 파란색' });
  p2.finishOk();
  await waitFor(() => e.ctx.store.tasks.require(t.id).state === 'in_review', '검수로');
  return { d, t, key, rk };
}

describe('대표가 작업자에게 보낸 지시는 그 작업의 검수자가 판정 전에 본다 (CTL-06, AC-17, REV-06)', () => {
  it.each([
    ['프로듀서(기본 검수자)', 'producer'],
    ['QA', 'qa'],
  ] as const)('%s 검수: 검수 턴 메시지의 대표 지시 절·get_work_context·get_review_target에 대표 지시가 보이고, 관리 턴을 더 띄우지 않으며 다른 작업 검수에는 섞이지 않는다', async (_label, who) => {
    const e = (env = await bootSessions());
    const text = '로그인 버튼은 완료 조건과 달리 파란색으로 해 주세요';
    const reviewerId = who === 'qa' ? e.qaId : e.producerId;
    const { d, t, rk } = await ownerInstructedSubmission(e, { reviewerId: who === 'qa' ? e.qaId : undefined, text });
    expect(e.ctx.store.tasks.require(t.id).reviewerId).toBe(reviewerId);
    e.tick();
    await waitFor(() => liveCount(e, rk) === 1, '검수 턴');
    const rv = e.liveProc(rk)!;
    expect(rv.memberId).toBe(reviewerId);
    // 검수 턴 메시지: 프로그램이 쓴 '대표 지시' 절 + 인용된 본문
    const launch = launchesOfKey(e, rk)[0]!.message;
    expect(launch).toMatch(/## 긴급 지시 — 메인 에이전트가 이 작업에 보낸 긴급 지시 1건 \(완료 조건·프로듀서 지시보다 우선, CTL-06\)\n> \[[^\]]+\] 메인 에이전트 → [^\n]*작업자\): 로그인 버튼은 완료 조건과 달리 파란색으로 해 주세요/);
    expect(launch.indexOf('## 긴급 지시')).toBeGreaterThan(launch.indexOf('### 1. 검수'));
    // 업무 문맥·검수 대상 조회
    const wc = await toolOk(e, rv.turnId, 'get_work_context');
    const reviewTask = (wc.reviewTasks as { urgentInstructions?: { text: string; to: string; delivered: boolean }[] }[])[0]!;
    expect(reviewTask.urgentInstructions?.map((x) => [x.text, x.delivered])).toEqual([[text, true]]);
    expect(reviewTask.urgentInstructions![0]!.to).toContain(`${e.devId}, 작업자`);
    const target = await toolOk(e, rv.turnId, 'get_review_target', { task_id: t.id });
    expect((target.urgentInstructions as { text: string }[]).map((x) => x.text)).toEqual([text]);
    expect(String(target.urgentInstructionsNote)).toContain('완료 조건·프로듀서 지시보다 우선');
    // 판정은 그대로 받는다 (이 턴은 대표 지시를 모두 보였다)
    expect((await toolOk(e, rv.turnId, 'submit_review', { task_id: t.id, ...PASS })).verdict).toBe('pass');
    rv.finishOk();
    await waitFor(() => e.ctx.store.tasks.require(t.id).state === 'done' && !e.core.turns.hasLiveSession(rk), '완료');
    // 공유 사본은 그 자체로 관리 턴을 띄우지 않았다 (AC-41) — 지시 관리·메인 에이전트 대화 턴 없음
    expect([turnsOfKey(e, directiveKey(d.id)).length, turnsOfKey(e, mainKey(e.projectId)).length]).toEqual([0, 0]);
    // 긴급 지시는 메인 에이전트가 보냈으므로 공유 사본은 프로듀서에게만 (옛 대표 직접 메시지는 메인·프로듀서 둘 다)
    expect(e.ctx.store.queue.list({ state: 'queued' }).filter((q) => q.ownerShared).map((q) => q.memberId).sort()).toEqual([e.producerId]);
    // 다른 작업의 검수에는 그 대표 지시가 섞이지 않는다 (AC-40)
    const other = seedInReviewTask(e, e.qaId, { directiveId: d.id });
    const ok = reviewKey(other.id);
    e.hold.add(ok);
    e.core.tasks.dispatchReview(e.ctx.store.tasks.require(other.id));
    e.tick();
    await waitFor(() => liveCount(e, ok) === 1, '다른 작업 검수 턴');
    const otherLaunch = launchesOfKey(e, ok)[0]!.message;
    expect(otherLaunch).not.toContain('파란색');
    expect(otherLaunch).not.toContain('## 긴급 지시');
    const owc = await toolOk(e, e.liveProc(ok)!.turnId, 'get_work_context');
    expect(JSON.stringify(owc)).not.toContain('파란색');
  });

  it('검수 턴이 시작된 뒤 작업자에게 온 대표 지시를 보지 않은 판정은 받지 않고 그 지시를 거부 안내로 보인다 — 턴은 끝내지 않으며, 다시 판정하면 받는다 (반려는 한 번만 센다)', async () => {
    const e = (env = await bootSessions());
    e.ctx.deps.timing!.questionEndGraceMs = 300;
    const { task, proc } = await startReview(e, e.qaId, { outputMode: 'repo' });
    const rk = reviewKey(task.id);
    const key = taskKey(task.id);
    await toolOk(e, proc.turnId, 'get_review_target', { task_id: task.id }); // 대표 지시가 오기 전에 조회
    const text = '결제 실패 문구는 "다시 시도해 주세요"로 바꿔 주세요';
    const sent = await e.main('instruct_member', { member_id: e.devId, text: text, urgent: true });
    expect(sent.sessionKey).toBe(key);
    const reject = { task_id: task.id, verdict: 'reject', criteria: [{ criterion: '문서가 있다', pass: false, note: '보완' }], reason: '문구 보완 필요' };
    const refused = await e.tool(proc.turnId, 'submit_review', reject);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.code).toBe('conflict');
      expect(refused.message).toContain('아직 보지 않았습니다');
      expect(refused.message).toContain(text);
    }
    expect(e.ctx.store.reviews.list({ ref1: task.id })).toEqual([]);
    // 거부 안내로 지시를 보였으니 턴은 그대로 — 끝내거나 다시 넣지 않는다
    await sleep(700);
    expect(proc.done).toBe(false);
    const again = await toolOk(e, proc.turnId, 'submit_review', reject);
    expect([again.verdict, again.duplicate, again.taskState]).toEqual(['reject', false, 'in_progress']);
    proc.finishOk();
    await waitFor(() => !e.core.turns.hasLiveSession(rk), '검수 턴 종료');
    const cur = e.ctx.store.tasks.require(task.id);
    expect([cur.review.rejectsInRound, cur.review.rejectsTotal]).toEqual([1, 1]);
    // 재작업 첫 턴(같은 작업 세션) 맨 앞에 대표 지시, 그 뒤 반려 사유
    e.hold.add(key);
    e.tick();
    await waitFor(() => liveCount(e, key) === 1, '재작업 턴');
    const l = launchesOfKey(e, key)[0]!.message;
    expect(l).toMatch(OWNER_FIRST);
    expect(l).toContain(text);
    expect(l).toContain('문구 보완 필요');
  });
});

describe('통과 뒤 검수자에게 온 대표 메시지는 병합·확정 전에 전달되고 판정을 바꿀 수 있다 (AC-36, CLI-10, CTL-06)', () => {
  /** QA 검수 턴(저장소 변경형)에서 통과를 등록한 뒤 대표가 QA에게 메시지를 보낸다 — 검수 턴은 아직 살아 있다 */
  async function passedThenOwnerMessage(e: SessEnv, text: string) {
    const { task, proc } = await startReview(e, e.qaId, { outputMode: 'repo' });
    const rk = reviewKey(task.id);
    expect((await toolOk(e, proc.turnId, 'submit_review', { task_id: task.id, ...PASS, criteria: [{ criterion: '문서가 있다', pass: true, note: '확인' }] })).verdict).toBe('pass');
    const sent = await e.main('instruct_member', { member_id: e.qaId, text: text, urgent: true });
    expect(sent.sessionKey).toBe(rk);
    return { task, proc, rk, sent };
  }

  it('검수자가 메시지를 보고 반려하면 그 판정이 통과를 대신한다 — 그 사이 병합 판단을 넣지 않고, 보낸 뒤 안내가 사실대로 알린다', async () => {
    const e = (env = await bootSessions());
    const text = '통과시키지 말고 결제 화면까지 확인한 뒤 판정해 주세요';
    const { task, proc, rk, sent } = await passedThenOwnerMessage(e, text);
    expect(sent.note).toContain('이미 이 버전을 통과로 판정했습니다');
    expect(sent.note).toContain('병합 판단을(를) 미룹니다');
    expect(sent.note).not.toContain('판정은 지시를 확인한 뒤에 받습니다');
    proc.finishOk();
    await waitFor(() => !e.core.turns.hasLiveSession(rk), '검수 턴 종료');
    // 병합 판단을 미루고 같은 버전의 '다시 판정' 검수 업무를 그 검수자에게 넣었다
    expect(queuedKinds(e, (q) => q.taskId === task.id && q.kind === 'merge_decision')).toEqual([]);
    const pin = e.ctx.store.tasks.require(task.id).review.target!.pinnedAt;
    expect(e.ctx.store.queue.list({ ref2: rk, state: 'queued' }).map((q) => [q.kind, q.urgent, q.memberId, q.kind === 'review' ? q.reviewPinnedAt : null])).toEqual([
      ['message', true, e.qaId, null],
      ['review', false, e.qaId, pin],
    ]);
    e.tick();
    await waitFor(() => liveCount(e, rk) === 1, '대표 메시지 전달 검수 턴');
    const l2 = launchesOfKey(e, rk).at(-1)!.message;
    expect(l2).toMatch(OWNER_FIRST);
    expect(l2).toContain('결제 화면까지 확인');
    expect(l2).toMatch(/### 2\. 검수\n> [^\n]*이미 통과로 판정했습니다/);
    const r2 = await toolOk(e, e.liveProc(rk)!.turnId, 'submit_review', {
      task_id: task.id,
      verdict: 'reject',
      criteria: [{ criterion: '문서가 있다', pass: false, note: '결제 화면 미확인' }],
      reason: '대표 지시대로 결제 화면까지 확인이 필요합니다',
    });
    expect([r2.verdict, r2.duplicate, r2.taskState]).toEqual(['reject', false, 'in_progress']);
    const cur = e.ctx.store.tasks.require(task.id);
    expect([cur.review.passed, cur.review.rejectsInRound]).toEqual([null, 1]);
    expect(e.ctx.store.reviews.list({ ref1: task.id }).map((r) => r.verdict)).toEqual(['pass', 'reject']);
    e.liveProc(rk)!.finishOk();
    await waitFor(() => !e.core.turns.hasLiveSession(rk), '두 번째 검수 턴 종료');
    expect(queuedKinds(e, (q) => q.taskId === task.id && q.kind === 'merge_decision')).toEqual([]);
    expect(notices(e, '긴급 지시 전달 못 함')).toEqual([]);
  });

  it('검수자가 메시지를 보고 판정을 바꾸지 않으면 그 통과로 병합 판단을 넣고 병합한다 — 대표 메시지는 전달됐다', async () => {
    const e = (env = await bootSessions());
    const { task, proc, rk } = await passedThenOwnerMessage(e, '접근성 항목도 봤는지 확인해 주세요');
    proc.finishOk();
    await waitFor(() => !e.core.turns.hasLiveSession(rk), '검수 턴 종료');
    expect(queuedKinds(e, (q) => q.taskId === task.id && q.kind === 'merge_decision')).toEqual([]);
    e.tick();
    await waitFor(() => liveCount(e, rk) === 1, '대표 메시지 전달 검수 턴');
    e.liveProc(rk)!.finishOk('확인했습니다. 판정은 그대로입니다');
    await waitFor(() => !e.core.turns.hasLiveSession(rk), '두 번째 검수 턴 종료');
    expect(queuedKinds(e, (q) => q.taskId === task.id && q.kind === 'merge_decision')).toEqual(['merge_decision']);
    expect(e.ctx.store.reviews.list({ ref1: task.id }).map((r) => r.verdict)).toEqual(['pass']);
    expect(e.ctx.store.messages.list({ ref1: e.qaId }).map((m) => !!m.deliveredAt)).toEqual([true]);
    expect(notices(e, '긴급 지시 전달 못 함')).toEqual([]);
  });

  it('병합 요청이 잠금을 기다리는 사이 검수자에게 대표 메시지가 오면 병합 처리가 main을 바꾸지 않고 멈춘다 — 그 상태의 병합 요청도 받지 않는다. 검수자가 확인한 뒤 병합한다', async () => {
    const e = (env = await bootSessions());
    const d = seedDirective(e);
    const t = makeTask(e, { directiveId: d.id, assignee: e.devId, title: '로그인 화면', reviewerId: e.qaId });
    const key = taskKey(t.id);
    const rk = reviewKey(t.id);
    e.hold.add(key);
    e.hold.add(rk);
    e.tick();
    await waitFor(() => liveCount(e, key) === 1, '작업 턴');
    const p1 = e.liveProc(key)!;
    await toolOk(e, p1.turnId, 'set_steps', { steps: ['구현'] });
    writeFileSync(join(e.ctx.store.tasks.require(t.id).workspace!.worktreePath, 'login.txt'), '로그인\n', 'utf8');
    await toolOk(e, p1.turnId, 'complete_step', { step_index: 0, note: '구현' });
    await toolOk(e, p1.turnId, 'submit_for_review', { note: '제출' });
    p1.finishOk();
    await waitFor(() => e.ctx.store.tasks.require(t.id).state === 'in_review', '검수로');
    e.tick();
    await waitFor(() => liveCount(e, rk) === 1, 'QA 검수 턴');
    const rv = e.liveProc(rk)!;
    await toolOk(e, rv.turnId, 'submit_review', { task_id: t.id, ...PASS });
    const producer = e.ctx.store.members.require(e.producerId);
    const mainBefore = git(e.projectDir, ['rev-parse', 'HEAD']);
    // 병합 요청은 받았지만 프로젝트 잠금을 다른 처리가 잡고 있다
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const holder = e.core.locks.run(e.projectId, 'test-hold', () => gate);
    expect(e.core.merges.requestMerge(t.id, producer, null).status).toBe('queued');
    const sent = await e.main('instruct_member', { member_id: e.qaId, text: '결제 화면도 확인했는지 알려 주세요', urgent: true });
    expect(sent.sessionKey).toBe(rk);
    expect(sent.note).toContain('병합을 처리하는 중');
    release();
    await holder;
    await waitFor(() => !e.core.merges.isPending(t.id), '병합 처리 끝');
    expect(git(e.projectDir, ['rev-parse', 'HEAD'])).toBe(mainBefore);
    const cur = e.ctx.store.tasks.require(t.id);
    expect([cur.state, cur.merge, !!cur.review.passed]).toEqual(['in_review', null, true]);
    // 이 상태의 병합 요청은 받지 않고, 프로듀서의 병합 후보에도 넣지 않는다 (검수자가 판정을 바꿀 수 있다)
    expect(() => e.core.merges.requestMerge(t.id, producer, null)).toThrow(/검수자에게 통과 판정 뒤 긴급 지시/);
    expect(git(e.projectDir, ['rev-parse', 'HEAD'])).toBe(mainBefore);
    const dk = directiveKey(d.id);
    e.hold.add(dk);
    e.core.merges.queueMergeDecision(e.ctx.store.tasks.require(t.id));
    expect(queuedKinds(e, (q) => q.taskId === t.id && q.kind === 'merge_decision')).toEqual([]);
    // 미루기 전에 넣어 둔 병합 판단이 남아 있었다면: 프로듀서 턴의 후보에서 빠지고, 병합 요청 없이 끝나도 재촉하지 않는다
    enqueue(e.ctx, { kind: 'merge_decision', memberId: e.producerId, sessionKey: dk, projectId: e.projectId, taskId: t.id, directiveId: d.id, message: `${t.id} 병합 판단` });
    e.tick();
    await waitFor(() => !!e.liveProc(dk, e.producerId), '프로듀서 지시 관리 턴');
    const pwc = await toolOk(e, e.liveProc(dk, e.producerId)!.turnId, 'get_work_context');
    expect((pwc.mergeCandidates as { taskId: string }[]).map((c) => c.taskId)).toEqual([]);
    e.liveProc(dk, e.producerId)!.finishOk();
    await waitFor(() => !e.core.turns.hasLiveSession(dk), '프로듀서 턴 종료');
    // 병합 판단 재촉(작업 ID 없이 지시 세션에 넣는 항목 포함)도 없다
    expect(e.ctx.store.queue.list({ ref2: dk, state: 'queued' }).filter((q) => q.kind === 'merge_decision')).toEqual([]);
    // 검수자가 확인하고(판정 그대로) 턴을 마치면 병합 판단 → 병합
    rv.finishOk();
    await waitFor(() => !e.core.turns.hasLiveSession(rk), '검수 턴 종료');
    e.tick();
    await waitFor(() => liveCount(e, rk) === 1, '대표 메시지 전달 검수 턴');
    expect(launchesOfKey(e, rk).at(-1)!.message).toContain('결제 화면도 확인했는지');
    e.liveProc(rk)!.finishOk();
    await waitFor(() => !e.core.turns.hasLiveSession(rk), '두 번째 검수 턴 종료');
    expect(queuedKinds(e, (q) => q.taskId === t.id && q.kind === 'merge_decision')).toEqual(['merge_decision']);
    expect(e.core.merges.requestMerge(t.id, producer, null).status).toBe('queued');
    await waitFor(() => e.ctx.store.tasks.require(t.id).state === 'done' && !e.core.merges.isPending(t.id), '병합 완료');
    expect(git(e.projectDir, ['rev-parse', 'HEAD'])).not.toBe(mainBefore);
  });

  it('산출물형: 통과 뒤 보류가 풀려 확정할 때 검수자에게 온 대표 메시지가 기다리면 확정을 미루고 먼저 전달한다 — 판정을 바꾸지 않으면 그 통과로 확정·완료', async () => {
    const e = (env = await bootSessions());
    const text = '목차 순서를 확인했는지 알려 주세요';
    const { t, rk } = await ownerInstructedSubmission(e, { reviewerId: e.qaId, text: '안내서에 고객센터 번호를 넣어 주세요' });
    e.tick();
    await waitFor(() => liveCount(e, rk) === 1, 'QA 검수 턴');
    const rv = e.liveProc(rk)!;
    // 통과는 기록됐지만 확정 전에 보류됐다 (확정이 파일 잠김으로 실패한 경우 등)
    const target = e.ctx.store.tasks.require(t.id).review.target!;
    transitionTask(e.ctx, t.id, { type: 'review_pass', reviewId: 'RV-보류', reviewerId: e.qaId, target }, e.qaId);
    e.core.tasks.hold(t.id, 'error', 'task', '산출물 확정 실패: EBUSY', 'system');
    const sent = await e.main('instruct_member', { member_id: e.qaId, text: text, urgent: true });
    expect(sent.sessionKey).toBe(rk);
    expect(sent.note).toContain('보류가 풀리면');
    expect(sent.note).toContain('산출물 확정을(를) 미룹니다');
    rv.finishOk();
    await waitFor(() => !e.core.turns.hasLiveSession(rk), '검수 턴 종료');
    await e.main('resume_task', { task_id: t.id });
    await sleep(50);
    // 확정을 미뤘다 — 검수(통과) 상태 그대로, 그 검수자에게 대표 메시지와 다시 판정 업무
    const held = e.ctx.store.tasks.require(t.id);
    expect([held.state, held.artifact]).toEqual(['in_review', null]);
    expect(e.ctx.store.queue.list({ ref2: rk, state: 'queued' }).map((q) => q.kind)).toEqual(['message', 'review']);
    e.tick();
    await waitFor(() => liveCount(e, rk) === 1, '대표 메시지 전달 검수 턴');
    expect(launchesOfKey(e, rk).at(-1)!.message).toContain(text);
    e.liveProc(rk)!.finishOk();
    await waitFor(() => e.ctx.store.tasks.require(t.id).state === 'done', '확정·완료');
    expect(e.ctx.store.tasks.require(t.id).artifact?.version).toBe(1);
    expect(notices(e, '긴급 지시 전달 못 함')).toEqual([]);
  });
});

describe('대표 메시지를 먼저 전달하려고 끝낸 검수 턴은 재시도로 세지 않는다 (AC-36, 8장 자동 복구 상한)', () => {
  it('검수 턴마다 대표 메시지가 와서 판정을 받지 못하고 세 번 이어 끝나도 검수자 교체 요청(reviewer_assign)을 내지 않고 판정 재촉 횟수도 올리지 않는다 — 네 번째 턴의 판정을 받는다', async () => {
    const e = (env = await bootSessions());
    e.ctx.deps.timing!.questionEndGraceMs = 200;
    const { task } = await startReview(e, e.qaId, { outputMode: 'repo' });
    const rk = reviewKey(task.id);
    for (let i = 1; i <= 3; i++) {
      const p = e.liveProc(rk)!;
      await e.main('instruct_member', { member_id: e.qaId, text: `확인할 것 ${i}: 결제 화면`, urgent: true });
      const r = await e.tool(p.turnId, 'submit_review', { task_id: task.id, ...PASS, criteria: [{ criterion: '문서가 있다', pass: true, note: '확인' }] });
      expect(r.ok).toBe(false);
      await waitFor(() => p.done && !e.core.turns.hasLiveSession(rk), `대표 메시지로 끝난 검수 턴 ${i}`);
      e.tick();
      await waitFor(() => liveCount(e, rk) === 1, `다음 검수 턴 ${i + 1}`);
      expect(launchesOfKey(e, rk).at(-1)!.message).toContain(`확인할 것 ${i}`);
    }
    expect(e.ctx.store.queue.list().filter((q) => q.kind === 'reviewer_assign')).toEqual([]);
    // 판정 재촉 횟수는 deliveries로 센다(리드 결정 30) — attempts는 재촉으로 오르지 않으므로 그것을 보면 아무것도 지키지 않는다 (리드 결정 40)
    const nudges = e.ctx.store.queue.list({ ref2: rk }).filter((q) => q.kind === 'review');
    expect(nudges.map((q) => q.deliveries ?? 0)).toEqual(nudges.map(() => 0));
    const ok = await toolOk(e, e.liveProc(rk)!.turnId, 'submit_review', { task_id: task.id, ...PASS, criteria: [{ criterion: '문서가 있다', pass: true, note: '확인' }] });
    expect([ok.verdict, ok.duplicate]).toEqual(['pass', false]);
  });

  it('긴급 지시로 끝난 검수 턴 세 번은 판정 재촉 예산을 쓰지 않는다 — 그 뒤 판정 없이 끝난 첫 보통 턴은 재촉(deliveries 1)을 받고 검수자 교체 요청은 없다 (리드 결정 40, 프로브 zz-s1fix4-ti-question-nudge-count)', async () => {
    const e = (env = await bootSessions());
    e.ctx.deps.timing!.questionEndGraceMs = 200;
    const { task } = await startReview(e, e.qaId, { outputMode: 'repo' });
    const rk = reviewKey(task.id);
    for (let i = 1; i <= 3; i++) {
      const p = e.liveProc(rk)!;
      await e.main('instruct_member', { member_id: e.qaId, text: `확인할 것 ${i}: 결제 화면`, urgent: true });
      const r = await e.tool(p.turnId, 'submit_review', { task_id: task.id, ...PASS, criteria: [{ criterion: '문서가 있다', pass: true, note: '확인' }] });
      expect(r.ok).toBe(false);
      await waitFor(() => p.done && !e.core.turns.hasLiveSession(rk), `긴급 지시로 끝난 검수 턴 ${i}`);
      e.tick();
      await waitFor(() => liveCount(e, rk) === 1, `다음 검수 턴 ${i + 1}`);
      expect(launchesOfKey(e, rk).at(-1)!.message).toContain(`확인할 것 ${i}`);
    }
    // 네 번째 턴은 질문도 긴급 지시도 없이 판정 없이 끝난다 — 보통 재촉 한 번이고, 검수자 교체로 건너뛰지 않는다
    const p4 = e.liveProc(rk)!;
    p4.finishOk('검토했습니다');
    await waitFor(() => !e.core.turns.hasLiveSession(rk), '네 번째 검수 턴 마무리');
    await sleep(50);
    expect(e.ctx.store.queue.list().filter((q) => q.kind === 'reviewer_assign' && q.taskId === task.id)).toEqual([]);
    const queued = e.ctx.store.queue.list({ ref2: rk, state: 'queued' }).filter((q) => q.kind === 'review');
    expect(queued.map((q) => [q.deliveries ?? 0, q.attempts])).toEqual([[1, 0]]);
    expect(queued[0]!.message).toContain('검수 결과가 아직 등록되지 않았습니다');
  });
});
