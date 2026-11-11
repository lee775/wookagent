/**
 * 화면용 데이터 (src/shared/views.ts) 생성: 전체 스냅샷과 상세 조회.
 */
import { existsSync, readFileSync } from 'node:fs';
import type {
  ActivityEntry,
  AgentMessage,
  AiKind,
  Directive,
  Member,
  Project,
  Report,
  Role,
  Task,
} from '@shared/domain';
import { AI_KINDS, MAIN_AGENT_ID, OWNER } from '@shared/domain';
import type {
  ActivityView,
  AiStatusView,
  AppSnapshot,
  CheckRunView,
  CliEventPage,
  DiffView,
  DirectiveDetail,
  DirectiveView,
  MemberDetail,
  MemberStatus,
  MemberView,
  NotificationView,
  OwnerTodo,
  ProjectView,
  ReportDetail,
  ReportListItem,
  RoleView,
  SessionView,
  TaskDetail,
  TaskView,
  TrayStatus,
  TurnView,
} from '@shared/views';
import type { CliEvent } from '@shared/events';
import type { ReportFilter } from '@shared/ipc';
import { HOLD_REASON_LABEL, SESSION_KIND_LABEL } from '@shared/labels';
import { directiveProgress, taskProgress } from '@core/progress';
import { deriveMemberStatus } from '@core/memberStatus';
import { activeModelLimits, MODEL_FAMILY_LABEL } from '@core/usageLimits';
import { isActiveTask } from '@core/taskMachine';
import { isDirectiveOpen } from '@core/directiveMachine';
import { diffSec } from '@core/time';
import { BackendError } from '../backend/types';
import type { Core } from './core';
import { directiveTasks, memberName, roleOf, taskOrThrow } from './lookups';
import { parseKey } from './records';
import { holdReach, type HoldReach } from './overview';
import { recoveryProjectOf } from './alerts';
import { hashTree } from './fsutil';

const RECENT_MS = 7 * 24 * 3600_000;

export class ViewBuilder {
  private version = 0;

  constructor(private readonly core: Core) {}

  private get ctx() {
    return this.core.ctx;
  }

  /** 실행을 기다리는 대기 항목 수 — 대표 메시지 공유 사본은 그 자체로 턴을 띄우지 않으므로 세지 않는다 (CTL-05) */
  private waitingCount(memberId?: string): number {
    return this.ctx.store.queue.list(memberId ? { ref1: memberId, state: 'queued' } : { state: 'queued' }).filter((q) => !q.ownerShared).length;
  }

  // ───────────────────────── 매퍼 ─────────────────────────

  roleView(r: Role): RoleView {
    return {
      id: r.id,
      name: r.name,
      instructions: r.instructions,
      taskTypes: r.taskTypes,
      allowedSkills: r.allowedSkills,
      defaultAi: r.defaultAi,
      canReview: r.canReview,
      builtin: r.builtin,
      // 만든 쪽 — 기록으로만 보인다(잠금 없음). 시작 때 옮김 전의 역할이면 없다 (리드 결정 S5-12)
      ...(r.createdBy ? { createdBy: r.createdBy } : {}),
    };
  }

  /** reach: 보류가 메인에게 가 있는지 보는 판정 — 스냅숏은 하나를 만들어 모든 작업에 쓴다. 없으면 보류가 있을 때만 만든다 (리드 결정 S5-3) */
  taskView(t: Task, reach: HoldReach | null = null): TaskView {
    const steps = this.ctx.store.steps.list(t.id);
    const r = t.hold.reasons.length ? (reach ?? holdReach(this.ctx)) : null;
    return {
      id: t.id,
      projectId: t.projectId,
      directiveId: t.directiveId,
      round: t.round,
      title: t.title,
      goal: t.goal,
      type: t.type,
      priority: t.priority,
      state: t.state,
      assigneeId: t.assigneeId,
      reviewerId: t.reviewerId,
      prerequisiteIds: t.prerequisiteIds,
      acceptanceCriteria: t.acceptanceCriteria,
      plannedAreas: t.plannedAreas,
      outputMode: t.outputMode,
      steps: steps.map((s) => ({ idx: s.idx, title: s.title, done: s.done, doneAt: s.doneAt, commitSha: s.commitSha })),
      progress: taskProgress(steps),
      hold: t.hold.reasons.length
        ? {
            reasons: t.hold.reasons.map((x) => ({ kind: x.kind, label: HOLD_REASON_LABEL[x.kind], note: x.note, since: x.since, scope: x.scope, refId: x.refId, reachesMain: r!.reason(t, x) })),
            returnState: t.hold.returnState,
          }
        : null,
      review: {
        round: t.review.round,
        rejectsInRound: t.review.rejectsInRound,
        rejectsTotal: t.review.rejectsTotal,
        autoCheck: t.review.autoCheck.status,
        autoCheckDetail: t.review.autoCheck.detail,
        passed: !!t.review.passed,
        targetPinnedAt: t.review.target?.pinnedAt ?? null,
      },
      branch: t.workspace?.branch ?? null,
      worktreePath: t.workspace?.worktreePath ?? null,
      conflictFiles: t.conflict?.files ?? [],
      conflictUnverifiable: t.conflict?.unverifiable ?? [],
      changedCriteria: t.changedCriteria ?? [],
      createdAt: t.createdAt,
      activatedAt: t.activatedAt,
      completedAt: t.completedAt,
      merge: t.merge ? { mergeCommitSha: t.merge.mergeCommitSha, mergedAt: t.merge.mergedAt } : null,
      revertOfTaskId: t.revertOfTaskId,
      revertedByTaskId: t.revertedByTaskId,
    };
  }

  directiveView(d: Directive): DirectiveView {
    const ctx = this.ctx;
    const tasks = directiveTasks(ctx, d.id);
    const round = tasks.filter((t) => t.round === d.round);
    const latest = d.rounds.slice().reverse().find((r) => r.reportId)?.reportId ?? null;
    return {
      id: d.id,
      projectId: d.projectId,
      title: d.title,
      text: d.text,
      round: d.round,
      state: d.state,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
      progress: directiveProgress(round, (id) => ctx.store.steps.list(id)),
      taskIds: tasks.map((t) => t.id),
      latestReportId: latest,
      attachments: d.attachments,
    };
  }

  private memberStatus(m: Member): { status: MemberStatus; reasons: string[] } {
    const ctx = this.ctx;
    const project = m.projectId ? ctx.store.projects.get(m.projectId) : null;
    const mock = m.isMain ? ctx.settings().developer.mainAgentMock : !!project?.mock.enabled;
    // 외부 에이전트가 메인 자리를 가졌으면 CLI 가용성(재로그인·사용량 한도·CLI 문제)과 CLI 모델을 보지 않는다 — 스케줄러의 gateAi와 같은 규칙이다. M-MAIN의 AI 칸은
    // 마지막 CLI 그대로라 그것을 보이면 외부 보유자를 그 CLI로 보이게 된다 (리드 결정 S7-4·S7-17 F2)
    const external = m.isMain && !!this.core.seat.externalHolder();
    const openQuestions = m.isMain
      ? ctx.store.questions.list({ state: 'open' }).filter((q) => q.to === 'owner' && q.fromId === m.id).map((q) => q.text.slice(0, 60))
      : [];
    return deriveMemberStatus({
      member: m,
      stop: ctx.stop(),
      runningLabel: this.core.turns.liveOf(m.id)?.label ?? null,
      assignedTasks: this.core.tasks.openTasks(m.id),
      queued: this.waitingCount(m.id),
      ai: mock || external ? null : ctx.ai(m.ai.kind),
      // 모델별 주간 한도: 지금 AI 설정의 모델로 본다 (진행 중 세션이 고정한 모델과 다를 수 있는 보기용 값, 리드 결정 22)
      model: external ? null : this.core.team.modelValue(m.ai),
      memberError: null,
      openQuestions,
      nowMs: ctx.clock.ms(),
    });
  }

  memberView(m: Member): MemberView {
    const ctx = this.ctx;
    const role = m.isMain ? null : roleOf(ctx, m.roleId);
    const project = m.projectId ? ctx.store.projects.get(m.projectId) : null;
    const mock = m.isMain ? ctx.settings().developer.mainAgentMock : !!project?.mock.enabled;
    const st = this.memberStatus(m);
    const active = this.core.tasks.openTasks(m.id).find((t) => isActiveTask(t)) ?? null;
    let currentTask: MemberView['currentTask'] = null;
    if (active) {
      const steps = ctx.store.steps.list(active.id);
      currentTask = {
        id: active.id,
        title: active.title,
        state: active.state,
        progress: taskProgress(steps),
        currentStep: steps.find((s) => !s.done)?.title ?? null,
        inReview: active.state === 'in_review',
        branch: active.workspace?.branch ?? null,
      };
    }
    const live = this.core.turns.liveOf(m.id);
    const session = ctx.store.sessions.list({ ref1: m.id, state: 'open' }).pop() ?? null;
    const last = this.core.turns.lastLineOf(m.id);
    return {
      id: m.id,
      projectId: m.projectId,
      name: m.name,
      roleId: m.roleId,
      roleName: m.isMain ? '메인 에이전트' : (role?.name ?? m.roleId),
      isProducer: m.isProducer,
      isMain: m.isMain,
      canReview: m.isProducer || !!role?.canReview,
      ai: {
        ...m.ai,
        effortValue: this.core.team.effortValue(m.ai),
        modelValue: this.core.team.modelValue(m.ai),
        mock,
        mockScenario: m.mockScenario ?? (mock ? (project?.mock.defaultScenario ?? null) : null),
      },
      pendingAiChange: m.pendingAi,
      aiDecision: m.aiDecision ? { byName: memberName(ctx, m.aiDecision.by), byOwner: m.aiDecision.by === OWNER, reason: m.aiDecision.reason, at: m.aiDecision.at } : null,
      status: st.status,
      statusReasons: st.reasons,
      currentTask,
      currentWork: live ? { kind: live.kind, label: live.label, turnId: live.turnId, startedAt: live.startedAt } : null,
      queuedCount: this.waitingCount(m.id),
      runSeconds: m.runSeconds,
      currentSessionId: session?.id ?? null,
      lastActivityAt: last?.at ?? null,
      lastLine: last?.text ?? null,
      deleted: !!m.deletedAt,
    };
  }

  projectView(p: Project): ProjectView {
    const ctx = this.ctx;
    const stop = ctx.stop();
    const members = ctx.store.members.list({ project_id: p.id, state: 'active' });
    const counts: Record<MemberStatus, number> = { working: 0, idle: 0, awaiting_answer: 0, paused: 0, error: 0 };
    for (const m of members) counts[this.memberStatus(m).status] += 1;
    const active = ctx.store.directives.list({ project_id: p.id }).filter((d) => isDirectiveOpen(d) && d.state !== 'awaiting_confirmation');
    const tasks = active.flatMap((d) => directiveTasks(ctx, d.id, d.round));
    const latest = ctx.store.reports.list({ project_id: p.id }, { desc: true, limit: 1 })[0] ?? null;
    return {
      id: p.id,
      name: p.name,
      path: p.path,
      baseBranch: p.baseBranch,
      createdAt: p.createdAt,
      paused: !!stop.projects[p.id]?.paused,
      pauseMode: stop.projects[p.id]?.mode ?? null,
      mock: p.mock,
      producerId: p.producerId,
      checkCommands: p.checkCommands,
      networkPolicy: p.networkPolicy,
      deploy: p.deploy,
      activeDirectiveCount: active.length,
      progress: directiveProgress(tasks, (id) => ctx.store.steps.list(id)),
      memberStatusCounts: counts,
      latestReport: latest ? { id: latest.id, title: latest.title, createdAt: latest.createdAt, status: latest.status } : null,
    };
  }

  activityView(e: ActivityEntry): ActivityView {
    return {
      seq: e.seq,
      ts: e.ts,
      actor: e.actor,
      actorName: memberName(this.ctx, e.actor),
      projectId: e.projectId,
      taskId: e.taskId,
      memberId: e.memberId,
      kind: e.kind,
      level: e.level,
      text: e.text,
      result: e.result,
      requestId: e.requestId,
      sessionId: e.sessionId,
      turnId: e.turnId,
    };
  }

  aiStatus(): AiStatusView[] {
    const ctx = this.ctx;
    const now = ctx.clock.ms();
    return AI_KINDS.map((k: AiKind) => {
      const a = ctx.ai(k);
      const limited = !!a.usageLimitedUntil && Date.parse(a.usageLimitedUntil) > now;
      // 모델별 주간 한도는 그 계열의 턴만 막으므로 blocked에 넣지 않고 따로 보인다 (리드 결정 22)
      const modelLimits = activeModelLimits(a, now).map((x) => ({ ...x, label: MODEL_FAMILY_LABEL[x.family] }));
      return {
        kind: k,
        installed: a.cliInstalled,
        version: a.cliVersion,
        problem: a.cliProblem,
        usageLimitedUntil: limited ? a.usageLimitedUntil : null,
        ...(modelLimits.length ? { modelLimits } : {}),
        authRequired: a.authRequired,
        blocked: a.authRequired || limited || !a.cliInstalled || !!a.cliProblem,
      };
    });
  }

  ownerTodos(reach: HoldReach = holdReach(this.ctx)): OwnerTodo[] {
    const ctx = this.ctx;
    const todos: OwnerTodo[] = [];
    // 대표 검수 대기(owner_review)는 없다 — 적격 팀원이 없으면 메인 에이전트가 검수한다 (REV-06 v0.6, HOME-02)
    for (const q of ctx.store.questions.list({ state: 'open' })) {
      if (q.to !== 'owner') continue;
      todos.push({ kind: 'question', id: `question:${q.id}`, questionId: q.id, fromId: q.fromId, fromName: memberName(ctx, q.fromId), text: q.text, projectId: q.projectId, since: q.createdAt });
    }
    for (const r of ctx.store.reports.list({ state: 'new' })) {
      todos.push({ kind: 'unread_report', id: `report:${r.id}`, reportId: r.id, title: r.title, projectId: r.projectId, since: r.createdAt });
    }
    // reachesMain: 그 보류가 메인 에이전트에게 업무로 가 있는지 — 한 판정(overview.ts holdReach)으로 본다: 검수자 없음 보류는 그 작업의 가장 최근 검수자 없음
    // 업무가, 정지 해제 목록은 가장 최근 정지 해제 업무가 버려지지 않았을 때만 참이다 (리드 결정 41·43·S5-3). 상한에서 버린 보류 넘김은 대표 알림이 그 일의 업무다
    for (const t of ctx.store.tasks.list({ state: 'on_hold' })) {
      for (const r of t.hold.reasons) {
        if (r.kind === 'error') {
          todos.push({ kind: 'error', id: `error:${t.id}`, memberId: t.assigneeId, taskId: t.id, projectId: t.projectId, message: `${t.id} ${t.title}: ${r.note}`, since: r.since, reachesMain: reach.reason(t, r) });
        }
        if (r.kind === 'merge_blocked') todos.push({ kind: 'error', id: `merge:${t.id}`, memberId: null, taskId: t.id, projectId: t.projectId, message: `${t.id} 병합 보류: ${r.note}`, since: r.since, reachesMain: reach.reason(t, r) });
      }
    }
    for (const item of this.core.recovery.items()) {
      todos.push({ kind: 'recovery_check', id: `recovery:${item.requestId}`, requestId: item.requestId, taskId: item.taskId, projectId: item.projectId, message: `${item.kind}: ${item.finding}`, since: item.startedAt, reachesMain: reach.recovery(item.requestId, recoveryProjectOf(ctx, item)) });
    }
    for (const k of AI_KINDS) {
      const a = ctx.ai(k);
      if (a.authRequired) todos.push({ kind: 'auth_required', id: `auth:${k}`, aiKind: k, since: a.authRequiredSince ?? ctx.now() });
    }
    if (!ctx.stop().global.active) {
      const n = this.core.stops.heldByEmergency();
      if (n) todos.push({ kind: 'emergency_held', id: 'emergency-held', count: n, since: ctx.stop().global.releasedAt ?? ctx.now(), reachesMain: reach.stopReleased() });
    }
    return todos.sort((a, b) => (a.since < b.since ? 1 : -1));
  }

  // ───────────────────────── 스냅샷 ─────────────────────────

  snapshot(): AppSnapshot {
    const ctx = this.ctx;
    const stop = ctx.stop();
    const nowMs = ctx.clock.ms();
    const projects = ctx.store.projects.list({ state: 'active' });
    const members = ctx.store.members.list({ state: 'active' });
    const memberViews = members.map((m) => this.memberView(m));
    const directives = ctx.store.directives
      .list()
      .filter((d) => isDirectiveOpen(d) || nowMs - Date.parse(d.updatedAt) < RECENT_MS);
    const dIds = new Set(directives.map((d) => d.id));
    const tasks = ctx.store.tasks.list().filter((t) => dIds.has(t.directiveId) || !['done', 'cancelled'].includes(t.state));
    const caps = ctx.settings().execution.maxConcurrent;
    const running = this.core.turns.running();
    // 보류가 메인에게 가 있는지 보는 판정은 스냅숏마다 하나 — 대표 할 일과 작업마다 대기열을 다시 읽지 않는다 (리드 결정 S5-3)
    const reach = holdReach(ctx);
    const ownerTodos = this.ownerTodos(reach);
    const unread = ctx.store.notifications.list({ state: 'unread' });
    const ai = this.aiStatus();
    // 삭제된 팀원은 일시정지로 보이지 않는다 — 지우는 트랜잭션이 정지 기록을 지우지만 그 전의 DB에는 남아 있을 수 있다 (리드 결정 S5-64)
    const pausedMembers = Object.entries(stop.members).filter(([memberId, s]) => s.paused && !ctx.store.members.get(memberId)?.deletedAt);
    const tray: TrayStatus = stop.global.active
      ? 'emergency'
      : memberViews.some((m) => m.status === 'error') || unread.some((n) => n.level === 'urgent')
        ? 'error'
        : Object.values(stop.projects).some((s) => s.paused) || pausedMembers.length
          ? 'paused'
          : memberViews.some((m) => m.status === 'awaiting_answer') || ownerTodos.some((t) => t.kind === 'question')
            ? 'awaiting'
            : 'normal';
    this.version += 1;
    return {
      version: this.version,
      generatedAt: ctx.now(),
      auth: this.core.auth.state(),
      stop: {
        global: { active: stop.global.active, since: stop.global.since },
        // 누가 걸었는지와 프로그램이 건 정지의 까닭(예: 프로세스 종료를 확인하지 못함)도 보낸다 — 대표가 왜 멈췄는지 알 수 있게
        pausedProjects: Object.entries(stop.projects)
          .filter(([, s]) => s.paused)
          .map(([projectId, s]) => ({ projectId, since: s.since, mode: s.mode, by: s.by, ...(s.reason ? { reason: s.reason } : {}) })),
        pausedMembers: pausedMembers.map(([memberId, s]) => ({ memberId, since: s.since, mode: s.mode, by: s.by, ...(s.reason ? { reason: s.reason } : {}) })),
        lastEmergency: this.core.stops.lastEmergency(),
        heldByEmergency: this.core.stops.heldByEmergency(),
      },
      projects: projects.map((p) => this.projectView(p)),
      members: memberViews,
      directives: directives.map((d) => this.directiveView(d)),
      tasks: tasks.map((t) => this.taskView(t, reach)),
      ownerTodos,
      notifications: { unread: unread.length, urgentUnread: unread.filter((n) => n.level === 'urgent').length },
      recentActivity: ctx.store.activity.search({ limit: 30 }).map((e) => this.activityView(e)),
      ai,
      running: {
        total: running.length,
        general: running.filter((r) => r.slotClass === 'general').length,
        management: running.filter((r) => r.slotClass === 'management').length,
        cap: caps,
        generalCap: caps >= 2 ? caps - 1 : caps,
        queued: this.waitingCount(),
      },
      trayStatus: tray,
      roles: ctx.store.roles.list().map((r) => this.roleView(r)),
      // 지금 메인 자리 (리드 결정 S4-10) — 자리가 바뀔 때마다 SeatService가 변경을 알려 상단 보유자 표시가 바로 바뀐다. 로그인 전에는 LOCKED_SEAT (S4-11)
      seat: this.core.seat.view(),
    };
  }

  // ───────────────────────── 상세 ─────────────────────────

  /** 팀원 상세 메시지의 보낸 쪽 — 메인 에이전트의 지시는 '메인 지시'로 보인다 (긴급 지시는 따로 표시, AC-17 v0.6). 옛 대표 직접 메시지는 '대표' */
  messageFrom(m: AgentMessage): string {
    if (m.fromActor === MAIN_AGENT_ID) return m.kind === 'urgent' ? '메인 에이전트 긴급 지시' : '메인 에이전트 지시';
    return memberName(this.ctx, m.fromActor);
  }

  memberDetail(id: string): MemberDetail {
    const ctx = this.ctx;
    const m = ctx.store.members.get(id);
    if (!m) throw new BackendError('not_found', `팀원 ${id}을(를) 찾을 수 없습니다`);
    // 역할 행이 없는 팀원: 메인 에이전트(역할 'main'은 행이 없다)와, 팀원을 지운 뒤 역할까지 지운 지운 팀원이다 — 그 팀원을 메인 에이전트 역할로 보이지 않게
    // 있는 그대로 '지운 역할'로 보인다 (리드 결정 S5-13)
    const role = roleOf(ctx, m.roleId) ?? {
      id: m.roleId,
      name: m.isMain ? '메인 에이전트' : `지운 역할 (${m.roleId})`,
      instructions: '',
      taskTypes: [],
      allowedSkills: [],
      defaultAi: m.ai,
      canReview: false,
      builtin: m.isMain,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
    };
    const sessions = ctx.store.sessions.list({ ref1: id });
    const live = this.core.turns.liveOf(id);
    const sessionViews: SessionView[] = sessions
      .slice(-30)
      .reverse()
      .map((s) => {
        const { kind, ref } = parseKey(s.workKey);
        return {
          id: s.id,
          kind,
          workKey: s.workKey,
          label: `${ref === 'general' ? '직접 명령' : ref} ${SESSION_KIND_LABEL[kind]}`,
          cliSessionId: s.cliSessionId,
          aiKind: s.aiKind,
          mock: s.mock,
          createdAt: s.createdAt,
          closedAt: s.closedAt,
          previousSessionId: s.previousSessionId,
          replaceReason: s.replaceReason,
          turnCount: s.turnCount,
          current: !s.closedAt,
        };
      });
    const turns = ctx.store.turns.list({ ref1: id }, { desc: true, limit: 20 });
    const turnViews: TurnView[] = turns.map((t) => ({
      id: t.id,
      sessionId: t.sessionId,
      startedAt: t.startedAt,
      endedAt: t.endedAt,
      endReason: t.endReason,
      endDetail: t.endDetail,
      bypass: t.bypass,
      mcp: t.mcp,
      eventCount: t.eventCount,
      usage: t.usage,
      running: !t.endedAt || live?.turnId === t.id,
      // 외부 보유자의 턴만 적는다 — 없으면 서버가 띄우는 CLI (계약 TurnView.runner, 리드 결정 S7-2)
      ...(t.runner === 'external' ? { runner: 'external' as const } : {}),
    }));
    const open = this.core.tasks.openTasks(id);
    const current = open.find((t) => isActiveTask(t)) ?? null;
    const history = ctx.store.tasks
      .list({ ref2: id, state: ['done', 'cancelled'] })
      .slice(-30)
      .reverse()
      .map((t) => ({
        taskId: t.id,
        title: t.title,
        state: t.state,
        completedAt: t.completedAt ?? t.cancelledAt,
        durationSec: t.activatedAt ? diffSec(t.activatedAt, t.completedAt ?? t.cancelledAt ?? t.updatedAt) : 0,
        rejects: t.review.rejectsTotal,
      }));
    const messages = ctx.store.messages
      .list({ ref1: id })
      .slice(-30)
      .reverse()
      .map((x) => ({ id: x.id, from: this.messageFrom(x), text: x.text, createdAt: x.createdAt, delivered: !!x.deliveredAt, undelivered: x.deliveredAt ? null : (x.undeliveredReason ?? null) }));
    return {
      member: this.memberView(m),
      role: this.roleView(role),
      sessions: sessionViews,
      recentTurns: turnViews,
      currentTask: current ? this.taskView(current) : null,
      queuedTasks: open.filter((t) => t.state === 'waiting').map((t) => this.taskView(t)),
      history,
      messages,
    };
  }

  /** CLI 이벤트 페이지 (MBR-03). cursor = 다음에 읽을 seq */
  memberEvents(id: string, opts: { turnId?: string; cursor?: string | null; limit?: number }): CliEventPage {
    const ctx = this.ctx;
    const turn = opts.turnId ? ctx.store.turns.get(opts.turnId) : ctx.store.turns.list({ ref1: id }, { desc: true, limit: 1 })[0];
    if (!turn || turn.memberId !== id) return { events: [], nextCursor: null, turnId: null };
    if (!existsSync(turn.eventsFile)) return { events: [], nextCursor: null, turnId: turn.id };
    const from = Number(opts.cursor ?? 0) || 0;
    const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
    const lines = readFileSync(turn.eventsFile, 'utf8').split('\n').filter(Boolean);
    const events: CliEvent[] = [];
    for (const line of lines) {
      try {
        const ev = JSON.parse(line) as CliEvent;
        if (ev.seq > from) events.push(ev);
      } catch {
        // 쓰는 중인 마지막 줄은 다음 조회에서 읽는다
      }
      if (events.length >= limit) break;
    }
    const last = events[events.length - 1];
    const more = events.length >= limit;
    return { events, nextCursor: last && (more || !turn.endedAt) ? String(last.seq) : more ? String(last!.seq) : null, turnId: turn.id };
  }

  async taskDiff(id: string): Promise<DiffView> {
    const ctx = this.ctx;
    const git = ctx.deps.git;
    const t = taskOrThrow(ctx, id);
    const project = ctx.store.projects.require(t.projectId);
    const MAX = 200_000;
    try {
      if (t.merge) {
        const stat = await git.diffStat(project.path, t.merge.preMainSha, t.merge.mergeCommitSha);
        const p = await git.diffPatch(project.path, t.merge.preMainSha, t.merge.mergeCommitSha, MAX);
        return { taskId: id, base: t.merge.preMainSha, head: t.merge.mergeCommitSha, files: stat, patch: ctx.redact.text(p.patch), truncated: p.truncated };
      }
      if (t.review.target?.kind === 'repo' && t.state === 'in_review') {
        const { baseMainSha, taskCommitSha } = t.review.target;
        const stat = await git.diffStat(project.path, baseMainSha, taskCommitSha);
        const p = await git.diffPatch(project.path, baseMainSha, taskCommitSha, MAX);
        return { taskId: id, base: baseMainSha, head: taskCommitSha, files: stat, patch: ctx.redact.text(p.patch), truncated: p.truncated };
      }
      if (t.workspace && existsSync(t.workspace.worktreePath)) {
        const base = await git.revParse(project.path, `refs/heads/${project.baseBranch}`);
        if (base) {
          const w = await git.workingDiff(t.workspace.worktreePath, base, MAX);
          return { taskId: id, base, head: null, files: w.files, patch: ctx.redact.text(w.patch), truncated: w.truncated };
        }
      }
    } catch (e) {
      return { taskId: id, base: null, head: null, files: [], patch: `diff를 만들지 못했습니다: ${e instanceof Error ? e.message : String(e)}`, truncated: false };
    }
    return { taskId: id, base: null, head: null, files: [], patch: '', truncated: false };
  }

  async taskDetail(id: string): Promise<TaskDetail> {
    const ctx = this.ctx;
    const t = taskOrThrow(ctx, id);
    return {
      task: this.taskView(t),
      reviews: ctx.store.reviews.list({ ref1: id }).map((r) => ({
        id: r.id,
        reviewRound: r.reviewRound,
        reviewerId: r.reviewerId,
        reviewerName: memberName(ctx, r.reviewerId),
        verdict: r.verdict,
        criteria: r.criteria,
        reason: r.reason,
        createdAt: r.createdAt,
      })),
      transitions: ctx.store.transitions.list(id).map((x) => ({ from: x.from, event: x.event, to: x.to, reason: x.reason, actor: memberName(ctx, x.actor), at: x.at })),
      diff: await this.taskDiff(id),
      ...this.reviewNotes(t),
      artifact: t.artifact ? { version: t.artifact.version, dir: t.artifact.dir, files: t.artifact.files.map((f) => f.path), finalizedAt: t.artifact.finalizedAt } : null,
      checkRuns: this.checkRuns(id),
    };
  }

  /** 작업의 자동 검사 실행 기록 (TaskDetail.checkRuns) — exec 기록의 결과 값에서 화면에 필요한 것만, 오래된 것부터 */
  private checkRuns(taskId: string): CheckRunView[] {
    const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
    const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
    return this.ctx.store.execs
      .list({ ref1: taskId, ref2: 'auto_check' })
      .slice()
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
      .map((e) => {
        const r = e.result;
        return {
          requestId: e.requestId,
          command: e.command,
          state: e.state,
          startedAt: e.startedAt,
          endedAt: e.endedAt,
          exitCode: num(r.exitCode),
          timedOut: r.timedOut === true,
          remaining: num(r.remaining),
          ownerConfirmedAt: str(r.ownerConfirmedAt),
          leftFiles: Array.isArray(r.leftFiles) ? r.leftFiles.filter((f): f is string => typeof f === 'string') : [],
        };
      });
  }

  /** 검수할 때 따로 볼 것 (TaskDetail.reviewNotes — 팀원 검수 요청에 적는 것과 같다, GIT-07·AC-47). 없으면 빈 객체 */
  private reviewNotes(t: Task): Pick<TaskDetail, 'reviewNotes'> {
    if (t.state !== 'in_review') return {};
    const unchecked = this.core.tasks.uncheckedConflictFiles(t.id);
    const dir = this.core.tasks.deliverablesCopyOf(t);
    const files = dir ? hashTree(dir).map((f) => f.path) : [];
    if (!unchecked.length && !files.length) return {};
    return { reviewNotes: { uncheckedConflictFiles: unchecked, deliverables: dir && files.length ? { dir, files } : null } };
  }

  directiveDetail(id: string): DirectiveDetail {
    const ctx = this.ctx;
    const d = ctx.store.directives.get(id);
    if (!d) throw new BackendError('not_found', `지시 ${id}을(를) 찾을 수 없습니다`);
    const reach = holdReach(ctx);
    return {
      directive: this.directiveView(d),
      tasks: directiveTasks(ctx, id).map((t) => this.taskView(t, reach)),
      rounds: d.rounds.map((r) => ({ round: r.round, requestedAt: r.requestedAt, text: r.text, anchored: r.anchored, reportId: r.reportId })),
      reports: ctx.store.reports.list({ ref1: id }).map((r) => this.reportItem(r)),
    };
  }

  reportItem(r: Report): ReportListItem {
    const ctx = this.ctx;
    return {
      id: r.id,
      projectId: r.projectId,
      projectName: r.projectId ? (ctx.store.projects.get(r.projectId)?.name ?? r.projectId) : '일반',
      directiveId: r.directiveId,
      round: r.round,
      title: r.title,
      status: r.status,
      createdAt: r.createdAt,
    };
  }

  reportList(f: ReportFilter): ReportListItem[] {
    const ctx = this.ctx;
    let list = ctx.store.reports.list(undefined, { desc: true });
    if (f.projectId === 'general') list = list.filter((r) => !r.projectId);
    else if (f.projectId) list = list.filter((r) => r.projectId === f.projectId);
    if (f.status) list = list.filter((r) => r.status === f.status);
    if (f.from) list = list.filter((r) => r.createdAt >= f.from!);
    if (f.to) list = list.filter((r) => r.createdAt <= f.to!);
    if (f.text?.trim()) {
      const q = f.text.trim().toLowerCase();
      list = list.filter((r) => {
        if (r.title.toLowerCase().includes(q) || (r.directiveId ?? '').toLowerCase().includes(q)) return true;
        try {
          return readFileSync(r.filePath, 'utf8').toLowerCase().includes(q);
        } catch {
          return false;
        }
      });
    }
    return list.map((r) => this.reportItem(r));
  }

  reportDetail(id: string): ReportDetail {
    const ctx = this.ctx;
    const { report, markdown } = this.core.reports.read(id);
    const others = report.directiveId ? ctx.store.reports.list({ ref1: report.directiveId }).filter((r) => r.id !== id) : [];
    return {
      ...this.reportItem(report),
      markdown,
      sections: report.sections,
      stats: report.stats,
      comments: ctx.store.reportComments.list({ ref1: id }).map((c) => ({ id: c.id, kind: c.kind, quote: c.quote, text: c.text, createdAt: c.createdAt })),
      otherRounds: others.map((r) => ({ id: r.id, round: r.round })),
      filePath: report.filePath,
      // reports.approve와 같은 판정 — 수정 요청한 보고서도 메인 에이전트가 새 회차를 열기 전이면 그대로 승인할 수 있다 (리드 결정 10)
      canApprove: this.core.reports.approveRefusal(report) === null,
      // reports.requestChanges와 같은 판정 — 지시가 이미 끝났거나 취소된 보고서에는 수정 요청을 받지 않는다 (리드 결정 25)
      canRequestChanges: this.core.reports.requestChangesRefusal(report) === null,
    };
  }

  notifications(limit: number): NotificationView[] {
    return this.ctx.store.notifications
      .list(undefined, { desc: true, limit: Math.min(Math.max(limit, 1), 500) })
      .map((n) => ({ id: n.id, level: n.level, title: n.title, body: n.body, link: n.link, key: n.key, createdAt: n.createdAt, read: !!n.readAt }));
  }
}
