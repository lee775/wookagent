/**
 * host_exec 시험 도우미 (리드 결정 S5-16~S5-20): 메인 대화 턴을 하나 띄워 두고(가짜 CLI는 끝날 때까지 산다) 그 턴의 신원으로 host_exec를 부른다.
 * orchHarness의 서버 명령 갈래(러너 이름 '서버 명령 ')가 명령을 받는다 — 시험이 env.hostExec로 띄우는 법을 정한다
 */
import { MAIN_AGENT_ID } from '@shared/domain';
import type { ToolCallResult } from '../../src/main/mcp/types';
import type { HostExecResult } from '../../src/main/mcp/catalog';
import { FakeProc, waitFor, type OrchEnv } from './orchHarness';

export const MAIN_KEY = 'main:general';
let seq = 0;

/** 메인 대화 턴을 띄워 실행 중으로 둔다 — 대표 명령 하나를 싣는다 */
export async function liveMainTurn(e: OrchEnv, text = '서버 PC 상태를 봐 줘'): Promise<{ proc: FakeProc; turnId: string }> {
  e.hold.add(MAIN_KEY);
  await e.invoke('command.send', { target: 'main', text });
  e.tick();
  await waitFor(() => !!e.liveProc(MAIN_KEY, MAIN_AGENT_ID), '메인 턴 시작');
  const proc = e.liveProc(MAIN_KEY, MAIN_AGENT_ID)!;
  return { proc, turnId: proc.turnId };
}

/** 그 턴의 신원으로 host_exec — purpose·request_id는 주지 않으면 시험 값 */
export function hostExec(e: OrchEnv, turnId: string, args: Record<string, unknown>): Promise<ToolCallResult> {
  return e.tool(turnId, 'host_exec', { purpose: '시험 명령', request_id: `rq-hx-${++seq}`, ...args });
}

/** ok인 결과의 데이터 */
export function okData(r: ToolCallResult): HostExecResult {
  if (!r.ok) throw new Error(`host_exec 거부: ${r.code} ${r.message}`);
  return r.data as HostExecResult;
}

/** 서버 명령 가짜 프로세스 — 출력 줄을 내고 code로 끝나거나(exitAfterMs), 끝날 때까지 산다(null) */
export function scriptedHost(e: OrchEnv, o: { lines?: string[]; code?: number; exitAfterMs?: number | null; remaining?: number; onStart?: (p: FakeProc) => void } = {}): FakeProc[] {
  const made: FakeProc[] = [];
  e.hostExec = (spec) => {
    const p = new FakeProc('host', '', spec.label);
    made.push(p);
    e.hostProcs.push(p);
    o.onStart?.(p);
    setTimeout(() => {
      for (const l of o.lines ?? []) p.line(l);
      if (o.exitAfterMs !== null) setTimeout(() => p.exit(o.code ?? 0, { remaining: o.remaining ?? 0 }), o.exitAfterMs ?? 0);
    }, 5);
    return p;
  };
  return made;
}

/** 실행 기록 (host_exec) */
export function hostRecords(e: OrchEnv) {
  return e.ctx.store.execs.list({ ref2: 'host_exec' });
}
