import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';

const renderer = resolve('src/renderer');
const profile = resolve(renderer, '.followups3-browser-profile');
if (!profile.startsWith(renderer + sep) || existsSync(profile)) throw new Error('Expected an unused renderer-local browser profile');
const output = resolve('docs/design/permission-ui/followups3');
mkdirSync(output, { recursive: true });
const browser = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
  '--headless=new', '--disable-gpu', '--disable-gpu-sandbox', '--no-sandbox', '--in-process-gpu',
  '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, TMP: resolve(renderer, '.followups3-test-temp'), TEMP: resolve(renderer, '.followups3-test-temp') } });
let errors = '';
browser.stderr.on('data', chunk => { errors += chunk; });
const pause = ms => new Promise(done => setTimeout(done, ms));
let socket;
let sequence = 0;
const pending = new Map();
function send(method, params = {}) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timed out: ${method}`)); }, 10000);
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
  for (let i = 0; i < 100; i++) {
    if (await evaluate(`Boolean(${expression})`)) return;
    await pause(100);
  }
  throw new Error(`Timed out: ${expression}`);
}
const audits = [];
try {
  const portFile = resolve(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !existsSync(portFile); i++) await pause(100);
  if (!existsSync(portFile)) throw new Error(`Chrome did not start: ${errors.slice(-1000)}`);
  const port = Number(readFileSync(portFile, 'utf8').split('\n')[0]);
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(pages.find(page => page.type === 'page').webSocketDebuggerUrl);
  await new Promise((done, reject) => { socket.onopen = done; socket.onerror = reject; });
  socket.onmessage = event => {
    const response = JSON.parse(event.data); const listener = pending.get(response.id);
    if (listener) { pending.delete(response.id); response.error ? listener.reject(new Error(JSON.stringify(response.error))) : listener.resolve(response.result); }
  };
  await send('Page.enable'); await send('Runtime.enable');
  for (const width of [1440, 390]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: width === 1440 ? 1000 : 844, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: 'http://127.0.0.1:5196/?capture=home&studio3d=0' });
    await waitFor("document.querySelector('.login-dev')");
    await evaluate(`(async () => {
      const dataUrl = performance.getEntriesByType('resource').findLast(entry => new URL(entry.name).pathname === '/src/api/fake/data.ts')?.name;
      if (!dataUrl) throw new Error('The loaded fake data module is missing');
      const data = await import(dataUrl);
      // Use both emergency examples from the actual fake bridge, including the older-server fallback.
      data.snapshot.ownerTodos = data.snapshot.ownerTodos.filter(todo => todo.kind === 'emergency_held');
      if (data.snapshot.ownerTodos.length !== 2 || data.snapshot.ownerTodos[0].reachesMain !== false || 'reachesMain' in data.snapshot.ownerTodos[1]) throw new Error('Fake emergency examples changed');
      data.snapshot.ai.forEach(ai => { ai.authRequired=false; ai.blocked=false; ai.problem=null; ai.usageLimitedUntil=null; ai.modelLimits=[]; });
      data.notifications.splice(0); data.snapshot.notifications = { unread:0, urgentUnread:0 };
      document.querySelector('.login-dev').click();
    })()`);
    await waitFor("document.querySelectorAll('.todo').length === 2");
    await evaluate(`document.querySelector('.todo button:last-child').click()`);
    await waitFor(`document.querySelector('[aria-label="명령 입력"]').value === '긴급 정지로 보류된 작업에 대해: '`);
    // Keep the verified draft visible while giving Home its normal viewing area.
    await evaluate(`document.querySelector('[aria-label="대화 기록 접기"]').click()`);
    await waitFor("!document.querySelector('.conversation')");
    await evaluate("document.querySelector('.todo-list').closest('.section').scrollIntoView({block:'start'})");
    await evaluate('document.fonts.ready'); await pause(200);
    const audit = await evaluate(`(() => {
      const rows = [...document.querySelectorAll('.todo')];
      const visible = e => { const r=e.getBoundingClientRect(); return r.width>0 && r.height>0 && r.top<innerHeight && r.bottom>0; };
      const overflow = [...document.querySelectorAll('button,h1,h2,strong,p')].filter(visible).filter(e => e.clientWidth>0 && e.scrollWidth>e.clientWidth+2).map(e => e.textContent.trim());
      const outOfBounds = [...document.querySelectorAll('.todo button,.todo p,.todo strong')].filter(e => { const r=e.getBoundingClientRect(); return r.left<0 || r.right>innerWidth; }).map(e => e.textContent.trim());
      const content = document.querySelector('.main-content').getBoundingClientRect();
      const commandTop = document.querySelector('.command-bar').getBoundingClientRect().top;
      const rowsVisible = rows.every(e => {const r=e.getBoundingClientRect(); return r.top>=content.top && r.bottom<=Math.min(content.bottom,commandTop);});
      return {width:innerWidth,height:innerHeight,deviceScaleFactor:devicePixelRatio,documentWidth:document.documentElement.scrollWidth,overflow,outOfBounds,rowsVisible,
        undeliveredLabel:rows[0].querySelector('strong').textContent,undeliveredHint:rows[0].querySelector('.muted')?.textContent,
        undeliveredText:rows[0].textContent,legacyText:rows[1].textContent,buttons:rows.flatMap(e=>[...e.querySelectorAll('button')].map(b=>b.textContent.trim())),
        draft:{target:document.querySelector('[aria-label="명령 대상"]').value,targetLabel:document.querySelector('[aria-label="명령 대상"] option:checked').textContent,text:document.querySelector('[aria-label="명령 입력"]').value}};
    })()`);
    if (audit.documentWidth > width || audit.overflow.length || audit.outOfBounds.length || !audit.rowsVisible) throw new Error(`Layout failed: ${JSON.stringify(audit)}`);
    if (audit.undeliveredLabel !== '보류된 작업 2건' || audit.undeliveredHint !== '이 보류 목록은 메인 에이전트에게 전해지지 않았습니다. 필요한 조치는 명령창으로 메인 에이전트에게 알려 주세요.') throw new Error('Undelivered emergency copy changed');
    if (audit.undeliveredText.includes('확인해 항목별로 재개') || !audit.legacyText.includes('1건의 보류 작업은 메인 에이전트가 확인해 항목별로 재개합니다.')) throw new Error('Emergency fallback changed');
    if (audit.draft.target !== 'main' || audit.draft.targetLabel !== '메인 에이전트 직접' || audit.draft.text !== '긴급 정지로 보류된 작업에 대해: ') throw new Error('Wrong direct-main draft');
    if (audit.buttons.some(text => /^(재개|재시도|다시 시도|작업 취소)$/.test(text))) throw new Error('Unexpected owner operation');
    const png = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(resolve(output, `home-emergency-held-${width}.png`), Buffer.from(png.data, 'base64'));
    audits.push(audit);
    console.log(`Home ${width}: both rows visible, no overflow, direct-main draft verified`);
  }
  writeFileSync(resolve(output, 'layout-audit.json'), JSON.stringify(audits, null, 2) + '\n');
} finally {
  if (socket?.readyState === 1) { try { await send('Browser.close'); } catch { /* The owned browser may close before replying. */ } socket.close(); }
  if (browser.exitCode === null) await Promise.race([new Promise(done => browser.once('exit', done)), pause(3000)]);
  if (browser.exitCode === null) browser.kill();
  await pause(300);
  // This unused, exact path was checked before starting the script-owned browser.
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
