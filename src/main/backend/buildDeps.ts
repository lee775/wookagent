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
import { fileSecretBackend, secretsDirOf } from '../auth/fileSecretStore';
import { apiKeyStatusEnv, createApiKeyCache } from '../auth/apiKeys';
import { googleLogin } from '../auth/googleAuth';
import { scanSkills } from '../skills/scanSkills';
import { normalizeSettings } from '../orchestrator/defaults';
import { dataPaths } from '../orchestrator/paths';
import { mainWorkDirOf } from '../orchestrator/mainWork';
import { claimDataOwner } from '../orchestrator/dataOwner';
import { createRealDesktopLauncher, probeRealDesktopHelper, realDesktopRefusal } from '../desktop/realHelper';
import { screenModeOff } from '../desktop/safety';
import { screenSession, type ScreenSession } from '../desktop/screenSession';
import { createX11DesktopLauncher, probeX11Helper } from '../desktop/x11Launcher';
import { x11LaunchRefusal } from '../process/scriptTool';
import type { DesktopDeps } from '../desktop/service';
import type { RunnerProblem } from '../process/types';
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
  /**
   * 화면 도우미 (리드 결정 S6-3·S6-5) — 시험은 가짜 도우미(tests/fixtures/desktop/fakeDesktop.ts의 launcher), null이면 없음. 넘기지 않으면 서버 모드의 Windows에서만
   * 실제 도우미(WookDesktopHelper.exe)를 쓴다 — 시험(VITEST) 중에는 실제 화면 시험 문이 닫혀 있으면 쓰지 않는다(화면 도구는 unavailable, 화면 확인 업무 없음).
   * 데스크톱 앱(mode 'desktop')과 운영자가 끈 실행(screen.enabled false)에는 넘겨도 쓰지 않는다 (리드 결정 S6-11)
   */
  desktop?: DesktopDeps | null;
  /**
   * 운영자 설정 server.json의 screen (리드 결정 S6-11·S10-7.6·S10-7.7) — enabled가 false면 화면 조작을 쓰지 않는다. Linux: display·xauthority(붙을 X 화면 — 없으면 서버의
   * 환경), typeWithoutA11y(암호 칸을 가르지 못해도 친다). 서버를 시작할 때만 읽는다
   */
  screen?: { enabled: boolean | null; display?: string | null; xauthority?: string | null; typeWithoutA11y?: boolean | null };
  /**
   * Linux 화면 세션을 정하는 환경 (DISPLAY·WAYLAND_DISPLAY·XDG_SESSION_TYPE·XAUTHORITY만 본다 — 리드 결정 S10-7.7). 주지 않으면 서버 프로세스의 환경이고, 시험(VITEST)
   * 중에는 빈 환경이다 — 시험이 도는 PC(WSLg·CI 러너·개발자의 데스크톱)의 화면 변수에 기대지 않게. 화면 변수가 필요한 시험은 이것으로 그 환경을 적는다
   */
  screenEnv?: Readonly<Record<string, string | undefined>>;
}

/** 화면 세션을 정하는 환경 — 넘긴 것, 없으면 시험 중에는 빈 환경, 아니면 서버 프로세스의 환경 (S10c) */
export function screenEnvOf(o: Pick<BuildDepsOptions, 'screenEnv'>, env: NodeJS.ProcessEnv = process.env): Readonly<Record<string, string | undefined>> {
  if (o.screenEnv) return o.screenEnv;
  return env.VITEST ? {} : env;
}

/**
 * 실제 화면 도우미 의존성 (리드 결정 S6-11·S10-7) — 서버 모드에서, 실제 도우미를 띄울 수 있는 환경일 때만(시험 중 문 닫힘이면 없음). Windows는 WookDesktopHelper.exe,
 * Linux는 화면 세션이 X11이면 X11 화면 도우미(x11Helper.mjs). 데스크톱 앱은 화면 조작을 쓰지 않는다. 사전 점검의 확인(probe)과 실행 파일이 바뀐 것을 알리는
 * 길(onProblem)도 여기서 준다 — 둘 다 실제 도우미를 쓸 때만 있다
 */
function realDesktopDeps(o: BuildDepsOptions, session: ScreenSession): DesktopDeps | undefined {
  if (o.mode !== 'server') return undefined;
  if (process.platform === 'linux') return session.kind === 'x11' ? x11DesktopDeps(o, session) : undefined;
  if (realDesktopRefusal() !== null) return undefined;
  const sourcePath = join(o.appRoot, 'resources', 'desktophelper', 'DesktopHelper.cs');
  const listeners = new Set<(p: RunnerProblem) => void>();
  const launcher = createRealDesktopLauncher({
    dataDir: o.dataDir,
    sourcePath,
    log: (level, msg, extra) => o.logger?.(level, msg, extra),
    onProblem: (p) => {
      o.logger?.('error', `화면 도우미 실행 환경 문제 (${p.kind}): ${p.text}`);
      for (const cb of listeners) cb(p);
    },
  });
  return {
    launcher,
    // 사전 점검은 띄우는 이음매가 준비해 고정한 실행 파일을 쓴다 — 따로 준비하지 않는다 (S6F1b, 리드 결정 S6-21 H3)
    probe: () => probeRealDesktopHelper({ launcher }), // S6F1b
    onProblem: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}

/** Linux X11 화면 도우미 의존성 (S10c, 리드 결정 S10-7). 시험 중에는 Linux 실제 화면 시험 문이 열렸을 때만 (S10-7.11) */
function x11DesktopDeps(o: BuildDepsOptions, session: Extract<ScreenSession, { kind: 'x11' }>): DesktopDeps | undefined {
  if (x11LaunchRefusal(process.env, session.display) !== null) return undefined;
  const typeWithoutA11y = o.screen?.typeWithoutA11y === true;
  if (typeWithoutA11y) {
    o.logger?.('warn', 'server.json screen.typeWithoutA11y가 켜져 있습니다 — 포커스가 암호 칸인지 가르지 못해도(AT-SPI 없음) 메인 에이전트의 글자 입력을 보냅니다');
  }
  const listeners = new Set<(p: RunnerProblem) => void>();
  const launcher = createX11DesktopLauncher({
    dataDir: o.dataDir,
    appRoot: o.appRoot,
    nodePath: process.execPath,
    display: session.display,
    xauthority: session.xauthority,
    typeWithoutA11y,
    log: (level, msg, extra) => o.logger?.(level, msg, extra),
    onProblem: (p) => {
      o.logger?.('error', `화면 도우미 실행 환경 문제 (${p.kind}): ${p.text}`);
      for (const cb of listeners) cb(p);
    },
  });
  return {
    launcher,
    probe: () => probeX11Helper({ launcher }),
    onProblem: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    typeWithoutA11y,
  };
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
  // 화면 조작을 쓰지 않는 실행 (리드 결정 S6-11·S10-7.7): 데스크톱 앱·지원하지 않는 OS·운영자가 끔·Linux 화면 세션 없음(Wayland·화면 없음) — 이때는 화면 도우미를 넣지 않는다(넘겨받았어도). 그 밖에는 넘겨받은
  // 도우미(시험의 가짜), 없으면 서버 모드의 Windows에서 실제 도우미
  // Linux 서버의 화면 세션 (리드 결정 S10-7.7): server.json screen.display가 먼저, 없으면 서버의 환경 (Wayland면 쓸 수 없음)
  const session = screenSession({ platform: process.platform, env: screenEnvOf(o), config: o.screen ?? null });
  const screenOff = screenModeOff({ mode: o.mode, platform: process.platform, enabled: o.screen?.enabled ?? null, helperGiven: !!o.desktop, session });
  const desktop = screenOff ? undefined : o.desktop === undefined ? realDesktopDeps(o, session) : (o.desktop ?? undefined);
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
    // Linux는 데스크톱·서버 모두 데이터 폴더의 파일 저장소 — 키링을 쓰지 않는다 (리드 결정 S10-6.1)
    secrets: createSecretStore({ service: 'wookagent', forceMemory: o.memorySecrets, ...(process.platform === 'linux' ? { file: fileSecretBackend({ dir: secretsDirOf(o.dataDir) }) } : {}) }),
    apiKeys,
    redactor,
    shell: o.shell,
    googleLogin,
    ...(o.googleDevice ? { googleDevice: o.googleDevice } : {}),
    ...(o.seat ? { seat: o.seat } : {}),
    ...(o.workspaceRoot ? { mainWorkDir: mainWorkDirOf(resolve(o.workspaceRoot)) } : {}),
    scanSkills,
    ...(desktop ? { desktop } : {}),
    ...(screenOff ? { screenOff } : {}),
    logger: o.logger,
    timing: o.timing,
  };
}
