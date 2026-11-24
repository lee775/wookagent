/**
 * 욱채 도메인 타입 — DB에 저장되는 엔티티.
 * 기준 문서: docs/기획서_v0.5.md (괄호 안 ID는 기획서 요구사항 ID).
 * 이 파일은 main·preload·renderer·테스트가 함께 쓰는 계약이다. 바꿀 때는 모든 사용처를 같이 고친다.
 */

export type IsoTime = string; // ISO 8601 UTC 문자열

// ───────────────────────── ID ─────────────────────────
export type ProjectId = string; // P-0001
export type MemberId = string; // M-0001, 메인 에이전트는 MAIN_AGENT_ID
export type RoleId = string; // 기본 역할 'producer' 등, 사용자 정의 'role-0001'
export type DirectiveId = string; // D-0001
export type TaskId = string; // T-0001
export type SessionId = string; // S-000001 (앱 내부 세션 ID. CLI 세션 ID와 별개)
export type TurnId = string; // TN-000001
export type QueueEntryId = string; // W-000001
export type QuestionId = string; // Q-0001
export type ReportId = string; // R-0001
export type ReviewId = string; // RV-0001
export type MessageId = string; // MSG-000001
export type RequestId = string; // RQ-000001 (외부 실행·git 요청 ID, ERR-07)
export type NotificationId = string; // N-000001
export type AttachmentId = string; // A-000001
export type ExternalAgentId = string; // X-0001 (외부 에이전트, SERVER_DESIGN 4.5, 리드 결정 S7-2)

export const MAIN_AGENT_ID: MemberId = 'M-MAIN';
export const OWNER = 'owner' as const; // 대표
export type OwnerRef = typeof OWNER;
/**
 * 운영자 (SERVER_DESIGN 2.1): 서버 PC에서 서버를 띄운 주체 — 조직도 밖. 설치·운영자 설정·시험 준비를 프로세스 안 내부 API(createInternalApi)로 한다.
 * 대표 화면과 원격 경로에는 이 길이 없다
 */
export const OPERATOR = 'operator' as const;
export type OperatorRef = typeof OPERATOR;
/** 기록상의 주체 (2.5 행위자 넷). 팀원 ID(메인 에이전트는 MAIN_AGENT_ID), 대표, 운영자, 프로그램 자신 */
export type Actor = MemberId | OwnerRef | OperatorRef | 'system';

// ───────────────────────── AI 설정 ─────────────────────────
export type AiKind = 'claude' | 'codex';
export const AI_KINDS: readonly AiKind[] = ['claude', 'codex'];
/**
 * 턴을 실행한 쪽 (SERVER_DESIGN 4.1 RunnerKind, 리드 결정 S7-2) — 서버가 띄우는 CLI의 AI 종류, 또는 스스로 도는 외부 에이전트. 세션·턴 기록의 aiKind만
 * 이것으로 넓힌다 — 설정(effortMapping·authMode·modelCatalog 등)의 AiKind는 넓히지 않는다
 */
export type RunnerKind = AiKind | 'external';
/** 노력치 단계 '높게·보통·낮게' (ROLE-03). 실제 CLI 값은 설정의 effortMapping으로 변환 */
export type EffortTier = 'high' | 'normal' | 'low';
export const EFFORT_TIERS: readonly EffortTier[] = ['high', 'normal', 'low'];
export interface AiConfig {
  kind: AiKind;
  /** null이면 CLI 기본 모델 */
  model: string | null;
  effortTier: EffortTier;
  /** 단계 대신 CLI 실제 값을 직접 지정할 때 (예: claude 'max', codex 'xhigh') */
  effortOverride: string | null;
}

/** AI 설정 결정 기록 */
export interface AiDecision {
  by: Actor;
  reason: string;
  at: IsoTime;
}

/** 메인 에이전트가 고를 수 있는 모델 목록 항목 (운영 설정에서 대표가 관리) */
export interface ModelOption {
  /** CLI에 넘길 모델 이름 또는 별칭 */
  id: string;
  label: string;
  /** 언제 고르면 좋은지 (메인 에이전트 판단 근거) */
  note: string;
}

/**
 * CLI별 실제 노력치 값 (claude --effort, codex model_reasoning_effort).
 * codex: codex-cli 0.163의 모델 목록(`codex debug models --bundled`, ~/.codex/models_cache.json)에서 모든 모델이 받는 값만 둔다 —
 * none·minimal은 받는 모델이 없고, ultra는 CLI 안에서 하위 에이전트를 띄워 턴 상한·정지 제어 밖으로 나가므로 넣지 않는다 (windows:F7)
 */
export const EFFORT_LEVELS: Record<AiKind, readonly string[]> = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['low', 'medium', 'high', 'xhigh', 'max'],
};

/** 예전 목록에만 있던 노력치 → 지금 목록의 가장 가까운 값. 저장된 설정·팀원·세션 값을 읽을 때만 바꾼다 (새 입력은 거부) */
export const LEGACY_EFFORT_ALIASES: Record<AiKind, Readonly<Record<string, string>>> = {
  claude: {},
  codex: { none: 'low', minimal: 'low' },
};

// ───────────────────────── 역할 (4.2) ─────────────────────────
export type BuiltinRoleId = 'producer' | 'planner' | 'architect' | 'developer' | 'ui_designer' | 'qa' | 'docs';
/**
 * 역할을 만든 쪽 — 기록으로만 둔다. 누가 만들었든 메인 에이전트가 고칠 수 있고, 대표 우선(CTL-06) 잠금은 없다 (SERVER_DESIGN 7장, 리드 결정 S5-12).
 * seed = 기본 역할, owner = 4단계 전에 대표가 만든 역할, main = 메인 에이전트(create_role), operator = 운영자 내부 API
 */
export type RoleCreator = 'seed' | 'owner' | 'main' | 'operator';
export interface Role {
  id: RoleId;
  name: string;
  /** 세션 시작 시 앱이 넣는 역할 지침 (MEM-04) */
  instructions: string;
  taskTypes: TaskType[];
  allowedSkills: string[];
  defaultAi: AiConfig;
  /** 검수 권한 (REV-02·03) */
  canReview: boolean;
  builtin: boolean;
  /** 만든 쪽 (리드 결정 S5-12). undefined = 5단계 전에 저장된 역할(시작 때 옮김이 채운다) */
  createdBy?: RoleCreator;
  createdAt: IsoTime;
  updatedAt: IsoTime;
}

// ───────────────────────── 프로젝트 ─────────────────────────
export const MOCK_SCENARIOS = [
  'normal', // 정상 완료 (바이패스 정상 실행 포함)
  'slow', // 느린 진행
  'crash', // 비정상 종료 (첫 턴만 — 자동 재개로 회복)
  'crash_loop', // 매 턴 비정상 종료 (2회 재개 실패 → 오류·긴급 알림)
  'hang', // 응답 없음
  'spin', // 헛돌기 (같은 오류 반복, 단계 진척 없음)
  'bypass_mismatch', // 실행 권한 확인 발생 = 바이패스 설정 불일치
  'answer_wait', // 프로듀서에게 질문 → 답변 대기
  'usage_limit', // 사용량 한도
  'review_violation', // 검수 권한 위반 시도 (본인·미배정 검수)
  'triple_reject', // 검수자가 3회 반려
  'merge_conflict', // 다른 작업과 같은 파일 수정 → 병합 충돌
  'revert', // 병합 후 선택 되돌리기 요청
  'duplicate_tool', // 앱 도구 요청 중복 전달
] as const;
export type MockScenario = (typeof MOCK_SCENARIOS)[number];

export interface ProjectMockConfig {
  /** 개발자 옵션: 이 프로젝트의 팀원을 모의 에이전트로 실행 (MOCK-04) */
  enabled: boolean;
  /** 진행 속도 배수. 1 = 기본, 10 = 10배 빠르게 (MOCK-03) */
  speed: number;
  defaultScenario: MockScenario;
}

export interface Project {
  id: ProjectId;
  name: string;
  /** 프로젝트 폴더(= main 작업 트리) 절대 경로 */
  path: string;
  /** 기준 브랜치. 새 저장소는 'main', 기존 저장소는 등록 시 현재 브랜치 */
  baseBranch: string;
  /** 자동 검사 명령 (REV-01): 빌드·테스트·형식 검사. 비어 있으면 '해당 없음' */
  checkCommands: string[];
  /** 팀원 네트워크 사용 방침 (CLI-24). 업무 지침일 뿐 차단 기능이 아님 */
  networkPolicy: 'allow' | 'restricted';
  /** 원격 올리기·배포 설정 (GIT-12). null이면 해당 작업을 만들지 않음 */
  deploy: { pushRemote: string | null; deployCommand: string | null };
  mock: ProjectMockConfig;
  producerId: MemberId;
  createdAt: IsoTime;
  updatedAt: IsoTime;
  archivedAt: IsoTime | null;
}

// ───────────────────────── 팀원 (ORG-02, 5.4) ─────────────────────────
export interface Member {
  id: MemberId;
  /** null = 메인 에이전트 */
  projectId: ProjectId | null;
  name: string;
  roleId: RoleId;
  isProducer: boolean;
  isMain: boolean;
  ai: AiConfig;
  /** 진행 중 작업이 끝난 뒤 적용할 설정 변경 (MBR-06) */
  pendingAi: AiConfig | null;
  /**
   * AI 종류·모델·노력치를 마지막으로 정한 주체와 사유 (추가 결정 2026-10-27: 메인 에이전트가 판단해 정함). 예전 '대표가 정함' 기록은 이력으로 남는다 —
   * 대표 고정은 v0.6에서 없앴다 (SERVER_DESIGN 2.7, 시작 때 migrations.ts가 저장된 고정 값을 지운다)
   */
  aiDecision: AiDecision | null;
  /** 모의 모드에서 따를 시나리오. null이면 프로젝트 기본값 */
  mockScenario: MockScenario | null;
  createdAt: IsoTime;
  updatedAt: IsoTime;
  deletedAt: IsoTime | null;
  /** 프로듀서 교체 시 후임 ID (ORG-04) */
  replacedById: MemberId | null;
  /** 누적 실행 시간(초) — 가동 시간 표시 */
  runSeconds: number;
}

// ───────────────────────── 지시 (5.3) ─────────────────────────
export type DirectiveState =
  | 'received' // 접수
  | 'planning' // 계획
  | 'in_progress' // 진행
  | 'reporting' // 보고
  | 'awaiting_confirmation' // 확인 대기
  | 'closed' // 종료
  | 'cancelled'; // 취소

export interface Attachment {
  id: AttachmentId;
  name: string;
  /** 앱 데이터 폴더에 복사한 파일 경로 */
  path: string;
  size: number;
  mime: string;
}

export interface AnchoredComment {
  /** 보고서에서 선택한 원문 일부 */
  quote: string;
  comment: string;
}

export interface DirectiveRound {
  round: number;
  requestedAt: IsoTime;
  /** 1회차는 대표 명령 원문, 2회차부터는 수정 요청 전체 코멘트 */
  text: string;
  anchored: AnchoredComment[];
  reportId: ReportId | null;
}

export interface FinalResult {
  round: number;
  summary: string;
  outputs: string[];
  changedFiles: string[];
  issues: string[];
  nextSteps: string[];
  submittedAt: IsoTime;
  by: Actor;
}

export interface Directive {
  id: DirectiveId;
  /** null = '메인 에이전트 직접' 명령 (CMD-02, 문서함 '일반' 폴더) */
  projectId: ProjectId | null;
  title: string;
  text: string;
  attachments: Attachment[];
  /** 현재 회차 (1부터, 수정 요청마다 +1 — FBK-03) */
  round: number;
  state: DirectiveState;
  rounds: DirectiveRound[];
  finalResult: FinalResult | null;
  /** 계획 승인 후 시작 (TSK-07, 2차). 기본 false */
  planApprovalRequired: boolean;
  createdAt: IsoTime;
  updatedAt: IsoTime;
  closedAt: IsoTime | null;
  cancelledAt: IsoTime | null;
}

// ───────────────────────── 작업 (5.2, 5.3) ─────────────────────────
export type TaskState =
  | 'waiting' // 대기
  | 'in_progress' // 진행
  | 'on_hold' // 보류
  | 'in_review' // 검수
  | 'done' // 완료
  | 'cancelled'; // 취소

export type TaskType =
  | 'plan' // 계획
  | 'spec' // 기획
  | 'architecture' // 설계
  | 'development' // 개발
  | 'bugfix' // 버그 수정
  | 'design' // 디자인
  | 'test' // 테스트
  | 'docs' // 문서
  | 'research' // 조사
  | 'simulation' // 시뮬레이션
  | 'asset' // 에셋: 음원·이미지·3D 모델 같은 산출물. 출력 방식을 정하지 않으면 산출물형 (SERVER_DESIGN 7장, 리드 결정 S5-15)
  | 'revert'; // 되돌리기 (GIT-10, 프로그램이 만든 작업)

export type Priority = 'urgent' | 'high' | 'normal' | 'low';
export const PRIORITY_RANK: Record<Priority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

/** 저장소 변경형 / 산출물형 (5.2) */
export type OutputMode = 'repo' | 'artifact';

export type HoldReasonKind =
  | 'answer_wait' // 답변 대기 (질문 ID = refId)
  | 'error' // 오류 (자동 복구 실패 등)
  | 'paused' // 일시정지 (scope = member|project)
  | 'emergency_stop' // 긴급 정지
  | 'replan' // 재계획 (3회 반려, 헛돌기, 되돌리기 충돌)
  | 'prereq_cancelled' // 선행 작업 취소 (TSK-04)
  | 'recovery_check' // 복구 확인 (실행 여부 불명확, ERR-08)
  | 'interrupted' // 중단 후 보류 (9장)
  | 'blocked' // 팀원 막힘 보고
  | 'merge_blocked'; // 병합 진행 불가 (프로젝트 폴더 미커밋 변경·git 오류 등) — 원인이 정리되면 메인 에이전트가 항목별 재개 (병합 판단부터 다시)

export interface HoldReason {
  kind: HoldReasonKind;
  scope: 'global' | 'project' | 'member' | 'task' | null;
  /** 질문 ID, 실행 요청 ID 등 관련 ID */
  refId: string | null;
  note: string;
  since: IsoTime;
  by: Actor;
}

export type ReviewTarget =
  | {
      kind: 'repo';
      taskCommitSha: string;
      baseMainSha: string;
      pinnedAt: IsoTime;
      /**
       * 산출물형에서 전환된 작업: 고정 때 찍은 산출물 폴더 결과 파일 사본의 해시 (REV-07 '산출물 버전·해시에 연결'). 보관은 이 해시와 같은 내용만
       * (검수 사본, 사본이 바뀌었으면 고정 때 그대로인 산출물 폴더) — 어디에도 없으면 병합하지 않고 진행으로 돌리거나(병합 전) 보관하지 않고 보류한다(병합 뒤).
       * 결과 파일이 없었으면 없다
       */
      deliverables?: ArtifactFile[];
    }
  | { kind: 'artifact'; files: ArtifactFile[]; version: number; pinnedAt: IsoTime };

export interface ArtifactFile {
  /** 작업 폴더 또는 산출물 폴더 기준 상대 경로 */
  path: string;
  sha256: string;
  size: number;
}

export type AutoCheckStatus = 'not_run' | 'running' | 'passed' | 'failed' | 'not_applicable';

export interface TaskReviewState {
  /** 검수 차수 (1부터). 재계획 후 +1 (REV-04) */
  round: number;
  rejectsInRound: number;
  rejectsTotal: number;
  /** 현재 고정된 검수 대상 (REV-07) */
  target: ReviewTarget | null;
  /** 검수 통과 기록. target과 다른 대상이면 무효 */
  passed: { reviewId: ReviewId; reviewerId: MemberId | OwnerRef; at: IsoTime; target: ReviewTarget } | null;
  autoCheck: { status: AutoCheckStatus; detail: string; at: IsoTime | null };
}

export interface TaskWorkspace {
  branch: string;
  worktreePath: string;
  baseBranch: string;
  createdAt: IsoTime;
}

export interface TaskMergeInfo {
  requestId: RequestId;
  taskCommitSha: string;
  preMainSha: string;
  mergeCommitSha: string;
  mergedAt: IsoTime;
}

/**
 * 최신 main 반영 중 생긴 병합 충돌 (GIT-07). 같은 충돌 — 같은 파일이고 그 사이 받아들인 해결 커밋이 없음 — 이 다시 기록돼도
 * (병합을 취소한 뒤 프로그램이 다시 반영 등) since·횟수를 이어 간다. 받아들인 해결 커밋이 기록을 지운다
 */
export interface TaskConflict {
  files: string[];
  /** 이 충돌이 처음 기록된 시각 (같은 충돌을 다시 기록해도 그대로) */
  since: IsoTime;
  resolverId: MemberId | null;
  /** 충돌을 낸 병합이 반영하던 main 커밋 — 작업 폴더에 진행 중인 병합이 없을 때 병합이 마무리됐는지 취소됐는지 가린다. 없으면 모름 */
  baseSha?: string | null;
  /** 받아들인 해결 커밋 없이 끝난 해결 턴 수 (진척 없는 자동 재개, CLI-18). 재계획·대표 재개 때 0. 없으면 0 */
  unresolvedTurns?: number;
  /** 이 충돌로 헛돌기 보류된 횟수 — 같은 충돌의 두 번째 헛돌기는 대표에게 보고한다 (GIT-07). 없으면 0 */
  spinHolds?: number;
  /**
   * 충돌을 기록할 때(병합 직후, 팀원이 손대기 전) 내용으로 확인할 수 없던 충돌 파일 (바이너리·큰 파일·한쪽이 지운 파일 등). 팀원이 그 파일을 직접
   * 스테이징해 인덱스에서 충돌이 풀려도 해결 커밋·재검수 요청에 계속 적는다 (GIT-07 재검수 안전장치). 없으면 없음
   */
  unverifiable?: string[];
}

export interface TaskArtifactInfo {
  version: number;
  /** 보관 폴더 (앱 데이터) */
  dir: string;
  files: ArtifactFile[];
  finalizedAt: IsoTime;
}

export interface Task {
  id: TaskId;
  projectId: ProjectId;
  directiveId: DirectiveId;
  /** 상위 지시 회차 */
  round: number;
  title: string;
  goal: string;
  type: TaskType;
  priority: Priority;
  assigneeId: MemberId;
  /**
   * 검수자 (REV-02·06). 적격 팀원이 없으면 메인 에이전트(M-MAIN). null = 아직 미배정이거나 검수자 없음(M-MAIN도 기여자 — 보류하고 메인에게 알림).
   * 'owner'는 v0.6 전의 대표 검수 기록이다 — 시작 때 데이터 이전이 열린 작업을 M-MAIN으로 바꾼다 (migrations.ts). 새로 쓰지 않는다
   */
  reviewerId: MemberId | OwnerRef | null;
  prerequisiteIds: TaskId[];
  acceptanceCriteria: string[];
  /**
   * 이 작업에서 빠지거나 바뀐 이전 완료 조건 글 (update_task·replan_task가 남김). 그 글로 적힌 검수 결과는 지금 조건을 같은 자리로 덮지 않는다 —
   * 이전 조건을 본 통과가 바뀐 조건까지 통과로 묶이지 않게 (REV-03, reviewRules.uncoveredCriteria). 없으면 없음
   */
  formerCriteria?: string[];
  /**
   * 지금 완료 조건 중 조건 변경(update_task·replan_task)에서 더해지거나 바뀐 뒤 아직 통과를 받지 않은 것 (reviewRules.changedCriteria — 변경마다
   * 쌓이고, 통과가 기록되면 비운다). 이 조건은 같은 글로 적힌 검수 결과로만 덮인다 — 같은 자리 결과로 덮지 않는다 (REV-03, AC-43). 없으면 없음
   */
  changedCriteria?: string[];
  /** 수정 예정 영역 (충돌 예방, GIT-08) */
  plannedAreas: string[];
  outputMode: OutputMode;
  state: TaskState;
  hold: { reasons: HoldReason[]; returnState: TaskState | null };
  workspace: TaskWorkspace | null;
  review: TaskReviewState;
  /** 작업자 + 충돌 해결 등 실질 수정 참여자 (REV-02). 검수 불가 대상 */
  contributors: MemberId[];
  merge: TaskMergeInfo | null;
  artifact: TaskArtifactInfo | null;
  revertOfTaskId: TaskId | null;
  revertedByTaskId: TaskId | null;
  skillsUsed: string[];
  /** 턴 중 검수 요청을 받음 → 턴과 하위 프로세스 종료 확인 후 처리 */
  pendingSubmit: { requestedAt: IsoTime; note: string } | null;
  /** 최신 main 반영 중 생긴 병합 충돌 (GIT-07) */
  conflict: TaskConflict | null;
  /** 비정상 종료 자동 재개 연속 횟수 (최대 2회) */
  crashRetries: number;
  /** 진척 없는 자동 재개 연속 횟수 (3회면 헛돌기) */
  noProgressResumes: number;
  /**
   * 단계 진척 없이 이어진 제출 거부 수 (ERR-04 자동 재시도 상한) — 제출 처리가 대상을 고정하지 않고 제출 요청을 지운 거부를 모두 하나로 센다:
   * 자동 검사 실패, 검사 뒤 커밋되지 않은 파일, 산출물 없음, 검사 중 작업 버전 변경. 다시 제출하기만 되풀이하면 상한(spinSameErrorCount)에서
   * 헛돌기 보류. 단계 완료·대상 고정·재계획·대표 재개 때 0 (검사 통과만으로는 0이 아니다 — 통과한 뒤 거부되는 제출도 이어서 센다). 없으면 0.
   * 이름은 이전 기록과 맞추려고 그대로 둔다
   */
  checkFailStreak?: number;
  createdBy: Actor;
  createdAt: IsoTime;
  updatedAt: IsoTime;
  /** 대기열 정렬 기준 시각 (TSK-05) */
  queuedAt: IsoTime;
  /** 담당 팀원의 활성 일반 작업이 된 시각 (5.7 일반 작업 활성화) */
  activatedAt: IsoTime | null;
  completedAt: IsoTime | null;
  cancelledAt: IsoTime | null;
}

export interface Step {
  taskId: TaskId;
  idx: number;
  title: string;
  done: boolean;
  doneAt: IsoTime | null;
  /** 단계 완료 커밋 (GIT-05). 변경이 없으면 null */
  commitSha: string | null;
  note: string;
}

// ───────────────────────── 검수 기록 ─────────────────────────
export interface CriterionResult {
  criterion: string;
  pass: boolean;
  note: string;
}

export interface ReviewRecord {
  id: ReviewId;
  taskId: TaskId;
  reviewRound: number;
  reviewerId: MemberId | OwnerRef;
  target: ReviewTarget;
  verdict: 'pass' | 'reject';
  criteria: CriterionResult[];
  reason: string;
  requestId: string | null;
  createdAt: IsoTime;
}

// ───────────────────────── 질문·메시지 ─────────────────────────
export interface Question {
  id: QuestionId;
  projectId: ProjectId | null;
  fromId: MemberId;
  to: 'producer' | 'owner';
  taskId: TaskId | null;
  directiveId: DirectiveId | null;
  /** 질문을 보낸 업무 세션 키 — 답변은 이 세션의 다음 턴으로 전달 */
  sessionKey: string;
  text: string;
  status: 'open' | 'answered' | 'cancelled';
  answer: string | null;
  answeredBy: Actor | null;
  createdAt: IsoTime;
  answeredAt: IsoTime | null;
}

export interface AgentMessage {
  id: MessageId;
  requestId: string | null;
  fromActor: Actor;
  toMemberId: MemberId;
  /** 전달할 업무 세션 키. null이면 받는 팀원의 현재 업무 세션 */
  sessionKey: string | null;
  text: string;
  /**
   * urgent: 메인 에이전트의 긴급 지시 (instruct_member urgent — 그 업무 세션의 다음 턴 맨 앞, 검수·병합 전 전달, ARCHITECTURE 5장).
   * owner_direct: v0.6 전의 대표 직접 메시지 (CTL-05, 없앰) — 이력으로 남고, 아직 전달 전인 것은 긴급 지시와 같은 보장으로 전달된다
   */
  kind: 'owner_direct' | 'urgent' | 'agent' | 'system';
  /** 함께 공유된 팀원 (긴급 지시·직접 지시는 프로듀서에게 공유, CMD-06. 옛 대표 직접 메시지는 메인·프로듀서) */
  sharedWith: MemberId[];
  urgent: boolean;
  createdAt: IsoTime;
  /** 이 메시지를 실은 턴의 CLI를 띄운 시각 — 받는 업무 세션에 넘긴 때 (AC-36). 아직이면 null */
  deliveredAt: IsoTime | null;
  /** 전달하기 전에 그 업무가 끝나거나 바뀌어 대기열에서 빠진 시각과 사유 (대표에게 알림). 없으면 아직 전달 대기이거나 전달됨 */
  undeliveredAt?: IsoTime | null;
  undeliveredReason?: string | null;
}

// ───────────────────────── 세션·턴 (ORG-02, MEM-10·11) ─────────────────────────
export type SessionKind =
  | 'task' // 일반 작업 (작업별 새 세션)
  | 'review' // 검수 업무
  | 'directive' // 프로듀서의 지시 관리 업무 (계획·질문 응답·병합 판단·최종 결과)
  | 'main_project' // 메인 에이전트 — 프로젝트별 대화
  | 'main_general'; // 메인 에이전트 — 직접 명령

export interface AgentSession {
  id: SessionId;
  memberId: MemberId;
  projectId: ProjectId | null;
  kind: SessionKind;
  /** 'task:T-0001' | 'review:T-0001' | 'directive:D-0001' | 'main:P-0001' | 'main:general' */
  workKey: string;
  /**
   * 이 세션이 어느 프로젝트의 일인지 — 작업 키에서 뽑는다(main:P → P, review:T → T의 프로젝트, main:general → null). projectId는 그 팀원이 속한
   * 프로젝트라 메인 에이전트 세션은 늘 null이다 (SERVER_DESIGN 5.4, 리드 결정 S5-5). undefined = 5단계 전에 저장된 세션
   */
  workProjectId?: ProjectId | null;
  /** 외부 에이전트가 실행한 세션이면 'external' (리드 결정 S7-2) */
  aiKind: RunnerKind;
  /** 실행 주체 — undefined는 'cli' (7단계 전에 저장된 세션) */
  runner?: 'cli' | 'external';
  /** runner가 'external'이면 그 에이전트 ID, 아니면 null. undefined = 7단계 전에 저장된 세션 */
  externalAgentId?: ExternalAgentId | null;
  /** 메인 세션이면 띄울 때의 자리 세대 (S4-4) */
  seatGeneration?: number;
  mock: boolean;
  /**
   * 세션 첫 턴에 고정한 CLI 모델·노력치 값 (19.1: 진행 중인 세션의 모델은 바꾸지 않는다). 이어하기는 이 값으로 실행한다.
   * undefined = 이 값이 생기기 전에 저장된 세션 (다음 턴의 값으로 고정). 메인 에이전트 세션은 운영 설정을 따른다 (AGT-08)
   */
  model?: string | null;
  effort?: string | null;
  /** CLI 세션 ID (Claude session_id / Codex thread_id). 첫 턴 전에는 null (CLI-06) */
  cliSessionId: string | null;
  cwd: string;
  createdAt: IsoTime;
  closedAt: IsoTime | null;
  previousSessionId: SessionId | null;
  replaceReason: string | null;
  /** 세션 교체 시 새 세션에 넘긴 인계 요약 (ERR-03) */
  handoverSummary: string | null;
  turnCount: number;
  lastTurnAt: IsoTime | null;
}

export type SlotClass = 'management' | 'general';

export type ProcessState =
  | 'starting'
  | 'running'
  | 'stop_requested' // 정지 요청됨 (단계 끝나면 종료)
  | 'terminating' // 종료 중
  | 'exited' // 종료 확인
  | 'kill_failed'; // 종료 확인 실패 (CTL-03)

export type TurnEndReason =
  | 'completed'
  | 'user_stop' // 대표·정지 제어가 요청한 종료 (비정상 종료 재시도 대상 아님, ERR-04)
  | 'crashed' // 비정상 종료
  | 'no_response' // 응답 없음
  | 'timeout' // 턴 시간 상한 초과
  | 'usage_limit'
  | 'auth_required'
  | 'bypass_mismatch'
  | 'app_restart' // 앱 재시작으로 끊김
  | 'spawn_failed'
  | 'spin'; // 헛돌기

export interface TurnUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
}

export interface Turn {
  id: TurnId;
  sessionId: SessionId;
  memberId: MemberId;
  projectId: ProjectId | null;
  /** 이 턴이 어느 프로젝트의 일인지 — 세션의 workProjectId와 같다 (SERVER_DESIGN 5.4, 리드 결정 S5-5). undefined = 5단계 전에 저장된 턴 */
  workProjectId?: ProjectId | null;
  taskId: TaskId | null;
  directiveId: DirectiveId | null;
  sessionKind: SessionKind;
  slotClass: SlotClass;
  queueEntryIds: QueueEntryId[];
  /**
   * 검수 턴: 띄울 때 고정돼 있던 검수 대상의 고정 시각(`ReviewTarget.pinnedAt`) — 그 턴의 읽기용 사본이 이 버전이다. 판정은 이 버전에만
   * 묶는다 (REV-07·08, AC-43: 시각 순서가 아니라 같은 고정인지로 본다). 검수 턴이 아니면 없음
   */
  reviewPinnedAt?: IsoTime | null;
  isResume: boolean;
  /** 외부 에이전트가 실행한 턴이면 'external' (리드 결정 S7-2) */
  aiKind: RunnerKind;
  /** 실행 주체 — undefined는 'cli' (7단계 전에 저장된 턴) */
  runner?: 'cli' | 'external';
  /** runner가 'external'이면 그 에이전트 ID, 아니면 null. undefined = 7단계 전에 저장된 턴 */
  externalAgentId?: ExternalAgentId | null;
  /** 메인 턴이면 띄울 때의 자리 세대 (S4-4) */
  seatGeneration?: number;
  mock: boolean;
  startedAt: IsoTime;
  endedAt: IsoTime | null;
  lastActivityAt: IsoTime;
  process: {
    state: ProcessState;
    pid: number | null;
    /**
     * PID가 생긴 시각(OS 시계, spawn 직후 기록 — 실제 생성 시각보다 같거나 늦다). 재시작 복구가 같은 PID를 쓰는 다른 프로세스를
     * 끊지 않게 프로세스 생성 시각과 대조한다 (windows:F2, ERR-08). 없으면(이전 기록·시작 전) 종료하지 않는다
     */
    spawnedAt?: IsoTime | null;
    /**
     * Linux: 그 PID의 부팅 기준 신원(boot id + /proc 시작 틱, 띄운 직후 기록 — 리드 결정 S10-5.1). 있으면 재시작 복구는 생성 시각 대신 이것으로
     * 정확히 대조한다(벽시계가 움직여도 살아 있는 이전 CLI를 남의 것으로 보지 않는다). 없으면(다른 플랫폼·이전 기록) spawnedAt 규칙
     */
    start?: { bootId: string; ticks: number } | null;
    /**
     * Linux: 그 실행의 환경에 넣은 표시 값(WOOK_RUN_TAG, 띄울 때 기록 — 리드 결정 S10-10.2). 리더가 끝났는데 그룹이 남았으면, 재시작 복구는 남은 구성원
     * 모두의 환경에 이 값이 있을 때만 그 그룹을 끝낸다. 없으면(다른 플랫폼·이전 기록) 그런 그룹은 건드리지 않는다
     */
    runTag?: string | null;
    exitCode: number | null;
    stopRequestedAt: IsoTime | null;
    stopMode: 'graceful' | 'immediate' | null;
    killDetail: string | null;
  };
  endReason: TurnEndReason | null;
  endDetail: string;
  stepsCompleted: number;
  toolCalls: number;
  usage: TurnUsage | null;
  /** 바이패스 적용 확인 (CLI-21): verified = CLI가 적용 상태를 보고함, requested = 옵션만 전달(확인 불가) */
  bypass: 'verified' | 'requested' | 'mismatch';
  mcp: 'connected' | 'unknown' | 'failed';
  /** 비밀 값을 가린 이벤트 JSONL 파일 (CLI-16) */
  eventsFile: string;
  eventCount: number;
  finalText: string | null;
}

// ───────────────────────── 실행 대기열 (5.7) ─────────────────────────
export type WorkKind =
  | 'task_work' // 일반: 작업 수행·계속
  | 'conflict_fix' // 일반: 병합 충돌 해결 (GIT-07)
  | 'review' // 관리: 배정된 검수자의 검수
  | 'plan' // 관리: 프로듀서 계획 (작업 분할·배정, 수정 회차)
  | 'replan' // 관리: 프로듀서 재계획 (3회 반려, 헛돌기, 선행 작업 취소)
  | 'answer' // 관리: 프로듀서 질문 응답
  | 'merge_decision' // 관리: 프로듀서 병합 판단
  | 'final_result' // 관리: 프로듀서 최종 결과 정리
  | 'reviewer_assign' // 관리: 프로듀서 검수자 재배정
  | 'main_command' // 관리: 메인 에이전트 명령 처리
  | 'main_report' // 관리: 메인 에이전트 보고서 작성
  | 'memory_update' // 관리: 메인 에이전트 프로젝트 기억 갱신 (FBK-05)
  | 'change_request' // 관리: 메인 에이전트 — 대표의 보고서 수정 요청 (FBK-03 v0.6, 다음 회차는 revise_directive)
  | 'ai_suggestion' // 관리: 메인 에이전트 — 대표의 팀원 AI 변경 건의 (명령이 아니다, 리드 결정 S10-37 — 메인이 판단해 바꾸거나 그대로 두고 답한다)
  | 'stop_released' // 관리: 메인 에이전트 — 긴급 정지 해제 뒤 보류 목록 (CTL-10 v0.6, 항목별 재개는 resume_task)
  | 'no_reviewer' // 관리: 메인 에이전트 — 검수자 없음 (적격 팀원이 없고 메인도 기여자, REV-06 v0.6)
  | 'alert' // 관리: 메인 에이전트 — 대표에게만 가던 보류·실패를 처리할 일 (SERVER_DESIGN 5.3, 키 alertKey, 리드 결정 S5-7)
  | 'screen_check' // 관리: 메인 에이전트 — 시험 이미지로 화면 보기 확인 (SERVER_DESIGN 10.6, 리드 결정 S6-10)
  | 'message'; // 메인 긴급 지시·직접 지시·팀원 메시지 전달 (대상 세션의 분류를 따름)

export interface QueueEntry {
  id: QueueEntryId;
  kind: WorkKind;
  memberId: MemberId;
  projectId: ProjectId | null;
  taskId: TaskId | null;
  directiveId: DirectiveId | null;
  questionId: QuestionId | null;
  /** 이 업무를 실행할 세션 키. 같은 키의 대기 항목은 한 턴에 묶어 전달 (CLI-19) */
  sessionKey: string;
  slotClass: SlotClass;
  priority: Priority;
  queuedAt: IsoTime;
  state: 'queued' | 'running' | 'done' | 'cancelled';
  /** 다음 턴에 전달할 내용 */
  message: string;
  /** 이미지·파일 첨부 경로 */
  attachments: string[];
  /** 메인 에이전트의 긴급 지시(옛 대표 직접 메시지 포함) 등 우선 전달 */
  urgent: boolean;
  /**
   * 긴급 지시를 프로듀서에게 공유한 사본 (CMD-06, AC-17 — 이름은 옛 대표 직접 메시지 공유 사본에서 왔다). 그 자체로는 턴을 띄우지 않고
   * 그 세션에 다른 일로 턴이 뜰 때 함께 전달한다. 없으면 false
   */
  ownerShared?: boolean;
  /** 이 항목이 전하는 메시지 기록 (AgentMessage — 긴급 지시·팀원 메시지). 이 항목을 실은 턴의 CLI를 띄우면 그 기록을 전달됨으로 적는다 */
  messageId?: MessageId;
  /**
   * 검수 업무(`review`)가 어느 고정 버전의 것인지 — 만들 때의 검수 대상 고정 시각. 다른 버전의 검수 요청에 합치거나 그 버전 검수 턴에
   * 싣지 않는다 (REV-07·08: 이전 버전의 사본 위치·완료 조건이 새 버전 검수에 섞이지 않게). 없으면 버전에 묶이지 않은 항목(질문 답변 등)
   */
  reviewPinnedAt?: IsoTime;
  /**
   * 수정 요청 업무(`change_request`)가 어느 보고서의 것인지. 그 보고서가 더는 수정 요청이 아니거나(대표가 그대로 승인 등) 지시가 끝났거나 새 회차가 열리면
   * 끝난 업무로 보고 다시 전달하지 않는다 (리드 결정 19). 없으면(이전 기록) 업무 글의 보고서 ID로 본다
   */
  reportId?: ReportId;
  /**
   * 프로그램이 일시정지한 팀원 (종료를 확인하지 못한 실행, CTL-11) — 메인 에이전트에게 그 팀원의 재개를 맡긴 업무(`main:<P>`의 `message`)에만 있다.
   * 그 팀원이 재개되거나 삭제되면 끝난 업무다. 그 전에는 메인 턴이 처리하지 않고 끝나도 다시 넣는다 (리드 결정 24·26)
   */
  pausedMemberId?: MemberId;
  /**
   * 메인 에이전트에게 넘긴 보류·실패(`alert`)의 키 — `alert:<종류>:<대상>` (SERVER_DESIGN 5.3). 같은 일은 대기·실행 중인 같은 키 항목이 있거나 그 보류가
   * 걸린 뒤 이미 넣었으면 다시 넣지 않는다 (리드 결정 S5-7). requestId와 섞지 않는다(그 중복 제거는 끝난 항목까지 본다). alert가 아니면 없음
   */
  alertKey?: string;
  turnId: TurnId | null;
  requestId: string | null;
  /**
   * 이 업무를 실은 턴이 비정상 종료형으로 끝나 다시 넣은 횟수 — 비정상 종료·응답 없음·CLI 안전 검사 거부만 센다. 비정상 종료 상한은 항목마다 이것으로 본다
   * (상한이면 그 항목만 버리고 알린다). 사용량 한도·재로그인 필요·이어하기 실패·정지·재시작으로 다시 넣을 때와 재촉·남는 업무의 다시 전달은 세지 않는다
   * (리드 결정 30). 재촉·다시 전달로 새로 넣은 항목은 0부터 센다
   */
  attempts: number;
  /**
   * 재촉·남는 업무로 같은 일을 다시 전달한 횟수 (리드 결정 30) — 멈춘 검수 넘김·일시정지된 팀원의 재개(3번 뒤 대표 알림), 보고서 작성 재촉, 프로듀서·검수
   * 재촉, 계획 재촉, 다시 판정 턴의 다시 전달. 그 상한은 이것으로 보고 비정상 종료 상한(attempts)과 섞지 않는다. 없으면(이전 기록) 0
   */
  deliveries?: number;
  /** 이 항목을 실은 턴이 프로세스를 띄우기 전에 실패한 횟수 — 시작 실패 상한은 이것만 센다 (재전달 횟수와 따로, ERR-04). 없으면 0 */
  startFails?: number;
  /**
   * 이 항목을 실은 턴이 앱·PC 재시작으로 끊겨 재시작 복구가 다시 넣은 횟수 (리드 결정 39) — 그 턴이 앱째 끝내면 재시작마다 다시 넣어 끝없이 돌므로 3번째로
   * 끊기면 다시 넣지 않고 버린 뒤 알린다. 비정상 종료형 끝(attempts)·다시 전달(deliveries)·시작 실패(startFails)와 따로 센다. 끊긴 턴의 업무를 다시 넣을
   * 때(requeue)는 이어 간다. 없으면(이전 기록) 0
   */
  restarts?: number;
  createdAt: IsoTime;
  doneAt: IsoTime | null;
}

// ───────────────────────── 보고서 (6.2, 6.3) ─────────────────────────
export type ReportStatus = 'new' | 'read' | 'approved' | 'changes_requested';

export interface ReportSections {
  summary: string; // 요약 (3줄 이내)
  results: string; // 결과: 한 일, 산출물
  changedFiles: string[]; // 변경 파일 목록
  howToVerify: string; // 확인 방법
  issues: string; // 이슈·리스크
  nextSteps: string; // 다음 할 일
}

export interface ReportStats {
  taskCount: number;
  rejectCount: number;
  durationSec: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
}

export interface Report {
  id: ReportId;
  projectId: ProjectId | null;
  directiveId: DirectiveId | null;
  round: number;
  title: string;
  /** 앱 데이터 폴더의 마크다운 파일 (RPT-03) */
  filePath: string;
  status: ReportStatus;
  sections: ReportSections;
  stats: ReportStats;
  createdAt: IsoTime;
  readAt: IsoTime | null;
  decidedAt: IsoTime | null;
}

export interface ReportComment {
  id: string;
  reportId: ReportId;
  kind: 'overall' | 'anchored';
  quote: string | null;
  text: string;
  createdAt: IsoTime;
}

// ───────────────────────── 알림 (12장) ─────────────────────────
export type NotificationLevel = 'urgent' | 'normal' | 'info';

export type NavTarget =
  | { tab: 'projects'; projectId?: ProjectId; memberId?: MemberId; taskId?: TaskId; directiveId?: DirectiveId }
  | { tab: 'documents'; reportId?: ReportId; projectId?: ProjectId | null }
  | { tab: 'simulation' }
  | { tab: 'settings'; section?: SettingsSection }
  | { tab: 'seat'; panel?: 'screen' }; // 메인 자리와 인계 보기 — 응답 없음·자리 바뀜·교체 멈춤 알림이 여기로 간다 (리드 결정 S4-19). panel 'screen' = 화면 조작 칸 (S6-12)

export type SettingsSection =
  | 'general'
  | 'account'
  | 'team'
  | 'execution'
  | 'policy'
  | 'skills'
  | 'logs'
  | 'developer';

export interface AppNotification {
  id: NotificationId;
  level: NotificationLevel;
  title: string;
  body: string;
  link: NavTarget | null;
  /** 같은 key의 읽지 않은 알림은 새로 만들지 않고 갱신 */
  key: string | null;
  createdAt: IsoTime;
  readAt: IsoTime | null;
}

// ───────────────────────── 대화 기록 (CMD-04) ─────────────────────────
export type ConversationTarget = ProjectId | 'main';
export interface ConversationMessage {
  id: string;
  target: ConversationTarget;
  role: 'owner' | 'main_agent' | 'system';
  text: string;
  attachments: Attachment[];
  directiveId: DirectiveId | null;
  createdAt: IsoTime;
}

// ───────────────────────── 활동 기록 (10.5) ─────────────────────────
export type ActivityKind =
  | 'app_tool'
  | 'command' // CLI가 실행한 명령
  | 'file_change'
  | 'directive'
  | 'task'
  | 'review'
  | 'merge'
  | 'revert'
  | 'report'
  | 'question'
  | 'message'
  | 'error'
  | 'stop'
  | 'resume'
  | 'git'
  | 'exec'
  | 'auth'
  | 'settings'
  | 'session'
  | 'system'
  | 'seat' // 메인 자리 교체·응답 없음·운영자 배정 (SERVER_DESIGN 4.3·4.4, 리드 결정 S4-10)
  | 'journal' // 메인 일지에 에이전트가 쓰고 닫은 것 (6.1)
  | 'screen'; // 화면 조작 (SERVER_DESIGN 10.6, 리드 결정 S6-7)

export interface ActivityEntry {
  seq: number;
  ts: IsoTime;
  actor: Actor;
  projectId: ProjectId | null;
  directiveId: DirectiveId | null;
  taskId: TaskId | null;
  memberId: MemberId | null;
  sessionId: SessionId | null;
  turnId: TurnId | null;
  requestId: string | null;
  kind: ActivityKind;
  level: 'info' | 'warn' | 'error';
  /** 비밀 값 가림 적용 후 내용 */
  text: string;
  result: string | null;
}

// ───────────────────────── 외부 실행·git 요청 기록 (ERR-07, SEC-11, GIT-15) ─────────────────────────
export type ExecKind =
  | 'project_setup'
  | 'git_init'
  | 'git_worktree_add'
  | 'git_commit'
  | 'git_update_from_base'
  | 'git_conflict_commit'
  | 'git_merge'
  | 'git_revert'
  | 'git_worktree_remove'
  | 'git_branch_delete'
  | 'git_archive'
  | 'git_sync_base_checkout'
  | 'auto_check'
  | 'git_push'
  | 'deploy'
  | 'host_exec'; // 메인 에이전트의 서버 PC 명령 (SERVER_DESIGN 8.2, 리드 결정 S5-16) — 재시작 복구 확인(recovery.items)에 넣지 않는다

export interface ExecRecord {
  requestId: RequestId;
  kind: ExecKind;
  projectId: ProjectId | null;
  taskId: TaskId | null;
  cwd: string;
  command: string;
  target: string;
  state: 'started' | 'succeeded' | 'failed' | 'unknown';
  startedAt: IsoTime;
  endedAt: IsoTime | null;
  /** preSha·postSha·mergeCommitSha·exitCode·출력 요약 등 */
  result: Record<string, unknown>;
}

// ───────────────────────── 정지 제어 (9장, CTL-08) ─────────────────────────
export type StopMode = 'graceful' | 'immediate';

export interface ScopeStop {
  paused: boolean;
  mode: StopMode;
  since: IsoTime;
  by: Actor;
  /** 프로그램이 건 정지(by=system)의 까닭 — 대표에게 보이는 글 (예: 프로세스 종료를 확인하지 못함). 대표 정지는 없음 */
  reason?: string;
}

export interface StopState {
  global: { active: boolean; since: IsoTime | null; by: Actor | null; releasedAt: IsoTime | null };
  projects: Record<ProjectId, ScopeStop>;
  members: Record<MemberId, ScopeStop>;
}

// ───────────────────────── AI 도구 가용성 (8장) ─────────────────────────
/**
 * 모델별 주간 한도가 걸리는 모델 계열 — Claude CLI rate_limit_event의 seven_day_opus·seven_day_sonnet (리드 결정 22)과
 * seven_day_overage_included(CLI 이름 'Fable limit', 리드 결정 29)
 */
export type ModelLimitFamily = 'opus' | 'sonnet' | 'fable';

export interface AiAvailability {
  kind: AiKind;
  /** 사용량 한도로 새 턴을 막는 기한 (그 AI 종류 전체 — 5시간·주간 한도 등). null이면 한도 없음 */
  usageLimitedUntil: IsoTime | null;
  /**
   * 모델별 주간 한도의 기한 (계열 → 기한). 그 계열 모델의 턴만 막는다 — 모델을 정하지 않은 턴은 CLI 기본 모델을 알 수 없어 그 계열로 본다.
   * 없으면 없음 (리드 결정 22, @core/usageLimits)
   */
  modelUsageLimits?: Partial<Record<ModelLimitFamily, IsoTime>>;
  /** 인증 만료 — 재로그인 전까지 새 턴 금지 */
  authRequired: boolean;
  authRequiredSince: IsoTime | null;
  cliInstalled: boolean;
  cliVersion: string | null;
  /** 받는 가장 낮은 버전보다 낮음·버전을 읽지 못함·바이패스 설정 불일치 등 (CLI-15) — 확인한 범위보다 새 버전은 여기 들어오지 않는다 (리드 결정 S10-38) */
  cliProblem: string | null;
  checkedAt: IsoTime | null;
}

// ───────────────────────── 대표 ─────────────────────────
export interface Owner {
  /** 구글 계정 고유 ID (sub) */
  sub: string;
  email: string;
  name: string;
  registeredAt: IsoTime;
  lastLoginAt: IsoTime | null;
}

// ───────────────────────── 상태 전이 기록 (TSK-03) ─────────────────────────
export interface TransitionRecord {
  seq: number;
  entity: 'task' | 'directive';
  entityId: string;
  from: string;
  event: string;
  to: string;
  reason: string;
  actor: Actor;
  at: IsoTime;
  requestId: string | null;
}

// ───────────────────────── 스킬 (SKL-03) ─────────────────────────
export interface SkillEntry {
  /** 스킬 이름 (폴더 이름 또는 frontmatter name) */
  name: string;
  description: string;
  source: AiKind;
  path: string;
  mode: 'auto' | 'manual';
}

// ───────────────────────── 운영 설정 (13.7) ─────────────────────────
export interface EffortMapping {
  claude: Record<EffortTier, string>;
  codex: Record<EffortTier, string>;
}

export interface Settings {
  general: {
    mainAgent: AiConfig;
    backup: { enabled: boolean; keep: number };
    /** 2차 */
    launchAtLogin: boolean;
  };
  account: {
    googleClientId: string;
    /** 데스크톱 OAuth 클라이언트 보안 비밀은 키체인에 저장 — 여기에는 설정 여부만 */
    googleClientSecretSet: boolean;
    authMode: Record<AiKind, 'subscription' | 'api_key'>;
  };
  team: {
    effortMapping: EffortMapping;
    /** 메인 에이전트가 고를 수 있는 모델 목록. 비어 있으면 CLI 기본 모델만 */
    modelCatalog?: Record<AiKind, ModelOption[]>;
  };
  execution: {
    /** 전체 CLI 턴 상한 N (ORG-07). 기본 5 */
    maxConcurrent: number;
    turnTimeoutMin: number; // 턴 시간 상한 (CLI-22) 기본 60
    claudeMaxTurns: number | null; // --max-turns (CLI-22)
    noOutputMin: number; // 응답 없음 기준 10분
    commandMaxMin: number; // 실행 명령 별도 제한 30분
    healthCheckMin: number; // 상태 확인 후 대기 3분
    crashRetryMax: number; // 비정상 종료 재개 최대 2회
    spinSameErrorCount: number; // 같은 오류 5회
    spinNoProgressMin: number; // 진척 없는 30분
    spinNoProgressResumes: number; // 진척 없는 자동 재개 3회
    preventSleep: boolean; // 절전 방지 (ENV-11)
  };
  policy: {
    emergencyShortcut: string;
    sensitiveAreas: { kind: 'system' | 'personal' | 'secret' | 'app'; paths: string[] }[];
  };
  skills: { overrides: Record<string, 'auto' | 'manual'> };
  logs: { retentionDays: number };
  developer: {
    /** 메인 에이전트를 모의 에이전트로 실행 */
    mainAgentMock: boolean;
    mockSpeed: number;
  };
  cli: { claudePath: string | null; codexPath: string | null };
}
