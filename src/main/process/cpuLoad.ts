/**
 * 이 PC의 최근 CPU 사용률 (대표 지시 2026-11-18: "cpu95%를 넘는 작업은 못하도록 … 넘을거같으면 딜레이") — 스케줄러와 host_exec가 새 일을 시작하기 전에 본다
 * (orchestrator/cpuGuard.ts). 타이머 없이, 부를 때마다 os.cpus()의 누적 시간을 한 번 읽어 몇 초 전에 읽은 값과 견준다. 스케줄러가 2초마다 부르므로
 * 값은 최근 4~6초의 평균이다 — 한순간 튄 값으로 일을 미루지 않는다.
 */
import { cpus } from 'node:os';

/** 모든 코어의 누적 시간 합 (ms) */
export interface CpuTimes {
  idle: number;
  total: number;
}

export function readCpuTimes(): CpuTimes {
  let idle = 0;
  let total = 0;
  for (const c of cpus()) {
    idle += c.times.idle;
    total += c.times.user + c.times.nice + c.times.sys + c.times.irq + c.times.idle;
  }
  return { idle, total };
}

/** 두 시점 사이의 사용률(0~100). 그사이 흐른 CPU 시간이 없으면(같은 순간, 읽지 못함) null */
export function cpuPercentBetween(from: CpuTimes, to: CpuTimes): number | null {
  const total = to.total - from.total;
  if (!(total > 0)) return null;
  const busy = total - (to.idle - from.idle);
  return Math.min(100, Math.max(0, (busy / total) * 100));
}

/** 견줄 옛 값의 나이: 이보다 새 값과는 견주지 않는다(구간이 짧으면 튄다) */
const MIN_WINDOW_MS = 1500;
/** 이보다 오래된 값은 버린다 — 오래 부르지 않았으면 다시 모은다 */
const MAX_WINDOW_MS = 6000;
/** 읽은 값을 남기는 간격 */
const KEEP_GAP_MS = 500;

/**
 * 최근 CPU 사용률을 돌려주는 함수를 만든다. 견줄 만큼 오래된 값이 아직 없으면(처음 부름, 오래 쉬었다 부름) null — 모르는 동안은 일을 미루지 않는다.
 * read·now는 시험 이음매
 */
export function createCpuLoad(read: () => CpuTimes = readCpuTimes, now: () => number = Date.now): () => number | null {
  const kept: { at: number; times: CpuTimes }[] = [];
  return () => {
    const at = now();
    let times: CpuTimes;
    try {
      times = read();
    } catch {
      return null;
    }
    while (kept.length && at - kept[0]!.at > MAX_WINDOW_MS) kept.shift();
    // 가장 오래된(그래도 MAX_WINDOW_MS 안의) 값과 견준다 — 구간이 길수록 고르다
    const base = kept.find((k) => at - k.at >= MIN_WINDOW_MS);
    const last = kept[kept.length - 1];
    if (!last || at - last.at >= KEEP_GAP_MS) kept.push({ at, times });
    return base ? cpuPercentBetween(base.times, times) : null;
  };
}
