import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve('src/renderer');
const suite = 'src/renderer/src/components/permission-ui.test.ts';
const mutants = [
  { item: 1, file: 'src/components/MemberPanel.tsx', before: 'openCommand(member.projectId,', after: "openCommand('main',", test: '1. member', bug: '팀원 명령의 프로젝트 대상을 main으로 바꿈' },
  { item: 2, file: 'src/components/MainPauseNotice.tsx', before: "if (!pause && main?.status !== 'paused')", after: "if (!snapshot.stop?.global.active || (!pause && main?.status !== 'paused'))", test: '2. main pause', bug: '긴급 정지가 없으면 메인 정지 해제를 숨김' },
  { item: 4, file: 'src/screens/Home.tsx', before: "openCommand(null, '새 프로젝트를 만들어 줘: ')", after: "openCommand('P-0001', '새 프로젝트를 만들어 줘: ')", test: '4. home', bug: '새 프로젝트 요청을 기존 프로젝트에 보냄' },
  { item: 5, file: 'src/components/TaskDetail.tsx', before: '메인 에이전트 검수 중', after: '대표 검수 대기', test: '5. task', bug: '메인 검수를 대표 검수 대기로 다시 표시' },
  { item: 6, file: 'src/screens/Documents.tsx', before: "return report.canApprove ?? (report.status !== 'approved' && report.status !== 'changes_requested');", after: "return report.status !== 'approved' && report.status !== 'changes_requested';", test: '6. report approval', bug: 'canApprove를 무시하고 상태만으로 승인 버튼을 숨김' },
  { item: 8, file: 'src/lib/installationSettings.ts', before: 'backup: { enabled: settings.general.backup.enabled }', after: 'backup: { enabled: settings.general.backup.enabled, keep: settings.general.backup.keep }', test: '8. operations', bug: '설치 저장에 운영 설정인 백업 보관 개수를 섞음' },
  { item: 9, file: 'src/lib/taskSignals.ts', before: "reason.kind === 'error' && reason.scope === 'task' &&", after: "reason.note.includes('대표가 확인한 것으로 보고') && reason.kind === 'error' && reason.scope === 'task' &&", suite: 'src/renderer/src/lib/taskSignals.test.ts', test: '2. detects', bug: '자동 검사 보류 탐지를 한국어 문구에 다시 묶음' },
  { item: 11, file: 'src/screens/Home.tsx', before: "import { useState } from 'react';", after: "import { useState } from 'react';\nif (false) void call('members.pause', 'M-0016', 'graceful');", test: '11. every literal', bug: '실행 경로 밖에 금지된 팀원 일시정지 호출을 재도입' },
];
const results = [];
for (const mutant of mutants) {
  const file = resolve(root, mutant.file);
  if (!file.startsWith(root + sep)) throw new Error('Mutation path escaped renderer');
  const original = readFileSync(file, 'utf8');
  if (!original.includes(mutant.before)) throw new Error(`Missing mutation anchor for item ${mutant.item}`);
  try {
    writeFileSync(file, original.replace(mutant.before, mutant.after));
    const result = spawnSync(process.execPath, [resolve('node_modules/vitest/vitest.mjs'), 'run', '--config', 'src/renderer/tools/vitest.config.ts', mutant.suite ?? suite, '-t', mutant.test], { encoding: 'utf8', timeout: 60000 });
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.replace(/\x1b\[[0-9;]*m/g, '');
    const killed = result.status !== 0 && /AssertionError|expected .*|button .*|toBeDefined/.test(output) && /Tests\s+.*failed/.test(output);
    results.push({ item: mutant.item, file: mutant.file, bug: mutant.bug, test: mutant.test, exitCode: result.status, killed,
      evidence: output.split('\n').filter(line => /FAIL|AssertionError|Tests\s+|Test Files\s+/.test(line)).slice(0, 7) });
    console.log(`item ${mutant.item}: ${killed ? 'KILLED' : 'SURVIVED / ERROR'}`);
  } finally {
    writeFileSync(file, original);
    if (readFileSync(file, 'utf8') !== original) throw new Error(`Failed to restore ${file}`);
  }
}
mkdirSync('docs/design/permission-ui', { recursive: true });
writeFileSync('docs/design/permission-ui/mutation-results.json', JSON.stringify(results, null, 2) + '\n');
if (results.some(result => !result.killed)) process.exitCode = 1;
