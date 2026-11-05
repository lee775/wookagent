import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';

const require=createRequire(import.meta.url);
const {chromium}=require('C:/Users/pc_09/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright-core');
const browser=await chromium.launch({headless:false,args:['--enable-webgl','--use-gl=angle','--use-angle=d3d11']});
try {
  const page=await browser.newPage({viewport:{width:1440,height:900},deviceScaleFactor:1});
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
  page.on('response',response=>{if(response.status()>=400)errors.push(`${response.status()} ${response.url()}`);});
  await page.goto(`${process.argv[3]??'http://127.0.0.1:5198'}/?officeDemo=busy&studio3d=1&perfWalk=1`,{waitUntil:'networkidle'});
  await page.waitForFunction(()=>window.studio3dPerfWalk&&JSON.parse(window.render_game_to_text(false)).ready,{timeout:30000});
  await page.evaluate(()=>window.studio3dPerfWalk(true));
  await page.waitForTimeout(500);
  const cdp=await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const metric=async()=>Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(item=>[item.name,item.value]));
  const before=await metric(),started=Date.now();
  const sample=await page.evaluate(()=>new Promise(resolve=>{
    let frames=0;const begin=performance.now();let sampled=begin;
    const prior=new Map(JSON.parse(window.render_game_to_text(false)).people.map(p=>[p.id,{x:p.x,z:p.z}]));
    const travel=new Map([...prior.keys()].map(id=>[id,0]));
    const next=time=>{frames++;
      if(time-sampled>=1000){sampled=time;
        for(const p of JSON.parse(window.render_game_to_text(false)).people){const old=prior.get(p.id);
          if(old){travel.set(p.id,travel.get(p.id)+Math.hypot(p.x-old.x,p.z-old.z));prior.set(p.id,{x:p.x,z:p.z});}}
      }
      if(time-begin<10000)requestAnimationFrame(next);
      else resolve({fps:frames/((time-begin)/1000),travel:[...travel]});};
    requestAnimationFrame(next);
  }));
  const duration=(Date.now()-started)/1000,after=await metric();
  const state=JSON.parse(await page.evaluate(()=>window.render_game_to_text(false)));
  const motion=sample.travel.filter(([id])=>id!=='M-0013').map(([,distance])=>distance);
  const report={fps:+sample.fps.toFixed(1),mainThreadBusy:+((after.TaskDuration-before.TaskDuration)/duration).toFixed(3),
    scriptBusy:+((after.ScriptDuration-before.ScriptDuration)/duration).toFixed(3),
    duration,walkClips:state.people.filter(person=>person.clip==='walk').length,
    movedActors:motion.filter(distance=>distance>.1).length,minTravel:+Math.min(...motion).toFixed(3),
    footSlide:state.footSlide,
    viewport:[1440,900],errors,notes:'Twelve members walk back and forth in separate aisle lanes; the producer remains seated.'};
  writeFileSync(process.argv[2]??'docs/design/v4/phase2c/performance.json',JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
} finally {await browser.close();}
