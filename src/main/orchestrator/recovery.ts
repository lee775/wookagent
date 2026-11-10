/**
 * 재시작 복구 (8장 앱·PC 재시작, ERR-06·08, GIT-15, AC-14·16·44·45).
 * 순서: 정지 상태(이미 DB) → 이전 턴 프로세스 확인(PID 주인 대조)·종료 → 'started' 실행 기록 대조 → 남은 작업 폴더 정리·끊긴 취소 마무리
 * → 재개 가능한 것만 대기열 복원 → 관리 업무를 저장된 상태로 다시 맞춤 → 요약 알림 1회.
 * 실행 여부가 불명확한 비멱등 작업은 자동 재실행하지 않고 복구 확인으로 보류한다.
 */
import { existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import type { Actor, ExecRecord, QueueEntry, Task, Turn } from '@shared/domain';
import { MAIN_AGENT_ID, OWNER } from '@shared/domain';
import { CANCEL_HOLD_REF, hasHold, isTerminal } from '@core/taskMachine';
import { isDirectiveOpen } from '@core/directiveMachine';
import { BackendError } from '../backend/types';
import type { RecoveryItemView } from '@shared/views';
import { unconfirmedEnvProblem } from '../process/types';
import type { Core } from './core';
import { directiveKey, isUrgentDirect, mainKey, markMessagesDelivered, newestEntry, noteMessagesUndelivered, reviewKey, taskKey, transitionTask } from './records';
import { closedDirectiveWork, memberName, producerOf, projectOrThrow, taskOrThrow } from './lookups';
import { alertMain, hostExecCutText, OWNER_HANDED, ownerExit, recoveryProjectOf, recoveryText, sweepAlerts } from './alerts';
import { deadWorkReason, dropDeadWork, isReviewHandOff, mergeNudgeTasks, RESTART_CUT_LIMIT, restartDropped, reviewHandedOff } from './turns';

/** PID 주인 대조의 시각 여유 (생성 시각 절삭·작은 시계 보정) */
const PID_TIME_SLACK_MS = 1000;

/** PID 주인 대조의 대상 — 이전 실행의 턴과 서버 명령(host_exec 실행 기록, 리드 결정 S5-18) */
type ProcessOwner = { id: string; process: Pick<Turn['process'], 'pid'> & { spawnedAt?: string | null } };

export class RecoveryService {
  constructor(private readonly core: Core) {}

  private get ctx() {
    return this.core.ctx;
  }

  async run(): Promise<{ resumed: number; held: number; killed: number }> {
    const ctx = this.ctx;
    let killed = 0;
    let resumed = 0;
    let held = 0;

    // 1) 이전 실행의 턴: 프로세스 생존 확인 → 그 턴이 띄운 바로 그 프로세스일 때만 종료 (재연결 불가).
    //    PID는 재사용되므로(재부팅·오래 지난 재시작) 생성 시각을 기록한 시작 시각과 대조하고, 확인하지 못하면 건드리지 않는다 (windows:F2, ERR-08)
    const running = ctx.store.turns.list({ state: 'running' });
    const owners = await this.previousProcesses(running);
    let unverified = 0;
    let unconfirmedKills = 0;
    for (const t of running) {
      let detail = '앱 재시작으로 끊김';
      const pid = t.process.pid;
      const owner = owners.get(t.id);
      /** 이 턴의 프로세스 트리를 끊었지만 종료를 확인하지 못함 (남은 수, -1 = 확인 불가) — CTL-11로 그 실행을 막는다 */
      let unconfirmed: { remaining: number; why: string } | null = null;
      if (pid && owner) {
        if (owner.kind === 'ours') {
          try {
            const r = await ctx.deps.runner.killTree(pid);
            if (r.ok) killed++;
            else unconfirmed = { remaining: r.remaining, why: r.detail };
            detail += r.ok ? ' — 남은 프로세스 종료 확인' : ` — 종료 확인 실패: ${r.detail}`;
          } catch (e) {
            unconfirmed = { remaining: -1, why: e instanceof Error ? e.message : String(e) };
            detail += ` — 종료 확인 실패: ${unconfirmed.why}`;
          }
        } else if (owner.kind === 'other') {
          detail += ` — PID ${pid}는 다른 프로세스가 쓰고 있어 건드리지 않음`;
        } else if (owner.kind === 'unknown') {
          unverified++;
          detail += ` — PID ${pid}가 이 턴의 프로세스인지 확인하지 못해 건드리지 않음 (${owner.why})`;
        }
      }
      // 턴 마감·세션 턴 수·그 턴에 실은 항목·메시지 전달 기록은 한 트랜잭션으로 맞춘다 — 그 사이에서 끊기면 턴이 아직 실행 중으로 남아 다음 재시작이
      // 이 턴을 처음부터 다시 맞춘다 (마감만 남고 항목이 실행 중으로 남거나, 전달 기록만 지워진 채 항목이 남지 않게)
      ctx.store.tx(() => {
        ctx.store.turns.put({
          ...t,
          endedAt: ctx.now(),
          endReason: 'app_restart',
          endDetail: detail,
          process: { ...t.process, state: unconfirmed ? 'kill_failed' : 'exited', ...(unconfirmed ? { killDetail: unconfirmed.why } : {}) },
        });
        this.settleCutTurnEntries(t);
      });
      if (unconfirmed) {
        // 종료를 확인하지 못한 이전 실행에 새 프로세스를 겹쳐 띄우지 않는다 (CTL-11) — 턴 종료 때와 같게 작업 보류·팀원 일시정지 + 긴급 알림
        unconfirmedKills++;
        await this.core.turns.blockUnconfirmedRun(
          {
            label: `${ctx.store.members.get(t.memberId)?.name ?? t.memberId} 이전 턴 ${t.id}`,
            sessionKind: t.sessionKind,
            sessionKey: ctx.store.sessions.get(t.sessionId)?.workKey ?? t.sessionId,
            memberId: t.memberId,
            projectId: t.projectId,
            taskId: t.taskId,
            turnId: t.id,
          },
          { envProblem: unconfirmedEnvProblem(ctx.deps.runner), remaining: unconfirmed.remaining, cause: unconfirmed.why, what: '이전 실행' },
        );
      }
      // 메인 에이전트의 턴은 팀원 프로젝트가 없어 그 턴의 작업 키 프로젝트로 남긴다 (SERVER_DESIGN 5.4, 리드 결정 S5-5 — 5단계 전 기록은 없다)
      ctx.activity({ kind: 'system', level: 'warn', projectId: t.projectId ?? t.workProjectId ?? null, memberId: t.memberId, turnId: t.id, text: `재시작 복구: 턴 ${t.id} ${detail}` });
    }

    // 2) 시작만 기록된 외부 실행·git 작업 대조
    for (const e of ctx.store.execs.list({ state: 'started' })) {
      try {
        held += await this.reconcileExec(e);
      } catch (err) {
        this.markExec(e, 'unknown', { recoveryError: err instanceof Error ? err.message : String(err) });
        held += this.holdForRecovery(e, `실행 결과 확인 실패: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // 2-0) 병합은 기록됐지만 끝나지 않은 작업: 체크아웃된 프로젝트 폴더가 그 병합보다 뒤처져 있으면 맞춘다 (GIT-15, 7.1 병합 기록).
    //      병합 기록과 폴더 맞춤 사이(또는 맞추는 중)에 끊긴 경우다. 보류 중인 작업도 — 맞추지 않으면 뒤 작업의 병합이 막힌다.
    //      다음 병합(스케줄러 시작 뒤)보다 먼저 끝나고, 폴더가 이미 맞으면 아무것도 하지 않는다
    for (const t of ctx.store.tasks.list({ state: ['in_review', 'on_hold'] })) {
      if (t.outputMode !== 'repo' || !t.merge) continue;
      await this.core.merges.syncRecordedMerge(t.id).catch((err: unknown) => ctx.log('warn', `재시작 후 프로젝트 폴더 맞춤 실패 ${t.id}`, err));
    }

    // 2-1) 끝난 작업의 남은 작업 폴더·검수 사본 정리 (정리 때 다른 프로그램이 잡고 있던 폴더 등, 멱등)
    const copies = new Map<string, Set<string>>();
    const leftCopies = (projectId: string, taskId: string): boolean => {
      let s = copies.get(projectId);
      if (!s) {
        let names: string[] = [];
        try {
          names = readdirSync(join(ctx.paths.review, projectId));
        } catch {
          // 검수 사본 폴더가 없으면 남은 것도 없다
        }
        s = new Set(names.map((n) => n.replace(/-r\d+-.*$/, '')));
        copies.set(projectId, s);
      }
      return s.has(taskId);
    };
    for (const t of ctx.store.tasks.list({ state: ['cancelled', 'done'] })) {
      if ((t.workspace && existsSync(t.workspace.worktreePath)) || leftCopies(t.projectId, t.id)) await this.core.tasks.cleanupWorkspace(t);
    }

    // 2-2) 취소 처리 중에 끊긴 작업 → 대표·프로듀서가 고른 취소를 마저 한다 (CTL-08: 선택은 재시작으로 풀리지 않음).
    //      실행 중 턴이 없으므로 git 정리만 남아 있다 — 같은 저장소의 git 작업이 겹치지 않게 차례로.
    //      그 취소가 병합과 겹쳐 main에 병합이 반영된 작업은 취소하지 않는다: 남은 취소 보류만 풀려 다시 병합하지 않고 완료된다(다른 보류가 남으면
    //      그 해제 때) — 거부는 예상한 결과다 (tasks.cancel, AC-46 완료 결과 유지)
    for (const t of ctx.store.tasks.list({ state: 'on_hold' })) {
      const r = t.hold.reasons.find((x) => x.kind === 'interrupted' && x.refId === CANCEL_HOLD_REF);
      if (!r) continue;
      const why = r.note.replace(/^취소 처리 중: /, '') || '재시작 후 취소 마무리';
      try {
        await this.core.tasks.cancel(t.id, why, r.by);
      } catch (e) {
        if (t.merge) ctx.log('info', `재시작 후 취소 마무리: ${t.id}은(는) main에 병합이 반영돼 취소하지 않음 (취소 보류만 풀어 완료 결과로)`);
        else ctx.log('warn', `재시작 후 취소 마무리 실패 ${t.id}`, e);
      }
    }
    // 2-2b) main에 병합이 반영됐는데 '선행 작업 취소' 보류가 남은 작업 (그 보류를 더하던 이전 기록): 병합이 반영된 작업은 선행 작업이 필요 없는 완료
    //       결과다 — 그 보류를 풀어 다시 병합하지 않고 완료로 수렴시킨다. 다른 보류가 남으면 그 해제 때 완료된다 (5.3, AC-46, S7-B1)
    for (const t of ctx.store.tasks.list({ state: 'on_hold' })) {
      if (t.merge && t.hold.reasons.some((r) => r.kind === 'prereq_cancelled')) this.core.tasks.releaseSettledHoldsOfMerged(t.id);
    }

    // 2-3) 지시 취소 중에 끊긴 지시 → 남은 미완료 작업을 마저 취소한다 (CTL-08, TSK-09, AC-46). 지시는 취소 선택을 먼저 저장하므로
    //      취소 상태인데 미완료 작업이 남았으면 끊긴 것이다. 아래 3)이 그 작업들을 일반 작업으로 다시 넣지 않게 먼저 한다
    for (const d of ctx.store.directives.list({ state: 'cancelled' })) {
      if (!this.core.tasks.directiveCancelTargets(d.id).length) continue;
      const by = [...ctx.store.transitions.list(d.id)].reverse().find((x) => x.event === 'cancel')?.actor ?? OWNER;
      try {
        await this.core.directives.cancel(d.id, by);
      } catch (e) {
        ctx.log('warn', `재시작 후 지시 취소 마무리 실패 ${d.id}`, e);
      }
    }

    // 2-4) 되돌리기 작업의 끊긴 프로그램 단계 (작업 폴더 → 되돌리기 커밋 기록, GIT-15·CLI-09): 작업 폴더 HEAD가 이미 되돌리기 커밋이면
    //      기록만 하고, 아니면 같은 프로젝트 잠금 안에서 다시 되돌린다. 일반 작업으로 담당에게 넘기지 않는다 (AC-12) — 3)보다 먼저
    //      취소 선택이 저장된 지시의 되돌리기(취소 전부터 있던 것)는 이어 가지 않는다 — 2-3)이 취소한다 (AC-46, S7-B6)
    for (const t of ctx.store.tasks.list({ state: ['waiting', 'in_progress'] })) {
      if (!this.core.merges.revertPending(t) || !this.core.stops.runAllowedForTask(t) || closedDirectiveWork(ctx, null, t)) continue;
      await this.core.merges.resumeRevert(t.id);
      resumed++;
    }

    // 2-5) 안전망: 검수 중인데 할 일이 아무것도 없는 작업은 잃은 업무를 다시 만든다 (리드 결정 18 — 시작 때만). 3)보다 먼저 해 활동 기록이 남게 한다
    resumed += this.rebuildLostReviewWork();

    // 3) 재개 가능한 작업만 대기열 복원 (정지·보류 작업은 그대로)
    for (const t of ctx.store.tasks.list({ state: ['in_progress', 'in_review'] })) {
      if (!this.core.stops.runAllowedForTask(t)) continue;
      // 되돌리기 커밋을 기록하지 못한 되돌리기 작업은 2-4)·스케줄러가 프로그램 단계로 이어 간다 ('이어서 진행' 작업으로 넘기지 않음)
      if (this.core.merges.revertPending(t)) continue;
      // 기다리는 메시지(대표 직접 메시지·팀원 메시지 — 끊긴 턴에서 되돌린 것 포함)만 있으면 '이어서 진행' 안내도 넣는다 — 대표 메시지는 그 안내 앞에
      // 우선 전달된다 (ERR-08: 확인된 결과와 미확정 항목 구분)
      const queuedTask = ctx.store.queue.list({ ref2: taskKey(t.id), state: 'queued' }).some((q) => q.kind !== 'message');
      if (t.state === 'in_progress') {
        if (t.pendingSubmit) {
          void this.core.tasks.processSubmission(t.id);
          resumed++;
        } else if (!queuedTask) {
          // 끊긴 일의 재시작 횟수를 이어 간다 — 상한에 닿은 작업은 1)이 보류해 여기 오지 않는다 (리드 결정 44)
          this.core.tasks.continueWork(t.id, '앱이 다시 시작되어 이어서 진행합니다. get_work_context로 상태와 마지막 커밋을 확인하세요. (확인된 결과와 미확정 항목을 구분하세요)', 'task_work', 0, this.carriedRestarts(t.id));
          resumed++;
        }
      } else if (!t.review.passed) {
        // 검수가 이미 넘어간 작업(메인 에이전트의 멈춘 검수 넘김, 프로듀서의 검수자 재배정 — 합쳐 둔 옛 항목은 글의 작업 ID도)은 검수를 다시 등록하지
        // 않는다 — 재시작마다 판정 없이 끝나는 검수 한 바퀴를 더 돌리지 않게. 넘긴 업무가 처리한다 (리드 결정 24)
        if (reviewHandedOff(ctx, t.id)) continue;
        // 그 검수 일(넘김·검수)을 재시작 상한에서 버렸으면 다시 등록하지 않는다 — 버림 알림이 그 일의 업무다 (리드 결정 44)
        if (this.reviewWorkRestartDropped(t)) continue;
        // 지금 검수자 앞으로 된, 지금 버전(또는 버전에 묶이지 않은) 항목만 센다 — 이전·삭제된 검수자 몫이나 이전 버전 항목은 dispatchReview가
        // 정리하고 다시 등록한다 (CONC-11, REV-07·08)
        const pin = t.review.target?.pinnedAt;
        const queuedReview = ctx.store.queue
          .list({ ref2: reviewKey(t.id), state: 'queued' })
          .some((q) => q.memberId === t.reviewerId && (!q.reviewPinnedAt || q.reviewPinnedAt === pin));
        if (!queuedReview) {
          this.core.tasks.dispatchReview(t);
          resumed++;
        }
      } else if (t.outputMode === 'repo' && t.merge) {
        // main 반영은 기록됐는데 완료 전에 끊김 → 다시 병합하지 않고 마무리 (GIT-15)
        void this.core.merges.finishMerged(t.id, null);
        resumed++;
      } else if (t.outputMode === 'repo') {
        // 병합 판단을 재시작 상한에서 버렸거나 그 작업을 적은 프로듀서의 병합 재촉이 기다리면 다시 넣지 않는다 (리드 결정 44·48)
        if (!this.skipMergeDecision(t)) this.core.merges.queueMergeDecision(t);
      } else if (t.outputMode === 'artifact') {
        this.core.merges.finalizeArtifactOrHold(t.id);
      }
    }

    // 4) 소비됐거나 재시도가 끝나 사라진 관리 업무를 저장된 상태로 다시 맞춘다
    this.reconcileManagement();

    const onHold = ctx.store.tasks.list({ state: 'on_hold' }).length;
    if (killed || resumed || held || onHold || unverified || unconfirmedKills) {
      ctx.notify({
        level: 'info',
        title: '재시작 복구',
        body: `재개 ${resumed}건 · 보류 유지 ${onHold}건${held ? ` (복구 확인 ${held}건)` : ''}${killed ? ` · 남은 프로세스 ${killed}개 종료` : ''}${
          unconfirmedKills ? ` · 이전 프로세스 ${unconfirmedKills}개는 끊었지만 하위 프로세스 종료를 확인하지 못해 그 일을 멈춤 (긴급 알림 참고)` : ''
        }${unverified ? ` · 이전 프로세스 ${unverified}개는 같은 프로세스인지 확인하지 못해 그대로 둠 (활동 기록 참고)` : ''}`,
        link: { tab: 'settings', section: 'policy' },
      });
    }
    return { resumed, held, killed };
  }

  /**
   * 이전 실행 턴의 PID가 지금 누구 것인지 (windows:F2). 살아 있는 PID의 생성 시각이 그 턴이 기록한 시작 시각(spawn 직후, OS 시계)보다
   * 늦지 않을 때만 그 턴의 프로세스로 본다 — 1초 여유는 시각 단위 절삭·작은 시계 보정 몫.
   * 시작 시각 기록이 없거나(이전 기록) 생성 시각을 읽지 못하면 '모름'으로 두고 종료하지 않는다 (남의 프로세스 트리를 끊지 않는 쪽으로)
   */
  private async previousProcesses(turns: readonly ProcessOwner[]): Promise<Map<string, { kind: 'gone' | 'ours' | 'other' } | { kind: 'unknown'; why: string }>> {
    const runner = this.ctx.deps.runner;
    const out = new Map<string, { kind: 'gone' | 'ours' | 'other' } | { kind: 'unknown'; why: string }>();
    const alive: { turn: ProcessOwner; pid: number; spawnedMs: number | null }[] = [];
    for (const t of turns) {
      const pid = t.process.pid;
      if (!pid) continue;
      try {
        if (!(await runner.isAlive(pid))) {
          out.set(t.id, { kind: 'gone' });
          continue;
        }
      } catch (e) {
        out.set(t.id, { kind: 'unknown', why: `생존 확인 실패: ${e instanceof Error ? e.message : String(e)}` });
        continue;
      }
      const spawnedMs = t.process.spawnedAt ? Date.parse(t.process.spawnedAt) : NaN;
      alive.push({ turn: t, pid, spawnedMs: Number.isFinite(spawnedMs) ? spawnedMs : null });
    }
    // 그 턴이 시작된 뒤 PC가 다시 켜졌으면 지금 그 PID는 다른 프로세스다 — 조회하지 않는다
    const bootMs = Date.now() - os.uptime() * 1000;
    const toQuery = alive.filter((a) => a.spawnedMs !== null && bootMs <= a.spawnedMs + PID_TIME_SLACK_MS);
    const created = toQuery.length ? await runner.processCreatedAt(toQuery.map((a) => a.pid)).catch(() => new Map<number, number>()) : new Map<number, number>();
    for (const a of alive) {
      if (a.spawnedMs === null) {
        out.set(a.turn.id, { kind: 'unknown', why: '시작 시각 기록이 없는 이전 기록' });
      } else if (bootMs > a.spawnedMs + PID_TIME_SLACK_MS) {
        out.set(a.turn.id, { kind: 'other' });
      } else {
        const at = created.get(a.pid);
        if (at === undefined) out.set(a.turn.id, { kind: 'unknown', why: '프로세스 생성 시각을 읽지 못함' });
        else out.set(a.turn.id, { kind: at <= a.spawnedMs + PID_TIME_SLACK_MS ? 'ours' : 'other' });
      }
    }
    return out;
  }

  /**
   * CLI를 띄운 뒤 끊긴 턴은 그 세션의 한 턴이다 — 턴 실행기의 마무리(finish)를 거치지 않았으므로 여기서 같은 기록을 남긴다.
   * 안 남기면 세션 첫 턴이 끊겼을 때 다음 턴이 첫 턴으로 보여, 이어할 수 있는 CLI 세션을 버리고 새 CLI 세션 ID로 덮어쓴다 (ERR-03: 이어하기 먼저).
   * 이어할 CLI 세션 ID가 없으면(세션을 알리기 전에 끊긴 Codex 등) 그 세션을 닫는다 → 다음 턴이 새 세션에서 인계 요약을 받는다 (ERR-03, MEM-11).
   * 다음 턴이 이 세션을 이어할 수 있으면 true — 이미 닫혀 있었거나 지금 닫으면 false (그 턴에 실은 메시지는 새 세션에 다시 넣는다)
   */
  private countCutTurn(t: Turn): boolean {
    const ctx = this.ctx;
    const s = ctx.store.sessions.get(t.sessionId);
    if (!s || s.closedAt) return false;
    const now = ctx.now();
    const counted = { ...s, turnCount: s.turnCount + 1, lastTurnAt: now };
    // 닫는 사유가 교체 사유다 — 다음 세션이 이 세션을 이전 세션으로, 이 사유를 교체 사유로 잇는다 (turns.resolveSession)
    ctx.store.sessions.put(s.cliSessionId ? counted : { ...counted, closedAt: now, replaceReason: '재시작: 이어할 CLI 세션 없음 → 새 세션 (ERR-03)' });
    return !!s.cliSessionId;
  }

  /**
   * 끊긴 턴이 실었던 대기 항목을 맞춘다 (재시작 순서 ②). CLI를 띄운 턴(PID 기록)은 그 세션의 한 턴으로 센다 — 그 세션을 다음 턴이 이어할 수 있는지(열려 있고
   * CLI 세션 ID가 있음)가 그 턴에 실은 메시지의 전달 여부다. 이어할 수 없는 턴(CLI를 띄우기 전에 끊겼거나, 이어할 CLI 세션 없이 끊겨 세션을 닫음)에 실은
   * 메시지(대표 직접 메시지·팀원 메시지)는 그 업무 세션에 전달되지 않았다 — 다음 턴(닫았으면 새 세션의 첫 턴)이 받도록 대기열로 되돌리고 전달 기록을
   * 지운다. '완료'로 두면 새 세션은 그 메시지를 모른 채 기록만 '전달됨'으로 남는다 (AC-36, CLI-10, ERR-03). 호출자가 턴 마감과 한 트랜잭션으로 부른다
   */
  private settleCutTurnEntries(t: Turn): void {
    const ctx = this.ctx;
    // 그 세션의 첫 CLI 턴이었는지 — 이 턴을 세기 전에 본다 (S7-B5)
    const before = ctx.store.sessions.get(t.sessionId);
    const firstTurn = !!t.process.pid && !!before && !before.closedAt && before.turnCount === 0;
    const resumable = t.process.pid ? this.countCutTurn(t) : false;
    const carried: QueueEntry[] = [];
    const again = new Set<string>();
    /** 재시작으로 끊긴 횟수의 상한에 닿아 다시 넣지 않는 항목 (리드 결정 39) */
    const cutOut: QueueEntry[] = [];
    /** 재시작으로 끊긴 횟수의 상한에 닿아 이어서 진행하지 않고 보류할 작업 (작업 세션, 리드 결정 44) */
    let heldTask: string | null = null;
    for (const id of t.queueEntryIds) {
      const q = ctx.store.queue.get(id);
      if (!q || q.state !== 'running') continue;
      carried.push(q);
      // 세션의 첫 턴이 끊겼으면 이어할 수 있는 세션이어도 CLI가 대화 기록을 쓰기 전에 끊겼을 수 있다 (Claude는 세션 ID를 띄울 때 정한다) — 그러면
      // 다음 이어하기가 실패해 새 세션이 열리고, 그 인계 요약에는 대표 직접 메시지만 실린다. 팀원 메시지(send_message·instruct_member)는 다시 넣고
      // 전달 기록을 지운다: 이어하기가 되면 '(다시 전달)'로 한 번 더 받지만, 조용히 잃는 것보다 낫다. 대표 직접 메시지는 그대로 전달됨 — 인계 요약이
      // 넘긴다 (AC-36-obs, CLI-10, ERR-03, S6-C5·S7-B5)
      const agentAgain = resumable && firstTurn && !!q.messageId && !isUrgentDirect(q);
      if (agentAgain) again.add(q.id);
      // 대상이 이미 끝난 업무(대표가 그대로 승인해 거둬들인 수정 요청, 대상이 풀린 남는 업무 등)는 되살리지 않는다 — 다시 넣기·스케줄러와 같은 판정
      // (리드 결정 19·31)
      const ended = deadWorkReason(ctx, q, (taskId) => this.core.tasks.reviewPending(taskId));
      if (ended) {
        dropDeadWork(ctx, q, `재시작 복구: ${ended}`);
        continue;
      }
      const redeliver = (!resumable && (!!q.messageId || isUrgentDirect(q))) || agentAgain;
      if (redeliver && q.messageId) {
        const m = ctx.store.messages.get(q.messageId);
        if (m?.deliveredAt) ctx.store.messages.put({ ...m, deliveredAt: null });
      }
      // 작업 세션의 다른 일은 아래 3)이 '이어서 진행'으로 다시 넣는다. 재시작으로 끊긴 횟수는 이 항목에 남기고 그 '이어서 진행'이 이어 간다 — 새 항목이
      // 0부터 세면 그 작업의 턴이 앱째 끝낼 때 재시작마다 끝없이 이어서 진행했다. RESTART_CUT_LIMIT번째면 이어서 진행하지 않고 작업을 보류한다(아래)
      // (리드 결정 44). 다른 일과 같게 상한의 항목은 취소로 둔다 — 재시작 상한의 버림 모양(turns.isRestartLimitDrop)
      if (q.sessionKey.startsWith('task:') && !redeliver) {
        const restarts = (q.restarts ?? 0) + 1;
        if (restarts >= RESTART_CUT_LIMIT) {
          ctx.store.queue.put({ ...q, state: 'cancelled', restarts, doneAt: ctx.now() });
          heldTask = q.taskId ?? q.sessionKey.slice('task:'.length);
        } else ctx.store.queue.put({ ...q, state: 'done', restarts, doneAt: ctx.now() });
      }
      // 다른 버전(이제 고정돼 있지 않은 버전)의 검수 업무는 되돌리지 않는다 — 기준 변경·재배정으로 그 버전 검수가 끝났는데 되살리면 다음 버전 검수
      // 요청에 이전 사본 위치·완료 조건이 섞인다 (REV-07·08). 지금 버전 검수는 3)이 다시 등록한다
      else if (this.staleReviewEntry(q)) {
        ctx.store.queue.put({ ...q, state: 'cancelled', doneAt: ctx.now() });
        noteMessagesUndelivered(ctx, [q], '이전 버전의 검수 업무 (재시작 복구)');
      } else {
        const message = agentAgain && !q.message.startsWith('(다시 전달') ? `(다시 전달 — 재시작 전에 끊긴 세션 첫 턴에 실렸던 메시지입니다. 이미 받아 처리했으면 다시 처리하지 마세요) ${q.message}` : q.message;
        // 재시작으로 끊긴 것은 비정상 종료형 끝이 아니다 — attempts(비정상 종료 상한)를 올리지 않는다 (리드 결정 30). 재시작으로 끊긴 횟수는 따로 센다: 그
        // 업무의 턴이 앱째 끝내면 재시작마다 다시 넣어 끝없이 돌므로, RESTART_CUT_LIMIT번째로 끊기면 다시 넣지 않고 버린 뒤 알린다 (리드 결정 39). 턴 마감과
        // 한 트랜잭션이라 같은 끊김을 두 번 세지 않는다
        const restarts = (q.restarts ?? 0) + 1;
        if (restarts >= RESTART_CUT_LIMIT) {
          ctx.store.queue.put({ ...q, state: 'cancelled', turnId: null, restarts, doneAt: ctx.now() });
          cutOut.push({ ...q, restarts });
        } else ctx.store.queue.put({ ...q, state: 'queued', turnId: null, restarts, message });
      }
    }
    // 이어할 CLI 세션에 넘긴 메시지는 전달됐다 (띄운 직후 기록하기 전에 끊겼으면 여기서 맞춘다). 이어할 수 없으면 위에서 되돌린 항목을 실은 턴이 적는다
    if (resumable) markMessagesDelivered(ctx, carried.filter((q) => !again.has(q.id)));
    // 재시작 상한에 닿아 버린 항목을 알리고 이어 갈 쪽을 정한다 — 전달 기록을 맞춘 뒤에(전달되지 않은 메시지만 '전달 못 함'으로) (리드 결정 36·39)
    if (cutOut.length) this.core.turns.restartLimitReached(t, cutOut);
    // 작업 세션이 상한에 닿았다 — 작업 턴의 비정상 종료 상한처럼 보류·'자동 복구 실패'. 보류라 3)이 이어서 진행하지 않는다 (리드 결정 44)
    const task = heldTask ? ctx.store.tasks.get(heldTask) : null;
    if (task) this.core.turns.restartLimitHold(t, task);
  }

  /**
   * 작업 세션의 '이어서 진행'(재시작 3))이 이어 갈 재시작으로 끊긴 횟수 — 그 작업 세션의 가장 최근 일(메시지 빼고)의 restarts (리드 결정 44). 끊긴 턴의 일은
   * settleCutTurnEntries가 +1 해 둔다. 정상 경로로 새로 넣은 일(다음 단계·재작업·재개)은 0이라 그 뒤로는 다시 센다
   */
  private carriedRestarts(taskId: string): number {
    return newestEntry(this.ctx.store.queue.list({ ref2: taskKey(taskId) }).filter((q) => q.kind !== 'message'))?.restarts ?? 0;
  }

  /**
   * 그 작업의 검수 일(멈춘 검수 넘김·검수 업무)의 가장 최근 항목이 재시작 상한에서 버린 것인지 (리드 결정 44) — 그러면 시작 때 검수를 다시 등록하지 않는다
   * (안전망 2-5)·재시작 3)). 버림 알림(넘김이면 '메인 에이전트 처리 지연'도)이 그 일의 업무다. 같은 시작에서 다시 등록하면 그 턴이 앱째 끝낼 때 끝없이
   * 돌고, 넘긴 작업에 눈먼 검수 한 바퀴를 더 돌린다(리드 결정 24)
   */
  private reviewWorkRestartDropped(t: Task): boolean {
    const ctx = this.ctx;
    return restartDropped([
      ...ctx.store.queue.list({ ref2: mainKey(t.projectId) }).filter((q) => isReviewHandOff(q) && q.taskId === t.id),
      ...ctx.store.queue.list({ ref2: reviewKey(t.id) }).filter((q) => q.kind === 'review'),
    ]);
  }

  /**
   * 그 작업의 병합 판단 업무 (그 지시 세션의 항목) — taskId가 그 작업이거나, taskId 없이 글에 그 작업을 적은 프로듀서의 병합 재촉(judgeDirective,
   * turns.mergeNudgeTasks)이다. 재시작 상한의 버림 판정과 '이미 기다림' 판정이 같은 대상을 본다 (리드 결정 48)
   */
  private mergeDecisionsOf(t: Task): QueueEntry[] {
    return this.ctx.store.queue
      .list({ ref2: directiveKey(t.directiveId) })
      .filter((q) => q.kind === 'merge_decision' && (q.taskId === t.id || (!q.taskId && mergeNudgeTasks(q).includes(t.id))));
  }

  /**
   * 시작 때 그 작업의 병합 판단을 다시 넣지 않는지 (재시작 2)의 병합 대조·3)·관리 업무 복원):
   * - 그 작업의 병합 판단 업무(재촉 포함) 가운데 가장 최근 것이 재시작 상한에서 버린 것이다 — 버림 알림이 그 일의 업무다 (리드 결정 44). 재촉에는 taskId가
   *   없어 taskId로만 보면 버린 재촉을 보지 못하고, 가장 최근 항목이 정상으로 마친 원래 요청이라 다시 넣었다
   * - 그 작업을 적은 병합 재촉이 아직 기다린다 — queueMergeDecision의 중복 합치기는 taskId가 같은 항목만 봐서 같은 작업의 둘째 항목을 만들었고, 그 항목은
   *   재촉과 한 턴에 실려 재촉이 재시작 상한에서 버려진 뒤에도 남아 돌았다 (리드 결정 48). taskId가 그 작업인 항목은 그 합치기가 본다
   */
  private skipMergeDecision(t: Task): boolean {
    const entries = this.mergeDecisionsOf(t);
    return restartDropped(entries) || entries.some((q) => !q.taskId && (q.state === 'queued' || q.state === 'running'));
  }

  /**
   * 시작 때 안전망 (리드 결정 18 — 주기 검사가 아니라 재시작 복구에서만): 검수 중·통과 전인데 대기·실행 중인 검수도, 검수자 재배정 업무(reviewer_assign)도,
   * 그 작업의 메인 에이전트 업무도 없는 작업. 검수 중 작업에는 늘 대기·실행 중인 검수나 처리할 수 있는 쪽의 업무가 있어야 하므로(리드 결정 11), 그런 작업은
   * 어떤 끝에서 업무를 잃은 것이다 — 지금 검수자에게 검수를 다시 등록하고(적격 검수자가 없으면 '검수자 없음' 보류와 메인 업무) 활동 기록을 남긴다.
   * 다만 그 검수 일(넘김·검수)의 가장 최근 항목을 재시작 상한에서 버렸으면 다시 만들지 않는다 — 버림 알림이 그 일의 업무다 (리드 결정 44).
   * 다시 불러도 같다: 다시 만든 업무가 있으면 건너뛴다. 다시 만든 작업 수
   */
  private rebuildLostReviewWork(): number {
    const ctx = this.ctx;
    const live = ctx.store.queue.list({ state: ['queued', 'running'] });
    // 합쳐 둔 옛 재배정 항목(같은 작업끼리만 합치기 전)은 글의 작업 ID도 본다 (turns.stuckReviewAssigns와 같게)
    const hasWork = (taskId: string) =>
      live.some(
        (q) =>
          (q.taskId === taskId && (q.kind === 'reviewer_assign' || (q.memberId === MAIN_AGENT_ID && q.sessionKey.startsWith('main:')))) ||
          (q.kind === 'reviewer_assign' && !!q.message.match(/T-\d+/g)?.includes(taskId)),
      );
    let n = 0;
    for (const t of ctx.store.tasks.list({ state: 'in_review' })) {
      if (t.review.passed || !t.review.target || closedDirectiveWork(ctx, null, t)) continue;
      if (this.core.tasks.reviewPending(t.id) || hasWork(t.id) || this.reviewWorkRestartDropped(t)) continue;
      this.core.tasks.dispatchReview(t);
      const now = taskOrThrow(ctx, t.id);
      const did = now.state === 'on_hold' ? "'검수자 없음'으로 보류하고 메인 에이전트에게 넘김" : `검수자 ${now.reviewerId === MAIN_AGENT_ID ? '메인 에이전트' : now.reviewerId}에게 검수를 다시 등록`;
      ctx.activity({
        kind: 'review',
        level: 'warn',
        projectId: t.projectId,
        directiveId: t.directiveId,
        taskId: t.id,
        text: `재시작 복구: ${t.id} 검수 중인데 대기·실행 중인 검수도, 검수자 재배정이나 메인 에이전트 업무도 없어 ${did}`,
      });
      n++;
    }
    return n;
  }

  /** 끊긴 턴이 실었던 검수 업무가 이제 고정돼 있지 않은 버전의 것인지 (기준 변경·재배정 등으로 대상이 지워졌거나 다른 버전이 고정됨) */
  private staleReviewEntry(q: QueueEntry): boolean {
    if (q.kind !== 'review' || !q.reviewPinnedAt || !q.sessionKey.startsWith('review:')) return false;
    const t = q.taskId ? this.ctx.store.tasks.get(q.taskId) : null;
    return !t || isTerminal(t.state) || t.review.target?.pinnedAt !== q.reviewPinnedAt;
  }

  private markExec(e: ExecRecord, state: ExecRecord['state'], extra: Record<string, unknown>): void {
    this.ctx.store.execs.put({ ...e, state, endedAt: this.ctx.now(), result: { ...e.result, ...extra } });
  }

  /**
   * 복구 확인은 메인 에이전트가 한다(resolve_recovery) — 작업이 있으면 그 작업을 보류(복구 확인)하고, 작업이 없어도 메인 에이전트에게 알림 업무를 넣는다
   * (alert recovery:<요청 ID> — 글에 recovery_id가 있다, 리드 결정 S5-8). 대표 알림은 넘긴 사실을 쓴다(넘기지 못했으면 결정 32의 문장, 리드 결정 32·40·S5-9)
   */
  private holdForRecovery(e: ExecRecord, note: string): number {
    const ctx = this.ctx;
    const alert = (): boolean =>
      !!alertMain(ctx, { kind: 'recovery', target: e.requestId, projectId: recoveryProjectOf(ctx, e), taskId: e.taskId, message: recoveryText(ctx, e.requestId, note), since: e.startedAt });
    if (!e.taskId) {
      const handed = alert();
      ctx.notify({
        level: 'normal',
        title: '복구 확인 필요',
        body: `${e.kind} ${e.command}: ${note} — ${handed ? `확인을 ${OWNER_HANDED}` : ownerExit(false, '')}`,
        link: { tab: 'settings', section: 'policy' },
        key: `recovery:${e.requestId}`,
      });
      return 1;
    }
    const t = ctx.store.tasks.get(e.taskId);
    if (!t || isTerminal(t.state)) return 0;
    if (!hasHold(t, 'recovery_check', (r) => r.refId === e.requestId)) {
      this.core.tasks.hold(t.id, 'recovery_check', 'task', note, 'system', e.requestId);
    }
    const handed = alert();
    ctx.notify({
      level: 'normal',
      title: '복구 확인 필요',
      body: `${t.id} ${e.kind}: ${note} — 작업을 보류${handed ? `하고 확인을 ${OWNER_HANDED}` : `했습니다. ${ownerExit(false, '')}`}`,
      link: { tab: 'projects', projectId: t.projectId, taskId: t.id },
      key: `recovery:${e.requestId}`,
    });
    return 1;
  }

  private async reconcileExec(e: ExecRecord): Promise<number> {
    const ctx = this.ctx;
    const git = ctx.deps.git;
    const task = e.taskId ? ctx.store.tasks.get(e.taskId) : null;
    switch (e.kind) {
      case 'git_merge': {
        if (!task || !e.projectId) return this.markExec(e, 'unknown', { recovered: 'no_task' }), 0;
        const project = projectOrThrow(ctx, e.projectId);
        const pre = String(e.result.preMainSha ?? '');
        const taskSha = String(e.result.taskSha ?? '');
        const found = pre && taskSha ? await git.findMergeCommit(project.path, project.baseBranch, pre, taskSha) : null;
        if (found) {
          // 이미 반영됨 → 다시 실행하지 않는다 (GIT-15). 작업이 정지·보류 중이어도 병합 기록은 남긴다 —
          // 안 남기면 재개 뒤 같은 병합을 다시 요청·실행한다. 완료는 검수 상태일 때 3단계에서, 보류 중이면 재개 때 (CTL-10)
          this.markExec(e, 'succeeded', { mergeCommitSha: found, recovered: 'already_applied' });
          const passed = task.review.passed?.target;
          if (!isTerminal(task.state) && !task.merge && passed?.kind === 'repo' && passed.taskCommitSha === taskSha) {
            // 기록 전에 끊겼으면 프로젝트 폴더도 맞추지 못한 상태다 — 맞춤은 아래 2-0) 단계가 기록된 병합마다 한다
            ctx.store.tasks.patch(task.id, { merge: { requestId: e.requestId, taskCommitSha: taskSha, preMainSha: pre, mergeCommitSha: found, mergedAt: ctx.now() } });
          }
          return 0;
        }
        const baseNow = await git.revParse(project.path, `refs/heads/${project.baseBranch}`);
        if (baseNow === pre) {
          this.markExec(e, 'failed', { recovered: 'not_applied' });
          // 병합 판단을 재시작 상한에서 버렸으면 여기서도 다시 넣지 않는다 — 3)·관리 업무 복원과 같은 판정 (리드 결정 44·48)
          if (task.state === 'in_review' && task.review.passed && !this.skipMergeDecision(task)) this.core.merges.queueMergeDecision(task);
          return 0;
        }
        this.markExec(e, 'unknown', { recovered: 'unclear', baseNow });
        return this.holdForRecovery(e, '병합 실행 여부를 확인할 수 없습니다 (기준 브랜치가 예상과 다름)');
      }
      case 'git_commit':
      case 'git_conflict_commit':
      case 'git_revert': {
        if (!task?.workspace) return this.markExec(e, 'failed', { recovered: 'no_workspace' }), 0;
        const head = await git.revParse(task.workspace.worktreePath, 'HEAD').catch(() => null);
        const pre = e.result.head ? String(e.result.head) : null;
        const log = head ? await git.log(task.workspace.worktreePath, head, 1).catch(() => []) : [];
        const applied = !!head && head !== pre && !!log[0]?.subject.startsWith(`[${task.id}]`);
        if (applied && e.kind === 'git_commit' && typeof e.result.step === 'number') {
          const step = ctx.store.steps.list(task.id).find((s) => s.idx === e.result.step);
          if (step && !step.done) ctx.store.steps.put({ ...step, done: true, doneAt: ctx.now(), commitSha: head, note: '재시작 복구로 확인' });
        }
        this.markExec(e, applied ? 'succeeded' : 'failed', { recovered: applied ? 'already_applied' : 'not_applied', head });
        return 0;
      }
      case 'git_update_from_base': {
        if (!task?.workspace) return this.markExec(e, 'failed', { recovered: 'no_workspace' }), 0;
        const st = await git.status(task.workspace.worktreePath);
        if (st.mergeInProgress || st.unmerged.length) {
          // 같은 충돌이 이미 기록돼 있으면 since·횟수를 이어 간다 — 재시작이 해결 못 한 턴 수를 되돌리지 않게 (GIT-07, CLI-18). 내용으로 확인할 수 없는
          // 충돌 파일도 지금(팀원이 손대기 전) 확인해 기록에 남긴다 — 재검수 요청에 계속 적도록
          const merging = st.mergeInProgress ? await git.revParse(task.workspace.worktreePath, 'MERGE_HEAD').catch(() => null) : null;
          const unverifiable = await this.core.tasks.unverifiableNow(task.id, task.workspace.worktreePath);
          ctx.store.tasks.patch(task.id, { conflict: this.core.tasks.nextConflict(task.id, st.unmerged, merging ?? (String(e.result.baseSha ?? '') || null), unverifiable).conflict });
          this.markExec(e, 'succeeded', { recovered: 'conflict_in_progress', conflicts: st.unmerged });
        } else this.markExec(e, 'failed', { recovered: 'rerun_on_submit' });
        return 0;
      }
      case 'git_sync_base_checkout':
        // 병합 뒤 프로젝트 폴더를 맞추다 끊김 — 아래 2-0) 단계가 그 병합의 맞춤을 다시 한다 (폴더가 뒤처져 있을 때만, 새 실행 기록으로)
        this.markExec(e, 'failed', { recovered: 'interrupted_resync' });
        return 0;
      case 'auto_check':
      case 'git_worktree_add':
      case 'git_worktree_remove':
      case 'git_branch_delete':
      case 'git_archive':
      case 'project_setup':
      case 'git_init':
        // 멱등 작업: 다음 처리 때 다시 수행
        this.markExec(e, 'failed', { recovered: 'idempotent_rerun' });
        return 0;
      case 'host_exec':
        // 메인 에이전트의 서버 명령 — 복구 확인으로 보류하지 않는다(다시 돌리는 것은 멱등이 아니고 확인할 결과도 없다). 그 프로세스 트리를 끝내고 메인에게 알린다
        return this.reconcileHostExec(e);
      case 'git_push':
      case 'deploy':
      default:
        this.markExec(e, 'unknown', { recovered: 'unclear' });
        return this.holdForRecovery(e, '외부 실행이 끝났는지 확인할 수 없습니다 (자동 재실행 안 함, ERR-08)');
    }
  }

  /**
   * 서버 재시작으로 끊긴 서버 명령 (host_exec, 리드 결정 S5-18): 남긴 PID가 그 실행의 프로세스인지(생성 시각 대조 — 턴과 같은 판정) 보고 그 트리를 끝낸다. 실행 기록은
   * 실패('서버 재시작으로 끊김')로 둔다 — 복구 확인 목록(recovery.items)에 넣지 않는다. 메인 일지에 서버 기록 한 줄, 메인에게 알림 업무 alert:host_exec:<실행 ID>.
   * 종료를 확인하지 못하면 턴과 같이 막는다(CTL-11 — 메인 에이전트 일시정지, 출구는 대표의 정지 해제). 보류할 작업이 없으므로 0을 돌려준다
   */
  private async reconcileHostExec(e: ExecRecord): Promise<number> {
    const ctx = this.ctx;
    const pid = typeof e.result.pid === 'number' ? e.result.pid : null;
    const spawnedAt = typeof e.result.spawnedAt === 'string' ? e.result.spawnedAt : null;
    let processes = '띄우기 전에 끊겼거나 PID 기록이 없음';
    let found: 'gone' | 'killed' | 'unconfirmed' | 'other' | 'unknown' = 'gone';
    let unconfirmed: { remaining: number; why: string } | null = null;
    if (pid) {
      const owner = (await this.previousProcesses([{ id: e.requestId, process: { pid, spawnedAt } }])).get(e.requestId);
      if (!owner || owner.kind === 'gone') processes = `PID ${pid} — 이미 끝남`;
      else if (owner.kind === 'other') {
        found = 'other';
        processes = `PID ${pid}는 다른 프로세스가 쓰고 있어 건드리지 않음`;
      } else if (owner.kind === 'unknown') {
        found = 'unknown';
        processes = `PID ${pid}가 그 명령의 프로세스인지 확인하지 못해 건드리지 않음 (${owner.why})`;
      } else {
        try {
          const r = await ctx.deps.runner.killTree(pid);
          if (r.ok) {
            found = 'killed';
            processes = `PID ${pid} — 남은 프로세스 종료 확인`;
          } else unconfirmed = { remaining: r.remaining, why: r.detail };
        } catch (err) {
          unconfirmed = { remaining: -1, why: err instanceof Error ? err.message : String(err) };
        }
        if (unconfirmed) {
          found = 'unconfirmed';
          processes = `PID ${pid} — 종료 확인 실패: ${unconfirmed.why}`;
        }
      }
    }
    ctx.store.tx(() => {
      this.markExec(e, 'failed', { recovered: 'interrupted_by_restart', error: '서버 재시작으로 끊김', processes: found, ...(unconfirmed ? { remaining: unconfirmed.remaining, leftoverDetail: unconfirmed.why } : {}) });
      alertMain(ctx, { kind: 'host_exec', target: e.requestId, projectId: e.projectId, message: hostExecCutText(ctx, e, processes), since: e.startedAt });
    });
    const sessionKey = typeof e.result.sessionKey === 'string' ? e.result.sessionKey : 'main:general';
    this.core.journal.server('action', `서버 재시작으로 끊긴 서버 명령 (host_exec ${e.requestId}): "${e.command.slice(0, 200)}" — 목적: ${e.target.slice(0, 200)} → ${processes}`, {
      projectId: e.projectId,
      workKey: sessionKey,
      ...(typeof e.result.generation === 'number' ? { generation: e.result.generation } : {}),
    });
    ctx.activity({ kind: 'exec', level: unconfirmed ? 'error' : 'warn', actor: 'system', projectId: e.projectId, memberId: MAIN_AGENT_ID, requestId: e.requestId, text: `재시작 복구: 서버 명령 ${e.requestId} 서버 재시작으로 끊김 — ${processes}` });
    if (unconfirmed) {
      // 종료를 확인하지 못한 이전 실행에 새 메인 턴을 겹쳐 띄우지 않는다 (CTL-11) — 턴과 같은 길: 메인 에이전트 일시정지 + 긴급 알림
      await this.core.turns.blockUnconfirmedRun(
        { label: `메인 에이전트 이전 서버 명령 ${e.requestId}`, sessionKind: sessionKey === 'main:general' ? 'main_general' : 'main_project', sessionKey, memberId: MAIN_AGENT_ID, projectId: null, taskId: null, turnId: null },
        { envProblem: unconfirmedEnvProblem(ctx.deps.runner), remaining: unconfirmed.remaining, cause: unconfirmed.why, what: '이전 실행' },
      );
    }
    return 0;
  }

  /**
   * 관리 업무를 저장된 상태에서 다시 만든다 (8장 자동 복구 실패 → 다시 시도할 수 있게). 소비된 대기 항목이나
   * 재시도를 다 써서 사라진 일 — 프로듀서에게 온 질문 답변, 회차 마감(최종 결과 요청), 보고서 요청, 병합 판단, 프로그램이 일시정지한 팀원의
   * 재개(메인 에이전트 업무, 리드 결정 26) — 을 대기·실행 중 항목과 대조해 빠진 것만 넣는다. 여러 번 불러도 같은 결과.
   * 비정상 종료·시작 실패 상한과 헛돌기로 버린 일은 다음 시작에 일부러 다시 만든다(다시 시도할 수 있게 — 재시작이 그 일의 재시도다). 그러나 같은 대상의
   * 가장 최근 항목(상태와 상관없이)이 재시작 상한에서 버린 것이면 다시 만들지 않는다: 그 턴이 앱째 끝낸 일이라 같은 시작에서 0부터 다시 넣으면 끝없이
   * 돌고, 대표가 받은 '더는 자동으로 다시 시도하지 않습니다'가 거짓이 된다. 그 버림 알림이 그 일의 업무다 (restartDropped, 리드 결정 44)
   */
  reconcileManagement(projectId: string | null = null): void {
    const ctx = this.ctx;
    const inScope = (p: string | null) => !projectId || p === projectId;
    const pending = (key: string, pred: (q: QueueEntry) => boolean) => ctx.store.queue.list({ ref2: key, state: ['queued', 'running'] }).some(pred);
    /** 그 대상의 가장 최근 항목이 재시작 상한에서 버린 것인지 (since: 그 전 항목은 다른 대상 — 지난 회차·앞선 정지) */
    const dropped = (key: string, pred: (q: QueueEntry) => boolean, since?: string | null) => restartDropped(ctx.store.queue.list({ ref2: key }).filter(pred), since);
    const attempt = (what: string, fn: () => void) => {
      try {
        fn();
      } catch (e) {
        ctx.log('warn', `관리 업무 복원 실패 (${what})`, e);
      }
    };

    // 프로듀서에게 온 열린 질문 → 답변 업무 (질문한 작업은 답변 대기로 보류돼 있다)
    for (const q of ctx.store.questions.list({ state: 'open' })) {
      if (q.to !== 'producer' || !q.directiveId || !q.projectId || !inScope(q.projectId)) continue;
      const d = ctx.store.directives.get(q.directiveId);
      if (!d || !isDirectiveOpen(d)) continue;
      const t = q.taskId ? ctx.store.tasks.get(q.taskId) : null;
      if (t && isTerminal(t.state)) continue;
      // 그 질문의 답변 업무 — questionId가 그 질문이거나, 열린 질문을 모두 적는 프로듀서의 답변 재촉(judgeDirective, questionId 없음)이다. 대기 판정과 재시작
      // 상한의 버림 판정이 같은 대상을 본다: 질문 ID로만 보면 버린 재촉을 보지 못해, 가장 최근 항목인 정상으로 마친 원래 요청을 보고 같은 시작에서 다시
      // 넣었다 (리드 결정 44·48)
      const answerOf = (e: QueueEntry) => e.kind === 'answer' && (e.questionId === q.id || !e.questionId);
      if (pending(directiveKey(q.directiveId), answerOf)) continue;
      if (dropped(directiveKey(q.directiveId), answerOf)) continue;
      attempt(`질문 ${q.id}`, () => this.core.tasks.queueProducerAnswer(q, producerOf(ctx, q.projectId!).id));
    }

    for (const d of ctx.store.directives.list({ state: ['planning', 'in_progress', 'reporting'] })) {
      if (!d.projectId || !inScope(d.projectId)) continue;
      // 지금 회차가 열린 때 — 그 전에 만든 보고서 요청·최종 결과 요청은 지난 회차의 것이다
      const roundSince = d.rounds.find((r) => r.round === d.round)?.requestedAt ?? null;
      if (d.state === 'reporting') {
        // 최종 결과는 받았는데 보고서가 없다 → 메인 에이전트 보고 요청
        const report = d.rounds.find((r) => r.round === d.round)?.reportId;
        if (report || d.finalResult?.round !== d.round) continue;
        if (pending(mainKey(d.projectId), (e) => e.kind === 'main_report' && e.directiveId === d.id)) continue;
        if (dropped(mainKey(d.projectId), (e) => e.kind === 'main_report' && e.directiveId === d.id, roundSince)) continue;
        attempt(`보고 ${d.id}`, () => this.core.directives.queueMainReport(d));
      } else {
        // 회차 작업이 모두 끝났는데 최종 결과 요청이 없다
        if (pending(directiveKey(d.id), (e) => e.kind === 'final_result')) continue;
        if (dropped(directiveKey(d.id), (e) => e.kind === 'final_result', roundSince)) continue;
        attempt(`회차 마감 ${d.id}`, () => this.core.directives.checkRoundDone(d.id));
      }
    }

    // 검수를 통과한 저장소 변경형 → 병합 판단 (병합 기록이 있으면 다시 병합하지 않고 마무리)
    for (const t of ctx.store.tasks.list({ state: 'in_review' })) {
      if (!inScope(t.projectId) || !t.review.passed || t.outputMode !== 'repo') continue;
      if (!this.core.stops.runAllowedForTask(t)) continue;
      if (t.merge) void this.core.merges.finishMerged(t.id, null);
      else if (!this.skipMergeDecision(t)) attempt(`병합 판단 ${t.id}`, () => this.core.merges.queueMergeDecision(t));
    }

    // 프로그램이 일시정지한 팀원(종료를 확인하지 못한 실행) → 메인 에이전트의 재개 업무. 일시정지와 업무 넣기 사이에 끊겼거나, 이 업무가 생기기 전(1단계 전)에
    // 건 정지다. 그 팀원의 재개 업무가 대기·실행 중이면 넣지 않는다(handPauseToMain) — 다시 불러도 같다 (리드 결정 26). 그 정지의 재개 업무(그 정지 뒤에
    // 만든 것)를 재시작 상한에서 버렸으면 다시 넣지 않는다 — 대표가 받은 '메인 에이전트 처리 지연'이 그 일의 업무다 (리드 결정 44)
    for (const [memberId, s] of Object.entries(ctx.stop().members)) {
      if (!s.paused || s.by !== 'system' || memberId === MAIN_AGENT_ID || !inScope(ctx.store.members.get(memberId)?.projectId ?? null)) continue;
      if (dropped(mainKey(ctx.store.members.get(memberId)?.projectId ?? null), (e) => e.pausedMemberId === memberId && e.memberId === MAIN_AGENT_ID, s.since)) continue;
      attempt(`팀원 재개 ${memberId}`, () => this.core.turns.handPauseToMain(memberId, null));
    }

    // 메인 에이전트에게 넘길 보류·항목에 알림이 없으면 만든다 — 같은 결과로 모이는 시작 때 훑기 (리드 결정 S5-8). 그 보류가 걸린 뒤 같은 키로 넣은 항목이
    // 하나라도 있으면(받아 마쳤거나 상한에서 버림) 다시 만들지 않는다. 처음 5단계로 시작하면 예전 보류(1단계 전 대표 정지·중단 포함)를 알린다
    attempt('메인 알림 훑기', () => sweepAlerts(ctx, inScope));
  }

  // ───────────────────────── 대표 화면 ─────────────────────────

  items(): RecoveryItemView[] {
    const ctx = this.ctx;
    return ctx.store.execs.list({ state: 'unknown' }).map((e) => ({
      requestId: e.requestId,
      kind: e.kind,
      projectId: e.projectId,
      taskId: e.taskId,
      command: e.command,
      startedAt: e.startedAt,
      finding: String(e.result.recovered ?? e.result.recoveryError ?? '실행 여부 불명확'),
    }));
  }

  /**
   * 복구 확인 (ERR-08) — v0.6에서는 메인 에이전트가 한다(resolve_recovery, actor M-MAIN). 기본 행위자는 대표(예전 기록·시험 호환).
   * beforeResolve: 아래 거부(찾을 수 없음·병합 커밋을 찾지 못함)와 이미 처리된 확인을 지난 뒤, 정하기 바로 전에 부른다 — 던지면 정하지 않는다 (resolve_recovery가
   * 메인이 아직 받지 않은 그 알림을 먼저 보여 준다, 리드 결정 S5-50). applied·git_merge는 그 전에 git.log를 기다린다 — 그 사이 부른 메인 턴이 끝났으면
   * 알림은 대기 그대로 둔 채 거부한다(다음 메인 턴이 받는다, 리드 결정 S5-56)
   */
  async resolve(requestId: string, action: 'applied' | 'retry' | 'cancel', actor: Actor = OWNER, o: { beforeResolve?: () => void } = {}): Promise<void> {
    const ctx = this.ctx;
    const e = ctx.store.execs.get(requestId);
    if (!e) throw new BackendError('not_found', '복구 항목을 찾을 수 없습니다');
    if (e.state !== 'unknown') return;
    const task: Task | null = e.taskId ? ctx.store.tasks.get(e.taskId) : null;
    if (action === 'cancel') {
      o.beforeResolve?.();
      this.markExec(e, 'failed', { resolvedBy: actor, resolution: 'cancel' });
      if (task && !isTerminal(task.state)) await this.core.tasks.cancel(task.id, `복구 확인 — ${memberName(ctx, actor)} 취소`, actor);
      return;
    }
    if (action === 'applied' && e.kind === 'git_merge' && task && e.projectId) {
      const project = projectOrThrow(ctx, e.projectId);
      const commits = await ctx.deps.git.log(project.path, `refs/heads/${project.baseBranch}`, 200);
      const hit = commits.find((c) => c.body.includes(`Wook-Task: ${task.id}`) || c.subject.startsWith(`[${task.id}] 병합`));
      if (!hit) throw new BackendError('conflict', `${project.baseBranch}에서 ${task.id} 병합 커밋을 찾지 못했습니다. '다시 실행'을 고르세요`);
      o.beforeResolve?.();
      this.markExec(e, 'succeeded', { resolvedBy: actor, mergeCommitSha: hit.sha });
      // 병합 기록을 남긴 뒤 보류를 푼다 → 검수 상태로 돌아오면 afterRelease가 다시 병합하지 않고 완료한다
      const cur = taskOrThrow(ctx, task.id);
      if (!isTerminal(cur.state) && !cur.merge && cur.review.passed) {
        ctx.store.tasks.patch(task.id, { merge: { requestId, taskCommitSha: String(e.result.taskSha ?? ''), preMainSha: String(e.result.preMainSha ?? ''), mergeCommitSha: hit.sha, mergedAt: ctx.now() } });
        // 그 병합 뒤 프로젝트 폴더 맞춤도 끊겼을 수 있다 (폴더가 뒤처져 있을 때만 맞춘다)
        await this.core.merges.syncRecordedMerge(task.id);
      }
      const released = this.releaseRecovery(taskOrThrow(ctx, task.id), requestId, actor);
      if (released.state !== 'on_hold') this.core.tasks.afterRelease(released, '복구 확인 (반영됨)');
      return;
    }
    o.beforeResolve?.();
    this.markExec(e, action === 'applied' ? 'succeeded' : 'failed', { resolvedBy: actor, resolution: action });
    if (task) {
      const t = this.releaseRecovery(task, requestId, actor);
      if (t.state !== 'on_hold') this.core.tasks.afterRelease(t, `복구 확인 (${action === 'applied' ? '반영됨' : '다시 실행'})`);
    }
  }

  private releaseRecovery(task: Task, requestId: string, actor: Actor): Task {
    if (!hasHold(task, 'recovery_check', (r) => r.refId === requestId)) return task;
    return transitionTask(this.ctx, task.id, { type: 'release', match: (r) => r.kind === 'recovery_check' && r.refId === requestId, note: '복구 확인 완료' }, actor);
  }
}
