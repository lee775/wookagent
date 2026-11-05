import {readFileSync,writeFileSync} from 'node:fs';

const runs=Array.from({length:5},(_,index)=>JSON.parse(readFileSync(
  `docs/design/v4/phase2b/performance-production-${index+1}.json`,'utf8')));
const measure=key=>{const values=runs.map(run=>run[key]).sort((a,b)=>a-b);
  return {median:values[2],min:values[0],max:values.at(-1)};};
const summary={runs:runs.length,viewport:[1440,900],fps:measure('fps'),
  mainThreadBusy:measure('mainThreadBusy'),scriptBusy:measure('scriptBusy'),
  walkClips:runs.map(run=>run.walkClips),movedActors:runs.map(run=>run.movedActors),
  minTravel:Math.min(...runs.map(run=>run.minTravel)),errors:runs.flatMap(run=>run.errors)};
writeFileSync('docs/design/v4/phase2b/performance.json',JSON.stringify(summary,null,2));
console.log(summary);
