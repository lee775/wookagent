// 시험 도우미 (tests/server/consoleSignals.test.ts, S2-17): launch.ps1이 띄운 콘솔에 빌드한 서버를 함께 붙여 띄우고,
// 서버의 출력·pid·끝난 결과를 파일로 남긴다. 인자는 설정 JSON 파일 하나: { outDir, argv }.
// 서버에 stdin을 물려줘야 libuv가 CREATE_NO_WINDOW를 붙이지 않아 서버가 이 콘솔을 같이 쓴다 — 그래야 이 콘솔에 낸 Ctrl+C·Ctrl+Break가 서버에 간다
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const { outDir, argv } = JSON.parse(readFileSync(process.argv[2], 'utf8'));
// 이 도우미도 같은 콘솔 이벤트를 받는다 — 끝나지 않고 서버가 끝날 때까지 남아 결과를 적는다
for (const s of ['SIGINT', 'SIGBREAK']) process.on(s, () => undefined);
const child = spawn(process.execPath, argv, { stdio: ['inherit', 'pipe', 'pipe'], windowsHide: true });
let out = '';
let err = '';
child.stdout.setEncoding('utf8').on('data', (c) => {
  out += c;
  writeFileSync(join(outDir, 'stdout.txt'), out);
});
child.stderr.setEncoding('utf8').on('data', (c) => {
  err += c;
  writeFileSync(join(outDir, 'stderr.txt'), err);
});
writeFileSync(join(outDir, 'pids.json'), JSON.stringify({ wrapper: process.pid, server: child.pid }));
child.on('exit', (code, signal) => {
  writeFileSync(join(outDir, 'exit.json'), JSON.stringify({ code, signal }));
  setTimeout(() => process.exit(0), 200);
});
