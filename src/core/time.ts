/** 시각 주입 — 테스트에서 시간을 조절하기 위해 모든 로직은 Clock을 받는다. */
export interface Clock {
  now(): Date;
  iso(): string;
  ms(): number;
}

/**
 * 작은 되돌림을 따라가지 않는 벽시계의 상한 (리드 결정 S10-12): 벽시계가 이 프로세스의 앞선 읽기보다 이만큼 이하로 뒤에 있으면 앞선 값을 그대로 준다(벽시계가
 * 그 값을 지날 때까지). 이보다 더 뒤로 갔으면 실제 시각 바로잡기로 보고 따라간다
 */
export const CLOCK_HOLD_MAX_MS = 10_000;

/**
 * 작은 되돌림에 뒤로 가지 않는 벽시계 (리드 결정 S10-12). 제품은 기록의 앞뒤를 벽시계 문자열로 가르는 곳이 있다 — 일시정지의 since와 재개 업무의 createdAt
 * (turns.pauseItemEnded), 자리 교체를 청한 때와 나가는 턴이 끝난 때(seat.unconfirmedOutgoingEnd), 멈춤 알림의 since와 새 항목(alerts). 그 사이 벽시계가
 * 조금 뒤로 가면(WSL2는 약 30초마다 0.5초, 실제 PC는 드물게 — 부팅·VM 재개·손으로 바꿈) 뒤에 생긴 기록이 앞선 것으로 보였다.
 * - 읽은 값은 이 시계의 앞선 읽기보다 이르지 않다 — 벽시계가 그보다 CLOCK_HOLD_MAX_MS 이하로 뒤에 있는 동안은 앞선 값을 준다(같은 값이 된다)
 * - 그보다 더 뒤로 간 벽시계는 바로잡기로 보고 따라간다. 앞으로 간 벽시계는 늘 따라간다
 * - now()·iso()·ms()는 같은 한 번의 읽기에서 나온다
 * wall: 벽시계 (시험이 바꿔 넣는다)
 */
export function createSteadyWallClock(wall: () => number = () => Date.now(), holdMaxMs: number = CLOCK_HOLD_MAX_MS): Clock {
  let last = Number.NEGATIVE_INFINITY;
  const ms = (): number => {
    const w = wall();
    // 앞으로 갔거나 같다 · 크게 뒤로 갔다(바로잡기) → 따라간다. 조금 뒤로 갔다 → 앞선 값을 그대로
    if (w >= last || last - w > holdMaxMs) last = w;
    return last;
  };
  return {
    now: () => new Date(ms()),
    iso: () => new Date(ms()).toISOString(),
    ms,
  };
}

/** 제품이 기록에 찍는 하나의 시계 — 작은 되돌림에 뒤로 가지 않는 벽시계 (리드 결정 S10-12) */
export const systemClock: Clock = createSteadyWallClock();

/** 테스트용 시계. advance()로 시간을 앞으로 보낸다 */
export function createManualClock(startIso = '2026-10-27T00:00:00.000Z'): Clock & { advance(ms: number): void; set(iso: string): void } {
  let t = Date.parse(startIso);
  return {
    now: () => new Date(t),
    iso: () => new Date(t).toISOString(),
    ms: () => t,
    advance(ms: number) {
      t += ms;
    },
    set(iso: string) {
      t = Date.parse(iso);
    },
  };
}

export function addMs(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString();
}

export function diffSec(fromIso: string, toIso: string): number {
  return Math.max(0, Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 1000));
}
