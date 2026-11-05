/**
 * 백엔드 조립 지점: 오케스트레이터 + 저장소 + git + 프로세스 러너 + CLI 어댑터 + 앱 도구 서버.
 * Electron 껍데기(main/index.ts)와 서버(src/server/serve.ts)가 부르고, 업무 로직은 모두 오케스트레이터가 맡는다.
 * 서버는 mode 'server'를 넘긴다 — 대표 길은 호출자(기기 세션)마다 원격 게이트로 돌고(S3-2·S3-3), 관리 채널은 운영자 길(operator.ts)을 쓴다 (SERVER_DESIGN 3.2)
 */
import { join } from 'node:path';
import type { BackendDeps, OperatedBackend } from './types';
import { buildOrchestratorDeps } from './buildDeps';
import { createBackendOperator } from './operator';
import { createOrchestrator } from '../orchestrator/orchestrator';
import { releaseDataOwner } from '../orchestrator/dataOwner';
import { dataPaths } from '../orchestrator/paths';
import { createFileLogger } from '../shell/logger';

export async function createBackend(deps: BackendDeps): Promise<OperatedBackend> {
  const logger = createFileLogger({ dir: join(deps.dataDir, 'logs'), fileName: 'backend.log' });
  const log = (level: 'info' | 'warn' | 'error', msg: string, extra?: unknown) => {
    if (extra === undefined) logger[level](msg);
    else logger[level](msg, extra);
  };
  let odeps: Awaited<ReturnType<typeof buildOrchestratorDeps>>;
  try {
    odeps = await buildOrchestratorDeps({
      dataDir: deps.dataDir,
      appRoot: deps.appRoot,
      isPackaged: deps.isPackaged,
      allowDevLogin: deps.allowDevLogin,
      mode: deps.mode,
      // 데이터의 주인 확인 — 살아 있는 다른 욱채의 데이터면 러너·복구 전에 멈춘다 (S2-15)
      instance: deps.instance,
      appVersion: deps.appVersion,
      nodeExecPath: deps.nodeExecPath,
      nodeExecEnv: deps.nodeExecEnv,
      shell: deps.shell,
      logger: log,
      ...(deps.seat ? { seat: deps.seat } : {}),
      ...(deps.workspaceRoot ? { workspaceRoot: deps.workspaceRoot } : {}),
    });
  } catch (error) {
    logger.close();
    throw error;
  }
  // 로그 파일에도 대표가 등록한 비밀 값·턴 토큰까지 가린 값만 남긴다 (SEC-10)
  logger.setRedactor((t) => odeps.redactor.text(t));
  // 서버 모드면 로그인 방식도 적는다 — 운영자가 기록으로 확인한다 (S3-2). 데스크톱 줄은 예전 그대로
  const loginMode = deps.mode === 'server' ? ', 로그인 방식 서버(기기 세션 — kv 대표 세션을 쓰지 않음)' : '';
  log('info', `백엔드 시작 — 데이터 폴더 ${deps.dataDir}, 프로세스 종료 방식 ${odeps.runner.mode} (${odeps.runner.detail})${loginMode}`);
  const orch = await createOrchestrator(odeps);
  const backend = orch.backend;
  const shutdown = backend.shutdown;
  return {
    ...backend,
    operator: createBackendOperator(() => orch.core),
    // 서버 HTTP가 토큰을 확인하고 끊긴 세션의 SSE를 닫는다 (S3-4). 운영자 길처럼 부를 때 읽는다
    get sessions() {
      return orch.core.deviceSessions;
    },
    // 서버 HTTP의 업로드·내려받기 (S3-10)
    get files() {
      return orch.core.serverFiles;
    },
    shutdown: async () => {
      await shutdown();
      // 깨끗한 종료: 저장소의 데이터 주인 기록이 아직 이 프로세스면 지운다 — 데스크톱·서버 모두 이 길로 끝난다 (S2-20)
      if (deps.instance) releaseDataOwner({ dbPath: dataPaths(deps.dataDir).db, self: deps.instance, log });
      logger.close();
    },
  };
}
