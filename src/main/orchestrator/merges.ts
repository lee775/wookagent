/**
 * 병합·산출물 확정·되돌리기 (REV-05, GIT-06·10·13·14, 7.1).
 * main 변경은 프로젝트별 잠금 안에서 한 번에 하나만. 잠금 안에서는 확인과 main 변경만 하고, 단계마다 정지·상태를 다시 본다.
 * 버전이 달라졌으면 잠금을 풀고 최신 main 반영·자동 검사·검수부터 다시 한다 (GIT-06, 7.1 긴 작업과 잠금).
 * main에 반영된 뒤에는 병합 실패로 다루지 않는다 — 기록을 먼저 남기고, 정지·보류 중이면 재개 때 완료한다 (5.3 보류→검수→완료).
 */
import type { Member, Step, Task } from '@shared/domain';
import { TASK_STATE_LABEL } from '@shared/labels';
import { emptyReviewState, isTerminal, sameTarget, TransitionError } from '@core/taskMachine';
import { chooseReviewer } from '@core/reviewRules';
import { BackendError } from '../backend/types';
import type { Core } from './core';
import { cancelQueued, directiveKey, enqueue, isUrgentDirect, parseKey, reviewKey, taskKey, transitionTask } from './records';
import { memberIdentity, recordedExec } from './execlog';
import { alertTaskHold, OWNER_HANDED, ownerExit } from './alerts';
import { artifactVersionDir } from './paths';
import { copyTree, hashTree } from './fsutil';
import { cancelSnapshotOf, closedDirectiveWork, isProgramRevert, producerOf, projectMembers, projectOrThrow, roleOf, taskOrThrow } from './lookups';

/** 잠금 안 처리의 결과: 끝남 / 잠금을 푼 뒤 제출 처리(최신 main 반영·검사·재고정)부터 다시 */
type MergeOutcome = 'done' | 'resubmit';

/** 되돌리기 작업의 프로그램 단계 기록 (단계 0) — 이 단계가 기록돼야 되돌리기 커밋이 만들어진 것으로 본다 */
const revertStepTitle = (origId: string) => `${origId} 병합 변경 취소 커밋`;
/** 프로그램 되돌리기 커밋 메시지 첫 줄 — 재시작 때 작업 폴더 HEAD가 그 커밋인지 알아본다 (GIT-15) */
const revertSubject = (revertTaskId: string, origId: string) => `[${revertTaskId}] ${origId} 되돌리기`;
/**
 * 되돌리기 보류 때 프로듀서에게 알린 뒤 작업 목록 (kv) — 그 뒤 재계획했으면 프로듀서가 확인한 목록이다 (병합 직전 다시 확인, 7.1).
 * seq: 그 보류의 상태 전이 순번 — 재계획이 그 뒤인지 시계가 아니라 전이 순서로 본다 (시계가 뒤로 맞춰져도 같다)
 */
const revertDepsKey = (revertTaskId: string) => `revertdeps:${revertTaskId}`;
type ListedDependents = { seq: number; ids: string[] }[];

/** 되돌리기 요청을 보낸 턴 (앱 도구 request_revert) — 지시 취소 전에 시작된 그 지시의 턴이 보낸 요청을 가린다 (AC-46, TSK-09) */
export interface RevertOrigin {
  sessionKey: string;
  turnId: string;
  /** 그 턴이 시작된 시각. 턴 기록이 없으면 null — 취소 때 남긴 턴 목록이 없는 이전 기록에만 쓴다 */
  turnStartedAt: string | null;
}

/**
 * '병합 기록 확인 필요'의 출구 (리드 결정 S5-8) — main에는 병합이 반영됐고 작업은 통과·병합 기록 그대로 검수 중으로 남는다. 다음 시작(재시작 복구)이나 보류 해제
 * (afterRelease → finishMerged)가 다시 병합하지 않고 기록대로 마무리한다. 메인 에이전트에게 업무는 가지 않는다 — 서두를 때는 대표가 명령창으로 알린다
 */
const MERGE_RECORD_EXIT = '다음 시작 때 기록대로 다시 마무리합니다(다시 병합하지 않음). 서둘러야 하면 명령창으로 메인 에이전트에게 알려 주세요 — 메인 에이전트가 그 작업을 중단한 뒤 다시 이어 가면 바로 마무리합니다';

export class MergeService {
  /** 병합 대기·진행 중인 작업 → 그 처리 (중복 요청 방지, 취소가 main 반영과 겹치지 않게 기다리는 데 씀) */
  private readonly pending = new Map<string, Promise<void>>();
  /** 되돌리기 작업의 프로그램 단계(작업 폴더·되돌리기 커밋)를 이어 가는 중인 처리 (resumeRevert) */
  private readonly revertJobs = new Map<string, Promise<void>>();
  /**
   * 잠금 밖에서 도는 완료 마무리 — 산출물 확정(finalizeArtifactOrHold)과 병합 완료 처리(finishMerged: 보류 해제·재시작 복구가 부른 것 포함).
   * 작업 공간 정리·원격 올리기(git)를 기다린 뒤 저장소에 쓰므로 앱 종료가 끝나기를 기다린다 (S7-D2, SHUT-1)
   */
  private readonly finishing = new Set<Promise<unknown>>();

  constructor(private readonly core: Core) {}

  private get ctx() {
    return this.core.ctx;
  }

  queueMergeDecision(task: Task): void {
    const ctx = this.ctx;
    if (task.outputMode !== 'repo' || task.merge || this.pending.has(task.id)) return;
    // 취소·종료된 지시의 작업은 병합 판단을 묻지 않는다 (TSK-09, AC-46 — 되돌리기 작업은 예외)
    if (closedDirectiveWork(ctx, null, task)) return;
    // 작업자에게 온 대표 직접 메시지가 아직 전달되지 않았으면 병합으로 가지 않고 진행으로 돌려 먼저 전달한다 (AC-36, REV-08 — 반려 아님)
    if (this.core.tasks.reopenForOwnerMessage(task.id)) return;
    // 통과 뒤 그 검수자에게 온 대표 직접 메시지가 기다리면 병합 판단을 미루고 검수 세션에 먼저 전달한다 — 검수자가 다시 판정할 수 있다 (CTL-06)
    if (this.core.tasks.holdForReviewerMessage(task.id)) return;
    const producer = producerOf(ctx, task.projectId);
    enqueue(ctx, {
      kind: 'merge_decision',
      memberId: producer.id,
      sessionKey: directiveKey(task.directiveId),
      projectId: task.projectId,
      taskId: task.id,
      directiveId: task.directiveId,
      priority: task.priority,
      message: `${task.id} "${task.title}"이(가) 독립 검수를 통과했습니다. 병합하려면 request_merge(task_id="${task.id}")를 호출하세요.${
        this.core.tasks.deliverablesCopyOf(task) ? ' (산출물형에서 저장소 변경형으로 전환된 작업 — 산출물 폴더의 결과 파일은 검수한 사본으로 병합이 끝나면 함께 보관됩니다)' : ''
      }`,
      dedupeKind: true,
    });
  }

  /** 병합 처리나 되돌리기 작업의 프로그램 단계가 진행 중인지 — 그동안 이 작업 폴더에 턴을 띄우거나 내용을 바꾸지 않는다 */
  isPending(taskId: string): boolean {
    return this.pending.has(taskId) || this.revertJobs.has(taskId);
  }

  /** 병합 대기·진행 중인 작업이 하나라도 있는지 — CLI 턴이 없어도 진행 중 작업이다 (절전 방지·완전 종료 확인, AC-31) */
  hasPending(): boolean {
    return this.pending.size > 0 || this.revertJobs.size > 0;
  }

  /** 완료 마무리(산출물 확정·병합 완료 처리)가 돌고 있는지 — 앱 종료가 저장소를 닫기 전에 기다린다 (S7-D2) */
  hasFinishing(): boolean {
    return this.finishing.size > 0;
  }

  /** 완료 마무리를 끝날 때까지(실패해도) finishing에 둔다 */
  private trackFinishing<T>(job: Promise<T>): Promise<T> {
    this.finishing.add(job);
    const done = () => this.finishing.delete(job);
    job.then(done, done);
    return job;
  }

  /** 진행 중인 병합 처리·되돌리기 단계가 끝날 때까지 기다린다 (없으면 바로). 실패해도 거부하지 않는다 */
  settled(taskId: string): Promise<void> {
    return Promise.all([this.pending.get(taskId), this.revertJobs.get(taskId)]).then(
      () => undefined,
      () => undefined,
    );
  }

  /** 프로듀서 병합 요청 (GIT-04): 검증 후 프로젝트 잠금 대기열에 넣는다 */
  requestMerge(taskId: string, producer: Member, requestId: string | null): { status: 'queued' | 'in_progress' | 'merged'; mergeCommitSha?: string } {
    const ctx = this.ctx;
    const task = taskOrThrow(ctx, taskId);
    if (!producer.isProducer || producer.projectId !== task.projectId) throw new BackendError('forbidden', '병합은 이 프로젝트의 프로듀서만 요청할 수 있습니다');
    if (task.merge) return { status: 'merged', mergeCommitSha: task.merge.mergeCommitSha };
    if (this.pending.has(taskId)) return { status: 'in_progress' };
    // 취소·종료된 지시의 미완료 작업은 main에 넣지 않는다 (TSK-09, AC-46) — 지시 취소가 그 작업을 취소하는 중이다. 되돌리기 작업은 예외
    if (closedDirectiveWork(ctx, null, task)) throw new BackendError('conflict', `${taskId}의 지시 ${task.directiveId}이(가) 취소·종료돼 병합하지 않습니다`);
    if (task.outputMode !== 'repo') throw new BackendError('invalid', '산출물형 작업은 병합하지 않습니다 (검수 통과 시 자동 확정)');
    if (task.state !== 'in_review') throw new BackendError('conflict', `${taskId}은(는) 검수 상태가 아닙니다 (${task.state})`);
    if (!task.review.passed || !sameTarget(task.review.passed.target, task.review.target)) {
      throw new BackendError('conflict', `${taskId}은(는) 현재 대상 버전으로 독립 검수를 통과하지 않았습니다`);
    }
    // 통과 뒤 그 검수자에게 온 대표 메시지를 아직 전달하지 않았다 — 검수자가 메시지를 보고 다시 판정할 수 있어 병합하지 않는다 (CTL-06).
    // 검수자가 확인하고 그 통과가 그대로면 병합 판단을 다시 요청한다 (holdForReviewerMessage → 검수 턴 마무리)
    if (this.core.tasks.holdForReviewerMessage(taskId)) {
      throw new BackendError('conflict', `${taskId}의 검수자에게 통과 판정 뒤 긴급 지시가 와서 병합하지 않습니다 — 검수자가 지시를 확인한 뒤 통과가 그대로면 병합 판단을 다시 요청합니다 (CTL-06)`);
    }
    ctx.activity({ kind: 'merge', actor: producer.id, projectId: task.projectId, taskId, requestId, text: `${taskId} 병합 요청 접수` });
    let next: MergeOutcome = 'done';
    const job = this.core.locks
      .run(task.projectId, `merge:${taskId}`, () => this.runMerge(taskId, requestId))
      .then(
        (r) => {
          next = r;
        },
        (e: unknown) => this.mergeFailed(taskId, e),
      )
      .finally(() => {
        this.pending.delete(taskId);
        ctx.bus.changed();
        ctx.bus.signal('tick');
        // 기준 main이 바뀌었으면 잠금을 푼 뒤에 최신 main 반영·자동 검사·대상 재고정부터 다시 (GIT-06)
        if (next === 'resubmit') void this.core.tasks.processSubmission(taskId);
      });
    this.pending.set(taskId, job);
    ctx.bus.changed(); // 진행 중 작업 여부(절전 방지) 다시 보기
    return { status: 'queued' };
  }

  /** 잠금 안 처리의 오류. main에 반영되기 전의 실제 실패만 병합 보류로 막는다 */
  private mergeFailed(taskId: string, e: unknown): void {
    const ctx = this.ctx;
    try {
      const msg = e instanceof Error ? e.message : String(e);
      const t = ctx.store.tasks.get(taskId);
      if (e instanceof TransitionError) {
        // 처리하는 사이 상태가 바뀐 경합(정지·보류·취소) — 병합 실패가 아니다
        ctx.log('warn', `병합 처리 중 상태 변경 ${taskId}`, e);
        ctx.activity({ kind: 'merge', level: 'warn', projectId: t?.projectId ?? null, taskId, text: `${taskId} 병합 중단 — 처리 중 상태가 바뀜`, result: msg });
        return;
      }
      ctx.log('error', `병합 실패 ${taskId}`, e);
      if (!t || isTerminal(t.state)) return;
      const link = { tab: 'projects' as const, projectId: t.projectId, taskId };
      if (t.merge) {
        // main에는 이미 반영됨 → 병합 실패·병합 보류로 다루지 않는다. 작업은 통과·병합 기록 그대로 검수 중으로 남아 다음 시작이나 보류 해제(afterRelease)가
        // 기록대로 마무리한다 — 그 사실과 대표의 출구를 쓴다 (리드 결정 S5-8)
        ctx.notify({ level: 'urgent', title: '병합 기록 확인 필요', body: `${taskId}: main에는 병합됐지만 마무리 중 오류가 났습니다: ${msg} — ${MERGE_RECORD_EXIT}`, link, key: `merge-record:${taskId}` });
        return;
      }
      this.core.tasks.hold(taskId, 'merge_blocked', 'task', `병합 실패: ${msg}`, 'system');
      // 이 보류는 메인 에이전트에게 알림 업무로 간다(alert merge-fail:<작업>) — 보류한 뒤 넘기고 대표 알림은 넘긴 사실을 쓴다 (리드 결정 32·S5-7·S5-9)
      const handed = alertTaskHold(ctx, 'merge-fail', taskId, { cause: 'main에 반영하기 전에 병합이 실패해 보류됨' });
      ctx.notify({ level: 'urgent', title: '병합 실패', body: `${taskId}: ${msg} — 병합을 보류${handed ? `하고 ${OWNER_HANDED}` : `했습니다. ${ownerExit(false)}`}`, link, key: `merge-fail:${taskId}` });
    } catch (err) {
      ctx.log('error', `병합 실패 처리 오류 ${taskId}`, err);
    }
  }

  /** 잠금 안에서 실행 (GIT-06 순서). 'resubmit'이면 잠금을 푼 뒤 제출 처리부터 다시 */
  private async runMerge(taskId: string, requestId: string | null): Promise<MergeOutcome> {
    const ctx = this.ctx;
    const git = ctx.deps.git;
    const task = taskOrThrow(ctx, taskId);
    if (task.state !== 'in_review' || !task.review.passed || task.merge) return 'done';
    const project = projectOrThrow(ctx, task.projectId);
    const target = task.review.passed.target;
    // 정지·보류·취소·재고정은 git을 기다리는 사이에도 들어온다 → 단계마다 다시 확인 (CTL-09).
    // 보류된 작업은 통과 기록을 그대로 두므로 재개 때 병합 판단부터 다시 한다. 지시 취소는 지시를 먼저 취소 상태로 저장한 뒤
    // 작업을 하나씩 취소하므로, 아직 그 작업 차례가 오지 않았어도 지시가 닫혔으면 main을 바꾸지 않는다 (CTL-08, AC-46)
    const live = (): boolean => {
      const c = ctx.store.tasks.get(taskId);
      return (
        !!c &&
        c.state === 'in_review' &&
        !c.merge &&
        this.core.stops.runAllowedForTask(c) &&
        !this.core.tasks.isCancelling(taskId) &&
        !closedDirectiveWork(ctx, null, c) &&
        sameTarget(c.review.passed?.target ?? null, target)
      );
    };
    const halted = (): MergeOutcome => {
      ctx.activity({ kind: 'merge', level: 'warn', projectId: project.id, taskId, requestId, text: `${taskId} 병합 보류 — 정지·상태 변경 (재개되면 병합 판단부터 다시)` });
      return 'done';
    };
    if (!live()) return halted();
    // 작업자에게 온 대표 직접 메시지가 아직 전달되지 않았으면 main을 바꾸지 않고 진행으로 돌려 먼저 전달한다 (AC-36, REV-08 — 반려 아님).
    // 병합 판단 뒤에 온 메시지도 여기서 본다 — 병합하면 그 업무 세션이 다시 열리지 않는다. main을 바꾸기 바로 앞에서 한 번 더 본다.
    // 통과 뒤 그 검수자에게 온 대표 메시지도 같다 — main을 바꾸지 않고 병합을 멈춰 검수 세션에 먼저 전달한다(검수자가 다시 판정할 수 있다, CTL-06).
    // 통과가 그대로면 그 검수 턴의 마무리가 병합 판단을 다시 넣는다
    const ownerFirst = (): boolean => {
      if (this.core.tasks.reopenForOwnerMessage(taskId, { inMerge: true })) return true;
      if (!this.core.tasks.holdForReviewerMessage(taskId)) return false;
      ctx.activity({ kind: 'merge', level: 'warn', projectId: project.id, taskId, requestId, text: `${taskId} 병합 멈춤 — 통과 뒤 검수자에게 온 긴급 지시를 먼저 전달 (검수자가 다시 판정할 수 있음, main은 그대로)` });
      return true;
    };
    if (ownerFirst()) return 'done';
    if (target.kind !== 'repo' || !task.workspace) throw new Error('저장소 변경형 검수 대상이 아닙니다');
    const wt = task.workspace.worktreePath;
    const base = project.baseBranch;

    const st = await git.status(wt);
    if (!live()) return halted();
    if (!st.clean) {
      transitionTask(ctx, taskId, { type: 'reopen', reason: '작업 폴더에 반영되지 않은 변경이 있음 (7.1)' }, 'system');
      this.core.tasks.continueWork(taskId, '검수 후 작업 폴더에 반영되지 않은 변경이 생겼습니다. 확인 후 다시 submit_for_review를 호출하세요.');
      return 'done';
    }
    const head = await git.revParse(wt, 'HEAD');
    if (!live()) return halted();
    if (!head || head !== target.taskCommitSha) {
      transitionTask(ctx, taskId, { type: 'reopen', reason: '검수 후 작업 버전이 바뀜 (REV-07)' }, 'system');
      this.core.tasks.continueWork(taskId, '검수 후 작업 버전이 바뀌었습니다. 다시 submit_for_review를 호출하세요.');
      return 'done';
    }
    const baseNow = await git.revParse(project.path, `refs/heads/${base}`);
    if (!baseNow) throw new Error(`기준 브랜치 ${base}을(를) 찾을 수 없습니다`);
    if (baseNow !== target.baseMainSha) {
      // 기록 전에 끊겨 이미 반영된 병합이면 다시 병합하지 않고 기록만 확정 (GIT-15, AC-45). 그 뒤의 프로젝트 폴더 맞춤도 끊겼을 수 있다
      // — 폴더가 이 병합보다 뒤처져 있을 때만 맞춘다 (syncCheckout)
      const already = await git.findMergeCommit(project.path, base, target.baseMainSha, target.taskCommitSha);
      if (already) {
        return this.recordAndFinish(taskId, requestId, { taskCommitSha: target.taskCommitSha, preMainSha: target.baseMainSha, mergeCommitSha: already }, base);
      }
      if (!live()) return halted();
      // 어차피 진행으로 돌아간다 — 대표 메시지가 기다리면 그 메시지와 함께 팀원에게 다시 제출하게 한다 (다시 제출하면 최신 main을 반영해 검사·검수)
      if (ownerFirst()) return 'done';
      return this.reopenForResubmit(taskId, '기준 main이 바뀌어 최신 main 반영 후 재검사·재검수 (반려 아님)');
    }
    // 기준 main 대비 바뀐 파일이 없으면 빈 병합 커밋을 만들지 않고 통과 기록만으로 완료 (GIT-05, AC-47)
    const changed = await git.diffStat(project.path, baseNow, head);
    if (!live()) return halted();
    if (ownerFirst()) return 'done';
    // 산출물형에서 전환된 작업: 병합과 함께 보관할 산출물 폴더 결과 파일이 고정 때 해시와 같은 내용으로 남아 있는지 본다 (검수 사본, 사본이 바뀌었으면
    // 고정 때 그대로인 산출물 폴더 — tasks.deliverablesSource). 어디에도 없으면 검수한 내용을 보관할 수 없으니 main을 바꾸지 않는다 (REV-07 '산출물
    // 버전·해시에 연결'): 산출물 확정(finalizeArtifact)과 같게 진행으로 돌려 새 버전으로 다시 검수한다(반려 아님)
    if (this.core.tasks.deliverablesSource(task, target) === null) {
      transitionTask(ctx, taskId, { type: 'reopen', reason: '검수한 산출물 폴더 결과 파일이 대상 고정 뒤 바뀜 (REV-07)' }, 'system');
      this.core.tasks.continueWork(
        taskId,
        '검수한 산출물 폴더 결과 파일이 대상 고정 뒤 바뀌어(검수 사본과 산출물 폴더 모두) 병합하지 않았습니다. 산출물 폴더의 결과 파일을 확인하고 다시 submit_for_review를 호출하세요 — 그 내용으로 다시 검수합니다.',
      );
      ctx.activity({ kind: 'merge', level: 'warn', projectId: project.id, taskId, requestId, text: `${taskId} 병합 안 함 — 검수한 산출물 폴더 결과 파일이 대상 고정 뒤 바뀜 (검수 사본·산출물 폴더 모두, 진행으로 돌려 다시 제출·검수, main은 그대로)` });
      return 'done';
    }
    if (changed.length === 0) {
      await this.completeWithoutMerge(taskId, requestId, base);
      return 'done';
    }
    // 프로젝트 폴더에 기준 브랜치가 체크아웃돼 있고 커밋되지 않은 변경이 있으면 병합하지 않는다
    const checkedOut = (await git.currentBranch(project.path)) === base;
    const dirty = checkedOut && (await git.hasTrackedChanges(project.path));
    // main을 바꾸기 바로 앞의 마지막 확인 — 이 뒤로는 되돌릴 수 없다 (CTL-09). 대표 메시지도 여기서 마지막으로 본다 (이 뒤에 온 것은 완료 뒤 알림과 함께 정리)
    if (!live()) return halted();
    if (ownerFirst()) return 'done';
    // 되돌리기는 여기서 되돌릴 변경에 기대는 뒤 작업을 다시 본다 (7.1 '뒤의 작업이 되돌릴 변경에 의존하면 보류', GIT-10) — 되돌리기 커밋 때 확인한
    // 뒤에도 다른 지시의 계획(따로 도는 프로듀서 세션)이나 재계획 뒤에 그 작업을 선행 작업으로 둔 작업이 생길 수 있다. 이 확인과 main 변경 사이에 기다림이 없다
    if (isProgramRevert(task) && this.holdForNewDependents(taskId, requestId)) return 'done';
    if (dirty) {
      this.core.tasks.hold(taskId, 'merge_blocked', 'task', '프로젝트 폴더에 커밋되지 않은 변경이 있어 병합 보류', 'system');
      // 이 보류는 메인 에이전트에게 알림 업무로 간다(alert merge-dirty:<작업>) — 그 변경은 대표나 운영자가 직접 고친 것일 수 있어 정리는 그쪽 몫이고, 메인은
      // 확인한 뒤 재개한다. 넘기지 못했으면 결정 32의 문장 (리드 결정 32·S5-7·S5-9)
      const handed = alertTaskHold(ctx, 'merge-dirty', taskId, { cause: `${project.name} 폴더에 커밋되지 않은 변경이 있어 병합 보류됨` });
      ctx.notify({
        level: 'normal',
        title: '병합 보류',
        body: `${project.name} 폴더에 커밋되지 않은 변경이 있어 ${taskId} 병합을 보류${
          handed ? `하고 ${OWNER_HANDED}. 그 변경을 직접 하고 있다면 정리(커밋·보관)한 뒤 알려 주세요` : `했습니다. ${ownerExit(false, '변경을 정리(커밋·보관)하면')}.`
        }`,
        link: { tab: 'projects', projectId: project.id, taskId },
        key: `merge-dirty:${taskId}`,
      });
      return 'done';
    }
    const message = `[${taskId}] 병합: ${task.title}\n\nWook-Task: ${taskId}\nWook-Request: ${requestId ?? '-'}`;
    const res = await recordedExec(
      ctx,
      {
        kind: 'git_merge',
        projectId: project.id,
        taskId,
        cwd: project.path,
        command: `merge ${task.workspace.branch} → ${base}`,
        target: base,
        requestId: requestId ?? undefined,
        pre: { preMainSha: baseNow, taskSha: head, branch: task.workspace.branch },
      },
      async () => {
        const r = await git.mergeIntoBase(project.path, { baseBranch: base, taskSha: head, expectedBaseSha: baseNow, message, identity: memberIdentity(null) });
        return { value: r, result: r.ok ? { mergeCommitSha: r.mergeSha } : { reason: r.reason, detail: r.detail }, failed: !r.ok };
      },
    );
    if (!res.ok) {
      if (res.reason === 'base_moved' || res.reason === 'not_up_to_date') {
        if (!live()) return halted();
        if (ownerFirst()) return 'done';
        return this.reopenForResubmit(taskId, `병합 직전 기준 확인 실패(${res.reason}) — 최신 main 반영 후 재검사·재검수`);
      }
      throw new Error(res.detail);
    }
    // main에 반영됨 — 여기서부터는 병합 실패로 다루지 않는다 (GIT-14·15)
    return this.recordAndFinish(taskId, requestId, { taskCommitSha: head, preMainSha: baseNow, mergeCommitSha: res.mergeSha }, checkedOut ? base : null);
  }

  /** 반려가 아닌 재작업으로 진행에 돌리고 제출 요청을 남긴다 — 잠금을 푼 뒤 processSubmission이 이어 처리 (GIT-06, REV-07) */
  private reopenForResubmit(taskId: string, why: string): MergeOutcome {
    const ctx = this.ctx;
    const t = transitionTask(ctx, taskId, { type: 'reopen', reason: why }, 'system');
    ctx.store.tasks.patch(taskId, { pendingSubmit: { requestedAt: ctx.now(), note: '최신 main 반영 후 재검사' } });
    ctx.activity({ kind: 'merge', projectId: t.projectId, taskId, text: `${taskId} ${why}` });
    return 'resubmit';
  }

  /**
   * main 반영을 기록하고 마무리한다. 기록은 작업이 정지·보류 중이어도 바로 남기고(되돌릴 수 없는 사실),
   * 완료·정리·원격 올리기는 작업이 검수 상태일 때만 — 보류 중이면 재개 때 finishMerged가 한다 (CTL-10)
   */
  private async recordAndFinish(
    taskId: string,
    requestId: string | null,
    m: { taskCommitSha: string; preMainSha: string; mergeCommitSha: string },
    syncBase: string | null,
  ): Promise<MergeOutcome> {
    const ctx = this.ctx;
    const cur = ctx.store.tasks.get(taskId);
    if (!cur) return 'done';
    if (cur.state === 'cancelled') {
      // 취소는 진행 중 병합이 끝나기를 기다리므로 생기면 안 되는 상태 — 숨기지 않고 알린다. 되돌리기는 프로듀서 도구라 대표는 메인 에이전트를 거친다 (리드 결정 45)
      ctx.log('error', `취소된 작업의 병합이 main에 반영됨 ${taskId}`);
      ctx.notify({
        level: 'urgent',
        title: '병합 기록 확인 필요',
        body: `${taskId}은(는) 취소됐지만 main에 병합이 반영됐습니다 (${m.mergeCommitSha.slice(0, 8)}). 필요하면 명령창으로 메인 에이전트에게 되돌리기를 말해 주세요`,
        link: { tab: 'projects', projectId: cur.projectId, taskId },
        key: `merge-record:${taskId}`,
      });
      return 'done';
    }
    if (!isTerminal(cur.state) && !cur.merge) {
      ctx.store.tasks.patch(taskId, { merge: { requestId: requestId ?? '-', ...m, mergedAt: ctx.now() } });
    }
    if (syncBase) await this.syncCheckout(cur.projectId, taskId, syncBase, m.preMainSha, m.mergeCommitSha);
    if (!(await this.finishMerged(taskId, requestId))) {
      const t = ctx.store.tasks.get(taskId);
      if (t && !isTerminal(t.state)) {
        ctx.activity({ kind: 'merge', level: 'warn', projectId: t.projectId, taskId, requestId, text: `${taskId} main 병합 반영됨 ${m.mergeCommitSha.slice(0, 8)} — 작업이 정지·보류 중이라 재개 때 완료 처리` });
      }
    }
    return 'done';
  }

  /**
   * 체크아웃된 프로젝트 폴더를 병합 결과로 맞춘다 (실패해도 던지지 않음 — 못 맞추면 알림). 폴더가 이 병합보다 뒤처져 있을 때만 한다 — 저장소 상태로
   * 본다 (GIT-15, AC-45): 기준 브랜치가 체크아웃돼 있고 그 끝이 이 병합 커밋이며 이 병합이 바꾼 경로의 인덱스가 모두 아직 병합 전 내용일 때
   * (`git.baseCheckoutState` — 그 밖의 경로에 스테이징된 대표 변경은 보지 않고, 맞춤(read-tree)도 그대로 남긴다). 그래서 병합 직후·재시작 복구에서
   * 여러 번 불러도 같다 — 이 병합의 맞춤을 이미 마쳤거나(성공한 맞춤 기록) 병합이 바꾼 경로마다 그 병합의 변경이 들어 있으면(병합 결과, 또는 그
   * 위에 대표가 고친 내용 — 그대로 커밋해도 병합이 되돌려지지 않는다) 기록·알림 없이 넘어가고, main이 이 병합 뒤로 더 움직였으면 이 병합의 맞춤이
   * 아니다. 그 밖에(병합 변경이 빠진 경로 — 병합 전 내용, 병합 전 내용에 대표 변경이 더해짐 — 나 내용으로 확인하지 못한 경로가 있는데 모두 병합 전
   * 내용은 아님) 건드리지 않고 그 파일들을 종류별로 적어 알린다 — 알림은 사실이어야 한다. 실행 기록에 두 커밋을 남겨 맞추다 끊긴 것을 재시작
   * 때 알아본다. 프로젝트 잠금 안에서 부른다
   */
  private async syncCheckout(projectId: string, taskId: string, base: string, oldSha: string, newSha: string): Promise<void> {
    const ctx = this.ctx;
    const git = ctx.deps.git;
    try {
      const project = projectOrThrow(ctx, projectId);
      if (ctx.store.execs.list({ ref1: taskId, ref2: 'git_sync_base_checkout' }).some((x) => x.state === 'succeeded' && x.result.newSha === newSha)) return;
      // 추적 파일 변경이 하나도 없으면 폴더가 HEAD(=이 병합이거나 그 뒤) 그대로다 — 맞출 것이 없다
      if (!(await git.hasTrackedChanges(project.path))) return;
      const { state, preMerge, preMergeEdited = [], unverified = [] } = await git.baseCheckoutState(project.path, base, oldSha, newSha);
      if (state === 'not_checked_out' || state === 'moved' || state === 'synced') return;
      if (state === 'diverged') {
        const list = (ps: readonly string[]) => (ps.length > 5 ? `${ps.slice(0, 5).join(', ')} 외 ${ps.length - 5}개` : ps.join(', '));
        // 병합 변경이 빠진(또는 확인하지 못한) 파일을 종류별로 적는다 — 알림은 사실이어야 한다
        const files =
          [
            preMerge.length ? `아직 병합 전 내용: ${list(preMerge)}` : '',
            preMergeEdited.length ? `병합 전 내용에 대표 변경이 더해짐: ${list(preMergeEdited)}` : '',
            unverified.length ? `병합 변경이 들어 있는지 확인 못 함: ${list(unverified)}` : '',
          ]
            .filter(Boolean)
            .join(' / ') || '병합 전 커밋을 찾지 못해 어느 파일인지 가리지 못함';
        ctx.activity({
          kind: 'git',
          level: 'warn',
          projectId,
          taskId,
          text: `${taskId} ${base} 병합(${newSha.slice(0, 8)}) 뒤 프로젝트 폴더를 맞추지 않음 — 이 병합으로 바뀐 파일에 대표 변경이 섞여 그대로 둠 (${files})`,
        });
        ctx.notify({
          level: 'normal',
          title: '프로젝트 폴더 동기화 필요',
          body: `${base}에는 병합(${newSha.slice(0, 8)})됐지만 프로젝트 폴더에서 이 병합으로 바뀐 파일에 대표 변경이 섞여 있어 맞추지 않았습니다 — ${files}. 변경을 정리(커밋·보관)한 뒤 폴더를 최신 ${base}(으)로 맞추세요 — 병합 변경이 빠진 파일을 그대로 커밋하면 그 파일의 병합 변경이 되돌려집니다`,
          link: { tab: 'projects', projectId },
          key: `sync:${projectId}`,
        });
        return;
      }
      const sync = await recordedExec(
        ctx,
        {
          kind: 'git_sync_base_checkout',
          projectId,
          taskId,
          cwd: project.path,
          command: `read-tree -m -u ${oldSha.slice(0, 8)} ${newSha.slice(0, 8)}`,
          target: base,
          pre: { oldSha, newSha },
        },
        async () => {
          const s = await git.syncCheckedOutBase(project.path, base, oldSha, newSha);
          return { value: s, result: { ok: s.ok, detail: s.detail }, failed: !s.ok };
        },
      );
      if (!sync.ok) {
        ctx.notify({
          level: 'normal',
          title: '프로젝트 폴더 동기화 필요',
          body: `${base}에는 병합됐지만 프로젝트 폴더 작업 트리를 맞추지 못했습니다: ${sync.detail}`,
          link: { tab: 'projects', projectId },
          key: `sync:${projectId}`,
        });
      }
    } catch (e) {
      ctx.log('warn', `프로젝트 폴더 동기화 실패 ${taskId}`, e);
    }
  }

  /**
   * 기록된 병합(`task.merge`) 뒤의 프로젝트 폴더 맞춤을 마저 한다 — 재시작 복구·대표 복구 확인 공용 (GIT-15, ARCHITECTURE 9장 재시작 ③).
   * 병합 기록과 폴더 맞춤 사이(또는 맞추는 중)에 끊기면 main은 병합 커밋인데 폴더는 병합 전 내용이라, 그대로 두면 다음 병합이 '커밋되지
   * 않은 변경'으로 보류되고 그 변경을 커밋하면 병합이 되돌려진다. 같은 폴더를 바꾸는 병합과 겹치지 않게 그 작업의 병합 잠금 안에서 한다
   */
  async syncRecordedMerge(taskId: string): Promise<void> {
    const t = this.ctx.store.tasks.get(taskId);
    const m = t?.merge;
    if (!t || !m?.preMainSha || !m.mergeCommitSha) return;
    const base = projectOrThrow(this.ctx, t.projectId).baseBranch;
    await this.core.locks.run(t.projectId, `merge:${taskId}`, () => this.syncCheckout(t.projectId, taskId, base, m.preMainSha, m.mergeCommitSha));
  }

  /**
   * 병합이 main에 반영된 작업을 완료로 마무리 (병합 직후·보류 해제·재시작 복구 공용, GIT-06 기록 확정 → 정리).
   * 검수 상태·통과·병합 기록이 모두 있을 때만 한다 — 보류 중이면 하지 않고 false (재개 후 afterRelease가 다시 부른다).
   * 보류 해제·재시작 복구가 부르면 잠금 밖에서 돌므로 앱 종료가 기다리게 finishing에 둔다 (S7-D2)
   */
  finishMerged(taskId: string, requestId: string | null): Promise<boolean> {
    return this.trackFinishing(this.finishMergedNow(taskId, requestId));
  }

  private async finishMergedNow(taskId: string, requestId: string | null): Promise<boolean> {
    const ctx = this.ctx;
    const t = ctx.store.tasks.get(taskId);
    if (!t || t.state !== 'in_review' || !t.review.passed || !t.merge) return false;
    const merge = t.merge;
    // 산출물형에서 전환된 작업의 산출물 폴더 결과 파일은 완료 전에 보관한다 (보관하지 못하면 완료하지 않고 보류 — 재개 때 다시)
    if (!this.archiveDeliverablesOrHold(taskId)) return false;
    let done: Task;
    try {
      done = transitionTask(ctx, taskId, { type: 'complete' }, 'system', requestId ?? (merge.requestId === '-' ? null : merge.requestId));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      ctx.log('error', `병합 완료 기록 실패 ${taskId}`, e);
      ctx.notify({ level: 'urgent', title: '병합 기록 확인 필요', body: `${taskId}: main에는 병합됐지만 완료 처리하지 못했습니다: ${msg} — ${MERGE_RECORD_EXIT}`, link: { tab: 'projects', projectId: t.projectId, taskId }, key: `merge-record:${taskId}` });
      return false;
    }
    try {
      const project = projectOrThrow(ctx, done.projectId);
      ctx.activity({ kind: 'merge', projectId: project.id, taskId, requestId, text: `${taskId} → ${project.baseBranch} 병합 완료 ${merge.mergeCommitSha.slice(0, 8)}` });
      ctx.notify({ level: 'info', title: '병합 완료', body: `${taskId} ${done.title}`, link: { tab: 'projects', projectId: project.id, taskId } });
      await this.core.tasks.cleanupWorkspace(done);
      await this.pushIfConfigured(project.id, taskId);
      this.afterComplete(taskOrThrow(ctx, taskId));
    } catch (e) {
      ctx.log('error', `병합 완료 후 처리 실패 ${taskId}`, e);
    }
    return true;
  }

  /** 변경 없는 저장소 작업: 병합 커밋·원격 올리기 없이 검수 통과 기록만으로 완료 (GIT-05, AC-47) */
  private async completeWithoutMerge(taskId: string, requestId: string | null, base: string): Promise<void> {
    const ctx = this.ctx;
    if (!this.archiveDeliverablesOrHold(taskId)) return;
    const done = transitionTask(ctx, taskId, { type: 'complete' }, 'system', requestId);
    ctx.activity({ kind: 'merge', projectId: done.projectId, taskId, requestId, text: `${taskId} ${base} 대비 변경 없음 — 병합 커밋 없이 완료` });
    await this.core.tasks.cleanupWorkspace(done);
    this.afterComplete(taskOrThrow(ctx, taskId));
  }

  /**
   * 산출물형에서 저장소 변경형으로 전환된 작업의 산출물 폴더 결과 파일을 완료 전에 보관한다 (AC-47, REV-05 — tasks.archiveDeliverables).
   * 파일 오류로 보관하지 못하면 완료하지 않고 보류(오류) + 긴급 알림 — 산출물 확정 실패와 같게, 원인을 정리한 뒤 재개하면 다시 보관하고 완료한다.
   * 보관했거나 보관할 것이 없으면 true
   */
  private archiveDeliverablesOrHold(taskId: string): boolean {
    const ctx = this.ctx;
    try {
      this.core.tasks.archiveDeliverables(taskId);
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      ctx.log('error', `산출물 보관 실패 ${taskId}`, e);
      const t = ctx.store.tasks.get(taskId);
      if (t && !isTerminal(t.state)) {
        this.core.tasks.hold(taskId, 'error', 'task', `산출물 폴더 결과 파일 보관 실패: ${msg}`, 'system');
        // 메인 에이전트에게 알림 업무로 넘긴다(alert artifact-fail:<작업>) — 메인이 이어 가면 결과 파일을 보관하고 완료한다 (리드 결정 S5-7·S5-9)
        const handed = alertTaskHold(ctx, 'artifact-fail', taskId, { cause: '산출물 폴더의 결과 파일을 보관하지 못해 완료하지 않고 보류됨' });
        ctx.notify({ level: 'urgent', title: '산출물 보관 실패', body: `${taskId}: ${msg} — 작업을 보류${handed ? `하고 ${OWNER_HANDED}` : `했습니다. ${ownerExit(false)}`}`, link: { tab: 'projects', projectId: t.projectId, taskId }, key: `artifact-fail:${taskId}` });
      }
      return false;
    }
  }

  /** 원격 올리기 (GIT-12): 프로젝트에 대상이 지정돼 있을 때만, 별도 승인 없이 수행하고 결과를 기록 */
  private async pushIfConfigured(projectId: string, taskId: string): Promise<void> {
    const ctx = this.ctx;
    const project = projectOrThrow(ctx, projectId);
    const remote = project.deploy.pushRemote?.trim();
    if (!remote) return;
    const r = await recordedExec(
      ctx,
      { kind: 'git_push', projectId, taskId, cwd: project.path, command: `git push ${remote} ${project.baseBranch}`, target: `${remote}/${project.baseBranch}` },
      async () => {
        const out = await ctx.deps.git.push(project.path, remote, project.baseBranch);
        return { value: out, result: { ok: out.ok, output: out.output.slice(-2000) }, failed: !out.ok };
      },
    ).catch((e: unknown) => ({ ok: false, output: e instanceof Error ? e.message : String(e) }));
    if (!r.ok) {
      ctx.notify({ level: 'normal', title: '원격 올리기 실패', body: `${project.name} → ${remote}: ${r.output.slice(-300)}`, link: { tab: 'projects', projectId }, key: `push:${projectId}` });
    } else {
      ctx.activity({ kind: 'git', projectId, taskId, text: `원격 올리기 완료 → ${remote}/${project.baseBranch}` });
    }
  }

  private afterComplete(task: Task): void {
    const ctx = this.ctx;
    // 끝난 작업의 세션으로 남은 업무는 실행될 일이 없다 (검수 중에 온 팀원 메시지 등, F12) — 기록하고 정리. 작업자에게 온 대표 직접 메시지는
    // 완료 전에 진행으로 돌려 먼저 전달하므로(reopenForOwnerMessage) 여기 남는 것은 병합이 main에 반영된 뒤에 온 것이나 검수자에게 온 것뿐 —
    // 조용히 지우지 않고 대표에게 알린다 (cancelQueued)
    const left = ctx.store.queue.list({ state: 'queued' }).filter((q) => q.sessionKey === taskKey(task.id) || q.sessionKey === reviewKey(task.id));
    if (left.length) {
      cancelQueued(ctx, (q) => q.sessionKey === taskKey(task.id) || q.sessionKey === reviewKey(task.id), `${task.id}이(가) 이미 완료돼(${task.merge ? 'main에 병합' : task.outputMode === 'artifact' ? '산출물 확정' : '변경 없이 완료'}) 그 업무 세션이 더 이어지지 않음`);
      const msgs = left.filter((q) => q.kind === 'message');
      const urgent = msgs.filter(isUrgentDirect);
      ctx.activity({
        kind: 'task',
        level: msgs.length ? 'warn' : 'info',
        projectId: task.projectId,
        taskId: task.id,
        text: `${task.id} 완료 — 전달되지 않은 업무 ${left.length}건 정리${msgs.length ? ` (메시지 ${msgs.length}건${urgent.length ? `, 그중 긴급 지시 ${urgent.length}건은 대표에게 알림` : ''})` : ''}`,
        result: msgs.map((q) => q.message.slice(0, 200)).join(' / ') || null,
      });
    }
    this.core.team.applyPendingAiIfIdle(task.assigneeId);
    this.core.directives.checkRoundDone(task.directiveId);
    if (task.revertOfTaskId) {
      ctx.activity({ kind: 'revert', projectId: task.projectId, taskId: task.revertOfTaskId, text: `${task.revertOfTaskId} 되돌리기가 ${task.id}로 반영됨` });
    }
    ctx.bus.signal('tick');
  }

  /**
   * 산출물 확정을 시작하고 실패를 처리한다 (검수 통과·보류 해제·재시작 복구 공용, CONC-14). 파일 오류(Windows EBUSY·EPERM·긴 경로 등)로
   * 확정하지 못하면 검수(통과) 상태로 조용히 멈추지 않게 보류(오류) + 긴급 알림 → 원인이 정리되고 메인 에이전트가 재개하면 다시 확정한다
   */
  finalizeArtifactOrHold(taskId: string): void {
    const ctx = this.ctx;
    // 실패 처리(보류·알림)까지 앱 종료가 기다린다 (S7-D2)
    void this.trackFinishing(this.finalizeArtifact(taskId).catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      ctx.log('error', `산출물 확정 실패 ${taskId}`, e);
      try {
        const t = ctx.store.tasks.get(taskId);
        if (!t || isTerminal(t.state)) return;
        this.core.tasks.hold(taskId, 'error', 'task', `산출물 확정 실패: ${msg}`, 'system');
        const handed = alertTaskHold(ctx, 'artifact-fail', taskId, { cause: '산출물을 확정하지 못해 보류됨' });
        ctx.notify({ level: 'urgent', title: '산출물 확정 실패', body: `${taskId}: ${msg} — 작업을 보류${handed ? `하고 ${OWNER_HANDED}` : `했습니다. ${ownerExit(false)}`}`, link: { tab: 'projects', projectId: t.projectId, taskId }, key: `artifact-fail:${taskId}` });
      } catch (err) {
        ctx.log('error', `산출물 확정 실패 처리 오류 ${taskId}`, err);
      }
    }));
  }

  /** 산출물형 확정 (REV-05): 검수 대상과 같은 파일을 보관 */
  async finalizeArtifact(taskId: string): Promise<void> {
    const ctx = this.ctx;
    const task = taskOrThrow(ctx, taskId);
    if (task.state !== 'in_review' || !task.review.passed) return;
    const target = task.review.passed.target;
    if (target.kind !== 'artifact') return;
    // 취소·종료된 지시의 미완료 작업은 확정·완료하지 않는다 — 병합의 확인(runMerge live())과 같다 (TSK-09, AC-46, CTL-08). 지시 취소는 선택을 먼저
    // 저장한 뒤 작업을 하나씩 취소하므로, 아직 그 작업 차례가 오지 않았어도 늦게 온 검수 통과·보류 해제·재시작 복구가 그 작업을 완료로 만들지 않는다.
    // 검수(통과) 상태로 두면 지시 취소가 그 작업을 취소한다. 확인부터 완료 전이까지 기다림이 없다
    if (closedDirectiveWork(ctx, null, task)) {
      ctx.activity({ kind: 'task', level: 'warn', projectId: task.projectId, taskId, text: `${taskId} 산출물 확정 안 함 — 지시 ${task.directiveId}이(가) 취소·종료됨 (미완료 작업은 지시 취소가 취소)` });
      return;
    }
    // 작업자에게 온 대표 직접 메시지가 아직 전달되지 않았으면 확정하지 않고 진행으로 돌려 먼저 전달한다 (AC-36, REV-08 — 반려 아님).
    // 보류 해제·재시작 복구로 통과 뒤 확정을 다시 시작할 때도 같다
    if (this.core.tasks.reopenForOwnerMessage(taskId)) return;
    // 통과 뒤 그 검수자에게 온 대표 메시지가 기다리면 확정을 미루고 검수 세션에 먼저 전달한다 — 검수자가 다시 판정할 수 있다 (CTL-06).
    // 통과가 그대로면 그 검수 턴의 마무리(turns.settleReview)가 확정을 다시 시작한다
    if (this.core.tasks.holdForReviewerMessage(taskId)) return;
    const snapshot = this.core.tasks.reviewCopyOf(task);
    const files = snapshot ? hashTree(snapshot) : [];
    if (!sameTarget({ ...target }, { kind: 'artifact', files, version: target.version, pinnedAt: target.pinnedAt })) {
      transitionTask(ctx, taskId, { type: 'reopen', reason: '보관할 산출물이 검수 대상과 다름' }, 'system');
      this.core.tasks.continueWork(taskId, '검수한 산출물과 보관할 파일이 다릅니다. 산출물을 확인하고 다시 제출하세요.');
      return;
    }
    const dir = artifactVersionDir(ctx.paths, task.projectId, taskId, target.version);
    copyTree(snapshot!, dir);
    ctx.store.tasks.patch(taskId, { artifact: { version: target.version, dir, files, finalizedAt: ctx.now() } });
    transitionTask(ctx, taskId, { type: 'complete' }, 'system');
    // 산출물형은 저장소 변경이 없으므로 브랜치 보관 없이 정리 (빈 커밋·병합을 만들지 않음, AC-47)
    const done = taskOrThrow(ctx, taskId);
    await this.core.tasks.cleanupWorkspace(done);
    ctx.activity({ kind: 'task', projectId: task.projectId, taskId, text: `${taskId} 산출물 v${target.version} 확정·보관 (${files.length}개 파일)` });
    this.afterComplete(done);
  }

  /** 되돌리기 요청 (GIT-10). origin: 요청을 보낸 턴 (앱 도구) — 지시 취소 전에 시작된 그 지시의 턴이 보낸 요청은 받지 않는다 (assertRevertRequestCurrent) */
  async requestRevert(taskId: string, producer: Member, reason: string, origin: RevertOrigin | null = null): Promise<{ mode: 'discarded' | 'revert_task'; revertTaskId?: string }> {
    const ctx = this.ctx;
    const task = taskOrThrow(ctx, taskId);
    if (!producer.isProducer || producer.projectId !== task.projectId) throw new BackendError('forbidden', '되돌리기는 이 프로젝트의 프로듀서만 요청할 수 있습니다');
    this.assertRevertRequestCurrent(origin);
    if (!isTerminal(task.state)) {
      if (this.pending.has(taskId)) throw new BackendError('conflict', `${taskId}은(는) 지금 병합 중입니다. 병합이 끝난 뒤 되돌리기를 요청하세요`);
      await this.core.tasks.cancel(taskId, `되돌리기(병합 전 폐기): ${reason}`, producer.id);
      return { mode: 'discarded' };
    }
    if (task.state !== 'done' || !task.merge) throw new BackendError('invalid', `${taskId}은(는) 병합된 저장소 변경 작업이 아닙니다`);
    if (task.revertedByTaskId) {
      const existing = ctx.store.tasks.get(task.revertedByTaskId);
      if (existing && existing.state !== 'cancelled') return { mode: 'revert_task', revertTaskId: existing.id };
    }
    // 만들기와 프로그램 단계(작업 폴더 → 되돌리기 커밋 → 의존성 확인)는 그 프로젝트 잠금 안에서 한다 (GIT-13). 앱이 그 사이 꺼지거나
    // 정지로 멈추면 재시작 복구·보류 해제·스케줄러가 resumeRevert로 같은 잠금 안에서 이어 간다 (GIT-15)
    const rt = await this.core.locks.run(task.projectId, `revert:${taskId}`, async () => {
      const created = this.createRevertTask(task, producer, reason, origin);
      await this.trackRevert(created.id, () => this.advanceRevert(created.id));
      return created;
    });
    return { mode: 'revert_task', revertTaskId: rt.id };
  }

  /**
   * 취소된 지시의 턴이 취소 전에 보낸 되돌리기 요청이면 받지 않는다 (AC-46 '취소된 지시의 완료 작업과 main 변경은 별도 되돌리기 전까지 유지', TSK-09).
   * 지시 취소는 선택을 먼저 저장하고 그 지시의 턴을 끝내지만, 그 전에 받아 처리 중이던 요청(프로젝트 잠금을 기다리던 request_revert 등)은 취소 뒤에
   * 도착한다. 만든 시각만 보면 취소 뒤에 요청한 별도 되돌리기(revertOutlivesDirective)로 남아 대표가 유지하기로 한 완료 변경을 main에서 지운다. 그래서
   * 요청을 보낸 턴이 취소된 지시의 일(그 지시 세션, 그 지시 작업의 작업·검수 세션)이고 그 취소 전에 시작됐으면 거부한다 — 판정을 그 턴이 본 버전에 묶는
   * 것과 같은 방식이다 (AC-43). '취소 전에 시작됨'은 시계가 아니라 지시를 취소할 때 남긴 턴 목록(lookups.CancelSnapshot — 그 지시의 턴과 그때 살아 있던 턴)으로
   * 본다(턴 기록이 없는 턴도 포함): 시계가 뒤로 맞춰져도 같다. 목록이 없는 취소(이전 기록)만 턴 시작 시각과 취소 시각을 견준다. 취소 뒤에 시작된 턴의
   * 요청은 취소를 알고 한 별도 되돌리기로 받는다. 요청을 받을 때와 프로젝트 잠금 안에서 만들기 바로 앞(같은 동기 구간)에서 본다
   */
  private assertRevertRequestCurrent(origin: RevertOrigin | null): void {
    if (!origin) return;
    const ctx = this.ctx;
    const prefix = origin.sessionKey.split(':', 1)[0];
    if (prefix !== 'directive' && prefix !== 'task' && prefix !== 'review') return;
    const { kind, ref } = parseKey(origin.sessionKey);
    const directiveId = kind === 'directive' ? ref : (ctx.store.tasks.get(ref)?.directiveId ?? null);
    const d = directiveId ? ctx.store.directives.get(directiveId) : null;
    if (!d || d.state !== 'cancelled' || !d.cancelledAt) return;
    const snap = cancelSnapshotOf(ctx, d.id);
    const startedBefore = snap
      ? snap.turns.includes(origin.turnId) || !ctx.store.turns.get(origin.turnId)
      : !(origin.turnStartedAt && origin.turnStartedAt >= d.cancelledAt);
    if (!startedBefore) return;
    throw new BackendError(
      'conflict',
      `이 턴이 시작된 뒤 지시 ${d.id}이(가) 취소돼 이 턴의 되돌리기 요청은 받지 않았습니다 — 지시 취소는 미완료 작업만 취소하고 완료된 변경과 main 반영은 유지합니다 (TSK-09). 지금 턴을 마치세요. 취소된 지시의 완료 변경을 따로 되돌려야 하면 그 뒤의 턴에서 다시 요청하세요`,
    );
  }

  /**
   * 되돌리기 작업 기록만 만든다 (작업 폴더·커밋은 advanceRevert). 작업과 원래 작업의 연결을 한 번에 남긴다 — 사이에 끊겨 연결 없는
   * 되돌리기 작업이 남으면 다시 요청할 때 두 번째 되돌리기가 생긴다
   */
  private createRevertTask(orig: Task, producer: Member, reason: string, origin: RevertOrigin | null): Task {
    const ctx = this.ctx;
    // 잠금을 기다리는 사이 이 요청을 보낸 턴의 지시가 취소됐으면 만들지 않는다 (AC-46) — 만들기와 같은 동기 구간에서 다시 본다
    this.assertRevertRequestCurrent(origin);
    // 잠금을 기다리는 사이 다른 요청(다른 request_id로 다시 보낸 같은 되돌리기)이 이미 만들었으면 그것을 돌려준다 (CONC-08, ERR-07)
    const fresh = taskOrThrow(ctx, orig.id);
    const existing = fresh.revertedByTaskId ? ctx.store.tasks.get(fresh.revertedByTaskId) : null;
    if (existing && existing.state !== 'cancelled') return existing;
    const project = projectOrThrow(ctx, orig.projectId);
    const now = ctx.now();
    const id = ctx.store.nextId('task');
    const draft: Task = {
      id,
      projectId: orig.projectId,
      directiveId: orig.directiveId,
      round: orig.round,
      title: `[되돌리기] ${orig.title}`,
      goal: `${orig.id}의 병합 변경만 취소하고 이후 다른 작업의 변경은 유지한다. 사유: ${reason}`,
      type: 'revert',
      priority: 'high',
      assigneeId: producer.id,
      reviewerId: null,
      prerequisiteIds: [],
      acceptanceCriteria: [`${orig.id}의 변경 효과만 취소된다`, '이후 병합된 다른 작업의 변경은 유지된다', '자동 검사를 통과한다'],
      plannedAreas: [],
      outputMode: 'repo',
      state: 'waiting',
      hold: { reasons: [], returnState: null },
      workspace: null,
      review: emptyReviewState(),
      contributors: [producer.id],
      merge: null,
      artifact: null,
      revertOfTaskId: orig.id,
      revertedByTaskId: null,
      skillsUsed: [],
      pendingSubmit: null,
      conflict: null,
      crashRetries: 0,
      noProgressResumes: 0,
      createdBy: producer.id,
      createdAt: now,
      updatedAt: now,
      queuedAt: now,
      activatedAt: null,
      completedAt: null,
      cancelledAt: null,
    };
    draft.reviewerId = chooseReviewer(draft, projectMembers(ctx, project.id), (r) => roleOf(ctx, r));
    ctx.store.tx(() => {
      ctx.store.tasks.insert(draft);
      ctx.store.tasks.patch(orig.id, { revertedByTaskId: id });
      ctx.store.transitions.append({ entity: 'task', entityId: id, from: '-', event: 'create', to: 'waiting', reason: `${orig.id} 되돌리기 요청 (프로그램 작업)`, actor: producer.id, at: now, requestId: null });
      ctx.activity({ kind: 'revert', actor: producer.id, projectId: project.id, taskId: orig.id, text: `${orig.id} 되돌리기 작업 ${id} 생성: ${reason}` });
    });
    return draft;
  }

  /** 되돌리기 작업의 프로그램 단계(되돌리기 커밋)가 기록됐으면 그 단계 */
  private revertStepOf(t: Task): Step | null {
    if (!t.revertOfTaskId) return null;
    const title = revertStepTitle(t.revertOfTaskId);
    return this.ctx.store.steps.list(t.id).find((s) => s.done && !!s.commitSha && s.title === title) ?? null;
  }

  /**
   * 되돌리기 작업의 프로그램 단계(작업 폴더 → 되돌리기 커밋 기록)가 아직 남았는지 (CLI-09: 되돌리기는 프로그램이 한다). 남은 동안은
   * 일반 작업으로 넘기지 않는다 — 활성화 카드·'이어서 진행'을 받은 담당(프로듀서)이 되돌리지 않은 결과를 되돌리기로 병합하게 된다 (AC-12).
   * 충돌로 보류된 되돌리기를 프로듀서가 재계획(replan_task)으로 넘겨받았으면 그 뒤로는 담당이 직접 되돌리는 일반 작업이다
   */
  revertPending(t: Task): boolean {
    if (!isProgramRevert(t) || isTerminal(t.state) || this.revertStepOf(t)) return false;
    return !this.ctx.store.transitions.list(t.id).some((x) => x.event === 'replanned');
  }

  /**
   * 되돌리기 작업의 프로그램 단계를 이어 간다 (재시작 복구·보류 해제·스케줄러 공용, GIT-15). 그 프로젝트 잠금 안에서 지금 상태부터 다시
   * 확인하므로 여러 번 불러도 같다 — 되돌리기 커밋이 이미 작업 폴더에 있으면 다시 만들지 않고 기록만 한다
   */
  resumeRevert(taskId: string): Promise<void> {
    const running = this.revertJobs.get(taskId);
    if (running) return running;
    const t = this.ctx.store.tasks.get(taskId);
    if (!t || !this.revertPending(t)) return Promise.resolve();
    return this.trackRevert(taskId, () => this.core.locks.run(t.projectId, `revert:${t.revertOfTaskId}`, () => this.advanceRevert(taskId)));
  }

  /**
   * 되돌리기 단계 처리를 기록해 둔다 — 그동안 isPending·settled가 이 작업을 진행 중으로 본다 (취소는 끝나기를 기다린 뒤 작업 폴더를 보관·정리,
   * 스케줄러는 그 작업 폴더에 턴을 띄우지 않음). 이미 기록된 처리가 있으면(잠금 뒤에서 기다리는 resumeRevert) 그 처리가 이 잠금 뒤에 끝나므로
   * 새로 기록하지 않고 실행만 한다
   */
  private trackRevert(taskId: string, fn: () => Promise<void>): Promise<void> {
    const ctx = this.ctx;
    if (this.revertJobs.has(taskId)) return fn().catch((e: unknown) => this.revertFailed(taskId, e));
    const job: Promise<void> = fn()
      .catch((e: unknown) => this.revertFailed(taskId, e))
      .finally(() => {
        if (this.revertJobs.get(taskId) === job) this.revertJobs.delete(taskId);
        ctx.bus.changed();
        ctx.bus.signal('tick');
      });
    this.revertJobs.set(taskId, job);
    ctx.bus.changed(); // 진행 중 작업 여부(절전 방지) 다시 보기
    return job;
  }

  /**
   * 되돌리기 프로그램 단계 (프로젝트 잠금 안, GIT-10·13·15, CLI-09): ① 대기면 작업 폴더(최신 main) → 진행 ② 되돌리기 커밋 —
   * 작업 폴더 HEAD가 이미 그 커밋이면(커밋 뒤 기록 전에 끊김) 다시 만들지 않는다 ③ 커밋 기록·제출 요청과 뒤 작업 의존성 보류를 한 번에
   * 남긴다 → 의존하는 뒤 작업이 없으면 제출 처리(최신 main 반영·자동 검사·검수). 정지·보류·취소가 들어오면 기록하지 않고 멈춘다 —
   * 풀리면 다시 부른다. 충돌하면 보류(재계획) + 프로듀서 [replan] (7.1)
   */
  private async advanceRevert(taskId: string): Promise<void> {
    const ctx = this.ctx;
    const git = ctx.deps.git;
    // 지시 취소 선택이 저장되면 그 지시의 일은 더 진행하지 않는다 — 지시 취소가 아직 이 작업 차례에 오지 않았어도 (제출·병합의 확인과 같다, CTL-08,
    // AC-46). 지시 취소 전부터 있던 되돌리기는 그 지시의 미완료 작업이라 함께 취소된다 — 작업 폴더에 되돌리기 커밋을 만들거나 기록하지 않는다. 지시
    // 취소 뒤에 요청한 별도 되돌리기는 closedDirectiveWork가 빼므로 계속 간다 (S7-B6)
    let closedNoted = false;
    const live = (): Task | null => {
      const t = ctx.store.tasks.get(taskId);
      if (!t || !this.revertPending(t) || !this.core.stops.runAllowedForTask(t) || this.core.tasks.isCancelling(taskId)) return null;
      if (closedDirectiveWork(ctx, null, t)) {
        if (!closedNoted) {
          closedNoted = true;
          ctx.activity({
            kind: 'revert',
            level: 'warn',
            projectId: t.projectId,
            directiveId: t.directiveId,
            taskId,
            text: `${taskId} 되돌리기 단계 멈춤 — 지시 ${t.directiveId}이(가) 취소·종료돼 되돌리기 커밋을 기록하지 않음 (main은 그대로, 지시 취소가 이 작업을 보관·취소)`,
          });
        }
        return null;
      }
      return t;
    };
    let rt = live();
    if (!rt) return;
    const orig = taskOrThrow(ctx, rt.revertOfTaskId!);
    const mergeSha = orig.merge?.mergeCommitSha;
    if (!mergeSha) throw new Error(`되돌릴 ${orig.id}의 병합 기록이 없습니다`);
    if (rt.state === 'waiting') {
      try {
        await this.core.tasks.ensureWorkspace(rt);
      } catch (e) {
        // 일반 작업 활성화와 같게: 보류(오류) + 메인 에이전트에게 알림 업무(alert ws-fail:<작업>) + 긴급 알림 → 원인을 정리한 뒤 메인 에이전트가 재개 (재개되면
        // 스케줄러가 이 단계를 다시 부른다). 이미 끝난 작업이면 보류할 것도 알릴 것도 없다 (리드 결정 S5-7·S5-9 — 알림은 보류 뒤)
        const msg = e instanceof Error ? e.message : String(e);
        const t = ctx.store.tasks.get(taskId);
        if (t && !isTerminal(t.state)) {
          this.core.tasks.hold(taskId, 'error', 'task', `되돌리기 작업 폴더 생성 실패: ${msg}`, 'system');
          const handed = alertTaskHold(ctx, 'ws-fail', taskId, { cause: '되돌리기 작업 폴더를 만들지 못해 보류됨' });
          ctx.notify({
            level: 'urgent',
            title: '작업 공간 생성 실패',
            body: `${taskId}: ${msg} — 작업을 보류${handed ? `하고 ${OWNER_HANDED}` : `했습니다. ${ownerExit(false)}`}`,
            link: { tab: 'projects', projectId: rt.projectId, taskId },
            key: `ws-fail:${taskId}`,
          });
        }
        return;
      }
      if (!(rt = live()) || rt.state !== 'waiting') return;
      rt = transitionTask(ctx, taskId, { type: 'activate' }, 'system');
    }
    if (rt.state !== 'in_progress') return;
    if (!rt.workspace) throw new Error('되돌리기 작업 폴더가 없습니다');
    const ws = rt.workspace;
    const id = taskId;
    const head = await git.revParse(ws.worktreePath, 'HEAD');
    if (!live()) return;
    let sha = head && (await this.isRevertCommit(ws.worktreePath, head, id, orig.id)) ? head : null;
    if (!live()) return;
    if (sha) {
      ctx.activity({ kind: 'revert', projectId: orig.projectId, taskId: id, text: `${id} 되돌리기 커밋 ${sha.slice(0, 8)}이(가) 이미 작업 폴더에 있음 — 다시 만들지 않고 기록 (GIT-15)` });
    } else {
      const res = await recordedExec(
        ctx,
        {
          kind: 'git_revert',
          projectId: orig.projectId,
          taskId: id,
          cwd: ws.worktreePath,
          command: `git revert -m 1 ${mergeSha.slice(0, 8)}`,
          target: ws.branch,
          // 재시작 때 작업 폴더 HEAD를 커밋 전 HEAD와 대조한다 (recovery reconcileExec)
          pre: { head },
        },
        async () => {
          const r = await git.revertMerge(ws.worktreePath, mergeSha, `${revertSubject(id, orig.id)}\n\nWook-Revert-Of: ${orig.id}`, memberIdentity(null));
          return { value: r, result: r.ok ? { sha: r.sha } : { conflicts: r.conflicts, detail: r.detail }, failed: !r.ok };
        },
      );
      // 기다리는 사이 정지·보류·취소됐으면 기록하지 않는다 — 풀리면 다시 이 단계에서 (커밋이 있으면 그것을 기록, 충돌이면 다시 보류)
      if (!live()) return;
      if (!res.ok) {
        const why = res.conflicts.length ? `충돌: ${res.conflicts.join(', ')}` : res.detail;
        this.holdRevert(
          id,
          `되돌리기 ${why}`,
          `${orig.id} 되돌리기(${id})가 이후 변경과 맞지 않아 보류됐습니다 (${why}). 작업 폴더에는 되돌리기를 남기지 않았고 main은 그대로입니다.`,
          `정했으면 replan_task(task_id="${id}")로 다시 진행시키세요 — 담당이 그 작업 폴더에서 직접 되돌린 뒤 제출합니다(필요하면 담당·완료 조건 조정). 되돌리지 않기로 했으면 cancel_task(task_id="${id}").`,
        );
        return;
      }
      sha = res.sha;
    }
    // 커밋 기록 + 제출 요청 + (뒤 작업이 기대면) 보류를 한 트랜잭션으로 — 사이에서 끊겨 의존성 확인 없이 제출 처리로 넘어가지 않게
    const dependents = this.revertDependents(orig, id);
    const committed = sha;
    ctx.store.tx(() => {
      ctx.store.steps.replaceAll(id, [{ taskId: id, idx: 0, title: revertStepTitle(orig.id), done: true, doneAt: ctx.now(), commitSha: committed, note: '프로그램 수행' }]);
      ctx.store.tasks.patch(id, { pendingSubmit: { requestedAt: ctx.now(), note: '되돌리기 커밋 생성' } });
      if (dependents.length) {
        // 기대는 작업 목록(상태 포함)은 holdRevert가 [replan]에 적고 기록한다
        this.holdRevert(
          id,
          `되돌리기 의존성: ${dependents.map((t) => t.id).join(', ')}이(가) ${orig.id}에 기댐`,
          `${orig.id} "${orig.title}" 되돌리기(${id})를 보류했습니다: 뒤 작업이 ${orig.id}을(를) 선행 작업으로 두고 있어, 되돌리면 그 작업들이 기대는 변경이 사라집니다 (7.1). 되돌리기 커밋은 되돌리기 작업 폴더에만 있고 main은 그대로입니다.`,
          `함께 되돌릴 작업은 request_revert, 고칠 작업은 새 작업으로 처리하세요. 그대로 진행해도 되면 replan_task(task_id="${id}")로 다시 진행시키세요 — 자동 검사·독립 검수·병합으로 이어집니다. 되돌리지 않기로 했으면 cancel_task(task_id="${id}").`,
        );
      }
    });
    ctx.activity({ kind: 'revert', projectId: orig.projectId, taskId: id, text: `${id} 되돌리기 커밋 ${committed.slice(0, 8)} 기록${dependents.length ? ` — 뒤 작업 의존성으로 보류 (${dependents.map((t) => t.id).join(', ')})` : ''}` });
    if (!dependents.length) void this.core.tasks.processSubmission(id);
  }

  /** 작업 폴더 HEAD가 이 되돌리기 작업이 만든 되돌리기 커밋인지 (메시지 첫 줄·Wook-Revert-Of 줄, 부모 하나) */
  private async isRevertCommit(wt: string, head: string, revertTaskId: string, origId: string): Promise<boolean> {
    const [c] = await this.ctx.deps.git.log(wt, head, 1).catch(() => []);
    return !!c && c.parents.length === 1 && c.subject === revertSubject(revertTaskId, origId) && c.body.includes(`Wook-Revert-Of: ${origId}`);
  }

  /**
   * 되돌릴 작업에 기대는 뒤 작업 (7.1 '뒤의 작업이 되돌릴 변경에 의존하면'): 그 작업을 선행 작업으로 둔 작업과, 다시 그 작업에 기대는
   * 작업까지. 완료(병합)된 것과 아직 진행 중인 것 모두. 취소됐거나 이미 되돌려진 작업은 그 변경이 main에 없으므로 뺀다
   */
  private revertDependents(orig: Task, revertTaskId: string): Task[] {
    const ctx = this.ctx;
    const all = ctx.store.tasks.list({ project_id: orig.projectId });
    const reverted = (t: Task) => !!t.revertedByTaskId && ctx.store.tasks.get(t.revertedByTaskId)?.state === 'done';
    const found = new Map<string, Task>();
    const next = [orig.id];
    while (next.length) {
      const cur = next.shift()!;
      for (const t of all) {
        if (t.id === revertTaskId || t.id === orig.id || found.has(t.id) || !t.prerequisiteIds.includes(cur)) continue;
        if (t.state === 'cancelled' || reverted(t)) continue;
        found.set(t.id, t);
        next.push(t.id);
      }
    }
    return [...found.values()];
  }

  /**
   * 되돌리기를 자동으로 진행하지 않고 보류한다 (GIT-10, 7.1 '충돌·의존성·검사 실패 → 보류, 프로듀서가 조정 범위를 계획'): 재계획 보류 +
   * 프로듀서 [replan] + 알림. 대표의 단순 재개로는 풀리지 않고 프로듀서의 replan_task(다시 진행)·cancel_task(취소)로만 풀린다.
   * 어떤 작업까지 함께 조정할지 정하려면 되돌릴 변경에 기대는 뒤 작업을 알아야 한다 — 어떤 보류든(충돌·의존성·검사 실패) 지금 목록을 [replan]에 적고
   * 보류와 같은 트랜잭션으로 기록한다(kv revertdeps). 그 뒤 재계획했으면 프로듀서가 확인한 목록이다 — 병합 직전에 다시 볼 때 그 밖의 작업이 있으면
   * 다시 보류한다 (holdForNewDependents). within: 보류와 같은 트랜잭션 안에서 그 보류 전이의 순번으로 남길 기록 (그 뒤에 재계획했는지 전이 순서로 본다)
   */
  holdRevert(revertTaskId: string, note: string, situation: string, next: string, within?: (holdSeq: number) => void): void {
    const ctx = this.ctx;
    const rt = taskOrThrow(ctx, revertTaskId);
    const producer = producerOf(ctx, rt.projectId);
    const orig = rt.revertOfTaskId ? ctx.store.tasks.get(rt.revertOfTaskId) : null;
    const deps = orig ? this.revertDependents(orig, rt.id) : [];
    const depsLine = orig && deps.length ? ` ${orig.id}을(를) 선행 작업으로 둔 뒤 작업(이어서 기대는 작업 포함): ${deps.map((t) => `${t.id} "${t.title}"(${TASK_STATE_LABEL[t.state]})`).join(', ')}.` : '';
    ctx.store.tx(() => {
      this.core.tasks.hold(rt.id, 'replan', 'task', note, 'system');
      const all = ctx.store.transitions.list(rt.id);
      const holdSeq = all[all.length - 1]?.seq ?? 0;
      if (deps.length) this.noteListedDependents(rt.id, deps.map((t) => t.id), holdSeq);
      within?.(holdSeq);
      enqueue(ctx, {
        kind: 'replan',
        memberId: producer.id,
        sessionKey: directiveKey(rt.directiveId),
        projectId: rt.projectId,
        taskId: rt.id,
        directiveId: rt.directiveId,
        priority: 'high',
        message: `${situation}${depsLine} 어떤 작업까지 함께 조정할지 계획하세요 (이후 변경을 통째로 지우지 않음, 7.1). ${next}`,
        dedupeKind: true,
      });
    });
    ctx.notify({ level: 'normal', title: '되돌리기 보류', body: `${rt.revertOfTaskId ?? rt.id} 되돌리기가 보류됐습니다 (${note})`, link: { tab: 'projects', projectId: rt.projectId, taskId: rt.id } });
  }

  /** 되돌리기 보류 때 프로듀서에게 알린 뒤 작업 목록을 그 보류 전이의 순번과 함께 남긴다 (보류와 같은 트랜잭션 안에서) */
  private noteListedDependents(revertTaskId: string, ids: string[], seq: number): void {
    const ctx = this.ctx;
    const key = revertDepsKey(revertTaskId);
    ctx.store.kv.set<ListedDependents>(key, [...(ctx.store.kv.get<ListedDependents>(key) ?? []), { seq, ids }]);
  }

  /**
   * 프로듀서가 확인한 뒤 작업: 보류 때 알린 목록 가운데 그 보류 뒤에 재계획(replan_task)한 것 — 재계획은 그 보류를 풀 수 있는 프로듀서의 판단이다.
   * 순서는 상태 전이 순번으로 본다 (시계가 뒤로 맞춰져도 같다)
   */
  private acceptedDependents(rt: Task): Set<string> {
    const ctx = this.ctx;
    const lastReplan = ctx.store.transitions
      .list(rt.id)
      .filter((x) => x.event === 'replanned')
      .reduce((m, x) => Math.max(m, x.seq), 0);
    const listed = ctx.store.kv.get<ListedDependents>(revertDepsKey(rt.id)) ?? [];
    return new Set(listed.filter((l) => l.seq < lastReplan).flatMap((l) => l.ids));
  }

  /**
   * 병합 직전(main을 바꾸기 바로 앞, 잠금 안) 되돌릴 변경에 기대는 뒤 작업을 다시 보고, 프로듀서가 지난 보류·재계획 때 확인하지 않은 작업이 있으면
   * main을 바꾸지 않고 보류한다 (7.1 '뒤의 작업이 되돌릴 변경에 의존하면 보류', GIT-10, AC-12). 커밋 때의 의존성 보류와 같게 제출 요청을 남긴다 —
   * 재계획하면 최신 main 반영·자동 검사·독립 검수·병합으로 다시 이어지고, 그때는 이번에 알린 작업이 확인된 목록이다. 보류했으면 true
   */
  private holdForNewDependents(taskId: string, requestId: string | null): boolean {
    const ctx = this.ctx;
    const rt = taskOrThrow(ctx, taskId);
    const orig = rt.revertOfTaskId ? ctx.store.tasks.get(rt.revertOfTaskId) : null;
    if (!orig) return false;
    const accepted = this.acceptedDependents(rt);
    const fresh = this.revertDependents(orig, rt.id).filter((t) => !accepted.has(t.id));
    if (!fresh.length) return false;
    const ids = fresh.map((t) => t.id).join(', ');
    ctx.store.tx(() => {
      ctx.store.tasks.patch(taskId, { pendingSubmit: { requestedAt: ctx.now(), note: '되돌리기 의존성 재계획 뒤 다시 제출' } });
      this.holdRevert(
        taskId,
        `되돌리기 의존성(병합 직전 확인): ${ids}이(가) ${orig.id}에 기댐`,
        `${orig.id} "${orig.title}" 되돌리기(${taskId})를 main에 병합하기 직전에 뒤 작업을 다시 확인하니, 지난 보류·재계획 때 확인하지 않은 작업 ${ids}이(가) ${orig.id}에 기대고 있어 병합하지 않고 보류했습니다 (7.1). 되돌리면 그 작업들이 기대는 변경이 사라집니다. main은 그대로입니다.`,
        `함께 되돌릴 작업은 request_revert, 고칠 작업은 새 작업으로 처리하세요. 그대로 진행해도 되면 replan_task(task_id="${taskId}")로 다시 진행시키세요 — 최신 main 반영·자동 검사·독립 검수를 다시 거쳐 병합합니다. 되돌리지 않기로 했으면 cancel_task(task_id="${taskId}").`,
      );
    });
    ctx.activity({ kind: 'revert', level: 'warn', projectId: rt.projectId, taskId, requestId, text: `${taskId} 병합 직전 뒤 작업 의존성 다시 확인 — 확인되지 않은 ${ids}이(가) ${orig.id}에 기대 main을 바꾸지 않고 보류(재계획)` });
    return true;
  }

  /** 되돌리기 프로그램 단계의 오류. 처리 중 상태가 바뀐 경합은 실패가 아니다(풀리면 다시). 실제 실패는 보류(오류) + 긴급 알림 → 원인 정리 뒤 메인 에이전트 재개 */
  private revertFailed(taskId: string, e: unknown): void {
    const ctx = this.ctx;
    try {
      const msg = e instanceof Error ? e.message : String(e);
      const t = ctx.store.tasks.get(taskId);
      if (e instanceof TransitionError) {
        ctx.log('warn', `되돌리기 처리 중 상태 변경 ${taskId}`, e);
        return;
      }
      ctx.log('error', `되돌리기 처리 실패 ${taskId}`, e);
      if (!t || isTerminal(t.state)) return;
      this.core.tasks.hold(taskId, 'error', 'task', `되돌리기 처리 실패: ${msg}`, 'system');
      const handed = alertTaskHold(ctx, 'revert-fail', taskId, { cause: '되돌리기 처리(프로그램 단계)가 실패해 보류됨' });
      ctx.notify({ level: 'urgent', title: '되돌리기 실패', body: `${taskId}: ${msg} — 되돌리기를 보류${handed ? `하고 ${OWNER_HANDED}` : `했습니다. ${ownerExit(false)}`}`, link: { tab: 'projects', projectId: t.projectId, taskId }, key: `revert-fail:${taskId}` });
    } catch (err) {
      ctx.log('error', `되돌리기 실패 처리 오류 ${taskId}`, err);
    }
  }
}
