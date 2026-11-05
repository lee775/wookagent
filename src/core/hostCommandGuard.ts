/**
 * host_exec가 실행하지 않는 명령 (SERVER_DESIGN 8.2, 리드 결정 S5-17·S5-32, 지도 host-exec §5): 서버 PC를 멈추게 할 수 있는 명령 — 디스크 포맷·diskpart·mkfs·
 * 디스크로 dd·루트 삭제·서버 PC 종료·재시작, 서버(이 프로세스) 자체를 죽이는 명령 — 과 서버 운영자 명령(wook-server — 메인 에이전트는 운영자가 아니다), 서버
 * 데이터 폴더를 가리키는 명령(실행 위치 검사의 명령 글자 쪽). 순수 함수다(파일·프로세스를 보지 않는다).
 *
 * 읽는 법 (S5-32·S5-39): 소문자로 바꾸고 cmd의 ^·PowerShell의 ` 이스케이프를 지운 뒤, 따옴표 밖의 && || & | ; 줄바꿈 { }에서 명령을 나눈다(짝 없는 따옴표는
 * 글자로 본다). 따옴표는 셸에 따라 다르다 — cmd(host_exec의 셸, shell:'cmd')는 큰따옴표만 따옴표이고 작은따옴표는 글자다(그래서 `echo 'a & shutdown'`의 shutdown은
 * 실제로 돌아 막는다). 안쪽이 PowerShell·sh인 감싸기는 작은따옴표도 따옴표로 읽는다. 나눈 명령마다 앞의 @(cmd 되풀이 끄기)·묶는 괄호·중괄호({ }, & { })를 떼고,
 * 따옴표를 지키며 낱말로 나눈 뒤 낱말마다 따옴표를 지운다. 감싸는 명령(cmd /c, powershell -c(옵션 줄임말·값 옵션을 가려냄), pwsh, start, Start-Process(saps),
 * call, sudo, env, bash -c, wsl, cmd의 if·for 등)은 벗겨 안쪽 명령으로 보고, 안쪽이 명령 줄이면 그 글을 다시 읽는다(PowerShell 안에서는 start·saps가 Start-Process다).
 * get-process가 서버를 가리키고 같은 파이프라인 뒤에 stop-process가 오면 서버 종료로 본다. 그래서 첫 낱말이 아닌 자리의 같은 글자(git log --format, echo shutdown)와
 * 따옴표 안의 같은 글자(git commit -m "…; reboot …")는 막지 않는다. 데이터 폴더 규칙만 낱말이 아니라 명령 글자 전체에서 그 경로(대소문자·빗금 방향 무시)와 관리 파일
 * 이름(admin.token·admin.endpoint·setup-code.txt)을 찾는다.
 *
 * 한계 (도구 설명과 SERVER_DESIGN 8.2에 그대로 적는다 — HOST_COMMAND_GUARD_LIMITS): 명령 글자만 본다. 실수를 막는 장치이지 일부러 피하려는 쪽을 막지
 * 않는다. CLI 자체의 셸이 돌리는 명령은 이 검사를 거치지 않는다. 출력에 찍힌 비밀 값은 이 목록이 아니라 백엔드 가리개가 가린다(S5-30).
 */

/** 도구 설명과 설계 문서(8.2)가 그대로 옮기는 한계 문장 (리드 결정 S5-17·S5-32·S5-39) */
export const HOST_COMMAND_GUARD_LIMITS =
  '이 거부 목록은 명령 글자만 봅니다 — 서버 운영자 명령과 서버 데이터 폴더도 그 이름이나 경로가 명령에 그대로 적혀 있을 때만 알아봅니다. 파일에 쓴 뒤 실행하는 스크립트, 변수·별칭·함수(%APPDATA% 같은 환경 변수로 쓴 경로나 cd로 옮긴 뒤 상대 경로로 가리키는 서버·데이터 폴더 포함), 인코딩한 명령(-EncodedCommand), 다른 언어의 한 줄 실행, 그 밖의 셸 문법은 보지 못합니다. cmd.exe에서는 작은따옴표가 따옴표가 아니라 그 안의 글도 명령으로 봅니다. 실수를 막는 장치이지 일부러 피하려는 쪽을 막는 장치가 아닙니다. CLI 자체의 셸로 돌리는 명령은 이 검사를 거치지 않습니다.';

export interface HostCommandContext {
  /** 서버(이 프로세스)의 PID — 그 PID를 끝내는 명령을 막는다 */
  serverPid: number;
  /** 서버 실행 파일 이름(예: node.exe, wookagent.exe). 모르면 null — 이름으로 끝내는 명령은 보지 않는다 */
  serverImage: string | null;
  /** 앱 데이터 폴더 — 명령 글자에 그 경로가 보이면 막는다 (리드 결정 S5-32). 모르면 null — 관리 파일 이름만 본다 */
  dataDir: string | null;
  /** host_exec가 실제로 쓰는 셸 (리드 결정 S5-39) — cmd는 큰따옴표만 따옴표(작은따옴표는 글자), posix는 둘 다 따옴표. 넘기는 것을 잊지 못하게 필수 칸이다 */
  shell: 'cmd' | 'posix';
}

export type HostCommandRule = '디스크 포맷' | 'diskpart' | '디스크로 dd' | '루트 삭제' | '서버 PC 종료·재시작' | '서버 종료' | '서버 운영자 명령' | '서버 데이터 폴더';

export interface HostCommandDenial {
  rule: HostCommandRule;
  /** 걸린 명령 조각 (고른 글자, 80자까지) */
  matched: string;
}

/** 감싸는 명령 — 안쪽 명령을 꺼내 다시 본다. cmd의 if·for도 몸을 꺼낸다 (리드 결정 S5-39) */
const WRAPPERS = new Set([
  'cmd', 'powershell', 'pwsh', 'start', 'start-process', 'saps', 'call', 'sudo', 'doas', 'env', 'bash', 'sh', 'zsh', 'dash', 'nohup', 'nice', 'time', 'exec', 'wsl', 'if', 'for',
]);
/** PowerShell 옵션 — 이름의 앞부분만 써도 된다(앞부분이 모호하지 않으면). 값을 하나 받는 옵션 (그 값은 명령이 아니다) */
const PS_VALUE_NAMES = ['executionpolicy', 'windowstyle', 'outputformat', 'inputformat', 'configurationname', 'workingdirectory', 'version', 'psconsolefile', 'settingsfile', 'custompipename'];
/**
 * 값 옵션의 정해진 별칭 — 앞부분이 아닌 것(-ep·-wd·-of·-if)이 있어 앞부분 맞추기만으로는 스위치로 읽혀 그 값을 안쪽 명령으로 봤다. 예전 목록의 별칭을 모두 둔다
 * (리드 결정 S5-46)
 */
const PS_VALUE_ALIASES = new Set(['ep', 'ex', 'w', 'wd', 'of', 'if', 'v']);
/** 명령 글을 받는 옵션과 그 이름 앞부분 별칭 */
const PS_COMMAND_NAMES = ['command', 'commandwithargs'];
const PS_COMMAND_ALIASES = new Set(['c', 'cwa']);
/** 볼 수 없는 옵션 — 인코딩한 명령·스크립트 파일 */
const PS_OPAQUE_NAMES = ['encodedcommand', 'file'];
const PS_OPAQUE_ALIASES = new Set(['e', 'ec', 'f']);
/** Start-Process에서 값을 하나 받는 옵션 (앞부분만 써도 된다 — -FilePath·-ArgumentList는 따로 본다) */
const SAPS_VALUE_OPTIONS = ['workingdirectory', 'credential', 'redirectstandardinput', 'redirectstandardoutput', 'redirectstandarderror', 'windowstyle', 'verb', 'environment'];
/** cmd if의 조건 — 낱말 하나를 받는 것과 비교 낱말 (리드 결정 S5-46) */
const IF_ONE_OPERAND = new Set(['errorlevel', 'exist', 'defined', 'cmdextversion']);
const IF_COMPARE = new Set(['equ', 'neq', 'lss', 'leq', 'gtr', 'geq']);
/** 감싸는 명령을 몇 겹까지 벗기는지 */
const MAX_DEPTH = 8;

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** 경로와 실행 파일 확장자를 뗀 이름 */
function programName(token: string): string {
  const base = token.split(/[\\/]/).pop() ?? token;
  return base.replace(/\.(exe|com|cmd|bat|ps1)$/, '');
}

/** 글자 고르기 — 소문자, cmd의 ^·PowerShell의 ` 이스케이프 지우기. 따옴표는 남긴다 — 나누기와 낱말 읽기가 따옴표를 본다 (S5-32) */
function normalize(command: string): string {
  return command.toLowerCase().replace(/[\^`]/g, '');
}

/** i 자리가 짝이 있는 따옴표의 시작인지 — 짝 없는 따옴표는 글자로 본다. cmd(single=false)에서는 작은따옴표를 따옴표로 보지 않는다 (리드 결정 S5-39) */
const opensQuote = (s: string, i: number, single: boolean): boolean => (s[i] === '"' || (single && s[i] === "'")) && s.indexOf(s[i]!, i + 1) !== -1;

/** 명령 하나의 앞뒤 다듬기 — 공백, cmd의 @(되풀이 끄기), 묶는 괄호·중괄호({ } — PowerShell 스크립트 블록, S5-39) */
const bare = (seg: string): string =>
  seg
    .replace(/\s+/g, ' ')
    .replace(/^[\s@({]+/, '')
    .replace(/[\s)}]+$/, '');

/** 나눈 명령 하나 — 글과, 바로 앞 명령에서 홑파이프(|)로 이어졌는지 (파이프라인 — get-process | stop-process를 보려고) */
interface Segment {
  text: string;
  piped: boolean;
}

/** 명령 나누기: 따옴표 밖의 && || & | ; 줄바꿈 { } (리드 결정 S5-32·S5-39 — 따옴표 안은 나누지 않는다. { }는 PowerShell 스크립트 블록 경계) */
function segmentsOf(text: string, single: boolean): Segment[] {
  const out: Segment[] = [];
  let cur = '';
  let piped = false;
  const push = (nextPiped: boolean): void => {
    const t = bare(cur);
    if (t) out.push({ text: t, piped });
    cur = '';
    piped = nextPiped;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (opensQuote(text, i, single)) {
      const close = text.indexOf(c, i + 1);
      cur += text.slice(i, close + 1);
      i = close;
    } else if (c === '&' || c === '|' || c === ';' || c === '\r' || c === '\n' || c === '{' || c === '}') {
      const doubled = (c === '&' || c === '|') && text[i + 1] === c;
      if (doubled) i++;
      // 홑파이프(|)만 파이프라인으로 잇는다. &&·||·&·;·줄바꿈·중괄호는 끊는다
      push(c === '|' && !doubled);
    } else cur += c;
  }
  push(false);
  return out;
}

/**
 * 낱말 하나 — 따옴표를 지운 글(t)과, 그 낱말이 따옴표로 쓰였는지(q), 낱말의 마지막 ==(따옴표 밖) 뒤에 따옴표 부분이 왔는지(qe). 따옴표로 쓴 빈 글("")은
 * { t: '', q: true } — 버리지 않는다. cmd start는 따옴표 낱말을 창 제목으로 건너뛰고(`start "제목" cmd …`), cmd if는 qe로 `"%a%"==`·`%x%==`(== 뒤가 비어 오른쪽
 * 값이 다음 낱말)과 `"%1"==""`(== 뒤에 따옴표 부분 — 그 낱말에서 비교가 끝남)을, `==""`(연산자와 오른쪽 값)과 홀로 쓴 `==`를 가른다. 안쪽 프로그램을 집는
 * 자리는 앞의 빈 따옴표 낱말(`cmd /c "" …`)을 건너뛴다 (리드 결정 S5-52·S5-58)
 */
interface Token {
  t: string;
  q: boolean;
  qe: boolean;
}
const texts = (ts: readonly Token[]): string[] => ts.map((x) => x.t);
/** 앞의 빈 따옴표 낱말(`cmd /c "" …`·`-Command "" …`)을 건너뛴다 — 그다음을 프로그램으로 본다 (리드 결정 S5-52) */
const dropEmpty = (ts: Token[]): Token[] => {
  let k = 0;
  while (k < ts.length && ts[k]!.t === '' && ts[k]!.q) k++;
  return ts.slice(k);
};

/**
 * 낱말로 나누기: 따옴표 안의 공백은 낱말을 나누지 않고, 낱말마다 따옴표를 지운다. cmd(single=false)에서는 작은따옴표를 글자로 남긴다 (S5-39). 따옴표 여부(q)와
 * 따옴표 밖의 마지막 == 뒤에 따옴표 부분이 왔는지(qe)를 싣는다 (S5-52·S5-58)
 */
function tokensOf(seg: string, single: boolean): Token[] {
  const out: Token[] = [];
  let cur = '';
  let quoted = false;
  let afterEq = false;
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i]!;
    if (opensQuote(seg, i, single)) {
      const close = seg.indexOf(c, i + 1);
      cur += seg.slice(i + 1, close);
      quoted = true;
      afterEq = true;
      i = close;
    } else if (c === ' ') {
      if (cur || quoted) out.push({ t: cur, q: quoted, qe: afterEq });
      cur = '';
      quoted = false;
      afterEq = false;
    } else if (c !== '"' && !(single && c === "'")) {
      cur += c;
      // 따옴표 밖의 == — 그 뒤에 따옴표 부분이 오는지 다시 본다
      if (c === '=' && cur.endsWith('==')) afterEq = false;
    }
  }
  if (cur || quoted) out.push({ t: cur, q: quoted, qe: afterEq });
  return out;
}

/** 감싸는 명령의 안쪽: 안쪽 명령 낱말 후보들, 그 낱말을 이은 글을 명령 줄로 다시 읽을지, 그리고 안쪽 셸의 따옴표 규칙(single)과 PowerShell 여부(ps) */
interface Inner {
  argv: Token[][];
  line: boolean;
  single: boolean;
  ps: boolean;
}

/** PowerShell 옵션의 갈래 — 앞부분이 모호하지 않게 짧게 써도 PowerShell이 맞춰 준다 (리드 결정 S5-39) */
function psOptionKind(opt: string): 'command' | 'opaque' | 'value' | 'switch' {
  const key = opt.replace(/^-+/, '').split(':')[0] ?? '';
  if (!key) return 'switch';
  if (PS_COMMAND_ALIASES.has(key) || PS_COMMAND_NAMES.some((n) => n.startsWith(key))) return 'command';
  if (PS_OPAQUE_ALIASES.has(key) || PS_OPAQUE_NAMES.some((n) => n.startsWith(key))) return 'opaque';
  if (PS_VALUE_ALIASES.has(key) || PS_VALUE_NAMES.some((n) => n.startsWith(key))) return 'value';
  return 'switch';
}

/** Start-Process(saps, PowerShell의 start)의 실행 파일과 인자 — -FilePath 값이나 옵션이 아닌 첫 낱말, -ArgumentList 값(쉼표·공백으로 나눔)이나 옵션이 아닌 둘째 낱말부터 */
function startProcess(rest: string[]): Inner {
  let file: string | null = null;
  const args: string[] = [];
  // Start-Process는 PowerShell이라 인자의 작은따옴표도 따옴표다 — cmd에서 낱말을 나눌 때 남은 따옴표를 뗀다 (리드 결정 S5-39)
  const deq = (s: string) => s.replace(/^['"]+/, '').replace(/['"]+$/, '');
  const split = (v: string) => v.split(/[\s,]+/).map(deq).filter(Boolean);
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i]!;
    if (t.length > 1 && t.startsWith('-')) {
      const colon = t.indexOf(':');
      const opt = colon > 0 ? t.slice(1, colon) : t.slice(1);
      const value = (): string => (colon > 0 ? t.slice(colon + 1) : (rest[++i] ?? ''));
      // PowerShell은 옵션 이름의 앞부분만 써도 된다
      const is = (full: string) => full.startsWith(opt);
      if (is('filepath') || opt === 'pspath' || opt === 'path') file = deq(value());
      else if (is('argumentlist') || opt === 'args') args.push(...split(value()));
      else if (SAPS_VALUE_OPTIONS.some(is)) value();
    } else if (file === null) file = deq(t) || null;
    else args.push(...split(t));
  }
  // 따옴표는 이미 떼었으므로 q는 쓰지 않는다
  return { argv: file ? [[file, ...args].map((x) => ({ t: x, q: false, qe: false }))] : [], line: true, single: true, ps: true };
}

/**
 * 감싸는 명령의 안쪽 (감싸는 명령이 아니면 undefined). 볼 수 없는 꼴(-EncodedCommand, 스크립트 파일)이면 null.
 * single·ps는 지금 명령이 든 셸의 규칙 — 다시 읽지 않는 감싸기(sudo·env·start(cmd)·if·for)는 그대로 물려주고, 명령 줄을 다시 읽는 감싸기는 그 셸의 규칙을 준다
 */
function unwrap(tokens: Token[], single: boolean, ps: boolean): Inner | null | undefined {
  const name = programName(tokens[0]!.t);
  if (!WRAPPERS.has(name)) return undefined;
  const rest = tokens.slice(1);
  let i = 0;
  switch (name) {
    case 'cmd':
      // cmd /d /s /q /c <명령> — /c·/k 뒤가 안쪽 명령 줄 (cmd 셸). 그 뒤 빈 따옴표 낱말(`cmd /c "" …`)은 건너뛴다 (리드 결정 S5-52)
      while (i < rest.length && rest[i]!.t.startsWith('/') && rest[i]!.t !== '/c' && rest[i]!.t !== '/k') i++;
      if (i < rest.length && (rest[i]!.t === '/c' || rest[i]!.t === '/k')) return { argv: [dropEmpty(rest.slice(i + 1))], line: true, single: false, ps: false };
      return { argv: [dropEmpty(rest.slice(i))], line: true, single: false, ps: false };
    case 'powershell':
    case 'pwsh':
      while (i < rest.length && rest[i]!.t.startsWith('-')) {
        const kind = psOptionKind(rest[i]!.t);
        // -Command 뒤 빈 따옴표 낱말(`-c "" …`)은 건너뛴다 (리드 결정 S5-52)
        if (kind === 'command') return { argv: [dropEmpty(rest.slice(i + 1))], line: true, single: true, ps: true };
        if (kind === 'opaque') return null;
        i += kind === 'value' && !rest[i]!.t.includes(':') ? 2 : 1;
      }
      return { argv: [dropEmpty(rest.slice(i))], line: true, single: true, ps: true };
    case 'start': {
      // PowerShell 안에서는 start가 Start-Process다. cmd에서는 start ["제목"] [/b /wait …] <명령> — 첫 따옴표 낱말 하나를 제목으로, 스위치를 건너뛴다 (리드 결정 S5-52)
      if (ps) return startProcess(texts(rest));
      let title = false;
      while (i < rest.length) {
        if (rest[i]!.t.startsWith('/')) i++;
        else if (!title && rest[i]!.q) ((title = true), i++);
        else break;
      }
      return { argv: [rest.slice(i)], line: false, single, ps };
    }
    case 'start-process':
    case 'saps':
      return startProcess(texts(rest));
    case 'sudo':
    case 'doas':
      while (i < rest.length && rest[i]!.t.startsWith('-')) i += rest[i]!.t === '-u' || rest[i]!.t === '-g' ? 2 : 1;
      return { argv: [rest.slice(i)], line: false, single, ps };
    case 'env':
      while (i < rest.length && (rest[i]!.t.startsWith('-') || rest[i]!.t.includes('='))) i++;
      return { argv: [rest.slice(i)], line: false, single, ps };
    case 'bash':
    case 'sh':
    case 'zsh':
    case 'dash': {
      const c = rest.findIndex((t) => /^-[a-z]*c[a-z]*$/.test(t.t));
      if (c >= 0) return { argv: [dropEmpty(rest.slice(c + 1))], line: true, single: true, ps: false };
      return rest.length && !rest[0]!.t.startsWith('-') ? null : { argv: [rest], line: false, single, ps };
    }
    case 'nice':
      while (i < rest.length && rest[i]!.t.startsWith('-')) i += rest[i]!.t === '-n' ? 2 : 1;
      return { argv: [rest.slice(i)], line: false, single, ps };
    case 'wsl':
      while (i < rest.length && rest[i]!.t.startsWith('-')) i += ['-d', '--distribution', '-u', '--user', '--cd'].includes(rest[i]!.t) ? 2 : 1;
      return { argv: [dropEmpty(rest.slice(i))], line: true, single: true, ps: false };
    case 'if': {
      // cmd: if [/i] [not] errorlevel|exist|defined|cmdextversion X <명령> / if a==b <명령>(== 앞뒤 공백, 빈 글 "" 포함) / if a equ|neq|lss|leq|gtr|geq b <명령> /
      // if … (<명령>) [else (<명령>)] — 조건을 건너뛰고 몸을 본다 (리드 결정 S5-39·S5-46·S5-52·S5-58)
      let j = 0;
      while (j < rest.length && (rest[j]!.t === '/i' || rest[j]!.t === 'not')) j++;
      const a = rest[j] ?? { t: '', q: false, qe: false };
      const b = rest[j + 1] ?? { t: '', q: false, qe: false };
      if (IF_ONE_OPERAND.has(a.t)) j += 2;
      // a==b(한 낱말) / a== b·"%a%"== "1"(끝이 ==이고 그 뒤에 따옴표 부분이 없다 — 오른쪽 값은 다음 낱말) / "%1"==""(== 뒤에 따옴표 부분 — 그 낱말에서 비교가
      // 끝나 몸이 바로 뒤) (리드 결정 S5-58)
      else if (a.t.includes('==')) j += a.t.endsWith('==') && !a.qe ? 2 : 1;
      // a == b · a equ b (홀로 쓴 ==)
      else if ((b.t === '==' && !b.qe) || IF_COMPARE.has(b.t)) j += 3;
      // a ==b · a =="" · a =="x" (== 뒤에 오른쪽 값이 붙은 낱말 — 몸은 그 뒤, 리드 결정 S5-58)
      else if (b.t.startsWith('==')) j += 2;
      else j += 1;
      const body = rest.slice(j);
      // (<명령>) else (<명령>) — else 뒤의 몸도 본다
      const e = body.findIndex((t, k) => k > 0 && t.t === 'else' && body[k - 1]!.t.endsWith(')'));
      return { argv: e >= 0 ? [body.slice(0, e), body.slice(e + 1)] : [body], line: false, single, ps };
    }
    case 'for': {
      // cmd: for … do <명령> (리드 결정 S5-39)
      const d = rest.findIndex((t) => t.t === 'do');
      return d >= 0 ? { argv: [rest.slice(d + 1)], line: false, single, ps } : undefined;
    }
    default:
      // call·nohup·time·exec — 그 뒤 빈 따옴표 낱말도 건너뛴다 (리드 결정 S5-52)
      while (i < rest.length && rest[i]!.t.startsWith('-')) i++;
      return { argv: [dropEmpty(rest.slice(i))], line: false, single, ps };
  }
}

/** 드라이브 루트 (C: C:\ C:/) — format의 대상 */
const DRIVE_ROOT_RE = /^[a-z]:[\\/]?$/;
/** 지울 대상이 드라이브·루트 폴더 자체 (C: C:\ C:/ \ /) */
const ROOT_DIR_RE = /^([a-z]:[\\/]?|[\\/])$/;
/** 지울 대상이 드라이브·루트 폴더의 모든 파일 (C:\* C:\*.* \* /*) */
const ROOT_FILES_RE = /^([a-z]:)?[\\/]\*(\.\*)?$/;
const LINUX_DISK_RE = /^\/dev\/(sd|nvme|vd|xvd|hd|mmcblk|disk|mapper\/|md|loop)/;
/** cmd 스위치가 있는지 — /s /q처럼 따로 쓰든 /s/q처럼 붙여 쓰든 */
const hasSwitch = (args: readonly string[], sw: string): boolean => args.some((a) => a.startsWith('/') && a.split('/').includes(sw));
/** 되풀이(재귀) 지우기 옵션: -r·-R·-rf·-fr 같은 짧은 옵션 묶음, --recursive, PowerShell -Recurse(앞부분만 써도 된다) */
const isRecursiveFlag = (a: string): boolean => (/^-[a-z]{1,4}$/.test(a) && a.includes('r')) || a === '--recursive' || (a.length >= 2 && '-recurse'.startsWith(a));

/** 서버 진입점 — 운영자 명령 wook-server의 본체 (`node out/server/index.mjs <명령>`, SERVER_DESIGN 3.2) */
const SERVER_ENTRY_RE = /out[\\/]server[\\/]index\.mjs$/;
/** node가 값을 하나 받는 옵션 (그 값은 스크립트가 아니다) */
const NODE_VALUE_OPTIONS = new Set(['-r', '--require', '--import', '--loader', '--experimental-loader', '--conditions', '--input-type', '--title', '--env-file', '--inspect-port']);

/** node가 돌릴 스크립트 — 옵션이 아닌 첫 낱말. -e·-p(글로 준 코드)면 null */
function nodeScript(args: readonly string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '-e' || a === '--eval' || a === '-p' || a === '--print') return null;
    if (a === '--') return args[i + 1] ?? null;
    if (!a.startsWith('-')) return a;
    if (NODE_VALUE_OPTIONS.has(a)) i++;
  }
  return null;
}

/** 그 명령 하나(감싸는 명령을 벗긴 낱말)가 막을 명령인지 */
function denyTokens(tokens: string[], o: HostCommandContext): HostCommandRule | null {
  const name = programName(tokens[0]!);
  const args = tokens.slice(1);
  // 디스크 포맷: format <드라이브>: (git log --format·prettier --format은 첫 낱말이 아니라 걸리지 않는다)
  if (name === 'format' && args.some((a) => DRIVE_ROOT_RE.test(a))) return '디스크 포맷';
  if (['format-volume', 'clear-disk', 'initialize-disk', 'remove-partition', 'reset-physicaldisk'].includes(name)) return '디스크 포맷';
  if (name === 'mkfs' || name.startsWith('mkfs.') || name === 'mke2fs' || name === 'wipefs') return '디스크 포맷';
  if (name === 'mkswap' && args.some((a) => a.startsWith('/dev/'))) return '디스크 포맷';
  if (name === 'sgdisk' && args.some((a) => a === '-z' || a === '-o' || a.startsWith('--zap') || a === '--clear')) return '디스크 포맷';
  if (name === 'shred' && args.some((a) => a.startsWith('/dev/'))) return '디스크 포맷';
  if (name === 'diskpart') return 'diskpart';
  // 디스크로 dd: of=\\.\physicaldrive…·of=\\.\C:·of=/dev/sd… (/dev/null·zero·stdout·stderr는 된다)
  if (name === 'dd') {
    const out = args.find((a) => a.startsWith('of='))?.slice(3) ?? '';
    if (/^\\\\\.\\(physicaldrive|[a-z]:)/.test(out) || LINUX_DISK_RE.test(out)) return '디스크로 dd';
  }
  // 루트 삭제
  // 루트 삭제 — cmd rd /s·del /s, PowerShell Remove-Item -Recurse(별칭 rm·ri·del·erase·rmdir·rd), POSIX rm -r
  if ((name === 'rd' || name === 'rmdir') && hasSwitch(args, 's') && args.some((a) => ROOT_DIR_RE.test(a))) return '루트 삭제';
  if ((name === 'del' || name === 'erase') && hasSwitch(args, 's') && args.some((a) => ROOT_DIR_RE.test(a) || ROOT_FILES_RE.test(a))) return '루트 삭제';
  if (['rm', 'ri', 'del', 'erase', 'rmdir', 'rd', 'remove-item'].includes(name) && args.some(isRecursiveFlag)) {
    if (args.includes('--no-preserve-root') || args.some((a) => ROOT_DIR_RE.test(a) || ROOT_FILES_RE.test(a))) return '루트 삭제';
  }
  // 서버 PC 종료·재시작 — shutdown /a(취소)·/?(도움말)·-c(취소)만은 된다
  if (name === 'shutdown') {
    const harmless = new Set(['/a', '-a', '/?', '-?', '-c', '--help']);
    if (!(args.length > 0 && args.every((a) => harmless.has(a)))) return '서버 PC 종료·재시작';
  }
  if (['stop-computer', 'restart-computer', 'logoff', 'reboot', 'poweroff', 'halt'].includes(name)) return '서버 PC 종료·재시작';
  if ((name === 'init' || name === 'telinit') && args.some((a) => a === '0' || a === '6')) return '서버 PC 종료·재시작';
  if (name === 'systemctl' && args.some((a) => ['poweroff', 'reboot', 'halt', 'kexec'].includes(a))) return '서버 PC 종료·재시작';
  const image = o.serverImage ? programName(o.serverImage.toLowerCase()) : null;
  // 서버 운영자 명령 (리드 결정 S5-32) — 어느 하위 명령이든(status·config show 포함): 메인 에이전트는 운영자가 아니다. wook-server, 서버 진입점을 띄우는 node(또는
  // 서버 실행 파일), npm·pnpm·yarn의 start:server
  if (name === 'wook-server') return '서버 운영자 명령';
  if ((name === 'node' || name === image) && SERVER_ENTRY_RE.test(nodeScript(args) ?? '')) return '서버 운영자 명령';
  if ((name === 'npm' || name === 'pnpm' || name === 'yarn') && args.includes('start:server')) return '서버 운영자 명령';
  // 서버 자체를 죽이는 명령 — 서버 PID나 서버 실행 파일 이름
  const pid = String(o.serverPid);
  const matches = (v: string | undefined): boolean => imageMatches(v, image);
  if (name === 'taskkill') {
    const after = (flag: string) => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));
    const fis = after('/fi').map((f) => (f ?? '').trim());
    // /fi "imagename eq node.exe"·/fi "pid eq 1234" (S5-32)
    const filtered = fis.some((f) => {
      const m = /^(imagename|pid) eq (\S+)$/.exec(f);
      return !!m && (m[1] === 'pid' ? m[2] === pid : matches(m[2]));
    });
    if (after('/pid').includes(pid) || after('/im').some(matches) || filtered) return '서버 종료';
    // /fi "username eq …"·"session eq …"는 그 사용자·세션의 모든 프로세스를 끝낸다 — 작업·PID로 좁히지 않으면 서버도 끝난다 (리드 결정 S5-39)
    const userOrSession = fis.some((f) => /^(username|session) /.test(f));
    const narrowed = fis.some((f) => /^(imagename|pid) /.test(f)) || after('/im').length > 0 || after('/pid').length > 0;
    if (userOrSession && !narrowed) return '서버 종료';
  }
  if (name === 'stop-process' || name === 'spps' || name === 'kill') {
    // -Name·-Id 값은 쉼표로 묶은 배열일 수 있다 (리드 결정 S5-39)
    if (args.some((a) => a === pid || a === `-${pid}`) || arrayAfter(args, ['-id']).includes(pid)) return '서버 종료';
    if (arrayAfter(args, ['-name', '-processname', '-n']).some(matches)) return '서버 종료';
  }
  if ((name === 'pkill' || name === 'killall') && args.some((a) => !a.startsWith('-') && matches(a))) return '서버 종료';
  // wmic process … name=<이름> … delete|terminate, wmic process where processid=<pid> … call terminate (리드 결정 S5-39)
  if (name === 'wmic' && args.includes('process') && args.some((a) => a === 'delete' || a === 'terminate' || a === 'call')) {
    const joined = args.join(' ');
    const nm = /name=['"]?([^\s'"]+)/.exec(joined);
    if (nm && matches(nm[1])) return '서버 종료';
    const pm = /processid=['"]?(\d+)/.exec(joined);
    if (pm && pm[1] === pid) return '서버 종료';
  }
  return null;
}

/** 서버 실행 파일 이름 (경로·확장자를 뗀 소문자, 와일드카드 가능), 모르면 null */
function serverImageName(o: HostCommandContext): string | null {
  return o.serverImage ? programName(o.serverImage.toLowerCase()) : null;
}

/** v(이미지 이름·경로)가 서버 실행 파일 이름과 같은지 — 와일드카드(node*)도 본다 */
function imageMatches(v: string | undefined, image: string | null): boolean {
  if (!image || !v) return false;
  const want = programName(v);
  if (!want.includes('*')) return want === image;
  return new RegExp(`^${want.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(image);
}

/** 플래그 뒤의 값들 — 다음 옵션 전까지 모아 쉼표·공백으로 나눈다 (PowerShell 배열 인자, 리드 결정 S5-39) */
function arrayAfter(args: readonly string[], flags: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (!flags.includes(args[i]!)) continue;
    const collect: string[] = [];
    for (let j = i + 1; j < args.length && !args[j]!.startsWith('-'); j++) collect.push(args[j]!);
    out.push(...collect.join(' ').split(/[\s,]+/).filter(Boolean));
  }
  return out;
}

/** get-process(gps·ps)가 서버(이미지·PID)를 가리키는지 — 같은 파이프라인 뒤의 stop-process와 함께 서버 종료로 본다 (리드 결정 S5-39) */
function getProcessNamesServer(tokens: string[], o: HostCommandContext): boolean {
  const name = programName(tokens[0] ?? '');
  if (name !== 'get-process' && name !== 'gps' && name !== 'ps') return false;
  const args = tokens.slice(1);
  const image = serverImageName(o);
  if (arrayAfter(args, ['-name', '-processname', '-n']).some((v) => imageMatches(v, image))) return true;
  if (arrayAfter(args, ['-id']).includes(String(o.serverPid))) return true;
  const positional = args.find((a) => !a.startsWith('-'));
  return positional !== undefined && positional.split(/[\s,]+/).some((v) => imageMatches(v, image));
}

/** stop-process(spps·kill)인지 — 파이프라인으로 받은 프로세스를 끝낸다 */
function isStopProcess(tokens: string[]): boolean {
  const name = programName(tokens[0] ?? '');
  return name === 'stop-process' || name === 'spps' || name === 'kill';
}

/** 이름·경로 조각이 이어지는 글자 — 데이터 폴더·관리 파일 이름의 앞뒤가 이 글자면 다른 이름이다(D:\wook-data2, myadmin.token) */
const NAME_CHAR_RE = /[\p{L}\p{N}_.-]/u;
/** 데이터 폴더 안의 관리 파일 — 관리 토큰·관리 채널 자리·설정 코드 (리드 결정 S5-32, SERVER_DESIGN 3.2) */
const ADMIN_FILES = ['admin.token', 'admin.endpoint', 'setup-code.txt'];
/** 경로 비교용 글 — 따옴표를 지우고 빗금을 한 방향(/)으로, 겹친 빗금은 하나로 (소문자는 normalize가 했다) */
const pathText = (s: string): string => s.replace(/["']/g, '').replace(/\\/g, '/').replace(/\/{2,}/g, '/');

/** 글 안에 그 이름이 앞뒤가 끊긴 채(다른 이름의 일부가 아니게) 들어 있는지 */
function namesWhole(text: string, name: string): boolean {
  for (let i = text.indexOf(name); i !== -1; i = text.indexOf(name, i + 1)) {
    const before = i > 0 ? text[i - 1]! : '';
    const after = text[i + name.length] ?? '';
    if (!NAME_CHAR_RE.test(before) && !NAME_CHAR_RE.test(after)) return true;
  }
  return false;
}

/** 명령 하나가 서버 데이터 폴더(경로 — 대소문자·빗금 방향 무시)나 그 안의 관리 파일 이름을 가리키는지 (실행 위치 검사의 명령 글자 쪽, S5-32) */
function namesDataFolder(seg: string, dataDir: string | null): boolean {
  const text = pathText(seg);
  const dir = dataDir ? pathText(dataDir.toLowerCase()).replace(/\/+$/, '') : '';
  return (dir.length > 0 && namesWhole(text, dir)) || ADMIN_FILES.some((f) => namesWhole(text, f));
}

/** 명령 하나(낱말)를 보고, 감싸는 명령이면 안쪽까지 본다 — 앞의 빈 따옴표 낱말(`cmd /c "" …`)은 건너뛴다 (리드 결정 S5-52) */
function scanCommand(tokens: Token[], seg: string, o: HostCommandContext, single: boolean, ps: boolean, depth: number): HostCommandDenial | null {
  const ts = dropEmpty(tokens);
  const first = (ts[0]?.t ?? '').replace(/^[@({]+/, '');
  const t: Token[] = first ? [{ ...ts[0]!, t: first }, ...ts.slice(1)] : ts.slice(1);
  if (!t.length) return null;
  const rule = denyTokens(texts(t), o);
  if (rule) return { rule, matched: clip(seg, 80) };
  if (depth >= MAX_DEPTH) return null;
  const inner = unwrap(t, single, ps);
  if (!inner) return null; // 감싸는 명령이 아니거나(undefined) 볼 수 없는 꼴(null)
  for (const a of inner.argv) {
    if (!a.length) continue;
    const byToken = scanCommand(a, seg, o, inner.single, inner.ps, depth + 1);
    if (byToken) return byToken;
    // 안쪽이 명령 줄이면(cmd /c "a & b"·powershell -c "…") 그 글을 그 셸의 규칙으로 다시 읽는다 — 파이프라인·구분자·따옴표를 본다
    if (inner.line) {
      const byLine = scanText(texts(a).join(' '), o, inner.single, inner.ps, depth + 1);
      if (byLine) return { rule: byLine.rule, matched: clip(seg, 80) };
    }
  }
  return null;
}

/** 명령 글 하나(셸 한 겹)를 나누고 본다 — 파이프라인의 get-process → stop-process, 명령마다 거부 규칙, 데이터 폴더 */
function scanText(text: string, o: HostCommandContext, single: boolean, ps: boolean, depth: number): HostCommandDenial | null {
  if (depth > MAX_DEPTH) return null;
  let sawServerGetProcess = false;
  for (const seg of segmentsOf(text, single)) {
    const tokens = tokensOf(seg.text, single);
    const plain = texts(tokens);
    if (!seg.piped) sawServerGetProcess = false; // 홑파이프로 이어지지 않으면 파이프라인이 끊긴다
    if (getProcessNamesServer(plain, o)) sawServerGetProcess = true;
    else if (sawServerGetProcess && isStopProcess(plain)) return { rule: '서버 종료', matched: clip(seg.text, 80) };
    const byCmd = scanCommand(tokens, seg.text, o, single, ps, depth);
    if (byCmd) return byCmd;
    if (namesDataFolder(seg.text, o.dataDir)) return { rule: '서버 데이터 폴더', matched: clip(seg.text, 80) };
  }
  return null;
}

/** 막을 명령이면 그 규칙과 걸린 조각, 아니면 null (리드 결정 S5-17·S5-32·S5-39) */
export function hostCommandDenied(command: string, o: HostCommandContext): HostCommandDenial | null {
  return scanText(normalize(command), o, o.shell === 'posix', false, 0);
}

/** 거부 글 (도구 결과 forbidden — 지도 host-exec §5, 운영자 명령·데이터 폴더는 리드 결정 S5-32) */
export function hostCommandRefusal(d: HostCommandDenial, shell: 'cmd' | 'posix' = 'cmd'): string {
  if (d.rule === '서버 운영자 명령') {
    return `서버 운영자 명령(wook-server)이라 실행하지 않았습니다 ("${d.matched}") — 운영자 명령은 서버 PC의 운영자가 쓰는 것이라, 메인 에이전트는 상태 보기를 포함해 어떤 운영자 명령도 돌리지 않습니다. 운영자가 할 일이 있으면 ask_owner로 대표에게 알리세요`;
  }
  if (d.rule === '서버 데이터 폴더') {
    return `앱 데이터 폴더나 그 안의 관리 파일(admin.token·admin.endpoint·setup-code.txt)을 가리키는 명령이라 실행하지 않았습니다 ("${d.matched}") — 데이터 폴더는 host_exec로 읽거나 바꾸지 않습니다. 앱의 기록은 search_activity·get_overview로 보세요`;
  }
  // cmd.exe는 작은따옴표를 글자로 봐서 그 안의 명령도 본다 — 걸린 조각에 작은따옴표가 있으면 큰따옴표를 쓰라고 일러 준다 (리드 결정 S5-39)
  const quoteHint = shell === 'cmd' && d.matched.includes("'") ? ' (cmd에서는 작은따옴표가 글자로 남아 그 안이 명령으로 읽힙니다 — 메시지·인자에는 큰따옴표를 쓰세요)' : '';
  return `서버 PC를 멈추게 할 수 있는 명령이라 실행하지 않았습니다 (${d.rule}: "${d.matched}") — 디스크 포맷·diskpart·mkfs·디스크로 dd·루트 삭제·서버 PC 종료·재시작·서버 종료는 host_exec로 하지 않습니다${quoteHint}`;
}
