import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const ui = 'src/renderer/src/components/permission-ui.test.ts';
const signals = 'src/renderer/src/lib/taskSignals.test.ts';
const followups = 'src/renderer/src/components/followups2.test.ts';
const home = 'screens/Home.tsx', hints = 'lib/taskSignals.ts', settings = 'screens/Settings.tsx';
const mutants = [
  { file: home, suite: `${ui}|${followups}`, test: 'S2-3.|S2-fake.',
    before: "if ('reachesMain' in todo && todo.reachesMain !== undefined) return todo.reachesMain;",
    after: "if (todo.kind === 'error') return false; if ('reachesMain' in todo && todo.reachesMain !== undefined) return todo.reachesMain;",
    bug: '오류와 병합 보류의 true를 무시하고 명령창 출구를 표시함' },
  { file: home, suite: `${ui}|${followups}`, test: 'S2-3.|S2-fake.|4. home',
    before: "if ('reachesMain' in todo && todo.reachesMain !== undefined) return todo.reachesMain;",
    after: "if (todo.kind === 'recovery_check') return false; if ('reachesMain' in todo && todo.reachesMain !== undefined) return todo.reachesMain;",
    bug: '복구 true를 무시하고 명령창 출구를 표시함' },
  { file: home, suite: ui, test: 'S2-3.|S3-2.',
    before: 'return todo.reachesMain;', after: 'return true;', bug: '홈에서 false도 처리 중으로 표시함' },
  { file: home, suite: ui, test: 'S2-3.',
    before: "return todo.kind === 'error' && todo.message.includes('검수자 없음 —');",
    after: 'return false;', bug: '홈에서 필드 없는 검수자 없음의 기존 안내를 없앰' },
  { file: hints, suite: `${ui}|${signals}`, test: 'S2-4.|S5-signals.|2. detects|S5-mixed.',
    before: "if (reason.reachesMain === true) return '메인 에이전트가 처리 중';",
    after: "if (reason.reachesMain === true) return '명령창으로 메인 에이전트에게 알려 주세요';",
    bug: '작업 상세와 검사 신호에서 true를 명령창 출구로 표시함' },
  { file: hints, suite: `${ui}|${signals}`, test: 'S2-4.|S5-signals.|2. detects|S5-mixed.',
    before: "if (reason.reachesMain === true) return '메인 에이전트가 처리 중';",
    after: "if (reason.reachesMain !== undefined) return '메인 에이전트가 처리 중';",
    bug: '작업 상세와 검사 신호에서 false를 처리 중으로 표시함' },
  { file: hints, suite: `${ui}|${signals}`, test: 'S2-4.|S5-signals.',
    before: "reason.refId !== 'no_reviewer'", after: 'true', bug: '필드 없는 검수자 없음의 자동 처리 안내를 명령창 출구로 바꿈' },
  { file: home, suite: ui, test: 'S5-home-group.',
    before: '{ownerCount}</span>', after: '{todos.length}</span>', bug: '메인 처리 항목과 운영 경고를 대표 할 일 개수에 포함함' },
  { file: home, suite: ui, test: 'S5-home-group.',
    before: 'key: `${todo.id}:${occurrence}`', after: 'key: todo.id', bug: '한 작업의 두 오류 사유에 동일한 React 키를 부여함' },
  { file: settings, suite: ui, test: 'S5-roles-refresh.',
    before: 'return () => { active = false; };\n  }, [section, snapshot.version]);', after: 'return () => { active = false; };\n  }, [section]);', bug: '같은 설정 분류에서 스냅샷이 바뀌어도 역할을 다시 읽지 않음' },
  { file: settings, suite: ui, test: 'S5-creators.',
    before: '{role.createdBy && <span', after: '{false && <span', bug: '역할 생성자 태그를 숨김' },
  { file: settings, suite: ui, test: 'S5-creators.',
    before: 'ROLE_CREATOR_LABEL[role.createdBy]', after: 'ROLE_CREATOR_LABEL.operator', bug: '모든 생성자를 운영자로 표시함' },
  { file: 'components/TaskDetail.tsx', suite: ui, test: 'S5-asset.',
    before: 'TASK_TYPE_LABEL[t.type]', after: "t.type === 'asset' ? '' : TASK_TYPE_LABEL[t.type]", bug: '에셋 작업 유형 라벨을 숨김' },
  { file: settings, suite: ui, test: 'S5-creators.',
    before: 'TASK_TYPE_LABEL[type]', after: "type === 'asset' ? '' : TASK_TYPE_LABEL[type]", bug: '역할의 담당 유형에서 에셋 라벨을 숨김' },
  { file: 'api/fake/index.ts', suite: ui, test: 'S5-asset.',
    before: "artifact: task.outputMode === 'artifact' && task.state === 'done' ?",
    after: "artifact: task.type !== 'asset' && task.outputMode === 'artifact' && task.state === 'done' ?", bug: '에셋의 보관된 산출물을 반환하지 않음' },
  { file: 'screens/Studio.tsx', suite: ui, test: 'S5-main-activity.',
    before: "item.memberId === 'M-MAIN' ? '메인 에이전트' : item.actorName", after: 'item.actorName', bug: 'M-MAIN 활동에 알 수 없는 팀원 이름을 그대로 표시함' },
  { file: 'screens/Studio.tsx', suite: ui, test: 'S5-main-activity.',
    before: 'snapshot.recentActivity.filter((item) => item.projectId === project.id)', after: 'snapshot.recentActivity', bug: '다른 프로젝트의 메인 활동까지 스튜디오에 표시함' },
  { file: home, suite: ui, test: 'S5-history.',
    before: 'reachesMain ? <details className="hold-history">', after: 'false ? <details className="hold-history">', bug: '홈에서 예전 명령창 안내를 현재 상태와 함께 그대로 노출함' },
  { file: 'components/TaskDetail.tsx', suite: ui, test: 'S5-history.',
    before: '<details className="hold-history">', after: '<details className="hold-history" open>', bug: '작업 상세에서 예전 출구 안내를 기본으로 펼침' },
  { file: settings, suite: ui, test: 'S5-policy.',
    before: '홈에서 복구 항목의 전달 상태를 확인하세요. 메인 에이전트에게 확인이나 처리를 요청할 수 있습니다.',
    after: '메인 에이전트가 실행 결과를 확인하고 처리합니다.', bug: '모든 복구 항목을 메인이 처리한다는 무조건적인 약속을 복원함' },
  { file: 'api/fake/data.ts', suite: followups, test: 'S2-fake.',
    before: "kind: 'merge_blocked', label: '병합 기록 확인 필요', reachesMain: true",
    after: "kind: 'merge_blocked', label: '병합 기록 확인 필요', reachesMain: false", bug: '가짜 병합 보류와 홈 todo의 전달 상태를 다르게 만듦' },
  { file: 'api/fake/seat.ts', suite: 'src/renderer/src/components/stage4-seat.test.ts', test: 'S4-5.',
    before: "label: '탐색 항목 이름에 관한 질문'", after: "label: '다른 질문'", bug: '일지의 질문 링크를 잘못된 이름으로 표시함' },
];
const results = [];
for (const mutant of mutants) {
  const file = resolve('src/renderer/src', mutant.file), original = readFileSync(file), source = original.toString('utf8');
  if (source.split(mutant.before).length !== 2) throw new Error(`Expected one anchor: ${mutant.bug}`);
  try {
    writeFileSync(file, source.replace(mutant.before, mutant.after));
    const run = spawnSync(process.execPath, [resolve('node_modules/vitest/vitest.mjs'), 'run', '--config',
      'src/renderer/tools/vitest.config.ts', '--configLoader', 'runner', '--no-cache', ...mutant.suite.split('|'), '-t', mutant.test],
      { encoding: 'utf8', timeout: 60000, windowsHide: true, env: { ...process.env, NODE_DISABLE_COMPILE_CACHE: '1' } });
    const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`.replace(/\x1b\[[0-9;]*m/g, '');
    const killed = run.status === 1 && /AssertionError/.test(output) && /Tests\s+.*failed/.test(output);
    results.push({ file: mutant.file, test: mutant.test, bug: mutant.bug, exitCode: run.status, killed,
      evidence: output.split('\n').filter(line => /FAIL|AssertionError|Tests\s+|Test Files\s+/.test(line)) });
    console.log(`${killed ? 'KILLED' : 'SURVIVED / ERROR'}: ${mutant.bug}`);
  } finally {
    writeFileSync(file, original);
    if (!readFileSync(file).equals(original)) throw new Error(`Restoration failed: ${file}`);
  }
}
const output = resolve('docs/design/permission-ui/stage5-overview');
mkdirSync(output, { recursive: true });
writeFileSync(resolve(output, 'mutation-results.json'), JSON.stringify({ sourceRestored: true, results }, null, 2) + '\n');
if (results.some(result => !result.killed)) process.exitCode = 1;
