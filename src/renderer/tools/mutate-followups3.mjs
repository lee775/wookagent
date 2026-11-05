import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const file = resolve('src/renderer/src/screens/Home.tsx');
const output = resolve('docs/design/permission-ui/followups3');
const temp = resolve('src/renderer/.followups3-test-temp');
mkdirSync(output, { recursive: true });
mkdirSync(temp, { recursive: true });
const mutants = [
  { item: 1, test: 'S3-1.', before: "todo.kind === 'emergency_held' && todo.reachesMain === false", after: 'false', bug: 'false인 긴급 보류에도 메인이 확인하고 재개한다고 표시함' },
  { item: 1, test: 'S3-1.', before: "'긴급 정지로 보류된 작업에 대해: '", after: "'이 보류 항목에 대해: '", bug: '긴급 보류 명령 초안을 일반 보류 문구로 되돌림' },
  { item: 1, test: 'S3-1.', before: "todo.kind === 'emergency_held' && todo.reachesMain === false", after: "todo.kind === 'emergency_held' && todo.reachesMain !== true", bug: '필드가 없는 이전 서버를 전달 실패로 표시함' },
  { item: 2, test: 'S3-2.', before: "todo.reachesMain ?? todo.message.includes('검수자 없음 —')", after: "todo.reachesMain || todo.message.includes('검수자 없음 —')", bug: '검수자 없음 문구가 명시적인 false를 덮음' },
];
const original = readFileSync(file);
const source = original.toString('utf8');
const results = [];
for (const mutant of mutants) {
  if (source.split(mutant.before).length !== 2) throw new Error(`Mutation anchor must occur once: ${mutant.bug}`);
  try {
    writeFileSync(file, source.replace(mutant.before, mutant.after));
    const run = spawnSync(process.execPath, [resolve('node_modules/vitest/vitest.mjs'), 'run', '--config',
      'src/renderer/tools/vitest.config.ts', 'src/renderer/src/components/permission-ui.test.ts', '-t', mutant.test], {
      encoding: 'utf8', timeout: 60000, windowsHide: true,
      env: { ...process.env, TMP: temp, TEMP: temp, NODE_DISABLE_COMPILE_CACHE: '1' },
    });
    const text = `${run.stdout ?? ''}\n${run.stderr ?? ''}`.replace(/\x1b\[[0-9;]*m/g, '');
    const killed = run.status !== 0 && /AssertionError/.test(text) && /Tests\s+.*failed/.test(text);
    results.push({ item: mutant.item, test: mutant.test, bug: mutant.bug, exitCode: run.status, killed,
      evidence: text.split('\n').filter(line => /FAIL|AssertionError|Tests\s+|Test Files\s+/.test(line)).slice(0, 6) });
    console.log(`item ${mutant.item} ${mutant.test}: ${killed ? 'KILLED' : 'SURVIVED / ERROR'}`);
  } finally {
    writeFileSync(file, original);
    if (!readFileSync(file).equals(original)) throw new Error('Home.tsx restoration failed');
  }
}
writeFileSync(resolve(output, 'mutation-results.json'), JSON.stringify({ sourceRestored: readFileSync(file).equals(original), results }, null, 2) + '\n');
if (results.some(result => !result.killed)) process.exitCode = 1;
