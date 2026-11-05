/**
 * 시험용: 어댑터가 준비한 실행 명령(PreparedRun)으로 모의 에이전트를 자식 프로세스로 띄우고,
 * 표준 출력·오류를 어댑터의 실제 파서에 줄 단위로 넣는다 (오케스트레이터가 하는 일과 같은 순서).
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { ParsedCliEvent } from '@shared/events';
import type { AgentAdapter, PreparedRun, TurnLaunch } from '../types';

export interface MockRun {
  prepared: PreparedRun;
  stdout: string[];
  stderr: string[];
  events: ParsedCliEvent[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** 시험이 끝냄 (응답 없음 재현·시간 초과) */
  killed: boolean;
  durationMs: number;
}

export interface RunOptions {
  /** 이 시간이 지나도 안 끝나면 끝내고 killed=true (기본 30초) */
  timeoutMs?: number;
  /** 정해진 시간 뒤 끝낸다 (응답 없음 재현) */
  killAfterMs?: number;
  /** 준비된 환경 변수를 바꾼다 (undefined = 지움). 어댑터를 거치지 않는 직접 실행 재현용 */
  envOverride?: Record<string, string | undefined>;
  /** 준비된 인자 대신 쓸 인자 (스크립트 경로 뒤) */
  argsOverride?: string[];
}

export async function runMockTurn(adapter: AgentAdapter, launch: TurnLaunch, o: RunOptions = {}): Promise<MockRun> {
  const prepared = await adapter.prepare(launch);
  const parser = adapter.createParser(launch);
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries({ ...prepared.spec.env, ...(o.envOverride ?? {}) })) if (v !== undefined) env[k] = v;
  if (o.argsOverride) prepared.spec.args = [prepared.spec.args[0]!, ...o.argsOverride];
  const t0 = performance.now();
  const child = spawn(prepared.spec.command, prepared.spec.args, { cwd: prepared.spec.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const stdout: string[] = [];
  const stderr: string[] = [];
  const events: ParsedCliEvent[] = [];
  let killed = false;
  const kill = () => {
    if (killed) return;
    killed = true;
    child.kill();
  };
  const timers = [setTimeout(kill, o.timeoutMs ?? 30_000)];
  if (o.killAfterMs !== undefined) timers.push(setTimeout(kill, o.killAfterMs));
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
    stdout.push(line);
    events.push(...parser.pushLine(line));
  });
  createInterface({ input: child.stderr, crlfDelay: Infinity }).on('line', (line) => {
    stderr.push(line);
    events.push(...parser.pushStderr(line));
  });
  let stdinError: Error | null = null;
  child.stdin.on('error', (e) => {
    stdinError = e;
  });
  child.stdin.end(prepared.spec.stdinText ?? '', 'utf8');
  const [exitCode, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, sig) => resolve([code, sig]));
  });
  for (const t of timers) clearTimeout(t);
  if (stdinError && !killed && exitCode === 0) throw new Error(`모의 에이전트 표준 입력 쓰기 실패: ${String(stdinError)}`);
  events.push(...parser.finish(exitCode));
  return { prepared, stdout, stderr, events, exitCode, signal, killed, durationMs: performance.now() - t0 };
}

/** 해석기가 모르는 줄·종류를 만났다는 표시 (모의 출력이 실제 형식과 어긋났다는 뜻) */
const UNKNOWN_MARKERS = ['해석하지 못한 출력', '알 수 없는 이벤트', '이벤트 해석 실패', '알 수 없는 항목', '알 수 없는 응답 내용', '항목 없는'];

export function unknownEvents(events: ParsedCliEvent[]): ParsedCliEvent[] {
  return events.filter((e) => e.kind === 'system' && UNKNOWN_MARKERS.some((m) => e.text.startsWith(m)));
}
