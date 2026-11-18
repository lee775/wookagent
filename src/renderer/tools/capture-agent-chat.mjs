// Run through the approved CPU wrapper. Only this app in one headless browser.
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const output = resolve('docs/design/agent-chat');
const temporary = mkdtempSync(resolve(tmpdir(), 'agent-chat-'));
const audits = [], checks = [], errors = [];
let server, browser;
mkdirSync(resolve(output, 'captures'), { recursive: true });
try {
  server = await createServer({ configFile: resolve('vite.web.config.ts'), configLoader: 'runner',
    cacheDir: resolve(temporary, 'vite'), server: { host: '127.0.0.1', port: 5196, strictPort: true } });
  await server.listen();
  browser = await chromium.launchPersistentContext(resolve(temporary, 'profile'), {
    channel: 'msedge', headless: true, viewport: { width: 1440, height: 1000 },
    args: ['--disable-gpu', '--disable-gpu-sandbox', '--renderer-process-limit=2'],
  });
  const page = await browser.newPage();
  await page.route('**/src/main.tsx*', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: `window.wook = (await import('/src/api/fake/index.ts')).fakeBridge;\n${await response.text()}` });
  });
  page.on('pageerror', error => errors.push(error.message));
  const launcher = () => page.getByRole('button', { name: '메인 에이전트 대화', exact: true });
  const panel = () => page.getByRole('dialog', { name: '메인 에이전트 대화창' });
  const input = () => page.getByRole('textbox', { name: '명령 입력' });
  async function start(width, state = 'busy', upload = 'mixed') {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto(`http://127.0.0.1:5196/?officeState=${state}&fakeUpload=${upload}&studio3d=0`);
    await page.locator('.company-live-office').waitFor();
    await page.evaluate(() => document.fonts.ready);
    await page.locator('.company-live-office').scrollIntoViewIfNeeded();
    await page.getByRole('status', { name: '읽지 않은 메인 답변 1개' }).waitFor();
  }
  async function fileEvent(type, names = ['검토 메모.txt', '참고 자료.csv'], location = 'middle') {
    return page.evaluate(({ type, names, location }) => {
      const transfer = new DataTransfer();
      for (const name of names) transfer.items.add(new File(['sample'], name, { type: 'text/plain' }));
      const target = document.querySelector(location === 'conversation' ? '.conversation' : location === 'composer' ? 'textarea[aria-label="명령 입력"]' : location === 'modal' ? '[aria-modal="true"]' : '.main-content');
      const event = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer });
      target.dispatchEvent(event);
      return { prevented: event.defaultPrevented, outsideOldBar: !target.closest('.command-bar') };
    }, { type, names, location });
  }
  async function capture(name, width) {
    // Finish only the panel's entrance animation, leaving the office untouched.
    await page.locator('.agent-chat').evaluate(el => Promise.all(el.getAnimations().map(animation => animation.finished.catch(() => {}))));
    const audit = await page.evaluate(() => {
      const rect = el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
      const chat = document.querySelector('.agent-chat'), open = !chat.hidden;
      const hit = el => { if (!el) return true; const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)); };
      return { width: innerWidth, documentWidth: document.documentElement.scrollWidth, viewportHeight: innerHeight,
        panel: open ? rect(chat) : null, launcher: rect(document.querySelector('.chat-launcher')),
        oneInput: document.querySelectorAll('textarea[aria-label="명령 입력"]').length === 1,
        emergencyReachable: hit(document.querySelector('.emergency-button')), notificationsReachable: hit(document.querySelector('.bell-button')), memberCloseReachable: hit(document.querySelector('[aria-label="팀원 상세 닫기"]')),
        inputFocused: document.activeElement?.getAttribute('aria-label') === '명령 입력',
        ready: document.querySelectorAll('.upload-ready').length, error: document.querySelectorAll('.upload-error').length,
        animation: getComputedStyle(chat).animationName, main: rect(document.querySelector('.main-content')) };
    });
    assert.ok(audit.documentWidth <= width, `${name}: sideways overflow`);
    assert.ok(audit.oneInput && audit.emergencyReachable && audit.notificationsReachable && audit.memberCloseReachable, `${name}: controls obscured ${JSON.stringify(audit)}`);
    if (audit.panel) assert.ok(audit.panel.left >= 0 && audit.panel.right <= width + 1 && audit.panel.bottom <= audit.viewportHeight, `${name}: panel overflow`);
    const filename = `captures/${name}-${width}.png`;
    await page.screenshot({ path: resolve(output, filename) });
    audits.push({ filename, ...audit }); console.log(filename);
  }
  for (const width of [1440, 390]) {
    await start(width); await capture('closed-unread', width);
    assert.equal(await input().count(), 0, 'Closed chat input must be absent from the accessibility tree');
    await launcher().click(); await panel().waitFor();
    await input().evaluate(el => { if (el !== document.activeElement) throw new Error('Input did not receive focus'); });
    await page.locator('.conversation .bubble-main_agent').last().waitFor();
    await page.waitForFunction(() => !document.querySelector('.conversation-unread'));
    await capture('compact-home', width);
    if (width === 1440) {
      const last = audits.at(-1); assert.ok(last.main.right <= last.panel.left, 'Office needs a clear reading lane');
    }
    await page.getByRole('button', { name: '대화 넓게 보기' }).click();
    await page.locator('.conversation').evaluate(el => { el.scrollTop = 0; });
    await capture('expanded', width);
    assert.equal(await page.locator('.conversation .bubble a', { hasText: '모바일 확인 메모.txt' }).count(), 1);
    await page.getByRole('button', { name: '대화 작게 보기' }).click();
    await page.getByRole('button', { name: '대화 닫기', exact: true }).click();
    assert.ok(await launcher().evaluate(el => el === document.activeElement));
    assert.ok((await fileEvent('dragover')).prevented); await page.locator('.command-drop-hint').waitFor();
    await capture('file-drag-closed', width);
    assert.ok((await fileEvent('drop')).outsideOldBar); await panel().waitFor();
    await page.locator('.upload-ready').waitFor(); await page.locator('.upload-error').waitFor();
    assert.ok(await page.locator('.upload-error [role="alert"]').evaluate(el => el.getBoundingClientRect().bottom <= el.closest('.attachment-chips').getBoundingClientRect().bottom), 'The error message must be visible above the compose actions');
    await capture('chips-ready-error', width);
    assert.ok(await page.getByRole('button', { name: '보내기', exact: true }).isDisabled());
    await page.getByRole('button', { name: '참고 자료.csv 다시 올리기' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.upload-ready').length === 2);
    await input().fill('메모와 자료를 함께 확인해 줘'); await page.getByRole('button', { name: '보내기', exact: true }).click();
    await page.locator('.toast', { hasText: '명령을 보냈습니다' }).waitFor();
    await page.getByRole('button', { name: '메인 에이전트 대화', exact: true }).click();
    await page.getByRole('button', { name: '서비스 개발 사무실 열기' }).click();
    await page.locator('.studio-scene-section').scrollIntoViewIfNeeded();
    await launcher().click(); await input().waitFor();
    assert.equal(await page.getByRole('combobox', { name: '명령 대상' }).inputValue(), 'P-8001');
    await capture('compact-department', width);
    await page.locator('.member-card').first().click(); await page.getByRole('button', { name: '팀원 상세 닫기' }).waitFor();
    await capture('with-member', width);
    await page.getByRole('button', { name: '팀원 상세 닫기' }).click();
    await input().focus(); await page.keyboard.press('Escape'); assert.equal(await panel().count(), 0);
    await launcher().focus(); await page.keyboard.press('Enter'); await input().waitFor();
    await page.emulateMedia({ reducedMotion: 'reduce' }); await capture('reduced-motion', width);
    assert.equal(audits.at(-1).animation, 'none');
    if (width === 390) {
      await page.locator('.toast').first().waitFor({ state: 'detached' });
      await page.evaluate(() => { Object.defineProperty(visualViewport, 'height', { value: 420, configurable: true }); visualViewport.dispatchEvent(new Event('resize')); });
      await page.waitForFunction(() => document.querySelector('.agent-chat-widget').style.getPropertyValue('--chat-viewport-height') === '420px');
      assert.ok(await input().evaluate(el => el.getBoundingClientRect().bottom <= 420), 'Input must stay above the simulated keyboard');
      assert.ok(await page.getByRole('button', { name: '보내기', exact: true }).evaluate(el => el.getBoundingClientRect().bottom <= 420), 'Send must stay above the simulated keyboard');
      await capture('keyboard-viewport', width);
      await page.evaluate(() => { delete visualViewport.height; visualViewport.dispatchEvent(new Event('resize')); });
    }
    await page.reload(); await page.locator('.company-live-office').waitFor(); assert.equal(await panel().count(), 0);
    await start(width, 'emergency'); await launcher().click(); await capture('emergency', width);
    checks.push({ width, keyboardOpenClose: true, dropOpens: true, retryAndSend: true, readMarks: true, reloadClosed: true });
  }
  // Preserve the previous command-drop browser coverage at the new entry point.
  await start(1440, 'busy', 'ok'); await launcher().click();
  await page.evaluate(() => {
    const source = document.createElement('p'); source.id = 'selected-text-fixture'; source.textContent = '드래그한 글';
    source.style.cssText = 'position:fixed;top:220px;left:280px;z-index:100;background:white;padding:12px'; document.body.append(source);
    const range = document.createRange(); range.selectNodeContents(source); getSelection().removeAllRanges(); getSelection().addRange(range);
  });
  const source = await page.locator('#selected-text-fixture').boundingBox(), destination = await input().boundingBox();
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2); await page.mouse.down(); await page.waitForTimeout(200);
  await page.mouse.move(destination.x + 40, destination.y + 25, { steps: 24 }); await page.waitForTimeout(200); await page.mouse.up();
  assert.equal(await input().inputValue(), '드래그한 글'); await page.locator('#selected-text-fixture').evaluate(el => el.remove());
  checks.push('Native selected text drag still inserts into the command textarea');
  for (const cancel of ['window-leave', 'Escape', 'blur', 'dragend', 'silent-cancel']) {
    await fileEvent('dragover'); await page.locator('.command-drop-hint').waitFor();
    if (cancel === 'window-leave') await page.evaluate(() => document.documentElement.dispatchEvent(new DragEvent('dragleave', { bubbles: true, relatedTarget: null })));
    else if (cancel === 'Escape') await page.keyboard.press('Escape');
    else if (cancel === 'blur' || cancel === 'dragend') await page.evaluate(type => window.dispatchEvent(new Event(type)), cancel);
    await page.locator('.command-drop-hint').waitFor({ state: 'detached', timeout: 2000 });
    assert.equal(await page.locator('.upload-chip').count(), 0);
    checks.push(`${cancel} clears file-drag feedback`);
  }
  if (!await panel().count()) await launcher().click();
  await fileEvent('dragenter', ['대화 위 첨부.txt'], 'conversation'); await page.locator('.command-drop-hint').waitFor();
  await fileEvent('drop', ['대화 위 첨부.txt'], 'conversation'); await page.locator('.upload-ready').waitFor();
  const unsent = await page.evaluate(async () => (await import('/src/api/fake/index.ts')).fakeBridge.invoke('command.history', 'main', { limit: 60 }));
  assert.ok(!unsent.some(message => message.attachments.some(file => file.name === '대화 위 첨부.txt')));
  await fileEvent('drop', ['추가 파일.txt'], 'composer'); assert.equal(await page.locator('.upload-chip').count(), 2);
  await page.getByRole('button', { name: '대화 위 첨부.txt 첨부 제거' }).click(); await page.getByRole('button', { name: '추가 파일.txt 첨부 제거' }).click();
  checks.push('Conversation and later composer drops preserve attachments, focus input and wait for an explicit send');
  await page.locator('.palette-trigger').click(); await page.getByRole('dialog', { name: '빠른 이동' }).waitFor();
  for (const location of ['modal', 'middle']) {
    assert.ok((await fileEvent('dragover', ['차단.txt'], location)).prevented); assert.equal(await page.locator('.command-drop-hint').count(), 0);
    assert.ok((await fileEvent('drop', ['차단.txt'], location)).prevented); assert.equal(await page.locator('.upload-chip').count(), 0);
    assert.ok(await page.getByRole('dialog', { name: '빠른 이동' }).getByRole('combobox').evaluate(el => el === document.activeElement));
  }
  await page.keyboard.press('Escape'); await panel().waitFor();
  checks.push('A modal blocks file attachment and chat focus; Escape closes that modal and keeps chat open');
  const chooser = page.waitForEvent('filechooser'); await page.getByRole('button', { name: '파일 첨부', exact: true }).focus(); await page.keyboard.press('Enter');
  await (await chooser).setFiles({ name: 'keyboard.txt', mimeType: 'text/plain', buffer: Buffer.from('keyboard') });
  await page.getByRole('button', { name: 'keyboard.txt 첨부 제거' }).waitFor();
  await page.evaluate(() => {
    const data = new DataTransfer(); data.items.add(new File(['pixels'], 'pasted.png', { type: 'image/png' }));
    const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data });
    document.querySelector('textarea[aria-label="명령 입력"]').dispatchEvent(event); if (!event.defaultPrevented) throw new Error('Image paste was not handled');
  });
  await page.waitForFunction(() => document.querySelectorAll('.upload-ready').length === 2);
  await input().fill('첨부를 검토해 줘');
  await input().evaluate(el => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true })));
  assert.equal(await input().inputValue(), '첨부를 검토해 줘');
  await input().press('Shift+Enter'); assert.ok((await input().inputValue()).includes('\n'));
  await input().press('Enter'); await page.waitForFunction(() => document.querySelectorAll('.upload-chip').length === 0);
  await page.locator('.conversation').getByRole('link', { name: /keyboard.txt/ }).waitFor();
  const history = await page.evaluate(async () => (await import('/src/api/fake/index.ts')).fakeBridge.invoke('command.history', 'main', { limit: 60 }));
  assert.ok(history.some(message => message.attachments.some(file => file.name === 'keyboard.txt' && file.size === 8 && file.mime === 'text/plain')));
  checks.push('Keyboard paperclip, image paste, Korean composing Enter, Shift+Enter, Enter send, attachment metadata and bubble download links');
  assert.deepEqual(errors, []);
  writeFileSync(resolve(output, 'capture-results.json'), JSON.stringify({ audits, checks, errors }, null, 2) + '\n');
} finally {
  await browser?.close(); await server?.close();
  assert.equal(dirname(temporary), resolve(tmpdir()), 'Only remove the temporary directory created by this run');
  rmSync(temporary, { recursive: true, force: true });
}
