import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const cases=[
  {name:'furniture path',file:'src/renderer/src/studio3d/navigation.ts',from:'!this.footprints.some(box=>!allowed.has(box)&&segmentCrossesFootprint(a,b,box))',to:'true||!this.footprints.some(box=>!allowed.has(box)&&segmentCrossesFootprint(a,b,box))'},
  {name:'person separation',file:'src/renderer/src/studio3d/behaviour.ts',from:'const blocked=states.some(other=>other!==state&&distance(next,other)<.48);',to:'const blocked=false;'},
  {name:'rest capacity',file:'src/renderer/src/studio3d/placement.ts',from:"x:2.16,z:-1.77,yaw:Math.PI,place:'coffee'",to:"x:2.16,z:-1.77,yaw:Math.PI,place:'sofa'"},
  {name:'rest variety',file:'src/renderer/src/studio3d/behaviour.ts',from:'if(cycle%2===0)return initial;',to:'return initial;'},
  {name:'minimum rest dwell',file:'src/renderer/src/studio3d/behaviour.ts',from:'cycle*45<state.statusAt+15',to:'cycle*45<state.statusAt'},
  {name:'visitor facing',file:'src/renderer/src/studio3d/behaviour.ts',from:'yaw=facing(target,visited);visitId=visitor;',to:'yaw=0;visitId=visitor;'},
  {name:'emergency freeze',file:'src/renderer/src/studio3d/behaviour.ts',from:'if(this.stop) {',to:'if(false) {'},
  {name:'tag collision',file:'src/renderer/src/studio3d/tags.ts',from:'return visible.every(other=>!tagsOverlap(candidate,other));',to:'return true;'},
  {name:'idle segment',file:'src/renderer/src/api/fake/officeDemo.ts',from:"[88, 'idle']",to:"[88, 'busy']"},
  {name:'inherited answer wait',file:'src/renderer/src/api/fake/officeDemo.ts',from:'activatedAt: null, hold: null, conflictFiles: []',to:'activatedAt: null, hold: source.hold, conflictFiles: []'},
];

const results=[];
for(const item of cases){
  const original=readFileSync(item.file,'utf8');
  if(!original.includes(item.from))throw new Error(`${item.name}: mutation target missing`);
  if(original.split(item.from).length!==2)throw new Error(`${item.name}: mutation target is ambiguous`);
  try{
    writeFileSync(item.file,original.replace(item.from,item.to),'utf8');
    const run=spawnSync(process.execPath,['node_modules/vitest/vitest.mjs','run','--config',
      'src/renderer/tools/vitest.config.ts','src/renderer/src/studio3d/behaviour.test.ts'],
      {cwd:process.cwd(),encoding:'utf8',timeout:60000,maxBuffer:1024*1024});
    results.push({name:item.name,detected:run.status!==0,
      summary:(run.stdout??'').split(/\r?\n/).filter(line=>/Tests\s+\d+|Test Files\s+\d+|AssertionError|FAIL /.test(line)).slice(-5)});
  }finally{
    writeFileSync(item.file,original,'utf8');
  }
  console.log(`${item.name}: ${results.at(-1).detected?'caught':'MISSED'}`);
}
writeFileSync('docs/design/v4/phase2b/mutation-results.json',JSON.stringify(results,null,2));
if(results.some(item=>!item.detected))process.exitCode=1;
