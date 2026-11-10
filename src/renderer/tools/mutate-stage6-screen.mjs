import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const suite = 'src/renderer/src/components/stage6-screen.test.ts';
const panel = 'screens/SeatScreenControl.tsx', chip = 'components/ScreenStatus.tsx', facts = 'lib/screens.ts';
const mutants = [
  { file: chip, test: 'S6-chip-hidden', before: '!snapshot.auth.loggedIn || ', after: '', bug: '로그인 전 화면 상태 노출' },
  { file: chip, test: 'S6-chip-hidden', before: '(!screen.operatingSince && !screen.paused)', after: 'false', bug: '쉬는 동안 조작 칩 노출' },
  { file: chip, test: 'S6-chip-paused', before: 'const label = screen.paused', after: 'const label = false', bug: '멈춤을 조작 중으로 표시' },
  { file: 'App.tsx', test: 'S6-chip-route', before: "open={() => navigate({ tab: 'seat', panel: 'screen' })}", after: "open={() => navigate({ tab: 'seat' })}", bug: '상단 칩에서 화면 패널 지정 누락' },
  { file: panel, test: 'S6-unavailable', before: '<p>{screen.unavailable.text}</p>', after: '<p></p>', bug: '화면 도구를 쓸 수 없는 까닭 누락' },
  { file: facts, test: 'S6-vision', before: "if (seat.vision === 'verified')", after: "if (seat.vision !== 'failed')", bug: '미확인을 확인됨으로 표시' },
  { file: facts, test: 'S6-vision', before: "if (seat.vision === 'verified')", after: "if (seat.vision !== 'unknown')", bug: '실패를 확인됨으로 표시' },
  { file: facts, test: 'S6-typed', before: "row.result !== 'secret_blocked'", after: 'true', bug: '차단된 입력 글 노출' },
  { file: facts, test: 'S6-typed', before: 'row.focus?.password === false', after: 'true', bug: '암호 칸과 알 수 없는 포커스의 입력 글 노출' },
  { file: facts, test: 'S6-typed', before: 'return `가림 · ${row.textLength ?? 0}자`;', after: "return '가림';", bug: '가린 글자 수 누락' },
  { file: panel, test: 'S6-kept', before: 'if (!capture.kept) return;', after: 'if (false) return;', bug: '보관이 끝난 이미지 요청' },
  { file: panel, test: 'S6-kept', before: 'item.kept ? <button', after: 'true ? <button', bug: '보관이 끝난 캡처 보기 버튼 노출' },
  { file: panel, test: 'S6-kept', before: "if (selected) document.getElementById", after: "if (false) document.getElementById", bug: '열린 캡처가 보이도록 스크롤하지 않음' },
  { file: panel, test: 'S6-kept', before: 'capture?.kept ? <CaptureImage', after: 'capture ? <CaptureImage', bug: '폴링에서 보관 종료를 확인한 뒤에도 이미지 유지' },
  { file: panel, test: 'S6-image-late', before: 'if (!active) return;', after: 'if (false) return;', bug: '닫은 캡처의 늦은 응답 적용' },
  { file: panel, suite: 'src/renderer/src/components/stage4-seat.test.ts', test: 'S4-no-swap', before: 'let active = true, busy = false;', after: "void call('turns.stopMember', 'M-MAIN'); let active = true, busy = false;", bug: '화면 패널에서 별도의 조작 호출 추가' },
  { file: chip, suite: 'src/renderer/src/components/stage4-seat.test.ts', test: 'S4-no-swap', before: 'onClick={open}', after: "onClick={() => { void import('../api/store').then(({ call }) => call('settings.update', {})); open(); }}", bug: '화면 칩에 설정 쓰기 추가' },
  { file: 'lib/notice.ts', test: 'S6-notice', before: "if (link?.tab === 'seat') return { title: item.title, link, command: null };", after: "if (link?.tab === 'seat') return { title: item.title, link: { tab: 'seat' }, command: null };", bug: '알림에서 화면 패널 소실' },
  { file: 'App.tsx', test: 'S6-notice', before: 'setSeatPanel(target.panel);', after: 'setSeatPanel(undefined);', bug: 'navigate 토픽에서 패널 소실' },
  { file: panel, test: 'S6-poll', before: 'active = false; clearInterval(timer);', after: 'active = false;', bug: '패널을 닫은 뒤 폴링 타이머 유지' },
  { file: panel, test: 'S6-poll', before: 'if (operating) timer', after: 'if (true) timer', bug: '조작하지 않는 동안 폴링' },
  { file: panel, test: 'S6-poll', before: 'if (document.hidden) return;', after: 'if (false) return;', bug: '숨긴 브라우저 페이지에서 폴링' },
  { file: panel, test: 'S6-poll', before: '[seat.generation, operating]', after: '[seat, operating]', bug: '스냅샷 객체가 바뀔 때마다 다시 조회' },
  { file: 'screens/Seat.tsx', test: 'S6-panel-close', before: "tab === 'screen' && <div", after: "true && <div", bug: '다른 탭에서도 화면 패널을 마운트해 둠' },
  { file: 'components/ActivityMarker.tsx', test: 'S6-activity', before: " || item.kind === 'screen'", after: '', bug: '화면 조작 활동 아이콘 누락' },
  ...['screens/Home.tsx', 'screens/Studio.tsx', 'screens/Settings.tsx'].map(file => ({ file, test: 'S6-activity-labels', before: 'ACTIVITY_KIND_LABEL[item.kind]', after: "item.kind === 'screen' ? '' : ACTIVITY_KIND_LABEL[item.kind]", bug: `${file} 화면 조작 활동 라벨 누락` })),
  { file: panel, test: 'S6-records', before: '({row.x}, {row.y})', after: '(0, 0)', bug: '기록에 실제 좌표 대신 고정 좌표 표시' },
  { file: panel, test: 'S6-view-controls', before: '<div className="screen-control">', after: '<div className="screen-control"><button onClick={() => void call(\'stop.emergency\')}>화면 조작 멈춤</button>', bug: '보기 패널에 별도의 화면 멈춤 버튼 추가' },
  { file: 'screens/Settings.tsx', test: 'S6-prereqs', before: '{prereqs.screen.detail}', after: "{''}", bug: '화면 도구 준비 상태 누락' },
  { file: 'screens/Settings.tsx', test: 'S6-prereqs', before: '{prereqs.jobRunner.detail}', after: "{''}", bug: '작업 개체 도우미 준비 상태 누락' },
  { file: 'screens/Home.tsx', test: 'S6-work-label', before: "mainAgent.currentWork.kind === 'screen_check'", after: 'false', bug: '홈에서 화면 확인 대신 내부 작업 이름 표시' },
  { file: 'components/MemberPanel.tsx', test: 'S6-work-label', before: "member.currentWork.kind === 'screen_check'", after: 'false', bug: '상세에서 화면 확인 대신 내부 작업 이름 표시' },
  { file: 'api/fake/index.ts', test: 'S6-fake-bridge', before: "'fakeSeat', 'fakeScreen',", after: "'fakeSeat',", bug: 'fakeScreen 주소 표시를 읽지 않음' },
  { file: 'api/fake/screens.ts', test: 'S6-fixtures', before: "'secret_blocked', ", after: '', bug: '비밀 입력 차단 예제 누락' },
];
const wrapper = 'C:/Users/pc_09/AppData/Local/Temp/claude/C--WOOK-wookagent/7f7656cb-51f2-4626-b0fb-713c3230d9b4/scratchpad/vt.sh';
const output = resolve('docs/design/permission-ui/stage6-screen'); mkdirSync(output, { recursive: true });
const report = resolve(output, 'mutation-results.json');
const retryFailed = process.argv.includes('--retry-failed');
const previous = retryFailed && existsSync(report) ? JSON.parse(readFileSync(report, 'utf8')).results : [];
const results = previous.filter(result => result.killed);
for (const mutant of mutants) {
  if (retryFailed && results.some(result => result.file === mutant.file && result.bug === mutant.bug)) continue;
  const file = resolve('src/renderer/src', mutant.file), original = readFileSync(file), source = original.toString('utf8');
  if (source.split(mutant.before).length !== 2) throw new Error(`Expected unique anchor: ${mutant.bug}`);
  try {
    writeFileSync(file, source.replace(mutant.before, mutant.after));
    const run = spawnSync('bash', [wrapper, 'run', '--config', 'src/renderer/tools/vitest.config.ts', '--configLoader', 'runner', '--no-cache', mutant.suite ?? suite, '-t', mutant.test], {
      encoding: 'utf8', timeout: 1080000, windowsHide: true, env: { ...process.env, NODE_DISABLE_COMPILE_CACHE: '1' },
    });
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
writeFileSync(report, JSON.stringify({ sourceRestored: true, results }, null, 2) + '\n');
if (results.some(result => !result.killed)) process.exitCode = 1;
