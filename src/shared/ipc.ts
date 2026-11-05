/**
 * 화면 ↔ main 프로세스 IPC 규약.
 * - 요청: window.wook.invoke(method, ...args) → Promise<결과>
 * - 구독: window.wook.subscribe(topic, cb) → 해제 함수
 * preload는 이 목록에 있는 이름만 통과시킨다. 메서드를 추가하면 IPC_METHODS에도 넣는다.
 */
import type {
  AiConfig,
  AiKind,
  AnchoredComment,
  DirectiveId,
  MemberId,
  MockScenario,
  NavTarget,
  ProjectId,
  QuestionId,
  ReportId,
  RoleId,
  Settings,
  SettingsSection,
  StopMode,
  TaskId,
  TaskType,
} from './domain';
import type {
  AiConfigInput,
  AppSnapshot,
  AuthState,
  DeviceLoginPoll,
  DeviceLoginStart,
  DeviceSessionView,
  CliEventPage,
  ConversationView,
  DiffView,
  DirectiveDetail,
  EmergencySummary,
  MemberDetail,
  NotificationView,
  PrereqStatus,
  ProjectView,
  RecoveryItemView,
  ReportDetail,
  ReportListItem,
  RoleView,
  SkillView,
  TaskDetail,
  ActivityView,
  MemberView,
  SystemInfo,
  SeatView,
  SeatHistoryEntry,
  SeatHandoverView,
  JournalFilter,
  JournalPage,
} from './views';
import type { CliEvent } from './events';

export interface CreateProjectInput {
  /** existing = 기존 폴더 연결, new = 새 폴더 만들기 (HOME-05) */
  mode: 'existing' | 'new';
  /** existing: 연결할 폴더. new: 만들 폴더의 전체 경로 */
  path: string;
  name: string;
  checkCommands?: string[];
}

export interface AddMemberInput {
  projectId: ProjectId;
  roleId: RoleId;
  /** 비우면 자동 이름 */
  name?: string;
  ai?: AiConfigInput;
}

export interface UpdateMemberInput {
  name?: string;
  roleId?: RoleId;
  ai?: AiConfigInput;
  mockScenario?: MockScenario | null;
}

export interface SendCommandInput {
  /** 프로젝트 ID 또는 'main'(메인 에이전트 직접, CMD-02) */
  target: ProjectId | 'main';
  text: string;
  /**
   * 첨부 파일 경로 (CMD-03). 클립보드 이미지는 dataUrl로. 서버에 접속한 화면은 경로 대신 POST /api/uploads로 올린 파일의 uploadId를 쓴다 — 서버는 원격
   * 화면이 보낸 경로를 받지 않는다 (SERVER_DESIGN 3.4, 리드 결정 S3-10)
   */
  attachments?: { path?: string; name: string; dataUrl?: string; uploadId?: string }[];
}

export interface RequestChangesInput {
  overall: string;
  anchored: AnchoredComment[];
}

export interface LogFilter {
  text?: string;
  projectId?: ProjectId | null;
  memberId?: MemberId | null;
  taskId?: TaskId | null;
  kinds?: string[];
  level?: 'info' | 'warn' | 'error';
  from?: string;
  to?: string;
  limit?: number;
  beforeSeq?: number;
}

export interface ReportFilter {
  text?: string;
  projectId?: ProjectId | 'general' | null;
  status?: 'new' | 'read' | 'approved' | 'changes_requested';
  from?: string;
  to?: string;
}

export interface RoleInput {
  name: string;
  instructions: string;
  taskTypes: TaskType[];
  allowedSkills: string[];
  defaultAi: { kind: AiKind; model: string | null; effortTier: 'high' | 'normal' | 'low'; effortOverride: string | null };
  canReview: boolean;
}

/** 깊은 부분 갱신 */
export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : DeepPartial<T[K]>) : T[K] };

export interface WookApiMethods {
  // 로그인 (15.1)
  'auth.getState': () => AuthState;
  'auth.login': () => AuthState;
  'auth.devLogin': () => AuthState;
  'auth.logout': () => AuthState;
  // 서버 로그인 (SERVER_DESIGN 3.5, S3-4~6) — 기기 코드 로그인·대표 이메일 첫 설정은 서버에서만 쓴다 (데스크톱은 거부). 기기 목록·끊기는 대표 메서드다
  'auth.deviceLogin': (deviceName?: string) => DeviceLoginStart;
  'auth.deviceLoginPoll': (loginId: string) => DeviceLoginPoll;
  'auth.setupOwner': (code: string, email: string) => AuthState;
  'auth.listDevices': () => DeviceSessionView[];
  'auth.revokeDevice': (sessionId: string) => DeviceSessionView[];

  // 전체 상태
  'snapshot.get': () => AppSnapshot;

  // 프로젝트
  'projects.create': (input: CreateProjectInput) => ProjectView;
  'projects.update': (
    id: ProjectId,
    patch: {
      name?: string;
      checkCommands?: string[];
      networkPolicy?: 'allow' | 'restricted';
      /** 원격 올리기·배포 설정 (GIT-12). null이면 해당 작업을 만들지 않음 */
      deploy?: { pushRemote: string | null; deployCommand: string | null };
    },
  ) => ProjectView;
  'projects.pause': (id: ProjectId, mode: StopMode) => void;
  'projects.resume': (id: ProjectId) => void;
  'projects.setMock': (id: ProjectId, mock: { enabled: boolean; speed?: number; defaultScenario?: MockScenario }) => ProjectView;

  // 팀원
  'members.add': (input: AddMemberInput) => MemberView;
  'members.update': (id: MemberId, patch: UpdateMemberInput) => MemberView;
  'members.remove': (id: MemberId) => void;
  /** 프로듀서는 삭제 대신 교체만 (ORG-04) */
  'members.replaceProducer': (projectId: ProjectId, input: { name?: string; ai?: AiConfigInput }) => MemberView;
  'members.pause': (id: MemberId, mode: StopMode) => void;
  'members.resume': (id: MemberId) => void;
  /** 현재 작업 중단 → 보류 또는 취소 (9장) */
  'members.interrupt': (id: MemberId, then: 'hold' | 'cancel') => void;
  'members.getDetail': (id: MemberId) => MemberDetail;
  /** CLI 이벤트 조회. turnId 생략 시 최근 턴. cursor는 이전 결과의 nextCursor */
  'members.getEvents': (id: MemberId, opts: { turnId?: string; cursor?: string | null; limit?: number }) => CliEventPage;

  // 명령창 (6.1)
  'command.send': (input: SendCommandInput) => { conversationId: string };
  'command.history': (target: ProjectId | 'main', opts: { before?: string; limit?: number }) => ConversationView[];

  // 지시·작업
  'directives.get': (id: DirectiveId) => DirectiveDetail;
  'directives.cancel': (id: DirectiveId) => void;
  'tasks.get': (id: TaskId) => TaskDetail;
  'tasks.getDiff': (id: TaskId) => DiffView;
  /** 항목별 명시적 재개 (CTL-10) */
  'tasks.resume': (id: TaskId) => void;
  'tasks.cancel': (id: TaskId) => void;
  'tasks.interrupt': (id: TaskId, then: 'hold' | 'cancel') => void;

  // 질문 답변 (대표에게 온 질문)
  'questions.answer': (id: QuestionId, answer: string) => void;

  // 보고서·문서함 (6.2, 13.5)
  'reports.list': (filter: ReportFilter) => ReportListItem[];
  'reports.get': (id: ReportId) => ReportDetail;
  'reports.markRead': (id: ReportId) => void;
  /** 결과 승인 (FBK-01) — 이미 반영된 결과의 사후 확인 */
  'reports.approve': (id: ReportId, comment: string) => void;
  /** 수정 요청 (FBK-02·03) */
  'reports.requestChanges': (id: ReportId, input: RequestChangesInput) => void;

  // 알림 (12장)
  'notifications.list': (opts: { limit?: number }) => NotificationView[];
  'notifications.markRead': (id: string | 'all') => void;

  // 정지 (9장)
  'stop.emergency': () => EmergencySummary;
  /** 전역 정지 해제 — 대표 확인 후 호출. 작업은 재개하지 않음 (CTL-10) */
  'stop.release': () => void;

  // 메인 자리와 일지 (SERVER_DESIGN 4·6장, 리드 결정 S4-7) — 보기만. 자리를 바꾸는 메서드는 없다 (S4-2)
  'seat.get': () => SeatView;
  /** 새것부터, 최대 200줄 */
  'seat.history': () => SeatHistoryEntry[];
  /** 인자가 없으면 지금 세대. 그 세대에 꾸러미가 없으면 null */
  'seat.handover': (generation?: number) => SeatHandoverView | null;
  'journal.list': (filter?: JournalFilter) => JournalPage;

  // 복구 확인 (ERR-08)
  'recovery.list': () => RecoveryItemView[];
  /** applied = 이미 반영된 것으로 처리, retry = 다시 실행, cancel = 작업 취소 */
  'recovery.resolve': (requestId: string, action: 'applied' | 'retry' | 'cancel') => void;

  // 운영 설정 (13.7)
  'settings.get': () => Settings;
  /**
   * 설정 저장. 데스크톱 화면이 메인 AI(general.mainAgent)를 보낼 때는 그 화면이 불러 온 메인 AI 값을 `expected.mainAgent`로 함께 보낸다.
   * 그사이 저장된 메인 AI가 달라졌으면(메인이 자리를 넘겼거나 모델을 바꿨으면) 아무것도 저장하지 않고 'conflict'로 거부한다 (리드 결정 S4-25).
   * 설치 설정 저장(기록 보관 등)은 general.mainAgent를 보내지 않는다
   */
  'settings.update': (patch: DeepPartial<Settings>, expected?: { mainAgent?: AiConfig }) => Settings;
  /** 구글 OAuth 클라이언트 보안 비밀 저장 (키체인) */
  'settings.setGoogleSecret': (secret: string) => void;
  /** API 키 등록 (키체인, ENV-05) */
  'settings.setApiKey': (kind: AiKind, key: string | null) => void;
  'roles.list': () => RoleView[];
  'roles.create': (input: RoleInput) => RoleView;
  'roles.update': (id: RoleId, input: RoleInput) => RoleView;
  'roles.delete': (id: RoleId) => void;
  'skills.list': () => SkillView[];
  'skills.setMode': (name: string, mode: 'auto' | 'manual') => void;
  'skills.setRoleSkills': (roleId: RoleId, skills: string[]) => void;
  'logs.search': (filter: LogFilter) => ActivityView[];
  /** 내보내기 → 저장한 파일 경로 */
  'logs.export': (filter: LogFilter) => { path: string };

  // 시스템
  'system.prereqs': () => PrereqStatus;
  /** 데이터 폴더·버전 등 읽기 전용 정보 (운영 설정 > 일반) */
  'system.info': () => SystemInfo;
  'system.recheckAi': (kind: AiKind) => void;
  'system.pickFiles': () => { path: string; name: string }[];
  'system.openPath': (path: string) => void;
  'system.backupNow': () => { path: string };
}

export type WookMethod = keyof WookApiMethods;
export type WookParams<M extends WookMethod> = Parameters<WookApiMethods[M]>;
export type WookResult<M extends WookMethod> = ReturnType<WookApiMethods[M]>;

/** main → 화면 푸시 */
export interface WookTopics {
  /** 상태가 바뀔 때마다 (ENV-08: 2초 안) */
  snapshot: AppSnapshot;
  /** 실시간 CLI 이벤트 (팀원 상세 열려 있을 때) */
  cliEvents: { memberId: MemberId; turnId: string; events: CliEvent[] };
  /** 새 알림 (화면 안 토스트) */
  notification: NotificationView;
  /** 트레이·OS 알림 클릭 → 화면 이동 */
  navigate: NavTarget;
  /** 긴급 정지 결과 요약 (CTL-04) */
  emergency: EmergencySummary;
  /** 설정 화면 열기 요청 */
  openSettings: { section: SettingsSection };
}
export type WookTopic = keyof WookTopics;

/** 화면 쪽 API (preload가 window.wook으로 노출) */
export interface WookBridge {
  invoke<M extends WookMethod>(method: M, ...args: WookParams<M>): Promise<WookResult<M>>;
  subscribe<T extends WookTopic>(topic: T, cb: (payload: WookTopics[T]) => void): () => void;
  /** 실행 환경 */
  platform: 'win32' | 'darwin' | 'linux' | 'web';
}

/**
 * 화면 약속의 메서드 전부 (요청 처리 공용 부분 backend/invokeCore.ts의 허용 목록). 데스크톱 preload는 이 가운데 DESKTOP_METHODS만 통과시킨다.
 * `WookApiMethods`의 키와 정확히 같아야 한다 — 글자 그대로의 목록 타입으로 두어 계약 시험(tests/unit/ipcContract.test.ts)이 컴파일 때도 본다 (S2-10)
 */
export const IPC_METHODS = [
  'auth.getState',
  'auth.login',
  'auth.devLogin',
  'auth.logout',
  'auth.deviceLogin',
  'auth.deviceLoginPoll',
  'auth.setupOwner',
  'auth.listDevices',
  'auth.revokeDevice',
  'snapshot.get',
  'projects.create',
  'projects.update',
  'projects.pause',
  'projects.resume',
  'projects.setMock',
  'members.add',
  'members.update',
  'members.remove',
  'members.replaceProducer',
  'members.pause',
  'members.resume',
  'members.interrupt',
  'members.getDetail',
  'members.getEvents',
  'command.send',
  'command.history',
  'directives.get',
  'directives.cancel',
  'tasks.get',
  'tasks.getDiff',
  'tasks.resume',
  'tasks.cancel',
  'tasks.interrupt',
  'questions.answer',
  'reports.list',
  'reports.get',
  'reports.markRead',
  'reports.approve',
  'reports.requestChanges',
  'notifications.list',
  'notifications.markRead',
  'stop.emergency',
  'stop.release',
  'seat.get',
  'seat.history',
  'seat.handover',
  'journal.list',
  'recovery.list',
  'recovery.resolve',
  'settings.get',
  'settings.update',
  'settings.setGoogleSecret',
  'settings.setApiKey',
  'roles.list',
  'roles.create',
  'roles.update',
  'roles.delete',
  'skills.list',
  'skills.setMode',
  'skills.setRoleSkills',
  'logs.search',
  'logs.export',
  'system.prereqs',
  'system.info',
  'system.recheckAi',
  'system.pickFiles',
  'system.openPath',
  'system.backupNow',
] as const satisfies readonly WookMethod[];

/**
 * 대표 메서드 (SERVER_DESIGN 2.4 '유지' 32개, OWN-02·03·05, AC-51): 대표 세션이 부를 수 있는 것은 명령·답변·결과 승인/수정 요청·긴급 정지/해제·
 * 보기·본인 로그인뿐이다. 나머지 운영(팀·프로젝트·작업·역할·설정·복구 확인)은 메인 에이전트가 앱 도구로 한다 — 대표 세션의 그런 요청은 서버
 * (Backend.invoke)가 거부하고 기록한다. 화면에서 버튼을 숨기는 것으로 대신하지 않는다.
 * CLI 다시 확인(system.recheckAi)은 CLI 상태를 다시 읽을 뿐 팀·작업·설정을 바꾸지 않는 보기라 대표에게 남긴다 — 메인 에이전트의 AI 종류가 재로그인
 * 필요로 막히면 메인은 턴이 뜨지 않아 recheck_ai를 부를 수 없다 (리드 결정 7, 10-29). 메인의 recheck_ai도 그대로 있다.
 * 메인 도구·운영자로 옮긴 27개는 운영자 내부 API와 메인 도구 처리기가 같은 처리기를 쓰므로 WookApiMethods·IPC_METHODS에 남고, 대표 세션에는
 * `forbidden`이다. 기능 자체를 없앤 셋(대표 직접 메시지·대표 검수·폴더 고르기, 2.4 '없앰')은 화면 정리 뒤 화면 약속과 처리기에서 지웠다 — 그 이름은
 * 이제 알 수 없는 요청이다 (리드 결정 21, 10-29)
 * 4단계 보기 4개(seat.get·seat.history·seat.handover·journal.list, 리드 결정 S4-7)는 보기만 한다. 로그인해야 부를 수 있고, 자리를 바꾸는 대표 메서드는 없다 (S4-2)
 */
export const OWNER_METHODS = [
  'auth.getState',
  'auth.login',
  'auth.logout',
  'auth.deviceLogin',
  'auth.deviceLoginPoll',
  'auth.setupOwner',
  'auth.listDevices',
  'auth.revokeDevice',
  'snapshot.get',
  'members.getDetail',
  'members.getEvents',
  'command.send',
  'command.history',
  'directives.get',
  'tasks.get',
  'tasks.getDiff',
  'questions.answer',
  'reports.list',
  'reports.get',
  'reports.markRead',
  'reports.approve',
  'reports.requestChanges',
  'notifications.list',
  'notifications.markRead',
  'stop.emergency',
  'stop.release',
  'seat.get',
  'seat.history',
  'seat.handover',
  'journal.list',
  'recovery.list',
  'settings.get',
  'roles.list',
  'skills.list',
  'logs.search',
  'logs.export',
  'system.prereqs',
  'system.info',
  'system.recheckAi',
  'system.pickFiles',
  'system.openPath',
] as const satisfies readonly WookMethod[];
export type OwnerMethod = (typeof OWNER_METHODS)[number];

/**
 * 데스크톱 앱만 더 받는 운영자 로컬 메서드 (SERVER_DESIGN 2.5): 데스크톱에서는 그 PC의 사람이 대표이자 운영자다. 개발 실행 로그인, 구글 로그인 설정,
 * API 키 등록, 그리고 `settings.update` 중 운영자 항목(DESKTOP_OPERATOR_SETTINGS — 다른 항목이 섞이면 거부)만.
 * 프로젝트 모의 실행(`projects.setMock`)은 끄기만 받는다 — 인자가 `{ enabled: false }` 하나일 때만. 1단계 전에 개발자 옵션에서 켠 모의 실행을 끌 길이다
 * (리드 결정 23). 켜기는 데스크톱·원격·메인 에이전트 모두 거부한다
 * 서버의 원격 경로에는 이 목록이 없다 (운영자 설정은 관리 소켓으로만)
 */
export const DESKTOP_OPERATOR_METHODS = ['auth.devLogin', 'settings.setGoogleSecret', 'settings.setApiKey', 'settings.update', 'projects.setMock'] as const satisfies readonly WookMethod[];
/**
 * `settings.update`에서 데스크톱 운영자가 바꿀 수 있는 설정 항목 (점으로 이은 경로, 그 아래 전부): 계정·구글(AI 인증 방식 account.authMode 포함 — 결제
 * 방식은 설치의 일이기도 하다, 리드 결정 9), CLI 실행 파일 위치, 그리고 운영자 몫인 보안 정책(민감 영역·긴급 정지 단축키)·기록 보관 기간·자동 백업 켜기·
 * 로그인 때 실행 (리드 결정 2, 2026-10-29) — 메인 에이전트가 보안 정책을 약하게 하거나 기록을 줄이지 못하게 update_settings 허용 항목에는 넣지 않는다
 * (AC-19, LOG-03). 메인 AI(처음 보유자 general.mainAgent)도 운영자 몫이다 — 그 PC에 메인 AI 종류의 CLI가 없으면 데스크톱 운영자가 바꾼다
 * (리드 결정 8, 4단계 자리 넘기기가 대신할 때까지). 원격 경로와 update_settings는 계속 거부한다. 서버에서는 운영자 설정·내부 API로만 바뀐다
 */
export const DESKTOP_OPERATOR_SETTINGS: readonly string[] = ['account', 'cli', 'policy', 'logs.retentionDays', 'general.backup.enabled', 'general.launchAtLogin', 'general.mainAgent'];
/**
 * `settings.update`에서 데스크톱 운영자가 끄기(false)만 할 수 있는 항목 — 값까지 본다. 메인 에이전트 모의 모드는 개발·시험 전용이라, 1단계 전에 켜 둔
 * 것을 끌 길만 둔다 (리드 결정 23). 켜기(true)나 다른 값은 거부한다. 원격 경로와 update_settings는 끄기도 거부한다
 */
export const DESKTOP_OPERATOR_OFF_ONLY_SETTINGS: readonly string[] = ['developer.mainAgentMock'];

/** 데스크톱 preload 허용 목록: 대표 메서드 + 운영자 로컬 메서드 */
export const DESKTOP_METHODS: readonly WookMethod[] = [...OWNER_METHODS, ...DESKTOP_OPERATOR_METHODS];

/** 푸시 토픽 전부 — `WookTopics`의 키와 정확히 같다 (계약 시험, S2-10) */
export const IPC_TOPICS = ['snapshot', 'cliEvents', 'notification', 'navigate', 'emergency', 'openSettings'] as const satisfies readonly WookTopic[];

export const IPC_INVOKE_CHANNEL = 'wook:invoke';
export const IPC_TOPIC_PREFIX = 'wook:topic:';

/** IPC 오류 응답 형식 — 화면에 그대로 보여줄 수 있는 한국어 메시지 */
export interface WookErrorPayload {
  code: string;
  message: string;
}
