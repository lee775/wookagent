import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/pc_09/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright-core');
const browser = await chromium.launch();
const base = process.argv[2] ?? 'http://127.0.0.1:5198/';
const output = process.argv[3];
const routes = [
  '?capture=login', '?officeDemo=busy&capture=home', '?officeDemo=idle', '?officeDemo=busy',
  '?officeDemo=events', '?officeDemo=busy&capture=member', '?officeDemo=busy&capture=documents',
  '?officeDemo=busy&capture=settings', '?officeDemo=busy',
];
const scanned = [];
const failures = [];
try {
  for (const [index, route] of routes.entries()) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(new URL(route, base).toString(), { waitUntil: 'networkidle' });
    await page.waitForTimeout(index === 4 ? 1500 : 300);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    const visit = async (node, parent) => {
      if (node.nodeType === 3 && /^[가-힣\s]+$/.test(node.nodeValue ?? '') && /[가-힣]/.test(node.nodeValue ?? '')) {
        const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId: parent.nodeId });
        if (fonts.length) {
          const entry = { screen: `s${String(index + 1).padStart(2, '0')}`, text: node.nodeValue.trim().slice(0, 50), fonts: fonts.map(font => font.familyName) };
          scanned.push(entry);
          if (fonts.some(font => !font.familyName.includes('Pretendard'))) failures.push(entry);
        }
      }
      for (const child of node.children ?? []) await visit(child, node);
    };
    await visit(root, root);
    await page.close();
  }
} finally { await browser.close(); }
const report = { scanned: scanned.length, screens: routes.length, failures: failures.slice(0, 40) };
if (output) writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
if (failures.length) process.exitCode = 1;
