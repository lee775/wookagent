/**
 * 데스크톱 운영 설정의 메인 AI를 교체 중에 바꾸기 (리드 결정 S4-16, S4-2·S4-9):
 * - settings.update는 보낸 general.mainAgent를 저장된 값(prev.general.mainAgent)과 견주고, 정말 바뀌었을 때만 SeatService.assign을 부른다
 * - 교체 중(switching)에 정말 바꾸면 — 나가는 보유자로 되돌리는 것도 — '넘기는 중'으로 거부되고 그 요청의 어떤 칸도 저장되지 않는다
 * - 저장된 값을 그대로 다시 보내는 설치 설정 저장(기록 보관 등 다른 칸)은 교체 중에도 지나간다
 * - 운영 설정의 메인 AI는 앉지 않을 AI를 말하지 않는다 — 교체가 끝나면 설정·자리·M-MAIN이 같다
 * 탐침 P1(server-s4-seat-authority)과 zz-s4fl-desktop-revert-during-swap 두 시험(server-s4-flows-lifecycle)에서 왔다
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID, type AiConfig } from '@shared/domain';
import { bootOrch, waitFor, type OrchEnv } from './orchHarness';

let env: OrchEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const KEY = 'main:general';
const SWITCHING = '메인 자리를 Codex CLI에게 넘기는 중입니다(세대 1 → 2) — 교체가 끝난 뒤에 다시 하세요';

async function refusal(p: Promise<unknown>): Promise<{ code?: string; message: string } | null> {
  try {
    await p;
    return null;
  } catch (err) {
    return { code: (err as { code?: string }).code, message: (err as Error).message };
  }
}

/** 교체가 끝난 뒤 운영 설정·자리·M-MAIN이 같은 AI를 말하는지 */
function seated(e: OrchEnv) {
  return { holder: e.core.seat.view().holder?.label, settings: e.ctx.settings().general.mainAgent.kind, mainAi: e.ctx.store.members.require(MAIN_AGENT_ID).ai.kind };
}

describe('교체 중의 데스크톱 메인 AI 바꾸기 (seatDesktopSwitching)', () => {
  it('실행 중인 메인 턴을 기다리는 교체에 나가는 보유자로 되돌리면 넘기는 중으로 거부되고 아무것도 저장하지 않는다 (탐침 P1)', async () => {
    const e = (env = await bootOrch());
    e.core.seat.applyOperatorConfig({ holders: null, drainMs: 60_000, initialHolder: null }, '시험');
    const original = { ...e.ctx.settings().general.mainAgent };
    const codex: AiConfig = { ...original, kind: 'codex', model: null, effortOverride: null };
    e.hold.add(KEY);
    await e.invoke('command.send', { target: 'main', text: '상태 알려줘' });
    e.tick();
    await waitFor(() => !!e.liveProc(KEY, MAIN_AGENT_ID), '메인 턴 시작');
    await e.invoke('settings.update', { general: { mainAgent: codex } });
    expect(e.core.seat.view()).toMatchObject({ state: 'switching', holder: { label: 'Claude CLI' }, pendingHolder: { label: 'Codex CLI' } });
    expect(e.ctx.settings().general.mainAgent).toEqual(codex);
    // 운영자가 마음을 바꿔 원래 값(나가는 보유자 Claude)으로 되돌린다 — 다른 칸도 함께
    const retention = e.ctx.settings().logs.retentionDays;
    expect(await refusal(e.invoke('settings.update', { general: { mainAgent: original }, logs: { retentionDays: retention + 1 } }))).toEqual({ code: 'conflict', message: SWITCHING });
    expect(e.ctx.settings().general.mainAgent).toEqual(codex);
    expect(e.ctx.settings().logs.retentionDays).toBe(retention);
    // 나가는 턴이 끝나면 교체가 이어진다 — 끝난 뒤 셋 모두 Codex
    e.hold.delete(KEY);
    e.liveProc(KEY, MAIN_AGENT_ID)!.finishOk();
    await waitFor(() => e.core.seat.view().state === 'active', '교체 끝');
    await e.core.seat.settled();
    expect(seated(e)).toEqual({ holder: 'Codex CLI', settings: 'codex', mainAi: 'codex' });
  });

  it('인계 메모 턴 동안 되돌려도 같다 — 받았다고 답하고 뒤에서 덮어쓰지 않는다 (zz-s4fl-desktop-revert-during-swap 1)', async () => {
    const e = (env = await bootOrch());
    await e.invoke('command.send', { target: 'main', text: '지금 상황은?' });
    await e.drain(1);
    const claude = e.ctx.settings().general.mainAgent;
    const codex: AiConfig = { ...claude, kind: 'codex', model: null, effortOverride: null };
    e.hold.add(KEY); // 나가는 보유자의 메모 턴이 잠깐 살아 있게
    await e.invoke('settings.update', { general: { mainAgent: codex } });
    await waitFor(() => !!e.liveProc(KEY, MAIN_AGENT_ID), '메모 턴');
    expect(e.core.seat.view()).toMatchObject({ state: 'switching', holder: { label: 'Claude CLI' }, pendingHolder: { label: 'Codex CLI' } });
    expect(await refusal(e.invoke('settings.update', { general: { mainAgent: claude } }))).toEqual({ code: 'conflict', message: SWITCHING });
    // 같은 종류로 다른 설정(세 번째 값)도 정말 바뀐 것이라 거부한다
    expect(await refusal(e.invoke('settings.update', { general: { mainAgent: { ...codex, effortTier: 'low' } } }))).toEqual({ code: 'conflict', message: SWITCHING });
    expect(e.ctx.settings().general.mainAgent).toEqual(codex);
    e.hold.clear();
    e.liveProc(KEY, MAIN_AGENT_ID)?.finishOk();
    await waitFor(() => e.core.seat.view().state === 'active', '교체 끝');
    await e.core.seat.settled();
    expect(seated(e)).toEqual({ holder: 'Codex CLI', settings: 'codex', mainAi: 'codex' });
  });

  it('교체 중에도 저장된 메인 AI를 그대로 다시 보내는 설치 설정 저장은 지나간다 (zz-s4fl-desktop-revert-during-swap 2)', async () => {
    const e = (env = await bootOrch());
    await e.invoke('command.send', { target: 'main', text: '지금 상황은?' });
    await e.drain(1);
    const claude = e.ctx.settings().general.mainAgent;
    const codex: AiConfig = { ...claude, kind: 'codex', model: null, effortOverride: null };
    e.hold.add(KEY);
    await e.invoke('settings.update', { general: { mainAgent: codex } });
    await waitFor(() => !!e.liveProc(KEY, MAIN_AGENT_ID), '메모 턴');
    // 설치 설정 화면은 늘 general.mainAgent를 함께 보낸다 — 저장된 값(이제 Codex)과 운영자가 바꾼 칸
    const s = e.ctx.settings();
    const retention = s.logs.retentionDays === 30 ? 31 : 30;
    const saved = await e.invoke('settings.update', { general: { mainAgent: s.general.mainAgent }, logs: { retentionDays: retention } });
    expect(saved.logs.retentionDays).toBe(retention);
    expect(e.ctx.settings().logs.retentionDays).toBe(retention);
    expect(e.core.seat.view()).toMatchObject({ state: 'switching', generation: 2 });
    e.hold.clear();
    e.liveProc(KEY, MAIN_AGENT_ID)?.finishOk();
    await waitFor(() => e.core.seat.view().state === 'active', '교체 끝');
    await e.core.seat.settled();
    expect(seated(e)).toEqual({ holder: 'Codex CLI', settings: 'codex', mainAi: 'codex' });
    expect(e.ctx.settings().logs.retentionDays).toBe(retention);
  });
});
