import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
// @ts-expect-error Node-only test helper; renderer ambient types deliberately exclude Node.
import { createHash } from 'node:crypto';
// @ts-expect-error Node-only test helper; renderer ambient types deliberately exclude Node.
import { inflateSync } from 'node:zlib';
// @ts-expect-error Node-only test helper; renderer ambient types deliberately exclude Node.
import { Buffer } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSnapshot, NotificationView, ScreenRecentView } from '../../../shared/views';
import { GUI_RESULT_LABEL } from '../../../shared/labels';
import { snapshot as seed, settings } from '../api/fake/data';
import { createFakeSeat } from '../api/fake/seat';
import { createFakeScreens, fakeScreenState } from '../api/fake/screens';
import { ScreenChip } from './ScreenStatus';
import { CaptureImage, ScreenActionRecord, SeatScreenControl } from '../screens/SeatScreenControl';
import { SeatScreen } from '../screens/Seat';
import { ServerNotice } from './ServerNotice';
import { ActivityMarker } from './ActivityMarker';
import { SettingsScreen } from '../screens/Settings';
import { Home } from '../screens/Home';
import { Studio } from '../screens/Studio';
import { MemberPanel } from './MemberPanel';
import { noticePresentation } from '../lib/notice';
import { screenVision } from '../lib/screens';
import { subscribeCommand } from '../lib/commands';

const runtime = vi.hoisted(() => ({ host: null as HookHost | null, invoke: vi.fn(), subscribe: vi.fn() }));
vi.mock('../api/bridge', () => ({ getBridge: () => ({ invoke: runtime.invoke, subscribe: runtime.subscribe, platform: 'win32' }) }));
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return { ...actual,
    useState: (init: unknown) => runtime.host ? runtime.host.state(init) : actual.useState(init),
    useRef: (init: unknown) => runtime.host ? runtime.host.state({ current: init })[0] : actual.useRef(init),
    useEffect: (fn: () => void | (() => void), deps?: unknown[]) => runtime.host ? runtime.host.effect(fn, deps) : actual.useEffect(fn, deps),
    useCallback: <T extends (...args: never[]) => unknown>(fn: T, deps: unknown[]) => runtime.host ? fn : actual.useCallback(fn, deps),
  };
});
type Slot = { value: unknown; deps?: unknown[]; cleanup?: () => void };
class HookHost {
  slots: Slot[] = []; index = 0; effects: (() => void)[] = []; tree: ReactNode = null;
  disposed = false; writesAfterDispose = 0;
  state(init: unknown): [unknown, (value: unknown) => void] {
    const index = this.index++, slot = this.slots[index] ??= { value: typeof init === 'function' ? init() : init };
    return [slot.value, value => { if (this.disposed) this.writesAfterDispose++; slot.value = typeof value === 'function' ? value(slot.value) : value; }];
  }
  effect(fn: () => void | (() => void), deps?: unknown[]) {
    const index = this.index++, old = this.slots[index];
    if (!old || !deps || deps.some((dep, i) => !Object.is(dep, old.deps?.[i]))) this.effects.push(() => {
      old?.cleanup?.(); const cleanup = fn(); this.slots[index] = { value: null, deps, cleanup: typeof cleanup === 'function' ? cleanup : undefined };
    });
  }
  async render(component: () => ReactNode) {
    for (let pass = 0; pass < 4; pass++) {
      this.index = 0; runtime.host = this;
      try { this.tree = component(); } finally { runtime.host = null; }
      this.effects.splice(0).forEach(effect => effect());
      for (let tick = 0; tick < 8; tick++) await Promise.resolve();
    }
  }
  html() { return renderToStaticMarkup(this.tree); }
  dispose() { this.slots.forEach(slot => slot.cleanup?.()); this.slots = []; this.disposed = true; }
}
type Props = { children?: ReactNode; onClick?: (event: { preventDefault: () => void }) => unknown; 'aria-label'?: string; 'aria-selected'?: boolean; className?: string; panel?: 'screen'; visit?: number };
function elements(node: ReactNode): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  return isValidElement<Props>(node) ? [node, ...elements(node.props.children)] : [];
}
function click(label: string) {
  const button = elements(host.tree).find(node => node.type === 'button' && (node.props['aria-label'] === label || renderToStaticMarkup(node.props.children).replace(/<[^>]+>/g, '').trim() === label));
  expect(button, label).toBeDefined(); return button?.props.onClick?.({ preventDefault() {} });
}
let host: HookHost, snapshot: AppSnapshot, fixture: ReturnType<typeof createFakeScreens>, recent: ScreenRecentView;
let hidden = false;
const scrollCapture = vi.fn();
const visibility = new Set<() => void>();
const renderPanel = () => host.render(() => SeatScreenControl({ seat: snapshot.seat }));
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-06T04:00:00Z'));
  host = new HookHost(); snapshot = structuredClone(seed); snapshot.auth.loggedIn = true;
  snapshot.seat = createFakeSeat(new URLSearchParams('fakeScreen=operating')).seat;
  fixture = createFakeScreens(); recent = fixture.recent(); hidden = false; visibility.clear(); scrollCapture.mockReset();
  vi.stubGlobal('window', { dispatchEvent: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), location: { search: '?studio3d=0' } });
  vi.stubGlobal('document', { get hidden() { return hidden; }, getElementById: () => ({ scrollIntoView: scrollCapture }), addEventListener: (_: string, fn: () => void) => visibility.add(fn), removeEventListener: (_: string, fn: () => void) => visibility.delete(fn) });
  runtime.subscribe.mockReset().mockReturnValue(() => undefined);
  runtime.invoke.mockReset().mockImplementation(async (method: string, ...args: unknown[]) => {
    if (method === 'screens.recent') return structuredClone(recent);
    if (method === 'screens.image') return fixture.image(String(args[0]));
    if (method === 'seat.get') return structuredClone(snapshot.seat);
    if (method === 'seat.history') return [];
    if (method === 'settings.get') return structuredClone(settings);
    if (method === 'roles.list' || method === 'skills.list' || method === 'recovery.list' || method === 'notifications.list') return [];
    if (method === 'logs.search') return snapshot.recentActivity;
    if (method === 'system.info') return null;
    if (method === 'system.prereqs') return { git: { ok: true }, claude: { detail: '로그인됨' }, codex: { detail: '로그인됨' }, screen: { detail: '화면 도구가 잠겼습니다.' }, jobRunner: { detail: '하위 프로세스를 함께 종료합니다.' } };
    if (method === 'snapshot.get') return snapshot;
    throw new Error(`Unexpected call: ${method}`);
  });
});
afterEach(() => { host.dispose(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('stage 6 viewing server screen operations', () => {
  it('S6-chip-hidden. hides screen state before login and while idle', () => {
    const open = vi.fn(); snapshot.auth.loggedIn = false;
    expect(ScreenChip({ snapshot, open })).toBeNull();
    snapshot.auth.loggedIn = true; snapshot.seat.screen = fakeScreenState(null);
    expect(ScreenChip({ snapshot, open })).toBeNull();
  });
  it.each(['human', 'local'])('S6-chip-paused. shows %s reason and deadline instead of operating', scenario => {
    snapshot.seat.screen = fakeScreenState(scenario);
    const html = renderToStaticMarkup(ScreenChip({ snapshot, open: vi.fn() }));
    expect(html).toContain('화면 조작 멈춤'); expect(html).toContain(scenario === 'human' ? '서버 PC 앞 사람 입력' : '서버 PC의 멈춤 단축키');
    expect(html).toContain('까지'); expect(html).not.toContain('화면 조작 중');
    snapshot.seat.screen.operatingSince = null;
    expect(renderToStaticMarkup(ScreenChip({ snapshot, open: vi.fn() }))).toContain('화면 조작 멈춤');
  });
  it('S6-chip-route. opens the screen panel through the actual App callback', async () => {
    const { App } = await import('../App'); await host.render(App);
    const chip = elements(host.tree).find(node => node.type === ScreenChip);
    expect(chip).toBeDefined();
    if (isValidElement<{ open: () => void }>(chip)) chip.props.open();
    await host.render(App);
    expect(elements(host.tree).find(node => node.type === SeatScreen)?.props.panel).toBe('screen');
  });
  it.each(['locked', 'desktop'])('S6-unavailable. preserves the %s reason and way out', async scenario => {
    snapshot.seat.screen = fakeScreenState(scenario); await renderPanel();
    const status = elements(host.tree).find(node => node.props.className?.startsWith('screen-state'));
    expect(renderToStaticMarkup(status)).toContain(snapshot.seat.screen.unavailable!.text);
    expect(host.html()).toContain('화면 도구를 쓸 수 없습니다'); expect(host.html()).not.toContain('화면 도구 사용 가능');
  });
  it.each(['unknown', 'failed'] as const)('S6-vision. never claims verified for %s, explains the consequence', async vision => {
    snapshot.seat.vision = vision; snapshot.seat.screen = fakeScreenState('locked'); await renderPanel();
    const html = host.html(); expect(html).not.toContain('화면 보기: 확인됨');
    expect(html).toContain(vision === 'unknown' ? '아직 확인 안 함' : '글 정보만');
    if (vision === 'unknown') expect(screenVision(snapshot.seat)).toContain(snapshot.seat.screen.unavailable!.text);
    host.dispose(); host = new HookHost();
    await host.render(() => SeatScreen({ snapshot, navigate: vi.fn() }));
    expect(host.html()).toContain(vision === 'unknown' ? '아직 확인 안 함' : '글 정보만');
  });
  it('S6-typed. shows safe text and masks length-only, blocked, password and unknown focus text', () => {
    const row = fixture.actions[0];
    const render = () => renderToStaticMarkup(ScreenActionRecord({ row, captures: fixture.captures, open: vi.fn() }));
    expect(render()).toContain(row.text!);
    row.text = null; row.textLength = 24; expect(render()).toContain('가림 · 24자');
    row.text = 'must-never-appear'; row.result = 'secret_blocked'; expect(render()).not.toContain(row.text); expect(render()).toContain('가림 · 24자');
    row.result = 'ok'; row.focus!.password = true; expect(render()).not.toContain(row.text);
    row.focus!.password = null; expect(render()).not.toContain(row.text);
  });
  it('S6-kept. loads only opened kept images, never expired images or links', async () => {
    await renderPanel(); expect(runtime.invoke.mock.calls.some(([m]) => m === 'screens.image')).toBe(false);
    expect(host.html()).toContain('보관 기간이 지났거나 파일을 확인할 수 없습니다.');
    expect(elements(host.tree).some(node => node.props['aria-label'] === '캡처 SC-000001 보기')).toBe(false);
    await click('캡처 SC-000003 보기'); await renderPanel();
    expect(scrollCapture).toHaveBeenCalledWith({ block: 'center' });
    expect(elements(host.tree).some(node => node.type === CaptureImage)).toBe(true);
    recent.captures[0].kept = false;
    await vi.advanceTimersByTimeAsync(5000); await renderPanel();
    expect(elements(host.tree).some(node => node.type === CaptureImage)).toBe(false);
    host.dispose(); host = new HookHost();
    await host.render(() => CaptureImage({ capture: fixture.captures[2] }));
    expect(runtime.invoke.mock.calls.some(([m]) => m === 'screens.image')).toBe(false);
    host.dispose(); host = new HookHost();
    await host.render(() => CaptureImage({ capture: fixture.captures[0] }));
    expect(runtime.invoke).toHaveBeenCalledWith('screens.image', 'SC-000003'); expect(host.html()).toContain('<img');
    const open = vi.fn(); const row = fixture.actions.at(-1)!;
    expect(renderToStaticMarkup(ScreenActionRecord({ row, captures: fixture.captures, open }))).not.toContain('<button');
    expect(open).not.toHaveBeenCalled();
  });
  it('S6-image-late. ignores an image response after closing its view', async () => {
    let finish: ((value: unknown) => void) | undefined;
    runtime.invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await host.render(() => CaptureImage({ capture: fixture.captures[0] }));
    host.dispose(); finish?.(fixture.image('SC-000003')); for (let tick = 0; tick < 8; tick++) await Promise.resolve();
    expect(host.writesAfterDispose).toBe(0); expect(host.html()).not.toContain('<img');
  });
  it('S6-poll. polls every 5s without snapshot-identity refetch and stops on close, idle or hidden', async () => {
    const reads = () => runtime.invoke.mock.calls.filter(([m]) => m === 'screens.recent').length;
    await renderPanel(); expect(reads()).toBe(1);
    snapshot.seat = structuredClone(snapshot.seat); await renderPanel(); expect(reads()).toBe(1);
    await vi.advanceTimersByTimeAsync(4999); expect(reads()).toBe(1);
    await vi.advanceTimersByTimeAsync(1); expect(reads()).toBe(2);
    hidden = true; visibility.forEach(fn => fn()); await vi.advanceTimersByTimeAsync(10000); expect(reads()).toBe(2);
    hidden = false; visibility.forEach(fn => fn()); await Promise.resolve(); expect(reads()).toBe(3);
    snapshot.seat.screen.operatingSince = null; await renderPanel(); const idleReads = reads();
    await vi.advanceTimersByTimeAsync(10000); expect(reads()).toBe(idleReads);
    snapshot.seat.screen.operatingSince = new Date().toISOString(); await renderPanel(); const closeReads = reads();
    host.dispose(); await vi.advanceTimersByTimeAsync(10000); expect(reads()).toBe(closeReads); expect(visibility.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });
  it('S6-panel-close. unmounts the screen panel when another inner tab is selected', async () => {
    await host.render(() => SeatScreen({ snapshot, navigate: vi.fn(), panel: 'screen' }));
    expect(elements(host.tree).some(node => node.type === SeatScreenControl)).toBe(true);
    await click('자리와 인계'); await host.render(() => SeatScreen({ snapshot, navigate: vi.fn(), panel: 'screen' }));
    expect(elements(host.tree).some(node => node.type === SeatScreenControl)).toBe(false);
  });
  it('S6-notice. preserves panel through notification, App navigation and repeated visits', async () => {
    const item: NotificationView = { id: 'N-screen', key: 'screen:locked', title: '화면 잠김', body: '운영자에게 잠금 해제를 부탁하세요.', read: false, level: 'info', createdAt: new Date().toISOString(), link: { tab: 'seat', panel: 'screen' } };
    expect(noticePresentation(item, snapshot).link).toEqual(item.link);
    const draft = vi.fn(), off = subscribeCommand(draft), navigate = vi.fn();
    await host.render(() => ServerNotice({ item, snapshot, navigate, markRead: vi.fn(), close: vi.fn() }));
    await click('관련 화면 보기'); expect(navigate).toHaveBeenCalledWith(item.link); expect(draft).not.toHaveBeenCalled(); off();
    host.dispose(); host = new HookHost(); const { App } = await import('../App'); await host.render(App);
    const listener = runtime.subscribe.mock.calls.find(([topic]) => topic === 'navigate')?.[1];
    listener(item.link); await host.render(App);
    const panel = elements(host.tree).find(node => node.type === SeatScreen); expect(panel?.props.panel).toBe('screen');
    const firstVisit = panel?.props.visit; listener(item.link); await host.render(App);
    expect(elements(host.tree).find(node => node.type === SeatScreen)?.props.visit).toBeGreaterThan(firstVisit ?? 0);
  });
  it('S6-records. renders every result, actual coordinates, keys, generation and before/after viewing links', () => {
    const html = fixture.actions.map(row => renderToStaticMarkup(ScreenActionRecord({ row, captures: fixture.captures, open: vi.fn() }))).join('');
    for (const label of Object.values(GUI_RESULT_LABEL)) expect(html).toContain(label);
    for (const label of ['(480, 312) → (640, 400)', 'Ctrl+S', '세대 2', '세대 3', '메모장 · 산책 기록', '전 캡처 보기', '후 캡처 보기']) expect(html).toContain(label);
    const open = vi.fn();
    for (const node of elements(ScreenActionRecord({ row: fixture.actions[0], captures: fixture.captures, open }))) node.props.onClick?.({ preventDefault() {} });
    expect(open.mock.calls).toEqual([['SC-000002'], ['SC-000003']]);
  });
  it('S6-view-controls. has only capture viewing controls and cannot operate the screen', async () => {
    await renderPanel();
    for (const node of elements(host.tree).filter(node => node.type === 'button')) {
      expect(node.props['aria-label'] ?? '').toMatch(/^캡처 SC-\d+ 보기$/);
      await node.props.onClick?.({ preventDefault() {} });
    }
    await renderPanel();
    for (const node of elements(host.tree).filter(node => node.type === 'button')) {
      const name = node.props['aria-label'] ?? renderToStaticMarkup(node.props.children);
      expect(name).toMatch(/^(캡처 SC-\d+ 보기|캡처 닫기)$/);
      await node.props.onClick?.({ preventDefault() {} });
    }
    for (const row of recent.actions) {
      const record = ScreenActionRecord({ row, captures: recent.captures, open: vi.fn() });
      for (const node of elements(record).filter(node => node.type === 'button')) {
        expect(node.props['aria-label']).toMatch(/^GA-\d+ (전|후) 캡처 SC-\d+ 보기$/);
        await node.props.onClick?.({ preventDefault() {} });
      }
    }
    expect(runtime.invoke.mock.calls.every(([method]) => ['screens.recent', 'screens.image'].includes(method))).toBe(true);
  });
  it('S6-prereqs. shows both screen and job-object helper facts', async () => {
    await host.render(() => SettingsScreen({ snapshot, section: 'account', setSection: vi.fn(), logout: vi.fn(), openTask: vi.fn() }));
    for (const text of ['화면 도구', '작업 개체 도우미', '화면 도구가 잠겼습니다.', '하위 프로세스를 함께 종료합니다.']) expect(host.html()).toContain(text);
  });
  it('S6-activity. provides the screen icon', () => {
    const item = { ...snapshot.recentActivity[0], kind: 'screen' as const };
    const html = renderToStaticMarkup(ActivityMarker({ item })); expect(html).toContain('aria-label="화면 조작"'); expect(html).toContain('<svg');
  });
  it('S6-activity-labels. labels Home, Studio and settings logs and names M-MAIN correctly', async () => {
    const project = snapshot.projects[0];
    snapshot.recentActivity = [{ ...snapshot.recentActivity[0], kind: 'screen', memberId: 'M-MAIN', projectId: project.id, actorName: '알 수 없는 팀원', text: '화면 조작을 기록했습니다.' }];
    await host.render(() => Home({ snapshot, openProject: vi.fn(), openTask: vi.fn(), openReport: vi.fn(), openMember: vi.fn(), openPolicy: vi.fn() }));
    expect(host.html()).toContain('<small>화면 조작</small>');
    host.dispose(); host = new HookHost();
    await host.render(() => Studio({ snapshot, project, back: vi.fn(), openMember: vi.fn(), openTask: vi.fn(), openDirective: vi.fn(), openReport: vi.fn() }));
    expect(host.html()).toContain('<small>화면 조작'); expect(host.html()).toContain('<strong>메인 에이전트</strong>'); expect(host.html()).not.toContain('알 수 없는 팀원');
    host.dispose(); host = new HookHost();
    await host.render(() => SettingsScreen({ snapshot, section: 'logs', setSection: vi.fn(), logout: vi.fn(), openTask: vi.fn() }));
    expect(host.html()).toContain('<td>화면 조작</td>');
  });
  it('S6-work-label. shows screen_check as 화면 확인 in Home and member detail', async () => {
    const main = snapshot.members.find(member => member.isMain)!;
    main.currentTask = null; main.currentWork = { kind: 'screen_check', label: 'internal-probe-name', turnId: 'TN-probe', startedAt: new Date().toISOString() };
    await host.render(() => Home({ snapshot, openProject: vi.fn(), openTask: vi.fn(), openReport: vi.fn(), openMember: vi.fn(), openPolicy: vi.fn() }));
    expect(host.html()).toContain('화면 확인'); expect(host.html()).not.toContain('internal-probe-name');
    host.dispose(); host = new HookHost();
    runtime.invoke.mockResolvedValue({ member: main, role: { name: '메인' }, sessions: [], recentTurns: [], history: [], messages: [], queuedTasks: [], currentTask: null, cliEvents: [], rawEvents: [] });
    await host.render(() => MemberPanel({ id: main.id, snapshot, close: vi.fn(), openTask: vi.fn() }));
    expect(host.html()).toContain('화면 확인'); expect(host.html()).not.toContain('internal-probe-name');
  });
  it('S6-fixtures. covers every result, two generations, secret length and genuine generated PNG bytes', () => {
    expect(new Set(fixture.actions.map(row => row.result))).toEqual(new Set(Object.keys(GUI_RESULT_LABEL)));
    expect(new Set(fixture.captures.map(row => row.generation))).toEqual(new Set([2, 3]));
    expect(fixture.actions.find(row => row.result === 'secret_blocked')).toMatchObject({ text: null, textLength: 24 });
    expect(fixture.image('SC-000001')).toBeNull(); expect(fixture.image('unknown')).toBeNull();
    const png = Buffer.from(fixture.image('SC-000003')!.dataUrl.split(',')[1], 'base64');
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([640, 360]);
    expect(createHash('sha256').update(png).digest('hex')).toBe(fixture.captures[0].sha256);
    const idat: ReturnType<typeof Buffer.from>[] = []; for (let offset = 8; offset < png.length;) { const length = png.readUInt32BE(offset); if (png.toString('ascii', offset + 4, offset + 8) === 'IDAT') idat.push(png.subarray(offset + 8, offset + 8 + length)); offset += length + 12; }
    expect(inflateSync(Buffer.concat(idat)).length).toBe((640 * 3 + 1) * 360);
    const first = fixture.recent({ limit: 2 }); expect(first.actions).toHaveLength(2);
    expect(fixture.recent({ limit: 2, before: first.nextCursor! }).actions[0].id).toBe(fixture.actions[2].id);
  });
  it.each(['operating', 'human', 'local', 'locked', 'desktop'])('S6-fake-bridge. reads devParam %s and protects captures before login', async scenario => {
    vi.resetModules();
    vi.stubGlobal('window', { location: { search: `?fakeScreen=${scenario}` }, localStorage: { getItem: () => null, setItem: vi.fn() }, dispatchEvent: vi.fn(), setInterval, clearInterval });
    const { fakeBridge } = await import('../api/fake');
    await expect(fakeBridge.invoke('screens.recent')).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(fakeBridge.invoke('screens.image', 'SC-000003')).rejects.toMatchObject({ code: 'unauthorized' });
    await fakeBridge.invoke('auth.devLogin'); const view = await fakeBridge.invoke('seat.get');
    expect(view.screen).toEqual(fakeScreenState(scenario));
    expect((await fakeBridge.invoke('system.prereqs')).screen.ok).toBe(!view.screen.unavailable);
    expect((await fakeBridge.invoke('screens.recent')).actions).toHaveLength(13);
    expect(await fakeBridge.invoke('screens.image', 'SC-000001')).toBeNull();
    expect((await fakeBridge.invoke('screens.image', 'SC-000003'))?.mime).toBe('image/png');
    expect((await fakeBridge.invoke('snapshot.get')).recentActivity.some(row => row.kind === 'screen')).toBe(true);
  });
});
