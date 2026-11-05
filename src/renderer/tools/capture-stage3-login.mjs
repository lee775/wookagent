import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';

const renderer = resolve('src/renderer'), output = resolve('docs/design/permission-ui/stage3-login');
const profile = resolve(renderer, `.stage3-browser-profile-${Date.now()}`), temp = resolve(renderer, '.stage3-test-temp');
if (!profile.startsWith(renderer + sep) || existsSync(profile)) throw new Error('Expected an unused renderer-local profile');
mkdirSync(output, { recursive: true }); mkdirSync(temp, { recursive: true });
const browser = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
  '--headless=new', '--disable-gpu', '--disable-gpu-sandbox', '--no-sandbox', '--in-process-gpu',
  '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, TMP: temp, TEMP: temp } });
let errors = '', socket, sequence = 0, acceptDialog = false;
const pending = new Map(), audits = [], dialogs = [], runtimeErrors = [];
browser.stderr.on('data', chunk => { errors += chunk; });
const pause = ms => new Promise(done => setTimeout(done, ms));
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
  for (let i = 0; i < 200; i++) { if (await evaluate(`Boolean(${expression})`)) return; await pause(100); }
  throw new Error(`Timed out: ${expression}`);
}
const clickText = text => evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)})?.click()`);
async function navigate(query) {
  await send('Page.navigate', { url: `http://127.0.0.1:5196/?studio3d=0&${query}` });
  await waitFor("document.querySelector('.server-login-card')");
}
async function capture(name, width, selector) {
  await evaluate('document.fonts.ready'); await pause(180);
  const audit = await evaluate(`(() => {
    const scope = document.querySelector(${JSON.stringify(selector)});
    const visible = e => {const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&r.bottom>0&&r.top<innerHeight;};
    const overflowing = [...scope.querySelectorAll('button,h1,h2,p,strong,label,a,dd')].filter(visible).filter(e=>e.scrollWidth>e.clientWidth+2).map(e=>e.textContent.trim());
    const outOfBounds = [...scope.querySelectorAll('button,input,a,.device-user-code')].filter(visible).filter(e=>{const r=e.getBoundingClientRect();return r.left<0||r.right>innerWidth;}).map(e=>e.textContent.trim());
    const controls = [...scope.querySelectorAll('button,input,a')].filter(visible).map(e=>({text:e.textContent.trim()||e.id,height:e.getBoundingClientRect().height}));
    return {width:innerWidth,height:innerHeight,deviceScaleFactor:devicePixelRatio,documentWidth:document.documentElement.scrollWidth,overflowing,outOfBounds,controls,
      code:scope.querySelector('.device-user-code')?.textContent,codeFontSize:scope.querySelector('.device-user-code')?parseFloat(getComputedStyle(scope.querySelector('.device-user-code')).fontSize):null,
      text:scope.textContent,currentDevices:scope.querySelectorAll('.current-device').length};
  })()`);
  if (audit.documentWidth > width || audit.overflowing.length || audit.outOfBounds.length || audit.controls.some(c=>c.height<44)) throw new Error(`Layout ${name}: ${JSON.stringify(audit)}`);
  if (audit.codeFontSize && audit.codeFontSize < 30) throw new Error('Phone code is too small');
  const png = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(resolve(output, `${name}-${width}.png`), Buffer.from(png.data, 'base64'));
  audits.push({ name, ...audit }); console.log(`${name} ${width}: controls >=44px, no overflow`);
}
try {
  const portFile = resolve(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !existsSync(portFile); i++) await pause(100);
  if (!existsSync(portFile)) throw new Error(`Chrome failed: ${errors.slice(-1000)}`);
  const port = Number(readFileSync(portFile, 'utf8').split('\n')[0]);
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(pages.find(page => page.type === 'page').webSocketDebuggerUrl);
  await new Promise((done, reject) => { socket.onopen = done; socket.onerror = reject; });
  socket.onmessage = event => {
    const response = JSON.parse(event.data), listener = pending.get(response.id);
    if (listener) { pending.delete(response.id); response.error ? listener.reject(new Error(JSON.stringify(response.error))) : listener.resolve(response.result); }
    if (response.method === 'Runtime.exceptionThrown') runtimeErrors.push(response.params.exceptionDetails);
    if (response.method === 'Page.javascriptDialogOpening') {
      dialogs.push({ message: response.params.message, accepted: acceptDialog });
      void send('Page.handleJavaScriptDialog', { accept: acceptDialog });
    }
  };
  await send('Page.enable'); await send('Runtime.enable');
  for (const width of [1440, 390]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: width === 1440 ? 1000 : 844, deviceScaleFactor: 1, mobile: false });
    await send('Network.setUserAgentOverride', { userAgent: width === 390 ? 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36' : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36' });
    await navigate('fakeMode=server&fakeLogin=pending'); await clickText('Google 계정으로 로그인'); await waitFor("document.querySelector('.device-user-code')");
    await capture('device-code', width, '.server-login-card');
    // Exercise the real clipboard gesture using CDP input, then read the copied value.
    const rect = await evaluate("(()=>{const r=document.querySelector('.device-code-box button').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()");
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...rect, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...rect, button: 'left', clickCount: 1 });
    await waitFor("document.querySelector('.copy-status')");
    const copyStatus = await evaluate("document.querySelector('.copy-status').textContent");
    if (!copyStatus.includes('코드를 복사했습니다')) throw new Error(`Clipboard failed: ${copyStatus}`);
    audits.push({ check: 'copy', width, copyStatus });

    await navigate('fakeMode=server&fakeSetup=1');
    await evaluate(`(() => {const set=(id,value)=>{const e=document.getElementById(id);Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,value);e.dispatchEvent(new Event('input',{bubbles:true}));};set('owner-setup-code','BCDX2345');set('owner-setup-email','owner@example.com');})()`);
    await waitFor("!document.querySelector('.owner-setup-form button').disabled");
    await capture('setup', width, '.server-login-card');
    await evaluate("document.querySelector('.owner-setup-form button').click()");
    await waitFor("document.querySelector('.server-login-start')");
    if (await evaluate("Boolean(document.querySelector('.owner-setup-form'))")) throw new Error('Setup did not exit');
    audits.push({ check: 'setup-success', width, transitionedToLogin: true });

    await navigate('fakeMode=server&fakeLogin=denied'); await clickText('Google 계정으로 로그인');
    await waitFor("document.querySelector('.server-login-error')"); await capture('denied', width, '.server-login-card');
    await clickText('다시 시작'); await waitFor("document.querySelector('.device-user-code')?.textContent==='BCDX-FGHJ'");
    audits.push({ check: 'denied-restart', width, newCode: 'BCDX-FGHJ' });

    await navigate('fakeMode=server'); await clickText('Google 계정으로 로그인'); await waitFor("document.querySelector('.app-shell')");
    await evaluate("document.querySelector('[aria-label=\"알림함\"]').click()");
    await waitFor("[...document.querySelectorAll('.notification-item strong')].some(e=>e.textContent==='새 기기가 로그인했습니다')");
    const notice = await evaluate(`(() => {const e=[...document.querySelectorAll('.notification-item')].find(e=>e.querySelector('strong')?.textContent==='새 기기가 로그인했습니다');const result={text:e.textContent,buttons:[...e.querySelectorAll('button')].map(b=>b.textContent)};e.querySelector('button').click();return result;})()`);
    if (notice.buttons.includes('메인 에이전트에게 말하기')) throw new Error('Device notice opened a command');
    await waitFor("document.querySelector('.device-session .current-device')");
    // Fold conversation history so the settings can use their normal viewing space.
    await evaluate("document.querySelector('[aria-label=\"대화 기록 접기\"]')?.click()");
    const devicePosition = await evaluate("(()=>{const r=document.getElementById('logged-in-devices').getBoundingClientRect(),m=document.querySelector('.main-content').getBoundingClientRect();return {top:r.top,contentTop:m.top,focused:document.activeElement.id==='logged-in-devices'};})()");
    if (!devicePosition.focused || devicePosition.top < devicePosition.contentTop || devicePosition.top > devicePosition.contentTop + 40) throw new Error(`Notice did not open device list: ${JSON.stringify(devicePosition)}`);
    await pause(200); await capture('devices', width, '#logged-in-devices');
    audits.push({ check: 'new-device-notice', width, ...notice, target: 'settings/account', devicePosition, command: await evaluate("document.querySelector('[aria-label=\"명령 입력\"]').value") });
    acceptDialog = false;
    await evaluate("document.querySelector('.device-session:not(:has(.current-device)) .device-revoke').click()");
    if (await evaluate("document.querySelectorAll('.device-session').length") !== 2) throw new Error('Cancelled revocation removed a device');
    acceptDialog = true;
    await evaluate("document.querySelector('.device-session:has(.current-device) .device-revoke').click()");
    await waitFor("document.querySelector('.server-login-start')");
    await clickText('Google 계정으로 로그인'); await waitFor("document.querySelector('.app-shell')");
    audits.push({ check: 'current-device-revoke-and-relogin', width, loggedOutAndBackIn: true });
  }
  // The default fake still offers the original desktop login.
  await send('Page.navigate', { url: 'http://127.0.0.1:5196/?studio3d=0' });
  await waitFor("document.querySelector('.login-dev')");
  if (await evaluate("Boolean(document.querySelector('.server-login-card'))")) throw new Error('Default fake changed to server');
  audits.push({ check: 'default-desktop', originalLoginVisible: true });
  if (runtimeErrors.length) throw new Error(`Browser errors: ${JSON.stringify(runtimeErrors)}`);
  writeFileSync(resolve(output, 'layout-audit.json'), JSON.stringify({ audits, dialogs, runtimeErrors }, null, 2) + '\n');
} finally {
  if (socket?.readyState === 1) { try { await send('Browser.close'); } catch { /* Owned browser may close before replying. */ } socket.close(); }
  if (browser.exitCode === null) await Promise.race([new Promise(done => browser.once('exit', done)), pause(3000)]);
  if (browser.exitCode === null) browser.kill();
  await pause(300);
  if (!profile.startsWith(renderer + sep)) throw new Error('Profile escaped renderer');
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
