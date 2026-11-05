/**
 * 병합 뒤 체크아웃된 프로젝트 폴더 맞춤 (GIT-15, 7.1 병합 기록, ARCHITECTURE 9장 재시작, AC-45).
 * main은 병합 커밋으로 바뀌었는데 프로젝트 폴더가 병합 전 내용으로 남으면 다음 병합이 '커밋되지 않은 변경'으로 보류되고, 그 변경을
 * 커밋하면 병합이 되돌려진다. 병합 기록과 폴더 맞춤 사이·맞추는 중에 앱이 꺼지거나, 기록 전에 끊겨 이미 반영된 병합을 확정할 때도
 * 다음 병합보다 먼저 폴더를 맞춘다. 맞춤은 폴더가 그 병합보다 뒤처져 있을 때만 한다 (여러 번 해도 같다, 대표의 로컬 변경은 덮지 않는다).
 * 서비스 단계 하네스(helpers.boot) + 재시작(git-helpers.restartServices).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Env } from './helpers';
import { boot, notices } from './helpers';
import { driveToDone, fileAt, mainSha, mergeBy, mergeCommitsFor, passedRepoTask, restartServices, settled, waitUntil } from '../acceptance/git-helpers';

let env: Env | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const syncExecs = (e: Env, taskId: string) => e.ctx.store.execs.list({ ref1: taskId }).filter((x) => x.kind === 'git_sync_base_checkout');
const folderClean = async (e: Env) => !(await e.ctx.deps.git.hasTrackedChanges(e.projectDir));

/** 같은 기준에서 검수를 통과한 두 작업 (서로 다른 파일) */
async function twoPassed(e: Env) {
  const [dev1, dev2] = e.members as [Env['members'][number], Env['members'][number]];
  const t1 = await passedRepoTask(e.core, { projectId: e.project.id, assignee: dev1, files: { 'a.txt': 'A\n' } });
  const t2 = await passedRepoTask(e.core, { projectId: e.project.id, assignee: dev2, files: { 'b.txt': 'B\n' } });
  return { t1, t2 };
}

/** 재시작 뒤: 첫 작업은 다시 병합하지 않고 완료, 폴더가 main과 같고, 뒤 작업 병합도 막히지 않는다 */
async function expectConverged(e: Env, t1: string, t2: string, mergeSha: string) {
  expect(await folderClean(e)).toBe(true);
  const d1 = await settled(e.core, t1);
  expect(d1).toMatchObject({ state: 'done', merge: { mergeCommitSha: mergeSha } });
  expect(e.ctx.store.execs.list({ ref1: t1 }).filter((x) => x.kind === 'git_merge')).toHaveLength(1);
  expect((await driveToDone(e.core, t2)).state).toBe('done');
  expect(notices(e, '병합 보류')).toEqual([]);
  expect(notices(e, '프로젝트 폴더 동기화 필요')).toEqual([]);
  for (const id of [t1, t2]) expect(mergeCommitsFor(e.projectDir, 'main', id)).toBe(1);
  expect(await folderClean(e)).toBe(true);
  expect(readFileSync(join(e.projectDir, 'a.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('A\n');
  expect(readFileSync(join(e.projectDir, 'b.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('B\n');
}

describe('병합 뒤 프로젝트 폴더 맞춤 복구 (GIT-15)', () => {
  it('병합 기록 뒤 폴더 맞춤을 시작하기 전에 앱이 꺼지면, 재시작 복구가 다음 병합보다 먼저 폴더를 맞추고 기록을 남긴다', async () => {
    env = await boot({ team: ['developer', 'developer'] });
    let e = env;
    const { t1, t2 } = await twoPassed(e);
    const g = e.ctx.deps.git;
    const origMerge = g.mergeIntoBase.bind(g);
    const origDirty = g.hasTrackedChanges.bind(g);
    let merged = false;
    let cut = false;
    g.mergeIntoBase = async (repo, o) => {
      const r = await origMerge(repo, o);
      merged = r.ok;
      return r;
    };
    // 병합 뒤 첫 폴더 확인(맞춤 직전)에서 멈춘다 = 병합 기록 뒤, 맞춤 실행 기록 전에 앱 종료
    g.hasTrackedChanges = async (dir) => {
      if (merged && !cut) {
        cut = true;
        return new Promise<never>(() => undefined);
      }
      return origDirty(dir);
    };
    e.core.merges.requestMerge(t1.id, e.producer, null);
    await waitUntil(() => cut, '병합 기록 뒤 폴더 맞춤 직전');
    const rec = e.ctx.store.tasks.require(t1.id);
    expect(rec.state).toBe('in_review');
    expect(rec.merge).not.toBeNull();
    expect(syncExecs(e, t1.id)).toEqual([]);
    expect(await origDirty(e.projectDir)).toBe(true); // 폴더는 병합 전 내용 (main은 병합 커밋)

    e = env = await restartServices(e);
    const [sync] = syncExecs(e, t1.id);
    expect(sync).toMatchObject({ state: 'succeeded', result: { oldSha: rec.merge!.preMainSha, newSha: rec.merge!.mergeCommitSha, ok: true } });
    await expectConverged(e, t1.id, t2.id, rec.merge!.mergeCommitSha);
  });

  it('폴더를 맞추는 중에 앱이 꺼지면, 끊긴 맞춤 기록을 정리하고 재시작 복구가 같은 맞춤을 다시 한다', async () => {
    env = await boot({ team: ['developer', 'developer'] });
    let e = env;
    const { t1, t2 } = await twoPassed(e);
    const g = e.ctx.deps.git;
    let cut = false;
    g.syncCheckedOutBase = () => {
      cut = true;
      return new Promise<never>(() => undefined); // read-tree 전에 앱 종료
    };
    e.core.merges.requestMerge(t1.id, e.producer, null);
    await waitUntil(() => cut, '폴더 맞춤 시작');
    const rec = e.ctx.store.tasks.require(t1.id);
    const [started] = syncExecs(e, t1.id);
    expect(started).toMatchObject({ state: 'started', result: { oldSha: rec.merge!.preMainSha, newSha: rec.merge!.mergeCommitSha } });

    e = env = await restartServices(e);
    expect(syncExecs(e, t1.id).map((x) => [x.state, x.result.recovered ?? null])).toEqual([
      ['failed', 'interrupted_resync'],
      ['succeeded', null],
    ]);
    await expectConverged(e, t1.id, t2.id, rec.merge!.mergeCommitSha);
  });

  it('기록 전에 끊겨 이미 반영된 병합을 다시 병합하지 않고 확정할 때, 병합 전 내용으로 남은 프로젝트 폴더도 맞춘다', async () => {
    env = await boot({ team: ['developer', 'developer'] });
    const e = env;
    const { t1, t2 } = await twoPassed(e);
    const target = t1.review.passed!.target;
    if (target.kind !== 'repo') throw new Error('저장소 변경형이어야 한다');
    // 이전 실행이 main에 반영만 하고 끊긴 병합 (작업 트리는 건드리지 않음)
    const r = await e.ctx.deps.git.mergeIntoBase(e.projectDir, {
      baseBranch: e.project.baseBranch,
      taskSha: target.taskCommitSha,
      expectedBaseSha: target.baseMainSha,
      message: `[${t1.id}] 병합: ${t1.title}\n\nWook-Task: ${t1.id}\nWook-Request: -`,
      identity: { name: '욱채', email: 'wook@wook.local' },
    });
    if (!r.ok) throw new Error(r.detail);
    expect(await folderClean(e)).toBe(false);

    const d1 = await mergeBy(e.core, t1.id);
    expect(d1).toMatchObject({ state: 'done', merge: { mergeCommitSha: r.mergeSha } });
    expect(syncExecs(e, t1.id)).toMatchObject([{ state: 'succeeded', result: { oldSha: target.baseMainSha, newSha: r.mergeSha } }]);
    expect(await folderClean(e)).toBe(true);
    expect((await driveToDone(e.core, t2.id)).state).toBe('done');
    expect(notices(e, '병합 보류')).toEqual([]);
    for (const id of [t1.id, t2.id]) expect(mergeCommitsFor(e.projectDir, 'main', id)).toBe(1);
  });

  it('맞춤은 폴더가 그 병합보다 뒤처져 있을 때만 한다 — 이미 맞으면 실행하지 않고, 대표가 고친 파일은 덮지 않으며, main이 더 움직였으면 건드리지 않는다', async () => {
    env = await boot({ team: ['developer', 'developer'] });
    const e = env;
    const { t1 } = await twoPassed(e);
    const d1 = await mergeBy(e.core, t1.id);
    expect(d1.state).toBe('done');
    expect(syncExecs(e, t1.id)).toHaveLength(1); // 병합 직후 한 번
    // 이미 맞음 → 아무것도 하지 않는다
    await e.core.merges.syncRecordedMerge(t1.id);
    expect(syncExecs(e, t1.id)).toHaveLength(1);
    // 대표가 병합된 파일을 고치는 중 (커밋 안 함) → 다시 불러도 그 변경을 덮지 않는다
    writeFileSync(join(e.projectDir, 'a.txt'), '대표가 고치는 중\n', 'utf8');
    await e.core.merges.syncRecordedMerge(t1.id);
    expect(readFileSync(join(e.projectDir, 'a.txt'), 'utf8')).toBe('대표가 고치는 중\n');
    expect(notices(e, '프로젝트 폴더 동기화 필요')).toEqual([]);
    // main이 이 병합 뒤로 움직였으면 이 병합의 맞춤이 아니다 (실행 기록도 남기지 않는다)
    const before = syncExecs(e, t1.id).length;
    const g = e.ctx.deps.git;
    await g.commitAll(e.projectDir, '대표 커밋', { name: '대표', email: 'owner@local' });
    writeFileSync(join(e.projectDir, 'a.txt'), '다시 고치는 중\n', 'utf8');
    expect(mainSha(e.core, e.project.id)).not.toBe(d1.merge!.mergeCommitSha);
    await e.core.merges.syncRecordedMerge(t1.id);
    expect(syncExecs(e, t1.id)).toHaveLength(before);
    expect(readFileSync(join(e.projectDir, 'a.txt'), 'utf8')).toBe('다시 고치는 중\n');
    expect(fileAt(e.projectDir, 'refs/heads/main', 'a.txt')).toBe('대표가 고치는 중\n');
  });
});
