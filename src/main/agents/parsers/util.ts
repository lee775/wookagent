/** 파서 공용 도우미 — 형식이 어긋난 값을 만나도 던지지 않는다 */
import type { CliErrorKind, ParsedCliEvent } from '@shared/events';
import { classifyErrorText, type ErrorClass } from './classify';

export interface ParserOptions {
  /** 앱 도구 서버 이름 (mcp__<이름>__<도구> 구분) */
  serverName: string;
  now?: () => Date;
  /** "resets 3pm"처럼 시간대 없는 해제 시각을 해석할 시간대 */
  timeZone?: string;
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
export function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
export function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
export function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g;
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

/** 한 줄 요약: 공백을 하나로 합치고 max자에서 자른다 */
export function oneLine(s: string, max = 200): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** 비어 있지 않은 첫 줄 */
export function firstLine(s: string, max = 200): string {
  const line = s.split(/\r?\n/).find((l) => l.trim() !== '') ?? '';
  return oneLine(line, max);
}

export function fmtTokens(n: number | undefined): string {
  if (n === undefined) return '?';
  return n.toLocaleString('en-US');
}

/** JSON 한 줄 해석. 객체가 아니면 실패로 본다 */
export function parseJsonLine(line: string): { ok: true; value: Record<string, unknown> } | { ok: false } {
  const t = line.replace(/^﻿/, '').trim();
  if (!t.startsWith('{')) return { ok: false };
  try {
    const v: unknown = JSON.parse(t);
    return isRecord(v) ? { ok: true, value: v } : { ok: false };
  } catch {
    return { ok: false };
  }
}

const KIND_PREFIX: Record<CliErrorKind, string> = {
  usage_limit: '사용량 한도',
  auth: '인증 필요',
  permission: '실행 권한 확인 발생 (바이패스 불일치)',
  mcp: '앱 도구(MCP) 오류',
  other: '오류',
};

/**
 * 오류 이벤트 만들기 + 같은 분류의 반복 억제.
 * 사용량 한도·인증·권한·MCP·이어하기 실패는 턴당 한 번만 'error'로 내고, 반복은 'system'으로 낮춘다
 * (오케스트레이터가 같은 사유로 알림·차단을 두 번 하지 않게). 'other'는 헛돌기 판정에 쓰이므로 그대로 낸다.
 */
export class ErrorTracker {
  private readonly emitted = new Map<string, { hasReset: boolean }>();
  /** 바로 앞 오류 문구 — CLI가 같은 실패를 두 번 알릴 때(codex error + turn.failed, claude 오류 메시지 + result) 한 번만 센다 */
  private lastText: string | null = null;
  private lastClass: ErrorClass | null = null;
  constructor(private readonly opts: ParserOptions) {}

  classify(text: string, code?: string | null): ErrorClass {
    return classifyErrorText(text, { now: this.opts.now?.() ?? new Date(), timeZone: this.opts.timeZone, code: code ?? null });
  }

  /** 바로 앞 오류와 같은 문구면 그때의 분류(오류 코드까지 반영된)를 그대로 쓴다 — 결과 이벤트의 errorKind가 어긋나지 않게 */
  classifyLike(text: string): ErrorClass {
    if (this.lastClass && this.lastText !== null && text.trim() === this.lastText) return { ...this.lastClass };
    return this.classify(text);
  }

  has(kind: CliErrorKind): boolean {
    return this.emitted.has(kind);
  }

  /**
   * 분류된 오류만 이벤트로 (분류 안 되면 빈 배열).
   * dropRepeat: 이미 낸 분류면 '(같은 오류 반복)' 안내도 만들지 않는다 (stderr처럼 원문 줄이 따로 남는 경우)
   */
  ifClassified(text: string, raw: unknown, o: { code?: string | null; fallbackResetAt?: string; dropRepeat?: boolean } = {}): ParsedCliEvent[] {
    const cls = this.classify(text, o.code);
    if (cls.kind === 'other' && !cls.resumeFailed) return [];
    const out = this.event(text, raw, { cls, fallbackResetAt: o.fallbackResetAt });
    return o.dropRepeat ? out.filter((e) => e.kind === 'error') : out;
  }

  event(text: string, raw: unknown, o: { cls?: ErrorClass; code?: string | null; fallbackResetAt?: string } = {}): ParsedCliEvent[] {
    const cls: ErrorClass = { ...(o.cls ?? this.classify(text, o.code)) };
    if (cls.kind === 'usage_limit' && !cls.resetAt && o.fallbackResetAt) cls.resetAt = o.fallbackResetAt;
    const key = cls.resumeFailed ? 'resume' : cls.kind;
    const norm = text.trim();
    if (key === 'other' && norm !== '' && norm === this.lastText) return [{ kind: 'system', text: `(같은 오류 반복) ${oneLine(text, 300)}`, raw }];
    this.lastText = norm;
    this.lastClass = cls;
    if (key !== 'other') {
      const prev = this.emitted.get(key);
      const upgrade = cls.kind === 'usage_limit' && !!cls.resetAt && prev !== undefined && !prev.hasReset;
      if (prev && !upgrade) return [{ kind: 'system', text: `(같은 오류 반복) ${oneLine(text, 300)}`, raw }];
      this.emitted.set(key, { hasReset: !!cls.resetAt });
    }
    const label = cls.resumeFailed ? '이어하기 실패' : KIND_PREFIX[cls.kind];
    const data: NonNullable<ParsedCliEvent['data']> = { errorKind: cls.kind };
    if (cls.resetAt) data.resetAt = cls.resetAt;
    if (cls.rateLimitType) data.rateLimitType = cls.rateLimitType;
    if (cls.resumeFailed) data.resumeFailed = true;
    const body = text.trim() === '' ? '(내용 없음)' : text.trim();
    return [{ kind: 'error', text: `${label}: ${body}`, data, raw }];
  }

  /** 이미 정한 분류로 오류 이벤트 (rate_limit_event 등 구조화된 근거) */
  forced(text: string, raw: unknown, cls: ErrorClass): ParsedCliEvent[] {
    return this.event(text, raw, { cls });
  }
}

export function epochSecondsToIso(v: unknown): string | undefined {
  const n = num(v);
  if (n === undefined || n <= 0) return undefined;
  return new Date(n > 1e12 ? n : n * 1000).toISOString();
}
