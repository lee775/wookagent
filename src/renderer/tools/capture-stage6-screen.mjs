import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, sep } from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';

const tempRoot = resolve(tmpdir()), temp = mkdtempSync(resolve(tempRoot, 'wook-stage6-screen-'));
const output = resolve('docs/design/permission-ui/stage6-screen'); mkdirSync(output, { recursive: true });
const audits = [], errors = [];
let server, chrome, browser;
const pause = ms => new Promise(done => setTimeout(done, ms));
try {
  server = await createServer({ configFile: resolve('vite.web.config.ts'), configLoader: 'runner', cacheDir: resolve(temp, 'vite'), server: { host: '127.0.0.1', port: 5196, strictPort: true } });
  await server.listen();
  chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', '--disable-gpu', '--disable-gpu-sandbox', '--no-sandbox', '--in-process-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${resolve(temp, 'chrome')}`, 'about:blank'], { windowsHide: true, stdio: 'ignore', env: { ...process.env, TMP: temp, TEMP: temp } });
  const portFile = resolve(temp, 'chrome/DevToolsActivePort');
  for (let retry = 0; retry < 100 && !existsSync(portFile); retry++) await pause(100);
  if (!existsSync(portFile)) throw new Error('Headless Chrome did not start');
  const port = Number(readFileSync(portFile, 'utf8').split('\n')[0]);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = browser.contexts()[0].pages()[0];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  async function open(width, scenario) {
    await page.setViewportSize({ width, height: 1100 });
    await page.goto(`http://127.0.0.1:5196/?studio3d=0&fakeScreen=${scenario}`);
    await page.locator('.login-dev').click();
    await page.locator('.seat-chip').waitFor();
    await page.evaluate(async () => {
      const { fakeBridge } = await import('/src/api/fake/index.ts');
      window.__calls = []; window.__expire = false;
      window.wook = { ...fakeBridge, invoke: async (method, ...args) => {
        window.__calls.push({ method, args });
        const value = await fakeBridge.invoke(method, ...args);
        if (method === 'screens.recent' && window.__expire) value.captures = value.captures.map(row => ({ ...row, kept: false }));
        return value;
      } };
    });
    const chip = page.locator('.screen-chip');
    if (await chip.count()) await chip.click();
    else { await page.locator('.nav-item').filter({ hasText: '자리와 인계' }).click(); await page.getByRole('tab', { name: '화면 조작', exact: true }).click(); }
    await page.locator('.screen-captures li').first().waitFor();
  }
  async function shot(name, width, selector, expected) {
    const target = page.locator(selector);
    await target.scrollIntoViewIfNeeded(); await page.evaluate(() => document.fonts.ready); await pause(120);
    const audit = await target.evaluate(element => {
      const main = document.querySelector('.main-content');
      const chip = document.querySelector('.screen-chip');
      const rect = chip?.getBoundingClientRect();
      return { text: element.innerText, width: innerWidth, documentWidth: document.documentElement.scrollWidth,
        mainWidth: main.clientWidth, mainScrollWidth: main.scrollWidth,
        controls: [...element.querySelectorAll('button')].map(button => ({ name: button.getAttribute('aria-label') ?? button.innerText, height: button.getBoundingClientRect().height })),
        chip: chip ? { name: chip.getAttribute('aria-label'), text: chip.innerText, left: rect.left, right: rect.right, bottom: rect.bottom, height: rect.height } : null };
    });
    if (!audit.text.includes(expected) || audit.documentWidth > width || audit.mainScrollWidth > audit.mainWidth + 1 || audit.controls.some(control => control.height < 44) || (audit.chip && (audit.chip.left < 0 || audit.chip.right > width))) throw new Error(`Layout failed ${name}: ${JSON.stringify(audit)}`);
    const file = `${name}-${width}.png`; await page.screenshot({ path: resolve(output, file) });
    audits.push({ file, ...audit }); console.log(`Captured ${file}`);
  }
  for (const width of [1440, 390]) {
    for (const scenario of ['operating', 'human', 'local', 'locked', 'desktop']) {
      await open(width, scenario);
      await shot(`screen-${scenario}`, width, '.screen-control > .section', scenario === 'operating' ? '화면 조작 중' : scenario === 'human' || scenario === 'local' ? '화면 조작 멈춤' : '화면 도구를 쓸 수 없습니다');
      if (scenario === 'human' || scenario === 'local') {
        if ((await page.locator('.screen-chip').innerText()).includes('화면 조작 중')) throw new Error('Pause shown as operating');
      }
      if (scenario !== 'operating') continue;
      if (await page.evaluate(() => window.__calls.some(row => row.method === 'screens.image'))) throw new Error('Images loaded before opening');
      await page.getByRole('button', { name: '캡처 SC-000003 보기', exact: true }).click();
      await page.locator('.screen-capture-image').waitFor();
      await shot('capture-open', width, '.screen-open-capture', 'SC-000003');
      await page.getByRole('button', { name: '캡처 닫기', exact: true }).click();
      await shot('action-secret', width, '.screen-action:nth-child(2)', '가림 · 24자');
      // Verify real React lifecycle, in addition to the deterministic hook tests.
      await page.getByRole('button', { name: '캡처 SC-000003 보기', exact: true }).click();
      await page.locator('.screen-capture-image').waitFor();
      const imageReads = await page.evaluate(() => window.__calls.filter(row => row.method === 'screens.image').length);
      await page.evaluate(() => { window.__expire = true; });
      await page.locator('.screen-capture-image').waitFor({ state: 'detached', timeout: 7000 });
      if (await page.evaluate(() => window.__calls.filter(row => row.method === 'screens.image').length) !== imageReads) throw new Error('Expired image fetched again');
      await page.getByRole('tab', { name: '자리와 인계', exact: true }).click();
      const closedReads = await page.evaluate(() => window.__calls.filter(row => row.method === 'screens.recent').length);
      await pause(5200);
      if (await page.evaluate(() => window.__calls.filter(row => row.method === 'screens.recent').length) !== closedReads) throw new Error('Polling continued after panel closed');
      audits.push({ check: 'real-react-expiration-and-poll-cleanup', width, imageReads, closedReads, passed: true });
    }
    // Follow the actual screen notice while already on the seat screen.
    await page.locator('.bell-button').click();
    // Desktop-mode fixture has a screen notice with the panel field.
    await page.locator('.notification-item').filter({ hasText: '화면 도구를 쓸 수 없습니다' }).getByRole('button', { name: '관련 화면 보기' }).click();
    if (await page.getByRole('tab', { name: '화면 조작', exact: true }).getAttribute('aria-selected') !== 'true') throw new Error('Notice lost screen panel');
    audits.push({ check: 'notice-screen-panel', width, passed: true });
    await page.locator('.nav-item').filter({ hasText: '운영 설정' }).click();
    await page.locator('.settings-nav button').filter({ hasText: /설치 설정|계정과 기기/ }).click();
    await shot('settings-prereqs', width, '.settings-content > .section:last-child', '작업 개체 도우미');
  }
  if (errors.length) throw new Error(`Browser errors: ${JSON.stringify(errors)}`);
  writeFileSync(resolve(output, 'browser-audit.json'), JSON.stringify({ audits, errors, headless: true, serverPort: 5196 }, null, 2) + '\n');
} finally {
  await browser?.close().catch(() => undefined);
  if (chrome && chrome.exitCode === null) { chrome.kill(); await new Promise(done => { chrome.once('exit', done); setTimeout(done, 3000); }); }
  await server?.close();
  if (!temp.startsWith(tempRoot + sep)) throw new Error('Temp containment failed');
  rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
}
