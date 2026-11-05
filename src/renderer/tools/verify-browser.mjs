// Run with dev:web. Set WOOK_RENDERER_URL to select a freshly started server.
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const rendererUrl = new URL(process.env.WOOK_RENDERER_URL ?? 'http://127.0.0.1:5199/');
const profile = resolve('docs/design/.verify-edge');
const port = 9225;
const child = spawn(edge, [
  '--headless', '--disable-gpu', '--no-sandbox', '--no-first-run', '--window-size=1440,900', '--force-device-scale-factor=1',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  new URL('?officeDemo=busy&capture=home', rendererUrl).toString(),
], { stdio: 'ignore', windowsHide: true });

let socket;
let sequence = 0;
const waiting = new Map();
const pause = ms => new Promise(done => setTimeout(done, ms));
async function cdp(method, params = {}) {
  const id = ++sequence;
  return new Promise((resolveResult, reject) => {
    waiting.set(id, { resolveResult, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const value = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (value.exceptionDetails) throw new Error(value.exceptionDetails.text);
  return value.result.value;
}
async function waitFor(expression, expected = true) {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (await evaluate(expression) === expected) return;
    await pause(100);
  }
  throw new Error(`Timed out: ${expression}`);
}
try {
  let page;
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      page = tabs.find(tab => tab.type === 'page' && tab.url.includes(rendererUrl.host));
      if (page) break;
    } catch { /* DevTools is starting. */ }
    await pause(100);
  }
  if (!page) throw new Error('Edge DevTools did not start');
  socket = new WebSocket(page.webSocketDebuggerUrl);
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (!message.id) return;
    const entry = waiting.get(message.id);
    if (!entry) return;
    waiting.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message));
    else entry.resolveResult(message.result);
  };
  await new Promise((done, reject) => { socket.onopen = done; socket.onerror = reject; });
  await cdp('Runtime.enable');
  await waitFor("Boolean(document.querySelector('.todo-list'))");
  await evaluate("[...document.querySelectorAll('.nav-item')].find(item => item.textContent.includes('문서함')).click()");
  await waitFor("Boolean(document.querySelector('.report-list-item'))");
  await evaluate("[...document.querySelectorAll('.report-list-item')].find(item => item.textContent.includes('위키 구조 개선 검토')).click()");
  await waitFor("document.querySelector('.doc-viewer h2')?.textContent.includes('위키 구조 개선 검토')");
  await evaluate("(() => { const text=document.querySelector('.markdown p')?.firstChild; if (!text) return; const range=document.createRange(); range.selectNodeContents(text); getSelection().removeAllRanges(); getSelection().addRange(range); document.querySelector('.markdown').dispatchEvent(new MouseEvent('mouseup',{bubbles:true})); })()");
  await waitFor("Boolean(document.querySelector('.quote-popover'))");
  await evaluate("[...document.querySelectorAll('.quote-popover button')].find(button => button.textContent.includes('코멘트')).click()");
  await waitFor("Boolean(document.querySelector('.anchor-editor textarea'))");
  await evaluate("(() => { const el=document.querySelector('.anchor-editor textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,'이 부분을 다시 확인해 주세요.'); el.dispatchEvent(new Event('input',{bubbles:true})); })()");
  await evaluate("document.querySelector('.anchor-editor button').click()");
  await waitFor("document.querySelectorAll('.modal blockquote').length === 1");
  await evaluate("[...document.querySelectorAll('.report-list-item')].find(item => item.textContent.includes('이번 주 작업 요약')).click()");
  await waitFor("document.querySelector('.doc-viewer h2')?.textContent.includes('이번 주 작업 요약')");
  await evaluate("[...document.querySelectorAll('.report-footer button')].find(item => item.textContent.includes('수정 요청')).click()");
  await waitFor("Boolean(document.querySelector('.modal'))");
  if (!await evaluate("document.querySelectorAll('.modal blockquote').length === 0 && [...document.querySelectorAll('.modal button')].find(button => button.textContent.includes('수정 요청 보내기'))?.disabled")) throw new Error('Review comments leaked between reports');
  await evaluate("[...document.querySelectorAll('.modal button')].find(button => button.textContent.includes('취소')).click()");
  await evaluate("(() => { const text=document.querySelector('.markdown p')?.firstChild; if (!text) return; const range=document.createRange(); range.selectNodeContents(text); getSelection().removeAllRanges(); getSelection().addRange(range); document.querySelector('.markdown').dispatchEvent(new MouseEvent('mouseup',{bubbles:true})); })()");
  await waitFor("Boolean(document.querySelector('.quote-popover'))");
  await evaluate("[...document.querySelectorAll('.quote-popover button')].find(button => button.textContent.includes('코멘트')).click()");
  await waitFor("Boolean(document.querySelector('.anchor-editor textarea'))");
  await evaluate("(() => { const el=document.querySelector('.anchor-editor textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,'이 보고서의 부분 의견'); el.dispatchEvent(new Event('input',{bubbles:true})); })()");
  await evaluate("document.querySelector('.anchor-editor button').click()");
  await waitFor("document.querySelectorAll('.modal blockquote').length === 1");
  await evaluate("(() => { const el=document.querySelector('.modal textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,'검토 중인 의견'); el.dispatchEvent(new Event('input',{bubbles:true})); })()");
  await waitFor("[...document.querySelectorAll('.modal button')].find(button => button.textContent.includes('수정 요청 보내기'))?.disabled === false");
  await evaluate("[...document.querySelectorAll('.modal button')].find(button => button.textContent.includes('취소')).click()");
  await evaluate("[...document.querySelectorAll('.report-footer button')].find(item => item.textContent.includes('수정 요청')).click()");
  if (!await evaluate("document.querySelectorAll('.modal blockquote').length === 0 && [...document.querySelectorAll('.modal button')].find(button => button.textContent.includes('수정 요청 보내기'))?.disabled")) throw new Error('Cancel did not reset review comments');
  await evaluate("(() => { const el=document.querySelector('.modal textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,'다른 의견'); el.dispatchEvent(new Event('input',{bubbles:true})); })()");
  await waitFor("[...document.querySelectorAll('.modal button')].find(button => button.textContent.includes('수정 요청 보내기'))?.disabled === false");
  await evaluate("document.querySelector('.modal-header button')?.click()");
  await evaluate("[...document.querySelectorAll('.report-footer button')].find(item => item.textContent.includes('수정 요청')).click()");
  if (!await evaluate("document.querySelectorAll('.modal blockquote').length === 0 && [...document.querySelectorAll('.modal button')].find(button => button.textContent.includes('수정 요청 보내기'))?.disabled")) throw new Error('Close icon did not reset review comments');
  await evaluate("document.querySelector('.modal-header button')?.click()");
  await evaluate("[...document.querySelectorAll('.nav-item')].find(item => item.textContent.includes('프로젝트')).click()");
  await evaluate("[...document.querySelectorAll('.project-nav button')].find(item => item.textContent.includes('홈')).click()");
  await waitFor("Boolean([...document.querySelectorAll('.todo')].find(item => item.textContent.includes('새 보고')))");
  await evaluate("[...document.querySelectorAll('.todo')].find(item => item.textContent.includes('새 보고')).querySelector('button').click()");
  await waitFor("document.querySelector('.doc-viewer h2')?.textContent.includes('산책 기록 화면')");
  const opened = await evaluate("document.querySelector('.doc-viewer h2')?.textContent");
  await evaluate("[...document.querySelectorAll('.report-footer button')].find(item => item.textContent.includes('결과 승인')).click()");
  await waitFor("Boolean(document.querySelector('.modal'))");
  await evaluate("[...document.querySelectorAll('.modal button')].find(item => item.textContent.includes('결과 승인')).click()");
  await waitFor("document.querySelector('.report-footer')?.textContent.includes('결과 승인됨')");
  const approved = await evaluate("({ footer: document.querySelector('.report-footer')?.textContent, buttons: [...document.querySelectorAll('.report-footer button')].map(button => button.textContent) })");
  if (approved.buttons.some(text => text.includes('결과 승인') || text.includes('수정 요청'))) throw new Error('Approval controls remain active');
  await evaluate("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))");
  await waitFor("Boolean(document.querySelector('.command-palette'))");
  if (!await evaluate("(() => { const panel=document.querySelector('.command-palette'); const r=panel.getBoundingClientRect(); return panel.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)); })()")) throw new Error('Command palette is not the topmost panel');
  await evaluate("(() => { const el=document.querySelector('.palette-input input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'설정'); el.dispatchEvent(new Event('input',{bubbles:true})); })()");
  await waitFor("document.querySelectorAll('.command-palette [role=option]').length === 1");
  if (!await evaluate("document.querySelector('.command-palette [role=option]')?.textContent.includes('Alt 4') && document.querySelector('.command-palette [role=listbox]')?.id === 'palette-options'")) throw new Error('Filtered palette shortcut changed');
  await evaluate("[...document.querySelectorAll('.command-palette button')].find(button => button.textContent.includes('운영 설정')).click()");
  await waitFor("document.querySelector('.settings-screen h1')?.textContent === '운영 설정'");
  if (!await evaluate("document.querySelectorAll('.nav-item kbd').length === 0 && [...document.querySelectorAll('.nav-item')].every(button => /Alt [1-4]/.test(button.title))")) throw new Error('Navigation shortcut hints moved');
  await cdp('Page.enable');
  await cdp('Page.navigate', { url: new URL('?officeDemo=busy', rendererUrl).toString() });
  await waitFor("document.querySelectorAll('.office-person-label').length === 12");
  await pause(800);
  const office = await evaluate("(() => { const scene=document.querySelector('.office-scene').getBoundingClientRect(); const cards=[...document.querySelectorAll('.office-person-label')].map(label => { label.focus(); const r=label.querySelector('.office-person-card').getBoundingClientRect(); return { name:label.querySelector('strong').textContent, ok:r.left>=scene.left-1 && r.right<=scene.right+1 && r.top>=scene.top-1 && r.bottom<=scene.bottom+1, x:r.left, y:r.top, right:r.right, bottom:r.bottom, labelY:label.getBoundingClientRect().top, labelTop:label.style.top, side:label.dataset.side, flip:label.dataset.cardLeft, up:label.dataset.cardUp }; }); return { width: scene.width, scene:{left:scene.left,top:scene.top,right:scene.right,bottom:scene.bottom}, cards, overflow: document.documentElement.scrollWidth>innerWidth }; })()");
  if (office.width < 1000 || office.cards.some(value => !value.ok) || office.overflow) throw new Error(`Office geometry: ${JSON.stringify(office)}`);
  if (!await evaluate("(() => { const layer=document.querySelector('.office-depth-layer'); const children=[...layer.children]; const values=children.map(node => Number(node.dataset.baseY ?? node.dataset.feetY)); return children.length === 37 && values.every((value,index) => Number.isFinite(value) && (index === 0 || values[index-1] <= value)); })()")) throw new Error('Actor, chair and desk DOM order does not follow feet depth');
  await evaluate("document.activeElement.blur(); document.querySelector('.main-content').scrollTop=0");
  await pause(8000);
  const figureNames = await evaluate("[...document.querySelectorAll('.office-actor')].map(actor => actor.getAttribute('aria-label').replace(' 열기',''))");
  for (const name of figureNames) {
    const point = await evaluate(`(() => { const actor=[...document.querySelectorAll('.office-actor')].find(node => node.getAttribute('aria-label') === ${JSON.stringify(`${name} 열기`)}); const r=actor.querySelector('.actor-hit').getBoundingClientRect(); for (const fy of [.22,.4,.6,.8]) for (const fx of [.5,.3,.7]) { const x=r.left+r.width*fx, y=r.top+r.height*fy; if (document.elementFromPoint(x,y)?.closest('.office-actor')===actor) return { name: ${JSON.stringify(name)}, x,y }; } return {name:${JSON.stringify(name)},x:r.left+r.width/2,y:r.top+r.height*.26,blocked:true}; })()`);
    if (point.blocked) throw new Error(`Figure has no exposed hit area: ${JSON.stringify(point)}`);
    await evaluate(`document.elementFromPoint(${point.x},${point.y}).dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}))`);
    try { await waitFor("Boolean(document.querySelector('.member-panel .member-hero h2'))"); }
    catch { throw new Error(`Figure did not open: ${JSON.stringify(point)}; panel=${await evaluate("document.querySelector('.member-panel')?.innerText.slice(0,140) ?? 'missing'")}`); }
    const openedMember = await evaluate("document.querySelector('.member-panel .member-hero h2')?.textContent");
    if (openedMember !== point.name) throw new Error(`Clicked ${point.name}, opened ${openedMember}`);
    await evaluate("document.querySelector('.member-panel .slide-head button').click()");
    await waitFor("!document.querySelector('.member-panel')");
  }
  process.stdout.write(`Opened: ${opened}\nAfter approval: ${approved.footer.trim()}\nCommand palette: 운영 설정\n`);
  process.stdout.write(`Office: ${office.width.toFixed(0)}px, 12 cards inside, 12 figures clickable\n`);
} finally {
  socket?.close();
  child.kill();
}
