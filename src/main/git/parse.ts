/**
 * git 출력 해석 (순수 함수). gitService.ts가 쓴다.
 * 경로가 나오는 출력은 모두 -z(NUL 구분)로 받는다 — 공백·한글·따옴표가 든 경로도 그대로 온다.
 */
import type { CommitInfo, DiffFileStat, GitFileStatus } from './types';

const UNMERGED_CODES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

export interface ParsedStatus {
  files: GitFileStatus[];
  untracked: string[];
  unmerged: string[];
}

/** `git status --porcelain=v1 -z` */
export function parseStatusZ(out: string): ParsedStatus {
  const files: GitFileStatus[] = [];
  const untracked: string[] = [];
  const unmerged: string[] = [];
  const tokens = out.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i];
    if (!entry) continue;
    if (entry.length < 4 || entry[2] !== ' ') {
      throw new Error(`git status 출력을 해석하지 못했습니다: ${JSON.stringify(entry.slice(0, 120))}`);
    }
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    // -z 형식의 이름 바뀜 항목은 "XY 새경로\0원래경로\0"
    if (code[0] === 'R' || code[0] === 'C' || code[1] === 'R' || code[1] === 'C') i++;
    if (code === '!!') continue;
    files.push({ path, code });
    if (code === '??') untracked.push(path);
    else if (UNMERGED_CODES.has(code)) unmerged.push(path);
  }
  return { files, untracked, unmerged };
}

export interface WorktreeEntry {
  /** git이 기록한 경로 (Windows에서도 / 구분) */
  path: string;
  head: string | null;
  /** refs/heads/... 전체 이름. 분리 HEAD·bare면 null */
  branch: string | null;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  /** 폴더가 사라져 정리 대상 (git 2.31+가 표시) */
  prunable: boolean;
}

/** `git worktree list --porcelain` (줄 단위 형식, 첫 항목이 기본 작업 폴더) */
export function parseWorktreeList(out: string): WorktreeEntry[] {
  const list: WorktreeEntry[] = [];
  let cur: WorktreeEntry | null = null;
  for (const raw of out.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line === '') {
      if (cur) list.push(cur);
      cur = null;
      continue;
    }
    if (line.startsWith('worktree ')) {
      if (cur) list.push(cur);
      cur = {
        path: unquoteGitPath(line.slice('worktree '.length)),
        head: null,
        branch: null,
        detached: false,
        bare: false,
        locked: false,
        prunable: false,
      };
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('HEAD ')) cur.head = line.slice(5).trim();
    else if (line.startsWith('branch ')) cur.branch = unquoteGitPath(line.slice(7));
    else if (line === 'detached') cur.detached = true;
    else if (line === 'bare') cur.bare = true;
    else if (line === 'locked' || line.startsWith('locked ')) cur.locked = true;
    else if (line === 'prunable' || line.startsWith('prunable ')) cur.prunable = true;
  }
  if (cur) list.push(cur);
  return list;
}

/** git의 C 스타일 따옴표 경로("a\tb", "\352\270\200")를 푼다. 따옴표가 없으면 그대로 */
export function unquoteGitPath(s: string): string {
  if (s.length < 2 || s[0] !== '"' || s[s.length - 1] !== '"') return s;
  const bytes: number[] = [];
  const pushText = (t: string) => {
    for (const b of Buffer.from(t, 'utf8')) bytes.push(b);
  };
  const body = s.slice(1, -1);
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== '\\') {
      const cp = body.codePointAt(i) ?? 0;
      const text = String.fromCodePoint(cp);
      pushText(text);
      i += text.length - 1;
      continue;
    }
    const n = body[++i];
    if (n === undefined) {
      bytes.push(0x5c);
      break;
    }
    const simple: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };
    if (n in simple) {
      bytes.push(simple[n]);
    } else if (/[0-7]/.test(n)) {
      let oct = n;
      while (oct.length < 3 && /[0-7]/.test(body[i + 1] ?? '')) oct += body[++i];
      bytes.push(parseInt(oct, 8) & 0xff);
    } else {
      pushText(n);
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

export interface NameStatusEntry {
  status: DiffFileStat['status'];
  path: string;
  /** 이름 바뀜·복사의 원래 경로 */
  oldPath: string | null;
}

function mapStatusLetter(letter: string): DiffFileStat['status'] {
  switch (letter) {
    case 'A':
      return 'A';
    case 'D':
      return 'D';
    case 'U':
      return 'U';
    case 'R':
      return 'R';
    // 복사는 새 파일로 본다
    case 'C':
      return 'A';
    // T(종류 바뀜)·X(알 수 없음)·M
    default:
      return 'M';
  }
}

/** `git diff --name-status -z` */
export function parseNameStatusZ(out: string): NameStatusEntry[] {
  const tokens = out.split('\0');
  const res: NameStatusEntry[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const code = tokens[i];
    if (!code) continue;
    if (!/^[A-Z][0-9]*$/.test(code)) {
      throw new Error(`git diff --name-status 출력을 해석하지 못했습니다: ${JSON.stringify(code.slice(0, 120))}`);
    }
    const letter = code[0];
    if (letter === 'R' || letter === 'C') {
      const oldPath = tokens[++i] ?? '';
      const path = tokens[++i] ?? '';
      res.push({ status: mapStatusLetter(letter), path, oldPath });
    } else {
      res.push({ status: mapStatusLetter(letter), path: tokens[++i] ?? '', oldPath: null });
    }
  }
  return res;
}

/** `git diff-tree`·`git diff-index`의 raw 출력 한 줄 — src = 앞쪽(트리), dst = 뒤쪽(트리·인덱스). 없는 쪽은 모드 000000 */
export interface RawDiffEntry {
  srcMode: string;
  dstMode: string;
  srcSha: string;
  dstSha: string;
  /** 첫 글자 (A·D·M·T·U …) */
  status: string;
}

/** `git diff-tree -r -z --no-renames` · `git diff-index -z --no-renames` (raw 형식) → 경로별 항목 */
export function parseRawDiffZ(out: string): Map<string, RawDiffEntry> {
  const tokens = out.split('\0');
  const map = new Map<string, RawDiffEntry>();
  for (let i = 0; i < tokens.length; i++) {
    const meta = tokens[i];
    if (!meta) continue;
    const m = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])\d*$/.exec(meta);
    if (!m) throw new Error(`git diff raw 출력을 해석하지 못했습니다: ${JSON.stringify(meta.slice(0, 120))}`);
    map.set(tokens[++i] ?? '', { srcMode: m[1]!, dstMode: m[2]!, srcSha: m[3]!, dstSha: m[4]!, status: m[5]! });
  }
  return map;
}

/** `git diff --numstat -z` → 새 경로별 줄 수. 바이너리('-')는 0 */
export function parseNumstatZ(out: string): Map<string, { additions: number; deletions: number }> {
  const tokens = out.split('\0');
  const map = new Map<string, { additions: number; deletions: number }>();
  for (let i = 0; i < tokens.length; i++) {
    const rec = tokens[i];
    if (!rec) continue;
    const m = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(rec);
    if (!m) throw new Error(`git diff --numstat 출력을 해석하지 못했습니다: ${JSON.stringify(rec.slice(0, 120))}`);
    let path = m[3];
    // 이름 바뀜: "추가\t삭제\t\0원래경로\0새경로\0"
    if (path === '') {
      i++;
      path = tokens[++i] ?? '';
    }
    map.set(path, {
      additions: m[1] === '-' ? 0 : Number(m[1]),
      deletions: m[2] === '-' ? 0 : Number(m[2]),
    });
  }
  return map;
}

export function combineDiffStats(
  entries: NameStatusEntry[],
  counts: Map<string, { additions: number; deletions: number }>,
): DiffFileStat[] {
  return entries.map((e) => {
    const c = counts.get(e.path) ?? { additions: 0, deletions: 0 };
    return { path: e.path, status: e.status, additions: c.additions, deletions: c.deletions };
  });
}

/** 필드 구분자 (커밋 메시지에 나올 일이 사실상 없는 제어 문자) */
export const LOG_FIELD_SEP = '\x1f';
export const LOG_FORMAT = '%H%x1f%P%x1f%s%x1f%b';

/** `git log -z --format=LOG_FORMAT` */
export function parseLogZ(out: string): CommitInfo[] {
  const res: CommitInfo[] = [];
  for (const rec of out.split('\0')) {
    if (rec.trim() === '') continue;
    const parts = rec.split(LOG_FIELD_SEP);
    if (parts.length < 4) throw new Error(`git log 출력을 해석하지 못했습니다: ${JSON.stringify(rec.slice(0, 120))}`);
    const [sha, parents, subject, ...body] = parts;
    const p = parents.trim();
    res.push({
      sha: sha.trim(),
      parents: p ? p.split(/\s+/) : [],
      subject,
      body: body.join(LOG_FIELD_SEP).replace(/\s+$/, ''),
    });
  }
  return res;
}

/**
 * git check-ref-format 규칙 (refs/heads/<이름> 같은 전체 이름에 적용).
 * 프로세스를 띄우지 않으려고 직접 검사한다.
 */
export function isValidRefName(ref: string): boolean {
  if (!ref || ref === '@') return false;
  if (ref.startsWith('/') || ref.endsWith('/') || ref.endsWith('.')) return false;
  if (ref.includes('//') || ref.includes('..') || ref.includes('@{')) return false;
  // 제어 문자·공백·~ ^ : ? * [ \
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(ref)) return false;
  for (const part of ref.split('/')) {
    if (!part || part.startsWith('.') || part.endsWith('.lock')) return false;
  }
  return true;
}

/** 남은 충돌 표시 (<<<<<<< / ======= / >>>>>>> 셋이 모두 있어야 충돌로 본다 — 오탐 줄이기) */
export function hasConflictMarkers(text: string): boolean {
  return /^<{7,}(?:[ \t]|\r?$)/m.test(text) && /^>{7,}(?:[ \t]|\r?$)/m.test(text) && /^={7,}\r?$/m.test(text);
}

/** git과 같은 기준: 앞 8000바이트에 NUL이 있으면 바이너리 */
export function looksBinary(buf: Uint8Array): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export function countLines(content: string): number {
  if (!content) return 0;
  const n = content.split('\n').length;
  return content.endsWith('\n') ? n - 1 : n;
}

/**
 * 미추적 파일을 git diff와 같은 모양의 "새 파일" 패치로 만든다.
 * content=null 이면 내용 생략 (바이너리·큰 파일 — git도 큰 파일은 바이너리로 표시한다)
 */
export function newFilePatch(relPath: string, mode: string, content: string | null): string {
  const head = `diff --git a/${relPath} b/${relPath}\nnew file mode ${mode}\n`;
  if (content === null) return `${head}Binary files /dev/null and b/${relPath} differ\n`;
  if (content === '') return head;
  const endsWithNewline = content.endsWith('\n');
  const lines = (endsWithNewline ? content.slice(0, -1) : content).split('\n');
  const n = lines.length;
  let s = `${head}--- /dev/null\n+++ b/${relPath}\n@@ -0,0 +1${n === 1 ? '' : `,${n}`} @@\n`;
  for (const l of lines) s += `+${l}\n`;
  if (!endsWithNewline) s += '\\ No newline at end of file\n';
  return s;
}

/**
 * 잘린 출력을 줄 경계(없으면 UTF-8 글자 경계)에서 끊어 문자열로 만든다.
 * 반환 bytes는 실제로 쓴 바이트 수
 */
export function decodeTruncated(buf: Buffer): { text: string; bytes: number } {
  const nl = buf.lastIndexOf(0x0a);
  if (nl >= 0) {
    const cut = buf.subarray(0, nl + 1);
    return { text: cut.toString('utf8'), bytes: cut.length };
  }
  // 줄바꿈이 없으면 끝의 불완전한 UTF-8 글자만 버린다
  let end = buf.length;
  let back = 0;
  while (end - back - 1 >= 0 && back < 3 && (buf[end - back - 1] & 0xc0) === 0x80) back++;
  const leadIdx = end - back - 1;
  if (leadIdx >= 0) {
    const lead = buf[leadIdx];
    const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
    if (need > back + 1) end = leadIdx;
  }
  const cut = buf.subarray(0, end);
  return { text: cut.toString('utf8'), bytes: cut.length };
}
