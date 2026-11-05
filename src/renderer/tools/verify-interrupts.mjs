import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/pc_09/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright-core');
const base = process.env.WOOK_RENDERER_URL ?? 'http://127.0.0.1:5199/';
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const intercept = async () => page.evaluate(async () => {
    const url = performance.getEntriesByType('resource').map(entry => entry.name).find(name => name.includes('/api/fake/index.ts?t='));
    const { fakeBridge } = await import(url);
    const real = fakeBridge.invoke.bind(fakeBridge);
    window.__interruptProbe = [];
    fakeBridge.invoke = async (...args) => {
      if (args[0] === 'members.interrupt' || args[0] === 'tasks.interrupt') window.__interruptProbe.push(args);
      return real(...args);
    };
  });
  await page.goto(new URL('?officeDemo=busy&capture=home', base).toString(), { waitUntil: 'networkidle' });
  await page.locator('.todo').filter({ hasText: '대표 검수' }).locator('button').click();
  await page.locator('.criterion-form select').first().waitFor();
  await intercept();
  await page.locator('.modal').last().getByRole('button', { name: '중단', exact: true }).click();
  const taskDialog = page.getByRole('dialog', { name: '작업 중단' });
  await taskDialog.getByRole('button', { name: '닫기' }).last().click();
  assert.equal((await page.evaluate(() => window.__interruptProbe)).length, 0);
  await page.locator('.modal').last().getByRole('button', { name: '중단', exact: true }).click();
  page.once('dialog', dialog => dialog.dismiss());
  await taskDialog.getByRole('button', { name: '작업 취소' }).click();
  assert.equal((await page.evaluate(() => window.__interruptProbe)).length, 0);
  page.once('dialog', dialog => dialog.accept());
  await taskDialog.getByRole('button', { name: '작업 취소' }).click();
  await page.waitForFunction(() => window.__interruptProbe.length === 1);
  assert.equal((await page.evaluate(() => window.__interruptProbe))[0][2], 'cancel');

  await page.goto(new URL('?officeDemo=busy&capture=member', base).toString(), { waitUntil: 'networkidle' });
  await intercept();
  const panel = page.locator('.member-panel');
  await panel.getByRole('button', { name: '중단', exact: true }).click();
  const memberDialog = page.getByRole('dialog', { name: '현재 작업 중단' });
  await memberDialog.getByRole('button', { name: '닫기' }).last().click();
  assert.equal((await page.evaluate(() => window.__interruptProbe)).length, 0);
  await panel.getByRole('button', { name: '중단', exact: true }).click();
  page.once('dialog', dialog => dialog.dismiss());
  await memberDialog.getByRole('button', { name: '작업 취소' }).click();
  assert.equal((await page.evaluate(() => window.__interruptProbe)).length, 0);
  page.once('dialog', dialog => dialog.accept());
  await memberDialog.getByRole('button', { name: '작업 취소' }).click();
  await page.waitForFunction(() => window.__interruptProbe.length === 1);
  assert.equal((await page.evaluate(() => window.__interruptProbe))[0][2], 'cancel');
  const report = { taskCloseCalls: 0, taskDismissCalls: 0, taskConfirmedMode: 'cancel',
    memberCloseCalls: 0, memberDismissCalls: 0, memberConfirmedMode: 'cancel' };
  if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally { await browser.close(); }
