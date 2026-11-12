/**
 * 작업 중 절전 방지 (ENV-11, AC-31) — 데스크톱의 Electron 이음매. 화면 꺼짐은 막지 않고 시스템 절전만 막는다(prevent-app-suspension).
 * 판단(진행 중 작업 && execution.preventSleep)은 powerGuard.ts가 하고, 여기는 Electron powerSaveBlocker를 그 Blocker로 준다. 서버는 같은 판단에
 * 서버 도우미를 Blocker로 준다 (src/server/power.ts, 리드 결정 S9-5)
 */
import { powerSaveBlocker } from 'electron';
import type { Backend } from '../backend/types';
import type { Logger } from './logger';
import { createGuard, type Blocker, type PowerGuard } from './powerGuard';

export type { PowerGuard };

/** Electron powerSaveBlocker 하나 — 시작한 id를 쥔다 */
function electronBlocker(): Blocker {
  let id: number | null = null;
  return {
    start() {
      id = null;
      id = powerSaveBlocker.start('prevent-app-suspension');
    },
    stop() {
      if (id === null) return;
      const started = id;
      id = null;
      powerSaveBlocker.stop(started);
    },
    isStarted: () => id !== null && powerSaveBlocker.isStarted(id),
  };
}

export function createPowerGuard(deps: {
  backend: Pick<Backend, 'hasActiveWork' | 'preventSleepEnabled' | 'onActiveWorkChange'>;
  logger: Logger;
}): PowerGuard {
  return createGuard({ backend: deps.backend, logger: deps.logger, blocker: electronBlocker() });
}
