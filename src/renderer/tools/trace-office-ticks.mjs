import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/pc_09/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright-core');
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto('http://127.0.0.1:5199/?officeDemo=busy', { waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);
  const result = await page.evaluate(async () => {
    const counts = { actorStyle: 0, plateStyle: 0, child: 0, other: 0 };
    const observer = new MutationObserver(mutations => mutations.forEach(m => {
      if (m.type === 'childList') counts.child++;
      else if (m.target.matches?.('.office-actor') && m.attributeName === 'style') counts.actorStyle++;
      else if (m.target.matches?.('.office-person-label') && m.attributeName === 'style') counts.plateStyle++;
      else counts.other++;
    }));
    observer.observe(document.querySelector('.office-scene'), { subtree: true, attributes: true, childList: true });
    await new Promise(done => setTimeout(done, 3000));
    observer.disconnect();
    return counts;
  });
  console.log(result);
} finally { await browser.close(); }
