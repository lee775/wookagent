import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/pc_09/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright-core');
const [query = 'cycle', widthText = '1440', secondsText = '64', out = 'docs/design/v34/plates.json'] = process.argv.slice(2);
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: Number(widthText), height: 900 }, deviceScaleFactor: 1 });
  await page.goto(`http://127.0.0.1:5199/?officeDemo=${query}`, { waitUntil: 'networkidle' });
  await page.locator('.office-person-label').first().waitFor();
  const rect = async () => page.evaluate(() => {
    const box = node => { const r = node.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; };
    const origin = box(document.querySelector('.office-scene'));
    const local = r => ({ left: r.left - origin.left, top: r.top - origin.top,
      right: r.right - origin.left, bottom: r.bottom - origin.top });
    const labels = [...document.querySelectorAll('.office-person-label')];
    const plates = labels.map(label => {
      const name = label.querySelector('strong')?.textContent ?? '';
      const actor = [...document.querySelectorAll('.office-actor')].find(node => node.getAttribute('aria-label') === `${name} 열기`);
      const r = box(label);
      const positions = [[.2, .2], [.5, .5], [.8, .8]];
      const painted = positions.filter(([fx, fy]) => {
        const hit = document.elementFromPoint(r.left + (r.right - r.left) * fx, r.top + (r.bottom - r.top) * fy);
        return hit === label || label.contains(hit);
      }).length;
      return { name, state: label.querySelector('.office-person-state')?.textContent ?? '', rect: local(r),
        head: actor?.querySelector('.rig-head') ? local(box(actor.querySelector('.rig-head'))) : null,
        painted, phase: label.dataset.actorPhase, slot: label.dataset.slot, placement: label.dataset.placement };
    });
    const dialog = [...document.querySelectorAll('.modal, [role="dialog"], [role="alertdialog"]')]
      .some(node => { const style = getComputedStyle(node); return style.display !== 'none' && style.visibility !== 'hidden'; });
    return { plates, time: performance.now(), dialog };
  });
  const hits = [];
  const previous = new Map();
  let maxOverlap = 0, maxOwnerHead = 0, maxJump = 0, unpainted = 0, samples = 0;
  const intersect = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
    Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  const area = a => Math.max(1, (a.right - a.left) * (a.bottom - a.top));
  const until = Date.now() + Number(secondsText) * 1000;
  while (Date.now() < until) {
    const frame = await rect();
    samples++;
    for (const plate of frame.plates) {
      if (plate.painted < 2 && !frame.dialog) {
        unpainted++;
        if (hits.length < 30) hits.push({ kind: 'unpainted', name: plate.name, painted: plate.painted,
          time: +frame.time.toFixed(1), rect: plate.rect, phase: plate.phase, placement: plate.placement });
      }
      if (plate.head) {
        const cover = intersect(plate.rect, plate.head) / area(plate.head);
        maxOwnerHead = Math.max(maxOwnerHead, cover);
        if (cover > .05 && hits.length < 30) hits.push({ kind: 'head', name: plate.name, cover: +cover.toFixed(3), phase: plate.phase, placement: plate.placement });
      }
      const before = previous.get(plate.name);
      if (before && frame.time - before.time <= 600 && before.phase === plate.phase && !['walking', 'rising', 'lowering'].includes(plate.phase)) {
        const jump = Math.hypot(plate.rect.left - before.rect.left, plate.rect.top - before.rect.top);
        if (jump > maxJump) maxJump = jump;
        if (jump > 20 && hits.length < 30) hits.push({ kind: 'jump', name: plate.name, jump: +jump.toFixed(1), phase: plate.phase,
          from: before.placement, to: plate.placement, fromSlot: before.slot, toSlot: plate.slot,
          fromPoint: [before.rect.left, before.rect.top], toPoint: [plate.rect.left, plate.rect.top] });
      }
      previous.set(plate.name, { ...plate, time: frame.time });
    }
    for (let i = 0; i < frame.plates.length; i++) for (let j = i + 1; j < frame.plates.length; j++) {
      const a = frame.plates[i], b = frame.plates[j];
      const ratio = intersect(a.rect, b.rect) / Math.min(area(a.rect), area(b.rect));
      maxOverlap = Math.max(maxOverlap, ratio);
      if (ratio > .05 && hits.length < 30) hits.push({ kind: 'overlap', a: a.name, b: b.name, ratio: +ratio.toFixed(3),
        time: +frame.time.toFixed(1), aRect: a.rect, bRect: b.rect });
    }
    await page.waitForTimeout(100);
  }
  const hover = await page.evaluate(() => [...document.querySelectorAll('.office-person-label')].map(label => {
    label.focus();
    const card = label.querySelector('.office-person-card');
    const r = card.getBoundingClientRect();
    card.style.pointerEvents = 'auto';
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    const onTop = card === hit || card.contains(hit) || label === hit;
    card.style.pointerEvents = '';
    return { name: label.querySelector('strong')?.textContent, onTop };
  }));
  const result = { query, width: Number(widthText), seconds: Number(secondsText), samples,
    maxOverlap, maxOwnerHead, maxJump, unpainted, hover, hits };
  writeFileSync(out, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ query, width: Number(widthText), samples, maxOverlap: +maxOverlap.toFixed(3),
    maxOwnerHead: +maxOwnerHead.toFixed(3), maxJump: +maxJump.toFixed(1), unpainted,
    hoverFailures: hover.filter(item => !item.onTop).length }));
  if (maxOverlap > .05 || maxOwnerHead > .05 || maxJump > 20 || unpainted || hover.some(item => !item.onTop)) process.exitCode = 1;
} finally { await browser.close(); }
