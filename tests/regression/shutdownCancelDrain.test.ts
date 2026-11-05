/**
 * 앱 종료는 잠금 밖에서 git 단계를 기다리는 프로그램 작업도 기다린다 (stage-6 리뷰 process-shutdown D3 → S7-D2 — S6-E7 SHUT-1 '진행 중인 프로그램 작업이
 * 없을 때까지(상한 있음) 기다리고, 남은 작업은 다음 단계에서 멈추게', ENV-09).
 * 예전 종료는 턴·제출 처리·자동 검사·병합/되돌리기·프로젝트 잠금만 셌다. 그 밖에서 git을 기다리는 작업은 세지 않아 저장소를 바로 닫았고, 그 작업의
 * 다음 기록이 닫힌 저장소에 쓰다 실패했다('database is not open', 'statement has been finalized', '산출물 확정 실패 …'):
 * - 작업 취소(tasks.cancel)의 중간 결과 보관(archiveWorkspace)·작업 폴더 정리(cleanupWorkspace)
 * - 산출물 확정(finalizeArtifactOrHold)의 작업 공간 정리
 * - 보류 해제·재시작 복구가 부른 병합 완료 처리(finishMerged)의 정리
 * - 프로젝트 등록(git 초기화·첫 커밋) — S7-D1에서 등록 중인 폴더를 세게 되어 함께 기다린다
 * 이제 이 작업들을 종료가 기다리고(같은 상한), 작업 취소는 앱 종료 중이면 다음 git 단계로 가지 않는다(보관 전이면 취소 보류를 남겨 다음 시작의
 * 복구가 마치고, 취소 뒤 정리 전이면 정리를 다음 시작에 맡긴다). 실제 저장소·git, 가짜 CLI (stops-helpers.bootRestartable)
 * 원래 탐침: probe-archive/stage6-process-shutdown-review/tests-regression__zz-s6psr-shutdown-cancel.probe.ts
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Task } from '@shared/domain';
import { MAIN_AGENT_ID } from '@shared/domain';
import { CANCEL_HOLD_REF } from '@core/taskMachine';
import { openStore, type Store } from '../../src/main/db/store';
import { dataPaths } from '../../src/main/orchestrator/paths';
import { hashTree } from '../../src/main/orchestrator/fsutil';
import { taskKey } from '../../src/main/orchestrator/records';
import { bootRestartable, seedDirective, seedInReviewTask, sleep, waitUntil, type RestartableEnv } from '../acceptance/stops-helpers';

const boxes: RestartableEnv[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const b of boxes.splice(0).reverse()) await b.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

async function boot(): Promise<RestartableEnv> {
  const e = await bootRestartable();
  boxes.push(e);
  return e;
}

/** 같은 데이터 폴더로 새 인스턴스 (앞 인스턴스의 저장소가 닫힌 뒤 — 재시작 복구가 돈다) */
async function rebootOf(e: RestartableEnv): Promise<RestartableEnv> {
  const next = await bootRestartable({}, { dataDir: e.dataDir, projRoot: dirname(e.projectDir), projectId: e.projectId, producerId: e.producerId, devId: e.devId, qaId: e.qaId });
  boxes.push(next);
  return next;
}

/** 저장소가 닫힌 뒤 같은 DB를 따로 열어 읽는다 */
function readDb<T>(e: RestartableEnv, fn: (s: Store) => T): T {
  const store = openStore(dataPaths(e.dataDir).db);
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

/** 작업 폴더가 있는 진행 중 작업 (실제 git worktree) */
async function activeTask(e: RestartableEnv): Promise<Task> {
  const { core, ctx } = e;
  const d = seedDirective(e);
  const t = core.tasks.create({ directiveId: d.id, title: '기능', goal: '목표', type: 'development', assigneeId: e.devId, acceptanceCriteria: ['동작한다'], outputMode: 'repo' }, e.producerId);
  if (!(await core.tasks.activateForLaunch(t.id))) throw new Error('활성화 실패');
  for (const q of ctx.store.queue.list({ ref2: taskKey(t.id), state: 'queued' })) ctx.store.queue.put({ ...q, state: 'done', doneAt: ctx.now() });
  writeFileSync(join(ctx.store.tasks.require(t.id).workspace!.worktreePath, 'wip.txt'), '중간 결과\n', 'utf8');
  return ctx.store.tasks.require(t.id);
}

/** 메인 에이전트 검수(적격 팀원이 없을 때의 대체 검수, REV-06 v0.6)를 통과한 저장소 변경형 작업 (작업 폴더·커밋·제출 처리까지 실제 git) */
async function passedRepoTask(e: RestartableEnv): Promise<Task> {
  const { core, ctx } = e;
  const d = seedDirective(e);
  const t = core.tasks.create({ directiveId: d.id, title: '기능', goal: '목표', type: 'development', assigneeId: e.devId, reviewerId: MAIN_AGENT_ID, acceptanceCriteria: ['동작한다'], outputMode: 'repo' }, e.producerId);
  if (!(await core.tasks.activateForLaunch(t.id))) throw new Error('활성화 실패');
  for (const q of ctx.store.queue.list({ ref2: taskKey(t.id), state: 'queued' })) ctx.store.queue.put({ ...q, state: 'done', doneAt: ctx.now() });
  core.tasks.setSteps(t.id, ['단계 1']);
  const dev = ctx.store.members.require(e.devId);
  writeFileSync(join(ctx.store.tasks.require(t.id).workspace!.worktreePath, `${t.id}.txt`), `${t.id} 변경\n`, 'utf8');
  await core.tasks.completeStep(t.id, 0, '완료', dev, null);
  core.tasks.requestSubmit(t.id, '제출', dev);
  await core.tasks.processSubmission(t.id);
  const cur = ctx.store.tasks.require(t.id);
  if (cur.state !== 'in_review') throw new Error(`검수 상태가 아님: ${cur.state}`);
  const verdict = { verdict: 'pass' as const, criteria: cur.acceptanceCriteria.map((c) => ({ criterion: c, pass: true, note: '확인' })), reason: '' };
  const passed = core.tasks.submitReview(t.id, core.ctx.store.members.require(MAIN_AGENT_ID), verdict, null).task;
  // 메인 검수 턴의 마무리(turns.settleReview)가 하는 일 — 병합 판단을 프로듀서에게 넣는다 (이 시험은 검수 턴 없이 판정한다)
  core.merges.queueMergeDecision(ctx.store.tasks.require(t.id));
  return passed;
}

const settle = (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => 'resolved',
    (err: unknown) => `rejected: ${err instanceof Error ? err.message : String(err)}`,
  );

describe('앱 종료는 작업 취소의 git 단계를 기다린다 (S7-D2, SHUT-1)', () => {
  it('중간 결과 보관(git) 중에 끄면 — 보관이 끝날 때까지 기다리고 취소를 마친 뒤 저장소를 닫는다. 작업 폴더 정리는 다음 시작의 복구가 한다', async () => {
    const e = await boot();
    const t = await activeTask(e);
    const g = e.ctx.deps.git;
    const orig = g.archiveBranch.bind(g);
    let entered = false;
    g.archiveBranch = async (repo, branch, tag) => {
      entered = true;
      await sleep(1500); // 큰 저장소의 보관처럼 오래 걸린다
      return orig(repo, branch, tag);
    };
    const cancel = settle(e.core.tasks.cancel(t.id, '대표 취소', MAIN_AGENT_ID));
    await waitUntil(() => entered, '취소의 중간 결과 보관', 30_000);
    const t0 = Date.now();
    await e.orch.stop();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1000); // 저장소를 닫기 전에 보관을 기다렸다
    expect(await cancel).toBe('resolved');
    expect(e.errors).toEqual([]);
    const db = readDb(e, (s) => ({
      state: s.tasks.require(t.id).state,
      archive: s.execs.list({ ref1: t.id }).filter((x) => x.kind === 'git_archive').map((x) => x.state),
      removes: s.execs.list({ ref1: t.id }).filter((x) => x.kind === 'git_worktree_remove').length,
      deferred: s.activity.search({ taskId: t.id, limit: 200 }).some((a) => a.text.includes(`${t.id} 취소 — 앱 종료 중이라 작업 폴더 정리는 다음 시작 때`)),
    }));
    expect(db).toEqual({ state: 'cancelled', archive: ['succeeded'], removes: 0, deferred: true });
    expect(existsSync(t.workspace!.worktreePath)).toBe(true); // 정리는 다음 시작에

    // 다시 시작: 끝난 작업의 남은 작업 폴더를 정리한다 (recovery 2-1)
    const next = await rebootOf(e);
    const removed = next.ctx.store.execs.list({ ref1: t.id }).filter((x) => x.kind === 'git_worktree_remove');
    expect(removed.map((x) => x.state)).toEqual(['succeeded']);
    expect(existsSync(t.workspace!.worktreePath)).toBe(false);
    expect(next.ctx.store.tasks.require(t.id).state).toBe('cancelled');
    expect(next.errors).toEqual([]);
  });

  it('작업 폴더 정리(git) 중에 끄면 — 정리가 끝날 때까지 기다리고 그 기록을 남긴 뒤 저장소를 닫는다 (예전: statement has been finalized)', async () => {
    const e = await boot();
    const t = await activeTask(e);
    const g = e.ctx.deps.git;
    const orig = g.removeWorktree.bind(g);
    let entered = false;
    g.removeWorktree = async (repo, path) => {
      entered = true;
      await sleep(1500);
      return orig(repo, path);
    };
    const cancel = settle(e.core.tasks.cancel(t.id, '대표 취소', MAIN_AGENT_ID));
    await waitUntil(() => entered, '취소의 작업 폴더 정리', 30_000);
    const t0 = Date.now();
    await e.orch.stop();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1000);
    expect(await cancel).toBe('resolved');
    expect(e.errors).toEqual([]);
    const db = readDb(e, (s) => ({
      state: s.tasks.require(t.id).state,
      removes: s.execs.list({ ref1: t.id }).filter((x) => x.kind === 'git_worktree_remove').map((x) => x.state),
    }));
    expect(db).toEqual({ state: 'cancelled', removes: ['succeeded'] });
    expect(existsSync(t.workspace!.worktreePath)).toBe(false);
  });

  it('종료가 시작된 뒤에는 취소가 보관(git)으로 가지 않는다 — 취소 보류가 남아 다음 시작의 복구가 보관부터 마친다', async () => {
    const e = await boot();
    const t = await activeTask(e);
    // 대표가 취소를 누른 직후 앱을 끈다: 취소는 선택(취소 보류)을 먼저 저장하고 실행 종료를 기다리는 사이 종료가 시작된다
    const cancel = settle(e.core.tasks.cancel(t.id, '대표 취소', MAIN_AGENT_ID));
    const stop = e.orch.stop();
    expect(await cancel).toMatch(/^rejected: 앱을 종료하는 중이라 T-\d+ 취소를 마치지 못했습니다 — 취소 선택은 저장돼 있어 다음 시작 때 이어서 마칩니다$/);
    await stop;
    expect(e.errors).toEqual([]);
    const db = readDb(e, (s) => {
      const cur = s.tasks.require(t.id);
      return {
        state: cur.state,
        cancelHold: cur.hold.reasons.some((r) => r.kind === 'interrupted' && r.refId === CANCEL_HOLD_REF),
        archive: s.execs.list({ ref1: t.id }).filter((x) => x.kind === 'git_archive').length,
      };
    });
    expect(db).toEqual({ state: 'on_hold', cancelHold: true, archive: 0 });

    // 다시 시작: 끊긴 취소를 마친다 (recovery 2-2) — 보관한 뒤 취소, 작업 폴더 정리
    const next = await rebootOf(e);
    const cur = next.ctx.store.tasks.require(t.id);
    expect(cur.state).toBe('cancelled');
    expect(next.ctx.store.execs.list({ ref1: t.id }).filter((x) => x.kind === 'git_archive').map((x) => x.state)).toEqual(['succeeded']);
    expect(existsSync(t.workspace!.worktreePath)).toBe(false);
    expect(next.errors).toEqual([]);
  });

  it('상한을 넘겨도: 보관을 기다리던 취소는 그 git 단계가 끝나면 마치고(정리는 다음 시작에) 그 뒤에 저장소를 닫는다 — 닫힌 저장소에 쓰지 않는다', async () => {
    const e = await boot();
    const t = await activeTask(e);
    const g = e.ctx.deps.git;
    const orig = g.archiveBranch.bind(g);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered = false;
    g.archiveBranch = async (repo, branch, tag) => {
      entered = true;
      await gate; // 상한보다 오래 걸린다
      return orig(repo, branch, tag);
    };
    e.ctx.deps.timing!.shutdownDrainMs = 300;
    const cancel = settle(e.core.tasks.cancel(t.id, '대표 취소', MAIN_AGENT_ID));
    await waitUntil(() => entered, '취소의 중간 결과 보관', 30_000);
    const t0 = Date.now();
    await e.orch.stop();
    expect(Date.now() - t0).toBeLessThan(5000); // 걸린 git을 끝까지 기다리지 않았다
    expect(e.core.tasks.hasCancelling()).toBe(true);
    release();
    expect(await cancel).toBe('resolved');
    await waitUntil(() => !e.core.tasks.hasCancelling(), '남은 취소 끝');
    await sleep(200); // 저장소를 닫기까지
    expect(e.errors).toEqual([]);
    expect(readDb(e, (s) => s.tasks.require(t.id).state)).toBe('cancelled');
  });
});

describe('앱 종료는 완료 마무리(산출물 확정·재개가 부른 병합 완료 처리)와 프로젝트 등록을 기다린다 (S7-D2)', () => {
  it('산출물 확정의 작업 공간 정리 중에 끄면 — 정리가 끝날 때까지 기다린다. 확정 실패로 기록하지 않는다 (예전: 산출물 확정 실패 … statement has been finalized)', async () => {
    const e = await boot();
    const { core, ctx } = e;
    const d = seedDirective(e);
    const t = seedInReviewTask(e, { directiveId: d.id, assigneeId: e.devId, reviewerId: e.qaId, title: '문서' });
    const copy = core.tasks.reviewCopyOf(ctx.store.tasks.require(t.id))!;
    writeFileSync(join(copy, 'a.md'), '# 문서\n', 'utf8');
    const files = hashTree(copy);
    const cur = ctx.store.tasks.require(t.id);
    const target = { kind: 'artifact' as const, files, version: 1, pinnedAt: cur.review.target!.pinnedAt };
    ctx.store.tasks.patch(t.id, { review: { ...cur.review, target, passed: { reviewId: 'R-test', reviewerId: e.qaId, at: ctx.now(), target } } });
    let entered = false;
    const orig = core.tasks.removeReviewCopies.bind(core.tasks);
    core.tasks.removeReviewCopies = async (task) => {
      entered = true;
      await sleep(1500);
      return orig(task);
    };
    core.merges.finalizeArtifactOrHold(t.id);
    await waitUntil(() => entered, '산출물 확정 뒤 정리', 30_000);
    const t0 = Date.now();
    await e.orch.stop();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1000);
    expect(e.errors).toEqual([]);
    const db = readDb(e, (s) => ({
      state: s.tasks.require(t.id).state,
      finalized: s.activity.search({ taskId: t.id, limit: 200 }).some((a) => a.text.startsWith(`${t.id} 산출물 v1 확정·보관`)),
      failNotice: s.notifications.list().some((n) => n.title === '산출물 확정 실패'),
    }));
    expect(db).toEqual({ state: 'done', finalized: true, failNotice: false });
    expect(existsSync(copy)).toBe(false);
  });

  it('병합이 반영된 채 보류된 작업을 메인 에이전트가 재개한 직후 끄면 — 재개가 부른 병합 완료 처리(작업 폴더 정리)를 기다린다 (예전: 병합 완료 후 처리 실패)', async () => {
    const e = await boot();
    const { core, ctx } = e;
    const t = await passedRepoTask(e);
    // 병합 도중 대표 중단으로 보류 → main 반영은 기록되고 완료는 재개 때 (CTL-10)
    const g = ctx.deps.git;
    const origMerge = g.mergeIntoBase.bind(g);
    let releaseMerge!: () => void;
    const mergeGate = new Promise<void>((r) => (releaseMerge = r));
    let merging = false;
    g.mergeIntoBase = async (repo, o) => {
      merging = true;
      await mergeGate;
      return origMerge(repo, o);
    };
    for (const q of ctx.store.queue.list({ state: 'queued' })) if (q.kind === 'merge_decision' && q.taskId === t.id) ctx.store.queue.put({ ...q, state: 'done', doneAt: ctx.now() });
    expect(core.merges.requestMerge(t.id, ctx.store.members.require(e.producerId), null).status).toBe('queued');
    await waitUntil(() => merging, '병합 반영 중', 30_000);
    core.tasks.hold(t.id, 'interrupted', 'task', '대표 중단', MAIN_AGENT_ID);
    releaseMerge();
    await waitUntil(() => !core.merges.hasPending() && !!ctx.store.tasks.require(t.id).merge, '병합 기록 (보류 중)', 30_000);
    expect(ctx.store.tasks.require(t.id).state).toBe('on_hold');

    const origRemove = g.removeWorktree.bind(g);
    let entered = false;
    g.removeWorktree = async (repo, path) => {
      entered = true;
      await sleep(1500);
      return origRemove(repo, path);
    };
    core.tasks.resumeByOwner(t.id, MAIN_AGENT_ID); // 보류 해제 → afterRelease → finishMerged (잠금 밖)
    await waitUntil(() => entered, '재개 뒤 병합 완료 처리의 정리', 30_000);
    expect(core.locks.busy() || core.merges.hasPending()).toBe(false); // 예전 종료가 세던 것에는 잡히지 않는다
    const t0 = Date.now();
    await e.orch.stop();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1000);
    expect(e.errors).toEqual([]);
    const db = readDb(e, (s) => ({
      state: s.tasks.require(t.id).state,
      removes: s.execs.list({ ref1: t.id }).filter((x) => x.kind === 'git_worktree_remove').map((x) => x.state),
    }));
    expect(db).toEqual({ state: 'done', removes: ['succeeded'] });
  });

  it('프로젝트 등록(git 초기화·첫 커밋) 중에 끄면 — 등록이 끝나 저장될 때까지 기다린다', async () => {
    const e = await boot();
    const root = mkdtempSync(join(tmpdir(), 'wook-test-reg-'));
    dirs.push(root);
    const g = e.ctx.deps.git;
    const orig = g.ensureRepo.bind(g);
    let entered = false;
    g.ensureRepo = async (dir, o) => {
      entered = true;
      await sleep(1500);
      return orig(dir, o);
    };
    const reg = settle(e.core.projects.create({ mode: 'new', path: join(root, '새 프로젝트'), name: '새 프로젝트' }, MAIN_AGENT_ID));
    await waitUntil(() => entered, '프로젝트 등록의 git 초기화', 30_000);
    const t0 = Date.now();
    await e.orch.stop();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1000);
    expect(await reg).toBe('resolved');
    expect(e.errors).toEqual([]);
    expect(readDb(e, (s) => s.projects.list().map((p) => p.name))).toContain('새 프로젝트');
  });
});
