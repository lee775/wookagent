/**
 * 팀원 상태 (기획서 5.4). 겹치면 일시정지 → 오류 → 답변 대기 → 업무 중 → 대기 순으로 대표 상태를 고르고,
 * 나머지 사유도 함께 돌려준다 (상세 화면 표시용).
 */
import type { AiAvailability, Member, StopState, Task } from '@shared/domain';
import type { MemberStatus } from '@shared/views';
import { activeUsageLimit, MODEL_FAMILY_LABEL } from './usageLimits';

export interface MemberStatusInput {
  member: Member;
  stop: StopState;
  /** 실행 중 턴 설명 (없으면 null) */
  runningLabel: string | null;
  /** 담당 미완료 작업 (활성 작업 포함) */
  assignedTasks: readonly Task[];
  /** 이 팀원의 대기열 항목 수 */
  queued: number;
  /** 모의 실행이면 null */
  ai: AiAvailability | null;
  /** 이 팀원의 턴이 쓸 모델 — 모델별 주간 한도가 걸렸는지 본다. 생략·null = 정하지 않음(그 종류의 모든 모델별 한도에 걸림, 리드 결정 22) */
  model?: string | null;
  /** 팀원 단위 오류 (예: 바이패스 불일치로 멈춤) */
  memberError: string | null;
  /** 답변을 기다리는 질문 내용 (요약) */
  openQuestions: readonly string[];
  nowMs: number;
}

const ORDER: MemberStatus[] = ['paused', 'error', 'awaiting_answer', 'working', 'idle'];

function hhmm(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Seoul' });
}

/** 기한 표시: 하루 안이면 시각만, 그보다 멀면(주간 한도 등) 날짜도 */
function untilText(iso: string, nowMs: number): string {
  if (Date.parse(iso) - nowMs < 24 * 3600_000) return hhmm(iso);
  const day = new Date(iso).toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', timeZone: 'Asia/Seoul' });
  return `${day} ${hhmm(iso)}`;
}

export function deriveMemberStatus(i: MemberStatusInput): { status: MemberStatus; reasons: string[] } {
  const found = new Map<MemberStatus, string[]>();
  const add = (s: MemberStatus, why: string) => {
    const list = found.get(s) ?? [];
    if (!list.includes(why)) list.push(why);
    found.set(s, list);
  };

  if (i.stop.global.active) add('paused', '긴급 정지');
  if (i.member.projectId && i.stop.projects[i.member.projectId]?.paused) add('paused', '프로젝트 일시정지');
  if (i.stop.members[i.member.id]?.paused) add('paused', '팀원 일시정지');

  if (i.memberError) add('error', i.memberError);
  if (i.ai?.authRequired) add('error', `${i.ai.kind} 인증 만료 — 재로그인 필요`);
  if (i.ai && (!i.ai.cliInstalled || i.ai.cliProblem)) add('error', i.ai.cliProblem ?? `${i.ai.kind} CLI 없음`);

  for (const t of i.assignedTasks) {
    if (t.state !== 'on_hold') continue;
    for (const r of t.hold.reasons) {
      switch (r.kind) {
        case 'error':
          add('error', `${t.id} 오류: ${r.note || '자동 복구 실패'}`);
          break;
        case 'recovery_check':
          add('error', `${t.id} 복구 확인 필요`);
          break;
        case 'answer_wait':
          add('awaiting_answer', `${t.id} 답변 대기`);
          break;
        case 'replan':
          add('idle', `${t.id} 재계획 대기`);
          break;
        case 'blocked':
          add('idle', `${t.id} 막힘 보고 — 프로듀서 조치 대기`);
          break;
        // 대표가 멈춘 작업은 항목별 재개 전까지 실행하지 않으므로 일시정지로 표시 (5.4, CTL-10) — 저절로 풀리는 대기와 구분
        case 'emergency_stop':
          if (!i.stop.global.active) add('paused', `${t.id} 긴급 정지 — 항목별 재개 대기`);
          break;
        case 'interrupted':
          add('paused', `${t.id} 중단됨 — 재개 대기`);
          break;
        case 'merge_blocked':
          add('idle', `${t.id} 병합 보류`);
          break;
        case 'prereq_cancelled':
          add('idle', `${t.id} 선행 작업 취소 — 프로듀서 조치 대기`);
          break;
        case 'paused':
          break; // 정지 범위 사유는 위에서 처리
      }
    }
  }
  for (const q of i.openQuestions) add('awaiting_answer', `답변 대기: ${q}`);

  if (i.runningLabel) add('working', i.runningLabel);

  // 대기 사유
  const limit = i.ai ? activeUsageLimit(i.ai, i.model, i.nowMs) : null;
  if (limit) add('idle', `${limit.family ? `${MODEL_FAMILY_LABEL[limit.family]} 주간 한도` : '사용량 한도'} (${untilText(limit.until, i.nowMs)}까지)`);
  const active = i.assignedTasks.find((t) => t.activatedAt && t.state !== 'done' && t.state !== 'cancelled');
  if (active?.state === 'in_review') add('idle', active.review.passed ? `${active.id} 병합 순서 대기` : `${active.id} 검수 결과 대기`);
  if (!i.runningLabel && i.queued > 0) add('idle', '실행 자리 대기');
  if (!active && i.assignedTasks.some((t) => t.state === 'waiting')) add('idle', '선행 작업·차례 대기');
  // 턴이 끝난 뒤 프로그램이 제출을 처리하는 동안(최신 main 반영·자동 검사)에는 턴도 대기 항목도 없다
  if (active?.state === 'in_progress' && !i.runningLabel && i.queued === 0) {
    add('idle', active.review.autoCheck.status === 'running' ? `${active.id} 자동 검사 중` : active.pendingSubmit ? `${active.id} 검수 제출 처리 중` : `${active.id} 다음 턴 준비 중`);
  }
  if (!found.size) add('idle', i.assignedTasks.length ? `${i.assignedTasks[0]!.id} 처리 대기` : '맡은 작업 없음');

  const status = ORDER.find((s) => found.has(s)) ?? 'idle';
  const reasons = [...(found.get(status) ?? []), ...ORDER.filter((s) => s !== status).flatMap((s) => found.get(s) ?? [])];
  return { status, reasons };
}
