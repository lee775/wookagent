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
