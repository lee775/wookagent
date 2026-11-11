/**
 * externalMainStatus (리드 결정 S7-17 F2·F5): 외부 에이전트가 메인 자리를 가진 동안 M-MAIN을 마지막 CLI로 보이지 않는다.
 * - F2: 대표가 보는 M-MAIN 상태(memberView — 스냅숏·팀원 상세가 같은 함수)는 마지막 CLI(Claude)의 재로그인 필요·사용량 한도를 싣지 않는다. 서버가 띄우는 Claude
 *   보유자면 같은 표시가 그대로 보인다. 메인 모의 실행은 켜 둔 채이고(리드 결정 S6-19), 운영 모드의 보기(모의 실행 끔)는 한 번의 동기 호출 동안만 설정을 바꿔 본다 —
 *   그 사이에 스케줄러 차례나 턴이 끼지 않으므로 실제 CLI는 뜨지 않는다
 * - F5: get_work_context의 you는 실행하는 쪽(runner)을 말한다 — 외부 보유자의 턴이면 'external', CLI 종류(aiKind)는 null. CLI 보유자면 그 AI 종류.
 *   get_overview에는 팀원별 AI 종류가 없고 자리 칸이 외부 보유자를 말한다
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID } from '@shared/domain';
import type { MemberView } from '@shared/views';
import type { TokenIdentity } from '../../src/main/mcp/types';
import type { WorkContext } from '../../src/main/mcp/catalog';
import { agentCall, bootExternal, claimAs, nextWork, situation, until, type ExternalEnv } from './externalRig';

let x: ExternalEnv;

beforeAll(async () => {
  x = await bootExternal({});
}, 120_000);

afterAll(async () => {
  await x?.close();
});

/** 운영 모드의 M-MAIN 보기 — 메인 모의 실행을 끈 설정으로 한 번의 동기 호출만 (같은 틱에 되돌린다) */
function prodMainView(): MemberView {
  const ctx = x.h.core.ctx as unknown as { settings: () => Record<string, unknown> & { developer: Record<string, unknown> } };
  const own = Object.prototype.hasOwnProperty.call(ctx, 'settings');
  const before = ctx.settings;
  const orig = ctx.settings.bind(ctx);
  ctx.settings = () => {
    const s = orig();
    return { ...s, developer: { ...s.developer, mainAgentMock: false } };
  };
  try {
    return x.h.core.views.memberView(x.h.core.ctx.store.members.require(MAIN_AGENT_ID));
  } finally {
    if (own) ctx.settings = before;
    else delete (ctx as { settings?: unknown }).settings;
  }
}

/** 메인 대화 세션의 신원 (토큰 없이 처리기를 부른다 — 외부 에이전트가 아니다) */
const mainIdentity = (): TokenIdentity => ({ turnId: 'TN-x', sessionId: 'S-x', sessionKey: 'main:general', sessionKind: 'main_general', memberId: MAIN_AGENT_ID, projectId: null, isMain: true, isProducer: false, canReview: false });

async function workContextAs(identity: TokenIdentity): Promise<WorkContext> {
  const r = await x.h.core.tools.handle(identity, 'get_work_context', {});
  if (!r.ok) throw new Error(`get_work_context 거부: ${r.code}`);
  return r.data as WorkContext;
}

function setClaude(p: { authRequired?: boolean; usageLimitedUntil?: string | null }): void {
  const ctx = x.h.core.ctx;
  ctx.saveAi({ ...ctx.ai('claude'), ...(p.authRequired !== undefined ? { authRequired: p.authRequired, authRequiredSince: p.authRequired ? ctx.now() : null } : {}), ...('usageLimitedUntil' in p ? { usageLimitedUntil: p.usageLimitedUntil } : {}) });
}

const AUTH = 'claude 인증 만료 — 재로그인 필요';
const hasLimit = (v: MemberView) => v.statusReasons.some((r) => r.startsWith('사용량 한도'));

describe('외부 보유자는 마지막 CLI로 보이지 않는다 (리드 결정 S7-17 F2·F5)', () => {
  it('서버가 띄우는 Claude 보유자: M-MAIN 상태에 Claude의 재로그인·사용량 한도가 보이고, get_work_context는 runner·aiKind claude', async () => {
    const ctx = x.h.core.ctx;
    expect(ctx.store.seat.get('main')!.holder).toMatchObject({ kind: 'launched', ai: { kind: 'claude' } });
    expect(ctx.store.members.require(MAIN_AGENT_ID).ai.kind).toBe('claude');
    setClaude({ authRequired: true });
    const auth = prodMainView();
    expect([auth.status, auth.statusReasons[0]]).toEqual(['error', AUTH]);
    setClaude({ authRequired: false, usageLimitedUntil: new Date(ctx.clock.ms() + 3_600_000).toISOString() });
    expect(hasLimit(prodMainView())).toBe(true);
    setClaude({ usageLimitedUntil: null });
    expect(ctx.settings().developer.mainAgentMock).toBe(true);

    const you = (await workContextAs(mainIdentity())).you;
    expect([you.runner, you.aiKind]).toEqual(['claude', 'claude']);
  });

  it('외부 보유자가 앉은 동안: 같은 표시가 M-MAIN 상태에 없고(error 아님), get_work_context는 runner external·aiKind null, get_overview에는 AI 종류가 없다', async () => {
    const ctx = x.h.core.ctx;
    const { key } = x.operator.addExternalAgent('그록봇');
    await x.operator.assignSeat('external:X-0001', true);
    const lease = await claimAs(x.api, key);
    // M-MAIN의 AI 칸은 마지막 CLI 그대로다 — 그것을 상태로 보이지 않는다
    expect(ctx.store.members.require(MAIN_AGENT_ID).ai.kind).toBe('claude');

    setClaude({ authRequired: true });
    const auth = prodMainView();
    expect(auth.status).not.toBe('error');
    expect(auth.statusReasons).not.toContain(AUTH);
    setClaude({ authRequired: false, usageLimitedUntil: new Date(ctx.clock.ms() + 3_600_000).toISOString() });
    const limit = prodMainView();
    expect(hasLimit(limit)).toBe(false);
    expect(limit.statusReasons.some((r) => r.includes('claude'))).toBe(false);
    setClaude({ usageLimitedUntil: null });
    expect(ctx.settings().developer.mainAgentMock).toBe(true);

    // 메인 신원(자리로 판단) — external, CLI 종류 없음
    const seatYou = (await workContextAs(mainIdentity())).you;
    expect([seatYou.runner, seatYou.aiKind]).toEqual(['external', null]);

    // 외부 보유자의 실제 턴이 REST로 부른다 (토큰 신원 — 그 에이전트에 묶임)
    await x.owner$('command.send', { target: 'main', text: '지금 상황을 알려 줘' });
    const w = await nextWork(x.api, key, lease.leaseId);
    const call = (name: string) => agentCall(x.api, key, `/tool/${name}`, { body: {}, headers: { 'X-Wook-Turn-Token': w.mcp.token } });
    const wc = await call('get_work_context');
    expect(wc.status).toBe(200);
    const you = wc.json<{ ok: boolean; data: WorkContext }>().data.you;
    expect([you.memberId, you.isMain, you.runner, you.aiKind]).toEqual([MAIN_AGENT_ID, true, 'external', null]);
    const ov = await call('get_overview');
    expect(ov.status).toBe(200);
    const overview = ov.json<{ ok: boolean; data: { seat: { holder: { kind: string; agentId?: string } } } }>().data;
    expect(overview.seat.holder).toMatchObject({ kind: 'external', agentId: 'X-0001' });
    expect(ov.body.toString('utf8')).not.toContain('"aiKind"');

    const done = await agentCall(x.api, key, `/work/${w.turnId}/finish`, { body: { leaseId: lease.leaseId, finalText: '지금은 한가합니다', outcome: 'completed' } });
    expect(done.status).toBe(200);
    await until(() => x.h.core.turns.count() === 0, '턴 정리', 30_000, () => situation(x));
  }, 90_000);
});
