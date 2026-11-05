import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/pc_09/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright-core');
const width = Number(process.argv[2] ?? 1440);
const output = process.argv[3] ?? `docs/design/v34/motion-cycle-${width}.json`;
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await page.goto('http://127.0.0.1:5199/?officeDemo=cycle', { waitUntil: 'networkidle' });
  const result = await page.evaluate(() => new Promise(resolve => {
    const area = rect => Math.max(0, rect.width) * Math.max(0, rect.height);
    const overlap = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
      Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    const metrics = { width: window.innerWidth, durationMs: 64500, samples: 0, pops: 0, maxRigOffsetJump: 0,
      leglessOpenFloor: 0, legsOverHeads: 0, maxHeadCover: 0, depthFlips: 0,
      opacityDrops: 0, maxOpacityDrop: 0, boardBlocked: 0, hits: [] };
    const previous = new Map(), previousDepth = new Map();
    const start = performance.now();
    const interval = window.setInterval(() => {
      metrics.samples++;
      const now = performance.now() - start;
      const layer = document.querySelector('.office-depth-layer');
      const children = [...(layer?.children ?? [])];
      const actors = [...document.querySelectorAll('.office-scene .office-actor[data-member-id]')].map(node => {
        const id = node.getAttribute('data-member-id');
        const x = Number(node.getAttribute('data-seat-x'));
        const seatY = Number(node.getAttribute('data-seat-y'));
        const feetY = Number(node.getAttribute('data-feet-y'));
        const transform = node.style.transform.match(/translate\(([-\d.]+)px,\s*([-\d.]+)px\)/);
        const rigY = transform ? Number(transform[2]) : NaN;
        const head = node.querySelector('.rig-head')?.getBoundingClientRect();
        const legs = [...node.querySelectorAll('.rig-leg')].filter(leg => getComputedStyle(leg).display !== 'none')
          .map(leg => leg.getBoundingClientRect());
        const leg = legs.length ? { left: Math.min(...legs.map(rect => rect.left)), right: Math.max(...legs.map(rect => rect.right)),
          top: Math.min(...legs.map(rect => rect.top)), bottom: Math.max(...legs.map(rect => rect.bottom)) } : null;
        return { id, node, bounds: node.getBoundingClientRect(), x, seatY, feetY, rigY, head, leg, pose: node.getAttribute('data-pose'),
          seated: node.getAttribute('data-seated') === 'true', hidden: node.getAttribute('data-far-seat') === 'true',
          opacity: Number(getComputedStyle(node).opacity), order: children.indexOf(node) };
      });
      for (const actor of actors) {
        const prior = previous.get(actor.id);
        const offset = actor.rigY - actor.feetY;
        if (prior && Number.isFinite(offset) && Number.isFinite(prior.offset)) {
          const jump = Math.abs(offset - prior.offset);
          metrics.maxRigOffsetJump = Math.max(metrics.maxRigOffsetJump, jump);
          if (jump >= 8) { metrics.pops++; if (metrics.hits.length < 30) metrics.hits.push({ kind: 'pop', id: actor.id, at: now, jump }); }
          const drop = prior.opacity - actor.opacity;
          metrics.maxOpacityDrop = Math.max(metrics.maxOpacityDrop, drop);
          if (now - prior.at <= 75 && drop > .35) metrics.opacityDrops++;
        }
        previous.set(actor.id, { offset, opacity: actor.opacity, at: now });
        const rigX = Number(actor.node.style.transform.match(/translate\(([-\d.]+)px/)?.[1] ?? NaN) + 40;
        if (actor.hidden && (Math.abs(rigX - actor.x) > 43 || actor.feetY < actor.seatY - 35 || actor.feetY > 309))
          metrics.leglessOpenFloor++;
        if (actor.pose !== 'walk' || !actor.leg) continue;
        for (const other of actors) if (other.id !== actor.id && other.seated && other.head) {
          const cover = overlap(actor.leg, other.head) / Math.max(1, area(other.head));
          metrics.maxHeadCover = Math.max(metrics.maxHeadCover, cover);
          if (cover > .2) { metrics.legsOverHeads++; if (metrics.hits.length < 30) metrics.hits.push({ kind: 'head', walker: actor.id, sitter: other.id, at: now, cover }); }
        }
        for (const desk of children.filter(node => node.hasAttribute('data-desk'))) {
          const deskX = Number(desk.getAttribute('data-desk')?.split(':')[0]);
          if (Math.abs(rigX - deskX) > 80 || overlap(actor.bounds, desk.getBoundingClientRect()) <= 0) continue;
          const key = `${actor.id}:${desk.getAttribute('data-desk')}`;
          const order = actor.order - children.indexOf(desk);
          const old = previousDepth.get(key);
          if (old && Math.sign(old.order) !== Math.sign(order) && now - old.at < 250) {
            metrics.depthFlips++;
            if (metrics.hits.length < 30) metrics.hits.push({ kind: 'depth', id: actor.id, desk: desk.getAttribute('data-desk'), at: now });
          }
          previousDepth.set(key, { order, at: now });
        }
      }
      const boardLines = [...document.querySelectorAll('.office-svg text')].filter(node => node.getAttribute('x') === '432' &&
        ['96', '126', '100'].includes(node.getAttribute('y')));
      for (const line of boardLines) {
        const box = line.getBoundingClientRect();
        const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        if (top?.closest('.office-actor')) metrics.boardBlocked++;
      }
      if (now >= 64500) { window.clearInterval(interval); resolve(metrics); }
    }, 50);
  }));
  writeFileSync(output, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ...result, hits: undefined }));
  if (result.pops || result.leglessOpenFloor || result.legsOverHeads || result.depthFlips ||
    result.opacityDrops || result.boardBlocked) process.exitCode = 1;
  await page.close();
} finally { await browser.close(); }
