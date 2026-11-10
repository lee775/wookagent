/**
 * 화면 조작 좌표와 캡처 유효 시간 (SERVER_DESIGN 8.3.3·8.3.4, 리드 결정 S6-6 — 10.6 guiCoordinates). 가짜 도우미만 쓴다 (S6-15).
 * - 줄인 캡처의 좌표는 축마다 real = origin + min(size−1, floor((p+0.5)·size÷imageSize))로 바뀐다 — 배율, 모니터 위치(왼쪽 모니터의 음수 원점), 'all'
 * - 캡처 밖의 점은 invalid이고 도우미에 아무것도 가지 않는다
 * - 30초 넘은 캡처는 stale_capture, 다른 세대의 캡처는 seat_changed, 모르는 캡처는 invalid, 찍은 뒤 모니터 배치가 바뀌면(LAYOUT_CHANGED) stale_capture
 */
import { afterEach, describe, expect, it } from 'vitest';
import { captureScale, insideCapture, rectToImage, toReal, toRealAxis } from '../../src/main/desktop/coords';
import { bootGui, capture, input, inputLines, liveMain, type GuiEnv } from './guiRig';

const open: GuiEnv[] = [];
afterEach(async () => {
  for (const g of open.splice(0)) await g.close();
});

/** 주 모니터 2560×1440 (DPI 144), 왼쪽 모니터 1920×1080 (x -1920) */
const TWO_SCREENS = [
  { x: 0, y: 0, width: 2560, height: 1440, dpi: 144, primary: true },
  { x: -1920, y: 0, width: 1920, height: 1080, dpi: 96, primary: false },
];

describe('좌표 변환 (순수 함수)', () => {
  it('배율 1.5 — 첫·가운데·마지막 픽셀이 찍은 영역 안의 실제 픽셀이 된다 (옆 모니터로 넘지 않는다)', () => {
    expect([0, 640, 1279].map((p) => toRealAxis(p, 1280, 0, 1920))).toEqual([0, 960, 1919]);
    // 키우지 않은 캡처(배율 1)는 그대로
    expect([0, 17, 1919].map((p) => toRealAxis(p, 1920, 0, 1920))).toEqual([0, 17, 1919]);
  });

  it('왼쪽 모니터(원점 음수)와 모든 모니터(all) 캡처의 원점을 더한다', () => {
    const left = { width: 960, height: 540, originX: -1920, originY: 0, realWidth: 1920, realHeight: 1080 };
    expect(toReal(left, 0, 0)).toEqual({ x: -1919, y: 1 });
    expect(toReal(left, 959, 539)).toEqual({ x: -1, y: 1079 });
    const all = { width: 1280, height: 411, originX: -1920, originY: 0, realWidth: 4480, realHeight: 1440 };
    // 세로 배율은 1440÷411 — 축마다 따로 센다
    expect(toReal(all, 1279, 410)).toEqual({ x: 2558, y: 1438 });
    expect(captureScale(all)).toBe(3.5);
  });

  it('캡처 안인지(정수, 0 ≤ 좌표 < 크기)와 실제 사각형을 캡처 좌표로 (글 정보 보유자의 창 위치)', () => {
    const f = { width: 1280, height: 720, originX: 0, originY: 0, realWidth: 2560, realHeight: 1440 };
    expect([insideCapture(f, 0, 0), insideCapture(f, 1279, 719), insideCapture(f, 1280, 0), insideCapture(f, 0, 720), insideCapture(f, -1, 3), insideCapture(f, 1.5, 3)]).toEqual([true, true, false, false, false, false]);
    expect(rectToImage(f, { x: 100, y: 100, width: 800, height: 600 })).toEqual({ x: 50, y: 50, width: 400, height: 300 });
    // 캡처 밖의 창은 뺀다
    expect(rectToImage(f, { x: -1900, y: 0, width: 800, height: 600 })).toBeNull();
  });
});

describe('gui_input 좌표 — 가짜 도우미가 받은 실제 픽셀 (S6-6)', () => {
  it('주 모니터 캡처(1280로 줄임, 배율 2)·왼쪽 모니터·모든 모니터의 클릭이 실제 픽셀로 가고, 캡처 밖의 점은 아무것도 보내지 않는다', async () => {
    const g = await bootGui({ screens: TWO_SCREENS, windows: [] });
    open.push(g);
    const turnId = await liveMain(g.e);
    const main = await capture(g.e, turnId);
    expect(main.data).toMatchObject({ screen: 1, width: 1280, height: 720, scale: 2, origin: { x: 0, y: 0 }, image: 'attached' });
    expect(Date.parse(main.data.expires_at) - Date.parse(main.data.taken_at)).toBe(30_000);
    expect((await input(g.e, turnId, { action: 'click', capture_id: main.data.capture_id, x: 100, y: 50 })).ok).toBe(true);

    const left = await capture(g.e, turnId, { screen: 2, max_width: 960 });
    expect(left.data).toMatchObject({ screen: 2, width: 960, height: 540, scale: 2, origin: { x: -1920, y: 0 } });
    expect((await input(g.e, turnId, { action: 'double_click', capture_id: left.data.capture_id, x: 0, y: 0 })).ok).toBe(true);

    const all = await capture(g.e, turnId, { screen: 'all' });
    expect(all.data).toMatchObject({ screen: 'all', width: 1280, height: 411, origin: { x: -1920, y: 0 } });
    expect((await input(g.e, turnId, { action: 'drag', capture_id: all.data.capture_id, x: 0, y: 0, x2: 1279, y2: 410 })).ok).toBe(true);
    const out = await input(g.e, turnId, { action: 'scroll', capture_id: main.data.capture_id, x: 1280, y: 10, amount: -3 });
    expect(out).toMatchObject({ ok: false, code: 'invalid' });

    // 입력 줄에는 그 캡처의 모니터 배치 해시(L)가 붙는다
    const layout = g.e.ctx.store.guiActions.byCapture(main.data.capture_id)!.capture!.layout;
    expect(inputLines(g.fake)).toEqual([`CLICK 201 101 left 1 ${layout}`, `CLICK -1919 1 left 2 ${layout}`, `DRAG -1919 1 2558 1438 ${layout}`]);
    // 기록에는 실제 픽셀이 남는다
    expect(g.e.ctx.store.guiActions.query({ turnId, actions: ['click', 'double_click', 'drag', 'scroll'], asc: true }).map((r) => [r.action, r.result, r.x, r.y, r.x2, r.y2])).toEqual([
      ['click', 'ok', 201, 101, null, null],
      ['double_click', 'ok', -1919, 1, null, null],
      ['drag', 'ok', -1919, 1, 2558, 1438],
      ['scroll', 'invalid', null, null, null, null],
    ]);
  });

  it('끌기의 끝점도 캡처 안이어야 한다 — 시작점이 안이어도 끝점이 캡처 밖이면 invalid이고 DRAG가 가지 않는다 (S6-21 J3)', async () => {
    const g = await bootGui({ screens: TWO_SCREENS, windows: [] });
    open.push(g);
    const turnId = await liveMain(g.e);
    const c = await capture(g.e, turnId);
    expect([c.data.width, c.data.height]).toEqual([1280, 720]);
    const drag = (x2: number, y2: number) => input(g.e, turnId, { action: 'drag', capture_id: c.data.capture_id, x: 10, y: 10, x2, y2 });
    // 끝점의 x가 캡처 너비와 같다 (마지막 픽셀의 바로 밖 — 옆 모니터로 넘어간다), y가 높이와 같다, 둘 다 밖
    for (const [x2, y2] of [[1280, 10], [10, 720], [5000, 5000]] as const) {
      const r = await drag(x2, y2);
      expect([x2, y2, r.ok ? 'ok' : r.code]).toEqual([x2, y2, 'invalid']);
      if (!r.ok) expect(r.message).toContain(`(${x2}, ${y2})`);
    }
    expect(inputLines(g.fake)).toEqual([]);
    // 끝점이 마지막 픽셀이면 간다 — 그 길이 실제로 돈다는 증거
    expect((await drag(1279, 719)).ok).toBe(true);
    expect(inputLines(g.fake).map((l) => l.split(' ')[0])).toEqual(['DRAG']);
    expect(g.e.ctx.store.guiActions.query({ turnId, actions: ['drag'], asc: true }).map((r) => [r.result, r.dispatched, r.x2, r.y2])).toEqual([
      ['invalid', false, null, null],
      ['invalid', false, null, null],
      ['invalid', false, null, null],
      ['ok', true, 2559, 1439],
    ]);
  });

  it('30초 넘은 캡처는 stale_capture, 다른 세대의 캡처는 seat_changed, 모르는 캡처는 invalid — 셋 다 도우미에 입력을 보내지 않는다', async () => {
    const g = await bootGui();
    open.push(g);
    const turnId = await liveMain(g.e);
    const fresh = await capture(g.e, turnId);
    g.clock.advance(29_000);
    expect((await input(g.e, turnId, { action: 'move', capture_id: fresh.data.capture_id, x: 10, y: 10 })).ok).toBe(true);
    g.clock.advance(1_500);
    const stale = await input(g.e, turnId, { action: 'move', capture_id: fresh.data.capture_id, x: 10, y: 10 });
    expect(stale).toMatchObject({ ok: false, code: 'stale_capture' });

    const other = await capture(g.e, turnId);
    const row = g.e.ctx.store.guiActions.byCapture(other.data.capture_id)!;
    g.e.ctx.store.guiActions.put({ ...row, generation: row.generation - 1 });
    expect(await input(g.e, turnId, { action: 'click', capture_id: other.data.capture_id, x: 10, y: 10 })).toMatchObject({ ok: false, code: 'seat_changed' });
    expect(await input(g.e, turnId, { action: 'click', capture_id: 'SC-999999', x: 10, y: 10 })).toMatchObject({ ok: false, code: 'invalid' });
    expect(inputLines(g.fake)).toHaveLength(1);
    expect(g.e.ctx.store.guiActions.query({ turnId, actions: ['move', 'click'] }).map((r) => r.result).reverse()).toEqual(['ok', 'stale_capture', 'seat_changed', 'invalid']);
  });

  it('찍은 뒤 모니터 배치가 바뀌면 도우미가 LAYOUT_CHANGED로 거부하고 stale_capture가 된다', async () => {
    const g = await bootGui({ screens: TWO_SCREENS });
    open.push(g);
    const turnId = await liveMain(g.e);
    const c = await capture(g.e, turnId);
    g.fake.act({ do: 'set', value: { screens: [TWO_SCREENS[0]!] } });
    await new Promise((r) => setTimeout(r, 150));
    expect(await input(g.e, turnId, { action: 'click', capture_id: c.data.capture_id, x: 10, y: 10 })).toMatchObject({ ok: false, code: 'stale_capture' });
  });
});
