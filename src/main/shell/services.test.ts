import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { BackendError } from '../backend/types';
import type { Logger } from './logger';

const electron = vi.hoisted(() => ({
  shell: {
    openExternal: vi.fn(async (_url: string) => undefined),
    openPath: vi.fn(async (_path: string) => ''),
    showItemInFolder: vi.fn((_path: string) => undefined),
  },
  dialog: { showOpenDialog: vi.fn() },
}));
vi.mock('electron', () => ({ shell: electron.shell, dialog: electron.dialog }));

import { createShellServices } from './services';

let dir: string;
beforeEach(() => {
  vi.clearAllMocks();
  dir = mkdtempSync(join(tmpdir(), 'wook-test-서비스 폴더-'));
});
// rmSync는 Node 24.13(Windows)에서 한글 경로면 테스트 프로세스가 죽어 비동기 rm을 쓴다
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function setup(win: { visible: boolean } | null = null) {
  const fakeWin = win ? ({ isDestroyed: () => false, isVisible: () => win.visible } as unknown as BrowserWindow) : null;
  const notifier = { show: vi.fn() };
  const focusWindow = vi.fn();
  const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const services = createShellServices({ getWindow: () => fakeWin, focusWindow, notifier, logger });
  return { services, fakeWin, notifier, focusWindow };
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  const error = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(BackendError);
  return (error as BackendError).code;
}

describe('ShellServices', () => {
  it('openExternal은 https만 연다', async () => {
    const { services } = setup();
    await services.openExternal('https://accounts.google.com/o/oauth2/v2/auth?x=1');
    expect(electron.shell.openExternal).toHaveBeenCalledWith('https://accounts.google.com/o/oauth2/v2/auth?x=1');
    for (const bad of ['http://example.com', 'file:///C:/Windows/System32/calc.exe', 'javascript:alert(1)', 'ms-settings:', '아무 말']) {
      expect(await codeOf(services.openExternal(bad))).toBe('invalid_url');
    }
    expect(electron.shell.openExternal).toHaveBeenCalledTimes(1);
  });

  it('openExternal 실패는 한국어 BackendError로 바꾼다', async () => {
    electron.shell.openExternal.mockRejectedValueOnce(new Error('no browser'));
    const { services } = setup();
    expect(await codeOf(services.openExternal('https://example.com'))).toBe('open_failed');
  });

  it('openPath: 폴더·문서는 열고, 실행 파일 형식은 폴더에서 보여 주기만 한다', async () => {
    const { services } = setup();
    const doc = join(dir, '보고서 1.md');
    writeFileSync(doc, '# 보고서');
    await services.openPath(dir);
    await services.openPath(doc);
    expect(electron.shell.openPath.mock.calls.map((c) => c[0])).toEqual([dir, doc]);
    for (const name of ['설치.exe', 'run.bat', 'build.CMD', 'script.ps1', 'x.js', 'link.lnk']) {
      const file = join(dir, name);
      writeFileSync(file, '');
      await services.openPath(file);
    }
    expect(electron.shell.openPath).toHaveBeenCalledTimes(2);
    expect(electron.shell.showItemInFolder).toHaveBeenCalledTimes(6);
    // 이름이 .exe로 끝나는 폴더는 폴더로 연다 (Windows)
    if (process.platform === 'win32') {
      const folder = join(dir, 'tools.exe');
      mkdirSync(folder);
      await services.openPath(folder);
      expect(electron.shell.openPath).toHaveBeenLastCalledWith(folder);
    }
  });

  it('openPath: 상대 경로·없는 경로·열기 실패는 거부한다', async () => {
    const { services } = setup();
    expect(await codeOf(services.openPath('reports/a.md'))).toBe('invalid_path');
    expect(await codeOf(services.openPath(join(dir, '없음.md')))).toBe('not_found');
    const doc = join(dir, 'a.md');
    writeFileSync(doc, '');
    electron.shell.openPath.mockResolvedValueOnce('No application is associated');
    expect(await codeOf(services.openPath(doc))).toBe('open_failed');
  });

  it('pickFiles: 여러 개 선택, 이름을 붙여 돌려준다. 숨긴 창은 부모로 쓰지 않는다', async () => {
    const { services } = setup({ visible: false });
    const a = join(dir, '첨부 1.png');
    const b = join(dir, 'b.txt');
    electron.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [a, b] });
    await expect(services.pickFiles()).resolves.toEqual([
      { path: a, name: '첨부 1.png' },
      { path: b, name: 'b.txt' },
    ]);
    const call = electron.dialog.showOpenDialog.mock.calls.at(-1)!;
    expect(call).toHaveLength(1);
    expect(call[0]).toMatchObject({ properties: ['openFile', 'multiSelections'] });
  });

  // 폴더 선택 창(pickFolder)을 없애며(S2-7) 그 시험이 보던 '보이는 창을 부모로'·'취소'를 파일 선택에서 본다
  it('pickFiles: 보이는 창을 부모로 쓰고, 취소하면 빈 목록', async () => {
    const { services, fakeWin } = setup({ visible: true });
    electron.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    await expect(services.pickFiles()).resolves.toEqual([]);
    expect(electron.dialog.showOpenDialog).toHaveBeenLastCalledWith(fakeWin, expect.objectContaining({ properties: ['openFile', 'multiSelections'] }));
  });

  it('폴더 선택 창은 없다 (system.pickFolder를 없앴다, S2-7)', () => {
    const { services } = setup();
    expect(Object.keys(services).sort()).toEqual(['focusWindow', 'openExternal', 'openPath', 'pickFiles', 'showOsNotification']);
  });

  it('알림·창 앞으로는 주입한 껍데기 기능으로 전달한다', () => {
    const { services, notifier, focusWindow } = setup();
    const onClick = vi.fn();
    services.showOsNotification({ level: 'urgent', title: 't', body: 'b', onClick });
    expect(notifier.show).toHaveBeenCalledWith({ level: 'urgent', title: 't', body: 'b', onClick });
    services.focusWindow();
    expect(focusWindow).toHaveBeenCalledTimes(1);
  });
});
