import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

const temporary = mkdtempSync(resolve(tmpdir(), 'ai-suggestion-capture-'));
const output = resolve('docs/design/ai-suggestion/captures');
const origin = 'http://127.0.0.1:5196';
let server, browser;
try {
  mkdirSync(output, { recursive: true });
  server = await createServer({ configFile: resolve('vite.web.config.ts'), configLoader: 'runner',
    mode: 'development', cacheDir: resolve(temporary, 'vite'), server: { host: '127.0.0.1', port: 5196, strictPort: true } });
  await server.listen();
  browser = await chromium.launchPersistentContext(resolve(temporary, 'profile'), {
    channel: 'msedge', headless: true, reducedMotion: 'reduce',
    args: ['--disable-gpu', '--disable-background-networking', '--renderer-process-limit=2'],
  });
  await browser.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const page = browser.pages()[0];
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const entry = page.getByRole('button', { name: 'AI 건의', exact: true });
  const sheet = page.getByRole('dialog', { name: '팀원 AI 건의서' });
  const model = sheet.getByRole('combobox', { name: '건의할 모델' });
  const high = sheet.getByRole('radiogroup', { name: '건의할 노력치' }).getByRole('radio', { name: '높게' });
  const reason = sheet.getByRole('textbox', { name: '건의하는 까닭' });
  const send = sheet.getByRole('button', { name: '건의 보내기' });
  const why = '검색 조건이 겹치는 경우를 더 꼼꼼히 검토해 주세요.';
  async function capture(name, width) {
    const accessibility = await page.locator('body').ariaSnapshot();
    const controls = accessibility.split('\n').filter(line => /^\s*- (button|link|tab|combobox|textbox|radio) "/.test(line));
    assert.ok(!controls.some(line => /(?:AI|모델|노력(?:치)?|추론)\s*(변경|조정|바꾸기|고르기|저장)|"(저장|적용)"/.test(line)), 'Unexpected team control');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth &&
      [...document.querySelectorAll('dialog[open]')].every(el => el.scrollWidth <= el.clientWidth)));
    await page.screenshot({ path: resolve(output, name + '-' + width + '.jpg'), quality: 94, animations: 'disabled' });
    console.log(name + '-' + width);
  }
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 960 });
    await page.goto(origin + '/?officeState=busy&studio3d=0');
    await page.locator('[data-company-member="M-MAIN"]').click();
    await page.locator('.main-seat-summary').waitFor();
    assert.equal(await entry.count(), 0);
    await page.getByRole('button', { name: '팀원 상세 닫기' }).click();
    await page.getByRole('button', { name: '서비스 개발 사무실 열기' }).click();
    await page.locator('[data-directory-member="M-8007"]').click();
    await entry.focus(); await entry.press('Enter');
    await sheet.locator('.suggestion-fixed').waitFor();
    await capture('fixed', width);
    await page.keyboard.press('Escape');
    await sheet.waitFor({ state: 'detached' });
    assert.ok(await entry.evaluate(el => document.activeElement === el), 'Escape restores focus to AI 건의');
    await page.getByRole('button', { name: '팀원 상세 닫기' }).click();
    await page.locator('[data-directory-member="M-8002"]').click();
    await entry.waitFor(); await page.evaluate(() => document.fonts.ready);
    await capture('member', width);
    await entry.press('Enter'); assert.ok(await send.isDisabled());
    await sheet.getByText('모델별 설명', { exact: true }).click();
    await sheet.locator('.suggestion-catalog dd').first().waitFor();
    await sheet.getByText('모델별 설명', { exact: true }).click();
    await model.selectOption('gpt-6-sol');
    await sheet.getByRole('radio', { name: '건의 없음' }).focus();
    await page.keyboard.press('ArrowRight'); assert.ok(await high.isChecked());
    await reason.fill(why); await capture('picks', width);
    // A catalog revision between opening and sending exercises the fake server's real rejection.
    const codex = await page.evaluate(async () => {
      const { settings } = await import('/src/api/fake/data.ts');
      return settings.team.modelCatalog.codex.splice(0);
    });
    await send.click();
    assert.equal(await sheet.getByRole('alert').textContent(), '운영 설정의 모델 목록에서 "gpt-6-sol"을 찾을 수 없습니다.');
    assert.equal(await model.inputValue(), 'gpt-6-sol'); assert.ok(await high.isChecked()); assert.equal(await reason.inputValue(), why);
    await capture('refusal', width);
    await page.evaluate(async rows => { (await import('/src/api/fake/data.ts')).settings.team.modelCatalog.codex.push(...rows); }, codex);
    await send.press('Enter');
    await page.locator('.toast', { hasText: '건의를 보냈습니다' }).waitFor();
    const chat = page.getByRole('dialog', { name: '메인 에이전트 대화창' });
    assert.equal(await chat.getByRole('combobox', { name: '명령 대상' }).inputValue(), 'P-8001');
    await chat.locator('.bubble-owner', { hasText: why }).waitFor();
    await capture('sent', width);
    await chat.locator('.bubble-main_agent', { hasText: '건의를 반영했습니다' }).waitFor();
    await page.locator('.toast').first().waitFor({ state: 'hidden' });
    await capture('conversation', width);
  }
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  await server?.close();
  assert.equal(dirname(temporary), resolve(tmpdir()));
  rmSync(temporary, { recursive: true, force: true });
}
