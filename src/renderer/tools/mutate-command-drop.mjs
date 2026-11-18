// Run serially under the approved CPU wrapper; each Vitest child uses it too.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const wrapper = process.env.COMMAND_DROP_VITEST_WRAPPER;
assert.ok(wrapper, 'Set COMMAND_DROP_VITEST_WRAPPER to the approved Vitest wrapper');
const root = 'src/renderer/src/';
const cases = [
  ['text triggers file mode', 'lib/fileDrop.ts', "Array.from(data.types).includes('Files')", 'true'],
  ['file items ignored', 'lib/fileDrop.ts', "item.kind !== 'file'", "item.kind === 'file'"],
  ['folders accepted', 'lib/fileDrop.ts', 'if (entry?.isDirectory)', 'if (false)'],
  ['folder also attached', 'lib/fileDrop.ts', '        continue;', '        // continue removed'],
  ['fallback duplicates files', 'lib/fileDrop.ts', '  } else {', '  } {'],
  ['only first file kept', 'lib/fileDrop.ts', 'for (const item of items)', 'for (const item of items.slice(0, 1))'],
  ['50 MB boundary refused', 'lib/fileDrop.ts', 'file.size > MAX_UPLOAD_BYTES', 'file.size >= MAX_UPLOAD_BYTES'],
  ['desktop oversize accepted', 'lib/fileDrop.ts', "if (mode === 'desktop') return;", 'if (false) return;'],
  ['web oversize chip missing', 'lib/fileDrop.ts', "if (mode === 'desktop') return;", 'if (true) return;'],
  ['file highlight missing', 'lib/useCommandDrop.ts', 'setDragging(active);', 'setDragging(false);'],
  ['highlight limited to composer', 'lib/useCommandDrop.ts', 'const active = !blocked();', "const active = !blocked() && event.target instanceof Node && document.querySelector('.command-compose')?.contains(event.target) === true;"],
  ['window entry hint missing', 'lib/useCommandDrop.ts', "window.addEventListener('dragenter', over, true);", '// dragenter listener removed'],
  ['file cursor refuses allowed drops', 'lib/useCommandDrop.ts', "active ? 'copy' : 'none'", "'none'"],
  ['window leave stays highlighted', 'lib/useCommandDrop.ts', 'if (!inside(event.relatedTarget)) clear();', 'if (false) clear();'],
  ['moving between page children clears hint', 'lib/useCommandDrop.ts', 'if (!inside(event.relatedTarget)) clear();', 'clear();'],
  ['drop stays highlighted', 'lib/useCommandDrop.ts', '      clear();\n      if (!isFileDrag', '      // clear removed\n      if (!isFileDrag'],
  ['Escape ignored', 'lib/useCommandDrop.ts', "event.key === 'Escape'", "event.key === 'Never'"],
  ['blur ignored', 'lib/useCommandDrop.ts', "window.addEventListener('blur', clear);", '// blur listener removed'],
  ['dragend ignored', 'lib/useCommandDrop.ts', "window.addEventListener('dragend', clear, true);", '// dragend listener removed'],
  ['pagehide ignored', 'lib/useCommandDrop.ts', "window.addEventListener('pagehide', clear);", '// pagehide listener removed'],
  ['hidden page ignored', 'lib/useCommandDrop.ts', "document.addEventListener('visibilitychange', visibility);", '// visibility listener removed'],
  ['silent OS cancel sticks', 'lib/useCommandDrop.ts', 'setTimeout(clear, 700)', 'setTimeout(clear, 70000)'],
  ['continued drag expires early', 'lib/useCommandDrop.ts', '      clearTimeout(expiry);\n      // OS', '      // deadline not renewed\n      // OS'],
  ['outside file navigates', 'lib/useCommandDrop.ts', "window.addEventListener('drop', drop, true);", '// page drop guard removed'],
  ['outside file ignored', 'lib/useCommandDrop.ts', 'event.dataTransfer && !blocked()', "event.dataTransfer && !blocked() && event.target instanceof Node && document.querySelector('.command-compose')?.contains(event.target)"],
  ['modal shows destination hint', 'lib/useCommandDrop.ts', 'const active = !blocked();', 'const active = true;'],
  ['modal drop attaches behind dialog', 'lib/useCommandDrop.ts', 'event.dataTransfer && !blocked()', 'event.dataTransfer'],
  ['drop loses focus', 'components/CommandBar.tsx', '    input.current?.focus();', '    // focus removed'],
  ['web drop ignored', 'components/CommandBar.tsx', '      addFiles(files);', '      // dropped files ignored'],
  ['later web drop replaces chips', 'components/CommandBar.tsx', '    queue.current?.add(files.map', '    queue.current?.clear(); queue.current?.add(files.map'],
  ['desktop drop replaces chips', 'components/CommandBar.tsx', 'setAttachments(old => [...old, ...added]);', 'setAttachments(added);'],
  ['desktop uses no data URL', 'components/CommandBar.tsx', 'dataUrl: reader.result } : null', "dataUrl: '' } : null"],
  ['send while reading desktop file', 'components/CommandBar.tsx', 'readingFiles > 0 || web &&', 'web &&'],
  ['retry button does nothing', 'components/CommandBar.tsx', 'queue.current?.retry(item.id)', 'undefined'],
];
const run = () => spawnSync('bash', [wrapper, 'run', '--config', 'src/renderer/tools/vitest.config.ts',
  root + 'lib/fileDrop.test.ts', root + 'components/command-drop.test.ts'],
{ encoding: 'utf8', windowsHide: true, timeout: 180000, maxBuffer: 2000000 });
const baseline = run();
assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr);
for (const [name, file, from] of cases) assert.equal(readFileSync(root + file, 'utf8').split(from).length, 2, `Unique anchor: ${name}`);
const results = [];
for (const [name, file, from, to] of cases) {
  const original = readFileSync(root + file, 'utf8');
  try {
    writeFileSync(root + file, original.replace(from, to));
    const result = run();
    const output = result.stdout + result.stderr;
    const caught = result.status !== 0 && /AssertionError/.test(output);
    results.push({ name, caught, exit: result.status });
    console.log(`${name}: ${caught ? 'caught' : 'MISSED'}`);
    if (!caught) console.log(output.slice(-1800));
  } finally { writeFileSync(root + file, original); }
}
mkdirSync('docs/design/command-bar', { recursive: true });
writeFileSync('docs/design/command-bar/mutation-results.json', JSON.stringify(results, null, 2) + '\n');
assert.ok(results.every(item => item.caught), 'A command drop mutant survived');
console.log(`${results.length}/${results.length} caught`);
