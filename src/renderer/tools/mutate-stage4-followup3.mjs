import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const fake = 'api/fake/index.ts', banner = 'components/SeatStatus.tsx';
const fakeTests = 'src/renderer/src/api/fake/settings-seat.test.ts';
const bannerTests = 'src/renderer/src/components/permission-ui.test.ts';
const mutants = [
  { file: fake, suite: fakeTests, test: 'S4-25-fake-conflict.|S4-37-fake-label.|S4-37-fake-codex-default.',
    before: "const label = `${current.kind === 'claude' ? 'Claude CLI' : 'Codex CLI'}(${model ? `모델 ${model}` : 'CLI 기본 모델'}, 노력치 ${effort})`;",
    after: "const label = `${current.kind === 'claude' ? 'Claude CLI' : 'Codex CLI'} · ${current.model ?? '기본 모델'}`;",
    bug: '가짜 충돌 문구를 가운뎃점과 기본 모델만 쓰던 형식으로 되돌림' },
  { file: fake, suite: fakeTests, test: 'S4-37-fake-installation.',
    before: 'const loaded = patch.general?.mainAgent !== undefined ? expected?.mainAgent : undefined;',
    after: 'const loaded = expected?.mainAgent;', bug: 'general.mainAgent가 없는 패치에도 오래된 expected를 검사함' },
  { file: banner, suite: bannerTests, test: 'S4-37-switching.',
    before: '메인 자리를 ${seat.pendingHolder?.label',
    after: "${desktop ? '운영 설정의 메인 AI로 자리를 바꾸세요. ' : ''}메인 자리를 ${seat.pendingHolder?.label",
    bug: '데스크톱의 교체 중 배너에서 운영 설정으로 나가도록 안내함' },
  { file: banner, suite: bannerTests, test: 'S4-37-switching.',
    before: '메인 자리를 ${seat.pendingHolder?.label',
    after: "${!desktop ? '서버 PC의 운영자에게 자리를 바꿔 달라고 하세요. ' : ''}메인 자리를 ${seat.pendingHolder?.label",
    bug: '서버의 교체 중 배너에서 서버 PC의 운영자에게 자리를 바꾸도록 안내함' },
  { file: banner, suite: bannerTests, test: 'S4-37-held-switching.',
    before: ' 교체가 보류되어 있습니다. 메인 에이전트 정지 안내에서 정지 해제를 눌러 주세요.',
    after: ' 교체가 보류되어 있습니다.', bug: '보류된 교체에서 기존 정지 해제 경로 안내를 빠뜨림' },
  { file: banner, suite: bannerTests, test: 'S4-37-switching.',
    before: '메인 자리를 ${seat.pendingHolder?.label', after: '메인 자리를 ${seat.holder?.label',
    bug: '인계받을 보유자 대신 지금 보유자를 안내함' },
  { file: fake, suite: fakeTests, test: 'S4-37-fake-label.',
    before: 'settings.team.effortMapping[current.kind][current.effortTier];', after: 'current.effortTier;',
    bug: '설정에 연결된 CLI 노력치 대신 단계 이름을 표시함' },
  { file: fake, suite: fakeTests, test: 'S4-25-fake-conflict.',
    before: 'const effort = current.effortOverride ?? ', after: 'const effort = ',
    bug: '직접 지정한 노력치를 무시하고 단계 연결값을 표시함' },
  { file: fake, suite: fakeTests, test: 'S4-25-fake-conflict.',
    before: "const model = current.model ?? (current.kind === 'codex' ? settings.team.modelCatalog?.codex?.[0]?.id ?? null : null);",
    after: 'const model = current.model;', bug: '모델이 미지정인 Codex에서 backend의 기본 모델 해석을 빠뜨림' },
  { file: banner, suite: bannerTests, test: 'S4-37-switching-pause.',
    before: "snapshot.stop.pausedMembers.some(item => item.memberId === 'M-MAIN')",
    after: 'snapshot.stop.pausedMembers.length > 0', bug: '다른 팀원의 정지를 메인 교체 보류로 잘못 판단함' },
];
const results = [];
for (const mutant of mutants) {
  const file = resolve('src/renderer/src', mutant.file), original = readFileSync(file), source = original.toString('utf8');
  if (source.split(mutant.before).length !== 2) throw new Error(`Expected one anchor: ${mutant.bug}`);
  try {
    writeFileSync(file, source.replace(mutant.before, mutant.after));
    const run = spawnSync(process.execPath, [resolve('node_modules/vitest/vitest.mjs'), 'run', '--config',
      'src/renderer/tools/vitest.config.ts', '--configLoader', 'runner', mutant.suite, '-t', mutant.test, '--no-cache'], {
      encoding: 'utf8', timeout: 60000, windowsHide: true, env: { ...process.env, NODE_DISABLE_COMPILE_CACHE: '1' },
    });
    const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`.replace(/\x1b\[[0-9;]*m/g, '');
    const killed = run.status === 1 && /AssertionError/.test(output) && /Tests\s+.*failed/.test(output);
    results.push({ file: mutant.file, test: mutant.test, bug: mutant.bug, exitCode: run.status, killed,
      evidence: output.split('\n').filter(line => /FAIL|AssertionError|Tests\s+|Test Files\s+/.test(line)) });
    console.log(`${mutant.bug}: ${killed ? 'KILLED' : 'SURVIVED / ERROR'}`);
  } finally {
    writeFileSync(file, original);
    if (!readFileSync(file).equals(original)) throw new Error(`Restoration failed: ${file}`);
  }
}
writeFileSync(resolve('docs/design/permission-ui/stage4-seat/followup3-mutation-results.json'), JSON.stringify({ sourceRestored: true, results }, null, 2) + '\n');
if (results.some(result => !result.killed)) process.exitCode = 1;
