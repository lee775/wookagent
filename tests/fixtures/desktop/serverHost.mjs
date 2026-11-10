// '서버와 함께 끝남' 시험용 서버 흉내 (리드 결정 S6-0·S6-5): 화면 도우미 클라이언트(desktopHelper.ts — Node 형식 제거로 불러온다)로
// 가짜 도우미를 띄우고 그 PID를 알린 뒤 기다린다. 시험이 이 프로세스를 강제로 끝내면(Windows: TerminateProcess) 도우미도 끝나야 한다 —
// 클라이언트는 도우미를 직접 띄우므로 Node(libuv)의 KILL_ON_JOB_CLOSE 작업 개체에 들어 있다. POSIX는 표준 입력이 닫혀 끝난다.
// 인자: <desktopHelper.ts 경로> <fakeDesktopHelper.mjs 경로> <화면 폴더>. 시나리오는 환경 변수 WOOK_FAKE_DESKTOP 그대로.
import { pathToFileURL } from 'node:url';

const defaults = process.listeners('warning');
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name === 'ExperimentalWarning' || w.code === 'MODULE_TYPELESS_PACKAGE_JSON') return;
  for (const l of defaults) l(w);
});

// 끝날 때까지 기다린다 (시험이 끝낸다) — 도우미 프로세스는 unref라 이것이 없으면 이 프로세스가 먼저 끝난다
setInterval(() => undefined, 60_000);
const [clientPath, fakePath, screensDir] = process.argv.slice(2);
const { createDesktopHelper } = await import(pathToFileURL(clientPath).href);
const env = {};
for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v;
const client = createDesktopHelper({
  launcher: { launch: () => ({ file: process.execPath, args: [fakePath], env }) },
  log: () => undefined,
  screensDir: () => screensDir,
});
const r = await client.ready();
process.stdout.write(r.ok ? `HELPER ${client.pid}\n` : `FAIL ${r.text}\n`);
