/**
 * 응답 없는 메인 자리 보유자 (SERVER_DESIGN 4.4·10.4 seatNoFallback, 리드 결정 S4-5, 대표 결정(10-29) '넘기지 않는다'):
 * - 서버가 띄운 보유자의 응답 없음은 둘 중 먼저 생긴 때부터 센다: 메인 턴이 시작 실패·사용량 한도·재로그인 필요로 연달아 3번 끝남, 또는 메인 일이 쌓였는데
 *   그 AI 종류를 쓸 수 없음(사용량 한도 대기·CLI-15의 시작 정지). 사이에 정상으로 끝난 메인 턴이 끼면 '연달아'가 아니다
 * - 아무리 오래 응답이 없어도 서버는 자리를 바꾸지 않는다. 5분·30분·2시간에 대표에게 다시 알리고(key seat-unresponsive:<세대>), 알림은 보유자와 시간을
 *   말하고 출구 문장(명령·긴급 정지, 운영자의 seat assign)으로 끝난다. 그동안 쌓인 명령은 보유자가 돌아오면(정상으로 끝난 메인 턴) 이어서 처리한다
 * - 응답 없음이 된 뒤의 실패한 메인 턴은 시작 때를 바꾸지 않고, 여러 때를 한꺼번에 넘기면 알림은 하나다
 * - 긴급 정지 중에는 세지 않는다: 응답 없음의 때는 그대로이고, 다시 알리지 않고(정지 바로 전에 넘긴 때도), 해제하면 정지한 시간만큼 뒤로 민다
 * 시간은 앱 시계를 앞당겨 본다(시스템 시계 + 덧붙인 시간 — 턴·타이머는 그대로 돈다)
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAIN_AGENT_ID, OWNER } from '@shared/domain';
import type { Clock } from '@core/time';
import { bootOrch, notices, sleep, type FakeProc, type OrchEnv } from './orchHarness';

let env: OrchEnv | null = null;
afterEach(async () => {
  vi.restoreAllMocks();
  await env?.close();
  env = null;
});

const MIN = 60_000;
const HOUR = 60 * MIN;
const KEY = 'main:general';
const TITLE = '메인 에이전트 응답 없음';
const EXIT_SENTENCE =
  '서버는 메인 자리를 다른 AI에게 넘기지 않습니다. 명령은 그대로 보내셔도 됩니다 — 쌓아 두었다가 메인 에이전트가 돌아오면 이어서 처리합니다. 급하면 긴급 정지를 누르세요. 메인 자리를 다른 AI에게 넘기는 것은 이 PC의 운영자가 운영 설정의 메인 AI로 합니다';

/** 시스템 시계에 시간을 덧붙여 앞당기는 시계 — 턴의 감시·타이머는 실제 시간으로 그대로 돈다 */
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

/** 자리에 관한 것 — 이것이 바뀌면 자리가 바뀐 것이다 (응답 없음 칸은 뺀다) */
const seatPrint = (e: OrchEnv) => {
  const s = e.ctx.store.seat.get('main')!;
  return JSON.stringify({ generation: s.generation, state: s.state, holder: s.holder, since: s.since, history: e.ctx.store.seatHistory.list(), mainAi: e.ctx.store.members.require(MAIN_AGENT_ID).ai });
};
const mainTurns = (e: OrchEnv) => e.ctx.store.turns.list({ ref1: MAIN_AGENT_ID });
const seatRows = (e: OrchEnv) => e.ctx.store.activity.search({ kinds: ['seat'], limit: 100 }).map((r) => r.text);
const journalSeat = (e: OrchEnv) => e.ctx.store.journal.query({ kinds: ['seat'] }).map((r) => r.text);

const usageLimit = (resetAt: string) => (p: FakeProc) => p.emit({ kind: 'error', text: '사용량 한도에 도달했습니다', data: { errorKind: 'usage_limit', resetAt } });
const relogin = (p: FakeProc) => p.emit({ kind: 'error', text: '로그인이 만료됐습니다', data: { errorKind: 'auth' } });

/** 메인 턴 하나를 띄우고 끝날 때까지 */
async function oneMainTurn(e: OrchEnv): Promise<void> {
  e.tick();
  await e.idle('메인 턴');
}

/**
 * 실제 AI 경로(모의 아님)의 메인이 사용량 한도로 끝나 그 한도를 기다리는 동안 명령이 쌓인 자리 — 응답 없음은 그 다음 틱(스케줄러)이 센다.
 * 한도는 하루 뒤에 풀린다
 */
async function blockedHolder(e: OrchEnv, clock: ReturnType<typeof skewClock>): Promise<{ resetAt: string }> {
  const resetAt = new Date(clock.ms() + 24 * HOUR).toISOString();
  e.script.set(KEY, usageLimit(resetAt));
  await e.invoke('command.send', { target: 'main', text: '첫 명령' });
  await oneMainTurn(e);
  expect(mainTurns(e).map((t) => t.endReason)).toEqual(['usage_limit']);
  expect(e.ctx.ai('claude').usageLimitedUntil).toBe(resetAt);
  return { resetAt };
}

describe('응답 없는 보유자 — 서버는 자리를 바꾸지 않는다 (seatNoFallback)', () => {
  it('쌓인 메인 일을 그 AI가 받을 수 없으면 응답 없음이다 — 아무리 오래 가도 자리는 그대로, 5분·30분·2시간에 대표에게 알리고, 돌아오면 쌓인 일을 처리한다', async () => {
    const clock = skewClock();
    const e = (env = await bootOrch({ mock: false, clock }));
    const before = seatPrint(e);
    const { resetAt } = await blockedHolder(e, clock);
    // 다음 틱이 센다 — 한도를 기다리는 동안 쌓인 메인 일
    e.tick();
    const v = e.core.seat.view();
    expect(v.unresponsiveSince).not.toBeNull();
    expect(Math.abs(Date.parse(v.unresponsiveSince!) - clock.ms())).toBeLessThan(5000);
    expect(v.unresponsiveReason).toBe(`Claude CLI를 쓸 수 없어 메인 일이 쌓여 있습니다 — claude 사용량 한도 (${resetAt}까지)`);
    expect(e.core.views.snapshot().seat).toMatchObject({ unresponsiveSince: v.unresponsiveSince, unresponsiveReason: v.unresponsiveReason });
    expect(seatRows(e)).toContain(`메인 에이전트 응답 없음: Claude CLI (세대 1) — ${v.unresponsiveReason}. 서버는 메인 자리를 바꾸지 않습니다`);
    expect(journalSeat(e)).toContain(`메인 에이전트 응답 없음: Claude CLI (세대 1) — ${v.unresponsiveReason}. 서버는 메인 자리를 바꾸지 않습니다`);
    expect(notices(e, TITLE)).toEqual([]);
    // 대표는 계속 명령한다 — 대기열에 쌓인다
    await e.invoke('command.send', { target: 'main', text: '두 번째 명령' });
    await e.invoke('command.send', { target: 'main', text: '세 번째 명령' });

    // 4분: 아직 알리지 않는다. 5분: 첫 알림
    clock.advance(4 * MIN);
    e.tick();
    expect(notices(e, TITLE)).toEqual([]);
    clock.advance(MIN + 1000);
    e.tick();
    e.tick();
    const [first] = notices(e, TITLE);
    expect(notices(e, TITLE)).toHaveLength(1);
    // 누르면 자리 보기로 간다 (리드 결정 S4-19 — 그 전에는 갈 곳이 없어 null이었다)
    expect(first).toMatchObject({ level: 'normal', key: 'seat-unresponsive:1', link: { tab: 'seat' } });
    expect(first!.body).toBe(`메인 에이전트 Claude CLI(세대 1)가 5분째 응답하지 않습니다 — ${v.unresponsiveReason}. ${EXIT_SENTENCE}`);
    // 30분·2시간 — 읽은 뒤의 알림은 새 알림이다. 그 뒤로는 다시 알리지 않는다
    await e.invoke('notifications.markRead', 'all');
    clock.advance(25 * MIN);
    e.tick();
    await e.invoke('notifications.markRead', 'all');
    clock.advance(90 * MIN);
    e.tick();
    clock.advance(10 * HOUR);
    e.tick();
    e.tick();
    const bodies = notices(e, TITLE).map((n) => n.body.slice(0, n.body.indexOf('응답하지 않습니다')));
    expect(bodies.sort()).toEqual(['메인 에이전트 Claude CLI(세대 1)가 2시간째 ', '메인 에이전트 Claude CLI(세대 1)가 30분째 ', '메인 에이전트 Claude CLI(세대 1)가 5분째 '].sort());
    expect(notices(e, TITLE).every((n) => n.key === 'seat-unresponsive:1' && n.body.endsWith(EXIT_SENTENCE))).toBe(true);

    // 12시간이 넘어도 자리는 그대로다 — 세대·보유자·이력·M-MAIN의 AI, 교체 알림도 없다. 그동안 메인 턴은 뜨지 않았다
    expect(seatPrint(e)).toBe(before);
    expect(e.core.seat.view()).toMatchObject({ generation: 1, state: 'active', holder: { label: 'Claude CLI' }, pendingHolder: null });
    expect(notices(e, '메인 에이전트가 바뀌었습니다')).toEqual([]);
    expect(seatRows(e).some((t) => t.startsWith('메인 자리 교체'))).toBe(false);
    expect(mainTurns(e)).toHaveLength(1);

    // 보유자가 돌아온다: 한도가 풀리면 쌓인 명령을 실은 메인 턴이 뜨고, 정상으로 끝나면 응답 없음을 비운다
    e.script.delete(KEY);
    clock.advance(Date.parse(resetAt) - clock.ms() + MIN);
    await oneMainTurn(e);
    const turns = mainTurns(e);
    expect(turns.map((t) => t.endReason)).toEqual(['usage_limit', 'completed']);
    const back = e.launches.find((l) => l.turnId === turns[1]!.id)!;
    for (const text of ['첫 명령', '두 번째 명령', '세 번째 명령']) expect(back.message).toContain(text);
    expect(e.ctx.store.queue.list({ ref1: MAIN_AGENT_ID, state: 'queued' })).toEqual([]);
    expect(e.core.seat.view()).toMatchObject({ unresponsiveSince: null, unresponsiveReason: null });
    expect(seatRows(e).some((t) => /^메인 에이전트가 다시 응답함: Claude CLI \(세대 1, 응답 없음 24시간( \d+분)?\) — 쌓인 일을 이어서 처리합니다$/.test(t))).toBe(true);
    // 알렸던 응답 없음은 같은 key로 다시 응답한다고 알린다 (정보)
    expect(notices(e, '메인 에이전트가 다시 응답합니다')).toMatchObject([{ level: 'info', key: 'seat-unresponsive:1' }]);
    expect(seatPrint(e)).toBe(before);
    expect(e.errors).toEqual([]);
  });

  it('긴급 정지 중에는 세지 않는다 — 정지한 동안은 알리지 않고 응답 없음의 때도 그대로이며, 해제하면 정지한 시간만큼 뒤로 밀어 정지하지 않은 시간만 센다', async () => {
    const clock = skewClock();
    const e = (env = await bootOrch({ mock: false, clock }));
    await blockedHolder(e, clock);
    e.tick();
    const t0 = e.core.seat.view().unresponsiveSince!;
    expect(t0).not.toBeNull();
    clock.advance(4 * MIN);
    e.tick();
    await e.invoke('stop.emergency');
    // 정지한 동안 1시간 — 스케줄러가 돌든(정지 중에는 바로 돌아간다) 자리 확인을 바로 부르든 알리지 않고, 때는 그대로다
    clock.advance(HOUR);
    e.tick();
    e.core.seat.watch();
    expect(notices(e, TITLE)).toEqual([]);
    expect(e.core.seat.view().unresponsiveSince).toBe(t0);
    // 메인 턴의 끝도 세지 않는다 (정지 중)
    e.core.seat.noteMainTurnEnd(1, 'completed');
    expect(e.core.seat.view().unresponsiveSince).toBe(t0);
    // 해제: 정지한 시간(약 1시간)만큼 뒤로
    const stoppedAt = Date.parse(e.ctx.stop().global.since!);
    await e.invoke('stop.release');
    const releasedAt = Date.parse(e.ctx.stop().global.releasedAt!);
    const t1 = e.core.seat.view().unresponsiveSince!;
    expect(Date.parse(t1) - Date.parse(t0)).toBe(releasedAt - stoppedAt);
    expect(releasedAt - stoppedAt).toBeGreaterThanOrEqual(HOUR);
    // 정지하지 않은 시간은 4분 남짓 — 아직 알리지 않는다. 1분 더 지나면 5분째 알림
    e.tick();
    expect(notices(e, TITLE)).toEqual([]);
    clock.advance(MIN + 1000);
    e.tick();
    expect(notices(e, TITLE).map((n) => n.body.slice(0, n.body.indexOf(' 응답하지 않습니다')))).toEqual(['메인 에이전트 Claude CLI(세대 1)가 5분째']);
    expect(e.core.seat.view()).toMatchObject({ generation: 1, state: 'active', holder: { label: 'Claude CLI' } });
  });

  it('정지 바로 전에 넘긴 5분을 아직 알리지 않았어도 정지한 동안에는 알리지 않는다 — 해제 뒤에 알린다 (S4-29 3번, 탐침 watchDuringStop)', async () => {
    const clock = skewClock();
    const e = (env = await bootOrch({ clock }));
    for (let i = 0; i < 3; i++) e.core.seat.noteMainTurnEnd(1, 'usage_limit');
    expect(e.core.seat.view().unresponsiveSince).not.toBeNull();
    clock.advance(5 * MIN + 1000); // 5분을 넘겼지만 그 사이 스케줄러 틱이 없었다
    await e.core.stops.emergency(OWNER);
    e.core.seat.watch(); // 자리 확인을 바로 부른다
    expect(notices(e, TITLE)).toEqual([]);
    e.core.stops.release(OWNER);
    e.tick();
    expect(notices(e, TITLE).map((n) => n.body.slice(0, n.body.indexOf(' 응답하지 않습니다')))).toEqual(['메인 에이전트 Claude CLI(세대 1)가 5분째']);
  });

  it('메인 턴이 사용량 한도·재로그인 필요·시작 실패로 연달아 3번 끝나면 응답 없음이다 — 2번까지는 아니다', async () => {
    const e = (env = await bootOrch());
    const far = new Date(Date.now() + 24 * HOUR).toISOString();
    await e.invoke('command.send', { target: 'main', text: '상태 알려줘' });
    // 모의 메인은 AI 가용성을 보지 않아 한도·로그인으로 막히지 않는다 — 같은 일을 다시 띄워 끝나는 차례를 고른다
    e.script.set(KEY, usageLimit(far));
    await oneMainTurn(e);
    e.script.set(KEY, relogin);
    await oneMainTurn(e);
    expect(mainTurns(e).map((t) => t.endReason)).toEqual(['usage_limit', 'auth_required']);
    expect(e.core.seat.view().unresponsiveSince).toBeNull();
    // 셋째: 프로세스를 띄우기 전의 실패 (실행 값 검사 — 턴 기록 뒤)
    e.script.delete(KEY);
    e.prepareHook = (_launch, who) => {
      if (who.memberId === MAIN_AGENT_ID) throw new Error('메인 AI 모델 이름을 CLI가 받지 않습니다 (시험)');
    };
    await oneMainTurn(e);
    expect(mainTurns(e).map((t) => t.endReason)).toEqual(['usage_limit', 'auth_required', 'spawn_failed']);
    expect(e.core.seat.view()).toMatchObject({ unresponsiveReason: '메인 턴이 3번 연달아 사용량 한도·재로그인 필요·시작 실패로 끝났습니다', generation: 1, state: 'active' });
    expect(e.core.seat.view().unresponsiveSince).not.toBeNull();
    // 돌아오면 비운다
    e.prepareHook = null;
    await e.invoke('command.send', { target: 'main', text: '다시 해 줘' });
    await oneMainTurn(e);
    expect(mainTurns(e).at(-1)!.endReason).toBe('completed');
    expect(e.core.seat.view()).toMatchObject({ unresponsiveSince: null, unresponsiveReason: null });
    expect(e.ctx.store.seat.get('main')).toMatchObject({ unresponsiveStreak: [], unresponsiveNotices: 0 });
  });

  it('사이에 정상으로 끝난 메인 턴이 끼면 연달아가 아니다 — 턴 기록 전의 시작 실패도 세고, 같은 끝이 셋이면 그 까닭 하나로 말한다', async () => {
    const e = (env = await bootOrch());
    const far = new Date(Date.now() + 24 * HOUR).toISOString();
    // AI가 아닌 까닭(프로그램이 건 메인 일시정지)으로 기다리는 메인 일은 응답 없음이 아니다
    await e.core.stops.pauseMember(MAIN_AGENT_ID, 'immediate', 'system', '시험 — 종료 확인 실패');
    await e.invoke('command.send', { target: 'main', text: '첫 명령' });
    e.tick();
    e.core.seat.watch();
    expect(e.core.seat.view().unresponsiveSince).toBeNull();
    expect(mainTurns(e)).toHaveLength(0);
    await e.invoke('stop.release');
    e.script.set(KEY, usageLimit(far));
    await oneMainTurn(e);
    await oneMainTurn(e);
    e.script.delete(KEY);
    await oneMainTurn(e);
    expect(mainTurns(e).map((t) => t.endReason)).toEqual(['usage_limit', 'usage_limit', 'completed']);
    // 정상 끝 뒤로 둘 — 아직 아니다
    await e.invoke('command.send', { target: 'main', text: '둘째 명령' });
    e.script.set(KEY, usageLimit(far));
    await oneMainTurn(e);
    await oneMainTurn(e);
    expect(e.core.seat.view().unresponsiveSince).toBeNull();
    expect(e.ctx.store.seat.get('main')!.unresponsiveStreak).toEqual(['usage_limit', 'usage_limit']);
    // 셋째는 턴 기록 전의 시작 실패 (세션을 고른 뒤 모델을 정하다 실패 — 턴 기록이 없다)
    e.script.delete(KEY);
    const turnsBefore = mainTurns(e).length;
    vi.spyOn(e.core.team, 'modelFor').mockImplementationOnce(() => {
      throw new Error('모델을 정하지 못했습니다 (시험)');
    });
    e.tick();
    await sleep(50);
    await e.idle('턴 기록 전 실패');
    expect(mainTurns(e)).toHaveLength(turnsBefore);
    expect(e.ctx.store.activity.search({ text: '턴 시작 실패: 모델을 정하지 못했습니다 (시험)', limit: 5 })).toHaveLength(1);
    expect(e.core.seat.view().unresponsiveReason).toBe('메인 턴이 3번 연달아 사용량 한도·시작 실패로 끝났습니다');
    // 같은 끝 셋이면 그 까닭 하나로
    await oneMainTurn(e);
    e.core.seat.noteMainTurnEnd(1, 'completed');
    for (let i = 0; i < 3; i++) e.core.seat.noteMainTurnEnd(1, 'usage_limit');
    expect(e.core.seat.view().unresponsiveReason).toBe('사용량 한도로 메인 턴이 3번 연달아 끝났습니다');
    // 다른 세대의 턴(교체 중 나가는 턴 등)·정지로 끝난 턴은 세지 않고, 그 밖의 끝(비정상 종료)은 연달아를 끊는다
    e.core.seat.noteMainTurnEnd(1, 'completed');
    e.core.seat.noteMainTurnEnd(1, 'usage_limit');
    e.core.seat.noteMainTurnEnd(0, 'usage_limit');
    e.core.seat.noteMainTurnEnd(1, 'user_stop');
    expect(e.ctx.store.seat.get('main')!.unresponsiveStreak).toEqual(['usage_limit']);
    e.core.seat.noteMainTurnEnd(1, 'crashed');
    expect(e.ctx.store.seat.get('main')!.unresponsiveStreak).toEqual([]);
  });

  it('응답 없음이 된 뒤에도 실패로 끝나는 메인 턴은 그 시작 때를 바꾸지 않는다 — 보이는 시간과 5분·30분·2시간 알림이 처음부터 이어진다 (S4-22 5번)', async () => {
    const clock = skewClock();
    const e = (env = await bootOrch({ clock }));
    const far = new Date(clock.ms() + 24 * HOUR).toISOString();
    const lead = () => notices(e, TITLE).map((n) => n.body.slice(0, n.body.indexOf(' 응답하지 않습니다')));
    await e.invoke('command.send', { target: 'main', text: '상태 알려줘' });
    e.script.set(KEY, usageLimit(far));
    for (let i = 0; i < 3; i++) await oneMainTurn(e);
    const since = e.core.seat.view().unresponsiveSince;
    expect(since).not.toBeNull();
    // 10분 뒤 넷째 메인 턴이 재로그인 필요로 끝난다 — 그 틱이 먼저 '10분째'를 알린다
    clock.advance(10 * MIN);
    await e.invoke('command.send', { target: 'main', text: '두 번째 명령' });
    e.script.set(KEY, relogin);
    await oneMainTurn(e);
    expect(mainTurns(e).map((t) => t.endReason)).toEqual(['usage_limit', 'usage_limit', 'usage_limit', 'auth_required']);
    expect(e.core.seat.view().unresponsiveSince).toBe(since);
    expect(lead()).toEqual(['메인 에이전트 Claude CLI(세대 1)가 10분째']);
    // 처음부터 30분: 다섯째(시작 실패) 앞의 틱이 '30분째'를 알린다 — 넷째가 시간을 다시 시작했다면 '20분째'였다
    await e.invoke('notifications.markRead', 'all');
    clock.advance(20 * MIN);
    await e.invoke('command.send', { target: 'main', text: '세 번째 명령' });
    e.script.delete(KEY);
    e.prepareHook = (_launch, who) => {
      if (who.memberId === MAIN_AGENT_ID) throw new Error('메인 AI 모델 이름을 CLI가 받지 않습니다 (시험)');
    };
    await oneMainTurn(e);
    expect(mainTurns(e).at(-1)!.endReason).toBe('spawn_failed');
    expect(e.core.seat.view().unresponsiveSince).toBe(since);
    expect(lead().sort()).toEqual(['메인 에이전트 Claude CLI(세대 1)가 10분째', '메인 에이전트 Claude CLI(세대 1)가 30분째'].sort());
    expect(e.core.seat.view()).toMatchObject({ generation: 1, state: 'active', holder: { label: 'Claude CLI' } });
  });

  it('한 번에 5분·30분·2시간을 모두 넘기면 알림은 하나이고 지금 시간을 말한다 — 읽은 뒤에도 다시 오지 않는다 (S4-22 6번)', async () => {
    const clock = skewClock();
    const e = (env = await bootOrch({ clock }));
    for (let i = 0; i < 3; i++) e.core.seat.noteMainTurnEnd(1, 'usage_limit');
    const reason = e.core.seat.view().unresponsiveReason;
    expect(reason).toBe('사용량 한도로 메인 턴이 3번 연달아 끝났습니다');
    // PC가 잠들었다 깨어난 것처럼 3시간이 한꺼번에 지난다
    clock.advance(3 * HOUR);
    e.tick();
    expect(notices(e, TITLE).map((n) => n.body)).toEqual([`메인 에이전트 Claude CLI(세대 1)가 3시간째 응답하지 않습니다 — ${reason}. ${EXIT_SENTENCE}`]);
    // 읽은 뒤의 틱도, 한참 뒤의 틱도 새 알림을 내지 않는다 — 세 때를 모두 쓴 것이다
    await e.invoke('notifications.markRead', 'all');
    e.tick();
    e.tick();
    clock.advance(10 * HOUR);
    e.tick();
    expect(notices(e, TITLE)).toHaveLength(1);
  });
});
