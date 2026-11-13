// 가짜 systemd-inhibit (리드 결정 S10-6.5) — 서버가 쥐는 `systemd-inhibit --what=sleep --mode=block /bin/sh -c 'echo "READY 1 power"; exec cat >/dev/null'`를
// Node로 흉내 낸다. 시험 전용. 잠금을 잡았으면 READY 줄을 내고, 표준 입력이 끝나면 놓고(released) 끝난다.
// 환경:
//   FAKE_INHIBIT_LOG       이 파일에 한 줄씩 덧붙인다 (start <pid> <번호> <시나리오> · ready · released · exit <까닭>)
//   FAKE_INHIBIT_SCENARIO  쉼표로 띄우기마다의 시나리오 (n번째 띄우기는 n번째 값, 모자라면 마지막 값). 띄우기 번호는 로그의 start 줄 수
//     ok · denied(‘Failed to inhibit: Access denied’로 1 — polkit) · no-bus(‘Failed to connect to bus: …’로 1) · crash(READY 전에 말없이 3) ·
//     no-ready(READY 없이 표준 입력 끝까지) · die-after-ready(READY 뒤 FAKE_INHIBIT_DIE_FILE-<번호>가 생기면 9) · ignore-eof(READY 뒤 표준 입력이 끝나도 남는다 —
//     끝내야 끝난다) · slow(FAKE_INHIBIT_GATE_FILE이 생길 때까지 READY를 내지 않는다)
// 안전: 어떤 경우든 5분 뒤에는 스스로 끝난다 — 시험이 이 프로세스를 PID로 끝내지 않아도 남지 않게
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

const logFile = process.env.FAKE_INHIBIT_LOG ?? '';
const log = (line) => {
  if (!logFile) return;
  try {
    appendFileSync(logFile, `${line}\n`);
  } catch {
    // 로그는 거들 뿐
  }
};
const launchNo = logFile && existsSync(logFile) ? readFileSync(logFile, 'utf8').split('\n').filter((l) => l.startsWith('start ')).length + 1 : 1;
const scenarios = (process.env.FAKE_INHIBIT_SCENARIO ?? 'ok').split(',');
const scenario = scenarios[Math.min(launchNo, scenarios.length) - 1] ?? 'ok';
log(`start ${process.pid} ${launchNo} ${scenario}`);
setTimeout(() => finish('lifetime', 0), 5 * 60_000).unref();

function finish(why, code) {
  log(`exit ${why}`);
  process.exit(code);
}

if (scenario === 'denied') {
  process.stderr.write('Failed to inhibit: Access denied\n');
  finish('denied', 1);
} else if (scenario === 'no-bus') {
  process.stderr.write('Failed to connect to bus: No medium found\n');
  finish('no-bus', 1);
} else if (scenario === 'crash') {
  finish('crash', 3);
} else {
  let ready = false;
  const sayReady = () => {
    ready = true;
    log('ready');
    process.stdout.write('READY 1 power\n');
  };
  if (scenario === 'slow') {
    const t = setInterval(() => {
      if (existsSync(process.env.FAKE_INHIBIT_GATE_FILE ?? '')) {
        clearInterval(t);
        sayReady();
      }
    }, 20);
  } else if (scenario !== 'no-ready') sayReady();
  if (scenario === 'die-after-ready') {
    const file = `${process.env.FAKE_INHIBIT_DIE_FILE ?? ''}-${launchNo}`;
    setInterval(() => {
      if (process.env.FAKE_INHIBIT_DIE_FILE && existsSync(file)) finish('die-after-ready', 9);
    }, 20);
  }
  process.stdin.resume();
  process.stdin.on('end', () => {
    if (scenario === 'ignore-eof') {
      log('eof ignored');
      // 끝내야 끝난다 — 이벤트 고리를 붙잡아 둔다
      setInterval(() => undefined, 1_000);
      return;
    }
    log(ready ? 'released' : 'released before ready');
    finish('eof', 0);
  });
}
