// Compile isolated copies. Production source and concurrent test discovery stay untouched.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { Raycaster, SkinnedMesh, Vector3 } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const workspace=process.cwd(),out=path.resolve('docs/design/v4/phase2d');
const temporary=path.join(out,`mutation-runtime-${process.pid}`),files=[],directories=[];
assert(temporary.startsWith(workspace+path.sep));
fs.mkdirSync(temporary);directories.push(temporary);
const sources=path.resolve('src/renderer/src/studio3d');
const results=[];
async function compileVariant(name,target,mutate){
  const directory=path.join(temporary,name);fs.mkdirSync(directory);directories.push(directory);
  const written=new Map();
  function compile(filename){
    filename=path.resolve(filename);
    if(written.has(filename))return written.get(filename);
    const destination=path.join(directory,`${written.size}.mjs`);written.set(filename,destination);
    let source=fs.readFileSync(filename,'utf8').replaceAll('\r\n','\n');
    if(filename===path.join(sources,target)){
      const changed=mutate(source);assert.notEqual(changed,source,`Missing mutation target: ${name}`);source=changed;
    }
    let javascript=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
    javascript=javascript.replace(/(from\s*|import\s*\()(['"])(\.[^'"]+)\2/g,(whole,prefix,quote,specifier)=>{
      const base=path.resolve(path.dirname(filename),specifier);
      const dependency=[base,base+'.ts',base+'.tsx',path.join(base,'index.ts')].find(candidate=>fs.existsSync(candidate)&&fs.statSync(candidate).isFile());
      assert(dependency,`Unresolved ${specifier}`);
      return prefix+quote+pathToFileURL(compile(dependency)).href+quote;
    });
    fs.writeFileSync(destination,javascript);files.push(destination);return destination;
  }
  const modules={};
  for(const module of ['placement','navigation','behaviour','characterKit','workstations','footContact'])
    modules[module]=await import(pathToFileURL(compile(path.join(sources,module+'.ts'))).href);
  return modules;
}
const member=(id,isProducer=false)=>({id,name:id,roleId:isProducer?'producer':'developer',isProducer,status:'working',deleted:false});
const team=count=>count?[member('producer',true),...Array.from({length:count-1},(_,index)=>member(`M-${100+index}`))]:[];
const positions=(modules,count)=>modules.placement.snapshotPlacement({members:team(count),tasks:[],directives:[],activity:[],emergency:false,now:0});
async function gltf(name){
  const bytes=fs.readFileSync(`src/renderer/public/studio3d/${name}.glb`);
  return new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');
}
const checks={
  count:modules=>assert.equal(positions(modules,50).length,50),
  door:modules=>{
    const engine=new modules.behaviour.OfficeBehaviour(new modules.navigation.NavigationGrid(modules.navigation.sharedFootprints));
    engine.apply(positions(modules,2),false,null);engine.apply(positions(modules,3),false,null);
    const added=engine.snapshot().frames.find(frame=>frame.id==='M-101');assert.equal(added.x,modules.placement.entryDoor.x);assert.equal(added.z,modules.placement.entryDoor.z);
  },
  rest:modules=>{
    const engine=new modules.behaviour.OfficeBehaviour(new modules.navigation.NavigationGrid([
      ...modules.navigation.sharedFootprints,...modules.navigation.workstationFootprints(13)]));
    engine.apply(positions(modules,13),false,'idle');
    for(let i=0;i<750;i++)engine.advance(.04);
    assert.equal(engine.snapshot().frames.filter(frame=>['coffee','sofa','window','meeting'].includes(frame.place)&&
      ['seated','standing'].includes(frame.phase)).length,9);
  },
  twins:modules=>{
    const older=member('M-9900'),newer=member('M-8748');
    const before=modules.characterKit.looksForMembers([older]).get(older.id);
    const after=modules.characterKit.looksForMembers([newer,older]);assert.deepEqual(after.get(older.id),before);
    const signature=look=>`${look.hair}:${look.garment}:${look.family}`;
    assert.notEqual(signature(after.get(newer.id)),signature(before));
  },
  contact:modules=>{assert.equal(modules.footContact.walkFootContact(0)?.side,'L');assert.equal(modules.footContact.walkFootContact(.5)?.side,'R');},
  visibility:async modules=>{
    const room=await gltf('room');room.scene.updateMatrixWorld(true);
    const door=modules.placement.entryDoor;
    for(const height of [1.55,1.72,1.9])assert.equal(new Raycaster(new Vector3(door.x,height,door.z),
      new Vector3(-12,9,13).normalize(),0,8).intersectObject(room.scene,true).length,0);
  },
  idleArrival:modules=>{
    const nav=new modules.navigation.NavigationGrid([...modules.navigation.sharedFootprints,...modules.navigation.workstationFootprints(3)]);
    const engine=new modules.behaviour.OfficeBehaviour(nav),two=positions(modules,2),three=positions(modules,3);
    const added=three.find(person=>!two.some(old=>old.memberId===person.memberId));added.status='idle';added.clip='sit_idle';
    engine.apply(two,false,null);engine.apply(three,false,null);let nearest=Infinity,firstSeat;
    const approach={x:added.x-Math.sin(added.yaw)*.57,z:added.z-Math.cos(added.yaw)*.57};
    for(let tick=0;tick<1500;tick++){
      const previous=engine.snapshot().frames.find(frame=>frame.id===added.memberId);
      if(tick%20===0||(previous.phase==='walking'&&Math.hypot(previous.x-approach.x,previous.z-approach.z)<.35&&
        nav.route(previous,approach).length===0))engine.setNavigation(nav);
      engine.advance(.04);const actor=engine.snapshot().frames.find(frame=>frame.id===added.memberId);
      nearest=Math.min(nearest,Math.hypot(actor.x-modules.placement.entryApron.x,actor.z-modules.placement.entryApron.z));
      if(actor.phase==='seated'){firstSeat=actor;break;}
    }
    assert(nearest<.4);assert.equal(firstSeat?.place,'desk');assert(Math.hypot(firstSeat.x-added.x,firstSeat.z-added.z)<.01);
  },
  freezeDesk:async modules=>{
    const station=modules.workstations.createWorkstation(await gltf('workstation_kit'),member('freeze-test'),0,10);
    modules.workstations.settleWorkstation(station,10.3);const height=station.root.position.y;
    modules.workstations.settleWorkstation(station,12.3,false,true);assert(Math.abs(station.root.position.y-height)<1e-8);
  },
  hiringStream:modules=>{
    const reserved=[13,...Array.from({length:12},(_,index)=>index+1)];
    const grid=count=>{
      const assets=[...new Set([...reserved,...positions(modules,count).map(person=>person.asset)])];
      return new modules.navigation.NavigationGrid([...modules.navigation.sharedFootprints,
        ...modules.navigation.workstationFootprintsForAssets(assets,new Set(assets))]);
    };
    const engine=new modules.behaviour.OfficeBehaviour(grid(3));engine.apply(positions(modules,3),false,null);
    const initial=new Set(positions(modules,3).map(person=>person.memberId)),nearest=new Map();let count=3;
    for(let tick=0;tick<1875;tick++){
      const next=Math.min(14,3+Math.floor(tick*.04/4));
      if(next!==count){count=next;engine.setNavigation(grid(count));engine.apply(positions(modules,count),false,null);}
      engine.advance(.04);
      for(const actor of engine.snapshot().frames)if(!initial.has(actor.id))nearest.set(actor.id,Math.min(nearest.get(actor.id)??Infinity,
        Math.hypot(actor.x-modules.placement.entryApron.x,actor.z-modules.placement.entryApron.z)));
    }
    assert.equal(engine.snapshot().frames.filter(frame=>frame.phase==='seated').length,14);
    assert.equal(nearest.size,11);for(const distance of nearest.values())assert(distance<.4);
  },
  chair:async modules=>assert(modules.workstations.createWorkstation(await gltf('workstation_kit'),member('chair-test'),0,-Infinity).chair),
  blink:async modules=>{
    const m=member('M-0014');m.roleId='planner';
    const look=modules.characterKit.lookForMember(m);
    const assembled=modules.characterKit.assembleCharacter(m,{garments:new Map([[look.garment,await gltf(`kit_${look.garment}`)]]),appearance:await gltf('appearance_kit')});
    let body;assembled.root.traverse(object=>{if(object instanceof SkinnedMesh)body=object;});
    assembled.root.updateMatrixWorld(true);const attribute=body.geometry.getAttribute('position');
    const index=Array.from({length:attribute.count},(_,i)=>i).find(i=>attribute.getY(i)<.3);
    const before=body.getVertexPosition(index,new Vector3());body.morphTargetInfluences[body.morphTargetDictionary.eyeBlink]=1;
    assert(body.getVertexPosition(index,new Vector3()).distanceTo(before)<.00001);
  },
};
const mutations=[
  ['truncate-members','placement.ts',s=>s.replace('members.filter(member => !member.isProducer && !member.deleted);','members.filter(member => !member.isProducer && !member.deleted).slice(0,12);'),'count'],
  ['spawn-at-desk','behaviour.ts',s=>s.replace('arriving?{...entryDoor}:{x:person.x,z:person.z}','arriving?{x:person.x,z:person.z}:{x:person.x,z:person.z}'),'door'],
  ['parallel-chair-exits','behaviour.ts',s=>s.replace(/        if\(state\.phaseTime<=dt[\s\S]*?state\.clip='sit_idle';continue;\n        }\n/,''),'rest'],
  ['allow-twins','characterKit.ts',s=>s.replace('while(used.has(key)&&attempt++<1152)','while(false&&used.has(key)&&attempt++<1152)'),'twins'],
  ['wrong-contact-phase','footContact.ts',s=>s.replace('actionTime+.25','actionTime+0'),'contact'],
  ['hidden-door','placement.ts',s=>s.replace('{x:5.25,z:-3.90}','{x:3,z:-3.90}'),'visibility'],
  ['omit-chair','workstations.ts',s=>s.replace("[variant,'chair',screen","[variant,screen"),'chair'],
  ['absolute-morphs','characterKit.ts',s=>s.replace('merged.morphTargetsRelative=base.morphTargetsRelative;','merged.morphTargetsRelative=false;'),'blink'],
  ['skip-first-desk','behaviour.ts',s=>s.replace(/      if\(state.arriving\)\{[\s\S]*?      }\n/,''),'idleArrival'],
  ['skip-entrance-apron','behaviour.ts',s=>s.replace('return state.entrancePending?[...navigation.route(origin,entryApron),...navigation.route(entryApron,goal)]:navigation.route(origin,goal);','return navigation.route(origin,goal);'),'hiringStream'],
  ['drop-final-approach','behaviour.ts',s=>s.replace('      if(!route.length&&distance(origin,state.pathGoal)<.35)continue;',''),'idleArrival'],
  ['animate-desk-during-freeze','workstations.ts',s=>s.replace('  if(paused&&!station.settled)station.bornAt+=Math.max(0,now-station.lastAt);',''),'freezeDesk'],
  ['block-coffee-aisle','navigation.ts',s=>s.replace('[3.92,-1.20]','[3.92,-1.57]'),'hiringStream'],
];
try{
  const baseline=await compileVariant('baseline','',s=>s);
  for(const check of Object.values(checks))await check(baseline);
  for(const [name,target,mutate,oracle] of mutations){
    const modules=await compileVariant(name,target,mutate);let killed=false,error='';
    try{await checks[oracle](modules);}catch(cause){killed=true;error=String(cause.message);}
    results.push({name,target,oracle,killed,error});console.log(name,killed?'KILLED':'SURVIVED');
  }
  fs.writeFileSync(path.join(out,'mutation-results.json'),JSON.stringify({baseline:`all ${Object.keys(checks).length} oracles passed`,results},null,2));
  assert(results.every(result=>result.killed),'A mutation survived');
}finally{
  for(const filename of files)fs.unlinkSync(filename);
  for(const directory of directories.reverse())fs.rmdirSync(directory);
}
