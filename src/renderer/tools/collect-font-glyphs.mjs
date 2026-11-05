import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/pc_09/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright-core');
const browser = await chromium.launch();
const base = process.argv[2] ?? 'http://127.0.0.1:5198/';
const glyphs = new Set();
const routes = [
  '?capture=login', '?officeDemo=busy&capture=home', '?officeDemo=idle', '?officeDemo=busy',
  '?officeDemo=events', '?officeDemo=busy&capture=member', '?officeDemo=busy&capture=documents',
  '?officeDemo=busy&capture=settings', '?officeDemo=busy&capture=poses',
  ...['assignment', 'step', 'review', 'submit', 'check', 'rejected', 'passed', 'conflict', 'waiting', 'error', 'paused', 'report', 'emergency'].map(step => `?officeDemo=${step}`),
];
try {
  for (const route of routes) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(new URL(route, base).toString(), { waitUntil: 'networkidle' });
    await page.waitForTimeout(200);
    const copy = await page.evaluate(() => document.body.textContent ?? '');
    for (const char of copy) glyphs.add(char);
    await page.close();
  }
} finally { await browser.close(); }
const value = [...glyphs].sort().join('');
writeFileSync(new URL('./pretendard-glyphs.txt', import.meta.url), value + '\n');
console.log(`${glyphs.size} glyphs across ${routes.length} screens`);
