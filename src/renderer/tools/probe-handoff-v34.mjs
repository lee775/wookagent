import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/pc_09/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright-core');
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto('http://127.0.0.1:5199/?officeDemo=review', { waitUntil: 'networkidle' });
  const rows = [];
  const started = Date.now();
  while (Date.now() - started < 26_000) {
    rows.push(await page.evaluate(() => {
      const box = node => {
        if (!node) return null;
        const r = node.getBoundingClientRect();
        return r.width && r.height ? { left: r.left, right: r.right, top: r.top, bottom: r.bottom,
          cx: (r.left + r.right) / 2, cy: (r.top + r.bottom) / 2 } : null;
      };
      const overlap = (a, b) => a && b ? Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
        Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)) : 0;
      const plates = [...document.querySelectorAll('.office-person-label')].map(node => ({
        name: node.querySelector('strong')?.textContent, box: box(node) }));
      const folder = box(document.querySelector('.office-handoff-folder'));
      const people = ['하린', '유진'].map(name => {
        const node = [...document.querySelectorAll('.office-actor')].find(actor => actor.getAttribute('aria-label') === `${name} 열기`);
        const head = box(node?.querySelector('.rig-head'));
        const arms = [...(node?.querySelectorAll('.rig-arm') ?? [])].map(box);
        const hands = [...(node?.querySelectorAll('.rig-hand') ?? [])].map(box);
        const nameplate = plates.find(plate => plate.name === name)?.box;
        return { name, pose: node?.getAttribute('data-pose'), active: node?.getAttribute('data-handoff'),
          head, arms, hands, nameplate, plateState: document.querySelector(`.office-person-label[aria-label="${name} 팀원 상세 열기"] .office-person-state`)?.textContent,
          handCover: hands.map(hand => Math.max(...plates.map(plate => overlap(hand, plate.box) / Math.max(1, hand ? (hand.right - hand.left) * (hand.bottom - hand.top) : 1)), 0)) };
      });
      return { time: performance.now(), folder, folderCover: folder ? Math.max(...plates.map(plate => overlap(folder, plate.box) /
        Math.max(1, (folder.right - folder.left) * (folder.bottom - folder.top))), 0) : null, people };
    }));
    await page.waitForTimeout(100);
  }
  const active = rows.filter(row => row.folder && row.people.every(person => person.active === 'true'));
  const maxTravel = active.length ? Math.max(...active.map(a => Math.hypot(a.folder.cx - active[0].folder.cx, a.folder.cy - active[0].folder.cy))) : 0;
  const folderCover = Math.max(0, ...active.map(row => row.folderCover));
  const handCover = Math.max(0, ...active.flatMap(row => row.people.flatMap(person => person.handCover)));
  const reviewerMotion = new Set(active.map(row => JSON.stringify([row.people[1].head?.cx, row.people[1].head?.cy,
    row.people[1].arms.map(arm => [arm?.cx, arm?.cy])]))).size;
  const result = { samples: rows.length, activeSamples: active.length, maxTravel, folderCover, handCover, reviewerMotion, rows };
  writeFileSync('docs/design/v34/handoff-probe.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ samples: rows.length, activeSamples: active.length, maxTravel: +maxTravel.toFixed(1),
    folderCover: +folderCover.toFixed(3), handCover: +handCover.toFixed(3), reviewerMotion }));
  if (maxTravel < 20 || folderCover > .1 || handCover > .1 || reviewerMotion < active.length / 2) process.exitCode = 1;
} finally { await browser.close(); }
