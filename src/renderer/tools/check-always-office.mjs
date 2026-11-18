// App-only captures. One headless browser; only the Vite server on 5196 is owned here.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

const out = 'docs/design/permission-ui/always-office';
const cacheDir = mkdtempSync(join(tmpdir(), 'always-office-vite-'));
mkdirSync(out, { recursive: true });
const results = [];
const scenarios = [false, true].flatMap(desktop => [1440, 390].flatMap(width => [
  { state: 'no-project', home: true }, { state: 'empty-seat', home: true },
  { state: 'no-project', home: true, external: true }, { state: 'idle' }, { state: 'busy' },
  { state: 'no-project', home: true, reduced: true }, { state: 'idle', reduced: true },
  { state: 'emergency', home: true }, { state: 'emergency' },
].map(item => ({ ...item, width, desktop, mode: desktop || width > 760 ? '3d' : '2d' }))));
scenarios.push(
  ...['no-project', 'empty-seat'].map(state => ({ width: 1440, state, home: true, mode: '2d', switch: '0' })),
  ...['no-project', 'empty-seat'].map(state => ({ width: 390, state, home: true, mode: '3d', switch: '1' })),
  ...['no-project', 'empty-seat'].map(state => ({ width: 1440, state, home: true, mode: '2d', noWebGL: true })),
);
const only = process.argv.find(arg => arg.startsWith('--state='))?.slice(8);
const onlyWidth = process.argv.find(arg => arg.startsWith('--width='))?.slice(8);
const probe = process.argv.find(arg => arg.startsWith('--probe'));
const refresh = process.argv.includes('--refresh-captures');
const scenarioLabel = scenario => `${scenario.state}-${scenario.mode}-${scenario.width}${scenario.home ? '-company' : ''}${scenario.desktop ? '-desktop' : ''}${scenario.reduced ? '-reduced' : ''}${scenario.external ? '-external' : ''}${scenario.switch ? '-override' : ''}${scenario.noWebGL ? '-no-webgl' : ''}`;
const previous = refresh ? JSON.parse(readFileSync(`${out}/browser-check.json`, 'utf8')) : [];
const probes = {
  company: [{ width: 1440, state: 'no-project', home: true, mode: '3d' }],
  external: [{ width: 1440, state: 'no-project', home: true, mode: '3d', external: true }],
  vacant: [{ width: 1440, state: 'empty-seat', home: true, mode: '3d' }],
  idle: [{ width: 1440, state: 'idle', mode: '3d' }],
  fallback: [{ width: 390, state: 'no-project', home: true, mode: '2d' }],
};
const selected = probe ? probes[probe.split('=')[1] ?? 'idle'] : scenarios.filter(scenario =>
  (!only || scenario.state === only) && (!onlyWidth || scenario.width === Number(onlyWidth)) &&
  (!refresh || only || scenario.width === 390 || scenario.home && scenario.mode === '2d'));
assert.ok(selected, 'Unknown browser probe');
let server, browser;
try {
  server = await createServer({ configFile: 'vite.web.config.ts', cacheDir, logLevel: 'error', server: { host: '127.0.0.1', port: 5196, strictPort: true } });
  await server.listen();
  browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--use-angle=swiftshader', '--enable-webgl', '--disable-dev-shm-usage'] });
  for (const scenario of selected) {
    const { width, state, mode, desktop, reduced, external, home, noWebGL } = scenario;
    const page = await browser.newPage({ viewport: { width, height: 1000 }, deviceScaleFactor: 1, hasTouch: width === 390, reducedMotion: reduced ? 'reduce' : 'no-preference' });
    const errors = []; page.on('pageerror', error => errors.push(String(error)));
    const label = scenarioLabel(scenario);
    try {
      await page.addInitScript(noWebGL => {
        window.officeDraws = 0;
        window.officeContexts = 0; window.officeMaxContexts = 0;
        for (const prototype of [WebGLRenderingContext.prototype, WebGL2RenderingContext.prototype]) for (const name of ['drawElements', 'drawArrays']) {
          const original = prototype[name];
          prototype[name] = function (...args) { window.officeDraws++; return original.apply(this, args); };
        }
        const getContext = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (kind, ...args) {
          if (noWebGL && kind === 'webgl2') return null;
          const context = getContext.call(this, kind, ...args);
          if (kind === 'webgl2' && context && !this.dataset.officeTracked) {
            this.dataset.officeTracked = 'true'; window.officeContexts++;
            window.officeMaxContexts = Math.max(window.officeMaxContexts, window.officeContexts);
            let active = true;
            const release = () => { if (active) { active = false; window.officeContexts--; } };
            this.addEventListener('webglcontextlost', release);
            const extension = context.getExtension('WEBGL_lose_context');
            if (extension) { const lose = extension.loseContext.bind(extension); extension.loseContext = () => { release(); lose(); }; }
          }
          return context;
        };
      }, !!noWebGL);
      const query = new URLSearchParams({ officeState: state, fakeMode: desktop ? 'desktop' : 'server', fakeDesktop: desktop ? '1' : '0', fakeSetup: 'ready' });
      if (scenario.switch) query.set('studio3d', scenario.switch);
      if (external) query.set('fakeAgents', 'connected');
      await page.goto(`http://127.0.0.1:5196/?${query}`, { waitUntil: 'networkidle' });
      const later = page.getByRole('button', { name: '나중에', exact: true }); if (await later.count()) await later.click();
      const waitOffice = async region => {
        await region.scrollIntoViewIfNeeded();
        await region.locator('canvas, .office-svg').waitFor();
        if (mode === '3d') {
          assert.equal(await region.locator('.office-svg').count(), 0, '3D office fell back to 2D');
          await page.waitForFunction(() => window.render_game_to_text && JSON.parse(window.render_game_to_text(false)).ready, null, { timeout: 90000 });
        } else {
          await region.locator('.office-svg').waitFor();
          assert.equal(await region.locator('canvas').count(), 0, 'Fallback opened a 3D scene');
        }
        await page.waitForTimeout(mode === '3d' ? 700 : 1200);
      };
      const mainRegion = page.getByRole('region', { name: '메인 사무실', exact: true });
      await waitOffice(mainRegion);
      assert.ok(await page.getByRole('heading', { name: '부서와 직원', exact: true }).count(), 'Home lost the department list');
      const people = await page.locator(home ? '.company-main [data-company-member]' : '[data-department] [data-company-member]').evaluateAll(elements => elements.map(element => ({ id: element.dataset.companyMember, name: element.querySelector('strong').firstChild.textContent.trim() })));
      if (!home) await page.getByRole('button', { name: '서비스 개발 사무실 열기', exact: true }).click();
      const region = page.getByRole('region', { name: home ? '메인 사무실' : '프로젝트 사무실', exact: true });
      if (!home) await waitOffice(region);
      const selector = mode === '3d' ? '.studio3d-tag' : '.office-person-label';
      assert.ok(await region.locator('.office-scene').count(), 'No office to watch');
      assert.equal(await region.locator(selector).count(), state === 'empty-seat' ? 0 : home ? 1 : 12);
      if (state === 'empty-seat') await page.getByText('메인 자리가 비어 있습니다.', { exact: false }).waitFor();
      const expectedPeople = state === 'empty-seat' ? [] : people;
      let desks;
      if (mode === '3d') {
        const actual = await page.evaluate(() => JSON.parse(window.render_game_to_text(false)));
        desks = actual.workstations.map(station => station.id);
        assert.deepEqual(desks.toSorted(), expectedPeople.map(person => person.id).toSorted(), 'Desk without an existing member, or missing member desk');
        assert.equal(actual.characterCount, expectedPeople.length, 'Wrong character count');
      } else if (home) {
        desks = await region.locator('[data-desk]').count();
        assert.equal(desks, expectedPeople.length, 'Fallback has desks without people');
        assert.equal(await region.locator('[data-chair]').count(), expectedPeople.length, 'Fallback has chairs without people');
        assert.equal(await region.locator('[data-desk-partition]').count(), expectedPeople.length, 'Fallback has partitions without people');
      }
      const samples = [];
      for (const seconds of home && state !== 'empty-seat' || state === 'idle' && mode === '2d' ? [0, 40, 900] : [0]) {
        if (seconds) {
          if (mode === '3d') await page.evaluate(ms => window.advanceTime(ms), seconds * 1000);
          else { await page.evaluate(seconds => { window.officeRealNow ??= Date.now; Date.now = () => window.officeRealNow() + seconds * 1000; }, seconds); await page.waitForTimeout(1100); }
        }
        const geometry = await region.evaluate((root, selector) => {
          const scene = root.querySelector('.office-scene'), bounds = scene.getBoundingClientRect();
          const overlap = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
          const labels = [...root.querySelectorAll(selector)].map(element => { const box = element.getBoundingClientRect(), css = getComputedStyle(element); return { id: element.dataset.memberId, text: element.textContent.trim(), font: parseFloat(css.fontSize), visible: css.visibility !== 'hidden' && css.display !== 'none', x: box.x - bounds.x - scene.clientLeft, y: box.y - bounds.y - scene.clientTop, width: box.width, height: box.height }; });
          return { labels, overlap: labels.flatMap((a, index) => labels.slice(index + 1).filter(b => overlap(a, b)).map(b => [a.id, b.id])), clipped: labels.filter(box => box.x < 0 || box.y < 0 || box.x + box.width > scene.clientWidth || box.y + box.height > scene.clientHeight).map(box => box.id) };
        }, selector);
        assert.deepEqual(geometry.overlap, [], 'Names overlap'); assert.deepEqual(geometry.clipped, [], 'Names clipped');
        for (const person of state === 'empty-seat' ? [] : people) { const name = geometry.labels.find(label => label.id === person.id); assert.equal(name?.text, person.name); assert.ok(name.visible && name.font >= 13, 'Name unreadable'); }
        const seating = await page.evaluate(mode => mode === '3d' ? JSON.parse(window.render_game_to_text(false)).people.map(person => ({ id: person.id, status: person.status, seated: person.pose === 'seated', place: person.place })) : [...document.querySelectorAll('.office-actor[data-member-id]')].map(element => ({ id: element.dataset.memberId, seated: element.dataset.seated === 'true', place: element.dataset.place })), mode);
        for (const person of seating.filter(person => home || state === 'idle' || person.status === 'idle')) { assert.ok(person.seated, 'Idle person stands'); assert.ok(home ? person.place === 'desk' : ['desk', 'producer', 'sofa', 'lounge'].includes(person.place), 'Idle person has no own chair or sofa seat'); }
        samples.push({ seconds, names: geometry.labels.length, seating });
      }
      await page.mouse.move(0, 0);
      const captureSection = home ? page.locator('.company-live-office') : page.locator('.studio-scene-section');
      if (!probe) {
        // Keep the 1000px interaction checks; give fixed mobile notices room in the capture.
        const tallerCapture = width === 390 || state === 'emergency';
        if (tallerCapture) { await page.setViewportSize({ width, height: 1600 }); await waitOffice(region); }
        await captureSection.screenshot({ path: `${out}/${label}.png` });
        if (tallerCapture) { await page.setViewportSize({ width, height: 1000 }); await waitOffice(region); }
      }
      // Re-enter live rendering after deterministic time sampling.
      if (mode === '3d' && samples.length > 1) {
        await page.reload({ waitUntil: 'networkidle' });
        const later = page.getByRole('button', { name: '나중에', exact: true }); if (await later.count()) await later.click();
        if (!home) { await waitOffice(mainRegion); await page.getByRole('button', { name: '서비스 개발 사무실 열기', exact: true }).click(); }
        await waitOffice(region);
      }
      if (home || state === 'idle' || reduced || state === 'emergency') {
        if (mode === '3d') {
          const before = await page.evaluate(() => window.officeDraws); await page.waitForTimeout(1400);
          assert.equal(await page.evaluate(() => window.officeDraws), before, 'Still office keeps rendering');
        } else {
          await region.evaluate(root => { window.officeChanges = 0; new MutationObserver(records => { window.officeChanges += records.length; }).observe(root.querySelector('.office-svg'), { subtree: true, attributes: true, childList: true, characterData: true }); });
          await page.waitForTimeout(1400);
          assert.equal(await page.evaluate(() => window.officeChanges), 0, 'Still fallback keeps drawing');
        }
      }
      if (state !== 'empty-seat') {
        const first = people[0];
        const name = region.locator(`${selector}[data-member-id="${first.id}"]`);
        if (width === 390) await name.tap(); else await name.hover();
        const card = page.getByRole('group', { name: `${first.name} 업무 정보`, exact: true }); await card.waitFor();
        if (external) assert.match(await card.innerText(), /외부 에이전트 · AI 설정은 외부에서 관리합니다\./, 'External main card has stale AI details');
        await card.getByRole('button', { name: `${first.name} 팀원 상세 열기`, exact: true }).click();
        const panel = page.getByRole('complementary', { name: '팀원 상세', exact: true }); await panel.getByRole('heading', { name: first.name, exact: true }).waitFor();
        assert.equal(await region.locator('canvas, .office-svg').count(), 0, 'Office stays alive behind member portrait');
        assert.equal(await panel.locator('canvas').count(), 0, 'Member detail opened a second 3D scene');
        await page.getByRole('button', { name: '팀원 상세 닫기', exact: true }).click();
        await waitOffice(region);
      }
      // Simulate the browser's visibility event on this app page; no desktop input or capture.
      await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
      await page.waitForFunction(() => !document.querySelector('.office-svg, .office-viewport canvas'));
      const draws = await page.evaluate(() => window.officeDraws); await page.waitForTimeout(200);
      assert.equal(await page.evaluate(() => window.officeDraws), draws, 'Hidden office renders');
      await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); });
      await waitOffice(region);
      await region.evaluate(root => { const main = root.closest('main'); const spacer = document.createElement('div'); spacer.style.height = '1800px'; main.appendChild(spacer); main.scrollTop = main.scrollHeight; });
      await region.locator('[data-office-sleeping]').waitFor({ timeout: 3000 }).catch(() => assert.fail('Offscreen office stays alive'));
      assert.equal(await region.locator('canvas, .office-svg').count(), 0, 'Offscreen office stays alive');
      await region.scrollIntoViewIfNeeded(); await waitOffice(region);
      await page.getByRole('button', { name: '문서함', exact: true }).click();
      await page.waitForFunction(() => !document.querySelector('.office-viewport canvas, .office-viewport .office-svg'));
      const maxContexts = await page.evaluate(() => window.officeMaxContexts);
      assert.ok(maxContexts <= 1, 'Two WebGL scenes were alive at once');
      assert.deepEqual(errors, [], 'App page errors');
      results.push({ ...scenario, desks, samples, memberDetail: state === 'empty-seat' ? 'vacant' : 'passed', hidden: 'unmounted, no draws', offscreen: 'unmounted', screenClosed: 'unmounted', maxContexts, errors });
      console.log(`${label}: passed`);
    } finally { await page.close(); }
  }
} finally {
  if (browser) await browser.close();
  if (server) await server.close();
  assert.ok(cacheDir.startsWith(join(tmpdir(), 'always-office-vite-')), 'Unexpected cache cleanup target');
  rmSync(cacheDir, { recursive: true, force: true });
  if (!probe) {
    const merged = refresh ? scenarios.map(scenario => [...results, ...previous].find(result => scenarioLabel(result) === scenarioLabel(scenario))) : results;
    assert.ok(merged.every(Boolean), 'Missing earlier browser check');
    writeFileSync(`${out}/browser-check${only && !refresh ? `-${only}` : ''}.json`, JSON.stringify(merged, null, 2) + '\n');
  }
}
assert.equal(results.length, selected.length, 'Missing office scenario');
