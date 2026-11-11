/**
 * 시험 실행마다 임시 폴더 하나 (리드 결정 S4-24) — 주 설정(vitest.config.ts)의 globalSetup이다. 화면 시험 설정은 쓰지 않는다.
 * - 시험은 os.tmpdir() 아래에 wook-test-* 폴더를 만들고 끝나면 지우는데, Windows에서는 잠긴 파일 때문에 지우지 못한 폴더가 쌓였다(11-03에 1,534개).
 *   시험 파일마다 고치지 않고 여기 한 곳에서 다룬다
 * - 시작: 시스템 임시 폴더 아래에 이 실행의 폴더(wook-vitest-<pid>-<난수 6자>)를 만들고 TEMP·TMP·TMPDIR를 그 폴더로 바꾼다. 일꾼(forks)은 이 뒤에
 *   환경을 물려받아 뜨므로(vitest가 일꾼을 띄울 때 process.env를 그대로 넘긴다) 시험과 시험이 띄우는 프로세스가 모두 그 안에 쓴다
 * - 끝: 환경 변수를 되돌리고 그 폴더를 rmSync(잠긴 파일은 다시 시도)로 지운다. rmSync는 연결 지점(junction)·심볼릭 링크를 따라가지 않고 링크만 지운다.
 *   지우다 남았으면(다른 프로세스가 아직 연 파일은 지워지는 중으로 남아 폴더가 잠깐 비지 않는다) 비기를 잠깐 기다려 빈 폴더를 지운다. 그래도 무엇이 남았으면 그대로
 *   두고 한 줄로 알린다 (리드 결정 S7-24 W3)
 * - 오래된 실행 폴더: 시작할 때 이 이름 꼴이면서 그 pid가 살아 있지 않은 진짜 폴더 가운데 6시간 넘게 바뀌지 않은 것과 빈 것(볼 것이 없다 — 끝(teardown)을 거치지
 *   못하고 끝난 실행, 끝에서 지우지 못한 빈 폴더)을 지운다. 동시에 도는 다른 실행의 폴더(pid가 살아 있다)와 그 밖의 것(예전 wook-test-* 등 — 리드가 따로
 *   지운다)은 건드리지 않는다
 * - 경로가 길어지지 않게(Windows MAX_PATH) 폴더 이름을 짧게 둔다
 */
import { existsSync, lstatSync, mkdtempSync, readdirSync, rmdirSync, rmSync, type Dirent } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 실행 폴더 이름 — mkdtemp가 붙이는 난수 6자 */
export const RUN_DIR_PREFIX = 'wook-vitest-';
export const RUN_DIR_RE = /^wook-vitest-(\d+)-[A-Za-z0-9]{6}$/;
/** 끝난 실행의 폴더를 지우는 때 — 6시간 넘게 바뀌지 않은 것 */
export const RUN_DIR_STALE_MS = 6 * 3_600_000;
/** 시험과 그 자식 프로세스가 임시 폴더를 찾는 환경 변수 (Windows는 TEMP·TMP, POSIX는 TMPDIR) */
export const TEMP_VARS = ['TEMP', 'TMP', 'TMPDIR'] as const;

/** 그 pid의 프로세스가 살아 있는지 — 신호 0은 보내지 않고 있는지만 본다. EPERM은 있지만 권한이 없는 것이라 살아 있다 */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** 폴더를 지운다 — 잠긴 파일은 잠깐씩 다시 시도한다. 연결 지점은 따라가지 않는다. 못 지우면 false */
export function removeTree(dir: string): boolean {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    return true;
  } catch {
    return false;
  }
}

/** 그 폴더 안의 항목 수 — 읽지 못하면(없거나 폴더가 아니다) -1 */
function entryCount(dir: string): number {
  try {
    return readdirSync(dir).length;
  } catch {
    return -1;
  }
}

/** 이 스레드를 ms만큼 멈춘다 — teardown은 동기라 기다림도 동기다 */
function pauseSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 이 실행의 폴더를 닫는다 (teardown): 안의 것까지 지운다(S4-24). 지우다 남았으면 — 다른 프로세스가 아직 연 파일은 지워지는 중으로 남아 그 프로세스가 닫을 때까지
 * 폴더가 비지 않는다 — 비기를 잠깐(tries × waitMs) 기다려 빈 폴더를 지운다. 그래도 무엇이 남았으면 그대로 둔다(left — 남은 항목 수, 리드 결정 S7-24 W3)
 */
export function closeRunDir(dir: string, o: { remove?: (dir: string) => boolean; tries?: number; waitMs?: number } = {}): { removed: boolean; left: number } {
  const remove = o.remove ?? removeTree;
  if (remove(dir) || !existsSync(dir)) return { removed: true, left: 0 };
  const tries = o.tries ?? 10;
  for (let i = 0; i < tries; i++) {
    if (entryCount(dir) === 0) {
      try {
        rmdirSync(dir);
      } catch {
        // 비었어도 지우지 못했다 — 잠깐 뒤 다시
      }
    }
    if (!existsSync(dir)) return { removed: true, left: 0 };
    pauseSync(o.waitMs ?? 300);
  }
  if (!existsSync(dir)) return { removed: true, left: 0 };
  return { removed: false, left: Math.max(0, entryCount(dir)) };
}

/**
 * root 아래의 끝난 실행 폴더 — 이름이 RUN_DIR_RE이고, 진짜 폴더이고(연결 지점·링크·파일은 이 설정이 만든 것이 아니다), 그 pid가 이 프로세스가 아니면서
 * 살아 있지 않고, 6시간 넘게 바뀌지 않았거나(mtime — 실행 중에는 시험이 그 바로 아래에 폴더를 만들어 늘 바뀐다) 빈 것(볼 것이 없다 — 리드 결정 S7-24 W3)만
 */
export function staleRunDirs(root: string, o: { now?: number; alive?: (pid: number) => boolean } = {}): string[] {
  const now = o.now ?? Date.now();
  const alive = o.alive ?? pidAlive;
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const stale: string[] = [];
  for (const d of entries) {
    const m = RUN_DIR_RE.exec(d.name);
    if (!m || !d.isDirectory() || d.isSymbolicLink()) continue;
    const pid = Number(m[1]);
    if (pid === process.pid || alive(pid)) continue;
    const dir = join(root, d.name);
    try {
      const st = lstatSync(dir);
      if (!st.isDirectory() || (now - st.mtimeMs <= RUN_DIR_STALE_MS && entryCount(dir) !== 0)) continue;
    } catch {
      continue;
    }
    stale.push(dir);
  }
  return stale;
}

/** 끝난 실행 폴더를 지우고 이 실행의 폴더를 만든다 */
export function openRunDir(root: string, o: { now?: number; alive?: (pid: number) => boolean } = {}): { dir: string; removed: string[]; left: string[] } {
  const removed: string[] = [];
  const left: string[] = [];
  for (const d of staleRunDirs(root, o)) (removeTree(d) ? removed : left).push(d);
  const dir = mkdtempSync(join(root, `${RUN_DIR_PREFIX}${process.pid}-`));
  return { dir, removed, left };
}

export default function setup(): () => void {
  const run = openRunDir(tmpdir());
  if (run.left.length) console.warn(`[시험 임시 폴더] 끝난 실행의 폴더 ${run.left.length}개를 지우지 못했습니다 — 다음 실행이 다시 지웁니다`);
  const saved = TEMP_VARS.map((k) => [k, process.env[k]] as const);
  for (const k of TEMP_VARS) process.env[k] = run.dir;
  return () => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    const closed = closeRunDir(run.dir);
    if (!closed.removed) {
      console.warn(
        closed.left > 0
          ? `[시험 임시 폴더] 이 실행의 폴더에 지우지 못한 것 ${closed.left}개가 남아 그대로 둡니다 — 6시간 뒤 다음 실행이 지웁니다: ${run.dir}`
          : `[시험 임시 폴더] 이 실행의 폴더가 비었지만 지우지 못했습니다 — 다음 실행이 지웁니다: ${run.dir}`,
      );
    }
  };
}
