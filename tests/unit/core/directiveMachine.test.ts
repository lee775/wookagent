/**
 * 지시 상태 전이 — 기획서 5.3 지시 상태표, 전이표(확인 대기 지시 수정 요청, 미종료 지시 취소), FBK-03, AC-06·22.
 */
import { describe, expect, it } from 'vitest';
import type { Directive, DirectiveState, FinalResult } from '@shared/domain';
import { applyDirectiveEvent, canApplyDirective, isDirectiveOpen, type DirectiveEvent } from '@core/directiveMachine';
import { TransitionError } from '@core/taskMachine';
import { AT, DIRECTIVE_STATES, makeDirective, T0 } from './fixtures';

const apply = (d: Directive, ev: DirectiveEvent) => applyDirectiveEvent(d, ev, AT, 'owner');

const RESULT: FinalResult = {
  round: 1,
  summary: '로그인 완료',
  outputs: [],
  changedFiles: ['src/login.ts'],
  issues: [],
  nextSteps: [],
  submittedAt: T0,
  by: 'M-PD',
};

const SAMPLE: Record<DirectiveEvent['type'], DirectiveEvent> = {
  plan: { type: 'plan' },
  start: { type: 'start' },
  replan: { type: 'replan' },
  final_result: { type: 'final_result', result: RESULT },
  supplement: { type: 'supplement' },
  report_submitted: { type: 'report_submitted', reportId: 'R-0001' },
  approve: { type: 'approve' },
  request_changes: { type: 'request_changes', text: '버튼 색을 바꿔 주세요', anchored: [{ quote: '요약', comment: '더 짧게' }] },
  cancel: { type: 'cancel', reason: '대표 취소' },
};
const EVENT_TYPES = Object.keys(SAMPLE) as DirectiveEvent['type'][];

/** 기획서 5.3 지시 상태표 '다음 상태' 열 → (이벤트, 다음 상태) */
const SPEC: Record<DirectiveState, Partial<Record<DirectiveEvent['type'], DirectiveState>>> = {
  received: { plan: 'planning', cancel: 'cancelled' }, // 접수 → 계획, 취소
  planning: { start: 'in_progress', final_result: 'reporting', cancel: 'cancelled' }, // 계획 → 진행, 보고(직접 처리로 산출물 확정), 취소
  in_progress: { final_result: 'reporting', replan: 'planning', cancel: 'cancelled' }, // 진행 → 보고, 계획(재계획), 취소
  reporting: { report_submitted: 'awaiting_confirmation', supplement: 'in_progress', cancel: 'cancelled' }, // 보고 → 확인 대기, 진행(보완 작업), 취소
  awaiting_confirmation: { approve: 'closed', request_changes: 'planning', cancel: 'cancelled' }, // 확인 대기 → 종료, 계획(다음 회차), 취소
  closed: {}, // 없음
  cancelled: {}, // 없음
};

const SPEC_NEXT: Record<DirectiveState, DirectiveState[]> = {
  received: ['planning', 'cancelled'],
  planning: ['in_progress', 'reporting', 'cancelled'],
  in_progress: ['reporting', 'planning', 'cancelled'],
  reporting: ['awaiting_confirmation', 'in_progress', 'cancelled'],
  awaiting_confirmation: ['closed', 'planning', 'cancelled'],
  closed: [],
  cancelled: [],
};

describe('5.3 지시 상태표 × 이벤트 전수', () => {
  const cases = DIRECTIVE_STATES.flatMap((s) => EVENT_TYPES.map((e) => ({ s, e, to: SPEC[s][e] ?? null })));

  it.each(cases)('$s + $e → $to', ({ s, e, to }) => {
    const d = makeDirective({ state: s });
    expect(canApplyDirective(d, e)).toBe(to !== null);
    if (to === null) {
      let caught: unknown = null;
      try {
        apply(d, SAMPLE[e]);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(TransitionError);
      expect(caught).toMatchObject({ entity: 'directive', entityId: 'D-0001', from: s, event: e });
      return;
    }
    const r = apply(d, SAMPLE[e]);
    expect(r).toMatchObject({ from: s, to, event: e });
    expect(r.directive.state).toBe(to);
    expect(r.directive.updatedAt).toBe(AT);
  });

  it.each(DIRECTIVE_STATES)('%s 에서 갈 수 있는 상태 집합 = 상태표 다음 상태 열', (s) => {
    const reached = EVENT_TYPES.filter((e) => canApplyDirective(makeDirective({ state: s }), e)).map(
      (e) => apply(makeDirective({ state: s }), SAMPLE[e]).to,
    );
    expect(new Set(reached)).toEqual(new Set(SPEC_NEXT[s]));
  });

  it('종료·취소만 닫힌 지시', () => {
    expect(DIRECTIVE_STATES.filter((s) => !isDirectiveOpen(makeDirective({ state: s })))).toEqual(['closed', 'cancelled']);
  });
});

describe('FBK-03 수정 요청 → 같은 지시 회차 +1, 확인 대기 → 계획 (AC-22)', () => {
  const awaiting = () =>
    makeDirective({
      state: 'awaiting_confirmation',
      finalResult: RESULT,
      rounds: [{ round: 1, requestedAt: T0, text: '로그인 기능을 만들어 줘', anchored: [], reportId: 'R-0001' }],
    });

  it('회차 +1, 상태 계획, 새 회차 기록(코멘트 포함), 이전 회차·보고서 기록 유지', () => {
    const before = awaiting();
    const r = apply(before, SAMPLE.request_changes);
    expect(r.from).toBe('awaiting_confirmation');
    expect(r.to).toBe('planning');
    expect(r.directive.id).toBe('D-0001');
    expect(r.directive.round).toBe(2);
    expect(r.directive.rounds).toEqual([
      { round: 1, requestedAt: T0, text: '로그인 기능을 만들어 줘', anchored: [], reportId: 'R-0001' },
      { round: 2, requestedAt: AT, text: '버튼 색을 바꿔 주세요', anchored: [{ quote: '요약', comment: '더 짧게' }], reportId: null },
    ]);
    // 새 회차는 새 최종 결과를 받는다
    expect(r.directive.finalResult).toBeNull();
    // 입력은 그대로 (이전 회차 덮어쓰지 않음)
    expect(before.round).toBe(1);
    expect(before.rounds).toHaveLength(1);
    expect(before.rounds[0]!.reportId).toBe('R-0001');
  });

  it('두 번 수정 요청 → 3회차, 회차별 보고서 연결은 각 회차에만', () => {
    let d = apply(awaiting(), SAMPLE.request_changes).directive;
    d = apply(d, SAMPLE.start).directive;
    d = apply(d, { type: 'final_result', result: { ...RESULT, round: 2 } }).directive;
    d = apply(d, { type: 'report_submitted', reportId: 'R-0002' }).directive;
    d = apply(d, { type: 'request_changes', text: '한 번 더', anchored: [] }).directive;
    expect(d.round).toBe(3);
    expect(d.rounds.map((x) => [x.round, x.reportId])).toEqual([
      [1, 'R-0001'],
      [2, 'R-0002'],
      [3, null],
    ]);
  });
});

describe('지시 흐름 (AC-06, 6.3)', () => {
  it('접수 → 계획 → 진행 → 보고 → 확인 대기 → 종료', () => {
    let d = makeDirective();
    const path: DirectiveState[] = [d.state];
    for (const ev of [SAMPLE.plan, SAMPLE.start, SAMPLE.final_result, SAMPLE.report_submitted, SAMPLE.approve]) {
      d = apply(d, ev).directive;
      path.push(d.state);
    }
    expect(path).toEqual(['received', 'planning', 'in_progress', 'reporting', 'awaiting_confirmation', 'closed']);
    expect(d.closedAt).toBe(AT);
    expect(d.finalResult).toEqual(RESULT);
    expect(d.rounds[0]!.reportId).toBe('R-0001');
  });

  it('계획 → 보고: 직접 처리로 산출물 확정', () => {
    const r = apply(makeDirective({ state: 'planning' }), SAMPLE.final_result);
    expect(r.to).toBe('reporting');
    expect(r.directive.finalResult).toEqual(RESULT);
  });

  it('보고 → 진행(보완 작업) → 보고', () => {
    let d = apply(makeDirective({ state: 'reporting', finalResult: RESULT }), SAMPLE.supplement).directive;
    expect(d.state).toBe('in_progress');
    d = apply(d, SAMPLE.final_result).directive;
    expect(d.state).toBe('reporting');
  });

  it.each(['received', 'planning', 'in_progress', 'reporting', 'awaiting_confirmation'] as const)('미종료 지시(%s) | 대표의 취소 → 취소', (s) => {
    const r = apply(makeDirective({ state: s }), SAMPLE.cancel);
    expect(r.to).toBe('cancelled');
    expect(r.directive.cancelledAt).toBe(AT);
    expect(isDirectiveOpen(r.directive)).toBe(false);
  });
});
