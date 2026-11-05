import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';

const renderer = resolve('src/renderer'), output = resolve('docs/design/permission-ui/stage4-seat');
const modelsOnly = process.argv.includes('--models-only');
const profile = resolve(renderer, `.stage4-browser-profile-${Date.now()}`), temp = resolve(renderer, '.stage4-test-temp');
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
  throw new Error(`Timed out: ${expression}; body=${await evaluate('document.body.innerText')}; errors=${JSON.stringify(runtimeErrors)}`);
}
const clickText = text => evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)})?.click()`);

async function navigate(query = '') {
  await send('Page.navigate', { url: `http://127.0.0.1:5196/?studio3d=0&${query}` });
  await waitFor("document.querySelector('.login-dev')");
  if (await evaluate("Boolean(document.querySelector('.seat-chip,.seat-unresponsive'))")) throw new Error('Seat leaked before login');
  await evaluate("document.querySelector('.login-dev').click()");
  await waitFor("document.querySelector('.seat-chip')");
}
async function capture(name, width) {
  await evaluate('document.fonts.ready'); await pause(150);
  const audit = await evaluate(`(() => {
    const visible = e => { const r=e.getBoundingClientRect(); return r.width>0&&r.height>0&&r.bottom>0&&r.top<innerHeight; };
    const scope=document.querySelector('.seat-screen') || document.querySelector('.main-content');
    const nodes=[...document.querySelectorAll('.topbar button,.status-stack button'), ...scope.querySelectorAll('button,a,select')].filter(visible);
    const overflowing=[...document.querySelectorAll('.topbar strong,.seat-chip-compact,.status-stack p,.seat-screen p,.seat-screen h2,.seat-screen h3,.seat-screen dd')].filter(visible).filter(e=>e.scrollWidth>e.clientWidth+2).map(e=>e.textContent.trim());
    const bounds=nodes.filter(e=>{const r=e.getBoundingClientRect(); return r.left<0||r.right>innerWidth;}).map(e=>e.textContent.trim());
    const controls=nodes.map(e=>({text:e.textContent.trim()||e.getAttribute('aria-label'),height:e.getBoundingClientRect().height}));
    const bar=document.querySelector('.topbar').getBoundingClientRect();
    const visibleModels=[...document.querySelectorAll('.seat-chip small,.seat-screen p.muted')].filter(visible).map(e=>e.textContent.trim()).filter(text=>/^(opus|gpt-6-sol)$/.test(text));
    return {width:innerWidth,height:innerHeight,scale:devicePixelRatio,documentWidth:document.documentElement.scrollWidth,contentWidth:scope.scrollWidth,contentClientWidth:scope.clientWidth,overflowing,bounds,controls,barHeight:bar.height,chip:document.querySelector('.seat-chip').textContent,body:scope.textContent,visibleModels};
  })()`);
  if(modelsOnly && !audit.visibleModels.length) { console.log(`${name} ${width}: skipped (no visible model)`); return; }
  if (audit.documentWidth > width || audit.contentWidth > audit.contentClientWidth+1 || audit.overflowing.length || audit.bounds.length || audit.controls.some(c=>c.height<44) || audit.barHeight > 66) throw new Error(`Layout ${name}: ${JSON.stringify(audit)}`);
  const png=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
  writeFileSync(resolve(output,`${name}-${width}.png`),Buffer.from(png.data,'base64'));
  audits.push({name,...audit}); console.log(`${name} ${width}: no overflow; controls >= 44px`);
}
try {
  const portFile=resolve(profile,'DevToolsActivePort');
  for(let i=0;i<100&&!existsSync(portFile);i++) await pause(100);
  if(!existsSync(portFile)) throw new Error(`Chrome failed: ${errors.slice(-1000)}`);
  const port=Number(readFileSync(portFile,'utf8').split('\n')[0]);
  const pages=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket=new WebSocket(pages.find(page=>page.type==='page').webSocketDebuggerUrl);
  await new Promise((done,reject)=>{socket.onopen=done;socket.onerror=reject;});
  socket.onmessage=event=>{
    const response=JSON.parse(event.data),listener=pending.get(response.id);
    if(listener){pending.delete(response.id);response.error?listener.reject(new Error(JSON.stringify(response.error))):listener.resolve(response.result);}
    if(response.method==='Runtime.exceptionThrown')runtimeErrors.push(response.params.exceptionDetails);
    if(response.method==='Page.javascriptDialogOpening')void send('Page.handleJavaScriptDialog',{accept:true});
  };
  await send('Page.enable');await send('Runtime.enable');
  for(const width of [1440,390]) {
    await send('Emulation.setDeviceMetricsOverride',{width,height:width===1440?1100:1550,deviceScaleFactor:1,mobile:false});
    await navigate();await capture('topbar-active',width);
    await evaluate("document.querySelector('.seat-chip').click()");await waitFor("document.querySelector('.seat-history li')");
    await capture('seat-history',width);
    await evaluate("document.querySelector('.handover-link').click()");await waitFor("document.querySelector('.unverified-explanation')");
    await capture('handover',width);
    await evaluate("(()=>{const p=document.querySelector('.main-content'),m=document.querySelector('.unverified-section');p.scrollTop+=m.getBoundingClientRect().top-p.getBoundingClientRect().top-180;})()");
    await capture('handover-memos',width);
    await clickText('메인 일지');await waitFor("document.querySelector('.journal-entry')");
    await evaluate("document.querySelector('.main-content').scrollTop=0");
    await capture('journal-all',width);
    await evaluate("(()=>{const e=document.querySelector('[aria-label=\"일지 종류\"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(e,'promise');e.dispatchEvent(new Event('change',{bubbles:true}));})()");
    await waitFor("document.querySelectorAll('.journal-entry').length===4");await capture('journal-promises',width);
    await evaluate("document.querySelector('.journal-open input').click()");await waitFor("document.querySelectorAll('.journal-entry').length===3");await capture('journal-open',width);
    await navigate('fakeSeat=switching');await capture('topbar-switching',width);
    await navigate('fakeSeat=vacant');await capture('topbar-vacant',width);
    await navigate('fakeSeat=unresponsive');await capture('unresponsive-counting',width);
    await evaluate("document.querySelector('.seat-unresponsive button').click()");
    await waitFor("document.activeElement?.tagName==='TEXTAREA'");
    audits.push({check:'command-focus',width,target:await evaluate('document.activeElement.tagName')});
    await evaluate("document.querySelector('[aria-label=\"대화 기록 접기\"]')?.click()");
    await evaluate("document.querySelectorAll('.seat-unresponsive button')[1].click()");await waitFor("document.querySelector('.emergency-result')");
    await clickText('확인');await waitFor("!document.querySelector('.modal')");
    await capture('unresponsive-stopped',width);
    if(width===390){
      await send('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:1,mobile:false});
      await capture('unresponsive-stopped-phone',width);
      await send('Emulation.setDeviceMetricsOverride',{width,height:1550,deviceScaleFactor:1,mobile:false});
    }
    await evaluate("document.querySelector('.status-stack .emergency-banner button').click()");
    await waitFor("document.querySelector('.seat-unresponsive strong').textContent.includes('응답 없음')");
    const resumed=await evaluate("document.querySelector('.seat-unresponsive strong').textContent");
    if(!resumed.includes('4분'))throw new Error(`Stopped duration counted: ${resumed}`);
    audits.push({check:'stop-release-keeps-duration',width,resumed});
    await evaluate("document.querySelectorAll('.toast button').forEach(b=>b.click())");
    // Also audit a usual phone height, where the message stack has its own scroll limit.
    if(width===390){await send('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:1,mobile:false});await capture('unresponsive-phone',width);}
  }
  if(runtimeErrors.length)throw new Error(`Browser errors: ${JSON.stringify(runtimeErrors)}`);
  writeFileSync(resolve(output,modelsOnly?'followup-model-layout-audit.json':'layout-audit.json'),JSON.stringify({audits,runtimeErrors},null,2)+'\n');
} finally {
  if(socket?.readyState===1){try{await send('Browser.close');}catch{}socket.close();}
  if(browser.exitCode===null)await Promise.race([new Promise(done=>browser.once('exit',done)),pause(3000)]);
  if(browser.exitCode===null)browser.kill();
  await pause(300);
  if(!profile.startsWith(renderer+sep))throw new Error('Profile escaped renderer');
  rmSync(profile,{recursive:true,force:true,maxRetries:5,retryDelay:200});
}
