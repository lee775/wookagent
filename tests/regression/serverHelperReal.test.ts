/**
 * serverHelperReal (리드 결정 S9-11): 실제 WookServerHelper.exe를 띄워 약속을 본다 — 시험 실행이 한 번 컴파일한 것(tests/setup/serverHelper.ts)을 쓴다.
 * csc가 없으면(Windows 밖 포함) 건너뛴다. 이 PC에서 띄워도 되는 것만 한다 (S9-13): 파이프 모드, 그리고 절전 방지 모드는 잠깐.
 * - power: READY 1 power, PING·AWAKE·RELAX의 OK, 표준 입력이 끝나면 스스로 풀고 0으로 끝난다
 * - pipe: READY, OPEN·DATA·END, END는 쓸 것을 다 쓴 뒤 닫는다(늦게 읽는 클라이언트도 다 받는다), KILL은 바로 닫는다, CLOSE로 끝난다,
 *   이미 쓰는 이름은 FAIL INUSE, 약속 밖 이름은 FAIL INIT
 * 띄운 도우미는 이 시험이 쥔 ChildProcess로만 끝낸다 — 끝나지 않은 것이 있으면 afterEach가 그 핸들로 끝내고 끝난 것을 확인한다 (리드 결정 S9-18)
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { connect, createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readHelperLines, serverHelperEnv } from '../../src/server/serverHelper';

const bin = process.env['WOOK_TEST_SERVER_HELPER_BIN'];
const exe = bin ? join(bin, 'WookServerHelper.exe') : '';
const ready = process.platform === 'win32' && !!bin && existsSync(exe);
/** 느린 PC 흉내 (리드 결정 S9-18) — 단계 사이에 이만큼 쉰다 */
const PAUSE = Number(process.env['WOOK_TEST_PAUSE_MS'] ?? 0) || 0;
const pause = (): Promise<void> => new Promise((r) => setTimeout(r, PAUSE));
/** 답이 올 것을 기다리는 창 — 넉넉하게 (느린 PC에서도 실패가 아니다) */
const ANSWER_MS = 15_000;

interface Helper {
  child: ChildProcessWithoutNullStreams;
  lines: string[];
  /** pred에 맞는 줄이 올 때까지 (이미 왔으면 바로). 줄을 소비한다 */
  next(pred: (line: string) => boolean, label: string, ms?: number): Promise<string>;
  send(line: string): void;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

const started: Helper[] = [];

function run(args: string[]): Helper {
  const child = spawn(exe, args, { env: serverHelperEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const lines: string[] = [];
  const waiters: (() => void)[] = [];
  readHelperLines(
    child.stdout,
    (line) => {
      lines.push(line);
      for (const w of waiters.splice(0)) w();
    },
    () => lines.push('<overflow>'),
  );
  child.stdin.on('error', () => undefined);
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => child.once('exit', (code, signal) => r({ code, signal })));
  const h: Helper = {
    child,
    lines,
    exited,
    send: (line) => void child.stdin.write(`${line}\n`),
    async next(pred, label, ms = ANSWER_MS) {
      const deadline = Date.now() + ms;
      for (;;) {
        const i = lines.findIndex(pred);
        if (i >= 0) return lines.splice(i, 1)[0]!;
        const left = deadline - Date.now();
        if (left <= 0) throw new Error(`도우미의 줄을 기다리다 시간이 지났습니다: ${label} (받은 줄 ${lines.map((l) => l.slice(0, 30)).join(' | ')})`);
        await new Promise<void>((r) => {
          const t = setTimeout(r, Math.min(left, 200));
          waiters.push(() => {
            clearTimeout(t);
            r();
          });
        });
      }
    },
  };
  started.push(h);
  return h;
}

afterEach(async () => {
  // 이 시험이 띄운 것만, 쥔 핸들로 — 아직 끝나지 않았으면 끝내고 끝난 것을 확인한다
  for (const h of started.splice(0)) {
    if (h.child.exitCode === null && h.child.signalCode === null) h.child.kill();
    await h.exited;
  }
});

const pipeName = (): string => `\\\\.\\pipe\\wook-admin-s9a-test-${randomBytes(8).toString('hex')}`;

/** 로컬 클라이언트 — 보낼 것을 쓰고, readDelayMs만큼 읽지 않다가 읽는다. 끊길 때까지 받은 것 */
function client(name: string, send: string, readDelayMs = 0): Promise<{ got: string; error: string | null }> {
  return new Promise((resolve) => {
    const s = connect(name);
    let got = '';
    let error: string | null = null;
    s.setEncoding('utf8');
    s.on('connect', () => {
      s.write(send);
      if (readDelayMs) {
        s.pause();
        setTimeout(() => s.resume(), readDelayMs);
      }
    });
    s.on('data', (d: string) => (got += d));
    s.on('error', (e: NodeJS.ErrnoException) => (error = e.code ?? e.message));
    s.on('close', () => resolve({ got, error }));
  });
}

describe.skipIf(!ready)('serverHelperReal — 실제 서버 도우미', () => {
  it('power: READY 1 power, PING·AWAKE·RELAX에 OK로 답하고, 표준 입력이 끝나면 스스로 풀고 0으로 끝난다', async () => {
    const h = run(['power']);
    expect(await h.next((l) => l.startsWith('READY'), 'READY')).toBe('READY 1 power');
    await pause();
    h.send('PING');
    expect(await h.next((l) => l.startsWith('OK'), 'PING')).toBe('OK idle');
    h.send('AWAKE');
    expect(await h.next((l) => l.startsWith('OK'), 'AWAKE')).toBe('OK awake');
    await pause();
    h.send('PING');
    expect(await h.next((l) => l.startsWith('OK'), 'PING awake')).toBe('OK awake');
    h.send('RELAX');
    expect(await h.next((l) => l.startsWith('OK'), 'RELAX')).toBe('OK idle');
    h.send('AWAKE');
    expect(await h.next((l) => l.startsWith('OK'), 'AWAKE again')).toBe('OK awake');
    h.send('WHAT');
    expect(await h.next((l) => l.startsWith('ERR'), 'unknown')).toBe('ERR unknown');
    // 막은 채로 표준 입력을 닫는다 — 풀고 스스로 끝난다(이 시험은 끝내지 않는다)
    const t0 = Date.now();
    h.child.stdin.end();
    const exit = await h.exited;
    expect(exit).toEqual({ code: 0, signal: null });
    // 기록용: 표준 입력이 끝난 뒤 끝나기까지 (제품은 1초 뒤에 끝낸다 — 이 시험은 스스로 끝났는지를 본다)
    expect(Date.now() - t0).toBeLessThan(ANSWER_MS);
  }, 60_000);

  it('pipe: READY 뒤 OPEN·DATA를 넘기고, END는 쓴 것을 다 보낸 뒤 닫는다 — 늦게 읽는 클라이언트도 100KB를 다 받는다', async () => {
    const name = pipeName();
    const h = run(['pipe', '--name', name]);
    expect(await h.next((l) => l.startsWith('READY') || l.startsWith('FAIL'), 'READY')).toBe('READY 1 pipe');
    const reply = `pong-${'x'.repeat(100_000)}\n`;
    for (const readDelay of [0, 1500]) {
      const c = client(name, 'ping\n', readDelay);
      const open = await h.next((l) => l.startsWith('OPEN '), 'OPEN');
      const id = open.split(' ')[1]!;
      const data = await h.next((l) => l.startsWith(`DATA ${id} `), 'DATA');
      expect(Buffer.from(data.split(' ')[2]!, 'base64').toString()).toBe('ping\n');
      await pause();
      h.send(`DATA ${id} ${Buffer.from(reply).toString('base64')}`);
      h.send(`END ${id}`);
      expect(await c).toEqual({ got: reply, error: null });
      expect(await h.next((l) => l === `END ${id}`, 'END')).toBe(`END ${id}`);
    }
    // KILL — 바로 닫는다(남은 것을 보내지 않는다)
    const killed = client(name, 'hello\n');
    const id = (await h.next((l) => l.startsWith('OPEN '), 'OPEN kill')).split(' ')[1]!;
    await h.next((l) => l.startsWith(`DATA ${id} `), 'DATA kill');
    h.send(`KILL ${id}`);
    expect(await killed).toEqual({ got: '', error: null });
    h.send('CLOSE');
    expect(await h.exited).toEqual({ code: 0, signal: null });
    // KILL한 연결에는 END를 알리지 않는다
    expect(h.lines.filter((l) => l === `END ${id}`)).toEqual([]);
  }, 60_000);

  it('pipe: 클라이언트가 먼저 끊으면 END를 알리고, 표준 입력이 끝나면 열린 연결을 닫고 0으로 끝난다', async () => {
    const name = pipeName();
    const h = run(['pipe', '--name', name]);
    expect(await h.next((l) => l.startsWith('READY') || l.startsWith('FAIL'), 'READY')).toBe('READY 1 pipe');
    const s = connect(name);
    s.on('error', () => undefined);
    const id = (await h.next((l) => l.startsWith('OPEN '), 'OPEN')).split(' ')[1]!;
    s.destroy();
    expect(await h.next((l) => l === `END ${id}`, 'END after client close')).toBe(`END ${id}`);
    const held = client(name, 'stay\n');
    await h.next((l) => l.startsWith('OPEN '), 'OPEN held');
    h.child.stdin.end();
    expect(await h.exited).toEqual({ code: 0, signal: null });
    expect((await held).got).toBe('');
  }, 60_000);

  it('pipe: 그 이름을 이미 누가 쓰면 FAIL INUSE(4), 약속 밖 이름은 FAIL INIT bad_name(3)', async () => {
    const name = pipeName();
    const taken: Server = createServer((s) => s.destroy());
    await new Promise<void>((r) => taken.listen(name, () => r()));
    try {
      const h = run(['pipe', '--name', name]);
      expect(await h.next(() => true, 'FAIL')).toBe('FAIL INUSE');
      expect(await h.exited).toEqual({ code: 4, signal: null });
    } finally {
      await new Promise<void>((r) => taken.close(() => r()));
    }
    const bad = run(['pipe', '--name', '\\\\.\\pipe\\someone-else']);
    expect(await bad.next(() => true, 'FAIL bad name')).toBe('FAIL INIT bad_name');
    expect(await bad.exited).toEqual({ code: 3, signal: null });
  }, 60_000);

  it('--probe는 판과 비트를 한 줄로 답한다', async () => {
    const h = run(['--probe']);
    const line = await h.next(() => true, 'probe');
    expect(JSON.parse(line)).toEqual({ __wookServer: 'probe', ok: true, version: 1, bits: 64 });
    expect(await h.exited).toEqual({ code: 0, signal: null });
  });
});
