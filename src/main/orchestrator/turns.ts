/**
 * 턴 실행기와 스케줄러 (15.4, 5.7, 8장, CLI-18..22).
 * - 스케줄러: 대기열 + 대기 작업 활성화 후보 → 실행 허용 검사 → 자리 배정 → 턴 시작
 * - 턴 실행기: 세션 결정 → 지침·메시지·앱 도구 토큰 → 어댑터 → 프로세스 → 이벤트 해석·저장 → 감시 → 종료 판정
 * 자리는 launch()가 동기적으로 예약하므로 tick이 겹쳐도 중복 실행되지 않는다 (CLI-20).
 */
import { createWriteStream, existsSync, mkdirSync, type WriteStream } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  AgentSession,
  AiAvailability,
  AiKind,
  HoldReasonKind,
  Member,
  Project,
  QueueEntry,
  RunnerKind,
  SessionKind,
  SlotClass,
  StopMode,
  StopState,
  Task,
  Turn,
  TurnEndReason,
  WorkKind,
} from '@shared/domain';
import { MAIN_AGENT_ID } from '@shared/domain';
import type { CliEvent, ParsedCliEvent } from '@shared/events';
import { DIRECTIVE_STATE_LABEL, HOLD_REASON_LABEL, TASK_STATE_LABEL, WORK_KIND_LABEL } from '@shared/labels';
import { checkRunGate, TASK_BOUND_KINDS, type GateResult } from '@core/runGate';
import { MODEL_FAMILY_LABEL, modelInFamily, modelLimitFamily } from '@core/usageLimits';
import { mainCanReview } from '@core/reviewRules';
import { pickStarts, type RunningSlot, type StartCandidate } from '@core/scheduling';
import { PRIORITY_RANK } from '@shared/domain';
import { isTerminal } from '@core/taskMachine';
import { isDirectiveOpen } from '@core/directiveMachine';
import { stripImages } from '@core/imageStrip';
import type { EventParser, TurnLaunch } from '../agents/types';
import { LaunchError } from '../agents/common';
import { unconfirmedEnvProblem, type ExitInfo, type ManagedProcess, type TerminateResult } from '../process/types';
import type { TokenIdentity } from '../mcp/types';
import { SECRET_KEYS } from '../auth/types';
import type { Core } from './core';
import type { Ctx } from './context';
import { buildSystemPrompt, buildTurnMessage } from './prompts';
import { cancelQueued, directiveKey, enqueue, isUrgentDirect, isUrgentMessage, mainKey, markMessagesDelivered, newestEntry, noteMessagesUndelivered, parseKey, reviewKey, slotClassOf, transitionTask, workProjectOf } from './records';
import { artifactWorkDir, eventsFile, turnTmpDir } from './paths';
import { removeTree } from './fsutil';
import { activeTaskOf, closedDirectiveWork, deferredMessageTask, directiveTasks, memberOrSuccessor, prereqsDone, producerOf, roleOf } from './lookups';
import { conflictFixGuide, NO_REVIEWER_HOLD_REF, reviewTurnStale } from './tasks';
import { ALERT_KIND_LABEL, alertEnded, alertHead, alertMain, alertTaskHold, carrySupersededAlert, deletedMemberAlertText, handOverDroppedText, memberAlertText, OWNER_HANDED, OWNER_TELL_MAIN, ownerExit, parseAlertKey, producerStuckText, RESTART_ALERT_KINDS, restartDroppedText, type CarryOutcome, type TaskAlertKind } from './alerts';
import type { RunnerFields } from './seat';
import type { HostExecStop } from './hostExec';
import { MCP_TOOL_TIMEOUT_SEC } from '../agents/common';
import { aiModelKey, deadScreenCheck, externalModelKey } from '../desktop/service';
import { EXTERNAL_STOP, ExternalRun } from './externalAgents';

/**
 * 외부 보유자의 턴을 띄우려는데 그 에이전트의 롱폴(work/next)이 그사이 사라졌다 (리드 결정 S7-4) — 턴 기록 전 실패라 일은 대기열에 그대로 남고, 시작 실패로 세지 않는다
 * (에이전트가 다시 받으러 오면 그때 띄운다)
 */
class ExternalPollGone extends Error {}

interface LiveTurn {
  turnId: string;
  memberId: string;
  sessionKey: string;
  sessionId: string;
  sessionKind: SessionKind;
  slotClass: SlotClass;
  taskId: string | null;
  directiveId: string | null;
  projectId: string | null;
  /**
   * 이 턴이 어느 프로젝트의 일인지 — 작업 키에서 뽑는다(records.workProjectOf). 턴·세션 기록과 토큰에 적고, 턴의 활동 기록은 projectId가 없으면(메인 에이전트)
   * 이 값으로 남긴다(loggedProject). 알림 링크와 보고 통계는 그대로 projectId (SERVER_DESIGN 5.4, 리드 결정 S5-5)
   */
  workProjectId: string | null;
  entryIds: string[];
  entryKinds: WorkKind[];
  /** 검수 턴: 띄울 때 고정돼 있던 검수 대상의 고정 시각 (턴 기록 `reviewPinnedAt`과 같음) — 이 턴이 보는 버전 */
  reviewPinnedAt: string | null;
  /** 실행 주체의 종류 — 서버가 띄우는 CLI(claude·codex) 또는 외부 보유자(external, 7단계 — 리드 결정 S7-2) */
  aiKind: RunnerKind;
  /**
   * 외부 보유자의 턴 (리드 결정 S7-4) — 스케줄러가 고를 때의 보유자. 이 턴은 프로세스를 띄우지 않고 그 에이전트의 롱폴로 일을 넘긴다(ExternalRun). CLI 턴은 null
   */
  external: { agentId: string; label: string } | null;
  /** 이 턴이 CLI에 넘긴 모델 (null = CLI 기본 모델) — 모델별 주간 한도를 그 계열에 거는 데 쓴다 (리드 결정 22) */
  model: string | null;
  mock: boolean;
  /** 메인 턴: 띄울 때(스케줄러가 고른 때)의 자리 세대 — 토큰에 적는다 (SERVER_DESIGN 4.1, 리드 결정 S4-4). 팀원 턴은 null */
  seatGeneration: number | null;
  proc: ManagedProcess | null;
  token: string | null;
  startedMs: number;
  lastActivityMs: number;
  lastStepMs: number;
  suspectSinceMs: number | null;
  commands: Map<string, number>;
  errorCounts: Map<string, number>;
  stepsCompleted: number;
  seq: number;
  stream: WriteStream | null;
  eventsPath: string;
  stop: { mode: StopMode; reason: string; user: boolean; endReason: TurnEndReason; requested: boolean } | null;
  /** 프로그램이 이 턴의 프로세스를 끝낸 결과 (첫 terminate 호출의 약속). 확인하지 못했으면(ok=false) finish가 kill_failed를 지킨다 (CTL-11) */
  stopResult: Promise<TerminateResult> | null;
  /**
   * 이 턴이 부른 서버 명령(host_exec)이 남긴 하위 프로세스 (noteUnconfirmed — 남은 수, -1 = 확인하지 못함). finish가 그 턴의 남은 프로세스로 접는다 — 턴이
   * kill_failed로 끝나 메인 에이전트가 일시정지된다 (리드 결정 S5-18, CTL-11)
   */
  hostUnconfirmed: { remaining: number; detail: string } | null;
  /** 턴 마무리(finish)를 시작했다 — 그 뒤에는 이 턴의 서버 명령을 새로 띄우지 않는다 (마무리가 실행 중 목록을 이미 거뒀을 수 있다, 리드 결정 S5-18) */
  finishing: boolean;
  /**
   * 러너가 알려 준 이 턴 실행의 끝 (CLI 프로세스, 외부 실행도) — 받은 그때 적는다. 정지가 오기 전에 실행이 끝났는지(runEnded)와, 그 끝이 남긴 후손을 확인했는지
   * (remaining — 0이 아니면 정지의 답이 확인 실패다)를 정지가 본다 (리드 결정 S7-17 F1·S7-22 S1). 아직 끝나지 않았으면 null
   */
  exit: ExitInfo | null;
  /** 질문·막힘 보고 뒤 CLI가 턴을 스스로 끝내지 않으면 프로그램이 끝내는 예약 (endAfterQuestion) */
  questionEndTimer: NodeJS.Timeout | null;
  /** 질문·막힘 보고 등으로 이 턴을 끝내기로 한 때와 까닭 (endAfterQuestion) — 그 뒤 출력이 멈춘 시간·상한으로 끝낸다 */
  questionEnd: { why: string; sinceMs: number } | null;
  /** CLI 표준 출력의 마지막 줄 시각 (해석해 버리는 추론 진행·keep-alive 줄 포함) — 질문 뒤 출력이 멈췄는지 본다 */
  lastOutputMs: number;
  /** 이 검수 턴에 보인 대표 지시(그 작업에 온 대표 직접 메시지 ID) — 턴 메시지·검수 대상 조회·업무 문맥·거부 안내로 보인 것 (CTL-06) */
  ownerNotesShown: Set<string>;
  /** 대표 직접 메시지를 먼저 전달하려고 판정을 받지 않고 끝내는 턴 — 판정 재촉·검수자 교체 요청으로 세지 않는다 (endForOwnerMessage) */
  ownerMessageFirst: boolean;
  /**
   * 질문(ask_producer)·막힘 보고(report_blocked) 뒤 끝내기로 한 턴 — 답변(또는 막힘 조치)이 다음 턴을 연다. 그 답이 턴이 끝나기 전에(질문 뒤 창 안에)
   * 와서 작업이 진행·검수로 돌아왔어도 진척 없는 재개·판정 없는 검수 턴으로 세지 않는다 (15.4, AC-37, S7-B4)
   */
  endedForQuestion: boolean;
  flags: {
    bypassMismatch: string | null;
    /** 바이패스 불일치가 설정 문제인지 (권한 모드가 bypassPermissions가 아니거나 확인 전). false면 확인 뒤의 개별 명령 거부 */
    bypassConfig: boolean;
    /** rateLimitType: CLI가 알려 준 한도 종류 (seven_day_opus 등, 모를 때 null) */
    usageLimit: { resetAt: string | null; message: string; rateLimitType: string | null } | null;
    auth: string | null;
    resumeFailed: boolean;
    spawnError: string | null;
    /** 시작 실패가 CLI 실행 파일 문제(AI 종류 전체)인지 — LaunchError.cliUnavailable (CLI-15) */
    spawnCliUnavailable: boolean;
    sawResult: boolean;
    resultIsError: boolean;
    finalText: string | null;
    mcp: 'connected' | 'unknown' | 'failed';
    bypass: 'verified' | 'requested' | 'mismatch';
  };
  usage: { inputTokens: number; outputTokens: number; costUsd: number | null };
  cleanup: string[];
  pendingUi: CliEvent[];
  uiTimer: NodeJS.Timeout | null;
  lastPersistMs: number;
  lastLine: string | null;
  label: string;
  done: Promise<void>;
  resolveDone: () => void;
}

/**
 * 버린 항목을 알리고 이어 갈 쪽을 정하는 데 필요한 턴의 모양 (dropAnnounced·handOffStuckReviews·standingLost) — 돌던 턴(LiveTurn)이나, 재시작 복구가
 * 맞추는 끊긴 턴 기록 (리드 결정 39)
 */
type TurnRef = Pick<LiveTurn, 'memberId' | 'sessionKey' | 'sessionKind' | 'directiveId' | 'projectId' | 'entryIds'>;

/** 턴 활동 기록의 프로젝트 — 팀원 프로젝트, 없으면(메인 에이전트) 작업 키의 프로젝트 (SERVER_DESIGN 5.4, 리드 결정 S5-5). 알림 링크는 projectId 그대로 */
const loggedProject = (l: Pick<LiveTurn, 'projectId' | 'workProjectId'>): string | null => l.projectId ?? l.workProjectId;

export interface StopResult {
  turnId: string;
  memberId: string;
  /** 멈춘 턴의 업무 세션 — 프로듀서 교체가 남은 프로세스를 거부 글에 그 세션으로 적는다 (리드 결정 S5-62) */
  sessionKey: string;
  taskId: string | null;
  ok: boolean;
  detail: string;
  /** 종료 확인에 실패했을 때 남은 프로세스 수 (-1 = 확인하지 못함). 알림이 '남았다'와 '확인하지 못했다'를 가른다 (S7-D3) */
  remaining?: number;
  /** 정지가 오기 전에 실행이 이미 끝난 턴 — 이 정지가 멈추지 않았다('이미 마친 턴'). 그 턴은 그 실행이 낸 끝 까닭으로 끝난다 (리드 결정 S7-17 F1) */
  alreadyEnded?: true;
}

const RESET_FALLBACK_MS = 30 * 60_000;
/** 같은 업무가 프로세스를 띄우기 전에 이 횟수만큼 실패하면 멈추고 알린다 (ERR-04 자동 재시도 상한) */
const START_FAIL_LIMIT = 3;
/**
 * 같은 업무를 실은 턴이 앱·PC 재시작으로 이 횟수만큼 끊기면 재시작 복구가 다시 넣지 않고 버린 뒤 알린다 (리드 결정 39, QueueEntry.restarts) — 그 턴이 앱째
 * 끝내면 재시작마다 다시 넣어 끝없이 돈다. 비정상 종료 상한(attempts)과 따로 센다
 */
export const RESTART_CUT_LIMIT = 3;

/**
 * 재시작 상한에서 버린 항목인지 (리드 결정 39·44) — 재시작 복구가 RESTART_CUT_LIMIT번째로 끊긴 업무를 다시 넣지 않고 둔 모양(취소, restarts가 상한 이상).
 * 재시작으로 끊긴 횟수는 재시작 복구만 올리고 상한에서 버리므로, 이 모양은 그 버림뿐이다. 따로 저장하지 않고 이 모양으로 알아본다
 */
export function isRestartLimitDrop(q: QueueEntry): boolean {
  return q.state === 'cancelled' && (q.restarts ?? 0) >= RESTART_CUT_LIMIT;
}

/**
 * 같은 대상의 가장 최근 항목(상태와 상관없이)이 재시작 상한에서 버린 것인지 (리드 결정 44). 시작 때 다시 만드는 쪽(관리 업무 복원, 검수 안전망, 재시작 3))이
 * 다시 만들기 전에 본다. 그렇다면 다시 만들지 않는다 — 같은 시작에서 0부터 다시 넣으면 앱째 끝내는 턴이 끝없이 돌고 '더는 자동으로 다시 시도하지 않습니다'
 * 알림이 거짓이 된다. 버림 알림이 그 일의 업무다. 그 뒤 정상 경로로 생긴 같은 대상의 항목은 더 최근이라 이 판정을 푼다.
 * since: 이 시각 전에 만든 항목은 다른 대상(지난 회차, 앞선 정지)의 것이라 보지 않는다
 */
export function restartDropped(entries: readonly QueueEntry[], since?: string | null): boolean {
  const last = newestEntry(since ? entries.filter((q) => q.createdAt >= since) : entries);
  return !!last && isRestartLimitDrop(last);
}
/**
 * 턴 종료 확인 제한 (CTL-03 3초 안). 러너는 job을 비우는 데 2초 + 출력 마무리 0.3초 안에 스스로 보고하므로 그보다 길게 기다린다 —
 * 짧으면 러너가 보고하기 직전에 러너째 강제 종료해 남은 프로세스 수를 잃고 실패로 적는다 (windows:F9)
 */
export const STOP_CONFIRM_MS = 2800;
/**
 * 질문·막힘 보고 뒤 CLI가 도구 결과("지금 턴을 마치세요")를 받고 스스로 턴을 끝내기를 기다리는 시간 — 출력이 이만큼 멈추면 프로그램이 끝낸다
 * (15.4 "해당 작업 보류, 팀원 프로세스 종료", AC-37). 마무리 응답을 만드는 모델 호출은 몇 초를 넘기 흔하므로 출력이 이어지는 동안은 기다린다
 * (추론 진행·keep-alive 줄도 출력). deps.timing.questionEndGraceMs로 바꾼다
 */
export const QUESTION_END_GRACE_MS = 8000;
/** 질문 뒤 계속 출력하며 끝내지 않는(마치라는 안내를 따르지 않는) CLI도 이 시간 안에 끝낸다. deps.timing.questionEndCapMs로 바꾼다 */
export const QUESTION_END_CAP_MS = 30_000;
/**
 * 계획 중인 지시가 막 만든 작업을 시작하기 전에 기다리는 시간 (S8-B2): 그 지시의 계획 턴이 마지막으로 작업을 만든 뒤 이만큼 — 같은 계획에서 곧이어 만드는
 * 작업·검수자 지정이 모이는 동안만. 계획 턴 전체를 기다리지 않는다 (계획 동안 실행 보류는 TSK-07 '계획 승인 후 시작'을 켰을 때만 — 기본 꺼짐)
 */
export const PLAN_SETTLE_MS = 1500;
/** 세션 교체 인계 요약에 넣는 최근 보류·해제 기록 수와 질문 수 (ERR-03) */
const HANDOVER_HOLD_EVENTS = 6;
const HANDOVER_QUESTIONS = 5;
/** 판정 기회 없이 끝난 다시 판정 턴의 종료 사유 글 (rejudgeCut, S7-B3) */
const REJUDGE_CUT_TEXT: Partial<Record<TurnEndReason, string>> = {
  crashed: '비정상 종료',
  no_response: '응답 없음',
  timeout: '시간 상한',
  usage_limit: '사용량 한도',
  auth_required: '재로그인 필요',
  bypass_mismatch: 'CLI 안전 검사 거부',
  spawn_failed: 'CLI 실행 실패',
  spin: '헛돌기',
};
/** 정상으로 끝나지 않은 턴의 끝 사유 글 — 멈춘 검수 넘김의 머리말이 팀원에게 보낸 지시가 처리되지 못한 까닭으로 쓴다 (sentInstructionsText, 리드 결정 40) */
const CUT_END_TEXT: Partial<Record<TurnEndReason, string>> = { ...REJUDGE_CUT_TEXT, user_stop: '정지', app_restart: '앱 재시작' };
/** 세션 교체 인계 요약에 넣는 그 업무 세션의 대표 직접 메시지 수 (CTL-06, ERR-03) */
const HANDOVER_OWNER_MESSAGES = 5;
/**
 * 병합 충돌을 풀지 못한 헛돌기 보류의 사유 머리말 — 같은 충돌의 두 번째 헛돌기(대표 보고, GIT-07)를 전이 기록에서 알아보는 데도 쓴다. 메인에게 넘긴 그 보류(alert
 * conflict-stuck)가 아직 그대로인지도 이것으로 본다 (alerts.ts)
 */
export const CONFLICT_SPIN_NOTE = '병합 충돌 미해결';
/** 프로듀서가 검수자 재배정 업무를 처리하지 않을 때 다시 재촉하는 횟수 — 그 뒤에는 메인 에이전트에게 넘긴다 (리드 결정 11) */
const REVIEWER_ASSIGN_NUDGES = 2;
/**
 * 대상이 풀릴 때까지 남는 메인 에이전트 업무(멈춘 검수 넘김, 프로그램이 일시정지한 팀원의 재개)를 메인 턴 몇 번에 실어 보내는지 — 그래도 그대로면
 * 대표에게 그 작업·팀원을 알린다. 보고서 작성 재촉(main_report)과 같은 횟수다 (리드 결정 24·26)
 */
const MAIN_STANDING_DELIVERIES = 3;
/** 예전 코드가 남는 업무 글 앞에 저장해 둔 머리말 — 이제 머리말은 전달할 때만 붙이므로(standingHead) 이전 기록의 것을 떼어 낸다 */
const STANDING_NUDGE_HEAD = /^\(\d+번째 알림 — [^\n]*\n\n/;
/**
 * 끊긴 턴의 업무를 다시 넣을 때(requeue) 붙는 앞말 '<까닭>\n\n(다시 전달) '. 까닭은 늘 한 줄이다 — requeue가 그 안의 줄바꿈을 접는다(requeueLead).
 * 여러 줄이면(CLI 안전 검사 거부 글 등) 이 앞말을 떼지 못해 남는 업무 글에 쌓이고, 버린 대표 명령의 이름이 그 까닭 글이 된다 (리드 결정 40)
 */
const REQUEUE_PREFIX = /^[^\n]*\n\n\(다시 전달\) /;

/** 다시 넣기 앞말의 까닭 — 줄바꿈을 한 칸으로 접어 한 줄로 (REQUEUE_PREFIX가 늘 떼어 낼 수 있게) */
function requeueLead(extra: string): string {
  return extra.replace(/\s*[\r\n]+\s*/g, ' ').trim();
}

/**
 * 남는 업무(멈춘 검수 넘김·팀원 재개)의 본문 — 앞에 쌓인 다시 넣기 앞말과 예전 머리말을 떼어 낸 원래 안내. 다시 전달할 때 그 앞에 지금의 머리말만 붙인다
 * (리드 결정 31: 머리말이 쌓이지 않게)
 */
export function standingBody(message: string): string {
  let m = message;
  for (;;) {
    const next = m.replace(STANDING_NUDGE_HEAD, '').replace(REQUEUE_PREFIX, '');
    if (next === m) return m;
    m = next;
  }
}

/** 예전 재개 업무 글이 넣을 때 저장해 둔 '멈춘 업무' 목록 줄과 그 끝 문장 — 이제 머리말이 전달할 때 적으므로(standingHead) 떼어 낸다 (리드 결정 37) */
const LEGACY_PAUSE_WORK = [/\n- 멈춘 업무: [^\n]*/, / 재개하기 전까지 [^\n]*는 멈춰 있습니다\.$/] as const;

/** 남는 업무의 원래 안내(standingBody) — 재개 업무면 예전 기록이 저장해 둔 '멈춘 업무' 목록도 뗀다. 업그레이드 전에 넣은 항목도 낡은 목록을 전하지 않게 (리드 결정 37) */
function standingText(q: QueueEntry): string {
  const body = standingBody(q.message);
  return q.pausedMemberId ? LEGACY_PAUSE_WORK.reduce((m: string, re) => m.replace(re, ''), body) : body;
}

/** 남는 업무인지 — 멈춘 검수 넘김(isReviewHandOff)이나 프로그램이 일시정지한 팀원의 재개(pausedMemberId)를 맡긴 메인 에이전트 업무 (리드 결정 24·26·31) */
export function isStandingItem(q: QueueEntry): boolean {
  return (!!q.pausedMemberId && q.memberId === MAIN_AGENT_ID) || isReviewHandOff(q);
}

/** 받침이 있으면 '이', 없으면 '가' — 알림 글의 '…이(가) 반복됩니다'를 자연스럽게 */
function subjectJosa(word: string): string {
  const c = word.charCodeAt(word.length - 1) - 0xac00;
  return c >= 0 && c <= 11171 && c % 28 !== 0 ? '이' : '가';
}
/** 받침이 있으면(ㄹ 받침 빼고) '으로', 아니면 '로' — '응답 없음으로 끝났습니다' */
function instrumentalJosa(word: string): string {
  const c = word.charCodeAt(word.length - 1) - 0xac00;
  return c >= 0 && c <= 11171 && c % 28 !== 0 && c % 28 !== 8 ? '으로' : '로';
}

/** 턴이 끝난 까닭 → 그 턴의 서버 명령(host_exec)을 끝낸 까닭 (결과의 stopped) — 긴급 정지·앱 종료·자리 교체가 아니면 턴 종료 */
function hostStopOf(reason: string | null): HostExecStop {
  if (reason?.startsWith('긴급 정지')) return '긴급 정지';
  if (reason?.startsWith('앱 종료')) return '앱 종료';
  if (reason?.startsWith('메인 자리 교체')) return '메인 자리 교체';
  return '턴 종료';
}

/** 턴 기록의 남은 프로세스 설명 (remaining: 남은 수, -1이면 확인하지 못함) */
function leftoverText(remaining: number): string {
  return remaining > 0 ? `정리 후 남은 프로세스 ${remaining}개` : '정리 후 남은 하위 프로세스를 확인하지 못함';
}

/**
 * 종료를 확인하지 못한 실행을 무엇으로 막는지 (blockUnconfirmedRun) — 알림 글(unconfirmedNote)이 출구를 사실대로 말하게 한다.
 * - main_pause: 메인 에이전트의 관리 실행(main:<P>) → 메인 에이전트 일시정지. 대표의 '정지 해제'로만 풀린다 (리드 결정 6)
 * - member_pause: 프로듀서 등 팀원의 관리 실행 → 그 팀원 일시정지 + 메인 에이전트에게 재개 업무 (handPauseToMain, 리드 결정 26)
 * - task_hold: 작업·검수 세션의 턴과 자동 검사 → 작업 보류(오류) + 메인 에이전트에게 알림 업무 (alert kill-failed, 리드 결정 S5-7·S5-8)
 */
export type UnconfirmedBlock = 'main_pause' | 'member_pause' | 'task_hold';
/**
 * 알림 글의 출구 (unconfirmedNote) — 막는 방법에 더해 그 일이 메인에게 갔는지: handed는 메인 에이전트에게 알림 업무를 넣었다(작업 보류, 이미 일시정지된 팀원 —
 * 리드 결정 S5-9·26), task_hold는 넘기지 못했다(같은 보류를 이미 받아 마쳤거나 버림) — 결정 32의 문장
 */
export type UnconfirmedExit = UnconfirmedBlock | 'handed';

/** 이 실행(팀원·세션 종류)의 종료를 확인하지 못하면 blockUnconfirmedRun이 무엇으로 막는지 */
export function unconfirmedBlock(memberId: string, sessionKind: SessionKind): UnconfirmedBlock {
  if (sessionKind === 'task' || sessionKind === 'review') return 'task_hold';
  return memberId === MAIN_AGENT_ID ? 'main_pause' : 'member_pause';
}

/**
 * 종료를 확인하지 못한 실행의 사실 (CTL-11) — 작업 보류 사유 글은 이것만 담는다(사실만, 출구 문장 없이 — 리드 결정 S5-9). 남은 수를 알면 그 수를, 모르면(-1)
 * 확인하지 못했다고 쓴다 — 확인하지 못한 것을 남았다고 쓰지 않는다. envProblem: 실행 환경 문제(작업 개체 도우미를 쓸 수 없음 등)면 그 까닭을 앞세운다
 */
export function unconfirmedFacts(envProblem: string | null, remaining: number, cause: string | null, what: '턴' | '자동 검사' | '이전 실행' | '서버 명령'): string {
  if (remaining > 0) return `${what} 종료 뒤 하위 프로세스 ${remaining}개가 남았습니다 (종료 확인 실패).`;
  const why = envProblem ? `작업 개체 도우미를 쓸 수 없음 — ${envProblem}` : cause;
  return `${what} 종료 뒤 남은 하위 프로세스를 확인하지 못했습니다 — 이 실행이 띄운 프로세스(개발 서버 등)가 모두 끝났는지 알 수 없습니다${why ? ` (${clip(why, 240)})` : ''}.`;
}

/**
 * 종료를 확인하지 못한 실행의 대표 알림 글 (CTL-11) — 사실(unconfirmedFacts) + 출구. 대표에게는 재개가 없으므로 재개하라고 쓰지 않고, 출구(exit)마다 실제 길을 쓴다.
 * 남은 프로세스를 대표가 보는 곳은 모드마다 다르다 (리드 결정 S4-20·S5-9): 데스크톱은 이 PC의 작업 관리자, 서버는 서버 PC라 원격 대표는 운영자에게 부탁한다
 * - main_pause: 남은 프로세스가 사라졌는지 확인한 뒤 '정지 해제'를 누르라고 (리드 결정 6). 메인은 정지돼 턴이 뜨지 않아 스스로 풀 수 없다
 * - member_pause: 메인 에이전트가 재개 업무를 받으므로 확인되면 메인 에이전트가 이어 가고, 대표는 명령창으로 알릴 수 있다고 (리드 결정 26 — 살아 있는 재개 업무가
 *   있을 때만 쓴다)
 * - handed: 메인 에이전트에게 알림 업무를 넣었다 — 무엇을 했는지(lead)와 '…메인 에이전트에게 넘겼습니다. 메인 에이전트가 확인하고 이어 갑니다 — 서둘러야 하면 …'
 *   (리드 결정 S5-9). lead: 작업 보류는 '작업을 보류하고 ', 이미 일시정지된 팀원은 '팀원 일시정지는 그대로 두고 ' 등
 * - task_hold: 넘기지 못했다 — 정리되면 명령창으로 메인 에이전트에게 알려 달라고 (결정 32의 문장)
 */
export function unconfirmedNote(
  envProblem: string | null,
  remaining: number,
  cause: string | null,
  what: '턴' | '자동 검사' | '이전 실행' | '서버 명령',
  exit: UnconfirmedExit,
  mode: 'desktop' | 'server' = 'desktop',
  lead = '',
): string {
  const facts = unconfirmedFacts(envProblem, remaining, cause, what);
  const server = mode === 'server';
  if (exit === 'handed') return `${facts} ${lead}${OWNER_HANDED}`;
  if (exit === 'main_pause') {
    const check = server
      ? '서버 PC에 남은 프로세스가 모두 사라졌는지 확인한 뒤(서버 PC를 직접 볼 수 없으면 서버 PC의 운영자에게 확인을 부탁하세요)'
      : '작업 관리자 등에서 남은 프로세스가 모두 사라졌는지 확인한 뒤';
    return `${facts} ${check} '정지 해제'를 누르세요 — 메인 에이전트의 일시정지가 풀려 쌓인 명령을 이어서 처리합니다`;
  }
  const check =
    remaining > 0
      ? exit === 'member_pause'
        ? '남은 프로세스가 정리됐는지 확인되면'
        : '남은 프로세스가 정리되면'
      : server
        ? '남은 프로세스가 없는지 확인되면'
        : '작업 관리자 등에서 남은 프로세스가 없는지 확인되면';
  const then = exit === 'member_pause' ? '메인 에이전트가 다시 이어 갑니다. 직접 정리했거나 서둘러야 하면 명령창으로 메인 에이전트에게 알려 주세요' : OWNER_TELL_MAIN;
  return `${facts} ${check} ${then}`;
}

/** 인계 요약 한 줄에 넣을 글: 줄바꿈·공백을 하나로 접고 길이를 자른다 */
function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * 상태 전이 기록의 보류 사유(core/taskMachine "보류: <종류> (<사유>)")를 인계 요약용으로: 종류는 이름으로 바꾼다.
 * 답변 대기의 사유 글은 질문 원문이고 검수자의 질문일 수도 있어 빼고, 질문은 그 세션 것만 질문·답변 줄에 넣는다 (MEM-11)
 */
function holdHistoryText(reason: string): string {
  const m = /^보류: ([a-z_]+)(?: \(([\s\S]*)\))?$/.exec(reason);
  if (!m) return reason;
  const label = HOLD_REASON_LABEL[m[1] as HoldReasonKind] ?? m[1]!;
  return m[1] === 'answer_wait' || !m[2] ? label : `${label} (${m[2]})`;
}

export interface StopOptions {
  /**
   * 프로세스를 띄우기 전(작업 폴더·검수 사본·어댑터 준비 중)인 턴을 이만큼만 기다린다. 정지 요청을 본 턴은 프로세스를 띄우지 않으므로
   * 긴급 정지는 준비(git 등)가 끝나기를 무한정 기다리지 않는다 (CTL-03, windows:F9). 생략하면 끝날 때까지 기다린다 —
   * 취소·지시 취소는 그 턴이 대기열 정리까지 마친 뒤에 다음 단계로 가야 한다 (CONC-04)
   */
  noProcessWaitMs?: number;
}

export class TurnRunner {
  private readonly live = new Map<string, LiveTurn>();
  /**
   * 턴 한 번의 전체 흐름(준비 → 실행 → 마무리 → 종료 판정). live에서 빠지고 done이 풀린 뒤에도 판정은 저장소를 쓰므로
   * 앱 종료는 저장소를 닫기 전에 이것까지 기다린다 (drain)
   */
  private readonly inflight = new Set<Promise<void>>();
  /** 턴 흐름마다 그 팀원 — 메인 자리 교체가 나가는 메인 턴의 마무리를 기다린다 (settleMember, 리드 결정 S4-3) */
  private readonly flowMember = new Map<Promise<void>, string>();
  /** 턴 ID → 그 턴의 흐름 — 프로듀서 교체가 멈춘 턴의 마무리·종료 판정을 턴마다 기다린다 (settleTurns·turnFlow, 리드 결정 S5-73) */
  private readonly flowTurn = new Map<string, Promise<void>>();
  /** 새 턴을 띄우지 않는 팀원(붙잡은 수) — 프로듀서 교체가 그 프로듀서의 정지와 그 마무리를 기다리는 동안 (holdLaunches, 리드 결정 S5-73) */
  private readonly launchHolds = new Map<string, number>();
  private watchdog: NodeJS.Timeout | null = null;
  /** 말풍선용 마지막 한 줄 (팀원별) */
  private readonly lastLines = new Map<string, { text: string; at: string }>();

  constructor(private readonly core: Core) {}

  private get ctx() {
    return this.core.ctx;
  }

  start(): void {
    const ms = this.ctx.deps.timing?.watchdogMs ?? 5000;
    this.watchdog = setInterval(() => this.checkWatchdog(), ms);
    this.watchdog.unref?.();
  }

  stopTimers(): void {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    // 앱 종료는 남은 턴을 모두 끝낸다 (stopAll) — 질문 뒤 종료 예약이 그 뒤(저장소를 닫은 뒤)에 돌지 않게
    for (const l of this.live.values()) {
      if (l.questionEndTimer) clearTimeout(l.questionEndTimer);
      l.questionEndTimer = null;
    }
  }

  /** 앱 종료: 시작·마무리 중인 턴의 흐름이 모두 끝날 때까지 기다린다 (상한 ms). 다 끝났으면 true */
  async drain(ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (this.inflight.size) {
      const left = deadline - Date.now();
      if (left <= 0) return false;
      if (!(await settlesWithin(Promise.allSettled([...this.inflight]), left))) return false;
    }
    return true;
  }

  /** 그 팀원의 턴 흐름(시작·실행·마무리·종료 판정)이 하나라도 남았는지 */
  hasMemberFlow(memberId: string): boolean {
    for (const m of this.flowMember.values()) if (m === memberId) return true;
    return false;
  }

  /**
   * 그 팀원의 턴 흐름이 모두 끝날 때까지 기다린다 (상한 ms). 다 끝났으면 true — 메인 자리 교체의 2번(나가는 메인 턴의 마무리, SERVER_DESIGN 4.3).
   * 판정까지 기다려야 세션을 닫는 5번이 끝나는 턴의 기록과 엇갈리지 않는다
   */
  async settleMember(memberId: string, ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    for (;;) {
      const runs = [...this.flowMember].filter(([, m]) => m === memberId).map(([run]) => run);
      if (!runs.length) return true;
      const left = deadline - Date.now();
      if (left <= 0) return false;
      if (!(await settlesWithin(Promise.allSettled(runs), left))) return false;
    }
  }

  /**
   * 그 턴들의 흐름(마무리·종료 판정)이 끝날 때까지 기다린다 (상한 ms) — 흐름이 끝난 턴 ID 묶음. 흐름이 이미 없는 턴도 끝난 것으로 센다. 프로듀서 교체가 멈춘 턴마다
   * 결과(남은 프로세스·보류·일시정지·다시 넣은 일)를 셀 때 쓴다 (리드 결정 S5-73 1). settleMember와 달리 그 팀원의 다른(새) 턴은 기다리지 않는다
   */
  async settleTurns(turnIds: readonly string[], ms: number): Promise<Set<string>> {
    const runs = turnIds.map((id) => this.flowTurn.get(id)).filter((r): r is Promise<void> => !!r);
    if (runs.length) await settlesWithin(Promise.allSettled(runs), ms);
    return new Set(turnIds.filter((id) => !this.flowTurn.has(id)));
  }

  /** 그 턴의 흐름이 끝나면 풀리는 약속 — 흐름이 없으면(이미 끝남) 바로 풀린다 (리드 결정 S5-73) */
  turnFlow(turnId: string): Promise<void> {
    return this.flowTurn.get(turnId) ?? Promise.resolve();
  }

  /**
   * 그 팀원의 새 턴을 띄우지 않게 붙잡는다 — 돌려준 함수로 푼다(여러 번 불러도 한 번). 프로듀서 교체가 그 프로듀서의 턴을 멈추고 그 마무리를 기다리는 동안 쓴다:
   * 멈춘 턴의 판정이 다시 넣은 일로 같은 프로듀서의 새 턴이 곧바로 뜨면 멈춘 결과를 셀 수 없고, 바꾸면 지운 팀원의 턴이 살아 남는다 (리드 결정 S5-73 1).
   * 스케줄러가 대기 업무와 대기 작업 활성화 둘 다에서 본다. 풀면 바로 다시 본다(tick)
   */
  holdLaunches(memberId: string): () => void {
    this.launchHolds.set(memberId, (this.launchHolds.get(memberId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const n = (this.launchHolds.get(memberId) ?? 1) - 1;
      if (n > 0) this.launchHolds.set(memberId, n);
      else this.launchHolds.delete(memberId);
      this.ctx.bus.signal('tick');
    };
  }

  /** 그 팀원의 새 턴을 띄우지 않게 붙잡혀 있는지 (holdLaunches) */
  launchHeld(memberId: string): boolean {
    return this.launchHolds.has(memberId);
  }

  // ───────────────────────── 조회 ─────────────────────────

  running(): RunningSlot[] {
    return [...this.live.values()].map((l) => ({ memberId: l.memberId, sessionKey: l.sessionKey, slotClass: l.slotClass }));
  }
  count(): number {
    return this.live.size;
  }
  hasLiveSession(key: string): boolean {
    return [...this.live.values()].some((l) => l.sessionKey === key);
  }
  /**
   * 계획 중인 지시가 막 만든 작업을 언제까지 기다리게 하는지 (ms — 스케줄러가 팀원별 다음 작업을 고를 때, S7-B7·S8-B2). 그 지시의 계획 턴(프로듀서가 작업을
   * 나누고 배정하는 '계획' 업무를 실은 지시 세션 턴)이 돌고, 그 턴이 시작된 뒤 만든 그 지시의 작업 중 가장 늦은 것이 PLAN_SETTLE_MS 안이면 그때부터
   * PLAN_SETTLE_MS 뒤까지, 아니면 null(기다리지 않음). 곧이어 만드는 작업·검수자 지정이 모인 뒤 같은 차례에 우선순위 → 대기 등록 순(TSK-05, 5.7)으로
   * 시작하므로 시작 순서가 도구 호출 사이 몇십 ms에 따라 달라지지 않고, 계획 턴이 길어도(실제 CLI는 몇 분) 그동안 작업을 묶어 두지 않는다
   */
  planSettleUntil(directiveId: string, nowMs: number): number | null {
    const key = directiveKey(directiveId);
    const plan = [...this.live.values()].find((l) => l.sessionKey === key && l.entryKinds.includes('plan'));
    if (!plan) return null;
    const latest = directiveTasks(this.ctx, directiveId).reduce((last, t) => {
      const at = Date.parse(t.createdAt);
      return at >= plan.startedMs && at > last ? at : last;
    }, -Infinity);
    const until = latest + PLAN_SETTLE_MS;
    return until > nowMs ? until : null;
  }
  /** exceptTurnId: 그 턴은 세지 않는다 (막 시작하는 턴 자신, CONC-12) */
  isMemberRunning(memberId: string, exceptTurnId?: string): boolean {
    return [...this.live.values()].some((l) => l.memberId === memberId && l.turnId !== exceptTurnId);
  }
  liveOf(memberId: string): { turnId: string; kind: WorkKind; label: string; startedAt: string } | null {
    const l = [...this.live.values()].find((x) => x.memberId === memberId);
    if (!l) return null;
    return { turnId: l.turnId, kind: l.entryKinds[0] ?? 'message', label: l.label, startedAt: new Date(l.startedMs).toISOString() };
  }
  lastLineOf(memberId: string): { text: string; at: string } | null {
    return this.lastLines.get(memberId) ?? null;
  }
  liveTurnIds(): string[] {
    return [...this.live.keys()];
  }

  // ───────────────────────── 정지 ─────────────────────────

  private async terminate(l: LiveTurn, reason: string, user: boolean, endReason: TurnEndReason, o: StopOptions = {}): Promise<StopResult> {
    // 이미 끝난 턴(단계 완료 300ms 뒤의 예약 종료 등이 늦게 도착)은 건드리지 않는다 — 끝난 턴의 프로세스 상태를 덮어쓰지 않게 (CONC-13)
    if (!this.live.has(l.turnId)) return { turnId: l.turnId, memberId: l.memberId, sessionKey: l.sessionKey, taskId: l.taskId, ok: true, detail: '이미 끝난 턴' };
    // 정지가 오기 전에 실행이 이미 끝난 턴 — 러너가 CLI 프로세스의 끝을 알려 와 마무리 중이거나 외부 에이전트가 finish를 보냈다(외부 실행 끝). 멈추지 않는다: 정지를
    // 표시하지 않으므로 끝 까닭은 그 실행이 낸 그대로이고(정상이면 답을 한 번 남긴다) 다시 넣지 않는다. 이 정지가 끝낸 턴으로 세지 않는다(alreadyEnded). 앞서 걸린
    // 정지(단계 마치고 정지·내부 종료)가 있으면 지금처럼 그 정지로 끝난다 (리드 결정 S7-17 F1)
    if (l.proc && !l.stop && this.runEnded(l)) {
      const ended = { turnId: l.turnId, memberId: l.memberId, sessionKey: l.sessionKey, taskId: l.taskId, alreadyEnded: true as const };
      // 그 끝이 남긴 후손을 확인하지 못했으면(남은 수 −1·>0) 확인한 것으로 답하지 않는다 — 끝난 프로세스에게 물으면 러너가 그 끝 그대로 답한다(alreadyExited: 확인 실패와
      // 남은 수). 긴급 정지 요약은 그 실패 줄로 완료가 아니고, 작업 취소는 작업 폴더를 지우지 않는다 (AC-15·CTL-03·CTL-11, 리드 결정 S7-22 S1). 외부 실행에는 남은
      // 후손이 없다
      if (!(l.proc instanceof ExternalRun) && l.exit && l.exit.remaining !== 0) {
        const res = await l.proc
          .terminate({ timeoutMs: STOP_CONFIRM_MS, reason })
          .catch((e: unknown): TerminateResult => ({ ok: false, remaining: -1, detail: e instanceof Error ? e.message : String(e), durationMs: 0 }));
        if (!res.ok) return { ...ended, ok: false, detail: `종료 확인 실패: ${res.detail}`, remaining: res.remaining };
      }
      return { ...ended, ok: true, detail: '이미 마친 턴' };
    }
    if (!l.stop || !l.stop.requested || l.stop.mode !== 'immediate') {
      l.stop = { mode: 'immediate', reason, user, endReason, requested: true };
    }
    this.persistTurn(l, { process: 'stop_requested' });
    if (!l.proc) {
      // begin()은 프로세스를 띄우기 바로 앞(같은 동기 구간)에서 정지 요청을 확인한다 → 이 턴은 이제 프로세스를 띄우지 않는다
      const settled = o.noProcessWaitMs === undefined ? (await l.done, true) : await settlesWithin(l.done, o.noProcessWaitMs);
      return {
        turnId: l.turnId,
        memberId: l.memberId,
        sessionKey: l.sessionKey,
        taskId: l.taskId,
        ok: true,
        detail: settled ? '실행 전 취소' : '실행 전 정지 — 시작 준비(작업 폴더 등)가 끝나면 프로세스를 띄우지 않고 끝납니다',
      };
    }
    // 외부 보유자의 턴은 토큰을 폐기해 멈춘다 — 그 에이전트 프로세스가 끝났는지는 알 수 없다는 사실을 턴 기록(killDetail)에 남긴다. 상태는 exited다: 그 권한은 이미
    // 거뒀고 끝남을 확인할 길이 없어 CTL-11의 멈춤을 걸지 않는다 (리드 결정 S7-4)
    this.persistTurn(l, { process: 'terminating', ...(l.external ? { killDetail: EXTERNAL_STOP } : {}) });
    // 첫 종료 요청의 결과를 턴에 둔다 — 프로세스가 끝난 뒤의 판정(finish)이 같은 결과를 본다 (프로세스는 같은 약속을 돌려준다)
    const pending = l.proc
      .terminate({ timeoutMs: STOP_CONFIRM_MS, reason })
      .catch((e: unknown): TerminateResult => ({ ok: false, remaining: -1, detail: e instanceof Error ? e.message : String(e), durationMs: 0 }));
    l.stopResult ??= pending;
    const res = await pending;
    if (!res.ok) this.persistTurn(l, { process: 'kill_failed', killDetail: res.detail });
    return {
      turnId: l.turnId,
      memberId: l.memberId,
      sessionKey: l.sessionKey,
      taskId: l.taskId,
      ok: res.ok,
      // 외부 보유자의 턴은 '종료 확인'이 아니다 — 토큰·임대를 폐기했고 그 프로세스의 끝은 확인할 수 없다는 그 글 그대로 (리드 결정 S7-4)
      detail: res.ok ? (l.external ? res.detail : `종료 확인 (${res.durationMs}ms)`) : `종료 확인 실패: ${res.detail}`,
      ...(res.ok ? {} : { remaining: res.remaining }),
    };
  }

  /**
   * 그 턴의 실행이 끝났는지 — 러너가 CLI 프로세스(외부 실행)의 끝을 알려 왔거나(exit), 외부 에이전트의 finish를 받았다(외부 실행은 그 자리에서 끝나고 마무리는 곧
   * 이어진다). 마무리(finish)를 시작했어도 끝을 받지 못한 턴(프로세스를 띄운 뒤의 시작 실패)은 아니다 — 그 프로세스는 아직 살아 있을 수 있어 지금처럼 멈춘다
   */
  private runEnded(l: LiveTurn): boolean {
    return l.exit !== null || (l.proc instanceof ExternalRun && l.proc.ended);
  }

  async stopWhere(
    pred: (l: { memberId: string; sessionKey: string; taskId: string | null; projectId: string | null }) => boolean,
    reason: string,
    user: boolean,
    o: StopOptions = {},
  ): Promise<StopResult[]> {
    const targets = [...this.live.values()].filter((l) => pred(l));
    return Promise.all(targets.map((l) => this.terminate(l, reason, user, 'user_stop', o)));
  }

  /**
   * 모두 멈춘다 (긴급 정지·앱 종료). 정지가 오기 전에 실행이 이미 끝난 턴(마무리 중)은 멈추지 않으므로 그 답은 빼고 돌려준다 — 다만 그 끝이 남긴 후손을 확인하지
   * 못한 답(ok 아님)은 남긴다: 긴급 정지 요약이 그 실패 줄을 싣고 완료라고 하지 않는다. 그런 답도 alreadyEnded이므로 요약은 '턴 N개 종료'·멈춘 턴 목록에 세지
   * 않는다 (리드 결정 S7-17 F1·S7-22 S1)
   */
  async stopAll(reason: string, o: StopOptions = {}): Promise<StopResult[]> {
    return (await this.stopWhere(() => true, reason, true, o)).filter((r) => !r.alreadyEnded || !r.ok);
  }

  stopSessions(keys: string[], reason: string, user: boolean): Promise<StopResult[]> {
    return this.stopWhere((l) => keys.includes(l.sessionKey), reason, user);
  }

  stopMember(memberId: string, reason: string, user: boolean): Promise<StopResult[]> {
    return this.stopWhere((l) => l.memberId === memberId, reason, user);
  }

  /**
   * 외부 보유자의 턴을 비정상 종료로 끝낸다 (임대 만료·스스로 물러남·다시 claim·키 폐기 — externalAgents.ts, 리드 결정 S7-4): 비정상 종료 규칙으로 다시 넣는다
   * (attempts+1, 상한이면 버리고 알린다). 그 턴이 없으면 아무것도 하지 않는다
   */
  endExternal(turnId: string, why: string): void {
    const l = this.live.get(turnId);
    if (!l?.external) return;
    void this.terminate(l, why, false, 'crashed').catch((e: unknown) => this.ctx.log('error', `외부 턴 종료 실패 ${turnId}`, e));
  }

  /** 돌고 있는 외부 보유자의 턴 (긴급 정지 요약의 '종료 확인 불가' 줄 — StopService) */
  externalTurns(): { turnId: string; agentId: string; label: string }[] {
    return [...this.live.values()].flatMap((l) => (l.external ? [{ turnId: l.turnId, agentId: l.external.agentId, label: l.external.label }] : []));
  }

  /**
   * 메인 에이전트의 규칙 (seat/claim의 rules·skills, 리드 결정 S7-2) — 서버가 띄우는 CLI의 메인 대화(main_general) 시스템 프롬프트와 같은 글과 스킬 목록. CLI처럼
   * 시스템 프롬프트를 받을 수 없는 외부 에이전트에게 준다
   */
  mainRules(): { rules: string; skills: { name: string; allowedRoles: string[] }[] } {
    const ctx = this.ctx;
    const member = ctx.store.members.require(MAIN_AGENT_ID);
    const skills = this.skillCatalog();
    const rules = buildSystemPrompt({ member, role: null, project: null, sessionKind: 'main_general', cwd: this.core.mainWork.dir, manualSkills: this.manualSkillsFor(member.roleId), skillCatalog: skills });
    return { rules, skills };
  }

  /** 단계까지만 마치고 종료 (9장 일시정지 기본) */
  requestGraceful(pred: (l: { memberId: string; sessionKey: string }) => boolean, reason: string): void {
    for (const l of this.live.values()) {
      // 실행이 이미 끝난 턴(마무리 중)은 멈추지 않는다 — terminate와 같은 판정이다. 정지를 걸면 끝 까닭이 user_stop이 되어 마친 일이 다시 들어간다 (리드 결정 S7-22 S2)
      if (!pred(l) || l.stop || (l.proc && this.runEnded(l))) continue;
      l.stop = { mode: 'graceful', reason, user: true, endReason: 'user_stop', requested: true };
      this.persistTurn(l, { process: 'stop_requested' });
      // 작업 세션이 아니면 단계 개념이 없으므로 바로 종료
      if (l.sessionKind !== 'task') void this.terminate(l, reason, true, 'user_stop');
    }
  }

  /** complete_step 처리 직후 호출 — 진척 기록, 정지 요청이 있으면 종료 */
  noteStepProgress(turnId: string): void {
    const l = this.live.get(turnId);
    if (!l) return;
    l.stepsCompleted += 1;
    l.lastStepMs = this.ctx.clock.ms();
    l.lastActivityMs = l.lastStepMs;
    if (l.stop?.mode === 'graceful') {
      const reason = l.stop.reason;
      setTimeout(() => void this.terminate(l, `${reason} (단계 완료 후)`, true, 'user_stop'), 300);
    }
  }

  /**
   * 질문(ask_producer)·막힘 보고(report_blocked)·대표 메시지를 먼저 전달하려고 받지 않은 판정 직후 호출 — 그 턴에 할 일이 끝났으니 팀원 프로세스를
   * 끝내 자리를 돌려준다 (15.4 "해당 작업 보류, 팀원 프로세스 종료", AC-37, 5.7 자리 반환). 협조하는 CLI는 도구 결과("지금 턴을 마치세요")를 받고
   * 마무리 응답을 만드는 모델 호출을 한 번 더 한 뒤 result 이벤트(그 턴 전체의 사용량·비용·마지막 응답)를 내고 스스로 끝난다 — 그 호출은 몇 초를
   * 넘기 흔하다(추론 포함). 그래서 정해진 시간이 아니라 출력이 멈춘 시간으로 끊는다: CLI 표준 출력(추론 진행·keep-alive 줄 포함)이 questionEndGraceMs
   * 동안 없으면, 그리고 계속 출력하며 끝내지 않아도 questionEndCapMs가 지나면 프로그램이 끝낸다. 정지를 미리 걸지 않으므로 그 안에 스스로 끝낸 턴은
   * 그대로 기록되고(정지 요청 기록 없음, 사용량·마지막 응답 유지), 프로그램이 끝낸 턴도 정상 종료(completed)로 판정한다 — 비정상 종료·헛돌기로
   * 세지 않고, 보류된 작업은 판정이 손대지 않아 답변(또는 막힘 조치)이 다음 턴을 연다. 단계 마치고 정지(graceful)를 기다리던 턴이면 그 정지로
   * 끝낸다 (기록은 정지 그대로). 한 턴에 여러 번 불러도 처음 것으로 센다
   */
  endAfterQuestion(turnId: string, why: string, o: { forQuestion?: boolean } = {}): void {
    const l = this.live.get(turnId);
    if (!l) return;
    // 질문·막힘 보고로 끝내는 턴이다 — 판정이 진척 없는 재개·판정 없는 검수 턴으로 세지 않는다 (judgeTask·judgeReview, S7-B4)
    if (o.forQuestion !== false) l.endedForQuestion = true;
    if (l.questionEnd) return;
    const ctx = this.ctx;
    l.questionEnd = { why, sinceMs: ctx.clock.ms() };
    const check = (): void => {
      l.questionEndTimer = null;
      if (!this.live.has(l.turnId) || l.stop?.mode === 'immediate') return;
      const idleMs = ctx.deps.timing?.questionEndGraceMs ?? QUESTION_END_GRACE_MS;
      const capMs = Math.max(idleMs, ctx.deps.timing?.questionEndCapMs ?? QUESTION_END_CAP_MS);
      const now = ctx.clock.ms();
      const since = l.questionEnd!.sinceMs;
      const quietMs = now - Math.max(l.lastOutputMs, since);
      const left = Math.min(idleMs - quietMs, capMs - (now - since));
      if (left > 0) {
        // 아직 출력이 이어진다 — 마지막 출력에서 다시 잰다
        l.questionEndTimer = setTimeout(check, left);
        l.questionEndTimer.unref?.();
        return;
      }
      const sec = (ms: number) => `${Math.round(ms / 100) / 10}초`;
      const cause = quietMs >= idleMs ? `출력 없이 ${sec(quietMs)}` : `상한 ${sec(capMs)}`;
      const s = l.stop;
      void this.terminate(l, s ? `${s.reason} (${why}, ${cause})` : `${why} (${cause})`, s?.user ?? false, s?.endReason ?? 'completed').catch((e: unknown) =>
        ctx.log('error', `질문 뒤 턴 종료 실패 ${l.turnId}`, e),
      );
    };
    l.questionEndTimer = setTimeout(check, ctx.deps.timing?.questionEndGraceMs ?? QUESTION_END_GRACE_MS);
    l.questionEndTimer.unref?.();
  }

  /**
   * 대표 직접 메시지를 먼저 전달하려고 판정을 받지 않은 검수 턴을 끝낸다 (CLI-10 우선 전달, AC-36) — 프로그램이 끊는 턴이라 판정 재촉의 재시도
   * 횟수·검수자 교체 요청(reviewer_assign)으로 세지 않는다 (judgeReview). 검수자는 판정을 하려 했다
   */
  endForOwnerMessage(turnId: string, why: string): void {
    const l = this.live.get(turnId);
    if (!l) return;
    l.ownerMessageFirst = true;
    this.endAfterQuestion(turnId, why, { forQuestion: false });
  }

  // ───────────────────────── 서버 명령 (host_exec, 리드 결정 S5-18) ─────────────────────────

  /** host_exec를 부른 턴의 시작 시각과 정지 요청 — 턴 시간 상한까지 남은 시간과 시작 전 정지 확인에 쓴다. 실행 중인 턴이 아니면 null */
  hostExecTurn(turnId: string): { startedMs: number; stopping: boolean } | null {
    const l = this.live.get(turnId);
    return l ? { startedMs: l.startedMs, stopping: !!l.stop || l.finishing } : null;
  }

  /**
   * 서버 명령이 도는 동안 그 턴의 실행 중 명령으로 센다 — 감시가 응답 없음(noOutputMin) 대신 명령 상한(commandMaxMin)을 쓴다. 앱 도구 호출 동안 CLI는 출력이 없다.
   * 시작할 때도 마지막 활동으로 둔다 — 명령 상한은 그 명령이 시작한 때부터 센다(앞서 CLI가 오래 조용했어도 명령을 일찍 끊지 않는다, 리드 결정 S5-33).
   * 끝나면 그때를 마지막 활동으로 둔다 (CLI가 결과를 받고 다시 출력할 때까지)
   */
  noteHostCommand(turnId: string, key: string, running: boolean): void {
    const l = this.live.get(turnId);
    if (!l) return;
    const now = this.ctx.clock.ms();
    if (running) l.commands.set(`host_exec:${key}`, now);
    else l.commands.delete(`host_exec:${key}`);
    l.lastActivityMs = now;
    l.suspectSinceMs = null;
  }

  /**
   * 그 턴이 부른 서버 명령이 남긴 하위 프로세스를 그 턴에 접는다 (리드 결정 S5-18): 턴이 끝날 때 kill_failed가 되어 blockUnconfirmedRun이 메인 에이전트를 일시정지하고
   * 출구는 대표의 정지 해제다 — 자리 교체의 S4-26 멈춤도 자리 코드를 고치지 않고 그대로 걸린다. 실행 중인 턴이 아니면 false
   */
  noteUnconfirmed(turnId: string, remaining: number, detail: string): boolean {
    const l = this.live.get(turnId);
    if (!l) return false;
    const prev = l.hostUnconfirmed;
    // 확인하지 못함(-1)이 센 수보다 무겁다 — 여러 번이면 그것을 지킨다
    l.hostUnconfirmed = !prev ? { remaining, detail } : { remaining: prev.remaining < 0 || remaining < 0 ? -1 : prev.remaining + remaining, detail: `${prev.detail}; ${detail}` };
    return true;
  }

  /** 이 검수 턴에 보인 대표 지시를 적는다 (턴 메시지·검수 대상 조회·업무 문맥·거부 안내) — 판정 전에 모두 보였는지 본다 (CTL-06) */
  markOwnerNotesShown(turnId: string, ids: readonly string[]): void {
    const l = this.live.get(turnId);
    if (l) for (const id of ids) l.ownerNotesShown.add(id);
  }

  /** 이 턴에 아직 보이지 않은 것만 (ids 중). 실행 중인 턴이 아니면 null — 보인 기록이 없으니 판단하지 않는다 */
  ownerNotesUnseen(turnId: string, ids: readonly string[]): string[] | null {
    const l = this.live.get(turnId);
    return l ? ids.filter((id) => !l.ownerNotesShown.has(id)) : null;
  }

  /**
   * 메인 도구의 한 번 거부(resume_task·resume_member·resolve_recovery 등)가 거부 글로 보인 대기 항목을 그 호출의 메인 턴에 싣는다 (리드 결정 S5-49) — 실행 중,
   * 그 턴 ID, 그 턴이 실은 항목(턴 기록 queueEntryIds도). 그래서 다른 실은 항목과 같다: 정상으로 끝나면 finish가 받아 마친 것으로 두고, 끊기면(자리 교체·
   * 비정상 종료·긴급 정지) 다시 넣기가, 재시작으로 끊기면 재시작 복구가 다시 전달한다. 판정할 업무 종류(entryKinds)는 그대로 둔다 — 그 턴이 띄운 일이 아니다.
   * 실은 항목 맨 앞에 둔다: 이 턴이 같은 키의 앞선 알림(첫 알림)도 실었으면 끊겼을 때 이 항목이 먼저 다시 들어가고, 그 뒤 앞선 항목이 더 새 이 항목에 밀려 버려지며 그
   * 글을 이 항목에 옮겨 싣는다(carrySupersededAlert는 더 새 대기 항목에 싣는다, 리드 결정 S5-44 2) — 다시 전달이 두 트리를 싣는다.
   * 결과는 셋이다 (리드 결정 S5-56): 실음(그 턴 ID), 메인 턴이 없음(운영자·시험 신원이나 팀원 턴 — 호출자가 받아 마친 것으로 둔다), 그 메인 턴이 이미
   * 끝남(턴 기록이 메인의 것인데 실행 중이 아니다 — 도구가 기다리는 사이 긴급 정지·자리 교체로 끝났다. 거부 글이 없는 CLI로 가므로 항목은 건드리지 않는다:
   * 대기 그대로 두어 다음 메인 턴이 받는다)
   */
  carryShown(turnId: string, entries: readonly QueueEntry[]): CarryOutcome {
    const l = this.live.get(turnId);
    if (!l || l.memberId !== MAIN_AGENT_ID) {
      const ended = l ? null : this.ctx.store.turns.get(turnId);
      return ended?.memberId === MAIN_AGENT_ID ? { kind: 'gone', turnId } : { kind: 'none' };
    }
    const ctx = this.ctx;
    const ids = entries.map((q) => q.id);
    ctx.store.tx(() => {
      for (const id of ids) ctx.store.queue.put({ ...ctx.store.queue.require(id), state: 'running', turnId: l.turnId });
      const t = ctx.store.turns.get(l.turnId);
      if (t) ctx.store.turns.put({ ...t, queueEntryIds: [...ids, ...t.queueEntryIds.filter((id) => !ids.includes(id))] });
    });
    // 저장한 뒤에 — 실패하면 이 턴의 실은 항목으로 세지 않는다(대기 그대로)
    l.entryIds = [...ids, ...l.entryIds.filter((id) => !ids.includes(id))];
    ctx.bus.changed();
    return { kind: 'carried', turnId: l.turnId };
  }

  /**
   * 메인 도구를 부른 메인 턴이 그 결과를 더는 받지 못하는지 (리드 결정 S5-63 — 처리기가 기다린 뒤 상태를 바꾸기 전에 다시 본다): 턴 기록이 메인 에이전트의 것인데
   * 실행 중이 아니거나, 마무리를 시작했거나(CLI가 이미 끝남), 즉시 종료 요청을 받았다(긴급 정지·자리 교체·중단 — 정지 검사의 '이 턴의 종료 요청'과 같은 판정).
   * 턴 기록이 없거나 팀원 턴이면 false — 운영자·시험 신원은 다시 보지 않는다
   */
  mainCallerGone(turnId: string): boolean {
    if (this.ctx.store.turns.get(turnId)?.memberId !== MAIN_AGENT_ID) return false;
    const l = this.live.get(turnId);
    return !l || l.finishing || l.stop?.mode === 'immediate';
  }

  // ───────────────────────── 세션 ─────────────────────────

  /**
   * 업무 세션 닫기. 닫는 사유가 그 세션의 교체 사유다 (MEM-11) — 열린 세션에 남아 있던 사유는 그 세션이 만들어진 까닭(앞 세션의 교체)이라
   * 덮어쓴다. 같은 팀원의 다음 세션이 이 세션을 이전 세션으로, 이 사유를 교체 사유로 잇는다 (resolveSession)
   */
  closeSessions(workKey: string, reason: string): void {
    const ctx = this.ctx;
    for (const s of ctx.store.sessions.list({ ref2: workKey, state: 'open' })) {
      ctx.store.sessions.put({ ...s, closedAt: ctx.now(), replaceReason: reason });
    }
  }

  closeMemberSessions(memberId: string, reason: string): void {
    const ctx = this.ctx;
    for (const s of ctx.store.sessions.list({ ref1: memberId, state: 'open' })) ctx.store.sessions.put({ ...s, closedAt: ctx.now(), replaceReason: reason });
  }

  /**
   * 이 세션 키로 띄울 턴이 쓸 모델 (launch와 같은 판정, 저장소를 바꾸지 않음) — 허용 검사가 모델별 주간 한도를 본다 (리드 결정 22). 진행 중인 팀원 세션은
   * 첫 턴에 고정한 모델을, 아니면 지금 AI 설정의 모델을 쓴다. 메인 에이전트는 고정하지 않는다. 실행 위치가 바뀌어 새 세션이 될 때만 어긋날 수 있는데,
   * 그때는 그 턴이 한 번 한도에 닿아 새 세션의 모델로 다시 판정된다
   */
  gateModel(member: Member, key: string): string | null {
    const open = this.ctx.store.sessions.list({ ref1: member.id, ref2: key, state: 'open' })[0];
    const pinned = !member.isMain && !!open && open.aiKind === member.ai.kind && !open.mock && open.turnCount > 0 && !!open.cliSessionId && open.model !== undefined;
    return this.core.team.modelFor(member.ai.kind, pinned ? open!.model : member.ai.model);
  }

  /**
   * 허용 검사의 AI 쪽 입력 — 모의 실행이면 ai null(AI 가용성을 보지 않음), 아니면 그 팀원 AI 종류의 가용성과 이 세션 키로 띄울 턴이 쓸 모델(gateModel —
   * 모델별 주간 한도). 스케줄러와 진행 판정(mainProgress)이 함께 쓴다 (리드 결정 22·38)
   */
  gateAi(member: Member, key: string): { ai: AiAvailability | null; model: string | null } {
    const ctx = this.ctx;
    // 외부 보유자에게는 AI 종류의 가용성이 없다 — 임대가 그 확인이다(seat.externalReady). M-MAIN의 AI 칸은 마지막 CLI 그대로라 그것으로 막지 않는다 (리드 결정 S7-4)
    if (member.isMain && this.core.seat.externalHolder()) return { ai: null, model: null };
    const project = member.projectId ? ctx.store.projects.get(member.projectId) : null;
    const mock = member.isMain ? ctx.settings().developer.mainAgentMock : !!project?.mock.enabled;
    const ai = mock ? null : ctx.ai(member.ai.kind);
    return { ai, model: ai ? this.gateModel(member, key) : null };
  }

  /**
   * 대기 항목 하나의 허용 검사 — 스케줄러가 그 세션의 턴을 띄우기 전에 보는 것과 같은 판정이다(정지·삭제, 작업 보류, 받는 팀원 AI 종류의 재로그인 필요·사용량
   * 한도·모델별 한도·CLI 문제). 메인 에이전트의 진행 판정도 이것으로 본다 — 스케줄러가 띄우지 않을 지시를 진행으로 세지 않게 (리드 결정 38).
   * sessionTask: 작업·검수 세션의 작업. gi: 그 팀원·세션 키의 gateAi (스케줄러는 세션 키마다 한 번 구해 넘긴다)
   */
  entryRunGate(member: Member, key: string, sessionTask: Task | null, e: QueueEntry, stop: StopState, nowMs: number, gi = this.gateAi(member, key)): GateResult {
    const { kind } = parseKey(key);
    const t = sessionTask ?? (e.taskId && TASK_BOUND_KINDS.includes(e.kind) ? (this.ctx.store.tasks.get(e.taskId) ?? null) : null);
    return checkRunGate({ stop, member, kind: e.kind, task: t, taskBound: kind === 'task' || kind === 'review', recoveryPending: false, ai: gi.ai, model: gi.model, prereqsDone: null, nowMs });
  }

  private resolveSession(
    member: Member,
    key: string,
    cwd: string,
    aiKind: RunnerKind,
    mock: boolean,
    projectId: string | null,
    seatGeneration: number | null,
    /** 외부 보유자의 턴이면 그 에이전트 (리드 결정 S7-4) — 세션은 그 에이전트의 것이고, CLI 세션 ID 칸은 세션 ID 그대로(다음 턴이 이어 간다) */
    externalAgentId: string | null = null,
  ): { session: AgentSession; handover: string | null } {
    const ctx = this.ctx;
    const kind = parseKey(key).kind;
    const open = ctx.store.sessions.list({ ref1: member.id, ref2: key, state: 'open' })[0];
    const tooLong = (kind === 'main_project' || kind === 'main_general') && (open?.turnCount ?? 0) >= 40;
    const sameRunner = !!open && (open.externalAgentId ?? null) === externalAgentId;
    if (open && open.cwd === cwd && open.aiKind === aiKind && open.mock === mock && sameRunner && !tooLong) return { session: open, handover: null };
    let replaceReason: string | null = null;
    let handover: string | null = null;
    // 이전 세션: 지금 교체하는 열린 세션, 없으면 이미 닫힌 이 팀원·업무의 마지막 세션 (이어하기 실패·재시작 때 이어할 CLI 세션 없음·재배정 등으로
    // 닫힘). 새 세션은 어느 쪽이든 이전 세션과 교체 사유를 기록해 교체 이력이 이어진다 (MEM-11, MBR-01, ERR-03)
    const prev = open ?? ctx.store.sessions.list({ ref1: member.id, ref2: key }).pop() ?? null;
    if (open) {
      replaceReason = tooLong ? '대화가 길어져 새 세션으로 이어감 (MEM-09)' : open.cwd !== cwd ? '실행 위치 변경' : 'AI 설정 변경';
      handover = this.buildHandover(key, open);
      ctx.store.sessions.put({ ...open, closedAt: ctx.now(), replaceReason });
    } else if (prev) {
      replaceReason = prev.replaceReason;
      handover = this.buildHandover(key, prev);
    }
    // 메인 세션(main:*·메인 검수 review:*): 새 세대의 키별 첫 세션에는 그 세대의 인계 꾸러미를, 40턴 세션 교체(MEM-09)에는 지금 기록으로 다시 만든 최신판을
    // 앞에 넣는다 — 키 하나가 아니라 모든 키에 (SERVER_DESIGN 6.2 '전달 방법', 리드 결정 S4-6)
    if (member.isMain) {
      const prevGeneration = prev ? ((prev as AgentSession & RunnerFields).seatGeneration ?? null) : undefined;
      const packet = this.core.handover.forSession(seatGeneration, prevGeneration, !!open && tooLong);
      if (packet) handover = handover ? `${packet}\n\n${handover}` : packet;
    }
    // 이 세션이 어느 프로젝트의 일인지 — 메인 세션은 팀원 프로젝트(projectId)가 늘 null이라 작업 키에서 뽑는다 (SERVER_DESIGN 5.4, 리드 결정 S5-5)
    const workProjectId = workProjectOf(ctx, key);
    // 실행 주체 (4.1 RunnerKind — 서버가 띄우는 CLI 또는 외부 보유자, 리드 결정 S7-2)와 메인 세션의 자리 세대 (S4-4)
    const sessionId = ctx.store.nextId('session');
    const s: AgentSession & RunnerFields = {
      runner: externalAgentId ? 'external' : 'cli',
      externalAgentId,
      ...(seatGeneration !== null ? { seatGeneration } : {}),
      id: sessionId,
      memberId: member.id,
      projectId,
      workProjectId,
      kind,
      workKey: key,
      aiKind,
      mock,
      // 외부 보유자는 CLI 세션이 없다 — 세션 ID를 그대로 둬 다음 턴이 이어 가는 턴(첫 턴 아님)이 된다 (리드 결정 S7-4)
      cliSessionId: externalAgentId ? sessionId : null,
      cwd,
      createdAt: ctx.now(),
      closedAt: null,
      previousSessionId: prev?.id ?? null,
      replaceReason,
      handoverSummary: handover,
      turnCount: 0,
      lastTurnAt: null,
    };
    ctx.store.sessions.insert(s);
    ctx.activity({ kind: 'session', projectId: projectId ?? workProjectId, memberId: member.id, sessionId: s.id, text: `세션 ${s.id} 시작 (${key}${replaceReason ? `, 교체: ${replaceReason}` : ''})` });
    return { session: s, handover };
  }

  /** 세션 교체 시 인계 요약 (ERR-03) */
  buildHandover(key: string, prev: AgentSession): string {
    const ctx = this.ctx;
    const { kind, ref } = parseKey(key);
    const lines: string[] = [`이전 세션 ${prev.id} (${prev.cliSessionId ?? 'CLI 세션 없음'})에서 이어받습니다.`];
    if (kind === 'task' || kind === 'review') {
      const t = ctx.store.tasks.get(ref);
      if (t) {
        const steps = ctx.store.steps.list(t.id);
        lines.push(`작업 ${t.id} "${t.title}" — 상태 ${t.state}, 목표: ${t.goal}`);
        lines.push(`완료 단계: ${steps.filter((s) => s.done).map((s) => s.title).join(' / ') || '없음'}`);
        lines.push(`남은 단계: ${steps.filter((s) => !s.done).map((s) => s.title).join(' / ') || '없음'}`);
        const lastCommit = [...steps].reverse().find((s) => s.commitSha)?.commitSha;
        if (lastCommit) lines.push(`마지막 커밋: ${lastCommit.slice(0, 10)}`);
        const reviews = ctx.store.reviews.list({ ref1: t.id });
        if (reviews.length) lines.push(`검수 이력: ${reviews.map((r) => `${r.reviewRound}차 ${r.verdict === 'pass' ? '통과' : `반려(${r.reason.slice(0, 80)})`}`).join(' / ')}`);
        // 보류 이력 (ERR-03): 지난 보류·해제까지. 세션을 바꿔 다시 시작할 때는 보류가 이미 풀려 있어 지금 사유만으로는 남지 않는다.
        // 작업 세션만 넣는다 (검수 세션은 그 검수의 질문만, 아래)
        if (kind === 'task') {
          const holds = ctx.store.transitions
            .list(t.id)
            .filter((x) => x.event === 'hold' || x.event === 'release' || x.event === 'replanned')
            .slice(-HANDOVER_HOLD_EVENTS)
            .map((x) => clip(holdHistoryText(x.reason), 160));
          if (holds.length) lines.push(`보류 이력: ${holds.join(' / ')}`);
        }
        if (t.hold.reasons.length) lines.push(`현재 보류 사유: ${t.hold.reasons.map((r) => `${HOLD_REASON_LABEL[r.kind]}: ${clip(r.note, 160)}`).join(' / ')}`);
        // 이 세션에서 한 질문과 받은 답 — 답변은 이전 CLI 세션에 한 번만 전달됐으므로 새 세션은 여기서만 안다 (TSK-08, AC-37).
        // 같은 세션 키의 질문만 넣는다 — 다른 업무 세션의 질문·답변을 섞지 않는다 (MEM-11)
        const qa = ctx.store.questions
          .list({ ref1: t.id })
          .filter((q) => q.sessionKey === key)
          .slice(-HANDOVER_QUESTIONS)
          .map((q) => `${q.id} 질문: ${clip(q.text, 160)} → ${q.status === 'answered' ? `답변: ${clip(q.answer ?? '', 400)}` : q.status === 'open' ? '답변 대기 중' : '취소됨'}`);
        if (qa.length) lines.push(`질문·답변: ${qa.join(' / ')}`);
        if (t.conflict) lines.push(`해결할 충돌: ${t.conflict.files.join(', ')}`);
        // 검수 세션은 검수 턴마다 '대표 지시' 절로 그 작업의 대표 메시지를 모두 받는다 (begin)
        if (kind === 'task') lines.push(...this.deliveredOwnerMessagesLine(key));
      }
    } else if (kind === 'directive') {
      const d = ctx.store.directives.get(ref);
      if (d) {
        lines.push(`지시 ${d.id} "${d.title}" — ${d.round}회차, 상태 ${d.state}`);
        lines.push(...directiveTasks(ctx, d.id, d.round).map((t) => `- ${t.id} ${t.title}: ${t.state}`));
      }
      lines.push(...this.deliveredOwnerMessagesLine(key));
    } else {
      lines.push('프로젝트 기억 문서(read_memory)를 먼저 읽고 이어가세요.');
    }
    return lines.join('\n');
  }

  /**
   * 인계 요약 줄: 이 업무 세션 키로 온 대표 직접 메시지 중 이미 전달한 최근 것 (오래된 것부터). 이전 CLI 세션에 한 번 전달됐으므로 새 세션은
   * 여기서만 안다 — 이어하기 실패·재시작으로 세션을 바꿔도 대표 지시가 사라지지 않게 (CTL-06, CLI-10, ERR-03). 아직 전달하지 않은 것은 그 턴 맨
   * 앞에 따로 가고, 전달하지 못한 것(대표에게 알림)은 넣지 않는다. 이 업무 세션 키의 것만 — 다른 업무의 메시지를 섞지 않는다 (MEM-11, AC-40)
   */
  private deliveredOwnerMessagesLine(key: string): string[] {
    const msgs = this.ctx.store.messages
      .list()
      .filter((m) => isUrgentMessage(m) && m.sessionKey === key && !!m.deliveredAt)
      .slice(-HANDOVER_OWNER_MESSAGES);
    return msgs.length ? [`긴급 지시 (이전 세션에 전달됨, 프로듀서 지시·완료 조건보다 우선 — CTL-06): ${msgs.map((m) => clip(m.text, 400)).join(' / ')}`] : [];
  }

  // ───────────────────────── 실행 ─────────────────────────

  /** 스케줄러가 고른 후보 실행. 자리는 여기서 동기적으로 예약된다 */
  launch(c: StartCandidate, entryIds: string[]): void {
    const ctx = this.ctx;
    const turnId = ctx.store.nextId('turn');
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => (resolveDone = r));
    const l: LiveTurn = {
      turnId,
      memberId: c.memberId,
      sessionKey: c.sessionKey,
      sessionId: '',
      sessionKind: parseKey(c.sessionKey).kind,
      slotClass: c.slotClass,
      taskId: null,
      directiveId: null,
      projectId: null,
      workProjectId: workProjectOf(ctx, c.sessionKey),
      entryIds,
      entryKinds: [],
      reviewPinnedAt: null,
      aiKind: 'claude',
      model: null,
      mock: false,
      // 스케줄러는 자리가 active일 때만 메인 턴을 고른다 — 그때의 세대가 이 턴의 세대다 (교체가 시작돼도 이 턴은 나가는 세대로 마무리한다). 교체 중에 뜨는
      // 메인 턴은 나가는 보유자의 인계 메모 턴뿐이라 나가는 세대다 (S4b, launchGeneration)
      seatGeneration: c.memberId === MAIN_AGENT_ID ? this.core.seat.launchGeneration() : null,
      // 외부 보유자면 그 에이전트에게 넘긴다 — 스케줄러(또는 인계 메모 턴)가 고른 같은 동기 구간의 보유자 (리드 결정 S7-4)
      external: c.memberId === MAIN_AGENT_ID ? this.core.seat.externalHolder() : null,
      proc: null,
      token: null,
      startedMs: ctx.clock.ms(),
      lastActivityMs: ctx.clock.ms(),
      lastStepMs: ctx.clock.ms(),
      suspectSinceMs: null,
      commands: new Map(),
      errorCounts: new Map(),
      stepsCompleted: 0,
      seq: 0,
      stream: null,
      eventsPath: '',
      stop: null,
      stopResult: null,
      hostUnconfirmed: null,
      finishing: false,
      exit: null,
      questionEndTimer: null,
      questionEnd: null,
      lastOutputMs: ctx.clock.ms(),
      ownerNotesShown: new Set(),
      ownerMessageFirst: false,
      endedForQuestion: false,
      flags: {
        bypassMismatch: null,
        bypassConfig: false,
        usageLimit: null,
        auth: null,
        resumeFailed: false,
        spawnError: null,
        spawnCliUnavailable: false,
        sawResult: false,
        resultIsError: false,
        finalText: null,
        mcp: 'unknown',
        bypass: 'requested',
      },
      usage: { inputTokens: 0, outputTokens: 0, costUsd: null },
      cleanup: [],
      pendingUi: [],
      uiTimer: null,
      lastPersistMs: 0,
      lastLine: null,
      label: '',
      done,
      resolveDone,
    };
    this.live.set(turnId, l);
    ctx.bus.changed();
    // 실패 처리 자체가 실패해도(예: 종료 중 닫힌 저장소) 처리되지 않은 거부로 새지 않게 마지막에 기록만 한다
    const run = this.begin(l, c)
      .catch((e) => this.failStart(l, e))
      .catch((e) => ctx.log('error', `턴 마무리 실패 ${turnId}`, e));
    this.inflight.add(run);
    this.flowMember.set(run, c.memberId);
    this.flowTurn.set(turnId, run);
    void run.finally(() => {
      this.inflight.delete(run);
      this.flowMember.delete(run);
      this.flowTurn.delete(turnId);
    });
  }

  private async begin(l: LiveTurn, c: StartCandidate): Promise<void> {
    const ctx = this.ctx;
    const member = ctx.store.members.require(l.memberId);
    if (c.activateTaskId) {
      const ok = await this.core.tasks.activateForLaunch(c.activateTaskId);
      if (!ok) throw new Error(`작업 ${c.activateTaskId} 활성화 실패`);
      l.entryIds = ctx.store.queue.list({ ref2: c.sessionKey, state: 'queued' }).map((q) => q.id);
    }
    if (l.stop) throw new Error('시작 전 정지 요청');
    let entries = l.entryIds.map((id) => ctx.store.queue.get(id)).filter((q): q is QueueEntry => !!q && q.state === 'queued');
    if (!entries.length) throw new Error('전달할 업무가 없습니다');
    // 대표 직접 메시지 우선 (CLI-10). 대표 메시지 공유 사본(CTL-05)은 이 턴을 띄운 일 뒤에 참고로 붙인다
    entries = entries.sort((a, b) => Number(b.urgent) - Number(a.urgent) || Number(!!a.ownerShared) - Number(!!b.ownerShared) || (a.queuedAt < b.queuedAt ? -1 : 1));
    // 판정·표시하는 업무 종류에는 공유 사본을 넣지 않는다 — 실어 온 정보일 뿐 이 턴의 일이 아니다 (예: 보고서 턴의 마지막 말을 대화에 붙이지 않게)
    l.entryKinds = entries.filter((e) => !e.ownerShared).map((e) => e.kind);
    const { kind, ref } = parseKey(c.sessionKey);
    const project: Project | null = member.projectId ? ctx.store.projects.get(member.projectId) : null;
    // 메인 에이전트의 검수 턴(review:T)은 그 작업의 프로젝트 일로 기록한다 — 메인은 프로젝트 소속이 없다 (REV-06 v0.6)
    l.projectId = member.projectId ?? (kind === 'task' || kind === 'review' ? (ctx.store.tasks.get(ref)?.projectId ?? null) : null);
    let task: Task | null = null;
    let cwd: string;
    const addDirs: string[] = [];
    if (kind === 'task' || kind === 'review') {
      task = ctx.store.tasks.require(ref);
      l.taskId = task.id;
      l.directiveId = task.directiveId;
    } else if (kind === 'directive') {
      l.directiveId = ref;
    }
    if (!l.directiveId) l.directiveId = entries.find((e) => e.directiveId)?.directiveId ?? null;
    if (!l.taskId) l.taskId = entries.find((e) => e.taskId)?.taskId ?? null;
    if (kind === 'task') {
      if (!task!.workspace) await this.core.tasks.ensureWorkspace(task!);
      task = ctx.store.tasks.require(ref);
      cwd = task.workspace!.worktreePath;
      // 산출물 폴더: 산출물형 작업, 그리고 저장소 변경형으로 전환된 뒤에도 그 폴더에 만든 결과 파일을 계속 고칠 수 있게 (AC-47)
      const artifacts = artifactWorkDir(ctx.paths, task.projectId, task.id);
      if (task.outputMode === 'artifact' || existsSync(artifacts)) addDirs.push(artifacts);
    } else if (kind === 'review') {
      // 이 턴은 지금 고정된 버전을 검수한다 — 그 버전의 읽기용 사본에서 돌고, 판정도 이 고정에만 묶인다 (REV-07·08)
      l.reviewPinnedAt = task!.review.target?.pinnedAt ?? null;
      let copy = this.core.tasks.reviewCopyOf(task!);
      if (!copy || !existsSync(copy)) {
        if (!task!.review.target) throw new Error('검수 대상이 고정되지 않았습니다');
        copy = await this.core.tasks.prepareReviewCopy(task!, task!.review.target);
      }
      cwd = copy;
      if (project) addDirs.push(project.path);
      // 산출물형에서 전환된 작업의 산출물 폴더 결과 파일 사본 (이 버전) — 검수자가 읽을 수 있게 (AC-47)
      const deliverables = this.core.tasks.deliverablesCopyOf(task!);
      if (deliverables) addDirs.push(deliverables);
    } else if (kind === 'directive') {
      if (!project) throw new Error('프로젝트가 없습니다');
      cwd = project.path;
    } else {
      // 메인 에이전트 작업 폴더 — 데이터 폴더 밖 (SERVER_DESIGN 3.7, 리드 결정 S5-20). 옮겨졌으면 열린 세션은 '실행 위치 변경'으로 새 세션이 된다 (resolveSession)
      cwd = this.core.mainWork.dir;
    }
    // 긴급 정지 중에는 어떤 CLI도 새로 띄우지 않는다 — 스케줄러를 거치지 않는 길(인계 메모 턴 등)도 여기서 막는다. 여기부터 턴 기록까지는 await가 없어
    // 같은 동기 구간에서 본 정지 값이다. 턴·세션 기록 전이라 대기 항목은 그대로 남고, 정지 요청으로 끝난 시작이라 시작 실패로 세지 않는다 (리드 결정 S4-14, CTL-03)
    if (ctx.stop().global.active) throw new Error('시작 전 정지 요청 — 긴급 정지 중');
    // 외부 보유자 (리드 결정 S7-4): 그 에이전트의 열린 롱폴을 같은 동기 구간에서 받아 둔다 — 턴 기록까지 await가 없다(S4-14와 같다). 롱폴이 그사이 사라졌으면
    // 턴 기록 전 실패라 일은 대기열에 그대로 남는다
    const ext = l.external ? this.core.externalAgents.takePoll(l.seatGeneration) : null;
    if (l.external && (!ext || ext.agentId !== l.external.agentId)) {
      throw new ExternalPollGone(`외부 보유자 ${l.external.label}(${l.external.agentId})의 일 받기(work/next)가 그사이 끝나 턴을 넘기지 않았습니다 — 일은 대기열에 그대로 둡니다`);
    }
    // AI 설정: 진행 중 작업이 끝났으면 보류된 변경 적용. 지금 시작하는 이 턴과 이 턴이 활성화한 작업은 세지 않는다 (CONC-12)
    this.core.team.applyPendingAiIfIdle(member.id, { turnId: l.turnId, taskId: c.activateTaskId ?? null });
    const fresh = ctx.store.members.require(member.id);
    // 메인 모의 실행(개발자 옵션)은 서버가 띄우는 보유자에게만 쓴다 — 외부 보유자는 스스로 돈다 (S7-4)
    const mock = ext ? false : fresh.isMain ? ctx.settings().developer.mainAgentMock : !!project?.mock.enabled;
    const cliKind: AiKind | null = ext ? null : fresh.ai.kind;
    const aiKind: RunnerKind = cliKind ?? 'external';
    l.aiKind = aiKind;
    l.mock = mock;
    const { session, handover } = this.resolveSession(fresh, c.sessionKey, cwd, aiKind, mock, member.projectId, l.seatGeneration, ext ? ext.agentId : null);
    l.sessionId = session.id;
    const isFirst = session.turnCount === 0 || !session.cliSessionId;
    // 진행 중인 세션은 첫 턴에 고정한 모델·노력치를 끝까지 쓴다 — 바뀐 설정은 새 세션부터 (19.1, MBR-06, F9).
    // 고정값이 없는 이전 기록은 이번 값으로 고정한다. 메인 에이전트는 대표가 운영 설정에서 정하므로(AGT-08) 다음 턴부터 같은 세션에 적용
    const pinned = !fresh.isMain && !isFirst && session.model !== undefined;
    // 정하지 않은 모델은 실제로 넘길 값으로 풀어 고정한다 — Codex는 대표 개인 설정을 읽지 않으므로 목록 첫 모델 (windows:F1).
    // 예전에 null·예전 노력치(none·minimal)로 고정된 세션도 지금 실행할 수 있는 값으로 (windows:F7). 외부 보유자에는 모델·노력치가 없다 — 서버는 그 뒤의 모델을 모른다
    const model = cliKind ? this.core.team.modelFor(cliKind, pinned ? session.model : fresh.ai.model) : null;
    l.model = model;
    const effort = cliKind ? (pinned ? this.core.team.effortFor(cliKind, session.effort ?? null) : this.core.team.effortValue(fresh.ai)) : null;
    if (cliKind && !pinned && (session.model !== model || session.effort !== effort)) ctx.store.sessions.patch(session.id, { model, effort });
    const role = fresh.isMain ? null : roleOf(ctx, fresh.roleId);
    const skills = this.manualSkillsFor(fresh.roleId);
    const systemPrompt = buildSystemPrompt({
      member: fresh,
      role,
      project,
      sessionKind: kind,
      cwd,
      manualSkills: skills,
      skillCatalog: fresh.isMain ? this.skillCatalog() : undefined,
    });
    // 검수 턴: 대표가 이 작업에 보낸 직접 메시지(작업자·검수자에게)를 모두 보인다 — 프로듀서든 아니든 그 작업을 판정하는 쪽은 대표 지시를 알고 판정한다
    // (CTL-06 대표 지시 우선, AC-17). 이 턴의 항목으로 따로 가는 것(검수자에게 온 대표 메시지)은 그 항목으로 — 보인 것으로 적어 판정 때 확인한다
    let ownerInstructions: string[] | undefined;
    if (kind === 'review' && task) {
      const notes = this.core.tasks.ownerInstructionsFor(task.id);
      const carried = new Set(entries.map((e) => e.messageId).filter((id): id is string => !!id));
      ownerInstructions = notes.filter((m) => !carried.has(m.id)).map((m) => this.core.tasks.ownerInstructionLine(m));
      for (const m of notes) l.ownerNotesShown.add(m.id);
    }
    // 남는 업무를 다시 전달하면 그 머리말을 지금(전달하는 때) 확인한 사실로 붙인다 — 저장된 글에는 넣지 않아 다시 넣어도 쌓이지 않는다 (리드 결정 31)
    const shown = entries.map((e) => {
      const head = this.standingHead(e);
      return head ? { ...e, message: `${head}\n\n${standingText(e)}` } : e;
    });
    // 메인 대화 턴(main:*)마다 맨 앞에 현황 요약 — 이 턴을 띄울 때 계산하고 이 턴이 싣는 일은 빼고 센다. 메인 검수 턴(review:T)에는 넣지 않는다 (SERVER_DESIGN 5.1,
    // 리드 결정 S5-4). 첫 턴·이어하기·세션 교체·다시 전달·인계 메모 턴 모두 이 길이다
    const digest = fresh.isMain && (kind === 'main_project' || kind === 'main_general') ? this.core.overview.digestFor(c.sessionKey, new Set(entries.map((e) => e.id))) : null;
    const message = buildTurnMessage({ session, entries: shown, handover: isFirst ? (handover ?? session.handoverSummary) : null, isFirstTurn: isFirst, ownerInstructions, digest });
    l.label = `${WORK_KIND_LABEL[entries[0]!.kind]}${l.taskId ? ` ${l.taskId}` : l.directiveId ? ` ${l.directiveId}` : ''}`;
    // 턴 기록 → 업무 항목 실행 중
    l.eventsPath = eventsFile(ctx.paths, member.id, session.id, l.turnId);
    // 실행 주체 (4.1 RunnerKind) — 서버가 띄우는 CLI 또는 외부 보유자(그 에이전트 ID, pid 없음 — S7-4). 메인 턴은 자리 세대도 적는다 (S4-4)
    const turn: Turn & RunnerFields = {
      runner: ext ? 'external' : 'cli',
      externalAgentId: ext ? ext.agentId : null,
      ...(l.seatGeneration !== null ? { seatGeneration: l.seatGeneration } : {}),
      id: l.turnId,
      sessionId: session.id,
      memberId: member.id,
      projectId: l.projectId,
      workProjectId: l.workProjectId,
      taskId: l.taskId,
      directiveId: l.directiveId,
      sessionKind: kind,
      slotClass: l.slotClass,
      queueEntryIds: entries.map((e) => e.id),
      ...(kind === 'review' ? { reviewPinnedAt: l.reviewPinnedAt } : {}),
      isResume: !isFirst,
      aiKind,
      mock,
      startedAt: new Date(l.startedMs).toISOString(),
      endedAt: null,
      lastActivityAt: new Date(l.startedMs).toISOString(),
      process: { state: 'starting', pid: null, spawnedAt: null, exitCode: null, stopRequestedAt: null, stopMode: null, killDetail: null },
      endReason: null,
      endDetail: '',
      stepsCompleted: 0,
      toolCalls: 0,
      usage: null,
      bypass: 'requested',
      mcp: 'unknown',
      eventsFile: l.eventsPath,
      eventCount: 0,
      finalText: null,
    };
    ctx.store.tx(() => {
      ctx.store.turns.insert(turn);
      for (const e of entries) ctx.store.queue.put({ ...e, state: 'running', turnId: l.turnId });
    });
    l.entryIds = entries.map((e) => e.id);
    // 앱 도구 토큰 (턴별)
    const identity: TokenIdentity = {
      turnId: l.turnId,
      sessionId: session.id,
      sessionKey: c.sessionKey,
      sessionKind: kind,
      memberId: member.id,
      projectId: member.projectId,
      isMain: fresh.isMain,
      isProducer: fresh.isProducer,
      canReview: !!role?.canReview || fresh.isProducer,
      // 메인 토큰의 세대 — 도구 처리기가 자리가 받지 않는 세대를 seat_changed로 거부한다 (S4-4)
      ...(l.seatGeneration !== null ? { seatGeneration: l.seatGeneration } : {}),
      // 도구 호출 기록(app_tool)의 프로젝트 — 메인 에이전트는 팀원 프로젝트가 없다 (S5-5)
      workProjectId: l.workProjectId,
      // 메인 턴을 띄운 AI 종류·모델의 키 — 화면 보기 확인은 지금 보유자의 모델로 띄운 턴만 받고 답한다 (리드 결정 S6-21 G). 외부 보유자는 `external:<에이전트 ID>` —
      // 서버는 그 뒤의 모델을 모르므로 그 에이전트만 확인한다 (리드 결정 S7-14). 외부 턴의 토큰은 그 에이전트에 묶인다 (S7-3)
      ...(ext ? { modelKey: externalModelKey(ext.agentId), externalAgentId: ext.agentId } : fresh.isMain ? { modelKey: aiModelKey(fresh.ai) } : {}),
    };
    l.token = this.core.toolServer.issueToken(identity);
    ctx.redact.addSecret(l.token, 'token');
    if (ext) {
      // 외부 보유자의 턴 (리드 결정 S7-4): 프로세스를 띄우지 않고 받아 둔 롱폴로 일(WorkItem)을 넘긴다 — 같은 턴 기록·토큰·인계·현황 요약·메시지. 턴 기록부터 넘기기까지
      // await가 없다. 진행은 이벤트로, 마침은 마지막 답·결과로 오고, 멈춤은 토큰을 폐기한다(ExternalRun). 무인 출력 감시는 하지 않는다 — 임대가 살아 있는지가 그 확인이다
      const run = new ExternalRun();
      run.sink = (events) => this.onEvents(l, events);
      run.onFinal = (text) => {
        l.flags.finalText = text;
      };
      run.onEnd = () => {
        if (l.token) this.core.toolServer.revokeToken(l.token);
        this.core.externalAgents.turnEnded(l.turnId);
      };
      l.proc = run;
      mkdirSync(dirname(l.eventsPath), { recursive: true });
      l.stream = createWriteStream(l.eventsPath, { flags: 'a', encoding: 'utf8' });
      this.persistTurn(l, { process: 'running', pid: null, spawnedAt: ctx.now() });
      const execution = ctx.settings().execution;
      ext.deliver(
        l.turnId,
        {
          turnId: l.turnId,
          workKey: c.sessionKey,
          kind,
          projectId: l.projectId ?? l.workProjectId,
          generation: l.seatGeneration ?? this.core.seat.generation(),
          cwd,
          instructions: systemPrompt,
          message,
          digest: digest?.text ?? null,
          attachments: entries.flatMap((e) => e.attachments).map((p) => ({ name: basename(p), path: p })),
          mcp: { url: this.core.toolServer.url ?? '', token: l.token },
          deadlineAt: new Date(l.startedMs + execution.turnTimeoutMin * 60_000).toISOString(),
        },
        run,
      );
      // 이 턴이 실은 메시지는 이제 그 에이전트에게 넘겼다 — 메시지 기록을 전달됨으로 (AC-36)
      markMessagesDelivered(ctx, entries);
      ctx.activity({
        kind: 'exec',
        actor: member.id,
        projectId: loggedProject(l),
        taskId: l.taskId,
        directiveId: l.directiveId,
        memberId: member.id,
        sessionId: session.id,
        turnId: l.turnId,
        text: `${isFirst ? '첫 턴을' : '이어 가는 턴을'} 외부 에이전트에게 넘김: ${ext.label}(${ext.agentId})`,
      });
      const exit = await run.exited;
      l.exit = exit;
      await this.finish(l, { code: exit.code, terminated: exit.terminated, remaining: exit.remaining });
      return;
    }
    // 여기부터는 서버가 띄우는 CLI 턴이다 (외부 보유자는 위에서 끝났다)
    const cli: AiKind = cliKind!;
    const tmp = turnTmpDir(ctx.paths, l.turnId);
    mkdirSync(tmp, { recursive: true });
    l.cleanup.push(tmp);
    const settings = ctx.settings();
    const env: Record<string, string> = {};
    if (!mock && settings.account.authMode[cli] === 'api_key') {
      const key = await ctx.deps.secrets.get(cli === 'claude' ? SECRET_KEYS.apiKeyClaude : SECRET_KEYS.apiKeyCodex);
      if (key) {
        if (cli === 'claude') env.ANTHROPIC_API_KEY = key;
        else env.OPENAI_API_KEY = key;
        ctx.redact.addSecret(key, 'api-key');
      }
    }
    const scenario = fresh.mockScenario ?? project?.mock.defaultScenario ?? 'normal';
    const launch: TurnLaunch = {
      format: cli,
      cwd,
      message,
      systemPrompt,
      resumeCliSessionId: isFirst ? null : session.cliSessionId,
      newSessionId: isFirst && (cli === 'claude' || mock) ? randomUUID() : null,
      model,
      effort: effort!,
      // 메인 대화 턴은 host_exec(최대 30분)가 있어 CLI가 앱 도구를 그보다 길게 기다리게 한다 — 팀원 턴은 CLI 기본값 그대로 (리드 결정 S5-18)
      mcp: { url: this.core.toolServer.url!, token: l.token, serverName: 'wook', ...(fresh.isMain && (kind === 'main_project' || kind === 'main_general') ? { toolTimeoutSec: MCP_TOOL_TIMEOUT_SEC } : {}) },
      maxTurns: settings.execution.claudeMaxTurns,
      images: entries.flatMap((e) => e.attachments).filter((p) => /\.(png|jpe?g|gif|webp)$/i.test(p)),
      addDirs,
      tempDir: tmp,
      env,
      mock: mock
        ? {
            scenario,
            speed: project?.mock.speed ?? settings.developer.mockSpeed,
            role: fresh.isMain ? 'main' : fresh.isProducer ? 'producer' : 'member',
            memberId: fresh.id,
            workKey: c.sessionKey,
            turnNumber: session.turnCount + 1,
            stateDir: join(ctx.paths.mock, member.projectId ?? 'main'),
          }
        : undefined,
    };
    const adapter = mock ? ctx.deps.adapters.mock : ctx.deps.adapters[cli];
    const prepared = await adapter.prepare(launch);
    l.cleanup.push(...prepared.cleanup);
    if (isFirst && prepared.expectedCliSessionId) {
      ctx.store.sessions.patch(session.id, { cliSessionId: prepared.expectedCliSessionId });
    }
    // 러너가 띄우자마자 하위 프로세스를 추적할 수 있을 때까지 (taskkill 방식의 작업 개체 도우미 준비, AC-29·36). 정지 확인은 이 뒤 같은 동기 구간에서
    await ctx.deps.runner.ready?.();
    if (l.stop) throw new Error('시작 전 정지 요청');
    mkdirSync(dirname(l.eventsPath), { recursive: true });
    l.stream = createWriteStream(l.eventsPath, { flags: 'a', encoding: 'utf8' });
    const parser = adapter.createParser(launch);
    // 어댑터가 만든 자식 환경(buildChildEnv: process.env에서 부모 CLI 세션 변수를 뺀 전체 환경)을 그대로 쓴다.
    // 여기서 process.env를 다시 섞으면 뺀 변수(CLAUDE_CODE_CHILD_SESSION 등)가 되살아나고 윈도우에서 Path·PATH가 겹친다
    const proc = ctx.deps.runner.start({ ...prepared.spec, label: `${member.name} ${l.label}` });
    l.proc = proc;
    // PID가 생긴 시각 — 재시작 복구가 OS의 프로세스 생성 시각과 대조하므로 앱 시계가 아니라 OS 시계로 적는다.
    // start()는 프로세스를 동기적으로 만들므로 실제 생성 시각보다 같거나 늦다 (windows:F2)
    this.persistTurn(l, { process: 'running', pid: proc.pid, spawnedAt: proc.pid !== null ? new Date().toISOString() : null, start: proc.start ?? null, runTag: proc.runTag ?? null });
    // 이 턴이 실은 메시지(대표 직접 메시지·팀원 메시지)는 이제 그 업무 세션의 CLI에 넘겼다 — 메시지 기록을 전달됨으로 (AC-36)
    markMessagesDelivered(ctx, entries);
    ctx.activity({
      kind: 'exec',
      actor: member.id,
      projectId: loggedProject(l),
      taskId: l.taskId,
      directiveId: l.directiveId,
      memberId: member.id,
      sessionId: session.id,
      turnId: l.turnId,
      text: `${isFirst ? '첫 턴' : '이어하기'} 시작: ${prepared.display}`,
    });
    proc.onStdoutLine((line) => {
      // 해석해 버리는 줄(추론 진행·keep-alive)도 CLI가 아직 일하고 있다는 표시다 — 질문 뒤 마무리를 기다리는 동안 본다 (endAfterQuestion)
      l.lastOutputMs = ctx.clock.ms();
      this.onEvents(l, safeParse(() => parser.pushLine(line), line));
    });
    proc.onStderrLine((line) => this.onEvents(l, safeParse(() => parser.pushStderr(line), line)));
    const exit = await proc.exited;
    l.exit = exit;
    this.onEvents(l, safeParse(() => parser.finish(exit.code), ''));
    await this.finish(l, { code: exit.code, terminated: exit.terminated, remaining: exit.remaining, ...(exit.detail ? { leftoverDetail: exit.detail } : {}) });
  }

  private manualSkillsFor(roleId: string): string[] {
    const ctx = this.ctx;
    const overrides = ctx.settings().skills.overrides;
    const role = roleOf(ctx, roleId);
    return (role?.allowedSkills ?? []).filter((s) => overrides[s] === 'manual');
  }

  private skillCatalog(): { name: string; allowedRoles: string[] }[] {
    const ctx = this.ctx;
    const overrides = ctx.settings().skills.overrides;
    const roles = ctx.store.roles.list();
    return Object.entries(overrides)
      .filter(([, mode]) => mode === 'manual')
      .map(([name]) => ({ name, allowedRoles: roles.filter((r) => r.allowedSkills.includes(name)).map((r) => r.id) }));
  }

  private async failStart(l: LiveTurn, e: unknown): Promise<void> {
    const ctx = this.ctx;
    const msg = e instanceof Error ? e.message : String(e);
    l.flags.spawnError = msg;
    l.flags.spawnCliUnavailable = e instanceof LaunchError && e.cliUnavailable;
    ctx.log('error', `턴 시작 실패 ${l.turnId}`, e);
    if (!ctx.store.turns.get(l.turnId)) {
      // 턴 기록 전 실패 — 대기 항목은 그대로 대기열에 남는다
      this.live.delete(l.turnId);
      l.resolveDone();
      if (e instanceof ExternalPollGone) {
        // 외부 보유자의 롱폴이 그사이 끝났다 — 시작 실패로 세지 않는다(응답 없음도 아니다 — 그것은 임대가 정한다). 다시 받으러 오면 그때 띄운다 (리드 결정 S7-4)
        ctx.log('info', msg);
      } else if (!msg.includes('정지 요청')) {
        ctx.activity({ kind: 'error', level: 'error', projectId: loggedProject(l), memberId: l.memberId, taskId: l.taskId, text: `턴 시작 실패: ${msg}` });
        // 정지·보류 요청을 받은 턴의 실패는 시작 실패로 세지 않는다 — 턴 기록 뒤 실패가 user_stop으로 끝나는 것과 같다 (endReasonOf, ERR-04). 항목은 센 횟수
        // 그대로 남아, 재개 뒤 다시 판정 턴이 대표 메시지를 싣는다 (CTL-06, CTL-10, S10-B1)
        if (!l.stop) this.recordStartFailure(l, msg);
        // 메인 턴의 시작 실패도 응답 없음으로 센다 — 턴 기록 뒤의 시작 실패(spawn_failed)와 같다 (SERVER_DESIGN 4.4, 리드 결정 S4-5)
        if (!l.stop && l.memberId === MAIN_AGENT_ID) this.core.seat.noteMainTurnEnd(l.seatGeneration, 'spawn_failed');
      }
      ctx.bus.changed();
      setTimeout(() => ctx.bus.signal('tick'), 1000);
      return;
    }
    await this.finish(l, { code: null, terminated: false, remaining: 0, spawnError: msg });
  }

  /**
   * 프로세스를 띄우기 전 실패를 시작 시도로 센다 — 턴 기록 전·후 모두 (ERR-04, F1, CONC-01). 같은 업무가 상한만큼 실패하면 항목을 멈추고 알린다.
   * 작업·검수 세션이면 할 일 없이 진행·검수로 남지 않게 작업을 보류(오류)한다 → 원인(모델 이름·작업 폴더·첨부 등)을 고친 뒤 대표 재개로 다시.
   * 시작 실패만 센다(startFails) — 비정상 종료·끊김으로 다시 넣은 횟수(attempts)와 섞지 않는다: 보류 사유·알림의 횟수가 실제 시작 실패 횟수다 (S9-B2).
   * 상한에 닿아 멈췄으면 true
   */
  private recordStartFailure(l: LiveTurn, msg: string): boolean {
    const ctx = this.ctx;
    let gaveUp = false;
    const dropped: QueueEntry[] = [];
    /** 보류한 작업을 넘긴 메인 알림 업무 (작업·검수 세션) */
    let handed: QueueEntry | null = null;
    const task = l.sessionKind === 'task' || l.sessionKind === 'review' ? ctx.store.tasks.get(parseKey(l.sessionKey).ref) : null;
    // 통과 뒤 대표 메시지로 병합 판단·확정을 미룬 작업의 검수 세션: 대표 직접 메시지는 지우지 않고 남긴다(작업은 아래에서 보류). 원인을 고친 뒤 재개하면 같은
    // 검수 세션의 다시 판정 턴이 그 메시지를 싣는다 — 지우면 메시지 없이 다시 판정 턴이 돌아 이전 통과로 병합 판단이 들어간다. 재개 뒤 다시 센다 (CTL-06, CTL-10, S9-B1).
    // 그 사이 검수 턴을 멈추지 않는 보류(작업자 일시정지 등)로 보류된 작업도 풀리면 검수로 돌아오므로 같게 본다 (S10-B1)
    const reviewState = task?.state === 'on_hold' ? task.hold.returnState : task?.state;
    const keepOwner = l.sessionKind === 'review' && !!task && reviewState === 'in_review' && this.core.tasks.mergeDeferredForReviewer(task);
    ctx.store.tx(() => {
      const drop: { q: QueueEntry; startFails: number }[] = [];
      /** 상한에 닿은 첫 항목 — 알림의 세션·링크 */
      let first: QueueEntry | null = null;
      for (const id of l.entryIds) {
        const q = ctx.store.queue.get(id);
        if (!q || q.state !== 'queued') continue;
        const startFails = (q.startFails ?? 0) + 1;
        if (startFails < START_FAIL_LIMIT) {
          ctx.store.queue.put({ ...q, startFails });
          continue;
        }
        gaveUp = true;
        first ??= q;
        if (keepOwner && isUrgentDirect(q)) ctx.store.queue.put({ ...q, startFails: 0 });
        else drop.push({ q, startFails });
      }
      // 먼저 항목을 멈춘다 — 아래의 넘김이 '그 작업에 재배정 업무가 아직 있다'(남는 업무 판정, 리드 결정 31)고 보지 않게 버리는 항목은 대기열에서 빼 둔다
      for (const { q, startFails } of drop) {
        ctx.store.queue.put({ ...q, state: 'cancelled', startFails, doneAt: ctx.now() });
        dropped.push(q);
      }
      // 프로듀서 지시 세션: 버리는 검수자 재배정 업무의 멈춘 검수는 메인 에이전트에게 넘긴다 — 같은 트랜잭션이라 넘기기 전에 끊겨도 업무가 사라지지 않는다
      // (리드 결정 18). 메인 세션: 버리는 남는 업무(멈춘 검수 넘김·팀원 재개)는 그 작업·팀원을 대표에게 알린다 (리드 결정 24)
      if (drop.length) this.handOffStuckReviews(l, `프로듀서 턴이 ${START_FAIL_LIMIT}번 시작하지 못했습니다 (${msg.slice(0, 80)})`, drop.map((x) => x.q));
      if (drop.length) this.standingLost(l, `${START_FAIL_LIMIT}번 시작하지 못해 (${msg.slice(0, 80)})`, drop.map((x) => x.q));
      // 작업·검수 세션: 할 일 없이 진행·검수로 남지 않게 작업을 보류(오류)한다 → 메인 에이전트에게 알림 업무(alert start-fail:<작업>) — 원인(모델 이름·작업 폴더·
      // 첨부 등)을 고친 뒤 메인의 resume_task로 다시. 알림보다 먼저 보류하고 넘긴다 — 알림이 '넘겼습니다'라고 할 때는 이미 넘긴 뒤다 (리드 결정 28·S5-7·S5-9)
      const cur = gaveUp && task ? ctx.store.tasks.get(task.id) : null;
      if (cur && !isTerminal(cur.state) && cur.state !== 'on_hold') {
        try {
          this.core.tasks.hold(cur.id, 'error', 'task', `턴 시작 ${START_FAIL_LIMIT}회 실패: ${msg}`, 'system');
          // 출구가 시작하지 못한 팀원(검수 턴이면 검수자)을 ID로 적는다 (리드 결정 S5-28)
          handed = alertTaskHold(ctx, 'start-fail', cur.id, {
            cause: `${l.sessionKind === 'review' ? '검수' : '작업'} 턴이 ${START_FAIL_LIMIT}번 시작하지 못해 보류됨`,
            member: { id: l.memberId, review: l.sessionKind === 'review' },
          });
        } catch (e) {
          ctx.log('error', `시작 실패 보류 처리 실패 ${cur.id}`, e);
        }
      }
      // 알림은 이 상한 하나에 하나다. 버리는 대표 명령·답변·수정 요청은 같은 알림에 적는다 — 무엇을 다시 말해야 하는지 대표가 알 수 있게 (리드 결정 30). 그런
      // 버림은 그 버림만의 알림 key로 새 알림을 내고 대표 요청마다 활동 기록을 남긴다 — 같은 세션의 다음 버림이 앞 알림을 덮지 않게 (리드 결정 36).
      // 작업·검수 세션의 보류(리드 결정 28)는 위에서 메인 에이전트에게 넘겼다면 그 사실을, 아니면(지시·메인 세션, 넘기지 못함) 대표가 명령창으로 메인
      // 에이전트에게 알리는 길을 적는다(대표 요청을 버렸으면 그 문장이 이미 그 길을 적는다) (리드 결정 32·40·S5-9). 버린 보류 넘김(정지 해제 목록·검수자
      // 없음)과 알림 업무도 대표 요청처럼 그 버림만의 key로 알리고, 아직 그 보류인 작업을 적고, 활동 기록을 남긴다 — 보류 넘김은 메인에게 한 번 더 넘기고
      // 그렇다고 적는다(리드 결정 S5-8). 멈춘 업무도 이름으로 적는다 — 그래야 끝 문장('메인 에이전트가 확인하고 이어 갑니다')이 무엇을 가리키는지 대표가
      // 메인에게 말할 수 있다 (리드 결정 43)
      if (first) {
        const live = drop.map((x) => x.q).filter((q) => !deadWorkReason(ctx, q, this.reviewBusy));
        const owner = ownerRequests(ctx, live);
        const held = heldHandOvers(ctx, live);
        // 버린 보류 넘김(정지 해제 목록·검수자 없음)은 한 번 더 메인에게 넘긴다 — 알림보다 먼저 (리드 결정 S5-8·43)
        this.reAlertHandOvers(held, `${START_FAIL_LIMIT}번 시작하지 못해`);
        const lost = lostText(owner, held);
        const what = [...new Set(drop.map((x) => workLabel(x.q)))].join(', ');
        ctx.notify({
          level: 'urgent',
          title: '업무 시작 실패',
          body: `${first.sessionKey}: ${msg}${what ? ` — ${START_FAIL_LIMIT}번 시작하지 못해 멈춘 업무: ${what}` : ''}${lost ? `. ${lost}` : handed ? `. 작업을 보류하고 ${OWNER_HANDED}` : `. ${ownerExit(false)}`}`,
          link: first.projectId ? { tab: 'projects', projectId: first.projectId, memberId: first.memberId } : null,
          key: dropNoticeKey('start-fail', first.sessionKey, owner, held),
        });
        noteOwnerRequestsLost(ctx, owner, `업무 시작이 ${START_FAIL_LIMIT}번 실패함 (${clip(msg, 80)})`);
        noteHeldHandOversLost(ctx, held, `업무 시작이 ${START_FAIL_LIMIT}번 실패함 (${clip(msg, 80)})`);
      }
    });
    // 함께 멈춘 메시지는 메시지 기록에 남기고 대표 직접 메시지는 따로 알린다 — 시작 실패 알림만으로는 메시지가 전달되지 않았다는 것이 보이지 않는다
    noteMessagesUndelivered(ctx, dropped, `업무 시작이 ${START_FAIL_LIMIT}회 실패해 그 업무를 멈춤 (${msg.slice(0, 120)})`);
    return gaveUp;
  }

  // ───────────────────────── 이벤트 ─────────────────────────

  private onEvents(l: LiveTurn, events: ParsedCliEvent[]): void {
    if (!events.length) return;
    const ctx = this.ctx;
    const now = ctx.clock.ms();
    for (const raw of events) {
      // 이미지 바이트(MCP 도구 결과의 화면 캡처·시험 이미지, Read한 PNG)는 가리기 전에 뺀다 — 이벤트 파일·화면 푸시에 남지 않게 (리드 결정 S6-7).
      // 가릴 수 없는 그림이라 보관 규칙(24시간·500장)은 화면 폴더만 지킨다
      const ev = ctx.redact.value(stripImages(raw));
      l.seq += 1;
      const rec: CliEvent = { ...ev, seq: l.seq, ts: new Date(now).toISOString(), turnId: l.turnId };
      l.stream?.write(`${JSON.stringify(rec)}\n`);
      if (ev.kind !== 'stderr') l.lastActivityMs = now;
      l.suspectSinceMs = null;
      this.interpret(l, ev);
      if (ev.kind === 'text' || ev.kind === 'command_start' || ev.kind === 'file_change' || ev.kind === 'mcp_call' || ev.kind === 'tool_call') {
        const line = ev.text.split('\n')[0]!.slice(0, 120);
        if (line) {
          l.lastLine = line;
          this.lastLines.set(l.memberId, { text: line, at: rec.ts });
        }
      }
      l.pendingUi.push(rec);
    }
    if (!l.uiTimer) {
      l.uiTimer = setTimeout(() => {
        l.uiTimer = null;
        const batch = l.pendingUi.splice(0);
        if (batch.length) ctx.bus.emit('cliEvents', { memberId: l.memberId, turnId: l.turnId, events: batch });
      }, 250);
    }
    if (now - l.lastPersistMs > 2000) this.persistTurn(l, {});
  }

  private interpret(l: LiveTurn, ev: ParsedCliEvent): void {
    const ctx = this.ctx;
    const d = ev.data ?? {};
    const settings = ctx.settings().execution;
    switch (ev.kind) {
      case 'session': {
        if (d.cliSessionId) {
          const s = ctx.store.sessions.get(l.sessionId);
          if (s && s.cliSessionId !== d.cliSessionId) ctx.store.sessions.put({ ...s, cliSessionId: d.cliSessionId });
        }
        if (d.permissionMode !== undefined) {
          if (d.permissionMode === 'bypassPermissions') l.flags.bypass = 'verified';
          else this.flagBypass(l, `권한 모드가 '${d.permissionMode}'입니다 (bypassPermissions 아님)`, true);
        }
        if (d.mcpServers) {
          const wook = d.mcpServers.find((s) => s.name === 'wook');
          l.flags.mcp = wook ? (wook.status === 'connected' ? 'connected' : 'failed') : l.flags.mcp;
        }
        break;
      }
      case 'command_start':
        l.commands.set(d.callId ?? `c${l.seq}`, ctx.clock.ms());
        ctx.activity({ kind: 'command', actor: l.memberId, projectId: loggedProject(l), taskId: l.taskId, memberId: l.memberId, sessionId: l.sessionId, turnId: l.turnId, text: d.command ?? ev.text });
        break;
      case 'command_end': {
        l.commands.delete(d.callId ?? '');
        if (!d.callId) l.commands.clear();
        if (d.exitCode != null && d.exitCode !== 0) this.countError(l, `cmd:${(d.command ?? ev.text).slice(0, 160)}`, settings.spinSameErrorCount);
        break;
      }
      case 'file_change':
        ctx.activity({ kind: 'file_change', actor: l.memberId, projectId: loggedProject(l), taskId: l.taskId, memberId: l.memberId, sessionId: l.sessionId, turnId: l.turnId, text: (d.paths ?? []).join(', ') || ev.text });
        break;
      case 'mcp_call':
        if (d.server === 'wook' && l.flags.mcp === 'unknown') l.flags.mcp = 'connected';
        break;
      case 'usage':
        if (d.inputTokens != null) l.usage.inputTokens += d.inputTokens;
        if (d.outputTokens != null) l.usage.outputTokens += d.outputTokens;
        if (d.costUsd != null) l.usage.costUsd = (l.usage.costUsd ?? 0) + d.costUsd;
        break;
      case 'error':
        if (d.errorKind === 'usage_limit') {
          // 한도 종류는 먼저 알려 준 것을 지킨다 (rate_limit_event 뒤의 같은 한도 오류에는 없을 수 있다)
          l.flags.usageLimit = { resetAt: d.resetAt ?? null, message: ev.text, rateLimitType: d.rateLimitType ?? l.flags.usageLimit?.rateLimitType ?? null };
          void this.terminate(l, '사용량 한도', false, 'usage_limit');
        } else if (d.errorKind === 'auth') {
          l.flags.auth = ev.text;
          void this.terminate(l, '인증 만료', false, 'auth_required');
        } else if (d.errorKind === 'permission') {
          this.flagBypass(l, ev.text);
        } else if (d.resumeFailed) {
          l.flags.resumeFailed = true;
        } else {
          this.countError(l, `err:${ev.text.slice(0, 160)}`, settings.spinSameErrorCount);
        }
        break;
      case 'result':
        l.flags.sawResult = true;
        l.flags.resultIsError = !!d.isError;
        if (ev.text) l.flags.finalText = ev.text;
        if (d.permissionDenials && d.permissionDenials > 0) this.flagBypass(l, `권한 거부 ${d.permissionDenials}건 발생`);
        if (d.resumeFailed) l.flags.resumeFailed = true;
        if (d.costUsd != null && l.usage.costUsd == null) l.usage.costUsd = d.costUsd;
        if (d.inputTokens != null && l.usage.inputTokens === 0) l.usage.inputTokens = d.inputTokens;
        if (d.outputTokens != null && l.usage.outputTokens === 0) l.usage.outputTokens = d.outputTokens;
        break;
      case 'text':
        l.flags.finalText = ev.text;
        break;
      default:
        break;
    }
  }

  /**
   * config: 설정 문제(권한 모드가 bypassPermissions 아님). 생략하면 바이패스를 확인하기 전의 거부만 설정 문제로 본다 —
   * init에서 bypassPermissions를 확인한 뒤의 개별 거부(CLI 내장 안전 검사: 빈 변수 경로 rm 등)는 그 명령만의 문제다 (windows:F8, CLI-12)
   */
  private flagBypass(l: LiveTurn, why: string, config?: boolean): void {
    if (l.flags.bypassMismatch) return;
    l.flags.bypassConfig = config ?? l.flags.bypass !== 'verified';
    l.flags.bypassMismatch = why;
    l.flags.bypass = 'mismatch';
    void this.terminate(l, `바이패스 설정 불일치: ${why}`, false, 'bypass_mismatch');
  }

  private countError(l: LiveTurn, sig: string, limit: number): void {
    const n = (l.errorCounts.get(sig) ?? 0) + 1;
    l.errorCounts.set(sig, n);
    // 단계 마치고 정지를 기다리는 턴도 헛돌기는 끊는다 (CONC-09)
    if (n >= limit && l.stop?.mode !== 'immediate') void this.terminate(l, `헛돌기: 같은 오류 ${n}회`, false, 'spin');
  }

  // ───────────────────────── 감시 (8장) ─────────────────────────

  private checkWatchdog(): void {
    const ctx = this.ctx;
    const s = ctx.settings().execution;
    const now = ctx.clock.ms();
    for (const l of this.live.values()) {
      // 이미 즉시 종료 중인 턴만 건너뛴다. 단계 마치고 정지(graceful)를 기다리는 턴도 시간 상한·응답 없음·헛돌기 감시를 받는다 —
      // 멈춘 CLI가 단계 완료를 부르지 않으면 자리·팀원이 무기한 잡힌다 (CONC-09, CLI-22). 종료는 terminate가 즉시로 올린다
      if (!l.proc || l.stop?.mode === 'immediate') continue;
      if (now - l.startedMs > s.turnTimeoutMin * 60_000) {
        void this.terminate(l, `턴 시간 상한 ${s.turnTimeoutMin}분 초과`, false, 'timeout');
        continue;
      }
      // 외부 보유자의 턴: 턴 시간 상한(deadlineAt)만 본다 — 출력 없음 감시는 하지 않는다. 임대(heartbeat)가 살아 있는지가 그 확인이다 (리드 결정 S7-4)
      if (l.external) continue;
      if (l.sessionKind === 'task' && now - l.lastStepMs > s.spinNoProgressMin * 60_000 && now - l.startedMs > s.spinNoProgressMin * 60_000) {
        void this.terminate(l, `헛돌기: 단계 진척 없이 ${s.spinNoProgressMin}분`, false, 'spin');
        continue;
      }
      const limitMs = (l.commands.size > 0 ? s.commandMaxMin : s.noOutputMin) * 60_000;
      if (now - l.lastActivityMs > limitMs) {
        if (l.suspectSinceMs == null) {
          l.suspectSinceMs = now;
          ctx.activity({ kind: 'system', level: 'warn', projectId: loggedProject(l), memberId: l.memberId, turnId: l.turnId, text: `응답 확인 중 — ${Math.round(limitMs / 60000)}분간 출력 없음` });
        } else if (now - l.suspectSinceMs > s.healthCheckMin * 60_000) {
          void this.terminate(l, '응답 없음', false, 'no_response');
        }
      }
    }
  }

  // ───────────────────────── 종료 ─────────────────────────

  private persistTurn(
    l: LiveTurn,
    p: { process?: Turn['process']['state']; pid?: number | null; spawnedAt?: string | null; start?: Turn['process']['start']; runTag?: string | null; killDetail?: string },
  ): void {
    const ctx = this.ctx;
    const t = ctx.store.turns.get(l.turnId);
    // 끝난 턴은 finish()가 쓴 최종 기록을 그대로 둔다 (CONC-13)
    if (!t || t.endedAt) return;
    l.lastPersistMs = ctx.clock.ms();
    ctx.store.turns.put({
      ...t,
      lastActivityAt: new Date(l.lastActivityMs).toISOString(),
      eventCount: l.seq,
      stepsCompleted: l.stepsCompleted,
      bypass: l.flags.bypass,
      mcp: l.flags.mcp,
      process: {
        ...t.process,
        state: p.process ?? t.process.state,
        pid: p.pid !== undefined ? p.pid : t.process.pid,
        spawnedAt: p.spawnedAt !== undefined ? p.spawnedAt : (t.process.spawnedAt ?? null),
        // Linux만 생긴다 (S10-5.1) — 없으면 키를 만들지 않는다 (다른 플랫폼의 기록은 그대로)
        ...(p.start ? { start: p.start } : {}),
        // Linux만 (S10-10.2) — 리더가 끝난 뒤 남은 그룹을 재시작 복구가 알아본다
        ...(p.runTag ? { runTag: p.runTag } : {}),
        stopRequestedAt: l.stop && !t.process.stopRequestedAt ? ctx.now() : t.process.stopRequestedAt,
        stopMode: l.stop?.mode ?? t.process.stopMode,
        killDetail: p.killDetail ?? t.process.killDetail,
      },
    });
    ctx.bus.changed();
  }

  private endReasonOf(l: LiveTurn, x: { code: number | null; terminated: boolean; spawnError?: string }): TurnEndReason {
    if (l.stop) return l.stop.endReason;
    if (x.spawnError) return 'spawn_failed';
    if (l.flags.bypassMismatch) return 'bypass_mismatch';
    if (l.flags.auth) return 'auth_required';
    if (l.flags.usageLimit) return 'usage_limit';
    if (!l.flags.sawResult) return 'crashed';
    if (x.code !== 0 && x.code !== null && l.flags.resultIsError) return 'crashed';
    return 'completed';
  }

  /** leftoverDetail: ExitInfo.detail — 남은 후손을 확인하지 못한 까닭 (러너가 알려 줌) */
  private async finish(l: LiveTurn, x: { code: number | null; terminated: boolean; remaining: number; spawnError?: string; leftoverDetail?: string }): Promise<void> {
    const ctx = this.ctx;
    // 이 뒤로 이 턴의 서버 명령은 새로 띄우지 않는다 — 아래 settleTurn보다 먼저, 같은 동기 구간에서 (리드 결정 S5-18)
    l.finishing = true;
    // 외부 보유자의 턴: 그 임대가 받아 간 턴을 지운다 — 다음 work/next는 새 일을 기다린다 (리드 결정 S7-4)
    if (l.external) this.core.externalAgents.turnEnded(l.turnId);
    if (l.uiTimer) {
      clearTimeout(l.uiTimer);
      l.uiTimer = null;
    }
    if (l.questionEndTimer) {
      clearTimeout(l.questionEndTimer);
      l.questionEndTimer = null;
    }
    const batch = l.pendingUi.splice(0);
    if (batch.length) ctx.bus.emit('cliEvents', { memberId: l.memberId, turnId: l.turnId, events: batch });
    await new Promise<void>((r) => (l.stream ? l.stream.end(r) : r()));
    if (l.token) this.core.toolServer.revokeToken(l.token);
    for (const f of l.cleanup) {
      try {
        removeTree(f);
      } catch {
        // 임시 파일 정리 실패는 동작에 영향 없음
      }
    }
    // 이 턴이 부른 서버 명령(host_exec)을 끝내고 그 기록이 끝날 때까지 기다린다 — CLI가 끝나도 처리기는 뒤에서 계속 돈다. 남은 하위 프로세스는 그 처리가 이 턴에
    // 접는다(noteUnconfirmed). 정상 종료·감시·종료 요청·자리 교체의 정지 모두 이 길이다 (리드 결정 S5-18)
    await this.core.hostExec.settleTurn(l.turnId, hostStopOf(l.stop?.reason ?? null));
    // 메인 턴이 무장한 화면 도우미를 놓고(RELEASE — 답이 없으면 STOP하고 끝낸다), 그 턴의 화면 조작을 활동 기록·일지 한 줄로 남긴다. 도우미의 끝남을 확인하지
    // 못했으면 서버 명령처럼 이 턴에 접는다(noteUnconfirmed → 아래 leftover → kill_failed, 메인 일시정지) — 그래서 leftover를 읽기 전에 기다린다 (리드 결정 S6-7·S6-9).
    // 접는 것은 그 정지의 결과가 나온 그때다(desktop/lifecycle.ts — 그때 돌던 메인 턴에만, 리드 결정 S6-21 A1): 이 기다림이 도는 정지(긴급 정지·교체·시간 초과로
    // 스스로 한 정지)의 결과까지 기다리므로 이 턴이 도는 동안의 것은 여기서 잡힌다
    if (l.memberId === MAIN_AGENT_ID) {
      await this.core.desktop.settleTurn(l.turnId, { memberId: l.memberId, sessionId: l.sessionId, projectId: loggedProject(l), workKey: l.sessionKey, generation: l.seatGeneration ?? this.core.seat.generation() });
    }
    // 프로그램이 끝낸 턴이면 그 종료 확인 결과를 본다 (terminate가 기다린 것과 같은 약속). 확인하지 못했으면(ok=false) 프로세스의
    // ExitInfo.remaining이 0이어도 — 러너가 제한 시간 안에 보고하지 않아 러너째 끊은 경우 등 — 종료 확인으로 치지 않는다 (CTL-11)
    const stopRes = l.stopResult ? await l.stopResult : null;
    const stopUnconfirmed = !!stopRes && !stopRes.ok;
    const host = l.hostUnconfirmed;
    /** 남은 프로세스 수 (0 = 종료 확인, -1 = 확인하지 못함). 이 턴의 서버 명령이 남긴 것도 센다 */
    const leftover = x.remaining !== 0 ? x.remaining : stopUnconfirmed ? (stopRes.remaining > 0 ? stopRes.remaining : -1) : host ? host.remaining : 0;
    const reason = this.endReasonOf(l, x);
    const endedAt = ctx.now();
    const detail =
      x.spawnError ??
      l.stop?.reason ??
      l.flags.bypassMismatch ??
      l.flags.auth ??
      l.flags.usageLimit?.message ??
      (reason === 'crashed' ? `종료 코드 ${x.code}${l.flags.sawResult ? '' : ', 결과 이벤트 없음'}` : '');
    const t = ctx.store.turns.get(l.turnId);
    const killDetail =
      leftover !== 0 ? (t?.process.killDetail ?? (stopUnconfirmed ? stopRes.detail : null) ?? x.leftoverDetail ?? host?.detail ?? leftoverText(leftover)) : (t?.process.killDetail ?? null);
    if (t) {
      ctx.store.turns.put({
        ...t,
        endedAt,
        lastActivityAt: new Date(l.lastActivityMs).toISOString(),
        endReason: reason,
        endDetail: detail,
        eventCount: l.seq,
        stepsCompleted: l.stepsCompleted,
        bypass: l.flags.bypass,
        mcp: l.flags.mcp,
        usage: { inputTokens: l.usage.inputTokens || null, outputTokens: l.usage.outputTokens || null, costUsd: l.usage.costUsd },
        finalText: l.flags.finalText ? ctx.redact.text(l.flags.finalText).slice(0, 20000) : null,
        process: {
          ...t.process,
          // 남은 프로세스가 있거나(>0) 남은 후손을 확인하지 못했으면(-1) 종료 확인으로 치지 않는다 (CTL-11). 정지 요청의 종료 확인이 실패했으면
          // (terminate ok=false) ExitInfo.remaining이 0이어도 kill_failed — 판정 순서와 관계없이 그 결과(stopResult)로 정한다
          state: leftover !== 0 ? 'kill_failed' : 'exited',
          exitCode: x.code,
          killDetail,
        },
      });
      // 세션 턴 수는 CLI를 띄운 턴만 센다 (첫 턴 판정·이어하기의 기준) — 띄우기 전에 멈춘 턴은 CLI 대화를 만들지 않았으므로,
      // 세면 다음 턴이 없는 CLI 세션을 이어하려다 한 번 헛돈다 (ERR-03)
      const s = ctx.store.sessions.get(l.sessionId);
      if (s && l.proc) ctx.store.sessions.put({ ...s, turnCount: s.turnCount + 1, lastTurnAt: endedAt });
      const m = ctx.store.members.get(l.memberId);
      if (m) ctx.store.members.put({ ...m, runSeconds: m.runSeconds + Math.round((ctx.clock.ms() - l.startedMs) / 1000) });
      const delivered = !!l.proc;
      ctx.store.tx(() => {
        for (const id of l.entryIds) {
          const q = ctx.store.queue.get(id);
          if (!q || q.state !== 'running') continue;
          // 프로세스를 띄우기 전에 멈췄으면 전달되지 않았으므로 대기열로 되돌린다
          if (delivered) ctx.store.queue.put({ ...q, state: 'done', doneAt: endedAt });
          else ctx.store.queue.put({ ...q, state: 'queued', turnId: null });
        }
      });
    }
    this.live.delete(l.turnId);
    l.resolveDone();
    ctx.activity({
      kind: reason === 'completed' ? 'session' : 'error',
      level: reason === 'completed' || reason === 'user_stop' ? 'info' : 'warn',
      actor: l.memberId,
      projectId: loggedProject(l),
      taskId: l.taskId,
      memberId: l.memberId,
      sessionId: l.sessionId,
      turnId: l.turnId,
      text: `턴 종료 (${reason})${detail ? `: ${detail}` : ''} — 단계 ${l.stepsCompleted}개 완료`,
    });
    // 판정 전에: 남은 하위 프로세스가 있거나 확인하지 못했으면 그 실행에 새 턴을 겹쳐 띄우지 않게 막는다 (CTL-11, F14).
    // 앱 종료가 끝낸 턴은 막지 않는다 (blockUnconfirmedRun) — 기록(kill_failed)만 남고 다음 시작이 이어 간다
    if (t && leftover !== 0) await this.leftoverProcesses(l, leftover, killDetail);
    try {
      await this.judge(l, reason, x);
    } catch (e) {
      ctx.log('error', `턴 종료 판정 실패 ${l.turnId}`, e);
      ctx.activity({ kind: 'error', level: 'error', projectId: loggedProject(l), memberId: l.memberId, taskId: l.taskId, turnId: l.turnId, text: `턴 종료 판정 실패: ${e instanceof Error ? e.message : String(e)}` });
    }
    this.core.team.applyPendingAiIfIdle(l.memberId);
    // 메인 턴이 어떻게 끝났는지로 보유자의 응답 없음을 센다 — 판정(다시 넣기) 뒤에 (SERVER_DESIGN 4.4, 리드 결정 S4-5)
    if (l.memberId === MAIN_AGENT_ID) this.core.seat.noteMainTurnEnd(l.seatGeneration, reason);
    ctx.bus.changed();
    // 프로세스를 띄우기 전에 실패했으면 턴 기록 전 실패(failStart)와 같이 1초 뒤에 다시 본다 — 같은 실패를 곧바로 되풀이하지 않게
    if (reason === 'spawn_failed' && !l.proc) setTimeout(() => ctx.bus.signal('tick'), 1000);
    else ctx.bus.signal('tick');
  }

  /**
   * CLI는 끝났는데 정리 뒤에도 하위 프로세스(개발 서버·테스트 등)가 남았거나 남은 후손을 확인하지 못했다 (kill_failed) — 막고 알린다
   * (blockUnconfirmedRun). AC-36: 대표 메시지 등 그 세션에 쌓인 업무는 그대로 대기열에 남아 재개 때 전달된다 (기존 턴과 관련 하위 프로세스 종료 후 전달)
   */
  private async leftoverProcesses(l: LiveTurn, remaining: number, cause: string | null): Promise<void> {
    const who = this.ctx.store.members.get(l.memberId)?.name ?? l.memberId;
    await this.blockUnconfirmedRun(
      { label: `${who} ${l.label}`, sessionKind: l.sessionKind, sessionKey: l.sessionKey, memberId: l.memberId, projectId: l.projectId, taskId: l.taskId, turnId: l.turnId },
      { envProblem: unconfirmedEnvProblem(this.ctx.deps.runner), remaining, cause, what: '턴' },
    );
  }

  /**
   * 종료를 확인하지 못한 실행(턴·자동 검사·재시작 때 끊은 이전 턴)에 새 프로세스를 겹쳐 띄우지 않게 막고 긴급 알림 (CTL-11, F14).
   * 남은 프로세스를 확인·정리한 뒤 푼다. 먼저 막고(보류·일시정지와 메인 업무) 그 결과대로 알림 글을 쓴다 — 알림이 '넘겼습니다'라고 할 때는 이미 넘긴 뒤다
   * (리드 결정 S5-9: 알림은 보류 뒤).
   * - 작업·검수 세션(작업에 묶인 실행): 그 작업을 보류(오류, 사유 글은 사실만) → 메인 에이전트에게 알림 업무(alert kill-failed:<작업>) → 메인 에이전트의 항목별
   *   재개(`resume_task`). 같은 보류를 이미 받아 마쳤으면 넘기지 않고 결정 32의 문장 (리드 결정 S5-7·S5-8)
   * - 관리 세션(지시 관리·메인 에이전트): 막을 작업이 없으므로 그 팀원을 일시정지한다 (까닭을 정지 기록에 남긴다) → 프로듀서는 메인 에이전트의
   *   `resume_member`, 메인 에이전트 자신은 대표의 정지 해제(`stop.release`, 리드 결정 6 — 정지된 메인은 턴이 뜨지 않아 스스로 풀 수 없다).
   *   프로듀서 등 팀원을 일시정지하면 메인 에이전트에게 재개 업무를 넣는다(handPauseToMain) — 그 팀원 앞에 멈춘 업무(검수자 재배정 등)를 처리할 수
   *   있는 쪽은 메인 에이전트뿐이다 (리드 결정 26). 이미 일시정지된 팀원은 살아 있는 재개 업무가 있을 때만 그 글('메인 에이전트가 다시 이어 갑니다')을 쓰고,
   *   없으면(메인이 건 정지, 1단계 전 대표 정지, 재개 업무가 상한에서 대표에게 넘어감) 알림 업무(alert kill-failed:<팀원>)를 넣는다 (리드 결정 26·42·S5-8).
   *   새로 건 정지도 같다 — 재개 업무를 넣지 못했으면 알림 업무로 넘긴다. 삭제된 팀원은 일시정지하지 않고 그 업무 세션을 대상으로 한 알림
   *   (alert kill-failed:<세션 키>)으로 넘긴다 (리드 결정 S5-62)
   * 앱 종료(stopAll '앱 종료') 중에는 막지 않는다 — 기록(kill_failed)만 남는다. 보류·정지를 남기면 재시작 뒤 그 일이 이유 없이 멈춘다.
   * 대표 알림 글을 돌려준다(앱 종료 중이면 사실만)
   */
  async blockUnconfirmedRun(
    r: {
      label: string;
      sessionKind: SessionKind;
      sessionKey: string;
      memberId: string;
      projectId: string | null;
      taskId: string | null;
      turnId: string | null;
      /** 작업 보류 사유의 refId — 그 실행의 기록 ID (자동 검사: 메인 에이전트가 이 보류를 재개하면 그 실행의 결과로 이어 간다, S7-C2) */
      refId?: string | null;
    },
    u: {
      envProblem: string | null;
      remaining: number;
      cause: string | null;
      what: '턴' | '자동 검사' | '이전 실행' | '서버 명령';
      /** 사실 뒤에 붙일 글 — 자동 검사가 재개 때 그 결과로 이어 간다는 것 (autocheck resumeText) */
      tail?: string | null;
    },
  ): Promise<string> {
    const ctx = this.ctx;
    const mode = ctx.deps.mode ?? 'desktop';
    const tail = u.tail ? ` — ${u.tail}` : '';
    const facts = `${unconfirmedFacts(u.envProblem, u.remaining, u.cause, u.what)}${tail}`;
    if (this.core.stopping) {
      ctx.log('warn', `앱 종료 중 종료를 확인하지 못한 실행 (보류·일시정지하지 않음): ${r.label} — ${facts}`);
      return facts;
    }
    const send = (exit: UnconfirmedExit, lead = ''): string => {
      const note = `${unconfirmedNote(u.envProblem, u.remaining, u.cause, u.what, exit, mode, lead)}${tail}`;
      ctx.notify({
        level: 'urgent',
        title: '프로세스 종료 확인 실패',
        body: `${r.label}: ${note}`,
        link: r.projectId ? { tab: 'projects', projectId: r.projectId, memberId: r.memberId, taskId: r.taskId ?? undefined } : null,
        key: `kill-failed:${r.sessionKey}`,
      });
      return note;
    };
    const pidLine = (): string[] => {
      const turn = r.turnId ? ctx.store.turns.get(r.turnId) : null;
      const left = u.remaining > 0 ? `남은 하위 프로세스 ${u.remaining}개` : '남은 하위 프로세스를 확인하지 못함';
      const pid = turn?.process.pid ? `턴 ${turn.id}의 CLI PID ${turn.process.pid}` : turn ? `턴 ${turn.id}` : r.label;
      return [`- 프로세스: ${pid} — ${left}${turn?.process.killDetail ? ` (${clip(turn.process.killDetail, 200)})` : ''}`];
    };
    if (r.sessionKind !== 'task' && r.sessionKind !== 'review') {
      const block = unconfirmedBlock(r.memberId, r.sessionKind);
      const m = ctx.store.members.get(r.memberId);
      if (m?.deletedAt) {
        // 삭제된 팀원(교체된 프로듀서 등 — 지우는 길은 그 턴의 마무리를 기다리지 않는다)은 일시정지하지 않는다: 지워진 팀원의 정지는 화면·현황에 남기만 하고, 그 재개
        // 업무(handPauseToMain)는 삭제된 팀원이라 넣지 않아 남은 프로세스가 메인에게 가지 않는다. 팀원에 매이지 않는 알림 — 그 업무 세션을 대상으로 한 kill-failed —
        // 으로 넘긴다. 시작 때 맞춤이 남은 프로세스에 거는 항목(작업 보류·팀원 정지)은 삭제된 팀원의 관리 세션에 맞지 않는다 (리드 결정 S5-62 2)
        const handed = alertMain(ctx, {
          kind: 'kill-failed',
          target: r.sessionKey,
          projectId: m.projectId ?? workProjectOf(ctx, r.sessionKey),
          message: deletedMemberAlertText(ctx, m, { label: r.label, sessionKey: r.sessionKey, sessionKind: r.sessionKind }, pidLine()),
          since: ctx.now(),
        });
        return send(handed ? 'handed' : 'task_hold', handed ? '삭제된 팀원이라 일시정지하지 않고 ' : '');
      }
      /** 그 팀원의 재개를 메인에게 맡긴 업무(결정 26)가 살아 있는지 — '메인 에이전트가 다시 이어 갑니다'는 이것이 있을 때만 참이다 */
      const livePauseItem = (): boolean =>
        ctx.store.queue.list({ state: ['queued', 'running'] }).some((q) => q.pausedMemberId === r.memberId && q.memberId === MAIN_AGENT_ID && !deadWorkReason(ctx, q, this.reviewBusy));
      const stop = ctx.stop().members[r.memberId];
      if (stop?.paused) {
        // 이미 팀원 일시정지면 그 재개가 같은 확인 지점이다. 긴급 정지·프로젝트 정지는 풀릴 때 이 세션이 다시 돌 수 있어 팀원 정지를 더한다.
        // 그 재개를 메인에게 맡긴 업무가 살아 있을 때만 '메인 에이전트가 다시 이어 갑니다'가 참이다 — 없으면 메인에게 알림 업무를 넣는다 (리드 결정 26·S5-8)
        if (block === 'main_pause') return send('main_pause');
        if (livePauseItem()) return send('member_pause');
        const handed = m
          ? alertMain(ctx, {
              kind: 'kill-failed',
              target: m.id,
              projectId: m.projectId,
              message: memberAlertText(ctx, m.id, `${m.name}(${m.id}) — ${r.label}의 프로세스 종료를 확인하지 못했습니다. 이미 일시정지돼 있어 프로그램이 새로 정지를 걸지 않았고, 그 재개를 맡은 업무도 없습니다`, pidLine()),
              since: stop.since,
            })
          : null;
        return send(handed ? 'handed' : 'task_hold', handed ? '팀원 일시정지는 그대로 두고 ' : '');
      }
      try {
        await this.core.stops.pauseMember(r.memberId, 'graceful', 'system', `프로세스 종료를 확인하지 못함 (${clip(r.label, 80)})`);
        // 활동 기록은 작업 키의 프로젝트로도 남긴다 — 메인 에이전트의 main:P 턴 (S5-5). 알림 링크는 위의 projectId 그대로
        ctx.activity({ kind: 'stop', level: 'warn', projectId: r.projectId ?? workProjectOf(ctx, r.sessionKey), memberId: r.memberId, turnId: r.turnId, text: `프로세스 종료 확인 실패로 일시정지 — ${facts}` });
        if (r.memberId !== MAIN_AGENT_ID) this.handPauseToMain(r.memberId, { label: r.label, turnId: r.turnId });
      } catch (e) {
        ctx.log('error', `남은 프로세스 일시정지 처리 실패 ${r.memberId}`, e);
      }
      // 새로 건 정지도 그 재개 업무가 메인에게 있을 때만 member_pause의 글이다. 넣지 못했으면(처리 실패) 일시정지가 걸렸을 때는 알림 업무로 넘기고 넘긴 사실을,
      // 정지도 걸지 못했으면 결정 32의 문장을 쓴다 — 대표 글은 실제로 메인에게 간 것만 말한다 (리드 결정 26·S5-8·S5-62 2)
      if (block === 'member_pause' && !livePauseItem()) {
        const paused = ctx.stop().members[r.memberId];
        const handed =
          m && paused?.paused
            ? alertMain(ctx, {
                kind: 'kill-failed',
                target: m.id,
                projectId: m.projectId,
                message: memberAlertText(ctx, m.id, `${m.name}(${m.id}) — ${r.label}의 프로세스 종료를 확인하지 못해 프로그램이 일시정지했지만, 그 재개를 맡길 업무를 넣지 못했습니다`, pidLine()),
                since: paused.since,
              })
            : null;
        return send(handed ? 'handed' : 'task_hold', handed ? '팀원을 일시정지하고 ' : '');
      }
      return send(block);
    }
    const task = r.taskId ? ctx.store.tasks.get(r.taskId) : null;
    let handed: QueueEntry | null = null;
    if (task && !isTerminal(task.state)) {
      try {
        this.core.tasks.hold(task.id, 'error', 'task', facts, 'system', r.refId ?? null);
        handed = alertTaskHold(ctx, 'kill-failed', task.id, { cause: `${r.label}의 프로세스 종료를 확인하지 못해 보류됨`, refId: r.refId ?? null, extra: pidLine() });
      } catch (e) {
        ctx.log('error', `남은 프로세스 보류 처리 실패 ${task.id}`, e);
      }
    }
    return send(handed ? 'handed' : 'task_hold', handed ? '작업을 보류하고 ' : '');
  }

  /**
   * 프로그램이 일시정지한 팀원(종료를 확인하지 못한 실행, CTL-11)의 재개를 메인 에이전트에게 맡긴다 (리드 결정 26). 그 팀원 앞에 멈춘 업무(검수자 재배정 등)를
   * 풀 수 있는 쪽은 `resume_member`를 가진 메인 에이전트뿐이다 — 대표에게는 팀원 재개가 없다. 업무 글은 그 팀원, 까닭, 프로세스(PID)와 '남은 프로세스가
   * 사라졌는지 확인한 뒤 재개'를 담는다. 그 팀원 앞에 기다리는 업무는 글에 저장하지 않고 전달할 때마다 머리말이 적는다(standingHead, 리드 결정 37).
   * 그 팀원이 프로그램이 건 그 정지로 남아 있는 동안만 필요한 남는 업무다 (deadWorkReason 한 판정 —
   * 넣을 때도 본다, 리드 결정 31). 그 정지의 재개 업무가 이미 대기·실행 중이면 넣지 않는다 — 시작 때 관리 업무 복원(recovery.reconcileManagement)도 이
   * 길이라 다시 불러도 같다. 앞선 다른 정지의 낡은 재개 업무가 남아 있으면 지우고(기록) 이 정지의 업무를 넣는다.
   * from: 그 정지를 건 실행(이름·턴). 없으면(시작 때 복원) 정지 기록의 까닭을 쓴다
   */
  handPauseToMain(memberId: string, from: { label: string; turnId: string | null } | null): void {
    const ctx = this.ctx;
    const m = ctx.store.members.get(memberId);
    const stop = ctx.stop().members[memberId];
    if (!m || m.deletedAt || m.isMain || !stop?.paused || stop.by !== 'system') return;
    for (const q of ctx.store.queue.list({ state: ['queued', 'running'] })) {
      if (q.pausedMemberId !== memberId) continue;
      const ended = deadWorkReason(ctx, q, this.reviewBusy);
      if (!ended) return;
      if (q.state === 'queued') dropDeadWork(ctx, q, ended);
    }
    const turn = from?.turnId ? ctx.store.turns.get(from.turnId) : null;
    const cause = from ? `${from.label}의 프로세스 종료를 확인하지 못했습니다` : (stop.reason ?? '프로세스 종료를 확인하지 못했습니다');
    const pid = turn
      ? [turn.process.pid ? `턴 ${turn.id}의 CLI PID ${turn.process.pid}` : `턴 ${turn.id}`, turn.process.killDetail ? clip(turn.process.killDetail, 200) : null].filter(Boolean).join(' — ')
      : '알 수 없음 (정지 기록만 남음)';
    // 그 팀원 앞에 기다리는 업무는 저장하지 않는다 — 넣는 때(턴 판정 전)의 목록은 전달할 때 사실이 아니다: 정상으로 끝난 턴이 실은 업무는 이미 처리됐고,
    // 그 뒤에 온 업무(검수자 재배정 등)는 빠진다. 전달할 때마다 머리말(standingHead)이 그때 기다리는 업무를 적는다 (리드 결정 31·37)
    const message = [
      `프로그램이 ${m.name}(${m.id}, ${roleOf(ctx, m.roleId)?.name ?? m.roleId})을(를) 일시정지했습니다 — ${cause}.`,
      `- 프로세스: ${pid}`,
      `남은 프로세스가 모두 사라졌는지 확인한 뒤 resume_member(member_id="${m.id}", reason="…")로 재개하세요. 직접 확인할 길이 없으면 ask_owner로 ${
        // 서버 PC의 프로세스는 원격 대표가 볼 수 없다 — 그 PC의 운영자가 확인한다 (리드 결정 S4-20·S5-9)
        ctx.deps.mode === 'server' ? '대표에게 서버 PC 운영자의 확인을 부탁해 달라고 하세요' : '대표에게 작업 관리자에서 확인해 달라고 부탁하세요'
      }.`,
    ].join('\n');
    enqueue(ctx, { kind: 'message', memberId: MAIN_AGENT_ID, sessionKey: mainKey(m.projectId), projectId: m.projectId, pausedMemberId: m.id, priority: 'high', message });
    ctx.activity({ kind: 'stop', level: 'warn', projectId: m.projectId, memberId: m.id, text: `${m.name} 일시정지(프로세스 종료 확인 실패)의 재개를 메인 에이전트에게 맡김 — 남은 프로세스를 확인한 뒤 재개` });
  }

  /**
   * 재개 업무가 대표에게 넘어간 뒤(세 번 전달해도 그대로 → '메인 에이전트 처리 지연' pause-stuck) 그 팀원이 아직 프로그램이 건 정지로 일시정지돼 있는데 그 뒤
   * 새 업무가 왔다 — 처리할 수 있는 쪽(메인 에이전트)에게 가는 업무가 없으니 알림 업무를 넣는다 (alert member-paused:<팀원>, 리드 결정 35·S5-8). 스케줄러가
   * 틱마다 부른다. (그 정지, 가장 최근 넘김) 한 번에 한 번: 넘긴 때(대표 알림 시각) 뒤에 같은 키로 넣었으면 다시 넣지 않는다. 그 정지의 재개 업무가 다시
   * 살아 있으면(재시작 때 복원) 넣지 않는다. 그 메인 세션 턴이 돌고 있으면 이번에는 보지 않는다(끝나는 중인 턴이 재개 업무를 다시 넣을 수 있다)
   */
  alertPausedMembers(): void {
    const ctx = this.ctx;
    for (const [memberId, s] of Object.entries(ctx.stop().members)) {
      if (!s.paused || s.by !== 'system' || memberId === MAIN_AGENT_ID) continue;
      const m = ctx.store.members.get(memberId);
      if (!m || m.deletedAt) continue;
      const key = mainKey(m.projectId);
      if (this.hasLiveSession(key)) continue;
      const gaveUp = ctx.store.notifications
        .list({ ref1: `pause-stuck:${m.id}` })
        .map((n) => n.createdAt)
        .filter((at) => at >= s.since)
        .sort()
        .pop();
      if (!gaveUp) continue;
      if (ctx.store.queue.list({ ref2: key, state: ['queued', 'running'] }).some((q) => q.pausedMemberId === m.id && q.memberId === MAIN_AGENT_ID)) continue;
      const fresh = ctx.store.queue.list({ ref1: m.id, state: 'queued' }).filter((q) => !q.ownerShared && q.createdAt > gaveUp);
      if (!fresh.length) continue;
      const head = `${m.name}(${m.id}) — 프로그램이 건 일시정지(${clip(s.reason ?? '프로세스 종료를 확인하지 못함', 120)})의 재개 업무를 세 번 넘겨도 그대로라 대표에게 알린 뒤에도 일시정지돼 있는데, 그 뒤 새 업무 ${fresh.length}건이 왔습니다`;
      alertMain(ctx, { kind: 'member-paused', target: m.id, projectId: m.projectId, message: memberAlertText(ctx, m.id, head), since: gaveUp });
    }
  }

  /**
   * 대상이 풀릴 때까지 남는 메인 에이전트 업무가 아직 필요한지 (리드 결정 24·26·31) — 필요하면 그 대상, 아니면 null. 필요한지는 deadWorkReason 한 판정이고
   * (넣을 때·스케줄러가 전달하기 전·다시 넣을 때·재시작 복구가 같은 판정), 여기서는 같은 대상의 다른 남는 업무가 대기·실행 중이면(그것이 이어 간다) 겹쳐
   * 넣지 않도록 null을 더 돌려준다. q 자신은 세지 않는다
   */
  private standingNeed(q: QueueEntry): { task: Task } | { member: Member } | null {
    const ctx = this.ctx;
    if (!isStandingItem(q) || deadWorkReason(ctx, q, this.reviewBusy)) return null;
    if (q.pausedMemberId) {
      const m = ctx.store.members.get(q.pausedMemberId);
      if (!m) return null;
      return ctx.store.queue.list({ state: ['queued', 'running'] }).some((x) => x.id !== q.id && x.pausedMemberId === m.id) ? null : { member: m };
    }
    const t = ctx.store.tasks.get(q.taskId!);
    if (!t || reviewHandedOff(ctx, t.id, q.id)) return null;
    return { task: t };
  }

  /** 검수가 대기·실행 중인지 — 남는 업무 판정(deadWorkReason)이 쓴다 (실행 중인 검수 턴까지 보는 tasks.reviewPending) */
  private readonly reviewBusy = (taskId: string): boolean => this.core.tasks.reviewPending(taskId);

  /**
   * 메인 에이전트가 그 프로젝트에서 시작한 진행이 아직 끝나지 않았는지 (리드 결정 31) — 그동안 남는 업무는 다시 전달하지 않고 기다린다(전달 횟수로 세지 않는다).
   * - 그 메인 세션(main:<P>)이 대표에게 한 질문(ask_owner)이 아직 열려 있다
   * - 메인 에이전트가 그 프로젝트 팀원에게 보낸 지시·메시지(instruct_member·send_message — 메시지 기록이 있는 항목)가 아직 전달 전이거나, 그것을 실은 턴이
   *   돌고 있다. 받는 쪽이 지금 받을 수 없는 지시(받는 팀원이 일시정지·삭제됨, 프로젝트 일시정지, 그 업무 세션이 지금 뜨지 않음 — 검수 중 작업의 작업
   *   세션 등, 받는 팀원의 AI 쪽 막힘 — 재로그인 필요·사용량 한도·모델별 주간 한도·CLI 문제)는 진행으로 보지 않는다. 그런 지시를 기다리며 남는 업무를
   *   끝없이 미루지 않게. 판정은 스케줄러와 같다 (mainProgress, 리드 결정 38)
   */
  mainProgressPending(projectId: string | null): boolean {
    return this.mainProgress(projectId).pending;
  }

  /**
   * mainProgressPending의 자세한 판정 — pending: 기다리는 진행이 있다. stuck: 메인 에이전트가 보낸 지시 가운데 아직 전달 전인데 지금 받는 쪽이 받을 수 없어
   * 진행으로 보지 않은 것(받는 팀원 이름과 그 까닭) — 다시 전달하는 머리말이 '보낸 지시는 처리됐다'고 잘못 말하지 않게 (standingHead).
   * 받을 수 있는지는 스케줄러와 같은 판정이다: 그 세션이 지금 뜰 수 있는지(작업 세션은 진행 중, 검수 세션은 검수 중, 지시 세션은 지시가 열림)와 허용 검사
   * (entryRunGate — 정지·삭제, 작업 보류, 받는 팀원 AI 종류의 재로그인 필요·사용량 한도·그 팀원과 세션이 쓸 모델의 모델별 한도·CLI 문제, 모의 실행이면 AI는
   * 보지 않음). 스케줄러가 띄우지 않을 지시를 진행으로 세면 남는 업무가 그 막힘이 풀릴 때까지 다시 전달되지 않고 대표 알림도 가지 않는다 (리드 결정 38)
   */
  private mainProgress(projectId: string | null): { pending: boolean; stuck: { name: string; why: string }[] } {
    const ctx = this.ctx;
    const key = mainKey(projectId);
    if (ctx.store.questions.list({ state: 'open' }).some((x) => x.to === 'owner' && x.fromId === MAIN_AGENT_ID && x.sessionKey === key)) return { pending: true, stuck: [] };
    if (!projectId) return { pending: false, stuck: [] };
    const stop = ctx.stop();
    const nowMs = ctx.clock.ms();
    /** 받는 쪽이 지금 그 지시를 받을 수 없는 까닭 — 받을 수 있으면(또는 그 턴이 돌고 있으면) null */
    const blocked = (q: QueueEntry): string | null => {
      if (q.state === 'running') return null;
      const m = memberOrSuccessor(ctx, q.memberId);
      if (!m) return '받는 팀원이 삭제됨';
      const { kind, ref } = parseKey(q.sessionKey);
      const sessionTask = kind === 'task' || kind === 'review' ? (ctx.store.tasks.get(ref) ?? null) : null;
      if (kind === 'task' && sessionTask?.state !== 'in_progress') return sessionTask ? `${ref}이(가) ${TASK_STATE_LABEL[sessionTask.state]} 상태라 그 작업 세션이 뜨지 않음` : `작업 ${ref}을(를) 찾을 수 없음`;
      if (kind === 'review' && sessionTask?.state !== 'in_review') return sessionTask ? `${ref}이(가) ${TASK_STATE_LABEL[sessionTask.state]} 상태라 그 검수 세션이 뜨지 않음` : `작업 ${ref}을(를) 찾을 수 없음`;
      if (kind === 'directive' && closedDirectiveWork(ctx, ref, q.taskId ? ctx.store.tasks.get(q.taskId) : null)) return `지시 ${ref}이(가) 끝남`;
      const gate = this.entryRunGate(m, q.sessionKey, sessionTask, q, stop, nowMs);
      return gate.ok ? null : clip(gate.detail, 100);
    };
    let pending = false;
    const stuck = new Map<string, { name: string; why: string }>();
    for (const q of ctx.store.queue.list({ state: ['queued', 'running'] })) {
      if (!q.messageId || q.memberId === MAIN_AGENT_ID || q.projectId !== projectId) continue;
      if (ctx.store.messages.get(q.messageId)?.fromActor !== MAIN_AGENT_ID) continue;
      const why = blocked(q);
      if (!why) pending = true;
      else stuck.set(q.memberId, { name: ctx.store.members.get(q.memberId)?.name ?? q.memberId, why });
    }
    return { pending, stuck: [...stuck.values()] };
  }

  /**
   * 남는 업무를 전달할 때 그 글 앞에 붙이는 머리말 — 지금(스케줄러가 전달하기로 고른 같은 차례) 확인한 사실만 쓴다. 지금 상태를 말하는 문장은 이때 계산하므로
   * 참이다 (리드 결정 31: 전달 때 계산하지 않은 상태는 쓰지 않는다). 다시 전달(전달 횟수 1 이상)이면 몇 번째인지와 대상·진행의 지금 상태를 쓴다. 팀원 재개
   * 업무는 첫 전달부터 그 팀원 앞에 지금 기다리는 업무를 적는다 — 저장된 글에는 업무 목록이 없다 (리드 결정 37). 그 밖의 첫 전달이나 남는 업무가 아니면 null
   */
  private standingHead(q: QueueEntry): string | null {
    const ctx = this.ctx;
    const n = q.deliveries ?? 0;
    if (!isStandingItem(q)) return null;
    if (q.pausedMemberId) {
      const m = ctx.store.members.get(q.pausedMemberId);
      if (!m || !ctx.stop().members[m.id]?.paused) return null;
      if (n < 1) return `(${this.pausedWorkNow(m)})`;
    } else if (n < 1) return null;
    const progress = this.mainProgress(q.projectId);
    const settled = !progress.pending && !progress.stuck.length;
    // 보낸 지시 가운데 받는 쪽이 지금 받을 수 없어 아직 전달되지 않은 것 — 그 까닭(스케줄러의 허용 검사, 리드 결정 38)이 풀리기 전에는 처리되지 않으니 그 사실을 말한다
    const stuck = progress.stuck.length
      ? ` 앞서 ${progress.stuck.map((s) => s.name).join(', ')}에게 보낸 지시가 아직 전달되지 않았습니다 — 받는 쪽이 지금 그 업무를 받을 수 없어(${progress.stuck.map((s) => `${s.name}: ${s.why}`).join('; ')}) 그 까닭이 풀리기 전에는 처리되지 않습니다.`
      : '';
    const last = `${MAIN_STANDING_DELIVERIES}번째에도 그대로면 대표에게 알립니다.`;
    if (q.pausedMemberId) {
      const m = ctx.store.members.require(q.pausedMemberId);
      return `(${n + 1}번째 알림 — ${m.name}(${m.id})은(는) 아직 일시정지돼 있습니다) ${this.pausedWorkNow(m)}.${
        settled ? ' 팀원에게 보낸 지시나 대표에게 한 질문 가운데 처리를 기다리는 것은 지금 없습니다.' : stuck
      } 남은 프로세스가 사라졌는지 확인한 뒤 resume_member로 재개하세요. ${last}`;
    }
    const t = ctx.store.tasks.get(q.taskId!);
    if (!t) return null;
    const open = !this.reviewBusy(t.id) && !reviewHandedOff(ctx, t.id, q.id);
    return `(${n + 1}번째 알림 — ${t.id} 검수가 아직 다시 시작되지 않았습니다)${open ? ' 지금 이 작업에는 대기·실행 중인 검수도, 검수자 재배정 업무도 없습니다.' : ''}${
      settled ? ` 팀원에게 보낸 지시나 대표에게 한 질문 가운데 처리를 기다리는 것도 지금은 없습니다${this.sentInstructionsText(t)}` : stuck
    } 아래 안내대로 처리하세요. ${last}`;
  }

  /**
   * 멈춘 검수 넘김을 다시 전달할 때, 앞서 그 넘김을 실은 메인 턴부터 메인 에이전트가 그 프로젝트 팀원에게 보낸 지시가 어떻게 끝났는지 (리드 결정 40) —
   * 전달할 때 확인한 사실만 쓴다. 그 지시를 실은 마지막 항목이 마쳤고(done) 그 턴이 정상으로 끝났으면(정상 종료·시간 상한) '처리됐다'고 쓰고, 취소됐거나
   * 전달되지 못했거나 그 턴이 다른 끝(비정상 종료 상한·헛돌기 등)으로 끝나 다시 넣지 않았으면 받는 쪽에 닿지 못했다고 쓴다. 아직 대기·실행 중인 지시는
   * 진행(mainProgress)이 따로 말한다. 그런 지시가 없으면 마침표만 — 처리됐다고 짐작하지 않는다
   */
  private sentInstructionsText(t: Task): string {
    const ctx = this.ctx;
    // 앞서 이 작업의 넘김을 실은 메인 턴 (지금 턴은 아직 기록 전이다). 메인 에이전트 관리 턴의 기록에는 프로젝트가 없어 실은 항목으로 찾는다
    const carriesHandOff = (id: string): boolean => {
      const e = ctx.store.queue.get(id);
      return !!e && isReviewHandOff(e) && e.taskId === t.id;
    };
    const prev = ctx.store.turns
      .list({ ref1: MAIN_AGENT_ID }, { orderBy: 'created', desc: true, limit: 200 })
      .find((x) => x.endedAt && x.queueEntryIds.some(carriesHandOff));
    if (!prev) return '.';
    const byMessage = new Map<string, QueueEntry[]>();
    for (const x of ctx.store.queue.list({ project_id: t.projectId })) {
      if (!x.messageId || x.memberId === MAIN_AGENT_ID) continue;
      byMessage.set(x.messageId, [...(byMessage.get(x.messageId) ?? []), x]);
    }
    const processed = new Set<string>();
    const lost = new Map<string, string>();
    for (const [messageId, entries] of byMessage) {
      const msg = ctx.store.messages.get(messageId);
      if (msg?.fromActor !== MAIN_AGENT_ID || msg.createdAt < prev.startedAt) continue;
      if (entries.some((x) => x.state === 'queued' || x.state === 'running')) continue;
      const latest = entries.reduce((a, b) => (b.createdAt > a.createdAt || (b.createdAt === a.createdAt && b.id > a.id) ? b : a));
      const name = ctx.store.members.get(latest.memberId)?.name ?? latest.memberId;
      const end = latest.turnId ? ctx.store.turns.get(latest.turnId)?.endReason : null;
      const endText = end ? (CUT_END_TEXT[end] ?? null) : null;
      if (latest.state === 'done' && (end === 'completed' || end === 'timeout')) processed.add(name);
      else if (latest.state === 'done' && endText) lost.set(name, `받은 턴이 ${endText}${instrumentalJosa(endText)} 끝나 처리하지 못함`);
      else lost.set(name, msg.undeliveredReason ? `전달되지 못함 — ${clip(msg.undeliveredReason, 80)}` : '처리되기 전에 정리됨');
    }
    const done = [...processed].filter((x) => !lost.has(x));
    return [
      done.length ? ` — 앞서 ${done.join(', ')}에게 보낸 지시는 처리됐지만 검수가 다시 시작되지 않은 것입니다.` : '.',
      lost.size ? ` 앞서 ${[...lost.keys()].join(', ')}에게 보낸 지시는 받는 쪽에 닿지 못했습니다(${[...lost.entries()].map(([k, why]) => `${k}: ${why}`).join('; ')}).` : '',
    ].join('');
  }

  /**
   * 일시정지된 팀원 앞에 지금 기다리는 업무를 적은 문장 (팀원 재개 업무의 머리말, 리드 결정 37) — 그 팀원 몫의 대기 항목을 종류와 지시·작업 ID로 적는다. 멈춘
   * 턴이 실었던 업무도 아직 대기 중일 때만 나온다(정상으로 끝난 턴의 업무는 이미 처리됐다). 공유 사본(그 자체로 턴을 띄우지 않음)은 빼고, 없으면 없다고 쓴다
   */
  private pausedWorkNow(m: Member): string {
    const waiting = [...new Set(this.ctx.store.queue.list({ ref1: m.id, state: 'queued' }).filter((x) => !x.ownerShared).map(workLabel))];
    return waiting.length
      ? `지금 ${m.name}(${m.id}) 앞에 기다리는 업무: ${waiting.join(', ')} — 재개하기 전까지 처리되지 않습니다`
      : `지금 ${m.name}(${m.id}) 앞에 기다리는 업무는 없습니다 — 새로 오는 업무도 재개할 때까지 기다립니다`;
  }

  /**
   * 기다리던(진행이 끝나기를 기다린) 남는 업무가 이미 전달 상한에 닿았다 — 전달하지 않고 대표에게 그 작업·팀원을 알린 뒤 그 항목을 지운다 (리드 결정 31). 메인
   * 에이전트 턴에 세 번 실려 매번 대상이 그대로이고 기다리는 진행도 없을 때만 여기 온다. 스케줄러가 부른다. 같은 대상의 다른 남는 업무가 이어 가고 있으면
   * 알리지 않고 이 항목만 지운다(기록)
   */
  giveUpStanding(q: QueueEntry): void {
    const ctx = this.ctx;
    const need = this.standingNeed(q);
    if (need) this.standingGivenUp(need);
    else ctx.activity({ kind: q.pausedMemberId ? 'stop' : 'review', projectId: q.projectId, taskId: q.taskId, memberId: q.pausedMemberId ?? null, text: `남는 업무 ${q.id} 정리 — 같은 대상의 다른 업무가 이어 감 (${q.sessionKey})` });
    cancelQueued(ctx, (x) => x.id === q.id, need ? '메인 에이전트에게 세 번 전달했지만 그대로라 대표에게 알림' : '같은 대상의 다른 남는 업무가 이어 감');
  }

  /**
   * 남는 업무를 메인 에이전트가 처리하지 못했다 — 메인 턴 MAIN_STANDING_DELIVERIES번에 실려도 대상이 그대로이거나, 그 업무를 실은 메인 턴이 다시 넣지
   * 않는 끝(비정상 종료·응답 없음 상한, 헛돌기, CLI 안전 검사 거부 상한, 시작 실패 상한)으로 끝났다(lost — 그 끝의 모양). 조용히 버리지 않고 대표에게 그
   * 작업·팀원을 알린다 — 대표는 명령창으로 메인 에이전트에게 지시할 수 있다. 그 뒤에는 이 알림이 처리할 수 있는 쪽의 업무다 (리드 결정 24).
   * 알림은 작업·팀원마다 key 하나다(읽기 전이면 그 알림을 고친다)
   */
  private standingGivenUp(need: { task: Task } | { member: Member }, lost?: string): void {
    const ctx = this.ctx;
    if ('task' in need) {
      const t = need.task;
      const why = lost ? `메인 에이전트의 턴이 ${lost} 이 업무를 처리하지 못했습니다` : `메인 에이전트에게 ${MAIN_STANDING_DELIVERIES}번 넘겼지만 검수가 다시 시작되지 않았습니다`;
      ctx.notify({
        level: 'normal',
        title: '메인 에이전트 처리 지연',
        body: `${t.directiveId}: ${t.id} "${t.title}" 검수가 멈춘 채 남아 있습니다 — ${why}. 이 작업을 어떻게 할지 명령창으로 메인 에이전트에게 말해 주세요 (예: "${t.id} 검수를 다시 진행해", "${t.id}는 취소해").`,
        link: { tab: 'projects', projectId: t.projectId, directiveId: t.directiveId, taskId: t.id },
        key: `handoff-stuck:${t.id}`,
      });
      ctx.activity({ kind: 'review', level: 'warn', projectId: t.projectId, directiveId: t.directiveId, taskId: t.id, text: `${t.id} 멈춘 검수를 대표에게 알림 — ${why}` });
      return;
    }
    const m = need.member;
    const why = lost ? `메인 에이전트의 턴이 ${lost} 이 업무를 처리하지 못했습니다` : `메인 에이전트에게 재개를 ${MAIN_STANDING_DELIVERIES}번 맡겼지만 아직 재개하지 않았습니다`;
    const waiting = [...new Set(ctx.store.queue.list({ ref1: m.id, state: ['queued', 'running'] }).map(workLabel))];
    ctx.notify({
      level: 'normal',
      title: '메인 에이전트 처리 지연',
      body: `${m.name}(${m.id})이(가) 프로세스 종료를 확인하지 못해 일시정지된 채 남아 있습니다 — ${why}.${waiting.length ? ` 멈춘 업무: ${waiting.join(', ')}.` : ''} 남은 프로세스를 정리했다면 명령창으로 메인 에이전트에게 ${m.name}을(를) 재개하라고 말해 주세요.`,
      link: { tab: 'projects', projectId: m.projectId ?? undefined, memberId: m.id },
      key: `pause-stuck:${m.id}`,
    });
    ctx.activity({ kind: 'stop', level: 'warn', projectId: m.projectId, memberId: m.id, text: `${m.name} 일시정지를 대표에게 알림 — ${why}` });
  }

  /**
   * 메인 턴이 다시 넣지 않는 끝으로 끝났다 — 실었던 남는 업무(멈춘 검수 넘김·일시정지된 팀원의 재개) 중 아직 필요한 것을 대표에게 알린다(standingGivenUp).
   * 메인 에이전트의 관리 세션만 본다. entries: 이 항목들만 (시작 실패 상한에서 버리는 항목). 없으면 이 턴이 실은 항목 전부 (리드 결정 24)
   */
  private standingLost(l: TurnRef, lost: string, entries?: readonly QueueEntry[]): void {
    if (l.memberId !== MAIN_AGENT_ID || (l.sessionKind !== 'main_project' && l.sessionKind !== 'main_general')) return;
    for (const q of entries ?? l.entryIds.map((id) => this.ctx.store.queue.get(id))) {
      const need = q ? this.standingNeed(q) : null;
      if (need) this.standingGivenUp(need, lost);
    }
  }

  // ───────────────────────── 턴 종료 후 판정 (CLI-18) ─────────────────────────

  /**
   * 끊긴 턴의 업무를 다시 넣는다. 턴이 끝나는 시점에는 정지를 기다린 쪽(프로듀서 교체·지시 취소)의 처리가 이미 끝나 있으므로
   * 지금 상태를 다시 본다: 취소·종료된 지시의 관리 업무는 버리고(그 지시에 붙은 되돌리기 작업의 업무는 남긴다 — 별도 되돌리기, AC-46),
   * 담당은 지금 기준(교체 → 후임, 후임 없이 삭제 → 버림)으로 (CONC-04, TSK-09, ORG-04). 대상이 이미 끝난 업무(대표가 거둬들인 수정 요청 등)는
   * 다시 넣지 않고 정리한다 (deadWorkReason, 리드 결정 19 — 남는 업무의 대상이 풀렸는지도 같은 판정, 리드 결정 31).
   * 비정상 종료형 끝(비정상 종료·응답 없음·CLI 안전 검사 거부, crash)만 그 항목의 attempts를 올린다 — 사용량 한도·재로그인 필요·바이패스 설정 불일치·
   * 실행 파일 없음·이어하기 실패·정지로 다시 넣는 것은 비정상 종료 상한에 가까워지지 않는다. 다시 판정 턴의 다시 전달(delivery)은 deliveries로 센다 (리드 결정 30).
   * entries: 이 항목들만 (비정상 종료 상한 아래인 항목). 없으면 이 턴이 실은 항목 전부
   */
  private requeue(l: LiveTurn, extra: string, o: { crash?: boolean; delivery?: boolean; entries?: readonly QueueEntry[] } = {}): void {
    const ctx = this.ctx;
    if (!l.proc) return; // 전달 전이면 finish()에서 이미 대기열로 되돌렸다
    if (l.sessionKind === 'directive') {
      const d = l.directiveId ? ctx.store.directives.get(l.directiveId) : null;
      if (!d) return;
    }
    for (const q of o.entries ?? l.entryIds.map((id) => ctx.store.queue.get(id))) {
      if (!q) continue;
      if (l.sessionKind === 'directive' && closedDirectiveWork(ctx, l.directiveId, q.taskId ? ctx.store.tasks.get(q.taskId) : null)) continue;
      const ended = deadWorkReason(ctx, q, this.reviewBusy);
      if (ended) {
        dropDeadWork(ctx, q, ended);
        continue;
      }
      const m = memberOrSuccessor(ctx, q.memberId);
      if (!m) continue;
      // 이어하기가 실패한 턴은 그 CLI 세션에 닿지 못했다(세션은 닫혔다) — 실었던 메시지의 전달 기록을 지운다. 새 세션의 턴이 띄울 때 다시 적는다
      // (AC-36-obs 기록이 사실대로, S7-B5)
      if (l.flags.resumeFailed && q.messageId) {
        const msg = ctx.store.messages.get(q.messageId);
        if (msg?.deliveredAt) ctx.store.messages.put({ ...msg, deliveredAt: null });
      }
      enqueue(ctx, {
        kind: q.kind,
        memberId: m.id,
        sessionKey: q.sessionKey,
        projectId: q.projectId,
        taskId: q.taskId,
        directiveId: q.directiveId,
        questionId: q.questionId,
        priority: q.priority,
        urgent: q.urgent,
        ownerShared: q.ownerShared,
        messageId: q.messageId,
        // 검수 업무는 그 버전에 묶인 채로 — 그 사이 새 버전이 고정됐으면 다음 검수 요청에 섞이지 않고 지워진다 (REV-07·08)
        ...(q.reviewPinnedAt ? { reviewPinnedAt: q.reviewPinnedAt } : {}),
        ...(q.reportId ? { reportId: q.reportId } : {}),
        ...(q.pausedMemberId ? { pausedMemberId: q.pausedMemberId } : {}),
        // 알림 업무는 키를 이어 간다 — 같은 일을 다시 넣지 않고(alerts.alertMain), 화면의 reachesMain이 가장 최근 항목으로 본다 (리드 결정 S5-7)
        ...(q.alertKey ? { alertKey: q.alertKey } : {}),
        attachments: q.attachments,
        attempts: q.attempts + (o.crash ? 1 : 0),
        deliveries: (q.deliveries ?? 0) + (o.delivery ? 1 : 0),
        // 재시작으로 끊긴 횟수는 이어 간다 — 그 사이 끊긴 턴을 다시 넣어도 앱째 끝내는 업무의 재시작 상한이 처음부터 다시 세지 않게 (리드 결정 39)
        restarts: q.restarts ?? 0,
        message: `${requeueLead(extra)}\n\n(다시 전달) ${q.message}`,
      });
    }
  }

  /**
   * 비정상 종료형 끝(비정상 종료·응답 없음, CLI 안전 검사 거부)의 상한을 항목마다 본다 (리드 결정 30): 자기 attempts가 상한 아래인 항목은 attempts+1로 다시
   * 넣고, 상한에 닿은 항목만 버린다(버린 항목은 crashLimitReached가 알린다). 턴에 함께 실린 다른 업무(다시 전달한 남는 업무 등)의 횟수에 끌려 대표 명령이
   * 버려지지 않게. 버린 항목과, 실은 항목을 모두 버렸는지
   */
  private requeueBelowCrashLimit(l: LiveTurn, extra: string): { dropped: QueueEntry[]; all: boolean } {
    const ctx = this.ctx;
    const max = ctx.settings().execution.crashRetryMax;
    const carried = l.entryIds.map((id) => ctx.store.queue.get(id)).filter((q): q is QueueEntry => !!q);
    const below = carried.filter((q) => q.attempts < max);
    if (below.length) this.requeue(l, extra, { crash: true, entries: below });
    const dropped = carried.filter((q) => q.attempts >= max);
    return { dropped, all: dropped.length === carried.length };
  }

  /**
   * 비정상 종료형 끝의 상한에 닿아 버린 항목을 알린다 (리드 결정 30): '자동 복구 실패' 긴급 알림 — 버린 업무와, 그 가운데 메인 에이전트에게 전하지 못한 대표
   * 명령·답변·수정 요청(프로젝트와 글 앞부분 또는 보고서 ID). '반복됩니다'는 버린 항목이 모두 정말 그렇게 두 번 이상 끝났을 때만 쓴다. 그리고 버린 일마다
   * 이어 갈 쪽을 정한다: 검수 요청을 잃은 검수 → 프로듀서 검수자 재배정, 재배정 업무 → 메인 에이전트, 남는 업무 → 대표 알림
   */
  private crashLimitReached(l: LiveTurn, d: { dropped: QueueEntry[]; all: boolean }, why: string, reviewTask: Task | null): void {
    const max = this.ctx.settings().execution.crashRetryMax;
    const repeated = d.dropped.every((q) => q.attempts > 0);
    const what = d.all ? l.label : [...new Set(d.dropped.map(workLabel))].join(', ');
    const how = repeated ? `${why}${subjectJosa(why)} 반복됩니다` : `${why}${instrumentalJosa(why)} 끝났습니다 — 자동 재시도가 ${max}회로 정해져 있어 다시 시도하지 않습니다`;
    const ended = `${why}${instrumentalJosa(why)} ${repeated ? '반복해서 ' : ''}끝`;
    // 버린 화면 확인 업무는 답하지 않은 것으로 본다 (리드 결정 S6-10 '상한에서 버리면 failed')
    this.core.desktop.checkDropped(d.dropped, `확인 턴이 ${ended}남`);
    this.dropAnnounced(l, d.dropped, what, how, { review: `검수 턴이 ${ended}났습니다`, producer: `프로듀서 턴이 ${ended}났습니다`, lost: `${ended}나` }, reviewTask, 'crash');
  }

  /**
   * 재시작으로 끊긴 횟수의 상한에 닿아 재시작 복구가 버린 항목을 알린다 (리드 결정 39) — 그 업무의 턴이 앱째 끝내면 재시작마다 다시 넣어 끝없이 돌기 때문이다.
   * 비정상 종료형 끝의 상한과 같게 알리고 이어 갈 쪽을 정한다(dropAnnounced, 리드 결정 36의 알림 key·활동 기록 포함). 알림은 프로그램이 그 업무를 처리하던
   * 중에 다시 시작됐다고 말한다. 재시작 복구(recovery.settleCutTurnEntries)가 그 턴의 마감과 한 트랜잭션으로 부른다
   */
  restartLimitReached(t: Turn, dropped: readonly QueueEntry[]): void {
    const ctx = this.ctx;
    if (!dropped.length) return;
    const sessionKey = dropped[0]!.sessionKey;
    const what = [...new Set(dropped.map(workLabel))].join(', ');
    const how = `이 업무를 처리하던 중에 프로그램이 ${RESTART_CUT_LIMIT}번 다시 시작돼(앱이 갑자기 꺼지거나 PC가 다시 켜지는 등) 더는 자동으로 다시 시도하지 않습니다`;
    noteMessagesUndelivered(ctx, dropped, `프로그램이 그 업무를 처리하던 중에 ${RESTART_CUT_LIMIT}번 다시 시작돼 그 업무를 멈춤`);
    ctx.activity({
      kind: 'system',
      level: 'warn',
      projectId: t.projectId,
      memberId: t.memberId,
      turnId: t.id,
      text: `재시작 복구: ${what} — 처리하던 중에 프로그램이 ${RESTART_CUT_LIMIT}번 다시 시작돼 다시 넣지 않음 (${sessionKey})`,
    });
    const task = t.sessionKind === 'review' && t.taskId ? ctx.store.tasks.get(t.taskId) : null;
    const reviewTask = task?.state === 'in_review' && !task.review.passed ? task : null;
    const ref: TurnRef = { memberId: t.memberId, sessionKey, sessionKind: t.sessionKind, directiveId: t.directiveId, projectId: t.projectId, entryIds: dropped.map((q) => q.id) };
    const cut = `프로그램 재시작으로 ${RESTART_CUT_LIMIT}번 끊`;
    this.core.desktop.checkDropped(dropped, `확인 턴이 ${cut}김`);
    this.dropAnnounced(ref, dropped, what, how, { review: `검수 턴이 ${cut}겼습니다`, producer: `프로듀서 턴이 ${cut}겼습니다`, lost: `${cut}겨` }, reviewTask, 'restart');
  }

  /**
   * 작업 세션의 일이 재시작으로 RESTART_CUT_LIMIT번째 끊겼다 (리드 결정 44) — 재시작 3)의 '이어서 진행'이 끊긴 횟수를 이어 가므로 그 작업의 턴이 앱째 끝내면
   * 여기 닿는다. 이어서 진행하지 않고 작업을 보류(오류)하고 알린다: 작업 턴의 비정상 종료 상한과 같은 보류·'자동 복구 실패' 알림(key crash:<작업>)이다.
   * 이 보류는 메인 에이전트에게 알림 업무로 간다(alert crash:<작업>, 리드 결정 S5-8) — 보류한 뒤 넘기고, 대표 알림은 넘긴 사실을 쓴다(넘기지 못했으면 결정 32의 문장).
   * 이미 보류·종료된 작업은 건드리지 않는다. 재시작 복구(recovery.settleCutTurnEntries)가 그 턴의 마감과 한 트랜잭션으로 부른다
   */
  restartLimitHold(t: Turn, task: Task): void {
    const ctx = this.ctx;
    if (isTerminal(task.state) || task.state === 'on_hold') return;
    this.core.tasks.hold(task.id, 'error', 'task', `작업하던 중에 프로그램이 ${RESTART_CUT_LIMIT}번 다시 시작돼 자동으로 이어 가지 않음`, 'system');
    const handed = alertTaskHold(ctx, 'crash', task.id, { cause: `작업하던 중에 프로그램이 ${RESTART_CUT_LIMIT}번 다시 시작돼 보류됨 (재시작 상한)` });
    ctx.activity({
      kind: 'system',
      level: 'warn',
      projectId: task.projectId,
      memberId: t.memberId,
      taskId: task.id,
      turnId: t.id,
      text: `재시작 복구: ${task.id} 작업 — 작업하던 중에 프로그램이 ${RESTART_CUT_LIMIT}번 다시 시작돼 이어서 진행하지 않고 보류함`,
    });
    ctx.notify({
      level: 'urgent',
      title: '자동 복구 실패',
      body: `${task.id} ${task.title} — 이 작업을 하던 중에 프로그램이 ${RESTART_CUT_LIMIT}번 다시 시작돼(앱이 갑자기 꺼지거나 PC가 다시 켜지는 등) 작업을 보류${handed ? `하고 ${OWNER_HANDED}` : `했습니다. ${ownerExit(false)}`}`,
      link: { tab: 'projects', projectId: task.projectId, taskId: task.id },
      key: `crash:${task.id}`,
    });
  }

  /**
   * 다시 넣지 않고 버린 항목을 알리고 이어 갈 쪽을 정한다 — 비정상 종료형 끝의 상한(crashLimitReached)과 재시작으로 끊긴 횟수의 상한(restartLimitReached)이
   * 함께 쓴다. '자동 복구 실패' 긴급 알림에 버린 업무(what)와 까닭(how), 그 가운데 메인 에이전트에게 전하지 못한 대표 명령·답변·수정 요청을 적는다. 대표 요청을
   * 버렸으면 그 버림만의 알림이고(dropNoticeKey — 같은 세션의 다음 버림이 덮지 않아 새 알림·OS 알림이 뜬다) 대표 요청마다 활동 기록을 남긴다 (리드 결정 36).
   * 버린 보류 넘김(정지 해제 목록·검수자 없음)과 알림 업무(alert)도 같다 — 아직 그 보류인 작업을 ID와 제목으로 적고 결정 32의 문장으로 끝내며, 그 항목은 취소로
   * 둔다 (리드 결정 43). 비정상 종료 상한(by 'crash')에서 버린 보류 넘김은 메인에게 한 번 더 넘기고 그렇다고 적는다. 재시작 상한(by 'restart')에서는 메인 세션 일을
   * 넘기지 않고, 팀원 업무(프로듀서 답변·최종 결과·병합 판단·계획·재계획·검수)는 메인에게 한 번 넘긴다 — 넘겼으면 끝 문장이 그 사실이다 (리드 결정 44·S5-8).
   * 그리고 버린 일마다 이어 갈 쪽을 정한다: 검수 요청을 잃은 검수 → 프로듀서 검수자 재배정, 재배정 업무 → 메인 에이전트, 남는 업무 → 대표 알림.
   * 대표 요청도 보류 넘김도 적지 않는 버림은 결정 32의 문장으로 끝낸다 — 버린 업무는 메인 에이전트에게 다시 가지 않으니 대표가 명령창으로 알리는 길을 적는다
   * (적으면 그 문장이 이미 길을 적는다, 리드 결정 45)
   */
  private dropAnnounced(
    ref: TurnRef,
    dropped: readonly QueueEntry[],
    what: string,
    how: string,
    after: { review: string; producer: string; lost: string },
    reviewTask: Task | null,
    by: 'crash' | 'restart',
  ): void {
    const ctx = this.ctx;
    const live = dropped.filter((q) => !deadWorkReason(ctx, q, this.reviewBusy));
    // 상한에서 버린 알림 업무가 더 새 대기 항목에 밀려 끝난 일이면(알리지 않는다) 그 보류가 아직 남았을 때 그 글을 더 새 항목에 옮겨 싣는다 — 다시 넣기·재시작
    // 복구가 버릴 때와 같다 (리드 결정 S5-44 2)
    for (const q of dropped) if (q.kind === 'alert' && !live.includes(q)) carrySupersededAlert(ctx, q);
    const owner = ownerRequests(ctx, live);
    const held = heldHandOvers(ctx, live);
    // 버린 보류 넘김은 비정상 종료 상한에서만 한 번 더 메인에게 넘긴다 — 재시작 상한에서 버린 메인 세션 일은 넘기지 않는다(앱째 끝낸 턴이 다시 도는 고리, 리드 결정
    // 44·S5-8). 재시작 상한에서 버린 팀원 업무(프로듀서 답변·최종 결과·병합 판단·검수 등)는 메인에게 한 번 넘긴다. 알림보다 먼저 넣는다
    if (by === 'crash') this.reAlertHandOvers(held, after.lost);
    const handed = by === 'restart' && ref.memberId !== MAIN_AGENT_ID ? this.restartDropsToMain(live) : 0;
    const lost = lostText(owner, held);
    const projectId = ref.projectId ?? dropped.find((q) => q.projectId)?.projectId ?? null;
    ctx.notify({
      level: 'urgent',
      title: '자동 복구 실패',
      body: `${what} — ${how}${lost ? `. ${lost}` : handed ? `. 그 일을 ${OWNER_HANDED}` : `. ${ownerExit(false)}`}`,
      link: projectId ? { tab: 'projects', projectId, memberId: ref.memberId } : null,
      key: dropNoticeKey('crash', ref.sessionKey, owner, held),
    });
    noteOwnerRequestsLost(ctx, owner, how);
    noteHeldHandOversLost(ctx, held, how);
    // 판정 없이 재시도를 다 쓴 검수(검수 요청을 다시 넣지 못함) → 알림만 하지 않고 프로듀서가 다른 검수자를 정하게 (F6, 8장 자동 복구 실패 → 개입)
    if (reviewTask && !this.core.tasks.reviewPending(reviewTask.id)) this.escalateReview(reviewTask, after.review);
    // 검수자 재배정 업무를 실은 프로듀서 턴이 그 업무의 재시도를 다 썼다 — 그 업무는 다시 넣지 않으므로 멈춘 검수를 메인 에이전트에게 넘긴다 (리드 결정 11·18)
    this.handOffStuckReviews(ref, after.producer, dropped);
    // 메인 업무는 버리고 알리는 것이 설계지만, 대상이 풀릴 때까지 남는 업무(멈춘 검수 넘김·팀원 재개)는 그 작업·팀원을 대표에게 알린다 (리드 결정 24)
    this.standingLost(ref, after.lost, dropped);
  }

  /**
   * 상한에서 버린 보류 넘김(정지 해제 목록·검수자 없음)을 메인에게 한 번 더 넘긴다 (alert handover-dropped:<버린 항목>, 리드 결정 S5-8·43) — 비정상 종료·시작 실패·
   * 헛돌기로 버렸을 때만 부른다(재시작 상한은 넘기지 않는다). 버린 알림 업무는 다시 넘기지 않는다 — 대표 알림이 그 일의 끝이다. 넘긴 것은 again으로 표시해
   * 대표 알림이 '다시 넘긴 보류 작업'으로 쓴다(heldHandOversText). how: 버린 끝의 모양('비정상 종료로 반복해서 끝나' 등)
   */
  private reAlertHandOvers(held: HeldHandOver[], how: string): void {
    for (const h of held) {
      if (h.q.kind !== 'stop_released' && h.q.kind !== 'no_reviewer') continue;
      const one = h.tasks.length === 1 ? h.tasks[0]! : null;
      const e = alertMain(this.ctx, {
        kind: 'handover-dropped',
        target: h.q.id,
        projectId: h.q.projectId,
        taskId: one?.id ?? null,
        directiveId: one?.directiveId ?? null,
        message: handOverDroppedText(h.q, h.tasks, how),
        since: h.q.createdAt,
      });
      if (e) h.again = true;
    }
  }

  /**
   * 재시작 상한에서 버린 팀원 업무를 메인에게 한 번 넘긴다 (alert restart-dropped:<버린 항목>, 리드 결정 S5-8·44) — 프로듀서의 답변·최종 결과·병합 판단·계획·
   * 재계획과 검수. 시작 때 다시 만들지 않는 일이라(restartDropped) 넘기지 않으면 아무에게도 가지 않는다. 대상이 이미 풀린 것은 넘기지 않는다. 넘긴 수
   */
  private restartDropsToMain(live: readonly QueueEntry[]): number {
    const ctx = this.ctx;
    let n = 0;
    for (const q of live) {
      if (q.memberId === MAIN_AGENT_ID || !RESTART_ALERT_KINDS.has(q.kind)) continue;
      const probe = { ...q, kind: 'alert' as const, alertKey: `alert:restart-dropped:${q.id}` };
      if (alertEnded(ctx, probe)) continue;
      const e = alertMain(ctx, { kind: 'restart-dropped', target: q.id, projectId: q.projectId, taskId: q.taskId, directiveId: q.directiveId, message: restartDroppedText(ctx, q), since: q.createdAt });
      if (e) n++;
    }
    return n;
  }

  private async judge(l: LiveTurn, reason: TurnEndReason, x: { code: number | null; spawnError?: string }): Promise<void> {
    const ctx = this.ctx;
    const settings = ctx.settings().execution;
    const task = l.taskId ? ctx.store.tasks.get(l.taskId) : null;
    const taskSession = l.sessionKind === 'task';
    // 검수 세션: 판정은 submit_review 때 이미 저장됐으므로 턴이 어떻게 끝났든 다음 단계로 이어 간다 (F6).
    // 작업이 보류됐으면(중단·취소·긴급 정지·프로젝트 정지) 손대지 않는다 — 보류 해제(afterRelease)가 이어 간다
    const reviewTask = l.sessionKind === 'review' && task?.state === 'in_review' ? task : null;
    // 통과 뒤 대표 메시지로 미룬 '다시 판정' 턴이 판정 기회 없이 끝났으면 미룸을 풀지 않고 다시 넣는다 (rejudgeCut, S7-B3) — 그 밖에는 정해진 다음 단계로
    const settled = (): boolean => !!reviewTask && (this.rejudgeCut(l, reviewTask, reason) || this.settleReview(l, reviewTask));

    if (reason === 'user_stop') {
      if (settled()) return;
      // 작업 세션은 보류 해제(afterRelease) 때 이어서 진행한다. 관리 업무와, 작업이 보류되지 않은 채(검수자 정지) 멈춘
      // 아직 판정 전인 검수는 잃지 않게 다시 넣는다 — 정지가 풀리면 실행된다
      if ((!taskSession && l.sessionKind !== 'review') || reviewTask) this.requeue(l, '정지로 중단된 업무입니다. 이어서 처리하세요.');
      return;
    }

    // 외부 보유자의 턴에는 AI 종류의 가용성(재로그인·사용량 한도·CLI 문제)이 없다 — 그 자리는 임대가 정한다. 넘기지 못한 턴(턴 기록 뒤 실패)은 막지 않고 다시 넣는다
    // (리드 결정 S7-4). 이 갈래 밖의 끝(비정상 종료·시간 상한·정상)은 CLI 턴과 같은 판정이다
    const cliKind: AiKind | null = l.aiKind === 'external' ? null : l.aiKind;
    if (cliKind === null && (reason === 'bypass_mismatch' || reason === 'auth_required' || reason === 'spawn_failed' || reason === 'usage_limit')) {
      if (settled()) return;
      this.requeue(l, '이전 턴을 외부 에이전트에게 넘기지 못했습니다. 이어서 처리하세요.');
      return;
    }

    if (cliKind && (reason === 'bypass_mismatch' || reason === 'auth_required' || reason === 'spawn_failed')) {
      const ai = ctx.ai(cliKind);
      // 실행 파일을 찾지·쓰지 못함 → AI 종류 단위 문제 (CLI-15). 막아 두면 그 종류의 업무는 다시 확인할 때까지 대기열에 남는다
      const cliGone = !l.mock && reason === 'spawn_failed' && (l.flags.spawnCliUnavailable || /ENOENT|not found|찾을 수 없/i.test(x.spawnError ?? ''));
      // 턴 기록 뒤 프로세스 전 실패 중 이 업무만의 문제(모델 이름·작업 폴더·첨부·노력치·비밀 값) → 시작 시도로 센다 (ERR-04, F1, CONC-01)
      const startFailure = reason === 'spawn_failed' && !l.proc && !cliGone;
      // 바이패스를 확인한 뒤의 개별 명령 거부(CLI 내장 안전 검사)는 설정 문제가 아니다 → AI 종류 전체를 막지 않는다 (windows:F8)
      const perCall = reason === 'bypass_mismatch' && !l.flags.bypassConfig;
      if (!l.mock) {
        if (reason === 'bypass_mismatch' && !perCall) ctx.saveAi({ ...ai, cliProblem: `바이패스 설정 불일치: ${l.flags.bypassMismatch}` });
        if (reason === 'auth_required') ctx.saveAi({ ...ai, authRequired: true, authRequiredSince: ctx.now() });
        if (cliGone) ctx.saveAi({ ...ai, cliInstalled: false, cliProblem: x.spawnError ?? null });
      }
      const title = reason === 'bypass_mismatch' ? (perCall ? 'CLI 안전 검사 거부' : '바이패스 설정 불일치') : reason === 'auth_required' ? `${l.aiKind} 재로그인 필요` : 'CLI 실행 실패';
      // 작업 세션의 바이패스 불일치(개별 명령 거부·설정 문제)는 작업을 보류하고 메인 에이전트에게 알림 업무로 넘긴다(alert cli-refusal·bypass:<작업>) — 알림보다
      // 먼저 보류하고 넘겨, 알림이 보류했다는 것과 넘긴 사실을 말한다(넘기지 못했으면 결정 32의 문장). 개별 명령 거부는 설정 문제가 아니다 — 보류 사유도 그
      // 까닭으로 적는다. 작업 세션 밖은 글을 그대로 둔다: 설정 문제의 출구는 설치 설정이다 (리드 결정 32·48·S5-7·S5-9)
      const holdTask = reason === 'bypass_mismatch' && task && taskSession && !isTerminal(task.state) ? task : null;
      const mismatch = holdTask ? (l.flags.bypassMismatch ?? '').replace(/\.\s*$/, '') : (l.flags.bypassMismatch ?? '');
      let handedHold: QueueEntry | null = null;
      if (holdTask) {
        this.core.tasks.hold(holdTask.id, 'error', 'task', `${perCall ? 'CLI 안전 검사가 명령을 거부함' : '바이패스 설정 불일치'}: ${l.flags.bypassMismatch}`, 'system');
        handedHold = alertTaskHold(ctx, perCall ? 'cli-refusal' : 'bypass', holdTask.id, {
          cause: perCall ? 'CLI 안전 검사가 명령을 거부해 작업 턴이 끝나 보류됨' : '바이패스 설정 불일치로 작업 턴이 끝나 보류됨',
          // 거부된 명령을 낸 그 작업 턴의 팀원 — 출구가 ID로 적는다 (리드 결정 S5-28)
          member: { id: l.memberId, review: false },
        });
      }
      const heldNote = holdTask ? (handedHold ? `. 작업을 보류하고 ${OWNER_HANDED}` : `. 작업을 보류했습니다. ${ownerExit(false)}`) : '';
      if (perCall) {
        ctx.notify({
          level: 'urgent',
          title,
          body: `${l.label}: CLI 안전 검사가 명령을 거부해 턴을 끝냈습니다 — ${mismatch}${heldNote}`,
          link: l.projectId ? { tab: 'projects', projectId: l.projectId, memberId: l.memberId, taskId: l.taskId ?? undefined } : null,
          key: `bypass-denied:${l.sessionKey}`,
        });
      } else if (!startFailure) {
        ctx.notify({
          level: 'urgent',
          title,
          body: `${l.label}: ${l.flags.bypassMismatch != null ? mismatch : (l.flags.auth ?? x.spawnError ?? '')}${heldNote}`,
          link: { tab: 'settings', section: 'account' },
          key: `ai-problem:${l.aiKind}:${reason}`,
        });
      }
      // 검수를 통과한 작업의 검수 턴(대표 메시지로 미룬 다시 판정 등)이 프로세스 전에 실패했다: 마무리(settleReview)가 미룸 때문에 같은 업무를 새로 넣어
      // 시작 실패로 세지 못한 채 틱마다 다시 띄웠다 — 먼저 시작 시도로 센다. 상한이면 보류(오류)·'업무 시작 실패' 알림. 미룸이 남았으면 되돌아온 항목이
      // 센 횟수 그대로 기다린다(마무리하면 검수 항목이 새로 들어가 횟수가 지워진다). 아니면 정해진 다음 단계로 (ERR-04, CONC-01, S8-B4)
      if (startFailure && reviewTask?.review.passed) {
        if (this.recordStartFailure(l, x.spawnError ?? '') || this.core.tasks.mergeDeferredForReviewer(reviewTask)) return;
        this.settleReview(l, reviewTask);
        return;
      }
      if (settled()) return;
      // 시작 실패: finish()가 항목을 대기열로 되돌렸다 → 시도 횟수를 올리고 상한이면 멈춘다 (그 사이 await 없음)
      if (startFailure) {
        this.recordStartFailure(l, x.spawnError ?? '');
        return;
      }
      if (perCall) {
        // AI 종류를 막지 않으므로 다시 시도에 상한을 둔다 — 비정상 종료형 끝이라 항목마다 그 항목의 횟수로 본다 (리드 결정 30). 작업 세션은 위 보류가
        // 멈춘다 (재개 때 아래 안내와 함께 전달). 상한에 닿은 항목은 버리고 알린다: 검수 → 재배정, 재배정 업무 → 메인 에이전트, 남는 업무 → 대표 (리드 결정 18·24)
        const again = `CLI 안전 검사가 명령을 거부해 이전 턴이 끝났습니다: ${l.flags.bypassMismatch ?? ''}. 같은 명령을 되풀이하지 말고 리터럴 경로나 \${VAR:?} 가드를 쓰세요.`;
        if (taskSession) {
          this.requeue(l, again, { crash: true });
          return;
        }
        const d = this.requeueBelowCrashLimit(l, again);
        if (d.dropped.length) this.crashLimitReached(l, d, 'CLI 안전 검사 거부', reviewTask);
        return;
      }
      // 재로그인 필요·바이패스 설정 불일치·실행 파일 없음: AI 종류를 막았으므로 풀릴 때까지 기다린다 — 비정상 종료 횟수로 세지 않는다 (리드 결정 30)
      this.requeue(l, `이전 턴이 끝나지 못했습니다 (${title}).`);
      return;
    }
    if (cliKind && reason === 'usage_limit') {
      // 모델별 주간 한도(Claude Opus·Sonnet·Fable 주간 한도, @core/usageLimits modelLimitFamily)는 그 모델 계열의 턴만 막는다 — 다른 모델로 도는 메인 에이전트·팀원은 계속 돈다.
      // 이 턴의 모델이 그 계열이 아니면(드묾) 종류 전체로 건다 — 같은 턴을 되풀이해 띄우지 않게 (리드 결정 22)
      const family = l.aiKind === 'claude' ? modelLimitFamily(l.flags.usageLimit?.rateLimitType) : null;
      const scoped = !l.mock && !!family && modelInFamily(l.model, family);
      const until = l.flags.usageLimit?.resetAt ?? new Date(ctx.clock.ms() + RESET_FALLBACK_MS).toISOString();
      if (!l.mock) {
        const ai = ctx.ai(cliKind);
        if (scoped) ctx.saveAi({ ...ai, modelUsageLimits: { ...ai.modelUsageLimits, [family!]: until } });
        else ctx.saveAi({ ...ai, usageLimitedUntil: until });
      } else {
        // 모의 실행: 시나리오 재현만 하고 잠깐 뒤 재개
        const ai = ctx.ai(cliKind);
        ctx.saveAi({ ...ai, usageLimitedUntil: new Date(ctx.clock.ms() + 2000).toISOString() });
      }
      const message = l.flags.usageLimit?.message ?? '';
      // 메인 에이전트도 그 모델로 쉴 때의 출구는 읽는 대표에게 있는 것만 쓴다 (리드 결정 S4-20): 데스크톱은 대표가 이 PC의 운영자라 설치 설정의 메인 AI 모델,
      // 서버는 메인 AI가 운영자 몫이다 — 쉬는 메인은 턴이 뜨지 않아 hand_off_seat도 못 하므로 명령은 쌓였다가 처리되고, 그 전에 바꾸는 것은 운영자의 seat assign
      const mainExit =
        ctx.deps.mode === 'server'
          ? '메인 에이전트도 이 모델로 쉬고 있다면 보낸 명령은 쌓였다가 한도가 풀리면 처리됩니다. 그 전에 메인 자리를 다른 AI에게 넘기는 것은 서버 PC의 운영자가 합니다(wook-server seat assign).'
          : '메인 에이전트도 쉬고 있다면 설치 설정에서 메인 AI 모델을 다른 모델로 정하면 바로 이어서 일합니다.';
      ctx.notify(
        scoped
          ? {
              level: 'normal',
              title: `${MODEL_FAMILY_LABEL[family!]} 주간 한도`,
              body: `${l.aiKind}: ${message} — 한도가 풀릴 때까지 ${MODEL_FAMILY_LABEL[family!]} 모델의 턴만 쉽니다(모델을 정하지 않은 팀원도 포함). 다른 모델의 턴은 그대로 실행됩니다. ${mainExit}`,
              link: { tab: 'settings', section: 'account' },
              key: `usage:${l.aiKind}:${family}`,
            }
          : {
              level: 'normal',
              title: '사용량 한도',
              body: `${l.aiKind}: ${message}${l.mock ? '' : ' — 한도가 풀리면 저절로 이어 갑니다. 그때까지 기다리기 어렵다면 설치 설정에서 결제 방식(AI 인증 방식)을 바꾸거나, API 키 방식이면 키를 새로 등록하세요. 그러면 한 번 다시 시도합니다.'}`,
              link: { tab: 'settings', section: 'account' },
              key: `usage:${l.aiKind}`,
            },
      );
      if (settled()) return;
      this.requeue(l, '사용량 한도로 이전 턴이 중단됐습니다. 이어서 진행하세요.');
      return;
    }
    if (l.flags.resumeFailed) {
      this.closeSessions(l.sessionKey, '이어하기 실패 → 새 세션 (ERR-03)');
      if (settled()) return;
      this.requeue(l, '이전 세션을 이어갈 수 없어 새 세션에서 인계받아 진행합니다.');
      return;
    }
    if (reason === 'crashed' || reason === 'no_response') {
      const why = reason === 'crashed' ? '비정상 종료' : '응답 없음';
      const ro = instrumentalJosa(why);
      if (taskSession && task && !isTerminal(task.state)) {
        if (task.state === 'on_hold') return;
        if (task.crashRetries < settings.crashRetryMax) {
          ctx.store.tasks.patch(task.id, { crashRetries: task.crashRetries + 1 });
          if (task.pendingSubmit) return void (await this.core.tasks.processSubmission(task.id));
          this.requeue(l, `이전 턴이 ${why}${ro} 끝났습니다 (자동 재개 ${task.crashRetries + 1}/${settings.crashRetryMax}). get_work_context로 상태를 확인하고 이어서 진행하세요.`, { crash: true });
          return;
        }
        this.core.tasks.hold(task.id, 'error', 'task', `${why} 자동 복구 ${settings.crashRetryMax}회 실패`, 'system');
        // 이 보류는 메인 에이전트에게 알림 업무로 간다(alert crash:<작업>) — 보류한 뒤 넘기고, 대표 알림은 넘긴 사실을 쓴다 (리드 결정 40·S5-7·S5-9)
        const handed = alertTaskHold(ctx, 'crash', task.id, { cause: `작업 턴이 ${why}${ro} ${settings.crashRetryMax + 1}번 끝나 보류됨 (비정상 종료 상한)` });
        ctx.notify({
          level: 'urgent',
          title: '자동 복구 실패',
          body: `${task.id} ${task.title} — ${why} 재시작 ${settings.crashRetryMax}회 실패로 작업을 보류${handed ? `하고 ${OWNER_HANDED}` : `했습니다. ${ownerExit(false)}`}`,
          link: { tab: 'projects', projectId: task.projectId, taskId: task.id },
          key: `crash:${task.id}`,
        });
        return;
      }
      if (settled()) return;
      // 상한은 항목마다 그 항목의 횟수로 본다 — 함께 실린 다른 업무(다시 전달한 남는 업무 등)의 횟수에 끌려 대표 명령·수정 요청이 한 번 끊긴 것으로 버려지지
      // 않게. 상한 아래인 항목은 다시 넣고, 닿은 항목만 버리고 알린다 (리드 결정 30)
      const d = this.requeueBelowCrashLimit(l, `이전 턴이 ${why}${ro} 끝났습니다. 이어서 처리하세요.`);
      if (d.dropped.length) this.crashLimitReached(l, d, why, reviewTask);
      return;
    }
    if (reason === 'spin') {
      if (taskSession && task && !isTerminal(task.state)) return this.spinHold(task, `헛돌기: ${l.stop?.reason ?? ''}`);
      if (settled()) return;
      // 헛돌기로 끝난 턴은 실은 업무를 다시 넣지 않는다 — 버린 대표 요청과 보류 넘김(정지 해제 목록·검수자 없음)은 그 버림만의 알림 key로 알리고 활동
      // 기록을 남긴다 (리드 결정 30·36·43). 둘 다 없으면 결정 32의 문장으로 끝낸다 — 버린 업무는 다시 가지 않는다 (리드 결정 45)
      const spinLive = l.entryIds.map((id) => ctx.store.queue.get(id)).filter((q): q is QueueEntry => !!q && !deadWorkReason(ctx, q, this.reviewBusy));
      this.core.desktop.checkDropped(spinLive, '확인 턴이 헛돌아 끝남');
      const spinOwner = ownerRequests(ctx, spinLive);
      const spinHeld = heldHandOvers(ctx, spinLive);
      this.reAlertHandOvers(spinHeld, '헛돌아');
      const spinLost = lostText(spinOwner, spinHeld);
      ctx.notify({
        level: 'normal',
        title: '헛돌기',
        body: `${l.label} — 같은 오류가 반복됐습니다${spinLost ? `. ${spinLost}` : `. ${ownerExit(false)}`}`,
        key: dropNoticeKey('spin', l.sessionKey, spinOwner, spinHeld),
      });
      noteOwnerRequestsLost(ctx, spinOwner, '메인 에이전트의 턴이 같은 오류를 되풀이하는 헛돌기로 끝남');
      noteHeldHandOversLost(ctx, spinHeld, '메인 에이전트의 턴이 같은 오류를 되풀이하는 헛돌기로 끝남');
      if (reviewTask) this.escalateReview(reviewTask, `검수 턴이 헛돌았습니다 (${l.stop?.reason ?? '같은 오류 반복'})`);
      this.handOffStuckReviews(l, '프로듀서 턴이 헛돌았습니다');
      this.standingLost(l, '헛돌아');
      return;
    }

    // 시간 상한으로 끊긴 다시 판정 턴도 정상으로 마친 것이 아니다 — 미룸을 풀지 않고 다시 넣는다 (S7-B3)
    if (reason === 'timeout' && reviewTask && this.rejudgeCut(l, reviewTask, reason)) return;
    // 정상 종료·시간 상한: 세션 종류별 판정
    switch (l.sessionKind) {
      case 'task':
        return this.judgeTask(l, reason);
      case 'review':
        return this.judgeReview(l);
      case 'directive':
        return this.judgeDirective(l);
      case 'main_project':
      case 'main_general':
        return this.judgeMain(l);
    }
  }

  /**
   * 헛돌기 보류 (8장): 작업 보류(재계획) → 프로듀서가 방법 변경·재계획·재배정. 병합 충돌을 풀지 못해 헛돈 작업이면 GIT-07 순서를 따른다 —
   * 프로듀서가 해결 업무를 맡거나(자기에게 재배정하면 그 작업 폴더에서 해결, CLI-03) 다른 팀원에게 넘긴다. 프로듀서가 손댄 뒤에도
   * (프로듀서가 맡았거나, 같은 충돌로 두 번째 헛돌기) 풀리지 않으면 대표에게 보고한다 (긴급, GIT-07 '그래도 안 되면 대표에게 보고',
   * 8장 '프로듀서가 해결 못 하면 긴급')
   */
  spinHold(task: Task, note: string): void {
    const ctx = this.ctx;
    const producer = producerOf(ctx, task.projectId);
    const conflict = ctx.store.tasks.get(task.id)?.conflict ?? task.conflict;
    // 이번 보류를 기록하기 전에: 같은 충돌(같은 파일, 그 사이 받아들인 해결 커밋 없음)로 이미 헛돌기 보류된 적이 있는지 — 충돌 기록의 헛돌기 횟수.
    // 같은 충돌이 다시 기록돼도(병합 취소 뒤 다시 반영 등) 횟수·since가 이어지므로 놓치지 않는다. 횟수가 없는 옛 기록은 전이 기록의 보류 사유로 본다
    const again =
      !!conflict &&
      ((conflict.spinHolds ?? 0) > 0 || ctx.store.transitions.list(task.id).some((x) => x.event === 'hold' && x.at >= conflict.since && x.reason.includes(CONFLICT_SPIN_NOTE)));
    ctx.store.tx(() => {
      this.core.tasks.hold(task.id, 'replan', 'task', conflict ? `${CONFLICT_SPIN_NOTE} — ${note}` : note, 'system', null, 'in_progress');
      const held = ctx.store.tasks.require(task.id).conflict;
      if (held) ctx.store.tasks.patch(task.id, { conflict: { ...held, spinHolds: (held.spinHolds ?? 0) + 1 } });
    });
    const assignee = ctx.store.members.get(task.assigneeId);
    const message = conflict
      ? [
          `${task.id} "${task.title}"의 병합 충돌(${conflict.files.join(', ')})을 담당 ${assignee?.name ?? task.assigneeId}(${task.assigneeId})이(가) 해결하지 못해 헛돌기로 보류됐습니다 (${note}, GIT-07).`,
          `프로듀서가 해결을 맡으려면 replan_task(task_id="${task.id}", assignee_id="${producer.id}")로 직접 맡으세요 — 그 작업 폴더에서 충돌 표시를 정리한 뒤 report_conflict_resolved를 호출합니다 (git 명령 없이).`,
          '다른 팀원에게 맡기려면 assignee_id를 그 팀원으로, 같은 담당에게 방법을 바꿔 다시 맡기려면 assignee_id 없이 note에 방법을 적어 replan_task를 호출하세요.',
        ].join('\n')
      : `${task.id} "${task.title}"이(가) 헛돌기로 보류됐습니다 (${note}). 방법 변경·재계획·재배정 중 하나로 replan_task를 호출하세요.`;
    enqueue(ctx, {
      kind: 'replan',
      memberId: producer.id,
      sessionKey: directiveKey(task.directiveId),
      projectId: task.projectId,
      taskId: task.id,
      directiveId: task.directiveId,
      priority: task.priority,
      message,
      dedupeKind: true,
    });
    if (conflict && (again || task.assigneeId === producer.id)) {
      // 프로듀서가 손댄 뒤에도 풀리지 않았다 — 메인 에이전트에게 알림 업무로 넘긴다(alert conflict-stuck:<작업>, 리드 결정 40·S5-8). 다음 조치(다른 팀원에게
      // 맡기기, 작업 취소 등)는 메인이 정한다. 넘기지 못했으면 결정 32의 문장
      const handed = alertTaskHold(ctx, 'conflict-stuck', task.id, {
        cause: `병합 충돌(${conflict.files.join(', ')})을 ${task.assigneeId === producer.id ? '프로듀서가 맡아서도' : '프로듀서가 다시 맡겼는데도'} 풀지 못해 헛돌기로 보류됨 (GIT-07)`,
      });
      ctx.notify({
        level: 'urgent',
        title: '병합 충돌 해결 실패',
        body: `${task.id} ${task.title} — 충돌 파일 ${conflict.files.join(', ')}을(를) ${task.assigneeId === producer.id ? '프로듀서가 맡아서도' : '프로듀서가 다시 맡겼는데도'} 해결하지 못했습니다. ${
          handed ? OWNER_HANDED : `다른 팀원에게 맡길지, 작업을 취소할지 등 어떻게 할지 ${OWNER_TELL_MAIN}`
        } (GIT-07)`,
        link: { tab: 'projects', projectId: task.projectId, taskId: task.id },
        key: `conflict-stuck:${task.id}`,
      });
    }
  }

  private async judgeTask(l: LiveTurn, reason: TurnEndReason): Promise<void> {
    const ctx = this.ctx;
    const settings = ctx.settings().execution;
    const task = l.taskId ? ctx.store.tasks.get(l.taskId) : null;
    if (!task || isTerminal(task.state) || task.state !== 'in_progress') return;
    const prefix = reason === 'timeout' ? `턴 시간 상한(${settings.turnTimeoutMin}분)으로 끊겼습니다. ` : '';
    // 질문·막힘 보고로 끝낸 턴은 진척 없는 재개(충돌이면 해결 못 한 해결 턴)로 세지 않는다 — 답변(또는 막힘 조치)이 다음 턴을 연다. 그 답이 턴이
    // 끝나기 전에(질문 뒤 창 안에) 와 작업이 진행으로 돌아왔으면 답이 이미 이 세션에 기다리므로 '이어서 진행' 재촉도 넣지 않는다. 답이 언제 오든
    // 같은 판정이다 (15.4, AC-37, 8장 헛돌기, S7-B4)
    const counted = !l.endedForQuestion;
    const answerWaiting = !counted && ctx.store.queue.list({ ref2: l.sessionKey, state: 'queued' }).some((q) => !q.ownerShared);
    if (task.conflict) {
      // 충돌이 열린 채 끝난 턴 = 받아들인 해결 커밋 없이 끝난 해결 턴이다 (보고가 없었거나, 병합을 취소한 뒤 보고해 받지 않음 등). 그 충돌 기록에
      // 센다 — 같은 충돌이 다시 기록돼도 이어진다. 상한(3번째)이면 헛돌기 → 프로듀서 (GIT-07, CLI-18, 8장 헛돌기). 일반 진척 없는 재개 수는
      // 건드리지 않는다: 제출 처리에서 생긴 충돌도 해결 턴을 처음부터 3번 받는다
      const turns = (task.conflict.unresolvedTurns ?? 0) + (counted ? 1 : 0);
      if (counted) {
        ctx.store.tasks.patch(task.id, { conflict: { ...task.conflict, unresolvedTurns: turns } });
        if (turns >= settings.spinNoProgressResumes) return this.spinHold(ctx.store.tasks.require(task.id), `진척 없는 자동 재개 ${turns}회`);
      }
      // 작업 폴더의 병합 상태는 남겨 둔 제출 요청의 처리가 맞춘다 — 병합이 진행 중이면 해결 업무를 다시 넣고, 취소돼 없으면 최신 main을 다시
      // 반영해 충돌 표시를 되살린다 (해결할 것이 없는 해결 턴을 띄우지 않게)
      if (task.pendingSubmit) return this.core.tasks.processSubmission(task.id);
      if (answerWaiting) return;
      this.core.tasks.continueWork(
        task.id,
        `${prefix}병합 충돌이 아직 해결되지 않았습니다 (해결 보고 없이 끝난 해결 턴 ${turns}/${settings.spinNoProgressResumes}).\n${conflictFixGuide(task.conflict.files, task.conflict.unverifiable, task.type === 'revert' ? task.revertOfTaskId : null)}`,
        'conflict_fix',
      );
      return;
    }
    if (task.pendingSubmit) return this.core.tasks.processSubmission(task.id);
    const progressed = l.stepsCompleted > 0;
    if (progressed || counted) {
      const noProg = progressed ? 0 : task.noProgressResumes + 1;
      ctx.store.tasks.patch(task.id, { noProgressResumes: noProg, ...(progressed ? { crashRetries: 0 } : {}) });
      if (noProg >= settings.spinNoProgressResumes) return this.spinHold(task, `진척 없는 자동 재개 ${noProg}회`);
    }
    if (answerWaiting) return;
    const steps = ctx.store.steps.list(task.id);
    const left = steps.filter((s) => !s.done);
    let msg: string;
    if (!steps.length) msg = `${prefix}아직 단계 목록이 없습니다. set_steps로 단계를 만들고 진행하세요.`;
    else if (left.length) msg = `${prefix}계속 진행하세요. 남은 단계 ${left.length}개: ${left.map((s) => `${s.idx}:${s.title}`).join(' / ')}`;
    else msg = `${prefix}모든 단계를 마쳤습니다. 완료 조건을 확인하고 submit_for_review를 호출하세요.`;
    this.core.tasks.continueWork(task.id, msg, 'task_work');
  }

  /**
   * 통과 뒤 그 검수자에게 온 대표 메시지로 병합 판단(산출물 확정)을 미룬 작업의 검수 턴이 판정 기회 없이 끝났다 — 정상 종료(completed)가 아닌 정지·비정상
   * 종료·응답 없음·사용량 한도·이어하기 실패·재로그인 필요·헛돌기·시간 상한. 검수자는 메시지를 보고 다시 판정하지 못했으므로 미룸을 풀지 않는다
   * (tasks.rejudgeWaitOf): 그 턴의 업무(대표 메시지·다시 판정 요청)를 '(다시 전달)'로 다시 넣고(정지는 시도로 세지 않음), crashRetryMax번 이어지면
   * 보류(오류)하고 대표에게 알린다 — 이전 통과를 말없이 병합·확정하지 않는다 (CTL-06, AC-36, CLI-10, ERR-04, S7-B3). 했으면 true.
   * 프로세스를 띄우기 전에 멈춘 턴은 업무가 이미 대기열로 돌아가(전달 안 됨) 미룸이 그대로다 — 시작 실패 처리에 맡긴다 (false)
   */
  private rejudgeCut(l: LiveTurn, task: Task, reason: TurnEndReason): boolean {
    const ctx = this.ctx;
    const wait = this.core.tasks.rejudgeWaitOf(task);
    if (!wait || wait.reviewerId !== l.memberId || !l.proc) return false;
    const why = l.flags.resumeFailed ? '이어하기 실패' : (REJUDGE_CUT_TEXT[reason] ?? reason);
    if (reason === 'user_stop') {
      this.requeue(l, '정지로 중단된 다시 판정 업무입니다. 긴급 지시를 확인하고 이어서 처리하세요.');
      return true;
    }
    // 다시 판정의 다시 전달은 끝난 모양과 상관없이 그 항목의 deliveries로 센다(그 상한이 이 미룸의 상한이다). 비정상 종료형 끝만 attempts도 올린다 (리드 결정 30)
    const max = ctx.settings().execution.crashRetryMax;
    const sent = Math.max(0, ...l.entryIds.map((id) => ctx.store.queue.get(id)?.deliveries ?? 0));
    if (sent >= max) {
      this.core.tasks.holdRejudgeStuck(task.id, why, sent + 1);
      return true;
    }
    // 이어하기 실패는 종료 코드가 비정상이어도 비정상 종료형이 아니다 (judge가 그 갈래로 부른다)
    const crash = !l.flags.resumeFailed && (reason === 'crashed' || reason === 'no_response' || (reason === 'bypass_mismatch' && !l.flags.bypassConfig));
    this.requeue(l, `이전 검수 턴이 ${why}${instrumentalJosa(why)} 끝나 긴급 지시를 보고 다시 판정하지 못했습니다 (다시 전달 ${sent + 1}/${max}). 긴급 지시를 확인하고 판정을 바꿀지 정하세요.`, {
      crash,
      delivery: true,
    });
    ctx.activity({
      kind: 'review',
      level: 'warn',
      actor: l.memberId,
      projectId: task.projectId,
      taskId: task.id,
      turnId: l.turnId,
      text: `${task.id} 다시 판정 턴이 ${why}${instrumentalJosa(why)} 끝나 긴급 지시와 다시 판정 요청을 다시 넣음 (${sent + 1}/${max}) — ${task.outputMode === 'artifact' ? '산출물 확정' : '병합 판단'}은 계속 미룸`,
    });
    return true;
  }

  /**
   * 검수 세션이 끝났을 때 이미 정해진 다음 단계 (턴이 어떻게 끝났든 같다). 했으면 true — 호출자는 다시 넣거나 재촉하지 않는다.
   * - 통과: 저장소 변경형이면 병합 판단 (남은 검수 항목은 쓸모없다). 산출물형은 통과 때 이미 확정을 시작했다
   * - 이 턴이 시작된 뒤 대상이 다시 고정됨(기준 변경·재제출): 이전 버전을 보던 턴 — 지금 버전 검수 등록만 맞춘다 (REV-07)
   * - 검수자가 바뀜(교체·삭제): 이 팀원 몫으로 다시 넣지 않고 지금 검수자에게 (CONC-11)
   */
  private settleReview(l: LiveTurn, task: Task): boolean {
    const ctx = this.ctx;
    const staleKey = `reviewstale:${task.id}`;
    const stale = launchedForOtherPin(l, task);
    if (!stale && ctx.store.kv.get<number>(staleKey)) ctx.store.kv.set(staleKey, 0);
    if (task.review.passed) {
      // 통과 뒤 그 검수자에게 온 대표 직접 메시지가 기다리면 병합 판단 등록·산출물 확정이 미루고 그 검수 세션의 다음 턴 맨 앞에 먼저 전달한다 — 검수자가
      // 메시지를 보고 다시 판정할 수 있다 (CTL-06, AC-36, tasks.holdForReviewerMessage). 그 턴이 다시 판정하지 않고 끝나면 여기로 다시 와서 등록한 통과로 이어 간다
      cancelQueued(ctx, (q) => q.sessionKey === reviewKey(task.id) && q.kind === 'review');
      if (task.outputMode === 'repo') this.core.merges.queueMergeDecision(task);
      // 산출물형은 통과 때 확정을 시작한다 — 대표 메시지로 미뤘던 확정(보류 해제·재시작 복구에서)은 여기서 이어 간다. 확정 쪽이 상태·대상을 다시 본다
      else if (!closedDirectiveWork(ctx, null, task)) this.core.merges.finalizeArtifactOrHold(task.id);
      return true;
    }
    // 지금 대상이 아닌 고정에 띄워진 턴: 이전 버전을 보던 턴이라 판정도 받지 않았다 (submitReview). 그 턴 몫으로 다시 넣거나 재촉·재배정하지 않고,
    // 지금 버전 검수가 검수자에게 등록돼 있는지만 맞춘다 (같은 항목은 겹쳐 만들지 않는다, REV-07). 같은 고정인지로 보므로 시계가 뒤로 맞춰져도
    // 바뀐 것이 없으면 여기 오지 않는다. 이런 턴이 이어지면(검수할 때마다 판정 전에 버전이 바뀜) 상한에서 프로듀서에게 넘긴다 (ERR-04 자동 재시도 상한)
    if (stale) {
      const n = (ctx.store.kv.get<number>(staleKey) ?? 0) + 1;
      const limit = ctx.settings().execution.spinNoProgressResumes;
      ctx.store.kv.set(staleKey, n >= limit ? 0 : n);
      this.core.tasks.dispatchReview(task);
      if (n >= limit) this.escalateReview(task, `검수 턴이 ${n}번 이어서 판정 전에 검수 대상 버전이 바뀌어 끝났습니다`);
      return true;
    }
    if (task.reviewerId !== l.memberId) {
      this.core.tasks.dispatchReview(task);
      return true;
    }
    return false;
  }

  /**
   * 검수가 등록되지 않은 채 재시도를 다 썼다 → 프로듀서가 검수자를 다시 정하게 (8장 자동 복구 실패 → 개입). 안내는 실제로 통하는 길만 말한다 (리드 결정 11):
   * 같은 검수자를 다시 정하면 검수를 다시 등록하고(changeReviewer), "main"은 메인 에이전트가 이 작업을 검수할 수 있을 때만 권한다.
   * 같은 검수자로 다시 등록한 검수가 또 이렇게 끝났으면 프로듀서에게 같은 검수자를 다시 권하지 않고 메인 에이전트에게 넘긴다 — 프로듀서가 안내대로 같은
   * 검수자를 고르기를 끝없이 되풀이하지 않게 (리드 결정 17)
   */
  private escalateReview(task: Task, why: string): void {
    const ctx = this.ctx;
    const producer = producerOf(ctx, task.projectId);
    const again = this.core.tasks.sameReviewerRedispatches(task);
    if (again > 0) {
      this.handReviewToMain(task, task.directiveId, task.projectId, { again, why });
      return;
    }
    enqueue(ctx, {
      kind: 'reviewer_assign',
      memberId: producer.id,
      sessionKey: directiveKey(task.directiveId),
      projectId: task.projectId,
      taskId: task.id,
      directiveId: task.directiveId,
      priority: task.priority,
      message: `${task.id} ${why} (검수자 ${task.reviewerId === MAIN_AGENT_ID ? '메인 에이전트' : task.reviewerId}). ${reviewerAssignHint(task)}`,
      dedupeKind: true,
    });
  }

  private judgeReview(l: LiveTurn): void {
    const ctx = this.ctx;
    const task = l.taskId ? ctx.store.tasks.get(l.taskId) : null;
    if (!task || task.state !== 'in_review') return;
    // 다시 판정 업무를 실은 검수 턴이 정상으로 끝났다 — 검수자가 대표 메시지를 보고 판정을 바꾸지 않았다(바꿨으면 새 판정이 통과를 대신했다): 미룸을 풀어
    // 아래 마무리가 등록한 통과로 이어 간다. 질문·대표 메시지로 프로그램이 끝낸 턴은 판정을 마친 것이 아니다 (S7-B3)
    if (!l.endedForQuestion && !l.ownerMessageFirst && l.entryKinds.includes('review')) this.core.tasks.rejudgeTurnCompleted(task.id, l.memberId);
    if (this.settleReview(l, task)) return;
    const target = task.review.target;
    const judged = ctx.store.reviews.list({ ref1: task.id }).some((r) => r.reviewRound === task.review.round && r.reviewerId === l.memberId && target && JSON.stringify(r.target) === JSON.stringify(target));
    if (judged) return;
    // 대표 메시지를 먼저 전달하려고 프로그램이 판정을 받지 않고 끝낸 턴은 재시도로 세지 않는다 — 검수자는 판정하려 했다 (endForOwnerMessage). 세면 검수 중
    // 대표 메시지가 이어서 올 때 검수자 교체 요청(reviewer_assign)이 나간다. 질문(ask_producer)으로 끝낸 턴도 세지 않는다 — 답변이 다음 턴을 연다.
    // 그 답이 턴이 끝나기 전에(질문 뒤 창 안에) 와 검수로 돌아왔으면 답이 이미 이 검수 세션에 기다리므로 판정 재촉도 넣지 않는다 (15.4, S7-B4)
    const counted = !l.ownerMessageFirst && !l.endedForQuestion;
    if (l.endedForQuestion && ctx.store.queue.list({ ref2: l.sessionKey, state: 'queued' }).some((q) => q.memberId === l.memberId && !q.ownerShared)) return;
    // 판정 재촉 횟수는 실은 항목의 deliveries로 센다 — 비정상 종료 횟수(attempts)와 섞지 않는다 (리드 결정 30)
    const sent = this.carriedDeliveries(l);
    if (counted && sent >= 2) return this.escalateReview(task, '검수 결과가 반복해서 등록되지 않았습니다');
    enqueue(ctx, {
      kind: 'review',
      memberId: l.memberId,
      sessionKey: l.sessionKey,
      projectId: task.projectId,
      taskId: task.id,
      directiveId: task.directiveId,
      priority: task.priority,
      // 지금 버전의 판정 재촉 — 다른 버전 검수 요청에 섞이지 않게 그 고정에 묶는다 (REV-07·08)
      ...(target ? { reviewPinnedAt: target.pinnedAt } : {}),
      deliveries: sent + (counted ? 1 : 0),
      message: l.ownerMessageFirst
        ? '긴급 지시를 먼저 확인하세요 — 그 뒤에 완료 조건을 확인하고 submit_review로 결과를 등록하세요 (긴급 지시는 완료 조건·프로듀서 지시보다 우선, CTL-06).'
        : '검수 결과가 아직 등록되지 않았습니다. 완료 조건을 확인하고 submit_review로 결과를 등록하세요.',
      dedupeKind: true,
    });
  }

  private judgeDirective(l: LiveTurn): void {
    const ctx = this.ctx;
    const d = l.directiveId ? ctx.store.directives.get(l.directiveId) : null;
    if (!d) return;
    const kinds = new Set(l.entryKinds);
    // 재촉 횟수는 그 종류의 실은 항목의 deliveries로 본다 — 함께 실린 다른 업무의 횟수에 끌려가지 않고, 비정상 종료 횟수와 섞지 않는다 (리드 결정 30)
    // 계획 지연 알림의 since는 그 지연의 마지막 재촉(실은 계획 항목)을 만든 때다 (리드 결정 S5-26)
    if (kinds.has('plan')) this.core.directives.afterPlanTurn(d.id, this.carriedDeliveries(l, (q) => q.kind === 'plan'), this.stallSince(l, (q) => q.kind === 'plan'));
    const producer = ctx.store.members.get(l.memberId);
    if (!producer) return;
    const nudge = (kind: WorkKind, message: string, taskId: string | null = null) => {
      const sent = this.carriedDeliveries(l, (q) => q.kind === kind);
      if (sent >= 2) {
        // 재촉 상한 — 프로듀서에게 더 넣지 않는다. 그 일은 메인 에이전트에게 한 번 넘긴다(alert producer-stuck:<지시>:<종류> — 지연 하나마다 한 번: since는 이 턴이
        // 실은 그 종류 항목, 곧 그 지연의 마지막 재촉을 만든 때라 같은 회차의 다른 지연은 따로 알린다, 리드 결정 45·S5-8·S5-26). 넘기지 못했으면(같은 지연을
        // 이미 넘겼다) 대표가 명령창으로 메인 에이전트에게 알리는 길을 적는다
        const handed = alertMain(ctx, {
          kind: 'producer-stuck',
          target: `${d.id}:${kind}`,
          projectId: d.projectId,
          directiveId: d.id,
          taskId,
          message: producerStuckText(ctx, d.id, kind, message),
          since: this.stallSince(l, (q) => q.kind === kind),
        });
        ctx.notify({
          level: 'normal',
          title: '프로듀서 처리 지연',
          body: `${d.id}: 프로듀서가 같은 요청을 세 번 받고도 처리하지 않았습니다 (${message.replace(/\.\s*$/, '')}). ${handed ? OWNER_HANDED : `어떻게 할지 ${OWNER_TELL_MAIN}`}`,
          link: { tab: 'projects', projectId: d.projectId ?? undefined, directiveId: d.id },
          key: `producer-stuck:${d.id}:${kind}`,
        });
        return;
      }
      enqueue(ctx, { kind, memberId: producer.id, sessionKey: l.sessionKey, projectId: d.projectId, directiveId: d.id, taskId, priority: 'high', deliveries: sent + 1, message, dedupeKind: true });
    };
    if (kinds.has('answer')) {
      const open = ctx.store.questions.list({ state: 'open' }).filter((q) => q.to === 'producer' && q.directiveId === d.id);
      if (open.length) nudge('answer', `아직 답하지 않은 질문: ${open.map((q) => `${q.id}: ${q.text.slice(0, 80)}`).join(' / ')}. answer_question으로 답하세요.`);
    }
    if (kinds.has('merge_decision')) {
      // 통과 뒤 그 검수자에게 온 대표 메시지로 병합 판단을 미룬 작업(메시지 대기·다시 판정 턴 진행 중)은 재촉하지 않는다 — request_merge가 거부한다 (CTL-06, S8-B3)
      const cands = directiveTasks(ctx, d.id).filter(
        (t) => t.state === 'in_review' && t.review.passed && t.outputMode === 'repo' && !this.core.merges.isPending(t.id) && !this.core.tasks.mergeDeferredForReviewer(t),
      );
      if (cands.length) nudge('merge_decision', `${MERGE_NUDGE_LEAD}${cands.map((t) => t.id).join(', ')}. request_merge를 호출하세요.`);
    }
    if (kinds.has('final_result') && (d.state === 'in_progress' || d.state === 'planning')) {
      const tasks = directiveTasks(ctx, d.id, d.round);
      if (tasks.length && tasks.every((t) => isTerminal(t.state))) nudge('final_result', '모든 작업이 끝났습니다. submit_final_result로 결과를 정리하세요.');
    }
    if (kinds.has('replan')) {
      const held = directiveTasks(ctx, d.id).filter((t) => t.state === 'on_hold' && t.hold.reasons.some((r) => r.kind === 'replan' || r.kind === 'blocked' || r.kind === 'prereq_cancelled'));
      if (held.length) nudge('replan', `조치가 필요한 보류 작업: ${held.map((t) => t.id).join(', ')}. replan_task 또는 resolve_hold를 호출하세요.`);
    }
    if (kinds.has('reviewer_assign')) {
      // 검수자 재배정 업무를 받고도 검수자를 정하지 않아 검수가 멈춘 작업 — 검수 중 작업에는 늘 대기·실행 중인 검수나, 처리할 수 있는 쪽의 업무가 있어야
      // 한다 (리드 결정 11): 프로듀서를 다시 재촉하고, 재촉 상한이면 메인 에이전트에게 넘긴다. 이 턴이 받은 재배정 업무의 작업만, 그 업무의 재촉 횟수로 본다
      for (const [t, tries] of this.stuckReviewAssigns(l)) this.reviewerAssignStuck(l.sessionKey, tries, d.id, d.projectId, producer.id, t);
    }
  }

  /**
   * 이 프로듀서 턴이 받은 검수자 재배정 업무(reviewer_assign)의 작업 중 검수가 멈춘 것 — 검수 중·통과 전인데 대기·실행 중인 검수가 없다.
   * [작업, 그 업무의 재촉 횟수]. 합쳐 둔 옛 항목(같은 작업끼리만 합치기 전)도 놓치지 않게 글의 작업 ID도 본다 (리드 결정 11).
   * entries: 이 항목들만 본다 (시작 실패 상한에서 버리는 항목 — recordStartFailure). 없으면 이 턴이 실은 항목 전부
   */
  private stuckReviewAssigns(l: TurnRef, entries?: readonly QueueEntry[]): [Task, number][] {
    const ctx = this.ctx;
    if (l.sessionKind !== 'directive') return [];
    const asked = new Map<string, number>();
    for (const q of entries ?? l.entryIds.map((id) => ctx.store.queue.get(id))) {
      if (q?.kind !== 'reviewer_assign') continue;
      for (const taskId of new Set([...(q.taskId ? [q.taskId] : []), ...(q.message.match(/T-\d+/g) ?? [])])) asked.set(taskId, Math.max(asked.get(taskId) ?? 0, q.deliveries ?? 0));
    }
    const out: [Task, number][] = [];
    for (const [taskId, tries] of asked) {
      const t = ctx.store.tasks.get(taskId);
      if (!t || t.directiveId !== l.directiveId || t.state !== 'in_review' || t.review.passed || this.core.tasks.reviewPending(t.id)) continue;
      out.push([t, tries]);
    }
    return out;
  }

  /**
   * 검수자 재배정 업무를 실은 프로듀서 턴이 재시도 없이 끝났다(비정상 종료·응답 없음 상한, 헛돌기, CLI 안전 검사 거부 상한, 시작 실패 상한) — 멈춘 검수를
   * 곧바로 메인 에이전트에게 넘긴다 (리드 결정 11·18). entries: 이 항목들의 작업만 (stuckReviewAssigns)
   */
  private handOffStuckReviews(l: TurnRef, why: string, entries?: readonly QueueEntry[]): void {
    if (!l.directiveId) return;
    for (const [t] of this.stuckReviewAssigns(l, entries)) this.reviewerAssignStuck(l.sessionKey, REVIEWER_ASSIGN_NUDGES, l.directiveId, t.projectId, l.memberId, t, why);
  }

  /**
   * 프로듀서가 검수자 재배정 업무를 처리하지 않은 작업: 재촉(상한 REVIEWER_ASSIGN_NUDGES번) → 메인 에이전트 업무 + 대표 알림 (judgeDirective, 리드 결정 11).
   * why: 프로듀서 턴이 재시도 없이 끝난 까닭 (없으면 재촉을 다 쓴 것)
   */
  private reviewerAssignStuck(sessionKey: string, tries: number, directiveId: string, projectId: string | null, producerId: string, t: Task, why?: string): void {
    const ctx = this.ctx;
    const who = t.reviewerId === MAIN_AGENT_ID ? '메인 에이전트' : (t.reviewerId ?? '없음');
    if (tries < REVIEWER_ASSIGN_NUDGES) {
      enqueue(ctx, {
        kind: 'reviewer_assign',
        memberId: producerId,
        sessionKey,
        projectId,
        directiveId,
        taskId: t.id,
        priority: 'high',
        deliveries: tries + 1,
        message: `${t.id} 검수가 멈춰 있습니다 — 아직 검수자(지금 ${who})를 다시 정하지 않았습니다. ${reviewerAssignHint(t, this.core.tasks.sameReviewerRedispatches(t) === 0)}`,
        dedupeKind: true,
      });
      return;
    }
    this.handReviewToMain(t, directiveId, projectId, { producer: why ?? `${tries + 1}번의 턴에서 정하지 않았습니다` });
  }

  /**
   * 멈춘 검수를 메인 에이전트에게 넘긴다: 그 프로젝트의 메인 업무(main:<P>, high)와 활동 기록, 대표 알림은 작업·검수자마다 한 번 (리드 결정 11·17·18).
   * cause — producer: 프로듀서가 검수자를 다시 정하지 않았다(그 까닭) / again·why: 프로듀서가 같은 검수자를 다시 정해 다시 등록한 검수(again번)가 또 판정 없이
   * 끝났다(why). 메인 에이전트가 실제로 할 수 있는 일만 적는다 — 메인 자신이 검수자면 판정을 직접 남기는 길도. 넘긴 뒤에도 검수 중 작업에는 이 업무가 있다
   */
  private handReviewToMain(t: Task, directiveId: string, projectId: string | null, cause: { producer: string } | { again: number; why: string }): void {
    const ctx = this.ctx;
    // 넣을 때도 남는 업무 한 판정으로 본다 — 검수가 이미 다시 등록됐거나 재배정 업무가 있으면(대상이 풀림) 넘기지 않고 기록만 남긴다 (리드 결정 31)
    const ended = handOffEnded(ctx, t.id, this.reviewBusy);
    if (ended) {
      ctx.activity({ kind: 'review', projectId: t.projectId, directiveId: t.directiveId, taskId: t.id, text: `${t.id} 멈춘 검수를 메인 에이전트에게 넘기지 않음 — ${ended}` });
      return;
    }
    const mainReviews = t.reviewerId === MAIN_AGENT_ID;
    const who = mainReviews ? '메인 에이전트' : (t.reviewerId ?? '없음');
    // 메인은 assign_reviewer로 검수자를 직접 정한다 (리드 결정 48·S5-11) — 안내는 add_member(검수 권한 팀원이 없을 때) 다음 assign_reviewer를 앞세운다. 지금
    // 검수자가 자격이 있으면 팀원을 더하기만 해서는 검수자가 바뀌지 않는다(dispatchReview는 그 검수자를 그대로 둔다). 프로듀서에게 지시하라는 안내는 그 지시가
    // 지금 프로듀서에게 닿을 때만 마지막에 둔다 (리드 결정 11·45). 메인의 instruct_member와 같은 판정(messageSessionOf)으로 보아 프로듀서의 활성 작업
    // 세션(멈춘 이 작업 자신 등)으로 가는데 그 작업이 진행 중이 아니면, 그 지시는 작업이 다시 진행될 때까지 처리되지 않는다 — 그 길을 빼고 까닭을 적는다.
    // 글은 저장해 다시 전달하므로 그 까닭은 넣을 때 확인한 사실로 쓴다 (리드 결정 31)
    const producerId = ctx.store.projects.get(t.projectId)?.producerId;
    const producer = producerId ? ctx.store.members.get(producerId) : null;
    const parked = producer && !producer.deletedAt ? deferredMessageTask(ctx, producer) : null;
    const parkedNote =
      parked && producer
        ? `이 업무를 넣을 때 프로듀서 ${producer.name}${subjectJosa(producer.name)} 맡은 작업 ${parked.id}이(가) ${TASK_STATE_LABEL[parked.state]} 중이었습니다 — 프로듀서에게 보내는 지시(instruct_member)는 그 작업 세션으로 가서 그 작업이 다시 진행될 때까지 처리되지 않으므로 그 길은 적지 않았습니다.`
        : '';
    let message: string;
    let note: string;
    const assign = `assign_reviewer(task_id="${t.id}", reviewer_id="…")`;
    if ('producer' in cause) {
      message = parked
        ? `${t.id} "${t.title}" 검수가 멈췄습니다 — 검수자(${who})의 검수 턴이 판정 없이 반복해서 끝나 프로듀서에게 검수자 재배정을 맡겼지만 ${cause.producer}. 검수 권한 팀원이 없으면 add_member로 더한 뒤 ${assign}로 검수자를 정하세요(지금 검수자를 다시 정하면 그 검수자에게 검수를 다시 등록합니다). 필요 없으면 cancel_task로 취소하세요. ${parkedNote}`
        : `${t.id} "${t.title}" 검수가 멈췄습니다 — 검수자(${who})의 검수 턴이 판정 없이 반복해서 끝나 프로듀서에게 검수자 재배정을 맡겼지만 ${cause.producer}. 검수 권한 팀원이 없으면 add_member로 더한 뒤 ${assign}로 검수자를 정하세요(지금 검수자를 다시 정하면 그 검수자에게 검수를 다시 등록합니다). 필요 없으면 cancel_task로 취소하세요. 프로듀서에게 맡기려면 instruct_member로 assign_reviewer를 지시해도 됩니다.`;
      note = `${t.id} 검수자 재배정이 처리되지 않아 메인 에이전트에게 넘김 (${cause.producer})`;
    } else {
      const head = mainReviews
        ? `${t.id} "${t.title}" 검수가 멈췄습니다 — 메인 에이전트 자신의 검수 턴이 판정 없이 반복해서 끝납니다 (${cause.why}). 프로듀서가 같은 검수자 "main"을 다시 정해 검수를 ${cause.again}번 다시 등록했지만 이번에도 판정이 없어, 같은 검수를 더 되풀이하지 않고 넘깁니다.`
        : `${t.id} "${t.title}" 검수가 멈췄습니다 — 검수자 ${who}의 검수 턴이 판정 없이 반복해서 끝납니다 (${cause.why}). 프로듀서가 같은 검수자를 다시 정해 검수를 ${cause.again}번 다시 등록했지만 이번에도 판정이 없어, 같은 검수를 더 되풀이하지 않고 넘깁니다.`;
      // 같은 검수자로 다시 등록한 검수도 판정 없이 끝났다 — 같은 검수자는 권하지 않는다 (리드 결정 17)
      const canMain = !mainReviews && mainCanReview(t);
      const ways = [
        `검수 권한 팀원이 없으면 add_member로 더한 뒤 ${assign}로 ${canMain ? '다른 적격 검수자나 "main"(메인 에이전트)을' : '다른 적격 검수자를'} 정하세요 — 같은 검수자(${who})로 다시 등록한 검수도 판정 없이 끝났습니다.${
          mainReviews || canMain ? '' : ' 메인 에이전트는 이 작업에 기여해 검수할 수 없습니다.'
        }`,
        ...(mainReviews ? [`판정을 직접 남기려면 interrupt_task 뒤 resume_task(task_id="${t.id}")로 검수를 다시 등록하고, 그 검수 턴에서 submit_review로 결과를 꼭 등록하세요.`] : []),
        '필요 없는 작업이면 cancel_task로 까닭을 적어 취소하세요.',
        ...(parked ? [] : ['프로듀서에게 맡기려면 instruct_member로 assign_reviewer를 지시해도 됩니다.']),
      ];
      message = [`${head} 할 수 있는 일:`, ...ways.map((w) => `- ${w}`), ...(parked ? [parkedNote] : [])].join('\n');
      note = `${t.id} 같은 검수자(${who})로 다시 등록한 검수도 판정 없이 끝나 메인 에이전트에게 넘김 (다시 등록 ${cause.again}번, ${cause.why})`;
    }
    enqueue(ctx, { kind: 'message', memberId: MAIN_AGENT_ID, sessionKey: mainKey(projectId), projectId, directiveId, taskId: t.id, priority: 'high', message, dedupeKind: true });
    ctx.activity({ kind: 'review', level: 'warn', projectId: t.projectId, taskId: t.id, text: note });
    // 대표 알림은 작업·검수자마다 한 번 — 같은 검수가 되풀이해 넘어와도 다시 알리지 않는다 (읽은 뒤에도). 메인 에이전트가 이 넘김을 받아 이어 가고, 대표는
    // 서두를 때 명령창으로 알린다 (리드 결정 45 — '프로듀서 처리 지연' 알림은 모두 명령창 길을 적는다)
    const key = `review-stuck:${t.id}:${t.reviewerId ?? 'none'}`;
    if (ctx.store.notifications.list({ ref1: key }).length) return;
    ctx.notify({
      level: 'normal',
      title: 'producer' in cause ? '프로듀서 처리 지연' : '검수 멈춤',
      body:
        'producer' in cause
          ? `${directiveId}: ${t.id} 검수자를 다시 정하지 않아 메인 에이전트에게 넘겼습니다. 메인 에이전트가 확인하고 이어 갑니다 — 서둘러야 하면 명령창으로 메인 에이전트에게 알려 주세요`
          : `${directiveId}: ${t.id} 검수가 같은 검수자(${who})로 다시 해도 판정 없이 끝나 메인 에이전트에게 넘겼습니다. 메인 에이전트가 확인하고 이어 갑니다 — 서둘러야 하면 명령창으로 메인 에이전트에게 알려 주세요`,
      link: { tab: 'projects', projectId: projectId ?? undefined, directiveId, taskId: t.id },
      key,
    });
  }

  private judgeMain(l: LiveTurn): void {
    const ctx = this.ctx;
    const target = l.sessionKey === 'main:general' ? 'main' : l.sessionKey.slice('main:'.length);
    const kinds = new Set(l.entryKinds);
    // 대표에게 하는 답: 명령·메시지, 그리고 대표가 넘긴 일(수정 요청·정지 해제)과 검수자 없음 처리 결과 (v0.6) — 보고서 턴의 마지막 말은 붙이지 않는다
    if (['main_command', 'message', 'change_request', 'stop_released', 'no_reviewer', 'alert'].some((k) => kinds.has(k as WorkKind)) && l.flags.finalText) {
      this.core.commands.appendAgentReply(target, l.flags.finalText, l.directiveId);
    }
    // 화면 확인 업무를 싣고 정상으로 끝났는데 답하지 않았으면 그 보유자는 화면 이미지를 볼 수 없다고 정한다 (리드 결정 S6-10)
    if (kinds.has('screen_check')) this.core.desktop.afterMainTurn(l.entryIds.map((id) => ctx.store.queue.get(id)));
    // 보고서 재촉은 이 턴이 실은 보고서 요청마다 그 요청의 지시와 전달 횟수(deliveries)로 본다 — 같은 턴에 다른 지시의 업무(다시 넣은 멈춘 검수 넘김 등,
    // 리드 결정 24)가 함께 실려도 그 횟수에 끌려가지 않고, 비정상 종료 횟수(attempts)와 섞지 않는다 (리드 결정 30)
    for (const id of l.entryIds) {
      const q = ctx.store.queue.get(id);
      if (q?.kind !== 'main_report' || !q.directiveId) continue;
      const d = ctx.store.directives.get(q.directiveId);
      if (d?.state !== 'reporting') continue;
      const sent = q.deliveries ?? 0;
      if (sent >= 2) {
        // 재촉 상한 — 더 넣지 않는다. 대표가 명령창으로 메인 에이전트에게 알리는 길을 적는다 (리드 결정 32·45)
        ctx.notify({
          level: 'normal',
          title: '보고서 작성 지연',
          body: `${d.id} 보고서가 제출되지 않았습니다 — 메인 에이전트에게 세 번 요청했지만 내지 않았습니다. 어떻게 할지 명령창으로 메인 에이전트에게 알려 주세요. 메인 에이전트가 확인하고 이어 갑니다`,
          link: { tab: 'projects', projectId: d.projectId ?? undefined, directiveId: d.id },
          key: `report-stuck:${d.id}`,
        });
      } else {
        enqueue(ctx, {
          kind: 'main_report',
          memberId: MAIN_AGENT_ID,
          sessionKey: l.sessionKey,
          projectId: d.projectId,
          directiveId: d.id,
          priority: 'high',
          deliveries: sent + 1,
          message: `지시 ${d.id}의 보고서가 아직 제출되지 않았습니다. submit_report(directive_id="${d.id}")를 호출하세요.`,
          dedupeKind: true,
        });
      }
    }
    // 멈춘 검수 넘김·일시정지된 팀원의 재개는 대상이 풀릴 때까지 남는 업무다 (리드 결정 24·26·31): 이 턴이 그 대상을 풀지 않고 끝났으면 다시 넣는다(전달 횟수
    // deliveries+1, 비정상 종료 횟수는 새로 0부터). 글은 원래 안내만 저장하고 머리말은 전달할 때 붙인다(standingHead). 메인 턴 MAIN_STANDING_DELIVERIES번에
    // 실려 매번 대상이 그대로이면 대표에게 그 작업·팀원을 알린다(그 뒤에는 그 알림이 처리할 수 있는 쪽의 업무다). 다만 이 턴이 시작한 진행(대표에게 한 질문,
    // 팀원에게 보낸 지시)이 아직 끝나지 않았으면 알리지 않고 기다리게 넣는다 — 스케줄러가 진행이 끝난 뒤에 대상을 다시 보고 전달하거나 알린다
    for (const id of l.entryIds) {
      const q = ctx.store.queue.get(id);
      if (!q || !isStandingItem(q)) continue;
      const ended = deadWorkReason(ctx, q, this.reviewBusy);
      if (ended) {
        // 대상이 풀렸다 — 다시 넣지 않는다 (기록 한 줄)
        ctx.activity({ kind: q.pausedMemberId ? 'stop' : 'review', projectId: q.projectId, directiveId: q.directiveId, taskId: q.taskId, memberId: q.pausedMemberId ?? null, text: `남는 업무 끝 — ${ended} (${q.sessionKey}, 다시 넣지 않음)` });
        // 메인 자신이 이 턴에 그 작업을 중단해(돌아갈 상태 검수) 넘김이 끝났는데 resume_task 없이 턴이 끝났다 — 그 작업에는 할 일이 없으니 메인에게 한 번 다시
        // 알린다 (alert interrupted-review:<작업>, 리드 결정 42·S5-8). 시작 때 훑기가 나머지(스케줄러·다시 넣기에서 끝난 넘김)를 맡는다
        if (isReviewHandOff(q)) this.alertInterruptedReview(q.taskId!);
        continue;
      }
      const need = this.standingNeed(q);
      if (!need) continue;
      const next = (q.deliveries ?? 0) + 1;
      if (next >= MAIN_STANDING_DELIVERIES && !this.mainProgressPending(q.projectId)) {
        this.standingGivenUp(need);
        continue;
      }
      enqueue(ctx, {
        kind: 'message',
        memberId: MAIN_AGENT_ID,
        sessionKey: q.sessionKey,
        projectId: q.projectId,
        directiveId: q.directiveId,
        taskId: q.taskId,
        ...(q.pausedMemberId ? { pausedMemberId: q.pausedMemberId } : {}),
        priority: q.priority,
        deliveries: next,
        message: standingText(q),
        dedupeKind: true,
      });
    }
  }

  /** 메인이 직접 중단한(돌아갈 상태 검수) 채 남은 작업을 메인에게 알린다 (리드 결정 42) — 그 보류가 메인이 건 중단일 때만 */
  private alertInterruptedReview(taskId: string): void {
    const t = this.ctx.store.tasks.get(taskId);
    if (!t || t.state !== 'on_hold') return;
    alertTaskHold(this.ctx, 'interrupted-review', t.id, { cause: '메인 에이전트가 검수 중에 중단한 채 재개하지 않고 턴을 마쳐 할 일이 없음' });
  }

  /** 이 턴이 실은 항목(공유 사본 빼고, pred에 맞는 것)의 가장 큰 전달 횟수 (QueueEntry.deliveries, 리드 결정 30) */
  private carriedDeliveries(l: LiveTurn, pred: (q: QueueEntry) => boolean = () => true): number {
    const ctx = this.ctx;
    return Math.max(0, ...l.entryIds.map((id) => ctx.store.queue.get(id)).flatMap((q) => (q && !q.ownerShared && pred(q) ? [q.deliveries ?? 0] : [])));
  }

  /**
   * 재촉 상한 알림(계획 지연·프로듀서 처리 지연)의 since — 이 턴이 실은 그 종류 항목 가운데 전달 횟수가 가장 큰 것(그 지연의 마지막 재촉)을 만든 때. 같은 지연이
   * 다시 상한이면 같은 때라 한 번이고, 같은 회차의 다른 지연은 그 뒤에 만든 재촉이라 따로 알린다 (리드 결정 S5-26). 그런 항목이 없으면 지금
   */
  private stallSince(l: LiveTurn, pred: (q: QueueEntry) => boolean): string {
    const ctx = this.ctx;
    const carried = l.entryIds.map((id) => ctx.store.queue.get(id)).filter((q): q is QueueEntry => !!q && !q.ownerShared && pred(q));
    const last = carried.reduce<QueueEntry | null>((a, b) => (!a || (b.deliveries ?? 0) > (a.deliveries ?? 0) ? b : a), null);
    return last?.createdAt ?? ctx.now();
  }
}

function safeParse(fn: () => ParsedCliEvent[], line: string): ParsedCliEvent[] {
  try {
    return fn();
  } catch (e) {
    return [{ kind: 'system', text: `이벤트 해석 실패: ${e instanceof Error ? e.message : String(e)}`, raw: line }];
  }
}

/**
 * 검수 턴이 지금 고정된 검수 대상이 아닌 버전에 띄워졌는지 — 그 턴은 이전 버전(사본)을 보고 있었다 (REV-07·08). 띄울 때의 고정과 같은지로 본다
 * (submit_review의 판정 묶기와 같은 기준, reviewTurnStale). 띄울 때 대상을 알 수 없었던 턴만 시작 시각으로 본다
 */
function launchedForOtherPin(l: LiveTurn, task: Task): boolean {
  const pinnedAt = task.review.target?.pinnedAt;
  if (!pinnedAt) return false;
  return reviewTurnStale(l.reviewPinnedAt !== null ? { turnPinnedAt: l.reviewPinnedAt } : { turnStartedAt: new Date(l.startedMs).toISOString() }, pinnedAt);
}

/**
 * 검수자 재배정 업무의 안내 — 실제로 무엇을 하는 길만 말한다 (리드 결정 11). 같은 검수자를 다시 정하면 검수를 다시 등록하고(tasks.changeReviewer),
 * "main"은 메인 에이전트가 이 작업을 검수할 수 있을 때만(기여자가 아님) 권한다. 메인 에이전트가 지금 검수자면 "main"이 바로 그 '다시 등록'이다.
 * offerSame=false: 같은 검수자로 다시 등록한 검수도 판정 없이 끝났다 — 같은 검수자는 권하지 않는다 (리드 결정 17)
 */
export function reviewerAssignHint(task: Task, offerSame = true): string {
  if (task.reviewerId === MAIN_AGENT_ID) {
    return offerSame
      ? 'assign_reviewer로 검수 권한이 있는 다른 팀원을 정하거나, 그런 팀원이 없으면 같은 검수자 "main"을 다시 정해 메인 에이전트 검수를 다시 시작하세요.'
      : 'assign_reviewer로 검수 권한이 있는 다른 팀원을 정하세요. 같은 검수자 "main"으로 다시 등록한 검수도 판정 없이 끝났습니다.';
  }
  const main = mainCanReview(task);
  const other = main ? '다른 적격 검수자나 "main"(메인 에이전트)을' : '다른 적격 검수자를';
  if (!offerSame) {
    const tried = task.reviewerId ? ` 같은 검수자(${task.reviewerId})로 다시 등록한 검수도 판정 없이 끝났습니다.` : '';
    return `assign_reviewer로 ${other} 정하세요.${tried}${main ? '' : ' 메인 에이전트는 이 작업에 기여해 검수할 수 없습니다.'}`;
  }
  const same = task.reviewerId ? `, 같은 검수자(${task.reviewerId})를 다시 정해 검수를 다시 시작하세요` : '';
  return `assign_reviewer로 ${other} 정하${same ? `거나${same}` : '세요'}.${main ? '' : ' 메인 에이전트는 이 작업에 기여해 검수할 수 없습니다.'}`;
}

/**
 * 업무의 대상이 이미 끝났는지 — 끝났으면 그 까닭, 아니면 null (리드 결정 19). 한 판정을 세 곳이 함께 쓴다: 끊긴 턴의 업무를 다시 넣을 때(requeue),
 * 재시작 복구가 끊긴 턴의 업무를 되살릴 때(recovery.settleCutTurnEntries), 스케줄러가 대기 업무를 띄우기 전. 끝난 업무는 지우고 다시 전달하지 않는다 —
 * 대표가 그대로 승인해 거둬들인 수정 요청이 턴이 끊긴 뒤 '(다시 전달)'로 돌아와 메인 에이전트에게 거둬들인 일을 시키지 않게.
 * - 수정 요청(change_request): 그 보고서가 더는 수정 요청이 아니다(그대로 결과 승인), 지시가 끝나거나 취소됐다, 새 회차가 열렸다
 * - 보고서 작성(main_report): 지시가 보고 단계가 아니다(보고서 제출·지시 종료·취소)
 * - 검수자 없음(no_reviewer): 작업이 끝났거나 '검수자 없음' 보류가 풀렸다
 * - 정지 해제 목록(stop_released): 목록의 작업 가운데 아직 긴급 정지 보류인 것이 없다 (releasedStillHeld, 리드 결정 43)
 * - 메인에게 넘긴 보류·실패(alert): 그 키의 대상이 풀렸다 — 보류 사유가 없어짐, 복구 확인이 처리됨, 팀원이 재개됨, 지시가 그 단계를 벗어남 등 (alerts.alertEnded,
 *   리드 결정 S5-7)
 * - 검수자 재배정(reviewer_assign): 작업이 끝났거나 검수 단계가 아니다(보류 중이면 돌아갈 상태로 본다), 또는 이미 통과했다. 합쳐 둔 옛 검수자 재배정 항목(같은 작업끼리만 합치기 전)은 그 항목이 가리키는 작업(taskId와 글의 작업 ID)이 모두 끝났을
 *   때만 끝난 업무다 — 첫 작업이 통과했다고 다른 작업의 재배정 업무까지 지우지 않는다 (리드 결정 27)
 * - 남는 업무(리드 결정 31 — 넣을 때·스케줄러가 전달하기 전·다시 넣을 때·재시작 복구가 이 한 판정을 쓴다. 필요 없어진 항목은 활동 기록 한 줄과 함께 지우고
 *   전달하지 않는다):
 *   - 멈춘 검수를 넘겨받은 메인 업무(isReviewHandOff): 작업이 검수 중·통과 전이고, 대기·실행 중인 검수도 검수자 재배정 업무도 없을 때만 필요하다 (handOffEnded)
 *   - 일시정지된 팀원의 재개를 맡긴 메인 업무(pausedMemberId): 그 팀원이 프로그램이 건 그 정지(`by: 'system'`, 그 업무를 만들기 전에 건 정지)로 남아 있을
 *     때만 필요하다 — 재개·삭제됐거나 메인 에이전트가 직접 다시 일시정지했으면 끝난 업무다 (pauseItemEnded, 리드 결정 26·31)
 * 다른 업무(대표 명령·답변, 기억 갱신, 팀원 메시지, 작업·검수 등)는 보지 않는다. 지시가 닫힌 일은 closedDirectiveWork가 따로 본다.
 * reviewBusy: 그 작업의 검수가 대기·실행 중인지 (tasks.reviewPending — 실행 중인 검수 턴까지). 없으면 대기열만 본다
 */
export function deadWorkReason(ctx: Ctx, q: QueueEntry, reviewBusy?: (taskId: string) => boolean): string | null {
  switch (q.kind) {
    case 'change_request': {
      const reportId = q.reportId ?? /보고서 (R-\d+)/.exec(q.message)?.[1] ?? null;
      const r = reportId ? ctx.store.reports.get(reportId) : null;
      if (r?.status === 'approved') return `대표가 보고서 ${r.id}을(를) 그대로 결과 승인함`;
      if (r && r.status !== 'changes_requested') return `보고서 ${r.id}이(가) 더는 수정 요청 상태가 아님`;
      const d = q.directiveId ? ctx.store.directives.get(q.directiveId) : null;
      if (d && !isDirectiveOpen(d)) return `지시 ${d.id}이(가) ${DIRECTIVE_STATE_LABEL[d.state]}됨`;
      if (d && r && d.round > r.round) return `지시 ${d.id}의 ${d.round}회차가 이미 열림`;
      return null;
    }
    case 'main_report': {
      const d = q.directiveId ? ctx.store.directives.get(q.directiveId) : null;
      return d && d.state !== 'reporting' ? `지시 ${d.id}이(가) 보고 단계가 아님 (${DIRECTIVE_STATE_LABEL[d.state]})` : null;
    }
    case 'no_reviewer': {
      const t = q.taskId ? ctx.store.tasks.get(q.taskId) : null;
      if (!t) return null;
      if (isTerminal(t.state)) return `${t.id}이(가) 이미 ${TASK_STATE_LABEL[t.state]}됨`;
      return t.hold.reasons.some((r) => r.refId === NO_REVIEWER_HOLD_REF) ? null : `${t.id}의 '검수자 없음' 보류가 이미 풀림`;
    }
    case 'stop_released':
      return releasedStillHeld(ctx, q).length ? null : '정지 해제 목록의 작업이 모두 긴급 정지 보류에서 풀림';
    case 'alert':
      return alertEnded(ctx, q);
    case 'screen_check':
      // 화면 확인: 화면 도구를 내놓지 않음·세대나 모델이 바뀜·이미 확인함 (리드 결정 S6-10)
      return deadScreenCheck(ctx, q);
    case 'reviewer_assign': {
      // 가리키는 작업이 하나라도 아직 그 업무가 필요하면(또는 찾을 수 없어 판단할 수 없으면) 살아 있다
      let ended: string | null = null;
      for (const taskId of namedTasks(q)) {
        const why = reviewWorkEnded(ctx, taskId);
        if (!why) return null;
        ended ??= why;
      }
      return ended;
    }
    case 'message': {
      if (q.pausedMemberId && q.memberId === MAIN_AGENT_ID) return pauseItemEnded(ctx, q.pausedMemberId, q.createdAt);
      return isReviewHandOff(q) ? handOffEnded(ctx, q.taskId!, reviewBusy) : null;
    }
    default:
      return null;
  }
}

/**
 * 멈춘 검수 넘김(남는 업무)이 더는 필요 없는 까닭 — 작업이 검수 중·통과 전이고, 대기·실행 중인 검수도 검수자 재배정 업무도 없을 때만 필요하다 (리드 결정 31).
 * 보류(돌아갈 상태가 검수)도 검수 중이 아니다 — 보류가 풀리면 afterRelease가 검수를 다시 등록한다. 작업을 찾을 수 없으면 판단하지 않는다(null)
 */
export function handOffEnded(ctx: Ctx, taskId: string, reviewBusy?: (taskId: string) => boolean): string | null {
  const t = ctx.store.tasks.get(taskId);
  if (!t) return null;
  if (isTerminal(t.state)) return `${t.id}이(가) 이미 ${TASK_STATE_LABEL[t.state]}됨`;
  if (t.state !== 'in_review') return `${t.id}이(가) 검수 중이 아님 (${TASK_STATE_LABEL[t.state]})`;
  if (t.review.passed) return `${t.id}이(가) 이미 검수를 통과함`;
  const busy = reviewBusy ? reviewBusy(t.id) : ctx.store.queue.list({ ref2: reviewKey(t.id), state: ['queued', 'running'] }).some((x) => x.kind === 'review' || x.state === 'running');
  if (busy) return `${t.id}의 검수가 다시 등록됨`;
  const assigning = ctx.store.queue.list({ state: ['queued', 'running'] }).some((x) => x.kind === 'reviewer_assign' && namedTasks(x).includes(t.id));
  return assigning ? `${t.id}의 검수자 재배정 업무가 프로듀서에게 있음` : null;
}

/**
 * 일시정지된 팀원의 재개를 맡긴 업무(남는 업무)가 더는 필요 없는 까닭 — 그 팀원이 프로그램이 건 그 정지로 남아 있을 때만 필요하다 (리드 결정 26·31):
 * 재개됐거나(정지 기록 없음) 삭제됐거나, 정지를 건 쪽이 프로그램이 아니거나(메인 에이전트가 직접 다시 일시정지함 등), 그 업무를 만든 뒤에 건 다른 정지다
 */
function pauseItemEnded(ctx: Ctx, memberId: string, createdAt: string): string | null {
  const m = ctx.store.members.get(memberId);
  if (!m || m.deletedAt) return `${memberId}이(가) 삭제됨`;
  const s = ctx.stop().members[m.id];
  if (!s?.paused) return `${m.name}(${m.id})이(가) 이미 재개됨`;
  if (s.by !== 'system') {
    const who = s.by === MAIN_AGENT_ID ? '메인 에이전트' : s.by === 'owner' ? '대표' : s.by === 'operator' ? '운영자' : s.by;
    return `${m.name}(${m.id})을(를) ${who}${subjectJosa(who)} 직접 일시정지함 — 프로그램이 건 정지가 아님`;
  }
  return s.since > createdAt ? `${m.name}(${m.id})이(가) 그 뒤 다른 까닭으로 다시 일시정지됨` : null;
}

/** 검수 업무(검수자 재배정·멈춘 검수 넘김)의 대상 작업이 끝났는지 — 끝났으면 그 까닭. 작업을 찾을 수 없으면 판단하지 않는다(null) */
function reviewWorkEnded(ctx: Ctx, taskId: string): string | null {
  const t = ctx.store.tasks.get(taskId);
  if (!t) return null;
  if (isTerminal(t.state)) return `${t.id}이(가) 이미 ${TASK_STATE_LABEL[t.state]}됨`;
  const state = t.state === 'on_hold' ? (t.hold.returnState ?? t.state) : t.state;
  if (state !== 'in_review') return `${t.id}이(가) 검수 단계가 아님 (${TASK_STATE_LABEL[state]})`;
  return t.review.passed ? `${t.id}이(가) 이미 검수를 통과함` : null;
}

/** 멈춘 검수를 메인 에이전트에게 넘긴 업무인지 — 작업에 묶이고 메시지 기록이 없는 메인 에이전트의 message (handReviewToMain, 리드 결정 17·24) */
export function isReviewHandOff(q: QueueEntry): boolean {
  return q.kind === 'message' && q.memberId === MAIN_AGENT_ID && q.sessionKey.startsWith('main:') && !!q.taskId && !q.messageId;
}

/**
 * 업무가 가리키는 작업 — taskId, 그리고 검수자 재배정이면 글의 작업 ID. 예전 코드는 같은 지시 세션의 재배정 업무를 작업과 상관없이 한 항목으로 합쳐
 * 첫 작업의 taskId만 남겼다 — 다른 작업은 글에만 있다 (리드 결정 27)
 */
export function namedTasks(q: QueueEntry): string[] {
  return [...new Set([...(q.taskId ? [q.taskId] : []), ...(q.kind === 'reviewer_assign' ? (q.message.match(/T-\d+/g) ?? []) : [])])];
}

/** 프로듀서의 병합 재촉 글 머리 (judgeDirective) — 재촉에는 taskId가 없고 이 뒤에 작업 ID를 적는다 */
const MERGE_NUDGE_LEAD = '검수를 통과했지만 병합 요청이 없는 작업: ';

/**
 * 병합 재촉(taskId 없는 merge_decision)이 적은 작업 — 재촉 글 머리 뒤의 작업 ID 목록만 읽는다(다시 넣기 앞말 등 다른 글의 작업 ID는 읽지 않는다). 시작 때
 * 병합 판단을 다시 넣을지 볼 때 이 재촉도 그 작업의 업무로 센다 — 재시작 상한의 버림 판정과 '이미 기다림' 판정 (recovery, 리드 결정 48)
 */
export function mergeNudgeTasks(q: QueueEntry): string[] {
  const ids = [...q.message.matchAll(new RegExp(`${MERGE_NUDGE_LEAD}((?:T-\\d+(?:, )?)+)`, 'g'))].flatMap((m) => m[1]!.match(/T-\d+/g) ?? []);
  return [...new Set(ids)];
}

/**
 * 그 작업의 검수가 넘어가 있는지 — 대기·실행 중인 멈춘 검수 넘김(메인 에이전트)이나 검수자 재배정(프로듀서, 합쳐 둔 옛 항목은 글의 작업 ID도)이 있다.
 * 재시작 복구 3)이 이런 작업에 검수를 다시 등록하지 않고(눈먼 검수 한 바퀴를 더 돌리지 않게), 남는 업무 판정(standingNeed)이 쓴다 (리드 결정 24).
 * exceptId: 이 항목은 세지 않는다
 */
export function reviewHandedOff(ctx: Ctx, taskId: string, exceptId: string | null = null): boolean {
  return ctx.store.queue
    .list({ state: ['queued', 'running'] })
    .some((q) => q.id !== exceptId && ((isReviewHandOff(q) && q.taskId === taskId) || (q.kind === 'reviewer_assign' && namedTasks(q).includes(taskId))));
}

/** 업무 한 줄 이름 — '검수자 배정 T-0001', '계획 D-0002' (메인 에이전트에게 맡기는 팀원 재개 업무·대표 알림의 '멈춘 업무') */
function workLabel(q: QueueEntry): string {
  const refs = namedTasks(q);
  const ref = refs.length ? refs.join('·') : (q.directiveId ?? '');
  return `${WORK_KIND_LABEL[q.kind]}${ref ? ` ${ref}` : ''}`;
}

/** 버린 대표 요청 하나 — 그 항목과 한 줄 이름 ('쇼핑몰(P-0001) 명령 "…"', '쇼핑몰(P-0001) 보고서 R-0001 수정 요청') */
interface OwnerRequest {
  q: QueueEntry;
  label: string;
}

/**
 * 버린 항목 가운데 메인 에이전트에게 끝내 전하지 못한 대표의 요청 (리드 결정 30) — 대표 명령·질문 답변(main_command)은 프로젝트와 글 앞부분 40자쯤,
 * 수정 요청(change_request)은 프로젝트와 보고서 ID로 이름 붙인다. 대표가 무엇을 다시 말해야 하는지 알 수 있게
 */
function ownerRequests(ctx: Ctx, entries: readonly QueueEntry[]): OwnerRequest[] {
  return entries.flatMap((q) => {
    if (q.memberId !== MAIN_AGENT_ID || (q.kind !== 'main_command' && q.kind !== 'change_request')) return [];
    const p = q.projectId ? ctx.store.projects.get(q.projectId) : null;
    const where = p ? `${p.name}(${p.id})` : (q.projectId ?? '메인 에이전트 직접');
    if (q.kind === 'change_request') {
      const reportId = q.reportId ?? /보고서 (R-\d+)/.exec(q.message)?.[1] ?? null;
      return [{ q, label: `${where} 보고서${reportId ? ` ${reportId}` : ''} 수정 요청` }];
    }
    // 대표 명령은 '대표 명령 (…):\n<글>\n\n<안내>', 질문 답변은 '질문 Q-…에 대한 답변 (대표): <글>'이다 (다시 넣은 앞말은 뗀다)
    const body = standingBody(q.message);
    const command = /^대표 명령[^\n]*:\n([\s\S]*)$/.exec(body);
    const answer = /^(질문 Q-\d+)에 대한 답변 \([^)]*\): ([\s\S]*)$/.exec(body);
    const text = command ? command[1]!.split('\n\n')[0]! : answer ? answer[2]! : body;
    return [{ q, label: `${where} ${answer ? `${answer[1]} 답변` : '명령'} "${clip(text, 40)}"` }];
  });
}

/** 버린 대표 요청을 적은 한 문장 — 알림 본문 끝에 붙인다 (리드 결정 30). 없으면 '' */
function ownerRequestsText(items: readonly OwnerRequest[]): string {
  return items.length ? `메인 에이전트에게 전하지 못한 대표 요청: ${items.map((x) => x.label).join(', ')} — 필요하면 명령창으로 메인 에이전트에게 다시 말해 주세요` : '';
}

/**
 * 정지 해제 목록(stop_released)이 적은 작업 가운데 아직 긴급 정지 보류인 것 (리드 결정 43) — 작업 ID는 그 항목의 글에서 찾는다(namedTasks처럼 글의 작업 ID).
 * 목록 줄('- T-0001 "제목" — …') 머리의 ID만 본다 — 작업 제목이나 다시 넣기 앞말(CLI 거부 글 등)에 든 다른 작업 ID를 목록으로 읽지 않게. 합친 목록·다시
 * 넣기 앞말이 붙어도 그 줄들은 그대로다. 아무것도 없으면 그 업무는 끝났다(deadWorkReason)
 */
function releasedStillHeld(ctx: Ctx, q: QueueEntry): Task[] {
  const ids = [...new Set([...q.message.matchAll(/^- (T-\d+) /gm)].map((m) => m[1]!))];
  return ids.flatMap((id) => {
    const t = ctx.store.tasks.get(id);
    return t?.state === 'on_hold' && t.hold.reasons.some((r) => r.kind === 'emergency_stop') ? [t] : [];
  });
}

/** 버린 보류 넘김 하나 — 그 항목, 아직 그 보류인 작업, 한 줄 이름 ('긴급 정지 해제 목록 — T-0001 "결제 화면", T-0002 "…"', '검수자 없음 T-0003 "…"') */
interface HeldHandOver {
  q: QueueEntry;
  tasks: Task[];
  label: string;
  /** 메인에게 한 번 더 넘겼다 (alert handover-dropped, reAlertHandOvers — 리드 결정 S5-8) */
  again?: boolean;
}

/**
 * 버린 항목 가운데 메인 에이전트에게 끝내 전하지 못한 보류 넘김 (리드 결정 43) — 서버가 보류를 메인 에이전트에게 업무로 넘긴 정지 해제 목록(stop_released,
 * 대표의 정지 해제가 만든다), 검수자 없음(no_reviewer), 대표에게만 가던 보류·실패를 넘긴 알림 업무(alert, 리드 결정 S5-7). 남는 업무가 아니라 메인이 한 번
 * 받고 정하는 업무다. 그 보류가 이미 풀린 것(deadWorkReason)은 빼고, 아직 그 보류인 작업을 ID와 제목으로 적는다(알림 업무는 그 첫 줄) — 대표가 무엇을
 * 메인에게 말해야 하는지 알 수 있게
 */
function heldHandOvers(ctx: Ctx, entries: readonly QueueEntry[]): HeldHandOver[] {
  const name = (t: Task): string => `${t.id} "${clip(t.title, 40)}"`;
  return entries.flatMap((q) => {
    if (q.memberId !== MAIN_AGENT_ID) return [];
    if (q.kind === 'stop_released') {
      const tasks = releasedStillHeld(ctx, q);
      return tasks.length ? [{ q, tasks, label: `긴급 정지 해제 목록 — ${tasks.map(name).join(', ')}` }] : [];
    }
    if (q.kind === 'alert') {
      if (deadWorkReason(ctx, q)) return [];
      const t = q.taskId ? ctx.store.tasks.get(q.taskId) : null;
      const kind = parseAlertKey(q.alertKey)?.kind;
      return [{ q, tasks: t ? [t] : [], label: `${kind ? ALERT_KIND_LABEL[kind] : WORK_KIND_LABEL.alert} — ${clip(alertHead(q), 120)}` }];
    }
    if (q.kind !== 'no_reviewer' || deadWorkReason(ctx, q)) return [];
    const t = q.taskId ? ctx.store.tasks.get(q.taskId) : null;
    return t ? [{ q, tasks: [t], label: `검수자 없음 ${name(t)}` }] : [];
  });
}

/**
 * 버린 보류 넘김을 적은 한 문장 (리드 결정 43·S5-8) — 다시 넘기지 못한 것(버린 알림 업무, 재시작 상한)은 메인 에이전트에게 다시 가지 않으므로 결정 32의 문장으로,
 * 한 번 더 넘긴 것(again)은 넘긴 사실과 OWNER_HANDED로 끝낸다. 둘 다면 앞 문장에 이어 적는다. 없으면 ''
 */
function heldHandOversText(items: readonly HeldHandOver[]): string {
  const lost = items.filter((x) => !x.again);
  const again = items.filter((x) => x.again);
  return items.length
    ? `${
        lost.length
          ? `메인 에이전트에게 전하지 못한 보류 작업: ${lost.map((x) => x.label).join('; ')} — 어떻게 할지 명령창으로 메인 에이전트에게 알려 주세요. 메인 에이전트가 확인하고 이어 갑니다${
              again.length ? `. 메인 에이전트에게 다시 넘긴 보류 작업: ${again.map((x) => x.label).join('; ')}` : ''
            }`
          : `메인 에이전트에게 다시 넘긴 보류 작업: ${again.map((x) => x.label).join('; ')} — ${OWNER_HANDED}`
      }`
    : '';
}

/** 버림 알림 끝에 붙이는 글 — 버린 대표 요청 문장, 그다음 버린 보류 넘김 문장 (리드 결정 30·43). 둘 다 없으면 '' */
function lostText(owner: readonly OwnerRequest[], held: readonly HeldHandOver[]): string {
  return [ownerRequestsText(owner), heldHandOversText(held)].filter(Boolean).join('. ');
}

/**
 * 버림 알림의 key (리드 결정 36·43) — 대표 요청이나 보류 넘김을 버렸으면 세션 key 뒤에 그 버림의 첫 대표 요청(없으면 첫 보류 넘김) 항목 ID를 붙인다
 * ('crash:main:P-0001:W-000123'). ctx.notify는 같은 key의 읽지 않은 알림을 덮어쓰므로, 세션 key 하나면 같은 세션의 다음 버림이 앞에서 버린 것의 이름을
 * 지우고 OS 알림도 띄우지 않는다. 둘 다 없는 버림은 세션 key 그대로다(덮어써도 된다). 앞말(crash:·start-fail:·spin:)은 그대로라 화면이 앞말로 묶는다
 * (리드 결정 41)
 */
function dropNoticeKey(prefix: 'crash' | 'start-fail' | 'spin', sessionKey: string, owner: readonly OwnerRequest[], held: readonly HeldHandOver[] = []): string {
  const first = owner[0]?.q ?? held[0]?.q;
  return first ? `${prefix}:${sessionKey}:${first.id}` : `${prefix}:${sessionKey}`;
}

/**
 * 버린 대표 요청마다 활동 기록 한 줄 (리드 결정 36) — 프로젝트, 종류, 글 앞부분이나 보고서 ID. 대표가 알림을 읽은 뒤에도 무엇이 메인 에이전트에게 닿지
 * 못했는지 남는다. why: 버린 까닭
 */
function noteOwnerRequestsLost(ctx: Ctx, owner: readonly OwnerRequest[], why: string): void {
  for (const { q, label } of owner) {
    ctx.activity({
      kind: q.kind === 'change_request' ? 'report' : 'message',
      level: 'warn',
      projectId: q.projectId,
      directiveId: q.directiveId,
      memberId: q.memberId,
      text: `메인 에이전트에게 전하지 못한 대표 요청: ${label} — ${why} (${q.id}, 다시 전달하지 않음)`,
    });
  }
}

/**
 * 버린 보류 넘김마다 활동 기록 한 줄 (리드 결정 43, 대표 요청의 noteOwnerRequestsLost처럼) — 알림을 읽은 뒤에도 어느 보류가 메인 에이전트에게 닿지 못했는지
 * 남는다. 그 항목은 취소로 둔다: 비정상 종료 상한·헛돌기로 버린 항목은 턴이 마친(done) 채 남는데, 화면의 reachesMain은 같은 대상의 가장 최근 항목이 취소인지로
 * 그 보류가 아직 메인에게 있는지 본다(overview.ts holdReach — 대표 할 일·작업 화면·현황이 같은 판정). why: 버린 까닭
 */
function noteHeldHandOversLost(ctx: Ctx, items: readonly HeldHandOver[], why: string): void {
  for (const { q, tasks, label, again } of items) {
    const cur = ctx.store.queue.get(q.id);
    if (cur && cur.state !== 'cancelled') ctx.store.queue.put({ ...cur, state: 'cancelled', doneAt: ctx.now() });
    const one = tasks.length === 1 ? tasks[0]! : null;
    ctx.activity({
      kind: q.kind === 'stop_released' ? 'stop' : q.kind === 'alert' ? (one ? 'task' : 'system') : 'review',
      level: 'warn',
      projectId: q.projectId ?? one?.projectId ?? null,
      directiveId: q.directiveId ?? one?.directiveId ?? null,
      taskId: one?.id ?? null,
      memberId: q.memberId,
      // 한 번 더 넘긴 보류 넘김은 그렇게 남긴다 — 버린 알림 업무는 다시 넘기지 않는다 (리드 결정 S5-8)
      text: again ? `메인 에이전트에게 다시 넘긴 보류 작업: ${label} — ${why} (${q.id})` : `메인 에이전트에게 전하지 못한 보류 작업: ${label} — ${why} (${q.id}, 다시 전달하지 않음)`,
    });
  }
}

/**
 * 대상이 끝난 업무(deadWorkReason)를 지운다 — 대기·실행·마친 항목 모두 '취소'로 두고 까닭을 활동 기록에 남긴다. 다시 전달하지 않는다 (리드 결정 19).
 * 더 새 대기 항목에 밀려 버리는 알림 업무의 보류가 아직 남아 있으면 그 글을 더 새 항목에 옮겨 싣는다 (alerts.carrySupersededAlert, 리드 결정 S5-44)
 */
export function dropDeadWork(ctx: Ctx, q: QueueEntry, why: string): void {
  ctx.store.tx(() => {
    const carried = q.kind === 'alert' ? carrySupersededAlert(ctx, q) : null;
    if (q.state !== 'cancelled') ctx.store.queue.put({ ...q, state: 'cancelled', doneAt: ctx.now() });
    noteMessagesUndelivered(ctx, [q], why);
    ctx.activity({
      kind: q.kind === 'change_request' || q.kind === 'main_report' ? 'report' : q.pausedMemberId || q.kind === 'stop_released' ? 'stop' : 'review',
      projectId: q.projectId,
      directiveId: q.directiveId,
      taskId: q.taskId,
      memberId: q.memberId,
      text: `끝난 일의 ${WORK_KIND_LABEL[q.kind]} 업무 정리 — ${why} (${q.sessionKey}, 다시 전달하지 않음${carried ? ` — 아직 남은 그 보류의 글은 ${carried}에 함께 실음` : ''})`,
    });
  });
  ctx.bus.changed();
}

/** 제한 시간 안에 끝났으면 true (끝나지 않은 약속은 그대로 계속된다) */
async function settlesWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p.then(() => true), new Promise<boolean>((r) => (timer = setTimeout(() => r(false), Math.max(0, ms))))]);
  } finally {
    clearTimeout(timer);
  }
}

// ───────────────────────── 스케줄러 ─────────────────────────

export class Scheduler {
  private ticking = false;
  private again = false;
  private timer: NodeJS.Timeout | null = null;
  private wake: { at: number; timer: NodeJS.Timeout } | null = null;
  private off: (() => void) | null = null;

  constructor(private readonly core: Core) {}

  start(): void {
    this.off = this.core.ctx.bus.onSignal('tick', () => this.tick());
    this.timer = setInterval(() => this.tick(), 2000);
    this.timer.unref?.();
    this.tick();
  }

  stop(): void {
    this.off?.();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.wake) clearTimeout(this.wake.timer);
    this.wake = null;
  }

  /**
   * 그때 한 번 더 본다 (계획 중인 지시가 막 만든 작업의 기다림이 끝나는 때 — 2초 주기를 기다리지 않게). 더 이른 예약이 있으면 그것으로 충분하다.
   * 자동 실행(start)이 꺼져 있으면 예약하지 않는다 — 그때는 부르는 쪽이 tick을 정한다
   */
  private wakeAt(atMs: number): void {
    if (!this.timer || (this.wake && this.wake.at <= atMs)) return;
    if (this.wake) clearTimeout(this.wake.timer);
    const timer = setTimeout(
      () => {
        this.wake = null;
        this.tick();
      },
      Math.max(0, atMs - this.core.ctx.clock.ms()) + 20,
    );
    timer.unref?.();
    this.wake = { at: atMs, timer };
  }

  tick(): void {
    if (!this.core.started || this.core.stopping) return;
    if (this.ticking) {
      this.again = true;
      return;
    }
    this.ticking = true;
    try {
      this.runOnce();
    } catch (e) {
      this.core.ctx.log('error', '스케줄러 오류', e);
    } finally {
      this.ticking = false;
      if (this.again) {
        this.again = false;
        setImmediate(() => this.tick());
      }
    }
  }

  private runOnce(): void {
    const ctx = this.core.ctx;
    const stop = ctx.stop();
    if (stop.global.active) return;
    // 외부 보유자의 임대가 끝났는지 — 끝났으면 돌던 턴을 비정상 종료로 다시 넣고 자리를 응답 없음으로 (리드 결정 S7-4). 5초 타이머도 본다
    this.core.externalAgents.sweep();
    // 메인 자리 보유자의 응답 없음 — 쌓인 메인 일을 그 AI 종류가 받을 수 없는지 보고, 5분·30분·2시간에 대표에게 다시 알린다. 긴급 정지 중에는 세지도 알리지도
    // 않는다(바로 위에서 돌아간다). 서버는 자리를 바꾸지 않는다 (SERVER_DESIGN 4.4, 리드 결정 S4-5)
    this.core.seat.watch();
    // 재개 업무를 대표에게 넘긴 뒤에도 일시정지된 팀원에게 새 업무가 왔다 — 메인 에이전트에게 한 번 알린다 (리드 결정 35·S5-8)
    this.core.turns.alertPausedMembers();
    const nowMs = ctx.clock.ms();
    const candidates: StartCandidate[] = [];
    const eligibleByKey = new Map<string, string[]>();

    // 1) 대기열 항목 (세션 키별 묶음)
    const groups = new Map<string, QueueEntry[]>();
    for (const q of ctx.store.queue.list({ state: 'queued' })) {
      const g = groups.get(q.sessionKey) ?? [];
      g.push(q);
      groups.set(q.sessionKey, g);
    }
    for (const [key, queued] of groups) {
      if (this.core.turns.hasLiveSession(key)) continue;
      const { kind, ref } = parseKey(key);
      const sessionTask = kind === 'task' || kind === 'review' ? ctx.store.tasks.get(ref) : null;
      // 취소·종료된 지시의 일(그 지시 세션의 관리 업무, 그 지시 작업의 작업·검수 세션)은 실행하지 않고 지운다 (TSK-09 예약된 턴 취소, AC-46).
      // 지시가 닫힌 뒤에도 끝까지 가는 되돌리기 작업(종료된 지시의 되돌리기, 지시 취소 뒤에 요청한 별도 되돌리기)의 일은 예외
      const dead = queued.filter((q) =>
        kind === 'directive' ? closedDirectiveWork(ctx, ref, q.taskId ? ctx.store.tasks.get(q.taskId) : null) : !!sessionTask && closedDirectiveWork(ctx, null, sessionTask),
      );
      if (dead.length) {
        const ids = new Set(dead.map((q) => q.id));
        cancelQueued(ctx, (q) => ids.has(q.id), '그 업무의 지시가 취소·종료됨');
        ctx.activity({ kind: 'directive', level: 'warn', projectId: dead[0]!.projectId, directiveId: dead[0]!.directiveId ?? sessionTask?.directiveId ?? null, text: `취소·종료된 지시의 대기 업무 ${dead.length}건 정리 (${key}: ${[...new Set(dead.map((q) => q.kind))].join(', ')})` });
      }
      // 검수 세션: 다른 버전(이전 고정)에 묶인 검수 항목은 지금 버전 검수 턴에 싣지 않고 지운다 — 이전 버전의 사본 위치·완료 조건이 새 버전 검수
      // 요청에 섞이지 않게 (REV-07·08). 시작 중에 멈춘 턴이 되돌린 항목·재시작 복구가 되돌린 항목도 여기서 걸러진다
      const pin = kind === 'review' && sessionTask?.state === 'in_review' ? sessionTask.review.target?.pinnedAt : undefined;
      const stale = pin ? queued.filter((q) => q.kind === 'review' && !!q.reviewPinnedAt && q.reviewPinnedAt !== pin) : [];
      if (stale.length) {
        const ids = new Set(stale.map((q) => q.id));
        cancelQueued(ctx, (q) => ids.has(q.id), '이전 버전의 검수 업무');
        ctx.activity({ kind: 'review', projectId: sessionTask!.projectId, taskId: sessionTask!.id, text: `${sessionTask!.id} 이전 버전의 검수 업무 ${stale.length}건 정리 — 지금 고정된 버전 검수에 싣지 않음` });
      }
      // 대상이 이미 끝난 업무(대표가 그대로 승인해 거둬들인 수정 요청, 풀린 '검수자 없음', 검수 단계를 벗어난 작업의 재배정 등)도 띄우지 않고 지운다 —
      // 메인 에이전트 세션까지 본다. 다시 넣기·재시작 복구와 같은 판정이다 (deadWorkReason, 리드 결정 19)
      const ended: QueueEntry[] = [];
      const busy = (taskId: string): boolean => this.core.tasks.reviewPending(taskId);
      for (const q of queued) {
        if (dead.some((x) => x.id === q.id) || stale.some((x) => x.id === q.id)) continue;
        const why = deadWorkReason(ctx, q, busy);
        if (!why) continue;
        dropDeadWork(ctx, q, why);
        ended.push(q);
      }
      // 남는 업무의 다시 전달(전달 횟수 1 이상): 메인 에이전트가 그 일로 시작한 진행(대표에게 한 질문, 팀원에게 보낸 지시)이 아직 끝나지 않았으면 이번에는
      // 싣지 않고 기다린다(세지 않는다). 진행이 끝났는데 이미 세 번 전달했으면 다시 싣지 않고 대표에게 알린다 (리드 결정 31). 틱마다 다시 본다
      const parked: QueueEntry[] = [];
      if (kind === 'main_project' || kind === 'main_general') {
        for (const q of queued) {
          if (ended.includes(q) || !isStandingItem(q) || (q.deliveries ?? 0) < 1) continue;
          if (this.core.turns.mainProgressPending(q.projectId)) parked.push(q);
          else if ((q.deliveries ?? 0) >= MAIN_STANDING_DELIVERIES) {
            this.core.turns.giveUpStanding(q);
            ended.push(q);
          }
        }
      }
      const entries = queued.filter((q) => !dead.some((x) => x.id === q.id) && !stale.some((x) => x.id === q.id) && !ended.includes(q) && !parked.includes(q));
      if (!entries.length) continue;
      // 끝난 작업의 작업·검수 세션으로 남은 일은 실행될 일이 없다 — 완료 정리(merges.afterComplete) 뒤에 들어온 것 (산출물 확정 직후 아직 끝나지
      // 않은 검수 턴으로 온 대표 메시지 등). 남겨 두면 '전달 대기'로 영영 남으므로 지우고, 대표 메시지는 알린다
      if (sessionTask && isTerminal(sessionTask.state)) {
        const ids = new Set(entries.map((q) => q.id));
        cancelQueued(ctx, (q) => ids.has(q.id), `${sessionTask.id}이(가) 이미 ${sessionTask.state === 'done' ? '완료' : '취소'}돼 그 업무 세션이 더 이어지지 않음`);
        ctx.activity({ kind: 'task', level: 'warn', projectId: sessionTask.projectId, taskId: sessionTask.id, text: `${sessionTask.id} ${sessionTask.state === 'done' ? '완료' : '취소'} 뒤 남은 업무 ${entries.length}건 정리 (${key}: ${[...new Set(entries.map((q) => q.kind))].join(', ')})` });
        continue;
      }
      // 담당은 지금 기준: 프로듀서 교체로 삭제된 팀원 몫 항목은 후임이 실행한다 — 낡은 항목 하나가 세션 키 전체를 막지 않게 (CONC-04)
      const member = memberOrSuccessor(ctx, entries[entries.length - 1]!.memberId);
      if (!member) continue;
      // 프로듀서 교체가 그 프로듀서의 정지와 그 마무리를 기다리는 동안은 그 팀원의 새 턴을 띄우지 않는다 — 일은 대기열에 남는다 (리드 결정 S5-73 1)
      if (this.core.turns.launchHeld(member.id)) continue;
      // 메인 자리가 교체 중이거나 비었으면 M-MAIN 일(main:*·메인 검수 review:*)을 새로 시작하지 않는다 — 일은 대기열에 남아 새 보유자에게 간다
      // (SERVER_DESIGN 4.3 1번·7번, 리드 결정 S4-2: 어느 순간에도 메인 턴은 하나 이하)
      // 외부 보유자는 그 에이전트가 일을 받으러 와 있을 때만(살아 있는 임대와 열린 롱폴) — 고르는 쪽은 여전히 스케줄러 하나다 (리드 결정 S7-4)
      if (member.isMain && !this.core.seat.runsMain() && !this.core.seat.externalReady()) continue;
      if (kind === 'task') {
        // 작업 세션은 진행 중일 때만: 대기는 활성화 경로에서, 검수 중에는 검수 대상인 작업 폴더를 고치지 않게
        // 재작업(반려·재고정)될 때까지 미룬다 — 그때 다음 할 일과 함께 전달 (REV-08, F12). 보류·종료는 허용 검사가 막는다
        if (!sessionTask || sessionTask.state !== 'in_progress') continue;
        if (sessionTask.assigneeId !== member.id) continue;
        // 되돌리기 커밋을 아직 기록하지 못한 되돌리기 작업의 작업 폴더에는 턴을 띄우지 않는다 — 프로그램이 되돌린다 (CLI-09, AC-12)
        if (this.core.merges.revertPending(sessionTask)) continue;
        // 제출 처리(최신 main 반영·자동 검사·대상 고정)·병합 처리 중에는 이 작업 폴더에 새 턴을 띄우지 않는다.
        // 처리가 끝나면 tick으로 바로 다시 본다 (5.3 진행→검수: 작업자 턴이 끝난 뒤 대상 고정, CONC-03)
        if (this.core.tasks.isSubmitting(ref) || this.core.merges.isPending(ref)) continue;
      } else if (kind === 'review') {
        // 검수 세션은 검수 중일 때만 (고정된 대상의 읽기 사본에서 돈다). 재작업·재배정으로 대상이 지워진 뒤의 낡은 항목은 띄우지 않는다
        if (!sessionTask || sessionTask.state !== 'in_review') continue;
      }
      // 허용 검사: 모의 실행이면 AI를 보지 않고, 모델별 주간 한도는 이 턴이 쓸 모델로 본다 (리드 결정 22). 메인 에이전트의 진행 판정도 같은 검사를 쓴다 (리드 결정 38)
      const gi = this.core.turns.gateAi(member, key);
      const eligible = entries.filter((e) => this.core.turns.entryRunGate(member, key, sessionTask, e, stop, nowMs, gi).ok);
      // 대표 메시지 공유 사본만 있는 세션은 띄우지 않는다 — 그 세션에 다른 일이 생겨 턴이 뜰 때 함께 전달한다 (CTL-05, AC-17).
      // 순서(우선순위·대기 시각)도 턴을 띄우는 일로만 정한다
      const driving = eligible.filter((e) => !e.ownerShared);
      if (!driving.length) continue;
      eligibleByKey.set(key, eligible.map((e) => e.id));
      candidates.push({
        sessionKey: key,
        memberId: member.id,
        slotClass: slotClassOf(key),
        priority: driving.reduce((best, e) => (PRIORITY_RANK[e.priority] < PRIORITY_RANK[best] ? e.priority : best), driving[0]!.priority),
        queuedAt: driving.reduce((min, e) => (e.queuedAt < min ? e.queuedAt : min), driving[0]!.queuedAt),
        urgent: driving.some((e) => e.urgent),
      });
    }

    // 2) 대기 작업 활성화 후보 (팀원당 1개, TSK-05). 취소·종료된 지시의 작업(지시 취소가 취소하는 중)과 프로그램이 이어 가는
    //    되돌리기 작업은 담당에게 작업 카드로 주지 않는다 (AC-46, AC-12)
    const best = new Map<string, Task>();
    // 계획 중인 지시가 막 만든 작업은 잠깐(PLAN_SETTLE_MS) 기다린다 — 곧이어 만드는 작업이 모이면 같은 차례에 우선순위 → 대기 등록 순으로 시작한다. 작업
    // 폴더 만들기는 저장소마다 차례로 하므로(gitService) 이 순서가 그대로 활성화 순서다 (TSK-05, 5.7, S7-B7). 고르기 전에 빼므로 그 팀원의 다른 대기 작업
    // (다른 지시 등)은 기다리지 않고 시작한다. 기다림이 끝나는 때에 다시 본다 (S8-B2)
    const settle = new Map<string, number | null>();
    let wakeAt = Infinity;
    for (const t of ctx.store.tasks.list({ state: 'waiting' })) {
      if (this.core.merges.revertPending(t) || closedDirectiveWork(ctx, null, t)) continue;
      if (!settle.has(t.directiveId)) settle.set(t.directiveId, this.core.turns.planSettleUntil(t.directiveId, nowMs));
      const until = settle.get(t.directiveId)!;
      if (until !== null) {
        wakeAt = Math.min(wakeAt, until);
        continue;
      }
      const cur = best.get(t.assigneeId);
      if (cur && (PRIORITY_RANK[cur.priority] < PRIORITY_RANK[t.priority] || (cur.priority === t.priority && cur.queuedAt <= t.queuedAt))) continue;
      if (!prereqsDone(ctx, t)) continue;
      best.set(t.assigneeId, t);
    }
    // 되돌리기 작업의 프로그램 단계(작업 폴더 → 되돌리기 커밋)가 남았으면 이어 간다 — 정지·보류가 풀렸거나 재시작 뒤 (GIT-15). 턴이 아니라 자리를 쓰지 않는다
    // 취소 선택이 저장된 지시의 되돌리기(지시 취소 전부터 있던 것)는 이어 가지 않는다 — 지시 취소가 그 작업을 취소하는 중이다 (AC-46, S7-B6)
    for (const t of ctx.store.tasks.list({ state: ['waiting', 'in_progress'] })) {
      if (t.type !== 'revert' || this.core.merges.isPending(t.id) || this.core.tasks.isCancelling(t.id) || closedDirectiveWork(ctx, null, t)) continue;
      if (this.core.merges.revertPending(t) && this.core.stops.runAllowedForTask(t)) void this.core.merges.resumeRevert(t.id);
    }
    for (const t of best.values()) {
      const member = ctx.store.members.get(t.assigneeId);
      if (!member || member.deletedAt || this.core.turns.launchHeld(member.id)) continue;
      if (activeTaskOf(ctx, member.id)) continue;
      if (this.core.turns.hasLiveSession(`task:${t.id}`)) continue;
      const project = ctx.store.projects.get(t.projectId);
      const mock = !!project?.mock.enabled;
      const ai = mock ? null : ctx.ai(member.ai.kind);
      const model = ai ? this.core.turns.gateModel(member, `task:${t.id}`) : null;
      const gate = checkRunGate({ stop, member, kind: 'task_work', task: t, taskBound: true, recoveryPending: false, ai, model, prereqsDone: true, nowMs });
      if (!gate.ok) continue;
      candidates.push({ sessionKey: `task:${t.id}`, memberId: member.id, slotClass: 'general', priority: t.priority, queuedAt: t.queuedAt, urgent: false, activateTaskId: t.id });
    }

    if (wakeAt < Infinity) this.wakeAt(wakeAt);
    if (!candidates.length) return;
    const picks = pickStarts({ cap: ctx.settings().execution.maxConcurrent, running: this.core.turns.running(), candidates });
    for (const p of picks) this.core.turns.launch(p, eligibleByKey.get(p.sessionKey) ?? []);
  }
}
