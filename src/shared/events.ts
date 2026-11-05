/**
 * CLI 이벤트 정규화 형식 (CLI-02, CLI-16, MBR-03).
 * Claude Code stream-json · Codex --json JSONL · 모의 에이전트 출력을 모두 이 형식으로 바꿔 저장·표시한다.
 * 저장 전에 text·data·raw 모두 비밀 값 가리기를 적용한다 (SEC-10).
 */
import type { IsoTime } from './domain';

export type CliEventKind =
  | 'session' // 세션 시작·이어하기 (cliSessionId, 바이패스·MCP 상태)
  | 'text' // 에이전트 메시지
  | 'thinking' // 추론 요약
  | 'tool_call' // 도구 호출 (Read/Edit/Bash 등)
  | 'tool_result'
  | 'command_start' // 셸 명령 시작 (강조 표시)
  | 'command_end' // 셸 명령 종료 (exitCode)
  | 'file_change' // 파일 변경 (강조 표시)
  | 'mcp_call' // 앱 도구 호출
  | 'usage' // 사용량
  | 'error' // 오류 (errorKind로 사용량 한도·인증·권한 확인 구분)
  | 'result' // 턴 종료 결과
  | 'system' // 프로그램이 넣은 안내 (정지 요청, 러너 종료 결과 등)
  | 'stderr'; // CLI 표준 오류 출력 한 줄

/** usage_limit=사용량 한도, auth=인증 만료, permission=실행 권한 확인 발생(바이패스 불일치) */
export type CliErrorKind = 'usage_limit' | 'auth' | 'permission' | 'mcp' | 'other';

export interface CliEventData {
  cliSessionId?: string;
  /** Claude init 이벤트의 permissionMode — 'bypassPermissions'여야 정상 */
  permissionMode?: string;
  mcpServers?: { name: string; status: string }[];
  tool?: string;
  /** 도구 호출 ID (호출·결과 짝 맞춤) */
  callId?: string;
  server?: string;
  command?: string;
  exitCode?: number | null;
  paths?: string[];
  ok?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  costUsd?: number;
  errorKind?: CliErrorKind;
  /** 사용량 한도 해제 예상 시각 (알 수 있을 때) */
  resetAt?: IsoTime;
  /** 사용량 한도의 종류 (Claude rate_limit_event의 rateLimitType — five_hour·seven_day·seven_day_opus 등, 알 수 있을 때) */
  rateLimitType?: string;
  isError?: boolean;
  numTurns?: number;
  /** result 이벤트의 권한 거부 목록 — 비어 있지 않으면 바이패스 불일치 */
  permissionDenials?: number;
  /** 이어하기 실패 (세션을 찾을 수 없음 등) → 새 세션으로 인계 필요 (ERR-03) */
  resumeFailed?: boolean;
}

/** 파서가 만든 이벤트 (순번·시각은 저장할 때 붙인다) */
export interface ParsedCliEvent {
  kind: CliEventKind;
  /** 사람이 읽는 한 줄~여러 줄 요약 */
  text: string;
  data?: CliEventData;
  /** 원본 이벤트 객체 (원본 형식 보기). 저장 전에 가림 적용 */
  raw?: unknown;
}

export interface CliEvent extends ParsedCliEvent {
  /** 턴 안에서 1부터 증가 */
  seq: number;
  ts: IsoTime;
  turnId: string;
}
