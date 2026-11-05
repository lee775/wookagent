import { describe, expect, it, vi } from 'vitest';
import type { Logger } from './logger';
import { createQuitFlow, type QuitFlowDeps } from './quit';

function setup(over: Partial<QuitFlowDeps> = {}) {
  const order: string[] = [];
  const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const deps: QuitFlowDeps = {
    hasActiveWork: vi.fn(() => false),
    confirm: vi.fn(async () => true),
    beforeShutdown: vi.fn(() => void order.push('beforeShutdown')),
    shutdown: vi.fn(async () => void order.push('shutdown')),
    cleanup: vi.fn(() => void order.push('cleanup')),
    exit: vi.fn((code: number) => void order.push(`exit:${code}`)),
    logger,
    ...over,
  };
  return { flow: createQuitFlow(deps), deps, order, logger };
}

describe('완전 종료 (ENV-09)', () => {
  it('진행 중인 작업이 없으면 묻지 않고 정리 후 코드 0으로 끝낸다', async () => {
    const { flow, deps, order } = setup();
    await expect(flow.request({ confirm: true, reason: 'tray' })).resolves.toBe(true);
    expect(deps.confirm).not.toHaveBeenCalled();
    expect(order).toEqual(['beforeShutdown', 'shutdown', 'cleanup', 'exit:0']);
    expect(flow.phase).toBe('shutting_down');
  });

  it('진행 중인 작업이 있으면 확인하고, 취소하면 아무것도 하지 않는다', async () => {
    const { flow, deps } = setup({ hasActiveWork: () => true, confirm: vi.fn(async () => false) });
    await expect(flow.request({ confirm: true, reason: 'tray' })).resolves.toBe(false);
    expect(deps.confirm).toHaveBeenCalledTimes(1);
    expect(deps.shutdown).not.toHaveBeenCalled();
    expect(deps.exit).not.toHaveBeenCalled();
    expect(flow.phase).toBe('running');
  });

  it('진행 중인 작업이 있고 [종료]를 고르면 체크포인트(shutdown) 후 끝낸다', async () => {
    const { flow, order } = setup({ hasActiveWork: () => true });
    await expect(flow.request({ confirm: true, reason: 'tray' })).resolves.toBe(true);
    expect(order).toEqual(['beforeShutdown', 'shutdown', 'cleanup', 'exit:0']);
  });

  it('OS 종료처럼 확인할 수 없으면 묻지 않는다', async () => {
    const { flow, deps } = setup({ hasActiveWork: () => true });
    await flow.request({ confirm: false, reason: 'session-end' });
    expect(deps.confirm).not.toHaveBeenCalled();
    expect(deps.shutdown).toHaveBeenCalledTimes(1);
  });

  it('여러 번 요청해도 정리는 한 번만 한다', async () => {
    const { flow, deps } = setup();
    await Promise.all([flow.request({ confirm: true, reason: 'a' }), flow.request({ confirm: false, reason: 'b' }), flow.request({ confirm: true, reason: 'c' })]);
    expect(deps.shutdown).toHaveBeenCalledTimes(1);
    expect(deps.exit).toHaveBeenCalledTimes(1);
  });

  it('확인 창이 떠 있는 동안 OS 종료가 오면 바로 정리하고, 이후 확인 결과는 무시한다', async () => {
    let answer!: (ok: boolean) => void;
    const { flow, deps } = setup({
      hasActiveWork: () => true,
      confirm: () =>
        new Promise<boolean>((r) => {
          answer = r;
        }),
    });
    const asked = flow.request({ confirm: true, reason: 'tray' });
    expect(flow.phase).toBe('confirming');
    await flow.request({ confirm: false, reason: 'session-end' });
    answer(false);
    await expect(asked).resolves.toBe(true);
    expect(deps.shutdown).toHaveBeenCalledTimes(1);
    expect(deps.exit).toHaveBeenCalledTimes(1);
  });

  it('정리 중 오류가 나도 자원을 정리하고 코드 1로 끝낸다', async () => {
    const { flow, order, logger } = setup({
      shutdown: async () => {
        throw new Error('DB 닫기 실패');
      },
    });
    await flow.request({ confirm: false, reason: 'tray' });
    expect(order).toEqual(['beforeShutdown', 'cleanup', 'exit:1']);
    expect(logger.error).toHaveBeenCalled();
  });

  it('정리가 시간 안에 끝나지 않으면 강제로 끝낸다', async () => {
    vi.useFakeTimers();
    try {
      const { flow, deps } = setup({ shutdown: () => new Promise<void>(() => undefined), timeoutMs: 5_000 });
      const done = flow.request({ confirm: false, reason: 'tray' });
      await vi.advanceTimersByTimeAsync(5_000);
      await done;
      expect(deps.exit).toHaveBeenCalledWith(1);
      expect(deps.cleanup).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('확인 창을 띄우지 못하면 종료하지 않는다', async () => {
    const { flow, deps } = setup({
      hasActiveWork: () => true,
      confirm: async () => {
        throw new Error('dialog 실패');
      },
    });
    await expect(flow.request({ confirm: true, reason: 'tray' })).resolves.toBe(false);
    expect(deps.shutdown).not.toHaveBeenCalled();
  });
});
