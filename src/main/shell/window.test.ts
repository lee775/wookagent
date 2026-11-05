import { mkdtempSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';
import type { RendererTarget } from './appUrl';
import type { Logger } from './logger';

type Handler = (...args: unknown[]) => unknown;

const electron = vi.hoisted(() => {
  class Emitter {
    private handlers = new Map<string, Handler[]>();
    on(event: string, cb: Handler) {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), cb]);
      return this;
    }
    once(event: string, cb: Handler) {
      const wrapped: Handler = (...args) => {
        this.handlers.set(event, (this.handlers.get(event) ?? []).filter((h) => h !== wrapped));
        return cb(...args);
      };
      return this.on(event, wrapped);
    }
    emit(event: string, ...args: unknown[]) {
      for (const cb of [...(this.handlers.get(event) ?? [])]) cb(...args);
    }
  }
  class FakeWebContents extends Emitter {
    openHandler: ((d: { url: string }) => { action: string }) | null = null;
    permissionRequest: ((wc: unknown, permission: string, cb: (ok: boolean) => void) => void) | null = null;
    permissionCheck: ((wc: unknown, permission: string) => boolean) | null = null;
    session = {
      setPermissionRequestHandler: (fn: FakeWebContents['permissionRequest']) => {
        this.permissionRequest = fn;
      },
      setPermissionCheckHandler: (fn: FakeWebContents['permissionCheck']) => {
        this.permissionCheck = fn;
      },
    };
    setWindowOpenHandler(fn: FakeWebContents['openHandler']) {
      this.openHandler = fn;
    }
    toggleDevTools = vi.fn();
  }
  const windows: FakeWindow[] = [];
  class FakeWindow extends Emitter {
    webContents = new FakeWebContents();
    visible = false;
    minimized = false;
    destroyed = false;
    loadURL = vi.fn(async (_url: string) => undefined);
    loadFile = vi.fn(async (_path: string) => undefined);
    show = vi.fn(() => {
      this.visible = true;
      this.emit('show');
    });
    hide = vi.fn(() => {
      this.visible = false;
    });
    focus = vi.fn();
    restore = vi.fn(() => {
      this.minimized = false;
    });
    constructor(public options: Record<string, unknown>) {
      super();
      windows.push(this);
    }
    isVisible() {
      return this.visible;
    }
    isMinimized() {
      return this.minimized;
    }
    isDestroyed() {
      return this.destroyed;
    }
    /** 실제 창이 닫히는 흐름 흉내: close(막을 수 있음) → closed */
    tryClose() {
      const event = { defaultPrevented: false, preventDefault: () => (event.defaultPrevented = true) };
      this.emit('close', event);
      if (!event.defaultPrevented) {
        this.destroyed = true;
        this.emit('closed');
      }
      return event;
    }
  }
  return {
    windows,
    BrowserWindow: FakeWindow,
    screen: { getPrimaryDisplay: vi.fn(() => ({ workAreaSize: { width: 1920, height: 1040 } })) },
    shell: { openExternal: vi.fn(async (_url: string) => undefined) },
  };
});
vi.mock('electron', () => ({ BrowserWindow: electron.BrowserWindow, screen: electron.screen, shell: electron.shell }));

import { createMainWindowController, TRAY_HINT_TEXT, type MainWindowDeps } from './window';

const DEV: RendererTarget = { kind: 'url', url: 'http://localhost:5173/', origin: 'http://localhost:5173' };

let dir: string;
beforeEach(() => {
  vi.clearAllMocks();
  electron.windows.length = 0;
  dir = mkdtempSync(join(tmpdir(), 'wook-test-창 상태-'));
});
// rmSync는 Node 24.13(Windows)에서 한글 경로면 테스트 프로세스가 죽어 비동기 rm을 쓴다
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function setup(over: Partial<MainWindowDeps> = {}) {
  const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const notify = vi.fn();
  const onSessionEnd = vi.fn();
  const deps: MainWindowDeps = {
    preloadPath: join(dir, 'preload', 'index.js'),
    target: DEV,
    isDev: false,
    logger,
    shellStateFile: join(dir, 'shell-state.json'),
    notify,
    onSessionEnd,
    ...over,
  };
  const ctl = createMainWindowController(deps);
  return { ctl, notify, logger, onSessionEnd, deps };
}

const latest = () => electron.windows.at(-1)!;

describe('메인 창', () => {
  it('정해진 크기·제목·배경색과 격리된 webPreferences로 만든다', () => {
    const { ctl, deps } = setup();
    ctl.create({ show: true });
    expect(latest().options).toEqual({
      width: 1440,
      height: 900,
      minWidth: 1100,
      minHeight: 700,
      show: false,
      title: '욱채',
      backgroundColor: '#F4F2EC',
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
    expect(latest().loadURL).toHaveBeenCalledWith('http://localhost:5173/');
  });

  it('작은 화면에서는 작업 영역에 맞춘다', () => {
    electron.screen.getPrimaryDisplay.mockReturnValueOnce({ workAreaSize: { width: 1280, height: 680 } });
    setup().ctl.create({ show: true });
    expect(latest().options).toMatchObject({ width: 1280, height: 680, minWidth: 1100, minHeight: 680 });
  });

  it('파일 화면은 loadFile로 불러온다', () => {
    const file = join(dir, '앱 폴더', 'renderer', 'index.html');
    setup({ target: { kind: 'file', path: file } }).ctl.create({ show: true });
    expect(latest().loadFile).toHaveBeenCalledWith(file);
  });

  it('ready-to-show에서 보이고, show:false로 만들면 숨긴 채로 둔다', () => {
    const { ctl } = setup();
    ctl.create({ show: false });
    latest().emit('ready-to-show');
    expect(latest().show).not.toHaveBeenCalled();
    ctl.show();
    expect(latest().show).toHaveBeenCalledTimes(1);
    expect(latest().focus).toHaveBeenCalled();
  });

  it('닫기 버튼은 트레이로 숨기고, 처음 한 번만 OS 알림으로 안내한다 (재실행 후에도 한 번)', () => {
    const first = setup();
    first.ctl.create({ show: true });
    const w = latest();
    expect(w.tryClose().defaultPrevented).toBe(true);
    expect(w.hide).toHaveBeenCalled();
    expect(w.isDestroyed()).toBe(false);
    expect(first.notify).toHaveBeenCalledWith({ level: 'normal', title: '욱채', body: TRAY_HINT_TEXT });
    w.tryClose();
    expect(first.notify).toHaveBeenCalledTimes(1);
    expect(JSON.parse(readFileSync(join(dir, 'shell-state.json'), 'utf8'))).toEqual({ trayHintShown: true });

    const second = setup();
    second.ctl.create({ show: true });
    latest().tryClose();
    expect(second.notify).not.toHaveBeenCalled();
  });

  it('완전 종료 중(allowClose)에는 닫기를 막지 않는다', () => {
    const { ctl } = setup();
    ctl.create({ show: true });
    ctl.allowClose();
    expect(latest().tryClose().defaultPrevented).toBe(false);
    expect(ctl.getWindow()).toBeNull();
  });

  it('닫힌 뒤 show()하면 창을 다시 만든다', () => {
    const { ctl } = setup();
    ctl.create({ show: true });
    ctl.allowClose();
    latest().tryClose();
    ctl.show();
    expect(electron.windows).toHaveLength(2);
    expect(latest().visible).toBe(true);
  });

  it('최소화된 창은 복원해서 앞으로', () => {
    const { ctl } = setup();
    ctl.create({ show: true });
    latest().visible = true;
    latest().minimized = true;
    ctl.show();
    expect(latest().restore).toHaveBeenCalled();
    expect(latest().focus).toHaveBeenCalled();
  });

  it('앱 밖으로의 이동은 막고, https는 기본 브라우저로 연다', () => {
    const { ctl } = setup();
    ctl.create({ show: true });
    const nav = (url: string) => {
      const ev = { url, prevented: false, preventDefault: () => (ev.prevented = true) };
      latest().webContents.emit('will-navigate', ev);
      return ev.prevented;
    };
    expect(nav('http://localhost:5173/#/settings')).toBe(false);
    expect(nav('https://github.com/x')).toBe(true);
    expect(electron.shell.openExternal).toHaveBeenCalledWith('https://github.com/x');
    expect(nav('file:///C:/Users/dropped.pdf')).toBe(true);
    expect(nav('http://example.com/')).toBe(true);
    expect(electron.shell.openExternal).toHaveBeenCalledTimes(1);
  });

  it('새 창은 항상 거부하고 https만 기본 브라우저로 연다', () => {
    const { ctl } = setup();
    ctl.create({ show: true });
    const open = latest().webContents.openHandler!;
    expect(open({ url: 'https://example.com/doc' })).toEqual({ action: 'deny' });
    expect(open({ url: 'http://example.com/' })).toEqual({ action: 'deny' });
    expect(open({ url: 'javascript:alert(1)' })).toEqual({ action: 'deny' });
    expect(electron.shell.openExternal.mock.calls).toEqual([['https://example.com/doc']]);
  });

  it('브라우저 권한은 클립보드·전체 화면만 허용한다', () => {
    const { ctl, logger } = setup();
    ctl.create({ show: true });
    const wc = latest().webContents;
    const answer = (permission: string) => {
      let result: boolean | null = null;
      wc.permissionRequest!(wc, permission, (ok) => (result = ok));
      return result;
    };
    expect(answer('clipboard-sanitized-write')).toBe(true);
    expect(answer('media')).toBe(false);
    expect(answer('notifications')).toBe(false);
    expect(wc.permissionCheck!(wc, 'geolocation')).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('media'));
  });

  it('화면 프로세스가 죽으면 다시 불러오고, 1분에 3번째면 멈추고 긴급 알림', () => {
    const { ctl, notify } = setup();
    ctl.create({ show: true });
    const w = latest();
    const gone = (reason: string) => w.webContents.emit('render-process-gone', {}, { reason, exitCode: 1 });
    gone('clean-exit');
    expect(w.loadURL).toHaveBeenCalledTimes(1);
    gone('crashed');
    gone('oom');
    expect(w.loadURL).toHaveBeenCalledTimes(3);
    gone('crashed');
    expect(w.loadURL).toHaveBeenCalledTimes(3);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ level: 'urgent' }));
  });

  it('Windows 세션 종료를 알린다', () => {
    const { ctl, onSessionEnd } = setup();
    ctl.create({ show: true });
    latest().emit('session-end', {});
    expect(onSessionEnd).toHaveBeenCalledTimes(1);
  });

  it('개발 모드에서만 F12로 개발자 도구를 연다', () => {
    const dev = setup({ isDev: true });
    dev.ctl.create({ show: true });
    const ev = { preventDefault: vi.fn() };
    latest().webContents.emit('before-input-event', ev, { type: 'keyDown', key: 'F12', control: false, shift: false });
    expect(latest().webContents.toggleDevTools).toHaveBeenCalledTimes(1);

    const prod = setup({ isDev: false });
    prod.ctl.create({ show: true });
    latest().webContents.emit('before-input-event', ev, { type: 'keyDown', key: 'F12', control: false, shift: false });
    expect(latest().webContents.toggleDevTools).not.toHaveBeenCalled();
  });

  it('IPC 발신자: 메인 창 최상위 프레임 + 앱 주소만 신뢰', () => {
    const { ctl } = setup();
    ctl.create({ show: true });
    const sender = latest().webContents;
    const ev = (frame: unknown, s: unknown = sender) => ({ sender: s, senderFrame: frame }) as unknown as IpcMainInvokeEvent;
    expect(ctl.isTrustedSender(ev({ parent: null, url: 'http://localhost:5173/' }))).toBe(true);
    expect(ctl.isTrustedSender(ev({ parent: null, url: 'https://evil.example/' }))).toBe(false);
    expect(ctl.isTrustedSender(ev({ parent: {}, url: 'http://localhost:5173/' }))).toBe(false);
    expect(ctl.isTrustedSender(ev({ parent: null, url: 'http://localhost:5173/' }, {}))).toBe(false);
  });
});
