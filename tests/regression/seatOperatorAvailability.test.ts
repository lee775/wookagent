/**
 * 운영자 배정과 AI를 쓸 수 있는지 (리드 결정 S4-15, SERVER_DESIGN 4.3):
 * - 같은 종류에서 모델·노력치만 바꾸면 자리를 넘기는 것이 아니다 — 쓸 수 있는지 보지 않는다. 그 CLI가 재로그인 필요·CLI-15 문제·설치 안 됨이어도 저장되고
 *   세대 그대로 다음 턴부터 적용된다 (4단계 전 데스크톱과 같다)
 * - 운영자가 지금 쓸 수 없는 종류로 바꾸면 거부한다(데스크톱의 바뀐 동작 — KNOWN_ISSUES). 거부 글은 운영자가 한 일을 말하고, 그 독자에게 있는 출구만 적는다:
 *   데스크톱 '메인 AI를 Codex CLI로 바꿀 수 없습니다 — …', 서버 'Codex CLI에게 메인 자리를 배정할 수 없습니다 — …'. 메인의 hand_off_seat는 '넘길 수 없습니다'
 * - 한 요청이 메인 모의 실행도 끄면 쓸 수 있는지는 끈 뒤의 값으로 본다 (리드 결정 S4-28). 모의 실행 값을 넘기지 않는 쪽(메인의 넘기기·seat assign)은 저장된 값이다
 * 탐침 P3(server-s4-seat-authority)와 zz-s4fl-desktop-availability(server-s4-flows-lifecycle), zz-sa2-new S4(server-s4fix1-seat-authority),
 * fix2Gaps G9(server-s4fix2-tests-integrity)에서 왔다
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID, type AiConfig } from '@shared/domain';
import type { TokenIdentity } from '../../src/main/mcp/types';
import { bootOrch, type OrchEnv } from './orchHarness';
import { mainOpsIdentity } from './mainOps';

let env: OrchEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const CODEX: AiConfig = { kind: 'codex', model: null, effortTier: 'high', effortOverride: null };
const main: TokenIdentity = { ...mainOpsIdentity(), seatGeneration: 1 };
const DESKTOP_EXIT = (fix: string) => `이 PC에서 ${fix} 뒤 설치 설정의 'CLI 준비 상태'에서 '다시 확인'을 누르고 다시 바꾸세요`;
const SERVER_EXIT = (fix: string) =>
  `서버 PC에서 ${fix} 뒤 CLI 상태를 다시 확인하면 배정할 수 있습니다. 서버를 다시 시작하면 시작할 때 확인하고, 대표 화면 설치 설정의 'CLI 준비 상태'에서 '다시 확인'을 눌러도 됩니다`;

async function refusal(p: Promise<unknown>): Promise<{ code?: string; message: string } | null> {
  try {
    await p;
    return null;
  } catch (err) {
    return { code: (err as { code?: string }).code, message: (err as Error).message };
  }
}

describe('운영자 배정과 AI를 쓸 수 있는지 (seatOperatorAvailability)', () => {
  it('데스크톱: 같은 종류의 노력치·모델만 바꾸면 지금 CLI가 재로그인 필요·CLI 문제·설치 안 됨이어도 저장된다 — 세대 그대로 (탐침 P3)', async () => {
    const e = (env = await bootOrch({ mock: false }));
    const claude = e.ctx.ai('claude');
    const cur = { ...e.ctx.settings().general.mainAgent };
    expect(cur.kind).toBe('claude');
    // 재로그인 필요인 채로 노력치만
    e.ctx.saveAi({ ...claude, authRequired: true, authRequiredSince: e.ctx.now() });
    const low = await e.invoke('settings.update', { general: { mainAgent: { ...cur, effortOverride: 'low' } } });
    expect(low.general.mainAgent.effortOverride).toBe('low');
    expect(e.core.seat.view()).toMatchObject({ generation: 1, state: 'active', holder: { label: 'Claude CLI', ai: { effortOverride: 'low' } } });
    expect(e.ctx.store.members.require(MAIN_AGENT_ID).ai.effortOverride).toBe('low');
    // 모델만 (zz-s4fl-desktop-availability)
    const opus = await e.invoke('settings.update', { general: { mainAgent: { ...cur, effortOverride: 'low', model: 'opus' } } });
    expect({ saved: opus.general.mainAgent.model, seat: e.core.seat.launchedAi()?.model }).toEqual({ saved: 'opus', seat: 'opus' });
    // CLI-15 문제·설치 안 됨이어도 같은 종류 변경은 막지 않는다
    e.ctx.saveAi({ ...claude, cliProblem: 'claude 0.1.0은 검증된 버전 범위 밖입니다' });
    expect((await e.invoke('settings.update', { general: { mainAgent: { ...cur, model: 'sonnet' } } })).general.mainAgent.model).toBe('sonnet');
    e.ctx.saveAi({ ...claude, cliInstalled: false, cliProblem: '설치되지 않음' });
    expect((await e.invoke('settings.update', { general: { mainAgent: { ...cur, model: null } } })).general.mainAgent.model).toBeNull();
    expect(e.core.seat.view()).toMatchObject({ generation: 1, state: 'active' });
    expect(e.core.seat.history()).toHaveLength(1);
  });

  it('데스크톱: 쓸 수 없는 종류로 바꾸면 운영자의 일로 거부하고 그 출구를 적는다 — 아무것도 저장하지 않는다. 출구대로 하면 바뀐다', async () => {
    const e = (env = await bootOrch({ mock: false }));
    const codex = e.ctx.ai('codex');
    const before = { ...e.ctx.settings().general.mainAgent };
    const retention = e.ctx.settings().logs.retentionDays;
    const change = () => e.invoke('settings.update', { general: { mainAgent: CODEX }, logs: { retentionDays: retention + 1 } });

    e.ctx.saveAi({ ...codex, authRequired: true, authRequiredSince: e.ctx.now() });
    expect(await refusal(change())).toEqual({
      code: 'conflict',
      message: `메인 AI를 Codex CLI로 바꿀 수 없습니다 — Codex CLI에 로그인돼 있지 않습니다 (재로그인 필요). ${DESKTOP_EXIT('Codex CLI에 로그인한')}`,
    });
    e.ctx.saveAi({ ...codex, cliInstalled: false, cliProblem: '설치되지 않음' });
    expect((await refusal(change()))?.message).toBe(`메인 AI를 Codex CLI로 바꿀 수 없습니다 — Codex CLI가 이 PC에 설치되지 않았습니다. ${DESKTOP_EXIT('Codex CLI를 설치한')}`);
    e.ctx.saveAi({ ...codex, cliProblem: 'codex 0.1.0은 검증된 버전 범위 밖입니다' });
    expect((await refusal(change()))?.message).toBe(
      `메인 AI를 Codex CLI로 바꿀 수 없습니다 — Codex CLI를 지금 쓸 수 없습니다 (codex 0.1.0은 검증된 버전 범위 밖입니다). ${DESKTOP_EXIT('Codex CLI의 문제를 고친')}`,
    );
    // 아무것도 바뀌지 않았다
    expect(e.ctx.settings().general.mainAgent).toEqual(before);
    expect(e.ctx.settings().logs.retentionDays).toBe(retention);
    expect(e.core.seat.view()).toMatchObject({ generation: 1, state: 'active', holder: { label: 'Claude CLI' } });

    // 글이 말한 출구: 로그인한 뒤 설치 설정의 '다시 확인'(system.recheckAi) → 다시 바꾸면 넘어간다
    e.ctx.saveAi({ ...codex, authRequired: true, authRequiredSince: e.ctx.now() });
    await e.invoke('system.recheckAi', 'codex');
    expect(e.ctx.ai('codex').authRequired).toBe(false);
    await change();
    await e.core.seat.settled();
    expect(e.core.seat.view()).toMatchObject({ generation: 2, state: 'active', holder: { label: 'Codex CLI' } });

    // 메인의 넘기기는 그대로 '넘길 수 없습니다'
    e.ctx.saveAi({ ...e.ctx.ai('claude'), authRequired: true, authRequiredSince: e.ctx.now() });
    expect(await e.core.tools.handle({ ...main, seatGeneration: 2 }, 'hand_off_seat', { to: 'claude', reason: '대표 명령' })).toEqual({
      ok: false,
      code: 'conflict',
      message: 'Claude CLI에게 메인 자리를 넘길 수 없습니다 — Claude CLI에 로그인돼 있지 않습니다 (재로그인 필요)',
    });
  });

  it('데스크톱: 메인 모의 실행 끄기와 종류 바꾸기를 한 요청에 보내면 끈 뒤의 값으로 본다 — 모의 실행이 남으면 보지 않고, 끄면 쓸 수 없는 종류는 거부한다 (리드 결정 S4-28)', async () => {
    const e = (env = await bootOrch()); // 메인 모의 실행 켜짐 — 운영자는 끄기만 할 수 있다
    expect(e.ctx.settings().developer.mainAgentMock).toBe(true);
    e.ctx.saveAi({ ...e.ctx.ai('codex'), authRequired: true, authRequiredSince: e.ctx.now() });
    const retention = e.ctx.settings().logs.retentionDays;
    // 같은 요청이 모의 실행을 끈다 — 그 뒤로는 Codex CLI가 실제로 떠야 하는데 지금 쓸 수 없다. 아무것도 저장하지 않는다(모의 실행도 켜진 채)
    expect(await refusal(e.invoke('settings.update', { general: { mainAgent: CODEX }, developer: { mainAgentMock: false }, logs: { retentionDays: retention + 1 } }))).toEqual({
      code: 'conflict',
      message: `메인 AI를 Codex CLI로 바꿀 수 없습니다 — Codex CLI에 로그인돼 있지 않습니다 (재로그인 필요). ${DESKTOP_EXIT('Codex CLI에 로그인한')}`,
    });
    expect(e.ctx.settings().developer.mainAgentMock).toBe(true);
    expect(e.ctx.settings().logs.retentionDays).toBe(retention);
    expect(e.core.seat.view()).toMatchObject({ generation: 1, state: 'active', holder: { label: 'Claude CLI' } });
    // 모의 실행이 켜진 채로 남으면 CLI를 쓰지 않으므로 보지 않는다 — 바뀐다
    await e.invoke('settings.update', { general: { mainAgent: CODEX } });
    await e.core.seat.settled();
    expect(e.core.seat.view()).toMatchObject({ generation: 2, state: 'active', holder: { label: 'Codex CLI' } });
    // 함께 보내는 것 자체를 거부하지는 않는다 — 끈 뒤에도 쓸 수 있는 종류면 둘 다 저장된다
    await e.invoke('settings.update', { general: { mainAgent: { ...CODEX, kind: 'claude' } }, developer: { mainAgentMock: false } });
    await e.core.seat.settled();
    expect(e.core.seat.view()).toMatchObject({ generation: 3, state: 'active', holder: { label: 'Claude CLI' } });
    expect(e.ctx.settings().developer.mainAgentMock).toBe(false);
  });

  it('서버: 운영자 seat assign이 쓸 수 없는 종류면 서버 운영자의 글로 거부하고 서버 PC의 출구를 적는다 — 메인의 넘기기는 넘기기 글', async () => {
    const e = (env = await bootOrch({ mock: false, mode: 'server' }));
    const codex = e.ctx.ai('codex');
    const operatorRefusal = async (force: boolean) => (await refusal((async () => e.core.seat.operatorAssign('launched:codex', force))()))?.message ?? null;
    e.ctx.saveAi({ ...codex, authRequired: true, authRequiredSince: e.ctx.now() });
    const auth = await operatorRefusal(false);
    expect(auth).toBe(`Codex CLI에게 메인 자리를 배정할 수 없습니다 — Codex CLI에 로그인돼 있지 않습니다 (재로그인 필요). ${SERVER_EXIT('Codex CLI에 로그인한')}`);
    e.ctx.saveAi({ ...codex, cliInstalled: false, cliProblem: '설치되지 않음' });
    const install = await operatorRefusal(true);
    expect(install).toBe(`Codex CLI에게 메인 자리를 배정할 수 없습니다 — Codex CLI가 서버 PC에 설치되지 않았습니다. ${SERVER_EXIT('Codex CLI를 설치한')}`);
    const handOff = await e.core.tools.handle(main, 'hand_off_seat', { to: 'codex', reason: '대표 명령' });
    expect(handOff).toEqual({ ok: false, code: 'conflict', message: 'Codex CLI에게 메인 자리를 넘길 수 없습니다 — Codex CLI가 서버 PC에 설치되지 않았습니다' });
    // 어느 글도 서버의 운영자·메인에게 없는 데스크톱의 길(운영 설정·이 PC)을 말하지 않는다
    for (const text of [auth, install, (handOff as { message: string }).message]) expect(text).not.toMatch(/운영 설정|이 PC/);
    expect(e.core.seat.view()).toMatchObject({ generation: 1, state: 'active', holder: { label: 'Claude CLI' } });
    // 같은 종류의 모델·노력치만 바꾸는 메인의 넘기기는 지금 CLI가 재로그인 필요여도 받는다 (세대 그대로)
    e.ctx.saveAi({ ...e.ctx.ai('claude'), authRequired: true, authRequiredSince: e.ctx.now() });
    expect(await e.core.tools.handle(main, 'hand_off_seat', { to: 'claude', effort_tier: 'low', reason: '대표 명령: 노력치 낮춰' })).toMatchObject({ ok: true, data: { generation: 1 } });
    expect(e.core.seat.view()).toMatchObject({ generation: 1, holder: { ai: { kind: 'claude', effortTier: 'low' } } });
  });

  it('메인 모의 실행이 켜져 있으면 모의 실행 값을 함께 넘기지 않는 쪽(메인의 hand_off_seat·서버 seat assign)도 저장된 값으로 본다 — 로그인돼 있지 않은 CLI에게도 넘긴다 (리드 결정 S4-28·S4-35 5번, 탐침 G9)', async () => {
    // 데스크톱: 메인이 넘긴다
    const e = (env = await bootOrch());
    expect(e.ctx.settings().developer.mainAgentMock).toBe(true);
    e.ctx.saveAi({ ...e.ctx.ai('codex'), authRequired: true, authRequiredSince: e.ctx.now() });
    expect(await e.core.tools.handle(main, 'hand_off_seat', { to: 'codex', reason: '대표 명령' })).toMatchObject({ ok: true, data: { sameGeneration: false } });
    await e.core.seat.settled();
    expect(e.core.seat.view()).toMatchObject({ generation: 2, state: 'active', holder: { label: 'Codex CLI' } });
    await e.close();
    // 서버: 운영자가 배정한다
    const s = (env = await bootOrch({ mode: 'server' }));
    expect(s.ctx.settings().developer.mainAgentMock).toBe(true);
    s.ctx.saveAi({ ...s.ctx.ai('codex'), cliInstalled: false, cliProblem: '설치되지 않음' });
    await s.core.seat.operatorAssign('launched:codex', false).done;
    expect(s.core.seat.view()).toMatchObject({ generation: 2, state: 'active', holder: { label: 'Codex CLI' } });
  });
});
