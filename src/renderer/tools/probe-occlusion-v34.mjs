// Read-only paint-order probe for the 욱채 office.
// For each actor, samples points on its painted head and torso and records which element is painted on top.
// usage: node probe-occlusion-v34.mjs <url> <out.json> <waitMs> <samples> <everyMs> [gridPx] [width]
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/pc_09/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright-core');
const [url, out, waitMs = '3000', samples = '1', everyMs = '1000', gridPx = '2', width = '1440'] = process.argv.slice(2);
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: Number(width), height: 900 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(url, { waitUntil: 'networkidle' });
const t0 = Date.now();
await page.waitForTimeout(Number(waitMs));
const rows = [];
for (let i = 0; i < Number(samples); i++) {
  const row = await page.evaluate((grid) => {
    // make every SVG shape hit-testable, ignore transparent hit boxes and the HTML plates
    if (!document.getElementById('probe-style')) {
      const s = document.createElement('style'); s.id = 'probe-style';
      s.textContent = '.office-svg, .office-svg * { pointer-events: visiblePainted !important; } .office-svg .actor-hit { pointer-events: none !important; } .office-label-layer, .office-stop-notice, .office-caption { pointer-events: none !important; }';
      document.head.appendChild(s);
    }
    const svg = document.querySelector('.office-svg');
    const layer = document.querySelector('.office-depth-layer');
    const order = layer ? [...layer.children].map(n => n.classList.contains('office-actor') ? 'A:' + n.getAttribute('aria-label').replace(' 열기', '') : n.hasAttribute('data-chair') ? 'C:' + n.getAttribute('data-chair') : 'D:' + (n.querySelector('.desk-number')?.textContent ?? '?')) : [];
    const kindOf = (el) => {
      if (!el || !svg.contains(el)) return 'html';
      const actor = el.closest('.office-actor');
      if (actor) return 'A:' + actor.getAttribute('aria-label').replace(' 열기', '');
      const chair = el.closest('[data-chair]');
      if (chair) { const [x, y] = chair.getAttribute('data-chair').split(':'); return (Number(y) < 400 ? 'farChair:' : 'nearChair:') + x; }
      const desk = el.closest('.office-depth-layer > g');
      if (desk) { const n = desk.querySelector('.desk-number')?.textContent ?? '?'; return (Number(n) <= 6 ? 'farDesk:' : 'nearDesk:') + n; }
      if (el.closest('.office-sofa-layer')) return 'sofaLayer';
      return 'room';
    };
    const actors = [...document.querySelectorAll('.office-actor')].map(node => {
      const name = node.getAttribute('aria-label').replace(' 열기', '');
      const res = { name, pose: node.getAttribute('data-pose'), view: node.getAttribute('data-view'), seated: node.getAttribute('data-seated'), feetY: Number(node.getAttribute('data-feet-y')), farSeat: node.getAttribute('data-far-seat'), parts: {} };
      for (const part of ['rig-head', 'rig-body']) {
        const target = node.querySelector('.' + part);
        if (!target) continue;
        const r = target.getBoundingClientRect();
        let own = 0; const covers = {};
        for (let y = r.top + grid / 2; y < r.bottom; y += grid) for (let x = r.left + grid / 2; x < r.right; x += grid) {
          const stack = document.elementsFromPoint(x, y).filter(el => svg.contains(el) && !el.classList.contains('actor-hit'));
          const mine = stack.findIndex(el => target.contains(el));
          if (mine < 0) continue; // this part is not painted at this point
          own++;
          if (mine === 0) continue;
          const k = kindOf(stack[0]);
          if (k === 'A:' + name) continue; // covered by own arm/hand etc.
          covers[k] = (covers[k] ?? 0) + 1;
        }
        res.parts[part] = { own, covers, box: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)] };
      }
      const st = node.getAttribute('style') || '';
      const m = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(st);
      res.origin = m ? [Number(m[1]), Number(m[2])] : null;
      return res;
    });
    return { order, actors, emergency: !!document.querySelector('.office-stop-overlay') };
  }, Number(gridPx));
  rows.push({ t: Date.now() - t0, ...row });
  if (i + 1 < Number(samples)) await page.waitForTimeout(Number(everyMs));
}
writeFileSync(out, JSON.stringify({ url, startedAt: t0, errors, rows }, null, 0));
console.log('samples', rows.length, 'errors', errors.length);
await browser.close();
