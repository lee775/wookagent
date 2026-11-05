/**
 * 병합 파이프라인 회귀 (spec:F2, concurrency:CONC-02, CONC-06(c), spec:F13, CONC-07(3), spec:F3).
 * 실제 git·저장소. 대표 조작(정지·취소)은 병합 처리의 git 대기 구간 안에서 일어나도록 git 메서드를 감싸 끼워 넣는다.
 * - main 반영 전의 정지·취소 → 병합하지 않고 멈춤, 재개되면 병합 판단부터 다시
 * - main 반영 뒤의 정지·취소 → 병합 실패·병합 보류로 다루지 않고 기록 → 재개 때 다시 병합하지 않고 완료 (5.3 보류→검수→완료)
 * - 기준 main 변경 → 잠금 밖에서 재검사·재고정 (GIT-06), 이미 반영된 병합은 다시 만들지 않음 (GIT-15)
 */
import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { MAIN_AGENT_ID, OWNER } from '@shared/domain';
import { BackendError } from '../../src/main/backend/types';
import type { Env } from './helpers';
import { boot, commitOnMain, git, mainSha, mergeAndSettle, mergeCommitsFor, notices, pass, passedTask, queued, sleep, waitFor } from './helpers';

let env: Env | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const kinds = (env: Env, id: string) => env.ctx.store.tasks.require(id).hold.reasons.map((r) => r.kind);

describe('병합 도중 정지·취소 (main 반영 전)', () => {
  it('프로젝트 일시정지가 병합 확인 중에 오면 main은 그대로, 병합 보류·실패 알림 없이 멈추고 재개 후 다시 병합해 완료', async () => {
    env = await boot();
    const e = env;
    const t = await passedTask(e, { reviewer: 'main' });
    const before = mainSha(e);
    const g = e.ctx.deps.git;
    const origStatus = g.status.bind(g);
    let armed = true;
    g.status = async (dir) => {
      if (armed && dir === t.workspace!.worktreePath && e.core.merges.isPending(t.id)) {
        armed = false;
        await e.core.stops.pauseProject(e.project.id, 'graceful', MAIN_AGENT_ID);
      }
      return origStatus(dir);
    };
    const held = await mergeAndSettle(e, t.id);
    expect(mainSha(e)).toBe(before);
    expect(held.state).toBe('on_hold');
    expect(kinds(e, t.id)).toEqual(['paused']);
    expect(held.merge).toBeNull();
    expect(held.review.passed).not.toBeNull();
    expect(notices(e, '병합 실패')).toHaveLength(0);

    e.core.stops.resumeProject(e.project.id, MAIN_AGENT_ID);
    expect(e.ctx.store.tasks.require(t.id).state).toBe('in_review');
    expect(queued(e, (q) => q.kind === 'merge_decision' && q.taskId === t.id)).toHaveLength(1);
    const done = await mergeAndSettle(e, t.id);
    expect(done.state).toBe('done');
    expect(mergeCommitsFor(e, t.id)).toBe(1);
    expect(existsSync(t.workspace!.worktreePath)).toBe(false);
  });

  it('작업 취소가 병합 확인 중에 오면 병합하지 않고 취소된다 (취소는 진행 중 병합이 끝나기를 기다림)', async () => {
    env = await boot();
    const e = env;
    const t = await passedTask(e, { reviewer: 'main' });
    const before = mainSha(e);
    const g = e.ctx.deps.git;
    const origRev = g.revParse.bind(g);
    let cancelP: Promise<void> | null = null;
    g.revParse = async (dir, ref) => {
      if (!cancelP && dir === e.project.path && ref === `refs/heads/${e.project.baseBranch}` && e.core.merges.isPending(t.id)) {
        cancelP = e.core.tasks.cancel(t.id, '대표 취소', MAIN_AGENT_ID);
      }
      return origRev(dir, ref);
    };
    await mergeAndSettle(e, t.id);
    expect(cancelP).not.toBeNull();
    await cancelP;
    const c = e.ctx.store.tasks.require(t.id);
    expect(c.state).toBe('cancelled');
    expect(mainSha(e)).toBe(before);
    expect(git(e.projectDir, ['rev-parse', '--verify', `refs/wook/archive/${t.id}-cancel`])).toMatch(/^[0-9a-f]{40}$/);
    expect(notices(e, '병합 실패')).toHaveLength(0);
  });
});

describe('병합 도중 정지·취소 (main 반영 중)', () => {
  it('긴급 정지가 main 반영 중에 오면 병합을 기록해 두고 보류, 정지 해제·항목 재개 때 다시 병합하지 않고 완료', async () => {
    env = await boot();
    const e = env;
    const t = await passedTask(e, { reviewer: 'main' });
    const g = e.ctx.deps.git;
    const origMerge = g.mergeIntoBase.bind(g);
    let armed = true;
    g.mergeIntoBase = async (dir, o) => {
      if (armed) {
        armed = false;
        await e.core.stops.emergency(OWNER);
      }
      return origMerge(dir, o);
    };
    const held = await mergeAndSettle(e, t.id);
    expect(mergeCommitsFor(e, t.id)).toBe(1);
    expect(held.state).toBe('on_hold');
    expect(kinds(e, t.id)).toEqual(['emergency_stop']); // merge_blocked 없음
    expect(held.merge?.mergeCommitSha).toBe(mainSha(e));
    expect(notices(e, '병합 실패')).toHaveLength(0);
    // 완료·정리는 재개 때 (CTL-10)
    expect(existsSync(t.workspace!.worktreePath)).toBe(true);

    e.core.stops.release(OWNER);
    e.core.tasks.resumeByOwner(t.id, MAIN_AGENT_ID);
    await waitFor(() => e.ctx.store.tasks.require(t.id).state === 'done', '재개 후 완료');
    await waitFor(() => !existsSync(t.workspace!.worktreePath), '작업 폴더 정리');
    expect(mergeCommitsFor(e, t.id)).toBe(1);
    expect(queued(e, (q) => q.kind === 'merge_decision' && q.taskId === t.id)).toHaveLength(0);
    expect(e.core.merges.requestMerge(t.id, e.producer, null).status).toBe('merged');
  });

  it('작업 취소가 main 반영 중에 오면 취소하지 않는다 — 병합 결과를 유지하고 완료 (AC-46)', async () => {
    env = await boot();
    const e = env;
    const t = await passedTask(e, { reviewer: 'main' });
    const g = e.ctx.deps.git;
    const origMerge = g.mergeIntoBase.bind(g);
    let cancelP: Promise<void> | null = null;
    g.mergeIntoBase = async (dir, o) => {
      cancelP ??= e.core.tasks.cancel(t.id, '대표 취소', MAIN_AGENT_ID);
      return origMerge(dir, o);
    };
    await mergeAndSettle(e, t.id);
    const err = await cancelP!.then(
      () => null,
      (x: unknown) => x,
    );
    expect(err).toBeInstanceOf(BackendError);
    expect((err as BackendError).code).toBe('conflict');
    await waitFor(() => e.ctx.store.tasks.require(t.id).state === 'done', '병합 완료');
    expect(mergeCommitsFor(e, t.id)).toBe(1);
    expect(e.ctx.store.tasks.require(t.id).hold.reasons).toEqual([]);
  });
});

describe('기준 main 변경 (GIT-06·15)', () => {
  it('통과 뒤 main이 바뀌면 잠금을 푼 뒤 최신 main 반영·검사·재고정 → 재검수 (반려 아님) → 병합', async () => {
    env = await boot();
    const e = env;
    const t = await passedTask(e, { reviewer: 'main' });
    const moved = commitOnMain(e, 'other.txt', '다른 작업의 변경\n');
    const holders: (string | null)[] = [];
    const checks = e.core.checks;
    const origRun = checks.run.bind(checks);
    checks.run = async (task, project, cwd) => {
      holders.push(e.core.locks.holder(project.id));
      return origRun(task, project, cwd);
    };
    await mergeAndSettle(e, t.id);
    await waitFor(() => e.ctx.store.tasks.require(t.id).state === 'in_review' && !e.core.tasks.isSubmitting(t.id), '재고정');
    const r = e.ctx.store.tasks.require(t.id);
    expect(holders).toEqual([null]); // 자동 검사는 병합 잠금 밖에서
    expect(r.review.target?.kind === 'repo' && r.review.target.baseMainSha).toBe(moved);
    expect(r.review.passed).toBeNull();
    expect(r.review.rejectsInRound).toBe(0);
    expect(r.merge).toBeNull();
    expect(mergeCommitsFor(e, t.id)).toBe(0);

    pass(e, t.id);
    const done = await mergeAndSettle(e, t.id);
    expect(done.state).toBe('done');
    expect(mergeCommitsFor(e, t.id)).toBe(1);
  });

  it('이미 main에 반영된 병합(기록 전에 끊김)은 다시 병합하지 않고 기록만 확정해 완료', async () => {
    env = await boot();
    const e = env;
    const t = await passedTask(e, { reviewer: 'main' });
    const target = t.review.passed!.target;
    if (target.kind !== 'repo') throw new Error('repo target');
    const r = await e.ctx.deps.git.mergeIntoBase(e.project.path, {
      baseBranch: e.project.baseBranch,
      taskSha: target.taskCommitSha,
      expectedBaseSha: target.baseMainSha,
      message: `[${t.id}] 병합: ${t.title}\n\nWook-Task: ${t.id}\nWook-Request: RQ-LOST`,
      identity: { name: '욱채', email: 'wook@wook.local' },
    });
    expect(r.ok).toBe(true);
    const done = await mergeAndSettle(e, t.id);
    expect(done.state).toBe('done');
    expect(done.merge?.mergeCommitSha).toBe(r.ok ? r.mergeSha : '');
    expect(mergeCommitsFor(e, t.id)).toBe(1);
  });
});

describe('병합 보류 해제 경로 (spec:F3)', () => {
  it('프로젝트 폴더 미커밋 변경으로 병합 보류 → 정리 후 메인 에이전트 재개 → 병합 판단부터 다시 → 완료', async () => {
    env = await boot();
    const e = env;
    commitOnMain(e, 'README.md', '원본\n');
    const t = await passedTask(e, { reviewer: 'main' });
    writeFileSync(join(e.projectDir, 'README.md'), '대표가 고치는 중\n', 'utf8');
    const held = await mergeAndSettle(e, t.id);
    expect(held.state).toBe('on_hold');
    expect(kinds(e, t.id)).toEqual(['merge_blocked']);
    expect(notices(e, '병합 보류')).toHaveLength(1);

    git(e.projectDir, ['checkout', '--', 'README.md']);
    const resumed = e.core.tasks.resumeByOwner(t.id, MAIN_AGENT_ID);
    expect(resumed.state).toBe('in_review');
    expect(queued(e, (q) => q.kind === 'merge_decision' && q.taskId === t.id)).toHaveLength(1);
    const done = await mergeAndSettle(e, t.id);
    expect(done.state).toBe('done');
    expect(mergeCommitsFor(e, t.id)).toBe(1);
  });

  it('되돌리기가 이후 변경과 충돌하면 재계획 보류 → 프로듀서 replan_task로 다시 진행', async () => {
    env = await boot();
    const e = env;
    const t = await passedTask(e, { reviewer: 'main', file: 'shared.txt', content: '첫 버전\n' });
    expect((await mergeAndSettle(e, t.id)).state).toBe('done');
    commitOnMain(e, 'shared.txt', '이후 작업이 고친 버전\n');
    const res = await e.core.merges.requestRevert(t.id, e.producer, '잘못된 변경');
    expect(res.mode).toBe('revert_task');
    const rt = e.ctx.store.tasks.require(res.revertTaskId!);
    expect(rt.state).toBe('on_hold');
    expect(rt.hold.reasons.map((r) => r.kind)).toEqual(['replan']);
    expect(queued(e, (q) => q.kind === 'replan' && q.taskId === rt.id)).toHaveLength(1);

    const after = e.core.tasks.replan(rt.id, { note: '충돌 파일은 직접 되돌림' }, e.producer.id);
    expect(after.state).toBe('in_progress');
    expect(queued(e, (q) => q.kind === 'task_work' && q.taskId === rt.id)).toHaveLength(1);
    await sleep(10);
  });
});
