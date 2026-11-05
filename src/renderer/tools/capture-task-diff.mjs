import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/pc_09/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright-core');
const base = process.env.WOOK_RENDERER_URL ?? 'http://127.0.0.1:5199/';
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(new URL('?officeDemo=busy&capture=home', base).toString(), { waitUntil: 'networkidle' });
  await page.locator('.todo', { hasText: '대표 검수' }).getByRole('button', { name: '열기' }).click();
  const diff = page.locator('.diff-view');
  await diff.waitFor();
  const text = await diff.innerText();
  assert.match(text, /WalkLog\.tsx|walk-log-flow\.md/);
  assert.doesNotMatch(text, /OrderScreen|order-flow|주문|합계/i);
  await diff.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'docs/design/v35-functions/task-diff.png' });
  console.log(JSON.stringify({ screenshot: 'docs/design/v35-functions/task-diff.png', walkJournalDiff: true }));
} finally { await browser.close(); }
