import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/pc_09/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright-core');
const root = process.argv[2] ?? 'docs/design/v33/review';
const base = process.env.WOOK_RENDERER_URL ?? 'http://127.0.0.1:5199/';
await mkdir(root, { recursive: true });
const browser = await chromium.launch();
const stamps = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await page.goto(new URL('?officeDemo=review', base).toString(), { waitUntil: 'networkidle' });
  const scene = page.locator('.office-scene');
  await scene.waitFor();
  const started = performance.now();
  for (let index = 0; index < 27; index++) {
    const delay = started + index * 1000 - performance.now();
    if (delay > 0) await page.waitForTimeout(delay);
    const at = performance.now() - started;
    await scene.screenshot({ path: join(root, `frame-${String(index).padStart(3, '0')}.png`) });
    stamps.push({ frame: index, milliseconds: Math.round(at) });
  }
  await writeFile(join(root, 'timestamps.json'), JSON.stringify(stamps, null, 2));
  console.log(JSON.stringify({ frames: stamps.length, maximumTimingErrorMs: Math.max(...stamps.map(({ frame, milliseconds }) => Math.abs(milliseconds - frame * 1000))) }));
} finally {
  await browser.close();
}
