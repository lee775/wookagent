// Exercise Blender's exported morph tracks through the running Three.js mixer.
import {createRequire} from 'node:module';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
const require=createRequire(import.meta.url);
const {chromium}=require('C:/Users/pc_09/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright-core');
const browser=await chromium.launch({headless:false});
const page=await browser.newPage({viewport:{width:1440,height:900}});
await page.goto('http://127.0.0.1:5197/?officeDemo=busy&studio3d=1',{waitUntil:'networkidle'});
await page.waitForFunction(()=>window.render_game_to_text&&JSON.parse(window.render_game_to_text()).ready);
await page.evaluate(()=>window.advanceTime(0));
const result=await page.evaluate(()=>{
 const host=document.querySelector('.office-scene');
 const key=Object.keys(host).find(key=>key.startsWith('__reactFiber'));
 let fiber=host[key],actors;
 while(fiber&&!actors){let hook=fiber.memoizedState;while(hook&&!actors){actors=hook.memoizedState?.current?.actors;hook=hook.next;}fiber=fiber.return;}
 const actor=actors[0];
 let mesh;actor.root.traverse(object=>{if(object.isSkinnedMesh&&object.morphTargetInfluences)mesh=object;});
 const names=mesh.morphTargetDictionary;
 const sample=(clip,seconds)=>{
  actor.mixer.stopAllAction();
  const action=actor.actions.get(clip);action.reset().setEffectiveWeight(1).play();
  actor.mixer.update(seconds);
  return [...mesh.morphTargetInfluences];
 };
 return {names,tracks:{sit_type:actor.actions.get('sit_type').getClip().tracks.map(t=>t.name).filter(n=>n.includes('morph')),
   stand_talk:actor.actions.get('stand_talk').getClip().tracks.map(t=>t.name).filter(n=>n.includes('morph'))},
   samples:{idle:sample('sit_type',0),blink:sample('sit_type',1.875),talkClosed:sample('stand_talk',0),
      talkOpen:sample('stand_talk',.375),sofaOpen:sample('sofa_talk',.375)}};
});
writeFileSync(join(new URL('.',import.meta.url).pathname.replace(/^\/(\w:)/,'$1'),'morph-browser.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify(result,null,2));
await browser.close();
