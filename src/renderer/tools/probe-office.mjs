import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/pc_09/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright-core');
const [url, seconds, out] = [process.argv[2], Number(process.argv[3] ?? 30), process.argv[4] ?? 'probe.json'];
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(url, { waitUntil: 'networkidle' });
const t0 = Date.now();
const data = await page.evaluate(async (ms) => {
  const rows = [];
  const start = performance.now();
  const svg = document.querySelector('.office-svg');
  const scene = svg.getBoundingClientRect();
  const sx = 1200 / scene.width, sy = 610 / scene.height;
  const box = element => {
    const rect = element.getBoundingClientRect();
    return [(rect.left - scene.left) * sx, (rect.top - scene.top) * sy,
      (rect.right - scene.left) * sx, (rect.bottom - scene.top) * sy];
  };
  return await new Promise(resolve => {
    const step = () => {
      const t = performance.now() - start;
      const nodes = document.querySelectorAll('.office-depth-layer .office-actor, .office-sofa-layer .office-actor');
      const list = [];
      nodes.forEach((n, order) => {
        const st = n.getAttribute('style') || '';
        const m = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(st);
        const sw = /--swing:\s*([-\d.]+)deg/.exec(st);
        const ar = /--arm:\s*([-\d.]+)deg/.exec(st);
        const dir = n.querySelector('.actor-direction')?.getAttribute('transform') || '';
        const head = box(n.querySelector('.rig-head'));
        const body = box(n.querySelector('.rig-body'));
        list.push([n.getAttribute('aria-label').replace(' 열기', ''), n.getAttribute('data-pose'), n.dataset.pendingPose || '', n.getAttribute('data-view'), n.getAttribute('data-seated'), m ? +m[1] : null, m ? +m[2] : null, sw ? +sw[1] : null, n.classList.contains('pose-changing') ? 1 : 0, n.parentNode.classList.contains('office-sofa-layer') ? 'S' : 'A', order, dir ? -1 : 1, ar ? +ar[1] : null,
          [Math.min(head[0], body[0]), Math.min(head[1], body[1]), Math.max(head[2], body[2]), Math.max(head[3], body[3])],
          [+n.dataset.seatX, +n.dataset.seatY], +n.dataset.feetY, n.dataset.farSeat === 'true']);
      });
      const labels = [...document.querySelectorAll('.office-person-label')].map(b => [b.querySelector('strong')?.textContent, b.querySelector('.office-person-state')?.textContent]);
      rows.push([Math.round(t), Date.now(), list, rows.length % 30 === 0 ? labels : null, !!document.querySelector('.office-stop-overlay')]);
      if (t < ms) requestAnimationFrame(step); else resolve(rows);
    };
    requestAnimationFrame(step);
  });
}, seconds * 1000);
writeFileSync(out, JSON.stringify({ startedAt: t0, errors, rows: data }));
console.log('rows', data.length, 'errors', errors.length);
await browser.close();
