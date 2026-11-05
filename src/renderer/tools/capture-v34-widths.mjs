import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/pc_09/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright-core');
const out = 'docs/design/v34';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
try {
  for (const width of [1100, 1920]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
    await page.goto('http://127.0.0.1:5199/?officeDemo=busy', { waitUntil: 'networkidle' });
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `${out}/s04-studio-busy-${width}.png` });
    await page.close();
  }
} finally { await browser.close(); }
