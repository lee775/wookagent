/**
 * 서버 데이터 폴더 (SERVER_DESIGN 3.7, S2-5): `--data-dir` → `WOOK_DATA_DIR` → 기본 위치. 서버는 패키징 여부와 상관없이 늘 이 순서를 따른다.
 * 기본 위치는 데스크톱 앱(Electron appData/wookagent)과 같다 — 같은 PC에서 둘이 같은 데이터를 쓸 수 있고, 동시 실행은 실행 잠금이 막는다.
 * 처음 만들 때는 그 사용자만 쓰게 한다: POSIX 0700, Windows는 상속을 끊고 지금 사용자만 (icacls). 옆의 임시 이름으로 만들어 좁힌 뒤 제자리로
 * 옮긴다 — 제자리에 있는 새 폴더는 늘 좁힌 폴더다 (S2-20)
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readlinkSync, realpathSync, renameSync, rmdirSync, statSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

export const DATA_DIR_NAME = 'wookagent';

/** 데스크톱 앱과 같은 기본 위치: Windows %APPDATA%, macOS ~/Library/Application Support, Linux $XDG_CONFIG_HOME 또는 ~/.config */
export function defaultDataDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home: string = homedir()): string {
  if (platform === 'win32') return join(env['APPDATA'] || join(home, 'AppData', 'Roaming'), DATA_DIR_NAME);
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', DATA_DIR_NAME);
  return join(env['XDG_CONFIG_HOME'] || join(home, '.config'), DATA_DIR_NAME);
}

/** `--data-dir` → `WOOK_DATA_DIR` → 기본 위치 (절대 경로로) */
export function resolveDataDir(flag: string | undefined, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  const chosen = flag?.trim() || env['WOOK_DATA_DIR']?.trim() || defaultDataDir(env, platform);
  return resolve(chosen);
}

/** Windows 계정 이름 (icacls에 넘긴다): 도메인\사용자 */
export function windowsPrincipal(env: NodeJS.ProcessEnv = process.env): string {
  const user = env['USERNAME'] || userInfo().username;
  return env['USERDOMAIN'] ? `${env['USERDOMAIN']}\\${user}` : user;
}

/**
 * Windows: 상속한 권한을 끊고 지금 사용자에게만 모든 권한을 준다 (icacls /inheritance:r /grant:r). 폴더면 안의 파일·폴더도 따르게 한다.
 * 실패하면 던진다 — 부르는 쪽이 정한다
 */
export function restrictToCurrentUser(path: string, kind: 'file' | 'dir'): void {
  const grant = `${windowsPrincipal()}:${kind === 'dir' ? '(OI)(CI)F' : 'F'}`;
  execFileSync('icacls', [path, '/inheritance:r', '/grant:r', grant], { stdio: 'ignore', windowsHide: true, timeout: 15_000 });
}

/**
 * 데이터 폴더를 만들 수 없게 하는 경로의 자리 (리드 결정 S10-16 FPS-3, S10-16b) — `path`는 데이터 폴더 자신이거나 그 위 폴더 하나
 * - link: 그 자리가 폴더에 닿지 않는 링크 — 링크에 적힌 곳(target)과 따라갈 때의 오류 코드(ENOENT: 가리키는 곳이 없다, ELOOP: 링크가 고리다)
 * - notDir: 위 폴더 자리에 폴더가 아닌 것(파일, 파일로 가는 링크 — link는 그 링크가 닿는 곳)이 있다. 데이터 폴더 자신의 자리는 prepareDataDir·check의 예전 글이 말한다
 */
export type DataDirPathProblem = { kind: 'link'; path: string; target: string; code: string } | { kind: 'notDir'; path: string; link?: string };

/** dataDirPathProblem이 보는 파일 시스템 — 시험이 넣는다 */
export interface DataDirPathFs {
  lstat(path: string): { isSymbolicLink(): boolean; isDirectory(): boolean };
  stat(path: string): { isDirectory(): boolean };
  readlink(path: string): string;
  realpath(path: string): string;
}

const realPathFs: DataDirPathFs = { lstat: (p) => lstatSync(p), stat: (p) => statSync(p), readlink: (p) => readlinkSync(p), realpath: (p) => realpathSync(p) };

const errCode = (error: unknown): string => (error as NodeJS.ErrnoException).code ?? (error as Error).message;

/**
 * 데이터 폴더를 그 자리에 만들 수 있는지 (S10-16 FPS-3·S10-16b) — 데이터 폴더에서 위로 올라가 처음 있는 자리(lstat)를 본다:
 * 폴더에 닿지 않는 링크면(데이터 폴더 자신이든 위 폴더든) link, 위 폴더 자리에 폴더가 아닌 것이면 notDir, 폴더(또는 폴더에 닿는 링크)면 null —
 * 아래의 없는 폴더들은 서버가 만든다. 데이터 폴더 자신이 있으면(링크가 폴더·파일에 닿아도) null: 그 판단은 예전 길이 한다.
 * 그런 자리에는 서버가 폴더를 만들 수 없다 — 링크 위로 옮기기(rename)는 ENOTDIR, 위 폴더 만들기(mkdir)는 ENOENT·ENOTDIR·ELOOP로만 끝난다
 */
export function dataDirPathProblem(dataDir: string, fs: DataDirPathFs = realPathFs): DataDirPathProblem | null {
  let p = dataDir;
  for (;;) {
    let st: { isSymbolicLink(): boolean; isDirectory(): boolean };
    try {
      st = fs.lstat(p);
    } catch (error) {
      // 없다(ENOENT) — 위를 본다. 경로 가운데의 파일(ENOTDIR)·고리(ELOOP)도 위에서 그 자리를 찾는다. 그 밖의 오류(EACCES 등)는 여기서 판단하지 않는다
      const code = errCode(error);
      if (code !== 'ENOENT' && code !== 'ENOTDIR' && code !== 'ELOOP') return null;
      const up = dirname(p);
      if (up === p) return null;
      p = up;
      continue;
    }
    if (st.isSymbolicLink()) {
      let real: string;
      try {
        real = fs.realpath(p);
      } catch (error) {
        let target = '';
        try {
          target = fs.readlink(p);
        } catch {
          // 그사이 바뀌었다 — 적힌 곳 없이 말한다
        }
        return { kind: 'link', path: p, target, code: errCode(error) };
      }
      if (p === dataDir) return null;
      try {
        return fs.stat(p).isDirectory() ? null : { kind: 'notDir', path: p, link: real };
      } catch {
        return null;
      }
    }
    return p === dataDir || st.isDirectory() ? null : { kind: 'notDir', path: p };
  }
}

/**
 * 그 자리의 글과 할 일 — 서버의 시작 거부(prepareDataDir)와 check(Linux)가 같은 글을 쓴다 (S10-16 FPS-3·S10-16b).
 * 데이터 폴더 자신의 링크는 FPS-3의 글 그대로, 위 폴더는 그 경로를 적는다
 */
export function dataDirPathProblemText(dataDir: string, problem: DataDirPathProblem): { text: string; fix: string } {
  if (problem.kind === 'notDir') {
    return {
      text: `데이터 폴더 경로의 위 폴더 자리(${problem.path})에 폴더가 아닌 것이 있습니다${problem.link ? ` (링크 → ${problem.link})` : ''} — 서버는 그 아래에 데이터 폴더를 만들 수 없습니다`,
      fix: '그 자리의 파일을 옮기거나 지우세요, 아니면 다른 --data-dir을 쓰세요',
    };
  }
  const self = problem.path === dataDir;
  const subject = self ? '데이터 폴더가 링크인데' : `데이터 폴더 경로의 위 폴더(${problem.path})가 링크인데`;
  const cannot = self ? '서버는 그 자리에 폴더를 만들 수 없습니다' : '서버는 데이터 폴더를 만들 수 없습니다';
  if (problem.code === 'ELOOP') {
    return { text: `${subject} 링크가 고리를 이뤄 폴더에 닿지 않습니다 (링크 → ${problem.target}) — ${cannot}`, fix: '링크를 고치거나 지우세요' };
  }
  const why = problem.code === 'ENOENT' ? '가리키는 곳이 없습니다' : `가리키는 곳에 닿지 못했습니다 (${problem.code})`;
  return {
    text: `${subject} ${why} (링크 → ${problem.target}) — ${cannot}`,
    fix: '가리키는 곳의 디스크를 붙이거나(mount) 그 폴더를 만들거나, 링크를 고치세요',
  };
}

/**
 * 데이터 폴더를 준비한다. 없으면 그 사용자만 쓰게 만든다(0700·Windows ACL). 있으면 그대로 쓴다 — 데스크톱 앱이 만든 폴더의 권한을 바꾸지 않는다.
 * 데이터 폴더나 그 위 폴더가 폴더에 닿지 않는 링크이거나 위 폴더 자리에 폴더가 아닌 것이 있으면 무엇도 만들기 전에 그 까닭으로 던진다 (S10-16 FPS-3·S10-16b).
 * 새 폴더는 옆의 임시 이름으로 만들어 좁힌 뒤 제자리로 옮긴다 (S2-20): 제자리에 만든 뒤 좁히면, 좁히기(icacls)가 실패하거나 그사이 프로세스가
 * 끝났을 때 물려받은 권한의 폴더가 남고, 다음 시작이 그것을 '이미 있는 폴더'로 그대로 쓴다. 좁히기에 실패하면 임시 폴더를 지우고 던진다.
 * 폴더가 아니거나 만들 수 없으면 던진다
 */
export function prepareDataDir(dataDir: string, platform: NodeJS.Platform = process.platform): { created: boolean } {
  if (existsSync(dataDir)) {
    if (!statSync(dataDir).isDirectory()) throw new Error(`데이터 폴더 자리에 폴더가 아닌 것이 있습니다: ${dataDir}`);
    return { created: false };
  }
  const problem = dataDirPathProblem(dataDir);
  if (problem) {
    const t = dataDirPathProblemText(dataDir, problem);
    throw new Error(`${t.text}. ${t.fix}`);
  }
  const parent = dirname(dataDir);
  mkdirSync(parent, { recursive: true });
  const staging = join(parent, `.${basename(dataDir)}.tmp-${randomBytes(4).toString('hex')}`);
  mkdirSync(staging, { mode: 0o700 });
  try {
    if (platform === 'win32') restrictToCurrentUser(staging, 'dir');
    else chmodSync(staging, 0o700);
    renameSync(staging, dataDir);
  } catch (error) {
    try {
      // 빈 폴더다. rmSync는 Node 24.13(Windows)에서 한글 경로면 프로세스가 죽어 rmdirSync를 쓴다
      rmdirSync(staging);
    } catch {
      // 이미 없다
    }
    // 그사이 다른 프로세스가 같은 폴더를 만들었으면(그쪽도 좁힌 뒤 옮겼다) 그 폴더를 쓴다
    if (existsSync(dataDir) && statSync(dataDir).isDirectory()) return { created: false };
    throw error;
  }
  return { created: true };
}
