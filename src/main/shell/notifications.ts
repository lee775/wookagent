/** OS 알림 (12장). 긴급은 소리·화면에 오래 남음, 일반은 무음 */
import { Notification } from 'electron';
import type { Logger } from './logger';

export interface OsNotificationInput {
  level: 'urgent' | 'normal';
  title: string;
  body: string;
  onClick?: () => void;
}

export interface OsNotifier {
  show(n: OsNotificationInput): void;
}

export function createOsNotifier(deps: { focusWindow: () => void; logger: Logger; retain?: number }): OsNotifier {
  // 참조가 사라지면 가비지 수집으로 클릭 이벤트를 못 받으므로 최근 알림을 붙잡아 둔다 (Windows 알림 센터 클릭 포함)
  const retained: Notification[] = [];
  const retain = deps.retain ?? 50;
  const release = (n: Notification): void => {
    const i = retained.indexOf(n);
    if (i >= 0) retained.splice(i, 1);
  };
  // Windows: 붙잡아 둔 목록에서 빠진 알림을 알림 센터에서 눌러도 최소한 창은 연다
  if (process.platform === 'win32' && typeof Notification.handleActivation === 'function') {
    try {
      Notification.handleActivation(() => {
        try {
          deps.focusWindow();
        } catch (error) {
          deps.logger.error('알림 클릭 후 창을 열지 못했습니다', error);
        }
      });
    } catch (error) {
      deps.logger.error('알림 클릭 처리기를 등록하지 못했습니다', error);
    }
  }

  return {
    show({ level, title, body, onClick }) {
      if (!Notification.isSupported()) {
        deps.logger.warn(`OS 알림을 지원하지 않는 환경이라 표시하지 못했습니다: ${title}`);
        return;
      }
      const urgent = level === 'urgent';
      let notification: Notification;
      try {
        notification = new Notification({
          title,
          body,
          silent: !urgent,
          urgency: urgent ? 'critical' : 'normal',
          timeoutType: urgent ? 'never' : 'default',
        });
      } catch (error) {
        deps.logger.error(`OS 알림을 만들지 못했습니다: ${title}`, error);
        return;
      }
      notification.on('click', () => {
        release(notification);
        try {
          deps.focusWindow();
        } catch (error) {
          deps.logger.error('알림 클릭 후 창을 열지 못했습니다', error);
        }
        if (!onClick) return;
        try {
          onClick();
        } catch (error) {
          deps.logger.error(`알림 클릭 처리 실패: ${title}`, error);
        }
      });
      notification.on('failed', (_event, error) => {
        release(notification);
        deps.logger.error(`OS 알림 표시 실패: ${title}`, error);
      });
      retained.push(notification);
      if (retained.length > retain) retained.splice(0, retained.length - retain);
      try {
        notification.show();
      } catch (error) {
        release(notification);
        deps.logger.error(`OS 알림 표시 실패: ${title}`, error);
      }
    },
  };
}
