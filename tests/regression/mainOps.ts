/**
 * 시험용 진입점 (SERVER_DESIGN 2.5·2.6, 10.11 '부르는 길만 바뀜'):
 * - mainOp: 메인 에이전트의 운영 도구(앱 도구 처리기)를 부른다 — 대표 메서드로 하던 팀·작업 조작을 대신한다. 결과 데이터를 돌려주고, 거부되면
 *   대표 메서드처럼 code·message를 가진 오류로 던진다. reason을 주지 않으면 시험용 사유를 넣는다
 * - internalInvoker: 운영자 내부 API(createInternalApi)를 대표 invoke와 같은 모양으로 부른다 — 시험 준비(프로젝트·팀원·모의 설정)용
 * - seedStoredSettings: 저장된 설정을 검사 없이 바로 쓴다 — 제품 범위 밖의 실행 값(감시를 빠르게 돌리는 값)을 넣을 때만 (리드 결정 15)
 */
import { MAIN_AGENT_ID, type Settings } from '@shared/domain';
import type { DeepPartial, WookMethod, WookParams, WookResult } from '@shared/ipc';
import type { TokenIdentity } from '../../src/main/mcp/types';
import type { Core } from '../../src/main/orchestrator/core';
import { createInternalApi } from '../../src/main/orchestrator/api';
import { normalizeSettings } from '../../src/main/orchestrator/defaults';

/** 메인 에이전트 운영 턴의 신원 (턴 기록 없음 — 처리기는 토큰으로 확인한 신원만 본다) */
export function mainOpsIdentity(sessionKey = 'main:general', turnId = 'TN-main-ops'): TokenIdentity {
  return {
    turnId,
    sessionId: 'S-main-ops',
    sessionKey,
    sessionKind: sessionKey === 'main:general' ? 'main_general' : 'main_project',
    memberId: MAIN_AGENT_ID,
    projectId: null,
    isMain: true,
    isProducer: false,
    canReview: false,
  };
}

export type ToolError = Error & { code: string };

export async function mainOp(core: Core, tool: string, args: Record<string, unknown> = {}, o: { sessionKey?: string } = {}): Promise<Record<string, unknown>> {
  const r = await core.tools.handle(mainOpsIdentity(o.sessionKey), tool, { reason: `시험: ${tool}`, ...args });
  if (r.ok) return (r.data ?? {}) as Record<string, unknown>;
  const e = new Error(r.message) as ToolError;
  e.code = r.code;
  throw e;
}

export type Invoker = <M extends WookMethod>(method: M, ...args: WookParams<M>) => Promise<WookResult<M>>;

export function internalInvoker(core: Core): Invoker {
  const api = createInternalApi(core);
  return (async <M extends WookMethod>(method: M, ...args: WookParams<M>) => {
    const fn = api[method] as unknown as (...a: unknown[]) => unknown;
    return (await fn(...(args as unknown[]))) as WookResult<M>;
  }) as Invoker;
}

/**
 * 시험 전용: 저장된 운영 설정에 부분 설정을 바로 합쳐 쓴다 — settings.update의 검사(실행 설정 범위, 리드 결정 15)를 거치지 않는다.
 * 감시를 빠르게 돌리려고 제품 범위 밖의 값(응답 없음 0.003분, 턴 시간 상한 0.1분 등)을 넣을 때만 쓴다. 제품의 범위는 시험 때문에 낮추지 않는다.
 * 재시작하면 시작 때 확인이 범위 밖 값을 기본값으로 되돌린다
 */
export function seedStoredSettings(core: Core, patch: DeepPartial<Settings>): void {
  const merge = (base: unknown, over: unknown): unknown => {
    if (over === undefined) return base;
    if (typeof base !== 'object' || base === null || Array.isArray(base) || typeof over !== 'object' || over === null || Array.isArray(over)) return over;
    const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    for (const [k, v] of Object.entries(over)) out[k] = merge(out[k], v);
    return out;
  };
  core.ctx.saveSettings(normalizeSettings(merge(core.ctx.settings(), patch) as Settings));
}
