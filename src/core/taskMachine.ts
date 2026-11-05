/**
 * 작업 상태 전이 (기획서 5.3 작업 상태표·전이표, REV-04, TSK-03).
 * 순수 함수: 새 Task 객체와 전이 기록을 돌려준다. 저장·부수 효과는 호출자가 한다.
 */
import type { Actor, HoldReason, HoldReasonKind, IsoTime, ReviewTarget, Task, TaskState } from '@shared/domain';

/** 현재 검수 차수에서 이 횟수째 반려면 보류(재계획) (REV-04) */
export const REJECT_LIMIT = 3;

/** 취소 처리 중 보류(`interrupted`)의 refId — 대표·프로듀서가 고른 취소가 재시작 뒤에도 이어지게 표시 (CTL-08) */
export const CANCEL_HOLD_REF = 'cancel';

export type TaskEvent =
  /** 대기 → 진행: 선행 작업 완료·실행 자리·담당 팀원 차례 확보 */
  | { type: 'activate' }
  /** 진행 → 검수: 작업자 턴 종료 + 자동 검사 통과 + 대상 버전 고정 */
  | { type: 'submit'; target: ReviewTarget }
  /** 검수 → 검수: 기준 main 변경 등으로 대상 버전을 다시 고정 (반려 아님, REV-07) */
  | { type: 'repin'; target: ReviewTarget }
  /** 검수 통과 기록 (상태는 검수 유지 — 병합·확정 대기) */
  | { type: 'review_pass'; reviewId: string; reviewerId: string; target: ReviewTarget }
  /** 검수 → 진행 (1·2번째) / 보류(재계획) (3번째) */
  | { type: 'reject'; reason: string }
  /** 검수 → 진행: 버전이 달라져 재작업 필요 (충돌·미반영 변경). 반려 횟수에 넣지 않음 */
  | { type: 'reopen'; reason: string }
  /** 검수 → 완료: 병합 또는 산출물 확정 */
  | { type: 'complete' }
  /** 대기·진행·검수 → 보류 (이미 보류면 사유만 추가) */
  | { type: 'hold'; reason: HoldReason; returnState?: TaskState }
  /** 보류 사유 해제. 남은 사유가 없으면 저장한 복귀 상태로 */
  | { type: 'release'; match: (r: HoldReason) => boolean; note: string }
  /** 보류 중 작업 내용·검수 기준 변경 → 복귀 상태를 진행으로 */
  | { type: 'basis_changed'; note: string }
  /** 재계획 완료: 재계획 사유 해제 + 새 검수 차수 (REV-04) */
  | { type: 'replanned'; note: string }
  /** 재배정: 활성 표시 해제 (새 담당은 다시 활성화) */
  | { type: 'reassign'; assigneeId: string }
  /** 미완료 → 취소 */
  | { type: 'cancel'; reason: string };

export interface TaskTransition {
  task: Task;
  from: TaskState;
  to: TaskState;
  event: TaskEvent['type'];
  note: string;
}

export class TransitionError extends Error {
  constructor(
    public readonly entity: 'task' | 'directive',
    public readonly entityId: string,
    public readonly from: string,
    public readonly event: string,
    message: string,
  ) {
    super(message);
    this.name = 'TransitionError';
  }
}

const TERMINAL: readonly TaskState[] = ['done', 'cancelled'];

export function isTerminal(state: TaskState): boolean {
  return TERMINAL.includes(state);
}

/** 활성 일반 작업 여부 (5.7: 기존 작업이 완료·취소·재배정되기 전에는 다음 작업을 시작하지 않음) */
export function isActiveTask(task: Task): boolean {
  return task.activatedAt !== null && !isTerminal(task.state);
}

function fail(task: Task, ev: TaskEvent, why: string): never {
  throw new TransitionError('task', task.id, task.state, ev.type, `작업 ${task.id} 상태(${task.state})에서 '${ev.type}' 불가: ${why}`);
}

function sameReason(a: HoldReason, b: HoldReason): boolean {
  return a.kind === b.kind && a.scope === b.scope && a.refId === b.refId;
}

export function hasHold(task: Task, kind: HoldReasonKind, pred?: (r: HoldReason) => boolean): boolean {
  return task.hold.reasons.some((r) => r.kind === kind && (!pred || pred(r)));
}

/** 진척이 있었다 — 진척 없는 자동 재개 수·비정상 종료 재시도 수를 다시 센다 (CLI-18, 8장 헛돌기·자동 복구) */
function resetRetries(next: Task): void {
  next.noProgressResumes = 0;
  next.crashRetries = 0;
}

export function applyTaskEvent(task: Task, ev: TaskEvent, at: IsoTime, _actor: Actor): TaskTransition {
  const from = task.state;
  const next: Task = {
    ...task,
    hold: { reasons: [...task.hold.reasons], returnState: task.hold.returnState },
    review: { ...task.review },
    updatedAt: at,
  };
  let note = '';

  switch (ev.type) {
    case 'activate': {
      if (from !== 'waiting') fail(task, ev, '대기 상태에서만 시작할 수 있습니다');
      next.state = 'in_progress';
      if (!next.activatedAt) next.activatedAt = at;
      note = '작업 시작';
      break;
    }
    case 'submit': {
      if (from !== 'in_progress') fail(task, ev, '진행 상태에서만 검수로 넘길 수 있습니다');
      next.state = 'in_review';
      next.review.target = ev.target;
      next.review.passed = null;
      next.pendingSubmit = null;
      // 검사를 거쳐 검수 대상이 된 버전은 진척이다 — 자동 재개·재시도 수와 이어진 제출 거부 수를 다시 센다 (CLI-18, ERR-04). 반려 뒤 재작업 턴이
      // 제출 전의 쉬는 턴에 이어 세어져 헛돌기로 보류되지 않게. 제출 요청만으로는 세지 않는다 — 대상을 고정하지 못한 제출(검사 실패 등)은 진척이 아니다
      resetRetries(next);
      if (next.checkFailStreak) next.checkFailStreak = 0;
      note = '자동 검사 통과, 검수 대상 고정';
      break;
    }
    case 'repin': {
      if (from !== 'in_review') fail(task, ev, '검수 상태에서만 대상을 다시 고정할 수 있습니다');
      next.review.target = ev.target;
      next.review.passed = null;
      // 다시 고정한 버전도 고정과 같다 (submit)
      resetRetries(next);
      if (next.checkFailStreak) next.checkFailStreak = 0;
      note = '검수 대상 버전 재고정 (재검수, 반려 아님)';
      break;
    }
    case 'review_pass': {
      if (from !== 'in_review') fail(task, ev, '검수 상태가 아닙니다');
      // 통과는 지금 고정된 대상에만 묶는다 — 이전 대상의 통과로 다른 버전이 완료되지 않게 (REV-07)
      if (!sameTarget(ev.target, task.review.target)) fail(task, ev, '고정된 검수 대상과 다른 버전의 통과입니다 (REV-07)');
      next.review.passed = { reviewId: ev.reviewId, reviewerId: ev.reviewerId, at, target: ev.target };
      // 통과는 지금 조건 모두를 판정했다(바뀐 조건은 같은 글로 — submitReview) — 쌓아 둔 바뀐 조건을 비운다. 조건 변경은 고정 대상을 지우므로
      // 이 통과의 대상은 마지막 조건 변경 뒤에 고정됐다 (REV-03, reviewRules.changedCriteria)
      if (next.changedCriteria?.length) next.changedCriteria = [];
      // 판정을 받은 버전도 진척이다 (고정 때 이미 다시 셌다 — 판정 기록 때도 같게)
      resetRetries(next);
      note = '검수 통과';
      break;
    }
    case 'reject': {
      if (from !== 'in_review') fail(task, ev, '검수 상태가 아닙니다');
      next.review.rejectsInRound = task.review.rejectsInRound + 1;
      next.review.rejectsTotal = task.review.rejectsTotal + 1;
      next.review.target = null;
      next.review.passed = null;
      // 반려 뒤 재작업은 새로 센다 — 판정을 받은 버전이 있었으니 그 앞의 쉬는 턴에 잇지 않는다 (CLI-18). 반려 상한은 따로 (REV-04)
      resetRetries(next);
      if (next.review.rejectsInRound >= REJECT_LIMIT) {
        next.state = 'on_hold';
        next.hold.returnState = 'in_progress';
        next.hold.reasons.push({
          kind: 'replan',
          scope: 'task',
          refId: null,
          note: `현재 검수 차수 ${REJECT_LIMIT}회 반려: ${ev.reason}`,
          since: at,
          by: 'system',
        });
        note = `${REJECT_LIMIT}번째 반려 → 보류(재계획)`;
      } else {
        next.state = 'in_progress';
        note = `반려 ${next.review.rejectsInRound}/${REJECT_LIMIT}`;
      }
      break;
    }
    case 'reopen': {
      if (from !== 'in_review') fail(task, ev, '검수 상태가 아닙니다');
      next.state = 'in_progress';
      next.review.target = null;
      next.review.passed = null;
      note = ev.reason;
      break;
    }
    case 'complete': {
      if (from !== 'in_review') fail(task, ev, '검수 상태에서만 완료할 수 있습니다');
      if (!task.review.passed) fail(task, ev, '검수 통과 기록이 없습니다');
      if (!sameTarget(task.review.passed.target, task.review.target)) fail(task, ev, '통과 기록이 현재 검수 대상과 다릅니다 (REV-07)');
      next.state = 'done';
      next.completedAt = at;
      next.pendingSubmit = null;
      note = '완료';
      break;
    }
    case 'hold': {
      if (isTerminal(from)) fail(task, ev, '끝난 작업은 보류할 수 없습니다');
      // 복귀 상태는 대기·진행·검수만 (5.3: 보류 → 대기·진행·검수·취소). 다른 값은 해제 때 상태표 밖 전이·사유 없는 보류를 만든다
      const rs = from === 'on_hold' ? ev.returnState : (ev.returnState ?? from);
      if (rs !== undefined && rs !== 'waiting' && rs !== 'in_progress' && rs !== 'in_review') fail(task, ev, `복귀 상태는 대기·진행·검수만 가능합니다 (${rs})`);
      if (rs === 'in_review' && !task.review.target) fail(task, ev, '검수 대상이 고정되지 않아 검수로 복귀할 수 없습니다');
      if (!next.hold.reasons.some((r) => sameReason(r, ev.reason))) next.hold.reasons.push(ev.reason);
      if (from !== 'on_hold') {
        next.state = 'on_hold';
        next.hold.returnState = ev.returnState ?? from;
      } else if (ev.returnState) {
        next.hold.returnState = ev.returnState;
      }
      note = `보류: ${ev.reason.kind}${ev.reason.note ? ` (${ev.reason.note})` : ''}`;
      break;
    }
    case 'release': {
      if (from !== 'on_hold') fail(task, ev, '보류 상태가 아닙니다');
      // 재계획 사유는 새 검수 차수를 여는 replanned로만 푼다 — 일반 해제는 차수 반려 횟수를 그대로 둔다 (REV-04)
      if (task.hold.reasons.some((r) => r.kind === 'replan' && ev.match(r))) fail(task, ev, '재계획 사유는 재계획 완료(replanned)로만 해제합니다 (REV-04)');
      const before = next.hold.reasons.length;
      next.hold.reasons = next.hold.reasons.filter((r) => !ev.match(r));
      if (next.hold.reasons.length === before) fail(task, ev, '해제할 보류 사유가 없습니다');
      if (next.hold.reasons.length === 0) {
        next.state = next.hold.returnState ?? 'in_progress';
        next.hold.returnState = null;
        note = `보류 해제 → ${next.state} (${ev.note})`;
      } else {
        note = `보류 사유 일부 해제 (${ev.note}), 남은 사유 ${next.hold.reasons.length}개`;
      }
      break;
    }
    case 'basis_changed': {
      if (from !== 'on_hold') fail(task, ev, '보류 상태가 아닙니다');
      if (next.hold.returnState === 'in_review' || next.hold.returnState === 'waiting') {
        // 대기 복귀는 아직 시작 전이라 내용 변경과 무관
        if (next.hold.returnState === 'in_review') {
          next.hold.returnState = 'in_progress';
          next.review.target = null;
          next.review.passed = null;
        }
      }
      note = `보류 중 기준 변경: ${ev.note}`;
      break;
    }
    case 'replanned': {
      if (from !== 'on_hold' || !hasHold(task, 'replan')) fail(task, ev, '재계획 보류 상태가 아닙니다');
      next.hold.reasons = next.hold.reasons.filter((r) => r.kind !== 'replan');
      next.review.round = task.review.round + 1;
      next.review.rejectsInRound = 0;
      next.review.target = null;
      next.review.passed = null;
      resetRetries(next);
      if (next.checkFailStreak) next.checkFailStreak = 0;
      // 남은 충돌의 해결 못 한 턴 수도 다시 센다 (새 방법·새 담당에게 3번). 헛돌기 횟수는 그대로 — 같은 충돌의 두 번째 헛돌기는 대표 보고 (GIT-07)
      if (next.conflict) next.conflict = { ...next.conflict, unresolvedTurns: 0 };
      // 재계획 후에는 다시 작업부터 (전이표: 보류(재계획) → 진행)
      next.hold.returnState = task.activatedAt ? 'in_progress' : 'waiting';
      if (next.hold.reasons.length === 0) {
        next.state = next.hold.returnState;
        next.hold.returnState = null;
      }
      note = `재계획 완료, 검수 ${next.review.round}차 시작 (${ev.note})`;
      break;
    }
    case 'reassign': {
      // 전이표에 진행→대기가 없으므로 진행·검수 중이면 호출자가 먼저 보류시킨 뒤 재배정한다 (보류→대기는 허용)
      if (from !== 'waiting' && from !== 'on_hold') fail(task, ev, '대기 또는 보류 상태에서만 재배정할 수 있습니다');
      const prev = task.assigneeId;
      next.assigneeId = ev.assigneeId;
      next.activatedAt = null;
      next.review.target = null;
      next.review.passed = null;
      if (from === 'on_hold') {
        // 9장: 중단 보류는 명시적 재개·재배정으로 다시 시작. 이전 담당의 막힘 보고와 그 팀원에게 건 정지는 새 담당 작업에 남기지 않는다
        const handedOver = prev !== ev.assigneeId;
        next.hold.reasons = next.hold.reasons.filter(
          (r) => r.kind !== 'interrupted' && !(handedOver && (r.kind === 'blocked' || (r.kind === 'paused' && r.scope === 'member' && r.refId === prev))),
        );
        if (next.hold.reasons.length === 0) {
          next.state = 'waiting';
          next.hold.returnState = null;
        } else next.hold.returnState = 'waiting';
      }
      if (!next.contributors.includes(ev.assigneeId)) next.contributors = [...next.contributors, ev.assigneeId];
      note = `재배정 → ${ev.assigneeId}`;
      break;
    }
    case 'cancel': {
      if (isTerminal(from)) fail(task, ev, '이미 끝난 작업입니다');
      next.state = 'cancelled';
      next.cancelledAt = at;
      next.hold = { reasons: [], returnState: null };
      next.pendingSubmit = null;
      note = `취소: ${ev.reason}`;
      break;
    }
    default: {
      const never: never = ev;
      throw new Error(`알 수 없는 작업 이벤트: ${JSON.stringify(never)}`);
    }
  }

  return { task: next, from, to: next.state, event: ev.type, note };
}

/**
 * 대표가 [재개]로 직접 풀 수 있는 보류 사유 (CTL-10). 나머지는 각자의 해결 경로로만 풀린다.
 * 병합 보류(`merge_blocked`)는 원인(프로젝트 폴더 미커밋 변경·git 오류)이 대표 쪽이라 정리 후 재개로 푼다 —
 * 재개하면 병합 판단부터 다시 하고, 병합 단계가 폴더·HEAD·기준 main을 다시 확인한다
 */
export function isOwnerResumable(r: HoldReason): boolean {
  if (r.kind === 'emergency_stop' || r.kind === 'interrupted' || r.kind === 'error' || r.kind === 'merge_blocked') return true;
  if (r.kind === 'paused' && r.scope === 'task') return true;
  return false;
}

/** 새 작업 기본값 */
export function emptyReviewState(): Task['review'] {
  return {
    round: 1,
    rejectsInRound: 0,
    rejectsTotal: 0,
    target: null,
    passed: null,
    autoCheck: { status: 'not_run', detail: '', at: null },
  };
}

/** 검수 대상이 같은지 (REV-07) */
export function sameTarget(a: ReviewTarget | null, b: ReviewTarget | null): boolean {
  if (!a || !b) return false;
  if (a.kind === 'repo' && b.kind === 'repo') return a.taskCommitSha === b.taskCommitSha && a.baseMainSha === b.baseMainSha;
  if (a.kind === 'artifact' && b.kind === 'artifact') {
    if (a.files.length !== b.files.length) return false;
    const key = (f: { path: string; sha256: string }) => `${f.path}\u0000${f.sha256}`;
    const sa = new Set(a.files.map(key));
    return b.files.every((f) => sa.has(key(f)));
  }
  return false;
}
