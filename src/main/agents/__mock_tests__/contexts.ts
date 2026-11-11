/**
 * 시험용 get_work_context 결과·턴 메시지 만들기.
 * 모양은 mcp/catalog.ts WorkContext, 턴 메시지는 orchestrator/prompts.ts buildTurnMessage와 같게 만든다.
 */
import type { TaskType, WorkKind } from '@shared/domain';
import { WORK_KIND_LABEL } from '@shared/labels';
import type { WorkContext, WorkTaskCard } from '../../mcp/catalog';

export interface TeamMember {
  memberId: string;
  name: string;
  roleId: string;
  roleName: string;
  canReview: boolean;
  /** 역할이 맡는 작업 유형 (WorkContext.team[].taskTypes, 리드 결정 S5-15). 없으면 빈 목록 */
  taskTypes?: TaskType[];
}

export const PRODUCER: TeamMember = { memberId: 'M-0001', name: '프로듀서 한', roleId: 'producer', roleName: '프로듀서', canReview: true, taskTypes: ['plan'] };
export const DEV: TeamMember = { memberId: 'M-0002', name: '개발자 김', roleId: 'developer', roleName: '개발자', canReview: false, taskTypes: ['development', 'bugfix'] };
export const QA: TeamMember = { memberId: 'M-0003', name: 'QA 박', roleId: 'qa', roleName: 'QA', canReview: true, taskTypes: ['test'] };
export const PLANNER: TeamMember = { memberId: 'M-0004', name: '기획자 이', roleId: 'planner', roleName: '기획자', canReview: false, taskTypes: ['spec', 'research'] };
export const DOCS: TeamMember = { memberId: 'M-0005', name: '문서 최', roleId: 'docs', roleName: '문서', canReview: false, taskTypes: ['docs'] };
export const MAIN: TeamMember = { memberId: 'M-MAIN', name: '메인 에이전트', roleId: 'main', roleName: '메인 에이전트', canReview: false };

export const PROJECT = { id: 'P-0001', name: '테스트 프로젝트', path: 'C:\\projects\\테스트 프로젝트', baseBranch: 'main', checkCommands: [] as string[] };

function you(m: TeamMember): WorkContext['you'] {
  return {
    memberId: m.memberId,
    name: m.name,
    roleId: m.roleId,
    roleName: m.roleName,
    isProducer: m.roleId === 'producer',
    isMain: m.roleId === 'main',
    canReview: m.canReview,
    projectId: m.roleId === 'main' ? null : PROJECT.id,
    runner: 'claude',
    aiKind: 'claude',
  };
}

function base(m: TeamMember, sessionKey: string, kind: WorkContext['session']['kind'], workKinds: WorkKind[], messages: string[]): WorkContext {
  return {
    you: you(m),
    session: { sessionKey, kind, turnNumber: 1 },
    workKinds,
    instructions: workKinds.map((k) => `- ${WORK_KIND_LABEL[k]}`).join('\n'),
    project: PROJECT,
    directive: null,
    task: null,
    reviewTasks: [],
    questions: [],
    mergeCandidates: [],
    team: [],
    tasks: [],
    messages: messages.map((text) => ({ from: '욱채', text, at: '2026-10-27T00:00:00.000Z' })),
  };
}

export function taskCard(o: Partial<WorkTaskCard> & { id: string }): WorkTaskCard {
  return {
    title: '로그인 화면 만들기',
    goal: '로그인 화면과 입력 검사를 만든다',
    type: 'development',
    priority: 'normal',
    state: 'in_progress',
    outputMode: 'repo',
    acceptanceCriteria: ['로그인 화면이 보인다', '빈 입력을 막는다'],
    plannedAreas: [],
    prerequisiteIds: [],
    steps: [],
    branch: `task/${o.id}-login`,
    worktreePath: null,
    artifactDir: null,
    reviewRound: 1,
    rejectsInRound: 0,
    lastRejectReason: null,
    conflictFiles: [],
    autoCheck: { status: 'not_run', detail: '' },
    ...o,
  };
}

export function taskContext(o: { member?: TeamMember; task: WorkTaskCard; workKinds?: WorkKind[]; messages?: string[] }): WorkContext {
  const m = o.member ?? DEV;
  const kinds = o.workKinds ?? ['task_work'];
  return { ...base(m, `task:${o.task.id}`, 'task', kinds, o.messages ?? [`작업 ${o.task.id} "${o.task.title}"을(를) 맡았습니다.`]), task: o.task };
}

export function reviewContext(o: { member?: TeamMember; taskId: string; criteria?: string[]; reviewCopyPath: string | null; round?: number; title?: string }): WorkContext {
  const m = o.member ?? PRODUCER;
  return {
    ...base(m, `review:${o.taskId}`, 'review', ['review'], [`${o.taskId} 검수를 맡았습니다.`]),
    reviewTasks: [
      {
        taskId: o.taskId,
        title: o.title ?? '로그인 화면 만들기',
        outputMode: 'repo',
        acceptanceCriteria: o.criteria ?? ['로그인 화면이 보인다', '빈 입력을 막는다'],
        reviewRound: o.round ?? 1,
        target: { kind: 'repo', taskCommitSha: 'a'.repeat(40), baseMainSha: 'b'.repeat(40), pinnedAt: '2026-10-27T00:00:00.000Z' },
        reviewCopyPath: o.reviewCopyPath,
      },
    ],
  };
}

export function directive(o: { id?: string; title?: string; text?: string; round?: number } = {}): NonNullable<WorkContext['directive']> {
  const id = o.id ?? 'D-0001';
  const text = o.text ?? '로그인 화면을 만들어 줘';
  const round = o.round ?? 1;
  return {
    id,
    title: o.title ?? '로그인 화면을 만들어 줘',
    text,
    round,
    state: 'planning',
    rounds: Array.from({ length: round }, (_, i) => ({ round: i + 1, text: i === 0 ? text : `${i + 1}회차 수정 요청: 버튼 색을 바꿔 주세요`, anchored: [] })),
  };
}

export function directiveContext(o: {
  kinds: WorkKind[];
  directive?: NonNullable<WorkContext['directive']>;
  team?: TeamMember[];
  tasks?: WorkContext['tasks'];
  questions?: WorkContext['questions'];
  mergeCandidates?: WorkContext['mergeCandidates'];
  messages?: string[];
  member?: TeamMember;
}): WorkContext {
  const d = o.directive ?? directive();
  const m = o.member ?? PRODUCER;
  return {
    ...base(m, `directive:${d.id}`, 'directive', o.kinds, o.messages ?? o.kinds.map((k) => `${WORK_KIND_LABEL[k]} 요청`)),
    directive: d,
    team: [m, ...(o.team ?? [])].map((t) => ({ ...t, taskTypes: t.taskTypes ?? [], runner: 'claude' as const, aiKind: 'claude' as const, status: '대기', activeTaskId: null })),
    tasks: o.tasks ?? [],
    questions: o.questions ?? [],
    mergeCandidates: o.mergeCandidates ?? [],
  };
}

export function mainContext(o: { sessionKey: string; kinds: WorkKind[]; messages: string[]; directive?: NonNullable<WorkContext['directive']> | null }): WorkContext {
  const general = o.sessionKey === 'main:general';
  return {
    ...base(MAIN, o.sessionKey, general ? 'main_general' : 'main_project', o.kinds, o.messages),
    project: general ? null : PROJECT,
    directive: o.directive ?? null,
  };
}

/** orchestrator/prompts.ts buildTurnMessage와 같은 모양 */
export function turnMessage(sessionKey: string, entries: { kind: WorkKind; message: string; urgent?: boolean }[], firstTurn = true): string {
  const lines = [`[욱채 · 시험 · ${sessionKey}] 이번 턴에 전달된 일 ${entries.length}건`];
  entries.forEach((e, n) => lines.push('', `### ${n + 1}. ${WORK_KIND_LABEL[e.kind]}${e.urgent ? ' (긴급 지시 우선 전달)' : ''}`, e.message.trim()));
  lines.push('', '먼저 get_work_context를 호출해 전체 정보를 확인한 뒤 진행하세요.');
  if (firstTurn) lines.push('이 세션의 첫 턴입니다.');
  return lines.join('\n');
}

/** 대표 명령 업무 메시지 (orchestrator/directives.ts 명령 전달과 같은 모양) */
export function ownerCommandMessage(text: string, projectId: string | null = PROJECT.id): string {
  return [
    projectId ? `대표 명령 (프로젝트 ${PROJECT.name} ${projectId}):` : '대표 명령 (메인 에이전트 직접):',
    text,
    '',
    projectId
      ? `먼저 read_memory(project_id="${projectId}")로 프로젝트 기억을 읽고 판단하세요. 지시로 등록할 일이면 register_directive, 모호하면 ask_owner로 질문하세요. 대표에게 할 답변은 마지막 메시지로 남기세요.`
      : '프로젝트와 무관한 직접 명령입니다. 직접 처리하고, 결과는 마지막 메시지로 남기거나 필요하면 submit_report(지시 없음)로 보고하세요.',
  ].join('\n');
}
