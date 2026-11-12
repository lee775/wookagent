// 가짜 서버 도우미 (리드 결정 S9-11) — WookServerHelper.exe와 같은 표준 입출력 약속을 Node로 흉내 낸다. 시험 전용.
//   node fakeServerHelper.mjs pipe --name <이름>   관리 채널: 그 이름에 Node 파이프를 열고 연결의 바이트를 OPEN·DATA·END로 넘긴다 (DATA·END·KILL·CLOSE를 받는다)
//   node fakeServerHelper.mjs power                절전 방지: READY 1 power, AWAKE → OK awake, RELAX → OK idle, PING → OK <상태>
// 환경:
//   FAKE_SH_LOG       이 파일에 한 줄씩 덧붙인다 (start <pid> <mode> <launch> · cmd <명령> <id> · kill <id> · exit <까닭>) — 바이트는 적지 않는다
//   FAKE_SH_SCENARIO  쉼표로 띄우기마다의 시나리오 (n번째 띄우기는 n번째 값, 모자라면 마지막 값). 띄우기 번호는 로그의 같은 mode start 줄 수
//     ok · fail-init · fail-inuse · no-ready · die-on-file(FAKE_SH_DIE_FILE이 생기면 9로 끝남) · die-on-file-n(FAKE_SH_DIE_FILE-<띄우기 번호>가 생기면 9로 끝남) ·
//     die-after-ready · huge-line(첫 OPEN 뒤 1.1MiB 줄) · garbage(첫 OPEN 뒤 약속에 없는 줄) · split(받은 덩어리를 세 DATA로, 줄도 두 번에 나눠 쓴다) ·
//     bad-version(READY 9 …) · ignore-close(CLOSE·표준 입력 끝을 무시 — 끝내야 끝난다) ·
//     power-no-ready · power-no-ack · power-crash(AWAKE에 9로 끝남) · power-ignore-eof(표준 입력이 끝나도 남는다 — 끝내야 끝난다) ·
//     power-die-on-file-n(ok처럼 답하다가 FAKE_SH_DIE_FILE-<띄우기 번호>가 생기면 9로 끝남)
//   FAKE_SH_DELAY_MS  표준 출력의 줄마다 이만큼 늦춘다 (느린 PC 흉내 — 순서는 그대로)
//   FAKE_SH_IN_DELAY_MS 표준 입력의 줄마다와 입력의 끝을 이만큼 늦게 처리한다 (느린 PC 흉내 — 순서는 그대로, 리드 결정 S9-22 TI-2)
// 안전: 표준 입력이 끝나면 끝난다(power-ignore-eof만 예외). 어떤 경우든 5분 뒤에는 스스로 끝난다 — 시험이 이 프로세스를 PID로 끝내지 않아도 남지 않게
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';

const [mode, flag, name] = process.argv.slice(2);
const logFile = process.env.FAKE_SH_LOG ?? '';
const delayMs = Number(process.env.FAKE_SH_DELAY_MS ?? 0) || 0;
const log = (line) => {
  if (logFile) {
    try {
      appendFileSync(logFile, `${line}\n`);
    } catch {
      // 로그는 거들 뿐
    }
  }
};
const launchNo = (() => {
  let n = 1;
  if (logFile && existsSync(logFile)) n = readFileSync(logFile, 'utf8').split('\n').filter((l) => l.startsWith('start ') && l.split(' ')[2] === mode).length + 1;
  return n;
})();
const scenarios = (process.env.FAKE_SH_SCENARIO ?? 'ok').split(',');
const scenario = scenarios[Math.min(launchNo, scenarios.length) - 1] ?? 'ok';
log(`start ${process.pid} ${mode} ${launchNo} ${scenario}`);

const lifetime = setTimeout(() => finish('lifetime', 0), 5 * 60_000);
lifetime.unref();

let chain = Promise.resolve();
/** 표준 출력 한 줄 — 늦춤이 있으면 순서를 지켜 늦춘다 */
function out(line, split = false) {
  chain = chain.then(async () => {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    if (split && line.length > 2) {
      const half = Math.floor(line.length / 2);
      process.stdout.write(line.slice(0, half));
      await new Promise((r) => setTimeout(r, 5));
      process.stdout.write(`${line.slice(half)}\n`);
    } else {
      process.stdout.write(`${line}\n`);
    }
  });
  return chain;
}

function finish(why, code) {
  log(`exit ${why}`);
  void chain.then(() => process.exit(code));
}

const stdin = createInterface({ input: process.stdin, crlfDelay: Infinity });
// 느린 도우미 흉내 — 받은 줄과 입력의 끝을 늦게 처리한다(순서는 그대로)
const inDelay = Number(process.env.FAKE_SH_IN_DELAY_MS ?? 0) || 0;
if (inDelay) {
  const on = stdin.on.bind(stdin);
  stdin.on = (ev, fn) => on(ev, (...a) => setTimeout(() => fn(...a), inDelay));
}

/** 이 띄우기의 죽음 파일(FAKE_SH_DIE_FILE-<번호>)이 생기면 9로 끝난다 — 시험이 몇 번째 도우미를 언제 끝낼지 고른다 */
function dieOnNumberedFile() {
  const file = `${process.env.FAKE_SH_DIE_FILE ?? ''}-${launchNo}`;
  const t = setInterval(() => {
    if (process.env.FAKE_SH_DIE_FILE && existsSync(file)) {
      clearInterval(t);
      finish('die-on-file-n', 9);
    }
  }, 50);
}

if (mode === 'power') {
  let state = 'idle';
  if (scenario !== 'power-no-ready') void out('READY 1 power');
  if (scenario === 'power-die-on-file-n') dieOnNumberedFile();
  stdin.on('line', (line) => {
    log(`cmd ${line}`);
    if (line === 'AWAKE') {
      if (scenario === 'power-crash') return finish('crash', 9);
      if (scenario === 'power-no-ack') return;
      state = 'awake';
      void out('OK awake');
    } else if (line === 'RELAX') {
      if (scenario === 'power-no-ack') return;
      state = 'idle';
      void out('OK idle');
    } else if (line === 'PING') void out(`OK ${state}`);
    else if (line === 'QUIT') finish('quit relax', 0);
    else void out('ERR unknown');
  });
  stdin.on('close', () => {
    if (scenario === 'power-ignore-eof') {
      log('eof ignored');
      // 표준 입력이 끝나도 남는다 — 쥔 쪽이 끝내야 한다 (30초 뒤에는 스스로 끝난다)
      setTimeout(() => finish('ignored-eof timeout', 0), 30_000).unref?.();
      setInterval(() => undefined, 1000);
      return;
    }
    finish('eof relax', 0);
  });
} else if (mode === 'pipe' && flag === '--name' && name) {
  if (scenario === 'fail-init') {
    void out('FAIL INIT fake');
    finish('fail-init', 3);
  } else if (scenario === 'fail-inuse') {
    void out('FAIL INUSE');
    finish('fail-inuse', 4);
  } else {
    runPipe();
  }
} else {
  process.stderr.write('usage: fakeServerHelper.mjs power | pipe --name <name>\n');
  process.exit(2);
}

function runPipe() {
  const conns = new Map();
  let nextId = 0;
  let opened = 0;
  const split = scenario === 'split';
  const server = createServer((sock) => {
    const id = ++nextId;
    conns.set(id, sock);
    opened++;
    void out(`OPEN ${id}`, split);
    if (opened === 1 && scenario === 'huge-line') void out(`DATA ${id} ${'A'.repeat(1_100_000)}`);
    if (opened === 1 && scenario === 'garbage') void out('HELLO 1');
    sock.on('data', (d) => {
      if (split) {
        // 받은 덩어리를 세 조각(첫 바이트 · 가운데 · 나머지)의 DATA로 — 한 줄의 JSON이 여러 DATA에 걸친다. 각 줄도 두 번에 나눠 쓴다
        const cuts = [0, 1, Math.max(1, Math.floor(d.length / 2)), d.length];
        for (let i = 0; i < 3; i++) {
          const part = d.subarray(cuts[i], cuts[i + 1]);
          if (part.length) void out(`DATA ${id} ${part.toString('base64')}`, true);
        }
      } else {
        void out(`DATA ${id} ${d.toString('base64')}`);
      }
    });
    sock.on('close', () => {
      if (conns.delete(id)) void out(`END ${id}`, split);
    });
    sock.on('error', () => undefined);
  });
  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      void out('FAIL INUSE');
      finish('inuse', 4);
    } else {
      void out(`FAIL INIT ${error.code ?? 'listen'}`);
      finish('init', 3);
    }
  });
  server.listen(name, () => {
    if (scenario === 'no-ready') return;
    void out(scenario === 'bad-version' ? 'READY 9 pipe' : 'READY 1 pipe').then(() => {
      if (scenario === 'die-after-ready') finish('die-after-ready', 9);
    });
    if (scenario === 'die-on-file') {
      const file = process.env.FAKE_SH_DIE_FILE ?? '';
      const t = setInterval(() => {
        if (file && existsSync(file)) {
          clearInterval(t);
          finish('die-on-file', 9);
        }
      }, 50);
    }
    if (scenario === 'die-on-file-n') dieOnNumberedFile();
  });
  const closeAll = (why) => {
    if (scenario === 'ignore-close') {
      // CLOSE·표준 입력 끝을 무시한다 — 쥔 쪽이 끝내야 한다 (30초 뒤에는 스스로 끝난다)
      log(`ignored ${why}`);
      setTimeout(() => finish('ignored-close timeout', 0), 30_000).unref?.();
      return;
    }
    for (const s of conns.values()) s.destroy();
    conns.clear();
    server.close();
    finish(why, 0);
  };
  stdin.on('line', (line) => {
    const [verb, idText, b64] = line.split(' ');
    if (verb === 'CLOSE') return closeAll('close');
    log(`cmd ${verb} ${idText ?? ''}`);
    const sock = conns.get(Number(idText));
    if (!sock) return;
    if (verb === 'DATA' && b64) sock.write(Buffer.from(b64, 'base64'));
    else if (verb === 'END') sock.end();
    else if (verb === 'KILL') {
      conns.delete(Number(idText));
      sock.destroy();
    }
  });
  stdin.on('close', () => closeAll('eof'));
}
