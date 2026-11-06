import { isValidElement, type ReactNode, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthState, DeviceLoginPoll, DeviceLoginStart, DeviceSessionView, NotificationView } from '../../../shared/views';
import { snapshot as seed, settings as settingsSeed } from '../api/fake/data';
import { SettingsScreen } from '../screens/Settings';
import { ServerLogin, OwnerSetup, browserDeviceName } from './ServerLogin';
import { DeviceList } from './DeviceList';
import { ServerNotice } from './ServerNotice';
import { noticePresentation } from '../lib/notice';
import { subscribeCommand } from '../lib/commands';
import { createServerAuth } from '../api/fake/serverAuth';

const runtime = vi.hoisted(() => ({ host: null as HookHost | null, invoke: vi.fn() }));
vi.mock('../api/bridge', () => ({ getBridge: () => ({ invoke: runtime.invoke }) }));
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return { ...actual,
    useState: (init: unknown) => runtime.host ? runtime.host.state(init) : actual.useState(init),
    useRef: (init: unknown) => runtime.host ? runtime.host.state({ current: init })[0] : actual.useRef(init),
    useEffect: (fn: () => void | (() => void), deps?: unknown[]) => runtime.host ? runtime.host.effect(fn, deps) : actual.useEffect(fn, deps),
  };
});
type Slot = { value: unknown; deps?: unknown[]; cleanup?: () => void };
class HookHost {
  slots: Slot[] = []; index = 0; effects: (() => void)[] = []; tree: ReactNode = null;
  state(init: unknown): [unknown, (value: unknown) => void] {
    const index = this.index++, slot = this.slots[index] ??= { value: typeof init === 'function' ? init() : init };
    return [slot.value, value => { slot.value = typeof value === 'function' ? value(slot.value) : value; }];
  }
  effect(fn: () => void | (() => void), deps?: unknown[]) {
    const index = this.index++, old = this.slots[index];
    if (!old || !deps || deps.some((dep, i) => !Object.is(dep, old.deps?.[i]))) {
      this.effects.push(() => { old?.cleanup?.(); const cleanup = fn(); this.slots[index] = { value: null, deps, cleanup: typeof cleanup === 'function' ? cleanup : undefined }; });
    }
  }
  async render(component: () => ReactNode) {
    for (let pass = 0; pass < 4; pass++) {
      this.index = 0; runtime.host = this;
      try { this.tree = component(); } finally { runtime.host = null; }
      this.effects.splice(0).forEach(effect => effect());
      for (let i = 0; i < 8; i++) await Promise.resolve();
    }
  }
  html() { return renderToStaticMarkup(this.tree); }
  dispose() { this.slots.forEach(slot => slot.cleanup?.()); }
}
type Props = { children?: ReactNode; onClick?: () => unknown; onSubmit?: (event: { preventDefault: () => void }) => unknown;
  onChange?: (event: { target: { value: string } }) => void; disabled?: boolean; 'aria-label'?: string; id?: string };
function elements(node: ReactNode): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Props>(node)) return [];
  return [node, ...elements(node.props.children)];
}
function text(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(text).join('');
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  return isValidElement<Props>(node) ? text(node.props.children) : '';
}
function button(host: HookHost, label: string) {
  const found = elements(host.tree).find(node => node.type === 'button' && (text(node.props.children).trim() === label || node.props['aria-label'] === label));
  expect(found, label).toBeDefined(); return found!;
}
const auth: AuthState = { ...seed.auth, mode: 'server', setupRequired: false, loggedIn: false, devLoginAllowed: false };
const devices: DeviceSessionView[] = [
  { id: 'current', deviceName: 'PC (Windows)', tailscaleLogin: 'owner@example.com', createdAt: '2026-10-30T01:00:00Z', lastUsedAt: '2026-10-30T02:00:00Z', expiresAt: '2026-11-13T02:00:00Z', current: true },
  { id: 'phone', deviceName: '휴대폰 (Android)', tailscaleLogin: null, createdAt: '2026-10-29T01:00:00Z', lastUsedAt: '2026-10-29T02:00:00Z', expiresAt: '2026-11-12T02:00:00Z', current: false },
];
let host: HookHost;
let start: DeviceLoginStart;
let events: EventTarget;
let confirm: ReturnType<typeof vi.fn>;
let clipboard: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-30T03:00:00Z'));
  host = new HookHost(); events = new EventTarget(); confirm = vi.fn(() => true); clipboard = vi.fn(async () => undefined);
  vi.stubGlobal('window', { confirm, dispatchEvent: events.dispatchEvent.bind(events) });
  vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', clipboard: { writeText: clipboard } });
  start = { loginId: 'login-1', userCode: 'WQKF-RHTM', verificationUrl: 'https://www.google.com/device', expiresAt: new Date(Date.now() + 600000).toISOString(), intervalSec: 2 };
  runtime.invoke.mockReset().mockImplementation(async method => {
    if (method === 'auth.deviceLogin') return { ...start };
    if (method === 'auth.deviceLoginPoll') return { status: 'pending' };
    if (method === 'auth.listDevices') return structuredClone(devices);
    if (method === 'auth.getState') return { ...auth, loggedIn: true };
    throw new Error(`Unexpected call: ${method}`);
  });
});
afterEach(() => { host.dispose(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const renderLogin = () => host.render(() => ServerLogin());
async function begin() { await renderLogin(); await button(host, 'Google 계정으로 로그인').props.onClick?.(); await renderLogin(); }

describe('stage 3 server screens', () => {
  it('S3-login-code. starts with a guessed device name, shows the exact warning and copies the visible code', async () => {
    await begin();
    expect(runtime.invoke).toHaveBeenCalledWith('auth.deviceLogin', 'PC (Windows)');
    expect(host.html()).toContain('class="device-user-code">WQKF-RHTM');
    expect(host.html()).toContain('이 코드는 지금 이 화면에서 시작한 로그인입니다. 다른 사람이 보내 준 코드는 넣지 마세요.');
    expect(host.html()).toContain('href="https://www.google.com/device"'); expect(host.html()).toContain('google.com/device 열기');
    expect(host.html()).toContain('10분 00초');
    await button(host, '코드 복사').props.onClick?.(); await renderLogin();
    expect(clipboard).toHaveBeenCalledWith('WQKF-RHTM'); expect(host.html()).toContain('코드를 복사했습니다');
    expect(browserDeviceName('Android')).toBe('휴대폰 (Android)'); expect(browserDeviceName('iPhone')).toBe('휴대폰 (iPhone)');
    expect(browserDeviceName('iPad')).toBe('태블릿 (iPad)'); expect(browserDeviceName('Macintosh')).toBe('PC (Mac)');
  });
  it('S3-login-poll. waits for the interval, never overlaps polls and refreshes auth before authorizing', async () => {
    const authorized = vi.fn(); events.addEventListener('wook:authorized', authorized);
    let finish: (value: unknown) => void = () => undefined;
    const held = new Promise(done => { finish = done; });
    runtime.invoke.mockImplementation(async method => method === 'auth.deviceLogin' ? start : method === 'auth.deviceLoginPoll' ? held : { ...auth, loggedIn: true });
    await begin(); await vi.advanceTimersByTimeAsync(1999);
    expect(runtime.invoke.mock.calls.filter(([method]) => method === 'auth.deviceLoginPoll')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(10001);
    expect(runtime.invoke.mock.calls.filter(([method]) => method === 'auth.deviceLoginPoll')).toHaveLength(1);
    finish({ status: 'ok' }); await renderLogin();
    expect(runtime.invoke).toHaveBeenCalledWith('auth.deviceLoginPoll', 'login-1');
    expect(runtime.invoke).toHaveBeenCalledWith('auth.getState'); expect(authorized).toHaveBeenCalledTimes(1);
    host.dispose(); await vi.advanceTimersByTimeAsync(20000);
    expect(runtime.invoke.mock.calls.filter(([method]) => method === 'auth.deviceLoginPoll')).toHaveLength(1);
  });
  it('S3-login-interval. keeps a changed interval across missing values until another result replaces it', async () => {
    const poll = vi.fn<() => Promise<DeviceLoginPoll>>().mockResolvedValue({ status: 'pending' })
      .mockResolvedValueOnce({ status: 'pending', intervalSec: 7 })
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({ status: 'pending', intervalSec: 3 });
    runtime.invoke.mockImplementation(async method => method === 'auth.deviceLogin' ? { ...start } : poll());
    await begin();
    for (const [delayMs, count] of [[2000, 1], [7000, 2], [7000, 3], [3000, 4], [3000, 5]]) {
      await vi.advanceTimersByTimeAsync(delayMs - 1);
      expect(poll).toHaveBeenCalledTimes(count - 1);
      await vi.advanceTimersByTimeAsync(1); await renderLogin();
      expect(poll).toHaveBeenCalledTimes(count);
    }
    host.dispose(); await vi.advanceTimersByTimeAsync(20000);
    expect(poll).toHaveBeenCalledTimes(5);
  });
  it.each([undefined, -1, 0, 0.5, 60.1, 61, Infinity, NaN])('S3-login-interval-range. ignores %s and keeps the raised interval', async intervalSec => {
    const poll = vi.fn<() => Promise<DeviceLoginPoll>>().mockResolvedValue({ status: 'pending' })
      .mockResolvedValueOnce({ status: 'pending', intervalSec: 7 })
      .mockResolvedValueOnce({ status: 'pending', intervalSec });
    runtime.invoke.mockImplementation(async method => method === 'auth.deviceLogin' ? { ...start } : poll());
    await begin(); await vi.advanceTimersByTimeAsync(9000);
    expect(poll).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(6999);
    expect(poll).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(poll).toHaveBeenCalledTimes(3);
  });
  it.each([1, 2.5, 60])('S3-login-interval-valid. accepts %s seconds including both bounds', async intervalSec => {
    const poll = vi.fn<() => Promise<DeviceLoginPoll>>().mockResolvedValue({ status: 'pending' })
      .mockResolvedValueOnce({ status: 'pending', intervalSec });
    runtime.invoke.mockImplementation(async method => method === 'auth.deviceLogin' ? { ...start } : poll());
    await begin(); await vi.advanceTimersByTimeAsync(2000);
    expect(poll).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(intervalSec * 1000 - 1);
    expect(poll).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(poll).toHaveBeenCalledTimes(2);
  });
  it('S3-login-interval-pending. waits for a slow response before starting the new interval without overlapping', async () => {
    let finish: (result: DeviceLoginPoll) => void = () => undefined;
    const held = new Promise<DeviceLoginPoll>(resolve => { finish = resolve; });
    const poll = vi.fn<() => Promise<DeviceLoginPoll>>().mockResolvedValue({ status: 'pending' }).mockReturnValueOnce(held);
    runtime.invoke.mockImplementation(async method => method === 'auth.deviceLogin' ? { ...start } : poll());
    await begin(); await vi.advanceTimersByTimeAsync(22000);
    expect(poll).toHaveBeenCalledTimes(1);
    finish({ status: 'pending', intervalSec: 7 }); await renderLogin();
    await vi.advanceTimersByTimeAsync(6999);
    expect(poll).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(poll).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(6999);
    expect(poll).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(poll).toHaveBeenCalledTimes(3);
  });
  it.each(['denied', 'expired', 'error'])('S3-login-terminal. %s shows the server message, stops polling and allows a fresh login', async status => {
    runtime.invoke.mockImplementation(async method => method === 'auth.deviceLogin' ? { ...start } : { status, message: `서버 안내: ${status}` });
    await begin(); await vi.advanceTimersByTimeAsync(2000); await renderLogin();
    expect(host.html()).toContain(`서버 안내: ${status}`); expect(host.html()).not.toContain('device-user-code');
    await vi.advanceTimersByTimeAsync(10000); expect(runtime.invoke.mock.calls.filter(([method]) => method === 'auth.deviceLoginPoll')).toHaveLength(1);
    await button(host, '다시 시작').props.onClick?.(); await renderLogin();
    expect(runtime.invoke.mock.calls.filter(([method]) => method === 'auth.deviceLogin')).toHaveLength(2);
    expect(host.html()).toContain('WQKF-RHTM');
  });
  it('S3-login-expiry. expires locally without polling past the deadline and cleans up on unmount', async () => {
    start.expiresAt = new Date(Date.now() + 1000).toISOString(); start.intervalSec = 5;
    await begin(); await vi.advanceTimersByTimeAsync(1000); await renderLogin();
    expect(host.html()).toContain('로그인 코드가 만료되었습니다. 다시 시작해 주세요.');
    await vi.advanceTimersByTimeAsync(10000); expect(runtime.invoke.mock.calls.filter(([method]) => method === 'auth.deviceLoginPoll')).toHaveLength(0);
  });
  it('S3-setup. submits only code and email, displays errors and hands the resulting auth back to the gate', async () => {
    const saved = vi.fn(); const render = () => host.render(() => OwnerSetup({ onSetup: saved }));
    await render(); expect(host.html()).toContain('서버 설정이 끝나지 않았습니다');
    expect(host.html()).toContain('서버를 처음 켤 때 서버 PC의 콘솔과 setup-code.txt에 나온 코드입니다');
    expect(host.html()).not.toMatch(/클라이언트|보안 비밀|google.com\/device|개발 모드/);
    expect(button(host, '대표 이메일 등록').props.disabled).toBe(true);
    for (const [id, value] of [['owner-setup-code', 'bcdx2345'], ['owner-setup-email', 'owner@example.com']]) {
      elements(host.tree).find(node => node.props.id === id)?.props.onChange?.({ target: { value } });
    }
    runtime.invoke.mockRejectedValueOnce(new Error('설정 코드가 맞지 않습니다.'));
    await render(); elements(host.tree).find(node => node.type === 'form')?.props.onSubmit?.({ preventDefault: vi.fn() }); await render();
    expect(host.html()).toContain('설정 코드가 맞지 않습니다.'); expect(saved).not.toHaveBeenCalled();
    runtime.invoke.mockResolvedValueOnce({ ...auth, setupRequired: false });
    elements(host.tree).find(node => node.type === 'form')?.props.onSubmit?.({ preventDefault: vi.fn() }); await render();
    expect(runtime.invoke).toHaveBeenLastCalledWith('auth.setupOwner', 'BCDX2345', 'owner@example.com');
    expect(saved).toHaveBeenCalledWith({ ...auth, setupRequired: false });
  });
  it('S3-devices. shows identity and times, confirms before revoking and applies the returned list', async () => {
    const render = () => host.render(() => DeviceList({ auth: { ...auth, loggedIn: true }, version: 1 }));
    await render(); expect(runtime.invoke).toHaveBeenCalledWith('auth.listDevices');
    expect(host.html()).toContain('이 기기'); expect(host.html()).toContain('owner@example.com'); expect(host.html()).toContain('사용자 정보 없음');
    expect(host.html()).toContain('마지막 사용'); expect(host.html()).toContain('만료'); expect(host.html()).toContain('11. 13.');
    confirm.mockReturnValueOnce(false); await button(host, '휴대폰 (Android) 끊기').props.onClick?.();
    expect(runtime.invoke.mock.calls.filter(([method]) => method === 'auth.revokeDevice')).toHaveLength(0);
    runtime.invoke.mockResolvedValueOnce([devices[0]]);
    await button(host, '휴대폰 (Android) 끊기').props.onClick?.(); await render();
    expect(runtime.invoke).toHaveBeenLastCalledWith('auth.revokeDevice', 'phone'); expect(host.html()).not.toContain('휴대폰 (Android)');
    expect(host.html()).toContain('PC (Windows)');
  });
  it('S3-current-device. revoking this device logs the screen out', async () => {
    const loggedOut = vi.fn(); events.addEventListener('wook:unauthorized', loggedOut);
    await host.render(() => DeviceList({ auth, version: 1 }));
    runtime.invoke.mockResolvedValueOnce([devices[1]]);
    await button(host, 'PC (Windows) 끊기').props.onClick?.();
    await host.render(() => DeviceList({ auth, version: 1 }));
    expect(confirm).toHaveBeenCalledWith('이 기기의 연결을 끊을까요? 이 화면에서 로그아웃됩니다.');
    expect(runtime.invoke).toHaveBeenLastCalledWith('auth.revokeDevice', 'current'); expect(loggedOut).toHaveBeenCalledTimes(1);
  });
  it.each([undefined, 'desktop'] as const)('S3-desktop. mode %s still lists devices but renders only the desktop explanation', async mode => {
    await host.render(() => DeviceList({ auth: { ...auth, mode }, version: 1 }));
    expect(runtime.invoke).toHaveBeenCalledWith('auth.listDevices');
    expect(host.html()).toContain('이 PC에서 쓰는 데스크톱 앱입니다 — 기기별 로그인은 서버 접속에서 씁니다');
    expect(host.html()).not.toContain('PC (Windows)'); expect(host.html()).not.toContain('끊기');
  });
  it('S3-server-settings. a server fake without window.wook cannot submit installation settings', async () => {
    runtime.invoke.mockImplementation(async method => {
      if (method === 'settings.get') return structuredClone(settingsSeed);
      if (method === 'roles.list' || method === 'skills.list' || method === 'recovery.list') return [];
      return null;
    });
    await host.render(() => SettingsScreen({ snapshot: { ...seed, auth: { ...auth, loggedIn: true } }, section: 'account', setSection: vi.fn(), logout: vi.fn(), openTask: vi.fn() }));
    expect(host.html()).toContain('계정과 기기'); expect(host.html()).not.toContain('Google 클라이언트 ID');
    expect(host.html()).not.toContain('설치 설정 저장'); expect(host.html()).not.toContain('모의 실행 끄기');
    const fieldsets = elements(host.tree).filter(node => node.type === 'fieldset');
    expect(fieldsets.length).toBe(0);
  });
  it('S3-device-notice. a prefixed notice navigates to devices and never opens a main command', () => {
    const item: NotificationView = { id: 'new-login', key: 'device-login:new-id', title: '서버 제목', body: '새 PC / 대표@example.com / 10월 30일', level: 'normal', read: false, createdAt: start.expiresAt,
      link: { tab: 'projects', taskId: seed.tasks[0].id } };
    const view = noticePresentation(item, seed); expect(view.link).toEqual({ tab: 'settings', section: 'account' }); expect(view.command).toBeNull();
    const navigate = vi.fn(), markRead = vi.fn(), close = vi.fn(), draft = vi.fn(); const off = subscribeCommand(draft);
    try {
      host.tree = ServerNotice({ item, snapshot: seed, navigate, markRead, close });
      expect(host.html()).toContain(item.body); expect(host.html()).not.toContain('메인 에이전트에게 말하기');
      button(host, '로그인한 기기 보기').props.onClick?.();
      expect(navigate).toHaveBeenCalledWith({ tab: 'settings', section: 'account' }); expect(markRead).toHaveBeenCalled(); expect(close).toHaveBeenCalled(); expect(draft).not.toHaveBeenCalled();
      const showDevices = vi.fn(); navigate.mockClear();
      host.tree = ServerNotice({ item, snapshot: seed, navigate, markRead, close, showDevices });
      button(host, '로그인한 기기 보기').props.onClick?.();
      expect(showDevices).toHaveBeenCalledTimes(1); expect(navigate).not.toHaveBeenCalled(); expect(draft).not.toHaveBeenCalled();
    } finally { off(); }
  });
  it('S3-fake. server setup is one-use, device login advances with time and revocation logs out only this device', () => {
    const snapshot = { auth: { ...auth } }, changed = vi.fn(), notify = vi.fn();
    const fake = createServerAuth({ snapshot, query: new URLSearchParams('fakeMode=server&fakeSetup=1'), changed, notify });
    expect(snapshot.auth.setupRequired).toBe(true); expect(() => fake.start()).toThrow('서버 설정이 끝나지 않았습니다');
    expect(() => fake.setup('BADCODE1', 'owner@example.com')).toThrow('설정 코드가 맞지 않습니다');
    fake.setup('BCDX2345', 'Owner@Example.com'); expect(() => fake.setup('BCDX2345', 'other@example.com')).toThrow('이미 등록');
    const login = fake.start('휴대폰 (iPhone)'); expect(fake.poll(login.loginId).status).toBe('pending');
    vi.advanceTimersByTime(12000); expect(fake.poll(login.loginId).status).toBe('ok');
    expect(fake.list().find(device => device.current)?.deviceName).toBe('휴대폰 (iPhone)');
    expect(notify.mock.calls[0][0].key).toMatch(/^device-login:/);
    const current = fake.list().find(device => device.current)!;
    expect(fake.revoke(current.id).every(device => !device.current)).toBe(true); expect(snapshot.auth.loggedIn).toBe(false);
    expect(() => fake.list()).toThrow('로그인이 필요');
  });
  it.each(['denied', 'expired', 'error'])('S3-fake-terminal. %s advances from pending to a stable terminal state', scenario => {
    const snapshot = { auth: { ...auth } };
    const fake = createServerAuth({ snapshot, query: new URLSearchParams(`fakeMode=server&fakeLogin=${scenario}`), changed: vi.fn(), notify: vi.fn() });
    const login = fake.start('PC (Windows)'); expect(fake.poll(login.loginId).status).toBe('pending');
    vi.advanceTimersByTime(6000); expect(fake.poll(login.loginId).status).toBe(scenario);
    expect(fake.poll(login.loginId).status).toBe(scenario); expect(snapshot.auth.loggedIn).toBe(false);
  });
  it('S3-fake-slow. raises the second poll interval once per login and the screen keeps it through success', async () => {
    const snapshot = { auth: { ...auth } };
    const fake = createServerAuth({ snapshot, query: new URLSearchParams('fakeMode=server&fakeLogin=slow'), changed: vi.fn(), notify: vi.fn() });
    const poll = vi.fn((loginId: string) => fake.poll(loginId));
    runtime.invoke.mockImplementation(async (method, loginId) => {
      if (method === 'auth.deviceLogin') return fake.start('PC (Windows)');
      if (method === 'auth.deviceLoginPoll') return poll(loginId);
      if (method === 'auth.getState') return snapshot.auth;
      throw new Error(`Unexpected call: ${method}`);
    });
    const authorized = vi.fn(); events.addEventListener('wook:authorized', authorized);
    await begin(); await vi.advanceTimersByTimeAsync(2000);
    expect(poll.mock.results[0].value).toEqual({ status: 'pending' });
    await vi.advanceTimersByTimeAsync(2000);
    expect(poll.mock.results[1].value).toEqual({ status: 'pending', intervalSec: 7 });
    await vi.advanceTimersByTimeAsync(6999);
    expect(poll).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(poll.mock.results[2].value).toEqual({ status: 'pending' });
    await vi.advanceTimersByTimeAsync(6999);
    expect(poll).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(poll.mock.results[3].value.status).toBe('ok');
    expect(authorized).toHaveBeenCalledTimes(1);
    const next = fake.start();
    expect(fake.poll(next.loginId)).toEqual({ status: 'pending' });
    expect(fake.poll(next.loginId)).toEqual({ status: 'pending', intervalSec: 7 });
    expect(fake.poll(next.loginId)).toEqual({ status: 'pending' });
  });
});
