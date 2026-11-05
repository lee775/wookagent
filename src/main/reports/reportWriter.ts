/**
 * 보고서 마크다운 생성·저장 (6.2 RPT-02·03·04, DOC-07).
 * - 양식: 머리(제목·프로젝트·지시 ID·회차·작성 시각 KST) → 요약 → 결과(+변경 파일) → 확인 방법 → 이슈·리스크 → 다음 할 일 → 작업 통계
 * - 저장 위치: <앱 데이터>/reports/<프로젝트 또는 일반>/<YYYY-MM>/<YYYY-MM-DD>_<지시ID 또는 직접>_<제목>_v<회차>.md
 * - 비밀 값은 마크다운을 만들 때 가린다 (등록 값까지 가리려면 오케스트레이터의 가리개를 넘긴다)
 */
import { constants as fsConstants, promises as fsp } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createRedactor, type Redactor } from '@core/redact';
import type { ReportSections, ReportStats } from '@shared/domain';

export const GENERAL_FOLDER = '일반';
export const DIRECT_DIRECTIVE_LABEL = '직접';
export const REPORT_TIME_ZONE = 'Asia/Seoul';
/** 양식의 요약 줄 수 상한 (RPT-02 '요약 | 결과를 3줄 이내로') — 빈 줄은 세지 않는다 */
export const REPORT_SUMMARY_MAX_LINES = 3;

export class ReportFileError extends Error {
  constructor(
    public readonly code: 'invalid_input' | 'invalid_path' | 'outside_base' | 'io',
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ReportFileError';
  }
}

/** 등록 값이 없는 기본 가리개 — 알려진 키 형식·대입 문맥만 가린다 */
const defaultRedactor = createRedactor();

// ───────────────────────── 시각 ─────────────────────────

interface ZonedParts {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function zonedParts(iso: string, timeZone: string): ZonedParts {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) throw new ReportFileError('invalid_input', `작성 시각을 해석할 수 없습니다: ${String(iso)}`);
  let fmt = formatterCache.get(timeZone);
  if (!fmt) {
    try {
      fmt = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      });
    } catch (err) {
      throw new ReportFileError('invalid_input', `알 수 없는 시간대입니다: ${timeZone}`, { cause: err });
    }
    formatterCache.set(timeZone, fmt);
  }
  const parts: Partial<ZonedParts> = {};
  for (const p of fmt.formatToParts(new Date(ms))) {
    if (p.type === 'year' || p.type === 'month' || p.type === 'day' || p.type === 'hour' || p.type === 'minute') parts[p.type] = p.value;
  }
  const { year, month, day, hour, minute } = parts;
  if (!year || !month || !day || !hour || !minute) throw new ReportFileError('invalid_input', `작성 시각을 변환하지 못했습니다: ${iso}`);
  return { year: year.padStart(4, '0'), month, day, hour, minute };
}

/** 'YYYY-MM-DD HH:mm (KST)' */
export function formatKst(iso: string): string {
  const p = zonedParts(iso, REPORT_TIME_ZONE);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} (KST)`;
}

// ───────────────────────── 통계 표기 ─────────────────────────

const numberFormat = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 0 });

function formatCount(n: number, unit: string): string {
  return Number.isFinite(n) && n >= 0 ? `${numberFormat.format(Math.round(n))}${unit}` : '알 수 없음';
}

/** 사람이 읽는 소요 시간: 45초, 5분 30초, 1시간 5분, 2일 3시간 */
export function formatDuration(totalSec: number): string {
  if (!Number.isFinite(totalSec) || totalSec < 0) return '알 수 없음';
  const sec = Math.round(totalSec);
  if (sec < 60) return `${sec}초`;
  const days = Math.floor(sec / 86_400);
  const hours = Math.floor((sec % 86_400) / 3_600);
  const minutes = Math.floor((sec % 3_600) / 60);
  const seconds = sec % 60;
  if (days > 0) return [`${days}일`, hours > 0 ? `${hours}시간` : '', minutes > 0 ? `${minutes}분` : ''].filter(Boolean).join(' ');
  if (hours > 0) return minutes > 0 ? `${hours}시간 ${minutes}분` : `${hours}시간`;
  return seconds > 0 ? `${minutes}분 ${seconds}초` : `${minutes}분`;
}

export function formatUsd(cost: number): string {
  if (!Number.isFinite(cost) || cost < 0) return '알 수 없음';
  const digits = cost >= 1 || cost === 0 ? 2 : 4;
  return `$${cost.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: digits })}`;
}

function formatUsage(stats: ReportStats): string {
  const parts = [`입력 ${formatCount(stats.inputTokens, ' 토큰')}`, `출력 ${formatCount(stats.outputTokens, ' 토큰')}`];
  if (stats.costUsd !== null && stats.costUsd !== undefined) parts.push(`비용 ${formatUsd(stats.costUsd)}`);
  return parts.join(' · ');
}

// ───────────────────────── 본문 정리 ─────────────────────────

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * 항목 본문을 보고서 구조 안에 가둔다: 줄바꿈 LF, 앞뒤 빈 줄 제거, 제목(#·밑줄 제목)을 두 단계 낮춤,
 * 닫히지 않은 코드 블록은 닫는다 (안 닫으면 뒤 항목 전체가 코드로 보인다).
 */
function normalizeBody(raw: string): string {
  const lines = raw.replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/[ \t]+$/, ''));
  const out: string[] = [];
  let fence: { char: string; len: number } | null = null;
  for (const line of lines) {
    const f = FENCE_RE.exec(line);
    if (fence) {
      out.push(line);
      if (f && f[1]![0] === fence.char && f[1]!.length >= fence.len && line.trim() === f[1]) fence = null;
      continue;
    }
    // ``` 뒤 정보 문자열에 백틱이 있으면 코드 블록이 아니라 인라인 코드다 (CommonMark)
    if (f && !(f[1]![0] === '`' && line.slice(line.indexOf(f[1]!) + f[1]!.length).includes('`'))) {
      fence = { char: f[1]![0]!, len: f[1]!.length };
      out.push(line);
      continue;
    }
    const atx = /^( {0,3})(#{1,6})(?=\s|$)(.*)$/.exec(line);
    if (atx) {
      out.push(`${atx[1]}${'#'.repeat(Math.min(6, atx[2]!.length + 2))}${atx[3]}`);
      continue;
    }
    const prev = out.length > 0 ? out[out.length - 1]! : '';
    const setext = /^ {0,3}(=+|-+)[ \t]*$/.exec(line);
    // 문단 바로 아래의 ===/--- 는 밑줄 제목이다 (목록·제목·표·인용·코드 블록 아래면 아님)
    if (setext && prev.trim().length > 0 && !/^ {0,3}(?:[-*+]|\d+[.)])\s|^ {0,3}[#|>]/.test(prev) && !FENCE_RE.test(prev)) {
      out[out.length - 1] = `${setext[1]![0] === '=' ? '###' : '####'} ${prev.trim()}`;
      continue;
    }
    out.push(line);
  }
  if (fence) out.push(fence.char.repeat(fence.len));
  while (out.length > 0 && out[0]!.trim() === '') out.shift();
  while (out.length > 0 && out[out.length - 1]!.trim() === '') out.pop();
  return out.join('\n');
}

function oneLine(s: string): string {
  return s.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

function inlineCode(s: string): string {
  const longest = Math.max(0, ...(s.match(/`+/g) ?? []).map((m) => m.length));
  const ticks = '`'.repeat(longest + 1);
  const pad = s.startsWith('`') || s.endsWith('`') || longest > 0 ? ' ' : '';
  return `${ticks}${pad}${s}${pad}${ticks}`;
}

// ───────────────────────── 마크다운 ─────────────────────────

export interface ReportMarkdownInput {
  title: string;
  projectName: string;
  directiveId: string | null;
  round: number;
  /** ISO 시각 (UTC) */
  createdAt: string;
  sections: ReportSections;
  stats: ReportStats;
  /** 등록 값·턴 토큰까지 가리려면 오케스트레이터의 가리개를 넘긴다. 없으면 알려진 형식만 가린다 (RPT-04) */
  redactor?: Redactor;
}

function assertRound(round: number): void {
  if (!Number.isInteger(round) || round < 1) throw new ReportFileError('invalid_input', `회차는 1 이상의 정수여야 합니다: ${String(round)}`);
}

export function renderReportMarkdown(input: ReportMarkdownInput): string {
  assertRound(input.round);
  const red = input.redactor ?? defaultRedactor;
  const body = (s: string | null | undefined, empty: string): string => {
    const normalized = normalizeBody(red.text(s ?? ''));
    return normalized.length > 0 ? normalized : empty;
  };
  const title = oneLine(red.text(input.title ?? '')) || '보고서';
  const projectName = oneLine(red.text(input.projectName ?? '')) || GENERAL_FOLDER;
  const directive = input.directiveId ? oneLine(input.directiveId) : '없음 (메인 에이전트 직접 명령)';

  const files: string[] = [];
  const seen = new Set<string>();
  for (const f of input.sections.changedFiles ?? []) {
    const p = oneLine(red.text(f));
    if (p.length === 0 || seen.has(p)) continue;
    seen.add(p);
    files.push(`- ${inlineCode(p)}`);
  }

  const { stats } = input;
  const lines = [
    `# ${title}`,
    '',
    `- 프로젝트: ${projectName}`,
    `- 지시 ID: ${directive}`,
    `- 회차: ${input.round}회차`,
    `- 작성 시각: ${formatKst(input.createdAt)}`,
    '',
    '## 요약',
    '',
    body(input.sections.summary, '내용 없음'),
    '',
    '## 결과',
    '',
    body(input.sections.results, '내용 없음'),
    '',
    '### 변경 파일',
    '',
    ...(files.length > 0 ? files : ['- 없음']),
    '',
    '## 확인 방법',
    '',
    body(input.sections.howToVerify, '내용 없음'),
    '',
    '## 이슈·리스크',
    '',
    body(input.sections.issues, '없음'),
    '',
    '## 다음 할 일',
    '',
    body(input.sections.nextSteps, '없음'),
    '',
    '## 작업 통계',
    '',
    '| 항목 | 값 |',
    '| --- | --- |',
    `| 작업 수 | ${formatCount(stats.taskCount, '개')} |`,
    `| 반려 횟수 | ${formatCount(stats.rejectCount, '회')} |`,
    `| 소요 시간 | ${formatDuration(stats.durationSec)} |`,
    `| 사용량 | ${formatUsage(stats)} |`,
    '',
  ];
  return lines.join('\n');
}

// ───────────────────────── 파일 이름 ─────────────────────────

const WINDOWS_RESERVED_RE = /^(?:CON|PRN|AUX|NUL|COM[0-9¹²³]|LPT[0-9¹²³]|CONIN\$|CONOUT\$)$/i;
const INVALID_NAME_CHARS_RE = /[<>:"/\\|?*\p{Cc}\p{Cf}]/gu;
const MAX_SEGMENT = 60;

/** 폴더·파일 이름 한 조각을 Windows·macOS에서 안전하게 만든다 (한국어 유지) */
function sanitizeSegment(raw: string, space: ' ' | '-'): string {
  let s = raw.normalize('NFC').replace(INVALID_NAME_CHARS_RE, ' ');
  s = space === '-' ? s.replace(/\s+/g, '-').replace(/-{2,}/g, '-') : s.replace(/\s+/g, ' ');
  s = s.replace(/^[\s.\-]+|[\s.\-]+$/g, '');
  // 코드 포인트 기준으로 잘라 서로게이트 쌍(이모지)이 깨지지 않게 한다
  const cps = Array.from(s);
  if (cps.length > MAX_SEGMENT) s = cps.slice(0, MAX_SEGMENT).join('').replace(/[\s.\-]+$/g, '');
  const base = s.split('.')[0] ?? '';
  if (WINDOWS_RESERVED_RE.test(base.trim())) s = `_${s}`;
  return s;
}

export interface ReportPathInput {
  /** null = '메인 에이전트 직접' 명령 (DOC-07, '일반' 폴더) */
  projectName: string | null;
  directiveId: string | null;
  title: string;
  round: number;
  createdAt: string;
  /** 날짜를 정하는 시간대. 기본 Asia/Seoul */
  timeZone?: string;
}

/** '<프로젝트 또는 일반>/<YYYY-MM>/<YYYY-MM-DD>_<지시ID 또는 직접>_<제목>_v<회차>.md' ('/' 구분) */
export function reportRelativePath(input: ReportPathInput): string {
  assertRound(input.round);
  const p = zonedParts(input.createdAt, input.timeZone ?? REPORT_TIME_ZONE);
  const folder = input.projectName === null ? GENERAL_FOLDER : sanitizeSegment(defaultRedactor.text(input.projectName), ' ') || '프로젝트';
  const directive = sanitizeSegment(input.directiveId ?? DIRECT_DIRECTIVE_LABEL, '-') || DIRECT_DIRECTIVE_LABEL;
  const title = sanitizeSegment(defaultRedactor.text(input.title), '-') || '보고서';
  return `${folder}/${p.year}-${p.month}/${p.year}-${p.month}-${p.day}_${directive}_${title}_v${input.round}.md`;
}

// ───────────────────────── 저장 ─────────────────────────

export interface WriteReportOptions {
  /** true = 같은 경로의 파일을 원자적으로 교체. 기본 false = 기존 보고서를 덮어쓰지 않고 '-2', '-3' 이름을 붙인다 (FBK-03) */
  overwrite?: boolean;
  /**
   * 저장은 끝났지만 뒷정리(임시 파일 삭제·폴더 동기화)가 실패했을 때 알림. 저장 성공을 실패로 바꾸면
   * 다시 시도하다 중복 보고서가 생기므로 오류로 던지지 않고 여기로 알린다. 기본은 console.warn
   */
  onWarning?: (message: string, cause: unknown) => void;
}

const MAX_NAME_ATTEMPTS = 1000;
const BUSY_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const LINK_UNSUPPORTED_CODES = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS', 'EINVAL', 'EMLINK']);
const DIR_FSYNC_UNSUPPORTED_CODES = new Set(['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'EISDIR', 'EPERM', 'EBADF']);

const errCode = (err: unknown): string | undefined =>
  typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : undefined;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 앱 데이터 보고서 폴더 기준 상대 경로를 검사하고 절대 경로로 바꾼다 */
function resolveInside(baseDir: string, relPath: string): { base: string; target: string } {
  if (typeof relPath !== 'string' || relPath.trim().length === 0) throw new ReportFileError('invalid_path', '보고서 경로가 비어 있습니다');
  if (relPath.includes('\0')) throw new ReportFileError('invalid_path', '보고서 경로에 쓸 수 없는 글자가 있습니다');
  if (path.isAbsolute(relPath) || path.win32.isAbsolute(relPath) || /^[A-Za-z]:/.test(relPath)) {
    throw new ReportFileError('outside_base', `보고서 폴더 밖의 경로에는 쓸 수 없습니다: ${relPath}`);
  }
  const segments = relPath.split(/[\\/]+/).filter((s) => s.length > 0);
  for (const seg of segments) {
    if (seg === '..') throw new ReportFileError('outside_base', `보고서 폴더 밖의 경로에는 쓸 수 없습니다: ${relPath}`);
    if (WINDOWS_RESERVED_RE.test((seg.split('.')[0] ?? '').trim())) {
      throw new ReportFileError('invalid_path', `Windows 예약 이름은 쓸 수 없습니다: ${seg}`);
    }
    if (/[<>:"|?*\p{Cc}]/u.test(seg) || /[. ]$/.test(seg)) throw new ReportFileError('invalid_path', `파일 이름에 쓸 수 없는 글자가 있습니다: ${seg}`);
  }
  const base = path.resolve(baseDir);
  const target = path.resolve(base, relPath);
  const rel = path.relative(base, target);
  if (rel.length === 0 || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new ReportFileError('outside_base', `보고서 폴더 밖의 경로에는 쓸 수 없습니다: ${relPath}`);
  }
  return { base, target };
}

async function fsyncDir(dir: string): Promise<void> {
  // Windows는 폴더 핸들 fsync를 지원하지 않는다
  if (process.platform === 'win32') return;
  const fh = await fsp.open(dir, 'r');
  try {
    await fh.sync();
  } catch (err) {
    if (!DIR_FSYNC_UNSUPPORTED_CODES.has(errCode(err) ?? '')) throw err;
  } finally {
    await fh.close();
  }
}

/** Windows에서는 백신·탐색기가 잠깐 파일을 잡고 있으면 EPERM/EBUSY가 난다 — 잠시 뒤 다시 시도 */
async function retryBusy<T>(op: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await op();
    } catch (err) {
      if (process.platform !== 'win32' || attempt >= 8 || !BUSY_RETRY_CODES.has(errCode(err) ?? '')) throw err;
      await sleep(25 * 2 ** Math.min(attempt, 4));
    }
  }
}

function candidateName(target: string, n: number): string {
  if (n === 1) return target;
  const ext = path.extname(target);
  return `${target.slice(0, target.length - ext.length)}-${n}${ext}`;
}

/** 이미 있는 보고서를 덮어쓰지 않고 처음 비어 있는 이름에 완성된 파일을 올린다 (하드 링크는 원자적이며 이미 있으면 실패) */
async function commitUnique(tmp: string, target: string): Promise<string> {
  let useLink = true;
  for (let n = 1; n <= MAX_NAME_ATTEMPTS; n++) {
    const candidate = candidateName(target, n);
    if (useLink) {
      try {
        await fsp.link(tmp, candidate);
        return candidate;
      } catch (err) {
        const code = errCode(err);
        if (code === 'EEXIST') continue;
        if (!LINK_UNSUPPORTED_CODES.has(code ?? '')) throw err;
        // FAT·exFAT·일부 네트워크 드라이브는 하드 링크가 없다 — 배타적 복사로 대신한다
        useLink = false;
      }
    }
    try {
      await fsp.copyFile(tmp, candidate, fsConstants.COPYFILE_EXCL);
      return candidate;
    } catch (err) {
      if (errCode(err) === 'EEXIST') continue;
      throw err;
    }
  }
  throw new ReportFileError('io', `같은 이름의 보고서가 너무 많아 저장할 이름을 정하지 못했습니다: ${path.basename(target)}`);
}

/**
 * 보고서를 baseDir 아래 relPath에 UTF-8(LF, BOM 없음)로 저장하고 실제 절대 경로를 돌려준다.
 * 임시 파일에 다 쓰고 fsync한 뒤 한 번에 드러내므로, 읽는 쪽은 반쯤 쓴 파일을 보지 않는다.
 * baseDir 밖(.., 절대 경로, 폴더 연결로 밖을 가리키는 경우)은 거부한다.
 */
export async function writeReportFile(baseDir: string, relPath: string, markdown: string, opts: WriteReportOptions = {}): Promise<string> {
  if (typeof markdown !== 'string') throw new ReportFileError('invalid_input', '보고서 내용이 문자열이 아닙니다');
  const { base, target } = resolveInside(baseDir, relPath);
  let content = markdown.replace(/\r\n?/g, '\n');
  if (!content.endsWith('\n')) content += '\n';
  const dir = path.dirname(target);
  try {
    await fsp.mkdir(dir, { recursive: true });
  } catch (err) {
    throw new ReportFileError('io', `보고서 폴더를 만들지 못했습니다: ${dir}`, { cause: err });
  }
  // 폴더 연결(심볼릭 링크·정션)로 보고서 폴더 밖을 가리키지 않는지 실제 경로로 확인
  let realBase: string;
  let realDir: string;
  try {
    [realBase, realDir] = await Promise.all([fsp.realpath(base), fsp.realpath(dir)]);
  } catch (err) {
    throw new ReportFileError('io', `보고서 폴더의 실제 위치를 확인하지 못했습니다: ${dir}`, { cause: err });
  }
  const relReal = path.relative(realBase, realDir);
  if (relReal.startsWith('..') || path.isAbsolute(relReal)) {
    throw new ReportFileError('outside_base', `보고서 폴더 밖을 가리키는 폴더에는 쓸 수 없습니다: ${dir}`);
  }

  const warn = opts.onWarning ?? ((message: string, cause: unknown) => console.warn(`[보고서] ${message}`, cause));
  const tmp = path.join(dir, `.${randomBytes(8).toString('hex')}.report.tmp`);
  const removeTmp = async (): Promise<void> => {
    try {
      await retryBusy(() => fsp.rm(tmp, { force: true }));
    } catch (err) {
      warn(`임시 파일을 지우지 못했습니다: ${tmp}`, err);
    }
  };

  let finalPath: string;
  try {
    const fh = await fsp.open(tmp, 'wx');
    try {
      await fh.writeFile(content, 'utf8');
      await fh.sync();
    } finally {
      await fh.close();
    }
    if (opts.overwrite) {
      await retryBusy(() => fsp.rename(tmp, target));
      finalPath = target;
    } else {
      finalPath = await commitUnique(tmp, target);
    }
  } catch (err) {
    await removeTmp();
    if (err instanceof ReportFileError) throw err;
    throw new ReportFileError('io', `보고서 파일을 저장하지 못했습니다: ${target}`, { cause: err });
  }
  // 여기부터는 저장이 끝난 상태 — 뒷정리 실패는 알리기만 한다 (링크·복사는 임시 이름이 남아 있다)
  if (!opts.overwrite) await removeTmp();
  try {
    await fsyncDir(dir);
  } catch (err) {
    warn(`보고서 폴더 동기화에 실패했습니다: ${dir}`, err);
  }
  return finalPath;
}
