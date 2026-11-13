/**
 * 비밀 값 파일 저장소 (리드 결정 S10-6.1 — SERVER_DESIGN 3.7): Linux에서는 데스크톱·서버 두 방식 모두 OS 키링을 쓰지 않고 `<데이터 폴더>/secrets/`의 파일에 둔다.
 * Linux의 키링(@napi-rs/keyring)은 Secret Service가 없으면 커널 keyutils로 말없이 떨어지고, 그 값은 다시 시작하면 사라진다 — 화면 없는 서버의 흔한 꼴이다.
 * - 폴더 0700, 계정마다 0600 파일 하나. 이름은 계정 이름의 SHA-256(16진) + `.json` — 계정 이름(200자 + 조각 표시)이 파일 이름 한도를 넘지 않게.
 *   내용은 `{"v":1,"account":"…","value":"…"}`. 쓰기는 옆의 임시 파일(0600, wx) → fsync → rename → 폴더 fsync — 중간에 끊겨도 옛 값이나 새 값 하나다.
 * - 암호화하지 않는다: 같은 사용자의 프로세스(메인 CLI 포함)는 0600 파일도, 마스터 키도, systemd-creds도 읽을 수 있다 — Windows 자격 증명 관리자와 같은
 *   노출이고, 값은 백엔드 가리개가 가린다. 0600·0700은 다른 사용자만 막는다.
 * - 크게 실패한다: 폴더나 파일이 이 사용자 것이 아니거나 그룹·다른 사용자에게 열려 있거나(mode & 077), 심볼릭 링크·폴더가 아닌 것이면 읽기·쓰기·지우기·
 *   목록 모두 SecretStoreError('backend')로 그 까닭과 고칠 줄(chmod)을 말한다. 상태(fallbackReason)도 지금의 문제를 말한다.
 * - 폴더는 처음 쓸 때 만든다(옆의 임시 이름으로 0700을 만든 뒤 제자리로 — 데이터 폴더와 같은 길). 없으면 읽기는 null, 목록은 비었다.
 * 권한 확인은 uid가 있는 운영체제에서만 한다(시험은 uid·stat을 넣어 Windows에서도 본다)
 */
import { randomBytes, createHash } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeSync, chmodSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { SecretStoreError, type FileSecretBackend } from './secretStore';

/** 데이터 폴더 안의 비밀 값 폴더 이름 */
export const SECRETS_DIR_NAME = 'secrets';

export function secretsDirOf(dataDir: string): string {
  return join(dataDir, SECRETS_DIR_NAME);
}

/** 상태 줄의 저장소 글 (리드 결정 S10-6.1) */
export function fileStoreText(dir: string): string {
  return `파일 (${dir} — 이 사용자만, 암호화하지 않음)`;
}

/** 권한 확인에 쓰는 stat의 부분 */
export interface SecretStat {
  uid: number;
  mode: number;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

export interface FileSecretOptions {
  dir: string;
  /** 이 사용자의 uid — 기본 process.getuid(), 없으면(Windows) 주인·권한을 보지 않는다. 시험이 넣는다 */
  uid?: number | null;
  /** 권한 확인용 lstat (기본 fs.lstatSync) — 시험이 넣는다 */
  stat?: (path: string) => SecretStat;
}

/** POSIX 작은따옴표 (고칠 줄 — 셸이 아무것도 바꾸지 않는다) */
const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
const octal = (mode: number): string => (mode & 0o777).toString(8).padStart(3, '0');

const FILE_RE = /^[0-9a-f]{64}\.json$/;
const fileNameOf = (account: string): string => `${createHash('sha256').update(account, 'utf8').digest('hex')}.json`;

function defaultUid(): number | null {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

/**
 * 한 자리(폴더·파일)의 문제 (없으면 null): 심볼릭 링크, 종류가 다름, 다른 주인, 그룹·다른 사용자에게 열림. uid가 null이면 종류만 본다
 */
function entryProblem(path: string, kind: 'dir' | 'file', st: SecretStat, uid: number | null): string | null {
  const what = kind === 'dir' ? `비밀 값 폴더(${path})` : `비밀 값 파일(${path})`;
  if (st.isSymbolicLink()) return `${what}가 심볼릭 링크입니다 — 링크를 지우고 서버를 다시 시작하세요(폴더는 처음 쓸 때 0700으로 만듭니다)`;
  if (kind === 'dir' ? !st.isDirectory() : !st.isFile()) return `${what} 자리에 ${kind === 'dir' ? '폴더' : '파일'}가 아닌 것이 있습니다 — 그것을 치우세요`;
  if (uid === null) return null;
  if (st.uid !== uid) return `${what}의 주인이 이 사용자(uid ${uid})가 아닙니다 (uid ${st.uid}) — 다른 사용자가 바꿀 수 있는 자리의 값은 쓰지 않습니다. 이 사용자 것으로 다시 만드세요`;
  if ((st.mode & 0o077) !== 0) return `${what}의 권한이 넓습니다 (${octal(st.mode)}) — 그룹·다른 사용자가 열 수 있습니다. 고치기: chmod ${kind === 'dir' ? '700' : '600'} ${shQuote(path)}`;
  return null;
}

/** 이 저장소가 쓰다 남긴 임시 파일의 이름 (`.<64 hex>.json.tmp-<8 hex>`) */
const TMP_RE = /^\.([0-9a-f]{64}\.json)\.tmp-[0-9a-f]{8}$/;
/** 연 때 이만큼 오래된 임시 파일만 지운다 — 같은 때 다른 쓰기의 것을 건드리지 않게 */
export const STALE_TMP_MS = 60_000;

/**
 * 비밀 값 폴더의 지금 문제 (없거나 괜찮으면 null) — 서버 시작(serve.ts)·check·상태가 같은 것을 본다. 폴더와 그 안의 값 파일(64자 16진 .json — 종류·주인·권한)을 본다
 * (리드 결정 S10-13 SH-6: 넓게 열린 파일 하나도 서버를 띄우지 않고 check가 실패로 본다 — 문서대로)
 */
export function fileSecretStoreProblem(dir: string, o: Omit<FileSecretOptions, 'dir'> & { list?: (dir: string) => string[] } = {}): string | null {
  const stat = o.stat ?? ((p: string) => lstatSync(p));
  const uid = o.uid === undefined ? defaultUid() : o.uid;
  let st: SecretStat;
  try {
    st = stat(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return `비밀 값 폴더(${dir})를 읽지 못했습니다 (${(error as NodeJS.ErrnoException).code ?? (error as Error).message})`;
  }
  const dirBad = entryProblem(dir, 'dir', st, uid);
  if (dirBad) return dirBad;
  let names: string[];
  try {
    names = (o.list ?? ((d: string) => readdirSync(d)))(dir);
  } catch (error) {
    return `비밀 값 폴더(${dir})를 읽지 못했습니다 (${(error as NodeJS.ErrnoException).code ?? (error as Error).message})`;
  }
  for (const name of names.filter((n) => FILE_RE.test(n)).sort()) {
    const path = join(dir, name);
    let fst: SecretStat;
    try {
      fst = stat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      return `비밀 값 파일(${path})을 읽지 못했습니다 (${(error as NodeJS.ErrnoException).code ?? (error as Error).message})`;
    }
    const bad = entryProblem(path, 'file', fst, uid);
    if (bad) return bad;
  }
  return null;
}

/** 폴더를 그 사용자만 쓰게 만든다 — 옆의 임시 이름으로 만들어 0700으로 좁힌 뒤 제자리로 옮긴다 (데이터 폴더와 같은 길, S2-20) */
function makePrivateDir(dir: string): void {
  const staging = join(dirname(dir), `.${basename(dir)}.tmp-${randomBytes(4).toString('hex')}`);
  mkdirSync(staging, { mode: 0o700 });
  try {
    chmodSync(staging, 0o700);
    renameSync(staging, dir);
  } catch (error) {
    try {
      rmdirSync(staging);
    } catch {
      // 이미 없다
    }
    // 그사이 다른 쪽이 같은 폴더를 만들었으면 그것을 쓴다 (권한은 부르는 쪽이 다시 본다)
    if ((error as NodeJS.ErrnoException).code === 'EEXIST' || (error as NodeJS.ErrnoException).code === 'ENOTEMPTY') return;
    throw error;
  }
}

/** 폴더의 변경(이름 바꾸기·지우기)을 디스크에 — 폴더 fsync가 없는 운영체제(Windows)에서는 건너뛴다 */
function fsyncDir(dir: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(dir, 'r');
    fsyncSync(fd);
  } catch {
    // Windows는 폴더를 열어 fsync할 수 없다 — 파일 fsync와 rename만으로 둔다
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** 파일 저장소의 한 칸 단위 읽기·쓰기 (createSecretStoreOn이 나눠 담기·키 잠금을 얹는다) */
export function fileSecretBackend(o: FileSecretOptions): FileSecretBackend {
  const { dir } = o;
  const stat = o.stat ?? ((p: string) => lstatSync(p));
  const uid = o.uid === undefined ? defaultUid() : o.uid;
  const fail = (message: string, cause?: unknown): never => {
    throw new SecretStoreError('backend', message, cause !== undefined ? { cause } : undefined);
  };

  /**
   * 쓰다 끊긴 임시 파일(값이 그대로 든다)을 지운다 (리드 결정 S10-13 SH-5): 연 때는 STALE_TMP_MS보다 오래된 것을, 그 계정을 지울 때는 그 계정의 것을 모두.
   * 폴더에 문제가 있으면(남의 것·넓음·링크) 손대지 않는다. 지우지 못해도 값 처리는 이어 간다
   */
  const sweepTmp = (only: { name?: string; olderThanMs?: number }): void => {
    let names: string[];
    try {
      if (entryProblem(dir, 'dir', stat(dir), uid)) return;
      names = readdirSync(dir);
    } catch {
      return;
    }
    const now = Date.now();
    for (const n of names) {
      const m = TMP_RE.exec(n);
      if (!m || (only.name !== undefined && m[1] !== only.name)) continue;
      const path = join(dir, n);
      try {
        const st = lstatSync(path);
        if (!st.isFile()) continue;
        if (only.olderThanMs !== undefined && now - st.mtimeMs < only.olderThanMs) continue;
        unlinkSync(path);
      } catch {
        // 지우지 못하면 다음에 다시 본다
      }
    }
  };
  // 연 때(서버·데스크톱의 백엔드 시작 — 실행 잠금 뒤라 다른 쓰기가 없다): 오래된 임시 파일을 치운다
  sweepTmp({ olderThanMs: STALE_TMP_MS });

  /** 폴더가 있으면 권한을 본다 — 없으면 false (문제가 있으면 던진다) */
  const checkDir = (): boolean => {
    let st: SecretStat;
    try {
      st = stat(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      return fail(`비밀 값 폴더(${dir})를 읽지 못했습니다 (${(error as NodeJS.ErrnoException).code ?? (error as Error).message})`, error);
    }
    const bad = entryProblem(dir, 'dir', st, uid);
    if (bad) fail(bad);
    return true;
  };

  /** 파일의 권한을 본다 — 없으면 false */
  const checkFile = (path: string): boolean => {
    let st: SecretStat;
    try {
      st = stat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      return fail(`비밀 값 파일(${path})을 읽지 못했습니다 (${(error as NodeJS.ErrnoException).code ?? (error as Error).message})`, error);
    }
    const bad = entryProblem(path, 'file', st, uid);
    if (bad) fail(bad);
    return true;
  };

  /** 파일 하나를 읽어 그 계정의 값 (모양이 틀리면 corrupt) */
  const readEntry = (path: string, account: string | null): { account: string; value: string } => {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw error;
      throw new SecretStoreError('corrupt', `비밀 값 파일(${path})의 형식이 손상되었습니다. 다시 등록하세요.`, { cause: error });
    }
    const r = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
    if (r['v'] !== 1 || typeof r['account'] !== 'string' || typeof r['value'] !== 'string' || (account !== null && r['account'] !== account)) {
      throw new SecretStoreError('corrupt', `비밀 값 파일(${path})의 형식이 손상되었습니다. 다시 등록하세요.`);
    }
    return { account: r['account'], value: r['value'] };
  };

  return {
    dir,
    problem: () => fileSecretStoreProblem(dir, { uid, stat }),
    async get(account) {
      if (!checkDir()) return null;
      const path = join(dir, fileNameOf(account));
      if (!checkFile(path)) return null;
      try {
        return readEntry(path, account).value;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
    async set(account, value) {
      if (!checkDir()) {
        try {
          makePrivateDir(dir);
        } catch (error) {
          fail(`비밀 값 폴더(${dir})를 만들지 못했습니다 (${(error as NodeJS.ErrnoException).code ?? (error as Error).message})`, error);
        }
        checkDir();
      }
      const name = fileNameOf(account);
      const path = join(dir, name);
      // 지금 파일이 넓게 열려 있으면 덮어쓰지도 않는다 — 그 자리를 다른 사용자가 바꿨을 수 있다
      checkFile(path);
      const tmp = join(dir, `.${name}.tmp-${randomBytes(4).toString('hex')}`);
      try {
        const fd = openSync(tmp, 'wx', 0o600);
        try {
          writeSync(fd, JSON.stringify({ v: 1, account, value }));
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        chmodSync(tmp, 0o600);
        renameSync(tmp, path);
      } catch (error) {
        try {
          unlinkSync(tmp);
        } catch {
          // 이미 없다
        }
        fail(`비밀 값 '${account}'을 파일에 쓰지 못했습니다 (${(error as NodeJS.ErrnoException).code ?? (error as Error).message})`, error);
      }
      fsyncDir(dir);
    },
    async delete(account) {
      if (!checkDir()) return false;
      const path = join(dir, fileNameOf(account));
      // 그 계정을 쓰다 끊긴 임시 파일도 지운다 — 지운 값이 디스크에 남지 않게 (SH-5)
      sweepTmp({ name: fileNameOf(account) });
      if (!checkFile(path)) return false;
      try {
        unlinkSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        fail(`비밀 값 '${account}'의 파일을 지우지 못했습니다 (${(error as NodeJS.ErrnoException).code ?? (error as Error).message})`, error);
      }
      fsyncDir(dir);
      return true;
    },
    list: async () => {
      if (!checkDir()) return [];
      const out: string[] = [];
      for (const name of readdirSync(dir)) {
        if (!FILE_RE.test(name)) continue;
        const path = join(dir, name);
        if (!checkFile(path)) continue;
        try {
          const e = readEntry(path, null);
          // 이름과 계정이 맞지 않는 파일은 이 저장소가 쓴 것이 아니다 — 목록에 넣지 않는다
          if (fileNameOf(e.account) === name) out.push(e.account);
        } catch {
          // 손상된 파일은 목록에 넣지 않는다 (그 계정을 읽으면 corrupt로 알린다)
        }
      }
      return out;
    },
  };
}
