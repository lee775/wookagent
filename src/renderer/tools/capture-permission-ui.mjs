import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, sep } from 'node:path';

const workspace = resolve('.');
const profile = resolve('src/renderer/.permission-browser-profile');
if (!profile.startsWith(workspace + sep) || !profile.endsWith('.permission-browser-profile')) throw new Error('Unexpected browser profile path');
const output = resolve('docs/design/permission-ui');
mkdirSync(output, { recursive: true });
const browser = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
  '--headless=new', '--disable-gpu', '--disable-gpu-sandbox', '--no-sandbox', '--in-process-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=9336', `--user-data-dir=${profile}`, 'about:blank',
], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
let browserErrors = '';
browser.stderr.on('data', chunk => { browserErrors += chunk; });
const pause = ms => new Promise(done => setTimeout(done, ms));
let socket;
let sequence = 0;
const pending = new Map();
function send(method, params = {}) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timed out: ${method}; ${browserErrors.slice(-1500)}`)); }, 10000);
    pending.set(id, { resolve: value => { clearTimeout(timeout); resolve(value); }, reject: error => { clearTimeout(timeout); reject(error); } });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
const evaluate = async expression => {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
};
async function waitFor(expression) {
  for (let i = 0; i < 100; i++) { try { if (await evaluate(`Boolean(${expression})`)) return; } catch { /* navigating */ } await pause(100); }
  throw new Error(`Timed out: ${expression}; page: ${await evaluate('document.body.innerText')}`);
}
const audits = [];
try {
  let pages;
  for (let i = 0; i < 100; i++) { try { pages = await (await fetch('http://127.0.0.1:9336/json/list')).json(); break; } catch { await pause(100); } }
  socket = new WebSocket(pages.find(page => page.type === 'page').webSocketDebuggerUrl);
  await new Promise((done, reject) => { socket.onopen = done; socket.onerror = reject; });
  socket.onmessage = event => { const response = JSON.parse(event.data); const listener = pending.get(response.id); if (listener) { pending.delete(response.id); response.error ? listener.reject(new Error(JSON.stringify(response.error))) : listener.resolve(response.result); } };
  await send('Page.enable'); await send('Runtime.enable');
  for (const width of [1440, 390]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: width === 1440 ? 1000 : 844, deviceScaleFactor: 1, mobile: false });
    for (const screen of ['home', 'member', 'main-paused', 'studio', 'task', 'documents', 'settings']) {
      const capture = screen === 'task' ? 'task-T-0009' : screen === 'studio' ? 'home' : screen;
      await send('Page.navigate', { url: `http://127.0.0.1:5196/?capture=${capture}&studio3d=0` });
      await waitFor("document.querySelector('.login-dev')");
      await evaluate("document.querySelector('.login-dev').click()");
      await waitFor("document.querySelector('.app-shell') && !document.querySelector('.loading')");
      if (screen === 'studio') {
        await evaluate("document.querySelector('.project-card').click()");
        await waitFor("document.querySelector('.screen.studio')");
      }
      if (screen === 'settings') {
        await waitFor("document.querySelector('.settings-nav')");
        await evaluate("[...document.querySelectorAll('.settings-nav button')].find(button => button.textContent === '설치 설정').click()");
        await waitFor("document.querySelector('.installation-fields')");
      }
      if (screen === 'main-paused') {
        await evaluate("[...document.querySelectorAll('.main-pause-notice button')].find(button => button.textContent === '메인 에이전트 상태 보기').click()");
        await waitFor("document.querySelector('.member-panel .main-pause-notice')");
      }
      if (screen === 'documents') await waitFor("document.querySelector('.report-head')");
      if (screen === 'task') await waitFor("document.querySelector('.hold-hint')");
      if (screen === 'member') await waitFor("document.querySelector('.member-hero')");
      await evaluate("document.querySelector('.main-content').scrollTop = 0");
      await evaluate('document.fonts.ready');
      await pause(180);
      const audit = await evaluate(`(() => {
        const visible = element => { const rect = element.getBoundingClientRect(); const style = getComputedStyle(element); return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && rect.top < innerHeight && rect.bottom > 0; };
        const buttons = [...document.querySelectorAll('button')].filter(visible).map(element => element.textContent.trim());
        const overflow = [...document.querySelectorAll('button,label,h1,h2,strong')].filter(visible).filter(element => element.scrollWidth > element.clientWidth + 2).map(element => ({ text: element.textContent.trim().slice(0, 100), width: element.clientWidth, scroll: element.scrollWidth }));
        return { width: innerWidth, documentWidth: document.documentElement.scrollWidth, buttons, overflow };
      })()`);
      const image = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      writeFileSync(resolve(output, `${screen}-${width}.png`), Buffer.from(image.data, 'base64'));
      audits.push({ screen, ...audit });
      console.log(`${screen}-${width}: document ${audit.documentWidth}, overflow ${audit.overflow.length}`);
      if (audit.documentWidth > width || audit.overflow.length) throw new Error(`Layout failed on ${screen}-${width}`);
      const operation = audit.buttons.find(text => /^(일시정지|재개|중단|팀원 추가|설정 변경|검수 등록|검수자에게 메시지 보내기|지시 취소|작업 취소)$/.test(text));
      if (operation) throw new Error(`Owner operation still visible: ${operation}`);
      const extraCapture = async name => {
        await pause(120);
        const extra = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        writeFileSync(resolve(output, `${name}-${width}.png`), Buffer.from(extra.data, 'base64'));
      };
      if (screen === 'home') {
        await evaluate("document.querySelector('.todo-list').scrollIntoView({block:'start'})");
        await extraCapture('home-todos');
        await evaluate("document.querySelector('.page-heading > button').click()");
        await waitFor("document.querySelector('.command-input textarea').value === '새 프로젝트를 만들어 줘: '");
        const target = await evaluate("document.querySelector('.command-compose select').value");
        if (target !== 'main') throw new Error('New project shortcut must target main');
        await extraCapture('command-new-project');
      }
      if (screen === 'studio') {
        await evaluate("document.querySelector('.member-grid').scrollIntoView({block:'start'})");
        await extraCapture('studio-members');
      }
      if (screen === 'main-paused') {
        await evaluate("document.querySelector('.slide-head button').click(); document.querySelector('.todo-list').scrollIntoView({block:'start'})");
        await extraCapture('main-paused-home');
      }
      if (screen === 'task') {
        await evaluate("[...document.querySelectorAll('.modal-body .section')].find(section=>section.querySelector('h2')?.textContent==='보류 사유').scrollIntoView({block:'start'})");
        await extraCapture('task-hold');
      }
      if (screen === 'settings') {
        for (const [name, expression] of [
          ['settings-ai', "document.querySelector('.installation-ai')"],
          ['settings-policy', "[...document.querySelectorAll('.installation-fields h3')].find(element=>element.textContent==='보안 정책')"],
        ]) {
          await evaluate(`${expression}.scrollIntoView({block:'start'})`);
          await extraCapture(name);
        }
      }
      if (screen === 'documents') {
        await evaluate("document.querySelector('.report-footer').scrollIntoView({block:'center'})");
        await extraCapture('documents-actions');
        await evaluate("[...document.querySelectorAll('.report-footer button')].find(button=>button.textContent.includes('수정 요청')).click()");
        await waitFor("document.querySelector('.modal textarea')");
        await evaluate("document.querySelector('.modal textarea').focus()");
        await send('Input.insertText', { text: '장소 카드의 문구를 더 분명하게 고쳐 주세요.' });
        await evaluate("[...document.querySelectorAll('.modal button')].find(button=>button.textContent==='수정 요청 보내기').click()");
        await waitFor("!document.querySelector('.modal') && document.querySelector('.report-footer button')");
        await evaluate("document.querySelector('.report-footer').scrollIntoView({block:'center'})");
        await extraCapture('documents-changes-requested');
      }
      // Additional scroll captures retain lower sections of long panels and forms.
      if (['member', 'settings', 'task'].includes(screen)) {
        const scroller = screen === 'member' ? '.slide-scroll' : screen === 'task' ? '.modal-body' : '.main-content';
        await evaluate(`document.querySelector('${scroller}').scrollTop = document.querySelector('${scroller}').scrollHeight`);
        await pause(120);
        const lower = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        writeFileSync(resolve(output, `${screen}-lower-${width}.png`), Buffer.from(lower.data, 'base64'));
      }
      if (screen === 'settings') {
        for (const section of ['팀과 역할', '실행', '실행 정책·정지', '스킬', '개발자 옵션']) {
          await evaluate(`[...document.querySelectorAll('.settings-nav button')].find(button => button.textContent === ${JSON.stringify(section)}).click()`);
          await waitFor("document.querySelector('.settings-content .section')");
          await evaluate("document.querySelector('.main-content').scrollTop = 0");
          await pause(120);
          const controls = await evaluate("document.querySelectorAll('.settings-content input,.settings-content select,.settings-content textarea').length");
          if (controls !== 0) throw new Error(`Editable operations in ${section}`);
          await extraCapture(`settings-${({ '팀과 역할': 'team', '실행': 'execution', '실행 정책·정지': 'operations', '스킬': 'skills', '개발자 옵션': 'developer' })[section]}`);
        }
      }
    }
  }
  writeFileSync(resolve(output, 'layout-audit.json'), JSON.stringify(audits, null, 2) + '\n');
} finally {
  if (socket?.readyState === 1) { try { await send('Browser.close'); } catch { /* closed by command */ } socket.close(); }
  // Only this script's isolated browser can still be running here.
  if (browser.exitCode === null) await Promise.race([new Promise(done => browser.once('exit', done)), pause(3000)]);
  if (browser.exitCode === null) browser.kill();
  await pause(300);
  // Both the absolute path and the exact task-specific directory name were verified above.
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
