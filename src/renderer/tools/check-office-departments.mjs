// App pages only: one headless browser, serial pages, no desktop/server automation.
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync,existsSync,readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from 'vite';

const out=resolve('docs/design/permission-ui/office-departments');
const smoke=process.argv.includes('--smoke');
const onlyHome=process.argv.includes('--home');
const onlyReplies=process.argv.includes('--replies');
const only2D=process.argv.includes('--2d');
const onlyMembers=process.argv.includes('--members');
const selectedState=process.argv.find(arg=>arg.startsWith('--state='))?.slice(8);
const states=['producer','busy','idle','paused','emergency','six'];
assert.ok(!selectedState||states.includes(selectedState),'Unknown office state');
const shots=!smoke;
const results=[];
mkdirSync(out,{recursive:true});
let server=null,browser=null;
const screenshot=async(page,name)=>{if(shots)await page.screenshot({path:resolve(out,`${name}.png`)});};
const base='http://127.0.0.1:5196/';
async function home(page,state,mode='2d',extra='') {
  const requests=[];page.on('request',request=>{if(/(?:^|\/)Studio3D[.-]|characterKit|\.glb$/.test(new URL(request.url()).pathname))requests.push(request.url());});
  await page.goto(`${base}?officeState=${state}&studio3d=${mode==='3d'?1:0}&fakeMode=server&fakeSetup=ready${extra}`,{waitUntil:'networkidle'});
  await page.waitForSelector('[data-department]');
  const later=page.getByRole('button',{name:'나중에',exact:true});if(await later.count())await later.click();
  await page.waitForTimeout(400);
  assert.deepEqual(requests,[],'Home loaded heavy 3D assets');
  const data=await page.locator('.company-office').evaluate(root=>({departments:[...root.querySelectorAll('[data-department]')].map(el=>el.getAttribute('data-department')),
    people:[...root.querySelectorAll('[data-company-member]')].map(el=>({id:el.getAttribute('data-company-member'),name:el.querySelector('strong')?.firstChild?.textContent?.trim(),role:el.querySelector('strong small')?.textContent,ai:el.querySelector('.company-ai')?.textContent,work:el.querySelector('.company-work')?.textContent}))}));
  assert.equal(data.departments.length,state==='six'?6:1,'Company project count');
  assert.equal(new Set(data.departments).size,data.departments.length,'Company duplicated projects');
  assert.equal(data.people.length,state==='six'?73:state==='producer'?2:13,'Company member count');
  assert.equal(new Set(data.people.map(person=>person.id)).size,data.people.length,'Company duplicated members');
  assert.equal(await page.locator('.main-agent-banner').count(),1,'Main entry route disappeared');
  assert.equal(await page.locator('.project-card .project-card-top strong').count(),data.departments.length,'Project entry routes disappeared');
  if(state==='producer'||state==='idle')assert.match(await page.locator('.company-office').innerText(),/진행 중인 지시가 없어 지금 일하는 직원이 없습니다/,'Idle department is unexplained');
  if(state==='busy'&&mode==='2d'&&(!smoke||onlyMembers)&&!onlyReplies){
    const entry=page.locator('[data-company-member="M-8002"]');
    const name=(await entry.getAttribute('aria-label')).replace(' 팀원 상세 열기','');
    await entry.click();const panel=page.getByRole('complementary',{name:'팀원 상세',exact:true});
    await panel.getByRole('heading',{name,exact:true}).waitFor();
    await page.waitForTimeout(300);
    assert.equal(await page.locator('.toast').filter({hasText:'요청을 처리하지 못했습니다'}).count(),0,'Fixture member panel could not read its member or task');
    await screenshot(page,`busy-member-panel-${page.viewportSize().width}`);
    await panel.getByRole('button',{name:'팀원 상세 닫기',exact:true}).click();
    assert.deepEqual(requests,[],'Home or member panel loaded heavy 3D assets');
    await page.locator('.main-content').evaluate(el=>{el.scrollTop=0;});
  }
  return data;
}
async function office(page,data,mode,width,state) {
  await page.getByRole('button',{name:'\uC11C\uBE44\uC2A4 \uAC1C\uBC1C \uC0AC\uBB34\uC2E4 \uC5F4\uAE30',exact:true}).click();
  const selector=mode==='3d'?'.studio3d-tag':'.office-person-label';
  const people=data.people.filter(person=>person.id!=='M-MAIN');
  await page.waitForFunction(({selector,count})=>document.querySelectorAll(selector).length===count,{selector,count:people.length},{timeout:90000});
  await page.locator('.studio-scene-section').evaluate(el=>el.scrollIntoView({block:'start'}));
  await page.mouse.move(0,0);await page.waitForTimeout(800);
  const checks=[];
  for(let sample=0;sample<6;sample++){
    const geometry=await page.locator('.office-scene').evaluate((root,selector)=>{
      const scene=root.getBoundingClientRect(),board=JSON.parse(root.dataset.officeBoard??'[]');
      const overlap=(a,b)=>a.x<b.x+b.width&&a.x+a.width>b.x&&a.y<b.y+b.height&&a.y+a.height>b.y;
      const labels=[...root.querySelectorAll(selector)].map(el=>{const box=el.getBoundingClientRect(),css=getComputedStyle(el);return{id:el.getAttribute('data-member-id'),text:el.textContent.trim(),children:[...el.children].map(child=>child.tagName),visible:css.display!=='none'&&css.visibility!=='hidden',background:css.backgroundColor,border:parseFloat(css.borderWidth),
        box:{x:box.left-scene.left,y:box.top-scene.top,width:box.width,height:box.height},font:parseFloat(css.fontSize)};});
      return{labels,board,scene:{width:scene.width,height:scene.height},
        overlaps:labels.flatMap((a,i)=>labels.slice(i+1).filter(b=>overlap(a.box,b.box)).map(b=>[a.id,b.id])),
        clipped:labels.filter(el=>el.box.x<0||el.box.y<0||el.box.x+el.box.width>scene.width||el.box.y+el.box.height>scene.height).map(el=>el.id),
        overBoard:labels.filter(el=>board.some(area=>overlap(el.box,area))).map(el=>el.id),tethers:root.querySelectorAll('.staff-tether').length};
    },selector);
    if(geometry.clipped.length||geometry.overlaps.length||geometry.overBoard.length){console.log(JSON.stringify(geometry));await screenshot(page,`round2-debug-${mode}-${width}`);}
    assert.equal(geometry.labels.filter(label=>label.visible).length,people.length,'Office hid a name');
    for(const person of people){const label=geometry.labels.find(label=>label.id===person.id);assert.equal(label?.text,person.name,'Always-visible office label contains more than the name');assert.deepEqual(label.children,['STRONG'],'Floating office paragraph returned');assert.equal(label.background,'rgba(0, 0, 0, 0)','Office name regained a panel');assert.equal(label.border,0);assert.ok(label.font>=13,'Office name is too small');}
    assert.deepEqual(geometry.overlaps,[],'Office names overlapped');assert.deepEqual(geometry.clipped,[],'Office name clipped');assert.deepEqual(geometry.overBoard,[],'Office name covered whiteboard writing');
    assert.equal(geometry.tethers,0,'Leader lines returned');
    checks.push({names:geometry.labels.length,overlaps:geometry.overlaps,clipped:geometry.clipped,overBoard:geometry.overBoard});
    await page.waitForTimeout(150);
  }
  assert.equal(await page.locator('.office-detail-card:not([hidden])').count(),0,'Office details are visible without a request');
  assert.ok(await page.locator('.office-viewport').evaluate(el=>el.scrollWidth<=el.clientWidth+1),'Office requires horizontal panning to read names');
  const directory=page.locator('[data-directory-member]');assert.equal(await directory.count(),people.length,'Directory omitted a member');
  assert.equal(await page.locator('.studio-scene-section').evaluate(el=>el.nextElementSibling?.querySelector('h2')?.textContent),'\uD300\uC6D0 \uB514\uB809\uD130\uB9AC','Directory is not directly below the office');
  for(const person of people){const row=directory.filter({has:page.locator(`.member-card-head strong`,{hasText:person.name})});const text=await page.locator(`[data-directory-member="${person.id}"]`).innerText();assert.ok(text.includes(person.ai)&&text.includes(person.work)&&text.includes(person.role),'Directory lost role AI or current step');}
  await screenshot(page,`${state}-office-${mode}-${width}`);
  if(shots){await page.locator('.studio-scene-section').evaluate(el=>el.nextElementSibling.scrollIntoView({block:'start'}));await screenshot(page,`${state}-directory-${mode}-${width}`);await page.locator('.studio-scene-section').evaluate(el=>el.scrollIntoView({block:'start'}));}
  if(state==='busy'){
    const card=page.locator('.office-detail-card:not([hidden])');
    const validateCard=async person=>{
      await card.waitFor({timeout:2000}).catch(()=>undefined);assert.equal(await card.count(),1,'Requested office detail card did not open');
      assert.equal(await page.getByRole('complementary',{name:'팀원 상세',exact:true}).count(),0,'Office name opened member panel before details were requested');
      assert.ok(await card.isVisible(),'Requested office detail card is hidden');
      const text=await card.innerText();for(const value of [person.name,person.role,person.ai,person.work])assert.ok(text.includes(value),'On-demand card lost role AI or current work');
      const valid=await card.evaluate((el,{id,mode})=>{
        const scene=el.closest('.office-scene'),root=scene.getBoundingClientRect(),box=el.getBoundingClientRect();
        const name=scene.querySelector(`[data-member-id="${id}"]${mode==='3d'?'.studio3d-tag':'.office-person-label'}`).getBoundingClientRect();
        let head;if(mode==='3d'){const person=JSON.parse(window.render_game_to_text(false)).people.find(person=>person.id===id),r=person.headRadius;head={left:person.clickPoint.x-r,top:person.clickPoint.y-r*1.15,right:person.clickPoint.x+r,bottom:person.clickPoint.y+r*1.05};}
        else head=scene.querySelector(`.office-actor[data-member-id="${id}"] .rig-head`).getBoundingClientRect();
        const overlaps=(a,b)=>a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top;
        const board=JSON.parse(scene.dataset.officeBoard??'[]').map(rect=>({left:root.left+rect.x,top:root.top+rect.y,right:root.left+rect.x+rect.width,bottom:root.top+rect.y+rect.height}));
        return{inside:box.left>=root.left&&box.right<=root.right&&box.top>=root.top&&box.bottom<=root.bottom,head:overlaps(box,head),name:overlaps(box,name),board:board.some(area=>overlaps(box,area))};
      },{id:person.id,mode});
      assert.deepEqual(valid,{inside:true,head:false,name:false,board:false},'Office card clipped or covered its name head or board');
    };
    for(const person of smoke?people.slice(0,1):people){const name=page.locator(`${selector}[data-member-id="${person.id}"]`);await name.hover();await validateCard(person);if(person.id===people[0].id)await screenshot(page,`busy-card-hover-${mode}-${width}`);await page.mouse.move(0,0);await page.waitForTimeout(200);assert.equal(await card.count(),0,'Office hover card stayed after leaving');}
    const first=people[0],second=people[1];
    const firstName=page.locator(`${selector}[data-member-id="${first.id}"]`),secondName=page.locator(`${selector}[data-member-id="${second.id}"]`);
    await firstName.focus();await validateCard(first);await screenshot(page,`busy-card-focus-${mode}-${width}`);
    await page.keyboard.press('Escape');assert.equal(await card.count(),0,'Escape did not close office card');
    await secondName.focus();await validateCard(second);await firstName.focus();await validateCard(first);assert.equal(await card.count(),1);
    await page.getByRole('textbox',{name:'\uBA85\uB839 \uC785\uB825'}).focus();await page.waitForTimeout(200);assert.equal(await card.count(),0,'Blur did not close office card');await firstName.focus();await validateCard(first);
    for(const person of [first,second]){
      await page.locator(`${selector}[data-member-id="${person.id}"]`).focus();await validateCard(person);
      await page.keyboard.press('Tab');assert.ok(await card.locator('.office-detail-close').evaluate(el=>el===document.activeElement),'Keyboard cannot reach member details');
      await page.keyboard.press('Tab');assert.ok(await card.locator('.office-detail-open').evaluate(el=>el===document.activeElement),'Keyboard cannot reach member details');await validateCard(person);
    }
    await firstName.focus();await page.keyboard.press('Tab');await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');const panel=page.getByRole('complementary',{name:'\uD300\uC6D0 \uC0C1\uC138',exact:true});await panel.waitFor({timeout:2000}).catch(()=>undefined);assert.equal(await panel.count(),1,'Office detail control did not open member panel');await panel.getByRole('heading',{name:first.name,exact:true}).waitFor();await page.getByRole('button',{name:'\uD300\uC6D0 \uC0C1\uC138 \uB2EB\uAE30',exact:true}).click();
    await page.mouse.move(0,0);await page.locator('.studio-scene-section').evaluate(el=>el.scrollIntoView({block:'start'}));
    if(width===390)await firstName.tap();else{await firstName.dispatchEvent('pointerdown',{pointerType:'touch',bubbles:true});await firstName.dispatchEvent('click',{bubbles:true});}await validateCard(first);await screenshot(page,`busy-card-touch-${mode}-${width}`);
    if(width===390){const box=await page.locator('.office-scene').boundingBox();await page.touchscreen.tap(box.x+8,box.y+8);}else await page.locator('.office-scene').dispatchEvent('pointerdown',{pointerType:'touch',bubbles:true});assert.equal(await card.count(),0,'Tap elsewhere did not close office card');
    await page.mouse.move(0,0);await page.evaluate(()=>document.activeElement?.blur());
  }
  return{samples:checks,onDemand:state==='busy'?'hover/focus/touch/details/escape/outside passed':'not requested'};
}

try {
  if(process.argv.includes('--serve')){server=await createServer({configFile:'vite.web.config.ts',server:{host:'127.0.0.1',port:5196,strictPort:true}});await server.listen();}
  browser=await chromium.launch({channel:'msedge',headless:true,args:['--use-angle=swiftshader','--enable-webgl','--disable-dev-shm-usage']});
  for(const width of process.argv.includes('--phone')?[390]:smoke?[1440]:[1440,390]) {
    for(const state of onlyReplies?[]:selectedState?[selectedState]:smoke?['busy']:states) {
      for(const mode of onlyHome||only2D?['2d']:smoke?['3d']:state==='six'?['2d']:['3d','2d']) {
        const page=await browser.newPage({viewport:{width,height:1000},deviceScaleFactor:1,hasTouch:width===390});
        const errors=[];page.on('pageerror',e=>errors.push(String(e)));
        try {
          const data=await home(page,state,mode);
          if(mode==='2d'){
            await screenshot(page,`${state}-company-${width}`);
            if(state!=='six'){await page.locator('[data-department]').evaluate(el=>el.scrollIntoView({block:'start'}));await screenshot(page,`${state}-department-${width}`);}
            if(state==='six')for(const id of data.departments){await page.locator(`[data-department="${id}"]`).evaluate(el=>el.scrollIntoView({block:'start'}));await screenshot(page,`six-company-${id}-${width}`);}
          }
          const checks=!onlyHome&&state!=='six'?await office(page,data,mode,width,state):[];
          assert.deepEqual(errors,[],'App page errors');
          results.push({width,state,mode,people:data.people.length,departments:data.departments.length,checks,errors});
          console.log(`${state} ${mode} ${width}: passed`);
        } finally {await page.close();}
      }
    }
    if(!smoke||onlyReplies){
      const page=await browser.newPage({viewport:{width,height:1000},deviceScaleFactor:1,hasTouch:width===390});
      try {
        await home(page,'busy','2d','&fakeReply=both');
        await page.getByLabel('읽지 않은 메인 답변 2개',{exact:true}).waitFor();
        await screenshot(page,`main-replies-toast-${width}`);
        await page.getByRole('button',{name:'메인 에이전트의 답 — 서비스 개발 대화 열기',exact:true}).click();
        assert.equal(await page.getByRole('combobox',{name:'명령 대상'}).inputValue(),'P-8001','Toast opened wrong conversation');
        await page.locator('.bubble-main_agent').filter({hasText:'검색 화면의 기본 흐름을 연결했습니다.'}).waitFor();
        await page.getByLabel('읽지 않은 메인 답변 1개',{exact:true}).waitFor();
        await screenshot(page,`main-reply-project-${width}`);
        await page.getByRole('button',{name:'알림함',exact:true}).click();
        await screenshot(page,`main-replies-bell-${width}`);
        const direct=page.locator('.notification-item').filter({has:page.locator('strong',{hasText:/^메인 에이전트의 답$/})});
        await direct.getByRole('button',{name:'답변 대화 열기',exact:true}).click();
        assert.equal(await page.getByRole('combobox',{name:'명령 대상'}).inputValue(),'main','Bell opened wrong conversation');
        await page.locator('.bubble-main_agent').filter({hasText:'전체 부서의 업무를 확인했습니다.'}).waitFor();
        await page.waitForFunction(()=>!document.querySelector('.conversation-unread'));
        const bottom=await page.locator('.conversation').evaluate(el=>el.scrollHeight-el.clientHeight-el.scrollTop);
        assert.ok(await page.locator('.conversation').evaluate(el=>el.scrollHeight>el.clientHeight),'Conversation scroll check needs overflow');
        assert.ok(bottom<3,'Conversation did not open at newest message');
        await screenshot(page,`main-reply-direct-${width}`);
        results.push({width,state:'main-replies',toast:'project',bell:'direct',unreadCleared:true,newest:true});
      } finally {await page.close();}
    }
  }
} finally {if(browser)await browser.close();if(server)await server.close();}
if(shots){const path=resolve(out,'browser-check.json');const keys=new Set(results.map(item=>`${item.width}/${item.state}/${item.mode}`));
  const previous=selectedState&&existsSync(path)?JSON.parse(readFileSync(path,'utf8')).filter(item=>!keys.has(`${item.width}/${item.state}/${item.mode}`)):[];
  writeFileSync(path,JSON.stringify([...previous,...results],null,2)+'\n');}
console.log('Office/company browser assertions passed');
