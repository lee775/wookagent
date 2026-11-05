/**
 * 준비 전에 온 신호는 시작을 그만두게 한다 (SERVER_DESIGN 3.2, S2-5·S2-16 — 리뷰 lifecycle-guarantees의 zz-lc-lockhang이 드러낸 것: 신호를 준비 뒤로
 * 미루기만 해서, 시작이 멈추면 Ctrl+C로도 끝나지 않았다). 시작 단계(잠금·백엔드·HTTP)가 끝날 때마다 보고, 연 것을 닫고 잠금을 놓은 뒤 1로 끝낸다.
 * 서버 한살이(runServe)를 이 프로세스 안에서 돌리고 신호는 process.emit으로 낸다 — 운영체제가 신호를 보내는 길(POSIX kill, Windows 콘솔 Ctrl+C·Ctrl+Break)은
 * shutdown.test와 S2-17의 시험이 본다. 쓰다 만 잠금 파일(빈 파일)을 두어 잠금을 2초 지켜보는 동안 신호를 보낸다
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runServe } from '../../src/server/serve';
import { removeDir, sleep } from './helpers';

const WATCHED = ['uncaughtException', 'unhandledRejection', 'SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const;
const before = new Map<string, unknown[]>();
let dataDir = '';

beforeAll(() => {
  for (const e of WATCHED) before.set(e, process.listeners(e as NodeJS.Signals));
  dataDir = mkdtempSync(join(tmpdir(), 'wook-test-start-cancel-'));
});

afterAll(async () => {
  // runServe가 건 처리기를 걷는다 (이 시험 프로세스는 서버가 아니다)
  for (const e of WATCHED) {
    for (const l of process.listeners(e as NodeJS.Signals)) {
      if (!before.get(e)!.includes(l)) process.removeListener(e, l as (...args: unknown[]) => void);
    }
  }
  await removeDir(dataDir);
});

describe('준비 전 신호 (S2-16)', () => {
  it('잠금을 잡는 동안 온 신호는 시작을 그만두게 한다 — 잡은 잠금을 놓고, 백엔드를 만들지 않고, 기록 파일을 가리키며 1로 끝낸다', async () => {
    // 쓰다 만 잠금 — 같은 내용을 2초 지켜본 뒤에야 넘겨받는다
    writeFileSync(join(dataDir, 'server.lock'), '');
    const out: string[] = [];
    const err: string[] = [];
    const exits: number[] = [];
    const io = { out: async (t: string) => void out.push(t), err: async (t: string) => void err.push(t), exit: (c: number) => void exits.push(c) };
    const logFile = join(dataDir, 'logs', 'server.log');
    const started = runServe({ dataDir, bind: '127.0.0.1', port: 0, webDir: null, allowTestSession: false }, io);
    const deadline = Date.now() + 20_000;
    while (!(existsSync(logFile) && readFileSync(logFile, 'utf8').includes('욱채 서버 시작'))) {
      if (Date.now() > deadline) throw new Error('서버가 시작 기록을 남기지 않았습니다');
      await sleep(20);
    }
    process.emit('SIGHUP', 'SIGHUP');
    // 두 번째 신호는 무시한다 (글은 첫 신호)
    process.emit('SIGINT', 'SIGINT');
    const code = await started;
    expect(code).toBe(1);
    expect(err.join('')).toBe(`욱채 서버를 시작하지 못했습니다: 준비되기 전에 종료 신호(SIGHUP)를 받아 시작을 그만두었습니다\n자세한 기록: ${logFile}\n`);
    expect({ out, exits }).toEqual({ out: [], exits: [] });
    // 넘겨받은 잠금을 놓았다. 백엔드(저장소·백엔드 기록)를 만들지 않았다
    expect(existsSync(join(dataDir, 'server.lock'))).toBe(false);
    expect(existsSync(join(dataDir, 'wook.db'))).toBe(false);
    expect(existsSync(join(dataDir, 'logs', 'backend.log'))).toBe(false);
    const log = readFileSync(logFile, 'utf8');
    expect(log).toContain('[INFO] 종료 신호 받음 (SIGHUP)');
    expect(log).toContain('[ERROR] 시작 실패: 준비되기 전에 종료 신호(SIGHUP)를 받아 시작을 그만두었습니다');
  }, 60_000);
});
