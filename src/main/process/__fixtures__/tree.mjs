// 후손 프로세스를 만들고 PID를 JSON 한 줄로 알린다.
// 사용: node tree.mjs <후손 수> <stay|exit> [orphan] [hold] [prompt]
//   stay   : 알린 뒤 계속 살아 있음 / exit: 알린 뒤 바로 끝남(후손은 남음)
//   orphan : 중간 부모가 먼저 끝나 고아가 된 후손 1개 추가 (taskkill /T로는 찾을 수 없음)
//   hold   : 후손이 stdout·stderr를 물려받아 파이프를 계속 잡고 있음
//   prompt : 표준 입력(프롬프트)을 끝까지 읽은 뒤에 후손을 만든다 — 프롬프트를 읽고서야 일을 시작하는 CLI처럼
import { spawn } from 'node:child_process';

const count = Number(process.argv[2] ?? '2');
const stay = (process.argv[3] ?? 'stay') === 'stay';
const withOrphan = process.argv.includes('orphan');
const hold = process.argv.includes('hold');
if (process.argv.includes('prompt')) {
  for await (const _chunk of process.stdin) {
    // 프롬프트는 읽기만 한다
  }
}
// Windows: detached여야 이 스크립트(libuv) job에 들지 않아 부모가 끝나도 남는다 (개발 서버처럼).
// POSIX: detached면 setsid로 그룹을 떠나므로 그대로 둔다.
const detached = process.platform === 'win32';
// 안전장치: 테스트가 정리하지 못해도 60초 뒤 스스로 끝난다
const sleeper = ['-e', 'setTimeout(() => {}, 60000)'];

const pids = [];
for (let i = 0; i < count; i++) {
  const c = spawn(process.execPath, sleeper, {
    detached,
    stdio: hold ? ['ignore', 'inherit', 'inherit'] : 'ignore',
    windowsHide: true,
  });
  c.unref();
  pids.push(c.pid);
}
if (withOrphan) {
  const code = [
    "const c = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'],",
    `{ detached: ${detached}, stdio: 'ignore', windowsHide: true });`,
    'c.unref(); process.stdout.write(String(c.pid));',
  ].join(' ');
  const mid = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
  let out = '';
  mid.stdout.setEncoding('utf8');
  mid.stdout.on('data', (d) => {
    out += d;
  });
  await new Promise((r) => mid.on('close', r));
  pids.push(Number(out));
}
process.stdout.write(`${JSON.stringify({ tree: pids, self: process.pid })}\n`);
if (stay) setTimeout(() => {}, 60000);
