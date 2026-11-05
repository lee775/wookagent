import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_INVOKE_CHANNEL, IPC_METHODS, IPC_TOPIC_PREFIX, type WookBridge } from '@shared/ipc';

const electron = vi.hoisted(() => {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  return {
    listeners,
    contextBridge: { exposeInMainWorld: vi.fn() },
    ipcRenderer: {
      invoke: vi.fn(),
      on: vi.fn((channel: string, fn: (...args: unknown[]) => void) => {
        if (!listeners.has(channel)) listeners.set(channel, new Set());
        listeners.get(channel)!.add(fn);
      }),
      removeListener: vi.fn((channel: string, fn: (...args: unknown[]) => void) => {
        listeners.get(channel)?.delete(fn);
      }),
    },
  };
});
vi.mock('electron', () => ({ contextBridge: electron.contextBridge, ipcRenderer: electron.ipcRenderer }));

let wook: WookBridge;

beforeAll(async () => {
  await import('./index');
  expect(electron.contextBridge.exposeInMainWorld).toHaveBeenCalledTimes(1);
  const [key, api] = electron.contextBridge.exposeInMainWorld.mock.calls[0]!;
  expect(key).toBe('wook');
  wook = api as WookBridge;
});

beforeEach(() => {
  electron.ipcRenderer.invoke.mockReset();
});

function emit(channel: string, payload: unknown) {
  for (const fn of electron.listeners.get(channel) ?? []) fn({ sender: 'ipcRenderer-객체' }, payload);
}

describe('preload window.wook', () => {
  it('invoke·subscribe·platform만 노출한다', () => {
    expect(Object.keys(wook).sort()).toEqual(['invoke', 'platform', 'subscribe']);
    expect(['win32', 'darwin', 'linux']).toContain(wook.platform);
  });

  it('invoke는 메서드와 인자 배열을 보내고 { ok: true }의 값을 돌려준다', async () => {
    electron.ipcRenderer.invoke.mockResolvedValue({ ok: true, value: { id: 'T-0001' } });
    await expect(wook.invoke('tasks.get', 'T-0001')).resolves.toEqual({ id: 'T-0001' });
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith(IPC_INVOKE_CHANNEL, 'tasks.get', ['T-0001']);
  });

  it('{ ok: false }는 한국어 메시지와 code를 가진 Error로 던진다', async () => {
    electron.ipcRenderer.invoke.mockResolvedValue({ ok: false, error: { code: 'not_found', message: '작업을 찾을 수 없습니다' } });
    const error = await wook.invoke('tasks.get', 'T-0404').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('작업을 찾을 수 없습니다');
    expect((error as Error & { code: string }).code).toBe('not_found');
  });

  it('허용 목록에 없는 메서드는 IPC를 보내지 않고 거부한다', async () => {
    const call = (wook.invoke as (m: string, ...a: unknown[]) => Promise<unknown>)('system.exec', 'rm -rf /');
    await expect(call).rejects.toMatchObject({ code: 'unknown_method', message: '허용되지 않은 요청입니다.' });
    expect(electron.ipcRenderer.invoke).not.toHaveBeenCalled();
  });

  it('대표 권한에서 뺀 메서드는 IPC를 보내지 않고 forbidden으로 거부한다 — 대표 메서드와 데스크톱 운영자 로컬 메서드는 보낸다 (SERVER_DESIGN 2.5)', async () => {
    for (const removed of ['members.pause', 'projects.create', 'tasks.cancel', 'roles.create', 'system.backupNow']) {
      const call = (wook.invoke as (m: string, ...a: unknown[]) => Promise<unknown>)(removed, 'x');
      await expect(call).rejects.toMatchObject({ code: 'forbidden' });
    }
    expect(electron.ipcRenderer.invoke).not.toHaveBeenCalled();
    electron.ipcRenderer.invoke.mockResolvedValue({ ok: true, value: null });
    await wook.invoke('settings.setApiKey', 'claude', null);
    await wook.invoke('settings.update', { cli: { claudePath: null } });
    await wook.invoke('command.send', { target: 'main', text: '팀원 하나 붙여 줘' });
    // CLI 다시 확인은 대표 메서드다 (보기, 리드 결정 7) — 홈의 '재로그인 필요' 할 일이 부른다
    await wook.invoke('system.recheckAi', 'claude');
    expect(electron.ipcRenderer.invoke.mock.calls.map((c) => c[1])).toEqual(['settings.setApiKey', 'settings.update', 'command.send', 'system.recheckAi']);
  });

  it('기능 자체를 없앤 메서드(폴더 고르기 등)는 화면 약속에 없어 다른 모르는 이름처럼 unknown_method로 거부하고 IPC를 보내지 않는다 (리드 결정 21)', async () => {
    expect(IPC_METHODS).not.toContain('system.pickFolder');
    const call = (wook.invoke as (m: string, ...a: unknown[]) => Promise<unknown>)('system.pickFolder');
    await expect(call).rejects.toMatchObject({ code: 'unknown_method', message: '허용되지 않은 요청입니다.' });
    expect(electron.ipcRenderer.invoke).not.toHaveBeenCalled();
  });

  it('IPC 자체가 실패하거나 응답 형식이 이상하면 한국어 오류로 바꾼다', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    electron.ipcRenderer.invoke.mockRejectedValue(new Error("No handler registered for 'wook:invoke'"));
    await expect(wook.invoke('snapshot.get')).rejects.toMatchObject({ code: 'ipc_failed' });
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();

    electron.ipcRenderer.invoke.mockResolvedValue('이상한 응답');
    await expect(wook.invoke('snapshot.get')).rejects.toMatchObject({ code: 'bad_response' });
  });

  it('subscribe는 허용 주제만 받고, 콜백에는 내용만 넘기고, 해제할 수 있다', () => {
    const cb = vi.fn();
    const off = wook.subscribe('snapshot', cb);
    const channel = IPC_TOPIC_PREFIX + 'snapshot';
    expect(electron.ipcRenderer.on).toHaveBeenCalledWith(channel, expect.any(Function));
    emit(channel, { version: 7 });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0]).toEqual([{ version: 7 }]);
    off();
    off();
    expect(electron.ipcRenderer.removeListener).toHaveBeenCalledTimes(1);
    emit(channel, { version: 8 });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('허용되지 않은 주제 구독은 거부한다', () => {
    expect(() => (wook.subscribe as (t: string, cb: () => void) => () => void)('wook:invoke', () => undefined)).toThrow('허용되지 않은 구독입니다.');
  });

  it('한 구독자의 오류가 다른 구독자를 막지 않는다', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const bad = vi.fn(() => {
      throw new Error('화면 오류');
    });
    const good = vi.fn();
    const off1 = wook.subscribe('notification', bad);
    const off2 = wook.subscribe('notification', good);
    emit(IPC_TOPIC_PREFIX + 'notification', { id: 'N-1' });
    expect(good).toHaveBeenCalledWith({ id: 'N-1' });
    expect(consoleError).toHaveBeenCalled();
    off1();
    off2();
    consoleError.mockRestore();
  });
});
