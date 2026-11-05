/**
 * 데스크톱의 메인 AI 설정 (리드 결정 S4-9, SERVER_DESIGN 4.3) — 데스크톱 운영자 설정(DESKTOP_OPERATOR_SETTINGS)의 general.mainAgent를 바꾸는 것은 그 PC 운영자의
 * 자리 배정이다. SeatService.assign을 거쳐(바꾼 쪽 operator):
 * - AI 종류가 바뀌면 새 세대 (교체 — 인계 메모 턴을 거쳐 넘어간다)
 * - 모델·노력치만 바뀌면 같은 세대 — 실행 중인 턴은 띄울 때의 값 그대로, 같은 세션의 다음 턴부터 새 값. 대표 알림은 없다
 * - 자리가 받지 않으면(보유자 목록 밖 등) 설정을 저장하지 않는다
 * - 대표의 길은 아니다: 메인의 update_settings는 메인 AI를 거부한다(원격 길의 거부는 tests/server/seatNoOwnerPath)
 * 그리고 로그아웃한 데스크톱 화면에서는 자리 보기 넷이 예전의 unauthorized로 거부되고 스냅숏의 자리는 LOCKED_SEAT다 (S4-11)
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID, OPERATOR, OWNER, type AiConfig } from '@shared/domain';
import { LOCKED_SEAT } from '@shared/views';
import { bootOrch, notices, waitFor, type OrchEnv } from './orchHarness';

let env: OrchEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const KEY = 'main:general';
const seatActivity = (e: OrchEnv) => e.ctx.store.activity.search({ kinds: ['seat'], limit: 50 });
const fingerprint = (e: OrchEnv) =>
  JSON.stringify({ seat: e.ctx.store.seat.get('main'), history: e.ctx.store.seatHistory.list(), mainAi: e.ctx.store.members.require(MAIN_AGENT_ID).ai, mainAgent: e.ctx.settings().general.mainAgent });

describe('데스크톱의 메인 AI 설정은 운영자 배정이다 (S4-9)', () => {
  it('AI 종류를 바꾸면 새 세대 — 바꾼 쪽은 운영자이고 대표가 아니다', async () => {
    const e = (env = await bootOrch());
    const codex: AiConfig = { ...e.ctx.settings().general.mainAgent, kind: 'codex', model: null, effortOverride: null };
    const saved = await e.invoke('settings.update', { general: { mainAgent: codex } });
    expect(saved.general.mainAgent).toEqual(codex);
    await e.core.seat.settled();
    expect(e.core.seat.view()).toMatchObject({ generation: 2, state: 'active', holder: { label: 'Codex CLI', ai: codex } });
    expect(e.ctx.store.members.require(MAIN_AGENT_ID).ai).toEqual(codex);
    expect(e.core.seat.history().map((h) => [h.generation, h.changedBy])).toEqual([
      [2, 'operator'],
      [1, 'server'],
    ]);
    const start = seatActivity(e).find((x) => x.text.startsWith('메인 자리 교체 시작'))!;
    expect([start.actor, start.text]).toEqual([OPERATOR, '메인 자리 교체 시작: Claude CLI → Codex CLI (세대 1 → 2, 운영자가 바꿈) — 운영 설정의 메인 AI 변경 (데스크톱 운영자)']);
    expect(e.ctx.store.seatHistory.list().some((h) => (h.changedBy as string) === OWNER)).toBe(false);
    expect(notices(e, '메인 에이전트가 바뀌었습니다')).toHaveLength(1);
  });

  it('모델·노력치만 바꾸면 같은 세대 — 실행 중인 턴은 그대로, 같은 세션의 다음 턴부터 새 값이고 대표 알림은 없다', async () => {
    const e = (env = await bootOrch());
    const old = e.ctx.settings().general.mainAgent;
    e.hold.add(KEY);
    await e.invoke('command.send', { target: 'main', text: '첫 명령' });
    e.tick();
    await waitFor(() => !!e.liveProc(KEY, MAIN_AGENT_ID), '메인 턴 시작');
    const running = e.liveProc(KEY, MAIN_AGENT_ID)!;
    const next: AiConfig = { ...old, model: 'opus', effortTier: 'low', effortOverride: null };
    expect(old.effortTier).toBe('high');
    await e.invoke('settings.update', { general: { mainAgent: next } });
    // 세대·이력 줄 수 그대로, 보유자의 AI만 바뀐다 — 운영자가 바꾼 것으로
    expect(e.core.seat.view()).toMatchObject({ generation: 1, state: 'active', holder: { ai: next } });
    expect(e.core.seat.history()).toHaveLength(1);
    expect(e.core.seat.history()[0]).toMatchObject({ generation: 1, changedBy: 'server', holder: { ai: next } });
    expect(e.ctx.store.members.require(MAIN_AGENT_ID)).toMatchObject({ ai: next, aiDecision: { by: OPERATOR } });
    const same = seatActivity(e).find((x) => x.text.startsWith('메인 자리 Claude CLI의 모델·노력치를 바꿈'))!;
    expect([same.actor, same.text]).toEqual([OPERATOR, `메인 자리 Claude CLI의 모델·노력치를 바꿈 (세대 1 그대로 — 다음 턴부터: 모델 opus, 노력치 ${e.core.team.effortValue(next)}) — 운영 설정의 메인 AI 변경 (데스크톱 운영자)`]);
    expect(notices(e, '메인 에이전트가 바뀌었습니다')).toEqual([]);
    // 실행 중인 턴은 띄울 때의 값 — 다음 턴은 같은 세션을 이어서 새 모델로
    const first = e.launches.find((l) => l.turnId === running.turnId)!;
    expect(first.model).not.toBe('opus');
    e.hold.clear();
    running.finishOk();
    await e.idle();
    await e.invoke('command.send', { target: 'main', text: '둘째 명령' });
    await e.drain(1);
    const turns = e.ctx.store.turns.list({ ref1: MAIN_AGENT_ID });
    expect(turns).toHaveLength(2);
    expect(turns[1]!.sessionId).toBe(turns[0]!.sessionId);
    const second = e.launches.find((l) => l.turnId === turns[1]!.id)!;
    expect([second.model, second.effort, second.resume !== null]).toEqual(['opus', e.core.team.effortValue(next), true]);
  });

  it('자리가 받지 않으면 설정을 저장하지 않고, 메인의 update_settings는 메인 AI를 바꾸지 못한다', async () => {
    const e = (env = await bootOrch());
    e.core.seat.applyOperatorConfig({ holders: ['launched:claude'], drainMs: null, initialHolder: null }, '시험');
    const before = fingerprint(e);
    const codex: AiConfig = { ...e.ctx.settings().general.mainAgent, kind: 'codex', model: null };
    await expect(e.invoke('settings.update', { general: { mainAgent: codex } })).rejects.toMatchObject({
      code: 'forbidden',
      message: 'Codex CLI(launched:codex)은(는) 운영자가 정한 메인 자리 보유자 목록(seat.holders: launched:claude)에 없습니다',
    });
    expect(fingerprint(e)).toBe(before);
    // 메인 에이전트는 자리 넘기기(hand_off_seat)로만 — 운영 설정의 메인 AI는 운영자 몫이다
    await expect(e.main('update_settings', { patch: { general: { mainAgent: { ...codex, kind: 'claude', model: 'opus' } } } })).rejects.toMatchObject({ code: 'forbidden' });
    expect(fingerprint(e)).toBe(before);
  });

  it('로그아웃한 데스크톱 화면: 자리 보기 넷은 unauthorized이고 스냅숏의 자리는 LOCKED_SEAT다 (S4-11)', async () => {
    const e = (env = await bootOrch());
    expect(await e.invoke('seat.get')).toMatchObject({ generation: 1, holder: { label: 'Claude CLI' } });
    await e.invoke('auth.logout');
    for (const [m, args] of [
      ['seat.get', []],
      ['seat.history', []],
      ['seat.handover', [1]],
      ['journal.list', [{}]],
    ] as const) {
      await expect((e.orch.backend.invoke as unknown as (x: string, a: unknown[]) => Promise<unknown>)(m, [...args]), m).rejects.toMatchObject({ code: 'unauthorized' });
    }
    const pushed: unknown[] = [];
    const off = e.orch.backend.onTopic('snapshot', (s) => pushed.push(s.seat));
    e.ctx.bus.changed();
    await waitFor(() => pushed.length > 0, '로그아웃 스냅숏');
    off();
    expect(pushed.at(-1)).toEqual(LOCKED_SEAT);
  });
});
