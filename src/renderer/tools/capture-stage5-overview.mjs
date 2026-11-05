import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, sep } from 'node:path';
import { createServer } from 'vite';

const tempRoot = resolve(tmpdir()), temp = mkdtempSync(resolve(tempRoot, 'wook-stage5-overview-'));
const output = resolve('docs/design/permission-ui/stage5-overview');
mkdirSync(output, { recursive: true });
const audits = [], runtimeErrors = [], consoleErrors = [];
let server, browser, socket, sequence = 0, stderr = '';
const pending = new Map(), pause = ms => new Promise(done => setTimeout(done, ms));
function send(method, params = {}) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function waitFor(expression) {
  for (let i = 0; i < 150; i++) {
    try { if (await evaluate(`Boolean(${expression})`)) return; } catch { /* Navigation changes context. */ }
    await pause(100);
  }
  throw new Error(`Timed out: ${expression}; page=${await evaluate('document.body.innerText')}`);
}
const click = text => evaluate(`(() => { const button=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)}); if(!button)throw new Error('Missing button');button.click(); })()`);
async function navigate(width) {
  await send('Emulation.setDeviceMetricsOverride', { width, height: 1100, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: 'http://127.0.0.1:5196/?studio3d=0&capture=stage5' });
  await waitFor("document.querySelector('.login-dev')");
  await evaluate("document.querySelector('.login-dev').click()");
  await waitFor("document.querySelector('.home-todos')");
  await evaluate(`(async()=>{
    window.__data=await import('/src/api/fake/data.ts');
    window.__fake=(await import('/src/api/fake/index.ts')).fakeBridge;
    window.__calls=[];
    window.wook={...window.__fake,platform:'win32',invoke:async(method,...args)=>{window.__calls.push({method,args});return window.__fake.invoke(method,...args);}};
  })()`);
}
async function capture(name, width, selector, expected) {
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`);
  await evaluate('document.fonts.ready'); await pause(180);
  const audit = await evaluate(`(() => {
    const target=document.querySelector(${JSON.stringify(selector)}),r=target.getBoundingClientRect();
    const container=target.closest('.modal-body')??document.querySelector('.main-content');
    const controls=[...target.querySelectorAll('button,summary')].map(e=>({text:e.textContent.trim(),height:e.getBoundingClientRect().height}));
    const visible=container.getBoundingClientRect();
    return {width:innerWidth,height:innerHeight,scale:devicePixelRatio,documentWidth:document.documentElement.scrollWidth,
      containerWidth:container.clientWidth,containerScrollWidth:container.scrollWidth,text:target.innerText,top:r.top,bottom:r.bottom,
      visibleTop:visible.top,visibleBottom:visible.bottom,controls,overflow:target.scrollWidth>target.clientWidth+1};
  })()`);
  if (!audit.text.includes(expected) || audit.documentWidth > width || audit.containerScrollWidth > audit.containerWidth + 1 || audit.overflow || audit.top < audit.visibleTop - 1 || audit.bottom > audit.visibleBottom + 1 || audit.controls.some(control => control.height < 44)) throw new Error(`Layout/text: ${name}: ${JSON.stringify(audit)}`);
  const png = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const filename = `${name}-${width}.png`;
  writeFileSync(resolve(output, filename), Buffer.from(png.data, 'base64'));
  audits.push({ filename, ...audit }); console.log(`${filename}: text and horizontal layout verified`);
}
async function openTask(id) {
  await click('실행 정책·정지');
  await waitFor("document.querySelector('.hold-list')");
  const title = await evaluate(`window.__data.tasks.find(t=>t.id===${JSON.stringify(id)}).title`);
  await click(title); await waitFor("document.querySelector('.hold-reason')");
}
async function closeModal() {
  await evaluate("document.querySelector('.modal-header button[aria-label=닫기]').click()");
  await waitFor("!document.querySelector('.modal')");
}
try {
  server = await createServer({ configFile: resolve('vite.web.config.ts'), configLoader: 'runner', cacheDir: resolve(temp, 'vite'), server: { host: '127.0.0.1', port: 5196, strictPort: true } });
  await server.listen();
  browser = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', '--disable-gpu', '--disable-gpu-sandbox', '--no-sandbox', '--in-process-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${resolve(temp, 'chrome')}`, 'about:blank'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, TMP: temp, TEMP: temp } });
  browser.stderr.on('data', chunk => { stderr += chunk; });
  const portFile = resolve(temp, 'chrome/DevToolsActivePort');
  for (let i = 0; i < 100 && !existsSync(portFile); i++) await pause(100);
  if (!existsSync(portFile)) throw new Error(`Chrome failed: ${stderr.slice(-1500)}`);
  const port = Number(readFileSync(portFile, 'utf8').split('\n')[0]);
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(pages.find(page => page.type === 'page').webSocketDebuggerUrl);
  await new Promise((done, reject) => { socket.onopen = done; socket.onerror = reject; });
  socket.onmessage = event => {
    const response = JSON.parse(event.data), listener = pending.get(response.id);
    if (listener) { pending.delete(response.id); response.error ? listener.reject(new Error(JSON.stringify(response.error))) : listener.resolve(response.result); }
    if (response.method === 'Runtime.exceptionThrown') runtimeErrors.push(response.params.exceptionDetails);
    if (response.method === 'Runtime.consoleAPICalled' && response.params.type === 'error') consoleErrors.push(response.params.args.map(arg => arg.value ?? arg.description).join(' '));
  };
  await send('Page.enable'); await send('Runtime.enable');
  for (const width of [1440, 390]) {
    await navigate(width);
    const home = await evaluate(`({count:document.querySelector('.todo-number').textContent,main:[...document.querySelectorAll('.home-todos>section:nth-child(2) .todo')].map(e=>e.innerText)})`);
    if (home.count !== '3' || home.main.length !== 3 || home.main.some(text => text.includes('명령창으로') || text.includes('따로 전해지지'))) throw new Error(`Home grouping: ${JSON.stringify(home)}`);
    await capture('home-owner', width, '.home-todos>section:nth-child(1)', '대표 할 일');
    await capture('home-main', width, '.home-todos>section:nth-child(2)', '메인 에이전트가 처리 중');
    await capture('home-attention', width, '.home-todos>section:nth-child(3)', '명령창으로 메인 에이전트에게 알려 주세요');
    await evaluate("document.querySelector('.home-todos>section:nth-child(2) details').open=true");
    // The second item contains an old command-box exit. The default view above hid it.
    await evaluate("document.querySelectorAll('.home-todos>section:nth-child(2) details')[1].open=true");
    if (!await evaluate("document.querySelectorAll('.home-todos>section:nth-child(2) details')[1].innerText.includes('명령창으로 메인 에이전트에게 알려 주세요')")) throw new Error('Historical note lost');
    audits.push({ check: 'history-toggle', width, preserved: true });
    await click('운영 설정'); await waitFor("document.querySelector('.settings-nav')");
    await click('팀과 역할'); await waitFor("[...document.querySelectorAll('.role-row')].some(e=>e.textContent.includes('사운드'))");
    await capture('settings-roles', width, '.role-row:last-child', '담당 유형: 에셋, 조사');
    const roleAudit = await evaluate(`(async()=>{
      const roles=window.__data.roles;
      const reads=()=>window.__calls.filter(c=>c.method==='roles.list').length;
      const before=reads();
      roles.push({...roles.at(-1),id:'live-role',name:'음원 검수 담당'});
      await window.__fake.invoke('settings.update',{});
      return {before};
    })()`);
    await waitFor("[...document.querySelectorAll('.role-row strong')].some(e=>e.textContent==='음원 검수 담당')");
    await evaluate("window.__data.roles.at(-1).name='소리 담당';window.__fake.invoke('settings.update',{})");
    await waitFor("[...document.querySelectorAll('.role-row strong')].some(e=>e.textContent==='소리 담당')");
    await evaluate("window.__data.roles.pop();window.__fake.invoke('settings.update',{})");
    await waitFor("![...document.querySelectorAll('.role-row strong')].some(e=>e.textContent==='소리 담당')");
    const roleResult = await evaluate(`({reads:window.__calls.filter(c=>c.method==='roles.list').length,edits:document.querySelectorAll('.role-row input,.role-row button,.role-row textarea,.role-row select').length,tag:document.querySelector('.role-row:last-child .role-creator').textContent})`);
    if (roleResult.reads !== roleAudit.before + 3 || roleResult.edits || roleResult.tag !== '메인 에이전트') throw new Error(`Live roles: ${JSON.stringify(roleResult)}`);
    audits.push({ check: 'snapshot-topic-role-create-update-delete', width, ...roleAudit, ...roleResult });
    await openTask('T-0013');
    await capture('task-merge', width, '.hold-reason', '메인 에이전트가 처리 중');
    await evaluate("document.querySelector('.hold-history').open=true");
    await capture('task-merge-history', width, '.hold-reason', '명령창으로 메인 에이전트에게 알려 주세요');
    await closeModal(); await openTask('T-0014');
    await capture('task-recovery', width, '.hold-reason', '메인 에이전트가 처리 중');
    await closeModal(); await openTask('T-0009');
    await capture('task-dropped', width, '.hold-reason', '명령창으로 메인 에이전트에게 알려 주세요');
    await closeModal(); await openTask('T-0008');
    await capture('task-legacy', width, '.hold-reason', '다시 판정을 받을지');
    await closeModal();
    await capture('settings-policy', width, '.settings-content>section:last-child', '홈에서 복구 항목의 전달 상태를 확인하세요.');
    // Open the project and task through their real screen controls.
    await click('프로젝트');
    await waitFor("document.querySelector('.project-card')");
    await evaluate("[...document.querySelectorAll('.project-card')].find(e=>e.textContent.includes('사내 위키')).click()");
    await waitFor("document.querySelector('.activity-compact')");
    if (!await evaluate("document.querySelector('.activity-compact').innerText.includes('메인 에이전트')")) throw new Error('Main activity name missing');
    await capture('studio-main', width, '.activity-compact .activity-row:first-child', '메인 에이전트');
    await evaluate("[...document.querySelectorAll('.task-row strong')].find(e=>e.textContent==='위키 안내 음원 만들기').closest('button').click()");
    await waitFor("document.querySelector('.modal .detail-intro')");
    await capture('asset-type', width, '.detail-intro', '에셋');
    await capture('asset-output', width, '.modal-body>section:last-child', 'wiki-guide.wav');
    await closeModal();
  }
  if (runtimeErrors.length || consoleErrors.length) throw new Error(`Browser errors: ${JSON.stringify({ runtimeErrors, consoleErrors })}`);
  writeFileSync(resolve(output, 'browser-audit.json'), JSON.stringify({ audits, runtimeErrors, consoleErrors }, null, 2) + '\n');
} finally {
  if (socket?.readyState === 1) { try { await send('Browser.close'); } catch {} socket.close(); }
  if (browser && browser.exitCode === null) await Promise.race([new Promise(done => browser.once('exit', done)), pause(3000)]);
  if (browser && browser.exitCode === null) browser.kill();
  await server?.close(); await pause(300);
  if (!temp.startsWith(tempRoot + sep) || !temp.includes('wook-stage5-overview-')) throw new Error('Unexpected temp directory');
  rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  console.log('Own 5196 server and Chrome stopped; system temp removed.');
}
