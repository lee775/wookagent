/**
 * 메인 에이전트의 긴급 지시 (instruct_member `urgent: true | 'interrupt'`, SERVER_DESIGN 2.7, CLI-10 v0.6).
 * 옛 대표 직접 메시지(CTL-05, 없앰)의 전달 장치를 그대로 잇는다 — 보낸 주체만 M-MAIN이다 (ARCHITECTURE 5장 '대표 직접 메시지 전달 보장'):
 * - 받는 팀원의 지금 업무 세션(돌고 있는 턴의 세션, 없으면 맡은 작업, 프로듀서면 진행 중 지시)에 우선 항목(`urgent`)으로 넣는다 — 지금 턴이 끝난 뒤
 *   같은 세션 맨 앞에 전달하고(`'interrupt'`면 지금 턴을 끝내고), 정지·보류 중이면 저장만 한다
 * - 검수·병합 전에 반드시 전달한다 (records.isUrgentDirect를 tasks.reopenForOwnerMessage·holdForReviewerMessage가 본다), 통과 뒤에 오면 다시 판정한다
 * - 그 작업을 검수하는 쪽은 판정 전에 이 지시를 본다 (tasks.ownerInstructionsFor — 완료 조건·프로듀서 지시보다 우선, CTL-06)
 * - 프로듀서에게는 공유 사본(ownerShared — 그 자체로 턴을 띄우지 않는다)으로 알린다 (CMD-06, AC-17)
 */
import type { AgentMessage, Member, Task } from '@shared/domain';
import { MAIN_AGENT_ID } from '@shared/domain';
import { sameTarget } from '@core/taskMachine';
import { BackendError } from '../backend/types';
import type { Core } from './core';
import { directiveKey, enqueue, parseKey, reviewKey, taskKey } from './records';
import { activeTaskOf, closedDirectiveWork, memberOrThrow, projectOrThrow, roleOf } from './lookups';

export interface UrgentInstructionResult {
  messageId: string;
  /** 전달할 업무 세션 키 (task:T-0001 등) */
  sessionKey: string;
  /** sessionKey와 같다 — 보통 지시(instruct_member)의 결과와 같은 이름 */
  delivered: string;
  /** 공유 사본을 받은 팀원 (프로듀서) */
  sharedWith: string[];
  urgent: true | 'interrupt';
  /** 바로(지금 턴이 끝난 뒤) 전달되지 않는 까닭 — 보통 경우 null */
  note: string | null;
}

/** 업무 세션 키를 안내에 쓰는 말로 (T-0002 작업 · T-0001 검수 · D-0001 지시 관리) */
function workLabel(key: string): string {
  const { kind, ref } = parseKey(key);
  return kind === 'task' ? `${ref} 작업` : kind === 'review' ? `${ref} 검수` : kind === 'directive' ? `${ref} 지시 관리` : key;
}

/** 프로젝트의 진행 중 지시 (프로듀서의 지시 관리 세션) */
function openDirectiveOf(core: Core, projectId: string | null): string | null {
  return projectId ? (core.ctx.store.directives.list({ project_id: projectId }).filter((x) => ['planning', 'in_progress', 'reporting'].includes(x.state)).pop()?.id ?? null) : null;
}

/**
 * 검수 세션으로 간 긴급 지시의 안내 — 검수자가 이미 통과로 판정했는지, 병합·확정이 어디까지 왔는지에 따라 사실대로 (CTL-06, AC-36).
 * 통과 뒤에 온 지시는 병합·확정을 미루고 먼저 전달해 검수자가 다시 판정할 수 있다 (tasks.holdForReviewerMessage) — main에 반영된 뒤는 아니다
 */
function reviewSessionNote(core: Core, t: Task, memberId: string, interrupt: boolean): string | null {
  const p = t.review.passed;
  const held = t.state === 'on_hold';
  if (p && p.reviewerId === memberId && sameTarget(p.target, t.review.target)) {
    if (t.merge) return `검수자가 이미 통과로 판정했고 ${t.id}은(는) main에 병합돼 판정을 바꿀 수 없습니다. 이 지시는 전달하지 못할 수 있습니다 — 전달하지 못하면 알림으로 알려 드립니다.`;
    if (core.merges.isPending(t.id)) {
      return `검수자가 이미 통과로 판정했고 ${t.id}의 병합을 처리하는 중입니다. main을 바꾸기 전이면 병합을 멈추고 그 검수 세션의 다음 턴 맨 앞에 먼저 전달합니다 — 검수자가 지시를 보고 다시 판정하면 그 판정이 통과를 대신합니다. 이미 main에 반영됐으면 전달하지 못하고 알림으로 알려 드립니다.`;
    }
    const what = t.outputMode === 'artifact' ? '산출물 확정' : '병합 판단';
    return `검수자가 이미 이 버전을 통과로 판정했습니다. ${held ? '보류가 풀리면' : '지금 검수 턴이 끝나면'} 그 검수 세션의 다음 턴 맨 앞에 먼저 전달하고 그때까지 ${what}을(를) 미룹니다 — 검수자가 지시를 보고 다시 판정하면 그 판정이 통과를 대신하고, 바꾸지 않으면 그 통과로 이어 갑니다.`;
  }
  if (held) return `${t.id}이(가) 보류 중이라 지시만 저장했습니다. 보류가 풀려 검수가 다시 돌면 그 검수 세션의 다음 턴 맨 앞에 전달하고, 판정은 지시를 확인한 뒤에 받습니다.`;
  if (t.state !== 'in_review') return `${t.id}이(가) 다시 작업 중이라 다음 버전이 제출돼 검수할 때 그 검수 세션 맨 앞에 전달하고, 판정은 지시를 확인한 뒤에 받습니다.`;
  return interrupt ? null : '지금 검수 턴이 끝나면 그 검수 세션의 다음 턴 맨 앞에 전달합니다. 판정은 지시를 확인한 뒤에 받습니다.';
}

/**
 * 긴급 지시가 바로(지금 턴이 끝난 뒤) 전달되지 않는 까닭 — 도구 결과의 note로 돌려준다 (CLI-10, AC-36). 보통 경우는 null.
 * 정지·보류 중이면 저장만 하고, 검수 중인 작업이면 완료하기 전에 진행으로 돌려 먼저 전달한다 (tasks.reopenForOwnerMessage)
 */
function deliveryNote(core: Core, m: Member, sessionKey: string, interrupt: boolean): string | null {
  const ctx = core.ctx;
  const stop = ctx.stop();
  if (stop.global.active) return '긴급 정지 중이라 지시만 저장했습니다. 정지를 해제하고 그 업무를 재개하면 같은 업무 세션에 먼저 전달합니다.';
  if (stop.members[m.id]?.paused || (m.projectId && stop.projects[m.projectId]?.paused)) return '일시정지 중이라 지시만 저장했습니다. 재개하면 같은 업무 세션에 먼저 전달합니다.';
  const { kind, ref } = parseKey(sessionKey);
  if (kind !== 'task' && kind !== 'review') return null;
  const t = ctx.store.tasks.get(ref);
  if (!t) return null;
  if (t.state === 'done' || t.state === 'cancelled') return `${t.id}은(는) 방금 ${t.state === 'done' ? '완료' : '취소'}돼 이 업무 세션으로는 전달하지 못할 수 있습니다. 전달하지 못하면 알림으로 알려 드립니다.`;
  if (closedDirectiveWork(ctx, null, t)) return `${t.id}의 지시가 취소·종료돼 이 작업은 곧 취소됩니다. 이 지시는 전달하지 못할 수 있습니다 — 전달하지 못하면 알림으로 알려 드립니다.`;
  if (kind === 'review') return reviewSessionNote(core, t, m.id, interrupt);
  const reviewing = t.state === 'in_review' || (t.state === 'on_hold' && t.hold.returnState === 'in_review');
  if (reviewing) {
    return `${t.id}이(가) 검수 중이라 지금은 작업 세션에 턴을 띄우지 않습니다. 검수에서 반려되면 재작업 첫 턴에, 통과해도 완료하기 전에 작업을 진행으로 돌려 먼저 전달하고 반영한 새 버전을 다시 검수합니다 (반려로 세지 않음). 검수자도 판정 전에 이 긴급 지시를 봅니다.`;
  }
  if (t.state === 'on_hold') return `${t.id}이(가) 보류 중이라 지시만 저장했습니다. 보류가 풀리면 같은 업무 세션에 먼저 전달합니다.`;
  if (t.state === 'in_progress' && !interrupt && (t.pendingSubmit || core.tasks.isSubmitting(t.id) || core.merges.isPending(t.id))) {
    return `${t.id}의 검수 요청을 처리하는 중입니다. 검수에서 반려되면 재작업 첫 턴에, 통과해도 완료하기 전에 작업을 진행으로 돌려 먼저 전달합니다.`;
  }
  return null;
}

/**
 * 다시 판정 실패로 보류된 작업의 검수 세션으로 보낸 긴급 지시의 안내 (S8-B1): 어디로 갔는지, 원래 갈 곳(지금 턴·맡은 작업)으로는 가지 않았다는 것,
 * 재개하면 무엇을 하는지 — 보류 알림·보류 사유와 같은 두 길이다 (재개 전에는 병합·확정하지 않음)
 */
function rejudgeNote(core: Core, t: Task, m: Member, passedOver: string | null, liveNotStopped: boolean): string {
  const what = t.outputMode === 'artifact' ? '산출물 확정' : '병합 판단';
  const stop = core.ctx.stop();
  const halted = stop.global.active
    ? ' 지금은 긴급 정지 중이라 정지가 해제된 뒤 재개하세요.'
    : stop.members[m.id]?.paused || (m.projectId && stop.projects[m.projectId]?.paused)
      ? ' 지금은 일시정지 중이라 정지가 풀려야 다시 판정 턴이 돕니다.'
      : '';
  return [
    `${t.id} 다시 판정으로 전달 — ${t.id}이(가) 다시 판정 실패로 보류 중이라 ${m.name}의 ${t.id} 검수 세션에 저장했습니다${passedOver ? ` (${workLabel(passedOver)}에는 보내지 않음${liveNotStopped ? ', 지금 턴도 중단하지 않음' : ''})` : ''}.`,
    ` ${t.id}을(를) 재개하면 검수자가 이 지시를 보고 다시 판정한 뒤에 그 판정대로 이어 갑니다(통과가 그대로면 ${what}) — 재개하기 전에는 ${what}을(를) 하지 않습니다.${halted}`,
  ].join('');
}

/**
 * 긴급 지시를 보낸다 (메인 에이전트 도구 instruct_member urgent). mode 'interrupt'면 그 팀원의 지금 턴을 끝내고 바로 전달한다.
 * 받는 팀원·스킬 검사는 부르는 쪽(tools.instructMember)이 했다
 */
export function sendUrgentInstruction(core: Core, memberId: string, text: string, o: { mode: true | 'interrupt'; skill: string | null; requestId: string | null }): UrgentInstructionResult {
  const ctx = core.ctx;
  const m = memberOrThrow(ctx, memberId);
  if (m.isMain || m.deletedAt) throw new BackendError('invalid', '지시할 수 없는 대상입니다');
  const body = text.trim();
  if (!body) throw new BackendError('invalid', '지시 내용을 입력하세요');
  if (o.skill && !roleOf(ctx, m.roleId)?.allowedSkills.includes(o.skill)) throw new BackendError('forbidden', `${m.name}의 역할에 허용되지 않은 스킬입니다: ${o.skill} (SKL-04)`);
  const interrupt = o.mode === 'interrupt';
  const live = core.turns.liveOf(m.id);
  let sessionKey: string | null = null;
  let taskId: string | null = null;
  let directiveId: string | null = null;
  if (live) {
    const turn = ctx.store.turns.get(live.turnId);
    if (turn) {
      const s = ctx.store.sessions.get(turn.sessionId);
      sessionKey = s?.workKey ?? null;
      taskId = turn.taskId;
      directiveId = turn.directiveId;
    }
  }
  if (!sessionKey) {
    const active = activeTaskOf(ctx, m.id);
    if (active) {
      sessionKey = taskKey(active.id);
      taskId = active.id;
      directiveId = active.directiveId;
    } else if (m.isProducer && m.projectId) {
      const d = openDirectiveOf(core, m.projectId);
      if (d) {
        sessionKey = directiveKey(d);
        directiveId = d;
      }
    }
  }
  // 다시 판정 실패로 보류된 작업의 검수자에게 보내는 긴급 지시는 그 작업의 검수 세션으로 간다 — 보류 사유가 안내한 길이다 ("검수자에게 지시를 보낸 뒤
  // 재개"). 지금 턴·맡은 작업보다 먼저, 그런 보류가 여럿이면 먼저 보류된 작업으로 — 어디로 갔는지·어디로 가지 않았는지 안내로 알린다 (CTL-06, S8-B1)
  const rejudge = core.tasks.rejudgeHeldTaskFor(m.id);
  const passedOver = rejudge && sessionKey && sessionKey !== reviewKey(rejudge.id) ? sessionKey : null;
  if (rejudge) {
    sessionKey = reviewKey(rejudge.id);
    taskId = rejudge.id;
    directiveId = rejudge.directiveId;
  }
  if (!sessionKey) throw new BackendError('conflict', `${m.name}은(는) 지금 진행 중인 업무가 없습니다. 프로듀서를 통해 작업으로 지시하세요`);
  const sharedWith: string[] = [];
  if (m.projectId && !m.isProducer) sharedWith.push(projectOrThrow(ctx, m.projectId).producerId);
  const msg: AgentMessage = {
    id: ctx.store.nextId('message'),
    requestId: o.requestId,
    fromActor: MAIN_AGENT_ID,
    toMemberId: m.id,
    sessionKey,
    text: ctx.redact.text(body),
    kind: 'urgent',
    sharedWith: sharedWith.filter((x) => x !== m.id),
    urgent: true,
    createdAt: ctx.now(),
    deliveredAt: null,
  };
  const target = sessionKey;
  const skillNote = o.skill ? ` (스킬 ${o.skill} 사용)` : '';
  ctx.store.tx(() => {
    ctx.store.messages.insert(msg);
    enqueue(ctx, {
      kind: 'message',
      memberId: m.id,
      sessionKey: target,
      projectId: m.projectId,
      taskId,
      directiveId,
      urgent: true,
      priority: 'urgent',
      messageId: msg.id,
      requestId: o.requestId,
      message: `메인 에이전트 긴급 지시${skillNote} (프로듀서 지시·완료 조건보다 우선합니다, CTL-06): ${body}`,
    });
    // 프로듀서에게 공유한다 (CMD-06, AC-17): 그 업무의 지시 관리 세션(없으면 프로젝트의 진행 중 지시)의 다음 턴에 함께 전달한다. 공유 사본은 그 자체로
    // 턴을 띄우지 않고 우선 전달도 아니다 — 그 팀원에게 간 긴급 지시를 알게 하는 정보
    const copy = `[공유] 메인 에이전트 → ${m.name}(${m.id}) 긴급 지시${taskId ? ` [${taskId}]` : ''}${skillNote} — 프로듀서 지시·완료 조건보다 우선합니다 (CTL-06): ${body}`;
    for (const to of msg.sharedWith) {
      const d = directiveId ?? openDirectiveOf(core, m.projectId);
      if (d) enqueue(ctx, { kind: 'message', memberId: to, sessionKey: directiveKey(d), projectId: m.projectId, directiveId: d, message: copy, ownerShared: true });
    }
  });
  // 바로 전달되지 않으면 그 까닭을 기록하고 돌려준다 — 검수 중인 작업의 세션이면 반려 때 또는 완료 전에 진행으로 돌려 전달된다
  // (REV-08: 검수 중 작업 폴더에 턴을 띄우지 않음, AC-36: 그대로 완료되며 사라지지 않음). 다시 판정으로 보낸 지시는 지금 턴의 세션으로 가지 않으므로
  // 그 턴을 끝내지 않는다
  const interrupting = interrupt && !!live && !rejudge;
  const note = rejudge ? rejudgeNote(core, rejudge, m, passedOver, interrupt && !!live) : deliveryNote(core, m, target, interrupting);
  ctx.activity({
    kind: 'message',
    actor: MAIN_AGENT_ID,
    projectId: m.projectId,
    memberId: m.id,
    taskId,
    requestId: o.requestId,
    text: `메인 에이전트 → ${m.name} 긴급 지시${interrupting ? ' (현재 턴 중단 후 전달)' : ''}${note ? ` (${note})` : ''}: ${body.slice(0, 200)}`,
  });
  // 기존 턴이 끝난 뒤 같은 업무 세션에 우선 전달 (CLI-10). 즉시 전달이면 현재 턴을 끝낸다
  if (interrupting) void core.turns.stopMember(m.id, '긴급 지시 즉시 전달', true);
  return { messageId: msg.id, sessionKey: target, delivered: target, sharedWith: msg.sharedWith, urgent: o.mode, note };
}
