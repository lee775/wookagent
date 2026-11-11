import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, sep } from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';

const tempRoot = resolve(tmpdir()), temporary = mkdtempSync(resolve(tempRoot, 'wook-stage7-browser-'));
const output = resolve('docs/design/permission-ui/stage7-agents'); mkdirSync(output, { recursive: true });
const audits = [], errors = [];
let server, chrome, browser;
const pause = ms => new Promise(done => setTimeout(done, ms));
try {
  server = await createServer({ configFile: resolve('vite.web.config.ts'), configLoader: 'runner', cacheDir: resolve(temporary, 'vite'), server: { host: '127.0.0.1', port: 5196, strictPort: true, fs: { allow: [resolve('.'), realpathSync('node_modules')] } } });
  await server.listen();
  chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', '--disable-gpu', '--disable-gpu-sandbox', '--no-sandbox', '--in-process-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${resolve(temporary, 'chrome')}`, 'about:blank'], { windowsHide: true, stdio: 'ignore', env: { ...process.env, TMP: temporary, TEMP: temporary } });
  const portFile = resolve(temporary, 'chrome/DevToolsActivePort');
  for (let retry = 0; retry < 100 && !existsSync(portFile); retry++) await pause(100);
  if (!existsSync(portFile)) throw new Error('Headless Chrome did not start');
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${Number(readFileSync(portFile, 'utf8').split('\n')[0])}`);
  const page = browser.contexts()[0].pages()[0];
  // Keep this fake-only capture independent of the production bootstrap.
  await page.route('**/src/main.tsx*', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: `window.wook = (await import('/src/api/fake/index.ts')).fakeBridge;\n${await response.text()}` });
  });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  async function start(width, scenario) {
    await page.setViewportSize({ width, height: 1100 });
    await page.goto(`http://127.0.0.1:5196/?studio3d=0&fakeAgents=${scenario}`);
    await page.getByRole('button', { name: '개발 모드로 시작하기' }).click();
    await page.locator('.seat-chip').waitFor();
    await page.evaluate(async () => {
      const { fakeBridge } = await import('/src/api/fake/index.ts');
      const { snapshot } = await import('/src/api/fake/data.ts');
      snapshot.auth.mode = 'server'; window.__calls = []; window.__agentMode = null;
      window.wook = { ...fakeBridge, invoke: async (method, ...args) => {
        window.__calls.push(method);
        const value = await fakeBridge.invoke(method, ...args);
        if (method === 'agents.list' && window.__agentMode === 'disconnected') return value.map(row => ({ ...row, connected: false }));
        if (method === 'agents.list' && window.__agentMode === 'revoked') return value.map(row => ({ ...row, connected: true, revokedAt: new Date().toISOString() }));
        return value;
      } };
      window.dispatchEvent(new Event('wook:authorized'));
    });
    await page.locator('.seat-chip').click();
    await page.locator('.external-agents').waitFor();
    await page.locator('.external-agents [role=status]').waitFor({ state: 'detached' });
  }
  async function shot(name, width, selector, expected) {
    const target = page.locator(selector);
    await target.scrollIntoViewIfNeeded(); await page.evaluate(() => document.fonts.ready); await pause(100);
    const audit = await page.evaluate(selector => {
      const element = document.querySelector(selector), chip = document.querySelector('.seat-chip'), rect = chip.getBoundingClientRect();
      const main = document.querySelector('.main-content');
      const sidebar = document.querySelector('.sidebar').getBoundingClientRect();
      const topbar = document.querySelector('.topbar').getBoundingClientRect();
      return { width: innerWidth, documentWidth: document.documentElement.scrollWidth, mainWidth: main.clientWidth, mainScrollWidth: main.scrollWidth,
        navigationUncovered: innerWidth > 760 || sidebar.top >= topbar.bottom - 1,
        text: element.innerText, chip: { text: chip.innerText, name: chip.getAttribute('aria-label'), left: rect.left, right: rect.right, height: rect.height },
        listControls: document.querySelectorAll('.external-agents button, .external-agents a, .external-agents input, .external-agents select, .external-agents textarea').length,
        newControls: [...document.querySelectorAll('.seat-chip')].map(button => ({ name: button.getAttribute('aria-label'), height: button.getBoundingClientRect().height })), calls: window.__calls };
    }, selector);
    if (!audit.text.includes(expected) || audit.documentWidth > width || audit.mainScrollWidth > audit.mainWidth + 1 || !audit.navigationUncovered || audit.listControls || audit.chip.left < 0 || audit.chip.right > width || audit.newControls.some(row => row.height < 44)) throw new Error(`Layout failed ${name}: ${JSON.stringify(audit)}`);
    const filename = `${name}-${width}.png`; await page.screenshot({ path: resolve(output, filename) });
    audits.push({ filename, ...audit }); console.log(filename);
  }
  for (const width of [1440, 390]) {
    for (const scenario of ['none', 'connected', 'disconnected', 'incoming', 'revoked', 'several', 'unresponsive']) {
      await start(width, scenario);
      await shot(`seat-${scenario}`, width, '#seat-panel > .section:first-child', scenario === 'none' ? 'Claude CLI' : '산책 도우미 · 외부 에이전트');
      await shot(`agents-${scenario}`, width, '.external-agents', scenario === 'none' ? '등록된 외부 에이전트가 없습니다.' : '산책 도우미');
      if (scenario !== 'none') {
        const chip = await page.locator('.seat-chip').innerText();
        if (!chip.includes('외부 에이전트') || /Claude|Codex|opus|gpt-/.test(chip)) throw new Error('External chip mislabels the holder');
      }
      if (['disconnected', 'revoked', 'unresponsive'].includes(scenario)) {
        if ((await page.locator('.external-holder-state .agent-status').innerText()) !== '연결 안 됨') throw new Error('Disconnected external shown connected');
      }
      if (scenario === 'incoming' && !(await page.locator('.seat-chip').innerText()).includes('기록 정리 도우미')) throw new Error('Incoming holder omitted');
    }
    await start(width, 'incoming');
    await page.evaluate(async () => {
      const { snapshot } = await import('/src/api/fake/data.ts');
      snapshot.seat.holder.label = '산책 기록을 정리하는 도우미 '.repeat(4).trim();
      snapshot.seat.pendingHolder.label = '새 프로그램 '.repeat(10).trim();
      window.dispatchEvent(new Event('wook:authorized'));
    });
    await page.locator('.seat-chip').filter({ hasText: '새 프로그램' }).waitFor();
    const longLabels = await page.locator('.seat-chip').evaluate(element => {
      const visible = element.querySelector(innerWidth > 760 ? '.seat-chip-full' : '.seat-chip-compact');
      const nav = document.querySelector('.sidebar .nav-item'), box = nav.getBoundingClientRect();
      return { text: element.innerText, documentWidth: document.documentElement.scrollWidth,
        clipped: visible.scrollWidth > visible.clientWidth + 1 || visible.scrollHeight > visible.clientHeight + 1,
        navigationClickable: nav.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)) };
    });
    if (longLabels.clipped || longLabels.documentWidth > width || !longLabels.navigationClickable || (longLabels.text.match(/외부 에이전트/g) ?? []).length !== 2) throw new Error(`Long holder names failed: ${JSON.stringify(longLabels)}`);
    audits.push({ check: 'long-holder-labels-remain-visible', width, ...longLabels });
    await start(width, 'connected');
    await page.evaluate(() => { window.__agentMode = 'disconnected'; });
    await page.locator('.external-holder-state .agent-status').filter({ hasText: '연결 안 됨' }).waitFor({ timeout: 7000 });
    await page.evaluate(() => { window.__agentMode = 'revoked'; });
    await page.locator('.external-holder-state').getByText('서버 접근이 철회됐습니다. 외부 프로그램의 종료 여부는 확인할 수 없습니다.', { exact: true }).waitFor({ timeout: 7000 });
    if ((await page.locator('.external-holder-state .agent-status').innerText()) !== '연결 안 됨') throw new Error('Stale connected flag beats revocation');
    audits.push({ check: 'real-react-disconnect-and-revoke', width, passed: true });
    await page.locator('.sidebar').getByRole('button', { name: '프로젝트', exact: true }).click();
    await page.locator('.main-agent-banner').click();
    await page.locator('.main-seat-summary').waitFor();
    const summary = await page.locator('.main-seat-summary').innerText();
    if (!summary.includes('산책 도우미 · 외부 에이전트') || /Claude|Codex|opus|기본 모델/.test(summary)) throw new Error('Main panel shows stale CLI');
    await shot('member-external', width, '.main-seat-summary', '외부 에이전트');
    const selected = page.locator('.turn-chips');
    if ((await selected.innerText()).includes('바이패스')) throw new Error('External turn exposes CLI bypass details');
    await shot('turn-external', width, '.turn-chips', '외부 에이전트');
    await shot('sessions-mixed', width, '.member-panel .section:has(th:nth-child(5))', '외부 에이전트');
  }
  if (errors.length) throw new Error(`Browser errors: ${JSON.stringify(errors)}`);
  writeFileSync(resolve(output, 'browser-audit.json'), JSON.stringify({ audits, errors, headless: true, serverPort: 5196 }, null, 2) + '\n');
} finally {
  await browser?.close().catch(() => undefined);
  if (chrome && chrome.exitCode === null) { chrome.kill(); await new Promise(done => { chrome.once('exit', done); setTimeout(done, 3000); }); }
  await server?.close();
  if (!temporary.startsWith(tempRoot + sep)) throw new Error('Temp containment failed');
  rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
}
