/**
 * 메인 창. 닫기 버튼은 트레이로 숨김 (ENV-09). 앱 주소 밖으로의 이동·새 창은 막는다.
 */
import { BrowserWindow, screen, shell, type IpcMainInvokeEvent, type Session } from 'electron';
import { createAppUrlMatcher, type RendererTarget } from './appUrl';
import { isTrustedIpcSender } from './ipc';
import { isRecord, readJsonFile, writeJsonFileAtomic } from './jsonFile';
import type { Logger } from './logger';

export const WINDOW_TITLE = '욱채';
export const WINDOW_BACKGROUND = '#F4F2EC';
export const TRAY_HINT_TEXT = '창을 닫아도 트레이에서 계속 실행됩니다';

/** 화면이 쓸 수 있는 브라우저 권한. 나머지(카메라·위치·알림 등)는 거부 */
const ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set(['clipboard-read', 'clipboard-sanitized-write', 'fullscreen']);

/** 화면 프로세스가 이 시간 안에 이 횟수만큼 죽으면 자동 새로고침을 멈춘다 */
const CRASH_WINDOW_MS = 60_000;
const CRASH_LIMIT = 3;

export interface MainWindowDeps {
  preloadPath: string;
  target: RendererTarget;
  isDev: boolean;
  logger: Logger;
  /** 트레이 안내를 한 번 보였는지 기억하는 파일 (<앱데이터>/shell-state.json) */
  shellStateFile: string;
  notify: (n: { level: 'urgent' | 'normal'; title: string; body: string }) => void;
  /** Windows 로그오프·종료 (막을 수 없음) */
  onSessionEnd: () => void;
}

export interface MainWindowController {
  getWindow(): BrowserWindow | null;
  /** 없으면 만들고, 최소화·숨김을 풀고 앞으로 */
  show(): void;
  create(opts: { show: boolean }): BrowserWindow;
  /** 완전 종료 중 — 닫기를 더 이상 숨김으로 바꾸지 않는다 */
  allowClose(): void;
  isAppUrl(url: string): boolean;
  isTrustedSender(event: IpcMainInvokeEvent): boolean;
}

function readTrayHintShown(file: string, logger: Logger): boolean {
  const result = readJsonFile(file);
  if (result.ok) return isRecord(result.value) && result.value['trayHintShown'] === true;
  if (!result.missing) logger.warn(`껍데기 상태 파일을 읽지 못했습니다: ${file}`, result.error);
  return false;
}

function applyPermissionPolicy(session: Session, logger: Logger): void {
  session.setPermissionRequestHandler((_contents, permission, callback) => {
    const allowed = ALLOWED_PERMISSIONS.has(permission);
    if (!allowed) logger.warn(`화면의 권한 요청을 거부했습니다: ${permission}`);
    callback(allowed);
  });
  session.setPermissionCheckHandler((_contents, permission) => ALLOWED_PERMISSIONS.has(permission));
}

export function createMainWindowController(deps: MainWindowDeps): MainWindowController {
  const { logger } = deps;
  const isAppUrl = createAppUrlMatcher(deps.target);
  let win: BrowserWindow | null = null;
  let closeAllowed = false;
  let showWhenReady = false;
  let trayHintShown = readTrayHintShown(deps.shellStateFile, logger);
  let crashTimes: number[] = [];
  let permissionsApplied = false;

  const showTrayHintOnce = (): void => {
    if (trayHintShown) return;
    trayHintShown = true;
    deps.notify({ level: 'normal', title: WINDOW_TITLE, body: TRAY_HINT_TEXT });
    try {
      const prev = readJsonFile(deps.shellStateFile);
      const base = prev.ok && isRecord(prev.value) ? prev.value : {};
      writeJsonFileAtomic(deps.shellStateFile, { ...base, trayHintShown: true });
    } catch (error) {
      logger.error('트레이 안내 표시 여부를 저장하지 못했습니다 (다음 실행 때 한 번 더 보일 수 있음)', error);
    }
  };

  const load = (w: BrowserWindow): void => {
    const loading = deps.target.kind === 'url' ? w.loadURL(deps.target.url) : w.loadFile(deps.target.path);
    loading.catch((error: unknown) => logger.error('화면을 불러오지 못했습니다', error));
  };

  // 주소의 쿼리에는 토큰이 들어 있을 수 있어 기록에는 출처(origin)만 남긴다
  const originOf = (url: string): string => {
    try {
      const parsed = new URL(url);
      return parsed.origin !== 'null' ? parsed.origin : `${parsed.protocol}…`;
    } catch {
      return '(형식 오류 주소)';
    }
  };

  const openExternalSafely = (url: string): void => {
    shell.openExternal(url).catch((error: unknown) => logger.error(`외부 브라우저로 열지 못했습니다: ${originOf(url)}`, error));
  };

  const isHttps = (url: string): boolean => {
    try {
      return new URL(url).protocol === 'https:';
    } catch {
      return false;
    }
  };

  const create = (opts: { show: boolean }): BrowserWindow => {
    if (win && !win.isDestroyed()) return win;
    const area = screen.getPrimaryDisplay().workAreaSize;
    const w = new BrowserWindow({
      width: Math.min(1440, area.width),
      height: Math.min(900, area.height),
      minWidth: Math.min(1100, area.width),
      minHeight: Math.min(700, area.height),
      show: false,
      title: WINDOW_TITLE,
      backgroundColor: WINDOW_BACKGROUND,
      autoHideMenuBar: true,
      webPreferences: {
        preload: deps.preloadPath,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        spellcheck: false,
        webviewTag: false,
      },
    });
    win = w;
    showWhenReady = opts.show;
    if (!permissionsApplied) {
      applyPermissionPolicy(w.webContents.session, logger);
      permissionsApplied = true;
    }

    w.once('ready-to-show', () => {
      if (showWhenReady && !w.isDestroyed()) w.show();
    });
    // 화면 로드가 늦거나 실패해도 대표가 창을 볼 수 있게
    const fallback = setTimeout(() => {
      if (showWhenReady && !w.isDestroyed() && !w.isVisible()) w.show();
    }, 5_000);
    fallback.unref();
    w.once('show', () => clearTimeout(fallback));

    w.on('close', (event) => {
      if (closeAllowed) return;
      event.preventDefault();
      w.hide();
      showTrayHintOnce();
    });
    w.on('closed', () => {
      clearTimeout(fallback);
      if (win === w) win = null;
    });
    w.on('session-end', () => deps.onSessionEnd());
    w.on('unresponsive', () => logger.warn('화면이 응답하지 않습니다'));
    w.on('responsive', () => logger.info('화면이 다시 응답합니다'));

    const contents = w.webContents;
    contents.on('will-navigate', (event) => {
      if (isAppUrl(event.url)) return;
      event.preventDefault();
      if (isHttps(event.url)) openExternalSafely(event.url);
      else logger.warn(`앱 밖 주소로의 이동을 막았습니다: ${originOf(event.url)}`);
    });
    contents.setWindowOpenHandler(({ url }) => {
      if (isHttps(url)) openExternalSafely(url);
      else logger.warn(`새 창 열기를 막았습니다: ${originOf(url)}`);
      return { action: 'deny' };
    });
    contents.on('will-attach-webview', (event) => {
      event.preventDefault();
      logger.warn('webview 삽입을 막았습니다');
    });
    contents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      // -3(ERR_ABORTED)은 다른 이동으로 대체된 경우라 오류가 아니다
      if (isMainFrame && code !== -3) logger.error(`화면 로드 실패 (${code} ${description}): ${originOf(url)}`);
    });
    contents.on('render-process-gone', (_event, details) => {
      logger.error(`화면 프로세스 종료: ${details.reason} (code ${details.exitCode})`);
      if (details.reason === 'clean-exit' || w.isDestroyed()) return;
      const now = Date.now();
      crashTimes = [...crashTimes.filter((t) => now - t < CRASH_WINDOW_MS), now];
      if (crashTimes.length >= CRASH_LIMIT) {
        logger.error('화면이 짧은 시간에 반복해서 종료돼 자동 새로고침을 멈췄습니다');
        deps.notify({ level: 'urgent', title: '화면이 반복해서 종료되었습니다', body: '작업은 계속 진행됩니다. 프로그램을 다시 시작해 주세요.' });
        return;
      }
      load(w);
    });
    if (deps.isDev) {
      contents.on('before-input-event', (event, input) => {
        const devtoolsKey = input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i');
        if (input.type === 'keyDown' && devtoolsKey) {
          contents.toggleDevTools();
          event.preventDefault();
        }
      });
    }

    load(w);
    return w;
  };

  return {
    getWindow: () => (win && !win.isDestroyed() ? win : null),
    create,
    show() {
      const w = win && !win.isDestroyed() ? win : create({ show: true });
      showWhenReady = true;
      if (w.isMinimized()) w.restore();
      if (!w.isVisible()) w.show();
      w.focus();
    },
    allowClose() {
      closeAllowed = true;
    },
    isAppUrl,
    isTrustedSender: (event) => isTrustedIpcSender(event, win && !win.isDestroyed() ? win : null, isAppUrl),
  };
}
