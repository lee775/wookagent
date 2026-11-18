// Serial renderer mutations. Run under the caller's CPU wrapper.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const wrapper = process.env.OFFICE_VITEST_WRAPPER;
assert.ok(wrapper, 'Set OFFICE_VITEST_WRAPPER to the approved vitest wrapper');
const root = 'src/renderer/src/';
const tests = ['components/always-office.test.ts', 'studio/idle-seating.test.ts'];
const run = () => spawnSync('bash', [wrapper, 'run', '--config', 'src/renderer/tools/vitest.config.ts', ...tests.map(test => root + test)],
  { encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 3000000 });
const cases = [
  ['zero projects hide office', 'components/CompanyOffice.tsx', '<section className="company-live-office"', '{snapshot.projects.length > 0 && <section className="company-live-office"'],
  ['main person omitted', 'components/CompanyOffice.tsx', 'members={holder && main ? [main] : []}', 'members={[]}'],
  ['vacant seat has phantom person', 'components/CompanyOffice.tsx', 'members={holder && main ? [main] : []}', 'members={main ? [main] : []}'],
  ['vacant explanation removed', 'components/CompanyOffice.tsx', '메인 자리가 비어 있습니다. 사무실은 언제든 볼 수 있습니다.', '사무실에서 쉬어 가세요.'],
  ['main member detail disconnected', 'components/CompanyOffice.tsx', 'onMember={openMember}', 'onMember={() => undefined}'],
  ['company bypasses the shared 3D renderer', 'components/CompanyOffice.tsx', "import { OfficeScene } from './OfficeScene';", "import { Office as OfficeScene } from '../studio/Office';"],
  ['department bypasses the shared 3D renderer', 'screens/Studio.tsx', "import { OfficeScene } from '../components/OfficeScene';", "import { Office as OfficeScene } from '../studio/Office';", 'idle'],
  ['company fallback prebuilds twelve desks', 'components/CompanyOffice.tsx', 'desksForMembersOnly seat=', 'seat='],
  ['company fallback leaves empty partitions', 'studio/Office.tsx', 'partitionCount={desksForMembersOnly ? visible.length : 6}', 'partitionCount={6}'],
  ['3D company main goes to the sofa', 'studio3d/placement.ts', 'isMain?homeForAsset(asset):', ''],
  ['3D main has no personal workstation', 'studio3d/Studio3D.tsx', 'if(!stations.has(member.id)){', 'if(!member.isMain&&!stations.has(member.id)){', 'company'],
  ['3D main has no generated character', 'studio3d/Studio3D.tsx', 'if(!actorById.has(member.id)&&!pendingArrivals.has(member.id)){', 'if(!member.isMain&&!actorById.has(member.id)&&!pendingArrivals.has(member.id)){', 'company'],
  ['shared selection always falls back to 2D', 'components/OfficeScene.tsx', 'return useStudio3D()', 'return false'],
  ['shared selection ignores unavailable WebGL2', 'lib/useStudio3D.ts', 'return webgl2Available;', 'return true;'],
  ['shared selection ignores narrow web layout', 'lib/useStudio3D.ts', 'if (runtime().web &&', 'if (false && runtime().web &&'],
  ['shared selection applies web fallback on desktop', 'lib/useStudio3D.ts', 'if (runtime().web &&', 'if ('],
  ['shared selection ignores the 2D query switch', 'lib/useStudio3D.ts', ".get('studio3d') === '0'", ".get('studio3d') === 'never'"],
  ['hidden page mounts scene', 'components/OfficeViewport.tsx', 'visible && inView && !suspended', 'inView && !suspended'],
  ['portrait opens second scene', 'components/OfficeViewport.tsx', 'visible && inView && !suspended', 'visible && inView'],
  ['company ignores member detail suspension', 'components/CompanyOffice.tsx', 'suspended={officeSuspended}', 'suspended={false}'],
  ['offscreen office mounts scene', 'components/OfficeViewport.tsx', 'visible && inView && !suspended', 'visible && !suspended', 'company'],
  ['main stands after forty seconds', 'studio/motion.ts', "const sofa = !member.isProducer", "if (member.isMain && seconds >= 40) return {key:'stand',place:'window',pose:'window',point:{x:370,y:205},label:'대기'};\n  const sofa = !member.isProducer"],
  ['idle staff wander after forty seconds', 'studio/motion.ts', "const sofa = !member.isProducer", "if (seconds >= 40) return {key:'stand',place:'window',pose:'window',point:{x:370,y:205},label:'대기'};\n  const sofa = !member.isProducer"],
  ['3D idle office keeps animating', 'lib/officeRendering.ts', "members.every(member => member.status === 'idle')", 'false'],
  ['3D reduced motion keeps animating', 'lib/officeRendering.ts', 'return reduced || emergency ||', 'return emergency ||'],
  ['3D emergency keeps animating', 'lib/officeRendering.ts', 'return reduced || emergency ||', 'return reduced ||'],
  ['external main uses stale AI details', 'lib/officePeople.ts', "holder?.kind === 'external'", 'false'],
  ['3D renderer ignores the still policy', 'studio3d/Studio3D.tsx', 'if(officeIsStill(input.members,input.emergency,reduced.matches)&&!settling)', 'if(false)', 'idle'],
  ['2D fallback ignores the still policy', 'studio/Office.tsx', 'if (officeIsStill(data.current.visible, data.current.emergency, reduced)', 'if (false && officeIsStill(data.current.visible, data.current.emergency, reduced)', 'fallback'],
  ['3D external main uses stale seat details', 'studio3d/Studio3D.tsx', 'seat:committedInput.current.seat', 'seat:undefined', 'external'],
];
// Close the conditional after the complete section for the reachability mutant.
const mutate = (source, item) => {
  source = source.replaceAll('\r\n', '\n');
  const [, , from, to] = item;
  assert.equal(source.split(from).length, 2, `Unique mutation anchor: ${item[0]}`);
  const changed = source.replace(from, to);
  return item[0] === 'zero projects hide office' ? changed.replace('    </section>\n    <div className="company-heading"', '    </section>}\n    <div className="company-heading"') : changed;
};
const baseline = run();
assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr);
const browserCheck = (probe = 'idle') => spawnSync('node', ['src/renderer/tools/check-always-office.mjs', `--probe=${probe}`],
  { encoding: 'utf8', windowsHide: true, timeout: 180000, maxBuffer: 3000000 });
for (const probe of new Set(cases.flatMap(item => item[4] ? [item[4]] : []))) {
  const browserBaseline = browserCheck(probe);
  assert.equal(browserBaseline.status, 0, browserBaseline.stdout + browserBaseline.stderr);
  console.log(`${probe} browser baseline: passed`);
}
const results = [];
for (const item of cases) {
  const path = root + item[1], original = readFileSync(path, 'utf8');
  try {
    writeFileSync(path, mutate(original, item));
    const result = item[4] ? browserCheck(item[4]) : run(), output = result.stdout + result.stderr;
    const caught = result.status !== 0 && output.includes('AssertionError');
    results.push({ bug: item[0], caught, exit: result.status, evidence: output.split(/\r?\n/).find(line => line.includes('AssertionError')) ?? 'No assertion failure' });
    console.log(`${item[0]}: ${caught ? 'caught' : 'MISSED'}`);
    if (!caught) console.log(output.slice(-1800));
  } finally { writeFileSync(path, original); }
}
writeFileSync('docs/design/permission-ui/always-office/mutation-results.json', JSON.stringify(results, null, 2) + '\n');
assert.ok(results.every(result => result.caught), 'An always-available office mutant survived');
