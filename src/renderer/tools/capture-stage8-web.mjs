import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

const output = resolve('docs/design/permission-ui/stage8-web');
const fix1 = process.argv.includes('--fix1');
const wrapup = process.argv.includes('--wrapup');
const temporary = mkdtempSync(resolve(tmpdir(), 'wook-stage8-'));
mkdirSync(output, { recursive: true });
const audits = [], errors = [];
let server, browser;
try {
  server = await createServer({ configFile: resolve('vite.web.config.ts'), configLoader: 'runner', cacheDir: resolve(temporary, 'vite'), server: { host: '127.0.0.1', port: 5196, strictPort: true } });
  await server.listen();
  browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--disable-gpu', '--disable-gpu-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  if (fix1) await context.addInitScript(() => {
    window.__notificationPermission = 'default';
    class CaptureNotification {
      static get permission() { return window.__notificationPermission; }
      static requestPermission() { window.__notificationPermission = 'granted'; return Promise.resolve('granted'); }
      constructor() { throw new TypeError('Capture: notification constructor unavailable'); }
    }
    window.Notification = CaptureNotification;
    // Exercise the documented fallback failure without relying on the headless OS policy.
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: undefined });
  });
  if (wrapup) await context.addInitScript(() => {
    window.__shownNotifications = [];
    if (location.search.includes('captureUnsupported=1')) window.Notification = undefined;
    else {
      class CaptureNotification {
        static permission = 'granted';
        constructor(title, options) { window.__shownNotifications.push({ title, options }); }
        close() {}
      }
      window.Notification = CaptureNotification;
    }
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: undefined });
  });
  const page = await context.newPage();
  // This is a fake-screen capture, independent of the concurrently edited production bootstrap.
  await page.route('**/src/main.tsx*', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: `window.wook = (await import('/src/api/fake/index.ts')).fakeBridge;\n${await response.text()}` });
  });
  page.on('pageerror', error => errors.push(error.message));
  let assets = [];
  page.on('request', request => { if (/\.glb|\/studio3d\/portrait|three\.module/.test(request.url())) assets.push(request.url()); });
  async function start(width, flags = '') {
    assets = [];
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await page.goto(`http://127.0.0.1:5196/?${flags}`);
    await page.getByRole('button', { name: '개발 모드로 시작하기' }).click();
    await page.locator('.home-todos').waitFor();
    await page.evaluate(async () => {
      const { fakeBridge } = await import('/src/api/fake/index.ts');
      const { snapshot } = await import('/src/api/fake/data.ts');
      snapshot.auth.mode = 'server';
      window.__fake = fakeBridge; window.__data = snapshot; window.__calls = [];
      const original = fakeBridge.invoke.bind(fakeBridge);
      const upload = fakeBridge.web.upload.bind(fakeBridge.web); window.__uploadCalls = 0;
      fakeBridge.web.upload = (...args) => { window.__uploadCalls++; return upload(...args); };
      window.wook = { ...fakeBridge, invoke: async (method, ...args) => { window.__calls.push({ method, args }); return original(method, ...args); } };
      window.dispatchEvent(new Event('wook:authorized'));
    });
    await page.getByRole('status', { name: '서버 연결 상태' }).waitFor();
  }
  async function capture(name, width) {
    await page.evaluate(() => document.fonts.ready);
    const audit = await page.evaluate(() => {
      const compose = document.querySelector('.command-compose').getBoundingClientRect();
      return { width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth,
        composer: { top: compose.top, bottom: compose.bottom },
        connection: document.querySelector('.web-connection')?.textContent,
        screen: document.querySelector('.main-content')?.innerText.slice(0, 180),
        forbidden: [...document.querySelectorAll('button')].filter(b => /팀원 추가|팀원 해고|자리 교체|작업 보드 · 준비 중/.test(b.textContent)).map(b => b.textContent),
        cards: [...document.querySelectorAll('.project-card')].map(card => { const box = card.getBoundingClientRect(); return { left: box.left, right: box.right, scrollWidth: card.scrollWidth, width: box.width }; }),
        shownNotifications: window.__shownNotifications,
        noticeCount: document.querySelectorAll('[aria-label="브라우저 알림을 표시할 수 없음"]').length };
    });
    if (audit.documentWidth > width || audit.composer.bottom > audit.height + 1 || audit.forbidden.length) throw new Error(`${name}: ${JSON.stringify(audit)}`);
    if (audit.cards.some(card => card.right > width || card.scrollWidth > card.width + 1)) throw new Error(`${name}: project card overflow`);
    const filename = `${name}-${width}.png`;
    await page.screenshot({ path: resolve(output, filename) });
    audits.push({ filename, ...audit, threeRequests: [...assets] });
    console.log(filename);
  }
  async function nav(name) { await page.locator('.sidebar').getByRole('button', { name, exact: true }).click(); }
  if (wrapup) for (const width of [1440, 390]) {
    await start(width);
    await page.evaluate(() => localStorage.clear());
    await start(width, 'captureUnsupported=1');
    const notice = page.getByRole('status', { name: '브라우저 알림을 표시할 수 없음' });
    await notice.getByRole('button', { name: '브라우저 알림 불가 안내 닫기' }).waitFor();
    await capture('wrapup-notification-notice', width);
    await nav('문서함');
    if (await notice.count()) throw new Error('Notification notice repeated on Documents');
    await nav('프로젝트');
    await notice.getByRole('button', { name: '브라우저 알림 불가 안내 닫기' }).click();
    await notice.waitFor({ state: 'detached' });
    await start(width, 'captureUnsupported=1');
    if (await notice.count()) throw new Error('Notice dismissal did not survive reload');
    await capture('wrapup-notification-dismissed', width);
    await start(width);
    await page.evaluate(async () => {
      const { notifications } = await import('/src/api/fake/data.ts');
      // No topic is emitted: simulate a silently dead stream, with a server clock far behind the page.
      const missed = ['연결을 기다리는 동안 도착한 알림 1', '연결을 기다리는 동안 도착한 알림 2'].map((title, index) => ({
        ...notifications[0], id: `wrapup-missed-${index}`, title, body: '알림 목록을 다시 읽어 복구했습니다.', read: false,
        createdAt: '2020-01-01T00:00:00Z', link: { tab: 'documents' },
      }));
      notifications.unshift(...missed);
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      window.__fake.web.setConnection({ status: 'reconnecting', lostAt: Date.now(), attempt: 1, retryAt: null });
      window.__fake.web.setConnection({ status: 'open', runId: 'wrapup', since: Date.now() });
      window.__fake.web.resync();
    });
    await page.waitForFunction(() => window.__shownNotifications.length === 1);
    await page.evaluate(async () => {
      window.__fake.web.resync();
      // Wait for the second list read and its promise callbacks before checking deduplication.
      await new Promise(resolve => setTimeout(resolve, 150));
      if (window.__shownNotifications.length !== 1) throw new Error('Duplicate missed notification');
      const item = window.__shownNotifications[0];
      if (item.title !== '욱채 알림' || item.options.body !== '작업실에 확인할 새 알림이 2개 있습니다.') throw new Error('Wrong missed notification text');
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    });
    await page.getByRole('button', { name: '알림함', exact: true }).click();
    await page.locator('.notification-menu').getByText('연결을 기다리는 동안 도착한 알림 2', { exact: true }).waitFor();
    await capture('wrapup-missed-notifications', width);
  }
  else if (fix1) for (const width of [1440, 390]) {
    await start(width);
    await page.getByRole('button', { name: '브라우저 알림 켜기' }).waitFor();
    await capture('fix1-notification-offer', width);
    await page.evaluate(async () => {
      window.__notificationPermission = 'granted';
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      const { showBrowserNotification } = await import('/src/lib/browserNotifications.ts');
      await showBrowserNotification({ id: 'capture-unavailable', link: null }, () => undefined);
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    });
    await page.getByRole('status', { name: '브라우저 알림을 표시할 수 없음' }).waitFor();
    if (await page.getByRole('button', { name: '브라우저 알림 켜기' }).count()) throw new Error('Failed notification offer still visible');
    await capture('fix1-notification-unavailable', width);
    await start(width, 'fakeUpload=rate_limited');
    await page.getByLabel('첨부할 파일 선택').setInputFiles({ name: '다시 대기하는 메모.txt', mimeType: 'text/plain', buffer: Buffer.from('queued again') });
    await page.waitForFunction(() => window.__uploadCalls === 3 && document.querySelector('.upload-queued'));
    await page.getByRole('status', { name: '다시 대기하는 메모.txt 업로드 대기' }).waitFor();
    if (await page.locator('.upload-chip [role=alert]').count()) throw new Error('Rate limit shown as an error before retries');
    await capture('fix1-upload-queued-again', width);
    await page.getByText('첨부 준비됨', { exact: true }).waitFor();
    await start(width);
    await page.evaluate(async () => {
      window.__data.projects[0].path = 'C:/Projects/' + '아주긴프로젝트폴더'.repeat(14) + '/workspace';
      await window.__fake.invoke('notifications.markRead', 'all');
    });
    await page.locator('.project-path').filter({ hasText: '아주긴프로젝트폴더' }).waitFor();
    await page.locator('.project-card').first().scrollIntoViewIfNeeded();
    const pathLayout = await page.locator('.project-path').first().evaluate(path => ({ height: path.getBoundingClientRect().height, line: parseFloat(getComputedStyle(path).lineHeight), whiteSpace: getComputedStyle(path).whiteSpace }));
    if (pathLayout.whiteSpace === 'nowrap' || pathLayout.height <= pathLayout.line) throw new Error('Long path did not wrap');
    await capture('fix1-home-long-path', width);
    await start(width);
    const directive = await page.evaluate(async () => {
      const d = window.__data.directives.find(item => item.projectId === window.__data.projects[0].id);
      d.attachments = [{ id: 'A-123', name: '화면 검토 자료.txt', path: 'C:/fixture/review.txt', mimeType: 'text/plain', size: 20 }];
      await window.__fake.invoke('notifications.markRead', 'all'); return { title: d.title };
    });
    await page.locator('.project-card').first().click();
    await page.locator('.directive-title').filter({ hasText: directive.title }).click();
    const dialog = page.getByRole('dialog', { name: directive.title });
    await dialog.getByRole('link', { name: '화면 검토 자료.txt' }).waitFor();
    if (await dialog.getByRole('link', { name: '화면 검토 자료.txt' }).count() !== 1) throw new Error('Duplicate directive attachment');
    await capture('fix1-directive-attachments', width);
    await start(width);
    const report = await page.evaluate(async () => {
      const { reports } = await import('/src/api/fake/data.ts');
      const r = reports[0]; r.status = 'read'; r.directiveId = null;
      r.projectId = window.__data.projects[0].id; r.projectName = window.__data.projects[0].name;
      return { id: r.id, title: r.title, projectId: r.projectId };
    });
    await nav('문서함');
    await page.locator('.report-list-item').filter({ hasText: report.title }).click();
    await page.locator('.report-footer').getByRole('button', { name: '수정 요청', exact: true }).click();
    await page.getByRole('textbox', { name: '전체 코멘트' }).fill('표에 비교 근거를 더해 주세요.');
    await page.getByRole('button', { name: '수정 요청 보내기', exact: true }).click();
    await page.locator('.conversation').getByText('표에 비교 근거를 더해 주세요.', { exact: false }).waitFor();
    if (await page.getByRole('combobox', { name: '명령 대상' }).inputValue() !== report.projectId) throw new Error('Wrong project conversation');
    await page.locator('.doc-viewer [role=status]').scrollIntoViewIfNeeded();
    await page.locator('.conversation .bubble-owner').filter({ hasText: '표에 비교 근거를 더해 주세요.' }).scrollIntoViewIfNeeded();
    await page.waitForFunction(() => document.querySelectorAll('.toast-stack .toast').length === 0);
    await capture('fix1-documents-change-request', width);
  }
  else for (const width of [1440, 390]) {
    await start(width, 'fakeConn=reconnecting');
    await capture('home-reconnecting-notification-offer', width);
    if (assets.length) throw new Error('Home loaded a 3D asset');
    await nav('운영 설정');
    await page.getByRole('button', { name: '계정과 기기', exact: true }).click();
    await page.getByRole('heading', { name: '대표 계정' }).waitFor();
    if (await page.getByRole('textbox', { name: 'Google 클라이언트 ID' }).count()) throw new Error('Installation form visible on web');
    await capture('account', width);
    await page.getByRole('button', { name: '기록', exact: true }).click();
    await page.getByRole('button', { name: '내보내기', exact: true }).click();
    await page.getByRole('link', { name: '내보낸 기록 내려받기' }).waitFor();
    await capture('log-download', width);
    await nav('문서함');
    await page.locator('.report-list-item').first().click();
    await page.getByRole('link', { name: '보고서 내려받기' }).waitFor();
    if (width === 390) await page.locator('.report-footer').scrollIntoViewIfNeeded();
    await capture('report-download', width);
    await start(width, 'fakeSeat=unresponsive');
    await nav('자리와 인계');
    await page.getByRole('heading', { name: '지금 메인 자리' }).waitFor();
    if (width === 390) await page.locator('.seat-response-state').scrollIntoViewIfNeeded();
    await capture('seat-unresponsive', width);
    await page.locator('.seat-screen').getByRole('button', { name: '메인 에이전트에게 말하기', exact: true }).click();
    await page.getByRole('textbox', { name: '명령 입력' }).blur();
    if (!(await page.getByRole('textbox', { name: '명령 입력' }).inputValue()).includes('현재 상태')) throw new Error('Seat shortcut did not fill composer');
    await start(width, 'fakeUpload=slow');
    await page.getByLabel('첨부할 파일 선택').setInputFiles({ name: '화면 검토.png', mimeType: 'image/png', buffer: Buffer.from('capture fixture') });
    await page.getByRole('progressbar', { name: '화면 검토.png 업로드 진행률' }).waitFor();
    await capture('upload-progress', width);
    await start(width, 'fakeUpload=fail');
    await page.getByLabel('첨부할 파일 선택').setInputFiles({ name: '기획 메모.txt', mimeType: 'text/plain', buffer: Buffer.from('review') });
    await page.getByRole('button', { name: '기획 메모.txt 다시 올리기' }).waitFor();
    await capture('upload-error', width);
    await page.getByRole('button', { name: '기획 메모.txt 다시 올리기' }).click();
    await page.getByText('첨부 준비됨', { exact: true }).waitFor();
    await page.getByRole('textbox', { name: '명령 입력' }).fill('첨부 파일을 검토해 줘');
    await page.getByRole('button', { name: '보내기', exact: true }).click();
    const command = await page.evaluate(() => window.__calls.find(call => call.method === 'command.send'));
    if (!command?.args[0].attachments[0].uploadId || 'path' in command.args[0].attachments[0]) throw new Error('Invalid web attachment');
    await page.getByRole('button', { name: '대화 기록 펼치기' }).click();
    await page.getByRole('link', { name: '기획 메모.txt' }).waitFor();
    await capture('conversation-attachment', width);
    await start(width);
    await page.locator('.main-agent-banner').click();
    await page.getByRole('complementary', { name: '팀원 상세' }).waitFor();
    await capture('member', width);
    if (assets.length) throw new Error('Member portrait loaded a 3D asset');
    await page.getByRole('button', { name: '팀원 상세 닫기' }).click();
    if (width === 390) {
      await page.locator('.project-nav button').nth(1).click();
      await page.getByRole('heading', { name: '지금 작업실' }).waitFor();
      await capture('studio', width);
      await page.getByRole('textbox', { name: '명령 입력' }).fill('휴대폰에서 작업을 확인해 줘');
      // Desktop headless cannot open an OS keyboard. A reduced visual viewport reproduces its available space.
      await page.setViewportSize({ width: 390, height: 500 });
      await page.getByRole('textbox', { name: '명령 입력' }).focus();
      await page.waitForFunction(() => document.querySelector('.app-shell').getBoundingClientRect().height <= innerHeight + 1);
      await capture('studio-keyboard-viewport', width);
      await start(390, 'fakeConn=reconnecting&fakeSeat=unresponsive');
      await page.setViewportSize({ width: 390, height: 500 });
      for (const screen of ['프로젝트', '문서함', '자리와 인계', '운영 설정']) {
        await nav(screen);
        await page.getByRole('textbox', { name: '명령 입력' }).focus();
        await page.waitForFunction(() => document.querySelector('.app-shell').getBoundingClientRect().height <= innerHeight + 1);
        await capture(`keyboard-${screen}`, width);
      }
      for (const section of ['계정과 기기', '팀과 역할', '실행', '실행 정책·정지', '스킬', '기록', '개발자 옵션']) {
        await page.locator('.settings-nav').getByRole('button', { name: section, exact: true }).click();
        await page.getByRole('textbox', { name: '명령 입력' }).focus();
        await capture(`keyboard-${section}`, width);
      }
    } else {
      await start(width, 'studio3d=0');
      await page.locator('.project-nav button').nth(1).click();
      await page.getByRole('heading', { name: '지금 작업실' }).waitFor();
      await capture('studio', width);
    }
  }
  if (errors.length) throw new Error(errors.join('\n'));
} finally {
  await browser?.close();
  await server?.close();
  writeFileSync(resolve(output, wrapup ? 'browser-audit-wrapup.json' : fix1 ? 'browser-audit-fix1.json' : 'browser-audit.json'), JSON.stringify({ audits, errors }, null, 2) + '\n');
  if (!temporary.startsWith(resolve(tmpdir()))) throw new Error('Unexpected temp path');
  rmSync(temporary, { recursive: true, force: true });
}
