import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Keep every upstream unicode-range so browser font loading remains lazy.
const source = resolve('node_modules/pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css');
const target = resolve('src/renderer/src/styles/pretendard-used.css');
const css = readFileSync(source, 'utf8').replaceAll('url(./woff2-dynamic-subset/',
  'url(../../../../node_modules/pretendard/dist/web/variable/woff2-dynamic-subset/');
writeFileSync(target, `/* All upstream Pretendard Variable dynamic subsets. Regenerate with tools/sync-pretendard.mjs. */\n${css}`, 'utf8');
