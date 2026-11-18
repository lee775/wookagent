/**
 * 작업 서비스 (5장, 7장): 생성·수정·단계·제출(자동 검사·대상 고정)·검수·질문·막힘·보류·재개·취소·활성화.
 */
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type {
  Actor,
  AgentMessage,
  ArtifactFile,
  CriterionResult,
  HoldReason,
  HoldReasonKind,
  Member,
  OutputMode,
  OwnerRef,
  Priority,
  Project,
  Question,
  QueueEntry,
  ReviewRecord,
  ReviewTarget,
  Step,
  Task,
  TaskConflict,
  TaskState,
  TaskType,
} from '@shared/domain';
import { MAIN_AGENT_ID, OWNER } from '@shared/domain';
import { HOLD_REASON_LABEL, TASK_TYPE_LABEL } from '@shared/labels';
import { CANCEL_HOLD_REF, emptyReviewState, hasHold, isOwnerResumable, isTerminal, REJECT_LIMIT, sameTarget } from '@core/taskMachine';
import { canBeReviewer, canSubmitReview, changedCriteria, chooseReviewer, uncoveredCriteria } from '@core/reviewRules';
import { isDirectiveOpen } from '@core/directiveMachine';
import { taskBranchName } from '@core/ids';
import { BackendError } from '../backend/types';
import type { Core } from './core';
import { cancelQueued, directiveKey, enqueue, isUrgentDirect, isUrgentMessage, mainKey, noteMessagesUndelivered, reviewKey, taskKey, transitionTask } from './records';
import { memberIdentity, recordedExec } from './execlog';
import { alertTaskHold, OWNER_HANDED, OWNER_TELL_MAIN, ownerExit } from './alerts';
import { artifactVersionDir, artifactWorkDir, reviewCopyPath, taskWorktreePath } from './paths';
import { copyTree, hashTree, removeTree } from './fsutil';
import {
  activeTaskOf,
  closedDirectiveWork,
  directiveOrThrow,
  directiveTasks,
  isProgramRevert,
  memberName,
  memberOrThrow,
  openTasksOf,
  producerOf,
  projectMembers,
  projectOrThrow,
  revertOutlivesDirective,
  roleOf,
  taskOrThrow,
} from './lookups';
import type { UrgentInstructionView } from '../mcp/catalog';

/** 검수자 없음 보류(오류)의 refId — 적격 팀원이 없고 메인 에이전트도 기여자라 대신할 수 없음 (REV-06 v0.6). 메인이 resume_task로 재개하면 검수 등록부터 다시 */
export const NO_REVIEWER_HOLD_REF = 'no_reviewer';
/** 검수자 칸을 활동 기록·안내에 쓰는 말로 */
const reviewerLabel = (id: string | null): string => (id === MAIN_AGENT_ID ? '메인 에이전트' : (id ?? '없음'));
/**
 * 같은 검수자에게 검수를 다시 등록한 횟수 (kv, 리드 결정 17): 그 검수자와 횟수. 판정이 기록되거나 다른 검수자가 정해지면 지운다 — 다시 등록한 검수가
 * 또 판정 없이 끝나면 프로듀서에게 같은 검수자를 다시 권하지 않고 메인 에이전트에게 넘긴다 (turns.escalateReview). 재시작해도 남는다
 */
const redispatchKey = (taskId: string) => `reviewredispatch:${taskId}`;
interface ReviewRedispatch {
  reviewerId: string | null;
  count: number;
}
/** 검수자에게 보이는 그 작업의 긴급 지시 수 — 최근 것 (CTL-06) */
const OWNER_INSTRUCTIONS_MAX = 10;
/** 통과 뒤 그 검수자에게 온 대표 메시지로 미룬 통과 (kv 값: 그 통과의 검수 기록 ID) — 같은 검수자의 새 판정이 그 통과를 대신한다 (CTL-06) */
const rejudgeKey = (taskId: string) => `rejudge:${taskId}`;
/**
 * 그 미룸이 아직 풀리지 않았다는 기록 (kv, S7-B3): 그 통과의 검수자가 대표 메시지를 본 뒤의 검수 턴을 정상으로 마치거나(다시 판정하거나 바꾸지 않기로 함)
 * 대표가 정할 때까지 병합 판단·병합·산출물 확정을 미룬다 — 그 턴이 판정 기회 없이 끝나면(비정상 종료·사용량 한도·이어하기 실패 등) 풀리지 않는다.
 * 메시지가 대기열에서 빠진 뒤에도(턴에 실려 전달됨) 남으므로 재시작해도 그대로다
 */
const rejudgeWaitKey = (taskId: string) => `rejudgewait:${taskId}`;
interface RejudgeWait {
  /** 미룬 통과의 검수 기록 ID — 다른 통과(새 판정)면 듣지 않는다 */
  reviewId: string;
  reviewerId: string;
  since: string;
}
/** 다시 판정 턴이 상한까지 판정 기회 없이 끝나 대표에게 넘긴 보류(오류)의 refId — 대표가 재개하면 그 통과로 이어 간다 (S7-B3) */
export const REJUDGE_HOLD_REF = 'rejudge';
/** 같은 검수자의 다시 판정 실패 보류 중 대표 메시지가 가는 차례: 먼저 보류된 것, 같으면 작업 ID 순 (rejudgeHeldTaskFor, S8-B1) */
const byRejudgeHold = (a: { task: { id: string }; since: string }, b: { task: { id: string }; since: string }): number => a.since.localeCompare(b.since) || a.task.id.localeCompare(b.task.id);

export interface CreateTaskInput {
  directiveId: string;
  title: string;
  goal: string;
  type: TaskType;
  assigneeId: string;
  reviewerId?: string | null;
  priority?: Priority;
  prerequisiteIds?: string[];
  acceptanceCriteria: string[];
  plannedAreas?: string[];
  outputMode: OutputMode;
  revertOfTaskId?: string | null;
}

export interface UpdateTaskInput {
  priority?: Priority;
  prerequisiteIds?: string[];
  assigneeId?: string;
  reviewerId?: string;
  acceptanceCriteria?: string[];
  plannedAreas?: string[];
  goal?: string;
}

/**
 * 충돌 해결 안내 (GIT-07, CLI-09): 팀원은 git 없이 파일만 고치고, 스테이징·커밋은 report_conflict_resolved를 받은 프로그램이 한다.
 * 표시가 없는 충돌 파일(바이너리·한쪽에서 지운 파일 등)은 작업 폴더에 있는 그대로 커밋되므로 남길 내용을 직접 정하게 한다.
 * revertOf: 되돌리기 작업이면 되돌릴 원래 작업 — 되돌릴 변경만 취소하고 이후 변경은 남기는 7.1 규칙을 함께 적는다
 */
export function conflictFixGuide(files: readonly string[], unverifiable: readonly string[] = [], revertOf: string | null = null): string {
  const lines = [
    `충돌 파일: ${files.join(', ') || '(없음 — 해결 커밋만 남음)'}`,
    '충돌 표시(<<<<<<< ======= >>>>>>>)를 정리해 두 변경을 올바르게 합친 뒤 report_conflict_resolved를 호출하세요. git 명령은 쓰지 마세요 — 스테이징·커밋은 프로그램이 합니다.',
  ];
  if (revertOf) {
    lines.push(`되돌리기 작업입니다: ${revertOf}의 변경만 취소하고, 그 뒤 main에 들어온 다른 작업의 변경은 그대로 남기세요 — 이후 변경을 통째로 지우지 마세요 (7.1).`);
  }
  if (unverifiable.length) {
    lines.push(`충돌 표시가 없는 충돌 파일(바이너리·한쪽에서 지운 파일 등): ${unverifiable.join(', ')} — 남길 내용을 직접 정해 그 파일을 고치거나 지우세요. 작업 폴더에 있는 그대로 커밋됩니다.`);
  }
  return lines.join('\n');
}

/** 충돌 해결 안내에 넣을 되돌릴 원래 작업 (되돌리기 작업일 때만) */
function revertOfFor(t: Task): string | null {
  return isProgramRevert(t) ? t.revertOfTaskId : null;
}

/** 같은 파일 묶음인지 (순서 무관) — 같은 충돌인지 가리는 데 쓴다 (GIT-07) */
function sameFileSet(a: readonly string[], b: readonly string[]): boolean {
  const sa = new Set(a);
  const sb = new Set(b);
  return sa.size === sb.size && [...sa].every((f) => sb.has(f));
}

/** 안내·활동 기록에 넣을 파일 목록 (앞 5개) */
function fileList(files: readonly string[]): string {
  return files.length > 5 ? `${files.slice(0, 5).join(', ')} 외 ${files.length - 5}개` : files.join(', ');
}

/** 파일 목록 합치기 (중복 없이, 앞 목록부터) */
function unionFiles(...lists: (readonly string[] | undefined)[]): string[] {
  return [...new Set(lists.flatMap((l) => l ?? []))];
}

/** 두 파일 목록이 같은 내용인지 (경로·해시, 순서 무관) */
function sameFiles(a: readonly ArtifactFile[], b: readonly ArtifactFile[]): boolean {
  if (a.length !== b.length) return false;
  const key = (f: ArtifactFile) => `${f.path}\u0000${f.sha256}`;
  const sa = new Set(a.map(key));
  return b.every((f) => sa.has(key(f)));
}

/** 충돌 표시가 남은 이른 해결 보고에 돌려줄 안내 (예상한 거부, conflict) */
export function markersLeftMessage(files: readonly string[]): string {
  return `충돌 표시(<<<<<<< ======= >>>>>>>)가 아직 남아 있는 파일: ${files.join(', ')}. 두 변경을 올바르게 합쳐 표시를 모두 지운 뒤 다시 report_conflict_resolved를 호출하세요. git 명령은 쓰지 마세요.`;
}

/** 판정한 쪽이 본 검수 대상 (REV-07·08) — 판정을 그 버전에만 묶는 데 쓴다. 모르면 비워 둔다 */
export interface ReviewSeen {
  /**
   * 판정을 보낸 검수 턴이 띄워질 때 고정돼 있던 대상의 고정 시각 (턴 기록 `reviewPinnedAt` — 그 턴의 읽기용 사본이 이 버전). 지금 대상과 다르면
   * 그 턴은 이 버전을 보지 못했다. 같은 고정인지로 본다 — 시계가 뒤로 맞춰져도 바뀐 것이 없으면 판정을 받는다
   */
  turnPinnedAt?: string | null;
  /** 띄울 때의 고정을 남기지 않은 옛 턴 기록의 시작 시각 — turnPinnedAt이 없을 때만 (지금 대상이 그 뒤에 고정됐으면 이전 버전을 보던 턴) */
  turnStartedAt?: string | null;
}

/** 검수 턴이 지금 고정된 대상을 보지 못했는지 (REV-07·08): 띄울 때의 고정이 기록돼 있으면 같은 고정인지로, 옛 기록이면 시작 시각으로 */
export function reviewTurnStale(seen: Pick<ReviewSeen, 'turnPinnedAt' | 'turnStartedAt'>, pinnedAt: string): boolean {
  if (seen.turnPinnedAt !== undefined) return seen.turnPinnedAt !== pinnedAt;
  return !!seen.turnStartedAt && seen.turnStartedAt < pinnedAt;
}

export class TaskService {
  constructor(private readonly core: Core) {}

  private get ctx() {
    return this.core.ctx;
  }

  // ───────────────────────── 생성·수정 ─────────────────────────

  create(input: CreateTaskInput, actor: Actor): Task {
    const ctx = this.ctx;
    const d = directiveOrThrow(ctx, input.directiveId);
    if (!d.projectId) throw new BackendError('invalid', '메인 에이전트 직접 명령에는 작업을 만들 수 없습니다');
    if (!isDirectiveOpen(d) || d.state === 'awaiting_confirmation' || d.state === 'received') {
      throw new BackendError('conflict', `지시 ${d.id}은(는) 지금 작업을 추가할 수 없는 상태입니다`);
    }
    const project = projectOrThrow(ctx, d.projectId);
    const assignee = memberOrThrow(ctx, input.assigneeId);
    if (assignee.projectId !== project.id || assignee.deletedAt || assignee.isMain) {
      throw new BackendError('invalid', `담당 ${input.assigneeId}은(는) 이 프로젝트의 팀원이 아닙니다`);
    }
    const prereqs = [...new Set(input.prerequisiteIds ?? [])];
    for (const pid of prereqs) {
      const p = ctx.store.tasks.get(pid);
      if (!p || p.projectId !== project.id) throw new BackendError('invalid', `선행 작업 ${pid}을(를) 이 프로젝트에서 찾을 수 없습니다`);
    }
    const criteria = input.acceptanceCriteria.map((c) => c.trim()).filter(Boolean);
    if (criteria.length === 0) throw new BackendError('invalid', '완료 조건이 하나 이상 필요합니다');
    const now = ctx.now();
    const id = ctx.store.nextId('task');
    const draft: Task = {
      id,
      projectId: project.id,
      directiveId: d.id,
      round: d.round,
      title: input.title.trim(),
      goal: input.goal.trim(),
      type: input.type,
      priority: input.priority ?? 'normal',
      assigneeId: assignee.id,
      reviewerId: null,
      prerequisiteIds: prereqs,
      acceptanceCriteria: criteria,
      plannedAreas: input.plannedAreas ?? [],
      outputMode: input.outputMode,
      state: 'waiting',
      hold: { reasons: [], returnState: null },
      workspace: null,
      review: emptyReviewState(),
      contributors: [assignee.id],
      merge: null,
      artifact: null,
      revertOfTaskId: input.revertOfTaskId ?? null,
      revertedByTaskId: null,
      skillsUsed: [],
      pendingSubmit: null,
      conflict: null,
      crashRetries: 0,
      noProgressResumes: 0,
      createdBy: actor,
      createdAt: now,
      updatedAt: now,
      queuedAt: now,
      activatedAt: null,
      completedAt: null,
      cancelledAt: null,
    };
    draft.reviewerId = this.resolveReviewer(draft, input.reviewerId ?? null);
    ctx.store.tasks.insert(draft);
    ctx.store.transitions.append({
      entity: 'task',
      entityId: id,
      from: '-',
      event: 'create',
      to: 'waiting',
      reason: `${actor}가 생성`,
      actor,
      at: now,
      requestId: null,
    });
    ctx.activity({
      kind: 'task',
      actor,
      projectId: project.id,
      directiveId: d.id,
      taskId: id,
      memberId: assignee.id,
      text: `작업 생성 ${id} [${TASK_TYPE_LABEL[draft.type]}] ${draft.title} → 담당 ${assignee.name}, 검수 ${reviewerLabel(draft.reviewerId)}`,
    });
    ctx.bus.signal('tick');
    return draft;
  }

  /**
   * 검수자 결정: 지정값 검증 또는 기본 규칙 (REV-02, REV-06 v0.6). 'main'은 메인 에이전트(M-MAIN) — 적격 팀원이 없을 때의 대체 검수자다. 대표 검수('owner')는
   * 없앴다. 기본 규칙이 아무도 고르지 못하면(메인도 기여자) null — 검수 등록 때 보류하고 메인에게 알린다 (dispatchReview)
   */
  resolveReviewer(task: Task, requested: string | null): string | null {
    const ctx = this.ctx;
    if (requested === OWNER) throw new BackendError('invalid', '대표 검수("owner")는 없앴습니다 — 적격 팀원이 없으면 "main"(메인 에이전트)을 검수자로 정하세요 (REV-06)');
    if (requested === 'main') requested = MAIN_AGENT_ID;
    if (requested) {
      const m = ctx.store.members.get(requested);
      if (!m) throw new BackendError('invalid', `검수자 ${requested}을(를) 찾을 수 없습니다`);
      const ok = canBeReviewer(m, roleOf(ctx, m.roleId), task);
      if (!ok.ok) throw new BackendError('forbidden', `검수자 ${m.name}: ${ok.reason}`);
      return m.id;
    }
    return chooseReviewer(task, projectMembers(ctx, task.projectId), (r) => roleOf(ctx, r));
  }

  update(taskId: string, patch: UpdateTaskInput, actor: Actor): Task {
    const ctx = this.ctx;
    let task = taskOrThrow(ctx, taskId);
    if (isTerminal(task.state)) throw new BackendError('conflict', `작업 ${taskId}은(는) 이미 끝났습니다`);
    this.assertDirectiveOpen(task);
    // 내용·담당 변경은 진행으로 되돌리거나 활성을 지운다 — 병합·취소와 겹치면 main 반영과 작업 상태가 어긋난다
    if (patch.acceptanceCriteria || patch.goal || (patch.assigneeId && patch.assigneeId !== task.assigneeId)) this.assertChangeable(task);
    const changes: string[] = [];
    let basisChanged = false;
    if (patch.prerequisiteIds) {
      const ids = [...new Set(patch.prerequisiteIds)];
      for (const pid of ids) {
        if (pid === taskId) throw new BackendError('invalid', '자기 자신을 선행 작업으로 둘 수 없습니다');
        const p = ctx.store.tasks.get(pid);
        if (!p || p.projectId !== task.projectId) throw new BackendError('invalid', `선행 작업 ${pid}을(를) 찾을 수 없습니다`);
        if (this.dependsOn(pid, taskId)) throw new BackendError('invalid', `선행 관계가 순환합니다 (${pid} → ${taskId})`);
      }
      task = { ...task, prerequisiteIds: ids };
      changes.push(`선행 작업 ${ids.join(', ') || '없음'}`);
    }
    if (patch.priority) {
      task = { ...task, priority: patch.priority };
      changes.push(`우선순위 ${patch.priority}`);
    }
    if (patch.acceptanceCriteria) {
      const c = patch.acceptanceCriteria.map((s) => s.trim()).filter(Boolean);
      if (!c.length) throw new BackendError('invalid', '완료 조건이 하나 이상 필요합니다');
      // 빠지거나 바뀐 조건 글을 남긴다 — 이전 조건 목록을 보고 한 검수 결과가 바뀐 조건을 같은 자리로 덮지 않게 (REV-03, uncoveredCriteria).
      // 이번에 더해지거나 바뀐 조건도 앞 변경의 것에 더해 남긴다(통과가 기록되면 비움) — 그 조건은 같은 글의 결과로만 덮인다
      const former = [...new Set([...(task.formerCriteria ?? []), ...task.acceptanceCriteria])].filter((x) => !c.includes(x));
      const changed = changedCriteria(task.acceptanceCriteria, c, task.changedCriteria);
      task = {
        ...task,
        acceptanceCriteria: c,
        ...(former.length || task.formerCriteria ? { formerCriteria: former } : {}),
        ...(changed.length || task.changedCriteria ? { changedCriteria: changed } : {}),
      };
      changes.push('완료 조건 변경');
      basisChanged = true;
    }
    if (patch.plannedAreas) {
      task = { ...task, plannedAreas: patch.plannedAreas };
      changes.push('수정 예정 영역 변경');
    }
    if (patch.goal) {
      task = { ...task, goal: patch.goal };
      changes.push('목표 변경');
      basisChanged = true;
    }
    // 검수자는 검증·기록만 먼저 하고, 실제 교체(대기·실행 중 검수 정리 → 새 검수자에게 등록)는 기준 변경 처리 뒤에 한다 —
    // 기준 변경으로 진행에 돌아가는 작업에 검수를 등록했다가 바로 무효가 되지 않게 (CONC-11)
    const reviewer = patch.reviewerId !== undefined ? this.resolveReviewer(task, patch.reviewerId) : undefined;
    if (reviewer !== undefined) changes.push(`검수자 ${reviewer}`);
    ctx.store.tasks.put({ ...task, updatedAt: ctx.now() });
    if (basisChanged) {
      const cur = taskOrThrow(ctx, taskId);
      if (cur.state === 'on_hold') transitionTask(ctx, taskId, { type: 'basis_changed', note: changes.join(', ') }, actor);
      else if (cur.state === 'in_review') {
        // 검수 기준이 바뀌면 다시 진행 → 새 버전 제출 (REV-07). 바뀌기 전 기준·버전으로 돌던 검수 턴과 대기 중 검수는 쓸모가 없으므로
        // 끝내고 지운다(재배정·검수자 교체와 같게). 새 버전 검수는 다시 제출해 대상을 고정할 때 등록된다. 끝내는 사이 그 턴이 보낸
        // 판정은 새 버전에 묶이지 않는다 (submitReview — 지금 대상보다 먼저 시작한 턴의 판정은 받지 않음)
        transitionTask(ctx, taskId, { type: 'reopen', reason: '검수 기준 변경' }, actor);
        void this.core.turns.stopSessions([reviewKey(taskId)], '검수 기준 변경', true);
        // 검수자에게 온 대표 직접 메시지는 남긴다 — 다시 제출해 새 버전을 검수할 때 그 검수 세션 맨 앞에 간다 (AC-36)
        cancelQueued(ctx, (q) => q.sessionKey === reviewKey(taskId) && !isUrgentDirect(q));
        // 아직 시작 중(프로세스를 띄우기 전)인 검수 턴이 실은 항목도 지운다 — 띄우기 전에 멈춘 턴의 항목은 대기열로 돌아가므로, 두면 이전 버전의
        // 사본 위치·완료 조건이 다음 버전 검수 요청에 섞인다 (REV-07·08). 대표 직접 메시지는 그대로 대기열로 돌아가 다음 검수 턴에 간다
        ctx.store.tx(() => {
          const gone = ctx.store.queue.list({ ref2: reviewKey(taskId), state: 'running' }).filter((q) => !isUrgentDirect(q));
          for (const q of gone) ctx.store.queue.put({ ...q, state: 'cancelled', doneAt: ctx.now() });
          noteMessagesUndelivered(ctx, gone, `${taskId}의 검수 기준이 바뀜`);
        });
        this.continueWork(taskId, `완료 조건·목표가 바뀌었습니다: ${changes.join(', ')}. 바뀐 기준에 맞춰 확인하고 다시 제출하세요.`);
      }
    }
    if (reviewer !== undefined) this.changeReviewer(taskId, reviewer, '검수자 변경');
    if (patch.assigneeId && patch.assigneeId !== task.assigneeId) this.reassign(taskId, patch.assigneeId, actor);
    ctx.activity({ kind: 'task', actor, projectId: task.projectId, taskId, text: `작업 ${taskId} 수정: ${changes.join(', ') || '변경 없음'}` });
    ctx.bus.signal('tick');
    return taskOrThrow(ctx, taskId);
  }

  private dependsOn(taskId: string, target: string, seen = new Set<string>()): boolean {
    if (taskId === target) return true;
    if (seen.has(taskId)) return false;
    seen.add(taskId);
    const t = this.ctx.store.tasks.get(taskId);
    return !!t && t.prerequisiteIds.some((p) => this.dependsOn(p, target, seen));
  }

  /**
   * 취소·종료된 지시의 작업은 내용·계획을 바꾸거나 다시 진행시키지 않는다 — 지시 취소가 그 작업을 취소하는 중이다 (TSK-09, AC-46).
   * 지시 취소 전에 이미 받아 처리 중이던 프로듀서 요청(update_task·replan_task·resolve_hold)도 여기서 거부된다. 되돌리기 작업은 예외.
   * releasesMerged: 보류 해제(대표 재개·막힘 해제)는 main에 병합이 이미 반영된 작업이면 받는다 — 그 작업은 완료 결과라 지시 취소가 취소하지 않고
   * (5.3 '완료 결과는 유지', AC-46), 해제는 다시 병합하지 않고 완료만 한다(afterRelease → finishMerged). 막으면 그 작업은 영영 보류로 남는다
   */
  private assertDirectiveOpen(task: Task, o: { releasesMerged?: boolean } = {}): void {
    if (o.releasesMerged && task.merge) return;
    if (closedDirectiveWork(this.ctx, null, task)) {
      throw new BackendError('conflict', `${task.id}의 지시 ${task.directiveId}이(가) 취소·종료돼 이 작업은 더 진행하지 않습니다`);
    }
  }

  /** 병합 중·병합 반영됨·취소 중인 작업은 내용·담당을 바꾸지 않는다 (F2: 바꾸면 main 반영과 작업 상태가 어긋난다) */
  private assertChangeable(task: Task): void {
    if (this.cancelling.has(task.id)) throw new BackendError('conflict', `${task.id}은(는) 취소 처리 중입니다`);
    if (this.core.merges.isPending(task.id)) throw new BackendError('conflict', `${task.id}은(는) 지금 병합 중입니다. 병합이 끝난 뒤 다시 요청하세요`);
    if (task.merge) {
      throw new BackendError('conflict', `${task.id}은(는) 이미 main에 병합됐습니다 (재개되면 완료 처리). 바꿀 것이 있으면 새 작업으로 만드세요`);
    }
  }

  /** 지금 이 작업의 담당을 바꿀 수 없는 까닭 (없으면 null) — 직원 교체(team.replaceMember)가 아무것도 바꾸기 전에 그 직원의 모든 작업을 본다 */
  reassignBlocker(task: Task): string | null {
    if (isTerminal(task.state)) return null;
    try {
      this.assertChangeable(task);
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }

  /** 재배정: 진행·검수 중이면 실행을 끝내고 보류→재배정→대기로 (전이표 준수) */
  reassign(taskId: string, assigneeId: string, actor: Actor): void {
    const ctx = this.ctx;
    const task = taskOrThrow(ctx, taskId);
    const m = memberOrThrow(ctx, assigneeId);
    if (m.projectId !== task.projectId || m.deletedAt || m.isMain) throw new BackendError('invalid', `${assigneeId}은(는) 이 프로젝트 팀원이 아닙니다`);
    if (isTerminal(task.state)) throw new BackendError('conflict', `작업 ${taskId}은(는) 이미 끝났습니다`);
    this.assertChangeable(task);
    if (task.state === 'in_progress' || task.state === 'in_review') {
      // 진행 중인 검수 턴도 끝낸다 — 재배정으로 검수 대상이 지워지므로 그 검수는 쓸모가 없다
      void this.core.turns.stopSessions([taskKey(taskId), reviewKey(taskId)], '재배정', true);
      transitionTask(ctx, taskId, { type: 'hold', reason: this.reason('interrupted', 'task', '재배정', actor) }, actor);
    }
    // 재배정 전이가 중단·이전 담당 정지·막힘 사유를 함께 풀고, 남은 사유가 없으면 대기로 돌린다 (9장, CORE-01)
    transitionTask(ctx, taskId, { type: 'reassign', assigneeId }, actor);
    const cur = taskOrThrow(ctx, taskId);
    // 이전 담당의 작업 세션은 닫는다 (새 담당은 새 세션, MEM-10). 지워진 검수 대상의 검수 업무·세션도 정리한다
    this.core.turns.closeSessions(taskKey(taskId), '재배정');
    this.core.turns.closeSessions(reviewKey(taskId), '재배정');
    cancelQueued(ctx, (q) => q.sessionKey === taskKey(taskId) || q.sessionKey === reviewKey(taskId), `${taskId}이(가) 다른 팀원에게 재배정돼 그 업무 세션이 닫힘`);
    if (cur.reviewerId === assigneeId) {
      ctx.store.tasks.patch(taskId, { reviewerId: this.resolveReviewer(taskOrThrow(ctx, taskId), null) });
    }
    this.core.team.applyPendingAiIfIdle(task.assigneeId);
    ctx.bus.signal('tick');
  }

  // ───────────────────────── 단계 (TSK-06, GIT-05) ─────────────────────────

  setSteps(taskId: string, titles: string[]): Step[] {
    const ctx = this.ctx;
    const existing = ctx.store.steps.list(taskId);
    const done = existing.filter((s) => s.done);
    const doneTitles = new Set(done.map((s) => s.title.trim()));
    const fresh = titles.map((t) => t.trim()).filter((t) => t && !doneTitles.has(t));
    const steps: Step[] = [
      ...done.map((s, i) => ({ ...s, idx: i })),
      ...fresh.map((title, j) => ({ taskId, idx: done.length + j, title, done: false, doneAt: null, commitSha: null, note: '' })),
    ];
    ctx.store.steps.replaceAll(taskId, steps);
    ctx.bus.changed();
    return steps;
  }

  addSteps(taskId: string, titles: string[]): Step[] {
    const ctx = this.ctx;
    const existing = ctx.store.steps.list(taskId);
    const add = titles.map((t) => t.trim()).filter(Boolean);
    const steps = [...existing, ...add.map((title, j) => ({ taskId, idx: existing.length + j, title, done: false, doneAt: null, commitSha: null, note: '' }))];
    ctx.store.steps.replaceAll(taskId, steps);
    ctx.bus.changed();
    return steps;
  }

  /** 처리 중인 단계 완료 (작업:단계 → 그 처리) — 같은 단계 완료가 겹쳐 오면 두 번 커밋·집계하지 않고 첫 결과를 돌려준다 (CONC-08, ERR-07) */
  private readonly completingSteps = new Map<string, Promise<{ step: Step; commitSha: string | null; already: boolean }>>();

  async completeStep(taskId: string, idx: number, note: string, member: Member, turnId: string | null): Promise<{ step: Step; commitSha: string | null; already: boolean }> {
    const key = `${taskId}:${idx}`;
    const running = this.completingSteps.get(key);
    if (running) return { ...(await running), already: true };
    const job = this.completeStepInner(taskId, idx, note, member, turnId);
    this.completingSteps.set(key, job);
    try {
      return await job;
    } finally {
      this.completingSteps.delete(key);
    }
  }

  private async completeStepInner(taskId: string, idx: number, note: string, member: Member, turnId: string | null): Promise<{ step: Step; commitSha: string | null; already: boolean }> {
    const ctx = this.ctx;
    const task = taskOrThrow(ctx, taskId);
    const steps = ctx.store.steps.list(taskId);
    const step = steps.find((s) => s.idx === idx);
    if (!step) throw new BackendError('invalid', `단계 ${idx}이(가) 없습니다. 현재 단계: ${steps.map((s) => `${s.idx}:${s.title}`).join(' / ') || '없음'}`);
    if (step.done) return { step, commitSha: step.commitSha, already: true };
    let commitSha: string | null = null;
    if (task.workspace) {
      const st = await ctx.deps.git.status(task.workspace.worktreePath);
      if (!st.clean) {
        if (st.unmerged.length) throw new BackendError('conflict', `충돌이 해결되지 않은 파일이 있습니다: ${st.unmerged.join(', ')}`);
        // 산출물형이라도 저장소 파일이 바뀌면 변경형으로 전환 (5.2)
        if (task.outputMode === 'artifact') this.switchToRepo(task);
        const project = projectOrThrow(ctx, task.projectId);
        commitSha = await recordedExec(
          ctx,
          {
            kind: 'git_commit',
            projectId: project.id,
            taskId,
            cwd: task.workspace.worktreePath,
            command: `git commit -m "[${taskId}] ${step.title}"`,
            target: task.workspace.branch,
            pre: { step: idx, head: await ctx.deps.git.revParse(task.workspace.worktreePath, 'HEAD') },
          },
          async () => {
            const sha = await ctx.deps.git.commitAll(task.workspace!.worktreePath, `[${taskId}] ${step.title}`, memberIdentity(member));
            return { value: sha, result: { sha } };
          },
        );
      }
    }
    // git을 기다리는 사이 다른 경로가 이 단계를 끝냈으면 그 기록(실제 커밋 SHA)을 덮지 않는다
    const latest = ctx.store.steps.list(taskId).find((s) => s.idx === idx);
    if (latest?.done) return { step: latest, commitSha: latest.commitSha, already: true };
    const done: Step = { ...step, done: true, doneAt: ctx.now(), commitSha, note };
    ctx.store.steps.put(done);
    ctx.store.tasks.patch(taskId, { noProgressResumes: 0, crashRetries: 0, checkFailStreak: 0, updatedAt: ctx.now() });
    if (turnId) this.core.turns.noteStepProgress(turnId);
    ctx.activity({
      kind: 'task',
      actor: member.id,
      projectId: task.projectId,
      taskId,
      memberId: member.id,
      turnId,
      text: `${taskId} 단계 ${idx + 1} 완료: ${step.title}${commitSha ? ` (커밋 ${commitSha.slice(0, 8)})` : ''}`,
    });
    return { step: done, commitSha, already: false };
  }

  // ───────────────────────── 제출 → 자동 검사 → 대상 고정 (REV-01, GIT-06 앞부분) ─────────────────────────

  requestSubmit(taskId: string, note: string, member: Member): { message: string } {
    const ctx = this.ctx;
    const task = taskOrThrow(ctx, taskId);
    if (task.state !== 'in_progress') throw new BackendError('conflict', `작업 ${taskId}은(는) 진행 상태가 아닙니다 (${task.state})`);
    // 충돌 해결 중에는 제출이 아니라 해결 보고가 할 일이다 — 제출 요청은 이미 남아 있고, 해결 보고 뒤 프로그램이 이어서 처리한다 (GIT-07)
    if (task.conflict) throw new BackendError('conflict', `병합 충돌이 아직 해결되지 않았습니다. ${conflictFixGuide(task.conflict.files, task.conflict.unverifiable, revertOfFor(task))}`);
    const steps = ctx.store.steps.list(taskId);
    const left = steps.filter((s) => !s.done);
    if (steps.length === 0) throw new BackendError('invalid', '단계가 없습니다. set_steps로 단계를 만들고 완료한 뒤 제출하세요');
    if (left.length) {
      throw new BackendError('invalid', `남은 단계가 있습니다: ${left.map((s) => `${s.idx}:${s.title}`).join(' / ')}. 완료하거나 필요 없으면 set_steps로 정리하세요`);
    }
    if (task.pendingSubmit) return { message: '이미 검수 요청을 받았습니다. 턴을 마치세요.' };
    // 제출 요청 자체는 진척이 아니다 — 진척 없는 재개 수를 되돌리지 않는다 (CLI-18: 다시 세는 것은 단계 완료·받아들인 해결 커밋·대상 고정·
    // 검수 판정·재계획). 되돌리면 검사가 계속 실패하는 작업이 제출만 되풀이하며 헛돌기에 닿지 않는다. 검사를 거쳐 대상이 고정되면(submit 전이)
    // 다시 센다 — 반려 뒤 재작업 턴은 처음부터. 제출 처리에서 생긴 충돌의 해결 턴은 그 충돌 기록에 따로 센다 (TaskConflict.unresolvedTurns — 새 충돌이면 0부터)
    ctx.store.tasks.patch(taskId, { pendingSubmit: { requestedAt: ctx.now(), note } });
    ctx.activity({ kind: 'task', actor: member.id, projectId: task.projectId, taskId, memberId: member.id, text: `${taskId} 검수 요청 접수: ${note}` });
    return { message: '검수 요청을 받았습니다. 지금 턴을 마치세요. 턴이 끝나면 프로그램이 최신 main 반영·자동 검사 후 검수자에게 넘깁니다.' };
  }

  /** 제출 처리 중인 작업 → 그 처리 (같은 작업을 겹쳐 처리하지 않고, 취소가 끝나기를 기다리는 데 씀) */
  private readonly submitting = new Map<string, Promise<void>>();
  /** 취소 처리 중인 작업 → 그 처리 (보류는 이미 저장됨) */
  private readonly cancelling = new Map<string, Promise<void>>();

  /** 제출 처리(최신 main 반영·자동 검사·대상 고정) 중인지 — 그동안 이 작업 폴더에 새 턴을 띄우지 않는다 (5.3 진행→검수) */
  isSubmitting(taskId: string): boolean {
    return this.submitting.has(taskId);
  }

  /** 제출 처리 중인 작업이 하나라도 있는지 — CLI 턴이 없어도 진행 중 작업이다 (절전 방지·완전 종료 확인, ENV-09·11, AC-31) */
  hasSubmitting(): boolean {
    return this.submitting.size > 0;
  }

  /** 취소 처리 중인지 */
  isCancelling(taskId: string): boolean {
    return this.cancelling.has(taskId);
  }

  /** 취소 처리 중인 작업이 하나라도 있는지 — 취소의 git 단계(중간 결과 보관·작업 폴더 정리)는 잠금 밖에서 돈다. 앱 종료가 기다린다 (S7-D2) */
  hasCancelling(): boolean {
    return this.cancelling.size > 0;
  }

  /** 턴·하위 프로세스 종료 확인 후 호출 (15.4: 검수 요청 → 자동 검사·버전 고정 후 검수자 관리 대기열) */
  async processSubmission(taskId: string): Promise<void> {
    if (this.submitting.has(taskId)) return;
    const job = this.runSubmission(taskId);
    this.submitting.set(taskId, job);
    // 진행 중 작업 여부(절전 방지)가 바뀌었을 수 있다 — 턴이 끝난 뒤의 제출 처리·자동 검사도 진행 중 작업이다 (AC-31)
    this.ctx.bus.changed();
    try {
      await job;
    } finally {
      this.submitting.delete(taskId);
      this.ctx.bus.changed();
      // 처리하는 동안 미뤄 둔 이 작업의 업무를 바로 시작할 수 있게
      this.ctx.bus.signal('tick');
    }
  }

  /** 진행 중인 제출 처리가 끝날 때까지 기다린다 (없으면 바로) */
  private async submissionSettled(taskId: string): Promise<void> {
    await this.submitting.get(taskId);
  }

  private async runSubmission(taskId: string): Promise<void> {
    try {
      await this.processSubmissionInner(taskId);
    } catch (e) {
      const ctx = this.ctx;
      const msg = e instanceof Error ? e.message : String(e);
      ctx.log('error', `제출 처리 실패 ${taskId}`, e);
      const t = ctx.store.tasks.get(taskId);
      if (t && !isTerminal(t.state)) {
        this.hold(taskId, 'error', 'task', `검수 제출 처리 실패: ${msg}`, 'system');
        // 이 보류는 메인 에이전트에게 알림 업무로 간다(alert submit-fail:<작업>) — 보류한 뒤 넘기고 대표 알림은 넘긴 사실을 쓴다 (리드 결정 40·S5-7·S5-9)
        const handed = alertTaskHold(ctx, 'submit-fail', taskId, { cause: '검수 제출 처리(최신 main 반영·자동 검사·대상 고정)가 실패해 보류됨' });
        ctx.notify({
          level: 'urgent',
          title: '검수 제출 처리 실패',
          body: `${taskId}: ${msg} — 작업을 보류${handed ? `하고 ${OWNER_HANDED}` : `했습니다. ${ownerExit(false)}`}`,
          link: { tab: 'projects', projectId: t.projectId, taskId },
          key: `submit-fail:${taskId}`,
        });
      }
    }
  }

  private async processSubmissionInner(taskId: string): Promise<void> {
    const ctx = this.ctx;
    const git = ctx.deps.git;
    // 계속해도 되는지: 진행 + 제출 요청 + 실행 허용. git·검사를 기다리는 사이 정지·보류·취소되면
    // 제출 요청을 남겨 두고 멈춘다 — 재개(afterRelease)·재시작 복구 때 처음부터 다시 처리 (CTL-09).
    // 지시가 취소·종료됐으면(지시 취소가 그 작업들을 취소하는 중) 검사·검수로 넘기지 않는다 (AC-46, 되돌리기 작업은 예외)
    const current = (): Task | null => {
      const t = ctx.store.tasks.get(taskId);
      return t && t.state === 'in_progress' && t.pendingSubmit && this.core.stops.runAllowedForTask(t) && !closedDirectiveWork(ctx, null, t) ? t : null;
    };
    let task = current();
    if (!task) return;
    if (this.core.turns.hasLiveSession(taskKey(taskId))) return; // 턴이 끝난 뒤에
    const project = projectOrThrow(ctx, task.projectId);
    const assignee = memberOrThrow(ctx, task.assigneeId);
    if (!task.workspace) throw new Error('작업 공간이 없습니다');
    const ws = task.workspace;
    const wt = ws.worktreePath;
    const base = project.baseBranch;

    const st = await git.status(wt);
    if (!(task = current())) return;
    if (st.unmerged.length || st.mergeInProgress) {
      // 해결 보고를 받았는데 커밋 전에 끊겼으면(앱 종료·재시작) 그 보고대로 프로그램이 마저 커밋하고 이어 간다 (CLI-09).
      // 그사이 충돌 표시가 다시 보이면 보고를 무르고 해결 업무로 돌린다
      const resolver = st.mergeInProgress && task.conflict?.resolverId ? ctx.store.members.get(task.conflict.resolverId) : null;
      if (resolver) {
        const r = await this.commitConflictResolution(task, resolver, '해결 보고 뒤 끊긴 커밋 마무리');
        if (!('markers' in r)) return this.processSubmissionInner(taskId);
        if (!(task = current())) return;
      }
      // 작업 폴더에 충돌이 남았는데 기록이 없으면(기록 전에 끊김) 기록한다 — 해결 못 한 해결 턴을 진척 없는 재개로 세어
      // 헛돌기로 프로듀서에게 넘기려면 기록이 있어야 한다 (GIT-07, CLI-18)
      if (!task.conflict) {
        const merging = st.mergeInProgress ? await git.revParse(wt, 'MERGE_HEAD').catch(() => null) : null;
        const unverifiable = await this.unverifiableNow(taskId, wt);
        ctx.store.tasks.patch(taskId, { conflict: this.nextConflict(taskId, st.unmerged, merging, unverifiable).conflict });
        if (!(task = current())) return;
      }
      const files = st.unmerged.length ? st.unmerged : (task.conflict?.files ?? []);
      // 되돌리기 작업의 충돌은 프로듀서가 먼저 계획한다 — 충돌을 기록한 뒤 보류하기 전에 끊겼으면(재시작) 여기서 보류한다 (7.1, AC-12)
      if (this.revertConflictNeedsPlan(task)) return this.holdRevertConflict(task, files, base);
      const turns = task.conflict?.unresolvedTurns ?? 0;
      enqueue(ctx, {
        kind: 'conflict_fix',
        memberId: task.assigneeId,
        sessionKey: taskKey(taskId),
        projectId: task.projectId,
        taskId,
        priority: task.priority,
        message: `충돌이 아직 해결되지 않았습니다${turns ? ` (해결 보고 없이 끝난 해결 턴 ${turns}/${ctx.settings().execution.spinNoProgressResumes})` : ''}.\n${conflictFixGuide(files, task.conflict?.unverifiable, revertOfFor(task))}`,
        dedupeKind: true,
      });
      return;
    }
    if (task.conflict) {
      // 진행 중인 병합이 없는데 충돌 기록이 남았다. 그 병합이 마무리됐으면(해결 커밋 뒤 기록 전에 끊김 등) 기록을 정리하고 이어 간다 — 아래 최신
      // main 반영이 다시 확인한다. 취소됐으면(팀원이 git merge --abort 등) 해결된 것이 없다: 기록을 그대로 두고 아래 최신 main 반영으로 가린다 —
      // 여전히 충돌하면 충돌 표시를 되살리고 같은 충돌로 since·해결 못 한 턴 수를 이어 간다(지우고 새로 기록하면 병합 취소·보고를 되풀이하는 턴이
      // 끝없이 돈다, GIT-07·CLI-18). 충돌 없이 반영되면 그때 기록을 정리한다 (저장소에 충돌이 없다, REV-07)
      const concluded = await this.mergeConcluded(wt, task.conflict, project);
      if (!(task = current())) return;
      if (concluded) {
        if ((await this.settleConflictRecord(taskId, wt, 'concluded', base, current)) !== true) return;
      } else {
        ctx.activity({
          kind: 'git',
          level: 'warn',
          projectId: project.id,
          taskId,
          text: `${taskId} 작업 폴더에 진행 중인 병합이 없는데 충돌(${task.conflict?.files.join(', ') ?? ''})은 해결되지 않음 (병합 취소로 보임) — 최신 ${base}을(를) 다시 반영해 확인 (여전히 충돌하면 충돌 표시를 되살리고, 충돌 없이 반영되면 기록을 정리)`,
        });
      }
      if (!(task = current())) return;
    }
    const baseSha = await git.revParse(project.path, `refs/heads/${base}`);
    if (!baseSha) throw new Error(`기준 브랜치 ${base}을(를) 찾을 수 없습니다`);
    // 산출물형 전환은 이 작업이 바꾼 것만 본다 (5.2 '추적 파일이 바뀌면', AC-47): 커밋하지 않은 변경, 또는 작업 브랜치가 main에서
    // 갈라진 지점 이후의 변경. main ↔ HEAD 두 점 비교는 작업 폴더를 만든 뒤 다른 작업이 main에 병합한 변경까지 보여 준다
    const ahead = task.outputMode === 'artifact' && (await this.changedSinceFork(wt, baseSha));
    if (!(task = current())) return;
    if (task.outputMode === 'artifact' && (ahead || !st.clean)) {
      this.switchToRepo(task);
      task = taskOrThrow(ctx, taskId);
    }

    let target: ReviewTarget;
    if (task.outputMode === 'repo') {
      if (!st.clean) {
        // 대표가 확인하고 재개한, 종료를 확인하지 못한 검사가 남긴 파일은 커밋하지 않는다 — 확인한 검사와 같게 거부 (S8-C1). 작업 폴더 HEAD가 그
        // 검사한 버전 그대로일 때만 — 그 뒤 커밋이 생겼으면(재개 때 충돌 해결 등) 커밋하고 새 버전을 다시 검사 (S10-C1)
        const headNow = await git.revParse(wt, 'HEAD');
        if (!(task = current())) return;
        if (this.refuseConfirmedCheckLeftovers(task, st.files.map((f) => f.path), headNow)) return;
        await recordedExec(
          ctx,
          { kind: 'git_commit', projectId: project.id, taskId, cwd: wt, command: `git commit -m "[${taskId}] 제출 전 변경 정리"`, target: ws.branch },
          async () => ({ value: await git.commitAll(wt, `[${taskId}] 제출 전 변경 정리`, memberIdentity(assignee)) }),
        );
        if (!(task = current())) return;
      }
      // 최신 main 반영 (GIT-06)
      const upd = await recordedExec(
        ctx,
        { kind: 'git_update_from_base', projectId: project.id, taskId, cwd: wt, command: `git merge ${base}`, target: ws.branch, pre: { baseSha } },
        async () => {
          const r = await git.mergeBaseInto(wt, base, `[${taskId}] 최신 ${base} 반영`, memberIdentity(null));
          return { value: r, result: r.ok ? { sha: r.sha, upToDate: r.upToDate } : { conflicts: r.conflicts } };
        },
      );
      if (!upd.ok) {
        // 충돌은 작업 폴더에 남으므로 정지 여부와 관계없이 기록한다. 해결 요청은 실행해도 될 때만.
        // 충돌이 났다는 것은 진척이 아니다. 같은 충돌(같은 파일, 그 사이 받아들인 해결 커밋 없음 — 병합을 취소한 뒤 다시 반영한 경우 등)이면
        // since·해결 못 한 턴 수·헛돌기 횟수를 이어 간다: 새로 기록하면 병합 취소·보고를 되풀이하는 턴이 끝없이 돌고 대표 보고도 놓친다 (GIT-07, CLI-18)
        const merging = await git.revParse(wt, 'MERGE_HEAD').catch(() => null);
        // 표시가 없는 충돌 파일(바이너리·한쪽이 지운 파일 등)은 따로 안내한다 — 작업 폴더에 있는 그대로 커밋되므로 남길 내용을 직접 정하게. 팀원이 손대기 전인
        // 지금 확인해 충돌 기록에 남긴다 — 팀원이 그 파일을 직접 스테이징해 인덱스에서 충돌이 풀려도 재검수 요청에 계속 적는다 (GIT-07)
        const scanned = await this.unverifiableNow(taskId, wt);
        const { conflict, continued: again } = this.nextConflict(taskId, upd.conflicts, merging ?? baseSha, scanned);
        ctx.store.tasks.patch(taskId, { conflict });
        ctx.activity({
          kind: 'git',
          level: 'warn',
          projectId: project.id,
          taskId,
          text: `${taskId} 최신 ${base} 반영 중 충돌: ${upd.conflicts.join(', ')}${again ? ` (같은 충돌을 되살림 — 해결 못 한 해결 턴 ${conflict.unresolvedTurns ?? 0}회에 이어서 셈)` : ''}`,
        });
        const unverifiable = conflict.unverifiable;
        if (!(task = current())) return;
        // 되돌리기 작업이 최신 main을 반영하다 충돌하면 담당에게 일반 충돌 해결로 넘기지 않고 보류한다 — 어떤 작업까지 함께 조정할지 프로듀서가
        // 계획한다 (GIT-10 '충돌·의존성 문제가 있으면 자동 완료하지 않고 보류', 7.1, AC-12 — 의존성·검사 실패 보류와 같게)
        if (this.revertConflictNeedsPlan(task)) return this.holdRevertConflict(task, upd.conflicts, base);
        const lead = again
          ? `작업 폴더에 진행 중인 병합이 없어(병합 취소 등) 충돌이 해결되지 않았습니다. 프로그램이 최신 ${base}을(를) 다시 반영해 충돌 표시를 되살렸습니다 — git 명령은 쓰지 마세요 (해결 보고 없이 끝난 해결 턴 ${conflict.unresolvedTurns ?? 0}/${ctx.settings().execution.spinNoProgressResumes}).`
          : `최신 ${base}를 반영하다 충돌이 났습니다 (GIT-07).`;
        enqueue(ctx, {
          kind: 'conflict_fix',
          memberId: task.assigneeId,
          sessionKey: taskKey(taskId),
          projectId: task.projectId,
          taskId,
          priority: task.priority,
          message: `${lead}\n${conflictFixGuide(upd.conflicts, unverifiable, revertOfFor(task))}`,
          dedupeKind: true,
        });
        return;
      }
      if (!(task = current())) return;
      if (task.conflict) {
        // 병합을 취소해 남겨 둔 충돌 기록인데 다시 반영한 최신 main이 충돌 없이 들어왔다 (팀원이 손으로 맞췄거나 그사이 main이 바뀜). 저장소에 충돌이
        // 없으니 기록과 횟수를 정리하고 제출 처리를 이어 간다 — 남겨 두면 지나간 충돌로 검수·재작업 제출 거부·헛돌기가 이어진다 (REV-07, GIT-07, CLI-18).
        // 기록된 충돌 파일은 마무리된 병합과 같게 내용으로 본다 (재시작 뒤 같은 처리는 마무리된 병합으로 같은 확인을 한다)
        if ((await this.settleConflictRecord(taskId, wt, 'remerged', base, current)) !== true) return;
        if (!(task = current())) return;
      }
      // 자동 검사 (REV-01)
      ctx.store.tasks.patch(taskId, { review: { ...task.review, autoCheck: { status: 'running', detail: '', at: ctx.now() } } });
      const check = await this.core.checks.run(task, project, wt, upd.sha);
      const checked = current();
      if (check.stopped || !checked) {
        // 검사 중 정지·보류·취소 → 결과로 치지 않고 제출 요청을 남겨 재개 때 다시 검사 (CTL-09). 종료를 확인하지 못해 보류한 검사는 재개 때 그 결과로 이어 간다 (resumeNote, S7-C2)
        const t = taskOrThrow(ctx, taskId);
        ctx.store.tasks.patch(taskId, { review: { ...t.review, autoCheck: { status: 'not_run', detail: check.resumeNote ?? '정지로 중단 — 재개 때 다시 검사', at: ctx.now() } } });
        return;
      }
      task = checked;
      // 검사 통과만으로는 이어진 제출 거부 수를 되돌리지 않는다 — 통과한 뒤 거부되는 제출(검사 뒤 커밋되지 않은 파일 등)도 이어서 센다. 대상을 고정하면 0 (ERR-04)
      ctx.store.tasks.patch(taskId, { review: { ...task.review, autoCheck: { status: check.status, detail: check.detail, at: ctx.now() } } });
      if (check.status === 'failed' && isProgramRevert(task)) {
        // 되돌린 결과가 검사에 실패하면 일반 재작업으로 넘기지 않고 보류한다 — 어떤 작업까지 함께 조정할지 프로듀서가 계획한다 (7.1, AC-12).
        // 재계획 뒤에는 (다시 맡은) 담당이 이 작업 폴더에서 조정해 다시 제출한다 — 다른 작업으로 조정했으면 바로 제출하면 최신 main으로 다시 검사
        const origId = task.revertOfTaskId!;
        ctx.store.tx(() => {
          ctx.store.tasks.patch(taskId, { pendingSubmit: null });
          this.core.merges.holdRevert(
            taskId,
            `되돌리기 자동 검사 실패: ${check.detail.slice(0, 300)}`,
            `${origId} 되돌리기(${taskId})의 결과(최신 ${base} + 되돌리기)가 자동 검사에 실패해 보류했습니다. main은 그대로입니다. 검사 출력:\n${check.detail.slice(0, 1500)}\n`,
            `다른 작업으로 조정한다면 그 작업이 main에 병합된 뒤, 이 되돌리기 안에서 고치게 하려면 그대로(또는 assignee_id로 맡길 팀원을 정해) replan_task(task_id="${taskId}")를 호출하세요 — 담당이 이 작업 폴더에서 확인·조정한 뒤 다시 제출하면 최신 ${base}를 반영해 다시 검사합니다. 되돌리지 않기로 했으면 cancel_task(task_id="${taskId}").`,
          );
        });
        ctx.activity({ kind: 'revert', level: 'warn', projectId: project.id, taskId, text: `${taskId} 되돌리기 결과 자동 검사 실패 — 보류(재계획), 프로듀서가 조정 범위를 계획`, result: check.detail.slice(0, 500) });
        return;
      }
      if (check.status === 'failed') {
        // 자동 재시도에는 상한을 둔다 (ERR-04, 8장 헛돌기 '같은 오류·명령 실패'): 제출 턴은 진척 없는 재개로 세지 않으므로, 단계 진척 없이
        // 거부된 제출 뒤 다시 제출하기만 되풀이하면 여기서만 멈출 수 있다 — 이어진 거부가 상한이면 헛돌기 보류 + 프로듀서 [replan] (refuseSubmission)
        const refused = this.refuseSubmission(taskId, '자동 검사 실패', check.detail.slice(0, 500));
        if (!refused) return;
        this.continueWork(
          taskId,
          `자동 검사에 실패했습니다 (이어진 실패 ${refused.streak}/${refused.limit} — ${refused.limit}번째면 헛돌기로 보류). 원인을 고친 뒤 다시 submit_for_review를 호출하세요.\n${check.detail}`,
          'task_work',
        );
        return;
      }
      const after = await git.status(wt);
      if (!(task = current())) return;
      if (!after.clean) {
        const paths = after.files.map((f) => f.path);
        if (!this.refuseSubmission(taskId, `자동 검사 뒤 커밋되지 않은 파일 (${fileList(paths)})`)) return;
        this.continueWork(taskId, `자동 검사 뒤 커밋되지 않은 파일이 생겼습니다(빌드 산출물이면 .gitignore에 추가하세요): ${paths.slice(0, 20).join(', ')}`);
        return;
      }
      const taskSha = await git.revParse(wt, 'HEAD');
      const mainNow = await git.revParse(project.path, `refs/heads/${base}`);
      if (!taskSha || !mainNow) throw new Error('검수 대상 버전을 확인하지 못했습니다');
      if (!(task = current())) return;
      // 검사한 버전만 고정한다 (5.3 진행→검수, CONC-03). 검사하는 사이 작업 폴더에 커밋이 생겼으면 검사를 거치지 않은 버전이다
      if (taskSha !== upd.sha) {
        if (!this.refuseSubmission(taskId, '자동 검사 중 작업 버전 변경 — 고정하지 않음')) return;
        this.continueWork(taskId, '자동 검사 중에 작업 버전이 바뀌었습니다. 바뀐 내용을 확인하고 다시 submit_for_review를 호출하세요.');
        return;
      }
      // 검사하는 사이 main이 더 움직였으면 지금 main과의 조합은 검사하지 않았다 → 검사 전 기준으로 고정해
      // 병합 단계가 '기준 main 바뀜'으로 보고 최신 반영·재검사부터 다시 하게 한다 (GIT-06, REV-07)
      const pinnedBase = mainNow === baseSha || (await git.isAncestor(wt, mainNow, taskSha)) ? mainNow : baseSha;
      if (!(task = current())) return;
      const pinned: Extract<ReviewTarget, { kind: 'repo' }> = { kind: 'repo', taskCommitSha: taskSha, baseMainSha: pinnedBase, pinnedAt: ctx.now() };
      await this.prepareReviewCopy(task, pinned);
      // 산출물형에서 전환된 작업이 산출물 폴더에 만든 결과 파일도 이 버전으로 고정해 검수자에게 보인다 (AC-47, REV-05·08) — 그 사본의 해시를 대상에
      // 묶어 병합 직전·보관 때 검수한 내용인지 대조한다 (REV-07 '산출물 버전·해시에 연결')
      const deliverables = this.snapshotDeliverables(task, pinned);
      target = deliverables.length ? { ...pinned, deliverables } : pinned;
    } else {
      const workDir = artifactWorkDir(ctx.paths, project.id, taskId);
      const files = hashTree(workDir);
      if (files.length === 0) {
        if (!this.refuseSubmission(taskId, '산출물 없음')) return;
        this.continueWork(taskId, `산출물이 없습니다. 산출물 폴더(${workDir})에 결과 파일을 저장한 뒤 다시 submit_for_review를 호출하세요.`);
        return;
      }
      ctx.store.tasks.patch(taskId, {
        review: { ...task.review, autoCheck: { status: 'not_applicable', detail: '해당 없음 — 산출물형 작업 (완료 조건으로 검수자가 확인)', at: ctx.now() } },
      });
      const version = (ctx.store.kv.get<number>(`artifactver:${taskId}`) ?? 0) + 1;
      ctx.store.kv.set(`artifactver:${taskId}`, version);
      target = { kind: 'artifact', files, version, pinnedAt: ctx.now() };
      copyTree(workDir, reviewCopyPath(ctx.paths, project.id, taskId, task.review.round, `v${version}`));
    }
    if (!current()) return;
    transitionTask(ctx, taskId, { type: 'submit', target }, 'system');
    this.dispatchReview(taskOrThrow(ctx, taskId));
  }

  /** 작업 브랜치가 기준에서 갈라진 지점 이후 바뀐 파일이 있는지. 공통 이력이 없으면(있을 수 없는 상태) 기준과 바로 비교한다 */
  private async changedSinceFork(wt: string, baseSha: string): Promise<boolean> {
    const git = this.ctx.deps.git;
    const fork = await git.mergeBase(wt, baseSha, 'HEAD');
    return (await git.diffStat(wt, fork ?? baseSha, 'HEAD')).length > 0;
  }

  /**
   * 산출물형 → 저장소 변경형 전환 (5.2: 이 작업이 추적 파일을 바꿈, AC-47). 산출물 폴더에 이미 만든 결과 파일은 버리지 않는다 — 고정할 때
   * 그 버전의 사본을 검수자에게 보이고(snapshotDeliverables) 병합이 끝나면 함께 보관한다. 팀원은 계속 그 폴더를 쓴다 (실행 위치·작업 카드)
   */
  private switchToRepo(task: Task): void {
    const ctx = this.ctx;
    ctx.store.tasks.patch(task.id, { outputMode: 'repo' });
    const files = hashTree(artifactWorkDir(ctx.paths, task.projectId, task.id)).map((f) => f.path);
    ctx.activity({
      kind: 'task',
      level: files.length ? 'warn' : 'info',
      projectId: task.projectId,
      taskId: task.id,
      text: `${task.id} 산출물형 → 저장소 변경형 전환 (작업 폴더 변경 감지)${files.length ? ` — 산출물 폴더의 결과 파일 ${files.length}개(${fileList(files)})는 검수 요청에 함께 넣고 병합이 끝나면 함께 보관` : ''}`,
    });
  }

  /**
   * 다음 충돌 기록 (GIT-07). 같은 충돌 — 기록이 남아 있고(받아들인 해결 커밋이 지우지 않았다) 파일이 같다 — 이면 since·해결 못 한 턴 수·
   * 헛돌기 횟수를 이어 간다(continued: 병합 취소 뒤 다시 반영하는 경우 등). 아니면 새 충돌로 모두 0부터.
   * unverifiable: 병합 직후(팀원이 손대기 전) 내용으로 확인할 수 없던 충돌 파일 — 기록에 남겨(같은 충돌이면 합쳐) 해결 커밋·재검수 요청에 계속 적는다
   */
  nextConflict(taskId: string, files: string[], baseSha: string | null, unverifiable: readonly string[] = []): { conflict: TaskConflict; continued: boolean } {
    const prev = taskOrThrow(this.ctx, taskId).conflict;
    const add = unverifiable.filter((f) => files.includes(f));
    if (prev && sameFileSet(prev.files, files)) {
      const kept = unionFiles(prev.unverifiable, add);
      return { conflict: { ...prev, files, resolverId: null, baseSha: baseSha ?? prev.baseSha ?? null, ...(kept.length ? { unverifiable: kept } : {}) }, continued: true };
    }
    return { conflict: { files, since: this.ctx.now(), resolverId: null, baseSha, unresolvedTurns: 0, spinHolds: 0, ...(add.length ? { unverifiable: add } : {}) }, continued: false };
  }

  /**
   * 지금 작업 폴더의 충돌 파일 중 내용으로 확인할 수 없는 것 (바이너리·한쪽이 지운 파일 등) — 충돌을 기록할 때(병합 직후, 팀원이 손대기 전) 본다.
   * 확인하지 못하면 빈 목록 (안내만 줄인다)
   */
  async unverifiableNow(taskId: string, wt: string): Promise<string[]> {
    const check = await this.ctx.deps.git.conflictCheck(wt).catch((e: unknown) => {
      this.ctx.log('warn', `충돌 파일 확인 실패 ${taskId} (안내만 줄임)`, e);
      return null;
    });
    return check?.unverifiable ?? [];
  }

  /**
   * 진행 중인 병합 없이 남은 충돌 기록을 정리한다 (GIT-07, REV-07 상태는 저장소와 맞아야): 그 병합이 마무리됐거나(concluded — 해결 커밋 뒤 기록 전에
   * 끊김·팀원이 직접 커밋) 병합을 취소한 뒤 다시 반영한 최신 main이 충돌 없이 들어왔을 때(remerged — 팀원이 손으로 맞췄거나 그사이 main이 바뀜).
   * 기록된 충돌 파일을 내용으로 본다 — 표시가 남았으면 해결된 것이 아니다: 기록을 두고 해결 업무로 (false). 아니면 기록·횟수를 지우고, 내용으로
   * 확인하지 못한 충돌 파일(충돌을 기록할 때 확인하지 못한 것 포함)을 재검수 요청에 적도록 남긴다 (true). 기다리는 사이 계속할 수 없게 되면 null —
   * 기록은 그대로 두고 다시 처리할 때 같은 확인을 한다 (그때는 반영한 main이 HEAD에 들어 있어 마무리된 병합으로 본다)
   */
  private async settleConflictRecord(taskId: string, wt: string, how: 'concluded' | 'remerged', base: string, current: () => Task | null): Promise<boolean | null> {
    const ctx = this.ctx;
    const record = current()?.conflict;
    if (!record) return current() ? true : null;
    const check = await ctx.deps.git.conflictCheck(wt, record.files);
    const task = current();
    if (!task) return null;
    if (check.withMarkers.length) {
      ctx.activity({
        kind: 'git',
        level: 'warn',
        projectId: task.projectId,
        taskId,
        text:
          how === 'concluded'
            ? `${taskId} 작업 폴더의 병합은 커밋됐지만 충돌 표시가 남음 (${check.withMarkers.join(', ')}) — 검수로 넘기지 않고 해결 업무로`
            : `${taskId} 최신 ${base}은(는) 충돌 없이 반영됐지만 충돌 파일에 충돌 표시가 남음 (${check.withMarkers.join(', ')}) — 검수로 넘기지 않고 해결 업무로`,
      });
      enqueue(ctx, {
        kind: 'conflict_fix',
        memberId: task.assigneeId,
        sessionKey: taskKey(taskId),
        projectId: task.projectId,
        taskId,
        priority: task.priority,
        message: `${how === 'concluded' ? '병합은 커밋돼 있지만' : `최신 ${base}은(는) 충돌 없이 반영됐지만`} 충돌이 해결되지 않았습니다. ${markersLeftMessage(check.withMarkers)}`,
        dedupeKind: true,
      });
      return false;
    }
    const unchecked = unionFiles(check.unverifiable, record.unverifiable);
    ctx.store.tx(() => {
      ctx.store.tasks.patch(taskId, { conflict: null, noProgressResumes: 0 });
      if (unchecked.length) this.noteUnverifiedOutside(taskId, unchecked);
    });
    const tail = unchecked.length ? ` — 내용으로 확인하지 못한 충돌 파일: ${unchecked.join(', ')}` : '';
    ctx.activity({
      kind: 'git',
      level: unchecked.length || how === 'remerged' ? 'warn' : 'info',
      projectId: task.projectId,
      taskId,
      text:
        how === 'concluded'
          ? `${taskId} 충돌 기록 정리 — 작업 폴더에 진행 중인 병합이 없고 그 병합은 마무리됨, 충돌 파일에 표시 없음 (최신 ${base} 반영을 다시 확인)${tail}`
          : `${taskId} 충돌 기록 정리 — 병합 취소 뒤 다시 반영한 최신 ${base}이(가) 충돌 없이 들어옴 (충돌 ${record.files.join(', ')} 없음, 해결 못 한 해결 턴 ${record.unresolvedTurns ?? 0}회 기록도 지움) — 제출 처리를 이어 감${tail}`,
    });
    return true;
  }

  /**
   * 대표가 확인하고 재개한 '종료를 확인하지 못한 검사' 뒤 작업 폴더에 커밋되지 않은 파일이 있으면(dirty = 지금 커밋되지 않은 파일 — 그 검사나 검사가 남긴
   * 프로세스가 쓴 것, S9-C2) 제출 전 정리로 커밋하지 않고, 확인한 검사의 '검사 뒤 커밋되지 않은 파일' 거부와 같게 제출을 거부한다 — 커밋하면 버전이
   * 바뀌어 기록한 결과를 못 쓰고 다시 검사·다시 보류를 되풀이하거나, 프로그램이 검사 산출물을 커밋한 채 검수로 간다 (S8-C1, REV-01, CTL-11). 그 검사가
   * 실패였으면 안내에 함께 적는다. 프로그램 되돌리기 작업의 실패한 검사는 확인한 경로와 같게 되돌리기 보류 (S9-C1). 자동 검사 표시는 그 실행의 결과로.
   * 대표 확인 기록·거부(보류)·안내는 한 트랜잭션 (재시작 뒤 다시 들어와도 같은 처리). head: 지금 작업 폴더 HEAD — 그 검사한 버전과 다르면(보류 뒤
   * 충돌 해결 커밋 등) 해당 없음, 커밋하고 다시 검사 (S10-C1). 처리했으면 true
   */
  private refuseConfirmedCheckLeftovers(task: Task, dirty: string[], head: string | null): boolean {
    const ctx = this.ctx;
    return ctx.store.tx(() => {
      const left = this.core.checks.leftByConfirmedRun(task, task.workspace!.worktreePath, dirty, head);
      if (!left) return false;
      const cur = taskOrThrow(ctx, task.id);
      ctx.store.tasks.patch(task.id, { review: { ...cur.review, autoCheck: { status: left.status, detail: left.detail, at: ctx.now() } } });
      if (left.status === 'failed' && isProgramRevert(cur)) {
        // 되돌린 결과가 검사에 실패했다 — 확인한 경로(검사 실패를 '검사 뒤 상태'보다 먼저 본다)와 같게 일반 재작업으로 넘기지 않고 되돌리기 보류,
        // 프로듀서가 조정 범위를 계획한다 (7.1, AC-12, S9-C1). 그 파일은 커밋하지 않고 작업 폴더에 둔 채 알린다
        const base = projectOrThrow(ctx, cur.projectId).baseBranch;
        const files = fileList(left.files);
        ctx.store.tasks.patch(task.id, { pendingSubmit: null });
        this.core.merges.holdRevert(
          task.id,
          `되돌리기 자동 검사 실패: ${left.detail.slice(0, 300)}`,
          `${cur.revertOfTaskId!} 되돌리기(${task.id})의 결과(최신 ${base} + 되돌리기)가 자동 검사에 실패해 보류했습니다. main은 그대로입니다. 검사 뒤 커밋되지 않은 파일(${files})은 커밋하지 않고 작업 폴더에 두었습니다(빌드 산출물이면 .gitignore에 추가해야 합니다). 검사 출력:\n${left.detail.slice(0, 1500)}\n`,
          `다른 작업으로 조정한다면 그 작업이 main에 병합된 뒤, 이 되돌리기 안에서 고치게 하려면 그대로(또는 assignee_id로 맡길 팀원을 정해) replan_task(task_id="${task.id}")를 호출하세요 — 담당이 이 작업 폴더에서 확인·조정한 뒤 다시 제출하면 최신 ${base}를 반영해 다시 검사합니다. 되돌리지 않기로 했으면 cancel_task(task_id="${task.id}").`,
        );
        ctx.activity({
          kind: 'revert',
          level: 'warn',
          projectId: cur.projectId,
          taskId: task.id,
          text: `${task.id} 되돌리기 결과 자동 검사 실패 — 보류(재계획), 프로듀서가 조정 범위를 계획 (검사 뒤 커밋되지 않은 파일 ${files}은 커밋하지 않음)`,
          result: left.detail.slice(0, 500),
        });
        return true;
      }
      if (!this.refuseSubmission(task.id, `자동 검사 뒤 커밋되지 않은 파일 (${fileList(left.files)})`)) return true;
      this.continueWork(
        task.id,
        `자동 검사 뒤 커밋되지 않은 파일이 생겼습니다(빌드 산출물이면 .gitignore에 추가하세요): ${left.files.slice(0, 20).join(', ')}${left.status === 'failed' ? `\n그 검사는 실패했습니다 — 원인도 고친 뒤 다시 submit_for_review를 호출하세요.\n${left.detail}` : ''}`,
      );
      return true;
    });
  }

  /**
   * 제출 처리가 대상을 고정하지 않고 제출 요청을 지우는 거부 — 자동 검사 실패, 검사 뒤 커밋되지 않은 파일, 산출물 없음, 검사 중 작업 버전 변경. 단계
   * 진척 없이 이어진 거부를 하나로 센다(checkFailStreak — ERR-04 자동 재시도 상한, 8장 헛돌기 '같은 오류·명령 실패 5회'): 제출 턴은 진척 없는 재개로 세지
   * 않으므로 다시 제출하기만 되풀이하면 여기서만 멈출 수 있다. 상한(spinSameErrorCount)이면 헛돌기 보류 + 프로듀서 [replan]하고 null — 호출자는 다시
   * 제출하라는 안내를 넣지 않는다. 아니면 이어진 거부 수와 상한. 단계 완료·대상 고정·재계획·대표 재개 때 0. 거부 기록·제출 요청 지우기·보류는 한 트랜잭션
   */
  private refuseSubmission(taskId: string, why: string, result: string | null = null): { streak: number; limit: number } | null {
    const ctx = this.ctx;
    const limit = ctx.settings().execution.spinSameErrorCount;
    const cur = taskOrThrow(ctx, taskId);
    const streak = (cur.checkFailStreak ?? 0) + 1;
    const held = streak >= limit;
    ctx.store.tx(() => {
      ctx.store.tasks.patch(taskId, { pendingSubmit: null, checkFailStreak: streak });
      ctx.activity({
        kind: 'task',
        level: 'warn',
        projectId: cur.projectId,
        taskId,
        text: `${taskId} 제출 거부 — ${why} (단계 진척 없이 이어진 제출 거부 ${streak}/${limit}${held ? ' — 헛돌기 보류' : ''})`,
        result,
      });
      if (held) this.core.turns.spinHold(taskOrThrow(ctx, taskId), `제출 ${streak}회 연속 거부 — 단계 진척 없이 다시 제출 (마지막: ${why})`);
    });
    return held ? null : { streak, limit };
  }

  /**
   * 진행 중인 병합이 없는 작업 폴더에서 충돌을 낸 병합이 마무리됐는지 — 그 병합이 반영하던 main 커밋(모르면 지금 main)이 HEAD에 들어 있으면
   * 마무리(해결 커밋 뒤 기록 전에 끊김·팀원이 직접 커밋), 아니면 취소된 것이다(git merge --abort 등 — 해결된 것이 없다)
   */
  private async mergeConcluded(wt: string, conflict: TaskConflict, project: Project): Promise<boolean> {
    const git = this.ctx.deps.git;
    const head = await git.revParse(wt, 'HEAD');
    const merged = conflict.baseSha ?? (await git.revParse(project.path, `refs/heads/${project.baseBranch}`));
    return !!head && !!merged && (await git.isAncestor(wt, merged, head));
  }

  /**
   * 되돌리기 작업의 이 충돌을 프로듀서가 아직 계획하지 않았는지 (7.1 '충돌·의존성 → 보류, 프로듀서가 조정 범위를 계획', AC-12): 이 충돌(같은 충돌을
   * 다시 기록해도 그대로인 since로 가린다)로 보류한 기록(kv revertconflict)이 있고 그 보류 전이 뒤에 재계획(replan_task)했으면 계획한 것이다 —
   * 그 뒤의 같은 충돌은 (맡긴) 담당이 해결하는 일이라 병합을 취소해 다시 반영해도 다시 보류하지 않는다. 받아들인 해결 커밋 뒤의 새 충돌은 새로 계획한다.
   * 순서는 시계가 아니라 상태 전이 순번으로 본다 (시계가 뒤로 맞춰져도 같다)
   */
  private revertConflictNeedsPlan(task: Task): boolean {
    const conflict = task.conflict;
    if (!isProgramRevert(task) || !conflict) return false;
    const held = this.ctx.store.kv.get<{ since: string; seq: number }>(`revertconflict:${task.id}`);
    if (!held || held.since !== conflict.since) return true;
    return !this.ctx.store.transitions.list(task.id).some((x) => x.event === 'replanned' && x.seq > held.seq);
  }

  /**
   * 되돌리기 작업이 최신 main을 반영하다 그 뒤 들어온 변경과 충돌하면 보류한다 (GIT-10, 7.1, AC-12): 재계획 보류 + 프로듀서 [replan](뒤 작업 목록 포함) +
   * '되돌리기 보류' 알림 (merges.holdRevert). 충돌 표시와 제출 요청은 작업 폴더·기록에 그대로 둔다 — 재계획 뒤 (assignee_id로 맡긴, 아니면 지금) 담당이
   * 그 작업 폴더에서 해결하고(안내에 '되돌릴 변경만 취소, 이후 변경은 남김'), 해결을 보고하면 최신 main 반영·자동 검사·검수·병합으로 이어진다
   */
  private holdRevertConflict(task: Task, files: readonly string[], base: string): void {
    const ctx = this.ctx;
    const origId = task.revertOfTaskId!;
    const since = task.conflict!.since;
    this.core.merges.holdRevert(
      task.id,
      `되돌리기 최신 ${base} 반영 충돌: ${files.join(', ')}`,
      `${origId} 되돌리기(${task.id})를 최신 ${base}에 반영하다 그 뒤 main에 들어온 변경과 충돌해 보류했습니다 (충돌 파일: ${fileList(files)}). 충돌 표시는 되돌리기 작업 폴더에 남아 있고 main은 그대로입니다.`,
      `정했으면 replan_task(task_id="${task.id}")로 다시 진행시키세요 — assignee_id로 맡길 팀원을 정하지 않으면 지금 담당이 그 작업 폴더에서 충돌을 해결합니다(${origId}의 변경만 취소하고 이후 변경은 남김). 되돌리지 않기로 했으면 cancel_task(task_id="${task.id}").`,
      // 이 충돌로 보류했다는 기록 — 이 보류 뒤에 재계획하면 같은 충돌은 다시 보류하지 않는다 (보류와 같은 트랜잭션)
      (seq) => ctx.store.kv.set(`revertconflict:${task.id}`, { since, seq }),
    );
    ctx.activity({
      kind: 'revert',
      level: 'warn',
      projectId: task.projectId,
      taskId: task.id,
      text: `${task.id} 되돌리기를 최신 ${base}에 반영하다 충돌 (${fileList(files)}) — 담당에게 일반 충돌 해결로 넘기지 않고 보류(재계획), 프로듀서가 조정 범위를 계획`,
    });
  }

  /** 검수용 읽기 사본 (REV-08): 고정 커밋의 분리 작업 폴더 */
  async prepareReviewCopy(task: Task, target: ReviewTarget): Promise<string> {
    const ctx = this.ctx;
    const project = projectOrThrow(ctx, task.projectId);
    if (target.kind === 'artifact') return reviewCopyPath(ctx.paths, project.id, task.id, task.review.round, `v${target.version}`);
    const path = reviewCopyPath(ctx.paths, project.id, task.id, task.review.round, target.taskCommitSha.slice(0, 8));
    await ctx.deps.git.removeWorktree(project.path, path);
    await ctx.deps.git.addDetachedWorktree(project.path, { path, commit: target.taskCommitSha });
    return path;
  }

  reviewCopyOf(task: Task): string | null {
    const t = task.review.target;
    if (!t) return null;
    const tag = t.kind === 'repo' ? t.taskCommitSha.slice(0, 8) : `v${t.version}`;
    return reviewCopyPath(this.ctx.paths, task.projectId, task.id, task.review.round, tag);
  }

  /** 저장소 변경형 대상의 산출물 폴더 결과 파일 사본 위치 (검수 사본 옆, 같은 정리 대상) */
  private deliverablesCopyPath(task: Task, target: Extract<ReviewTarget, { kind: 'repo' }>): string {
    return reviewCopyPath(this.ctx.paths, task.projectId, task.id, task.review.round, `${target.taskCommitSha.slice(0, 8)}-artifacts`);
  }

  /**
   * 산출물형에서 저장소 변경형으로 전환된 작업이 산출물 폴더에 만든 결과 파일을 이 고정 버전의 읽기용 사본으로 남긴다 (REV-08). 결과 파일이 없으면
   * 이전 고정의 사본을 지운다. 대상 고정 때마다 다시 찍으므로 여러 번 해도 같다. 찍은 사본의 해시를 돌려준다 — 호출자가 대상에 묶어 병합 직전·보관 때
   * 검수한 내용인지 대조한다 (REV-07 '산출물 버전·해시에 연결', deliverablesSource·archiveDeliverables). 결과 파일이 없으면 빈 목록
   */
  private snapshotDeliverables(task: Task, target: Extract<ReviewTarget, { kind: 'repo' }>): ArtifactFile[] {
    const ctx = this.ctx;
    const work = artifactWorkDir(ctx.paths, task.projectId, task.id);
    const dst = this.deliverablesCopyPath(task, target);
    if (!hashTree(work).length) {
      removeTree(dst);
      return [];
    }
    copyTree(work, dst);
    ctx.activity({ kind: 'review', projectId: task.projectId, taskId: task.id, text: `${task.id} 산출물 폴더 결과 파일을 검수 대상과 함께 고정 (${dst})` });
    return hashTree(dst);
  }

  /**
   * 그 검수 대상에 묶인 산출물 폴더 결과 파일(산출물형에서 전환된 작업)을 보관할 원본 — 고정 때 찍은 해시(대상의 deliverables)와 내용이 같은 곳 (REV-07).
   * 검수 사본이 같으면 사본, 사본이 바뀌었으면(검수 턴의 실행 위치라 바뀔 수 있다 — REV-08 위반) 고정 때 그대로인 산출물 폴더(검수 중에는 작업 턴이 돌지
   * 않는다). 판정은 고정한 버전에 묶이므로 둘 중 고정 때와 같은 쪽이 검수한 내용이다 — 사본을 바꾸는 검수 턴 때문에 고정·검수가 끝없이 되풀이되지 않는다.
   * 둘 다 다르면 null: 검수한 내용을 보관할 수 없다 (병합 전이면 진행으로 돌리고 병합 뒤면 보류). 고정 때 결과 파일이 없었거나 해시를 남기지 않은 이전
   * 기록이면 undefined (대조할 것이 없다)
   */
  deliverablesSource(task: Task, target: ReviewTarget): { dir: string; files: ArtifactFile[]; fromCopy: boolean } | null | undefined {
    if (target.kind !== 'repo' || !target.deliverables?.length) return undefined;
    const pinned = target.deliverables;
    const copy = this.deliverablesCopyPath(task, target);
    if (existsSync(copy) && sameFiles(hashTree(copy), pinned)) return { dir: copy, files: pinned, fromCopy: true };
    const work = artifactWorkDir(this.ctx.paths, task.projectId, task.id);
    if (existsSync(work) && sameFiles(hashTree(work), pinned)) return { dir: work, files: pinned, fromCopy: false };
    return null;
  }

  /**
   * 지금 고정된 저장소 변경형 버전의 산출물 폴더 결과 파일 사본 (산출물형에서 전환된 작업, AC-47). 검수 요청·get_review_target·검수 턴 실행
   * 위치가 쓰고, 병합이 끝나면 이 사본을 보관한다 (REV-05). 없으면 null
   */
  deliverablesCopyOf(task: Task): string | null {
    const t = task.review.target;
    if (!t || t.kind !== 'repo') return null;
    const p = this.deliverablesCopyPath(task, t);
    return existsSync(p) ? p : null;
  }

  /**
   * 저장소 변경형으로 전환된 작업의 산출물 폴더 결과 파일(검수한 버전)을 병합과 함께 보관한다 (AC-47 '버전 보관', REV-05). 완료 전에 부른다 —
   * 보관 기록이 있으면 다시 하지 않으므로 완료 전에 끊겨도 재개·재시작 때 같은 결과. 보관하는 것은 고정 때 찍은 해시(대상의 deliverables)와 같은
   * 내용뿐이다 (REV-07, deliverablesSource): 검수 사본, 사본이 바뀌었으면 고정 때 그대로인 산출물 폴더(경고 활동). 둘 다 다르면 보관하지 않고
   * 던진다 — 호출자(merges.archiveDeliverablesOrHold)가 보류(오류) + 긴급 알림, 검수한 내용으로 되돌린 뒤 재개하면 다시 대조해 보관한다. 보관본도
   * 그 해시와 대조한다. 고정 때 결과 파일이 없었으면 아무것도 하지 않는다. 해시를 남기지 않은 이전 기록은 사본을 그대로 보관하고 경고를 남긴다.
   * 파일 오류는 던진다
   */
  archiveDeliverables(taskId: string): void {
    const ctx = this.ctx;
    const t = taskOrThrow(ctx, taskId);
    if (t.outputMode !== 'repo' || t.artifact) return;
    const target = t.review.passed?.target ?? t.review.target;
    if (!target || target.kind !== 'repo') return;
    let source: string;
    let files: ArtifactFile[];
    let how: string;
    if (target.deliverables === undefined) {
      // 고정 때 해시를 남기지 않은 이전 기록 — 대조할 것이 없어 사본을 그대로 보관한다 (경고 활동)
      const copy = this.deliverablesCopyOf(t);
      files = copy ? hashTree(copy) : [];
      if (!copy || !files.length) return;
      source = copy;
      how = '고정 때 해시가 없는 이전 기록이라 대조하지 못한 사본';
    } else {
      const src = this.deliverablesSource(t, target);
      if (src === undefined) return;
      if (src === null) {
        const names = target.deliverables.map((f) => f.path);
        throw new Error(`검수한 산출물 폴더 결과 파일(${fileList(names)})이 대상 고정 뒤 바뀌어 보관하지 않았습니다 — 검수 사본과 산출물 폴더 모두 고정 때와 다릅니다. 검수한 내용으로 되돌리세요`);
      }
      source = src.dir;
      files = src.files;
      how = src.fromCopy ? '검수한 사본' : '검수 사본이 고정 뒤 바뀌어 고정 때 그대로인 산출물 폴더에서';
    }
    const version = (ctx.store.kv.get<number>(`artifactver:${taskId}`) ?? 0) + 1;
    const dir = artifactVersionDir(ctx.paths, t.projectId, taskId, version);
    copyTree(source, dir);
    if (target.deliverables !== undefined && !sameFiles(hashTree(dir), files)) {
      // 복사하는 사이 원본이 바뀌었다 — 고정 때와 다른 보관본은 남기지 않는다
      removeTree(dir);
      throw new Error('검수한 산출물 폴더 결과 파일을 보관하는 사이 내용이 바뀌어 보관하지 않았습니다');
    }
    ctx.store.tx(() => {
      ctx.store.kv.set(`artifactver:${taskId}`, version);
      ctx.store.tasks.patch(taskId, { artifact: { version, dir, files, finalizedAt: ctx.now() } });
    });
    ctx.activity({
      kind: 'task',
      level: how === '검수한 사본' ? 'info' : 'warn',
      projectId: t.projectId,
      taskId,
      text: `${taskId} 산출물 폴더 결과 파일 v${version} 보관 (${files.length}개, ${how} — 병합과 함께)`,
    });
  }

  /**
   * 검수 대상이 고정된 작업을 검수자에게 넘긴다. 적격 팀원이 없으면 메인 에이전트(M-MAIN)의 검수 세션(review:T)으로 간다 — 다른 검수자와 같은 검수 업무다
   * (REV-06 v0.6). 메인도 그 작업의 기여자라 아무도 검수할 수 없으면 보류하고 메인에게 '검수자 없음'을 알린다 (holdNoReviewer)
   */
  dispatchReview(task: Task): void {
    const ctx = this.ctx;
    if (task.state !== 'in_review' || !task.review.target) return;
    let reviewer = task.reviewerId;
    const m = reviewer ? ctx.store.members.get(reviewer) : null;
    if (!reviewer || !m || !canBeReviewer(m, roleOf(ctx, m.roleId), task).ok) {
      reviewer = chooseReviewer(task, projectMembers(ctx, task.projectId), (r) => roleOf(ctx, r));
      ctx.store.tasks.patch(task.id, { reviewerId: reviewer });
      ctx.activity({ kind: 'review', projectId: task.projectId, taskId: task.id, text: `${task.id} 검수자 재지정 → ${reviewerLabel(reviewer)}` });
    }
    if (!reviewer) {
      this.holdNoReviewer(taskOrThrow(ctx, task.id));
      return;
    }
    const pin = task.review.target.pinnedAt;
    // 다른 팀원(이전·삭제된 검수자) 앞으로 남은 검수 항목은 지운다 — 세션·종류로만 합치는 중복 묶기가
    // 새 검수 업무를 그 항목에 합쳐 엉뚱한 팀원이 실행하거나 아무도 실행하지 않게 되는 것을 막는다 (F5, CONC-11).
    // 다른 버전(이전 고정)의 검수 항목도 지운다 — 이전 버전의 사본 위치·완료 조건이 이 버전 검수 요청에 섞이지 않게 (REV-07·08)
    cancelQueued(ctx, (q) => q.sessionKey === reviewKey(task.id) && q.kind === 'review' && (q.memberId !== reviewer || (!!q.reviewPinnedAt && q.reviewPinnedAt !== pin)));
    // 검수자가 따로 볼 것: 충돌 해결 때 내용으로 확인하지 못한 파일(GIT-07), 산출물형에서 전환된 작업의 산출물 폴더 결과 파일(AC-47)
    const unchecked = this.uncheckedConflictFiles(task.id);
    const deliverables = this.deliverablesCopyOf(task);
    const deliverableNames = deliverables ? hashTree(deliverables).map((f) => f.path) : [];
    const uncheckedNote = unchecked.length
      ? `충돌 해결 때 내용으로 확인하지 못한 파일(바이너리·한쪽이 지운 파일 등 — 작업 폴더에 있던 그대로 커밋됨): ${unchecked.join(', ')}. main 쪽 변경이 빠지지 않았는지 이 파일들을 확인하세요 (GIT-07).`
      : '';
    const deliverablesNote = deliverableNames.length
      ? `산출물 폴더의 결과 파일(산출물형에서 저장소 변경형으로 전환된 작업 — 이 버전의 사본, 병합이 끝나면 함께 보관): ${deliverables} — ${fileList(deliverableNames)}. 완료 조건에 해당하면 이 파일들도 확인하세요.`
      : '';
    const copy = this.reviewCopyOf(task);
    enqueue(ctx, {
      kind: 'review',
      memberId: reviewer,
      sessionKey: reviewKey(task.id),
      projectId: task.projectId,
      taskId: task.id,
      directiveId: task.directiveId,
      priority: task.priority,
      reviewPinnedAt: pin,
      message: [
        `${task.id} "${task.title}" 검수 (${task.review.round}차). 읽기용 사본: ${copy ?? '-'}`,
        `완료 조건:\n${task.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}`,
        `자동 검사: ${task.review.autoCheck.status}`,
        uncheckedNote,
        deliverablesNote,
      ]
        .filter(Boolean)
        .join('\n'),
      dedupeKind: true,
    });
  }

  /**
   * 검수자 없음 (REV-06 v0.6): 적격 검수 팀원이 없고 메인 에이전트도 이 작업의 기여자라 대신할 수 없다 — 자동 통과·본인 검수로 대체하지 않고 작업을
   * 보류(오류, refId no_reviewer)하고 메인 에이전트에게 '검수자 없음' 업무를 준다. 메인이 검수 권한 팀원을 더하거나 프로듀서에게 배정을 지시한 뒤
   * resume_task로 재개하면 검수 등록부터 다시 한다 (afterRelease → dispatchReview). 이미 그 보류가 있으면 다시 하지 않는다 (재시작 복구에서 다시 불려도 같다)
   */
  private holdNoReviewer(task: Task): void {
    const ctx = this.ctx;
    if (task.state !== 'in_review' || task.hold.reasons.some((r) => r.refId === NO_REVIEWER_HOLD_REF)) return;
    // 보류 사유는 대표 화면에도 보인다 — 대표에게는 팀원 추가·재개가 없으므로 재개하라고 쓰지 않는다. 메인 에이전트는 '검수자 없음' 업무를 받는다 (리드 결정 32)
    const note = '검수자 없음 — 적격 검수 팀원이 없고 메인 에이전트도 이 작업의 기여자라 검수할 수 없습니다. 메인 에이전트가 검수 권한 팀원을 더하거나 검수자를 정한 뒤 재개합니다';
    ctx.store.tx(() => {
      this.hold(task.id, 'error', 'task', note, 'system', NO_REVIEWER_HOLD_REF, 'in_review');
      enqueue(ctx, {
        kind: 'no_reviewer',
        memberId: MAIN_AGENT_ID,
        sessionKey: mainKey(task.projectId),
        projectId: task.projectId,
        taskId: task.id,
        directiveId: task.directiveId,
        priority: 'high',
        message: `${task.id} "${task.title}" 검수자 없음 — 적격 검수 팀원이 없고 메인 에이전트도 이 작업에 기여해 대신 검수할 수 없어 작업을 보류했습니다. 검수 권한 팀원을 add_member로 더하거나 프로듀서에게 assign_reviewer를 지시한 뒤 resume_task(task_id="${task.id}")로 재개하세요 — 재개하면 검수 등록부터 다시 합니다.`,
        dedupeKind: true,
      });
    });
    ctx.activity({ kind: 'review', level: 'warn', projectId: task.projectId, taskId: task.id, text: `${task.id} 검수자 없음 — 보류하고 메인 에이전트에게 알림 (적격 팀원 없음, 메인 에이전트도 기여자)` });
  }

  /**
   * 지난 판정 뒤의 충돌 해결에서 내용으로 확인하지 못한 충돌 파일 (작업 폴더 그대로 커밋됨) — 프로그램의 해결 커밋(실행 기록 `unverified`)과,
   * 팀원이 프로그램 밖에서 커밋해 둔 병합을 해결로 받은 경우(`conflictunverified:<작업>` 기록). 재검수(GIT-07)가 그 파일을 보게 검수 요청에 적는다
   */
  uncheckedConflictFiles(taskId: string): string[] {
    const ctx = this.ctx;
    const since = ctx.store.reviews.list({ ref1: taskId }).reduce((last, r) => (r.createdAt > last ? r.createdAt : last), '');
    const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((f): f is string => typeof f === 'string') : []);
    const files = ctx.store.execs
      .list({ ref1: taskId, ref2: 'git_conflict_commit' })
      .filter((x) => x.state === 'succeeded' && x.startedAt >= since)
      .flatMap((x) => strings(x.result.unverified));
    const outside = (ctx.store.kv.get<{ at: string; files: string[] }[]>(`conflictunverified:${taskId}`) ?? []).filter((x) => x.at >= since).flatMap((x) => strings(x.files));
    return [...new Set([...files, ...outside])];
  }

  /**
   * 검수 중 작업의 다음 할 일을 다시 등록 (검수자 정지 해제·삭제·교체 뒤). 통과했으면 병합 판단, 아니면 검수.
   * 검수 대상 작업은 검수자 정지로 보류되지 않아 afterRelease가 돌지 않는다. 중복 묶기로 여러 번 불러도 항목은 하나 (F5)
   */
  redispatchReview(task: Task): void {
    if (task.state !== 'in_review') return;
    if (!task.review.passed) this.dispatchReview(task);
    else if (task.outputMode === 'repo' && !task.merge) this.core.merges.queueMergeDecision(task);
  }

  /**
   * 검수자 교체 한 곳 (assign_reviewer·update_task·팀원 삭제·프로듀서 교체, CONC-11): 기록 → 이전 검수자의 대기 항목·실행 중 턴·세션 정리
   * → 새 검수자에게 다시 등록. 실행 중 턴은 정지 표시가 바로 남아 user_stop으로 끝나고, 검수자가 바뀌었으므로 다시 넣지 않는다.
   * 같은 검수자를 다시 정하면(검수 지연 뒤 프로듀서의 assign_reviewer — 메인 에이전트가 유일한 대체 검수자일 때 등) 검수 중·통과 전이고 대기·실행 중인
   * 검수가 없을 때 그 검수자에게 검수를 다시 등록한다 — 아무 일도 하지 않으면 작업이 검수 중인 채 아무도 검수하지 않는다 (리드 결정 11). 한 일을 돌려준다.
   * 다시 등록한 횟수를 센다 — 그 검수도 판정 없이 끝나면 같은 검수자를 다시 권하지 않고 메인 에이전트에게 넘긴다. 다른 검수자를 정하면 횟수를 지운다 (리드 결정 17)
   */
  changeReviewer(taskId: string, reviewer: string | null, reason: string): 'changed' | 'redispatched' | 'unchanged' {
    const ctx = this.ctx;
    const cur = taskOrThrow(ctx, taskId);
    if (cur.reviewerId === reviewer) {
      if (cur.state !== 'in_review' || cur.review.passed || !cur.review.target || this.reviewPending(taskId)) return 'unchanged';
      const count = this.sameReviewerRedispatches(cur) + 1;
      ctx.store.kv.set<ReviewRedispatch>(redispatchKey(taskId), { reviewerId: reviewer, count });
      ctx.activity({ kind: 'review', projectId: cur.projectId, taskId, text: `${taskId} 검수자 ${reviewerLabel(reviewer)} 그대로 — 대기·실행 중인 검수가 없어 검수를 다시 등록 (${reason}, 같은 검수자로 ${count}번째)` });
      this.dispatchReview(cur);
      ctx.bus.signal('tick');
      return 'redispatched';
    }
    ctx.store.kv.set<ReviewRedispatch | null>(redispatchKey(taskId), null);
    ctx.store.tasks.patch(taskId, { reviewerId: reviewer });
    cancelQueued(ctx, (q) => q.sessionKey === reviewKey(taskId), `${taskId}의 검수자가 바뀜 (${reason})`);
    void this.core.turns.stopSessions([reviewKey(taskId)], reason, true);
    this.core.turns.closeSessions(reviewKey(taskId), reason);
    this.redispatchReview(taskOrThrow(ctx, taskId));
    ctx.bus.signal('tick');
    return 'changed';
  }

  /** 지금 검수자에게 같은 검수자로 검수를 다시 등록한 횟수 (리드 결정 17) — 판정이 기록되거나 다른 검수자가 정해졌으면 0 */
  sameReviewerRedispatches(task: Task): number {
    const v = this.ctx.store.kv.get<ReviewRedispatch>(redispatchKey(task.id));
    return v && v.reviewerId === task.reviewerId ? v.count : 0;
  }

  /** 이 작업의 검수가 대기 중이거나 돌고 있는지 — 검수 세션의 대기·실행 중 검수 항목, 또는 살아 있는 검수 턴 (리드 결정 11) */
  reviewPending(taskId: string): boolean {
    const key = reviewKey(taskId);
    return this.core.turns.hasLiveSession(key) || this.ctx.store.queue.list({ ref2: key, state: ['queued', 'running'] }).some((q) => q.kind === 'review');
  }

  // ───────────────────────── 검수 결과 (REV-03·04·07) ─────────────────────────

  submitReview(
    taskId: string,
    /** 'owner'(옛 대표 검수)는 받지 않는다 — v0.6 전 호출을 분명히 거부하려고 타입에 남겼다 (REV-06 v0.6, 대표 검수 없음) */
    reviewer: Member | OwnerRef,
    raw: { verdict: 'pass' | 'reject'; criteria: CriterionResult[]; reason: string },
    requestId: string | null,
    seen: ReviewSeen = {},
  ): { review: ReviewRecord; duplicate: boolean; task: Task; reopenedForOwnerMessage?: boolean } {
    const ctx = this.ctx;
    if (reviewer === OWNER) throw new BackendError('forbidden', '대표 검수는 없앴습니다 — 적격 검수 팀원이 없으면 메인 에이전트가 검수합니다 (REV-06)');
    // 사유도 저장 전에 가린다 (도구 인자는 앱 도구 경계에서 이미 가림, SEC-10)
    const input = { ...raw, reason: ctx.redact.text(raw.reason), criteria: ctx.redact.value(raw.criteria) };
    const task = taskOrThrow(ctx, taskId);
    const reviewerId = reviewer.id;
    // 메인 에이전트도 배정된 검수자일 때만 — 같은 검사를 거친다 (REV-03·06 v0.6)
    const ok = canSubmitReview(reviewer, roleOf(ctx, reviewer.roleId), task);
    if (!ok.ok) throw new BackendError('forbidden', `검수 결과 등록 거부: ${ok.reason}`);
    if (task.state !== 'in_review' || !task.review.target) throw new BackendError('conflict', `작업 ${taskId}은(는) 검수 상태가 아닙니다 (${task.state})`);
    const target = task.review.target;
    // 판정은 검수자가 본 버전에만 묶는다 (REV-07·08, AC-43). 지금 대상이 아닌 고정에 띄워진 검수 턴은 이전 버전의 사본과 이전 완료 조건을
    // 보고 있었다 — 그 판정을 지금 버전에 붙이면 아무도 보지 않은 버전이 통과·병합된다. 새 버전 검수는 고정 때 이미 등록됐다.
    // 시각 순서가 아니라 같은 고정인지로 본다 — 시계가 뒤로 맞춰져도 바뀐 것이 없는 버전의 판정은 받는다
    if (reviewTurnStale(seen, target.pinnedAt)) {
      throw new BackendError('conflict', '검수 대상 버전이 이 턴이 시작된 뒤 바뀌어 판정을 등록하지 않았습니다. 이 턴을 마치세요 — 새 버전 검수는 다음 턴에 전달됩니다');
    }
    // 같은 고정(제출·재고정) 안에서 같은 검수자의 두 번째 판정만 무시한다 (REV-04: 같은 요청의 재전송).
    // 반려는 상태를 진행·보류로 바꾸므로 지금 고정에 남는 판정은 통과뿐이고, 제출·재고정·재작업은 통과 기록을 비운다.
    // 그래서 반려 뒤 변경 없이 다시 제출한 같은 버전도 새로 판정한다
    // 예외: 통과한 뒤 그 검수자에게 대표 직접 메시지가 와서 병합·확정을 미루고 다시 판정하게 한 통과(kv rejudge — holdForReviewerMessage)는 그
    // 검수자의 새 판정이 대신한다 — 대표 메시지를 본 뒤의 판정이 결과를 바꿀 수 있어야 한다 (CTL-06, AC-36). 새 판정 뒤에는 그 기록이 다른 통과를 가리켜 듣지 않는다
    const passed = task.review.passed;
    if (passed && passed.reviewerId === reviewerId && sameTarget(passed.target, target)) {
      const prior = ctx.store.reviews.get(passed.reviewId);
      const rejudge = ctx.store.kv.get<string>(rejudgeKey(taskId)) === passed.reviewId;
      if (prior && !rejudge) return { review: prior, duplicate: true, task };
    }
    if (input.verdict === 'pass' && input.criteria.some((c) => !c.pass)) {
      throw new BackendError('invalid', '통과 판정인데 실패로 표시한 완료 조건이 있습니다. 반려하거나 조건 판정을 고치세요');
    }
    // 통과는 지금 완료 조건마다 통과 결과가 있어야 한다 (REV-03 완료 조건별 결과, 검수 규칙 '확인하지 못한 조건은 통과로 처리하지 않는다',
    // AC-43 '최신 기준의 검수') — 바뀐 완료 조건을 보지 않은 통과가 새 버전에 묶이지 않게. 빠지거나 바뀐 이전 조건 글로 적힌 결과는 그 자리의
    // 지금 조건을 덮지 않는다 (formerCriteria — 이전 조건 목록을 보고 한 통과), 조건 변경에서 더해지거나 바뀐 뒤 아직 통과를 받지 않은 조건은 같은 글의 결과로만 덮이고
    // (changedCriteria — 자리로 덮지 않음), 빈 글의 결과는 아무 조건도 덮지 않는다
    const missing = input.verdict === 'pass' ? uncoveredCriteria(task.acceptanceCriteria, input.criteria, task.formerCriteria, task.changedCriteria) : [];
    if (missing.length) {
      throw new BackendError(
        'invalid',
        `통과 판정에는 지금 완료 조건마다 통과 결과가 있어야 합니다 — 결과가 없는 조건: ${missing.map((c) => `"${c}"`).join(', ')}. 완료 조건(get_review_target의 acceptanceCriteria)을 모두 확인해 조건마다 결과를 적어 다시 판정하세요 — criterion에는 그 조건 글을 적으세요(새로 더해지거나 바뀐 조건은 같은 글의 결과만 칩니다)`,
      );
    }
    if (input.verdict === 'reject' && !input.reason.trim() && input.criteria.every((c) => c.pass)) {
      throw new BackendError('invalid', '반려 사유를 적어 주세요');
    }
    const rec: ReviewRecord = {
      id: ctx.store.nextId('review'),
      taskId,
      reviewRound: task.review.round,
      reviewerId,
      target,
      verdict: input.verdict,
      criteria: input.criteria,
      reason: input.reason,
      requestId,
      createdAt: ctx.now(),
    };
    ctx.store.reviews.insert(rec);
    // 판정이 기록됐다 — 같은 검수자로 다시 등록한 횟수를 지운다 (리드 결정 17)
    ctx.store.kv.set<ReviewRedispatch | null>(redispatchKey(taskId), null);
    ctx.activity({
      kind: 'review',
      actor: reviewerId,
      projectId: task.projectId,
      taskId,
      requestId,
      text: `${taskId} 검수 ${task.review.round}차 ${input.verdict === 'pass' ? '통과' : '반려'} (${reviewerLabel(reviewerId)})`,
      result: input.reason || null,
    });
    if (input.verdict === 'pass') {
      const t = transitionTask(ctx, taskId, { type: 'review_pass', reviewId: rec.id, reviewerId, target }, reviewerId, requestId);
      // 취소·종료된 지시의 작업이면 통과 기록만 남긴다 — 완료(산출물 확정)·병합 판단·진행 되돌림으로 가지 않는다. 지시 취소는 선택을 먼저 저장한 뒤
      // 작업을 하나씩 취소하므로, 취소 차례가 오기 전에 끝난 검수 턴의 통과가 그 작업을 완료로 만들면 안 된다 (TSK-09, AC-46 — 병합의 확인과 같게)
      if (closedDirectiveWork(ctx, null, t)) {
        ctx.activity({ kind: 'review', level: 'warn', projectId: t.projectId, taskId, requestId, text: `${taskId} 검수 통과 기록 — 지시 ${t.directiveId}이(가) 취소·종료돼 완료(확정·병합)로 가지 않음 (미완료 작업은 지시 취소가 취소)` });
        return { review: rec, duplicate: false, task: t };
      }
      // 작업자에게 온 대표 직접 메시지가 아직 전달되지 않았으면 완료로 가지 않고 진행으로 돌려 먼저 전달한다 (AC-36, REV-08 — 반려 아님).
      // 통과 기록은 그 버전의 판정으로 남는다. 다시 제출되면 새 버전으로 검수한다
      if (this.reopenForOwnerMessage(taskId)) return { review: rec, duplicate: false, task: taskOrThrow(ctx, taskId), reopenedForOwnerMessage: true };
      // 저장소 변경형의 병합 판단은 그 검수 턴의 마무리가 넣는다 (turns.settleReview — 메인 에이전트 검수도 같다)
      if (t.outputMode === 'artifact') this.core.merges.finalizeArtifactOrHold(taskId);
      return { review: rec, duplicate: false, task: t };
    }
    const failed = input.criteria.filter((c) => !c.pass).map((c) => `- ${c.criterion}: ${c.note}`);
    const t = transitionTask(ctx, taskId, { type: 'reject', reason: input.reason || failed.join(' ') }, reviewerId, requestId);
    if (t.state === 'in_progress') {
      this.continueWork(
        taskId,
        `검수 반려 (현재 차수 ${t.review.rejectsInRound}/${REJECT_LIMIT}). 사유: ${input.reason}\n${failed.join('\n')}\n고친 뒤 다시 submit_for_review를 호출하세요.`,
        'task_work',
      );
    } else {
      const producer = producerOf(ctx, t.projectId);
      enqueue(ctx, {
        kind: 'replan',
        memberId: producer.id,
        sessionKey: directiveKey(t.directiveId),
        projectId: t.projectId,
        taskId,
        directiveId: t.directiveId,
        priority: t.priority,
        message: `${taskId} "${t.title}"이(가) 현재 검수 차수에서 ${REJECT_LIMIT}번 반려되어 재계획 보류됐습니다. 마지막 사유: ${input.reason}\n방법 변경·완료 조건 조정·재배정 중 하나로 replan_task를 호출하세요.`,
        dedupeKind: true,
      });
      ctx.notify({
        level: 'normal',
        title: '반복 반려',
        body: `${taskId} ${t.title} — ${REJECT_LIMIT}회 반려로 재계획 대기`,
        link: { tab: 'projects', projectId: t.projectId, taskId },
        key: `reject3:${taskId}`,
      });
    }
    return { review: rec, duplicate: false, task: t };
  }

  replan(taskId: string, patch: UpdateTaskInput & { note: string }, actor: Actor): Task {
    const ctx = this.ctx;
    const task = taskOrThrow(ctx, taskId);
    if (task.state !== 'on_hold' || !hasHold(task, 'replan')) throw new BackendError('conflict', `${taskId}은(는) 재계획 보류 상태가 아닙니다`);
    this.assertDirectiveOpen(task);
    const { note, assigneeId, ...rest } = patch;
    if (Object.keys(rest).length) this.update(taskId, rest, actor);
    if (assigneeId && assigneeId !== task.assigneeId) this.reassign(taskId, assigneeId, actor);
    const t = transitionTask(ctx, taskId, { type: 'replanned', note }, actor);
    this.afterRelease(t, `재계획: ${note}`);
    return t;
  }

  // ───────────────────────── 질문·막힘 ─────────────────────────

  askProducer(task: Task, member: Member, text: string, sessionKey: string): Question {
    const ctx = this.ctx;
    const producer = producerOf(ctx, task.projectId);
    const q: Question = {
      id: ctx.store.nextId('question'),
      projectId: task.projectId,
      fromId: member.id,
      to: 'producer',
      taskId: task.id,
      directiveId: task.directiveId,
      sessionKey,
      text,
      status: 'open',
      answer: null,
      answeredBy: null,
      createdAt: ctx.now(),
      answeredAt: null,
    };
    ctx.store.questions.insert(q);
    if (task.state === 'in_progress' || task.state === 'in_review' || task.state === 'on_hold') {
      transitionTask(ctx, task.id, { type: 'hold', reason: this.reason('answer_wait', 'task', text.slice(0, 200), member.id, q.id) }, member.id);
    }
    this.queueProducerAnswer(q, producer.id);
    ctx.activity({ kind: 'question', actor: member.id, projectId: task.projectId, taskId: task.id, text: `${q.id} 질문 → 프로듀서: ${text}` });
    return q;
  }

  /** 프로듀서에게 질문 답변 업무 등록 (질문할 때·재시작 복구 때 공용) */
  queueProducerAnswer(q: Question, producerId: string): void {
    const ctx = this.ctx;
    if (!q.directiveId) return;
    const from = ctx.store.members.get(q.fromId);
    const task = q.taskId ? ctx.store.tasks.get(q.taskId) : null;
    enqueue(ctx, {
      kind: 'answer',
      memberId: producerId,
      sessionKey: directiveKey(q.directiveId),
      projectId: q.projectId,
      taskId: q.taskId,
      directiveId: q.directiveId,
      questionId: q.id,
      priority: task?.priority ?? 'normal',
      message: `${from?.name ?? q.fromId}(${q.fromId})의 질문 ${q.id}${q.taskId ? ` [${q.taskId}]` : ''}: ${q.text}\nanswer_question으로 답하세요.`,
    });
  }

  /** 질문 답변 (프로듀서 도구 또는 대표 화면) */
  answer(questionId: string, raw: string, actor: Actor): Question {
    const ctx = this.ctx;
    // 대표 화면(questions.answer)에서 온 답변도 저장 전에 가린다 (SEC-10)
    const answer = ctx.redact.text(raw);
    const q = ctx.store.questions.get(questionId);
    if (!q) throw new BackendError('not_found', `질문 ${questionId}을(를) 찾을 수 없습니다`);
    if (q.status !== 'open') return q;
    const done: Question = { ...q, status: 'answered', answer, answeredBy: actor, answeredAt: ctx.now() };
    ctx.store.questions.put(done);
    ctx.activity({ kind: 'question', actor, projectId: q.projectId, taskId: q.taskId, text: `${q.id} 답변: ${answer}` });
    const msg = `질문 ${q.id}에 대한 답변 (${actor === OWNER ? '대표' : actor}): ${answer}`;
    if (q.taskId) {
      const t = ctx.store.tasks.get(q.taskId);
      if (t && t.state === 'on_hold' && hasHold(t, 'answer_wait', (r) => r.refId === q.id)) {
        const nt = transitionTask(ctx, t.id, { type: 'release', match: (r) => r.kind === 'answer_wait' && r.refId === q.id, note: `답변 도착 ${q.id}` }, actor);
        if (nt.state === 'on_hold') {
          // 다른 보류 사유가 남아 있으면 실행하지 않는다 (AC-37). 답변은 재개 때 함께 전달
          enqueue(ctx, { kind: 'message', memberId: q.fromId, sessionKey: q.sessionKey, projectId: q.projectId, taskId: q.taskId, message: msg });
          return done;
        }
      }
      enqueue(ctx, {
        kind: q.sessionKey.startsWith('review:') ? 'review' : 'task_work',
        memberId: q.fromId,
        sessionKey: q.sessionKey,
        projectId: q.projectId,
        taskId: q.taskId,
        priority: t?.priority ?? 'normal',
        message: msg,
      });
    } else {
      enqueue(ctx, { kind: 'main_command', memberId: q.fromId, sessionKey: q.sessionKey, projectId: q.projectId, message: msg, priority: 'high' });
    }
    return done;
  }

  reportBlocked(task: Task, member: Member, reason: string): void {
    const ctx = this.ctx;
    transitionTask(ctx, task.id, { type: 'hold', reason: this.reason('blocked', 'task', reason, member.id) }, member.id);
    const producer = producerOf(ctx, task.projectId);
    enqueue(ctx, {
      kind: 'replan',
      memberId: producer.id,
      sessionKey: directiveKey(task.directiveId),
      projectId: task.projectId,
      taskId: task.id,
      directiveId: task.directiveId,
      priority: task.priority,
      message: `${member.name}이(가) ${task.id} "${task.title}" 막힘을 보고했습니다: ${reason}\n조치한 뒤 resolve_hold(kind="blocked") 또는 재배정·취소를 하세요.`,
    });
  }

  resolveHold(taskId: string, kind: 'blocked' | 'prereq_cancelled', note: string, actor: Actor): Task {
    const ctx = this.ctx;
    const task = taskOrThrow(ctx, taskId);
    if (task.state !== 'on_hold' || !hasHold(task, kind)) throw new BackendError('conflict', `${taskId}에 '${HOLD_REASON_LABEL[kind]}' 보류 사유가 없습니다`);
    this.assertDirectiveOpen(task, { releasesMerged: true });
    // main에 병합이 반영된 작업은 선행 작업이 더 필요 없다 — 완료 결과다 (5.3 '완료 결과는 유지', AC-46). 선행 작업을 다시 정하지 않아도 풀고, 풀리면
    // 다시 병합하지 않고 완료한다 (afterRelease → finishMerged). 취소된 지시의 작업이면 update_task가 막혀 다시 정할 길도 없다 (S7-B1)
    if (kind === 'prereq_cancelled' && !task.merge && task.prerequisiteIds.some((p) => ctx.store.tasks.get(p)?.state === 'cancelled')) {
      throw new BackendError('conflict', '취소된 선행 작업이 아직 남아 있습니다. update_task로 선행 작업을 다시 정한 뒤 해제하세요');
    }
    const t = transitionTask(ctx, taskId, { type: 'release', match: (r) => r.kind === kind, note }, actor);
    this.afterRelease(t, note);
    return t;
  }

  /**
   * 충돌 해결 보고 (report_conflict_resolved, GIT-07). 팀원은 git 명령 없이 파일만 고친다 (CLI-09) — 인덱스의 충돌 표시(UU·AA)는
   * 프로그램이 스테이징할 때 풀리므로 해결 여부는 작업 폴더 내용으로 본다. 충돌 표시가 남은 이른 보고는 예상한 거부(conflict)라
   * 기록·실행 없이 남은 파일을 알려 준다. 해결 커밋 뒤에는 제출 요청이 남아 있어 턴이 끝나면 최신 main 반영·자동 검사·재검수로 이어진다
   */
  async conflictResolved(task: Task, member: Member, note: string): Promise<{ sha: string; unverified: string[]; outcome: 'committed' | 'concluded' }> {
    const ctx = this.ctx;
    if (!task.workspace) throw new BackendError('invalid', '작업 공간이 없습니다');
    const wt = task.workspace.worktreePath;
    const st = await ctx.deps.git.status(wt);
    const conflict = taskOrThrow(ctx, task.id).conflict;
    if (!st.mergeInProgress && !conflict) throw new BackendError('conflict', '해결할 병합 충돌이 없습니다');
    if (!st.mergeInProgress) return this.reportWithoutMerge(task, member, wt, conflict!);
    const r = await this.commitConflictResolution(task, member, note);
    if ('markers' in r) throw new BackendError('conflict', markersLeftMessage(r.markers));
    return { ...r, outcome: 'committed' };
  }

  /**
   * 작업 폴더에 진행 중인 병합이 없는데 충돌 기록이 남은 상태의 해결 보고 — 팀원이 규칙(CLI-09)을 어기고 병합을 취소했거나(git merge --abort 등)
   * 직접 커밋했거나, 해결 커밋 뒤 기록 전에 끊긴 경우다.
   * - 그 병합이 마무리됐으면(반영하던 main이 HEAD에 들어 있음): 기록된 충돌 파일을 내용으로 본다 — 표시가 남았으면 이른 보고로 거부, 없으면 해결로 받는다
   * - 취소됐으면: 해결된 것이 없다 — 받지 않고(conflict) 사실과 다음 일을 알린다. 충돌 기록·횟수는 그대로 두고, 턴이 끝나면 해결 못 한 해결 턴으로
   *   센 뒤 프로그램이 최신 main을 다시 반영한다 — 여전히 충돌하면 충돌 표시를 되살려 해결 업무를 다시 보내고, 충돌 없이 반영되면 기록을 정리하고 제출
   *   처리를 이어 간다(processSubmissionInner). 진척으로 받으면 병합 취소·보고를 되풀이하는 턴이 끝없이 돈다 (GIT-07, CLI-18). 그 다시 반영은 남겨 둔
   *   제출 요청의 처리이므로, 제출 요청이 없으면 남긴다 (안내가 사실이도록)
   */
  private async reportWithoutMerge(task: Task, member: Member, wt: string, conflict: TaskConflict): Promise<{ sha: string; unverified: string[]; outcome: 'concluded' }> {
    const ctx = this.ctx;
    const project = projectOrThrow(ctx, task.projectId);
    const base = project.baseBranch;
    if (!(await this.mergeConcluded(wt, conflict, project))) {
      const limit = ctx.settings().execution.spinNoProgressResumes;
      const n = (conflict.unresolvedTurns ?? 0) + 1;
      const cur = taskOrThrow(ctx, task.id);
      if (!cur.pendingSubmit && cur.conflict) ctx.store.tasks.patch(task.id, { pendingSubmit: { requestedAt: ctx.now(), note: '병합 취소 뒤 최신 main 다시 반영' } });
      ctx.activity({
        kind: 'git',
        level: 'warn',
        actor: member.id,
        projectId: task.projectId,
        taskId: task.id,
        text: `${task.id} 충돌 해결 보고를 받지 않음 — 작업 폴더에 진행 중인 병합이 없고 최신 ${base}이(가) 반영돼 있지 않음 (병합 취소로 보임, 충돌 ${conflict.files.join(', ')} 미해결)`,
      });
      const next =
        n >= limit
          ? `턴이 끝나면 작업이 헛돌기로 보류되고 프로듀서가 해결 방법을 정합니다 — 다시 진행되면 프로그램이 최신 ${base}을(를) 다시 반영합니다(여전히 충돌하면 충돌 표시가 되살아남).`
          : `턴이 끝나면 프로그램이 최신 ${base}을(를) 다시 반영합니다 — 여전히 충돌하면 충돌 표시가 되살아나고 해결 업무가 다시 옵니다. 충돌 없이 반영되면 충돌 기록을 정리하고 자동 검사·검수로 이어 갑니다.`;
      throw new BackendError(
        'conflict',
        `해결된 것이 없어 이 보고는 받지 않았습니다: 작업 폴더에 진행 중인 병합이 없고 최신 ${base}이(가) 이 작업에 반영돼 있지 않습니다 — 병합이 취소된 것으로 보입니다(git merge --abort 등). 충돌 파일 ${conflict.files.join(', ')}은(는) 아직 해결되지 않았습니다. git 명령은 쓰지 마세요. 지금 턴을 마치세요 — 이 턴은 해결하지 못한 해결 턴으로 셉니다(${n}/${limit}${n >= limit ? ', 프로듀서에게 넘어감' : ''}). ${next}`,
      );
    }
    const check = await ctx.deps.git.conflictCheck(wt, conflict.files);
    if (check.withMarkers.length) throw new BackendError('conflict', markersLeftMessage(check.withMarkers));
    // 병합이 이미 커밋돼 있다 (팀원이 직접 커밋했거나 해결 커밋 뒤 기록 전에 끊김): 내용을 확인했으므로 해결로 받는다 — 해결자를 기록하고 기록을 지운다.
    // 확인하지 못한 파일(바이너리 등 — 충돌을 기록할 때 확인하지 못한 파일 포함, 팀원이 직접 스테이징했어도)은 재검수 요청에 적도록 남긴다 (GIT-07)
    const unverified = unionFiles(check.unverifiable, conflict.unverifiable);
    this.recordResolver(task.id, member);
    const cur = taskOrThrow(ctx, task.id);
    ctx.store.tx(() => {
      ctx.store.tasks.patch(task.id, { conflict: null, noProgressResumes: 0, pendingSubmit: cur.pendingSubmit ?? { requestedAt: ctx.now(), note: '충돌 해결 후 재제출' } });
      if (unverified.length) this.noteUnverifiedOutside(task.id, unverified);
    });
    const unchecked = unverified.length ? ` — 내용으로 확인하지 못한 충돌 파일은 커밋된 그대로: ${unverified.join(', ')}` : '';
    ctx.activity({
      kind: 'git',
      level: unchecked ? 'warn' : 'info',
      actor: member.id,
      projectId: task.projectId,
      taskId: task.id,
      text: `${task.id} 충돌 해결 보고 — 진행 중인 병합이 없고 그 병합이 이미 커밋돼 있어(프로그램 밖에서 마무리) 충돌 파일 내용을 확인하고 기록을 정리 (최신 ${base} 반영을 다시 확인)${unchecked}`,
    });
    return { sha: (await ctx.deps.git.revParse(wt, 'HEAD')) ?? '', unverified, outcome: 'concluded' };
  }

  /**
   * 프로그램 밖에서 커밋된 병합을 해결로 받을 때 내용으로 확인하지 못한 충돌 파일을 남긴다 — 프로그램의 해결 커밋은 실행 기록(`unverified`)에 남기고,
   * 이것은 재검수 요청이 같은 방식으로 보게 kv `conflictunverified:<작업>`에 (uncheckedConflictFiles, GIT-07)
   */
  private noteUnverifiedOutside(taskId: string, files: string[]): void {
    const ctx = this.ctx;
    const key = `conflictunverified:${taskId}`;
    ctx.store.kv.set(key, [...(ctx.store.kv.get<{ at: string; files: string[] }[]>(key) ?? []), { at: ctx.now(), files }]);
  }

  /** 충돌 해결자(실질 수정 주체)를 기록한다 → 검수 불가 (GIT-07, REV-02). 커밋보다 먼저 남겨 커밋 뒤 끊겨도 검수자에서 빠진다 */
  private recordResolver(taskId: string, member: Member): void {
    const ctx = this.ctx;
    const t = taskOrThrow(ctx, taskId);
    const contributors = t.contributors.includes(member.id) ? t.contributors : [...t.contributors, member.id];
    ctx.store.tasks.patch(taskId, { contributors, conflict: t.conflict ? { ...t.conflict, resolverId: member.id } : null });
    if (t.reviewerId === member.id) ctx.store.tasks.patch(taskId, { reviewerId: this.resolveReviewer(taskOrThrow(ctx, taskId), null) });
  }

  /**
   * 충돌 해결 커밋 (해결 보고 때, 또는 보고 뒤 커밋 전에 끊긴 것을 재시작 뒤 마무리할 때). 충돌 표시가 남은 파일이 있으면 커밋하지 않고
   * 보고를 무른 뒤 그 파일들을 돌려준다. 표시가 없어 내용으로 확인할 수 없는 충돌 파일(바이너리·한쪽이 지운 파일 등)은 작업 폴더 그대로
   * 커밋되므로 기록·활동에 남겨 재검수(GIT-07)에서 보게 한다
   */
  private async commitConflictResolution(task: Task, resolver: Member, note: string): Promise<{ sha: string; unverified: string[] } | { markers: string[] }> {
    const ctx = this.ctx;
    const git = ctx.deps.git;
    const ws = task.workspace!;
    const project = projectOrThrow(ctx, task.projectId);
    const notYet = (markers: string[]): { markers: string[] } => {
      const cur = taskOrThrow(ctx, task.id);
      if (cur.conflict?.resolverId) ctx.store.tasks.patch(task.id, { conflict: { ...cur.conflict, resolverId: null } });
      return { markers };
    };
    // 인덱스에 충돌로 남은 파일만이 아니라 기록된 충돌 파일 모두를 내용으로 본다 — 팀원이 표시가 남은 채 직접 스테이징한 파일도 걸러낸다 (GIT-07)
    const record = taskOrThrow(ctx, task.id).conflict;
    const recorded = record?.files ?? [];
    const check = await git.conflictCheck(ws.worktreePath, recorded);
    if (check.withMarkers.length) return notYet(check.withMarkers);
    // 내용으로 확인할 수 없는 충돌 파일: 지금 확인한 것 + 충돌을 기록할 때(팀원이 손대기 전) 확인하지 못한 것 — 팀원이 그 파일을 직접 스테이징해 인덱스에서
    // 충돌이 풀렸어도(수정/삭제 충돌 등) 내용으로 확인한 것이 아니다. 해결 커밋 기록·재검수 요청·대표 검수 알림에 남는다 (GIT-07 재검수 안전장치)
    const unverified = unionFiles(check.unverifiable, record?.unverifiable);
    this.recordResolver(task.id, resolver);
    const head = await git.revParse(ws.worktreePath, 'HEAD');
    let sha: string;
    try {
      sha = await recordedExec(
        ctx,
        { kind: 'git_conflict_commit', projectId: project.id, taskId: task.id, cwd: ws.worktreePath, command: 'git commit (충돌 해결)', target: ws.branch, pre: { head, resolverId: resolver.id } },
        async () => ({
          value: await git.concludeMerge(ws.worktreePath, `[${task.id}] 최신 ${project.baseBranch} 반영 충돌 해결: ${note}`, memberIdentity(resolver)),
          result: { unverified },
        }),
      );
    } catch (e) {
      // 확인과 커밋 사이에 충돌 표시가 다시 생겼으면 오류가 아니라 이른 보고다 (다시 확인하지 못하면 원래 오류를 그대로 던진다)
      const again = await git.conflictCheck(ws.worktreePath, recorded).catch(() => null);
      if (again?.withMarkers.length) return notYet(again.withMarkers);
      throw e;
    }
    const cur = taskOrThrow(ctx, task.id);
    ctx.store.tasks.patch(task.id, { conflict: null, noProgressResumes: 0, pendingSubmit: cur.pendingSubmit ?? { requestedAt: ctx.now(), note: '충돌 해결 후 재제출' } });
    const unchecked = unverified.length ? ` — 내용으로 확인하지 못한 충돌 파일은 작업 폴더 그대로 커밋: ${unverified.join(', ')}` : '';
    ctx.activity({
      kind: 'git',
      level: unchecked ? 'warn' : 'info',
      actor: resolver.id,
      projectId: task.projectId,
      taskId: task.id,
      text: `${task.id} 충돌 해결 커밋 ${sha.slice(0, 8)} (해결자 ${resolver.name})${unchecked}`,
    });
    return { sha, unverified };
  }

  // ───────────────────────── 보류·재개·취소 ─────────────────────────

  reason(kind: HoldReasonKind, scope: HoldReason['scope'], note: string, by: Actor, refId: string | null = null): HoldReason {
    return { kind, scope, refId, note, since: this.ctx.now(), by };
  }

  hold(taskId: string, kind: HoldReasonKind, scope: HoldReason['scope'], note: string, by: Actor, refId: string | null = null, returnState?: TaskState): Task {
    return transitionTask(this.ctx, taskId, { type: 'hold', reason: this.reason(kind, scope, note, by, refId), returnState }, by);
  }

  /** 보류가 풀려 원래 상태로 돌아왔을 때 다음 할 일 등록 */
  afterRelease(task: Task, note: string): void {
    const ctx = this.ctx;
    if (task.state === 'in_progress') {
      // 되돌리기 커밋을 아직 기록하지 못한 되돌리기 작업은 담당에게 '이어서 진행'을 주지 않고 프로그램이 이어 간다 (CLI-09, AC-12)
      if (this.core.merges.revertPending(task)) void this.core.merges.resumeRevert(task.id);
      else if (task.pendingSubmit) void this.processSubmission(task.id);
      else if (task.conflict) {
        enqueue(ctx, {
          kind: 'conflict_fix',
          memberId: task.assigneeId,
          sessionKey: taskKey(task.id),
          projectId: task.projectId,
          taskId: task.id,
          priority: task.priority,
          message: `재개: 병합 충돌이 아직 해결되지 않았습니다.\n${conflictFixGuide(task.conflict.files, task.conflict.unverifiable, revertOfFor(task))}`,
          dedupeKind: true,
        });
      } else this.continueWork(task.id, `작업이 재개되었습니다 (${note}). get_work_context로 상태를 확인하고 이어서 진행하세요.`);
    } else if (task.state === 'in_review') {
      if (task.review.passed) {
        if (task.outputMode === 'artifact') this.core.merges.finalizeArtifactOrHold(task.id);
        // 병합 도중 정지·보류된 작업: main 반영은 기록돼 있으므로 다시 병합하지 않고 완료한다 (5.3 보류→검수→완료)
        else if (task.merge) void this.core.merges.finishMerged(task.id, null);
        else this.core.merges.queueMergeDecision(task);
      } else this.dispatchReview(task);
    }
    ctx.bus.signal('tick');
  }

  /** 이 업무 세션에 아직 전달하지 않은 긴급 지시 (CLI-10 우선 전달, AC-36). memberId를 주면 그 팀원 앞으로 온 것만 */
  ownerMessagesWaiting(sessionKey: string, memberId?: string): QueueEntry[] {
    return this.ctx.store.queue.list({ ref2: sessionKey, state: 'queued' }).filter((q) => isUrgentDirect(q) && (!memberId || q.memberId === memberId));
  }

  /**
   * 메인 에이전트가 이 작업에 보낸 긴급 지시(옛 대표 직접 메시지 포함) — 작업자(작업 세션)·검수자(검수 세션)에게 보낸 것, 오래된 것부터 최근 OWNER_INSTRUCTIONS_MAX건.
   * 그 작업을 검수하는 쪽은 프로듀서든 아니든 판정 전에 이것을 본다 (CTL-06, AC-17 공유): 검수 턴 메시지의 '긴급 지시' 절,
   * get_review_target·get_work_context의 urgentInstructions, 그 뒤에 온 것은 판정 거부 안내 (tools submit_review). 아직 전달 대기인 것은 넣고, 전달하지
   * 못하고 지운 것(대표에게 알림)은 넣지 않는다. 그 작업의 세션 키로 온 것만 — 다른 작업의 지시를 섞지 않는다 (AC-40)
   */
  ownerInstructionsFor(taskId: string): AgentMessage[] {
    const keys = new Set([taskKey(taskId), reviewKey(taskId)]);
    return this.ctx.store.messages
      .list()
      .filter((m) => isUrgentMessage(m) && !!m.sessionKey && keys.has(m.sessionKey) && !m.undeliveredAt)
      .slice(-OWNER_INSTRUCTIONS_MAX);
  }

  /** 검수자에게 보이는 긴급 지시 한 건 (get_review_target·get_work_context) */
  ownerInstructionView(m: AgentMessage): UrgentInstructionView {
    const name = this.ctx.store.members.get(m.toMemberId)?.name ?? m.toMemberId;
    return { messageId: m.id, at: m.createdAt, to: `${name}(${m.toMemberId}, ${m.sessionKey?.startsWith('review:') ? '검수자' : '작업자'})`, text: m.text, delivered: !!m.deliveredAt };
  }

  /** 검수 턴 메시지·판정 거부 안내에 넣는 긴급 지시 한 줄 */
  ownerInstructionLine(m: AgentMessage): string {
    const v = this.ownerInstructionView(m);
    const text = m.text.replace(/\s+/g, ' ').trim();
    const pending = v.delivered
      ? ''
      : m.sessionKey?.startsWith('review:')
        ? ' (검수자에게 아직 전달 전 — 그 검수 턴이 끝나면 검수 세션의 다음 턴 맨 앞에 전달)'
        : ' (작업자에게 아직 전달 전 — 검수 중이라 기다림: 반려되면 재작업 첫 턴에, 통과해도 완료하기 전에 진행으로 돌려 전달)';
    return `[${v.at}] ${m.kind === 'owner_direct' ? '대표' : '메인 에이전트'} → ${v.to}: ${text.length > 600 ? `${text.slice(0, 599)}…` : text}${pending}`;
  }

  /**
   * 통과 뒤 그 검수자에게 온 대표 직접 메시지가 그 검수 세션에서 기다리는지 (CTL-06, AC-36) — 기다리면 병합·산출물 확정을 미루고, 그 검수 세션의 다음
   * 턴 맨 앞에 메시지를 전달한 뒤 검수자가 다시 판정할 수 있게 한다 (holdForReviewerMessage). 지금 대상의 통과, main 반영 전, 대표가 아닌 검수자일 때만
   */
  reviewerMessagesAfterPass(task: Task): QueueEntry[] {
    const p = task.review.passed;
    if (!p || p.reviewerId === OWNER || task.merge || !sameTarget(p.target, task.review.target)) return [];
    return this.ownerMessagesWaiting(reviewKey(task.id), p.reviewerId);
  }

  /**
   * 통과 뒤 그 검수자에게 온 대표 메시지 때문에 병합·산출물 확정을 미루는지 — 메시지가 그 검수 세션에서 기다리거나, 이미 다시 판정 턴에 실려 나갔어도 그 턴이
   * 정상으로 끝나지 않았다(rejudgewait). holdForReviewerMessage가 미루는 조건 그대로라, 프로듀서의 병합 후보(get_work_context·병합 판단 재촉)도 이것으로
   * 거른다 — request_merge가 거부할 작업을 후보로 주지 않는다 (CTL-06, GIT-04, S8-B3)
   */
  mergeDeferredForReviewer(t: Task): boolean {
    return this.reviewerMessagesAfterPass(t).length > 0 || !!this.rejudgeWaitOf(t);
  }

  /**
   * 병합 판단·병합 처리·산출물 확정 앞에서 부른다: 통과 뒤 그 검수자에게 온 대표 직접 메시지가 기다리면 미루고 true. 같은 버전에 묶인 '다시 판정'
   * 검수 업무를 그 검수자에게 넣고(같은 항목은 하나 — 대표 메시지 뒤에 간다), 그 통과를 그 검수자가 다시 판정할 수 있다고 적는다(kv `rejudge:<작업>` —
   * 같은 검수자의 새 판정이 그 통과를 대신한다, submitReview). 검수자가 다시 판정하지 않고 턴을 마치면 그 통과로 이어 간다 (turns.settleReview)
   */
  holdForReviewerMessage(taskId: string): boolean {
    const ctx = this.ctx;
    const t = ctx.store.tasks.get(taskId);
    // 취소·종료된 지시의 작업은 병합·확정으로 가지 않으니 미룰 것도 없다 — 지시 취소가 그 작업을 취소하며 남은 메시지를 알린다 (AC-46)
    if (!t || closedDirectiveWork(ctx, null, t) || !this.mergeDeferredForReviewer(t)) return false;
    const waiting = this.reviewerMessagesAfterPass(t);
    // 메시지가 이미 다시 판정 턴에 실려 나갔어도 그 턴이 정상으로 끝나기 전이면 미룸은 그대로다 (rejudgewait, S7-B3)
    const wait = this.rejudgeWaitOf(t);
    const passed = t.review.passed!;
    const pin = t.review.target!.pinnedAt;
    const key = reviewKey(t.id);
    const what = t.outputMode === 'artifact' ? '산출물 확정' : '병합 판단';
    const fresh = !wait && !ctx.store.queue.list({ ref2: key, state: 'queued' }).some((q) => q.kind === 'review' && q.reviewPinnedAt === pin);
    ctx.store.tx(() => {
      ctx.store.kv.set(rejudgeKey(t.id), passed.reviewId);
      if (!wait) ctx.store.kv.set<RejudgeWait>(rejudgeWaitKey(t.id), { reviewId: passed.reviewId, reviewerId: passed.reviewerId, since: ctx.now() });
      enqueue(ctx, {
        kind: 'review',
        memberId: passed.reviewerId,
        sessionKey: key,
        projectId: t.projectId,
        taskId: t.id,
        directiveId: t.directiveId,
        priority: t.priority,
        reviewPinnedAt: pin,
        message: [
          `${t.id} "${t.title}" — 이 버전(${t.review.round}차)은 이미 통과로 판정했습니다 (${passed.reviewId}). 판정 뒤 긴급 지시가 도착해 ${what}을(를) 미뤘습니다.`,
          '위 긴급 지시를 확인하세요. 지시에 따라 판정을 바꿔야 하면 get_review_target으로 대상을 다시 확인하고 submit_review를 호출하세요 — 이 버전에 대한 새 판정이 등록한 통과를 대신합니다 (긴급 지시가 우선, CTL-06).',
          `바꿀 것이 없으면 판정을 다시 하지 말고 턴을 마치세요 — 등록한 통과로 ${what}을(를) 이어 갑니다.`,
        ].join('\n'),
        dedupeKind: true,
      });
    });
    if (fresh) {
      ctx.activity({
        kind: 'review',
        projectId: t.projectId,
        taskId: t.id,
        text: `${t.id} ${what} 미룸 — 통과 뒤 검수자 ${passed.reviewerId}에게 온 긴급 지시 ${waiting.length}건을 먼저 전달하고 다시 판정할 수 있게 함 (CTL-06)`,
      });
    }
    ctx.bus.signal('tick');
    return true;
  }

  /**
   * 지금 통과에 걸린 다시 판정 기다림 (S7-B3) — 다른 통과(새 판정)·main 반영 뒤·대표 검수면 없다. 검수자가 바뀌었으면(교체·재배정) 그 통과의 검수자는 더
   * 판정할 수 없으므로 기다리지 않는다 — 바꾼 쪽(프로듀서·대표)이 정했다
   */
  rejudgeWaitOf(t: Task): RejudgeWait | null {
    const p = t.review.passed;
    if (!p || p.reviewerId === OWNER || t.reviewerId !== p.reviewerId || t.merge || !sameTarget(p.target, t.review.target)) return null;
    const w = this.ctx.store.kv.get<RejudgeWait>(rejudgeWaitKey(t.id));
    return w && w.reviewId === p.reviewId ? w : null;
  }

  /**
   * 그 통과의 검수자가 다시 판정 업무를 실은 검수 턴을 정상으로 마쳤다 (turns.judgeReview — 질문·대표 메시지로 끝낸 턴은 아니다): 대표 메시지를 보고 판정을
   * 바꾸지 않기로 했다 — 그 통과로 이어 가게 미룸을 푼다. 그 사이 온 대표 메시지가 아직 기다리면 풀지 않는다 (그 메시지를 실은 턴이 다시 판정한다, S7-B3)
   */
  rejudgeTurnCompleted(taskId: string, memberId: string): void {
    const ctx = this.ctx;
    const t = ctx.store.tasks.get(taskId);
    const w = t ? this.rejudgeWaitOf(t) : null;
    if (!t || !w || w.reviewerId !== memberId || this.reviewerMessagesAfterPass(t).length) return;
    ctx.store.kv.set(rejudgeWaitKey(taskId), null);
    ctx.activity({
      kind: 'review',
      actor: memberId,
      projectId: t.projectId,
      taskId,
      text: `${taskId} 다시 판정 턴 마침 — 검수자가 긴급 지시를 보고 판정을 바꾸지 않아 등록한 통과(${w.reviewId})로 ${t.outputMode === 'artifact' ? '산출물 확정' : '병합 판단'}을(를) 이어 감`,
    });
  }

  /**
   * 다시 판정 실패로 보류된(holdRejudgeStuck) 작업 중 이 팀원이 그 통과의 검수자인 것 — 대표가 이 팀원에게 보내는 직접 메시지는 그 작업의 검수 세션으로
   * 간다(api ownerMessage: 지금 턴·맡은 작업보다 먼저). 보류 알림이 안내한 길이다. 여럿이면 먼저 보류된 작업(같으면 작업 ID 순) — 정해진 하나 (CTL-06, S8-B1)
   */
  rejudgeHeldTaskFor(memberId: string): Task | null {
    return this.rejudgeHoldsFor(memberId)[0]?.task ?? null;
  }

  /** 다시 판정 실패 보류 중인 작업 중 이 팀원이 그 통과의 검수자인 것 — 메시지가 가는 차례대로 (먼저 보류된 것, 같으면 작업 ID 순) */
  private rejudgeHoldsFor(memberId: string): { task: Task; since: string }[] {
    return this.ctx.store.tasks
      .list({ state: 'on_hold' })
      .flatMap((task) => {
        const since = task.hold.reasons.find((r) => r.refId === REJUDGE_HOLD_REF && isOwnerResumable(r))?.since;
        return since && this.rejudgeWaitOf(task)?.reviewerId === memberId ? [{ task, since }] : [];
      })
      .sort(byRejudgeHold);
  }

  /**
   * 다시 판정 턴이 상한까지 판정 기회 없이 끝났다 (turns.rejudgeCut — 비정상 종료·사용량 한도·이어하기 실패 등이 crashRetryMax번 이어짐). 검수자가 대표
   * 메시지를 보고 다시 판정하지 못한 통과를 그대로 병합·확정하지 않는다 — 보류(오류)하고 대표에게 알린다. 대표가 재개하면 그 통과로 이어 가고(대표가
   * 정함, resumeByOwner), 그 전에 검수자에게 다시 메시지를 보내면(그 작업의 검수 세션으로 감 — rejudgeHeldTaskFor) 재개 뒤 그 메시지로 다시 판정한다
   * (CTL-06, CTL-10, ERR-04, S7-B3, S8-B1)
   */
  holdRejudgeStuck(taskId: string, why: string, turns: number): void {
    const ctx = this.ctx;
    const t = ctx.store.tasks.get(taskId);
    if (!t || t.state !== 'in_review' || !this.rejudgeWaitOf(t)) return;
    const passed = t.review.passed!;
    const what = t.outputMode === 'artifact' ? '산출물 확정' : '병합 판단';
    const who = memberName(ctx, passed.reviewerId) || passed.reviewerId;
    // 같은 검수자의 다시 판정 실패 보류가 이미 있으면 메시지는 먼저 보류된 작업으로 간다(rejudgeHeldTaskFor) — 보류 사유가 지금 받는 작업과 이 작업이 받게
    // 되는 때를 그대로 말한다 (CTL-11, S9-B3). 차례는 이 보류의 시각으로 정한다
    const reason = this.reason('error', 'task', '', 'system', REJUDGE_HOLD_REF);
    const earlier = this.rejudgeHoldsFor(passed.reviewerId)
      .filter((h) => byRejudgeHold(h, { task: t, since: reason.since }) < 0)
      .map((h) => h.task.id);
    const route = !earlier.length
      ? `이 보류 중에 ${who}에게 보내는 긴급 지시는 이 작업의 다시 판정으로 감`
      : earlier.length === 1
        ? `${who}에게 보내는 긴급 지시는 먼저 보류된 ${earlier[0]}을(를) 재개하거나 취소할 때까지 ${earlier[0]}의 다시 판정으로 가고, 그 뒤에 이 작업의 다시 판정으로 감`
        : `${who}에게 보내는 긴급 지시는 먼저 보류된 ${earlier.join('·')}을(를) 모두 재개하거나 취소할 때까지 그중 먼저 보류된 작업(지금은 ${earlier[0]})의 다시 판정으로 가고, 그 뒤에 이 작업의 다시 판정으로 감`;
    const note = `다시 판정 못 함: 통과 뒤 검수자 ${who}에게 온 긴급 지시를 보고 다시 판정할 검수 턴이 ${turns}번 이어서 ${why}(으)로 끝남 — 메인 에이전트가 검수자 ${who}에게 긴급 지시를 보낸 뒤 재개하면 검수자가 그 지시를 보고 다시 판정한 뒤에 그 판정대로 이어 가고(${route}), 지시 없이 재개하면 등록한 통과로 ${what}을(를) 이어 갑니다`;
    transitionTask(ctx, taskId, { type: 'hold', reason: { ...reason, note } }, 'system');
    // 이 보류는 메인 에이전트에게 알림 업무로 간다(alert rejudge-stuck:<작업>, 리드 결정 S5-8) — 다시 판정을 받을지 등록한 통과로 이어 갈지 메인이 정한다.
    // 넘기지 못했으면(같은 보류를 이미 받아 마침) 대표가 명령창으로 말하는 길을 적는다 (리드 결정 32·S5-9)
    const handed = alertTaskHold(ctx, 'rejudge-stuck', taskId, { cause: `검수자 ${who}이(가) 긴급 지시를 보고 다시 판정하지 못해 ${what}을(를) 하지 않고 보류됨 (검수 턴 ${turns}번 ${why})` });
    ctx.notify({
      level: 'urgent',
      title: '다시 판정 실패',
      body: `${t.id} ${t.title} — 검수자 ${who}이(가) 긴급 지시를 보고 다시 판정하지 못했습니다 (검수 턴 ${turns}번 ${why}). ${what}을(를) 하지 않고 보류했습니다. ${
        handed ? `다시 판정을 받을지 등록한 통과로 이어 갈지 정하도록 ${OWNER_HANDED}` : `다시 판정을 받을지 등록한 통과로 이어 갈지 ${OWNER_TELL_MAIN}`
      }. 판정을 다시 받으려면 메인 에이전트가 검수자에게 긴급 지시를 보낸 뒤 재개합니다 — 이 보류 중에 ${who}에게 보내는 긴급 지시는 이 작업의 다시 판정으로 가고(같은 검수자에게 이런 보류가 여럿이면 먼저 보류된 작업으로), 재개하면 검수자가 그 지시를 보고 다시 판정한 뒤에 그 판정대로 이어 갑니다(통과가 그대로면 ${what}). 지시 없이 재개하면 등록한 통과로 ${what}을(를) 이어 갑니다`,
      link: { tab: 'projects', projectId: t.projectId, taskId: t.id },
      key: `rejudge-stuck:${t.id}`,
    });
  }

  /**
   * 검수 중인 작업의 작업 세션에 대표 직접 메시지가 기다리면 완료(병합·산출물 확정)하기 전에 진행으로 돌린다 — 그대로 완료하면 그 세션이
   * 다시 열리지 않아 메시지가 전달되지 못한다 (AC-36 "같은 업무 세션에 우선 전달", CLI-10, CTL-06). 검수 중에는 작업 폴더에 턴을 띄우지
   * 않으므로(REV-08) "수정이 필요하면 진행으로 돌려 새 버전을 제출"하는 길로 간다: 다음 작업 턴(같은 CLI 세션) 맨 앞에 메시지가 가고, 팀원이
   * 반영해 다시 제출하면 새 버전으로 자동 검사·검수를 다시 한다. 반려가 아니다 — 반려 횟수에 넣지 않는다 (REV-04·07).
   * 검수 통과·병합 판단·병합 직전·산출물 확정이 부른다. main에 병합이 반영된 작업은 되돌릴 수 없어 돌리지 않는다(완료 뒤 남은 메시지는 알림과
   * 함께 정리). 병합 처리 중인 작업은 병합 처리 자신(inMerge, 프로젝트 잠금 안)만 돌린다. 돌렸으면 true
   */
  reopenForOwnerMessage(taskId: string, o: { inMerge?: boolean } = {}): boolean {
    const ctx = this.ctx;
    const t = ctx.store.tasks.get(taskId);
    if (!t || t.state !== 'in_review' || t.merge) return false;
    if (!o.inMerge && this.core.merges.isPending(taskId)) return false;
    const waiting = this.ownerMessagesWaiting(taskKey(taskId), t.assigneeId);
    if (!waiting.length) return false;
    ctx.store.tx(() => {
      transitionTask(ctx, taskId, { type: 'reopen', reason: `긴급 지시 ${waiting.length}건을 먼저 전달 — 반영 뒤 다시 제출 (반려 아님, REV-08)` }, 'system');
      // 끝난 버전의 검수 업무가 남아 있으면 지운다 — 다시 제출해 새 버전을 고정할 때 새로 등록된다 (검수자에게 온 긴급 지시는 남긴다)
      cancelQueued(ctx, (q) => q.sessionKey === reviewKey(taskId) && q.kind === 'review');
      this.continueWork(
        taskId,
        '검수 중에 긴급 지시가 도착해 완료하기 전에 작업을 진행으로 돌렸습니다 (반려 아님 — 반려 횟수에 넣지 않음). 위 긴급 지시를 확인해 필요한 것을 반영한 뒤 submit_for_review를 다시 호출하세요. 바꿀 것이 없어도 다시 제출해야 검수·완료로 이어집니다.',
      );
    });
    ctx.notify({
      level: 'info',
      title: '긴급 지시 먼저 전달',
      body: `${t.id} ${t.title} — 작업자에게 보낸 긴급 지시가 아직 전달되지 않아 완료하기 전에 진행으로 돌려 같은 업무 세션에 먼저 전달합니다. 반영한 새 버전을 다시 검수합니다 (반려 아님)`,
      link: { tab: 'projects', projectId: t.projectId, taskId: t.id },
      key: `urgent-reopen:${t.id}`,
    });
    ctx.bus.signal('tick');
    return true;
  }

  /** 작업 세션에 다음 할 일 등록. restarts: 재시작 복구가 끊긴 일을 이어서 진행할 때 그 일의 재시작으로 끊긴 횟수 (리드 결정 44, 그 밖에는 0) */
  continueWork(taskId: string, message: string, kind: 'task_work' | 'conflict_fix' | 'message' = 'task_work', attempts = 0, restarts = 0): void {
    const t = taskOrThrow(this.ctx, taskId);
    enqueue(this.ctx, {
      kind,
      memberId: t.assigneeId,
      sessionKey: taskKey(taskId),
      projectId: t.projectId,
      taskId,
      directiveId: t.directiveId,
      priority: t.priority,
      message,
      attempts,
      restarts,
      dedupeKind: true,
    });
  }

  /**
   * 항목별 명시적 재개 (CTL-10). v0.6에서는 메인 에이전트가 한다(resume_task, actor M-MAIN) — 이름은 예전 대표 재개에서 왔다. 기본 행위자는 대표(예전 기록·시험 호환).
   * beforeRelease: 아래 거부(긴급 정지·취소 중·바로 풀 수 없는 보류·닫힌 지시)를 모두 지난 뒤, 풀기 바로 전에 그 작업과 풀 사유로 부른다 — 던지면 풀지 않는다
   * (resume_task가 메인이 아직 받지 않은 알림을 먼저 보여 준다, 리드 결정 S5-45)
   */
  resumeByOwner(taskId: string, actor: Actor = OWNER, o: { beforeRelease?: (task: Task, released: HoldReason[]) => void } = {}): Task {
    const ctx = this.ctx;
    const who = memberName(ctx, actor);
    if (ctx.stop().global.active) throw new BackendError('conflict', '긴급 정지 중입니다. 먼저 정지를 해제하세요');
    if (this.cancelling.has(taskId)) throw new BackendError('conflict', `${taskId}은(는) 취소 처리 중입니다`);
    const task = taskOrThrow(ctx, taskId);
    if (task.state !== 'on_hold' || !task.hold.reasons.some(isOwnerResumable)) {
      // 무엇이 그 보류를 푸는지 같이 알린다 — 취소 거부 안내(mergedNotCancellable)와 같은 길을 가리킨다 (S7-B2)
      const why = task.hold.reasons.map((r) => this.holdReleaseText(r)).join(', ') || task.state;
      throw new BackendError('conflict', `${who}가 바로 재개할 수 있는 보류가 아닙니다 (${why})`);
    }
    // 지시가 취소된 작업(작업 취소가 실패해 보류로 남은 경우 등)은 재개하지 않는다 — 다시 취소하면 이어서 마친다. main에 병합이 이미 반영된 작업(병합
    // 도중 긴급 정지·중단으로 보류)은 지시 취소가 취소하지 않는 완료 결과다 — 재개하면 다시 병합하지 않고 완료한다 (CTL-10, 5.3 '완료 결과는 유지', AC-46)
    this.assertDirectiveOpen(task, { releasesMerged: true });
    o.beforeRelease?.(task, task.hold.reasons.filter(isOwnerResumable));
    // 다시 판정하지 못한 통과의 보류(holdRejudgeStuck)를 대표가 재개했다 — 대표가 그 통과로 이어 가기로 정했다: 미룸 기록을 함께 푼다 (그 사이 검수자에게
    // 보낸 대표 메시지가 있으면 재개 뒤 병합 판단이 다시 미루고 그 메시지로 다시 판정한다, S7-B3)
    const decided = task.hold.reasons.some((r) => isOwnerResumable(r) && r.refId === REJUDGE_HOLD_REF);
    const t = ctx.store.tx(() => {
      if (decided) ctx.store.kv.set(rejudgeWaitKey(taskId), null);
      return transitionTask(ctx, taskId, { type: 'release', match: isOwnerResumable, note: `${who} 재개` }, actor);
    });
    // 대표가 원인을 정리하고 재개했다 — 자동 재시도 횟수를 다시 센다 (충돌의 해결 못 한 턴 수 포함, 헛돌기 횟수는 그대로: 같은 충돌의 두 번째 헛돌기는 대표 보고)
    const after = taskOrThrow(ctx, taskId);
    ctx.store.tasks.patch(taskId, { crashRetries: 0, noProgressResumes: 0, checkFailStreak: 0, ...(after.conflict ? { conflict: { ...after.conflict, unresolvedTurns: 0 } } : {}) });
    if (t.state !== 'on_hold') this.afterRelease(taskOrThrow(ctx, taskId), `${who} 재개`);
    ctx.activity({ kind: 'resume', actor, projectId: t.projectId, taskId, text: `${taskId} ${who} 재개 → ${t.state}` });
    return t;
  }

  /** 중단 (9장): 중단한 쪽(v0.6: 메인 에이전트)의 선택을 실행 종료보다 먼저 저장한다 (CTL-08) — 실행 허용 검사·제출 처리·병합·검사 시작이 바로 멈춘다 */
  async interrupt(taskId: string, then: 'hold' | 'cancel', actor: Actor): Promise<void> {
    const ctx = this.ctx;
    const who = memberName(ctx, actor);
    const task = taskOrThrow(ctx, taskId);
    if (isTerminal(task.state)) throw new BackendError('conflict', `${taskId}은(는) 이미 끝났습니다`);
    if (then === 'cancel') return this.cancel(taskId, `${who} 중단 후 취소`, actor);
    this.hold(taskId, 'interrupted', 'task', `${who} 중단`, actor);
    await this.core.turns.stopSessions([taskKey(taskId), reviewKey(taskId)], `${who} 중단`, true);
    await this.core.checks.terminateFor((id) => id === taskId);
  }

  /**
   * 팀원 중단 (9장 '중단', members.interrupt·interrupt_member): 중단은 작업 단위다 — 지금 돌고 있는 작업·검수 턴의 작업을 먼저, 없으면 맡은 활성 작업을
   * 보류·취소한다. 남의 작업을 검수하던 팀원이면 그 검수 대상 작업이 보류·취소된다 (F5). 작업 없이 도는 턴(관리 업무)은 그 턴만 끝낸다
   */
  async interruptMember(memberId: string, then: 'hold' | 'cancel', actor: Actor): Promise<void> {
    const ctx = this.ctx;
    const live = this.core.turns.liveOf(memberId);
    const turn = live ? ctx.store.turns.get(live.turnId) : null;
    const running = turn && (turn.sessionKind === 'task' || turn.sessionKind === 'review') ? turn.taskId : null;
    const active = running ?? activeTaskOf(ctx, memberId)?.id ?? null;
    if (active) return this.interrupt(active, then, actor);
    if (this.core.turns.isMemberRunning(memberId)) {
      await this.core.turns.stopMember(memberId, `${memberName(ctx, actor)} 중단`, true);
      return;
    }
    throw new BackendError('conflict', '중단할 작업이 없습니다');
  }

  /**
   * 취소 (5.3 미완료 → 취소, 9장 중단 후 취소). 같은 작업의 취소가 이미 진행 중이면 그 결과를 기다린다.
   * 병합이 이미 main에 반영된 작업은 취소하지 않는다 (AC-46: 완료 결과 유지, 되돌리기는 별도 작업 — TSK-09)
   */
  cancel(taskId: string, reason: string, actor: Actor): Promise<void> {
    const inflight = this.cancelling.get(taskId);
    if (inflight) return inflight;
    const job = this.cancelInner(taskId, reason, actor);
    this.cancelling.set(taskId, job);
    job.then(
      () => this.cancelling.delete(taskId),
      () => this.cancelling.delete(taskId),
    );
    return job;
  }

  private async cancelInner(taskId: string, reason: string, actor: Actor): Promise<void> {
    const ctx = this.ctx;
    const task = taskOrThrow(ctx, taskId);
    if (task.state === 'cancelled') return;
    if (task.state === 'done') throw this.mergedNotCancellable(task);
    if (task.merge) {
      // main에 병합이 이미 반영된 작업은 취소하지 않는다. 앞선 취소가 병합과 겹쳐 그 취소의 보류가 남았으면(풀기 전에 끊겨 재시작 복구·다시 취소가
      // 부름) 기다린 뒤의 처리와 같게 그 보류만 풀어 완료되게 한다 — 같은 작업의 취소는 하나씩만 돌므로 남은 취소 보류는 끝난 취소의 것이다
      this.withdrawCancelOfMerged(task, actor);
      throw this.mergedNotCancellable(taskOrThrow(ctx, taskId));
    }
    // 1) 선택을 먼저 저장 (CTL-08, 정지와 같은 순서) — 재시작해도 취소를 이어서 마친다 (recovery)
    this.hold(taskId, 'interrupted', 'task', `취소 처리 중: ${reason}`, actor, CANCEL_HOLD_REF);
    // 2) 실행 종료 확인 → 진행 중이던 병합·제출 처리가 끝나기를 기다린다 (보류를 보고 바로 빠지거나, main 반영이 끝났으면 기록을 남김)
    const stopped = await this.core.turns.stopSessions([taskKey(taskId), reviewKey(taskId)], `작업 취소: ${reason}`, true);
    const checks = await this.core.checks.terminateFor((id) => id === taskId);
    await this.core.merges.settled(taskId);
    await this.submissionSettled(taskId);
    const cur = taskOrThrow(ctx, taskId);
    if (cur.state === 'cancelled') return;
    if (cur.state === 'done') throw this.mergedNotCancellable(cur);
    if (cur.merge) {
      // 기다리는 사이 main 반영이 끝났다 → 이번 취소의 보류만 풀어 원래대로 완료되게 한다
      this.withdrawCancelOfMerged(cur, actor);
      throw this.mergedNotCancellable(taskOrThrow(ctx, taskId));
    }
    // 다른 업무 세션(지시 관리·메인 에이전트)으로 간 대표 직접 메시지는 그 세션이 계속 도므로 남긴다 — 그 턴이 이 작업 일을 하던 중에 왔을 뿐이다
    const mine = (q: QueueEntry) => q.sessionKey === taskKey(taskId) || q.sessionKey === reviewKey(taskId) || (q.taskId === taskId && !isUrgentDirect(q));
    const why = `${taskId}이(가) 취소됨 (${reason})`;
    cancelQueued(ctx, mine, why);
    this.assertCancelNotCutByShutdown(taskId);
    // 3) 중간 결과 보관은 반드시 (GIT-10). 실패하면 아무것도 지우지 않고 보류로 남긴다 — 다시 취소하면 이어서 한다
    try {
      await this.archiveWorkspace(cur, 'cancel');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // 다시 취소하면 이어서 한다 — 취소는 메인 에이전트의 일이다. 이 실패는 메인 에이전트에게 알림 업무로 간다(alert cancel-fail:<작업> — 출구는 cancel_task를
      // 다시, resume_task가 아니다). 보류(취소 처리 중)는 그대로 둔 채 넘기고 대표 알림은 넘긴 사실을 쓴다 (리드 결정 40·S5-7·S5-9)
      const handed = alertTaskHold(ctx, 'cancel-fail', taskId, { cause: `중간 결과를 보관하지 못해 취소를 마치지 못함 (취소 처리 중 보류 그대로): ${msg}` });
      ctx.notify({
        level: 'urgent',
        title: '작업 취소 실패',
        body: `${taskId}: 중간 결과를 보관하지 못해 취소를 마치지 못했습니다 (보류 유지): ${msg} — ${handed ? OWNER_HANDED : ownerExit(false)}`,
        link: { tab: 'projects', projectId: cur.projectId, taskId },
        key: `cancel-fail:${taskId}`,
      });
      throw e;
    }
    transitionTask(ctx, taskId, { type: 'cancel', reason }, actor);
    for (const q of ctx.store.questions.list({ ref1: taskId, state: 'open' })) ctx.store.questions.put({ ...q, status: 'cancelled' });
    // 선행 작업 취소 → 후속 작업 보류, 프로듀서가 의존성을 다시 정함 (TSK-04). main에 병합이 이미 반영된 후속 작업(병합 도중 정지로 보류 등)은 선행
    // 작업이 더 필요 없는 완료 결과다 — 보류를 더하지 않는다. 더하면 지시 취소 뒤에는 그 보류를 풀 길이 없어 영영 끝나지 못한다 (5.3, AC-46, S7-B1)
    for (const dep of ctx.store.tasks.list({ project_id: task.projectId })) {
      if (isTerminal(dep.state) || dep.merge || !dep.prerequisiteIds.includes(taskId)) continue;
      this.hold(dep.id, 'prereq_cancelled', 'task', `선행 작업 ${taskId} 취소`, 'system');
      const producer = producerOf(ctx, dep.projectId);
      enqueue(ctx, {
        kind: 'replan',
        memberId: producer.id,
        sessionKey: directiveKey(dep.directiveId),
        projectId: dep.projectId,
        taskId: dep.id,
        directiveId: dep.directiveId,
        priority: dep.priority,
        message: `선행 작업 ${taskId}이(가) 취소되어 ${dep.id} "${dep.title}"이(가) 보류됐습니다. update_task로 선행 작업을 다시 정하고 resolve_hold(kind="prereq_cancelled")로 해제하거나 취소하세요.`,
      });
    }
    this.core.team.applyPendingAiIfIdle(task.assigneeId);
    this.core.directives.checkRoundDone(task.directiveId);
    // 4) 작업 공간 정리는 최선 노력 — 실패해도 취소는 유지하고 다음 시작 때 다시 정리한다 (windows: 폴더를 쓰는 프로그램).
    //    종료를 확인하지 못한 프로세스가 있으면 그 폴더를 건드리지 않고 시작 때 정리에 맡긴다 (CTL-11).
    //    앱 종료 중이면 정리(git)를 하지 않고 다음 시작의 복구(끝난 작업의 남은 작업 폴더 정리)에 맡긴다 — 종료가 정리를 기다리지 않게 (S7-D2)
    if (this.core.stopping) {
      ctx.activity({ kind: 'git', projectId: cur.projectId, taskId, text: `${taskId} 취소 — 앱 종료 중이라 작업 폴더 정리는 다음 시작 때` });
    } else if (stopped.every((r) => r.ok) && checks.every((c) => c.result.ok)) {
      await this.cleanupWorkspace(cur);
    } else {
      ctx.log('warn', `종료를 확인하지 못한 프로세스가 있어 작업 폴더 정리를 미룸 ${taskId}`);
      ctx.activity({ kind: 'git', level: 'warn', projectId: cur.projectId, taskId, text: `${taskId} 취소 — 남은 프로세스가 있어 작업 폴더 정리는 다음 시작 때` });
    }
    // 처리하는 동안 들어온 낡은 항목 정리
    cancelQueued(ctx, mine, why);
    ctx.bus.signal('tick');
  }

  /**
   * 앱 종료 중이면 취소의 git 단계(중간 결과 보관)로 가지 않고 거부한다 (S7-D2, SHUT-1, ENV-09) — 종료가 저장소를 닫기 전에 그 단계를 기다리지 않게.
   * 취소 선택(취소 보류)은 이미 저장돼 있어 다음 시작의 복구(recovery 2-2)가 보관부터 이어서 마친다 (보관은 여러 번 해도 같다)
   */
  private assertCancelNotCutByShutdown(taskId: string): void {
    if (!this.core.stopping) return;
    this.ctx.log('info', `앱 종료 중이라 ${taskId} 취소를 다음 시작 때 이어서 마침 (취소 보류 유지)`);
    throw new BackendError('conflict', `앱을 종료하는 중이라 ${taskId} 취소를 마치지 못했습니다 — 취소 선택은 저장돼 있어 다음 시작 때 이어서 마칩니다`);
  }

  /**
   * main에 병합이 반영된 작업에 남은, 기다릴 것이 없는 보류를 푼다: 끝난 취소의 보류(refId cancel)와 '선행 작업 취소'(병합이 반영된 작업은 선행
   * 작업이 더 필요 없다, S7-B1). 남은 사유가 없으면 원래대로(검수) 돌아가 다시 병합하지 않고 완료된다 (afterRelease → merges.finishMerged). 다른
   * 보류(긴급 정지·일시정지 등)가 남으면 그 해제(대표 재개·팀원 재개 등) 때 완료된다
   */
  private withdrawCancelOfMerged(cur: Task, actor: Actor): void {
    const settledHold = (r: HoldReason) => (r.kind === 'interrupted' && r.refId === CANCEL_HOLD_REF) || r.kind === 'prereq_cancelled';
    if (!cur.merge || cur.state !== 'on_hold' || !cur.hold.reasons.some(settledHold)) return;
    const what = [...new Set(cur.hold.reasons.filter(settledHold).map((r) => (r.kind === 'prereq_cancelled' ? '선행 작업 취소 보류 해제' : '취소 철회')))].join('·');
    const nt = transitionTask(this.ctx, cur.id, { type: 'release', match: settledHold, note: `${what} — 병합이 이미 반영됨` }, actor);
    if (nt.state !== 'on_hold') this.afterRelease(nt, what);
  }

  /**
   * 재시작 복구: main에 병합이 반영됐는데 '선행 작업 취소' 보류가 남은 작업(이전 기록 — 그 보류를 더하던 때의 데이터)을 풀어 완료로 수렴시킨다 (S7-B1).
   * 그 작업의 취소가 돌고 있으면 그 취소가 맡는다
   */
  releaseSettledHoldsOfMerged(taskId: string): void {
    const t = this.ctx.store.tasks.get(taskId);
    if (!t || this.cancelling.has(taskId)) return;
    this.withdrawCancelOfMerged(t, 'system');
  }

  /**
   * 보류 사유 하나와 그것을 푸는 길 (CTL-10) — 항목별 재개(메인 에이전트의 resume_task)로 풀리는 것은 isOwnerResumable과 같다. 취소 거부·재개 거부·지시 취소
   * 알림이 실제로 통하는 길을 가리키게 한다 (S7-B2)
   */
  holdReleaseText(r: HoldReason): string {
    const label = HOLD_REASON_LABEL[r.kind];
    if (isOwnerResumable(r)) return `${label} — 작업 재개로 풀림`;
    switch (r.kind) {
      case 'paused':
        return r.scope === 'project' ? `${label} — 프로젝트 재개로 풀림` : `${label} — 팀원 ${memberName(this.ctx, r.refId) || r.refId || ''} 재개로 풀림`;
      case 'answer_wait':
        return `${label} — 답변이 오면 풀림`;
      case 'replan':
        return `${label} — 프로듀서가 재계획하면 풀림`;
      case 'blocked':
        return `${label} — 프로듀서가 막힘을 해제하면 풀림`;
      case 'prereq_cancelled':
        return `${label} — 프로듀서가 선행 작업을 다시 정하면 풀림`;
      case 'recovery_check':
        return `${label} — 메인 에이전트가 복구 확인(resolve_recovery)을 마치면 풀림`;
      default:
        return label;
    }
  }

  /**
   * main에 병합이 반영됐지만 보류 중인 작업이 무엇으로 완료되는지 (취소 거부 안내·지시 취소 알림 공용, S7-B2). 모든 사유가 대표 재개로 풀리면 '재개하면',
   * 아니면 사유마다 푸는 길을 적는다 — 대표 재개를 받지 않는 보류(팀원·프로젝트 일시정지 등)에 '재개하면 완료'라고 하지 않는다
   */
  mergedHeldNote(t: Task): string {
    const reasons = t.hold.reasons;
    if (reasons.every(isOwnerResumable)) return `지금 보류 중입니다(${reasons.map((r) => HOLD_REASON_LABEL[r.kind]).join(', ')}) — 재개하면 다시 병합하지 않고 완료합니다`;
    return `지금 보류 중입니다(${reasons.map((r) => this.holdReleaseText(r)).join(', ')}) — 보류가 모두 풀리면 다시 병합하지 않고 완료합니다`;
  }

  /** 취소할 수 없는 작업의 안내 — 완료됐거나 main에 병합이 반영된 작업 (재개 안내와 같은 길을 가리킨다: 보류 중이면 그 해제 때 완료) */
  private mergedNotCancellable(t: Task): BackendError {
    if (t.state === 'done') {
      return new BackendError('conflict', `${t.id}은(는) 이미 완료돼 취소할 수 없습니다. 변경을 되돌리려면 request_revert로 되돌리기 작업을 만드세요`);
    }
    const held = t.state === 'on_hold' ? this.mergedHeldNote(t) : '다시 병합하지 않고 완료 처리합니다';
    return new BackendError(
      'conflict',
      `${t.id}은(는) 이미 main에 병합돼 취소할 수 없습니다 — 완료 결과로 남습니다. ${held}. 변경을 되돌리려면 완료 뒤 request_revert로 되돌리기 작업을 만드세요`,
    );
  }

  /** 중간 결과 보관 (GIT-10: 병합 전 폐기·취소는 보관 뒤 정리). 실패하면 던진다 — 보관 전에는 아무것도 지우지 않는다 */
  async archiveWorkspace(task: Task, why: 'cancel' | 'revert'): Promise<void> {
    const ctx = this.ctx;
    const ws = task.workspace;
    if (!ws) return;
    const project = projectOrThrow(ctx, task.projectId);
    try {
      const st = await ctx.deps.git.status(ws.worktreePath);
      if (!st.clean && !st.mergeInProgress) {
        await ctx.deps.git.commitAll(ws.worktreePath, `[${task.id}] ${why === 'cancel' ? '취소' : '되돌리기'} 전 중간 결과 보관`, memberIdentity(null));
      } else if (st.mergeInProgress) await ctx.deps.git.abortMerge(ws.worktreePath);
    } catch (e) {
      ctx.log('warn', `중간 결과 커밋 실패 ${task.id}`, e);
    }
    await recordedExec(
      ctx,
      { kind: 'git_archive', projectId: project.id, taskId: task.id, cwd: project.path, command: `update-ref refs/wook/archive/${task.id}`, target: ws.branch },
      async () => ({ value: await ctx.deps.git.archiveBranch(project.path, ws.branch, `${task.id}-${why}`) }),
    );
  }

  /**
   * 작업 폴더·브랜치·검수 사본 정리 (취소·병합 완료·산출물 확정 공용). 멱등이고 던지지 않는다 —
   * 실패하면 알리고 다음 시작 때 recovery가 다시 부른다. 결과물은 이미 보관·반영된 뒤에만 부른다
   */
  async cleanupWorkspace(task: Task): Promise<boolean> {
    const ctx = this.ctx;
    const project = ctx.store.projects.get(task.projectId);
    if (!project) return true;
    const problems: string[] = [];
    const ws = task.workspace;
    if (ws) {
      const git = ctx.deps.git;
      await recordedExec(
        ctx,
        { kind: 'git_worktree_remove', projectId: project.id, taskId: task.id, cwd: project.path, command: `git worktree remove ${ws.worktreePath}`, target: ws.worktreePath },
        async () => {
          try {
            await git.removeWorktree(project.path, ws.worktreePath);
          } catch (e) {
            // 일부만 지워진 작업 폴더는 git 등록이 풀려 removeWorktree가 계속 거부한다 → 앱 소유 경로만 직접 지운다
            if (resolve(ws.worktreePath) !== resolve(taskWorktreePath(ctx.paths, project.id, task.id))) throw e;
            removeTree(ws.worktreePath);
            await git.removeWorktree(project.path, ws.worktreePath); // 등록 정리(prune) + 남지 않았는지 확인
          }
          return { value: true };
        },
      ).catch((e: unknown) => problems.push(`작업 폴더: ${e instanceof Error ? e.message : String(e)}`));
      // 따로 시도: 작업 폴더 등록이 풀리면 성공하고, 여러 번 해도 같다
      await recordedExec(
        ctx,
        { kind: 'git_branch_delete', projectId: project.id, taskId: task.id, cwd: project.path, command: `git branch -D ${ws.branch}`, target: ws.branch },
        async () => {
          await git.deleteBranch(project.path, ws.branch);
          return { value: true };
        },
      ).catch((e: unknown) => problems.push(`브랜치: ${e instanceof Error ? e.message : String(e)}`));
    }
    if (!(await this.removeReviewCopies(task))) problems.push('검수 사본 일부');
    if (problems.length) {
      ctx.log('warn', `작업 공간 정리 실패 ${task.id}: ${problems.join(' / ')}`);
      ctx.notify({
        level: 'normal',
        title: '작업 폴더 정리 실패',
        body: `${task.id}: 폴더를 쓰는 프로그램(터미널·편집기 등)을 닫으면 다음 시작 때 다시 정리합니다 — ${problems.join(' / ').slice(0, 300)}`,
        link: { tab: 'projects', projectId: task.projectId, taskId: task.id },
        key: `ws-cleanup:${task.id}`,
      });
      return false;
    }
    return true;
  }

  /** 검수 사본 정리. 하나가 잠겨 있어도 나머지는 지운다 (모두 지웠으면 true) */
  async removeReviewCopies(task: Task): Promise<boolean> {
    const ctx = this.ctx;
    const project = ctx.store.projects.get(task.projectId);
    if (!project) return true;
    const prefix = `${task.id}-r`;
    const dir = join(ctx.paths.review, project.id);
    let names: string[] = [];
    try {
      names = readdirSync(dir).filter((n) => n.startsWith(prefix));
    } catch {
      return true;
    }
    let ok = true;
    for (const n of names) {
      const p = join(dir, n);
      try {
        await ctx.deps.git.removeWorktree(project.path, p);
      } catch {
        // 분리 작업 폴더가 아니면(산출물 사본) 폴더만 지움
      }
      try {
        removeTree(p);
      } catch (e) {
        ok = false;
        ctx.log('warn', `검수 사본 정리 실패 ${p}`, e);
      }
    }
    return ok;
  }

  // ───────────────────────── 활성화 (5.7) ─────────────────────────

  /** 스케줄러가 자리를 확보한 뒤 호출: 작업 공간을 만들고 대기 → 진행 */
  async activateForLaunch(taskId: string): Promise<boolean> {
    const ctx = this.ctx;
    const task = taskOrThrow(ctx, taskId);
    if (task.state !== 'waiting') return task.state === 'in_progress';
    // 되돌리기 작업은 담당에게 작업 카드를 주지 않는다 — 작업 폴더·되돌리기 커밋은 프로그램이 만든다 (CLI-09, AC-12)
    if (this.core.merges.revertPending(task)) {
      void this.core.merges.resumeRevert(taskId);
      return false;
    }
    // 취소·종료된 지시의 작업은 시작하지 않는다 — 지시 취소가 그 작업을 취소하는 중이다 (TSK-09, AC-46)
    if (closedDirectiveWork(ctx, null, task)) return false;
    try {
      await this.ensureWorkspace(task);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.hold(taskId, 'error', 'task', `작업 공간 생성 실패: ${msg}`, 'system', null, 'waiting');
      // 이 보류는 메인 에이전트에게 알림 업무로 간다(alert ws-fail:<작업>) — 보류한 뒤 넘기고 대표 알림은 넘긴 사실을 쓴다 (리드 결정 40·S5-7·S5-9)
      const handed = alertTaskHold(ctx, 'ws-fail', taskId, { cause: '작업 공간(작업 폴더)을 만들지 못해 보류됨' });
      ctx.notify({
        level: 'urgent',
        title: '작업 공간 생성 실패',
        body: `${taskId}: ${msg} — 작업을 보류${handed ? `하고 ${OWNER_HANDED}` : `했습니다. ${ownerExit(false)}`}`,
        link: { tab: 'projects', projectId: task.projectId, taskId },
        key: `ws-fail:${taskId}`,
      });
      return false;
    }
    // 작업 폴더를 만드는 사이 정지·보류·취소됐으면 시작하지 않는다 (재개되면 다시 활성화 후보)
    if (taskOrThrow(ctx, taskId).state !== 'waiting') return false;
    const t = transitionTask(ctx, taskId, { type: 'activate' }, 'system');
    const steps = ctx.store.steps.list(taskId);
    const card = [
      `작업 ${t.id} "${t.title}"을(를) 맡았습니다 (${TASK_TYPE_LABEL[t.type]}, 우선순위 ${t.priority}).`,
      `목표: ${t.goal}`,
      `완료 조건:\n${t.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}`,
      t.plannedAreas.length ? `수정 예정 영역: ${t.plannedAreas.join(', ')}` : '',
      t.outputMode === 'artifact'
        ? `산출물형 작업입니다. 결과 파일은 ${artifactWorkDir(ctx.paths, t.projectId, t.id)} 에 저장하세요 (저장소 파일을 바꾸면 변경형으로 전환됩니다).`
        : `작업 폴더: ${t.workspace?.worktreePath} (브랜치 ${t.workspace?.branch})`,
      // 충돌 해결을 넘겨받은 작업 (헛돌기 뒤 프로듀서·다른 팀원 재배정, GIT-07): 그 작업 폴더에 충돌이 남아 있다 (CLI-03)
      t.conflict ? `이 작업 폴더에는 최신 main 반영 중 생긴 병합 충돌이 남아 있습니다 — 먼저 해결하세요 (GIT-07).\n${conflictFixGuide(t.conflict.files, t.conflict.unverifiable, revertOfFor(t))}` : '',
      steps.length ? '' : '먼저 set_steps로 단계 목록을 만드세요.',
    ]
      .filter(Boolean)
      .join('\n');
    enqueue(ctx, {
      kind: t.conflict ? 'conflict_fix' : 'task_work',
      memberId: t.assigneeId,
      sessionKey: taskKey(t.id),
      projectId: t.projectId,
      taskId: t.id,
      directiveId: t.directiveId,
      priority: t.priority,
      message: card,
      dedupeKind: true,
    });
    // 계획 → 진행 (지시)
    this.core.directives.startIfPlanned(t.directiveId);
    return true;
  }

  async ensureWorkspace(task: Task): Promise<void> {
    const ctx = this.ctx;
    const project = projectOrThrow(ctx, task.projectId);
    const path = task.workspace?.worktreePath ?? taskWorktreePath(ctx.paths, project.id, task.id);
    const branch = task.workspace?.branch ?? taskBranchName(task.id, task.title);
    await recordedExec(
      ctx,
      { kind: 'git_worktree_add', projectId: project.id, taskId: task.id, cwd: project.path, command: `git worktree add -b ${branch} ${path} ${project.baseBranch}`, target: branch },
      async () => {
        const r = await ctx.deps.git.addWorktree(project.path, { path, branch, base: project.baseBranch });
        return { value: r, result: { headSha: r.headSha, created: r.created } };
      },
    );
    if (task.outputMode === 'artifact') mkdirSync(artifactWorkDir(ctx.paths, project.id, task.id), { recursive: true });
    if (!task.workspace) {
      ctx.store.tasks.patch(task.id, { workspace: { branch, worktreePath: path, baseBranch: project.baseBranch, createdAt: ctx.now() } });
    }
  }

  /**
   * 지시 취소가 취소할 작업: 그 지시의 미완료 작업 (TSK-09). 지시가 취소된 뒤 만든 되돌리기 작업은 빼고(취소된 지시의 완료 변경을 없애는 별도
   * 되돌리기, AC-46), main에 병합이 이미 반영된 작업도 뺀다(완료 결과 — 취소할 수 없고 재개·복구 때 완료된다)
   */
  directiveCancelTargets(directiveId: string): Task[] {
    const ctx = this.ctx;
    const d = ctx.store.directives.get(directiveId);
    return directiveTasks(ctx, directiveId).filter((t) => !isTerminal(t.state) && !t.merge && !(d && revertOutlivesDirective(ctx, d, t)));
  }

  /**
   * 지시의 미완료 작업을 남지 않을 때까지 취소한다 (TSK-09, AC-46). 지시를 먼저 취소 상태로 저장한 뒤 부른다 — 그 뒤로는 작업이 새로
   * 생기지 않지만, 이미 받아 처리 중이던 요청이 만든 작업·선행 작업 취소로 보류된 후속 작업이 처음 목록 뒤에 남을 수 있어 목록을 다시 읽는다.
   * 한 작업이 실패해도 나머지는 취소하고, 실패한 작업은 이번 호출에서 다시 시도하지 않는다 (재시작·다시 취소하면 이어서 한다)
   */
  async cancelDirectiveTasks(directiveId: string, actor: Actor): Promise<number> {
    const ctx = this.ctx;
    let n = 0;
    const failed = new Set<string>();
    for (let round = 0; round < 20; round++) {
      const left = this.directiveCancelTargets(directiveId).filter((t) => !failed.has(t.id));
      if (!left.length) break;
      for (const t of left) {
        try {
          await this.cancel(t.id, `지시 ${directiveId} 취소`, actor);
          if (ctx.store.tasks.get(t.id)?.state === 'cancelled') n++;
          else failed.add(t.id);
        } catch (e) {
          failed.add(t.id);
          const msg = e instanceof Error ? e.message : String(e);
          if (ctx.store.tasks.get(t.id)?.merge) {
            // 취소를 기다리는 사이 main에 병합이 반영됐다 — 실패가 아니라 완료 결과다 (취소 보류만 풀려 완료되거나, 다른 보류가 풀리면 완료)
            ctx.activity({ kind: 'task', projectId: t.projectId, directiveId, taskId: t.id, text: `${t.id} main에 병합이 반영돼 취소하지 않음 — 완료 결과로 남음 (지시 ${directiveId} 취소 중)`, result: msg });
            continue;
          }
          ctx.log('warn', `지시 취소 중 작업 취소 실패 ${t.id}`, e);
          ctx.activity({ kind: 'task', level: 'warn', projectId: t.projectId, directiveId, taskId: t.id, text: `${t.id} 취소하지 못함 (지시 ${directiveId} 취소 중)`, result: msg });
        }
      }
    }
    return n;
  }

  openTasks(memberId: string): Task[] {
    return openTasksOf(this.ctx, memberId);
  }
}
