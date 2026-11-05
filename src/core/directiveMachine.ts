/**
 * 지시 상태 전이 (기획서 5.3 지시 상태표, FBK-03, TSK-09).
 */
import type { Actor, AnchoredComment, Directive, DirectiveState, FinalResult, IsoTime } from '@shared/domain';
import { TransitionError } from './taskMachine';

export type DirectiveEvent =
  /** 접수 → 계획: 프로듀서에게 전달 */
  | { type: 'plan' }
  /** 계획 → 진행: 하위 작업이 생겨 진행 시작 */
  | { type: 'start' }
  /** 진행 → 계획: 재계획 */
  | { type: 'replan' }
  /** 계획(직접 처리)·진행 → 보고: 프로듀서 최종 결과 제출 */
  | { type: 'final_result'; result: FinalResult }
  /** 보고 → 진행: 보완 작업 */
  | { type: 'supplement' }
  /** 보고 → 확인 대기: 보고서 제출 */
  | { type: 'report_submitted'; reportId: string }
  /** 확인 대기 → 종료: 대표 결과 승인 */
  | { type: 'approve' }
  /** 확인 대기 → 계획: 수정 요청, 회차 +1 (FBK-03) */
  | { type: 'request_changes'; text: string; anchored: AnchoredComment[] }
  /** 미종료 → 취소 */
  | { type: 'cancel'; reason: string };

const ALLOWED: Record<DirectiveState, DirectiveEvent['type'][]> = {
  received: ['plan', 'cancel'],
  planning: ['start', 'final_result', 'cancel'],
  in_progress: ['final_result', 'replan', 'cancel'],
  reporting: ['report_submitted', 'supplement', 'cancel'],
  awaiting_confirmation: ['approve', 'request_changes', 'cancel'],
  closed: [],
  cancelled: [],
};

export interface DirectiveTransition {
  directive: Directive;
  from: DirectiveState;
  to: DirectiveState;
  event: DirectiveEvent['type'];
  note: string;
}

export function canApplyDirective(d: Directive, type: DirectiveEvent['type']): boolean {
  return ALLOWED[d.state].includes(type);
}

export function isDirectiveOpen(d: Directive): boolean {
  return d.state !== 'closed' && d.state !== 'cancelled';
}

export function applyDirectiveEvent(d: Directive, ev: DirectiveEvent, at: IsoTime, _actor: Actor): DirectiveTransition {
  const from = d.state;
  if (!ALLOWED[from].includes(ev.type)) {
    throw new TransitionError('directive', d.id, from, ev.type, `지시 ${d.id} 상태(${from})에서 '${ev.type}' 불가`);
  }
  const next: Directive = { ...d, rounds: d.rounds.map((r) => ({ ...r })), updatedAt: at };
  let note = '';
  switch (ev.type) {
    case 'plan':
      next.state = 'planning';
      note = '프로듀서에게 전달';
      break;
    case 'start':
      next.state = 'in_progress';
      note = '작업 진행 시작';
      break;
    case 'replan':
      next.state = 'planning';
      note = '재계획';
      break;
    case 'final_result':
      next.state = 'reporting';
      next.finalResult = ev.result;
      note = '최종 결과 제출';
      break;
    case 'supplement':
      next.state = 'in_progress';
      note = '보완 작업';
      break;
    case 'report_submitted': {
      next.state = 'awaiting_confirmation';
      const cur = next.rounds.find((r) => r.round === next.round);
      if (cur) cur.reportId = ev.reportId;
      note = `보고서 ${ev.reportId} 제출`;
      break;
    }
    case 'approve':
      next.state = 'closed';
      next.closedAt = at;
      note = '대표 결과 승인';
      break;
    case 'request_changes':
      next.round = d.round + 1;
      next.state = 'planning';
      next.finalResult = null;
      next.rounds.push({ round: next.round, requestedAt: at, text: ev.text, anchored: ev.anchored, reportId: null });
      note = `수정 요청 → ${next.round}회차`;
      break;
    case 'cancel':
      next.state = 'cancelled';
      next.cancelledAt = at;
      note = `취소: ${ev.reason}`;
      break;
    default: {
      const never: never = ev;
      throw new Error(`알 수 없는 지시 이벤트: ${JSON.stringify(never)}`);
    }
  }
  return { directive: next, from, to: next.state, event: ev.type, note };
}
