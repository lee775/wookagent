/**
 * 화면 조작의 상태와 대표의 보기 (리드 결정 S6-2·S6-9·S6-11). 가짜 도우미만 쓴다 — 실제 화면 도우미는 뜨지 않는다.
 * - 쓰지 않는 실행: 데스크톱 앱(desktop_mode)·Windows 밖(unsupported_os)·운영자가 끔(disabled)이면 화면 도구는 그 글로 unavailable이고, 화면 도우미를 띄우지
 *   않고, 화면 확인 업무를 넣지 않고, 사전 점검도 하지 않는다. 앱 조립(buildDeps)은 그 실행에 화면 도우미를 넣지 않는다
 * - 잠김·끊김: 도구가 부딪히면 unavailable(사람이 풀어야 한다는 글)이고, 대표의 자리 화면(SeatView.screen)·사전 점검(system.prereqs)에 마지막으로 안 상태가
 *   보인다 — 대표에게는 대표가 할 수 있는 일(서버 PC 운영자에게 부탁)만 적는다. 종류가 바뀔 때마다 대표 알림 하나, 풀리면 지운다
 * - 사전 점검의 확인(probe)은 시작 뒤 한 번, 60초 안에는 다시 하지 않고, system.prereqs는 그것을 부르지 않는다
 * - 대표의 보기(screens.recent·screens.image): 최근 캡처와 동작 기록(이미지 바이트 없이), 캡처 한 장은 보관 중이고 기록의 해시와 맞을 때만
 * - 다시 시작: 답을 받지 못한 입력 줄을 닫고, 빠진 턴 한 줄을 남기고, 놓지 못한 키를 새 도우미로 한 번 놓는다
 * - 화면 도우미 실행 파일이 바뀌면 대표에게 알린다
 * 백엔드를 띄우는 시험은 메인이 실제 CLI가 아닌 것을 확인한다 (리드 결정 S6-19)
 */
import { readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID, OWNER } from '@shared/domain';
import { createFakeDesktop, killFakePids, type FakeDesktop } from '../fixtures/desktop/fakeDesktop';
import { buildOrchestratorDeps } from '../../src/main/backend/buildDeps';
import { RESTART_CUT_DETAIL, SCREEN_UNCONFIRMED_KEY } from '../../src/main/desktop/lifecycle';
import { createOperatorConfig, parseServerConfig } from '../../src/server/config';
import { SCREEN_ARMED_KEY, SCREEN_OFF_TEXT, screenModeOff, type ScreenProbeOutcome } from '../../src/main/desktop/safety';
import type { RunnerProblem } from '../../src/main/process/types';
import { bootApp, tempDir, waitFor as waitApp, type App } from '../acceptance/security-helpers';
import { bootGui, capture, input, inputLines, liveMain, rid } from './guiRig';
import { bootOrch, notices, sleep, waitFor, type OrchEnv } from './orchHarness';

const open: { close(): Promise<unknown> }[] = [];
const fakes: FakeDesktop[] = [];
afterEach(async () => {
  for (const g of open.splice(0)) await g.close();
  for (const f of fakes.splice(0)) await f.cleanup();
});

const SMALL = [{ x: 0, y: 0, width: 320, height: 200, dpi: 96, primary: true }];
const view = (e: OrchEnv) => e.core.views.snapshot().seat.screen;
const prereq = async (e: OrchEnv) => (await e.invoke('system.prereqs')).screen;
const screenAlerts = (e: OrchEnv) => e.ctx.store.queue.list({}).filter((q) => q.alertKey?.startsWith('alert:screen:'));

describe('화면 조작을 쓰지 않는 실행 (S6-11)', () => {
  it('판정: 데스크톱 앱 → desktop_mode, Windows 밖 → unsupported_os, 운영자가 끔 → disabled. 시험이 도우미를 직접 준 실행만 방식 없이 쓴다', () => {
    const code = (o: Parameters<typeof screenModeOff>[0]) => screenModeOff(o)?.code ?? null;
    expect(code({ mode: 'desktop', platform: 'win32', helperGiven: false })).toBe('desktop_mode');
    // 데스크톱 앱에는 도우미를 넘겨도 쓰지 않는다
    expect(code({ mode: 'desktop', platform: 'win32', helperGiven: true, enabled: true })).toBe('desktop_mode');
    expect(code({ platform: 'win32', helperGiven: false })).toBe('desktop_mode');
    expect(code({ mode: 'server', platform: 'linux', helperGiven: false })).toBe('unsupported_os');
    expect(code({ mode: 'server', platform: 'darwin', helperGiven: false })).toBe('unsupported_os');
    expect(code({ mode: 'server', platform: 'win32', helperGiven: false, enabled: false })).toBe('disabled');
    expect(code({ mode: 'server', platform: 'win32', helperGiven: true, enabled: false })).toBe('disabled');
    expect(code({ mode: 'server', platform: 'win32', helperGiven: false })).toBeNull();
    expect(code({ mode: 'server', platform: 'win32', helperGiven: false, enabled: true })).toBeNull();
    expect(code({ mode: 'server', platform: 'win32', helperGiven: false, enabled: null })).toBeNull();
    expect(code({ platform: 'linux', helperGiven: true })).toBeNull();
    expect(SCREEN_OFF_TEXT.desktop_mode).toBe('데스크톱 앱에서는 화면 조작을 쓰지 않습니다 — 서버 모드의 서버 PC에서만 씁니다');
  });

  it('앱 조립: 데스크톱 앱과 운영자가 끈 서버에는 넘겨받은 화면 도우미도 넣지 않는다', async () => {
    const fake = createFakeDesktop();
    fakes.push(fake);
    const base = { appRoot: process.cwd(), isPackaged: false, nodeExecPath: process.execPath, nodeExecEnv: {}, shell: null, memorySecrets: true, runnerMode: 'taskkill' as const, jobHelper: null };
    const build = async (o: Partial<Parameters<typeof buildOrchestratorDeps>[0]>) => {
      const dataDir = tempDir('screen-deps');
      const deps = await buildOrchestratorDeps({ ...base, dataDir, ...o });
      deps.store.close();
      deps.runner.dispose?.();
      return [!!deps.desktop, deps.screenOff?.code ?? null];
    };
    expect(await build({ mode: 'desktop', desktop: { launcher: fake.launcher } })).toEqual([false, 'desktop_mode']);
    expect(await build({ mode: 'server', desktop: { launcher: fake.launcher }, screen: { enabled: false } })).toEqual([false, 'disabled']);
    expect(await build({ mode: 'server', desktop: { launcher: fake.launcher }, screen: { enabled: true } })).toEqual([true, null]);
    expect(await build({ desktop: { launcher: fake.launcher } })).toEqual([true, null]);
    // 시험 중에는 실제 화면 도우미를 넣지 않는다 (실제 화면 시험 문이 닫혀 있다) — 서버 방식이어도
    expect(await build({ mode: 'server' })).toEqual([false, null]);
    expect(await build({})).toEqual([false, 'desktop_mode']);
    expect(fake.launches()).toBe(0);
  });

  it('쓰지 않는 실행에서는 화면 도구가 그 글로 unavailable이고 도우미를 띄우지 않는다 — 화면 확인 업무도 사전 점검도 없다', async () => {
    const fake = createFakeDesktop();
    fakes.push(fake);
    let probes = 0;
    const probe = async (): Promise<ScreenProbeOutcome> => {
      probes++;
      return { ok: true, reply: { lock: null } };
    };
    const e = await bootOrch({ desktop: { launcher: fake.launcher, probe }, screenOff: { code: 'desktop_mode', text: SCREEN_OFF_TEXT.desktop_mode } });
    open.push(e);
    await e.idle();
    expect(e.ctx.store.queue.list({}).filter((q) => q.kind === 'screen_check')).toEqual([]);
    const turnId = await liveMain(e);
    for (const [tool, args] of [
      ['screen_capture', {}],
      ['screen_info', {}],
      ['gui_input', { action: 'key', keys: 'enter', capture_id: 'SC-000001', request_id: rid() }],
      ['get_screen_check', {}],
      ['answer_screen_check', { code: '1234', request_id: rid() }],
    ] as const) {
      expect([tool, await e.tool(turnId, tool, args)]).toMatchObject([tool, { ok: false, code: 'unavailable', message: SCREEN_OFF_TEXT.desktop_mode }]);
    }
    expect([fake.launches(), probes]).toEqual([0, 0]);
    expect(view(e)).toMatchObject({ unavailable: { code: 'desktop_mode', text: SCREEN_OFF_TEXT.desktop_mode }, operatingSince: null, paused: null });
    expect(await prereq(e)).toMatchObject({ ok: false, state: 'desktop_mode', detail: SCREEN_OFF_TEXT.desktop_mode });
    // 상태는 스냅숏마다 바뀌지 않는다
    expect(view(e).unavailable!.since).toBe(view(e).unavailable!.since);
    // 화면 도우미가 아예 없는 실행(시험 중의 서버)은 helper_failed
    const bare = await bootOrch({ mode: 'server' });
    open.push(bare);
    expect(bare.core.views.snapshot().seat.screen.unavailable).toMatchObject({ code: 'helper_failed' });
    expect(bare.core.desktop.prereq()).toMatchObject({ ok: false, state: 'helper_failed' });
  });
});

describe('잠김·끊김을 알아채고 알린다 (S6-11)', () => {
  it('잠긴 화면에서는 도구가 unavailable이고, 대표의 자리 화면·사전 점검·알림이 대표가 할 일(운영자에게 부탁)을 말한다 — 종류가 바뀌면 다시, 풀리면 지운다', async () => {
    const g = await bootGui();
    open.push(g);
    const e = g.e;
    expect(view(e).unavailable).toBeNull();
    expect(await prereq(e)).toMatchObject({ ok: false, state: 'unknown' });
    const turnId = await liveMain(e);
    const c = await capture(e, turnId);
    expect(await prereq(e)).toMatchObject({ ok: true, state: 'available', detail: expect.stringContaining('모니터 1개') });
    g.fake.act({ do: 'set', value: { lock: 'locked' } });
    await sleep(150);
    const shot = await e.tool(turnId, 'screen_capture', {});
    expect(shot).toMatchObject({ ok: false, code: 'unavailable' });
    if (!shot.ok) expect(shot.message).toContain('ask_owner');
    // 입력도 조용히 사라지지 않는다 — 도우미가 잠김으로 거부한다
    expect(await input(e, turnId, { action: 'click', capture_id: c.data.capture_id, x: 300, y: 200 })).toMatchObject({ ok: false, code: 'unavailable' });
    expect(await e.tool(turnId, 'screen_info', {})).toMatchObject({ ok: false, code: 'unavailable' });
    const locked = view(e).unavailable!;
    expect(locked).toMatchObject({ code: 'locked', text: expect.stringContaining('서버 PC 운영자에게 잠금 해제·다시 로그온을 부탁하세요') });
    // 대표에게 보이는 글에는 메인의 도구 이름이 없다
    expect(locked.text).not.toContain('ask_owner');
    expect(await prereq(e)).toMatchObject({ ok: false, state: 'locked', detail: locked.text });
    const lockNotices = () => e.ctx.store.notifications.list().filter((n) => n.key?.startsWith('screen:'));
    expect(lockNotices().map((n) => [n.key, n.level, n.link, n.readAt])).toEqual([['screen:locked', 'normal', { tab: 'seat', panel: 'screen' }, null]]);
    expect(lockNotices()[0]!.body).toContain('서버 PC 운영자에게 잠금 해제·다시 로그온을 부탁하세요');
    // 같은 잠김이 이어지는 동안은 한 번만
    await e.tool(turnId, 'screen_capture', {});
    expect(lockNotices()).toHaveLength(1);
    expect(view(e).unavailable!.since).toBe(locked.since);
    // 종류가 바뀌면(원격 세션 끊김) 새로 알린다
    g.fake.act({ do: 'set', value: { lock: 'disconnected' } });
    await sleep(150);
    await e.tool(turnId, 'screen_capture', {});
    expect(view(e).unavailable).toMatchObject({ code: 'disconnected', text: expect.stringContaining('tscon') });
    expect(lockNotices().map((n) => n.key).sort()).toEqual(['screen:disconnected', 'screen:locked']);
    // 풀리면 다음 호출이 알아채고 상태·알림을 지운다
    g.fake.act({ do: 'set', value: { lock: null } });
    await sleep(150);
    expect((await e.tool(turnId, 'screen_capture', {})).ok).toBe(true);
    expect(view(e).unavailable).toBeNull();
    expect(await prereq(e)).toMatchObject({ ok: true, state: 'available' });
    expect(lockNotices().find((n) => n.key === 'screen:disconnected')!.readAt).not.toBeNull();
    const rows = e.ctx.store.activity.search({ kinds: ['screen'], limit: 50 }).map((a) => a.text);
    expect(rows.filter((t) => t.startsWith('서버 PC 화면을 쓸 수 없음'))).toHaveLength(2);
    expect(rows.filter((t) => t.startsWith('서버 PC 화면을 다시 쓸 수 있음'))).toHaveLength(1);
    // 잠김 거부는 기록에 남는다 (입력은 보내려 했다)
    expect(e.ctx.store.guiActions.query({ turnId, results: ['unavailable'], limit: 20 }).length).toBeGreaterThanOrEqual(3);
  });

  it('도우미가 한 번 뜻밖에 끝나도 다음 호출이 다시 띄운다 — 세 번 실패해야 다시 시작할 때까지 쓸 수 없다', async () => {
    const g = await bootGui();
    open.push(g);
    const e = g.e;
    const turnId = await liveMain(e);
    await capture(e, turnId);
    for (let i = 1; i <= 2; i++) {
      for (const pid of g.fake.pids()) {
        try {
          process.kill(pid);
        } catch {
          // 이미 끝났다
        }
      }
      await waitFor(() => e.core.desktop.peek()!.pid === null, '도우미 끝남');
      expect([i, (await e.tool(turnId, 'screen_capture', {})).ok]).toEqual([i, true]);
      expect(view(e).unavailable).toBeNull();
    }
    expect(g.fake.launches()).toBe(3);
    for (const pid of g.fake.pids()) {
      try {
        process.kill(pid);
      } catch {
        // 이미 끝났다
      }
    }
    await waitFor(() => e.core.desktop.peek()!.pid === null, '도우미 끝남');
    const dead = await e.tool(turnId, 'screen_capture', {});
    expect(dead).toMatchObject({ ok: false, code: 'unavailable' });
    if (!dead.ok) expect(dead.message).toContain('3번 실패해 더 띄우지 않습니다');
    expect(g.fake.launches()).toBe(3);
    expect(view(e).unavailable).toMatchObject({ code: 'helper_failed', text: expect.stringContaining('서버 PC 운영자에게') });
  });
});

describe('사전 점검 — 시작 뒤 한 번, system.prereqs는 띄우지 않는다 (S6-11)', () => {
  it('확인이 잠김을 알리면 마지막으로 안 상태가 되고 대표에게 알린다 — 메인 알림 업무는 넣지 않는다(도구가 알아챈 것만). 60초 안에는 다시 확인하지 않는다', async () => {
    let probes = 0;
    const probe = async (): Promise<ScreenProbeOutcome> => {
      probes++;
      return { ok: true, reply: { session: 1, interactive: true, lock: 'locked', monitors: 2, build: 18363, wda: false, elevated: true } };
    };
    const g = await bootGui({}, { helper: { probe } });
    open.push(g);
    const e = g.e;
    await waitFor(() => probes === 1 && view(e).unavailable !== null, '시작 뒤 사전 점검');
    expect(view(e).unavailable).toMatchObject({ code: 'locked' });
    expect(await prereq(e)).toMatchObject({ ok: false, state: 'locked', elevated: true });
    expect(notices(e, '화면 조작을 쓸 수 없습니다 — 화면 잠김')).toHaveLength(1);
    expect(screenAlerts(e)).toEqual([]);
    await prereq(e);
    await e.core.desktop.safety.probe();
    expect(probes).toBe(1);
    expect(g.fake.launches()).toBe(0);
  });

  it('확인이 괜찮다고 하면 쓸 수 있음이고, 표시가 캡처에 찍히는 옛 빌드와 관리자 권한을 말한다. 확인하지 못하면 helper_failed', async () => {
    const ok = async (): Promise<ScreenProbeOutcome> => ({ ok: true, reply: { lock: null, monitors: 2, wda: false, elevated: true } });
    const g = await bootGui({}, { helper: { probe: ok } });
    open.push(g);
    await waitFor(() => g.e.core.desktop.prereq().state === 'available', '사전 점검');
    const p = g.e.core.desktop.prereq();
    expect(p).toMatchObject({ ok: true, state: 'available', elevated: true });
    expect(p.detail).toContain('모니터 2개');
    expect(p.detail).toContain('조작 중 표시가 캡처에 함께 찍힙니다');
    expect(p.detail).toContain('관리자 권한');
    const bad = async (): Promise<ScreenProbeOutcome> => ({ ok: false, reason: 'csc.exe를 찾지 못했습니다' });
    const h = await bootGui({}, { helper: { probe: bad } });
    open.push(h);
    await waitFor(() => h.e.core.desktop.prereq().state === 'helper_failed', '사전 점검 실패');
    expect(h.e.core.desktop.prereq().detail).toContain('csc.exe를 찾지 못했습니다');
    expect(screenAlerts(h.e)).toEqual([]);
  });
});

describe('대표의 보기 — screens.recent · screens.image (S6-2)', () => {
  it('최근 캡처와 동작 기록을 새 것부터 준다(이미지 바이트·비밀 값 없이). 이미지는 보관 중이고 기록의 해시와 맞을 때만 — 바뀌거나 지워진 파일은 null', async () => {
    const g = await bootGui({ screens: SMALL, windows: [] });
    open.push(g);
    const e = g.e;
    const turnId = await liveMain(e);
    const c1 = await capture(e, turnId);
    expect((await input(e, turnId, { action: 'click', capture_id: c1.data.capture_id, x: 10, y: 20 })).ok).toBe(true);
    const SECRET = 'sk-ant-api03-NotRegisteredButFormatKey0123456789abcdefABCDEF';
    expect(await input(e, turnId, { action: 'type', capture_id: c1.data.capture_id, text: `키 ${SECRET}` })).toMatchObject({ ok: false, code: 'secret_blocked' });
    const c2 = await capture(e, turnId);
    const recent = await e.invoke('screens.recent');
    expect(recent.captures.map((c) => [c.id, c.kept, c.cause, c.width, c.height, c.generation, c.sha256.length])).toEqual([
      [c2.data.capture_id, true, 'capture', 320, 200, 1, 64],
      [c1.data.capture_id, true, 'capture', 320, 200, 1, 64],
    ]);
    expect(recent.actions.map((a) => [a.action, a.result, a.by])).toEqual([
      ['capture', 'ok', 'main'],
      ['type', 'secret_blocked', 'main'],
      ['click', 'ok', 'main'],
      ['capture', 'ok', 'main'],
    ]);
    expect(recent.actions[1]).toMatchObject({ text: null, textLength: [...`키 ${SECRET}`].length });
    expect(recent.actions[2]).toMatchObject({ x: 10, y: 20, beforeCaptureId: c1.data.capture_id });
    expect(recent.nextCursor).toBeNull();
    const json = JSON.stringify(recent);
    expect(json).not.toContain(SECRET);
    expect(json).not.toContain('iVBOR'); // PNG의 base64 머리
    // 쪽 넘기기: 새 것부터 둘씩
    const p1 = await e.invoke('screens.recent', { limit: 2 });
    expect([p1.actions.map((a) => a.action), p1.nextCursor]).toEqual([['capture', 'type'], p1.actions[1]!.id]);
    const p2 = await e.invoke('screens.recent', { limit: 2, before: p1.nextCursor! });
    expect([p2.actions.map((a) => a.action), p2.nextCursor]).toEqual([['click', 'capture'], null]);
    await expect(e.invoke('screens.recent', { before: 'T-1' })).rejects.toMatchObject({ code: 'invalid' });

    // 이미지: 파일 바이트 그대로 (data URL)
    const bytes = readFileSync(c1.data.file);
    const img = await e.invoke('screens.image', c1.data.capture_id);
    expect(img).toMatchObject({ id: c1.data.capture_id, mime: 'image/png', width: 320, height: 200 });
    expect(Buffer.from(img!.dataUrl.replace('data:image/png;base64,', ''), 'base64').equals(bytes)).toBe(true);
    // 모르는 ID·모양이 틀린 ID
    for (const id of ['SC-999999', 'S-1', '../SC-000001', 'GA-000001', `${c1.data.capture_id}.png`]) expect([id, await e.invoke('screens.image', id)]).toEqual([id, null]);
    await expect(e.invoke('screens.image', '')).rejects.toMatchObject({ code: 'invalid_args' });
    // 바꿔치기한 파일(크기가 다름)은 주지 않고, 목록에서도 보관 중이 아니다
    writeFileSync(c1.data.file, Buffer.concat([bytes, Buffer.from('x')]));
    expect(await e.invoke('screens.image', c1.data.capture_id)).toBeNull();
    expect((await e.invoke('screens.recent')).captures.find((c) => c.id === c1.data.capture_id)!.kept).toBe(false);
    // 크기와 수정 시각까지 맞춘 바꿔치기 — 이미지는 늘 다시 해시하므로 주지 않는다
    const st = statSync(c2.data.file);
    const swapped = Buffer.from(readFileSync(c2.data.file));
    swapped[swapped.length - 5] = swapped[swapped.length - 5]! ^ 0xff;
    writeFileSync(c2.data.file, swapped);
    utimesSync(c2.data.file, st.atime, st.mtime);
    expect(await e.invoke('screens.image', c2.data.capture_id)).toBeNull();
    // 지워진 파일
    unlinkSync(c2.data.file);
    expect(await e.invoke('screens.image', c2.data.capture_id)).toBeNull();
    expect((await e.invoke('screens.recent')).captures.map((c) => c.kept)).toEqual([false, false]);
    // 보기는 아무것도 보내지 않는다 — 도우미가 받은 입력은 그 클릭 하나뿐
    expect(inputLines(g.fake)).toHaveLength(1);
  });
});

describe('다시 시작했을 때 화면 조작 기록을 맞춘다 (S6-9)', () => {
  it('답을 받지 못한 입력 줄을 닫고, 턴 한 줄을 남기고, 앞 실행이 놓지 못한 키를 새 도우미로 한 번 놓는다 — 시작한 메인 턴은 모두 모의 실행이다', async () => {
    const fake = createFakeDesktop({ heldKeys: 2 });
    fakes.push(fake);
    const dataDir = tempDir('screen-restart');
    const desktop = { launcher: fake.launcher, timeouts: { READY: 5000 } };
    let app: App = await bootApp({ dataDir, desktop });
    open.push({ close: () => app.close([dataDir]) });
    const mainTurns = (a: App) => a.ctx.store.turns.list({ ref1: MAIN_AGENT_ID });
    // 첫 보유자의 화면 확인 턴 (모의 보유자가 시험 이미지를 맞힌다)
    await waitApp(() => a1Seat(app) === 'verified' && app.core.turns.count() === 0, '화면 확인 턴');
    const turn = mainTurns(app)[0]!;
    // 앞 실행이 입력 줄을 쓰고 답을 받기 전에 끝난 것처럼: 그 턴의 'sent' 줄, 놓기 표시(무장한 채 끝남)
    const records = app.core.desktop.records;
    const base = { at: app.ctx.now(), generation: 1, turnId: turn.id, projectId: null, by: 'main' as const, requestId: null, x: null, y: null, x2: null, y2: null, button: null, count: null, amount: null, beforeCaptureId: null, afterCaptureId: null, capture: null };
    const sent = records.insert({ ...base, action: 'key', keys: 'ctrl+s', result: 'sent', dispatched: true, requestId: 'rq-cut' });
    app.ctx.store.kv.set(SCREEN_ARMED_KEY, { at: app.ctx.now(), pid: 1, turnId: turn.id });
    expect(fake.launches()).toBe(0);
    await app.stop();
    // 다시 시작
    app = await bootApp({ dataDir, desktop });
    const row = app.ctx.store.guiActions.get(sent.id)!;
    expect([row.result, row.detail]).toEqual(['error', RESTART_CUT_DETAIL]);
    // 같은 request_id는 다시 보내지 않는다 (보냈는지 모르는 줄도 보낸 것으로 친다)
    expect(app.ctx.store.guiActions.dispatchedRequest(1, 'rq-cut')?.id).toBe(sent.id);
    // 그 턴의 화면 조작 한 줄 (앞 실행이 남기지 못했다)
    expect(app.ctx.store.activity.search({ turnId: turn.id, kinds: ['screen'], limit: 10 }).map((a) => a.text)).toEqual(['화면 조작 1회 (캡처 0장)']);
    // 새 도우미를 한 번 띄워 놓았다
    await app.core.desktop.lifecycle.restartRelease;
    expect(fake.launches()).toBe(1);
    expect(fake.received().filter((l) => /^\d+ RELEASE$/.test(l))).toHaveLength(1);
    expect(app.ctx.store.kv.get(SCREEN_ARMED_KEY)).toBeNull();
    expect(app.ctx.store.activity.search({ kinds: ['screen'], limit: 20 }).some((a) => a.text.startsWith('서버를 다시 시작하며 새 화면 도우미로 눌린 키·버튼을 뗌 (2개)'))).toBe(true);
    // 한 번 더 다시 시작하면 아무것도 하지 않는다
    await app.stop();
    app = await bootApp({ dataDir, desktop });
    await sleep(200);
    expect(app.core.desktop.lifecycle.restartRelease).toBeNull();
    expect(fake.received().filter((l) => /^\d+ RELEASE$/.test(l))).toHaveLength(1);
    // 이 시험이 띄운 메인 턴은 모두 모의 실행이다 — 실제 CLI는 뜨지 않았다
    const turns = mainTurns(app);
    expect(turns.length).toBeGreaterThanOrEqual(1);
    expect(turns.every((t) => t.mock === true && t.aiKind !== undefined)).toBe(true);
  }, 120_000);

  it('끝남을 확인하지 못한 화면 도우미의 문(kv desktop:unconfirmed)은 다시 시작해도 읽히고 시작 때의 맞추기(reconcile)가 연다 — 앞 실행의 도우미는 서버와 함께 끝났다. 앱 종료는 그 도우미를 다시 2.8초씩 기다리지 않는다 (S6-21 A1·A2)', async () => {
    const fake = createFakeDesktop({ noAck: ['STOP'], ignoreEof: true });
    fakes.push(fake);
    const dataDir = tempDir('screen-gate-restart');
    // 끝내기가 듣지 않는 도우미 (끝나지 않는 도우미 흉내)
    const desktop = { launcher: fake.launcher, timeouts: { READY: 5000, STOP_ACK: 100, STOP_CONFIRM: 600 }, kill: () => undefined };
    let app: App = await bootApp({ dataDir, desktop });
    open.push({
      close: async () => {
        killFakePids(fake.pids());
        await app.close([dataDir]);
      },
    });
    await waitApp(() => app.core.turns.count() === 0, '첫 화면 확인 턴');
    // 도우미가 떠 있고 도는 메인 턴이 없을 때의 긴급 정지 — STOP에 답하지 않고 끝나지도 않는다
    expect((await app.core.desktop.client()!.ready()).ok).toBe(true);
    const s = await app.core.stops.emergency(OWNER);
    expect(s.completed).toBe(false);
    expect(app.ctx.store.kv.get(SCREEN_UNCONFIRMED_KEY)).toMatchObject({ cause: '긴급 정지', turnId: null });
    expect(app.core.desktop.prereq()).toMatchObject({ ok: false, state: 'helper_failed', detail: expect.stringContaining('끝났는지 확인하지 못해') });
    // 도는 메인 턴이 없어 메인 에이전트를 곧바로 일시정지했다 (S6-21 A1)
    await waitApp(() => !!app.ctx.stop().members[MAIN_AGENT_ID]?.paused, '메인 일시정지');
    // 앱 종료: 이미 멈췄지만 끝남을 확인하지 못한 도우미에 STOP을 다시 쓰고 기다리지 않는다 (stopAll·dispose가 잇달아 부른다)
    const t0 = Date.now();
    await app.stop();
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(fake.received().filter((l) => l === 'STOP')).toHaveLength(1);
    // 실제 서버에서는 서버의 작업 개체가 끝낸다 — 시험에서는 직접 끝낸다
    killFakePids(fake.pids());
    app = await bootApp({ dataDir, desktop });
    // 시작할 때 kv에서 읽은 문을 맞추기가 열었다 (읽지 않았으면 이 활동 기록이 없다)
    expect(app.ctx.store.kv.get(SCREEN_UNCONFIRMED_KEY)).toBeNull();
    expect(app.core.desktop.lifecycle.unconfirmed()).toBeNull();
    const opened = app.ctx.store.activity.search({ kinds: ['screen'], limit: 30 }).filter((a) => a.text.startsWith('화면 도우미가 끝난 것을 확인함 — 서버를 다시 시작함'));
    expect(opened).toHaveLength(1);
    // 그 문과 함께 건 메인 에이전트의 일시정지는 다시 시작해도 남는다(CTL-11과 같다) — 그 줄이 그렇게 말하고 출구를 적는다 (S6-23 M 'accepted (a)')
    expect(app.ctx.stop().members[MAIN_AGENT_ID]?.paused).toBeTruthy();
    expect(opened[0]!.text).toContain("— 다만 메인 에이전트의 일시정지는 다시 시작해도 그대로입니다. 대표가 '정지 해제'를 누르면 풀립니다");
    expect(app.core.desktop.prereq().state).not.toBe('helper_failed');
    // 새 도우미를 띄울 수 있다
    fake.set({ noAck: [], ignoreEof: false });
    expect((await app.core.desktop.client()!.ready()).ok).toBe(true);
    expect(fake.launches()).toBe(2);
  }, 120_000);

  it('놓을 도우미가 없으면(쓰지 않는 실행) 놓기 표시를 지우고 그 PC 앞에서 할 일을 활동 기록에 남긴다 — 되풀이하지 않는다', async () => {
    const e = await bootOrch();
    open.push(e);
    e.ctx.store.kv.set(SCREEN_ARMED_KEY, { at: e.ctx.now(), pid: 1, turnId: null });
    e.core.desktop.reconcile();
    await e.core.desktop.lifecycle.restartRelease;
    expect(e.ctx.store.kv.get(SCREEN_ARMED_KEY)).toBeNull();
    const rows = e.ctx.store.activity.search({ kinds: ['screen'], level: 'warn', limit: 10 }).map((a) => a.text);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain('눌린 키·버튼을 떼지 못함');
    expect(rows[0]).toContain('눌렀다 떼야 합니다');
  });
});

describe('화면 도우미 실행 파일이 바뀌면 대표에게 알린다 (S6-5)', () => {
  it('띄울 때 해시가 다르면 긴급 알림(같은 key는 갱신)과 활동 기록 — 서버를 끝내면 구독을 끊는다', async () => {
    let fire: ((p: RunnerProblem) => void) | null = null;
    let offs = 0;
    const g = await bootGui(
      {},
      {
        helper: {
          onProblem: (cb) => {
            fire = cb;
            return () => {
              offs++;
            };
          },
        },
      },
    );
    open.push(g);
    expect(fire).not.toBeNull();
    fire!({ kind: 'binary_changed', text: '화면 도우미 파일(WookDesktopHelper.exe)이 준비할 때와 다릅니다 (해시가 다름)' });
    fire!({ kind: 'binary_changed', text: '화면 도우미 파일(WookDesktopHelper.exe)이 준비할 때와 다릅니다 (또 다름)' });
    const n = notices(g.e, '화면 도우미 파일이 바뀜');
    expect(n.map((x) => [x.level, x.key])).toEqual([['urgent', 'screen-helper-problem']]);
    expect(n[0]!.body).toContain('또 다름');
    expect(n[0]!.body).toContain('서버 PC의 운영자에게');
    expect(g.e.ctx.store.activity.search({ kinds: ['system'], level: 'error', limit: 10 }).filter((a) => a.text.includes('화면 도우미 파일이 바뀜'))).toHaveLength(2);
    await g.e.orch.stop();
    expect(offs).toBe(1);
  });
});

describe('운영자 설정 server.json의 screen.enabled (S6-11)', () => {
  it('참·거짓만 받는다 — 칸이 없으면 켬, "false" 같은 글은 거부한다(켬으로 읽지 않는다). 모르는 칸은 쓰지 않는다고 경고한다', () => {
    expect(parseServerConfig({}).config.screen).toEqual({ enabled: null });
    expect(parseServerConfig({ screen: {} }).config.screen).toEqual({ enabled: null });
    expect(parseServerConfig({ screen: { enabled: false } }).config.screen).toEqual({ enabled: false });
    expect(parseServerConfig({ screen: { enabled: true } }).config.screen).toEqual({ enabled: true });
    expect(parseServerConfig({ screen: { enabled: false } }).warnings).toEqual([]);
    for (const bad of ['false', 0, 'off', []]) expect(() => parseServerConfig({ screen: { enabled: bad } })).toThrow('server.json의 screen.enabled는 true나 false여야 합니다');
    expect(() => parseServerConfig({ screen: false })).toThrow('server.json의 screen은(는) 객체여야 합니다');
    expect(parseServerConfig({ screen: { enabled: false, rate: 10 } }).warnings).toEqual(['모르는 칸 screen.rate은(는) 쓰지 않습니다']);
  });

  it('시작할 때만 읽는다 — 파일 값이 시작 때와 달라지면 reload는 다시 시작해야 바뀐다고 경고하고 아무것도 바꾸지 않는다', () => {
    const dir = tempDir('screen-config');
    const path = join(dir, 'server.json');
    const log = { info: () => undefined, warn: () => undefined, error: () => undefined };
    const operator = { applyServerConfig: () => [], serverConfigState: () => ({}) } as unknown as Parameters<typeof createOperatorConfig>[0]['operator'];
    const config = (atStart: boolean | null) => createOperatorConfig({ path, ownerEmailFlag: null, operator, logger: log, screenEnabledAtStart: atStart });
    writeFileSync(path, JSON.stringify({ screen: { enabled: false } }));
    // 켠 채 시작했는데 파일이 끔으로 바뀌었다
    expect(config(null).reload().warnings).toEqual(['server.json의 screen.enabled(화면 조작 끔)는 서버를 다시 시작해야 바뀝니다 — 지금은 화면 조작이 켜져 있습니다']);
    expect(config(true).reload().warnings).toHaveLength(1);
    // 끈 채 시작했고 파일도 끔 — 경고 없음
    expect(config(false).reload().warnings).toEqual([]);
    writeFileSync(path, JSON.stringify({}));
    expect(config(false).reload().warnings).toEqual(['server.json의 screen.enabled(화면 조작 켬)는 서버를 다시 시작해야 바뀝니다 — 지금은 화면 조작이 꺼져 있습니다']);
    expect(config(null).reload().warnings).toEqual([]);
  });
});

function a1Seat(app: App): string {
  return app.ctx.store.seat.get('main')?.vision ?? 'unknown';
}

