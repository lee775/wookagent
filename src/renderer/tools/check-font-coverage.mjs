import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/pc_09/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright-core');
const [url = 'http://127.0.0.1:5199/?officeDemo=busy&capture=documents', output] = process.argv.slice(2);
const decoder = new TextDecoder('euc-kr');
let syllables = '';
for (let lead = 0xb0; lead <= 0xc8; lead++) for (let trail = 0xa1; trail <= 0xfe; trail++)
  syllables += decoder.decode(Uint8Array.from([lead, trail]));
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.evaluate(text => {
    const host = document.querySelector('.report-body .markdown') ?? document.body;
    const probe = document.createElement('p');
    probe.id = 'font-coverage-probe';
    probe.textContent = text;
    probe.style.fontFamily = 'Pretendard Variable';
    host.append(probe);
  }, syllables);
  await page.evaluate(() => document.fonts.ready);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('DOM.enable');
  await cdp.send('CSS.enable');
  const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#font-coverage-probe' });
  const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
  const report = { syllables: syllables.length, fonts, fallback: fonts.filter(font => !font.familyName.includes('Pretendard')) };
  if (output) writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ syllables: report.syllables, glyphs: fonts.reduce((sum, font) => sum + font.glyphCount, 0), fallback: report.fallback }));
  if (report.syllables !== 2350 || report.fallback.length) process.exitCode = 1;
} finally { await browser.close(); }
