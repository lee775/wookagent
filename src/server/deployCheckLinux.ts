/**
 * 배포 점검 `wook-server check [--json] [--dry-run]`의 Linux 쪽 (SERVER_DESIGN 10.10, 리드 결정 S10-6.3). 아무것도 바꾸지 않는다 — 고칠 길(fix)은 글로만 준다.
 * 항목은 순수 함수(linuxDeployItems)가 사실(LinuxFacts)에서 만든다. 사실을 모으는 쪽(gatherLinuxDeploy)은 작다: 파일 읽기(/proc·유닛 파일·linger·데이터
 * 폴더의 stat), 셸 없이 짧은 상한의 읽기 명령(systemctl --user show-environment·show <유닛>, systemctl show <절전 대상>, tailscale status·serve status), CLI 상태
 * 명령(claude auth status --json · codex login status — 유닛의 PATH로). 서버가 돌면 그 status·config show도 본다(관리 채널).
 * 항목 (S10-6.3, 서버 셸 조사 §7.5): user, proc, procps, node, unit, linger, dataDir, secrets, sleep, power, cli.claude, cli.codex, path, apikey-env,
 *   [screen — 화면 갈래 S10c가 넣는 자리, 아래 linuxDeployItems의 표시], adminSocket, tailscale. 고칠 줄은 POSIX 작은따옴표로 감싼다(셸이 아무것도 바꾸지 않는다).
 * 결과 모양은 Windows와 같다(DeployReport — 표·요약·status의 deploy·--json). 서버는 준비된 뒤 한 번 돌린다(startDeployCheck — 시험 중에는 돌리지 않는다)
 */
import { execFile } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { delimiter, join, posix } from 'node:path';
import type { AiKind } from '@shared/domain';
import type { ApiKeyState, BackendOperatorStatus } from '../main/backend/types';
import { fileSecretStoreProblem, fileStoreText, secretsDirOf } from '../main/auth/fileSecretStore';
import { operatorRequest } from './admin';
import type { AdminPipeInfo } from './adminPipe';
import { readServerConfig, serverConfigPath, type ServerConfigFile, type ServerConfigView } from './config';
import { screenSession } from '../main/desktop/screenSession';
import { x11ScreenCheck, type X11CheckFacts } from '../main/desktop/x11Check';
import { findSystemTool, resolveX11Tools } from '../main/desktop/x11Launcher';
import { API_KEY_ENV_NAMES, cliItem, deployCounts, formatCheck, probeCli, readTailscale, type CliProbe, type DeployItem, type DeployItemId, type DeployLevel, type DeployReport } from './deployCheck';
import type { ServerPowerStatus } from './power';
import type { AdminStatus } from './server';
import { dataDirPathProblem, dataDirPathProblemText, type DataDirPathProblem } from './dataDir';
import { procProblem } from './serveLinux';
import { appRootFrom, TASK_ARG_FLAGS } from './task';
import { envAssignments, execWords, lingerFile, parseShow, parseUnitFile, shQuote, showArgs, unitDirOf, unitName, unitsForDataDir } from './unit';

/** 명령 하나의 상한 (리드 결정 S10-6.3 '짧은 상한') */
export const LINUX_EXEC_TIMEOUT_MS = 4_000;
/** CLI 상태 확인 하나의 상한 (Windows와 같다) */
const CLI_TIMEOUT_MS = 15_000;
/** 절전 대상 — 서버에서는 막아 둔다(mask) */
export const SLEEP_TARGETS = ['sleep.target', 'suspend.target', 'hibernate.target', 'hybrid-sleep.target'] as const;
/** 서버 기본 포트 (server.ts DEFAULT_PORT) */
const DEFAULT_PORT = 7317;

// ───────────────────────── 고칠 줄 ─────────────────────────

/** 고칠 길 명령의 낱말: 글 그대로(제품이 정한 낱말·숫자) 또는 감쌀 값 */
export type PosixWord = string | { value: string };

/** 고칠 길의 wook-server 명령 — 늘 점검한 데이터 폴더를 붙이고(S9-22 DF-1), 값은 POSIX 작은따옴표로 감싼다(어떤 글자든 셸이 바꾸지 않는다) */
export function wookServerCommandPosix(command: string, dataDir: string, extra: readonly PosixWord[] = []): string {
  return ['wook-server', command, ...extra.map((w) => (typeof w === 'string' ? w : shQuote(w.value))), '--data-dir', shQuote(dataDir)].join(' ');
}

// ───────────────────────── 사실 ─────────────────────────

/** 실행 중인 서버에서 읽은 것 */
export interface LinuxServerView {
  adminPipe: AdminPipeInfo | null;
  power: ServerPowerStatus | null;
  secretStore: BackendOperatorStatus['secretStore'] | null;
  screen: { ok: boolean; detail: string } | null;
  port: number;
}

export interface LinuxFacts {
  dataDir: string;
  uid: number | null;
  user: string;
  /** /proc 확인의 문제 (S10a linuxProcProblem — serveLinux.procProblem) */
  proc: string | null;
  /** PATH에서 찾은 실행 파일 (없으면 null) */
  tools: { ps: string | null; pgrep: string | null; inhibit: string | null; tailscale: string | null };
  nodeVersion: string;
  /** 지금 install-task가 쓸 것 가운데 인자에 기대지 않는 것 */
  expected: { name: string; file: string; nodePath: string; entry: string };
  /** 유닛 — text는 우리 자리의 파일(없으면 null), show는 systemctl --user show(읽지 못했으면 null과 그 까닭) */
  unit: { text: string | null; show: Record<string, string> | null; error: string | null; others?: string[] };
  linger: boolean | null;
  /** 데이터 폴더의 stat — 링크면 따라간 폴더의 것과 그 실제 경로(link) (S10-13 SH-1, 서버도 따라간다). 없으면 null */
  dataDirStat: { uid: number; mode: number; isDirectory: boolean; link?: string | null } | { error: string; pathProblem?: DataDirPathProblem } | null;
  /** 비밀 값 폴더의 문제 (fileSecretStoreProblem) */
  secretsProblem: string | null;
  /** 절전 대상의 LoadState (읽지 못했으면 error) */
  sleep: { id: string; load: string }[] | { error: string };
  cli: Record<AiKind, CliProbe>;
  apiKeys: Record<AiKind, ApiKeyState> | null;
  /** 환경 변수 이름 — 이 프로세스, 사용자 관리자(show-environment — 못 읽으면 null) */
  envNames: { process: string[]; manager: string[] | null };
  /** claude·codex·git·node를 이 셸의 PATH에서 찾은 자리 (없으면 null) */
  found: Record<'claude' | 'codex' | 'git' | 'node', string | null>;
  tailscale: { status: string | null; serve: string | null; timedOut: boolean };
  server: LinuxServerView | null;
  /** 화면 조작의 사실 (S10c, 리드 결정 S10-7.12 — x11ScreenCheck). 서버의 상태는 server.screen에 있다. 없으면(모으지 않음) 서버의 상태만 본다 */
  screen?: Omit<X11CheckFacts, 'server'>;
}

const item = (id: DeployItemId, level: DeployLevel, text: string, fix: string | null = null): DeployItem => ({ id, level, text, fix: level === 'ok' || level === 'skip' ? null : fix });
const octal = (mode: number): string => (mode & 0o777).toString(8).padStart(3, '0');

/** 유닛 파일에서 읽은 것 — ExecStart argv·PATH·Environment 이름 (파일이 없거나 틀리면 null 칸) */
export function unitFileView(text: string | null): { argv: string[] | null; execCount: number; env: Record<string, string>; header: boolean } {
  if (text === null) return { argv: null, execCount: 0, env: {}, header: false };
  const u = parseUnitFile(text);
  const execs = u.service['ExecStart'] ?? [];
  const parsed = execs.length ? execWords(execs[execs.length - 1]!) : null;
  return { argv: parsed?.argv ?? null, execCount: execs.length, env: envAssignments(u.service['Environment'] ?? []), header: text.startsWith('# wook-server install-task') };
}

/** 유닛 PATH (유닛 파일의 Environment=PATH — 없으면 null) */
export const unitPathOf = (text: string | null): string | null => unitFileView(text).env['PATH'] ?? null;

// ───────────────────────── 항목 ─────────────────────────

function userItem(f: LinuxFacts): DeployItem {
  if (f.uid === 0) return item('user', 'fail', 'root(uid 0)로 돕니다 — 서버는 root로 띄우지 않습니다(메인 에이전트의 Claude Code가 root를 거부하고, root의 서버는 이 PC 전체를 쥡니다)', '서버를 돌릴 로그인 사용자로, sudo 없이 다시 점검하세요');
  if (f.uid !== null && f.uid < 1000) return item('user', 'warn', `시스템 계정(${f.user}, uid ${f.uid})으로 돕니다 — 로그인 사용자의 서버가 아닙니다`, '서버를 돌릴 로그인 사용자로 다시 점검하세요');
  return item('user', 'ok', `${f.user} (uid ${f.uid ?? '?'})`);
}

function procItem(f: LinuxFacts): DeployItem {
  if (f.proc) return item('proc', 'fail', `${f.proc}`, '/proc이 마운트된 보통의 Linux에서 돌리세요 — 컨테이너는 지원하지 않습니다 (SERVER_SETUP)');
  return item('proc', 'ok', '/proc을 읽을 수 있습니다 (실행 잠금·정지 확인)');
}

function procpsItem(f: LinuxFacts): DeployItem {
  const missing = [f.tools.ps ? null : 'ps', f.tools.pgrep ? null : 'pgrep'].filter(Boolean);
  if (missing.length) return item('procps', 'warn', `${missing.join('·')}이 PATH에 없습니다 — 서버는 /proc으로 보지만 운영자의 확인 명령(ps·pgrep)을 쓸 수 없습니다`, 'sudo apt install procps');
  return item('procps', 'ok', `${f.tools.ps}, ${f.tools.pgrep}`);
}

function nodeItem(f: LinuxFacts): DeployItem {
  const major = Number(/^v?(\d+)/.exec(f.nodeVersion)?.[1] ?? '0');
  if (major >= 24) return item('node', 'ok', `Node ${f.nodeVersion}`);
  return item('node', 'fail', `Node ${f.nodeVersion} — 24 이상이어야 합니다 (node:sqlite)`, `NodeSource나 nvm으로 Node 24 이상을 깐 뒤 유닛을 다시 등록하세요 (유닛은 Node의 절대 경로를 적어 둡니다): ${wookServerCommandPosix('install-task', f.dataDir)}`);
}

/** 유닛의 argv를 install-task가 쓰는 꼴과 견준다 — 시험용 세션은 따로, 옵션은 다시 등록하는 명령에 옮긴다 (task.ts taskArgvProblems의 Linux 쪽) */
export function unitArgvProblems(argv: readonly string[], want: { nodePath: string; entry: string; dataDir: string }): { testSession: boolean; problems: string[]; options: [string, string][] } {
  const isTest = (a: string): boolean => a === '--allow-test-session' || a.startsWith('--allow-test-session=');
  const testSession = argv.some(isTest);
  const problems: string[] = [];
  const options: [string, string][] = [];
  if (argv[0] !== want.nodePath) problems.push(`Node가 지금 것과 다릅니다 (${argv[0] ?? '없음'})`);
  if (argv[1] !== want.entry) problems.push(`서버 진입점이 지금 것과 다릅니다 (${argv[1] ?? '없음'})`);
  if (argv[2] !== 'serve') problems.push('serve로 띄우지 않습니다');
  if (argv[3] !== '--data-dir' || argv[4] !== want.dataDir) problems.push(`데이터 폴더가 지금 것과 다릅니다 (${argv[3] === '--data-dir' ? (argv[4] ?? '없음') : '--data-dir 없음'})`);
  const extra: string[] = [];
  const seen = new Set<string>();
  for (let k = 5; k < argv.length; k++) {
    const a = argv[k]!;
    if (isTest(a)) continue;
    const value = argv[k + 1];
    if (TASK_ARG_FLAGS.includes(a) && !seen.has(a) && value !== undefined && value !== '' && !value.startsWith('-')) {
      seen.add(a);
      options.push([a, value]);
      k++;
      continue;
    }
    // 옵션 이름만 보인다 — 값은 비밀 값일 수 있다
    extra.push(a.startsWith('--') ? a.replace(/=.*$/, '=…') : '(이름 없는 인자)');
  }
  if (extra.length) problems.push(`install-task가 쓰지 않는 인자가 있습니다 (${extra.join(' ')})`);
  return { testSession, problems, options };
}

function unitItem(f: LinuxFacts): DeployItem {
  const { name, file } = f.expected;
  const again = (options: [string, string][]): string =>
    wookServerCommandPosix('install-task', f.dataDir, options.flatMap(([k, v]): PosixWord[] => [k, k === '--port' && /^\d{1,5}$/.test(v) ? v : { value: v }]));
  if (!f.unit.show) return item('unit', 'warn', `사용자 systemd에 닿지 못해 유닛을 보지 못했습니다 (${f.unit.error ?? '까닭 모름'})`, '서버를 돌릴 사용자로 직접 로그인한 셸(SSH 포함)에서 다시 점검하세요 — sudo -u·su 셸에는 사용자 버스가 없습니다');
  const s = f.unit.show;
  // 같은 데이터 폴더를 가리키는 install-task의 유닛이 다른 이름으로도 있다 (S10-13 SH-2 — 폴더가 생기기 전에 등록했거나 경로의 링크가 바뀜): 지우고 다시 등록한다
  const others = f.unit.others ?? [];
  const redo = `${wookServerCommandPosix('uninstall-task', f.dataDir)} 뒤 ${again([])}`;
  if (s['LoadState'] === 'not-found' && f.unit.text === null) {
    if (others.length) {
      return item('unit', 'warn', `이 데이터 폴더의 유닛이 다른 이름으로 등록돼 있습니다 (${others.join(', ')}) — 데이터 폴더가 생기기 전에 등록했거나 경로의 링크가 바뀌었습니다`, `지우고 다시 등록하세요: ${redo}`);
    }
    return item('unit', 'warn', `등록된 유닛이 없습니다 (${name}) — 다시 시작하면 서버가 스스로 뜨지 않습니다`, again([]));
  }
  const fails: string[] = [];
  const warns: string[] = [];
  if (others.length) warns.push(`같은 데이터 폴더의 유닛이 다른 이름으로도 있습니다 (${others.join(', ')}) — 부팅하면 서버 둘이 같은 폴더로 뜨려 합니다`);
  if (s['FragmentPath'] && s['FragmentPath'] !== file) warns.push(`systemd가 읽는 유닛이 install-task의 자리가 아닙니다 (${s['FragmentPath']})`);
  if (f.unit.text === null) warns.push(`유닛 파일(${file})이 없습니다`);
  const view = unitFileView(f.unit.text);
  let options: [string, string][] = [];
  if (f.unit.text !== null) {
    if (view.execCount !== 1) warns.push(`ExecStart=가 ${view.execCount}개입니다 — install-task는 하나만 넣습니다`);
    if (!view.argv) warns.push('ExecStart=를 읽지 못했습니다 (따옴표가 맞지 않습니다)');
    else {
      const a = unitArgvProblems(view.argv, { nodePath: f.expected.nodePath, entry: f.expected.entry, dataDir: f.dataDir });
      if (a.testSession) fails.push('--allow-test-session으로 띄웁니다 — 시험용 세션 발급이 켜집니다');
      warns.push(...a.problems);
      options = a.options;
    }
    if (!view.header) warns.push('install-task가 쓴 파일이 아닙니다(첫 줄이 다릅니다) — 손으로 쓴 유닛입니다');
  }
  if ((s['DropInPaths'] ?? '').trim()) warns.push(`덧붙인 설정(drop-in)이 있습니다 (${s['DropInPaths']}) — ExecStart 등을 바꿀 수 있습니다`);
  if (s['UnitFileState'] !== 'enabled') warns.push(`켜져(enable) 있지 않습니다 (${s['UnitFileState'] || '없음'}) — 로그인·부팅 때 뜨지 않습니다`);
  if (s['KillMode'] && s['KillMode'] !== 'mixed') warns.push(`KillMode가 ${s['KillMode']}입니다 — install-task는 mixed로 씁니다(서버가 턴을 차례로 끝내게)`);
  if (!fails.length && !warns.length) return item('unit', 'ok', `${name} — 켜짐(enable), 이 사용자로 (${view.argv?.slice(1).join(' ') ?? ''})`);
  const fix = others.length ? `지우고 다시 등록하세요: ${wookServerCommandPosix('uninstall-task', f.dataDir)} 뒤 ${again(options)}` : `다시 등록하세요 (같은 이름을 바꿔 넣습니다): ${again(options)}`;
  return item('unit', fails.length ? 'fail' : 'warn', `${name}: ${[...fails, ...warns].join(' · ')}`, fix);
}

function lingerItem(f: LinuxFacts): DeployItem {
  if (f.linger === null) return item('linger', 'skip', 'linger를 읽지 못했습니다');
  if (f.linger) return item('linger', 'ok', `켜짐 — 부팅하면 로그인하지 않아도 ${f.user}의 유닛이 뜹니다`);
  return item('linger', 'warn', `꺼져 있습니다 — 부팅한 뒤 ${f.user}로 로그인하기 전에는 서버가 뜨지 않습니다`, `sudo loginctl enable-linger ${shQuote(f.user)}  (관리자 권한이 드는 한 번)`);
}

function dataDirItem(f: LinuxFacts): DeployItem {
  const st = f.dataDirStat;
  if (st === null) return item('dataDir', 'skip', `데이터 폴더가 아직 없습니다 (${f.dataDir}) — 서버가 처음 시작할 때 이 사용자만(0700) 열 수 있게 만듭니다`);
  if ('error' in st) {
    // 폴더에 닿지 않는 링크(가리키는 곳이 없음·고리 — 데이터 폴더 자신이나 위 폴더), 위 폴더 자리의 파일 — 서버는 데이터 폴더를 만들지 못하고
    // 시작하지 않는다 (S10-16 FPS-3·S10-16b)
    if (st.pathProblem) {
      const t = dataDirPathProblemText(f.dataDir, st.pathProblem);
      return item('dataDir', 'fail', `${f.dataDir}: ${t.text}`, t.fix);
    }
    return item('dataDir', 'skip', `데이터 폴더를 읽지 못했습니다 (${st.error})`);
  }
  if (!st.isDirectory) return item('dataDir', 'fail', `데이터 폴더 자리에 폴더가 아닌 것이 있습니다 (${f.dataDir}${st.link ? ` — 링크 → ${st.link}` : ''})`, '그것을 치우거나 다른 --data-dir을 쓰세요');
  // 링크면 서버처럼 따라간 폴더를 본다 — 글에 링크라고 적는다 (S10-13 SH-1)
  const where = st.link ? `${f.dataDir} (링크 → ${st.link})` : f.dataDir;
  // 고칠 줄은 따라간 폴더에 — `chown -R`은 명령줄의 링크를 따라가지 않아(-P가 기본) 링크 경로로는 링크만 바꾼다 (S10-16 FPS-2)
  const target = st.link ?? f.dataDir;
  const issues: string[] = [];
  const fixes: string[] = [];
  if (f.uid !== null && st.uid !== f.uid) {
    issues.push(`주인이 이 사용자가 아닙니다 (uid ${st.uid})`);
    fixes.push(`sudo chown -R ${shQuote(f.user)}: ${shQuote(target)}`);
  }
  if ((st.mode & 0o077) !== 0) {
    issues.push(`그룹·다른 사용자도 열 수 있습니다 (${octal(st.mode)})`);
    fixes.push(`chmod 700 ${shQuote(target)}`);
  }
  if (!issues.length) return item('dataDir', 'ok', `${where} — 이 사용자만 열 수 있습니다 (${octal(st.mode)})`);
  return item('dataDir', 'warn', `${where}: ${issues.join(' · ')} — 다른 계정이 server.json·wook.db·기록을 읽거나 바꿀 수 있습니다`, fixes.join(' · '));
}

function secretsItem(f: LinuxFacts): DeployItem {
  const dir = secretsDirOf(f.dataDir);
  const store = f.server?.secretStore ?? null;
  if (store) {
    if (store.backend === 'file' && !store.fallbackReason) return item('secrets', 'ok', fileStoreText(dir));
    if (store.backend === 'file') return item('secrets', 'fail', `비밀 값 파일 저장소를 쓸 수 없습니다 — ${store.fallbackReason}`, '그 글의 고치기를 한 뒤 서버를 다시 시작하세요');
    if (store.backend === 'memory') return item('secrets', 'fail', `비밀 값이 메모리에 있습니다 — 다시 시작하면 사라집니다${store.fallbackReason ? ` (${store.fallbackReason})` : ''}`, '서버를 다시 시작한 뒤 비밀 값을 다시 넣으세요');
    return item('secrets', 'warn', '비밀 값이 OS 키링에 있습니다 — 화면 없는 Linux의 키링은 다시 시작하면 사라질 수 있습니다', '서버를 다시 시작하세요 (Linux의 서버는 파일 저장소를 씁니다)');
  }
  if (f.secretsProblem) return item('secrets', 'fail', f.secretsProblem, '그 글의 고치기를 한 뒤 서버를 시작하세요 (서버는 이 상태로는 시작하지 않습니다)');
  return item('secrets', 'ok', `${fileStoreText(dir)} — 서버가 돌지 않아 서버의 상태는 보지 못했지만 폴더는 괜찮습니다`);
}

function sleepItem(f: LinuxFacts): DeployItem {
  if ('error' in f.sleep) return item('sleep', 'skip', `절전 대상을 읽지 못했습니다 (${f.sleep.error})`);
  const open = f.sleep.filter((t) => t.load !== 'masked').map((t) => t.id);
  if (!open.length) return item('sleep', 'ok', `절전 대상을 막아 두었습니다 (${SLEEP_TARGETS.join(', ')} — masked)`);
  return item(
    'sleep',
    'warn',
    `절전 대상이 막혀 있지 않습니다 (${open.join(', ')}) — 쉬는 동안 PC가 절전에 들면 휴대폰에서 닿지 않습니다. 사용자 유닛의 서버는 작업 중 절전 막기도 거부될 수 있습니다(polkit)`,
    `sudo systemctl mask ${SLEEP_TARGETS.join(' ')}`,
  );
}

function powerItem(f: LinuxFacts, sleepMasked: boolean): DeployItem {
  const p = f.server?.power ?? null;
  // 절전 대상을 막아 두었으면(서버의 권장 설정) 작업 중 막기가 없어도 PC는 잠들지 않는다 — systemd-inhibit이 있든 없든 통과 (S10-13 SH-8)
  if (sleepMasked && (!p || p.state === 'unavailable' || p.state === 'unsupported')) {
    const why = p ? `작업 중 절전 막기를 쓸 수 없지만(${p.reason ?? '까닭 모름'})` : f.tools.inhibit ? '서버가 돌지 않아 절전 막기 상태는 보지 못했지만' : 'systemd-inhibit이 PATH에 없지만';
    return item('power', 'ok', `${why} 절전 대상을 막아 두어 괜찮습니다`);
  }
  if (!p) {
    if (!f.tools.inhibit) return item('power', 'warn', 'systemd-inhibit이 PATH에 없습니다 — 서버는 작업 중에도 절전을 막지 못합니다', sleepMasked ? null : `sudo systemctl mask ${SLEEP_TARGETS.join(' ')}`);
    return item('power', 'skip', '서버가 돌지 않아 절전 방지 상태를 보지 못했습니다 — 서버를 띄운 뒤 wook-server status의 절전 방지 줄로 봅니다');
  }
  if (p.state === 'unavailable' || p.state === 'unsupported') {
    return item('power', 'warn', `작업 중 절전 막기를 쓸 수 없습니다 — ${p.reason ?? '까닭 모름'}`, `절전 대상을 막아 두세요: sudo systemctl mask ${SLEEP_TARGETS.join(' ')}`);
  }
  if (p.state === 'off') return item('power', 'ok', `꺼 두었습니다 (${p.reason ?? 'execution.preventSleep'})`);
  return item('power', 'ok', `${p.state}${p.reason ? ` — ${p.reason}` : ''}`);
}

function pathItem(f: LinuxFacts): DeployItem {
  const unitPath = unitPathOf(f.unit.text);
  if (unitPath === null) return item('path', 'skip', '유닛이 없거나 PATH를 적지 않아 견주지 못했습니다');
  const dirs = new Set(unitPath.split(':').filter(Boolean));
  const outside = (Object.entries(f.found) as [string, string | null][]).filter(([, at]) => at !== null && !dirs.has(posix.dirname(at))).map(([n, at]) => `${n}(${at})`);
  if (!outside.length) return item('path', 'ok', `유닛의 PATH에 claude·codex·git·node가 있는 폴더가 들었습니다 (찾은 것만)`);
  return item(
    'path',
    'warn',
    `이 셸에서 찾은 ${outside.join(', ')}이 유닛의 PATH 밖에 있습니다 — 서버(유닛)는 그것을 찾지 못합니다`,
    `그 PATH가 있는 셸에서 유닛을 다시 등록하세요: ${wookServerCommandPosix('install-task', f.dataDir)}`,
  );
}

function apiKeyEnvItem(f: LinuxFacts): DeployItem {
  const unitEnv = Object.keys(unitFileView(f.unit.text).env);
  const where = (name: string): string[] => {
    const at: string[] = [];
    if (f.envNames.process.includes(name)) at.push('이 셸');
    if (f.envNames.manager?.includes(name)) at.push('사용자 관리자');
    if (unitEnv.includes(name)) at.push('유닛');
    return at;
  };
  const found: string[] = [];
  const names: string[] = [];
  for (const kind of ['claude', 'codex'] as const) {
    if (f.apiKeys?.[kind].authMode === 'api_key') continue;
    for (const name of API_KEY_ENV_NAMES[kind]) {
      const at = where(name);
      if (at.length) {
        found.push(`${name}(${at.join('·')})`);
        names.push(name);
      }
    }
  }
  if (!found.length) return item('apikey-env', 'ok', '구독 방식 AI에 걸리는 API 키 환경 변수가 없습니다');
  const mode = f.apiKeys ? '구독 방식인데' : '구독 방식이면(서버가 돌지 않아 방식을 보지 못했습니다)';
  return item(
    'apikey-env',
    'warn',
    `${mode} API 키 환경 변수가 있습니다: ${found.join(', ')} — CLI가 그 키로 돌아 API 요금이 나갈 수 있습니다 (값은 읽지 않았습니다)`,
    `구독으로 쓰려면 ~/.profile·~/.bashrc·~/.config/environment.d에서 지우고 systemctl --user unset-environment ${names.join(' ')} 뒤 서버를 다시 시작하세요. API 키로 쓰려면 ${wookServerCommandPosix('secret set', f.dataDir, ['<AI>-api-key'])}`,
  );
}

function adminSocketItem(f: LinuxFacts): DeployItem {
  const a = f.server?.adminPipe ?? null;
  if (!f.server || !a) return item('adminSocket', 'skip', '서버가 돌지 않아 관리 채널을 보지 못했습니다');
  if (a.mode === 'socket' && a.userOnlyAcl) return item('adminSocket', 'ok', '소켓 파일 — 이 사용자만 (다른 기기에서는 닿지 않습니다)');
  return item('adminSocket', 'warn', `관리 채널이 소켓 파일이 아닙니다 (${a.mode}${a.reason ? ` — ${a.reason}` : ''})`, '서버를 다시 시작하세요');
}

function tailscaleItem(f: LinuxFacts): DeployItem {
  const install = `curl -fsSL https://tailscale.com/install.sh | sh 뒤 sudo tailscale up --operator=${shQuote(f.user)}`;
  if (!f.tools.tailscale) return item('tailscale', 'warn', 'Tailscale이 없습니다 — 휴대폰에서 들어올 수 없습니다', install);
  if (f.tailscale.timedOut) return item('tailscale', 'warn', `tailscale status가 ${LINUX_EXEC_TIMEOUT_MS / 1000}초 안에 끝나지 않았습니다 — tailscaled가 멈췄을 수 있습니다`, 'sudo systemctl restart tailscaled');
  const port = f.server?.port ?? unitPortOf(f.unit.text) ?? DEFAULT_PORT;
  const t = readTailscale(f.tailscale.status, f.tailscale.serve, port);
  if (!t) return item('tailscale', 'warn', 'tailscale status를 읽지 못했습니다 — 로그인하지 않았거나 tailscaled가 꺼져 있을 수 있습니다', `sudo tailscale up --operator=${shQuote(f.user)}`);
  if (!t.running) return item('tailscale', 'warn', `Tailscale이 돌고 있지 않습니다 (${t.state})`, `sudo tailscale up --operator=${shQuote(f.user)}`);
  const fails: string[] = [];
  const warns: string[] = [];
  const fixes: string[] = [];
  if (t.funnel) {
    fails.push('tailscale funnel이 켜져 있습니다 — 인터넷 전체에 열립니다');
    fixes.push('tailscale funnel --https=443 off');
  }
  if (!t.https) {
    warns.push('tailnet의 HTTPS 인증서가 꺼져 있습니다 (CertDomains가 비었습니다)');
    fixes.push('Tailscale 관리 콘솔 → DNS에서 MagicDNS와 HTTPS 인증서를 켜세요');
  }
  if (!t.ours) {
    warns.push(`이 서버(포트 ${port})로 넘기는 tailscale serve 항목이 없습니다`);
    fixes.push(`tailscale serve --bg ${port} (root가 아니면 먼저 sudo tailscale set --operator=${shQuote(f.user)}) 뒤 그 https 주소를 server.json network.publicOrigin에 넣고 ${wookServerCommandPosix('config reload', f.dataDir)}`);
  }
  if (t.others.length) {
    warns.push(`같은 이름에 다른 항목이 있습니다: ${t.others.join(', ')} — 그 이름의 로그인 쿠키가 그쪽에도 갑니다 (S3-31)`);
    fixes.push('다른 서비스는 다른 Tailscale 기기 이름에 두세요');
  }
  if (!fails.length && !warns.length) return item('tailscale', 'ok', `https://${t.dnsName ?? '?'} → 127.0.0.1:${port}`);
  return item('tailscale', fails.length ? 'fail' : 'warn', [...fails, ...warns].join(' · '), fixes.join(' · '));
}

/** 유닛의 --port (없으면 null) */
export function unitPortOf(text: string | null): number | null {
  const argv = unitFileView(text).argv ?? [];
  for (let k = 0; k < argv.length; k++) {
    const a = argv[k]!;
    const v = a === '--port' ? argv[k + 1] : a.startsWith('--port=') ? a.slice('--port='.length) : undefined;
    if (v !== undefined && /^\d{1,5}$/.test(v)) return Number(v);
  }
  return null;
}

/** 사실 → 항목 (리드 결정 S10-6.3의 목록) — 순수 함수 */
export function linuxDeployItems(f: LinuxFacts): DeployItem[] {
  const sleepMasked = !('error' in f.sleep) && f.sleep.length > 0 && f.sleep.every((t) => t.load === 'masked');
  return [
    userItem(f),
    procItem(f),
    procpsItem(f),
    nodeItem(f),
    unitItem(f),
    lingerItem(f),
    dataDirItem(f),
    secretsItem(f),
    sleepItem(f),
    powerItem(f, sleepMasked),
    cliItem('claude', f.cli.claude, f.apiKeys?.claude ?? null, f.dataDir, wookServerCommandPosix),
    cliItem('codex', f.cli.codex, f.apiKeys?.codex ?? null, f.dataDir, wookServerCommandPosix),
    pathItem(f),
    apiKeyEnvItem(f),
    // 화면 조작(screen) 항목 (S10c) — Windows 목록처럼 apikey-env 뒤
    linuxScreenItem(f),
    adminSocketItem(f),
    tailscaleItem(f),
  ];
}

/**
 * 화면 조작 (S10c, 리드 결정 S10-7.12): 도구가 있는지 · 화면(Wayland·없음·Xvfb) · 접근성 버스 · typeWithoutA11y 경고 (x11ScreenCheck). 서버가 돌면 그 서버가 본 화면
 * 상태가 먼저다. 사실을 모으지 않았으면 서버의 상태만 본다 (Windows의 screenItem과 같은 모양)
 */
export function linuxScreenItem(f: Pick<LinuxFacts, 'screen' | 'server'>): DeployItem {
  const server = f.server?.screen ?? null;
  if (!f.screen) {
    if (!f.server) return item('screen', 'skip', '서버가 돌지 않아 보지 못했습니다 — 서버를 띄운 뒤 wook-server status의 화면 조작 줄로 봅니다');
    if (!server) return item('screen', 'skip', '서버가 화면 조작 상태를 내지 않았습니다');
    return server.ok
      ? item('screen', 'ok', server.detail)
      : item('screen', 'warn', server.detail, '서버 PC의 화면(Xvfb)과 server.json의 screen 칸을 확인 — 화면 조작을 쓰지 않으면 server.json에 "screen": { "enabled": false }');
  }
  const r = x11ScreenCheck({ ...f.screen, server });
  return item('screen', r.level, r.text, r.fix);
}

/** 화면 조작의 사실 (S10c) — 화면 세션은 서버(유닛)가 받는 환경(사용자 관리자의 환경, 못 읽으면 이 셸)과 server.json으로 정한다. 읽기만 한다 */
function screenFacts(config: ServerConfigFile['screen'] | null, env: Readonly<Record<string, string | undefined>>, x11: LinuxGatherDeps['x11']): Omit<X11CheckFacts, 'server'> {
  const tools = x11 ? x11() : { missingTools: [], python3: true };
  return {
    enabled: config?.enabled ?? null,
    session: screenSession({ platform: 'linux', env, config: config ? { display: config.display ?? null, xauthority: config.xauthority ?? null } : null }),
    missingTools: tools.missingTools,
    python3: tools.python3,
    probe: null,
    dbusSession: !!env['DBUS_SESSION_BUS_ADDRESS'],
    typeWithoutA11y: config?.typeWithoutA11y === true,
  };
}

// ───────────────────────── 사실 모으기 ─────────────────────────

export interface LinuxExecResult {
  code: number | null;
  stdout: string;
  timedOut: boolean;
  error: string | null;
}
/** 셸 없이 프로그램 하나 — 짧은 상한 */
export type LinuxExec = (file: string, args: readonly string[], o: { timeoutMs: number; signal?: AbortSignal }) => Promise<LinuxExecResult>;

export const realLinuxExec: LinuxExec = (file, args, o) =>
  new Promise((resolveRun) => {
    execFile(file, [...args], { timeout: o.timeoutMs, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8', ...(o.signal ? { signal: o.signal } : {}) }, (err, stdout) => {
      const e = err as (NodeJS.ErrnoException & { code?: unknown; killed?: boolean; signal?: string | null }) | null;
      resolveRun({
        code: e ? (typeof e.code === 'number' ? e.code : null) : 0,
        stdout: String(stdout ?? ''),
        timedOut: !!e && e.killed === true && e.signal != null && e.name !== 'AbortError',
        error: e?.name === 'AbortError' ? 'aborted' : e && typeof e.code === 'string' ? e.code : null,
      });
    });
  });

/** PATH에서 실행 파일을 찾는다 (셸 없이 — 파일과 실행 권한만 본다) */
export function whichOnPath(name: string, path: string | undefined): string | null {
  for (const dir of (path ?? '').split(delimiter).filter(Boolean)) {
    const p = join(dir, name);
    try {
      const st = statSync(p);
      if (st.isFile() && (st.mode & 0o111) !== 0) return p;
    } catch {
      // 없다
    }
  }
  return null;
}

export interface LinuxGatherDeps {
  exec: LinuxExec;
  uid: number | null;
  user: string;
  home: string;
  env: NodeJS.ProcessEnv;
  nodeVersion: string;
  nodePath: string;
  appRoot: string;
  proc: () => string | null;
  which: (name: string, path: string | undefined) => string | null;
  exists: (path: string) => boolean;
  readText: (path: string) => string | null;
  /** 폴더의 이름들 (유닛 폴더 — 같은 데이터 폴더의 다른 이름 유닛을 찾는다). 없으면 그 찾기를 하지 않는다 */
  listDir?: (dir: string) => string[];
  statDir: (path: string) => LinuxFacts['dataDirStat'];
  secretsProblem: (dir: string) => string | null;
  cli: (kind: AiKind, override: string | null, env: NodeJS.ProcessEnv) => Promise<CliProbe>;
  now: () => Date;
  /** 화면 조작의 X 도구·python3 (S10c — 정해진 시스템 폴더의 stat). 없으면(시험) 모두 있는 것으로 본다 */
  x11?: () => { missingTools: string[]; python3: boolean };
}

export function defaultLinuxGatherDeps(): LinuxGatherDeps {
  let user = '';
  try {
    user = userInfo().username;
  } catch {
    user = process.env['USER'] ?? '';
  }
  return {
    exec: realLinuxExec,
    uid: typeof process.getuid === 'function' ? process.getuid() : null,
    user,
    home: homedir(),
    env: process.env,
    nodeVersion: process.versions.node,
    nodePath: process.execPath,
    appRoot: appRootFrom(),
    proc: () => procProblem(),
    which: whichOnPath,
    exists: existsSync,
    readText: (p) => {
      try {
        return readFileSync(p, 'utf8');
      } catch {
        return null;
      }
    },
    statDir: (p) => {
      // 링크는 서버(prepareDataDir)처럼 따라간다 — 따라간 폴더의 주인·권한을 보고 링크라고 적는다 (S10-13 SH-1). 폴더에 닿지 않는 링크(데이터 폴더
      // 자신이나 위 폴더 — 가리키는 곳이 없음·고리)와 위 폴더 자리의 파일은 '아직 없음'이 아니다: 서버는 데이터 폴더를 만들 수 없다(rename·mkdir가
      // ENOTDIR·ENOENT로 끝난다) — 서버와 같은 판단(dataDirPathProblem)으로 실패를 적는다 (S10-16 FPS-3·S10-16b)
      const code = (e: unknown): string => (e as NodeJS.ErrnoException).code ?? (e as Error).message;
      const problem = dataDirPathProblem(p);
      if (problem) return { error: problem.kind === 'link' ? problem.code : 'ENOTDIR', pathProblem: problem };
      let link: string | null = null;
      try {
        if (lstatSync(p).isSymbolicLink()) link = realpathSync(p);
      } catch (error) {
        if (code(error) === 'ENOENT') return null;
        return { error: code(error) };
      }
      try {
        const st = statSync(p);
        return { uid: st.uid, mode: st.mode, isDirectory: st.isDirectory(), link };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        return { error: (error as NodeJS.ErrnoException).code ?? (error as Error).message };
      }
    },
    listDir: (d) => {
      try {
        return readdirSync(d);
      } catch {
        return [];
      }
    },
    secretsProblem: (dir) => fileSecretStoreProblem(dir),
    cli: (kind, override, env) => probeCli(kind, { override, env }),
    now: () => new Date(),
    x11: () => ({ missingTools: resolveX11Tools().missing, python3: !!findSystemTool('python3') }),
  };
}

/** 사실을 모아 항목으로 — 읽기만 한다. 명령은 셸 없이 짧은 상한으로, tailscale serve status는 status가 상한에 걸리면 부르지 않는다(S9-24 R2S-4와 같다) */
export async function gatherLinuxDeploy(
  o: {
    dataDir: string;
    cliPaths: { claudePath: string | null; codexPath: string | null };
    apiKeys: Record<AiKind, ApiKeyState> | null;
    server: LinuxServerView | null;
    /** server.json의 screen 칸 (S10c — 없으면 null) */
    screen?: ServerConfigFile['screen'] | null;
    signal?: AbortSignal;
  },
  deps: LinuxGatherDeps,
): Promise<DeployReport> {
  const run = (file: string, args: readonly string[]) => deps.exec(file, args, { timeoutMs: LINUX_EXEC_TIMEOUT_MS, ...(o.signal ? { signal: o.signal } : {}) });
  const name = unitName(o.dataDir);
  // 사용자 관리자의 환경 — 유닛 폴더(XDG_CONFIG_HOME)와 API 키 이름을 본다
  let managerEnv: Record<string, string> | null = null;
  let managerError: string | null = null;
  if (!deps.env['XDG_RUNTIME_DIR']) managerError = 'XDG_RUNTIME_DIR이 없습니다';
  else {
    const r = await run('systemctl', ['--user', 'show-environment']);
    if (r.code === 0) {
      managerEnv = {};
      for (const line of r.stdout.split('\n')) {
        const eq = line.indexOf('=');
        if (eq > 0) managerEnv[line.slice(0, eq)] = line.slice(eq + 1);
      }
    } else managerError = r.error ?? (r.timedOut ? '시간 초과' : `끝 코드 ${r.code}`);
  }
  const unitDir = unitDirOf(managerEnv, deps.home);
  const file = posix.join(unitDir, name);
  const others = deps.listDir ? unitsForDataDir(o.dataDir, unitDir, { list: deps.listDir, read: deps.readText }).filter((n) => n !== name) : [];
  let show: Record<string, string> | null = null;
  if (managerEnv) {
    const r = await run('systemctl', showArgs(name));
    if (r.code === 0) show = parseShow(r.stdout)[0] ?? {};
    else managerError = r.error ?? (r.timedOut ? '시간 초과' : `끝 코드 ${r.code}`);
  }
  const unitText = deps.readText(file);
  const sleepRun = await run('systemctl', ['show', '-p', 'Id', '-p', 'LoadState', ...SLEEP_TARGETS]);
  const sleep: LinuxFacts['sleep'] =
    sleepRun.code === 0
      ? parseShow(sleepRun.stdout).map((b) => ({ id: b['Id'] ?? '?', load: b['LoadState'] ?? '?' }))
      : { error: sleepRun.error ?? (sleepRun.timedOut ? '시간 초과' : `systemctl show 끝 코드 ${sleepRun.code}`) };
  const path = deps.env['PATH'];
  const tailscale = deps.which('tailscale', path);
  let ts: LinuxFacts['tailscale'] = { status: null, serve: null, timedOut: false };
  if (tailscale) {
    const st = await run(tailscale, ['status', '--json']);
    ts = { status: st.stdout || null, serve: null, timedOut: st.timedOut };
    if (!st.timedOut) ts.serve = (await run(tailscale, ['serve', 'status', '--json'])).stdout || null;
  }
  // CLI는 서버(유닛)가 쓰는 PATH로 찾는다 — 유닛이 없으면 이 셸의 PATH
  const cliEnv = { ...deps.env, PATH: unitPathOf(unitText) ?? path ?? '' };
  const safeCli = (kind: AiKind, override: string | null): Promise<CliProbe> =>
    deps.cli(kind, override, cliEnv).catch((e: unknown): CliProbe => ({ found: false, path: null, loggedIn: null, detail: (e as Error).message }));
  const [claude, codex] = await Promise.all([safeCli('claude', o.cliPaths.claudePath), safeCli('codex', o.cliPaths.codexPath)]);
  const facts: LinuxFacts = {
    dataDir: o.dataDir,
    uid: deps.uid,
    user: deps.user,
    proc: deps.proc(),
    tools: { ps: deps.which('ps', path), pgrep: deps.which('pgrep', path), inhibit: deps.which('systemd-inhibit', path), tailscale },
    nodeVersion: deps.nodeVersion,
    expected: { name, file, nodePath: deps.nodePath, entry: posix.join(deps.appRoot, 'out', 'server', 'index.mjs') },
    unit: { text: unitText, show, error: managerError, others },
    linger: deps.user ? deps.exists(lingerFile(deps.user)) : null,
    dataDirStat: deps.statDir(o.dataDir),
    secretsProblem: deps.secretsProblem(secretsDirOf(o.dataDir)),
    sleep,
    cli: { claude, codex },
    apiKeys: o.apiKeys,
    envNames: { process: Object.keys(deps.env), manager: managerEnv ? Object.keys(managerEnv) : null },
    found: { claude: deps.which('claude', path), codex: deps.which('codex', path), git: deps.which('git', path), node: deps.which('node', path) },
    tailscale: ts,
    server: o.server,
    screen: { ...screenFacts(o.screen ?? null, managerEnv ?? deps.env, deps.x11), home: managerEnv?.['HOME'] ?? deps.home },
  };
  return { checkedAt: deps.now().toISOString(), items: linuxDeployItems(facts) };
}

// ───────────────────────── 운영자 명령 check (Linux) ─────────────────────────

export interface LinuxCheckDeps {
  gather: LinuxGatherDeps;
  /** 이 데이터 폴더의 실행 중인 서버 (관리 채널 status·config show — 없으면 null) */
  server: (dataDir: string) => Promise<(LinuxServerView & { apiKeys: Record<AiKind, ApiKeyState> | null; cliPaths: { claudePath: string | null; codexPath: string | null } }) | null>;
  /** server.json의 cli 위치 (읽지 못하면 null) */
  config: (dataDir: string) => { cliPaths: { claudePath: string | null; codexPath: string | null }; screen?: ServerConfigFile['screen'] } | null;
}

/** 실행 중인 서버의 status를 Linux 점검의 서버 보기로 */
export function linuxServerView(s: Pick<AdminStatus, 'adminPipe' | 'power' | 'secretStore' | 'screen' | 'port'>): LinuxServerView {
  return {
    adminPipe: s.adminPipe ?? null,
    power: s.power ?? null,
    secretStore: s.secretStore ?? null,
    screen: s.screen ? { ok: s.screen.ok, detail: s.screen.detail } : null,
    port: s.port,
  };
}

export function defaultLinuxCheckDeps(): LinuxCheckDeps {
  return {
    gather: defaultLinuxGatherDeps(),
    server: async (dataDir) => {
      let status: AdminStatus;
      try {
        const reply = await operatorRequest({ dataDir, command: 'status', timeoutMs: 5_000 });
        if (!reply.ok) return null;
        status = reply.result as AdminStatus;
      } catch {
        return null;
      }
      let config: ServerConfigView | null = null;
      try {
        const reply = await operatorRequest({ dataDir, command: 'config.show', timeoutMs: 5_000 });
        if (reply.ok) config = reply.result as ServerConfigView;
      } catch {
        config = null;
      }
      return { ...linuxServerView(status), apiKeys: config?.apiKeys ?? null, cliPaths: config?.cli ?? { claudePath: null, codexPath: null } };
    },
    config: (dataDir) => {
      const r = readServerConfig(serverConfigPath(dataDir));
      return r.ok ? { cliPaths: r.config.cli, screen: r.config.screen } : null;
    },
  };
}

/** `wook-server check`의 Linux 쪽 — 실패가 있으면 1. --dry-run은 돌릴 것만 보인다(아무것도 띄우지 않고 서버에도 붙지 않는다) */
export async function runLinuxCheck(o: { dataDir: string; dryRun: boolean }, deps: LinuxCheckDeps): Promise<{ code: number; out: string; err: string; json: { ok: true; result: unknown } }> {
  if (o.dryRun) {
    const name = unitName(o.dataDir);
    const commands = [
      ['systemctl', '--user', 'show-environment'],
      ['systemctl', ...showArgs(name)],
      ['systemctl', 'show', '-p', 'Id', '-p', 'LoadState', ...SLEEP_TARGETS],
      ['tailscale', 'status', '--json'],
      ['tailscale', 'serve', 'status', '--json'],
    ];
    const files = ['/proc/self/stat', '/proc/sys/kernel/random/boot_id', `~/.config/systemd/user/${name}`, `/var/lib/systemd/linger/<사용자>`, `${o.dataDir} (stat)`, `${secretsDirOf(o.dataDir)} (stat)`];
    const clis = ['claude auth status --json', 'codex login status'];
    return {
      code: 0,
      out: [
        '[시험 실행 — 아무것도 띄우지 않았습니다] check가 돌릴 것 (모두 읽기만 합니다, 셸 없이)',
        ...commands.map((c) => `  ${c.join(' ')}  (${LINUX_EXEC_TIMEOUT_MS / 1000}초)`),
        ...clis.map((c) => `  ${c}  (찾은 CLI만, 유닛의 PATH로, ${CLI_TIMEOUT_MS / 1000}초)`),
        `  관리 채널 status·config show (이 데이터 폴더의 서버가 돌 때만 — ${o.dataDir})`,
        '읽는 파일',
        ...files.map((f) => `  ${f}`),
        '',
      ].join('\n'),
      err: '',
      json: { ok: true, result: { dryRun: true, unit: name, commands, files, cliStatus: clis } },
    };
  }
  const server = await deps.server(o.dataDir).catch(() => null);
  const cfg = deps.config(o.dataDir);
  const report = await gatherLinuxDeploy(
    {
      dataDir: o.dataDir,
      cliPaths: server?.cliPaths ?? cfg?.cliPaths ?? { claudePath: null, codexPath: null },
      apiKeys: server?.apiKeys ?? null,
      server: server ? { adminPipe: server.adminPipe, power: server.power, secretStore: server.secretStore, screen: server.screen, port: server.port } : null,
      screen: cfg?.screen ?? null,
    },
    deps.gather,
  );
  const failed = report.items.some((i) => i.level === 'fail');
  return { code: failed ? 1 : 0, out: formatCheck(report), err: '', json: { ok: true, result: { ...report, counts: deployCounts(report.items) } } };
}
