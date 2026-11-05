/**
 * 응답 없음이 이어진 시간은 긴급 정지한 시간을 세지 않는다 — 재거나 글에 남기는 모든 곳에서 (리드 결정 S4-17, S4-5, SERVER_DESIGN 4.4):
 * - 정지 중이면 지금이 아니라 정지가 시작된 때에서 끊는다(SeatService 한 도움 함수). 해제 때 시작 때를 정지한 만큼 뒤로 미는 것(S4-5)은 그대로라 이어진다
 * - 운영자 복구 배정의 까닭('이전 보유자가 n분째 응답하지 않음' — 이력의 끝난 까닭·인계 꾸러미·대표 알림·메인 일지에 그대로 남는다), seat status의
 *   unresponsiveForMs, 다시 알림, 다시 응답함 글
 * 탐침 P4(server-s4-seat-authority, zz-seatauth-unresp)에서 왔다
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID, OWNER } from '@shared/domain';
import type { Clock } from '@core/time';
import { bootOrch, notices, type FakeProc, type OrchEnv } from './orchHarness';

let env: OrchEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const MIN = 60_000;
const HOUR = 60 * MIN;
const KEY = 'main:general';

/** 앞당길 수 있는 앱 시계 */
function skewClock(): Clock & { advance(ms: number): void } {
  let offset = 0;
  return {
    now: () => new Date(Date.now() + offset),
    iso: () => new Date(Date.now() + offset).toISOString(),
    ms: () => Date.now() + offset,
    advance(ms: number) {
      offset += ms;
    },
  };
}
const usageLimit = (resetAt: string) => (p: FakeProc) => p.emit({ kind: 'error', text: '사용량 한도에 도달했습니다', data: { errorKind: 'usage_limit', resetAt } });

/** 실제 AI 길(모의 아님)의 메인이 사용량 한도로 끝나고, 한도를 기다리는 동안 쌓인 명령 하나로 응답 없음이 시작된다 */
async function unresponsiveMain(clock: ReturnType<typeof skewClock>): Promise<OrchEnv> {
  const e = (env = await bootOrch({ mock: false, clock }));
  e.script.set(KEY, usageLimit(new Date(clock.ms() + 24 * HOUR).toISOString()));
  await e.invoke('command.send', { target: 'main', text: '첫 명령' });
  e.tick();
  await e.idle('메인 턴');
  await e.invoke('command.send', { target: 'main', text: '두 번째 명령' });
  e.tick(); // watch → 응답 없음 시작
  expect(e.core.seat.view().unresponsiveSince).not.toBeNull();
  return e;
}

describe('응답 없음 시간과 긴급 정지 (seatSilentTime)', () => {
  it('긴급 정지 중의 운영자 복구 배정 — 까닭의 응답 없음 시간은 정지하지 않은 10분이다. 이력·꾸러미·알림·일지·seat status 모두 (탐침 P4)', async () => {
    const clock = skewClock();
    const e = await unresponsiveMain(clock);
    clock.advance(10 * MIN); // 정지하지 않은 10분
    await e.invoke('stop.emergency');
    clock.advance(HOUR); // 긴급 정지한 1시간
    // seat status (S4-8): 정지 중에는 늘지 않는다
    expect(Math.round(e.core.seat.operatorStatus().unresponsiveForMs! / MIN)).toBe(10);
    expect(Math.round(e.core.seat.unresponsiveForMs()! / MIN)).toBe(10);
    await e.core.seat.operatorAssign('launched:codex', true).done;
    const reason = '운영자 복구 배정 (wook-server seat assign --force) — 이전 보유자가 10분째 응답하지 않음';
    expect(e.core.seat.history().find((h) => h.generation === 1)!.endReason).toBe(`운영자가 바꿈: ${reason}`);
    expect(e.core.seat.handover(2)!.sections[0]!.lines).toContain(`까닭: ${reason}`);
    expect(notices(e, '메인 에이전트가 바뀌었습니다')[0]!.body).toContain(`까닭: ${reason}.`);
    const journal = e.ctx.store.journal.query({ kinds: ['seat'] });
    expect(JSON.stringify(journal)).toContain(reason);
    expect(JSON.stringify(journal)).not.toContain('1시간 10분째');
    expect(e.ctx.stop().global.active).toBe(true);
    expect(e.core.seat.view()).toMatchObject({ generation: 2, holder: { label: 'Codex CLI' } });
  });

  it('정지 중에는 그대로, 해제한 뒤에는 이어서 센다 — 다시 알림과 다시 응답함도 정지하지 않은 시간이다', async () => {
    const clock = skewClock();
    const e = await unresponsiveMain(clock);
    clock.advance(3 * MIN);
    await e.core.stops.emergency(OWNER);
    clock.advance(2 * HOUR);
    expect(Math.round(e.core.seat.unresponsiveForMs()! / MIN)).toBe(3);
    e.core.stops.release(OWNER);
    expect(Math.round(e.core.seat.unresponsiveForMs()! / MIN)).toBe(3);
    // 해제 뒤 2분 더 → 5분째 알림 (정지한 2시간은 세지 않아 '2시간째'가 아니다)
    clock.advance(2 * MIN + 1000);
    e.tick();
    const [n] = notices(e, '메인 에이전트 응답 없음');
    expect(n!.body).toContain('5분째 응답하지 않습니다');
    expect(n!.link).toEqual({ tab: 'seat' });
    expect(e.ctx.store.seat.get('main')!.unresponsiveNotices).toBe(1);
    // 한도가 풀려 메인 턴이 정상으로 끝나면 '다시 응답함'의 시간도 정지하지 않은 시간 — 그 알림도 자리 보기로 간다 (S4-19)
    e.script.delete(KEY);
    e.ctx.saveAi({ ...e.ctx.ai('claude'), usageLimitedUntil: null });
    e.tick();
    await e.idle('메인 턴');
    expect(e.core.seat.view().unresponsiveSince).toBeNull();
    const back = notices(e, '메인 에이전트가 다시 응답합니다');
    expect(back).toHaveLength(1);
    expect(back[0]!.body).toContain('5분 만에 다시 응답했습니다');
    expect(back[0]!.link).toEqual({ tab: 'seat' });
    expect(e.ctx.store.activity.search({ kinds: ['seat'], limit: 30 }).map((r) => r.text)).toContain('메인 에이전트가 다시 응답함: Claude CLI (세대 1, 응답 없음 5분) — 쌓인 일을 이어서 처리합니다');
    expect(e.ctx.store.members.require(MAIN_AGENT_ID).ai.kind).toBe('claude');
  });
});
