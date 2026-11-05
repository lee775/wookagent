import { readFileSync, writeFileSync } from 'node:fs';
const file = 'src/renderer/src/screens/Home.tsx';
const source = readFileSync(file, 'utf8');
const from = "placeholder={'npm run build\\nnpm test'} /></label><div className=\"modal-actions\">";
const to = "placeholder={'npm run build\\nnpm test'} /></label>{createError && <p role=\"alert\" className=\"warning\">{createError}</p>}<div className=\"modal-actions\">";
if (source.includes(to)) process.exit(0);
if (source.split(from).length !== 2) throw new Error('Project error anchor missing or repeated');
writeFileSync(file, source.replace(from, to));
