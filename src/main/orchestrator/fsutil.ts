/** 파일 도우미: 산출물 해시 목록, 폴더 복사·삭제, 원자적 쓰기 */
import { createHash } from 'node:crypto';
import { closeSync, cpSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import type { ArtifactFile } from '@shared/domain';

export function hashTree(dir: string, maxFiles = 2000): ArtifactFile[] {
  const out: ArtifactFile[] = [];
  if (!existsSync(dir)) return out;
  const walk = (d: string, depth: number) => {
    if (depth > 20 || out.length >= maxFiles) return;
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === '.git' || ent.name === 'node_modules') continue;
        walk(full, depth + 1);
      } else if (ent.isFile()) {
        const buf = readFileSync(full);
        out.push({
          path: relative(dir, full).split(sep).join('/'),
          sha256: createHash('sha256').update(buf).digest('hex'),
          size: buf.length,
        });
        if (out.length >= maxFiles) return;
      }
    }
  };
  walk(dir, 0);
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export function copyTree(src: string, dst: string): void {
  rmSync(dst, { recursive: true, force: true });
  mkdirSync(dirname(dst), { recursive: true });
  if (existsSync(src)) cpSync(src, dst, { recursive: true });
  else mkdirSync(dst, { recursive: true });
}

export function removeTree(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}

export function writeFileAtomic(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, file);
}

/**
 * 파일 이름 한 칸의 바이트 상한 — Linux(ext4 등)·macOS는 이름을 UTF-8 255바이트까지 받는다. 한글 한 글자는 3바이트라 120자 이름도 넘을 수 있다(넘으면
 * ENAMETOOLONG — 첨부 저장이 500으로 끝났다, 리드 결정 S10t). Windows(NTFS)는 UTF-16 255단위라 120자 규칙으로 충분하다 — 바이트로 자르지 않는다
 */
export const FILE_NAME_MAX_BYTES = process.platform === 'win32' ? Number.POSITIVE_INFINITY : 255;

/**
 * 파일 이름을 UTF-16 maxUnits 단위와 UTF-8 maxBytes 바이트 안에 맞춘다. 넘으면 마지막 확장자(점 뒤 16자까지)는 남기고 그 앞을 글자(코드 포인트) 단위로
 * 자른다 — 이모지 가운데에서 자르지 않고, 내려받은 파일이 그 형식의 앱으로 열리게. 확장자가 없거나 16자를 넘으면 그냥 앞에서부터 남긴다
 */
export function fitFileName(name: string, maxUnits: number, maxBytes: number = FILE_NAME_MAX_BYTES): string {
  if (name.length <= maxUnits && Buffer.byteLength(name, 'utf8') <= maxBytes) return name;
  const dot = name.lastIndexOf('.');
  const extLength = name.length - dot - 1;
  const ext = dot > 0 && extLength >= 1 && extLength <= 16 ? name.slice(dot) : '';
  const unitRoom = maxUnits - ext.length;
  const byteRoom = maxBytes - Buffer.byteLength(ext, 'utf8');
  let stem = '';
  let stemBytes = 0;
  for (const ch of ext ? name.slice(0, dot) : name) {
    const b = Buffer.byteLength(ch, 'utf8');
    if (stem.length + ch.length > unitRoom || stemBytes + b > byteRoom) break;
    stem += ch;
    stemBytes += b;
  }
  return stem + ext;
}

export function readTextOr(file: string, fallback: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return fallback;
  }
}

export function isDirEmpty(dir: string): boolean {
  try {
    return readdirSync(dir).length === 0;
  } catch {
    return true;
  }
}

export function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 파일 끝에서 maxBytes까지만 읽은 줄 — 이벤트 파일을 통째로 읽지 않는다. 중간에서 시작했으면 첫 줄은 잘린 줄이라 뺀다(줄바꿈은 한 바이트라 UTF-8 글자를 가르지
 * 않는다). 파일이 없으면 빈 목록
 */
export function readTail(file: string, maxBytes: number): { lines: string[]; truncated: boolean } {
  let fd: number;
  try {
    fd = openSync(file, 'r');
  } catch {
    return { lines: [], truncated: false };
  }
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    let read = 0;
    while (read < buf.length) {
      const n = readSync(fd, buf, read, buf.length - read, start + read);
      if (n <= 0) break;
      read += n;
    }
    const lines = buf.subarray(0, read).toString('utf8').split('\n');
    if (start > 0) lines.shift();
    return { lines: lines.filter(Boolean), truncated: start > 0 };
  } finally {
    closeSync(fd);
  }
}
