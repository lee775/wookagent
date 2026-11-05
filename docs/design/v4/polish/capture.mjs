import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const require=createRequire(import.meta.url);
const {chromium}=require('C:/Users/pc_09/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright-core');
const output=new URL('.',import.meta.url).pathname.replace(/^\/(\w:)/,'$1');
mkdirSync(output,{recursive:true});
const smoke=process.argv.includes('--smoke');
const idleSmoke=process.argv.includes('--idle-smoke');
const portraits=process.argv.includes('--portraits');
const browser=await chromium.launch({headless:false,args:['--enable-webgl','--use-gl=angle','--use-angle=d3d11']});
const report={scenarios:[],performance:null,errors:[],controls:null,closeups:[]};

async function open(step,width=1440,scale=1,initialMs=1600,video=false,thirteen=false){
  const context=await browser.newContext({viewport:{width,height:900},deviceScaleFactor:scale,
    ...(video?{recordVideo:{dir:output,size:{width,height:900}}}:{})});
  const page=await context.newPage();
  if(thirteen){
    await page.route('**/src/api/fake/data.ts*',async route=>{
      const response=await route.fetch();
      const body=await response.text();
      const injection=`\n{ const projectMembers=snapshot.members.filter(member=>member.projectId==='P-0003'); const source=projectMembers.find(member=>!member.isProducer); if(projectMembers.length<13&&source) snapshot.members.push({...source,id:'M-POLISH-13',name:'13th worker',status:'working'}); }\n`;
      await route.fulfill({response,body:body+injection});
    });
  }
  // Chromium's implicit root favicon request is unrelated to Studio assets.
  await page.route('**/favicon.ico',route=>route.fulfill({status:204,body:''}));
  page.on('pageerror',error=>report.errors.push({kind:'pageerror',message:error.message}));
  page.on('console',message=>{if(message.type()==='error')report.errors.push({kind:'console',message:message.text(),location:message.location()});});
  page.on('response',response=>{if(response.status()>=400)report.errors.push({kind:'http',status:response.status(),url:response.url()});});
  page.on('requestfailed',request=>report.errors.push({kind:'request',url:request.url(),failure:request.failure()}));
  await page.goto(`http://127.0.0.1:5197/?officeDemo=${step}&studio3d=1${process.argv.includes('--unlit')?'&unlit=1':''}${process.argv.includes('--noshadow')?'&noshadow=1':''}`,{waitUntil:'networkidle'});
  await page.waitForFunction(()=>window.render_game_to_text&&JSON.parse(window.render_game_to_text()).ready,{timeout:30000});
  if(initialMs)await page.evaluate(ms=>window.advanceTime(ms),initialMs);
  return {page,context};
}

async function state(page){return JSON.parse(await page.evaluate(()=>window.render_game_to_text()));}
function check(snapshot,step,width){
  const issues=[...snapshot.problems];
  if(snapshot.people.length!==snapshot.expectedCount)
    issues.push(`expected ${snapshot.expectedCount} snapshot members, got ${snapshot.people.length}`);
  for(const person of snapshot.people){
    if(!Number.isFinite(person.screenHeight)||!Number.isFinite(person.headTorsoHeight))
      issues.push(`${person.id} has no measured skinned bounds`);
    if(width===1440&&person.pose==='standing'&&person.screenHeight<64)
      issues.push(`${person.id} standing ${person.screenHeight}px < 64px`);
    if(width===1440&&person.pose==='seated'&&person.headTorsoHeight<36)
      issues.push(`${person.id} seated head/torso ${person.headTorsoHeight}px < 36px`);
    if(person.status==='error'&&person.clip!=='head_in_hands')issues.push(`${person.id} error clip`);
    if(person.status==='awaiting_answer'&&person.clip!=='hand_raise')issues.push(`${person.id} waiting clip`);
    if(person.status==='paused'&&person.clip!=='sit_lean_back')issues.push(`${person.id} paused clip`);
    if(person.status==='working'&&!person.clip?.startsWith('sit_'))issues.push(`${person.id} work clip`);
    if(person.clip==='stand_drink'&&!person.mugHeld)issues.push(`${person.id} mug is not in hand`);
  }
  const standing=snapshot.people.filter(person=>person.pose==='standing').map(person=>person.screenHeight);
  const seated=snapshot.people.filter(person=>person.pose==='seated').map(person=>person.headTorsoHeight);
  return {step,width,count:snapshot.people.length,expected:snapshot.expectedCount,
    standingMin:standing.length?Math.min(...standing):null,
    seatedHeadTorsoMin:seated.length?Math.min(...seated):null,
    issues,people:snapshot.people};
}

async function closeup(page,person,name,clip,level,view='front'){
  await page.evaluate(()=>window.advanceTime(550));
  const chosen=clip??person.clip;
  const frame=name==='status-hand_raise-2x.png'?10:name==='status-hand_raise-waiting-2x.png'?29:
    name==='status-head_in_hands-2x.png'?17:name==='status-sit_celebrate-2x.png'?18:
    name==='rest-coffee-2x.png'?28:17;
  await page.evaluate(({id,chosen,level,view,frame})=>{
    window.studio3dCapture(id,undefined,level,view);
    const host=document.querySelector('.office-scene');
    const key=Object.keys(host).find(key=>key.startsWith('__reactFiber'));
    let fiber=host[key],actors;
    while(fiber&&!actors){
      let hook=fiber.memoizedState;
      while(hook&&!actors){actors=hook.memoizedState?.current?.actors;hook=hook.next;}
      fiber=fiber.return;
    }
    const actor=actors?.find(item=>item.memberId===id);
    if(window.location.search.includes('noshadow=1'))actor.root.traverse(object=>{if(object.isMesh)object.receiveShadow=false;});
    if(window.location.search.includes('unlit=1'))actor.root.traverse(object=>{
      if(object.isMesh){for(const material of Array.isArray(object.material)?object.material:[object.material]){
        material.emissive.copy(material.color);material.color.setRGB(0,0,0);material.emissiveIntensity=1;
      }}
    });
    const action=actor?.actions.get(chosen);
    if(!action)throw new Error(`No browser clip ${chosen} for ${id}`);
    actor.mixer.stopAllAction();
    action.reset().setEffectiveWeight(1).setEffectiveTimeScale(1).play();
    actor.mixer.update((frame-1)/24);
    actor.current=chosen;
    window.studio3dCapture(id,undefined,level,view);
    for(const item of actors){
      if(!item.root.visible)item.mug.visible=false;
      if(!['hold_folder','hand_over','receive'].includes(chosen))item.folder.visible=false;
    }
    document.querySelector('.studio3d-tags')?.style.setProperty('display','none');
  },{id:person.id,chosen,level,view,frame});
  const box=await page.locator('.office-scene canvas').boundingBox();
  if(!box)throw new Error('No Studio 3D canvas');
  const width=380,height=380;
  await page.screenshot({path:join(output,name),clip:{x:box.x+box.width/2-width/2,
    y:box.y+box.height/2-height/2,width,height}});
  report.closeups.push({file:name,member:person.id,clip:chosen,frame,level,view});
}

async function overviewPose(page,person,clip,frame,name){
  await page.evaluate(({id,clip,frame})=>{
    const host=document.querySelector('.office-scene');
    const key=Object.keys(host).find(key=>key.startsWith('__reactFiber'));
    let fiber=host[key],actors;
    while(fiber&&!actors){let hook=fiber.memoizedState;while(hook&&!actors){actors=hook.memoizedState?.current?.actors;hook=hook.next;}fiber=fiber.return;}
    const actor=actors.find(item=>item.memberId===id);
    const action=actor.actions.get(clip);
    actor.mixer.stopAllAction();action.reset().setEffectiveWeight(1).setEffectiveTimeScale(1).play();
    actor.mixer.update((frame-1)/24);actor.current=clip;window.advanceTime(0);
  },{id:person.id,clip,frame});
  await page.screenshot({path:join(output,name),scale:'css'});
}

try{
  const scenarios=idleSmoke?[['idle',1440]]:smoke?[['busy',1440]]:portraits?[]:
    [['busy',1440],['idle',1440]];
  for(const [step,width] of scenarios){
    const {page,context}=await open(step,width);
    const snapshot=await state(page);
    report.scenarios.push(check(snapshot,step,width));
    await page.screenshot({path:join(output,`${step}-${width}.png`)});
    await context.close();
  }
  if(!smoke&&!idleSmoke){
    const {page,context}=await open('idle',1440);
    const canvas=page.locator('.office-scene canvas'),box=await canvas.boundingBox();
    if(!box)throw new Error('No Studio 3D canvas');
    await page.mouse.move(box.x+box.width/2,box.y+box.height/2);
    await page.mouse.wheel(0,-400);
    const zoomed=(await state(page)).camera;
    await page.mouse.down();
    await page.mouse.move(box.x+box.width/2+90,box.y+box.height/2+30,{steps:5});
    await page.mouse.up();
    const panned=(await state(page)).camera;
    await canvas.dblclick();
    const reset=(await state(page)).camera;
    const target=(await state(page)).people.find(person=>person.place==='coffee');
    if(target)await page.mouse.click(box.x+target.screenX,box.y+target.screenY);
    report.controls={zoomed:zoomed.zoom>1,panned:Math.abs(panned.panX)+Math.abs(panned.panZ)>0,
      reset:reset.zoom===1&&reset.panX===0&&reset.panZ===0,
      selected:await page.locator('.member-panel').isVisible()};
    await context.close();

    const busy=await open('busy',1440,2);
    const busyState=await state(busy.page),seen=new Set();
    for(const person of busyState.people)if(!seen.has(person.role)){
      seen.add(person.role);
      await closeup(busy.page,person,`desk-${person.role}-2x.png`,undefined,5.3);
    }
    await busy.context.close();
    for(const [step,status,name] of [
      ['waiting','awaiting_answer','status-hand_raise-waiting-2x.png'],
      ['error','error','status-head_in_hands-2x.png'],
      ['paused','paused','status-sit_lean_back-2x.png'],
    ]){
      const opened=await open(step,1440,2,step==='waiting'?320:1400);
      const people=(await state(opened.page)).people;
      const matched=people.find(item=>item.status===status);
      const person=matched??people.find(item=>item.role==='developer')??people[0];
      if(!person)throw new Error(`No person in ${step}`);
      if(step==='waiting'){
        await overviewPose(opened.page,person,'hand_raise',10,'status-hand_raise-1440.png');
        await overviewPose(opened.page,person,'hand_raise',29,'status-hand_raise-waiting-1440.png');
        await closeup(opened.page,person,'status-hand_raise-2x.png',undefined,5.3);
        await opened.page.evaluate(()=>window.advanceTime(950));
      }
      if(step==='error')await overviewPose(opened.page,person,'head_in_hands',17,'status-head_in_hands-1440.png');
      await closeup(opened.page,person,name,
        step==='paused'?'sit_lean_back':step==='error'?'head_in_hands':'hand_raise',5.3);
      await opened.context.close();
    }
    const extra=await open('busy',1440,2);
    const worker=(await state(extra.page)).people.find(person=>person.role==='developer');
    if(!worker)throw new Error('No developer for status close-ups');
    await closeup(extra.page,worker,'status-sit_think-2x.png','sit_think',5.3);
    await closeup(extra.page,worker,'status-sit_celebrate-2x.png','sit_celebrate',5.3);
    await extra.context.close();

    const idle=await open('idle',1440,2,600);
    const idleState=await state(idle.page);
    for(const [place,name] of [
      ['coffee','rest-coffee-2x.png'],['sofa','rest-sofa_talk-2x.png'],
      ['window','rest-window_gaze-2x.png'],['meeting','rest-meeting-2x.png'],
    ]){
      const person=place==='window'?[...idleState.people].reverse().find(item=>item.place===place):
        idleState.people.find(item=>item.place===place);
      if(!person)throw new Error(`No ${place} rest guest`);
      await closeup(idle.page,person,name,place==='sofa'?'sofa_talk':undefined,
        place==='sofa'?3.0:place==='meeting'?3.5:place==='coffee'?3.0:3.0,
        place==='window'?'rear':'front');
    }
    await idle.context.close();

    if(!portraits){
    const performance=await open('busy',1440,1,1600,false,false);
    const perfState=await state(performance.page);
    const cdp=await performance.context.newCDPSession(performance.page);
    await cdp.send('Performance.enable');
    const metric=async()=>Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(item=>[item.name,item.value]));
    const before=await metric(),started=Date.now();
    const fps=await performance.page.evaluate(()=>new Promise(resolve=>{
      let frames=0;const begin=performance.now();
      const next=time=>{frames++;if(time-begin<10000)requestAnimationFrame(next);
        else resolve(frames/((time-begin)/1000));};
      requestAnimationFrame(next);
    }));
    const duration=(Date.now()-started)/1000,after=await metric();
    report.performance={people:perfState.people.length,expected:perfState.expectedCount,
      fps:+fps.toFixed(1),mainThreadBusy:+((after.TaskDuration-before.TaskDuration)/duration).toFixed(3),
      scriptBusy:+((after.ScriptDuration-before.ScriptDuration)/duration).toFixed(3),duration};
    await performance.context.close();
    }
  }
  writeFileSync(join(output,'probe.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({scenarios:report.scenarios.map(({step,width,count,expected,standingMin,seatedHeadTorsoMin,issues})=>
    ({step,width,count,expected,standingMin,seatedHeadTorsoMin,issues})),
    performance:report.performance,controls:report.controls,errors:report.errors},null,2));
}finally{await browser.close();}
