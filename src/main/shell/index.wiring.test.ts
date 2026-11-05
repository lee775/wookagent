/**
 * src/main/index.ts 연결 확인 — electron과 백엔드를 가짜로 바꿔 실제 GUI 없이 시작·IPC·트레이·단축키·종료 흐름을 돌린다.
 */
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { IPC_INVOKE_CHANNEL, IPC_TOPIC_PREFIX } from '@shared/ipc';
import type { EmergencySummary } from '@shared/views';

type Handler = (...args: unknown[]) => unknown;

const h = vi.hoisted(() => {
  const order: string[] = [];
  const state = { appData: '' };
  class Emitter {
    handlers = new Map<string, Handler[]>();
    on(event: string, cb: Handler) {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), cb]);
      return this;
    }
    once(event: string, cb: Handler) {
      const wrapped: Handler = (...args) => {
        this.handlers.set(event, (this.handlers.get(event) ?? []).filter((x) => x !== wrapped));
        return cb(...args);
      };
      return this.on(event, wrapped);
    }
    emit(event: string, ...args: unknown[]) {
      for (const cb of [...(this.handlers.get(event) ?? [])]) cb(...args);
    }
  }
  const windows: FakeWindow[] = [];
  class FakeWindow extends Emitter {
    webContents = Object.assign(new Emitter(), {
      send: vi.fn(),
      isDestroyed: () => false,
      isCrashed: () => false,
      setWindowOpenHandler: vi.fn(),
      toggleDevTools: vi.fn(),
      session: { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() },
    });
    visible = false;
    loadURL = vi.fn(async () => undefined);
    loadFile = vi.fn(async () => undefined);
    show = vi.fn(() => {
      this.visible = true;
      this.emit('show');
    });
    hide = vi.fn(() => {
      this.visible = false;
    });
    focus = vi.fn();
    restore = vi.fn();
    constructor(public options: Record<string, unknown>) {
      super();
      windows.push(this);
      order.push('BrowserWindow');
    }
    isVisible() {
      return this.visible;
    }
    isMinimized() {
      return false;
    }
    isDestroyed() {
      return false;
    }
  }
  const trays: FakeTray[] = [];
  class FakeTray extends Emitter {
    menu: { label?: string; click?: () => void }[] = [];
    tooltip = '';
    destroyed = false;
    constructor(public image: unknown) {
      super();
      trays.push(this);
      order.push('Tray');
    }
    setToolTip(t: string) {
      this.tooltip = t;
    }
    setContextMenu(m: FakeTray['menu']) {
      this.menu = m;
    }
    setImage(i: unknown) {
      this.image = i;
    }
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      this.destroyed = true;
    }
  }
  const notifications: { options: Record<string, unknown> }[] = [];
  class FakeNotification extends Emitter {
    static isSupported() {
      return true;
    }
    constructor(public options: Record<string, unknown>) {
      super();
      notifications.push(this);
    }
    show() {}
  }
  const appEvents = new Emitter();
  let readyResolve!: () => void;
  const ready = new Promise<void>((r) => (readyResolve = r));
  const app = Object.assign(appEvents, {
    isPackaged: false,
    setName: vi.fn((n: string) => void order.push(`setName:${n}`)),
    getPath: vi.fn((name: string) => (name === 'appData' ? state.appData : join(state.appData, name))),
    setPath: vi.fn((name: string) => void order.push(`setPath:${name}`)),
    enableSandbox: vi.fn(() => void order.push('enableSandbox')),
    requestSingleInstanceLock: vi.fn(() => {
      order.push('requestSingleInstanceLock');
      return true;
    }),
    quit: vi.fn(),
    exit: vi.fn((code?: number) => void order.push(`exit:${code ?? 0}`)),
    whenReady: vi.fn(() => ready),
    getVersion: () => '0.1.0',
    getAppPath: () => 'C:\\앱 루트',
    setAppUserModelId: vi.fn(),
  });
  const registeredShortcuts = new Map<string, () => void>();
  const electron = {
    app,
    BrowserWindow: FakeWindow,
    Tray: FakeTray,
    Notification: FakeNotification,
    Menu: { setApplicationMenu: vi.fn(), buildFromTemplate: vi.fn((t: unknown) => t) },
    nativeImage: {
      createFromBitmap: vi.fn(() => ({ addRepresentation: vi.fn() })),
    },
    screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }) },
    shell: { openExternal: vi.fn(async () => undefined), openPath: vi.fn(async () => ''), showItemInFolder: vi.fn() },
    dialog: { showErrorBox: vi.fn(), showMessageBox: vi.fn(async () => ({ response: 0 })), showOpenDialog: vi.fn() },
    ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
    globalShortcut: {
      register: vi.fn((acc: string, cb: () => void) => {
        registeredShortcuts.set(acc, cb);
        return true;
      }),
      unregister: vi.fn((acc: string) => void registeredShortcuts.delete(acc)),
      unregisterAll: vi.fn(() => registeredShortcuts.clear()),
      isRegistered: (acc: string) => registeredShortcuts.has(acc),
    },
    powerSaveBlocker: { start: vi.fn(() => 1), stop: vi.fn(), isStarted: vi.fn(() => true) },
    powerMonitor: new Emitter(),
  };

  const topicListeners = new Map<string, Set<(p: unknown) => void>>();
  const summary: EmergencySummary = { at: '2026-10-27T01:00:00.000Z', completed: true, stoppedTurns: [], heldTasks: [], failures: [] };
  const backend = {
    invoke: vi.fn(async () => ({ version: 1 })),
    onTopic: vi.fn((topic: string, cb: (p: unknown) => void) => {
      if (!topicListeners.has(topic)) topicListeners.set(topic, new Set());
      topicListeners.get(topic)!.add(cb);
      return () => topicListeners.get(topic)!.delete(cb);
    }),
    emergencyStop: vi.fn(async () => summary),
    getTrayStatus: () => 'normal' as const,
    onTrayStatus: vi.fn(() => () => undefined),
    hasActiveWork: vi.fn(() => false),
    onActiveWorkChange: vi.fn(() => () => undefined),
    preventSleepEnabled: () => true,
    emergencyShortcut: () => 'CommandOrControl+Alt+Shift+S',
    shutdown: vi.fn(async () => void order.push('backend.shutdown')),
    backupNow: vi.fn(async () => ({ path: 'x' })),
    backupEnabled: () => false,
  };
  const createBackend = vi.fn(async (_deps: unknown) => {
    order.push('createBackend');
    return backend;
  });
  return { order, state, electron, windows, trays, notifications, registeredShortcuts, readyResolve, backend, createBackend, topicListeners, summary };
});

vi.mock('electron', () => h.electron);
vi.mock('../backend/createBackend', () => ({ createBackend: h.createBackend }));
// 실행 잠금 (S2-6): 실제 잠금 파일을 잡되, 잡고 놓는 때를 순서에 남긴다
vi.mock('../backend/instanceLock', async (importOriginal) => {
  const real = await importOriginal<typeof import('../backend/instanceLock')>();
  return {
    ...real,
    acquireInstanceLock: async (o: Parameters<typeof real.acquireInstanceLock>[0]) => {
      h.order.push('instanceLock');
      const r = await real.acquireInstanceLock(o);
      if (!r.ok) return r;
      return {
        ...r,
        release: () => {
          h.order.push('lock.release');
          r.release();
        },
      };
    },
  };
});

let appData: string;
const listenersBefore = { exception: [] as unknown[], rejection: [] as unknown[] };
// Vitest 5 기본값 clearMocks: true — 테스트마다 호출 기록이 지워지므로 시작 때 기록을 따로 떠 둔다
const boot = {
  setPath: [] as unknown[][],
  ipcHandle: [] as unknown[][],
  loadURL: [] as unknown[][],
  createBackend: [] as unknown[][],
  powerStart: 0,
};

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  appData = mkdtempSync(join(tmpdir(), 'wook-test-앱데이터 폴더-'));
  h.state.appData = appData;
  listenersBefore.exception = process.listeners('uncaughtException');
  listenersBefore.rejection = process.listeners('unhandledRejection');
  process.env['ELECTRON_RENDERER_URL'] = 'http://localhost:5173';
  await import('../index');
  h.readyResolve();
  await vi.waitFor(() => expect(h.registeredShortcuts.size).toBe(1));
  boot.setPath = [...h.electron.app.setPath.mock.calls];
  boot.ipcHandle = [...h.electron.ipcMain.handle.mock.calls];
  boot.loadURL = [...h.windows[0]!.loadURL.mock.calls];
  boot.createBackend = [...h.createBackend.mock.calls];
  boot.powerStart = h.electron.powerSaveBlocker.start.mock.calls.length;
});

afterAll(async () => {
  delete process.env['ELECTRON_RENDERER_URL'];
  for (const l of process.listeners('uncaughtException')) {
    if (!listenersBefore.exception.includes(l)) process.removeListener('uncaughtException', l);
  }
  for (const l of process.listeners('unhandledRejection')) {
    if (!listenersBefore.rejection.includes(l)) process.removeListener('unhandledRejection', l);
  }
  vi.restoreAllMocks();
  // rmSync는 Node 24.13(Windows)에서 한글 경로면 테스트 프로세스가 죽어 비동기 rm을 쓴다
  await rm(appData, { recursive: true, force: true });
});

describe('Electron 진입점 연결', () => {
  it('ready 전에 이름·userData·sessionData를 정하고, 그다음 단일 실행 잠금을 잡는다', () => {
    const lockAt = h.order.indexOf('requestSingleInstanceLock');
    expect(h.order.slice(0, lockAt)).toEqual(['setName:욱채', 'setPath:userData', 'setPath:sessionData', 'enableSandbox']);
    expect(boot.setPath).toEqual([
      ['userData', join(appData, 'wookagent')],
      ['sessionData', join(appData, 'wookagent', 'chromium')],
    ]);
    expect(existsSync(join(appData, 'wookagent', 'chromium'))).toBe(true);
  });

  it('실행 잠금은 Electron 단일 실행 잠금 뒤, 백엔드를 만들기 전에 잡는다 — 데스크톱 앱 종류와 이 프로세스를 적는다 (S2-6)', () => {
    expect(h.order.indexOf('requestSingleInstanceLock')).toBeLessThan(h.order.indexOf('instanceLock'));
    expect(h.order.indexOf('instanceLock')).toBeLessThan(h.order.indexOf('createBackend'));
    const lock = JSON.parse(readFileSync(join(appData, 'wookagent', 'server.lock'), 'utf8')) as Record<string, unknown>;
    expect(lock).toEqual({ pid: process.pid, createdAt: expect.any(Number), kind: 'desktop', startedAt: expect.any(String) });
    expect(h.order).not.toContain('lock.release');
  });

  it('로그를 <앱데이터>/logs/main.log에 남긴다', () => {
    const text = readFileSync(join(appData, 'wookagent', 'logs', 'main.log'), 'utf8');
    expect(text).toContain('욱채 시작');
    expect(text).toContain('껍데기 준비 완료');
  });

  it('IPC 처리기를 창보다 먼저 걸고, 백엔드에 껍데기 기능·노드 실행 정보를 넘긴다', () => {
    expect(boot.ipcHandle).toEqual([[IPC_INVOKE_CHANNEL, expect.any(Function)]]);
    expect(h.order.indexOf('createBackend')).toBeLessThan(h.order.indexOf('BrowserWindow'));
    const deps = boot.createBackend[0]![0] as Record<string, unknown>;
    expect(deps).toMatchObject({
      dataDir: join(appData, 'wookagent'),
      appRoot: 'C:\\앱 루트',
      isPackaged: false,
      nodeExecPath: process.execPath,
      nodeExecEnv: { ELECTRON_RUN_AS_NODE: '1' },
    });
    expect(Object.keys(deps['shell'] as object).sort()).toEqual(['focusWindow', 'openExternal', 'openPath', 'pickFiles', 'showOsNotification']);
    // 개발 모드 로그인은 예전처럼 개발 실행(isPackaged false)에서만 — 패키징 여부와 따로 넘긴다 (S2-2)
    expect(deps['allowDevLogin']).toBe(true);
  });

  it('백엔드에 잡은 실행 잠금의 내용과 데이터 폴더를 이 프로세스로 넘긴다 — 저장소의 데이터 주인 확인 (S2-15)', () => {
    const deps = boot.createBackend[0]![0] as Record<string, unknown>;
    const lock = JSON.parse(readFileSync(join(appData, 'wookagent', 'server.lock'), 'utf8')) as Record<string, unknown>;
    expect(deps['instance']).toEqual({ ...lock, dataDir: join(appData, 'wookagent') });
    expect(deps['instance']).toMatchObject({ pid: process.pid, kind: 'desktop' });
  });

  it('창은 preload·개발 서버 주소로 만들고, 트레이·긴급 정지 단축키를 건다', () => {
    const win = h.windows[0]!;
    expect((win.options['webPreferences'] as Record<string, unknown>)['preload']).toMatch(/preload[\\/]index\.js$/);
    expect(boot.loadURL).toEqual([['http://localhost:5173/']]);
    expect(h.trays).toHaveLength(1);
    expect(h.trays[0]!.tooltip).toBe('욱채 — 정상');
    expect([...h.registeredShortcuts.keys()]).toEqual(['CommandOrControl+Alt+Shift+S']);
    expect(boot.powerStart).toBe(0);
  });

  it('메인 창의 요청은 백엔드로 가고, 백엔드 푸시는 창으로 온다', async () => {
    const win = h.windows[0]!;
    const handler = boot.ipcHandle[0]![1] as Handler;
    const event = { sender: win.webContents, senderFrame: { parent: null, url: 'http://localhost:5173/' } };
    await expect(handler(event, 'snapshot.get', [])).resolves.toEqual({ ok: true, value: { version: 1 } });
    const foreign = { sender: {}, senderFrame: { parent: null, url: 'http://localhost:5173/' } };
    await expect(handler(foreign, 'snapshot.get', [])).resolves.toMatchObject({ ok: false, error: { code: 'forbidden_sender' } });

    for (const cb of h.topicListeners.get('snapshot') ?? []) cb({ version: 2 });
    expect(win.webContents.send).toHaveBeenCalledWith(`${IPC_TOPIC_PREFIX}snapshot`, { version: 2 });
  });

  it('창이 모두 닫혀도 종료하지 않고, 두 번째 실행은 창을 앞으로 가져온다', () => {
    h.electron.app.emit('window-all-closed');
    expect(h.electron.app.quit).not.toHaveBeenCalled();
    expect(h.electron.app.exit).not.toHaveBeenCalled();
    const win = h.windows[0]!;
    win.visible = false;
    h.electron.app.emit('second-instance', {}, [], '');
    expect(win.visible).toBe(true);
    expect(win.focus).toHaveBeenCalled();
  });

  it('전역 단축키 → 긴급 정지 → 화면에 요약 푸시 + 긴급 OS 알림', async () => {
    h.registeredShortcuts.get('CommandOrControl+Alt+Shift+S')!();
    await vi.waitFor(() => expect(h.windows[0]!.webContents.send).toHaveBeenCalledWith(`${IPC_TOPIC_PREFIX}emergency`, h.summary));
    expect(h.backend.emergencyStop).toHaveBeenCalledTimes(1);
    expect(h.notifications.at(-1)!.options).toMatchObject({ title: '긴급 정지 완료', silent: false });
  });

  it('완전 종료: before-quit을 막고 체크포인트(shutdown) → 정리 → app.exit(0)', async () => {
    const event = { preventDefault: vi.fn() };
    h.electron.app.emit('before-quit', event);
    expect(event.preventDefault).toHaveBeenCalled();
    await vi.waitFor(() => expect(h.electron.app.exit).toHaveBeenCalledWith(0));
    expect(h.order.indexOf('backend.shutdown')).toBeLessThan(h.order.indexOf('exit:0'));
    expect(h.electron.dialog.showMessageBox).not.toHaveBeenCalled();
    expect(h.trays[0]!.destroyed).toBe(true);
    expect(h.electron.globalShortcut.unregisterAll).toHaveBeenCalled();
    expect(h.electron.ipcMain.removeHandler).toHaveBeenCalledWith(IPC_INVOKE_CHANNEL);
    expect(readFileSync(join(appData, 'wookagent', 'logs', 'main.log'), 'utf8')).toContain('욱채 종료 (코드 0)');
  });

  it('완전 종료는 체크포인트 뒤, 끝내기 전에 실행 잠금을 놓는다 (S2-6)', () => {
    expect(h.order.indexOf('backend.shutdown')).toBeLessThan(h.order.indexOf('lock.release'));
    expect(h.order.indexOf('lock.release')).toBeLessThan(h.order.indexOf('exit:0'));
    expect(existsSync(join(appData, 'wookagent', 'server.lock'))).toBe(false);
  });
});
