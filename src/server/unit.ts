/**
 * Linux의 systemd 사용자 유닛 (SERVER_DESIGN 10.10, 리드 결정 S10-6.2): `wook-server install-task | uninstall-task [--dry-run] [--json]`이 Linux에서 하는 일.
 * 서버를 로그인한 사용자의 systemd 사용자 유닛 `wook-server-<데이터 폴더 해시 8자>.service`로 띄운다 — 시스템 유닛·root·sudo는 쓰지 않는다.
 * - 지킴: root(uid 0)면 1. 사용자 버스(XDG_RUNTIME_DIR이 있고 `systemctl --user show-environment`가 0)가 없으면 1 — sudo -u·su로 바꾼 셸에는 없다.
 *   진입점(<앱 루트>/out/server/index.mjs)이 있어야 하고, 웹 화면은 Windows와 같다(task.ts chooseWebDir). 넣을 값에 제어 문자·짝 없는 서로게이트가 있거나 앱 폴더가
 *   빈칸으로 시작하거나 끝나거나 역슬래시로 끝나면 받지 않는다. `--allow-test-session`·`--bind`와 '-'로 시작하는 값은 인자를 읽을 때 cli.ts가 거부한다
 * - 유닛 글(unitText): KillMode=mixed(서버에만 SIGTERM — 턴을 차례로 끝낸 뒤 남은 것은 SIGKILL), TimeoutStopSec=45, Restart=on-failure, RestartSec=60,
 *   StartLimitBurst=4 / StartLimitIntervalSec=600, UMask=0077, install-task를 실행한 셸의 PATH, 절대 경로의 --data-dir. 값은 systemd 규칙으로 감싼다:
 *   ExecStart는 낱말마다 큰따옴표 — `\`→`\\`, `"`→`\"`, `%`→`%%`(지정자), `$`→`$$`(실행 때 환경 변수 펼치기). Environment=는 같되 `$`는 그대로(펼치지 않는다).
 *   WorkingDirectory=·Description=은 따옴표를 풀지 않고 `%`만 `%%`
 * - 등록: `~/.config/systemd/user`(사용자 관리자의 XDG_CONFIG_HOME이 있으면 그 아래)에 임시 파일(0600) → 제자리로 → `systemctl --user daemon-reload` →
 *   `systemctl --user enable <유닛>` → 다시 읽기(파일 글이 쓴 그대로, `systemctl --user show`의 LoadState·FragmentPath·DropInPaths·UnitFileState·KillMode·
 *   WorkingDirectory·ExecStart). 다르거나 덧붙인 설정(drop-in)이 있으면 1. 서버는 띄우지 않는다(start는 운영자가) — 다음 할 일과, linger가 꺼져 있으면
 *   `sudo loginctl enable-linger <사용자>`를 말한다(sudo는 부르지 않는다). 다시 하면 바꿔 넣는다
 * - --dry-run: 유닛 글과 실행할 명령을 보여 주기만 한다 — 파일을 쓰지 않고 systemctl은 읽기(show-environment)만
 * - uninstall-task: 유닛이 없으면 '등록된 유닛이 없습니다'로 0. 있으면 disable → 우리 파일을 지움 → daemon-reload → 다시 읽어 없어진 것을 본다. 읽지 못하면 1(있는지
 *   모르면 없다고 하지 않고 지우지 않는다). 실행 중인 서버는 끄지 않는다(shutdown을 말한다)
 * systemctl은 주입할 수 있는 실행기로만 부른다 — execFile, 셸 없이, 15초(task.ts realRunner)
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { posix } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import type { ExecResult, TaskFlags, TaskRunner } from './task';

/** 유닛 이름 앞머리 */
export const UNIT_PREFIX = 'wook-server-';
/** 유닛 이름의 모양 */
export const UNIT_NAME_RE = /^wook-server-[0-9a-f]{8}\.service$/;
/** 유닛 파일 첫 줄 — install-task가 쓴 파일인지 알아본다 */
export const UNIT_HEADER = '# wook-server install-task가 쓴 파일입니다 — 바꾸려면 install-task를 다시 하세요 (손으로 고친 것은 check가 알립니다)';
export const UNIT_ROOT_REFUSAL = '로그인한 사용자 계정으로 실행해야 합니다 — root로는 사용자 유닛을 등록하지 않습니다 (sudo 없이, 서버를 돌릴 사용자로 실행하세요)';
export const NO_USER_BUS =
  '이 사용자의 systemd(사용자 관리자)에 닿지 못했습니다 — 서버를 돌릴 사용자로 직접 로그인한 셸(SSH 포함)에서 실행하세요. sudo -u·su로 바꾼 셸에는 사용자 버스(XDG_RUNTIME_DIR)가 없습니다';

/**
 * 유닛 이름이 셈하는 데이터 폴더 — 가장 가까운 있는 상위 폴더의 실제 경로(링크를 푼 것)에 나머지를 붙인다 (리드 결정 S10-13 SH-2). 데이터 폴더가 아직 없을 때와
 * 서버가 그 폴더를 만든 뒤가 같은 값이다(경로에 링크가 있어도). 폴더가 있으면 그 실제 경로 그대로 — 예전 이름(admin.ts dataDirHash의 Linux 규칙)과 같다
 */
export function unitDataPath(dataDir: string, real: (p: string) => string = (p) => realpathSync.native(p)): string {
  const abs = posix.resolve(dataDir);
  const rest: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      const r = real(cur);
      return rest.length ? posix.join(r, ...rest) : r;
    } catch {
      if (cur === '/') return abs;
      rest.unshift(posix.basename(cur));
      cur = posix.dirname(cur);
    }
  }
}

/**
 * 데이터 폴더의 유닛 이름 `wook-server-<해시 8자>.service` — Linux는 unitDataPath(대소문자를 가린다, 링크를 푼 실제 경로)를 센다. 다른 OS(시험)는 적힌 POSIX 경로를
 * 그대로 센다(파일 시스템에 닿지 않는다). Windows 작업 이름(task.ts)·파이프 이름(admin.ts)은 이것과 따로다
 */
export function unitName(dataDir: string, platform: NodeJS.Platform = process.platform, real?: (p: string) => string): string {
  const key = platform === 'linux' ? unitDataPath(dataDir, real) : posix.resolve(dataDir);
  return `${UNIT_PREFIX}${createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 8)}.service`;
}

/**
 * 같은 데이터 폴더를 가리키는 install-task의 유닛 파일 이름들 (S10-13 SH-2) — 유닛 폴더의 wook-server-*.service 가운데 install-task가 쓴 것(첫 줄 UNIT_HEADER)이고
 * ExecStart의 --data-dir이 unitDataPath로 같은 폴더인 것. 데이터 폴더가 생기기 전에 등록했거나 경로의 링크가 바뀌어 이름이 달라진 유닛도 찾는다
 */
export function unitsForDataDir(dataDir: string, unitDir: string, fs: { list(dir: string): string[]; read(path: string): string | null }, real?: (p: string) => string): string[] {
  const want = unitDataPath(dataDir, real);
  const out: string[] = [];
  for (const n of fs.list(unitDir).filter((x) => UNIT_NAME_RE.test(x)).sort()) {
    const text = fs.read(posix.join(unitDir, n));
    if (text === null || !text.startsWith(UNIT_HEADER)) continue;
    const exec = parseUnitFile(text).service['ExecStart'] ?? [];
    const argv = exec.length === 1 ? execWords(exec[0]!)?.argv : undefined;
    const at = argv ? argv.indexOf('--data-dir') : -1;
    if (argv && at >= 0 && argv[at + 1] !== undefined && unitDataPath(argv[at + 1]!, real) === want) out.push(n);
  }
  return out;
}

// ───────────────────────── systemd 글 ─────────────────────────

/** ExecStart의 낱말 하나 — 큰따옴표 안: `\`·`"`는 C 이스케이프, `%`는 지정자, `$`는 실행 때 펼치는 변수 */
export function systemdExecWord(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, '$$$$')}"`;
}

/** Environment= 의 `"이름=값"` — ExecStart와 같되 `$`는 그대로(Environment=는 변수를 펼치지 않는다) */
export function systemdEnvAssignment(name: string, value: string): string {
  return `"${`${name}=${value}`.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;
}

/** 따옴표를 풀지 않는 칸(WorkingDirectory=·Description=) — `%`만 */
export const systemdPlain = (value: string): string => value.replace(/%/g, '%%');

export interface UnitInputs {
  dataDir: string;
  /** process.execPath (realpath 하지 않는다) */
  nodePath: string;
  /** <앱 루트>/out/server/index.mjs */
  entry: string;
  /** 작업 폴더 (앱 루트) */
  appRoot: string;
  webDir: string | null;
  port?: number;
  configPath?: string;
  ownerEmail?: string;
  publicOrigin?: string;
  workspaceRoot?: string;
  /** install-task를 실행한 셸의 PATH */
  path: string;
}

/** 서버의 인자 (Node가 받는 그대로 — 진입점부터). task.ts taskArguments와 같은 차례 */
export function unitArgv(i: Omit<UnitInputs, 'path'>): string[] {
  const argv = [i.entry, 'serve', '--data-dir', i.dataDir];
  if (i.webDir) argv.push('--web-dir', i.webDir);
  if (i.port !== undefined) argv.push('--port', String(i.port));
  if (i.configPath) argv.push('--config', i.configPath);
  if (i.ownerEmail) argv.push('--owner-email', i.ownerEmail);
  if (i.publicOrigin) argv.push('--public-origin', i.publicOrigin);
  if (i.workspaceRoot) argv.push('--workspace-root', i.workspaceRoot);
  return argv;
}

/** 유닛 글로 넣을 수 없는 값의 글 (아니면 null) */
export function unitValueProblem(i: UnitInputs): string | null {
  const values: [string, string | undefined | null][] = [
    ['Node 실행 파일', i.nodePath],
    ['서버 진입점', i.entry],
    ['앱 폴더', i.appRoot],
    ['데이터 폴더', i.dataDir],
    ['--web-dir', i.webDir],
    ['--config', i.configPath],
    ['--workspace-root', i.workspaceRoot],
    ['--owner-email', i.ownerEmail],
    ['--public-origin', i.publicOrigin],
    ['PATH', i.path],
  ];
  for (const [what, v] of values) {
    if (!v) continue;
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(v)) return `${what}에 제어 문자(줄바꿈 등)가 있어 유닛에 넣지 않습니다 — 그런 글자가 없는 값을 쓰세요`;
    if (Buffer.from(v, 'utf8').toString('utf8') !== v) return `${what}에 UTF-8로 쓸 수 없는 글자가 있어 유닛에 넣지 않습니다`;
  }
  // ExecStart의 실행 파일 이름은 systemd가 따옴표·역슬래시를 받지 않고('Executable name contains special characters' — WSL의 systemd 255에서 확인), 그 낱말은
  // argv[0]이기도 해 $가 실행 때 펼쳐진다 — 그런 글자가 든 Node 경로는 받지 않는다
  if (/["'\\$]/.test(i.nodePath)) return `Node 실행 파일 경로(${i.nodePath})에 systemd가 실행 파일 이름으로 받지 않는 글자(" ' \\ $)가 있습니다 — 그런 글자가 없는 폴더의 Node로 install-task를 다시 하세요`;
  // WorkingDirectory=는 따옴표를 풀지 않는다 — 앞뒤 빈칸은 systemd가 지우고, 끝의 역슬래시는 다음 줄로 잇는다
  if (/^\s|\s$|\\$/.test(i.appRoot)) return `앱 폴더(${i.appRoot})가 빈칸으로 시작하거나 끝나거나 역슬래시로 끝나 유닛의 WorkingDirectory=에 그대로 넣을 수 없습니다 — 저장소를 다른 폴더에 두세요`;
  for (const [what, v] of [['Node 실행 파일', i.nodePath], ['서버 진입점', i.entry], ['데이터 폴더', i.dataDir], ['앱 폴더', i.appRoot]] as const) {
    if (!posix.isAbsolute(v)) return `${what}가 절대 경로가 아닙니다: ${v}`;
  }
  return null;
}

/** 리드 결정 S10-6.2의 유닛 글 (줄 끝 LF) */
export function unitText(i: UnitInputs): string {
  return [
    UNIT_HEADER,
    '[Unit]',
    `Description=${systemdPlain(`욱채 서버 (${i.dataDir})`)}`,
    '# 사용자 유닛은 시스템의 network-online.target을 기다릴 수 없습니다 — 서버는 이 PC 안(루프백)만 엽니다',
    'StartLimitIntervalSec=600',
    'StartLimitBurst=4',
    '',
    '[Service]',
    'Type=exec',
    `WorkingDirectory=${systemdPlain(i.appRoot)}`,
    `ExecStart=${[i.nodePath, ...unitArgv(i)].map(systemdExecWord).join(' ')}`,
    '# install-task를 실행한 셸의 PATH — 사용자 유닛의 기본 PATH에는 ~/.local/bin·nvm이 없습니다 (claude·codex·git·node)',
    `Environment=${systemdEnvAssignment('PATH', i.path)}`,
    'UMask=0077',
    '# 끌 때 서버에만 SIGTERM — 서버가 턴을 차례로 끝낸 뒤, 남은 프로세스는 systemd가 SIGKILL로 끝냅니다',
    'KillMode=mixed',
    'TimeoutStopSec=45',
    'Restart=on-failure',
    'RestartSec=60',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

// ───────────────────────── 유닛 파일 읽기 (check) ─────────────────────────

/**
 * systemd의 따옴표 낱말 규칙으로 한 줄을 나눈다 (extract_first_word UNQUOTE|CUNESCAPE): 빈칸으로 나누고, 큰·작은따옴표 안은 한 낱말, 역슬래시는 C 이스케이프
 * (`\\ \" \' \n \t \xNN` …). 닫지 않은 따옴표는 null. 지정자(`%%`)·변수(`$$`)는 그다음에 푼다(execWords)
 */
export function splitSystemdWords(line: string): string[] | null {
  const out: string[] = [];
  let i = 0;
  const n = line.length;
  const ESC: Record<string, string> = { a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', '"': '"', "'": "'", s: ' ' };
  for (;;) {
    while (i < n && /\s/.test(line[i]!)) i++;
    if (i >= n) return out;
    let word = '';
    let quote: '"' | "'" | null = null;
    for (; i < n; i++) {
      const c = line[i]!;
      if (c === '\\') {
        const e = line[i + 1];
        if (e === undefined) return null;
        if (e === 'x' && /^[0-9a-fA-F]{2}$/.test(line.slice(i + 2, i + 4))) {
          word += String.fromCharCode(parseInt(line.slice(i + 2, i + 4), 16));
          i += 3;
          continue;
        }
        word += ESC[e] ?? e;
        i++;
        continue;
      }
      if (quote) {
        if (c === quote) quote = null;
        else word += c;
        continue;
      }
      if (c === '"' || c === "'") {
        quote = c;
        continue;
      }
      if (/\s/.test(c)) break;
      word += c;
    }
    if (quote) return null;
    out.push(word);
  }
}

/** ExecStart= 값 → Node가 받는 argv (따옴표·C 이스케이프, `%%`→`%`, `$$`→`$`). 앞의 실행 접두(`-@:+!`)는 떼고 알린다 */
export function execWords(value: string): { argv: string[]; prefix: string } | null {
  const m = /^([-@:+!]*)(.*)$/s.exec(value.trim())!;
  const words = splitSystemdWords(m[2]!.replace(/%%/g, '\u0000'));
  if (!words) return null;
  return { prefix: m[1]!, argv: words.map((w) => w.replace(/\u0000/g, '%').replace(/\$\$/g, '$')) };
}

/** 유닛 파일에서 [Service]의 칸 (같은 이름이 여럿이면 모두 — ExecStart=가 둘이면 check가 알린다). 다음 줄로 잇는 줄(끝 `\`)은 이어 붙인다 */
export function parseUnitFile(text: string): { service: Record<string, string[]>; sections: string[] } {
  const service: Record<string, string[]> = {};
  const sections: string[] = [];
  let section = '';
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  for (let k = 0; k < lines.length; k++) {
    let line = lines[k]!;
    while (line.endsWith('\\') && k + 1 < lines.length) line = `${line.slice(0, -1)} ${lines[++k]!}`;
    const t = line.trim();
    if (!t || t.startsWith('#') || t.startsWith(';')) continue;
    const sec = /^\[(.+)\]$/.exec(t);
    if (sec) {
      section = sec[1]!;
      sections.push(section);
      continue;
    }
    const eq = t.indexOf('=');
    if (eq < 0 || section !== 'Service') continue;
    const key = t.slice(0, eq).trim();
    (service[key] ??= []).push(t.slice(eq + 1).trim());
  }
  return { service, sections };
}

/** Environment= 값들 → 이름=값 (따옴표·C 이스케이프, `%%`→`%`) */
export function envAssignments(values: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const v of values) {
    for (const w of splitSystemdWords(v.replace(/%%/g, '\u0000')) ?? []) {
      const eq = w.indexOf('=');
      if (eq > 0) out[w.slice(0, eq)] = w.slice(eq + 1).replace(/\u0000/g, '%');
    }
  }
  return out;
}

// ───────────────────────── systemctl ─────────────────────────

/** `systemctl show`의 `이름=값` 줄들 → 칸 (여러 유닛이면 빈 줄로 나뉜 덩어리마다) */
export function parseShow(text: string): Record<string, string>[] {
  const blocks: Record<string, string>[] = [];
  let cur: Record<string, string> | null = null;
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    if (!line.trim()) {
      cur = null;
      continue;
    }
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    if (!cur) blocks.push((cur = {}));
    cur[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return blocks;
}

/** show의 ExecStart 칸에서 argv[] (공백으로 이은 글 그대로 — systemctl이 그렇게 낸다) */
export function showArgv(execStart: string | undefined): string | null {
  return /argv\[\]=(.*?) ; ignore_errors=/.exec(execStart ?? '')?.[1] ?? null;
}

/** 읽어 볼 칸 */
export const SHOW_PROPS = ['LoadState', 'FragmentPath', 'DropInPaths', 'UnitFileState', 'KillMode', 'WorkingDirectory', 'ExecStart', 'ActiveState'] as const;
export const showArgs = (name: string): string[] => ['--user', 'show', name, ...SHOW_PROPS.flatMap((p) => ['-p', p])];

const runText = (r: ExecResult): string => r.error ?? (r.timedOut ? '15초 안에 끝나지 않음' : `끝 코드 ${r.code}`);

/** 사용자 관리자의 환경 (`systemctl --user show-environment`) — 닿지 못하면 null */
export async function readManagerEnv(run: TaskRunner, env: NodeJS.ProcessEnv): Promise<Record<string, string> | null> {
  if (!env['XDG_RUNTIME_DIR']) return null;
  const r = await run('systemctl', ['--user', 'show-environment']);
  if (r.code !== 0) return null;
  const out: Record<string, string> = {};
  for (const line of r.stdout.toString('utf8').split('\n')) {
    const eq = line.indexOf('=');
    // $'…' 꼴(특수 글자를 셸 꼴로 낸 값)은 그대로 쓰지 않는다
    if (eq > 0 && !line.slice(eq + 1).startsWith("$'")) out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

/**
 * 유닛 파일을 둘 폴더 — 사용자 관리자가 읽는 자리: 그 관리자의 XDG_CONFIG_HOME(절대 경로일 때), 아니면 그 관리자의 HOME(없으면 이 셸의 홈) 아래 .config/systemd/user.
 * 이 셸의 HOME·XDG_CONFIG_HOME이 관리자의 것과 달라도(바꾼 셸) 관리자가 보는 자리에 쓴다 — 다시 읽기의 FragmentPath가 한 번 더 본다
 */
export function unitDirOf(managerEnv: Record<string, string> | null, home: string): string {
  const abs = (v: string | undefined): string | null => (v && posix.isAbsolute(v) ? v : null);
  const base = abs(managerEnv?.['XDG_CONFIG_HOME']) ?? posix.join(abs(managerEnv?.['HOME']) ?? home, '.config');
  return posix.join(base, 'systemd', 'user');
}

/** POSIX 작은따옴표 (고칠 줄·다음 할 일 — 셸이 아무것도 바꾸지 않는다) */
export const shQuote = (s: string): string => (/^[A-Za-z0-9_./:=@%+,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

// ───────────────────────── 명령 ─────────────────────────

export interface UnitCommandDeps {
  /** systemctl (리드 결정 S10-6.2 — 주입할 수 있는 실행기) */
  run: TaskRunner;
  /** process.getuid() */
  uid: number | null;
  /** 사용자 이름 (linger 줄) */
  user: string;
  home: string;
  env: NodeJS.ProcessEnv;
  appRoot: string;
  nodePath: string;
  /** 파일이 있는지 (linger 파일) */
  exists: (path: string) => boolean;
  /** 웹 화면 폴더 고르기 (task.ts와 같은 것) */
  chooseWebDir: (flag: string | undefined, appRoot: string) => { webDir: string | null; warning: string | null; refusal: string | null };
  /** 유닛 파일 쓰기·읽기·지우기 (기본 fs — 시험이 임시 폴더로) */
  fs?: { write(path: string, text: string): void; read(path: string): string | null; remove(path: string): boolean; list?(dir: string): string[] };
}

export function defaultUnitDeps(o: { appRoot: string; nodePath: string; run: TaskRunner; chooseWebDir: UnitCommandDeps['chooseWebDir'] }): UnitCommandDeps {
  let user = '';
  try {
    user = userInfo().username;
  } catch {
    user = process.env['USER'] ?? '';
  }
  return {
    run: o.run,
    uid: typeof process.getuid === 'function' ? process.getuid() : null,
    user,
    home: homedir(),
    env: process.env,
    appRoot: o.appRoot,
    nodePath: o.nodePath,
    exists: existsSync,
    chooseWebDir: o.chooseWebDir,
  };
}

/** 유닛 파일 쓰기 — 옆 임시 파일(0600, wx) → 제자리로. 폴더가 없으면 만든다(0700) */
export const realUnitFs: NonNullable<UnitCommandDeps['fs']> = {
  write(path, text) {
    mkdirSync(posix.dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.tmp-${randomBytes(4).toString('hex')}`;
    try {
      writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      chmodSync(tmp, 0o600);
      renameSync(tmp, path);
    } catch (error) {
      try {
        unlinkSync(tmp);
      } catch {
        // 이미 없다
      }
      throw error;
    }
  },
  read(path) {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return null;
    }
  },
  list(dir) {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  },
  remove(path) {
    try {
      unlinkSync(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  },
};

export interface UnitCommandResult {
  code: number;
  out: string;
  err: string;
  json: { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } };
}

const fail = (code: number, errCode: string, message: string): UnitCommandResult => ({ code, out: '', err: `${message}\n`, json: { ok: false, error: { code: errCode, message } } });

/** linger가 켜져 있는지 — /var/lib/systemd/linger/<사용자> (logind가 두는 파일, 읽기만) */
export const lingerFile = (user: string): string => posix.join('/var/lib/systemd/linger', user);

/** 등록한 유닛을 다시 읽어 쓴 것과 다른 점 (없으면 빈 목록) */
export function compareUnit(want: { file: string; text: string; argv: string[]; appRoot: string }, got: { text: string | null; show: Record<string, string> }): string[] {
  const diffs: string[] = [];
  const s = got.show;
  if (got.text !== want.text) diffs.push('유닛 파일의 글');
  if (s['LoadState'] !== 'loaded') diffs.push(`LoadState(${s['LoadState'] ?? '없음'})`);
  if (s['FragmentPath'] !== want.file) diffs.push(`FragmentPath(${s['FragmentPath'] || '없음'})`);
  if ((s['DropInPaths'] ?? '').trim()) diffs.push(`덧붙인 설정(drop-in: ${s['DropInPaths']}) — ExecStart 등을 바꿀 수 있습니다`);
  if (s['UnitFileState'] !== 'enabled') diffs.push(`UnitFileState(${s['UnitFileState'] || '없음'})`);
  if (s['KillMode'] !== 'mixed') diffs.push(`KillMode(${s['KillMode'] ?? '없음'})`);
  if (s['WorkingDirectory'] !== want.appRoot) diffs.push('WorkingDirectory');
  // systemd는 유닛 파일의 $$를 실행할 때 $로 펼친다 — 그 전의 argv(show가 내는 것)에는 $$가 남아 있을 수 있다(systemd --user --test 덤프에서 확인). 둘 다 같은 값이다
  const shown = showArgv(s['ExecStart']);
  if (shown !== want.argv.join(' ') && shown !== want.argv.map((a) => a.replace(/\$/g, '$$$$')).join(' ')) diffs.push('ExecStart');
  return diffs;
}

/** install-task (Linux) */
export async function installUnit(o: { dataDir: string; flags: TaskFlags; dryRun: boolean }, deps: UnitCommandDeps): Promise<UnitCommandResult> {
  if (deps.uid === 0) return fail(1, 'root', UNIT_ROOT_REFUSAL);
  const fs = deps.fs ?? realUnitFs;
  const entry = posix.join(deps.appRoot, 'out', 'server', 'index.mjs');
  if (!deps.exists(entry)) return fail(1, 'no_entry', `서버 진입점이 없습니다: ${entry} — 저장소 폴더에서 npm run build:server를 한 뒤 다시 하세요`);
  const web = deps.chooseWebDir(o.flags.webDir, deps.appRoot);
  if (web.refusal) return fail(1, 'web_dir', web.refusal.replace('(작업은 등록하지 않았습니다)', '(유닛은 등록하지 않았습니다)'));
  const abs = (p: string): string => posix.resolve(p);
  const inputs: UnitInputs = {
    dataDir: abs(o.dataDir),
    nodePath: deps.nodePath,
    entry,
    appRoot: deps.appRoot,
    webDir: web.webDir,
    ...(o.flags.port !== undefined ? { port: o.flags.port } : {}),
    ...(o.flags.configPath ? { configPath: abs(o.flags.configPath) } : {}),
    ...(o.flags.ownerEmail ? { ownerEmail: o.flags.ownerEmail } : {}),
    ...(o.flags.publicOrigin ? { publicOrigin: o.flags.publicOrigin } : {}),
    ...(o.flags.workspaceRoot ? { workspaceRoot: abs(o.flags.workspaceRoot) } : {}),
    path: deps.env['PATH'] ?? '',
  };
  const bad = unitValueProblem(inputs);
  if (bad) return fail(1, 'bad_value', bad);
  if (!inputs.path) return fail(1, 'no_path', '이 셸에 PATH가 없어 유닛에 넣을 PATH를 정하지 못했습니다 — 보통의 로그인 셸에서 실행하세요');
  const managerEnv = await readManagerEnv(deps.run, deps.env);
  if (!managerEnv) return fail(1, 'no_user_bus', NO_USER_BUS);
  const name = unitName(inputs.dataDir);
  const file = posix.join(unitDirOf(managerEnv, deps.home), name);
  const text = unitText(inputs);
  const argv = [inputs.nodePath, ...unitArgv(inputs)];
  const commands = [
    ['systemctl', '--user', 'daemon-reload'],
    ['systemctl', '--user', 'enable', name],
    ['systemctl', ...showArgs(name)],
  ];
  const lingerOn = deps.exists(lingerFile(deps.user));
  const warnings = web.warning ? [web.warning.replace('install-task를 다시 하세요', 'install-task를 다시 하세요 (유닛을 바꿔 넣습니다)')] : [];
  const summary = [
    `  Node          ${inputs.nodePath}`,
    `  서버 진입점   ${inputs.entry}`,
    `  데이터 폴더   ${inputs.dataDir}`,
    `  웹 화면       ${inputs.webDir ?? '없음'}`,
    `  유닛 파일     ${file}`,
    `  PATH          ${inputs.path}`,
    `  실행 계정     ${deps.user} (사용자 유닛 — 로그인할 때${lingerOn ? '와 부팅할 때(linger 켜짐)' : '만 — linger가 꺼져 있어 부팅만으로는 뜨지 않습니다'}, root 없이)`,
  ];
  const lingerLine = lingerOn ? [] : [`  부팅할 때도   sudo loginctl enable-linger ${shQuote(deps.user)}  (관리자 권한이 드는 한 번 — 이 명령은 그것을 부르지 않습니다)`];
  if (o.dryRun) {
    return {
      code: 0,
      out: [
        `[시험 실행 — 아무것도 바꾸지 않았습니다] 등록할 사용자 유닛: ${name}`,
        ...summary,
        ...warnings.map((w) => `  경고          ${w}`),
        '실행할 명령 (유닛 파일을 0600으로 쓴 뒤)',
        ...commands.map((c) => `  ${c.join(' ')}`),
        '유닛 파일',
        text.trimEnd(),
        '',
      ].join('\n'),
      err: '',
      json: { ok: true, result: { dryRun: true, name, file, text, commands, unit: { ...inputs, argv }, linger: lingerOn, warnings } },
    };
  }
  try {
    fs.write(file, text);
  } catch (error) {
    return fail(1, 'write', `유닛 파일을 쓰지 못했습니다 (${file} — ${(error as NodeJS.ErrnoException).code ?? (error as Error).message})`);
  }
  for (const c of commands.slice(0, 2)) {
    const r = await deps.run('systemctl', c.slice(1));
    if (r.code !== 0) return fail(1, 'systemctl', `${c.join(' ')}에 실패했습니다 (${runText(r)}) — 유닛 파일(${file})은 썼습니다. install-task를 다시 하거나 uninstall-task로 지우세요`);
  }
  const shown = await deps.run('systemctl', showArgs(name));
  if (shown.code !== 0) return fail(1, 'readback', `등록한 유닛을 다시 읽지 못했습니다 (systemctl --user show ${runText(shown)}) — systemctl --user status ${name}으로 확인하세요`);
  const diffs = compareUnit({ file, text, argv, appRoot: inputs.appRoot }, { text: fs.read(file), show: parseShow(shown.stdout.toString('utf8'))[0] ?? {} });
  if (diffs.length) return fail(1, 'mismatch', `등록한 유닛이 쓴 것과 다릅니다 (${diffs.join(', ')}) — systemctl --user cat ${name}으로 확인하거나 install-task를 다시 하세요`);
  const q = shQuote(inputs.dataDir);
  return {
    code: 0,
    out: [
      `systemd 사용자 유닛을 등록했습니다: ${name}`,
      ...summary,
      ...warnings.map((w) => `  경고          ${w}`),
      '다음 할 일',
      `  지금 띄우기   systemctl --user start ${name}`,
      `  확인          wook-server status --data-dir ${q}`,
      `  기록          journalctl --user -u ${name}`,
      `  끄기          wook-server shutdown --data-dir ${q} (유닛을 지워도 실행 중인 서버는 그대로입니다)`,
      ...lingerLine,
      '',
    ].join('\n'),
    err: '',
    json: { ok: true, result: { dryRun: false, name, file, registered: true, unit: { ...inputs, argv }, linger: lingerOn, warnings } },
  };
}

/**
 * uninstall-task (Linux) — 이 데이터 폴더의 유닛을 모두 지운다: 지금 이름(unitName)과, 같은 폴더를 가리키는 install-task의 유닛 파일이 다른 이름으로 있으면 그것도
 * (리드 결정 S10-13 SH-2 — 데이터 폴더가 생기기 전에 등록했거나 경로의 링크가 바뀐 경우). 먼저 모두 읽고(하나라도 읽지 못하거나 다른 자리의 같은 이름이면 아무것도
 * 지우지 않는다), 그다음 disable → 파일 지우기 → daemon-reload 한 번 → 모두 다시 읽기
 */
export async function uninstallUnit(o: { dataDir: string; dryRun: boolean }, deps: UnitCommandDeps): Promise<UnitCommandResult> {
  if (deps.uid === 0) return fail(1, 'root', UNIT_ROOT_REFUSAL);
  const fs = deps.fs ?? realUnitFs;
  const dataDir = posix.resolve(o.dataDir);
  const name = unitName(dataDir);
  const managerEnv = await readManagerEnv(deps.run, deps.env);
  if (!managerEnv) return fail(1, 'no_user_bus', NO_USER_BUS);
  const unitDir = unitDirOf(managerEnv, deps.home);
  const fileOf = (n: string): string => posix.join(unitDir, n);
  const others = unitsForDataDir(dataDir, unitDir, { list: (d) => fs.list?.(d) ?? [], read: (f) => fs.read(f) }).filter((n) => n !== name);
  const names = [name, ...others];
  const commands = names.flatMap((n) => [
    ['systemctl', ...showArgs(n)],
    ['systemctl', '--user', 'disable', n],
    ['rm', fileOf(n)],
  ]);
  commands.push(['systemctl', '--user', 'daemon-reload']);
  if (o.dryRun) {
    return {
      code: 0,
      out: [
        `[시험 실행 — 아무것도 바꾸지 않았습니다] 지울 사용자 유닛: ${names.join(', ')}${others.length ? ' (같은 데이터 폴더를 가리키는 다른 이름의 유닛 포함)' : ''}`,
        '실행할 명령',
        ...commands.map((c) => `  ${c.join(' ')}${c[1] === '--user' && c[2] === 'show' ? '  (유닛이 있는지 읽습니다 — 지운 뒤에도 한 번 더)' : ''}`),
        '',
      ].join('\n'),
      err: '',
      json: { ok: true, result: { dryRun: true, name, names, file: fileOf(name), commands } },
    };
  }
  const read = async (n: string): Promise<Record<string, string> | null> => {
    const r = await deps.run('systemctl', showArgs(n));
    return r.code === 0 ? (parseShow(r.stdout.toString('utf8'))[0] ?? {}) : null;
  };
  // 먼저 모두 읽는다 — 하나라도 읽지 못하거나 install-task의 자리가 아니면 아무것도 지우지 않는다
  const present: string[] = [];
  for (const n of names) {
    const before = await read(n);
    if (!before) return fail(1, 'readback', `유닛이 있는지 읽지 못해 지우지 않았습니다 — systemctl --user status ${n}으로 확인하세요`);
    if (before['LoadState'] === 'not-found' && fs.read(fileOf(n)) === null) continue;
    const fragment = before['FragmentPath'] ?? '';
    if (fragment && fragment !== fileOf(n)) return fail(1, 'not_ours', `${n}은 install-task가 쓴 자리(${fileOf(n)})가 아닌 ${fragment}에 있습니다 — 아무것도 지우지 않았습니다`);
    present.push(n);
  }
  if (!present.length) {
    return { code: 0, out: `등록된 유닛이 없습니다 (${name}) — 바꾼 것이 없습니다\n`, err: '', json: { ok: true, result: { dryRun: false, name, names: [], existed: false, removed: false } } };
  }
  for (const n of present) {
    const dis = await deps.run('systemctl', ['--user', 'disable', n]);
    if (dis.code !== 0) return fail(1, 'systemctl', `systemctl --user disable ${n}에 실패했습니다 (${runText(dis)})${present[0] === n ? ' — 아무것도 지우지 않았습니다' : ''}`);
    try {
      fs.remove(fileOf(n));
    } catch (error) {
      return fail(1, 'remove', `유닛 파일(${fileOf(n)})을 지우지 못했습니다 (${(error as NodeJS.ErrnoException).code ?? (error as Error).message}) — 유닛은 꺼 두었습니다(disable)`);
    }
  }
  const reload = await deps.run('systemctl', ['--user', 'daemon-reload']);
  if (reload.code !== 0) return fail(1, 'systemctl', `systemctl --user daemon-reload에 실패했습니다 (${runText(reload)}) — 유닛 파일은 지웠습니다`);
  for (const n of present) {
    const after = await read(n);
    if (!after) return fail(1, 'readback', `유닛을 지운 뒤 없어졌는지 읽지 못했습니다 — systemctl --user status ${n}으로 확인하세요`);
    // 지웠다: systemd가 그 유닛을 모르거나(not-found), 돌고 있어 아직 들고 있더라도 켜져 있지 않고(enable 아님) 파일이 없다 — 다음 부팅·로그인에 뜨지 않는다
    const gone = after['LoadState'] === 'not-found' || (after['UnitFileState'] !== 'enabled' && fs.read(fileOf(n)) === null);
    if (!gone) return fail(1, 'still_there', `유닛을 지웠다고 했지만 아직 있습니다 (${n}: LoadState ${after['LoadState']}, UnitFileState ${after['UnitFileState'] || '없음'}) — systemctl --user cat ${n}으로 확인하세요`);
  }
  const q = shQuote(dataDir);
  return {
    code: 0,
    out: `사용자 유닛 ${present.join(', ')}을 지웠습니다. 실행 중인 서버는 끄지 않았습니다 — 끄려면 wook-server shutdown --data-dir ${q}\n`,
    err: '',
    json: { ok: true, result: { dryRun: false, name, names: present, existed: true, removed: true } },
  };
}
