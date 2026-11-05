/**
 * 시험용: 수집한 실제 CLI 출력(__fixtures__/*.jsonl, *.stderr.txt)을 파서에 넣어 이벤트 목록을 만든다.
 * 모의 에이전트(MOCK-06)가 같은 형식을 내는지 비교할 때도 쓴다.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ParsedCliEvent } from '@shared/events';
import type { EventParser } from '../types';

export const FIXTURE_DIR = path.dirname(fileURLToPath(import.meta.url));

export interface CaptureMeta {
  versions: Record<string, string | null>;
  scenarios: Record<string, { cli: 'claude' | 'codex'; exitCode: number | null; argv: string[]; checks: Record<string, unknown>; modelCall: boolean }>;
}

export function readMeta(): CaptureMeta {
  return JSON.parse(readFileSync(path.join(FIXTURE_DIR, 'capture-meta.json'), 'utf8')) as CaptureMeta;
}

export function fixtureLines(name: string): { stdout: string[]; stderr: string[] } {
  const read = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l !== '') : []);
  return { stdout: read(path.join(FIXTURE_DIR, `${name}.jsonl`)), stderr: read(path.join(FIXTURE_DIR, `${name}.stderr.txt`)) };
}

/** stdout 전부 → stderr 전부 → finish(실제 종료 코드) 순서로 넣는다 */
export function replay(parser: EventParser, name: string, exitCode?: number | null): ParsedCliEvent[] {
  const { stdout, stderr } = fixtureLines(name);
  const code = exitCode !== undefined ? exitCode : (readMeta().scenarios[name]?.exitCode ?? null);
  const events: ParsedCliEvent[] = [];
  for (const l of stdout) events.push(...parser.pushLine(l));
  for (const l of stderr) events.push(...parser.pushStderr(l));
  events.push(...parser.finish(code));
  return events;
}

export function ofKind(events: ParsedCliEvent[], kind: ParsedCliEvent['kind']): ParsedCliEvent[] {
  return events.filter((e) => e.kind === kind);
}
