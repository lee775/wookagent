import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/pc_09/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright-core');

const base = process.argv[2] ?? 'http://127.0.0.1:5198/';
const output = process.argv[3];
const browser = await chromium.launch();
const samples = [];
const scenes = [
  ['s04', 'busy', 2500, 1],
  ['s09', 'busy', 1800, 1],
  ['events', 'events', 4500, 1],
  ['walk', 'cycle', 1000, 12],
];
try {
  for (const [name, demo, initial, count] of scenes) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1,
      reducedMotion: name === 's09' ? 'reduce' : 'no-preference' });
    const page = await context.newPage();
    await page.goto(new URL(`?officeDemo=${demo}`, base).toString(), { waitUntil: 'networkidle' });
    await page.waitForTimeout(initial);
    for (let index = 0; index < count; index++) {
      const data = await page.evaluate(() => {
        const scene = document.querySelector('.office-scene').getBoundingClientRect();
        const scale = scene.width / 1200;
        const rect = element => {
          const r = element.getBoundingClientRect();
          return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, cx: (r.left + r.right) / 2, cy: (r.top + r.bottom) / 2 };
        };
        const distance = (point, box) => Math.hypot(Math.max(box.left - point.x, 0, point.x - box.right), Math.max(box.top - point.y, 0, point.y - box.bottom));
        const overlap = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
        const actors = [...document.querySelectorAll('.office-scene .office-actor')].map(node => ({
          name: node.getAttribute('aria-label')?.replace(' 열기', ''),
          head: rect(node.querySelector('.rig-head')), body: rect(node.querySelector('.rig-body')),
          feet: rect(node.querySelector('.actor-hit')).bottom,
          phase: node.dataset.pose, seated: node.dataset.seated,
        }));
        return [...document.querySelectorAll('.office-person-label')].filter(node => getComputedStyle(node).visibility === 'visible').map(node => {
          const name = node.querySelector('strong').textContent;
          const box = rect(node);
          const point = { x: box.cx, y: box.cy };
          const distances = actors.map(actor => ({ name: actor.name, d: Math.min(distance(point, actor.head), distance(point, actor.body)) }));
          distances.sort((a, b) => a.d - b.d);
          const owner = actors.find(actor => actor.name === name);
          const otherOverlap = Math.max(0, ...actors.filter(actor => actor.name !== name).flatMap(actor => [actor.head, actor.body].map(part => overlap(box, part) / Math.max(1, (part.right - part.left) * (part.bottom - part.top)))));
          return { name, nearest: distances[0]?.name, ownerDistance: Math.min(distance(point, owner.head), distance(point, owner.body)) / scale,
            otherOverlap: +otherOverlap.toFixed(3), floor: node.dataset.placement === 'floor', pose: owner.phase, seated: owner.seated,
            x: +((point.x - scene.left) / scale).toFixed(1), y: +((point.y - scene.top) / scale).toFixed(1),
            ownerBody: { x: +((owner.body.cx - scene.left) / scale).toFixed(1), y: +((owner.body.cy - scene.top) / scale).toFixed(1) },
            nearestBody: { x: +(((actors.find(actor => actor.name === distances[0]?.name)?.body.cx ?? 0) - scene.left) / scale).toFixed(1), y: +(((actors.find(actor => actor.name === distances[0]?.name)?.body.cy ?? 0) - scene.top) / scale).toFixed(1) } };
        });
      });
      samples.push({ scene: name, index, plates: data });
      if (index < count - 1) await page.waitForTimeout(800);
    }
    await context.close();
  }
} finally { await browser.close(); }
const plates = samples.flatMap(sample => sample.plates.map(plate => ({ ...plate, scene: sample.scene, index: sample.index })));
const failures = plates.filter(plate => plate.nearest !== plate.name || plate.otherOverlap > .1 || plate.ownerDistance > 60);
const report = { samples: samples.length, plates: plates.length, correctNearest: plates.filter(plate => plate.nearest === plate.name).length,
  maxOtherOverlap: Math.max(...plates.map(plate => plate.otherOverlap)), maxOwnerDistance: Math.max(...plates.map(plate => plate.ownerDistance)),
  failures: failures.slice(0, 50) };
if (output) writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
if (failures.length) process.exitCode = 1;
