/** 껍데기 상태 파일(backup-state.json 등) 읽기·쓰기 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type JsonReadResult = { ok: true; value: unknown } | { ok: false; missing: true } | { ok: false; missing: false; error: Error };

export function readJsonFile(path: string): JsonReadResult {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: false, missing: true };
    return { ok: false, missing: false, error: error instanceof Error ? error : new Error(String(error)) };
  }
  try {
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch (error) {
    return { ok: false, missing: false, error: error instanceof Error ? error : new Error(String(error)) };
  }
}

/** 임시 파일에 쓴 뒤 이름을 바꿔, 쓰는 도중 꺼져도 반쯤 쓴 파일이 남지 않게 한다 */
export function writeJsonFileAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  try {
    renameSync(tmp, path);
  } catch (error) {
    // rmSync는 Node 24.13(Windows)에서 한글 경로면 프로세스가 죽는다 — unlinkSync를 쓴다
    try {
      unlinkSync(tmp);
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new AggregateError([error, cleanupError], `상태 파일을 저장하지 못했고 임시 파일도 지우지 못했습니다: ${tmp}`);
      }
    }
    throw error;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
