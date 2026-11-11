/**
 * 앱 도구 서버(MCP) 계약 (CLI-07, CLI-08, ENV-02).
 * - 127.0.0.1(루프백)에서만 받는다. Host 헤더도 루프백 주소만 허용 (DNS 리바인딩 방지)
 * - 인증: Authorization: Bearer <턴 토큰>. 토큰 없음·만료 → 본문을 읽기 전에 401 (DB에 쓰지 않고 기록 파일에 1분 창 한 줄, 리드 결정 S7-17 A1)
 * - 도구 목록은 토큰 주인의 역할로 걸러서 공개하고, 호출 때마다 처리기가 다시 검사
 * 구현: ./server.ts 의 createAppToolServer()
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { MemberId, ProjectId, SessionId, SessionKind, TurnId } from '@shared/domain';
import type { ToolSpec } from './catalog';

export interface TokenIdentity {
  turnId: TurnId;
  sessionId: SessionId;
  sessionKey: string;
  sessionKind: SessionKind;
  memberId: MemberId;
  projectId: ProjectId | null;
  isMain: boolean;
  isProducer: boolean;
  canReview: boolean;
  /**
   * 메인 자리 세대 (SERVER_DESIGN 4.1, 리드 결정 S4-4) — 메인 턴의 토큰은 늘 채운다(턴을 띄울 때의 세대, turns.ts launch). 도구 처리기는 지금 자리가
   * 받지 않는 세대의 메인 토큰을 seat_changed로 거부하고 기록한다. 없으면 세대를 보지 않는다 — 처리기를 직접 부르는 프로세스 안 시험 신원뿐이다
   */
  seatGeneration?: number;
  /**
   * 이 턴이 어느 프로젝트의 일인지 — 작업 키에서 뽑은 것(records.workProjectOf, SERVER_DESIGN 5.4·리드 결정 S5-5). projectId는 팀원이 속한 프로젝트라
   * 메인 에이전트는 늘 null이다 — 메인의 도구 호출 기록(app_tool)은 이 값으로 프로젝트를 남긴다. 없으면(시험 신원) 모름
   */
  workProjectId?: ProjectId | null;
  /**
   * 이 턴을 띄운 AI 종류와 모델의 키 (desktop/service.ts aiModelKey — 리드 결정 S6-21 G). 메인 턴의 토큰은 늘 채운다(턴을 띄울 때의 M-MAIN AI, turns.ts launch).
   * 화면 보기 확인(get_screen_check·answer_screen_check)은 이 키가 지금 자리 보유자의 모델 키와 같은 턴만 받고 답한다 — 턴이 도는 중에 모델이 바뀌면 그 턴은
   * 옛 모델 그대로라 새 모델의 확인을 대신할 수 없다. 없으면 모델을 보지 않는다 — 처리기를 직접 부르는 프로세스 안 시험 신원뿐이다
   */
  modelKey?: string;
  /**
   * 이 턴을 받아 간 외부 에이전트 (7단계 S7b, 리드 결정 S7-3) — 외부 보유자의 턴 토큰에만 있다. 에이전트 API의 tool·screens 길은 키의 에이전트와 이 값이 같을 때만
   * 받고, 키 폐기·긴급 정지는 이 값으로 그 에이전트의 토큰을 모두 거둔다(revokeWhere). 그 턴의 modelKey는 `external:<이 값>`이다 (리드 결정 S7-14)
   */
  externalAgentId?: string;
}

/**
 * 도구 거부 코드 전부 (리드 결정 S6-3) — 이 목록 하나가 서버(server.ts ERROR_CODES)와 처리기(tools.ts의 BackendError 코드 연결)를 먹인다.
 * 화면 조작이 더한 것: human_active = 서버 PC 앞 사람 입력 멈춤·멈춤 단축키, secret_blocked = 비밀 값이 든 글·암호 칸이나 모르는 포커스,
 * denied_target = 금지된 키·창·관리자 권한 대상, stale_capture = 30초 지난 캡처·바뀐 화면 배치, rate_limited = 횟수 상한, unavailable = 화면 조작을 쓸 수 없음
 */
export const TOOL_FAILURE_CODES = ['forbidden', 'invalid', 'conflict', 'not_found', 'stopped', 'seat_changed', 'error',
  'unavailable', 'stale_capture', 'rate_limited', 'human_active', 'secret_blocked', 'denied_target'] as const;
export type ToolFailureCode = (typeof TOOL_FAILURE_CODES)[number];
/** base64 PNG ≤ 4MiB — 캐시·onCall·기록 밖, 글 블록 뒤 */
export interface ToolImage { mimeType: 'image/png'; data: string }
export type ToolCallResult = { ok: true; data: unknown; images?: ToolImage[] } | { ok: false; code: ToolFailureCode; message: string };

/** 도구 이름 → 처리. args는 zod로 검사된 값 */
export type ToolHandler = (identity: TokenIdentity, toolName: string, args: Record<string, unknown>) => Promise<ToolCallResult>;

export interface ToolCallLog {
  at: string;
  identity: TokenIdentity | null;
  tool: string;
  args: Record<string, unknown>;
  result: ToolCallResult | { ok: false; code: 'unauthorized'; message: string };
  durationMs: number;
}

export interface AppToolServer {
  /** 시작 후 주소 (예: http://127.0.0.1:53211/mcp) */
  start(): Promise<{ url: string; port: number }>;
  stop(): Promise<void>;
  readonly url: string | null;
  /** 턴마다 새 토큰 발급 */
  issueToken(identity: TokenIdentity): string;
  /** 턴 종료 시 폐기 — 이후 이 토큰의 호출은 401 */
  revokeToken(token: string): void;
  revokeTurn(turnId: TurnId): void;
  /**
   * 조건에 맞는 토큰을 모두 폐기한다 — 지운 수 (메인 자리 교체 4번 `revokeWhere(identity => identity.isMain)`, SERVER_DESIGN 4.3·리드 결정 S4-3).
   * 시험의 가짜 서버에는 없을 수 있다 — 그때 이전 세대 토큰은 도구 처리기의 세대 확인(seat_changed)이 막는다
   */
  revokeWhere?(pred: (identity: TokenIdentity) => boolean): number;
  /**
   * 이 리스너의 기본 주소 (예: http://127.0.0.1:53211) — 에이전트 API(`/agent/v1`)와 MCP(`/mcp`)가 같은 루프백 포트에 있다 (리드 결정 S7-2·S7-3). 시작 전·종료 뒤 null.
   * 시험의 가짜 서버에는 없을 수 있다
   */
  readonly baseUrl?: string | null;
  /** 살아 있는 턴 토큰의 신원 (모르거나 폐기됐으면 null) — 에이전트 API의 tool·screens 길이 키의 에이전트와 같은지 본다 (S7-3) */
  identityOf?(token: string): TokenIdentity | null;
  /**
   * MCP tools/call과 같은 길(입력 검사·역할·처리기·기록 onCall) — 에이전트 API의 `POST /agent/v1/tool/{name}`가 쓴다 (S7-2). 토큰이 죽었으면 null
   */
  callTool?(token: string, name: string, args: unknown): Promise<ToolCallResult | null>;
  /**
   * `/agent/v1/*`를 이 리스너에 붙인다 — Host 검사 뒤에 부른다. 붙이지 않은 리스너(데스크톱 앱)는 그 길에 404 (S7-3: 서버 모드에서만).
   * 처리기는 요청마다 셋째 인자로 이 리스너의 인증 없는 요청 몫을 받는다 (리드 결정 S7-17 A1 — `/mcp`와 함께 쓴다)
   */
  mountAgentApi?(handler: ListenerHandler | null): void;
}

/**
 * 한 리스너의 인증하지 못한 요청 몫 (리드 결정 S7-3·S7-17 A1): `/mcp`와 거기 붙은 `/agent/v1`이 함께 1분에 120번 — 넘으면 429와 Retry-After.
 * 맞는 에이전트 키나 살아 있는 턴 토큰을 실은 요청은 세지 않는다
 */
export interface UnauthenticatedBudget {
  /** 인증하지 못한 요청 하나를 센다 — 몫을 넘었으면 다시 해도 되는 때까지의 초, 넘지 않았으면 null */
  hit(): number | null;
}

/** 리스너에 붙이는 처리기 (`/agent/v1/*`) — budget: 그 리스너의 인증 없는 요청 몫 (없으면 처리기가 제 몫을 쓴다 — 단위 시험) */
export type ListenerHandler = (req: IncomingMessage, res: ServerResponse, budget?: UnauthenticatedBudget) => Promise<void>;

export interface AppToolServerOptions {
  handler: ToolHandler;
  /**
   * 토큰이 살아 있는 모든 도구 호출(거부 포함)을 기록 (LOG-01). 인증하지 못한 요청(401·429)과 Host 거부(403)는 넘기지 않는다 — DB에 쓰지 않고 log로 모은다
   * (리드 결정 S7-17 A1). 다만 이 실행에서 폐기한 토큰(끝난 턴)으로 다시 온 401은 그 턴의 신원으로 요청마다 한 번 넘긴다(사유에 메시지 수)
   */
  onCall: (log: ToolCallLog) => void;
  /** 0이면 임의 포트 */
  port?: number;
  /**
   * 그 호출자에게 보일 도구 설명 (리드 결정 S6-6) — 없으면 카탈로그 글 그대로. 화면 이미지를 볼 수 없다고 확인된 보유자에게 screen_capture 설명에
   * '이 보유자는 화면 이미지를 볼 수 없다고 확인됨'을 붙이는 데 쓴다
   */
  describe?: (identity: TokenIdentity, spec: ToolSpec) => string;
  /**
   * 외부 에이전트의 턴 토큰(externalAgentId가 있는 신원)을 쓰기 직전에 부른다 (리드 결정 S7-17 F4) — 그 임대의 끝나는 때가 지났으면 그 자리에서 임대를 끝내
   * 토큰을 거둔다(externalAgents.sweep). 서버는 부른 뒤 토큰을 다시 찾아, 죽었으면 401로 답한다 — 임대 길이 lease_expired로 답하는 바로 그때 토큰도 죽는다
   */
  beforeExternal?: (identity: TokenIdentity) => void;
  /**
   * 이 리스너의 거부 기록 (리드 결정 S7-17 A1) — 인증하지 못한 요청(401·429)과 Host 거부(403)는 DB에 쓰지 않고, 종류마다 1분 창에 한 줄(창의 첫 줄과 나머지 수)로
   * 여기에 쓴다. 없으면 쓰지 않는다
   */
  log?: (text: string) => void;
  /**
   * 요청 하나를 받는 시간·머리를 받는 시간의 상한 (밀리초 — 기본 30초·10초, 리드 결정 S7-22 S3). 받는 시간만 잰다(롱폴·느린 도구의 답은 상관없다). 시험이 줄인다
   */
  timeouts?: { requestMs?: number; headersMs?: number };
}
