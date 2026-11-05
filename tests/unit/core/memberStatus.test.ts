/**
 * 팀원 상태 — 기획서 5.4 (업무 중·대기·답변 대기·일시정지·오류, 겹치면 일시정지 → 오류 → 답변 대기 → 업무 중 → 대기,
 * 나머지 사유도 남김), 9장(긴급 정지·중단 후 항목별 재개), CTL-10.
 */
import { describe, expect, it } from 'vitest';
import type { MemberStatus } from '@shared/views';
import { deriveMemberStatus, type MemberStatusInput } from '@core/memberStatus';
import { emptyReviewState } from '@core/taskMachine';
import { aiOk, clearStop, makeMember, NOW_MS, reason, repoTarget, T0, taskIn } from './fixtures';

function input(over: Partial<MemberStatusInput> = {}): MemberStatusInput {
  return {
    member: makeMember('M-DEV', 'developer'),
    stop: clearStop(),
    runningLabel: null,
    assignedTasks: [],
    queued: 0,
    ai: aiOk(),
    memberError: null,
    openQuestions: [],
    nowMs: NOW_MS,
    ...over,
  };
}
const heldWith = (...rs: ReturnType<typeof reason>[]) => taskIn('on_hold', { hold: { reasons: rs, returnState: 'in_progress' } });
const future = new Date(NOW_MS + 3_600_000).toISOString();

describe('5.4 상태별 단독 조건', () => {
  const table: { name: string; over: Partial<MemberStatusInput>; status: MemberStatus; reason: string }[] = [
    { name: '맡은 작업 없음', over: {}, status: 'idle', reason: '맡은 작업 없음' },
    { name: '턴 실행 중', over: { runningLabel: 'T-0001 작업' }, status: 'working', reason: 'T-0001 작업' },
    { name: '대표에게 한 질문 답변 대기', over: { openQuestions: ['배포 대상은?'] }, status: 'awaiting_answer', reason: '답변 대기: 배포 대상은?' },
    {
      name: '작업 답변 대기 보류',
      over: { assignedTasks: [heldWith(reason('answer_wait', { refId: 'Q-0001' }))] },
      status: 'awaiting_answer',
      reason: 'T-0001 답변 대기',
    },
    { name: '팀원 단위 오류', over: { memberError: '바이패스 설정 불일치' }, status: 'error', reason: '바이패스 설정 불일치' },
    { name: '인증 만료', over: { ai: aiOk({ authRequired: true }) }, status: 'error', reason: 'claude 인증 만료 — 재로그인 필요' },
    { name: 'CLI 미설치', over: { ai: aiOk({ cliInstalled: false }) }, status: 'error', reason: 'claude CLI 없음' },
    { name: 'CLI 문제', over: { ai: aiOk({ cliProblem: '검증되지 않은 버전' }) }, status: 'error', reason: '검증되지 않은 버전' },
    { name: '자동 복구 실패 보류', over: { assignedTasks: [heldWith(reason('error', { note: '비정상 종료 2회' }))] }, status: 'error', reason: 'T-0001 오류: 비정상 종료 2회' },
    { name: '복구 확인 보류', over: { assignedTasks: [heldWith(reason('recovery_check'))] }, status: 'error', reason: 'T-0001 복구 확인 필요' },
    {
      name: '긴급 정지',
      over: { stop: { ...clearStop(), global: { active: true, since: T0, by: 'owner', releasedAt: null } } },
      status: 'paused',
      reason: '긴급 정지',
    },
    {
      name: '프로젝트 일시정지',
      over: { stop: { ...clearStop(), projects: { 'P-0001': { paused: true, mode: 'graceful', since: T0, by: 'M-MAIN' } } } },
      status: 'paused',
      reason: '프로젝트 일시정지',
    },
    {
      name: '팀원 일시정지',
      over: { stop: { ...clearStop(), members: { 'M-DEV': { paused: true, mode: 'graceful', since: T0, by: 'M-MAIN' } } } },
      status: 'paused',
      reason: '팀원 일시정지',
    },
    { name: '사용량 한도 대기', over: { ai: aiOk({ usageLimitedUntil: future }) }, status: 'idle', reason: '사용량 한도' },
    {
      name: '검수 결과 대기',
      over: { assignedTasks: [taskIn('in_review', { review: { ...emptyReviewState(), target: repoTarget(), passed: null } })] },
      status: 'idle',
      reason: 'T-0001 검수 결과 대기',
    },
    { name: '병합 순서 대기', over: { assignedTasks: [taskIn('in_review')] }, status: 'idle', reason: 'T-0001 병합 순서 대기' },
    { name: '실행 자리 대기', over: { assignedTasks: [taskIn('in_progress')], queued: 1 }, status: 'idle', reason: '실행 자리 대기' },
    { name: '선행 작업·차례 대기', over: { assignedTasks: [taskIn('waiting')] }, status: 'idle', reason: '선행 작업·차례 대기' },
    { name: '재계획 대기', over: { assignedTasks: [heldWith(reason('replan'))] }, status: 'idle', reason: 'T-0001 재계획 대기' },
    { name: '막힘 보고', over: { assignedTasks: [heldWith(reason('blocked'))] }, status: 'idle', reason: 'T-0001 막힘 보고 — 프로듀서 조치 대기' },
  ];

  it.each(table)('$name → $status', ({ over, status, reason: why }) => {
    const r = deriveMemberStatus(input(over));
    expect(r.status).toBe(status);
    expect(r.reasons.some((x) => x.includes(why))).toBe(true);
  });

  it('지난 사용량 한도는 사유가 아니다', () => {
    const r = deriveMemberStatus(input({ ai: aiOk({ usageLimitedUntil: new Date(NOW_MS - 1).toISOString() }) }));
    expect(r.reasons).toEqual(['맡은 작업 없음']);
  });
});

describe('5.4 겹칠 때: 일시정지 → 오류 → 답변 대기 → 업무 중 → 대기, 나머지 사유도 남김', () => {
  const ORDER: MemberStatus[] = ['paused', 'error', 'awaiting_answer', 'working', 'idle'];
  /** 서로 독립적으로 겹칠 수 있는 대표 조건 */
  const COND: Record<MemberStatus, { apply: (i: MemberStatusInput) => void; reason: string }> = {
    paused: { apply: (i) => void (i.stop.members['M-DEV'] = { paused: true, mode: 'graceful', since: T0, by: 'M-MAIN' }), reason: '팀원 일시정지' },
    error: { apply: (i) => void (i.memberError = '바이패스 설정 불일치'), reason: '바이패스 설정 불일치' },
    awaiting_answer: { apply: (i) => void (i.openQuestions = ['범위?']), reason: '답변 대기: 범위?' },
    working: { apply: (i) => void (i.runningLabel = 'T-0009 검수'), reason: 'T-0009 검수' },
    idle: { apply: (i) => void (i.ai = aiOk({ usageLimitedUntil: future })), reason: '사용량 한도' },
  };

  const pairs = ORDER.flatMap((hi, k) => ORDER.slice(k + 1).map((lo) => ({ hi, lo })));
  it.each(pairs)('$hi + $lo → $hi (두 사유 모두, 대표 사유 먼저)', ({ hi, lo }) => {
    const i = input({ stop: clearStop() });
    COND[lo].apply(i);
    COND[hi].apply(i);
    const r = deriveMemberStatus(i);
    expect(r.status).toBe(hi);
    expect(r.reasons[0]).toBe(COND[hi].reason);
    expect(r.reasons.some((x) => x.startsWith(COND[lo].reason))).toBe(true);
  });

  it('다섯 조건이 모두 겹치면 일시정지, 사유는 우선순위 순서로 전부', () => {
    const i = input({ stop: clearStop() });
    for (const s of ORDER) COND[s].apply(i);
    const r = deriveMemberStatus(i);
    expect(r.status).toBe('paused');
    const firstIndex = (why: string) => r.reasons.findIndex((x) => x.startsWith(why));
    const idx = ORDER.map((s) => firstIndex(COND[s].reason));
    expect(idx.every((x) => x >= 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
  });

  it('자기 작업이 답변 대기인데 다른 관리 업무(검수)를 실행 중 → 답변 대기 (5.4 순서 그대로)', () => {
    const r = deriveMemberStatus(input({ runningLabel: 'T-0009 검수', assignedTasks: [heldWith(reason('answer_wait', { refId: 'Q-1' }))] }));
    expect(r.status).toBe('awaiting_answer');
    expect(r.reasons).toContain('T-0009 검수');
  });

  it('긴급 정지 중에는 작업별 긴급 정지 보류 사유를 따로 늘어놓지 않는다', () => {
    const stop = { ...clearStop(), global: { active: true, since: T0, by: 'owner' as const, releasedAt: null } };
    const r = deriveMemberStatus(input({ stop, assignedTasks: [heldWith(reason('emergency_stop', { scope: 'global' }))] }));
    expect(r.status).toBe('paused');
    expect(r.reasons).toEqual(['긴급 정지']);
  });

  it('같은 사유는 한 번만', () => {
    const r = deriveMemberStatus(input({ openQuestions: ['범위?', '범위?'] }));
    expect(r.reasons).toEqual(['답변 대기: 범위?']);
  });
});

describe('대기 사유가 실제 상황과 맞아야 한다 (5.4 대기: 사유 표시)', () => {
  it('활성 작업이 진행 중인데 턴·대기열이 없을 때(턴 종료 후 자동 검사 실행 중) "맡은 작업 없음"이라고 하지 않는다', () => {
    const t = taskIn('in_progress', {
      pendingSubmit: { requestedAt: T0, note: '검수 요청' },
      review: { ...emptyReviewState(), autoCheck: { status: 'running', detail: '', at: T0 } },
    });
    const r = deriveMemberStatus(input({ assignedTasks: [t], runningLabel: null, queued: 0 }));
    expect(r.reasons).not.toContain('맡은 작업 없음');
    expect(r.reasons.some((x) => x.includes('T-0001'))).toBe(true);
  });
});

describe('9장 / CTL-10: 대표가 멈춘 작업은 항목별 재개 전까지 일시정지로 표시 (5.4 일시정지: 대표가 멈췄거나 긴급 정지가 적용됨, 해제 전까지 실행 안 함)', () => {
  it.each([
    { name: '전역 정지 해제 후 항목 재개 전인 긴급 정지 보류', r: reason('emergency_stop', { scope: 'global' }) },
    { name: '대표 중단 후 보류', r: reason('interrupted', { note: '대표 중단', by: 'M-MAIN' }) },
  ])('$name → 일시정지', ({ r }) => {
    const stop = { ...clearStop(), global: { active: false, since: T0, by: 'owner' as const, releasedAt: T0 } };
    const out = deriveMemberStatus(input({ stop, assignedTasks: [heldWith(r)] }));
    expect(out.status).toBe('paused');
  });
});
