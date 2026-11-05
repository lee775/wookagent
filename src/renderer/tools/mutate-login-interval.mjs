import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const file = resolve('src/renderer/src/components/ServerLogin.tsx');
const original = readFileSync(file);
const source = original.toString('utf8');
const renderer = resolve('src/renderer');
const temp = mkdtempSync(resolve(renderer, '.interval-mutations-'));
const mutants = [
  {
    bug: 'pending 응답의 intervalSec를 무시함', test: 'S3-login-interval\\.',
    before: '            intervalSec = result.intervalSec;', after: '            intervalSec = start.intervalSec;',
  },
  {
    bug: '바뀐 간격을 한 번만 쓰고 다음 요청에서 시작 간격으로 되돌림', test: 'S3-login-interval\\.',
    before: '    const poll = async () => {', after: '    const poll = async () => {\n      intervalSec = start.intervalSec;',
  },
  {
    bug: '1초 미만과 60초 초과 값을 받아들임', test: 'S3-login-interval-range\\. ignores (0\\.5|61) and',
    before: 'result.intervalSec !== undefined && result.intervalSec >= 1 && result.intervalSec <= 60',
    after: 'result.intervalSec !== undefined',
  },
];
const results = [];
try {
  for (const mutant of mutants) {
    if (source.split(mutant.before).length !== 2) throw new Error(`Expected one anchor: ${mutant.bug}`);
    try {
      writeFileSync(file, source.replace(mutant.before, mutant.after));
      const run = spawnSync(process.execPath, [resolve('node_modules/vitest/vitest.mjs'), 'run', '--config',
        'src/renderer/tools/vitest.config.ts', 'src/renderer/src/components/stage3-login.test.ts', '-t', mutant.test], {
        encoding: 'utf8', timeout: 60000, windowsHide: true,
        env: { ...process.env, TMP: temp, TEMP: temp, NODE_DISABLE_COMPILE_CACHE: '1' },
      });
      const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`.replace(/\x1b\[[0-9;]*m/g, '');
      const killed = run.status === 1 && /AssertionError/.test(output) && /Tests\s+.*failed/.test(output);
      results.push({ ...mutant, exitCode: run.status, killed,
        evidence: output.split('\n').filter(line => /FAIL|AssertionError|Tests\s+|Test Files\s+/.test(line)) });
      console.log(`${mutant.bug}: ${killed ? 'KILLED' : 'SURVIVED / ERROR'}`);
    } finally {
      writeFileSync(file, original);
      if (!readFileSync(file).equals(original)) throw new Error('Source restoration failed');
    }
  }
  writeFileSync(resolve('docs/design/permission-ui/stage3-login/interval-mutation-results.json'),
    JSON.stringify({ sourceRestored: true, results }, null, 2) + '\n');
  if (results.some(result => !result.killed)) process.exitCode = 1;
} finally {
  if (dirname(temp) !== renderer) throw new Error(`Unsafe cleanup path: ${temp}`);
  rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
