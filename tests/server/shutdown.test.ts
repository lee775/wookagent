/**
 * 서버 종료 (SERVER_DESIGN 3.2, S2-5, S2-11 shutdown): 빌드한 서버가 모의 CLI 턴을 돌리는 중에
 * - 관리 채널 `shutdown`(Windows 백그라운드 실행에는 신호를 보낼 수 없어 이 길이 있다)으로, POSIX에서는 신호로도 (Windows 콘솔의 Ctrl+C·Ctrl+Break는 consoleSignals.test)
 * - backend.shutdown이 끝나고(턴을 정지로 끝냄) 남은 프로세스가 0이며, 잠금·관리 토큰이 없어지고 코드 0으로 끝난다
 * - 종료 중의 두 번째 요청은 종료 흐름을 다시 시작하지 않는다
 * 데이터 폴더는 하네스로 준비한다(프로젝트·hang 개발자·모의 메인) — 대표는 팀을 꾸리지 못한다
 */
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppSnapshot } from '@shared/views';
import { createHarness } from '../e2e/harness';
import { stillRunning } from '../acceptance/stops-helpers';
import { openStore } from '../../src/main/db/store';
import { dataPaths } from '../../src/main/orchestrator/paths';
import { processLiveness } from '../../src/main/process/processRunner';
import { buildServerTo, descendantsOf, invokeHttp, issueTokenBuilt, removeDir, runClient, runClientAsync, sleep, startBuilt, testBuildDir, type BuiltServer } from './helpers';

let buildDir = '';
let entry = '';
const dirs: string[] = [];
const servers: BuiltServer[] = [];

beforeAll(() => {
  buildDir = testBuildDir('shutdown');
  entry = buildServerTo(buildDir);
}, 120_000);

afterAll(async () => {
  for (const s of servers) if (s.child.exitCode === null && s.child.signalCode === null) s.child.kill();
  for (const d of dirs) await removeDir(d);
  await removeDir(buildDir);
});

/** hang 개발자가 있는 프로젝트를 준비한 데이터 폴더 */
async function seededDataDir(): Promise<{ dataDir: string; projectId: string }> {
  const h = await createHarness({ team: ['developer'], scenarios: { developer: 'hang' } });
  const out = { dataDir: h.dataDir, projectId: h.projectId };
  await h.close({ keepDirs: true });
  dirs.push(h.dataDir, join(h.projectDir, '..'));
  return out;
}

/** 서버를 띄우고 명령을 보내 모의 CLI 턴이 돌 때까지 — 그때의 자손 프로세스(서버보다 늦게 생긴 것) */
async function busyServer(): Promise<{ srv: BuiltServer; token: string; pids: number[] }> {
  const { dataDir, projectId } = await seededDataDir();
  const startedAt = Date.now();
  const srv = await startBuilt({ entry, dataDir, args: ['--allow-test-session'] });
  servers.push(srv);
  const token = issueTokenBuilt(entry, dataDir);
  const sent = await invokeHttp(srv.url, token, 'command.send', [{ target: projectId, text: '로그인 화면을 만들어 줘' }]);
  expect(sent.status).toBe(200);
  const deadline = Date.now() + 120_000;
  for (;;) {
    const snap = (await invokeHttp(srv.url, token, 'snapshot.get')).json<{ value: AppSnapshot }>().value;
    const devRunning = snap.tasks.some((t) => t.state === 'in_progress') && snap.running.total > 0;
    if (devRunning) break;
    if (Date.now() > deadline) throw new Error('모의 CLI 턴이 시작되지 않았습니다');
    await sleep(200);
  }
  await sleep(500);
  const all = descendantsOf(srv.child.pid);
  const created = await processLiveness.processCreatedAt(all);
  // 서버보다 먼저 생긴 것(부모 pid가 다시 쓰인 남의 프로세스)은 빼고 센다
  const pids = all.filter((p) => (created.get(p) ?? 0) >= startedAt - 2000);
  return { srv, token, pids };
}

function turnsLeftOpen(dataDir: string): number {
  const store = openStore(dataPaths(dataDir).db);
  try {
    return store.turns.list().filter((t) => t.endedAt === null).length;
  } finally {
    store.close();
  }
}

describe('관리 채널 shutdown', () => {
  it('모의 CLI가 도는 중에 shutdown하면 backend.shutdown이 끝나고 남은 프로세스 0, 잠금·관리 토큰 없음, 코드 0', async () => {
    const { srv, pids } = await busyServer();
    expect(pids.length).toBeGreaterThan(0);
    const stopAt = Date.now();
    const down = runClient(entry, ['shutdown', '--data-dir', srv.dataDir]);
    expect([down.code, down.stdout.trim()]).toEqual([0, '서버를 종료했습니다.']);
    const exit = await srv.exited;
    expect(exit.code).toBe(0);
    expect(stillRunning(pids, stopAt)).toEqual([]);
    expect(existsSync(join(srv.dataDir, 'server.lock'))).toBe(false);
    expect(existsSync(join(srv.dataDir, 'admin.token'))).toBe(false);
    const log = readFileSync(join(srv.dataDir, 'logs', 'server.log'), 'utf8');
    expect(log).toContain('관리 채널: shutdown 처리');
    expect(log).toContain('완전 종료 시작 (관리 채널 shutdown)');
    expect(log).toContain('체크포인트 저장·실행 정리 완료');
    expect(log).toContain('욱채 서버 종료 (코드 0)');
    // 턴은 정지로 끝났다 (backend.shutdown이 체크포인트를 남김)
    expect(turnsLeftOpen(srv.dataDir)).toBe(0);
  }, 300_000);

  // 동시에 보낸 두 요청 가운데 늦은 쪽은 '끝내는 중' 거부를 받거나, 이미 닫힌 채널을 만나 not_running이 된다 — 어느 쪽인지는 때에 따라 다르다.
  // 그래서 여기서는 종료 흐름이 한 번뿐인지만 본다. 종료가 시작된 뒤의 명령 거부 자체는 adminSocket.test가 정해진 차례로 본다 (S2-17)
  it('shutdown 두 개를 동시에 보내도 종료 흐름은 한 번만 돈다', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'wook-test-shutdown-twice-'));
    dirs.push(dataDir);
    const srv = await startBuilt({ entry, dataDir });
    servers.push(srv);
    const [a, b] = await Promise.all([runClientAsync(entry, ['shutdown', '--data-dir', dataDir]), runClientAsync(entry, ['shutdown', '--data-dir', dataDir])]);
    expect((await srv.exited).code).toBe(0);
    const codes = [a.code, b.code].sort();
    // 하나는 끝까지 기다려 0, 다른 하나는 '끝내는 중'(1)이거나 이미 끝난 서버를 만나(1) 실패한다
    expect(codes).toEqual([0, 1]);
    const log = readFileSync(join(dataDir, 'logs', 'server.log'), 'utf8');
    expect(log.match(/완전 종료 시작/g)).toHaveLength(1);
    expect(log.match(/관리 채널: shutdown 처리/g)).toHaveLength(1);
  }, 120_000);
});

describe('신호 (POSIX)', () => {
  it.for(['SIGTERM', 'SIGINT', 'SIGHUP'] as const)('%s도 같은 종료 흐름 — 남은 프로세스 0, 잠금 없음, 코드 0', { timeout: 300_000 }, async (signal, ctx) => {
    if (process.platform === 'win32') {
      ctx.skip(
        'Windows: kill(신호)은 신호를 보내지 않고 프로세스를 바로 끝낸다. Ctrl+C(SIGINT)·Ctrl+Break(SIGBREAK)는 consoleSignals.test가 콘솔 제어 이벤트로 본다. ' +
          'SIGTERM은 Windows에 없고, SIGHUP(콘솔 창 닫기)은 시험에서 낼 수 없어 보지 않는다 — 백그라운드 서버는 관리 채널 shutdown으로 끈다(위 시험)',
      );
    }
    const { srv, pids } = await busyServer();
    const stopAt = Date.now();
    srv.child.kill(signal);
    await sleep(100);
    // 종료 중 두 번째 신호는 무시한다
    srv.child.kill(signal);
    const exit = await srv.exited;
    expect(exit.code).toBe(0);
    expect(stillRunning(pids, stopAt)).toEqual([]);
    expect(existsSync(join(srv.dataDir, 'server.lock'))).toBe(false);
    const log = readFileSync(join(srv.dataDir, 'logs', 'server.log'), 'utf8');
    expect(log).toContain(`완전 종료 시작 (${signal})`);
    expect(log.match(/완전 종료 시작/g)).toHaveLength(1);
    expect(turnsLeftOpen(srv.dataDir)).toBe(0);
  });
});
