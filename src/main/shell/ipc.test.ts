import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { IPC_INVOKE_CHANNEL, IPC_TOPICS, IPC_TOPIC_PREFIX, type WookTopic } from '@shared/ipc';
import { BackendError, type Backend } from '../backend/types';
import type { Logger } from './logger';

const electron = vi.hoisted(() => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
}));
vi.mock('electron', () => electron);

import { createInvokeHandler, forwardTopics, IPC_ERRORS, isTrustedIpcSender, registerInvokeHandler, sendTopic } from './ipc';

function fakeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() } satisfies Logger;
}

function fakeBackend(invoke: Backend['invoke'] = vi.fn()) {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const backend = {
    invoke,
    onTopic: vi.fn((topic: string, cb: (payload: unknown) => void) => {
      if (!listeners.has(topic)) listeners.set(topic, new Set());
      listeners.get(topic)!.add(cb);
      return () => listeners.get(topic)!.delete(cb);
    }),
  };
  const emit = (topic: string, payload: unknown) => {
    for (const cb of listeners.get(topic) ?? []) cb(payload);
  };
  return { backend: backend as unknown as Backend, emit, listeners };
}

function fakeWindow(opts: { destroyed?: boolean; contentsDestroyed?: boolean; crashed?: boolean; sendThrows?: boolean } = {}) {
  const send = vi.fn((..._args: unknown[]) => {
    if (opts.sendThrows) throw new Error('An object could not be cloned.');
  });
  const webContents = {
    send,
    isDestroyed: () => opts.contentsDestroyed ?? false,
    isCrashed: () => opts.crashed ?? false,
  };
  const win = { isDestroyed: () => opts.destroyed ?? false, webContents };
  return { win: win as unknown as BrowserWindow, send, webContents };
}

const event = {} as IpcMainInvokeEvent;

describe('IPC 요청 처리', () => {
  beforeEach(() => vi.clearAllMocks());

  it('허용 목록의 메서드는 백엔드에 전달하고 { ok: true, value }로 답한다', async () => {
    const invoke = vi.fn(async () => ({ version: 3 }));
    const { backend } = fakeBackend(invoke as unknown as Backend['invoke']);
    const handler = createInvokeHandler({ backend, isTrustedSender: () => true, logger: fakeLogger() });
    await expect(handler(event, 'snapshot.get', [])).resolves.toEqual({ ok: true, value: { version: 3 } });
    expect(invoke).toHaveBeenCalledWith('snapshot.get', []);
    await handler(event, 'tasks.interrupt', ['T-0001', 'hold']);
    expect(invoke).toHaveBeenLastCalledWith('tasks.interrupt', ['T-0001', 'hold']);
  });

  it('반환값이 없는 메서드도 ok로 답한다', async () => {
    const { backend } = fakeBackend(vi.fn(async () => undefined) as unknown as Backend['invoke']);
    const handler = createInvokeHandler({ backend, isTrustedSender: () => true, logger: fakeLogger() });
    await expect(handler(event, 'stop.release', [])).resolves.toEqual({ ok: true, value: undefined });
  });

  it('허용 목록에 없는 메서드는 백엔드를 부르지 않고 거부한다', async () => {
    const invoke = vi.fn();
    const { backend } = fakeBackend(invoke as unknown as Backend['invoke']);
    const logger = fakeLogger();
    const handler = createInvokeHandler({ backend, isTrustedSender: () => true, logger });
    for (const method of ['system.exec', 'constructor', '__proto__', 42, null, undefined]) {
      await expect(handler(event, method, [])).resolves.toEqual({ ok: false, error: IPC_ERRORS.unknownMethod });
    }
    expect(invoke).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('메인 창이 아닌 발신자는 거부한다', async () => {
    const invoke = vi.fn();
    const { backend } = fakeBackend(invoke as unknown as Backend['invoke']);
    const handler = createInvokeHandler({ backend, isTrustedSender: () => false, logger: fakeLogger() });
    await expect(handler(event, 'snapshot.get', [])).resolves.toEqual({ ok: false, error: IPC_ERRORS.forbiddenSender });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('발신자 확인이 예외를 내도 거부로 처리한다', async () => {
    const { backend } = fakeBackend();
    const logger = fakeLogger();
    const handler = createInvokeHandler({
      backend,
      isTrustedSender: () => {
        throw new Error('Render frame was disposed');
      },
      logger,
    });
    await expect(handler(event, 'snapshot.get', [])).resolves.toEqual({ ok: false, error: IPC_ERRORS.forbiddenSender });
    expect(logger.error).toHaveBeenCalled();
  });

  it('인자가 배열이 아니면 거부한다', async () => {
    const invoke = vi.fn();
    const { backend } = fakeBackend(invoke as unknown as Backend['invoke']);
    const handler = createInvokeHandler({ backend, isTrustedSender: () => true, logger: fakeLogger() });
    await expect(handler(event, 'snapshot.get', { 0: 'x' })).resolves.toEqual({ ok: false, error: IPC_ERRORS.invalidArgs });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('BackendError는 code·한국어 메시지를 그대로 전달한다', async () => {
    const { backend } = fakeBackend(
      vi.fn(async () => {
        throw new BackendError('not_found', '작업을 찾을 수 없습니다: T-0009');
      }) as unknown as Backend['invoke'],
    );
    const logger = fakeLogger();
    const handler = createInvokeHandler({ backend, isTrustedSender: () => true, logger });
    await expect(handler(event, 'tasks.get', ['T-0009'])).resolves.toEqual({
      ok: false,
      error: { code: 'not_found', message: '작업을 찾을 수 없습니다: T-0009' },
    });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('다른 모듈 사본의 BackendError(이름·code로 판별)도 그대로 전달한다', async () => {
    const foreign = Object.assign(new Error('이미 정지 중입니다'), { name: 'BackendError', code: 'conflict' });
    const { backend } = fakeBackend(
      vi.fn(async () => {
        throw foreign;
      }) as unknown as Backend['invoke'],
    );
    const handler = createInvokeHandler({ backend, isTrustedSender: () => true, logger: fakeLogger() });
    await expect(handler(event, 'stop.emergency', [])).resolves.toEqual({ ok: false, error: { code: 'conflict', message: '이미 정지 중입니다' } });
  });

  it('그 밖의 오류는 internal + 한국어 일반 메시지로 바꾸고 전체 오류를 기록한다', async () => {
    const boom = new TypeError("Cannot read properties of undefined (reading 'id')");
    const { backend } = fakeBackend(
      vi.fn(async () => {
        throw boom;
      }) as unknown as Backend['invoke'],
    );
    const logger = fakeLogger();
    const handler = createInvokeHandler({ backend, isTrustedSender: () => true, logger });
    const res = await handler(event, 'members.getDetail', ['M-0001']);
    expect(res).toEqual({ ok: false, error: IPC_ERRORS.internal });
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('members.getDetail'), boom);
  });

  it('비밀 값을 담을 수 있는 인자는 기록하지 않는다', async () => {
    const { backend } = fakeBackend(
      vi.fn(async () => {
        throw new BackendError('invalid', 'API 키 형식이 올바르지 않습니다.');
      }) as unknown as Backend['invoke'],
    );
    const logger = fakeLogger();
    const handler = createInvokeHandler({ backend, isTrustedSender: () => true, logger });
    await handler(event, 'settings.setApiKey', ['claude', 'sk-ant-secret-value-123456']);
    const logged = JSON.stringify([...logger.warn.mock.calls, ...logger.error.mock.calls, ...logger.info.mock.calls]);
    expect(logged).not.toContain('sk-ant-secret-value-123456');
  });

  it('백엔드 준비를 기다렸다가 처리하고, 준비 실패면 backend_unavailable', async () => {
    let resolve!: (b: Backend) => void;
    const pending = new Promise<Backend>((r) => {
      resolve = r;
    });
    const { backend } = fakeBackend(vi.fn(async () => 'ready') as unknown as Backend['invoke']);
    const handler = createInvokeHandler({ backend: pending, isTrustedSender: () => true, logger: fakeLogger() });
    const early = handler(event, 'snapshot.get', []);
    resolve(backend);
    await expect(early).resolves.toEqual({ ok: true, value: 'ready' });

    const failed = Promise.reject(new Error('DB를 열 수 없음'));
    failed.catch(() => undefined);
    const logger = fakeLogger();
    const broken = createInvokeHandler({ backend: failed, isTrustedSender: () => true, logger });
    await expect(broken(event, 'snapshot.get', [])).resolves.toEqual({ ok: false, error: IPC_ERRORS.backendUnavailable });
    expect(logger.error).toHaveBeenCalled();
  });

  it('registerInvokeHandler는 IPC_INVOKE_CHANNEL에 처리기를 걸고 해제할 수 있다', async () => {
    const { backend } = fakeBackend(vi.fn(async () => 1) as unknown as Backend['invoke']);
    const dispose = registerInvokeHandler({ backend, isTrustedSender: () => true, logger: fakeLogger() });
    expect(electron.ipcMain.handle).toHaveBeenCalledWith(IPC_INVOKE_CHANNEL, expect.any(Function));
    const handler = electron.ipcMain.handle.mock.calls[0]![1] as (e: unknown, m: unknown, a: unknown) => Promise<unknown>;
    await expect(handler(event, 'snapshot.get', [])).resolves.toEqual({ ok: true, value: 1 });
    dispose();
    expect(electron.ipcMain.removeHandler).toHaveBeenCalledWith(IPC_INVOKE_CHANNEL);
  });
});

describe('IPC 발신자 확인', () => {
  const isAppUrl = (url: string) => url.startsWith('app://ok/');

  function setup(frame: { parent: unknown; url: string } | null) {
    const contents = {};
    const win = { isDestroyed: () => false, webContents: contents } as unknown as BrowserWindow;
    return { win, ev: { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent };
  }

  it('메인 창 최상위 프레임 + 앱 주소만 신뢰한다', () => {
    const { win, ev } = setup({ parent: null, url: 'app://ok/index.html' });
    expect(isTrustedIpcSender(ev, win, isAppUrl)).toBe(true);
  });

  it('다른 webContents, 하위 프레임, 다른 주소, 창 없음은 거부한다', () => {
    const { win } = setup({ parent: null, url: 'app://ok/index.html' });
    const other = { sender: {}, senderFrame: { parent: null, url: 'app://ok/index.html' } } as unknown as IpcMainInvokeEvent;
    expect(isTrustedIpcSender(other, win, isAppUrl)).toBe(false);

    const child = setup({ parent: {}, url: 'app://ok/index.html' });
    expect(isTrustedIpcSender(child.ev, child.win, isAppUrl)).toBe(false);

    const foreign = setup({ parent: null, url: 'https://evil.example/' });
    expect(isTrustedIpcSender(foreign.ev, foreign.win, isAppUrl)).toBe(false);

    const noFrame = setup(null);
    expect(isTrustedIpcSender(noFrame.ev, noFrame.win, isAppUrl)).toBe(false);

    const ok = setup({ parent: null, url: 'app://ok/index.html' });
    expect(isTrustedIpcSender(ok.ev, null, isAppUrl)).toBe(false);
    const destroyed = { isDestroyed: () => true, webContents: ok.win.webContents } as unknown as BrowserWindow;
    expect(isTrustedIpcSender(ok.ev, destroyed, isAppUrl)).toBe(false);
  });

  it('사라진 프레임 접근 예외는 거부로 처리한다', () => {
    const contents = {};
    const win = { isDestroyed: () => false, webContents: contents } as unknown as BrowserWindow;
    const ev = {
      sender: contents,
      get senderFrame(): never {
        throw new Error('Render frame was disposed before WebFrameMain could be accessed');
      },
    } as unknown as IpcMainInvokeEvent;
    expect(isTrustedIpcSender(ev, win, isAppUrl)).toBe(false);
  });
});

describe('푸시 주제 전달', () => {
  beforeEach(() => vi.clearAllMocks());

  it('모든 IPC_TOPICS를 구독하고 접두어를 붙여 창으로 보낸다', () => {
    const { backend, emit } = fakeBackend();
    const { win, send } = fakeWindow();
    forwardTopics({ backend, getWindow: () => win, logger: fakeLogger() });
    expect((backend.onTopic as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])).toEqual([...IPC_TOPICS]);
    IPC_TOPICS.forEach((topic, i) => emit(topic, { n: i }));
    expect(send.mock.calls).toEqual(IPC_TOPICS.map((topic, i) => [IPC_TOPIC_PREFIX + topic, { n: i }]));
  });

  it('창이 없거나 닫혔거나 화면이 죽었으면 보내지 않는다', () => {
    const { backend, emit } = fakeBackend();
    let current: BrowserWindow | null = null;
    forwardTopics({ backend, getWindow: () => current, logger: fakeLogger() });
    emit('snapshot', {});

    for (const opts of [{ destroyed: true }, { contentsDestroyed: true }, { crashed: true }]) {
      const { win, send } = fakeWindow(opts);
      current = win;
      emit('snapshot', {});
      expect(send).not.toHaveBeenCalled();
    }
  });

  it('같은 긴급 정지 요약(at 같음)은 한 번만 보낸다 (백엔드 푸시 + 트레이 경로)', () => {
    const { win, send } = fakeWindow();
    const logger = fakeLogger();
    const summary = { at: '2026-10-27T01:00:00.000Z', completed: true, stoppedTurns: [], heldTasks: [], failures: [] };
    expect(sendTopic(win, 'emergency', summary, logger)).toBe(true);
    expect(sendTopic(win, 'emergency', { ...summary }, logger)).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    sendTopic(win, 'emergency', { ...summary, at: '2026-10-27T02:00:00.000Z' }, logger);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('보내기 실패는 기록하고 예외를 밖으로 내지 않는다', () => {
    const logger = fakeLogger();
    const { win } = fakeWindow({ sendThrows: true });
    expect(sendTopic(win, 'notification' as WookTopic, {} as never, logger)).toBe(false);
    expect(logger.error).toHaveBeenCalled();
  });

  it('해제하면 모든 구독이 풀린다', () => {
    const { backend, emit, listeners } = fakeBackend();
    const { win, send } = fakeWindow();
    const dispose = forwardTopics({ backend, getWindow: () => win, logger: fakeLogger() });
    dispose();
    for (const topic of IPC_TOPICS) expect(listeners.get(topic)?.size ?? 0).toBe(0);
    emit('snapshot', {});
    expect(send).not.toHaveBeenCalled();
  });
});
