import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

const output = resolve('docs/design/command-bar');
const temporary = mkdtempSync(resolve(tmpdir(), 'command-drop-'));
const audits = [], checks = [], errors = [], consoleWarnings = [];
let server, browser;
mkdirSync(resolve(output, 'captures'), { recursive: true });
try {
  server = await createServer({ configFile: resolve('vite.web.config.ts'), configLoader: 'runner',
    cacheDir: resolve(temporary, 'vite'), server: { host: '127.0.0.1', port: 5196, strictPort: true } });
  await server.listen();
  browser = await chromium.launchPersistentContext(resolve(temporary, 'profile'), {
    channel: 'msedge', headless: true, viewport: { width: 1440, height: 1000 },
    args: ['--disable-gpu', '--disable-gpu-sandbox'], reducedMotion: 'reduce',
  });
  const page = await browser.newPage();
  let lastFileEvent;
  await page.route('**/src/main.tsx*', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: `window.wook = (await import('/src/api/fake/index.ts')).fakeBridge;\n${await response.text()}` });
  });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error' && message.text().includes('same key')) consoleWarnings.push('Existing demo activity feed has a duplicate React key (1003) after command.send.');
    else if (message.type() === 'error') errors.push(message.text());
  });
  async function start(width, flags = '') {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await page.goto(`http://127.0.0.1:5196/?${flags}`);
    await page.getByRole('button', { name: '개발 모드로 시작하기' }).click();
    await page.locator('.home-todos').waitFor();
    await page.evaluate(() => document.fonts.ready);
  }
  async function fileEvent(type, location = 'middle', names = ['검토 메모.txt', '참고 자료.csv']) {
    lastFileEvent = await page.evaluate(({ type, location, names }) => {
      const transfer = new DataTransfer();
      for (const name of names) transfer.items.add(new File(['sample contents'], name, { type: 'text/plain' }));
      const x = Math.floor(innerWidth / 2), y = Math.floor(innerHeight / 2);
      const target = location === 'middle' ? document.elementFromPoint(x, y)
        : document.querySelector(location === 'conversation' ? '.conversation' : location === 'modal' ? '[aria-modal="true"]' : 'textarea[aria-label="명령 입력"]');
      if (!target) throw new Error(`Missing drop target: ${location}`);
      const event = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: x, clientY: y });
      target.dispatchEvent(event);
      // Chromium keeps dropEffect at "none" on constructed DataTransfers. Cursor
      // assignments are verified by component tests; here check the real DOM.
      return { type, location, x, y, inCommandBar: !!target.closest('.command-bar'), prevented: event.defaultPrevented };
    }, { type, location, names });
    if (location === 'middle') assert.equal(lastFileEvent.inCommandBar, false, 'Middle of page must be outside command bar');
    return lastFileEvent.prevented;
  }
  async function capture(name, width) {
    const audit = await page.evaluate(() => {
      const bar = document.querySelector('.command-bar').getBoundingClientRect();
      return { width: innerWidth, documentWidth: document.documentElement.scrollWidth, bar: { left: bar.left, right: bar.right, bottom: bar.bottom },
        viewportHeight: innerHeight, highlight: !!document.querySelector('.command-file-over'),
        ready: document.querySelectorAll('.upload-ready').length, error: document.querySelectorAll('.upload-error').length,
        activeInput: document.activeElement?.getAttribute('aria-label'),
        hintDisplay: document.querySelector('.command-drop-hint') ? getComputedStyle(document.querySelector('.command-drop-hint')).display : null };
    });
    assert.ok(audit.documentWidth <= width && audit.bar.right <= width + 1 && audit.bar.bottom <= audit.viewportHeight + 1, `${name}: layout overflow`);
    const filename = `captures/${name}-${width}.png`;
    await page.screenshot({ path: resolve(output, filename) });
    audits.push({ filename, ...audit, ...(name === 'file-over' ? { drag: lastFileEvent } : {}) }); console.log(filename);
  }
  for (const width of [1440, 390]) {
    await start(width, 'fakeUpload=mixed');
    await capture('idle', width);
    assert.ok(await fileEvent('dragover'));
    await page.locator('.command-file-over').waitFor();
    assert.equal(await page.locator('.command-drop-hint').count(), 1);
    await capture('file-over', width);
    if (width === 390) {
      assert.equal(audits.at(-1).hintDisplay, 'none');
      assert.ok(readFileSync(resolve(output, 'captures/idle-390.png')).equals(readFileSync(resolve(output, 'captures/file-over-390.png'))));
    }
    assert.ok(await fileEvent('drop'));
    await page.locator('.upload-ready').waitFor(); await page.locator('.upload-error').waitFor();
    assert.ok(await page.getByRole('textbox', { name: '명령 입력' }).evaluate(el => el === document.activeElement));
    assert.ok(await page.getByRole('button', { name: '보내기', exact: true }).isDisabled());
    await capture('two-files', width);
    await page.getByRole('button', { name: '참고 자료.csv 다시 올리기' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.upload-ready').length === 2);
    assert.ok(await page.getByRole('button', { name: '보내기', exact: true }).isEnabled());
    await fileEvent('drop', 'composer', ['추가 파일.txt']);
    assert.equal(await page.locator('.upload-chip').count(), 3);
    checks.push(`${width}: middle-page drag hint and drop, upload queue, ready/error chips, retry, later composer drop, focus and layout`);
  }
  await start(1440);
  // Actual browser default insertion for a selected text drag; the page guard must not cancel it.
  await page.evaluate(() => {
    const source = document.createElement('p'); source.id = 'selected-text-fixture';
    source.textContent = '드래그한 글'; source.style.cssText = 'position:fixed;top:120px;left:280px;z-index:100;background:white;padding:12px';
    document.body.append(source);
    const range = document.createRange(); range.selectNodeContents(source);
    getSelection().removeAllRanges(); getSelection().addRange(range);
  });
  const source = await page.locator('#selected-text-fixture').boundingBox();
  const destination = await page.getByRole('textbox', { name: '명령 입력' }).boundingBox();
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down(); await page.waitForTimeout(200);
  await page.mouse.move(destination.x + 40, destination.y + 25, { steps: 24 });
  await page.waitForTimeout(200); await page.mouse.up();
  assert.equal(await page.getByRole('textbox', { name: '명령 입력' }).inputValue(), '드래그한 글');
  checks.push('native selected text drag inserts into textarea');
  await page.locator('#selected-text-fixture').evaluate(el => el.remove());
  for (const cancel of ['window-leave', 'Escape', 'blur', 'dragend', 'silent-cancel']) {
    await fileEvent('dragover'); await page.locator('.command-file-over').waitFor();
    if (cancel === 'window-leave') await page.evaluate(() => document.documentElement.dispatchEvent(new DragEvent('dragleave', { bubbles: true, relatedTarget: null })));
    else if (cancel === 'Escape') await page.keyboard.press('Escape');
    else if (cancel === 'blur' || cancel === 'dragend') await page.evaluate(type => window.dispatchEvent(new Event(type)), cancel);
    // The silent-cancel case deliberately sends no event at all.
    await page.locator('.command-file-over').waitFor({ state: 'detached', timeout: 2000 });
    assert.equal(await page.locator('.upload-chip').count(), 0);
    checks.push(cancel);
  }
  await page.getByRole('button', { name: '대화 기록 펼치기' }).click();
  await page.locator('.conversation').waitFor();
  await fileEvent('dragenter', 'conversation'); await page.locator('.command-drop-hint').waitFor();
  assert.ok(await fileEvent('drop', 'conversation', ['대화 위 첨부.txt']));
  await page.getByRole('button', { name: '대화 위 첨부.txt 첨부 제거' }).waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.upload-ready').length === 1);
  assert.equal(await page.getByRole('textbox', { name: '명령 입력' }).evaluate(el => el === document.activeElement), true);
  const unsent = await page.evaluate(async () => (await import('/src/api/fake/index.ts')).fakeBridge.invoke('command.history', 'main', { limit: 60 }));
  assert.ok(!unsent.some(message => message.attachments.some(file => file.name === '대화 위 첨부.txt')));
  await page.getByRole('button', { name: '대화 위 첨부.txt 첨부 제거' }).click();
  await page.getByRole('button', { name: '대화 기록 접기' }).click();
  checks.push('conversation drop attaches and focuses without sending; one click removes the chip');

  // Use the app's own blocking dialog, including a drop on its backdrop.
  await page.locator('.palette-trigger').click();
  await page.getByRole('dialog', { name: '빠른 이동' }).waitFor();
  for (const location of ['modal', 'middle']) {
    assert.ok(await fileEvent('dragover', location));
    assert.equal(await page.locator('.command-drop-hint').count(), 0);
    assert.ok(await fileEvent('drop', location));
    assert.equal(await page.locator('.upload-chip').count(), 0);
    assert.ok(await page.getByRole('dialog', { name: '빠른 이동' }).getByRole('combobox').evaluate(el => el === document.activeElement));
  }
  await page.keyboard.press('Escape');
  await fileEvent('dragover'); await page.locator('.command-drop-hint').waitFor();
  await page.keyboard.press('Escape'); await page.locator('.command-drop-hint').waitFor({ state: 'detached' });
  checks.push('blocking dialog and backdrop refuse files with no destination hint or focus change; closing restores window drop');
  // Keyboard paperclip path and image paste still reach exactly the same queue.
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '파일 첨부', exact: true }).focus(); await page.keyboard.press('Enter');
  await (await chooser).setFiles({ name: 'keyboard.txt', mimeType: 'text/plain', buffer: Buffer.from('keyboard') });
  await page.getByRole('button', { name: 'keyboard.txt 첨부 제거' }).waitFor();
  const paste = await page.evaluate(() => {
    const data = new DataTransfer(); data.items.add(new File(['pixels'], 'pasted.png', { type: 'image/png' }));
    const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data });
    document.querySelector('textarea[aria-label="명령 입력"]').dispatchEvent(event);
    return { prevented: event.defaultPrevented, types: [...event.clipboardData.items].map(item => item.type) };
  });
  assert.ok(paste.prevented, JSON.stringify(paste));
  await page.getByRole('button', { name: 'pasted.png 첨부 제거' }).waitFor({ timeout: 2000 });
  await page.waitForFunction(() => document.querySelectorAll('.upload-ready').length === 2, null, { timeout: 4000 });
  await page.getByRole('textbox', { name: '명령 입력' }).fill('첨부를 검토해 줘');
  await page.getByRole('textbox', { name: '명령 입력' }).press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('.upload-chip').length === 0);
  await page.getByRole('button', { name: '대화 기록 펼치기' }).click();
  await page.locator('.conversation').getByText('keyboard.txt', { exact: false }).waitFor();
  const history = await page.evaluate(async () => (await import('/src/api/fake/index.ts')).fakeBridge.invoke('command.history', 'main', { limit: 60 }));
  assert.ok(history.some(message => message.attachments.some(file => file.name === 'keyboard.txt' && file.size === 8 && file.mime === 'text/plain')));
  checks.push('keyboard paperclip, image paste, Enter send and fake attachment metadata in conversation');
  assert.deepEqual(errors, []);
} catch (error) {
  errors.push(error instanceof Error ? error.message : String(error));
  throw error;
} finally {
  await browser?.close(); await server?.close();
  writeFileSync(resolve(output, 'browser-audit.json'), JSON.stringify({ audits, checks, errors, consoleWarnings: [...new Set(consoleWarnings)] }, null, 2) + '\n');
  assert.ok(temporary.startsWith(resolve(tmpdir())));
  rmSync(temporary, { recursive: true, force: true });
}
