import { createRequire } from 'node:module';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/pc_09/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright-core');
const out = new URL('.', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
const browser = await chromium.launch({ headless: false, args: ['--enable-webgl', '--use-gl=angle', '--use-angle=d3d11'] });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:5199/?officeDemo=busy&studio3d=1', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.render_game_to_text && JSON.parse(window.render_game_to_text()).ready);
  for (const [name, time, clip] of [
    ['typist-2x.png', 1, { x: 568, y: 420, width: 245, height: 245 }],
    ['sit-down-2x.png', 17.1, { x: 625, y: 412, width: 245, height: 255 }],
  ]) {
    await page.evaluate(t => {
      const now = JSON.parse(window.render_game_to_text()).time;
      window.advanceTime(Math.max(0, t - now) * 1000);
    }, time);
    await page.screenshot({ path: join(out, name), clip });
  }
  await context.close();
} finally { await browser.close(); }
