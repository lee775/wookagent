import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from './logger';

const electron = vi.hoisted(() => {
  const registered = new Map<string, () => void>();
  const taken = new Set<string>();
  return {
    registered,
    taken,
    globalShortcut: {
      register: vi.fn((acc: string, cb: () => void) => {
        if (acc === 'Nope+') throw new TypeError('conversion failure from Nope+');
        if (taken.has(acc)) return false;
        registered.set(acc, cb);
        return true;
      }),
      unregister: vi.fn((acc: string) => void registered.delete(acc)),
      isRegistered: vi.fn((acc: string) => registered.has(acc)),
    },
  };
});
vi.mock('electron', () => ({ globalShortcut: electron.globalShortcut }));

import { createEmergencyShortcut } from './shortcuts';

function setup(accelerator: string) {
  const setting = { value: accelerator };
  const onTrigger = vi.fn();
  const notify = vi.fn();
  const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const shortcut = createEmergencyShortcut({ getAccelerator: () => setting.value, onTrigger, notify, logger });
  return { shortcut, setting, onTrigger, notify, logger };
}

describe('긴급 정지 전역 단축키 (CTL-02)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    electron.registered.clear();
    electron.taken.clear();
  });

  it('설정값으로 등록하고, 누르면 긴급 정지를 부른다', () => {
    const { shortcut, onTrigger } = setup('CommandOrControl+Alt+Shift+S');
    expect(shortcut.register()).toBe(true);
    expect(shortcut.accelerator).toBe('CommandOrControl+Alt+Shift+S');
    electron.registered.get('CommandOrControl+Alt+Shift+S')!();
    expect(onTrigger).toHaveBeenCalledTimes(1);
  });

  it('다른 프로그램이 쓰고 있으면 기록하고 OS 알림을 띄운다', () => {
    electron.taken.add('CommandOrControl+Alt+Shift+S');
    const { shortcut, notify, logger } = setup('CommandOrControl+Alt+Shift+S');
    expect(shortcut.register()).toBe(false);
    expect(shortcut.accelerator).toBeNull();
    expect(logger.error).toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: '긴급 정지 단축키를 등록하지 못했습니다' }));
  });

  it('형식이 틀린 단축키(예외)도 같은 방식으로 알린다', () => {
    const { shortcut, notify } = setup('Nope+');
    expect(shortcut.register()).toBe(false);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('설정이 바뀌었을 때만 다시 등록하고, 같은 실패를 반복해서 알리지 않는다', () => {
    electron.taken.add('Ctrl+Alt+X');
    const { shortcut, setting, notify } = setup('Ctrl+Alt+X');
    shortcut.register();
    shortcut.syncWithSettings();
    shortcut.syncWithSettings();
    expect(notify).toHaveBeenCalledTimes(1);
    setting.value = 'Ctrl+Alt+Y';
    shortcut.syncWithSettings();
    expect(shortcut.accelerator).toBe('Ctrl+Alt+Y');
    setting.value = 'Ctrl+Alt+Z';
    shortcut.syncWithSettings();
    expect(electron.registered.has('Ctrl+Alt+Y')).toBe(false);
    expect(electron.registered.has('Ctrl+Alt+Z')).toBe(true);
  });

  it('unregister는 등록한 단축키를 푼다', () => {
    const { shortcut } = setup('Ctrl+Alt+Q');
    shortcut.register();
    shortcut.unregister();
    expect(electron.registered.size).toBe(0);
    expect(shortcut.accelerator).toBeNull();
  });
});
