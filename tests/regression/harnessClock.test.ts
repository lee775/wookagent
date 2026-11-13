/**
 * 하네스의 기본 시계는 뒤로 가지 않는다 (리드 결정 S10-10.2, ./steadyClock.ts). WSL2의 벽시계는 약 30초마다 0.5초쯤 뒤로 당겨진다(S10t 실측) — 제품이 기록의
 * 앞뒤를 벽시계 문자열로 가르는 곳에서 시험이 몇 ms 사이에 둔 두 기록이 뒤바뀌어 가끔 실패했다:
 * - alertsToMain '계획 지연': 알림 업무의 since와 새 지연 항목의 createdAt (alerts.ts `q.createdAt >= a.since`)
 * - programPauseToMain '메인 턴 비정상 종료 상한…': 프로그램이 건 정지의 since와, 비정상 종료 뒤 다시 넣은 재개 업무의 createdAt — 뒤로 당겨지면 재개 업무가
 *   '그 뒤 다른 까닭으로 다시 일시정지됨'(turns.ts pauseItemEnded `s.since > createdAt`)으로 조용히 지워져 대표 알림이 오지 않았다
 * - seatDrainUnconfirmedEnd '…서버 명령(host_exec)…': 교체를 청한 때(requestedAt)와 나가는 메인 턴이 끝난 때 — 뒤로 당겨지면 그 턴이 교체 전에 끝난 것으로
 *   보여 종료 확인 실패에도 새 보유자가 앉았다
 * 시스템 시계를 0.5초 뒤로 옮겨(가짜 Date — performance.now는 그대로) 그 당김을 흉내 낸다. 잡는 결함: 하네스 기본 시계가 다시 벽시계(systemClock)가 됨
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAIN_AGENT_ID } from '@shared/domain';
import type { Clock } from '@core/time';
import { deadWorkReason } from '../../src/main/orchestrator/turns';
import { enqueue, mainKey } from '../../src/main/orchestrator/records';
import { createHarness, type Harness } from '../e2e/harness';
import { bootApp, type App } from '../acceptance/security-helpers';
import { bootRestartable, type RestartableEnv } from '../acceptance/stops-helpers';
import { boot, type Env } from './helpers';
import { bootOrch, type OrchEnv } from './orchHarness';
import { steadyClock } from './steadyClock';

const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const c of closers.splice(0).reverse()) await c().catch(() => undefined);
});

/** 시스템 시계(Date·new Date())를 지금부터 ms만큼 옮긴다 — 타이머·performance.now는 실제 그대로 */
function stepSystemClock(ms: number): void {
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
  vi.setSystemTime(Date.now() + ms);
}

describe('뒤로 가지 않는 벽시계 (steadyClock)', () => {
  it('만든 때의 벽시계에서 단조 시계만큼 흐르고, 벽시계가 뒤로·앞으로 움직여도 따라가지 않는다', () => {
    let wall = 1_000_000;
    let mono = 50;
    const c = steadyClock({ wall: () => wall, mono: () => mono });
    expect(c.ms()).toBe(1_000_000);
    mono += 120;
    wall -= 500;
    expect(c.ms()).toBe(1_000_120);
    wall += 10_000;
    mono += 5;
    expect(c.ms()).toBe(1_000_125);
    expect(c.iso()).toBe(new Date(1_000_125).toISOString());
    expect(c.now().getTime()).toBe(1_000_125);
  });
});

describe('하네스 기본 시계는 시스템 시계가 0.5초 뒤로 옮겨져도 뒤로 가지 않는다', () => {
  const harnesses: [string, () => Promise<Clock>][] = [
    ['bootOrch (regression/orchHarness)', async () => {
      const e: OrchEnv = await bootOrch();
      closers.push(() => e.close());
      return e.ctx.clock;
    }],
    ['boot (regression/helpers)', async () => {
      const e: Env = await boot();
      closers.push(() => e.close());
      return e.ctx.clock;
    }],
    ['createHarness (e2e/harness)', async () => {
      const h: Harness = await createHarness({ noProject: true });
      closers.push(() => h.close());
      return h.core.ctx.clock;
    }],
    ['bootApp (acceptance/security-helpers)', async () => {
      const a: App = await bootApp({ stopScheduler: true });
      closers.push(() => a.close());
      return a.ctx.clock;
    }],
    ['bootRestartable (acceptance/stops-helpers)', async () => {
      const r: RestartableEnv = await bootRestartable({ holdAll: true });
      closers.push(() => r.close());
      return r.ctx.clock;
    }],
  ];
  for (const [name, start] of harnesses) {
    it(name, async () => {
      const clock = await start();
      const before = clock.ms();
      const beforeIso = clock.iso();
      stepSystemClock(-500);
      expect(clock.ms()).toBeGreaterThanOrEqual(before);
      expect(clock.iso() >= beforeIso).toBe(true);
    });
  }
});

describe('제품의 벽시계 문자열 순서가 시험 안에서 뒤바뀌지 않는다', () => {
  it('프로그램이 건 정지 뒤에 넣은 재개 업무는, 그사이 시스템 시계가 0.5초 뒤로 옮겨져도 "그 뒤 다시 일시정지됨"으로 지워지지 않는다 (programPauseToMain의 실패 모양)', async () => {
    const e = await bootOrch();
    closers.push(() => e.close());
    await e.core.stops.pauseMember(e.producerId, 'immediate', 'system', '시험: 종료 확인 실패');
    stepSystemClock(-500);
    const item = enqueue(e.ctx, { kind: 'message', memberId: MAIN_AGENT_ID, sessionKey: mainKey(e.projectId), projectId: e.projectId, pausedMemberId: e.producerId, priority: 'high', message: '시험: 재개 업무' });
    expect(item.createdAt >= e.ctx.stop().members[e.producerId]!.since).toBe(true);
    expect(deadWorkReason(e.ctx, item)).toBeNull();
  });
});
