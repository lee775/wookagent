import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/pc_09/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright-core');
const base = process.env.WOOK_RENDERER_URL ?? 'http://127.0.0.1:5199/';
const browser = await chromium.launch();
const fonts = {};
async function platformFonts(page, selector) {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    const { root } = await cdp.send('DOM.getDocument');
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector });
    assert.ok(nodeId, `${selector} missing`);
    const result = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
    return result.fonts.map(font => font.familyName);
  } finally { await cdp.detach(); }
}
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(5000);
  await page.goto(new URL('?officeDemo=busy&capture=documents', base).toString(), { waitUntil: 'networkidle' });
  await page.locator('.report-body .markdown code').first().waitFor();
  const tree = await page.locator('.tree-group button').allTextContents();
  assert.ok(tree.every(label => !/(\d+)회차.*\1회차/.test(label)), `duplicate round in tree: ${tree}`);
  const treeFits = await page.locator('.tree-group button').evaluateAll(buttons => buttons.every(button => button.scrollHeight <= button.clientHeight + 2));
  assert.equal(treeFits, true, 'tree report names are clipped');
  for (const heading of ['확인 방법', '결과']) {
    const item = page.locator('.report-body h2', { hasText: heading }).first();
    await item.scrollIntoViewIfNeeded();
    const clear = await item.evaluate(node => {
      const headingBox = node.getBoundingClientRect();
      const body = node.closest('.report-body').getBoundingClientRect();
      return headingBox.top >= body.top && headingBox.bottom <= body.bottom;
    });
    assert.equal(clear, true, `${heading} heading is cut by the footer`);
  }
  fonts.markdownCode = await platformFonts(page, '.report-body .markdown code');
  await page.locator('.compare-box select').selectOption('R-0005');
  await page.locator('.comparison .markdown').first().waitFor();
  assert.ok(await page.locator('.comparison h2').count(), 'comparison exposes raw markdown headings');
  assert.ok(!(await page.locator('.comparison').innerText()).includes('## '));
  fonts.comparison = await platformFonts(page, '.comparison .markdown');
  await page.goto(new URL('?officeDemo=busy&capture=home', base).toString(), { waitUntil: 'networkidle' });
  await page.locator('.todo', { hasText: '대표 검수' }).getByRole('button', { name: '열기' }).click();
  await page.locator('.diff-view pre').waitFor();
  fonts.diff = await platformFonts(page, '.diff-view pre');
  await page.locator('.modal-header button').click();
  await page.locator('.project-card').first().click();
  await page.locator('.member-card', { hasText: '시안' }).click();
  await page.locator('.cli-event').first().waitFor();
  fonts.cli = await platformFonts(page, await page.locator('.cli-event code').count() ? '.cli-event code' : '.cli-event');
  await page.goto(new URL('?officeDemo=busy&capture=settings', base).toString(), { waitUntil: 'networkidle' });
  await page.locator('.settings-nav button', { hasText: '실행 정책·정지' }).click();
  await page.locator('.recovery-card code').waitFor();
  fonts.recovery = await platformFonts(page, '.recovery-card code');
  assert.ok(Object.values(fonts).flat().every(name => !/Gulim/i.test(name)), JSON.stringify(fonts));
  console.log(JSON.stringify({ treeFits, comparisonMarkdown: true, headingsClear: true, fonts }));
  await page.close();
} finally { await browser.close(); }
