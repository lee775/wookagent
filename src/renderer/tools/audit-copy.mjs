import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/pc_09/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright-core');
const base = process.env.WOOK_RENDERER_URL ?? 'http://127.0.0.1:5199/';
const browser = await chromium.launch();
const results = [];
const bad = /\b(?:[PMTDR]-\d{4}|TN-[\w-]+|in_progress|in_review|on_hold|awaiting_confirmation|waiting|create|submit)\b/gi;
const scan = async (page, name) => {
  const text = await page.locator('body').innerText();
  results.push({ name, raw: [...text.matchAll(bad)].map(match => ({ value: match[0], context: text.slice(Math.max(0, match.index - 45), match.index + 45) })),
    particle: [...text.matchAll(/을\(를\)|이\(가\)|다\.[을를이가]/g)].map(match => text.slice(Math.max(0, (match.index ?? 0) - 35), (match.index ?? 0) + 35)), remote: text.includes('remote 이름'),
    names: (text.match(/하린|나래/g) ?? []).length });
};
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(new URL('?officeDemo=busy&capture=home', base).toString(), { waitUntil: 'networkidle' });
  await scan(page, 'home');
  await page.locator('.todo').filter({ hasText: '대표 검수' }).locator('button').click();
  await page.locator('.criterion-form select').first().waitFor();
  await scan(page, 'task');
  await page.goto(new URL('?officeDemo=busy&capture=member', base).toString(), { waitUntil: 'networkidle' });
  await scan(page, 'member');
  await page.goto(new URL('?officeDemo=busy', base).toString(), { waitUntil: 'networkidle' });
  await scan(page, 'studio');
  const directiveCount = await page.locator('.directive-title').count();
  for (let index = 0; index < directiveCount; index++) {
    await page.locator('.directive-title').nth(index).click();
    await page.locator('.modal').waitFor();
    await page.waitForFunction(() => !document.querySelector('.modal')?.textContent?.includes('불러오는 중'));
    await scan(page, `directive-${index + 1}`);
    await page.locator('.modal-header button').click();
    await page.locator('.modal').waitFor({ state: 'hidden' });
  }
  await page.goto(new URL('?officeDemo=busy', base).toString(), { waitUntil: 'networkidle' });
  await page.locator('.emergency-button').click();
  await page.getByRole('dialog', { name: '긴급 정지 결과' }).waitFor();
  await scan(page, 'emergency');
  if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results));
  if (results.some(result => result.raw.length || result.particle.length || result.remote)) process.exitCode = 1;
} finally { await browser.close(); }
