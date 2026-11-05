import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/pc_09/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright-core');
const base = process.env.WOOK_RENDERER_URL ?? 'http://127.0.0.1:5199/';
const routes = [
  ['s01', '?capture=login'], ['s02', '?officeDemo=busy&capture=home'],
  ['s03', '?officeDemo=idle'], ['s04', '?officeDemo=busy'],
  ['s05', '?officeDemo=events'], ['s06', '?officeDemo=busy&capture=member'],
  ['s07', '?officeDemo=busy&capture=documents'], ['s08', '?officeDemo=busy&capture=settings'],
  ['s09', '?officeDemo=busy'],
];
const machine = /\b[TDRM]-\d{4}\b|이\(가\)|은\(는\)|을\(를\)|\b(?:in_progress|in_review|on_hold|awaiting_confirmation|planning|reporting|waiting|cancelled|done)\b|\bmerge\s*:/i;
const browser = await chromium.launch();
const findings = [];
const check = async (page, name) => {
  const text = await page.locator('body').innerText();
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  for (const line of lines) {
    if (machine.test(line)) findings.push({ screen: name, line, kind: 'machine text' });
  }
  const knownTitles = ['산책 장소 데이터 연결', '산책 기록 화면 · 2회차 보고', '기록 흐름 검수'];
  for (const line of lines) for (const title of knownTitles) {
    if (line.indexOf(title) >= 0 && line.indexOf(title, line.indexOf(title) + title.length) >= 0)
      findings.push({ screen: name, line, kind: 'repeated title' });
  }
};
try {
  for (const [name, route] of routes) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    await page.goto(new URL(route, base).toString(), { waitUntil: 'networkidle' });
    await check(page, name);
    await page.close();
  }
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(new URL('?officeDemo=busy&capture=settings', base).toString(), { waitUntil: 'networkidle' });
  await page.locator('.settings-nav button', { hasText: '기록' }).first().click();
  await page.locator('tbody tr').first().waitFor();
  await check(page, 'settings-logs');
  await page.goto(new URL('?officeDemo=busy&capture=home', base).toString(), { waitUntil: 'networkidle' });
  await page.locator('.project-card').first().click();
  await page.locator('.member-card', { hasText: '담이' }).click();
  await page.locator('.member-panel .member-hero h2').waitFor();
  await check(page, 'member-panel');
  await page.locator('.member-panel textarea[placeholder*="에게 전달할 내용"]').fill('검수 상태를 알려 주세요.');
  await page.locator('.member-panel button', { hasText: '메시지 보내기' }).click();
  await page.locator('.member-panel [role="status"]').waitFor();
  await check(page, 'member-send-note');
  await page.locator('.member-panel .slide-head button').click();
  await page.getByRole('button', { name: '긴급 정지' }).click();
  await page.locator('.emergency-result').waitFor();
  await check(page, 'emergency-dialog');
  await page.close();
  assert.deepEqual(findings, [], JSON.stringify(findings, null, 2));
  console.log(JSON.stringify({ scanned: [...routes.map(([name]) => name), 'settings-logs', 'member-panel', 'member-send-note', 'emergency-dialog'], findings: 0 }));
} finally { await browser.close(); }
