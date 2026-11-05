/**
 * src/main/index.ts 실행 잠금 거부 (SERVER_DESIGN 3.3, S2-6): 같은 데이터 폴더를 다른 욱채(서버)가 쓰고 있으면 데스크톱 앱은 오류 창을 띄우고
 * 백엔드·창을 만들지 않은 채 끝낸다. 잠금 파일은 그대로 둔다. electron과 백엔드는 가짜, 잠금을 잡은 쪽은 실제 자식 프로세스다.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
    getAppPath: () => 'C:\\앱 루트',
    setAppUserModelId: vi.fn(),
  };
  const BrowserWindow = vi.fn();
  const electron = {
    app,
    BrowserWindow,
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
  const createBackend = vi.fn();
  return { state, electron, createBackend };
});

vi.mock('electron', () => h.electron);
vi.mock('../backend/createBackend', () => ({ createBackend: h.createBackend }));

let appData: string;
let holder: ChildProcess & { pid: number };
let lockText = '';
const envBefore = process.env['WOOK_DATA_DIR'];
const listenersBefore = { exception: [] as unknown[], rejection: [] as unknown[] };
// Vitest 5 기본값 clearMocks: true — 시험마다 호출 기록이 지워지므로 시작 때 기록을 따로 떠 둔다
const calls = { showErrorBox: [] as unknown[][], exit: [] as unknown[][], createBackend: 0, windows: 0, ipcHandle: 0 };

beforeAll(async () => {
  appData = mkdtempSync(join(tmpdir(), 'wook-test-잠금 거부-'));
  h.state.appData = appData;
  // 개발 실행은 WOOK_DATA_DIR이 있으면 그 폴더를 쓴다 — 이 시험은 앱 데이터 폴더 아래를 쓴다
  delete process.env['WOOK_DATA_DIR'];
  listenersBefore.exception = process.listeners('uncaughtException');
  listenersBefore.rejection = process.listeners('unhandledRejection');
  // 같은 데이터 폴더를 쓰는 서버 (실제 살아 있는 다른 프로세스)
  holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true }) as ChildProcess & { pid: number };
  await new Promise<void>((resolve, reject) => {
    holder.once('spawn', () => resolve());
    holder.once('error', reject);
  });
  const createdAt = (await processLiveness.processCreatedAt([holder.pid])).get(holder.pid);
  const dataDir = join(appData, 'wookagent');
  mkdirSync(dataDir, { recursive: true });
  lockText = JSON.stringify({ pid: holder.pid, createdAt, kind: 'server', startedAt: new Date().toISOString() });
  writeFileSync(join(dataDir, 'server.lock'), lockText);

  await import('../index');
  // 끝내거나(거부) 백엔드를 만들기 시작할 때(잘못된 시작)까지 — 어느 쪽이든 아래 시험이 가린다
  await vi.waitFor(
    () => {
      if (!h.electron.app.exit.mock.calls.length && !h.createBackend.mock.calls.length) throw new Error('아직 시작·거부 중');
    },
    { timeout: 20_000 },
  );
  calls.showErrorBox = [...h.electron.dialog.showErrorBox.mock.calls];
  calls.exit = [...h.electron.app.exit.mock.calls];
  calls.createBackend = h.createBackend.mock.calls.length;
  calls.windows = h.electron.BrowserWindow.mock.calls.length;
  calls.ipcHandle = h.electron.ipcMain.handle.mock.calls.length;
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
  await rm(appData, { recursive: true, force: true });
});

describe('데스크톱 앱 실행 잠금 거부 (S2-6)', () => {
  it('다른 욱채(서버)가 쓰는 데이터 폴더면 그 종류와 pid를 오류 창으로 알리고 코드 1로 끝낸다', () => {
    expect(calls.showErrorBox).toEqual([
      [
        '욱채를 시작하지 못했습니다',
        `이 데이터 폴더는 이미 다른 욱채(서버, pid ${holder.pid})가 쓰고 있습니다.\n\n같은 데이터 폴더로는 욱채를 하나만 실행할 수 있습니다. 실행 중인 욱채를 먼저 끝낸 뒤 다시 시작해 주세요.`,
      ],
    ]);
    expect(calls.exit).toEqual([[1]]);
  });

  it('백엔드·창·IPC를 만들지 않는다 — 서버의 CLI를 재시작 복구가 끊지 않는다', () => {
    expect({ createBackend: calls.createBackend, windows: calls.windows, ipcHandle: calls.ipcHandle }).toEqual({ createBackend: 0, windows: 0, ipcHandle: 0 });
    expect(holder.exitCode).toBeNull();
  });

  it('잠금 파일은 서버의 것 그대로 두고, 거부를 로그에 남긴다', () => {
    expect(readFileSync(join(appData, 'wookagent', 'server.lock'), 'utf8')).toBe(lockText);
    const log = readFileSync(join(appData, 'wookagent', 'logs', 'main.log'), 'utf8');
    expect(log).toContain(`실행 잠금을 잡지 못해 시작하지 않습니다: 이 데이터 폴더는 이미 다른 욱채(서버, pid ${holder.pid})가 쓰고 있습니다`);
  });
});
