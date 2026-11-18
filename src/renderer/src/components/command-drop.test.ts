import { isValidElement, type ReactNode, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CommandBar } from './CommandBar';
import { snapshot } from '../api/fake/data';
import { createFakeWeb } from '../api/fake/web';
import type { WookBridge } from '../../../shared/ipc';
import { MAX_UPLOAD_BYTES } from '../lib/uploads';
import type { NotificationView } from '../../../shared/views';
import { openCommand, openConversation } from '../lib/commands';
import { mainReplyFixture } from '../api/fake/departments';
// @ts-expect-error Node is available in Vitest, outside the renderer environment.
import { readFileSync } from 'node:fs';

// Same lightweight React hook host as the existing renderer component tests.
// Real DOM, native text drags and focus are also checked by capture-command-drop.mjs.
const context = vi.hoisted(() => ({ host: null as Host | null, bridge: null as WookBridge | null }));
vi.mock('../api/bridge', () => ({ getBridge: () => context.bridge }));
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return { ...actual,
    useState: (init: unknown) => context.host ? context.host.state(init) : actual.useState(init),
    useRef: (init: unknown) => context.host ? context.host.state({ current: init })[0] : actual.useRef(init),
    useEffect: (fn: () => void | (() => void), deps?: unknown[]) => context.host ? context.host.effect(fn, deps) : actual.useEffect(fn, deps),
  };
});
type Slot = { value: unknown; deps?: unknown[]; cleanup?: () => void };
class Host {
  project: string | null = null; notices: NotificationView[] = [];
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
  async render() {
    for (let pass = 0; pass < 4; pass++) {
      this.index = 0; context.host = this;
      try { this.tree = CommandBar({ snapshot, currentProjectId: this.project, notifications: this.notices }); } finally { context.host = null; }
      this.effects.splice(0).forEach(effect => effect());
      for (let i = 0; i < 10; i++) await Promise.resolve();
    }
  }
  html() { return renderToStaticMarkup(this.tree); }
  dispose() { this.slots.forEach(slot => slot.cleanup?.()); }
}
type Props = {
  children?: ReactNode; className?: string; ref?: { current: unknown }; disabled?: boolean;
  onClick?: () => unknown; onChange?: (event: unknown) => void; onPaste?: (event: unknown) => void;
  onKeyDown?: (event: unknown) => void; onScroll?: () => void; hidden?: boolean; style?: Record<string, string>;
  inert?: boolean;
  'aria-label'?: string;
};
function nodes(node: ReactNode): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  return isValidElement<Props>(node) ? [node, ...nodes(node.props.children)] : [];
}
class TestNode extends EventTarget {
  children: TestNode[] = []; focus = vi.fn();
  contains(node: TestNode): boolean { return this === node || this.children.some(child => child.contains(node)); }
}
let host: Host, win: EventTarget, root: TestNode, area: TestNode, middle: TestNode, conversation: TestNode, input: TestNode;
let modalOpen: boolean;
let web: ReturnType<typeof createFakeWeb>;
let invoke: ReturnType<typeof vi.fn>;
const find = (label: string) => nodes(host.tree).find(node => node.props['aria-label'] === label)!;
const highlighted = () => host.html().includes('command-file-over');
const transfer = (files: File[] = []) => ({ types: ['Files'], items: files.map(file => ({ kind: 'file', getAsFile: () => file })), files, dropEffect: 'none' });
function drag(type: string, data = transfer(), target: TestNode = input, relatedTarget: TestNode | null = null) {
  const event = new Event(type, { cancelable: true });
  Object.defineProperties(event, { dataTransfer: { value: data }, target: { value: target }, relatedTarget: { value: relatedTarget } });
  win.dispatchEvent(event); return event;
}
beforeEach(async () => {
  vi.useFakeTimers(); win = new EventTarget(); root = new TestNode(); area = new TestNode(); input = new TestNode(); middle = new TestNode(); conversation = new TestNode();
  root.children.push(area, middle, conversation); area.children.push(input); modalOpen = false;
  vi.stubGlobal('Node', TestNode);
  vi.stubGlobal('window', { location: { search: '' }, addEventListener: win.addEventListener.bind(win), removeEventListener: win.removeEventListener.bind(win), dispatchEvent: win.dispatchEvent.bind(win) });
  vi.stubGlobal('document', { documentElement: root, querySelector: () => modalOpen ? middle : null, visibilityState: 'visible', addEventListener: win.addEventListener.bind(win), removeEventListener: win.removeEventListener.bind(win) });
  web = createFakeWeb(); invoke = vi.fn(async () => []);
  context.bridge = { platform: 'web', web, invoke: invoke as WookBridge['invoke'], subscribe: () => () => undefined };
  host = new Host(); await host.render();
  expect(nodes(host.tree).filter(node => node.props['aria-label'] === '명령 입력')).toHaveLength(1);
  find('명령 입력').props.ref!.current = input;
});
afterEach(() => { host.dispose(); vi.useRealTimers(); vi.unstubAllGlobals(); });

const panel = () => find('메인 에이전트 대화창');
async function openChat() { find('메인 에이전트 대화').props.onClick?.(); await host.render(); }
function escape(composing = false) {
  const event = new Event('keydown', { cancelable: true });
  Object.defineProperties(event, { key: { value: 'Escape' }, isComposing: { value: composing } });
  win.dispatchEvent(event); return event;
}
it('chat starts closed, opens in one press, expands only by choice and closes with focus returned', async () => {
  const launcherFocus = vi.fn(); find('메인 에이전트 대화').props.ref!.current = { focus: launcherFocus };
  expect(panel().props.hidden).toBe(true); expect(input.focus).not.toHaveBeenCalled();
  await openChat(); expect(panel().props.hidden).toBe(false); expect(panel().props.className).toBe('agent-chat agent-chat-compact');
  expect(input.focus).toHaveBeenCalledTimes(1);
  find('대화 넓게 보기').props.onClick?.(); await host.render();
  expect(panel().props.className).toBe('agent-chat agent-chat-expanded');
  find('대화 작게 보기').props.onClick?.(); await host.render();
  expect(panel().props.className).toBe('agent-chat agent-chat-compact');
  find('대화 닫기').props.onClick?.(); await host.render();
  expect(panel().props.hidden).toBe(true); expect(launcherFocus).toHaveBeenCalledTimes(1);
  await openChat(); expect(escape(true).defaultPrevented).toBe(false); await host.render(); expect(panel().props.hidden).toBe(false);
  expect(escape().defaultPrevented).toBe(true); await host.render();
  expect(panel().props.hidden).toBe(true); expect(launcherFocus).toHaveBeenCalledTimes(2);
});
it('keeps exactly one command input and preserves a draft and open state between screens; reload starts closed', async () => {
  await openChat(); find('명령 입력').props.onChange?.({ target: { value: '이어서 적을 내용' } }); await host.render();
  host.project = snapshot.projects[0].id; await host.render();
  expect(panel().props.hidden).toBe(false);
  expect(find('명령 입력').props).toMatchObject({ value: '이어서 적을 내용' });
  expect(find('명령 대상').props).toMatchObject({ value: host.project });
  for (const action of ['대화 넓게 보기', '대화 닫기']) {
    find(action).props.onClick?.(); await host.render();
    expect(nodes(host.tree).filter(node => node.type === 'textarea')).toHaveLength(1);
    expect(host.html()).not.toMatch(/command-bar|command-expanded|대화 기록 펼치기|대화 기록 접기/);
  }
  host.dispose(); host = new Host(); await host.render(); expect(panel().props.hidden).toBe(true);
});
it('opens external drafts and requested conversations in the compact panel without sending or discarding the draft', async () => {
  openCommand(snapshot.projects[0].id, '보고서에서 고칠 내용을 적습니다.'); await host.render();
  expect(panel().props.hidden).toBe(false); expect(panel().props.className).toBe('agent-chat agent-chat-compact');
  expect(find('명령 대상').props).toMatchObject({ value: snapshot.projects[0].id });
  expect(find('명령 입력').props).toMatchObject({ value: '보고서에서 고칠 내용을 적습니다.' });
  find('대화 닫기').props.onClick?.(); await host.render();
  openConversation(null); await host.render(); expect(panel().props.hidden).toBe(false);
  expect(find('명령 대상').props).toMatchObject({ value: 'main' });
  expect(find('명령 입력').props).toMatchObject({ value: '보고서에서 고칠 내용을 적습니다.' });
  expect(invoke).not.toHaveBeenCalledWith('command.send', expect.anything());
});
it('a file dropped while closed opens the panel with its chip and focuses the only input', async () => {
  expect(panel().props.hidden).toBe(true);
  drag('drop', transfer([new File(['memo'], '새 메모.txt')]), middle); await host.render();
  expect(panel().props.hidden).toBe(false); expect(host.html()).toContain('새 메모.txt'); expect(input.focus).toHaveBeenCalled();
  expect(nodes(host.tree).filter(node => node.type === 'textarea')).toHaveLength(1);
  expect(invoke).not.toHaveBeenCalledWith('command.send', expect.anything());
});
it('unread counts survive closed and hidden states, clear only the chosen visible conversation, and announce messages politely', async () => {
  const direct = mainReplyFixture(null, snapshot.generatedAt), project = mainReplyFixture(snapshot.projects[0].id, snapshot.generatedAt);
  // Identical answers in different conversations still belong to different targets.
  project.message.text = direct.message.text; project.notice.body = direct.notice.body;
  host.notices = [direct.notice, project.notice];
  invoke.mockImplementation(async (method, target) => method === 'command.history' ? [target === 'main' ? direct.message : project.message] : []);
  await host.render(); expect(host.html()).toContain('읽지 않은 메인 답변 2개');
  expect(invoke).not.toHaveBeenCalledWith('notifications.markRead', expect.anything());
  Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
  await openChat(); expect(host.html()).toContain('읽지 않은 메인 답변 2개');
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true }); win.dispatchEvent(new Event('visibilitychange')); await host.render();
  expect(invoke).toHaveBeenCalledWith('notifications.markRead', direct.notice.id);
  expect(invoke).not.toHaveBeenCalledWith('notifications.markRead', project.notice.id);
  expect(host.html()).toContain('읽지 않은 메인 답변 1개');
  expect(host.html()).toContain('role="log"'); expect(host.html()).toContain('aria-live="polite"');
  find('명령 대상').props.onChange?.({ target: { value: snapshot.projects[0].id } }); await host.render();
  expect(invoke).toHaveBeenCalledWith('notifications.markRead', project.notice.id);
  expect(host.html()).not.toContain('conversation-unread');
});
it('does not mark an answer above the reading viewport until the owner scrolls to it', async () => {
  const reply = mainReplyFixture(null, snapshot.generatedAt); host.notices = [reply.notice];
  invoke.mockImplementation(async method => method === 'command.history' ? [reply.message] : []);
  let top = -100;
  const list = { scrollTop: 0, scrollHeight: 1000, getBoundingClientRect: () => ({ top: 0, bottom: 200 }),
    querySelectorAll: () => [{ dataset: { messageId: reply.message.id }, getBoundingClientRect: () => ({ top, bottom: top + 50, height: 50 }) }] };
  nodes(host.tree).find(node => node.props.className === 'conversation')!.props.ref!.current = list;
  await openChat(); expect(invoke).not.toHaveBeenCalledWith('notifications.markRead', reply.notice.id);
  top = 20; nodes(host.tree).find(node => node.props.className === 'conversation')!.props.onScroll?.(); await host.render();
  expect(invoke).toHaveBeenCalledWith('notifications.markRead', reply.notice.id);
});
it('new replies preserve the position while reading earlier messages and follow the bottom when the owner returns', async () => {
  const reply = mainReplyFixture(null, snapshot.generatedAt), messages = [reply.message];
  invoke.mockImplementation(async method => method === 'command.history' ? [...messages] : []);
  const list = { scrollTop: 0, scrollHeight: 1000, clientHeight: 200, querySelectorAll: () => [] };
  nodes(host.tree).find(node => node.props.className === 'conversation')!.props.ref!.current = list;
  await openChat(); expect(list.scrollTop).toBe(1000);
  list.scrollTop = 40; nodes(host.tree).find(node => node.props.className === 'conversation')!.props.onScroll?.(); await host.render();
  messages.push({ ...reply.message, id: 'second' }); host.notices = [{ ...reply.notice, read: true }]; await host.render();
  expect(list.scrollTop).toBe(40);
  list.scrollTop = 800; nodes(host.tree).find(node => node.props.className === 'conversation')!.props.onScroll?.(); await host.render();
  messages.push({ ...reply.message, id: 'third' }); host.notices = [...host.notices]; await host.render();
  expect(list.scrollTop).toBe(1000);
  list.scrollTop = 40; nodes(host.tree).find(node => node.props.className === 'conversation')!.props.onScroll?.(); await host.render();
  find('명령 대상').props.onChange?.({ target: { value: snapshot.projects[0].id } }); await host.render();
  expect(list.scrollTop).toBe(1000);
});
it('closing a background conversation before returning to the page leaves its reply unread', async () => {
  const reply = mainReplyFixture(null, snapshot.generatedAt); host.notices = [reply.notice];
  invoke.mockImplementation(async method => method === 'command.history' ? [reply.message] : []);
  Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
  await openChat(); find('대화 닫기').props.onClick?.(); await host.render();
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true }); win.dispatchEvent(new Event('visibilitychange')); await host.render();
  expect(invoke).not.toHaveBeenCalledWith('notifications.markRead', reply.notice.id);
  expect(host.html()).toContain('읽지 않은 메인 답변 1개');
});
it('a blocking dialog makes chat inert, keeps Escape for that dialog and defers reading until it closes', async () => {
  host.dispose(); let mutation = () => {};
  vi.stubGlobal('MutationObserver', class { constructor(callback: () => void) { mutation = callback; } observe() {} disconnect() {} });
  host = new Host(); await host.render(); find('명령 입력').props.ref!.current = input;
  await openChat(); modalOpen = true; mutation(); await host.render();
  expect(panel().props.inert).toBe(true); expect(find('메인 에이전트 대화').props.inert).toBe(true);
  expect(escape().defaultPrevented).toBe(false); await host.render(); expect(panel().props.hidden).toBe(false);
  const reply = mainReplyFixture(null, snapshot.generatedAt); host.notices = [reply.notice];
  invoke.mockImplementation(async method => method === 'command.history' ? [reply.message] : []); await host.render();
  expect(invoke).not.toHaveBeenCalledWith('notifications.markRead', reply.notice.id);
  modalOpen = false; mutation(); await host.render();
  expect(panel().props.inert).toBe(false); expect(invoke).toHaveBeenCalledWith('notifications.markRead', reply.notice.id);
});
it('Enter sends once, Shift+Enter and Korean composing Enter do not send, and in-flight sending is visible', async () => {
  await openChat(); find('명령 입력').props.onChange?.({ target: { value: '다음 작업을 정리해 줘' } }); await host.render();
  const key = (shiftKey: boolean, isComposing: boolean, keyCode = 13) => ({ key: 'Enter', shiftKey, keyCode, nativeEvent: { isComposing }, preventDefault: vi.fn() });
  for (const event of [key(true, false), key(false, true), key(false, false, 229)]) find('명령 입력').props.onKeyDown?.(event);
  expect(invoke).not.toHaveBeenCalledWith('command.send', expect.anything());
  let finish: (() => void) | undefined;
  invoke.mockImplementation(method => method === 'command.send' ? new Promise<void>(resolve => { finish = resolve; }) : Promise.resolve([]));
  const event = key(false, false); find('명령 입력').props.onKeyDown?.(event); await host.render();
  expect(event.preventDefault).toHaveBeenCalled(); expect(host.html()).toContain('보내는 중…');
  expect(nodes(host.tree).find(node => node.props.className === 'primary-button send-button')!.props.disabled).toBe(true);
  find('명령 입력').props.onKeyDown?.(key(false, false));
  expect(invoke.mock.calls.filter(call => call[0] === 'command.send')).toHaveLength(1);
  finish?.(); await host.render(); expect(host.html()).not.toContain('보내는 중…');
});
it('phone geometry follows keyboard viewport height and pan, and listeners are removed on unmount', async () => {
  host.dispose(); const viewport = Object.assign(new EventTarget(), { height: 844, offsetTop: 0 });
  Object.defineProperty(window, 'visualViewport', { value: viewport, configurable: true }); host = new Host(); await host.render();
  expect(nodes(host.tree)[0].props.style).toMatchObject({ '--chat-viewport-height': '844px', '--chat-viewport-top': '0px' });
  viewport.height = 420; viewport.offsetTop = 36; viewport.dispatchEvent(new Event('resize')); await host.render();
  expect(nodes(host.tree)[0].props.style).toMatchObject({ '--chat-viewport-height': '420px', '--chat-viewport-top': '36px' });
  const remove = vi.spyOn(viewport, 'removeEventListener'); host.dispose(); expect(remove).toHaveBeenCalledWith('resize', expect.any(Function)); expect(remove).toHaveBeenCalledWith('scroll', expect.any(Function));
});
it('layout leaves desktop offices, emergency controls, member close and toasts clear; phone has no fixed minimum width and motion can stop', () => {
  const css = readFileSync('src/renderer/src/styles/agent-chat.css', 'utf8');
  expect(css).toContain('.agent-chat[hidden] { display: none; }');
  expect(css).toContain('margin-right: calc(clamp(304px, 32vw, 384px) + 36px)');
  expect(css).toContain('--chat-right: calc(min(560px, 55vw) + 14px)');
  expect(css).toMatch(/@media \(max-width: 760px\)[\s\S]*\n\s+width: calc\(100vw - 16px\); height:/);
  expect(css).toContain('height: calc(var(--chat-viewport-height, 100dvh) - 148px)');
  expect(css).toContain('@media (prefers-reduced-motion: reduce)');
  expect(css).toContain('animation: none !important; transition: none !important; scroll-behavior: auto !important');
  const seat = readFileSync('src/renderer/src/styles/seat.css', 'utf8');
  expect(seat).not.toMatch(/grid-template-rows:[^;]*(?:92px|153px)/);
});

it('highlights a file drag over the page and clears on window leave, Esc, blur, dragend, pagehide, hidden page and silent OS cancel', async () => {
  for (const end of ['leave', 'Escape', 'blur', 'dragend', 'pagehide', 'hidden', 'timeout']) {
    expect(drag('dragover', transfer(), middle).defaultPrevented).toBe(true);
    await host.render(); expect(highlighted()).toBe(true);
    if (end === 'leave') drag('dragleave', transfer(), middle);
    else if (end === 'timeout') await vi.advanceTimersByTimeAsync(701);
    else if (end === 'hidden') { Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }); win.dispatchEvent(new Event('visibilitychange')); }
    else if (end === 'Escape') { const event = new Event('keydown'); Object.defineProperty(event, 'key', { value: 'Escape' }); win.dispatchEvent(event); }
    else win.dispatchEvent(new Event(end));
    await host.render(); expect(highlighted()).toBe(false);
  }
});
it('shows the destination on window entry and keeps it while moving between page, conversation and composer', async () => {
  const data = transfer();
  drag('dragenter', data, middle);
  await host.render(); expect(highlighted()).toBe(true);
  expect(host.html()).toContain('class="command-drop-hint command-file-over"');
  expect(host.html()).toContain('창 어디에 놓아도 명령에 첨부됩니다');
  expect(data.dropEffect).toBe('copy');
  for (const target of [conversation, area, input, middle]) {
    drag('dragleave', data, input, target);
    await host.render(); expect(highlighted()).toBe(true);
    drag('dragover', data, target);
    await host.render(); expect(highlighted()).toBe(true);
  }
  expect(input.focus).not.toHaveBeenCalled();
  // Continued dragover renews the silent-cancel deadline.
  await vi.advanceTimersByTimeAsync(600); drag('dragover', data, middle);
  await vi.advanceTimersByTimeAsync(600); await host.render(); expect(highlighted()).toBe(true);
});
it('adds dropped files through the real queue, keeps later drops, focuses input and clears highlight', async () => {
  drag('dragover'); drag('drop', transfer([new File(['a'], 'a.txt'), new File(['b'], 'b.txt')]));
  await host.render();
  expect(highlighted()).toBe(false); expect(input.focus).toHaveBeenCalledTimes(1);
  expect(host.html()).toContain('a.txt'); expect(host.html()).toContain('b.txt');
  expect(host.html()).toContain('파일 2개를 첨부 목록에 추가했습니다.');
  expect(find('a.txt 업로드 진행률')).toBeDefined();
  await vi.advanceTimersByTimeAsync(1000); await host.render();
  drag('drop', transfer([new File(['c'], 'c.txt')])); await host.render();
  expect(host.html()).toContain('a.txt'); expect(host.html()).toContain('b.txt'); expect(host.html()).toContain('c.txt');
});
it('shows retryable error chips and blocks sends until retry finishes', async () => {
  web.upload = vi.fn().mockRejectedValueOnce(new Error('파일을 올리지 못했습니다.')).mockResolvedValue({ uploadId: 'ready' });
  drag('drop', transfer([new File(['x'], 'retry.txt')])); await host.render();
  expect(find('retry.txt 다시 올리기')).toBeDefined();
  expect(nodes(host.tree).find(node => node.props.className === 'primary-button send-button')?.props.disabled).toBe(true);
  await find('retry.txt 다시 올리기').props.onClick?.(); await host.render();
  expect(host.html()).toContain('첨부 준비됨');
  expect(nodes(host.tree).find(node => node.props.className === 'primary-button send-button')?.props.disabled).toBe(false);
});
it('leaves text and link drags entirely to the browser', async () => {
  const text = { types: ['text/plain', 'text/uri-list'], items: [], files: [], dropEffect: 'link' };
  const before = host.html();
  expect(drag('dragenter', text, middle).defaultPrevented).toBe(false);
  expect(drag('dragover', text, middle).defaultPrevented).toBe(false);
  expect(drag('drop', text, middle).defaultPrevented).toBe(false);
  expect(text.dropEffect).toBe('link');
  await host.render(); expect(host.html()).toBe(before); expect(input.focus).not.toHaveBeenCalled();
});
it('attaches from the middle of the page and conversation, focuses input, and waits for an explicit send', async () => {
  for (const [target, name] of [[middle, 'middle.txt'], [conversation, 'conversation.txt']] as const) {
    drag('dragover', transfer(), target);
    expect(drag('drop', transfer([new File(['x'], name)]), target).defaultPrevented).toBe(true);
    await host.render(); expect(highlighted()).toBe(false); expect(host.html()).toContain(name);
  }
  expect(input.focus).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1000); await host.render();
  expect(invoke).not.toHaveBeenCalledWith('command.send', expect.anything());
  expect(find('명령 대상').props).toMatchObject({ value: 'main' });
  await find('middle.txt 첨부 제거').props.onClick?.(); await host.render();
  expect(host.html()).not.toContain('middle.txt'); expect(host.html()).toContain('conversation.txt');
});
it('blocks file drops and the hint while a modal blocks the page, then resumes after it closes', async () => {
  drag('dragover', transfer(), middle); await host.render(); expect(highlighted()).toBe(true);
  modalOpen = true;
  for (const target of [middle, conversation, input]) {
    const data = transfer([new File(['x'], 'blocked.txt')]);
    expect(drag('dragover', data, target).defaultPrevented).toBe(true);
    await host.render(); expect(highlighted()).toBe(false); expect(host.html()).not.toContain('command-drop-hint');
    expect(data.dropEffect).toBe('none');
    expect(drag('drop', data, target).defaultPrevented).toBe(true);
    await host.render(); expect(host.html()).not.toContain('blocked.txt');
  }
  expect(input.focus).not.toHaveBeenCalled();
  modalOpen = false;
  drag('drop', transfer([new File(['x'], 'resumed.txt')]), middle);
  await host.render(); expect(host.html()).toContain('resumed.txt'); expect(input.focus).toHaveBeenCalledTimes(1);
});
it('refuses folders accessibly but still attaches their sibling files', async () => {
  const file = new File(['x'], 'kept.txt');
  const folder = { kind: 'file', getAsFile: () => new File([], 'folder'), webkitGetAsEntry: () => ({ isDirectory: true, name: '자료' }) };
  drag('drop', { types: ['Files'], files: [file], items: [folder, { kind: 'file', getAsFile: () => file }], dropEffect: 'none' }, middle); await host.render();
  expect(host.html()).toContain('자료: 폴더는 첨부할 수 없습니다');
  expect(host.html()).toContain('aria-live="polite"'); expect(host.html()).toContain('kept.txt');
});
it('keeps a non-retryable web size-error chip, without invoking upload', async () => {
  web.upload = vi.fn();
  const file = new File([], 'large.txt'); Object.defineProperty(file, 'size', { value: MAX_UPLOAD_BYTES + 1 });
  drag('drop', transfer([file])); await host.render();
  expect(host.html()).toContain('50 MB'); expect(find('large.txt 첨부 제거')).toBeDefined();
  expect(nodes(host.tree).some(node => node.props['aria-label'] === 'large.txt 다시 올리기')).toBe(false);
  expect(web.upload).not.toHaveBeenCalled();
});
it('desktop reads data URLs, refuses oversize files and blocks an immediate Enter until the read completes', async () => {
  host.dispose(); context.bridge = { platform: 'win32', invoke: invoke as WookBridge['invoke'], subscribe: () => () => undefined };
  const readers: { onload?: () => void; result: string; readAsDataURL: ReturnType<typeof vi.fn> }[] = [];
  vi.stubGlobal('FileReader', class {
    result = 'data:text/plain;base64,eA=='; onload?: () => void;
    readAsDataURL = vi.fn(() => { readers.push(this); });
  });
  host = new Host(); await host.render();
  find('명령 입력').props.ref!.current = input;
  find('명령 입력').props.onChange?.({ target: { value: '첨부 검토' } }); await host.render();
  const large = new File([], 'large'); Object.defineProperty(large, 'size', { value: MAX_UPLOAD_BYTES + 1 });
  drag('drop', transfer([new File(['x'], 'desktop.txt'), large]), middle); await host.render();
  expect(readers).toHaveLength(1); expect(host.html()).toContain('50 MB');
  expect(nodes(host.tree).find(node => node.props.className === 'primary-button send-button')?.props.disabled).toBe(true);
  readers[0].onload?.(); await host.render();
  expect(host.html()).toContain('desktop.txt'); expect(host.html()).not.toContain('📎 large');
  drag('drop', transfer([new File(['x'], 'later.txt')])); await host.render();
  readers[1].onload?.(); await host.render();
  expect(host.html()).toContain('desktop.txt'); expect(host.html()).toContain('later.txt');
  await nodes(host.tree).find(node => node.props.className === 'primary-button send-button')?.props.onClick?.();
  expect(invoke).toHaveBeenCalledWith('command.send', { target: 'main', text: '첨부 검토', attachments: [
    { name: 'desktop.txt', dataUrl: 'data:text/plain;base64,eA==' }, { name: 'later.txt', dataUrl: 'data:text/plain;base64,eA==' },
  ] });
});
it('desktop paperclip paths and pasted image data URLs share one composer and respect the paste size limit', async () => {
  host.dispose(); context.bridge = { platform: 'win32', invoke: invoke as WookBridge['invoke'], subscribe: () => () => undefined };
  invoke.mockImplementation(async method => method === 'system.pickFiles' ? [{ name: '기획.pdf', path: 'demo/plan.pdf' }] : []);
  const readers: { onload?: () => void; result: string }[] = [];
  vi.stubGlobal('FileReader', class {
    result = 'data:image/png;base64,eA=='; onload?: () => void;
    readAsDataURL() { readers.push(this); }
  });
  host = new Host(); await host.render(); find('명령 입력').props.ref!.current = input; await openChat();
  await find('파일 첨부').props.onClick?.(); await host.render(); expect(host.html()).toContain('기획.pdf');
  const large = new File([], 'large.png', { type: 'image/png' }); Object.defineProperty(large, 'size', { value: MAX_UPLOAD_BYTES + 1 });
  const image = new File(['x'], '', { type: 'image/png' }), preventDefault = vi.fn();
  find('명령 입력').props.onPaste?.({ clipboardData: { items: [large, image].map(file => ({ type: 'image/png', getAsFile: () => file })) }, preventDefault }); await host.render();
  expect(preventDefault).toHaveBeenCalled(); expect(readers).toHaveLength(1); expect(host.html()).toContain('50 MB');
  expect(nodes(host.tree).find(node => node.props.className === 'primary-button send-button')!.props.disabled).toBe(true);
  readers[0].onload?.(); await host.render();
  expect(find('붙여넣은 이미지.png 첨부 제거')).toBeDefined(); await find('기획.pdf 첨부 제거').props.onClick?.(); await host.render();
  expect(host.html()).not.toContain('기획.pdf');
  await nodes(host.tree).find(node => node.props.className === 'primary-button send-button')!.props.onClick?.();
  expect(invoke).toHaveBeenCalledWith('command.send', { target: 'main', text: '', attachments: [{ name: '붙여넣은 이미지.png', dataUrl: 'data:image/png;base64,eA==' }] });
});
