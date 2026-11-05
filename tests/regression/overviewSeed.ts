/**
 * 현황 시험의 기록 준비 (overviewMultiProject·digestEveryTurn) — 현황은 기록만 읽으므로 프로젝트·지시·작업을 폴더와 git 없이 기록에 바로 넣는다.
 * 만든 차례대로 ID가 붙는다 (P-…·D-…·T-…)
 */
import type { Directive, DirectiveState, HoldReason, Project, Task, TaskState } from '@shared/domain';
import type { OrchEnv } from './orchHarness';

/** 프로젝트 하나 (bootOrch 프로젝트를 본뜬다 — 프로듀서는 같은 팀원) */
export function addProject(e: OrchEnv, name: string): Project {
  const base = e.ctx.store.projects.require(e.projectId);
  const now = e.ctx.now();
  const p: Project = { ...base, id: e.ctx.store.nextId('project'), name, path: `${base.path}-${name.length}-${Math.random().toString(36).slice(2, 6)}`, createdAt: now, updatedAt: now };
  e.ctx.store.projects.insert(p);
  return p;
}

/** 지시 하나 — round 회차(앞 회차 기록 포함), 상태 state */
export function addDirective(e: OrchEnv, projectId: string, o: { state?: DirectiveState; round?: number; title?: string } = {}): Directive {
  const now = e.ctx.now();
  const round = o.round ?? 1;
  const d: Directive = {
    id: e.ctx.store.nextId('directive'),
    projectId,
    title: o.title ?? `${projectId} 지시`,
    text: o.title ?? `${projectId} 지시`,
    attachments: [],
    round,
    state: o.state ?? 'in_progress',
    rounds: Array.from({ length: round }, (_, i) => ({ round: i + 1, requestedAt: now, text: `${i + 1}회차`, anchored: [], reportId: null })),
    finalResult: null,
    planApprovalRequired: false,
    createdAt: now,
    updatedAt: now,
    closedAt: o.state === 'closed' ? now : null,
    cancelledAt: o.state === 'cancelled' ? now : null,
  };
  e.ctx.store.directives.insert(d);
  return d;
}

/** 작업 하나 — 상태·회차·보류 사유를 정해 바로 넣는다 */
export function addTask(
  e: OrchEnv,
  d: Directive,
  o: { state?: TaskState; round?: number; title?: string; holds?: HoldReason[]; returnState?: TaskState | null; reviewerId?: string | null; assigneeId?: string } = {},
): Task {
  const now = e.ctx.now();
  const t: Task = {
    id: e.ctx.store.nextId('task'),
    projectId: d.projectId!,
    directiveId: d.id,
    round: o.round ?? d.round,
    title: o.title ?? '현황 작업',
    goal: '현황 시험',
    type: 'development',
    priority: 'normal',
    assigneeId: o.assigneeId ?? e.devId,
    reviewerId: o.reviewerId ?? null,
    prerequisiteIds: [],
    acceptanceCriteria: ['동작한다'],
    plannedAreas: [],
    outputMode: 'repo',
    state: o.state ?? 'waiting',
    hold: { reasons: o.holds ?? [], returnState: o.holds?.length ? (o.returnState ?? 'in_progress') : null },
    workspace: null,
    review: { round: 1, rejectsInRound: 0, rejectsTotal: 0, target: null, passed: null, autoCheck: { status: 'not_applicable', detail: '', at: now } },
    contributors: [],
    merge: null,
    artifact: null,
    revertOfTaskId: null,
    revertedByTaskId: null,
    skillsUsed: [],
    pendingSubmit: null,
    conflict: null,
    crashRetries: 0,
    noProgressResumes: 0,
    createdBy: e.producerId,
    createdAt: now,
    updatedAt: now,
    queuedAt: now,
    activatedAt: null,
    completedAt: null,
    cancelledAt: null,
  };
  e.ctx.store.tasks.insert(t);
  return t;
}

/** 보류 사유 하나 */
export function hold(e: OrchEnv, kind: HoldReason['kind'], note: string, o: { refId?: string | null; by?: string } = {}): HoldReason {
  return { kind, scope: 'task', refId: o.refId ?? null, note, since: e.ctx.now(), by: o.by ?? 'system' };
}
