/**
 * 오케스트레이터 의존성 조립. Electron 앱(createBackend)과 통합 테스트가 같이 쓴다.
 */
import { join, resolve } from 'node:path';
import type { AiKind, Settings } from '@shared/domain';
import { systemClock, type Clock } from '@core/time';
import { createRedactor, type Redactor } from '@core/redact';
import { openStore } from '../db/store';
import { createGitService } from '../git/gitService';
import { createProcessRunner } from '../process/processRunner';
import type { JobHelper } from '../process/jobHelper';
import { createClaudeAdapter, createCodexAdapter } from '../agents';
import { createMockAdapter } from '../agents/mockAdapter';
import { HOST_EXEC_AI_KEYS } from '../agents/common';
import { createAppToolServer } from '../mcp/server';
import { createSecretStore } from '../auth/secretStore';
import { apiKeyStatusEnv, createApiKeyCache } from '../auth/apiKeys';
import { googleLogin } from '../auth/googleAuth';
import { scanSkills } from '../skills/scanSkills';
import { normalizeSettings } from '../orchestrator/defaults';
import { dataPaths } from '../orchestrator/paths';
import { mainWorkDirOf } from '../orchestrator/mainWork';
import { claimDataOwner } from '../orchestrator/dataOwner';
import type { LogFn, OrchestratorDeps } from '../orchestrator/context';
import type { SeatConfigValues, ShellServices } from './types';
import type { InstanceIdentity } from './instanceLock';

export interface BuildDepsOptions {
  dataDir: string;
  appRoot: string;
  isPackaged: boolean;
  /** 개발 모드 로그인을 받는지 (S2-2). 없으면 !isPackaged — 예전 판정 그대로 (시험 하네스). 서버 모드는 늘 끈다 (S3-2) */
  allowDevLogin?: boolean;
  /** 로그인 방식 (S3-2). 없으면 'desktop' */
  mode?: 'desktop' | 'server';
  /**
   * 이 욱채 프로세스 (실행 잠금 내용 + 데이터 폴더, S2-15). 있으면 저장소를 열자마자 데이터의 주인을 보고 적는다(orchestrator/dataOwner.ts) — 살아 있는
   * 다른 욱채의 데이터(복사본·잠금 파일이 지워짐)면 러너·복구 전에 BackendError(data_in_use)로 멈춘다. 잠금을 잡은 껍데기(데스크톱·서버)가 넘긴다.
   * 없으면(시험 하네스) 확인하지 않는다
   */
  instance?: InstanceIdentity;
  appVersion?: string;
  nodeExecPath: string;
  nodeExecEnv: Record<string, string>;
  shell: ShellServices | null;
  logger?: LogFn;
  clock?: Clock;
  /** 테스트: OS 보안 저장소 대신 메모리 */
  memorySecrets?: boolean;
  timing?: OrchestratorDeps['timing'];
  /** 테스트: 프로세스 러너 방식 고정 */
  runnerMode?: 'jobobject' | 'taskkill' | 'pgroup';
  /** 테스트: taskkill 방식의 작업 개체 도우미를 바꾼다 (null = 도우미를 쓸 수 없는 환경) */
  jobHelper?: JobHelper | null;
  /** 테스트: 기기 코드 로그인의 구글 주소를 가짜 구글 서버로 (S3-5) */
  googleDevice?: OrchestratorDeps['googleDevice'];
  /** 서버의 메인 자리 운영자 설정 (server.json의 seat, S4-12) */
  seat?: SeatConfigValues;
  /** 작업 폴더 위치 (리드 결정 S5-20) — 그 아래 main이 메인 에이전트 작업 폴더다. 없으면(시험 하네스) 예전 자리 `<dataDir>/main-agent` */
  workspaceRoot?: string;
}

/**
 * 서버를 띄운 셸이 내보낸 AI 키(HOST_EXEC_AI_KEYS의 이름, 대소문자 무시)를 가리개에 넣는다 (리드 결정 S5-30): 그 값은 서버 프로세스의 환경에 살아 있고, CLI 턴이
 * 아직 이 환경을 그대로 넘기므로(S5-21) 메인 CLI의 셸이 찍을 수 있다. 형식 규칙이 없는 키(Azure OpenAI·xAI 등)도 가린다. 8자보다 짧은 값은 키가 아니라 넣지 않는다.
 * 넣은 수를 돌려준다
 */
export function registerEnvAiKeys(redactor: Pick<Redactor, 'addSecret'>, env: Record<string, string | undefined>): number {
  let n = 0;
  for (const [name, value] of Object.entries(env)) {
    if (!HOST_EXEC_AI_KEYS.includes(name.toUpperCase()) || !value || value.trim().length < 8) continue;
    redactor.addSecret(value, 'api-key');
    n++;
  }
  return n;
}

export async function buildOrchestratorDeps(o: BuildDepsOptions): Promise<OrchestratorDeps> {
  const paths = dataPaths(o.dataDir);
  const store = openStore(paths.db);
  if (o.instance) {
    // 데이터의 주인 확인 (S2-15): 무엇도 쓰기 전에 — 프로세스 러너(표준 입력 임시 파일 정리·러너 컴파일)와 재시작 복구보다 먼저
    try {
      await claimDataOwner({ store, self: o.instance, log: o.logger });
    } catch (error) {
      store.close();
      throw error;
    }
  }
  const settings =(): Settings => normalizeSettings(store.kv.get<Settings>('settings'));
  const runner = await createProcessRunner({
    dataDir: o.dataDir,
    forceMode: o.runnerMode,
    runnerSource: join(o.appRoot, 'resources', 'jobrunner', 'JobRunner.cs'),
    log: o.logger,
    ...(o.jobHelper !== undefined ? { jobHelper: o.jobHelper } : {}),
  });
  // API 키 방식이면 CLI 상태 확인에도 턴과 같은 키 변수를 넣는다 — 넣지 않으면 구독 로그인이 없는 PC에서 시작 때마다 '재로그인 필요'로 막힌다
  // (리드 결정 16). statusEnv는 동기라 키는 메모리 사본에서 읽는다(시작 때·키 등록 때 채움). 키가 없으면 설정은 읽지 않는다
  const apiKeys = createApiKeyCache();
  const statusEnv = (kind: AiKind) => (): Record<string, string> => {
    const key = apiKeys.get(kind);
    return key ? apiKeyStatusEnv(kind, settings().account.authMode[kind], key) : {};
  };
  const claude = createClaudeAdapter({ pathOverride: () => settings().cli.claudePath, statusEnv: statusEnv('claude') });
  const codex = createCodexAdapter({ pathOverride: () => settings().cli.codexPath, statusEnv: statusEnv('codex') });
  const mock = createMockAdapter({
    nodeExecPath: o.nodeExecPath,
    nodeExecEnv: o.nodeExecEnv,
    scriptPath: join(o.appRoot, 'resources', 'mock-agent', 'mock-agent.mjs'),
  });
  const redactor = createRedactor({
    // 가리개는 던지지 않는다 — 글 하나를 가리지 못하면 그 글 대신 '[가림:가리기 실패]'를 남기고 경고 한 줄. 글의 내용은 적지 않는다 (리드 결정 S5-83)
    onFailure: (f) =>
      o.logger?.(
        'warn',
        `가리개가 ${f.where === 'text' ? '글' : '값'} 하나를 가리지 못해 '[가림:가리기 실패]'로 바꿨습니다 (${f.error}${f.length !== null ? `, ${f.length.toLocaleString('ko-KR')}자` : ''}) — 원문은 남기지 않았습니다`,
      ),
  });
  // 서버는 운영자가 환경으로 내보낸 AI 키도 가린다 (S5-30) — 데스크톱은 예전 그대로
  if (o.mode === 'server') registerEnvAiKeys(redactor, process.env);
  return {
    dataDir: o.dataDir,
    appRoot: o.appRoot,
    isPackaged: o.isPackaged,
    // 서버 모드는 개발 모드 로그인을 늘 끈다 — 넘긴 값과 상관없이 (S3-2)
    allowDevLogin: o.mode === 'server' ? false : (o.allowDevLogin ?? !o.isPackaged),
    mode: o.mode ?? 'desktop',
    appVersion: o.appVersion,
    store,
    clock: o.clock ?? systemClock,
    git: createGitService(),
    runner,
    adapters: { claude, codex, mock },
    createToolServer: (opts) => createAppToolServer(opts),
    secrets: createSecretStore({ service: 'wookagent', forceMemory: o.memorySecrets }),
    apiKeys,
    redactor,
    shell: o.shell,
    googleLogin,
    ...(o.googleDevice ? { googleDevice: o.googleDevice } : {}),
    ...(o.seat ? { seat: o.seat } : {}),
    ...(o.workspaceRoot ? { mainWorkDir: mainWorkDirOf(resolve(o.workspaceRoot)) } : {}),
    scanSkills,
    logger: o.logger,
    timing: o.timing,
  };
}
