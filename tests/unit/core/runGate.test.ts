/**
 * 실행 허용 검사 — 기획서 CTL-09 순서(전역 긴급 정지 → 프로젝트·팀원·작업 정지 → 취소·미해소 보류/복구 확인
 * → 인증·사용량·(CLI)·선행 작업), 5.7 마지막 문단(답변 대기는 다른 관리 업무를 막지 않음), AC-44.
 */
import { describe, expect, it } from 'vitest';
import type { WorkKind } from '@shared/domain';
import { checkRunGate, TASK_BOUND_KINDS, type GateBlock, type GateInput } from '@core/runGate';
import { aiOk, clearStop, makeMember, NOW_MS, reason, T0, taskIn } from './fixtures';

function base(over: Partial<GateInput> = {}): GateInput {
  return {
    stop: clearStop(),
    member: makeMember('M-DEV', 'developer'),
    kind: 'task_work',
    task: taskIn('in_progress'),
    taskBound: true,
    recoveryPending: false,
    ai: aiOk(),
    prereqsDone: null,
    nowMs: NOW_MS,
    ...over,
  };
}

type Mut = (i: GateInput) => void;
/** CTL-09 순서대로 */
const CONDITIONS: { block: GateBlock; label: string; mut: Mut }[] = [
  { block: 'global_stop', label: '전역 긴급 정지', mut: (i) => void (i.stop.global = { active: true, since: T0, by: 'owner', releasedAt: null }) },
  { block: 'project_paused', label: '프로젝트 일시정지', mut: (i) => void (i.stop.projects['P-0001'] = { paused: true, mode: 'graceful', since: T0, by: 'M-MAIN' }) },
  { block: 'member_paused', label: '팀원 일시정지', mut: (i) => void (i.stop.members['M-DEV'] = { paused: true, mode: 'immediate', since: T0, by: 'M-MAIN' }) },
  { block: 'member_deleted', label: '삭제된 팀원', mut: (i) => void (i.member = { ...i.member, deletedAt: T0 }) },
  { block: 'task_held', label: '작업 보류', mut: (i) => void (i.task = taskIn('on_hold', { hold: { reasons: [reason('answer_wait', { refId: 'Q-0001' })], returnState: 'in_progress' } })) },
  { block: 'recovery', label: '미해소 복구 확인', mut: (i) => void (i.recoveryPending = true) },
  { block: 'auth', label: '인증 만료', mut: (i) => void (i.ai = { ...i.ai!, authRequired: true, authRequiredSince: T0 }) },
  { block: 'usage_limit', label: '사용량 한도', mut: (i) => void (i.ai = { ...i.ai!, usageLimitedUntil: new Date(NOW_MS + 60_000).toISOString() }) },
  { block: 'cli_problem', label: 'CLI 문제', mut: (i) => void (i.ai = { ...i.ai!, cliProblem: '검증되지 않은 버전 9.9' }) },
  { block: 'prereq', label: '선행 작업 미완료', mut: (i) => void (i.prereqsDone = false) },
];

function gate(...muts: Mut[]): ReturnType<typeof checkRunGate> {
  const i = base();
  for (const m of muts) m(i);
  return checkRunGate(i);
}

describe('CTL-09 각 조건 단독', () => {
  it('모든 조건 통과 → 실행 허용', () => {
    expect(checkRunGate(base())).toEqual({ ok: true });
    expect(checkRunGate(base({ prereqsDone: true }))).toEqual({ ok: true });
  });

  it.each(CONDITIONS)('$label → $block', ({ block, mut }) => {
    const r = gate(mut);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.block).toBe(block);
      expect(r.detail).not.toBe('');
    }
  });

  it.each(['done', 'cancelled'] as const)('작업이 끝남(%s) → task_closed', (s) => {
    expect(gate((i) => void (i.task = taskIn(s)))).toMatchObject({ ok: false, block: 'task_closed' });
  });

  it('CLI 미설치 → cli_problem', () => {
    expect(gate((i) => void (i.ai = { ...i.ai!, cliInstalled: false }))).toMatchObject({ ok: false, block: 'cli_problem' });
  });
});

describe('CTL-09 순서: 두 조건이 겹치면 앞선 검사가 이긴다 (모든 순서쌍)', () => {
  const pairs = CONDITIONS.flatMap((a, ai) => CONDITIONS.slice(ai + 1).map((b) => ({ first: a, second: b })));
  it.each(pairs)('$first.label + $second.label → $first.block', ({ first, second }) => {
    // 뒤 조건을 먼저 적용해도 결과는 앞 조건
    expect(gate(second.mut, first.mut)).toMatchObject({ ok: false, block: first.block });
  });

  it('취소된 작업 + 복구 확인 + 인증 만료 → task_closed', () => {
    const r = gate(
      (i) => void (i.ai = { ...i.ai!, authRequired: true }),
      (i) => void (i.recoveryPending = true),
      (i) => void (i.task = taskIn('cancelled')),
    );
    expect(r).toMatchObject({ ok: false, block: 'task_closed' });
  });
});

describe('업무 범위 (5.7: 특정 작업의 답변 대기는 그 팀원의 다른 관리 업무를 막지 않음, 팀원·프로젝트 정지는 모든 소속 업무에)', () => {
  const heldTask = taskIn('on_hold', { hold: { reasons: [reason('answer_wait', { refId: 'Q-0001' })], returnState: 'in_progress' } });

  it('작업 세션 업무 종류는 taskBound 표시가 없어도 작업 보류에 막힌다', () => {
    expect([...TASK_BOUND_KINDS].sort()).toEqual(['conflict_fix', 'merge_decision', 'review', 'task_work']);
    for (const kind of TASK_BOUND_KINDS) {
      expect(checkRunGate(base({ kind, task: heldTask, taskBound: false }))).toMatchObject({ ok: false, block: 'task_held' });
    }
  });

  it('작업 세션으로 가는 메시지도 작업 보류에 막힌다 (CLI-10: 정지 중이면 저장만)', () => {
    expect(checkRunGate(base({ kind: 'message', task: heldTask, taskBound: true }))).toMatchObject({ ok: false, block: 'task_held' });
  });

  it.each(['plan', 'answer', 'replan', 'final_result', 'reviewer_assign', 'message'] as WorkKind[])(
    '보류된 작업과 관련 있어도 작업 세션이 아닌 관리 업무(%s)는 막지 않는다',
    (kind) => {
      expect(checkRunGate(base({ member: makeMember('M-PD', 'producer'), kind, task: heldTask, taskBound: false }))).toEqual({ ok: true });
    },
  );

  it('재계획 보류 작업의 프로듀서 재계획 업무는 실행 가능 (아니면 재계획이 영원히 못 돈다)', () => {
    const replanHeld = taskIn('on_hold');
    expect(checkRunGate(base({ member: makeMember('M-PD', 'producer'), kind: 'replan', task: replanHeld, taskBound: false }))).toEqual({ ok: true });
  });

  it('프로젝트 일시정지는 그 프로젝트 프로듀서의 관리 업무도 막는다', () => {
    const i = base({ member: makeMember('M-PD', 'producer'), kind: 'plan', task: null, taskBound: false });
    i.stop.projects['P-0001'] = { paused: true, mode: 'graceful', since: T0, by: 'M-MAIN' };
    expect(checkRunGate(i)).toMatchObject({ ok: false, block: 'project_paused' });
  });

  it('다른 팀원·다른 프로젝트의 정지, 해제된 정지 기록은 막지 않는다', () => {
    const i = base();
    i.stop.members['M-QA'] = { paused: true, mode: 'graceful', since: T0, by: 'M-MAIN' };
    i.stop.projects['P-0002'] = { paused: true, mode: 'graceful', since: T0, by: 'M-MAIN' };
    i.stop.members['M-DEV'] = { paused: false, mode: 'graceful', since: T0, by: 'M-MAIN' };
    i.stop.global = { active: false, since: T0, by: 'owner', releasedAt: T0 };
    expect(checkRunGate(i)).toEqual({ ok: true });
  });

  it('AC-44: 전역 정지 해제 후에도 항목별 재개 전(긴급 정지 보류 남음)에는 작업 세션 업무를 실행하지 않는다', () => {
    const stop = clearStop();
    stop.global = { active: false, since: T0, by: 'owner', releasedAt: T0 };
    const t = taskIn('on_hold', { hold: { reasons: [reason('emergency_stop', { scope: 'global' })], returnState: 'in_review' } });
    for (const kind of ['task_work', 'conflict_fix', 'review', 'merge_decision'] as WorkKind[]) {
      expect(checkRunGate(base({ stop, kind, task: t, taskBound: kind === 'task_work' || kind === 'conflict_fix' }))).toMatchObject({ ok: false, block: 'task_held' });
    }
    // 메시지 도착으로도 재개하지 않음
    expect(checkRunGate(base({ stop, kind: 'message', task: t, taskBound: true }))).toMatchObject({ ok: false, block: 'task_held' });
  });

  it('대기 작업 활성화 판단: 선행 작업 완료 전에는 시작 안 함 (TSK-04, AC-08)', () => {
    expect(checkRunGate(base({ task: taskIn('waiting'), prereqsDone: false }))).toMatchObject({ ok: false, block: 'prereq' });
    expect(checkRunGate(base({ task: taskIn('waiting'), prereqsDone: true }))).toEqual({ ok: true });
  });
});

describe('AI 가용성', () => {
  it('사용량 한도 기한이 지나면 통과', () => {
    expect(checkRunGate(base({ ai: aiOk({ usageLimitedUntil: new Date(NOW_MS - 1).toISOString() }) }))).toEqual({ ok: true });
    expect(checkRunGate(base({ ai: aiOk({ usageLimitedUntil: new Date(NOW_MS).toISOString() }) }))).toEqual({ ok: true });
  });

  it('모의 실행(ai=null)은 AI 가용성을 보지 않지만 정지·보류는 그대로 본다', () => {
    expect(checkRunGate(base({ ai: null }))).toEqual({ ok: true });
    const i = base({ ai: null });
    i.stop.global.active = true;
    expect(checkRunGate(i)).toMatchObject({ ok: false, block: 'global_stop' });
  });
});
