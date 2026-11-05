/**
 * git 서비스 구현 (7장, ARCHITECTURE 10장). 계약: ./types.ts
 * - git은 셸 없이 인자 배열로 실행한다. 출력은 UTF-8로 읽고, 경로가 나오는 출력은 -z로 받는다.
 * - 프로그램이 만드는 커밋: --no-verify, 작성자 = 팀원, 커미터 = 욱채 <wook@wook.local>.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, rmdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  CommitInfo,
  ConflictCheck,
  DiffFileStat,
  GitIdentity,
  GitService,
  MergeIntoBaseResult,
  RevertResult,
  UpdateFromBaseResult,
  WorktreeStatus,
} from './types';
import {
  LOG_FORMAT,
  combineDiffStats,
  countLines,
  decodeTruncated,
  hasConflictMarkers,
  isValidRefName,
  looksBinary,
  newFilePatch,
  parseLogZ,
  parseNameStatusZ,
  parseNumstatZ,
  parseRawDiffZ,
  parseStatusZ,
  parseWorktreeList,
  type RawDiffEntry,
  type WorktreeEntry,
} from './parse';

export class GitError extends Error {
  constructor(
    message: string,
    public readonly args: string[],
    public readonly code: number | null,
    public readonly stderr: string,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

export interface GitCommandInfo {
  /** 하위 명령부터의 인자 (공통 -c 설정 제외) */
  args: string[];
  cwd: string;
  /** 종료 코드. 실행 실패·강제 종료면 null */
  code: number | null;
  durationMs: number;
}

export interface GitServiceOptions {
  gitPath?: string;
  onCommand?: (c: GitCommandInfo) => void;
}

const WOOK_COMMITTER: GitIdentity = { name: '욱채', email: 'wook@wook.local' };
const FIRST_COMMIT_MESSAGE = '욱채 프로젝트 등록 (첫 커밋)\n';

/** 모든 명령 공통 설정 (ARCHITECTURE 10장) */
const GLOBAL_CONFIG: readonly string[] = [
  '-c',
  'core.quotepath=false',
  '-c',
  'commit.gpgsign=false',
  '-c',
  'core.fsmonitor=false',
  // Windows: 앱 데이터 아래 작업 폴더는 경로가 길어 260자 제한에 걸리기 쉽다
  ...(process.platform === 'win32' ? ['-c', 'core.longpaths=true'] : []),
];

/** 걸린 git을 끊는 안전장치. 정상 작업을 끊지 않도록 넉넉히 */
const COMMAND_TIMEOUT_MS = 30 * 60_000;
const STDERR_MAX_BYTES = 256 * 1024;
/** 다른 git 프로세스(IDE·CLI의 git status 등)가 잠금 파일을 잡고 있을 때 다시 시도하는 간격 */
const LOCK_RETRY_DELAYS_MS = [200, 500, 1000, 2000];
/** 미추적 파일 내용을 diff에 넣는 상한 (넘으면 git처럼 바이너리로 표시) */
const UNTRACKED_MAX_FILE_BYTES = 1024 * 1024;
/** workingDiff가 미추적 파일 줄 수를 세려고 읽는 총량 상한 */
const UNTRACKED_READ_BUDGET_BYTES = 32 * 1024 * 1024;
/** 충돌 표시 검사로 읽는 파일 크기 상한 */
const MARKER_CHECK_MAX_BYTES = 32 * 1024 * 1024;

/** 상속 환경에서 지우는 변수: 저장소 위치를 바꾸거나 커밋 정보·동작을 바꾸는 것들 */
const DROP_ENV = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
  'GIT_CONFIG_PARAMETERS',
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_AUTHOR_DATE',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
  'GIT_COMMITTER_DATE',
  'GIT_REFLOG_ACTION',
  'GIT_TERMINAL_PROMPT',
  'GIT_OPTIONAL_LOCKS',
  'GIT_EDITOR',
  'GIT_SEQUENCE_EDITOR',
  'GIT_MERGE_AUTOEDIT',
  // 경로 해석 방식 (GIT_LITERAL_PATHSPECS와 함께 있으면 git이 오류를 낸다)
  'GIT_LITERAL_PATHSPECS',
  'GIT_GLOB_PATHSPECS',
  'GIT_NOGLOB_PATHSPECS',
  'GIT_ICASE_PATHSPECS',
  'LC_ALL',
]);

interface ExecOptions {
  /** 읽기 전용 명령: GIT_OPTIONAL_LOCKS=0 (인덱스 갱신 쓰기 안 함) */
  readOnly?: boolean;
  /** 표준 입력으로 넣고 닫을 내용 */
  input?: string;
  /** 커밋 작성자 (없으면 욱채) */
  author?: GitIdentity;
  /** 이 바이트를 넘으면 자르고 git을 끝낸다 */
  stdoutLimit?: number;
  timeoutMs?: number;
  /** 하위 명령 앞에 넣을 추가 -c 설정 */
  config?: readonly string[];
  /** 추가 환경 변수 */
  env?: Readonly<Record<string, string>>;
}

/** 경로 인자를 와일드카드로 해석하지 않게 (파일 이름에 * [ 가 있어도 그대로) */
const LITERAL_PATHSPECS = { GIT_LITERAL_PATHSPECS: '1' } as const;

interface CheckedOptions extends ExecOptions {
  /** 성공으로 볼 종료 코드 (기본 [0]) */
  ok?: readonly number[];
}

interface ExecResult {
  code: number | null;
  stdout: string;
  /** stdout에 실제로 담은 바이트 수 */
  stdoutBytes: number;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
}

type RepoProbe =
  | { kind: 'none' }
  | { kind: 'top' }
  | { kind: 'inside'; prefix: string }
  | { kind: 'no_worktree' };

// ───────────────────────── 작은 도우미 ─────────────────────────

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function errCode(e: unknown): string | undefined {
  return typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function short(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 8) : '없음';
}

function isLockContention(stderr: string): boolean {
  return /Unable to create '[^']*\.lock': File exists/i.test(stderr);
}

/** 사람이 읽을 오류 요약: hint·줄바꿈 경고를 빼고 앞 몇 줄만 */
function summarizeStderr(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('hint:') && !/^warning: in the working copy of /.test(l));
  const s = lines.slice(0, 4).join(' / ');
  return s.length > 600 ? `${s.slice(0, 600)}…` : s;
}

function failMessage(args: readonly string[], code: number | null, stderr: string): string {
  const what = `git ${args[0] ?? ''}`.trim();
  const detail = summarizeStderr(stderr);
  if (/detected dubious ownership/i.test(stderr)) {
    return `${what}: git이 이 폴더의 소유자를 신뢰하지 않아 실행을 거부했습니다. git 설정 safe.directory에 이 폴더를 추가해야 합니다 (${detail})`;
  }
  if (isLockContention(stderr)) {
    return `${what}: 다른 git 작업이 잠금 파일(.lock)을 쓰고 있어 실패했습니다. 다른 작업이 끝난 뒤에도 계속되면 남은 잠금 파일을 지워야 합니다 (${detail})`;
  }
  return `${what} 실패 (종료 코드 ${code ?? '없음'})${detail ? `: ${detail}` : ''}`;
}

function invalid(message: string): GitError {
  return new GitError(message, [], null, '');
}

/** 파일 작업 오류를 한국어 GitError로 (원래 오류 내용은 덧붙인다) */
async function fsStep<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw invalid(`${what} (${errText(e)})`);
  }
}

/** 리비전 인자: 옵션으로 해석되거나 줄이 깨지는 값을 막는다 (나머지는 git이 검사) */
function assertRev(value: string, what: string): void {
  if (typeof value !== 'string' || value.trim() === '' || value.startsWith('-') || /[\0\r\n]/.test(value)) {
    throw invalid(`${what} 값이 올바르지 않습니다: ${JSON.stringify(value)}`);
  }
}

function assertBranch(branch: string, what = '브랜치 이름'): void {
  if (typeof branch !== 'string' || branch.startsWith('-') || !isValidRefName(`refs/heads/${branch}`)) {
    throw invalid(`${what}이 올바르지 않습니다: ${JSON.stringify(branch)}`);
  }
}

function assertIdentity(identity: GitIdentity): void {
  const bad = (v: unknown) => typeof v !== 'string' || v.trim() === '' || /[<>\0\r\n]/.test(v);
  if (!identity || bad(identity.name) || bad(identity.email)) {
    throw invalid(`커밋 작성자 정보가 올바르지 않습니다: ${JSON.stringify(identity)}`);
  }
}

/** 커밋 메시지: 앞뒤 공백 제거, 줄바꿈 통일, 끝에 줄바꿈 하나 */
function normalizeMessage(message: string): string {
  const m = typeof message === 'string' ? message.replace(/\r\n?/g, '\n').trim() : '';
  if (!m) throw invalid('커밋 메시지가 비어 있습니다');
  return `${m}\n`;
}

function clampBytes(maxBytes: number): number {
  return Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : 0;
}

async function statOrNull(p: string) {
  try {
    return await stat(p);
  } catch (e) {
    if (errCode(e) === 'ENOENT' || errCode(e) === 'ENOTDIR') return null;
    throw e;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch (e) {
    if (errCode(e) === 'ENOENT' || errCode(e) === 'ENOTDIR') return false;
    throw e;
  }
}

/** 파일이 있거나 비어 있지 않은 폴더면 true (빈 폴더에는 git이 작업 폴더를 만들 수 있다) */
async function isOccupied(p: string): Promise<boolean> {
  let st;
  try {
    st = await lstat(p);
  } catch (e) {
    if (errCode(e) === 'ENOENT' || errCode(e) === 'ENOTDIR') return false;
    throw e;
  }
  if (!st.isDirectory()) return true;
  return (await readdir(p)).length > 0;
}

/**
 * 경로 비교용 정규화: 있는 가장 가까운 상위 폴더까지 실제 경로로 바꿔 8.3 짧은 이름·링크 차이를 없앤다.
 * Windows·macOS는 대소문자를 구분하지 않는다.
 */
function canonicalPath(p: string): string {
  const resolved = path.resolve(p);
  let head = resolved;
  const tail: string[] = [];
  for (;;) {
    try {
      head = realpathSync.native(head);
      break;
    } catch {
      // 없는 경로: 상위 폴더로 올라가며 실제 경로를 찾는다 (비교용이라 실패해도 원래 경로를 쓴다)
      const parent = path.dirname(head);
      if (parent === head) break;
      tail.unshift(path.basename(head));
      head = parent;
    }
  }
  // macOS는 파일 이름을 NFD로 줄 때가 있고 git은 NFC로 내보낸다
  const full = path.join(head, ...tail).normalize('NFC');
  return process.platform === 'win32' || process.platform === 'darwin' ? full.toLowerCase() : full;
}

function samePath(a: string, b: string): boolean {
  return canonicalPath(a) === canonicalPath(b);
}

/** 저장소별로 차례를 기다리는 작업 폴더 명령 (inWorktreeQueue) — 저장소 실제 경로 → 마지막 차례 */
const worktreeQueues = new Map<string, Promise<void>>();

/**
 * 같은 저장소의 작업 폴더 목록을 읽거나 바꾸는 명령(worktree add·list·remove·prune, branch -D)은 한 번에 하나씩 한다. git은 이 명령들에서
 * 다른 작업 폴더의 관리 폴더(.git/worktrees/<이름>)를 읽는데, 동시에 만들어지는 중인 작업 폴더의 commondir 파일이 아직 비어 있으면
 * 'fatal: failed to read .git/worktrees/T-0001/commondir'로 128 종료한다 — 한 번에 작업 여러 개를 활성화하면(스케줄러 tick 하나) 그중 하나가
 * '작업 공간 생성 실패'로 보류됐다. 앞 차례가 실패해도 다음 차례는 돈다. 이 서비스 밖의 git(대표가 직접 쓰는 git)까지 막지는 못한다
 */
function inWorktreeQueue<T>(repoDir: string, fn: () => Promise<T>): Promise<T> {
  const key = canonicalPath(repoDir);
  const prev = worktreeQueues.get(key) ?? Promise.resolve();
  const run = prev.then(fn);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  worktreeQueues.set(key, tail);
  void tail.then(() => {
    if (worktreeQueues.get(key) === tail) worktreeQueues.delete(key);
  });
  return run;
}

/** 작업 폴더 목록을 읽거나 바꾸는 공개 명령을 저장소별 차례로 돌린다 (inWorktreeQueue). 이 명령들은 서로를 부르지 않는다 (차례가 꼬이지 않게) */
function withWorktreeQueue(s: GitService): GitService {
  return {
    ...s,
    addWorktree: (repoDir, o) => inWorktreeQueue(repoDir, () => s.addWorktree(repoDir, o)),
    addDetachedWorktree: (repoDir, o) => inWorktreeQueue(repoDir, () => s.addDetachedWorktree(repoDir, o)),
    removeWorktree: (repoDir, p) => inWorktreeQueue(repoDir, () => s.removeWorktree(repoDir, p)),
    deleteBranch: (repoDir, b) => inWorktreeQueue(repoDir, () => s.deleteBranch(repoDir, b)),
  };
}

function buildEnv(o: ExecOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const win = process.platform === 'win32';
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    const key = win ? k.toUpperCase() : k;
    if (DROP_ENV.has(key) || key.startsWith('GITHEAD_')) continue;
    env[k] = v;
  }
  env.GIT_TERMINAL_PROMPT = '0';
  env.LC_ALL = 'C';
  // ':'는 git이 편집기를 띄우지 않는 특별 값 — 편집기 대기로 멈추지 않게
  env.GIT_EDITOR = ':';
  env.GIT_SEQUENCE_EDITOR = ':';
  env.GIT_MERGE_AUTOEDIT = 'no';
  if (o.readOnly) {
    env.GIT_OPTIONAL_LOCKS = '0';
  } else {
    // reflog 기록에도 커미터 정보가 쓰인다
    const author = o.author ?? WOOK_COMMITTER;
    env.GIT_AUTHOR_NAME = author.name;
    env.GIT_AUTHOR_EMAIL = author.email;
    env.GIT_COMMITTER_NAME = WOOK_COMMITTER.name;
    env.GIT_COMMITTER_EMAIL = WOOK_COMMITTER.email;
  }
  if (o.env) Object.assign(env, o.env);
  return env;
}

/** 저장소 기준 상대 경로 (/ 구분). 폴더 밖이면 오류 */
function toRepoRelative(dir: string, p: string): string {
  if (typeof p !== 'string' || p.trim() === '' || /[\0\r\n]/.test(p)) {
    throw invalid(`경로가 올바르지 않습니다: ${JSON.stringify(p)}`);
  }
  const root = path.resolve(dir);
  const rel = path.relative(root, path.resolve(root, p));
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw invalid(`프로젝트 폴더 밖의 경로입니다: ${p}`);
  }
  return rel.split(path.sep).join('/');
}

// ───────────────────────── 서비스 ─────────────────────────

export function createGitService(opts: GitServiceOptions = {}): GitService {
  const gitPath = opts.gitPath ?? 'git';

  const report = (info: GitCommandInfo): void => {
    if (!opts.onCommand) return;
    try {
      opts.onCommand(info);
    } catch (e) {
      // 기록 콜백 오류로 git 작업을 실패시키지 않되, 숨기지도 않는다
      process.emitWarning(`git onCommand 콜백 오류: ${errText(e)}`, 'WookGitWarning');
    }
  };

  /** git 1회 실행. 실행 자체가 안 되면 GitError, 종료 코드는 호출자가 판단 */
  async function exec(cwd: string, args: string[], o: ExecOptions = {}): Promise<ExecResult> {
    // 없는 cwd로 spawn하면 'spawn git ENOENT'(git이 없다는 뜻처럼 보임)가 나므로 먼저 확인한다
    let st;
    try {
      st = await statOrNull(cwd);
    } catch (e) {
      throw new GitError(`폴더를 확인하지 못했습니다: ${cwd} (${errText(e)})`, args, null, '');
    }
    if (!st) throw new GitError(`폴더가 없습니다: ${cwd}`, args, null, '');
    if (!st.isDirectory()) throw new GitError(`폴더가 아닙니다: ${cwd}`, args, null, '');

    const fullArgs = [...GLOBAL_CONFIG, ...(o.config ?? []), ...args];
    const env = buildEnv(o);
    const started = Date.now();

    return await new Promise<ExecResult>((resolve, reject) => {
      let settled = false;
      let timer: NodeJS.Timeout | null = null;
      const settle = (code: number | null, fn: () => void) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        report({ args: [...args], cwd, code, durationMs: Date.now() - started });
        fn();
      };

      let child: ChildProcess;
      try {
        child = spawn(gitPath, fullArgs, {
          cwd,
          env,
          windowsHide: true,
          stdio: [o.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        });
      } catch (e) {
        settle(null, () => reject(new GitError(`git을 실행하지 못했습니다 (${gitPath}): ${errText(e)}`, args, null, '')));
        return;
      }

      const out: Buffer[] = [];
      let outLen = 0;
      let truncated = false;
      const err: Buffer[] = [];
      let errLen = 0;
      let timedOut = false;

      child.stdout?.on('data', (chunk: Buffer) => {
        if (truncated) return;
        const limit = o.stdoutLimit;
        if (limit !== undefined && outLen + chunk.length > limit) {
          if (limit > outLen) out.push(chunk.subarray(0, limit - outLen));
          outLen = limit;
          truncated = true;
          child.kill();
          return;
        }
        out.push(chunk);
        outLen += chunk.length;
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        if (errLen >= STDERR_MAX_BYTES) return;
        err.push(chunk);
        errLen += chunk.length;
      });
      child.on('error', (e) => {
        // pid가 없으면 실행 자체가 실패 (ENOENT 등). 실행 뒤의 오류(kill 실패 등)는 close에서 마무리된다
        if (child.pid === undefined) {
          settle(null, () =>
            reject(new GitError(`git을 실행하지 못했습니다 (${gitPath}): ${errText(e)}`, args, null, '')),
          );
        }
      });
      if (o.input !== undefined && child.stdin) {
        // git이 입력을 다 읽기 전에 끝나면 EPIPE가 난다 — 결과는 종료 코드로 판단하므로 여기서는 기록만
        child.stdin.on('error', (e) => {
          err.push(Buffer.from(`\n(표준 입력 쓰기 오류: ${errText(e)})`, 'utf8'));
        });
        child.stdin.end(o.input, 'utf8');
      }
      timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, o.timeoutMs ?? COMMAND_TIMEOUT_MS);

      child.on('close', (code) => {
        const stderr = Buffer.concat(err).toString('utf8');
        if (child.pid === undefined) {
          settle(null, () => reject(new GitError(`git을 실행하지 못했습니다 (${gitPath})`, args, null, stderr)));
          return;
        }
        const buf = Buffer.concat(out);
        let stdout: string;
        let stdoutBytes: number;
        if (truncated) {
          const d = decodeTruncated(buf);
          stdout = d.text;
          stdoutBytes = d.bytes;
        } else {
          stdout = buf.toString('utf8');
          stdoutBytes = buf.length;
        }
        settle(code, () => resolve({ code, stdout, stdoutBytes, stderr, truncated, timedOut }));
      });
    });
  }

  /** 종료 코드를 확인하는 실행. 잠금 경합이면 잠깐 기다렸다 다시 */
  async function git(cwd: string, args: string[], o: CheckedOptions = {}): Promise<ExecResult> {
    const okCodes = o.ok ?? [0];
    for (let attempt = 0; ; attempt++) {
      const r = await exec(cwd, args, o);
      if (r.timedOut) {
        throw new GitError(
          `git ${args[0]} 명령이 제한 시간(${Math.round((o.timeoutMs ?? COMMAND_TIMEOUT_MS) / 1000)}초)을 넘겨 중단했습니다`,
          args,
          r.code,
          r.stderr,
        );
      }
      if (r.truncated || (r.code !== null && okCodes.includes(r.code))) return r;
      if (!o.readOnly && isLockContention(r.stderr) && attempt < LOCK_RETRY_DELAYS_MS.length) {
        await delay(LOCK_RETRY_DELAYS_MS[attempt]);
        continue;
      }
      throw new GitError(failMessage(args, r.code, r.stderr), args, r.code, r.stderr);
    }
  }

  const read = (cwd: string, args: string[], o: CheckedOptions = {}) => git(cwd, args, { ...o, readOnly: true });

  // ── 조회 도우미 ──

  async function resolveCommit(dir: string, rev: string): Promise<string | null> {
    assertRev(rev, '리비전');
    const r = await read(dir, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], { ok: [0, 1] });
    if (r.code !== 0) return null;
    const sha = r.stdout.trim();
    return sha || null;
  }

  async function refExists(dir: string, ref: string): Promise<boolean> {
    const r = await read(dir, ['rev-parse', '--verify', '--quiet', ref], { ok: [0, 1] });
    return r.code === 0;
  }

  const mergeInProgress = (dir: string) => refExists(dir, 'MERGE_HEAD');
  const revertInProgress = (dir: string) => refExists(dir, 'REVERT_HEAD');

  /** HEAD가 가리키는 전체 ref 이름 (refs/heads/...). 분리 HEAD면 null */
  async function symbolicHead(dir: string): Promise<string | null> {
    const r = await read(dir, ['symbolic-ref', '--quiet', 'HEAD'], { ok: [0, 1] });
    if (r.code !== 0) return null;
    return r.stdout.trim() || null;
  }

  /** 충돌 미해결 파일. git diff --diff-filter=U 와 같은 목록이지만 인덱스를 다시 쓰지 않는 ls-files -u 로 */
  async function unmergedFiles(dir: string): Promise<string[]> {
    const r = await read(dir, ['ls-files', '-u', '-z']);
    const paths: string[] = [];
    for (const rec of r.stdout.split('\0')) {
      const tab = rec.indexOf('\t');
      if (tab >= 0) paths.push(rec.slice(tab + 1));
    }
    return [...new Set(paths)];
  }

  /**
   * 충돌 파일을 내용으로 본다 (GIT-07). 팀원은 git 없이 파일만 고치므로 해결 여부는 인덱스가 아니라 작업 폴더 내용이다.
   * 단계(ls-files -u): 1=공통 조상, 2=이쪽(ours), 3=저쪽(theirs). 두 쪽이 다 있는 텍스트 파일만 git이 충돌 표시를 남긴다 —
   * 한쪽이 지운 파일(수정/삭제 충돌)·바이너리·큰 파일·일반 파일이 아닌 것은 표시가 없어 내용으로 확인할 수 없다.
   * 작업 폴더에서 지운 파일은 지우기로 해결한 것이다 (스테이징하면 지워진다).
   * recorded(기록된 충돌 파일) 중 인덱스에서 이미 충돌이 풀린 파일 — 팀원이 규칙을 어기고 직접 스테이징하거나 병합을 커밋한 파일 — 도
   * 같은 기준으로 내용을 본다: 표시가 남았으면 미해결, 텍스트가 아니면 확인 불가 (GIT-07)
   */
  async function scanConflicts(dir: string, recorded: readonly string[] = []): Promise<ConflictCheck> {
    const r = await read(dir, ['ls-files', '-u', '-z']);
    const stages = new Map<string, Set<string>>();
    for (const rec of r.stdout.split('\0')) {
      const tab = rec.indexOf('\t');
      if (tab < 0) continue;
      const rel = rec.slice(tab + 1);
      const stage = rec.slice(0, tab).split(' ')[2] ?? '';
      const s = stages.get(rel) ?? new Set<string>();
      s.add(stage);
      stages.set(rel, s);
    }
    const withMarkers: string[] = [];
    const unverifiable: string[] = [];
    /** bothSides: 두 쪽 내용이 다 있는 충돌(표시를 남기는 충돌)인지 — 인덱스에서 풀린 파일은 알 수 없어 내용만 본다 */
    const check = async (rel: string, bothSides: boolean): Promise<void> => {
      const abs = path.join(dir, rel);
      const inside = path.relative(dir, abs);
      if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) return;
      const st = await fsStep(`충돌 파일을 확인하지 못했습니다: ${rel}`, () => statOrNull(abs));
      if (!st) return;
      if (!bothSides || !st.isFile() || st.size > MARKER_CHECK_MAX_BYTES) {
        unverifiable.push(rel);
        return;
      }
      const buf = await fsStep(`충돌 파일을 읽지 못했습니다: ${rel}`, () => readFile(abs));
      if (looksBinary(buf)) unverifiable.push(rel);
      else if (hasConflictMarkers(buf.toString('utf8'))) withMarkers.push(rel);
    };
    for (const [rel, s] of stages) await check(rel, s.has('2') && s.has('3'));
    for (const rel of new Set(recorded)) if (!stages.has(rel)) await check(rel, true);
    return { unmerged: [...stages.keys()], withMarkers, unverifiable };
  }

  /**
   * 인덱스 사본으로 실행: 작업 트리와 비교하는 git diff는 GIT_OPTIONAL_LOCKS=0이어도 인덱스 파일 정보를
   * 다시 쓰므로, 진짜 인덱스를 건드리지 않고 잠금 경합도 만들지 않게 사본을 쓴다
   */
  async function withIndexCopy<T>(dir: string, fn: (env: Record<string, string>) => Promise<T>): Promise<T> {
    const indexPath = path.resolve(dir, (await read(dir, ['rev-parse', '--git-path', 'index'])).stdout.trim());
    const tmp = await fsStep('임시 폴더를 만들지 못했습니다', () => mkdtemp(path.join(tmpdir(), 'wook-git-index-')));
    try {
      const copy = path.join(tmp, 'index');
      try {
        await copyFile(indexPath, copy);
      } catch (e) {
        // 인덱스가 아직 없는 저장소면 빈 인덱스로 (git이 새로 만든다)
        if (errCode(e) !== 'ENOENT') throw invalid(`git 인덱스를 복사하지 못했습니다: ${indexPath} (${errText(e)})`);
      }
      return await fn({ GIT_INDEX_FILE: copy });
    } finally {
      await rm(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  }

  async function trackedChanges(dir: string): Promise<boolean> {
    const r = await read(dir, ['status', '--porcelain=v1', '-z', '--untracked-files=no']);
    return r.stdout.length > 0;
  }

  /** 두 블롭의 줄 단위 편집 거리(더한 줄 + 뺀 줄). 바이너리면 null. flags = 줄 비교 옵션 — 그 옵션으로 바뀐 줄이 없으면 git이 줄을 내지 않는다(0) */
  async function lineDistance(dir: string, a: string, b: string, flags: readonly string[] = []): Promise<number | null> {
    if (a === b) return 0;
    const r = await read(dir, ['diff', '--numstat', '-z', '--diff-algorithm=myers', '--no-ext-diff', '--no-textconv', ...flags, a, b]);
    if (!r.stdout) return 0;
    const m = /^(\d+)\t(\d+)\t/.exec(r.stdout);
    return m ? Number(m[1]) + Number(m[2]) : null;
  }

  /**
   * 병합이 바꾼 한 경로(m: 병합 전 → 병합 결과)의 인덱스 항목(i)이 둘 다 아닐 때(대표가 고친 내용), 그 병합의 변경이 들어 있는지 (GIT-15, AC-45):
   * 'in' = 병합 결과에 대표 변경이 더해짐(그대로 커밋해도 병합이 되돌려지지 않는다), 'missing' = 병합 전 내용에 대표 변경이 더해짐(그대로 커밋하면
   * 그 경로의 병합 변경이 되돌려진다), 'unknown' = 내용으로 가릴 수 없음(바이너리·일반 파일 아님·충돌 중, 대표 변경이 병합한 줄과 겹침).
   * 병합이 더한 경로는 대표 것, 대표가 지운 경로는 대표 결정으로 본다('in'). 내용은 줄 단위 편집 거리 d로 본다 — 병합 결과(new)가 병합 전(old)과
   * 인덱스(I) 사이에 있으면(d(old,I) = d(old,new) + d(new,I)) I는 병합 결과에서 병합한 줄을 하나도 되돌리지 않고 더 고친 것이고, old가 new와 I
   * 사이에 있으면 I는 병합 전 내용을 고친 것이다. 3-way 병합(merge-file)은 병합한 줄 바로 옆 줄을 고친 경우 충돌로 끝나 둘을 가리지 못한다.
   * 마지막 줄 끝에 줄바꿈이 없는 내용이 있으면 git은 그 줄과 줄바꿈이 붙은 같은 글의 줄을 다른 줄로 센다 — 그 뒤에 줄을 더하기만 해도 그 줄이
   * 바뀐 것으로 잡혀 위 두 식이 다 맞지 않거나, 병합이 더한 그 줄이 되돌려진 것으로 잡혀 'missing'이 된다. 그때는 줄바꿈을 붙인 것처럼
   * (--ignore-cr-at-eol: 줄 끝 줄바꿈 유무와 CR을 보지 않음) 한 번 더 잰다. 'missing'은 그렇게 재서 'in'일 때만 바꾸고, 그 밖에는 그대로 둔다.
   * 다 맞지 않던 것을 그렇게 재서 병합이 바꾼 줄이 없으면(줄 끝만 바꾼 병합) 가릴 수 없다('unknown')
   */
  async function mergeChangeIn(dir: string, m: RawDiffEntry, i: RawDiffEntry): Promise<'in' | 'missing' | 'unknown'> {
    const NONE = '000000';
    if (i.status === 'U') return 'unknown';
    if (m.srcMode === NONE || i.dstMode === NONE) return 'in';
    if (m.dstMode === NONE) return 'missing';
    if (![m.srcMode, m.dstMode, i.dstMode].every((x) => x === '100644' || x === '100755')) return 'unknown';
    // 병합이 바꾼 실행 권한이 병합 전 그대로면 그대로 커밋할 때 되돌려진다
    if (m.srcMode !== m.dstMode && i.dstMode === m.srcMode) return 'missing';
    if (m.srcSha === m.dstSha) return 'in';
    const judge = async (flags: readonly string[]): Promise<'in' | 'missing' | 'unknown' | null> => {
      const [on, ni, oi] = await Promise.all([lineDistance(dir, m.srcSha, m.dstSha, flags), lineDistance(dir, m.dstSha, i.dstSha, flags), lineDistance(dir, m.srcSha, i.dstSha, flags)]);
      if (on === null || ni === null || oi === null) return null;
      if (on > 0 && oi === on + ni) return 'in';
      if (on > 0 && ni === on + oi) return 'missing';
      return 'unknown';
    };
    const has = await judge([]);
    if (has === null || has === 'in') return has ?? 'unknown';
    const blobs = await Promise.all([m.srcSha, m.dstSha, i.dstSha].map((sha) => read(dir, ['cat-file', 'blob', sha])));
    if (!blobs.some((b) => b.stdout !== '' && !b.stdout.endsWith('\n'))) return has;
    const eol = (await judge(['--ignore-cr-at-eol'])) ?? 'unknown';
    return has === 'missing' && eol !== 'in' ? 'missing' : eol;
  }

  async function commitParents(dir: string, sha: string): Promise<string[]> {
    const r = await read(dir, ['rev-list', '--parents', '-n', '1', sha, '--']);
    return r.stdout.trim().split(/\s+/).slice(1);
  }

  async function isAncestor(dir: string, ancestor: string, descendant: string): Promise<boolean> {
    assertRev(ancestor, '조상 커밋');
    assertRev(descendant, '자손 커밋');
    const r = await read(dir, ['merge-base', '--is-ancestor', ancestor, descendant], { ok: [0, 1] });
    return r.code === 0;
  }

  async function probeRepo(dir: string): Promise<RepoProbe> {
    const args = ['rev-parse', '--is-inside-work-tree', '--is-bare-repository', '--show-prefix'];
    const r = await exec(dir, args, { readOnly: true });
    if (r.timedOut) throw new GitError('git rev-parse 명령이 제한 시간을 넘겨 중단했습니다', args, r.code, r.stderr);
    if (r.code !== 0) {
      if (/not a git repository/i.test(r.stderr)) return { kind: 'none' };
      throw new GitError(failMessage(args, r.code, r.stderr), args, r.code, r.stderr);
    }
    const [inside = '', , prefix = ''] = r.stdout.split(/\r?\n/);
    if (inside.trim() !== 'true') return { kind: 'no_worktree' };
    return prefix.trim() === '' ? { kind: 'top' } : { kind: 'inside', prefix: prefix.trim() };
  }

  async function listWorktrees(repoDir: string): Promise<WorktreeEntry[]> {
    const r = await read(repoDir, ['worktree', 'list', '--porcelain']);
    return parseWorktreeList(r.stdout);
  }

  /** 폴더가 사라진 작업 폴더 기록이면 true */
  async function isStale(w: WorktreeEntry): Promise<boolean> {
    return w.prunable || !(await exists(w.path));
  }

  async function headOf(dir: string): Promise<string> {
    const sha = await resolveCommit(dir, 'HEAD');
    if (!sha) throw new GitError(`HEAD 커밋이 없습니다: ${dir}`, ['rev-parse', 'HEAD'], null, '');
    return sha;
  }

  async function diffStatsOf(dir: string, revs: string[], env?: Record<string, string>): Promise<DiffFileStat[]> {
    const common = ['-z', '-M', '--no-color', '--no-ext-diff'];
    const [num, ns] = await Promise.all([
      read(dir, ['diff', '--numstat', ...common, ...revs, '--'], { env }),
      read(dir, ['diff', '--name-status', ...common, ...revs, '--'], { env }),
    ]);
    return combineDiffStats(parseNameStatusZ(ns.stdout), parseNumstatZ(num.stdout));
  }

  const patchArgs = (revs: string[]) => [
    'diff',
    '-M',
    '--no-color',
    '--no-ext-diff',
    '--src-prefix=a/',
    '--dst-prefix=b/',
    ...revs,
    '--',
  ];

  async function commitStaged(dir: string, message: string, identity: GitIdentity): Promise<void> {
    await git(dir, ['commit', '--no-verify', '--cleanup=whitespace', '-F', '-'], { input: message, author: identity });
  }

  // ── 서비스 메서드 ──

  const service: GitService = {
    async version() {
      let r: ExecResult;
      try {
        r = await exec(tmpdir(), ['--version'], { readOnly: true, timeoutMs: 30_000 });
      } catch (e) {
        if (e instanceof GitError) return null;
        throw e;
      }
      if (r.code !== 0) return null;
      const m = /git version (\S+)/.exec(r.stdout);
      return m ? m[1] : null;
    },

    async isRepo(dir) {
      const st = await statOrNull(dir);
      if (!st || !st.isDirectory()) return false;
      return (await probeRepo(dir)).kind === 'top';
    },

    async ignoredPaths(dir, paths) {
      if (paths.length === 0) return [];
      // check-ignore: 그 경로나 상위 폴더가 무시 규칙에 걸리는 것만(안에 든 파일이 모두 무시되는 폴더는 아니다), 추적하는 파일이 그 아래 있으면 빼고 (S10-D1).
      // './'를 붙여 ':'로 시작하는 이름도 pathspec 마법으로 읽지 않게 한다 — 출력도 받은 철자 그대로다
      const args = ['check-ignore', '-z', '--stdin'];
      const input = paths.map((p) => `./${p}\0`).join('');
      const list = (r: ExecResult) => r.stdout.split('\0').filter(Boolean).map((p) => p.replace(/^\.\//, ''));
      if ((await probeRepo(dir)).kind === 'top') return list(await read(dir, args, { input, ok: [0, 1] }));
      // 저장소 최상위가 아니면 ensureRepo가 dir에 git init을 한다 — 같은 전역 설정·템플릿의 빈 임시 저장소에 dir을 작업 트리로 붙여 본다
      const tmp = await fsStep('임시 폴더를 만들지 못했습니다', () => mkdtemp(path.join(tmpdir(), 'wook-git-ignore-')));
      try {
        await git(tmp, ['init', '-q']);
        return list(await read(dir, [`--git-dir=${path.join(tmp, '.git')}`, `--work-tree=${dir}`, ...args], { input, ok: [0, 1] }));
      } finally {
        await rm(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      }
    },

    async ensureRepo(dir, { init, identity }) {
      assertIdentity(identity);
      const st = await statOrNull(dir);
      if (!st) {
        if (!init) throw invalid(`폴더가 없습니다: ${dir}`);
        await fsStep(`폴더를 만들지 못했습니다: ${dir}`, () => mkdir(dir, { recursive: true }));
      } else if (!st.isDirectory()) {
        throw invalid(`폴더가 아닙니다: ${dir}`);
      }

      let initialized = false;
      const probe = await probeRepo(dir);
      if (probe.kind === 'no_worktree') {
        throw invalid(`작업 트리가 없는 git 저장소(bare)이거나 .git 폴더 안입니다: ${dir}`);
      }
      if (probe.kind === 'inside') {
        // 상위 저장소가 이 폴더의 파일을 관리하면 그 저장소의 일부다. 관리하지 않는 폴더(예: 홈 폴더 저장소 아래)는 따로 만든다
        const tracked = await read(dir, ['ls-files', '-z'], { stdoutLimit: 1 });
        if (tracked.truncated || tracked.stdout.length > 0) {
          const top = (await read(dir, ['rev-parse', '--show-toplevel'])).stdout.trim();
          throw invalid(
            `이 폴더는 다른 git 저장소(${top})가 관리하는 하위 폴더입니다. 저장소 최상위 폴더를 등록하세요: ${dir}`,
          );
        }
      }
      if (probe.kind === 'none' || probe.kind === 'inside') {
        if (!init) throw invalid(`git 저장소가 아닙니다: ${dir}`);
        await git(dir, ['init', '-b', 'main']);
        initialized = true;
      }

      if (!(await resolveCommit(dir, 'HEAD'))) {
        // worktree를 만들려면 커밋이 하나 있어야 한다 (GIT-01). 빈 폴더면 빈 커밋
        await git(dir, ['add', '-A']);
        await git(dir, ['commit', '--no-verify', '--allow-empty', '--cleanup=whitespace', '-F', '-'], {
          input: FIRST_COMMIT_MESSAGE,
          author: identity,
        });
      }

      const head = await symbolicHead(dir);
      let baseBranch: string;
      if (head && head.startsWith('refs/heads/')) {
        baseBranch = head.slice('refs/heads/'.length);
      } else if (await resolveCommit(dir, 'refs/heads/main')) {
        baseBranch = 'main';
      } else {
        throw invalid(
          `HEAD가 브랜치가 아닌 커밋을 가리키고(분리 HEAD) main 브랜치도 없어 기준 브랜치를 정할 수 없습니다. 프로젝트 폴더에서 기준 브랜치를 체크아웃하세요: ${dir}`,
        );
      }
      const headSha = await resolveCommit(dir, `refs/heads/${baseBranch}`);
      if (!headSha) throw invalid(`기준 브랜치 ${baseBranch}의 커밋을 찾지 못했습니다: ${dir}`);
      return { initialized, baseBranch, headSha };
    },

    async revParse(dir, ref) {
      return resolveCommit(dir, ref);
    },

    async currentBranch(dir) {
      const head = await symbolicHead(dir);
      if (!head) return null;
      return head.startsWith('refs/heads/') ? head.slice('refs/heads/'.length) : head;
    },

    async status(dir): Promise<WorktreeStatus> {
      const [r, merging] = await Promise.all([
        read(dir, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
        mergeInProgress(dir),
      ]);
      const p = parseStatusZ(r.stdout);
      return {
        clean: p.files.length === 0 && !merging,
        trackedDirty: p.files.some((f) => f.code !== '??'),
        files: p.files,
        untracked: p.untracked,
        unmerged: p.unmerged,
        mergeInProgress: merging,
      };
    },

    async addWorktree(repoDir, { path: wtPath, branch, base }) {
      assertBranch(branch);
      assertRev(base, '기준');
      const target = path.resolve(wtPath);
      const branchRef = `refs/heads/${branch}`;

      let list = await listWorktrees(repoDir);
      let atPath = list.find((w) => samePath(w.path, target));
      let byBranch = list.find((w) => w.branch === branchRef);
      if ((atPath && (await isStale(atPath))) || (byBranch && (await isStale(byBranch)))) {
        // 폴더가 지워진 기록이 경로·브랜치를 잡고 있으면 정리하고 다시 본다
        await git(repoDir, ['worktree', 'prune']);
        list = await listWorktrees(repoDir);
        atPath = list.find((w) => samePath(w.path, target));
        byBranch = list.find((w) => w.branch === branchRef);
      }

      if (atPath) {
        if (atPath.branch === branchRef) return { created: false, headSha: await headOf(target) };
        throw invalid(
          `이 경로에는 다른 ${atPath.branch ? `브랜치(${atPath.branch.replace(/^refs\/heads\//, '')})의` : '커밋의'} 작업 폴더가 이미 있습니다: ${target}`,
        );
      }
      if (byBranch) throw invalid(`브랜치 ${branch}는 이미 다른 작업 폴더에서 쓰고 있습니다: ${byBranch.path}`);
      // git은 경로 검사보다 브랜치 생성을 먼저 하므로, 실패할 경로면 미리 막아 빈 브랜치가 남지 않게 한다
      if (await isOccupied(target)) throw invalid(`경로가 이미 있고 작업 폴더가 아닙니다: ${target}`);

      if (await resolveCommit(repoDir, branchRef)) {
        await git(repoDir, ['worktree', 'add', target, branch]);
      } else {
        const baseSha = await resolveCommit(repoDir, base);
        if (!baseSha) throw invalid(`기준 커밋을 찾지 못했습니다: ${base}`);
        await git(repoDir, ['worktree', 'add', '--no-track', '-b', branch, target, baseSha]);
      }
      return { created: true, headSha: await headOf(target) };
    },

    async addDetachedWorktree(repoDir, { path: wtPath, commit }) {
      assertRev(commit, '커밋');
      const sha = await resolveCommit(repoDir, commit);
      if (!sha) throw invalid(`커밋을 찾지 못했습니다: ${commit}`);
      const target = path.resolve(wtPath);

      let atPath = (await listWorktrees(repoDir)).find((w) => samePath(w.path, target));
      if (atPath && (await isStale(atPath))) {
        await git(repoDir, ['worktree', 'prune']);
        atPath = (await listWorktrees(repoDir)).find((w) => samePath(w.path, target));
      }
      if (atPath) {
        if (atPath.detached && (await resolveCommit(target, 'HEAD')) === sha) return;
        throw invalid(`이 경로에는 다른 작업 폴더가 이미 있습니다: ${target}`);
      }
      if (await isOccupied(target)) throw invalid(`경로가 이미 있고 작업 폴더가 아닙니다: ${target}`);
      await git(repoDir, ['worktree', 'add', '--detach', target, sha]);
    },

    async removeWorktree(repoDir, wtPath) {
      const target = path.resolve(wtPath);
      const list = await listWorktrees(repoDir);
      const idx = list.findIndex((w) => samePath(w.path, target));
      const entry = idx >= 0 ? list[idx] : null;
      if (entry && idx === 0) throw invalid(`기본 작업 폴더(프로젝트 폴더)는 제거할 수 없습니다: ${target}`);
      if (entry && (await exists(target))) {
        await git(repoDir, ['worktree', 'remove', '--force', entry.path]);
      }
      await git(repoDir, ['worktree', 'prune']);
      if (await exists(target)) {
        if (!(await isOccupied(target))) {
          await fsStep(`빈 작업 폴더를 지우지 못했습니다: ${target}`, () => rmdir(target));
          return;
        }
        throw invalid(
          entry
            ? `작업 폴더를 다 지우지 못했습니다 (사용 중인 파일이 있을 수 있습니다): ${target}`
            : `작업 폴더가 아닌 폴더라 지우지 않았습니다: ${target}`,
        );
      }
    },

    async commitAll(dir, message, identity) {
      assertIdentity(identity);
      const msg = normalizeMessage(message);
      if (await mergeInProgress(dir)) {
        throw invalid(`병합이 진행 중이라 단계 커밋을 할 수 없습니다. 충돌 해결을 먼저 마쳐야 합니다: ${dir}`);
      }
      await git(dir, ['add', '-A']);
      const staged = await read(dir, ['diff', '--cached', '--quiet'], { ok: [0, 1] });
      if (staged.code === 0) return null;
      await commitStaged(dir, msg, identity);
      return headOf(dir);
    },

    async commitPaths(dir, paths, message, identity) {
      assertIdentity(identity);
      const msg = normalizeMessage(message);
      if (!Array.isArray(paths)) throw invalid('커밋할 파일 목록이 올바르지 않습니다');
      const wanted = paths.map((p) => toRepoRelative(dir, p));
      if (wanted.length === 0) return null;
      if (await mergeInProgress(dir)) {
        throw invalid(`병합이 진행 중이라 일부 파일만 커밋할 수 없습니다: ${dir}`);
      }

      // 대상: HEAD와 작업 트리 내용이 다른 추적 파일 + 새 파일 (폴더를 주면 그 아래 전부).
      // 무시(.gitignore)된 새 파일은 넣지 않는다
      const foldCase = process.platform === 'win32' || process.platform === 'darwin';
      const norm = (s: string) => (foldCase ? s.normalize('NFC').toLowerCase() : s.normalize('NFC'));
      const wantedNorm = wanted.map(norm);
      const matches = (p: string) => {
        const n = norm(p);
        return wantedNorm.some((w) => n === w || n.startsWith(`${w}/`));
      };
      const [changed, others, unmerged] = await Promise.all([
        read(dir, ['diff', 'HEAD', '--name-only', '-z', '--no-renames']),
        read(dir, ['ls-files', '--others', '--exclude-standard', '-z']),
        unmergedFiles(dir),
      ]);
      const conflicted = unmerged.filter(matches);
      if (conflicted.length > 0) throw invalid(`충돌이 해결되지 않은 파일은 커밋할 수 없습니다: ${conflicted.join(', ')}`);
      const trackedTargets = changed.stdout.split('\0').filter((p) => p && matches(p));
      const newFiles = others.stdout.split('\0').filter((p) => p && !p.endsWith('/') && matches(p));
      if (trackedTargets.length === 0 && newFiles.length === 0) return null;

      // 경로는 표준 입력(NUL 구분)으로 넘겨 명령줄 길이·특수 문자 문제를 피한다
      if (newFiles.length > 0) {
        await git(dir, ['add', '--pathspec-from-file=-', '--pathspec-file-nul'], {
          input: newFiles.join('\0'),
          env: LITERAL_PATHSPECS,
        });
      }
      // --only: 다른 파일의 스테이징은 그대로 둔 채 이 파일들의 작업 트리 내용만 커밋
      await git(
        dir,
        ['commit', '--only', '--no-verify', '--cleanup=whitespace', '-m', msg, '--pathspec-from-file=-', '--pathspec-file-nul'],
        { input: [...new Set([...trackedTargets, ...newFiles])].join('\0'), author: identity, env: LITERAL_PATHSPECS },
      );
      return headOf(dir);
    },

    async mergeBaseInto(dir, baseRef, message, identity): Promise<UpdateFromBaseResult> {
      assertIdentity(identity);
      assertRev(baseRef, '기준 브랜치');
      const msg = normalizeMessage(message);

      // 브랜치 이름이면 refs/heads/로 확정 (같은 이름의 태그와 헷갈리지 않게, 충돌 표시에도 이 이름이 나온다)
      const mergeArg = (await resolveCommit(dir, `refs/heads/${baseRef}`)) ? `refs/heads/${baseRef}` : baseRef;
      const baseSha = await resolveCommit(dir, mergeArg);
      if (!baseSha) throw invalid(`기준 브랜치를 찾지 못했습니다: ${baseRef}`);

      if (await mergeInProgress(dir)) {
        const conflicts = await unmergedFiles(dir);
        if (conflicts.length > 0) {
          return { ok: false, conflicts, detail: `이전 병합의 충돌이 아직 해결되지 않았습니다: ${conflicts.join(', ')}` };
        }
        throw invalid('진행 중인 병합이 있습니다. 충돌 해결을 마무리하거나 병합을 취소해야 합니다');
      }
      if (await trackedChanges(dir)) {
        throw invalid(`커밋되지 않은 변경이 있어 최신 기준 브랜치를 반영할 수 없습니다: ${dir}`);
      }
      const head = await headOf(dir);
      if (await isAncestor(dir, baseSha, head)) return { ok: true, sha: head, upToDate: true };

      const args = [
        'merge',
        '--no-ff',
        '--no-edit',
        '--no-verify',
        '--no-log',
        '--no-squash',
        '--no-rerere-autoupdate',
        '--no-verify-signatures',
        '-m',
        msg,
        mergeArg,
      ];
      const r = await git(dir, args, { author: identity, ok: [0, 1, 2] });
      if (r.code === 0) {
        const after = await headOf(dir);
        return { ok: true, sha: after, upToDate: after === head };
      }
      if (await mergeInProgress(dir)) {
        const conflicts = await unmergedFiles(dir);
        if (conflicts.length > 0) {
          return {
            ok: false,
            conflicts,
            detail: `최신 기준 브랜치를 반영하는 중 충돌이 났습니다: ${conflicts.join(', ')}`,
          };
        }
        // 충돌 없이 멈춘 병합은 되돌려 원래 상태로 둔다
        await git(dir, ['merge', '--abort']);
      }
      throw new GitError(failMessage(args, r.code, r.stderr), args, r.code, r.stderr);
    },

    async conflictCheck(dir, recorded) {
      return scanConflicts(dir, recorded ?? []);
    },

    async concludeMerge(dir, message, identity) {
      assertIdentity(identity);
      if (!(await mergeInProgress(dir))) throw invalid(`진행 중인 병합이 없습니다: ${dir}`);

      // 팀원은 git을 직접 쓰지 않고 파일만 고치므로, 아직 표시가 남은 파일이 있는지 내용으로 확인한다
      const { withMarkers } = await scanConflicts(dir);
      if (withMarkers.length > 0) {
        throw invalid(`충돌 표시가 남아 있는 파일이 있습니다: ${withMarkers.join(', ')}`);
      }

      await git(dir, ['add', '-A']);
      const still = await unmergedFiles(dir);
      if (still.length > 0) throw invalid(`충돌이 해결되지 않은 파일이 있습니다: ${still.join(', ')}`);

      const trimmed = typeof message === 'string' ? message.replace(/\r\n?/g, '\n').trim() : '';
      if (trimmed) {
        await commitStaged(dir, `${trimmed}\n`, identity);
      } else {
        // MERGE_MSG에 붙은 "# Conflicts:" 주석 줄을 빼고 쓴다
        await git(dir, ['commit', '--no-verify', '--no-edit', '--cleanup=strip'], { author: identity });
      }
      return headOf(dir);
    },

    async abortMerge(dir) {
      if (!(await mergeInProgress(dir))) return;
      await git(dir, ['merge', '--abort']);
    },

    isAncestor,

    async mergeBase(dir, a, b) {
      assertRev(a, '비교 커밋');
      assertRev(b, '비교 커밋');
      // 종료 코드 1 = 공통 조상 없음 (잘못된 리비전은 128로 오류)
      const r = await read(dir, ['merge-base', a, b], { ok: [0, 1] });
      if (r.code !== 0) return null;
      return r.stdout.trim() || null;
    },

    async mergeIntoBase(repoDir, { baseBranch, taskSha, expectedBaseSha, message, identity }): Promise<MergeIntoBaseResult> {
      assertIdentity(identity);
      assertBranch(baseBranch, '기준 브랜치 이름');
      assertRev(taskSha, '작업 커밋');
      assertRev(expectedBaseSha, '기준 커밋');
      const msg = normalizeMessage(message);
      const baseRef = `refs/heads/${baseBranch}`;

      const current = await resolveCommit(repoDir, baseRef);
      if (!current) return { ok: false, reason: 'error', detail: `기준 브랜치 ${baseBranch}이(가) 없습니다` };
      const expected = await resolveCommit(repoDir, expectedBaseSha);
      if (!expected) return { ok: false, reason: 'error', detail: `기준 커밋을 찾지 못했습니다: ${expectedBaseSha}` };
      if (current !== expected) {
        return {
          ok: false,
          reason: 'base_moved',
          detail: `기준 브랜치 ${baseBranch}이(가) 바뀌었습니다 (예상 ${short(expected)}, 현재 ${short(current)})`,
        };
      }
      const task = await resolveCommit(repoDir, taskSha);
      if (!task) return { ok: false, reason: 'error', detail: `작업 커밋을 찾지 못했습니다: ${taskSha}` };
      if (task === expected) {
        return { ok: false, reason: 'error', detail: '작업 커밋이 기준 브랜치 끝과 같아 병합할 변경이 없습니다' };
      }
      if (!(await isAncestor(repoDir, expected, task))) {
        return {
          ok: false,
          reason: 'not_up_to_date',
          detail: `작업 브랜치에 최신 ${baseBranch}(${short(expected)})가 반영돼 있지 않습니다`,
        };
      }

      const tree = (await read(repoDir, ['rev-parse', '--verify', `${task}^{tree}`])).stdout.trim();
      const merge = (
        await git(repoDir, ['commit-tree', tree, '-p', expected, '-p', task, '-F', '-'], { input: msg, author: identity })
      ).stdout.trim();
      if (!/^[0-9a-f]{40,64}$/.test(merge)) {
        return { ok: false, reason: 'error', detail: `병합 커밋을 만들지 못했습니다: ${JSON.stringify(merge.slice(0, 100))}` };
      }
      try {
        await git(repoDir, ['update-ref', '-m', 'wook merge', baseRef, merge, expected], {
          config: ['-c', 'core.filesRefLockTimeout=2000'],
        });
      } catch (e) {
        if (!(e instanceof GitError)) throw e;
        const now = await resolveCommit(repoDir, baseRef);
        if (now !== expected) {
          return {
            ok: false,
            reason: 'base_moved',
            detail: `병합하는 사이 기준 브랜치 ${baseBranch}이(가) 바뀌었습니다 (현재 ${short(now)})`,
          };
        }
        return { ok: false, reason: 'error', detail: e.message };
      }
      return { ok: true, mergeSha: merge, preSha: expected };
    },

    async syncCheckedOutBase(repoDir, baseBranch, oldSha, newSha) {
      assertBranch(baseBranch, '기준 브랜치 이름');
      assertRev(oldSha, '이전 커밋');
      assertRev(newSha, '새 커밋');
      const baseRef = `refs/heads/${baseBranch}`;
      // 병합은 이미 끝난 뒤라 여기서 던지면 호출자가 병합 기록을 못 남긴다 → git 실패는 모두 ok=false로 돌려준다
      try {
        if ((await symbolicHead(repoDir)) !== baseRef) {
          return { ok: true, detail: `프로젝트 폴더에 ${baseBranch}이(가) 체크아웃돼 있지 않아 맞출 것이 없습니다` };
        }
        const [oldC, newC, cur] = await Promise.all([
          resolveCommit(repoDir, oldSha),
          resolveCommit(repoDir, newSha),
          resolveCommit(repoDir, baseRef),
        ]);
        if (!oldC || !newC) {
          return { ok: false, detail: `커밋을 찾지 못해 프로젝트 폴더를 맞추지 않았습니다 (${oldSha} → ${newSha})` };
        }
        if (cur !== newC) {
          return {
            ok: false,
            detail: `${baseBranch}이(가) 예상한 커밋(${short(newC)})이 아니라 ${short(cur)}을(를) 가리켜 프로젝트 폴더를 맞추지 않았습니다`,
          };
        }
        if (oldC === newC) return { ok: true, detail: '프로젝트 폴더가 이미 최신입니다' };

        // read-tree -m은 인덱스의 파일 정보가 최신이어야 정확히 판단한다 (변경 파일이 있어도 계속 진행 — 종료 코드 1).
        // -q는 쓰지 않는다: -q면 다른 git이 index.lock을 잡고 있을 때 아무 말 없이 128로 끝나 잠금 경합으로 알아보지 못하고(다시 하지 않고)
        // 오류 내용도 남지 않는다 — 인덱스를 다시 써야 할 때(파일 정보가 바뀐 때)만 그래서 부하·시각에 따라 갈렸다
        await git(repoDir, ['update-index', '--refresh'], { ok: [0, 1] });
        // 로컬 변경·미추적 파일을 덮어쓰게 되면 아무것도 바꾸지 않고 실패한다
        await git(repoDir, ['read-tree', '-m', '-u', oldC, newC]);
        return { ok: true, detail: `프로젝트 폴더를 ${short(newC)}(으)로 맞췄습니다` };
      } catch (e) {
        if (!(e instanceof GitError)) throw e;
        return {
          ok: false,
          detail: `프로젝트 폴더의 파일을 최신 ${baseBranch}(${short(newSha)})로 맞추지 못했습니다. 커밋되지 않은 변경이나 미추적 파일이 덮어써질 수 있어 폴더는 그대로 두었습니다: ${summarizeStderr(e.stderr) || e.message}`,
        };
      }
    },

    async baseCheckoutState(repoDir, baseBranch, oldSha, newSha) {
      assertBranch(baseBranch, '기준 브랜치 이름');
      assertRev(oldSha, '이전 커밋');
      assertRev(newSha, '새 커밋');
      const baseRef = `refs/heads/${baseBranch}`;
      if ((await symbolicHead(repoDir)) !== baseRef) return { state: 'not_checked_out', preMerge: [] };
      const [oldC, newC, cur] = await Promise.all([resolveCommit(repoDir, oldSha), resolveCommit(repoDir, newSha), resolveCommit(repoDir, baseRef)]);
      if (!newC || cur !== newC) return { state: 'moved', preMerge: [] };
      // 인덱스와 트리 대조 (--cached: 작업 트리·파일 정보를 보지 않아 인덱스를 다시 쓰지 않는다)
      if (!oldC) {
        // 병합 전 커밋을 찾지 못하면 이 병합의 경로를 가릴 수 없다 — 인덱스 전체가 병합 결과인지로만 본다 (0 = 같음)
        const same = (await read(repoDir, ['diff-index', '--cached', '--quiet', newC, '--'], { ok: [0, 1] })).code === 0;
        return { state: same ? 'synced' : 'diverged', preMerge: [] };
      }
      // 이 병합이 바꾼 경로만 본다 — 그 밖의 경로에 스테이징된 변경은 대표 작업이다. 그 경로의 인덱스 항목이 병합 전 트리와 같으면 병합 전 내용,
      // 병합 결과와 같으면 맞춘 것, 둘 다 아니면(대표가 고친 내용) 그 병합의 변경이 들어 있는지 내용으로 가린다 (mergeChangeIn)
      const merged = parseRawDiffZ((await read(repoDir, ['diff-tree', '-r', '-z', '--no-renames', oldC, newC])).stdout);
      if (!merged.size) return { state: 'synced', preMerge: [] };
      const index = parseRawDiffZ((await read(repoDir, ['diff-index', '--cached', '-z', '--no-renames', oldC, '--'])).stdout);
      const preMerge: string[] = [];
      const preMergeEdited: string[] = [];
      const unverified: string[] = [];
      for (const [p, m] of merged) {
        const i = index.get(p);
        if (!i) preMerge.push(p);
        else if (i.status === 'U' || i.dstMode !== m.dstMode || i.dstSha !== m.dstSha) {
          const has = await mergeChangeIn(repoDir, m, i);
          if (has === 'missing') preMergeEdited.push(p);
          else if (has === 'unknown') unverified.push(p);
        }
      }
      if (!preMerge.length && !preMergeEdited.length && !unverified.length) return { state: 'synced', preMerge };
      return {
        state: preMerge.length === merged.size ? 'behind' : 'diverged',
        preMerge,
        ...(preMergeEdited.length ? { preMergeEdited } : {}),
        ...(unverified.length ? { unverified } : {}),
      };
    },

    async hasTrackedChanges(dir) {
      return trackedChanges(dir);
    },

    async findMergeCommit(repoDir, baseBranch, preSha, taskSha) {
      assertBranch(baseBranch, '기준 브랜치 이름');
      assertRev(preSha, '병합 전 커밋');
      assertRev(taskSha, '작업 커밋');
      const baseRef = `refs/heads/${baseBranch}`;
      const [pre, task, base] = await Promise.all([
        resolveCommit(repoDir, preSha),
        resolveCommit(repoDir, taskSha),
        resolveCommit(repoDir, baseRef),
      ]);
      if (!pre || !task || !base) return null;
      const r = await read(repoDir, ['rev-list', '--merges', '--parents', `${pre}..${baseRef}`, '--']);
      for (const line of r.stdout.split(/\r?\n/)) {
        const [sha, ...parents] = line.trim().split(/\s+/);
        if (sha && parents.length === 2 && parents[0] === pre && parents[1] === task) return sha;
      }
      return null;
    },

    async revertMerge(dir, mergeSha, message, identity): Promise<RevertResult> {
      assertIdentity(identity);
      assertRev(mergeSha, '병합 커밋');
      const msg = normalizeMessage(message);
      const target = await resolveCommit(dir, mergeSha);
      if (!target) throw invalid(`되돌릴 병합 커밋을 찾지 못했습니다: ${mergeSha}`);
      if ((await commitParents(dir, target)).length < 2) throw invalid(`병합 커밋이 아닙니다: ${short(target)}`);

      // 앱이 중간에 꺼져 남은 되돌리기 상태는 정리하고 다시 한다 (이 작업 폴더는 앱 소유)
      if (await revertInProgress(dir)) await git(dir, ['revert', '--abort']);
      if (await mergeInProgress(dir)) throw invalid(`병합이 진행 중이라 되돌릴 수 없습니다: ${dir}`);
      if (await trackedChanges(dir)) throw invalid(`커밋되지 않은 변경이 있어 되돌릴 수 없습니다: ${dir}`);

      // --no-commit 후 직접 커밋: 메시지를 지정하고 --no-verify를 쓰기 위해
      const args = ['revert', '--no-commit', '--no-rerere-autoupdate', '-m', '1', target];
      const r = await git(dir, args, { author: identity, ok: [0, 1, 2] });
      if (r.code !== 0) {
        const pending = await revertInProgress(dir);
        const conflicts = pending ? await unmergedFiles(dir) : [];
        if (pending) await git(dir, ['revert', '--abort']);
        if (conflicts.length > 0) {
          return { ok: false, conflicts, detail: `되돌리는 중 충돌이 나서 되돌리기를 취소했습니다: ${conflicts.join(', ')}` };
        }
        throw new GitError(failMessage(args, r.code, r.stderr), args, r.code, r.stderr);
      }

      const staged = await read(dir, ['diff', '--cached', '--quiet'], { ok: [0, 1] });
      if (staged.code === 0) {
        if (await revertInProgress(dir)) await git(dir, ['revert', '--abort']);
        return { ok: false, conflicts: [], detail: `되돌릴 변경이 없습니다 (이미 되돌려졌을 수 있습니다): ${short(target)}` };
      }
      await commitStaged(dir, msg, identity);
      return { ok: true, sha: await headOf(dir) };
    },

    async archiveBranch(repoDir, branch, archiveName) {
      assertBranch(branch);
      const ref = `refs/wook/archive/${archiveName}`;
      if (typeof archiveName !== 'string' || archiveName.startsWith('-') || !isValidRefName(ref)) {
        throw invalid(`보관 이름이 올바르지 않습니다: ${JSON.stringify(archiveName)}`);
      }
      const sha = await resolveCommit(repoDir, `refs/heads/${branch}`);
      if (!sha) return null;
      const existing = await resolveCommit(repoDir, ref);
      if (existing === sha) return sha;
      if (existing) throw invalid(`같은 이름의 보관 기록이 이미 다른 커밋(${short(existing)})을 가리킵니다: ${archiveName}`);
      // 마지막 빈 값 = 아직 없을 때만 만든다
      await git(repoDir, ['update-ref', '-m', 'wook archive', ref, sha, ''], {
        config: ['-c', 'core.filesRefLockTimeout=2000'],
      });
      return sha;
    },

    async deleteBranch(repoDir, branch) {
      assertBranch(branch);
      const branchRef = `refs/heads/${branch}`;
      if (!(await refExists(repoDir, branchRef))) return;
      const args = ['branch', '-D', branch];
      let r = await git(repoDir, args, { ok: [0, 1] });
      // branch -D는 잠금 실패도 종료 코드 1이라, 그때는 다시 시도하는 경로로 보낸다
      if (r.code !== 0 && isLockContention(r.stderr)) r = await git(repoDir, args);
      if (r.code === 0) return;
      // 폴더가 지워진 작업 폴더 기록이 브랜치를 잡고 있으면 정리하고 한 번 더
      const holder = (await listWorktrees(repoDir)).find((w) => w.branch === branchRef);
      if (holder && (await isStale(holder))) {
        await git(repoDir, ['worktree', 'prune']);
        r = await git(repoDir, args, { ok: [0, 1] });
        if (r.code === 0) return;
      }
      if (!(await refExists(repoDir, branchRef))) return;
      if (holder) {
        throw new GitError(
          `브랜치 ${branch}가 작업 폴더(${holder.path})에서 쓰이고 있어 지울 수 없습니다`,
          args,
          r.code,
          r.stderr,
        );
      }
      throw new GitError(failMessage(args, r.code, r.stderr), args, r.code, r.stderr);
    },

    async diffStat(dir, from, to) {
      assertRev(from, '비교 시작');
      assertRev(to, '비교 끝');
      return diffStatsOf(dir, [from, to]);
    },

    async diffPatch(dir, from, to, maxBytes) {
      assertRev(from, '비교 시작');
      assertRev(to, '비교 끝');
      const r = await read(dir, patchArgs([from, to]), { stdoutLimit: clampBytes(maxBytes) });
      return { patch: r.stdout, truncated: r.truncated };
    },

    async workingDiff(dir, base, maxBytes) {
      assertRev(base, '기준');
      const budget = clampBytes(maxBytes);
      const [files, others, tracked] = await withIndexCopy(dir, (env) =>
        Promise.all([
          diffStatsOf(dir, [base], env),
          read(dir, ['ls-files', '--others', '--exclude-standard', '-z'], { env }),
          read(dir, patchArgs([base]), { stdoutLimit: budget, env }),
        ]),
      );
      let patch = tracked.stdout;
      let used = tracked.stdoutBytes;
      let truncated = tracked.truncated;
      let readBudget = UNTRACKED_READ_BUDGET_BYTES;

      for (const rel of others.stdout.split('\0').filter(Boolean)) {
        // 하위 저장소 폴더는 "dir/" 로 나온다 — 내용 없이 목록에만
        if (rel.endsWith('/')) {
          files.push({ path: rel.slice(0, -1), status: '?', additions: 0, deletions: 0 });
          continue;
        }
        const abs = path.join(dir, rel);
        let st;
        try {
          st = await lstat(abs);
        } catch (e) {
          // 목록을 얻은 뒤 지워진 파일
          if (errCode(e) === 'ENOENT') continue;
          throw invalid(`미추적 파일을 확인하지 못했습니다: ${rel} (${errText(e)})`);
        }
        let mode = process.platform !== 'win32' && st.mode & 0o111 ? '100755' : '100644';
        let content: string | null = null;
        let additions = 0;
        // 패치에 넣을 수 있는지 (false면 목록에만)
        let patchable = true;
        if (st.isSymbolicLink()) {
          mode = '120000';
          try {
            content = await readlink(abs);
            additions = 1;
          } catch (e) {
            if (errCode(e) === 'ENOENT') continue;
            patchable = false;
          }
        } else if (!st.isFile()) {
          patchable = false;
        } else if (st.size > UNTRACKED_MAX_FILE_BYTES) {
          // 큰 파일은 내용 없이 바이너리처럼 표시 (content=null)
        } else if (st.size > readBudget) {
          // 읽기 총량을 넘음: 내용을 빼므로 잘린 결과로 표시
          patchable = false;
          truncated = true;
        } else {
          readBudget -= st.size;
          try {
            const buf = await readFile(abs);
            if (!looksBinary(buf)) {
              content = buf.toString('utf8');
              additions = countLines(content);
            }
          } catch (e) {
            if (errCode(e) === 'ENOENT') continue;
            // 다른 프로그램이 잠근 파일(Windows) 등: 보기용 diff라 목록에만 남기고 내용은 뺀다
            patchable = false;
          }
        }
        files.push({ path: rel, status: '?', additions, deletions: 0 });
        if (truncated || !patchable) continue;
        const piece = newFilePatch(rel, mode, content);
        const bytes = Buffer.byteLength(piece, 'utf8');
        if (used + bytes > budget) {
          truncated = true;
          continue;
        }
        patch += piece;
        used += bytes;
      }
      return { files, patch, truncated };
    },

    async log(dir, ref, limit): Promise<CommitInfo[]> {
      assertRev(ref, '리비전');
      const n = Number.isFinite(limit) ? Math.floor(limit) : 0;
      if (n <= 0) return [];
      const r = await read(dir, [
        'log',
        '-z',
        '--no-color',
        '--no-show-signature',
        `--format=${LOG_FORMAT}`,
        '-n',
        String(n),
        ref,
        '--',
      ]);
      return parseLogZ(r.stdout);
    },

    async push(dir, remote, branch) {
      assertRev(remote, '원격 저장소');
      assertBranch(branch);
      // 같은 이름의 태그와 헷갈리지 않게 전체 이름으로. 강제 올리기 없음
      const refspec = `refs/heads/${branch}:refs/heads/${branch}`;
      const r = await exec(dir, ['push', remote, refspec]);
      const output = `${r.stdout}${r.stdout && r.stderr ? '\n' : ''}${r.stderr}`.trim();
      if (r.timedOut) {
        return { ok: false, output: `${output}\n원격 올리기가 제한 시간을 넘겨 중단했습니다`.trim() };
      }
      return { ok: r.code === 0, output };
    },
  };

  // 같은 저장소의 작업 폴더 명령은 차례로 — 동시에 만들면 git이 반쯤 만든 관리 폴더를 읽다 실패한다 (inWorktreeQueue)
  return withWorktreeQueue(service);
}
