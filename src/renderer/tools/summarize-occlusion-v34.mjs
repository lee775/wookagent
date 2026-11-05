import { readFileSync, writeFileSync } from 'node:fs';

const files = ['occlusion-busy-1440.json', 'occlusion-cycle-1440.json', 'occlusion-busy-1100.json', 'occlusion-cycle-1100.json'];
const far = new Set(['다온', '서윤', '루카', '하린', '지오', '나래']);
const summaries = files.map(file => {
  const data = JSON.parse(readFileSync(`docs/design/v34/${file}`, 'utf8'));
  const farTorso = [], nearHead = [], nearChairTorso = [];
  const otherCovers = [];
  for (const row of data.rows) for (const actor of row.actors) {
    if (row.emergency) continue;
    if (actor.seated !== 'true') continue;
    const isFar = far.has(actor.name);
    const part = actor.parts[isFar ? 'rig-body' : 'rig-head'];
    if (!part?.own) continue;
    const own = part.own;
    const cover = Object.values(part.covers).reduce((sum, value) => sum + value, 0);
    (isFar ? farTorso : nearHead).push(1 - cover / own);
    if (!isFar) nearChairTorso.push(Object.entries(actor.parts['rig-body']?.covers ?? {})
      .filter(([kind]) => kind.startsWith('nearChair:')).reduce((sum, [, value]) => sum + value, 0));
    const allowed = isFar ? `farDesk:${String([150,300,500,650,850,1000].indexOf(actor.origin?.[0] + 40) + 1).padStart(2,'0')}` : `nearChair:${actor.origin?.[0] + 40}`;
    const unexpected = Object.entries(part.covers).filter(([kind]) => kind !== allowed);
    if (unexpected.length) otherCovers.push({ t: row.t, name: actor.name, unexpected });
  }
  return { file, samples: data.rows.length, farSeated: farTorso.length, nearSeated: nearHead.length,
    minFarTorsoVisible: Math.min(...farTorso), meanFarTorsoVisible: farTorso.reduce((a,b) => a+b,0) / farTorso.length,
    minNearHeadVisible: Math.min(...nearHead), meanNearHeadVisible: nearHead.reduce((a,b) => a+b,0) / nearHead.length,
    nearChairTorsoOverlapSamples: nearChairTorso.filter(value => value > 0).length,
    unexpectedCovers: otherCovers.slice(0, 20) };
});
writeFileSync('docs/design/v34/occlusion-summary.json', JSON.stringify(summaries, null, 2));
console.log(JSON.stringify(summaries));
if (summaries.some(item => item.minFarTorsoVisible < .6 || item.minNearHeadVisible < .9 ||
  item.nearChairTorsoOverlapSamples !== item.nearSeated || item.unexpectedCovers.length)) process.exitCode = 1;
