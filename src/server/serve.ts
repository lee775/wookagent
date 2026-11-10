/**
 * 서버 프로세스의 한살이 (SERVER_DESIGN 3.2, S2-5).
 * 시작: 인자(cli.ts) → 데이터 폴더(없으면 그 사용자만 쓰게 만든다) → 운영자 설정 미리 보기(파일의 모양과 적용할 값 — 틀리면 잠금·저장소를 만들지
 *   않는다, S3-35) → 실행 잠금(S2-6) → createBackend → 운영자 설정(server.json·--owner-email·
 *   --public-origin 적용, S3-8·S3-7 — 틀리면 시작하지 않는다) → HTTP·관리 채널 → 준비 줄 하나 → 대표 이메일이 없으면 설정 코드(S3-6 — 콘솔과
 *   setup-code.txt에만)와 자동 백업 예약.
 *   잠금은 백엔드(재시작 복구)보다 먼저 잡는다 — 두 번째 프로세스의 복구가 첫 프로세스의 CLI를 끊지 않게. 백엔드는 저장소의 데이터 주인도 본다
 *   (살아 있는 다른 욱채의 데이터 — 복사본·잠금 파일이 지워짐 — 면 시작하지 않는다, S2-15).
 *   시작이 실패하면 stderr와 기록에 남기고, 연 것을 닫고 잠금을 놓은 뒤 1로 끝낸다. stderr는 기록 파일을 실제로 썼을 때만 그 파일을 가리킨다 (S2-16).
 *   준비 전에 온 신호는 시작을 그만두게 한다 — 같은 실패 길로 1 (S2-16).
 * 종료: SIGINT·SIGTERM·SIGHUP·SIGBREAK(Windows)와 관리 채널 `shutdown`이 모두 createQuitFlow({confirm:false})로 간다 →
 *   새 요청 503 → backend.shutdown → SSE·HTTP·관리 채널 닫기 → 잠금 놓기 → 0으로 끝냄. 종료 중 두 번째 신호는 무시한다(종료 흐름의 상한은 그대로).
 * uncaughtException·unhandledRejection은 가린 기록만 남기고 계속 돈다 (데스크톱 main과 같다). 하루 1회 자동 백업은 데스크톱과 같은 예약이다
 * (startServerBackups, S3-8). 절전 처리는 아직 없다.
 */
import { readFileSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBackend } from '../main/backend/createBackend';
import { acquireInstanceLock, type HeldInstanceLock } from '../main/backend/instanceLock';
import type { OperatedBackend } from '../main/backend/types';
import { isDataOwnerRefusal } from '../main/orchestrator/dataOwner';
import { SETUP_CODE_FILE, setupCodePattern, showSetupCode } from '../main/orchestrator/serverLogin';
import { createBackupScheduler, type BackupScheduler } from '../main/shell/backupScheduler';
import { createFileLogger, defaultRedact, type FileLogger, type Logger } from '../main/shell/logger';
import { createQuitFlow, type QuitFlow } from '../main/shell/quit';
import { writePrivateFile } from './admin';
import { createOperatorConfig, precheckServerConfig, readServerConfig, serverConfigPath } from './config';
import { chooseWorkspaceRoot, workspaceProblem } from '../main/orchestrator/mainWork';
import { serverWindowTitle } from '../main/desktop/safety';
import { createHeadlessShell } from './headlessShell';
import { prepareDataDir } from './dataDir';
import { isLoopbackBind, nonLoopbackBindMessage, startServer, type RunningServer } from './server';
import { redactSessionTokens } from './sessions';

export interface ServeOptions {
  dataDir: string;
  bind: string;
  port: number;
  webDir: string | null;
  allowTestSession: boolean;
  /** 운영자 설정 파일 (--config, 없으면 `<dataDir>/server.json` — S3-8) */
  configPath?: string;
  /** 대표 이메일 (--owner-email — server.json의 owner.email보다 먼저다, S3-6) */
  ownerEmail?: string;
  /** 공개 주소 (--public-origin, 정리한 주소 — server.json의 network.publicOrigin보다 먼저다, S3-7) */
  publicOrigin?: string;
  /** 작업 폴더 위치 (--workspace-root — server.json의 workspaceRoot보다 먼저다, 리드 결정 S5-20). 메인 에이전트는 그 아래 main에서 일한다 */
  workspaceRoot?: string;
}

export interface ServeIo {
  out(text: string): Promise<void>;
  err(text: string): Promise<void>;
  exit(code: number): void;
  /** 운영자 명령 secret set의 비밀 값 — 표준 입력으로만 받는다 (S3-8). 없으면 그 명령을 쓸 수 없다 */
  readSecret?(): Promise<string>;
}

const SIGNALS: readonly NodeJS.Signals[] = process.platform === 'win32' ? ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] : ['SIGINT', 'SIGTERM', 'SIGHUP'];

/**
 * 앱 루트(resources/가 있는 곳): 이 파일 기준 두 단계 위 — 빌드한 out/server/index.mjs와 원본 src/server/serve.ts 모두 저장소 루트를 가리킨다
 * (S2-9). import.meta.url을 살려 둔 빌드라야 한다
 */
export function resolveAppRoot(moduleUrl: string = import.meta.url): string {
  return resolve(dirname(fileURLToPath(moduleUrl)), '..', '..');
}

function readVersion(appRoot: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : '알 수 없음';
  } catch {
    return '알 수 없음';
  }
}

/**
 * 서버 기록 가리기: 기본 규칙 + 기기 세션 토큰(wos_…) + 관리 토큰 값 (서버가 열린 뒤) + 낸 설정 코드 (S3-6 — 기록에 넣지 않지만 한 겹 더).
 * 설정 코드는 auth.setupOwner가 받는 모든 꼴(보이는 ABCD-EFGH, 소문자, 띄어쓰기)로 가린다 — 꼴은 serverLogin.ts setupCodePattern 하나가 정한다 (S3-18)
 */
export function serverRedactor(server: () => RunningServer | null, codes: ReadonlySet<string>): (text: string) => string {
  return (text) => {
    let out = redactSessionTokens(defaultRedact(text));
    for (const c of codes) out = out.replace(setupCodePattern(c), '[가림:설정코드]');
    return server()?.redactAdminToken(out) ?? out;
  };
}

/**
 * 서버의 하루 1회 자동 백업 (ENV-07, 리드 결정 S2-18·S3-8): 데스크톱과 같은 예약(shell/backupScheduler.ts)·같은 설정(general.backup.enabled)·같은
 * 기록 파일(`<dataDir>/backup-state.json`). 시험이 첫 확인까지의 시간을 줄인다
 */
export function startServerBackups(o: { backend: Pick<OperatedBackend, 'backupEnabled' | 'backupNow'>; dataDir: string; logger: Logger; initialDelayMs?: number; intervalMs?: number }): BackupScheduler {
  const scheduler = createBackupScheduler({
    backend: o.backend,
    stateFile: join(o.dataDir, 'backup-state.json'),
    logger: o.logger,
    initialDelayMs: o.initialDelayMs,
    intervalMs: o.intervalMs,
  });
  scheduler.start();
  o.logger.info('자동 백업 예약 시작 (하루 1회 — 설정 general.backup.enabled, 데스크톱 앱과 같은 backup-state.json)');
  return scheduler;
}

/**
 * 서버를 띄운다. 준비되면 null(프로세스는 종료 흐름이 끝낸다), 시작하지 못하면 끝낼 코드(1)를 돌려준다
 */
export async function runServe(opts: ServeOptions, io: ServeIo): Promise<number | null> {
  const { dataDir } = opts;
  // 루프백 밖 --bind는 무엇도 만들기 전에 거부한다 (S2-2) — 원격 접속은 늘 루프백 앞의 tailscale serve로
  if (!isLoopbackBind(opts.bind)) {
    await io.err(`욱채 서버를 시작하지 못했습니다: ${nonLoopbackBindMessage(opts.bind)}\n`);
    return 1;
  }
  try {
    prepareDataDir(dataDir);
  } catch (error) {
    await io.err(`욱채 서버를 시작하지 못했습니다: 데이터 폴더를 준비하지 못했습니다 (${dataDir}) — ${(error as Error).message}\n`);
    return 1;
  }
  const logger: FileLogger = createFileLogger({ dir: join(dataDir, 'logs'), fileName: 'server.log' });
  let server: RunningServer | null = null;
  const issuedCodes = new Set<string>();
  logger.setRedactor(serverRedactor(() => server, issuedCodes));
  // 처리되지 않은 오류 하나로 서버가 끝나지 않게 — 가린 기록만 남기고 계속 돈다 (S2-5)
  process.on('uncaughtException', (error) => logger.error('처리되지 않은 예외 (서버)', error));
  process.on('unhandledRejection', (reason) => logger.error('처리되지 않은 Promise 거부 (서버)', reason));

  let quit: QuitFlow | null = null;
  // 준비 전에 온 신호는 시작을 그만두게 한다 (S2-16) — 시작 단계(잠금·백엔드·HTTP)가 끝날 때마다 보고, 연 것을 닫고 잠금을 놓은 뒤 1로 끝낸다.
  // 준비 뒤의 신호는 종료 흐름으로 간다. 두 번째 신호는 무시한다
  let cancelled: string | null = null;
  for (const signal of SIGNALS) {
    process.on(signal, () => {
      logger.info(`종료 신호 받음 (${signal})`);
      if (quit) void quit.request({ confirm: false, reason: signal });
      else cancelled ??= signal;
    });
  }
  const cancelMessage = (): string => `준비되기 전에 종료 신호(${cancelled})를 받아 시작을 그만두었습니다`;

  let lock: HeldInstanceLock | null = null;
  let backend: OperatedBackend | null = null;
  // 시작하는 동안 프로세스를 붙잡아 둔다. 백엔드 준비는 프로세스를 붙잡지 않는 핸들(taskkill 방식의 작업 개체 도우미 등)만 기다릴 수 있어,
  // 그대로 두면 Node가 할 일이 없다고 보고 준비 전에 조용히 0으로 끝난다(잠금 파일도 남는다). 데스크톱은 Electron이 붙잡는다. HTTP가 열리거나 시작이 실패하면 놓는다
  const startupHold = setInterval(() => undefined, 60_000);
  const fail = async (message: string, error?: unknown): Promise<number> => {
    clearInterval(startupHold);
    if (error !== undefined) logger.error(`시작 실패: ${message}`, error);
    else logger.error(`시작 실패: ${message}`);
    if (server) {
      try {
        await server.close();
      } catch (e) {
        logger.error('시작 실패 뒤 HTTP·관리 채널 정리 실패', e);
      }
    }
    if (backend) {
      try {
        await backend.shutdown();
      } catch (e) {
        logger.error('시작 실패 뒤 백엔드 정리 실패', e);
      }
    }
    lock?.release();
    // 기록 파일을 실제로 썼을 때만 그 파일을 가리킨다 — 쓰지 못했으면 없는 파일을 가리키지 않고 그렇다고 말한다 (S2-16)
    const pointer = logger.isWritable()
      ? `자세한 기록: ${logger.filePath}`
      : `서버 기록(${logger.filePath})을 쓰지 못해 자세한 기록이 남지 않았습니다 — 데이터 폴더에 쓸 수 있는지 확인해 주세요`;
    logger.close();
    await io.err(`욱채 서버를 시작하지 못했습니다: ${message}\n${pointer}\n`);
    return 1;
  };

  const appRoot = resolveAppRoot();
  const version = readVersion(appRoot);
  logger.info(`욱채 서버 시작 v${version} (Node ${process.versions.node}, ${process.platform} ${process.arch}) 데이터 폴더: ${dataDir}`);

  // 운영자 설정 파일(S3-8)의 모양과 적용할 값(대표 이메일·구글 클라이언트 ID·CLI 위치, --owner-email — S3-35)을 먼저 본다 — 틀리면 잠금·백엔드
  // (저장소·재시작 복구)를 만들기 전에 그만둔다. 값은 백엔드가 뜬 뒤 적용한다
  const configPath = opts.configPath ? resolve(opts.configPath) : serverConfigPath(dataDir);
  const precheck = precheckServerConfig(configPath, { ownerEmail: opts.ownerEmail ?? null, publicOrigin: opts.publicOrigin ?? null });
  if (!precheck.ok) return fail(`운영자 설정을 적용하지 못했습니다 — ${precheck.message}`);

  // 메인 자리의 운영자 설정 (S4-12): 백엔드가 시작하며 자리 정책을 적용하고, 새 DB면 처음 보유자를 앉힌다 — 시작 복구·첫 턴보다 먼저라 reload를 기다리지 않는다
  const startConfig = readServerConfig(configPath);
  const seat = startConfig.ok && startConfig.config.seat ? startConfig.config.seat : undefined;
  // 메인 에이전트 작업 폴더 (리드 결정 S5-20): --workspace-root > server.json workspaceRoot > ~/wook-workspace, 그 아래 main. 시작할 때만 정하고, 절대 경로가 아니거나
  // 데이터 폴더와 겹치면 잠금·저장소를 만들기 전에 그만둔다. 등록된 프로젝트와 겹치는지는 저장소를 연 뒤 백엔드가 본다(겹치면 같은 실패 길로 1)
  const workspace = chooseWorkspaceRoot(opts.workspaceRoot ?? null, startConfig.ok ? startConfig.config.workspaceRoot : null);
  const workspaceBad = workspaceProblem(workspace, dataDir);
  if (workspaceBad) return fail(workspaceBad);
  const workspaceRoot = resolve(workspace.root);
  // 화면 조작 끄기 (리드 결정 S6-11): server.json screen.enabled — 시작할 때만 읽는다. false면 화면 도우미를 띄우지 않고 화면 도구는 unavailable이다
  const screenEnabled = startConfig.ok ? startConfig.config.screen.enabled : null;

  const acquired = await acquireInstanceLock({ dataDir, kind: 'server' });
  if (!acquired.ok) return fail(acquired.message);
  lock = acquired;
  if (cancelled) return fail(cancelMessage());

  try {
    backend = await createBackend({
      dataDir,
      appRoot,
      // 서버는 늘 패키징으로 보고 개발 모드 로그인은 늘 끈다 — 누가 부르는지는 기기 세션으로 정한다 (S3-2). 운영자 시험 세션은 실제 기기 세션이다 (S3-4)
      isPackaged: true,
      allowDevLogin: false,
      mode: 'server',
      appVersion: version,
      nodeExecPath: process.execPath,
      nodeExecEnv: {},
      shell: createHeadlessShell(),
      // 데이터의 주인 확인 (S2-15): 복사본이나 잠금 파일이 지워진 데이터 폴더로 살아 있는 욱채의 CLI를 복구가 끊지 않게
      instance: { ...acquired.record, dataDir },
      ...(seat ? { seat } : {}),
      workspaceRoot,
      screen: { enabled: screenEnabled },
    });
  } catch (error) {
    // 살아 있는 다른 욱채의 데이터면 그 글을 그대로 (복구를 돌리지 않았고 아무것도 바꾸지 않았다)
    if (isDataOwnerRefusal(error)) return fail(error.message);
    return fail(`프로그램 핵심 기능(백엔드)을 시작하지 못했습니다 — ${(error as Error)?.message ?? String(error)}`, error);
  }
  const be = backend;
  if (cancelled) return fail(cancelMessage());

  // 운영자 설정 (server.json·--owner-email, S3-8·S3-6): 파일 값이 DB 값과 다르면 덮어쓰고 활동 기록에 남긴다. 파일이 틀리면 시작하지 않는다
  const operatorConfig = createOperatorConfig({
    path: configPath,
    ownerEmailFlag: opts.ownerEmail ?? null,
    // 공개 주소·받는 Tailscale 사용자는 HTTP가 이 설정에서 요청마다 읽는다 (S3-7)
    publicOriginFlag: opts.publicOrigin ?? null,
    // 작업 폴더 위치는 시작할 때만 정한다 — config show가 보이고, reload는 다시 시작해야 바뀐다고 말한다 (S5-20)
    workspace: { ...workspace, root: workspaceRoot },
    // 화면 조작은 시작할 때만 켜고 끈다 — reload는 다시 시작해야 바뀐다고 말한다 (S6-11)
    screenEnabledAtStart: screenEnabled,
    operator: be.operator,
    logger,
  });
  try {
    operatorConfig.reload();
  } catch (error) {
    return fail(`운영자 설정을 적용하지 못했습니다 — ${(error as Error)?.message ?? String(error)}`);
  }

  let running: RunningServer;
  try {
    running = await startServer({
      backend: be,
      dataDir,
      bind: opts.bind,
      port: opts.port,
      webDir: opts.webDir,
      allowTestSession: opts.allowTestSession,
      operatorConfig,
      logger,
      version,
      onShutdownRequest: () => void quit?.request({ confirm: false, reason: '관리 채널 shutdown' }),
    });
  } catch (error) {
    return fail((error as Error)?.message ?? String(error), error);
  }
  server = running;
  if (cancelled) return fail(cancelMessage());
  clearInterval(startupHold);

  const setupFile = join(dataDir, SETUP_CODE_FILE);
  const removeSetupFile = (): void => {
    try {
      unlinkSync(setupFile);
    } catch {
      // 이미 없다
    }
  };
  // 하루 1회 자동 백업 — 데스크톱과 같은 설정 (S3-8, S2-18)
  const backups = startServerBackups({ backend: be, dataDir, logger });
  quit = createQuitFlow({
    hasActiveWork: () => be.hasActiveWork(),
    confirm: async () => true,
    beforeShutdown: () => running.beginShutdown(),
    shutdown: async () => {
      backups.stop();
      await be.shutdown();
    },
    cleanup: () => running.closeNow(),
    exit: (code) => {
      // 설정 코드는 이 실행의 메모리에만 있다 — 남은 파일은 다음 시작에 쓸모없다
      removeSetupFile();
      lock?.release();
      logger.info(`욱채 서버 종료 (코드 ${code})`);
      logger.close();
      io.exit(code);
    },
    logger,
  });

  // 서버 콘솔 창의 제목 (리드 결정 S6-8 '막는 창'): 화면 도우미가 이 제목의 창을 막는다 — 메인 에이전트가 화면 조작으로 서버 창에 키를 보내거나(Ctrl+C는
  // 서버를 끝낸다) 닫지 못하게. Windows에서 process.title은 그 콘솔 창의 제목이 된다. 정하지 못해도 시작은 이어 간다
  try {
    process.title = serverWindowTitle(process.pid);
  } catch (error) {
    logger.warn('서버 콘솔 창의 제목을 정하지 못했습니다 — 화면 조작이 이 창을 제목으로 가려내지 못합니다', error);
  }
  // 화면 조작의 마지막으로 안 상태 (S6-11) — 사전 점검(--probe)은 백엔드가 시작 뒤 한 번 하고 backend.log에 남긴다. 운영자는 wook-server status로 다시 본다
  const screen = be.operator.status().screen;
  if (screen) logger.info(`화면 조작: ${screen.state} — ${screen.detail}`);
  // 같은 포트의 두 루프백을 다 잡았다는 것도 준비 줄에 (S2-14)
  const listening = `${running.addresses.join('과 ')}에서 받음`;
  logger.info(`준비 완료: ${running.url} (${listening}) 실행 ID ${running.runId}`);
  await io.out(`욱채 서버 준비 완료: 주소 ${running.url} (${listening}) · 실행 ID ${running.runId} · 데이터 폴더 ${dataDir}\n`);

  // 대표 이메일이 정해지지 않았으면 설정 코드 (S3-6): 서버 콘솔과 setup-code.txt(그 사용자만)에만 낸다 — 기록에는 코드 없이
  const setup = be.operator.issueSetupCode();
  if (!setup) {
    removeSetupFile();
    return null;
  }
  issuedCodes.add(setup.code);
  const until = new Date(setup.expiresAt).toLocaleString('ko-KR');
  try {
    writePrivateFile(
      setupFile,
      [
        '욱채 서버 대표 이메일 설정 코드',
        `코드: ${showSetupCode(setup.code)}`,
        `끝나는 때: ${until} (1시간, 한 번만)`,
        '웹 화면의 서버 설정에서 이 코드와 대표 구글 계정의 이메일을 넣으세요. 대표 이메일이 정해지면 이 파일은 지워집니다.',
        '서버 PC의 운영자는 코드 없이 wook-server config owner-email <이메일>로 정할 수도 있습니다.',
        '',
      ].join('\n'),
      '설정 코드 파일',
      logger,
    );
  } catch (error) {
    logger.warn('설정 코드 파일을 쓰지 못했습니다 (콘솔의 코드를 쓰세요)', error);
  }
  logger.info(`대표 이메일이 정해지지 않아 설정 코드를 냈습니다 (${SETUP_CODE_FILE}, 1시간, 한 번만)`);
  await io.out(
    `대표 이메일이 아직 정해지지 않았습니다. 설정 코드 ${showSetupCode(setup.code)} (${until}까지, 한 번만 — ${setupFile}에도 적었습니다)를 웹 화면의 서버 설정에 대표 이메일과 함께 넣거나, 운영자가 wook-server config owner-email <이메일>로 정하세요.\n`,
  );
  return null;
}
