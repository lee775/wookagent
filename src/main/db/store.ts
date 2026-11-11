/**
 * SQLite 저장소 (ENV-06, TSK-08, CTL-08).
 * - 엔티티는 JSON 문서로 저장하고, 조회에 쓰는 몇 개 열(project_id, state, ref1, ref2)을 따로 둔다.
 * - WAL + synchronous=FULL: 정지·보류 같은 상태 변경을 즉시 디스크에 남긴다.
 * - 활동 기록(activity)은 덧붙이기만 한다 (LOG-03). 삭제는 보관 기간 정리 함수만.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  ActivityEntry,
  AgentMessage,
  AiConfig,
  AgentSession,
  AppNotification,
  ConversationMessage,
  Directive,
  ExecRecord,
  Member,
  Project,
  Question,
  QueueEntry,
  Report,
  ReportComment,
  ReviewRecord,
  Role,
  Step,
  Task,
  TransitionRecord,
  Turn,
} from '@shared/domain';
import type { GuiAction, GuiResult, HandoverSection, JournalKind, JournalRef } from '@shared/views';
import { formatId, type IdKind } from '@core/ids';

type Indexer<T> = (row: T) => { project_id?: string | null; state?: string | null; ref1?: string | null; ref2?: string | null };

export interface DocFilter {
  project_id?: string | null;
  state?: string | string[];
  ref1?: string;
  ref2?: string;
}

export interface DocRepo<T> {
  get(id: string): T | null;
  /** 없으면 오류 */
  require(id: string): T;
  insert(row: T): T;
  /** 전체 교체 */
  put(row: T): T;
  /** 부분 갱신 후 저장한 값 반환 */
  patch(id: string, patch: Partial<T>): T;
  list(filter?: DocFilter, opts?: { orderBy?: 'created' | 'id'; desc?: boolean; limit?: number }): T[];
  count(filter?: DocFilter): number;
  delete(id: string): void;
}

export interface StepRepo {
  list(taskId: string): Step[];
  put(step: Step): void;
  replaceAll(taskId: string, steps: Step[]): void;
}

export interface ActivityFilter {
  text?: string;
  projectId?: string | null;
  memberId?: string | null;
  taskId?: string | null;
  turnId?: string | null;
  kinds?: string[];
  level?: 'info' | 'warn' | 'error';
  from?: string;
  to?: string;
  beforeSeq?: number;
  limit?: number;
}

export interface Store {
  readonly db: DatabaseSync;
  readonly path: string;
  tx<T>(fn: () => T): T;
  nextId(kind: IdKind): string;
  projects: DocRepo<Project>;
  members: DocRepo<Member>;
  roles: DocRepo<Role>;
  directives: DocRepo<Directive>;
  tasks: DocRepo<Task>;
  steps: StepRepo;
  reviews: DocRepo<ReviewRecord>;
  questions: DocRepo<Question>;
  messages: DocRepo<AgentMessage>;
  sessions: DocRepo<AgentSession>;
  turns: DocRepo<Turn>;
  queue: DocRepo<QueueEntry>;
  reports: DocRepo<Report>;
  reportComments: DocRepo<ReportComment>;
  notifications: DocRepo<AppNotification>;
  conversation: DocRepo<ConversationMessage>;
  execs: DocRepo<ExecRecord>;
  transitions: {
    append(t: Omit<TransitionRecord, 'seq'>): TransitionRecord;
    list(entityId: string): TransitionRecord[];
  };
  activity: {
    append(e: Omit<ActivityEntry, 'seq'>): ActivityEntry;
    search(f: ActivityFilter): ActivityEntry[];
    purgeOlderThan(iso: string): number;
  };
  kv: {
    get<T>(key: string): T | null;
    set<T>(key: string, value: T): void;
    /** prefix로 시작하는 칸 가운데 값의 at(ISO)이 before보다 이른 것을 지운다 — 지운 수 (도구 중복 캐시의 보관 기간, 리드 결정 S4-4) */
    purgeStamped(prefix: string, before: string): number;
  };
  /** 메인 자리 한 줄 (id 'main', SERVER_DESIGN 4.1) — 바꾸는 곳은 orchestrator/seat.ts의 SeatService뿐이다 (리드 결정 S4-2) */
  seat: DocRepo<MainSeatRow>;
  /** 자리 이력 (seat_history, 세대마다 한 줄) */
  seatHistory: DocRepo<SeatHistoryRow>;
  /** 세대별 인계 꾸러미 (seat_handover, 6.2) */
  seatHandovers: DocRepo<SeatHandoverRow>;
  /** 메인 에이전트 일지 (main_journal, 6.1 — 리드 결정 S4-6). 쓰는 곳은 orchestrator/journal.ts의 JournalService뿐이다 */
  journal: JournalRepo;
  /**
   * 화면 조작 기록 (gui_actions, 6판 — SERVER_DESIGN 8.3.5·리드 결정 S6-7). 쓰는 곳은 desktop/guiRecords.ts의 GuiRecords뿐이다 — 저장 전에 가린다.
   * 이미지 바이트는 두지 않는다 (캡처 ID와 sha256만)
   */
  guiActions: GuiActionRepo;
  /** 대표의 기기 세션 (서버 모드, SERVER_DESIGN 3.5·리드 결정 S3-4) — 토큰 원문은 두지 않고 해시만 */
  ownerSessions: OwnerSessionRepo;
  /** 같은 요청 ID의 저장한 답 (서버 모드, 리드 결정 S3-9 — backend/requestReplies.ts) — 인자 원문은 두지 않고 지문만 */
  requestReplies: RequestReplyRepo;
  /**
   * 외부 에이전트 (external_agents, 7판 — SERVER_DESIGN 4.1·4.5, 리드 결정 S7-2·S7-3). 쓰는 곳은 orchestrator/externalAgents.ts뿐이다 — 키 원문은 두지 않고
   * sha256만
   */
  externalAgents: ExternalAgentRepo;
  /** 온라인 백업 (VACUUM INTO) */
  backupTo(file: string): void;
  close(): void;
}

/**
 * 대표의 기기 세션 한 줄 (owner_sessions, S3-4). 시각은 ISO 문자열. tokenHash는 `wos_` 토큰의 SHA-256(16진수) — 원문은 어디에도 두지 않는다.
 * ownerSub: 세션을 연 대표의 구글 sub — 등록된 대표가 바뀌면 그 앞의 세션은 살아 있지 않다(auth/deviceSessions.ts)
 */
export interface OwnerSessionRow {
  id: string;
  tokenHash: string;
  deviceName: string;
  tailscaleLogin: string | null;
  ownerSub: string;
  createdAt: string;
  lastUsedAt: string;
  /** 쉬다가 끝나는 때 (마지막 사용 + 14일) */
  idleExpiresAt: string;
  /** 최대 (만든 때 + 90일) */
  absoluteExpiresAt: string;
  revokedAt: string | null;
  /** 끊은 쪽 (owner·operator·system) */
  revokedBy: string | null;
}

export interface OwnerSessionRepo {
  insert(row: OwnerSessionRow): void;
  get(id: string): OwnerSessionRow | null;
  byTokenHash(hash: string): OwnerSessionRow | null;
  /** 끊지 않은 세션 (만든 차례) — 만료는 부르는 쪽이 본다 */
  listActive(): OwnerSessionRow[];
  /** 마지막 사용과 쉬는 만료를 늦춘다 (끊긴 세션은 그대로) */
  touch(id: string, lastUsedAt: string, idleExpiresAt: string): void;
  /** 끊는다. 이미 끊겼거나 없으면 false */
  revoke(id: string, revokedAt: string, revokedBy: string): boolean;
}

/** 같은 요청 ID의 저장한 답 한 줄 (request_replies, S3-9). outcome은 화면에 준 답 — 성공 값 또는 오류 code·글 */
export interface RequestReplyRow {
  sessionId: string;
  /** 요청 ID의 SHA-256 (원문은 두지 않는다) */
  requestId: string;
  method: string;
  /** 인자 JSON의 SHA-256 (원문은 두지 않는다) */
  argsDigest: string;
  outcome: { ok: true; value?: unknown } | { ok: false; code: string; message: string };
  createdAt: string;
}

export interface RequestReplyRepo {
  /** 그 (세션, 요청 ID)의 답 — notBefore(ISO)보다 오래된 것은 없는 것으로 본다 */
  get(sessionId: string, requestId: string, notBefore: string): RequestReplyRow | null;
  /** 남긴다 (같은 키가 이미 있으면 그대로 둔다 — 첫 답이 남는다) */
  insert(row: RequestReplyRow): void;
  /** iso보다 오래된 답을 지운다 — 지운 수 */
  purgeOlderThan(iso: string): number;
}

/**
 * 외부 에이전트 한 줄 (external_agents, 7판 — 리드 결정 S7-2·S7-3). id는 순번 'X-0001'(폐기해도 다시 쓰지 않는다). keyHash는 키 `wsk_…`의 sha256(16진수) —
 * 원문은 어디에도 두지 않는다. 폐기는 운영자만 한다. lastSeenAt은 마지막으로 인증된 에이전트 API 호출 (자주 쓰지 않게 간격을 두고 적는다)
 */
export interface ExternalAgentRow {
  id: string;
  label: string;
  keyHash: string;
  createdAt: string;
  revokedAt: string | null;
  revokedBy: 'operator' | null;
  lastSeenAt: string | null;
}

export interface ExternalAgentRepo {
  insert(row: ExternalAgentRow): void;
  get(id: string): ExternalAgentRow | null;
  byKeyHash(hash: string): ExternalAgentRow | null;
  /** 모두 (ID 차례) */
  list(): ExternalAgentRow[];
  /** 폐기한다. 이미 폐기됐거나 없으면 false */
  revoke(id: string, revokedAt: string, revokedBy: 'operator'): boolean;
  /** 마지막 접속을 적는다 (폐기된 줄은 그대로) */
  touch(id: string, lastSeenAt: string): void;
}

/**
 * 외부 보유자의 임대 (리드 결정 S7-2·S7-4 — 7단계 S7b가 쓴다). 메인 자리 한 줄의 lease 칸에 두고 서버가 시작할 때 비운다. leaseHash는 임대 ID의 sha256 —
 * 원문은 에이전트에게만 간다
 */
export interface SeatLeaseRow {
  agentId: string;
  leaseHash: string;
  generation: number;
  claimedAt: string;
  heartbeatAt: string;
  expiresAt: string;
}

/** 메인 자리 보유자 (SERVER_DESIGN 4.1) — 저장 모양. 외부 보유자(external)의 label은 등록 기록(external_agents)의 이름이다 (리드 결정 S7-4) */
export type SeatHolder = { kind: 'launched'; ai: AiConfig } | { kind: 'external'; agentId: string; label: string };

/** 자리를 바꾼 쪽 — 대표는 없다 (리드 결정 S4-2) */
export type SeatChanger = 'main' | 'operator' | 'server';

/** 진행 중인 자리 교체 (switching일 때만 — 4.3 교체 순서의 2~7번). 앱을 다시 시작해도 이어 간다 */
export interface SeatSwapRow {
  /** 나가는 세대 */
  from: number;
  /** 들어오는 세대 (= 자리의 generation) */
  to: number;
  by: SeatChanger;
  /** 바꾸는 까닭 (가린 글) */
  reason: string;
  /** 넘기는 쪽이 남긴 말 (hand_off_seat의 note, 가린 글) */
  note: string | null;
  /** 운영자 --force: 실행 중인 메인 턴을 바로 멈추고 마무리를 기다리지 않는다 */
  force: boolean;
  /** hand_off_seat를 부른 턴 — 그 턴이 끝나면 넘어간다 */
  callerTurnId: string | null;
  requestedAt: string;
  /** draining: 메인 턴의 마무리를 기다린다 · unconfirmed: 그 턴의 종료를 확인하지 못해 멈췄다(CTL-11) · finishing: 3~7번 */
  stage: 'draining' | 'unconfirmed' | 'finishing';
  /** 3번 인계 메모 턴 (S4b) — 띄웠으면 그 턴. 그 턴의 도구는 일지·기억 쓰기와 조회만 받는다. 한 번 띄웠으면 다시 주지 않는다 */
  memoTurnId?: string | null;
  /** 3번을 건너뛰는 까닭 (정지 해제로 이어 가는 교체 등 — S4b) */
  memoSkip?: string | null;
}

/** 메인 자리 (DB 한 줄, 4.1) */
export interface MainSeatRow {
  id: 'main';
  generation: number;
  /** 화면의 SeatState 가운데 stopped는 외부 보유자의 임대(7단계)에서 쓴다 */
  state: 'active' | 'switching' | 'vacant';
  /** 앉은 보유자 (vacant면 null). switching 동안은 나가는 보유자 */
  holder: SeatHolder | null;
  since: string | null;
  unresponsiveSince: string | null;
  unresponsiveReason: string | null;
  /**
   * 응답 없음으로 세는 메인 턴의 끝이 연달아 몇 번이었나 (4.4, 리드 결정 S4-5 — 시작 실패·사용량 한도·재로그인 필요, 끝 사유를 차례대로 3개까지). 정상으로
   * 끝나면 비운다. 4단계 S4c 전의 줄에는 없다(빈 것으로 본다)
   */
  unresponsiveStreak?: string[];
  /** 이 응답 없음에 대표에게 보낸 알림 수 (5분·30분·2시간 — 0~3). 응답하거나 교체되면 0 */
  unresponsiveNotices?: number;
  /** switching일 때 들어올 보유자 */
  pendingHolder: SeatHolder | null;
  vision: 'verified' | 'failed' | 'unknown';
  /** vision을 정한 모델 (리드 결정 S6-3·S6-10 — 확인 요청 ID 'screen-check:g<N>:<modelKey>'의 modelKey). 없으면 확인한 적 없음 */
  visionModel?: string | null;
  /** vision을 정한 때 */
  visionAt?: string | null;
  swap: SeatSwapRow | null;
  /** 외부 보유자의 임대 (7단계 S7b, 리드 결정 S7-2) — 없으면 없음. 서버가 시작할 때 비운다 */
  lease?: SeatLeaseRow | null;
}

/** 자리 이력 한 줄 (seat_history) — 바꾼 쪽에 대표는 없다 */
export interface SeatHistoryRow {
  /** 세대의 줄 ID (orchestrator/seat.ts seatGenerationId — 세대 1은 'G-0001') */
  id: string;
  generation: number;
  holder: SeatHolder;
  startedAt: string;
  endedAt: string | null;
  /** 이 세대를 연 까닭 (가린 글) */
  startReason: string;
  /** 끝난 까닭 (가린 글) */
  endReason: string | null;
  changedBy: SeatChanger;
  /** 이 세대의 인계 꾸러미 (seat_handover의 id) */
  handoverId: string | null;
}

/** 세대별 인계 꾸러미 (seat_handover, 6.2) — 저장 전에 가린다 (리드 결정 S4-6) */
export interface SeatHandoverRow {
  /** 세대의 줄 ID (seatGenerationId) */
  id: string;
  generation: number;
  createdAt: string;
  /** 꾸러미를 받는 보유자 */
  holder: SeatHolder;
  previous: SeatHolder | null;
  sections: HandoverSection[];
  chars: number;
  /** 넘기는 쪽이 남긴 말 (hand_off_seat의 note, 가린 글) — 세션 교체(MEM-09) 때 다시 만드는 최신판이 쓴다 (S4b) */
  note?: string | null;
}

/** 일지가 가리키는 대상 (지시·질문·보고·팀원·작업·프로젝트 ID) — 이름은 보일 때 지금 기록에서 붙인다 */
export interface JournalRefRow {
  kind: JournalRef['kind'];
  id: string;
}

/** 약속(promise)의 상태 — 닫은 쪽은 그 세대의 보유자 이름 */
export interface JournalPromiseRow {
  state: 'open' | 'closed';
  closedAt: string | null;
  resolution: string | null;
  closedGeneration: number | null;
  closedBy: string | null;
}

/** 30일 지난 서버 기록의 월별 묶음 (6.3) — 종류별 건수와 그달에 닫힌 약속 */
export interface JournalRollupRow {
  /** 'YYYY-MM' (UTC) */
  month: string;
  counts: Partial<Record<JournalKind, number>>;
  total: number;
  /** 그달에 닫힌 약속의 ID와 제목 (묶음을 다시 만들어도 한 번만) */
  closedPromises: { id: string; title: string }[];
}

/**
 * 메인 일지 한 줄 (main_journal, SERVER_DESIGN 6.1·리드 결정 S4-6) — 글은 저장 전에 가린 것(최대 1,000자). id는 순번에서 만든다('J-000001').
 * author server는 서버가 적은 사실, agent는 메인 에이전트가 journal_write로 적은 주장이다
 */
export interface JournalRow {
  id: string;
  seq: number;
  at: string;
  /** 쓴 때의 자리 세대 (에이전트 기록과 메인의 도구 호출은 그 턴의 세대) */
  generation: number;
  /** 그 세대의 보유자 이름 ('Claude CLI') */
  holder: string;
  author: 'server' | 'agent';
  kind: JournalKind;
  projectId: string | null;
  /** 쓴 업무 세션 키 (메인의 도구 호출·에이전트 기록) */
  workKey: string | null;
  /** 쓴 메인 턴 — 에이전트 기록의 턴당 상한을 이것으로 센다 */
  turnId: string | null;
  text: string;
  refs: JournalRefRow[];
  promise: JournalPromiseRow | null;
  rollup: JournalRollupRow | null;
}

/** 일지 찾기 조건 — 늘 때(at)·순번 차례. 기본은 새 것부터 */
export interface JournalQuery {
  /** 없으면 전체, null이면 프로젝트 없는 기록만 */
  projectId?: string | null;
  kinds?: readonly string[];
  author?: 'server' | 'agent';
  generation?: number;
  openPromisesOnly?: boolean;
  turnId?: string;
  /** 이 때보다 이른 것만 */
  before?: string;
  /** 다음 쪽: 이 줄(때·순번)보다 앞선 것만 */
  after?: { at: string; seq: number };
  limit?: number;
  asc?: boolean;
}

export interface JournalRepo {
  insert(row: Omit<JournalRow, 'id' | 'seq'>): JournalRow;
  get(id: string): JournalRow | null;
  /** 같은 순번의 줄을 바꾼다 (약속 닫기·월별 묶음 갱신) */
  put(row: JournalRow): void;
  query(q: JournalQuery): JournalRow[];
  count(q: JournalQuery): number;
  /** 그 순번들을 지운다 — 월별 묶음으로 줄인 서버 기록. 지운 수 */
  deleteSeqs(seqs: readonly number[]): number;
}

/** 일지 줄 ID ↔ 순번 */
export const journalId = (seq: number): string => `J-${String(seq).padStart(6, '0')}`;
const journalSeqOf = (id: string): number | null => {
  const m = /^J-(\d{1,15})$/.exec(id.trim());
  return m ? Number(m[1]) : null;
};

/** 화면 조작 기록이 남긴 캡처 한 장 (gui_actions.data.capture) — 파일 바이트는 두지 않는다. 좌표는 실제 픽셀 */
export interface GuiCaptureRecord {
  /** 'SC-000001' — 파일 이름(<메인 작업 폴더>/screens/<id>.png) */
  id: string;
  screen: number | 'all';
  /** 이미지 크기 (줄였을 수 있다) */
  width: number;
  height: number;
  /** 이미지 픽셀 하나가 실제 픽셀 몇 개인가 (실제 폭 ÷ 이미지 폭) */
  scale: number;
  originX: number;
  originY: number;
  realWidth: number;
  realHeight: number;
  /** 모니터 배치 해시 (입력 명령의 L) */
  layout: string;
  /** 파일 바이트의 SHA-256 — TS가 다시 해시한 값 */
  sha256: string;
  bytes: number;
  cause: 'capture' | 'after_input';
  /** 보유자에게 준 꼴 */
  image: 'attached' | 'text_only' | 'too_large';
  /** 그때 포커스 창의 프로그램 이름 (제목은 두지 않는다) */
  focusApp: string | null;
}

/**
 * 화면 조작 기록 한 줄 (gui_actions, 6판 — SERVER_DESIGN 8.3.5·리드 결정 S6-7). id는 순번에서 만든다('GA-000001'). 글(keys·text·focus·detail)은 저장 전에 가린
 * 것이고, 입력 글은 가려진 것이 없을 때만 그대로, 아니면 null과 길이만 둔다. 처리기에 닿은 모든 시도마다 한 줄 — 보낸 입력은 'sent'로 먼저 남기고 답을 받은 뒤 고친다
 */
export interface GuiActionRow {
  id: string;
  seq: number;
  at: string;
  generation: number;
  holderLabel: string;
  turnId: string | null;
  projectId: string | null;
  /** 메인의 도구 호출 · 서버(턴 끝의 놓기·정지) */
  by: 'main' | 'server';
  action: GuiAction;
  result: GuiResult;
  /** 저장용 요청 ID (safeRequestId) — 같은 세대에서 같은 값이면 다시 입력하지 않는다 (AC-45) */
  requestId: string | null;
  /** 도우미에게 입력 줄을 썼는지 — 썼으면 같은 요청을 다시 받지 않는다 (보냈는지 모르는 시간 초과 포함) */
  dispatched: boolean;
  x: number | null;
  y: number | null;
  x2: number | null;
  y2: number | null;
  button: 'left' | 'right' | 'middle' | null;
  count: number | null;
  amount: number | null;
  keys: string | null;
  text: string | null;
  textLength: number | null;
  focus: { app: string; title: string; password: boolean | null } | null;
  detail: string | null;
  beforeCaptureId: string | null;
  afterCaptureId: string | null;
  /** action 'capture'의 캡처 (거부된 캡처는 null) */
  capture: GuiCaptureRecord | null;
  updatedAt: string;
}

export type GuiActionInsert = Omit<GuiActionRow, 'id' | 'seq'>;

export interface GuiActionQuery {
  turnId?: string;
  actions?: readonly string[];
  results?: readonly string[];
  /** 이 순번보다 앞선 것만 (새 것부터 넘길 때) */
  beforeSeq?: number;
  limit?: number;
  asc?: boolean;
}

export interface GuiActionRepo {
  insert(row: GuiActionInsert): GuiActionRow;
  get(id: string): GuiActionRow | null;
  /** 같은 순번의 줄을 바꾼다 (보낸 입력의 결과·뒤 캡처) */
  put(row: GuiActionRow): void;
  /** 그 캡처를 남긴 줄 (action 'capture') */
  byCapture(captureId: string): GuiActionRow | null;
  /** 같은 세대·같은 요청 ID로 입력 줄을 쓴 줄 (가장 최근) */
  dispatchedRequest(generation: number, requestId: string): GuiActionRow | null;
  query(q: GuiActionQuery): GuiActionRow[];
  /** iso보다 오래된 줄을 지운다 — 지운 수 (활동 기록 보관 기간과 같이) */
  purgeOlderThan(iso: string): number;
}

/** 화면 조작 기록 줄 ID ↔ 순번 */
export const guiActionId = (seq: number): string => `GA-${String(seq).padStart(6, '0')}`;
const guiActionSeqOf = (id: string): number | null => {
  const m = /^GA-(\d{1,15})$/.exec(id.trim());
  return m ? Number(m[1]) : null;
};

/**
 * DocRepo.require가 찾지 못했을 때 던지는 오류 — 이름·글은 예전 그대로(`Error: <표>: '<ID>'을(를) 찾을 수 없습니다`). 대표 길(backend/ownerGate.ts)은
 * 이것을 not_found로 바꿔 답한다(리드 결정 S3-13 — 예전에는 500 internal). 다른 길은 예전처럼 일반 오류로 다룬다
 */
export class MissingRowError extends Error {
  constructor(
    readonly table: string,
    readonly id: string,
  ) {
    super(`${table}: '${id}'을(를) 찾을 수 없습니다`);
  }
}

/**
 * 스키마 판. 1: 처음 판. 2: 대표의 기기 세션 표 owner_sessions (S3-4). 3: 같은 요청 ID의 저장한 답 request_replies (S3-9). 4: 메인 자리 seat·자리 이력
 * seat_history·인계 꾸러미 seat_handover (4단계, 리드 결정 S4-2·S4-12) — 모든 표를 IF NOT EXISTS로 만들므로 앞 판 DB를 열면 새 표만 더해진다.
 * 자리 한 줄은 시작 때 SeatService.init이 채운다 (앞 판 DB면 운영 설정의 메인 AI로 1세대). 5: 메인 에이전트 일지 main_journal (4단계 S4b, 리드 결정 S4-6).
 * 6: 화면 조작 기록 gui_actions (6단계 S6b, 리드 결정 S6-7) — 데스크톱과 서버가 같은 DB를 쓰므로 데스크톱에도 빈 표가 생긴다.
 * 7: 외부 에이전트 external_agents (7단계 S7a, 리드 결정 S7-2) — 키는 해시만. 데스크톱에도 빈 표가 생긴다(데스크톱은 외부 에이전트를 앉히지 않는다)
 */
const SCHEMA_VERSION = 7;

const DOC_TABLES = [
  'projects',
  'members',
  'roles',
  'directives',
  'tasks',
  'reviews',
  'questions',
  'messages',
  'sessions',
  'turns',
  'queue',
  'reports',
  'report_comments',
  'notifications',
  'conversation',
  'execs',
  'seat',
  'seat_history',
  'seat_handover',
] as const;

function migrate(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  const row = db.prepare(`SELECT value FROM meta WHERE key='schema_version'`).get() as { value: string } | undefined;
  const ver = row ? Number(row.value) : 0;
  if (ver >= SCHEMA_VERSION) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const t of DOC_TABLES) {
      db.exec(`CREATE TABLE IF NOT EXISTS ${t} (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        state TEXT,
        ref1 TEXT,
        ref2 TEXT,
        seq INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        data TEXT NOT NULL
      )`);
      db.exec(`CREATE INDEX IF NOT EXISTS ${t}_project ON ${t}(project_id)`);
      db.exec(`CREATE INDEX IF NOT EXISTS ${t}_state ON ${t}(state)`);
      db.exec(`CREATE INDEX IF NOT EXISTS ${t}_ref1 ON ${t}(ref1)`);
      db.exec(`CREATE INDEX IF NOT EXISTS ${t}_ref2 ON ${t}(ref2)`);
    }
    db.exec(`CREATE TABLE IF NOT EXISTS steps (task_id TEXT NOT NULL, idx INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (task_id, idx))`);
    db.exec(`CREATE TABLE IF NOT EXISTS transitions (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, entity TEXT NOT NULL, entity_id TEXT NOT NULL, data TEXT NOT NULL)`);
    db.exec(`CREATE INDEX IF NOT EXISTS transitions_entity ON transitions(entity_id)`);
    db.exec(`CREATE TABLE IF NOT EXISTS activity (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL, actor TEXT NOT NULL, project_id TEXT, directive_id TEXT, task_id TEXT, member_id TEXT,
      session_id TEXT, turn_id TEXT, request_id TEXT, kind TEXT NOT NULL, level TEXT NOT NULL, text TEXT NOT NULL, result TEXT)`);
    db.exec(`CREATE INDEX IF NOT EXISTS activity_ts ON activity(ts)`);
    db.exec(`CREATE INDEX IF NOT EXISTS activity_project ON activity(project_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS activity_member ON activity(member_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS activity_task ON activity(task_id)`);
    db.exec(`CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    db.exec(`CREATE TABLE IF NOT EXISTS counters (kind TEXT PRIMARY KEY, n INTEGER NOT NULL)`);
    // 2판: 대표의 기기 세션 (S3-4). 토큰 해시만 — 원문은 두지 않는다
    db.exec(`CREATE TABLE IF NOT EXISTS owner_sessions (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      device_name TEXT NOT NULL,
      tailscale_login TEXT,
      owner_sub TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_used_at TEXT NOT NULL,
      idle_expires_at TEXT NOT NULL,
      absolute_expires_at TEXT NOT NULL,
      revoked_at TEXT,
      revoked_by TEXT)`);
    // 3판: 같은 요청 ID의 저장한 답 (S3-9). 인자는 지문만
    db.exec(`CREATE TABLE IF NOT EXISTS request_replies (
      session_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      method TEXT NOT NULL,
      args_digest TEXT NOT NULL,
      outcome TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (session_id, request_id))`);
    db.exec(`CREATE INDEX IF NOT EXISTS request_replies_created ON request_replies(created_at)`);
    // 4판: 도구 중복 캐시는 7일 보관한다 (S4-4) — 앞 판에 남은 값에는 때가 없어, 옮기는 지금을 때로 적어 보관 기간을 지금부터 센다. 4판 뒤의 값에는 늘 때가 있다
    if (ver < 4) {
      db.prepare(
        `UPDATE kv SET value = json_set(value, '$.at', ?) WHERE substr(key, 1, 8) = 'toolreq:' AND json_type(value) = 'object' AND json_extract(value, '$.at') IS NULL`,
      ).run(new Date().toISOString());
    }
    // 5판: 메인 에이전트 일지 (S4-6). 순번이 줄 ID다. 찾기는 때·순번 차례 — 월별 묶음은 그달의 마지막 때에 놓인다
    db.exec(`CREATE TABLE IF NOT EXISTS main_journal (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      generation INTEGER NOT NULL,
      author TEXT NOT NULL,
      kind TEXT NOT NULL,
      project_id TEXT,
      turn_id TEXT,
      state TEXT,
      data TEXT NOT NULL)`);
    db.exec(`CREATE INDEX IF NOT EXISTS main_journal_at ON main_journal(at, seq)`);
    db.exec(`CREATE INDEX IF NOT EXISTS main_journal_kind ON main_journal(kind, state)`);
    db.exec(`CREATE INDEX IF NOT EXISTS main_journal_turn ON main_journal(turn_id)`);
    // 6판: 화면 조작 기록 (S6-7). 이미지 바이트는 두지 않는다 — 캡처 ID와 sha256만. 순번이 줄 ID다
    db.exec(`CREATE TABLE IF NOT EXISTS gui_actions (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      generation INTEGER NOT NULL,
      turn_id TEXT,
      action TEXT NOT NULL,
      result TEXT NOT NULL,
      capture_id TEXT,
      request_id TEXT,
      data TEXT NOT NULL)`);
    db.exec(`CREATE INDEX IF NOT EXISTS gui_actions_at ON gui_actions(at, seq)`);
    db.exec(`CREATE INDEX IF NOT EXISTS gui_actions_turn ON gui_actions(turn_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS gui_actions_capture ON gui_actions(capture_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS gui_actions_request ON gui_actions(generation, request_id)`);
    // 7판: 외부 에이전트 (S7-2). 키 원문은 두지 않는다 — sha256만(겹치지 않는다). 폐기하지 않은 에이전트끼리는 이름이 겹치지 않는다(등록 기록이 대소문자까지
    // 보고, 이 색인은 같은 글자를 한 번 더 막는다)
    db.exec(`CREATE TABLE IF NOT EXISTS external_agents (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      key_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      revoked_at TEXT,
      revoked_by TEXT,
      last_seen_at TEXT)`);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS external_agents_live_label ON external_agents(label) WHERE revoked_at IS NULL`);
    db.prepare(`INSERT INTO meta(key, value) VALUES('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(
      String(SCHEMA_VERSION),
    );
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** 메인 일지 표 (5판). 줄 내용은 data(JSON)에 두고 찾는 데 쓰는 칸만 따로 둔다 */
function makeJournalRepo(db: DatabaseSync): JournalRepo {
  const rowOf = (r: { seq: number; data: string }): JournalRow => ({ ...(JSON.parse(r.data) as Omit<JournalRow, 'id' | 'seq'>), id: journalId(Number(r.seq)), seq: Number(r.seq) });
  const dataOf = (row: Omit<JournalRow, 'id' | 'seq'>): string => {
    const copy: Partial<JournalRow> = { ...row };
    delete copy.id;
    delete copy.seq;
    return JSON.stringify(copy);
  };
  const where = (q: JournalQuery): { sql: string; args: (string | number)[] } => {
    const parts: string[] = [];
    const args: (string | number)[] = [];
    if (q.projectId !== undefined) {
      if (q.projectId === null) parts.push('project_id IS NULL');
      else {
        parts.push('project_id = ?');
        args.push(q.projectId);
      }
    }
    if (q.kinds?.length) {
      parts.push(`kind IN (${q.kinds.map(() => '?').join(',')})`);
      args.push(...q.kinds);
    }
    if (q.author) {
      parts.push('author = ?');
      args.push(q.author);
    }
    if (q.generation !== undefined) {
      parts.push('generation = ?');
      args.push(q.generation);
    }
    if (q.openPromisesOnly) parts.push(`kind = 'promise' AND state = 'open'`);
    if (q.turnId) {
      parts.push('turn_id = ?');
      args.push(q.turnId);
    }
    if (q.before) {
      parts.push('at < ?');
      args.push(q.before);
    }
    if (q.after) {
      parts.push(q.asc ? '(at > ? OR (at = ? AND seq > ?))' : '(at < ? OR (at = ? AND seq < ?))');
      args.push(q.after.at, q.after.at, q.after.seq);
    }
    return { sql: parts.length ? `WHERE ${parts.join(' AND ')}` : '', args };
  };
  return {
    insert(row) {
      const r = db
        .prepare(`INSERT INTO main_journal(at, generation, author, kind, project_id, turn_id, state, data) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(row.at, row.generation, row.author, row.kind, row.projectId, row.turnId, row.promise?.state ?? null, dataOf(row));
      const seq = Number(r.lastInsertRowid);
      return { ...row, id: journalId(seq), seq };
    },
    get(id) {
      const seq = journalSeqOf(id);
      if (seq === null) return null;
      const r = db.prepare(`SELECT seq, data FROM main_journal WHERE seq = ?`).get(seq) as { seq: number; data: string } | undefined;
      return r ? rowOf(r) : null;
    },
    put(row) {
      db.prepare(`UPDATE main_journal SET at = ?, generation = ?, author = ?, kind = ?, project_id = ?, turn_id = ?, state = ?, data = ? WHERE seq = ?`).run(
        row.at,
        row.generation,
        row.author,
        row.kind,
        row.projectId,
        row.turnId,
        row.promise?.state ?? null,
        dataOf(row),
        row.seq,
      );
    },
    query(q) {
      const w = where(q);
      const dir = q.asc ? 'ASC' : 'DESC';
      const lim = q.limit ? ` LIMIT ${Math.max(1, Math.floor(q.limit))}` : '';
      const rows = db.prepare(`SELECT seq, data FROM main_journal ${w.sql} ORDER BY at ${dir}, seq ${dir}${lim}`).all(...w.args) as { seq: number; data: string }[];
      return rows.map(rowOf);
    },
    count(q) {
      const w = where(q);
      return Number((db.prepare(`SELECT COUNT(*) AS c FROM main_journal ${w.sql}`).get(...w.args) as { c: number }).c);
    },
    deleteSeqs(seqs) {
      let n = 0;
      const del = db.prepare(`DELETE FROM main_journal WHERE seq = ?`);
      for (const s of seqs) n += Number(del.run(s).changes);
      return n;
    },
  };
}

/** 화면 조작 기록 표 (6판). 줄 내용은 data(JSON)에 두고 찾는 데 쓰는 칸만 따로 둔다 */
function makeGuiActionRepo(db: DatabaseSync): GuiActionRepo {
  const rowOf = (r: { seq: number; data: string }): GuiActionRow => ({ ...(JSON.parse(r.data) as GuiActionInsert), id: guiActionId(Number(r.seq)), seq: Number(r.seq) });
  const dataOf = (row: GuiActionInsert | GuiActionRow): string => {
    const copy: Partial<GuiActionRow> = { ...row };
    delete copy.id;
    delete copy.seq;
    return JSON.stringify(copy);
  };
  const cols = (row: GuiActionInsert): (string | number | null)[] => [row.at, row.generation, row.turnId, row.action, row.result, row.capture?.id ?? null, row.requestId, dataOf(row)];
  return {
    insert(row) {
      const r = db.prepare(`INSERT INTO gui_actions(at, generation, turn_id, action, result, capture_id, request_id, data) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`).run(...cols(row));
      const seq = Number(r.lastInsertRowid);
      return { ...row, id: guiActionId(seq), seq };
    },
    get(id) {
      const seq = guiActionSeqOf(id);
      if (seq === null) return null;
      const r = db.prepare(`SELECT seq, data FROM gui_actions WHERE seq = ?`).get(seq) as { seq: number; data: string } | undefined;
      return r ? rowOf(r) : null;
    },
    put(row) {
      db.prepare(`UPDATE gui_actions SET at = ?, generation = ?, turn_id = ?, action = ?, result = ?, capture_id = ?, request_id = ?, data = ? WHERE seq = ?`).run(...cols(row), row.seq);
    },
    byCapture(captureId) {
      const r = db.prepare(`SELECT seq, data FROM gui_actions WHERE capture_id = ? AND action = 'capture' ORDER BY seq DESC LIMIT 1`).get(captureId) as { seq: number; data: string } | undefined;
      return r ? rowOf(r) : null;
    },
    dispatchedRequest(generation, requestId) {
      const rows = db.prepare(`SELECT seq, data FROM gui_actions WHERE generation = ? AND request_id = ? ORDER BY seq DESC`).all(generation, requestId) as { seq: number; data: string }[];
      for (const r of rows) {
        const row = rowOf(r);
        if (row.dispatched) return row;
      }
      return null;
    },
    query(q) {
      const parts: string[] = [];
      const args: (string | number)[] = [];
      if (q.turnId) {
        parts.push('turn_id = ?');
        args.push(q.turnId);
      }
      if (q.actions?.length) {
        parts.push(`action IN (${q.actions.map(() => '?').join(',')})`);
        args.push(...q.actions);
      }
      if (q.results?.length) {
        parts.push(`result IN (${q.results.map(() => '?').join(',')})`);
        args.push(...q.results);
      }
      if (q.beforeSeq !== undefined) {
        parts.push('seq < ?');
        args.push(q.beforeSeq);
      }
      const where = parts.length ? `WHERE ${parts.join(' AND ')}` : '';
      const dir = q.asc ? 'ASC' : 'DESC';
      const lim = q.limit ? ` LIMIT ${Math.max(1, Math.floor(q.limit))}` : '';
      const rows = db.prepare(`SELECT seq, data FROM gui_actions ${where} ORDER BY seq ${dir}${lim}`).all(...args) as { seq: number; data: string }[];
      return rows.map(rowOf);
    },
    purgeOlderThan(iso) {
      return Number(db.prepare(`DELETE FROM gui_actions WHERE at < ?`).run(iso).changes);
    },
  };
}

const ownerSessionOf = (r: Record<string, unknown>): OwnerSessionRow => ({
  id: String(r.id),
  tokenHash: String(r.token_hash),
  deviceName: String(r.device_name),
  tailscaleLogin: (r.tailscale_login as string | null) ?? null,
  ownerSub: String(r.owner_sub),
  createdAt: String(r.created_at),
  lastUsedAt: String(r.last_used_at),
  idleExpiresAt: String(r.idle_expires_at),
  absoluteExpiresAt: String(r.absolute_expires_at),
  revokedAt: (r.revoked_at as string | null) ?? null,
  revokedBy: (r.revoked_by as string | null) ?? null,
});

const externalAgentOf = (r: Record<string, unknown>): ExternalAgentRow => ({
  id: String(r.id),
  label: String(r.label),
  keyHash: String(r.key_hash),
  createdAt: String(r.created_at),
  revokedAt: (r.revoked_at as string | null) ?? null,
  revokedBy: r.revoked_by === 'operator' ? 'operator' : null,
  lastSeenAt: (r.last_seen_at as string | null) ?? null,
});

/** 외부 에이전트 표 (7판) */
function makeExternalAgentRepo(db: DatabaseSync): ExternalAgentRepo {
  return {
    insert(r) {
      db.prepare(`INSERT INTO external_agents(id, label, key_hash, created_at, revoked_at, revoked_by, last_seen_at) VALUES(?, ?, ?, ?, ?, ?, ?)`).run(
        r.id,
        r.label,
        r.keyHash,
        r.createdAt,
        r.revokedAt,
        r.revokedBy,
        r.lastSeenAt,
      );
    },
    get(id) {
      const r = db.prepare(`SELECT * FROM external_agents WHERE id=?`).get(id) as Record<string, unknown> | undefined;
      return r ? externalAgentOf(r) : null;
    },
    byKeyHash(hash) {
      const r = db.prepare(`SELECT * FROM external_agents WHERE key_hash=?`).get(hash) as Record<string, unknown> | undefined;
      return r ? externalAgentOf(r) : null;
    },
    list() {
      return (db.prepare(`SELECT * FROM external_agents ORDER BY id`).all() as Record<string, unknown>[]).map(externalAgentOf);
    },
    revoke(id, revokedAt, revokedBy) {
      return Number(db.prepare(`UPDATE external_agents SET revoked_at=?, revoked_by=? WHERE id=? AND revoked_at IS NULL`).run(revokedAt, revokedBy, id).changes) > 0;
    },
    touch(id, lastSeenAt) {
      db.prepare(`UPDATE external_agents SET last_seen_at=? WHERE id=? AND revoked_at IS NULL`).run(lastSeenAt, id);
    },
  };
}

export function openStore(path: string): Store {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = FULL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);

  let depth = 0;
  const tx = <T>(fn: () => T): T => {
    if (depth > 0) return fn();
    // 앞선 실패로 열린 채 남은 트랜잭션(롤백까지 실패)은 정리하고 시작한다 — 남겨 두면 BEGIN이 계속 실패한다
    if (db.isTransaction) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // 이미 닫혔으면 그대로 진행
      }
    }
    db.exec('BEGIN IMMEDIATE'); // 실패하면 depth가 바뀌지 않는다
    depth++;
    try {
      const r = fn();
      db.exec('COMMIT');
      return r;
    } catch (e) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // SQLite가 이미 자동 롤백했으면(COMMIT 중 디스크 부족 등) 실패한다 — 원래 오류를 던진다
      }
      throw e;
    } finally {
      // 감소는 한 곳에서만: COMMIT이 실패해도 두 번 줄지 않는다 (CONC-10 — 음수가 되면 이후 중첩 트랜잭션이 모두 실패)
      depth--;
    }
  };

  let seqCounter = Number(
    (db.prepare(`SELECT COALESCE(MAX(n), 0) AS n FROM counters WHERE kind='__seq'`).get() as { n: number } | undefined)?.n ?? 0,
  );
  const nextSeq = (): number => {
    seqCounter += 1;
    db.prepare(`INSERT INTO counters(kind, n) VALUES('__seq', ?) ON CONFLICT(kind) DO UPDATE SET n=excluded.n`).run(seqCounter);
    return seqCounter;
  };

  const nextId = (kind: IdKind): string =>
    tx(() => {
      const cur = db.prepare(`SELECT n FROM counters WHERE kind=?`).get(kind) as { n: number } | undefined;
      const n = (cur?.n ?? 0) + 1;
      db.prepare(`INSERT INTO counters(kind, n) VALUES(?, ?) ON CONFLICT(kind) DO UPDATE SET n=excluded.n`).run(kind, n);
      return formatId(kind, n);
    });

  function makeRepo<T extends object>(table: (typeof DOC_TABLES)[number], idOf: (r: T) => string, index: Indexer<T>): DocRepo<T> {
    const getStmt = db.prepare(`SELECT data FROM ${table} WHERE id = ?`);
    const insStmt = db.prepare(
      `INSERT INTO ${table}(id, project_id, state, ref1, ref2, seq, updated_at, data) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const updStmt = db.prepare(`UPDATE ${table} SET project_id=?, state=?, ref1=?, ref2=?, updated_at=?, data=? WHERE id=?`);
    const delStmt = db.prepare(`DELETE FROM ${table} WHERE id=?`);
    const now = () => new Date().toISOString();

    const where = (f?: DocFilter): { sql: string; args: (string | null)[] } => {
      const parts: string[] = [];
      const args: (string | null)[] = [];
      if (f) {
        if (f.project_id !== undefined) {
          if (f.project_id === null) parts.push('project_id IS NULL');
          else {
            parts.push('project_id = ?');
            args.push(f.project_id);
          }
        }
        if (f.state !== undefined) {
          const states = Array.isArray(f.state) ? f.state : [f.state];
          if (states.length === 0) parts.push('0');
          else {
            parts.push(`state IN (${states.map(() => '?').join(',')})`);
            args.push(...states);
          }
        }
        if (f.ref1 !== undefined) {
          parts.push('ref1 = ?');
          args.push(f.ref1);
        }
        if (f.ref2 !== undefined) {
          parts.push('ref2 = ?');
          args.push(f.ref2);
        }
      }
      return { sql: parts.length ? `WHERE ${parts.join(' AND ')}` : '', args };
    };

    const repo: DocRepo<T> = {
      get(id) {
        const r = getStmt.get(id) as { data: string } | undefined;
        return r ? (JSON.parse(r.data) as T) : null;
      },
      require(id) {
        const r = repo.get(id);
        if (!r) throw new MissingRowError(table, id);
        return r;
      },
      insert(row) {
        const ix = index(row);
        insStmt.run(idOf(row), ix.project_id ?? null, ix.state ?? null, ix.ref1 ?? null, ix.ref2 ?? null, nextSeq(), now(), JSON.stringify(row));
        return row;
      },
      put(row) {
        const ix = index(row);
        const res = updStmt.run(ix.project_id ?? null, ix.state ?? null, ix.ref1 ?? null, ix.ref2 ?? null, now(), JSON.stringify(row), idOf(row));
        if (Number(res.changes) === 0) repo.insert(row);
        return row;
      },
      patch(id, patch) {
        const cur = repo.require(id);
        const next = { ...cur, ...patch } as T;
        repo.put(next);
        return next;
      },
      list(filter, opts) {
        const w = where(filter);
        const order = opts?.orderBy === 'id' ? 'id' : 'seq';
        const lim = opts?.limit ? ` LIMIT ${Math.max(1, Math.floor(opts.limit))}` : '';
        const rows = db.prepare(`SELECT data FROM ${table} ${w.sql} ORDER BY ${order} ${opts?.desc ? 'DESC' : 'ASC'}${lim}`).all(...w.args) as {
          data: string;
        }[];
        return rows.map((r) => JSON.parse(r.data) as T);
      },
      count(filter) {
        const w = where(filter);
        const r = db.prepare(`SELECT COUNT(*) AS c FROM ${table} ${w.sql}`).get(...w.args) as { c: number };
        return Number(r.c);
      },
      delete(id) {
        delStmt.run(id);
      },
    };
    return repo;
  }

  const byId = (r: { id: string }) => r.id;

  const store: Store = {
    db,
    path,
    tx,
    nextId,
    projects: makeRepo<Project>('projects', byId, (p) => ({ state: p.archivedAt ? 'archived' : 'active' })),
    members: makeRepo<Member>('members', byId, (m) => ({
      project_id: m.projectId,
      state: m.deletedAt ? 'deleted' : 'active',
      ref1: m.roleId,
    })),
    roles: makeRepo<Role>('roles', byId, () => ({})),
    directives: makeRepo<Directive>('directives', byId, (d) => ({ project_id: d.projectId, state: d.state })),
    tasks: makeRepo<Task>('tasks', byId, (t) => ({ project_id: t.projectId, state: t.state, ref1: t.directiveId, ref2: t.assigneeId })),
    steps: {
      list(taskId) {
        const rows = db.prepare(`SELECT data FROM steps WHERE task_id=? ORDER BY idx`).all(taskId) as { data: string }[];
        return rows.map((r) => JSON.parse(r.data) as Step);
      },
      put(step) {
        db.prepare(`INSERT INTO steps(task_id, idx, data) VALUES(?, ?, ?) ON CONFLICT(task_id, idx) DO UPDATE SET data=excluded.data`).run(
          step.taskId,
          step.idx,
          JSON.stringify(step),
        );
      },
      replaceAll(taskId, steps) {
        tx(() => {
          db.prepare(`DELETE FROM steps WHERE task_id=?`).run(taskId);
          const ins = db.prepare(`INSERT INTO steps(task_id, idx, data) VALUES(?, ?, ?)`);
          for (const s of steps) ins.run(taskId, s.idx, JSON.stringify(s));
        });
      },
    },
    reviews: makeRepo<ReviewRecord>('reviews', byId, (r) => ({ ref1: r.taskId, state: r.verdict })),
    questions: makeRepo<Question>('questions', byId, (q) => ({ project_id: q.projectId, state: q.status, ref1: q.taskId, ref2: q.fromId })),
    messages: makeRepo<AgentMessage>('messages', byId, (m) => ({ state: m.deliveredAt ? 'delivered' : m.undeliveredAt ? 'undelivered' : 'pending', ref1: m.toMemberId })),
    sessions: makeRepo<AgentSession>('sessions', byId, (s) => ({
      project_id: s.projectId,
      state: s.closedAt ? 'closed' : 'open',
      ref1: s.memberId,
      ref2: s.workKey,
    })),
    turns: makeRepo<Turn>('turns', byId, (t) => ({
      project_id: t.projectId,
      state: t.endedAt ? 'ended' : 'running',
      ref1: t.memberId,
      ref2: t.sessionId,
    })),
    queue: makeRepo<QueueEntry>('queue', byId, (q) => ({ project_id: q.projectId, state: q.state, ref1: q.memberId, ref2: q.sessionKey })),
    reports: makeRepo<Report>('reports', byId, (r) => ({ project_id: r.projectId, state: r.status, ref1: r.directiveId })),
    reportComments: makeRepo<ReportComment>('report_comments', byId, (c) => ({ ref1: c.reportId })),
    notifications: makeRepo<AppNotification>('notifications', byId, (n) => ({ state: n.readAt ? 'read' : 'unread', ref1: n.key })),
    conversation: makeRepo<ConversationMessage>('conversation', byId, (c) => ({ ref1: c.target })),
    execs: makeRepo<ExecRecord>('execs', (e) => e.requestId, (e) => ({ project_id: e.projectId, state: e.state, ref1: e.taskId, ref2: e.kind })),
    seat: makeRepo<MainSeatRow>('seat', byId, (s) => ({ state: s.state })),
    seatHistory: makeRepo<SeatHistoryRow>('seat_history', byId, (h) => ({ state: h.endedAt ? 'closed' : 'open', ref1: String(h.generation), ref2: h.changedBy })),
    seatHandovers: makeRepo<SeatHandoverRow>('seat_handover', byId, (p) => ({ ref1: String(p.generation) })),
    journal: makeJournalRepo(db),
    guiActions: makeGuiActionRepo(db),
    externalAgents: makeExternalAgentRepo(db),
    transitions: {
      append(t) {
        const r = db.prepare(`INSERT INTO transitions(entity, entity_id, data) VALUES(?, ?, ?)`).run(t.entity, t.entityId, JSON.stringify(t));
        return { ...t, seq: Number(r.lastInsertRowid) };
      },
      list(entityId) {
        const rows = db.prepare(`SELECT seq, data FROM transitions WHERE entity_id=? ORDER BY seq`).all(entityId) as { seq: number; data: string }[];
        return rows.map((r) => ({ ...(JSON.parse(r.data) as Omit<TransitionRecord, 'seq'>), seq: Number(r.seq) }));
      },
    },
    activity: {
      append(e) {
        const r = db
          .prepare(
            `INSERT INTO activity(ts, actor, project_id, directive_id, task_id, member_id, session_id, turn_id, request_id, kind, level, text, result)
             VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(e.ts, e.actor, e.projectId, e.directiveId, e.taskId, e.memberId, e.sessionId, e.turnId, e.requestId, e.kind, e.level, e.text, e.result);
        return { ...e, seq: Number(r.lastInsertRowid) };
      },
      search(f) {
        const parts: string[] = [];
        const args: (string | number | null)[] = [];
        if (f.text) {
          parts.push('(text LIKE ? OR result LIKE ? OR request_id = ?)');
          args.push(`%${f.text}%`, `%${f.text}%`, f.text);
        }
        if (f.projectId !== undefined && f.projectId !== null) {
          parts.push('project_id = ?');
          args.push(f.projectId);
        }
        if (f.memberId) {
          parts.push('member_id = ?');
          args.push(f.memberId);
        }
        if (f.taskId) {
          parts.push('task_id = ?');
          args.push(f.taskId);
        }
        if (f.turnId) {
          parts.push('turn_id = ?');
          args.push(f.turnId);
        }
        if (f.kinds?.length) {
          parts.push(`kind IN (${f.kinds.map(() => '?').join(',')})`);
          args.push(...f.kinds);
        }
        if (f.level) {
          parts.push('level = ?');
          args.push(f.level);
        }
        if (f.from) {
          parts.push('ts >= ?');
          args.push(f.from);
        }
        if (f.to) {
          parts.push('ts <= ?');
          args.push(f.to);
        }
        if (f.beforeSeq) {
          parts.push('seq < ?');
          args.push(f.beforeSeq);
        }
        const limit = Math.min(Math.max(f.limit ?? 200, 1), 5000);
        const sql = `SELECT * FROM activity ${parts.length ? 'WHERE ' + parts.join(' AND ') : ''} ORDER BY seq DESC LIMIT ${limit}`;
        const rows = db.prepare(sql).all(...args) as Record<string, unknown>[];
        return rows.map((r) => ({
          seq: Number(r.seq),
          ts: String(r.ts),
          actor: String(r.actor),
          projectId: (r.project_id as string | null) ?? null,
          directiveId: (r.directive_id as string | null) ?? null,
          taskId: (r.task_id as string | null) ?? null,
          memberId: (r.member_id as string | null) ?? null,
          sessionId: (r.session_id as string | null) ?? null,
          turnId: (r.turn_id as string | null) ?? null,
          requestId: (r.request_id as string | null) ?? null,
          kind: r.kind as ActivityEntry['kind'],
          level: r.level as ActivityEntry['level'],
          text: String(r.text),
          result: (r.result as string | null) ?? null,
        }));
      },
      purgeOlderThan(iso) {
        const r = db.prepare(`DELETE FROM activity WHERE ts < ?`).run(iso);
        return Number(r.changes);
      },
    },
    kv: {
      get<T>(key: string): T | null {
        const r = db.prepare(`SELECT value FROM kv WHERE key=?`).get(key) as { value: string } | undefined;
        return r ? (JSON.parse(r.value) as T) : null;
      },
      set<T>(key: string, value: T): void {
        db.prepare(`INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, JSON.stringify(value));
      },
      purgeStamped(prefix: string, before: string): number {
        const r = db.prepare(`DELETE FROM kv WHERE substr(key, 1, ?) = ? AND json_type(value) = 'object' AND json_extract(value, '$.at') < ?`).run(prefix.length, prefix, before);
        return Number(r.changes);
      },
    },
    ownerSessions: {
      insert(r) {
        db.prepare(
          `INSERT INTO owner_sessions(id, token_hash, device_name, tailscale_login, owner_sub, created_at, last_used_at, idle_expires_at, absolute_expires_at, revoked_at, revoked_by)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(r.id, r.tokenHash, r.deviceName, r.tailscaleLogin, r.ownerSub, r.createdAt, r.lastUsedAt, r.idleExpiresAt, r.absoluteExpiresAt, r.revokedAt, r.revokedBy);
      },
      get(id) {
        const r = db.prepare(`SELECT * FROM owner_sessions WHERE id=?`).get(id) as Record<string, unknown> | undefined;
        return r ? ownerSessionOf(r) : null;
      },
      byTokenHash(hash) {
        const r = db.prepare(`SELECT * FROM owner_sessions WHERE token_hash=?`).get(hash) as Record<string, unknown> | undefined;
        return r ? ownerSessionOf(r) : null;
      },
      listActive() {
        const rows = db.prepare(`SELECT * FROM owner_sessions WHERE revoked_at IS NULL ORDER BY created_at, id`).all() as Record<string, unknown>[];
        return rows.map(ownerSessionOf);
      },
      touch(id, lastUsedAt, idleExpiresAt) {
        db.prepare(`UPDATE owner_sessions SET last_used_at=?, idle_expires_at=? WHERE id=? AND revoked_at IS NULL`).run(lastUsedAt, idleExpiresAt, id);
      },
      revoke(id, revokedAt, revokedBy) {
        const r = db.prepare(`UPDATE owner_sessions SET revoked_at=?, revoked_by=? WHERE id=? AND revoked_at IS NULL`).run(revokedAt, revokedBy, id);
        return Number(r.changes) > 0;
      },
    },
    requestReplies: {
      get(sessionId, requestId, notBefore) {
        const r = db.prepare(`SELECT * FROM request_replies WHERE session_id=? AND request_id=? AND created_at>=?`).get(sessionId, requestId, notBefore) as
          | Record<string, unknown>
          | undefined;
        if (!r) return null;
        return {
          sessionId: String(r.session_id),
          requestId: String(r.request_id),
          method: String(r.method),
          argsDigest: String(r.args_digest),
          outcome: JSON.parse(String(r.outcome)) as RequestReplyRow['outcome'],
          createdAt: String(r.created_at),
        };
      },
      insert(r) {
        db.prepare(`INSERT OR IGNORE INTO request_replies(session_id, request_id, method, args_digest, outcome, created_at) VALUES(?, ?, ?, ?, ?, ?)`).run(
          r.sessionId,
          r.requestId,
          r.method,
          r.argsDigest,
          JSON.stringify(r.outcome),
          r.createdAt,
        );
      },
      purgeOlderThan(iso) {
        return Number(db.prepare(`DELETE FROM request_replies WHERE created_at<?`).run(iso).changes);
      },
    },
    backupTo(file: string) {
      mkdirSync(dirname(file), { recursive: true });
      db.prepare(`VACUUM INTO ?`).run(file);
    },
    close() {
      db.close();
    },
  };
  return store;
}
