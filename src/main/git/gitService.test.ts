/**
 * git 서비스 통합 테스트: 실제 git으로 임시 저장소(경로에 공백·한글)를 만들어 확인한다.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GitError, createGitService, type GitCommandInfo } from './gitService';
import type { GitIdentity } from './types';

const DEV: GitIdentity = { name: '개발자 1', email: 'M-0002@wook.local' };
const QA: GitIdentity = { name: 'QA 담당', email: 'M-0003@wook.local' };
const WOOK: GitIdentity = { name: '욱채', email: 'wook@wook.local' };

let root = '';
let seq = 0;
const commands: GitCommandInfo[] = [];
/** 명령이 끝날 때마다 불리는 시험용 끼어들기 (경합 재현) */
let hook: ((c: GitCommandInfo) => void) | null = null;
const git = createGitService({
  onCommand: (c) => {
    commands.push(c);
    hook?.(c);
  },
});

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'wook-test-깃 서비스 '));
});

// Node 24.13(Windows)의 fs.rmSync({recursive})는 한글 경로에서 프로세스가 죽는다 → 비동기 rm만 쓴다
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function fresh(name: string): string {
  seq += 1;
  const d = path.join(root, `${String(seq).padStart(2, '0')} ${name}`);
  mkdirSync(d, { recursive: true });
  return d;
}

const SH_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: '테스트',
  GIT_AUTHOR_EMAIL: 'test@wook.local',
  GIT_COMMITTER_NAME: '테스트',
  GIT_COMMITTER_EMAIL: 'test@wook.local',
  GIT_TERMINAL_PROMPT: '0',
  LC_ALL: 'C',
};

/** 시험 준비·확인용 직접 git 실행 */
function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.quotepath=false', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    env: SH_ENV,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function write(dir: string, rel: string, content: string | Buffer): void {
  const f = path.join(dir, rel);
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f, content);
}

/** 줄바꿈 변환(core.autocrlf)과 무관하게 비교 */
function read(dir: string, rel: string): string {
  return readFileSync(path.join(dir, rel), 'utf8').replace(/\r\n/g, '\n');
}

async function newRepo(name: string, files: Record<string, string> = { 'README.md': '# 시작\n' }) {
  const dir = fresh(name);
  for (const [k, v] of Object.entries(files)) write(dir, k, v);
  const r = await git.ensureRepo(dir, { init: true, identity: DEV });
  return { dir, ...r };
}

async function commitFiles(dir: string, files: Record<string, string>, message: string, who = DEV): Promise<string> {
  for (const [k, v] of Object.entries(files)) write(dir, k, v);
  const sha = await git.commitAll(dir, message, who);
  if (!sha) throw new Error('커밋이 만들어지지 않았습니다');
  return sha;
}

function parentsOf(dir: string, sha: string): string[] {
  return sh(dir, 'rev-list', '--parents', '-n', '1', sha).split(' ').slice(1);
}

/** 작업 브랜치를 최신 main으로 맞춘 뒤 main에 병합하고 프로젝트 폴더를 동기화 */
async function landTask(repo: string, wt: string, id: string) {
  const up = await git.mergeBaseInto(wt, 'main', `[${id}] 최신 main 반영`, DEV);
  if (!up.ok) throw new Error(`최신 main 반영 실패: ${up.detail}`);
  const pre = await git.revParse(repo, 'refs/heads/main');
  const r = await git.mergeIntoBase(repo, {
    baseBranch: 'main',
    taskSha: up.sha,
    expectedBaseSha: pre!,
    message: `[${id}] 병합: ${id}\n\nWook-Task: ${id}\nWook-Request: RQ-000001`,
    identity: WOOK,
  });
  if (!r.ok) throw new Error(`병합 실패: ${r.reason} ${r.detail}`);
  const s = await git.syncCheckedOutBase(repo, 'main', r.preSha, r.mergeSha);
  if (!s.ok) throw new Error(`동기화 실패: ${s.detail}`);
  return { taskSha: up.sha, ...r };
}

describe('version · isRepo', () => {
  it('git 버전을 돌려주고, git이 없으면 null', async () => {
    expect(await git.version()).toMatch(/^\d+\.\d+/);
    const missing = createGitService({ gitPath: path.join(root, '없는 git', 'git.exe') });
    expect(await missing.version()).toBeNull();
  });

  it('저장소 최상위 폴더만 저장소로 본다', async () => {
    const plain = fresh('일반 폴더');
    expect(await git.isRepo(path.join(plain, '없음'))).toBe(false);
    expect(await git.isRepo(plain)).toBe(false);
    const { dir } = await newRepo('저장소', { 'sub/a.txt': 'a\n' });
    expect(await git.isRepo(dir)).toBe(true);
    expect(await git.isRepo(path.join(dir, 'sub'))).toBe(false);
  });
});

describe('ensureRepo', () => {
  it('빈 폴더: git init -b main + 빈 첫 커밋 (작성자 = 팀원, 커미터 = 욱채)', async () => {
    const dir = fresh('빈 폴더');
    const r = await git.ensureRepo(dir, { init: true, identity: DEV });
    expect(r.initialized).toBe(true);
    expect(r.baseBranch).toBe('main');
    expect(r.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(sh(dir, 'log', '--format=%an|%ae|%cn|%ce', '-n', '1')).toBe('개발자 1|M-0002@wook.local|욱채|wook@wook.local');
    expect(sh(dir, 'ls-files')).toBe('');
    expect((await git.status(dir)).clean).toBe(true);
    // 다시 불러도 그대로
    expect(await git.ensureRepo(dir, { init: true, identity: DEV })).toEqual({ ...r, initialized: false });
  });

  it('파일이 있는 폴더: 한글·공백 파일 이름까지 첫 커밋에 넣는다', async () => {
    const { dir, headSha, initialized } = await newRepo('파일 있는 폴더', {
      '한글 문서.md': '내용\n',
      '폴더 1/코드.ts': 'export {};\n',
    });
    expect(initialized).toBe(true);
    expect(sh(dir, 'ls-files').split('\n').sort()).toEqual(['폴더 1/코드.ts', '한글 문서.md']);
    expect(await git.revParse(dir, 'HEAD')).toBe(headSha);
    expect((await git.status(dir)).clean).toBe(true);
  });

  it('폴더가 없으면 init=true일 때 만든다', async () => {
    const dir = path.join(fresh('상위'), '새 프로젝트');
    const r = await git.ensureRepo(dir, { init: true, identity: DEV });
    expect(r.initialized).toBe(true);
    expect(await git.isRepo(dir)).toBe(true);
  });

  it('저장소가 아니고 init=false면 오류', async () => {
    const dir = fresh('저장소 아님');
    await expect(git.ensureRepo(dir, { init: false, identity: DEV })).rejects.toBeInstanceOf(GitError);
    await expect(git.ensureRepo(path.join(dir, '없음'), { init: false, identity: DEV })).rejects.toBeInstanceOf(GitError);
  });

  it('기존 저장소: 체크아웃된 브랜치를 기준으로 쓰고 커밋을 더 만들지 않는다', async () => {
    const dir = fresh('기존 저장소');
    sh(dir, 'init', '-q', '-b', 'dev');
    write(dir, 'x.txt', 'x\n');
    sh(dir, 'add', '-A');
    sh(dir, 'commit', '-q', '-m', 'init');
    const head = sh(dir, 'rev-parse', 'HEAD');
    const r = await git.ensureRepo(dir, { init: true, identity: DEV });
    expect(r).toEqual({ initialized: false, baseBranch: 'dev', headSha: head });
    expect(sh(dir, 'rev-list', '--count', 'HEAD')).toBe('1');
  });

  it('커밋이 없는 기존 저장소: 첫 커밋을 만든다', async () => {
    const dir = fresh('커밋 없는 저장소');
    sh(dir, 'init', '-q', '-b', 'trunk');
    write(dir, '파일.txt', '1\n');
    const r = await git.ensureRepo(dir, { init: false, identity: DEV });
    expect(r.initialized).toBe(false);
    expect(r.baseBranch).toBe('trunk');
    expect(sh(dir, 'ls-files')).toBe('파일.txt');
    expect(r.headSha).toBe(sh(dir, 'rev-parse', 'HEAD'));
  });

  it('분리 HEAD: main이 있으면 main, 없으면 오류', async () => {
    const { dir } = await newRepo('분리 HEAD');
    const second = await commitFiles(dir, { 'b.txt': 'b\n' }, '둘째');
    sh(dir, 'checkout', '-q', '--detach', 'HEAD~1');
    expect(await git.currentBranch(dir)).toBeNull();
    const r = await git.ensureRepo(dir, { init: true, identity: DEV });
    expect(r.baseBranch).toBe('main');
    expect(r.headSha).toBe(second);
    sh(dir, 'branch', '-m', 'main', 'dev');
    await expect(git.ensureRepo(dir, { init: true, identity: DEV })).rejects.toThrow(/분리 HEAD/);
  });

  it('다른 저장소가 관리하는 하위 폴더는 거부, 관리하지 않는 하위 폴더는 따로 만든다', async () => {
    const { dir, headSha } = await newRepo('상위 저장소', { 'sub/a.txt': 'a\n' });
    await expect(git.ensureRepo(path.join(dir, 'sub'), { init: true, identity: DEV })).rejects.toThrow(/하위 폴더/);
    const nested = path.join(dir, 'nested 폴더');
    write(nested, 'n.txt', 'n\n');
    const r = await git.ensureRepo(nested, { init: true, identity: DEV });
    expect(r.initialized).toBe(true);
    expect(await git.isRepo(nested)).toBe(true);
    expect(sh(nested, 'ls-files')).toBe('n.txt');
    expect(await git.revParse(dir, 'HEAD')).toBe(headSha);
  });

  it('bare 저장소는 거부', async () => {
    const dir = fresh('bare');
    sh(dir, 'init', '-q', '--bare');
    await expect(git.ensureRepo(dir, { init: true, identity: DEV })).rejects.toBeInstanceOf(GitError);
  });
});

describe('commitAll · status · hasTrackedChanges', () => {
  it('한글 파일 이름 커밋, 변경이 없으면 null', async () => {
    const { dir } = await newRepo('단계 커밋');
    write(dir, '한글 폴더/새 파일.txt', '안녕하세요\n');
    write(dir, 'README.md', '# 바뀜\n');
    const st = await git.status(dir);
    expect(st.clean).toBe(false);
    expect(st.trackedDirty).toBe(true);
    expect(st.untracked).toEqual(['한글 폴더/새 파일.txt']);
    expect(st.files).toEqual(
      expect.arrayContaining([
        { path: 'README.md', code: ' M' },
        { path: '한글 폴더/새 파일.txt', code: '??' },
      ]),
    );
    const sha = await git.commitAll(dir, '[T-0001] 단계 1: 화면 만들기', DEV);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(sh(dir, 'log', '-n', '1', '--format=%s|%an|%ae|%cn|%ce')).toBe(
      '[T-0001] 단계 1: 화면 만들기|개발자 1|M-0002@wook.local|욱채|wook@wook.local',
    );
    expect(sh(dir, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort()).toEqual([
      'README.md',
      '한글 폴더/새 파일.txt',
    ]);
    expect((await git.status(dir)).clean).toBe(true);
    expect(await git.commitAll(dir, '[T-0001] 빈 단계', DEV)).toBeNull();
    await expect(git.commitAll(dir, '   ', DEV)).rejects.toBeInstanceOf(GitError);
  });

  it('hasTrackedChanges는 미추적 파일을 무시한다', async () => {
    const { dir } = await newRepo('추적 변경');
    write(dir, '미추적.txt', 'u\n');
    expect(await git.hasTrackedChanges(dir)).toBe(false);
    expect((await git.status(dir)).trackedDirty).toBe(false);
    write(dir, 'README.md', '# 수정\n');
    expect(await git.hasTrackedChanges(dir)).toBe(true);
    sh(dir, 'checkout', '--', 'README.md');
    expect(await git.hasTrackedChanges(dir)).toBe(false);
    sh(dir, 'add', '미추적.txt');
    expect(await git.hasTrackedChanges(dir)).toBe(true);
  });
});

describe('commitPaths', () => {
  it('지정한 파일만 커밋하고 대표의 다른 변경·스테이징은 그대로 둔다', async () => {
    const { dir } = await newRepo('지침 파일', { 'CLAUDE.md': 'old\n', 'user.txt': 'x\n' });
    write(dir, 'user.txt', 'staged\n');
    sh(dir, 'add', 'user.txt');
    write(dir, '대표 메모.txt', '미추적\n');
    write(dir, 'CLAUDE.md', 'new\n');
    write(dir, 'AGENTS.md', 'agents\n');
    const before = (await git.revParse(dir, 'HEAD'))!;

    const sha = await git.commitPaths(dir, ['AGENTS.md', 'CLAUDE.md'], '[욱채] 지침 파일 설정', WOOK);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect((await git.diffStat(dir, before, sha!)).map((f) => `${f.status} ${f.path}`).sort()).toEqual([
      'A AGENTS.md',
      'M CLAUDE.md',
    ]);
    const st = await git.status(dir);
    expect(st.files).toEqual(
      expect.arrayContaining([
        { path: 'user.txt', code: 'M ' },
        { path: '대표 메모.txt', code: '??' },
      ]),
    );
    expect(st.files.map((f) => f.path)).not.toContain('CLAUDE.md');
    expect(st.files.map((f) => f.path)).not.toContain('AGENTS.md');

    expect(await git.commitPaths(dir, ['AGENTS.md', 'CLAUDE.md'], '[욱채] 다시', WOOK)).toBeNull();
    await expect(git.commitPaths(dir, ['../밖.txt'], '[욱채] 밖', WOOK)).rejects.toBeInstanceOf(GitError);

    // 폴더 안의 절대 경로·폴더 단위도 된다
    write(dir, 'docs/가이드 [1].md', '안내\n');
    const sha2 = await git.commitPaths(dir, [path.join(dir, 'docs')], '[욱채] 문서', WOOK);
    expect((await git.diffStat(dir, sha!, sha2!)).map((f) => f.path)).toEqual(['docs/가이드 [1].md']);
    expect((await git.status(dir)).files).toEqual(expect.arrayContaining([{ path: 'user.txt', code: 'M ' }]));
  });
});

describe('addWorktree · addDetachedWorktree · removeWorktree', () => {
  it('작업 폴더 생성은 멱등이고, 제거는 두 번 해도 된다', async () => {
    const { dir, headSha } = await newRepo('작업 폴더');
    const wt = path.join(fresh('worktrees'), 'P-0001', 'T-0001');
    const a = await git.addWorktree(dir, { path: wt, branch: 'task/T-0001-로그인', base: 'main' });
    expect(a).toEqual({ created: true, headSha });
    expect(await git.currentBranch(wt)).toBe('task/T-0001-로그인');
    expect(read(wt, 'README.md')).toBe('# 시작\n');
    expect(await git.addWorktree(dir, { path: wt, branch: 'task/T-0001-로그인', base: 'main' })).toEqual({
      created: false,
      headSha,
    });

    const work = await commitFiles(wt, { 'login.ts': 'login\n' }, '[T-0001] 로그인');
    await git.removeWorktree(dir, wt);
    expect(existsSync(wt)).toBe(false);
    await git.removeWorktree(dir, wt);
    expect(sh(dir, 'worktree', 'list', '--porcelain')).not.toContain('T-0001');

    // 브랜치만 남은 상태: 그 브랜치로 다시 붙인다
    const again = await git.addWorktree(dir, { path: wt, branch: 'task/T-0001-로그인', base: 'main' });
    expect(again).toEqual({ created: true, headSha: work });
    expect(read(wt, 'login.ts')).toBe('login\n');
  });

  it('지워진 작업 폴더 기록은 정리하고 다시 만든다', async () => {
    const { dir, headSha } = await newRepo('지워진 작업 폴더');
    const wt = path.join(fresh('worktrees'), 'T-0002');
    await git.addWorktree(dir, { path: wt, branch: 'task/T-0002', base: 'main' });
    await rm(wt, { recursive: true, force: true });
    expect(await git.addWorktree(dir, { path: wt, branch: 'task/T-0002', base: 'main' })).toEqual({
      created: true,
      headSha,
    });
  });

  it('잘못된 경로·브랜치는 거부하고 빈 브랜치를 남기지 않는다', async () => {
    const { dir } = await newRepo('작업 폴더 오류');
    const base = fresh('worktrees');
    const occupied = path.join(base, '사용 중');
    write(occupied, 'keep.txt', '대표 파일\n');
    await expect(git.addWorktree(dir, { path: occupied, branch: 'task/T-0003', base: 'main' })).rejects.toThrow(
      /작업 폴더가 아닙니다/,
    );
    expect(await git.revParse(dir, 'refs/heads/task/T-0003')).toBeNull();
    expect(read(occupied, 'keep.txt')).toBe('대표 파일\n');

    const wt = path.join(base, 'T-0004');
    await git.addWorktree(dir, { path: wt, branch: 'task/T-0004', base: 'main' });
    await expect(git.addWorktree(dir, { path: wt, branch: 'task/T-0005', base: 'main' })).rejects.toBeInstanceOf(
      GitError,
    );
    await expect(
      git.addWorktree(dir, { path: path.join(base, 'T-0004b'), branch: 'task/T-0004', base: 'main' }),
    ).rejects.toThrow(/다른 작업 폴더/);
    await expect(git.addWorktree(dir, { path: path.join(base, 'x'), branch: 'bad name', base: 'main' })).rejects.toThrow(
      /브랜치 이름/,
    );
    await expect(git.addWorktree(dir, { path: path.join(base, 'y'), branch: '-x', base: 'main' })).rejects.toBeInstanceOf(
      GitError,
    );
    await expect(git.removeWorktree(dir, dir)).rejects.toThrow(/기본 작업 폴더/);
    // 작업 폴더가 아닌 폴더는 지우지 않는다
    await expect(git.removeWorktree(dir, occupied)).rejects.toThrow(/지우지 않았습니다/);
    expect(read(occupied, 'keep.txt')).toBe('대표 파일\n');
  });

  it('검수용 읽기 사본은 분리 HEAD로 만든다 (멱등)', async () => {
    const { dir, headSha } = await newRepo('검수 사본');
    await commitFiles(dir, { 'v2.txt': '2\n' }, '둘째');
    const rv = path.join(fresh('review'), `T-0001-r1-${headSha.slice(0, 8)}`);
    await git.addDetachedWorktree(dir, { path: rv, commit: headSha });
    expect(await git.currentBranch(rv)).toBeNull();
    expect(await git.revParse(rv, 'HEAD')).toBe(headSha);
    expect(existsSync(path.join(rv, 'v2.txt'))).toBe(false);
    await git.addDetachedWorktree(dir, { path: rv, commit: headSha });
    await expect(git.addDetachedWorktree(dir, { path: rv, commit: 'main' })).rejects.toBeInstanceOf(GitError);
    await git.removeWorktree(dir, rv);
    expect(existsSync(rv)).toBe(false);
  });
});

describe('mergeBaseInto · concludeMerge · abortMerge', () => {
  it('이미 최신이면 upToDate, 충돌 없는 반영은 병합 커밋', async () => {
    const { dir } = await newRepo('최신 반영', { 'a.txt': 'a\n', 'b.txt': 'b\n' });
    const wt = path.join(fresh('worktrees'), 'T-0001');
    await git.addWorktree(dir, { path: wt, branch: 'task/T-0001', base: 'main' });
    const t1 = await commitFiles(wt, { 'a.txt': 'a 작업\n' }, '[T-0001] a');
    expect(await git.mergeBaseInto(wt, 'main', '[T-0001] 최신 main 반영', DEV)).toEqual({ ok: true, sha: t1, upToDate: true });

    const m1 = await commitFiles(dir, { 'b.txt': 'b main\n' }, 'main 진행');
    const r = await git.mergeBaseInto(wt, 'main', '[T-0001] 최신 main 반영', DEV);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.upToDate).toBe(false);
    expect(parentsOf(wt, r.sha)).toEqual([t1, m1]);
    expect(sh(wt, 'log', '-n', '1', '--format=%s|%an|%cn')).toBe('[T-0001] 최신 main 반영|개발자 1|욱채');
    expect(read(wt, 'a.txt')).toBe('a 작업\n');
    expect(read(wt, 'b.txt')).toBe('b main\n');
    expect((await git.status(wt)).clean).toBe(true);
  });

  it('충돌: 병합 상태와 표시를 남기고, 해결 후 concludeMerge', async () => {
    const { dir } = await newRepo('충돌 반영', { '충돌 파일.txt': 'base\n', 'other.txt': 'o\n' });
    const wt = path.join(fresh('worktrees'), 'T-0001');
    await git.addWorktree(dir, { path: wt, branch: 'task/T-0001', base: 'main' });
    const t1 = await commitFiles(wt, { '충돌 파일.txt': 'task\n' }, '[T-0001] 작업');
    const m1 = await commitFiles(dir, { '충돌 파일.txt': 'main\n', 'other.txt': 'o2\n' }, 'main 진행');

    const r = await git.mergeBaseInto(wt, 'main', '[T-0001] 최신 main 반영', DEV);
    expect(r).toMatchObject({ ok: false, conflicts: ['충돌 파일.txt'] });
    const text = read(wt, '충돌 파일.txt');
    expect(text).toContain('<<<<<<< HEAD');
    expect(text).toContain('>>>>>>> refs/heads/main');
    const st = await git.status(wt);
    expect(st).toMatchObject({ clean: false, mergeInProgress: true, unmerged: ['충돌 파일.txt'] });
    // 다시 불러도 같은 충돌을 알려준다 (멱등)
    expect(await git.mergeBaseInto(wt, 'main', '[T-0001] 최신 main 반영', DEV)).toMatchObject({
      ok: false,
      conflicts: ['충돌 파일.txt'],
    });
    await expect(git.commitAll(wt, '[T-0001] 단계', DEV)).rejects.toThrow(/병합이 진행 중/);
    await expect(git.concludeMerge(wt, '[T-0001] 충돌 해결', DEV)).rejects.toThrow(/충돌 표시/);

    // 팀원이 파일만 고친다 (git add 없이)
    write(wt, '충돌 파일.txt', 'task + main\n');
    const sha = await git.concludeMerge(wt, '[T-0001] 최신 main 반영 충돌 해결', QA);
    expect(parentsOf(wt, sha)).toEqual([t1, m1]);
    expect(sh(wt, 'log', '-n', '1', '--format=%B').trim()).toBe('[T-0001] 최신 main 반영 충돌 해결');
    expect(sh(wt, 'log', '-n', '1', '--format=%an|%cn')).toBe('QA 담당|욱채');
    const after = await git.status(wt);
    expect(after).toMatchObject({ clean: true, mergeInProgress: false, unmerged: [] });
    expect(read(wt, 'other.txt')).toBe('o2\n');
    await expect(git.concludeMerge(wt, 'x', DEV)).rejects.toThrow(/진행 중인 병합이 없습니다/);
  });

  it('메시지 없이 concludeMerge하면 병합 메시지에서 "# Conflicts" 주석을 뺀다', async () => {
    const { dir } = await newRepo('기본 메시지', { 'c.txt': 'base\n' });
    const wt = path.join(fresh('worktrees'), 'T-0001');
    await git.addWorktree(dir, { path: wt, branch: 'task/T-0001', base: 'main' });
    await commitFiles(wt, { 'c.txt': 'task\n' }, '[T-0001] 작업');
    await commitFiles(dir, { 'c.txt': 'main\n' }, 'main 진행');
    expect((await git.mergeBaseInto(wt, 'main', '[T-0001] 최신 main 반영', DEV)).ok).toBe(false);
    write(wt, 'c.txt', 'merged\n');
    await git.concludeMerge(wt, '', DEV);
    expect(sh(wt, 'log', '-n', '1', '--format=%B').trim()).toBe('[T-0001] 최신 main 반영');
  });

  it('conflictCheck: 해결 여부는 인덱스가 아니라 작업 폴더 내용으로 본다 — 표시가 남은 텍스트만 미해결, 표시가 없는 충돌(바이너리·수정/삭제)은 내용으로 확인할 수 없음', async () => {
    const { dir } = await newRepo('충돌 내용 확인', { 'text.txt': 'base\n', 'img.bin': 'base\n', 'gone.txt': 'base\n', 'kept.txt': 'base\n' });
    const wt = path.join(fresh('worktrees'), 'T-0001');
    await git.addWorktree(dir, { path: wt, branch: 'task/T-0001', base: 'main' });
    // 작업: 텍스트·바이너리 수정, gone.txt 수정, kept.txt 삭제 / main: 같은 텍스트·바이너리 수정, gone.txt 삭제, kept.txt 수정
    write(wt, 'text.txt', 'task\n');
    write(wt, 'img.bin', Buffer.from([0, 1, 2, 3]));
    write(wt, 'gone.txt', 'task\n');
    unlinkSync(path.join(wt, 'kept.txt'));
    await git.commitAll(wt, '[T-0001] 작업', DEV);
    write(dir, 'text.txt', 'main\n');
    write(dir, 'img.bin', Buffer.from([0, 9, 9, 9]));
    unlinkSync(path.join(dir, 'gone.txt'));
    write(dir, 'kept.txt', 'main\n');
    await git.commitAll(dir, 'main 진행', DEV);
    expect((await git.mergeBaseInto(wt, 'main', '[T-0001] 최신 main 반영', DEV)).ok).toBe(false);

    const c = await git.conflictCheck(wt);
    expect([...c.unmerged].sort()).toEqual(['gone.txt', 'img.bin', 'kept.txt', 'text.txt']);
    expect(c.withMarkers).toEqual(['text.txt']);
    expect([...c.unverifiable].sort()).toEqual(['gone.txt', 'img.bin', 'kept.txt']);

    // 팀원이 파일만 고친다 (git 없이): 인덱스의 충돌 표시는 그대로지만 내용으로는 해결. 작업 폴더에서 지운 파일은 지우기로 해결
    write(wt, 'text.txt', 'task + main\n');
    unlinkSync(path.join(wt, 'gone.txt'));
    const c2 = await git.conflictCheck(wt);
    expect([...(await git.status(wt)).unmerged].sort()).toEqual(['gone.txt', 'img.bin', 'kept.txt', 'text.txt']);
    expect(c2.withMarkers).toEqual([]);
    expect([...c2.unverifiable].sort()).toEqual(['img.bin', 'kept.txt']);

    // 확인은 아무것도 바꾸지 않는다 — concludeMerge가 작업 폴더에 있는 그대로 커밋한다
    await git.concludeMerge(wt, '[T-0001] 최신 main 반영 충돌 해결', QA);
    expect(await git.status(wt)).toMatchObject({ clean: true, mergeInProgress: false, unmerged: [] });
    expect(read(wt, 'text.txt')).toBe('task + main\n');
    expect(existsSync(path.join(wt, 'gone.txt'))).toBe(false);
    expect(readFileSync(path.join(wt, 'img.bin'))).toEqual(Buffer.from([0, 1, 2, 3]));
    expect(read(wt, 'kept.txt')).toBe('main\n');
  });

  it('abortMerge는 병합 전 상태로 돌리고, 병합이 없으면 아무것도 안 한다', async () => {
    const { dir } = await newRepo('병합 취소', { 'c.txt': 'base\n' });
    const wt = path.join(fresh('worktrees'), 'T-0001');
    await git.addWorktree(dir, { path: wt, branch: 'task/T-0001', base: 'main' });
    const t1 = await commitFiles(wt, { 'c.txt': 'task\n' }, '[T-0001] 작업');
    await commitFiles(dir, { 'c.txt': 'main\n' }, 'main 진행');
    expect((await git.mergeBaseInto(wt, 'main', '[T-0001] 최신 main 반영', DEV)).ok).toBe(false);
    await git.abortMerge(wt);
    expect(await git.status(wt)).toMatchObject({ clean: true, mergeInProgress: false });
    expect(await git.revParse(wt, 'HEAD')).toBe(t1);
    expect(read(wt, 'c.txt')).toBe('task\n');
    await git.abortMerge(wt);
  });

  it('커밋되지 않은 변경이 있으면 반영하지 않는다', async () => {
    const { dir } = await newRepo('더러운 작업 폴더', { 'c.txt': 'base\n' });
    const wt = path.join(fresh('worktrees'), 'T-0001');
    await git.addWorktree(dir, { path: wt, branch: 'task/T-0001', base: 'main' });
    await commitFiles(dir, { 'd.txt': 'main\n' }, 'main 진행');
    write(wt, 'c.txt', '작업 중\n');
    await expect(git.mergeBaseInto(wt, 'main', '[T-0001] 최신 main 반영', DEV)).rejects.toThrow(/커밋되지 않은 변경/);
    expect(read(wt, 'c.txt')).toBe('작업 중\n');
  });
});

describe('mergeIntoBase · syncCheckedOutBase · findMergeCommit', () => {
  it('정상 병합: parents [기준, 작업], 기준 브랜치 이동, 프로젝트 폴더 동기화, 복구 확인', async () => {
    const { dir, headSha: base0 } = await newRepo('main 병합', { 'app.txt': 'v0\n' });
    const wt = path.join(fresh('worktrees'), 'T-0001');
    await git.addWorktree(dir, { path: wt, branch: 'task/T-0001-기능', base: 'main' });
    const task = await commitFiles(wt, { 'app.txt': 'v1\n', '새 기능.txt': '기능\n' }, '[T-0001] 기능');

    const message = '[T-0001] 병합: 기능 추가\n\nWook-Task: T-0001\nWook-Request: RQ-000123';
    const r = await git.mergeIntoBase(dir, { baseBranch: 'main', taskSha: task, expectedBaseSha: base0, message, identity: WOOK });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.preSha).toBe(base0);
    expect(await git.revParse(dir, 'refs/heads/main')).toBe(r.mergeSha);
    expect(parentsOf(dir, r.mergeSha)).toEqual([base0, task]);
    expect(sh(dir, 'rev-parse', `${r.mergeSha}^{tree}`)).toBe(sh(dir, 'rev-parse', `${task}^{tree}`));
    expect(sh(dir, 'log', '-n', '1', '--format=%B', r.mergeSha).trim()).toBe(message);
    expect(sh(dir, 'log', '-n', '1', '--format=%cn|%ce', r.mergeSha)).toBe('욱채|wook@wook.local');
    expect(sh(dir, 'reflog', '-n', '1', '--format=%gs', 'refs/heads/main')).toBe('wook merge');

    // 작업 트리는 아직 예전 상태 → 동기화 필요
    expect(read(dir, 'app.txt')).toBe('v0\n');
    expect(await git.hasTrackedChanges(dir)).toBe(true);
    const s = await git.syncCheckedOutBase(dir, 'main', base0, r.mergeSha);
    expect(s.ok).toBe(true);
    expect(read(dir, 'app.txt')).toBe('v1\n');
    expect(read(dir, '새 기능.txt')).toBe('기능\n');
    expect((await git.status(dir)).clean).toBe(true);

    expect(await git.findMergeCommit(dir, 'main', base0, task)).toBe(r.mergeSha);
    expect(await git.findMergeCommit(dir, 'main', base0, base0)).toBeNull();
    expect(await git.findMergeCommit(dir, 'main', r.mergeSha, task)).toBeNull();

    // 같은 작업을 다시 병합하려 하면 기준이 바뀌었다고 거부 (중복 실행 방지)
    const dup = await git.mergeIntoBase(dir, { baseBranch: 'main', taskSha: task, expectedBaseSha: base0, message, identity: WOOK });
    expect(dup).toMatchObject({ ok: false, reason: 'base_moved' });
  });

  it('base_moved · not_up_to_date · 변경 없음은 병합하지 않는다', async () => {
    const { dir, headSha: base0 } = await newRepo('병합 거부', { 'a.txt': 'a\n' });
    const wt = path.join(fresh('worktrees'), 'T-0001');
    await git.addWorktree(dir, { path: wt, branch: 'task/T-0001', base: 'main' });
    const task = await commitFiles(wt, { 'a.txt': 'a 작업\n' }, '[T-0001] 작업');
    const base1 = await commitFiles(dir, { 'b.txt': 'b\n' }, 'main 진행');
    const msg = '[T-0001] 병합';

    const moved = await git.mergeIntoBase(dir, { baseBranch: 'main', taskSha: task, expectedBaseSha: base0, message: msg, identity: WOOK });
    expect(moved).toMatchObject({ ok: false, reason: 'base_moved' });
    const stale = await git.mergeIntoBase(dir, { baseBranch: 'main', taskSha: task, expectedBaseSha: base1, message: msg, identity: WOOK });
    expect(stale).toMatchObject({ ok: false, reason: 'not_up_to_date' });
    const same = await git.mergeIntoBase(dir, { baseBranch: 'main', taskSha: base1, expectedBaseSha: base1, message: msg, identity: WOOK });
    expect(same).toMatchObject({ ok: false, reason: 'error' });
    const noBranch = await git.mergeIntoBase(dir, { baseBranch: 'release', taskSha: task, expectedBaseSha: base1, message: msg, identity: WOOK });
    expect(noBranch).toMatchObject({ ok: false, reason: 'error' });
    expect(await git.revParse(dir, 'refs/heads/main')).toBe(base1);
  });

  it('병합 커밋을 만든 직후 다른 쪽이 기준을 바꾸면 base_moved (update-ref 비교 후 교체)', async () => {
    const { dir, headSha: base0 } = await newRepo('병합 경합', { 'a.txt': 'a\n' });
    const wt = path.join(fresh('worktrees'), 'T-0001');
    await git.addWorktree(dir, { path: wt, branch: 'task/T-0001', base: 'main' });
    const task = await commitFiles(wt, { 'a.txt': 'a 작업\n' }, '[T-0001] 작업');
    const racer = sh(dir, 'commit-tree', `${base0}^{tree}`, '-p', base0, '-m', '다른 병합');
    hook = (c) => {
      if (c.args[0] === 'commit-tree') {
        hook = null;
        sh(dir, 'update-ref', 'refs/heads/main', racer, base0);
      }
    };
    try {
      const r = await git.mergeIntoBase(dir, { baseBranch: 'main', taskSha: task, expectedBaseSha: base0, message: '[T-0001] 병합', identity: WOOK });
      expect(r).toMatchObject({ ok: false, reason: 'base_moved' });
    } finally {
      hook = null;
    }
    expect(await git.revParse(dir, 'refs/heads/main')).toBe(racer);
  });

  it('동기화: 기준이 체크아웃돼 있지 않으면 그대로, 로컬 변경과 겹치면 아무것도 바꾸지 않고 실패', async () => {
    const { dir, headSha: base0 } = await newRepo('동기화', { 'shared.txt': 'v0\n' });
    const wt = path.join(fresh('worktrees'), 'T-0001');
    await git.addWorktree(dir, { path: wt, branch: 'task/T-0001', base: 'main' });
    const task = await commitFiles(wt, { 'shared.txt': 'v1\n' }, '[T-0001] 작업');
    const r = await git.mergeIntoBase(dir, { baseBranch: 'main', taskSha: task, expectedBaseSha: base0, message: '[T-0001] 병합', identity: WOOK });
    if (!r.ok) throw new Error(r.detail);

    // 대표가 병합 사이에 같은 파일을 고친 경우
    write(dir, 'shared.txt', '대표 수정\n');
    const fail = await git.syncCheckedOutBase(dir, 'main', base0, r.mergeSha);
    expect(fail.ok).toBe(false);
    expect(fail.detail).toMatch(/맞추지 못했습니다/);
    expect(read(dir, 'shared.txt')).toBe('대표 수정\n');
    expect(sh(dir, 'ls-files', '-s', 'shared.txt')).toContain(sh(dir, 'rev-parse', `${base0}:shared.txt`));

    // 대표가 변경을 정리하면 다시 맞출 수 있다
    write(dir, 'shared.txt', 'v0\n');
    expect((await git.syncCheckedOutBase(dir, 'main', base0, r.mergeSha)).ok).toBe(true);
    expect(read(dir, 'shared.txt')).toBe('v1\n');
    expect((await git.status(dir)).clean).toBe(true);

    // 다른 브랜치가 체크아웃돼 있으면 건드리지 않는다
    sh(dir, 'checkout', '-q', '-b', 'other');
    await commitFiles(wt, { 'shared.txt': 'v2\n' }, '[T-0001] 추가');
    const up = await git.mergeBaseInto(wt, 'main', '[T-0001] 최신 main 반영', DEV);
    if (!up.ok) throw new Error(up.detail);
    const r2 = await git.mergeIntoBase(dir, { baseBranch: 'main', taskSha: up.sha, expectedBaseSha: r.mergeSha, message: '[T-0001] 병합 2', identity: WOOK });
    if (!r2.ok) throw new Error(r2.detail);
    const skip = await git.syncCheckedOutBase(dir, 'main', r.mergeSha, r2.mergeSha);
    expect(skip.ok).toBe(true);
    expect(read(dir, 'shared.txt')).toBe('v1\n');
    expect((await git.status(dir)).clean).toBe(true);
  });
});

describe('revertMerge (AC-12)', () => {
  it('A 뒤에 B가 병합된 상태에서 A만 되돌리고 B는 유지, 되돌리기도 같은 병합 절차로 반영', async () => {
    const { dir } = await newRepo('선택 되돌리기', { 'a.txt': 'a0\n', 'b.txt': 'b0\n' });
    const wts = fresh('worktrees');
    const wtA = path.join(wts, 'T-0001');
    const wtB = path.join(wts, 'T-0002');
    await git.addWorktree(dir, { path: wtA, branch: 'task/T-0001-a', base: 'main' });
    await git.addWorktree(dir, { path: wtB, branch: 'task/T-0002-b', base: 'main' });
    await commitFiles(wtA, { 'a.txt': 'a1\n', 'a-추가.txt': 'A 새 파일\n' }, '[T-0001] A');
    await commitFiles(wtB, { 'b.txt': 'b1\n' }, '[T-0002] B', QA);

    const mA = await landTask(dir, wtA, 'T-0001');
    const mB = await landTask(dir, wtB, 'T-0002');
    expect(read(dir, 'a.txt')).toBe('a1\n');
    expect(read(dir, 'b.txt')).toBe('b1\n');

    const wtR = path.join(wts, 'T-0003');
    await git.addWorktree(dir, { path: wtR, branch: 'task/T-0003-revert', base: 'main' });
    const rv = await git.revertMerge(wtR, mA.mergeSha, '[T-0003] T-0001 되돌리기\n\nWook-Revert-Of: T-0001', DEV);
    expect(rv.ok).toBe(true);
    if (!rv.ok) return;
    expect(parentsOf(wtR, rv.sha)).toEqual([mB.mergeSha]);
    expect(sh(wtR, 'log', '-n', '1', '--format=%B').trim()).toBe('[T-0003] T-0001 되돌리기\n\nWook-Revert-Of: T-0001');
    expect(read(wtR, 'a.txt')).toBe('a0\n');
    expect(existsSync(path.join(wtR, 'a-추가.txt'))).toBe(false);
    expect(read(wtR, 'b.txt')).toBe('b1\n');
    expect(await git.revParse(wtR, 'REVERT_HEAD')).toBeNull();
    expect((await git.status(wtR)).clean).toBe(true);

    const rR = await landTask(dir, wtR, 'T-0003');
    expect(rR.preSha).toBe(mB.mergeSha);
    expect(read(dir, 'a.txt')).toBe('a0\n');
    expect(existsSync(path.join(dir, 'a-추가.txt'))).toBe(false);
    expect(read(dir, 'b.txt')).toBe('b1\n');
    // main을 과거로 옮기지 않았다: 이전 병합이 모두 이력에 남는다
    expect(await git.isAncestor(dir, mA.mergeSha, 'main')).toBe(true);
    expect(await git.isAncestor(dir, mB.mergeSha, 'main')).toBe(true);
    expect(await git.findMergeCommit(dir, 'main', mB.mergeSha, rR.taskSha)).toBe(rR.mergeSha);
  });

  it('되돌리기 충돌: 중단하고 충돌 파일을 알려주며 작업 폴더는 깨끗하다', async () => {
    const { dir } = await newRepo('되돌리기 충돌', { 'f.txt': 'x\n', 'g.txt': 'g\n' });
    const wts = fresh('worktrees');
    const wtA = path.join(wts, 'T-0001');
    await git.addWorktree(dir, { path: wtA, branch: 'task/T-0001', base: 'main' });
    await commitFiles(wtA, { 'f.txt': 'A\n', 'a-new.txt': 'new\n' }, '[T-0001] A');
    const mA = await landTask(dir, wtA, 'T-0001');
    const wtB = path.join(wts, 'T-0002');
    await git.addWorktree(dir, { path: wtB, branch: 'task/T-0002', base: 'main' });
    await commitFiles(wtB, { 'f.txt': 'B\n' }, '[T-0002] B');
    await landTask(dir, wtB, 'T-0002');

    const wtR = path.join(wts, 'T-0003');
    const { headSha } = await git.addWorktree(dir, { path: wtR, branch: 'task/T-0003', base: 'main' });
    const rv = await git.revertMerge(wtR, mA.mergeSha, '[T-0003] T-0001 되돌리기', DEV);
    expect(rv).toMatchObject({ ok: false, conflicts: ['f.txt'] });
    expect((await git.status(wtR)).clean).toBe(true);
    expect(await git.revParse(wtR, 'REVERT_HEAD')).toBeNull();
    expect(await git.revParse(wtR, 'HEAD')).toBe(headSha);
    expect(read(wtR, 'f.txt')).toBe('B\n');
    expect(read(wtR, 'a-new.txt')).toBe('new\n');

    // 병합 커밋이 아니면 오류
    await expect(git.revertMerge(wtR, `${mA.mergeSha}^2`, '[T-0003] 잘못된 대상', DEV)).rejects.toThrow(/병합 커밋이 아닙니다/);
  });
});

describe('archiveBranch · deleteBranch', () => {
  it('브랜치 끝을 refs/wook/archive에 보관하고 브랜치를 지운다', async () => {
    const { dir } = await newRepo('보관');
    const wt = path.join(fresh('worktrees'), 'T-0001');
    await git.addWorktree(dir, { path: wt, branch: 'task/T-0001-작업', base: 'main' });
    const tip = await commitFiles(wt, { 'w.txt': '중간 결과\n' }, '[T-0001] 중간');

    expect(await git.archiveBranch(dir, 'task/T-0001-작업', 'T-0001-cancel')).toBe(tip);
    expect(await git.revParse(dir, 'refs/wook/archive/T-0001-cancel')).toBe(tip);
    expect(await git.archiveBranch(dir, 'task/T-0001-작업', 'T-0001-cancel')).toBe(tip);
    expect(await git.archiveBranch(dir, 'task/없음', 'T-0009-cancel')).toBeNull();
    await expect(git.archiveBranch(dir, 'main', 'T-0001-cancel')).rejects.toThrow(/이미 다른 커밋/);
    await expect(git.archiveBranch(dir, 'main', 'bad..name')).rejects.toBeInstanceOf(GitError);

    // 작업 폴더가 브랜치를 쓰고 있으면 지우지 않는다
    await expect(git.deleteBranch(dir, 'task/T-0001-작업')).rejects.toThrow(/작업 폴더/);
    await git.removeWorktree(dir, wt);
    await git.deleteBranch(dir, 'task/T-0001-작업');
    expect(await git.revParse(dir, 'refs/heads/task/T-0001-작업')).toBeNull();
    await git.deleteBranch(dir, 'task/T-0001-작업');
    expect(await git.revParse(dir, 'refs/wook/archive/T-0001-cancel')).toBe(tip);
  });

  it('폴더가 지워진 작업 폴더 기록이 잡고 있어도 브랜치를 지운다', async () => {
    const { dir } = await newRepo('지워진 폴더의 브랜치');
    const wt = path.join(fresh('worktrees'), 'T-0002');
    await git.addWorktree(dir, { path: wt, branch: 'task/T-0002', base: 'main' });
    await rm(wt, { recursive: true, force: true });
    await git.deleteBranch(dir, 'task/T-0002');
    expect(await git.revParse(dir, 'refs/heads/task/T-0002')).toBeNull();
  });
});

describe('diffStat · diffPatch · workingDiff · log', () => {
  it('커밋 사이 diff: 추가·수정·삭제·이름 바뀜·바이너리', async () => {
    const lines = Array.from({ length: 20 }, (_, i) => `줄 ${i + 1} 내용은 이름이 바뀌어도 같습니다`).join('\n') + '\n';
    const { dir, headSha: c1 } = await newRepo('커밋 diff', {
      'keep.txt': 'k\n',
      'gone.txt': 'g\n',
      '원본 이름.txt': lines,
    });
    write(dir, 'bin.dat', Buffer.from([0, 1, 2, 3]));
    const c2 = await git.commitAll(dir, 'bin', DEV);
    write(dir, 'keep.txt', 'k\nk2\n');
    unlinkSync(path.join(dir, 'gone.txt'));
    renameSync(path.join(dir, '원본 이름.txt'), path.join(dir, '새 이름.txt'));
    write(dir, 'new.txt', 'n\n');
    write(dir, 'bin.dat', Buffer.from([0, 1, 2, 4]));
    const c3 = await git.commitAll(dir, 'change', DEV);

    const stats = await git.diffStat(dir, c2!, c3!);
    expect([...stats].sort((a, b) => a.path.localeCompare(b.path))).toEqual(
      [
        { path: 'bin.dat', status: 'M', additions: 0, deletions: 0 },
        { path: 'gone.txt', status: 'D', additions: 0, deletions: 1 },
        { path: 'keep.txt', status: 'M', additions: 1, deletions: 0 },
        { path: 'new.txt', status: 'A', additions: 1, deletions: 0 },
        { path: '새 이름.txt', status: 'R', additions: 0, deletions: 0 },
      ].sort((a, b) => a.path.localeCompare(b.path)),
    );
    expect((await git.diffStat(dir, c1, c2!)).map((s) => s.status)).toEqual(['A']);

    const full = await git.diffPatch(dir, c2!, c3!, 1_000_000);
    expect(full.truncated).toBe(false);
    expect(full.patch).toContain('diff --git a/keep.txt b/keep.txt');
    expect(full.patch).toContain('+k2');
    expect(full.patch).toContain('rename to 새 이름.txt');
    const cut = await git.diffPatch(dir, c2!, c3!, 120);
    expect(cut.truncated).toBe(true);
    expect(Buffer.byteLength(cut.patch)).toBeLessThanOrEqual(120);
    expect(cut.patch.endsWith('\n')).toBe(true);
    expect(full.patch.startsWith(cut.patch)).toBe(true);
    await expect(git.diffStat(dir, c2!, '없는-ref')).rejects.toBeInstanceOf(GitError);
  });

  it('mergeBase: 작업 브랜치가 갈라진 지점 — 그 뒤 main이 움직여도 그대로이고, 공통 이력이 없으면 null', async () => {
    const { dir, headSha: base0 } = await newRepo('갈라진 지점', { 'a.txt': 'a\n' });
    const wt = path.join(fresh('worktrees'), 'T-0001');
    await git.addWorktree(dir, { path: wt, branch: 'task/T-0001', base: 'main' });
    const moved = await commitFiles(dir, { 'other.txt': '다른 작업\n' }, 'main 진행');
    // 작업 커밋이 없으면 갈라진 지점은 작업 HEAD 자신 — 두 점 비교에만 보이는 main 쪽 변경은 이 작업의 변경이 아니다
    expect(await git.mergeBase(wt, moved, 'HEAD')).toBe(base0);
    expect(await git.diffStat(wt, base0, 'HEAD')).toEqual([]);
    expect((await git.diffStat(wt, moved, 'HEAD')).map((f) => f.path)).toEqual(['other.txt']);
    const own = await commitFiles(wt, { 'a.txt': 'a2\n' }, '[T-0001] 작업');
    expect(await git.mergeBase(wt, moved, own)).toBe(base0);
    expect((await git.diffStat(wt, base0, own)).map((f) => f.path)).toEqual(['a.txt']);
    sh(dir, 'checkout', '-q', '--orphan', 'lonely');
    sh(dir, 'commit', '-q', '-m', '공통 이력 없음');
    expect(await git.mergeBase(dir, sh(dir, 'rev-parse', 'HEAD'), moved)).toBeNull();
    await expect(git.mergeBase(dir, 'HEAD', '없는-ref')).rejects.toBeInstanceOf(GitError);
  });

  it('workingDiff: 커밋 안 된 변경 + 미추적 파일, 인덱스는 건드리지 않는다', async () => {
    const { dir } = await newRepo('작업 diff', { 'tracked.txt': 'one\n', 'same.txt': 'same\n' });
    write(dir, 'tracked.txt', 'one\ntwo\n');
    write(dir, 'same.txt', 'same\n'); // 내용은 같고 파일 시각만 바뀜 → git diff가 인덱스를 다시 쓰려는 경우
    write(dir, '새 폴더/새 파일.txt', '첫 줄\n둘째 줄');
    write(dir, 'bin.dat', Buffer.from([0, 1, 2, 3]));
    write(dir, 'big.log', Buffer.alloc(1024 * 1024 + 10, 0x61));
    const indexFile = path.join(dir, '.git', 'index');
    const indexBefore = readFileSync(indexFile);

    const wd = await git.workingDiff(dir, 'main', 1_000_000);
    expect(wd.truncated).toBe(false);
    expect(wd.files).toHaveLength(4);
    expect(wd.files).toEqual(
      expect.arrayContaining([
        { path: 'tracked.txt', status: 'M', additions: 1, deletions: 0 },
        { path: '새 폴더/새 파일.txt', status: '?', additions: 2, deletions: 0 },
        { path: 'bin.dat', status: '?', additions: 0, deletions: 0 },
        { path: 'big.log', status: '?', additions: 0, deletions: 0 },
      ]),
    );
    expect(wd.patch).toContain('+two');
    expect(wd.patch).toContain('+++ b/새 폴더/새 파일.txt');
    expect(wd.patch).toContain('+첫 줄\n+둘째 줄\n\\ No newline at end of file');
    expect(wd.patch).toContain('Binary files /dev/null and b/bin.dat differ');
    expect(wd.patch).toContain('Binary files /dev/null and b/big.log differ');
    expect(wd.patch).not.toContain('aaaaaaaa');

    expect(readFileSync(indexFile).equals(indexBefore)).toBe(true);
    expect(sh(dir, 'diff', '--cached', '--name-only')).toBe('');
    expect((await git.status(dir)).untracked.sort()).toEqual(['big.log', 'bin.dat', '새 폴더/새 파일.txt'].sort());

    const small = await git.workingDiff(dir, 'main', 200);
    expect(small.truncated).toBe(true);
    expect(Buffer.byteLength(small.patch)).toBeLessThanOrEqual(200);
    expect(small.files).toHaveLength(4);
  });

  it('log: 제목·본문·부모', async () => {
    const { dir, headSha: c1 } = await newRepo('기록');
    write(dir, 'x.txt', 'x\n');
    const c2 = await git.commitAll(dir, '[T-0001] 제목\n\n본문 1줄\n본문 2줄', DEV);
    const log = await git.log(dir, 'main', 10);
    expect(log).toHaveLength(2);
    expect(log[0]).toEqual({ sha: c2, parents: [c1], subject: '[T-0001] 제목', body: '본문 1줄\n본문 2줄' });
    expect(log[1]).toMatchObject({ sha: c1, parents: [], subject: '욱채 프로젝트 등록 (첫 커밋)', body: '' });
    expect(await git.log(dir, 'main', 1)).toHaveLength(1);
    expect(await git.log(dir, 'main', 0)).toEqual([]);
  });
});

describe('push', () => {
  it('원격 저장소에 브랜치를 올리고, 실패는 ok=false로 돌려준다', async () => {
    const { dir } = await newRepo('올리기');
    const remote = path.join(fresh('원격'), 'remote.git');
    mkdirSync(remote);
    sh(remote, 'init', '-q', '--bare');
    sh(dir, 'remote', 'add', 'origin', remote);
    const sha = await commitFiles(dir, { 'p.txt': 'p\n' }, '올릴 커밋');
    const r = await git.push(dir, 'origin', 'main');
    expect(r.ok).toBe(true);
    expect(sh(remote, 'rev-parse', 'refs/heads/main')).toBe(sha);
    const bad = await git.push(dir, '없는원격', 'main');
    expect(bad.ok).toBe(false);
    expect(bad.output.length).toBeGreaterThan(0);
  });
});

describe('잠금 경합 · 환경 · 중단 복구', () => {
  it('다른 git이 잠금 파일을 잡고 있으면 잠깐 기다렸다 다시 하고, 계속 잡혀 있으면 한국어 오류', async () => {
    const { dir } = await newRepo('잠금 경합');
    const lock = path.join(dir, '.git', 'index.lock');
    writeFileSync(lock, '');
    const release = setTimeout(() => unlinkSync(lock), 300);
    write(dir, 'a.txt', 'a\n');
    try {
      expect(await git.commitAll(dir, '[T-0001] 잠금 뒤 커밋', DEV)).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      clearTimeout(release);
      if (existsSync(lock)) unlinkSync(lock);
    }

    // 계속 잡혀 있는 잠금: 프로젝트 폴더 동기화는 던지지 않고 ok=false
    const wt = path.join(fresh('worktrees'), 'T-0002');
    await git.addWorktree(dir, { path: wt, branch: 'task/T-0002', base: 'main' });
    const task = await commitFiles(wt, { 'b.txt': 'b\n' }, '[T-0002] b');
    const pre = (await git.revParse(dir, 'main'))!;
    const r = await git.mergeIntoBase(dir, { baseBranch: 'main', taskSha: task, expectedBaseSha: pre, message: '[T-0002] 병합', identity: WOOK });
    if (!r.ok) throw new Error(r.detail);
    writeFileSync(lock, '');
    try {
      const s = await git.syncCheckedOutBase(dir, 'main', pre, r.mergeSha);
      expect(s.ok).toBe(false);
      expect(s.detail).toMatch(/index\.lock/);
      write(dir, 'c.txt', 'c\n');
      await expect(git.commitAll(dir, '[T-0002] 잠긴 커밋', DEV)).rejects.toThrow(/잠금 파일/);
    } finally {
      unlinkSync(lock);
    }
    expect((await git.syncCheckedOutBase(dir, 'main', pre, r.mergeSha)).ok).toBe(true);
    expect(read(dir, 'b.txt')).toBe('b\n');
  }, 30_000);

  it('상속된 GIT_DIR·GIT_INDEX_FILE 같은 환경 변수에 끌려가지 않는다', async () => {
    const { dir, headSha } = await newRepo('환경 변수');
    const saved = { GIT_DIR: process.env.GIT_DIR, GIT_INDEX_FILE: process.env.GIT_INDEX_FILE };
    process.env.GIT_DIR = path.join(root, '엉뚱한 곳');
    process.env.GIT_INDEX_FILE = path.join(root, '엉뚱한 인덱스');
    try {
      expect(await git.revParse(dir, 'HEAD')).toBe(headSha);
      expect((await git.status(dir)).clean).toBe(true);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it('작업 폴더(worktree)에서도 workingDiff가 인덱스를 건드리지 않는다', async () => {
    const { dir } = await newRepo('worktree diff', { 'a.txt': 'a\n' });
    const wt = path.join(fresh('worktrees'), 'T-0001');
    await git.addWorktree(dir, { path: wt, branch: 'task/T-0001', base: 'main' });
    write(wt, 'a.txt', 'a\nb\n');
    write(wt, '새 파일.md', '# 새\n');
    const indexFile = sh(wt, 'rev-parse', '--path-format=absolute', '--git-path', 'index');
    const before = readFileSync(indexFile);
    const wd = await git.workingDiff(wt, 'main', 100_000);
    expect(wd.files.map((f) => `${f.status} ${f.path}`).sort()).toEqual(['? 새 파일.md', 'M a.txt']);
    expect(wd.patch).toContain('+++ b/새 파일.md');
    expect(readFileSync(indexFile).equals(before)).toBe(true);
  });

  it('앱이 꺼져 남은 되돌리기 진행 상태를 정리하고 다시 되돌린다', async () => {
    const { dir } = await newRepo('되돌리기 재시도', { 'a.txt': 'a0\n' });
    const wts = fresh('worktrees');
    const wtA = path.join(wts, 'T-0001');
    await git.addWorktree(dir, { path: wtA, branch: 'task/T-0001', base: 'main' });
    await commitFiles(wtA, { 'a.txt': 'a1\n' }, '[T-0001] A');
    const mA = await landTask(dir, wtA, 'T-0001');
    const wtR = path.join(wts, 'T-0002');
    await git.addWorktree(dir, { path: wtR, branch: 'task/T-0002', base: 'main' });
    // 커밋 직전에 멈춘 상태를 흉내낸다
    sh(wtR, 'revert', '--no-commit', '-m', '1', mA.mergeSha);
    expect(await git.revParse(wtR, 'REVERT_HEAD')).toBe(mA.mergeSha);
    const rv = await git.revertMerge(wtR, mA.mergeSha, '[T-0002] T-0001 되돌리기', DEV);
    expect(rv.ok).toBe(true);
    expect(read(wtR, 'a.txt')).toBe('a0\n');
    expect(await git.revParse(wtR, 'REVERT_HEAD')).toBeNull();
    // 이미 되돌린 병합을 또 되돌리려 하면 변경 없음으로 알려준다
    const again = await git.revertMerge(wtR, mA.mergeSha, '[T-0002] 다시', DEV);
    expect(again).toMatchObject({ ok: false, conflicts: [] });
    expect((await git.status(wtR)).clean).toBe(true);
  });
});

describe('오류 · 명령 기록', () => {
  it('GitError에 인자·종료 코드·stderr가 담기고 메시지는 한국어', async () => {
    const { dir } = await newRepo('오류');
    const err = await git.diffStat(dir, 'HEAD', '없는-ref').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitError);
    const ge = err as GitError;
    expect(ge.args[0]).toBe('diff');
    expect(ge.code).toBe(128);
    expect(ge.stderr).toMatch(/없는-ref/);
    expect(ge.message).toMatch(/실패/);
    await expect(git.status(path.join(dir, '없는 폴더'))).rejects.toThrow(/폴더가 없습니다/);
    await expect(git.revParse(dir, '--all')).rejects.toBeInstanceOf(GitError);
    expect(await git.revParse(dir, 'refs/heads/없음')).toBeNull();
  });

  it('onCommand는 공통 -c 설정을 뺀 하위 명령 인자를 받는다', async () => {
    const dir = fresh('명령 기록');
    commands.length = 0;
    await git.isRepo(dir);
    const c = commands.find((x) => x.args[0] === 'rev-parse');
    expect(c).toBeDefined();
    expect(c!.cwd).toBe(dir);
    expect(c!.code).toBe(128);
    expect(c!.durationMs).toBeGreaterThanOrEqual(0);
    expect(commands.every((x) => x.args[0] !== '-c')).toBe(true);
  });
});
