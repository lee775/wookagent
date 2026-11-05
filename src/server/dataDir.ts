/**
 * 서버 데이터 폴더 (SERVER_DESIGN 3.7, S2-5): `--data-dir` → `WOOK_DATA_DIR` → 기본 위치. 서버는 패키징 여부와 상관없이 늘 이 순서를 따른다.
 * 기본 위치는 데스크톱 앱(Electron appData/wookagent)과 같다 — 같은 PC에서 둘이 같은 데이터를 쓸 수 있고, 동시 실행은 실행 잠금이 막는다.
 * 처음 만들 때는 그 사용자만 쓰게 한다: POSIX 0700, Windows는 상속을 끊고 지금 사용자만 (icacls). 옆의 임시 이름으로 만들어 좁힌 뒤 제자리로
 * 옮긴다 — 제자리에 있는 새 폴더는 늘 좁힌 폴더다 (S2-20)
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, renameSync, rmdirSync, statSync } from 'node:fs';
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
 * 데이터 폴더를 준비한다. 없으면 그 사용자만 쓰게 만든다(0700·Windows ACL). 있으면 그대로 쓴다 — 데스크톱 앱이 만든 폴더의 권한을 바꾸지 않는다.
 * 새 폴더는 옆의 임시 이름으로 만들어 좁힌 뒤 제자리로 옮긴다 (S2-20): 제자리에 만든 뒤 좁히면, 좁히기(icacls)가 실패하거나 그사이 프로세스가
 * 끝났을 때 물려받은 권한의 폴더가 남고, 다음 시작이 그것을 '이미 있는 폴더'로 그대로 쓴다. 좁히기에 실패하면 임시 폴더를 지우고 던진다.
 * 폴더가 아니거나 만들 수 없으면 던진다
 */
export function prepareDataDir(dataDir: string, platform: NodeJS.Platform = process.platform): { created: boolean } {
  if (existsSync(dataDir)) {
    if (!statSync(dataDir).isDirectory()) throw new Error(`데이터 폴더 자리에 폴더가 아닌 것이 있습니다: ${dataDir}`);
    return { created: false };
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
