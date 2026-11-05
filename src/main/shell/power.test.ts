import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from './logger';

const electron = vi.hoisted(() => {
  const started = new Set<number>();
  let next = 1;
  return {
    started,
    powerSaveBlocker: {
      start: vi.fn((_type: string) => {
        const id = next++;
        started.add(id);
        return id;
      }),
      stop: vi.fn((id: number) => started.delete(id)),
      isStarted: vi.fn((id: number) => started.has(id)),
    },
  };
});
vi.mock('electron', () => ({ powerSaveBlocker: electron.powerSaveBlocker }));

import { createPowerGuard } from './power';

function setup(initial: { active: boolean; enabled: boolean }) {
  const state = { ...initial };
  let onChange: ((active: boolean) => void) | null = null;
  const backend = {
    hasActiveWork: () => state.active,
    preventSleepEnabled: () => state.enabled,
    onActiveWorkChange: vi.fn((cb: (active: boolean) => void) => {
      onChange = cb;
      return () => {
        onChange = null;
      };
    }),
  };
  const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const guard = createPowerGuard({ backend, logger });
  const setActive = (active: boolean) => {
    state.active = active;
    onChange?.(active);
  };
  return { guard, state, setActive, isSubscribed: () => onChange !== null };
}

describe('절전 방지 (ENV-11)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    electron.started.clear();
  });

  it('작업이 진행 중이고 설정이 켜져 있을 때만 prevent-app-suspension으로 막는다', () => {
    const { guard, setActive } = setup({ active: false, enabled: true });
    expect(guard.blocking).toBe(false);
    setActive(true);
    expect(electron.powerSaveBlocker.start).toHaveBeenCalledWith('prevent-app-suspension');
    expect(guard.blocking).toBe(true);
    setActive(true);
    expect(electron.powerSaveBlocker.start).toHaveBeenCalledTimes(1);
    setActive(false);
    expect(electron.powerSaveBlocker.stop).toHaveBeenCalledTimes(1);
    expect(guard.blocking).toBe(false);
  });

  it('설정을 끄면 update()에서 해제하고, 켜면 다시 막는다', () => {
    const { guard, state } = setup({ active: true, enabled: true });
    expect(guard.blocking).toBe(true);
    state.enabled = false;
    guard.update();
    expect(guard.blocking).toBe(false);
    state.enabled = true;
    guard.update();
    expect(guard.blocking).toBe(true);
    expect(electron.powerSaveBlocker.start).toHaveBeenCalledTimes(2);
  });

  it('dispose하면 구독을 풀고 막기를 해제한다', () => {
    const { guard, isSubscribed } = setup({ active: true, enabled: true });
    guard.dispose();
    expect(isSubscribed()).toBe(false);
    expect(electron.started.size).toBe(0);
  });
});
