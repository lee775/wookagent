/**
 * 재시작 때 병합 뒤 프로젝트 폴더 맞춤을 다시 할지는 저장소 상태로 정한다 (GIT-15, AC-45, ARCHITECTURE 9장 ③·10장). 병합이 바꾼 경로의 인덱스만 본다:
 * - 이 병합의 맞춤을 이미 마쳤거나(성공한 맞춤 기록) 그 경로가 이미 병합 결과면, 그 뒤 대표가 폴더에서 고친 것(스테이징 포함)을 맞춤 대상으로 보지
 *   않는다 — 실행 기록·'프로젝트 폴더 동기화 필요' 알림 없이 넘어간다
 * - 그 경로가 모두 아직 병합 전 내용이면 맞춘다 — 다른 경로에 스테이징된 대표 변경은 그대로 남는다
 * - 일부만 병합 전 내용인 경우(맞추지 않은 폴더에 대표 변경이 섞임)는 checkoutSyncMergedPaths.test.ts
 * 서비스 단계 하네스(helpers.boot) + 재시작(git-helpers.restartServices). 병합이 main에 반영될 때 프로젝트를 일시정지해 작업이 병합 기록을 단 채 보류로 남게 한다.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID } from '@shared/domain';
import type { Env } from './helpers';
import { boot, notices } from './helpers';
import { git, passedRepoTask, restartServices, waitUntil } from '../acceptance/git-helpers';

let env: Env | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const syncExecs = (e: Env, taskId: string) => e.ctx.store.execs.list({ ref1: taskId }).filter((x) => x.kind === 'git_sync_base_checkout');
const ALARM = '프로젝트 폴더 동기화 필요';

/** 병합이 main에 반영되는 순간 프로젝트를 일시정지한다 → 작업은 병합 기록을 단 채 보류 (재개 때 완료). skipSync면 폴더 맞춤 전에 끊긴 것처럼 맞추지 않는다 */
async function mergedWhilePaused(e: Env, o: { skipSync?: boolean } = {}) {
  const [dev1] = e.members as [Env['members'][number]];
  const t1 = await passedRepoTask(e.core, { projectId: e.project.id, assignee: dev1, files: { 'a.txt': 'A\n' } });
  const g = e.ctx.deps.git;
  const orig = g.mergeIntoBase.bind(g);
  g.mergeIntoBase = async (repo, m) => {
    const r = await orig(repo, m);
    await e.core.stops.pauseProject(e.project.id, 'graceful', MAIN_AGENT_ID);
    return r;
  };
  if (o.skipSync) g.syncCheckedOutBase = async () => ({ ok: true, detail: '맞추기 전에 끊김 (시험)' });
  e.core.merges.requestMerge(t1.id, e.producer, null);
  await waitUntil(() => !e.core.merges.isPending(t1.id) && !!e.ctx.store.tasks.require(t1.id).merge, '병합 기록');
  const rec = e.ctx.store.tasks.require(t1.id);
  expect(rec.state).toBe('on_hold');
  return rec;
}

describe('재시작 뒤 프로젝트 폴더 맞춤 판단 (GIT-15, AC-45)', () => {
  it('이미 맞춘 폴더에서 대표가 병합된 파일을 고쳐 스테이징했으면, 재시작이 맞춤을 다시 하지 않고 알리지도 않는다 (대표 변경 그대로)', async () => {
    env = await boot({ team: ['developer'] });
    let e = env;
    const t1 = await mergedWhilePaused(e);
    expect(syncExecs(e, t1.id).map((x) => x.state)).toEqual(['succeeded']);
    expect(git(e.projectDir, ['status', '--porcelain'])).toBe('');
    writeFileSync(join(e.projectDir, 'a.txt'), '대표 수정\n', 'utf8');
    git(e.projectDir, ['add', 'a.txt']);

    e = env = await restartServices(e);
    expect(syncExecs(e, t1.id)).toHaveLength(1);
    expect(notices(e, ALARM)).toEqual([]);
    expect(readFileSync(join(e.projectDir, 'a.txt'), 'utf8')).toBe('대표 수정\n');
    expect(git(e.projectDir, ['diff', '--cached', '--name-only'])).toBe('a.txt');
  });

  it('맞춤 기록이 없어도 인덱스가 이미 병합 트리면(맞춘 뒤 기록 전에 끊김) 대표가 폴더에서 고친 것을 맞춤 대상으로 보지 않는다 — 재시작마다 실행 기록이 쌓이지 않는다', async () => {
    env = await boot({ team: ['developer'] });
    let e = env;
    const t1 = await mergedWhilePaused(e);
    // 맞춤은 했지만 그 기록을 남기기 전에 끊긴 것처럼 기록을 지운다
    for (const x of syncExecs(e, t1.id)) e.ctx.store.execs.delete(x.requestId);
    writeFileSync(join(e.projectDir, 'a.txt'), '대표가 고치는 중 (스테이징 안 함)\n', 'utf8');
    for (let i = 0; i < 2; i++) {
      e = env = await restartServices(e);
      expect(syncExecs(e, t1.id), `재시작 ${i + 1}번째`).toEqual([]);
    }
    expect(notices(e, ALARM)).toEqual([]);
    expect(readFileSync(join(e.projectDir, 'a.txt'), 'utf8')).toBe('대표가 고치는 중 (스테이징 안 함)\n');
  });

  it('병합 뒤 폴더를 맞추기 전에 끊겼으면 재시작이 맞춘다 — 인덱스가 병합 전 트리 그대로일 때', async () => {
    env = await boot({ team: ['developer'] });
    let e = env;
    const t1 = await mergedWhilePaused(e, { skipSync: true });
    expect(syncExecs(e, t1.id).map((x) => x.state)).toEqual(['succeeded']); // 시험용 맞춤(아무것도 안 함)
    for (const x of syncExecs(e, t1.id)) e.ctx.store.execs.delete(x.requestId); // 맞추기 전에 끊긴 상태
    expect(git(e.projectDir, ['status', '--porcelain'])).not.toBe(''); // main은 병합 커밋인데 폴더는 병합 전
    e = env = await restartServices(e);
    expect(syncExecs(e, t1.id).map((x) => [x.state, x.result.ok])).toEqual([['succeeded', true]]);
    expect(git(e.projectDir, ['status', '--porcelain'])).toBe('');
    expect(readFileSync(join(e.projectDir, 'a.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('A\n');
    expect(notices(e, ALARM)).toEqual([]);
  });

  it('맞추지 않은 폴더에 대표가 병합과 상관없는 파일을 스테이징했으면 그 변경은 그대로 두고 병합한 파일만 맞춘다 (알림 없음)', async () => {
    env = await boot({ team: ['developer'] });
    let e = env;
    const t1 = await mergedWhilePaused(e, { skipSync: true });
    for (const x of syncExecs(e, t1.id)) e.ctx.store.execs.delete(x.requestId);
    writeFileSync(join(e.projectDir, 'owner.txt'), '대표 작업\n', 'utf8');
    git(e.projectDir, ['add', 'owner.txt']);
    e = env = await restartServices(e);
    // 병합이 바꾼 파일(a.txt)은 아직 병합 전 내용 그대로다 — 그 경로만 보면 뒤처진 폴더라 맞춘다. 다른 경로에 스테이징된 대표 변경은 판단에 넣지 않고 그대로 남는다
    expect(syncExecs(e, t1.id).map((x) => [x.state, x.result.ok])).toEqual([['succeeded', true]]);
    expect(notices(e, ALARM)).toEqual([]);
    expect(readFileSync(join(e.projectDir, 'a.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('A\n');
    expect(git(e.projectDir, ['diff', '--cached', '--name-only']).split(/\r?\n/)).toEqual(['owner.txt']);
    expect(readFileSync(join(e.projectDir, 'owner.txt'), 'utf8')).toBe('대표 작업\n');
  });
});
