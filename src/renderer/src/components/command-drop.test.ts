import { isValidElement, type ReactNode, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CommandBar } from './CommandBar';
import { snapshot } from '../api/fake/data';
import { createFakeWeb } from '../api/fake/web';
import type { WookBridge } from '../../../shared/ipc';
import { MAX_UPLOAD_BYTES } from '../lib/uploads';

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
      try { this.tree = CommandBar({ snapshot, currentProjectId: null }); } finally { context.host = null; }
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
  find('명령 입력').props.ref!.current = input;
});
afterEach(() => { host.dispose(); vi.useRealTimers(); vi.unstubAllGlobals(); });

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
  expect(host.html()).toContain('class="command-drop-hint"');
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
