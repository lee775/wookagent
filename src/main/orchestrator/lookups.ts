/** 자주 쓰는 조회 */
import type { Directive, Member, MemberId, Project, ProjectId, Role, Task } from '@shared/domain';
import { MAIN_AGENT_ID } from '@shared/domain';
import { isActiveTask, isTerminal } from '@core/taskMachine';
import { isDirectiveOpen } from '@core/directiveMachine';
import { BackendError } from '../backend/types';
import type { Ctx } from './context';
import { directiveKey, taskKey } from './records';

export function roleOf(ctx: Ctx, roleId: string): Role | null {
  return ctx.store.roles.get(roleId);
}

export function memberOrThrow(ctx: Ctx, id: MemberId): Member {
  const m = ctx.store.members.get(id);
  if (!m) throw new BackendError('not_found', `팀원 ${id}을(를) 찾을 수 없습니다`);
  return m;
}

/**
 * 메인 도구(일시정지·재개·설정·AI·삭제·중단·지시·메시지·검수자 지정)가 겨누는 팀원 — 삭제된 팀원이면 conflict로 거부한다 (리드 결정 S5-74):
 * '삭제된 팀원 <이름>(<ID>)입니다', 교체된 프로듀서면 그 프로젝트의 지금 프로듀서도 적는다. 없는 ID는 memberOrThrow의 not_found. 조회(get_member_activity)는 삭제된
 * 팀원도 본다 (리드 결정 S5-6)
 */
export function liveMemberOrThrow(ctx: Ctx, id: MemberId): Member {
  const m = memberOrThrow(ctx, id);
  if (!m.deletedAt) return m;
  const project = m.replacedById && m.projectId ? ctx.store.projects.get(m.projectId) : null;
  const now = project ? ctx.store.members.get(project.producerId) : null;
  const heir = now && !now.deletedAt && now.id !== m.id ? `${now.name}(${now.id})` : null;
  throw new BackendError('conflict', `삭제된 팀원 ${m.name}(${m.id})입니다${heir ? ` — 지금 프로듀서는 ${heir}입니다` : ''}`);
}

export function projectOrThrow(ctx: Ctx, id: ProjectId): Project {
  const p = ctx.store.projects.get(id);
  if (!p) throw new BackendError('not_found', `프로젝트 ${id}을(를) 찾을 수 없습니다`);
  return p;
}

export function taskOrThrow(ctx: Ctx, id: string): Task {
  const t = ctx.store.tasks.get(id);
  if (!t) throw new BackendError('not_found', `작업 ${id}을(를) 찾을 수 없습니다`);
  return t;
}

export function directiveOrThrow(ctx: Ctx, id: string): Directive {
  const d = ctx.store.directives.get(id);
  if (!d) throw new BackendError('not_found', `지시 ${id}을(를) 찾을 수 없습니다`);
  return d;
}

export function producerOf(ctx: Ctx, projectId: ProjectId): Member {
  const p = projectOrThrow(ctx, projectId);
  const m = ctx.store.members.get(p.producerId);
  if (!m || m.deletedAt) throw new BackendError('not_found', `프로젝트 ${projectId}의 프로듀서가 없습니다`);
  return m;
}

/**
 * 지금 이 업무를 맡을 팀원: 삭제된 팀원이면 교체한 후임(프로듀서 교체, ORG-04)을 따라간다. 후임 없이 삭제됐으면 null.
 * 낡은 대기 항목(교체 전 프로듀서 몫)이 세션 키 전체를 막지 않게 쓴다 (CONC-04)
 */
export function memberOrSuccessor(ctx: Ctx, id: MemberId): Member | null {
  let m = ctx.store.members.get(id);
  for (let i = 0; m?.deletedAt && m.replacedById && i < 20; i++) m = ctx.store.members.get(m.replacedById);
  return m && !m.deletedAt ? m : null;
}

export function mainAgent(ctx: Ctx): Member {
  const m = ctx.store.members.get(MAIN_AGENT_ID);
  if (!m) throw new BackendError('not_found', '메인 에이전트가 없습니다');
  return m;
}

export function projectMembers(ctx: Ctx, projectId: ProjectId): Member[] {
  return ctx.store.members.list({ project_id: projectId, state: 'active' });
}

/** 담당 미완료 작업 */
export function openTasksOf(ctx: Ctx, memberId: MemberId): Task[] {
  return ctx.store.tasks.list({ ref2: memberId, state: ['waiting', 'in_progress', 'on_hold', 'in_review'] });
}

/** 활성 일반 작업 (5.7) */
export function activeTaskOf(ctx: Ctx, memberId: MemberId): Task | null {
  return openTasksOf(ctx, memberId).find((t) => isActiveTask(t)) ?? null;
}

/**
 * 팀원에게 보내는 지시·메시지가 가는 업무 세션 (CLI-10: 받는 쪽 다음 턴에 전달) — 활성 작업이 있으면 그 작업 세션, 없으면 프로듀서는 열린 지시의 지시 세션.
 * 보낼 곳이 없으면 null. 메인 에이전트의 instruct_member·send_message(tools)와 멈춘 검수 넘김의 안내(turns.handReviewToMain)가 이 한 판정을 쓴다 (리드 결정 45)
 */
export function messageSessionOf(ctx: Ctx, m: Member): { key: string; kind: 'message'; taskId: string | null; directiveId: string | null } | null {
  if (m.isMain) return null;
  const active = activeTaskOf(ctx, m.id);
  if (active && active.state !== 'done' && active.state !== 'cancelled') return { key: taskKey(active.id), kind: 'message', taskId: active.id, directiveId: active.directiveId };
  if (m.isProducer && m.projectId) {
    const open = ctx.store.directives.list({ project_id: m.projectId }).filter((d) => d.state === 'planning' || d.state === 'in_progress' || d.state === 'reporting').pop();
    if (open) return { key: directiveKey(open.id), kind: 'message', taskId: null, directiveId: open.id };
  }
  return null;
}

/**
 * 그 팀원에게 지금 지시하면 받는 세션(messageSessionOf)이 바로 뜨지 못하는 작업 세션인지 — 그렇다면 그 작업을 돌려준다. 스케줄러는 작업 세션을 작업이 진행
 * 중일 때만 띄우므로(검수 중·보류·대기면 띄우지 않음) 그 지시는 작업이 다시 진행될 때까지 처리되지 않는다. 아니면(지시 세션·진행 중 작업·보낼 곳 없음) null
 */
export function deferredMessageTask(ctx: Ctx, m: Member): Task | null {
  const dest = messageSessionOf(ctx, m);
  const t = dest?.taskId && dest.key === taskKey(dest.taskId) ? ctx.store.tasks.get(dest.taskId) : null;
  return t && t.state !== 'in_progress' ? t : null;
}

export function directiveTasks(ctx: Ctx, directiveId: string, round?: number): Task[] {
  const all = ctx.store.tasks.list({ ref1: directiveId });
  return round === undefined ? all : all.filter((t) => t.round === round);
}

export function prereqsDone(ctx: Ctx, task: Task): boolean {
  return task.prerequisiteIds.every((id) => ctx.store.tasks.get(id)?.state === 'done');
}

export function isOpenTask(t: Task): boolean {
  return !isTerminal(t.state);
}

/** 프로그램이 만든 되돌리기 작업 (GIT-10, `merges.createRevertTask`). 원래 작업의 지시에 붙는다 */
export function isProgramRevert(t: Task): boolean {
  return t.type === 'revert' && !!t.revertOfTaskId;
}

/**
 * 지시를 취소할 때 남기는 기록 (kv, `directives.cancel`이 취소 전이와 같은 트랜잭션으로 남긴다): 그때 있던 그 지시의 작업과, 그때까지 시작된 턴(그
 * 지시의 턴 — 지시 세션, 그 지시 작업의 작업·검수 세션 — 과 그때 살아 있던 턴). 무엇이 취소 '뒤'에 생겼는지 시계가 아니라 이 목록으로 가린다 —
 * 시계가 뒤로 맞춰져도 같다 (AC-46, TSK-09). 목록 없이 취소된 지시(이전 기록)만 시각으로 견준다
 */
export interface CancelSnapshot {
  tasks: string[];
  turns: string[];
}
export const cancelSnapshotKey = (directiveId: string) => `cancelsnap:${directiveId}`;
export function cancelSnapshotOf(ctx: Ctx, directiveId: string): CancelSnapshot | null {
  return ctx.store.kv.get<CancelSnapshot>(cancelSnapshotKey(directiveId));
}

/**
 * 지시가 닫혀도(취소·종료) 끝까지 가는 되돌리기 작업인지 (TSK-09 '변경을 취소할 필요가 있으면 별도 되돌리기 작업', AC-46). 되돌리기 작업은
 * 원래 작업의 지시에 붙는다 — 종료된 지시의 되돌리기와 지시 취소 뒤에 요청한 되돌리기(취소된 지시의 완료 변경을 없애는 별도 되돌리기 — 취소 때 남긴
 * 작업 목록에 없던 것)가 그렇다. 지시 취소 전에 이미 있던 되돌리기는 그 지시의 미완료 하위 작업이라 지시 취소가 함께 취소한다
 */
export function revertOutlivesDirective(ctx: Ctx, d: Directive, t: Task): boolean {
  if (!isProgramRevert(t)) return false;
  if (d.state !== 'cancelled') return true;
  const snap = cancelSnapshotOf(ctx, d.id);
  if (snap) return !snap.tasks.includes(t.id);
  return !!d.cancelledAt && t.createdAt >= d.cancelledAt;
}

/**
 * 취소·종료된 지시에 딸린 일인지 (TSK-09 '미완료 하위 작업과 예약된 턴을 취소', AC-46). 그 지시의 작업은 더 실행·검수·병합하지 않는다
 * (지시를 닫은 뒤에도 끝까지 가는 되돌리기 작업은 예외 — revertOutlivesDirective). task가 있으면 그 작업의 지시를, 없으면 directiveId를 본다
 */
export function closedDirectiveWork(ctx: Ctx, directiveId: string | null, task: Task | null): boolean {
  const id = task?.directiveId ?? directiveId;
  const d = id ? ctx.store.directives.get(id) : null;
  if (!d || isDirectiveOpen(d)) return false;
  return !(task && revertOutlivesDirective(ctx, d, task));
}

export function memberName(ctx: Ctx, id: string | null | undefined): string {
  if (!id) return '';
  if (id === 'owner') return '대표';
  if (id === 'operator') return '운영자';
  if (id === 'system') return '욱채';
  return ctx.store.members.get(id)?.name ?? id;
}
