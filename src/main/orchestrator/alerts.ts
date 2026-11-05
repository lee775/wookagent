/**
 * 대표에게만 가던 보류·실패를 메인 에이전트에게 넘긴다 (SERVER_DESIGN 5.3, 리드 결정 S5-7·S5-8·S5-9).
 * - 업무 종류는 `alert` — `message`로 넣으면 작업에 묶이고 메시지 기록이 없는 메인 메시지라 멈춘 검수 넘김으로 읽혀(turns.isReviewHandOff) 스케줄러가 끝난
 *   일로 지운다. 작업 보류에 막히지 않게 TASK_BOUND_KINDS 밖이다 (리드 결정 S5-7)
 * - 키 `alert:<종류>:<대상>`은 QueueEntry.alertKey에 둔다. requestId에 두면 그 중복 제거가 끝난·취소된 항목까지 보아 같은 작업의 다음 보류를 조용히 삼킨다
 * - 알림 항목 하나는 보류 하나의 것이다 (보류 한 번 규칙, 리드 결정 S5-25가 S5-7을 고침): 지금 보류가 걸린 때(since) 뒤에 넣은 실행 중·대기 항목이 있으면
 *   그것이 싣는다. since 전에 넣은 실행 중 항목은 앞선 보류의 글을 이미 읽어 새 보류를 싣지 못하고, since 전에 넣은 대기 항목은 조용히 지우고 새로 넣는다 —
 *   전할 글과 reachesMain이 가장 새 보류를 따른다. 지운 항목의 보류가 아직 남아 있으면(같은 키의 살아 있는 사유 둘) 새 항목이 그 글도 함께 싣는다(S5-37).
 *   그다음 since 뒤에 같은 키로 이미 넣었으면(상태와 상관없이) 넣지 않는다 — 같은 작업의 다음 보류는 새로 알리고, 상한에서 버린 알림은 다시 만들지 않는다.
 *   그래서 한 키의 대기 항목은 하나뿐이다(앞선 보류의 실행 중 항목 곁에 하나 있을 수 있다)
 * - 메인에게 갈 그 키의 알림 항목은 그 키의 살아 있는 사유를 모두 싣는다 (리드 결정 S5-44가 S5-37을 넓힘): 같은 보류의 대기 항목이 다른 사유로 만든 것이면 새
 *   사유의 글을 그 항목에 더하고(시작 때 훑기의 5단계 전 사유 둘, 같은 보류를 새 PID로 다시 알림), 더 새 대기 항목에 밀려 버리는 앞선 실행 중·다시 넣은 항목의
 *   보류가 아직 남아 있으면 그 글을 더 새 항목에 옮겨 싣는다(carrySupersededAlert — 비정상 종료·긴급 정지의 다시 넣기, 재시작 복구)
 * - resume_task가 풀 사유의 알림이 아직 대기 중이면(메인이 받기 전) 한 번 거부하고 그 알림을 거부 글로 보여 준다 — 다음 호출은 재개한다 (handUnseenAlertsOnResume,
 *   리드 결정 S5-45). 보인 알림은 부른 메인 턴에 싣는다 — 그 턴이 끊기면 다시 전달된다, 턴이 없을 때만 받아 마침 (S5-49). 부른 메인 턴이 이미 끝났으면(기다리는
 *   사이 긴급 정지·자리 교체) 대기 그대로 두고 거부만 한다 — 다음 메인 턴이 받는다 (S5-56). resume_member·resolve_recovery·replace_producer도 같은 한 번
 *   거부다 (refuseOnceUnseen, S5-50)
 * - 넣는 곳: 보류를 저장한 뒤 그 자리에서 alertMain(작업 보류면 alertTaskHold)을 부른다. TaskService.hold에 한곳으로 걸지 않는다 — 다시 판정 보류(transitionTask)·
 *   작업 없는 복구 확인을 놓치고, 프로듀서가 풀 보류에도 걸린다
 * - 한 번 받는 일이다 (검수자 없음처럼, 리드 결정 43): 대상이 풀리면 끝난 업무(alertEnded → turns.deadWorkReason), 상한에서 버리면 대표에게 알리고
 *   (turns.heldHandOvers) 다시 만들지 않는다. 메인 에이전트에게 있는지(화면의 reachesMain)는 overview.ts holdReach가 그 키의 가장 최근 항목으로 본다
 * - 대표 알림은 넣은 사실과 OWNER_HANDED('…메인 에이전트에게 넘겼습니다. 메인 에이전트가 확인하고 이어 갑니다 — 서둘러야 하면 …')다. '처리 중'은 쓰지 않는다 —
 *   버려지면 거짓이 되므로 지금 상태는 화면이 reachesMain으로 말한다. 넘기지 못했으면(이미 받아 마쳤거나 버린 같은 보류) 결정 32의 문장 (리드 결정 S5-9)
 * 긴급 정지는 알림 업무가 아니다 — 정지 해제 목록(stop_released)이 그 일이다. 알림 업무도 다른 메인 일처럼 긴급 정지·메인 일시정지·메인 AI의 막힘에 막힌다
 */
import type { HoldReason, QueueEntry, Task } from '@shared/domain';
import { MAIN_AGENT_ID } from '@shared/domain';
import { HOLD_REASON_LABEL, TASK_STATE_LABEL, WORK_KIND_LABEL } from '@shared/labels';
import { CANCEL_HOLD_REF, isTerminal } from '@core/taskMachine';
import { isDirectiveOpen } from '@core/directiveMachine';
import type { Ctx } from './context';
import type { JournalRefRow } from '../db/store';
import { enqueue, mainKey, newestEntry } from './records';
import { directiveTasks, memberName, openTasksOf, producerOf } from './lookups';
import { NO_REVIEWER_HOLD_REF, REJUDGE_HOLD_REF } from './tasks';
import { CONFLICT_SPIN_NOTE, deadWorkReason, isReviewHandOff, mergeNudgeTasks, standingBody } from './turns';

/**
 * 대표 알림의 출구 — 메인 에이전트에게 알림 업무를 넣었다 (리드 결정 S5-9, review-stuck과 같은 모양). 앞에 무엇을 넘겼는지(예: '작업을 보류하고 ')를 붙여 쓴다
 */
export const OWNER_HANDED = '메인 에이전트에게 넘겼습니다. 메인 에이전트가 확인하고 이어 갑니다 — 서둘러야 하면 명령창으로 메인 에이전트에게 알려 주세요';
/** 결정 32의 문장 — 메인 에이전트에게 넘기지 못한 일(이미 받아 마친 같은 보류, 상한에서 버린 알림)의 대표 출구 */
export const OWNER_TELL_MAIN = '명령창으로 메인 에이전트에게 알려 주세요. 메인 에이전트가 확인하고 이어 갑니다';

/**
 * 대표 알림 끝 문장 — 알림 업무가 메인에게 있으면(handed) OWNER_HANDED, 아니면 '<lead> + 결정 32의 문장'. 두 갈래 모두 명령창 길을 적는다
 * (ownerTextsNoResume가 이 함수의 모든 return을 본다)
 */
export function ownerExit(handed: boolean, lead = '원인이 정리되면'): string {
  return handed ? OWNER_HANDED : `${lead ? `${lead} ` : ''}${OWNER_TELL_MAIN}`;
}

/** 알림 종류 — 키 `alert:<종류>:<대상>`의 종류 (SERVER_DESIGN 5.3, 지도 alerts-to-main 2절 표) */
export type AlertKind =
  | 'kill-failed' // CTL-11 — 작업·검수 턴·자동 검사(대상 T), 이미 일시정지된 팀원의 관리 실행(대상 M, 리드 결정 26), 삭제된 팀원의 관리 실행(대상 세션 키, 리드 결정 S5-62)
  | 'merge-fail'
  | 'merge-dirty'
  | 'artifact-fail'
  | 'revert-fail'
  | 'ws-fail'
  | 'start-fail'
  | 'rejudge-stuck'
  | 'crash'
  | 'cli-refusal'
  | 'bypass'
  | 'submit-fail'
  | 'cancel-fail'
  | 'conflict-stuck'
  | 'error-hold' // 시작 때 훑기가 까닭을 가리지 못한 오류 보류
  | 'recovery' // 대상: 실행 요청 ID (resolve_recovery의 recovery_id)
  | 'plan-stuck' // 대상: 지시
  | 'producer-stuck' // 대상: '<지시>:<업무 종류>'
  | 'handover-dropped' // 대상: 버린 보류 넘김 항목 (리드 결정 43)
  | 'restart-dropped' // 대상: 재시작 상한에서 버린 팀원 업무 항목 (리드 결정 44)
  | 'member-paused' // 대상: 팀원 — 재개 업무를 대표에게 넘긴 뒤 새 업무가 온 일시정지 팀원 (리드 결정 35)
  | 'legacy-pause' // 대상: 팀원 — 1단계 전 대표가 건 팀원 정지
  | 'legacy-hold' // 대상: 작업 — 1단계 전 대표가 중단한 작업
  | 'interrupted-review' // 대상: 작업 — 메인이 직접 중단한 채 남은 검수 작업 (리드 결정 42)
  | 'urgent-undelivered' // 대상: 메시지 기록 — 전달하지 못한 긴급 지시
  | 'host_exec'; // 대상: 실행 기록 ID — 서버 재시작으로 끊긴 서버 명령 (리드 결정 S5-18)

/** 알림 종류의 한 줄 이름 — 현황·요약·인계 꾸러미의 '넘겨받은 보류·남는 업무', 활동 기록 */
export const ALERT_KIND_LABEL: Record<AlertKind, string> = {
  'kill-failed': '프로세스 종료 확인 실패',
  'merge-fail': '병합 실패',
  'merge-dirty': '병합 보류',
  'artifact-fail': '산출물 처리 실패',
  'revert-fail': '되돌리기 실패',
  'ws-fail': '작업 공간 생성 실패',
  'start-fail': '업무 시작 실패',
  'rejudge-stuck': '다시 판정 실패',
  crash: '자동 복구 실패',
  'cli-refusal': 'CLI 안전 검사 거부',
  bypass: '바이패스 설정 불일치',
  'submit-fail': '검수 제출 처리 실패',
  'cancel-fail': '작업 취소 실패',
  'conflict-stuck': '병합 충돌 해결 실패',
  'error-hold': '오류 보류',
  recovery: '복구 확인',
  'plan-stuck': '계획 지연',
  'producer-stuck': '프로듀서 처리 지연',
  'handover-dropped': '전하지 못한 보류 넘김',
  'restart-dropped': '재시작 상한에서 멈춘 업무',
  'member-paused': '일시정지된 팀원에게 온 업무',
  'legacy-pause': '예전 대표 정지',
  'legacy-hold': '예전 대표 중단',
  'interrupted-review': '중단한 검수 작업',
  'urgent-undelivered': '전달하지 못한 긴급 지시',
  host_exec: '재시작으로 끊긴 서버 명령',
};

export const alertKey = (kind: AlertKind, target: string): string => `alert:${kind}:${target}`;

/** 알림 키 → 종류·대상. 대상에는 ':'이 들 수 있다(producer-stuck). 모르는 모양이면 null */
export function parseAlertKey(key: string | undefined | null): { kind: AlertKind; target: string } | null {
  const m = key ? /^alert:([a-z_-]+):(.+)$/.exec(key) : null;
  return m && m[1]! in ALERT_KIND_LABEL ? { kind: m[1] as AlertKind, target: m[2]! } : null;
}

const clip = (s: string, max: number): string => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

// ───────────────────────── 작업 보류와 알림 종류 ─────────────────────────

/** 알림이 가리키는 작업 보류 사유인지 — 대상이 작업인 종류만. 끝났는지(alertEnded)·메인에게 있는지(holdReach)·시작 때 훑기가 같은 판정을 쓴다 */
const genericError = (_t: Task, r: HoldReason): boolean => r.kind === 'error' && r.refId !== NO_REVIEWER_HOLD_REF && r.refId !== REJUDGE_HOLD_REF;
export const TASK_HOLD_OF: Partial<Record<AlertKind, (t: Task, r: HoldReason) => boolean>> = {
  'kill-failed': genericError,
  'artifact-fail': genericError,
  'revert-fail': genericError,
  'ws-fail': genericError,
  'start-fail': genericError,
  crash: genericError,
  'cli-refusal': genericError,
  bypass: genericError,
  'submit-fail': genericError,
  'error-hold': genericError,
  'merge-fail': (_t, r) => r.kind === 'merge_blocked',
  'merge-dirty': (_t, r) => r.kind === 'merge_blocked',
  'rejudge-stuck': (_t, r) => r.kind === 'error' && r.refId === REJUDGE_HOLD_REF,
  'cancel-fail': (_t, r) => r.kind === 'interrupted' && r.refId === CANCEL_HOLD_REF,
  'conflict-stuck': (_t, r) => r.kind === 'replan' && r.note.includes(CONFLICT_SPIN_NOTE),
  'interrupted-review': (t, r) => r.kind === 'interrupted' && r.refId !== CANCEL_HOLD_REF && r.by === MAIN_AGENT_ID && t.hold.returnState === 'in_review',
  'legacy-hold': (_t, r) => r.kind === 'interrupted' && r.refId !== CANCEL_HOLD_REF && r.by === 'owner',
};
export type TaskAlertKind = keyof typeof TASK_HOLD_OF;

/** 이 작업 보류 사유가 메인에게 넘어가는 알림 종류들 — 화면의 reachesMain이 이 키들의 가장 최근 항목을 본다 (overview.ts holdReach). 복구 확인은 요청 ID로 */
export function alertKeysOfReason(t: Task, r: HoldReason): string[] {
  if (r.kind === 'recovery_check') return r.refId ? [alertKey('recovery', r.refId)] : [];
  return (Object.entries(TASK_HOLD_OF) as [AlertKind, (t: Task, r: HoldReason) => boolean][]).filter(([, match]) => match(t, r)).map(([k]) => alertKey(k, t.id));
}

// ───────────────────────── 넣기 ─────────────────────────

export interface AlertInput {
  kind: AlertKind;
  target: string;
  /** 업무 세션 — 프로젝트 일이면 main:<P>, 아니면 main:general (리드 결정 S5-7) */
  projectId: string | null;
  taskId?: string | null;
  directiveId?: string | null;
  /** 메인에게 가는 글 — 첫 줄 '<ID> "<제목>" — <원인>', 보류 사유, 정확한 도구 호출과 그 도구가 못 하는 것 */
  message: string;
  /** 지금 보류·일이 생긴 때 — 그 뒤에 같은 키로 넣은 항목이 있으면(상태와 상관없이) 다시 넣지 않는다 */
  since: string;
  /**
   * since 전에 넣은 대기 항목을 바꿔 넣을 때 그 항목의 보류가 아직 남아 있는지 — 참이면 새 글 뒤에 그 항목의 글을 함께 싣는다(한 번 전달에 둘 다). 같은 키의
   * 살아 있는 보류 사유가 둘일 때 alertTaskHold가 준다(자동 검사와 작업 턴의 종료 확인 실패). 다른 곳은 주지 않는다 (리드 결정 S5-37)
   */
  keepEarlier?: boolean;
  /**
   * 같은 보류의 대기 항목(since 뒤에 넣은 것)이 이미 있을 때 그 항목에 없는 이 글의 줄을 그 항목에 더한다 — 그 항목을 다른 살아 있는 사유로 만들었거나(시작 때
   * 훑기가 5단계 전 사유 둘을 알릴 때) 같은 보류를 새 PID로 다시 알릴 때. alertTaskHold가 준다 (리드 결정 S5-44 1)
   */
  join?: boolean;
}

/** 알림 글 하나의 상한 — 앞서 넘긴 보류를 함께 실어도(keepEarlier·join·옮겨 싣기) 이 안에 든다 (리드 결정 S5-37, S5-44가 4,000자를 받아들임) */
export const ALERT_MESSAGE_MAX = 4_000;
/** 함께 실은 앞선 보류의 머리줄 — 그 아래 줄은 들여 쓴 앞선 항목의 글이다 */
export const ALERT_EARLIER_HEAD = '- 같은 키로 앞서 넘긴 보류(아직 남아 있음):';
/** 같은 보류의 대기 항목에 더한 사유의 머리줄 — 그 아래 줄은 들여 쓴 새 사유의 글이다 (리드 결정 S5-44 1) */
export const ALERT_JOINED_HEAD = '- 같은 키로 함께 넘긴 보류:';

/** text의 줄(빈 줄 빼고, 앞뒤 공백 무시)이 모두 message에 있는지 — 이미 실은 글을 다시 싣지 않는다 (리드 결정 S5-44) */
function carries(message: string, text: string): boolean {
  const have = new Set(message.split('\n').map((l) => l.trim()));
  return text.split('\n').every((l) => !l.trim() || have.has(l.trim()));
}

/**
 * 같은 보류의 대기 항목 글에 새 글을 더한 글 (리드 결정 S5-44 1) — 항목 글 + 머리줄 + 새 글의 첫 줄과 항목에 없는 줄(두 칸 들여 씀, 같은 종류의 출구 문장은
 * 되풀이하지 않는다). 첫 줄 뒤의 줄이 모두 이미 있으면(같은 사유를 같은 글로 다시 알림, 다시 부른 훑기) null. 첫 줄로는 사유를 가리지 않는다 — 시작 때 훑기는
 * 모든 사유에 같은 원인 글을 쓰므로 둘째 사유를 첫째로 보게 된다. ALERT_MESSAGE_MAX 안에 들게 더한 글의 뒤를 자르고, 머리줄조차 들지 않으면 null
 */
function joinedText(entry: string, fresh: string, also: readonly string[] = []): string | null {
  const [first = '', ...rest] = fresh.split('\n');
  // also: 같은 보류의 다른 항목(도는 중인 알림 등)의 글 — 그 줄도 이미 메인에게 간 것으로 친다 (리드 결정 S5-51)
  const known = [entry, ...also].join('\n');
  if (carries(known, rest.join('\n'))) return null;
  const have = new Set(known.split('\n').map((l) => l.trim()));
  const head = `${entry}\n${ALERT_JOINED_HEAD}\n`;
  const body = [first, ...rest.filter((l) => l.trim() && !have.has(l.trim()))].map((l) => `  ${l}`).join('\n');
  const room = ALERT_MESSAGE_MAX - head.length;
  if (room < 2) return null;
  return body.length > room ? `${head}${body.slice(0, room - 1)}…` : `${head}${body}`;
}

/**
 * 도는 중인 같은 보류의 알림에 없는 새 글의 줄만 실은 글 (리드 결정 S5-51) — 새 글의 첫 줄(무엇의 알림인지 — 현황·인계 꾸러미의 한 줄), 머리줄, 그 보류의 항목들에
 * 없는 줄(두 칸 들여 씀). 출구 문장처럼 이미 간 줄은 되풀이하지 않는다. ALERT_MESSAGE_MAX 안으로 뒤를 자른다
 */
function newLinesText(fresh: string, known: readonly string[]): string {
  const [first = '', ...rest] = fresh.split('\n');
  const have = new Set(known.join('\n').split('\n').map((l) => l.trim()));
  const text = [first, ALERT_JOINED_HEAD, ...rest.filter((l) => l.trim() && !have.has(l.trim())).map((l) => `  ${l}`)].join('\n');
  return text.length > ALERT_MESSAGE_MAX ? `${text.slice(0, ALERT_MESSAGE_MAX - 1)}…` : text;
}

/** 새 글 + 머리줄 + 앞선 항목의 글(끊긴 턴의 앞말은 떼고 두 칸 들여 씀). 전체가 ALERT_MESSAGE_MAX를 넘으면 앞선 글의 뒤를 자른다 */
function withEarlier(fresh: string, earlier: string): string {
  const head = `${fresh}\n${ALERT_EARLIER_HEAD}\n`;
  const body = standingBody(earlier)
    .split('\n')
    .map((l) => `  ${l}`)
    .join('\n');
  const room = ALERT_MESSAGE_MAX - head.length;
  return body.length > room ? `${head}${body.slice(0, Math.max(0, room - 1))}…` : `${head}${body}`;
}

/**
 * 메인 에이전트에게 알림 업무를 넣는다 (리드 결정 S5-7, 차례는 S5-25). ① since 뒤에 넣은 실행 중 항목이 있으면 그것을 돌려준다(같은 보류를 다시 알렸다 — 그
 * 턴이 싣는다). since 전에 넣은 실행 중 항목은 덮지 않는다 — 그 턴은 앞선 보류의 글을 이미 읽었다. ② 대기 항목이 since 뒤에 넣은 것이면 그것을 돌려준다.
 * ③ since 뒤에 같은 키로 넣은 항목이 있으면(받아 마쳤거나 버렸다) 넣지 않고 null — 호출자는 대표 알림을 결정 32의 문장으로 쓴다. ④ 아니면 새로 넣는다 — since
 * 전에 넣은 대기 항목(앞선 보류의 글)은 대표 알림·버림 알림 없이 지우고 새 항목이 대신한다(바꾼 사실은 활동 기록). 그 보류가 아직 남아 있으면(keepEarlier) 새 항목이
 * 그 글을 함께 싣는다 — 새 항목은 두 보류의 since보다 뒤라 받아 마친 뒤에도 두 사유 모두 메인에게 가 있다 (리드 결정 S5-37). ②에서 join이면 그 대기 항목에 없는
 * 새 글의 줄을 더한다 — 만든 때는 그대로라 같은 보류의 항목이다 (리드 결정 S5-44 1). ①에서 join이고 새 글에 그 보류의 항목들(도는 중인 것 포함)에 없는 줄(다른
 * 실행의 새 PID 등)이 있으면 그 턴은 이미 글을 읽어 싣지 못하므로 그 줄만 같은 보류의 대기 항목에 더하거나(있으면) 새 대기 항목으로 넣는다 — 새로 넣은 항목을
 * 돌려준다 (리드 결정 S5-51). 활동 기록 한 줄. 같은 트랜잭션 안에서 불러도 된다
 */
export function alertMain(ctx: Ctx, a: AlertInput): QueueEntry | null {
  const key = alertKey(a.kind, a.target);
  const sessionKey = mainKey(a.projectId);
  return ctx.store.tx(() => {
    const same = ctx.store.queue.list({ ref2: sessionKey }).filter((q) => q.memberId === MAIN_AGENT_ID && q.alertKey === key);
    const running = same.find((q) => q.state === 'running' && q.createdAt >= a.since);
    const queued = same.find((q) => q.state === 'queued');
    // 같은 보류의 알림이 도는 중이면 그 턴이 싣는다. 다만 새 글에 그 보류의 항목들(지운 것 빼고)에 없는 줄이 있으면 그 줄은 아무에게도 가지 않으므로 대기 항목으로
    // 넘긴다 — 같은 보류의 대기 항목이 이미 있으면 거기에 더하고(아래 ②), 없으면 그 줄만 실은 새 항목 (리드 결정 S5-51)
    const instance = same.filter((q) => q.createdAt >= a.since && q.state !== 'cancelled').map((q) => q.message);
    const fresh = ctx.redact.text(a.message);
    const newLines = !!running && a.join === true && !carries(instance.join('\n'), fresh.split('\n').slice(1).join('\n'));
    if (running && (!newLines || (queued && queued.createdAt < a.since))) return running;
    if (running && !queued) {
      const entry = enqueue(ctx, {
        kind: 'alert',
        memberId: MAIN_AGENT_ID,
        sessionKey,
        projectId: a.projectId,
        taskId: a.taskId ?? null,
        directiveId: a.directiveId ?? null,
        priority: 'high',
        message: newLinesText(fresh, instance),
        alertKey: key,
      });
      ctx.activity({
        kind: a.taskId ? 'task' : 'system',
        level: 'warn',
        projectId: a.projectId,
        taskId: a.taskId ?? null,
        directiveId: a.directiveId ?? null,
        memberId: MAIN_AGENT_ID,
        text: `${ALERT_KIND_LABEL[a.kind]} ${a.target}을(를) 메인 에이전트에게 넘김 (${key}, ${entry.id} — 도는 중인 같은 알림 ${running.id}에 없는 줄만 실음)`,
      });
      return entry;
    }
    if (queued && queued.createdAt >= a.since) {
      // 같은 보류의 대기 항목 — 다른 사유로 만들었거나 같은 보류를 새 글(새 PID)로 다시 알렸으면 그 줄을 더한다. 메인은 그 키의 살아 있는 사유를 모두 듣는다.
      // 같은 보류의 알림이 도는 중이면 그 글의 줄도 이미 간 것으로 친다 (리드 결정 S5-51)
      const joined = a.join ? joinedText(queued.message, fresh, running ? instance : []) : null;
      if (!joined) return running ?? queued;
      const entry = ctx.store.queue.patch(queued.id, { message: ctx.redact.text(joined) });
      ctx.activity({
        kind: a.taskId ? 'task' : 'system',
        level: 'warn',
        projectId: a.projectId,
        taskId: a.taskId ?? null,
        directiveId: a.directiveId ?? null,
        memberId: MAIN_AGENT_ID,
        text: `${ALERT_KIND_LABEL[a.kind]} ${a.target}을(를) 메인 에이전트에게 넘김 (${key}, 대기 중인 같은 알림 ${queued.id}에 그 글을 함께 실음)`,
      });
      return entry;
    }
    if (same.some((q) => q.createdAt >= a.since)) return null;
    // 앞선 보류의 대기 항목 — 새 보류의 글로 바꿔 넣는다. 상한에서 버린 것이 아니라 대표 알림·heldHandOvers의 버림 알림은 없다.
    // 그 보류가 아직 남아 있으면 그 글도 새 항목에 싣는다 — 지우기만 하면 메인은 앞선 보류(다른 프로세스 트리)를 듣지 못한다 (리드 결정 S5-37)
    if (queued) ctx.store.queue.put({ ...queued, state: 'cancelled', doneAt: ctx.now() });
    const carried = queued && a.keepEarlier ? queued : null;
    const entry = enqueue(ctx, {
      kind: 'alert',
      memberId: MAIN_AGENT_ID,
      sessionKey,
      projectId: a.projectId,
      taskId: a.taskId ?? null,
      directiveId: a.directiveId ?? null,
      priority: 'high',
      message: carried ? withEarlier(a.message, carried.message) : a.message,
      alertKey: key,
    });
    ctx.activity({
      kind: a.taskId ? 'task' : 'system',
      level: 'warn',
      projectId: a.projectId,
      taskId: a.taskId ?? null,
      directiveId: a.directiveId ?? null,
      memberId: MAIN_AGENT_ID,
      text: `${ALERT_KIND_LABEL[a.kind]} ${a.target}을(를) 메인 에이전트에게 넘김 (${key}, ${entry.id}${
        queued ? (carried ? ` — 아직 남은 앞선 보류를 실은 대기 항목 ${queued.id}을(를) 지우고 그 글을 새 항목에 함께 실음` : ` — 앞선 보류를 실은 대기 항목 ${queued.id}을(를) 지우고 새 보류로 바꿈`) : ''
      })`,
    });
    return entry;
  });
}

/**
 * 작업 보류를 메인 에이전트에게 넘긴다 — 보류를 저장한 뒤에 부른다(보류 뒤 알림, 리드 결정 S5-9). 그 종류가 가리키는 보류 사유(refId를 주면 그 사유)가 없으면
 * 넣지 않는다(null). 글: 첫 줄 '<작업> "<제목>" — <cause>', 저장된 보류 사유(가림), extra(CTL-11의 프로세스 등), 그 보류의 출구 도구와 못 하는 것.
 * member: 시작하지 못한·명령이 거부된 턴의 팀원(start-fail·cli-refusal의 출구가 그 ID를 적는다) — 넣는 곳이 준다(시작 때 훑기는 작업에서 고른다)
 */
export function alertTaskHold(ctx: Ctx, kind: TaskAlertKind, taskId: string, o: { cause: string; refId?: string | null; extra?: string[]; member?: FailingMember }): QueueEntry | null {
  const t = ctx.store.tasks.get(taskId);
  const match = TASK_HOLD_OF[kind];
  if (!t || t.state !== 'on_hold' || !match) return null;
  const reasons = t.hold.reasons.filter((r) => match(t, r));
  const r = (o.refId !== undefined ? reasons.find((x) => x.refId === o.refId) : undefined) ?? reasons[reasons.length - 1];
  if (!r) return null;
  const message = [
    `${t.id} "${clip(t.title, 80)}" — ${o.cause}`,
    `- 보류 사유(${HOLD_REASON_LABEL[r.kind]}): ${clip(ctx.redact.text(r.note), 600)}`,
    ...(o.extra ?? []),
    ...taskExits(ctx, kind, t, o.member ?? null),
  ].join('\n');
  // 같은 종류에 맞는 다른 살아 있는 사유가 이 사유보다 먼저 걸렸으면 앞선 알림의 보류는 아직 남아 있다 — 새 항목이 그 글을 함께 싣는다(자동 검사와 작업 턴의
  // 종료 확인 실패가 한 작업에 같이 남은 경우 — resume_task 한 번이 둘 다 풀므로 메인이 두 프로세스 트리를 다 들어야 한다, 리드 결정 S5-37)
  const keepEarlier = reasons.some((x) => x !== r && x.since < r.since);
  // 같은 보류의 대기 항목이 이미 있으면 그 항목에 이 사유의 글을 더한다 — 그 항목이 다른 사유로 만든 것이어도 메인은 그 키의 살아 있는 사유를 모두 듣는다
  // (리드 결정 S5-44 1)
  return alertMain(ctx, { kind, target: t.id, projectId: t.projectId, taskId: t.id, directiveId: t.directiveId, message, since: r.since, keepEarlier, join: true });
}

/** 턴을 시작하지 못했거나 그 턴의 명령이 거부된 팀원 — review: 검수 턴(그 팀원이 검수자), 아니면 작업 턴 (리드 결정 S5-28) */
export interface FailingMember {
  id: string;
  review: boolean;
}

/** 시작 때 훑기의 그 팀원 — 5단계 전 보류에는 넣는 곳의 기록이 없다: 검수로 돌아갈 보류면 검수자(검수 턴), 아니면 담당 팀원(작업 턴) */
function failingMemberOf(t: Task): FailingMember | null {
  const review = t.hold.returnState === 'in_review';
  const id = review ? t.reviewerId : t.assigneeId;
  return id ? { id, review } : null;
}

/** 출구 글의 그 팀원 — '검수자 이름(M-…)', '담당 팀원 이름(M-…)' */
function failingMemberLabel(ctx: Ctx, t: Task, m: FailingMember): string {
  const role = m.review ? '검수자' : m.id === t.assigneeId ? '담당 팀원' : '작업 턴을 맡은 팀원';
  const name = memberName(ctx, m.id);
  return `${role} ${name && name !== m.id ? `${name}(${m.id})` : m.id}`;
}

/** 작업 보류 알림의 출구 — 정확한 도구 호출(ID 포함)과 그 도구가 못 하는 것 (리드 결정 S5-7). member: start-fail·cli-refusal의 그 팀원 */
function taskExits(ctx: Ctx, kind: AlertKind, t: Task, member: FailingMember | null): string[] {
  const resume = `resume_task(task_id="${t.id}", reason="…")`;
  const cancel = `필요 없는 작업이면 cancel_task(task_id="${t.id}", reason="…")로 취소하세요.`;
  const server = ctx.deps.mode === 'server';
  const ask = server ? 'ask_owner로 대표에게 서버 PC 운영자의 확인을 부탁해 달라고 하세요' : 'ask_owner로 대표에게 작업 관리자에서 확인해 달라고 부탁하세요';
  switch (kind) {
    case 'kill-failed':
      return [
        `남은 프로세스가 모두 사라졌는지 확인한 뒤 ${resume}로 보류를 푸세요 — 확인하기 전에 풀면 남은 프로세스 위에 새 실행을 겹쳐 띄웁니다. 직접 확인할 길이 없으면 ${ask}.`,
        '자동 검사의 보류였다면 풀어도 검사를 다시 돌리지 않고 기록된 결과로 이어 갑니다(같은 버전일 때).',
        cancel,
      ];
    case 'merge-fail':
      return [`원인을 확인한 뒤 ${resume}로 보류를 풀면 병합 판단부터 다시 합니다(프로듀서의 request_merge). 원인이 그대로면 다시 병합에 실패합니다.`, cancel];
    case 'merge-dirty':
      return [
        `프로젝트 폴더의 커밋되지 않은 변경은 대표나 운영자가 직접 고친 것일 수 있습니다 — 정리됐는지 모르면 ask_owner로 대표에게 물으세요. 정리된 뒤 ${resume}로 풀면 병합 판단부터 다시 합니다. 정리되기 전에 풀면 다시 병합 보류가 됩니다.`,
        cancel,
      ];
    case 'artifact-fail':
      return [`파일 문제(다른 프로그램이 잡고 있음 등)가 정리된 뒤 ${resume}로 풀면 결과 파일을 다시 보관·확정하고 완료합니다.`, cancel];
    case 'revert-fail':
      return [`원인이 정리된 뒤 ${resume}로 풀면 되돌리기를 이어 갑니다.`, cancel];
    case 'ws-fail':
      return [`원인(디스크·경로·잠긴 파일 등)이 정리된 뒤 ${resume}로 풀면 작업 공간을 다시 만들고 시작합니다.`, cancel];
    case 'start-fail':
      // 시작하지 못한 팀원을 ID로 적는다 — 검수자인지 담당인지도 (리드 결정 S5-28). 메인 자신의 AI는 운영 설정이라 set_member_ai가 거부한다(AGT-08)
      if (member?.id === MAIN_AGENT_ID) {
        return [`시작하지 못한 것은 ${member.review ? '검수자인 메인 에이전트 자신의 검수 턴' : '메인 에이전트 자신의 턴'}입니다 — 메인 에이전트의 AI 설정은 운영자 몫이라 set_member_ai로는 바꿀 수 없습니다. 원인이 정리된 뒤 ${resume}로 푸세요.`, cancel];
      }
      return [
        member
          ? `원인이 모델 이름 등 팀원 설정이면 ${failingMemberLabel(ctx, t, member)}의 AI를 set_member_ai(member_id="${member.id}", …)로 고친 뒤 ${resume}로 푸세요 — 그대로 풀면 다시 시작하지 못합니다.`
          : `원인이 모델 이름 등 팀원 설정이면 set_member_ai로 고친 뒤 ${resume}로 푸세요 — 그대로 풀면 다시 시작하지 못합니다.`,
        cancel,
      ];
    case 'crash':
      return [`원인을 확인한 뒤 ${resume}로 풀면 자동 재시작 횟수를 처음부터 다시 셉니다.`, cancel];
    case 'cli-refusal':
      return [
        member
          ? `같은 명령이 또 거부되지 않게 필요하면 ${failingMemberLabel(ctx, t, member)}에게 instruct_member(member_id="${member.id}", text="…")로 다른 방법을 알린 뒤 ${resume}로 푸세요.`
          : `같은 명령이 또 거부되지 않게 필요하면 instruct_member로 담당에게 다른 방법을 알린 뒤 ${resume}로 푸세요.`,
        cancel,
      ];
    case 'bypass':
      return [`바이패스 설정은 운영자 몫입니다 — 설정이 고쳐지고 다시 확인되기 전에는 그 AI 종류의 턴이 뜨지 않습니다(recheck_ai로 다시 확인할 수 있습니다). 고쳐진 뒤 ${resume}로 푸세요.`, cancel];
    case 'submit-fail':
      return [`원인을 확인한 뒤 ${resume}로 풀면 제출 처리를 다시 합니다.`, cancel];
    case 'error-hold':
      return [`보류 사유를 확인하고 원인이 정리됐으면 ${resume}로 푸세요.`, cancel];
    case 'rejudge-stuck': {
      const reviewer = t.review.passed?.reviewerId ?? t.reviewerId ?? '';
      return [
        `판정을 다시 받으려면 instruct_member(member_id="${reviewer}", text="…", urgent=true)로 검수자에게 긴급 지시를 보낸 뒤 ${resume}로 푸세요 — 검수자가 그 지시를 보고 다시 판정합니다.`,
        `등록한 통과로 이어 가려면 지시 없이 ${resume}로 푸세요.`,
        cancel,
      ];
    }
    case 'cancel-fail':
      return [
        `취소를 마치려면 cancel_task(task_id="${t.id}", reason="…")를 다시 부르세요 — 중간 결과 보관부터 이어서 합니다. resume_task는 이 취소 보류를 풀어 작업을 되살리므로 취소를 마치는 길이 아닙니다.`,
      ];
    case 'conflict-stuck': {
      const p = producerOf(ctx, t.projectId);
      return [
        `프로듀서에게 [재계획] 업무가 가 있습니다. resume_task로는 재계획 보류가 풀리지 않습니다 — 프로듀서 ${p.name}(${p.id})에게 instruct_member로 replan_task(다른 팀원에게 맡기기, 방법 바꾸기)를 지시하거나, replace_producer로 프로듀서를 바꾸세요.`,
        cancel,
      ];
    }
    case 'interrupted-review':
      return [`메인 에이전트가 이 작업을 중단해 멈춘 검수 넘김이 끝났습니다. 검수를 다시 등록하려면 ${resume}, 검수자를 바꾸려면 그 뒤 assign_reviewer(task_id="${t.id}", reviewer_id="…")를 쓰세요.`, cancel];
    case 'legacy-hold':
      return [`1단계 전에 대표가 중단한 작업입니다 — 대표는 이제 이 보류를 풀 수 없습니다. 이어 가려면 ${resume}로 푸세요.`, cancel];
    default:
      return [];
  }
}

// ───────────────────────── 풀기 전에 못 본 알림 (리드 결정 S5-45·S5-49·S5-50) ─────────────────────────

/**
 * 거부 글로 보인 대기 항목을 부른 메인 턴에 실은 결과 (TurnRunner.carryShown, 리드 결정 S5-49·S5-56) — 셋을 가린다:
 * - carried: 실행 중인 그 메인 턴에 실었다(그 턴 ID)
 * - none: 부른 신원에 메인 턴이 없다(운영자·시험 신원, 팀원 턴) — 호출자가 받아 마친 것으로 둔다
 * - gone: 부른 메인 턴이 이미 끝났다(도구가 기다리는 사이 긴급 정지·자리 교체 등으로) — 거부 글은 없는 CLI로 가므로 대기 그대로 두어 다음 메인 턴이 받는다
 */
export type CarryOutcome = { kind: 'carried'; turnId: string } | { kind: 'none' } | { kind: 'gone'; turnId: string };
export type CarryShown = (entries: readonly QueueEntry[]) => CarryOutcome;

/** 한 번 거부 — 메인에게 돌려줄 거부 글과, 메인 일지에 서버 기록(action)으로 남길 한 줄(인계 꾸러미가 그 거부를 보인다, 리드 결정 S5-49) */
export interface UnseenRefusal {
  text: string;
  journal: string;
  projectId: string | null;
  refs: JournalRefRow[];
}

/** 메인이 아직 받지 않은 대기 항목 하나와 거부 글에 적을 그 줄 */
interface UnseenItem {
  q: QueueEntry;
  line: string;
}

/** 거부 글·일지·활동 기록의 그 항목 이름 — 알림이면 '프로세스 종료 확인 실패 T-0003', 결정 26의 재개 업무면 '일시정지된 팀원의 재개 M-0002' */
const unseenLabel = (q: QueueEntry): string => (q.kind !== 'alert' && q.pausedMemberId ? `일시정지된 팀원의 재개 ${q.pausedMemberId}` : alertLabel(q));

/**
 * 풀기 전에 메인이 아직 받지 않은(대기 중인) 항목을 한 번 보여 준다 — resume_task·resume_member·resolve_recovery·replace_producer가 같은 길이다 (리드 결정 S5-45·
 * S5-49·S5-50). 각 도구의 다른 거부를 모두 지난 뒤, 풀기 바로 전에 부른다. 항목이 없으면 null — 그대로 푼다. 있으면 그 항목들을 부른 메인 턴에 싣는다(carry —
 * 실행 중·그 턴 ID·그 턴이 실은 항목: 정상으로 끝나면 받아 마침, 끊기면 다시 넣기·재시작 복구가 다시 전달한다). 실행 중인 메인 턴이 없으면(운영자·시험 신원)
 * 받아 마친 것으로 둔다. 어느 쪽이든 취소가 아니라 reachesMain은 참이고, 다음 호출은 그 항목이 실행 중이거나 받아 마쳐 그대로 푼다. 부른 메인 턴이 이미
 * 끝났으면(도구가 기다리는 사이 긴급 정지·자리 교체 — carry가 gone) 거부 글이 없는 CLI로 가므로 항목은 대기 그대로 두고 거부만 한다 — 다음 메인 턴이 받고,
 * 그 전에 다시 부르면 다시 보여 준다 (리드 결정 S5-56). 항목마다 활동 기록 한 줄.
 * 거부 글: head와 갈래마다 참인 뒷말, 그리고 항목마다 그 줄과 들여 쓴 그 글(끊긴 턴의 앞말을 떼고 가림, ALERT_MESSAGE_MAX 안)
 */
function refuseOnceUnseen(
  ctx: Ctx,
  o: {
    tool: string;
    /** 다음 호출이 하는 일 — 'resume_task는 재개' */
    again: string;
    /** 거부 글 첫머리 — 무엇을 하지 않았고 왜인지('T-0001은(는) 재개하지 않았습니다 — …알림이 있습니다.') */
    head: string;
    /** 확인할 것 — '알림에 적힌 것', '알림에 적힌 것(남은 프로세스 등)' */
    check: string;
    /** 받은 것으로 둔 뒤 다음 호출이 하는 일 — '재개합니다' */
    next: string;
    /** 일지 한 줄의 대상 — 'T-0001', '서진(M-0001)' */
    subject: string;
    items: readonly UnseenItem[];
    carry: CarryShown;
    projectId: string | null;
    taskId?: string | null;
    directiveId?: string | null;
    refs: JournalRefRow[];
  },
): UnseenRefusal | null {
  if (!o.items.length) return null;
  const entries = o.items.map((x) => x.q);
  const to = o.carry(entries);
  /** 활동 기록·일지의 그 갈래 — 실음 / 받은 것으로 둠 / 부른 턴이 끝나 대기 그대로 */
  const fate = to.kind === 'carried' ? `이 턴 ${to.turnId}에 실음` : to.kind === 'none' ? '받은 것으로 둠' : `부른 턴 ${to.turnId}이(가) 이미 끝나 대기 그대로 둠 — 다음 메인 턴이 받음`;
  ctx.store.tx(() => {
    for (const q of entries) {
      // 받아 마침은 메인 턴이 없는 호출만이다 — 끝난 턴이면 대기 그대로 (리드 결정 S5-56)
      if (to.kind === 'none') ctx.store.queue.put({ ...ctx.store.queue.require(q.id), state: 'done', doneAt: ctx.now() });
      const what = `${q.alertKey ?? `재개 업무 ${q.pausedMemberId}`}, ${to.kind === 'carried' ? `${fate} — 그 턴이 끊기면 다시 전달` : fate}`;
      ctx.activity({
        kind: o.taskId ? 'task' : 'system',
        level: 'warn',
        projectId: o.projectId,
        taskId: o.taskId ?? null,
        directiveId: o.directiveId ?? null,
        memberId: MAIN_AGENT_ID,
        text:
          to.kind === 'gone'
            ? `${unseenLabel(q)} 알림 ${q.id}을(를) ${o.tool} 거부 글에 옮겨 적음 (${what})`
            : `${unseenLabel(q)} 알림 ${q.id}을(를) ${o.tool} 거부 글로 메인 에이전트에게 전달 (${what} — 다음 ${o.again})`,
      });
    }
  });
  ctx.bus.changed();
  const retry = `${o.check}을 확인한 뒤 이어 가도 되면 ${o.tool}를 다시 부르세요`;
  const head =
    to.kind === 'gone'
      ? `${o.head} 그 알림을 아래에 옮겨 적었지만 이 호출을 한 메인 턴(${to.turnId})이 이미 끝나, 받은 것으로 하지 않고 대기 그대로 두었습니다 — 다음 메인 턴이 받습니다. 그 턴에서 ${retry}.`
      : `${o.head} 그 알림을 아래에 옮겨 적고 받은 것으로 해 두었습니다. ${retry} — 다음 호출은 ${o.next}.`;
  const listed = entries.map((q) => `${q.id}(${unseenLabel(q)})`).join(', ');
  const quote = (q: QueueEntry): string => {
    const body = ctx.redact.text(standingBody(q.message));
    return (body.length > ALERT_MESSAGE_MAX ? `${body.slice(0, ALERT_MESSAGE_MAX - 1)}…` : body)
      .split('\n')
      .map((l) => `  ${l}`)
      .join('\n');
  };
  return {
    text: [head, ...o.items.flatMap(({ q, line }) => [line, quote(q)])].join('\n'),
    journal:
      to.kind === 'gone'
        ? `${o.tool} 거부 — ${o.subject}: 아직 받지 않은 알림 ${listed}을(를) 거부 글에 옮겨 적음(${fate})`
        : `${o.tool} 거부 — ${o.subject}: 아직 받지 않은 알림 ${listed}을(를) 거부 글로 보여 줌(${fate}) — 다음 ${o.again}`,
    projectId: o.projectId,
    refs: o.refs,
  };
}

/**
 * resume_task가 풀 사유 가운데 그 알림을 메인이 아직 받지 않은 것을 보여 준다 (리드 결정 S5-45) — 풀 사유(released)마다 그 키의 대기 항목(메인에게 전하기 전)을
 * 찾는다. 실행 중인 항목은 본 것으로 친다(그 턴이 부른 쪽이거나 그 글을 가졌다). 거부 글: 각 항목의 그 사유(이름·메모 200자)와 알림 글. 보인 항목은 부른 턴에
 * 싣는다(refuseOnceUnseen, 리드 결정 S5-49)
 */
export function handUnseenAlertsOnResume(ctx: Ctx, t: Task, released: readonly HoldReason[], carry: CarryShown): UnseenRefusal | null {
  const queued = ctx.store.queue.list({ ref2: mainKey(t.projectId), state: 'queued' }).filter((q) => q.memberId === MAIN_AGENT_ID && q.kind === 'alert' && !!q.alertKey);
  const unseen = new Map<string, { q: QueueEntry; reasons: HoldReason[] }>();
  for (const r of released) {
    const keys = alertKeysOfReason(t, r);
    for (const q of queued.filter((x) => keys.includes(x.alertKey!))) {
      const u = unseen.get(q.id) ?? { q, reasons: [] };
      if (!u.reasons.includes(r)) u.reasons.push(r);
      unseen.set(q.id, u);
    }
  }
  return refuseOnceUnseen(ctx, {
    tool: 'resume_task',
    again: 'resume_task는 재개',
    subject: t.id,
    head: `${t.id}은(는) 재개하지 않았습니다 — 재개하면 함께 풀릴 보류 가운데 아직 받지 않은(대기 중인) 알림이 있습니다.`,
    check: '알림에 적힌 것',
    next: '재개합니다',
    items: [...unseen.values()].map(({ q, reasons }) => ({
      q,
      line: `- 알림 ${q.id} (${alertLabel(q)}) — 함께 풀릴 보류: ${reasons.map((r) => `${HOLD_REASON_LABEL[r.kind]} "${clip(ctx.redact.text(r.note), 200)}"`).join(', ')}`,
    })),
    carry,
    projectId: t.projectId,
    taskId: t.id,
    directiveId: t.directiveId,
    refs: [
      { kind: 'task', id: t.id },
      { kind: 'project', id: t.projectId },
    ],
  });
}

/** 팀원에 관한 메인 알림 종류 — 남은 프로세스(kill-failed)·재개 업무를 넘긴 뒤 온 새 업무(member-paused)·예전 대표 정지(legacy-pause) (리드 결정 S5-50) */
const MEMBER_ALERT_KINDS: readonly AlertKind[] = ['kill-failed', 'member-paused', 'legacy-pause'];

/**
 * 팀원을 풀기 전에 그 팀원에 관해 메인이 아직 받지 않은 대기 항목을 보여 준다 (리드 결정 S5-50) — resume_member, 그리고 일시정지된 프로듀서 앞의 관리 업무를 새
 * 프로듀서가 바로 이어 받는 replace_producer. 항목: 알림 kill-failed·member-paused·legacy-pause:<팀원>과 결정 26의 재개 업무(pausedMemberId). 이미 끝난
 * 일(재개·삭제됨)은 보지 않는다. 보인 항목은 부른 턴에 싣는다(refuseOnceUnseen)
 */
export function handUnseenOnMemberRelease(ctx: Ctx, memberId: string, tool: 'resume_member' | 'replace_producer', carry: CarryShown): UnseenRefusal | null {
  const keys = MEMBER_ALERT_KINDS.map((k) => alertKey(k, memberId));
  const items = ctx.store.queue
    .list({ ref1: MAIN_AGENT_ID, state: 'queued' })
    .filter((q) => (q.kind === 'alert' ? keys.includes(q.alertKey ?? '') : q.pausedMemberId === memberId) && !deadWorkReason(ctx, q))
    .map((q) => ({ q, line: `- 알림 ${q.id} (${unseenLabel(q)})` }));
  const m = ctx.store.members.get(memberId);
  const name = m ? `${m.name}(${m.id})` : memberId;
  const head =
    tool === 'resume_member'
      ? `${name}은(는) 재개하지 않았습니다 — 이 팀원에 관해 아직 받지 않은(대기 중인) 알림이 있습니다.`
      : `프로듀서 ${name}을(를) 바꾸지 않았습니다 — 이 프로듀서에 관해 아직 받지 않은(대기 중인) 알림이 있습니다. 바꾸면 이 프로듀서 앞에 멈춘 관리 업무를 새 프로듀서가 바로 이어 받습니다.`;
  return refuseOnceUnseen(ctx, {
    tool,
    again: tool === 'resume_member' ? 'resume_member는 재개' : 'replace_producer는 교체',
    subject: name,
    head,
    check: '알림에 적힌 것(남은 프로세스 등)',
    next: tool === 'resume_member' ? '재개합니다' : '바꿉니다',
    items,
    carry,
    projectId: m?.projectId ?? null,
    refs: [{ kind: 'member', id: memberId }, ...(m?.projectId ? [{ kind: 'project' as const, id: m.projectId }] : [])],
  });
}

/**
 * 복구 확인을 정하기 전에(resolve_recovery) 그 복구 확인의 알림(alert:recovery:<요청 ID>)을 메인이 아직 받지 않았으면 보여 준다 (리드 결정 S5-50). 처리된
 * 복구 확인이면 RecoveryService.resolve가 이 판정 전에 아무것도 하지 않고 돌아간다 — 그래서 보는 알림은 늘 살아 있다. 보인 항목은 부른 턴에 싣는다(refuseOnceUnseen)
 */
export function handUnseenOnRecovery(ctx: Ctx, requestId: string, carry: CarryShown): UnseenRefusal | null {
  const key = alertKey('recovery', requestId);
  const items = ctx.store.queue
    .list({ ref1: MAIN_AGENT_ID, state: 'queued' })
    .filter((q) => q.kind === 'alert' && q.alertKey === key)
    .map((q) => ({ q, line: `- 알림 ${q.id} (${unseenLabel(q)})` }));
  const e = ctx.store.execs.get(requestId);
  const projectId = e ? recoveryProjectOf(ctx, e) : null;
  return refuseOnceUnseen(ctx, {
    tool: 'resolve_recovery',
    again: 'resolve_recovery는 처리',
    subject: `복구 확인 ${requestId}`,
    head: `복구 확인 ${requestId}은(는) 처리하지 않았습니다 — 이 복구 확인의 알림을 아직 받지 않았습니다(대기 중).`,
    check: '알림에 적힌 것',
    next: '처리합니다',
    items,
    carry,
    projectId,
    taskId: e?.taskId ?? null,
    refs: [...(e?.taskId ? [{ kind: 'task' as const, id: e.taskId }] : []), ...(projectId ? [{ kind: 'project' as const, id: projectId }] : [])],
  });
}

// ───────────────────────── 끝났는지 (한 번 받는 일의 판정, 리드 결정 S5-7) ─────────────────────────

/**
 * 알림 업무의 대상이 더는 그 일을 필요로 하지 않는 까닭 — 끝났으면 그 까닭, 아니면 null. turns.deadWorkReason의 alert 갈래다(넣을 때·전달하기 전·다시 넣을 때·
 * 재시작 복구가 같은 판정). 작업 보류는 그 종류의 보류 사유가 풀렸거나 작업이 끝났을 때, 복구 확인은 그 실행이 '모름'이 아닐 때, 팀원은 재개·삭제됐을 때,
 * 지시는 그 단계를 벗어났을 때, 버린 업무는 그 대상이 풀렸을 때다. 대상을 찾을 수 없으면 판단하지 않는다(null).
 * 같은 키의 더 새 대기·실행 중 항목이 있으면 그 항목이 가장 새 보류를 싣는다 — 앞선 보류의 항목은 끊긴 턴의 다시 넣기·재시작 복구에서 되살리지 않는다(한 키의
 * 대기 항목은 하나, 리드 결정 S5-25)
 */
export function alertEnded(ctx: Ctx, q: QueueEntry): string | null {
  const p = parseAlertKey(q.alertKey);
  if (!p) return null;
  const { kind, target } = p;
  if (ctx.store.queue.get(q.id)?.alertKey === q.alertKey) {
    const newer = ctx.store.queue
      .list({ ref2: q.sessionKey, state: ['queued', 'running'] })
      .find((x) => x.id !== q.id && x.memberId === MAIN_AGENT_ID && x.alertKey === q.alertKey && newestEntry([q, x]) === x);
    if (newer) return `더 새 보류를 실은 같은 알림 ${newer.id}이(가) 있음`;
  }
  if (kind === 'recovery') {
    const e = ctx.store.execs.get(target);
    if (!e) return null;
    return e.state === 'unknown' ? null : `복구 확인 ${target}이(가) 이미 처리됨`;
  }
  if (kind === 'kill-failed' && target.startsWith('M-')) return memberPauseEnded(ctx, target);
  // 삭제된 팀원의 관리 세션(대상이 세션 키) — 남은 프로세스를 알리는 한 번의 일이다. 그 팀원이 없어 저절로 풀리는 대상이 없다 (host_exec처럼, 리드 결정 S5-62)
  if (kind === 'kill-failed' && target.includes(':')) return null;
  const match = TASK_HOLD_OF[kind];
  if (match) {
    const t = ctx.store.tasks.get(target);
    if (!t) return null;
    if (isTerminal(t.state)) return `${t.id}이(가) 이미 ${TASK_STATE_LABEL[t.state]}됨`;
    return t.state === 'on_hold' && t.hold.reasons.some((r) => match(t, r)) ? null : `${t.id}의 ${ALERT_KIND_LABEL[kind]} 보류가 이미 풀림`;
  }
  switch (kind) {
    case 'member-paused':
      return memberPauseEnded(ctx, target);
    case 'legacy-pause': {
      const ended = memberPauseEnded(ctx, target);
      return ended ?? (ctx.stop().members[target]?.by === 'owner' ? null : `${target}의 예전 대표 정지가 이미 바뀜`);
    }
    case 'plan-stuck': {
      const d = ctx.store.directives.get(target);
      if (!d) return null;
      return d.state === 'planning' ? null : `지시 ${d.id}이(가) 계획 중이 아님`;
    }
    case 'producer-stuck':
      return producerStuckEnded(ctx, target);
    case 'handover-dropped': {
      const orig = ctx.store.queue.get(target);
      if (!orig) return null;
      return deadWorkReason(ctx, orig);
    }
    case 'restart-dropped': {
      const orig = ctx.store.queue.get(target);
      return orig ? restartDroppedEnded(ctx, orig) : null;
    }
    case 'urgent-undelivered': {
      const m = ctx.store.messages.get(target);
      return m?.deliveredAt ? `긴급 지시 ${target}이(가) 그 뒤 전달됨` : null;
    }
    case 'host_exec':
      // 끊긴 사실을 알리는 한 번의 일이다 — 저절로 풀리는 대상이 없다 (같은 키는 한 번만, 보류 한 번 규칙)
      return null;
    default:
      return null;
  }
}

/**
 * 더 새 대기 항목에 밀려 끝난 일로 버리는 같은 키의 앞선 항목(실행 중이던 것·다시 넣은 것)의 보류가 아직 남아 있으면 그 글을 더 새 대기 항목에 옮겨 싣는다
 * (리드 결정 S5-44 2) — 버리는 곳(turns.dropDeadWork: 끊긴 턴의 다시 넣기 — 비정상 종료·긴급 정지 —, 재시작 복구, 스케줄러)이 같은 트랜잭션에서 부른다. 끊긴
 * 턴이 읽었을 뿐 처리하지 못한 보류를 메인이 다시 듣는다. 남아 있다: 그 종류에 맞는 살아 있는 사유가 그 항목보다 먼저 걸렸다(since <= 그 항목의 만든 때).
 * 모양은 S5-37의 withEarlier(새 글, '아직 남아 있음' 머리줄, 두 칸 들여 쓴 앞선 글), 한 번만 — 그 글의 줄이 모두 이미 있으면 싣지 않는다. 작업 보류의 알림만.
 * 옮겨 실은 대기 항목 ID, 아니면 null
 */
export function carrySupersededAlert(ctx: Ctx, q: QueueEntry): string | null {
  const p = parseAlertKey(q.alertKey);
  const match = p ? TASK_HOLD_OF[p.kind] : undefined;
  if (!p || !match || q.memberId !== MAIN_AGENT_ID) return null;
  const newer = ctx.store.queue
    .list({ ref2: q.sessionKey, state: 'queued' })
    .find((x) => x.id !== q.id && x.memberId === MAIN_AGENT_ID && x.alertKey === q.alertKey && newestEntry([q, x]) === x);
  if (!newer) return null;
  const t = ctx.store.tasks.get(p.target);
  if (!t || t.state !== 'on_hold' || !t.hold.reasons.some((r) => match(t, r) && r.since <= q.createdAt)) return null;
  const earlier = standingBody(q.message);
  if (carries(newer.message, earlier)) return null;
  ctx.store.queue.patch(newer.id, { message: ctx.redact.text(withEarlier(newer.message, earlier)) });
  return newer.id;
}

/** 그 팀원이 아직 일시정지돼 있는지 — 재개·삭제됐으면 그 까닭 */
function memberPauseEnded(ctx: Ctx, memberId: string): string | null {
  const m = ctx.store.members.get(memberId);
  if (!m || m.deletedAt) return `${memberId}이(가) 삭제됨`;
  return ctx.stop().members[m.id]?.paused ? null : `${m.name}(${m.id})이(가) 이미 재개됨`;
}

/** 프로듀서 처리 지연(재촉 상한)의 대상이 풀렸는지 — 대상 '<지시>:<업무 종류>'. 지시가 닫혔거나 그 종류의 일이 더 없으면 끝났다 */
function producerStuckEnded(ctx: Ctx, target: string): string | null {
  const [directiveId = '', kind = ''] = target.split(':');
  const d = ctx.store.directives.get(directiveId);
  if (!d) return null;
  if (!isDirectiveOpen(d)) return `지시 ${d.id}이(가) 끝남`;
  const tasks = directiveTasks(ctx, d.id);
  switch (kind) {
    case 'answer':
      return ctx.store.questions.list({ state: 'open' }).some((q) => q.to === 'producer' && q.directiveId === d.id) ? null : `지시 ${d.id}에 프로듀서가 답할 질문이 없음`;
    case 'merge_decision':
      return tasks.some((t) => t.state === 'in_review' && t.review.passed && t.outputMode === 'repo' && !t.merge) ? null : `지시 ${d.id}에 병합을 기다리는 작업이 없음`;
    case 'final_result': {
      const round = directiveTasks(ctx, d.id, d.round);
      return (d.state === 'in_progress' || d.state === 'planning') && round.length && round.every((t) => isTerminal(t.state)) ? null : `지시 ${d.id}이(가) 최종 결과를 기다리지 않음`;
    }
    case 'replan':
      return tasks.some((t) => t.state === 'on_hold' && t.hold.reasons.some((r) => r.kind === 'replan' || r.kind === 'blocked' || r.kind === 'prereq_cancelled'))
        ? null
        : `지시 ${d.id}에 조치를 기다리는 보류 작업이 없음`;
    default:
      return null;
  }
}

/** 재시작 상한에서 버린 팀원 업무(리드 결정 44)의 대상이 풀렸는지 — 질문에 답이 왔거나, 지시가 그 단계를 벗어났거나, 작업이 그 단계를 벗어났다 */
function restartDroppedEnded(ctx: Ctx, q: QueueEntry): string | null {
  const d = q.directiveId ? ctx.store.directives.get(q.directiveId) : null;
  if (d && !isDirectiveOpen(d) && q.kind !== 'review') return `지시 ${d.id}이(가) 끝남`;
  const task = q.taskId ? ctx.store.tasks.get(q.taskId) : null;
  switch (q.kind) {
    case 'answer': {
      const open = ctx.store.questions.list({ state: 'open' }).filter((x) => x.to === 'producer' && x.directiveId === q.directiveId);
      return open.some((x) => !q.questionId || x.id === q.questionId) ? null : '답할 질문이 더 없음';
    }
    case 'final_result':
      return d && (d.state === 'in_progress' || d.state === 'planning') ? null : `지시 ${q.directiveId}이(가) 최종 결과를 기다리지 않음`;
    case 'plan':
      return d?.state === 'planning' ? null : `지시 ${q.directiveId}이(가) 계획 중이 아님`;
    case 'merge_decision': {
      const ids = q.taskId ? [q.taskId] : mergeNudgeTasks(q);
      return ids.some((id) => {
        const t = ctx.store.tasks.get(id);
        return !!t && t.state === 'in_review' && !!t.review.passed && !t.merge;
      })
        ? null
        : '병합을 기다리는 작업이 없음';
    }
    case 'review':
      if (!task) return null;
      return task.state === 'in_review' && !task.review.passed ? null : `${task.id}이(가) 검수를 기다리지 않음 (${TASK_STATE_LABEL[task.state]})`;
    case 'replan':
      if (!task) return null;
      return task.state === 'on_hold' && task.hold.reasons.some((r) => r.kind === 'replan' || r.kind === 'blocked' || r.kind === 'prereq_cancelled') ? null : `${task.id}의 재계획 보류가 이미 풀림`;
    default:
      return null;
  }
}

// ───────────────────────── 팀원·지시·버린 일의 알림 글 ─────────────────────────

/** 남은 프로세스를 메인이 직접 확인할 길이 없을 때의 출구 — 서버 PC의 프로세스는 원격 대표가 볼 수 없어 그 PC의 운영자가 확인한다 (리드 결정 S4-20·S5-9) */
export function askOwnerToCheck(ctx: Ctx): string {
  return ctx.deps.mode === 'server' ? 'ask_owner로 대표에게 서버 PC 운영자의 확인을 부탁해 달라고 하세요' : 'ask_owner로 대표에게 작업 관리자에서 확인해 달라고 부탁하세요';
}

/**
 * 일시정지된 팀원의 재개를 맡기는 글 — 리드 결정 26(이미 일시정지된 팀원의 종료 확인 실패)·35(재개 업무를 대표에게 넘긴 뒤 새 업무, 1단계 전 대표 정지).
 * 끝 문장의 다른 길은 글을 만들 때의 그 팀원으로 고른다 (리드 결정 S5-57): 프로젝트의 프로듀서면 그 프로젝트 ID로 replace_producer — remove_member는 프로듀서를
 * 거부한다(ORG-04). 다른 팀원이면 그 팀원 ID를 넣은 remove_member 호출 — 그 도구의 인자 모양 그대로(member_id만 받는다, 리드 결정 S5-70 2). 그 팀원에게 맡은 작업이
 * 남아 있으면 remove_member가 거부하므로 그 앞 조건(맡은 작업을 재배정하거나 취소)을 함께 적는다 (리드 결정 S5-75).
 * kill-failed:<팀원>·member-paused:<팀원>은 프로듀서의 관리 실행에서만 생긴다
 */
export function memberAlertText(ctx: Ctx, memberId: string, head: string, extra: string[] = []): string {
  const m = ctx.store.members.get(memberId);
  const name = m ? `${m.name}(${m.id})` : memberId;
  const waiting = [...new Set(ctx.store.queue.list({ ref1: memberId, state: 'queued' }).filter((x) => !x.ownerShared).map((x) => `${WORK_KIND_LABEL[x.kind]}${x.taskId ? ` ${x.taskId}` : x.directiveId ? ` ${x.directiveId}` : ''}`))];
  const ask = askOwnerToCheck(ctx);
  const producing = m?.projectId && !m.deletedAt && ctx.store.projects.get(m.projectId)?.producerId === m.id ? m.projectId : null;
  // remove_member가 거부하는 맡은 작업 — 같은 판정(openTasksOf)으로 본다 (리드 결정 S5-75)
  const open = producing ? [] : openTasksOf(ctx, memberId);
  const other = producing
    ? `프로듀서를 바꾸려면 마찬가지로 확인한 뒤 replace_producer(project_id="${producing}", reason="…")를 쓰세요 — 새 프로듀서가 멈춘 관리 업무를 이어 받습니다. 프로듀서는 remove_member로 지울 수 없습니다.`
    : `더 쓰지 않을 팀원이면 ${open.length ? `맡은 작업(${open.map((t) => t.id).join(', ')})을 재배정하거나 취소한 뒤 ` : ''}remove_member(member_id="${memberId}")로 지워도 됩니다.`;
  return [
    head,
    ...extra,
    `- 지금 ${name} 앞에 기다리는 업무: ${waiting.length ? waiting.join(', ') : '없음'} — 재개할 때까지 처리되지 않습니다`,
    `남은 프로세스가 없는지 확인한 뒤 resume_member(member_id="${memberId}", reason="…")로 풉니다. 직접 확인할 길이 없으면 ${ask}. ${other}`,
  ].join('\n');
}

/**
 * 삭제된 팀원의 관리 실행이 남긴 프로세스를 넘기는 글 (alert kill-failed:<세션 키>, 리드 결정 S5-62 2) — 그 팀원은 삭제돼 일시정지하지 않았다. 첫 줄 '<세션 키> —
 * <실행>(<팀원 ID>, 삭제된 팀원)…', 프로세스(PID·남은 수), 지시 세션이면 그 관리 업무를 지금 잇는 프로듀서, 할 일(확인, 확인할 때까지 그 프로듀서를 멈추는
 * 정확한 호출). run.label: blockUnconfirmedRun의 실행 이름('<이름> <턴 이름>')
 */
export function deletedMemberAlertText(ctx: Ctx, m: { id: string; name: string; projectId: string | null }, run: { label: string; sessionKey: string; sessionKind: string }, extra: string[]): string {
  const p = run.sessionKind === 'directive' && m.projectId ? ctx.store.projects.get(m.projectId) : null;
  const next = p ? ctx.store.members.get(p.producerId) : null;
  const heir = next && !next.deletedAt && next.id !== m.id ? next : null;
  return [
    `${run.sessionKey} — ${run.label}(${m.id}, 삭제된 팀원)의 프로세스 종료를 확인하지 못했습니다. 삭제된 팀원이라 프로그램이 일시정지하지 않았습니다`,
    ...extra,
    ...(heir ? [`- 이 세션의 관리 업무는 지금 프로듀서 ${heir.name}(${heir.id})이(가) 이어 받습니다 — 남은 프로세스가 정리되기 전에는 그 프로세스 위에서 돕니다`] : []),
    `남은 프로세스가 모두 사라졌는지 확인하세요. 직접 확인할 길이 없으면 ${askOwnerToCheck(ctx)}.${
      heir ? ` 확인할 때까지 그 관리 업무를 멈추려면 pause_member(member_id="${heir.id}", mode="graceful", reason="…")로 일시정지하고, 확인한 뒤 resume_member로 푸세요.` : ''
    } 이 알림은 다시 오지 않습니다.`,
  ].join('\n');
}

/** 계획 지연(재촉 상한) 알림 글 (리드 결정 S5-8 — 프로듀서가 세 번 받고도 작업을 만들지 않았다) */
export function planStuckText(ctx: Ctx, directiveId: string): string {
  const d = ctx.store.directives.get(directiveId);
  const p = d?.projectId ? producerOf(ctx, d.projectId) : null;
  return [
    `${directiveId} "${clip(d?.title ?? '', 80)}" — 프로듀서가 계획 요청을 세 번 받고도 작업을 만들지 않았습니다 (계획 지연, 재촉하지 않음)`,
    `${p ? `프로듀서 ${p.name}(${p.id})에게 instruct_member로 다시 지시하거나, replace_producer로 프로듀서를 바꾸세요.` : 'replace_producer로 프로듀서를 정하세요.'} 필요 없는 지시면 cancel_directive(directive_id="${directiveId}", reason="…")로 취소하세요.`,
  ].join('\n');
}

/** 프로듀서 처리 지연(재촉 상한) 알림 글 — kind: 재촉한 업무 종류, detail: 재촉 글(무엇을 기다리는지) */
export function producerStuckText(ctx: Ctx, directiveId: string, kind: string, detail: string): string {
  const d = ctx.store.directives.get(directiveId);
  const p = d?.projectId ? producerOf(ctx, d.projectId) : null;
  const label = WORK_KIND_LABEL[kind as keyof typeof WORK_KIND_LABEL] ?? kind;
  return [
    `${directiveId} "${clip(d?.title ?? '', 80)}" — 프로듀서가 같은 요청(${label})을 세 번 받고도 처리하지 않았습니다 (재촉하지 않음)`,
    `- 기다리는 일: ${clip(detail, 400)}`,
    `${p ? `프로듀서 ${p.name}(${p.id})에게 instruct_member로 다시 지시하거나, replace_producer로 프로듀서를 바꾸세요.` : 'replace_producer로 프로듀서를 정하세요.'} 필요 없는 작업은 cancel_task, 지시째 그만두려면 cancel_directive(directive_id="${directiveId}", reason="…").`,
  ].join('\n');
}

/** 메인 턴이 상한에서 버린 보류 넘김(정지 해제 목록·검수자 없음)을 한 번 더 넘기는 글 (리드 결정 S5-8·43) — tasks: 아직 그 보류인 작업, how: 버린 까닭 */
export function handOverDroppedText(q: QueueEntry, tasks: readonly Task[], how: string): string {
  const names = tasks.map((t) => `${t.id} "${clip(t.title, 60)}"`).join(', ');
  if (q.kind === 'stop_released') {
    return [
      `정지 해제 목록(${q.id})을 실은 메인 턴이 ${how} 그 목록이 처리되지 않았습니다 — 아직 긴급 정지 보류인 작업: ${names}`,
      '작업마다 상태를 확인하고 이어 가도 되는 것만 resume_task(task_id="…", reason="…")로 푸세요. 이 알림은 다시 오지 않습니다.',
    ].join('\n');
  }
  const t = tasks[0];
  return [
    `검수자 없음(${q.id})을 실은 메인 턴이 ${how} 그 업무가 처리되지 않았습니다 — ${names}`,
    `검수 권한 팀원을 add_member로 더한 뒤 resume_task(task_id="${t?.id ?? '…'}", reason="…")로 풀면 검수 등록부터 다시 합니다(검수자를 정하려면 그 뒤 assign_reviewer). 이 알림은 다시 오지 않습니다.`,
  ].join('\n');
}

/** 재시작 상한에서 버린 팀원 업무(리드 결정 44)를 메인에게 넘기는 글 — 받은 쪽(프로듀서·검수자)이 할 일을 메인이 다시 맡긴다 */
export function restartDroppedText(ctx: Ctx, q: QueueEntry): string {
  const who = memberName(ctx, q.memberId) || q.memberId;
  const what = `${WORK_KIND_LABEL[q.kind]}${q.taskId ? ` ${q.taskId}` : q.directiveId ? ` ${q.directiveId}` : ''}`;
  const head = `${what} (${who}, ${q.id}) — 이 업무를 처리하던 중에 프로그램이 3번 다시 시작돼 더는 자동으로 다시 시도하지 않습니다`;
  const tell = `${who}(${q.memberId})에게 instruct_member로 다시 지시하세요`;
  const ways: Record<string, string> = {
    answer: `${tell} — 질문${q.questionId ? ` ${q.questionId}` : ''}에 answer_question으로 답하라고.`,
    final_result: `${tell} — 지시 ${q.directiveId}의 결과를 submit_final_result로 정리하라고.`,
    merge_decision: `${tell} — 병합을 기다리는 작업을 request_merge로 병합하라고.`,
    plan: `${tell} — 지시 ${q.directiveId}를 create_task로 나누라고. 필요 없는 지시면 cancel_directive.`,
    replan: `${tell} — 보류된 작업을 replan_task나 resolve_hold로 조치하라고.`,
    review: `검수를 다시 등록하려면 assign_reviewer(task_id="${q.taskId ?? '…'}", reviewer_id="…")로 검수자를 정하세요(같은 검수자면 그 검수자에게 다시 등록). 프로듀서에게 검수자 재배정을 맡겼을 수도 있습니다.`,
  };
  return [head, ways[q.kind] ?? `${tell}.`, '같은 일을 앱째 끝낸 턴이 다시 돌 수 있으니 원인(긴 출력·큰 파일 등)을 먼저 살피세요. 이 알림은 다시 오지 않습니다.'].join('\n');
}

/** 재시작 상한에서 버렸을 때 메인에게 넘기는 팀원 업무 종류 (리드 결정 S5-8 — 프로듀서 답변·최종 결과·병합 판단·검수, 그리고 같은 프로듀서 일인 계획·재계획) */
export const RESTART_ALERT_KINDS: ReadonlySet<string> = new Set(['answer', 'final_result', 'merge_decision', 'review', 'plan', 'replan']);

/** 전달하지 못한 긴급 지시를 메인에게 넘기는 글 (리드 결정 S5-8 — 메인이 보냈는데 실패를 듣지 못했다) */
export function urgentUndeliveredText(from: string, name: string, memberId: string, messageId: string, why: string, text: string): string {
  return [
    `${from}가 ${name}(${memberId})에게 보낸 긴급 지시(${messageId})를 전달하지 못했습니다 — ${why}`,
    `- 지시: "${clip(text, 300)}"`,
    `아직 필요하면 받는 쪽이 지금 받을 수 있는지 확인한 뒤 instruct_member(member_id="${memberId}", text="…", urgent=true)로 다시 보내세요. 이 알림은 다시 오지 않습니다.`,
  ].join('\n');
}

// ───────────────────────── 시작 때 훑기 (리드 결정 S5-8) ─────────────────────────

/** 보류 사유 글로 그 작업 오류 보류의 알림 종류를 고른다 (시작 때 훑기 — 5단계 전 보류에는 알림 기록이 없다). 모르면 'error-hold' */
function errorKindOfNote(note: string): TaskAlertKind {
  if (/^(턴|자동 검사|이전 실행) 종료 뒤/.test(note)) return 'kill-failed';
  if (/^턴 시작 \d+회 실패/.test(note)) return 'start-fail';
  if (/자동 복구 \d+회 실패|번 다시 시작돼 자동으로 이어 가지 않음/.test(note)) return 'crash';
  if (note.startsWith('CLI 안전 검사가 명령을 거부함')) return 'cli-refusal';
  if (note.startsWith('바이패스 설정 불일치')) return 'bypass';
  if (/작업 공간 생성 실패|작업 폴더 생성 실패/.test(note)) return 'ws-fail';
  if (note.startsWith('검수 제출 처리 실패')) return 'submit-fail';
  if (note.startsWith('산출물')) return 'artifact-fail';
  if (note.startsWith('되돌리기 처리 실패')) return 'revert-fail';
  return 'error-hold';
}

/**
 * 시작 때 훑기 (리드 결정 S5-8 — 같은 결과로 모이는 맞춤 단계, 재시작 복구 reconcileManagement 끝). 살아 있는 보류·항목 가운데 알림이 없는 것에 알림을 만든다:
 * 그 보류가 걸린 뒤(since) 같은 키로 넣은 항목이 하나도 없을 때만(상태와 상관없이 — 상한에서 버린 알림·받아 마친 알림은 다시 만들지 않는다). 처음 5단계로
 * 시작하면 예전 보류를 알린다 — 한 프로젝트의 알림은 한 메인 턴에 실린다(세션 키별로 묶임). 다시 불러도 같다. 검수자 없음·긴급 정지 보류는 따로다(넘김이
 * 있고, 버린 넘김은 다시 만들지 않는다 — 리드 결정 43). 메인이 중단한 검수 작업은 그 작업의 멈춘 검수 넘김이 그 중단 전에 만들어져 그 중단 뒤에 끝났을 때만이다
 * (리드 결정 42·S5-28). inScope: 그 프로젝트만
 */
export function sweepAlerts(ctx: Ctx, inScope: (projectId: string | null) => boolean = () => true): void {
  for (const t of ctx.store.tasks.list({ state: 'on_hold' })) {
    if (!inScope(t.projectId)) continue;
    for (const r of t.hold.reasons) {
      if (r.kind === 'recovery_check') continue; // 복구 확인은 아래 실행 기록으로
      let kind: TaskAlertKind | null = null;
      if (genericError(t, r)) kind = errorKindOfNote(r.note);
      else if (r.kind === 'merge_blocked') kind = r.note.includes('커밋되지 않은 변경') ? 'merge-dirty' : 'merge-fail';
      else {
        for (const k of ['rejudge-stuck', 'cancel-fail', 'interrupted-review', 'legacy-hold'] as const) if (TASK_HOLD_OF[k]!(t, r)) kind = k;
        // 병합 충돌 헛돌기는 프로듀서가 맡아서도 못 풀었을 때만 대표·메인의 일이다 (spinHold — 같은 충돌의 두 번째 헛돌기이거나 프로듀서가 담당)
        if (!kind && TASK_HOLD_OF['conflict-stuck']!(t, r) && ((t.conflict?.spinHolds ?? 0) >= 2 || t.assigneeId === ctx.store.projects.get(t.projectId)?.producerId)) kind = 'conflict-stuck';
        // 메인이 중단한 검수 작업은 그 중단으로 멈춘 검수 넘김이 끝났을 때만 알린다(결정 42의 경우) — 넘김 없이 메인이 일부러 건 중단은 메인의 일이 아니다 (리드 결정 S5-28)
        if (kind === 'interrupted-review' && !handOffEndedByInterrupt(ctx, t, r.since)) kind = null;
      }
      if (!kind) continue;
      alertTaskHold(ctx, kind, t.id, { cause: `시작 때 확인: 메인 에이전트에게 알리지 않은 채 남은 보류(${ALERT_KIND_LABEL[kind]})`, refId: r.refId, member: failingMemberOf(t) ?? undefined });
    }
  }
  for (const e of ctx.store.execs.list({ state: 'unknown' })) {
    const projectId = recoveryProjectOf(ctx, e);
    if (!inScope(projectId)) continue;
    alertMain(ctx, { kind: 'recovery', target: e.requestId, projectId, taskId: e.taskId, message: recoveryText(ctx, e.requestId), since: e.startedAt });
  }
  for (const [memberId, s] of Object.entries(ctx.stop().members)) {
    if (!s.paused || s.by !== 'owner' || memberId === MAIN_AGENT_ID) continue;
    const m = ctx.store.members.get(memberId);
    if (!m || m.deletedAt || !inScope(m.projectId)) continue;
    const head = `${m.name}(${m.id}) — 1단계 전에 대표가 건 일시정지가 남아 있습니다 (예전 대표 정지). 대표는 이제 팀원을 재개할 수 없어 메인 에이전트에게 맡깁니다`;
    alertMain(ctx, { kind: 'legacy-pause', target: m.id, projectId: m.projectId, message: memberAlertText(ctx, m.id, head), since: s.since });
  }
}

/**
 * 그 작업의 멈춘 검수 넘김(turns.isReviewHandOff)이 그 중단(보류) 전에 만들어져 그 중단 뒤에 끝났는지(받아 마침·지움) — 메인이 넘김을 받고 중단한 결정 42의
 * 경우(리드 결정 S5-28). 그 중단 전에 다른 까닭으로 끝난 넘김(예: 검수자를 바꿔 마침)은 이 중단과 상관없다
 */
function handOffEndedByInterrupt(ctx: Ctx, t: Task, since: string): boolean {
  return ctx.store.queue
    .list({ ref2: mainKey(t.projectId) })
    .some((q) => isReviewHandOff(q) && q.taskId === t.id && (q.state === 'done' || q.state === 'cancelled') && q.createdAt < since && !!q.doneAt && q.doneAt >= since);
}

/** 복구 확인 알림이 가는 프로젝트 — 그 실행의 프로젝트, 없으면 그 작업의 프로젝트 (넣는 곳·시작 때 훑기·화면의 reachesMain이 같은 세션 키를 본다) */
export function recoveryProjectOf(ctx: Ctx, e: { projectId: string | null; taskId: string | null }): string | null {
  return e.projectId ?? (e.taskId ? (ctx.store.tasks.get(e.taskId)?.projectId ?? null) : null);
}

/** 복구 확인을 넘기는 글 — recovery_id는 그 실행의 요청 ID다 (resolve_recovery, 리드 결정 S5-8) */
export function recoveryText(ctx: Ctx, requestId: string, note?: string): string {
  const e = ctx.store.execs.get(requestId);
  const t = e?.taskId ? ctx.store.tasks.get(e.taskId) : null;
  const finding = note ?? String(e?.result.recovered ?? e?.result.recoveryError ?? '실행 여부 불명확');
  return [
    `${t ? `${t.id} "${clip(t.title, 80)}"` : (e?.projectId ?? '프로젝트 없음')} — 복구 확인 ${requestId}: ${e?.kind ?? ''} ${clip(ctx.redact.text(e?.command ?? ''), 200)}`,
    `- 확인한 것: ${clip(ctx.redact.text(finding), 300)}`,
    `결과를 직접 확인한 뒤 resolve_recovery(recovery_id="${requestId}", action="applied"|"retry"|"cancel", reason="…")로 정하세요 — applied는 이미 반영됨(병합이면 기준 브랜치에서 그 병합 커밋을 찾습니다), retry는 다시 실행, cancel은${t ? ' 작업 취소' : ' 그 실행을 실패로 둠'}. resume_task로는 복구 확인 보류가 풀리지 않습니다.`,
  ].join('\n');
}

/**
 * 서버 재시작으로 끊긴 서버 명령(host_exec)을 메인에게 넘기는 글 (리드 결정 S5-18) — 첫 줄 '<실행 ID> "<명령>" — 원인', 실행 위치·시작·보낸 request_id, 프로세스를
 * 어떻게 끝냈는지, 할 일(결과를 확인한 뒤 새 request_id로 다시 — 같은 request_id는 다시 돌지 않는다). processes: 재시작 복구가 확인한 그 프로세스 트리
 */
export function hostExecCutText(ctx: Ctx, e: { requestId: string; command: string; target: string; cwd: string; startedAt: string; result: Record<string, unknown> }, processes: string): string {
  const rid = typeof e.result.toolRequestId === 'string' ? e.result.toolRequestId : null;
  return [
    `서버 명령 ${e.requestId} "${clip(ctx.redact.text(e.command), 200)}" — 서버(앱)가 다시 시작되며 끊겼습니다`,
    `- 목적: ${clip(ctx.redact.text(e.target), 200)}`,
    `- 실행 위치: ${e.cwd} · 시작: ${e.startedAt}${rid ? ` · request_id ${clip(ctx.redact.text(rid), 120)}` : ''}`,
    `- 프로세스: ${processes}`,
    '명령이 어디까지 했는지(설치가 끝났는지 등)는 알 수 없습니다. 결과를 확인하고(필요하면 확인하는 명령을 host_exec로) 다시 돌려야 하면 새 request_id로 부르세요 — 같은 request_id로는 다시 돌지 않습니다.',
  ].join('\n');
}

/** 알림 업무 글의 첫 줄 — 끊긴 턴이 다시 넣으며 붙인 앞말('<까닭>' + 빈 줄 + '(다시 전달) ')은 뗀다 (turns.standingBody) */
export function alertHead(q: QueueEntry): string {
  return standingBody(q.message).split('\n')[0] ?? '';
}

/** 알림 업무 하나의 한 줄 이름 — '병합 실패 T-0003', '복구 확인 X-…' (현황·요약·인계 꾸러미) */
export function alertLabel(q: QueueEntry): string {
  const p = parseAlertKey(q.alertKey);
  return p ? `${ALERT_KIND_LABEL[p.kind]} ${p.target}` : `${WORK_KIND_LABEL[q.kind]}${q.taskId ? ` ${q.taskId}` : ''}`;
}

/** 보류 넘김이 메인에게 있는지 볼 때 쓰는 '가장 최근 항목이 살아 있나' — 대기·실행 중이거나 since 뒤에 받아 마쳤다 */
export function aliveFor(q: QueueEntry | null | undefined, since?: string): boolean {
  if (!q || q.state === 'cancelled') return false;
  return q.state === 'queued' || q.state === 'running' || !since || q.createdAt >= since;
}
