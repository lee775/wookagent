// Serial, renderer-only mutations. The caller supplies the required CPU wrapper.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const wrapper=process.env.OFFICE_VITEST_WRAPPER;
assert.ok(wrapper,'Set OFFICE_VITEST_WRAPPER to the approved vitest wrapper');
const root='src/renderer/src/';
const seating='studio/idle-seating.test.ts',names='api/fake/names.test.ts';
const cases=[
  {bug:'2D idle at coffee',file:'studio/motion.ts',from:"place: 'lounge', pose: talking",to:"place: 'coffee', pose: talking",test:seating},
  {bug:'2D shared sofa cushion',file:'studio/motion.ts',from:"point: slotPoint('lounge', rank)",to:"point: slotPoint('lounge', 0)",test:seating},
  {bug:'2D borrowed desk',file:'studio/motion.ts',from:"if (!sofa) return desk(pose, '자리에서 쉬는 중');",to:"if (!sofa) return {...desk(pose, '자리에서 쉬는 중'), point: stations[(index+1)%stations.length]};",test:seating},
  {bug:'2D standing idle pose',file:'studio/motion.ts',from:"pose: talking ? 'chat' : pose",to:"pose: 'window'",test:seating},
  {bug:'3D idle at coffee',file:'studio3d/behaviour.ts',from:'place=slot.place;target={x:slot.x,z:slot.z};yaw=slot.yaw;',to:"place='coffee';target={x:2.16,z:-1.77};yaw=slot.yaw;",test:seating},
  {bug:'3D shared sofa cushion',file:'studio3d/placement.ts',from:'restSlots[index]??homeForAsset(asset)',to:'restSlots[index===1?0:index]??homeForAsset(asset)',test:seating},
  {bug:'3D borrowed desk',file:'studio3d/placement.ts',from:'restSlots[index]??homeForAsset(asset)',to:'restSlots[index]??homeForAsset(asset+1)',test:seating},
  {bug:'3D standing idle clip',file:'studio3d/behaviour.ts',from:"clip=idleClip(person.asset,this.time,place==='sofa');",to:"clip='stand_idle';",test:seating},
  {bug:'3D initial placement at coffee',file:'studio3d/placement.ts',from:'slot = idleSeat(asset);',to:"slot = {x:2.16,z:-1.77,yaw:Math.PI,place:'coffee'};",test:seating},
  {bug:'department names duplicated',file:'api/fake/departments.ts',from:'demoName(1+index*12+rank)',to:'demoName(1+rank)',test:names},
  {bug:'AI role and number display name',file:'api/fake/officeDemo.ts',from:'name:demoName(serial)',to:'name:`코덱스 개발${serial}`',test:names},
  {bug:'rejected reference name',file:'api/fake/names.ts',from:"'서진'",to:"'하루'",test:names},
];
const run=test=>spawnSync('bash',[wrapper,'run','--config','src/renderer/tools/vitest.config.ts',root+test],
  {encoding:'utf8',windowsHide:true,timeout:120000,maxBuffer:3000000});
for(const test of [seating,names]){
  const baseline=run(test);assert.equal(baseline.status,0,baseline.stdout+baseline.stderr);
}
for(const item of cases){const original=readFileSync(root+item.file,'utf8');assert.equal(original.split(item.from).length,2,`Unique anchor: ${item.bug}`);}
const results=[];
for(const item of cases){
  const file=root+item.file,original=readFileSync(file,'utf8');
  try{
    writeFileSync(file,original.replace(item.from,item.to),'utf8');
    const result=run(item.test),output=result.stdout+result.stderr;
    const caught=result.status!==0&&output.includes('AssertionError');
    results.push({bug:item.bug,caught,exit:result.status,evidence:output.split(/\r?\n/).find(line=>line.includes('AssertionError'))??'No assertion failure'});
    console.log(`${item.bug}: ${caught?'caught':'MISSED'}`);
    if(!caught)console.log(output.slice(-1500));
  }finally{writeFileSync(file,original,'utf8');}
}
writeFileSync('docs/design/permission-ui/office-departments/idle-mutation-results.json',JSON.stringify(results,null,2)+'\n','utf8');
assert.ok(results.every(result=>result.caught),'An idle seating or identity mutant survived');
