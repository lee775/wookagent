import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve('src/renderer');
const permission = 'src/renderer/src/components/permission-ui.test.ts';
const notices = 'src/renderer/src/components/followups2.test.ts';
const temp = resolve(root, '.followups2-test-temp');
mkdirSync(temp, { recursive: true });
const mutants = [
  { item: 1, file: 'src/lib/notice.ts', before: 'if (key == null) return item.title;', after: 'if (true) return item.title;', suite: notices, test: 'S2-1.', bug: '키가 있어도 서버 제목을 그대로 써서 알림 종류를 놓침' },
  { item: 1, file: 'src/lib/notice.ts', before: "link = { tab: 'settings', section: 'account' };", after: 'link = item.link;', suite: notices, test: 'S2-1.', bug: '사용량 한도와 모의 실행 알림을 설치 설정으로 보내지 않음' },
  { item: 1, file: 'src/lib/notice.ts', before: "command = { projectId, text: '' };", after: "command = { projectId, text: '메인 에이전트에 대해: ' };", suite: notices, test: 'S2-1-drop.', bug: '종료 실패 알림의 빈 초안에 팀원 요청 문구를 다시 넣음' },
  { item: 3, file: 'src/screens/Home.tsx', before: "todo.reachesMain ?? todo.message.includes('검수자 없음 —')", after: "todo.reachesMain || todo.message.includes('검수자 없음 —')", suite: permission, test: 'S2-3.', bug: '명시적인 reachesMain false보다 예전 메시지 판정을 우선함' },
  { item: 3, file: 'src/screens/Home.tsx', before: "label: '복구 확인 필요'", after: "label: '메인 에이전트가 복구 확인 중'", suite: permission, test: 'S2-3.', bug: '복구 확인을 메인이 자동으로 처리 중이라고 표시함' },
  { item: 4, file: 'src/lib/taskSignals.ts', before: "reason.kind === 'merge_blocked' || reason.kind === 'recovery_check'", after: "reason.kind === 'recovery_check'", suite: permission, test: 'S2-4.', bug: '병합 보류를 메인이 자동으로 재개하는 안내로 되돌림' },
  { item: 4, file: 'src/lib/taskSignals.ts', before: "reason.kind === 'error' && reason.refId === 'rejudge'", after: "reason.kind === 'error' && (reason.refId === 'rejudge' || reason.label === '다시 판정 실패')", suite: permission, test: 'S2-4.', bug: '다시 판정 보류를 구조화된 refId 대신 한국어 이름으로도 판정함' },
  { item: 4, file: 'src/lib/taskSignals.ts', before: '메인 에이전트가 재개하면 같은 버전일 때 기록된 검사 결과로 이어 갑니다.', after: '메인 에이전트가 남은 프로세스를 확인한 뒤 자동으로 재개합니다.', suite: permission, test: 'S2-4.', bug: '파일 없는 자동 검사 보류에서 자동 재개를 약속함' },
  { item: 5, file: 'src/screens/Settings.tsx', before: '<option value="api_key">API 키</option>', after: '<option value="api_key">API 키</option><option value="free">무료</option>', suite: permission, test: 'S2-5.', bug: '서버가 받지 않는 세 번째 AI 인증 방식 선택지를 추가함' },
  { item: 5, file: 'src/api/fake/index.ts', before: "patch.account && 'authMode' in patch.account && !authModesAllowed(patch.account.authMode)", after: "false", suite: notices, test: 'S2-5-fake.', bug: '가짜 브리지가 잘못된 인증 방식과 혼합 저장을 허용함' },
];
const results = [];
for (const mutant of mutants) {
  const file = resolve(root, mutant.file);
  if (!file.startsWith(root + sep)) throw new Error('Mutation path escaped renderer');
  const original = readFileSync(file);
  const source = original.toString('utf8');
  if (!source.includes(mutant.before)) throw new Error(`Missing mutation anchor: ${mutant.bug}`);
  try {
    writeFileSync(file, source.replace(mutant.before, mutant.after));
    const result = spawnSync(process.execPath, [resolve('node_modules/vitest/vitest.mjs'), 'run', '--config', 'src/renderer/tools/vitest.config.ts', mutant.suite, '-t', mutant.test], {
      encoding: 'utf8', timeout: 60000, windowsHide: true, env: { ...process.env, TMP: temp, TEMP: temp },
    });
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.replace(/\x1b\[[0-9;]*m/g, '');
    const killed = result.status !== 0 && /AssertionError|expected .*|toBeDefined/.test(output) && /Tests\s+.*failed/.test(output);
    results.push({ item: mutant.item, file: mutant.file, bug: mutant.bug, test: mutant.test, exitCode: result.status, killed,
      evidence: output.split('\n').filter(line => /FAIL|AssertionError|Tests\s+|Test Files\s+/.test(line)).slice(0, 7) });
    console.log(`item ${mutant.item} ${mutant.test}: ${killed ? 'KILLED' : 'SURVIVED / ERROR'}`);
  } finally {
    writeFileSync(file, original);
    if (!readFileSync(file).equals(original)) throw new Error(`Failed to restore ${file}`);
  }
}
mkdirSync('docs/design/permission-ui/followups2', { recursive: true });
writeFileSync('docs/design/permission-ui/followups2/mutation-results.json', JSON.stringify(results, null, 2) + '\n');
if (results.some(result => !result.killed)) process.exitCode = 1;
