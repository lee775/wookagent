/**
 * src/main/index.ts 데이터 주인 거부 (SERVER_DESIGN 3.3, S2-15): 데이터 폴더가 살아 있는 다른 욱채(서버)의 데이터(복사본이거나 잠금 파일이 지워짐)면
 * 데스크톱 앱도 시작하지 않는다 — 실제 createBackend가 저장소를 열자마자 그 기록을 보고 재시작 복구 전에 멈춘다. 오류 창으로 알리고 코드 1로 끝내며
 * 잡았던 실행 잠금을 놓는다. 저장소의 주인 기록은 그대로다. electron과 창은 가짜, 주인으로 적힌 쪽은 실제 자식 프로세스다.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { openStore } from '../db/store';
import { processLiveness } from '../process/processRunner';

const h = vi.hoisted(() => {
  const state = { appData: '' };
  const app = {
    isPackaged: false,
    on: vi.fn(),
    setName: vi.fn(),
    getPath: vi.fn((name: string) => (name === 'appData' ? state.appData : `${state.appData}/${name}`)),
    setPath: vi.fn(),
    enableSandbox: vi.fn(),
    requestSingleInstanceLock: vi.fn(() => true),
    quit: vi.fn(),
    exit: vi.fn(),
    whenReady: vi.fn(() => Promise.resolve()),
    getVersion: () => '0.1.0',
    getAppPath: () => process.cwd(),
    setAppUserModelId: vi.fn(),
  };
  const electron = {
    app,
    BrowserWindow: vi.fn(),
    Tray: vi.fn(),
    Notification: Object.assign(vi.fn(), { isSupported: () => true }),
    Menu: { setApplicationMenu: vi.fn(), buildFromTemplate: vi.fn() },
    nativeImage: { createFromBitmap: vi.fn() },
    screen: { getPrimaryDisplay: vi.fn() },
    shell: { openExternal: vi.fn(), openPath: vi.fn(), showItemInFolder: vi.fn() },
    dialog: { showErrorBox: vi.fn(), showMessageBox: vi.fn(), showOpenDialog: vi.fn() },
    ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
    globalShortcut: { register: vi.fn(), unregister: vi.fn(), unregisterAll: vi.fn(), isRegistered: vi.fn() },
    powerSaveBlocker: { start: vi.fn(), stop: vi.fn(), isStarted: vi.fn() },
    powerMonitor: { on: vi.fn() },
  };
  // 창은 가짜 — 백엔드보다 먼저 만들어진다
  const windowCtl = { create: vi.fn(), getWindow: () => null, isTrustedSender: () => false, show: vi.fn(), allowClose: vi.fn() };
  return { state, electron, windowCtl };
});

vi.mock('electron', () => h.electron);
vi.mock('./window', () => ({ createMainWindowController: () => h.windowCtl }));

let appData: string;
let dataDir: string;
let holder: ChildProcess & { pid: number };
let recorded: Record<string, unknown> = {};
const envBefore = process.env['WOOK_DATA_DIR'];
const listenersBefore = { exception: [] as unknown[], rejection: [] as unknown[] };
// Vitest 5 기본값 clearMocks: true — 시험마다 호출 기록이 지워지므로 시작 때 기록을 따로 떠 둔다
const calls = { showErrorBox: [] as unknown[][], exit: [] as unknown[][] };

beforeAll(async () => {
  appData = mkdtempSync(join(tmpdir(), 'wook-test-데이터 주인-'));
  h.state.appData = appData;
  delete process.env['WOOK_DATA_DIR'];
  listenersBefore.exception = process.listeners('uncaughtException');
  listenersBefore.rejection = process.listeners('unhandledRejection');
  // 이 데이터를 쓰는 살아 있는 서버 (실제 다른 프로세스). 데이터 폴더는 다른 곳 — 이 폴더는 그 복사본이다. 잠금 파일은 복사되지 않았다
  holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true }) as ChildProcess & { pid: number };
  await new Promise<void>((resolve, reject) => {
    holder.once('spawn', () => resolve());
    holder.once('error', reject);
  });
  const createdAt = (await processLiveness.processCreatedAt([holder.pid])).get(holder.pid);
  dataDir = join(appData, 'wookagent');
  mkdirSync(dataDir, { recursive: true });
  recorded = { pid: holder.pid, createdAt, kind: 'server', startedAt: new Date().toISOString(), dataDir: 'D:\\원래 서버 데이터' };
  const store = openStore(join(dataDir, 'wook.db'));
  store.kv.set('instance', recorded);
  store.close();

  await import('../index');
  await vi.waitFor(
    () => {
      if (!h.electron.app.exit.mock.calls.length) throw new Error('아직 시작 중');
    },
    { timeout: 30_000 },
  );
  calls.showErrorBox = [...h.electron.dialog.showErrorBox.mock.calls];
  calls.exit = [...h.electron.app.exit.mock.calls];
}, 60_000);

afterAll(async () => {
  if (envBefore === undefined) delete process.env['WOOK_DATA_DIR'];
  else process.env['WOOK_DATA_DIR'] = envBefore;
  for (const l of process.listeners('uncaughtException')) {
    if (!listenersBefore.exception.includes(l)) process.removeListener('uncaughtException', l);
  }
  for (const l of process.listeners('unhandledRejection')) {
    if (!listenersBefore.rejection.includes(l)) process.removeListener('unhandledRejection', l);
  }
  holder?.kill();
  // rmSync는 Node 24.13(Windows)에서 한글 경로면 테스트 프로세스가 죽어 비동기 rm을 쓴다
  await rm(appData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('데스크톱 앱 데이터 주인 거부 (S2-15)', () => {
  it('살아 있는 다른 욱채의 데이터면 그 종류·pid·원래 데이터 폴더를 오류 창으로 알리고 코드 1로 끝낸다', () => {
    expect(calls.showErrorBox).toEqual([
      [
        '욱채를 시작하지 못했습니다',
        `실행 중인 다른 욱채의 데이터라 시작하지 않습니다.\n\n이 데이터는 실행 중인 욱채(서버, pid ${holder.pid}, 데이터 폴더 D:\\원래 서버 데이터)가 쓰고 있는 데이터입니다(복사본이거나 잠금 파일이 지워짐) — 그 욱채를 끝낸 뒤 다시 시작하세요\n\n자세한 기록: ${join(dataDir, 'logs', 'main.log')}`,
      ],
    ]);
    expect(calls.exit).toEqual([[1]]);
  });

  it('잡았던 실행 잠금을 놓고, 저장소의 주인 기록은 그대로 두며, 주인 프로세스는 살아 있다', () => {
    expect(existsSync(join(dataDir, 'server.lock'))).toBe(false);
    const store = openStore(join(dataDir, 'wook.db'));
    try {
      expect(store.kv.get('instance')).toEqual(recorded);
      // 재시작 복구도, 기본 데이터 만들기도 돌지 않았다 (설정·역할이 없다)
      expect(store.kv.get('settings')).toBeNull();
      expect(store.roles.count()).toBe(0);
    } finally {
      store.close();
    }
    expect(holder.exitCode).toBeNull();
  });
});
