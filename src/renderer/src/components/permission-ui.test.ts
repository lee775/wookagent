import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DESKTOP_METHODS, IPC_METHODS } from '../../../shared/ipc';
import type { WookBridge } from '../../../shared/ipc';
import type { Settings } from '../../../shared/domain';
import type { AppSnapshot, CheckRunView, HoldReasonView, MemberDetail, OwnerTodo, ReportDetail, RoleView, TaskDetail as TaskDetailView } from '../../../shared/views';
import { snapshot as seed, settings as settingsSeed, reports, roles } from '../api/fake/data';
import { createFakeSeat } from '../api/fake/seat';
import { MemberPanel } from './MemberPanel';
import { TaskDetail } from './TaskDetail';
import { Home } from '../screens/Home';
import { Studio } from '../screens/Studio';
import { Documents } from '../screens/Documents';
import { SettingsScreen } from '../screens/Settings';
import { CommandBar } from './CommandBar';
import { MainPauseNotice, releaseNotice } from './MainPauseNotice';
import { SeatUnresponsive } from './SeatStatus';
import { subscribeCommand } from '../lib/commands';
import { invokedMethods, rendererInvocations } from '../../tools/renderer-methods.mjs';
import { useToasts } from '../api/store';

// Exercise the real component functions and their event handlers without adding a DOM dependency.
// Nested components use real React during server rendering; only the mounted component uses this host.
const context = vi.hoisted(() => ({ host: null as HookHost | null }));
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return { ...actual,
    useState: (init: unknown) => context.host ? context.host.state(init) : actual.useState(init),
    useRef: (init: unknown) => context.host ? context.host.state({ current: init })[0] : actual.useRef(init),
    useEffect: (fn: () => void | (() => void), deps?: unknown[]) => context.host ? context.host.effect(fn, deps) : actual.useEffect(fn, deps),
  };
});
vi.mock('../lib/ui', async () => {
  const actual = await vi.importActual<typeof import('../lib/ui')>('../lib/ui');
  // Markdown sanitization requires the browser. Report actions and all other UI remain real.
  return { ...actual, Markdown: ({ source }: { source: string }) => createElement('article', null, source) };
});

type Slot = { value: unknown; deps?: unknown[]; cleanup?: () => void };
class HookHost {
  slots: Slot[] = [];
  index = 0;
  effects: (() => void)[] = [];
  tree: ReactNode = null;
  state(init: unknown): [unknown, (value: unknown) => void] {
    const index = this.index++;
    const slot = this.slots[index] ??= { value: typeof init === 'function' ? init() : init };
    return [slot.value, value => { slot.value = typeof value === 'function' ? value(slot.value) : value; }];
  }
  effect(fn: () => void | (() => void), deps?: unknown[]) {
    const index = this.index++;
    const old = this.slots[index];
    if (!old || !deps || deps.some((dep, i) => !Object.is(dep, old.deps?.[i]))) {
      this.effects.push(() => { old?.cleanup?.(); const cleanup = fn(); this.slots[index] = { value: null, deps, cleanup: typeof cleanup === 'function' ? cleanup : undefined }; });
    }
  }
  async render(component: () => ReactNode) {
    for (let pass = 0; pass < 4; pass++) {
      this.index = 0; context.host = this;
      try { this.tree = component(); } finally { context.host = null; }
      this.effects.splice(0).forEach(effect => effect());
      for (let tick = 0; tick < 5; tick++) await Promise.resolve();
    }
  }
  html() { return renderToStaticMarkup(this.tree); }
  dispose() { this.slots.forEach(slot => slot.cleanup?.()); }
}
type Props = { children?: ReactNode; title?: string; className?: string; onClick?: () => unknown; onChange?: (event: { target: { value: string; checked: boolean } }) => void; value?: unknown; disabled?: boolean; 'aria-label'?: string };
function elements(node: ReactNode): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Props>(node)) return [];
  return [node, ...Object.values(node.props).flatMap(value => typeof value === 'object' && value !== null ? elements(value as ReactNode) : [])];
}
function textOf(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  return isValidElement<Props>(node) ? textOf(node.props.children) : '';
}
function click(host: HookHost, text: string) {
  const button = elements(host.tree).find(element => element.type === 'button' && textOf(element.props.children).trim() === text);
  expect(button, `button ${text}`).toBeDefined();
  return button?.props.onClick?.();
}
const noop = () => undefined;
let snap: AppSnapshot;
let member: MemberDetail;
let task: TaskDetailView;
let report: ReportDetail;
let requests: { method: string; args: unknown[] }[];
let hosts: HookHost[];
let installation: Settings;
let listedRoles: RoleView[];
let beforeSettingsUpdate: (() => Promise<void>) | undefined;
const mount = async (component: () => ReactNode) => { const host = new HookHost(); hosts.push(host); await host.render(component); return host; };
function mainForm(host: HookHost) {
  const node = elements(host.tree).find(element => typeof element.type === 'function' && element.type.name === 'AiConfigForm');
  if (!node || typeof node.type !== 'function') throw new Error('메인 AI 폼이 없습니다.');
  return node;
}
function renderMainForm(screen: HookHost) {
  const node = mainForm(screen);
  if (typeof node.type !== 'function') throw new Error('메인 AI 폼이 아닙니다.');
  const rendered: unknown = Reflect.apply(node.type, undefined, [node.props]);
  if (isValidElement(rendered)) return rendered;
  throw new Error('메인 AI 폼을 렌더링하지 못했습니다.');
}
function editMainModel(form: HookHost, model: string) {
  const fields = elements(form.tree).find(node => isValidElement<{ setModel?: unknown }>(node) && typeof node.props.setModel === 'function');
  if (!isValidElement<{ setModel: (model: string) => void }>(fields)) throw new Error('모델 입력이 없습니다.');
  fields.props.setModel(model);
}
beforeEach(() => {
  snap = structuredClone(seed); requests = []; hosts = [];
  snap.seat = createFakeSeat(new URLSearchParams()).seat;
  installation = structuredClone(settingsSeed);
  listedRoles = structuredClone(roles);
  beforeSettingsUpdate = undefined;
  const person = snap.members.find(item => item.id === 'M-0016')!;
  member = { member: person, role: roles[0], sessions: [], recentTurns: [], currentTask: null, queuedTasks: [], history: [], messages: [
    { id: 'm1', from: '메인 에이전트 지시', text: '확인해 주세요.', createdAt: snap.generatedAt, delivered: true },
    { id: 'm2', from: '메인 에이전트 긴급 지시', text: '검수 전에 확인해 주세요.', createdAt: snap.generatedAt, delivered: false },
    { id: 'm3', from: '메인 에이전트 지시 → 하늘 (공유)', text: '함께 확인해 주세요.', createdAt: snap.generatedAt, delivered: true },
  ] };
  task = { task: snap.tasks.find(item => item.id === 'T-0004')!, reviews: [], transitions: [], diff: null };
  report = structuredClone(reports[0]); report.status = 'changes_requested'; report.canApprove = true;
  const bridge = {
    platform: 'win32', subscribe: () => noop,
    async invoke(method: string, ...args: unknown[]) {
      requests.push({ method, args });
      switch (method) {
        case 'members.getDetail': return structuredClone(member);
        case 'tasks.get': return structuredClone(task);
        case 'reports.get': return structuredClone(report);
        case 'reports.list': return [structuredClone(report)];
        case 'settings.get': return structuredClone(installation);
        case 'settings.update':
          await beforeSettingsUpdate?.();
          if (JSON.stringify(args[0]) === '{"developer":{"mainAgentMock":false}}') installation.developer.mainAgentMock = false;
          return structuredClone(installation);
        case 'roles.list': return structuredClone(listedRoles);
        case 'skills.list': case 'recovery.list': case 'command.history': case 'logs.search': return [];
        case 'members.getEvents': return { events: [], nextCursor: null, turnId: null };
        default: return null;
      }
    },
  };
  vi.stubGlobal('window', { wook: bridge, location: { search: '' }, confirm: vi.fn(() => true), dispatchEvent: noop, setTimeout, addEventListener: noop, removeEventListener: noop });
});

describe('stage 4 follow-up 2 settings and exit copy', () => {
  const renderSettings = () => SettingsScreen({ snapshot: snap, section: 'account', setSection: noop, logout: noop, openTask: noop });

  it.each(['generation', 'state', 'model', 'kind'] as const)('S4-25-refresh. %s changes reread settings, show the current AI and preserve installation edits', async change => {
    const screen = await mount(renderSettings);
    const edit = (label: string, value: string, checked = false) => {
      const field = elements(screen.tree).find(node => node.type === 'label' && textOf(node.props.children).startsWith(label));
      const input = elements(field).find(node => node.type === 'input');
      expect(input, label).toBeDefined();
      input?.props.onChange?.({ target: { value, checked } });
    };
    edit('기록 보관 기간', '47'); await screen.render(renderSettings);
    edit('Google 클라이언트 ID', 'unsaved-client'); await screen.render(renderSettings);
    edit('Claude CLI 경로', 'C:/unsaved/claude.exe'); await screen.render(renderSettings);
    edit('자동 백업 켜기', '', false); await screen.render(renderSettings);
    const reads = () => requests.filter(request => request.method === 'settings.get').length;
    const before = reads();
    snap.version++; await screen.render(renderSettings); expect(reads()).toBe(before);
    installation.general.mainAgent = { kind: 'codex', model: 'gpt-6-sol', effortTier: 'low', effortOverride: null };
    if (change === 'generation') snap.seat.generation++;
    if (change === 'state') snap.seat.state = 'switching';
    if (change === 'model' && snap.seat.holder?.kind === 'launched') snap.seat.holder.ai.model = 'sonnet';
    if (change === 'kind' && snap.seat.holder?.kind === 'launched') snap.seat.holder.ai.kind = 'codex';
    await screen.render(renderSettings);
    expect(reads()).toBe(before + 1);
    expect(mainForm(screen).props.value).toEqual(installation.general.mainAgent);
    const form = await mount(() => renderMainForm(screen));
    expect(form.html()).toContain('value="gpt-6-sol"');
    await click(screen, '설치 설정 저장');
    const patch = requests.find(request => request.method === 'settings.update')?.args[0];
    expect(patch).toMatchObject({ logs: { retentionDays: 47 }, account: { googleClientId: 'unsaved-client' }, cli: { claudePath: 'C:/unsaved/claude.exe' }, general: { backup: { enabled: false } } });
    expect(patch).toHaveProperty('general');
    expect(patch).not.toHaveProperty('general.mainAgent');
  });

  it('S4-25-form. sends only the edited main AI and the loaded expected AI, with its own saving state and notice', async () => {
    const screen = await mount(renderSettings), loaded = structuredClone(installation.general.mainAgent);
    const form = await mount(() => renderMainForm(screen));
    editMainModel(form, 'sonnet'); await form.render(() => renderMainForm(screen));
    let finish: ((next: Settings) => void) | undefined;
    beforeSettingsUpdate = () => new Promise<void>(resolve => { finish = next => { installation = next; resolve(); }; });
    click(form, '저장'); await form.render(() => renderMainForm(screen));
    expect(requests.filter(request => request.method === 'settings.update')).toEqual([{ method: 'settings.update', args: [{ general: { mainAgent: { ...loaded, model: 'sonnet' } } }, { mainAgent: loaded }] }]);
    expect(elements(form.tree).find(node => node.type === 'button')?.props.disabled).toBe(true);
    expect(elements(screen.tree).find(node => node.type === 'button' && textOf(node.props.children).trim() === '설치 설정 저장')?.props.disabled).toBe(false);
    finish?.({ ...installation, general: { ...installation.general, mainAgent: { ...loaded, model: 'sonnet' } } });
    await form.render(() => renderMainForm(screen)); await screen.render(renderSettings); await form.render(() => renderMainForm(screen));
    expect(elements(form.tree).find(node => node.type === 'button')?.props.disabled).toBe(false);
    expect(form.html()).toContain('메인 AI를 저장했습니다.');
    expect(screen.html()).not.toContain('설치 설정을 저장했습니다.');
  });

  it('S4-25-conflict. reports the usual error without retrying or claiming success', async () => {
    const screen = await mount(renderSettings), form = await mount(() => renderMainForm(screen));
    const toasts = await mount(() => useToasts().items.map(item => item.body));
    const message = '메인 AI가 그사이 Codex CLI · gpt-6-sol로 바뀌었습니다. 아무것도 저장하지 않았습니다 — 바뀐 메인 AI를 확인한 뒤 다시 바꾸세요';
    const invoke = window.wook!.invoke;
    window.wook!.invoke = async (method, ...args) => {
      if (method === 'settings.update') { requests.push({ method, args }); throw { code: 'conflict', message }; }
      return invoke(method, ...args);
    };
    click(form, '저장'); await form.render(() => renderMainForm(screen)); await toasts.render(() => useToasts().items.map(item => item.body));
    expect(toasts.html()).toContain(message);
    expect(requests.filter(request => request.method === 'settings.update')).toHaveLength(1);
    expect(form.html()).not.toContain('저장했습니다');
  });

  it.each([
    ['desktop', 'win32', true], ['server', 'win32', false], ['desktop', 'web', false],
  ] as const)('S4-30-banner. %s / %s gives the correct seat-change route', async (mode, platform, desktop) => {
    snap.auth.mode = mode; window.wook!.platform = platform;
    snap.auth.loggedIn = true; snap.seat.unresponsiveSince = snap.generatedAt;
    const host = await mount(() => SeatUnresponsive({ snapshot: snap, stop: noop }));
    const desktopText = '자리를 바꾸는 것은 메인 에이전트, 또는 이 PC의 운영자가 운영 설정의 메인 AI로 할 수 있습니다';
    const serverText = '자리를 바꾸는 것은 메인 에이전트와 서버 PC의 운영자만 할 수 있습니다';
    expect(host.html()).toContain(desktop ? desktopText : serverText);
    expect(host.html()).not.toContain(desktop ? serverText : desktopText);
  });

  it.each([
    ['desktop', 'win32', true], ['server', 'win32', false], ['desktop', 'web', false],
  ] as const)('S4-30-pause. %s / %s explains who can check remaining processes', async (mode, platform, desktop) => {
    snap.auth.mode = mode; window.wook!.platform = platform;
    snap.stop.pausedMembers.push({ memberId: 'M-MAIN', by: 'system', mode: 'graceful', since: snap.generatedAt, reason: '종료 확인이 필요합니다.' });
    const host = await mount(() => MainPauseNotice({ snapshot: snap }));
    expect(host.html()).toContain(desktop ? '작업 관리자에서 남아 있는 프로세스가 없는지 먼저 확인한 뒤 정지를 해제해 주세요.' : '서버 PC에 남은 프로세스가 없는지 운영자에게 확인을 부탁한 뒤 정지를 해제해 주세요.');
    if (!desktop) expect(host.html()).not.toContain('작업 관리자');
    else expect(host.html()).not.toContain('운영자에게 확인을 부탁');
  });
});
afterEach(() => { hosts.forEach(host => host.dispose()); context.host = null; vi.unstubAllGlobals(); });

describe('stage 4 follow-up 3 switching exits', () => {
  const modes = [['desktop', 'win32'], ['server', 'win32'], ['desktop', 'web']] as const;

  it.each(modes)('S4-37-switching. %s / %s names the pending holder without unavailable seat-change exits', async (mode, platform) => {
    snap.auth.mode = mode; window.wook!.platform = platform;
    snap.auth.loggedIn = true; snap.seat.state = 'switching'; snap.seat.unresponsiveSince = snap.generatedAt;
    snap.seat.pendingHolder = { kind: 'external', agentId: 'X-NEXT', label: '인계받을 AI' };
    const host = await mount(() => SeatUnresponsive({ snapshot: snap, stop: noop }));
    expect(host.html()).toContain('메인 자리를 인계받을 AI에게 넘기고 있습니다.');
    expect(host.html()).not.toContain('운영 설정');
    expect(host.html()).not.toContain('서버 PC의 운영자');
    expect(host.html()).not.toContain('자리를 바꾸는 것은');
    expect(host.html()).not.toContain('정지 해제');
    expect(elements(host.tree).filter(node => node.type === 'button').map(node => textOf(node.props.children))).toEqual(['메인 에이전트에게 말하기', '긴급 정지']);
  });

  it.each(modes)('S4-37-held-switching. %s / %s points to the existing release path for an M-MAIN pause', async (mode, platform) => {
    snap.auth.mode = mode; window.wook!.platform = platform;
    snap.auth.loggedIn = true; snap.seat.state = 'switching'; snap.seat.unresponsiveSince = snap.generatedAt;
    snap.seat.pendingHolder = { kind: 'launched', label: 'Codex CLI', ai: { kind: 'codex', model: 'gpt-6-sol', effortTier: 'high', effortOverride: null } };
    snap.stop.global.active = false;
    snap.stop.pausedMembers = [{ memberId: 'M-MAIN', by: 'system', mode: 'graceful', since: snap.generatedAt, reason: '교체를 마치기 전에 종료 확인이 필요합니다.' }];
    const host = await mount(() => SeatUnresponsive({ snapshot: snap, stop: noop }));
    expect(host.html()).toContain('메인 자리를 Codex CLI에게 넘기고 있습니다.');
    expect(host.html()).toContain('교체가 보류되어 있습니다. 메인 에이전트 정지 안내에서 정지 해제를 눌러 주세요.');
    expect(host.html()).not.toContain('운영 설정');
    expect(host.html()).not.toContain('서버 PC의 운영자');
    expect(elements(host.tree).filter(node => node.type === 'button').map(node => textOf(node.props.children))).toEqual(['메인 에이전트에게 말하기', '긴급 정지']);
    const notice = await mount(() => MainPauseNotice({ snapshot: snap }));
    await click(notice, '정지 해제');
    expect(requests.filter(request => request.method === 'stop.release')).toHaveLength(1);
    snap.stop.pausedMembers = [];
    await host.render(() => SeatUnresponsive({ snapshot: snap, stop: noop }));
    expect(host.html()).not.toContain('정지 해제');
  });

  it('S4-37-switching-pause. another member pause does not make the swap held', async () => {
    snap.auth.loggedIn = true; snap.seat.state = 'switching'; snap.seat.unresponsiveSince = snap.generatedAt;
    snap.seat.pendingHolder = { kind: 'external', agentId: 'X-NEXT', label: '다음 AI' };
    snap.stop.pausedMembers = [{ memberId: 'M-0016', by: 'system', mode: 'graceful', since: snap.generatedAt, reason: '팀원 정지' }];
    const host = await mount(() => SeatUnresponsive({ snapshot: snap, stop: noop }));
    expect(host.html()).toContain('메인 자리를 다음 AI에게 넘기고 있습니다.');
    expect(host.html()).not.toContain('정지 해제');
  });
});

describe('owner permission UI', () => {
  it('F1. mock off has exact calls, disappears after success, and is absent remotely', async () => {
    installation.developer.mainAgentMock = true;
    snap.projects.forEach((p, i) => { p.mock.enabled = i === 0; });
    const render = () => SettingsScreen({ snapshot: snap, section: 'account', setSection: noop, logout: noop, openTask: noop });
    const host = await mount(render);
    const offButtons = () => elements(host.tree).filter(e => e.type === 'button' && textOf(e.props.children) === '모의 실행 끄기');
    expect(offButtons()).toHaveLength(2);
    expect(host.html()).not.toContain('모의 실행 켜기');
    await offButtons()[0].props.onClick?.(); await host.render(render);
    expect(requests).toContainEqual({ method: 'settings.update', args: [{ developer: { mainAgentMock: false } }] });
    expect(offButtons()).toHaveLength(1);
    await offButtons()[0].props.onClick?.(); await host.render(render);
    expect(requests).toContainEqual({ method: 'projects.setMock', args: [snap.projects[0].id, { enabled: false }] });
    expect(offButtons()).toHaveLength(0);
    expect(host.html()).toContain('모의 실행을 껐습니다. 다음 턴부터 실제 AI CLI로 실행됩니다.');
    installation.developer.mainAgentMock = true; window.wook!.platform = 'web';
    const remote = await mount(render);
    expect(elements(remote.tree).filter(e => e.type === 'button' && textOf(e.props.children) === '모의 실행 끄기')).toHaveLength(0);
  });
  it('F2. model limits appear on Home and operations without blocking the AI kind', async () => {
    snap.ai.forEach(ai => { ai.blocked = false; ai.authRequired = false; ai.problem = null; ai.usageLimitedUntil = null; });
    snap.ai[0].modelLimits = [{ family: 'opus', label: '데이터에서 온 모델', until: '2026-11-03T12:35:00Z' }];
    const home = await mount(() => Home({ snapshot: snap, openProject: noop, openTask: noop, openReport: noop, openMember: noop, openPolicy: noop }));
    const operations = await mount(() => SettingsScreen({ snapshot: snap, section: 'policy', setSection: noop, logout: noop, openTask: noop }));
    for (const host of [home, operations]) {
      expect(host.html()).toContain('데이터에서 온 모델 주간 한도');
      expect(host.html()).toContain('데이터에서 온 모델 모델의 턴만 쉽니다');
      expect(host.html()).not.toContain('새 턴 실행이 막혔습니다');
    }
    const account = await mount(() => SettingsScreen({ snapshot: snap, section: 'account', setSection: noop, logout: noop, openTask: noop }));
    expect(account.html()).toContain('결제 방식을 바꾸거나 API 키 방식에서 키를 새로 등록하면, 걸려 있던 사용량 한도를 지우고 한 번 다시 시도합니다.');
  });
  it('F4. report eligibility controls button, quote and open modal after refresh', async () => {
    report.status = 'read'; report.canRequestChanges = true;
    const render = () => Documents({ snapshot: snap, selectedId: report.id, setSelectedId: noop });
    const host = await mount(render); click(host, '수정 요청'); await host.render(render);
    expect(host.html()).toContain('수정 요청 보내기');
    report.canRequestChanges = false; snap.version++;
    snap.directives.find(d => d.id === report.directiveId)!.state = 'cancelled';
    await host.render(render);
    expect(host.html()).not.toContain('수정 요청 보내기');
    expect(elements(host.tree).filter(e => e.type === 'button' && textOf(e.props.children).trim() === '수정 요청')).toHaveLength(0);
    expect(host.html()).toContain('지시가 이미 끝나 이 보고서에는 수정 요청을 할 수 없습니다. 바꿀 것이 있으면 명령창으로 메인 에이전트에게 말해 주세요.');
    snap.directives = snap.directives.filter(d => d.id !== report.directiveId); snap.version++; await host.render(render);
    expect(host.html()).toContain('지시가 이미 끝나 이 보고서에는 수정 요청을 할 수 없습니다.');
    report.canRequestChanges = undefined; snap.version++; await host.render(render);
    expect(host.html()).toContain('수정 요청');
  });
  it('F4-conflict. request conflict is shown verbatim even when eligibility changed on the server', async () => {
    report.status = 'read'; report.canRequestChanges = true;
    const render = () => Documents({ snapshot: snap, selectedId: report.id, setSelectedId: noop });
    const host = await mount(render); click(host, '수정 요청'); await host.render(render);
    elements(host.tree).find(e => e.type === 'textarea')?.props.onChange?.({ target: { value: '문구 수정', checked: false } });
    await host.render(render);
    const previous = window.wook!.invoke;
    window.wook!.invoke = async (method, ...args) => {
      if (method === 'reports.requestChanges') throw { code: 'conflict', message: '서버 원문: 이미 새 회차가 열렸습니다. R-0001 / 유지' };
      return previous(method, ...args);
    };
    click(host, '수정 요청 보내기'); await host.render(render);
    expect(host.html()).toContain('서버 원문: 이미 새 회차가 열렸습니다. R-0001 / 유지');
  });
  it('F5. operating ranges are read-only and null turns mean unlimited', async () => {
    installation.execution.claudeMaxTurns = null;
    const host = await mount(() => SettingsScreen({ snapshot: snap, section: 'execution', setSection: noop, logout: noop, openTask: noop }));
    expect(host.html()).toContain('<dt>Claude 최대 턴 수</dt><dd>제한 없음<small'); expect(host.html()).toContain('2~32개'); expect(host.html()).toContain('5~1440분');
    expect(elements(host.tree).filter(e => ['input', 'select', 'textarea'].includes(String(e.type)))).toHaveLength(0);
    const general = await mount(() => SettingsScreen({ snapshot: snap, section: 'general', setSection: noop, logout: noop, openTask: noop }));
    expect(general.html()).toContain('1~365개');
  });
  it('F6-7. re-login guidance names installation settings and owner email is plain text', async () => {
    snap.ownerTodos = [{ kind: 'auth_required', id: 'auth-test', aiKind: 'claude', since: snap.generatedAt }];
    const home = await mount(() => Home({ snapshot: snap, openProject: noop, openTask: noop, openReport: noop, openMember: noop, openPolicy: noop }));
    expect(home.html()).toContain('API 키 방식이면 설치 설정에서 키를 다시 등록하세요. 재로그인 필요 상태가 해제됩니다.');
    const account = await mount(() => SettingsScreen({ snapshot: snap, section: 'account', setSection: noop, logout: noop, openTask: noop }));
    expect(account.html()).toContain('class="readonly-account"');
    expect(account.html()).toContain('이 화면에서는 바꿀 수 없습니다.');
    expect(account.html()).not.toMatch(/<input[^>]*readOnly/);
  });
  it('1. member has instructions and a project command shortcut, with no operations', async () => {
    const draft = vi.fn(); const off = subscribeCommand(draft);
    const host = await mount(() => MemberPanel({ id: member.member.id, snapshot: snap, close: noop, openTask: noop }));
    const html = host.html();
    expect(html).toContain('메인 에이전트 긴급 지시'); expect(html).toContain('메인 에이전트 지시 → 하늘 (공유)');
    expect(html).not.toMatch(/대표 고정|설정 변경|대표 직접 메시지|팀원 삭제|>재개<|>중단<|>일시정지</);
    click(host, '메인 에이전트에게 말하기');
    expect(draft).toHaveBeenCalledWith({ target: member.member.projectId, text: `${member.member.id} ${member.member.name}(${member.member.roleName})에 대해: ` }); off();
  });
  it('2. main pause can be released without an emergency, with the reason and process check', async () => {
    snap.stop.global.active = false;
    snap.stop.pausedMembers.push({ memberId: 'M-MAIN', by: 'system', mode: 'graceful', since: snap.generatedAt, reason: '종료를 확인하지 못했습니다.' });
    const host = await mount(() => MainPauseNotice({ snapshot: snap, openMember: noop }));
    expect(host.html()).toContain('메인 에이전트가 정지했습니다.'); expect(host.html()).toContain('종료를 확인하지 못했습니다.');
    expect(host.html()).toContain('남아 있는 프로세스가 없는지 먼저 확인');
    await click(host, '정지 해제');
    expect(requests.some(request => request.method === 'stop.release')).toBe(true);
    expect(releaseNotice(3)).toBe('새 실행을 시작할 수 있습니다. 보류된 작업 3건은 메인 에이전트가 확인해 항목별로 재개합니다');
  });
  it('2. member detail and home todos both expose the main pause reason and release', async () => {
    member.member = snap.members.find(item => item.isMain)!;
    member.member.status = 'paused';
    member.member.statusReasons = ['이전 프로세스 종료를 확인하지 못했습니다.'];
    snap.stop.pausedMembers.push({ memberId: member.member.id, mode: 'graceful', by: 'system', since: snap.generatedAt, reason: member.member.statusReasons[0] });
    const panel = await mount(() => MemberPanel({ id: member.member.id, snapshot: snap, close: noop, openTask: noop }));
    const home = await mount(() => Home({ snapshot: snap, openProject: noop, openTask: noop, openReport: noop, openMember: noop, openPolicy: noop }));
    for (const host of [panel, home]) {
      expect(host.html()).toContain('메인 에이전트가 정지했습니다.');
      expect(host.html()).toContain('이전 프로세스 종료를 확인하지 못했습니다.');
      expect(host.html()).toContain('정지 해제');
    }
  });
  it('3. studio keeps member facts and project settings as views and opens a project command', async () => {
    const draft = vi.fn(); const off = subscribeCommand(draft);
    const host = await mount(() => Studio({ snapshot: snap, project: snap.projects[0], back: noop, openMember: noop, openTask: noop, openDirective: noop, openReport: noop }));
    const buttons = elements(host.tree).filter(element => element.type === 'button').map(element => textOf(element.props.children).trim());
    expect(buttons).not.toContain('팀원 추가'); expect(buttons).not.toContain('일시정지'); expect(buttons).not.toContain('재개');
    expect(host.html()).not.toContain('대표 고정');
    click(host, '메인 에이전트에게 말하기'); expect(draft).toHaveBeenCalledWith({ target: snap.projects[0].id, text: `${snap.projects[0].name}에 대해: ` }); off();
  });
  it('4. home project creation opens a main draft and authentication recheck remains callable', async () => {
    const draft = vi.fn(); const off = subscribeCommand(draft);
    const host = await mount(() => Home({ snapshot: snap, openProject: noop, openTask: noop, openReport: noop, openMember: noop, openPolicy: noop }));
    expect(host.html()).not.toContain('대표 검수');
    const recoveryTodo = elements(host.tree).find(node => isValidElement<{ todo?: OwnerTodo }>(node) && node.props.todo?.kind === 'recovery_check');
    expect(recoveryTodo).toBeDefined();
    const recoveryHtml = renderToStaticMarkup(recoveryTodo);
    expect(recoveryHtml).toContain('<strong>메인 에이전트가 처리 중</strong>');
    expect(recoveryHtml).not.toContain('이 보류는 메인 에이전트에게 따로 전해지지 않습니다.');
    click(host, '프로젝트 만들기 요청'); expect(draft).toHaveBeenCalledWith({ target: 'main', text: '새 프로젝트를 만들어 줘: ' });
    const recheck = elements(host.tree).filter(element => typeof element.type === 'function' && 'todo' in element.props);
    // Render the actual todo component to exercise its button, not a duplicate switch in the test.
    const auth = recheck.find(element => 'todo' in element.props && (element.props.todo as { kind: string }).kind === 'auth_required')!;
    const todoHost = await mount(() => (auth.type as (props: Props) => ReactNode)(auth.props));
    click(todoHost, '다시 확인');
    expect(requests.some(request => request.method === 'system.recheckAi')).toBe(true); off();
  });
  it('5. task shows main review and hold guidance without verdict or operation buttons', async () => {
    task.task.hold = { returnState: 'in_review', reasons: [{ kind: 'error', refId: 'rejudge', label: '다시 판정 실패', note: '검수 확인 필요', since: snap.generatedAt }] };
    const draft = vi.fn(); const off = subscribeCommand(draft);
    const host = await mount(() => TaskDetail({ id: task.task.id, snapshot: snap, close: noop, openDirective: noop, openTask: noop }));
    expect(host.html()).toContain('메인 에이전트 검수 중'); expect(host.html()).toContain('다시 판정을 받을지, 등록한 통과로 이어 갈지');
    expect(host.html()).not.toMatch(/검수 등록|검수 결과<select|검수자에게 메시지 보내기|>재개<|>중단<|>작업 취소<|>취소</);
    click(host, '메인 에이전트에게 말하기'); expect(draft).toHaveBeenCalledWith({ target: task.task.projectId, text: `${task.task.id} "${task.task.title}"에 대해: ` }); off();
  });
  it('S2-3. home respects reachesMain before legacy text and opens the held task draft', async () => {
    const draft = vi.fn(); const off = subscribeCommand(draft);
    const muted = '이 보류는 메인 에이전트에게 따로 전해지지 않습니다. 필요한 조치는 명령창으로 메인 에이전트에게 알려 주세요.';
    const error: Extract<OwnerTodo, { kind: 'error' }> = { kind: 'error', id: 'test-error', memberId: null,
      taskId: task.task.id, projectId: task.task.projectId, message: '서버의 새 보류 설명', since: snap.generatedAt };
    const cases: { todo: OwnerTodo; label: string; muted: boolean }[] = [
      { todo: { ...error, reachesMain: true }, label: '메인 에이전트가 처리 중', muted: false },
      { todo: { ...error, reachesMain: false, message: '검수자 없음 — 이 글보다 필드가 우선' }, label: '보류된 작업', muted: true },
      { todo: { ...error, message: '검수자 없음 — 검수자 배정 대기' }, label: '메인 에이전트가 처리 중', muted: false },
      { todo: error, label: '보류된 작업', muted: true },
      { todo: { kind: 'recovery_check', id: 'recovery', requestId: 'RQ-test', taskId: task.task.id,
        projectId: task.task.projectId, message: '병합 결과 확인 필요', since: snap.generatedAt }, label: '복구 확인 필요', muted: true },
      ...([true, false] as const).map(reachesMain => ({ todo: { kind: 'recovery_check' as const, id: 'recovery-new', requestId: 'RQ-test', taskId: task.task.id,
        projectId: task.task.projectId, message: '명령창으로 메인 에이전트에게 알려 주세요.', since: snap.generatedAt, reachesMain },
        label: reachesMain ? '메인 에이전트가 처리 중' : '복구 확인 필요', muted: !reachesMain })),
    ];
    try {
      for (const entry of cases) {
        snap.ownerTodos = [entry.todo];
        const home = await mount(() => Home({ snapshot: snap, openProject: noop, openTask: noop, openReport: noop, openMember: noop, openPolicy: noop }));
        expect(home.html()).toContain(`<strong>${entry.label}</strong>`);
        expect(home.html().includes(muted)).toBe(entry.muted);
        const element = elements(home.tree).find(value => typeof value.type === 'function' && 'todo' in value.props);
        expect(element).toBeDefined();
        const todo = await mount(() => typeof element?.type === 'function' ? Reflect.apply(element.type, undefined, [element.props]) : null);
        click(todo, '메인 에이전트에게 말하기');
        expect(draft).toHaveBeenLastCalledWith({ target: task.task.projectId, text: `${task.task.id} "${task.task.title}"에 대해: ` });
        expect(todo.html()).not.toMatch(/>재개<|>재시도<|>작업 취소</);
      }
      snap.ownerTodos = [{ ...error, taskId: 'T-9999' }];
      const home = await mount(() => Home({ snapshot: snap, openProject: noop, openTask: noop, openReport: noop, openMember: noop, openPolicy: noop }));
      const element = elements(home.tree).find(value => typeof value.type === 'function' && 'todo' in value.props);
      const todo = await mount(() => typeof element?.type === 'function' ? Reflect.apply(element.type, undefined, [element.props]) : null);
      click(todo, '메인 에이전트에게 말하기');
      expect(draft).toHaveBeenLastCalledWith({ target: task.task.projectId, text: 'T-9999에 대해: ' });
    } finally { off(); }
  });
  it('S3-1. emergency holds distinguish undelivered lists and open a direct main draft', async () => {
    const draft = vi.fn(); const off = subscribeCommand(draft);
    const muted = '이 보류 목록은 메인 에이전트에게 전해지지 않았습니다. 필요한 조치는 명령창으로 메인 에이전트에게 알려 주세요.';
    const held: Extract<OwnerTodo, { kind: 'emergency_held' }> = {
      kind: 'emergency_held', id: 'test-held', count: 3, since: snap.generatedAt,
    };
    const cases = [
      { ...held, reachesMain: false },
      { ...held, reachesMain: true },
      held,
    ];
    try {
      for (const entry of cases) {
        snap.ownerTodos = [entry];
        const home = await mount(() => Home({ snapshot: snap, openProject: noop, openTask: noop, openReport: noop, openMember: noop, openPolicy: noop }));
        const html = home.html();
        if (entry.reachesMain === false) {
          expect(html).toContain('<strong>보류된 작업 3건</strong>');
          expect(html).toContain(`<p class="muted">${muted}</p>`);
          expect(html).not.toContain('메인 에이전트가 확인해 항목별로 재개합니다.');
        } else {
          expect(html).toContain('<strong>보류 작업</strong>');
          expect(html).toContain('3건의 보류 작업은 메인 에이전트가 확인해 항목별로 재개합니다.');
          expect(html).not.toContain(muted);
        }
        const element = elements(home.tree).find(value => typeof value.type === 'function' && 'todo' in value.props);
        expect(element).toBeDefined();
        const todo = await mount(() => typeof element?.type === 'function' ? Reflect.apply(element.type, undefined, [element.props]) : null);
        expect(todo.html()).not.toMatch(/>재개<|>재시도<|>작업 취소</);
        if (entry.reachesMain === false) {
          expect(requests).toEqual([]);
          click(todo, '메인 에이전트에게 말하기');
          expect(draft).toHaveBeenLastCalledWith({ target: 'main', text: '긴급 정지로 보류된 작업에 대해: ' });
          expect(requests).toEqual([]);
        }
      }
    } finally { off(); }
  });
  it('S3-2. explicit false wins over a no-reviewer error message', async () => {
    snap.ownerTodos = [{ kind: 'error', id: 'dropped-no-reviewer', memberId: null,
      taskId: task.task.id, projectId: task.task.projectId, reachesMain: false,
      message: '검수자 없음 — 메인 에이전트에게 전달할 업무가 중단됐습니다.', since: snap.generatedAt }];
    const home = await mount(() => Home({ snapshot: snap, openProject: noop, openTask: noop, openReport: noop, openMember: noop, openPolicy: noop }));
    expect(home.html()).toContain('<strong>보류된 작업</strong>');
    expect(home.html()).not.toContain('메인 에이전트가 처리 중');
    expect(home.html()).toContain('이 보류는 메인 에이전트에게 따로 전해지지 않습니다. 필요한 조치는 명령창으로 메인 에이전트에게 알려 주세요.');
  });
  it('S2-4. task hold hints use structured fields and the exact S1F8 guidance', async () => {
    const general = '이 보류는 메인 에이전트에게 따로 전해지지 않습니다. 원인이 정리되면 명령창으로 메인 에이전트에게 알려 주세요. 메인 에이전트가 확인하고 이어 갑니다.';
    const rejudge = '이 보류는 메인 에이전트에게 따로 전해지지 않습니다. 다시 판정을 받을지, 등록한 통과로 이어 갈지 명령창으로 메인 에이전트에게 말해 주세요.';
    const automatic = '메인 에이전트가 보류 사유를 확인하고 필요한 조치를 마친 뒤 작업을 재개합니다.';
    const checkPrefix = '이 보류는 메인 에이전트에게 따로 전해지지 않습니다. 남은 프로세스가 정리되면 명령창으로 메인 에이전트에게 알려 주세요. ';
    const reason: HoldReasonView = { kind: 'error', scope: 'task', refId: 'different', label: '다시 판정 실패',
      note: '다시 판정 못 함: 같은 문구가 있어도 종류와 참조를 따릅니다.', since: snap.generatedAt };
    const run: CheckRunView = { requestId: 'RQ-test', command: 'npm test', state: 'unknown', startedAt: snap.generatedAt,
      endedAt: null, exitCode: null, timedOut: false, remaining: -1, ownerConfirmedAt: null, leftFiles: [] };
    const cases: { reason: HoldReasonView; hint: string; runs?: CheckRunView[] }[] = [
      { reason, hint: general },
      { reason: { ...reason, kind: 'merge_blocked' }, hint: general },
      { reason: { ...reason, kind: 'recovery_check' }, hint: general },
      { reason: { ...reason, refId: 'rejudge', label: '새 이름', note: '서버가 바꾼 새 설명' }, hint: rejudge },
      { reason: { ...reason, refId: 'RQ-test' }, runs: [run], hint: checkPrefix + '메인 에이전트가 재개하면 같은 버전일 때 기록된 검사 결과로 이어 갑니다.' },
      { reason: { ...reason, refId: 'RQ-test' }, runs: [{ ...run, leftFiles: ['dist/index.js'] }], hint: checkPrefix + '메인 에이전트가 재개해도 검사에서 남긴 파일이 그대로면 제출을 거부하고 담당에게 정리를 맡깁니다.' },
      { reason: { ...reason, refId: 'RQ-test', scope: 'member' }, runs: [run], hint: general },
      { reason: { ...reason, refId: 'no_reviewer' }, hint: automatic },
      ...(['error', 'merge_blocked', 'recovery_check'] satisfies HoldReasonView['kind'][]).flatMap(kind => [
        { reason: { ...reason, kind, reachesMain: true }, hint: '메인 에이전트가 처리 중' },
        { reason: { ...reason, kind, reachesMain: false }, hint: general },
      ]),
      { reason: { ...reason, refId: 'no_reviewer', reachesMain: false }, hint: general },
      { reason: { ...reason, refId: 'rejudge', reachesMain: true }, hint: '메인 에이전트가 처리 중' },
      { reason: { ...reason, refId: 'RQ-test', reachesMain: true }, runs: [run], hint: '메인 에이전트가 처리 중' },
      ...(['emergency_stop', 'paused', 'interrupted', 'answer_wait', 'replan', 'blocked', 'prereq_cancelled'] satisfies HoldReasonView['kind'][]).map(kind => ({ reason: { ...reason, kind }, hint: automatic })),
    ];
    for (const entry of cases) {
      task.task.hold = { returnState: 'in_review', reasons: [entry.reason] }; task.checkRuns = entry.runs ?? [];
      const host = await mount(() => TaskDetail({ id: task.task.id, snapshot: snap, close: noop, openDirective: noop, openTask: noop }));
      expect(host.html()).toContain(`<p class="hold-hint">${entry.hint}</p>`);
      expect(host.html()).not.toMatch(/>재개<|>재시도<|>검수 등록</);
    }
  });
  it('S5-home-group. main items and operational warnings stay outside the owner count, with one unique key per row', async () => {
    snap.stop.pausedMembers = []; snap.stop.global.active = false;
    const ownerItems = snap.ownerTodos.filter(todo => todo.kind === 'question' || todo.kind === 'unread_report');
    const error: Extract<OwnerTodo, { kind: 'error' }> = { kind: 'error', id: 'error:one-task', memberId: null, taskId: task.task.id, projectId: task.task.projectId,
      message: '첫 번째 보류 사유', since: snap.generatedAt, reachesMain: true };
    snap.ownerTodos = [...ownerItems, error, { ...error, message: '두 번째 보류 사유' },
      { ...error, id: 'dropped', reachesMain: false },
      { kind: 'recovery_check', id: 'recovery', requestId: 'RQ-test', projectId: null, taskId: null, message: '복구 확인', since: snap.generatedAt, reachesMain: true },
      { kind: 'auth_required', id: 'auth', aiKind: 'codex', since: snap.generatedAt }];
    const render = () => Home({ snapshot: snap, openProject: noop, openTask: noop, openReport: noop, openMember: noop, openPolicy: noop });
    const host = await mount(render);
    expect(host.html()).toContain(`<span class="todo-number">${ownerItems.length}</span>`);
    const main = elements(host.tree).find(node => node.props.title === '메인 에이전트가 처리 중');
    const representative = elements(host.tree).find(node => node.props.title === '대표 할 일');
    const rows = elements(host.tree).filter(node => 'todo' in node.props);
    expect(rows).toHaveLength(snap.ownerTodos.length);
    expect(new Set(rows.map(node => node.key)).size).toBe(rows.length);
    expect(elements(main).filter(node => 'todo' in node.props)).toHaveLength(3);
    expect(elements(representative).filter(node => 'todo' in node.props)).toHaveLength(ownerItems.length);
    snap.stop.pausedMembers = [{ memberId: 'M-MAIN', since: snap.generatedAt, by: 'system', mode: 'immediate', reason: '종료 확인 필요' }];
    await host.render(render);
    expect(host.html()).toContain(`<span class="todo-number">${ownerItems.length + 1}</span>`);
    snap.stop.global.active = true;
    snap.ownerTodos.push({ kind: 'emergency_held', id: 'stop-1', count: 2, reachesMain: false, since: snap.generatedAt },
      { kind: 'emergency_held', id: 'stop-legacy', count: 1, since: snap.generatedAt });
    await host.render(render);
    expect(host.html()).toContain(`<span class="todo-number">${ownerItems.length + 1}</span>`);
  });
  it('S5-history. current delivery precedes an expandable, unchanged historical exit in home and task detail', async () => {
    const note = '예전 기록입니다. 명령창으로 메인 에이전트에게 알려 주세요.';
    const reason: HoldReasonView = { kind: 'merge_blocked', label: '병합 보류', reachesMain: true, note, since: snap.generatedAt };
    task.task.hold = { returnState: 'in_review', reasons: [reason] };
    snap.ownerTodos = [{ kind: 'error', id: 'history', taskId: task.task.id, projectId: task.task.projectId, memberId: null, message: note, since: snap.generatedAt, reachesMain: true }];
    const home = await mount(() => Home({ snapshot: snap, openProject: noop, openTask: noop, openReport: noop, openMember: noop, openPolicy: noop }));
    const detail = await mount(() => TaskDetail({ id: task.task.id, snapshot: snap, close: noop, openDirective: noop, openTask: noop }));
    for (const host of [home, detail]) {
      const html = host.html();
      expect(html).toMatch(/<details class="hold-history"><summary>보류 당시 기록/);
      expect(html).toContain(`<p>${note}</p>`);
      expect(html.indexOf('메인 에이전트가 처리 중')).toBeLessThan(html.indexOf('<details'));
      const current = html.replace(/<details[\s\S]*?<\/details>/g, '');
      expect(current).not.toContain('명령창으로 메인 에이전트에게 알려 주세요');
      expect(current).not.toContain('따로 전해지지 않습니다');
    }
  });
  it('S5-mixed. each hold reason shows its own current state', async () => {
    const reason: HoldReasonView = { kind: 'merge_blocked', label: '전달된 병합 보류', reachesMain: true, note: '기록', since: snap.generatedAt };
    task.task.hold = { returnState: 'in_review', reasons: [reason, { ...reason, label: '중단된 복구 알림', kind: 'recovery_check', reachesMain: false }] };
    const host = await mount(() => TaskDetail({ id: task.task.id, snapshot: snap, close: noop, openDirective: noop, openTask: noop }));
    const reasons = elements(host.tree).filter(node => node.props.className === 'hold-reason');
    expect(reasons).toHaveLength(2);
    expect(textOf(reasons[0])).toContain('메인 에이전트가 처리 중');
    expect(textOf(reasons[0])).not.toContain('명령창으로');
    expect(textOf(reasons[1])).toContain('명령창으로 메인 에이전트에게 알려 주세요');
    expect(textOf(reasons[1])).not.toContain('처리 중');
  });
  it('S5-roles-refresh. snapshot changes refresh created, updated and deleted roles without changing sections', async () => {
    listedRoles = [];
    const render = () => SettingsScreen({ snapshot: snap, section: 'team', setSection: noop, logout: noop, openTask: noop });
    const host = await mount(render);
    const sound = roles.find(role => role.id === 'sound')!;
    expect(host.html()).not.toContain(`<strong>${sound.name}</strong>`);
    listedRoles = [structuredClone(sound)]; snap.version++; await host.render(render);
    expect(host.html()).toContain('<strong>사운드</strong>');
    listedRoles[0].name = '음원 담당'; snap.version++; await host.render(render);
    expect(host.html()).toContain('<strong>음원 담당</strong>');
    expect(host.html()).not.toContain('<strong>사운드</strong>');
    listedRoles = []; snap.version++; await host.render(render);
    expect(host.html()).not.toContain('<strong>음원 담당</strong>');
    expect(requests.filter(request => request.method === 'roles.list')).toHaveLength(4);
    expect(requests.some(request => /^roles\.(create|update|delete)$/.test(request.method))).toBe(false);
  });
  it('S5-creators. read-only creator tags cover every recorded actor and omit absent values', async () => {
    const sound = roles.find(role => role.id === 'sound')!;
    listedRoles = [
      { ...sound, id: 'seed', createdBy: 'seed' }, { ...sound, id: 'owner', createdBy: 'owner' },
      { ...sound, id: 'main', createdBy: 'main' }, { ...sound, id: 'operator', createdBy: 'operator' },
      { ...sound, id: 'legacy', createdBy: undefined },
    ];
    const host = await mount(() => SettingsScreen({ snapshot: snap, section: 'team', setSection: noop, logout: noop, openTask: noop }));
    const section = elements(host.tree).find(node => node.props.title === '역할 정의');
    const tags = elements(section).filter(node => node.props.className === 'role-creator');
    expect(tags.map(textOf)).toEqual(['기본', '대표(예전)', '메인 에이전트', '운영자']);
    expect(elements(section).some(node => ['input', 'textarea', 'select', 'button'].includes(String(node.type)))).toBe(false);
    expect(textOf(section)).toContain('담당 유형: 에셋, 조사');
  });
  it('S5-asset. the fake artifact task displays the asset label and its stored output', async () => {
    const { fakeBridge } = await import('../api/fake');
    task = await fakeBridge.invoke('tasks.get', 'T-0015');
    expect(task.task.type).toBe('asset'); expect(task.task.outputMode).toBe('artifact');
    expect(task.diff).toBeNull();
    const host = await mount(() => TaskDetail({ id: task.task.id, snapshot: snap, close: noop, openDirective: noop, openTask: noop }));
    expect(host.html()).toContain('에셋 · 보통');
    expect(host.html()).toContain('보관된 산출물');
    expect(host.html()).toContain('wiki-guide.wav');
    expect(host.html()).toContain('waveform.png');
  });
  it('S5-main-activity. studio names M-MAIN without project membership and keeps the project filter', async () => {
    const project = snap.projects[1];
    snap.members = snap.members.filter(member => member.id !== 'M-MAIN');
    const base = snap.recentActivity[0];
    snap.recentActivity = [
      { ...base, seq: 10001, memberId: 'M-MAIN', projectId: project.id, actorName: '알 수 없는 팀원', text: '이 프로젝트의 병합 확인' },
      { ...base, seq: 10002, memberId: 'M-MAIN', projectId: snap.projects[0].id, actorName: '알 수 없는 팀원', text: '다른 프로젝트 활동' },
    ];
    const host = await mount(() => Studio({ snapshot: snap, project, back: noop, openMember: noop, openTask: noop, openDirective: noop, openReport: noop }));
    const timeline = elements(host.tree).find(node => node.props.title === '활동 타임라인');
    expect(textOf(timeline)).toContain('메인 에이전트');
    expect(textOf(timeline)).toContain('이 프로젝트의 병합 확인');
    expect(textOf(timeline)).not.toContain('알 수 없는 팀원');
    expect(textOf(timeline)).not.toContain('다른 프로젝트 활동');
  });
  it('S5-policy. settings explains where to check delivery without promising that every hold is handled', async () => {
    const host = await mount(() => SettingsScreen({ snapshot: snap, section: 'policy', setSection: noop, logout: noop, openTask: noop }));
    expect(host.html()).toContain('각 작업의 보류 사유에서 전달 상태를 확인하세요.');
    expect(host.html()).toContain('홈에서 복구 항목의 전달 상태를 확인하세요.');
    expect(host.html()).not.toContain('메인 에이전트가 실행 결과를 확인하고 처리합니다.');
  });
  it('S2-5. installation offers only subscription and API key for both AIs', async () => {
    const host = await mount(() => SettingsScreen({ snapshot: snap, section: 'account', setSection: noop, logout: noop, openTask: noop }));
    const selects = elements(host.tree).filter(value => value.type === 'select' && elements(value.props.children).some(option => option.type === 'option' && option.props.value === 'subscription'));
    expect(selects).toHaveLength(2);
    for (const select of selects) {
      expect(elements(select.props.children).filter(value => value.type === 'option').map(option => ({ value: option.props.value, text: textOf(option.props.children) }))).toEqual([
        { value: 'subscription', text: '구독' }, { value: 'api_key', text: 'API 키' },
      ]);
    }
  });
  it('6. report approval follows canApprove, including changes requested, with legacy fallback', async () => {
    const props = { snapshot: snap, selectedId: report.id, setSelectedId: noop };
    const host = await mount(() => Documents(props));
    expect(elements(host.tree).some(element => element.type === 'button' && textOf(element.props.children).includes('결과 승인'))).toBe(true);
    click(host, '결과 승인'); await host.render(() => Documents(props));
    expect(host.html()).toContain('aria-label="결과 승인"');
    report.canApprove = false; snap.version += 1;
    await host.render(() => Documents(props));
    expect(host.html()).not.toContain('aria-label="결과 승인"');
    for (const [status, flag, expected] of [['read', false, false], ['approved', true, true], ['changes_requested', undefined, false], ['read', undefined, true]] as const) {
      report.status = status; report.canApprove = flag;
      const next = await mount(() => Documents(props));
      expect(elements(next.tree).some(element => element.type === 'button' && textOf(element.props.children).includes('결과 승인'))).toBe(expected);
    }
  });
  it('6. requestChanges sends feedback to main and promises no automatic round', async () => {
    report.status = 'read';
    const render = () => Documents({ snapshot: snap, selectedId: report.id, setSelectedId: noop });
    const host = await mount(render); click(host, '수정 요청'); await host.render(render);
    const textarea = elements(host.tree).find(element => element.type === 'textarea')!;
    textarea.props.onChange?.({ target: { value: '문구를 고쳐 주세요.', checked: false } }); await host.render(render);
    await click(host, '수정 요청 보내기'); await host.render(render);
    expect(host.html()).toContain('수정 요청을 메인 에이전트에게 보냈습니다. 다음 회차는 메인 에이전트가 엽니다.');
  });
  it('6. snapshot refresh updates approval eligibility without erasing a feedback draft', async () => {
    report.status = 'read';
    const render = () => Documents({ snapshot: snap, selectedId: report.id, setSelectedId: noop });
    const host = await mount(render); click(host, '수정 요청'); await host.render(render);
    elements(host.tree).find(element => element.type === 'textarea')?.props.onChange?.({ target: { value: '작성 중인 의견', checked: false } });
    report.canApprove = false; snap.version += 1;
    await host.render(render);
    expect(elements(host.tree).find(element => element.type === 'textarea')?.props.value).toBe('작성 중인 의견');
    expect(elements(host.tree).filter(element => element.type === 'button' && textOf(element.props.children).trim() === '결과 승인')).toHaveLength(0);
  });
  it('8. operations are views and installation save sends only permitted leaves', async () => {
    const props = { snapshot: snap, setSection: noop, logout: noop, openTask: noop };
    for (const section of ['team', 'execution', 'developer', 'skills', 'general', 'policy'] as const) {
      const host = await mount(() => SettingsScreen({ ...props, section }));
      expect(elements(host.tree).filter(element => element.type === 'input' || element.type === 'select' || element.type === 'textarea')).toHaveLength(0);
    }
    const host = await mount(() => SettingsScreen({ ...props, section: 'account' }));
    expect(host.html()).toContain('설치 설정 저장'); expect(host.html()).toContain('메인 에이전트 AI');
    await click(host, '설치 설정 저장');
    const patch = requests.find(request => request.method === 'settings.update')?.args[0];
    expect(patch).toEqual({ account: { googleClientId: settingsSeed.account.googleClientId, authMode: settingsSeed.account.authMode }, cli: settingsSeed.cli, policy: settingsSeed.policy, logs: { retentionDays: settingsSeed.logs.retentionDays }, general: { backup: { enabled: settingsSeed.general.backup.enabled }, launchAtLogin: settingsSeed.general.launchAtLogin } });
  });
  it('8. remote surface cannot submit installation changes', async () => {
    const bridge = window.wook!;
    bridge.platform = 'web';
    const host = await mount(() => SettingsScreen({ snapshot: snap, section: 'account', setSection: noop, logout: noop, openTask: noop }));
    expect(host.html()).not.toContain('Google 클라이언트 ID');
    expect(elements(host.tree).filter(element => element.type === 'button' && textOf(element.props.children) === '설치 설정 저장')).toHaveLength(0);
    expect(elements(host.tree).filter(element => element.type === 'fieldset')).toHaveLength(0);
  });
  it('1/4/5. command shortcut actually fills and opens the composer', async () => {
    const host = await mount(() => CommandBar({ snapshot: snap, currentProjectId: null }));
    const { openCommand } = await import('../lib/commands');
    openCommand('P-0001', 'T-0012 "검수"에 대해: ');
    await host.render(() => CommandBar({ snapshot: snap, currentProjectId: null }));
    expect(elements(host.tree).find(element => element.props['aria-label'] === '명령 입력')?.props.value).toBe('T-0012 "검수"에 대해: ');
    expect(elements(host.tree).find(element => element.props['aria-label'] === '명령 대상')?.props.value).toBe('P-0001');
    expect(host.html()).toContain('command-expanded');
  });
  it('11. every literal renderer invocation belongs to the desktop contract', () => {
    const allowed = new Set<string>([...DESKTOP_METHODS, 'system.recheckAi']);
    expect(rendererInvocations('src/renderer/src').filter(item => !allowed.has(item.method))).toEqual([]);
    expect(invokedMethods("call('members.pause', id); bridge.invoke(ok ? 'stop.release' : 'tasks.cancel');")).toEqual(['members.pause', 'stop.release', 'tasks.cancel']);
  });
  it('10. fake refuses every removed method and mixed installation patches without mutation', async () => {
    const { fakeBridge, FORBIDDEN_MESSAGE } = await import('../api/fake');
    const allowed = new Set<string>([...DESKTOP_METHODS, 'system.recheckAi']);
    for (const method of IPC_METHODS.filter(method => !allowed.has(method))) {
      await expect((fakeBridge.invoke as WookBridge['invoke'])(method)).rejects.toMatchObject({ code: 'forbidden', message: FORBIDDEN_MESSAGE });
    }
    const before = await fakeBridge.invoke('settings.get');
    await expect(fakeBridge.invoke('settings.update', { general: { backup: { enabled: true, keep: 99 } } })).rejects.toMatchObject({ code: 'forbidden' });
    expect(await fakeBridge.invoke('settings.get')).toEqual(before);
  });
});
