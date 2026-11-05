import { readFileSync, writeFileSync } from 'node:fs';
const file = 'src/renderer/src/screens/Documents.tsx';
const before = readFileSync(file, 'utf8');
const from = 'diffLines(comparison.markdown, detail.markdown)';
const to = "diffLines(comparison.markdown.replace(/^#\\s+[^\\r\\n]+\\r?\\n(?:\\r?\\n)?/, ''), reportBody)";
if (before.includes(to)) process.exit(0);
if (before.split(from).length !== 2) throw new Error('Comparison anchor missing or repeated');
writeFileSync(file, before.replace(from, to));
