import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSnapshot, JournalFilter, NotificationView } from '../../../shared/views';
import type { NavTarget } from '../../../shared/domain';
import { snapshot as seed, settings, roles, skills } from '../api/fake/data';
import { createFakeSeat } from '../api/fake/seat';
import { SeatChip, SeatUnresponsive } from './SeatStatus';
import { Handover, Journal, SeatScreen } from '../screens/Seat';
import { ActivityMarker } from './ActivityMarker';
import { SettingsScreen } from '../screens/Settings';
import { ServerNotice } from './ServerNotice';
import { noticePresentation } from '../lib/notice';
import { subscribeCommand } from '../lib/commands';
import { call } from '../api/store';
import { rendererInvocations } from '../../tools/renderer-methods.mjs';
import type { RendererTarget } from '../lib/seat';

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
type Props = { children?: ReactNode; onClick?: (event: { preventDefault: () => void }) => unknown;
  onChange?: (event: { target: { value: string; checked: boolean } }) => void; disabled?: boolean; generation?: number;
  'aria-label'?: string; 'aria-selected'?: boolean; href?: string; className?: string };
function elements(node: ReactNode): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  return isValidElement<Props>(node) ? [node, ...elements(node.props.children)] : [];
}
function text(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(text).join('');
  return typeof node === 'string' || typeof node === 'number' ? String(node) : isValidElement<Props>(node) ? text(node.props.children) : '';
}
function find(label: string, type = 'button') {
  const found = elements(host.tree).find(node => node.type === type && (text(node.props.children).trim() === label || node.props['aria-label'] === label));
  expect(found, label).toBeDefined(); return found!;
}
const click = (label: string, type = 'button') => find(label, type).props.onClick?.({ preventDefault() {} });
const change = (label: string, value: string) => find(label, 'select').props.onChange?.({ target: { value, checked: false } });
let host: HookHost, snapshot: AppSnapshot, fixture: ReturnType<typeof createFakeSeat>;
let navigate = vi.fn<(target: RendererTarget) => void>();
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-02T04:00:00Z'));
  vi.stubGlobal('window', { dispatchEvent: vi.fn() });
  host = new HookHost(); fixture = createFakeSeat(new URLSearchParams());
  snapshot = structuredClone(seed); snapshot.auth.loggedIn = true; snapshot.seat = fixture.seat;
  navigate = vi.fn();
  runtime.invoke.mockReset().mockImplementation(async (method: string, ...args: unknown[]) => {
    if (method === 'seat.get') return structuredClone(snapshot.seat);
    if (method === 'seat.history') return structuredClone(fixture.history);
    if (method === 'agents.list') return [];
    if (method === 'seat.handover') return fixture.handover(typeof args[0] === 'number' ? args[0] : undefined);
    if (method === 'journal.list') return fixture.list(args[0] as JournalFilter | undefined);
    if (method === 'settings.get') return structuredClone(settings);
    if (method === 'roles.list') return roles;
    if (method === 'skills.list') return skills;
    if (method === 'recovery.list') return [];
    if (method === 'system.info' || method === 'system.prereqs') return null;
    if (method === 'stop.emergency') return undefined;
    throw new Error(`Unexpected call: ${method}`);
  });
});
afterEach(() => { host.dispose(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const renderSeat = () => host.render(() => SeatScreen({ snapshot, navigate }));
const renderJournal = () => host.render(() => Journal({ snapshot, navigate }));

describe('stage 4 seat screens', () => {
  it('S4-1. shows every chip state, model and read-only navigation, and hides the locked seat', () => {
    const open = vi.fn();
    let tree = SeatChip({ snapshot, open });
    expect(renderToStaticMarkup(tree)).toContain('메인 에이전트: Claude CLI');
    expect(renderToStaticMarkup(tree)).toContain('opus');
    elements(tree).find(e => e.type === 'button')?.props.onClick?.({ preventDefault() {} }); expect(open).toHaveBeenCalledOnce();
    snapshot.seat = createFakeSeat(new URLSearchParams('fakeSeat=switching')).seat;
    expect(renderToStaticMarkup(SeatChip({ snapshot, open }))).toContain('메인 에이전트: Claude CLI → Codex CLI 교체 중');
    snapshot.seat = createFakeSeat(new URLSearchParams('fakeSeat=vacant')).seat;
    expect(renderToStaticMarkup(SeatChip({ snapshot, open }))).toContain('메인 에이전트 없음');
    snapshot.seat.state = 'stopped'; expect(renderToStaticMarkup(SeatChip({ snapshot, open }))).toContain('메인 에이전트 정지됨');
    snapshot.seat.state = 'active'; snapshot.seat.holder = { kind: 'external', agentId: 'X-1', label: '그록봇' };
    expect(renderToStaticMarkup(SeatChip({ snapshot, open }))).toContain('메인 에이전트: 그록봇');
    expect(renderToStaticMarkup(SeatChip({ snapshot, open }))).not.toContain('<small>');
    snapshot.auth.loggedIn = false; tree = SeatChip({ snapshot, open }); expect(tree).toBeNull();
    expect(runtime.invoke).not.toHaveBeenCalled();
  });

  it('S4-2. counts live across the hour, pauses while stopped, clears immediately and hides before login', async () => {
    snapshot.seat.unresponsiveSince = new Date(Date.now() - 59 * 60000 - 59000).toISOString();
    snapshot.seat.unresponsiveReason = '사용량 한도로 메인 턴이 3번 연달아 끝났습니다.';
    const render = () => host.render(() => SeatUnresponsive({ snapshot, stop: vi.fn() }));
    await render(); expect(host.html()).toContain('응답 없음 59분');
    vi.advanceTimersByTime(1000); await render(); expect(host.html()).toContain('응답 없음 1시간 0분');
    vi.advanceTimersByTime(12 * 60000); await render(); expect(host.html()).toContain('응답 없음 1시간 12분');
    expect(host.html()).toContain(snapshot.seat.unresponsiveReason);
    expect(host.html()).toContain('명령은 계속 보낼 수 있고, 보유자가 돌아오면 이어서 처리합니다. 급하면 긴급 정지를 쓰세요.');
    snapshot.stop.global.active = true; await render(); vi.advanceTimersByTime(600000); await render();
    expect(host.html()).toContain('긴급 정지 중이라 세지 않습니다'); expect(host.html()).not.toContain('응답 없음 1시간'); expect(vi.getTimerCount()).toBe(0);
    snapshot.stop.global.active = false; snapshot.seat.unresponsiveSince = null; await render(); expect(host.tree).toBeNull();
    snapshot.seat.unresponsiveSince = new Date().toISOString(); snapshot.auth.loggedIn = false; await render(); expect(host.tree).toBeNull();
  });

  it('S4-2-actions. offers only command focus and emergency stop', async () => {
    snapshot.seat.unresponsiveSince = new Date().toISOString();
    const draft = vi.fn(), off = subscribeCommand(draft);
    await host.render(() => SeatUnresponsive({ snapshot, stop: () => { void call('stop.emergency'); } }));
    expect(elements(host.tree).filter(e => e.type === 'button').map(e => text(e.props.children))).toEqual(['메인 에이전트에게 말하기', '긴급 정지']);
    await click('메인 에이전트에게 말하기'); expect(draft).toHaveBeenCalledWith({ target: 'main', text: '메인 에이전트의 응답을 기다리고 있습니다. ' });
    await click('긴급 정지'); expect(runtime.invoke).toHaveBeenCalledWith('stop.emergency'); off();
  });

  it('S4-3. reads current seat and newest-first history, with handover links only where available', async () => {
    await renderSeat(); const html = host.html();
    expect(runtime.invoke).toHaveBeenCalledWith('seat.get'); expect(runtime.invoke).toHaveBeenCalledWith('seat.history');
    for (const label of ['세대 3', 'Claude CLI', '활동 중', '화면 보기: 아직 확인 안 함', '운영자 배정', '메인이 넘김', '서버', '사용량 한도로 메인이 Codex CLI에 넘겼습니다.', '메인 에이전트를 바꾸려면 명령창에서 메인 에이전트에게 말하세요.']) expect(html).toContain(label);
    expect(html.indexOf('세대 3')).toBeLessThan(html.indexOf('세대 2'));
    expect(elements(host.tree).filter(e => e.type === 'a').map(e => e.props.href)).toEqual(['#handover-3', '#handover-2']);
    await elements(host.tree).find(e => e.props.href === '#handover-2')?.props.onClick?.({ preventDefault() {} }); await renderSeat();
    expect(elements(host.tree).find(e => e.type === Handover)?.props.generation).toBe(2);
    await click('자리 이력으로'); await renderSeat(); expect(host.html()).toContain('지금 메인 자리');
  });

  it.each([['verified', '확인됨'], ['failed', '실패']] as const)('S4-3-vision. renders %s truthfully', async (vision, label) => {
    snapshot.seat.vision = vision; await renderSeat(); expect(host.html()).toContain(`화면 보기: ${label}`);
  });

  it('S4-4. preserves section order, omitted counts, packet metadata and the memo distinction', async () => {
    await host.render(() => Handover({ generation: 3 })); const html = host.html();
    expect(runtime.invoke).toHaveBeenCalledWith('seat.handover', 3);
    for (const label of ['세대 3의 인계', 'Claude CLI', 'Codex CLI', '분량', '외 7건', '외 2건', '확인되지 않은 메모', '이전 메인 에이전트가 남긴 메모입니다. 서버가 확인한 사실이 아닙니다.']) expect(html).toContain(label);
    const positions = ['자리 정보', '확인된 사실', '이전 메인 에이전트의 메모', '기억 문서 위치'].map(label => html.indexOf(`<h3>${label}`));
    expect(positions.every((pos, i) => i === 0 || pos > positions[i - 1])).toBe(true);
    expect(html).toContain('handover-section unverified-section'); expect(html).toContain('handover-section verified-section');
    const packet = fixture.handover(3)!; packet.previous = null;
    runtime.invoke.mockResolvedValue(packet); await host.render(() => Handover({ generation: 1 })); expect(host.html()).toContain('첫 세대');
  });

  it('S4-4-empty. displays the server null result', async () => {
    await host.render(() => Handover({ generation: 1 })); expect(host.html()).toContain('이 세대에는 인계 꾸러미가 없습니다');
  });

  it('S4-5. shows every kind and promise mark, resolves references and appends cursor pages', async () => {
    await renderJournal(); expect(runtime.invoke).toHaveBeenCalledWith('journal.list', { limit: 50 });
    const html = host.html();
    for (const label of ['받은 명령', '메인 행동', '보고', '자리', '긴급 정지', '결정', '약속', '메모', '월별 묶음', '열림', '닫힘', '오래됨', '확인 필요', '휴대폰에서 버튼을 눌러 보고 결과를 보고서에 남겼습니다.', 'Claude CLI · 세대 3', '확인되지 않은 메모', '서버 기록']) expect(html).toContain(label);
    const rows = () => elements(host.tree).filter(e => e.type === 'li'); expect(rows()).toHaveLength(50);
    expect(elements(host.tree).filter(e => e.type === 'a').some(e => text(e.props.children) === '(지워짐)')).toBe(false);
    await click('화면 점검 보고', 'a'); expect(navigate).toHaveBeenCalledWith({ tab: 'documents', reportId: 'R-0001' });
    await click('탐색 항목 이름에 관한 질문', 'a'); expect(navigate).toHaveBeenCalledWith({ tab: 'question', questionId: 'Q-0001' });
    await click('더 보기'); await renderJournal(); expect(rows()).toHaveLength(54);
    expect(runtime.invoke.mock.calls.at(-1)?.[1]).toMatchObject({ cursor: expect.any(String), limit: 50 });
    expect(elements(host.tree).some(e => e.type === 'button' && text(e.props.children) === '더 보기')).toBe(false);
  });

  it('S4-5-filters. applies project, kind, author and open promises, clearing previous pages', async () => {
    await renderJournal(); change('일지 프로젝트', 'P-0001'); await renderJournal(); change('일지 종류', 'promise'); await renderJournal(); change('일지 작성자', 'agent'); await renderJournal();
    elements(host.tree).find(e => e.type === 'input')?.props.onChange?.({ target: { checked: true, value: '' } }); await renderJournal();
    expect(runtime.invoke.mock.calls.at(-1)).toEqual(['journal.list', { limit: 50, projectId: 'P-0001', kinds: ['promise'], author: 'agent', openPromisesOnly: true }]);
    expect(elements(host.tree).filter(e => e.type === 'li')).toHaveLength(3); expect(host.html()).not.toContain('마무리:');
    change('일지 프로젝트', '__general'); await renderJournal(); expect(host.html()).toContain('조건에 맞는 기록이 없습니다.');
  });

  it('S4-5-race. ignores a late page from an earlier filter', async () => {
    let finish: ((value: unknown) => void) | undefined;
    runtime.invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await renderJournal(); change('일지 종류', 'promise'); await renderJournal();
    finish?.(fixture.list()); await renderJournal(); expect(elements(host.tree).filter(e => e.type === 'li')).toHaveLength(4);
  });

  it('S4-6. sends unresponsive notices to seat without a command shortcut and gives new activity kinds icons', async () => {
    const item: NotificationView = { id: 'N-seat', key: 'seat-unresponsive:3', title: '메인 응답 없음', body: '기다리는 중입니다.', createdAt: new Date().toISOString(), read: false, level: 'urgent', link: { tab: 'projects', memberId: 'M-MAIN' } };
    expect(noticePresentation(item, snapshot)).toMatchObject({ link: { tab: 'seat' }, command: null });
    const draft = vi.fn(), off = subscribeCommand(draft);
    await host.render(() => ServerNotice({ item, snapshot, navigate, markRead: vi.fn(), close: vi.fn() }));
    await click('관련 화면 보기'); expect(navigate).toHaveBeenCalledWith({ tab: 'seat' }); expect(draft).not.toHaveBeenCalled(); off();
    for (const kind of ['seat', 'journal'] as const) {
      const html = renderToStaticMarkup(ActivityMarker({ item: { ...seed.recentActivity[0], kind, text: '기록 내용' } }));
      expect(html).toContain('role="img"'); expect(html).toContain('<svg'); expect(html).toContain(kind === 'seat' ? '자리' : '일지');
    }
  });

  it.each([
    ['seat-unresponsive:3', '메인 에이전트 응답 없음'],
    ['seat:3', '메인 에이전트가 바뀌었습니다'],
    ['seat-switch:3', '메인 자리 교체가 멈췄습니다'],
    [null, '제목이 다른 자리 알림'],
    ['usage:claude:opus', '자리 확인'],
    ['execution-reset', '자리 확인'],
    ['pause-stuck:M-MAIN', '자리 확인'],
    ['device-login:another-device', '자리 확인'],
    ['crash:main', '자리 확인'],
  ])('S4-followup-notice. follows a shared seat link for %s', async (key, title) => {
    const link: NavTarget = { tab: 'seat' };
    const item: NotificationView = { id: 'N-seat', key, title, body: '자리 기록을 확인하세요.', createdAt: new Date().toISOString(), read: false, level: 'info', link };
    const draft = vi.fn(), off = subscribeCommand(draft), markRead = vi.fn(), close = vi.fn(), showDevices = vi.fn();
    try {
      expect(noticePresentation(item, snapshot)).toEqual({ title, link, command: null });
      await host.render(() => ServerNotice({ item, snapshot, navigate, markRead, close, showDevices }));
      expect(elements(host.tree).filter(e => e.type === 'button').map(e => text(e.props.children))).toEqual(['관련 화면 보기']);
      await click('관련 화면 보기');
      expect(navigate).toHaveBeenCalledExactlyOnceWith(link);
      expect(markRead).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
      expect(draft).not.toHaveBeenCalled(); expect(showDevices).not.toHaveBeenCalled();
    } finally { off(); }
  });

  it('S4-followup-topic. opens the seat view from the shared navigate topic', async () => {
    vi.stubGlobal('window', { wook: {}, location: { search: '' }, addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn() });
    runtime.subscribe.mockReset().mockReturnValue(() => undefined);
    runtime.invoke.mockImplementation(async (method: string) => {
      if (method === 'snapshot.get') return snapshot;
      if (method === 'notifications.list') return [];
      throw new Error(`Unexpected App call: ${method}`);
    });
    const { App } = await import('../App');
    await host.render(App);
    expect(elements(host.tree).some(e => e.type === SeatScreen)).toBe(false);
    const listener = runtime.subscribe.mock.calls.find(([topic]) => topic === 'navigate')?.[1];
    expect(listener).toBeTypeOf('function');
    const target: NavTarget = { tab: 'seat' };
    listener(target); await host.render(App);
    expect(elements(host.tree).some(e => e.type === SeatScreen)).toBe(true);
  });

  it('S4-7. explains desktop assignment and hides the server main-AI form', async () => {
    const render = () => host.render(() => SettingsScreen({ snapshot, section: 'account', setSection: vi.fn(), logout: vi.fn(), openTask: vi.fn() }));
    await render(); expect(host.html()).toContain('바꾸면 운영자 배정으로 기록됩니다. AI 종류를 바꾸면 새 세대가 되고, 모델이나 노력치만 바꾸면 다음 턴부터 적용됩니다.');
    expect(host.html()).not.toContain('class="installation-fields" disabled');
    snapshot.auth.mode = 'server'; await render(); expect(host.html()).not.toContain('<h2>메인 에이전트 AI</h2>');
    expect(runtime.invoke.mock.calls.some(([method]) => method === 'settings.update')).toBe(false);
  });

  it('S4-no-swap. seat, screen and agent views have no swap or agent-managing control', async () => {
    // S6-12 explicitly adds two viewing methods; it adds no operating permission.
    const allowed = ['seat.get', 'seat.history', 'seat.handover', 'journal.list', 'screens.recent', 'screens.image', 'agents.list', 'stop.emergency'];
    const sources = ['components/SeatStatus.tsx', 'components/ScreenStatus.tsx', 'components/ExternalAgents.tsx', 'screens/Seat.tsx', 'screens/SeatScreenControl.tsx', 'lib/seat.ts', 'lib/screens.ts', 'lib/agents.ts'];
    expect(rendererInvocations('src/renderer/src').filter(({ path, method }) => sources.some(source => path.replaceAll('\\', '/').endsWith(source)) && !allowed.includes(method))).toEqual([]);
    await renderSeat();
    for (const node of elements(host.tree).filter(e => e.type === 'button' || e.type === 'a')) await node.props.onClick?.({ preventDefault() {} });
    host.dispose(); host = new HookHost(); await renderJournal();
    for (const node of elements(host.tree).filter(e => e.type === 'button' || e.type === 'a')) await node.props.onClick?.({ preventDefault() {} });
    expect(runtime.invoke.mock.calls.every(([method]) => allowed.includes(method))).toBe(true);
    expect(host.html()).not.toMatch(/자리 배정|교체하기|재시도|넘기기/);
  });

  it('S4-8. fake fixtures cover scenarios, generations, all sections and cursor filtering', () => {
    expect(createFakeSeat(new URLSearchParams()).seat).toMatchObject({ state: 'active', unresponsiveSince: null });
    expect(createFakeSeat(new URLSearchParams('fakeSeat=unresponsive')).seat.unresponsiveSince).not.toBeNull();
    expect(createFakeSeat(new URLSearchParams('fakeSeat=switching')).seat.pendingHolder?.label).toBe('Codex CLI');
    expect(createFakeSeat(new URLSearchParams('fakeSeat=vacant')).seat.holder).toBeNull();
    expect(fixture.history.map(row => row.holder.label)).toEqual(['Claude CLI', 'Codex CLI', 'Claude CLI']);
    expect(fixture.handover()?.sections.map(section => section.key)).toEqual(['seat', 'facts', 'memos', 'memory']);
    expect(fixture.list({ openPromisesOnly: true }).entries).toHaveLength(3);
    expect(fixture.list({ projectId: null }).entries.every(row => row.projectId === null)).toBe(true);
  });

  it.each(['active', 'unresponsive', 'switching', 'vacant'])('S4-8-bridge. protects logged-out seat reads and serves %s snapshots', async scenario => {
    vi.resetModules();
    vi.stubGlobal('window', { location: { search: `?fakeSeat=${scenario}` }, localStorage: { getItem: () => null, setItem: vi.fn() }, setInterval, clearInterval });
    const { fakeBridge } = await import('../api/fake');
    expect((await fakeBridge.invoke('snapshot.get')).seat).toMatchObject({ generation: 0, state: 'vacant', holder: null, unresponsiveSince: null });
    await expect(fakeBridge.invoke('seat.get')).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(fakeBridge.invoke('seat.history')).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(fakeBridge.invoke('seat.handover')).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(fakeBridge.invoke('journal.list')).rejects.toMatchObject({ code: 'unauthorized' });
    await fakeBridge.invoke('auth.devLogin');
    const view = await fakeBridge.invoke('snapshot.get');
    expect(view.seat.state).toBe(scenario === 'switching' || scenario === 'vacant' ? scenario : 'active');
    expect(await fakeBridge.invoke('seat.get')).toEqual(view.seat);
    expect(await fakeBridge.invoke('seat.history')).toHaveLength(3);
    expect((await fakeBridge.invoke('seat.handover', 3))?.sections).toHaveLength(4);
    expect((await fakeBridge.invoke('journal.list')).entries).toHaveLength(50);
    const notices = await fakeBridge.invoke('notifications.list', { limit: 50 });
    expect(notices.find(item => item.title === '메인 에이전트가 바뀌었습니다')).toMatchObject({ link: { tab: 'seat' } });
    if (scenario === 'switching') expect(notices.find(item => item.key?.startsWith('seat-switch:')))
      .toMatchObject({ title: '메인 자리 교체가 멈췄습니다', link: { tab: 'seat' } });
    if (scenario === 'unresponsive') {
      expect(notices.find(item => item.key?.startsWith('seat-unresponsive:')))
        .toMatchObject({ title: '메인 에이전트 응답 없음', link: { tab: 'seat' } });
      await fakeBridge.invoke('stop.emergency'); vi.advanceTimersByTime(5 * 60000);
      await fakeBridge.invoke('stop.emergency');
      expect((await fakeBridge.invoke('snapshot.get')).seat).toMatchObject({ state: 'stopped', unresponsiveSince: view.seat.unresponsiveSince });
      await fakeBridge.invoke('stop.release');
      const resumed = await fakeBridge.invoke('seat.get');
      expect(resumed.state).toBe('active');
      expect(Date.parse(resumed.unresponsiveSince!) - Date.parse(view.seat.unresponsiveSince!)).toBe(5 * 60000);
    }
    await fakeBridge.invoke('auth.logout');
    expect((await fakeBridge.invoke('snapshot.get')).seat.generation).toBe(0);
  });

  it('S4-followup-models. uses the default catalog for every fake model selection', () => {
    const catalog = settings.team.modelCatalog;
    expect(catalog?.claude.map(model => model.id)).toEqual(['fable', 'opus', 'sonnet', 'haiku']);
    expect(catalog?.codex.map(model => model.id)).toEqual(['gpt-6-sol']);
    const selections = [settings.general.mainAgent, ...seed.members.flatMap(member => [member.ai, ...(member.pendingAiChange ? [member.pendingAiChange] : [])]),
      ...roles.map(role => role.defaultAi), ...fixture.history.flatMap(row => row.holder.kind === 'launched' ? [row.holder.ai] : [])];
    const pending = createFakeSeat(new URLSearchParams('fakeSeat=switching')).seat.pendingHolder;
    if (pending?.kind === 'launched') selections.push(pending.ai);
    for (const ai of selections) if (ai.model !== null) expect(catalog?.[ai.kind].map(model => model.id)).toContain(ai.model);
    for (const member of seed.members) if (member.ai.modelValue != null)
      expect(catalog?.[member.ai.kind].map(model => model.id)).toContain(member.ai.modelValue);
  });
});
