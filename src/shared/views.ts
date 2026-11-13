/**
 * 화면(renderer)이 받는 데이터 형식.
 * main 프로세스가 DB 상태로부터 만들어 IPC로 보낸다. 화면은 이 타입만 의존한다.
 */
import type {
  ActivityKind,
  Actor,
  AiConfig,
  AiKind,
  AnchoredComment,
  Attachment,
  AutoCheckStatus,
  CriterionResult,
  DirectiveId,
  DirectiveState,
  EffortTier,
  ExternalAgentId,
  HoldReasonKind,
  IsoTime,
  MemberId,
  MockScenario,
  ModelLimitFamily,
  NavTarget,
  NotificationLevel,
  OutputMode,
  OwnerRef,
  Priority,
  ProjectId,
  ReportId,
  ReportSections,
  ReportStats,
  ReportStatus,
  RoleCreator,
  RoleId,
  RunnerKind,
  SessionKind,
  StopMode,
  TaskId,
  TaskState,
  TaskType,
  TurnEndReason,
  WorkKind,
} from './domain';
import type { CliEvent } from './events';

/** 팀원 상태 (5.4). 겹치면 paused → error → awaiting_answer → working → idle 순으로 대표 상태 */
export type MemberStatus = 'working' | 'idle' | 'awaiting_answer' | 'paused' | 'error';

export interface ProgressView {
  /** 완료 단계 수 */
  done: number;
  /** 전체 단계 수 (5.5 — 단계 없는 작업은 지시 진행도에서 1로 계산) */
  total: number;
  /** 0~1 */
  ratio: number;
}

// ───────────────────────── 스냅샷 (화면 전체 상태) ─────────────────────────
export interface AppSnapshot {
  /** 바뀔 때마다 증가 */
  version: number;
  generatedAt: IsoTime;
  auth: AuthState;
  stop: StopView;
  projects: ProjectView[];
  /** 메인 에이전트 포함 (projectId null, isMain true) */
  members: MemberView[];
  /** 종료·취소되지 않은 지시 + 최근 7일 안에 끝난 지시 */
  directives: DirectiveView[];
  /** 위 지시들의 작업 */
  tasks: TaskView[];
  /** 대표 할 일 (HOME-02) */
  ownerTodos: OwnerTodo[];
  notifications: { unread: number; urgentUnread: number };
  /** 최근 활동 30건 (HOME-03) */
  recentActivity: ActivityView[];
  ai: AiStatusView[];
  running: RunningView;
  /** 트레이 아이콘 상태 (ENV-10) */
  trayStatus: TrayStatus;
  roles: RoleView[];
  /** 지금 메인 자리 (SERVER_DESIGN 4.1, 리드 결정 S4-10) — 상단 보유자 표시·응답 없음 띠가 이것으로 바로 바뀐다. 로그인 전에는 LOCKED_SEAT (S4-11) */
  seat: SeatView;
}

export type TrayStatus = 'normal' | 'awaiting' | 'paused' | 'error' | 'emergency';

export interface RunningView {
  /** 실행 중인 CLI 턴 수 (전체) */
  total: number;
  general: number;
  management: number;
  /** 전체 상한 N */
  cap: number;
  /** 일반 작업 상한 (N≥2면 N-1) */
  generalCap: number;
  queued: number;
}

export interface StopView {
  global: { active: boolean; since: IsoTime | null };
  /** by: 누가 걸었는지 (owner·system 등), reason: 프로그램이 건 정지의 까닭 — 둘 다 없을 수 있다 */
  pausedProjects: { projectId: ProjectId; since: IsoTime; mode: StopMode; by?: Actor; reason?: string }[];
  pausedMembers: { memberId: MemberId; since: IsoTime; mode: StopMode; by?: Actor; reason?: string }[];
  /** 마지막 긴급 정지 요약 (CTL-04) */
  lastEmergency: EmergencySummary | null;
  /** 전역 정지 해제 후에도 항목별 재개를 기다리는 작업 수 (CTL-10) */
  heldByEmergency: number;
}

export interface EmergencySummary {
  at: IsoTime;
  /** 3초 안에 모든 CLI·하위 프로세스 종료를 확인했는지 (CTL-03) */
  completed: boolean;
  stoppedTurns: { turnId: string; memberId: MemberId; memberName: string; taskId: TaskId | null; ok: boolean; detail: string }[];
  /** 중간 상태로 보류된 작업 */
  heldTasks: { taskId: TaskId; title: string; previousState: TaskState; projectId: ProjectId }[];
  /**
   * 종료 확인 실패. remaining -1: 남은 프로세스를 확인하지 못한 실패(작업 개체를 읽지 못함 등). 값이 없으면 남은 프로세스를 센 실패다 — 그 수는
   * detail에 있다(이전 버전 요약도 같은 뜻). 화면은 이 값으로 '남은 프로세스가 있습니다'와 '확인하지 못했습니다'를 가른다 (S8-D3).
   * memberName: 이름이 겹치는 다른 팀원이 있으면 프로젝트 이름을 붙인 이름 — 예: 서진(B 프로젝트) (S8-D1)
   */
  failures: { memberId: MemberId; memberName: string; detail: string; remaining?: number }[];
}

export interface AuthState {
  loggedIn: boolean;
  owner: { email: string; name: string } | null;
  /** 구글 로그인 설정(클라이언트 ID)이 되어 있는지 */
  googleConfigured: boolean;
  /** 구글 로그인 보안 비밀이 OS 보안 저장소에 등록되어 있는지. 로그인 화면은 ID와 이 값이 모두 있어야 설정 완료로 본다 */
  googleSecretSet: boolean;
  /**
   * 대표(구글 계정)가 등록되어 있는지 — 로그인 전에도 알려 준다.
   * 등록 전에는 로그인 없이 구글 설정을 다시 넣을 수 있으므로(잘못 넣은 ID·비밀 복구) 로그인 화면이 다시 입력 경로를 남긴다
   */
  ownerRegistered: boolean;
  /** 개발 모드 로그인 허용 (패키징되지 않은 실행에서만) */
  devLoginAllowed: boolean;
  /**
   * 로그인 없이 구글 로그인 설정(클라이언트 ID·보안 비밀)을 받는지 — 로그인 화면이 설정 입력란을 보여 줄지 정한다. 대표 등록 전이면 늘 true.
   * 대표가 있어도 지금 설정이 대표 로그인으로 확인되지 않았으면 true: 클라이언트 ID 없음, 마지막 대표 로그인 뒤 바뀜(잘못 넣은 값으로 대표가
   * 갇히지 않게), 등록해 둔 보안 비밀이 OS 보안 저장소에서 사라짐. false면 지금 설정으로 대표가 로그인한 적이 있다 (보안 비밀 없이 로그인한
   * 설정 포함 — 로그인 단추를 막지 않는다). 로그인은 그래도 등록된 대표 계정으로만 된다.
   * 선택 항목: 없으면(예전 백엔드·가짜 백엔드) !ownerRegistered로 본다
   */
  googleSetupOpen?: boolean;
  /**
   * 로그인 방식 (SERVER_DESIGN 3.5, S3-2): 'desktop'은 이 PC의 브라우저로 구글 로그인(auth.login), 'server'는 기기 코드 로그인
   * (auth.deviceLogin → auth.deviceLoginPoll)과 기기별 세션이다. 없으면(예전 백엔드) 'desktop'
   */
  mode?: 'desktop' | 'server';
  /** 서버에서 대표 이메일이 아직 정해지지 않아 로그인을 열지 않는지 — 설정 코드와 대표 이메일을 넣는 화면(auth.setupOwner)을 보인다 (S3-6). 없으면 false */
  setupRequired?: boolean;
}

/** 기기 코드 로그인 시작 (auth.deviceLogin, SERVER_DESIGN 3.5·S3-5) — device_code는 서버만 가진다. 화면은 이 값으로 코드를 크게 보여 준다 */
export interface DeviceLoginStart {
  /** 이 로그인을 가리키는 값 — auth.deviceLoginPoll에 넘긴다. 시작한 브라우저에만 결과가 간다 */
  loginId: string;
  /** 대표가 휴대폰에서 넣을 코드 (예: 'ABCD-EFGH') */
  userCode: string;
  /** 코드를 넣는 주소 (예: https://www.google.com/device) */
  verificationUrl: string;
  /** 이 코드가 끝나는 때 */
  expiresAt: IsoTime;
  /** 결과를 물을 간격(초) — 서버가 늘릴 수 있다 */
  intervalSec: number;
}

/** 기기 코드 로그인 결과 (auth.deviceLoginPoll) — 'ok'면 서버가 그 응답으로 이 브라우저에 기기 세션을 준다. 세션 값은 화면에 오지 않는다 */
export interface DeviceLoginPoll {
  status: 'pending' | 'ok' | 'denied' | 'expired' | 'error';
  /** 사람이 읽는 까닭 (거부·만료·오류일 때) */
  message?: string;
  /** 'ok'일 때 로그인 뒤 상태 */
  auth?: AuthState;
  /** 'pending'일 때 다음에 물을 간격(초) — 구글이 slow_down을 보내 서버가 늘린 값. 없으면 시작 때 받은 intervalSec를 그대로 쓴다 */
  intervalSec?: number;
}

/** 대표의 기기 세션 하나 (auth.listDevices, SERVER_DESIGN 3.5·S3-4) — 세션 값·해시는 오지 않는다 */
export interface DeviceSessionView {
  id: string;
  /** 기기 이름 (로그인 때 화면이 넘긴 이름, 없으면 브라우저에서 짐작한 이름) */
  deviceName: string;
  /** Tailscale 사용자 (tailscale serve가 붙인 값, 없으면 null) */
  tailscaleLogin: string | null;
  createdAt: IsoTime;
  lastUsedAt: IsoTime;
  /** 이대로 쓰지 않으면 끝나는 때 (쉬다가 14일, 최대 90일 가운데 이른 쪽) */
  expiresAt: IsoTime;
  /** 이 목록을 부른 기기인지 */
  current: boolean;
}

export interface ProjectView {
  id: ProjectId;
  name: string;
  path: string;
  baseBranch: string;
  createdAt: IsoTime;
  paused: boolean;
  pauseMode: StopMode | null;
  mock: { enabled: boolean; speed: number; defaultScenario: MockScenario };
  producerId: MemberId;
  checkCommands: string[];
  networkPolicy: 'allow' | 'restricted';
  /** 원격 올리기·배포 설정 (GIT-12) */
  deploy: { pushRemote: string | null; deployCommand: string | null };
  /** 진행 중 지시 수 (HOME-01) */
  activeDirectiveCount: number;
  /** 진행 중 지시 전체의 진행도 */
  progress: ProgressView;
  memberStatusCounts: Record<MemberStatus, number>;
  latestReport: { id: ReportId; title: string; createdAt: IsoTime; status: ReportStatus } | null;
}

export interface MemberView {
  id: MemberId;
  projectId: ProjectId | null;
  name: string;
  roleId: RoleId;
  roleName: string;
  isProducer: boolean;
  isMain: boolean;
  canReview: boolean;
  /**
   * effortValue = CLI에 넘기는 노력치. modelValue = CLI에 넘기는 모델 — model이 null이면 Codex는 모델 목록 첫 항목,
   * Claude는 null(CLI 기본). 대표 개인 Codex 설정을 읽지 않으므로 '기본 모델'이 실제로 무엇인지 보여 준다 (windows:F1)
   */
  ai: AiConfig & { effortValue: string; modelValue?: string | null; mock: boolean; mockScenario: MockScenario | null };
  /** 진행 중 작업 뒤 적용 예정인 설정 변경이 있는지 */
  pendingAiChange: AiConfig | null;
  /** AI 설정을 마지막으로 정한 주체·사유 (메인 에이전트 판단 또는 대표) */
  aiDecision?: { byName: string; byOwner: boolean; reason: string; at: IsoTime } | null;
  status: MemberStatus;
  /** 상태 사유 (한국어 문장). 첫 항목이 대표 사유 */
  statusReasons: string[];
  /** 현재 활성 일반 작업 */
  currentTask: {
    id: TaskId;
    title: string;
    state: TaskState;
    progress: ProgressView;
    /** 진행 중인 단계 제목 */
    currentStep: string | null;
    inReview: boolean;
    branch: string | null;
  } | null;
  /** 지금 실행 중인 업무 */
  currentWork: { kind: WorkKind; label: string; turnId: string; startedAt: IsoTime } | null;
  queuedCount: number;
  /** 누적 가동 시간(초) */
  runSeconds: number;
  currentSessionId: string | null;
  lastActivityAt: IsoTime | null;
  /** 말풍선용 최근 한 줄 */
  lastLine: string | null;
  deleted: boolean;
}

export interface DirectiveView {
  id: DirectiveId;
  projectId: ProjectId | null;
  title: string;
  text: string;
  round: number;
  state: DirectiveState;
  createdAt: IsoTime;
  updatedAt: IsoTime;
  progress: ProgressView;
  taskIds: TaskId[];
  latestReportId: ReportId | null;
  attachments: Attachment[];
}

export interface HoldReasonView {
  kind: HoldReasonKind;
  /** 한국어 라벨 (예: '답변 대기', '긴급 정지') */
  label: string;
  note: string;
  since: IsoTime;
  /** 보류를 건 범위 (전체·프로젝트·팀원·작업) — 일시정지 보류를 어디서 풀지(팀원 재개·프로젝트 재개) 고를 때. 선택 항목 */
  scope?: 'global' | 'project' | 'member' | 'task' | null;
  /** 관련 ID (질문 ID, 'rejudge' 다시 판정 보류 등). 선택 항목 */
  refId?: string | null;
  /**
   * 이 보류가 메인 에이전트에게 처리할 일로 가 있는가 — 그 보류의 가장 최근 메인 업무(검수자 없음·정지 해제 목록·alert)가 있고 취소(상한에서 버림 포함)되지
   * 않았으면 true('메인 에이전트가 처리 중'), 버려졌거나 없으면 false(대표가 명령창으로 알려야 한다). 대표가 풀 보류(답변 대기 등)·메인에게 가지 않는
   * 보류는 false (SERVER_DESIGN 5.3, 리드 결정 S5-7·S5-3). 없으면(이전 서버) 모름
   */
  reachesMain?: boolean;
}

/** 자동 검사 실행 한 번 (TaskDetail.checkRuns) — 출력 전문은 TaskView.review.autoCheckDetail */
export interface CheckRunView {
  requestId: string;
  command: string;
  state: 'started' | 'succeeded' | 'failed' | 'unknown';
  startedAt: IsoTime;
  endedAt: IsoTime | null;
  exitCode: number | null;
  timedOut: boolean;
  /** 남은 프로세스 수: 0이면 없음, -1이면 확인하지 못함, null이면 기록 없음(종료 확인됨) */
  remaining: number | null;
  /** 확인하지 못한 검사를 대표가 재개로 확인한 시각 — 이 결과를 다시 썼다 (없으면 null) */
  ownerConfirmedAt: IsoTime | null;
  /** 검사 뒤 커밋되지 않고 남은 파일 (확인하지 못한 검사 보류 때 기록) */
  leftFiles: string[];
}

export interface TaskView {
  id: TaskId;
  projectId: ProjectId;
  directiveId: DirectiveId;
  round: number;
  title: string;
  goal: string;
  type: TaskType;
  priority: Priority;
  state: TaskState;
  assigneeId: MemberId;
  reviewerId: MemberId | OwnerRef | null;
  prerequisiteIds: TaskId[];
  acceptanceCriteria: string[];
  plannedAreas: string[];
  outputMode: OutputMode;
  steps: { idx: number; title: string; done: boolean; doneAt: IsoTime | null; commitSha: string | null }[];
  progress: ProgressView;
  hold: { reasons: HoldReasonView[]; returnState: TaskState | null } | null;
  review: {
    round: number;
    rejectsInRound: number;
    rejectsTotal: number;
    autoCheck: AutoCheckStatus;
    autoCheckDetail: string;
    passed: boolean;
    /** 지금 고정된 검수 대상의 고정 시각 (REV-07) — 검수자의 판정은 그 검수 턴이 본 고정(Turn.reviewPinnedAt)에 묶인다 */
    targetPinnedAt?: IsoTime | null;
  };
  branch: string | null;
  worktreePath: string | null;
  conflictFiles: string[];
  /** 열린 충돌 가운데 기록할 때 내용으로 확인하지 못한 파일 (바이너리·한쪽이 지운 파일 등, GIT-07). 선택 항목 */
  conflictUnverifiable?: string[];
  /** 최근 검수 기준 변경으로 더하거나 바뀐 기준 — 검수자가 같은 글로 판정해야 한다 (REV-03). 선택 항목 */
  changedCriteria?: string[];
  createdAt: IsoTime;
  activatedAt: IsoTime | null;
  completedAt: IsoTime | null;
  merge: { mergeCommitSha: string; mergedAt: IsoTime } | null;
  revertOfTaskId: TaskId | null;
  revertedByTaskId: TaskId | null;
}

export type OwnerTodo =
  | {
      kind: 'question';
      id: string;
      questionId: string;
      fromId: MemberId;
      fromName: string;
      text: string;
      projectId: ProjectId | null;
      since: IsoTime;
    }
  | { kind: 'unread_report'; id: string; reportId: ReportId; title: string; projectId: ProjectId | null; since: IsoTime }
  | {
      kind: 'error';
      id: string;
      memberId: MemberId | null;
      taskId: TaskId | null;
      projectId: ProjectId | null;
      message: string;
      since: IsoTime;
      /**
       * 이 보류로 메인 에이전트에게 업무가 가는가 — true면 '메인 에이전트가 처리 중', false면 대표가 명령창으로 알려야 한다. 그 보류의 가장 최근
       * 메인 업무(검수자 없음·alert)가 있고 취소(상한에서 버림 포함)되지 않았을 때만 true (SERVER_DESIGN 5.3, 리드 결정 S5-7 — HoldReasonView와 같은
       * 판정). 없으면(이전 서버) 모름
       */
      reachesMain?: boolean;
    }
  | {
      kind: 'recovery_check';
      id: string;
      requestId: string;
      taskId: TaskId | null;
      projectId: ProjectId | null;
      message: string;
      since: IsoTime;
      /** 이 복구 확인이 메인 에이전트에게 가 있는가 (alert:recovery:<요청 ID>, 같은 판정 — 리드 결정 S5-7·S5-8). 없으면(이전 서버) 모름 */
      reachesMain?: boolean;
    }
  | { kind: 'auth_required'; id: string; aiKind: AiKind; since: IsoTime }
  | {
      kind: 'emergency_held';
      id: string;
      count: number;
      since: IsoTime;
      /**
       * 정지 해제 목록이 메인 에이전트에게 가 있는가 — 가장 최근 정지 해제 업무가 버려지지 않았으면 true('메인 에이전트가 확인해 항목별로 재개'),
       * 상한에서 버려졌거나 없으면 false(대표가 명령창으로 알려야 한다). 없으면(이전 서버) 모름
       */
      reachesMain?: boolean;
    };

export interface ActivityView {
  seq: number;
  ts: IsoTime;
  actor: Actor;
  actorName: string;
  projectId: ProjectId | null;
  taskId: TaskId | null;
  memberId: MemberId | null;
  kind: ActivityKind;
  level: 'info' | 'warn' | 'error';
  text: string;
  result: string | null;
  requestId: string | null;
  sessionId: string | null;
  turnId: string | null;
}

export interface AiStatusView {
  kind: AiKind;
  installed: boolean;
  version: string | null;
  problem: string | null;
  usageLimitedUntil: IsoTime | null;
  /**
   * 걸려 있는 모델별 주간 한도 (Claude Opus·Sonnet 주간 한도) — 그 모델 계열(모델을 정하지 않은 팀원 포함)의 턴만 쉬고, 다른 모델의 턴은 돈다.
   * 그래서 blocked에 넣지 않는다. label은 'Opus' 같은 계열 이름 (리드 결정 22)
   */
  modelLimits?: { family: ModelLimitFamily; label: string; until: IsoTime }[];
  authRequired: boolean;
  /** 새 턴 시작이 막혀 있는지 */
  blocked: boolean;
}

export interface RoleView {
  id: RoleId;
  name: string;
  instructions: string;
  taskTypes: TaskType[];
  allowedSkills: string[];
  defaultAi: AiConfig;
  canReview: boolean;
  builtin: boolean;
  /** 만든 쪽 — 기록으로만 보인다(잠금 없음, 리드 결정 S5-12). 없으면(이전 서버) 모름 */
  createdBy?: RoleCreator;
}

// ───────────────────────── 상세 조회 ─────────────────────────
export interface SessionView {
  id: string;
  kind: SessionKind;
  workKey: string;
  /** 사람이 읽는 업무 이름 (예: 'T-0003 작업', 'D-0002 지시 관리') */
  label: string;
  cliSessionId: string | null;
  /** 외부 에이전트가 실행한 세션이면 'external' (리드 결정 S7-2) */
  aiKind: RunnerKind;
  mock: boolean;
  createdAt: IsoTime;
  closedAt: IsoTime | null;
  previousSessionId: string | null;
  replaceReason: string | null;
  turnCount: number;
  current: boolean;
}

export interface TurnView {
  id: string;
  sessionId: string;
  startedAt: IsoTime;
  endedAt: IsoTime | null;
  endReason: TurnEndReason | null;
  endDetail: string;
  bypass: 'verified' | 'requested' | 'mismatch';
  mcp: 'connected' | 'unknown' | 'failed';
  eventCount: number;
  usage: { inputTokens: number | null; outputTokens: number | null; costUsd: number | null } | null;
  running: boolean;
  /** 실행 주체 (리드 결정 S7-2) — 없으면 'cli' */
  runner?: 'cli' | 'external';
}

export interface MemberDetail {
  member: MemberView;
  role: RoleView;
  sessions: SessionView[];
  recentTurns: TurnView[];
  currentTask: TaskView | null;
  /** 대기 중인 작업 (담당) */
  queuedTasks: TaskView[];
  /** 지난 작업 이력 (MBR-05) */
  history: { taskId: TaskId; title: string; state: TaskState; completedAt: IsoTime | null; durationSec: number; rejects: number }[];
  /**
   * 이 팀원 관련 최근 메시지 (대표 직접 메시지 포함). delivered: 그 메시지를 실은 턴의 CLI를 띄움(전달됨).
   * undelivered: 전달하기 전에 그 업무가 끝나거나 바뀌어 전달하지 못한 사유 (대표에게 알림도 감). 없으면 전달 대기이거나 전달됨
   */
  messages: { id: string; from: string; text: string; createdAt: IsoTime; delivered: boolean; undelivered?: string | null }[];
}

export interface CliEventPage {
  events: CliEvent[];
  /** 다음 조회에 넘길 커서. null이면 끝 */
  nextCursor: string | null;
  turnId: string | null;
}

export interface DiffView {
  taskId: TaskId;
  base: string | null;
  head: string | null;
  files: { path: string; status: 'A' | 'M' | 'D' | 'R' | 'U' | '?'; additions: number; deletions: number }[];
  /** 통합 diff (가림 적용, 최대 200KB) */
  patch: string;
  truncated: boolean;
}

export interface ReviewHistoryView {
  id: string;
  reviewRound: number;
  reviewerId: MemberId | OwnerRef;
  reviewerName: string;
  verdict: 'pass' | 'reject';
  criteria: CriterionResult[];
  reason: string;
  createdAt: IsoTime;
}

export interface TaskDetail {
  task: TaskView;
  reviews: ReviewHistoryView[];
  transitions: { from: string; event: string; to: string; reason: string; actor: string; at: IsoTime }[];
  diff: DiffView | null;
  /**
   * 검수할 때 따로 볼 것 (선택 항목 — 없으면 볼 것 없음, 대표 검수 화면용). 팀원 검수자의 검수 요청에 적는 것과 같다:
   * - uncheckedConflictFiles: 지난 판정 뒤 충돌 해결에서 내용으로 확인하지 못해 작업 폴더 그대로 커밋된 파일(바이너리·한쪽이 지운 파일 등) —
   *   main 쪽 변경이 빠지지 않았는지 확인할 파일 (GIT-07)
   * - deliverables: 산출물형에서 저장소 변경형으로 전환된 작업의 산출물 폴더 결과 파일 — 지금 고정된 버전의 사본 위치와 파일 (AC-47, 병합이 끝나면 함께 보관)
   */
  reviewNotes?: { uncheckedConflictFiles: string[]; deliverables: { dir: string; files: string[] } | null };
  /** 보관된 산출물 (산출물형 확정, 또는 전환된 작업의 산출물 폴더 결과 파일 — REV-05). 선택 항목: 없으면 보관본 없음 */
  artifact?: { version: number; dir: string; files: string[]; finalizedAt: IsoTime } | null;
  /** 이 작업의 자동 검사 실행 기록, 오래된 것부터 (REV-01). 선택 항목 */
  checkRuns?: CheckRunView[];
}

export interface DirectiveDetail {
  directive: DirectiveView;
  tasks: TaskView[];
  rounds: { round: number; requestedAt: IsoTime; text: string; anchored: AnchoredComment[]; reportId: ReportId | null }[];
  reports: ReportListItem[];
}

export interface ReportListItem {
  id: ReportId;
  projectId: ProjectId | null;
  projectName: string;
  directiveId: DirectiveId | null;
  round: number;
  title: string;
  status: ReportStatus;
  createdAt: IsoTime;
}

export interface ReportDetail extends ReportListItem {
  markdown: string;
  sections: ReportSections;
  stats: ReportStats;
  comments: { id: string; kind: 'overall' | 'anchored'; quote: string | null; text: string; createdAt: IsoTime }[];
  /** 같은 지시의 다른 회차 보고서 (FBK-04 비교용) */
  otherRounds: { id: ReportId; round: number }[];
  filePath: string;
  /** 지금 reports.approve가 받아들이는지 — 수정 요청한 보고서도 메인 에이전트가 새 회차를 열기 전이면 그대로 승인할 수 있다 (v0.6) */
  canApprove?: boolean;
  /**
   * 지금 reports.requestChanges가 받아들이는지 — 이미 승인했거나 수정 요청한 보고서, 지시가 이미 끝났거나 취소된 보고서는 false (리드 결정 25).
   * 화면은 이것이 true일 때만 '수정 요청'을 보인다. 없으면(이전 서버) 예전 규칙(승인·수정 요청 상태가 아니면 보임)
   */
  canRequestChanges?: boolean;
}

export interface NotificationView {
  id: string;
  level: NotificationLevel;
  title: string;
  body: string;
  link: NavTarget | null;
  /** 알림 종류 키 (usage:<kind>, review-stuck:<T>:<검수자>, handoff-stuck:<T> 등) — 화면은 앞부분으로 종류를 가린다. 없으면(이전 서버) 모름 */
  key?: string | null;
  createdAt: IsoTime;
  read: boolean;
}

export interface ConversationView {
  id: string;
  role: 'owner' | 'main_agent' | 'system';
  text: string;
  attachments: Attachment[];
  directiveId: DirectiveId | null;
  createdAt: IsoTime;
}

export interface RecoveryItemView {
  requestId: string;
  kind: string;
  projectId: ProjectId | null;
  taskId: TaskId | null;
  command: string;
  startedAt: IsoTime;
  /** 프로그램이 확인한 내용 */
  finding: string;
}

export interface PrereqStatus {
  git: { ok: boolean; version: string | null };
  claude: { ok: boolean; version: string | null; loggedIn: boolean | null; detail: string };
  codex: { ok: boolean; version: string | null; loggedIn: boolean | null; detail: string };
  google: { configured: boolean };
  jobRunner: { ok: boolean; detail: string };
  /** 화면 조작 (SERVER_DESIGN 8.3·10.6, 리드 결정 S6-11) — 마지막으로 안 상태. system.prereqs는 도우미를 띄우지 않는다 */
  screen: { ok: boolean; state: ScreenUnavailableCode | 'available' | 'unknown'; detail: string; elevated: boolean | null };
}

export interface SystemInfo {
  /** 앱 데이터 폴더 (ENV-06) */
  dataDir: string;
  appVersion: string;
  isPackaged: boolean;
  platform: string;
  /** 하위 프로세스 종료 방식 (Job Object 러너 등) */
  processRunner: { mode: 'jobobject' | 'taskkill' | 'pgroup'; detail: string };
  /** 앱 도구 서버 주소 (루프백) */
  toolServerUrl: string | null;
}

export interface SkillView {
  name: string;
  description: string;
  source: AiKind;
  path: string;
  mode: 'auto' | 'manual';
  allowedRoles: RoleId[];
}

/** 팀원 추가 입력의 AI 설정 (역할 기본값을 덮어씀) */
export interface AiConfigInput {
  kind?: AiKind;
  model?: string | null;
  effortTier?: EffortTier;
  effortOverride?: string | null;
}

// ── 메인 자리와 인계 (SERVER_DESIGN 4.1·4.3·4.4·6장, 리드 결정 S4-2·S4-5·S4-6·S4-7·S4-10·S4-11) ──
// 대표는 보기만 한다. 자리를 바꾸는 대표 메서드는 없다 — 바꾸는 쪽은 지금 메인(hand_off_seat)과 서버 PC 운영자(seat assign)뿐이다

/** 메인 자리 보유자 (4.1) — label은 사람이 읽는 이름 (예: 'Claude CLI', '그록봇') */
export type SeatHolderView =
  | { kind: 'launched'; ai: AiConfig; label: string }
  | { kind: 'external'; agentId: string; label: string };

export type SeatState = 'active' | 'switching' | 'vacant' | 'stopped';

/** 지금 메인 자리 (seat.get, 스냅숏 seat) */
export interface SeatView {
  generation: number;
  state: SeatState;
  /** vacant면 null */
  holder: SeatHolderView | null;
  /** 지금 보유자가 앉은 때 (vacant면 null) */
  since: IsoTime | null;
  /** 응답 없음을 처음 본 때 (4.4·S4-5). 응답하면 null. 긴급 정지 중에는 세지 않는다 */
  unresponsiveSince: IsoTime | null;
  /** 응답 없음의 까닭 — 사람이 읽는 글 (예: '사용량 한도로 메인 턴이 3번 연달아 끝났습니다') */
  unresponsiveReason: string | null;
  /** switching일 때 넘어갈 보유자 (그 밖에는 null) */
  pendingHolder: SeatHolderView | null;
  /** 화면 이미지를 보는지 확인한 결과 (8.3.4) — 4단계에서는 늘 'unknown' */
  vision: 'verified' | 'failed' | 'unknown';
  /** 화면 조작 상태 (리드 결정 S6-2) — 로그인 전에는 LOCKED_SEAT가 비운다 (S4-11) */
  screen: SeatScreenView;
}

/** 로그인하지 않은 화면의 스냅숏에 들어가는 자리 (리드 결정 S4-11) — 보유자·이력은 업무 내용이라 비운다. 화면은 이 값을 '메인 에이전트 없음'으로 그리지 않는다 */
export const LOCKED_SEAT: SeatView = {
  generation: 0,
  state: 'vacant',
  holder: null,
  since: null,
  unresponsiveSince: null,
  unresponsiveReason: null,
  pendingHolder: null,
  vision: 'unknown',
  screen: { unavailable: null, operatingSince: null, paused: null },
};

/** 자리 이력 한 줄 (seat.history) — changedBy에 owner는 없다 */
export interface SeatHistoryEntry {
  generation: number;
  holder: SeatHolderView;
  startedAt: IsoTime;
  endedAt: IsoTime | null;
  /** 끝난 까닭 (예: '메인이 Codex에게 넘김: 사용량 한도', '운영자 복구 배정') */
  endReason: string | null;
  changedBy: 'main' | 'operator' | 'server';
  /** 이 세대에 인계 꾸러미가 있는지 (seat.handover(generation)) */
  hasHandover: boolean;
}

/** 인계 꾸러미의 한 칸 (6.2 순서 고정) */
export interface HandoverSection {
  key: 'seat' | 'facts' | 'memos' | 'memory';
  title: string;
  /** 'memos'만 true — 이전 메인이 남긴 확인되지 않은 주장 (6.3) */
  unverified: boolean;
  lines: string[];
  /** 분량 상한으로 뺀 건수 ('외 n건') */
  omitted: number;
}

/** 인계 꾸러미 (seat.handover) — 서버가 DB에서 정해진 규칙으로 만든 것. 최대 12,000자 */
export interface SeatHandoverView {
  generation: number;
  createdAt: IsoTime;
  /** 이 꾸러미를 받은 보유자 */
  holder: SeatHolderView;
  /** 이전 보유자 (첫 세대면 null) */
  previous: SeatHolderView | null;
  sections: HandoverSection[];
  chars: number;
}

export type JournalKind =
  | 'command' // 받은 명령
  | 'action' // 메인이 상태를 바꾼 도구 호출
  | 'report' // 보고 도착·승인·수정 요청
  | 'seat' // 자리 교체·응답 없음·운영자 배정
  | 'stop' // 긴급 정지·해제
  | 'decision' // 여기부터 셋은 에이전트가 쓴 것
  | 'promise'
  | 'note'
  | 'rollup'; // 30일 지난 서버 기록의 월별 묶음

export interface JournalRef {
  kind: 'directive' | 'question' | 'report' | 'member' | 'task' | 'project';
  id: string;
  /** 사람이 읽는 대상 이름 (없어진 대상이면 '(지워짐)') */
  label: string;
}

/** 메인 일지 한 줄 (journal.list) — author 'agent'는 확인되지 않은 주장 */
export interface JournalEntryView {
  id: string;
  at: IsoTime;
  generation: number;
  holderLabel: string;
  author: 'server' | 'agent';
  kind: JournalKind;
  projectId: ProjectId | null;
  projectName: string | null;
  /** 가림 적용 후 내용 (최대 1,000자) */
  text: string;
  refs: JournalRef[];
  /** kind 'promise'만 있다. stale: 7일 넘게 열림, needsCheck: 참조한 지시가 닫힘 (6.3) */
  promise?: { state: 'open' | 'closed'; stale: boolean; needsCheck: boolean; closedAt: IsoTime | null; resolution: string | null };
}

export interface JournalFilter {
  /** 없으면 전체, null이면 프로젝트 없는 기록만 */
  projectId?: ProjectId | null;
  kinds?: JournalKind[];
  author?: 'server' | 'agent';
  generation?: number;
  /** 열린 약속만 */
  openPromisesOnly?: boolean;
  /** 앞 페이지의 nextCursor */
  cursor?: string;
  /** 기본 50, 최대 200 */
  limit?: number;
}

export interface JournalPage {
  entries: JournalEntryView[];
  nextCursor: string | null;
}

// ── 화면 조작 (SERVER_DESIGN 8.3·10.6, 리드 결정 S6-2) ──
// 대표는 보기만 한다. 화면 조작을 시작·멈춤·조절하는 대표 메서드는 없다

/** wayland: Linux 서버가 Wayland 세션이라 쓸 수 없음 (리드 결정 S10-7.7) */
export type ScreenUnavailableCode = 'desktop_mode' | 'unsupported_os' | 'disabled' | 'wayland' | 'no_desktop' | 'locked' | 'disconnected' | 'secure_desktop' | 'helper_failed';
/** 바뀌는 때(무장·해제, 멈춤, 쓸 수 없음)에만 바뀐다 */
export interface SeatScreenView {
  unavailable: { code: ScreenUnavailableCode; text: string; since: IsoTime } | null;
  /** 서버 PC에 '조작 중' 표시가 떠 있는 동안 */ operatingSince: IsoTime | null;
  /** human: 마지막 사람 입력 + 30초, local: 멈춤 단축키 + 5분 */
  paused: { by: 'human' | 'local'; since: IsoTime; until: IsoTime } | null;
}
export type GuiAction = 'capture' | 'move' | 'click' | 'double_click' | 'drag' | 'scroll' | 'key' | 'type' | 'release' | 'stop';
export type GuiResult = 'sent' | 'ok' | 'error' | 'invalid' | 'conflict' | 'stopped' | 'seat_changed' | 'stale_capture'
  | 'rate_limited' | 'human_active' | 'secret_blocked' | 'denied_target' | 'unavailable';
export interface GuiActionView {
  id: string; at: IsoTime; generation: number; holderLabel: string; turnId: string | null; projectId: ProjectId | null;
  by: 'main' | 'server'; action: GuiAction;
  /** 실제 픽셀 */ x: number | null; y: number | null; x2: number | null; y2: number | null;
  button: 'left' | 'right' | 'middle' | null; count: number | null; amount: number | null; keys: string | null;
  /** 막혔으면 null */ text: string | null; textLength: number | null;
  focus: { app: string; title: string; password: boolean | null } | null;
  result: GuiResult; detail: string | null; beforeCaptureId: string | null; afterCaptureId: string | null;
}
export interface ScreenCaptureView {
  id: string; at: IsoTime; generation: number; holderLabel: string; turnId: string | null; projectId: ProjectId | null;
  screen: number | 'all'; width: number; height: number; scale: number; cause: 'capture' | 'after_input';
  focus: string | null; sha256: string; /** 파일이 있고 해시가 맞다 */ kept: boolean;
}
export interface ScreenFilter { limit?: number /* 동작, 100·최대 500 */; before?: string /* 동작 ID */ }
export interface ScreenRecentView { captures: ScreenCaptureView[] /* 최근 100 */; actions: GuiActionView[]; nextCursor: string | null }
export interface ScreenImageView { id: string; mime: 'image/png'; dataUrl: string; width: number; height: number }

// ── 외부 에이전트 (SERVER_DESIGN 4.5·10.7, 리드 결정 S7-2) ──
// 대표는 보기만 한다(agents.list). 등록·폐기는 서버 PC 운영자(wook-server agent add|revoke)만 한다. 키와 해시는 보기에 없다

/** 등록된 외부 에이전트 하나 (agents.list) */
export interface ExternalAgentView {
  id: ExternalAgentId;
  label: string;
  createdAt: IsoTime;
  revokedAt: IsoTime | null;
  /** 마지막으로 인증된 에이전트 API 호출 */
  lastSeenAt: IsoTime | null;
  /** 메인 자리에 앉아 있음, 또는 진행 중인 교체의 다음 보유자(incoming) */
  seat: 'seated' | 'incoming' | null;
  /** 지금 살아 있는 임대가 있다 */
  connected: boolean;
}
