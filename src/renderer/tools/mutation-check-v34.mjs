import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const office = 'src/renderer/src/studio/Office.tsx';
const motion = 'src/renderer/src/studio/motion.ts';
const characters = 'src/renderer/src/studio/characters.ts';
const demo = 'src/renderer/src/api/fake/officeDemo.ts';
const test = (file, name) => [
  'node_modules/vitest/vitest.mjs', 'run', '--config', 'src/renderer/tools/vitest.config.ts', file, '-t', name,
];
const cases = [
  { name: 'far chair key 308', file: office, before: "seat.y - 10 : seat.y + 26", after: "seat.y + 26 : seat.y + 26",
    command: test('src/renderer/src/studio/paintOrder.v34.test.ts', 'far seat') },
  { name: 'near desk key 472', file: office, before: "seat.side === 'far' ? 62 : 42", after: "seat.side === 'far' ? 62 : 62",
    command: test('src/renderer/src/studio/paintOrder.v34.test.ts', 'near seat') },
  { name: 'walking key follows feet through desks', file: office, before: 'Math.max(feetY, 525)', after: 'feetY',
    command: test('src/renderer/src/studio/paintOrder.v34.test.ts', 'complete aisle crossing') },
  { name: 'rise to walk 37 u jump', file: motion, before: "actor.phase === 'rising' ? offset * (1 - progress)",
    after: "actor.phase === 'rising' ? offset", command: test('src/renderer/src/studio/cycle.v34.test.ts', 'moves rig height') },
  { name: 'far lane y 240', file: motion,
    mutate: source => source.replace(': 195;', ': 240;').replace('[195, 525, 575, 585]', '[240, 525, 575, 585]'),
    command: test('src/renderer/src/studio/screenRoutes.v34.test.ts', 'keeps walking feet') },
  { name: 'connector 575 through a solid middle screen', file: office,
    before: '[440, 540], [610, 705]', after: '[440, 705]',
    command: test('src/renderer/src/studio/screenRoutes.v34.test.ts', 'completes every seat') },
  { name: 'report aisle detour removed', file: motion, before: 'const board = { x: 370, y: 205 };', after: 'const board = { x: 400, y: 205 };',
    command: test('src/renderer/src/studio/screenRoutes.v34.test.ts', 'report trip below') },
  { name: 'pose based plate text', file: motion, before: 'export function plateStateFor(behaviour: Behaviour): string {',
    after: 'export function plateStateFor(behaviour: Behaviour): string {\n  return plateStates[behaviour.pose];',
    command: test('src/renderer/src/studio/plateStates.v34.test.ts', 'state plates') },
  { name: '5 s report step', file: demo, before: "[47, 'report']", after: "[39, 'report']",
    command: test('src/renderer/src/studio/cycle.v34.test.ts', 'replays stamped events') },
  { name: 'report walk falls short at default speed', file: motion,
    before: "target.place === 'inbox' ? 112 : WALK_SPEED", after: 'WALK_SPEED',
    command: test('src/renderer/src/studio/cycle.v34.test.ts', 'replays stamped events') },
  { name: 'constant plate visibility', file: motion, before: 'visible: hiddenArea < width * height * .5', after: 'visible: true',
    command: test('src/renderer/src/studio/motion.v33.test.ts', 'geometrically covered plate') },
  { name: 'first walking draw uses 150 ms', file: motion, before: "actor.phase === 'walking' ? dt : Math.min(dt, .05)", after: 'dt',
    command: test('src/renderer/src/studio/motion.v33.test.ts', 'first walking draw') },
  { name: 'window rest faces the room', file: motion,
    before: "if (place === 'window' && phase === 'standing' && point.y <= 175) return 'back';",
    after: "if (place === 'window' && phase === 'standing' && point.y <= 175) return 'front';",
    command: test('src/renderer/src/studio/motion.v33.test.ts', 'faces the window') },
  { name: 'four identical hair silhouettes', file: characters,
    before: 'neighbours.filter(other => other.hairStyle === candidate.hairStyle).length < 3',
    after: 'neighbours.filter(other => other.hairStyle === candidate.hairStyle).length < 12',
    command: test('src/renderer/src/studio/motion.v33.test.ts', 'appearance collisions') },
];

function run(command) {
  const result = spawnSync(process.execPath, command, { encoding: 'utf8', cwd: process.cwd(), timeout: 60000 });
  return { code: result.status, output: `${result.stdout ?? ''}\n${result.stderr ?? ''}` };
}
const results = [];
for (const entry of cases) {
  const original = readFileSync(entry.file);
  const source = original.toString('utf8');
  const baseline = run(entry.command);
  let mutant = source;
  try {
    mutant = entry.mutate ? entry.mutate(source) : source.replace(entry.before, entry.after);
    if (mutant === source) throw new Error('Mutation anchor was not found');
    writeFileSync(entry.file, mutant, 'utf8');
    const changed = run(entry.command);
    results.push({ mutation: entry.name, test: `${entry.command[4]} · ${entry.command[6]}`,
      baselinePassed: baseline.code === 0, caught: baseline.code === 0 && changed.code !== 0,
      failure: changed.output.split('\n').find(line => line.includes('FAIL'))?.trim() ?? null });
  } catch (error) {
    results.push({ mutation: entry.name, test: `${entry.command[4]} · ${entry.command[6]}`,
      baselinePassed: baseline.code === 0, caught: false, error: String(error) });
  } finally { writeFileSync(entry.file, original); }
}
writeFileSync('docs/design/v34/mutation-check.json', JSON.stringify(results, null, 2));
console.log(JSON.stringify(results));
if (results.some(item => !item.caught)) process.exitCode = 1;
