import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {chromium}=require('C:/Users/pc_09/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright-core');
const browser=await chromium.launch({headless:false});
for(const step of ['busy','waiting','error','paused','idle']){
 const page=await browser.newPage();await page.goto(`http://127.0.0.1:5197/?officeDemo=${step}&studio3d=1`,{waitUntil:'networkidle'});
 await page.waitForFunction(()=>window.render_game_to_text&&JSON.parse(window.render_game_to_text()).ready);
 for(const ms of [0,1000,3000,6000]){
  if(ms)await page.evaluate(ms=>window.advanceTime(ms),ms);
  const state=await page.evaluate(()=>JSON.parse(window.render_game_to_text()));
  console.log(step,state.time,state.people.map(x=>[x.role,x.status,x.clip,x.pose]).filter(x=>['developer','producer'].includes(x[0])).slice(0,4));
 }
 await page.close();
}
await browser.close();
