/**
 * 상태 전이 적용 + 전이 기록 (TSK-03: 현재 상태·이벤트·다음 상태·사유·주체 기록)
 * 그리고 세션 키·대기열 공용 도우미.
 */
import type {
  Actor,
  AgentMessage,
  Directive,
  DirectiveId,
  MemberId,
  Priority,
  ProjectId,
  QuestionId,
  QueueEntry,
  SessionKind,
  SlotClass,
  Task,
  TaskId,
  WorkKind,
} from '@shared/domain';
import { DIRECTIVE_STATE_LABEL, TASK_STATE_LABEL } from '@shared/labels';
import { applyTaskEvent, type TaskEvent } from '@core/taskMachine';
import { applyDirectiveEvent, type DirectiveEvent } from '@core/directiveMachine';
import type { Ctx } from './context';
import { alertMain, OWNER_HANDED, urgentUndeliveredText } from './alerts';

export function transitionTask(ctx: Ctx, taskId: TaskId, ev: TaskEvent, actor: Actor, requestId: string | null = null): Task {
  return ctx.store.tx(() => {
    const cur = ctx.store.tasks.require(taskId);
    const at = ctx.now();
    const r = applyTaskEvent(cur, ev, at, actor);
    ctx.store.tasks.put(r.task);
    ctx.store.transitions.append({
      entity: 'task',
      entityId: taskId,
      from: r.from,
      event: r.event,
      to: r.to,
      reason: r.note,
      actor,
      at,
      requestId,
    });
    if (r.from !== r.to || ev.type === 'hold' || ev.type === 'review_pass' || ev.type === 'repin') {
      ctx.activity({
        kind: 'task',
        actor,
        projectId: r.task.projectId,
        directiveId: r.task.directiveId,
        taskId,
        memberId: r.task.assigneeId,
        requestId,
        text: `${taskId} ${TASK_STATE_LABEL[r.from]} → ${TASK_STATE_LABEL[r.to]} · ${r.note}`,
      });
    }
    return r.task;
  });
}

export function transitionDirective(ctx: Ctx, directiveId: DirectiveId, ev: DirectiveEvent, actor: Actor, requestId: string | null = null): Directive {
  return ctx.store.tx(() => {
    const cur = ctx.store.directives.require(directiveId);
    const at = ctx.now();
    const r = applyDirectiveEvent(cur, ev, at, actor);
    ctx.store.directives.put(r.directive);
    ctx.store.transitions.append({
      entity: 'directive',
      entityId: directiveId,
      from: r.from,
      event: r.event,
      to: r.to,
      reason: r.note,
      actor,
      at,
      requestId,
    });
    ctx.activity({
      kind: 'directive',
      actor,
      projectId: r.directive.projectId,
      directiveId,
      requestId,
      text: `${directiveId} ${DIRECTIVE_STATE_LABEL[r.from]} → ${DIRECTIVE_STATE_LABEL[r.to]} · ${r.note}`,
    });
    return r.directive;
  });
}

// ───────────────────────── 세션 키 ─────────────────────────
export const taskKey = (taskId: TaskId) => `task:${taskId}`;
export const reviewKey = (taskId: TaskId) => `review:${taskId}`;
export const directiveKey = (directiveId: DirectiveId) => `directive:${directiveId}`;
export const mainKey = (projectId: ProjectId | null) => `main:${projectId ?? 'general'}`;

export function parseKey(key: string): { kind: SessionKind; ref: string } {
  const [prefix, ref = ''] = key.split(':', 2) as [string, string?];
  switch (prefix) {
    case 'task':
      return { kind: 'task', ref };
    case 'review':
      return { kind: 'review', ref };
    case 'directive':
      return { kind: 'directive', ref };
    case 'main':
      return { kind: ref === 'general' ? 'main_general' : 'main_project', ref };
    default:
      throw new Error(`알 수 없는 세션 키: ${key}`);
  }
}

export function slotClassOf(key: string): SlotClass {
  return key.startsWith('task:') ? 'general' : 'management';
}

/**
 * 업무 세션 키가 어느 프로젝트의 일인지 (SERVER_DESIGN 5.4, 리드 결정 S5-5) — main:P → P, task:T·review:T → T의 프로젝트, directive:D → D의 프로젝트,
 * main:general → null. 메인 에이전트는 프로젝트 소속이 없어 팀원 프로젝트(projectId)가 늘 null이므로, 메인의 턴·세션·활동 기록은 이것으로 프로젝트를 찾는다.
 * 없는 작업·지시면 null
 */
export function workProjectOf(ctx: Ctx, key: string): ProjectId | null {
  const { kind, ref } = parseKey(key);
  if (kind === 'main_project') return ref || null;
  if (kind === 'task' || kind === 'review') return ctx.store.tasks.get(ref)?.projectId ?? null;
  if (kind === 'directive') return ctx.store.directives.get(ref)?.projectId ?? null;
  return null;
}

// ───────────────────────── 대기열 ─────────────────────────
export interface EnqueueInput {
  kind: WorkKind;
  memberId: MemberId;
  sessionKey: string;
  message: string;
  projectId?: ProjectId | null;
  taskId?: TaskId | null;
  directiveId?: DirectiveId | null;
  questionId?: QuestionId | null;
  priority?: Priority;
  urgent?: boolean;
  /** 긴급 지시의 프로듀서 공유 사본 — 그 자체로 턴을 띄우지 않고 그 세션의 다음 턴에 함께 간다 (QueueEntry.ownerShared) */
  ownerShared?: boolean;
  /** 이 항목이 전하는 메시지 기록 (QueueEntry.messageId) — 턴을 띄우면 전달됨으로, 전달 전에 빠지면 전달 못 함으로 적는다 */
  messageId?: string | null;
  /** 검수 업무가 묶인 고정 버전 (QueueEntry.reviewPinnedAt) — 같은 버전의 항목에만 합친다 */
  reviewPinnedAt?: string | null;
  /** 수정 요청 업무의 보고서 (QueueEntry.reportId) — 끝난 수정 요청을 가르는 데 쓴다 (리드 결정 19) */
  reportId?: string | null;
  /** 프로그램이 일시정지한 팀원 (QueueEntry.pausedMemberId) — 메인 에이전트에게 그 팀원의 재개를 맡긴 업무 (리드 결정 26) */
  pausedMemberId?: string | null;
  /** 메인 에이전트에게 넘긴 보류·실패의 키 (QueueEntry.alertKey, 'alert:<종류>:<대상>') — 같은 일은 alerts.alertMain이 한 번만 넣는다 (리드 결정 S5-7) */
  alertKey?: string | null;
  attachments?: string[];
  requestId?: string | null;
  attempts?: number;
  /** 재촉·남는 업무의 다시 전달 횟수 (QueueEntry.deliveries, 리드 결정 30) — 0이면 적지 않는다 */
  deliveries?: number;
  /** 재시작으로 끊겨 다시 넣은 횟수 (QueueEntry.restarts, 리드 결정 39) — 0이면 적지 않는다 */
  restarts?: number;
  /** 같은 세션에 같은 종류·같은 작업의 대기 항목이 있으면 새로 만들지 않음 (그 항목에 글을 덧붙인다) */
  dedupeKind?: boolean;
}

export function enqueue(ctx: Ctx, e: EnqueueInput): QueueEntry {
  // 대기열 내용은 저장 전에 가린다 (SEC-10, AC-20): 대표 입력·팀원 메시지가 원문으로 대기열·백업에 남지 않게. 멱등이라 이미 가린 값은 그대로
  const message = ctx.redact.text(e.message);
  return ctx.store.tx(() => {
    if (e.requestId) {
      const dup = ctx.store.queue.list({ ref2: e.sessionKey }).find((q) => q.requestId === e.requestId);
      if (dup) return dup;
    }
    if (e.dedupeKind) {
      // 공유 사본(턴을 띄우지 않는 항목)에는 합치지 않는다 — 합치면 그 일까지 턴을 띄우지 못한다.
      // 긴급 지시(urgent)에도 합치지 않는다 — 합친 내용이 '긴급 지시 우선 전달'로 보이고, 긴급 지시 기록의 전달 여부가 섞인다.
      // 다른 버전에 묶인 검수 항목에도 합치지 않는다 — 이전 버전의 사본 위치·완료 조건이 새 버전 검수 요청에 섞인다 (REV-07·08).
      // 다른 작업의 항목에도 합치지 않는다 — 합친 항목은 첫 작업의 taskId만 가져, 그 작업을 취소하면(taskId로 지움) 다른 작업의 업무(검수자 없음·검수자
      // 재배정·병합 판단 등)까지 사라진다 (리드 결정 11·13). 한 세션의 대기 항목은 한 턴에 함께 실리므로 따로 두어도 턴은 늘지 않는다.
      // 일시정지된 팀원의 재개를 맡긴 업무도 다른 업무(AI 결정 요청 등)와 합치지 않는다 — 그 팀원이 재개되면 끝나는 업무다 (리드 결정 26)
      const dup = ctx.store.queue
        .list({ ref2: e.sessionKey, state: 'queued' })
        .find(
          (q) =>
            q.kind === e.kind &&
            (q.taskId ?? null) === (e.taskId ?? null) &&
            !!q.ownerShared === !!e.ownerShared &&
            !!q.urgent === !!e.urgent &&
            (q.reviewPinnedAt ?? null) === (e.reviewPinnedAt ?? null) &&
            (q.pausedMemberId ?? null) === (e.pausedMemberId ?? null),
        );
      if (dup) {
        if (message && !dup.message.includes(message)) {
          return ctx.store.queue.patch(dup.id, { message: `${dup.message}\n\n${message}` });
        }
        return dup;
      }
    }
    const now = ctx.now();
    const entry: QueueEntry = {
      id: ctx.store.nextId('queue'),
      kind: e.kind,
      memberId: e.memberId,
      projectId: e.projectId ?? null,
      taskId: e.taskId ?? null,
      directiveId: e.directiveId ?? null,
      questionId: e.questionId ?? null,
      sessionKey: e.sessionKey,
      slotClass: slotClassOf(e.sessionKey),
      priority: e.priority ?? 'normal',
      queuedAt: now,
      state: 'queued',
      message,
      attachments: e.attachments ?? [],
      urgent: e.urgent ?? false,
      ...(e.ownerShared ? { ownerShared: true } : {}),
      ...(e.messageId ? { messageId: e.messageId } : {}),
      ...(e.reviewPinnedAt ? { reviewPinnedAt: e.reviewPinnedAt } : {}),
      ...(e.reportId ? { reportId: e.reportId } : {}),
      ...(e.pausedMemberId ? { pausedMemberId: e.pausedMemberId } : {}),
      ...(e.alertKey ? { alertKey: e.alertKey } : {}),
      turnId: null,
      requestId: e.requestId ?? null,
      attempts: e.attempts ?? 0,
      ...(e.deliveries ? { deliveries: e.deliveries } : {}),
      ...(e.restarts ? { restarts: e.restarts } : {}),
      createdAt: now,
      doneAt: null,
    };
    ctx.store.queue.insert(entry);
    ctx.bus.changed();
    ctx.bus.signal('tick');
    return entry;
  });
}

/**
 * 대기 항목을 지운다. why: 그 업무가 끝나거나 바뀐 까닭 — 지운 항목이 전하던 메시지(긴급 지시·팀원 메시지)를 아직 전달하지
 * 못했으면 그 사유를 메시지 기록에 남기고, 긴급 지시면 대표에게 알린다 (메시지는 조용히 사라지지 않는다, AC-36·CLI-10)
 */
export function cancelQueued(ctx: Ctx, pred: (q: QueueEntry) => boolean, why = '받을 업무가 끝나거나 바뀜'): number {
  return ctx.store.tx(() => {
    const gone: QueueEntry[] = [];
    for (const q of ctx.store.queue.list({ state: 'queued' })) {
      if (!pred(q)) continue;
      ctx.store.queue.put({ ...q, state: 'cancelled', doneAt: ctx.now() });
      gone.push(q);
    }
    if (gone.length) {
      ctx.bus.changed();
      noteMessagesUndelivered(ctx, gone, why);
    }
    return gone.length;
  });
}

/**
 * 가장 최근에 만든 항목 — 상태와 상관없이 대기열 번호(W-…)가 가장 큰 것. 번호는 만들 때 차례로 매기므로 만든 순서다(다시 저장해도 그대로). 없으면 null.
 * 같은 대상의 마지막 업무가 어떻게 끝났는지 볼 때 쓴다 (재시작 상한의 버림 — turns.restartDropped, 보류 넘김이 메인에게 있는지 — 화면의 reachesMain, 리드 결정 43·44)
 */
export function newestEntry(entries: readonly QueueEntry[]): QueueEntry | null {
  const no = (id: string): number => Number(id.slice(id.indexOf('-') + 1));
  return entries.reduce<QueueEntry | null>((a, b) => (!a || no(b.id) > no(a.id) ? b : a), null);
}

/**
 * 긴급 지시 항목인지 — 받는 팀원의 업무 세션에 우선 전달하는 항목 (CLI-10 v0.6: 메인 에이전트의 instruct_member urgent, 옛 대표 직접 메시지 포함).
 * 프로듀서 공유 사본(ownerShared)은 아니다. 턴이 끝난 뒤 그 세션 맨 앞, 검수·병합 전 전달, 통과 뒤 다시 판정이 이 판정에 걸려 있다 (ARCHITECTURE 5장)
 */
export function isUrgentDirect(q: QueueEntry): boolean {
  return q.kind === 'message' && q.urgent && !q.ownerShared;
}

/** 긴급 지시 기록인지 — 메인 에이전트의 긴급 지시와 v0.6 전의 대표 직접 메시지(이력 — 아직 전달 전이면 같은 보장으로 전달된다) */
export function isUrgentMessage(m: AgentMessage): boolean {
  return m.kind === 'urgent' || m.kind === 'owner_direct';
}

/**
 * 전달하지 못한 채 대기열에서 빠진 항목의 메시지를 기록한다 (AC-36-obs: 메시지 기록이 전달 여부를 사실대로). 메시지를 전하던 항목
 * (`messageId` — 긴급 지시·send_message·instruct_member)마다 그 기록에 `undeliveredAt`·`undeliveredReason`을 남기고, 긴급 지시면
 * 활동 기록과 대표 일반 알림도 (12장 — 긴급 지시는 대표 명령을 전하는 길이다). 이미 한 번 CLI에 넘긴 메시지(deliveredAt — 비정상 종료 뒤 다시 넣은 항목 등), 이미 기록한
 * 메시지, 같은 메시지를 전하는 다른 항목이 아직 대기·실행 중인 메시지는 건너뛴다. 여러 번 불러도 같다
 */
export function noteMessagesUndelivered(ctx: Ctx, entries: readonly QueueEntry[], why: string): void {
  const seen = new Set<string>();
  for (const q of entries) {
    const urgent = isUrgentDirect(q);
    if (!urgent && !q.messageId) continue;
    const key = q.messageId ?? q.id;
    if (seen.has(key)) continue;
    seen.add(key);
    const m = q.messageId ? ctx.store.messages.get(q.messageId) : null;
    if (m && (m.deliveredAt || m.undeliveredAt)) continue;
    if (q.messageId && ctx.store.queue.list({ state: ['queued', 'running'] }).some((x) => x.messageId === q.messageId && x.id !== q.id)) continue;
    if (m) ctx.store.messages.put({ ...m, undeliveredAt: ctx.now(), undeliveredReason: why });
    // 팀원 메시지는 기록만 — 지운 쪽(완료 정리·지시 취소 등)이 정리한 업무를 활동 기록에 남긴다. 대표에게는 긴급 지시만 알린다
    if (!urgent) continue;
    const name = ctx.store.members.get(q.memberId)?.name ?? q.memberId;
    const from = m?.kind === 'owner_direct' ? '대표' : '메인 에이전트';
    const text = (m?.text ?? q.message).replace(/\s+/g, ' ').trim();
    ctx.activity({
      kind: 'message',
      level: 'warn',
      projectId: q.projectId,
      memberId: q.memberId,
      taskId: q.taskId,
      directiveId: q.directiveId,
      text: `${from} → ${name} 긴급 지시를 전달하지 못함 (${why}): ${text.slice(0, 200)}`,
    });
    // 보낸 쪽(메인 에이전트)은 실패를 듣지 못한다 — 메인에게도 한 번 넘긴다 (alert:urgent-undelivered:<메시지>, 리드 결정 S5-8). 넘겼으면 대표 알림은 넘겼다고 쓴다
    const handed = alertMain(ctx, {
      kind: 'urgent-undelivered',
      target: key,
      projectId: q.projectId,
      taskId: q.taskId,
      directiveId: q.directiveId,
      message: urgentUndeliveredText(from, name, q.memberId, key, why, text),
      since: m?.createdAt ?? q.createdAt,
    });
    const quoted = text.length > 120 ? `${text.slice(0, 119)}…` : text;
    ctx.notify({
      level: 'normal',
      title: '긴급 지시 전달 못 함',
      body: `${from}가 ${name}에게 보낸 긴급 지시("${quoted}")를 전달하지 못했습니다 — ${why}. ${handed ? OWNER_HANDED : '필요하면 명령창으로 메인 에이전트에게 다시 말해 주세요'}`,
      link: q.projectId ? { tab: 'projects', projectId: q.projectId, memberId: q.memberId } : null,
      key: `urgent-undelivered:${key}`,
    });
  }
}

/** 이 항목들을 실은 턴의 CLI를 띄웠다 — 전하는 메시지 기록을 전달됨으로 적는다 (AC-36: '전달됨/전달 대기'가 사실과 맞게) */
export function markMessagesDelivered(ctx: Ctx, entries: readonly QueueEntry[]): void {
  const ids = [...new Set(entries.map((e) => e.messageId).filter((id): id is string => !!id))];
  if (!ids.length) return;
  ctx.store.tx(() => {
    const at = ctx.now();
    for (const id of ids) {
      const m = ctx.store.messages.get(id);
      if (m && !m.deliveredAt) ctx.store.messages.put({ ...m, deliveredAt: at, undeliveredAt: null, undeliveredReason: null });
    }
  });
  ctx.bus.changed();
}
