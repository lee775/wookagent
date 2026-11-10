/**
 * 화면 조작 횟수 상한 (SERVER_DESIGN 8.3.5 '속도 상한', 리드 결정 S6-8 — 10.6 guiRateLimit). 가짜 도우미, 시계는 손으로 움직이는 시계 — 창이 실제 시간에 밀리지 않는다.
 * - 입력: 초당 5회·분당 300회. 캡처: 초당 2장·턴당 60장. screen_info: 초당 2회. 넘으면 rate_limited이고 도우미에 아무것도 가지 않는다
 * - 창은 서버 전체에 하나이고 미끄러진다 — 턴이 바뀌어도 이어지고, 1초가 지나면 다시 된다. 턴당 캡처 수만 턴마다 새로 센다
 * - 모양을 지난 호출 가운데 받아들인 것을 센다: 모양이 틀린 호출과 상한에 걸린 호출은 세지 않고, 도우미가 거부한 호출(막힌 창)은 센다
 * - 놓기(release)·같은 request_id의 다시 보냄·화면 확인 도구는 세지 않는다
 * - 동작 뒤 자동 캡처(then_capture)가 상한에 걸리면 입력은 그대로 성공이고 after_note가 까닭을 말한다
 * - 코드 상한이다 — 설정에는 그 칸이 없다 (S6-18 4)
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Clock } from '@core/time';
import { MAIN_AGENT_ID } from '@shared/domain';
import type { GuiInputResult } from '../../src/main/mcp/catalog';
import { SCREEN_LIMITS } from '../../src/main/desktop/safety';
import type { HelperWindow } from '../../src/main/desktop/types';
import { bootGui, capture, inputLines, liveMain, MAIN_KEY, ok, rid, type GuiEnv, type GuiOptions } from './guiRig';
import { waitFor } from './orchHarness';

const open: GuiEnv[] = [];
afterEach(async () => {
  for (const g of open.splice(0)) await g.close();
});

/** 손으로만 가는 시계 */
function manualClock(): Clock & { advance(ms: number): void } {
  let t = Date.now();
  return {
    now: () => new Date(t),
    iso: () => new Date(t).toISOString(),
    ms: () => t,
    advance(ms: number) {
      t += ms;
    },
  };
}

/** 작은 화면 (캡처가 가볍다) — 배율 1 */
const SMALL = [{ x: 0, y: 0, width: 320, height: 200, dpi: 96, primary: true }];

async function boot(o: GuiOptions = {}, scenario: Parameters<typeof bootGui>[0] = {}) {
  const clock = manualClock();
  const g = await bootGui({ screens: SMALL, windows: [], ...scenario }, { limits: 'code', clock, ...o });
  open.push(g);
  return { g, clock };
}

const move = (g: GuiEnv, turnId: string, captureId: string, extra: Record<string, unknown> = {}) =>
  g.e.tool(turnId, 'gui_input', { action: 'move', capture_id: captureId, x: 10, y: 10, request_id: rid('rate'), then_capture: false, ...extra });

describe('입력 상한 — 초당 5회, 분당 300회', () => {
  it('코드 상한은 초당 5·분당 300·캡처 초당 2·턴당 60·screen_info 초당 2이고, 설정에는 화면 상한 칸이 없다', async () => {
    expect(SCREEN_LIMITS).toEqual({ inputPerSec: 5, inputPerMin: 300, capturePerSec: 2, capturePerTurn: 60, infoPerSec: 2 });
    expect(Object.isFrozen(SCREEN_LIMITS)).toBe(true);
    const { g } = await boot();
    const s = g.e.ctx.settings() as unknown as Record<string, Record<string, unknown>>;
    expect(Object.keys(s.execution ?? {}).filter((k) => /gui|screen|capture/i.test(k))).toEqual([]);
    expect(Object.keys(s).filter((k) => /gui|screen/i.test(k))).toEqual([]);
  });

  it('1초에 여섯째 입력은 rate_limited이고 도우미에 가지 않는다 — 1초가 지나면 다시 다섯 번. 걸린 호출과 모양이 틀린 호출은 세지 않는다', async () => {
    const { g, clock } = await boot();
    const turnId = await liveMain(g.e);
    const c = await capture(g.e, turnId);
    const id = c.data.capture_id;
    // 모양이 틀린 호출은 세지 않는다
    for (let i = 0; i < 6; i++) expect(await move(g, turnId, id, { x: 9999 })).toMatchObject({ ok: false, code: 'invalid' });
    for (let i = 0; i < 5; i++) expect((await move(g, turnId, id)).ok).toBe(true);
    const sixth = await move(g, turnId, id);
    expect(sixth).toMatchObject({ ok: false, code: 'rate_limited' });
    if (!sixth.ok) expect(sixth.message).toContain('초당 5회');
    // 걸린 호출을 되풀이해도 창이 늘지 않는다
    for (let i = 0; i < 10; i++) expect(await move(g, turnId, id)).toMatchObject({ ok: false, code: 'rate_limited' });
    expect(inputLines(g.fake)).toHaveLength(5);
    // 창은 미끄러진다: 999ms 뒤에도 아직, 1초가 지나면 다시 다섯 번
    clock.advance(999);
    expect(await move(g, turnId, id)).toMatchObject({ ok: false, code: 'rate_limited' });
    clock.advance(1);
    for (let i = 0; i < 5; i++) expect((await move(g, turnId, id)).ok).toBe(true);
    expect(await move(g, turnId, id)).toMatchObject({ ok: false, code: 'rate_limited' });
    expect(inputLines(g.fake)).toHaveLength(10);
    // 기록: 걸린 호출도 한 줄씩 (보내지 않음)
    const rows = g.e.ctx.store.guiActions.query({ turnId, actions: ['move'], results: ['rate_limited'], limit: 100 });
    expect(rows).toHaveLength(13);
    expect(rows.every((r) => !r.dispatched)).toBe(true);
  });

  it('창은 서버 전체에 하나다 — 턴이 바뀌어도 이어진다. 도우미가 거부한 입력(막힌 창)은 센다', async () => {
    const blocked: HelperWindow = { title: '욱채 — 대표 화면', app: 'chrome', pid: 7003, x: 0, y: 0, width: 100, height: 100, minimized: false, blocked: false, elevated: false };
    const { g, clock } = await boot({}, { windows: [blocked] });
    const first = await liveMain(g.e);
    const c1 = await capture(g.e, first);
    // 막힌 창을 세 번 누른다 — 도우미가 거부하지만 센다
    for (let i = 0; i < 3; i++) expect(await move(g, first, c1.data.capture_id, { x: 50, y: 50 })).toMatchObject({ ok: false, code: 'denied_target' });
    expect((await move(g, first, c1.data.capture_id, { x: 200, y: 150 })).ok).toBe(true);
    // 턴을 끝내고 새 턴 (시계는 그대로)
    g.e.liveProc(MAIN_KEY, MAIN_AGENT_ID)!.finishOk();
    await g.e.idle();
    const second = await liveMain(g.e, '이어서 봐 줘');
    expect(second).not.toBe(first);
    clock.advance(600); // 캡처 창(초당 2장)만 비운다 — 입력 창은 아직 1초 안
    clock.advance(500);
    const c2 = await capture(g.e, second);
    // 앞 턴의 네 번은 1.1초 전이라 창 밖이다 — 다시 다섯 번
    for (let i = 0; i < 5; i++) expect((await move(g, second, c2.data.capture_id, { x: 200, y: 150 })).ok).toBe(true);
    expect(await move(g, second, c2.data.capture_id, { x: 200, y: 150 })).toMatchObject({ ok: false, code: 'rate_limited' });
    // 같은 초 안에 턴을 바꿔도 창은 이어진다
    g.e.liveProc(MAIN_KEY, MAIN_AGENT_ID)!.finishOk();
    await g.e.idle();
    const third = await liveMain(g.e, '또 이어서');
    // 캡처는 세대가 같으면 다른 턴에서도 쓸 수 있다 (30초 안)
    expect(await move(g, third, c2.data.capture_id, { x: 200, y: 150 })).toMatchObject({ ok: false, code: 'rate_limited' });
  });

  it('분당 상한: 1분 안에 받아들인 입력이 상한에 닿으면 rate_limited이고 얼마 뒤에 다시 되는지 말한다 (시험 이음매로 12회)', async () => {
    const { g, clock } = await boot({ limits: { ...SCREEN_LIMITS, inputPerMin: 12 } });
    const turnId = await liveMain(g.e);
    let c = await capture(g.e, turnId);
    for (let i = 0; i < 12; i++) {
      clock.advance(250);
      expect((await move(g, turnId, c.data.capture_id)).ok).toBe(true);
    }
    clock.advance(250);
    const over = await move(g, turnId, c.data.capture_id);
    expect(over).toMatchObject({ ok: false, code: 'rate_limited' });
    if (!over.ok) expect(over.message).toMatch(/분당 12회.*\d+초쯤 뒤/);
    // 첫 입력이 1분 창을 벗어나면 한 번 더
    clock.advance(57_000);
    c = await capture(g.e, turnId);
    expect((await move(g, turnId, c.data.capture_id)).ok).toBe(true);
    expect(await move(g, turnId, c.data.capture_id)).toMatchObject({ ok: false, code: 'rate_limited' });
  });

  it('놓기·같은 request_id의 다시 보냄·화면 확인 도구는 세지 않는다', async () => {
    const { g } = await boot();
    const turnId = await liveMain(g.e);
    const c = await capture(g.e, turnId);
    const id = c.data.capture_id;
    const same = rid('dup');
    expect((await move(g, turnId, id, { request_id: same })).ok).toBe(true);
    // 같은 요청을 여러 번 — 캐시가 답하고 세지 않는다
    for (let i = 0; i < 8; i++) expect((await move(g, turnId, id, { request_id: same })).ok).toBe(true);
    for (let i = 0; i < 4; i++) expect((await move(g, turnId, id)).ok).toBe(true);
    expect(await move(g, turnId, id)).toMatchObject({ ok: false, code: 'rate_limited' });
    // 놓기는 상한에 걸린 뒤에도 받는다
    for (let i = 0; i < 3; i++) expect((await g.e.tool(turnId, 'gui_input', { action: 'release', request_id: rid('rel') })).ok).toBe(true);
    // 화면 확인 도구는 상한을 묻지 않는다 (이미 확인한 보유자라 conflict — rate_limited가 아니다)
    for (let i = 0; i < 4; i++) expect(await g.e.tool(turnId, 'get_screen_check', {})).toMatchObject({ ok: false, code: 'conflict' });
    expect(inputLines(g.fake)).toHaveLength(5);
  });
});

describe('캡처 상한 — 초당 2장, 턴당 60장 · screen_info 초당 2회', () => {
  it('1초에 셋째 캡처는 rate_limited이고 CAPTURE 줄이 가지 않는다. screen_info는 따로 초당 2회', async () => {
    const { g, clock } = await boot();
    const turnId = await liveMain(g.e);
    const shot = () => g.e.tool(turnId, 'screen_capture', {});
    const captures = () => g.fake.received().filter((l) => / CAPTURE /.test(l)).length;
    expect((await shot()).ok).toBe(true);
    expect((await shot()).ok).toBe(true);
    const third = await shot();
    expect(third).toMatchObject({ ok: false, code: 'rate_limited' });
    if (!third.ok) expect(third.message).toContain('초당 2장');
    expect(captures()).toBe(2);
    // screen_info는 캡처 창과 따로다
    expect((await g.e.tool(turnId, 'screen_info', {})).ok).toBe(true);
    expect((await g.e.tool(turnId, 'screen_info', {})).ok).toBe(true);
    expect(await g.e.tool(turnId, 'screen_info', {})).toMatchObject({ ok: false, code: 'rate_limited' });
    clock.advance(1000);
    expect((await shot()).ok).toBe(true);
    expect((await g.e.tool(turnId, 'screen_info', {})).ok).toBe(true);
    expect(captures()).toBe(3);
  });

  it('한 턴에 60장까지 — 61번째는 rate_limited(그 턴에서는 더 찍지 않는다), 새 턴은 다시 센다', async () => {
    const { g, clock } = await boot();
    const turnId = await liveMain(g.e);
    for (let i = 0; i < 60; i++) {
      clock.advance(501);
      const r = await g.e.tool(turnId, 'screen_capture', {});
      if (!r.ok) throw new Error(`${i + 1}번째 캡처 거부: ${r.code} ${r.message}`);
    }
    clock.advance(5000);
    const over = await g.e.tool(turnId, 'screen_capture', {});
    expect(over).toMatchObject({ ok: false, code: 'rate_limited' });
    if (!over.ok) expect(over.message).toContain('한 턴에 60장');
    expect(g.fake.received().filter((l) => / CAPTURE /.test(l))).toHaveLength(60);
    g.e.liveProc(MAIN_KEY, MAIN_AGENT_ID)!.finishOk();
    await g.e.idle();
    const next = await liveMain(g.e, '다음 턴');
    expect((await g.e.tool(next, 'screen_capture', {})).ok).toBe(true);
  }, 120_000);

  it('동작 뒤 자동 캡처가 상한에 걸리면 입력은 성공이고 after_note가 말한다 — 캡처는 찍지 않는다', async () => {
    const { g } = await boot();
    const turnId = await liveMain(g.e);
    const a = await capture(g.e, turnId);
    await capture(g.e, turnId); // 이 초의 두 장을 다 썼다
    const r = await g.e.tool(turnId, 'gui_input', { action: 'move', capture_id: a.data.capture_id, x: 10, y: 10, request_id: rid('then') });
    const data = ok<GuiInputResult>(r);
    expect(data.after).toBeNull();
    expect(data.after_note).toBe('입력은 보냈습니다 — 그 뒤 캡처 횟수 상한로 캡처하지 않았습니다');
    expect(r.ok && r.images).toBeFalsy();
    expect(inputLines(g.fake)).toHaveLength(1);
    expect(g.fake.received().filter((l) => / CAPTURE /.test(l))).toHaveLength(2);
    // 입력 줄은 ok로 남는다 (뒤 캡처 없음)
    await waitFor(() => g.e.ctx.store.guiActions.query({ turnId, actions: ['move'] })[0]?.result === 'ok', '입력 줄');
    expect(g.e.ctx.store.guiActions.query({ turnId, actions: ['move'] })[0]).toMatchObject({ result: 'ok', afterCaptureId: null });
  });
});
