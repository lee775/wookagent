// Reproducible browser geometry and typography check for the studio at three widths.
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/pc_09/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright-core');
const output = resolve('docs/design/v31');
const baseUrl = process.env.WOOK_RENDERER_URL ?? 'http://127.0.0.1:5199/';
const browser = await chromium.launch();
const results = [];
try {
  const cases = [1100, 1440, 1920].map(width => ({ width, mode: 'busy' })).concat(['idle', 'events', 'emergency'].map(mode => ({ width: 1440, mode })));
  for (const { width, mode } of cases) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
    await page.goto(new URL(`?officeDemo=${mode}`, baseUrl).toString(), { waitUntil: 'networkidle' });
    await page.waitForTimeout(1600);
    if (mode === 'busy' && width !== 1440) await page.screenshot({ path: resolve(output, `s04-studio-busy-${width}.png`) });
    const result = await page.evaluate(() => {
      const scene = document.querySelector('.office-scene');
      const svg = scene.querySelector('svg.office-svg');
      const scale = svg.getBoundingClientRect().width / 1200;
      const plates = [...scene.querySelectorAll('.office-person-label')].filter(el => getComputedStyle(el).display !== 'none');
      const boxes = plates.map(el => { const r = el.getBoundingClientRect(); return { name: el.querySelector('strong')?.textContent, left: r.left, right: r.right, top: r.top, bottom: r.bottom }; });
      const overlaps = boxes.flatMap((a, i) => boxes.slice(i + 1).filter(b => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top).map(b => `${a.name}/${b.name}`));
      const text = [...scene.querySelectorAll('svg text, .office-person-label strong, .office-person-state, .office-caption')].filter(el => el.textContent?.trim()).map(el => ({ value: el.textContent.trim().slice(0, 24), px: Math.round(parseFloat(getComputedStyle(el).fontSize) * (el instanceof SVGElement ? scale : 1) * 100) / 100 }));
      const animations = [...document.querySelectorAll('*')].filter(el => getComputedStyle(el).animationName !== 'none').reduce((counts, el) => { const name = getComputedStyle(el).animationName; counts[name] = (counts[name] ?? 0) + 1; return counts; }, {});
      const transitions = [...scene.querySelectorAll('*')].filter(el => getComputedStyle(el).transitionDuration !== '0s').reduce((counts, el) => { const key = `${el.tagName}.${String(el.getAttribute('class') ?? '').slice(0, 50)}`; counts[key] = (counts[key] ?? 0) + 1; return counts; }, {});
      return { sceneWidth: scene.getBoundingClientRect().width, labelCount: boxes.length, overlaps, minTextPx: Math.min(...text.map(item => item.px)), smallText: text.filter(item => item.px < 11), animations, transitions };
    });
    results.push({ width, mode, ...result });
    await page.close();
  }
} finally { await browser.close(); }
writeFileSync(resolve(output, 'browser-check.json'), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
if (results.some(result => result.overlaps.length || result.minTextPx < 11)) process.exitCode = 1;
