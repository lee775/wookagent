/**
 * 지시·명령·보고서·기억 (6장, 11장, 13.5).
 */
import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import type {
  Actor,
  AnchoredComment,
  Attachment,
  ConversationMessage,
  ConversationTarget,
  Directive,
  FinalResult,
  Member,
  QueueEntry,
  Report,
  ReportSections,
  ReportStats,
} from '@shared/domain';
import { MAIN_AGENT_ID, OPERATOR, OWNER } from '@shared/domain';
import type { SendCommandInput } from '@shared/ipc';
import { DIRECTIVE_STATE_LABEL } from '@shared/labels';
import { isTerminal } from '@core/taskMachine';
import { isDirectiveOpen } from '@core/directiveMachine';
import { diffSec } from '@core/time';
import { BackendError } from '../backend/types';
import { REPORT_SUMMARY_MAX_LINES, renderReportMarkdown, reportRelativePath, writeReportFile } from '../reports/reportWriter';
import type { Core } from './core';
import { cancelQueued, directiveKey, enqueue, isUrgentDirect, mainKey, transitionDirective } from './records';
import { cancelSnapshotKey, directiveOrThrow, directiveTasks, memberName, producerOf, projectOrThrow, revertOutlivesDirective, type CancelSnapshot } from './lookups';
import { projectMemoryFile } from './paths';
import { fitFileName, readTextOr, writeFileAtomic } from './fsutil';
import { deadWorkReason, dropDeadWork } from './turns';
import { alertMain, OWNER_HANDED, OWNER_TELL_MAIN, planStuckText } from './alerts';

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.pdf': 'application/pdf',
  '.json': 'application/json',
};

export class DirectiveService {
  constructor(private readonly core: Core) {}

  private get ctx() {
    return this.core.ctx;
  }

  /** 메인 에이전트의 지시 등록 (AGT-05): 접수 → 계획, 프로듀서에게 전달 */
  register(input: { projectId: string; title: string; text: string; attachmentIds?: string[] }, actor: Actor, requestId: string | null): Directive {
    const ctx = this.ctx;
    const project = projectOrThrow(ctx, input.projectId);
    const attachments = (input.attachmentIds ?? []).map((id) => this.core.commands.attachment(id)).filter((a): a is Attachment => !!a);
    const now = ctx.now();
    const d: Directive = {
      id: ctx.store.nextId('directive'),
      projectId: project.id,
      title: input.title.trim(),
      text: input.text.trim(),
      attachments,
      round: 1,
      state: 'received',
      rounds: [{ round: 1, requestedAt: now, text: input.text.trim(), anchored: [], reportId: null }],
      finalResult: null,
      planApprovalRequired: false,
      createdAt: now,
      updatedAt: now,
      closedAt: null,
      cancelledAt: null,
    };
    ctx.store.directives.insert(d);
    ctx.store.transitions.append({ entity: 'directive', entityId: d.id, from: '-', event: 'register', to: 'received', reason: '지시 등록', actor, at: now, requestId });
    const planned = transitionDirective(ctx, d.id, { type: 'plan' }, actor, requestId);
    this.queuePlan(planned, `새 지시 ${d.id} (1회차): ${d.title}\n\n${d.text}`);
    return planned;
  }

  private queuePlan(d: Directive, message: string): void {
    const producer = producerOf(this.ctx, d.projectId!);
    enqueue(this.ctx, {
      kind: 'plan',
      memberId: producer.id,
      sessionKey: directiveKey(d.id),
      projectId: d.projectId,
      directiveId: d.id,
      priority: 'high',
      attachments: d.attachments.map((a) => a.path),
      message: `${message}\n\n팀 구성과 각자의 진행 중 작업을 확인하고 create_task로 작업을 쪼개 배정하세요. 작업 없이 직접 결과를 낼 수 있으면 submit_final_result를 바로 호출해도 됩니다.`,
    });
  }

  startIfPlanned(directiveId: string): void {
    const ctx = this.ctx;
    const d = ctx.store.directives.get(directiveId);
    if (!d || d.state !== 'planning') return;
    if (directiveTasks(ctx, d.id, d.round).length === 0) return;
    transitionDirective(ctx, d.id, { type: 'start' }, 'system');
  }

  /**
   * 프로듀서 계획 턴 종료 후 (CLI-18 판정). deliveries: 그 계획 업무를 재촉으로 다시 전달한 횟수 — 비정상 종료 횟수와 따로 센다 (리드 결정 30). stallSince: 그 턴이
   * 실은 계획 항목(이 지연의 마지막 재촉)을 만든 때 — 상한 알림은 지연 하나마다 한 번이다 (리드 결정 S5-26)
   */
  afterPlanTurn(directiveId: string, deliveries: number, stallSince: string): void {
    const ctx = this.ctx;
    const d = ctx.store.directives.get(directiveId);
    if (!d) return;
    this.startIfPlanned(directiveId);
    const cur = ctx.store.directives.get(directiveId)!;
    if (cur.state !== 'planning') return;
    if (deliveries >= 2) {
      // 재촉 상한 — 프로듀서에게 더 넣지 않으므로 지시는 계획 중으로 남는다. 그 일은 메인 에이전트에게 한 번 넘긴다(alert plan-stuck:<지시> — 지연 하나마다 한 번:
      // since가 그 지연의 마지막 재촉을 만든 때라 같은 회차에 다시 멈춘 계획은 따로 알린다, 리드 결정 45·S5-8·S5-26). 넘기지 못했으면(같은 지연을 이미 넘겼다)
      // 대표가 명령창으로 메인 에이전트에게 알리는 길을 적는다
      const handed = alertMain(ctx, {
        kind: 'plan-stuck',
        target: d.id,
        projectId: d.projectId,
        directiveId: d.id,
        message: planStuckText(ctx, d.id),
        since: stallSince,
      });
      ctx.notify({
        level: 'normal',
        title: '계획 지연',
        body: `${d.id} ${d.title} — 프로듀서가 작업을 만들지 못했습니다. ${handed ? OWNER_HANDED : `어떻게 할지 ${OWNER_TELL_MAIN}`}`,
        link: { tab: 'projects', projectId: d.projectId ?? undefined, directiveId: d.id },
        key: `plan-stuck:${d.id}`,
      });
      return;
    }
    const producer = producerOf(ctx, d.projectId!);
    enqueue(ctx, {
      kind: 'plan',
      memberId: producer.id,
      sessionKey: directiveKey(d.id),
      projectId: d.projectId,
      directiveId: d.id,
      priority: 'high',
      deliveries: deliveries + 1,
      message: `지시 ${d.id}에 아직 작업이 없습니다. create_task로 작업을 만들거나, 직접 처리했다면 submit_final_result를 호출하세요.`,
      dedupeKind: true,
    });
  }

  /** 현재 회차 작업이 모두 끝나면 최종 결과 정리 요청 */
  checkRoundDone(directiveId: string): void {
    const ctx = this.ctx;
    const d = ctx.store.directives.get(directiveId);
    if (!d || (d.state !== 'in_progress' && d.state !== 'planning')) return;
    const tasks = directiveTasks(ctx, d.id, d.round);
    if (!tasks.length || tasks.some((t) => !isTerminal(t.state))) return;
    const producer = producerOf(ctx, d.projectId!);
    const lines = tasks.map((t) => `- ${t.id} ${t.title}: ${t.state === 'done' ? '완료' : '취소'}${t.merge ? ` (병합 ${t.merge.mergeCommitSha.slice(0, 8)})` : ''}`);
    enqueue(ctx, {
      kind: 'final_result',
      memberId: producer.id,
      sessionKey: directiveKey(d.id),
      projectId: d.projectId,
      directiveId: d.id,
      priority: 'high',
      message: `지시 ${d.id} ${d.round}회차의 작업이 모두 끝났습니다.\n${lines.join('\n')}\n결과를 정리해 submit_final_result를 호출하세요.`,
      dedupeKind: true,
    });
  }

  submitFinalResult(
    input: { directiveId: string; summary: string; outputs: string[]; changedFiles: string[]; issues: string[]; nextSteps: string[] },
    producer: Member,
    requestId: string | null,
  ): Directive {
    const ctx = this.ctx;
    const d = directiveOrThrow(ctx, input.directiveId);
    if (!producer.isProducer || producer.projectId !== d.projectId) throw new BackendError('forbidden', '이 지시의 프로듀서가 아닙니다');
    if (d.state === 'reporting' && d.finalResult?.round === d.round) return d;
    if (d.state !== 'in_progress' && d.state !== 'planning') throw new BackendError('conflict', `지시 ${d.id}은(는) 결과를 제출할 수 없는 상태입니다 (${d.state})`);
    const open = directiveTasks(ctx, d.id, d.round).filter((t) => !isTerminal(t.state));
    if (open.length) throw new BackendError('conflict', `아직 끝나지 않은 작업이 있습니다: ${open.map((t) => `${t.id}(${t.state})`).join(', ')}`);
    const result: FinalResult = {
      round: d.round,
      summary: input.summary,
      outputs: input.outputs,
      changedFiles: input.changedFiles,
      issues: input.issues,
      nextSteps: input.nextSteps,
      submittedAt: ctx.now(),
      by: producer.id,
    };
    const nd = transitionDirective(ctx, d.id, { type: 'final_result', result }, producer.id, requestId);
    this.queueMainReport(nd);
    return nd;
  }

  /** 메인 에이전트에게 보고서 작성 요청 (최종 결과 제출 때·재시작 복구 때 공용, RPT-01) */
  queueMainReport(d: Directive): void {
    const ctx = this.ctx;
    const result = d.finalResult;
    if (!result) return;
    const stats = this.core.reports.statsFor(d);
    enqueue(ctx, {
      kind: 'main_report',
      memberId: MAIN_AGENT_ID,
      sessionKey: mainKey(d.projectId),
      projectId: d.projectId,
      directiveId: d.id,
      priority: 'high',
      message: [
        `프로듀서 ${memberName(ctx, result.by)}이(가) 지시 ${d.id} "${d.title}" ${d.round}회차 결과를 제출했습니다. 정리해서 submit_report(directive_id="${d.id}")로 대표에게 보고하세요.`,
        `요약: ${result.summary}`,
        result.outputs.length ? `산출물:\n${result.outputs.map((o) => `- ${o}`).join('\n')}` : '',
        result.changedFiles.length ? `변경 파일:\n${result.changedFiles.map((o) => `- ${o}`).join('\n')}` : '',
        result.issues.length ? `이슈:\n${result.issues.map((o) => `- ${o}`).join('\n')}` : '',
        result.nextSteps.length ? `다음 할 일 제안:\n${result.nextSteps.map((o) => `- ${o}`).join('\n')}` : '',
        `작업 통계: 작업 ${stats.taskCount}개, 반려 ${stats.rejectCount}회`,
      ]
        .filter(Boolean)
        .join('\n'),
    });
  }

  /**
   * 지시 전체 취소 (5.3 '미완료 지시 → 취소: 미완료 하위 작업만 취소, 완료 결과는 유지', TSK-09, AC-46). 순서가 핵심이다:
   * ① 취소 선택을 먼저 저장한다(지시 → 취소, CTL-08) — 이 뒤로 이 지시에는 작업을 만들거나 고칠 수 없고(이미 받아 처리 중이던 프로듀서
   *    요청도 저장된 상태로 거부), 스케줄러·제출 처리·병합은 이 지시의 작업을 더 진행하지 않는다
   * ② 프로듀서의 지시 세션 턴을 끝내고 예약 업무를 지운다 (계획 중이던 턴이 작업을 더 만들지 못하게)
   * ③ 미완료 작업을 남지 않을 때까지 취소한다 (목록을 다시 읽어 처리 중에 생긴 작업·선행 취소로 보류된 후속 작업까지)
   * ④ 처리하는 동안 들어온 예약 업무를 한 번 더 지운다.
   * 이미 취소된 지시에 다시 부르면 남은 작업만 이어서 취소한다 — 재시작 복구가 끊긴 지시 취소를 마치는 데 쓴다 (CTL-08)
   */
  async cancel(directiveId: string, actor: Actor): Promise<void> {
    const ctx = this.ctx;
    const d = directiveOrThrow(ctx, directiveId);
    if (d.state === 'closed') return;
    const resumed = d.state === 'cancelled';
    if (resumed && !this.core.tasks.directiveCancelTargets(d.id).length) return;
    if (!resumed) {
      ctx.store.tx(() => {
        const who = actor === OWNER || actor === MAIN_AGENT_ID || actor === OPERATOR ? memberName(ctx, actor) : actor;
        transitionDirective(ctx, d.id, { type: 'cancel', reason: `${who} 취소 (미완료 작업 취소, 완료 결과 유지)` }, actor);
        // 취소 때 있던 것을 같이 남긴다 (lookups.CancelSnapshot) — 이 지시의 작업(그 목록에 없던 되돌리기 = 취소 뒤에 요청한 별도 되돌리기,
        // revertOutlivesDirective)과 취소 전에 시작된 턴(이 지시의 턴 + 지금 살아 있는 턴 — 그 턴이 처리 중이던 되돌리기 요청이 취소 뒤에 도착하면
        // 받지 않는다, merges.requestRevert). 시계가 아니라 이름으로 가리므로 시계가 뒤로 맞춰져도 같다 (AC-46)
        const turns = ctx.store.turns.list({ project_id: d.projectId }).filter((t) => t.directiveId === d.id).map((t) => t.id);
        const snap: CancelSnapshot = { tasks: directiveTasks(ctx, d.id).map((t) => t.id), turns: [...new Set([...turns, ...this.core.turns.liveTurnIds()])] };
        ctx.store.kv.set(cancelSnapshotKey(d.id), snap);
      });
    }
    // 되돌리기 작업의 대기 업무(병합 판단·재계획)는 지운다 — 지시 취소 뒤에 요청한 별도 되돌리기는 남긴다.
    // 대표 직접 메시지는 그 지시 세션으로 간 것만 지운다 — 작업·검수 세션의 것은 그 작업을 취소할 때(tasks.cancel), 계속 도는 다른 세션(메인
    // 에이전트 대화 등)으로 간 것은 남긴다. 지운 대표 메시지는 대표에게 알린다 (cancelQueued)
    const mine = (q: QueueEntry) => (q.sessionKey === directiveKey(d.id) || (q.directiveId === d.id && !isUrgentDirect(q))) && !this.separateRevertWork(q);
    const why = `지시 ${d.id}이(가) 취소됨`;
    // 메인 에이전트에게 남은 이 지시의 수정 요청·보고서 작성 업무는 끝난 업무로 지운다(dropDeadWork — 까닭을 활동 기록에 남긴다). cancelQueued는 메시지
    // 기록이 없는 항목을 기록 없이 지운다. 지운 대표의 수정 요청은 '지시 취소' 알림에도 적는다 — 그 요청은 메인 에이전트에게 닿지 못했다 (리드 결정 19·36·45)
    const lostRequests: string[] = [];
    const dropMainWork = (): void => {
      for (const q of ctx.store.queue.list({ ref1: MAIN_AGENT_ID, state: 'queued' })) {
        if (q.directiveId !== d.id || (q.kind !== 'change_request' && q.kind !== 'main_report')) continue;
        if (q.kind === 'main_report') {
          dropDeadWork(ctx, q, deadWorkReason(ctx, q) ?? why);
          continue;
        }
        const reportId = q.reportId ?? /보고서 (R-\d+)/.exec(q.message)?.[1] ?? null;
        const label = reportId ? `보고서 ${reportId}` : '보고서';
        lostRequests.push(label);
        dropDeadWork(ctx, q, `지시 ${d.id}이(가) 취소돼 대표의 ${label} 수정 요청을 메인 에이전트에게 전하지 못함`);
      }
    };
    dropMainWork();
    cancelQueued(ctx, mine, why);
    await this.core.turns.stopSessions([directiveKey(d.id)], '지시 취소', true);
    // 프로세스를 띄우기 전에 멈춘 턴은 항목을 대기열로 되돌린다 (정지가 끝나기 전에) → 한 번 더 지운다 (TSK-09: 예약된 턴 취소)
    dropMainWork();
    cancelQueued(ctx, mine, why);
    const n = await this.core.tasks.cancelDirectiveTasks(d.id, actor);
    dropMainWork();
    cancelQueued(ctx, mine, why);
    const left = this.core.tasks.directiveCancelTargets(d.id);
    // main에 병합이 이미 반영됐지만 아직 끝나지 않은 작업(병합 도중 긴급 정지·중단으로 보류 등)은 취소하지 않는 완료 결과다 — 보류가 풀리면(대표 재개 등)
    // 다시 병합하지 않고 완료된다 (5.3 '완료 결과는 유지', AC-46). 기다릴 것이 없는 보류(선행 작업 취소 — 이전 기록)는 여기서 풀고, 남은 보류는 무엇이
    // 푸는지(작업 재개·팀원/프로젝트 재개 등) 사유마다 알린다 — 대표 재개를 받지 않는 보류에 '재개하면 완료'라고 하지 않는다 (S7-B1·B2)
    for (const t of directiveTasks(ctx, d.id)) if (!isTerminal(t.state) && t.merge) this.core.tasks.releaseSettledHoldsOfMerged(t.id);
    const merged = directiveTasks(ctx, d.id).filter((t) => !isTerminal(t.state) && !!t.merge);
    const heldMerged = merged.filter((t) => t.state === 'on_hold');
    const mergedNote = merged.length
      ? `main에 병합이 반영된 ${merged.map((t) => `${t.id}${t.state === 'on_hold' ? '(보류)' : ''}`).join(', ')}은(는) 완료 결과로 남음 — 다시 병합하지 않고 완료${
          heldMerged.length ? `되며, 보류 중인 작업은 그 보류가 풀리면 완료 (${heldMerged.map((t) => `${t.id}: ${t.hold.reasons.map((r) => this.core.tasks.holdReleaseText(r)).join(', ')}`).join('; ')})` : ''
        }`
      : '';
    ctx.activity({
      kind: 'directive',
      level: left.length ? 'warn' : 'info',
      actor,
      projectId: d.projectId,
      directiveId: d.id,
      text: `${d.id} 지시 취소${resumed ? ' 이어서 마침' : ''} — 미완료 작업 ${n}개 취소, 완료 결과 유지${left.length ? ` (취소하지 못한 작업: ${left.map((t) => t.id).join(', ')})` : ''}${mergedNote ? `. ${mergedNote}` : ''}`,
    });
    if (!resumed) {
      ctx.notify({
        level: 'info',
        title: '지시 취소',
        body: `${d.id} ${d.title} — 완료된 결과와 main 반영은 유지됩니다${mergedNote ? `. ${mergedNote}` : ''}${
          lostRequests.length ? `. 대표의 ${lostRequests.join(', ')} 수정 요청은 메인 에이전트에게 전하지 못했습니다` : ''
        }`,
        link: { tab: 'projects', projectId: d.projectId ?? undefined, directiveId: d.id },
      });
    }
  }

  /** 지시 취소 뒤에 요청한 별도 되돌리기 작업의 업무인지 (AC-46 — 지시 취소가 지우지 않는다) */
  private separateRevertWork(q: QueueEntry): boolean {
    const ctx = this.ctx;
    const t = q.taskId ? ctx.store.tasks.get(q.taskId) : null;
    const d = t ? ctx.store.directives.get(t.directiveId) : null;
    return !!t && !!d && revertOutlivesDirective(ctx, d, t);
  }
}

export class CommandService {
  constructor(private readonly core: Core) {}

  private get ctx() {
    return this.core.ctx;
  }

  attachment(id: string): Attachment | null {
    return this.ctx.store.kv.get<Attachment>(`attachment:${id}`);
  }

  private saveAttachment(a: { path?: string; name: string; dataUrl?: string }): Attachment {
    const ctx = this.ctx;
    const id = ctx.store.nextId('attachment');
    // Linux·macOS는 이름을 UTF-8 255바이트까지 받는다 — 120자 안의 한글 이름(붙여 넣은 그림의 이름 등)도 넘으면 확장자를 남기고 더 자른다 (리드 결정 S10t).
    // Windows는 그대로다(바이트 상한 없음)
    // 자르기는 fitFileName 하나로 — 그 앞에서 120자로 먼저 자르면 긴 이름의 확장자가 잘린다 (리드 결정 S10-13)
    const safeName = fitFileName((basename(a.name || 'file') || 'file').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_'), 120);
    const dir = join(ctx.paths.attachments, id);
    mkdirSync(dir, { recursive: true });
    const dest = join(dir, safeName);
    let mime = MIME[extname(safeName).toLowerCase()] ?? 'application/octet-stream';
    if (a.dataUrl) {
      const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(a.dataUrl);
      if (!m) throw new BackendError('invalid', '첨부 데이터 형식이 잘못됐습니다');
      mime = m[1] ?? mime;
      writeFileSync(dest, m[2] ? Buffer.from(m[3]!, 'base64') : Buffer.from(decodeURIComponent(m[3]!), 'utf8'));
    } else if (a.path) {
      copyFileSync(a.path, dest);
    } else throw new BackendError('invalid', '첨부 파일이 비어 있습니다');
    const att: Attachment = { id, name: safeName, path: dest, size: statSync(dest).size, mime };
    ctx.store.kv.set(`attachment:${id}`, att);
    return att;
  }

  /** 대표 명령 (CMD-01..05) */
  send(input: SendCommandInput): { conversationId: string } {
    const ctx = this.ctx;
    const text = input.text.trim();
    if (!text) throw new BackendError('invalid', '명령을 입력하세요');
    const projectId = input.target === 'main' ? null : input.target;
    const project = projectId ? projectOrThrow(ctx, projectId) : null;
    const attachments = (input.attachments ?? []).map((a) => this.saveAttachment(a));
    const msg: ConversationMessage = {
      id: ctx.store.nextId('conversation'),
      target: input.target,
      role: 'owner',
      text: ctx.redact.text(text),
      attachments,
      directiveId: null,
      createdAt: ctx.now(),
    };
    ctx.store.conversation.insert(msg);
    const lines = [
      `대표 명령${project ? ` (프로젝트 ${project.name} ${project.id})` : ' (메인 에이전트 직접)'}:`,
      text,
    ];
    if (attachments.length) lines.push('', '첨부:', ...attachments.map((a) => `- ${a.id} ${a.name} (${a.path})`));
    lines.push(
      '',
      project
        ? `먼저 read_memory(project_id="${project.id}")로 프로젝트 기억을 읽고 판단하세요. 지시로 등록할 일이면 register_directive, 모호하면 ask_owner로 질문하세요. 대표에게 할 답변은 마지막 메시지로 남기세요.`
        : '프로젝트와 무관한 직접 명령입니다. 직접 처리하고, 결과는 마지막 메시지로 남기거나 필요하면 submit_report(지시 없음)로 보고하세요.',
    );
    enqueue(ctx, {
      kind: 'main_command',
      memberId: MAIN_AGENT_ID,
      sessionKey: mainKey(projectId),
      projectId,
      priority: 'high',
      attachments: attachments.map((a) => a.path),
      message: lines.join('\n'),
    });
    ctx.activity({ kind: 'message', actor: OWNER, projectId, text: `대표 명령 → 메인 에이전트: ${text.slice(0, 200)}` });
    // 받은 명령은 메인 일지의 서버 기록이다 (SERVER_DESIGN 6.1, S4b) — 보유자가 바뀌어도 다음 메인이 무엇을 받았는지 안다
    this.core.journal.server('command', `대표 명령 (${project ? `${project.id} ${project.name}` : '직접 명령'}): ${text}${attachments.length ? ` (첨부 ${attachments.length}개)` : ''}`, {
      projectId,
      refs: project ? [{ kind: 'project', id: project.id }] : [],
      workKey: mainKey(projectId),
    });
    return { conversationId: msg.id };
  }

  appendAgentReply(target: ConversationTarget, text: string, directiveId: string | null = null): void {
    const ctx = this.ctx;
    const t = text.trim();
    if (!t) return;
    ctx.store.conversation.insert({
      id: ctx.store.nextId('conversation'),
      target,
      role: 'main_agent',
      text: ctx.redact.text(t).slice(0, 20000),
      attachments: [],
      directiveId,
      createdAt: ctx.now(),
    });
    ctx.bus.changed();
  }

  appendSystem(target: ConversationTarget, text: string): void {
    const ctx = this.ctx;
    // 대표 답변 등 대표가 쓴 글이 들어온다 — 대화 기록도 저장 전에 가린다 (SEC-10, 15장)
    ctx.store.conversation.insert({ id: ctx.store.nextId('conversation'), target, role: 'system', text: ctx.redact.text(text), attachments: [], directiveId: null, createdAt: ctx.now() });
    ctx.bus.changed();
  }

  history(target: ConversationTarget, before: string | undefined, limit: number): ConversationMessage[] {
    const all = this.ctx.store.conversation.list({ ref1: target });
    const idx = before ? all.findIndex((m) => m.id === before) : all.length;
    const end = idx < 0 ? all.length : idx;
    return all.slice(Math.max(0, end - limit), end);
  }
}

export class ReportService {
  constructor(private readonly core: Core) {}

  private get ctx() {
    return this.core.ctx;
  }

  statsFor(d: Directive | null): ReportStats {
    const ctx = this.ctx;
    if (!d) return { taskCount: 0, rejectCount: 0, durationSec: 0, inputTokens: 0, outputTokens: 0, costUsd: null };
    const tasks = directiveTasks(ctx, d.id, d.round).filter((t) => t.state !== 'cancelled' || t.activatedAt);
    const ids = new Set(tasks.map((t) => t.id));
    const roundStart = d.rounds.find((r) => r.round === d.round)?.requestedAt ?? d.createdAt;
    let inputTokens = 0;
    let outputTokens = 0;
    let cost = 0;
    let anyCost = false;
    for (const turn of ctx.store.turns.list({ project_id: d.projectId })) {
      if (turn.startedAt < roundStart) continue;
      if (turn.directiveId !== d.id && !(turn.taskId && ids.has(turn.taskId))) continue;
      inputTokens += turn.usage?.inputTokens ?? 0;
      outputTokens += turn.usage?.outputTokens ?? 0;
      if (turn.usage?.costUsd != null) {
        cost += turn.usage.costUsd;
        anyCost = true;
      }
    }
    return {
      taskCount: tasks.length,
      rejectCount: tasks.reduce((s, t) => s + t.review.rejectsTotal, 0),
      durationSec: diffSec(roundStart, ctx.now()),
      inputTokens,
      outputTokens,
      costUsd: anyCost ? Math.round(cost * 10000) / 10000 : null,
    };
  }

  /** 메인 에이전트 보고서 제출 (RPT-01..04) */
  async submit(
    input: { directiveId?: string | null; title?: string | null; sections: ReportSections },
    actor: Actor,
    requestId: string | null,
  ): Promise<Report> {
    const ctx = this.ctx;
    const d = input.directiveId ? directiveOrThrow(ctx, input.directiveId) : null;
    if (d && d.state !== 'reporting') {
      const existing = d.rounds.find((r) => r.round === d.round)?.reportId;
      if (existing && d.state === 'awaiting_confirmation') return ctx.store.reports.require(existing);
      throw new BackendError('conflict', `지시 ${d.id}은(는) 보고 단계가 아닙니다 (${d.state}). 프로듀서의 최종 결과가 먼저 필요합니다`);
    }
    const project = d?.projectId ? projectOrThrow(ctx, d.projectId) : null;
    const sections = ctx.redact.value(input.sections);
    // 양식(RPT-02 '요약 | 결과를 3줄 이내로')에 맞지 않으면 저장하지 않고 다시 쓰게 한다 — 문서함에는 양식에 맞는 보고서만 (AC-21).
    // 거부는 요청 캐시를 남기지 않으므로 같은 턴에서 고쳐 다시 낼 수 있고, 그대로 턴을 마치면 보고 요청을 다시 받는다
    const summaryLines = sections.summary.replace(/\r\n?/g, '\n').split('\n').filter((l) => l.trim()).length;
    if (summaryLines > REPORT_SUMMARY_MAX_LINES) {
      throw new BackendError('invalid', `요약은 ${REPORT_SUMMARY_MAX_LINES}줄 이내로 써 주세요 (지금 ${summaryLines}줄). 자세한 내용은 결과(results)에 쓰고 다시 submit_report를 호출하세요`);
    }
    const title = (input.title?.trim() || d?.title || sections.summary.split('\n')[0]!.slice(0, 40) || '보고서').slice(0, 120);
    const stats = this.statsFor(d);
    const createdAt = ctx.now();
    const round = d?.round ?? 1;
    const markdown = renderReportMarkdown({ title, projectName: project?.name ?? '일반', directiveId: d?.id ?? null, round, createdAt, sections, stats });
    const rel = reportRelativePath({ projectName: project?.name ?? null, directiveId: d?.id ?? null, title, round, createdAt });
    const filePath = await writeReportFile(ctx.paths.reports, rel, ctx.redact.text(markdown));
    const report: Report = {
      id: ctx.store.nextId('report'),
      projectId: project?.id ?? null,
      directiveId: d?.id ?? null,
      round,
      title,
      filePath,
      status: 'new',
      sections,
      stats,
      createdAt,
      readAt: null,
      decidedAt: null,
    };
    ctx.store.reports.insert(report);
    if (d) transitionDirective(ctx, d.id, { type: 'report_submitted', reportId: report.id }, actor, requestId);
    ctx.activity({ kind: 'report', actor, projectId: report.projectId, directiveId: report.directiveId, requestId, text: `보고서 ${report.id} 제출: ${title}` });
    // 보고 도착 — 메인 일지의 서버 기록 (6.1, S4b). 메인의 submit_report도 이 한 줄이다
    this.core.journal.server('report', `보고서 ${report.id} 도착 (${project ? `${project.id} ${project.name}` : '일반'}${d ? `, 지시 ${d.id} ${round}회차` : ''}): "${title}" — ${sections.summary}`, {
      projectId: report.projectId,
      refs: [{ kind: 'report', id: report.id }, ...(d ? [{ kind: 'directive' as const, id: d.id }] : [])],
    });
    ctx.notify({
      level: 'normal',
      title: '보고서 도착',
      body: `${project?.name ?? '일반'} · ${title}`,
      link: { tab: 'documents', reportId: report.id, projectId: report.projectId },
      key: `report:${report.id}`,
    });
    this.core.commands.appendAgentReply(project?.id ?? 'main', `보고서를 올렸습니다: ${title} (${report.id})\n${sections.summary}`, d?.id ?? null);
    return report;
  }

  read(id: string): { report: Report; markdown: string } {
    const ctx = this.ctx;
    const report = ctx.store.reports.require(id);
    return { report, markdown: readTextOr(report.filePath, '(보고서 파일을 읽지 못했습니다)') };
  }

  markRead(id: string): void {
    const ctx = this.ctx;
    const r = ctx.store.reports.require(id);
    if (r.status === 'new') ctx.store.reports.put({ ...r, status: 'read', readAt: ctx.now() });
    for (const n of ctx.store.notifications.list({ ref1: `report:${id}`, state: 'unread' })) ctx.store.notifications.put({ ...n, readAt: ctx.now() });
    ctx.bus.changed();
  }

  private addComment(reportId: string, kind: 'overall' | 'anchored', text: string, quote: string | null): void {
    const ctx = this.ctx;
    if (!text.trim()) return;
    ctx.store.reportComments.insert({ id: ctx.store.nextId('comment'), reportId, kind, quote, text: ctx.redact.text(text), createdAt: ctx.now() });
  }

  /**
   * 대표가 지금 이 보고서를 결과 승인할 수 없는 까닭 (승인할 수 있으면 null) — approve와 화면의 ReportDetail.canApprove가 같은 판정을 쓴다.
   * 수정 요청한 보고서도 그 지시가 아직 확인 대기이고 메인 에이전트가 새 회차를 열지 않았으면(지금 회차가 그 보고서) 그대로 승인할 수 있다 (리드 결정 10,
   * SERVER_DESIGN 2.2) — 메인이 회차를 열지 않고 되묻거나 새 지시로 처리하면 대표가 결과를 승인할 길이 없어 지시가 확인 대기로 남던 것을 막는다.
   * 이미 승인한 보고서는 승인할 것이 없다 (approve는 아무것도 하지 않는다)
   */
  approveRefusal(r: Report): string | null {
    if (r.status === 'approved') return '이미 결과 승인한 보고서입니다';
    if (r.status !== 'changes_requested') return null;
    const d = r.directiveId ? this.ctx.store.directives.get(r.directiveId) : null;
    if (!d) return '이미 수정 요청한 보고서입니다 — 지시에 묶이지 않은 보고서라 수정 요청을 메인 에이전트가 처리합니다';
    if (d.state !== 'awaiting_confirmation') return `이미 수정 요청한 보고서입니다 — 지시 ${d.id}이(가) ${DIRECTIVE_STATE_LABEL[d.state]} 상태라 승인할 수 없습니다`;
    if (d.rounds.find((x) => x.round === d.round)?.reportId !== r.id) return `이미 수정 요청한 보고서입니다 — 지시 ${d.id}의 지금 회차(${d.round}회차) 보고서가 아닙니다`;
    return null;
  }

  /**
   * 결과 승인 (FBK-01): 이미 반영·확정된 결과의 사후 확인. 수정 요청 뒤라도 메인 에이전트가 새 회차를 열기 전이면 받는다(approveRefusal) — 그때는 그 지시의
   * 대기 중인 수정 요청 업무(change_request)를 지운다. 그 업무의 턴이 이미 돌고 있어도 승인한다: 지시가 끝나 그 뒤의 revise_directive는 conflict다
   */
  approve(id: string, comment: string): void {
    const ctx = this.ctx;
    const r = ctx.store.reports.require(id);
    if (r.status === 'approved') return;
    const refused = this.approveRefusal(r);
    if (refused) throw new BackendError('conflict', refused);
    const withdrawn = r.status === 'changes_requested';
    this.addComment(id, 'overall', comment, null);
    ctx.store.tx(() => {
      ctx.store.reports.put({ ...r, status: 'approved', readAt: r.readAt ?? ctx.now(), decidedAt: ctx.now() });
      if (r.directiveId) {
        const d = ctx.store.directives.get(r.directiveId);
        if (d?.state === 'awaiting_confirmation') transitionDirective(ctx, d.id, { type: 'approve' }, OWNER);
        if (withdrawn) cancelQueued(ctx, (q) => q.kind === 'change_request' && q.directiveId === r.directiveId, `대표가 보고서 ${id}을(를) 그대로 결과 승인함`);
      }
    });
    ctx.activity({
      kind: 'report',
      actor: OWNER,
      projectId: r.projectId,
      directiveId: r.directiveId,
      text: `보고서 ${id} 결과 승인${withdrawn ? ' (수정 요청 뒤 그대로 승인)' : ''}${comment ? `: ${comment}` : ''}`,
    });
    this.core.journal.server('report', `대표가 보고서 ${id} "${r.title}"을(를) 결과 승인함${withdrawn ? ' (수정 요청 뒤 그대로 승인 — 그 수정 요청으로 회차를 열지 않음)' : ''}${comment.trim() ? ` — 코멘트: ${comment.trim()}` : ''}`, {
      projectId: r.projectId,
      refs: [{ kind: 'report', id }, ...(r.directiveId ? [{ kind: 'directive' as const, id: r.directiveId }] : [])],
    });
    this.queueMemoryUpdate(
      r,
      `대표가 보고서 ${id} "${r.title}"을(를) ${withdrawn ? '수정 요청 뒤 그대로 ' : ''}결과 승인했습니다${withdrawn ? ' — 지시가 끝났고, 그 수정 요청으로 회차를 열지 않습니다' : ''}.${comment ? ` 코멘트: ${comment}` : ''} 드러난 선호가 있으면 프로젝트 기억에 반영하세요.`,
    );
    this.markRead(id);
  }

  /**
   * 대표가 지금 이 보고서에 수정 요청을 할 수 없는 까닭 (할 수 있으면 null) — requestChanges와 화면의 ReportDetail.canRequestChanges가 같은 판정을
   * 쓴다. 지시가 이미 끝났거나 취소된 보고서는 받지 않는다: 그 수정 요청은 끝난 업무라(deadWorkReason, 리드 결정 19) 메인 에이전트에게 닿기 전에
   * 지워진다 — 대표가 '수정 요청됨'만 보고 메인은 모르는 일이 없게 거부하고, 명령창으로 메인 에이전트에게 말하라고 알린다 (리드 결정 25).
   * 지시에 이 보고서보다 새 회차가 이미 열렸어도 같다 — 그 수정 요청도 끝난 업무다(리드 결정 19의 '새 회차' 조건, 리드 결정 34). 그래서 받은 수정 요청은 태어날
   * 때부터 끝난 업무인 일이 없다. 이미 수정 요청한 보고서는 다시 요청할 것이 없다 (requestChanges는 아무것도 하지 않는다)
   */
  requestChangesRefusal(r: Report): string | null {
    if (r.status === 'approved') return '이미 결과 승인한 보고서입니다';
    if (r.status === 'changes_requested') return '이미 수정 요청한 보고서입니다';
    const d = r.directiveId ? this.ctx.store.directives.get(r.directiveId) : null;
    if (d && !isDirectiveOpen(d)) {
      return `지시 ${d.id}이(가) 이미 ${DIRECTIVE_STATE_LABEL[d.state]}돼 이 보고서에는 수정 요청을 할 수 없습니다. 바꿀 것이 있으면 명령창으로 메인 에이전트에게 말해 주세요`;
    }
    if (d && d.round > r.round) {
      return `지시 ${d.id}의 ${d.round}회차가 이미 열려 있어 ${r.round}회차 보고서에는 수정 요청을 할 수 없습니다. 바꿀 것이 있으면 명령창으로 메인 에이전트에게 말해 주세요`;
    }
    return null;
  }

  /**
   * 수정 요청 (FBK-02·03 v0.6): 대표의 수정 요청은 메인 에이전트에게 가는 명령이다 — 보고서를 '수정 요청'으로 두고 코멘트(전체·부분)를 남긴 뒤
   * 메인 대기열(main:<P>)에 change_request 업무로 넣는다. 지시는 확인 대기 그대로이고, 다음 회차는 메인 에이전트가 revise_directive로 연다(revise).
   * 메인은 회차를 열지 않고 대표에게 되묻거나 새 지시로 처리할 수도 있다 (SERVER_DESIGN 2.2). 지시가 이미 끝났거나 취소됐으면 conflict다
   * (requestChangesRefusal, 리드 결정 25)
   */
  requestChanges(id: string, raw: { overall: string; anchored: AnchoredComment[] }): void {
    const ctx = this.ctx;
    // 보고서 코멘트·대기열로 들어가는 대표 글도 저장 전에 가린다 (SEC-10)
    const input = { overall: ctx.redact.text(raw.overall), anchored: ctx.redact.value(raw.anchored) };
    const r = ctx.store.reports.require(id);
    if (r.status === 'changes_requested') return;
    const refused = this.requestChangesRefusal(r);
    if (refused) throw new BackendError('conflict', refused);
    if (!input.overall.trim() && input.anchored.length === 0) throw new BackendError('invalid', '수정 요청 내용을 적어 주세요');
    this.addComment(id, 'overall', input.overall, null);
    for (const a of input.anchored) this.addComment(id, 'anchored', a.comment, a.quote);
    ctx.store.reports.put({ ...r, status: 'changes_requested', readAt: r.readAt ?? ctx.now(), decidedAt: ctx.now() });
    const detail = [input.overall.trim(), ...input.anchored.map((a) => `- "${a.quote}" → ${a.comment}`)].filter(Boolean).join('\n');
    // 수정 요청도 대표가 메인 에이전트에게 한 말이다 — 대화 기록(command.history가 읽는 곳)에 대표 글로 한 번 남긴다 (리드 결정 S8-13). 거부·이미 수정
    // 요청한 보고서(위에서 끝남)는 남기지 않고, 같은 요청 ID로 다시 온 호출은 저장한 답(requestReplies)이 받아 여기까지 오지 않는다. detail은 이미 가린 글이다
    ctx.store.conversation.insert({
      id: ctx.store.nextId('conversation'),
      target: r.projectId ?? 'main',
      role: 'owner',
      text: `보고서 ${id} "${r.title}" 수정 요청:\n${detail}`.slice(0, 20000),
      attachments: [],
      directiveId: r.directiveId,
      createdAt: ctx.now(),
    });
    const d = r.directiveId ? ctx.store.directives.get(r.directiveId) : null;
    const how = !d
      ? '이 보고서는 지시에 묶이지 않은 직접 명령의 보고서입니다 — 수정 요청대로 처리한 뒤 결과를 보고하세요.'
      : d.state === 'awaiting_confirmation'
        ? `다음 회차를 열려면 revise_directive(directive_id="${d.id}", report_id="${id}", instructions="프로듀서에게 줄 지시")를 호출하세요 — 대표 코멘트는 그대로 그 회차 요청으로 프로듀서에게 넘어갑니다. 요청이 모호하면 ask_owner로 먼저 묻고, 따로 처리할 일이면 새 지시(register_directive)로 처리해도 됩니다. 회차를 열지 않고 처리하면 대표에게 이 보고서를 그대로 결과 승인할 수 있다고 알리거나, 지시를 끝내야 하면 cancel_directive로 까닭과 함께 취소하세요 — 둘 다 아니면 지시가 확인 대기로 남습니다.`
        : `지시 ${d.id}은(는) 지금 ${DIRECTIVE_STATE_LABEL[d.state]} 상태라 회차를 열 수 없습니다 — 필요하면 새 지시(register_directive)로 처리하세요.`;
    enqueue(ctx, {
      kind: 'change_request',
      memberId: MAIN_AGENT_ID,
      sessionKey: mainKey(r.projectId),
      projectId: r.projectId,
      directiveId: r.directiveId,
      reportId: id,
      priority: 'high',
      message: [`대표가 보고서 ${id} "${r.title}"에 수정 요청을 했습니다${d ? ` (지시 ${d.id} ${d.round}회차)` : ''}:`, detail, how].join('\n'),
    });
    ctx.activity({ kind: 'report', actor: OWNER, projectId: r.projectId, directiveId: r.directiveId, text: `보고서 ${id} 수정 요청 → 메인 에이전트`, result: detail });
    this.core.journal.server('report', `대표가 보고서 ${id} "${r.title}"에 수정 요청을 함${d ? ` (지시 ${d.id} ${d.round}회차)` : ''}: ${detail}`, {
      projectId: r.projectId,
      refs: [{ kind: 'report', id }, ...(d ? [{ kind: 'directive' as const, id: d.id }] : [])],
    });
    this.queueMemoryUpdate(r, `대표가 보고서 ${id} "${r.title}"에 수정 요청을 했습니다:
${detail}
드러난 선호를 프로젝트 기억에 반영하세요.`);
    this.markRead(id);
  }

  /**
   * 수정 요청을 받은 메인 에이전트가 다음 회차를 연다 (revise_directive, FBK-03 v0.6, SERVER_DESIGN 2.6): 대표가 지금 회차의 보고서에 수정 요청을 했고 지시가
   * 확인 대기일 때만. 회차 +1, 확인 대기 → 계획, 프로듀서 [plan]. 대표 코멘트(전체·부분)는 그대로 그 회차 요청으로 붙이고(FBK-03), 메인의 지시를 함께 넘긴다.
   * 이미 연 회차에 다시 부르면 지시가 확인 대기가 아니라 거부된다 (재시도는 request_id로 같은 결과)
   */
  revise(directiveId: string, reportId: string, instructions: string, actor: Actor, requestId: string | null): Directive {
    const ctx = this.ctx;
    const d = directiveOrThrow(ctx, directiveId);
    const r = ctx.store.reports.get(reportId);
    if (!r || r.directiveId !== d.id) throw new BackendError('invalid', `보고서 ${reportId}은(는) 지시 ${d.id}의 보고서가 아닙니다`);
    // 수정 요청 뒤 대표가 그대로 결과 승인했으면 지시는 끝났다 (리드 결정 10) — 그 수정 요청으로는 회차를 열지 않는다
    if (r.status === 'approved') throw new BackendError('conflict', `대표가 보고서 ${r.id}을(를) 그대로 결과 승인해 지시 ${d.id}이(가) 끝났습니다 — 회차를 열지 않습니다`);
    if (r.status !== 'changes_requested') throw new BackendError('conflict', `보고서 ${r.id}에는 대표의 수정 요청이 없습니다 — 다음 회차는 대표가 수정 요청한 보고서로만 엽니다`);
    if (d.state !== 'awaiting_confirmation') {
      throw new BackendError('conflict', `지시 ${d.id}은(는) 확인 대기가 아니라(${DIRECTIVE_STATE_LABEL[d.state]}) 회차를 열 수 없습니다 — 이미 다음 회차를 열었거나 끝났습니다`);
    }
    if (d.rounds.find((x) => x.round === d.round)?.reportId !== r.id) throw new BackendError('conflict', `보고서 ${r.id}은(는) 지금 회차(${d.round}회차)의 보고서가 아닙니다`);
    const comments = ctx.store.reportComments.list({ ref1: r.id });
    const overall = comments.filter((c) => c.kind === 'overall').map((c) => c.text).join('\n\n');
    const anchored: AnchoredComment[] = comments.filter((c) => c.kind === 'anchored').map((c) => ({ quote: c.quote ?? '', comment: c.text }));
    const note = ctx.redact.text(instructions.trim());
    const nd = transitionDirective(ctx, d.id, { type: 'request_changes', text: overall, anchored }, actor, requestId);
    const producer = producerOf(ctx, nd.projectId!);
    const detail = [overall.trim(), ...anchored.map((a) => `- "${a.quote}" → ${a.comment}`)].filter(Boolean).join('\n');
    enqueue(ctx, {
      kind: 'plan',
      memberId: producer.id,
      sessionKey: directiveKey(nd.id),
      projectId: nd.projectId,
      directiveId: nd.id,
      priority: 'high',
      requestId,
      message: `대표가 지시 ${nd.id} 보고서(${r.id})에 수정 요청을 했고, 메인 에이전트가 ${nd.round}회차를 열었습니다.
대표 수정 요청:
${detail}
메인 에이전트 지시: ${note}
이전 회차 작업·보고서는 그대로 두고, 수정 작업을 새로 create_task로 만드세요.`,
    });
    return nd;
  }

  private queueMemoryUpdate(r: Report, message: string): void {
    enqueue(this.ctx, {
      kind: 'memory_update',
      memberId: MAIN_AGENT_ID,
      sessionKey: mainKey(r.projectId),
      projectId: r.projectId,
      directiveId: r.directiveId,
      priority: 'low',
      message,
    });
  }
}

const MEMORY_TEMPLATE = (name: string) => `# ${name} 프로젝트 기억

## 목표

## 현재 상태

## 주요 결정

## 진행 중 지시

## 최근 보고

## 대표 선호
`;

export class MemoryService {
  constructor(private readonly core: Core) {}

  ensure(projectId: string | null, name: string): void {
    const file = projectMemoryFile(this.core.ctx.paths, projectId);
    const cur = readTextOr(file, '');
    if (!cur) writeFileAtomic(file, MEMORY_TEMPLATE(name));
  }

  // 경로에는 DB가 발급한 프로젝트 ID만 쓴다 — 도구 인자를 그대로 쓰면 앱 데이터 밖에 파일을 만들 수 있다 (SEC-02, 10.2).
  // 없는 프로젝트는 not_found로 거부된다. 비어 있거나 null이면 일반 기억
  read(projectId: string | null): string {
    const ctx = this.core.ctx;
    const p = projectId ? projectOrThrow(ctx, projectId) : null;
    const id = p?.id ?? null;
    this.ensure(id, p?.name ?? '일반');
    return readFileSync(projectMemoryFile(ctx.paths, id), 'utf8');
  }

  write(projectId: string | null, content: string): void {
    const ctx = this.core.ctx;
    const id = projectId ? projectOrThrow(ctx, projectId).id : null;
    writeFileAtomic(projectMemoryFile(ctx.paths, id), ctx.redact.text(content).slice(0, 60000));
    ctx.activity({ kind: 'system', actor: MAIN_AGENT_ID, projectId: id, text: `프로젝트 기억 갱신 (${id ?? '일반'})` });
  }
}
