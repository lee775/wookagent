// 화면 약속 검사: 대표·데스크톱 운영자 메서드마다 가짜 브리지에 처리기가 있고 화면이 부르는지, 화면이 약속 밖 메서드를 부르지 않는지.
// 토픽은 여기서 보지 않는다 — 가짜 브리지의 구독자 표가 토픽 타입으로 묶여 있어 컴파일이 보고, tests/unit/ipcContract.test.ts가 IPC_TOPICS와
// 토픽 타입을 견준다 (리드 결정 S8-8)
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { invokedMethods } from './renderer-methods.mjs';

const root = resolve('src/renderer/src');
const contract = readFileSync(resolve('src/shared/ipc.ts'), 'utf8');
const list = name => contract.match(new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const`))?.[1] ?? '';
const methods = [...new Set([...`${list('OWNER_METHODS')} ${list('DESKTOP_OPERATOR_METHODS')}`.matchAll(/'([\w]+\.[\w]+)'/g)].map(match => match[1]))];
if (methods.length === 0) throw new Error('src/shared/ipc.ts에서 OWNER_METHODS·DESKTOP_OPERATOR_METHODS를 읽지 못했습니다');
function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]);
}
const sources = files(root).filter(path => /\.(tsx?|jsx?)$/.test(path) && !path.endsWith('.test.ts'));
const fake = readFileSync(resolve(root, 'api/fake/index.ts'), 'utf8');
const ui = sources.filter(path => !path.includes(`${join('api', 'fake')}`)).map(path => readFileSync(path, 'utf8')).join('\n');
const missingFake = methods.filter(method => !fake.includes(`'${method}':`));
const calls = invokedMethods(ui);
const missingUi = methods.filter(method => !calls.includes(method));
const forbiddenUi = calls.filter(method => !methods.includes(method));
console.log(`계약: 메서드 ${methods.length}개`);
console.log(`가짜 브리지 누락: ${missingFake.length ? missingFake.join(', ') : '없음'}`);
console.log(`화면 호출 누락: ${missingUi.length ? missingUi.join(', ') : '없음'}`);
console.log(`금지된 화면 호출: ${forbiddenUi.length ? forbiddenUi.join(', ') : '없음'}`);
if (missingFake.length || missingUi.length || forbiddenUi.length) process.exitCode = 1;
