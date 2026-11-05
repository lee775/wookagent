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
const entries = [];
try {
  for (const [index, route] of routes.entries()) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: index === 8 ? 'reduce' : 'no-preference' });
    const page = await context.newPage();
    await page.goto(new URL(route, base).toString(), { waitUntil: 'networkidle' });
    await page.waitForTimeout(index === 4 ? 7600 : 600);
    entries.push(await page.evaluate(index => {
      const bodyText = document.body.innerText;
      const raw = [...bodyText.matchAll(/\b[PMTDR]-[0-9]{4}\b|TN-|\((?:low|medium|high)\)|win32|Job Object|2차/g)].map(match => match[0]);
      const fontUnder11 = [...document.querySelectorAll('*')].filter(node => {
        if (!node.childNodes.length || ![...node.childNodes].some(child => child.nodeType === 3 && child.textContent.trim())) return false;
        const r = node.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && +getComputedStyle(node).fontSize.replace('px', '') < 11;
      }).map(node => ({ text: node.textContent.trim().slice(0, 50), size: getComputedStyle(node).fontSize }));
      const headingRepeat = [...document.querySelectorAll('.page-heading')].filter(node => node.querySelector('.eyebrow')?.textContent.trim() === node.querySelector('h1')?.textContent.trim()).map(node => node.querySelector('h1')?.textContent.trim());
      const parse = value => (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
      const luminosity = channels => channels.map(value => { const c = value / 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; }).reduce((sum, value, channel) => sum + value * [.2126, .7152, .0722][channel], 0);
      const muted = [...document.querySelectorAll('.muted, small, .eyebrow')].filter(node => node.getBoundingClientRect().width > 0 && node.textContent.trim()).map(node => {
        const fg = parse(getComputedStyle(node).color);
        let parent = node;
        let bg = [225, 232, 238];
        while (parent) {
          const color = getComputedStyle(parent).backgroundColor;
          if (color && !color.endsWith(', 0)') && color !== 'transparent') { bg = parse(color); break; }
          parent = parent.parentElement;
        }
        const a = luminosity(fg), b = luminosity(bg);
        return { text: node.textContent.trim().slice(0, 40), ratio: +((Math.max(a, b) + .05) / (Math.min(a, b) + .05)).toFixed(2) };
      }).filter(item => item.ratio < 4.5);
      return { screen: `s${String(index + 1).padStart(2, '0')}`, raw, fontUnder11, headingRepeat, mutedBelow45: muted };
    }, index));
    await context.close();
  }
} finally { await browser.close(); }
const report = { screens: entries, rawCount: entries.reduce((sum, item) => sum + item.raw.length, 0),
  smallTextCount: entries.reduce((sum, item) => sum + item.fontUnder11.length, 0),
  mutedLowContrastCount: entries.reduce((sum, item) => sum + item.mutedBelow45.length, 0) };
if (output) writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
if (report.rawCount || report.smallTextCount || report.mutedLowContrastCount || entries.some(item => item.headingRepeat.length)) process.exitCode = 1;
