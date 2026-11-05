/**
 * Electron 진입점 (껍데기). 업무 로직은 모두 Backend가 하고, 여기서는 창·트레이·전역 단축키·절전 방지·
 * OS 알림·백업 예약·IPC·실행 잠금만 연결한다 (ARCHITECTURE 3·4·16장, 실행 잠금은 SERVER_DESIGN 3.3).
 */
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { app, dialog, globalShortcut, Menu, powerMonitor, type MenuItemConstructorOptions, type MessageBoxOptions } from 'electron';
import { createBackend } from './backend/createBackend';
import { acquireInstanceLock, type HeldInstanceLock, type InstanceLockRefusal, type LockRecord } from './backend/instanceLock';
import { isDataOwnerRefusal } from './orchestrator/dataOwner';
import type { Backend, BackendDeps } from './backend/types';
import { resolveRendererTarget } from './shell/appUrl';
import { createBackupScheduler, type BackupScheduler } from './shell/backupScheduler';
import { createEmergencyTrigger } from './shell/emergency';
import { forwardTopics, registerInvokeHandler, sendTopic } from './shell/ipc';
import { createFileLogger, formatDetail, type FileLogger, type Logger } from './shell/logger';
import { createOsNotifier } from './shell/notifications';
import { createPowerGuard, type PowerGuard } from './shell/power';
import { createQuitFlow, QUIT_CONFIRM_BUTTONS, QUIT_CONFIRM_MESSAGE, type QuitFlow } from './shell/quit';
import { createShellServices } from './shell/services';
import { createEmergencyShortcut, type EmergencyShortcut } from './shell/shortcuts';
import { createTray, type TrayController } from './shell/tray';
import { createMainWindowController, type MainWindowController } from './shell/window';
import { defaultWorkspaceRoot } from './orchestrator/mainWork';

const APP_NAME = '욱채';
const DATA_DIR_NAME = 'wookagent';
/** 설치 패키지의 appId와 같아야 Windows 알림이 앱 이름으로 묶인다 */
const APP_USER_MODEL_ID = 'com.wook.wookagent';
/** Backend 계약에 설정 변경 알림이 없어 절전 방지·단축키 설정을 이 주기로 맞춘다 */
const SETTINGS_SYNC_MS = 30_000;

interface Runtime {
  windowCtl: MainWindowController | null;
  backend: Backend | null;
  tray: TrayController | null;
  shortcut: EmergencyShortcut | null;
  power: PowerGuard | null;
  backup: BackupScheduler | null;
  quit: QuitFlow | null;
  settingsTimer: ReturnType<typeof setInterval> | null;
  disposers: (() => void)[];
  /** OS 종료 중이면 종료 확인 창을 띄우지 않는다 */
  systemShutdown: boolean;
  /** 실행 잠금 (SERVER_DESIGN 3.3, S2-6) — 끝낼 때 놓는다 */
  lock: HeldInstanceLock | null;
}

/** userData는 ready 전에, 그리고 단일 실행 잠금(사용자 데이터 폴더 기준)보다 먼저 정해야 한다 */
function prepareDataDir(): string | null {
  try {
    app.setName(APP_NAME);
    // 개발·검증용: 패키징 안 된 실행에서만 WOOK_DATA_DIR로 데이터 폴더를 바꿀 수 있다 (실사용 데이터와 분리)
    const override = app.isPackaged ? undefined : process.env['WOOK_DATA_DIR'];
    const dataDir = override ? resolve(override) : join(app.getPath('appData'), DATA_DIR_NAME);
    mkdirSync(dataDir, { recursive: true });
    app.setPath('userData', dataDir);
    // Chromium 캐시·저장소는 하위 폴더로 분리해 앱 데이터(DB·보고서 등)와 섞이지 않게
    const sessionDir = join(dataDir, 'chromium');
    mkdirSync(sessionDir, { recursive: true });
    app.setPath('sessionData', sessionDir);
    app.enableSandbox();
    return dataDir;
  } catch (error) {
    dialog.showErrorBox('욱채를 시작하지 못했습니다', `앱 데이터 폴더를 준비하지 못했습니다.\n\n${formatDetail(error)}`);
    app.exit(1);
    return null;
  }
}

function buildAppMenu(): Menu | null {
  if (process.platform !== 'darwin') return null;
  // macOS는 메뉴가 없으면 복사·붙여넣기 단축키가 동작하지 않는다
  const template: MenuItemConstructorOptions[] = [{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }];
  return Menu.buildFromTemplate(template);
}

async function confirmQuit(windowCtl: MainWindowController): Promise<boolean> {
  const options: MessageBoxOptions = {
    type: 'question',
    title: '욱채 종료',
    message: QUIT_CONFIRM_MESSAGE,
    detail: '실행 중인 AI 작업을 멈추고 지금까지의 상태를 저장한 뒤 종료합니다.',
    buttons: [...QUIT_CONFIRM_BUTTONS],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  };
  // 숨긴·최소화한 창을 부모로 쓰면 확인 창이 보이지 않을 수 있다
  const win = windowCtl.getWindow();
  const result =
    win && win.isVisible() && !win.isMinimized() ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
  return result.response === 0;
}

function cleanup(rt: Runtime, logger: Logger): void {
  const step = (label: string, fn: () => void): void => {
    try {
      fn();
    } catch (error) {
      logger.error(`정리 실패: ${label}`, error);
    }
  };
  if (rt.settingsTimer) clearInterval(rt.settingsTimer);
  rt.settingsTimer = null;
  step('자동 백업 예약', () => rt.backup?.stop());
  step('절전 방지', () => rt.power?.dispose());
  step('긴급 정지 단축키', () => rt.shortcut?.unregister());
  step('전역 단축키', () => globalShortcut.unregisterAll());
  for (const dispose of rt.disposers.splice(0)) step('IPC 연결', dispose);
  step('트레이', () => rt.tray?.destroy());
}

function fatal(rt: Runtime, logger: FileLogger, title: string, error: unknown): void {
  logger.error(title, error);
  const reason = error instanceof Error ? error.message : formatDetail(error);
  dialog.showErrorBox('욱채를 시작하지 못했습니다', `${title}\n\n${reason}\n\n자세한 기록: ${logger.filePath}`);
  cleanup(rt, logger);
  rt.lock?.release();
  logger.close();
  app.exit(1);
}

/** 실행 잠금을 잡지 못함 (S2-6): 같은 데이터 폴더를 다른 욱채(서버 등)가 쓰는 중이다 — 백엔드·창을 만들지 않고 끝낸다 */
function lockRefused(logger: FileLogger, refusal: InstanceLockRefusal): void {
  logger.warn(`실행 잠금을 잡지 못해 시작하지 않습니다: ${refusal.message}`);
  const hint =
    refusal.reason === 'held'
      ? '같은 데이터 폴더로는 욱채를 하나만 실행할 수 있습니다. 실행 중인 욱채를 먼저 끝낸 뒤 다시 시작해 주세요.'
      : `자세한 기록: ${logger.filePath}`;
  dialog.showErrorBox('욱채를 시작하지 못했습니다', `${refusal.message}.\n\n${hint}`);
  logger.close();
  app.exit(1);
}

async function boot(rt: Runtime, logger: FileLogger, dataDir: string, lockRecord: LockRecord): Promise<void> {
  Menu.setApplicationMenu(buildAppMenu());
  const focusWindow = (): void => rt.windowCtl?.show();
  const notifier = createOsNotifier({ focusWindow, logger });

  const windowCtl = createMainWindowController({
    preloadPath: join(__dirname, '../preload/index.js'),
    target: resolveRendererTarget({
      isPackaged: app.isPackaged,
      devUrl: process.env['ELECTRON_RENDERER_URL'],
      rendererFile: join(__dirname, '../renderer/index.html'),
    }),
    isDev: !app.isPackaged,
    logger,
    shellStateFile: join(dataDir, 'shell-state.json'),
    notify: (n) => notifier.show(n),
    onSessionEnd: () => {
      rt.systemShutdown = true;
      void rt.quit?.request({ confirm: false, reason: 'session-end' });
    },
  });
  rt.windowCtl = windowCtl;

  const deps: BackendDeps = {
    dataDir,
    appRoot: app.isPackaged ? process.resourcesPath : app.getAppPath(),
    isPackaged: app.isPackaged,
    // 개발 모드 로그인은 예전처럼 개발 실행에서만 (S2-2 — 서버는 --allow-test-session으로 따로 정한다)
    allowDevLogin: !app.isPackaged,
    // 데스크톱은 예전 로그인 그대로 — kv 대표 세션 하나, 구글 루프백 로그인 (S3-2)
    mode: 'desktop',
    // 데이터의 주인 확인 (S2-15): 살아 있는 다른 욱채의 데이터(복사본·잠금 파일이 지워짐)면 복구 전에 멈춘다
    instance: { ...lockRecord, dataDir },
    appVersion: app.getVersion(),
    nodeExecPath: process.execPath,
    nodeExecEnv: { ELECTRON_RUN_AS_NODE: '1' },
    shell: createShellServices({ getWindow: () => windowCtl.getWindow(), focusWindow, notifier, logger }),
    // 메인 에이전트 작업 폴더는 데이터 폴더 밖 ~/wook-workspace/main (SERVER_DESIGN 3.7, 리드 결정 S5-20)
    workspaceRoot: defaultWorkspaceRoot(),
  };
  const backendPromise = createBackend(deps);
  // 백엔드 준비(DB·복구) 전에 화면이 보낸 요청은 준비될 때까지 기다리도록 처리기를 먼저 건다
  rt.disposers.push(registerInvokeHandler({ backend: backendPromise, isTrustedSender: (event) => windowCtl.isTrustedSender(event), logger }));
  windowCtl.create({ show: true });

  let backend: Backend;
  try {
    backend = await backendPromise;
  } catch (error) {
    // 살아 있는 다른 욱채의 데이터 (S2-15) — 복구를 돌리지 않았고 아무것도 바꾸지 않았다. 그 글을 그대로 알린다
    if (isDataOwnerRefusal(error)) fatal(rt, logger, '실행 중인 다른 욱채의 데이터라 시작하지 않습니다.', error);
    else fatal(rt, logger, '프로그램 핵심 기능(백엔드)을 시작하지 못했습니다.', error);
    return;
  }
  rt.backend = backend;
  rt.disposers.push(forwardTopics({ backend, getWindow: () => windowCtl.getWindow(), logger }));

  const emergency = createEmergencyTrigger({
    backend,
    pushEmergency: (summary) => {
      sendTopic(windowCtl.getWindow(), 'emergency', summary, logger);
    },
    notify: (n) => notifier.show(n),
    logger,
  });

  rt.quit = createQuitFlow({
    hasActiveWork: () => backend.hasActiveWork(),
    confirm: () => confirmQuit(windowCtl),
    beforeShutdown: () => {
      windowCtl.allowClose();
      windowCtl.getWindow()?.hide();
      rt.tray?.setBusyText('종료 중…');
    },
    shutdown: () => backend.shutdown(),
    cleanup: () => cleanup(rt, logger),
    exit: (code) => {
      rt.lock?.release();
      logger.info(`욱채 종료 (코드 ${code})`);
      logger.close();
      app.exit(code);
    },
    logger,
  });

  // 아래 기능 하나가 실패해도 작업(백엔드)과 창은 계속 돌아가야 한다
  const optional = <T>(label: string, start: () => T): T | null => {
    try {
      return start();
    } catch (error) {
      logger.error(`시작하지 못했습니다: ${label} (나머지 기능은 계속 동작)`, error);
      return null;
    }
  };
  rt.tray = optional('트레이', () =>
    createTray({
      backend,
      onOpenWindow: focusWindow,
      onEmergency: () => void emergency.trigger('tray'),
      onQuit: () => void rt.quit?.request({ confirm: true, reason: 'tray' }),
      logger,
    }),
  );
  if (!rt.tray) {
    notifier.show({
      level: 'urgent',
      title: '트레이 아이콘을 만들지 못했습니다',
      body: '창을 닫으면 프로그램을 다시 실행해 창을 열어 주세요. 작업은 계속 진행됩니다.',
    });
  }
  rt.shortcut = optional('긴급 정지 단축키', () => {
    const shortcut = createEmergencyShortcut({
      getAccelerator: () => backend.emergencyShortcut(),
      onTrigger: () => void emergency.trigger('shortcut'),
      notify: (n) => notifier.show(n),
      logger,
    });
    shortcut.register();
    return shortcut;
  });
  rt.power = optional('절전 방지', () => createPowerGuard({ backend, logger }));
  rt.backup = optional('자동 백업 예약', () => {
    const backup = createBackupScheduler({ backend, stateFile: join(dataDir, 'backup-state.json'), logger });
    backup.start();
    return backup;
  });
  rt.settingsTimer = setInterval(() => {
    rt.power?.update();
    rt.shortcut?.syncWithSettings();
  }, SETTINGS_SYNC_MS);

  powerMonitor.on('shutdown', () => {
    rt.systemShutdown = true;
    void rt.quit?.request({ confirm: false, reason: 'os-shutdown' });
  });
  logger.info('껍데기 준비 완료');
}

function main(): void {
  const dataDir = prepareDataDir();
  if (!dataDir) return;
  if (!app.requestSingleInstanceLock()) {
    // 이미 실행 중 — 첫 인스턴스가 'second-instance'로 창을 띄운다
    app.quit();
    return;
  }

  const logger = createFileLogger({ dir: join(dataDir, 'logs'), mirrorToConsole: !app.isPackaged });
  logger.info(
    `욱채 시작 v${app.getVersion()} (Electron ${process.versions.electron}, ${process.platform} ${process.arch}, 패키징=${app.isPackaged}) 데이터 폴더: ${dataDir}`,
  );
  process.on('uncaughtException', (error) => logger.error('처리되지 않은 예외 (main)', error));
  process.on('unhandledRejection', (reason) => logger.error('처리되지 않은 Promise 거부 (main)', reason));
  if (process.platform === 'win32') app.setAppUserModelId(app.isPackaged ? APP_USER_MODEL_ID : process.execPath);

  const rt: Runtime = {
    windowCtl: null,
    backend: null,
    tray: null,
    shortcut: null,
    power: null,
    backup: null,
    quit: null,
    settingsTimer: null,
    disposers: [],
    systemShutdown: false,
    lock: null,
  };
  // 실행 잠금 (SERVER_DESIGN 3.3, S2-6): 같은 데이터 폴더를 서버가 쓰고 있으면 백엔드를 만들기 전에 멈춘다 — 두 번째 프로세스의 재시작 복구가
  // 첫 프로세스의 CLI를 끊지 않게. Electron 단일 실행 잠금 뒤, 창이 준비되는 동안 잡는다(생성 시각 조회가 1초쯤 걸린다). 잡기는 던지지 않는다
  const lockPromise = acquireInstanceLock({ dataDir, kind: 'desktop' });

  app.on('second-instance', () => rt.windowCtl?.show());
  // macOS 독 아이콘 클릭
  app.on('activate', () => rt.windowCtl?.show());
  // 트레이 상주: 창이 모두 닫혀도 종료하지 않는다 (ENV-09). 이 처리기가 없으면 Electron이 바로 종료한다
  app.on('window-all-closed', () => undefined);
  app.on('before-quit', (event) => {
    // 준비 전에는 정리할 것이 없어 그대로 끝낸다(실행 잠금 파일이 남아도 다음 시작이 죽은 pid로 보고 넘겨받는다). 준비 후에는 완전 종료 절차를 탄다 (macOS Cmd+Q 등)
    if (!rt.quit) return;
    event.preventDefault();
    void rt.quit.request({ confirm: !rt.systemShutdown, reason: 'before-quit' });
  });

  app
    .whenReady()
    .then(async () => {
      const lock = await lockPromise;
      if (!lock.ok) return lockRefused(logger, lock);
      rt.lock = lock;
      await boot(rt, logger, dataDir, lock.record);
    })
    .catch((error: unknown) => fatal(rt, logger, '프로그램을 준비하는 중 오류가 발생했습니다.', error));
}

main();
