import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const output = resolve('docs/design/permission-ui/stage4-seat');
const temp = resolve('src/renderer/.stage4-followup-temp');
mkdirSync(temp, { recursive: true });
const screenTests = 'src/renderer/src/components/stage4-seat.test.ts';
const pathTests = 'src/renderer/src/lib/displayText.test.ts';
const mutants = [
  { file: 'lib/notice.ts', suite: screenTests, test: 'S4-followup-notice.', before: "link: { tab: 'seat' }, command: null", after: "link: { tab: 'projects' }, command: null", bug: '공유 자리 링크를 프로젝트 화면으로 보냄' },
  { file: 'lib/notice.ts', suite: screenTests, test: 'S4-6.', before: "link: { tab: 'seat' }, command: null", after: "link: { tab: 'seat' }, command: linkedCommand(item.link, snapshot)", bug: '응답 없음 알림에 이전 팀원 링크의 명령 초안을 붙임' },
  { file: 'components/ServerNotice.tsx', suite: screenTests, test: 'S4-followup-notice.', before: " && link?.tab !== 'seat'", after: '', bug: '기기 로그인 키가 공유 자리 링크를 덮어씀' },
  { file: 'App.tsx', suite: screenTests, test: 'S4-followup-topic.', before: "bridge.subscribe('navigate', navigate)", after: "bridge.subscribe('navigate', () => undefined)", bug: 'navigate 토픽을 받아도 화면을 바꾸지 않음' },
  ...['파일 변경', '파일 작성', '파일 수정', '파일 노트북 수정', '읽기', '파일 찾기', '내용 검색'].map(prefix => ({
    file: 'lib/displayText.ts', suite: pathTests, test: `S4-followup-path. preserves ${prefix} paths`,
    before: `${prefix}${prefix === '내용 검색' ? '):' : '|'}`, after: `잘못된 ${prefix}${prefix === '내용 검색' ? '):' : '|'}`,
    bug: `${prefix}: 경로를 보호하지 않아 작업 ID와 main을 바꿈`,
  })),
  { file: 'lib/displayText.ts', suite: pathTests, test: 'S4-followup-multiline.',
    before: "return value.split('\\n').map(line => resolveDisplayLine(line, snapshot)).join('\\n');",
    after: 'return resolveDisplayLine(value, snapshot);', bug: '여러 줄 중간에 나온 파일 경로를 바꿈' },
  { file: 'lib/displayText.ts', suite: pathTests, test: 'S4-followup-permission.',
    before: '파일 변경이 승인 단계에서 거부되었습니다', after: '파일 변경 거부', bug: 'Codex 파일 변경 거부와 반복 오류의 경로를 바꿈' },
  ...[
    ['N-SEAT-CHANGED', '메인 에이전트가 바뀌었습니다'],
    ['N-SEAT-SWITCH', '메인 자리 교체가 멈췄습니다'],
    ['N-SEAT-UNRESPONSIVE', '메인 에이전트 응답 없음'],
  ].map(([id, title]) => {
    const line = readFileSync(resolve('src/renderer/src/api/fake/index.ts'), 'utf8').split('\n').find(line => line.includes(`id: '${id}'`));
    if (!line) throw new Error(`Missing fake notice: ${id}`);
    return { file: 'api/fake/index.ts', suite: screenTests, test: 'S4-8-bridge.', before: line,
      after: line.replace("link: { tab: 'seat' }", 'link: null'), bug: `${title} fake 알림에서 공유 자리 링크를 빠뜨림` };
  }),
  { file: 'api/fake/seat.ts', suite: screenTests, test: 'S4-followup-models.', before: "model: 'opus'", after: "model: 'claude-opus-4-6'", bug: '자리 보유자에 카탈로그에 없는 Claude 모델을 표시함' },
  { file: 'api/fake/seat.ts', suite: screenTests, test: 'S4-followup-models.', before: "model: 'gpt-6-sol'", after: "model: 'gpt-5.4'", bug: '교체 대상과 이력에 카탈로그에 없는 Codex 모델을 표시함' },
  { file: 'api/fake/data.ts', suite: screenTests, test: 'S4-followup-models.', before: "specialist.ai.model = 'gpt-6-sol'", after: "specialist.ai.model = 'gpt-5'", bug: '팀원에게 이전 GPT 모델을 지정함' },
  { file: 'api/fake/data.ts', suite: screenTests, test: 'S4-followup-models.', before: "id: 'fable'", after: "id: 'old-fable'", bug: 'fake 기본 카탈로그의 모델 ID를 바꿈' },
];
const results = [];
for (const mutant of mutants) {
  const file = resolve('src/renderer/src', mutant.file), original = readFileSync(file), source = original.toString('utf8');
  if (source.split(mutant.before).length !== 2) throw new Error(`Expected one anchor: ${mutant.bug}`);
  try {
    writeFileSync(file, source.replace(mutant.before, mutant.after));
    const run = spawnSync(process.execPath, [resolve('node_modules/vitest/vitest.mjs'), 'run', '--config',
      'src/renderer/tools/vitest.config.ts', mutant.suite, '-t', mutant.test, '--no-cache'], {
      encoding: 'utf8', timeout: 60000, windowsHide: true,
      env: { ...process.env, TMP: temp, TEMP: temp, NODE_DISABLE_COMPILE_CACHE: '1' },
    });
    const text = `${run.stdout ?? ''}\n${run.stderr ?? ''}`.replace(/\x1b\[[0-9;]*m/g, '');
    const killed = run.status !== 0 && /AssertionError/.test(text) && /Tests\s+.*failed/.test(text);
    results.push({ file: mutant.file, test: mutant.test, bug: mutant.bug, exitCode: run.status, killed,
      evidence: text.split('\n').filter(line => /FAIL|AssertionError|Tests\s+|Test Files\s+/.test(line)) });
    console.log(`${mutant.test} ${mutant.bug}: ${killed ? 'KILLED' : 'SURVIVED / ERROR'}`);
  } finally {
    writeFileSync(file, original);
    if (!readFileSync(file).equals(original)) throw new Error(`Restoration failed: ${file}`);
  }
}
writeFileSync(resolve(output, 'followup-mutation-results.json'), JSON.stringify({ sourceRestored: true, results }, null, 2) + '\n');
if (results.some(result => !result.killed)) process.exitCode = 1;
