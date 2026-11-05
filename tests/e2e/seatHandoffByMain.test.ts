/**
 * 대표가 "메인을 Codex에게 넘겨"라고 명령하면 모의 메인이 hand_off_seat로 넘긴다 (SERVER_DESIGN 4.3·10.4 seatHandoffByMain, 리드 결정 S4-3·S4-4·S4-6):
 * - 모의 메인(실제 프로세스, claude 형식)이 남길 약속을 journal_write로 적고 hand_off_seat를 부른다 — 그 턴이 끝난 뒤에 새 세대(2)가 된다
 * - 메인이 스스로 넘긴 교체에는 따로 인계 메모 턴을 주지 않는다 (넘긴 턴이 남길 말을 적는 턴이다)
 * - 이전 세대의 신원은 도구 처리기가 seat_changed로 거부하고 기록한다 (그 턴의 토큰은 턴이 끝날 때 이미 폐기됐다)
 * - 새 보유자(모의 Codex 메인)의 첫 세션 인계(handoverSummary)와 첫 턴 입력에 인계 꾸러미가 들어 있다 — 이전 메인의 약속은 '확인되지 않은 주장' 칸에
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID, type AgentSession } from '@shared/domain';
import type { TokenIdentity } from '../../src/main/mcp/types';
import type { RunnerFields } from '../../src/main/orchestrator/seat';
import { createHarness, type Harness } from './harness';

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const endedMainTurns = (x: Harness) => x.core.ctx.store.turns.list({ ref1: MAIN_AGENT_ID }).filter((t) => !!t.endedAt);

describe('메인이 자리를 넘긴다 (seatHandoffByMain)', () => {
  it('대표의 "메인을 Codex에게 넘겨" → 모의 메인의 hand_off_seat → 그 턴 뒤 세대 2, 이전 신원은 seat_changed, 새 보유자의 첫 세션에 인계 꾸러미', async () => {
    const x = (h = await createHarness({ noProject: true }));
    const ctx = x.core.ctx;
    await x.invoke('command.send', { target: 'main', text: '메인을 Codex에게 넘겨' });
    await x.waitFor(() => endedMainTurns(x).length === 1 && x.core.seat.view().state === 'active' && x.core.seat.generation() === 2, { label: '넘기는 턴과 교체', timeoutMs: 60_000 });
    await x.core.seat.settled();
    const [first] = ctx.store.turns.list({ ref1: MAIN_AGENT_ID }) as (ReturnType<typeof ctx.store.turns.list>[number] & RunnerFields)[];
    expect([first!.aiKind, first!.seatGeneration, first!.endReason]).toEqual(['claude', 1, 'completed']);
    // 그 턴이 끝난 뒤에 새 세대가 됐다 — 자리 이력의 바꾼 쪽은 메인
    expect(x.snapshot().seat).toMatchObject({ generation: 2, state: 'active', holder: { label: 'Codex CLI' } });
    const history = x.core.seat.history();
    expect(history.map((r) => [r.generation, r.holder.label, r.changedBy, r.hasHandover])).toEqual([
      [2, 'Codex CLI', 'main', true],
      [1, 'Claude CLI', 'server', false],
    ]);
    expect(Date.parse(history[0]!.startedAt)).toBeLessThanOrEqual(Date.parse(first!.endedAt!));
    expect(ctx.store.seatHistory.get('G-0002')!.startReason).toBe('대표 명령: 메인을 Codex에게 넘겨');
    // 메인이 스스로 넘겼으니 따로 인계 메모 턴은 없다
    expect(ctx.store.activity.search({ kinds: ['seat'], limit: 30 }).map((r) => r.text)).toContain(
      '메인 자리 교체 (세대 1 → 2): 인계 메모 턴을 주지 않음 — 메인 에이전트가 스스로 넘겨, 넘긴 턴(hand_off_seat)에서 남길 말을 적었습니다',
    );
    expect(endedMainTurns(x)).toHaveLength(1);
    // 일지: 받은 명령, 메인이 남긴 약속, 넘기기(메인 행동), 교체 시작·끝 (자리)
    const journal = (await x.invoke('journal.list', {})).entries;
    expect(journal.map((j) => [j.author, j.kind, j.generation])).toEqual(
      expect.arrayContaining([
        ['server', 'command', 1],
        ['agent', 'promise', 1],
        ['server', 'action', 1],
        ['server', 'seat', 2],
      ]),
    );
    const promise = journal.find((j) => j.kind === 'promise')!;
    expect(promise).toMatchObject({ holderLabel: 'Claude CLI', promise: { state: 'open', stale: false, needsCheck: false } });
    expect(journal.find((j) => j.kind === 'action')!.text).toBe(
      '메인 자리를 Codex CLI에게 넘기기로 함 (세대 2부터, 이 턴을 마치면 넘어감) — 사유: 대표 명령: 메인을 Codex에게 넘겨 / 남긴 말: 모의 메인 에이전트가 넘깁니다 — 진행 중인 일은 인계 꾸러미를 보세요',
    );

    // 이전 세대의 신원은 처리하지 않고 seat_changed (턴 기록에서 그 신원을 다시 만든다)
    const s1 = ctx.store.sessions.get(first!.sessionId)!;
    const old: TokenIdentity = {
      turnId: first!.id,
      sessionId: s1.id,
      sessionKey: s1.workKey,
      sessionKind: s1.kind,
      memberId: MAIN_AGENT_ID,
      projectId: null,
      isMain: true,
      isProducer: false,
      canReview: false,
      seatGeneration: first!.seatGeneration,
    };
    expect(await x.core.tools.handle(old, 'journal_write', { kind: 'note', text: '늦은 메모' })).toEqual({
      ok: false,
      code: 'seat_changed',
      message: '메인 자리가 바뀌었습니다 (이 턴은 세대 1, 지금은 세대 2) — 이 요청(journal_write)은 처리하지 않았습니다. 지금 턴을 마치세요',
    });
    expect(ctx.store.activity.search({ kinds: ['seat'], limit: 30 }).map((r) => r.text)).toContain('이전 세대(1) 메인 토큰의 도구 요청을 거부함: journal_write — 지금 메인 자리는 세대 2입니다');

    // 새 보유자(모의 Codex)의 첫 세션: 인계 꾸러미가 handoverSummary에 들어 있다
    await x.invoke('command.send', { target: 'main', text: '바뀐 것을 알려 주세요' });
    await x.waitFor(() => endedMainTurns(x).length === 2 && x.core.turns.count() === 0, { label: '새 보유자의 첫 턴', timeoutMs: 60_000 });
    const second = ctx.store.turns.list({ ref1: MAIN_AGENT_ID })[1]! as ReturnType<typeof ctx.store.turns.list>[number] & RunnerFields;
    expect([second.aiKind, second.seatGeneration, second.endReason]).toEqual(['codex', 2, 'completed']);
    const s2 = ctx.store.sessions.get(second.sessionId)! as AgentSession & RunnerFields;
    expect([s2.aiKind, s2.seatGeneration, s2.replaceReason]).toEqual(['codex', 2, '메인 자리 교체(세대 2)']);
    const summary = s2.handoverSummary!;
    expect(summary.startsWith('[메인 자리 인계 꾸러미 — 세대 2,')).toBe(true);
    expect(summary).toContain('## 자리 정보\n이전 보유자: Claude CLI (세대 1');
    expect(summary).toContain('바꾼 쪽: 메인 에이전트');
    expect(summary).toContain('## 이전 메인 에이전트의 메모 (확인되지 않은 주장)');
    expect(summary).toContain(`${promise.id} [세대 1 · Claude CLI ·`);
    expect(summary).toContain('넘기며 남긴 말 (세대 1): 모의 메인 에이전트가 넘깁니다 — 진행 중인 일은 인계 꾸러미를 보세요');
    // 저장된 꾸러미(seat.handover)와 같은 글이고, 대표도 같은 꾸러미를 본다
    expect(summary.startsWith(x.core.handover.storedText(2)!)).toBe(true);
    const viewed = await x.invoke('seat.handover', 2);
    expect(viewed!.sections.map((s) => s.key)).toEqual(['seat', 'facts', 'memos', 'memory']);
    expect(viewed!.chars).toBe(x.core.handover.storedText(2)!.length);
    // 넘기며 남긴 말은 저장된 꾸러미와 함께 남아, 세션을 새로 열 때(MEM-09) 다시 만드는 최신판에도 든다
    expect(x.core.handover.latest(2).text).toContain('넘기며 남긴 말 (세대 1): 모의 메인 에이전트가 넘깁니다 — 진행 중인 일은 인계 꾸러미를 보세요');
  }, 150_000);
});
