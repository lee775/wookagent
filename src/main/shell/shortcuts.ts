/** 긴급 정지 전역 단축키 (CTL-02) — 창이 앞에 없어도 동작 */
import { globalShortcut } from 'electron';
import type { Logger } from './logger';
import type { OsNotificationInput } from './notifications';

export interface EmergencyShortcut {
  /** 지금 등록된 단축키 (실패했으면 null) */
  readonly accelerator: string | null;
  /** 설정값으로 (다시) 등록. 성공하면 true */
  register(): boolean;
  /** 설정값이 바뀌었을 때만 다시 등록 (같은 값으로 실패를 반복 알리지 않음) */
  syncWithSettings(): void;
  unregister(): void;
}

export function createEmergencyShortcut(deps: {
  getAccelerator: () => string;
  onTrigger: () => void;
  notify: (n: OsNotificationInput) => void;
  logger: Logger;
}): EmergencyShortcut {
  const { logger } = deps;
  let registered: string | null = null;
  let lastAttempt: string | null = null;

  const unregister = (): void => {
    if (registered === null) return;
    try {
      globalShortcut.unregister(registered);
    } catch (error) {
      logger.error(`긴급 정지 단축키 해제 실패: ${registered}`, error);
    }
    registered = null;
  };

  const reportFailure = (accelerator: string, detail: unknown): void => {
    logger.error(`긴급 정지 단축키를 등록하지 못했습니다: ${accelerator}`, detail);
    try {
      deps.notify({
        level: 'normal',
        title: '긴급 정지 단축키를 등록하지 못했습니다',
        body: `'${accelerator}' 단축키를 다른 프로그램이 쓰고 있을 수 있습니다. 운영 설정에서 다른 단축키로 바꿔 주세요. 트레이 메뉴와 창 상단의 긴급 정지는 그대로 쓸 수 있습니다.`,
      });
    } catch (error) {
      logger.error('단축키 실패 알림 표시 실패', error);
    }
  };

  const register = (): boolean => {
    let accelerator: string;
    try {
      accelerator = deps.getAccelerator().trim();
    } catch (error) {
      logger.error('긴급 정지 단축키 설정을 읽지 못했습니다', error);
      return false;
    }
    lastAttempt = accelerator;
    if (registered === accelerator && globalShortcut.isRegistered(accelerator)) return true;
    unregister();
    if (accelerator.length === 0) {
      reportFailure('(비어 있음)', '설정값이 비어 있습니다');
      return false;
    }
    let ok: boolean;
    try {
      ok = globalShortcut.register(accelerator, () => {
        try {
          deps.onTrigger();
        } catch (error) {
          logger.error('긴급 정지 단축키 처리 실패', error);
        }
      });
    } catch (error) {
      // 단축키 문자열 형식이 틀리면 예외가 난다
      reportFailure(accelerator, error);
      return false;
    }
    if (!ok) {
      reportFailure(accelerator, '다른 프로그램이 이미 쓰고 있거나 OS가 거부했습니다');
      return false;
    }
    registered = accelerator;
    logger.info(`긴급 정지 단축키 등록: ${accelerator}`);
    return true;
  };

  return {
    get accelerator() {
      return registered;
    },
    register,
    syncWithSettings() {
      let current: string;
      try {
        current = deps.getAccelerator().trim();
      } catch (error) {
        logger.error('긴급 정지 단축키 설정을 읽지 못했습니다', error);
        return;
      }
      if (current !== lastAttempt) register();
    },
    unregister,
  };
}
