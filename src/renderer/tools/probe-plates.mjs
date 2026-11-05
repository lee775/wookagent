import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/pc_09/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright-core');
const [url, secondsText = '58', output = 'plate-probe.json', widthText = '1440', delayText = '0'] = process.argv.slice(2);
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: Number(widthText), height: 900 }, deviceScaleFactor: 1 });
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => {
    const actors = [...document.querySelectorAll('.office-actor')];
    return actors.length > 0 && actors.length === document.querySelectorAll('.office-person-label').length &&
      actors.every(actor => actor.dataset.feetY);
  });
  if (Number(delayText) > 0) await page.waitForTimeout(Number(delayText));
  const result = await page.evaluate(async duration => {
    const failures = [];
    const scene = document.querySelector('.office-scene');
    const started = performance.now();
    let samples = 0, plates = 0, visible = 0, owned = 0, maxOtherCover = 0, maxDistance = 0, overflows = 0, stopHits = 0;
    const invalid = [];
    const rect = element => element.getBoundingClientRect();
    const intersect = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
      Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    const merged = (a, b) => ({ left: Math.min(a.left, b.left), top: Math.min(a.top, b.top),
      right: Math.max(a.right, b.right), bottom: Math.max(a.bottom, b.bottom) });
    while (performance.now() - started < duration * 1000) {
      const scale = rect(scene).width / 1200;
      const actors = [...document.querySelectorAll('.office-actor')].map(node => {
        const head = node.querySelector('.rig-head');
        const body = node.querySelector('.rig-body');
        return { name: node.getAttribute('aria-label')?.replace(' 열기', ''), box: merged(rect(head), rect(body)),
          feetY: Number(node.dataset.feetY), x: Number(/translate(?:3d)?\(([-\d.]+)/.exec(node.style.transform || node.getAttribute('transform') || '')?.[1] ?? 0) + 40 };
      });
      const notice = document.querySelector('.office-stop-notice');
      for (const plate of document.querySelectorAll('.office-person-label')) {
        plates++;
        const name = plate.querySelector('strong')?.textContent;
        const actor = actors.find(item => item.name === name);
        const box = rect(plate);
        const style = getComputedStyle(plate);
        const shown = !!actor && box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > .95;
        if (shown) visible++;
        const ownerX = rect(scene).left + actor.x * scale;
        const ownerY = rect(scene).top + actor.feetY * scale;
        const distance = Math.hypot((box.left + box.right) / 2 - ownerX, (box.top + box.bottom) / 2 - ownerY) / scale;
        maxDistance = Math.max(maxDistance, distance);
        if (distance <= 60) owned++;
        if (!Number.isFinite(distance) && invalid.length < 12) invalid.push({ name, feetY: actor?.feetY, x: actor?.x,
          transform: document.querySelector(`.office-actor[aria-label^="${name}"]`)?.style.transform });
        const state = plate.querySelector('.office-person-state');
        const overflow = state.scrollWidth > state.clientWidth + 1 || /니다\.?$/.test(state.textContent ?? '');
        if (overflow) overflows++;
        const cover = actors.filter(item => item.name !== name).map(item => ({ name: item.name,
          fraction: intersect(box, item.box) / Math.max(1, (item.box.right - item.box.left) * (item.box.bottom - item.box.top)) }))
          .sort((a, b) => b.fraction - a.fraction)[0];
        const otherCover = cover?.fraction ?? 0;
        maxOtherCover = Math.max(maxOtherCover, otherCover);
        const hitNotice = notice && intersect(box, rect(notice)) > 0;
        if (hitNotice) stopHits++;
        if ((!shown || distance > 60 || overflow || otherCover > .1 || hitNotice) && failures.length < 120)
          failures.push({ at: Math.round(performance.now() - started), name, shown, distance: +distance.toFixed(1), overflow,
            otherCover: +otherCover.toFixed(2), covered: cover?.name, plateBox: { x: Math.round(box.left), y: Math.round(box.top), w: Math.round(box.width), h: Math.round(box.height) },
            owner: { x: Math.round(ownerX), y: Math.round(ownerY) },
            coveredBox: actors.find(item => item.name === cover?.name)?.box, stopHit: !!hitNotice });
      }
      samples++;
      await new Promise(done => setTimeout(done, 100));
    }
    return { samples, plates, visible, owned, maxDistance, maxOtherCover, overflows, stopHits, invalid, failures };
  }, Number(secondsText));
  writeFileSync(output, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ samples: result.samples, plates: result.plates, visible: result.visible, owned: result.owned,
    maxDistance: result.maxDistance, maxOtherCover: result.maxOtherCover, overflows: result.overflows, stopHits: result.stopHits,
    invalid: result.invalid.length, failures: result.failures.length }));
  if (result.visible !== result.plates || result.owned !== result.plates || result.invalid.length || result.overflows || result.stopHits || result.maxOtherCover > .1) process.exitCode = 1;
} finally { await browser.close(); }
