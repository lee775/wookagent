/**
 * 메인 자리는 하나다 (SERVER_DESIGN 4.3·10.4 seatSingleHolder, 리드 결정 S4-2): 자리를 바꾸는 곳은 SeatService.assign 하나이고, 같은 차례에 들어온 넘기기
 * (메인)·운영자 배정·처음 보유자(서버 초기화) 요청 중 먼저 든 것 하나만 이긴다. 나머지는 까닭을 말하며 거부되고 아무것도 바꾸지 않는다.
 * 어느 순간에도 실행 중인 메인 턴은 하나 이하다 — 새 보유자의 턴은 나가는 턴이 끝난 뒤에야 뜬다
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID, type AiConfig, type Turn } from '@shared/domain';
import { BackendError } from '../../src/main/backend/types';
import type { SeatRequest } from '../../src/main/orchestrator/seat';
import { bootOrch, sleep, waitFor, type OrchEnv } from './orchHarness';

let env: OrchEnv | null = null;
let sampler: NodeJS.Timeout | null = null;
afterEach(async () => {
  if (sampler) clearInterval(sampler);
  sampler = null;
  await env?.close();
  env = null;
});

const CLAUDE: AiConfig = { kind: 'claude', model: null, effortTier: 'high', effortOverride: null };
const CODEX: AiConfig = { kind: 'codex', model: null, effortTier: 'high', effortOverride: null };
const KEY = 'main:general';

/** 결과 → 이겼으면 'ok', 거부면 '코드: 글' */
function outcome(r: PromiseSettledResult<unknown>): string {
  if (r.status === 'rejected') return r.reason instanceof BackendError ? `${r.reason.code}: ${r.reason.message}` : `오류: ${String(r.reason)}`;
  const v = r.value as { ok?: boolean; code?: string; message?: string };
  if (v && typeof v === 'object' && 'ok' in v) return v.ok ? 'ok' : `${v.code}: ${v.message}`;
  return 'ok';
}

/** 메인 턴 기록이 겹치는 곳 (끝난 뒤에 다음이 시작해야 한다) */
function overlaps(turns: Turn[]): string[] {
  const sorted = [...turns].sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1));
  const out: string[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    if (!prev.endedAt || prev.endedAt > sorted[i]!.startedAt) out.push(`${prev.id} ↔ ${sorted[i]!.id}`);
  }
  return out;
}

async function heldMainTurn(e: OrchEnv, text: string): Promise<string> {
  e.hold.add(KEY);
  await e.invoke('command.send', { target: 'main', text });
  e.tick();
  await waitFor(() => !!e.liveProc(KEY, MAIN_AGENT_ID), '메인 턴 시작');
  return e.liveProc(KEY, MAIN_AGENT_ID)!.turnId;
}

describe('메인 자리는 하나다 (seatSingleHolder)', () => {
  it('같은 차례에 온 넘기기·운영자 배정·처음 보유자 요청 중 먼저 든 하나만 이기고, 나머지는 까닭과 함께 거부된다 — 어느 순간에도 메인 턴은 하나 이하', async () => {
    const e = (env = await bootOrch());
    e.core.seat.applyOperatorConfig({ holders: null, drainMs: 30_000, initialHolder: null }, '시험');
    let most = 0;
    sampler = setInterval(() => {
      most = Math.max(most, e.core.turns.running().filter((r) => r.memberId === MAIN_AGENT_ID).length);
    }, 1);
    const operator = (ai: AiConfig): SeatRequest => ({ holder: { kind: 'launched', ai }, by: 'operator', reason: '운영자 복구 배정' });
    const initial = (ai: AiConfig): SeatRequest => ({ holder: { kind: 'launched', ai }, by: 'server', reason: '처음 보유자', initial: true });

    // 1차례: 메인의 넘기기가 먼저 든다
    const t1 = await heldMainTurn(e, 'Codex에게 메인을 넘겨');
    const round1 = await Promise.allSettled([
      e.tool(t1, 'hand_off_seat', { to: 'codex', reason: '대표 명령' }),
      Promise.resolve().then(() => e.core.seat.assign(operator(CODEX))),
      Promise.resolve().then(() => e.core.seat.assign(initial(CLAUDE))),
    ]);
    expect(round1.map(outcome)).toEqual([
      'ok',
      'conflict: 메인 자리를 Codex CLI에게 넘기는 중입니다(세대 1 → 2) — 교체가 끝난 뒤에 다시 하세요',
      'conflict: 메인 자리를 Codex CLI에게 넘기는 중입니다(세대 1 → 2) — 교체가 끝난 뒤에 다시 하세요',
    ]);
    expect(e.core.seat.view()).toMatchObject({ generation: 2, state: 'switching' });
    expect(e.core.seat.history().map((h) => [h.generation, h.changedBy])).toEqual([
      [2, 'main'],
      [1, 'server'],
    ]);
    e.liveProc(KEY, MAIN_AGENT_ID)!.finishOk();
    await e.core.seat.settled();
    expect(e.core.seat.view()).toMatchObject({ generation: 2, state: 'active', holder: { label: 'Codex CLI' } });

    // 2차례: 운영자 배정이 먼저 든다 — 실행 중인 메인(새 보유자)의 넘기기는 거부된다
    const t2 = await heldMainTurn(e, '다음 명령');
    const round2 = await Promise.allSettled([
      Promise.resolve().then(() => e.core.seat.assign(operator(CLAUDE))),
      Promise.resolve().then(() => e.tool(t2, 'hand_off_seat', { to: 'claude', reason: '대표 명령' })),
      Promise.resolve().then(() => e.core.seat.assign(initial(CODEX))),
    ]);
    expect(round2.map(outcome)).toEqual([
      'ok',
      'conflict: 메인 자리를 Claude CLI에게 넘기는 중입니다(세대 2 → 3) — 교체가 끝난 뒤에 다시 하세요',
      'conflict: 메인 자리를 Claude CLI에게 넘기는 중입니다(세대 2 → 3) — 교체가 끝난 뒤에 다시 하세요',
    ]);
    // 운영자 교체는 나가는 보유자에게 인계 메모 턴을 준다(4.3 3번, S4b) — 그 가짜 프로세스는 곧바로 끝나게 둔다
    e.hold.delete(KEY);
    e.liveProc(KEY, MAIN_AGENT_ID)!.finishOk();
    await e.core.seat.settled();
    expect(e.core.seat.view()).toMatchObject({ generation: 3, state: 'active', holder: { label: 'Claude CLI' } });
    expect(e.core.seat.history().map((h) => [h.generation, h.changedBy])).toEqual([
      [3, 'operator'],
      [2, 'main'],
      [1, 'server'],
    ]);

    // 앉은 자리에는 처음 보유자가 들지 않는다
    expect(() => e.core.seat.assign(initial(CODEX))).toThrow('메인 자리에 이미 Claude CLI가 앉아 있습니다(세대 3) — 처음 보유자는 자리가 비었을 때만 씁니다');

    // 새 보유자의 턴은 나가는 턴이 끝난 뒤에만 떴다
    e.hold.clear();
    await e.invoke('command.send', { target: 'main', text: '세 번째 명령' });
    await e.drain(1);
    const turns = e.ctx.store.turns.list({ ref1: MAIN_AGENT_ID });
    // 둘째 codex 턴은 운영자 교체의 인계 메모 턴(나가는 Codex CLI, S4b)이다 — 그것도 앞 턴이 끝난 뒤에, 겹치지 않게 떴다
    expect(turns.map((t) => t.aiKind)).toEqual(['claude', 'codex', 'codex', 'claude']);
    expect(overlaps(turns)).toEqual([]);
    expect(most).toBe(1);
  });

  it('빈 자리에 같은 차례로 온 처음 보유자 요청은 하나만 앉고, 나머지는 거부된다', async () => {
    const e = (env = await bootOrch());
    // 자리를 비운다 (앱이 아직 보유자를 앉히기 전과 같은 상태)
    const row = e.ctx.store.seat.get('main')!;
    e.ctx.store.seat.put({ ...row, state: 'vacant', holder: null, since: null });
    expect(e.core.seat.runsMain()).toBe(false);
    // 빈 자리에는 M-MAIN 일을 띄우지 않는다 — 대표 명령은 쌓인다
    await e.invoke('command.send', { target: 'main', text: '자리가 비었을 때 온 명령' });
    e.tick();
    await sleep(80);
    expect(e.launches.filter((l) => l.memberId === MAIN_AGENT_ID)).toEqual([]);
    const results = await Promise.allSettled([
      Promise.resolve().then(() => e.core.seat.assign({ holder: { kind: 'launched', ai: CODEX }, by: 'server', reason: '처음 보유자 A', initial: true })),
      Promise.resolve().then(() => e.core.seat.assign({ holder: { kind: 'launched', ai: CLAUDE }, by: 'server', reason: '처음 보유자 B', initial: true })),
    ]);
    expect(results.map(outcome)).toEqual(['ok', 'conflict: 메인 자리에 이미 Codex CLI가 앉아 있습니다(세대 2) — 처음 보유자는 자리가 비었을 때만 씁니다']);
    expect(e.core.seat.view()).toMatchObject({ generation: 2, state: 'active', holder: { label: 'Codex CLI' } });
    expect(e.ctx.store.members.require(MAIN_AGENT_ID).ai).toEqual(CODEX);
    // 앉은 보유자가 쌓인 명령을 처리한다
    await e.drain(1);
    expect(e.ctx.store.turns.list({ ref1: MAIN_AGENT_ID }).map((t) => t.aiKind)).toEqual(['codex']);
  });
});
