/**
 * 대표 직접 메시지 전달 보장 회귀 (AC-36, CLI-10, 15.4 "기존 턴·하위 프로세스 종료 후 같은 업무 세션에 우선 전달", REV-08, CTL-06):
 * - 검수 요청은 먼저 판정한다(CLI-18) — 제출하는 턴 도중이나 검수 중에 온 대표 메시지는 반려되면 재작업 첫 턴에, 통과해도 완료(병합·산출물
 *   확정)하기 전에 작업을 진행으로 돌려(반려 아님) 같은 CLI 세션 다음 턴 맨 앞에 전달한다. 다시 제출한 새 버전을 검수해 완료한다
 * - 저장소 변경형은 병합 판단·병합 직전에도 본다 — main을 바꾸지 않는다. 재시작으로 통과 기록 뒤 끊겨도 복구가 같은 길로 간다
 * - 검수 세션으로 온 대표 메시지가 있으면 판정을 받지 않고 먼저 전달한다 (산출물형은 통과하면 곧바로 완료돼 그 세션이 다시 돌지 않는다)
 * - 남은 까닭(작업 취소·재배정·완료 뒤 도착 등)으로 지우는 대표 메시지는 메시지 기록에 사유를 남기고 대표에게 일반 알림 — 조용히 사라지지 않는다
 * - 메시지 기록의 전달 시각(deliveredAt)은 그 메시지를 실은 턴의 CLI를 띄울 때 적는다 (띄우기 전에 멈추면 전달 대기 그대로)
 * - CLI를 띄우기 전에 끊긴 턴의 대표 메시지는 재시작 복구가 대기열로 되돌린다
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { QueueEntry, Turn } from '@shared/domain';
import { enqueue, reviewKey, taskKey, transitionTask } from '../../src/main/orchestrator/records';
import { artifactWorkDir } from '../../src/main/orchestrator/paths';
import { notices, seedDirective, startReview, waitFor } from './orchHarness';
import { bootSessions, launchesOfKey, liveCount, makeTask, toolOk, turnsOfKey, type SessEnv } from '../acceptance/sessions-helpers';
import {
  bootRestartable,
  seedDirective as seedRestartDirective,
  seedInReviewTask as seedRestartReview,
  waitUntil,
  type RestartableEnv,
} from '../acceptance/stops-helpers';

let env: SessEnv | null = null;
let renv: { v: RestartableEnv } | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
  await renv?.v.close();
  renv = null;
});

const OWNER_FIRST = /^\[욱채 · 작업 · task:T-\d+\] 이번 턴에 전달된 일 \d건\n\n### 1\. 메시지 확인 \(긴급 지시 우선 전달\)\n> 메인 에이전트 긴급 지시/;
const PASS = { verdict: 'pass', criteria: [{ criterion: '동작한다', pass: true, note: '확인' }], reason: '' };
const git = (cwd: string, args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
const ownerMsg = (e: { ctx: SessEnv['ctx'] }, memberId: string, text: string) => e.ctx.store.messages.list({ ref1: memberId }).find((m) => m.text === text)!;
const ownerEntries = (e: { ctx: SessEnv['ctx'] }, key: string) => e.ctx.store.queue.list({ ref2: key }).filter((q) => q.urgent);

describe('검수로 넘어간 작업의 대표 메시지는 완료 전에 같은 세션에 전달된다 (AC-36, REV-08)', () => {
  it('제출하는 턴 도중 온 대표 메시지: 검수는 먼저 하되, 통과해도 완료하지 않고 진행으로 돌려(반려 아님) 같은 CLI 세션 다음 턴 맨 앞에 전달하고, 다시 제출한 새 버전을 검수해 완료한다', async () => {
    const e = (env = await bootSessions());
    const d = seedDirective(e);
    const t = makeTask(e, { directiveId: d.id, assignee: e.devId, title: '사용 안내서', type: 'docs', outputMode: 'artifact' });
    const key = taskKey(t.id);
    const rk = reviewKey(t.id);
    const doc = join(artifactWorkDir(e.ctx.paths, e.projectId, t.id), 'guide.md');
    const text = '안내서 첫 줄에 고객센터 운영 시간을 넣어 주세요';
    e.hold.add(key);
    e.hold.add(rk);
    e.tick();
    await waitFor(() => liveCount(e, key) === 1, '작업 턴');
    const p1 = e.liveProc(key)!;
    await toolOk(e, p1.turnId, 'set_steps', { steps: ['안내서 작성'] });
    writeFileSync(doc, '# 사용 안내\n', 'utf8');
    await toolOk(e, p1.turnId, 'complete_step', { step_index: 0, note: '작성' });
    const sent = await e.main('instruct_member', { member_id: e.devId, text: text, urgent: true });
    expect(sent.note).toBeNull(); // 보통 경우 — 지금 턴이 끝나면 같은 세션에 전달
    await toolOk(e, p1.turnId, 'submit_for_review', { note: '제출' });
    p1.finishOk('제출했습니다');
    // 검수 요청을 먼저 판정한다 (CLI-18) — 검수 중에는 작업 폴더에 턴을 띄우지 않는다 (REV-08)
    await waitFor(() => e.ctx.store.tasks.require(t.id).state === 'in_review', '검수로');
    expect(ownerMsg(e, e.devId, text).deliveredAt).toBeNull();
    e.tick();
    await waitFor(() => liveCount(e, rk) === 1, '검수 턴');
    expect(turnsOfKey(e, key)).toHaveLength(1);
    const rv = e.liveProc(rk)!;
    const res = await toolOk(e, rv.turnId, 'submit_review', { task_id: t.id, ...PASS });
    expect(res.taskState).toBe('in_progress');
    expect(String(res.message)).toContain('진행으로 돌렸습니다');
    rv.finishOk();
    // 통과는 그 버전의 판정으로 남고, 작업은 반려 없이 진행으로 — 산출물은 확정하지 않았다
    const cur = e.ctx.store.tasks.require(t.id);
    expect([cur.state, cur.review.rejectsInRound, cur.review.rejectsTotal, cur.review.target, cur.artifact]).toEqual(['in_progress', 0, 0, null, null]);
    expect(e.ctx.store.transitions.list(t.id).map((x) => x.event).slice(-2)).toEqual(['review_pass', 'reopen']);
    expect(notices(e, '긴급 지시 먼저 전달')).toHaveLength(1);
    await waitFor(() => !e.core.turns.hasLiveSession(rk), '검수 턴 종료');
    // 같은 CLI 세션 이어하기의 맨 앞에 대표 메시지, 그 뒤에 다시 제출 안내
    e.tick();
    await waitFor(() => liveCount(e, key) === 1 && turnsOfKey(e, key).length === 2, '대표 메시지 전달 턴');
    const [l1, l2] = launchesOfKey(e, key);
    expect(l2!.resume).toBe(l1!.newSessionId);
    expect(l2!.message).toMatch(OWNER_FIRST);
    expect(l2!.message).toContain(text);
    expect(l2!.message).toMatch(/### 2\. 작업\n> 검수 중에 긴급 지시가 도착해 완료하기 전에 작업을 진행으로 돌렸습니다/);
    expect(ownerMsg(e, e.devId, text).deliveredAt).not.toBeNull();
    // 반영해 다시 제출 → 새 버전 검수 → 완료
    const p2 = e.liveProc(key)!;
    writeFileSync(doc, '# 사용 안내\n고객센터 운영 시간: 평일 9-18시\n', 'utf8');
    await toolOk(e, p2.turnId, 'submit_for_review', { note: '대표 메시지 반영' });
    p2.finishOk();
    await waitFor(() => e.ctx.store.tasks.require(t.id).state === 'in_review', '다시 검수로');
    e.tick();
    await waitFor(() => liveCount(e, rk) === 1, '재검수 턴');
    const rv2 = e.liveProc(rk)!;
    expect((await toolOk(e, rv2.turnId, 'submit_review', { task_id: t.id, ...PASS })).message).toBe('검수 결과를 등록했습니다.');
    rv2.finishOk();
    await waitFor(() => e.ctx.store.tasks.require(t.id).state === 'done', '완료');
    const fin = e.ctx.store.tasks.require(t.id);
    expect([fin.artifact?.version, fin.review.rejectsTotal]).toEqual([2, 0]);
    expect(e.ctx.store.reviews.list({ ref1: t.id }).map((r) => r.verdict)).toEqual(['pass', 'pass']);
    expect(notices(e, '긴급 지시 전달 못 함')).toEqual([]);
    const detail = await e.invoke('members.getDetail', e.devId);
    expect(detail.messages.find((m) => m.text === text)).toMatchObject({ delivered: true, undelivered: null });
  });

  it('저장소 변경형: 검수 통과 뒤(병합 전) 온 대표 메시지 — 병합 처리가 main을 바꾸기 전에 진행으로 돌려 먼저 전달한다', async () => {
    const e = (env = await bootSessions());
    const d = seedDirective(e);
    const t = makeTask(e, { directiveId: d.id, assignee: e.devId, title: '로그인 화면' });
    const key = taskKey(t.id);
    e.hold.add(key);
    e.tick();
    await waitFor(() => liveCount(e, key) === 1, '작업 턴');
    const p1 = e.liveProc(key)!;
    await toolOk(e, p1.turnId, 'set_steps', { steps: ['구현'] });
    writeFileSync(join(e.ctx.store.tasks.require(t.id).workspace!.worktreePath, 'login.txt'), '로그인\n', 'utf8');
    await toolOk(e, p1.turnId, 'complete_step', { step_index: 0, note: '구현' });
    await toolOk(e, p1.turnId, 'submit_for_review', { note: '제출' });
    p1.finishOk();
    await waitFor(() => e.ctx.store.tasks.require(t.id).state === 'in_review', '검수로');
    const producer = e.ctx.store.members.require(e.producerId);
    expect(e.core.tasks.submitReview(t.id, producer, { verdict: 'pass', criteria: PASS.criteria, reason: '' }, null).reopenedForOwnerMessage).toBeFalsy();
    const mainBefore = git(e.projectDir, ['rev-parse', 'HEAD']);
    const sent = await e.main('instruct_member', { member_id: e.devId, text: '로그인 실패 문구는 한국어로 바꿔 주세요', urgent: true });
    expect(sent.note).toContain('검수 중');
    expect(e.core.merges.requestMerge(t.id, producer, null).status).toBe('queued');
    await waitFor(() => !e.core.merges.isPending(t.id), '병합 처리 끝');
    const cur = e.ctx.store.tasks.require(t.id);
    expect([cur.state, cur.merge, cur.review.rejectsTotal, cur.pendingSubmit]).toEqual(['in_progress', null, 0, null]);
    expect(git(e.projectDir, ['rev-parse', 'HEAD'])).toBe(mainBefore);
    e.tick();
    await waitFor(() => turnsOfKey(e, key).length === 2 && liveCount(e, key) === 1, '대표 메시지 전달 턴');
    expect(launchesOfKey(e, key)[1]!.message).toMatch(OWNER_FIRST);
    expect(launchesOfKey(e, key)[1]!.message).toContain('로그인 실패 문구');
  });

  it('저장소 변경형: 통과 판정 뒤 검수 턴이 끝나기 전에 온 대표 메시지 — 검수 턴 마무리가 병합 판단을 넣지 않고 진행으로 돌린다', async () => {
    const e = (env = await bootSessions());
    const { task, proc } = await startReview(e, e.qaId, { outputMode: 'repo' });
    const key = taskKey(task.id);
    expect((await toolOk(e, proc.turnId, 'submit_review', { task_id: task.id, ...PASS })).taskState).toBe('in_review');
    expect(e.ctx.store.tasks.require(task.id).review.passed).not.toBeNull();
    await e.main('instruct_member', { member_id: e.devId, text: '변경 내역도 정리해 주세요', urgent: true });
    proc.finishOk();
    await waitFor(() => !e.core.turns.hasLiveSession(reviewKey(task.id)), '검수 턴 종료');
    const cur = e.ctx.store.tasks.require(task.id);
    expect([cur.state, cur.review.rejectsTotal, cur.merge]).toEqual(['in_progress', 0, null]);
    expect(e.ctx.store.queue.list({ state: 'queued' }).filter((q) => q.kind === 'merge_decision')).toEqual([]);
    e.hold.add(key);
    e.tick();
    await waitFor(() => liveCount(e, key) === 1, '대표 메시지 전달 턴');
    expect(launchesOfKey(e, key)[0]!.message).toMatch(/### 1\. 메시지 확인 \(긴급 지시 우선 전달\)\n> 메인 에이전트 긴급 지시[^\n]*변경 내역도/);
  });

  it('재시작: 검수 통과를 기록한 뒤 완료하기 전에 끊겨도 대표 메시지가 남아 있으면 복구가 완료하지 않고 진행으로 돌려 같은 업무 세션에 먼저 전달한다', async () => {
    renv = { v: await bootRestartable() };
    let e = renv.v;
    const d = seedRestartDirective(e);
    const t = seedRestartReview(e, { directiveId: d.id, assigneeId: e.devId, reviewerId: e.qaId, title: '안내서' });
    const text = '표지에 날짜를 넣어 주세요';
    expect((await e.main('instruct_member', { member_id: e.devId, text: text, urgent: true })).note).toContain('검수 중');
    // 통과 기록 직후(산출물 확정 전) 전원이 꺼진다
    transitionTask(e.ctx, t.id, { type: 'review_pass', reviewId: 'RV-재시작', reviewerId: e.qaId, target: t.review.target! }, e.qaId);
    e.crash();
    e = renv.v = await e.reboot({ holdAll: true });
    const key = taskKey(t.id);
    await waitUntil(() => !!e.liveProc(key), '재시작 뒤 작업 턴');
    const cur = e.ctx.store.tasks.require(t.id);
    expect([cur.state, cur.artifact, cur.review.rejectsTotal]).toEqual(['in_progress', null, 0]);
    expect(e.ctx.store.transitions.list(t.id).at(-1)?.event).toBe('reopen');
    const launch = e.launchesOf(key)[0]!;
    expect(launch.message).toMatch(/### 1\. 메시지 확인 \(긴급 지시 우선 전달\)\n> 메인 에이전트 긴급 지시[^\n]*표지에 날짜/);
    expect(launch.message).toContain('submit_for_review를 다시 호출하세요');
    expect(ownerMsg(e, e.devId, text).deliveredAt).not.toBeNull();
  });
});

describe('검수 세션으로 온 대표 메시지는 판정보다 먼저 전달된다 (CLI-10, CTL-06)', () => {
  it('검수 턴 도중 검수자에게 대표 메시지가 오면 그 턴의 판정은 받지 않고 프로그램이 턴을 마친다 — 다음 검수 턴 맨 앞에 전달한 뒤 판정을 받는다', async () => {
    const e = (env = await bootSessions());
    e.ctx.deps.timing!.questionEndGraceMs = 300;
    const { task, proc } = await startReview(e, e.qaId, { outputMode: 'repo' });
    const rk = reviewKey(task.id);
    const text = '결제 화면까지 확인해 주세요';
    const sent = await e.main('instruct_member', { member_id: e.qaId, text: text, urgent: true });
    expect(sent.sessionKey).toBe(rk);
    expect(sent.note).toContain('판정은 지시를 확인한 뒤');
    const refused = await e.tool(proc.turnId, 'submit_review', { task_id: task.id, ...PASS });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.code).toBe('conflict');
      expect(refused.message).toContain('긴급 지시');
    }
    expect(e.ctx.store.reviews.list({ ref1: task.id })).toEqual([]);
    expect(e.ctx.store.tasks.require(task.id).review.passed).toBeNull();
    // CLI가 턴을 끝내지 않아도 프로그램이 끝낸다 (정상 종료로 판정 — 판정 재촉과 함께 다시 넣는다)
    await waitFor(() => proc.done && !e.core.turns.hasLiveSession(rk), '프로그램이 검수 턴을 마침');
    expect(turnsOfKey(e, rk)[0]!.endReason).toBe('completed');
    e.tick();
    await waitFor(() => liveCount(e, rk) === 1, '다음 검수 턴');
    const l2 = launchesOfKey(e, rk)[1]!;
    expect(l2.resume).toBe(launchesOfKey(e, rk)[0]!.newSessionId);
    expect(l2.message).toMatch(/^\[욱채 · 검수 · review:T-\d+\] 이번 턴에 전달된 일 2건\n\n### 1\. 메시지 확인 \(긴급 지시 우선 전달\)\n> 메인 에이전트 긴급 지시[^\n]*결제 화면까지/);
    expect(ownerMsg(e, e.qaId, text).deliveredAt).not.toBeNull();
    const ok = await toolOk(e, e.liveProc(rk)!.turnId, 'submit_review', { task_id: task.id, ...PASS });
    expect(ok.verdict).toBe('pass');
    expect(e.ctx.store.tasks.require(task.id).review.passed).not.toBeNull();
  });

  it('검수 기준이 바뀌어 진행으로 돌아가도 검수자에게 온 대표 메시지는 지우지 않고, 다시 제출한 버전의 검수 턴 맨 앞에 전달한다', async () => {
    const e = (env = await bootSessions());
    const { task, proc } = await startReview(e, e.qaId, { outputMode: 'repo' });
    const rk = reviewKey(task.id);
    const key = taskKey(task.id);
    await e.main('instruct_member', { member_id: e.qaId, text: '접근성 항목도 꼭 확인해 주세요', urgent: true });
    e.core.tasks.update(task.id, { acceptanceCriteria: ['문서가 있다', '접근성 점검'] }, e.producerId);
    await waitFor(() => proc.done && !e.core.turns.hasLiveSession(rk), '검수 턴 종료');
    expect(e.ctx.store.tasks.require(task.id).state).toBe('in_progress');
    expect(ownerEntries(e, rk).map((q) => q.state)).toEqual(['queued']);
    expect(e.ctx.store.queue.list({ ref2: rk, state: 'queued' }).filter((q) => !q.urgent)).toEqual([]);
    expect(notices(e, '긴급 지시 전달 못 함')).toEqual([]);
    // 담당이 바뀐 기준으로 다시 제출 → 새 버전 고정 → 같은 검수 세션 키의 검수 턴 맨 앞에 대표 메시지
    e.hold.add(key);
    e.tick();
    await waitFor(() => liveCount(e, key) === 1, '작업 턴');
    const p = e.liveProc(key)!;
    await toolOk(e, p.turnId, 'set_steps', { steps: ['접근성 점검'] });
    await toolOk(e, p.turnId, 'complete_step', { step_index: 0, note: '확인' });
    await toolOk(e, p.turnId, 'submit_for_review', { note: '바뀐 기준으로 다시 제출' });
    p.finishOk();
    await waitFor(() => e.ctx.store.tasks.require(task.id).state === 'in_review', '다시 검수로');
    e.tick();
    await waitFor(() => liveCount(e, rk) === 1, '새 버전 검수 턴');
    expect(launchesOfKey(e, rk).at(-1)!.message).toMatch(/### 1\. 메시지 확인 \(긴급 지시 우선 전달\)\n> 메인 에이전트 긴급 지시[^\n]*접근성 항목도/);
    expect(ownerMsg(e, e.qaId, '접근성 항목도 꼭 확인해 주세요').deliveredAt).not.toBeNull();
  });
});

describe('남은 까닭으로 지우는 대표 메시지는 알린다 (AC-36: 조용히 사라지지 않음)', () => {
  it('작업 취소·재배정으로 지우는 대표 메시지는 메시지 기록에 사유를 남기고 일반 알림 — 프로듀서 지시 세션으로 간 대표 메시지는 그 작업 취소로 지우지 않는다', async () => {
    const e = (env = await bootSessions());
    const d = seedDirective(e);
    const t1 = makeTask(e, { directiveId: d.id, assignee: e.devId, title: '취소될 작업' });
    const k1 = taskKey(t1.id);
    const dk = `directive:${d.id}`;
    e.hold.add(k1);
    e.hold.add(dk);
    e.tick();
    await waitFor(() => liveCount(e, k1) === 1, '작업 턴');
    // 프로듀서는 그 작업 일(병합 판단 등)로 지시 관리 턴을 돌고 있다 — 이때 프로듀서에게 온 대표 메시지는 지시 세션으로 간다
    enqueue(e.ctx, { kind: 'merge_decision', memberId: e.producerId, sessionKey: dk, projectId: e.projectId, taskId: t1.id, directiveId: d.id, message: '병합 판단' });
    e.tick();
    await waitFor(() => liveCount(e, dk) === 1, '프로듀서 지시 관리 턴');
    await e.main('instruct_member', { member_id: e.devId, text: '취소 전 메시지', urgent: true });
    await e.main('instruct_member', { member_id: e.producerId, text: '이번 지시는 접근성을 먼저 봐 주세요', urgent: true });
    expect(ownerEntries(e, dk).map((q) => [q.taskId, q.state])).toEqual([[t1.id, 'queued']]);
    await e.main('cancel_task', { task_id: t1.id });
    expect(e.ctx.store.tasks.require(t1.id).state).toBe('cancelled');
    // 개발자에게 온 대표 메시지: 지우되 사유를 남기고 알린다
    expect(ownerEntries(e, k1).map((q) => q.state)).toEqual(['cancelled']);
    const m1 = ownerMsg(e, e.devId, '취소 전 메시지');
    expect(m1.deliveredAt).toBeNull();
    expect(m1.undeliveredReason).toContain(`${t1.id}이(가) 취소됨`);
    const n1 = notices(e, '긴급 지시 전달 못 함');
    expect(n1).toHaveLength(1);
    expect(n1[0]!.level).toBe('normal');
    expect(n1[0]!.body).toContain('취소 전 메시지');
    expect(n1[0]!.link).toMatchObject({ tab: 'projects', memberId: e.devId });
    const detail = await e.invoke('members.getDetail', e.devId);
    expect(detail.messages.find((m) => m.text === '취소 전 메시지')).toMatchObject({ delivered: false, undelivered: m1.undeliveredReason });
    expect(e.ctx.store.activity.search({ text: '긴급 지시를 전달하지 못함' })).toHaveLength(1);
    // 프로듀서 지시 세션으로 간 대표 메시지는 그 세션이 계속 돌므로 남는다
    expect(ownerEntries(e, dk).map((q) => q.state)).toEqual(['queued']);

    // 재배정: 이전 담당의 업무 세션으로 온 대표 메시지는 새 담당에게 넘기지 않고(AC-40) 알린다
    const t2 = makeTask(e, { directiveId: d.id, assignee: e.devId, title: '재배정될 작업' });
    const k2 = taskKey(t2.id);
    e.hold.add(k2);
    e.tick();
    await waitFor(() => liveCount(e, k2) === 1, '둘째 작업 턴');
    await e.main('instruct_member', { member_id: e.devId, text: '재배정 전 메시지', urgent: true });
    e.core.tasks.reassign(t2.id, e.qaId, e.producerId);
    expect(ownerEntries(e, k2).map((q) => q.state)).toEqual(['cancelled']);
    expect(ownerMsg(e, e.devId, '재배정 전 메시지').undeliveredReason).toContain('재배정');
    const bodies = notices(e, '긴급 지시 전달 못 함').map((n) => n.body);
    expect(bodies).toHaveLength(2);
    expect(bodies.filter((b) => b.includes('재배정 전 메시지'))).toHaveLength(1);
  });

  it('끝난 작업의 세션에 남은 대표 메시지(산출물 확정 직후 아직 끝나지 않은 검수 턴으로 온 것)는 스케줄러가 지우고 알린다 — 전달 대기로 영영 남지 않는다', async () => {
    const e = (env = await bootSessions());
    const d = seedDirective(e);
    const t = makeTask(e, { directiveId: d.id, assignee: e.devId, title: '안내서', type: 'docs', outputMode: 'artifact' });
    const key = taskKey(t.id);
    const rk = reviewKey(t.id);
    e.hold.add(key);
    e.hold.add(rk);
    e.tick();
    await waitFor(() => liveCount(e, key) === 1, '작업 턴');
    const p1 = e.liveProc(key)!;
    await toolOk(e, p1.turnId, 'set_steps', { steps: ['작성'] });
    writeFileSync(join(artifactWorkDir(e.ctx.paths, e.projectId, t.id), 'guide.md'), '# 안내\n', 'utf8');
    await toolOk(e, p1.turnId, 'complete_step', { step_index: 0, note: '작성' });
    await toolOk(e, p1.turnId, 'submit_for_review', { note: '제출' });
    p1.finishOk();
    await waitFor(() => e.ctx.store.tasks.require(t.id).state === 'in_review', '검수로');
    e.tick();
    await waitFor(() => liveCount(e, rk) === 1, '검수 턴');
    const rv = e.liveProc(rk)!;
    await toolOk(e, rv.turnId, 'submit_review', { task_id: t.id, ...PASS });
    // 확정·보관과 완료 정리(작업 폴더 정리 뒤 남은 업무 정리)까지 끝난 뒤
    await waitFor(() => e.ctx.store.activity.search({ taskId: t.id, text: '확정·보관' }).length > 0, '산출물 확정·완료 정리');
    expect(e.ctx.store.tasks.require(t.id).state).toBe('done');
    // 검수 턴은 아직 살아 있다 — 그 검수자에게 온 대표 메시지는 그 검수 세션으로 간다
    const sent = await e.main('instruct_member', { member_id: e.producerId, text: '안내서 고생했어요', urgent: true });
    expect(sent.sessionKey).toBe(rk);
    expect(sent.note).toContain('완료');
    rv.finishOk();
    await waitFor(() => !e.core.turns.hasLiveSession(rk), '검수 턴 종료');
    expect(ownerEntries(e, rk).map((q) => q.state)).toEqual(['queued']);
    e.tick();
    await waitFor(() => ownerEntries(e, rk).every((q) => q.state === 'cancelled'), '끝난 작업 세션의 대표 메시지 정리');
    expect(e.ctx.store.activity.search({ taskId: t.id, text: '완료 뒤 남은 업무' })).toHaveLength(1);
    expect(ownerMsg(e, e.producerId, '안내서 고생했어요').undeliveredReason).toContain('이미 완료');
    expect(notices(e, '긴급 지시 전달 못 함').map((n) => n.body)).toEqual([expect.stringContaining('안내서 고생했어요')]);
  });
});

describe('메시지 기록의 전달 시각 (AC-36: 전달됨·전달 대기가 사실과 맞게)', () => {
  it('그 메시지를 실은 턴의 CLI를 띄울 때 전달됨으로 적는다 — 띄우기 전에 실패하면 전달 대기로 남고 대기열에 그대로 있다. 다른 일은 대표 메시지 항목에 합치지 않는다', async () => {
    const e = (env = await bootSessions());
    const d = seedDirective(e);
    const t = makeTask(e, { directiveId: d.id, assignee: e.devId });
    const key = taskKey(t.id);
    e.hold.add(key);
    e.tick();
    await waitFor(() => liveCount(e, key) === 1, '첫 턴');
    const text = '오류 문구를 먼저 정리해 주세요';
    await e.main('instruct_member', { member_id: e.devId, text: text, urgent: true });
    // 같은 세션의 같은 종류 일(dedupe)은 대표 메시지 항목에 합치지 않는다 — 합치면 '대표 우선 전달'로 보인다
    enqueue(e.ctx, { kind: 'message', memberId: e.devId, sessionKey: key, projectId: e.projectId, taskId: t.id, message: '프로그램 안내', dedupeKind: true });
    const queued = e.ctx.store.queue.list({ ref2: key, state: 'queued' }).filter((q) => q.kind === 'message');
    expect(queued.map((q) => [q.urgent, q.message.includes('프로그램 안내')])).toEqual([
      [true, false],
      [false, true],
    ]);
    const owner = queued.find((q) => q.urgent)!;
    expect(owner.messageId).toBe(ownerMsg(e, e.devId, text).id);
    // 다음 턴은 프로세스를 띄우기 전에 실패한다 (실행 값 검사 실패 흉내)
    e.prepareHook = (_launch, who) => {
      if (who.sessionKey === key) throw new Error('실행 값 검사 실패 흉내');
    };
    e.liveProc(key)!.finishOk();
    await waitFor(() => !e.core.turns.hasLiveSession(key), '첫 턴 종료');
    e.tick();
    await waitFor(() => turnsOfKey(e, key).length === 2 && !e.core.turns.hasLiveSession(key), '띄우기 전 실패한 턴');
    expect(turnsOfKey(e, key)[1]!.endReason).toBe('spawn_failed');
    expect(ownerMsg(e, e.devId, text).deliveredAt).toBeNull();
    expect(e.ctx.store.queue.get(owner.id)).toMatchObject({ state: 'queued', attempts: 0, startFails: 1 });
    // 원인을 고치면 다음 턴이 띄워지며 전달된다
    e.prepareHook = null;
    e.tick();
    await waitFor(() => turnsOfKey(e, key).length === 3 && liveCount(e, key) === 1, '셋째 턴');
    expect(launchesOfKey(e, key).at(-1)!.message).toMatch(OWNER_FIRST);
    expect(ownerMsg(e, e.devId, text).deliveredAt).not.toBeNull();
    const detail = await e.invoke('members.getDetail', e.devId);
    expect(detail.messages.find((m) => m.text === text)).toMatchObject({ delivered: true });
  });

  it('재시작: CLI를 띄우기 전에 끊긴 작업 턴의 대표 메시지는 대기열로 되돌려 재시작 안내와 함께 같은 세션에 먼저 전달한다', async () => {
    renv = { v: await bootRestartable() };
    let e = renv.v;
    const d = seedRestartDirective(e);
    const t = e.core.tasks.create(
      { directiveId: d.id, title: '결제 화면', goal: '화면', type: 'development', assigneeId: e.devId, acceptanceCriteria: ['동작'], outputMode: 'repo' },
      e.producerId,
    );
    const key = taskKey(t.id);
    e.hold.add(key);
    e.tick();
    await waitUntil(() => !!e.liveProc(key), '첫 턴');
    const p1 = e.liveProc(key)!;
    expect((await e.tool(p1.turnId, 'set_steps', { steps: ['화면', '테스트'] })).ok).toBe(true);
    p1.finishOk();
    await waitUntil(() => !e.core.turns.hasLiveSession(key) && e.ctx.store.queue.list({ ref2: key, state: 'queued' }).length === 1, '첫 턴 종료 → 계속 안내');
    const text = '결제 버튼 문구도 바꿔 주세요';
    await e.main('instruct_member', { member_id: e.devId, text: text, urgent: true });
    // 둘째 턴이 기록됐지만(항목 실행 중) CLI를 띄우기 전에 전원이 꺼진다
    const queued = e.ctx.store.queue.list({ ref2: key, state: 'queued' });
    const first = e.ctx.store.turns.list({ ref1: e.devId })[0]!;
    const turnId = e.ctx.store.nextId('turn');
    const now = e.ctx.now();
    const cut: Turn = {
      ...first,
      id: turnId,
      queueEntryIds: queued.map((q) => q.id),
      isResume: true,
      startedAt: now,
      endedAt: null,
      lastActivityAt: now,
      process: { state: 'starting', pid: null, spawnedAt: null, exitCode: null, stopRequestedAt: null, stopMode: null, killDetail: null },
      endReason: null,
      endDetail: '',
      stepsCompleted: 0,
      toolCalls: 0,
      usage: null,
      eventCount: 0,
      finalText: null,
    };
    e.ctx.store.tx(() => {
      e.ctx.store.turns.insert(cut);
      for (const q of queued) e.ctx.store.queue.put({ ...q, state: 'running', turnId } satisfies QueueEntry);
    });
    e.crash();
    e = renv.v = await e.reboot({ holdAll: true });
    expect(e.ctx.store.turns.get(turnId)?.endReason).toBe('app_restart');
    await waitUntil(() => !!e.liveProc(key), '재시작 뒤 작업 턴');
    const launch = e.launchesOf(key)[0]!;
    expect(launch.message).toMatch(OWNER_FIRST);
    expect(launch.message).toContain(text);
    expect(launch.message).toContain('앱이 다시 시작되어 이어서 진행합니다');
    expect(ownerMsg(e, e.devId, text).deliveredAt).not.toBeNull();
  });
});
