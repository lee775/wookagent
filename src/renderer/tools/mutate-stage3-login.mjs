import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve('src/renderer/src');
const output = resolve('docs/design/permission-ui/stage3-login');
const temp = resolve('src/renderer/.stage3-test-temp');
mkdirSync(output, { recursive: true }); mkdirSync(temp, { recursive: true });
const mutants = [
  { item: 1, file: 'components/ServerLogin.tsx', test: 'S3-login-code.', before: '다른 사람이 보내 준 코드는 넣지 마세요.', after: '다른 사람이 보내 준 코드도 사용할 수 있습니다.', bug: '피싱 경고를 잘못된 안내로 바꿈' },
  { item: 1, file: 'components/ServerLogin.tsx', test: 'S3-login-poll.', before: "call('auth.deviceLoginPoll', start.loginId)", after: "call('auth.deviceLoginPoll', 'wrong-login')", bug: '시작한 로그인과 다른 ID를 폴링함' },
  { item: 1, file: 'components/ServerLogin.tsx', test: 'S3-login-terminal.', before: 'result.message ?? fallback[result.status]', after: 'fallback[result.status]', bug: '거절과 만료의 서버 메시지를 버림' },
  { item: 2, file: 'components/ServerLogin.tsx', test: 'S3-setup.', before: "call('auth.setupOwner', code.trim(), email.trim())", after: "call('auth.setupOwner', email.trim(), code.trim())", bug: '설정 코드와 이메일의 전달 순서를 뒤집음' },
  { item: 3, file: 'components/DeviceList.tsx', test: 'S3-devices.', before: 'device.current && <span', after: 'false && <span', bug: '현재 기기의 표시를 없앰' },
  { item: 3, file: 'components/DeviceList.tsx', test: 'S3-devices.', before: 'revoking || !window.confirm(question)', after: 'revoking', bug: '기기 끊기의 확인을 생략함' },
  { item: 3, file: 'components/DeviceList.tsx', test: 'S3-current-device.', before: "if (device.current) window.dispatchEvent(new Event('wook:unauthorized'));", after: "if (false) window.dispatchEvent(new Event('wook:unauthorized'));", bug: '이 기기를 끊어도 화면이 로그인 상태로 남음' },
  { item: 3, file: 'components/DeviceList.tsx', test: 'S3-desktop.', before: "call('auth.listDevices')", after: "Promise.resolve([])", bug: '데스크톱에서 기기 목록 호출을 생략함' },
  { item: 4, file: 'lib/notice.ts', test: 'S3-device-notice.', before: "if (key.startsWith('device-login:')) {\n    link = { tab: 'settings', section: 'account' };", after: "if (key.startsWith('device-login:')) {\n    link = { tab: 'projects' };\n    command = { projectId: null, text: '기기를 확인해 줘' };", bug: '새 기기 알림을 명령창 바로가기로 돌림' },
];
const results = [];
for (const mutant of mutants) {
  const file = resolve(root, mutant.file), original = readFileSync(file), source = original.toString('utf8');
  if (source.split(mutant.before).length !== 2) throw new Error(`Expected one anchor: ${mutant.bug}`);
  try {
    writeFileSync(file, source.replace(mutant.before, mutant.after));
    const run = spawnSync(process.execPath, [resolve('node_modules/vitest/vitest.mjs'), 'run', '--config', 'src/renderer/tools/vitest.config.ts',
      'src/renderer/src/components/stage3-login.test.ts', '-t', mutant.test], { encoding: 'utf8', timeout: 60000, windowsHide: true,
      env: { ...process.env, TMP: temp, TEMP: temp, NODE_DISABLE_COMPILE_CACHE: '1' } });
    const text = `${run.stdout ?? ''}\n${run.stderr ?? ''}`.replace(/\x1b\[[0-9;]*m/g, '');
    const killed = run.status !== 0 && /AssertionError/.test(text) && /Tests\s+.*failed/.test(text);
    results.push({ item: mutant.item, file: mutant.file, test: mutant.test, bug: mutant.bug, exitCode: run.status, killed,
      evidence: text.split('\n').filter(line => /FAIL|AssertionError|Tests\s+|Test Files\s+/.test(line)).slice(0, 8) });
    console.log(`item ${mutant.item} ${mutant.test}: ${killed ? 'KILLED' : 'SURVIVED / ERROR'}`);
  } finally {
    writeFileSync(file, original);
    if (!readFileSync(file).equals(original)) throw new Error(`Restoration failed: ${mutant.file}`);
  }
}
writeFileSync(resolve(output, 'mutation-results.json'), JSON.stringify({ sourceRestored: true, results }, null, 2) + '\n');
if (results.some(result => !result.killed)) process.exitCode = 1;
