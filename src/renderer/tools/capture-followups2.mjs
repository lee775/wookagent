import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, sep } from 'node:path';

const workspace = resolve('.');
const profile = resolve('src/renderer/.followups2-browser-profile');
if (!profile.startsWith(workspace + sep) || !profile.endsWith('.followups2-browser-profile')) throw new Error('Unexpected browser profile path');
const output = resolve('docs/design/permission-ui/followups2');
mkdirSync(output, { recursive: true });
const browser = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
  '--headless=new', '--disable-gpu', '--disable-gpu-sandbox', '--no-sandbox', '--in-process-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=9338', `--user-data-dir=${profile}`, 'about:blank',
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
const interactions = [];
try {
  let pages;
  for (let i = 0; i < 100; i++) { try { pages = await (await fetch('http://127.0.0.1:9338/json/list')).json(); break; } catch { await pause(100); } }
  socket = new WebSocket(pages.find(page => page.type === 'page').webSocketDebuggerUrl);
  await new Promise((done, reject) => { socket.onopen = done; socket.onerror = reject; });
  socket.onmessage = event => { const response = JSON.parse(event.data); const listener = pending.get(response.id); if (listener) { pending.delete(response.id); response.error ? listener.reject(new Error(JSON.stringify(response.error))) : listener.resolve(response.result); } };
  await send('Page.enable'); await send('Runtime.enable');
  const clickText = (selector, text) => evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].find(b => b.textContent.trim() === ${JSON.stringify(text)}).click()`);
  const setup = async scene => {
    const capture = scene === 'task-merge' ? 'task-T-0011' : 'home';
    await send('Page.navigate', { url: `http://127.0.0.1:5196/?capture=${capture}&studio3d=0` });
    await waitFor("document.querySelector('.login-dev')");
    await evaluate(`(async () => {
      // Vite may add an HMR timestamp. Use the module the app actually loaded.
      const dataUrl = performance.getEntriesByType('resource').find(entry => new URL(entry.name).pathname === '/src/api/fake/data.ts')?.name;
      if (!dataUrl) throw new Error('The app has not loaded its fake data module');
      const data = await import(dataUrl);
      globalThis.__followups2Data = data;
      data.snapshot.ai.forEach(ai => { ai.authRequired=false; ai.blocked=false; ai.problem=null; ai.usageLimitedUntil=null; ai.modelLimits=[]; });
      const task = data.snapshot.tasks.find(t => t.id === 'T-0011');
      task.state = 'on_hold';
      task.hold = { returnState:'in_review', reasons:[{kind:'merge_blocked',scope:'task',refId:null,label:'병합 보류',note:'프로젝트 폴더에 커밋되지 않은 변경이 있어 병합을 보류했습니다.',since:data.now()}] };
      data.snapshot.ownerTodos = [
        {kind:'error',id:'screen-hold',memberId:null,taskId:task.id,projectId:task.projectId,reachesMain:false,message:task.id+' '+task.title+': 프로젝트 폴더의 변경을 먼저 정리해야 합니다.',since:data.now()},
        {kind:'recovery_check',id:'screen-recovery',requestId:'RQ-screen',taskId:'T-0006',projectId:'P-0002',message:'T-0006 병합 결과를 확인해야 합니다.',since:data.now()}
      ];
      data.notifications.splice(0, data.notifications.length, ...data.notifications.filter(n => n.key?.startsWith('review-stuck:') || n.key?.startsWith('crash:')));
      data.snapshot.notifications.unread=data.notifications.length;
      data.snapshot.notifications.urgentUnread=1;
    })()`);
    await evaluate("document.querySelector('.login-dev').click()");
    await waitFor("document.querySelector('.app-shell') && !document.querySelector('.loading')");
    if (scene === 'home-holds') {
      await waitFor("document.querySelectorAll('.todo').length === 2");
      await evaluate("document.querySelector('.todo-list').closest('.section').scrollIntoView({block:'start'})");
    }
    if (scene === 'task-merge') {
      await waitFor("document.querySelector('.hold-hint')");
      await evaluate("document.querySelector('.hold-hint').closest('.section').scrollIntoView({block:'start'})");
    }
    if (scene === 'notices') {
      await evaluate("document.querySelector('[aria-label=알림함]').click()");
      await waitFor("document.querySelectorAll('.notice-body').length === 2");
    }
    await evaluate('document.fonts.ready'); await pause(160);
  };
  const captureScreen = async (scene, width) => {
    const audit = await evaluate(`(() => {
      const visible = e => { const r=e.getBoundingClientRect(), s=getComputedStyle(e); return r.width>0 && r.height>0 && s.visibility!=='hidden' && r.top<innerHeight && r.bottom>0; };
      const buttons=[...document.querySelectorAll('button')].filter(visible).map(b=>b.textContent.trim());
      const overflow=[...document.querySelectorAll('button,label,h1,h2,strong,.notice-toggle')].filter(visible).filter(e=>e.clientWidth>0 && e.scrollWidth>e.clientWidth+2).map(e=>({text:e.textContent.trim().slice(0,90), width:e.clientWidth, scroll:e.scrollWidth}));
      const outOfBounds=[...document.querySelectorAll('.notification-menu,.todo button,.modal,.hold-hint')].filter(visible).filter(e=>{const r=e.getBoundingClientRect(); return r.left<0 || r.right>innerWidth;}).map(e=>e.className);
      return {width:innerWidth,documentWidth:document.documentElement.scrollWidth,buttons,overflow,outOfBounds};
    })()`);
    const png = await send('Page.captureScreenshot', {format:'png', captureBeyondViewport:false});
    writeFileSync(resolve(output, `${scene}-${width}.png`), Buffer.from(png.data, 'base64'));
    audits.push({scene,...audit});
    console.log(`${scene}-${width}: document ${audit.documentWidth}, overflow ${audit.overflow.length}`);
    if (audit.documentWidth>width || audit.overflow.length || audit.outOfBounds.length) throw new Error(`Layout failed: ${scene}-${width}: ${JSON.stringify(audit)}`);
    if (audit.buttons.some(t=>/^(재개|다시 시도|재시도|일시정지|중단|검수 등록|팀원 추가|작업 취소)$/.test(t))) throw new Error('Forbidden owner control');
  };
  for (const width of [1440,390]) {
    await send('Emulation.setDeviceMetricsOverride', {width,height:width===1440?1000:844,deviceScaleFactor:1,mobile:false});
    await setup('notices');
    const collapsed = await evaluate(`(() => {
      const line=document.querySelectorAll('.notice-line')[1];
      return {clamp:getComputedStyle(line).webkitLineClamp,height:line.clientHeight,fullHeight:line.scrollHeight};
    })()`);
    if (collapsed.clamp !== '2' || collapsed.height >= collapsed.fullHeight) throw new Error(`Long notice is not clamped: ${JSON.stringify(collapsed)}`);
    await captureScreen('notices-collapsed',width);
    // Native details supports keyboard activation without a second interactive control.
    await evaluate("document.querySelectorAll('.notice-body summary')[1].focus()");
    await send('Input.dispatchKeyEvent', {type:'keyDown',key:' ',code:'Space',windowsVirtualKeyCode:32});
    await send('Input.dispatchKeyEvent', {type:'keyUp',key:' ',code:'Space',windowsVirtualKeyCode:32});
    await waitFor("document.querySelectorAll('.notice-body')[1].open");
    const expanded = await evaluate(`(() => {
      const line=document.querySelectorAll('.notice-line')[1];
      return {height:line.clientHeight,fullHeight:line.scrollHeight};
    })()`);
    if (expanded.height <= collapsed.height || expanded.height !== expanded.fullHeight) throw new Error('Expanded notice is clipped');
    const bodyPreserved = await evaluate("[...document.querySelectorAll('.notice-line')].every((line,i) => line.textContent === globalThis.__followups2Data.notifications[i].body)");
    if (!bodyPreserved) throw new Error('Server body changed');
    await captureScreen('notices-expanded',width);
    const review = await evaluate("globalThis.__followups2Data.snapshot.tasks.find(t=>t.id==='T-0004')");
    await clickText('.notification-item .notice-actions button', '메인 에이전트에게 말하기');
    await waitFor("document.querySelector('.command-input textarea').value.includes('T-0004')");
    const reviewDraft = await evaluate("({target:document.querySelector('[aria-label=\"명령 대상\"]').value,text:document.querySelector('[aria-label=\"명령 입력\"]').value})");
    if (reviewDraft.target!==review.projectId || reviewDraft.text!==`${review.id} "${review.title}"에 대해: `) throw new Error(`Wrong review draft: ${JSON.stringify(reviewDraft)}`);
    await evaluate("document.querySelector('[aria-label=알림함]').click()");
    await waitFor("document.querySelectorAll('.notice-actions').length===2");
    await evaluate("document.querySelectorAll('.notice-actions')[1].querySelectorAll('button')[1].click()");
    await waitFor("document.querySelector('[aria-label=\"명령 입력\"]').value === ''");
    const crashTarget = await evaluate("document.querySelector('[aria-label=\"명령 대상\"]').value");
    if (crashTarget!=='P-0001') throw new Error(`Wrong crash target: ${crashTarget}`);
    interactions.push({width,collapsed,expanded,bodyPreserved,reviewDraft,crashDraft:{target:crashTarget,text:''}});
    await setup('home-holds'); await captureScreen('home-holds',width);
    await setup('task-merge'); await captureScreen('task-merge',width);
  }
  writeFileSync(resolve(output,'layout-audit.json'), JSON.stringify({screens:audits,interactions},null,2)+'\n');
} finally {
  if (socket?.readyState === 1) { try { await send('Browser.close'); } catch { /* closed by command */ } socket.close(); }
  if (browser.exitCode === null) await Promise.race([new Promise(done=>browser.once('exit',done)),pause(3000)]);
  if (browser.exitCode === null) browser.kill();
  await pause(300);
  // Verified absolute path and the exact, script-owned directory name above.
  rmSync(profile,{recursive:true,force:true,maxRetries:5,retryDelay:200});
}
