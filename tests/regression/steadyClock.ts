/**
 * 시험 하네스의 기본 시계: 뒤로 가지 않는 벽시계 (리드 결정 S10-10.2). 만든 때의 Date.now()에 그 뒤 performance.now()(단조 시계)가 흐른 만큼을 더한다.
 * WSL2의 벽시계는 약 30초마다 0.5초쯤 뒤로 당겨진다(S10t 실측). 제품은 기록의 앞뒤를 벽시계 문자열로 가르는 곳이 있다(알림의 since·재개 업무의 정지 시각·
 * 자리 교체를 청한 때) — 시험이 몇 ms 사이에 둔 두 기록이 그 당김에 뒤바뀌어 시험이 가끔 실패했다(alertsToMain·programPauseToMain·seatDrainUnconfirmedEnd).
 * 시험이 자기 시계를 넘기는 길(bootOrch({clock}), createHarness({clock}) 등)은 그대로다. 실제 제품의 systemClock도 이제 10초 이내로는 뒤로 가지 않는다
 * (core/time.ts createSteadyWallClock, 리드 결정 S10-12 — 그 시계는 productClockOrder·time.test가 따로 본다)
 */
import type { Clock } from '@core/time';

export interface ClockSources {
  /** 벽시계 (epoch ms) */
  wall(): number;
  /** 단조 시계 (ms) */
  mono(): number;
}

const realSources: ClockSources = { wall: () => Date.now(), mono: () => performance.now() };

/** 만든 때의 벽시계 + 단조 시계의 흐름. 벽시계가 그 뒤 앞뒤로 움직여도 따라가지 않는다 — 늘 같거나 늦은 값 */
export function steadyClock(src: ClockSources = realSources): Clock {
  const w0 = src.wall();
  const m0 = src.mono();
  const ms = (): number => w0 + Math.floor(src.mono() - m0);
  return { now: () => new Date(ms()), iso: () => new Date(ms()).toISOString(), ms };
}

/**
 * 하네스들의 기본 시계 — 시험 프로세스(파일)마다 하나. 같은 파일 안의 다시 시작(restart·같은 데이터 폴더로 다시 띄움)도 같은 시계를 써서, 앞 실행이 남긴
 * 기록보다 뒤 실행의 기록이 이르게 적히지 않는다
 */
export const harnessClock: Clock = steadyClock();
