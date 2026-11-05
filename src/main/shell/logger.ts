/**
 * main 프로세스 로그 → <앱데이터>/logs/main.log (5MB마다 회전, 이전 파일 3개 보관).
 * 줄 단위 동기 쓰기: 비정상 종료 직전 기록까지 남기기 위해서다 (껍데기 로그는 양이 적다).
 * 한 번의 기록은 늘 한 줄이다 — 줄바꿈·제어 문자는 보이는 글자로 바꾸고, 한 줄의 크기에 상한을 둔다 (S2-13: 원격 호출자의 글이 가짜 줄을 만들거나 회전을 밀어내지 못하게).
 */
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { inspect } from 'node:util';

export interface Logger {
  info(message: string, ...details: unknown[]): void;
  warn(message: string, ...details: unknown[]): void;
  error(message: string, ...details: unknown[]): void;
}

export interface FileLogger extends Logger {
  readonly filePath: string;
  /**
   * 기록 파일을 실제로 열어 두었고 마지막 쓰기가 성공했는지. 아니면 기록은 표준 오류로만 갔다 — 운영자에게 없는 파일을 가리키지 않게
   * (서버 시작 실패 안내, S2-16)
   */
  isWritable(): boolean;
  /** 통합 단계에서 core 가리기(대표가 등록한 비밀 값 포함)로 바꿔 끼운다 */
  setRedactor(redact: (text: string) => string): void;
  close(): void;
}

export interface FileLoggerOptions {
  dir: string;
  fileName?: string;
  /** 기본 5MB */
  maxBytes?: number;
  /** 보관할 이전 파일 수 (main.log.1 … main.log.N). 기본 3 */
  keep?: number;
  mirrorToConsole?: boolean;
  now?: () => Date;
  /** 한 번의 기록 상한 (UTF-8 바이트, 시각·수준 포함). 기본 MAX_ENTRY_BYTES */
  maxEntryBytes?: number;
}

type Level = 'INFO' | 'WARN' | 'ERROR';

/** 한 번의 기록 상한 — 넘으면 잘라 TRUNCATED_MARK를 붙인다 (S2-13: 큰 인자 하나가 회전 파일을 밀어내지 못하게) */
export const MAX_ENTRY_BYTES = 4096;
export const TRUNCATED_MARK = '…(잘림)';

/** C0(탭 빼고)·DEL·C1 제어 문자와 줄 구분자 U+2028·U+2029 (몇몇 보기 도구가 줄바꿈으로 그린다 — 원본 글자를 이 파일에 두지 않으려고 코드로 만든다) */
const CONTROL_CHARS = new RegExp(`[\\u0000-\\u0008\\u000a-\\u001f\\u007f-\\u009f${String.fromCharCode(0x2028, 0x2029)}]`, 'g');

/**
 * 줄바꿈과 그 밖의 제어 문자를 보이는 글자(`\n`, `\r`, `\u001b` …)로 바꾼다 (S2-13). 기록은 한 번에 한 줄이라, 요청 인자를 되풀이하는 오류 글처럼
 * 부른 쪽이 넘긴 글이 기록에 가짜 줄을 만들지 못한다. 탭은 그대로 둔다
 */
export function escapeControls(text: string): string {
  return text.replace(CONTROL_CHARS, (c) => (c === '\n' ? '\\n' : c === '\r' ? '\\r' : `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`));
}

/** UTF-8로 maxBytes를 넘으면 잘라 표시를 붙인다 — 글자 경계까지 물려 자른 글자 조각을 남기지 않는다 */
function capEntry(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  const buf = Buffer.from(text);
  let end = Math.max(0, maxBytes - Buffer.byteLength(TRUNCATED_MARK));
  while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return `${buf.subarray(0, end).toString('utf8')}${TRUNCATED_MARK}`;
}

/** 표준 오류로 가는 기록기 자신의 실패 안내 — 스택 없이 코드·메시지만 (운영자가 보는 글에 날것의 스택을 넣지 않는다, S2-16) */
function briefError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const code = (error as NodeJS.ErrnoException).code;
  return code && !error.message.startsWith(code) ? `${code}: ${error.message}` : error.message;
}

// 앱이 저장하는 파일에 비밀 값이 남지 않게 하는 기본 가리기 (AC-20). 표기는 core 가리기와 같은 [가림:종류].
const DEFAULT_PATTERNS: readonly [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[가림:개인키]'],
  [/\bsk-ant-[A-Za-z0-9_-]{10,}/g, '[가림:API키]'],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, '[가림:API키]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[가림:AWS키]'],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, '[가림:GitHub토큰]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '[가림:GitHub토큰]'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, '[가림:Slack토큰]'],
  [/\bAIza[0-9A-Za-z_-]{35}/g, '[가림:Google키]'],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, '[가림:GitLab토큰]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[가림:JWT]'],
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [가림:토큰]'],
  [/(\/\/[^/\s:@]+:)[^@\s/]+@/g, '$1[가림:비밀번호]@'],
  // 대소문자 무시: access_token=…, api_key: … 같은 주소 쿼리·설정 문구도 가린다
  [/\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Za-z0-9_]*\s*[=:]\s*)(["']?)[^\s"'&]+\2/gi, '$1[가림:값]'],
];

export function defaultRedact(text: string): string {
  let out = text;
  for (const [pattern, replacement] of DEFAULT_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

export function formatDetail(detail: unknown): string {
  if (typeof detail === 'string') return detail;
  return inspect(detail, { depth: 5, breakLength: Infinity, maxStringLength: 20_000, maxArrayLength: 50 });
}

/** 로그 파일조차 쓸 수 없을 때의 마지막 출력. GUI 실행에서는 표준 오류가 없을 수 있어 실패해도 더 할 일이 없다 */
function lastResort(text: string): void {
  try {
    process.stderr.write(text.endsWith('\n') ? text : `${text}\n`);
  } catch {
    // 보고할 곳이 남아 있지 않다
  }
}

export function createFileLogger(options: FileLoggerOptions): FileLogger {
  const maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
  const keep = Math.max(1, options.keep ?? 3);
  const now = options.now ?? (() => new Date());
  const filePath = join(options.dir, options.fileName ?? 'main.log');
  let redact: (text: string) => string = defaultRedact;
  let fd: number | null = null;
  let size = 0;
  // 회전 실패(다른 프로그램이 파일을 잡고 있음 등) 뒤에는 조금 더 쌓인 다음 다시 시도한다
  let rotateAt = maxBytes;
  let closed = false;

  const open = (): number => {
    mkdirSync(options.dir, { recursive: true });
    const handle = openSync(filePath, 'a');
    fd = handle;
    size = fstatSync(handle).size;
    rotateAt = maxBytes;
    return handle;
  };

  const rotate = (): void => {
    if (fd !== null) {
      closeSync(fd);
      fd = null;
    }
    try {
      const oldest = `${filePath}.${keep}`;
      // rmSync는 Node 24.13(Windows)에서 한글 경로면 프로세스가 죽는다 — unlinkSync를 쓴다
      if (existsSync(oldest)) unlinkSync(oldest);
      for (let i = keep - 1; i >= 1; i--) {
        const from = `${filePath}.${i}`;
        if (existsSync(from)) renameSync(from, `${filePath}.${i + 1}`);
      }
      renameSync(filePath, `${filePath}.1`);
    } finally {
      open();
    }
  };

  /** 마지막 열기·쓰기가 실패해 기록이 표준 오류로만 가는 중 — 실패 안내는 그동안 한 번만 낸다 */
  let failing = false;
  const maxEntryBytes = options.maxEntryBytes ?? MAX_ENTRY_BYTES;

  /**
   * 기록 한 줄: 가린 뒤 제어 문자를 바꾸고 크기를 자른다 (S2-13 — 가리기 규칙이 줄바꿈 낀 값도 보도록 바꾸기 전에 가린다). 끝의 줄바꿈 하나만 진짜다
   */
  const format = (stamp: string, level: Level, message: string, details: unknown[], detail: (d: unknown) => string): string => {
    let line: string;
    try {
      const suffix = details.length > 0 ? ` ${details.map(detail).join(' ')}` : '';
      line = redact(`${stamp} [${level}] ${message}${suffix}`);
    } catch (error) {
      // 가리지 못한 상세 내용은 남기지 않는다
      const reason = error instanceof Error ? error.name : typeof error;
      line = defaultRedact(`${stamp} [${level}] ${message} (상세 내용을 가리지 못해 생략함: ${reason})`);
    }
    return `${capEntry(escapeControls(line), maxEntryBytes)}\n`;
  };

  /** 표준 오류로 갈 때는 오류의 스택을 빼고 코드·메시지만 (S2-16) */
  const briefDetail = (d: unknown): string => (d instanceof Error ? `${d.name}: ${briefError(d)}` : formatDetail(d));

  const write = (level: Level, message: string, details: unknown[]): void => {
    const stamp = now().toISOString();
    const line = format(stamp, level, message, details, formatDetail);
    const fallback = (): string => (details.length > 0 ? format(stamp, level, message, details, briefDetail) : line);
    if (options.mirrorToConsole) {
      const out = level === 'ERROR' ? console.error : level === 'WARN' ? console.warn : console.log;
      out(line.trimEnd());
    }
    if (closed) {
      lastResort(fallback());
      return;
    }
    try {
      let handle = fd ?? open();
      const bytes = Buffer.byteLength(line);
      if (size > 0 && size + bytes > rotateAt) {
        try {
          rotate();
        } catch (error) {
          lastResort(`[욱채 로그 회전 실패] ${briefError(error)}`);
          if (fd === null) open();
          rotateAt = size + Math.ceil(maxBytes / 4);
        }
        handle = fd as number;
      }
      writeSync(handle, line);
      size += bytes;
      failing = false;
    } catch (error) {
      if (!failing) lastResort(`[욱채 로그 기록 실패] ${filePath} (${briefError(error)})`);
      failing = true;
      lastResort(fallback());
    }
  };

  try {
    open();
  } catch (error) {
    failing = true;
    lastResort(`[욱채 로그 파일을 열지 못했습니다] ${filePath} (${briefError(error)})`);
  }

  return {
    filePath,
    isWritable: () => fd !== null && !failing && !closed,
    info: (message, ...details) => write('INFO', message, details),
    warn: (message, ...details) => write('WARN', message, details),
    error: (message, ...details) => write('ERROR', message, details),
    setRedactor(next) {
      redact = next;
    },
    close() {
      if (closed) return;
      closed = true;
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch (error) {
          lastResort(`[욱채 로그 파일 닫기 실패] ${briefError(error)}`);
        }
        fd = null;
      }
    },
  };
}
