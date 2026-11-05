/**
 * 앱 종료와 진행 중인 프로그램 작업 (SHUT-1, ENV-09, GIT-13·15, 9장 재시작 순서).
 * 턴과 턴 사이에 프로그램이 하는 작업(병합 마무리·작업 공간 정리·제출 처리·되돌리기 단계)이 돌고 있을 때 앱을 끄면:
 * - 종료는 그 작업이 다음 단계에서 멈추거나 끝날 때까지(상한 있음) 기다린 뒤 저장소를 닫는다 — 예전에는 바로 닫아 남은 처리가 닫힌 저장소에 쓰다
 *   실패했다 ('병합 완료 후 처리 실패 … statement has been finalized')
 * - 상한을 넘기면 기다리지 않고 끝내되, 남은 작업은 지금 기다리는 git 단계가 끝나면 다음 단계 확인(앱 종료 중)에서 멈추고 그 뒤에 저장소를 닫는다
 * - 어느 쪽이든 같은 데이터 폴더로 다시 시작하면 복구가 이어 간다 (병합 판단부터 다시·이미 반영된 병합은 기록만)
 * 실제 저장소·git, 가짜 CLI (stops-helpers.bootRestartable)
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Task } from '@shared/domain';
import { MAIN_AGENT_ID, OWNER } from '@shared/domain';
import { openStore } from '../../src/main/db/store';
import { dataPaths } from '../../src/main/orchestrator/paths';
import { taskKey } from '../../src/main/orchestrator/records';
import { bootRestartable, seedDirective, sleep, waitUntil, type RestartableEnv } from '../acceptance/stops-helpers';

const boxes: RestartableEnv[] = [];
afterEach(async () => {
  for (const b of boxes.splice(0).reverse()) await b.close().catch(() => undefined);
});

const git = (cwd: string, args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
const mainSha = (e: RestartableEnv) => git(e.projectDir, ['rev-parse', 'refs/heads/main']);
const mergeCommits = (e: RestartableEnv, taskId: string) =>
  git(e.projectDir, ['log', '--merges', '--format=%s', 'refs/heads/main'])
    .split(/\r?\n/)
    .filter((l) => l.startsWith(`[${taskId}] 병합`)).length;

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

function consumeMergeDecisions(e: RestartableEnv, taskId: string): void {
  for (const q of e.ctx.store.queue.list({ state: 'queued' })) if (q.kind === 'merge_decision' && q.taskId === taskId) e.ctx.store.queue.put({ ...q, state: 'done', doneAt: e.ctx.now() });
}

function requestMerge(e: RestartableEnv, taskId: string): void {
  consumeMergeDecisions(e, taskId);
  const r = e.core.merges.requestMerge(taskId, e.ctx.store.members.require(e.producerId), null);
  expect(r.status).toBe('queued');
}

/** 같은 데이터 폴더로 새 인스턴스 (앞 인스턴스의 저장소가 닫힌 뒤) */
function rebootOf(e: RestartableEnv): Promise<RestartableEnv> {
  return bootRestartable({}, { dataDir: e.dataDir, projRoot: dirname(e.projectDir), projectId: e.projectId, producerId: e.producerId, devId: e.devId, qaId: e.qaId });
}

describe('앱 종료는 진행 중인 프로그램 작업을 기다린 뒤 저장소를 닫는다 (SHUT-1)', () => {
  it('병합이 main에 반영된 뒤 마무리(작업 폴더 정리) 중에 끄면 — 그 마무리가 끝날 때까지 기다려 완료·정리 기록이 남고 오류가 없다', async () => {
    const e = await bootRestartable();
    boxes.push(e);
    const t = await passedRepoTask(e);
    const g = e.ctx.deps.git;
    const orig = g.removeWorktree.bind(g);
    let entered = false;
    g.removeWorktree = async (repo, path) => {
      entered = true;
      await sleep(1500); // 큰 작업 폴더 삭제처럼 오래 걸린다
      return orig(repo, path);
    };
    requestMerge(e, t.id);
    await waitUntil(() => entered, '병합 마무리(작업 폴더 정리) 시작', 30_000);
    const t0 = Date.now();
    await e.orch.stop();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1000); // 저장소를 닫기 전에 마무리를 기다렸다
    expect(e.errors).toEqual([]);
    const store = openStore(dataPaths(e.dataDir).db);
    try {
      const done = store.tasks.require(t.id);
      expect([done.state, !!done.merge]).toEqual(['done', true]);
      const removed = store.execs.list({ ref1: t.id }).filter((x) => x.kind === 'git_worktree_remove');
      expect(removed.map((x) => x.state)).toEqual(['succeeded']);
    } finally {
      store.close();
    }
    expect(mergeCommits(e, t.id)).toBe(1);
  });

  it('상한을 넘겨도: main을 바꾸기 전 단계에서 기다리던 병합은 그 git 단계가 끝나면 앱 종료 중이라 멈추고(main 그대로, 오류 없음) 그 뒤에 저장소를 닫는다 — 다시 시작하면 병합 판단부터 다시 해 한 번만 병합된다', async () => {
    const e = await bootRestartable();
    boxes.push(e);
    const t = await passedRepoTask(e);
    const before = mainSha(e);
    const g = e.ctx.deps.git;
    const orig = g.status.bind(g);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered = false;
    g.status = async (dir) => {
      if (dir === t.workspace!.worktreePath && e.core.merges.isPending(t.id)) {
        entered = true;
        await gate; // 오래 걸리는 git (상한보다 길다)
      }
      return orig(dir);
    };
    e.ctx.deps.timing!.shutdownDrainMs = 300;
    requestMerge(e, t.id);
    await waitUntil(() => entered, '병합 확인 중', 30_000);
    const t0 = Date.now();
    await e.orch.stop();
    expect(Date.now() - t0).toBeLessThan(5000); // 걸린 git을 끝까지 기다리지 않았다
    expect(e.core.merges.hasPending()).toBe(true);
    release();
    await waitUntil(() => !e.core.merges.hasPending(), '남은 병합 처리가 다음 단계에서 멈춤');
    await sleep(200); // 저장소를 닫기까지
    expect(e.errors).toEqual([]);
    expect(mainSha(e)).toBe(before);

    const next = await rebootOf(e);
    boxes.push(next);
    const cur = next.ctx.store.tasks.require(t.id);
    expect({ state: cur.state, merged: !!cur.merge, passed: !!cur.review.passed }).toEqual({ state: 'in_review', merged: false, passed: true });
    // 복구가 프로듀서에게 병합 판단을 다시 물었다 (처음 것은 위에서 처리됨 — 다시 시작한 스케줄러의 첫 tick이 새 것을 가져갔을 수 있다)
    expect(next.ctx.store.queue.list().filter((q) => q.kind === 'merge_decision' && q.taskId === t.id).length).toBeGreaterThanOrEqual(2);
    requestMerge(next, t.id);
    await waitUntil(() => next.ctx.store.tasks.require(t.id).state === 'done', '다시 시작한 뒤 병합 완료', 30_000);
    expect(mergeCommits(next, t.id)).toBe(1);
    expect(next.errors).toEqual([]);
  });

  it('상한을 넘겨도: main에 병합을 반영하는 git 단계(되돌릴 수 없음)가 끝나면 그 병합을 기록·마무리한 뒤 저장소를 닫는다 — 다시 시작해도 다시 병합하지 않는다', async () => {
    const e = await bootRestartable();
    boxes.push(e);
    const t = await passedRepoTask(e);
    const g = e.ctx.deps.git;
    const orig = g.mergeIntoBase.bind(g);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered = false;
    g.mergeIntoBase = async (repo, o) => {
      entered = true;
      await gate;
      return orig(repo, o);
    };
    e.ctx.deps.timing!.shutdownDrainMs = 300;
    requestMerge(e, t.id);
    await waitUntil(() => entered, '병합 반영 중', 30_000);
    await e.orch.stop();
    release();
    await waitUntil(() => !e.core.merges.hasPending(), '남은 병합 처리 끝');
    await sleep(200);
    expect(e.errors).toEqual([]);
    expect(mergeCommits(e, t.id)).toBe(1);

    const next = await rebootOf(e);
    boxes.push(next);
    await sleep(300); // 복구가 띄운 마무리(있다면)
    const cur = next.ctx.store.tasks.require(t.id);
    expect([cur.state, !!cur.merge]).toEqual(['done', true]);
    expect(mergeCommits(next, t.id)).toBe(1);
    expect(next.errors).toEqual([]);
  });
});
