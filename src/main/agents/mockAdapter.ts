/**
 * 모의 에이전트 어댑터 (기획서 16장 MOCK-06, ARCHITECTURE 14장).
 *
 * <node> resources/mock-agent/mock-agent.mjs --format claude|codex (--session-id <id> | --resume <id>)
 *        < [지침 블록 + 메시지](표준 입력)
 *
 * - 실행 파일은 Node(테스트) 또는 ELECTRON_RUN_AS_NODE=1인 Electron(앱)이다. 그 환경은 nodeExecEnv로 받는다.
 * - 출력 형식은 launch.format을 따르고 파서도 실제 CLI 파서를 그대로 쓴다 — CLI 연동 코드를 사용량 없이 시험하기 위해서다.
 * - 첫 턴에도 세션 ID를 미리 정해 넘긴다 (codex 형식 포함). 모의 에이전트는 그 ID로 세션 시작 이벤트를 낸다.
 * - 지침은 codex 대체 방식과 같은 <wook_instructions> 블록으로 메시지 앞에 붙인다 (실제 CLI와 같은 내용이 들어가게).
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { MOCK_SCENARIOS, type AiKind } from '@shared/domain';
import type { AgentAdapter, CliStatus, EventParser, MockLaunchOptions, PreparedRun, TurnLaunch } from './types';
import { CLAUDE_EFFORTS, CODEX_EFFORTS, LaunchError, buildChildEnv, displayCommand, isUuid, validateLaunch } from './common';
import { codexMessageWithInstructions } from './codexAdapter';
import { createParserFor } from './parsers';

export interface MockAdapterOptions {
  /** 모의 에이전트를 실행할 Node 실행 파일 (앱에서는 Electron 실행 파일) */
  nodeExecPath: string;
  /** 그 실행 파일을 Node로 쓰기 위한 환경 변수 (예: ELECTRON_RUN_AS_NODE=1) */
  nodeExecEnv: Record<string, string>;
  /** resources/mock-agent/mock-agent.mjs 절대 경로 */
  scriptPath: string;
  /** 자식 환경의 바탕 (기본 process.env). 부모 CLI 세션 표시 변수는 지운다 */
  baseEnv?: () => NodeJS.ProcessEnv | Record<string, string | undefined>;
  /** 사용량 한도 해제 시각 계산용 시계 (파서) */
  now?: () => Date;
  timeZone?: string;
  platform?: NodeJS.Platform;
}

const FORMAT_LABEL: Record<AiKind, 'Claude Code' | 'Codex'> = { claude: 'Claude Code', codex: 'Codex' };
const ROLES: readonly MockLaunchOptions['role'][] = ['main', 'producer', 'member'];
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

export function createMockAdapter(opts: MockAdapterOptions): AgentAdapter {
  const platform = opts.platform ?? process.platform;

  return {
    kind: 'mock',
    async detect(): Promise<CliStatus> {
      const scriptOk = existsSync(opts.scriptPath);
      // PATH 이름이면 실행할 때 찾으므로 여기서는 절대 경로만 확인한다
      const nodeOk = !isAbsolute(opts.nodeExecPath) || existsSync(opts.nodeExecPath);
      const problem = !scriptOk
        ? `모의 에이전트 스크립트가 없습니다: ${opts.scriptPath}`
        : !nodeOk
          ? `모의 에이전트를 실행할 Node 실행 파일이 없습니다: ${opts.nodeExecPath}`
          : null;
      return {
        installed: scriptOk && nodeOk,
        path: opts.scriptPath,
        version: 'mock',
        loggedIn: true,
        problem,
        detail: problem ?? `모의 에이전트 (${opts.nodeExecPath} ${opts.scriptPath})`,
      };
    },

    async prepare(launch: TurnLaunch): Promise<PreparedRun> {
      const mock = launch.mock;
      if (!mock) throw new LaunchError('모의 에이전트 실행 설정(launch.mock)이 없습니다');
      validateMockOptions(mock);
      if (launch.format !== 'claude' && launch.format !== 'codex') throw new LaunchError(`모의 에이전트 출력 형식이 올바르지 않습니다: ${String(launch.format)}`);
      // 실제 어댑터와 같은 검사를 거친다 — 모의 실행에서 통과한 값이 실제 실행에서 거부되지 않게
      try {
        await validateLaunch(FORMAT_LABEL[launch.format], launch, launch.format === 'claude' ? CLAUDE_EFFORTS : CODEX_EFFORTS);
      } catch (e) {
        if (e instanceof LaunchError) throw new LaunchError(`모의 에이전트(${launch.format} 형식): ${e.message}`);
        throw e;
      }
      if (!existsSync(opts.scriptPath)) throw new LaunchError(`모의 에이전트 스크립트가 없습니다: ${opts.scriptPath}`);

      const resume = launch.resumeCliSessionId !== null;
      if (!resume && launch.format === 'claude' && launch.newSessionId !== null && !isUuid(launch.newSessionId)) {
        throw new LaunchError(`모의 에이전트(claude 형식) 새 세션 ID는 UUID여야 합니다: "${launch.newSessionId}"`);
      }
      const sessionId = resume ? launch.resumeCliSessionId! : (launch.newSessionId ?? randomUUID());
      const args = [opts.scriptPath, '--format', launch.format, ...(resume ? ['--resume', sessionId] : ['--session-id', sessionId])];
      const env = buildChildEnv(
        opts.baseEnv?.() ?? process.env,
        { ...opts.nodeExecEnv, ...launch.env, ...mockEnv(launch, mock) },
        platform,
      );
      const stdinText = launch.systemPrompt.trim() !== '' ? codexMessageWithInstructions(launch.systemPrompt, launch.message) : launch.message;
      return {
        spec: { command: opts.nodeExecPath, args, cwd: launch.cwd, env, stdinText, label: `모의 ${launch.format} ${resume ? '이어하기' : '첫 턴'}` },
        expectedCliSessionId: sessionId,
        cleanup: [],
        display: `${displayCommand(opts.nodeExecPath, args, stdinText.length)} (모의 시나리오 ${mock.scenario}, 속도 ${mock.speed}배)`,
      };
    },

    createParser(launch: TurnLaunch): EventParser {
      return createParserFor(launch.format, { serverName: launch.mcp.serverName, now: opts.now, timeZone: opts.timeZone });
    },
  };
}

/** 모의 에이전트가 읽는 환경 변수 (ARCHITECTURE 14장) */
export function mockEnv(launch: TurnLaunch, mock: MockLaunchOptions): Record<string, string> {
  return {
    WOOK_MCP_URL: launch.mcp.url,
    WOOK_MCP_TOKEN: launch.mcp.token,
    WOOK_MCP_SERVER: launch.mcp.serverName,
    WOOK_MOCK_SCENARIO: mock.scenario,
    WOOK_MOCK_SPEED: String(mock.speed),
    WOOK_MOCK_ROLE: mock.role,
    WOOK_MOCK_MEMBER: mock.memberId,
    WOOK_MOCK_WORKKEY: mock.workKey,
    WOOK_MOCK_TURN: String(mock.turnNumber),
    WOOK_MOCK_STATE_DIR: mock.stateDir,
  };
}

function validateMockOptions(m: MockLaunchOptions): void {
  if (!(MOCK_SCENARIOS as readonly string[]).includes(m.scenario)) {
    throw new LaunchError(`알 수 없는 모의 시나리오입니다: "${String(m.scenario)}" (가능: ${MOCK_SCENARIOS.join(', ')})`);
  }
  if (typeof m.speed !== 'number' || !Number.isFinite(m.speed) || m.speed <= 0) throw new LaunchError(`모의 속도 배수는 0보다 큰 수여야 합니다: ${String(m.speed)}`);
  if (!ROLES.includes(m.role)) throw new LaunchError(`모의 역할이 올바르지 않습니다: "${String(m.role)}" (main|producer|member)`);
  for (const [name, v] of [
    ['팀원 ID', m.memberId],
    ['업무 키', m.workKey],
  ] as const) {
    if (typeof v !== 'string' || v.trim() === '' || CONTROL_RE.test(v)) throw new LaunchError(`모의 ${name}가 비어 있거나 올바르지 않습니다: "${String(v)}"`);
  }
  if (!Number.isInteger(m.turnNumber) || m.turnNumber < 1) throw new LaunchError(`모의 턴 번호는 1 이상의 정수여야 합니다: ${String(m.turnNumber)}`);
  if (typeof m.stateDir !== 'string' || !isAbsolute(m.stateDir)) throw new LaunchError(`모의 상태 폴더는 절대 경로여야 합니다: ${String(m.stateDir)}`);
}
