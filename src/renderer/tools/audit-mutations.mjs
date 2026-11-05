import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/pc_09/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright-core');
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(new URL('?officeDemo=busy', process.argv[2] ?? 'http://127.0.0.1:5198/').toString(), { waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);
  await page.evaluate(() => {
    window.__officeMutations = {};
    const observer = new MutationObserver(records => {
      for (const record of records) {
        const key = `${record.type}:${record.attributeName ?? ''}:${record.target.getAttribute?.('class') ?? record.target.nodeName}`;
        window.__officeMutations[key] = (window.__officeMutations[key] ?? 0) + 1;
      }
    });
    observer.observe(document.querySelector('.office-scene'), { subtree: true, childList: true, attributes: true });
  });
  await page.waitForTimeout(12000);
  const records = await page.evaluate(() => Object.entries(window.__officeMutations).sort((a, b) => b[1] - a[1]).slice(0, 30));
  console.log(records);
} finally { await browser.close(); }
