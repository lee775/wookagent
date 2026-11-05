/** 트레이 (13.1, ENV-09·10). 메뉴: 창 열기 · 긴급 정지 · 완전 종료 */
import { Menu, Tray, nativeImage, type NativeImage } from 'electron';
import type { TrayStatus } from '@shared/views';
import type { Backend } from '../backend/types';
import type { Logger } from './logger';
import { trayIconSet } from './trayIcons';

export const TRAY_STATUS_LABEL: Readonly<Record<TrayStatus, string>> = {
  normal: '정상',
  awaiting: '답변 대기',
  paused: '일시정지',
  error: '오류',
  emergency: '긴급 정지',
};

export function trayTooltip(status: TrayStatus): string {
  return `욱채 — ${TRAY_STATUS_LABEL[status]}`;
}

function toNativeImage(status: TrayStatus): NativeImage {
  const [base, ...more] = trayIconSet(status);
  if (!base) throw new Error(`트레이 아이콘이 비어 있습니다: ${status}`);
  const image = nativeImage.createFromBitmap(base.buffer, { width: base.width, height: base.height, scaleFactor: base.scaleFactor });
  for (const rep of more) {
    image.addRepresentation({ scaleFactor: rep.scaleFactor, width: rep.width, height: rep.height, buffer: rep.buffer });
  }
  return image;
}

export interface TrayController {
  readonly status: TrayStatus;
  setStatus(status: TrayStatus): void;
  /** 종료 중 같은 임시 문구. null이면 상태 문구로 돌아간다 */
  setBusyText(text: string | null): void;
  destroy(): void;
}

export function createTray(deps: {
  backend: Pick<Backend, 'getTrayStatus' | 'onTrayStatus'>;
  onOpenWindow: () => void;
  onEmergency: () => void;
  onQuit: () => void;
  logger: Logger;
}): TrayController {
  const { logger } = deps;
  const images = new Map<TrayStatus, NativeImage>();
  const imageFor = (status: TrayStatus): NativeImage => {
    let image = images.get(status);
    if (!image) {
      image = toNativeImage(status);
      images.set(status, image);
    }
    return image;
  };
  const guard = (label: string, fn: () => void) => () => {
    try {
      fn();
    } catch (error) {
      logger.error(`트레이 메뉴 처리 실패: ${label}`, error);
    }
  };

  let status: TrayStatus = deps.backend.getTrayStatus();
  let busyText: string | null = null;
  const tray = new Tray(imageFor(status));
  tray.setToolTip(trayTooltip(status));
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '창 열기', click: guard('창 열기', deps.onOpenWindow) },
      { label: '긴급 정지', click: guard('긴급 정지', deps.onEmergency) },
      { type: 'separator' },
      { label: '완전 종료', click: guard('완전 종료', deps.onQuit) },
    ]),
  );
  tray.on('double-click', guard('창 열기', deps.onOpenWindow));

  const setStatus = (next: TrayStatus): void => {
    if (tray.isDestroyed()) return;
    if (next === status) return;
    try {
      tray.setImage(imageFor(next));
      status = next;
      if (busyText === null) tray.setToolTip(trayTooltip(next));
      logger.info(`트레이 상태: ${TRAY_STATUS_LABEL[next]}`);
    } catch (error) {
      logger.error(`트레이 아이콘을 바꾸지 못했습니다: ${next}`, error);
    }
  };
  const unsubscribe = deps.backend.onTrayStatus(setStatus);

  return {
    get status() {
      return status;
    },
    setStatus,
    setBusyText(text) {
      busyText = text;
      if (!tray.isDestroyed()) tray.setToolTip(text === null ? trayTooltip(status) : `욱채 — ${text}`);
    },
    destroy() {
      try {
        unsubscribe();
      } catch (error) {
        logger.error('트레이 상태 구독 해제 실패', error);
      }
      if (!tray.isDestroyed()) tray.destroy();
    },
  };
}
