import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { invokedMethods } from './renderer-methods.mjs';

const root = resolve('src/renderer/src');
const contract = readFileSync(resolve('src/shared/ipc.ts'), 'utf8');
const list = name => contract.match(new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const`))?.[1] ?? '';
const methods = [...new Set([...`${list('OWNER_METHODS')} ${list('DESKTOP_OPERATOR_METHODS')}`.matchAll(/'([\w]+\.[\w]+)'/g)].map(match => match[1]).concat('system.recheckAi'))];
const topics = [...contract.matchAll(/^  (snapshot|cliEvents|notification|navigate|emergency|openSettings):/gm)].map(match => match[1]);
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
const missingTopics = topics.filter(topic => !fake.includes(`${topic}: new Set()`));
console.log(`계약: 메서드 ${methods.length}개, 토픽 ${topics.length}개`);
console.log(`가짜 브리지 누락: ${missingFake.length ? missingFake.join(', ') : '없음'}`);
console.log(`화면 호출 누락: ${missingUi.length ? missingUi.join(', ') : '없음'}`);
console.log(`가짜 토픽 누락: ${missingTopics.length ? missingTopics.join(', ') : '없음'}`);
console.log(`금지된 화면 호출: ${forbiddenUi.length ? forbiddenUi.join(', ') : '없음'}`);
if (missingFake.length || missingUi.length || missingTopics.length || forbiddenUi.length) process.exitCode = 1;
