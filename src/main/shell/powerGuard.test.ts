/**
 * powerGuard (리드 결정 S9-5): 절전 방지의 판단 — 진행 중 작업 && execution.preventSleep일 때만 Blocker.start, 아니면 stop. Electron 없이 돈다
 * (데스크톱의 shell/power.ts와 서버의 src/server/power.ts가 같은 판단을 쓴다)
 */
import { describe, expect, it, vi, type Mock } from 'vitest';
import type { Logger } from './logger';
import { createGuard } from './powerGuard';

function setup(initial: { active: boolean; enabled: boolean }, override: { start?: Mock<() => void> } = {}) {
  const state = { ...initial };
  let onChange: ((active: boolean) => void) | null = null;
  let started = false;
  const blocker = {
    start:
      override.start ??
      vi.fn<() => void>(() => {
        started = true;
      }),
    stop: vi.fn<() => void>(() => {
      started = false;
    }),
    isStarted: vi.fn<() => boolean>(() => started),
  };
  const backend = {
    hasActiveWork: vi.fn(() => state.active),
    preventSleepEnabled: vi.fn(() => state.enabled),
    onActiveWorkChange: vi.fn((cb: (active: boolean) => void) => {
      onChange = cb;
      return () => {
        onChange = null;
      };
    }),
  };
  const logger = { info: vi.fn<Logger['info']>(), warn: vi.fn<Logger['warn']>(), error: vi.fn<Logger['error']>() };
  const guard = createGuard({ backend, logger, blocker });
  const setActive = (active: boolean) => {
    state.active = active;
    onChange?.(active);
  };
  return { guard, state, setActive, blocker, backend, logger, isSubscribed: () => onChange !== null, setStarted: (v: boolean) => (started = v) };
}

describe('powerGuard — 절전 방지 판단', () => {
  it('만들 때 한 번 맞춘다 — 작업이 있고 설정이 켜져 있으면 바로 막는다', () => {
    const { guard, blocker } = setup({ active: true, enabled: true });
    expect([guard.blocking, blocker.start.mock.calls.length]).toEqual([true, 1]);
  });

  it('작업이 시작되면 막고, 같은 신호가 또 와도 다시 시작하지 않으며, 작업이 끝나면 푼다', () => {
    const { guard, blocker, setActive } = setup({ active: false, enabled: true });
    expect([guard.blocking, blocker.start.mock.calls.length]).toEqual([false, 0]);
    setActive(true);
    setActive(true);
    expect([guard.blocking, blocker.start.mock.calls.length]).toEqual([true, 1]);
    setActive(false);
    expect([guard.blocking, blocker.stop.mock.calls.length]).toEqual([false, 1]);
    // 풀린 뒤의 '작업 없음'은 다시 stop하지 않는다
    setActive(false);
    expect(blocker.stop).toHaveBeenCalledTimes(1);
  });

  it('설정(execution.preventSleep)이 꺼져 있으면 작업이 있어도 막지 않고, update()가 설정을 다시 읽는다', () => {
    const { guard, blocker, state } = setup({ active: true, enabled: false });
    expect([guard.blocking, blocker.start.mock.calls.length]).toEqual([false, 0]);
    state.enabled = true;
    guard.update();
    expect(guard.blocking).toBe(true);
    state.enabled = false;
    guard.update();
    expect([guard.blocking, blocker.stop.mock.calls.length]).toEqual([false, 1]);
  });

  it('막는 쪽이 스스로 풀렸으면(isStarted false) 다음 update()에서 다시 시작한다', () => {
    const { guard, blocker, setStarted } = setup({ active: true, enabled: true });
    setStarted(false);
    guard.update();
    expect([guard.blocking, blocker.start.mock.calls.length]).toEqual([true, 2]);
  });

  it('start가 던지면 막지 않은 것으로 보고 기록한다 — 다음 update()가 다시 해 본다', () => {
    let fails = 1;
    const { guard, logger, blocker } = setup(
      { active: true, enabled: true },
      {
        start: vi.fn(() => {
          if (fails-- > 0) throw new Error('막지 못함');
        }),
      },
    );
    expect(guard.blocking).toBe(false);
    expect(logger.error).toHaveBeenCalledWith('절전 방지를 시작하지 못했습니다', expect.any(Error));
    guard.update();
    expect([guard.blocking, blocker.start.mock.calls.length]).toEqual([true, 2]);
  });

  it('조건을 읽다 던지면 기록만 하고 상태를 바꾸지 않는다', () => {
    const { guard, backend, logger, blocker } = setup({ active: true, enabled: true });
    backend.hasActiveWork.mockImplementation(() => {
      throw new Error('읽지 못함');
    });
    guard.update();
    expect([guard.blocking, blocker.stop.mock.calls.length]).toEqual([true, 0]);
    expect(logger.error).toHaveBeenCalledWith('절전 방지 조건을 읽지 못했습니다', expect.any(Error));
  });

  it('dispose하면 구독을 풀고 막기를 풀며, 그 뒤의 update()·신호는 아무것도 하지 않는다', () => {
    const { guard, blocker, isSubscribed, setActive } = setup({ active: true, enabled: true });
    guard.dispose();
    expect([isSubscribed(), guard.blocking, blocker.stop.mock.calls.length]).toEqual([false, false, 1]);
    guard.update();
    setActive(true);
    guard.dispose();
    expect([blocker.start.mock.calls.length, blocker.stop.mock.calls.length]).toEqual([1, 1]);
  });
});
