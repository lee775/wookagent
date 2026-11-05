/**
 * 재시작 복구 (concurrency:CONC-07, spec:F6 복구 부분, GIT-15, AC-45, 8장 자동 복구 실패 → 다시 시도).
 * - main 반영 뒤 기록 전에 끊긴 병합: 작업이 정지·보류 중이어도 병합을 기록 → 재개 때 다시 병합하지 않고 완료
 * - 소비됐거나 재시도가 끝나 사라진 관리 업무(질문 답변·회차 마감·보고 요청·병합 판단)를 저장된 상태로 다시 만든다
 * 같은 Core에서 recovery.run()을 다시 부르는 방식으로 재시작을 대신한다 (실행 중 턴 없음).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAIN_AGENT_ID, OWNER } from '@shared/domain';
import { directiveKey, mainKey } from '../../src/main/orchestrator/records';
import type { Env } from './helpers';
import { activate, boot, consumeMergeDecisions, consumeQueued, mainSha, mergeAndSettle, mergeCommitsFor, newDirective, newTask, passedTask, queued, waitFor } from './helpers';

let env: Env | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

/** runMerge가 남기는 'started' 실행 기록 + 실제 main 반영까지 하고 기록 갱신 전에 "꺼진" 상태 */
async function mergeAppliedButUnrecorded(e: Env, taskId: string): Promise<string> {
  const t = e.ctx.store.tasks.require(taskId);
  const target = t.review.passed!.target;
  if (target.kind !== 'repo') throw new Error('repo');
  e.ctx.store.execs.put({
    requestId: 'RQ-CRASH',
    kind: 'git_merge',
    projectId: e.project.id,
    taskId,
    cwd: e.project.path,
    command: `merge ${t.workspace!.branch} → ${e.project.baseBranch}`,
    target: e.project.baseBranch,
    state: 'started',
    startedAt: e.ctx.now(),
    endedAt: null,
    result: { preMainSha: target.baseMainSha, taskSha: target.taskCommitSha, branch: t.workspace!.branch },
  });
  const r = await e.ctx.deps.git.mergeIntoBase(e.project.path, {
    baseBranch: e.project.baseBranch,
    taskSha: target.taskCommitSha,
    expectedBaseSha: target.baseMainSha,
    message: `[${taskId}] 병합: ${t.title}\n\nWook-Task: ${taskId}\nWook-Request: RQ-CRASH`,
    identity: { name: '욱채', email: 'wook@wook.local' },
  });
  if (!r.ok) throw new Error(r.detail);
  return r.mergeSha;
}

describe('기록 전에 끊긴 병합 (CONC-07)', () => {
  it('긴급 정지로 보류된 작업이어도 병합을 기록하고, 정지 해제·재개 때 다시 병합하지 않고 완료', async () => {
    env = await boot();
    const e = env;
    const t = await passedTask(e, { reviewer: 'main' });
    consumeMergeDecisions(e, t.id);
    await e.core.stops.emergency(OWNER);
    const sha = await mergeAppliedButUnrecorded(e, t.id);
    await e.core.recovery.run();
    const exec = e.ctx.store.execs.get('RQ-CRASH')!;
    expect(exec.state).toBe('succeeded');
    expect(exec.result.recovered).toBe('already_applied');
    const held = e.ctx.store.tasks.require(t.id);
    expect(held.state).toBe('on_hold');
    expect(held.merge?.mergeCommitSha).toBe(sha);
    // 체크아웃된 프로젝트 폴더도 병합 결과로 맞춰져 다음 병합이 미커밋 변경으로 막히지 않는다
    expect(await e.ctx.deps.git.hasTrackedChanges(e.project.path)).toBe(false);

    e.core.stops.release(OWNER);
    e.core.tasks.resumeByOwner(t.id, MAIN_AGENT_ID);
    await waitFor(() => e.ctx.store.tasks.require(t.id).state === 'done', '재개 후 완료');
    expect(mergeCommitsFor(e, t.id)).toBe(1);
    expect(mainSha(e)).toBe(sha);
    expect(queued(e, (q) => q.kind === 'merge_decision' && q.taskId === t.id)).toHaveLength(0);
    expect(e.core.merges.requestMerge(t.id, e.producer, 'RQ-DUP').status).toBe('merged');
    await waitFor(() => !existsSync(t.workspace!.worktreePath), '작업 폴더 정리');
  });

  it('보류가 없으면 재시작 복구가 바로 완료로 마무리한다', async () => {
    env = await boot();
    const e = env;
    const t = await passedTask(e, { reviewer: 'main' });
    consumeMergeDecisions(e, t.id);
    const sha = await mergeAppliedButUnrecorded(e, t.id);
    await e.core.recovery.run();
    const done = e.ctx.store.tasks.require(t.id);
    expect(done.state).toBe('done');
    expect(done.merge?.mergeCommitSha).toBe(sha);
    expect(mergeCommitsFor(e, t.id)).toBe(1);
  });

  it('병합 기록은 있는데 완료 전에 끊긴 작업은 재시작 복구가 다시 병합하지 않고 완료', async () => {
    env = await boot();
    const e = env;
    const t = await passedTask(e, { reviewer: 'main' });
    consumeMergeDecisions(e, t.id);
    const sha = await mergeAppliedButUnrecorded(e, t.id);
    e.ctx.store.execs.put({ ...e.ctx.store.execs.get('RQ-CRASH')!, state: 'succeeded', endedAt: e.ctx.now() });
    const target = t.review.passed!.target;
    if (target.kind !== 'repo') throw new Error('repo');
    e.ctx.store.tasks.patch(t.id, { merge: { requestId: 'RQ-CRASH', taskCommitSha: target.taskCommitSha, preMainSha: target.baseMainSha, mergeCommitSha: sha, mergedAt: e.ctx.now() } });
    await e.core.recovery.run();
    expect(e.ctx.store.tasks.require(t.id).state).toBe('done');
    expect(mergeCommitsFor(e, t.id)).toBe(1);
  });
});

describe('남은 정리 (windows:F6)', () => {
  it('끝난 작업의 남은 검수 사본도 다음 시작 때 지운다', async () => {
    env = await boot();
    const e = env;
    const t = await passedTask(e, { reviewer: 'main' });
    expect((await mergeAndSettle(e, t.id)).state).toBe('done');
    // 정리 때 다른 프로그램이 잡고 있어 남은 사본
    const left = join(e.ctx.paths.review, e.project.id, `${t.id}-r1-deadbeef`);
    mkdirSync(join(left, 'src'), { recursive: true });
    writeFileSync(join(left, 'src', 'a.txt'), 'x');
    const other = join(e.ctx.paths.review, e.project.id, 'T-9999-r1-cafebabe');
    mkdirSync(other, { recursive: true });
    await e.core.recovery.run();
    expect(existsSync(left)).toBe(false);
    expect(existsSync(other)).toBe(true); // 모르는 작업의 폴더는 건드리지 않는다
  });
});

describe('관리 업무 다시 맞추기 (spec:F6 복구)', () => {
  it('프로듀서에게 온 질문의 답변 업무가 사라졌으면 다시 넣는다 (한 번만)', async () => {
    env = await boot();
    const e = env;
    const t = await activate(e, newTask(e).id);
    const dev = e.ctx.store.members.require(t.assigneeId);
    const q = e.core.tasks.askProducer(t, dev, '어떤 API를 쓰나요?', `task:${t.id}`);
    // 프로듀서 턴이 항목을 받았지만 답하지 못하고 재시도도 다 썼다
    consumeQueued(e, directiveKey(t.directiveId));
    expect(queued(e, (x) => x.kind === 'answer')).toHaveLength(0);
    await e.core.recovery.run();
    expect(queued(e, (x) => x.kind === 'answer' && x.questionId === q.id)).toHaveLength(1);
    await e.core.recovery.run();
    expect(queued(e, (x) => x.kind === 'answer' && x.questionId === q.id)).toHaveLength(1);
  });

  it('회차 작업이 모두 끝났는데 최종 결과 요청이 사라졌으면 다시 넣는다', async () => {
    env = await boot();
    const e = env;
    const directiveId = newDirective(e);
    const t = await activate(e, newTask(e, { directiveId, outputMode: 'artifact' }).id);
    await e.core.tasks.cancel(t.id, '필요 없어짐', e.producer.id);
    consumeQueued(e, directiveKey(directiveId));
    await e.core.recovery.run();
    expect(queued(e, (x) => x.kind === 'final_result' && x.directiveId === directiveId)).toHaveLength(1);
  });

  it('최종 결과는 받았는데 보고서 요청이 사라졌으면 메인 에이전트에게 다시 넣는다 (한 번만)', async () => {
    env = await boot();
    const e = env;
    const directiveId = newDirective(e);
    const t = await activate(e, newTask(e, { directiveId, outputMode: 'artifact' }).id);
    await e.core.tasks.cancel(t.id, '필요 없어짐', e.producer.id);
    consumeQueued(e, directiveKey(directiveId));
    const d = e.core.directives.submitFinalResult({ directiveId, summary: '정리', outputs: [], changedFiles: [], issues: [], nextSteps: [] }, e.producer, null);
    expect(d.state).toBe('reporting');
    consumeQueued(e, mainKey(e.project.id));
    await e.core.recovery.run();
    const reports = queued(e, (x) => x.kind === 'main_report' && x.directiveId === directiveId);
    expect(reports).toHaveLength(1);
    await e.core.recovery.run();
    expect(queued(e, (x) => x.kind === 'main_report' && x.directiveId === directiveId)).toHaveLength(1);
    expect(reports[0]!.memberId).toBe(MAIN_AGENT_ID);
  });

  it('검수를 통과한 저장소 작업의 병합 판단이 사라졌으면 다시 넣는다', async () => {
    env = await boot();
    const e = env;
    const t = await passedTask(e, { reviewer: 'main' });
    consumeMergeDecisions(e, t.id);
    e.core.recovery.reconcileManagement(e.project.id);
    expect(queued(e, (x) => x.kind === 'merge_decision' && x.taskId === t.id)).toHaveLength(1);
    // 다른 프로젝트 범위로 부르면 건드리지 않는다
    consumeMergeDecisions(e, t.id);
    e.core.recovery.reconcileManagement('P-9999');
    expect(queued(e, (x) => x.kind === 'merge_decision' && x.taskId === t.id)).toHaveLength(0);
  });
});
