import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from './logger';

type Handler = (...args: unknown[]) => void;

const electron = vi.hoisted(() => {
  const created: FakeNotification[] = [];
  const state = { supported: true, showThrows: false };
  class FakeNotification {
    static isSupported() {
      return state.supported;
    }
    handlers = new Map<string, Handler>();
    shown = 0;
    constructor(public options: Record<string, unknown>) {
      created.push(this);
    }
    on(event: string, cb: Handler) {
      this.handlers.set(event, cb);
      return this;
    }
    show() {
      if (state.showThrows) throw new Error('toast 실패');
      this.shown++;
    }
  }
  return { created, state, Notification: FakeNotification };
});
vi.mock('electron', () => ({ Notification: electron.Notification }));

import { createOsNotifier } from './notifications';

function setup() {
  const focusWindow = vi.fn();
  const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { notifier: createOsNotifier({ focusWindow, logger }), focusWindow, logger };
}

describe('OS 알림 (12장)', () => {
  beforeEach(() => {
    electron.created.length = 0;
    electron.state.supported = true;
    electron.state.showThrows = false;
  });

  it('긴급은 소리를 내고 오래 남는다, 일반은 무음', () => {
    const { notifier } = setup();
    notifier.show({ level: 'urgent', title: '인증 만료', body: 'Claude 다시 로그인 필요' });
    notifier.show({ level: 'normal', title: '보고서 도착', body: 'D-0001' });
    const [urgent, normal] = electron.created;
    expect(urgent!.options).toMatchObject({ title: '인증 만료', body: 'Claude 다시 로그인 필요', silent: false, urgency: 'critical', timeoutType: 'never' });
    expect(normal!.options).toMatchObject({ title: '보고서 도착', silent: true, urgency: 'normal', timeoutType: 'default' });
    expect(urgent!.shown).toBe(1);
    expect(normal!.shown).toBe(1);
  });

  it('클릭하면 창을 앞으로 가져오고 onClick을 부른다', () => {
    const { notifier, focusWindow } = setup();
    const onClick = vi.fn();
    notifier.show({ level: 'normal', title: 't', body: 'b', onClick });
    electron.created[0]!.handlers.get('click')!({});
    expect(focusWindow).toHaveBeenCalledTimes(1);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('onClick 오류·표시 실패는 기록하고 던지지 않는다', () => {
    const { notifier, logger } = setup();
    notifier.show({
      level: 'normal',
      title: 't',
      body: 'b',
      onClick: () => {
        throw new Error('이동 실패');
      },
    });
    expect(() => electron.created[0]!.handlers.get('click')!({})).not.toThrow();
    electron.created[0]!.handlers.get('failed')!({}, 'toast error');
    electron.state.showThrows = true;
    expect(() => notifier.show({ level: 'urgent', title: 'x', body: 'y' })).not.toThrow();
    expect(logger.error).toHaveBeenCalledTimes(3);
  });

  it('알림을 지원하지 않으면 만들지 않고 경고만 남긴다', () => {
    electron.state.supported = false;
    const { notifier, logger } = setup();
    notifier.show({ level: 'urgent', title: 't', body: 'b' });
    expect(electron.created).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalled();
  });
});
