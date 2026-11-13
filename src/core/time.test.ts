/**
 * 제품의 시계는 작은 되돌림에 뒤로 가지 않는다 (리드 결정 S10-12, ./time.ts createSteadyWallClock). 벽시계를 바꿔 넣어 본다.
 * 잡는 결함: 되돌림을 그대로 따라감(뒤에 찍은 기록이 앞선 것으로 보임), 상한(10초)을 보지 않음(크게 바로잡은 시각을 영영 따라가지 않음), now·iso·ms가 서로 다른 값
 */
import { describe, expect, it, vi } from 'vitest';
import { CLOCK_HOLD_MAX_MS, createManualClock, createSteadyWallClock, systemClock } from './time';

/** 시험이 정하는 벽시계 */
function wallAt(start: number): { read: () => number; set: (v: number) => void; add: (d: number) => void } {
  let w = start;
  return { read: () => w, set: (v) => void (w = v), add: (d) => void (w += d) };
}

const T0 = Date.parse('2026-11-12T12:00:00.000Z');

describe('작은 되돌림에 뒤로 가지 않는 벽시계 (createSteadyWallClock)', () => {
  it('조금 뒤로 가면 앞선 값을 그대로 주다가, 벽시계가 그 값을 지나면 다시 따라간다', () => {
    const w = wallAt(T0);
    const c = createSteadyWallClock(w.read);
    expect(c.ms()).toBe(T0);
    w.add(-500);
    expect(c.ms()).toBe(T0);
    w.add(400);
    expect(c.ms()).toBe(T0);
    w.add(100);
    expect(c.ms()).toBe(T0);
    w.add(1);
    expect(c.ms()).toBe(T0 + 1);
    w.add(250);
    expect(c.ms()).toBe(T0 + 251);
  });

  it('정확히 10초 뒤면 앞선 값, 그보다 1ms라도 더 뒤면 바로잡기로 보고 따라간다 — 그 뒤로는 새 자리에서 같은 규칙', () => {
    expect(CLOCK_HOLD_MAX_MS).toBe(10_000);
    const w = wallAt(T0);
    const c = createSteadyWallClock(w.read);
    c.ms();
    w.set(T0 - 10_000);
    expect(c.ms()).toBe(T0);
    w.set(T0 - 10_001);
    expect(c.ms()).toBe(T0 - 10_001);
    w.add(-300);
    expect(c.ms()).toBe(T0 - 10_001);
    w.add(301);
    expect(c.ms()).toBe(T0 - 10_000);
  });

  it('앞으로 간 벽시계는 얼마든 따라간다', () => {
    const w = wallAt(T0);
    const c = createSteadyWallClock(w.read);
    c.ms();
    w.add(3_600_000);
    expect(c.ms()).toBe(T0 + 3_600_000);
    w.add(5);
    expect(c.ms()).toBe(T0 + 3_600_005);
  });

  it('now()·iso()·ms()는 같은 값이다 — 앞선 값을 줄 때도', () => {
    const w = wallAt(T0 + 123);
    const c = createSteadyWallClock(w.read);
    const agree = (expected: number) => {
      expect(c.ms()).toBe(expected);
      expect(c.now().getTime()).toBe(expected);
      expect(c.iso()).toBe(new Date(expected).toISOString());
    };
    agree(T0 + 123);
    w.add(-700);
    agree(T0 + 123);
    w.add(1_000);
    agree(T0 + 423);
  });

  it('작은 되돌림이 섞인 무작위 걸음 5,000번에도 읽은 값은 줄지 않는다 (10초 넘게 뒤처지지 않는 걸음)', () => {
    let seed = 0x5eed;
    const rnd = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const w = wallAt(T0);
    const c = createSteadyWallClock(w.read);
    let prev = c.ms();
    let maxWall = T0;
    let held = 0;
    for (let i = 0; i < 5_000; i++) {
      w.add(Math.round(rnd() * 1_100 - 400)); // -400ms ~ +700ms
      maxWall = Math.max(maxWall, w.read());
      expect(maxWall - w.read()).toBeLessThanOrEqual(CLOCK_HOLD_MAX_MS); // 전제: 바로잡기 크기가 아니다
      const v = c.ms();
      if (v === prev) held++;
      expect(v).toBeGreaterThanOrEqual(prev);
      expect(v).toBe(Math.max(prev, w.read()));
      prev = v;
    }
    expect(held).toBeGreaterThan(100); // 되돌림이 실제로 여러 번 있었다
  });

  it('제품의 systemClock이 이 시계다 — 실제 벽시계와 10초 안이고, 읽을 때마다 줄지 않는다', () => {
    let prev = systemClock.ms();
    expect(Math.abs(prev - Date.now())).toBeLessThanOrEqual(CLOCK_HOLD_MAX_MS);
    for (let i = 0; i < 1_000; i++) {
      const v = systemClock.ms();
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
    expect(Date.parse(systemClock.iso())).toBeGreaterThanOrEqual(prev);
  });

  it('제품의 systemClock 자체: 시스템 시계(가짜 Date — 타이머는 그대로)를 0.5초 뒤로 옮겨도 더 이른 값을 주지 않는다 — now·iso·ms 모두 (리뷰 TD-1)', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      // 이 프로세스의 앞선 읽기보다 앞선 시각에서 시작한다 (systemClock은 프로세스에 하나다)
      vi.setSystemTime(Date.now() + 60_000);
      const a = systemClock.ms();
      vi.setSystemTime(a - 500);
      expect(systemClock.ms()).toBeGreaterThanOrEqual(a);
      expect(Date.parse(systemClock.iso())).toBeGreaterThanOrEqual(a);
      expect(systemClock.now().getTime()).toBeGreaterThanOrEqual(a);
      // 벽시계가 다시 지나가면 따라간다
      vi.setSystemTime(a + 1_000);
      expect(systemClock.ms()).toBe(a + 1_000);
    } finally {
      vi.useRealTimers();
    }
    // 진짜 시각으로 돌아오면 60초 넘게 뒤라 바로잡기로 보고 따라간다
    expect(Math.abs(systemClock.ms() - Date.now())).toBeLessThan(5_000);
  });

  it('시험용 손 시계(createManualClock)는 그대로 — 뒤로도 맞출 수 있다', () => {
    const m = createManualClock('2026-10-27T00:00:00.000Z');
    m.advance(1_000);
    expect(m.iso()).toBe('2026-10-27T00:00:01.000Z');
    m.set('2026-10-26T00:00:00.000Z');
    expect(m.ms()).toBe(Date.parse('2026-10-26T00:00:00.000Z'));
  });
});
