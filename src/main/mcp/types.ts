/**
 * 앱 도구 서버(MCP) 계약 (CLI-07, CLI-08, ENV-02).
 * - 127.0.0.1(루프백)에서만 받는다. Host 헤더도 루프백 주소만 허용 (DNS 리바인딩 방지)
 * - 인증: Authorization: Bearer <턴 토큰>. 토큰 없음·만료 → 401, 기록
 * - 도구 목록은 토큰 주인의 역할로 걸러서 공개하고, 호출 때마다 처리기가 다시 검사
 * 구현: ./server.ts 의 createAppToolServer()
 */
import type { MemberId, ProjectId, SessionId, SessionKind, TurnId } from '@shared/domain';

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
}

export type ToolCallResult =
  | { ok: true; data: unknown }
  | { ok: false; code: 'forbidden' | 'invalid' | 'conflict' | 'not_found' | 'stopped' | 'seat_changed' | 'error'; message: string };

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
}

export interface AppToolServerOptions {
  handler: ToolHandler;
  /** 모든 호출(거부 포함)을 기록 (LOG-01) */
  onCall: (log: ToolCallLog) => void;
  /** 0이면 임의 포트 */
  port?: number;
}
