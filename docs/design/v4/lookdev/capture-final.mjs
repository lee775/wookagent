import { createRequire } from 'node:module';
import { renameSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/pc_09/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright-core');
const out = new URL('.', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
const url = 'http://127.0.0.1:5199/?officeDemo=busy&studio3d=1';
const errors = [];
const browser = await chromium.launch({ headless: false, args: ['--enable-webgl', '--use-gl=angle', '--use-angle=d3d11'] });

async function open(viewport, video = false) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1,
    ...(video ? { recordVideo: { dir: out, size: viewport } } : {}) });
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', e => { if (e.type() === 'error') errors.push(e.text()); });
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.render_game_to_text && JSON.parse(window.render_game_to_text()).ready, { timeout: 15000 });
  return { context, page };
}

async function advanceTo(page, seconds) {
  await page.evaluate(t => {
    const now = JSON.parse(window.render_game_to_text()).time;
    window.advanceTime(Math.max(0, t - now) * 1000);
  }, seconds);
}

try {
  let { context, page } = await open({ width: 1440, height: 900 });
  await advanceTo(page, 1);
  await page.screenshot({ path: join(out, 'studio-1440.png') });
  for (const [name, time] of [['stand-up', 3.8], ['walking', 7.0], ['drinking', 10.2], ['sit-down', 17.1], ['seated-again', 18.3]]) {
    await advanceTo(page, time);
    await page.screenshot({ path: join(out, `${name}-1440.png`) });
  }
  await context.close();

  ({ context, page } = await open({ width: 1100, height: 900 }));
  await advanceTo(page, 1);
  await page.screenshot({ path: join(out, 'studio-1100.png') });
  await context.close();

  ({ context, page } = await open({ width: 1440, height: 900 }));
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  const metric = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
  const before = await metric();
  const t0 = Date.now();
  const fps = await page.evaluate(() => new Promise(resolve => {
    let frames = 0; const start = performance.now();
    const next = t => { frames++; if (t - start < 10000) requestAnimationFrame(next); else resolve(frames / ((t - start) / 1000)); };
    requestAnimationFrame(next);
  }));
  const elapsed = (Date.now() - t0) / 1000;
  const after = await metric();
  const gpu = await page.evaluate(() => {
    const canvas = document.querySelector('.office-scene canvas');
    const gl = canvas?.getContext('webgl2');
    const debug = gl?.getExtension('WEBGL_debug_renderer_info');
    return debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : 'unavailable';
  });
  console.log('PERFORMANCE', JSON.stringify({ fps: +fps.toFixed(1), seconds: elapsed,
    mainThreadBusy: +((after.TaskDuration - before.TaskDuration) / elapsed).toFixed(3),
    scriptBusy: +((after.ScriptDuration - before.ScriptDuration) / elapsed).toFixed(3), gpu }));
  await context.close();

  ({ context, page } = await open({ width: 1440, height: 900 }, true));
  await page.waitForTimeout(25000);
  const video = page.video();
  await context.close();
  renameSync(await video.path(), join(out, 'studio-demo-25fps.webm'));
  console.log('VIDEO', join(out, 'studio-demo-25fps.webm'));
  console.log('ERRORS', JSON.stringify(errors));
} finally {
  await browser.close();
}
