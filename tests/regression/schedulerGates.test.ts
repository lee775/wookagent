/**
 * 작업 세션 턴을 띄우는 조건 (concurrency:CONC-03, spec:F12, 5.3 진행→검수, REV-08).
 * - 제출 처리(최신 main 반영·자동 검사·대상 고정) 중에는 같은 작업 폴더에 새 턴을 띄우지 않는다 — 검사하지 않은 버전이 고정되지 않게
 * - 검수 중에는 작업 세션 턴을 띄우지 않는다 — 메시지는 재작업 때 다음 할 일과 함께 전달된다. 통과해도 대표 직접 메시지가 남아 있으면
 *   완료하지 않고 진행으로 돌려(반려 아님) 먼저 전달한다 (AC-36, REV-08)
 * - 검사 중 작업 버전이 바뀌면 고정하지 않고, main이 더 움직였으면 검사한 기준으로 고정한다 (병합 단계가 다시 확인)
 * 실제 git, 가짜 CLI·자동 검사 프로세스 (orchHarness).
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { taskKey } from '../../src/main/orchestrator/records';
import type { FakeProc, OrchEnv } from './orchHarness';
import { bootOrch, seedDirective, sleep, waitFor } from './orchHarness';

let env: OrchEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const git = (cwd: string, args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim();
const taskTurns = (e: OrchEnv, taskId: string) => e.ctx.store.turns.list().filter((t) => t.taskId === taskId && t.sessionKind === 'task');

/** 작업 턴에서 단계 완료·제출을 하고 턴을 끝낸다 → 제출 처리가 자동 검사에서 멈춰 있는 상태 */
async function submitAndHoldCheck(e: OrchEnv): Promise<{ taskId: string; wt: string; check: FakeProc; headAtCheck: string; mainBefore: string }> {
  const d = seedDirective(e);
  const t = e.core.tasks.create({ directiveId: d.id, title: '구현', goal: '목표', type: 'development', assigneeId: e.devId, acceptanceCriteria: ['동작'], outputMode: 'repo' }, e.producerId);
  e.hold.add(taskKey(t.id));
  e.tick();
  await waitFor(() => !!e.liveProc(taskKey(t.id)), '작업 턴');
  const proc = e.liveProc(taskKey(t.id))!;
  const wt = e.ctx.store.tasks.require(t.id).workspace!.worktreePath;
  expect((await e.tool(proc.turnId, 'set_steps', { steps: ['구현'] })).ok).toBe(true);
  writeFileSync(join(wt, 'feature.txt'), '기능\n', 'utf8');
  expect((await e.tool(proc.turnId, 'complete_step', { step_index: 0, note: '완료' })).ok).toBe(true);
  expect((await e.tool(proc.turnId, 'submit_for_review', { note: '제출' })).ok).toBe(true);
  let check!: FakeProc;
  e.check = (p) => (check = p); // 끝내기 전까지 검사 중
  const mainBefore = git(e.projectDir, ['rev-parse', 'HEAD']);
  proc.finishOk();
  await waitFor(() => !!check, '자동 검사 시작');
  return { taskId: t.id, wt, check, headAtCheck: git(wt, ['rev-parse', 'HEAD']), mainBefore };
}

describe('제출 처리 중 작업 세션 턴 (CONC-03)', () => {
  it('자동 검사 중 대표 메시지가 와도 그 작업 폴더에 턴을 띄우지 않고, 검사한 버전이 고정된다', async () => {
    env = await bootOrch({ checkCommands: ['npm test'] });
    const e = env;
    const { taskId, check, headAtCheck } = await submitAndHoldCheck(e);
    expect(e.core.tasks.isSubmitting(taskId)).toBe(true);
    await e.main('instruct_member', { member_id: e.devId, text: '테스트 범위도 확인해 주세요', urgent: true });
    e.tick();
    await sleep(50);
    expect(taskTurns(e, taskId)).toHaveLength(1);

    check.exit(0);
    await waitFor(() => e.ctx.store.tasks.require(taskId).state === 'in_review', '검수로');
    const target = e.ctx.store.tasks.require(taskId).review.target;
    expect(target?.kind === 'repo' && target.taskCommitSha).toBe(headAtCheck);
  });
});

describe('검수 중 작업 세션 턴 (F12, REV-08)', () => {
  it('검수 중에는 메시지가 와도 작업 턴을 띄우지 않고, 반려되면 반려 사유와 함께 한 턴에 전달한다', async () => {
    env = await bootOrch({ checkCommands: ['npm test'] });
    const e = env;
    const { taskId, check } = await submitAndHoldCheck(e);
    check.exit(0);
    await waitFor(() => e.ctx.store.tasks.require(taskId).state === 'in_review', '검수로');
    await e.main('instruct_member', { member_id: e.devId, text: '로그 형식도 맞춰 주세요', urgent: true });
    e.tick();
    await sleep(50);
    expect(taskTurns(e, taskId)).toHaveLength(1); // 검수 대상 작업 폴더를 건드리지 않는다
    expect(e.ctx.store.queue.list({ ref2: taskKey(taskId), state: 'queued' }).map((q) => q.kind)).toEqual(['message']);

    const producer = e.ctx.store.members.require(e.producerId);
    e.core.tasks.submitReview(taskId, producer, { verdict: 'reject', criteria: [{ criterion: '동작', pass: false, note: '예외 처리 없음' }], reason: '예외 처리 필요' }, null);
    e.hold.delete(taskKey(taskId));
    await e.drain(1);
    const turns = taskTurns(e, taskId);
    expect(turns).toHaveLength(2);
    const msg = e.launches.filter((l) => l.workKey === taskKey(taskId))[1]!.message;
    expect(msg).toContain('로그 형식도 맞춰 주세요');
    expect(msg).toContain('예외 처리 필요');
  });

  it('검수 중에 온 대표 메시지가 남은 채 검수를 통과하면 병합하지 않고 진행으로 돌려(반려 아님) 같은 세션 다음 턴 맨 앞에 전달하고, 다시 제출한 버전을 새로 검수해 병합한다 (AC-36, REV-08)', async () => {
    env = await bootOrch({ checkCommands: ['npm test'] });
    const e = env;
    const key = (id: string) => taskKey(id);
    const { taskId, check, mainBefore } = await submitAndHoldCheck(e);
    check.exit(0);
    await waitFor(() => e.ctx.store.tasks.require(taskId).state === 'in_review', '검수로');
    const sent = await e.main('instruct_member', { member_id: e.devId, text: '고생했어요', urgent: true });
    expect(sent.note).toContain('검수 중');
    const producer = e.ctx.store.members.require(e.producerId);
    const pass = { verdict: 'pass' as const, criteria: [{ criterion: '동작', pass: true, note: '확인' }], reason: '' };
    const first = e.core.tasks.submitReview(taskId, producer, pass, null);
    // 통과는 기록하되 완료(병합)로 가지 않고 진행으로 돌린다 — 반려로 세지 않는다
    expect(first.reopenedForOwnerMessage).toBe(true);
    const reopened = e.ctx.store.tasks.require(taskId);
    expect([reopened.state, reopened.review.rejectsInRound, reopened.review.rejectsTotal, reopened.review.target]).toEqual(['in_progress', 0, 0, null]);
    expect(() => e.core.merges.requestMerge(taskId, producer, null)).toThrow(/검수 상태가 아닙니다/);
    expect(git(e.projectDir, ['rev-parse', 'HEAD'])).toBe(mainBefore);
    // 같은 업무 세션(같은 CLI 세션 이어하기)의 다음 턴 맨 앞에 대표 메시지, 그 뒤에 다시 제출 안내
    e.tick();
    await waitFor(() => taskTurns(e, taskId).length === 2 && !!e.liveProc(key(taskId)), '대표 메시지 전달 턴');
    const launches = e.launches.filter((l) => l.workKey === key(taskId));
    expect(launches[1]!.resume).toBe(launches[0]!.newSessionId);
    expect(launches[1]!.message).toMatch(/### 1\. 메시지 확인 \(긴급 지시 우선 전달\)\n> 메인 에이전트 긴급 지시[^\n]*고생했어요/);
    expect(launches[1]!.message).toMatch(/### 2\. 작업\n> 검수 중에 긴급 지시가 도착해/);
    expect(e.ctx.store.messages.list({ ref1: e.devId }).map((m) => !!m.deliveredAt)).toEqual([true]);
    // 다시 제출 → 다시 검사·고정 → 새로 검수 → 병합
    e.check = null;
    const p = e.liveProc(key(taskId))!;
    expect((await e.tool(p.turnId, 'submit_for_review', { note: '대표 메시지 확인' })).ok).toBe(true);
    p.finishOk();
    await waitFor(() => e.ctx.store.tasks.require(taskId).state === 'in_review', '다시 검수로');
    expect(e.core.tasks.submitReview(taskId, producer, pass, null).reopenedForOwnerMessage).toBeFalsy();
    expect(e.core.merges.requestMerge(taskId, producer, null).status).toBe('queued');
    await waitFor(() => e.ctx.store.tasks.require(taskId).state === 'done' && !e.core.merges.isPending(taskId), '병합 완료');
    await sleep(50);
    const done = e.ctx.store.tasks.require(taskId);
    expect(done.review.rejectsTotal).toBe(0);
    expect(e.ctx.store.reviews.list({ ref1: taskId }).map((r) => r.verdict)).toEqual(['pass', 'pass']);
    expect(git(e.projectDir, ['rev-parse', 'HEAD'])).not.toBe(mainBefore);
    // 대표 메시지는 전달됐다 — 정리되거나 '전달 못 함'으로 알리지 않는다
    expect(e.ctx.store.queue.list({ ref2: key(taskId) }).filter((q) => q.urgent).map((q) => q.state)).toEqual(['done']);
    expect(e.ctx.store.notifications.list().filter((n) => n.title === '긴급 지시 전달 못 함')).toEqual([]);
  });
});

describe('고정은 검사한 조합으로만 (CONC-03 4번)', () => {
  it('자동 검사 중 작업 폴더에 커밋이 생기면 고정하지 않고 다시 제출하게 한다', async () => {
    env = await bootOrch({ checkCommands: ['npm test'] });
    const e = env;
    const { taskId, wt, check } = await submitAndHoldCheck(e);
    writeFileSync(join(wt, 'late.txt'), '늦은 변경\n', 'utf8');
    git(wt, ['add', 'late.txt']);
    git(wt, ['commit', '-q', '-m', '검사 중 변경']);
    check.exit(0);
    await waitFor(() => !e.core.tasks.isSubmitting(taskId), '제출 처리 끝');
    const cur = e.ctx.store.tasks.require(taskId);
    expect(cur.state).toBe('in_progress');
    expect(cur.pendingSubmit).toBeNull();
    expect(cur.review.target).toBeNull();
    const next = e.ctx.store.queue.list({ ref2: taskKey(taskId), state: 'queued' });
    expect(next.map((q) => q.kind)).toEqual(['task_work']);
    expect(next[0]!.message).toContain('자동 검사 중에 작업 버전이 바뀌었습니다');
  });

  it('자동 검사 중 main이 더 움직이면 검사한 기준(main)으로 고정한다 — 병합 단계가 기준 변경으로 다시 확인', async () => {
    env = await bootOrch({ checkCommands: ['npm test'] });
    const e = env;
    const { taskId, check, mainBefore } = await submitAndHoldCheck(e);
    writeFileSync(join(e.projectDir, 'other.txt'), '다른 작업\n', 'utf8');
    git(e.projectDir, ['add', 'other.txt']);
    git(e.projectDir, ['commit', '-q', '-m', 'main: 다른 작업']);
    const mainAfter = git(e.projectDir, ['rev-parse', 'HEAD']);
    check.exit(0);
    await waitFor(() => e.ctx.store.tasks.require(taskId).state === 'in_review', '검수로');
    const target = e.ctx.store.tasks.require(taskId).review.target!;
    expect(target.kind).toBe('repo');
    if (target.kind !== 'repo') return;
    expect(target.baseMainSha).toBe(mainBefore);
    expect(target.baseMainSha).not.toBe(mainAfter);
  });
});
