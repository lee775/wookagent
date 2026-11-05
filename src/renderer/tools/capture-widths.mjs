import { createRequire } from 'node:module';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/pc_09/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright-core');
const base = process.env.WOOK_RENDERER_URL ?? 'http://127.0.0.1:5199/';
const dir = process.argv[2] ?? 'docs/design/v33';
const browser = await chromium.launch();
try {
  for (const width of [1100, 1920]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
    await page.goto(new URL('?officeDemo=busy', base).toString(), { waitUntil: 'networkidle' });
    await page.waitForTimeout(2500);
    const path = join(dir, `s04-${width}.png`);
    await page.screenshot({ path });
    console.log(path);
    await page.close();
  }
} finally { await browser.close(); }
