import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TrayStatus } from '@shared/views';
import type { Logger } from './logger';

type Handler = (...args: unknown[]) => void;
interface FakeImage {
  buffer: Buffer;
  opts: { width: number; height: number; scaleFactor?: number };
  reps: { scaleFactor?: number; width?: number; height?: number; buffer?: Buffer }[];
  addRepresentation(rep: FakeImage['reps'][number]): void;
}
interface MenuItem {
  label?: string;
  type?: string;
  click?: () => void;
}

const electron = vi.hoisted(() => {
  const trays: FakeTray[] = [];
  class FakeTray {
    image: unknown;
    tooltip = '';
    menu: MenuItem[] | null = null;
    handlers = new Map<string, Handler>();
    destroyed = false;
    constructor(image: unknown) {
      this.image = image;
      trays.push(this);
    }
    setToolTip(t: string) {
      this.tooltip = t;
    }
    setContextMenu(menu: MenuItem[]) {
      this.menu = menu;
    }
    setImage(image: unknown) {
      this.image = image;
    }
    on(event: string, cb: Handler) {
      this.handlers.set(event, cb);
      return this;
    }
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      this.destroyed = true;
    }
  }
  return {
    trays,
    Tray: FakeTray,
    Menu: { buildFromTemplate: vi.fn((template: MenuItem[]) => template) },
    nativeImage: {
      createFromBitmap: vi.fn((buffer: Buffer, opts: FakeImage['opts']): FakeImage => {
        const img: FakeImage = {
          buffer,
          opts,
          reps: [],
          addRepresentation(rep) {
            img.reps.push(rep);
          },
        };
        return img;
      }),
    },
  };
});
vi.mock('electron', () => ({ Tray: electron.Tray, Menu: electron.Menu, nativeImage: electron.nativeImage }));

import { createTray, trayTooltip } from './tray';

function setup(initial: TrayStatus = 'normal') {
  let listener: ((s: TrayStatus) => void) | null = null;
  const backend = {
    getTrayStatus: () => initial,
    onTrayStatus: vi.fn((cb: (s: TrayStatus) => void) => {
      listener = cb;
      return () => {
        listener = null;
      };
    }),
  };
  const handlers = { onOpenWindow: vi.fn(), onEmergency: vi.fn(), onQuit: vi.fn() };
  const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const controller = createTray({ backend, ...handlers, logger });
  const tray = electron.trays.at(-1)!;
  return { controller, tray, handlers, logger, push: (s: TrayStatus) => listener?.(s), subscribed: () => listener !== null };
}

describe('트레이', () => {
  beforeEach(() => {
    electron.trays.length = 0;
    vi.clearAllMocks();
  });

  it('상태 문구 툴팁과 16px(배율 1)+32px(배율 2) 아이콘으로 시작한다', () => {
    const { tray } = setup('awaiting');
    expect(tray.tooltip).toBe('욱채 — 답변 대기');
    const img = tray.image as FakeImage;
    expect(img.opts).toEqual({ width: 16, height: 16, scaleFactor: 1 });
    expect(img.buffer.length).toBe(16 * 16 * 4);
    expect(img.reps).toEqual([expect.objectContaining({ scaleFactor: 2, width: 32, height: 32 })]);
  });

  it('툴팁 문구는 정상·답변 대기·일시정지·오류·긴급 정지', () => {
    expect((['normal', 'awaiting', 'paused', 'error', 'emergency'] as const).map(trayTooltip)).toEqual([
      '욱채 — 정상',
      '욱채 — 답변 대기',
      '욱채 — 일시정지',
      '욱채 — 오류',
      '욱채 — 긴급 정지',
    ]);
  });

  it('메뉴는 창 열기 · 긴급 정지 · 구분선 · 완전 종료이고 각각 연결된다', () => {
    const { tray, handlers } = setup();
    const menu = tray.menu!;
    expect(menu.map((m) => m.label ?? m.type)).toEqual(['창 열기', '긴급 정지', 'separator', '완전 종료']);
    menu[0]!.click!();
    menu[1]!.click!();
    menu[3]!.click!();
    expect(handlers.onOpenWindow).toHaveBeenCalledTimes(1);
    expect(handlers.onEmergency).toHaveBeenCalledTimes(1);
    expect(handlers.onQuit).toHaveBeenCalledTimes(1);
  });

  it('더블클릭하면 창을 연다', () => {
    const { tray, handlers } = setup();
    tray.handlers.get('double-click')!();
    expect(handlers.onOpenWindow).toHaveBeenCalledTimes(1);
  });

  it('백엔드 상태가 바뀌면 아이콘·툴팁을 바꾼다', () => {
    const { tray, push, controller } = setup('normal');
    const before = tray.image;
    push('emergency');
    expect(tray.image).not.toBe(before);
    expect(tray.tooltip).toBe('욱채 — 긴급 정지');
    expect(controller.status).toBe('emergency');
  });

  it('종료 중 문구는 상태 변화로 덮이지 않는다', () => {
    const { tray, push, controller } = setup('normal');
    controller.setBusyText('종료 중…');
    push('error');
    expect(tray.tooltip).toBe('욱채 — 종료 중…');
    controller.setBusyText(null);
    expect(tray.tooltip).toBe('욱채 — 오류');
  });

  it('메뉴 처리 중 오류는 기록하고 밖으로 던지지 않는다', () => {
    const { tray, handlers, logger } = setup();
    handlers.onQuit.mockImplementation(() => {
      throw new Error('실패');
    });
    expect(() => tray.menu![3]!.click!()).not.toThrow();
    expect(logger.error).toHaveBeenCalled();
  });

  it('destroy하면 구독을 풀고 트레이를 없앤다', () => {
    const { controller, tray, subscribed } = setup();
    controller.destroy();
    expect(subscribed()).toBe(false);
    expect(tray.destroyed).toBe(true);
  });
});
