import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const cases = [
  { name: 'reversed furniture depth', file: 'src/renderer/src/studio/motion.ts',
    from: 'baseY(a) - baseY(b)', to: 'baseY(b) - baseY(a)', test: 'paints heads after shallower furniture' },
  { name: 'near-row sleeves held still', file: 'src/renderer/src/studio/motion.ts',
    from: "const amplitude = pose === 'type' ? 52 : 50;", to: 'const amplitude = 0;', test: 'paints heads after shallower furniture' },
  { name: 'rest slot on walking lane', file: 'src/renderer/src/studio/motion.ts',
    from: '{ x: 470, y: 170 }', to: '{ x: 470, y: 240 }', test: 'keeps every resting and visit point' },
  { name: 'routes never reach their target', file: 'src/renderer/src/studio/motion.ts',
    from: 'const route = routes[0] ?? [];', to: 'const route = [];', test: 'bounds route lengths' },
  { name: 'far seat bypass flattened onto the lane', file: 'src/renderer/src/studio/motion.ts',
    from: '{ x: entryX, y: 225 }, { x: exitX, y: 225 }', to: '{ x: entryX, y: 240 }, { x: exitX, y: 240 }',
    test: 'bounds route lengths' },
  { name: 'one shirt colour for everyone', file: 'src/renderer/src/studio/characters.ts',
    from: "shirt: shirts[trait('shirt') % shirts.length]", to: 'shirt: shirts[0]', test: 'keeps appearance collisions' },
  { name: 'rest places shuffle each five seconds', file: 'src/renderer/src/studio/motion.ts',
    from: ': slotPoint(place, rank);', to: ': slotPoint(place, (rank + Math.floor(seconds / 5)) % placeCapacity(place));', test: 'keeps a resting member in one slot' },
  { name: 'route ignores occupied rest slots', file: 'src/renderer/src/studio/motion.ts',
    from: 'segmentDistance(slot, a, b) < 45', to: 'segmentDistance(slot, a, b) < 0', test: 'keeps a twelve-person idle office clear' },
  { name: 'napper trapped between reserved sofa slots', file: 'src/renderer/src/studio/motion.ts',
    from: 'Math.hypot(from.x - napCentre.x, from.y - napCentre.y) < 2 || ', to: '', test: 'bounds route lengths' },
  { name: 'nap sits in only one sofa place', file: 'src/renderer/src/studio/motion.ts',
    from: '? { x: (placeSlots.lounge[0].x + placeSlots.lounge[1].x) / 2, y: placeSlots.lounge[0].y }',
    to: '? placeSlots.lounge[0]', test: 'keeps a resting member in one slot' },
  { name: 'walking legs held still', file: 'src/renderer/src/studio/motion.ts',
    from: 'const ramp = emergency || reduced || walking ? 1', to: 'const ramp = emergency || reduced ? 1', test: 'renders a first walking step' },
  { name: 'far desk legs always visible', file: 'src/renderer/src/studio/motion.ts',
    from: "const farLegsHidden = seat.side === 'far' && farDistance <= 68 && Math.abs(point.y - seat.y) <= 35;",
    to: 'const farLegsHidden = false;', test: 'renders a first walking step' },
  { name: 'desk work rendered in the aisle', file: 'src/renderer/src/studio/motion.ts',
    from: "!atDestination || deskWorkAway ? 'stand'", to: "!atDestination || deskWorkAway ? behaviour.pose", test: 'renders a first walking step' },
  { name: 'member plates hidden', file: 'src/renderer/src/studio/motion.ts',
    from: 'visible: true, placement:', to: 'visible: false, placement:', test: 'plays a complete hand-off' },
  { name: 'floor plate assigned to seated colleague', file: 'src/renderer/src/studio/motion.ts',
    from: 'top: point.y - 100, bottom: point.y + 10', to: 'top: point.y - 100, bottom: point.y - 30',
    test: 'places a floor plate clear' },
  { name: 'sofa departure skips rising', file: 'src/renderer/src/studio/motion.ts',
    from: "const atSeat = actor.phase === 'seated' || stations.some", to: 'const atSeat = stations.some',
    test: 'rises from the sofa' },
  { name: 'review demo cut to three seconds', file: 'src/renderer/src/api/fake/officeDemo.ts',
    from: "[13, 'assignment'], [36, 'review']", to: "[13, 'assignment'], [16, 'review']", test: 'plays a complete hand-off' },
  { name: 'reviewer leaves five seconds too early', file: 'src/renderer/src/studio/motion.ts',
    from: 'if (submitter && phase >= 5 && phase < 15)', to: 'if (submitter && phase >= 0 && phase < 15)', test: 'plays a complete hand-off' },
  { name: 'emergency release leaves together', file: 'src/renderer/src/studio/motion.ts',
    from: 'rank * 375', to: 'rank * 0', test: 'plays a complete hand-off' },
  { name: 'seated member rises into a frozen walker', file: 'src/renderer/src/studio/motion.ts',
    from: 'laneFirst(a.point) - laneFirst(b.point) ||', to: 'laneFirst(b.point) - laneFirst(a.point) ||',
    test: 'releases a walker on the lane' },
];
const results = [];
for (const item of cases) {
  const original = readFileSync(item.file, 'utf8');
  if (!original.includes(item.from) || original.indexOf(item.from) !== original.lastIndexOf(item.from))
    throw new Error(`Mutation anchor missing or repeated: ${item.name}`);
  let processResult;
  try {
    writeFileSync(item.file, original.replace(item.from, item.to));
    processResult = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config',
      'src/renderer/tools/vitest.config.ts', 'src/renderer/src/studio/motion.v33.test.ts', '--testNamePattern', item.test],
      { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
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
