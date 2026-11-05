import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, sep } from 'node:path';

const workspace = resolve('.');
const profile = resolve('src/renderer/.followups-browser-profile');
if (!profile.startsWith(workspace + sep) || !profile.endsWith('.followups-browser-profile')) throw new Error('Unexpected browser profile path');
const output = resolve('docs/design/permission-ui/followups');
mkdirSync(output, { recursive: true });
const browser = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
  '--headless=new', '--disable-gpu', '--disable-gpu-sandbox', '--no-sandbox', '--in-process-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=9337', `--user-data-dir=${profile}`, 'about:blank',
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
  for (let i = 0; i < 100; i++) { try { pages = await (await fetch('http://127.0.0.1:9337/json/list')).json(); break; } catch { await pause(100); } }
  socket = new WebSocket(pages.find(page => page.type === 'page').webSocketDebuggerUrl);
  await new Promise((done, reject) => { socket.onopen = done; socket.onerror = reject; });
  socket.onmessage = event => { const response = JSON.parse(event.data); const listener = pending.get(response.id); if (listener) { pending.delete(response.id); response.error ? listener.reject(new Error(JSON.stringify(response.error))) : listener.resolve(response.result); } };
  await send('Page.enable'); await send('Runtime.enable');

  const clickText = text => evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(text)}).click()`);
  const setup = async scene => {
    const capture = scene.startsWith('settings') || scene === 'boundary' ? 'settings' : scene === 'report-refused' ? 'documents' : 'home';
    await send('Page.navigate', { url: `http://127.0.0.1:5196/?capture=${capture}&studio3d=0` });
    await waitFor("document.querySelector('.login-dev')");
    await evaluate(`(async () => {
      const data = await import('/src/api/fake/data.ts');
      const bridge = (await import('/src/api/fake/index.ts')).fakeBridge;
      data.settings.developer.mainAgentMock = true;
      data.snapshot.projects.forEach((p, i) => p.mock.enabled = i === 0);
      data.snapshot.ai.forEach(ai => { ai.authRequired = false; ai.blocked = false; ai.problem = null; ai.usageLimitedUntil = null; });
      data.snapshot.ai[0].modelLimits = [{family:'fable', label:'Fable', until:'2026-11-03T12:35:00Z'}];
      data.snapshot.ownerTodos = data.snapshot.ownerTodos.filter(t => t.kind !== 'auth_required');
      const report = data.reports[0];
      report.status = 'read'; report.canRequestChanges = false; report.canApprove = false;
      data.snapshot.directives.find(d => d.id === report.directiveId).state = 'cancelled';
      const task = data.snapshot.tasks[0];
      data.notifications.splice(0, data.notifications.length, {
        id:'N-FOLLOWUP-HANDOFF', level:'normal', title:'메인 에이전트 처리 지연',
        body: task.directiveId + ': ' + task.id + ' "' + task.title + '" 검수가 멈춘 채 남아 있습니다 — 메인 에이전트에게 3번 넘겼지만 검수가 다시 시작되지 않았습니다. 이 작업을 어떻게 할지 명령창으로 메인 에이전트에게 말해 주세요 (예: "' + task.id + ' 검수를 다시 진행해", "' + task.id + '는 취소해").',
        link:{tab:'projects', projectId:task.projectId, directiveId:task.directiveId, taskId:task.id}, createdAt:'2026-10-29T14:35:00Z', read:false
      });
      await bridge.invoke('auth.devLogin');
    })()`);
    await waitFor("document.querySelector('.app-shell')");
    if (scene.startsWith('settings') || scene === 'boundary') {
      await waitFor("document.querySelector('.settings-nav')");
      await clickText('설치 설정'); await waitFor("document.querySelector('.mock-off-card')");
    }
    if (scene === 'settings-mock') await evaluate("document.querySelector('.mock-off-card').previousElementSibling.scrollIntoView({block:'start'})");
    if (scene === 'settings-ai') await evaluate("document.querySelector('.installation-ai').scrollIntoView({block:'start'})");
    if (scene === 'notice-handoff') {
      await evaluate("document.querySelector('[aria-label=알림함]').click()");
      await waitFor("document.querySelector('.notice-actions')");
    }
    if (scene === 'report-refused') {
      await waitFor("document.querySelector('.report-refusal')");
      await evaluate("document.querySelector('.report-refusal').scrollIntoView({block:'center'})");
      const invalid = await evaluate("[...document.querySelectorAll('.doc-viewer button')].some(b => b.textContent.trim() === '수정 요청')");
      if (invalid) throw new Error('Ended report still offers changes');
    }
    await evaluate('document.fonts.ready'); await pause(120);
  };
  const captureScreen = async (scene, width) => {
    const audit = await evaluate(`(() => {
      const visible = e => { const r=e.getBoundingClientRect(), s=getComputedStyle(e); return r.width>0 && r.height>0 && s.visibility!=='hidden' && r.top<innerHeight && r.bottom>0; };
      const buttons=[...document.querySelectorAll('button')].filter(visible).map(b=>b.textContent.trim());
      const overflow=[...document.querySelectorAll('button,label,h1,h2,strong')].filter(visible).filter(e=>e.clientWidth>0 && e.scrollWidth>e.clientWidth+2).map(e=>({text:e.textContent.trim().slice(0,90), width:e.clientWidth, scroll:e.scrollWidth}));
      const outOfBounds=[...document.querySelectorAll('.notification-menu,.ai-warning button,.mock-off-card button,.report-refusal')].filter(visible).filter(e=>{const r=e.getBoundingClientRect(); return r.left<0 || r.right>innerWidth;}).map(e=>e.className);
      return { width:innerWidth, documentWidth:document.documentElement.scrollWidth, buttons, overflow, outOfBounds };
    })()`);
    const image = await send('Page.captureScreenshot', {format:'png', captureBeyondViewport:false});
    writeFileSync(resolve(output, `${scene}-${width}.png`), Buffer.from(image.data, 'base64'));
    audits.push({scene, ...audit});
    console.log(`${scene}-${width}: document ${audit.documentWidth}, overflow ${audit.overflow.length}`);
    if (audit.documentWidth>width || audit.overflow.length || audit.outOfBounds.length) throw new Error(`Layout failed: ${scene}-${width}: ${JSON.stringify(audit.overflow)}`);
    if (audit.buttons.some(t=>/^(재개|다시 시도|재시도|모의 실행 켜기|일시정지|중단|검수 등록)$/.test(t))) throw new Error('Forbidden owner control');
  };
  for (const width of [1440,390]) {
    await send('Emulation.setDeviceMetricsOverride', {width, height:width===1440?1000:844, deviceScaleFactor:1, mobile:false});
    for (const scene of ['settings','settings-mock','settings-ai','home-model-limit','notice-handoff','report-refused']) {
      await setup(scene); await captureScreen(scene,width);
      if (scene==='notice-handoff') {
        await evaluate("[...document.querySelectorAll('.notice-actions button')].find(b=>b.textContent==='메인 에이전트에게 말하기').click()");
        await waitFor("document.querySelector('.command-input textarea').value.includes('T-0001')");
        const subject = await evaluate("document.querySelector('.command-input textarea').value");
        if (!subject.includes('기록 화면 흐름 만들기')) throw new Error(`Missing task name: ${subject}`);
        await captureScreen('notice-command',width);
      }
      if (scene==='settings-mock') {
        await evaluate("[...document.querySelectorAll('.mock-off-card button')][0].click()");
        await waitFor("document.querySelectorAll('.mock-off-card').length===1");
        await evaluate("document.querySelector('.mock-off-card button').click()");
        await waitFor("!document.querySelector('.mock-off-card')");
        if (!await evaluate("document.body.innerText.includes('다음 턴부터 실제 AI CLI로 실행됩니다.')")) throw new Error('Missing mock-off feedback');
      }
    }
    await setup('boundary');
    await evaluate("import('/src/api/fake/data.ts').then(d => { d.settings.team.modelCatalog.claude = [{id:'bad', label:{bad:true}}]; })");
    await clickText('팀과 역할');
    await waitFor("document.querySelector('[role=alert]')?.textContent.includes('설정을 표시하지 못했습니다')");
    await captureScreen('settings-error',width);
    await evaluate("[...document.querySelectorAll('.sidebar button')].find(b=>b.textContent.trim()==='프로젝트').click()");
    await waitFor("document.querySelector('.home h1')");
    if (!await evaluate("!!document.querySelector('.command-bar')")) throw new Error('Settings failure destroyed the rest of the app');
    audits.push({scene:'boundary-recovery',width,passed:true});
  }
  writeFileSync(resolve(output,'layout-audit.json'), JSON.stringify(audits,null,2)+'\n');
} finally {
  if (socket?.readyState === 1) { try { await send('Browser.close'); } catch { /* closed by command */ } socket.close(); }
  // Only this script's isolated browser can still be running here.
  if (browser.exitCode === null) await Promise.race([new Promise(done => browser.once('exit', done)), pause(3000)]);
  if (browser.exitCode === null) browser.kill();
  await pause(300);
  // Both the absolute path and the exact task-specific directory name were verified above.
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
