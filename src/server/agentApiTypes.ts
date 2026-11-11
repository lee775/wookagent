/**
 * 에이전트 API의 주고받는 모양 (SERVER_DESIGN 4.5, 리드 결정 S7-2·S7-3·S7-4) — 서버(agentApi.ts)와 `wook` CLI(src/cli)가 같이 쓴다. 타입과 상수만 둔다
 * (실행 코드를 끌어오지 않는다 — CLI 묶음이 가볍게).
 *
 * - 주소: `<dataDir>/agent-endpoint.json`의 agentApi (`http://127.0.0.1:<port>/agent/v1`) — 앱 도구 서버(MCP)와 같은 루프백 리스너, 시작마다 새 포트
 * - 키를 보내기 전: `POST hello`로 그 주소의 서버가 agent-endpoint.json의 proof를 아는지 확인한다 (인증 없는 길은 이것 하나 — S7-19 C3)
 * - 그 밖의 모든 요청: `Authorization: Bearer wsk_…`(에이전트 키). 키·턴 토큰을 주소(쿼리)에 넣으면 401
 * - 도구·화면 길은 키와 함께 `X-Wook-Turn-Token: wtt_…`(그 턴의 토큰)도 — 키와 토큰이 같은 에이전트여야 한다
 * - 본문: JSON 1MB까지 (도구 인자는 4MB까지). 오류는 `{ ok: false, error: { code, message } }` — message는 한국어 한 문장
 */
import type { IsoTime, SessionKind, TurnEndReason } from '@shared/domain';
import type { EmergencySummary, SeatHandoverView, SeatHolderView } from '@shared/views';

/** 경로 앞부분 */
export const AGENT_API_PREFIX = '/agent/v1';
/** 턴 토큰을 싣는 머리 */
export const TURN_TOKEN_HEADER = 'x-wook-turn-token';
/** agent-endpoint.json의 판 */
export const AGENT_ENDPOINT_VERSION = 1;
/** 본문 상한 (도구 인자 밖) */
export const AGENT_BODY_MAX_BYTES = 1024 * 1024;
/** 도구 인자 본문 상한 */
export const AGENT_TOOL_BODY_MAX_BYTES = 4 * 1024 * 1024;
/** 진행 글 상한 (자) */
export const AGENT_PROGRESS_MAX = 4000;
/** 마지막 답 상한 (자) */
export const AGENT_FINAL_MAX = 20000;
/** 임대·heartbeat·롱폴 (기본값 — 실제 값은 claim의 답이 준다) */
export const AGENT_LEASE_MS = 60_000;
export const AGENT_HEARTBEAT_MS = 15_000;
export const AGENT_POLL_MAX_MS = 25_000;
/** 1분 창의 상한 — 키마다 요청, 인증 없는 요청 전체 */
export const AGENT_RATE_PER_KEY = 600;
export const AGENT_RATE_UNAUTHENTICATED = 120;

/** 오류 코드 (리드 결정 S7-2) */
export const AGENT_ERROR_CODES = [
  'unauthorized',
  'rate_limited',
  'not_assigned',
  'seat_changed',
  'switching',
  'stopped',
  'lease_expired',
  'lease_superseded',
  'turn_ended',
  'not_found',
  'invalid',
  'too_large',
  'internal',
] as const;
export type AgentErrorCode = (typeof AGENT_ERROR_CODES)[number];

/** 코드 → HTTP 상태 */
export const AGENT_ERROR_STATUS: Readonly<Record<AgentErrorCode, number>> = {
  unauthorized: 401,
  rate_limited: 429,
  not_assigned: 403,
  seat_changed: 409,
  switching: 409,
  stopped: 409,
  lease_expired: 409,
  lease_superseded: 409,
  turn_ended: 409,
  not_found: 404,
  invalid: 400,
  too_large: 413,
  internal: 500,
};

export interface AgentError {
  ok: false;
  error: { code: AgentErrorCode | string; message: string };
}

/** `<dataDir>/agent-endpoint.json` — 주소만, 키는 없다 (리드 결정 S7-2) */
export interface AgentEndpointFile {
  version: typeof AGENT_ENDPOINT_VERSION;
  /** `http://127.0.0.1:<port>/agent/v1` */
  agentApi: string;
  /** `http://127.0.0.1:<port>/mcp` */
  mcp: string;
  runId: string;
  pid: number;
  startedAt: IsoTime;
  /**
   * 이 실행의 확인값 (리드 결정 S7-19 C3) — 실행마다 새 32바이트 난수(base64url). 그 사용자만 읽는 이 파일에만 있다: 어떤 길도 돌려주지 않고, 기록하지 않고,
   * 어디로도 보내지 않는다. 키가 아니다 — 듣는 쪽이 이 서버인지 `POST hello`로 확인하는 데만 쓴다
   */
  proof: string;
}

// ───────────────────────── 서버 확인 ─────────────────────────

/** 확인값(proof)의 바이트 수 */
export const AGENT_PROOF_BYTES = 32;
/** hello의 nonce 바이트 수 (base64url로 적는다) */
export const AGENT_HELLO_NONCE_MIN_BYTES = 16;
export const AGENT_HELLO_NONCE_MAX_BYTES = 64;
/** hello 본문 상한 (넘으면 413) — 횟수 상한이 없는 길이라 값싸게 */
export const AGENT_HELLO_BODY_MAX_BYTES = 1024;

/**
 * POST hello — 인증 없는 길은 이것 하나다 (리드 결정 S7-19 C3). 키를 보내기 전에, 그 주소에서 듣는 쪽이 agent-endpoint.json을 쓴 서버인지 확인한다:
 * `mac` = base64url(HMAC-SHA256(키 = proof를 base64url로 푼 32바이트, 글 = nonce를 base64url로 푼 바이트)). 받은 mac을 같은 식으로 계산한 값과 견준다.
 * 어떤 nonce에도 같은 꼴로 답한다(실행 ID·proof는 내지 않는다). 인증 없는 요청의 몫(1분 120번)으로 세지 않고, 그 몫이 다 써졌어도 답하며, 제 횟수 상한도 없다(리드 후속 11-11 — 맞는 키를 가진 에이전트가 쓰레기 요청 때문에 멈추지
 * 않게). 본문은 1KB까지. 아무것도 바꾸지 않는다(DB·임대·마지막 접속·기록)
 */
export interface HelloRequest {
  /** base64url (16~64바이트, '=' 없이) */
  nonce: string;
}
export interface HelloReply {
  ok: true;
  mac: string;
}

// ───────────────────────── 자리 ─────────────────────────

/** POST seat/claim */
export interface ClaimRequest {
  /** 에이전트가 스스로 붙이는 이름 — 쓰지 않는다(이름은 등록 기록에서) */
  label?: string;
}
export interface ClaimReply {
  ok: true;
  agentId: string;
  label: string;
  generation: number;
  leaseId: string;
  leaseMs: number;
  heartbeatMs: number;
  pollMaxMs: number;
  /** 도구 서버 주소 (MCP) */
  mcpUrl: string;
  /** 메인 에이전트의 규칙 (서버가 띄우는 CLI의 시스템 프롬프트와 같은 글 — main_general) */
  rules: string;
  skills: { name: string; allowedRoles: string[] }[];
  /** 이 세대의 인계 꾸러미 (없으면 null) */
  handover: SeatHandoverView | null;
}

/** POST seat/heartbeat */
export interface HeartbeatRequest {
  leaseId: string;
}
export interface HeartbeatReply {
  ok: true;
  /** active: 일을 받는다 · switching: 자리를 넘기는 중(돌던 턴을 마치세요) · stopped: 메인 에이전트가 일시정지돼 일이 오지 않는다 */
  state: 'active' | 'switching' | 'stopped';
  /** 이 임대의 세대 */
  generation: number;
  leaseExpiresAt: IsoTime;
  /** 대기 중인 메인 일 수 */
  queued: number;
}

/** POST seat/release */
export interface ReleaseRequest {
  leaseId: string;
  note?: string;
}
export interface OkReply {
  ok: true;
}

/** GET seat */
export interface SeatReply {
  ok: true;
  /** 메인 자리가 이 에이전트에게 배정돼 있는지 */
  assigned: boolean;
  generation: number;
  state: 'active' | 'switching' | 'vacant' | 'stopped';
  holder: SeatHolderView | null;
  /** 이 에이전트의 살아 있는 임대가 끝나는 때 (없으면 null) */
  leaseExpiresAt: IsoTime | null;
}

// ───────────────────────── 일 ─────────────────────────

/** POST work/next */
export interface NextRequest {
  leaseId: string;
  /** 일이 없을 때 기다리는 시간 (ms, 0~pollMaxMs) */
  waitMs?: number;
}

/** 일 하나 (work/next의 200) — message가 이 턴의 일이다(CLI에 넣는 메시지 그대로) */
export interface WorkItem {
  ok: true;
  turnId: string;
  workKey: string;
  kind: SessionKind;
  projectId: string | null;
  generation: number;
  /** 메인 작업 폴더, 메인이 검수자인 일이면 검수 사본 */
  cwd: string;
  /** 서버가 띄우는 CLI의 시스템 프롬프트와 같은 글 */
  instructions: string;
  /** 이 턴의 메시지 — 이것이 일이다 */
  message: string;
  /** 현황 요약 (메인 대화 턴만, 메시지에도 들어 있다) */
  digest: string | null;
  attachments: { name: string; path: string }[];
  /** 이 턴의 도구 — MCP 주소와 턴 토큰 `wtt_…` (REST 도구 길도 같은 토큰) */
  mcp: { url: string; token: string };
  /** 이 턴의 시간 상한 (턴 시간 상한 설정) */
  deadlineAt: IsoTime;
}

/** POST work/{turnId}/progress */
export interface ProgressRequest {
  leaseId: string;
  text: string;
}

/** POST work/{turnId}/finish */
export interface FinishRequest {
  leaseId: string;
  finalText: string;
  outcome: 'completed' | 'failed';
}
export interface FinishReply {
  ok: true;
  endReason: TurnEndReason;
}

// ───────────────────────── 도구·화면·정지 ─────────────────────────

/** POST tool/{name} — 본문이 도구 인자. 도구의 거부는 200과 ok false (code는 도구 거부 코드 — forbidden·invalid·seat_changed 등) */
export type ToolReply = { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } };

/** POST stop — 긴급 정지 (대표의 긴급 정지와 같다. 풀기는 대표만). 답은 긴급 정지 요약 그대로에 ok */
export type StopReply = { ok: true } & EmergencySummary;
