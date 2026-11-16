// Captures app pages in one headless browser; owns only the Vite server on 5196.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

const out='docs/design/permission-ui/office-departments';
const results=[];
let server,browser;
const shots=[];
const option=name=>process.argv.find(arg=>arg.startsWith(`--${name}=`))?.split('=')[1];
const widths=option('width')?[Number(option('width'))]:[1440,390];
const states=option('state')?[option('state')]:['idle2','idle6','idle','busy'];
const modes=option('mode')?[option('mode')]:['3d','2d'];
try{
  server=await createServer({configFile:'vite.web.config.ts',server:{host:'127.0.0.1',port:5196,strictPort:true}});
  await server.listen();
  browser=await chromium.launch({channel:'msedge',headless:true,args:['--use-angle=swiftshader','--enable-webgl','--disable-dev-shm-usage']});
  for(const width of widths)for(const state of states)for(const mode of modes){
    const page=await browser.newPage({viewport:{width,height:1000},deviceScaleFactor:1});
    const errors=[];page.on('pageerror',error=>errors.push(String(error)));
    try{
      await page.goto(`http://127.0.0.1:5196/?officeState=${state}&studio3d=${mode==='3d'?1:0}&fakeMode=server&fakeSetup=ready`,{waitUntil:'networkidle'});
      const later=page.getByRole('button',{name:'나중에',exact:true});if(await later.count())await later.click();
      await page.waitForSelector('[data-company-member]');
      const people=await page.locator('[data-department] [data-company-member]').evaluateAll(els=>els.map(el=>({
        id:el.dataset.companyMember,name:el.querySelector('strong').firstChild.textContent.trim()})));
      assert.equal(people.length,state==='idle2'?2:state==='idle6'?6:12);
      assert.equal(new Set(people.map(person=>person.name)).size,people.length,'Duplicate company names');
      assert.ok(people.every(person=>/^[가-힣]{2,4}$/u.test(person.name)),'Non-personal company name');
      await page.getByRole('button',{name:'서비스 개발 사무실 열기',exact:true}).click();
      const selector=mode==='3d'?'.studio3d-tag':'.office-person-label';
      await page.waitForFunction(({selector,count})=>document.querySelectorAll(selector).length===count,{selector,count:people.length},{timeout:90000});
      if(mode==='3d')await page.waitForFunction(()=>JSON.parse(window.render_game_to_text(false)).ready,{timeout:90000});
      await page.locator('.studio-scene-section').evaluate(el=>el.scrollIntoView({block:'start'}));
      await page.mouse.move(0,0);await page.waitForTimeout(1200);
      if(option('manual')&&mode==='3d')await page.evaluate(()=>window.advanceTime(0));
      const samples=[];
      for(let sample=0;sample<Number(option('samples')??4);sample++){
        const geometry=await page.locator('.office-scene').evaluate((root,selector)=>{
          const scene=root.getBoundingClientRect(),board=JSON.parse(root.dataset.officeBoard??'[]');
          const overlap=(a,b)=>a.x<b.x+b.width&&a.x+a.width>b.x&&a.y<b.y+b.height&&a.y+a.height>b.y;
          const labels=[...root.querySelectorAll(selector)].map(el=>{
            const box=el.getBoundingClientRect(),css=getComputedStyle(el);
            return{id:el.dataset.memberId,text:el.textContent.trim(),font:parseFloat(css.fontSize),
              box:{x:box.x-scene.x-root.clientLeft,y:box.y-scene.y-root.clientTop,width:box.width,height:box.height},visible:css.display!=='none'&&css.visibility!=='hidden'};
          });
          return {labels,protectedAreas:board,
            overlap:labels.flatMap((a,i)=>labels.slice(i+1).filter(b=>overlap(a.box,b.box)).map(b=>[a.id,b.id])),
            clipped:labels.filter(({box})=>box.x<0||box.y<0||box.x+box.width>root.clientWidth||box.y+box.height>root.clientHeight).map(el=>el.id),
            board:labels.filter(label=>board.some(area=>overlap(label.box,area))).map(el=>el.id)};
        },selector);
        if(geometry.overlap.length||geometry.clipped.length||geometry.board.length){
          await page.screenshot({path:resolve(tmpdir(),'office-seating-debug.png')});
          console.log(JSON.stringify(geometry));
        }
        assert.deepEqual(geometry.overlap,[],'Names overlap');assert.deepEqual(geometry.clipped,[],'Name clipped');assert.deepEqual(geometry.board,[],'Name covers board');
        for(const person of people){const label=geometry.labels.find(label=>label.id===person.id);
          assert.equal(label?.text,person.name,'Name label changed');assert.ok(label.visible&&label.font>=13,'Name unreadable');}
        const seating=await page.evaluate(mode=>mode==='3d'?JSON.parse(window.render_game_to_text(false)).people.map(person=>({
          id:person.id,place:person.place,pose:person.pose,clip:person.clip,x:person.x,y:person.z,status:person.status,
        })): [...document.querySelectorAll('.office-actor[data-member-id]')].map(el=>({
          id:el.dataset.memberId,place:el.dataset.place,pose:el.dataset.pose,seated:el.dataset.seated,
          x:Number(el.dataset.pointX),y:Number(el.dataset.pointY),
        })),mode);
        const idle=seating.filter(person=>state!=='busy'||person.id==='M-8003');
        assert.ok(idle.length>0,'No idle people inspected');
        const sofa=new Set();
        for(const person of idle){
          assert.ok((mode==='3d'?['desk','producer','sofa']:['desk','lounge']).includes(person.place),'Idle person is not at a seat');
          assert.equal(mode==='3d'?person.pose:person.seated,mode==='3d'?'seated':'true','Idle person is standing');
          if(person.place==='sofa'||person.place==='lounge'){
            const key=`${person.x}:${person.y}`;assert.ok(!sofa.has(key),'Shared sofa cushion');sofa.add(key);
          }
        }
        samples.push({names:geometry.labels.length,idle});
        if(option('manual')&&mode==='3d')await page.evaluate(()=>window.advanceTime(100));
        else await page.waitForTimeout(300);
      }
      const path=`${out}/${state}-office-${mode}-${width}.png`;
      await page.screenshot({path:resolve(path)});shots.push(path);
      assert.deepEqual(errors,[],'Page errors');
      results.push({width,state,mode,samples,errors});console.log(`${state} ${mode} ${width}: passed`);
    }finally{await page.close();}
  }
}finally{
  if(browser)await browser.close();if(server)await server.close();
  writeFileSync(`${out}/idle-browser-check.json`,JSON.stringify({results,shots},null,2)+'\n','utf8');
}
assert.equal(results.length,widths.length*states.length*modes.length,'Missing office scenario');
