// Run serially through the approved CPU wrapper, including every Vitest child.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const wrapper = process.env.COMMAND_DROP_VITEST_WRAPPER;
assert.ok(wrapper, 'Set COMMAND_DROP_VITEST_WRAPPER to the approved Vitest wrapper');
const root = 'src/renderer/src/';
const component = 'components/CommandBar.tsx', css = 'styles/agent-chat.css';
const cases = [
  ['reload starts open', component, "useState<'closed' | 'compact' | 'expanded'>('closed')", "useState<'closed' | 'compact' | 'expanded'>('compact')"],
  ['launcher cannot open', component, 'onClick={() => open ? closePanel() : openPanel()}', 'onClick={() => undefined}'],
  ['closed panel remains visible', component, 'hidden={!open}', 'hidden={false}'],
  ['close leaves panel open', component, "setView('closed'); launcher", "setView('compact'); launcher"],
  ['open does not focus input', component, 'if (open && !blocked) input.current?.focus({ preventScroll: true });', 'if (false) input.current?.focus({ preventScroll: true });'],
  ['close does not restore focus', component, 'launcher.current?.focus({ preventScroll: true });', 'undefined;'],
  ['expand never enlarges', component, "setView(value => value === 'expanded' ? 'compact' : 'expanded')", "setView('compact')"],
  ['Escape does not close', component, "event.key !== 'Escape'", "event.key !== 'Never'"],
  ['draft does not open chat', component, 'setText(draft.text); openPanel();', 'setText(draft.text);'],
  ['conversation request does not open chat', component, 'setTarget(target); openPanel();', 'setTarget(target);'],
  ['closed drop does not open chat', component, '    openPanel();', '    // no open on drop'],
  ['second command input', component, '<div className="command-input"><textarea', '<textarea aria-label="명령 입력" /><div className="command-input"><textarea'],
  ['unread count missing', component, 'const arrivingReplies=notifications.filter', 'const arrivingReplies=noNotices.filter'],
  ['closed history reads answers', component, 'if(!open){lastScrolled.current=null;followLatest.current=true;return;}', 'if(false){lastScrolled.current=null;followLatest.current=true;return;}'],
  ['new answer jumps while reading older messages', component, 'lastScrolled.current===null||followLatest.current', 'true'],
  ['marks replies from another target', component, 'mainReplyTarget(item)===target&&history.some', 'history.some'],
  ['offscreen answers marked read', component, 'return rect.bottom>frame.top&&rect.top<frame.bottom&&rect.height>0;', 'return true;'],
  ['hidden page marks read', component, "document.visibilityState==='hidden'||blocked", 'blocked'],
  ['uploads no longer block send', component, "web && uploads.some(item => item.state.kind !== 'ready')", 'false'],
  ['composing Enter sends', component, '!event.nativeEvent.isComposing && ', ''],
  ['IME keycode 229 sends', component, ' && event.keyCode !== 229', ''],
  ['Shift Enter sends', component, '!event.shiftKey && ', ''],
  ['keyboard resize ignored', 'lib/useChatSurface.ts', "visible.addEventListener('resize', update);", '// resize listener removed'],
  ['keyboard pan ignored', 'lib/useChatSurface.ts', "'--chat-viewport-top': `${visible.offsetTop}px`", "'--chat-viewport-top': '0px'"],
  ['modal does not block chat', 'lib/useChatSurface.ts', 'setBlocked(document.querySelector', 'setBlocked(false && document.querySelector'],
  ['office names under compact panel', css, 'margin-right: calc(clamp(304px, 32vw, 384px) + 36px)', 'margin-right: 0'],
  ['phone fixed desktop width', css, 'width: calc(100vw - 16px); height:', 'width: 480px; height:'],
  ['reduced motion ignored', css, 'animation: none !important; transition: none !important; scroll-behavior: auto !important;', 'animation: chat-arrive 150ms;'],
  ['bottom command row returns', 'styles/seat.css', 'grid-template-rows: 66px auto minmax(0, 1fr);', 'grid-template-rows: 66px auto minmax(0, 1fr) 92px;'],
];
const run = () => spawnSync('bash', [wrapper, 'run', '--config', 'src/renderer/tools/vitest.config.ts', root + 'components/command-drop.test.ts'],
  { encoding: 'utf8', windowsHide: true, timeout: 180000, maxBuffer: 2000000 });
const baseline = run();
assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr);
for (const [name, file, from] of cases) assert.equal(readFileSync(root + file, 'utf8').split(from).length, 2, `Unique anchor: ${name}`);
const results = [];
for (const [name, file, from, to] of cases) {
  const original = readFileSync(root + file, 'utf8');
  try {
    writeFileSync(root + file, original.replace(from, to));
    const result = run(), output = result.stdout + result.stderr;
    const caught = result.status !== 0 && /AssertionError/.test(output);
    results.push({ name, caught, exit: result.status });
    console.log(`${name}: ${caught ? 'caught' : 'MISSED'}`);
    if (!caught) console.log(output.slice(-1800));
  } finally { writeFileSync(root + file, original); }
}
mkdirSync('docs/design/agent-chat', { recursive: true });
writeFileSync('docs/design/agent-chat/mutation-results.json', JSON.stringify(results, null, 2) + '\n');
assert.ok(results.every(item => item.caught), 'An agent chat mutant survived');
console.log(`${results.length}/${results.length} caught`);
