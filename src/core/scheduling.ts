/**
 * 실행 자리 배정 (5.7, ORG-07, ORG-09, TSK-05, CLI-20).
 * - 전체 상한 N. N≥2면 관리 1자리 예약 → 일반 작업 최대 N-1. N=1이면 예약 없이 관리 업무 먼저
 * - 팀원당 실행 중 1개, 세션당 프로세스 1개
 * - 관리 업무 먼저, 같은 분류에서는 우선순위 → 대기 등록 시각
 * 후보는 실행 허용 검사(runGate)를 이미 통과한 것만 넘긴다.
 */
import type { Priority, SlotClass } from '@shared/domain';
import { PRIORITY_RANK } from '@shared/domain';

export interface RunningSlot {
  memberId: string;
  sessionKey: string;
  slotClass: SlotClass;
}

export interface StartCandidate {
  /** 세션 키 (작업 활성화 후보는 'task:<id>') */
  sessionKey: string;
  memberId: string;
  slotClass: SlotClass;
  priority: Priority;
  /** 정렬 기준 시각 (대기열 항목 중 가장 이른 것 / 작업 queuedAt) */
  queuedAt: string;
  /** 대표 직접 메시지 등 우선 전달 */
  urgent: boolean;
  /** 대기 작업 활성화 후보면 작업 ID */
  activateTaskId?: string;
}

export interface SlotCaps {
  total: number;
  general: number;
}

export function slotCaps(n: number): SlotCaps {
  const total = Math.max(1, Math.floor(n));
  return { total, general: total >= 2 ? total - 1 : total };
}

export function compareCandidates(a: StartCandidate, b: StartCandidate): number {
  if (a.slotClass !== b.slotClass) return a.slotClass === 'management' ? -1 : 1;
  if (a.urgent !== b.urgent) return a.urgent ? -1 : 1;
  const pr = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
  if (pr !== 0) return pr;
  if (a.queuedAt !== b.queuedAt) return a.queuedAt < b.queuedAt ? -1 : 1;
  return a.sessionKey < b.sessionKey ? -1 : a.sessionKey > b.sessionKey ? 1 : 0;
}

/** 지금 시작할 후보들을 순서대로 고른다 */
export function pickStarts(input: { cap: number; running: readonly RunningSlot[]; candidates: readonly StartCandidate[] }): StartCandidate[] {
  const caps = slotCaps(input.cap);
  let total = input.running.length;
  let general = input.running.filter((r) => r.slotClass === 'general').length;
  const busyMembers = new Set(input.running.map((r) => r.memberId));
  const busySessions = new Set(input.running.map((r) => r.sessionKey));
  const picked: StartCandidate[] = [];
  const sorted = [...input.candidates].sort(compareCandidates);
  for (const c of sorted) {
    if (total >= caps.total) break;
    if (busyMembers.has(c.memberId) || busySessions.has(c.sessionKey)) continue;
    if (c.slotClass === 'general' && general >= caps.general) continue;
    picked.push(c);
    total += 1;
    if (c.slotClass === 'general') general += 1;
    busyMembers.add(c.memberId);
    busySessions.add(c.sessionKey);
  }
  return picked;
}
