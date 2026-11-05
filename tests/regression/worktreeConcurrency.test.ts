/**
 * 한 저장소에서 작업 폴더를 동시에 만들고 지워도 git이 실패하지 않는다 (5.7 작업 활성화, 7장 작업 폴더, CLI-09).
 * 스케줄러는 tick 하나에서 작업 여러 개를 활성화하고(팀원마다 하나), 각 활성화가 같은 프로젝트 저장소에 git worktree add를 한다. git은
 * worktree add·list·remove 중에 다른 작업 폴더의 관리 폴더(.git/worktrees/<이름>)를 읽는데, 동시에 만들어지는 중인 폴더의 commondir 파일이
 * 아직 비어 있으면 'fatal: failed to read .git/worktrees/T-0001/commondir'로 128 종료했다 — 그 작업이 '작업 공간 생성 실패'로 보류되고
 * 턴이 뜨지 않아, 부하에서 tests/acceptance/stops.test.ts AC-14('작업 턴 4개', '두 작업 턴')가 시간 초과로 실패했다.
 * 이제 git 서비스가 같은 저장소의 작업 폴더 명령을 차례로 돌린다 (gitService inWorktreeQueue).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createGitService } from '../../src/main/git/gitService';

const DEV = { name: '개발자', email: 'M-0002@wook.local' };
const roots: string[] = [];
afterEach(async () => {
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const id = (n: number) => `T-${String(n).padStart(4, '0')}`;

describe('한 저장소의 작업 폴더를 동시에 만들고 지우기', () => {
  it('여러 작업 폴더를 동시에 만들고(지난 차례 작업 폴더를 지우는 것과 겹쳐도) 모두 만들어지고 지워진다', async () => {
    const git = createGitService();
    const root = mkdtempSync(join(tmpdir(), 'wook-test-reg-wtconc-'));
    roots.push(root);
    const dir = join(root, 'proj');
    const repo = await git.ensureRepo(dir, { init: true, identity: DEV });
    const failures: string[] = [];
    const record = (p: Promise<unknown>) => p.catch((e: Error) => failures.push(e.message.slice(0, 160)));
    const ROUNDS = 8;
    const PER_ROUND = 8;
    let prev: string[] = [];
    for (let round = 0; round < ROUNDS; round++) {
      const ids = Array.from({ length: PER_ROUND }, (_, i) => id(round * PER_ROUND + i + 1));
      // 이번 차례 작업 폴더 만들기와 지난 차례 작업 폴더 지우기(·브랜치 지우기), 목록만 보는 정리(없는 폴더 지우기 = worktree list + prune)를
      // 한꺼번에 — 활성화·완료 정리·검수 사본 정리가 겹치는 것처럼
      await Promise.all([
        ...ids.map((t) => record(git.addWorktree(dir, { path: join(root, 'wt', t), branch: `task/${t}`, base: repo.baseBranch }))),
        ...prev.map((t) => record(git.removeWorktree(dir, join(root, 'wt', t)).then(() => git.deleteBranch(dir, `task/${t}`)))),
        ...ids.map((t) => record(git.removeWorktree(dir, join(root, 'gone', t)))),
      ]);
      prev = ids;
    }
    const list = execList(dir);
    expect({ failures, worktrees: list.length }).toEqual({ failures: [], worktrees: 1 + PER_ROUND });
  }, 240_000);
});

/** 남은 작업 폴더 (본 폴더 포함) — git이 직접 본 목록 */
function execList(dir: string): string[] {
  return execFileSync('git', ['-C', dir, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' })
    .split(/\r?\n/)
    .filter((l) => l.startsWith('worktree '));
}
