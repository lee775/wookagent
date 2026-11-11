/**
 * externalHandsOff (SERVER_DESIGN 4.3·6.2·10.7, 리드 결정 S7-4·S7-7): 외부 메인(모의 외부 에이전트 handoff)이 대표 명령 '[mock:handoff codex]'에 hand_off_seat로
 * Codex에게 넘긴다 — 교체는 그 턴의 finish 뒤에 끝나고, 나간 임대의 heartbeat는 새 보유자를 말하는 seat_changed다. Codex(모의 메인)의 첫 턴 세션에 인계 꾸러미가 있다
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID } from '@shared/domain';
import { bootExternal, situation, until, type ExternalEnv } from './externalRig';

let x: ExternalEnv;

beforeAll(async () => {
  x = await bootExternal({});
}, 120_000);

afterAll(async () => {
  await x?.close();
});

describe('externalHandsOff — 외부 메인이 hand_off_seat로 Codex에게 넘긴다 (S7-4)', () => {
  it('넘김은 그 턴의 finish 뒤에 끝나고, Codex의 첫 턴이 인계 꾸러미를 받는다', async () => {
    const ctx = x.h.core.ctx;
    const { key } = x.operator.addExternalAgent('그록봇');
    await x.operator.assignSeat('external:X-0001', true);
    const mock = x.spawnMock(key, ['--scenario', 'handoff', '--heartbeat-ms', '300']);
    await until(() => x.mockLog(mock.log).some((e) => e.ev === 'claim' && e.status === 200), 'claim');
    await x.owner$('command.send', { target: 'main', text: '[mock:handoff codex] 메인을 Codex에게 넘겨' });
    await until(() => ctx.store.seat.get('main')!.state === 'active' && ctx.store.seat.get('main')!.generation === 3, 'Codex에게 넘어감', 60_000, () => situation(x, mock.log));

    const log = x.mockLog(mock.log);
    expect(log.find((e) => e.ev === 'tool' && e.name === 'hand_off_seat')).toMatchObject({ ok: true });
    expect(log.find((e) => e.ev === 'finish')).toMatchObject({ status: 200, endReason: 'completed' });
    expect(ctx.store.seat.get('main')!.holder).toMatchObject({ kind: 'launched', ai: { kind: 'codex' } });
    const g3 = ctx.store.seatHistory.get('G-0003')!;
    expect([g3.changedBy, g3.holder.kind]).toEqual(['main', 'launched']);
    // 교체는 넘긴 턴이 끝난 뒤에 끝났다
    const handTurn = ctx.store.turns.list({ ref1: MAIN_AGENT_ID }).find((t) => t.runner === 'external')!;
    const done = ctx.store.activity.search({ kinds: ['seat'], limit: 50 }).find((a) => a.text.startsWith('메인 자리 교체 끝: 그록봇 → Codex CLI (세대 3'))!;
    expect(done).toBeDefined();
    expect(Date.parse(done.ts)).toBeGreaterThanOrEqual(Date.parse(handTurn.endedAt!));
    // 나간 임대의 heartbeat·work/next는 새 보유자를 말하는 seat_changed (먼저 닿는 쪽이 받는다)
    await until(() => x.mockLog(mock.log).some((e) => (e.ev === 'heartbeat' || e.ev === 'next') && e.code === 'seat_changed'), 'seat_changed', 30_000, () => situation(x, mock.log));
    // 넘긴 뒤 다시 claim해도 자리는 Codex의 것이다 — 403
    await until(() => x.mockLog(mock.log).some((e) => e.ev === 'claim' && e.status === 403), '다시 claim은 403', 30_000);

    // Codex(모의 메인)의 첫 턴 — 그 세션에 인계 꾸러미
    await x.owner$('command.send', { target: 'main', text: '이어서 해 줘' });
    await until(() => ctx.store.turns.list({ ref1: MAIN_AGENT_ID }).some((t) => t.aiKind === 'codex' && !!t.endedAt), 'Codex의 첫 턴', 60_000, () => situation(x, mock.log));
    const codexTurn = ctx.store.turns.list({ ref1: MAIN_AGENT_ID }).find((t) => t.aiKind === 'codex')!;
    expect([codexTurn.runner, codexTurn.mock, codexTurn.seatGeneration]).toEqual(['cli', true, 3]);
    const session = ctx.store.sessions.get(codexTurn.sessionId)!;
    expect(session.handoverSummary ?? '').toContain('새 보유자: Codex CLI (세대 3)');
    expect(session.handoverSummary ?? '').toContain('이전 보유자: 그록봇 (세대 2');
  }, 120_000);
});
