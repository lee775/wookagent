import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/pc_09/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright-core');
const base = process.env.WOOK_RENDERER_URL ?? 'http://127.0.0.1:5199/';
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(new URL('?officeDemo=busy', base).toString(), { waitUntil: 'networkidle' });
  await page.evaluate(async () => {
    const url = performance.getEntriesByType('resource').map(entry => entry.name).find(name => name.includes('/api/fake/data.ts?t='));
    if (!url) throw new Error('Fake data module was not loaded');
    const { snapshot } = await import(url);
    const member = snapshot.members.find(item => item.id === 'M-0024');
    if (!member) throw new Error('Demo member missing');
    member.ai.effortTier = 'high';
    member.ai.effortOverride = 'max';
    member.ai.effortValue = 'max';
  });
  const card = page.locator('.member-card').filter({ hasText: '태오' }).first();
  await card.getByText('max', { exact: false }).waitFor({ timeout: 4000 });
  assert.match(await card.innerText(), /높게 \(max\)/);
  const actor = page.locator('.office-actor[aria-label="태오 열기"]');
  const label = page.locator('.office-person-label').filter({ hasText: '태오' }).first();
  await label.hover();
  const hover = label.locator('.office-person-card');
  assert.match(await hover.innerText(), /높게 \(max\)/);
  await actor.click();
  const panel = page.locator('.member-panel');
  await panel.waitFor();
  assert.match(await panel.innerText(), /높게 \(max\)/);
  const result = { card: true, hover: true, memberPanel: true, value: 'max' };
  if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
}
