import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/pc_09/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright-core');
const base = process.env.WOOK_RENDERER_URL ?? 'http://127.0.0.1:5199/';
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(5000);
  await page.goto(new URL('?officeDemo=busy&capture=settings', base).toString(), { waitUntil: 'networkidle' });
  await page.getByText(/선택한 노력치:.*실제 값/).waitFor();
  assert.match(await page.getByText(/선택한 노력치:.*실제 값/).textContent(), /실제 값 \w+/);
  await page.goto(new URL('?officeDemo=busy&capture=home', base).toString(), { waitUntil: 'networkidle' });
  await page.locator('.project-card').first().click();
  await page.locator('.member-card', { hasText: '시안' }).click();
  const panel = page.locator('.member-panel');
  await panel.getByText(/다음 작업부터 적용:.*높게 \(high\)/).waitFor();
  await page.evaluate(async () => {
    const url = performance.getEntriesByType('resource').map(entry => entry.name).find(name => name.includes('/api/fake/index.ts?t='));
    const { fakeBridge } = await import(url);
    const settings = await fakeBridge.invoke('settings.get');
    await fakeBridge.invoke('settings.update', { team: { effortMapping: {
      ...settings.team.effortMapping,
      codex: { ...settings.team.effortMapping.codex, high: 'xhigh' },
    } } });
  });
  await panel.getByText(/다음 작업부터 적용:.*높게 \(xhigh\)/).waitFor();
  console.log(JSON.stringify({ settingsResolvedValue: true, panelUpdatedMapping: true }));
} finally { await browser.close(); }
