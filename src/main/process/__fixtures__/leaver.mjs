// 프로세스 그룹을 떠나는 후손(setsid — Node detached)을 만들고 그 PID를 JSON 한 줄로 알린다 (POSIX 시험, 리드 결정 S10-5.5).
// 사용: node leaver.mjs <stay|exit> <env|scrub> <direct|orphan> <그만 파일 경로>
//   stay·exit : 알린 뒤 계속 살아 있음 / 바로 끝남
//   env·scrub : 떠난 후손이 환경을 물려받음 / 빈 환경으로 시작(환경을 지움 — 실행 표시도 없다)
//   direct    : 이 프로세스가 직접 띄운다 (부모가 살아 있는 동안 부모 PID로 이어진다)
//   orphan    : 중간 프로세스가 띄우고 곧바로 끝난다 (부모가 먼저 끝난 후손 — 부모 PID로는 이어지지 않는다)
// 떠난 후손은 그만 파일이 생기면 스스로 끝난다(60초 안전장치) — 시험은 기록한 PID로 죽이지 않는다
import { spawn } from 'node:child_process';

const [, , mode = 'stay', envMode = 'env', how = 'direct', quit = ''] = process.argv;
const KEEP = "const q=process.argv[1];setInterval(()=>{if(q&&require('fs').existsSync(q))process.exit(0)},100);setTimeout(()=>process.exit(0),60000)";
const opts = { detached: true, stdio: 'ignore', ...(envMode === 'scrub' ? { env: {} } : {}) };

let leaver;
if (how === 'direct') {
  const c = spawn(process.execPath, ['-e', KEEP, quit], opts);
  c.unref();
  leaver = c.pid;
} else {
  const code = `const c=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(KEEP)},process.argv[1]],${JSON.stringify(opts)});c.unref();process.stdout.write(String(c.pid))`;
  const mid = spawn(process.execPath, ['-e', code, quit], { stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  mid.stdout.setEncoding('utf8');
  mid.stdout.on('data', (d) => (out += d));
  await new Promise((r) => mid.on('close', r));
  leaver = Number(out);
}
process.stdout.write(`${JSON.stringify({ leaver, self: process.pid })}\n`);
if (mode === 'stay') {
  setInterval(() => undefined, 1000);
  setTimeout(() => process.exit(0), 60000);
}
