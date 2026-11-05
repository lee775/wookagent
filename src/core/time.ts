/** 시각 주입 — 테스트에서 시간을 조절하기 위해 모든 로직은 Clock을 받는다. */
export interface Clock {
  now(): Date;
  iso(): string;
  ms(): number;
}

export const systemClock: Clock = {
  now: () => new Date(),
  iso: () => new Date().toISOString(),
  ms: () => Date.now(),
};

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
