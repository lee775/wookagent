import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {chromium}=require('C:/Users/pc_09/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright-core');
const browser=await chromium.launch({headless:false});
const page=await browser.newPage();
page.on('request',request=>{if(/fake|data|index/.test(request.url()))console.log('REQ',request.url());});
await page.goto('http://127.0.0.1:5197/?officeDemo=busy&studio3d=1',{waitUntil:'networkidle'});
console.log('COUNT',await page.evaluate(()=>JSON.parse(window.render_game_to_text?.()??'{}').people?.length));
await browser.close();
