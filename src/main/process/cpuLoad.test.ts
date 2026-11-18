/**
 * 최근 CPU 사용률 (cpuLoad.ts) — 누적 시간 두 번의 차로 사용률을 내고, 견줄 만큼 오래된 값이 없으면 모른다고 한다.
 */
import { describe, expect, it } from 'vitest';
import { createCpuLoad, cpuPercentBetween, parseProcStat, readCpuTimes, type CpuTimes } from './cpuLoad';

describe('cpuPercentBetween', () => {
  it('그사이 쉰 시간을 뺀 비율이다', () => {
    expect(cpuPercentBetween({ idle: 0, total: 0 }, { idle: 50, total: 1000 })).toBe(95);
    expect(cpuPercentBetween({ idle: 100, total: 400 }, { idle: 400, total: 800 })).toBe(25);
    expect(cpuPercentBetween({ idle: 0, total: 0 }, { idle: 0, total: 800 })).toBe(100);
    expect(cpuPercentBetween({ idle: 0, total: 0 }, { idle: 800, total: 800 })).toBe(0);
  });

  it('흐른 CPU 시간이 없으면 모른다', () => {
    expect(cpuPercentBetween({ idle: 5, total: 10 }, { idle: 5, total: 10 })).toBeNull();
    expect(cpuPercentBetween({ idle: 5, total: 10 }, { idle: 4, total: 9 })).toBeNull();
  });
});

describe('parseProcStat — Linux는 /proc/stat의 첫 줄만 읽는다 (os.cpus()는 코어가 많으면 느리다)', () => {
  const STAT = ['cpu  1000 50 300 8000 200 10 40 0 0 0', 'cpu0 500 25 150 4000 100 5 20 0 0 0', 'intr 12345 0 0', 'ctxt 999'].join('\n');

  it('쉰 시간은 idle + iowait, 전체는 앞 여덟 칸의 합이다', () => {
    expect(parseProcStat(STAT)).toEqual({ idle: 8200, total: 9600 });
    // 옛 커널처럼 칸이 적어도 읽는다
    expect(parseProcStat('cpu 10 0 5 85\n')).toEqual({ idle: 85, total: 100 });
  });

  it('두 번 읽은 차로 사용률이 나온다', () => {
    const a = parseProcStat('cpu  1000 0 0 9000 0 0 0 0\n')!;
    const b = parseProcStat('cpu  1950 0 0 9050 0 0 0 0\n')!;
    expect(cpuPercentBetween(a, b)).toBe(95);
  });

  it('읽을 수 없는 글이면 null — 그때는 os.cpus()로 읽는다', () => {
    for (const bad of ['', 'cpu0 1 2 3 4\n', 'cpu  1 2 x 4\n', 'cpu  1 2\n', 'cpu  0 0 0 0\n', 'cpu  -1 0 0 5\n']) expect(parseProcStat(bad), JSON.stringify(bad)).toBeNull();
    // /proc이 없는 OS에서 linux로 불러도 던지지 않고 os.cpus()의 값을 준다
    const t = readCpuTimes('linux');
    expect(t.total).toBeGreaterThanOrEqual(t.idle);
  });
});

describe('createCpuLoad', () => {
  /** 시각과 누적 시간을 시험이 정한다 — busy: 그 구간의 사용률(%) */
  function fake() {
    let at = 0;
    const times: CpuTimes = { idle: 0, total: 0 };
    const load = createCpuLoad(
      () => ({ ...times }),
      () => at,
    );
    const pass = (ms: number, busy: number): void => {
      at += ms;
      times.total += ms;
      times.idle += ms * (1 - busy / 100);
    };
    return { load, pass };
  }

  it('처음 부르면 모르고, 1.5초가 지난 값이 생기면 그 구간의 사용률을 준다', () => {
    const f = fake();
    expect(f.load()).toBeNull();
    f.pass(1000, 100);
    expect(f.load()).toBeNull(); // 견줄 값이 아직 1초 전 것뿐
    f.pass(1000, 100);
    expect(f.load()).toBe(100);
  });

  it('2초마다 부르면 최근 4~6초의 평균이다 — 한 구간만 튀어서는 상한을 넘지 않는다', () => {
    const f = fake();
    f.load();
    f.pass(2000, 20);
    expect(f.load()).toBeCloseTo(20);
    f.pass(2000, 20);
    expect(f.load()).toBeCloseTo(20);
    f.pass(2000, 100); // 한 구간만 100%
    expect(f.load()).toBeCloseTo((20 + 20 + 100) / 3);
    f.pass(2000, 100);
    f.pass(2000, 100);
    expect(f.load()).toBeCloseTo(100); // 6초가 지난 값은 버린다
  });

  it('오래 부르지 않았으면 다시 모은다', () => {
    const f = fake();
    f.load();
    f.pass(2000, 50);
    expect(f.load()).toBeCloseTo(50);
    f.pass(60_000, 100);
    expect(f.load()).toBeNull();
    f.pass(2000, 10);
    expect(f.load()).toBeCloseTo(10);
  });

  it('1초 안에 다시 부르면 다시 읽지 않고 앞의 값을 돌려준다 — 주기마다 여러 곳에서 불러도 읽기는 한 번이다', () => {
    let at = 0;
    let reads = 0;
    const times: CpuTimes = { idle: 0, total: 0 };
    const load = createCpuLoad(
      () => {
        reads++;
        return { ...times };
      },
      () => at,
    );
    const pass = (ms: number, busy: number): void => {
      at += ms;
      times.total += ms;
      times.idle += ms * (1 - busy / 100);
    };
    load();
    pass(2000, 40);
    expect(load()).toBeCloseTo(40);
    expect(reads).toBe(2);
    pass(300, 100);
    expect(load()).toBeCloseTo(40);
    pass(600, 100);
    expect(load()).toBeCloseTo(40);
    expect(reads).toBe(2);
    pass(100, 100);
    expect(load()).toBeCloseTo((2000 * 40 + 1000 * 100) / 3000);
    expect(reads).toBe(3);
  });

  it('읽기가 실패하면 모른다고 하고 던지지 않는다', () => {
    const load = createCpuLoad(
      () => {
        throw new Error('읽지 못함');
      },
      () => 0,
    );
    expect(load()).toBeNull();
  });

  it('실제 값: 코어 시간의 합은 0 이상이고 쉰 시간은 전체를 넘지 않는다', () => {
    const t = readCpuTimes();
    expect(t.total).toBeGreaterThanOrEqual(t.idle);
    expect(t.idle).toBeGreaterThanOrEqual(0);
  });
});
