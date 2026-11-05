/**
 * 작업 상태 전이 — 기획서 5.3 작업 상태표·전이표, REV-04, REV-07, TSK-03, CTL-10, AC-09·16·46 를 표로 옮긴 테스트.
 */
import { describe, expect, it } from 'vitest';
import type { HoldReason, HoldReasonKind, Task, TaskState } from '@shared/domain';
import {
  applyTaskEvent,
  emptyReviewState,
  hasHold,
  isActiveTask,
  isOwnerResumable,
  isTerminal,
  REJECT_LIMIT,
  sameTarget,
  TransitionError,
  type TaskEvent,
} from '@core/taskMachine';
import { artifactTarget, AT, HOLD_KINDS, reason, repoTarget, T0, TASK_STATES, taskIn } from './fixtures';

const apply = (t: Task, ev: TaskEvent) => applyTaskEvent(t, ev, AT, 'system');
const hold = (r: HoldReason, returnState?: TaskState): TaskEvent => ({ type: 'hold', reason: r, returnState });
const releaseKind = (kind: HoldReasonKind, refId?: string): TaskEvent => ({
  type: 'release',
  match: (r) => r.kind === kind && (refId === undefined || r.refId === refId),
  note: `${kind} 해제`,
});
const submit = (sha: string, base = 'b1'): TaskEvent => ({ type: 'submit', target: repoTarget(sha, base) });
const reject: TaskEvent = { type: 'reject', reason: '완료 조건 미충족' };

/** 기획서 5.3 작업 상태표 '다음 상태' 열 그대로 */
const NEXT_STATES: Record<TaskState, readonly TaskState[]> = {
  waiting: ['in_progress', 'on_hold', 'cancelled'],
  in_progress: ['in_review', 'on_hold', 'cancelled'],
  on_hold: ['waiting', 'in_progress', 'in_review', 'cancelled'],
  in_review: ['done', 'in_progress', 'on_hold', 'cancelled'],
  done: [],
  cancelled: [],
};

/** 이벤트 견본 (상태표 전수 검사용) */
const SAMPLE: Record<TaskEvent['type'], TaskEvent> = {
  activate: { type: 'activate' },
  submit: submit('c2'),
  repin: { type: 'repin', target: repoTarget('c1', 'b2') },
  review_pass: { type: 'review_pass', reviewId: 'RV-0002', reviewerId: 'M-PD', target: repoTarget() },
  reject,
  reopen: { type: 'reopen', reason: '작업 버전 변경' },
  complete: { type: 'complete' },
  hold: hold(reason('interrupted', { note: '대표 중단' })),
  release: releaseKind('interrupted'),
  basis_changed: { type: 'basis_changed', note: '완료 조건 변경' },
  replanned: { type: 'replanned', note: '방법 변경' },
  reassign: { type: 'reassign', assigneeId: 'M-DEV2' },
  cancel: { type: 'cancel', reason: '대표 취소' },
};
const EVENT_TYPES = Object.keys(SAMPLE) as TaskEvent['type'][];

/** 상태별 허용 이벤트 (전이표 + 재배정은 대기·보류에서만) */
const ALLOWED: Record<TaskState, readonly TaskEvent['type'][]> = {
  waiting: ['activate', 'hold', 'reassign', 'cancel'],
  in_progress: ['submit', 'hold', 'cancel'],
  on_hold: ['hold', 'release', 'basis_changed', 'replanned', 'reassign', 'cancel'],
  in_review: ['repin', 'review_pass', 'reject', 'reopen', 'complete', 'hold', 'cancel'],
  done: [],
  cancelled: [],
};

/** 전수 검사용 상태별 작업: 보류는 재계획 + 중단 사유 2개, 검수는 통과 기록까지 있는 모양 */
function matrixTask(s: TaskState): Task {
  if (s === 'on_hold') {
    return taskIn('on_hold', {
      hold: { reasons: [reason('replan'), reason('interrupted', { note: '대표 중단' })], returnState: 'in_progress' },
    });
  }
  return taskIn(s);
}

function expectTransitionError(fn: () => unknown, from: TaskState, event: string): void {
  let caught: unknown = null;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(TransitionError);
  expect(caught).toMatchObject({ entity: 'task', entityId: 'T-0001', from, event });
}

describe('5.3 작업 상태표 × 이벤트 전수', () => {
  const cases = TASK_STATES.flatMap((s) => EVENT_TYPES.map((e) => ({ s, e, allowed: ALLOWED[s].includes(e) })));

  it.each(cases)('$s + $e → 허용=$allowed', ({ s, e, allowed }) => {
    const task = matrixTask(s);
    if (!allowed) {
      expectTransitionError(() => apply(task, SAMPLE[e]), s, e);
      return;
    }
    const r = apply(task, SAMPLE[e]);
    expect(r.from).toBe(s);
    expect(r.event).toBe(e);
    expect(r.to).toBe(r.task.state);
    expect(r.note).not.toBe('');
    // 상태가 바뀌면 반드시 상태표의 '다음 상태' 안 (TSK-03: 5.3의 흐름으로만 바뀐다)
    if (r.to !== s) expect(NEXT_STATES[s]).toContain(r.to);
  });

  it('완료·취소는 끝 상태 (다음 상태 없음)', () => {
    expect(TASK_STATES.filter(isTerminal)).toEqual(['done', 'cancelled']);
  });

  it('입력 작업 객체를 바꾸지 않는다 (순수 함수)', () => {
    for (const s of TASK_STATES) {
      for (const e of ALLOWED[s]) {
        const task = matrixTask(s);
        const before = JSON.parse(JSON.stringify(task));
        apply(task, SAMPLE[e]);
        expect(task).toEqual(before);
      }
    }
  });
});

describe('5.3 전이표 행 그대로', () => {
  const rows: { row: string; task: Task; ev: TaskEvent; to: TaskState; returnState?: TaskState | null }[] = [
    { row: '대기 작업 | 선행 작업 완료·실행 자리 확보 → 진행', task: taskIn('waiting'), ev: { type: 'activate' }, to: 'in_progress' },
    { row: '진행 작업 | 검수 요청과 자동 검사 통과 → 검수', task: taskIn('in_progress'), ev: submit('c1'), to: 'in_review' },
    {
      row: '검수 작업 | 현재 차수의 1번째 반려 → 진행',
      task: taskIn('in_review', { review: { ...emptyReviewState(), target: repoTarget(), rejectsInRound: 0 } }),
      ev: reject,
      to: 'in_progress',
    },
    {
      row: '검수 작업 | 현재 차수의 2번째 반려 → 진행',
      task: taskIn('in_review', { review: { ...emptyReviewState(), target: repoTarget(), rejectsInRound: 1, rejectsTotal: 1 } }),
      ev: reject,
      to: 'in_progress',
    },
    {
      row: '검수 작업 | 현재 차수의 3번째 반려 → 보류(재계획), 진행으로 복귀',
      task: taskIn('in_review', { review: { ...emptyReviewState(), target: repoTarget(), rejectsInRound: 2, rejectsTotal: 2 } }),
      ev: reject,
      to: 'on_hold',
      returnState: 'in_progress',
    },
    {
      row: '진행 작업 | 프로듀서에게 질문 → 보류(답변 대기), 원래 상태 저장',
      task: taskIn('in_progress'),
      ev: hold(reason('answer_wait', { refId: 'Q-0001' })),
      to: 'on_hold',
      returnState: 'in_progress',
    },
    {
      row: '검수 작업 | 대표에게 질문 → 보류(답변 대기), 원래 상태 저장',
      task: taskIn('in_review'),
      ev: hold(reason('answer_wait', { refId: 'Q-0002' })),
      to: 'on_hold',
      returnState: 'in_review',
    },
    { row: '검수 작업 | 검수 통과 및 병합/산출물 확정 → 완료', task: taskIn('in_review'), ev: { type: 'complete' }, to: 'done' },
    {
      row: '대기 작업 | 일시정지 → 보류(원래 상태 저장)',
      task: taskIn('waiting'),
      ev: hold(reason('paused', { scope: 'project', refId: 'P-0001' })),
      to: 'on_hold',
      returnState: 'waiting',
    },
    {
      row: '진행 작업 | 긴급 정지 → 보류(원래 상태 저장)',
      task: taskIn('in_progress'),
      ev: hold(reason('emergency_stop', { scope: 'global' })),
      to: 'on_hold',
      returnState: 'in_progress',
    },
    {
      row: '검수 작업 | 중단 후 보류 → 보류(원래 상태 저장)',
      task: taskIn('in_review'),
      ev: hold(reason('interrupted')),
      to: 'on_hold',
      returnState: 'in_review',
    },
  ];

  it.each(rows)('$row', ({ task, ev, to, returnState }) => {
    const r = apply(task, ev);
    expect(r.to).toBe(to);
    if (returnState !== undefined) expect(r.task.hold.returnState).toBe(returnState);
  });

  it.each(['waiting', 'in_progress', 'on_hold', 'in_review'] as const)('미완료 작업(%s) | 중단 후 취소 → 취소, 보류 정보 정리', (s) => {
    const task = taskIn(s, s === 'in_progress' ? { pendingSubmit: { requestedAt: T0, note: '제출' } } : {});
    const r = apply(task, { type: 'cancel', reason: '대표 중단 후 취소' });
    expect(r.to).toBe('cancelled');
    expect(r.task.cancelledAt).toBe(AT);
    expect(r.task.hold).toEqual({ reasons: [], returnState: null });
    expect(r.task.pendingSubmit).toBeNull();
  });

  it('AC-46: 검수 중 보류 → 취소', () => {
    const held = apply(taskIn('in_review'), hold(reason('paused', { scope: 'member', refId: 'M-DEV' }))).task;
    const r = apply(held, { type: 'cancel', reason: '취소' });
    expect(r.from).toBe('on_hold');
    expect(r.to).toBe('cancelled');
  });

  it('검수 통과 기록 없이는 완료할 수 없다 (REV-05·06: 자동 통과 없음)', () => {
    const t = taskIn('in_review', { review: { ...emptyReviewState(), target: repoTarget(), passed: null } });
    expectTransitionError(() => apply(t, { type: 'complete' }), 'in_review', 'complete');
  });
});

describe('REV-04 반려 횟수와 재계획 (AC-09)', () => {
  it(`현재 차수 1·2번째 반려 → 진행, ${REJECT_LIMIT}번째 → 보류(재계획), 복귀 상태 진행`, () => {
    expect(REJECT_LIMIT).toBe(3);
    let t = taskIn('in_progress');
    const expected: { to: TaskState; inRound: number }[] = [
      { to: 'in_progress', inRound: 1 },
      { to: 'in_progress', inRound: 2 },
      { to: 'on_hold', inRound: 3 },
    ];
    expected.forEach((exp, i) => {
      t = apply(t, submit(`c${i + 1}`)).task;
      const r = apply(t, reject);
      expect(r.to).toBe(exp.to);
      expect(r.task.review).toMatchObject({ round: 1, rejectsInRound: exp.inRound, rejectsTotal: exp.inRound, target: null, passed: null });
      t = r.task;
    });
    expect(t.hold.returnState).toBe('in_progress');
    expect(t.hold.reasons.map((r) => [r.kind, r.scope])).toEqual([['replan', 'task']]);
    expect(t.activatedAt).toBe(T0);
  });

  it('재계획 → 새 검수 차수, 차수 반려 횟수 0, 누적 반려 유지 → 다음 차수에서도 3번째에 다시 보류', () => {
    let t = taskIn('in_progress');
    for (let i = 0; i < 3; i++) t = apply(apply(t, submit(`a${i}`)).task, reject).task;
    expect(t.state).toBe('on_hold');

    const rp = apply(t, { type: 'replanned', note: '완료 조건 조정' });
    expect(rp.to).toBe('in_progress');
    expect(rp.task.review).toMatchObject({ round: 2, rejectsInRound: 0, rejectsTotal: 3, target: null, passed: null });
    expect(rp.task.hold).toEqual({ reasons: [], returnState: null });

    t = rp.task;
    const states: TaskState[] = [];
    for (let i = 0; i < 3; i++) {
      const r = apply(apply(t, submit(`b${i}`)).task, reject);
      states.push(r.to);
      t = r.task;
    }
    expect(states).toEqual(['in_progress', 'in_progress', 'on_hold']);
    expect(t.review).toMatchObject({ round: 2, rejectsInRound: 3, rejectsTotal: 6 });

    const rp2 = apply(t, { type: 'replanned', note: '재배정 없이 방법 변경' });
    expect(rp2.task.review).toMatchObject({ round: 3, rejectsInRound: 0, rejectsTotal: 6 });
  });

  it('5.3: 기준 main·작업 버전이 달라져 재검수(repin)·재작업(reopen)하는 것은 반려 횟수에 넣지 않는다', () => {
    let t = taskIn('in_review', { review: { ...emptyReviewState(), target: repoTarget('c1', 'b1'), rejectsInRound: 2, rejectsTotal: 2 } });
    const rep = apply(t, { type: 'repin', target: repoTarget('c1', 'b2') });
    expect(rep.to).toBe('in_review');
    expect(rep.task.review).toMatchObject({ rejectsInRound: 2, rejectsTotal: 2, passed: null, target: repoTarget('c1', 'b2') });

    const reo = apply(rep.task, { type: 'reopen', reason: '최신 main 반영 충돌' });
    expect(reo.to).toBe('in_progress');
    expect(reo.task.review).toMatchObject({ rejectsInRound: 2, rejectsTotal: 2 });

    // 그다음 실제 반려가 현재 차수 3번째
    t = apply(reo.task, submit('c2', 'b2')).task;
    expect(apply(t, reject).to).toBe('on_hold');
  });

  it('재계획 사유가 없는 보류에서 replanned는 오류', () => {
    const t = taskIn('on_hold', { hold: { reasons: [reason('blocked')], returnState: 'in_progress' } });
    expectTransitionError(() => apply(t, { type: 'replanned', note: 'x' }), 'on_hold', 'replanned');
    expectTransitionError(() => apply(taskIn('in_progress'), { type: 'replanned', note: 'x' }), 'in_progress', 'replanned');
  });

  it('재계획 후 다른 보류 사유가 남으면 실행하지 않고, 남은 사유가 풀리면 진행으로', () => {
    let t = apply(taskIn('in_review', { review: { ...emptyReviewState(), target: repoTarget(), rejectsInRound: 2, rejectsTotal: 2 } }), reject).task;
    t = apply(t, hold(reason('paused', { scope: 'member', refId: 'M-DEV' }))).task;
    const rp = apply(t, { type: 'replanned', note: '방법 변경' });
    expect(rp.to).toBe('on_hold');
    expect(rp.task.hold.reasons.map((r) => r.kind)).toEqual(['paused']);
    expect(rp.task.hold.returnState).toBe('in_progress');
    expect(rp.task.review).toMatchObject({ round: 2, rejectsInRound: 0, rejectsTotal: 3 });
    expect(apply(rp.task, releaseKind('paused')).to).toBe('in_progress');
  });

  it('재계획 중 재배정 → 새 담당이 다시 활성화하도록 대기로 복귀', () => {
    let t = apply(taskIn('in_review', { review: { ...emptyReviewState(), target: repoTarget(), rejectsInRound: 2, rejectsTotal: 2 } }), reject).task;
    t = apply(t, { type: 'reassign', assigneeId: 'M-DEV2' }).task;
    const rp = apply(t, { type: 'replanned', note: '재배정' });
    expect(rp.to).toBe('waiting');
    expect(rp.task.activatedAt).toBeNull();
    expect(rp.task.assigneeId).toBe('M-DEV2');
  });

  it('재계획 사유는 replanned로만 풀린다 — 일반 release로 지우면 새 차수 없이 진행으로 돌아가 다음 반려 1번에 다시 보류된다', () => {
    const held = apply(
      taskIn('in_review', { review: { ...emptyReviewState(), target: repoTarget(), rejectsInRound: 2, rejectsTotal: 2 } }),
      reject,
    ).task;
    // REV-04: 재계획 후 새 검수 차수를 열어 차수 횟수만 0으로 — release 경로는 이를 건너뛴다
    let released: Task | null = null;
    try {
      released = apply(held, releaseKind('replan')).task;
    } catch (e) {
      expect(e).toBeInstanceOf(TransitionError);
    }
    if (released) {
      expect(released.review.round).toBe(2);
      expect(released.review.rejectsInRound).toBe(0);
    }
  });
});

describe('여러 보류 사유 (5.3: 사유 하나가 해소됐다고 다른 정지 사유까지 해제하지 않음)', () => {
  it('답변 도착(답변 대기 해제) 후에도 일시정지가 남으면 보류 유지 → 일시정지 해제 시 원래 상태 (AC-37)', () => {
    let t = apply(taskIn('in_progress'), hold(reason('answer_wait', { refId: 'Q-0001' }))).task;
    t = apply(t, hold(reason('paused', { scope: 'project', refId: 'P-0001' }))).task;
    expect(t.hold.reasons).toHaveLength(2);
    expect(t.hold.returnState).toBe('in_progress');

    const r1 = apply(t, releaseKind('answer_wait', 'Q-0001'));
    expect(r1.to).toBe('on_hold');
    expect(r1.task.hold.reasons.map((r) => r.kind)).toEqual(['paused']);
    expect(r1.task.hold.returnState).toBe('in_progress');

    const r2 = apply(r1.task, releaseKind('paused'));
    expect(r2.to).toBe('in_progress');
    expect(r2.task.hold).toEqual({ reasons: [], returnState: null });
  });

  it('같은 종류라도 대상(refId·scope)이 다르면 모두 기록하고 하나씩 푼다', () => {
    let t = apply(taskIn('in_review'), hold(reason('answer_wait', { refId: 'Q-0001' }))).task;
    t = apply(t, hold(reason('answer_wait', { refId: 'Q-0002' }))).task;
    t = apply(t, hold(reason('paused', { scope: 'project', refId: 'P-0001' }))).task;
    t = apply(t, hold(reason('paused', { scope: 'member', refId: 'M-DEV' }))).task;
    expect(t.hold.reasons).toHaveLength(4);

    const order: [HoldReasonKind, string, TaskState][] = [
      ['answer_wait', 'Q-0001', 'on_hold'],
      ['paused', 'M-DEV', 'on_hold'],
      ['answer_wait', 'Q-0002', 'on_hold'],
      ['paused', 'P-0001', 'in_review'],
    ];
    for (const [kind, ref, to] of order) {
      const r = apply(t, releaseKind(kind, ref));
      expect(r.to).toBe(to);
      t = r.task;
    }
  });

  it('같은 사유(종류·범위·대상)의 중복 보류 이벤트는 한 번만 기록 (TSK-03)', () => {
    const r1 = apply(taskIn('in_progress'), hold(reason('emergency_stop', { scope: 'global' })));
    const r2 = apply(r1.task, hold(reason('emergency_stop', { scope: 'global', note: '다시' })));
    expect(r2.task.hold.reasons).toHaveLength(1);
    expect(r2.task.hold.returnState).toBe('in_progress');
  });

  it('보류 중 추가 보류는 저장한 복귀 상태를 보류로 덮어쓰지 않는다', () => {
    let t = apply(taskIn('in_review'), hold(reason('paused', { scope: 'member', refId: 'M-DEV' }))).task;
    t = apply(t, hold(reason('emergency_stop', { scope: 'global' }))).task;
    t = apply(t, hold(reason('interrupted'))).task;
    expect(t.hold.returnState).toBe('in_review');
  });

  it('해제할 사유가 없으면 오류 (보류 상태가 아니어도 오류)', () => {
    const t = apply(taskIn('in_progress'), hold(reason('blocked'))).task;
    expectTransitionError(() => apply(t, releaseKind('answer_wait')), 'on_hold', 'release');
    expectTransitionError(() => apply(taskIn('in_progress'), releaseKind('blocked')), 'in_progress', 'release');
  });

  it('hasHold: 종류와 조건으로 찾는다', () => {
    const t = taskIn('on_hold', { hold: { reasons: [reason('answer_wait', { refId: 'Q-1' }), reason('paused', { scope: 'project', refId: 'P-0001' })], returnState: 'in_progress' } });
    expect(hasHold(t, 'answer_wait')).toBe(true);
    expect(hasHold(t, 'answer_wait', (r) => r.refId === 'Q-2')).toBe(false);
    expect(hasHold(t, 'paused', (r) => r.scope === 'project')).toBe(true);
    expect(hasHold(t, 'replan')).toBe(false);
  });
});

describe('복귀 상태 규칙 (5.3: 보류는 저장한 복귀 상태로만 돌아간다)', () => {
  it.each(['waiting', 'in_progress', 'in_review'] as const)('%s 에서 일시정지 → 재개하면 그 상태로 복귀 (AC-16)', (s) => {
    const before = taskIn(s);
    const held = apply(before, hold(reason('paused', { scope: 'member', refId: 'M-DEV' }))).task;
    expect(held.state).toBe('on_hold');
    expect(held.hold.returnState).toBe(s);
    const r = apply(held, releaseKind('paused'));
    expect(r.to).toBe(s);
    expect(r.task.hold).toEqual({ reasons: [], returnState: null });
    // 검수 대상·통과 기록과 활성 여부는 보류를 거쳐도 그대로
    expect(r.task.review.target).toEqual(before.review.target);
    expect(r.task.review.passed).toEqual(before.review.passed);
    expect(r.task.activatedAt).toBe(before.activatedAt);
  });

  it('보류 중 작업 내용·검수 기준 변경 → 복귀 상태 검수였으면 진행으로, 통과·대상 무효 (검사·검수 다시)', () => {
    const held = apply(taskIn('in_review'), hold(reason('answer_wait', { refId: 'Q-0001' }))).task;
    expect(held.review.passed).not.toBeNull();
    const r = apply(held, { type: 'basis_changed', note: '완료 조건 변경' });
    expect(r.to).toBe('on_hold');
    expect(r.task.hold.returnState).toBe('in_progress');
    expect(r.task.review.target).toBeNull();
    expect(r.task.review.passed).toBeNull();
    // 반려 아님
    expect(r.task.review.rejectsInRound).toBe(held.review.rejectsInRound);
    const back = apply(r.task, releaseKind('answer_wait'));
    expect(back.to).toBe('in_progress');
    // 진행에서 다시 제출해야만 검수로
    expectTransitionError(() => apply(back.task, { type: 'complete' }), 'in_progress', 'complete');
  });

  it('보류 중 기준 변경: 복귀 상태 진행은 진행 유지', () => {
    const held = apply(taskIn('in_progress'), hold(reason('blocked'))).task;
    expect(apply(held, { type: 'basis_changed', note: '목표 변경' }).task.hold.returnState).toBe('in_progress');
  });

  it('보류 중 기준 변경: 복귀 상태 대기는 대기 유지 (시작 전 작업 — 진행으로 바꾸면 활성화·선행 작업 검사(TSK-04)를 건너뜀)', () => {
    const held = apply(taskIn('waiting'), hold(reason('paused', { scope: 'project', refId: 'P-0001' }))).task;
    const r = apply(held, { type: 'basis_changed', note: '목표 변경' });
    expect(r.task.hold.returnState).toBe('waiting');
    expect(apply(r.task, releaseKind('paused')).to).toBe('waiting');
  });

  it('보류 상태가 아니면 basis_changed는 오류', () => {
    expectTransitionError(() => apply(taskIn('in_review'), { type: 'basis_changed', note: 'x' }), 'in_review', 'basis_changed');
  });

  it.each(['done', 'cancelled', 'on_hold'] as const)(
    '저장할 복귀 상태는 대기·진행·검수만 — hold(returnState=%s)는 거부 (그대로 두면 release로 상태표 밖 전이·사유 없는 보류가 생김)',
    (rs) => {
      const t = taskIn('in_progress');
      expectTransitionError(() => apply(t, hold(reason('error'), rs)), 'in_progress', 'hold');
    },
  );

  it('검수 대상이 고정되지 않은 작업은 복귀 상태를 검수로 저장할 수 없다 (검수 진입은 대상 버전 고정 후에만)', () => {
    const t = taskIn('in_progress');
    expect(t.review.target).toBeNull();
    expectTransitionError(() => apply(t, hold(reason('error'), 'in_review')), 'in_progress', 'hold');
  });
});

describe('검수 통과와 완료의 버전 일치 (전이표 검수→완료 실행 조건, REV-07)', () => {
  it('통과 기록은 현재 고정된 대상에 대해서만 — 이전 대상의 통과로 완료할 수 없다', () => {
    const t = taskIn('in_review', { review: { ...emptyReviewState(), target: repoTarget('c2', 'b2'), passed: null } });
    let passed: Task | null = null;
    try {
      passed = apply(t, { type: 'review_pass', reviewId: 'RV-0009', reviewerId: 'M-PD', target: repoTarget('c1', 'b1') }).task;
    } catch (e) {
      expect(e).toBeInstanceOf(TransitionError);
    }
    if (passed) expectTransitionError(() => apply(passed!, { type: 'complete' }), 'in_review', 'complete');
  });

  it('대상 재고정(repin)은 기존 통과를 무효로 한다', () => {
    const r = apply(taskIn('in_review'), { type: 'repin', target: repoTarget('c1', 'b9') });
    expect(r.task.review.passed).toBeNull();
    expectTransitionError(() => apply(r.task, { type: 'complete' }), 'in_review', 'complete');
  });

  it('같은 대상 통과 → 완료, 완료 시각 기록', () => {
    const t = taskIn('in_review', { review: { ...emptyReviewState(), target: repoTarget('c3', 'b3'), passed: null } });
    const p = apply(t, { type: 'review_pass', reviewId: 'RV-0003', reviewerId: 'M-QA', target: repoTarget('c3', 'b3') });
    expect(p.to).toBe('in_review');
    const c = apply(p.task, { type: 'complete' });
    expect(c.to).toBe('done');
    expect(c.task.completedAt).toBe(AT);
  });
});

describe('활성화·제출', () => {
  it('activate: 대기 → 진행, 활성 시각 기록', () => {
    const r = apply(taskIn('waiting'), { type: 'activate' });
    expect(r.task.activatedAt).toBe(AT);
    expect(isActiveTask(r.task)).toBe(true);
  });

  it('submit: 진행 → 검수, 대상 고정·이전 통과 무효·제출 대기 정리', () => {
    const r = apply(taskIn('in_progress', { pendingSubmit: { requestedAt: T0, note: '제출' } }), submit('c7', 'b7'));
    expect(r.task.review.target).toEqual(repoTarget('c7', 'b7'));
    expect(r.task.review.passed).toBeNull();
    expect(r.task.pendingSubmit).toBeNull();
  });

  it('isActiveTask: 활성 후 검수·보류 중이어도 활성, 끝나면 아님 (ARCHITECTURE 6.1)', () => {
    expect(isActiveTask(taskIn('waiting'))).toBe(false);
    expect(isActiveTask(taskIn('in_progress'))).toBe(true);
    expect(isActiveTask(taskIn('in_review'))).toBe(true);
    expect(isActiveTask(taskIn('on_hold'))).toBe(true);
    expect(isActiveTask(taskIn('done'))).toBe(false);
    expect(isActiveTask(taskIn('cancelled', { activatedAt: T0 }))).toBe(false);
  });
});

describe('재배정 (대기·보류에서만)', () => {
  it.each(['in_progress', 'in_review', 'done', 'cancelled'] as const)('%s 에서는 재배정 불가', (s) => {
    expectTransitionError(() => apply(taskIn(s), { type: 'reassign', assigneeId: 'M-DEV2' }), s, 'reassign');
  });

  it('대기: 담당 변경, 활성 표시 없음, 새 담당은 실질 참여자로 기록 (이전 작업자도 계속 검수 불가)', () => {
    const r = apply(taskIn('waiting'), { type: 'reassign', assigneeId: 'M-DEV2' });
    expect(r.to).toBe('waiting');
    expect(r.task.assigneeId).toBe('M-DEV2');
    expect(r.task.activatedAt).toBeNull();
    expect(r.task.contributors).toEqual(['M-DEV', 'M-DEV2']);
  });

  it('보류: 활성 해제 + 복귀 상태 대기 + 검수 대상 무효 (새 담당이 다시 활성화)', () => {
    const held = apply(taskIn('in_review'), hold(reason('error', { note: '비정상 종료 2회' }))).task;
    const r = apply(held, { type: 'reassign', assigneeId: 'M-DEV2' });
    expect(r.to).toBe('on_hold');
    expect(r.task.activatedAt).toBeNull();
    expect(r.task.hold.returnState).toBe('waiting');
    expect(r.task.review.target).toBeNull();
    expect(r.task.review.passed).toBeNull();
    expect(apply(r.task, releaseKind('error')).to).toBe('waiting');
  });

  it('9장 중단: "보류는 명시적 재개·재배정" — 대표 중단 후 보류된 작업을 재배정하면 새 담당의 대기로 다시 시작', () => {
    const held = apply(taskIn('in_progress'), hold(reason('interrupted', { note: '대표 중단', by: 'M-MAIN' }))).task;
    const r = apply(held, { type: 'reassign', assigneeId: 'M-DEV2' });
    expect(r.task.hold.reasons.map((x) => x.kind)).not.toContain('interrupted');
    expect(r.to).toBe('waiting');
  });

  it('이전 담당의 팀원 일시정지(그 팀원 담당 작업에 건 정지)는 재배정된 작업을 계속 막지 않는다', () => {
    const held = apply(taskIn('in_progress'), hold(reason('paused', { scope: 'member', refId: 'M-DEV' }))).task;
    const r = apply(held, { type: 'reassign', assigneeId: 'M-DEV2' });
    expect(r.task.hold.reasons.some((x) => x.kind === 'paused' && x.scope === 'member' && x.refId === 'M-DEV')).toBe(false);
    expect(r.to).toBe('waiting');
  });

  it('재배정해도 담당과 무관한 보류(긴급 정지·프로젝트 정지·답변 대기)는 그대로', () => {
    let t = apply(taskIn('in_progress'), hold(reason('emergency_stop', { scope: 'global' }))).task;
    t = apply(t, hold(reason('paused', { scope: 'project', refId: 'P-0001' }))).task;
    t = apply(t, hold(reason('answer_wait', { refId: 'Q-0001' }))).task;
    const r = apply(t, { type: 'reassign', assigneeId: 'M-DEV2' });
    expect(r.to).toBe('on_hold');
    expect(r.task.hold.reasons.map((x) => x.kind).sort()).toEqual(['answer_wait', 'emergency_stop', 'paused']);
    expect(r.task.hold.returnState).toBe('waiting');
  });
});

describe('CTL-10 대표 항목별 재개 (isOwnerResumable)', () => {
  const table: { kind: HoldReasonKind; scope: HoldReason['scope']; owner: boolean }[] = [
    { kind: 'emergency_stop', scope: 'global', owner: true },
    { kind: 'interrupted', scope: 'task', owner: true },
    { kind: 'error', scope: 'task', owner: true },
    { kind: 'paused', scope: 'task', owner: true },
    { kind: 'paused', scope: 'project', owner: false },
    { kind: 'paused', scope: 'member', owner: false },
    { kind: 'answer_wait', scope: 'task', owner: false },
    { kind: 'replan', scope: 'task', owner: false },
    { kind: 'recovery_check', scope: 'task', owner: false },
    { kind: 'blocked', scope: 'task', owner: false },
    { kind: 'prereq_cancelled', scope: 'task', owner: false },
    // 병합 보류는 프로젝트 폴더·git 쪽 원인을 대표가 정리한 뒤 [재개]로 푼다 (재개 → 병합 판단부터 다시, F3)
    { kind: 'merge_blocked', scope: 'task', owner: true },
  ];

  it('표가 모든 보류 사유 종류를 다룬다', () => {
    expect(new Set(table.map((r) => r.kind))).toEqual(new Set(HOLD_KINDS));
  });

  it.each(table)('$kind/$scope → 대표 재개 대상=$owner', ({ kind, scope, owner }) => {
    expect(isOwnerResumable(reason(kind, { scope }))).toBe(owner);
  });

  it('전역 정지 해제 후 항목 재개는 긴급 정지 사유만 풀고 범위 정지·답변 대기는 유지', () => {
    let t = apply(taskIn('in_progress'), hold(reason('emergency_stop', { scope: 'global' }))).task;
    t = apply(t, hold(reason('paused', { scope: 'project', refId: 'P-0001' }))).task;
    t = apply(t, hold(reason('answer_wait', { refId: 'Q-0001' }))).task;
    const r = apply(t, { type: 'release', match: isOwnerResumable, note: '대표 재개' });
    expect(r.to).toBe('on_hold');
    expect(r.task.hold.reasons.map((x) => x.kind).sort()).toEqual(['answer_wait', 'paused']);
    expect(r.task.hold.returnState).toBe('in_progress');
  });
});

describe('sameTarget (REV-07 검수 대상 동일성)', () => {
  it.each([
    { a: repoTarget('c1', 'b1'), b: repoTarget('c1', 'b1'), same: true },
    { a: repoTarget('c1', 'b1'), b: repoTarget('c2', 'b1'), same: false },
    { a: repoTarget('c1', 'b1'), b: repoTarget('c1', 'b2'), same: false },
    {
      a: artifactTarget([{ path: 'a.md', sha256: 'h1' }, { path: 'b.md', sha256: 'h2' }]),
      b: artifactTarget([{ path: 'b.md', sha256: 'h2' }, { path: 'a.md', sha256: 'h1' }], 2),
      same: true,
    },
    { a: artifactTarget([{ path: 'a.md', sha256: 'h1' }]), b: artifactTarget([{ path: 'a.md', sha256: 'h9' }]), same: false },
    { a: artifactTarget([{ path: 'a.md', sha256: 'h1' }]), b: artifactTarget([{ path: 'a.md', sha256: 'h1' }, { path: 'c.md', sha256: 'h3' }]), same: false },
    { a: repoTarget(), b: artifactTarget([{ path: 'a.md', sha256: 'h1' }]), same: false },
    { a: null, b: repoTarget(), same: false },
    { a: null, b: null, same: false },
  ])('#%# → $same', ({ a, b, same }) => {
    expect(sameTarget(a, b)).toBe(same);
  });
});
