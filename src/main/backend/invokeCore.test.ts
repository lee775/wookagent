/**
 * 요청 처리 공용 부분 (SERVER_DESIGN 3.4, S2-8): 데스크톱 IPC와 서버 HTTP가 같이 쓴다 — electron 없이 돈다.
 * 허용 목록·인자 형식·오류 바꾸기·BackendError 판별·인자를 기록하지 않는 규칙을 본다. 발신자 확인은 길마다 따로다(shell/ipc.test.ts).
 */
import { describe, expect, it, vi } from 'vitest';
import { IPC_METHODS } from '@shared/ipc';
import { BackendError, type Backend } from './types';
import type { Logger } from '../shell/logger';

// 서버 프로세스에는 electron이 없다 — 이 모듈(과 그 의존)이 electron을 불러오면 이 시험이 실패한다
vi.mock('electron', () => {
  throw new Error('invokeCore는 electron 없이 돌아야 합니다 (서버 HTTP와 같이 쓴다)');
});

import { createInvokeCore, INVOKE_ERRORS, isBackendError, methodLabel, UNKNOWN_METHOD_LABEL } from './invokeCore';

const SECRET = 'sk-ant-api03-invoke-core-secret-0123456789';

function setup(invoke: (method: string, args: unknown[]) => Promise<unknown>, channel = 'HTTP') {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } satisfies Logger;
  const spy = vi.fn(invoke);
  const backend = { invoke: spy } as unknown as Pick<Backend, 'invoke'>;
  return { handle: createInvokeCore({ backend, logger, channel }), logger, spy };
}
const logged = (logger: Logger) =>
  JSON.stringify([...(logger.info as ReturnType<typeof vi.fn>).mock.calls, ...(logger.warn as ReturnType<typeof vi.fn>).mock.calls, ...(logger.error as ReturnType<typeof vi.fn>).mock.calls], (_k, v: unknown) =>
    v instanceof Error ? { name: v.name, message: v.message } : v,
  );

describe('요청 처리 공용 부분 (invokeCore)', () => {
  it('허용 목록의 메서드는 인자 배열과 함께 백엔드에 넘기고 { ok: true, value }로 답한다', async () => {
    const { handle, spy } = setup(async () => ({ version: 7 }));
    await expect(handle('snapshot.get', [])).resolves.toEqual({ ok: true, value: { version: 7 } });
    await expect(handle('tasks.interrupt', ['T-0001', 'hold'])).resolves.toEqual({ ok: true, value: { version: 7 } });
    expect(spy.mock.calls).toEqual([
      ['snapshot.get', []],
      ['tasks.interrupt', ['T-0001', 'hold']],
    ]);
  });

  it('허용 목록(IPC_METHODS)에 없는 이름은 백엔드를 부르지 않고 unknown_method — 객체 기본 속성 이름도', async () => {
    const { handle, spy, logger } = setup(async () => 1);
    for (const m of ['system.exec', 'system.pickFolder', 'constructor', '__proto__', 'hasOwnProperty', 42, null, undefined, { m: 1 }]) {
      await expect(handle(m, [SECRET])).resolves.toEqual({ ok: false, error: INVOKE_ERRORS.unknownMethod });
    }
    expect(spy).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith('허용 목록에 없는 HTTP 메서드를 거부했습니다: system.exec');
    expect(logger.warn).toHaveBeenCalledWith('허용 목록에 없는 HTTP 메서드를 거부했습니다: (number)');
    // 허용 목록은 화면 약속 그대로다
    for (const m of IPC_METHODS) expect(methodLabel(m)).toBe(m);
  });

  it('인자가 배열이 아니면 백엔드를 부르지 않고 invalid_args', async () => {
    const { handle, spy } = setup(async () => 1);
    for (const args of [{ 0: 'x' }, 'x', null, undefined, 3]) {
      await expect(handle('snapshot.get', args)).resolves.toEqual({ ok: false, error: INVOKE_ERRORS.invalidArgs });
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('BackendError는 code·한국어 메시지를 그대로 — 다른 모듈 사본(이름·code로 판별)도', async () => {
    const { handle, logger } = setup(async (m) => {
      if (m === 'tasks.get') throw new BackendError('not_found', '작업을 찾을 수 없습니다: T-0009');
      throw Object.assign(new Error('이미 정지 중입니다'), { name: 'BackendError', code: 'conflict' });
    });
    await expect(handle('tasks.get', ['T-0009'])).resolves.toEqual({ ok: false, error: { code: 'not_found', message: '작업을 찾을 수 없습니다: T-0009' } });
    await expect(handle('stop.emergency', [])).resolves.toEqual({ ok: false, error: { code: 'conflict', message: '이미 정지 중입니다' } });
    expect(logger.warn).toHaveBeenCalledWith('HTTP 요청 실패: tasks.get [not_found] 작업을 찾을 수 없습니다: T-0009');
    expect(logger.error).not.toHaveBeenCalled();
    // code가 없거나 메시지가 빈 같은 이름의 오류는 BackendError가 아니다
    expect(isBackendError(Object.assign(new Error('x'), { name: 'BackendError' }))).toBe(false);
    expect(isBackendError(Object.assign(new Error(''), { name: 'BackendError', code: 'x' }))).toBe(false);
  });

  it('그 밖의 오류는 internal과 일반 메시지로 바꾸고, 메서드 이름과 오류를 기록한다', async () => {
    const boom = new TypeError("Cannot read properties of undefined (reading 'id')");
    const { handle, logger } = setup(async () => {
      throw boom;
    });
    await expect(handle('members.getDetail', ['M-0001'])).resolves.toEqual({ ok: false, error: INVOKE_ERRORS.internal });
    expect(logger.error).toHaveBeenCalledWith('HTTP 요청 처리 중 예기치 않은 오류: members.getDetail', boom);
  });

  it('인자는 어느 길로도 기록하지 않는다 (비밀 값을 담을 수 있다, SEC-10)', async () => {
    const { handle, logger } = setup(async (m) => {
      if (m === 'settings.setApiKey') throw new BackendError('invalid', 'API 키 형식이 올바르지 않습니다.');
      throw new Error('예기치 않음');
    });
    await handle('settings.setApiKey', ['claude', SECRET]);
    await handle('command.send', [{ target: 'main', text: SECRET }]);
    await handle('system.exec', [SECRET]);
    await handle('snapshot.get', { secret: SECRET });
    expect(logger.warn).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
    expect(logged(logger)).not.toContain(SECRET);
  });

  it('백엔드 준비를 기다렸다가 처리하고, 준비 실패면 backend_unavailable', async () => {
    let resolve!: (b: Pick<Backend, 'invoke'>) => void;
    const pending = new Promise<Pick<Backend, 'invoke'>>((r) => (resolve = r));
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } satisfies Logger;
    const early = createInvokeCore({ backend: pending, logger, channel: 'IPC' })('snapshot.get', []);
    resolve({ invoke: (async () => 'ready') as unknown as Backend['invoke'] });
    await expect(early).resolves.toEqual({ ok: true, value: 'ready' });

    const failed = Promise.reject(new Error('DB를 열 수 없음'));
    failed.catch(() => undefined);
    const broken = createInvokeCore({ backend: failed, logger, channel: 'IPC' });
    await expect(broken('snapshot.get', [])).resolves.toEqual({ ok: false, error: INVOKE_ERRORS.backendUnavailable });
    expect(logger.error).toHaveBeenCalledWith('백엔드를 쓸 수 없어 IPC 요청을 처리하지 못했습니다: snapshot.get', expect.any(Error));
  });

  it('메서드 이름 표시: 길면 80자로 자르고, 문자열이 아니면 형식만', () => {
    expect(methodLabel('a'.repeat(200))).toBe('a'.repeat(80));
    expect(methodLabel(undefined)).toBe('(undefined)');
    expect(methodLabel({})).toBe('(object)');
  });
});

describe('원격 호출자 — 부른 쪽의 글을 기록하지 않는다 (S2-13, omitCallerText)', () => {
  const MARK = 'WOOK-CALLER-MARK-31d7';

  function remote(invoke: (method: string, args: unknown[]) => Promise<unknown>) {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } satisfies Logger;
    const backend = { invoke: vi.fn(invoke) } as unknown as Pick<Backend, 'invoke'>;
    return { handle: createInvokeCore({ backend, logger, channel: 'HTTP', omitCallerText: true }), logger };
  }

  it('인자를 되풀이하는 오류 메시지와 모르는 메서드 이름은 기록하지 않고 아는 메서드 이름과 code만 남긴다 — 응답에는 메시지가 그대로', async () => {
    const { handle, logger } = remote(async (_m, args) => {
      throw new BackendError('not_found', `팀원 ${String(args[0])}을(를) 찾을 수 없습니다`);
    });
    const echo = `${MARK}\n2026-10-30T00:00:00.000Z [INFO] 가짜 줄`;
    await expect(handle('members.getDetail', [echo])).resolves.toEqual({ ok: false, error: { code: 'not_found', message: `팀원 ${echo}을(를) 찾을 수 없습니다` } });
    await expect(handle(`${MARK}\n가짜 메서드`, [])).resolves.toEqual({ ok: false, error: INVOKE_ERRORS.unknownMethod });
    expect(logger.warn.mock.calls).toEqual([['HTTP 요청 실패: members.getDetail [not_found]'], [`허용 목록에 없는 HTTP 메서드를 거부했습니다: ${UNKNOWN_METHOD_LABEL}`]]);
    expect(UNKNOWN_METHOD_LABEL).toBe('(알 수 없는 메서드)');
    expect(logged(logger)).not.toContain(MARK);
  });

  it('예기치 않은 오류는 오류 종류와 스택 줄만 — 메시지(부른 쪽의 글이 섞일 수 있다)와 스택 줄처럼 꾸민 메시지는 남기지 않는다', async () => {
    const { handle, logger } = remote(async (_m, args) => {
      throw new TypeError(`${String(args[0])} is not a function\n    at FORGED-${MARK} (evil.js:1:1)`);
    });
    await expect(handle('tasks.get', [MARK])).resolves.toEqual({ ok: false, error: INVOKE_ERRORS.internal });
    expect(logger.error).toHaveBeenCalledTimes(1);
    const [message, frames] = logger.error.mock.calls[0] as [string, string];
    expect(message).toBe('HTTP 요청 처리 중 예기치 않은 오류: tasks.get [internal] TypeError');
    expect(frames).toMatch(/^\s+at /);
    expect(frames).toContain('invokeCore.test.ts');
    expect(logged(logger)).not.toContain(MARK);
  });

  it('데스크톱 IPC(끄면)는 예전 기록 그대로 — 메시지와 모르는 이름을 남긴다', async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } satisfies Logger;
    const backend = { invoke: async () => Promise.reject(new BackendError('not_found', `작업 ${MARK}`)) } as unknown as Pick<Backend, 'invoke'>;
    const handle = createInvokeCore({ backend, logger, channel: 'IPC' });
    await handle('tasks.get', [MARK]);
    await handle(`${MARK}.x`, []);
    expect(logger.warn.mock.calls).toEqual([[`IPC 요청 실패: tasks.get [not_found] 작업 ${MARK}`], [`허용 목록에 없는 IPC 메서드를 거부했습니다: ${MARK}.x`]]);
  });
});
