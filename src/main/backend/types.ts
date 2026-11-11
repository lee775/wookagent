/**
 * Electron 껍데기(main/index.ts, shell/*)·서버(src/server, SERVER_DESIGN 3.2) ↔ 백엔드(오케스트레이터) 경계.
 * 껍데기는 창·트레이·전역 단축키·절전 방지·OS 알림·IPC 연결만 맡고, 업무 로직은 모두 Backend가 한다.
 */
import type { AppSnapshot, DeviceSessionView, EmergencySummary, ExternalAgentView, PrereqStatus, SeatHistoryEntry, SeatView, TrayStatus } from '@shared/views';
import type { WookMethod, WookParams, WookResult, WookTopic, WookTopics } from '@shared/ipc';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ClaimReply, FinishReply, HeartbeatReply, SeatReply, WorkItem } from '../../server/agentApiTypes';
import type { ToolCallResult } from '../mcp/types';
import type { InstanceIdentity } from './instanceLock';
import type { DeviceSessionStore } from '../auth/deviceSessions';
import type { ServerFiles } from '../orchestrator/serverFiles';

/**
 * 원격 호출자 (서버 HTTP, 리드 결정 S3-3): HTTP 층이 쿠키나 Bearer 토큰을 확인한 뒤 만든다. 로그인 확인은 '이 호출자가 지금 등록된 대표의
 * 살아 있는 기기 세션을 가졌는가'이고, 대표 게이트는 원격 길('remote')로 돈다. 데스크톱 화면은 호출자를 넘기지 않는다 — 예전 길 그대로다
 */
export interface RemoteCaller {
  surface: 'remote';
  /** 확인한 기기 세션 (로그인 전이면 null) */
  session: DeviceSessionView | null;
  /** 이 호출자를 가리키는 열쇠 — 횟수 제한·로그인 묶기에 쓴다 (세션이 있으면 그 세션, 없으면 src/server/sessions.ts clientKeyOf) */
  clientKey: string;
  /**
   * 요청이 실은 로그인 전 쿠키(`__Host-wos_login`) 값마다의 열쇠 (리드 결정 S3-38, sessions.ts loginKeysOf) — 같은 이름이 여럿 와도 결과 묻기는 그 가운데
   * 어느 값으로 시작한 로그인이든 찾고, 새 시작은 그 값들로 시작한 기다림을 대신한다. 없으면 clientKey 하나만 본다. 기기 세션이 있는 호출자는 쓰지
   * 않는다 — 세션 열쇠로 묶는다
   */
  loginKeys?: readonly string[];
  /** `tailscale serve`가 붙인 Tailscale 사용자 (없으면 null) — 인증이 아니라 표시·추가 방어용 (3.6) */
  tailscaleLogin?: string | null;
  /**
   * 요청 ID (HTTP 본문의 id를 글로 바꾼 것, S3-9) — 기기 세션이 있는 호출자의 상태를 바꾸는 요청(requestReplies.ts REPLAY_METHODS)은 같은 ID를 한 번만
   * 처리하고 저장한 답을 준다. 없으면 늘 처리한다
   */
  requestId?: string;
  /**
   * 새 기기 세션을 이 요청의 응답에 싣는다 (HTTP 층이 채운다 — 세션 쿠키). 대표 확인을 마친 로그인 처리가 deviceSessions.issue 뒤에 부른다
   * (S3-5: 기기 코드 로그인의 'ok' 응답). 토큰은 응답 본문에 넣지 않는다
   */
  grantSession?(grant: { token: string; absoluteExpiresAt: string }): void;
  /**
   * 기기 코드 로그인을 이 브라우저에 묶는 새 열쇠 (S3-5): HTTP 층이 로그인 전 쿠키 `__Host-wos_login`(10분)을 이 응답에 싣고 그 열쇠(clientKeyOf와 같은 모양)를
   * 돌려준다. 결과 묻기(auth.deviceLoginPoll)는 그 쿠키를 실은 호출자만 찾는다. 기기 세션이 있는 호출자는 쓰지 않는다 — 세션 열쇠로 묶는다
   */
  newLoginKey?(): string;
  /**
   * 브라우저 로그인을 받지 않는 까닭 (리드 결정 S3-31) — HTTP 층이 공개 주소 밖의 Host(루프백 127.0.0.1·localhost·[::1])로 온 요청에 싣는다. 쿠키는 포트로
   * 나뉘지 않아 그 주소에 실은 쿠키는 같은 PC에서 다른 포트로 듣는 프로그램에도 가므로, 기기 코드 로그인을 시작하지도 마치지도 않는다(그 요청에는
   * grantSession·newLoginKey도 없다). 없으면 공개 주소로 온 요청이다
   */
  loginRefusal?: string;
}

export interface Backend {
  /**
   * IPC 메서드 처리. 실패하면 BackendError(한국어 메시지)를 던진다. caller: 원격 호출자(서버 HTTP, S3-3) — 없으면 데스크톱 길 그대로다.
   * 서버 모드(BackendDeps.mode 'server')에서 호출자 없는 요청은 세션 없는 원격 호출자로 본다 — 서버는 kv 대표 세션을 쓰지 않는다 (S3-2)
   */
  invoke<M extends WookMethod>(method: M, args: WookParams<M>, caller?: RemoteCaller): Promise<WookResult<M>>;
  /** 화면 푸시 이벤트 구독 (데스크톱: 로그아웃 중이면 업무 내용을 빼고 거른다) */
  onTopic<T extends WookTopic>(topic: T, cb: (payload: WookTopics[T]) => void): () => void;
  /** 거르지 않은 푸시 이벤트 (서버, S3-3) — 서버가 한 번만 구독하고 연결마다 topicFor로 거른다 */
  onTopicRaw<T extends WookTopic>(topic: T, cb: (payload: WookTopics[T]) => void): () => void;
  /**
   * 그 호출자에게 보낼 푸시 값 (보내지 않으면 undefined, S3-3): 로그인하지 않은 호출자는 데스크톱의 로그아웃 규칙 그대로 — 스냅숏은 업무 내용을 뺀 것
   * (lockedSnapshot), notification·cliEvents는 보내지 않고, navigate·emergency·openSettings는 그대로. 스냅숏의 auth는 그 호출자의 상태다
   */
  topicFor<T extends WookTopic>(topic: T, payload: WookTopics[T], caller: RemoteCaller): WookTopics[T] | undefined;
  /** 그 호출자에게 보낼 지금 스냅숏 (SSE 연결 때, S3-3) — topicFor와 같은 규칙 */
  snapshotFor(caller: RemoteCaller): Promise<AppSnapshot>;
  /** 트레이 메뉴·전역 단축키의 긴급 정지 (CTL-02) */
  emergencyStop(): Promise<EmergencySummary>;
  getTrayStatus(): TrayStatus;
  onTrayStatus(cb: (status: TrayStatus) => void): () => void;
  /**
   * 진행 중 작업이 있는지 (완전 종료 확인 ENV-09, 절전 방지 ENV-11·AC-31): 실행 중인 CLI 턴, 그리고 턴 사이에 프로그램이 하는
   * 작업 처리(제출 처리·자동 검사·병합). 보류·답변 대기 같은 대기는 넣지 않는다
   */
  hasActiveWork(): boolean;
  onActiveWorkChange(cb: (active: boolean) => void): () => void;
  /** 절전 방지 설정값 */
  preventSleepEnabled(): boolean;
  /** 긴급 정지 단축키 설정값 (예: 'CommandOrControl+Alt+Shift+S') */
  emergencyShortcut(): string;
  /** 완전 종료 전: 체크포인트 저장, 실행 중 턴 정리 (ENV-09) */
  shutdown(): Promise<void>;
  /** 하루 1회 자동 백업 (ENV-07) — 껍데기가 시각을 정해 호출 */
  backupNow(): Promise<{ path: string }>;
  backupEnabled(): boolean;
  /**
   * 외부 에이전트 API의 백엔드 쪽 (서버 모드만 — 데스크톱은 없다, 리드 결정 S7-1·S7-2). 서버(src/server/agentApi.ts)가 HTTP를 받아 이것을 부른다
   */
  readonly agents?: AgentBackend;
}

/**
 * 외부 에이전트 API의 백엔드 쪽 (SERVER_DESIGN 4.5, 리드 결정 S7-2·S7-3·S7-4 — orchestrator/externalAgents.ts). HTTP·인증 머리·횟수 제한·본문 상한은 서버(agentApi.ts)가
 * 맡고, 여기는 키 확인과 자리·임대·일·도구·화면·정지를 한다. 거부는 BackendError — code는 에이전트 API의 오류 코드(agentApiTypes.ts AGENT_ERROR_CODES)
 */
export interface AgentBackend {
  /** 에이전트 API가 붙는 루프백 리스너(앱 도구 서버)의 기본 주소 `http://127.0.0.1:<port>` — 시작 전이면 null */
  baseUrl(): string | null;
  /** 도구 서버 주소 `…/mcp` */
  mcpUrl(): string | null;
  /** `/agent/v1/*` 처리기를 그 리스너에 붙인다 (null이면 뗀다) */
  mount(handler: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | null): void;
  /** 키 → 에이전트 (모양이 틀리거나 모르거나 폐기된 키면 null — 무엇도 바꾸지 않는다) */
  authenticate(key: string): { id: string; label: string } | null;
  claim(agentId: string): Omit<ClaimReply, 'ok'>;
  heartbeat(agentId: string, leaseId: string): Omit<HeartbeatReply, 'ok'>;
  release(agentId: string, leaseId: string, note: string | null): void;
  seat(agentId: string): Omit<SeatReply, 'ok'>;
  /** 일 하나 — 없으면(기다린 시간이 끝남·새 롱폴이 이 롱폴을 대신함) null. closed: 연결이 끊기면 풀린다 */
  next(agentId: string, leaseId: string, waitMs: number, closed: Promise<void>): Promise<Omit<WorkItem, 'ok'> | null>;
  progress(agentId: string, leaseId: string, turnId: string, text: string): void;
  finish(agentId: string, leaseId: string, turnId: string, finalText: string, outcome: 'completed' | 'failed'): Promise<Omit<FinishReply, 'ok'>>;
  /** 도구 (MCP tools/call과 같은 길). 토큰이 없거나 죽었거나 다른 에이전트의 것이면 BackendError('unauthorized') */
  tool(agentId: string, token: string, name: string, args: unknown): Promise<ToolCallResult>;
  /** 캡처 PNG (보관 중이고 해시가 맞는 지금 세대의 것만) — 토큰 규칙은 tool과 같다 */
  screen(agentId: string, token: string, captureId: string): Buffer;
  /** 긴급 정지 (등록·폐기되지 않은 키면 누구나 — 리드 결정 S7-12 1) */
  stop(agentId: string): Promise<EmergencySummary>;
}

/**
 * 운영자 길 (서버 관리 채널, SERVER_DESIGN 3.2, S2-4): 행위자 operator로 처리·기록한다. 프로세스 안에서만 쓰고 어떤 네트워크(IPC·HTTP)에도 올리지 않는다.
 * createBackend가 붙인다 — 데스크톱 껍데기는 쓰지 않는다. 외부 에이전트의 등록·폐기(7단계, S7-2)도 이 길뿐이다 — 대표의 길에는 보기(agents.list)만 있다
 */
export interface BackendOperator {
  /** 긴급 정지 — 대표의 긴급 정지(stop.emergency)와 같은 처리, 행위자만 operator */
  emergencyStop(): Promise<EmergencySummary>;
  /**
   * 운영자 시험 세션 (리드 결정 S3-4, 관리 채널 `session test` — --allow-test-session 서버만 부른다): 등록된 대표의 실제 기기 세션
   * '운영자 시험 세션'을 연다. 대표가 없으면 시험용 대표를 만들고 활동 기록에 그렇게 적는다(행위자 operator). 토큰 원문은 이 반환값으로만 나간다
   */
  openTestSession(): TestSessionGrant;
  /** 운영자가 한 일을 활동 기록에 남긴다 (서버 종료 요청 등) */
  note(text: string): void;
  /**
   * 서버 프로세스가 쥔 비밀 값(관리 토큰 등)을 백엔드 가리개에 넣는다 (리드 결정 S5-30) — host_exec 출력·CLI 기록·도구 결과·활동 기록에 그 값이 찍혀도 가린다.
   * 값은 기록·응답에 넣지 않는다
   */
  registerSecret(value: string, kind: string): void;
  /** 관리 채널 status에 넣는 백엔드 상태 */
  status(): BackendOperatorStatus;
  /**
   * 운영자 설정 값을 적용한다 (리드 결정 S3-8 — server.json·--owner-email·운영자 명령): 값이 DB와 다르면 덮어쓰고 덮어쓴 것마다 활동 기록(행위자 operator)에 남긴다.
   * 모든 값을 먼저 확인하고 하나라도 틀리면 아무것도 바꾸지 않고 BackendError('invalid')를 던진다. 바뀐 것을 돌려준다
   */
  applyServerConfig(values: ServerConfigValues, origin: string): ServerConfigChange[];
  /** 운영자 설정의 지금 값 (config show) — 비밀 값은 등록 여부만 */
  serverConfigState(): ServerAuthStatus;
  /** 서버의 구글 로그인 보안 비밀 (운영자 `secret set|clear google-client-secret`, S3-8): OS 보안 저장소에 넣거나 지운다. 값은 기록·응답에 넣지 않는다 */
  setGoogleClientSecret(value: string | null): Promise<void>;
  /**
   * 대표 이메일 설정 코드를 새로 낸다 (리드 결정 S3-6): 대표 이메일이 이미 정해졌으면 null. 코드 원문은 이 반환값으로만 나간다 — 서버가 콘솔과
   * `<dataDir>/setup-code.txt`(그 사용자만)에 쓴다
   */
  issueSetupCode(): SetupCodeGrant | null;
  /** 메인 자리 보기 (운영자 `seat status`, 리드 결정 S4-8) — 아무것도 바꾸지 않는다 */
  seatStatus(): SeatOperatorStatus;
  /**
   * 운영자 배정 (`seat assign <보유자> [--force]`, S4-8): 바꾼 쪽 operator로 SeatService.assign을 거친다. force면 실행 중인 메인 턴을 바로 멈추고 마무리를
   * 기다리지 않는다. 교체가 잠깐 안에 끝나지 않으면 진행 중으로 답한다(seat status로 본다). 거부는 BackendError
   */
  assignSeat(holder: string, force: boolean): Promise<SeatAssignReport>;
  /**
   * 외부 에이전트 등록 (운영자 `agent add --label <이름>`, 리드 결정 S7-2·S7-3): 새 ID와 키 `wsk_…`를 낸다. 키 원문이 있는 곳은 이 반환값 하나뿐이다 — DB에는
   * sha256만, 활동 기록(auth, operator)·서버 기록·메인 일지에는 키가 없다. 이름은 1~40자, 제어 문자 없이, 폐기하지 않은 에이전트끼리 겹치지 않는다. 거부는 BackendError
   */
  addExternalAgent(label: string): ExternalAgentGrant;
  /**
   * 외부 에이전트 폐기 (운영자 `agent revoke <ID>`, S7-2): 이미 폐기됐으면 바꾸지 않고 already로 답한다. 모르는 ID는 BackendError('not_found').
   * seated: 그 에이전트가 메인 자리에 앉아 있거나 들어올 차례다 — 자리는 그대로 두고 응답 없음이 된다 (S7-4, 서버는 대체하지 않는다)
   */
  revokeExternalAgent(id: string): ExternalAgentRevokeReport;
  /** 외부 에이전트 목록 (운영자 `agent list`, 대표의 agents.list와 같은 보기) — 키·해시는 없다 */
  listExternalAgents(): ExternalAgentView[];
}

/** 운영자 `agent add`의 답 (S7-2) — key는 이번 한 번만 나간다 */
export interface ExternalAgentGrant {
  id: string;
  label: string;
  /** `wsk_` + 32바이트 base64url */
  key: string;
  createdAt: string;
}

/** 운영자 `agent revoke`의 답 (S7-2) */
export interface ExternalAgentRevokeReport {
  id: string;
  label: string;
  /** 폐기한 때 (이미 폐기됐으면 그때) */
  revokedAt: string;
  /** 이미 폐기돼 있어 바꾼 것이 없다 */
  already: boolean;
  /** 메인 자리에 앉아 있거나(seated) 진행 중인 교체의 들어올 보유자(incoming)다 */
  seated: boolean;
}

/** 운영자 `seat status`의 답 (S4-8) */
export interface SeatOperatorStatus {
  seat: SeatView;
  /** 응답 없음이 이어진 시간 (ms, 긴급 정지한 시간은 해제 때 뺀다 — S4-5). 응답하면 null */
  unresponsiveForMs: number | null;
  /** 진행 중인 교체 (switching일 때) — stage draining: 나가는 메인 턴의 마무리 · finishing: 인계 메모 턴과 마무리 · unconfirmed: 나가는 턴의 종료를 확인하지 못해 멈춤 */
  swap: { from: number; to: number; by: 'main' | 'operator' | 'server'; force: boolean; stage: 'draining' | 'finishing' | 'unconfirmed'; requestedAt: string } | null;
  policy: { holders: string[]; drainMs: number };
  /** 최근 이력 (새 것부터 5줄) */
  history: SeatHistoryEntry[];
}

/** 운영자 `seat assign`의 답 (S4-8) */
export interface SeatAssignReport {
  /** swap: 새 세대로 교체 · same: 같은 종류에서 모델·노력치만 · seated: 빈 자리에 앉힘 */
  outcome: 'swap' | 'same' | 'seated';
  /** 나가는 세대 (빈 자리였으면 그 마지막 세대) */
  from: number;
  generation: number;
  /** 이전 보유자 이름 (빈 자리였으면 null) */
  previous: string | null;
  /** 새 보유자 이름 */
  holder: string;
  force: boolean;
  /** 답할 때의 자리 — active면 끝났다. switching이면 아직 넘기는 중이거나(stage draining·finishing) 멈췄다(unconfirmed) */
  state: SeatView['state'];
  stage: 'draining' | 'finishing' | 'unconfirmed' | null;
  /** 운영자의 마무리 기다림 (ms) */
  drainMs: number;
}

/** 운영자 설정 값 (서버, S3-8) — 없는 칸은 DB 값을 그대로 둔다 */
export interface ServerConfigValues {
  /** 대표 이메일 (server.json owner.email 또는 --owner-email) */
  ownerEmail?: { email: string; source: 'config' | 'flag' };
  /** 서버의 구글 클라이언트 ID ('TV 및 입력 제한 기기' 종류) */
  googleClientId?: string;
  /** CLI 실행 파일 위치 (설정 settings.cli — 데스크톱 앱과 같은 칸) */
  cli?: { claudePath?: string; codexPath?: string };
  /**
   * 지금 쓰는 접속 허용 (S3-7·S3-19) — HTTP가 운영자 설정에서 요청마다 읽고 DB 설정에는 넣지 않는다. 여기서는 앞서 쓰던 값(kv `server.access`)과 견줘
   * 바뀐 것을 기록만 한다. 없으면 견주지 않는다. 공개 주소는 --public-origin이 있으면 그것(정한 곳 flag), 없으면 server.json의 값
   */
  access?: { publicOrigin: { origin: string; source: 'config' | 'flag' } | null; tailscaleLogins: readonly string[] | null };
  /**
   * 메인 자리 정책 (server.json의 seat, 리드 결정 S4-12) — 앉을 수 있는 보유자·교체 때 마무리를 기다리는 시간(ms)·처음 보유자(자리가 비었을 때만 쓴다).
   * null 칸은 지금 값을 그대로 둔다
   */
  seat?: SeatConfigValues;
}

/** server.json seat의 값 (리드 결정 S4-12) */
export interface SeatConfigValues {
  initialHolder: string | null;
  holders: string[] | null;
  drainMs: number | null;
}

/** 운영자 설정이 바꾼 것 하나 — 사람이 읽는 글 (비밀 값 없음 — Tailscale 사용자는 켬·끔과 수만) */
export interface ServerConfigChange {
  item: 'owner.email' | 'google.clientId' | 'cli.claudePath' | 'cli.codexPath' | 'network.publicOrigin' | 'owner.tailscaleLogins' | 'seat.holders' | 'seat.drainMs' | 'seat.initialHolder';
  text: string;
}

/** 서버 로그인 설정의 지금 값 (config show, S3-6·S3-8) */
export interface ServerAuthStatus {
  /** 대표 이메일과 정한 곳 (없으면 null — 설정 코드를 기다린다) */
  ownerEmail: string | null;
  ownerEmailSource: 'config' | 'flag' | 'setup' | null;
  /** 구글 계정(sub)까지 등록된 대표가 있는지 (시험용 대표는 아니다) */
  ownerRegistered: boolean;
  /** 지금 쓸 수 있는 설정 코드의 만료 (없으면 null) */
  setupCodeExpiresAt: string | null;
  google: { clientId: string | null; secretSet: boolean };
  cli: { claudePath: string | null; codexPath: string | null };
  /** 살아 있는 기기 세션 수 */
  deviceSessions: number;
  /** 메인 자리 정책 (S4-12) — 앉을 수 있는 보유자·교체 때 마무리를 기다리는 시간. 가짜 백엔드에는 없을 수 있다 */
  seat?: { holders: string[]; drainMs: number };
}

/** 설정 코드 (S3-6) — 원문은 서버 콘솔과 setup-code.txt에만 */
export interface SetupCodeGrant {
  code: string;
  /** 끝나는 때 (ISO) */
  expiresAt: string;
}

export interface BackendOperatorStatus {
  emergencyStop: { active: boolean; since: string | null };
  /** OS 보안 저장소를 못 써서 메모리로 대신하면 backend 'memory'와 그 이유 */
  secretStore: { backend: 'keyring' | 'memory'; fallbackReason: string | null };
  /**
   * 화면 조작의 마지막으로 안 상태 (리드 결정 S6-11 — system.prereqs의 screen과 같은 값, 아무것도 띄우지 않는다). 가짜 백엔드·예전 서버의 답에는 없을 수 있다
   */
  screen?: PrereqStatus['screen'];
}

/** 운영자 시험 세션 발급 결과 — 관리 채널 응답으로 한 번만 나간다 */
export interface TestSessionGrant {
  token: string;
  /** 세션이 끝나는 때 (ISO) */
  expiresAt: string;
  sessionId: string;
  /** 등록된 대표가 없어 시험용 대표를 만들었는지 */
  ownerCreated: boolean;
}

/** 서버 HTTP의 업로드·내려받기 (리드 결정 S3-10, orchestrator/serverFiles.ts) — 자리와 대상을 정한다. 본문 받기·응답은 HTTP 층이 한다 */
export type ServerFileAccess = Pick<ServerFiles, 'beginUpload' | 'finishUpload' | 'abortUpload' | 'sweep' | 'download'>;

/**
 * createBackend가 돌려주는 백엔드: 껍데기 경계(Backend) + 운영자 길 + 기기 세션 저장소(서버 HTTP가 토큰을 확인하고 끊긴 세션의 SSE를 닫는다, S3-4) +
 * 서버 HTTP의 업로드·내려받기(S3-10)
 */
export type OperatedBackend = Backend & { readonly operator: BackendOperator; readonly sessions: DeviceSessionStore; readonly files: ServerFileAccess };

/** 백엔드가 껍데기에게 빌리는 OS 기능 */
export interface ShellServices {
  openExternal(url: string): Promise<void>;
  openPath(path: string): Promise<void>;
  pickFiles(): Promise<{ path: string; name: string }[]>;
  /** OS 알림 (12장). urgent는 소리 포함. 클릭 시 화면 이동은 껍데기가 처리 */
  showOsNotification(n: { level: 'urgent' | 'normal'; title: string; body: string; onClick: () => void }): void;
  /** 창을 앞으로 */
  focusWindow(): void;
}

export interface BackendDeps {
  /** 앱 데이터 폴더 (예: %APPDATA%/wookagent) */
  dataDir: string;
  /** 앱 루트 (resources/ 가 있는 곳) */
  appRoot: string;
  isPackaged: boolean;
  /**
   * 개발 모드 로그인을 받는지 (SERVER_DESIGN 3.5, S2-2). 패키징 여부와 따로 둔다 — 데스크톱은 `!app.isPackaged`(예전과 같음). 서버 모드는 이 값과
   * 상관없이 늘 끈다 (리드 결정 S3-2 — 서버는 false를 넘긴다)
   */
  allowDevLogin: boolean;
  /**
   * 이 욱채 프로세스: 껍데기가 잡은 실행 잠금의 내용 + 데이터 폴더 (S2-15). 저장소에 데이터의 주인으로 적고, 살아 있는 다른 욱채가 적혀 있으면
   * (복사본이거나 잠금 파일이 지워짐) 복구 전에 BackendError('data_in_use')로 시작하지 않는다 — 그 욱채의 CLI를 끊지 않게
   */
  instance: InstanceIdentity;
  /** 앱 버전 (진단 정보·보고에 표시) */
  appVersion?: string;
  /** node 실행 파일 (모의 에이전트 실행용). Electron이면 process.execPath + ELECTRON_RUN_AS_NODE */
  nodeExecPath: string;
  nodeExecEnv: Record<string, string>;
  /** null이면 OS 기능 없이 돈다 (OrchestratorDeps와 같은 모양). 서버는 쓸 수 없는 기능을 분명히 거부하는 화면 없는 셸(src/server/headlessShell.ts)을 넘긴다 (S2-7) */
  shell: ShellServices | null;
  /**
   * 로그인 방식 (리드 결정 S3-2). 'desktop': 예전 그대로 — kv `auth.session` 하나, 구글 루프백 로그인, allowDevLogin이면 개발 모드 로그인.
   * 'server': kv `auth.session`을 읽지도 쓰지도 않고 개발 모드 로그인은 늘 꺼진다. 누가 부르는지는 호출자(RemoteCaller)의 기기 세션으로 정하고,
   * 대표 게이트는 원격 길('remote')로 돈다 — HTTP로 온 요청에는 운영자 로컬 메서드가 없다 (SERVER_DESIGN 2.5)
   */
  mode: 'desktop' | 'server';
  /** 서버의 메인 자리 운영자 설정 (server.json의 seat, S4-12) — 시작할 때 자리 정책과 새 DB의 처음 보유자로 쓴다. 데스크톱은 넘기지 않는다 */
  seat?: SeatConfigValues;
  /**
   * 작업 폴더 위치 (SERVER_DESIGN 3.7, 리드 결정 S5-20) — 그 아래 `main`이 메인 에이전트 작업 폴더다. 데스크톱은 `~/wook-workspace`, 서버는 `--workspace-root` >
   * server.json `workspaceRoot` > `~/wook-workspace` (serve.ts가 정하고 잠금 전에 확인한다). 없으면(시험 하네스) 예전 자리 `<dataDir>/main-agent`
   */
  workspaceRoot?: string;
  /**
   * 운영자 설정 server.json의 screen (리드 결정 S6-11) — enabled가 false면 화면 조작을 쓰지 않는다(화면 도구는 unavailable 'disabled', 화면 도우미를 띄우지 않는다).
   * 서버를 시작할 때만 읽는다. 데스크톱은 넘기지 않는다 — 데스크톱 앱은 화면 조작을 쓰지 않는다
   */
  screen?: { enabled: boolean | null };
}

export class BackendError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'BackendError';
  }
}
