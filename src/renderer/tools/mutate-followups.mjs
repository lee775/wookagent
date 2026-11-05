import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve('src/renderer');
const permission = 'src/renderer/src/components/permission-ui.test.ts';
const followups = 'src/renderer/src/components/followups.test.ts';
const mutants = [
  { item: 1, file: 'src/screens/Settings.tsx', before: "await call('projects.setMock', projectId, { enabled: false })", after: "await call('projects.setMock', projectId, { enabled: true })", suite: permission, test: 'F1.', bug: '프로젝트 끄기 버튼이 enabled:true를 보냄' },
  { item: 1, file: 'src/api/fake/index.ts', before: 'Object.keys(input).length !== 1 || input.enabled !== false', after: 'false', suite: followups, test: 'F1-fake.', bug: '가짜 브리지가 모의 켜기와 추가 인자를 허용함' },
  { item: 2, file: 'src/components/AiStatusSummary.tsx', before: '|| ai.modelLimits?.length', after: '', suite: permission, test: 'F2.', bug: '전체 AI가 막히지 않으면 홈에서 모델 한도를 숨김' },
  { item: 2, file: 'src/components/AiStatusSummary.tsx', before: '{limit.label} 주간 한도', after: 'Opus 주간 한도', suite: followups, test: 'F2-family.', bug: '서버 모델 이름 대신 Opus로 고정함' },
  { item: 3, file: 'src/components/ServerNotice.tsx', before: '{item.body}', after: "{item.body.replace('M-0016', '팀원 이름')}", suite: followups, test: 'F3.', bug: '서버 본문을 화면이 다시 씀' },
  { item: 3, file: 'src/components/ServerNotice.tsx', before: 'command.projectId, command.text', after: "command.projectId, '이 항목에 대해: '", suite: followups, test: 'F3.', bug: '알림의 명령 초안에서 작업과 팀원 식별자를 지움' },
  { item: 4, file: 'src/screens/Documents.tsx', before: "report.canRequestChanges ?? (report.status !== 'approved' && report.status !== 'changes_requested')", after: "report.status !== 'approved' && report.status !== 'changes_requested'", suite: permission, test: 'F4.', bug: 'canRequestChanges:false를 무시함' },
  { item: 4, file: 'src/screens/Documents.tsx', before: 'setFeedback(error.message)', after: "setFeedback('수정 요청을 처리하지 못했습니다.')", suite: permission, test: 'F4-conflict.', bug: 'conflict 서버 메시지를 일반 안내로 바꿈' },
  { item: 5, file: 'src/lib/operationLimits.ts', before: 'min: 2, max: 32', after: 'min: 1, max: 32', suite: followups, test: 'F5-source.', bug: '실행 상한 범위 사본이 서버 원본과 어긋남' },
  { item: 5, file: 'src/screens/Settings.tsx', before: "{s.execution[key] ?? '제한 없음'}", after: '{s.execution[key] ?? 0}', suite: permission, test: 'F5.', bug: 'Claude 반복 수 null을 0으로 표시함' },
  { item: 8, file: 'src/App.tsx', before: '<SettingsBoundary key={section}><SettingsScreen', after: '<SettingsScreen', second: ['/></SettingsBoundary>', '/>'], suite: followups, test: 'F8.', bug: '설정 화면 오류 경계를 제거함' },
];
const results = [];
for (const m of mutants) {
  const path = resolve(root, m.file);
  if (!path.startsWith(root + sep)) throw new Error('Mutation escaped renderer');
  const original = readFileSync(path, 'utf8');
  if (!original.includes(m.before)) throw new Error(`Missing anchor: ${m.bug}`);
  let mutated = original.replace(m.before, m.after);
  if (m.second) { if (!mutated.includes(m.second[0])) throw new Error('Missing closing anchor'); mutated = mutated.replace(...m.second); }
  try {
    writeFileSync(path, mutated);
    const result = spawnSync(process.execPath, [resolve('node_modules/vitest/vitest.mjs'), 'run', '--config', 'src/renderer/tools/vitest.config.ts', m.suite, '-t', m.test], { encoding: 'utf8', timeout: 60000, windowsHide: true });
    const output = `${result.stdout}\n${result.stderr}`.replace(/\x1b\[[0-9;]*m/g, '');
    const killed = result.status !== 0 && /Tests\s+.*failed/.test(output) && /AssertionError/.test(output);
    results.push({ item: m.item, file: m.file, bug: m.bug, test: m.test, killed, exitCode: result.status,
      evidence: output.split('\n').filter(l => /FAIL|AssertionError|Tests\s+|Test Files\s+/.test(l)).slice(0, 7) });
    console.log(`${m.item}: ${killed ? 'KILLED' : 'SURVIVED / ERROR'} — ${m.bug}`);
  } finally {
    writeFileSync(path, original);
    if (readFileSync(path, 'utf8') !== original) throw new Error(`Restore failed: ${path}`);
  }
}
mkdirSync('docs/design/permission-ui/followups', { recursive: true });
writeFileSync('docs/design/permission-ui/followups/mutation-results.json', JSON.stringify(results, null, 2) + '\n');
if (results.some(r => !r.killed)) process.exitCode = 1;
