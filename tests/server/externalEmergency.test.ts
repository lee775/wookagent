/**
 * externalEmergency (SERVER_DESIGN 4.5 '정지'·9.1, 리드 결정 S7-4·S7-7): 외부 보유자(모의 외부 에이전트 hold — 턴을 받아 마치지 않고 heartbeat만)가 도는 중의 긴급 정지.
 * - 요약은 완료가 아니다(completed false) — 외부 보유자 한 줄 '…종료 확인 불가', remaining -1. 정지는 3초 상한 안에 답한다
 * - 옛 턴 토큰은 MCP·REST 모두 401, heartbeat·work/next·claim은 409 stopped. 돌던 외부 턴은 user_stop으로 끝나 다시 들어간다(exited — CTL-11 일시정지 없음)
 * - 대표가 정지를 풀면 에이전트는 다시 claim한다
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID } from '@shared/domain';
import type { EmergencySummary } from '@shared/views';
import { EXTERNAL_STOP } from '../../src/main/orchestrator/externalAgents';
import { agentCall, bootExternal, claimAs, errCode, errMessage, mcpCall, situation, until, type ExternalEnv } from './externalRig';

let x: ExternalEnv;
let key = '';
let mock: ReturnType<ExternalEnv['spawnMock']>;

beforeAll(async () => {
  x = await bootExternal({});
}, 120_000);

afterAll(async () => {
  await x?.close();
});

/** 살아 있는 외부 턴의 토큰 — 시험만 읽는다 (출력하지 않는다). 모의 에이전트는 기록에 토큰을 쓰지 않는다 */
const liveToken = (): string => (x.h.core.externalAgents as unknown as { lease: { turn: { item: { mcp: { token: string } } } | null } | null }).lease!.turn!.item.mcp.token;

describe('externalEmergency — 긴급 정지는 외부 임대·턴 토큰을 폐기하고 완료라고 하지 않는다 (S7-4)', () => {
  it('hold 보유자: 요약 completed false·종료 확인 불가, 옛 토큰 401(MCP·REST), heartbeat·next·claim 409 stopped, CTL-11 일시정지 없음, 해제 뒤 다시 claim', async () => {
    const ctx = x.h.core.ctx;
    key = x.operator.addExternalAgent('그록봇').key;
    await x.operator.assignSeat('external:X-0001', true);
    mock = x.spawnMock(key, ['--scenario', 'hold', '--heartbeat-ms', '250']);
    await until(() => x.mockLog(mock.log).some((e) => e.ev === 'claim' && e.status === 200), 'claim');
    await x.owner$('command.send', { target: 'main', text: '오래 걸리는 일을 해 줘' });
    await until(() => x.mockLog(mock.log).some((e) => e.ev === 'hold'), '턴을 받아 붙잡음', 30_000, () => situation(x, mock.log));
    const turnId = String(x.mockLog(mock.log).find((e) => e.ev === 'hold')!.turnId);
    // 턴이 살아 있는 동안 work/next는 같은 일을 곧바로 준다 (잃어버린 응답이 두 턴을 만들지 않게)
    await until(() => x.mockLog(mock.log).some((e) => e.ev === 'next-while-holding'), '붙잡은 동안의 work/next');
    expect(x.mockLog(mock.log).find((e) => e.ev === 'next-while-holding')).toMatchObject({ status: 200, sameTurn: true });
    const token = liveToken();
    expect((await mcpCall(x.mcp, token, 'get_overview')).status).toBe(200);

    const t0 = Date.now();
    const summary = await x.owner$<EmergencySummary>('stop.emergency');
    expect(Date.now() - t0).toBeLessThan(6_000);
    expect(summary.completed).toBe(false);
    expect(summary.failures).toEqual([{ memberId: MAIN_AGENT_ID, memberName: '메인 에이전트(그록봇 — 외부)', detail: EXTERNAL_STOP, remaining: -1 }]);
    expect(summary.failures[0]!.detail).toContain('종료 확인 불가');
    expect(summary.stoppedTurns.find((s) => s.turnId === turnId)).toMatchObject({ ok: true, detail: EXTERNAL_STOP });

    // 옛 턴 토큰은 죽었다 — MCP도 REST도 401
    expect((await mcpCall(x.mcp, token, 'get_overview')).status).toBe(401);
    const rest = await agentCall(x.api, key, '/tool/get_overview', { body: {}, headers: { 'X-Wook-Turn-Token': token } });
    expect([rest.status, errCode(rest)]).toEqual([401, 'unauthorized']);
    // claim은 곧바로 409 stopped (대표가 풀면 다시 claim) — 모의 에이전트의 409를 기다리기 전에 직접 본다 (리드 결정 S7-20 TI-6)
    const claim = await agentCall(x.api, key, '/seat/claim', { body: {} });
    expect([claim.status, errCode(claim)]).toEqual([409, 'stopped']);
    expect(errMessage(claim)).toContain('대표가 정지를 풀면 다시 claim하세요');

    // 돌던 외부 턴: user_stop, exited(끝남 확인 불가는 글로), 다시 넣음 — CTL-11 일시정지·교체 보류 없음. 정지가 그 턴을 끝냈으므로 짧게만 기다린다
    await until(() => !!ctx.store.turns.get(turnId)?.endedAt, '정지한 외부 턴이 user_stop으로 끝남', 5_000, () => situation(x, mock.log));
    const t = ctx.store.turns.get(turnId)!;
    expect({ end: t.endReason, state: t.process.state, kill: t.process.killDetail }).toEqual({ end: 'user_stop', state: 'exited', kill: EXTERNAL_STOP });
    await until(() => x.h.core.turns.count() === 0, '턴 정리', 10_000, () => situation(x, mock.log));
    // 모의 에이전트의 heartbeat·work/next·claim도 409 stopped를 받았다
    await until(() => ['heartbeat', 'next-while-holding', 'claim'].every((ev) => x.mockLog(mock.log).some((e) => e.ev === ev && e.status === 409 && e.code === 'stopped')), 'heartbeat·next·claim의 409 stopped', 30_000, () => situation(x, mock.log));
    expect(ctx.stop().members[MAIN_AGENT_ID]).toBeUndefined();
    expect(ctx.store.notifications.list().some((n) => n.title === '프로세스 종료 확인 실패')).toBe(false);
    expect(ctx.store.queue.list({ ref1: MAIN_AGENT_ID, state: 'queued' }).map((q) => q.kind)).toEqual(['main_command']);
    // 정지한 동안은 응답 없음으로 세지 않는다
    expect(ctx.store.seat.get('main')!.unresponsiveSince).toBeNull();

    // 대표가 정지를 풀면 에이전트가 다시 claim한다
    await x.owner$('stop.release');
    await until(() => x.mockLog(mock.log).filter((e) => e.ev === 'claim' && e.status === 200).length === 2, '해제 뒤 다시 claim', 30_000, () => situation(x, mock.log));
  }, 120_000);

  it('긴급 정지는 임대를 끝낸다 — 정지 중에는 연결돼 있지 않고, 정지를 푼 뒤 정지 전의 임대는 409 lease_expired다 (리드 결정 S7-20 TI-1)', async () => {
    const ctx = x.h.core.ctx;
    // 앞 시험의 모의 에이전트를 끝낸다 — 이 시험은 시험 자신이 에이전트다. 같은 에이전트의 claim이 모의 에이전트의 임대(와 받아 간 턴)를 끝낸다
    if (mock.child.exitCode === null && mock.child.signalCode === null) {
      const gone = new Promise((r) => mock.child.once('exit', r));
      mock.child.kill();
      await gone;
    }
    const lease = await claimAs(x.api, key);
    await until(() => x.h.core.turns.count() === 0, '앞 임대의 턴 정리', 10_000, () => situation(x));
    const connected = async (): Promise<boolean> => (await x.owner$<{ id: string; connected: boolean }[]>('agents.list')).find((a) => a.id === 'X-0001')!.connected;
    const beat = () => agentCall(x.api, key, '/seat/heartbeat', { body: { leaseId: lease.leaseId } });
    expect([(await beat()).status, await connected()]).toEqual([200, true]);

    await x.owner$('stop.emergency');
    const during = await beat();
    expect([during.status, errCode(during)]).toEqual([409, 'stopped']);
    // 정지 중에는 연결돼 있지 않다 — 자리 행의 임대도 거뒀다
    expect([await connected(), ctx.store.seat.get('main')!.lease]).toEqual([false, null]);

    await x.owner$('stop.release');
    // 정지 전의 임대는 다시 살아나지 않는다 — heartbeat·work/next 모두 lease_expired, 다시 claim하라는 글
    const after = await beat();
    expect([after.status, errCode(after), errMessage(after)]).toEqual([409, 'lease_expired', '이 임대는 긴급 정지로 폐기했습니다 — 대표가 정지를 풀었으니 다시 claim하세요']);
    const next = await agentCall(x.api, key, '/work/next', { body: { leaseId: lease.leaseId, waitMs: 0 } });
    expect([next.status, errCode(next)]).toEqual([409, 'lease_expired']);
    expect(await connected()).toBe(false);
    // 다시 claim하면 새 임대로 연결된다
    await claimAs(x.api, key);
    expect(await connected()).toBe(true);
  }, 60_000);
});
