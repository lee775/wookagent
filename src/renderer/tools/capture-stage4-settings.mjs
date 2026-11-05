import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, sep } from 'node:path';
import { createServer } from 'vite';

const tempRoot = resolve(tmpdir()), temp = mkdtempSync(resolve(tempRoot, 'wook-stage4-settings-'));
const output = resolve('docs/design/permission-ui/stage4-seat');
const switchingOnly = process.argv.includes('--switching-only');
const originalPngs = new Map((await import('node:fs')).readdirSync(output).filter(name => name.endsWith('.png')).map(name => [name, readFileSync(resolve(output, name))]));
const changed = new Set(), audits = [], runtimeErrors = [];
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
    try { if (await evaluate(`Boolean(${expression})`)) return; } catch { /* Navigation replaces the context. */ }
    await pause(100);
  }
  throw new Error(`Timed out: ${expression}; page=${await evaluate('document.body.innerText')}`);
}
const click = text => evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)})?.click()`);
const viewport = (width, height = width === 1440 ? 1100 : 1550) => send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
async function navigate(query) {
  await send('Page.navigate', { url: `http://127.0.0.1:5196/?studio3d=0&${query}` });
  await waitFor("document.querySelector('.login-dev')");
  await evaluate("document.querySelector('.login-dev').click()");
  await waitFor("document.querySelector('.seat-chip')");
}
async function capture(name, width, selector, expected) {
  await evaluate('document.fonts.ready'); await pause(150);
  const audit = await evaluate(`(() => {
    const target=document.querySelector(${JSON.stringify(selector)}), r=target.getBoundingClientRect();
    const controls=[...target.querySelectorAll('button')].map(e=>({text:e.textContent.trim(),height:e.getBoundingClientRect().height}));
    return {width:innerWidth,height:innerHeight,scale:devicePixelRatio,documentWidth:document.documentElement.scrollWidth,text:target.textContent,top:r.top,bottom:r.bottom,controls,overflow:target.scrollWidth>target.clientWidth+1};
  })()`);
  if (!audit.text.includes(expected) || audit.documentWidth > width || audit.overflow || audit.controls.some(item => item.height < 44) || audit.top < 0 || audit.bottom > audit.height) throw new Error(`Layout/text: ${JSON.stringify(audit)}`);
  const png = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const filename = `${name}-${width}.png`;
  writeFileSync(resolve(output, filename), Buffer.from(png.data, 'base64')); changed.add(filename);
  audits.push({ filename, ...audit }); console.log(`${filename}: text verified; no overflow`);
}
async function attachBridge() {
  await evaluate(`(async()=>{
    window.__data=await import('/src/api/fake/data.ts');
    window.__fake=(await import('/src/api/fake/index.ts')).fakeBridge;
    window.__calls=[];
    window.wook={...window.__fake,platform:'win32',invoke:async(method,...args)=>{window.__calls.push({method,args});return window.__fake.invoke(method,...args);}};
  })()`);
}
async function captureSwitching() {
  for (const width of [1440, 390]) {
    await viewport(width, width === 390 ? 844 : 1100);
    for (const mode of ['desktop', 'server']) {
      await navigate('fakeSeat=switching'); await attachBridge();
      await evaluate(`(() => {
        const snapshot=window.__data.snapshot;
        snapshot.auth.mode=${JSON.stringify(mode)};
        snapshot.seat.unresponsiveSince=new Date(Date.now()-240000).toISOString();
        snapshot.seat.unresponsiveReason='메인 자리 인계를 기다리고 있습니다.';
        snapshot.stop.global.active=false; snapshot.stop.pausedMembers=[];
        return window.__fake.invoke('settings.update',{});
      })()`);
      await waitFor("document.querySelector('.seat-unresponsive')?.textContent.includes('메인 자리를 Codex CLI에게 넘기고 있습니다.')");
      await capture(`unresponsive-switching-${mode}`, width, '.seat-unresponsive', '메인 자리를 Codex CLI에게 넘기고 있습니다.');
      const text = await evaluate("document.querySelector('.seat-unresponsive').textContent");
      if (/운영 설정|서버 PC의 운영자|정지 해제/.test(text)) throw new Error(`Unavailable switching exit: ${text}`);
      await evaluate(`(() => {
        const snapshot=window.__data.snapshot;
        snapshot.stop.pausedMembers=[{memberId:'M-MAIN',by:'system',mode:'graceful',since:snapshot.generatedAt,reason:'교체를 마치기 전에 종료 확인이 필요합니다.'}];
        return window.__fake.invoke('settings.update',{});
      })()`);
      await waitFor("document.querySelector('.seat-unresponsive')?.textContent.includes('정지 해제') && document.querySelector('.main-pause-notice')");
      await capture(`unresponsive-held-switching-${mode}`, width, '.seat-unresponsive', '교체가 보류되어 있습니다. 메인 에이전트 정지 안내에서 정지 해제를 눌러 주세요.');
      const held = await evaluate(`({
        banner:document.querySelector('.seat-unresponsive').textContent,
        buttons:[...document.querySelectorAll('.seat-unresponsive button')].map(e=>e.textContent),
        pause:document.querySelector('.main-pause-notice').textContent
      })`);
      if (/운영 설정|서버 PC의 운영자/.test(held.banner) || held.buttons.join(',') !== '명령하기,긴급 정지' || !held.pause.includes('정지 해제')) throw new Error(`Held exit regression: ${JSON.stringify(held)}`);
      await evaluate("[...document.querySelectorAll('.main-pause-notice button')].find(e=>e.textContent==='정지 해제').click()");
      await waitFor("!document.querySelector('.main-pause-notice') && !document.querySelector('.seat-unresponsive').textContent.includes('정지 해제')");
      const calls = await evaluate("window.__calls.filter(c=>c.method==='stop.release').length");
      if (calls !== 1) throw new Error(`Release count: ${calls}`);
      audits.push({ check: 'existing-release-path', width, mode, held, calls });
    }
  }
  await navigate('capture=followup3-fake'); await attachBridge();
  const parity = await evaluate(`(async () => {
    const current=structuredClone(window.__data.settings.general.mainAgent);
    const stale={...current,model:'stale-model'};
    let refusal;
    try { await window.__fake.invoke('settings.update',{general:{mainAgent:stale},logs:{retentionDays:47}},{mainAgent:stale}); }
    catch(error) { refusal={code:error.code,message:error.message}; }
    const before=await window.__fake.invoke('settings.get');
    const saved=await window.__fake.invoke('settings.update',{logs:{retentionDays:47}},{mainAgent:stale});
    return {refusal,unchangedMain:JSON.stringify(saved.general.mainAgent)===JSON.stringify(current),retention:saved.logs.retentionDays,beforeRetention:before.logs.retentionDays};
  })()`);
  const expected = '메인 AI가 그사이 Claude CLI(CLI 기본 모델, 노력치 high)로 바뀌었습니다. 아무것도 저장하지 않았습니다 — 바뀐 메인 AI를 확인한 뒤 다시 바꾸세요';
  if (parity.refusal?.code !== 'conflict' || parity.refusal.message !== expected || !parity.unchangedMain || parity.retention !== 47 || parity.beforeRetention === 47) throw new Error(`Fake parity: ${JSON.stringify(parity)}`);
  audits.push({ check: 'fake-refusal-and-installation-patch', ...parity });
}
try {
  server = await createServer({ configFile: resolve('vite.web.config.ts'), configLoader: 'runner', cacheDir: resolve(temp, 'vite'), server: { host: '127.0.0.1', port: 5196, strictPort: true } });
  await server.listen();
  browser = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', '--disable-gpu', '--disable-gpu-sandbox', '--no-sandbox', '--in-process-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${resolve(temp, 'chrome')}`, 'about:blank'], {
    windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, TMP: temp, TEMP: temp },
  });
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
    if (response.method === 'Page.javascriptDialogOpening') void send('Page.handleJavaScriptDialog', { accept: true });
  };
  await send('Page.enable'); await send('Runtime.enable');
  if (switchingOnly) {
    await captureSwitching();
  } else {
  for (const width of [1440, 390]) {
    await viewport(width); await navigate('fakeSeat=unresponsive');
    const desktopCopy = '자리를 바꾸는 것은 메인 에이전트, 또는 이 PC의 운영자가 운영 설정의 메인 AI로 할 수 있습니다';
    await capture('unresponsive-counting', width, '.seat-unresponsive', desktopCopy);
    if (width === 390) { await viewport(width, 844); await capture('unresponsive-phone', width, '.seat-unresponsive', desktopCopy); await viewport(width); }
    await evaluate("document.querySelectorAll('.seat-unresponsive button')[1].click()");
    await waitFor("document.querySelector('.emergency-result')"); await click('확인'); await waitFor("!document.querySelector('.modal')");
    await capture('unresponsive-stopped', width, '.seat-unresponsive', desktopCopy);
    if (width === 390) { await viewport(width, 844); await capture('unresponsive-stopped-phone', width, '.seat-unresponsive', desktopCopy); await viewport(width); }
    await navigate('capture=main-paused'); await attachBridge();
    await evaluate("window.__data.snapshot.auth.mode='server';window.__fake.invoke('settings.update',{logs:{retentionDays:90}})");
    await waitFor("document.querySelector('.main-pause-notice')?.textContent.includes('운영자에게 확인을 부탁')");
    await capture('server-main-paused', width, '.main-pause-notice', '서버 PC에 남은 프로세스가 없는지 운영자에게 확인을 부탁한 뒤 정지를 해제해 주세요.');
  }
  // Exercise real React input events and the fake bridge, without saving extra settings screenshots.
  await viewport(1440); await navigate('capture=settings'); await attachBridge(); await click('설치 설정');
  await waitFor("document.querySelector('.settings-content input[type=number]')");
  await evaluate(`(()=>{const input=document.querySelector('.settings-content input[type=number]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'47');input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await evaluate(`window.__data.settings.general.mainAgent={kind:'codex',model:'gpt-6-sol',effortTier:'low',effortOverride:null};window.__data.snapshot.seat.generation++;window.__fake.invoke('settings.update',{logs:{retentionDays:90}})`);
  await waitFor("[...document.querySelectorAll('.settings-content section')].some(s=>s.querySelector('h2')?.textContent==='메인 에이전트 AI'&&s.querySelector('input')?.value==='gpt-6-sol')");
  const retention = await evaluate("document.querySelector('.settings-content input[type=number]').value");
  if (retention !== '47') throw new Error(`Unsaved retention lost: ${retention}`);
  await click('설치 설정 저장'); await waitFor("document.body.textContent.includes('설치 설정을 저장했습니다.')");
  const installationCall = await evaluate("window.__calls.filter(c=>c.method==='settings.update').at(-1)");
  if (installationCall.args[0].general.mainAgent || installationCall.args[0].logs.retentionDays !== 47) throw new Error('Installation patch regression');
  await evaluate(`(()=>{const section=[...document.querySelectorAll('.settings-content section')].find(s=>s.querySelector('h2')?.textContent==='메인 에이전트 AI');window.__form=section;const input=section.querySelector('input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'changed-model');input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  // Simulate the main changing the saved model before the seat snapshot reaches this screen.
  await evaluate("window.__data.settings.general.mainAgent.model='main-changed-first';window.__form.querySelector('button').click()");
  await waitFor("document.querySelector('.toast')?.textContent.includes('메인 AI가 그사이')");
  const conflict = await evaluate("({call:window.__calls.filter(c=>c.method==='settings.update').at(-1),text:document.querySelector('.toast').textContent,savedModel:window.__data.settings.general.mainAgent.model,calls:window.__calls.filter(c=>c.method==='settings.update').length})");
  await pause(250);
  if (conflict.call.args[1].mainAgent.model !== 'gpt-6-sol' || conflict.savedModel !== 'main-changed-first' || await evaluate("window.__calls.filter(c=>c.method==='settings.update').length") !== conflict.calls) throw new Error(`Conflict regression: ${JSON.stringify(conflict)}`);
  audits.push({ check: 'real-settings-refresh-and-conflict', retention, installationCall, conflict });
  }
  if (runtimeErrors.length) throw new Error(`Runtime errors: ${JSON.stringify(runtimeErrors)}`);
  const unchangedPngs = [...originalPngs].filter(([name]) => !changed.has(name));
  if (unchangedPngs.some(([name, bytes]) => !bytes.equals(readFileSync(resolve(output, name))))) throw new Error('An unrelated screenshot changed');
  writeFileSync(resolve(output, switchingOnly ? 'followup3-browser-audit.json' : 'followup2-browser-audit.json'), JSON.stringify({ audits, runtimeErrors, unchangedExistingPngs: unchangedPngs.length }, null, 2) + '\n');
} finally {
  if (socket?.readyState === 1) { try { await send('Browser.close'); } catch {} socket.close(); }
  if (browser && browser.exitCode === null) await Promise.race([new Promise(done => browser.once('exit', done)), pause(3000)]);
  if (browser && browser.exitCode === null) browser.kill();
  await server?.close();
  await pause(300);
  if (!temp.startsWith(tempRoot + sep) || !temp.includes('wook-stage4-settings-')) throw new Error('Unexpected temp directory');
  rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  console.log('Own 5196 server and Chrome stopped; system temp removed.');
}
