/**
 * 정지 제어 (9장, CTL-01..11).
 * - 정지 값은 실행 종료보다 먼저 DB에 저장한다 (CTL-08)
 * - 긴급 정지: 새 실행 즉시 차단 → 모든 CLI·하위 프로세스 종료 확인(3초) → 요약 (CTL-03·04)
 * - 전역 해제는 작업을 재개하지 않는다. 보류 목록을 메인 에이전트에게 업무(stop_released)로 넘기고, 메인이 항목별로 재개한다 (CTL-10 v0.6)
 */
import type { Actor, HoldReason, StopMode, Task } from '@shared/domain';
import { MAIN_AGENT_ID, OWNER } from '@shared/domain';
import { HOLD_REASON_LABEL, TASK_STATE_LABEL } from '@shared/labels';
import type { EmergencySummary } from '@shared/views';
import { isOwnerResumable, isTerminal } from '@core/taskMachine';
import { BackendError } from '../backend/types';
import type { Core } from './core';
import { enqueue, mainKey, parseKey, transitionTask } from './records';
import { memberName, memberOrThrow, projectOrThrow } from './lookups';
import { STOP_CONFIRM_MS } from './turns';
import type { Ctx } from './context';

const EMERGENCY_KEY = 'stop.lastEmergency';

/**
 * 긴급 정지 요약·알림에 쓸 팀원 이름 (팀원 ID → 이름). 다른 팀원과 이름이 겹치면 프로젝트 이름을 붙이고(모든 프로젝트의 프로듀서는 '서진'),
 * 그래도 겹치면 팀원 ID까지 붙인다 — 예: 서진(B 프로젝트), 서진(B 프로젝트, M-0004). 다른 팀원을 한 이름으로 합치지 않는다 (S8-D1, 12장).
 * 고른 이름끼리도 다시 견준다 — 팀원 이름은 자유라 '서진(B 프로젝트)'처럼 다른 팀원의 붙인 이름과 같을 수 있다. 그래도 같은 이름인 팀원은 모두
 * 팀원 ID까지 붙인다 (S9-D2). 팀원 ID는 겹치지 않으므로 끝난다
 */
function distinctNames(ctx: Ctx, ids: string[]): Map<string, string> {
  const uniq = [...new Set(ids)];
  const label = (id: string, level: 0 | 1 | 2): string => {
    const projectId = ctx.store.members.get(id)?.projectId;
    const extra = [level >= 1 && projectId ? (ctx.store.projects.get(projectId)?.name ?? projectId) : null, level === 2 ? id : null].filter(Boolean);
    return extra.length ? `${memberName(ctx, id)}(${extra.join(', ')})` : memberName(ctx, id);
  };
  const clash = (id: string, level: 0 | 1) => uniq.some((o) => o !== id && label(o, level) === label(id, level));
  const names = new Map(uniq.map((id) => [id, label(id, !clash(id, 0) ? 0 : !clash(id, 1) ? 1 : 2)]));
  for (;;) {
    const same = uniq.filter((id) => names.get(id) !== label(id, 2) && uniq.some((o) => o !== id && names.get(o) === names.get(id)));
    if (!same.length) return names;
    for (const id of same) names.set(id, label(id, 2));
  }
}

export class StopService {
  constructor(private readonly core: Core) {}

  private get ctx() {
    return this.core.ctx;
  }

  /**
   * 작업 관련 프로그램 처리(제출·병합·되돌리기·자동 검사)를 지금 해도 되는지. 앱 종료 중이면 아니다 — 진행 중인 처리는 다음 단계에서 멈추고
   * (제출 요청·통과 기록은 남는다) 재시작 복구가 이어 간다. 종료는 그 멈춤을 기다린 뒤 저장소를 닫는다 (orchestrator.stop, ENV-09)
   */
  runAllowedForTask(task: Task): boolean {
    if (this.core.stopping) return false;
    const s = this.ctx.stop();
    if (s.global.active) return false;
    if (s.projects[task.projectId]?.paused) return false;
    if (s.members[task.assigneeId]?.paused) return false;
    return task.state !== 'on_hold' && !isTerminal(task.state);
  }

  lastEmergency(): EmergencySummary | null {
    return this.ctx.store.kv.get<EmergencySummary>(EMERGENCY_KEY);
  }

  heldByEmergency(): number {
    return this.ctx.store.tasks.list({ state: 'on_hold' }).filter((t) => t.hold.reasons.some((r) => r.kind === 'emergency_stop')).length;
  }

  async emergency(by: Actor): Promise<EmergencySummary> {
    const ctx = this.ctx;
    const at = ctx.now();
    // 1) 정지 값부터 저장 → 스케줄러·처리기 모두 즉시 차단
    const s = ctx.stop();
    s.global = { active: true, since: s.global.active ? s.global.since : at, by, releasedAt: null };
    ctx.saveStop(s);
    ctx.activity({ kind: 'stop', actor: by, level: 'warn', text: '긴급 정지 실행' });
    // 2) 실행 종료 (병렬, 제한 시간 안). 프로세스를 띄우기 전인 턴(작업 폴더 준비 중 등)은 띄우지 않으므로 그 준비가 끝나기를 다 기다리지 않는다 (CTL-03 3초, windows:F9)
    const turnsP = this.core.turns.stopAll('긴급 정지', { noProcessWaitMs: STOP_CONFIRM_MS });
    const checksP = this.core.checks.terminateFor(() => true);
    // 메인 에이전트의 서버 명령(host_exec)도 함께 — 같은 3초 안이다 (리드 결정 S5-18, AC-15·29). 그 턴의 마무리는 같은 종료 약속을 받는다
    const hostP = this.core.hostExec.terminateWhere(() => true, '긴급 정지');
    // 3) 미완료 작업 보류 (원래 상태 저장)
    const held: EmergencySummary['heldTasks'] = [];
    for (const t of ctx.store.tasks.list({ state: ['waiting', 'in_progress', 'in_review', 'on_hold'] })) {
      if (t.hold.reasons.some((r) => r.kind === 'emergency_stop')) continue;
      const prev = t.state === 'on_hold' ? (t.hold.returnState ?? 'on_hold') : t.state;
      transitionTask(ctx, t.id, { type: 'hold', reason: this.core.tasks.reason('emergency_stop', 'global', '긴급 정지', by) }, by);
      held.push({ taskId: t.id, title: t.title, previousState: prev, projectId: t.projectId });
    }
    const results = await turnsP;
    const checkResults = await checksP;
    const hostResults = await hostP;
    // 자동 검사·서버 명령 프로세스가 남아도 정지 완료로 표시하지 않는다 (CTL-03)
    const failed = [
      ...results.filter((r) => !r.ok).map((r) => ({ memberId: r.memberId, detail: r.detail, remaining: r.remaining ?? -1 })),
      ...checkResults
        .filter((c) => !c.result.ok)
        .map((c) => ({ memberId: ctx.store.tasks.get(c.taskId)?.assigneeId ?? 'system', detail: `자동 검사 ${c.taskId}: ${c.result.detail}`, remaining: c.result.remaining })),
      ...hostResults.filter((h) => !h.result.ok).map((h) => ({ memberId: MAIN_AGENT_ID, detail: `서버 명령 ${h.execId}: ${h.result.detail}`, remaining: h.result.remaining })),
    ];
    // 팀원은 ID로 묶고, 이름이 겹치면 프로젝트 이름을 붙여 쓴다 — 모든 프로젝트의 프로듀서가 '서진'이라 이름으로 묶으면 다른 팀원의 실패가 빠진다 (S8-D1)
    const names = distinctNames(ctx, [...results.map((r) => r.memberId), ...failed.map((f) => f.memberId)]);
    // 남은 수를 센 실패는 그 수가 detail에 있다. 확인하지 못한 실패(-1, 0)만 remaining -1을 둔다 — 화면이 둘을 가른다 (S8-D3)
    const failures: EmergencySummary['failures'] = failed.map((f) => ({ memberId: f.memberId, memberName: names.get(f.memberId)!, detail: f.detail, ...(f.remaining > 0 ? {} : { remaining: -1 }) }));
    // 알림은 남은 프로세스를 셌을 때만 '남았다'고 쓴다 — 남은 후손을 확인하지 못한 실행(-1)은 확인하지 못했다고 (S7-D3, 12장)
    const counted = new Set(failures.filter((f) => f.remaining === undefined).map((f) => f.memberId));
    const unchecked = [...new Set(failures.map((f) => f.memberId))].filter((id) => !counted.has(id));
    const nameList = (ids: Iterable<string>) => [...ids].map((id) => names.get(id)!).join(', ');
    const failureText = [counted.size ? `남은 프로세스가 있습니다: ${nameList(counted)}` : '', unchecked.length ? `남은 프로세스를 확인하지 못했습니다: ${nameList(unchecked)}` : '']
      .filter(Boolean)
      .join(' / ');
    const summary: EmergencySummary = {
      at,
      completed: failures.length === 0,
      stoppedTurns: results.map((r) => ({ turnId: r.turnId, memberId: r.memberId, memberName: names.get(r.memberId)!, taskId: r.taskId, ok: r.ok, detail: r.detail })),
      heldTasks: held,
      failures,
    };
    ctx.store.kv.set(EMERGENCY_KEY, summary);
    ctx.activity({
      kind: 'stop',
      actor: by,
      level: failures.length ? 'error' : 'warn',
      text: `긴급 정지 ${failures.length ? '— 종료 실패 있음' : '완료'}: 턴 ${results.length}개 종료, 작업 ${held.length}개 보류`,
      result: failures.map((f) => `${f.memberName}: ${f.detail}`).join('; ') || null,
    });
    // 긴급 정지는 메인 일지의 서버 기록이다 (SERVER_DESIGN 6.1, S4b)
    this.core.journal.server(
      'stop',
      `${by === OWNER ? '대표가 ' : ''}긴급 정지 — 턴 ${results.length}개를 끝내고 작업 ${held.length}개를 보류함${failures.length ? ` (종료를 확인하지 못한 실행 ${failures.length}개: ${failures.map((f) => f.memberName).join(', ')})` : ''}`,
      { refs: held.slice(0, 10).map((t) => ({ kind: 'task' as const, id: t.taskId })) },
    );
    ctx.notify({
      level: 'urgent',
      title: failures.length ? '긴급 정지 — 종료 실패' : '긴급 정지 완료',
      body: failures.length ? failureText : `실행 ${results.length}개를 종료하고 작업 ${held.length}개를 보류했습니다`,
      link: { tab: 'settings', section: 'policy' },
      key: 'emergency',
    });
    ctx.bus.emit('emergency', summary);
    return summary;
  }

  /**
   * 대표 확인 후 전역 정지 해제 — 작업은 재개하지 않는다 (CTL-10). 긴급 정지로 보류된 작업이 있으면 그 목록을 메인 에이전트 대기열(main:general)에
   * '정지 해제' 업무로 넣는다 — 메인이 항목마다 확인하고 resume_task로 재개한 것만 실행된다 (v0.6, SERVER_DESIGN 2.2). 해제 값과 업무는 한 트랜잭션이다.
   * 메인 에이전트(M-MAIN)의 일시정지도 함께 푼다 — 긴급 정지가 없어도 (리드 결정 6, 10-29). 메인은 자기를 일시정지하지 못하므로 그 정지는 프로그램
   * (종료를 확인하지 못한 메인 실행, CTL-11)이나 예전 데이터(대표가 건 정지)가 건 것이고, 정지된 메인은 턴이 뜨지 않아 자기 정지를 풀 수 없다.
   * 대표에게 남은 안전장치(정지 해제)가 그 출구다. 다시 눌러도 같은 결과다(풀 것이 없으면 아무것도 하지 않는다). 다만 멈춘 자리 교체의 나가는 메인 턴이
   * 아직 남았으면 그 일시정지는 풀지 않고 출구로 남긴다 (seat.keepsMainHold, 리드 결정 S4-27)
   */
  release(by: Actor): void {
    const ctx = this.ctx;
    const s = ctx.stop();
    if (!s.global.active) {
      // 멈춘 자리 교체의 나가는 메인 턴이 아직 남았으면 메인 일시정지를 풀지 않는다 — 곧 다시 멈춰 '다시 시작' 알림이 참이 아니게 된다 (리드 결정 S4-27)
      if (!this.core.seat.keepsMainHold()) this.releaseMainPause(by);
      // 나가는 메인 턴의 종료를 확인하지 못해 멈춘 자리 교체도 정지 해제가 이어 간다 (CTL-11, SERVER_DESIGN 4.3 2번)
      this.core.seat.continueAfterRelease();
      return;
    }
    const held = ctx.store.tasks.list({ state: 'on_hold' }).filter((t) => t.hold.reasons.some((r) => r.kind === 'emergency_stop'));
    const stoppedSince = s.global.since;
    ctx.store.tx(() => {
      s.global = { active: false, since: null, by: null, releasedAt: ctx.now() };
      ctx.saveStop(s);
      if (held.length) {
        enqueue(ctx, {
          kind: 'stop_released',
          memberId: MAIN_AGENT_ID,
          sessionKey: mainKey(null),
          projectId: null,
          priority: 'high',
          message: this.releasedList(held),
          dedupeKind: true,
        });
      }
    });
    const n = held.length;
    ctx.activity({ kind: 'resume', actor: by, text: `긴급 정지 해제 — 보류 ${n}건은 메인 에이전트가 항목별로 재개${n ? ' (메인 에이전트에게 보류 목록 전달)' : ''}` });
    this.core.journal.server('stop', `${by === OWNER ? '대표가 ' : ''}긴급 정지를 해제함 — 보류된 작업 ${n}건은 메인 에이전트가 확인해 항목별로 재개${n ? '(정지 해제 업무로 전달)' : ''}`, {
      refs: held.slice(0, 10).map((t) => ({ kind: 'task' as const, id: t.id })),
    });
    ctx.notify({ level: 'info', title: '긴급 정지 해제', body: `새 실행을 시작할 수 있습니다. 보류된 작업 ${n}건은 메인 에이전트가 확인해 항목별로 재개합니다`, link: { tab: 'settings', section: 'policy' } });
    // 정지한 동안은 메인 자리 보유자의 응답 없음을 세지 않는다 — 그 때를 정지한 시간만큼 뒤로 민다 (SERVER_DESIGN 4.4, 리드 결정 S4-5)
    this.core.seat.afterStopRelease(stoppedSince, s.global.releasedAt ?? ctx.now());
    // 긴급 정지는 풀어도, 멈춘 자리 교체의 나가는 메인 턴이 아직 남았으면 메인 일시정지는 그대로 둔다 (리드 결정 S4-27)
    if (!this.core.seat.keepsMainHold()) this.releaseMainPause(by);
    this.core.seat.continueAfterRelease();
    ctx.bus.signal('tick');
  }

  /**
   * 메인 에이전트(M-MAIN)의 일시정지를 푼다 — 대표의 정지 해제가 함께 한다 (release). 누가 걸었든 푼다. 풀 것이 없으면 아무것도 하지 않는다.
   * 남은 프로세스는 다시 확인하지 않는다 — 종료 확인 실패 알림이 대표에게 남은 프로세스가 사라졌는지 확인한 뒤 누르라고 안내한다 (turns.unconfirmedNote).
   * 팀원 재개와 같은 길(resumeMember: 정지 값 지우기·그 정지로 보류된 작업 풀기·메인이 검수하던 작업의 검수 다시 넘기기)에, 기록·알림을 더한다
   */
  private releaseMainPause(by: Actor): void {
    const ctx = this.ctx;
    const p = ctx.stop().members[MAIN_AGENT_ID];
    if (!p) return;
    const why = p.reason ?? `${memberName(ctx, p.by)}의 일시정지`;
    this.resumeMember(MAIN_AGENT_ID, by);
    ctx.activity({ kind: 'resume', actor: by, memberId: MAIN_AGENT_ID, text: `정지 해제로 메인 에이전트 일시정지를 풂 — ${why}` });
    ctx.notify({
      level: 'info',
      title: '메인 에이전트 다시 시작',
      body: `정지 해제로 메인 에이전트의 일시정지(${why})를 풀었습니다. 쌓인 명령을 이어서 처리합니다`,
      link: null,
      key: 'main-paused',
    });
  }

  /**
   * 정지 해제 업무의 보류 목록 — 작업마다 프로젝트·담당·정지 전 상태·다른 보류 사유 (메인이 항목별로 판단한다). 다른 보류는 resume_task가 함께 푸는 것
   * (isOwnerResumable — 중단·오류·병합 보류·작업 일시정지)과 풀지 않는 것을 나눠 적는다 — 목록대로 재개했는데 다른 것이 돌면 안 된다 (리드 결정 12, CTL-10)
   */
  private releasedList(held: Task[]): string {
    const ctx = this.ctx;
    const labels = (rs: HoldReason[]) => [...new Set(rs.map((r) => HOLD_REASON_LABEL[r.kind]))].join('·');
    const lines = held.map((t) => {
      const project = ctx.store.projects.get(t.projectId)?.name ?? t.projectId;
      const before = t.hold.returnState ? TASK_STATE_LABEL[t.hold.returnState] : '-';
      const others = t.hold.reasons.filter((r) => r.kind !== 'emergency_stop');
      const together = others.filter(isOwnerResumable);
      const stay = others.filter((r) => !isOwnerResumable(r));
      return [
        `- ${t.id} "${t.title}" — ${project}(${t.projectId}), 담당 ${memberName(ctx, t.assigneeId)}, 정지 전 상태 ${before}`,
        together.length ? `, 재개하면 함께 풀림: ${labels(together)}` : '',
        stay.length ? `, 다른 보류: ${labels(stay)} (재개해도 그 사유가 풀릴 때까지 실행되지 않음)` : '',
      ].join('');
    });
    return [
      `대표가 긴급 정지를 해제했습니다. 긴급 정지로 보류된 작업 ${held.length}건은 저절로 재개되지 않습니다 (CTL-10).`,
      '항목마다 상태를 확인하고, 이어 가도 되는 것만 resume_task(task_id, reason)로 재개하세요. 그대로 두거나 취소(cancel_task)할 것은 그 까닭을 마지막 메시지로 대표에게 알리세요.',
      ...lines,
    ].join('\n');
  }

  /** reason: 프로그램이 건 정지의 까닭 (대표에게 보이는 글). 대표 정지는 비워 둔다 */
  async pauseProject(projectId: string, mode: StopMode, by: Actor, reason?: string): Promise<void> {
    const ctx = this.ctx;
    const p = projectOrThrow(ctx, projectId);
    const s = ctx.stop();
    s.projects[projectId] = { paused: true, mode, since: ctx.now(), by, ...(reason ? { reason } : {}) };
    ctx.saveStop(s);
    for (const t of ctx.store.tasks.list({ project_id: projectId, state: ['waiting', 'in_progress', 'in_review', 'on_hold'] })) {
      if (t.hold.reasons.some((r) => r.kind === 'paused' && r.scope === 'project')) continue;
      transitionTask(ctx, t.id, { type: 'hold', reason: this.core.tasks.reason('paused', 'project', '프로젝트 일시정지', by, projectId) }, by);
    }
    const members = new Set(ctx.store.members.list({ project_id: projectId }).map((m) => m.id));
    // 그 프로젝트 팀원의 턴, 그리고 그 프로젝트 작업을 검수하는 메인 에이전트의 검수 턴(review:T — 메인은 프로젝트 소속이 없다, REV-06 v0.6)
    const onProject = (l: { memberId: string; sessionKey: string }): boolean => {
      if (members.has(l.memberId)) return true;
      const { kind, ref } = parseKey(l.sessionKey);
      return (kind === 'task' || kind === 'review') && ctx.store.tasks.get(ref)?.projectId === projectId;
    };
    if (mode === 'immediate') {
      await Promise.all([this.core.turns.stopWhere(onProject, '프로젝트 일시정지(즉시)', true), this.core.checks.terminateFor((id) => ctx.store.tasks.get(id)?.projectId === projectId)]);
    } else {
      this.core.turns.requestGraceful(onProject, '프로젝트 일시정지');
    }
    ctx.activity({ kind: 'stop', actor: by, projectId, text: `프로젝트 ${p.name} 일시정지 (${mode === 'immediate' ? '즉시' : '단계 마치고'})${reason ? ` — ${reason}` : ''}` });
  }

  resumeProject(projectId: string, by: Actor): void {
    const ctx = this.ctx;
    const p = projectOrThrow(ctx, projectId);
    const s = ctx.stop();
    if (!s.projects[projectId]) return;
    delete s.projects[projectId];
    ctx.saveStop(s);
    this.releaseScope((r) => r.kind === 'paused' && r.scope === 'project' && r.refId === projectId, `프로젝트 ${p.name} 재개`, by, projectId);
    ctx.activity({ kind: 'resume', actor: by, projectId, text: `프로젝트 ${p.name} 재개` });
    ctx.bus.signal('tick');
  }

  /** reason: 프로그램이 건 정지의 까닭 (대표에게 보이는 글, 예: 프로세스 종료를 확인하지 못함). 대표 정지는 비워 둔다 */
  async pauseMember(memberId: string, mode: StopMode, by: Actor, reason?: string): Promise<void> {
    const ctx = this.ctx;
    const m = memberOrThrow(ctx, memberId);
    const s = ctx.stop();
    s.members[memberId] = { paused: true, mode, since: ctx.now(), by, ...(reason ? { reason } : {}) };
    ctx.saveStop(s);
    for (const t of this.core.tasks.openTasks(memberId)) {
      if (t.hold.reasons.some((r) => r.kind === 'paused' && r.scope === 'member' && r.refId === memberId)) continue;
      transitionTask(ctx, t.id, { type: 'hold', reason: this.core.tasks.reason('paused', 'member', `${m.name} 일시정지`, by, memberId) }, by);
    }
    if (mode === 'immediate') {
      // 즉시 정지는 이 팀원이 맡은 작업의 자동 검사 프로세스도 끝낸다 — 프로젝트 즉시 정지와 같게 (CTL-07)
      await Promise.all([
        this.core.turns.stopWhere((l) => l.memberId === memberId, '팀원 일시정지(즉시)', true),
        this.core.checks.terminateFor((id) => ctx.store.tasks.get(id)?.assigneeId === memberId),
      ]);
    } else this.core.turns.requestGraceful((l) => l.memberId === memberId, '팀원 일시정지');
    ctx.activity({ kind: 'stop', actor: by, projectId: m.projectId, memberId, text: `${m.name} 일시정지 (${mode === 'immediate' ? '즉시' : '단계 마치고'})${reason ? ` — ${reason}` : ''}` });
  }

  resumeMember(memberId: string, by: Actor): void {
    const ctx = this.ctx;
    const m = memberOrThrow(ctx, memberId);
    const s = ctx.stop();
    if (!s.members[memberId]) return;
    delete s.members[memberId];
    ctx.saveStop(s);
    this.releaseScope((r) => r.kind === 'paused' && r.scope === 'member' && r.refId === memberId, `${m.name} 재개`, by, m.projectId);
    // 이 팀원이 검수하던 남의 작업은 검수자 정지로 보류되지 않아 afterRelease가 돌지 않는다 → 끊긴 검수·병합 판단을 다시 넘긴다 (F5, 중복 묶기로 멱등)
    for (const t of ctx.store.tasks.list({ state: 'in_review' })) if (t.reviewerId === memberId) this.core.tasks.redispatchReview(t);
    ctx.activity({ kind: 'resume', actor: by, projectId: m.projectId, memberId, text: `${m.name} 재개` });
    ctx.bus.signal('tick');
  }

  private releaseScope(match: (r: HoldReason) => boolean, note: string, by: Actor, projectId: string | null): void {
    const ctx = this.ctx;
    const list = ctx.store.tasks.list(projectId ? { project_id: projectId, state: 'on_hold' } : { state: 'on_hold' });
    for (const t of list) {
      if (!t.hold.reasons.some(match)) continue;
      const nt = transitionTask(ctx, t.id, { type: 'release', match, note }, by);
      if (nt.state !== 'on_hold') this.core.tasks.afterRelease(nt, note);
    }
  }

  assertNotEmergency(): void {
    if (this.ctx.stop().global.active) throw new BackendError('stopped', '긴급 정지 중입니다');
  }
}
