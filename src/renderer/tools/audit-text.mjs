import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/pc_09/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright-core');
const base = process.env.WOOK_RENDERER_URL ?? 'http://127.0.0.1:5199/';
const screens = [
  ['s01', '?capture=login'], ['s02', '?officeDemo=busy&capture=home'], ['s03', '?officeDemo=idle'],
  ['s04', '?officeDemo=busy'], ['s05', '?officeDemo=events'], ['s06', '?officeDemo=busy&capture=member'],
  ['s07', '?officeDemo=busy&capture=documents'], ['s08', '?officeDemo=busy&capture=settings'],
  ['s09', '?officeDemo=busy'],
];
const browser = await chromium.launch();
const results = [];
try {
  for (const width of [1100, 1440]) for (const [name, route] of screens) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: name === 's09' ? 'reduce' : 'no-preference' });
    await page.goto(new URL(route, base).toString(), { waitUntil: 'networkidle' });
    const result = await page.evaluate(() => {
      const rgb = value => (value.match(/[\d.]+/g) ?? []).slice(0, 4).map(Number);
      const luminance = values => values.slice(0, 3).map(c => {
        const v = c / 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4;
      }).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
      const contrast = (a, b) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
      const visible = element => {
        const style = getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > .05 &&
          element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0;
      };
      const findings = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const content = node.textContent?.trim();
        if (!content || !node.parentElement || !visible(node.parentElement)) continue;
        const element = node.parentElement;
        const style = getComputedStyle(element);
        let size = parseFloat(style.fontSize);
        if (element instanceof SVGElement) {
          const matrix = element.getScreenCTM();
          if (matrix) size *= Math.hypot(matrix.a, matrix.b);
        }
        let background = element;
        while (background && rgb(getComputedStyle(background).backgroundColor)[3] === 0) background = background.parentElement;
        let bg = rgb(background ? getComputedStyle(background).backgroundColor : 'rgb(255,255,255)');
        if (element instanceof SVGElement) {
          const box = element.getBoundingClientRect();
          const cx = box.left + box.width / 2, cy = box.top + box.height / 2;
          const beneath = [...(element.ownerSVGElement?.querySelectorAll('rect') ?? [])].filter(rect =>
            Boolean(rect.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING) &&
            rect.getBoundingClientRect().left <= cx && rect.getBoundingClientRect().right >= cx &&
            rect.getBoundingClientRect().top <= cy && rect.getBoundingClientRect().bottom >= cy);
          if (beneath.length) bg = rgb(getComputedStyle(beneath.at(-1)).fill);
        }
        const fg = rgb(element instanceof SVGElement ? style.fill : style.color);
        const ratio = fg.length >= 3 && bg.length >= 3 ? contrast(fg, bg) : null;
        if (size < 11 || (ratio !== null && ratio < 4.5))
          findings.push({ text: content.slice(0, 35), tag: element.tagName, className: String(element.className?.baseVal ?? element.className ?? '').slice(0, 70),
            parent: String(element.parentElement?.className?.baseVal ?? element.parentElement?.className ?? '').slice(0, 70),
            fg: style.color, bg: background ? getComputedStyle(background).backgroundColor : 'rgb(255,255,255)',
            size: +size.toFixed(1), contrast: ratio === null ? null : +ratio.toFixed(2) });
      }
      return findings;
    });
    results.push({ name, width, findings: result });
    console.log(`${name} ${width}: ${result.length} findings`);
    await page.close();
  }
  const output = process.argv[2] ?? 'text-audit.json';
  writeFileSync(output, JSON.stringify(results, null, 2));
} finally { await browser.close(); }
