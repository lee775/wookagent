/**
 * 병합 뒤 프로젝트 폴더 맞춤 판단은 그 병합이 바꾼 경로만 본다 — 알림은 사실이어야 한다 (GIT-15, AC-45, ARCHITECTURE 10장).
 * - 병합이 바꾼 경로에 병합 전 내용이 하나도 없으면(병합 결과, 또는 그 뒤 대표가 고친 내용) 맞춘 폴더다: 기록·알림 없이 넘어간다. 맞춤 기록이 실패로
 *   남았어도(그 뒤 대표가 직접 맞춤) 같다. 대표가 고친 병합 파일에 병합 변경이 들어 있는지는 내용으로 가린다 (checkoutSyncOwnerEdit.test.ts)
 * - 그 경로가 모두 병합 전 내용이면 맞춘다 — 다른 경로에 스테이징된 대표 변경은 판단에 넣지 않고 그대로 남는다 (checkoutSyncGate.test.ts)
 * - 일부만 병합 전 내용이면 건드리지 않고, 병합 전 내용인 파일을 적어 알린다
 * git 서비스 단위(임시 저장소) + 서비스 단계 하네스(helpers.boot) + 재시작(git-helpers.restartServices).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID } from '@shared/domain';
import { createGitService } from '../../src/main/git/gitService';
import type { Env } from './helpers';
import { boot, notices } from './helpers';
import { git, passedRepoTask, restartServices, waitUntil } from '../acceptance/git-helpers';

let env: Env | null = null;
const dirs: string[] = [];
afterEach(async () => {
  await env?.close();
  env = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const ALARM = '프로젝트 폴더 동기화 필요';
const syncExecs = (e: Env, taskId: string) => e.ctx.store.execs.list({ ref1: taskId }).filter((x) => x.kind === 'git_sync_base_checkout');

/** 체크아웃된 main 폴더에 병합처럼 main만 앞으로 옮긴다 (작업 트리·인덱스는 병합 전 그대로) — old: README·b.txt, new: + a.txt, b.txt 바뀜 */
function behindRepo(): { dir: string; oldSha: string; newSha: string } {
  const dir = mkdtempSync(join(tmpdir(), 'wook-test-syncpaths-'));
  dirs.push(dir);
  const g = (args: string[], input?: string) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', input }).trim();
  g(['init', '-q', '-b', 'main']);
  writeFileSync(join(dir, 'README.md'), 'readme\n', 'utf8');
  writeFileSync(join(dir, 'b.txt'), 'b\n', 'utf8');
  g(['add', '.']);
  g(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'old']);
  const oldSha = g(['rev-parse', 'HEAD']);
  const idx = join(dir, '.git', 'tmp-index');
  const env2 = { ...process.env, GIT_INDEX_FILE: idx };
  const gi = (args: string[], input?: string) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', input, env: env2 }).trim();
  gi(['read-tree', oldSha]);
  gi(['update-index', '--add', '--cacheinfo', `100644,${g(['hash-object', '-w', '--stdin'], 'A\n')},a.txt`]);
  gi(['update-index', '--cacheinfo', `100644,${g(['hash-object', '-w', '--stdin'], 'b2\n')},b.txt`]);
  const tree = gi(['write-tree']);
  const newSha = g(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit-tree', tree, '-p', oldSha, '-m', 'merge']);
  g(['update-ref', 'refs/heads/main', newSha, oldSha]);
  return { dir, oldSha, newSha };
}

describe('맞춤 판단은 병합이 바꾼 경로만 본다 (git.baseCheckoutState)', () => {
  it('병합 전 내용인 경로가 없으면 synced, 모두면 behind, 일부면 diverged(그 경로를 돌려줌) — 다른 경로의 스테이징은 보지 않는다', async () => {
    const svc = createGitService();
    const sh = (dir: string, args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

    // 병합 뒤 맞추지 않은 폴더: 병합이 바꾼 a.txt·b.txt가 모두 병합 전 → behind
    const r1 = behindRepo();
    expect(await svc.baseCheckoutState(r1.dir, 'main', r1.oldSha, r1.newSha)).toEqual({ state: 'behind', preMerge: ['a.txt', 'b.txt'] });
    // 다른 경로에 대표가 스테이징한 변경이 있어도 그대로 behind (판단에 넣지 않는다)
    writeFileSync(join(r1.dir, 'README.md'), 'readme 대표\n', 'utf8');
    writeFileSync(join(r1.dir, 'owner.txt'), '대표\n', 'utf8');
    sh(r1.dir, ['add', 'README.md', 'owner.txt']);
    expect((await svc.baseCheckoutState(r1.dir, 'main', r1.oldSha, r1.newSha)).state).toBe('behind');
    // 병합한 파일 하나(b.txt)를 대표가 고쳐 스테이징 → a.txt만 병합 전 → diverged, 병합 전 내용인 파일은 a.txt. b.txt는 병합이 바꾼 그 줄 자체를
    // 고쳐(b → 'b 대표', 병합은 b → b2) 병합 변경이 들어 있는지 내용으로 가릴 수 없다 → 확인하지 못한 파일 (checkoutSyncOwnerEdit.test.ts)
    writeFileSync(join(r1.dir, 'b.txt'), 'b 대표\n', 'utf8');
    sh(r1.dir, ['add', 'b.txt']);
    expect(await svc.baseCheckoutState(r1.dir, 'main', r1.oldSha, r1.newSha)).toEqual({ state: 'diverged', preMerge: ['a.txt'], unverified: ['b.txt'] });

    // 맞춘 폴더(병합 결과)에서 대표가 병합한 파일을 고쳐 스테이징 → 병합 전 내용이 없다 → synced
    const r2 = behindRepo();
    sh(r2.dir, ['reset', '-q', '--hard']);
    writeFileSync(join(r2.dir, 'a.txt'), '대표 수정\n', 'utf8');
    sh(r2.dir, ['add', 'a.txt']);
    expect(await svc.baseCheckoutState(r2.dir, 'main', r2.oldSha, r2.newSha)).toEqual({ state: 'synced', preMerge: [] });
  });
});

describe('재시작 뒤 맞춤 판단과 알림 (GIT-15)', () => {
  /** 병합이 main에 반영되는 순간 프로젝트를 일시정지해 작업을 병합 기록을 단 채 보류로 둔다 */
  async function mergedWhilePaused(e: Env, files: Record<string, string>, sync: 'fail' | 'skip') {
    const [dev1] = e.members as [Env['members'][number]];
    const t1 = await passedRepoTask(e.core, { projectId: e.project.id, assignee: dev1, files });
    const g = e.ctx.deps.git;
    const orig = g.mergeIntoBase.bind(g);
    g.mergeIntoBase = async (repo, m) => {
      const r = await orig(repo, m);
      await e.core.stops.pauseProject(e.project.id, 'graceful', MAIN_AGENT_ID);
      return r;
    };
    g.syncCheckedOutBase =
      sync === 'fail'
        ? async () => ({ ok: false, detail: "fatal: Unable to create '.git/index.lock': File exists." }) // 다른 git(편집기 등)이 잠금을 잡고 있었다
        : async () => ({ ok: true, detail: '맞추기 전에 끊김 (시험)' });
    e.core.merges.requestMerge(t1.id, e.producer, null);
    await waitUntil(() => !e.core.merges.isPending(t1.id) && !!e.ctx.store.tasks.require(t1.id).merge, '병합 기록');
    const rec = e.ctx.store.tasks.require(t1.id);
    expect(rec.state).toBe('on_hold');
    return rec;
  }

  it('맞춤이 한 번 실패한 뒤 대표가 직접 맞춘 폴더에서 병합한 파일을 고쳐 스테이징했으면, 재시작이 다시 알리지 않는다 (병합 전 상태라고 하지 않는다)', async () => {
    env = await boot({ team: ['developer'] });
    let e = env;
    const t1 = await mergedWhilePaused(e, { 'a.txt': 'A\n' }, 'fail');
    expect(syncExecs(e, t1.id).map((x) => x.state)).toEqual(['failed']);
    const first = notices(e, ALARM);
    expect(first).toHaveLength(1);
    for (const n of first) e.ctx.store.notifications.put({ ...n, readAt: e.ctx.now() });
    // 대표가 알림을 보고 직접 맞춘다(main = 병합 커밋) → 병합한 파일을 고쳐 스테이징
    git(e.projectDir, ['reset', '-q', '--hard']);
    expect(git(e.projectDir, ['rev-parse', 'HEAD'])).toBe(t1.merge!.mergeCommitSha);
    writeFileSync(join(e.projectDir, 'a.txt'), '대표 수정\n', 'utf8');
    git(e.projectDir, ['add', 'a.txt']);

    e = env = await restartServices(e);
    expect(notices(e, ALARM).filter((n) => !n.readAt)).toEqual([]);
    expect(e.ctx.store.activity.search({ taskId: t1.id, text: '프로젝트 폴더를 맞추지 않음' })).toEqual([]);
    expect(syncExecs(e, t1.id).map((x) => x.state)).toEqual(['failed']); // 다시 맞추지 않았다
    expect(readFileSync(join(e.projectDir, 'a.txt'), 'utf8')).toBe('대표 수정\n');
    expect(git(e.projectDir, ['diff', '--cached', '--name-only'])).toBe('a.txt');
  });

  it('맞추지 않은 폴더에서 병합한 파일 일부만 대표가 고쳐 스테이징했으면 건드리지 않고, 아직 병합 전 내용인 파일을 적어 알린다', async () => {
    env = await boot({ team: ['developer'] });
    let e = env;
    const t1 = await mergedWhilePaused(e, { 'a.txt': 'A\n', 'b.txt': 'B\n' }, 'skip');
    for (const x of syncExecs(e, t1.id)) e.ctx.store.execs.delete(x.requestId); // 맞추기 전에 끊긴 상태 (폴더는 병합 전)
    writeFileSync(join(e.projectDir, 'a.txt'), '대표가 만든 a\n', 'utf8');
    git(e.projectDir, ['add', 'a.txt']);

    e = env = await restartServices(e);
    expect(syncExecs(e, t1.id)).toEqual([]);
    const alarm = notices(e, ALARM);
    expect(alarm).toHaveLength(1);
    expect(alarm[0]!.body).toContain('b.txt');
    expect(alarm[0]!.body).toContain('아직 병합 전 내용');
    expect(alarm[0]!.body).not.toContain('a.txt');
    const acts = e.ctx.store.activity.search({ taskId: t1.id, text: '프로젝트 폴더를 맞추지 않음' });
    expect(acts).toHaveLength(1);
    expect(acts[0]!.text).toContain('b.txt');
    expect(readFileSync(join(e.projectDir, 'a.txt'), 'utf8')).toBe('대표가 만든 a\n');
  });
});
