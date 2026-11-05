/**
 * 긴급 정지 중에는 어떤 CLI도 새로 뜨지 않는다 — 인계 메모 턴도 (리드 결정 S4-14, 1단계 긴급 정지 보장 CTL-03, SERVER_DESIGN 4.3 3번):
 * - 인계 메모 턴(memoRun)은 실행 자리를 기다리다가, 띄우기 바로 앞에서 허용 검사(entryRunGate)를 지금 정지 값·시계로 다시 본다. 기다리는 동안 대표가
 *   긴급 정지를 눌렀거나 메인이 일시정지됐거나 나가는 AI가 재로그인 필요·사용량 한도가 됐으면 메모 턴을 주지 않고(건너뛴 까닭을 활동 기록에) 교체를 마친다
 * - 두 번째 방어: TurnRunner는 긴급 정지 중이면 턴·세션 기록 전에 시작을 멈춘다 — 스케줄러를 거치지 않는 길도 CLI를 띄우지 못한다. 대기 항목은 그대로
 *   남고 시작 실패로 세지 않는다
 * 탐침 P2(server-s4-seat-authority)와 zz-s4fl-memo-during-stop(server-s4-flows-lifecycle), memoRecheckAi(server-s4fix1-tests-integrity)에서 왔다
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID, OWNER, type AiConfig } from '@shared/domain';
import { enqueue, slotClassOf } from '../../src/main/orchestrator/records';
import { bootOrch, sleep, startReview, waitFor, type OrchEnv } from './orchHarness';

let env: OrchEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const CODEX: AiConfig = { kind: 'codex', model: null, effortTier: 'high', effortOverride: null };
const seatRows = (e: OrchEnv) => e.ctx.store.activity.search({ kinds: ['seat'], limit: 50 }).map((r) => r.text);
const mainLaunches = (e: OrchEnv) => e.launches.filter((l) => l.memberId === MAIN_AGENT_ID).length;

/** 메인 턴 하나를 끝내 둔다 (나가는 보유자의 열린 대화 세션 — 메모 턴이 이어 쓸 곳) */
async function priorTurn(e: OrchEnv): Promise<void> {
  await e.invoke('command.send', { target: 'main', text: '지금 상황은?' });
  await e.drain(1);
}

describe('긴급 정지 중의 인계 메모 턴 (seatMemoDuringStop)', () => {
  it('실행 자리를 기다리던 메모 턴은 긴급 정지로 자리가 나도 뜨지 않는다 — 건너뛴 까닭을 남기고 교체를 마친다 (탐침 P2)', async () => {
    const e = (env = await bootOrch({ settings: { execution: { maxConcurrent: 2 } } }));
    expect(e.ctx.settings().execution.maxConcurrent).toBe(2);
    await priorTurn(e);
    // 관리 자리 둘을 다른 팀원의 검수 턴으로 채운다 — 메모 턴은 자리가 날 때까지 기다린다
    await startReview(e, e.qaId);
    await startReview(e, e.producerId);
    expect(e.core.turns.running()).toHaveLength(2);
    const before = mainLaunches(e);
    const turnsBefore = e.ctx.store.turns.list({ ref1: MAIN_AGENT_ID }).length;
    const swap = e.core.seat.assign({ holder: { kind: 'launched', ai: CODEX }, by: 'operator', reason: '운영자 교체' });
    expect(swap.outcome).toBe('swap');
    await sleep(300);
    expect(e.core.seat.view().state).toBe('switching');
    expect(mainLaunches(e)).toBe(before);
    // 대표가 긴급 정지 — 검수 턴 둘이 끝나 자리가 빈다
    await e.invoke('stop.emergency');
    await swap.done;
    expect(e.ctx.stop().global.active).toBe(true);
    // 정지 중에는 어떤 CLI도 새로 뜨지 않았다: 메인 턴 기록도, 어댑터 준비도 없다
    expect(mainLaunches(e)).toBe(before);
    expect(e.ctx.store.turns.list({ ref1: MAIN_AGENT_ID })).toHaveLength(turnsBefore);
    // 띄우기 바로 앞의 허용 검사가 메모 턴을 건너뛰었다 — 그 까닭이 활동 기록에 남고, 교체는 메모 없이 끝났다
    expect(seatRows(e)).toContain('메인 자리 교체 (세대 1 → 2): 인계 메모 턴을 주지 않음 — 나가는 보유자가 지금 답할 수 없습니다 (긴급 정지 중)');
    expect(seatRows(e).some((t) => t.includes('인계 메모 턴을 줌'))).toBe(false);
    expect(e.core.seat.view()).toMatchObject({ generation: 2, state: 'active', holder: { label: 'Codex CLI' } });
    // 메모 업무는 새 보유자에게 가지 않는다
    expect(e.ctx.store.queue.list({ ref1: MAIN_AGENT_ID, state: ['queued', 'running'] }).filter((q) => q.message.includes('[메인 자리 인계 메모]'))).toEqual([]);
  });

  it('자리가 하나뿐일 때도 같다 — 정지가 시작된 뒤에 뜬 메인 턴이 없다 (zz-s4fl-memo-during-stop)', async () => {
    const e = (env = await bootOrch({ settings: { execution: { maxConcurrent: 1 } } }));
    await priorTurn(e);
    const mainTurnsBefore = e.ctx.store.turns.list({ ref1: MAIN_AGENT_ID }).length;
    await startReview(e, e.qaId);
    e.hold.add('main:general');
    const swap = e.core.seat.assign({ holder: { kind: 'launched', ai: CODEX }, by: 'operator', reason: '운영자 교체' });
    expect(swap.outcome).toBe('swap');
    await sleep(500); // 메모 턴이 실행 자리를 기다린다
    expect(e.ctx.store.turns.list({ ref1: MAIN_AGENT_ID })).toHaveLength(mainTurnsBefore);
    await e.invoke('stop.emergency');
    expect(e.ctx.stop().global.active).toBe(true);
    await swap.done;
    const stoppedSince = e.ctx.stop().global.since!;
    const startedDuringStop = e.ctx.store.turns.list({ ref1: MAIN_AGENT_ID }).filter((t) => t.startedAt >= stoppedSince);
    expect(startedDuringStop).toEqual([]);
    expect(e.launches.filter((l) => l.message.includes('[메인 자리 인계 메모]'))).toEqual([]);
    expect(e.ctx.stop().global.active).toBe(true);
    expect(e.core.seat.view()).toMatchObject({ generation: 2, state: 'active' });
  });

  it('기다리는 동안 메인이 일시정지돼도 메모 턴을 주지 않는다 — 같은 허용 검사', async () => {
    const e = (env = await bootOrch({ settings: { execution: { maxConcurrent: 1 } } }));
    await priorTurn(e);
    const { proc, task } = await startReview(e, e.qaId);
    const before = mainLaunches(e);
    const swap = e.core.seat.assign({ holder: { kind: 'launched', ai: CODEX }, by: 'operator', reason: '운영자 교체' });
    await sleep(300);
    expect(e.core.seat.view().state).toBe('switching');
    // 메인 일시정지(프로그램이 건 정지와 같은 길) 뒤에 자리가 난다
    await e.core.stops.pauseMember(MAIN_AGENT_ID, 'graceful', 'system', '시험: 메인 일시정지');
    e.hold.delete(`review:${task.id}`);
    proc.finishOk();
    await swap.done;
    expect(mainLaunches(e)).toBe(before);
    expect(seatRows(e)).toContain('메인 자리 교체 (세대 1 → 2): 인계 메모 턴을 주지 않음 — 나가는 보유자가 지금 답할 수 없습니다 (팀원 일시정지)');
    expect(e.core.seat.view()).toMatchObject({ generation: 2, state: 'active' });
  });

  // 다시 보는 허용 검사의 AI 쪽 — 메모 턴이 하나뿐인 실행 자리를 기다리는 동안 나가는 AI가 재로그인 필요·사용량 한도가 되면 자리가 나도 주지 않는다 (S4-29 1번)
  for (const [label, block] of [
    ['재로그인 필요', (e: OrchEnv) => e.ctx.saveAi({ ...e.ctx.ai('claude'), authRequired: true, authRequiredSince: e.ctx.now() })],
    ['사용량 한도', (e: OrchEnv) => e.ctx.saveAi({ ...e.ctx.ai('claude'), usageLimitedUntil: new Date(Date.now() + 3600_000).toISOString() })],
  ] as const) {
    it(`기다리는 동안 나가는 Claude가 ${label}가 되면 자리가 나도 메모 턴을 주지 않는다 — 까닭을 남기고 교체를 마친다 (탐침 memoRecheckAi)`, async () => {
      const e = (env = await bootOrch({ mock: false, settings: { execution: { maxConcurrent: 1 } } }));
      await priorTurn(e);
      const { proc, task } = await startReview(e, e.qaId);
      expect(e.core.turns.running()).toHaveLength(1);
      const memoLaunches = () => e.launches.filter((l) => l.memberId === MAIN_AGENT_ID && l.message.includes('[메인 자리 인계 메모]'));
      const swap = e.core.seat.assign({ holder: { kind: 'launched', ai: CODEX }, by: 'operator', reason: '운영자 교체' });
      expect(swap.outcome).toBe('swap');
      await sleep(400); // 메모 업무가 들어가 하나뿐인 실행 자리를 기다린다
      expect(e.core.seat.view().state).toBe('switching');
      expect(memoLaunches()).toEqual([]);
      block(e); // 나가는 AI가 이제 답할 수 없다
      e.hold.delete(`review:${task.id}`);
      proc.finishOk(); // 자리가 난다
      await swap.done;
      expect(memoLaunches()).toEqual([]);
      expect(seatRows(e).some((t) => t.startsWith('메인 자리 교체 (세대 1 → 2): 인계 메모 턴을 주지 않음 — 나가는 보유자가 지금 답할 수 없습니다 (claude'))).toBe(true);
      expect(e.core.seat.view()).toMatchObject({ generation: 2, state: 'active', holder: { label: 'Codex CLI' } });
    });
  }

  it('TurnRunner는 긴급 정지 중이면 기록 전에 시작을 멈춘다 — 스케줄러를 거치지 않는 길도 CLI를 띄우지 못하고, 대기 항목은 그대로 남는다', async () => {
    const e = (env = await bootOrch());
    await e.core.stops.emergency(OWNER);
    expect(e.ctx.stop().global.active).toBe(true);
    const sessionsBefore = e.ctx.store.sessions.list({ ref1: MAIN_AGENT_ID }).length;
    const entry = enqueue(e.ctx, { kind: 'message', memberId: MAIN_AGENT_ID, sessionKey: 'main:general', projectId: null, priority: 'normal', message: '정지 중에 직접 띄우는 일' });
    // 스케줄러를 거치지 않고 바로 띄운다 (인계 메모 턴과 같은 길)
    e.core.turns.launch({ sessionKey: 'main:general', memberId: MAIN_AGENT_ID, slotClass: slotClassOf('main:general'), priority: 'normal', queuedAt: entry.queuedAt, urgent: false }, [entry.id]);
    await waitFor(() => e.core.turns.count() === 0, '시작 멈춤');
    await sleep(50);
    expect(e.launches.filter((l) => l.memberId === MAIN_AGENT_ID)).toEqual([]);
    expect(e.procs.filter((p) => p.memberId === MAIN_AGENT_ID)).toEqual([]);
    expect(e.ctx.store.turns.list({ ref1: MAIN_AGENT_ID })).toEqual([]);
    expect(e.ctx.store.sessions.list({ ref1: MAIN_AGENT_ID })).toHaveLength(sessionsBefore);
    // 대기 항목은 그대로 — 시작 실패로 세지 않았다
    expect(e.ctx.store.queue.require(entry.id)).toMatchObject({ state: 'queued', turnId: null });
    expect(e.ctx.store.activity.search({ kinds: ['error'], limit: 20 }).filter((r) => r.text.startsWith('턴 시작 실패'))).toEqual([]);
    // 정지를 풀면 스케줄러가 그 일을 띄운다
    await e.invoke('stop.release');
    await e.drain(1);
    expect(e.ctx.store.queue.require(entry.id).state).toBe('done');
  });
});
