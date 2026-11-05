/**
 * 완전 종료 (ENV-09): 진행 중인 작업이 있으면 확인 → 체크포인트 저장(backend.shutdown) → 프로세스 종료.
 * OS 로그오프·종료처럼 확인할 수 없는 경우는 묻지 않고 바로 정리한다.
 */
import type { Logger } from './logger';

export const QUIT_CONFIRM_MESSAGE = '진행 중인 작업이 있습니다. 체크포인트를 남기고 종료할까요?';
export const QUIT_CONFIRM_BUTTONS = ['종료', '취소'] as const;

export interface QuitRequest {
  /** 진행 중인 작업이 있을 때 대표에게 물을지 */
  confirm: boolean;
  /** 기록용 (tray, before-quit, session-end, os-shutdown …) */
  reason: string;
}

export type QuitPhase = 'running' | 'confirming' | 'shutting_down';

export interface QuitFlow {
  readonly phase: QuitPhase;
  /** 종료하면 true, 대표가 취소하면 false */
  request(req: QuitRequest): Promise<boolean>;
}

export interface QuitFlowDeps {
  hasActiveWork: () => boolean;
  /** 종료하기로 하면 true */
  confirm: () => Promise<boolean>;
  /** 확인 직후 (창 숨김, 트레이 '종료 중' 표시 등) */
  beforeShutdown: () => void;
  shutdown: () => Promise<void>;
  /** 단축키·절전 방지·타이머·트레이 정리 */
  cleanup: () => void;
  exit: (code: number) => void;
  logger: Logger;
  /** 정리가 끝나지 않을 때 강제로 끝내기까지 (기본 30초) */
  timeoutMs?: number;
}

function startTimeout(ms: number): { promise: Promise<'timeout'>; cancel(): void } {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<'timeout'>((resolve) => {
    handle = setTimeout(() => resolve('timeout'), ms);
  });
  return {
    promise,
    cancel() {
      if (handle !== undefined) clearTimeout(handle);
    },
  };
}

export function createQuitFlow(deps: QuitFlowDeps): QuitFlow {
  const { logger } = deps;
  const timeoutMs = deps.timeoutMs ?? 30_000;
  let phase: QuitPhase = 'running';
  let shutdownPromise: Promise<boolean> | null = null;
  let confirmPromise: Promise<boolean> | null = null;

  const runStep = (label: string, fn: () => void): void => {
    try {
      fn();
    } catch (error) {
      logger.error(`종료 단계 실패: ${label}`, error);
    }
  };

  const shutdownNow = (reason: string): Promise<boolean> => {
    if (shutdownPromise) return shutdownPromise;
    phase = 'shutting_down';
    logger.info(`완전 종료 시작 (${reason})`);
    shutdownPromise = (async () => {
      runStep('종료 준비', deps.beforeShutdown);
      let code = 0;
      const timeout = startTimeout(timeoutMs);
      try {
        const outcome = await Promise.race([deps.shutdown().then(() => 'done' as const), timeout.promise]);
        if (outcome === 'timeout') {
          code = 1;
          logger.error(`종료 정리가 ${Math.round(timeoutMs / 1000)}초 안에 끝나지 않아 강제로 종료합니다`);
        } else {
          logger.info('체크포인트 저장·실행 정리 완료');
        }
      } catch (error) {
        code = 1;
        logger.error('종료 정리 중 오류 (강제로 종료합니다)', error);
      } finally {
        timeout.cancel();
      }
      runStep('자원 정리', deps.cleanup);
      deps.exit(code);
      return true;
    })();
    return shutdownPromise;
  };

  return {
    get phase() {
      return phase;
    },
    async request(req) {
      if (shutdownPromise) return shutdownPromise;
      if (!req.confirm) return shutdownNow(req.reason);
      if (confirmPromise) return confirmPromise;
      let active: boolean;
      try {
        active = deps.hasActiveWork();
      } catch (error) {
        // 모르면 진행 중으로 보고 묻는다
        logger.error('진행 중 작업 여부를 확인하지 못했습니다', error);
        active = true;
      }
      if (!active) return shutdownNow(req.reason);
      phase = 'confirming';
      confirmPromise = (async () => {
        let ok: boolean;
        try {
          ok = await deps.confirm();
        } catch (error) {
          logger.error('종료 확인 창을 띄우지 못했습니다 (종료하지 않음)', error);
          ok = false;
        }
        // 확인 창이 떠 있는 동안 OS 종료 등으로 이미 정리가 시작됐을 수 있다
        if (shutdownPromise) return shutdownPromise;
        if (!ok) {
          phase = 'running';
          logger.info('대표가 완전 종료를 취소했습니다');
          return false;
        }
        return shutdownNow(req.reason);
      })().finally(() => {
        confirmPromise = null;
      });
      return confirmPromise;
    },
  };
}
