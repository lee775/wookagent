import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const suite = 'src/renderer/src/components/permission-ui.test.ts';
const mutants = [
  { file: 'lib/installationSettings.ts', test: '8. operations are views', before: 'general: {', after: 'general: { mainAgent: settings.general.mainAgent,', bug: '설치 설정 패치에 general.mainAgent를 다시 보냄' },
  { file: 'screens/Settings.tsx', test: 'S4-25-form.', before: '}, { mainAgent: loaded });', after: '});', bug: '메인 AI 폼이 expected를 보내지 않음' },
  { file: 'screens/Settings.tsx', test: 'S4-25-form.', before: '{ mainAgent: loaded });', after: '{ mainAgent: { kind, model: model || null, effortTier: tier, effortOverride: override || null } });', bug: 'expected에 불러온 값 대신 편집한 값을 보냄' },
  { file: 'screens/Settings.tsx', test: 'S4-25-refresh.', before: '[section, snapshot.seat.generation, snapshot.seat.state, holderAi]', after: '[section]', bug: '좌석 변경 시 settings.get을 다시 호출하지 않음' },
  { file: 'screens/Settings.tsx', test: 'S4-25-refresh.', before: 'setDraft(old => old ? { ...old, general: { ...old.general, mainAgent: structuredClone(value.general.mainAgent) } } : structuredClone(value));', after: 'setDraft(structuredClone(value));', bug: '좌석 변경이 저장하지 않은 설치 입력값을 지움' },
  { file: 'components/SeatStatus.tsx', test: 'S4-30-banner.', before: "const desktop = snapshot.auth.mode !== 'server' && (!window.wook || getBridge().platform !== 'web');", after: 'const desktop = false;', bug: '데스크톱 배너에 서버 운영자 문장을 표시함' },
  { file: 'components/SeatStatus.tsx', test: 'S4-30-banner.', before: "const desktop = snapshot.auth.mode !== 'server' && (!window.wook || getBridge().platform !== 'web');", after: 'const desktop = true;', bug: '서버 배너에 이 PC의 운영 설정 문장을 표시함' },
  { file: 'components/MainPauseNotice.tsx', test: 'S4-30-pause.', before: "const desktop = snapshot.auth.mode !== 'server' && (!window.wook || getBridge().platform !== 'web');", after: 'const desktop = true;', bug: '서버 정지 안내에 작업 관리자를 표시함' },
  { file: 'components/SeatStatus.tsx', test: 'S4-30-banner.', before: " && (!window.wook || getBridge().platform !== 'web')", after: '', bug: '웹 플랫폼에서도 데스크톱 배너를 표시함' },
  { file: 'components/MainPauseNotice.tsx', test: 'S4-30-pause.', before: " && (!window.wook || getBridge().platform !== 'web')", after: '', bug: '웹 플랫폼에서도 작업 관리자를 안내함' },
  { file: 'api/fake/index.ts', suite: 'src/renderer/src/api/fake/settings-seat.test.ts', test: 'S4-25-fake-conflict.', before: 'if (loaded && (loaded.kind', after: 'if (false && loaded && (loaded.kind', bug: '가짜 브리지가 오래된 expected.mainAgent를 무시하고 저장함' },
];
const results = [];
for (const mutant of mutants) {
  const file = resolve('src/renderer/src', mutant.file), original = readFileSync(file), source = original.toString('utf8');
  if (source.split(mutant.before).length !== 2) throw new Error(`Expected one anchor: ${mutant.bug}`);
  try {
    writeFileSync(file, source.replace(mutant.before, mutant.after));
    const run = spawnSync(process.execPath, [resolve('node_modules/vitest/vitest.mjs'), 'run', '--config', 'src/renderer/tools/vitest.config.ts', mutant.suite ?? suite, '-t', mutant.test, '--no-cache'], {
      encoding: 'utf8', timeout: 60000, windowsHide: true, env: { ...process.env, NODE_DISABLE_COMPILE_CACHE: '1' },
    });
    const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`.replace(/\x1b\[[0-9;]*m/g, '');
    const killed = run.status !== 0 && /AssertionError/.test(output) && /Tests\s+.*failed/.test(output);
    results.push({ file: mutant.file, test: mutant.test, bug: mutant.bug, exitCode: run.status, killed,
      evidence: output.split('\n').filter(line => /FAIL|AssertionError|Tests\s+|Test Files\s+/.test(line)) });
    console.log(`${mutant.bug}: ${killed ? 'KILLED' : 'SURVIVED / ERROR'}`);
  } finally {
    writeFileSync(file, original);
    if (!readFileSync(file).equals(original)) throw new Error(`Restoration failed: ${file}`);
  }
}
writeFileSync(resolve('docs/design/permission-ui/stage4-seat/followup2-mutation-results.json'), JSON.stringify({ sourceRestored: true, results }, null, 2) + '\n');
if (results.some(result => !result.killed)) process.exitCode = 1;
