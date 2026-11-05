/**
 * 실행 허용 검사 (CTL-09). 순서: 전역 긴급 정지 → 프로젝트·팀원·작업 정지 → 취소·미해소 보류/복구 확인
 * → 인증·사용량·CLI → 선행 작업. 모두 통과해야 새 턴·병합·재시도를 시작한다. 실행 자리는 scheduling.ts가 본다.
 */
import type { AiAvailability, Member, StopState, Task, WorkKind } from '@shared/domain';
import { HOLD_REASON_LABEL } from '@shared/labels';
import { activeUsageLimit, MODEL_FAMILY_LABEL } from './usageLimits';

export type GateBlock =
  | 'global_stop'
  | 'project_paused'
  | 'member_paused'
  | 'member_deleted'
  | 'task_closed'
  | 'task_held'
  | 'recovery'
  | 'auth'
  | 'usage_limit'
  | 'cli_problem'
  | 'prereq';

export type GateResult = { ok: true } | { ok: false; block: GateBlock; detail: string };

export interface GateInput {
  stop: StopState;
  /** 실행할 팀원 */
  member: Member;
  kind: WorkKind;
  /** 업무와 묶인 작업 (작업 수행·충돌 해결·검수·병합 판단, 작업 세션으로 가는 메시지) */
  task: Task | null;
  /** 작업 세션으로 가는 업무인지 (메시지 포함) */
  taskBound: boolean;
  /** 이 작업에 미해소 복구 확인이 있는지 */
  recoveryPending: boolean;
  /** 모의 실행이면 null (AI 가용성 무관) */
  ai: AiAvailability | null;
  /**
   * 이 턴이 쓸 모델 (CLI에 넘길 값). 모델별 주간 한도는 그 계열 모델의 턴만 막는다. null·생략 = 정하지 않음(CLI 기본 모델) — 기본 모델을 알 수
   * 없으므로 모든 모델별 한도에 걸린다 (리드 결정 22)
   */
  model?: string | null;
  /** 대기 작업 활성화 판단일 때만 값이 있음 */
  prereqsDone: boolean | null;
  nowMs: number;
}

/** 작업이 반드시 실행 가능한 상태여야 하는 업무 종류 */
export const TASK_BOUND_KINDS: readonly WorkKind[] = ['task_work', 'conflict_fix', 'review', 'merge_decision'];

function no(block: GateBlock, detail: string): GateResult {
  return { ok: false, block, detail };
}

export function checkRunGate(i: GateInput): GateResult {
  if (i.stop.global.active) return no('global_stop', '긴급 정지 중');
  if (i.member.projectId && i.stop.projects[i.member.projectId]?.paused) return no('project_paused', '프로젝트 일시정지');
  if (i.stop.members[i.member.id]?.paused) return no('member_paused', '팀원 일시정지');
  if (i.member.deletedAt) return no('member_deleted', '삭제된 팀원');
  if (i.task && (i.taskBound || TASK_BOUND_KINDS.includes(i.kind))) {
    if (i.task.state === 'done' || i.task.state === 'cancelled') return no('task_closed', `작업 ${i.task.id}이(가) 끝났습니다`);
    if (i.task.state === 'on_hold') {
      const labels = i.task.hold.reasons.map((r) => HOLD_REASON_LABEL[r.kind]).join(', ');
      return no('task_held', `작업 ${i.task.id} 보류 중 (${labels})`);
    }
  }
  if (i.recoveryPending) return no('recovery', '복구 확인 대기');
  if (i.ai) {
    if (i.ai.authRequired) return no('auth', `${i.ai.kind} 인증 만료 — 재로그인 필요`);
    const limit = activeUsageLimit(i.ai, i.model, i.nowMs);
    if (limit) {
      return no('usage_limit', limit.family ? `${i.ai.kind} ${MODEL_FAMILY_LABEL[limit.family]} 주간 한도 (${limit.until}까지, 이 모델 계열의 턴만)` : `${i.ai.kind} 사용량 한도 (${limit.until}까지)`);
    }
    if (!i.ai.cliInstalled) return no('cli_problem', `${i.ai.kind} CLI가 설치되지 않았습니다`);
    if (i.ai.cliProblem) return no('cli_problem', i.ai.cliProblem);
  }
  if (i.prereqsDone === false) return no('prereq', '선행 작업 대기');
  return { ok: true };
}
