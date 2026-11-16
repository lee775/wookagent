import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const vt=process.env.OFFICE_VITEST_WRAPPER;

if(process.argv.includes('--departments')){
  await import('./mutation-office-departments.mjs');
  process.exit();
}
if(process.argv.includes('--idle-seating')){
  await import('./mutation-idle-seating.mjs');
  process.exit();
}
if(!vt)throw new Error('Set OFFICE_VITEST_WRAPPER to the approved vitest wrapper');

const cases = [
  { name: 'reversed furniture depth', file: 'src/renderer/src/studio/motion.ts',
    from: 'baseY(a) - baseY(b)', to: 'baseY(b) - baseY(a)', test: 'paints heads after shallower furniture' },
  { name: 'near-row sleeve held still', file: 'src/renderer/src/studio/motion.ts',
    from: 'const left = Math.round(Math.sin((time + index * 137) * Math.PI * 2 / 710) * 13 * pulse);', to: 'const left = 0;', test: 'paints heads after shallower furniture' },
  { name: 'rest slot on walking lane', file: 'src/renderer/src/studio/motion.ts',
    from: '{ x: 470, y: 150 }', to: '{ x: 470, y: 195 }', test: 'keeps every resting and visit point' },
  { name: 'routes never reach their target', file: 'src/renderer/src/studio/motion.ts',
    from: 'const route = routes[0] ?? [];', to: 'const route = [];', test: 'bounds route lengths' },
  { name: 'far seat bypass flattened onto the lane', file: 'src/renderer/src/studio/motion.ts',
    from: 'const exits = farGaps.map(x => ({ x, y: origin.y }))', to: 'const exits = farGaps.map(x => ({ x, y: 195 }))',
    test: 'bounds route lengths' },
  { name: 'one shirt colour for everyone', file: 'src/renderer/src/studio/characters.ts',
    from: "shirt: shirts[trait('shirt') % shirts.length]", to: 'shirt: shirts[0]', test: 'keeps appearance collisions' },
  { name: 'rest places shuffle each five seconds', file: 'src/renderer/src/studio/motion.ts',
    from: "point: slotPoint('lounge', rank)", to: "point: slotPoint('lounge', rank + Math.floor(seconds / 5))", test: 'keeps a resting member in one slot' },
  { name: 'route ignores occupied rest slots', file: 'src/renderer/src/studio/motion.ts',
    from: 'segmentDistance(slot, a, b) < 35', to: 'segmentDistance(slot, a, b) < 0', test: 'routes around colleagues resting' },
  { name: 'napper trapped between reserved sofa slots', file: 'src/renderer/src/studio/motion.ts',
    from: 'const board = { x: 370, y: 205 };', to: 'if (Math.hypot(from.x - (placeSlots.lounge[0].x + placeSlots.lounge[1].x) / 2, from.y - placeSlots.lounge[0].y) < 2) return [];\n  const board = { x: 370, y: 205 };', test: 'bounds route lengths' },
  { name: 'resting colleagues share one sofa cushion', file: 'src/renderer/src/studio/motion.ts',
    from: "point: slotPoint('lounge', rank)", to: "point: slotPoint('lounge', 0)", test: 'keeps a resting member in one slot' },
  { name: 'walking legs held still', file: 'src/renderer/src/studio/motion.ts',
    from: 'const ramp = emergency || reduced || walking ? 1', to: 'const ramp = emergency || reduced ? 1', test: 'renders a first walking step' },
  { name: 'far desk legs always visible', file: 'src/renderer/src/studio/motion.ts',
    from: "const farLegsHidden = seat.side === 'far' && farDistance <= 43 && point.y >= seat.y - 35 && point.y <= 309;",
    to: 'const farLegsHidden = false;', test: 'renders a first walking step' },
  { name: 'desk work rendered in the aisle', file: 'src/renderer/src/studio/motion.ts',
    from: "!atDestination || deskWorkAway ? 'stand'", to: "!atDestination || deskWorkAway ? behaviour.pose", test: 'renders a first walking step' },
  { name: 'member plates hidden', file: 'src/renderer/src/studio/motion.ts',
    from: 'visible: hiddenArea < width * height * .5, placement:', to: 'visible: false, placement:', test: 'plays a complete hand-off' },
  { name: 'floor plate assigned to seated colleague', file: 'src/renderer/src/studio/motion.ts',
    from: 'top: point.y - 100, bottom: point.y + 10', to: 'top: point.y - 100, bottom: point.y - 30',
    test: 'places a floor plate clear' },
  { name: 'sofa departure skips rising', file: 'src/renderer/src/studio/motion.ts',
    from: "const atSeat = actor.phase === 'seated' || stations.some", to: 'const atSeat = stations.some',
    test: 'rises from the sofa' },
  { name: 'review demo cut to three seconds', file: 'src/renderer/src/studio/officeDemoStep.ts',
    from: "[11, 'assignment'], [30, 'review']", to: "[11, 'assignment'], [14, 'review']", test: 'plays a complete hand-off' },
  { name: 'reviewer leaves five seconds too early', file: 'src/renderer/src/studio/motion.ts',
    from: 'if (submitter && phase >= 5 && phase < 15)', to: 'if (submitter && phase >= 0 && phase < 15)', test: 'plays a complete hand-off' },
  { name: 'emergency release leaves together', file: 'src/renderer/src/studio/motion.ts',
    from: 'rank * 375', to: 'rank * 0', test: 'releases a walker on the lane' },
  { name: 'seated member rises into a frozen walker', file: 'src/renderer/src/studio/motion.ts',
    from: 'laneFirst(a.point) - laneFirst(b.point) ||', to: 'laneFirst(b.point) - laneFirst(a.point) ||',
    test: 'releases a walker on the lane' },
];
const results = [];
for (const item of cases) {
  const original = readFileSync(item.file, 'utf8');
  if (!original.includes(item.from) || original.indexOf(item.from) !== original.lastIndexOf(item.from))
    throw new Error(`Mutation anchor missing or repeated: ${item.name}`);
}
for (const item of cases) {
  const original = readFileSync(item.file, 'utf8');
  let processResult;
  try {
    writeFileSync(item.file, original.replace(item.from, item.to));
    processResult = spawnSync('bash', [vt, 'run', '--config',
      'src/renderer/tools/vitest.config.ts', 'src/renderer/src/studio/motion.v33.test.ts', '--testNamePattern', item.test],
      { encoding: 'utf8', timeout: 1200000, maxBuffer: 1024 * 1024, windowsHide:true });
  } finally {
    writeFileSync(item.file, original);
  }
  const output = `${processResult?.stdout ?? ''}\n${processResult?.stderr ?? ''}`;
  results.push({ bug: item.name, test: item.test, rejected: processResult?.status !== 0,
    assertion: output.match(/AssertionError:[^\r\n]*/)?.[0] ?? null });
}
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(results, null, 2));
console.log(JSON.stringify(results.map(({ bug, rejected }) => ({ bug, rejected }))));
if (results.some(result => !result.rejected || !result.assertion)) process.exitCode = 1;
