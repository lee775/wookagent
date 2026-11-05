/**
 * CLI 어댑터 계약 (15.3, 15.5, 16장).
 * - claude: `claude -p` + stream-json, 이어하기 `--resume` (+ 첫 턴 `--session-id`)
 * - codex: `codex exec --json`, 이어하기 `codex exec resume <thread_id>`
 * - mock: resources/mock-agent/mock-agent.mjs — 실제 CLI와 같은 형식(claude/codex)의 이벤트를 내고 앱 도구를 똑같이 호출 (MOCK-06)
 * 구현: ./claudeAdapter.ts, ./codexAdapter.ts, ./mockAdapter.ts, ./parsers/*.ts
 */
import type { AiKind, MockScenario } from '@shared/domain';
import type { ParsedCliEvent } from '@shared/events';
import type { RunSpec } from '../process/types';

export interface CliStatus {
  installed: boolean;
  /** 실행 파일 절대 경로 (Windows는 .exe로 해석한 경로) */
  path: string | null;
  version: string | null;
  /** 로그인 상태. 확인할 수 없으면 null */
  loggedIn: boolean | null;
  /** 검증된 버전 범위 안인지 (CLI-15). 범위 밖이면 problem에 사유 */
  problem: string | null;
  detail: string;
}

export interface TurnLaunch {
  /** 이벤트 형식. 모의 에이전트도 이 형식으로 출력해 실제 파서를 그대로 시험 */
  format: AiKind;
  cwd: string;
  /** 이번 턴에 보낼 사용자 메시지 (작업 카드·계속·답변·메시지 묶음) */
  message: string;
  /** 역할 지침 + 앱 작업 규칙 (MEM-04). 첫 턴·이어하기 모두 매번 넣는다 (CLI-21) */
  systemPrompt: string;
  /** 이어하기 대상 CLI 세션 ID (CLI-06). null이면 첫 턴 */
  resumeCliSessionId: string | null;
  /** 첫 턴에서 미리 정할 세션 UUID (Claude --session-id). codex는 무시 */
  newSessionId: string | null;
  /** CLI에 넘길 모델. null이면 넣지 않는다 (CLI 기본). Codex 팀원은 턴 실행기가 모델 목록 첫 항목으로 채운다 (windows:F1) */
  model: string | null;
  /** CLI 실제 노력치 값 — 목록은 EFFORT_LEVELS (claude: low|medium|high|xhigh|max, codex: low|medium|high|xhigh|max) */
  effort: string | null;
  /** 앱 도구 서버 (CLI-07). 토큰은 턴마다 새로 발급 */
  /**
   * toolTimeoutSec: 앱 도구 한 번을 CLI가 기다리는 시간(초) — 메인 대화 턴만 준다(host_exec가 오래 돌 수 있다, 리드 결정 S5-18). Codex는
   * mcp_servers.<이름>.tool_timeout_sec, Claude Code는 MCP_TOOL_TIMEOUT(ms). 없으면 CLI 기본값 그대로(팀원 턴 — 예전 그대로)
   */
  mcp: { url: string; token: string; serverName: string; toolTimeoutSec?: number };
  /** Claude --max-turns (CLI-22). null이면 넣지 않음 */
  maxTurns: number | null;
  /** 첨부 이미지 경로 (codex -i, claude는 메시지에 경로 안내) */
  images: string[];
  /** 추가 접근 폴더 */
  addDirs: string[];
  /** MCP 설정 파일 등 임시 파일을 쓸 폴더 (턴별) */
  tempDir: string;
  /** 추가 환경 변수 (API 키 방식 등). 호출자가 비밀 값을 넣는다 */
  env: Record<string, string>;
  /** 모의 에이전트 설정 (mock 어댑터만 사용) */
  mock?: MockLaunchOptions;
}

export interface MockLaunchOptions {
  scenario: MockScenario;
  /** 속도 배수 (MOCK-03) */
  speed: number;
  role: 'main' | 'producer' | 'member';
  memberId: string;
  workKey: string;
  /** 같은 업무의 몇 번째 턴인지 (1부터) — 시나리오가 '첫 턴만 실패' 같은 동작을 할 때 사용 */
  turnNumber: number;
  /** 시나리오 상태를 저장할 폴더 (예: 반려 횟수). 프로그램 데이터 폴더 안 */
  stateDir: string;
}

export interface PreparedRun {
  spec: RunSpec;
  /** 첫 턴에서 미리 정한 CLI 세션 ID (Claude --session-id). 모르면 null → 이벤트에서 받음 */
  expectedCliSessionId: string | null;
  /** 턴 종료 후 지울 임시 파일 */
  cleanup: string[];
  /** 실행 명령을 사람이 읽는 형태로 (활동 기록용, 비밀 값 제외) */
  display: string;
}

export interface EventParser {
  /** stdout 한 줄 → 정규화 이벤트 0개 이상. 해석 불가 줄은 kind 'stderr'가 아니라 'system'으로 원문 보존 */
  pushLine(line: string): ParsedCliEvent[];
  /** stderr 한 줄 → 오류 분류(usage_limit·auth 등) 포함 이벤트 */
  pushStderr(line: string): ParsedCliEvent[];
  /** 출력이 끝났을 때 (result 이벤트가 없었으면 그 사실을 알리는 이벤트 등) */
  finish(exitCode: number | null): ParsedCliEvent[];
}

export interface AgentAdapter {
  readonly kind: AiKind | 'mock';
  /** 설치·버전·로그인 확인 (ENV-04, CLI-15) */
  detect(): Promise<CliStatus>;
  /** 실행 명령 준비. 바이패스 옵션·MCP·지침·작업 폴더를 매번 명시 (CLI-11, CLI-21) */
  prepare(launch: TurnLaunch): Promise<PreparedRun>;
  /** 턴마다 새 파서 */
  createParser(launch: TurnLaunch): EventParser;
}
