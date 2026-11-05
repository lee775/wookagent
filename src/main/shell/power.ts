/** 작업 중 절전 방지 (ENV-11, AC-31). 화면 꺼짐은 막지 않고 시스템 절전만 막는다 */
import { powerSaveBlocker } from 'electron';
import type { Backend } from '../backend/types';
import type { Logger } from './logger';

export interface PowerGuard {
  readonly blocking: boolean;
  /** 실행 중 작업·설정값을 다시 읽어 맞춘다 (설정 변경 시 호출) */
  update(): void;
  dispose(): void;
}

export function createPowerGuard(deps: {
  backend: Pick<Backend, 'hasActiveWork' | 'preventSleepEnabled' | 'onActiveWorkChange'>;
  logger: Logger;
}): PowerGuard {
  const { backend, logger } = deps;
  let blockerId: number | null = null;
  let disposed = false;

  const stop = (): void => {
    if (blockerId === null) return;
    try {
      if (powerSaveBlocker.isStarted(blockerId)) powerSaveBlocker.stop(blockerId);
      logger.info('절전 방지 해제');
    } catch (error) {
      logger.error('절전 방지를 해제하지 못했습니다', error);
    }
    blockerId = null;
  };

  const update = (): void => {
    if (disposed) return;
    let want: boolean;
    try {
      want = backend.hasActiveWork() && backend.preventSleepEnabled();
    } catch (error) {
      logger.error('절전 방지 조건을 읽지 못했습니다', error);
      return;
    }
    if (!want) {
      stop();
      return;
    }
    if (blockerId !== null && powerSaveBlocker.isStarted(blockerId)) return;
    try {
      blockerId = powerSaveBlocker.start('prevent-app-suspension');
      logger.info('절전 방지 시작 (작업 진행 중)');
    } catch (error) {
      blockerId = null;
      logger.error('절전 방지를 시작하지 못했습니다', error);
    }
  };

  const unsubscribe = backend.onActiveWorkChange(() => update());
  update();

  return {
    get blocking() {
      return blockerId !== null;
    },
    update,
    dispose() {
      if (disposed) return;
      disposed = true;
      try {
        unsubscribe();
      } catch (error) {
        logger.error('작업 상태 구독 해제 실패', error);
      }
      stop();
    },
  };
}
