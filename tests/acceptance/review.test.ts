/**
 * 완료 기준(17장) 검수 그룹: AC-09 · AC-38 · AC-39 · AC-43 · AC-47.
 * 기획서 5.3(상태표·전이표), 5.6(REV-01~08), 7장(GIT-05·06·14), 7.1(병합 세부 규칙), 15.3(역할별 앱 도구, CLI-08)이 판정 기준이다.
 *
 * 세 층으로 확인한다.
 * - boot (tests/regression/helpers): 서비스 + 실제 SQLite·git. 반려 횟수·검수자 선택·병합 확인·산출물 보관을 정확히 몬다.
 * - bootOrch (tests/regression/orchHarness): 실제 오케스트레이터(스케줄러·턴 실행기·도구 처리기) + 가짜 CLI. 실제 검수 턴의 신원으로 도구 경계를 확인한다.
 * - createHarness (tests/e2e/harness): 실제 앱 도구 서버(HTTP) + 실제 모의 에이전트 프로세스로 처음부터 보고까지.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { MAIN_AGENT_ID } from '@shared/domain';
import { REJECT_LIMIT } from '@core/taskMachine';
import { TOOL_SPECS, rolesFor } from '../../src/main/mcp/catalog';
import { BackendError } from '../../src/main/backend/types';
import { artifactVersionDir } from '../../src/main/orchestrator/paths';
import type { Env } from '../regression/helpers';
import {
  activate,
  boot,
  commitOnMain,
  git,
  mainSha,
  mergeAndSettle,
  mergeCommitsFor,
  newDirective,
  newTask,
  notices,
  pass,
  passedTask,
  reject,
  sleep,
  submittedTask,
  waitFor,
} from '../regression/helpers';
import type { OrchEnv } from '../regression/orchHarness';
import { bootOrch, seedDirective, waitFor as waitOrch } from '../regression/orchHarness';
import { createHarness, sendCommand, type Harness } from '../e2e/harness';
import {
  callTool,
  consumeQueued,
  execKinds,
  gitIn,
  identityOf,
  member,
  orchRepoTaskInReview,
  queuedFor,
  reviewsOf,
  task,
  verdictArgs,
  workAndSubmit,
  writeArtifact,
} from './review-helpers';

let env: Env | null = null;
let oenv: OrchEnv | null = null;
const cleanups: (() => void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) c();
  await env?.close();
  env = null;
  await oenv?.close();
  oenv = null;
});

const sha256 = (s: string) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
const transitionsOf = (e: Env | OrchEnv, id: string) => e.ctx.store.transitions.list(id);
const reviewKeyOf = (id: string) => `review:${id}`;
const errOf = async (p: () => unknown): Promise<BackendError> => {
  try {
    await p();
  } catch (x) {
    if (x instanceof BackendError) return x;
    throw x;
  }
  throw new Error('거부되지 않았습니다');
};

// ═════════════════════════════════════════════════════════════════════════════════════════════
// AC-09: 작업자는 자기 작업을 검수할 수 없고, 현재 검수 차수의 3번째 반려는 검수 → 보류로 전환된다. 재계획해도 누적 반려 이력은 유지된다
// (REV-02·03·04, 5.3 전이표 '검수 작업 | 현재 차수의 3번째 반려 → 보류(재계획)')
// ═════════════════════════════════════════════════════════════════════════════════════════════
describe('AC-09 본인 검수 금지 · 3번째 반려 보류 · 누적 반려 이력', () => {
  it('AC-09 작업자는 자기 작업의 검수자로 지정될 수 없다 — create_task·update_task·assign_reviewer 모두 거부', async () => {
    env = await boot({ team: ['qa'] });
    const e = env;
    const qa = e.members[0]!; // 검수 권한이 있는 역할이라도 자기 작업은 안 된다
    const d = newDirective(e);
    const pd = identityOf(e, e.producer, `directive:${d}`);
    const before = e.ctx.store.tasks.list().length;
    const bad = await callTool(e, pd, 'create_task', {
      directive_id: d,
      title: 'QA 자기 검수 시도',
      goal: '목표',
      type: 'test',
      assignee_id: qa.id,
      reviewer_id: qa.id,
      acceptance_criteria: ['테스트가 있다'],
      output_mode: 'repo',
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.code).toBe('forbidden');
      expect(bad.message).toContain('작업자');
    }
    expect(e.ctx.store.tasks.list()).toHaveLength(before);

    const ok = await callTool(e, pd, 'create_task', { directive_id: d, title: 'QA 작업', goal: '목표', type: 'test', assignee_id: qa.id, acceptance_criteria: ['테스트가 있다'], output_mode: 'repo' });
    expect(ok.ok).toBe(true);
    const id = (ok.ok ? (ok.data as { taskId: string }).taskId : '') as string;
    expect(task(e, id).reviewerId).toBe(e.producer.id);
    for (const [tool, args] of [
      ['update_task', { task_id: id, reviewer_id: qa.id }],
      ['assign_reviewer', { task_id: id, reviewer_id: qa.id }],
    ] as const) {
      const r = await callTool(e, pd, tool, args);
      expect(r.ok, tool).toBe(false);
      if (!r.ok) expect(r.code).toBe('forbidden');
    }
    expect(task(e, id).reviewerId).toBe(e.producer.id);
  });

  it('AC-09 작업자는 검수 단계에서 자기 작업에 통과·반려를 등록할 수 없다 (저장된 검수자가 작업자로 잘못 남아 있어도)', async () => {
    env = await boot({ team: ['qa'] });
    const e = env;
    const qa = e.members[0]!;
    const t = await submittedTask(e, { assignee: qa, type: 'test' });
    expect(t.reviewerId).toBe(e.producer.id);
    const self = identityOf(e, qa, reviewKeyOf(t.id));
    for (const verdict of ['pass', 'reject'] as const) {
      const r = await callTool(e, self, 'submit_review', verdictArgs(t, verdict));
      expect(r.ok, verdict).toBe(false);
      if (!r.ok) expect(r.code).toBe('forbidden');
    }
    // 이전 기록·잘못된 저장으로 검수자 칸이 작업자 본인이어도 '작업자' 검사로 다시 막힌다 (CLI-08)
    e.ctx.store.tasks.patch(t.id, { reviewerId: qa.id });
    const forged = await callTool(e, self, 'submit_review', verdictArgs(task(e, t.id), 'pass'));
    expect(forged.ok).toBe(false);
    if (!forged.ok) expect(forged.message).toContain('작업자');
    const target = await callTool(e, self, 'get_review_target', { task_id: t.id });
    expect(target.ok).toBe(false);
    expect(reviewsOf(e, t.id)).toHaveLength(0);
    expect(task(e, t.id).state).toBe('in_review');
    expect(task(e, t.id).review.passed).toBeNull();
  });

  it('AC-09 검수자 칸이 작업자로 잘못 남아 있어도 검수 업무는 작업자가 아닌 적격 검수자에게 간다', async () => {
    env = await boot({ team: ['qa'] });
    const e = env;
    const qa = e.members[0]!;
    const t = newTask(e, { assignee: qa, type: 'test' });
    await activate(e, t.id);
    e.ctx.store.tasks.patch(t.id, { reviewerId: qa.id }); // 잘못 남은 값
    const cur = await workAndSubmit(e, t.id, { label: '테스트 작성' });
    expect(cur.state).toBe('in_review');
    expect(cur.reviewerId).toBe(e.producer.id);
    expect(queuedFor(e, (q) => q.sessionKey === reviewKeyOf(t.id)).map((q) => q.memberId)).toEqual([e.producer.id]);
  });

  it('AC-09 재배정 전 작업자(실질 수정 참여자)도 그 작업을 검수할 수 없다', async () => {
    env = await boot({ team: ['qa', 'developer'] });
    const e = env;
    const [qa, dev] = e.members as [typeof e.members[0], typeof e.members[0]];
    const t = await activate(e, newTask(e, { assignee: qa, type: 'test' }).id);
    e.core.tasks.reassign(t.id, dev!.id, e.producer.id);
    expect(task(e, t.id).contributors).toEqual(expect.arrayContaining([qa!.id, dev!.id]));
    const pd = identityOf(e, e.producer, `directive:${t.directiveId}`);
    const r = await callTool(e, pd, 'assign_reviewer', { task_id: t.id, reviewer_id: qa!.id });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('실질 수정 참여자');
  });

  it(`AC-09 현재 검수 차수의 1·2번째 반려는 진행, ${REJECT_LIMIT}번째 반려는 검수 → 보류(재계획)로 전환된다`, async () => {
    env = await boot({ team: ['developer', 'qa'] });
    const e = env;
    const [dev, qa] = e.members;
    let t = await submittedTask(e, { assignee: dev, reviewer: qa!.id });
    const reviewer = identityOf(e, qa!, reviewKeyOf(t.id));
    for (let i = 1; i <= REJECT_LIMIT; i++) {
      expect(t.state).toBe('in_review');
      const r = await callTool(e, reviewer, 'submit_review', verdictArgs(t, 'reject', `${i}번째 반려 사유`));
      expect(r.ok, `${i}번째 반려`).toBe(true);
      t = task(e, t.id);
      expect(t.review.rejectsInRound).toBe(i);
      expect(t.review.rejectsTotal).toBe(i);
      if (i < REJECT_LIMIT) {
        expect(t.state).toBe('in_progress');
        // 사유와 함께 작업자에게 수정 업무가 간다
        const work = queuedFor(e, (q) => q.kind === 'task_work' && q.taskId === t.id);
        expect(work.map((q) => q.memberId)).toEqual([dev!.id]);
        expect(work[0]!.message).toContain(`${i}번째 반려 사유`);
        expect(work[0]!.message).toContain(`${i}/${REJECT_LIMIT}`);
        consumeQueued(e, `task:${t.id}`);
        t = await workAndSubmit(e, t.id, { label: `반려 ${i} 반영` });
      }
    }
    expect(t.state).toBe('on_hold');
    expect(t.hold.reasons.map((r) => r.kind)).toEqual(['replan']);
    expect(t.hold.returnState).toBe('in_progress');
    const last = transitionsOf(e, t.id).at(-1)!;
    expect(last).toMatchObject({ from: 'in_review', event: 'reject', to: 'on_hold' });
    expect(transitionsOf(e, t.id).filter((x) => x.event === 'reject').map((x) => x.to)).toEqual(['in_progress', 'in_progress', 'on_hold']);
    // 프로듀서에게 재계획 업무 + 일반 알림 (8장 반복 반려)
    expect(queuedFor(e, (q) => q.kind === 'replan' && q.taskId === t.id).map((q) => q.memberId)).toEqual([e.producer.id]);
    const n = notices(e, '반복 반려');
    expect(n).toHaveLength(1);
    expect(n[0]!.level).toBe('normal');
    // 보류 중에는 작업자 턴을 다시 띄울 일이 없다 — 일반 해제(대표 재개)로 재계획 사유를 풀 수 없다
    await expect(Promise.resolve().then(() => e.core.tasks.resumeByOwner(t.id))).rejects.toBeInstanceOf(BackendError);
  });

  it('AC-09 같은 반려 요청의 재전송(같은 request_id)은 반려 횟수에 두 번 세지 않는다 (REV-04)', async () => {
    env = await boot({ team: ['developer', 'qa'] });
    const e = env;
    const [dev, qa] = e.members;
    const t = await submittedTask(e, { assignee: dev, reviewer: qa!.id });
    const reviewer = identityOf(e, qa!, reviewKeyOf(t.id));
    const args = verdictArgs(t, 'reject', '재전송 시험', 'rq-reject-1');
    const [a, b] = await Promise.all([callTool(e, reviewer, 'submit_review', args), callTool(e, reviewer, 'submit_review', args)]);
    const c = await callTool(e, reviewer, 'submit_review', args);
    expect([a.ok, b.ok, c.ok]).toEqual([true, true, true]);
    expect(task(e, t.id).review).toMatchObject({ rejectsInRound: 1, rejectsTotal: 1 });
    expect(reviewsOf(e, t.id)).toHaveLength(1);
    expect(task(e, t.id).state).toBe('in_progress');
  });

  it('AC-09 재계획하면 새 검수 차수에서 차수 반려만 0으로 시작하고, 누적 반려 횟수·이전 판정 기록은 유지된다 (다음 차수도 3번째에 다시 보류)', async () => {
    env = await boot({ team: ['developer', 'qa'] });
    const e = env;
    const [dev, qa] = e.members;
    let t = await submittedTask(e, { assignee: dev, reviewer: qa!.id });
    const reviewer = identityOf(e, qa!, reviewKeyOf(t.id));
    const rejectRound = async (round: number) => {
      for (let i = 1; i <= REJECT_LIMIT; i++) {
        const r = await callTool(e, reviewer, 'submit_review', verdictArgs(task(e, t.id), 'reject', `${round}차 ${i}번째`));
        expect(r.ok).toBe(true);
        if (i < REJECT_LIMIT) {
          consumeQueued(e, `task:${t.id}`);
          await workAndSubmit(e, t.id, { label: `${round}차 반려 ${i} 반영` });
        }
      }
      expect(task(e, t.id).state).toBe('on_hold');
    };
    await rejectRound(1);

    const pd = identityOf(e, e.producer, `directive:${t.directiveId}`);
    const rp = await callTool(e, pd, 'replan_task', { task_id: t.id, note: '방법을 바꿔 다시 진행' });
    expect(rp.ok).toBe(true);
    t = task(e, t.id);
    expect(t.state).toBe('in_progress');
    expect(t.review).toMatchObject({ round: 2, rejectsInRound: 0, rejectsTotal: REJECT_LIMIT });
    // 대표 화면(작업 상세)과 검수자 도구에 이전 차수 판정이 그대로 보인다
    const detail = await e.core.views.taskDetail(t.id);
    expect(detail.task.review).toMatchObject({ round: 2, rejectsInRound: 0, rejectsTotal: REJECT_LIMIT });
    expect(detail.reviews.map((r) => `${r.reviewRound}:${r.verdict}`)).toEqual(['1:reject', '1:reject', '1:reject']);

    // 새 차수의 첫 반려는 진행으로 (보류 아님), 누적은 계속 쌓인다
    consumeQueued(e, `task:${t.id}`);
    await workAndSubmit(e, t.id, { label: '재계획 반영' });
    const info = await callTool(e, reviewer, 'get_review_target', { task_id: t.id });
    expect(info.ok).toBe(true);
    if (info.ok) {
      const d = info.data as { reviewRound: number; rejectsInRound: number; previousReviews: { round: number; verdict: string }[] };
      expect(d.reviewRound).toBe(2);
      expect(d.rejectsInRound).toBe(0);
      expect(d.previousReviews.map((r) => `${r.round}:${r.verdict}`)).toEqual(['1:reject', '1:reject', '1:reject']);
    }
    const r1 = await callTool(e, reviewer, 'submit_review', verdictArgs(task(e, t.id), 'reject', '2차 1번째'));
    expect(r1.ok).toBe(true);
    t = task(e, t.id);
    expect(t.state).toBe('in_progress');
    expect(t.review).toMatchObject({ round: 2, rejectsInRound: 1, rejectsTotal: REJECT_LIMIT + 1 });

    // 2차에서 남은 두 번을 더 반려하면 다시 보류
    consumeQueued(e, `task:${t.id}`);
    await workAndSubmit(e, t.id, { label: '2차 반려 1 반영' });
    for (let i = 2; i <= REJECT_LIMIT; i++) {
      const r = await callTool(e, reviewer, 'submit_review', verdictArgs(task(e, t.id), 'reject', `2차 ${i}번째`));
      expect(r.ok).toBe(true);
      if (i < REJECT_LIMIT) {
        consumeQueued(e, `task:${t.id}`);
        await workAndSubmit(e, t.id, { label: `2차 반려 ${i} 반영` });
      }
    }
    t = task(e, t.id);
    expect(t.state).toBe('on_hold');
    expect(t.review).toMatchObject({ round: 2, rejectsInRound: REJECT_LIMIT, rejectsTotal: 2 * REJECT_LIMIT });

    // 다시 재계획 → 3차 통과. 누적 반려와 이전 기록 6건은 남는다
    expect((await callTool(e, pd, 'replan_task', { task_id: t.id, note: '담당 방식 재조정' })).ok).toBe(true);
    consumeQueued(e, `task:${t.id}`);
    await workAndSubmit(e, t.id, { label: '3차 작업' });
    expect((await callTool(e, reviewer, 'submit_review', verdictArgs(task(e, t.id), 'pass'))).ok).toBe(true);
    t = task(e, t.id);
    expect(t.review.round).toBe(3);
    expect(t.review.rejectsTotal).toBe(2 * REJECT_LIMIT);
    expect(t.review.passed?.reviewerId).toBe(qa!.id);
    expect(reviewsOf(e, t.id).map((r) => `${r.reviewRound}:${r.verdict}`)).toEqual(['1:reject', '1:reject', '1:reject', '2:reject', '2:reject', '2:reject', '3:pass']);
  });

  it('AC-09 (모의 팀 전체 흐름) 1차 검수에서 3번 반려 → 보류(재계획) → 프로듀서 재계획 → 2차 통과·병합, 누적 반려 이력 유지', async () => {
    const h = await createHarness({ team: ['developer'], scenarios: { producer: 'triple_reject' } });
    try {
      const did = await sendCommand(h, '로그인 화면을 만들어 줘');
      await h.waitFor(() => h.core.ctx.store.directives.get(did)?.state === 'awaiting_confirmation', { timeoutMs: 90_000, label: '보고 도착' });
      const [t] = h.core.ctx.store.tasks.list({ ref1: did });
      expect(t).toBeDefined();
      expect(t!.assigneeId).toBe(h.members.developer);
      expect(t!.state).toBe('done');
      expect(t!.merge?.mergeCommitSha).toMatch(/^[0-9a-f]{40}$/);
      expect(t!.review).toMatchObject({ round: 2, rejectsInRound: 0, rejectsTotal: 3 });
      const detail = await h.invoke('tasks.get', t!.id);
      expect(detail.reviews.map((r) => `${r.reviewRound}:${r.verdict}`)).toEqual(['1:reject', '1:reject', '1:reject', '2:pass']);
      // 판정은 모두 작업자가 아닌 검수자(프로듀서)가 했다
      expect(new Set(detail.reviews.map((r) => r.reviewerId))).toEqual(new Set([h.members.producer]));
      const tr = h.core.ctx.store.transitions.list(t!.id);
      expect(tr.filter((x) => x.event === 'reject').map((x) => `${x.from}>${x.to}`)).toEqual(['in_review>in_progress', 'in_review>in_progress', 'in_review>on_hold']);
      expect(tr.filter((x) => x.event === 'replanned').map((x) => `${x.from}>${x.to}:${x.actor}`)).toEqual([`on_hold>in_progress:${h.members.producer}`]);
      expect(h.core.ctx.store.notifications.list().filter((n) => n.title === '반복 반려')).toHaveLength(1);
    } finally {
      await h.close();
    }
  }, 120_000);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// AC-38: QA·설계자 등 검수 권한 팀원을 검수자로 지정하면 통과·반려를 등록할 수 있다. 역할 권한만 있고 검수자로 지정되지 않은 팀원은 등록할 수 없다
// (REV-02·03, CLI-08, 15.3 '본인이 검수자로 배정된 타인 작업의 ... 검수 결과 등록')
// ═════════════════════════════════════════════════════════════════════════════════════════════
describe('AC-38 지정된 검수자만 판정 등록', () => {
  /** 검수 턴을 실제 스케줄러로 띄운다 (가짜 CLI는 끝날 때까지 살아 있음) */
  async function launchReview(e: OrchEnv, taskId: string, reviewerId: string) {
    const key = reviewKeyOf(taskId);
    e.hold.add(key);
    e.tick();
    await waitOrch(() => !!e.liveProc(key, reviewerId), `${reviewerId} 검수 턴 시작`);
    return e.liveProc(key, reviewerId)!;
  }

  it('AC-38 프로듀서가 QA를 검수자로 지정하면 검수 업무가 QA에게 가고, QA의 검수 턴에서 통과를 등록할 수 있다', async () => {
    oenv = await bootOrch();
    const e = oenv;
    const d = seedDirective(e);
    const pd = identityOf(e, member(e, e.producerId), `directive:${d.id}`);
    const c = await callTool(e, pd, 'create_task', {
      directive_id: d.id,
      title: 'QA 검수 작업',
      goal: '로그인',
      type: 'development',
      assignee_id: e.devId,
      acceptance_criteria: ['로그인된다', '테스트가 있다'],
      output_mode: 'repo',
    });
    expect(c.ok).toBe(true);
    const id = c.ok ? (c.data as { taskId: string }).taskId : '';
    expect(task(e, id).reviewerId).toBe(e.producerId); // 기본 검수자
    const a = await callTool(e, pd, 'assign_reviewer', { task_id: id, reviewer_id: e.qaId });
    expect(a.ok).toBe(true);
    expect(task(e, id).reviewerId).toBe(e.qaId);
    await e.core.tasks.activateForLaunch(id);
    consumeQueued(e, `task:${id}`);
    const t = await workAndSubmit(e, id, { label: '구현' });
    expect(t.state).toBe('in_review');
    expect(queuedFor(e, (q) => q.sessionKey === reviewKeyOf(id)).map((q) => q.memberId)).toEqual([e.qaId]);

    const proc = await launchReview(e, id, e.qaId);
    expect(e.identity(proc.turnId)).toMatchObject({ memberId: e.qaId, sessionKind: 'review', canReview: true });
    const info = await e.tool(proc.turnId, 'get_review_target', { task_id: id });
    expect(info.ok).toBe(true);
    const r = await e.tool(proc.turnId, 'submit_review', verdictArgs(t, 'pass'));
    expect(r.ok).toBe(true);
    const recs = reviewsOf(e, id);
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ reviewerId: e.qaId, verdict: 'pass', reviewRound: 1, target: t.review.target });
    expect(recs[0]!.criteria.map((x) => x.criterion)).toEqual(['로그인된다', '테스트가 있다']);
    expect(task(e, id).review.passed?.reviewerId).toBe(e.qaId);
    proc.finishOk();
    await e.idle();
    // 통과 → 병합 판단은 프로듀서에게 (GIT-04)
    expect(queuedFor(e, (q) => q.kind === 'merge_decision' && q.taskId === id).map((q) => q.memberId)).toEqual([e.producerId]);
  });

  it('AC-38 지정된 QA는 반려도 등록할 수 있다 (사유와 함께 작업자에게 되돌아감)', async () => {
    oenv = await bootOrch();
    const e = oenv;
    const t = await orchRepoTaskInReview(e, { assigneeId: e.devId, reviewerId: e.qaId });
    const proc = await launchReview(e, t.id, e.qaId);
    const r = await e.tool(proc.turnId, 'submit_review', verdictArgs(t, 'reject', '오류 처리가 없습니다'));
    expect(r.ok).toBe(true);
    const cur = task(e, t.id);
    expect(cur.state).toBe('in_progress');
    expect(cur.review.rejectsInRound).toBe(1);
    expect(reviewsOf(e, t.id).map((x) => `${x.reviewerId}:${x.verdict}`)).toEqual([`${e.qaId}:reject`]);
    const work = queuedFor(e, (q) => q.kind === 'task_work' && q.taskId === t.id);
    expect(work.map((q) => q.memberId)).toEqual([e.devId]);
    expect(work[0]!.message).toContain('오류 처리가 없습니다');
    proc.finishOk();
    await e.idle();
  });

  it('AC-38 설계자·검수 권한 있는 사용자 정의 역할도 검수자로 지정되면 등록할 수 있다', async () => {
    oenv = await bootOrch();
    const e = oenv;
    const arch = { id: String((await e.main('add_member', { project_id: e.projectId, role_id: 'architect' })).memberId) };
    const role = {
      id: String(
        (
          await e.main('create_role', {
            name: '보안 검토자',
            instructions: '보안 관점으로 검토한다',
            task_types: ['test'],
            allowed_skills: [],
            default_ai: { kind: 'claude', model: null, effort_tier: 'normal', effort: null },
            can_review: true,
          })
        ).roleId,
      ),
    };
    const sec = { id: String((await e.main('add_member', { project_id: e.projectId, role_id: role.id })).memberId) };
    for (const reviewerId of [arch.id, sec.id]) {
      const t = await orchRepoTaskInReview(e, { assigneeId: e.devId, reviewerId });
      expect(t.reviewerId).toBe(reviewerId);
      const proc = await launchReview(e, t.id, reviewerId);
      const r = await e.tool(proc.turnId, 'submit_review', verdictArgs(t, 'pass'));
      expect(r.ok, reviewerId).toBe(true);
      expect(task(e, t.id).review.passed?.reviewerId).toBe(reviewerId);
      proc.finishOk();
      await e.idle();
    }
  });

  it('AC-38 검수 권한(QA·프로듀서)이 있어도 그 작업의 검수자로 지정되지 않으면 통과·반려·검수 대상 조회가 모두 거부된다', async () => {
    oenv = await bootOrch();
    const e = oenv;
    const byProducer = await orchRepoTaskInReview(e, { assigneeId: e.devId }); // 기본 검수자 = 프로듀서
    expect(byProducer.reviewerId).toBe(e.producerId);
    const byQa = await orchRepoTaskInReview(e, { assigneeId: e.devId, reviewerId: e.qaId });
    const proc = await launchReview(e, byQa.id, e.qaId); // QA의 실제 검수 턴 신원
    for (const args of [verdictArgs(byProducer, 'pass'), verdictArgs(byProducer, 'reject', '남의 작업 반려 시도')]) {
      const r = await e.tool(proc.turnId, 'submit_review', args);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe('forbidden');
        expect(r.message).toContain('검수자로 배정되지 않았습니다');
      }
    }
    const peek = await e.tool(proc.turnId, 'get_review_target', { task_id: byProducer.id });
    expect(peek.ok).toBe(false);
    expect(reviewsOf(e, byProducer.id)).toHaveLength(0);
    expect(task(e, byProducer.id)).toMatchObject({ state: 'in_review', review: expect.objectContaining({ passed: null, rejectsInRound: 0 }) });

    // 프로듀서도 검수 권한은 있지만 QA가 지정된 작업에는 등록할 수 없다
    const pd = identityOf(e, member(e, e.producerId), `directive:${byQa.directiveId}`);
    const p = await callTool(e, pd, 'submit_review', verdictArgs(byQa, 'pass'));
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.code).toBe('forbidden');
    expect(reviewsOf(e, byQa.id)).toHaveLength(0);
    // 지정된 QA는 그대로 등록할 수 있다
    expect((await e.tool(proc.turnId, 'submit_review', verdictArgs(byQa, 'pass'))).ok).toBe(true);
    proc.finishOk();
    await e.idle();
  });

  it('AC-38 검수 권한이 없는 역할(개발자)은 검수자로 지정할 수 없고, 검수 도구도 공개되지 않는다', async () => {
    oenv = await bootOrch();
    const e = oenv;
    const dev2 = { id: String((await e.main('add_member', { project_id: e.projectId, role_id: 'developer' })).memberId) };
    const t = await orchRepoTaskInReview(e, { assigneeId: e.devId });
    const pd = identityOf(e, member(e, e.producerId), `directive:${t.directiveId}`);
    const r = await callTool(e, pd, 'assign_reviewer', { task_id: t.id, reviewer_id: dev2.id });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('검수 권한이 없는 역할');
    expect(task(e, t.id).reviewerId).toBe(e.producerId);
    // 앱 도구 서버는 역할에 따라 공개: 검수 도구는 검수 권한 역할(프로듀서·QA·설계자·사용자 정의)에게만 (15.3, CLI-08)
    const reviewTools = TOOL_SPECS.filter((s) => s.name === 'submit_review' || s.name === 'get_review_target');
    expect(reviewTools).toHaveLength(2);
    for (const s of reviewTools) expect(s.roles).toEqual(['reviewer']);
    expect(rolesFor({ isMain: false, isProducer: false, canReview: false })).not.toContain('reviewer');
    expect(rolesFor({ isMain: false, isProducer: false, canReview: true })).toContain('reviewer');
    expect(rolesFor({ isMain: false, isProducer: true, canReview: true })).toContain('reviewer');
  });

  it('AC-38 검수자가 다른 팀원으로 바뀌면 이전 검수자는 더 이상 등록할 수 없다', async () => {
    oenv = await bootOrch();
    const e = oenv;
    const arch = { id: String((await e.main('add_member', { project_id: e.projectId, role_id: 'architect' })).memberId) };
    const t = await orchRepoTaskInReview(e, { assigneeId: e.devId, reviewerId: e.qaId });
    const proc = await launchReview(e, t.id, e.qaId);
    const pd = identityOf(e, member(e, e.producerId), `directive:${t.directiveId}`);
    expect((await callTool(e, pd, 'assign_reviewer', { task_id: t.id, reviewer_id: arch.id })).ok).toBe(true);
    await e.idle();
    expect(proc.terminatedByApp).toBe(true);
    const late = await e.tool(proc.turnId, 'submit_review', verdictArgs(t, 'pass'));
    expect(late.ok).toBe(false);
    expect(reviewsOf(e, t.id)).toHaveLength(0);
    expect(queuedFor(e, (q) => q.sessionKey === reviewKeyOf(t.id)).map((q) => q.memberId)).toEqual([arch.id]);
  });

  it('AC-38 (모의 팀 전체 흐름) 지정된 QA는 실제 앱 도구로 통과를 등록하고, 지정되지 않은 작업에 대한 등록 시도는 거부·기록된다', async () => {
    const h = await createHarness({ team: ['developer', 'developer', 'qa'], scenarios: { qa: 'review_violation' } });
    try {
      const dev1 = h.members.developer!;
      const dev2 = h.members.developer2!;
      const qa = h.members.qa!;
      const producer = h.members.producer!;
      // 검수자 지정이 작업 시작보다 먼저 되도록 개발자 1을 잠깐 멈춘다
      await h.internal('members.pause', dev1, 'immediate');
      const did = await sendCommand(h, '결제 화면을 만들어 줘');
      let t1 = '';
      await h.waitFor(
        () => {
          const t = h.core.ctx.store.tasks.list({ ref1: did }).find((x) => x.assigneeId === dev1);
          if (t) t1 = t.id;
          return !!t;
        },
        { label: '개발자 1 작업 생성' },
      );
      h.core.tasks.update(t1, { reviewerId: qa }, producer); // 프로듀서의 update_task(reviewer_id)와 같은 경로
      expect(h.task(t1).reviewerId).toBe(qa);
      await h.internal('members.resume', dev1);
      await h.waitFor(() => h.core.ctx.store.directives.get(did)?.state === 'awaiting_confirmation', { timeoutMs: 120_000, label: '보고 도착' });

      const tasks = h.core.ctx.store.tasks.list({ ref1: did });
      const t2 = tasks.find((x) => x.assigneeId === dev2)!;
      const recs = (id: string) => h.core.ctx.store.reviews.list({ ref1: id });
      expect(tasks.every((x) => x.state === 'done')).toBe(true);
      // 지정된 QA가 개발자 1 작업을 통과시켰고, 프로듀서는 그 작업에 판정하지 않았다
      expect(recs(t1).map((r) => `${r.reviewerId}:${r.verdict}`)).toEqual([`${qa}:pass`]);
      // 지정되지 않은 개발자 2 작업에는 QA 판정이 없다 (프로듀서만)
      expect(recs(t2.id).length).toBeGreaterThan(0);
      expect(recs(t2.id).every((r) => r.reviewerId === producer)).toBe(true);
      expect(h.core.ctx.store.reviews.list().filter((r) => r.reviewerId === qa).map((r) => r.taskId)).toEqual([t1]);
      // 실제 앱 도구 서버에서 거부되고 활동 기록에 남았다 (CLI-08)
      const denied = h.core.ctx.store.activity.search({ memberId: qa, kinds: ['app_tool'], text: 'submit_review 거부', limit: 50 });
      expect(denied.length).toBeGreaterThan(0);
      expect(denied.some((a) => (a.result ?? '').includes('검수자로 배정되지 않았습니다'))).toBe(true);
    } finally {
      await h.close();
    }
  }, 150_000);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// AC-39: 프로듀서 본인의 작업은 다른 적격 검수자에게 배정된다. 적격 팀원이 없으면 메인 에이전트가 검수하고(review:T) 자동 통과되지 않는다
// (REV-06 v0.6 — 대표 검수는 없다, SERVER_DESIGN 2.7)
// ═════════════════════════════════════════════════════════════════════════════════════════════
describe('AC-39 프로듀서 본인 작업의 검수', () => {
  it('AC-39 프로듀서 본인 작업은 적격 QA에게 배정되고 검수 업무도 QA에게만 간다', async () => {
    env = await boot({ team: ['qa'] });
    const e = env;
    const qa = e.members[0]!;
    const t = newTask(e, { assignee: e.producer });
    expect(t.reviewerId).toBe(qa.id);
    await activate(e, t.id);
    const cur = await workAndSubmit(e, t.id, { label: '프로듀서 직접 작업' });
    expect(cur.state).toBe('in_review');
    expect(queuedFor(e, (q) => q.sessionKey === reviewKeyOf(t.id)).map((q) => q.memberId)).toEqual([qa.id]);
    // 프로듀서 자신은 등록할 수 없다
    const self = await callTool(e, identityOf(e, e.producer, reviewKeyOf(t.id)), 'submit_review', verdictArgs(cur, 'pass'));
    expect(self.ok).toBe(false);
    // 배정된 QA는 등록할 수 있다
    expect((await callTool(e, identityOf(e, qa, reviewKeyOf(t.id)), 'submit_review', verdictArgs(cur, 'pass'))).ok).toBe(true);
  });

  it('AC-39 QA가 없으면 설계자, 그다음 검수 권한 있는 사용자 정의 역할에게 배정된다', async () => {
    env = await boot({ team: ['developer'] });
    const e = env;
    const arch = e.core.team.add({ projectId: e.project.id, roleId: 'architect' }, MAIN_AGENT_ID);
    expect(newTask(e, { assignee: e.producer }).reviewerId).toBe(arch.id);
    const now = e.ctx.now();
    e.ctx.store.roles.insert({
      id: 'role-acc-review',
      name: '검토 담당',
      instructions: '검토',
      taskTypes: ['test'],
      allowedSkills: [],
      defaultAi: { kind: 'claude', model: null, effortTier: 'normal', effortOverride: null },
      canReview: true,
      builtin: false,
      createdAt: now,
      updatedAt: now,
    });
    const custom = e.core.team.add({ projectId: e.project.id, roleId: 'role-acc-review' }, MAIN_AGENT_ID);
    e.core.team.remove(arch.id, MAIN_AGENT_ID);
    expect(newTask(e, { assignee: e.producer }).reviewerId).toBe(custom.id);
  });

  it('AC-39 적격 팀원이 없으면 메인 에이전트에게 검수 업무(review:T)가 간다 — 메인 판정 전에는 병합 요청이 거부되고, 팀원은 대신 등록할 수 없으며, 대표 할 일에는 나오지 않는다', async () => {
    // 메인의 통과는 실제 메인 검수 턴(가짜 CLI)에서 하고, 병합 판단은 그 턴의 마무리(제품의 turns.settleReview)가 넣는다 — 시험 도우미가 넣지 않는다 (10.11, 리드 결정 13)
    oenv = await bootOrch();
    const e = oenv;
    await e.internal('members.remove', e.qaId); // 팀: 프로듀서·개발자 — 검수 권한 팀원 없음
    const dev = member(e, e.devId);
    const producer = member(e, e.producerId);
    const cur = await orchRepoTaskInReview(e, { assigneeId: e.producerId });
    const t = cur;
    expect(cur.reviewerId).toBe(MAIN_AGENT_ID);
    expect(cur.state).toBe('in_review');
    expect(cur.review.passed).toBeNull();
    // 메인 에이전트의 검수 세션으로 검수 업무가 간다 — 대표 할 일·대표 검수 알림은 없다
    expect(queuedFor(e, (q) => q.sessionKey === reviewKeyOf(t.id)).map((q) => [q.kind, q.memberId])).toEqual([['review', MAIN_AGENT_ID]]);
    expect(e.core.views.taskView(cur).review).not.toHaveProperty('awaitingOwner');
    expect(e.core.views.ownerTodos().map((x) => x.kind as string)).not.toContain('owner_review');
    expect(e.ctx.store.notifications.list().filter((n) => n.title === '대표 검수 요청')).toHaveLength(0);
    expect(e.ctx.store.queue.list({ state: ['queued', 'running'] }).filter((q) => q.kind === 'merge_decision' && q.taskId === t.id)).toEqual([]);
    // 팀원 누구도(프로듀서 본인·개발자) 대신 등록할 수 없다
    for (const m of [producer, dev]) {
      const r = await callTool(e, identityOf(e, m, reviewKeyOf(t.id)), 'submit_review', verdictArgs(cur, 'pass'));
      expect(r.ok, m.roleId).toBe(false);
    }
    const merge = await callTool(e, identityOf(e, producer, `directive:${t.directiveId}`), 'request_merge', { task_id: t.id });
    expect(merge.ok).toBe(false);
    expect(reviewsOf(e, t.id)).toHaveLength(0);
    expect(task(e, t.id)).toMatchObject({ state: 'in_review', merge: null });

    // 메인 에이전트가 그 검수 세션의 실제 턴에서 통과하면, 그 검수 턴이 끝날 때의 마무리가 병합 판단을 프로듀서에게 넣고 병합된다
    const key = reviewKeyOf(t.id);
    e.hold.add(key);
    e.tick();
    await waitOrch(() => !!e.liveProc(key, MAIN_AGENT_ID), '메인 검수 턴 시작');
    const proc = e.liveProc(key, MAIN_AGENT_ID)!;
    expect((await e.tool(proc.turnId, 'submit_review', verdictArgs(task(e, t.id), 'pass'))).ok).toBe(true);
    proc.finishOk();
    await e.idle();
    expect(queuedFor(e, (q) => q.kind === 'merge_decision' && q.taskId === t.id).map((q) => q.memberId)).toEqual([e.producerId]);
    consumeQueued(e, `directive:${t.directiveId}`);
    e.core.merges.requestMerge(t.id, producer, null);
    await waitOrch(() => !e.core.merges.isPending(t.id), '병합 처리');
    expect(task(e, t.id).state).toBe('done');
    const base = e.ctx.store.projects.require(e.projectId).baseBranch;
    expect(gitIn(e.projectDir, ['log', '--merges', '--format=%s', `refs/heads/${base}`]).split(/\r?\n/).filter((l) => l.startsWith(`[${t.id}] 병합`))).toHaveLength(1);
  });

  it('AC-39 프로듀서는 자기 작업의 검수자로 자신을 지정할 수 없다', async () => {
    env = await boot({ team: ['qa'] });
    const e = env;
    const d = newDirective(e);
    const pd = identityOf(e, e.producer, `directive:${d}`);
    const c = await callTool(e, pd, 'create_task', { directive_id: d, title: '직접 작업', goal: '목표', type: 'development', assignee_id: e.producer.id, reviewer_id: e.producer.id, acceptance_criteria: ['된다'], output_mode: 'repo' });
    expect(c.ok).toBe(false);
    const t = newTask(e, { assignee: e.producer, directiveId: d });
    const a = await callTool(e, pd, 'assign_reviewer', { task_id: t.id, reviewer_id: e.producer.id });
    expect(a.ok).toBe(false);
    expect(task(e, t.id).reviewerId).toBe(e.members[0]!.id);
  });

  it('AC-39 다른 팀원 작업을 프로듀서에게 재배정하면 검수자가 프로듀서에서 다른 적격 검수자(없으면 메인 에이전트)로 바뀐다', async () => {
    env = await boot({ team: ['developer', 'qa'] });
    const e = env;
    const [dev, qa] = e.members;
    const t = newTask(e, { assignee: dev });
    expect(t.reviewerId).toBe(e.producer.id);
    e.core.tasks.reassign(t.id, e.producer.id, MAIN_AGENT_ID);
    expect(task(e, t.id).reviewerId).toBe(qa!.id);
    const t2 = newTask(e, { assignee: qa });
    expect(t2.reviewerId).toBe(e.producer.id);
    e.core.tasks.reassign(t2.id, e.producer.id, MAIN_AGENT_ID);
    // QA는 이전 작업자(실질 참여자), 개발자는 검수 권한 없음 → 메인 에이전트
    expect(task(e, t2.id).reviewerId).toBe(MAIN_AGENT_ID);
  });

  it('AC-39 프로듀서 작업의 적격 검수자가 삭제되면 프로듀서가 아니라 메인 에이전트 검수로 넘어간다', async () => {
    env = await boot({ team: ['qa'] });
    const e = env;
    const qa = e.members[0]!;
    const t = newTask(e, { assignee: e.producer });
    await activate(e, t.id);
    const cur = await workAndSubmit(e, t.id, { label: '직접 작업' });
    expect(cur.reviewerId).toBe(qa.id);
    e.core.team.remove(qa.id, MAIN_AGENT_ID);
    const after = task(e, t.id);
    expect(after.reviewerId).toBe(MAIN_AGENT_ID);
    expect(after.state).toBe('in_review');
    expect(after.review.passed).toBeNull();
    // 검수 업무는 메인 에이전트의 검수 세션으로만 (프로듀서·삭제된 QA 몫은 없다)
    expect(queuedFor(e, (q) => q.sessionKey === reviewKeyOf(t.id)).map((q) => q.memberId)).toEqual([MAIN_AGENT_ID]);
  });

  it('AC-39 프로듀서가 맡는 되돌리기 작업도 프로듀서가 아닌 적격 검수자(없으면 메인 에이전트)에게 배정된다', async () => {
    env = await boot({ team: ['developer'] });
    const e = env;
    const t = await passedTask(e, { reviewer: 'main', file: 'feature.txt' });
    expect((await mergeAndSettle(e, t.id)).state).toBe('done');
    const res = await e.core.merges.requestRevert(t.id, e.producer, '되돌리기 확인');
    const rt = task(e, res.revertTaskId!);
    expect(rt.assigneeId).toBe(e.producer.id);
    expect(rt.reviewerId).toBe(MAIN_AGENT_ID);
    await waitFor(() => task(e, rt.id).state === 'in_review' && !e.core.tasks.isSubmitting(rt.id), '되돌리기 제출');
    expect(queuedFor(e, (q) => q.sessionKey === reviewKeyOf(rt.id)).map((q) => [q.kind, q.memberId])).toEqual([['review', MAIN_AGENT_ID]]);
    expect(task(e, rt.id).review.passed).toBeNull();
  });

  it('AC-39 (모의 팀 전체 흐름) 팀원 없이 프로듀서가 직접 한 작업은 메인 에이전트 검수 대기로 가고, 시간이 지나거나 재시작해도 자동 통과되지 않으며, 모의 메인이 submit_review로 통과한 뒤에만 병합된다', async () => {
    let h: Harness = await createHarness({ team: [] });
    try {
      const did = await sendCommand(h, '설정 화면을 만들어 줘');
      // 메인 에이전트가 판정하는 때를 시험이 정한다: 지시를 등록한 메인을 운영자가 잠시 멈춘다(그동안 메인 검수 턴이 돌지 않는다)
      await h.internal('members.pause', MAIN_AGENT_ID, 'graceful');
      let taskId = '';
      await h.waitFor(
        () => {
          const t = h.core.ctx.store.tasks.list({ ref1: did })[0];
          if (t) taskId = t.id;
          return !!t && t.state === 'in_review' && !h.core.tasks.isSubmitting(t.id);
        },
        { timeoutMs: 60_000, label: '프로듀서 작업 검수 대기' },
      );
      const t = h.task(taskId);
      expect(t.assigneeId).toBe(h.members.producer);
      expect(t.reviewerId).toBe(MAIN_AGENT_ID);
      const stillWaiting = (x: Harness) => {
        const cur = x.task(taskId);
        expect(cur.state).toBe('in_review');
        expect(cur.review.passed).toBeNull();
        expect(cur.merge).toBeNull();
        expect(x.core.ctx.store.reviews.list({ ref1: taskId })).toHaveLength(0);
        expect(x.core.ctx.store.turns.list().filter((tn) => tn.taskId === taskId && tn.sessionKind === 'review')).toHaveLength(0);
        // 메인 에이전트의 검수 업무가 기다린다 — 대표 할 일에는 나오지 않는다
        expect(x.core.ctx.store.queue.list({ ref2: `review:${taskId}`, state: 'queued' }).map((q) => [q.kind, q.memberId])).toEqual([['review', MAIN_AGENT_ID]]);
        expect(x.snapshot().ownerTodos.map((o) => o.kind as string)).not.toContain('owner_review');
        expect(x.snapshot().tasks.find((v) => v.id === taskId)!.review).not.toHaveProperty('awaitingOwner');
      };
      stillWaiting(h);
      // 메인 판정 전에는 병합 요청이 거부된다
      const producer = h.core.ctx.store.members.require(h.members.producer!);
      expect(() => h.core.merges.requestMerge(taskId, producer, null)).toThrow();
      await sleep(3_000); // 스케줄러 2초 주기를 지나도 그대로
      stillWaiting(h);
      h = await h.restart();
      await sleep(1_500);
      stillWaiting(h);

      // 메인이 돌아오면 모의 메인이 그 검수 세션에서 submit_review로 통과하고, 그 뒤에만 병합된다
      await h.internal('members.resume', MAIN_AGENT_ID);
      await h.waitFor(() => h.core.ctx.store.directives.get(did)?.state === 'awaiting_confirmation', { timeoutMs: 60_000, label: '보고 도착' });
      const done = h.task(taskId);
      expect(done.state).toBe('done');
      expect(done.merge?.mergeCommitSha).toMatch(/^[0-9a-f]{40}$/);
      expect(h.core.ctx.store.reviews.list({ ref1: taskId }).map((r) => `${r.reviewerId}:${r.verdict}`)).toEqual([`${MAIN_AGENT_ID}:pass`]);
      expect(h.core.ctx.store.turns.list().filter((tn) => tn.taskId === taskId && tn.sessionKind === 'review').map((tn) => tn.memberId)).toEqual([MAIN_AGENT_ID]);
    } finally {
      await h.close();
    }
  }, 150_000);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// AC-43: 검수 통과 후 작업 커밋·기준 main 중 하나가 바뀌거나 미반영 변경이 생기면 병합되지 않는다. 최신 기준의 검사·검수를 다시 통과해야 한다
// (REV-07, GIT-06·14, 7.1 '검수 유효성', 5.3 '재검수하는 경우는 반려 횟수에 포함하지 않습니다')
// ═════════════════════════════════════════════════════════════════════════════════════════════
describe('AC-43 통과 후 버전이 바뀌면 병합하지 않음', () => {
  function checkLog(): { path: string; cmd: string; lines: () => string[] } {
    const dir = mkdtempSync(join(tmpdir(), 'wook-test-acc-check-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'checks.log');
    return {
      path,
      cmd: `git rev-parse HEAD >> ${path}`,
      lines: () => (existsSync(path) ? readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean) : []),
    };
  }

  it('AC-43 통과 후 기준 main이 바뀌면 병합하지 않고, 최신 main 반영 → 자동 검사 → 재검수를 다시 통과해야 병합된다 (반려로 세지 않음)', async () => {
    const log = checkLog();
    env = await boot({ team: ['developer', 'qa'], runner: true, checkCommands: [log.cmd] });
    const e = env;
    const [dev, qa] = e.members;
    const t = await submittedTask(e, { assignee: dev, reviewer: qa!.id, file: 'feature.txt' });
    const first = t.review.target!;
    expect(log.lines()).toHaveLength(1);
    pass(e, t.id);
    const moved = commitOnMain(e, 'other.txt', '다른 작업이 먼저 병합됨\n');

    await mergeAndSettle(e, t.id);
    await waitFor(() => task(e, t.id).state === 'in_review' && !e.core.tasks.isSubmitting(t.id), '재고정');
    const cur = task(e, t.id);
    expect(mergeCommitsFor(e, t.id)).toBe(0);
    expect(mainSha(e)).toBe(moved);
    expect(cur.merge).toBeNull();
    expect(cur.review.passed).toBeNull();
    expect(cur.review.target?.kind === 'repo' && cur.review.target.baseMainSha).toBe(moved);
    expect(cur.review.target?.kind === 'repo' && first.kind === 'repo' && cur.review.target.taskCommitSha !== first.taskCommitSha).toBe(true);
    // 최신 조합에서 자동 검사를 다시 했다 (검사한 커밋 = 새로 고정된 작업 커밋)
    expect(log.lines()).toHaveLength(2);
    expect(log.lines()[1]).toBe(cur.review.target?.kind === 'repo' ? cur.review.target.taskCommitSha : '');
    expect(cur.review.autoCheck.status).toBe('passed');
    // 반려가 아니다
    expect(cur.review).toMatchObject({ round: 1, rejectsInRound: 0, rejectsTotal: 0 });
    expect(transitionsOf(e, t.id).some((x) => x.event === 'reopen' && x.reason.includes('기준 main'))).toBe(true);
    // 재검수 업무가 검수자에게 다시 가고, 이전 통과로는 병합 요청을 받지 않는다
    expect(queuedFor(e, (q) => q.kind === 'review' && q.sessionKey === reviewKeyOf(t.id)).map((q) => q.memberId)).toEqual([qa!.id]);
    const refused = await errOf(() => e.core.merges.requestMerge(t.id, e.producer, null));
    expect(refused.code).toBe('conflict');

    pass(e, t.id);
    const done = await mergeAndSettle(e, t.id);
    expect(done.state).toBe('done');
    expect(mergeCommitsFor(e, t.id)).toBe(1);
    expect(done.merge?.preMainSha).toBe(moved);
    expect(reviewsOf(e, t.id).map((r) => r.verdict)).toEqual(['pass', 'pass']);
  });

  it('AC-43 통과 후 기준 main 변경으로 최신 기준의 자동 검사가 실패하면 병합되지 않고 진행으로 돌아간다', async () => {
    const cmd = process.platform === 'win32' ? 'if exist breaks.txt (exit 1) else (exit 0)' : 'test ! -e breaks.txt';
    env = await boot({ runner: true, checkCommands: [cmd] });
    const e = env;
    const t = await passedTask(e, { reviewer: 'main', file: 'feature.txt' });
    expect(t.review.autoCheck.status).toBe('passed');
    commitOnMain(e, 'breaks.txt', '이 파일이 있으면 검사가 실패한다\n');
    await mergeAndSettle(e, t.id);
    await waitFor(() => !e.core.tasks.isSubmitting(t.id) && task(e, t.id).state === 'in_progress', '재검사 실패');
    const cur = task(e, t.id);
    expect(cur.review.autoCheck.status).toBe('failed');
    expect(cur.review.passed).toBeNull();
    expect(cur.review.target).toBeNull();
    expect(mergeCommitsFor(e, t.id)).toBe(0);
    const work = queuedFor(e, (q) => q.kind === 'task_work' && q.taskId === t.id);
    expect(work.some((q) => q.message.includes('자동 검사에 실패'))).toBe(true);
    expect(cur.review.rejectsTotal).toBe(0);
  });

  it('AC-43 통과 후 작업 커밋이 바뀌면(작업 브랜치에 새 커밋) 병합하지 않고 진행으로 돌려 재검사·재검수를 받게 한다', async () => {
    env = await boot();
    const e = env;
    const t = await passedTask(e, { reviewer: 'main', file: 'feature.txt' });
    const before = mainSha(e);
    const wt = t.workspace!.worktreePath;
    writeFileSync(join(wt, 'late.txt'), '검수 뒤에 생긴 커밋\n', 'utf8');
    gitIn(wt, ['add', 'late.txt']);
    gitIn(wt, ['-c', 'user.name=late', '-c', 'user.email=l@l', 'commit', '-q', '-m', 'late']);

    const cur = await mergeAndSettle(e, t.id);
    expect(mainSha(e)).toBe(before);
    expect(mergeCommitsFor(e, t.id)).toBe(0);
    expect(cur.state).toBe('in_progress');
    expect(cur.review.passed).toBeNull();
    expect(cur.review.target).toBeNull();
    expect(cur.review.rejectsTotal).toBe(0);
    const work = queuedFor(e, (q) => q.kind === 'task_work' && q.taskId === t.id);
    expect(work.some((q) => q.message.includes('작업 버전이 바뀌었습니다'))).toBe(true);

    // 다시 제출 → 새 버전 고정 → 이전 통과로는 병합 불가 → 검수자(메인 에이전트)가 새 버전을 통과시켜야 병합
    const m = member(e, cur.assigneeId);
    e.core.tasks.requestSubmit(t.id, '다시 제출', m);
    await e.core.tasks.processSubmission(t.id);
    const again = task(e, t.id);
    expect(again.state).toBe('in_review');
    expect(again.review.target?.kind === 'repo' && again.review.target.taskCommitSha).toBe(git(wt, ['rev-parse', 'HEAD']));
    // 새 버전의 검수 요청이 다시 검수자(메인 에이전트의 검수 세션)에게 간다
    expect(queuedFor(e, (q) => q.sessionKey === reviewKeyOf(t.id) && q.kind === 'review').map((q) => [q.memberId, q.reviewPinnedAt])).toEqual([[MAIN_AGENT_ID, again.review.target!.pinnedAt]]);
    expect((await errOf(() => e.core.merges.requestMerge(t.id, e.producer, null))).code).toBe('conflict');
    pass(e, t.id);
    const done = await mergeAndSettle(e, t.id);
    expect(done.state).toBe('done');
    expect(git(e.projectDir, ['show', `${e.project.baseBranch}:late.txt`])).toContain('검수 뒤에 생긴 커밋');
  });

  it('AC-43 통과 후 작업 폴더에 반영되지 않은 변경이 생기면 병합하지 않고 진행으로 돌린다', async () => {
    env = await boot();
    const e = env;
    const t = await passedTask(e, { reviewer: 'main', file: 'feature.txt' });
    const before = mainSha(e);
    writeFileSync(join(t.workspace!.worktreePath, 'feature.txt'), '커밋하지 않은 수정\n', 'utf8');
    const cur = await mergeAndSettle(e, t.id);
    expect(mainSha(e)).toBe(before);
    expect(mergeCommitsFor(e, t.id)).toBe(0);
    expect(cur.state).toBe('in_progress');
    expect(cur.review.passed).toBeNull();
    expect(queuedFor(e, (q) => q.kind === 'task_work' && q.taskId === t.id).some((q) => q.message.includes('반영되지 않은 변경'))).toBe(true);
  });

  it('AC-43 병합 직전(잠금 안) 기준 main이 바뀌어도 main을 덮어쓰거나 이전 통과로 병합하지 않고 재검사·재검수로 돌린다', async () => {
    env = await boot();
    const e = env;
    const t = await passedTask(e, { reviewer: 'main', file: 'feature.txt' });
    const g = e.ctx.deps.git;
    const orig = g.mergeIntoBase.bind(g);
    let racer = '';
    g.mergeIntoBase = async (dir, o) => {
      if (!racer) racer = commitOnMain(e, 'race.txt', '병합 직전에 들어온 변경\n');
      return orig(dir, o);
    };
    await mergeAndSettle(e, t.id);
    await waitFor(() => !e.core.tasks.isSubmitting(t.id) && task(e, t.id).state === 'in_review', '재고정');
    expect(mergeCommitsFor(e, t.id)).toBe(0);
    expect(mainSha(e)).toBe(racer);
    const cur = task(e, t.id);
    expect(cur.review.passed).toBeNull();
    expect(cur.review.target?.kind === 'repo' && cur.review.target.baseMainSha).toBe(racer);
    expect(cur.review.rejectsTotal).toBe(0);
  });

  it('AC-43 (모의 팀 전체 흐름) 두 작업이 같은 main 기준으로 통과한 뒤 하나가 먼저 병합되면, 다른 하나는 바로 병합되지 않고 최신 main 반영·재검수를 다시 통과한 뒤 병합된다', async () => {
    const h = await createHarness({ team: ['developer', 'developer', 'qa'] });
    try {
      const producer = h.members.producer!;
      const qa = h.members.qa!;
      const devs = [h.members.developer!, h.members.developer2!];
      for (const d of devs) await h.internal('members.pause', d, 'immediate');
      const did = await sendCommand(h, '검색 화면과 정렬 기능을 만들어 줘');
      await h.waitFor(() => h.core.ctx.store.tasks.list({ ref1: did }).length === 3 && !h.core.turns.hasLiveSession(`directive:${did}`), { label: '계획 완료' });
      const devTasks = devs.map((d) => h.core.ctx.store.tasks.list({ ref1: did }).find((x) => x.assigneeId === d)!.id);
      // 두 개발 작업은 QA가 검수하고, 둘 다 통과할 때까지 병합 판단(프로듀서)을 멈춘다
      await h.internal('members.pause', producer, 'immediate');
      for (const id of devTasks) h.core.tasks.update(id, { reviewerId: qa }, producer);
      for (const d of devs) await h.internal('members.resume', d);
      await h.waitFor(() => devTasks.every((id) => h.task(id).state === 'in_review' && h.task(id).review.passed?.reviewerId === qa), { timeoutMs: 60_000, label: '두 작업 통과' });
      const [b0, b1] = devTasks.map((id) => {
        const p = h.task(id).review.passed!.target;
        return p.kind === 'repo' ? p.baseMainSha : '';
      });
      expect(b0).toBe(b1); // 같은 main 기준으로 통과
      await h.internal('members.resume', producer);
      await h.waitFor(() => h.core.ctx.store.directives.get(did)?.state === 'awaiting_confirmation', { timeoutMs: 90_000, label: '보고 도착' });

      const done = devTasks.map((id) => h.task(id));
      expect(done.every((t) => t.state === 'done' && !!t.merge)).toBe(true);
      const first = done.find((t) => t.merge!.preMainSha === b0)!;
      const second = done.find((t) => t !== first)!;
      expect(second.merge!.preMainSha).toBe(first.merge!.mergeCommitSha); // 먼저 병합된 main 위에 병합
      const recs = h.core.ctx.store.reviews.list({ ref1: second.id });
      expect(recs.map((r) => `${r.reviewerId}:${r.verdict}`)).toEqual([`${qa}:pass`, `${qa}:pass`]);
      const re = recs[1]!.target;
      expect(re.kind === 'repo' && re.baseMainSha).toBe(first.merge!.mergeCommitSha); // 재검수는 최신 기준 버전에 대해
      expect(second.merge!.taskCommitSha).toBe(re.kind === 'repo' ? re.taskCommitSha : '');
      expect(h.core.ctx.store.transitions.list(second.id).some((x) => x.event === 'reopen' && x.reason.includes('기준 main'))).toBe(true);
      expect(second.review.rejectsTotal).toBe(0);
      expect(h.core.ctx.store.reviews.list({ ref1: first.id })).toHaveLength(1);
    } finally {
      await h.close();
    }
  }, 150_000);

  it('AC-43 검수 중 완료 조건이 바뀌어 다시 제출된 새 버전은, 그 버전을 보지 않은 이전 검수 턴의 늦은 통과로 통과·병합 대상이 되지 않는다', async () => {
    oenv = await bootOrch();
    const e = oenv;
    const t = await orchRepoTaskInReview(e, { assigneeId: e.devId, reviewerId: e.qaId, criteria: ['로그인된다'] });
    const v1 = t.review.target;
    const key = reviewKeyOf(t.id);
    e.hold.add(key);
    e.tick();
    await waitOrch(() => !!e.liveProc(key, e.qaId), 'QA 검수 턴');
    const turn = e.liveProc(key, e.qaId)!;
    const seen = await e.tool(turn.turnId, 'get_review_target', { task_id: t.id });
    expect(seen.ok).toBe(true); // 검수자는 V1 사본을 보고 있다

    // 검수 도중 프로듀서가 완료 조건을 바꾼다 → 진행으로 돌아가 작업자가 V2를 제출
    e.core.tasks.update(t.id, { acceptanceCriteria: ['로그인된다', '오류 문구가 보인다'] }, e.producerId);
    expect(task(e, t.id).state).toBe('in_progress');
    consumeQueued(e, `task:${t.id}`);
    const v2 = await workAndSubmit(e, t.id, { label: '오류 문구 추가', file: 'error.txt', content: '오류 문구\n' });
    expect(v2.state).toBe('in_review');
    expect(v2.review.target).not.toEqual(v1);

    // V1만 본 이전 턴이 이제야 (이전 완료 조건으로) 통과를 보낸다
    const late = await e.tool(turn.turnId, 'submit_review', {
      task_id: t.id,
      verdict: 'pass',
      criteria: [{ criterion: '로그인된다', pass: true, note: 'V1 사본에서 확인' }],
      reason: '',
    });
    turn.finishOk();
    await e.idle();
    const after = task(e, t.id);
    expect.soft(late.ok, '그 버전을 보지 않은 검수 턴의 판정은 받지 않아야 함').toBe(false);
    expect.soft(after.review.passed, 'V2는 아직 검수를 통과하지 않았다').toBeNull();
    expect.soft(queuedFor(e, (q) => q.kind === 'merge_decision' && q.taskId === t.id), 'V2 병합 판단이 생기면 안 됨').toHaveLength(0);
    expect(queuedFor(e, (q) => q.kind === 'review' && q.sessionKey === key).map((q) => q.memberId), 'V2 검수가 QA 앞으로 남아야 함').toEqual([e.qaId]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// AC-47: 저장소 변경 없는 조사·문서 산출물은 독립 검수와 버전 보관으로 완료된다. 불필요한 빈 커밋·병합을 만들지 않고, 추적 파일이 바뀌면 변경형 절차로 전환한다
// (REV-01·05·07, GIT-02·05, 5.2 '산출물형이라도 추적 파일이 바뀌면 변경형으로 전환')
// ═════════════════════════════════════════════════════════════════════════════════════════════
describe('AC-47 산출물형 작업의 검수·보관', () => {
  async function plannerArtifactTask(e: Env, type: 'research' | 'docs' | 'spec' = 'research') {
    const planner = e.core.team.add({ projectId: e.project.id, roleId: 'planner' }, MAIN_AGENT_ID);
    const t = newTask(e, { assignee: planner, type, outputMode: 'artifact' });
    await activate(e, t.id);
    return { planner, t: task(e, t.id) };
  }

  it('AC-47 산출물형 조사 작업은 저장소 커밋 없이 독립 검수를 거쳐 검수한 버전 그대로 보관되고 완료된다 (빈 커밋·병합 없음)', async () => {
    env = await boot();
    const e = env;
    const main0 = mainSha(e);
    const { planner, t } = await plannerArtifactTask(e);
    expect(t.reviewerId).toBe(e.producer.id);
    e.core.tasks.setSteps(t.id, ['자료 조사', '결과 정리']);
    writeArtifact(e, t, 'notes/sources.md', '# 출처\n- A\n');
    const s0 = await e.core.tasks.completeStep(t.id, 0, '조사', planner, null);
    writeArtifact(e, t, 'report.md', '# 조사 결과\n추천안: A\n');
    const s1 = await e.core.tasks.completeStep(t.id, 1, '정리', planner, null);
    expect([s0.commitSha, s1.commitSha]).toEqual([null, null]); // 변경 없는 단계는 빈 커밋을 만들지 않는다 (GIT-05)
    e.core.tasks.requestSubmit(t.id, '제출', planner);
    await e.core.tasks.processSubmission(t.id);

    const inReview = task(e, t.id);
    expect(inReview.state).toBe('in_review');
    expect(inReview.outputMode).toBe('artifact');
    const target = inReview.review.target!;
    expect(target.kind).toBe('artifact');
    if (target.kind !== 'artifact') return;
    expect(target.version).toBe(1);
    expect(target.files.map((f) => `${f.path}:${f.sha256}`)).toEqual([`notes/sources.md:${sha256('# 출처\n- A\n')}`, `report.md:${sha256('# 조사 결과\n추천안: A\n')}`]);
    expect(inReview.review.autoCheck.status).toBe('not_applicable'); // '해당 없음'과 사유 (REV-01)
    expect(inReview.review.autoCheck.detail).toContain('해당 없음');
    // 검수 전에는 완료·보관하지 않는다, 작업자는 검수할 수 없다
    expect(inReview.artifact).toBeNull();
    expect((await callTool(e, identityOf(e, planner, reviewKeyOf(t.id)), 'submit_review', verdictArgs(inReview, 'pass'))).ok).toBe(false);
    expect(queuedFor(e, (q) => q.sessionKey === reviewKeyOf(t.id)).map((q) => q.memberId)).toEqual([e.producer.id]);

    // 독립 검수자(프로듀서) 통과 → 보관 → 완료
    const r = await callTool(e, identityOf(e, e.producer, reviewKeyOf(t.id)), 'submit_review', verdictArgs(inReview, 'pass'));
    expect(r.ok).toBe(true);
    await waitFor(() => task(e, t.id).state === 'done', '산출물 확정');
    await sleep(50);
    const done = task(e, t.id);
    expect(done.artifact?.version).toBe(1);
    expect(done.artifact?.dir).toBe(artifactVersionDir(e.ctx.paths, e.project.id, t.id, 1));
    expect(done.artifact?.files).toEqual(target.files);
    expect(readFileSync(join(done.artifact!.dir, 'report.md'), 'utf8')).toBe('# 조사 결과\n추천안: A\n');
    // 저장소에는 아무 흔적도 없다: main 그대로, 병합 기록·커밋 없음, 확정 뒤 정리로 작업 폴더·브랜치도 남지 않음
    expect(done.merge).toBeNull();
    expect(mainSha(e)).toBe(main0);
    expect(git(e.projectDir, ['log', '--format=%s', e.project.baseBranch])).not.toContain(`[${t.id}]`);
    await waitFor(() => !existsSync(t.workspace!.worktreePath) && git(e.projectDir, ['branch', '--list', t.workspace!.branch]) === '', '작업 공간 정리', 20_000);
    const kinds = execKinds(e, t.id);
    expect(kinds).not.toContain('git_commit');
    expect(kinds).not.toContain('git_merge');
    expect(e.ctx.store.queue.list({ state: 'queued' }).filter((q) => q.kind === 'merge_decision' && q.taskId === t.id)).toEqual([]);
  });

  it('AC-47 반려 뒤 다시 제출하면 새 버전으로 검수되고, 보관본은 통과한 버전과 같다 (제출 뒤 작업 폴더가 바뀌어도)', async () => {
    env = await boot();
    const e = env;
    const { planner, t } = await plannerArtifactTask(e, 'docs');
    e.core.tasks.setSteps(t.id, ['초안']);
    writeArtifact(e, t, 'guide.md', '초안\n');
    await e.core.tasks.completeStep(t.id, 0, '초안', planner, null);
    e.core.tasks.requestSubmit(t.id, '제출', planner);
    await e.core.tasks.processSubmission(t.id);
    expect(task(e, t.id).review.target).toMatchObject({ kind: 'artifact', version: 1 });
    reject(e, t.id);
    expect(task(e, t.id).state).toBe('in_progress');

    const v2 = await workAndSubmit(e, t.id, { label: '보완', file: null, artifactFile: 'guide.md', content: '보완본\n' });
    expect(v2.state).toBe('in_review');
    expect(v2.review.target).toMatchObject({ kind: 'artifact', version: 2 });
    writeArtifact(e, v2, 'guide.md', '검수 뒤 몰래 고친 내용\n'); // 검수 대상과 다른 작업 폴더
    pass(e, v2.id);
    await waitFor(() => task(e, t.id).state === 'done', '확정');
    await sleep(50);
    const done = task(e, t.id);
    expect(done.artifact?.version).toBe(2);
    expect(readFileSync(join(done.artifact!.dir, 'guide.md'), 'utf8')).toBe('보완본\n');
    expect(done.artifact?.files.map((f) => f.sha256)).toEqual([sha256('보완본\n')]);
    expect(done.merge).toBeNull();
  });

  it('AC-47 산출물형 작업이 단계 중에 추적 파일을 바꾸면 변경형으로 전환돼 커밋·최신 main 반영·병합 절차를 탄다', async () => {
    env = await boot();
    const e = env;
    commitOnMain(e, 'README.md', '# 프로젝트\n');
    const { planner, t } = await plannerArtifactTask(e);
    e.core.tasks.setSteps(t.id, ['조사', '문서 반영']);
    writeArtifact(e, t, 'report.md', '조사 결과\n');
    expect((await e.core.tasks.completeStep(t.id, 0, '조사', planner, null)).commitSha).toBeNull();
    expect(task(e, t.id).outputMode).toBe('artifact');
    writeFileSync(join(t.workspace!.worktreePath, 'README.md'), '# 프로젝트\n조사 결과 요약 추가\n', 'utf8');
    const s1 = await e.core.tasks.completeStep(t.id, 1, '문서 반영', planner, null);
    expect(s1.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(task(e, t.id).outputMode).toBe('repo');
    expect(e.ctx.store.activity.search({ taskId: t.id, text: '산출물형 → 저장소 변경형 전환' })).toHaveLength(1);
    e.core.tasks.requestSubmit(t.id, '제출', planner);
    await e.core.tasks.processSubmission(t.id);
    const cur = task(e, t.id);
    expect(cur.state).toBe('in_review');
    expect(cur.review.target?.kind).toBe('repo');
    expect(execKinds(e, t.id)).toContain('git_update_from_base');
    pass(e, t.id);
    const done = await mergeAndSettle(e, t.id);
    expect(done.state).toBe('done');
    expect(mergeCommitsFor(e, t.id)).toBe(1);
    expect(git(e.projectDir, ['show', `${e.project.baseBranch}:README.md`])).toContain('조사 결과 요약 추가');
  });

  it('AC-47 마지막 단계 뒤 제출 직전에 추적 파일이 바뀌어도 제출 처리에서 변경형으로 전환된다', async () => {
    env = await boot();
    const e = env;
    commitOnMain(e, 'README.md', '# 프로젝트\n');
    const { planner, t } = await plannerArtifactTask(e, 'docs');
    e.core.tasks.setSteps(t.id, ['문서']);
    writeArtifact(e, t, 'doc.md', '문서\n');
    await e.core.tasks.completeStep(t.id, 0, '문서', planner, null);
    writeFileSync(join(t.workspace!.worktreePath, 'README.md'), '# 프로젝트\n문서 링크\n', 'utf8');
    e.core.tasks.requestSubmit(t.id, '제출', planner);
    await e.core.tasks.processSubmission(t.id);
    const cur = task(e, t.id);
    expect(cur.outputMode).toBe('repo');
    expect(cur.review.target?.kind).toBe('repo');
    expect(git(t.workspace!.worktreePath, ['log', '--format=%s', 'HEAD'])).toContain(`[${t.id}] 제출 전 변경 정리`);
    expect(execKinds(e, t.id)).toContain('git_update_from_base');
  });

  it('AC-47 산출물형 작업 중 다른 작업이 main에 병합돼도(이 작업의 추적 파일 변경 없음) 산출물형으로 검수·보관된다', async () => {
    env = await boot();
    const e = env;
    const { planner, t } = await plannerArtifactTask(e);
    commitOnMain(e, 'other.txt', '다른 작업이 먼저 병합됨\n'); // 이 작업의 작업 폴더를 만든 뒤 main이 움직였다
    e.core.tasks.setSteps(t.id, ['조사']);
    writeArtifact(e, t, 'report.md', '조사 결과\n');
    await e.core.tasks.completeStep(t.id, 0, '조사', planner, null);
    const wt = t.workspace!.worktreePath;
    expect(git(wt, ['status', '--porcelain'])).toBe(''); // 이 작업은 저장소 파일을 바꾸지 않았다
    expect(git(wt, ['rev-list', '--count', `${e.project.baseBranch}..HEAD`])).toBe('0'); // 작업 브랜치에 이 작업의 커밋도 없다
    // 두 점 비교(main ↔ HEAD)에는 main 쪽 변경만 보인다 — 이 작업의 변경이 아니다
    expect(git(wt, ['diff', '--name-only', mainSha(e), 'HEAD'])).toBe('other.txt');
    e.core.tasks.requestSubmit(t.id, '제출', planner);
    await e.core.tasks.processSubmission(t.id);
    const cur = task(e, t.id);
    expect(cur.state).toBe('in_review');
    expect.soft(cur.outputMode, '추적 파일이 바뀌지 않았으면 산출물형 유지').toBe('artifact');
    expect.soft(cur.review.target?.kind, '검수 대상은 산출물 파일').toBe('artifact');
    // 지금 동작 그대로 끝까지 몰아 결과를 본다: 통과 → (변경형으로 바뀌었으면 병합 요청) → 완료
    pass(e, t.id);
    if (task(e, t.id).outputMode === 'repo') await mergeAndSettle(e, t.id);
    await waitFor(() => task(e, t.id).state === 'done', '완료');
    await sleep(50);
    const done = task(e, t.id);
    expect(done.artifact, '조사 산출물이 버전 보관돼야 한다 (REV-05)').not.toBeNull();
  });

  it('AC-47 저장소 변경형으로 계획됐어도 바뀐 파일이 없으면 빈 커밋·빈 병합 커밋 없이 검수 통과로 완료된다', async () => {
    env = await boot();
    const e = env;
    const before = mainSha(e);
    const t = await submittedTask(e, { file: null, type: 'research', reviewer: 'main' });
    expect(e.ctx.store.steps.list(t.id).map((s) => s.commitSha)).toEqual([null]);
    pass(e, t.id);
    const done = await mergeAndSettle(e, t.id);
    expect(done.state).toBe('done');
    expect(done.merge).toBeNull();
    expect(mainSha(e)).toBe(before);
    expect(execKinds(e, t.id).filter((k) => k === 'git_commit' || k === 'git_merge')).toEqual([]);
    expect(git(e.projectDir, ['rev-list', '--count', `${before}..${e.project.baseBranch}`])).toBe('0');
  });

  it('AC-47 (모의 팀 전체 흐름) 개발 작업이 먼저 병합돼 main이 움직여도, 저장소를 바꾸지 않은 기획자의 산출물형 작업은 산출물형으로 검수·보관된다', async () => {
    const h = await createHarness({ team: ['developer', 'planner'], scenarios: { planner: 'slow' } });
    try {
      const planner = h.members.planner!;
      const dev = h.members.developer!;
      const did = await sendCommand(h, '회원 가입 기능을 기획하고 만들어 줘');
      let spec = '';
      let devTask = '';
      await h.waitFor(
        () => {
          const ts = h.core.ctx.store.tasks.list({ ref1: did });
          const s = ts.find((x) => x.assigneeId === planner);
          const d = ts.find((x) => x.assigneeId === dev);
          if (s) spec = s.id;
          if (d) devTask = d.id;
          return !!s && s.state === 'in_progress' && !!s.workspace;
        },
        { intervalMs: 10, label: '기획 작업 시작' },
      );
      // 기획자가 조사하는 동안(작업 폴더는 이미 만들어짐) 개발 작업이 먼저 병합되게 한다 — 조사가 개발보다 오래 걸리는 흔한 상황
      await h.internal('members.pause', planner, 'immediate');
      expect(h.task(spec).review.target).toBeNull(); // 아직 제출 전
      await h.waitFor(() => !!devTask && h.task(devTask).state === 'done', { timeoutMs: 60_000, label: '개발 작업 병합' });
      await h.internal('members.resume', planner);
      await h.waitFor(() => h.core.ctx.store.directives.get(did)?.state === 'awaiting_confirmation', { timeoutMs: 90_000, label: '보고 도착' });
      const s = h.task(spec);
      expect(s.state).toBe('done');
      // 기획자는 저장소 파일을 바꾸지 않았다 (작업 브랜치에 기획자 커밋 없음)
      expect(h.core.ctx.store.steps.list(spec).every((x) => x.commitSha === null)).toBe(true);
      expect.soft(s.outputMode, '추적 파일 변경 없음 → 산출물형 유지').toBe('artifact');
      expect.soft(h.core.ctx.store.reviews.list({ ref1: spec }).map((r) => r.target.kind), '검수 대상은 산출물 파일').toEqual(['artifact']);
      expect(s.artifact, '기획 산출물이 검수한 버전으로 보관돼야 한다').not.toBeNull();
    } finally {
      await h.close();
    }
  }, 150_000);

  it('AC-47 (모의 팀 전체 흐름) 기획자의 산출물형 작업은 독립 검수 후 버전 보관으로 완료되고 main에 커밋·병합이 생기지 않는다', async () => {
    const h = await createHarness({ team: ['planner'] });
    try {
      const base = h.core.ctx.store.projects.require(h.projectId).baseBranch;
      const before = gitIn(h.projectDir, ['rev-parse', base]);
      const did = await sendCommand(h, '회원 가입 기능 기획서를 써 줘');
      await h.waitFor(() => h.core.ctx.store.directives.get(did)?.state === 'awaiting_confirmation', { timeoutMs: 90_000, label: '보고 도착' });
      const [t] = h.core.ctx.store.tasks.list({ ref1: did });
      expect(t).toBeDefined();
      expect(t!.assigneeId).toBe(h.members.planner);
      expect(t!.outputMode).toBe('artifact');
      expect(t!.state).toBe('done');
      expect(t!.merge).toBeNull();
      expect(t!.review.autoCheck.status).toBe('not_applicable');
      const recs = h.core.ctx.store.reviews.list({ ref1: t!.id });
      expect(recs.map((r) => `${r.reviewerId}:${r.verdict}`)).toEqual([`${h.members.producer}:pass`]);
      const passedTarget = recs[0]!.target;
      expect(passedTarget.kind).toBe('artifact');
      expect(t!.artifact?.files).toEqual(passedTarget.kind === 'artifact' ? passedTarget.files : []);
      expect(t!.artifact!.files.length).toBeGreaterThan(0);
      for (const f of t!.artifact!.files) {
        expect(createHash('sha256').update(readFileSync(join(t!.artifact!.dir, f.path))).digest('hex')).toBe(f.sha256);
      }
      expect(gitIn(h.projectDir, ['rev-parse', base])).toBe(before);
      expect(gitIn(h.projectDir, ['branch', '--list', 'task/*'])).toBe('');
      const kinds = h.core.ctx.store.execs.list({ ref1: t!.id }).map((x) => x.kind);
      expect(kinds).not.toContain('git_commit');
      expect(kinds).not.toContain('git_merge');
    } finally {
      await h.close();
    }
  }, 120_000);
});
