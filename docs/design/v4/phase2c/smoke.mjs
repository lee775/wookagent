import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
const require=createRequire(import.meta.url);
const {chromium}=require('C:/Users/pc_09/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright-core');
const browser=await chromium.launch({headless:false,args:['--enable-webgl','--use-gl=angle','--use-angle=d3d11']});
const errors=[];
try {
  const page=await browser.newPage({viewport:{width:1440,height:900},deviceScaleFactor:1});
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
  await page.goto('http://127.0.0.1:5198/?officeDemo=busy&studio3d=1',{waitUntil:'networkidle'});
  await page.waitForFunction(()=>window.render_game_to_text&&JSON.parse(window.render_game_to_text(false)).ready,{timeout:30000});
  const first=JSON.parse(await page.evaluate(()=>window.render_game_to_text(false)));
  const blinks=new Map(first.people.map(person=>[person.id,0]));
  for(let i=0;i<250;i++){
    await page.evaluate(()=>window.advanceTime(40));
    const state=JSON.parse(await page.evaluate(()=>window.render_game_to_text(false)));
    for(const person of state.people)blinks.set(person.id,Math.max(blinks.get(person.id)??0,person.eyeBlink));
  }
  await page.screenshot({path:'docs/design/v4/phase2c/busy-1440.png'});
  const result={errors,people:first.people.length,chairs:first.chairs.length,
    nonzeroBlink:[...blinks].filter(([,value])=>value>.01).length,
    blinks:Object.fromEntries(blinks),footSlide:JSON.parse(await page.evaluate(()=>window.render_game_to_text(false))).footSlide};
  writeFileSync('docs/design/v4/phase2c/smoke.json',JSON.stringify(result,null,2));
  console.log(JSON.stringify(result));
  await page.close();
} finally {await browser.close();}
