import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {chromium}=require('C:/Users/pc_09/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright-core');
const browser=await chromium.launch({headless:false});const page=await browser.newPage();
await page.goto('http://127.0.0.1:5197/?officeDemo=busy&studio3d=1',{waitUntil:'networkidle'});
await page.waitForFunction(()=>window.render_game_to_text&&JSON.parse(window.render_game_to_text()).ready);
console.log(await page.evaluate(()=>{
 const node=document.querySelector('.office-scene');
 const key=Object.keys(node).find(key=>key.startsWith('__reactFiber'));
 const result=[];let fiber=node[key];
 while(fiber){
  let hook=fiber.memoizedState;const hooks=[];let i=0;
  while(hook&&i++<30){const m=hook.memoizedState;hooks.push(m?.current?.actors?'ACTORS':m?.current?.apply?'RUNTIME':typeof m);hook=hook.next;}
  result.push({name:fiber.type?.name??fiber.elementType?.name??String(fiber.type),hooks});fiber=fiber.return;
 }return result;
}));
await browser.close();
