/**
 * 작업 스케줄러 등록 (SERVER_DESIGN 3.2·8.3.1·10.9, 리드 결정 S9-3): `wook-server install-task | uninstall-task [--dry-run] [--json]`.
 * 서버를 로그인한 사용자의 '로그온할 때' 작업으로 띄운다 — 서비스(세션 0)·LocalSystem·관리자 권한은 쓰지 않는다(화면 조작은 그 사용자의 화면이 있어야 한다).
 * - 지킴: Windows만(밖이면 2). SID(whoami /user /fo csv /nh의 정규식)가 S-1-5-18·19·20이거나 세션 0이면 '로그인한 사용자 계정으로 실행해야 합니다 — LocalSystem·
 *   서비스 계정 금지'로 1. `"`·`%`가 든 경로는 받지 않는다(작업 스케줄러가 %VAR%를 펼친다). `--allow-test-session`은 받지 않는다(인자를 읽을 때 cli.ts가 2)
 * - 넣는 것: Node = process.execPath(realpath 하지 않는다), 진입점 = <앱 루트>/out/server/index.mjs(있어야 한다), 데이터 폴더(절대 경로),
 *   웹 화면 = --web-dir(서버용 빌드여야 한다) 아니면 서버용 빌드 표시가 있는 out/web, 없으면 경고하고 빼고 넣는다. --port·--config·--owner-email·--public-origin·
 *   --workspace-root는 cli.ts가 확인한 그대로 옮긴다
 * - 이름 `WookServer-<데이터 폴더 해시 8자>`(admin.ts dataDirHash — 데이터 폴더마다 작업 하나), 루트 폴더. XML은 UTF-16LE(BOM)·이스케이프, 적지 않은 칸은 기본값:
 *   ExecutionTimeLimit PT0S(72시간에 끊지 않음), 배터리 두 표시 false(노트북도), Priority 6(보통 — 기본 7은 보통보다 낮음), 실패하면 1분마다 3번 다시
 * - 등록: 그 사용자만 읽는 임시 파일에 XML → `schtasks /create /tn <이름> /xml <파일> /f` → 파일을 지운다 → 등록된 작업을 작업 스케줄러 COM으로 그대로 읽어
 *   (readRegisteredTask — 읽기만 하는 Windows PowerShell 하나, ASCII JSON) Command·Arguments·UserId·LogonType·RunLevel·동작을 견준다(다르면 1). schtasks·PowerShell은
 *   주입할 수 있는 실행기로만 부른다 — execFile, 창 없이, 15초, 셸 없이, schtasks의 판정은 끝 코드로만(오류 글은 지역화돼 있다). 서버는 띄우지 않고 다음 할 일
 *   (schtasks /run, status)을 말한다. 다시 하면 바꿔 넣는다(/f)
 * - --dry-run: XML과 실행할 명령을 보여 주기만 한다 — schtasks·PowerShell을 부르지 않고 임시 파일도 만들지 않는다(SID와 세션 번호는 읽는다 — whoami·tasklist, 바꾸지 않는 명령)
 * - uninstall-task: 작업이 없으면(COM이 '찾을 수 없음') '등록된 작업이 없습니다'로 0, 있으면 /delete /f 뒤 다시 읽어 없어진 것을 본다. 읽지 못하면 1(있는지 모르면
 *   없다고 하지 않는다). 실행 중인 서버는 끄지 않는다(shutdown을 말한다)
 * 다시 읽기를 schtasks /query /xml로 하지 않는 까닭: 그 출력은 콘솔 코드 페이지(이 PC는 949)라 ASCII 밖 글자를 그대로 견줄 수 없다 (리드 결정 S9-22 DS-3·DS-4)
 * 작업의 인자는 Node가 Windows에서 명령 줄을 나누는 규칙(splitWindowsArgs)으로 나눠 본다 — check가 install-task가 쓰는 꼴과 견준다(taskArgvProblems, S9-22 DS-2)
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDirHash } from './admin';
import { restrictToCurrentUser } from './dataDir';
import { hasWebBuildMarker } from './webScreen';

/** 작업 이름 앞머리 (루트 폴더) */
export const TASK_PREFIX = 'WookServer-';
/** 작업 이름의 모양 — PowerShell 스크립트에 넣기 전에 본다 */
export const TASK_NAME_RE = /^WookServer-[0-9a-f]{8}$/;
/** 로그온 뒤 띄우기까지 (Tailscale·네트워크가 먼저 뜨게) */
export const TASK_LOGON_DELAY = 'PT30S';
/** schtasks 한 번의 상한 */
export const SCHTASKS_TIMEOUT_MS = 15_000;
/** LocalSystem·LocalService·NetworkService — 이 SID로는 등록하지 않는다 */
export const SERVICE_SIDS: readonly string[] = ['S-1-5-18', 'S-1-5-19', 'S-1-5-20'];
export const SERVICE_ACCOUNT_REFUSAL = '로그인한 사용자 계정으로 실행해야 합니다 — LocalSystem·서비스 계정 금지';

/** 데이터 폴더의 작업 이름 */
export function taskName(dataDir: string): string {
  return `${TASK_PREFIX}${dataDirHash(dataDir)}`;
}

/** 앱 루트 (out/server의 두 단계 위 — 빌드한 조각도 같은 폴더라 같다, serve.ts resolveAppRoot와 같은 식) */
export function appRootFrom(moduleUrl: string = import.meta.url): string {
  return resolve(dirname(fileURLToPath(moduleUrl)), '..', '..');
}

// ───────────────────────── 실행기 ─────────────────────────

export interface ExecResult {
  /** 끝 코드 (띄우지 못했거나 시간 초과면 null) */
  code: number | null;
  stdout: Buffer;
  timedOut: boolean;
  /** 띄우지 못함 (ENOENT 등) */
  error: string | null;
}

/** 주입할 수 있는 실행기 — 셸 없이 프로그램 하나 */
export type TaskRunner = (file: string, args: readonly string[]) => Promise<ExecResult>;

/**
 * Windows 시스템 폴더의 프로그램 — PATH로 찾지 않는다: Git for Windows가 PATH에 넣는 coreutils의 whoami 같은 같은 이름의 다른 프로그램을 띄우지 않게
 * (이 PC에서 겪음 — `whoami /user`가 'extra operand'로 끝났다)
 */
export function system32(name: 'schtasks' | 'whoami' | 'tasklist' | 'powershell', env: NodeJS.ProcessEnv = process.env): string {
  const root = join(env['SystemRoot'] || env['windir'] || 'C:\\Windows', 'System32');
  // Windows PowerShell 5.1 — PATH의 pwsh(7)·다른 powershell이 아니다
  return name === 'powershell' ? join(root, 'WindowsPowerShell', 'v1.0', 'powershell.exe') : join(root, `${name}.exe`);
}

/** 실제 실행기 (리드 결정 S9-3): execFile, 창 없이, 15초, 셸 없이. schtasks의 판정은 끝 코드로만. schtasks·whoami·tasklist·powershell은 시스템 폴더의 것 */
export const realRunner: TaskRunner = (file, args) =>
  new Promise((resolveRun) => {
    const exe = file === 'schtasks' || file === 'whoami' || file === 'tasklist' || file === 'powershell' ? system32(file) : file;
    execFile(exe, [...args], { windowsHide: true, timeout: SCHTASKS_TIMEOUT_MS, encoding: 'buffer', maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      const e = err as (NodeJS.ErrnoException & { code?: unknown; killed?: boolean; signal?: string | null }) | null;
      const timedOut = !!e && e.killed === true && e.signal != null;
      const code = e ? (typeof e.code === 'number' ? e.code : null) : 0;
      const error = e && typeof e.code === 'string' ? e.code : null;
      resolveRun({ code: timedOut ? null : code, stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout ?? '')), timedOut, error });
    });
  });

// ───────────────────────── 누구로 도는가 ─────────────────────────

export interface Identity {
  sid: string;
  /** 이 프로세스의 세션 번호 (읽지 못하면 null) */
  sessionId: number | null;
}

/** `whoami /user /fo csv /nh` → SID (지역화와 상관없는 모양만 본다) */
export function parseWhoamiSid(text: string): string | null {
  return /"(S-1-\d+(?:-\d+)+)"\s*$/m.exec(text)?.[1] ?? null;
}

/** `tasklist /fi "PID eq N" /fo csv /nh` → 세션 번호 (넷째 칸 — 세션 이름은 지역화될 수 있어 보지 않는다) */
export function parseTasklistSession(text: string, pid: number): number | null {
  for (const line of text.split(/\r?\n/)) {
    const f = line.trim().replace(/^"|"$/g, '').split('","');
    if (f.length >= 4 && f[1] === String(pid) && /^\d+$/.test(f[3]!)) return Number(f[3]);
  }
  return null;
}

/** 지금 사용자의 SID와 이 프로세스의 세션 번호 — 바꾸지 않는 명령 둘(whoami·tasklist) */
export async function readIdentity(run: TaskRunner, pid: number = process.pid): Promise<Identity | { error: string }> {
  const who = await run('whoami', ['/user', '/fo', 'csv', '/nh']);
  const sid = who.code === 0 ? parseWhoamiSid(who.stdout.toString('latin1')) : null;
  if (!sid) return { error: `지금 사용자의 SID를 읽지 못했습니다 (whoami ${who.error ?? (who.timedOut ? '시간 초과' : `끝 코드 ${who.code}`)})` };
  const list = await run('tasklist', ['/fi', `PID eq ${pid}`, '/fo', 'csv', '/nh']);
  return { sid, sessionId: list.code === 0 ? parseTasklistSession(list.stdout.toString('latin1'), pid) : null };
}

/** 서비스 계정·세션 0이면 거부 글 */
export function identityRefusal(id: Identity): string | null {
  if (SERVICE_SIDS.includes(id.sid) || id.sessionId === 0) return SERVICE_ACCOUNT_REFUSAL;
  return null;
}

// ───────────────────────── XML ─────────────────────────

/** XML 글 이스케이프 (요소 안의 글) */
export function xmlEscape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/**
 * Windows 명령 줄 인자 하나를 큰따옴표로 감싼다 — 닫는 따옴표 앞의 역슬래시는 두 배로(C 런타임 규칙: `"C:\"`는 따옴표를 이스케이프한 것으로 읽힌다).
 * `"`는 받지 않으므로(taskPathProblem) 안의 역슬래시는 그대로다
 */
export function winQuote(value: string): string {
  return `"${value.replace(/(\\+)$/, '$1$1')}"`;
}

export interface TaskInputs {
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
  /** 지금 사용자의 SID */
  sid: string;
  /** false면 꺼 둔 작업 (realTask 시험만) */
  enabled?: boolean;
}

/** 작업에 넣는 값 가운데 경로·글 — 하나라도 `"`·`%`·제어 문자가 있으면 그 이름 */
export function taskPathProblem(i: Omit<TaskInputs, 'sid'>): string | null {
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
  ];
  for (const [what, v] of values) {
    if (v && /["%\u0000-\u001f\u007f]/.test(v)) {
      return `${what}에 큰따옴표(")나 퍼센트(%)·제어 문자가 있어 작업에 넣지 않습니다 — 작업 스케줄러는 %…%를 환경 변수로 펼칩니다. 그런 글자가 없는 폴더를 쓰세요`;
    }
  }
  return null;
}

/** 작업의 인자 (Arguments) — `"<진입점>" serve --data-dir "<데이터 폴더>"` 뒤에 있는 옵션만 */
export function taskArguments(i: Omit<TaskInputs, 'sid'>): string {
  const parts = [winQuote(i.entry), 'serve', '--data-dir', winQuote(i.dataDir)];
  if (i.webDir) parts.push('--web-dir', winQuote(i.webDir));
  if (i.port !== undefined) parts.push('--port', String(i.port));
  if (i.configPath) parts.push('--config', winQuote(i.configPath));
  if (i.ownerEmail) parts.push('--owner-email', winQuote(i.ownerEmail));
  if (i.publicOrigin) parts.push('--public-origin', winQuote(i.publicOrigin));
  if (i.workspaceRoot) parts.push('--workspace-root', winQuote(i.workspaceRoot));
  return parts.join(' ');
}

/** 리드 결정 S9-3의 XML — 적지 않은 칸은 기본값 */
export function buildTaskXml(i: TaskInputs): string {
  const e = xmlEscape;
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    ` <RegistrationInfo><Author>wook-server install-task</Author><Description>${e(`욱채 서버 — ${i.dataDir}`)}</Description></RegistrationInfo>`,
    ` <Triggers><LogonTrigger><UserId>${e(i.sid)}</UserId><Delay>${TASK_LOGON_DELAY}</Delay></LogonTrigger></Triggers>`,
    ` <Principals><Principal id="Author"><UserId>${e(i.sid)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>`,
    ` <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>`,
    `  <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><Priority>6</Priority>${i.enabled === false ? '<Enabled>false</Enabled>' : ''}`,
    '  <RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure></Settings>',
    ` <Actions Context="Author"><Exec><Command>${e(i.nodePath)}</Command>`,
    `  <Arguments>${e(taskArguments(i))}</Arguments><WorkingDirectory>${e(i.appRoot)}</WorkingDirectory></Exec></Actions>`,
    '</Task>',
    '',
  ].join('\r\n');
}

/** 작업 스케줄러가 읽는 바이트 — UTF-16LE와 BOM */
export function taskXmlBytes(xml: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]);
}

const unescapeXml = (t: string): string =>
  t
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');

/** 등록된 작업 XML에서 견줄 칸 (없는 칸은 null) — 작업 스케줄러가 돌려주는 XML은 칸 차례·공백이 다를 수 있어 요소 이름으로 찾는다 */
export interface TaskFields {
  /** 첫 Exec 동작의 Command·Arguments·WorkingDirectory */
  command: string | null;
  arguments: string | null;
  workingDirectory: string | null;
  userId: string | null;
  logonType: string | null;
  /** 주체의 RunLevel (없으면 null — 작업 스케줄러의 기본은 LeastPrivilege) */
  runLevel: string | null;
  /** Actions 안의 동작 종류를 차례로 (Exec·ComHandler·SendEmail·ShowMessage) — install-task는 Exec 하나만 넣는다 */
  actions: string[];
  /** Exec 동작 모두의 Command·Arguments·WorkingDirectory (차례로 — 첫째가 위의 세 칸이다). check는 모두의 인자를 본다 (리드 결정 S9-24 R2S-3) */
  execs: { command: string | null; arguments: string | null; workingDirectory: string | null }[];
  executionTimeLimit: string | null;
  disallowStartIfOnBatteries: string | null;
  stopIfGoingOnBatteries: string | null;
  priority: string | null;
  enabled: string | null;
}

export function parseTaskXml(xml: string): TaskFields {
  const scopeOf = (within: string): string => new RegExp(`<${within}\\b[^>]*>([\\s\\S]*?)</${within}>`).exec(xml)?.[1] ?? '';
  const inScope = (tag: string, scope: string): string | null => {
    const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(scope);
    return m ? unescapeXml(m[1]!.trim()) : null;
  };
  const one = (tag: string, within?: string): string | null => inScope(tag, within ? scopeOf(within) : xml);
  const execs = [...scopeOf('Actions').matchAll(/<Exec\b[^>]*>([\s\S]*?)<\/Exec>/g)].map((m) => ({
    command: inScope('Command', m[1]!),
    arguments: inScope('Arguments', m[1]!),
    workingDirectory: inScope('WorkingDirectory', m[1]!),
  }));
  return {
    execs,
    command: one('Command', 'Exec'),
    arguments: one('Arguments', 'Exec'),
    workingDirectory: one('WorkingDirectory', 'Exec'),
    userId: one('UserId', 'Principal'),
    logonType: one('LogonType', 'Principal'),
    runLevel: one('RunLevel', 'Principal'),
    actions: [...scopeOf('Actions').matchAll(/<(Exec|ComHandler|SendEmail|ShowMessage)\b/g)].map((m) => m[1]!),
    executionTimeLimit: one('ExecutionTimeLimit', 'Settings'),
    disallowStartIfOnBatteries: one('DisallowStartIfOnBatteries', 'Settings'),
    stopIfGoingOnBatteries: one('StopIfGoingOnBatteries', 'Settings'),
    priority: one('Priority', 'Settings'),
    enabled: one('Enabled', 'Settings'),
  };
}

/** RunLevel이 관리자 권한 없이(LeastPrivilege)인지 — 칸이 없으면 작업 스케줄러의 기본(LeastPrivilege)이다 */
export const leastPrivilege = (runLevel: string | null): boolean => (runLevel ?? 'LeastPrivilege').trim() === 'LeastPrivilege';

/**
 * 등록하려던 칸과 다시 읽은 칸이 다른 것 (Command·Arguments·UserId·LogonType — 리드 결정 S9-3, RunLevel·동작 — S9-22 DS-1). 경로는 대소문자를 가리지 않는다.
 * 다시 읽기는 작업 스케줄러 COM의 XML 그대로라(readRegisteredTask) 모든 글자를 견준다. UserId는 SID로 썼어도 작업 스케줄러가 계정 이름(`도메인\사용자`·`사용자`)으로
 * 돌려줄 수 있다 — 그 이름(accountNames)도 같은 계정으로 본다
 */
export function compareTask(expected: TaskInputs, got: TaskFields, accountNames: readonly string[] = []): string[] {
  const path = (t: string | null): string => (t ?? '').trim().toLowerCase();
  const diffs: string[] = [];
  if (path(got.command) !== path(expected.nodePath)) diffs.push('Command(Node)');
  if (path(got.arguments) !== path(taskArguments(expected))) diffs.push('Arguments');
  if (!sameAccount(got.userId, expected.sid, accountNames)) diffs.push('UserId');
  if ((got.logonType ?? '').trim() !== 'InteractiveToken') diffs.push('LogonType');
  if (!leastPrivilege(got.runLevel)) diffs.push('RunLevel');
  if (got.actions.length !== 1 || got.actions[0] !== 'Exec') diffs.push('Actions');
  return diffs;
}

/** 작업의 UserId가 이 계정인지 — SID나 그 계정 이름(대소문자 무시). 서비스 SID는 늘 아니다 */
export function sameAccount(userId: string | null, sid: string, accountNames: readonly string[]): boolean {
  const v = (userId ?? '').trim().toLowerCase();
  if (!v || SERVICE_SIDS.includes(v.toUpperCase())) return false;
  return [sid, ...accountNames].some((n) => n && n.toLowerCase() === v);
}

// ───────────────────────── 작업 인자 읽기 ─────────────────────────

/**
 * Windows 명령 줄의 인자를 나눈다 — Node(MSVC 런타임, UCRT)가 `wmain`의 argv를 만드는 규칙 그대로(작업 스케줄러는 `"<Command>" <Arguments>`로 띄운다).
 * 빈칸·탭으로 나누고, 큰따옴표 안은 한 인자다(인자 가운데에서 열고 닫아도 된다). 역슬래시는 큰따옴표 바로 앞에서만 특별하다: 2n개 + `"` → 역슬래시 n개와
 * 따옴표 열기·닫기, 2n+1개 + `"` → 역슬래시 n개와 글자 `"`. 따옴표 안의 `""`는 글자 `"` 하나이고 따옴표 안에 남는다. 닫지 않은 따옴표는 줄 끝까지다.
 * 프로그램 이름(첫 낱말)의 따로 규칙은 다루지 않는다 — Arguments만 넘긴다
 */
export function splitWindowsArgs(line: string): string[] {
  const out: string[] = [];
  const n = line.length;
  let i = 0;
  for (;;) {
    while (i < n && (line[i] === ' ' || line[i] === '\t')) i++;
    if (i >= n) return out;
    let arg = '';
    let inQuote = false;
    for (;;) {
      let slashes = 0;
      while (i < n && line[i] === '\\') {
        i++;
        slashes++;
      }
      let copy = true;
      if (i < n && line[i] === '"') {
        if (slashes % 2 === 0) {
          // 따옴표 안의 "" → 글자 " (따옴표 안에 남는다)
          if (inQuote && line[i + 1] === '"') i++;
          else {
            copy = false;
            inQuote = !inQuote;
          }
        }
        slashes = Math.floor(slashes / 2);
      }
      arg += '\\'.repeat(slashes);
      if (i >= n || (!inQuote && (line[i] === ' ' || line[i] === '\t'))) break;
      if (copy) arg += line[i];
      i++;
    }
    out.push(arg);
  }
}

/** install-task가 작업 인자에 옮기는 서버 옵션 — `--이름 값` 꼴로 하나씩 (taskArguments와 같다) */
export const TASK_ARG_FLAGS: readonly string[] = ['--web-dir', '--port', '--config', '--owner-email', '--public-origin', '--workspace-root'];

/** 서버를 시험용 세션 발급으로 띄우는 인자 — `--allow-test-session`, `--allow-test-session=…` (Node의 parseArgs가 받는 꼴) */
const isTestSessionArg = (a: string): boolean => a === '--allow-test-session' || a.startsWith('--allow-test-session=');

/** 작업 동작의 Arguments를 Node처럼 나눴을 때 --allow-test-session이 있는지 — 동작마다 본다 (리드 결정 S9-24 R2S-3) */
export const argsHoldTestSession = (args: string | null): boolean => splitWindowsArgs(args ?? '').some(isTestSessionArg);

export interface TaskArgvView {
  /** Node가 받는 인자 (splitWindowsArgs) */
  argv: string[];
  /** --allow-test-session이 어디든 있다 */
  testSession: boolean;
  /** install-task가 지금 쓸 꼴과 다른 점 (사람이 읽는 글 — 옵션 값은 경로만 보인다) */
  problems: string[];
  /** install-task가 쓰는 옵션과 그 값 (다시 등록하는 명령에 그대로 옮긴다) */
  options: [string, string][];
}

/**
 * 등록된 작업의 Arguments를 Node가 읽는 대로 나눠(splitWindowsArgs) install-task가 쓰는 꼴과 견준다 (리드 결정 S9-22 DS-2): `"<진입점>" serve --data-dir "<데이터 폴더>"`
 * 뒤에 install-task가 옮기는 옵션(TASK_ARG_FLAGS)만 `--이름 값`으로 한 번씩. 진입점·데이터 폴더는 대소문자를 가리지 않는다. --allow-test-session은 어디에 있든 따로 알린다
 * (check는 실패로 본다). 그 밖에 다른 것은 problems — 다른 옵션의 값은 비밀 값일 수 있어 보이지 않는다
 */
export function taskArgvProblems(args: string | null, want: { entry: string; dataDir: string }): TaskArgvView {
  const argv = splitWindowsArgs(args ?? '');
  const testSession = argv.some(isTestSessionArg);
  const problems: string[] = [];
  const options: [string, string][] = [];
  const samePath = (a: string | undefined, b: string): boolean => (a ?? '').toLowerCase() === b.toLowerCase();
  if (!samePath(argv[0], want.entry)) problems.push(`서버 진입점이 지금 것과 다릅니다 (${argv[0] ?? '없음'})`);
  if (argv[1] !== 'serve') problems.push('serve로 띄우지 않습니다');
  if (argv[2] !== '--data-dir' || !samePath(argv[3], want.dataDir)) problems.push(`데이터 폴더가 지금 것과 다릅니다 (${argv[2] === '--data-dir' ? (argv[3] ?? '없음') : '--data-dir 없음'})`);
  const extra: string[] = [];
  const seen = new Set<string>();
  for (let k = 4; k < argv.length; k++) {
    const a = argv[k]!;
    if (isTestSessionArg(a)) continue;
    const value = argv[k + 1];
    // '-'로 시작하는 값은 Node의 parseArgs가 받지 않는다(`--config -x`는 '모호한 인자'로 서버가 뜨지 않는다) — install-task는 그런 값을 쓰지 않는다 (확인 검토의 노트)
    if (TASK_ARG_FLAGS.includes(a) && !seen.has(a) && value !== undefined && value !== '' && !value.startsWith('-')) {
      seen.add(a);
      options.push([a, value]);
      k++;
      continue;
    }
    // 옵션 이름만 보인다 (`--이름=값`은 이름까지) — 값은 비밀 값일 수 있다
    extra.push(a.startsWith('--') ? a.replace(/=.*$/, '=…') : '(이름 없는 인자)');
  }
  if (extra.length) problems.push(`install-task가 쓰지 않는 인자가 있습니다 (${extra.join(' ')})`);
  return { argv, testSession, problems, options };
}

/** 작업 인자의 --port (없거나 숫자가 아니면 null) — Node가 읽는 대로 나눠 본다 */
export function taskPortOf(args: string | null): number | null {
  const argv = splitWindowsArgs(args ?? '');
  for (let k = 0; k < argv.length; k++) {
    const a = argv[k]!;
    const v = a === '--port' ? argv[k + 1] : a.startsWith('--port=') ? a.slice('--port='.length) : undefined;
    if (v !== undefined && /^\d{1,5}$/.test(v)) return Number(v);
  }
  return null;
}

// ───────────────────────── 등록된 작업 읽기 (작업 스케줄러 COM) ─────────────────────────

/**
 * 등록된 작업의 XML을 그대로 읽는 Windows PowerShell 스크립트 (읽기만 — Connect·GetFolder·GetTask). 출력은 ASCII JSON 한 줄(ASCII 밖은 \uXXXX) — 콘솔 코드
 * 페이지와 상관없이 글자를 그대로 옮긴다. 작업이 없으면(0x80070002) found false, 그 밖의 오류는 error
 */
export function taskReadScript(name: string): string {
  if (!TASK_NAME_RE.test(name)) throw new Error('작업 이름 모양이 아닙니다');
  return String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  $svc = New-Object -ComObject Schedule.Service
  $svc.Connect()
  $t = $svc.GetFolder('\').GetTask('${name}')
  $r = [ordered]@{ v = 1; found = $true; xml = [string]$t.Xml; error = $null }
} catch {
  if ($_.Exception.HResult -eq -2147024894) { $r = [ordered]@{ v = 1; found = $false; xml = $null; error = $null } } else { $r = [ordered]@{ v = 1; found = $false; xml = $null; error = [string]$_.Exception.Message } }
}
$json = $r | ConvertTo-Json -Compress
[regex]::Replace($json, '[^\x00-\x7F]', { param($m) '\u{0:x4}' -f [int][char]$m.Value })
`;
}

/** 그 스크립트를 띄우는 인자 — -EncodedCommand(UTF-16LE base64)라 따옴표·역슬래시가 명령 줄에서 바뀌지 않는다 */
export function taskReadArgs(name: string): string[] {
  return ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(taskReadScript(name), 'utf16le').toString('base64')];
}

export type TaskRead = { found: true; xml: string } | { found: false } | { error: string };

/** 등록된 작업을 작업 스케줄러 COM으로 읽는다 (리드 결정 S9-22 DS-3·DS-4) — 주입한 실행기의 'powershell'로(실제는 시스템 폴더의 Windows PowerShell 5.1, 15초) */
export async function readRegisteredTask(name: string, run: TaskRunner): Promise<TaskRead> {
  const r = await run('powershell', taskReadArgs(name));
  if (r.code !== 0) return { error: `Windows PowerShell ${runText(r)}` };
  const text = r.stdout.toString('latin1');
  let v: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text.slice(Math.max(0, text.indexOf('{'))));
    v = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return { error: '작업을 읽는 PowerShell의 출력이 JSON이 아닙니다' };
  }
  if (v['v'] !== 1) return { error: '작업을 읽는 PowerShell의 출력 판이 다릅니다' };
  if (typeof v['error'] === 'string' && v['error']) return { error: `작업 스케줄러: ${v['error']}` };
  if (v['found'] === true && typeof v['xml'] === 'string') return { found: true, xml: v['xml'] };
  if (v['found'] === false) return { found: false };
  return { error: '작업을 읽는 PowerShell의 출력 모양이 다릅니다' };
}

/** 지금 사용자의 계정 이름 (`도메인\사용자`, `사용자`) — 작업 스케줄러가 SID 대신 돌려줄 수 있는 꼴 */
export function currentAccountNames(env: NodeJS.ProcessEnv = process.env): string[] {
  const user = env['USERNAME'] ?? '';
  if (!user) return [];
  return env['USERDOMAIN'] ? [`${env['USERDOMAIN']}\\${user}`, user] : [user];
}

// ───────────────────────── 등록·지우기 ─────────────────────────

/** schtasks 인자 — --dry-run이 보여 주고 등록이 그대로 쓴다 (작업이 있는지·다시 읽기는 COM — readRegisteredTask) */
export const schtasksArgs = {
  create: (name: string, file: string): string[] => ['/create', '/tn', name, '/xml', file, '/f'],
  delete: (name: string): string[] => ['/delete', '/tn', name, '/f'],
};

/** --dry-run이 보이는 다시 읽기 명령 (스크립트는 따로 보인다) */
export const TASK_READ_SHOWN: readonly string[] = ['powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', '<아래 다시 읽기 스크립트의 UTF-16LE base64>'];

const runText = (r: ExecResult): string => r.error ?? (r.timedOut ? `${SCHTASKS_TIMEOUT_MS / 1000}초 안에 끝나지 않음` : `끝 코드 ${r.code}`);

export interface RegisterDeps {
  run: TaskRunner;
  /** 임시 폴더를 만들 곳 (기본 OS 임시 폴더) */
  tmpBase?: string;
  /** 그 사용자만 읽게 좁힌다 (기본 icacls — dataDir.ts restrictToCurrentUser) */
  restrict?: (path: string, kind: 'file' | 'dir') => void;
  /** 다시 읽은 UserId가 SID 대신 계정 이름일 때 같은 계정으로 볼 이름 (기본 지금 사용자 — currentAccountNames) */
  accountNames?: readonly string[];
}

export type RegisterOutcome = { ok: true } | { ok: false; step: 'temp' | 'create' | 'query' | 'compare'; message: string };

/**
 * 등록 (리드 결정 S9-3): 그 사용자만 읽는 임시 폴더·파일에 XML → schtasks /create … /f → 파일·폴더를 지운다 → 작업 스케줄러 COM으로 그대로 읽어 견준다
 * (readRegisteredTask — S9-22). 임시 파일은 어느 길로 끝나든 지운다
 */
export async function registerTask(name: string, inputs: TaskInputs, deps: RegisterDeps): Promise<RegisterOutcome> {
  const restrict = deps.restrict ?? restrictToCurrentUser;
  let dir: string;
  try {
    dir = mkdtempSync(join(deps.tmpBase ?? tmpdir(), 'wook-task-'));
  } catch (error) {
    return { ok: false, step: 'temp', message: `작업 XML을 둘 임시 폴더를 만들지 못했습니다 (${(error as NodeJS.ErrnoException).code ?? (error as Error).message})` };
  }
  const file = join(dir, `${name}.xml`);
  let created: ExecResult;
  try {
    try {
      restrict(dir, 'dir');
      writeFileSync(file, taskXmlBytes(buildTaskXml(inputs)), { flag: 'wx' });
      restrict(file, 'file');
    } catch (error) {
      return { ok: false, step: 'temp', message: `작업 XML을 그 사용자만 읽는 임시 파일로 쓰지 못했습니다 (${(error as NodeJS.ErrnoException).code ?? (error as Error).message})` };
    }
    created = await deps.run('schtasks', schtasksArgs.create(name, file));
  } finally {
    // rmSync는 Node 24.13(Windows)에서 한글 경로면 프로세스가 죽는다 — 파일과 빈 폴더를 따로 지운다 (dataDir.ts와 같다)
    try {
      if (existsSync(file)) unlinkSync(file);
      rmdirSync(dir);
    } catch {
      // 지우지 못하면 다음 OS 임시 폴더 정리에 맡긴다 — XML에는 비밀 값이 없다(경로와 SID)
    }
  }
  if (created.code !== 0) return { ok: false, step: 'create', message: `작업을 등록하지 못했습니다 (schtasks /create ${runText(created)})` };
  const read = await readRegisteredTask(name, deps.run);
  if ('error' in read) return { ok: false, step: 'query', message: `등록한 작업을 다시 읽지 못했습니다 (${read.error}) — 작업 스케줄러에서 ${name}을 확인하세요` };
  if (!read.found) return { ok: false, step: 'query', message: `등록했다는 작업이 작업 스케줄러에 보이지 않습니다 — 작업 스케줄러에서 ${name}을 확인하세요` };
  const diffs = compareTask(inputs, parseTaskXml(read.xml), deps.accountNames ?? currentAccountNames());
  if (diffs.length) return { ok: false, step: 'compare', message: `등록한 작업이 쓴 것과 다릅니다 (${diffs.join(', ')}) — 작업 스케줄러에서 ${name}을 확인하거나 install-task를 다시 하세요` };
  return { ok: true };
}

export type UnregisterOutcome = { ok: true; existed: boolean } | { ok: false; message: string };

/**
 * 지우기: 작업 스케줄러 COM으로 읽어 없으면(찾을 수 없음) 그대로 0, 있으면 /delete /f 뒤 다시 읽어 없어진 것을 본다. 읽지 못하면(시간 초과·거부·PowerShell 없음)
 * 없다고 하지 않고 실패다 (리드 결정 S9-22 DF-9 — schtasks /query의 끝 코드는 '없음'과 '읽지 못함'을 가리지 않는다)
 */
export async function unregisterTask(name: string, run: TaskRunner): Promise<UnregisterOutcome> {
  const before = await readRegisteredTask(name, run);
  if ('error' in before) return { ok: false, message: `작업이 있는지 읽지 못해 지우지 않았습니다 (${before.error}) — 작업 스케줄러에서 ${name}을 확인하세요` };
  if (!before.found) return { ok: true, existed: false };
  const del = await run('schtasks', schtasksArgs.delete(name));
  if (del.code !== 0) return { ok: false, message: `작업을 지우지 못했습니다 (schtasks /delete ${runText(del)})` };
  const after = await readRegisteredTask(name, run);
  if ('error' in after) return { ok: false, message: `작업을 지운 뒤 없어졌는지 읽지 못했습니다 (${after.error}) — 작업 스케줄러에서 ${name}을 확인하세요` };
  if (after.found) return { ok: false, message: `작업을 지웠다고 했지만 아직 있습니다 — 작업 스케줄러에서 ${name}을 지우세요` };
  return { ok: true, existed: true };
}

// ───────────────────────── 명령 ─────────────────────────

/** install-task가 cli.ts에서 받는 옵션 (parseCli가 모양을 이미 봤다) */
export interface TaskFlags {
  port?: number;
  webDir?: string;
  configPath?: string;
  ownerEmail?: string;
  publicOrigin?: string;
  workspaceRoot?: string;
}

export interface TaskCommandDeps {
  platform: NodeJS.Platform;
  /** schtasks (리드 결정 S9-3 — 주입할 수 있는 실행기) */
  run: TaskRunner;
  /** SID·세션 번호 (기본은 whoami·tasklist를 run으로) */
  identity: () => Promise<Identity | { error: string }>;
  appRoot: string;
  nodePath: string;
  tmpBase?: string;
  restrict?: (path: string, kind: 'file' | 'dir') => void;
}

export function defaultTaskDeps(): TaskCommandDeps {
  return { platform: process.platform, run: realRunner, identity: () => readIdentity(realRunner), appRoot: appRootFrom(), nodePath: process.execPath };
}

export interface TaskCommandResult {
  code: number;
  /** 사람이 읽는 글 (stdout) */
  out: string;
  /** 오류 글 (stderr — 끝 코드가 0이 아닐 때) */
  err: string;
  /** --json의 답 */
  json: { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } };
}

const fail = (code: number, errCode: string, message: string): TaskCommandResult => ({ code, out: '', err: `${message}\n`, json: { ok: false, error: { code: errCode, message } } });

/** 웹 화면 폴더: --web-dir(서버용 빌드여야 한다) → 서버용 빌드 표시가 있는 <앱 루트>/out/web → 없음(경고) */
function chooseWebDir(flag: string | undefined, appRoot: string): { webDir: string | null; warning: string | null; refusal: string | null } {
  const marked = (dir: string): boolean => {
    try {
      return statSync(dir).isDirectory() && hasWebBuildMarker(readFileSync(join(dir, 'index.html'), 'utf8'));
    } catch {
      return false;
    }
  };
  if (flag) {
    const dir = resolve(flag);
    return marked(dir)
      ? { webDir: dir, warning: null, refusal: null }
      : { webDir: null, warning: null, refusal: `--web-dir 폴더가 서버용 웹 화면이 아닙니다: ${dir} — npm run build:web으로 만든 out/web을 넘기세요 (작업은 등록하지 않았습니다)` };
  }
  const dir = join(appRoot, 'out', 'web');
  if (marked(dir)) return { webDir: dir, warning: null, refusal: null };
  return { webDir: null, warning: `서버용 웹 화면(${dir})이 없어 --web-dir 없이 등록합니다 — 대표 화면 대신 안내 쪽만 보입니다. npm run build:web 뒤 install-task를 다시 하세요`, refusal: null };
}

/** install-task */
export async function installTask(o: { dataDir: string; flags: TaskFlags; dryRun: boolean }, deps: TaskCommandDeps): Promise<TaskCommandResult> {
  if (deps.platform !== 'win32') return fail(2, 'unsupported', 'install-task는 Windows에서만 씁니다 (Linux는 10단계)');
  const entry = join(deps.appRoot, 'out', 'server', 'index.mjs');
  if (!existsSync(entry)) return fail(1, 'no_entry', `서버 진입점이 없습니다: ${entry} — 저장소 폴더에서 npm run build:server를 한 뒤 다시 하세요`);
  const web = chooseWebDir(o.flags.webDir, deps.appRoot);
  if (web.refusal) return fail(1, 'web_dir', web.refusal);
  const base: Omit<TaskInputs, 'sid'> = {
    dataDir: resolve(o.dataDir),
    nodePath: deps.nodePath,
    entry,
    appRoot: deps.appRoot,
    webDir: web.webDir,
    ...(o.flags.port !== undefined ? { port: o.flags.port } : {}),
    ...(o.flags.configPath ? { configPath: resolve(o.flags.configPath) } : {}),
    ...(o.flags.ownerEmail ? { ownerEmail: o.flags.ownerEmail } : {}),
    ...(o.flags.publicOrigin ? { publicOrigin: o.flags.publicOrigin } : {}),
    ...(o.flags.workspaceRoot ? { workspaceRoot: resolve(o.flags.workspaceRoot) } : {}),
  };
  const bad = taskPathProblem(base);
  if (bad) return fail(1, 'bad_path', bad);
  const id = await deps.identity();
  if ('error' in id) return fail(1, 'identity', id.error);
  const refusal = identityRefusal(id);
  if (refusal) return fail(1, 'service_account', refusal);
  const inputs: TaskInputs = { ...base, sid: id.sid };
  const name = taskName(inputs.dataDir);
  const xml = buildTaskXml(inputs);
  const tempShown = '<임시 파일>';
  const argv = { create: ['schtasks', ...schtasksArgs.create(name, tempShown)], readback: [...TASK_READ_SHOWN] };
  const warnings = web.warning ? [web.warning] : [];
  const summary = [
    `  Node          ${inputs.nodePath}`,
    `  서버 진입점   ${inputs.entry}`,
    `  데이터 폴더   ${inputs.dataDir}`,
    `  웹 화면       ${inputs.webDir ?? '없음'}`,
    `  인자          ${taskArguments(inputs)}`,
    `  실행 계정     ${inputs.sid} (로그온할 때 30초 뒤, 관리자 권한 없이, 이 사용자의 화면에서)`,
  ];
  if (o.dryRun) {
    return {
      code: 0,
      out: [
        `[시험 실행 — 아무것도 바꾸지 않았습니다] 등록할 작업: ${name}`,
        ...summary,
        ...warnings.map((w) => `  경고          ${w}`),
        '실행할 명령',
        `  ${argv.create.join(' ')}`,
        `  ${argv.readback.join(' ')}  (등록한 작업을 작업 스케줄러 COM으로 그대로 다시 읽어 견줍니다 — 읽기만)`,
        '작업 XML (UTF-16, BOM — 임시 파일에 이대로 씁니다)',
        xml.replace(/\r\n/g, '\n'),
        '다시 읽기 스크립트 (Windows PowerShell 5.1 — 읽기만)',
        taskReadScript(name).trim(),
        '',
      ].join('\n'),
      err: '',
      json: { ok: true, result: { dryRun: true, name, xml, argv, readScript: taskReadScript(name), task: { ...inputs, arguments: taskArguments(inputs) }, warnings } },
    };
  }
  const outcome = await registerTask(name, inputs, { run: deps.run, ...(deps.tmpBase ? { tmpBase: deps.tmpBase } : {}), ...(deps.restrict ? { restrict: deps.restrict } : {}) });
  if (!outcome.ok) return fail(1, outcome.step === 'compare' ? 'mismatch' : 'schtasks', outcome.message);
  const quoted = winQuote(inputs.dataDir);
  return {
    code: 0,
    out: [
      `작업 스케줄러에 등록했습니다: ${name}`,
      ...summary,
      ...warnings.map((w) => `  경고          ${w}`),
      '다음 할 일',
      `  지금 띄우기   schtasks /run /tn ${name}`,
      `  확인          wook-server status --data-dir ${quoted}`,
      `  끄기          wook-server shutdown --data-dir ${quoted} (작업을 지워도 실행 중인 서버는 그대로입니다)`,
      "서버가 뜨면 '욱채 서버 (pid …)' 콘솔 창이 보입니다 — 그 창을 닫지 말고 wook-server shutdown으로 끄세요 (창을 닫으면 정리가 5초쯤에서 잘릴 수 있습니다)",
      '',
    ].join('\n'),
    err: '',
    json: { ok: true, result: { dryRun: false, name, registered: true, task: { ...inputs, arguments: taskArguments(inputs) }, warnings } },
  };
}

/** uninstall-task */
export async function uninstallTask(o: { dataDir: string; dryRun: boolean }, deps: Pick<TaskCommandDeps, 'platform' | 'run'>): Promise<TaskCommandResult> {
  if (deps.platform !== 'win32') return fail(2, 'unsupported', 'uninstall-task는 Windows에서만 씁니다 (Linux는 10단계)');
  const name = taskName(resolve(o.dataDir));
  const quoted = winQuote(resolve(o.dataDir));
  if (o.dryRun) {
    const argv = { exists: [...TASK_READ_SHOWN], delete: ['schtasks', ...schtasksArgs.delete(name)] };
    return {
      code: 0,
      out: [
        `[시험 실행 — 아무것도 바꾸지 않았습니다] 지울 작업: ${name}`,
        '실행할 명령',
        `  ${argv.exists.join(' ')}  (작업이 있는지 작업 스케줄러 COM으로 읽습니다 — 읽기만, 지운 뒤에도 한 번 더)`,
        `  ${argv.delete.join(' ')}`,
        '다시 읽기 스크립트 (Windows PowerShell 5.1 — 읽기만)',
        taskReadScript(name).trim(),
        '',
      ].join('\n'),
      err: '',
      json: { ok: true, result: { dryRun: true, name, argv, readScript: taskReadScript(name) } },
    };
  }
  const r = await unregisterTask(name, deps.run);
  if (!r.ok) return fail(1, 'schtasks', r.message);
  const stop = `실행 중인 서버는 끄지 않았습니다 — 끄려면 wook-server shutdown --data-dir ${quoted}`;
  return {
    code: 0,
    out: `${r.existed ? `작업 ${name}을 지웠습니다. ${stop}` : `등록된 작업이 없습니다 (${name}) — 바꾼 것이 없습니다`}\n`,
    err: '',
    json: { ok: true, result: { dryRun: false, name, existed: r.existed, removed: r.existed } },
  };
}
