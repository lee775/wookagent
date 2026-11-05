/**
 * 병합 뒤 프로젝트 폴더 맞추기(syncCheckedOutBase)는 다른 git이 잠금 파일(index.lock)을 잡고 있으면 기다렸다 다시 하고, 계속 잡혀 있으면
 * 잠금 파일 때문이라고 알린다 (7.1 병합 기록, ARCHITECTURE 10장 '잠금 경합이면 잠깐 기다렸다 다시').
 * 단계 5까지는 `git update-index -q --refresh`를 썼다. -q면 인덱스를 다시 써야 할 때(파일 정보가 바뀐 때) 잠금이 잡혀 있으면 git이 아무
 * 말 없이 128로 끝난다 — 잠금 경합으로 알아보지 못해 다시 하지 않고, 오류 내용도 '종료 코드 128'뿐이었다. 인덱스를 다시 써야 하는지가
 * 시각·부하에 따라 갈려 전체 실행에서만 gitService.test.ts의 잠금 경합 시험이 실패했다.
 * 여기서는 추적 파일의 수정 시각을 바꿔 인덱스를 다시 써야 하는 상태를 늘 만든다.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createGitService } from '../../src/main/git/gitService';
import type { GitIdentity } from '../../src/main/git/types';

const DEV: GitIdentity = { name: '개발자', email: 'M-0002@wook.local' };
const WOOK: GitIdentity = { name: '욱채', email: 'wook@wook.local' };
const git = createGitService();

const roots: string[] = [];
afterEach(async () => {
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const sh = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true }).trim();

/** 기준 브랜치가 체크아웃된 프로젝트 폴더 + 그 폴더보다 앞선 병합 커밋 (폴더는 병합 전 내용) — 인덱스 파일 정보는 낡게 만든다 */
async function behindAfterMerge(): Promise<{ dir: string; pre: string; merged: string; lock: string }> {
  const root = mkdtempSync(join(tmpdir(), 'wook-test-reg-gitlock-'));
  roots.push(root);
  const dir = join(root, 'proj');
  const repo = await git.ensureRepo(dir, { init: true, identity: DEV });
  writeFileSync(join(dir, 'a.txt'), 'a\n', 'utf8');
  await git.commitAll(dir, '[T-0000] a', DEV);
  const wt = join(root, 'wt');
  await git.addWorktree(dir, { path: wt, branch: 'task/T-0001', base: repo.baseBranch });
  writeFileSync(join(wt, 'b.txt'), 'b\n', 'utf8');
  const task = (await git.commitAll(wt, '[T-0001] b', DEV))!;
  const pre = (await git.revParse(dir, 'main'))!;
  const m = await git.mergeIntoBase(dir, { baseBranch: 'main', taskSha: task, expectedBaseSha: pre, message: '[T-0001] 병합', identity: WOOK });
  if (!m.ok) throw new Error(m.detail);
  // 내용은 그대로 두고 수정 시각만 바꾼다 → update-index --refresh가 인덱스를 다시 써야 한다 (잠금이 필요하다)
  const old = new Date(Date.now() - 3_600_000);
  utimesSync(join(dir, 'a.txt'), old, old);
  return { dir, pre, merged: m.mergeSha, lock: join(dir, '.git', 'index.lock') };
}

describe('프로젝트 폴더 맞추기와 다른 git의 잠금 파일', () => {
  it('잠금이 잠깐 잡혀 있으면 기다렸다 다시 해서 맞춘다 (인덱스를 다시 써야 할 때도)', async () => {
    const { dir, pre, merged, lock } = await behindAfterMerge();
    writeFileSync(lock, '');
    const release = setTimeout(() => unlinkSync(lock), 800);
    try {
      const s = await git.syncCheckedOutBase(dir, 'main', pre, merged);
      expect({ ok: s.ok, detail: s.ok ? '' : s.detail, file: existsSync(join(dir, 'b.txt')) }).toEqual({ ok: true, detail: '', file: true });
    } finally {
      clearTimeout(release);
      if (existsSync(lock)) unlinkSync(lock);
    }
    expect(sh(dir, 'status', '--porcelain')).toBe('');
  }, 30_000);

  it('잠금이 계속 잡혀 있으면 폴더를 그대로 두고 잠금 파일(index.lock) 때문이라고 알린다 — 잠금이 풀리면 다시 맞출 수 있다', async () => {
    const { dir, pre, merged, lock } = await behindAfterMerge();
    writeFileSync(lock, '');
    let s;
    try {
      s = await git.syncCheckedOutBase(dir, 'main', pre, merged);
    } finally {
      unlinkSync(lock);
    }
    expect({ ok: s.ok, mentionsLock: /index\.lock/.test(s.detail), file: existsSync(join(dir, 'b.txt')) }).toEqual({ ok: false, mentionsLock: true, file: false });
    expect((await git.syncCheckedOutBase(dir, 'main', pre, merged)).ok).toBe(true);
    expect(existsSync(join(dir, 'b.txt'))).toBe(true);
  }, 30_000);
});
