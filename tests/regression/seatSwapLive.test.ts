/**
 * 실행 중 메인 자리 교체 (SERVER_DESIGN 4.3·10.4 seatSwapLive, 리드 결정 S4-3·S4-4):
 * - 교체가 시작되면(1번) 스케줄러는 M-MAIN 일을 새로 띄우지 않는다. 나가는 메인 턴은 drainMs 안에 끝나면 그대로 마무리하고, 넘으면 멈춘다. 운영자 강제는
 *   기다리지 않고 바로 멈춘다
 * - 나가는 턴은 마무리하는 동안 제 세대 토큰으로 도구를 쓴다. 교체가 끝나면(4번 토큰 폐기 뒤) 그 토큰은 seat_changed로 거부되고 활동 기록에 남는다
 * - 대기열의 M-MAIN 일은 새 보유자에게 간다 — 이전 턴이 끝난 뒤에, 새 AI 종류의 새 세션으로. 이전 세션은 '메인 자리 교체(세대 n)'로 닫힌다
 * - M-MAIN의 AI는 교체 중에는 그대로이고(ensureMainAgent가 덮어쓰지 않는다) 교체가 끝날 때 자리가 바꾼다. 같은 종류의 모델·노력치만 바꾸면 세대 그대로
 * - 나가는 턴의 종료를 확인하지 못하면 switching으로 멈추고 대표에게 알린다 — 대표의 정지 해제가 이어 간다 (CTL-11)
 * - hand_off_seat는 이 턴이 끝나면 넘어간다고 답하고, 그 턴이 끝난 뒤 새 세대가 된다
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID, type AiConfig } from '@shared/domain';
import type { RunnerFields } from '../../src/main/orchestrator/seat';
import { bootOrch, notices, sleep, waitFor, type OrchEnv } from './orchHarness';

let env: OrchEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const CODEX: AiConfig = { kind: 'codex', model: null, effortTier: 'high', effortOverride: null };
const KEY = 'main:general';

async function boot(drainMs: number): Promise<OrchEnv> {
  const e = await bootOrch();
  e.core.seat.applyOperatorConfig({ holders: null, drainMs, initialHolder: null }, '시험');
  return e;
}

/** 대표 명령으로 메인 턴을 띄워 실행 중으로 둔다 */
async function startMainTurn(e: OrchEnv, text = '상태 알려줘'): Promise<string> {
  e.hold.add(KEY);
  await e.invoke('command.send', { target: 'main', text });
  e.tick();
  await waitFor(() => !!e.liveProc(KEY, MAIN_AGENT_ID), '메인 턴 시작');
  return e.liveProc(KEY, MAIN_AGENT_ID)!.turnId;
}

const mainRunning = (e: OrchEnv) => e.core.turns.running().filter((r) => r.memberId === MAIN_AGENT_ID).length;
const seatRows = (e: OrchEnv) => e.ctx.store.activity.search({ kinds: ['seat'], limit: 50 }).map((r) => r.text);

describe('실행 중 메인 자리 교체 (seatSwapLive)', () => {
  it('마무리 시간 안에 끝난 턴은 그대로 마무리하고, 교체 뒤 이전 토큰은 seat_changed로 거부·기록되며, 대기열 일은 새 보유자에게 간다', async () => {
    const e = (env = await boot(10_000));
    const turnId = await startMainTurn(e);
    expect(e.identity(turnId).seatGeneration).toBe(1);
    const r = e.core.seat.assign({ holder: { kind: 'launched', ai: CODEX }, by: 'operator', reason: '시험 교체' });
    expect([r.generation, r.outcome]).toEqual([2, 'swap']);
    expect(e.core.views.snapshot().seat).toMatchObject({ generation: 2, state: 'switching', holder: { label: 'Claude CLI' }, pendingHolder: { label: 'Codex CLI' } });
    // 교체 중: 쌓인 명령의 메인 턴은 새로 띄우지 않고, M-MAIN의 AI도 아직 그대로다
    await e.invoke('command.send', { target: 'main', text: '두 번째 명령' });
    e.tick();
    await sleep(80);
    expect(mainRunning(e)).toBe(1);
    expect(e.ctx.store.members.require(MAIN_AGENT_ID).ai.kind).toBe('claude');
    expect(e.core.team.ensureMainAgent().ai.kind).toBe('claude');
    // 교체 중에는 운영 설정의 메인 AI도 바꾸지 못한다 — 자리가 받지 않으면 설정을 저장하지 않는다 (S4-9)
    await expect(e.internal('settings.update', { general: { mainAgent: { kind: 'claude', model: 'opus', effortTier: 'high', effortOverride: null } } })).rejects.toMatchObject({
      code: 'conflict',
      message: '메인 자리를 Codex CLI에게 넘기는 중입니다(세대 1 → 2) — 교체가 끝난 뒤에 다시 하세요',
    });
    expect(e.ctx.settings().general.mainAgent.model).toBeNull();
    // 나가는 턴은 마무리하는 동안 제 세대 토큰으로 도구를 쓴다
    expect((await e.tool(turnId, 'read_memory', {})).ok).toBe(true);
    // 강제가 아닌 운영자 교체는 나가는 보유자에게 인계 메모 턴을 한 번 준다(4.3 3번, S4b) — 그 가짜 프로세스는 곧바로 끝나게 둔다(지금 턴은 이미 떠 있어 그대로 산다)
    e.hold.delete(KEY);
    e.liveProc(KEY, MAIN_AGENT_ID)!.finishOk();
    await r.done;
    expect(e.core.views.snapshot().seat).toMatchObject({ generation: 2, state: 'active', holder: { kind: 'launched', label: 'Codex CLI', ai: CODEX }, pendingHolder: null });
    expect([e.ctx.store.members.require(MAIN_AGENT_ID).ai, e.ctx.settings().general.mainAgent]).toEqual([CODEX, CODEX]);
    // 이전 토큰: seat_changed, 기록
    expect(await e.tool(turnId, 'read_memory', {})).toEqual({
      ok: false,
      code: 'seat_changed',
      message: '메인 자리가 바뀌었습니다 (이 턴은 세대 1, 지금은 세대 2) — 이 요청(read_memory)은 처리하지 않았습니다. 지금 턴을 마치세요',
    });
    expect(seatRows(e)).toContain('이전 세대(1) 메인 토큰의 도구 요청을 거부함: read_memory — 지금 메인 자리는 세대 2입니다');
    // 이전 세션은 교체 사유로 닫혔다
    const claudeSessions = e.ctx.store.sessions.list({ ref1: MAIN_AGENT_ID }).filter((s) => s.aiKind === 'claude');
    expect(claudeSessions.map((s) => [!!s.closedAt, s.replaceReason])).toEqual([[true, '메인 자리 교체(세대 2)']]);
    // 대기열의 일은 새 보유자에게 — 이전 턴이 끝난 뒤, 새 세대 토큰과 새 세션으로
    e.hold.clear();
    await e.drain(1);
    const turns = e.ctx.store.turns.list({ ref1: MAIN_AGENT_ID }) as (ReturnType<typeof e.ctx.store.turns.list>[number] & RunnerFields)[];
    expect(turns.map((t) => [t.aiKind, t.seatGeneration, t.runner])).toEqual([
      ['claude', 1, 'cli'],
      // 나가는 보유자의 인계 메모 턴 — 나가는 세대로 띄운다 (S4b)
      ['claude', 1, 'cli'],
      ['codex', 2, 'cli'],
    ]);
    expect(e.launches.find((l) => l.turnId === turns[1]!.id)!.message).toContain('[메인 자리 인계 메모]');
    expect(Date.parse(turns[1]!.startedAt)).toBeGreaterThanOrEqual(Date.parse(turns[0]!.endedAt!));
    expect(Date.parse(turns[2]!.startedAt)).toBeGreaterThanOrEqual(Date.parse(turns[1]!.endedAt!));
    expect(e.identity(turns[2]!.id).seatGeneration).toBe(2);
    const open = e.ctx.store.sessions.list({ ref1: MAIN_AGENT_ID, state: 'open' });
    expect(open.map((s) => [s.aiKind, s.replaceReason])).toEqual([['codex', '메인 자리 교체(세대 2)']]);
    // 활동 기록·대표 알림·이력·인계 꾸러미(자리 칸)
    expect(seatRows(e).some((t) => t.startsWith('메인 자리 교체 끝: Claude CLI → Codex CLI (세대 2, 운영자가 바꿈)'))).toBe(true);
    expect(notices(e, '메인 에이전트가 바뀌었습니다').map((n) => n.body)).toEqual([
      '이제 Codex CLI가 메인 에이전트입니다 (세대 2, 이전 Claude CLI). 운영자가 바꿨습니다 — 까닭: 시험 교체. 쌓여 있던 명령은 새 메인 에이전트가 이어서 처리합니다',
    ]);
    expect(e.core.seat.history().map((h) => [h.generation, h.holder.label, h.changedBy, h.endedAt === null, h.hasHandover])).toEqual([
      [2, 'Codex CLI', 'operator', true, true],
      [1, 'Claude CLI', 'server', false, false],
    ]);
    expect(e.core.seat.history()[1]!.endReason).toBe('운영자가 바꿈: 시험 교체');
    const packet = e.core.seat.handover();
    expect(packet).toMatchObject({ generation: 2, holder: { label: 'Codex CLI' }, previous: { label: 'Claude CLI' } });
    // 6.2 순서: 자리 정보 → 확인된 사실 → 이전 메인의 메모(확인되지 않은 주장) → 기억 문서 위치 (S4b가 자리 칸 뒤를 채운다)
    expect(packet!.sections.map((s) => [s.key, s.unverified])).toEqual([
      ['seat', false],
      ['facts', false],
      ['memos', true],
      ['memory', false],
    ]);
    expect(packet!.sections[0]!.lines.slice(1)).toEqual(['바꾼 쪽: 운영자', '까닭: 시험 교체', '새 보유자: Codex CLI (세대 2)']);
    expect(packet!.chars).toBeGreaterThan(0);
    expect(e.errors).toEqual([]);
  });

  it('마무리 시간(drainMs)을 넘긴 턴은 멈추고 교체를 마친다 — 운영자 강제는 기다리지 않고 바로 멈춘다', async () => {
    const e = (env = await boot(250));
    await startMainTurn(e);
    const proc = e.liveProc(KEY, MAIN_AGENT_ID)!;
    // 뒤따르는 인계 메모 턴(S4b)의 가짜 프로세스는 곧바로 끝난다 — 지금 턴은 이미 떠 있어 마무리 시간을 넘긴다
    e.hold.delete(KEY);
    const t0 = Date.now();
    const r = e.core.seat.assign({ holder: { kind: 'launched', ai: CODEX }, by: 'operator', reason: '시험 교체' });
    await r.done;
    expect(Date.now() - t0).toBeGreaterThanOrEqual(200);
    expect(proc.terminatedByApp).toBe(true);
    const [first] = e.ctx.store.turns.list({ ref1: MAIN_AGENT_ID });
    expect([first!.endReason, first!.endDetail]).toEqual(['user_stop', '메인 자리 교체(세대 2) — 마무리 시간 0.3초를 넘김']);
    // 이전 턴은 drainMs 안에 끝난다(10.4) — 멈추는 데 드는 시간만 더한 2초 안. 끝난 때는 그 턴의 기록으로 본다(뒤따르는 인계 메모 턴 때문에 done은 더 늦다, S4-22 1번)
    expect(Date.parse(first!.endedAt!) - t0).toBeLessThan(250 + 2_000);
    expect(e.core.seat.view()).toMatchObject({ generation: 2, state: 'active' });

    // 운영자 강제: 마무리 시간이 길어도 바로 멈춘다
    e.core.seat.applyOperatorConfig({ holders: null, drainMs: 600_000, initialHolder: null }, '시험');
    e.hold.add(KEY);
    await e.invoke('command.send', { target: 'main', text: '다음 명령' });
    e.tick();
    await waitFor(() => !!e.liveProc(KEY, MAIN_AGENT_ID), '새 보유자의 메인 턴');
    const codexProc = e.liveProc(KEY, MAIN_AGENT_ID)!;
    const t1 = Date.now();
    const forced = e.core.seat.assign({ holder: { kind: 'launched', ai: { ...CODEX, kind: 'claude' } }, by: 'operator', reason: '복구', force: true });
    await forced.done;
    expect(Date.now() - t1).toBeLessThan(10_000);
    expect(codexProc.terminatedByApp).toBe(true);
    expect(e.ctx.store.turns.list({ ref1: MAIN_AGENT_ID }).at(-1)!.endDetail).toBe('메인 자리 교체(세대 3) — 운영자가 바로 멈춤');
    expect(e.core.seat.view()).toMatchObject({ generation: 3, state: 'active', holder: { label: 'Claude CLI' } });
    expect(seatRows(e).some((t) => t.includes('(세대 2 → 3, 운영자가 바꿈, 강제)'))).toBe(true);
  });

  it('나가는 턴의 종료를 확인하지 못하면 새 보유자를 앉히지 않고 switching으로 멈춰 알린다 — 대표의 정지 해제가 교체를 이어 간다 (CTL-11)', async () => {
    const e = (env = await boot(100));
    await startMainTurn(e);
    e.liveProc(KEY, MAIN_AGENT_ID)!.terminateResult = { ok: false, remaining: -1, detail: '가짜 종료 확인 실패', durationMs: 1 };
    const r = e.core.seat.assign({ holder: { kind: 'launched', ai: CODEX }, by: 'operator', reason: '시험 교체' });
    await r.done;
    expect(e.core.seat.view()).toMatchObject({ generation: 2, state: 'switching', holder: { label: 'Claude CLI' }, pendingHolder: { label: 'Codex CLI' } });
    expect(e.ctx.store.seat.get('main')!.swap).toMatchObject({ from: 1, to: 2, by: 'operator', stage: 'unconfirmed' });
    // 교체 스스로의 정지가 실패해 멈췄다 — 그 정지의 실패 글로 멈춘 한 줄 (턴 기록을 보는 S4-26 확인의 글이 아니다, 리드 결정 S4-34)
    expect(seatRows(e).filter((t) => t.startsWith('메인 자리 교체 멈춤'))).toEqual([
      '메인 자리 교체 멈춤 (세대 1 → 2): 나가는 메인 턴의 종료를 확인하지 못해 Codex CLI가 앉지 않았습니다 — 종료 확인 실패: 가짜 종료 확인 실패',
    ]);
    const [n] = notices(e, '메인 자리 교체가 멈췄습니다');
    expect(n).toMatchObject({ level: 'urgent' });
    expect(n!.body).toContain("남은 프로세스가 모두 사라졌는지 확인한 뒤 '정지 해제'를 누르면 교체를 이어 갑니다");
    // 쌓인 명령은 띄우지 않는다 — 두 메인이 겹치지 않게
    e.hold.clear();
    await e.invoke('command.send', { target: 'main', text: '그동안 온 명령' });
    e.tick();
    await sleep(100);
    expect(mainRunning(e)).toBe(0);
    expect(e.ctx.store.members.require(MAIN_AGENT_ID).ai.kind).toBe('claude');
    // 대표가 확인하고 정지 해제 → 교체를 마치고 새 보유자가 쌓인 명령을 처리한다
    await e.invoke('stop.release');
    expect(e.core.seat.view()).toMatchObject({ generation: 2, state: 'active', holder: { label: 'Codex CLI' } });
    await e.drain(1);
    expect(e.ctx.store.turns.list({ ref1: MAIN_AGENT_ID }).map((t) => t.aiKind)).toEqual(['claude', 'codex']);
  });

  it('hand_off_seat: 이 턴을 마치면 넘어간다고 답하고, 그 턴은 마무리 도구를 쓰고, 끝난 뒤 새 세대가 된다 — 교체 중의 다른 요청은 거부된다', async () => {
    const e = (env = await boot(10_000));
    const turnId = await startMainTurn(e, 'Codex에게 메인을 넘겨');
    const r = await e.tool(turnId, 'hand_off_seat', { to: 'codex', reason: '대표 명령: Codex에게 메인을 넘김', note: '진행 중인 지시는 없습니다' });
    expect(r).toEqual({ ok: true, data: { generation: 2, to: 'Codex CLI', sameGeneration: false, message: '이 턴을 마치면 넘어갑니다. 남길 말은 journal_write로 적으세요' } });
    expect(e.core.seat.view().state).toBe('switching');
    // 넘기는 턴은 그 턴 안에서 마무리 도구를 쓸 수 있다 (상태를 바꾸는 도구도)
    expect((await e.tool(turnId, 'write_memory', { content: '# 일반\n- Codex에게 넘김' })).ok).toBe(true);
    // 교체 중의 다른 요청은 까닭과 함께 거부된다
    const again = await e.tool(turnId, 'hand_off_seat', { to: 'claude', reason: '되돌리기' });
    expect(again).toEqual({ ok: false, code: 'conflict', message: '메인 자리를 Codex CLI에게 넘기는 중입니다(세대 1 → 2) — 교체가 끝난 뒤에 다시 하세요' });
    expect(e.core.seat.view().generation).toBe(2);
    e.liveProc(KEY, MAIN_AGENT_ID)!.finishOk();
    await e.core.seat.settled();
    expect(e.core.seat.view()).toMatchObject({ generation: 2, state: 'active', holder: { label: 'Codex CLI' } });
    expect(e.core.seat.history()[0]).toMatchObject({ generation: 2, changedBy: 'main' });
    const start = e.ctx.store.activity.search({ kinds: ['seat'], limit: 50 }).find((x) => x.text.startsWith('메인 자리 교체 시작'));
    expect([start!.actor, start!.text]).toEqual([MAIN_AGENT_ID, '메인 자리 교체 시작: Claude CLI → Codex CLI (세대 1 → 2, 메인 에이전트가 넘김) — 대표 명령: Codex에게 메인을 넘김 / 남긴 말: 진행 중인 지시는 없습니다']);
    expect(await e.tool(turnId, 'write_memory', { content: '늦은 요청' })).toMatchObject({ ok: false, code: 'seat_changed' });
  });

  it('데스크톱 운영 설정으로 메인 AI 종류를 바꾸면(S4-9) 운영자 교체다 — 실행 중에는 M-MAIN의 AI를 덮어쓰지 않고, 그 턴이 끝난 뒤 바뀐다', async () => {
    const e = (env = await boot(10_000));
    await startMainTurn(e);
    // 뒤따르는 인계 메모 턴(S4b)의 가짜 프로세스는 곧바로 끝난다 — 지금 턴은 이미 떠 있어 그대로 산다
    e.hold.delete(KEY);
    const s = await e.invoke('settings.update', { general: { mainAgent: CODEX } });
    expect(s.general.mainAgent).toEqual(CODEX);
    expect(e.core.seat.view()).toMatchObject({ generation: 2, state: 'switching', pendingHolder: { label: 'Codex CLI' } });
    // 설정은 바뀌었지만 실행 중인 메인의 AI는 그대로 — 시작 때의 맞추기(ensureMainAgent)도 자리 보유자를 따른다
    expect(e.ctx.store.members.require(MAIN_AGENT_ID).ai.kind).toBe('claude');
    expect(e.core.team.ensureMainAgent().ai.kind).toBe('claude');
    e.liveProc(KEY, MAIN_AGENT_ID)!.finishOk();
    await e.core.seat.settled();
    expect(e.ctx.store.members.require(MAIN_AGENT_ID).ai).toEqual(CODEX);
    expect(e.core.seat.history()[0]).toMatchObject({ generation: 2, changedBy: 'operator' });
  });

  it('같은 종류에서 모델·노력치만 바꾸면 세대 그대로 실행 중인 턴은 그대로, 다음 턴부터 새 값이다 (hand_off_seat)', async () => {
    const e = (env = await boot(10_000));
    const turnId = await startMainTurn(e);
    const r = await e.tool(turnId, 'hand_off_seat', { to: 'claude', model: 'opus', effort: 'max', reason: '어려운 설계라 높임' });
    expect(r).toEqual({ ok: true, data: { generation: 1, to: 'Claude CLI', sameGeneration: true, message: '보유자는 그대로 Claude CLI이고 모델·노력치만 바꿨습니다. 세대 1 그대로, 다음 턴부터 적용됩니다' } });
    expect(e.core.seat.view()).toMatchObject({ generation: 1, state: 'active', holder: { ai: { kind: 'claude', model: 'opus', effortOverride: 'max' } } });
    expect(e.ctx.store.members.require(MAIN_AGENT_ID).ai).toMatchObject({ model: 'opus', effortOverride: 'max' });
    // 이 턴의 토큰은 그대로 쓴다 (세대가 같다)
    expect((await e.tool(turnId, 'read_memory', {})).ok).toBe(true);
    expect(e.ctx.store.sessions.list({ ref1: MAIN_AGENT_ID, state: 'open' })).toHaveLength(1);
    expect(e.core.seat.history()).toHaveLength(1);
    expect(notices(e, '메인 에이전트가 바뀌었습니다')).toEqual([]);
  });
});
