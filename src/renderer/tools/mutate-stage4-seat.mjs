import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const output = resolve('docs/design/permission-ui/stage4-seat');
const temp = resolve('src/renderer/.stage4-test-temp');
mkdirSync(output, { recursive: true }); mkdirSync(temp, { recursive: true });
const mutants = [
  { item: 1, file: 'components/SeatStatus.tsx', test: 'S4-1.', before: 'if (!snapshot.auth.loggedIn) return null;', after: 'if (false) return null;', bug: '로그인 전에 빈 자리를 표시함' },
  { item: 1, file: 'components/SeatStatus.tsx', test: 'S4-1.', before: '` → ${seat.pendingHolder?.label ?? \'다음 보유자\'} 교체 중`', after: "' 교체 중'", bug: '교체 중 다음 보유자 이름을 빠뜨림' },
  { item: 2, file: 'components/SeatStatus.tsx', test: 'S4-2.', before: 'setInterval(() => setNow(Date.now()), 1000)', after: 'setInterval(() => undefined, 1000)', bug: '응답 없음 시간이 늘어나지 않음' },
  { item: 2, file: 'components/SeatStatus.tsx', test: 'S4-2.', before: "snapshot.stop.global.active || seat.state === 'stopped'", after: 'false', bug: '긴급 정지 중에도 계속 시간을 셈' },
  { item: 3, file: 'screens/Seat.tsx', test: 'S4-3.', before: "operator: '운영자 배정'", after: "operator: '대표 배정'", bug: '바꾼 주체를 대표로 잘못 표시함' },
  { item: 4, file: 'screens/Seat.tsx', test: 'S4-4.', before: "section.unverified ? 'unverified-section' : 'verified-section'", after: "false ? 'unverified-section' : 'verified-section'", bug: '인계 메모를 사실과 같은 테두리로 표시함' },
  { item: 4, file: 'screens/Seat.tsx', test: 'S4-4.', before: 'section.omitted > 0', after: 'section.omitted > 9999', bug: '빠진 항목 건수를 숨김' },
  { item: 5, file: 'screens/Seat.tsx', test: 'S4-5.', before: 'cursor: page.nextCursor', after: 'cursor: undefined', bug: '더 보기에서 첫 페이지를 다시 불러옴' },
  { item: 5, file: 'screens/Seat.tsx', test: 'S4-5.', before: 'entry.promise.stale &&', after: 'false &&', bug: '오래된 약속 표시를 숨김' },
  { item: 5, file: 'screens/Seat.tsx', test: 'S4-5-filters.', before: 'openPromisesOnly: e.target.checked', after: 'openPromisesOnly: false', bug: '열린 약속 필터를 무시함' },
  { item: 6, file: 'lib/notice.ts', test: 'S4-6.', before: "link: { tab: 'seat' }, command: null", after: "link: { tab: 'projects' }, command: null", bug: '응답 없음 알림을 홈으로 잘못 연결함' },
  { item: 6, file: 'components/ActivityMarker.tsx', test: 'S4-6.', before: "item.kind === 'seat' || item.kind === 'journal'", after: 'false', bug: '자리와 일지 활동 아이콘을 제거함' },
  { item: 7, file: 'screens/Settings.tsx', test: 'S4-7.', before: '바꾸면 운영자 배정으로 기록됩니다. AI 종류를 바꾸면 새 세대가 되고, 모델이나 노력치만 바꾸면 다음 턴부터 적용됩니다.', after: '설정을 바꿀 수 있습니다.', bug: '운영자 배정과 세대 변경 안내를 제거함' },
  { item: 7, file: 'screens/Settings.tsx', test: 'S4-7.', before: 'disabled={!desktop}><AiConfigForm', after: 'disabled={false}><AiConfigForm', bug: '서버의 메인 AI 폼을 활성화함' },
  { item: 'no-swap', file: 'components/SeatStatus.tsx', test: 'S4-no-swap.', before: 'onClick={open}', after: "onClick={() => { void import('../api/store').then(({ call }) => call('settings.update', {})); open(); }}", bug: '보유자 칩에 설정 쓰기 호출을 몰래 추가함' },
  { item: 8, file: 'api/fake/seat.ts', test: 'S4-8.', before: "seat.pendingHolder = codex;", after: 'seat.pendingHolder = null;', bug: '교체 중 fake의 다음 보유자를 누락함' },
];
const results = [];
for (const mutant of mutants) {
  const file = resolve('src/renderer/src', mutant.file), original = readFileSync(file), source = original.toString('utf8');
  if (source.split(mutant.before).length !== 2) throw new Error(`Expected one anchor: ${mutant.bug}`);
  try {
    writeFileSync(file, source.replace(mutant.before, mutant.after));
    const run = spawnSync(process.execPath, [resolve('node_modules/vitest/vitest.mjs'), 'run', '--config',
      'src/renderer/tools/vitest.config.ts', 'src/renderer/src/components/stage4-seat.test.ts', '-t', mutant.test], {
      encoding: 'utf8', timeout: 60000, windowsHide: true,
      env: { ...process.env, TMP: temp, TEMP: temp, NODE_DISABLE_COMPILE_CACHE: '1' },
    });
    const text = `${run.stdout ?? ''}\n${run.stderr ?? ''}`.replace(/\x1b\[[0-9;]*m/g, '');
    const killed = run.status !== 0 && /AssertionError/.test(text) && /Tests\s+.*failed/.test(text);
    results.push({ item: mutant.item, test: mutant.test, file: mutant.file, bug: mutant.bug, exitCode: run.status, killed,
      evidence: text.split('\n').filter(line => /FAIL|AssertionError|Tests\s+|Test Files\s+/.test(line)).slice(0, 7) });
    console.log(`item ${mutant.item} ${mutant.test}: ${killed ? 'KILLED' : 'SURVIVED / ERROR'}`);
  } finally {
    writeFileSync(file, original);
    if (!readFileSync(file).equals(original)) throw new Error(`Restoration failed: ${file}`);
  }
}
writeFileSync(resolve(output, 'mutation-results.json'), JSON.stringify({ sourceRestored: true, results }, null, 2) + '\n');
if (results.some(result => !result.killed)) process.exitCode = 1;
