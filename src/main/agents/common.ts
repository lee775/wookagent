/**
 * 어댑터 공용: 자식 환경 변수, 실행 값 검사, 활동 기록용 명령 표시.
 */
import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { EFFORT_LEVELS } from '@shared/domain';
import type { TurnLaunch } from './types';

/**
 * 부모 CLI 세션이 자식 셸에 넣는 실행 표시 변수.
 * 앱을 Claude Code·Codex 터미널에서 띄우면 그대로 물려받는데, Claude 2.1.x는 CLAUDE_CODE_CHILD_SESSION이 있으면
 * 세션 저장을 끄는 경로가 있어 이어하기가 깨질 수 있다. 새 CLI 실행에는 의미가 없으므로 지운다.
 */
export const INHERITED_SESSION_VARS: readonly string[] = [
  'CLAUDECODE',
  'AI_AGENT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_CODE_SESSION_ACCESS_TOKEN',
  'CLAUDE_CODE_INVOKED_SKILLS',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'CLAUDE_PLUGIN_DATA',
  'CLAUDE_PLUGIN_ROOT',
  'CLAUDE_PROJECT_DIR',
  'CLAUDE_ENV_FILE',
  'CODEX_COMPANION_SESSION_ID',
  'CODEX_SANDBOX',
  'CODEX_SANDBOX_NETWORK_DISABLED',
  'CODEX_MANAGED_BY_NPM',
  'CODEX_MANAGED_BY_BUN',
  'CODEX_MANAGED_BY_PNPM',
  'CODEX_MANAGED_BY_VITE_PLUS',
  'CODEX_MANAGED_PACKAGE_ROOT',
  'WOOK_MCP_TOKEN',
];

/**
 * CLI 턴·host_exec에 넘기지 않는 X 화면 변수 (S10c, 리드 결정 S10-7.7): 이것이 있으면 메인 에이전트가 셸에서 xdotool 등으로 서버 PC 화면을 직접 찍고
 * 조작할 수 있다 — 화면 도구의 안전장치(사람 우선·막는 창·암호 칸·횟수 상한)를 건너뛴다. 실수 막기이지 경계는 아니다 (같은 사용자는 화면 쿠키 파일을 읽을 수 있다)
 */
export const SCREEN_ENV_VARS: readonly string[] = ['DISPLAY', 'XAUTHORITY'];

/**
 * 자식에게 줄 전체 환경 변수. Windows 환경 변수 이름은 대소문자를 가리지 않으므로 지울 때도 그렇게 비교한다.
 * 덮어쓰기 순서: base → (지울 변수 제거 — 부모 CLI 세션 변수·X 화면 변수) → extra
 */
export function buildChildEnv(
  base: NodeJS.ProcessEnv | Record<string, string | undefined>,
  extra: Record<string, string>,
  platform: NodeJS.Platform = process.platform,
): Record<string, string | undefined> {
  const caseInsensitive = platform === 'win32';
  const norm = (k: string) => (caseInsensitive ? k.toUpperCase() : k);
  const drop = new Set([...INHERITED_SESSION_VARS, ...SCREEN_ENV_VARS].map(norm));
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined || drop.has(norm(k))) continue;
    out[k] = v;
  }
  for (const [k, v] of Object.entries(extra)) {
    if (caseInsensitive) {
      for (const existing of Object.keys(out)) {
        if (existing !== k && existing.toUpperCase() === k.toUpperCase()) delete out[existing];
      }
    }
    out[k] = v;
  }
  return out;
}

/** host_exec 한 번의 시간 상한 (초) — 도구 인자 timeout_s의 상한과 같다 (리드 결정 S5-16) */
export const HOST_EXEC_MAX_TIMEOUT_S = 1800;
/**
 * 앱 도구 호출 하나를 CLI(MCP 클라이언트)가 기다리는 시간 (초) — host_exec 상한보다 60초 길게 (리드 결정 S5-18). Codex는 mcp_servers.<이름>.tool_timeout_sec,
 * Claude Code는 MCP_TOOL_TIMEOUT(ms)로 넣는다. 짧으면 긴 설치를 CLI가 먼저 끊어 결과를 받지 못하고, 명령은 턴이 끝날 때까지 돈다.
 * 두 CLI의 기본값은 실제 CLI로 재 보지 않았다 (S5d 보고서)
 */
export const MCP_TOOL_TIMEOUT_SEC = HOST_EXEC_MAX_TIMEOUT_S + 60;

/**
 * host_exec가 빼는 AI 키 이름 (리드 결정 S5-19) — 아래 이름 규칙에도 대부분 걸리지만 이름으로도 못 박는다. 이 키가 남으면 서버 PC 명령(설치 스크립트 등)이
 * 운영자의 API 키를 읽거나 구독 방식 CLI가 API 요금으로 돈다
 */
export const HOST_EXEC_AI_KEYS: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'XAI_API_KEY',
];

/**
 * host_exec가 빼는 비밀 값 이름 규칙 (대소문자 무시, 리드 결정 S5-19·S5-33·S5-40.3) — GITHUB_TOKEN·NPM_TOKEN·AWS_SECRET_ACCESS_KEY·DB_PASSWORD·JWT_PRIVATE_KEY·
 * COOKIE_SIGNING_KEY, 밑줄 없이 붙여 쓰는 PGPASSWORD·MYSQL_PWD·npm의 `_authToken`, 그리고 이름이 꼭 `DATABASE_URL`인 것(접속 문자열에 비밀번호가 든다).
 * 셸의 현재 폴더 PWD(밑줄 없음)는 남긴다
 */
export const HOST_EXEC_SECRET_NAME_RE =
  /(^|_)(API_?KEY|ACCESS_?KEY|SECRET(_?ACCESS)?_?KEY|PRIVATE_?KEY|SIGNING_?KEY|SECRET|TOKEN|CREDENTIALS?)$|AUTH_?TOKEN$|PASS(WORD|WD)$|_PWD$|^DATABASE_URL$/i;

/** host_exec 환경에서 빼는 이름인지: 부모 CLI 세션 변수, WOOK_* 전부, 알려진 AI 키, 비밀 값 이름 규칙 (모두 대소문자 무시) */
export function hostExecDropsVar(name: string): boolean {
  const upper = name.toUpperCase();
  return (
    INHERITED_SESSION_VARS.includes(upper) ||
    upper.startsWith('WOOK_') ||
    HOST_EXEC_AI_KEYS.includes(upper) ||
    HOST_EXEC_SECRET_NAME_RE.test(name)
  );
}

/**
 * host_exec가 띄우는 셸의 환경 (리드 결정 S5-19, SERVER_DESIGN 8.4): buildChildEnv(부모 CLI 세션 변수를 뺀 전체 환경)에서 WOOK_*(앱 도구 토큰·데이터 폴더 등),
 * 알려진 AI 키, 비밀 값처럼 보이는 이름(…_TOKEN·…_API_KEY·…SECRET·…PRIVATE_KEY·…SIGNING_KEY·…PASSWORD·…_PWD·…AUTHTOKEN·CREDENTIALS·DATABASE_URL)을 뺀다. CI=1을 넣는다 — 표준 입력이 닫혀 있어 묻는 설치는 기다리지
 * 않게. 토큰이 필요한 설치(비공개 저장소 등)는 운영자가 해야 한다
 */
export function buildHostExecEnv(base: NodeJS.ProcessEnv | Record<string, string | undefined>, platform: NodeJS.Platform = process.platform): Record<string, string | undefined> {
  const env = buildChildEnv(base, { CI: '1' }, platform);
  for (const k of Object.keys(env)) if (hostExecDropsVar(k)) delete env[k];
  return env;
}

/** 실행 전 검사에 쓰는 노력치 목록 — 앱 전체가 같은 목록(EFFORT_LEVELS)을 쓴다 (windows:F7) */
export const CLAUDE_EFFORTS: readonly string[] = EFFORT_LEVELS.claude;
export const CODEX_EFFORTS: readonly string[] = EFFORT_LEVELS.codex;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 앱 도구 서버 이름: codex -c 키 경로와 Claude 도구 이름(mcp__<이름>__<도구>)에 그대로 들어간다 */
const SERVER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

export function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}

export class LaunchError extends Error {
  /**
   * @param cliUnavailable CLI 실행 파일을 찾지·쓰지 못함 (설치 안 됨·경로 설정 오류·자동 업데이트로 이동).
   *   이 업무만의 문제가 아니라 그 AI 종류 전체의 문제다 → 호출자가 AI 종류 단위로 막는다 (CLI-15)
   */
  constructor(
    message: string,
    readonly cliUnavailable = false,
  ) {
    super(message);
    this.name = 'LaunchError';
  }
}

export interface ValidatedLaunch {
  resume: boolean;
}

/** 실행 전에 잘못된 값을 한국어 오류로 막는다 (CLI가 애매한 오류를 내기 전에) */
export async function validateLaunch(
  label: 'Claude Code' | 'Codex',
  launch: TurnLaunch,
  allowedEfforts: readonly string[],
): Promise<ValidatedLaunch> {
  if (!isAbsolute(launch.cwd)) throw new LaunchError(`${label} 작업 폴더는 절대 경로여야 합니다: ${launch.cwd}`);
  await mustBeDir(launch.cwd, `${label} 작업 폴더가 없습니다: ${launch.cwd}`);
  if (!isAbsolute(launch.tempDir)) throw new LaunchError(`${label} 임시 폴더는 절대 경로여야 합니다: ${launch.tempDir}`);
  for (const d of launch.addDirs) {
    if (!isAbsolute(d)) throw new LaunchError(`${label} 추가 접근 폴더는 절대 경로여야 합니다: ${d}`);
  }
  for (const img of launch.images) {
    if (!isAbsolute(img)) throw new LaunchError(`첨부 이미지는 절대 경로여야 합니다: ${img}`);
    const ok = await stat(img).then(
      (s) => s.isFile(),
      () => false,
    );
    if (!ok) throw new LaunchError(`첨부 이미지 파일이 없습니다: ${img}`);
  }
  if (launch.model !== null && (launch.model.trim() === '' || /\s/.test(launch.model) || CONTROL_RE.test(launch.model))) {
    throw new LaunchError(`${label} 모델 이름이 올바르지 않습니다: "${launch.model}"`);
  }
  if (launch.effort !== null && !allowedEfforts.includes(launch.effort)) {
    throw new LaunchError(`${label}에서 쓸 수 없는 노력치 값입니다: "${launch.effort}" (가능: ${allowedEfforts.join(', ')})`);
  }
  if (launch.maxTurns !== null && (!Number.isInteger(launch.maxTurns) || launch.maxTurns < 1)) {
    throw new LaunchError(`최대 반복 수는 1 이상의 정수여야 합니다: ${launch.maxTurns}`);
  }
  if (!SERVER_NAME_RE.test(launch.mcp.serverName)) {
    throw new LaunchError(`앱 도구 서버 이름이 올바르지 않습니다: "${launch.mcp.serverName}" (영문·숫자·하이픈만)`);
  }
  let url: URL;
  try {
    url = new URL(launch.mcp.url);
  } catch {
    throw new LaunchError(`앱 도구 서버 주소가 올바르지 않습니다: ${launch.mcp.url}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new LaunchError(`앱 도구 서버 주소는 http(s)여야 합니다: ${launch.mcp.url}`);
  }
  if (launch.mcp.token.trim() === '' || /\s/.test(launch.mcp.token)) {
    throw new LaunchError('앱 도구 토큰이 비어 있거나 공백을 포함합니다');
  }
  const resume = launch.resumeCliSessionId !== null;
  if (resume && (launch.resumeCliSessionId!.trim() === '' || CONTROL_RE.test(launch.resumeCliSessionId!) || launch.resumeCliSessionId!.startsWith('-'))) {
    throw new LaunchError(`이어하기 세션 ID가 올바르지 않습니다: "${launch.resumeCliSessionId}"`);
  }
  for (const [k, v] of Object.entries(launch.env)) {
    if (k === '' || k.includes('=') || CONTROL_RE.test(k)) throw new LaunchError(`환경 변수 이름이 올바르지 않습니다: "${k}"`);
    if (typeof v !== 'string') throw new LaunchError(`환경 변수 값은 문자열이어야 합니다: ${k}`);
  }
  return { resume };
}

async function mustBeDir(p: string, message: string): Promise<void> {
  const ok = await stat(p).then(
    (s) => s.isDirectory(),
    () => false,
  );
  if (!ok) throw new LaunchError(message);
}

/** 활동 기록용 명령 문자열. 공백·따옴표가 있는 인자만 큰따옴표로 감싼다 */
export function displayCommand(command: string, args: readonly string[], stdinChars: number | null): string {
  const q = (a: string) => (a === '' || /[\s"'`$&|<>^%]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
  const parts = [q(command), ...args.map(q)];
  if (stdinChars !== null) parts.push(`< 표준 입력(${stdinChars}자)`);
  return parts.join(' ');
}

/** 긴 문자열 인자를 활동 기록에서 줄인다 (지침 본문 등) */
export function abbreviateArg(value: string, max = 80): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…(${value.length}자)`;
}
