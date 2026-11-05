/**
 * 마지막 줄 끝에 줄바꿈이 없는 병합 파일(메모장·JSON에 흔함)도 맞춤 판단이 같다 (GIT-15, AC-45, ARCHITECTURE 10장): 맞춘 폴더에서 대표가 병합한
 * 마지막 줄 뒤에 줄을 더하면 그대로 커밋해도 병합이 되돌려지지 않으므로 알리지 않는다. git은 줄바꿈 없는 마지막 줄과 줄바꿈이 붙은 같은 줄을
 * 다른 줄로 세므로, 줄 거리로 가리지 못하거나 병합 변경이 빠졌다고 나오면 줄바꿈을 붙인 것처럼 한 번 더 잰다 — 병합 전 내용 위에 고친 것은
 * 그대로 알리고, 병합이 줄 끝만 바꿨으면 가릴 수 없다(확인하지 못함). 빠졌다고 나온 것은 다시 재서 들어 있다고 나올 때만 알리지 않는다.
 * git 서비스 단위(임시 저장소) + 서비스 단계 하네스(helpers.boot) + 재시작(git-helpers.restartServices).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

/** 체크아웃된 main에서 병합처럼 main만 앞으로 옮긴다 (인덱스·작업 트리는 병합 전). synced면 폴더도 병합 결과로 맞춘다(대표가 직접 맞춤) */
function mergedRepo(before: string, after: string, synced: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'wook-test-syncnoeol-'));
  dirs.push(dir);
  const g = (args: string[], input?: string) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', input }).trim();
  g(['init', '-q', '-b', 'main']);
  g(['config', 'core.autocrlf', 'false']);
  writeFileSync(join(dir, 'f.txt'), before);
  g(['add', '.']);
  g(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'old']);
  const oldSha = g(['rev-parse', 'HEAD']);
  const env2 = { ...process.env, GIT_INDEX_FILE: join(dir, '.git', 'tmp-index') };
  const gi = (args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: env2 }).trim();
  gi(['read-tree', oldSha]);
  gi(['update-index', '--add', '--cacheinfo', `100644,${g(['hash-object', '-w', '--stdin'], after)},f.txt`]);
  const newSha = g(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit-tree', gi(['write-tree']), '-p', oldSha, '-m', 'merge']);
  g(['update-ref', 'refs/heads/main', newSha, oldSha]);
  if (synced) g(['reset', '-q', '--hard']);
  /** 대표가 f.txt를 고쳐 스테이징한다 */
  const ownerStages = (content: string) => {
    writeFileSync(join(dir, 'f.txt'), content);
    g(['add', 'f.txt']);
  };
  return { dir, oldSha, newSha, ownerStages };
}

describe('줄바꿈 없는 마지막 줄의 병합 파일 — 맞춤 판단 (git.baseCheckoutState)', () => {
  const svc = createGitService();
  const state = (r: { dir: string; oldSha: string; newSha: string }) => svc.baseCheckoutState(r.dir, 'main', r.oldSha, r.newSha);

  it('맞춘 폴더에서 병합한 마지막 줄 뒤에 대표가 줄을 더했으면 맞춘 폴더다 — 병합이 줄을 더했든 마지막 줄을 바꿨든', async () => {
    const appended = mergedRepo('하나\n둘', '하나\n둘\n셋', true);
    appended.ownerStages('하나\n둘\n셋\n넷 (대표)');
    expect(await state(appended)).toEqual({ state: 'synced', preMerge: [] });

    const changed = mergedRepo('이름\n버전 1', '이름\n버전 2', true);
    changed.ownerStages('이름\n버전 2\n메모 (대표)');
    expect(await state(changed)).toEqual({ state: 'synced', preMerge: [] });
    // 대표가 끝에 줄바꿈만 붙였어도 맞춘 폴더다
    const newlineOnly = mergedRepo('이름\n버전 1', '이름\n버전 2', true);
    newlineOnly.ownerStages('이름\n버전 2\n');
    expect(await state(newlineOnly)).toEqual({ state: 'synced', preMerge: [] });
  });

  it('병합 전 내용 위에 줄을 더한 것은 그대로 병합 변경이 빠진 파일이다 — 병합이 줄 끝만 바꿨으면 가릴 수 없다', async () => {
    const r = mergedRepo('이름\n버전 1', '이름\n버전 2', false);
    r.ownerStages('이름\n버전 1\n메모 (대표)');
    expect(await state(r)).toEqual({ state: 'diverged', preMerge: [], preMergeEdited: ['f.txt'] });

    // 병합이 끝에 줄바꿈만 붙였다 — 대표가 마지막 줄을 고쳐 줄바꿈 없이 두면, 병합 결과 위에 고쳤는지 병합 전 내용 위에 고쳤는지 알 수 없다
    const eol = mergedRepo('가\n나', '가\n나\n', false);
    eol.ownerStages('가\n나 (대표)');
    expect(await state(eol)).toEqual({ state: 'diverged', preMerge: [], unverified: ['f.txt'] });
  });

  // 병합이 줄바꿈으로 끝나는 파일(또는 빈 파일) 끝에 줄바꿈 없는 한 줄만 더하면, 그 뒤에 줄을 더한 대표 내용은 엄격히 재면 병합한 줄이 되돌려진
  // 것으로 잡힌다(병합 변경이 빠짐) — 줄 끝을 무시해 다시 재서 들어 있다고 나오면 알리지 않는다 (GIT-15)
  it('줄바꿈으로 끝나는 파일·빈 파일에 병합이 줄바꿈 없는 줄을 더했으면, 맞춘 폴더에서 대표가 그 뒤에 줄을 더하거나 줄바꿈만 붙여도 맞춘 폴더다', async () => {
    const cases: [string, string, string, string][] = [
      ['줄을 더함', '이름\n버전 1\n', '이름\n버전 1\n버전 2', '이름\n버전 1\n버전 2\n메모 (대표)\n'],
      ['줄바꿈만 붙임', '이름\n버전 1\n', '이름\n버전 1\n버전 2', '이름\n버전 1\n버전 2\n'],
      ['빈 파일, 줄을 더함', '', '{"a": 1}', '{"a": 1}\n메모 (대표)\n'],
      ['빈 파일, 줄바꿈만 붙임', '', '{"a": 1}', '{"a": 1}\n'],
      ['CRLF 파일, 줄을 더함', 'a\r\nb\r\n', 'a\r\nb\r\nc', 'a\r\nb\r\nc\r\nd (대표)\r\n'],
    ];
    for (const [label, before, after, owner] of cases) {
      const r = mergedRepo(before, after, true);
      r.ownerStages(owner);
      expect(await state(r), label).toEqual({ state: 'synced', preMerge: [] });
    }
  });

  it('병합 변경이 빠졌다고 나온 것은 줄 끝을 무시해 다시 재도 들어 있다고 나오지 않으면 그대로 알린다', async () => {
    const cases: [string, string, string, string][] = [
      ['병합 전 내용에 줄을 더함', '이름\n버전 1\n', '이름\n버전 1\n버전 2', '이름\n버전 1\n메모 (대표)\n'],
      ['병합 전 내용에 줄바꿈 없는 줄을 더함', '이름\n버전 1\n', '이름\n버전 1\n버전 2', '이름\n버전 1\n메모 (대표)'],
      ['빈 파일이던 병합 전 내용에 줄을 더함', '', '{"a": 1}', '메모 (대표)\n'],
      // 병합이 끝에 줄바꿈만 붙였다 — 줄 끝을 무시하면 병합이 바꾼 줄이 없지만, 병합 전 내용(줄바꿈 없음)을 고친 것은 확인 못 함으로 낮추지 않는다
      ['줄바꿈만 붙인 병합, 병합 전 첫 줄을 고침', '가\n나', '가\n나\n', '가 (대표)\n나'],
    ];
    for (const [label, before, after, owner] of cases) {
      const r = mergedRepo(before, after, false);
      r.ownerStages(owner);
      expect(await state(r), label).toEqual({ state: 'diverged', preMerge: [], preMergeEdited: ['f.txt'] });
    }
  });

  it('재시작: 맞춤이 한 번 실패한 뒤 대표가 직접 맞춘 폴더에서 병합한 마지막 줄(줄바꿈 없음) 뒤에 줄을 더했으면 다시 알리지 않는다', async () => {
    env = await boot({ team: ['developer'] });
    let e = env;
    commitOnMain(e, 'shared.txt', '이름\n버전 1');
    const [dev1] = e.members as [Env['members'][number]];
    const t1 = await passedRepoTask(e.core, { projectId: e.project.id, assignee: dev1, files: { 'shared.txt': '이름\n버전 2' } });
    const g = e.ctx.deps.git;
    const orig = g.mergeIntoBase.bind(g);
    g.mergeIntoBase = async (repo, m) => {
      const r = await orig(repo, m);
      await e.core.stops.pauseProject(e.project.id, 'graceful', MAIN_AGENT_ID);
      return r;
    };
    g.syncCheckedOutBase = async () => ({ ok: false, detail: "fatal: Unable to create '.git/index.lock': File exists." });
    e.core.merges.requestMerge(t1.id, e.producer, null);
    await waitUntil(() => !e.core.merges.isPending(t1.id) && !!e.ctx.store.tasks.require(t1.id).merge, '병합 기록');
    for (const n of notices(e, ALARM)) e.ctx.store.notifications.put({ ...n, readAt: e.ctx.now() });
    git(e.projectDir, ['reset', '-q', '--hard']); // 대표가 직접 맞춘다
    writeFileSync(join(e.projectDir, 'shared.txt'), '이름\n버전 2\n메모 (대표)', 'utf8');
    git(e.projectDir, ['add', 'shared.txt']);

    e = env = await restartServices(e);
    expect(notices(e, ALARM).filter((n) => !n.readAt)).toEqual([]);
    expect(e.ctx.store.activity.search({ taskId: t1.id, text: '프로젝트 폴더를 맞추지 않음' })).toEqual([]);
    // 대표의 스테이징은 그대로
    expect(git(e.projectDir, ['show', ':shared.txt']).replace(/\r\n/g, '\n')).toBe('이름\n버전 2\n메모 (대표)');
  }, 120_000);

  it('재시작: 줄바꿈으로 끝나는 파일에 작업이 줄바꿈 없는 한 줄을 더해 병합된 뒤, 대표가 직접 맞추고 그 뒤에 줄을 더했으면 다시 알리지 않는다', async () => {
    env = await boot({ team: ['developer'] });
    let e = env;
    commitOnMain(e, 'shared.txt', '이름\n버전 1\n');
    const [dev1] = e.members as [Env['members'][number]];
    const t1 = await passedRepoTask(e.core, { projectId: e.project.id, assignee: dev1, files: { 'shared.txt': '이름\n버전 1\n버전 2' } });
    const g = e.ctx.deps.git;
    const orig = g.mergeIntoBase.bind(g);
    g.mergeIntoBase = async (repo, m) => {
      const r = await orig(repo, m);
      await e.core.stops.pauseProject(e.project.id, 'graceful', MAIN_AGENT_ID);
      return r;
    };
    g.syncCheckedOutBase = async () => ({ ok: false, detail: "fatal: Unable to create '.git/index.lock': File exists." });
    e.core.merges.requestMerge(t1.id, e.producer, null);
    await waitUntil(() => !e.core.merges.isPending(t1.id) && !!e.ctx.store.tasks.require(t1.id).merge, '병합 기록');
    for (const n of notices(e, ALARM)) e.ctx.store.notifications.put({ ...n, readAt: e.ctx.now() });
    git(e.projectDir, ['reset', '-q', '--hard']); // 대표가 직접 맞춘다
    writeFileSync(join(e.projectDir, 'shared.txt'), '이름\n버전 1\n버전 2\n메모 (대표)\n', 'utf8');
    git(e.projectDir, ['add', 'shared.txt']);

    e = env = await restartServices(e);
    expect(notices(e, ALARM).filter((n) => !n.readAt)).toEqual([]);
    expect(e.ctx.store.activity.search({ taskId: t1.id, text: '프로젝트 폴더를 맞추지 않음' })).toEqual([]);
    expect(git(e.projectDir, ['show', ':shared.txt']).replace(/\r\n/g, '\n')).toBe('이름\n버전 1\n버전 2\n메모 (대표)');
  }, 120_000);
});
