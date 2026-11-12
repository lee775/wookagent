/**
 * 작업 중 절전 방지의 판단 (ENV-11, AC-31, 리드 결정 S9-5) — Electron 없이. 진행 중 작업이 있고 설정(execution.preventSleep)이 켜져 있을 때만 막는다.
 * 막는 방법은 Blocker가 정한다: 데스크톱은 Electron powerSaveBlocker(shell/power.ts — 시스템 절전만, 화면 꺼짐은 막지 않는다), 서버는 서버 도우미
 * `WookServerHelper.exe power`(src/server/power.ts — SetThreadExecutionState, 화면 표시 플래그 없음)
 */
import type { Backend } from '../backend/types';
import type { Logger } from './logger';

/** 막는 쪽 — start는 막기를 시작하고 stop은 푼다. isStarted는 지금 막고 있다고 보는지 (던지면 기록하고 막지 않은 것으로 본다) */
export interface Blocker {
  start(): void;
  stop(): void;
  isStarted(): boolean;
}

export interface PowerGuard {
  readonly blocking: boolean;
  /** 실행 중 작업·설정값을 다시 읽어 맞춘다 (설정 변경 시 호출) */
  update(): void;
  dispose(): void;
}

export function createGuard(deps: {
  backend: Pick<Backend, 'hasActiveWork' | 'preventSleepEnabled' | 'onActiveWorkChange'>;
  logger: Logger;
  blocker: Blocker;
}): PowerGuard {
  const { backend, logger, blocker } = deps;
  let blocking = false;
  let disposed = false;

  const stop = (): void => {
    if (!blocking) return;
    try {
      if (blocker.isStarted()) blocker.stop();
      logger.info('절전 방지 해제');
    } catch (error) {
      logger.error('절전 방지를 해제하지 못했습니다', error);
    }
    blocking = false;
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
    if (blocking && blocker.isStarted()) return;
    try {
      blocker.start();
      blocking = true;
      logger.info('절전 방지 시작 (작업 진행 중)');
    } catch (error) {
      blocking = false;
      logger.error('절전 방지를 시작하지 못했습니다', error);
    }
  };

  const unsubscribe = backend.onActiveWorkChange(() => update());
  update();

  return {
    get blocking() {
      return blocking;
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
