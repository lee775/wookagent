/**
 * externalLeaseRules (SERVER_DESIGN 4.4·4.5·10.7, 리드 결정 S7-3·S7-4·S7-20 TI-2·TI-4·TI-5 — 검토 tests-integrity 2·4·5): 임대 길의 규칙 가운데 시험이 없던 것.
 * - 살아 있는 임대는 그 키의 에이전트 것이다 — 다른 에이전트의 키로 남의 임대를 쓰면 heartbeat·work/next·finish 모두 403 not_assigned이고 그 턴은 그대로다
 * - 같은 임대로 두 번째 work/next가 오면 앞의 열린 롱폴은 곧바로 204다 (에이전트 하나에 열린 롱폴 하나)
 * - seat/release: 200, 자리는 곧바로 응답 없음('외부 에이전트가 스스로 물러남'), 옛 임대는 409 lease_expired, 받아 간 턴은 그 까닭의 비정상 종료로 끝나 한 번 다시
 *   들어가고(attempts 1) 다시 claim하면 그 일이 온다
 * - 임대 길은 답하기 전에 만료를 본다: 끝나는 때가 지난 뒤 sweep(스케줄러 차례·5초 타이머)보다 먼저 온 heartbeat도 409 lease_expired다 (시계를 앞당기고 둘을 멈춰 둔다)
 * 시험 자신이 에이전트다(HTTP, 실제 루프백 리스너). 임대는 기본 60초. 메인 턴은 모두 모의 실행이거나 외부 턴이다 (externalRig close())
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID } from '@shared/domain';
import { EXTERNAL_RELEASED } from '../../src/main/orchestrator/externalAgents';
import { agentCall, bootExternal, claimAs, errCode, errMessage, nextWork, offsetClock, situation, sleep, until, type AgentReply, type ExternalEnv } from './externalRig';

const LEASE_MS = 60_000;
const clock = offsetClock();
let x: ExternalEnv;
let keyA = '';
let keyB = '';

beforeAll(async () => {
  x = await bootExternal({ clock, timing: { agentLeaseMs: LEASE_MS } });
  keyA = x.operator.addExternalAgent('그록봇').key;
  keyB = x.operator.addExternalAgent('남는봇').key;
  await x.operator.assignSeat('external:X-0001', true);
}, 120_000);

afterAll(async () => {
  await x?.close();
});

const ctx = () => x.h.core.ctx;
const beat = (key: string, leaseId: string) => agentCall(x.api, key, '/seat/heartbeat', { body: { leaseId } });
const finish = (key: string, leaseId: string, turnId: string, finalText: string) => agentCall(x.api, key, `/work/${turnId}/finish`, { body: { leaseId, finalText, outcome: 'completed' } });
const said = (r: AgentReply) => [r.status, errCode(r)];
/** 대기 중인 대표 명령의 전달 횟수 */
const queuedCommands = () => ctx().store.queue.list({ ref1: MAIN_AGENT_ID, state: 'queued' }).filter((q) => q.kind === 'main_command').map((q) => q.attempts);
const replies = (text: string) => ctx().store.conversation.list({ ref1: 'main' }).filter((m) => m.role === 'main_agent' && m.text === text).length;
const settled = () => until(() => x.h.core.turns.count() === 0, '턴 정리', 20_000, () => situation(x));

describe('externalLeaseRules — 임대 길의 규칙 (S7-3·S7-4)', () => {
  it('다른 에이전트의 키로 남의 살아 있는 임대를 쓰면 heartbeat·work/next·finish 모두 403 not_assigned — 그 턴은 그대로이고 임대의 주인이 마친다 (TI-4)', async () => {
    const lease = await claimAs(x.api, keyA);
    await x.owner$('command.send', { target: 'main', text: '남의 임대 시험' });
    const w = await nextWork(x.api, keyA, lease.leaseId);
    const hb = await beat(keyB, lease.leaseId);
    const next = await agentCall(x.api, keyB, '/work/next', { body: { leaseId: lease.leaseId, waitMs: 0 } });
    const fin = await finish(keyB, lease.leaseId, w.turnId, '남이 마침');
    expect([said(hb), said(next), said(fin)]).toEqual([
      [403, 'not_assigned'],
      [403, 'not_assigned'],
      [403, 'not_assigned'],
    ]);
    expect(errMessage(hb)).toBe('이 임대는 이 키의 에이전트 것이 아닙니다');
    // 그 턴은 살아 있고 남의 답은 남지 않았다 — 임대의 주인은 그대로 쓰고 마친다
    expect(ctx().store.turns.get(w.turnId)!.endedAt).toBeNull();
    expect(said(await beat(keyA, lease.leaseId))).toEqual([200, null]);
    const own = await finish(keyA, lease.leaseId, w.turnId, '주인이 마침');
    expect([own.status, own.json<{ endReason: string }>().endReason]).toEqual([200, 'completed']);
    await settled();
    expect([replies('남이 마침'), replies('주인이 마침')]).toEqual([0, 1]);
  }, 60_000);

  it('같은 임대로 두 번째 work/next가 오면 앞의 열린 롱폴은 곧바로 204다 (TI-5)', async () => {
    const lease = await claimAs(x.api, keyA);
    const t0 = Date.now();
    const first = agentCall(x.api, keyA, '/work/next', { body: { leaseId: lease.leaseId, waitMs: 20_000 } });
    // 앞의 롱폴이 열린 뒤에 둘째를 보낸다 (열린 롱폴이 있으면 서버는 그 롱폴을 쥐고 있다)
    await until(() => x.h.core.externalAgents.pollOpen('X-0001', lease.generation), '앞의 롱폴이 열림', 10_000);
    const second = await agentCall(x.api, keyA, '/work/next', { body: { leaseId: lease.leaseId, waitMs: 0 } });
    const old = await first;
    expect([old.status, second.status]).toEqual([204, 204]);
    // 앞의 롱폴은 제 기다림(20초)을 다 채우지 않았다
    expect(Date.now() - t0).toBeLessThan(10_000);
  }, 60_000);

  it("seat/release: 200, 자리는 곧바로 응답 없음('외부 에이전트가 스스로 물러남'), 옛 임대는 409 lease_expired, 받아 간 턴은 비정상 종료로 한 번 다시 들어가 다시 claim하면 온다 (TI-2)", async () => {
    const lease = await claimAs(x.api, keyA);
    const text = '놓기 전에 받은 일';
    await x.owner$('command.send', { target: 'main', text });
    const w = await nextWork(x.api, keyA, lease.leaseId);
    expect(w.message).toContain(text);
    const rel = await agentCall(x.api, keyA, '/seat/release', { body: { leaseId: lease.leaseId, note: '잠깐 물러납니다' } });
    expect(rel.status).toBe(200);
    // 받아 간 턴은 그 자리에서 끝내기 시작했다 (정지 요청 기록) — 아래에서 그 끝 까닭을 본다
    expect(ctx().store.turns.get(w.turnId)!.process.stopRequestedAt).not.toBeNull();
    // 곧바로(기다리지 않고) 응답 없음 — 까닭은 스스로 물러남. 서버는 자리를 바꾸지 않는다
    const seat = ctx().store.seat.get('main')!;
    expect({ gen: seat.generation, holder: seat.holder?.kind === 'external' ? seat.holder.agentId : null, reason: seat.unresponsiveReason, since: !!seat.unresponsiveSince }).toEqual({ gen: 2, holder: 'X-0001', reason: EXTERNAL_RELEASED, since: true });
    expect(ctx().store.activity.search({ kinds: ['seat'], limit: 20 }).some((a) => a.text === `${EXTERNAL_RELEASED}: 그록봇(X-0001, 세대 2) — 남긴 말: 잠깐 물러납니다`)).toBe(true);
    expect((await x.owner$<{ id: string; connected: boolean }[]>('agents.list')).find((a) => a.id === 'X-0001')!.connected).toBe(false);
    // 옛 임대는 죽었다 — heartbeat·work/next 모두 lease_expired
    const hb = await beat(keyA, lease.leaseId);
    expect([...said(hb), errMessage(hb)]).toEqual([409, 'lease_expired', '이 임대는 스스로 놓았습니다 (seat/release) — 다시 잡으려면 claim하세요']);
    expect(said(await agentCall(x.api, keyA, '/work/next', { body: { leaseId: lease.leaseId, waitMs: 0 } }))).toEqual([409, 'lease_expired']);
    // 받아 간 턴은 그 까닭의 비정상 종료로 끝나고 명령은 한 번 다시 들어간다
    await until(() => !!ctx().store.turns.get(w.turnId)?.endedAt, '물러난 턴이 끝남', 5_000, () => situation(x));
    const t = ctx().store.turns.get(w.turnId)!;
    expect([t.endReason, t.endDetail]).toEqual(['crashed', EXTERNAL_RELEASED]);
    await settled();
    expect(queuedCommands()).toEqual([1]);
    // 다시 claim하면 응답 없음이 풀리고 그 일이 온다
    const again = await claimAs(x.api, keyA);
    expect([ctx().store.seat.get('main')!.unresponsiveSince, ctx().store.seat.get('main')!.unresponsiveReason]).toEqual([null, null]);
    const redo = await nextWork(x.api, keyA, again.leaseId);
    expect(redo.message).toContain(text);
    const fin = await finish(keyA, again.leaseId, redo.turnId, '다시 받아 마침');
    expect([fin.status, fin.json<{ endReason: string }>().endReason]).toEqual([200, 'completed']);
    await settled();
    expect(queuedCommands()).toEqual([]);
    expect(replies('다시 받아 마침')).toBe(1);
  }, 60_000);

  it('끝나는 때가 지난 임대는 sweep보다 먼저 온 heartbeat에도 409 lease_expired다 — 임대 길이 먼저 만료를 본다 (TI-4, 앞당긴 시계)', async () => {
    const core = x.h.core;
    const lease = await claimAs(x.api, keyA);
    expect(said(await beat(keyA, lease.leaseId))).toEqual([200, null]);
    // 스케줄러 차례와 5초 타이머를 멈추고 시계를 임대 끝 너머로 — 아직 아무도 sweep하지 않았다
    core.scheduler.stop();
    core.externalAgents.stopTimers();
    try {
      clock.advance(LEASE_MS + 1_000);
      await sleep(50);
      expect(core.externalAgents.liveLease('X-0001', lease.generation)).toBe(false);
      expect(ctx().store.seat.get('main')!.unresponsiveSince).toBeNull();
      const hb = await beat(keyA, lease.leaseId);
      expect([...said(hb), errMessage(hb)]).toEqual([409, 'lease_expired', '이 임대는 60초 동안 heartbeat가 없어 끝났습니다 — 다시 claim하세요']);
      // 그 heartbeat가 sweep했다 — 자리는 그 까닭의 응답 없음, 같은 임대의 다음 요청도 lease_expired
      expect(ctx().store.seat.get('main')!.unresponsiveReason).toBe('외부 에이전트 임대 만료 — 60초 동안 heartbeat 없음');
      expect(said(await beat(keyA, lease.leaseId))).toEqual([409, 'lease_expired']);
    } finally {
      core.scheduler.start();
      core.externalAgents.start();
    }
  }, 60_000);
});
