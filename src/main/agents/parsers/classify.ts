/**
 * CLI 오류 문구 분류 — 사용량 한도·인증 만료·실행 권한 확인·앱 도구(MCP)·이어하기 실패를 한 곳에서 판정한다 (ARCHITECTURE 9·12장).
 * 문구는 Claude Code 2.1.x·codex-cli 0.163 실행 파일에 들어 있는 실제 문자열을 기준으로 모았다.
 */
import type { CliErrorKind } from '@shared/events';

export interface ErrorClass {
  kind: CliErrorKind;
  /** 사용량 한도 해제 예상 시각 (ISO) */
  resetAt?: string;
  /** 사용량 한도의 종류 (Claude rate_limit_event rateLimitType) — 모델별 주간 한도를 그 모델 계열에만 거는 데 쓴다 (리드 결정 22) */
  rateLimitType?: string;
  /** 이어하기 대상 세션을 찾지 못함 → 새 세션으로 인계 (ERR-03) */
  resumeFailed?: boolean;
}

export interface ClassifyOptions {
  now?: Date;
  /** 시간대 없는 해제 시각("resets 3pm")을 해석할 시간대. 기본: 이 PC의 시간대 (CLI도 같은 PC 시간으로 쓴다) */
  timeZone?: string;
  /** CLI가 준 오류 코드 (Claude assistant.error 등) */
  code?: string | null;
}

// 순서가 중요하다: 이어하기 실패 → 앱 도구(MCP) → 사용량 한도 → 인증 → 권한
const RESUME_FAILED: RegExp[] = [
  /no conversation found/i,
  /no saved session found/i,
  /no (?:session|thread) found/i,
  /no rollout found/i,
  /thread not found/i,
  /failed to resume session/i,
  /could not (?:find|load|resume) (?:the )?(?:session|conversation|thread)/i,
  /unable to load transcript/i,
  /session \S{0,80} (?:was )?not found/i,
];

const MCP: RegExp[] = [/\bmcp\b/i, /mcp[_ ]servers?/i, /mcp client/i];

const NOT_USAGE: RegExp[] = [/not your usage limit/i, /temporarily limiting requests/i];
const USAGE_LIMIT: RegExp[] = [
  /usage limit reached/i, // "Claude AI usage limit reached|<epoch>", "Usage limit reached · …"
  /\blimit reached\s*[∙·•|]/i, // "5-hour limit reached ∙ resets 3pm"
  /\b(?:5|five)[- ]hour limit\b/i,
  /\bweekly limit (?:reached|hit)\b/i,
  /you(?:'|’)?ve hit your .{0,48}?limit/i, // Claude "You've hit your session limit · resets …", Codex "You’ve hit your usage limit."
  /you(?:'|’)?re out of (?:usage|extra usage|usage credits)/i,
  /out of usage credits/i,
  /workspace is out of credits/i,
  /you hit your spend cap/i,
  /spend limit reached/i,
  /credit balance is too low/i,
  /insufficient[_ ]quota/i,
  /quota exceeded/i,
  /exceeded retry limit, last status: 429/i,
  /usage_cap_reached/i,
  /\brate_limit_error\b/i,
  /org(?:'|’)?s monthly (?:spend|usage) limit/i,
];

const AUTH: RegExp[] = [
  /not logged in/i,
  /please run \/login/i,
  /run (?:`)?claude (?:auth )?login/i,
  /invalid api key/i,
  /invalid x-api-key/i,
  /authentication[_ ](?:failed|error)/i,
  /oauth token (?:has )?(?:expired|been revoked)/i,
  /(?:access|refresh|authentication|auth|oauth) token (?:could not be refreshed|is expired|has expired|has been invalidated|was already used)/i,
  /token (?:has )?expired/i,
  /please (?:log ?in|sign in|re-?authenticate)(?: again)?/i,
  /log out and sign in again/i,
  /failed to refresh token/i,
  /token data is not available/i,
  /\b401\b[^\n]{0,60}unauthori[sz]ed/i,
  /\bunauthori[sz]ed\b/i,
  /missing bearer (?:or basic )?authentication/i,
  /login required/i,
  /oauth_org_not_allowed/i,
  /account (?:is )?on hold/i,
  /verification required/i,
  /disabled claude subscription access/i,
  /no codex credentials were found/i,
];

const PERMISSION: RegExp[] = [
  /requested permissions? to (?:use|write to|read|edit)/i, // "Claude requested permissions to use Bash, but you haven't granted it yet."
  /haven(?:'|’)?t granted it yet/i,
  /permission to (?:use|edit|write|read) .{1,160}? (?:has been|was) denied/i,
  /permission for this action (?:has been|was) denied/i,
  /\brequires? (?:manual )?approval\b/i,
  /approval (?:is )?(?:required|requested|needed|pending)/i,
  /(?:rejected|declined) by (?:the )?user/i,
  /waiting for (?:user )?approval/i,
  /permission prompts? (?:are|is) answered with a local deny/i,
  /permission_denials?/i,
];

/** Claude assistant.error 코드 (SDK) → 분류 */
const CLAUDE_ERROR_CODES: Record<string, CliErrorKind> = {
  authentication_failed: 'auth',
  oauth_org_not_allowed: 'auth',
  account_on_hold: 'auth',
  verification_required: 'auth',
  cloud_credential_error: 'auth',
  billing_error: 'usage_limit',
  rate_limit: 'usage_limit',
};

export function classifyErrorText(text: string, opts: ClassifyOptions = {}): ErrorClass {
  const t = text ?? '';
  if (RESUME_FAILED.some((r) => r.test(t))) return { kind: 'other', resumeFailed: true };
  if (MCP.some((r) => r.test(t))) return { kind: 'mcp' };
  const byCode = opts.code ? CLAUDE_ERROR_CODES[opts.code] : undefined;
  if (byCode === 'usage_limit' || (!NOT_USAGE.some((r) => r.test(t)) && USAGE_LIMIT.some((r) => r.test(t)))) {
    const resetAt = parseResetAt(t, opts.now ?? new Date(), opts.timeZone);
    return resetAt ? { kind: 'usage_limit', resetAt } : { kind: 'usage_limit' };
  }
  if (byCode === 'auth' || AUTH.some((r) => r.test(t))) return { kind: 'auth' };
  if (PERMISSION.some((r) => r.test(t))) return { kind: 'permission' };
  return { kind: 'other' };
}

/** Claude 도구 결과 중 바이패스가 적용되지 않았다는 뜻의 권한 확인 문구만 (명령 출력의 "Permission denied"는 제외) */
export function isPermissionPromptText(text: string): boolean {
  return PERMISSION.some((r) => r.test(text));
}

/**
 * Codex 재시도 안내 — 오류가 아니라 진행 안내.
 * "Reconnecting... 2/5 (unexpected status 401 …)"처럼 원인에 401이 있어도 마지막 error·turn.failed에서 판정한다
 * (ChatGPT 로그인은 401 뒤에 토큰을 새로 받아 회복할 수 있다)
 */
export function isTransientRetryText(text: string): boolean {
  return /^\s*reconnecting\.{0,3}\s*\d+\s*\/\s*\d+/i.test(text) || /^\s*falling back from websockets/i.test(text);
}

// ───────────────────────── 해제 시각 해석 ─────────────────────────

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const UNIT_MS: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 };

/**
 * 한도 문구에서 해제 시각을 찾는다. 찾지 못하면 undefined (호출자가 기본 30분 적용).
 *  - "…usage limit reached|1761580800" (epoch 초·밀리초)
 *  - "resets 2026-08-08 00:00 UTC"
 *  - "try again in 2 hours 13 minutes", "resets in 45m"
 *  - "resets Oct 30, 3pm (Asia/Seoul)", "try again at Oct 30th, 2026 3:15 PM"
 *  - "resets 3pm", "resets 3:30pm (Asia/Seoul)", "try again at 3:15 PM"
 */
export function parseResetAt(text: string, now: Date, timeZone?: string): string | undefined {
  const nowMs = now.getTime();

  const epoch = /\|\s*(\d{10}|\d{13})\b/.exec(text);
  if (epoch) {
    const v = Number(epoch[1]);
    return new Date(epoch[1]!.length === 13 ? v : v * 1000).toISOString();
  }

  const iso = /\b(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?\s*(UTC|GMT|Z|[+-]\d{2}:?\d{2})?/i.exec(text);
  if (iso) {
    const [, y, mo, d, h, mi, s, zone] = iso;
    const tz = zone ? zone.toUpperCase() : undefined;
    if (tz === 'UTC' || tz === 'GMT' || tz === 'Z') return new Date(Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!, +(s ?? 0))).toISOString();
    if (tz) {
      const sign = tz.startsWith('-') ? -1 : 1;
      const digits = tz.replace(/[+:-]/g, '');
      const offMin = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4)));
      return new Date(Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!, +(s ?? 0)) - offMin * 60_000).toISOString();
    }
    return new Date(wallTimeToUtc(+y!, +mo! - 1, +d!, +h!, +mi!, effectiveZone(timeZone))).toISOString();
  }

  const rel = /(?:try again|resets?|retry|available again)\s+(?:in|after)\s+((?:\d+(?:\.\d+)?\s*(?:days?|d|hours?|hrs?|hr|h|minutes?|mins?|min|m|seconds?|secs?|sec|s)\b[\s,]*(?:and\s+)?)+)/i.exec(text);
  if (rel) {
    let total = 0;
    for (const m of rel[1]!.matchAll(/(\d+(?:\.\d+)?)\s*(days?|d|hours?|hrs?|hr|h|minutes?|mins?|min|m|seconds?|secs?|sec|s)\b/gi)) {
      const unit = m[2]!.toLowerCase();
      const key = unit.startsWith('d') ? 'd' : unit.startsWith('h') ? 'h' : unit.startsWith('m') ? 'm' : 's';
      total += Number(m[1]) * UNIT_MS[key]!;
    }
    if (total > 0) return new Date(nowMs + total).toISOString();
  }

  const zoneIn = (s: string | undefined) => {
    const z = s?.trim();
    return z && isValidZone(z) ? z : effectiveZone(timeZone);
  };

  const dated =
    /(?:resets?|try again at|until|available again at)\s+(?:on\s+|at\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(?:(\d{4}),?\s*)?(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([^)]+)\))?/i.exec(text);
  if (dated) {
    const [, monName, day, year, hh, mm, ampm, zone] = dated;
    const month = MONTHS.indexOf(monName!.toLowerCase().slice(0, 3));
    const hour = to24(+hh!, ampm);
    if (month >= 0 && hour !== null) {
      const tz = zoneIn(zone);
      if (year) return new Date(wallTimeToUtc(+year, month, +day!, hour, +(mm ?? 0), tz)).toISOString();
      const thisYear = zonedParts(nowMs, tz).year;
      let ts = wallTimeToUtc(thisYear, month, +day!, hour, +(mm ?? 0), tz);
      if (ts < nowMs - 86_400_000) ts = wallTimeToUtc(thisYear + 1, month, +day!, hour, +(mm ?? 0), tz);
      return new Date(ts).toISOString();
    }
  }

  const timeOnly = /(?:resets?|try again at|until|available again at)\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b(?:\s*\(([^)]+)\))?/i.exec(text) ?? /(?:resets?|try again at)\s+(?:at\s+)?(\d{1,2}):(\d{2})()(?:\s*\(([^)]+)\))?/i.exec(text);
  if (timeOnly) {
    const [, hh, mm, ampm, zone] = timeOnly;
    const hour = to24(+hh!, ampm || undefined);
    if (hour !== null) {
      const tz = zoneIn(zone);
      const p = zonedParts(nowMs, tz);
      let ts = wallTimeToUtc(p.year, p.month, p.day, hour, +(mm ?? 0), tz);
      // 몇 분 지난 시각이면 오늘 이미 지난 것 → 내일
      if (ts < nowMs - 5 * 60_000) ts = wallTimeToUtc(p.year, p.month, p.day + 1, hour, +(mm ?? 0), tz);
      return new Date(ts).toISOString();
    }
  }
  return undefined;
}

function to24(h: number, ampm: string | undefined): number | null {
  if (!ampm) return h >= 0 && h <= 23 ? h : null;
  if (h < 1 || h > 12) return null;
  const pm = ampm.toLowerCase() === 'pm';
  return (h % 12) + (pm ? 12 : 0);
}

function effectiveZone(tz: string | undefined): string {
  if (tz && isValidZone(tz)) return tz;
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function isValidZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const dtfCache = new Map<string, Intl.DateTimeFormat>();
function zonedParts(utcMs: number, tz: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  let dtf = dtfCache.get(tz);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    dtfCache.set(tz, dtf);
  }
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(new Date(utcMs))) parts[p.type] = p.value;
  return { year: +parts.year!, month: +parts.month! - 1, day: +parts.day!, hour: +parts.hour! % 24, minute: +parts.minute!, second: +parts.second! };
}

/** 시간대 tz의 벽시계 시각 → UTC 밀리초 (일광 절약 시간 전환도 두 번 보정) */
export function wallTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, tz: string): number {
  const guess = Date.UTC(year, month, day, hour, minute);
  const offsetAt = (ms: number) => {
    const p = zonedParts(ms, tz);
    return Date.UTC(p.year, p.month, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
  };
  const off1 = offsetAt(guess);
  let ts = guess - off1;
  const off2 = offsetAt(ts);
  if (off2 !== off1) ts = guess - off2;
  return ts;
}
