/**
 * 대표에게 가는 글은 읽는 대표에게 있는 출구만 말한다 (리드 결정 S4-20, 대표 결정 10-29 — 서버의 대표에게는 메인 AI를 바꾸는 권한이 없다):
 * - 모델별 주간 한도 알림(turns.ts 판정): 메인 에이전트도 그 모델로 쉴 때, 데스크톱은 대표가 이 PC의 운영자라 설치 설정의 메인 AI 모델을, 서버는 쌓였다가
 *   처리되는 명령과 서버 PC 운영자의 seat assign을 말한다 (쉬는 메인은 턴이 뜨지 않아 hand_off_seat도 할 수 없다)
 * - 4단계 알림 '메인 에이전트 응답 없음'의 출구 문장도 모드마다 참이다 (서버: wook-server seat assign, 데스크톱: 운영 설정의 메인 AI)
 * 멈춘 교체 알림은 seatHeldSwapExit가 본다
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID } from '@shared/domain';
import type { Clock } from '@core/time';
import { enqueue } from '../../src/main/orchestrator/records';
import { bootOrch, notices, type FakeProc, type OrchEnv } from './orchHarness';

let env: OrchEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const KEY = 'main:general';
const DAY = 24 * 3600_000;
/** claudeParser가 거부된 rate_limit_event(Opus 주간 한도)에서 내는 것과 같은 오류 */
const opusLimit = (resetAt: string) => (p: FakeProc) =>
  p.emit({ kind: 'error', text: `사용량 한도: Opus 주간 한도에 도달했습니다 (해제 예정 ${resetAt})`, data: { errorKind: 'usage_limit', resetAt, rateLimitType: 'seven_day_opus' } });

/** 메인 턴 하나가 Opus 주간 한도로 끝난다 (메인은 모델을 정하지 않아 그 계열에 든다) */
async function mainHitsOpusLimit(e: OrchEnv): Promise<string> {
  const resetAt = new Date(Date.now() + 5 * DAY).toISOString();
  e.script.set(KEY, opusLimit(resetAt));
  enqueue(e.ctx, { kind: 'message', memberId: MAIN_AGENT_ID, sessionKey: KEY, projectId: null, priority: 'normal', message: '오늘 할 일 정리해 줘' });
  e.tick();
  await e.idle('메인 턴');
  expect(e.ctx.ai('claude').modelUsageLimits).toEqual({ opus: resetAt });
  const [n] = e.ctx.store.notifications.list({ ref1: 'usage:claude:opus' });
  expect(n!.title).toBe('Opus 주간 한도');
  return n!.body;
}

function skewClock(): Clock & { advance(ms: number): void } {
  let offset = 0;
  return { now: () => new Date(Date.now() + offset), iso: () => new Date(Date.now() + offset).toISOString(), ms: () => Date.now() + offset, advance: (ms) => (offset += ms) };
}

describe('대표 알림의 출구 문장 (seatNoticeExits)', () => {
  it('모델별 주간 한도 — 서버의 대표에게는 메인 AI 모델 설정을 말하지 않고, 쌓이는 명령과 서버 PC 운영자의 seat assign을 말한다', async () => {
    const e = (env = await bootOrch({ mock: false, mode: 'server' }));
    const body = await mainHitsOpusLimit(e);
    expect(body).toContain('한도가 풀릴 때까지 Opus 모델의 턴만 쉽니다(모델을 정하지 않은 팀원도 포함). 다른 모델의 턴은 그대로 실행됩니다.');
    expect(body.endsWith('메인 에이전트도 이 모델로 쉬고 있다면 보낸 명령은 쌓였다가 한도가 풀리면 처리됩니다. 그 전에 메인 자리를 다른 AI에게 넘기는 것은 서버 PC의 운영자가 합니다(wook-server seat assign).')).toBe(true);
    expect(body).not.toContain('설치 설정');
  });

  it('모델별 주간 한도 — 데스크톱의 대표는 이 PC의 운영자라 설치 설정의 메인 AI 모델 길을 그대로 말한다', async () => {
    const e = (env = await bootOrch({ mock: false }));
    const body = await mainHitsOpusLimit(e);
    expect(body.endsWith('메인 에이전트도 쉬고 있다면 설치 설정에서 메인 AI 모델을 다른 모델로 정하면 바로 이어서 일합니다.')).toBe(true);
    expect(body).not.toContain('seat assign');
  });

  it("'메인 에이전트 응답 없음' — 서버는 서버 PC 운영자의 seat assign, 데스크톱은 운영 설정의 메인 AI를 출구로 말한다", async () => {
    for (const mode of ['server', 'desktop'] as const) {
      const clock = skewClock();
      const e = (env = await bootOrch({ mode, clock }));
      for (let i = 0; i < 3; i++) e.core.seat.noteMainTurnEnd(1, 'usage_limit');
      clock.advance(5 * 60_000 + 1000);
      e.tick();
      const [n] = notices(e, '메인 에이전트 응답 없음');
      expect(n!.link).toEqual({ tab: 'seat' });
      if (mode === 'server') {
        expect(n!.body.endsWith('메인 자리를 다른 AI에게 넘기는 것은 서버 PC의 운영자만 할 수 있습니다(wook-server seat assign)')).toBe(true);
        expect(n!.body).not.toContain('운영 설정');
      } else {
        expect(n!.body.endsWith('메인 자리를 다른 AI에게 넘기는 것은 이 PC의 운영자가 운영 설정의 메인 AI로 합니다')).toBe(true);
      }
      await e.close();
      env = null;
    }
  });
});
