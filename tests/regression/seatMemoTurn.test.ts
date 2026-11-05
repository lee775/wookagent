/**
 * 메인 자리 교체의 인계 메모 턴 (SERVER_DESIGN 4.3 3번, 리드 결정 S4-3·S4-6, S4b):
 * - 강제가 아닌 운영자 교체는 나가는 보유자에게 짧은 인계 메모 턴을 한 번 준다(최대 2분, 나가는 세대로). 그 턴에는 journal_write·write_memory와 조회 도구만
 *   쓴다 — 다른 도구는 거부된다. 남긴 메모는 새 보유자의 인계 꾸러미 '넘길 때 남긴 글'에, 약속은 '열린 약속'에 든다. 메모 업무는 새 보유자에게 가지 않는다
 * - 운영자 강제·메인이 스스로 넘긴 교체에는 주지 않는다. 나가는 AI가 재로그인 필요·사용량 한도면 주지 않는다 (허용 검사) — 실행 자리가 모두 차 있어도
 *   교체를 시작할 때 바로 정한다 (S4-29 4번, 탐침 memoFirstGate)
 * - 상한을 넘겨 멈춘 메모 턴의 종료를 확인하지 못하면 새 보유자를 앉히지 않고 switching으로 멈춘다 — 정지 해제가 이어 가고, 그때는 메모 턴을 다시 주지 않는다
 * - 앱이 메모 턴 중에 끝났으면 다음 시작이 교체를 이어 가되 메모 턴은 다시 주지 않고, 남은 메모 업무를 지운다
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID, type AiConfig } from '@shared/domain';
import { enqueue } from '../../src/main/orchestrator/records';
import { bootOrch, notices, startReview, waitFor, type OrchEnv } from './orchHarness';

let env: OrchEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const CODEX: AiConfig = { kind: 'codex', model: null, effortTier: 'high', effortOverride: null };
const KEY = 'main:general';
const seatRows = (e: OrchEnv) => e.ctx.store.activity.search({ kinds: ['seat'], limit: 50 }).map((r) => r.text);
const operatorSwap = (e: OrchEnv, force = false) => e.core.seat.assign({ holder: { kind: 'launched', ai: CODEX }, by: 'operator', reason: '운영자 교체', force });

/** 메인 턴 하나를 끝내 둔다 (나가는 보유자의 열린 대화 세션) */
async function priorTurn(e: OrchEnv): Promise<void> {
  await e.invoke('command.send', { target: 'main', text: '지금 상황은?' });
  await e.drain(1);
}

describe('인계 메모 턴 (seatMemoTurn)', () => {
  it('운영자 교체는 나가는 보유자에게 메모 턴을 준다 — 일지·기억 쓰기와 조회만 받고, 남긴 것은 새 보유자의 꾸러미에 든다', async () => {
    const e = (env = await bootOrch());
    await priorTurn(e);
    const before = e.ctx.store.sessions.list({ ref1: MAIN_AGENT_ID, state: 'open' })[0]!;
    e.hold.add(KEY);
    const swap = operatorSwap(e);
    await waitFor(() => !!e.liveProc(KEY, MAIN_AGENT_ID), '인계 메모 턴');
    const memo = e.liveProc(KEY, MAIN_AGENT_ID)!.turnId;
    // 나가는 세대로, 나가는 보유자의 그 대화 세션을 이어서
    expect(e.identity(memo).seatGeneration).toBe(1);
    expect(e.ctx.store.turns.require(memo)).toMatchObject({ aiKind: 'claude', sessionId: before.id });
    expect(e.core.seat.view()).toMatchObject({ generation: 2, state: 'switching' });
    const launch = e.launches.find((l) => l.turnId === memo)!;
    expect(launch.message).toContain('[메인 자리 인계 메모] 메인 자리가 Codex CLI에게 넘어갑니다 (세대 1 → 2, 운영자가 바꿈 — 까닭: 운영자 교체).');
    expect(launch.message).toContain('이 턴에는 journal_write·write_memory와 조회 도구만 쓸 수 있습니다. 2분 안에 마치지 않으면 프로그램이 턴을 끝냅니다');
    // 쓸 수 있는 것: 일지·기억 쓰기와 조회
    expect((await e.tool(memo, 'get_work_context')).ok).toBe(true);
    expect((await e.tool(memo, 'read_memory')).ok).toBe(true);
    expect((await e.tool(memo, 'write_memory', { content: '# 일반\n- 운영자가 Codex로 바꿈' })).ok).toBe(true);
    const note = (await e.tool(memo, 'journal_write', { kind: 'note', text: '배포는 금요일에 하기로 대표와 얘기했다' })) as { ok: true; data: { id: string } };
    const promise = (await e.tool(memo, 'journal_write', { kind: 'promise', text: '새 메인이 금요일 배포 전에 대표에게 확인한다', reason: '대표가 확인하면 닫는다' })) as { ok: true; data: { id: string } };
    expect([note.ok, promise.ok]).toEqual([true, true]);
    // 그 밖의 도구는 거부된다 (상태를 바꾸지 않는다)
    for (const [tool, args] of [
      ['register_directive', { project_id: e.projectId, title: '새 지시', text: '하지 마' }],
      ['journal_close', { id: promise.data.id, resolution: '닫기' }],
      ['ask_owner', { question: '질문' }],
    ] as const) {
      expect(await e.tool(memo, tool, { ...args })).toEqual({
        ok: false,
        code: 'forbidden',
        message: `인계 메모 턴에는 journal_write·write_memory와 조회 도구만 쓸 수 있습니다 — 메인 자리가 넘어가는 중이라 ${tool}은(는) 처리하지 않았습니다. 다 적었으면 턴을 마치세요`,
      });
    }
    expect(e.ctx.store.directives.list()).toEqual([]);
    // 메모 턴이 끝나면 넘어간다
    e.liveProc(KEY, MAIN_AGENT_ID)!.finishOk();
    await swap.done;
    expect(e.core.seat.view()).toMatchObject({ generation: 2, state: 'active', holder: { label: 'Codex CLI' } });
    expect(seatRows(e)).toContain(`메인 자리 교체 (세대 1 → 2): 나가는 보유자에게 인계 메모 턴을 줌 (${KEY}, 최대 2분) — ${memo}`);
    const packet = e.core.seat.handover(2)!;
    const memos = packet.sections.find((s) => s.key === 'memos')!.lines;
    expect(memos).toContain('[넘길 때 남긴 글 (인계 메모)] 1건');
    expect(memos.some((l) => l.startsWith(`- ${note.data.id} [세대 1 · Claude CLI · `) && l.endsWith('배포는 금요일에 하기로 대표와 얘기했다'))).toBe(true);
    expect(memos.some((l) => l.startsWith(`- ${promise.data.id} [세대 1 · Claude CLI · `))).toBe(true);
    // 메모 업무는 새 보유자에게 가지 않는다 — 새 보유자의 첫 턴은 쌓인 명령만
    e.hold.clear();
    await e.invoke('command.send', { target: 'main', text: '새 메인에게 명령' });
    await e.drain(1);
    const last = e.launches.filter((l) => l.memberId === MAIN_AGENT_ID).at(-1)!;
    expect(e.identity(last.turnId).seatGeneration).toBe(2);
    expect(last.message).not.toContain('### 1. 기억 갱신');
    expect(last.message).toContain('새 메인에게 명령');
    expect(e.ctx.store.queue.list({ state: ['queued', 'running'] }).filter((q) => q.message.includes('[메인 자리 인계 메모]'))).toEqual([]);
    expect(e.errors).toEqual([]);
  });

  it('운영자 강제·메인이 넘긴 교체, 재로그인 필요·사용량 한도인 나가는 AI에는 메모 턴을 주지 않는다', async () => {
    const e = (env = await bootOrch({ mock: false }));
    await priorTurn(e);
    const turns = () => e.ctx.store.turns.list({ ref1: MAIN_AGENT_ID }).length;
    const n0 = turns();
    // 강제
    await operatorSwap(e, true).done;
    expect(seatRows(e)).toContain('메인 자리 교체 (세대 1 → 2): 인계 메모 턴을 주지 않음 — 운영자 강제 교체');
    // 나가는 Codex가 재로그인 필요
    e.ctx.saveAi({ ...e.ctx.ai('codex'), authRequired: true, authRequiredSince: e.ctx.now() });
    await e.core.seat.assign({ holder: { kind: 'launched', ai: { ...CODEX, kind: 'claude' } }, by: 'operator', reason: '되돌림' }).done;
    expect(seatRows(e)).toContain('메인 자리 교체 (세대 2 → 3): 인계 메모 턴을 주지 않음 — 나가는 보유자가 지금 답할 수 없습니다 (codex 인증 만료 — 재로그인 필요)');
    e.ctx.saveAi({ ...e.ctx.ai('codex'), authRequired: false, authRequiredSince: null });
    // 나가는 Claude가 사용량 한도
    e.ctx.saveAi({ ...e.ctx.ai('claude'), usageLimitedUntil: new Date(Date.now() + 3600_000).toISOString() });
    await operatorSwap(e).done;
    expect(seatRows(e).some((t) => t.startsWith('메인 자리 교체 (세대 3 → 4): 인계 메모 턴을 주지 않음 — 나가는 보유자가 지금 답할 수 없습니다 (claude 사용량 한도'))).toBe(true);
    // 어느 교체에도 메모 턴은 뜨지 않았다
    expect(turns()).toBe(n0);
    expect(e.core.seat.view()).toMatchObject({ generation: 4, state: 'active', holder: { label: 'Codex CLI' } });
  });

  it('교체를 시작할 때 이미 재로그인 필요인 나가는 AI에는 실행 자리가 모두 차 있어도 바로 주지 않는다 — 참인 까닭 하나, 메모 시간을 기다리지 않는다 (S4-29 4번)', async () => {
    const e = (env = await bootOrch({ mock: false, settings: { execution: { maxConcurrent: 1 } } }));
    e.ctx.deps.timing!.memoTurnMs = 3_000;
    await priorTurn(e);
    await startReview(e, e.qaId); // 하나뿐인 실행 자리가 차 있다
    e.ctx.saveAi({ ...e.ctx.ai('claude'), authRequired: true, authRequiredSince: e.ctx.now() });
    const t0 = Date.now();
    await operatorSwap(e).done;
    const took = Date.now() - t0;
    expect(seatRows(e).filter((t) => t.startsWith('메인 자리 교체 (세대 1 → 2): 인계 메모'))).toEqual([
      '메인 자리 교체 (세대 1 → 2): 인계 메모 턴을 주지 않음 — 나가는 보유자가 지금 답할 수 없습니다 (claude 인증 만료 — 재로그인 필요)',
    ]);
    // 실행 자리를 기다렸다면(메모 시간 3초) 이보다 늦고 '실행 자리가 … 나지 않았습니다'라는 참이 아닌 까닭을 남겼다
    expect(took).toBeLessThan(2_000);
    expect(e.core.seat.view()).toMatchObject({ generation: 2, state: 'active' });
    expect(e.launches.filter((l) => l.memberId === MAIN_AGENT_ID && l.message.includes('[메인 자리 인계 메모]'))).toEqual([]);
  });

  it('상한을 넘겨 멈춘 메모 턴의 종료를 확인하지 못하면 switching으로 멈춘다 — 정지 해제가 이어 가고, 메모 턴은 다시 주지 않는다', async () => {
    const e = (env = await bootOrch());
    e.ctx.deps.timing!.memoTurnMs = 300;
    await priorTurn(e);
    e.hold.add(KEY);
    e.script.set(KEY, (p) => {
      p.terminateResult = { ok: false, remaining: -1, detail: '가짜 종료 확인 실패', durationMs: 1 };
    });
    await operatorSwap(e).done;
    expect(e.ctx.store.seat.get('main')!.swap).toMatchObject({ from: 1, to: 2, stage: 'unconfirmed', memoTurnId: expect.stringMatching(/^TN-/) });
    expect(e.core.seat.view()).toMatchObject({ generation: 2, state: 'switching', holder: { label: 'Claude CLI' } });
    expect(notices(e, '메인 자리 교체가 멈췄습니다')).toHaveLength(1);
    expect(e.ctx.store.turns.list({ ref1: MAIN_AGENT_ID }).at(-1)!.endDetail).toBe('메인 자리 교체(세대 2) — 인계 메모 시간(0.3초)을 넘김');
    // 교체 스스로의 메모 시간 초과 정지가 실패해 멈췄다 — 그 정지의 실패 글로 멈춘 한 줄 (메모 턴 뒤 턴 기록을 보는 S4-31 확인의 글이 아니다)
    expect(seatRows(e).filter((t) => t.startsWith('메인 자리 교체 멈춤'))).toEqual([
      '메인 자리 교체 멈춤 (세대 1 → 2): 나가는 메인 턴의 종료를 확인하지 못해 Codex CLI가 앉지 않았습니다 — 종료 확인 실패: 가짜 종료 확인 실패',
    ]);
    e.script.clear();
    e.hold.clear();
    await e.invoke('stop.release');
    await e.core.seat.settled();
    expect(e.core.seat.view()).toMatchObject({ generation: 2, state: 'active', holder: { label: 'Codex CLI' } });
    expect(seatRows(e)).toContain('메인 자리 교체 (세대 1 → 2): 인계 메모 턴을 주지 않음 — 나가는 턴의 종료를 확인하지 못해 멈췄던 교체를 정지 해제로 이어 갑니다');
    expect(e.ctx.store.turns.list({ ref1: MAIN_AGENT_ID })).toHaveLength(2);
  });

  it('앱이 메모 턴 중에 끝났으면 다음 시작은 메모 턴을 다시 주지 않고, 남은 메모 업무를 새 보유자에게 넘기지 않는다', async () => {
    const e = (env = await bootOrch());
    await priorTurn(e);
    // 앞 실행의 모습: 메모 턴을 띄운 채(memoTurnId) 끝났고, 재시작 복구가 그 메모 업무를 다시 넣었다
    const now = e.ctx.now();
    const row = e.ctx.store.seat.get('main')!;
    const codex = { kind: 'launched' as const, ai: CODEX };
    e.ctx.store.seat.put({
      ...row,
      generation: 2,
      state: 'switching',
      pendingHolder: codex,
      swap: { from: 1, to: 2, by: 'operator', reason: '운영자 교체', note: null, force: false, callerTurnId: null, requestedAt: now, stage: 'finishing', memoTurnId: 'TN-앞실행' },
    });
    e.ctx.store.seatHistory.insert({ id: 'G-0002', generation: 2, holder: codex, startedAt: now, endedAt: null, startReason: '운영자 교체', endReason: null, changedBy: 'operator', handoverId: null });
    const left = enqueue(e.ctx, { kind: 'memory_update', memberId: MAIN_AGENT_ID, sessionKey: KEY, projectId: null, message: '이전 턴이 끝나지 못했습니다.\n\n(다시 전달) [메인 자리 인계 메모] 메인 자리가 Codex CLI에게 넘어갑니다' });
    e.core.seat.resumeAfterRestart();
    await e.core.seat.settled();
    expect(e.core.seat.view()).toMatchObject({ generation: 2, state: 'active', holder: { label: 'Codex CLI' } });
    expect(seatRows(e)).toContain('메인 자리 교체 (세대 1 → 2): 인계 메모 턴을 주지 않음 — 인계 메모 턴을 이미 줬습니다');
    expect(e.ctx.store.queue.require(left.id).state).toBe('cancelled');
    await e.drain(1);
    expect(e.ctx.store.turns.list({ ref1: MAIN_AGENT_ID })).toHaveLength(1);
  });
});
