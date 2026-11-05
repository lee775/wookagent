/**
 * 병합이 바꾼 파일을 대표가 고쳐 스테이징했으면(인덱스가 병합 전 내용도 병합 결과도 아님) 그 병합의 변경이 들어 있는지 내용으로 가린다 (GIT-15, AC-45,
 * ARCHITECTURE 10장): 맞춤 알림은 그대로 커밋하면 병합이 되돌려질 때 알리고, 되돌려지지 않으면 알리지 않는다.
 * - 병합 결과 위에 고친 것(병합한 줄 바로 옆 줄이라도) → 맞춘 폴더 (알림 없음)
 * - 병합 전 내용 위에 고친 것 → 병합 변경이 빠짐 → 건드리지 않고 '병합 전 내용에 대표 변경이 더해짐'으로 그 파일을 적어 알린다
 * - 내용으로 가릴 수 없는 것(바이너리, 병합한 줄 자체를 고침) → 확인하지 못한 파일로 적어 알린다
 * - 병합이 더한 파일의 대표 내용, 대표가 지운 파일은 대표 것이다 (알리지 않는다)
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
import { boot, commitOnMain, notices } from './helpers';
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
const LINES = '첫 줄\n둘째 줄\n셋째 줄\n넷째 줄\n다섯째 줄\n';

type Entry = string | Buffer | { mode: '100755'; content: string } | null;

/**
 * 체크아웃된 main 폴더에서 병합처럼 main만 앞으로 옮긴다 (인덱스·작업 트리는 병합 전 그대로). synced면 폴더도 병합 결과로 맞춘다(대표가 직접 맞춤).
 * after: 병합이 바꾸는 파일 (null = 지움, {mode:'100755'} = 실행 권한)
 */
function mergedRepo(before: Record<string, string | Buffer>, after: Record<string, Entry>, synced: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'wook-test-syncedit-'));
  dirs.push(dir);
  const g = (args: string[], input?: string | Buffer) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', input }).trim();
  g(['init', '-q', '-b', 'main']);
  for (const [f, c] of Object.entries(before)) writeFileSync(join(dir, f), c);
  g(['add', '.']);
  g(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'old']);
  const oldSha = g(['rev-parse', 'HEAD']);
  const env2 = { ...process.env, GIT_INDEX_FILE: join(dir, '.git', 'tmp-index') };
  const gi = (args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: env2 }).trim();
  gi(['read-tree', oldSha]);
  for (const [f, c] of Object.entries(after)) {
    if (c === null) gi(['update-index', '--force-remove', f]);
    else {
      const [mode, body] = typeof c === 'object' && !Buffer.isBuffer(c) ? [c.mode, c.content] : ['100644', c];
      gi(['update-index', '--add', '--cacheinfo', `${mode},${g(['hash-object', '-w', '--stdin'], body)},${f}`]);
    }
  }
  const newSha = g(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit-tree', gi(['write-tree']), '-p', oldSha, '-m', 'merge']);
  g(['update-ref', 'refs/heads/main', newSha, oldSha]);
  if (synced) g(['reset', '-q', '--hard']);
  /** 대표가 파일을 고쳐 스테이징한다 (null = 지워 스테이징) */
  const ownerStages = (f: string, content: string | Buffer | null) => {
    if (content === null) g(['rm', '-q', '--cached', f]);
    else {
      writeFileSync(join(dir, f), content);
      g(['add', f]);
    }
  };
  return { dir, oldSha, newSha, ownerStages };
}

describe('대표가 고친 병합 파일은 그 병합의 변경이 들어 있는지 내용으로 가린다 (git.baseCheckoutState)', () => {
  const svc = createGitService();
  const state = (r: { dir: string; oldSha: string; newSha: string }) => svc.baseCheckoutState(r.dir, 'main', r.oldSha, r.newSha);
  const merge = { 'f.txt': `작업 ${LINES}` }; // 병합이 첫 줄을 바꿨다

  it('병합 결과 위에 고친 것은 병합한 줄 바로 옆 줄이든 먼 줄이든 맞춘 폴더다 (synced)', async () => {
    for (const edit of [`작업 첫 줄\n둘째 줄 (대표)\n셋째 줄\n넷째 줄\n다섯째 줄\n`, `작업 첫 줄\n둘째 줄\n셋째 줄\n넷째 줄\n다섯째 줄 (대표)\n`]) {
      const r = mergedRepo({ 'f.txt': LINES }, merge, true);
      r.ownerStages('f.txt', edit);
      expect(await state(r)).toEqual({ state: 'synced', preMerge: [] });
    }
  });

  it('병합 전 내용 위에 고친 것은 병합 변경이 빠진 파일이다 — 옆 줄·먼 줄 모두, 다른 병합 파일이 병합 전 그대로여도 (diverged)', async () => {
    for (const edit of [`첫 줄\n둘째 줄 (대표)\n셋째 줄\n넷째 줄\n다섯째 줄\n`, `첫 줄\n둘째 줄\n셋째 줄\n넷째 줄\n다섯째 줄 (대표)\n`]) {
      const r = mergedRepo({ 'f.txt': LINES }, merge, false);
      r.ownerStages('f.txt', edit);
      expect(await state(r)).toEqual({ state: 'diverged', preMerge: [], preMergeEdited: ['f.txt'] });
    }
    // 병합이 두 파일을 바꿨고 그중 하나만 대표가 병합 전 내용 위에 고쳤다 → 맞추지 않는다 (read-tree -m이 덮게 된다)
    const r = mergedRepo({ 'f.txt': LINES, 'g.txt': 'g\n' }, { ...merge, 'g.txt': 'g2\n' }, false);
    r.ownerStages('f.txt', `${LINES}여섯째 줄 (대표)\n`);
    expect(await state(r)).toEqual({ state: 'diverged', preMerge: ['g.txt'], preMergeEdited: ['f.txt'] });
  });

  it('병합이 지운 파일을 병합 전 내용 위에 고쳐 남겼거나, 병합이 바꾼 실행 권한이 병합 전 그대로면 병합 변경이 빠진 파일이다', async () => {
    const del = mergedRepo({ 'f.txt': LINES, 'keep.txt': 'k\n' }, { 'f.txt': null }, false);
    del.ownerStages('f.txt', `${LINES}여섯째 줄 (대표)\n`);
    expect(await state(del)).toEqual({ state: 'diverged', preMerge: [], preMergeEdited: ['f.txt'] });

    // 병합이 실행 권한만 바꿨다 — 병합 전 폴더에서 내용을 고쳐 스테이징하면 권한은 병합 전 그대로 → 그대로 커밋하면 권한 변경이 되돌려진다
    const behind = mergedRepo({ 'run.sh': 'echo 1\n' }, { 'run.sh': { mode: '100755', content: 'echo 1\n' } }, false);
    behind.ownerStages('run.sh', 'echo 1\necho 2\n');
    expect(await state(behind)).toEqual({ state: 'diverged', preMerge: [], preMergeEdited: ['run.sh'] });
    const synced = mergedRepo({ 'run.sh': 'echo 1\n' }, { 'run.sh': { mode: '100755', content: 'echo 1\n' } }, true);
    synced.ownerStages('run.sh', 'echo 1\necho 2\n');
    expect(await state(synced)).toEqual({ state: 'synced', preMerge: [] });
  });

  it('내용으로 가릴 수 없으면(바이너리, 병합한 줄 자체를 고침) 확인하지 못한 파일로 diverged — 병합이 더한 파일의 대표 내용·대표가 지운 파일은 대표 것', async () => {
    const bin = mergedRepo({ 'b.bin': Buffer.from([1, 0, 2]) }, { 'b.bin': Buffer.from([1, 0, 3]) }, true);
    bin.ownerStages('b.bin', Buffer.from([1, 0, 4]));
    expect(await state(bin)).toEqual({ state: 'diverged', preMerge: [], unverified: ['b.bin'] });

    const same = mergedRepo({ 'f.txt': LINES }, merge, false);
    same.ownerStages('f.txt', `대표 첫 줄\n둘째 줄\n셋째 줄\n넷째 줄\n다섯째 줄\n`);
    expect(await state(same)).toEqual({ state: 'diverged', preMerge: [], unverified: ['f.txt'] });

    const own = mergedRepo({ 'f.txt': LINES }, { 'new.txt': '병합\n', ...merge }, false);
    own.ownerStages('new.txt', '대표가 만든 파일\n');
    own.ownerStages('f.txt', null);
    expect(await state(own)).toEqual({ state: 'synced', preMerge: [] });
  });
});

describe('재시작 뒤 맞춤 판단과 알림 — 대표가 고친 병합 파일 (GIT-15)', () => {
  /** 병합이 main에 반영되는 순간 프로젝트를 일시정지해 작업을 병합 기록을 단 채 보류로 둔다 (맞춤은 끊김 또는 한 번 실패) */
  async function mergedWhilePaused(e: Env, sync: 'fail' | 'skip') {
    commitOnMain(e, 'shared.txt', '첫 줄\n둘째 줄\n');
    const [dev1] = e.members as [Env['members'][number]];
    const t1 = await passedRepoTask(e.core, { projectId: e.project.id, assignee: dev1, files: { 'shared.txt': '작업 첫 줄\n둘째 줄\n' } });
    const g = e.ctx.deps.git;
    const orig = g.mergeIntoBase.bind(g);
    g.mergeIntoBase = async (repo, m) => {
      const r = await orig(repo, m);
      await e.core.stops.pauseProject(e.project.id, 'graceful', MAIN_AGENT_ID);
      return r;
    };
    g.syncCheckedOutBase =
      sync === 'fail'
        ? async () => ({ ok: false, detail: "fatal: Unable to create '.git/index.lock': File exists." })
        : async () => ({ ok: true, detail: '맞추기 전에 끊김 (시험)' });
    e.core.merges.requestMerge(t1.id, e.producer, null);
    await waitUntil(() => !e.core.merges.isPending(t1.id) && !!e.ctx.store.tasks.require(t1.id).merge, '병합 기록');
    const rec = e.ctx.store.tasks.require(t1.id);
    expect(rec.state).toBe('on_hold');
    return rec;
  }

  it('맞추기 전에 끊긴 폴더(병합 전 shared.txt)에서 대표가 병합한 줄 옆 줄을 고쳐 스테이징했으면, 재시작이 건드리지 않고 그 파일을 병합 변경이 빠진 파일로 알린다', async () => {
    env = await boot({ team: ['developer'] });
    let e = env;
    const t1 = await mergedWhilePaused(e, 'skip');
    for (const x of syncExecs(e, t1.id)) e.ctx.store.execs.delete(x.requestId); // 맞추기 전에 끊긴 상태
    expect(readFileSync(join(e.projectDir, 'shared.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('첫 줄\n둘째 줄\n');
    writeFileSync(join(e.projectDir, 'shared.txt'), '첫 줄\n둘째 줄 (대표)\n', 'utf8');
    git(e.projectDir, ['add', 'shared.txt']);

    e = env = await restartServices(e);
    expect(syncExecs(e, t1.id)).toEqual([]); // 맞추지 않았다
    const alarm = notices(e, ALARM);
    expect(alarm).toHaveLength(1);
    expect(alarm[0]!.body).toContain('병합 전 내용에 대표 변경이 더해짐: shared.txt');
    expect(alarm[0]!.body).toContain('그대로 커밋하면 그 파일의 병합 변경이 되돌려집니다');
    const acts = e.ctx.store.activity.search({ taskId: t1.id, text: '프로젝트 폴더를 맞추지 않음' });
    expect(acts).toHaveLength(1);
    expect(acts[0]!.text).toContain('shared.txt');
    // 대표의 스테이징·파일은 그대로
    expect(git(e.projectDir, ['show', ':shared.txt']).replace(/\r\n/g, '\n')).toBe('첫 줄\n둘째 줄 (대표)');
    expect(readFileSync(join(e.projectDir, 'shared.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('첫 줄\n둘째 줄 (대표)\n');
  });

  it('맞춤이 한 번 실패한 뒤 대표가 직접 맞춘 폴더에서 병합한 줄 옆 줄을 고쳐 스테이징했으면, 재시작이 다시 알리지 않는다', async () => {
    env = await boot({ team: ['developer'] });
    let e = env;
    const t1 = await mergedWhilePaused(e, 'fail');
    expect(syncExecs(e, t1.id).map((x) => x.state)).toEqual(['failed']);
    for (const n of notices(e, ALARM)) e.ctx.store.notifications.put({ ...n, readAt: e.ctx.now() });
    git(e.projectDir, ['reset', '-q', '--hard']); // 대표가 직접 맞춘다
    writeFileSync(join(e.projectDir, 'shared.txt'), '작업 첫 줄\n둘째 줄 (대표)\n', 'utf8');
    git(e.projectDir, ['add', 'shared.txt']);

    e = env = await restartServices(e);
    expect(notices(e, ALARM).filter((n) => !n.readAt)).toEqual([]);
    expect(e.ctx.store.activity.search({ taskId: t1.id, text: '프로젝트 폴더를 맞추지 않음' })).toEqual([]);
    expect(syncExecs(e, t1.id).map((x) => x.state)).toEqual(['failed']);
    expect(git(e.projectDir, ['show', ':shared.txt']).replace(/\r\n/g, '\n')).toBe('작업 첫 줄\n둘째 줄 (대표)');
  });
});
