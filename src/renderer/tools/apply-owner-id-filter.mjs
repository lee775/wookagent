import { readFileSync, writeFileSync } from 'node:fs';
const edits = {
  'src/renderer/src/screens/Home.tsx': [
    ['<p>{item.text}</p>', '<p>{resolveDisplayText(item.text, snapshot)}</p>'],
  ],
  'src/renderer/src/screens/Studio.tsx': [
    ['<p>{item.text}</p>', '<p>{resolveDisplayText(item.text, snapshot)}</p>'],
  ],
  'src/renderer/src/components/TaskDetail.tsx': [
    ['{transition.reason} ({transition.actor})', '{resolveDisplayText(transition.reason, snapshot)} ({resolveDisplayText(transition.actor, snapshot)})'],
  ],
  'src/renderer/src/App.tsx': [
    ['toast(item.title, item.body, item.level)', 'toast(resolveDisplayText(item.title, snapshot), resolveDisplayText(item.body, snapshot), item.level)'],
    ['<strong>{item.title}</strong>', '<strong>{resolveDisplayText(item.title, snapshot)}</strong>'],
    ['<p>{item.body}</p>', '<p>{resolveDisplayText(item.body, snapshot)}</p>'],
    ['<small>{item.body}</small>', '<small>{resolveDisplayText(item.body, snapshot)}</small>'],
  ],
};
for (const [file, changes] of Object.entries(edits)) {
  let source = readFileSync(file, 'utf8');
  for (const [from, to] of changes) {
    if (!source.includes(from) && !source.includes(to)) throw new Error(`${file}: ${from} missing`);
    source = source.replaceAll(from, to);
  }
  writeFileSync(file, source);
}
