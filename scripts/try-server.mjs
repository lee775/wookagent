/**
 * 욱채 체험 도구 (리드 결정 S9-9, docs/TRY_IT.md) — 대표가 이 PC에서 욱채를 직접 써 보는 길.
 *   scripts\try-server.cmd [local|mock|phone|stop] [옵션]   이 파일을 node로 부른다
 *   scripts\try-desktop.cmd [real-data]                      이 파일의 desktop
 *
 * - local (기본): 빌드가 낡았으면 다시 만들고, 체험 데이터 폴더(%LOCALAPPDATA%\wookagent-try\server)로 실제 서버를 띄운다. 이 PC 안의 https 중계
 *   (https://wook-try.test:<포트> — tailscale serve 대신)를 앞에 두고, 운영자 시험 세션(--allow-test-session, `session test --json`)의 토큰을
 *   Edge 창의 `__Host-wos_session` 쿠키로 넣어 로그인한 홈을 연다. 토큰은 화면·명령 줄에 내지 않는다. 메인 에이전트는 이 PC의 실제 Claude다.
 *   - 왜 http://127.0.0.1이 아닌가: 세션 쿠키는 `__Host-`·Secure이고 공개 주소의 Host로만 받는다(S3-31). 웹 화면은 Bearer를 보내지 않는다(S8-4)
 *   - 이미 도는 체험 서버가 있으면 다시 쓴다: 그 서버를 띄운 도구의 중계가 살아 있으면(그 중계가 데이터 폴더의 try-front.json 값으로 증명할 때만 쿠키를
 *     보낸다) 창만 하나 더 열고 서버는 그대로 둔다. 중계가 없으면 같은 포트에 중계를 다시 띄워 이어 쓰고, 끝날 때 그 서버를 끈다 (Windows에서는 도구가 끝나면
 *     그 도구가 띄운 서버도 함께 끝나 이 경우는 드물다 — 문서에는 쓰지 않는다)
 *   - 체험 폴더(데이터·작업 폴더)는 서버의 새 데이터 폴더처럼 이 사용자만 쓰게 만들고 표시 파일(.wook-try-folder)을 넣는다. --fresh는 그 표시가 있는 폴더만 지운다
 * - Ctrl+C는 빌드와 서버 시작 전부터 받는다: 준비 전이면 하던 일을 멈추고 띄운 서버를 손잡이로 끝내며, 준비 뒤면 관리 채널로 끈다. 끝 코드 130
 * - mock: vitest로 tests/try/tryMock.try.ts를 돌린다 — 프로세스 안 서버, 모의 메인 에이전트·프로젝트, 가짜 구글. AI를 부르지 않는다
 * - phone: Tailscale을 읽기만 하고(tailscale status --json, tailscale serve status --json) server.json을 써서 포트 7330에 서버를 띄운다.
 *   `tailscale serve --bg 7330`과 되돌리는 명령은 보여 주기만 한다 — 실행하지 않는다
 * - stop: 체험 서버(local·phone)를 관리 채널의 shutdown으로 끈다 — 그 데이터 폴더의 관리 토큰으로 서로 증명한 서버만 끈다. PID로 끄지 않는다
 * - desktop: 데스크톱 앱(electron-vite preview)을 체험 데이터 폴더로 연다. real-data면 실제 데이터 폴더(묻고 나서)
 *
 * 끝내기: 띄운 서버는 관리 채널 shutdown으로 끄고, 그래도 남으면 이 프로세스가 쥔 손잡이(ChildProcess)로만 끝낸다. 남의 프로세스를 PID로 끄지 않는다.
 * 시험용 환경 변수 (대표는 쓰지 않는다): WOOK_TRY_SERVER_ENTRY(빌드한 서버 index.mjs — 빌드를 건너뛴다), WOOK_TRY_WEB_DIR(서버용 웹 화면 폴더 — 빌드를
 * 건너뛴다), WOOK_TRY_NO_BROWSER=1(local이 Edge를 띄우지 않는다 — 콘솔의 Ctrl+C로 끝내는 시험 tests/server/consoleSignals.test.ts가 쓴다, 리드 결정 S9-19 6).
 * WOOK_TRY_ROOT는 체험 폴더의 뿌리를 바꾼다(문서에 있다)
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { createServer as createHttpsServer, request as httpsRequest } from 'node:https';
import { createRequire } from 'node:module';
import { homedir, tmpdir, userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** 이 PC 안의 시험용 공개 주소 이름 — Edge가 --host-resolver-rules로 127.0.0.1로 찾는다 (.test는 실제 DNS에 없는 이름) */
export const TRY_HOST = 'wook-try.test';
/** phone 서버의 포트 (tailscale serve --bg 7330) */
export const PHONE_PORT = 7330;
/** 체험용 대표 (서버의 운영자 시험 세션이 만드는 대표와 같은 이메일 — 설정 코드 없이 로그인한 홈으로 간다, auth.ts TEST_OWNER) */
export const TRY_OWNER_EMAIL = 'operator-test@wook.local';
/** 체험 서버의 중계를 증명하는 파일 (데이터 폴더 안 — 그 사용자만 읽는다) */
export const FRONT_FILE = 'try-front.json';
export const FRONT_PROBE_PATH = '/__wook-try/front';
export const SESSION_COOKIE = '__Host-wos_session';
const READY_RE = /욱채 서버 준비 완료: 주소 (http:\/\/\S+)(?: \([^)]*\))? · 실행 ID (\S+) · 데이터 폴더 /;
const WEB_MARKER_RE = /<meta\s+name\s*=\s*["']wook-build["']\s+content\s*=\s*["']remote["']\s*\/?>/i;

// ───────────────────────── 인자 ─────────────────────────

export const MODES = ['local', 'mock', 'phone', 'stop', 'desktop'];

/** 쓰임새 글 — 체험 폴더 자리를 넣어 보인다 */
export function usage(paths) {
  return [
    '욱채 체험 도구 — 이 PC에서 욱채를 직접 써 봅니다 (자세한 설명: docs\\TRY_IT.md)',
    '',
    '  scripts\\try-server.cmd [local]',
    '      실제 서버와 웹 화면을 Edge 창으로 엽니다. 메인 에이전트는 이 PC에 로그인된 실제 Claude라,',
    '      명령을 보낼 때마다 구독 사용량이 듭니다',
    '  scripts\\try-server.cmd mock',
    '      모의 서버(모의 메인 에이전트, 모의 프로젝트 3개)와 웹 화면을 Edge 창으로 엽니다. AI를 쓰지 않아 비용이 없습니다',
    '  scripts\\try-server.cmd phone --owner-email <메일> [--google-client-id <클라이언트 ID>]',
    '      휴대폰에서 Tailscale로 들어올 서버를 포트 7330에 띄웁니다.',
    '      Tailscale 설정은 바꾸지 않고, 직접 칠 명령만 보여 줍니다',
    '  scripts\\try-server.cmd stop',
    '      체험 서버(local, phone)를 끕니다',
    '  scripts\\try-desktop.cmd [real-data]',
    '      데스크톱 앱을 체험 데이터 폴더로 엽니다. real-data면 실제 데이터 폴더로 엽니다(묻고 나서)',
    '',
    '옵션',
    '  --fresh            local만: 체험 데이터 폴더와 작업 폴더를 지우고 새로 시작합니다',
    '  --smoke            로그인한 홈까지 열리는지만 보고 모두 끕니다 (점검용)',
    '  --headless         창을 띄우지 않습니다 — --smoke와 함께만 씁니다 (점검용)',
    '  --dry-run          desktop만: 할 일만 보여 주고 아무것도 띄우지 않습니다',
    '  -h, --help         이 도움말',
    '',
    `체험 폴더: ${paths ? paths.root : '%LOCALAPPDATA%\\wookagent-try'} (환경 변수 WOOK_TRY_ROOT로 바꿀 수 있습니다)`,
    '실제 욱채 데이터 폴더는 쓰지 않습니다 — try-desktop.cmd real-data만 씁니다',
    '',
  ].join('\n');
}

/** 인자 → 할 일. 던지지 않는다 */
export function parseKitArgs(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        fresh: { type: 'boolean' },
        headless: { type: 'boolean' },
        smoke: { type: 'boolean' },
        'dry-run': { type: 'boolean' },
        'owner-email': { type: 'string' },
        'google-client-id': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (error) {
    return { error: `인자를 알 수 없습니다: ${error.message}` };
  }
  const { values, positionals } = parsed;
  if (values.help) return { help: true };
  const [first, ...rest] = positionals;
  const mode = first ?? 'local';
  if (!MODES.includes(mode)) return { error: '알 수 없는 방식입니다 — local, mock, phone, stop 가운데 하나를 쓰세요' };
  const realData = mode === 'desktop' && rest.length === 1 && rest[0] === 'real-data';
  if (rest.length > (mode === 'desktop' ? 1 : 0) || (rest.length === 1 && !realData)) return { error: '방식 뒤의 낱말을 알 수 없습니다' };
  const a = {
    mode,
    fresh: values.fresh === true,
    headless: values.headless === true,
    smoke: values.smoke === true,
    dryRun: values['dry-run'] === true,
    ownerEmail: values['owner-email']?.trim() || null,
    googleClientId: values['google-client-id']?.trim() || null,
    realData,
  };
  if (a.fresh && mode !== 'local') return { error: '--fresh는 local에만 씁니다' };
  if ((a.smoke || a.headless) && mode !== 'local' && mode !== 'mock') return { error: '--smoke와 --headless는 local과 mock에만 씁니다' };
  if (a.headless && !a.smoke) return { error: '--headless는 --smoke와 함께만 씁니다 — 창 없이 띄운 서버에는 들어갈 길이 없습니다' };
  if (a.dryRun && mode !== 'desktop') return { error: '--dry-run은 desktop에만 씁니다' };
  if ((a.ownerEmail || a.googleClientId) && mode !== 'phone') return { error: '--owner-email과 --google-client-id는 phone에만 씁니다' };
  if (mode === 'phone' && !a.ownerEmail) return { error: 'phone에는 --owner-email <대표의 구글 계정 메일>이 있어야 합니다' };
  if (a.ownerEmail && !/^[^\s@<>()[\]\\,;:"]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(a.ownerEmail)) return { error: '--owner-email이 메일 모양이 아닙니다' };
  if (a.googleClientId && !/^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(a.googleClientId)) {
    return { error: "--google-client-id가 구글 클라이언트 ID 모양(…apps.googleusercontent.com)이 아닙니다" };
  }
  return a;
}

// ───────────────────────── 자리 ─────────────────────────

/** 실제 욱채 데이터 폴더 (서버의 resolveDataDir과 같은 차례: WOOK_DATA_DIR → 기본 위치) — 체험 폴더가 겹치지 않는지 보는 데 쓴다 */
export function realDataDirs(env = process.env, platform = process.platform) {
  const appData = platform === 'win32' ? env['APPDATA'] || join(homedir(), 'AppData', 'Roaming') : join(homedir(), '.config');
  const dirs = [resolve(appData, 'wookagent')];
  if (env['WOOK_DATA_DIR']?.trim()) dirs.push(resolve(env['WOOK_DATA_DIR'].trim()));
  return dirs;
}

/** 체험 폴더들 — 모두 뿌리(기본 %LOCALAPPDATA%\wookagent-try) 아래 */
export function tryPaths(env = process.env, platform = process.platform) {
  const override = env['WOOK_TRY_ROOT']?.trim();
  const base = platform === 'win32' ? env['LOCALAPPDATA'] || join(homedir(), 'AppData', 'Local') : join(homedir(), '.local', 'share');
  const root = override ? resolve(override) : resolve(base, 'wookagent-try');
  return {
    root,
    rootFromEnv: !!override,
    rootRelative: !!override && !isAbsolute(override),
    server: join(root, 'server'),
    serverWorkspace: join(root, 'workspace'),
    phone: join(root, 'phone'),
    phoneWorkspace: join(root, 'phone-workspace'),
    desktop: join(root, 'desktop'),
    real: realDataDirs(env, platform),
  };
}

const inside = (child, parent) => {
  const r = relative(parent, child);
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
};
/** 두 폴더가 같거나 한쪽이 다른 쪽 안이면 true (Windows는 대소문자 무시) */
export function overlaps(a, b, platform = process.platform) {
  const n = (p) => (platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));
  return inside(n(a), n(b)) || inside(n(b), n(a));
}

/** 체험 폴더가 실제 데이터 폴더와 겹치면 그 까닭 (겹치면 아무것도 하지 않는다) */
export function pathsProblem(paths, platform = process.platform) {
  if (paths.rootRelative) return 'WOOK_TRY_ROOT는 절대 경로여야 합니다';
  for (const dir of [paths.server, paths.serverWorkspace, paths.phone, paths.phoneWorkspace, paths.desktop]) {
    for (const real of paths.real) {
      if (overlaps(dir, real, platform)) return `체험 폴더(${dir})가 실제 욱채 데이터 폴더(${real})와 겹칩니다 — WOOK_TRY_ROOT를 다른 곳으로 정하세요`;
    }
  }
  return null;
}

// ───────────────────────── 체험 폴더 만들기 ─────────────────────────

/** 이 도구가 만든 체험 폴더의 표시 파일 — --fresh는 이 파일이 있는 폴더만 지운다 (리드 결정 S9-22 DF-5) */
export const TRY_MARKER = '.wook-try-folder';
const MARKER_HEAD = 'wook-try-folder 1';
const MARKER_TEXT = `${MARKER_HEAD}\n이 폴더는 욱채 체험 도구(scripts\\try-server.mjs)가 만들었습니다. 'scripts\\try-server.cmd local --fresh'는 이 파일이 있는 폴더만 지웁니다.\n`;

/** 이 도구가 만든 폴더인지 (표시 파일이 있고 그 첫 줄이 맞다) */
export function hasTryMarker(dir) {
  try {
    return readFileSync(join(dir, TRY_MARKER), 'utf8').startsWith(MARKER_HEAD);
  } catch {
    return false;
  }
}

/** Windows 계정 이름 (icacls에 넘긴다): 도메인\사용자 — src/server/dataDir.ts windowsPrincipal과 같다. 이 프로세스를 돌리는 사용자다 */
function windowsPrincipal() {
  const user = process.env['USERNAME'] || userInfo().username;
  return process.env['USERDOMAIN'] ? `${process.env['USERDOMAIN']}\\${user}` : user;
}

/**
 * 체험 폴더를 만든다 — 서버가 새 데이터 폴더를 만드는 것과 같게(src/server/dataDir.ts prepareDataDir, S2-20, 리드 결정 S9-22 DS-5): 옆의 임시 이름으로 만들어
 * 그 사용자만 쓰게 좁히고(Windows: icacls로 상속을 끊고 지금 사용자만, POSIX: 0700) 표시 파일을 넣은 뒤 제자리로 옮긴다 — 제자리에 생긴 폴더는 늘 좁힌
 * 폴더이고, 그 안에 나중에 쓰는 파일(server.json, try-front.json, 서버의 DB·기록)은 그 권한을 물려받는다. 이미 있으면 그대로 둔다(권한·표시를 바꾸지 않는다).
 * 좁히지 못하면 임시 폴더를 지우고 던진다
 */
export function prepareTryDir(dir, platform = process.platform, hooks = {}) {
  if (existsSync(dir)) {
    if (!statSync(dir).isDirectory()) throw new Error(`체험 폴더 자리에 폴더가 아닌 것이 있습니다: ${dir}`);
    return { created: false };
  }
  const parent = dirname(dir);
  mkdirSync(parent, { recursive: true });
  const staging = join(parent, `.${basename(dir)}.tmp-${randomBytes(4).toString('hex')}`);
  mkdirSync(staging, { mode: 0o700 });
  try {
    if (platform === 'win32') {
      const icacls = process.env['SystemRoot'] ? join(process.env['SystemRoot'], 'System32', 'icacls.exe') : 'icacls';
      execFileSync(icacls, [staging, '/inheritance:r', '/grant:r', `${windowsPrincipal()}:(OI)(CI)F`], { stdio: 'ignore', windowsHide: true, timeout: 15_000 });
    } else chmodSync(staging, 0o700);
    writeFileSync(join(staging, TRY_MARKER), MARKER_TEXT, { encoding: 'utf8', mode: 0o600 });
    // 시험 전용: 옮기기 바로 앞 (그사이 다른 실행이 같은 폴더를 만든 경우를 시험이 만든다)
    hooks.beforeRename?.(staging);
    renameSync(staging, dir);
  } catch (error) {
    try {
      unlinkSync(join(staging, TRY_MARKER));
    } catch {
      // 아직 쓰지 않았다
    }
    try {
      // 빈 폴더다 (rmSync는 Node 24.13·Windows에서 한글 경로면 프로세스가 죽는다 — dataDir.ts와 같다)
      rmdirSync(staging);
    } catch {
      // 이미 없다
    }
    // 그사이 다른 실행이 같은 폴더를 만들었으면(그쪽도 좁힌 뒤 옮겼다) 그 폴더를 쓴다
    if (existsSync(dir) && statSync(dir).isDirectory()) return { created: false };
    throw error;
  }
  return { created: true };
}

/**
 * 체험 폴더들을 만든다 — 못 만들면 그 까닭 글, 되면 null. 뿌리(체험 폴더들을 담는 폴더)도 없으면 먼저 그렇게 만든다: 다른 계정이 뿌리에 쓸 수 있으면
 * 그 안의 좁힌 폴더를 지우고 제 폴더로 바꿔 놓을 수 있다 (이미 있는 뿌리는 바꾸지 않는다)
 */
function prepareTryDirs(dirs, deps) {
  for (const dir of dirs) {
    try {
      prepareTryDir(dir, deps.platform);
    } catch (error) {
      return `체험 폴더를 이 사용자만 쓰게 만들지 못했습니다 (${dir}): ${error?.message ?? String(error)}`;
    }
  }
  return null;
}

/** --fresh가 지울 폴더 가운데 이 도구가 만든 표시가 없는 것이 있으면 그 까닭 (없는 폴더는 지울 것이 없어 뺀다) — 아무것도 지우지 않는다 */
export function freshProblem(paths) {
  const foreign = [paths.server, paths.serverWorkspace].filter((d) => existsSync(d) && !hasTryMarker(d));
  if (!foreign.length) return null;
  return [
    `--fresh: 이 폴더에는 체험 도구가 만든 표시(${TRY_MARKER} 파일)가 없어 지우지 않았습니다:`,
    ...foreign.map((d) => `  ${d}`),
    '체험 도구는 자기가 만든 폴더만 지웁니다. 아무것도 지우지 않았습니다 — 그 폴더를 직접 확인해 손으로 지우거나, WOOK_TRY_ROOT를 다른 곳으로 정하세요',
  ].join('\n');
}

/** --fresh가 지울 폴더를 잠깐 옮겨 두는 옆 이름 (`.<이름>.del-<16진 8자>`) */
export const FRESH_TRASH_RE = /^\.(?:server|workspace)\.del-[0-9a-f]{8}$/;

/**
 * --fresh의 지우기 (리드 결정 S9-24 R2K-1): 지울 폴더(체험 데이터 폴더·작업 폴더)를 먼저 하나씩 옆 이름(`.<이름>.del-<16진>`)으로 옮기고, 다 옮긴 뒤에야
 * 옮긴 폴더를 지운다.
 * - 무엇이 그 폴더를 쥐고 있으면(그 안을 현재 폴더로 둔 창, 메인 에이전트가 띄운 프로그램, 열린 파일) Windows는 옮기기를 바로 거절한다 — 그때는 이미 옮긴
 *   것을 되돌리고, 그 폴더와 닫을 것을 말하고, 아무것도 지우지 않고 1로 끝난다 (몇 초 걸리는 지우기를 기다리다 반쯤 지운 폴더를 남기지 않는다)
 * - 이 도구의 폴더는 제 이름으로 있는 동안 표시 파일을 잃지 않는다: 지우기는 옮긴 뒤의 이름에서만 한다
 * - 옮기기 바로 앞에 그 폴더가 체험 뿌리 안이고 표시가 있는지 다시 본다 — 뿌리 밖이나 표시 없는 폴더는 옮기지도 지우지도 않는다
 * - 옮기는 동안 받은 Ctrl+C는 옮긴 것을 되돌리고 130으로 끝낸다
 * 다 되면 null, 멈췄으면 끝 코드
 */
export async function freshRemove(paths, deps, stop, hooks = {}) {
  const moved = [];
  /** 옮기기 (시험 전용 hooks.rename이 그 앞에서 실패를 흉내 낼 수 있다) */
  const move = (from, to) => {
    hooks.rename?.(from, to);
    renameSync(from, to);
  };
  /**
   * 옮긴 것을 되돌린다 — 되돌리지 못한 것은 [제 이름, 옮긴 이름]으로. 되돌리지 못한 옆 이름 폴더에는 메모 파일(RESTORE_NOTE)을 넣는다: 다음 실행이 그 폴더를
   * '쓰지 않는 폴더'가 아니라 '제 이름으로 되돌릴 폴더'로 알아보고 지우지 않는다 (리드 결정 S9-25 R3-1)
   */
  const undo = () => {
    const left = [];
    for (const [orig, tmp] of moved.splice(0).reverse()) {
      try {
        move(tmp, orig);
      } catch {
        left.push([orig, tmp]);
        try {
          writeFileSync(join(tmp, RESTORE_NOTE), restoreNoteText(basename(orig)), { encoding: 'utf8', mode: 0o600 });
        } catch {
          // 메모를 못 써도 아래 글이 그 폴더와 되돌리는 명령을 말한다
        }
      }
    }
    return left;
  };
  /** 되돌리지 못한 폴더가 있으면 그 사실만 (지운 것은 없다): 어느 폴더가 어느 옆 이름에 있는지와 되돌리는 명령 하나씩 */
  const undoText = (left) => (left.length ? `\n${restoreLines(left).join('\n')}` : '');
  for (const dir of [paths.server, paths.serverWorkspace]) {
    if (!existsSync(dir)) continue;
    // 옮기기 바로 앞의 마지막 확인: 체험 뿌리 안(뿌리 자신은 아님)이고 이 도구의 표시가 있는 폴더만
    if (!inside(resolve(dir), resolve(paths.root)) || relative(resolve(paths.root), resolve(dir)) === '') {
      const left = undo();
      deps.err(`--fresh: 체험 뿌리(${paths.root}) 밖의 폴더는 옮기지도 지우지도 않습니다: ${dir}. 아무것도 지우지 않았습니다${undoText(left)}\n`);
      return 1;
    }
    if (!hasTryMarker(dir)) {
      const left = undo();
      deps.err(`${freshProblem(paths) ?? `--fresh: 이 폴더에는 체험 도구가 만든 표시(${TRY_MARKER} 파일)가 없어 지우지 않았습니다: ${dir}`}${undoText(left)}\n`);
      return 1;
    }
    if (stop?.fired) {
      const left = undo();
      if (left.length) deps.err(`${undoText(left).trim()}\n`);
      return stoppedEarly(deps, '--fresh를');
    }
    const tmp = join(dirname(dir), `.${basename(dir)}.del-${randomBytes(4).toString('hex')}`);
    try {
      move(dir, tmp);
      moved.push([dir, tmp]);
    } catch (error) {
      const left = undo();
      deps.err(
        [
          `--fresh: 이 폴더를 다른 프로그램이 쓰고 있어 지우지 않았습니다 (${error?.code ?? '옮기지 못함'}): ${dir}`,
          '  그 폴더 안을 현재 폴더로 둔 창(PowerShell·명령 프롬프트·탐색기)이나, 메인 에이전트가 띄워 아직 도는 프로그램을 닫은 뒤 다시 실행하세요.',
          // 되돌리지 못한 것이 있으면 '그대로입니다'라고 하지 않는다 — 지운 것은 없지만 그 폴더는 옆 이름에 있다 (S9-25 R3-1)
          left.length ? '  아무것도 지우지 않았습니다.' : '  아무것도 지우지 않았습니다 — 체험 데이터 폴더와 작업 폴더는 그대로입니다.',
          ...restoreLines(left),
          '',
        ].join('\n'),
      );
      return 1;
    }
  }
  if (stop?.fired) {
    const left = undo();
    if (left.length) deps.err(`${undoText(left).trim()}\n`);
    return stoppedEarly(deps, '--fresh를');
  }
  for (const [orig, tmp] of moved) {
    try {
      await rm(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    } catch (error) {
      deps.out(
        `--fresh: ${orig}는 옆 이름으로 옮겼지만 다 지우지 못했습니다 (${error?.code ?? '까닭 모름'}): ${tmp} — 이 폴더는 이제 쓰지 않으니 손으로 지워도 됩니다. 체험은 새 폴더로 계속합니다\n`,
      );
    }
  }
  return null;
}

/** --fresh가 제 이름으로 되돌리지 못한 옆 이름 폴더에 넣는 메모 — 그 폴더가 원래 어느 이름이었는지 */
export const RESTORE_NOTE = '.wook-try-restore';
const RESTORE_HEAD = 'wook-try-restore 1';
const restoreNoteText = (name) =>
  `${RESTORE_HEAD}\n${name}\n이 폴더는 욱채 체험 도구의 '${name}' 폴더입니다. --fresh가 옆 이름으로 옮겼다가 제 이름으로 되돌리지 못했습니다 — 지운 것은 없습니다.\n` +
  `이 폴더의 이름을 '${name}'(으)로 바꾸면 그대로 이어 씁니다. 바꾼 뒤에는 이 파일을 지워도 됩니다.\n`;

/** 되돌리지 못한 옆 이름 폴더의 원래 이름 (메모가 없거나 모양이 틀리면 null) */
export function restoreTarget(sideDir) {
  try {
    const [head, name] = readFileSync(join(sideDir, RESTORE_NOTE), 'utf8').split(/\r?\n/);
    return head === RESTORE_HEAD && (name === 'server' || name === 'workspace') ? name : null;
  } catch {
    return null;
  }
}

/** 되돌리는 글 — 폴더마다 '이 옆 이름에 있습니다'와 그 이름을 되돌리는 명령 하나 (PowerShell) */
function restoreLines(left) {
  return left.flatMap(([orig, tmp]) => [
    `  옮겨 둔 폴더를 제 이름으로 되돌리지 못했습니다 — ${basename(orig)} 폴더의 내용은 그대로 ${tmp} 에 있습니다. 이 이름을 되돌리세요:`,
    `    Rename-Item -LiteralPath "${tmp}" -NewName ${basename(orig)}`,
  ]);
}

/** 체험 뿌리 바로 아래의 옆 이름 폴더 — 되돌릴 폴더(메모가 있음)와 남은 폴더(메모 없음, 지우기가 실패한 것)로 나눈다. 알리기만 하고 건드리지 않는다 */
export function sideFolders(paths) {
  let names = [];
  try {
    names = readdirSync(paths.root).filter((n) => FRESH_TRASH_RE.test(n));
  } catch {
    return { stranded: [], leftovers: [] };
  }
  const stranded = [];
  const leftovers = [];
  for (const n of names) {
    const path = join(paths.root, n);
    const to = restoreTarget(path);
    if (to) stranded.push({ path, to, orig: to === 'server' ? paths.server : paths.serverWorkspace });
    else leftovers.push(path);
  }
  return { stranded, leftovers };
}

/** 지난 --fresh가 다 지우지 못하고 남긴 옆 이름 폴더 가운데 쓰지 않는 것 (되돌릴 폴더는 빼고) — 알리기만 하고 건드리지 않는다 */
export function freshLeftovers(paths) {
  return sideFolders(paths).leftovers;
}

/**
 * 되돌리지 못한 옆 이름 폴더가 있으면 (리드 결정 S9-25 R3-1): 원래 이름이 비어 있으면 새 빈 폴더로 시작하지 않고 멈출 까닭을(stop), 원래 이름에 다른 폴더가
 * 있으면 알릴 글을(note) 돌려준다. 그 폴더는 지우지 않는다
 */
export function strandedProblem(paths) {
  const { stranded } = sideFolders(paths);
  if (!stranded.length) return null;
  const lines = stranded.flatMap((s) => [
    `되돌리지 못한 체험 폴더가 있습니다 — 지난 --fresh가 '${s.to}' 폴더를 옆 이름으로 옮겼다가 되돌리지 못했습니다(지운 것은 없습니다): ${s.path}`,
    existsSync(s.orig)
      ? `  지금 '${s.to}' 자리에는 다른 폴더가 있어 그것을 씁니다. 옆 이름의 폴더로 이어 쓰려면 이 도구를 끈 뒤 지금의 '${s.to}' 폴더를 다른 이름으로 옮기고 Rename-Item -LiteralPath "${s.path}" -NewName ${s.to}`
      : `  그 이름을 되돌리세요: Rename-Item -LiteralPath "${s.path}" -NewName ${s.to}`,
  ]);
  const stop = stranded.some((s) => !existsSync(s.orig));
  return { stop, text: [...lines, ...(stop ? ['새 빈 폴더로 시작하지 않았습니다. 아무것도 바꾸지 않았습니다.'] : [])].join('\n') };
}

// ───────────────────────── Ctrl+C ─────────────────────────

/**
 * Ctrl+C(창 닫기)를 빌드와 서버 시작 전부터 받는다 (리드 결정 S9-22 DF-4). 처리기를 걸어 두면 Node는 Ctrl+C에 바로 끝나지 않으므로, 이 도구가 그 뒤를 정한다:
 * 준비 전이면 하던 일을 멈추고(띄운 서버는 손잡이로 끝낸다), 준비 뒤면 onSignal로 건 정리(관리 채널 shutdown)를 한다
 */
function watchInterrupt(deps) {
  let fired = false;
  let handler = null;
  const sig = deps.onInterrupt(() => {
    fired = true;
    handler?.();
  });
  void sig.fired.then(() => {
    fired = true;
  });
  return {
    get fired() {
      return fired;
    },
    signal: sig.fired,
    /** 준비 뒤의 정리 — 이미 받았으면 바로 부른다 */
    onSignal(fn) {
      handler = fn;
      if (fired) fn();
    },
    dispose: () => sig.dispose(),
  };
}

/** 준비 전에 Ctrl+C를 받아 멈춤 — 끝 코드 130 */
function stoppedEarly(deps, what) {
  deps.out(`Ctrl+C — ${what} 멈췄습니다. 띄운 것은 없습니다.\n`);
  return 130;
}

// ───────────────────────── server.json ─────────────────────────

/** local의 server.json — 체험용 대표(설정 코드 없이 로그인), 처음 메인 에이전트 Claude, 화면 조작 끔(S6-11), 체험 작업 폴더 */
export function localServerConfig(paths) {
  return {
    owner: { email: TRY_OWNER_EMAIL },
    seat: { initialHolder: 'launched:claude' },
    workspaceRoot: paths.serverWorkspace,
    screen: { enabled: false },
  };
}

/** phone의 server.json — 이미 있던 칸(구글 클라이언트 ID 등)은 두고 이 도구가 정하는 칸만 쓴다 */
export function phoneServerConfig(existing, o) {
  const base = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {};
  const google = base.google && typeof base.google === 'object' ? base.google : {};
  const network = base.network && typeof base.network === 'object' ? base.network : {};
  return {
    ...base,
    owner: { ...(base.owner && typeof base.owner === 'object' ? base.owner : {}), email: o.ownerEmail, tailscaleLogins: o.login ? [o.login] : [] },
    google: { ...google, ...(o.googleClientId ? { clientId: o.googleClientId } : {}) },
    network: { ...network, publicOrigin: o.origin },
    seat: base.seat && typeof base.seat === 'object' ? base.seat : { initialHolder: 'launched:claude' },
    workspaceRoot: o.workspace,
    screen: { enabled: false },
  };
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return null;
  }
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

// ───────────────────────── 빌드 ─────────────────────────

/**
 * 빌드·vitest의 환경 — 대표에게 쓸모없는 안내(Vite의 설정 불러오기 안내, Node의 SQLite 실험 기능 안내)만 끈다. 다른 경고는 그대로 보인다
 */
export function quietEnv(env) {
  const nodeOptions = [env['NODE_OPTIONS'], '--disable-warning=ExperimentalWarning'].filter(Boolean).join(' ');
  return { ...env, VITE_CONFIG_NATIVE_IGNORE_WARNING: 'true', NODE_OPTIONS: nodeOptions };
}

/**
 * 빌드 셋 — 결과 파일, 소스(이것보다 새로우면 낡았다), 다시 만드는 명령. 소스는 그 빌드가 읽는 파일을 모두 덮어야 한다: 웹 화면 빌드 설정은
 * src/server/webScreen.ts를, 데스크톱 앱(src/main)은 src/server의 파일 몇 개를 불러 쓴다 (리드 결정 S9-22 DF-6 — tryKit이 소스 밖을 부르는 import가
 * 없는지 본다)
 */
export function buildSpecs(repo = REPO) {
  const vite = join(repo, 'node_modules', 'vite', 'bin', 'vite.js');
  return {
    server: {
      label: '서버',
      labelObj: '서버를',
      npm: 'npm run build:server',
      outputs: [join(repo, 'out', 'server', 'index.mjs'), join(repo, 'out', 'server', 'serve.mjs')],
      sources: ['src/server', 'src/main', 'src/core', 'src/shared', 'src/cli', 'package.json', 'vite.server.config.ts'].map((p) => join(repo, p)),
      command: [vite, 'build', '--config', 'vite.server.config.ts'],
    },
    web: {
      label: '웹 화면',
      labelObj: '웹 화면을',
      npm: 'npm run build:web',
      outputs: [join(repo, 'out', 'web', 'index.html')],
      sources: ['src/renderer', 'src/shared', 'src/server/webScreen.ts', 'vite.web.config.ts', 'package.json'].map((p) => join(repo, p)),
      command: [vite, 'build', '--config', 'vite.web.config.ts', '--mode', 'remote'],
      marker: WEB_MARKER_RE,
    },
    desktop: {
      label: '데스크톱 앱',
      labelObj: '데스크톱 앱을',
      npm: 'npm run build',
      outputs: [join(repo, 'out', 'main', 'index.js'), join(repo, 'out', 'preload', 'index.js'), join(repo, 'out', 'renderer', 'index.html')],
      sources: ['src/main', 'src/preload', 'src/renderer', 'src/shared', 'src/core', 'src/server', 'electron.vite.config.ts', 'package.json'].map((p) => join(repo, p)),
      command: [join(repo, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js'), 'build'],
    },
  };
}

/** 폴더(또는 파일) 아래 가장 새로 바뀐 파일 — node_modules는 보지 않는다 */
export function newestFile(paths) {
  let best = null;
  const visit = (p) => {
    let st;
    try {
      st = statSync(p);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      for (const name of readdirSync(p)) if (name !== 'node_modules') visit(join(p, name));
    } else if (!best || st.mtimeMs > best.mtimeMs) best = { path: p, mtimeMs: st.mtimeMs };
  };
  for (const p of paths) visit(p);
  return best;
}

/** 빌드가 낡았는지 — 결과가 없거나, 소스가 결과보다 새롭거나, 웹 화면이 서버용 빌드가 아니면 그 까닭 글, 아니면 null */
export function staleReason(spec, repo = REPO) {
  let oldest = Infinity;
  for (const out of spec.outputs) {
    let st;
    try {
      st = statSync(out);
    } catch {
      return `${relative(repo, out)}이(가) 없습니다`;
    }
    oldest = Math.min(oldest, st.mtimeMs);
  }
  if (spec.marker) {
    const html = readFileSync(spec.outputs[0], 'utf8');
    if (!spec.marker.test(html)) return `${relative(repo, spec.outputs[0])}이(가) 서버용 웹 화면 빌드가 아닙니다`;
  }
  const newest = newestFile(spec.sources);
  if (newest && newest.mtimeMs > oldest) return `${relative(repo, newest.path)}이(가) 빌드보다 새롭습니다`;
  return null;
}

/** 낡았으면 다시 만든다 (무엇을 하는지 먼저 말한다). 끝나면 true. 빌드 중에 Ctrl+C를 받았으면(빌드도 같은 창에서 그 신호를 받아 끝난다) 오류 글 없이 false */
async function ensureBuild(kind, deps, stop) {
  const spec = buildSpecs(deps.repo)[kind];
  const why = staleReason(spec, deps.repo);
  if (!why) {
    deps.out(`빌드 확인: ${spec.label} — 최신입니다\n`);
    return true;
  }
  deps.out(`빌드: ${spec.labelObj} 다시 만듭니다 (${why}) — ${spec.npm} 명령과 같습니다. 1~2분 걸릴 수 있습니다\n`);
  const r = await deps.run(process.execPath, spec.command, { inherit: true, cwd: deps.repo, env: quietEnv(deps.env), timeoutMs: 15 * 60_000 });
  if (stop?.fired) return false;
  if (r.code !== 0) {
    deps.err(`${spec.label} 빌드가 실패했습니다 (끝 코드 ${r.code}) — 위의 글이 까닭입니다. 고친 뒤 다시 실행하세요\n`);
    return false;
  }
  const still = staleReason(spec, deps.repo);
  if (still) {
    deps.err(`${spec.label} 빌드 뒤에도 결과가 맞지 않습니다: ${still}\n`);
    return false;
  }
  deps.out(`빌드: ${spec.labelObj} 만들었습니다\n`);
  return true;
}

/** 서버 진입 파일 — 시험은 WOOK_TRY_SERVER_ENTRY로 따로 만든 빌드를 준다 (빌드를 건너뛴다) */
async function serverEntry(deps, stop) {
  const given = deps.env['WOOK_TRY_SERVER_ENTRY'];
  if (given) return existsSync(given) ? given : null;
  return (await ensureBuild('server', deps, stop)) ? join(deps.repo, 'out', 'server', 'index.mjs') : null;
}

/** 서버용 웹 화면 폴더 — 시험은 WOOK_TRY_WEB_DIR로 준다 (빌드를 건너뛴다) */
async function webDirOf(deps, stop) {
  const given = deps.env['WOOK_TRY_WEB_DIR'];
  if (given) return existsSync(join(given, 'index.html')) ? given : null;
  return (await ensureBuild('web', deps, stop)) ? join(deps.repo, 'out', 'web') : null;
}

/** 메인 에이전트가 이 PC의 Claude 로그인을 쓴다는 한 줄 (리드 결정 S9-22 DF-7) — 도구는 claude를 부르지 않는다 */
export const CLAUDE_LOGIN_LINE = "  - 이 PC의 Claude 로그인을 씁니다(확인: claude auth status). 로그인돼 있지 않으면 첫 명령에서 'claude 인증 만료 — 재로그인 필요'로 멈춥니다";

// ───────────────────────── Edge ─────────────────────────

/** Playwright의 msedge 채널이 찾는 자리 (tests/web/globalSetup.ts edgeCandidates와 같다) */
export function edgeCandidates(env = process.env, platform = process.platform) {
  if (platform === 'win32') {
    const roots = [env['LOCALAPPDATA'], env['PROGRAMFILES'], env['PROGRAMFILES(X86)'] ?? env['ProgramFiles(x86)']].filter((x) => !!x);
    return roots.map((r) => join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  }
  if (platform === 'darwin') return ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'];
  return ['/opt/microsoft/msedge/msedge'];
}

// ───────────────────────── 운영자 명령 ─────────────────────────

/** wook-server <명령> --json --data-dir <폴더> — 답 {ok, result|error}. 읽지 못하면 bad_reply */
export async function operator(deps, entry, words, dataDir, timeoutMs = 60_000) {
  const r = await deps.run(process.execPath, [entry, ...words, '--json', '--data-dir', dataDir], { cwd: deps.repo, timeoutMs });
  const line = (r.stdout ?? '').trim().split(/\r?\n/).pop() ?? '';
  try {
    const reply = JSON.parse(line);
    if (reply && typeof reply.ok === 'boolean') return reply;
  } catch {
    // 아래
  }
  return { ok: false, error: { code: 'bad_reply', message: `운영자 명령의 답을 읽지 못했습니다 (끝 코드 ${r.code})` } };
}

/** 운영자 시험 세션의 토큰 — 화면에 내지 않는다 */
async function sessionToken(deps, entry, dataDir) {
  const reply = await operator(deps, entry, ['session', 'test'], dataDir);
  const token = reply.ok ? reply.result?.token : null;
  if (typeof token !== 'string' || !token) return { token: null, message: reply.ok ? '답에 토큰이 없습니다' : reply.error.message };
  return { token, message: null };
}

// ───────────────────────── 중계 증명 ─────────────────────────

export const frontMac = (nonce, challenge) => createHmac('sha256', nonce).update(challenge).digest('base64url');

/** 중계가 이 데이터 폴더의 try-front.json을 쓴 도구의 것인지 — 그 nonce로 만든 답(HMAC)이 맞을 때만 true. nonce는 중계 밖으로 나가지 않는다 */
export async function frontProven(deps, port, nonce) {
  const challenge = randomBytes(24).toString('base64url');
  const mac = await deps.front.probe(port, challenge);
  if (typeof mac !== 'string') return false;
  const want = Buffer.from(frontMac(nonce, challenge));
  const got = Buffer.from(mac);
  return want.length === got.length && timingSafeEqual(want, got);
}

// ───────────────────────── local ─────────────────────────

function localBanner(paths) {
  return [
    '',
    '욱채 체험 — 실제 서버 (local)',
    '',
    '할 일',
    '  1. 서버와 웹 화면의 빌드가 소스보다 오래됐으면 다시 만듭니다 (npm run build:server, npm run build:web과 같습니다)',
    `  2. 체험 서버를 이 PC 안(루프백)에서 띄웁니다. 데이터 폴더: ${paths.server}`,
    '     다음에 실행해도 그대로 씁니다 (--fresh면 지우고 새로 시작합니다)',
    '  3. 이 PC 안의 https 중계(https://wook-try.test:<포트> — tailscale serve 대신)를 띄우고, 운영자 시험 세션으로 로그인한 Edge 창을 엽니다',
    '',
    '비용과 주의',
    '  - 메인 에이전트는 이 PC에 로그인된 실제 Claude CLI입니다. 명령을 보낼 때마다 Claude 구독 사용량이 들고, 팀원이 Codex를 쓰면 Codex 사용량도 듭니다',
    CLAUDE_LOGIN_LINE,
    '  - 메인 에이전트와 팀원은 이 PC에서 권한 확인 없이 명령을 실행하고 파일을 고칩니다. 메인 에이전트의 host_exec(서버 명령)도 이 PC에서 돕니다',
    `    (메인 에이전트 작업 폴더: ${join(paths.serverWorkspace, 'main')})`,
    '  - 화면 조작(마우스·키보드)은 꺼 둡니다 (server.json의 screen.enabled: false)',
    '  - 비용 없이 화면만 보려면: scripts\\try-server.cmd mock',
    '',
    '끝내기: Edge 창을 닫거나 이 창에서 Ctrl+C를 누르면 서버와 중계를 모두 끕니다. 다른 창에서는 scripts\\try-server.cmd stop',
    '',
  ].join('\n');
}

/** 서버의 준비 줄을 기다리다 Ctrl+C를 받으면 — 관리 채널은 준비 뒤에 열리므로, 이 도구가 띄워 쥔 그 프로세스만 손잡이로 끝낸다 (리드 결정 S9-22 DF-4) */
async function endStartingServer(child, deps, label) {
  deps.out(`Ctrl+C — 아직 준비 중인 ${label}를 끝냅니다 (관리 채널은 준비 뒤에 열려, 이 도구가 띄운 그 프로세스만 끝냅니다)…\n`);
  if (child.exitCode === null && child.signalCode === null) child.kill();
  await Promise.race([exited(child), delay(10_000)]);
}

/** 준비 줄을 기다린다 — 서버가 먼저 끝나면 그 끝을 돌려준다 */
function waitReady(child, timeoutMs) {
  return new Promise((resolveReady) => {
    let out = '';
    let errText = '';
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveReady(v);
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => {
      out += c;
      if (out.length > 64 * 1024) out = out.slice(-32 * 1024);
      const m = READY_RE.exec(out);
      if (m) finish({ ok: true, url: m[1], runId: m[2], port: Number(new URL(m[1]).port) });
    });
    child.stderr.on('data', (c) => {
      errText = `${errText}${c}`.slice(-8 * 1024);
    });
    child.once('exit', (code) => finish({ ok: false, why: `서버가 준비 전에 끝났습니다 (끝 코드 ${code})`, stderr: errText }));
    const timer = setTimeout(() => finish({ ok: false, why: `서버가 ${Math.round(timeoutMs / 1000)}초 안에 준비되지 않았습니다`, stderr: errText }), timeoutMs);
  });
}

const exited = (child) => (child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise((r) => child.once('exit', () => r())));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function local(a, paths, deps) {
  deps.out(localBanner(paths));
  if (!deps.edgeInstalled()) {
    deps.err(`Microsoft Edge가 없습니다 (찾은 자리: ${edgeCandidates(deps.env, deps.platform).join(', ')}). Edge를 설치한 뒤 다시 실행하세요\n`);
    return 1;
  }
  // 지난 --fresh가 제 이름으로 되돌리지 못한 폴더 — 원래 이름이 비었으면 새 빈 폴더로 시작하지 않는다(--fresh도), 아니면 알리고 계속한다 (S9-25 R3-1)
  const stranded = strandedProblem(paths);
  if (stranded?.stop) {
    deps.err(`${stranded.text}\n`);
    return 1;
  }
  if (stranded) deps.out(`${stranded.text}\n`);
  // --fresh는 이 도구가 만든 폴더만 지운다 — 아니면 아무것도 하지 않고 멈춘다 (리드 결정 S9-22 DF-5)
  const foreign = a.fresh ? freshProblem(paths) : null;
  if (foreign) {
    deps.err(`${foreign}\n`);
    return 1;
  }
  // Ctrl+C는 빌드와 서버 시작 전부터 받는다 (DF-4)
  const stop = watchInterrupt(deps);
  try {
    return await localRun(a, paths, deps, stop);
  } finally {
    stop.dispose();
  }
}

async function localRun(a, paths, deps, stop) {
  const dataDir = paths.server;
  const entry = await serverEntry(deps, stop);
  if (stop.fired) return stoppedEarly(deps, '빌드를');
  if (!entry) return 1;
  const webDir = await webDirOf(deps, stop);
  if (stop.fired) return stoppedEarly(deps, '빌드를');
  if (!webDir) return 1;

  let front = null;
  let child = null;
  /** 이 도구가 끝낼 서버인지 (띄웠거나 중계가 없어 이어 받음) */
  let owned = false;
  let browser = null;
  let origin;

  const status = await operator(deps, entry, ['status'], dataDir);
  if (stop.fired) return stoppedEarly(deps, '서버를 띄우기 전에');
  if (status.ok) {
    // 이미 도는 체험 서버를 다시 쓴다
    const shown = await operator(deps, entry, ['config', 'show'], dataDir);
    const publicOrigin = shown.ok ? shown.result?.access?.publicOrigin : null;
    const m = typeof publicOrigin === 'string' ? /^https:\/\/wook-try\.test:(\d+)$/.exec(publicOrigin) : null;
    if (!m) {
      deps.err(`이 데이터 폴더(${dataDir})에서 도는 서버(pid ${status.result.pid})는 try-server가 띄운 서버가 아닙니다 — 그 서버를 끈 뒤 다시 실행하세요\n`);
      return 1;
    }
    const port = Number(m[1]);
    origin = publicOrigin;
    if (a.fresh) {
      deps.err(`체험 서버가 아직 돌고 있어 지우지 않았습니다 (pid ${status.result.pid}) — scripts\\try-server.cmd stop으로 끈 뒤 --fresh로 다시 실행하세요\n`);
      return 1;
    }
    try {
      front = await deps.front.start(port);
    } catch (error) {
      if (error?.code !== 'EADDRINUSE') throw error;
    }
    if (front) {
      owned = true;
      deps.out(`앞서 띄운 체험 서버(pid ${status.result.pid})가 아직 돌고 있고, 그 서버를 띄운 도구는 끝났습니다. 그 서버를 이어 씁니다 — 중계를 같은 포트(${port})에 다시 띄웁니다. 끝낼 때 그 서버도 끕니다\n`);
      front.setUpstream(Number(new URL(status.result.url).port));
      writeJson(join(dataDir, FRONT_FILE), { version: 1, port, nonce: front.nonce });
    } else {
      const file = readJson(join(dataDir, FRONT_FILE));
      const proven = file && file.port === port && typeof file.nonce === 'string' && (await frontProven(deps, port, file.nonce));
      if (!proven) {
        deps.err(`체험 서버(pid ${status.result.pid})의 중계 포트 ${port}를 다른 프로그램이 쓰고 있어 그 서버에 들어가지 않았습니다 (로그인 쿠키를 보내지 않았습니다). scripts\\try-server.cmd stop으로 끈 뒤 다시 실행하세요\n`);
        return 1;
      }
      deps.out(`체험 서버(pid ${status.result.pid})가 다른 창에서 이미 돌고 있습니다. Edge 창만 하나 더 엽니다 — 이 창을 닫아도 그 서버는 그대로 돕니다 (끄려면 그 서버를 띄운 창을 닫거나 scripts\\try-server.cmd stop)\n`);
    }
  } else if (status.error?.code !== 'not_running') {
    deps.err(`체험 데이터 폴더(${dataDir})의 서버 상태를 알 수 없어 멈췄습니다: ${status.error?.message ?? '알 수 없음'}\n`);
    return 1;
  } else {
    if (a.fresh) {
      // 표시가 있는 폴더만 남았는지 한 번 더 본다 (처음 본 뒤 바뀌었을 수 있다)
      const foreign = freshProblem(paths);
      if (foreign) {
        deps.err(`${foreign}\n`);
        return 1;
      }
      deps.out(`--fresh: 체험 데이터 폴더(${dataDir})와 작업 폴더(${paths.serverWorkspace})를 지웁니다\n`);
      const ended = await freshRemove(paths, deps, stop);
      if (ended !== null) return ended;
      const old = freshLeftovers(paths);
      if (old.length) deps.out(`--fresh: 앞서 다 지우지 못하고 남은 폴더가 있습니다 — 쓰지 않는 폴더이니 손으로 지워도 됩니다: ${old.join(', ')}\n`);
    }
    // 데이터 폴더와 작업 폴더를 이 사용자만 쓰게 만든다 — server.json·try-front.json·서버의 DB가 그 권한을 물려받는다 (DS-5)
    const dirProblem = prepareTryDirs([paths.root, dataDir, paths.serverWorkspace], deps);
    if (dirProblem) {
      deps.err(`${dirProblem}\n`);
      return 1;
    }
    const configFile = join(dataDir, 'server.json');
    if (!existsSync(configFile)) {
      writeJson(configFile, localServerConfig(paths));
      deps.out(`server.json을 만들었습니다: ${configFile}\n  체험용 대표(${TRY_OWNER_EMAIL}), 처음 메인 에이전트 Claude CLI, 화면 조작 끔, 작업 폴더 ${paths.serverWorkspace}\n`);
    } else deps.out(`server.json은 있는 것을 그대로 씁니다: ${configFile}\n`);
    if (stop.fired) return stoppedEarly(deps, '서버를 띄우기 전에');
    front = await deps.front.start(0);
    origin = `https://${TRY_HOST}:${front.port}`;
    deps.out('체험 서버를 띄웁니다…\n');
    child = deps.start(process.execPath, [entry, 'serve', '--data-dir', dataDir, '--port', '0', '--allow-test-session', '--public-origin', origin, '--web-dir', webDir], { cwd: deps.repo });
    const ready = await Promise.race([waitReady(child, deps.readyTimeoutMs ?? 180_000), stop.signal.then(() => ({ ok: false, interrupted: true }))]);
    if (!ready.ok && ready.interrupted) {
      await endStartingServer(child, deps, '체험 서버');
      await front.close();
      deps.out('모두 껐습니다.\n');
      return 130;
    }
    if (!ready.ok) {
      deps.err(`${ready.why}${ready.stderr ? `\n${ready.stderr.trim()}` : ''}\n`);
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await front.close();
      return 1;
    }
    owned = true;
    front.setUpstream(ready.port);
    writeJson(join(dataDir, FRONT_FILE), { version: 1, port: front.port, nonce: front.nonce });
    deps.out(`체험 서버 준비: ${ready.url} (pid ${child.pid}) — 공개 주소 ${origin}\n`);
    // 준비 뒤 서버의 오류 글은 이 창에 보인다
    child.stderr.on('data', (c) => deps.err(`[서버] ${c}`));
  }

  // 한 번만 끈다 — Ctrl+C와 창 닫기가 겹쳐도 두 번째 부름은 첫 정리가 끝날 때까지 기다린다
  let cleaning = null;
  const cleanup = (why) => {
    cleaning ??= shutdownAll(why);
    return cleaning;
  };
  const shutdownAll = async (why) => {
    if (why) deps.out(`${why}\n`);
    if (browser) await browser.close().catch(() => undefined);
    if (owned) {
      const alive = child ? child.exitCode === null && child.signalCode === null : true;
      if (alive) {
        deps.out('체험 서버를 끕니다 (관리 채널의 shutdown)…\n');
        const r = await operator(deps, entry, ['shutdown'], dataDir, 90_000);
        if (child) {
          await Promise.race([exited(child), delay(deps.exitWaitMs ?? 45_000)]);
          // 그래도 남았으면 이 도구가 띄운 그 프로세스만 손잡이로 끝낸다
          if (child.exitCode === null && child.signalCode === null) {
            deps.err('서버가 종료 요청에 끝나지 않아 이 도구가 띄운 서버 프로세스를 끝냅니다\n');
            child.kill();
            await Promise.race([exited(child), delay(10_000)]);
          }
        } else if (!r.ok || !r.result?.stopped) {
          deps.err(`서버가 끝났는지 확인하지 못했습니다: ${r.ok ? '40초 안에 끝나지 않았습니다' : r.error.message} — scripts\\try-server.cmd stop으로 다시 끄세요\n`);
        }
      }
      try {
        unlinkSync(join(dataDir, FRONT_FILE));
      } catch {
        // 이미 없다
      }
    }
    if (front) await front.close().catch(() => undefined);
  };

  // 여기부터 Ctrl+C는 관리 채널로 서버를 끄는 정리다 — 준비 중에 이미 받았으면 바로 정리한다
  stop.onSignal(() => void cleanup('Ctrl+C — 모두 끕니다…'));
  /** 정리 중에 받은 것은 닫고 정리가 끝나기를 기다린다 (Ctrl+C) */
  const endOnSignal = async () => {
    if (browser) await browser.close().catch(() => undefined);
    await cleanup(null);
    deps.out(owned ? `모두 껐습니다. 데이터는 ${dataDir}에 남아 있습니다 (지우고 새로 하려면 --fresh)\n` : '이 창의 Edge를 닫았습니다. 체험 서버는 그대로 돕니다\n');
    return 130;
  };
  try {
    if (stop.fired) return await endOnSignal();
    const { token, message } = await sessionToken(deps, entry, dataDir);
    if (stop.fired) return await endOnSignal();
    if (!token) {
      deps.err(`운영자 시험 세션을 받지 못했습니다: ${message}\n`);
      await cleanup(null);
      return 1;
    }
    deps.out('운영자 시험 세션을 받았습니다 (토큰은 화면에 내지 않고 Edge 창의 쿠키로만 넣습니다)\n');
    deps.out(`Edge 창을 엽니다: ${origin}/${a.headless ? ' (창 없이)' : ''}\n`);
    browser = await deps.openBrowser({ origin, token, headless: a.headless, path: a.smoke ? '/?studio3d=0' : '/' });
    if (stop.fired) return await endOnSignal();
    if (a.smoke) {
      const seen = await browser.check();
      // 점검 중에 받은 Ctrl+C는 다른 Ctrl+C와 같이 끝낸다 — 정리가 창을 닫아 점검이 실패한 것은 점검 실패가 아니다 (리드 결정 S9-24 R2K-2)
      if (stop.fired) return await endOnSignal();
      const after = await operator(deps, entry, ['status'], dataDir);
      if (stop.fired) return await endOnSignal();
      const idle = after.ok && after.result?.activeWork === false;
      if (seen.ok && idle) deps.out('점검 통과: 로그인한 홈(프로젝트 현황)이 열렸고, 진행 중인 작업이 없습니다\n');
      else deps.err(`점검 실패: ${seen.ok ? '진행 중인 작업이 있습니다' : seen.detail}\n`);
      await cleanup('점검을 마쳤습니다 — 모두 끕니다');
      deps.out('모두 껐습니다.\n');
      return seen.ok && idle ? 0 : 1;
    }
    deps.out('창이 열렸습니다. 창을 닫거나 이 창에서 Ctrl+C를 누르면 끝납니다.\n');
    const serverGone = child ? exited(child).then(() => 'server') : new Promise(() => undefined);
    const how = await Promise.race([browser.closed.then(() => 'window'), serverGone, stop.signal.then(() => 'signal')]);
    if (how === 'server') await cleanup('체험 서버가 끝났습니다 — Edge 창과 중계도 닫습니다');
    else if (how === 'window') await cleanup('Edge 창을 닫았습니다 — 끝냅니다');
    else await cleanup(null);
    deps.out(owned ? `모두 껐습니다. 데이터는 ${dataDir}에 남아 있습니다 (지우고 새로 하려면 --fresh)\n` : '이 창의 Edge를 닫았습니다. 체험 서버는 그대로 돕니다\n');
    return how === 'signal' ? 130 : 0;
  } catch (error) {
    // Edge 창을 여는 중에 받은 Ctrl+C: 정리가 중계를 닫아 창 열기(page.goto)가 실패한 것이다 — 다른 Ctrl+C와 같이 130으로 끝낸다 (S9-24 R2K-2)
    if (stop.fired) return await endOnSignal();
    deps.err(`멈췄습니다: ${error?.message ?? String(error)}\n`);
    await cleanup(null);
    return 1;
  }
}

// ───────────────────────── mock ─────────────────────────

function mockBanner() {
  return [
    '',
    '욱채 체험 — 모의 서버 (mock)',
    '',
    '할 일',
    '  1. 웹 화면 빌드가 소스보다 오래됐으면 다시 만듭니다 (npm run build:web과 같습니다)',
    '  2. vitest로 모의 무대를 띄웁니다: 이 PC 안의 서버, 모의 메인 에이전트, 모의 프로젝트 3개, 가짜 구글 로그인 — 데이터는 임시 폴더에만 둡니다',
    '  3. Edge 창을 열고 가짜 구글 로그인을 자동으로 마쳐 홈을 보여 줍니다',
    '',
    '비용: 없습니다 — Claude·Codex를 부르지 않고, 비밀 값 저장소(자격 증명 관리자)를 건드리지 않습니다',
    '끝내기: Edge 창을 닫으세요 (이 창에서 Ctrl+C도 됩니다 — 그때 끝 코드는 130입니다)',
    '',
  ].join('\n');
}

/** 모의 무대(vitest)의 임시 폴더 이름 앞부분 — 이 도구가 OS 임시 폴더 아래에 만들고, 무대가 어떻게 끝나든 지운다 (리드 결정 S9-22 DF-3) */
export const MOCK_TEMP_PREFIX = 'wook-try-mock-';

/** 모의 무대의 환경 — 임시 폴더(TEMP·TMP·TMPDIR)를 이 도구가 만든 폴더로 (Windows는 이름의 대소문자를 가리지 않아 같은 이름은 모두 바꾼다) */
export function mockEnv(env, o) {
  const next = { ...quietEnv(env) };
  for (const k of Object.keys(next)) if (/^(temp|tmp|tmpdir)$/i.test(k)) delete next[k];
  return {
    ...next,
    TEMP: o.runDir,
    TMP: o.runDir,
    TMPDIR: o.runDir,
    WOOK_TRY: '1',
    WOOK_TRY_WEB_DIR: o.webDir,
    WOOK_TRY_HEADLESS: o.headless ? '1' : '',
    WOOK_TRY_SMOKE: o.smoke ? '1' : '',
  };
}

async function mock(a, paths, deps) {
  deps.out(mockBanner());
  if (!deps.edgeInstalled()) {
    deps.err(`Microsoft Edge가 없습니다 (찾은 자리: ${edgeCandidates(deps.env, deps.platform).join(', ')}). Edge를 설치한 뒤 다시 실행하세요\n`);
    return 1;
  }
  // Ctrl+C는 빌드 전부터 받는다 — 이 창의 빌드와 vitest도 같은 신호를 받아 끝난다 (DF-4)
  const stop = watchInterrupt(deps);
  try {
    return await mockRun(a, deps, stop);
  } finally {
    stop.dispose();
  }
}

async function mockRun(a, deps, stop) {
  const webDir = await webDirOf(deps, stop);
  if (stop.fired) return stoppedEarly(deps, '빌드를');
  if (!webDir) return 1;
  // 모의 무대의 데이터·Edge 프로필은 모두 이 폴더 안에 생긴다 — Ctrl+C로 vitest가 제 정리를 못 하고 끝나도 이 도구가 지운다 (DF-3)
  const runDir = mkdtempSync(join(tmpdir(), MOCK_TEMP_PREFIX));
  let child;
  try {
    deps.out('모의 무대를 띄웁니다 (vitest — 처음 몇십 초는 준비 시간입니다)…\n');
    child = deps.start(process.execPath, [join(deps.repo, 'node_modules', 'vitest', 'vitest.mjs'), 'run', '--config', 'vitest.try.config.ts', '--maxWorkers=1'], {
      cwd: deps.repo,
      env: mockEnv(deps.env, { runDir, webDir, headless: a.headless, smoke: a.smoke }),
      inherit: true,
    });
    // Ctrl+C는 이 창의 vitest도 함께 받는다 — 그 끝을 기다리고, 그래도 남으면 이 도구가 띄운 그 프로세스만 손잡이로 끝낸다
    await Promise.race([exited(child), stop.signal.then(() => Promise.race([exited(child), delay(deps.exitWaitMs ?? 30_000)]))]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await Promise.race([exited(child), delay(10_000)]);
    }
  } finally {
    // 무대가 남긴 것(Edge가 막 닫힌 프로필 등)은 잠깐 잠겨 있을 수 있어 몇 번 다시 시도한다
    await rm(runDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => undefined);
    if (existsSync(runDir)) deps.out(`모의 무대의 임시 폴더를 다 지우지 못했습니다 — 나중에 지워도 됩니다: ${runDir}\n`);
  }
  if (stop.fired) {
    // Ctrl+C로 끝낸 것은 정상 끝이다 — vitest가 신호로 끝나며 낸 끝 코드는 오류가 아니다
    deps.out('Ctrl+C — 모의 무대를 닫았습니다. 모두 껐습니다.\n');
    return 130;
  }
  if (child.exitCode === 0) {
    deps.out(a.smoke ? '점검 통과: 모의 무대의 로그인한 홈이 열렸습니다. 모두 껐습니다.\n' : '모의 체험을 마쳤습니다. 모두 껐습니다.\n');
    return 0;
  }
  deps.err(`모의 무대가 끝 코드 ${child.exitCode ?? child.signalCode}(으)로 끝났습니다 — 위의 vitest 글이 까닭입니다\n`);
  return 1;
}

// ───────────────────────── phone ─────────────────────────

/** tailscale status --json → 필요한 것만 */
export function readTailscaleStatus(json) {
  const self = json?.Self ?? {};
  const dns = typeof self.DNSName === 'string' ? self.DNSName.replace(/\.$/, '') : '';
  const user = json?.User && self.UserID !== undefined ? json.User[String(self.UserID)] : null;
  return {
    running: json?.BackendState === 'Running',
    state: typeof json?.BackendState === 'string' ? json.BackendState : '알 수 없음',
    dnsName: dns || null,
    https: Array.isArray(json?.CertDomains) && json.CertDomains.length > 0,
    login: typeof user?.LoginName === 'string' ? user.LoginName : null,
  };
}

/** tailscale serve status --json → 이미 있는 항목 글과 7330으로 넘기는 항목이 있는지 */
export function readServeStatus(json, port = PHONE_PORT) {
  const entries = [];
  let ours = false;
  for (const [p, v] of Object.entries(json?.TCP ?? {})) {
    if (v?.TCPForward) entries.push(`TCP ${p} → ${v.TCPForward}`);
    else if (v?.HTTPS) entries.push(`TCP ${p} (HTTPS)`);
    else entries.push(`TCP ${p}`);
  }
  for (const [host, v] of Object.entries(json?.Web ?? {})) {
    for (const [path, h] of Object.entries(v?.Handlers ?? {})) {
      const target = h?.Proxy ?? h?.Path ?? h?.Text ?? '?';
      entries.push(`https://${host}${path} → ${target}`);
      if (typeof h?.Proxy === 'string' && new RegExp(`(127\\.0\\.0\\.1|localhost):${port}(/|$)`).test(h.Proxy)) ours = true;
    }
  }
  const funnel = Object.values(json?.AllowFunnel ?? {}).some(Boolean);
  return { entries, ours, funnel };
}

function phoneBanner(paths) {
  return [
    '',
    '욱채 체험 — 휴대폰으로 (phone)',
    '',
    '할 일',
    '  1. Tailscale 상태를 읽습니다 (tailscale status --json, tailscale serve status --json — 읽기만 합니다)',
    `  2. 체험 데이터 폴더(${paths.phone})의 server.json에 대표 이메일, 공개 주소, 받는 Tailscale 사용자, 화면 조작 끔을 적습니다`,
    `  3. 빌드가 오래됐으면 다시 만들고, 서버를 이 PC 안의 포트 ${PHONE_PORT}에서 띄웁니다 — 휴대폰은 tailscale serve를 거쳐 들어옵니다`,
    '  4. tailscale serve를 켜고 끄는 명령을 보여 줍니다. 이 도구는 Tailscale 설정을 바꾸지 않습니다 — 직접 실행하세요',
    '',
    '비용과 주의: local과 같습니다 — 메인 에이전트는 실제 Claude CLI라 명령마다 구독 사용량이 들고, host_exec는 이 PC에서 돕니다. 화면 조작은 꺼 둡니다',
    CLAUDE_LOGIN_LINE,
    '끝내기: 이 창에서 Ctrl+C (또는 다른 창에서 scripts\\try-server.cmd stop). 그다음 아래에 보이는 되돌리는 명령으로 tailscale serve를 끄세요',
    '',
  ].join('\n');
}

async function phone(a, paths, deps) {
  deps.out(phoneBanner(paths));
  // Ctrl+C는 빌드와 서버 시작 전부터 받는다 (DF-4)
  const stop = watchInterrupt(deps);
  try {
    return await phoneRun(a, paths, deps, stop);
  } finally {
    stop.dispose();
  }
}

async function phoneRun(a, paths, deps, stop) {
  const st = await deps.run('tailscale', ['status', '--json'], { timeoutMs: 15_000 });
  let ts = null;
  try {
    ts = st.code === 0 ? readTailscaleStatus(JSON.parse(st.stdout)) : null;
  } catch {
    ts = null;
  }
  if (!ts || !ts.running || !ts.dnsName) {
    deps.err(
      [
        `Tailscale이 준비되지 않았습니다 (${ts ? `상태 ${ts.state}` : 'tailscale status를 읽지 못했습니다'}).`,
        '  1. 이 PC에 Tailscale을 설치하고 로그인합니다 (tailscale up)',
        '  2. 휴대폰에도 Tailscale 앱을 깔고 같은 계정으로 로그인합니다',
        '  3. 이 명령을 다시 실행합니다',
        '서버는 띄우지 않았습니다.',
        '',
      ].join('\n'),
    );
    return 1;
  }
  const origin = `https://${ts.dnsName}`;
  if (!ts.https) {
    deps.err(
      [
        '이 tailnet은 HTTPS 인증서가 꺼져 있습니다 (tailscale status의 CertDomains가 비었습니다).',
        '  1. https://login.tailscale.com/admin/dns 에서 MagicDNS와 HTTPS Certificates를 켭니다',
        '  2. 이 명령을 다시 실행합니다',
        '서버는 띄우지 않았습니다.',
        '',
      ].join('\n'),
    );
    return 1;
  }
  const configFile = join(paths.phone, 'server.json');
  const existing = readJson(configFile);
  const config = phoneServerConfig(existing, { ownerEmail: a.ownerEmail, login: ts.login, origin, googleClientId: a.googleClientId, workspace: paths.phoneWorkspace });
  if (!config.google?.clientId) {
    deps.err(
      [
        '구글 로그인 클라이언트가 없습니다. 휴대폰 로그인은 구글 기기 코드 로그인이라 \'TV 및 입력 제한 기기\' 종류의 OAuth 클라이언트가 있어야 합니다.',
        `  1. docs\\SERVER_INSTALL.md 2절대로 클라이언트를 만듭니다 (게시 상태가 '테스트'면 테스트 사용자에 ${a.ownerEmail}을(를) 넣으세요)`,
        `  2. 클라이언트 ID를 붙여 다시 실행합니다: scripts\\try-server.cmd phone --owner-email ${a.ownerEmail} --google-client-id <클라이언트 ID>`,
        '보안 비밀은 서버가 뜬 뒤에 넣습니다 — 그때 이 도구가 명령을 보여 줍니다.',
        '서버는 띄우지 않았습니다.',
        '',
      ].join('\n'),
    );
    return 1;
  }
  if (stop.fired) return stoppedEarly(deps, '서버를 띄우기 전에');
  // 데이터 폴더와 작업 폴더를 이 사용자만 쓰게 만든다 — server.json과 서버의 DB가 그 권한을 물려받는다 (DS-5)
  const dirProblem = prepareTryDirs([paths.root, paths.phone, paths.phoneWorkspace], deps);
  if (dirProblem) {
    deps.err(`${dirProblem}\n`);
    return 1;
  }
  writeJson(configFile, config);
  deps.out(
    `server.json을 썼습니다: ${configFile}\n  대표 이메일 ${a.ownerEmail}, 공개 주소 ${origin}, 받는 Tailscale 사용자 ${ts.login ?? '(이 PC의 사용자를 읽지 못해 검사하지 않음)'}, 화면 조작 끔\n`,
  );
  const sv = await deps.run('tailscale', ['serve', 'status', '--json'], { timeoutMs: 15_000 });
  let serve = { entries: [], ours: false, funnel: false };
  try {
    serve = sv.code === 0 && sv.stdout.trim() ? readServeStatus(JSON.parse(sv.stdout)) : serve;
  } catch {
    // 읽지 못하면 없는 것으로 본다
  }
  const others = serve.entries.filter((e) => !new RegExp(`(127\\.0\\.0\\.1|localhost):${PHONE_PORT}(/|$)`).test(e));
  if (others.length) {
    deps.out(
      [
        `주의: 이 PC의 Tailscale 이름(${ts.dnsName})에는 이미 다른 tailscale serve 항목이 있습니다:`,
        ...others.map((e) => `  - ${e}`),
        '  체험에는 그대로 써도 되지만, 실제로 쓸 때는 욱채 서버만 두세요 — 같은 이름의 다른 서비스에도 욱채의 로그인 쿠키가 갑니다. 이 도구는 그 항목을 지우지 않습니다',
        '',
      ].join('\n'),
    );
  }
  if (serve.funnel) deps.out('주의: 이 PC에 tailscale funnel(인터넷 공개)이 켜진 항목이 있습니다. 욱채에는 funnel을 쓰지 않습니다\n');
  const entry = await serverEntry(deps, stop);
  if (stop.fired) return stoppedEarly(deps, '빌드를');
  if (!entry) return 1;
  const webDir = await webDirOf(deps, stop);
  if (stop.fired) return stoppedEarly(deps, '빌드를');
  if (!webDir) return 1;
  const status = await operator(deps, entry, ['status'], paths.phone);
  if (stop.fired) return stoppedEarly(deps, '서버를 띄우기 전에');
  if (status.ok) {
    deps.err(`휴대폰 체험 서버가 이미 돌고 있습니다 (pid ${status.result.pid}) — 그 창을 쓰거나 scripts\\try-server.cmd stop으로 끈 뒤 다시 실행하세요\n`);
    return 1;
  }
  deps.out(`휴대폰 체험 서버를 띄웁니다 (포트 ${PHONE_PORT})…\n`);
  const child = deps.start(process.execPath, [entry, 'serve', '--data-dir', paths.phone, '--port', String(PHONE_PORT), '--web-dir', webDir], { cwd: deps.repo });
  const ready = await Promise.race([waitReady(child, deps.readyTimeoutMs ?? 180_000), stop.signal.then(() => ({ ok: false, interrupted: true }))]);
  if (!ready.ok && ready.interrupted) {
    await endStartingServer(child, deps, '휴대폰 체험 서버');
    deps.out('모두 껐습니다.\n');
    return 130;
  }
  if (!ready.ok) {
    deps.err(`${ready.why}${ready.stderr ? `\n${ready.stderr.trim()}` : ''}\n`);
    if (child.exitCode === null && child.signalCode === null) child.kill();
    return 1;
  }
  child.stderr.on('data', (c) => deps.err(`[서버] ${c}`));
  const shown = await operator(deps, entry, ['config', 'show'], paths.phone);
  const secretSet = shown.ok && shown.result?.google?.secretSet === true;
  const lines = [`휴대폰 체험 서버 준비: ${ready.url} (pid ${child.pid})`, ''];
  if (!secretSet) {
    lines.push(
      '구글 보안 비밀이 아직 없습니다. 다른 PowerShell 창의 저장소 폴더에서 넣으세요 (값은 명령 줄에 쓰지 않습니다):',
      `  Get-Content .\\google-secret.txt | scripts\\wook-server.cmd secret set google-client-secret --data-dir "${paths.phone}"`,
      `  (파일 없이 scripts\\wook-server.cmd secret set google-client-secret --data-dir "${paths.phone}"만 치면 화면에 보이지 않게 붙여 넣을 수 있습니다)`,
      '  이 비밀은 Windows 자격 증명 관리자의 욱채 항목(wookagent)에 들어갑니다. 데이터 폴더와 상관없는 자리라, 이 PC에 실제 욱채 서버를 둔다면',
      '  그 서버의 구글 보안 비밀도 이 값으로 바뀝니다 (데스크톱 앱의 구글 로그인 비밀은 따로라 바뀌지 않습니다)',
      '',
    );
  }
  lines.push(
    serve.ours ? `tailscale serve는 이미 포트 ${PHONE_PORT}으로 넘기고 있습니다.` : '다른 창에서 직접 실행하세요 (이 도구는 실행하지 않습니다):',
    ...(serve.ours ? [] : [`  tailscale serve --bg ${PHONE_PORT}`]),
    `휴대폰 브라우저에서 ${origin} 을 열고 구글 계정(${a.ownerEmail})으로 로그인합니다. 휴대폰도 같은 Tailscale 계정${ts.login ? `(${ts.login})` : ''}으로 로그인돼 있어야 합니다.`,
    '',
    '다 쓴 뒤 되돌리기:',
    '  1. 이 창에서 Ctrl+C (서버를 끕니다)',
    '  2. tailscale serve --https=443 off   (이 도구가 실행하지 않습니다. tailscale serve reset은 다른 항목까지 지우니 쓰지 마세요)',
    '',
  );
  deps.out(`${lines.join('\n')}\n`);
  await Promise.race([exited(child), stop.signal]);
  if (child.exitCode === null && child.signalCode === null) {
    // 이 도구가 띄운 서버는 창 없이(콘솔 없이) 돌아 이 창의 Ctrl+C를 받지 않는다 — 관리 채널의 shutdown으로 바로 끄고 그 끝을 기다린다. 그래도 남으면 이 도구가
    // 띄운 그 프로세스만 손잡이로 (local과 같다 — tests/server/consoleSignals.test.ts가 local의 Ctrl+C를 본다)
    deps.out('Ctrl+C — 휴대폰 체험 서버를 끕니다 (관리 채널의 shutdown)…\n');
    await operator(deps, entry, ['shutdown'], paths.phone, 90_000);
    await Promise.race([exited(child), delay(deps.exitWaitMs ?? 45_000)]);
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
  deps.out(`휴대폰 체험 서버가 끝났습니다. tailscale serve를 켰다면 끄세요: tailscale serve --https=443 off\n`);
  return stop.fired ? 130 : 0;
}

// ───────────────────────── stop ─────────────────────────

async function stop(paths, deps) {
  const entry = deps.env['WOOK_TRY_SERVER_ENTRY'] || join(deps.repo, 'out', 'server', 'index.mjs');
  if (!existsSync(entry)) {
    deps.err(`서버 빌드(${entry})가 없어 체험 서버에 물을 수 없습니다 — 이 도구로 띄운 서버라면 빌드를 지우기 전에 띄운 창에서 Ctrl+C로 끄세요\n`);
    return 1;
  }
  deps.out('체험 서버를 끕니다 — 각 체험 데이터 폴더의 관리 채널(관리 토큰으로 서로 증명)로 shutdown을 보냅니다. 다른 프로그램은 건드리지 않습니다\n');
  let failed = false;
  for (const [label, dir] of [
    ['local 체험 서버', paths.server],
    ['phone 체험 서버', paths.phone],
  ]) {
    const st = await operator(deps, entry, ['status'], dir);
    if (!st.ok) {
      deps.out(`  ${label}: 돌고 있지 않습니다 (${dir})\n`);
      continue;
    }
    deps.out(`  ${label}: 끕니다 (pid ${st.result.pid}, ${dir})…\n`);
    const r = await operator(deps, entry, ['shutdown'], dir, 90_000);
    if (r.ok && r.result?.stopped) deps.out(`  ${label}: 껐습니다\n`);
    else {
      failed = true;
      deps.err(`  ${label}: 끝났는지 확인하지 못했습니다 — ${r.ok ? '40초 안에 끝나지 않았습니다' : r.error.message}. ${join(dir, 'logs', 'server.log')}를 보세요\n`);
    }
  }
  deps.out('mock 체험은 그 창(Edge 창 닫기나 Ctrl+C)으로만 끝납니다.\n');
  return failed ? 1 : 0;
}

// ───────────────────────── desktop ─────────────────────────

/** 데스크톱 앱의 환경 — 체험이면 WOOK_DATA_DIR을 체험 폴더로, real-data면 WOOK_DATA_DIR을 빼서 앱의 기본 자리(%APPDATA%\wookagent)를 쓰게 */
export function desktopEnv(env, paths, realData) {
  const next = { ...env };
  for (const k of Object.keys(next)) if (k.toUpperCase() === 'WOOK_DATA_DIR') delete next[k];
  if (!realData) next['WOOK_DATA_DIR'] = paths.desktop;
  return next;
}

function desktopBanner(paths, realData) {
  const dir = realData ? paths.real[0] : paths.desktop;
  return [
    '',
    `욱채 체험 — 데스크톱 앱${realData ? ' (실제 데이터)' : ''}`,
    '',
    '할 일',
    '  1. 데스크톱 앱 빌드가 소스보다 오래됐으면 다시 만듭니다 (npm run build와 같습니다)',
    `  2. 데스크톱 앱을 엽니다 (npm start와 같습니다). 데이터 폴더: ${dir}`,
    ...(realData
      ? [
          '',
          '주의 — 실제 데이터 폴더입니다',
          '  - 이 빌드가 그 폴더의 DB에 지금 판의 표를 더하고 판 번호를 올립니다 (마이그레이션 — 되돌리지 않습니다). 먼저 그 폴더를 복사해 두면 안전합니다',
          '  - 실제 앱이 켜져 있으면 열리지 않습니다 (한 데이터 폴더는 한 번에 하나만 씁니다)',
        ]
      : ['     실제 데이터 폴더와 따로입니다 (실제 데이터로 열려면 scripts\\try-desktop.cmd real-data)']),
    '',
    '알아 둘 것',
    "  - 패키징하지 않은 실행이라 로그인 화면의 '개발 모드로 시작하기'로 구글 없이 들어갑니다",
    '  - 메인 에이전트는 이 PC의 실제 Claude CLI입니다. 명령을 보낼 때마다 구독 사용량이 듭니다',
    CLAUDE_LOGIN_LINE,
    '  - 앱의 설정에서 넣는 구글 로그인 보안 비밀과 API 키는 Windows 자격 증명 관리자의 욱채 항목(wookagent)에 들어갑니다.',
    '    데이터 폴더와 상관없는 자리라, 여기서 넣거나 지우면 실제 앱이 쓰는 값도 바뀝니다',
    '',
    '끝내기: 앱 창을 닫으세요',
    '',
  ].join('\n');
}

async function desktop(a, paths, deps) {
  deps.out(desktopBanner(paths, a.realData));
  const bin = join(deps.repo, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js');
  if (a.dryRun) {
    deps.out(`(--dry-run) 실행할 명령: node ${bin} preview --skipBuild — WOOK_DATA_DIR=${a.realData ? '(없음 — 앱의 기본 자리)' : paths.desktop}\n아무것도 띄우지 않았습니다.\n`);
    return 0;
  }
  if (a.realData) {
    const answer = (await deps.ask('실제 데이터 폴더로 열려면 y를 치고 Enter를 누르세요 (그 밖은 그만둡니다): ')).trim().toLowerCase();
    if (answer !== 'y' && answer !== 'yes') {
      deps.out('그만두었습니다. 아무것도 바꾸지 않았습니다.\n');
      return 1;
    }
  }
  if (!(await ensureBuild('desktop', deps))) return 1;
  if (!a.realData) {
    // 체험 데이터 폴더를 이 사용자만 쓰게 만든다 — 앱이 그 안에 DB·기록을 쓴다 (DS-5)
    const dirProblem = prepareTryDirs([paths.root, paths.desktop], deps);
    if (dirProblem) {
      deps.err(`${dirProblem}\n`);
      return 1;
    }
  }
  deps.out('데스크톱 앱을 엽니다…\n');
  const child = deps.start(process.execPath, [bin, 'preview', '--skipBuild'], { cwd: deps.repo, env: desktopEnv(deps.env, paths, a.realData), inherit: true });
  await exited(child);
  deps.out('데스크톱 앱이 끝났습니다.\n');
  return child.exitCode === 0 ? 0 : 1;
}

// ───────────────────────── 실행 ─────────────────────────

export async function runKit(argv, deps) {
  const a = parseKitArgs(argv);
  const paths = tryPaths(deps.env, deps.platform);
  if (a.error) {
    deps.err(`${a.error}\n\n${usage(paths)}`);
    return 2;
  }
  if (a.help) {
    deps.out(usage(paths));
    return 0;
  }
  const problem = pathsProblem(paths, deps.platform);
  if (problem) {
    deps.err(`${problem}\n`);
    return 2;
  }
  switch (a.mode) {
    case 'local':
      return local(a, paths, deps);
    case 'mock':
      return mock(a, paths, deps);
    case 'phone':
      return phone(a, paths, deps);
    case 'stop':
      return stop(paths, deps);
    case 'desktop':
      return desktop(a, paths, deps);
  }
  return 2;
}

// ───────────────────────── 실제 의존 ─────────────────────────

/** playwright-core의 자체 서명 인증서 생성기 (tests/web/proxy.ts와 같은 것 — 디스크에 쓰지 않는다) */
function selfSignedCertificate() {
  const bundle = createRequire(import.meta.url)('playwright-core/lib/coreBundle');
  const make = bundle?.utils?.generateSelfSignedCertificate;
  if (typeof make !== 'function') throw new Error('playwright-core에 자체 서명 인증서 생성기가 없습니다');
  return make();
}

/**
 * https 중계 — tests/web/proxy.ts처럼 공개 주소의 TLS를 받아 루프백 서버(http)로 그대로 넘긴다(Host·Origin·쿠키를 바꾸지 않는다). 다른 것은 하지 않는다.
 * 포트를 고를 수 있고(이어 쓰기), FRONT_PROBE_PATH에 nonce로 만든 HMAC으로 답한다 — nonce는 이 프로세스와 데이터 폴더의 try-front.json에만 있다
 */
export async function startFront(port = 0) {
  const { cert, key } = selfSignedCertificate();
  const nonce = randomBytes(32).toString('base64url');
  const sockets = new Set();
  let upstream = 0;
  const server = createHttpsServer({ cert, key }, (req, res) => {
    const url = new URL(req.url ?? '/', 'https://x');
    if (url.pathname === FRONT_PROBE_PATH) {
      const challenge = url.searchParams.get('c') ?? '';
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ mac: frontMac(nonce, challenge) }));
      return;
    }
    if (!upstream) {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('서버가 아직 준비되지 않았습니다');
      return;
    }
    const up = httpRequest({ host: '127.0.0.1', port: upstream, method: req.method, path: req.url, headers: req.headers, agent: false }, (upRes) => {
      res.writeHead(upRes.statusCode ?? 502, upRes.headers);
      upRes.pipe(res);
    });
    up.on('error', () => res.socket?.destroy());
    res.on('close', () => up.destroy());
    req.pipe(up);
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  server.on('tlsClientError', () => undefined);
  await new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', fail);
      ok();
    });
  });
  return {
    port: server.address().port,
    nonce,
    setUpstream: (p) => {
      upstream = p;
    },
    close: () =>
      new Promise((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}

/** 그 포트의 중계에 도전값을 보내 답(mac)을 받는다 — 쿠키·토큰은 보내지 않는다 */
export function probeFront(port, challenge) {
  return new Promise((resolveProbe) => {
    const req = httpsRequest(
      { host: '127.0.0.1', port, path: `${FRONT_PROBE_PATH}?c=${encodeURIComponent(challenge)}`, method: 'GET', rejectUnauthorized: false, headers: { Host: `${TRY_HOST}:${port}` }, timeout: 5000, agent: false },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          body += c;
          if (body.length > 4096) req.destroy();
        });
        res.on('end', () => {
          try {
            const mac = JSON.parse(body)?.mac;
            resolveProbe(typeof mac === 'string' ? mac : null);
          } catch {
            resolveProbe(null);
          }
        });
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolveProbe(null));
    req.end();
  });
}

/** Edge 창 (playwright-core) — 시험 세션 쿠키를 넣고 연다. 이 프로세스가 Ctrl+C를 직접 다루므로 Playwright의 신호 처리는 끈다 */
export async function openBrowser({ origin, token, headless, path }) {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({
    channel: 'msedge',
    headless,
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
    // 인증서 오류 무시는 이 창(임시 프로필)에만 — 시험용 자체 서명 인증서라서. tests/web/rig.ts와 같다
    args: [`--host-resolver-rules=MAP ${TRY_HOST} 127.0.0.1`, '--no-proxy-server', '--ignore-certificate-errors'],
  });
  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: true, locale: 'ko-KR', timezoneId: 'Asia/Seoul', viewport: headless ? { width: 1366, height: 900 } : null });
    await context.addCookies([{ name: SESSION_COOKIE, value: token, url: `${origin}/`, secure: true, httpOnly: true, sameSite: 'Strict' }]);
    const page = await context.newPage();
    let resolveClosed;
    const closed = new Promise((r) => (resolveClosed = r));
    const onPageClose = () => {
      if (context.pages().length === 0) resolveClosed();
    };
    page.on('close', onPageClose);
    context.on('page', (p) => p.on('close', onPageClose));
    browser.on('disconnected', () => resolveClosed());
    await page.goto(`${origin}${path}`, { timeout: 120_000 });
    return {
      closed,
      async check() {
        try {
          await page.getByRole('heading', { name: '프로젝트 현황' }).waitFor({ timeout: 120_000 });
          const login = await page.getByRole('button', { name: 'Google 계정으로 로그인' }).count();
          return login === 0 ? { ok: true } : { ok: false, detail: '로그인 화면이 보입니다' };
        } catch (error) {
          return { ok: false, detail: `2분 안에 로그인한 홈(프로젝트 현황)이 보이지 않았습니다 — ${String(error?.message ?? error).split('\n')[0]}` };
        }
      },
      close: () => browser.close(),
    };
  } catch (error) {
    await browser.close().catch(() => undefined);
    throw error;
  }
}

function runProcess(file, args, o = {}) {
  return new Promise((resolveRun) => {
    let child;
    try {
      child = spawn(file, args, { cwd: o.cwd ?? REPO, env: o.env ?? process.env, stdio: o.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
      resolveRun({ code: -1, stdout: '', stderr: String(error?.message ?? error) });
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8').on('data', (c) => (stdout += c));
    child.stderr?.setEncoding('utf8').on('data', (c) => (stderr += c));
    const timer = o.timeoutMs
      ? setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill();
        }, o.timeoutMs)
      : null;
    child.once('error', (error) => {
      if (timer) clearTimeout(timer);
      resolveRun({ code: -1, stdout, stderr: `${stderr}${error.message}` });
    });
    child.once('close', (code) => {
      if (timer) clearTimeout(timer);
      resolveRun({ code: code ?? -1, stdout, stderr });
    });
  });
}

/** Ctrl+C(SIGINT)·Ctrl+Break(SIGBREAK)·창 닫기(SIGHUP)를 한 번 받는다 */
function onInterrupt(handler) {
  let fire;
  const fired = new Promise((r) => (fire = r));
  const names = process.platform === 'win32' ? ['SIGINT', 'SIGBREAK', 'SIGHUP'] : ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const listener = () => {
    handler();
    fire();
  };
  for (const n of names) process.on(n, listener);
  return { fired, dispose: () => names.forEach((n) => process.off(n, listener)) };
}

function ask(question) {
  return new Promise((resolveAsk) => {
    process.stdout.write(question);
    let text = '';
    const onData = (c) => {
      text += c;
      if (text.includes('\n')) {
        process.stdin.off('data', onData);
        process.stdin.pause();
        resolveAsk(text.split(/\r?\n/)[0]);
      }
    };
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', onData);
    process.stdin.once('end', () => resolveAsk(text));
    process.stdin.resume();
  });
}

/**
 * 시험 전용 (WOOK_TRY_NO_BROWSER=1): Edge 창 대신 — 창은 닫히지 않는 것으로 친다. local은 Ctrl+C(창 닫기)나 서버가 끝날 때만 끝난다. 점검(--smoke)은 실패로 본다
 * (보지 못했다). 시험이 브라우저 없이 콘솔 신호만 볼 때 쓴다 (리드 결정 S9-19 6)
 */
async function openNoBrowser() {
  return {
    closed: new Promise(() => undefined),
    check: async () => ({ ok: false, detail: '창 없이 띄웠습니다 (WOOK_TRY_NO_BROWSER — 시험 전용)' }),
    close: async () => undefined,
  };
}

export function realDeps() {
  const noBrowser = process.env['WOOK_TRY_NO_BROWSER'] === '1';
  return {
    env: process.env,
    platform: process.platform,
    repo: REPO,
    out: (t) => process.stdout.write(t),
    err: (t) => process.stderr.write(t),
    run: runProcess,
    start: (file, args, o = {}) =>
      spawn(file, args, { cwd: o.cwd ?? REPO, env: o.env ?? process.env, stdio: o.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'], windowsHide: true }),
    front: { start: startFront, probe: probeFront },
    openBrowser: noBrowser ? openNoBrowser : openBrowser,
    edgeInstalled: () => noBrowser || edgeCandidates().some((p) => existsSync(p)),
    onInterrupt,
    ask,
  };
}

/** 표준 출력·오류를 다 내보낸 뒤 끝낸다 — Windows 콘솔 쓰기는 비동기라 바로 끝내면 마지막 글이 잘릴 수 있다 */
async function flushAndExit(code) {
  await new Promise((r) => process.stdout.write('', () => r()));
  await new Promise((r) => process.stderr.write('', () => r()));
  process.exit(code);
}

// 직접 실행할 때만 (시험은 함수를 불러 쓴다)
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await flushAndExit(await runKit(process.argv.slice(2), realDeps()));
}
