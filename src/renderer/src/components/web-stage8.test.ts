import { isValidElement, type ReactNode, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
// @ts-expect-error Node is available in Vitest; the renderer type environment omits it.
import { readFileSync, readdirSync } from 'node:fs';
// @ts-expect-error Node is available in Vitest; the renderer type environment omits it.
import { resolve } from 'node:path';
// @ts-expect-error Node is available in Vitest; the renderer type environment omits it.
import { runInNewContext } from 'node:vm';
// @ts-expect-error Build-time checker runs in Node; no renderer declaration is needed.
import { brokenText } from '../../tools/check-stage8-text.mjs';
import type { WookBridge, WebUploadOptions, WebUploadedFile, WookTopics } from '../../../shared/ipc';
import type { CliEvent } from '../../../shared/events';
import { snapshot as seed, settings, roles, skills, notifications } from '../api/fake/data';
import { createFakeWeb } from '../api/fake/web';
import { createFakeSeat } from '../api/fake/seat';
import { UploadQueue, webCommandAttachments, type UploadChip } from '../lib/uploads';
import { readCliTail, mergeCliEvents } from '../lib/memberEvents';
import { showBrowserNotification, showMissedNotifications, listenNotificationNavigation, notificationTarget, notificationsUnavailable } from '../lib/browserNotifications';
import { CommandBar } from './CommandBar';
import { FileDownload } from './FileDownload';
import { ConnectionStatus } from './ConnectionStatus';
import { NotificationOffer } from './NotificationOffer';
import { SettingsScreen } from '../screens/Settings';
import { ServerLogin } from './ServerLogin';
import { MemberPanel } from './MemberPanel';
import { openCommand } from '../lib/commands';
import { App } from '../App';
import { SeatScreen } from '../screens/Seat';
import { subscribeCommand } from '../lib/commands';
import { openConversation, subscribeConversation } from '../lib/commands';
import { DirectiveDetail } from './TaskDetail';
import { Documents } from '../screens/Documents';
import { reports, conversations } from '../api/fake/data';
import { useToasts } from '../api/store';
const context = vi.hoisted(() => ({ host: null as HookHost | null, bridge: null as WookBridge | null }));
vi.mock('../api/bridge', () => ({ getBridge: () => context.bridge }));
// This Node hook harness has no DOM. Browser captures exercise the real Markdown renderer.
vi.mock('../lib/ui', async () => ({ ...await vi.importActual<typeof import('../lib/ui')>('../lib/ui'), Markdown: ({ source }: { source: string }) => source }));
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return { ...actual,
    useState: (init: unknown) => context.host ? context.host.state(init) : actual.useState(init),
    useRef: (init: unknown) => context.host ? context.host.state({ current: init })[0] : actual.useRef(init),
    useEffect: (fn: () => void | (() => void), deps?: unknown[]) => context.host ? context.host.effect(fn, deps) : actual.useEffect(fn, deps),
    useCallback: <T extends (...args: never[]) => unknown>(fn: T, deps: unknown[]) => context.host ? fn : actual.useCallback(fn, deps),
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
      this.index = 0; context.host = this;
      try { this.tree = component(); } finally { context.host = null; }
      this.effects.splice(0).forEach(effect => effect());
      for (let i = 0; i < 8; i++) await Promise.resolve();
    }
  }
  html() { return renderToStaticMarkup(this.tree); }
  dispose() { this.slots.forEach(slot => slot.cleanup?.()); }
}
type Props = { children?: ReactNode; onClick?: () => unknown; onSubmit?: (event: { preventDefault: () => void }) => unknown;
  onChange?: (event: { target: { value: string } }) => void; disabled?: boolean; 'aria-label'?: string; id?: string; visible?: boolean };
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

let host: HookHost;
let web: ReturnType<typeof createFakeWeb>;
let invoke: ReturnType<typeof vi.fn<(method: string, ...args: unknown[]) => Promise<unknown>>>;
let snap: typeof seed;
const noop = () => undefined;
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
beforeEach(() => {
  vi.useFakeTimers(); host = new HookHost(); snap = structuredClone(seed); snap.auth.mode = 'server'; snap.auth.loggedIn = true;
  snap.seat = createFakeSeat(new URLSearchParams()).seat;
  const events = new EventTarget();
  const storage = new Map<string, string>();
  vi.stubGlobal('window', { location: { search: '', hash: '', origin: 'https://wook.test', href: 'https://wook.test/' },
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value); } },
    addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
    dispatchEvent: vi.fn(events.dispatchEvent.bind(events)), focus: vi.fn(), setTimeout, clearTimeout });
  vi.stubGlobal('navigator', { userAgent: 'Windows' });
  vi.stubGlobal('document', { visibilityState: 'visible', hidden: false, addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) });
  web = createFakeWeb();
  invoke = vi.fn(async (method: string) => {
    if (method === 'settings.get') return structuredClone(settings);
    if (method === 'roles.list') return roles;
    if (['skills.list', 'recovery.list', 'command.history', 'auth.listDevices', 'agents.list'].includes(method)) return [];
    if (method === 'system.info' || method === 'system.prereqs') return null;
    if (method === 'auth.getState') return snap.auth;
    return undefined;
  });
  context.bridge = { platform: 'web', web, invoke: invoke as WookBridge['invoke'], subscribe: () => noop };
});
afterEach(() => { host.dispose(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const composer = () => CommandBar({ snapshot: snap, currentProjectId: null });
const event = (seq: number, turnId = 'turn'): CliEvent => ({ seq, turnId, ts: '2026-11-05T00:00:00Z', kind: 'text', text: String(seq) });

it('S8-upload-wire: file and pasted image use uploadId and never a desktop path', async () => {
  await host.render(composer);
  const input = elements(host.tree).find(node => node.type === 'input' && node.props['aria-label'] === '첨부할 파일 선택');
  expect(input).toBeDefined();
  const file = new File(['hello'], 'brief.txt');
  const props = input!.props as unknown as { onChange: (event: { target: { files: File[]; value: string } }) => void };
  props.onChange({ target: { files: [file], value: '' } });
  await vi.advanceTimersByTimeAsync(900); await host.render(composer);
  openCommand(null, '첨부를 검토해 줘'); await host.render(composer);
  await button(host, '보내기').props.onClick?.();
  expect(invoke).toHaveBeenCalledWith('command.send', { target: 'main', text: '첨부를 검토해 줘', attachments: [{ name: 'brief.txt', uploadId: 'U-fake-1' }] });
  expect(invoke).not.toHaveBeenCalledWith('system.pickFiles');
  await flush(); await host.render(composer);
  const textarea = elements(host.tree).find(node => node.type === 'textarea');
  const image = new File(['pixels'], 'image.png', { type: 'image/png' });
  const preventDefault = vi.fn();
  (textarea!.props as unknown as { onPaste: (event: unknown) => void }).onPaste({ clipboardData: { items: [{ type: 'image/png', getAsFile: () => image }] }, preventDefault });
  expect(preventDefault).toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(900); await host.render(composer);
  openCommand(null, '붙여넣은 이미지를 검토해 줘'); await host.render(composer);
  await button(host, '보내기').props.onClick?.();
  expect(invoke).toHaveBeenLastCalledWith('command.send', { target: 'main', text: '붙여넣은 이미지를 검토해 줘', attachments: [{ name: 'image.png', uploadId: 'U-fake-2' }] });
  const chips: UploadChip[] = [{ id: 1, name: 'image.png', file, state: { kind: 'ready', uploadId: 'U-2' } }];
  expect(webCommandAttachments(chips)).toEqual([{ name: 'image.png', uploadId: 'U-2' }]);
});
it('S8-upload-error: a rejected upload is visible and blocks sending until retry or remove', async () => {
  web.upload = vi.fn().mockRejectedValueOnce(new Error('업로드 실패 예제')).mockResolvedValue({ uploadId: 'retry-success', name: 'fail.txt', size: 1, expiresAt: '' });
  await host.render(composer);
  const input = elements(host.tree).find(node => node.type === 'input');
  (input!.props as unknown as { onChange: (event: unknown) => void }).onChange({ target: { files: [new File(['x'], 'fail.txt')], value: '' } });
  await flush(); await host.render(composer);
  expect(host.html()).toContain('role="alert">업로드 실패 예제');
  expect(host.html()).toContain('fail.txt 다시 올리기'); expect(button(host, '보내기').props.disabled).toBe(true);
  await button(host, 'fail.txt 다시 올리기').props.onClick?.(); await flush(); await host.render(composer);
  expect(web.upload).toHaveBeenCalledTimes(2); expect(host.html()).toContain('첨부 준비됨');
  expect(host.html()).not.toContain('업로드 실패 예제'); expect(button(host, '보내기').props.disabled).toBe(false);
});
it('S8-upload-limits: queues the fourth file, rejects over 50 MB, aborts and frees a removed slot', async () => {
  let chips: UploadChip[] = []; const finishes: (() => void)[] = [];
  web.upload = vi.fn((_file: Blob, name: string, options?: WebUploadOptions) => new Promise<WebUploadedFile>((resolve, reject) => {
    finishes.push(() => resolve({ uploadId: name, name, size: 1, expiresAt: '' }));
    options?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
  }));
  const queue = new UploadQueue(web, next => { chips = next; });
  queue.add([1, 2, 3, 4].map(i => ({ file: new Blob(['x']), name: String(i) })));
  expect(web.upload).toHaveBeenCalledTimes(3); expect(chips[3].state.kind).toBe('queued');
  queue.remove(chips[0].id); await flush(); expect(web.upload).toHaveBeenCalledTimes(4);
  queue.add([{ file: new Blob([new Uint8Array(50 * 1024 * 1024 + 1)]), name: 'large' }]);
  expect(chips.at(-1)?.state).toMatchObject({ kind: 'error', message: expect.stringContaining('50 MB') });
  queue.dispose();
});
it('S8-download: web renders actual report, attachment and export links and never calls openPath', () => {
  for (const [target, expected] of [
    [{ kind: 'attachment', id: 'A-1' }, '/api/attachments/A-1'],
    [{ kind: 'reportFile', reportId: 'R-1' }, '/api/reports/R-1/file'],
    [{ kind: 'export', path: 'C:\\logs\\export.json' }, '/api/exports/export.json'],
  ] as const) {
    const html = renderToStaticMarkup(FileDownload({ target, path: 'C:/secret', children: '내려받기' }));
    expect(html).toContain(`href="${expected}"`); expect(html).not.toContain('C:/secret');
  }
  expect(invoke).not.toHaveBeenCalled();
});
it('S8-hidden: server-unusable installation fields, AI form and data-folder open are absent', async () => {
  const render = () => SettingsScreen({ snapshot: snap, section: 'account', setSection: noop, logout: noop, openTask: noop });
  await host.render(render);
  expect(host.html()).not.toMatch(/Google 클라이언트|API 키 저장|CLI 경로|설치 설정 저장|메인 에이전트 AI/);
  await host.render(() => SettingsScreen({ snapshot: snap, section: 'general', setSection: noop, logout: noop, openTask: noop }));
  expect(host.html()).not.toMatch(/>열기<|>열기\s*</);
});
it('S8-connection: reconnect elapsed and next retry remain visible, then a restored moment', async () => {
  web.setConnection({ status: 'reconnecting', lostAt: Date.now() - 8000, attempt: 2, retryAt: Date.now() + 3000 });
  await host.render(ConnectionStatus); expect(host.html()).toContain('서버 연결 상태'); expect(host.html()).toContain('연결 끊김 8초 · 3초 뒤 재시도');
  web.setConnection({ status: 'open', since: Date.now(), runId: 'restored' });
  await host.render(ConnectionStatus); expect(host.html()).toContain('다시 연결됐습니다');
  await vi.advanceTimersByTimeAsync(5100); await host.render(ConnectionStatus); expect(host.html()).toContain('서버 연결됨');
  expect(readFileSync(resolve('src/renderer/src/App.tsx'), 'utf8')).toContain('<ConnectionStatus />');
});
it('S8-resync: drains forward to newest, merges duplicate replay and reveals only older records', async () => {
  const read = vi.fn(async (cursor?: string) => cursor ? { events: [event(3), event(4)], nextCursor: null, turnId: 'turn' } : { events: [event(1), event(2)], nextCursor: '2', turnId: 'turn' });
  const initial = await readCliTail(read);
  const merged = mergeCliEvents(initial, [event(4), event(5)]);
  expect(merged.map(e => e.seq)).toEqual([1, 2, 3, 4, 5]);
  expect(merged.slice(-2).map(e => e.seq)).toEqual([4, 5]);
  expect(merged.slice(-4).map(e => e.seq)).toEqual([2, 3, 4, 5]);
  expect(mergeCliEvents(merged, [event(1, 'turn2')])).toHaveLength(6);
});
it('S8-notification: only hidden pages with granted permission notify once; click focuses and navigates', async () => {
  const created: { title: string; options: NotificationOptions; onclick?: () => void; close: () => void }[] = [];
  class BrowserNotification {
    static permission = 'default'; onclick?: () => void; close = vi.fn();
    constructor(public title: string, public options: NotificationOptions) { created.push(this); }
  }
  vi.stubGlobal('Notification', BrowserNotification);
  const navigate = vi.fn(), item = { ...notifications[0], id: 'web-hidden-once', link: { tab: 'documents' } as const };
  await showBrowserNotification(item, navigate); expect(created).toHaveLength(0);
  BrowserNotification.permission = 'granted'; await showBrowserNotification(item, navigate); expect(created).toHaveLength(0);
  vi.stubGlobal('document', { visibilityState: 'hidden' }); BrowserNotification.permission = 'default'; await showBrowserNotification(item, navigate); expect(created).toHaveLength(0);
  BrowserNotification.permission = 'granted'; await Promise.all([showBrowserNotification(item, navigate), showBrowserNotification(item, navigate)]); expect(created).toHaveLength(1);
  expect(created[0].title).toBe('욱채 알림'); expect(created[0].options.body).toBe('작업실에 확인할 새 알림이 있습니다.');
  expect(created[0].title + created[0].options.body).not.toContain(item.title);
  expect(created[0].title + created[0].options.body).not.toContain(item.body);
  created[0].onclick?.(); expect(window.focus).toHaveBeenCalled(); expect(navigate).toHaveBeenCalledWith(item.link);
});
it('S8-notification-offer: permission is requested only by the explicit button', async () => {
  const requestPermission = vi.fn(async () => 'granted'); vi.stubGlobal('Notification', { permission: 'default', requestPermission });
  await host.render(NotificationOffer); expect(requestPermission).not.toHaveBeenCalled();
  await button(host, '브라우저 알림 켜기').props.onClick?.(); await flush(); await host.render(NotificationOffer);
  expect(requestPermission).toHaveBeenCalledOnce(); expect(host.html()).toBe('');
});
it('S8-login409: re-reads auth and replaces login with setup', async () => {
  const toastHost = new HookHost(); let toasts: ReturnType<typeof useToasts> | undefined;
  await toastHost.render(() => { toasts = useToasts(); return null; });
  snap.auth.setupRequired = true;
  invoke.mockImplementation(async method => { if (method === 'auth.deviceLogin') throw Object.assign(new Error('서버 설정이 끝나지 않았습니다'), { code: 'conflict' }); if (method === 'auth.getState') return snap.auth; });
  await host.render(ServerLogin); await button(host, 'Google 계정으로 로그인').props.onClick?.(); await host.render(ServerLogin);
  expect(invoke).toHaveBeenCalledWith('auth.getState'); expect(host.html()).toContain('서버 설정이 끝나지 않았습니다'); expect(host.html()).toContain('설정 코드');
  await toastHost.render(() => { toasts = useToasts(); return null; });
  expect(toasts?.items).toEqual([]); toastHost.dispose();
});
it('S8-flags-and-imports: raw dev reads and api/fake imports cannot re-enter production screens', () => {
  const root = resolve('src/renderer/src');
  const files = readdirSync(root, { recursive: true }).filter((name: unknown): name is string => typeof name === 'string' && /\.tsx?$/.test(name) && !name.endsWith('.test.ts'));
  for (const name of files) {
    if (name.replaceAll('\\', '/') === 'api/env.ts' || /api[\\/](remote|install)/.test(name)) continue;
    const source = readFileSync(resolve(root, name), 'utf8');
    const reads = source.match(/(?:new URLSearchParams\((?!\))[^;]+|location\.search)/g) ?? [];
    if (name.replaceAll('\\', '/') === 'screens/Studio.tsx') expect(reads.join(' ')).not.toMatch(/officeDemo|capture|fake|perfWalk/);
    else expect(reads, name).toEqual([]);
  }
  for (const name of ['Studio3D.tsx', 'behaviour.ts']) expect(readFileSync(resolve(root, 'studio3d', name), 'utf8')).not.toMatch(/from ['"][^'"]*api\/fake\//);
});

it('S8-member-panel: watches the open member, backfills after resync, dedupes live overlap and pages older locally', async () => {
  const member = { ...snap.members[0], currentWork: null };
  snap.members[0] = member;
  let push: ((value: WookTopics['cliEvents']) => void) | undefined;
  context.bridge!.subscribe = (topic, cb) => { if (topic === 'cliEvents') push = cb as (value: WookTopics['cliEvents']) => void; return noop; };
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (method, ...args) => {
    if (method === 'members.getDetail') return { member, role: roles[0], sessions: [], recentTurns: [{ id: 'turn', startedAt: event(1).ts, endedAt: event(1).ts, running: false }], currentTask: null, queuedTasks: [], history: [], messages: [] };
    if (method === 'members.getEvents') {
      const options = args[1];
      const cursor = options && typeof options === 'object' && 'cursor' in options ? options.cursor : undefined;
      return cursor === '40' ? { events: Array.from({ length: 40 }, (_, i) => event(i + 41)), nextCursor: null, turnId: 'turn' }
        : cursor === '81' ? { events: [event(81), event(82)], nextCursor: '82', turnId: 'turn' }
        : cursor === '82' ? { events: [event(83)], nextCursor: null, turnId: 'turn' }
        : cursor === '80' ? { events: [], nextCursor: null, turnId: 'turn' }
        : { events: Array.from({ length: 40 }, (_, i) => event(i + 1)), nextCursor: '40', turnId: 'turn' };
    }
    return original(method, ...args);
  });
  const render = () => MemberPanel({ id: member.id, snapshot: snap, close: noop, openTask: noop });
  await host.render(render); await flush(); await host.render(render);
  expect(web.watched.has(member.id)).toBe(true);
  expect(host.html()).toContain('<p>80</p>'); expect(host.html()).not.toContain('<p>1</p>');
  const reads = invoke.mock.calls.filter(([method]) => method === 'members.getEvents').length;
  await button(host, '이전 기록 더 보기').props.onClick?.(); await host.render(render);
  expect(host.html()).toContain('<p>1</p>'); expect(invoke.mock.calls.filter(([method]) => method === 'members.getEvents')).toHaveLength(reads);
  push?.({ memberId: member.id, turnId: 'turn', events: [event(80), event(81), event(81)] }); await host.render(render);
  expect(host.html().match(/<p>80<\/p>/g)).toHaveLength(1);
  expect(host.html().match(/<p>81<\/p>/g)).toHaveLength(1);
  web.resync(); await flush(); await host.render(render);
  expect(invoke).toHaveBeenCalledWith('members.getEvents', member.id, { turnId: 'turn', cursor: '81', limit: 200 });
  const html = host.html(); expect(html.match(/<p>81<\/p>/g)).toHaveLength(1); expect(html).toContain('<p>83</p>');
  expect(html.indexOf('<p>80</p>')).toBeLessThan(html.indexOf('<p>81</p>'));
  host.dispose(); expect(web.watched.size).toBe(0);
});

it('S8-fake-web: flags give reconnect and one upload failure, retry reports progress and succeeds', async () => {
  window.location.search = '?fakeConn=reconnecting&fakeUpload=fail';
  const fake = createFakeWeb(), connections = vi.fn(), progress = vi.fn();
  const off = fake.onConnection(connections); expect(connections).toHaveBeenCalledWith(expect.objectContaining({ status: 'reconnecting' }));
  const watching = fake.watchMembers(['M-1', 'M-1', 'M-2']);
  expect(watching).toBeInstanceOf(Promise); let ready = false; void watching.then(() => { ready = true; });
  expect(ready).toBe(false); await watching; expect(ready).toBe(true);
  expect([...fake.watched]).toEqual(['M-1', 'M-2']);
  fake.watchMembers([]); expect(fake.watched.size).toBe(0);
  const failure = expect(fake.upload(new Blob(['test']), 'retry.txt', { onProgress: progress })).rejects.toMatchObject({ code: 'network' });
  await vi.advanceTimersByTimeAsync(900); await failure;
  const retry = fake.upload(new Blob(['test']), 'retry.txt', { onProgress: progress }); await vi.advanceTimersByTimeAsync(900);
  expect(await retry).toMatchObject({ uploadId: 'U-fake-1', name: 'retry.txt' }); expect(progress).toHaveBeenCalledWith(4, 4); off();
});

it('S8-app-resync: the web shell refreshes notifications, includes connection status and hides simulation', async () => {
  const events = new EventTarget();
  Object.assign(window, { addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) });
  const original = invoke.getMockImplementation()!;
  const item = { ...notifications[0], id: 'app-gap', read: false, createdAt: new Date(Date.now() + 1).toISOString() };
  let items: typeof notifications = [];
  invoke.mockImplementation(async (method, ...args) => method === 'snapshot.get' ? snap : method === 'notifications.list' ? items : original(method, ...args));
  const showNotification = vi.fn(async () => undefined);
  const messages = new EventTarget();
  vi.stubGlobal('navigator', { serviceWorker: { register: vi.fn(async () => ({ active: {}, showNotification })),
    addEventListener: messages.addEventListener.bind(messages), removeEventListener: messages.removeEventListener.bind(messages) } });
  vi.stubGlobal('Notification', { permission: 'granted' }); Object.assign(document, { visibilityState: 'hidden' });
  await host.render(App);
  expect(host.html()).toContain('aria-label="서버 연결 상태"');
  expect(host.html()).not.toContain('시뮬레이션');
  const reads = invoke.mock.calls.filter(([method]) => method === 'notifications.list').length;
  items = [item];
  web.setConnection({ status: 'reconnecting', lostAt: Date.now(), attempt: 1, retryAt: null });
  web.setConnection({ status: 'open', runId: 'new', since: Date.now() });
  web.resync(); await flush();
  expect(invoke.mock.calls.filter(([method]) => method === 'notifications.list')).toHaveLength(reads + 1);
  expect(showNotification).toHaveBeenCalledTimes(1);
  web.resync(); await flush(); expect(showNotification).toHaveBeenCalledTimes(1);
});

it('S8-seat: shows unresponsive details, fills a draft, and avoids re-reading history for ordinary snapshots', async () => {
  snap.seat.unresponsiveSince = '2026-11-05T00:00:00Z'; snap.seat.unresponsiveReason = '응답을 기다리고 있습니다.';
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (method, ...args) => method === 'seat.get' ? structuredClone(snap.seat) : method === 'seat.history' ? [] : original(method, ...args));
  const render = () => SeatScreen({ snapshot: snap, navigate: noop });
  await host.render(render);
  expect(host.html()).toContain('응답 없음'); expect(host.html()).toContain('응답을 기다리고 있습니다.');
  snap = structuredClone(snap); snap.version++;
  if (snap.seat.holder?.kind === 'launched') snap.seat.holder.ai.model = 'updated-model';
  await host.render(render); expect(host.html()).toContain('updated-model');
  expect(invoke.mock.calls.filter(([method]) => method === 'seat.history')).toHaveLength(1);
  const draft = vi.fn(), off = subscribeCommand(draft);
  await button(host, '메인 에이전트에게 말하기').props.onClick?.();
  expect(draft).toHaveBeenCalledWith({ target: 'main', text: '메인 에이전트의 현재 상태에 대해: ' }); off();
});

it('S8-panel-watch-gap: fills the gap despite a live suffix before readiness and repeats on a turn switch', async () => {
  const member = { ...snap.members[0], currentWork: null };
  snap.members[0] = member;
  let ready: (() => void) | undefined;
  let push: ((value: WookTopics['cliEvents']) => void) | undefined;
  context.bridge!.subscribe = (topic, cb) => { if (topic === 'cliEvents') push = cb as (value: WookTopics['cliEvents']) => void; return noop; };
  web.watchMembers = vi.fn(() => new Promise<void>(resolve => { ready = resolve; }));
  let written = false;
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (method, ...args) => {
    if (method === 'members.getDetail') return { member, recentTurns: ['turn', 'other'].map(id => ({ id, running: false })), sessions: [], currentTask: null, history: [], messages: [] };
    if (method === 'members.getEvents') {
      const options = args[1];
      const cursor = options && typeof options === 'object' && 'cursor' in options ? options.cursor : undefined;
      const turnId = options && typeof options === 'object' && 'turnId' in options ? String(options.turnId) : 'turn';
      if (!cursor) return { events: [event(1, turnId)], nextCursor: null, turnId };
      if (written && cursor === '1') return { events: [event(1, turnId), event(2, turnId)], nextCursor: '2', turnId };
      return { events: [event(2, turnId), event(3, turnId)], nextCursor: null, turnId };
    }
    return original(method, ...args);
  });
  const render = () => MemberPanel({ id: member.id, snapshot: snap, close: noop, openTask: noop });
  await host.render(render); await flush(); await host.render(render);
  expect(host.html()).toContain('<p>1</p>'); expect(host.html()).not.toContain('<p>2</p>');
  written = true;
  push?.({ memberId: member.id, turnId: 'turn', events: [event(3), event(3)] }); await host.render(render);
  ready?.(); await flush(); await host.render(render);
  expect(invoke).toHaveBeenCalledWith('members.getEvents', member.id, { turnId: 'turn', cursor: '1', limit: 200 });
  expect(invoke).toHaveBeenCalledWith('members.getEvents', member.id, { turnId: 'turn', cursor: '2', limit: 200 });
  expect(host.html().match(/<p>[123]<\/p>/g)).toEqual(['<p>1</p>', '<p>2</p>', '<p>3</p>']);
  const select = elements(host.tree).find(node => node.props['aria-label'] === '턴 선택');
  select?.props.onChange?.({ target: { value: 'other' } }); await host.render(render);
  expect(web.watchMembers).toHaveBeenCalledTimes(2);
  ready?.(); await flush(); await host.render(render);
  expect(invoke).toHaveBeenCalledWith('members.getEvents', member.id, { turnId: 'other', cursor: '1', limit: 200 });
  expect(host.html().match(/<p>3<\/p>/g)).toHaveLength(1);
});

it('S8-upload-rate-limit: queues again without an error, then becomes ready and enables send', async () => {
  web.upload = vi.fn().mockRejectedValueOnce(Object.assign(new Error('사용 중'), { code: 'rate_limited' }))
    .mockResolvedValue({ uploadId: 'retry', name: 'queued.txt', size: 1, expiresAt: '' });
  await host.render(composer);
  const input = elements(host.tree).find(node => node.props['aria-label'] === '첨부할 파일 선택');
  (input!.props as unknown as { onChange: (event: unknown) => void }).onChange({ target: { files: [new File(['x'], 'queued.txt')], value: '' } });
  await flush(); await host.render(composer);
  expect(host.html()).toContain('업로드 대기 · 잠시 뒤 다시 올립니다');
  expect(host.html()).not.toContain('role="alert"'); expect(button(host, '보내기').props.disabled).toBe(true);
  await vi.advanceTimersByTimeAsync(299); expect(web.upload).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1); await host.render(composer);
  expect(web.upload).toHaveBeenCalledTimes(2); expect(host.html()).toContain('첨부 준비됨');
  expect(host.html()).not.toContain('role="alert"'); expect(button(host, '보내기').props.disabled).toBe(false);
});

it('S8-upload-rate-exhausted: waits 300ms, 1s and Retry-After before showing an error, cancels removed retries', async () => {
  const limited = Object.assign(new Error('계속 사용 중'), { code: 'rate_limited', retryAfterSec: 2 });
  web.upload = vi.fn().mockRejectedValue(limited);
  let chips: UploadChip[] = [];
  const queue = new UploadQueue(web, values => { chips = values; });
  queue.add([{ name: 'busy', file: new Blob(['x']) }]); await flush();
  for (const delay of [300, 1000, 2000]) {
    expect(chips[0].state.kind).toBe('queued');
    const count = vi.mocked(web.upload).mock.calls.length;
    await vi.advanceTimersByTimeAsync(delay - 1); expect(web.upload).toHaveBeenCalledTimes(count);
    await vi.advanceTimersByTimeAsync(1); expect(web.upload).toHaveBeenCalledTimes(count + 1);
  }
  expect(chips[0].state).toEqual({ kind: 'error', message: '계속 사용 중' });
  await vi.advanceTimersByTimeAsync(10000); expect(web.upload).toHaveBeenCalledTimes(4);
  queue.retry(chips[0].id); await flush(); expect(chips[0].state.kind).toBe('queued');
  queue.remove(chips[0].id); await vi.advanceTimersByTimeAsync(10000); expect(web.upload).toHaveBeenCalledTimes(5);
  queue.dispose();
});

it('S8-upload-unauthorized: raises the same login event as invoke unauthorized', async () => {
  web.upload = vi.fn().mockRejectedValue(Object.assign(new Error('다시 로그인해 주세요'), { code: 'unauthorized' }));
  const queue = new UploadQueue(web, noop);
  queue.add([{ file: new Blob(['x']), name: 'expired' }]); await flush();
  expect(window.dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'wook:unauthorized' }));
  expect(web.upload).toHaveBeenCalledTimes(1); queue.dispose();
});

it('S8-notification-worker: uses showNotification with fixed text, data.link and one tag; handles navigation and cold start', async () => {
  const showNotification = vi.fn(async () => undefined), register = vi.fn(async () => ({ active: {}, showNotification }));
  const messages = new EventTarget();
  vi.stubGlobal('navigator', { serviceWorker: { register, addEventListener: messages.addEventListener.bind(messages), removeEventListener: messages.removeEventListener.bind(messages) } });
  class AndroidNotification { static permission = 'granted'; constructor() { throw new Error('Illegal constructor'); } }
  vi.stubGlobal('Notification', AndroidNotification); Object.assign(document, { visibilityState: 'hidden' });
  const navigate = vi.fn(), item = { ...notifications[0], id: 'sw-item', title: '비밀 제목', body: '비밀 본문'.repeat(100), link: { tab: 'documents', reportId: 'R-1' } as const };
  const off = listenNotificationNavigation(navigate);
  await Promise.all([showBrowserNotification(item, navigate), showBrowserNotification(item, navigate)]);
  expect(register).toHaveBeenCalledWith('/notify-sw.js', { scope: '/' }); expect(showNotification).toHaveBeenCalledTimes(1);
  const [title, options] = vi.mocked(showNotification).mock.calls[0] as unknown as [string, NotificationOptions];
  expect(title).toBe('욱채 알림'); expect(options.body).toBe('작업실에 확인할 새 알림이 있습니다.'); expect(options.tag).toBe('wook-sw-item');
  expect(JSON.stringify(options)).not.toContain(item.title); expect(JSON.stringify(options)).not.toContain(item.body);
  messages.dispatchEvent(new MessageEvent('message', { data: { type: 'wook:navigate', link: options.data.link } }));
  expect(navigate).toHaveBeenCalledWith(item.link);
  navigate.mockClear(); messages.dispatchEvent(new MessageEvent('message', { origin: 'https://elsewhere.test', data: { type: 'wook:navigate', link: options.data.link } })); expect(navigate).not.toHaveBeenCalled();
  Object.assign(window.location, { hash: options.data.link.slice(1), pathname: '/' });
  Object.assign(window, { history: { replaceState: vi.fn() } });
  const offCold = listenNotificationNavigation(navigate); expect(navigate).toHaveBeenCalledWith(item.link);
  expect(notificationTarget('//elsewhere.test/')).toBeNull(); expect(notificationTarget('/#wook-notify=bad')).toBeNull();
  off(); offCold();
});

it('S8-notification-unavailable: hides the offer and explains once if worker and constructor fail', async () => {
  vi.stubGlobal('navigator', { serviceWorker: { register: vi.fn(async () => { throw new Error('worker unavailable'); }) } });
  class Unsupported { static permission = 'default'; constructor() { throw new TypeError('Illegal constructor'); } }
  vi.stubGlobal('Notification', Unsupported);
  await host.render(NotificationOffer); expect(host.html()).toContain('브라우저 알림 켜기');
  Unsupported.permission = 'granted'; Object.assign(document, { visibilityState: 'hidden' });
  await showBrowserNotification({ ...notifications[0], id: 'cannot-show' }, noop); await host.render(NotificationOffer);
  expect(host.html()).not.toContain('브라우저 알림 켜기'); expect(host.html()).toContain('이 브라우저에서는 알림을 표시할 수 없습니다. 작업실의 알림함을 확인해 주세요.');
  await showBrowserNotification({ ...notifications[0], id: 'cannot-show-again' }, noop); await host.render(NotificationOffer);
  expect(vi.mocked(window.dispatchEvent).mock.calls.filter(([event]) => event.type === 'wook:notifications-unavailable')).toHaveLength(1);
  expect(host.html().match(/브라우저 알림을 표시할 수 없음/g)).toHaveLength(1);
});

it('S8-worker-click: focuses same-origin clients, opens a window otherwise, rejects foreign and non-relative links; notificationclick only', async () => {
  const source = readFileSync(resolve('src/renderer/public/notify-sw.js'), 'utf8');
  const handlers = new Map<string, (event: unknown) => void>();
  const client = { url: 'https://wook.test/', focus: vi.fn(async () => undefined), postMessage: vi.fn() };
  // The registering page is not controlled: this worker has no fetch handler or clients.claim().
  const clients = { matchAll: vi.fn(async (options: { includeUncontrolled?: boolean }) => options.includeUncontrolled ? [client] : []), openWindow: vi.fn(async () => undefined) };
  runInNewContext(source, { URL, self: { location: { origin: 'https://wook.test' }, clients, addEventListener: (name: string, handler: (event: unknown) => void) => handlers.set(name, handler) } });
  expect([...handlers.keys()]).toEqual(['notificationclick']); expect(source).not.toMatch(/\b(?:caches|importScripts)\b/);
  const click = async (link: string) => { let done: Promise<unknown> | undefined; handlers.get('notificationclick')?.({ notification: { close: noop, data: { link } }, waitUntil: (work: Promise<unknown>) => { done = work; } }); await done; };
  await click('/#wook-notify=test'); expect(client.focus).toHaveBeenCalledTimes(1); expect(client.postMessage).toHaveBeenCalledWith({ type: 'wook:navigate', link: '/#wook-notify=test' });
  expect(clients.matchAll).toHaveBeenCalledWith({ type: 'window', includeUncontrolled: true }); expect(clients.openWindow).not.toHaveBeenCalled();
  clients.matchAll.mockResolvedValue([]); await click('/'); expect(clients.openWindow).toHaveBeenCalledWith('/');
  clients.matchAll.mockClear();
  for (const link of ['https://elsewhere.test/', '//elsewhere.test/', '/\\elsewhere.test/', 'javascript:alert(1)']) await click(link);
  expect(clients.matchAll).not.toHaveBeenCalled();
});

it('S8-missed-notifications: resync shows one count for new unread unseen items only', async () => {
  const showNotification = vi.fn(async () => undefined);
  vi.stubGlobal('navigator', { serviceWorker: { register: vi.fn(async () => ({ active: {}, showNotification })) } });
  vi.stubGlobal('Notification', { permission: 'granted' }); Object.assign(document, { visibilityState: 'hidden' });
  const loss = Date.now(), make = (id: string, at: number, read = false) => ({ ...notifications[0], id, createdAt: new Date(at).toISOString(), read });
  await showMissedNotifications([make('old', loss - 1)], noop);
  expect(showNotification).not.toHaveBeenCalled();
  await showBrowserNotification(make('live', loss + 1), noop);
  const items = [make('old', loss - 1), make('read', loss + 1, true), make('live', loss + 1), make('missed-1', loss + 1), make('missed-2', loss + 2)];
  await showMissedNotifications(items, noop); await showMissedNotifications(items, noop);
  expect(showNotification).toHaveBeenCalledTimes(2);
  expect(showNotification).toHaveBeenLastCalledWith('욱채 알림', expect.objectContaining({ body: '작업실에 확인할 새 알림이 2개 있습니다.', tag: 'wook-missed-1' }));
});

function notificationWorker() {
  const showNotification = vi.fn(async () => undefined);
  vi.stubGlobal('Notification', { permission: 'granted' });
  vi.stubGlobal('navigator', { serviceWorker: { register: vi.fn(async () => ({ active: {}, showNotification })), addEventListener: noop, removeEventListener: noop } });
  return showNotification;
}

it('S8-live-before-list: a visible live item is already seen even if the last list did not contain it', async () => {
  const shown = notificationWorker(), live = { ...notifications[0], id: 'live-before-list', read: false };
  await showMissedNotifications([], noop);
  await showBrowserNotification(live, noop);
  Object.assign(document, { visibilityState: 'hidden' });
  await showMissedNotifications([live, { ...live, id: 'missed-after-live' }], noop);
  expect(shown).toHaveBeenCalledExactlyOnceWith('욱채 알림', expect.objectContaining({ tag: 'wook-missed-after-live', body: '작업실에 확인할 새 알림이 있습니다.' }));
});

it.each([-180000, 180000])('S8-clock-skew: recovers unseen ids with page clock offset %i and never repeats visible live items', async offset => {
  const serverTime = Date.parse('2026-11-05T12:00:00Z'); vi.setSystemTime(serverTime + offset);
  const make = (id: string, at: number) => ({ ...notifications[0], id, createdAt: new Date(at).toISOString(), read: false });
  const old = make('listed-before-loss', serverTime - 1000), live = make('visible-live', serverTime), missed = make('skew-missed', serverTime + 1000);
  let items = [old], push: ((item: WookTopics['notification']) => void) | undefined;
  context.bridge!.subscribe = (topic, cb) => { if (topic === 'notification') push = cb as typeof push; return noop; };
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (method, ...args) => method === 'snapshot.get' ? snap : method === 'notifications.list' ? items : original(method, ...args));
  const shown = notificationWorker();
  await host.render(App); expect(shown).not.toHaveBeenCalled();
  items = [live, old]; push?.(live); await flush(); expect(shown).not.toHaveBeenCalled();
  Object.assign(document, { visibilityState: 'hidden' });
  web.setConnection({ status: 'reconnecting', lostAt: Date.now(), attempt: 1, retryAt: null });
  items = [missed, live, old]; web.resync(); await flush();
  expect(shown).toHaveBeenCalledExactlyOnceWith('욱채 알림', expect.objectContaining({ tag: 'wook-skew-missed', body: '작업실에 확인할 새 알림이 있습니다.' }));
  web.resync(); await flush(); expect(shown).toHaveBeenCalledTimes(1);
});

it('S8-silent-dead: recovers an item created 47 seconds before the watchdog reports the loss', async () => {
  let items: typeof notifications = [];
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (method, ...args) => method === 'snapshot.get' ? snap : method === 'notifications.list' ? items : original(method, ...args));
  const shown = notificationWorker(); await host.render(App);
  Object.assign(document, { visibilityState: 'hidden' });
  await vi.advanceTimersByTimeAsync(3000);
  items = [{ ...notifications[0], id: 'silent-gap', read: false, createdAt: new Date().toISOString() }];
  await vi.advanceTimersByTimeAsync(47000);
  web.setConnection({ status: 'reconnecting', lostAt: Date.now(), attempt: 1, retryAt: null });
  expect(shown).not.toHaveBeenCalled();
  web.setConnection({ status: 'open', since: Date.now(), runId: 'restored' }); web.resync(); await flush();
  expect(shown).toHaveBeenCalledExactlyOnceWith('욱채 알림', expect.objectContaining({ tag: 'wook-silent-gap' }));
});

it('S8-later-list: a later snapshot read recovers unseen unread ids without any reconnect and marks visible lists seen', async () => {
  let items: typeof notifications = [];
  let pushSnapshot: ((value: WookTopics['snapshot']) => void) | undefined;
  context.bridge!.subscribe = (topic, cb) => { if (topic === 'snapshot') pushSnapshot = cb as typeof pushSnapshot; return noop; };
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (method, ...args) => method === 'snapshot.get' ? snap : method === 'notifications.list' ? items : original(method, ...args));
  const shown = notificationWorker(); await host.render(App);
  items = [{ ...notifications[0], id: 'visible-list', read: false }];
  snap = structuredClone(snap); snap.notifications.unread++; pushSnapshot?.(snap); await host.render(App);
  expect(shown).not.toHaveBeenCalled();
  Object.assign(document, { visibilityState: 'hidden' });
  items = [{ ...notifications[0], id: 'later-unseen', read: false }, ...items];
  snap = structuredClone(snap); snap.notifications.unread++; pushSnapshot?.(snap); await host.render(App);
  expect(shown).toHaveBeenCalledExactlyOnceWith('욱채 알림', expect.objectContaining({ tag: 'wook-later-unseen', body: '작업실에 확인할 새 알림이 있습니다.' }));
});

it('S8-panel-empty-catchup: an empty first read still catches up from zero after watch readiness, once and in order', async () => {
  const member = { ...snap.members[0], currentWork: null }; snap.members[0] = member;
  let ready: (() => void) | undefined, push: ((value: WookTopics['cliEvents']) => void) | undefined;
  web.watchMembers = vi.fn(() => new Promise<void>(resolve => { ready = resolve; }));
  context.bridge!.subscribe = (topic, cb) => { if (topic === 'cliEvents') push = cb as typeof push; return noop; };
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (method, ...args) => {
    if (method === 'members.getDetail') return { member, recentTurns: [{ id: 'turn', running: true }], sessions: [], currentTask: null, history: [], messages: [] };
    if (method === 'members.getEvents') {
      const options = args[1], cursor = options && typeof options === 'object' && 'cursor' in options ? options.cursor : undefined;
      return cursor === '0' ? { events: [event(1), event(2)], nextCursor: '2', turnId: 'turn' }
        : cursor === '2' ? { events: [event(3)], nextCursor: null, turnId: 'turn' }
        : { events: [], nextCursor: null, turnId: 'turn' };
    }
    return original(method, ...args);
  });
  const render = () => MemberPanel({ id: member.id, snapshot: snap, close: noop, openTask: noop });
  await host.render(render); expect(host.html()).not.toContain('<p>1</p>');
  push?.({ memberId: member.id, turnId: 'turn', events: [event(3), event(3)] }); await host.render(render);
  ready?.(); await flush(); await host.render(render);
  expect(invoke).toHaveBeenCalledWith('members.getEvents', member.id, { turnId: 'turn', cursor: '0', limit: 200 });
  expect(invoke).toHaveBeenCalledWith('members.getEvents', member.id, { turnId: 'turn', cursor: '2', limit: 200 });
  expect(host.html().match(/<p>[123]<\/p>/g)).toEqual(['<p>1</p>', '<p>2</p>', '<p>3</p>']);
});

it('S8-worker-reject-fallback: a rejected showNotification uses the working constructor without marking the browser unavailable', async () => {
  const created = vi.fn(), showNotification = vi.fn(async () => { throw new Error('worker rejected'); });
  class WorkingNotification { static permission = 'granted'; constructor(title: string, options: NotificationOptions) { created(title, options); } }
  vi.stubGlobal('Notification', WorkingNotification);
  vi.stubGlobal('navigator', { serviceWorker: { register: vi.fn(async () => ({ active: {}, showNotification })) } });
  Object.assign(document, { visibilityState: 'hidden' });
  await showBrowserNotification({ ...notifications[0], id: 'fallback' }, noop);
  expect(showNotification).toHaveBeenCalledTimes(1);
  expect(created).toHaveBeenCalledExactlyOnceWith('욱채 알림', expect.objectContaining({ tag: 'wook-fallback', body: '작업실에 확인할 새 알림이 있습니다.' }));
  expect(notificationsUnavailable()).toBe(false);
});

it.each(['visible', 'denied'])('S8-registration-recheck: stops delivery if %s while registration is pending and permits a later retry', async changed => {
  const showNotification = vi.fn(async () => undefined), constructor = vi.fn();
  let registered: ((value: unknown) => void) | undefined;
  const register = vi.fn(() => new Promise(resolve => { registered = resolve; }));
  class WorkingNotification { static permission = 'granted'; constructor() { constructor(); } }
  vi.stubGlobal('Notification', WorkingNotification); vi.stubGlobal('navigator', { serviceWorker: { register } });
  Object.assign(document, { visibilityState: 'hidden' });
  const item = { ...notifications[0], id: 'registration-pending' }, pending = showBrowserNotification(item, noop);
  await flush(); expect(register).toHaveBeenCalledTimes(1);
  if (changed === 'visible') Object.assign(document, { visibilityState: 'visible' }); else WorkingNotification.permission = 'denied';
  registered?.({ active: {}, showNotification }); await pending;
  expect(showNotification).not.toHaveBeenCalled(); expect(constructor).not.toHaveBeenCalled();
  Object.assign(document, { visibilityState: 'hidden' }); WorkingNotification.permission = 'granted';
  await showBrowserNotification(item, noop); expect(showNotification).toHaveBeenCalledTimes(1);
});

it('S8-notice-viewer: unsupported notice can be dismissed, stays dismissed after remount, and is separate per viewer', async () => {
  vi.stubGlobal('Notification', undefined);
  const first = () => NotificationOffer({ viewer: 'first@example.test' });
  await host.render(first); expect(host.html()).toContain('이 브라우저에서는 알림을 표시할 수 없습니다.');
  await button(host, '브라우저 알림 불가 안내 닫기').props.onClick?.(); await host.render(first); expect(host.html()).toBe('');
  host.dispose(); host = new HookHost(); await host.render(first); expect(host.html()).toBe('');
  host.dispose(); host = new HookHost(); await host.render(() => NotificationOffer({ viewer: 'second@example.test' }));
  expect(host.html()).toContain('브라우저 알림 불가 안내 닫기');
});

it('S8-notice-storage-blocked: storage exceptions do not prevent rendering or dismissal for this visit', async () => {
  vi.stubGlobal('Notification', undefined);
  Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new Error('storage blocked'); } });
  await host.render(NotificationOffer); expect(host.html()).toContain('브라우저 알림 불가 안내 닫기');
  await button(host, '브라우저 알림 불가 안내 닫기').props.onClick?.(); await host.render(NotificationOffer); expect(host.html()).toBe('');
});

it('S8-notice-home: the offer slot is visible only on Home and still registers while the slot is hidden', async () => {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (method, ...args) => method === 'snapshot.get' ? snap : method === 'notifications.list' ? [] : original(method, ...args));
  await host.render(App);
  const offer = () => elements(host.tree).find(node => node.type === NotificationOffer)?.props.visible;
  expect(offer()).toBe(true);
  await button(host, '문서함').props.onClick?.(); await host.render(App); expect(offer()).toBe(false);
  host.dispose(); host = new HookHost();
  const shown = notificationWorker();
  await host.render(() => NotificationOffer({ visible: false }));
  expect(host.html()).toBe(''); expect(navigator.serviceWorker.register).toHaveBeenCalledTimes(1); expect(shown).not.toHaveBeenCalled();
});

it('S8-project-changes: Documents selects the project conversation after success without a second command or lost draft', async () => {
  const report = { ...reports[0], projectId: snap.projects[0].id, projectName: snap.projects[0].name, canRequestChanges: true, comments: [], otherRounds: [] };
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (method, ...args) => method === 'reports.get' ? report : method === 'reports.list' ? [report] : original(method, ...args));
  const conversation = vi.fn(), off = subscribeConversation(conversation);
  const render = () => Documents({ snapshot: snap, selectedId: report.id, setSelectedId: noop });
  await host.render(render); await button(host, '수정 요청').props.onClick?.(); await host.render(render);
  const comment = elements(host.tree).find(node => node.type === 'textarea'); comment?.props.onChange?.({ target: { value: '표를 보완해 주세요' } }); await host.render(render);
  await button(host, '수정 요청 보내기').props.onClick?.(); await flush(); await host.render(render);
  expect(conversation).toHaveBeenCalledWith(report.projectId);
  expect(host.html()).toContain(`${report.projectName} 대화에 수정 요청을 표시했습니다.`);
  expect(invoke).not.toHaveBeenCalledWith('command.send', expect.anything()); off(); host.dispose(); host = new HookHost();
  await host.render(composer); openCommand(null, '작성 중인 명령'); await host.render(composer);
  openConversation(report.projectId); await host.render(composer);
  expect(host.html()).toContain('작성 중인 명령');
  expect(invoke).toHaveBeenCalledWith('command.history', report.projectId, { limit: 60 });
  expect(elements(host.tree).find(node => node.props['aria-label'] === '명령 대상')?.props).toMatchObject({ value: report.projectId });
});

it('S8-fake-changes: fake request inserts one S8-13 owner message in the right conversation', async () => {
  window.wook = context.bridge!;
  const { fakeBridge } = await import('../api/fake');
  const report = reports.find(item => item.status !== 'approved' && item.status !== 'changes_requested');
  expect(report).toBeDefined();
  const saved = structuredClone(report!), before = structuredClone(conversations[report!.projectId ?? 'main'] ?? []);
  const target = report!.projectId ?? 'main';
  try {
    // A direct report avoids unrelated directive refusal fixtures.
    report!.directiveId = null;
    await fakeBridge.invoke('reports.requestChanges', report!.id, { overall: '수정 의견', anchored: [{ quote: '선택 문장', comment: '근거 추가' }] });
    await fakeBridge.invoke('reports.requestChanges', report!.id, { overall: '수정 의견', anchored: [] });
    const history = await fakeBridge.invoke('command.history', target, { limit: 60 });
    const added = history.filter(item => item.text.startsWith(`보고서 ${report!.id} "${report!.title}" 수정 요청:`));
    expect(added).toHaveLength(1); expect(added[0]).toMatchObject({ role: 'owner', directiveId: null, attachments: [] });
    expect(added[0].text).toContain('수정 의견\n- "선택 문장" → 근거 추가');
  } finally { Object.assign(report!, saved); conversations[target] = before; }
});

it('S8-directive-and-text: attachments appear once and all renderer source and stage-8 tools retain valid Korean', async () => {
  const directive = { ...snap.directives[0], attachments: [{ id: 'A-123', name: '검토 자료.txt', path: 'C:/server/file' }] };
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (method, ...args) => method === 'directives.get' ? { directive, rounds: [], tasks: [], reports: [] } : original(method, ...args));
  await host.render(() => DirectiveDetail({ id: directive.id, snapshot: snap, close: noop, openTask: noop, openReport: noop }));
  expect(host.html().match(/href="\/api\/attachments\/A-123"/g)).toHaveLength(1);
  expect(host.html().match(/첨부 파일/g)).toHaveLength(1);
  expect(brokenText().defects).toEqual([]);
});

it('S8-home-wrap: phone project cards can shrink and their paths wrap anywhere', () => {
  const css = readFileSync(resolve('src/renderer/src/styles/web.css'), 'utf8');
  expect(css).toMatch(/\.web-layout \.project-card\s*\{[^}]*min-width:\s*0/);
  expect(css).toMatch(/\.web-layout \.project-path\s*\{[^}]*min-width:\s*0;[^}]*overflow-wrap:\s*anywhere/);
  expect(css).toMatch(/\.web-layout \.project-path\s*\{[^}]*white-space:\s*normal/);
  expect(readFileSync(resolve('src/renderer/src/screens/Home.tsx'), 'utf8')).toContain('className="muted project-path"');
});

it('S8-desktop-export: desktop export opens the file and says so', async () => {
  context.bridge!.web = undefined; context.bridge!.platform = 'win32'; snap.auth.mode = 'desktop';
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (method, ...args) => method === 'logs.export' ? { path: 'C:/logs/export.json' } : method === 'logs.search' ? [] : original(method, ...args));
  const render = () => SettingsScreen({ snapshot: snap, section: 'logs', setSection: noop, logout: noop, openTask: noop });
  await host.render(render); await button(host, '내보내기').props.onClick?.(); await flush(); await host.render(render);
  expect(host.html()).toContain('내보낸 기록 열기'); expect(host.html()).not.toContain('내보낸 기록 내려받기');
});

it('S8-web-escape: Escape closes the move palette while browser shortcuts remain untouched', async () => {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (method, ...args) => method === 'snapshot.get' ? snap : method === 'notifications.list' ? [] : original(method, ...args));
  await host.render(App);
  const move = elements(host.tree).find(node => node.type === 'button' && text(node.props.children).includes('이동'));
  expect(move).toBeDefined(); await move?.props.onClick?.(); await host.render(App); expect(host.html()).toContain('aria-label="빠른 이동"');
  const escape = new Event('keydown'); Object.assign(escape, { key: 'Escape' }); window.dispatchEvent(escape); await host.render(App);
  expect(host.html()).not.toContain('aria-label="빠른 이동"');
});

it('S8-notification-granted-load: registers on a permitted web page and leaves desktop alone', async () => {
  const register = vi.fn(async () => ({ active: {}, showNotification: vi.fn() }));
  vi.stubGlobal('navigator', { serviceWorker: { register } }); vi.stubGlobal('Notification', { permission: 'granted' });
  await host.render(NotificationOffer); expect(register).toHaveBeenCalledWith('/notify-sw.js', { scope: '/' });
  host.dispose(); host = new HookHost(); register.mockClear(); context.bridge!.web = undefined; context.bridge!.platform = 'win32';
  await host.render(NotificationOffer); expect(register).not.toHaveBeenCalled(); expect(host.html()).toBe('');
});

it('S8-doc-status: README records the passing web type check and the fix round', () => {
  const readme = readFileSync(resolve('docs/design/permission-ui/stage8-web/README.md'), 'utf8');
  const typecheck = readme.split('\n').find((line: string) => line.startsWith('| `npx tsc --noEmit -p tsconfig.web.json` |'));
  expect(typecheck).toContain('**exit 0**'); expect(readme).toContain('## 수정 1회차');
});
