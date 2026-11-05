import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/pc_09/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright-core');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto('http://127.0.0.1:5198/?officeDemo=busy', { waitUntil: 'networkidle' });
for (const wait of [3000, 6000, 12000]) {
  await page.waitForTimeout(wait);
  console.log(wait, await page.evaluate(() => [...document.querySelectorAll('.office-actor')].map(node => ({ name: node.getAttribute('aria-label'), pose: node.getAttribute('data-pose'), feet: node.getAttribute('data-feet-y') }))));
}
await browser.close();
