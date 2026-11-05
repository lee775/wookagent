import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/pc_09/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright-core');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const periods = new Map();
let maxStationaryPlateMove = 0;
let stationarySamples = 0;
const worst = [];
try {
  await page.goto('http://127.0.0.1:5198/?officeDemo=cycle', { waitUntil: 'networkidle' });
  for (let sample = 0; sample < 220; sample++) {
    const data = await page.evaluate(() => {
      const scene = document.querySelector('.office-scene').getBoundingClientRect();
      const scale = scene.width / 1200;
      const point = node => { const r = node.getBoundingClientRect(); return { x: (r.left + r.width / 2 - scene.left) / scale, y: (r.top + r.height / 2 - scene.top) / scale }; };
      return [...document.querySelectorAll('.office-person-label')].filter(plate => getComputedStyle(plate).visibility === 'visible').map(plate => {
        const id = plate.querySelector('strong').textContent;
        const actor = [...document.querySelectorAll('.office-actor')].find(node => node.getAttribute('aria-label')?.startsWith(id));
        return { id, plate: point(plate), actor: point(actor.querySelector('.actor-hit')), phase: actor.dataset.pose, placement: plate.dataset.placement };
      });
    });
    for (const entry of data) {
      const previous = periods.get(entry.id);
      if (previous && previous.phase === entry.phase && previous.placement === entry.placement &&
          Math.hypot(entry.actor.x - previous.actor.x, entry.actor.y - previous.actor.y) <= 2) {
        const stationary = previous.count === 3 ? { ...previous, plate: entry.plate, count: 4 } :
          { ...previous, count: previous.count + 1 };
        periods.set(entry.id, stationary);
        if (stationary.count > 4) {
          stationarySamples++;
          const move = Math.hypot(entry.plate.x - stationary.plate.x, entry.plate.y - stationary.plate.y);
          maxStationaryPlateMove = Math.max(maxStationaryPlateMove, move);
          if (move > 8) worst.push({ sample, id: entry.id, phase: entry.phase, placement: entry.placement,
            move: +move.toFixed(2), from: stationary.plate, to: entry.plate, actor: entry.actor });
        }
      } else periods.set(entry.id, { ...entry, count: 0 });
    }
    if (sample < 219) await page.waitForTimeout(250);
  }
} finally { await browser.close(); }
const report = { durationSeconds: 55, stationarySamples, maxStationaryPlateMove: +maxStationaryPlateMove.toFixed(2),
  worst: worst.sort((a, b) => b.move - a.move).slice(0, 20), pass: maxStationaryPlateMove <= 8 };
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
if (!report.pass) process.exitCode = 1;
