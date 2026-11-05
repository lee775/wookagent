import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/pc_09/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright-core');
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto('http://127.0.0.1:5199/?capture=poses', { waitUntil: 'networkidle' });
  const result = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.office-actor')].map(actor => {
      const pose = actor.getAttribute('data-pose');
      const view = actor.getAttribute('data-view');
      const mouths = [...actor.querySelectorAll('.mouth-smile, .mouth-neutral, .mouth-frown, .mouth-open')]
        .filter(node => getComputedStyle(node).display !== 'none' && node.getBoundingClientRect().width > 0);
      const feet = [...actor.querySelectorAll('.rig-foot')].map(node => node.getBoundingClientRect());
      const gap = feet.length === 2 ? Math.max(0, Math.max(feet[0].left, feet[1].left) - Math.min(feet[0].right, feet[1].right)) : 0;
      return { pose, view, visibleMouths: mouths.length, footGap: gap };
    });
    return { rows, mouthFailures: rows.filter(row => row.view !== 'back' && row.visibleMouths !== 1),
      legFailures: rows.filter(row => row.pose === 'walk' && ['front', 'back'].includes(row.view) && row.footGap < 4) };
  });
  writeFileSync('docs/design/v34/pose-probe.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ poses: result.rows.length, mouthFailures: result.mouthFailures.length,
    legFailures: result.legFailures.length, examples: [...result.mouthFailures, ...result.legFailures].slice(0, 4) }));
  if (result.mouthFailures.length || result.legFailures.length) process.exitCode = 1;
} finally { await browser.close(); }
