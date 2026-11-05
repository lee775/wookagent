/**
 * src/core 단위 테스트 공용 픽스처.
 * 모양은 실제 생성 코드(orchestrator/tasks.ts createTask, directives.ts register)와 같게 맞춘다.
 * 역할 표는 기획서 4.2(검수 권한 열)를 그대로 옮긴다.
 */
import type {
  AiAvailability,
  Directive,
  DirectiveState,
  HoldReason,
  HoldReasonKind,
  Member,
  Role,
  RoleId,
  ReviewTarget,
  Step,
  StopState,
  Task,
  TaskState,
} from '@shared/domain';
import { MAIN_AGENT_ID } from '@shared/domain';
import { emptyReviewState } from '@core/taskMachine';

export const T0 = '2026-10-27T00:00:00.000Z';
export const AT = '2026-10-27T01:00:00.000Z';
export const NOW_MS = Date.parse('2026-10-27T02:00:00.000Z');

export const TASK_STATES: readonly TaskState[] = ['waiting', 'in_progress', 'on_hold', 'in_review', 'done', 'cancelled'];
export const DIRECTIVE_STATES: readonly DirectiveState[] = [
  'received',
  'planning',
  'in_progress',
  'reporting',
  'awaiting_confirmation',
  'closed',
  'cancelled',
];
export const HOLD_KINDS: readonly HoldReasonKind[] = [
  'answer_wait',
  'error',
  'paused',
  'emergency_stop',
  'replan',
  'prereq_cancelled',
  'recovery_check',
  'interrupted',
  'blocked',
  'merge_blocked',
];

export function repoTarget(commit = 'c1', base = 'b1'): ReviewTarget {
  return { kind: 'repo', taskCommitSha: commit, baseMainSha: base, pinnedAt: T0 };
}

export function artifactTarget(files: { path: string; sha256: string }[], version = 1): ReviewTarget {
  return { kind: 'artifact', files: files.map((f) => ({ ...f, size: 1 })), version, pinnedAt: T0 };
}

export function reason(kind: HoldReasonKind, over: Partial<HoldReason> = {}): HoldReason {
  return { kind, scope: 'task', refId: null, note: kind, since: T0, by: 'system', ...over };
}

/** createTask 직후 모양 (대기, 활성 전) */
export function makeTask(over: Partial<Task> = {}): Task {
  const base: Task = {
    id: 'T-0001',
    projectId: 'P-0001',
    directiveId: 'D-0001',
    round: 1,
    title: '로그인 화면',
    goal: '로그인 화면을 만든다',
    type: 'development',
    priority: 'normal',
    assigneeId: 'M-DEV',
    reviewerId: 'M-PD',
    prerequisiteIds: [],
    acceptanceCriteria: ['로그인 버튼이 동작한다'],
    plannedAreas: [],
    outputMode: 'repo',
    state: 'waiting',
    hold: { reasons: [], returnState: null },
    workspace: null,
    review: emptyReviewState(),
    contributors: ['M-DEV'],
    merge: null,
    artifact: null,
    revertOfTaskId: null,
    revertedByTaskId: null,
    skillsUsed: [],
    pendingSubmit: null,
    conflict: null,
    crashRetries: 0,
    noProgressResumes: 0,
    createdBy: 'M-PD',
    createdAt: T0,
    updatedAt: T0,
    queuedAt: T0,
    activatedAt: null,
    completedAt: null,
    cancelledAt: null,
  };
  return { ...base, ...over };
}

/** 상태별 대표 작업 — 각 상태의 불변식(활성 시각·검수 대상·보류 사유)을 지킨 모양 */
export function taskIn(state: TaskState, over: Partial<Task> = {}): Task {
  switch (state) {
    case 'waiting':
      return makeTask({ state, ...over });
    case 'in_progress':
      return makeTask({ state, activatedAt: T0, ...over });
    case 'in_review':
      return makeTask({
        state,
        activatedAt: T0,
        review: { ...emptyReviewState(), target: repoTarget(), passed: { reviewId: 'RV-0001', reviewerId: 'M-PD', at: T0, target: repoTarget() } },
        ...over,
      });
    case 'on_hold':
      return makeTask({
        state,
        activatedAt: T0,
        hold: { reasons: [reason('replan')], returnState: 'in_progress' },
        ...over,
      });
    case 'done':
      return makeTask({ state, activatedAt: T0, completedAt: T0, ...over });
    case 'cancelled':
      return makeTask({ state, cancelledAt: T0, ...over });
  }
}

/** directives.ts register 직후 모양 */
export function makeDirective(over: Partial<Directive> = {}): Directive {
  return {
    id: 'D-0001',
    projectId: 'P-0001',
    title: '로그인 기능',
    text: '로그인 기능을 만들어 줘',
    attachments: [],
    round: 1,
    state: 'received',
    rounds: [{ round: 1, requestedAt: T0, text: '로그인 기능을 만들어 줘', anchored: [], reportId: null }],
    finalResult: null,
    planApprovalRequired: false,
    createdAt: T0,
    updatedAt: T0,
    closedAt: null,
    cancelledAt: null,
    ...over,
  };
}

export function makeMember(id: string, roleId: RoleId, over: Partial<Member> = {}): Member {
  return {
    id,
    projectId: 'P-0001',
    name: id,
    roleId,
    isProducer: roleId === 'producer',
    isMain: false,
    ai: { kind: 'claude', model: null, effortTier: 'normal', effortOverride: null },
    pendingAi: null,
    aiDecision: null,
    mockScenario: null,
    createdAt: T0,
    updatedAt: T0,
    deletedAt: null,
    replacedById: null,
    runSeconds: 0,
    ...over,
  };
}

export function mainAgent(): Member {
  return makeMember(MAIN_AGENT_ID, 'main', { projectId: null, isMain: true, isProducer: false });
}

function role(id: RoleId, name: string, canReview: boolean, builtin = true): Role {
  return {
    id,
    name,
    instructions: '',
    taskTypes: [],
    allowedSkills: [],
    defaultAi: { kind: 'claude', model: null, effortTier: 'normal', effortOverride: null },
    canReview,
    builtin,
    createdAt: T0,
    updatedAt: T0,
  };
}

/** 기획서 4.2 역할 표의 '검수 권한' 열 + 사용자 정의 역할 2개 (권한 있음/없음) */
export const ROLES: Record<string, Role> = {
  producer: role('producer', '프로듀서', true),
  planner: role('planner', '기획자', false),
  architect: role('architect', '설계자', true),
  developer: role('developer', '개발자', false),
  ui_designer: role('ui_designer', 'UI 디자이너', false),
  qa: role('qa', 'QA', true),
  docs: role('docs', '문서 담당', false),
  'role-0001': role('role-0001', '보안 검토자', true, false),
  'role-0002': role('role-0002', '번역가', false, false),
};

export const roleOf = (id: string): Role | null => ROLES[id] ?? null;

export function clearStop(): StopState {
  return { global: { active: false, since: null, by: null, releasedAt: null }, projects: {}, members: {} };
}

export function aiOk(over: Partial<AiAvailability> = {}): AiAvailability {
  return {
    kind: 'claude',
    usageLimitedUntil: null,
    authRequired: false,
    authRequiredSince: null,
    cliInstalled: true,
    cliVersion: '2.0.0',
    cliProblem: null,
    checkedAt: T0,
    ...over,
  };
}

export function steps(taskId: string, flags: readonly boolean[]): Step[] {
  return flags.map((done, idx) => ({
    taskId,
    idx,
    title: `단계 ${idx + 1}`,
    done,
    doneAt: done ? T0 : null,
    commitSha: null,
    note: '',
  }));
}

/** 결정적 의사 난수 (속성 테스트용) */
export function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}
