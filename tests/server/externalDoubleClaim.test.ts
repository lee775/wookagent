/**
 * externalDoubleClaim (SERVER_DESIGN 4.3·4.5, 리드 결정 S7-4·S7-7): 키만으로는 자리를 얻지 못한다 — 배정되지 않은 에이전트의 claim은 403 not_assigned(지금 보유자와
 * 세대를 말한다)이고 자리는 그대로다. 앉은 에이전트가 다시 claim하면(모의 외부 에이전트 reclaim) 앞 임대는 lease_superseded로 끝나고 그 임대가 받아 간 턴은
 * 비정상 종료로 한 번 다시 들어가 새 임대가 받아 마친다
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID } from '@shared/domain';
import { EXTERNAL_RECLAIM } from '../../src/main/orchestrator/externalAgents';
import { agentCall, bootExternal, errCode, situation, until, type ExternalEnv } from './externalRig';

let x: ExternalEnv;

beforeAll(async () => {
  x = await bootExternal({});
}, 120_000);

afterAll(async () => {
  await x?.close();
});

const seatPrint = (): string => {
  const ctx = x.h.core.ctx;
  return JSON.stringify({ seat: ctx.store.seat.get('main'), history: ctx.store.seatHistory.list(), queue: ctx.store.queue.list(), turns: ctx.store.turns.list() });
};

describe('externalDoubleClaim — 배정되지 않은 키는 403, 같은 에이전트의 다시 claim은 앞 임대를 끝낸다 (S7-4)', () => {
  it('배정되지 않은 에이전트의 claim은 403 not_assigned이고 자리·대기열·턴은 그대로다', async () => {
    x.operator.addExternalAgent('그록봇');
    const other = x.operator.addExternalAgent('남는봇');
    await x.operator.assignSeat('external:X-0001', true);
    await x.owner$('command.send', { target: 'main', text: '키만으로는 못 가져간다' });
    const before = seatPrint();
    const r = await agentCall(x.api, other.key, '/seat/claim', { body: { label: '나도 메인' } });
    expect([r.status, errCode(r)]).toEqual([403, 'not_assigned']);
    expect(r.json<{ error: { message: string } }>().error.message).toBe(
      '메인 자리는 이 에이전트(X-0002)에게 배정돼 있지 않습니다 — 지금 보유자: 그록봇 (세대 2). 서버 PC의 운영자가 wook-server seat assign external:X-0002로 배정해야 claim할 수 있습니다',
    );
    // 임대 없이 일을 가져갈 수도 없다
    const next = await agentCall(x.api, other.key, '/work/next', { body: { leaseId: 'made-up-lease', waitMs: 0 } });
    expect([next.status, errCode(next)]).toEqual([409, 'lease_expired']);
    const seat = await agentCall(x.api, other.key, '/seat');
    expect(seat.json()).toMatchObject({ assigned: false, holder: { agentId: 'X-0001' }, leaseExpiresAt: null });
    expect(seatPrint()).toBe(before);
  });

  it('앉은 에이전트의 다시 claim: 앞 임대는 lease_superseded, 받아 간 턴은 비정상 종료로 한 번 다시 들어가 새 임대가 받아 마친다', async () => {
    const ctx = x.h.core.ctx;
    const grant = ctx.store.externalAgents.get('X-0001')!;
    expect(grant.label).toBe('그록봇');
    // 키는 운영자 명령이 한 번만 줬다 — 이 시험은 첫 it에서 받은 키를 쓰지 않으므로 새로 등록해 자리를 옮긴다
    const again = x.operator.addExternalAgent('다시봇');
    await x.operator.assignSeat(`external:${again.id}`, true);
    const mock = x.spawnMock(again.key, ['--scenario', 'reclaim', '--heartbeat-ms', '300']);
    // 앞 임대로 보낸 finish는 lease_superseded — 그 임대가 받아 간 턴은 다시 claim이 그 자리에서 끝냈다 (짧게만 기다린다, 리드 결정 S7-20 TI-6)
    await until(() => x.mockLog(mock.log).some((e) => e.ev === 'finish-old-lease'), '앞 임대로 보낸 finish', 30_000, () => situation(x, mock.log));
    const oldLease = x.mockLog(mock.log).find((e) => e.ev === 'finish-old-lease')!;
    expect(oldLease).toMatchObject({ status: 409, code: 'lease_superseded' });
    const oldTurn = String(oldLease.turnId);
    await until(() => !!ctx.store.turns.get(oldTurn)?.endedAt, '앞 임대의 턴이 다시 claim으로 끝남', 5_000, () => situation(x, mock.log));
    expect([ctx.store.turns.get(oldTurn)!.endReason, ctx.store.turns.get(oldTurn)!.endDetail]).toEqual(['crashed', EXTERNAL_RECLAIM]);
    // 그 일은 다시 들어가 새 임대가 받아 마친다
    await until(() => x.mockLog(mock.log).some((e) => e.ev === 'finish' && e.status === 200), '새 임대로 마침', 30_000, () => situation(x, mock.log));
    expect(x.mockLog(mock.log).filter((e) => e.ev === 'claim' && e.status === 200)).toHaveLength(2);
    await until(() => x.h.core.turns.count() === 0, '턴 정리');

    const turns = ctx.store.turns.list({ ref1: MAIN_AGENT_ID }).filter((t) => t.externalAgentId === again.id);
    expect(turns.map((t) => [t.endReason, t.endDetail])).toEqual([
      ['crashed', EXTERNAL_RECLAIM],
      ['completed', ''],
    ]);
    // 한 번만 다시 들어갔다 (attempts 1) — 두 턴이 돌지 않았다
    const commands = ctx.store.queue.list({ ref1: MAIN_AGENT_ID }).filter((q) => q.kind === 'main_command');
    expect(commands.map((q) => [q.state, q.attempts])).toEqual([
      ['done', 0],
      ['done', 1],
    ]);
    expect(ctx.store.conversation.list({ ref1: 'main' }).filter((m) => m.role === 'main_agent').map((m) => m.text)).toEqual(['모의 외부 에이전트: 키만으로는 못 가져간다']);
    expect(ctx.store.activity.search({ kinds: ['seat'], limit: 50 }).filter((a) => a.text.startsWith('외부 에이전트가 메인 자리를 잡음: 다시봇')).map((a) => a.text.endsWith('같은 에이전트의 앞 임대를 끝냄'))).toEqual([true, false]);
  }, 60_000);
});
