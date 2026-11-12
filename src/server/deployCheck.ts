/**
 * 배포 점검 `wook-server check [--json] [--dry-run]` (SERVER_DESIGN 3.2·8.3.1·10.9, 리드 결정 S9-4): 서버 PC가 휴대폰에서 늘 닿고 화면 조작을 할 수 있게 놓였는지
 * 본다. 아무것도 바꾸지 않는다 — 고칠 길(fix)은 글로만 준다.
 * - 바꾸지 않는 PowerShell 점검 하나(Windows PowerShell 5.1 `-NoProfile -NonInteractive -EncodedCommand`, 10초)가 JSON(ASCII만) 하나를 낸다: 세션, 자동 로그온
 *   (Winlogon 값 이름만 보고 DefaultPassword의 값은 읽지 않는다), 화면 보호기·동적 잠금·InactivityTimeoutSecs, powercfg /qh(숨은 설정도 — 지역화된 글이 아니라
 *   16진 색인을 읽는다), 작업 스케줄러의 이 데이터 폴더 작업(읽기만), 데이터 폴더의 권한(Get-Acl — 읽기만), LanmanServer·Tailscale 쪽 445 막기 규칙,
 *   tailscale status·serve status, AI 키 환경 변수의 이름(값은 읽지 않는다). CLI 둘은 상태 확인 명령만(claude auth status --json, codex login status)
 * - 순수 함수(deployItems)가 그 사실들을 항목 {id, level ok|warn|fail|skip, text, fix}로 바꾼다 — 실패가 하나라도 있으면 끝 코드 1. 고칠 길이 wook-server
 *   명령이면 늘 점검한 데이터 폴더(--data-dir)를 붙인다 — 그대로 치면 다른(기본) 데이터 폴더로 가지 않게 (리드 결정 S9-22 DF-1)
 * - 서버(serve.ts)는 준비된 뒤 한 번, 기다리지 않고 돌린다(startDeployCheck): 시험(VITEST) 중에는 돌리지 않고, 준비를 늦추지 않고, 기록에는 요약 한 줄만 쓴다
 *   (비밀 값은 어느 항목에도 없다). 결과는 관리 status의 deploy다
 * 서버가 돌고 있으면 운영자 명령 check는 그 서버의 status(관리 채널 전송·화면 조작)와 config show(인증 방식·API 키 등록 여부)도 본다
 */
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import type { AiKind } from '@shared/domain';
import type { ApiKeyState } from '../main/backend/types';
import { buildChildEnv } from '../main/agents/common';
import { cliLauncherEnv, parseClaudeAuthStatus, parseCodexLoginStatus, resolveCli, runCommand, type RunCommand } from '../main/agents/resolveCli';
import { operatorRequest } from './admin';
import { adminPipeFallbackWarning, type AdminPipeInfo } from './adminPipe';
import { readServerConfig, serverConfigPath, type ServerConfigView } from './config';
import type { AdminStatus } from './server';
import { appRootFrom, argsHoldTestSession, leastPrivilege, parseTaskXml, sameAccount, SERVICE_SIDS, system32, TASK_NAME_RE, taskArgvProblems, taskName, taskPortOf, winQuote } from './task';

export type DeployLevel = 'ok' | 'warn' | 'fail' | 'skip';
export type DeployItemId = 'probe' | 'session' | 'autologon' | 'lock' | 'sleep' | 'task' | 'dataDir' | 'node' | 'cli.claude' | 'cli.codex' | 'apikey-env' | 'screen' | 'smb' | 'tailscale';

export interface DeployItem {
  id: DeployItemId;
  level: DeployLevel;
  text: string;
  /** 고치는 길 (통과·건너뜀이면 null) */
  fix: string | null;
}

/** 관리 status의 deploy (리드 결정 S9-2) */
export interface DeployReport {
  checkedAt: string;
  items: DeployItem[];
}

/** 항목 이름 (표·요약) */
export const ITEM_LABEL: Record<DeployItemId, string> = {
  probe: '점검 스크립트',
  session: '세션',
  autologon: '자동 로그온',
  lock: '화면 잠금',
  sleep: '절전',
  task: '작업 스케줄러',
  dataDir: '데이터 폴더',
  node: 'Node',
  'cli.claude': 'Claude CLI',
  'cli.codex': 'Codex CLI',
  'apikey-env': 'API 키 환경 변수',
  screen: '화면 조작',
  smb: 'SMB(관리 채널)',
  tailscale: 'Tailscale',
};

/** 점검의 상한 (리드 결정 S9-4) */
export const PROBE_TIMEOUT_MS = 10_000;
/** CLI 상태 확인 하나의 상한 */
export const CLI_STATUS_TIMEOUT_MS = 15_000;
/** 서버 기본 포트 (server.ts DEFAULT_PORT — 이 파일은 서버 모듈을 불러오지 않는다) */
const DEFAULT_PORT = 7317;
/** AI마다 API 키를 싣는 환경 변수 (구독 방식이면 CLI가 이 키로 요금을 낼 수 있다 — KNOWN_ISSUES S5-21). CLAUDE_CODE_OAUTH_TOKEN은 구독의 토큰이라 넣지 않는다 */
export const API_KEY_ENV_NAMES: Readonly<Record<AiKind, readonly string[]>> = {
  claude: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
  codex: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
};

// ───────────────────────── PowerShell 점검 ─────────────────────────

/** 점검이 값을 읽는 레지스트리 값 이름 — 이것 밖은 이름만 본다. 'Password'가 든 이름은 점검 스크립트의 RegValue가 늘 거부한다 */
export const PROBE_VALUE_NAMES: readonly string[] = [
  'AutoAdminLogon',
  'DefaultUserName',
  'DefaultDomainName',
  'ScreenSaveActive',
  'ScreenSaverIsSecure',
  'SCRNSAVE.EXE',
  'EnableGoodbye',
  'InactivityTimeoutSecs',
];

/**
 * 점검 스크립트 (Windows PowerShell 5.1). 읽기만 한다: Get-Item(키)의 GetValueNames·GetValue(위 이름만), powercfg /qh, 작업 스케줄러 COM의 GetTask(읽기),
 * 데이터 폴더의 Get-Acl, Get-Service, Get-NetFirewallRule, tailscale status·serve status. Get-ItemProperty는 쓰지 않는다(모든 값을 읽는다 — DefaultPassword 포함).
 * 콘솔 코드 페이지를 바꾸지 않는다(같은 콘솔을 쓰는 운영자 창이 바뀐다) — 대신 JSON의 ASCII 밖 글자를 모두 \\uXXXX로 적는다.
 * 데이터 폴더 경로는 UTF-16LE base64로 넣는다 — 경로의 따옴표(PowerShell은 ‘’도 따옴표로 본다)가 스크립트를 바꾸지 못하게
 */
export function probeScript(taskName: string, dataDir: string): string {
  if (!TASK_NAME_RE.test(taskName)) throw new Error('작업 이름 모양이 아닙니다');
  const dataDirB64 = Buffer.from(dataDir, 'utf16le').toString('base64');
  return String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
function RegValue($path, $name) {
  if ($name -like '*Password*') { return $null }
  try { $k = Get-Item -LiteralPath $path -ErrorAction Stop; $v = $k.GetValue($name, $null); if ($null -eq $v) { return $null }; return [string]$v } catch { return $null }
}
function RegNames($path) {
  try { return @((Get-Item -LiteralPath $path -ErrorAction Stop).GetValueNames()) } catch { return @() }
}
function Lines($x) { if ($null -eq $x) { return $null }; return (@($x) | ForEach-Object { [string]$_ }) -join [string][char]10 }
function Utf8Out($exe, $argLine) {
  try {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $exe; $psi.Arguments = $argLine; $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
    # 두 출력 모두 기다리지 않고 받는다 — 멈춘 자식이 4초 상한을 넘기지 못하게(ReadToEnd는 자식이 끝날 때까지 돌아오지 않는다). 넘으면 그 자식을 끝내고 null
    $p = [System.Diagnostics.Process]::Start($psi); $e = $p.StandardError.ReadToEndAsync(); $o = $p.StandardOutput.ReadToEndAsync()
    if (-not $p.WaitForExit(4000)) { try { $p.Kill() } catch { }; return $null }
    if (-not $o.Wait(2000)) { return $null }
    [void]$e.Wait(2000)
    return $o.Result
  } catch { return $null }
}
$r = [ordered]@{ v = 1 }
$r.sessionId = [System.Diagnostics.Process]::GetCurrentProcess().SessionId
$r.sessionName = $env:SESSIONNAME
$me = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$r.user = [ordered]@{ name = $env:USERNAME; domain = $env:USERDOMAIN; sid = $me.User.Value }
$wl = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
$r.winlogon = [ordered]@{ autoAdminLogon = (RegValue $wl 'AutoAdminLogon'); defaultUserName = (RegValue $wl 'DefaultUserName'); defaultDomainName = (RegValue $wl 'DefaultDomainName'); hasDefaultPassword = ((RegNames $wl) -contains 'DefaultPassword') }
$cp = 'HKCU:\Control Panel\Desktop'
$pp = 'HKCU:\Software\Policies\Microsoft\Windows\Control Panel\Desktop'
$r.screenSaver = [ordered]@{ active = (RegValue $cp 'ScreenSaveActive'); secure = (RegValue $cp 'ScreenSaverIsSecure'); saver = (RegValue $cp 'SCRNSAVE.EXE'); policyActive = (RegValue $pp 'ScreenSaveActive'); policySecure = (RegValue $pp 'ScreenSaverIsSecure'); policySaver = (RegValue $pp 'SCRNSAVE.EXE') }
$r.dynamicLock = (RegValue 'HKCU:\Software\Microsoft\Windows NT\CurrentVersion\Winlogon' 'EnableGoodbye')
$r.inactivityTimeoutSecs = (RegValue 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' 'InactivityTimeoutSecs')
$r.powercfg = [ordered]@{ consoleLock = (Lines (powercfg /qh SCHEME_CURRENT SUB_NONE CONSOLELOCK)); standby = (Lines (powercfg /qh SCHEME_CURRENT SUB_SLEEP STANDBYIDLE)); hibernate = (Lines (powercfg /qh SCHEME_CURRENT SUB_SLEEP HIBERNATEIDLE)) }
try {
  $svc = New-Object -ComObject Schedule.Service
  $svc.Connect()
  $t = $svc.GetFolder('\').GetTask('${taskName}')
  $r.task = [ordered]@{ found = $true; xml = [string]$t.Xml; error = $null }
} catch {
  if ($_.Exception.HResult -eq -2147024894) { $r.task = [ordered]@{ found = $false; xml = $null; error = $null } } else { $r.task = [ordered]@{ found = $false; xml = $null; error = [string]$_.Exception.Message } }
}
# 데이터 폴더의 권한 — 읽기만(Get-Acl). 견주기는 SID로(계정 이름은 보이기만)
$dd = [System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${dataDirB64}'))
if (Test-Path -LiteralPath $dd -PathType Container) {
  try {
    $acl = Get-Acl -LiteralPath $dd -ErrorAction Stop
    $rules = @(foreach ($a in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
      $an = $null; try { $an = $a.IdentityReference.Translate([System.Security.Principal.NTAccount]).Value } catch { }
      [ordered]@{ sid = [string]$a.IdentityReference.Value; name = $an; type = [string]$a.AccessControlType; inheritOnly = (($a.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) }
    })
    $r.dataDir = [ordered]@{ found = $true; protected = $acl.AreAccessRulesProtected; rules = $rules; error = $null }
  } catch { $r.dataDir = [ordered]@{ found = $true; protected = $null; rules = @(); error = [string]$_.Exception.Message } }
} else { $r.dataDir = [ordered]@{ found = $false; protected = $null; rules = @(); error = $null } }
$lan = Get-Service -Name LanmanServer
$r.lanman = if ($lan) { [string]$lan.Status } else { $null }
if (Get-Command Get-NetFirewallRule -ErrorAction SilentlyContinue) {
  # 맞는 규칙이 하나도 없으면 CIM 명령은 오류를 낸다 — 그때는 0개다 (이 PC에서 겪음)
  $n = 0
  foreach ($x in @(Get-NetFirewallRule -Direction Inbound -Action Block -Enabled True -ErrorAction SilentlyContinue)) {
    $p = $x | Get-NetFirewallPortFilter
    if ($p.Protocol -eq 'TCP' -and (@($p.LocalPort) -contains '445')) {
      $a = @(($x | Get-NetFirewallInterfaceFilter).InterfaceAlias)
      if (($a -contains 'Any') -or (@($a | Where-Object { $_ -like '*Tailscale*' }).Count -gt 0)) { $n++ }
    }
  }
  $r.smbBlockRules = $n
} else { $r.smbBlockRules = $null }
$ts = (Get-Command tailscale -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
if (-not $ts) { $c = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'; if (Test-Path -LiteralPath $c) { $ts = $c } }
# tailscale은 UTF-8을 낸다 — PowerShell의 글 받기(콘솔 코드 페이지 949)로 읽으면 한글이 든 JSON이 깨진다(이 PC에서 겪음). 바이트를 UTF-8로 읽는다
# 멈춘 tailscale은 status에서 4초 창을 다 쓰고 끝난다 — 그때는 serve status를 부르지 않는다(둘이면 8초 — 점검 전체의 10초 상한에 걸린다, 리드 결정 S9-24 R2S-4)
if ($ts) {
  $tsStatus = Utf8Out $ts 'status --json'
  $tsServe = $null
  if ($null -ne $tsStatus) { $tsServe = Utf8Out $ts 'serve status --json' }
  $r.tailscale = [ordered]@{ found = $true; status = $tsStatus; serve = $tsServe }
} else { $r.tailscale = [ordered]@{ found = $false; status = $null; serve = $null } }
$r.envNames = [ordered]@{ user = @(RegNames 'HKCU:\Environment'); machine = @(RegNames 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment') }
$json = $r | ConvertTo-Json -Compress -Depth 6
[regex]::Replace($json, '[^\x00-\x7F]', { param($m) '\u{0:x4}' -f [int][char]$m.Value })
`;
}

/** Windows PowerShell 5.1 (PATH가 아니라 시스템 폴더의 것 — task.ts system32와 같다) */
export function powershellPath(env: NodeJS.ProcessEnv = process.env): string {
  return system32('powershell', env);
}

/** 점검을 띄우는 인자 — 스크립트는 -EncodedCommand(UTF-16LE base64)로 넘겨 따옴표·역슬래시가 명령 줄에서 바뀌지 않게 */
export function probeArgs(taskName: string, dataDir: string): string[] {
  return ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(probeScript(taskName, dataDir), 'utf16le').toString('base64')];
}

export interface ProbeExecResult {
  code: number | null;
  stdout: string;
  timedOut: boolean;
  error: string | null;
}

/** 점검을 돌리는 실행기 (시험이 가짜를 넣는다) */
export type ProbeExec = (file: string, args: readonly string[], o: { timeoutMs: number; signal?: AbortSignal }) => Promise<ProbeExecResult>;

export const realProbeExec: ProbeExec = (file, args, o) =>
  new Promise((resolveRun) => {
    execFile(file, [...args], { windowsHide: true, timeout: o.timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: 'latin1', ...(o.signal ? { signal: o.signal } : {}) }, (err, stdout) => {
      const e = err as (NodeJS.ErrnoException & { code?: unknown; killed?: boolean; signal?: string | null }) | null;
      const timedOut = !!e && e.killed === true && e.signal != null && e.name !== 'AbortError';
      resolveRun({
        code: e ? (typeof e.code === 'number' ? e.code : null) : 0,
        stdout: String(stdout ?? ''),
        timedOut,
        error: e?.name === 'AbortError' ? 'aborted' : e && typeof e.code === 'string' ? e.code : null,
      });
    });
  });

/** 점검이 낸 사실 (모양이 틀린 칸은 null) */
export interface ProbeData {
  sessionId: number | null;
  sessionName: string | null;
  user: { name: string | null; domain: string | null; sid: string | null };
  winlogon: { autoAdminLogon: string | null; defaultUserName: string | null; defaultDomainName: string | null; hasDefaultPassword: boolean };
  /** 화면 보호기 — 사용자(HKCU Control Panel\Desktop)와 정책. saver는 고른 화면 보호기(SCRNSAVE.EXE — 없으면 '없음'을 고른 것) */
  screenSaver: { active: string | null; secure: string | null; saver: string | null; policyActive: string | null; policySecure: string | null; policySaver: string | null };
  dynamicLock: string | null;
  inactivityTimeoutSecs: string | null;
  powercfg: { consoleLock: string | null; standby: string | null; hibernate: string | null };
  task: { found: boolean; xml: string | null; error: string | null };
  /** 데이터 폴더의 권한 (Get-Acl) — 허용·거부 규칙마다 SID, 계정 이름(바꾸지 못하면 null), 상속 전용인지 */
  dataDir: { found: boolean; protected: boolean | null; rules: { sid: string; name: string | null; type: string; inheritOnly: boolean }[]; error: string | null };
  lanman: string | null;
  smbBlockRules: number | null;
  tailscale: { found: boolean; status: string | null; serve: string | null };
  envNames: { user: string[]; machine: string[] };
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : null);
const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : typeof v === 'string' ? [v] : []);

/** 점검의 표준 출력 → 사실. JSON이 아니면 그렇다고 (내용은 옮기지 않는다) */
export function parseProbeOutput(text: string): ProbeData | { error: string } {
  const start = text.indexOf('{');
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start >= 0 ? start : 0));
  } catch {
    return { error: '점검 스크립트의 출력이 JSON이 아닙니다' };
  }
  const r = obj(raw);
  if (r['v'] !== 1) return { error: '점검 스크립트의 출력 판이 다릅니다' };
  const user = obj(r['user']);
  const wl = obj(r['winlogon']);
  const ss = obj(r['screenSaver']);
  const pc = obj(r['powercfg']);
  const task = obj(r['task']);
  const dd = obj(r['dataDir']);
  const ts = obj(r['tailscale']);
  const env = obj(r['envNames']);
  // PowerShell 5.1은 요소가 하나인 배열을 그 요소로 낼 수 있다 — 둘 다 받는다
  const ddRules = (Array.isArray(dd['rules']) ? dd['rules'] : dd['rules'] && typeof dd['rules'] === 'object' ? [dd['rules']] : []).map(obj);
  return {
    sessionId: typeof r['sessionId'] === 'number' ? r['sessionId'] : null,
    sessionName: str(r['sessionName']),
    user: { name: str(user['name']), domain: str(user['domain']), sid: str(user['sid']) },
    winlogon: { autoAdminLogon: str(wl['autoAdminLogon']), defaultUserName: str(wl['defaultUserName']), defaultDomainName: str(wl['defaultDomainName']), hasDefaultPassword: wl['hasDefaultPassword'] === true },
    screenSaver: { active: str(ss['active']), secure: str(ss['secure']), saver: str(ss['saver']), policyActive: str(ss['policyActive']), policySecure: str(ss['policySecure']), policySaver: str(ss['policySaver']) },
    dynamicLock: str(r['dynamicLock']),
    inactivityTimeoutSecs: str(r['inactivityTimeoutSecs']),
    powercfg: { consoleLock: str(pc['consoleLock']), standby: str(pc['standby']), hibernate: str(pc['hibernate']) },
    task: { found: task['found'] === true, xml: str(task['xml']), error: str(task['error']) },
    dataDir:
      r['dataDir'] === undefined
        ? { found: false, protected: null, rules: [], error: '점검 출력에 데이터 폴더 칸이 없습니다' }
        : {
            found: dd['found'] === true,
            protected: typeof dd['protected'] === 'boolean' ? dd['protected'] : null,
            rules: ddRules.filter((x) => typeof x['sid'] === 'string').map((x) => ({ sid: x['sid'] as string, name: str(x['name']), type: str(x['type']) ?? '', inheritOnly: x['inheritOnly'] === true })),
            error: str(dd['error']),
          },
    lanman: str(r['lanman']),
    smbBlockRules: typeof r['smbBlockRules'] === 'number' ? r['smbBlockRules'] : null,
    tailscale: { found: ts['found'] === true, status: str(ts['status']), serve: str(ts['serve']) },
    envNames: { user: strs(env['user']), machine: strs(env['machine']) },
  };
}

/** 점검을 돌린다 (읽기만) */
export async function runProbe(
  taskName: string,
  dataDir: string,
  exec: ProbeExec = realProbeExec,
  o: { env?: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ProbeData | { error: string }> {
  const timeoutMs = o.timeoutMs ?? PROBE_TIMEOUT_MS;
  const r = await exec(powershellPath(o.env), probeArgs(taskName, dataDir), { timeoutMs, ...(o.signal ? { signal: o.signal } : {}) });
  if (r.error === 'aborted') return { error: '서버가 끝나 점검을 그만두었습니다' };
  if (r.error) return { error: `Windows PowerShell을 띄우지 못했습니다 (${r.error})` };
  if (r.timedOut) return { error: `${timeoutMs / 1000}초 안에 끝나지 않았습니다` };
  if (r.code !== 0) return { error: `끝 코드 ${r.code}` };
  return parseProbeOutput(r.stdout);
}

/**
 * `powercfg /qh <구성표> <하위 그룹> <설정>`의 지금 값 (AC·DC). 글은 지역화돼 있어(한국어 '현재 AC 전원 설정 색인') 읽지 않고, 16진 색인 `0x…`의 마지막 둘을
 * 차례로 AC·DC로 본다 — 출력은 늘 '가능한 …' 줄 뒤에 AC, 그다음 DC다. 설정이 숨어 /query에 나오지 않는 경우(CONSOLELOCK)도 /qh는 보인다
 */
export function powercfgAcDc(text: string | null): { ac: number; dc: number } | null {
  const hex = [...(text ?? '').matchAll(/0x([0-9a-fA-F]{8})\b/g)].map((m) => parseInt(m[1]!, 16));
  if (hex.length < 2) return null;
  return { ac: hex[hex.length - 2]!, dc: hex[hex.length - 1]! };
}

// ───────────────────────── Tailscale ─────────────────────────

export interface TailscaleFacts {
  running: boolean;
  state: string;
  dnsName: string | null;
  https: boolean;
  /** 이 서버(포트)로 넘기는 https 항목이 있는지 */
  ours: boolean;
  /** 그 밖의 항목 (같은 이름에 다른 서비스 — S3-31) */
  others: string[];
  funnel: boolean;
}

/** tailscale status --json + serve status --json → 필요한 것만 (JSON이 아니면 null) */
export function readTailscale(statusText: string | null, serveText: string | null, port: number): TailscaleFacts | null {
  let st: Record<string, unknown>;
  try {
    st = obj(JSON.parse(statusText ?? ''));
  } catch {
    return null;
  }
  let sv: Record<string, unknown> = {};
  try {
    sv = obj(JSON.parse(serveText?.trim() ? serveText : '{}'));
  } catch {
    sv = {};
  }
  const self = obj(st['Self']);
  const dns = typeof self['DNSName'] === 'string' ? self['DNSName'].replace(/\.$/, '') : '';
  const others: string[] = [];
  let ours = false;
  const target = new RegExp(`^(https?://)?(127\\.0\\.0\\.1|localhost|\\[::1\\]):${port}(/|$)`);
  const web = obj(sv['Web']);
  const ourHostPorts = new Set<string>();
  for (const [host, v] of Object.entries(web)) {
    for (const [path, h] of Object.entries(obj(obj(v)['Handlers']))) {
      const hh = obj(h);
      const proxy = typeof hh['Proxy'] === 'string' ? hh['Proxy'] : null;
      if (proxy && path === '/' && target.test(proxy)) {
        ours = true;
        ourHostPorts.add(host);
      } else others.push(`https://${host}${path} → ${proxy ?? (typeof hh['Path'] === 'string' ? hh['Path'] : typeof hh['Text'] === 'string' ? '(글)' : '?')}`);
    }
  }
  for (const [p, v] of Object.entries(obj(sv['TCP']))) {
    const vv = obj(v);
    // 우리 https 항목이 쓰는 포트의 HTTPS 표시는 그 항목의 일부다
    if (vv['HTTPS'] === true && [...ourHostPorts].some((h) => h.endsWith(`:${p}`))) continue;
    if (vv['HTTPS'] === true && Object.keys(web).some((h) => h.endsWith(`:${p}`))) continue;
    others.push(typeof vv['TCPForward'] === 'string' ? `TCP ${p} → ${vv['TCPForward']}` : `TCP ${p}`);
  }
  return {
    running: st['BackendState'] === 'Running',
    state: typeof st['BackendState'] === 'string' ? st['BackendState'] : '알 수 없음',
    dnsName: dns || null,
    https: Array.isArray(st['CertDomains']) && st['CertDomains'].length > 0,
    ours,
    others,
    funnel: Object.values(obj(sv['AllowFunnel'])).some((x) => x === true),
  };
}

// ───────────────────────── CLI ─────────────────────────

export interface CliProbe {
  found: boolean;
  path: string | null;
  loggedIn: boolean | null;
  detail: string;
}

/** CLI 하나: 찾고(설정의 경로 → PATH → 알려진 자리) 로그인 상태 명령 하나만 돌린다 (claude auth status --json · codex login status — 바꾸지 않는다) */
export async function probeCli(kind: AiKind, o: { override?: string | null; run?: RunCommand; env?: NodeJS.ProcessEnv } = {}): Promise<CliProbe> {
  const resolved = await resolveCli(kind, { override: o.override ?? null, ...(o.env ? { env: o.env } : {}) });
  if (!resolved.ok) return { found: false, path: null, loggedIn: null, detail: resolved.reason };
  const env = buildChildEnv(o.env ?? process.env, cliLauncherEnv(resolved.cli));
  const r = await (o.run ?? runCommand)(resolved.cli.path, kind === 'claude' ? ['auth', 'status', '--json'] : ['login', 'status'], { env, timeoutMs: CLI_STATUS_TIMEOUT_MS });
  const parsed = kind === 'claude' ? parseClaudeAuthStatus(r) : parseCodexLoginStatus(r);
  return { found: true, path: resolved.cli.path, loggedIn: parsed.loggedIn, detail: parsed.detail };
}

// ───────────────────────── 사실 → 항목 ─────────────────────────

/** 견줄 작업 (지금 install-task가 쓸 것 가운데 인자에 기대지 않는 것) */
export interface ExpectedTask {
  name: string;
  nodePath: string;
  entry: string;
  dataDir: string;
}

export interface DeployFacts {
  nodeVersion: string;
  probe: ProbeData | { error: string };
  expectedTask: ExpectedTask;
  cli: Record<AiKind, CliProbe>;
  /** 인증 방식과 API 키 등록 여부 (서버가 돌 때 — 모르면 null) */
  apiKeys: Record<AiKind, ApiKeyState> | null;
  /** 이 프로세스의 환경 변수 이름 */
  processEnvNames: string[];
  /** 실행 중인 서버 (없으면 null) */
  server: { adminPipe: AdminPipeInfo | null; screen: { ok: boolean; detail: string } | null; port: number } | null;
  /** server.json screen.enabled */
  screenEnabled: boolean | null;
}

const item = (id: DeployItemId, level: DeployLevel, text: string, fix: string | null = null): DeployItem => ({ id, level, text, fix: level === 'ok' || level === 'skip' ? null : fix });
const worst = (levels: DeployLevel[]): DeployLevel => (levels.includes('fail') ? 'fail' : levels.includes('warn') ? 'warn' : 'ok');
const eqi = (a: string | null, b: string | null): boolean => (a ?? '').toLowerCase() === (b ?? '').toLowerCase();
const minutes = (sec: number): string => (sec % 60 === 0 ? `${sec / 60}분` : `${sec}초`);

const TSCON = 'tscon ((Get-Process -Id $PID).SessionId) /dest:console';
const SMB_RULE =
  'New-NetFirewallRule -DisplayName "욱채 - Tailscale SMB 막기" -Direction Inbound -Protocol TCP -LocalPort 445 -InterfaceAlias "Tailscale" -Action Block (관리자 PowerShell — SERVER_INSTALL 4절 6번)';

/**
 * 셸이 큰따옴표 안에서도 바꾸거나 끊는 글자 — Windows PowerShell 5.1의 `$`·백틱·굽은 따옴표(“ ” ‘ ’ 등), cmd의 `&`·`^`·`%`·`!`, 그리고 `"` (리드 결정 S9-24 R2S-5).
 * 이런 글자가 든 폴더·값은 붙여 넣을 줄로 내지 않는다 — 반만 맞는 줄은 다른 데이터 폴더에 닿는다
 */
const SHELL_CHANGES = /[$`&^%!"\u2018-\u201f]/;

/** 고칠 길 명령의 낱말: 글 그대로(제품이 정한 낱말·숫자) 또는 따옴표로 감쌀 값(경로·주소 — 작업에서 옮겨 온 값 포함) */
export type CommandWord = string | { value: string };

/**
 * 고칠 길의 wook-server 명령 — 늘 점검한 데이터 폴더를 붙인다 (리드 결정 S9-22 DF-1: 붙이지 않으면 셸의 기본 데이터 폴더로 가 다른 폴더의 작업을 등록하고 경고가
 * 사라지지 않는다). 따옴표는 install-task의 인자와 같은 꼴(winQuote) — 보통의 폴더(빈칸·한글·작은따옴표·드라이브 뿌리·괄호)는 PowerShell 5.1과 cmd 어느 쪽에
 * 붙여 넣어도 Node가 같은 폴더를 받는다. 데이터 폴더나 옮길 값에 셸이 바꾸는 글자(SHELL_CHANGES)가 있으면 붙여 넣을 줄을 내지 않고 명령 이름과 할 일만 말한다
 * (리드 결정 S9-24 R2S-5)
 */
export function wookServerCommand(command: string, dataDir: string, extra: readonly CommandWord[] = []): string {
  const unsafeDir = SHELL_CHANGES.test(dataDir);
  const unsafeValue = extra.some((w) => typeof w !== 'string' && SHELL_CHANGES.test(w.value));
  if (!unsafeDir && !unsafeValue) return ['wook-server', command, ...extra.map((w) => (typeof w === 'string' ? w : winQuote(w.value))), '--data-dir', winQuote(dataDir)].join(' ');
  const words = extra.map((w) => (typeof w === 'string' ? w : SHELL_CHANGES.test(w.value) ? '<값>' : winQuote(w.value)));
  const where = [unsafeDir ? '데이터 폴더 이름' : null, unsafeValue ? '지금 작업에서 옮길 값' : null].filter(Boolean).join('과 ');
  return (
    `wook-server ${[command, ...words].join(' ')} --data-dir <데이터 폴더> — ${where}에 셸이 바꾸는 글자($ \` & ^ % ! " 굽은 따옴표)가 있어 그대로 붙여 넣을 줄을 내지 않습니다. ` +
    `이 명령을 손으로 치면서 --data-dir에는 이 데이터 폴더(${dataDir})를${unsafeValue ? ', <값>에는 지금 작업의 그 값을' : ''} 넣으세요`
  );
}

/** 시스템(LocalSystem)과 Administrators — 데이터 폴더에 있어도 되는 계정 (그 밖은 이 사용자만) */
const DATA_DIR_TRUSTED_SIDS: readonly string[] = ['S-1-5-18', 'S-1-5-32-544'];
/** CREATOR OWNER — 상속 전용이면 새 파일의 주인(이 사용자)에게 가는 자리표시라 넓히는 것이 아니다 */
const CREATOR_OWNER_SID = 'S-1-3-0';

function sessionItem(p: ProbeData, dataDir: string): DeployItem {
  if (p.sessionId === 0) return item('session', 'fail', '세션 0(서비스)에서 돕니다 — 화면이 없어 화면 조작을 쓸 수 없고, 로그인한 사용자의 서버가 아닙니다', `로그인한 사용자의 작업으로 띄우세요: ${wookServerCommand('install-task', dataDir)}`);
  if (p.sessionName && /^RDP-Tcp#/i.test(p.sessionName)) {
    return item('session', 'warn', `원격 데스크톱(RDP) 세션입니다 (${p.sessionName}) — 연결을 그냥 끊으면 이 세션의 화면이 잠깁니다`, `끊기 전에 그 세션의 관리자 PowerShell에서: ${TSCON}`);
  }
  return item('session', 'ok', `${p.sessionName ?? '세션 이름 없음'} (세션 ${p.sessionId ?? '?'})`);
}

function autologonItem(p: ProbeData): DeployItem {
  const w = p.winlogon;
  const issues: string[] = [];
  const fixes: string[] = [];
  const on = w.autoAdminLogon === '1';
  const sameUser = eqi(w.defaultUserName, p.user.name);
  if (!on) issues.push('자동 로그온이 꺼져 있습니다 — 다시 시작하면 로그인 화면에서 멈춰 작업(로그온할 때)이 돌지 않습니다');
  else if (!sameUser) issues.push(`자동 로그온 계정이 이 사용자가 아닙니다 (${w.defaultUserName ?? '없음'})`);
  if (!on || !sameUser) fixes.push('Sysinternals Autologon으로 이 계정의 자동 로그온을 켜세요 (암호는 LSA 비밀로 둡니다 — Microsoft 계정이면 먼저 \'Windows Hello 로그인만 허용\'을 끕니다)');
  if (w.hasDefaultPassword) {
    issues.push('Winlogon에 DefaultPassword 값이 있습니다 — 암호가 레지스트리에 평문으로 남습니다 (값은 읽지 않았습니다)');
    fixes.push('Autologon으로 다시 켠 뒤 DefaultPassword 값을 지우세요');
  }
  if (!issues.length) return item('autologon', 'ok', `켜짐 (${w.defaultDomainName ? `${w.defaultDomainName}\\` : ''}${w.defaultUserName})`);
  return item('autologon', 'warn', issues.join(' · '), fixes.join(' · '));
}

function lockItem(p: ProbeData): DeployItem {
  const s = p.screenSaver;
  const issues: string[] = [];
  const fixes: string[] = [];
  // 정책 값이 있으면 사용자 값보다 먼저다. 고른 화면 보호기(SCRNSAVE.EXE)가 없으면 아무것도 잠그지 않는다 — Windows는 '없음'으로 되돌려도 켜짐·암호 두 값을
  // 1로 둘 수 있다 (리드 결정 S9-22 DF-10)
  const active = (s.policyActive ?? s.active) === '1';
  const secure = (s.policySecure ?? s.secure) === '1';
  const saver = (s.policySaver ?? s.saver ?? '').trim();
  if (active && secure && saver) {
    // 암호를 거는 쪽이 정책이면 정책을 고친다
    const byPolicy = s.policySecure === '1';
    issues.push(`화면 보호기가 암호로 잠급니다${byPolicy ? ' (정책)' : ''}`);
    fixes.push(byPolicy ? '그룹 정책의 화면 보호기 암호 보호를 끄세요' : '화면 보호기를 \'없음\'으로 두거나 \'다시 시작할 때 로그온 화면 표시\'를 끄세요');
  }
  const consoleLock = powercfgAcDc(p.powercfg.consoleLock);
  if (consoleLock && consoleLock.ac !== 0) {
    issues.push('절전에서 깨어날 때 암호를 묻습니다 (CONSOLELOCK)');
    fixes.push('powercfg /setacvalueindex SCHEME_CURRENT SUB_NONE CONSOLELOCK 0 그다음 powercfg /setactive SCHEME_CURRENT');
  }
  const idle = Number(p.inactivityTimeoutSecs ?? '0');
  if (Number.isFinite(idle) && idle > 0) {
    issues.push(`비활성 ${minutes(idle)} 뒤 잠급니다 (InactivityTimeoutSecs 정책)`);
    fixes.push('보안 정책 \'대화형 로그온: 컴퓨터 비활성 한도\'를 0으로 두세요');
  }
  if (p.dynamicLock === '1') {
    issues.push('동적 잠금이 켜져 있습니다 (휴대폰이 멀어지면 잠급니다)');
    fixes.push('설정 → 계정 → 로그인 옵션에서 동적 잠금을 끄세요');
  }
  if (!issues.length) return item('lock', 'ok', consoleLock ? '스스로 잠그지 않습니다' : '스스로 잠그지 않습니다 (CONSOLELOCK은 읽지 못함)');
  return item('lock', 'warn', `${issues.join(' · ')} — 잠긴 화면은 검게 찍히고 입력이 먹지 않습니다`, fixes.join(' · '));
}

function sleepItem(p: ProbeData): DeployItem {
  const standby = powercfgAcDc(p.powercfg.standby);
  const hibernate = powercfgAcDc(p.powercfg.hibernate);
  if (!standby && !hibernate) return item('sleep', 'skip', '전원 설정을 읽지 못했습니다 (powercfg /qh)');
  const issues: string[] = [];
  const fixes: string[] = [];
  if (standby && standby.ac !== 0) {
    issues.push(`전원에 꽂혀 있어도 ${minutes(standby.ac)} 쉬면 절전에 듭니다`);
    fixes.push('powercfg /change standby-timeout-ac 0');
  }
  if (hibernate && hibernate.ac !== 0) {
    issues.push(`전원에 꽂혀 있어도 ${minutes(hibernate.ac)} 쉬면 최대 절전에 듭니다`);
    fixes.push('powercfg /change hibernate-timeout-ac 0');
  }
  if (!issues.length) return item('sleep', 'ok', '전원에 꽂혀 있으면 절전에 들지 않습니다');
  return item('sleep', 'warn', `${issues.join(' · ')} — 잠든 PC는 휴대폰에서 닿지 않습니다 (서버는 작업 중에만 절전을 막습니다)`, fixes.join(' · '));
}

/** 등록된 작업의 인자에서 --port (없으면 null) — Node가 읽는 대로 나눠 본다 (task.ts taskPortOf) */
export const taskPort = taskPortOf;

function taskItem(p: ProbeData, want: ExpectedTask): DeployItem {
  if (p.task.error) return item('task', 'skip', `작업 스케줄러를 읽지 못했습니다 (${p.task.error})`);
  if (!p.task.found || !p.task.xml) return item('task', 'warn', `등록된 작업이 없습니다 (${want.name}) — 다시 시작하면 서버가 스스로 뜨지 않습니다`, wookServerCommand('install-task', want.dataDir));
  const t = parseTaskXml(p.task.xml);
  const fails: string[] = [];
  const warns: string[] = [];
  // 작업 스케줄러는 SID로 쓴 UserId를 계정 이름으로 돌려줄 수 있다 — 같은 계정이면 된다 (task.ts sameAccount)
  const names = p.user.name ? [p.user.domain ? `${p.user.domain}\\${p.user.name}` : p.user.name, p.user.name] : [];
  if (t.userId && SERVICE_SIDS.includes(t.userId)) fails.push('서비스 계정으로 돕니다');
  else if (!sameAccount(t.userId, p.user.sid ?? '', names)) fails.push(`다른 계정으로 돕니다 (${t.userId ?? '없음'})`);
  if (t.logonType !== 'InteractiveToken') fails.push(`'사용자가 로그온한 경우에만 실행'이 아닙니다 (${t.logonType ?? '없음'}) — 화면이 없는 세션에서 돌 수 있습니다`);
  // 관리자 권한(가장 높은 수준)으로 돌면 서버·메인 에이전트·팀원 CLI·host_exec가 모두 관리자 토큰을 가진다 (리드 결정 S9-22 DS-1, S9-12 high)
  if (!leastPrivilege(t.runLevel)) fails.push(`관리자 권한(가장 높은 수준)으로 돕니다 (RunLevel ${t.runLevel}) — 서버와 AI가 모두 관리자 권한을 가집니다`);
  // 인자는 Node가 읽는 대로 나눠 install-task가 쓰는 꼴과 견준다 — 따옴표로 감싼 "--allow-test-session"도 Node에는 그 옵션이다 (S9-22 DS-2)
  const args = taskArgvProblems(t.arguments, { entry: want.entry, dataDir: want.dataDir });
  if (args.testSession) fails.push('--allow-test-session으로 띄웁니다 — 시험용 세션 발급이 켜집니다');
  // 둘째부터의 Exec 동작도 그 인자를 본다 — 같은 서버를 시험용 세션 발급으로 하나 더 띄울 수 있다 (리드 결정 S9-24 R2S-3)
  t.execs.forEach((e, i) => {
    if (i > 0 && argsHoldTestSession(e.arguments)) fails.push(`--allow-test-session으로 띄웁니다 (${i + 1}번째 동작) — 시험용 세션 발급이 켜집니다`);
  });
  if (t.actions.length > 1) warns.push(`동작이 ${t.actions.length}개입니다 (${t.actions.join(', ')}) — install-task는 서버를 띄우는 동작 하나만 넣습니다`);
  else if (t.actions[0] !== 'Exec') warns.push(`서버를 띄우는 프로그램 실행(Exec) 동작이 아닙니다 (${t.actions[0] ?? '동작 없음'})`);
  if (!eqi(t.command, want.nodePath)) warns.push(`Node가 지금 것과 다릅니다 (${t.command ?? '없음'})`);
  warns.push(...args.problems);
  // %…%는 작업 스케줄러가 환경 변수로 펼친다 — install-task는 '%'를 쓰지 않고, check는 펼친 뒤 Node가 받을 값을 알 수 없다 (리드 결정 S9-24 R2S-2)
  t.execs.forEach((e, i) => {
    const at = t.execs.length > 1 ? ` (${i + 1}번째 동작)` : '';
    for (const [place, v] of [
      ['Command', e.command],
      ['Arguments', e.arguments],
      ['WorkingDirectory', e.workingDirectory],
    ] as const) {
      if (v?.includes('%')) warns.push(`작업의 ${place}${at}에 %가 있습니다 — 작업 스케줄러가 %…%를 환경 변수로 펼쳐 Node가 받는 값을 알 수 없습니다`);
    }
  });
  if (t.executionTimeLimit !== 'PT0S') warns.push(`실행 시간 상한이 있습니다 (${t.executionTimeLimit ?? '기본 72시간'})`);
  if (t.disallowStartIfOnBatteries !== 'false' || t.stopIfGoingOnBatteries !== 'false') warns.push('배터리로 돌 때 시작하지 않거나 멈춥니다');
  if (t.enabled === 'false') warns.push('작업이 꺼져 있습니다');
  if (!fails.length && !warns.length) return item('task', 'ok', `${want.name} — 로그온할 때 이 사용자로 (${t.arguments})`);
  // 다시 등록하는 명령에는 지금 작업의 install-task 옵션(--port 등)을 그대로 옮긴다 — 그대로 치면 포트·공개 주소가 바뀌지 않게
  // 옮기는 값은 따옴표로 감쌀 값으로 넘긴다 — 셸이 바꾸는 글자가 있으면 붙여 넣을 줄을 내지 않는다 (R2S-5). 포트는 숫자일 때만 그대로
  const again = wookServerCommand('install-task', want.dataDir, args.options.flatMap(([k, v]): CommandWord[] => [k, k === '--port' && /^\d{1,5}$/.test(v) ? v : { value: v }]));
  return item('task', fails.length ? 'fail' : 'warn', `${want.name}: ${[...fails, ...warns].join(' · ')}`, `다시 등록하세요 (같은 이름을 바꿔 넣습니다): ${again}`);
}

/** 데이터 폴더의 권한 (리드 결정 S9-22 DS-5): 이 사용자·SYSTEM·Administrators 밖의 계정이 열 수 있으면 경고. 견주기는 SID로, 상속 전용 CREATOR OWNER는 보지 않는다 */
function dataDirItem(p: ProbeData, want: ExpectedTask): DeployItem {
  const d = p.dataDir;
  if (d.error) return item('dataDir', 'skip', `데이터 폴더의 권한을 읽지 못했습니다 (${d.error})`);
  if (!d.found) return item('dataDir', 'skip', `데이터 폴더가 아직 없습니다 (${want.dataDir}) — 서버가 처음 시작할 때 이 사용자만 열 수 있게 만듭니다`);
  if (!p.user.sid || !p.user.name) return item('dataDir', 'skip', '지금 사용자를 읽지 못해 데이터 폴더의 권한을 견주지 못했습니다');
  const mine = p.user.sid.toUpperCase();
  const others = d.rules.filter((r) => {
    const sid = r.sid.toUpperCase();
    if (r.type !== 'Allow' || sid === mine || DATA_DIR_TRUSTED_SIDS.includes(sid)) return false;
    return !(sid === CREATOR_OWNER_SID && r.inheritOnly);
  });
  if (!others.length) return item('dataDir', 'ok', `${want.dataDir} — 이 사용자·SYSTEM·Administrators만 열 수 있습니다`);
  const who = [...new Set(others.map((r) => r.name ?? r.sid))].join(', ');
  const account = p.user.domain ? `${p.user.domain}\\${p.user.name}` : p.user.name;
  return item(
    'dataDir',
    'warn',
    `다른 계정도 데이터 폴더를 열 수 있습니다 (${who}) — 그 계정이 server.json·wook.db·기록을 읽거나 bin의 서버 도우미를 바꿀 수 있습니다`,
    `그 사용자만 열게 좁히세요: ${icaclsFix(want.dataDir, account)}`,
  );
}

/**
 * 데이터 폴더를 그 사용자만 열게 좁히는 icacls 줄 — wook-server 고칠 길과 같은 규칙(리드 결정 S9-24 R2S-5, S9-25 R3-2): 폴더나 계정 이름에 셸이 바꾸는 글자가
 * 있으면 붙여 넣을 줄을 내지 않는다(반만 맞는 줄은 다른 폴더의 권한을 좁힌다). 보통의 폴더는 그 줄 그대로
 */
export function icaclsFix(dataDir: string, account: string): string {
  const unsafeDir = SHELL_CHANGES.test(dataDir);
  const unsafeAccount = SHELL_CHANGES.test(account);
  if (!unsafeDir && !unsafeAccount) return `icacls ${winQuote(dataDir)} /inheritance:r /grant:r "${account}:(OI)(CI)F"`;
  const where = [unsafeDir ? '데이터 폴더 이름' : null, unsafeAccount ? '계정 이름' : null].filter(Boolean).join('과 ');
  return (
    `icacls ${unsafeDir ? '<데이터 폴더>' : winQuote(dataDir)} /inheritance:r /grant:r "${unsafeAccount ? '<계정>' : account}:(OI)(CI)F" — ${where}에 셸이 바꾸는 글자($ \` & ^ % ! " 굽은 따옴표)가 있어 그대로 붙여 넣을 줄을 내지 않습니다. ` +
    `이 명령을 손으로 치면서 ${[unsafeDir ? `<데이터 폴더>에는 이 데이터 폴더(${dataDir})를` : null, unsafeAccount ? `<계정>에는 ${account}를` : null].filter(Boolean).join(', ')} 넣으세요`
  );
}

function nodeItem(version: string, dataDir: string): DeployItem {
  const major = Number(/^v?(\d+)/.exec(version)?.[1] ?? '0');
  return major >= 24
    ? item('node', 'ok', `Node ${version}`)
    : item('node', 'fail', `Node ${version} — 24 이상이어야 합니다 (node:sqlite)`, `winget install -e --id OpenJS.NodeJS.LTS 뒤 다시 등록하세요: ${wookServerCommand('install-task', dataDir)}`);
}

function cliItem(kind: AiKind, c: CliProbe, keys: ApiKeyState | null, dataDir: string): DeployItem {
  const id: DeployItemId = kind === 'claude' ? 'cli.claude' : 'cli.codex';
  const install = kind === 'claude' ? 'npm i -g @anthropic-ai/claude-code' : 'npm i -g @openai/codex';
  const login = kind === 'claude' ? 'claude auth login' : 'codex login';
  if (!c.found) return item(id, 'warn', `찾지 못했습니다 — 이 AI를 쓰지 않으면 괜찮습니다 (${c.detail})`, `${install} 뒤 ${login}`);
  if (c.loggedIn === true) return item(id, 'ok', `${c.path} · 로그인됨${c.detail ? ` (${c.detail})` : ''}`);
  if (keys?.authMode === 'api_key' && keys.registered) return item(id, 'ok', `${c.path} · API 키 방식 (키 등록됨 — 구독 로그인은 보지 않습니다)`);
  if (c.loggedIn === false) {
    const how =
      keys?.authMode === 'api_key' ? `API 키 방식인데 키가 없습니다 — 표준 입력으로 넣으세요: ${wookServerCommand('secret set', dataDir, [`${kind}-api-key`])}` : `${login} (서버를 돌리는 이 사용자로, 서버 PC의 터미널에서)`;
    return item(id, 'warn', `${c.path} · 로그인돼 있지 않습니다 — 이 AI의 턴은 '재로그인 필요'로 막힙니다`, how);
  }
  return item(id, 'warn', `${c.path} · 로그인 상태를 확인하지 못했습니다${c.detail ? ` (${c.detail})` : ''}`, `${login} 뒤 다시 점검하세요: ${wookServerCommand('check', dataDir)}`);
}

function apiKeyEnvItem(f: DeployFacts, p: ProbeData | null): DeployItem {
  const where = (name: string): string[] => {
    const at: string[] = [];
    const has = (list: readonly string[]): boolean => list.some((n) => n.toUpperCase() === name);
    if (has(f.processEnvNames)) at.push('이 프로세스');
    if (p && has(p.envNames.user)) at.push('사용자 환경');
    if (p && has(p.envNames.machine)) at.push('시스템 환경');
    return at;
  };
  const found: string[] = [];
  for (const kind of ['claude', 'codex'] as const) {
    if (f.apiKeys?.[kind].authMode === 'api_key') continue;
    for (const name of API_KEY_ENV_NAMES[kind]) {
      const at = where(name);
      if (at.length) found.push(`${name}(${at.join('·')})`);
    }
  }
  if (!found.length) return item('apikey-env', 'ok', '구독 방식 AI에 걸리는 API 키 환경 변수가 없습니다');
  const mode = f.apiKeys ? '구독 방식인데' : '구독 방식이면(서버가 돌지 않아 방식을 보지 못했습니다)';
  return item(
    'apikey-env',
    'warn',
    `${mode} API 키 환경 변수가 있습니다: ${found.join(', ')} — CLI가 그 키로 돌아 API 요금이 나갈 수 있습니다 (값은 읽지 않았습니다)`,
    `구독으로 쓰려면 그 변수를 지우고 서버를 다시 시작하세요 — 사용자 환경이면 [Environment]::SetEnvironmentVariable('<이름>', $null, 'User'). API 키로 쓰려면 ${wookServerCommand('secret set', f.expectedTask.dataDir, ['<AI>-api-key'])}`,
  );
}

function screenItem(f: DeployFacts): DeployItem {
  if (f.screenEnabled === false) return item('screen', 'ok', '화면 조작을 꺼 두었습니다 (server.json screen.enabled false)');
  if (!f.server) return item('screen', 'skip', '서버가 돌지 않아 보지 못했습니다 — 서버를 띄운 뒤 wook-server status의 화면 조작 줄로 봅니다');
  if (!f.server.screen) return item('screen', 'skip', '서버가 화면 조작 상태를 내지 않았습니다');
  return f.server.screen.ok
    ? item('screen', 'ok', f.server.screen.detail)
    : item('screen', 'warn', f.server.screen.detail, '자동 로그온·잠금 끄기·RDP를 끊기 전 tscon (SERVER_INSTALL 9절) — 화면 조작을 쓰지 않으면 server.json에 "screen": { "enabled": false }');
}

function smbItem(f: DeployFacts, p: ProbeData | null): DeployItem {
  const lanmanUp = p?.lanman === 'Running';
  const noRule = p?.smbBlockRules === 0;
  const portInfo = !p
    ? ''
    : !lanmanUp
      ? ' · 이 PC의 파일 공유 서버(LanmanServer)가 꺼져 있습니다'
      : p.smbBlockRules === null
        ? ' · 방화벽 규칙을 읽지 못했습니다'
        : noRule
          ? ' · Tailscale 쪽 TCP 445를 막는 규칙이 없습니다'
          : ` · Tailscale 쪽 TCP 445 막기 규칙 ${p.smbBlockRules}개`;
  if (!f.server || !f.server.adminPipe) return item('smb', 'skip', `서버가 돌지 않아 관리 채널을 보지 못했습니다${portInfo}`);
  const a = f.server.adminPipe;
  if (a.rejectsRemote) return item('smb', 'ok', `관리 채널이 다른 기기(SMB)의 연결을 거부합니다 (${a.mode === 'helper' ? '서버 도우미' : '소켓 파일'})${portInfo}${lanmanUp && noRule ? ' (정보 — 겹 방어로 막아 두기를 권합니다)' : ''}`);
  const fix = lanmanUp && noRule ? `${SMB_RULE} · 까닭을 고친 뒤 서버를 다시 시작하세요` : '까닭을 고친 뒤 서버를 다시 시작하세요';
  return item('smb', 'warn', `${adminPipeFallbackWarning(a.reason ?? '까닭 모름')}${portInfo}`, fix);
}

function tailscaleItem(f: DeployFacts, p: ProbeData | null): DeployItem {
  if (!p) return item('tailscale', 'skip', '점검 스크립트가 돌지 않아 보지 못했습니다');
  if (!p.tailscale.found) return item('tailscale', 'warn', 'Tailscale이 없습니다 — 휴대폰에서 들어올 수 없습니다', 'winget install -e --id Tailscale.Tailscale 뒤 tailscale up');
  const port = f.server?.port ?? taskPort(p.task.xml ? parseTaskXml(p.task.xml).arguments : null) ?? DEFAULT_PORT;
  const t = readTailscale(p.tailscale.status, p.tailscale.serve, port);
  if (!t) return item('tailscale', 'warn', 'tailscale status를 읽지 못했습니다 — 로그인하지 않았거나 서비스가 꺼져 있을 수 있습니다', 'tailscale up');
  if (!t.running) return item('tailscale', 'warn', `Tailscale이 돌고 있지 않습니다 (${t.state})`, 'tailscale up');
  const fails: string[] = [];
  const warns: string[] = [];
  const fixes: string[] = [];
  if (t.funnel) {
    fails.push('tailscale funnel이 켜져 있습니다 — 인터넷 전체에 열립니다');
    fixes.push('tailscale funnel을 끄세요 (tailscale funnel --https=443 off)');
  }
  if (!t.https) {
    warns.push('tailnet의 HTTPS 인증서가 꺼져 있습니다 (CertDomains가 비었습니다)');
    fixes.push('Tailscale 관리 콘솔 → DNS에서 MagicDNS와 HTTPS 인증서를 켜세요');
  }
  if (!t.ours) {
    warns.push(`이 서버(포트 ${port})로 넘기는 tailscale serve 항목이 없습니다`);
    fixes.push(`tailscale serve --bg ${port} 뒤 그 https 주소를 server.json network.publicOrigin에 넣고 ${wookServerCommand('config reload', f.expectedTask.dataDir)}`);
  }
  if (t.others.length) {
    warns.push(`같은 이름에 다른 항목이 있습니다: ${t.others.join(', ')} — 그 이름의 로그인 쿠키가 그쪽에도 갑니다 (S3-31)`);
    fixes.push('다른 서비스는 다른 Tailscale 기기 이름에 두세요');
  }
  if (!fails.length && !warns.length) return item('tailscale', 'ok', `https://${t.dnsName ?? '?'} → 127.0.0.1:${port}`);
  return item('tailscale', fails.length ? 'fail' : 'warn', [...fails, ...warns].join(' · '), fixes.join(' · '));
}

/** 사실 → 항목 (리드 결정 S9-4의 표) — 순수 함수 */
export function deployItems(f: DeployFacts): DeployItem[] {
  const p = 'error' in f.probe ? null : f.probe;
  const dataDir = f.expectedTask.dataDir;
  const items: DeployItem[] = [];
  if (!p) {
    items.push(
      item(
        'probe',
        'fail',
        `점검 스크립트(Windows PowerShell)가 끝나지 못했습니다 (${(f.probe as { error: string }).error}) — 세션·자동 로그온·잠금·절전·작업·데이터 폴더·Tailscale을 보지 못했습니다`,
        `powershell.exe(Windows PowerShell 5.1)가 있는지 본 뒤 다시 점검하세요: ${wookServerCommand('check', dataDir)}`,
      ),
    );
    for (const id of ['session', 'autologon', 'lock', 'sleep', 'task', 'dataDir'] as const) items.push(item(id, 'skip', '점검 스크립트가 돌지 않아 보지 못했습니다'));
  } else {
    items.push(sessionItem(p, dataDir), autologonItem(p), lockItem(p), sleepItem(p), taskItem(p, f.expectedTask), dataDirItem(p, f.expectedTask));
  }
  items.push(nodeItem(f.nodeVersion, dataDir));
  items.push(cliItem('claude', f.cli.claude, f.apiKeys?.claude ?? null, dataDir), cliItem('codex', f.cli.codex, f.apiKeys?.codex ?? null, dataDir));
  items.push(apiKeyEnvItem(f, p), screenItem(f), smbItem(f, p), tailscaleItem(f, p));
  return items;
}

/** 수 */
export function deployCounts(items: readonly DeployItem[]): Record<DeployLevel, number> {
  const c: Record<DeployLevel, number> = { ok: 0, warn: 0, fail: 0, skip: 0 };
  for (const i of items) c[i.level]++;
  return c;
}

/** 서버 기록·status 줄의 요약 한 줄 — 항목 이름과 수만 (글·값 없음) */
export function deploySummary(items: readonly DeployItem[]): string {
  const c = deployCounts(items);
  const ids = (level: DeployLevel): string => items.filter((i) => i.level === level).map((i) => i.id).join(', ');
  return `통과 ${c.ok} · 경고 ${c.warn}${c.warn ? ` (${ids('warn')})` : ''} · 실패 ${c.fail}${c.fail ? ` (${ids('fail')})` : ''} · 건너뜀 ${c.skip}`;
}

const LEVEL_TEXT: Record<DeployLevel, string> = { ok: '통과', warn: '경고', fail: '실패', skip: '건너뜀' };

/** 콘솔의 표시 폭 (한글·전각은 2칸) */
function displayWidth(t: string): number {
  let w = 0;
  for (const ch of t) w += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/.test(ch) ? 2 : 1;
  return w;
}
const pad = (t: string, width: number): string => t + ' '.repeat(Math.max(0, width - displayWidth(t)));

/** check의 표 (사람이 읽는 글) */
export function formatCheck(r: DeployReport): string {
  const labelWidth = Math.max(...r.items.map((i) => displayWidth(ITEM_LABEL[i.id]))) + 2;
  const lines = [`욱채 서버 배포 점검 (${r.checkedAt} — 바꾼 것은 없습니다)`];
  for (const i of r.items) {
    lines.push(`  ${pad(LEVEL_TEXT[i.level], 7)}${pad(ITEM_LABEL[i.id], labelWidth)}${i.text}`);
    if (i.fix) lines.push(`  ${pad('', 7)}${pad('', labelWidth)}할 일: ${i.fix}`);
  }
  const c = deployCounts(r.items);
  lines.push(`결과: ${deploySummary(r.items)} — ${c.fail ? '실패가 있어 끝 코드 1입니다' : '실패가 없습니다'}`, '');
  return lines.join('\n');
}

// ───────────────────────── 한 번 돌리기 ─────────────────────────

export interface GatherDeps {
  /** 점검 스크립트 — 그 작업 이름과 데이터 폴더(권한을 읽는다)로 */
  probe: (taskName: string, dataDir: string, signal?: AbortSignal) => Promise<ProbeData | { error: string }>;
  cli: (kind: AiKind, override: string | null) => Promise<CliProbe>;
  nodeVersion: string;
  processEnvNames: string[];
  now: () => Date;
}

export function defaultGatherDeps(): GatherDeps {
  return {
    probe: (name, dataDir, signal) => runProbe(name, dataDir, realProbeExec, signal ? { signal } : {}),
    cli: (kind, override) => probeCli(kind, { override }),
    nodeVersion: process.versions.node,
    processEnvNames: Object.keys(process.env),
    now: () => new Date(),
  };
}

/** 사실을 모아 항목으로 (점검과 CLI 둘은 함께 돈다) */
export async function gatherDeploy(
  o: {
    expectedTask: ExpectedTask;
    cliPaths: { claudePath: string | null; codexPath: string | null };
    apiKeys: Record<AiKind, ApiKeyState> | null;
    server: DeployFacts['server'];
    screenEnabled: boolean | null;
    signal?: AbortSignal;
  },
  deps: GatherDeps,
): Promise<DeployReport> {
  const [probe, claude, codex] = await Promise.all([
    deps.probe(o.expectedTask.name, o.expectedTask.dataDir, o.signal),
    deps.cli('claude', o.cliPaths.claudePath).catch((e: unknown): CliProbe => ({ found: false, path: null, loggedIn: null, detail: (e as Error).message })),
    deps.cli('codex', o.cliPaths.codexPath).catch((e: unknown): CliProbe => ({ found: false, path: null, loggedIn: null, detail: (e as Error).message })),
  ]);
  const items = deployItems({
    nodeVersion: deps.nodeVersion,
    probe,
    expectedTask: o.expectedTask,
    cli: { claude, codex },
    apiKeys: o.apiKeys,
    processEnvNames: deps.processEnvNames,
    server: o.server,
    screenEnabled: o.screenEnabled,
  });
  return { checkedAt: deps.now().toISOString(), items };
}

/** install-task가 지금 쓸 것 가운데 인자에 기대지 않는 것 (task.ts와 같은 식) */
export function expectedTaskOf(o: { name: string; dataDir: string; appRoot: string; nodePath: string }): ExpectedTask {
  return { name: o.name, nodePath: o.nodePath, entry: join(o.appRoot, 'out', 'server', 'index.mjs'), dataDir: o.dataDir };
}

// ───────────────────────── 운영자 명령 check ─────────────────────────

/** 실행 중인 서버에서 읽은 것 (없으면 null — 서버가 없다) */
export interface ServerView {
  adminPipe: AdminPipeInfo | null;
  screen: { ok: boolean; detail: string } | null;
  port: number;
  apiKeys: Record<AiKind, ApiKeyState> | null;
  cliPaths: { claudePath: string | null; codexPath: string | null };
}

export interface CheckCommandDeps {
  platform: NodeJS.Platform;
  gather: GatherDeps;
  /** 이 데이터 폴더의 실행 중인 서버 (관리 채널 status·config show — 없으면 null) */
  server: (dataDir: string) => Promise<ServerView | null>;
  /** server.json의 screen.enabled·cli 위치 (읽지 못하면 null) */
  config: (dataDir: string) => { screenEnabled: boolean | null; cliPaths: { claudePath: string | null; codexPath: string | null } } | null;
  taskName: (dataDir: string) => string;
  appRoot: string;
  nodePath: string;
}

export interface CheckCommandResult {
  code: number;
  out: string;
  err: string;
  json: { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } };
}

/** 운영자 명령 check의 실제 의존 (점검·CLI 확인은 읽기만, 서버는 관리 채널의 status·config show로) */
export function defaultCheckDeps(): CheckCommandDeps {
  return {
    platform: process.platform,
    gather: defaultGatherDeps(),
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
      return {
        adminPipe: status.adminPipe ?? null,
        screen: status.screen ? { ok: status.screen.ok, detail: status.screen.detail } : null,
        port: status.port,
        apiKeys: config?.apiKeys ?? null,
        cliPaths: config?.cli ?? { claudePath: null, codexPath: null },
      };
    },
    config: (dataDir) => {
      const r = readServerConfig(serverConfigPath(dataDir));
      return r.ok ? { screenEnabled: r.config.screen.enabled, cliPaths: r.config.cli } : null;
    },
    taskName,
    appRoot: appRootFrom(),
    nodePath: process.execPath,
  };
}

/** `wook-server check [--json] [--dry-run]` — 실패가 있으면 1. --dry-run은 돌릴 것만 보인다(아무것도 띄우지 않고 서버에도 붙지 않는다) */
export async function runCheck(o: { dataDir: string; dryRun: boolean }, deps: CheckCommandDeps): Promise<CheckCommandResult> {
  if (deps.platform !== 'win32') {
    const message = 'check는 Windows 서버 PC에서만 씁니다 (Linux는 10단계)';
    return { code: 2, out: '', err: `${message}\n`, json: { ok: false, error: { code: 'unsupported', message } } };
  }
  const name = deps.taskName(o.dataDir);
  if (o.dryRun) {
    const argv = [powershellPath(), '-NoProfile', '-NonInteractive', '-EncodedCommand', '<아래 스크립트의 UTF-16LE base64>'];
    const clis = ['claude auth status --json', 'codex login status'];
    return {
      code: 0,
      out: [
        '[시험 실행 — 아무것도 띄우지 않았습니다] check가 돌릴 것 (모두 읽기만 합니다)',
        `  ${argv.join(' ')}  (${PROBE_TIMEOUT_MS / 1000}초)`,
        ...clis.map((c) => `  ${c}  (찾은 CLI만, ${CLI_STATUS_TIMEOUT_MS / 1000}초)`),
        `  관리 채널 status·config show (이 데이터 폴더의 서버가 돌 때만 — ${o.dataDir})`,
        '점검 스크립트 (Windows PowerShell 5.1)',
        probeScript(name, o.dataDir).trim(),
        '',
      ].join('\n'),
      err: '',
      json: { ok: true, result: { dryRun: true, taskName: name, powershell: argv, script: probeScript(name, o.dataDir), cliStatus: clis } },
    };
  }
  const server = await deps.server(o.dataDir).catch(() => null);
  const cfg = deps.config(o.dataDir);
  const report = await gatherDeploy(
    {
      expectedTask: expectedTaskOf({ name, dataDir: o.dataDir, appRoot: deps.appRoot, nodePath: deps.nodePath }),
      // CLI 위치는 실행 중인 서버의 설정이 먼저(데스크톱 앱이 정한 것도 그 DB에 있다), 없으면 server.json
      cliPaths: server?.cliPaths ?? cfg?.cliPaths ?? { claudePath: null, codexPath: null },
      apiKeys: server?.apiKeys ?? null,
      server: server ? { adminPipe: server.adminPipe, screen: server.screen, port: server.port } : null,
      screenEnabled: cfg?.screenEnabled ?? null,
    },
    deps.gather,
  );
  const failed = report.items.some((i) => i.level === 'fail');
  return { code: failed ? 1 : 0, out: formatCheck(report), err: '', json: { ok: true, result: { ...report, counts: deployCounts(report.items) } } };
}

/**
 * 서버의 시작 뒤 한 번 (리드 결정 S9-4): Windows에서만, 시험(VITEST) 중에는 돌리지 않는다. 기다리지 않고 돌리므로 준비를 늦추지 않는다. 결과는 report로 넘기고
 * 기록에는 요약 한 줄만 쓴다(항목 글·값 없음). stop()은 돌던 점검을 그만두게 한다(쥔 자식 프로세스를 AbortSignal로 — 종료 흐름이 부른다). 돌리지 않으면 null
 */
export function startDeployCheck(o: {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  logger: { info(m: string): void; warn(m: string, e?: unknown): void };
  run: (signal: AbortSignal) => Promise<DeployReport>;
  report: (r: DeployReport) => void;
}): { stop(): void; done: Promise<void> } | null {
  if (o.env['VITEST'] || o.platform !== 'win32') return null;
  const abort = new AbortController();
  let stopped = false;
  const done = (async () => {
    try {
      const r = await o.run(abort.signal);
      if (stopped) return;
      o.report(r);
      o.logger.info(`배포 점검: ${deploySummary(r.items)} — wook-server check(또는 status)로 자세히 봅니다`);
    } catch (error) {
      if (!stopped) o.logger.warn(`배포 점검을 하지 못했습니다 — wook-server check로 다시 해 보세요 (${(error as Error)?.message ?? String(error)})`);
    }
  })();
  return {
    stop() {
      stopped = true;
      abort.abort();
    },
    done,
  };
}
