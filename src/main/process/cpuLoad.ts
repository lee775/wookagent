/**
 * 이 PC의 최근 CPU 사용률 (대표 지시 2026-11-18: "cpu95%를 넘는 작업은 못하도록 … 넘을거같으면 딜레이") — 스케줄러와 host_exec가 새 일을 시작하기 전에 본다
 * (orchestrator/cpuGuard.ts). 타이머 없이, 부를 때 누적 CPU 시간을 읽어 몇 초 전에 읽은 값과 견준다. 스케줄러가 2초마다 부르므로 값은 최근 4~6초의
 * 평균이다 — 한순간 튄 값으로 일을 미루지 않는다.
 * 읽기는 가벼워야 한다 — 스케줄러 주기마다, 현황을 만들 때마다 불린다:
 * - Linux는 /proc/stat의 첫 줄만 읽는다. os.cpus()는 코어마다 /sys의 주파수 파일까지 읽어 코어가 많은 PC에서 한 번에 수십~수백 ms가 걸릴 수 있고, 그동안
 *   서버가 다른 요청을 받지 못한다
 * - 어느 OS든 1초 안에 다시 부르면 다시 읽지 않고 앞의 값을 돌려준다
 */
import { readFileSync } from 'node:fs';
import { cpus } from 'node:os';

/** 모든 코어의 누적 시간 합 (단위는 OS마다 다르다 — 두 시점의 비만 쓴다) */
export interface CpuTimes {
  idle: number;
  total: number;
}

/**
 * /proc/stat의 첫 줄 'cpu  user nice system idle iowait irq softirq steal guest guest_nice' → 누적 시간. 쉰 시간은 idle + iowait, 전체는 앞 여덟 칸의 합이다
 * (guest는 user에 이미 들어 있다). 읽을 수 없는 글이면 null
 */
export function parseProcStat(text: string): CpuTimes | null {
  const line = /^cpu\s+(.+)$/m.exec(text);
  if (!line) return null;
  const n = line[1]!
    .trim()
    .split(/\s+/)
    .map((x) => Number(x));
  if (n.length < 4 || n.slice(0, 8).some((x) => !Number.isFinite(x) || x < 0)) return null;
  const idle = n[3]! + (n[4] ?? 0);
  const total = n.slice(0, 8).reduce((a, b) => a + b, 0);
  return total > 0 ? { idle, total } : null;
}

/** os.cpus()의 누적 시간 합 — Linux 밖(Windows·macOS)과 /proc/stat을 읽지 못한 Linux */
function osCpuTimes(): CpuTimes {
  let idle = 0;
  let total = 0;
  for (const c of cpus()) {
    idle += c.times.idle;
    total += c.times.user + c.times.nice + c.times.sys + c.times.irq + c.times.idle;
  }
  return { idle, total };
}

export function readCpuTimes(platform: NodeJS.Platform = process.platform): CpuTimes {
  if (platform === 'linux') {
    try {
      const t = parseProcStat(readFileSync('/proc/stat', 'utf8'));
      if (t) return t;
    } catch {
      // /proc이 없는 환경 — 아래로
    }
  }
  return osCpuTimes();
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
/** 다시 읽는 최소 간격 — 이 안에 다시 부르면 읽지 않고 앞의 값을 돌려준다 */
const READ_GAP_MS = 1000;

/**
 * 최근 CPU 사용률을 돌려주는 함수를 만든다. 견줄 만큼 오래된 값이 아직 없으면(처음 부름, 오래 쉬었다 부름) null — 모르는 동안은 일을 미루지 않는다.
 * read·now는 시험 이음매
 */
export function createCpuLoad(read: () => CpuTimes = readCpuTimes, now: () => number = Date.now): () => number | null {
  const kept: { at: number; times: CpuTimes }[] = [];
  let lastReadAt = Number.NEGATIVE_INFINITY;
  let lastValue: number | null = null;
  return () => {
    const at = now();
    if (at - lastReadAt < READ_GAP_MS) return lastValue;
    let times: CpuTimes;
    try {
      times = read();
    } catch {
      return null;
    }
    lastReadAt = at;
    while (kept.length && at - kept[0]!.at > MAX_WINDOW_MS) kept.shift();
    // 가장 오래된(그래도 MAX_WINDOW_MS 안의) 값과 견준다 — 구간이 길수록 고르다
    const base = kept.find((k) => at - k.at >= MIN_WINDOW_MS);
    kept.push({ at, times });
    lastValue = base ? cpuPercentBetween(base.times, times) : null;
    return lastValue;
  };
}
