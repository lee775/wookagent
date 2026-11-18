/**
 * CPU 상한 (대표 지시 2026-11-18: "최상단 메인봇은 … 컴퓨터 건드리잖아 이과정에서 cpu95%를 넘는 작업은 못하도록 해줘 넘을거같으면 딜레이하고 cpu 유의하면서
 * 작업하도록"). 이 PC의 CPU 사용률이 상한 이상이면 프로그램이 새 일을 시작하지 않고 내려갈 때까지 미룬다:
 * - 스케줄러: 팀 턴(프로듀서·팀원의 CLI)을 새로 띄우지 않는다. 메인 에이전트의 턴은 그대로 — 대표의 명령·정지에 답하고 상황을 볼 수 있어야 한다
 * - host_exec: 명령을 띄우지 않고 내려갈 때까지 기다렸다가 실행한다 — 높다고 돌려보내지 않는다 (같은 날 대표 지시 "돌려보내진 말고 딜레이했다가 나중에 작업")
 * 이미 돌고 있는 명령의 CPU를 깎지는 못한다 — 막는 것은 '더 얹기'다. 그래서 메인·팀 지침이 무거운 명령의 병렬 수를 줄이라고 함께 말한다 (prompts.ts).
 * 사용률을 모르면(측정기 없음 — 시험 하네스, 처음 몇 초) 미루지 않는다.
 */
import { MAIN_AGENT_ID } from '@shared/domain';
import type { Core } from './core';

/** CPU 사용률 상한(%) — 이 값 이상이면 새 일을 미룬다 */
export const CPU_LIMIT_PERCENT = 95;
/** host_exec가 CPU가 내려가기를 기다리는 동안 다시 보는 간격 (기본) */
const CPU_POLL_MS = 1000;
/** '미룸' 활동 기록을 다시 남기는 최소 간격 — 사용률이 상한 근처에서 오르내릴 때 기록이 쌓이지 않게 */
const HOLD_NOTE_GAP_MS = 60_000;

export interface CpuView {
  /** 최근 사용률(%, 반올림). 모르면 null */
  percent: number | null;
  limit: number;
  /** 지금 상한 이상이라 새 팀 턴과 host_exec를 미루는지 */
  holding: boolean;
}

export class CpuGuard {
  /** 스케줄러가 팀 턴을 미루기 시작한 때와 그 기록을 남겼는지 */
  private held: { sinceMs: number; noted: boolean } | null = null;
  private lastNoteMs = Number.NEGATIVE_INFINITY;

  constructor(private readonly core: Core) {}

  /** 최근 사용률(%, 반올림). 모르면 null */
  percent(): number | null {
    const p = this.core.ctx.deps.cpuLoad?.() ?? null;
    return p === null || !Number.isFinite(p) ? null : Math.round(p);
  }

  view(): CpuView {
    const percent = this.percent();
    return { percent, limit: CPU_LIMIT_PERCENT, holding: percent !== null && percent >= CPU_LIMIT_PERCENT };
  }

  /**
   * 스케줄러가 이번에 띄울 수 있는 후보 — CPU가 상한 이상이면 메인 에이전트의 턴만 남긴다. 미루기 시작할 때와 풀릴 때 활동 기록을 한 줄씩 남긴다.
   * 후보가 없어도 부른다(풀림을 적으려고)
   */
  admit<T extends { memberId: string }>(candidates: T[]): T[] {
    const ctx = this.core.ctx;
    const { percent, holding } = this.view();
    const kept = holding ? candidates.filter((c) => c.memberId === MAIN_AGENT_ID) : candidates;
    const heldCount = candidates.length - kept.length;
    const nowMs = ctx.clock.ms();
    if (heldCount > 0) {
      this.held ??= { sinceMs: nowMs, noted: false };
      if (!this.held.noted && nowMs - this.lastNoteMs >= HOLD_NOTE_GAP_MS) {
        this.held.noted = true;
        this.lastNoteMs = nowMs;
        ctx.activity({
          kind: 'system',
          level: 'warn',
          text: `서버 PC의 CPU 사용률이 ${percent}%입니다(상한 ${CPU_LIMIT_PERCENT}%) — 새 팀 턴의 시작을 미룹니다 (기다리는 업무 ${heldCount}건). 내려가면 이어서 시작합니다`,
        });
      }
    } else if (this.held && !holding) {
      if (this.held.noted) {
        ctx.activity({
          kind: 'system',
          text: `서버 PC의 CPU 사용률이 ${percent === null ? '상한 아래' : `${percent}%`}로 내려가 미뤘던 팀 턴을 다시 시작합니다 (${Math.max(1, Math.round((nowMs - this.held.sinceMs) / 1000))}초 미룸)`,
        });
      }
      this.held = null;
    }
    return kept;
  }

  /**
   * CPU가 상한 아래로 내려갈 때까지 기다린다 (host_exec가 명령을 띄우기 전). 높다고 돌려보내지 않는다 — 미뤘다가 내려가면 이어서 한다 (대표 지시 2026-11-18
   * "cpu가 계속 높다고 돌려보내진 말고 딜레이했다가 나중에 작업"). 처음부터 아래면 바로 돌아온다. giveUp: 그만 기다릴 때(부른 턴이 끝남·정지·자리 교체·앱
   * 종료)면 그대로 돌아온다 — 그 까닭의 거부는 부른 쪽의 검사가 한다. tick: 기다리는 동안 다시 볼 때마다 부른다(부른 턴을 살아 있다고 알림)
   */
  async waitBelow(o: { giveUp: () => boolean; tick?: () => void }): Promise<{ waitedMs: number }> {
    const pollMs = this.core.ctx.deps.timing?.cpuPollMs ?? CPU_POLL_MS;
    const t0 = Date.now();
    while (this.view().holding && !o.giveUp()) {
      o.tick?.();
      await new Promise<void>((done) => setTimeout(done, pollMs));
    }
    return { waitedMs: Date.now() - t0 };
  }
}
