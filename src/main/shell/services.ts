/** 백엔드가 껍데기에게 빌리는 OS 기능 (ShellServices) */
import { existsSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute } from 'node:path';
import { dialog, shell, type BrowserWindow, type OpenDialogOptions } from 'electron';
import { BackendError, type ShellServices } from '../backend/types';
import type { Logger } from './logger';
import type { OsNotifier } from './notifications';

// 열면 바로 실행되는 형식은 열지 않고 폴더에서 위치만 보여 준다 (에이전트가 만든 파일을 실수로 실행하지 않게)
const EXECUTABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.exe', '.com', '.bat', '.cmd', '.ps1', '.psm1', '.psd1', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh',
  '.msi', '.msp', '.scr', '.hta', '.cpl', '.msc', '.jar', '.lnk', '.reg', '.pif', '.url', '.appref-ms',
  '.application', '.gadget', '.inf', '.scf', '.sh', '.command', '.app', '.pkg', '.dmg', '.scpt', '.workflow',
  '.terminal', '.tool',
]);

export function isExecutableLike(path: string): boolean {
  return EXECUTABLE_EXTENSIONS.has(extname(path).toLowerCase());
}

export function createShellServices(deps: {
  getWindow: () => BrowserWindow | null;
  focusWindow: () => void;
  notifier: OsNotifier;
  logger: Logger;
}): ShellServices {
  const { logger } = deps;
  const parentWindow = (): BrowserWindow | null => {
    const w = deps.getWindow();
    return w && !w.isDestroyed() && w.isVisible() ? w : null;
  };
  const openDialog = async (options: OpenDialogOptions): Promise<string[]> => {
    const parent = parentWindow();
    const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
    return result.canceled ? [] : result.filePaths;
  };

  return {
    async openExternal(url) {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new BackendError('invalid_url', '주소 형식이 올바르지 않습니다.');
      }
      if (parsed.protocol !== 'https:') throw new BackendError('invalid_url', 'https 주소만 열 수 있습니다.');
      try {
        await shell.openExternal(parsed.href);
      } catch (error) {
        logger.error(`외부 브라우저로 열지 못했습니다: ${parsed.origin}`, error);
        throw new BackendError('open_failed', '기본 브라우저를 열지 못했습니다.');
      }
    },

    async openPath(path) {
      if (typeof path !== 'string' || !isAbsolute(path)) throw new BackendError('invalid_path', '전체 경로만 열 수 있습니다.');
      if (!existsSync(path)) throw new BackendError('not_found', `파일이나 폴더를 찾을 수 없습니다: ${path}`);
      let isDir: boolean;
      try {
        isDir = statSync(path).isDirectory();
      } catch (error) {
        logger.error(`경로 정보를 읽지 못했습니다: ${path}`, error);
        throw new BackendError('open_failed', `열지 못했습니다: ${path}`);
      }
      if ((!isDir || process.platform === 'darwin') && isExecutableLike(path)) {
        logger.info(`실행 파일 형식이라 열지 않고 폴더에서 보여 줍니다: ${path}`);
        shell.showItemInFolder(path);
        return;
      }
      const failure = await shell.openPath(path);
      if (failure) {
        logger.error(`경로를 열지 못했습니다: ${path} (${failure})`);
        throw new BackendError('open_failed', `열지 못했습니다: ${path}`);
      }
    },

    async pickFiles() {
      const picked = await openDialog({ title: '파일 선택', properties: ['openFile', 'multiSelections'] });
      return picked.map((path) => ({ path, name: basename(path) }));
    },

    showOsNotification(n) {
      deps.notifier.show(n);
    },

    focusWindow() {
      deps.focusWindow();
    },
  };
}
