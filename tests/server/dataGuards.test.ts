/**
 * 빌드한 서버의 데이터 지키기 (SERVER_DESIGN 3.2·3.3, S2-5·S2-6·S2-14~S2-16 — 리뷰 lifecycle-guarantees의 zz-lc-copykill·zz-lc-lockhang·zz-lc-artifact를 옮김).
 * - 살아 있는 욱채의 데이터 폴더 복사본(앱의 백업 wook.db)이나 잠금 파일을 손으로 지운 폴더로는 시작하지 않는다 — 그 욱채의 CLI를 재시작 복구가 끊지 않고,
 *   복사본은 바꾸지 않는다 (S2-15). 저장소에 적힌 주인이 죽은 pid거나 pid를 다시 쓴 다른 프로세스면 그대로 시작한다. 깨끗이 끝나면 주인 기록을 지운다 (S2-20)
 * - 시각이 미래인 깨진 잠금에서도 준비된다 (S2-16 잠금 기다림)
 * - 쓸 수 없는 데이터 폴더: stderr는 쓰지 못한 기록 파일을 가리키지 않고, 날것의 스택을 내지 않는다 (S2-16)
 * - 데이터 폴더의 다른 이름(접합)으로도 운영자 명령이 실행 중인 서버에 닿는다 (S2-16)
 * - 준비 줄은 두 루프백을 함께 잡았다고 말한다 (S2-14)
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, sendCommand, type Harness } from '../e2e/harness';
import { acquireInstanceLock, type HeldInstanceLock } from '../../src/main/backend/instanceLock';
import { openStore } from '../../src/main/db/store';
import { processLiveness } from '../../src/main/process/processRunner';
import { buildServerTo, childEnv, clientJson, removeDir, REPO, runClient, startBuilt, testBuildDir, workspaceArgs, type BuiltServer } from './helpers';

const isWin = process.platform === 'win32';
let buildDir = '';
let entry = '';
const dirs: string[] = [];
const servers: BuiltServer[] = [];

beforeAll(() => {
  buildDir = testBuildDir('guards');
  entry = buildServerTo(buildDir);
}, 180_000);

afterAll(async () => {
  for (const s of servers) {
    if (s.child.exitCode === null && s.child.signalCode === null) {
      runClient(entry, ['shutdown', '--data-dir', s.dataDir]);
      await Promise.race([s.exited, new Promise((r) => setTimeout(r, 40_000))]);
      if (s.child.exitCode === null) s.child.kill();
    }
  }
  for (const d of dirs) await removeDir(d);
  await removeDir(buildDir);
}, 120_000);

const tempDir = (tag: string): string => {
  const d = mkdtempSync(join(tmpdir(), `wook-test-guards-${tag}-`));
  dirs.push(d);
  return d;
};

/** 서버를 띄워 끝날 때까지 (시작하지 못하는 경우) */
function serveOnce(dataDir: string): { code: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [entry, 'serve', '--data-dir', dataDir, '--port', '0', ...workspaceArgs(dataDir)], { cwd: REPO, env: childEnv(), encoding: 'utf8', windowsHide: true, timeout: 90_000 });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function shutdownBuilt(s: BuiltServer): Promise<void> {
  expect(runClient(entry, ['shutdown', '--data-dir', s.dataDir]).code).toBe(0);
  expect((await s.exited).code).toBe(0);
}

describe('살아 있는 욱채의 데이터 (S2-15)', () => {
  let h: Harness;
  let lock: HeldInstanceLock | null = null;
  let cliPid = 0;
  let cliCreatedAt: number | undefined;
  let turnId = '';
  let dev = '';

  beforeAll(async () => {
    // 첫 욱채: 데스크톱 앱처럼 실행 잠금을 잡고 저장소에 주인으로 적힌 채, 모의 CLI 하나가 돌고 있다
    const createdAt = (await processLiveness.processCreatedAt([process.pid])).get(process.pid) ?? null;
    h = await createHarness({ team: ['developer'], scenarios: { developer: 'hang' }, instance: { pid: process.pid, createdAt, kind: 'desktop', startedAt: new Date().toISOString() } });
    const held = await acquireInstanceLock({ dataDir: h.dataDir, kind: 'desktop' });
    if (!held.ok) throw new Error(held.message);
    lock = held;
    await sendCommand(h, '로그인 화면을 만들어 줘');
    dev = h.members.developer!;
    await h.waitFor(() => h.core.turns.isMemberRunning(dev) && !!h.core.turns.lastLineOf(dev)?.text.includes('업무를 시작합니다'), { timeoutMs: 120_000, label: '개발자 hang 턴' });
    const turn = h.core.ctx.store.turns.list().find((t) => t.memberId === dev && t.endedAt === null && t.process.pid !== null)!;
    turnId = turn.id;
    cliPid = turn.process.pid!;
    cliCreatedAt = (await processLiveness.processCreatedAt([cliPid])).get(cliPid);
  }, 240_000);

  afterAll(async () => {
    lock?.release();
    await h?.close();
  }, 120_000);

  /** 첫 욱채의 CLI가 같은 프로세스로 살아 있고 그 턴이 이어진다 */
  async function firstStillRuns(): Promise<void> {
    expect(alive(cliPid)).toBe(true);
    expect((await processLiveness.processCreatedAt([cliPid])).get(cliPid)).toBe(cliCreatedAt);
    expect(h.core.turns.isMemberRunning(dev)).toBe(true);
    expect(h.core.ctx.store.turns.require(turnId).endedAt).toBeNull();
  }

  it('복사본(앱의 백업 wook.db)으로는 시작하지 않는다 — 첫 욱채의 CLI를 끊지 않고 복사본을 바꾸지 않는다', async () => {
    const copyDir = tempDir('copy');
    h.core.ctx.store.backupTo(join(copyDir, 'wook.db'));
    const peek = () => {
      const store = openStore(join(copyDir, 'wook.db'));
      try {
        const t = store.turns.require(turnId);
        return { endedAt: t.endedAt, process: t.process, activity: store.activity.search({ limit: 1000 }).length, instance: store.kv.get('instance') };
      } finally {
        store.close();
      }
    };
    const before = peek();
    expect(before.endedAt).toBeNull();
    const r = serveOnce(copyDir);
    expect(r.code).toBe(1);
    expect(r.stdout).not.toContain('준비 완료');
    expect(r.stderr).toContain(
      `욱채 서버를 시작하지 못했습니다: 이 데이터는 실행 중인 욱채(데스크톱 앱, pid ${process.pid}, 데이터 폴더 ${h.dataDir})가 쓰고 있는 데이터입니다(복사본이거나 잠금 파일이 지워짐) — 그 욱채를 끝낸 뒤 다시 시작하세요\n자세한 기록: ${join(copyDir, 'logs', 'server.log')}\n`,
    );
    await firstStillRuns();
    // 복사본: 턴·활동 기록·주인 기록이 그대로, 잠금과 관리 토큰은 남지 않았다
    expect(peek()).toEqual(before);
    expect(existsSync(join(copyDir, 'server.lock'))).toBe(false);
    expect(existsSync(join(copyDir, 'admin.token'))).toBe(false);
  }, 180_000);

  it('잠금 파일을 손으로 지운 같은 데이터 폴더로도 시작하지 않는다 — 첫 욱채의 CLI가 살아 있다', async () => {
    unlinkSync(join(h.dataDir, 'server.lock'));
    const r = serveOnce(h.dataDir);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`욱채 서버를 시작하지 못했습니다: 이 데이터는 실행 중인 욱채(데스크톱 앱, pid ${process.pid})가 쓰고 있는 데이터입니다(복사본이거나 잠금 파일이 지워짐) — 그 욱채를 끝낸 뒤 다시 시작하세요`);
    await firstStillRuns();
    expect(h.core.ctx.store.kv.get<{ pid: number }>('instance')?.pid).toBe(process.pid);
  }, 180_000);
});

describe('저장소의 주인이 끝난 프로세스면 그대로 시작한다 (S2-15)', () => {
  it('죽은 pid, 그리고 pid를 다시 쓴 다른 프로세스(생성 시각이 다름)가 적혀 있으면 시작하고 이 서버를 주인으로 적는다 — 준비 줄은 두 루프백을 말한다', async () => {
    const gone = spawn(process.execPath, ['-e', ''], { stdio: 'ignore', windowsHide: true });
    const deadPid = gone.pid!;
    await new Promise((r) => gone.once('exit', r));
    const myCreatedAt = (await processLiveness.processCreatedAt([process.pid])).get(process.pid)!;
    for (const [label, recorded] of [
      ['죽은 pid', { pid: deadPid, createdAt: Date.now() - 60_000, kind: 'desktop', startedAt: new Date().toISOString(), dataDir: 'C:\\다른 곳' }],
      ['다시 쓴 pid', { pid: process.pid, createdAt: myCreatedAt - 60_000, kind: 'server', startedAt: '2020-01-01T00:00:00.000Z', dataDir: 'C:\\다른 곳' }],
    ] as const) {
      const dataDir = tempDir('owner');
      const seed = openStore(join(dataDir, 'wook.db'));
      seed.kv.set('instance', recorded);
      seed.close();
      const s = await startBuilt({ entry, dataDir });
      servers.push(s);
      expect(s.stdout(), label).toMatch(/욱채 서버 준비 완료: 주소 http:\/\/127\.0\.0\.1:\d+ \(127\.0\.0\.1(과 ::1)?에서 받음\) · 실행 ID /);
      // 도는 동안 이 서버가 주인으로 적혀 있다 — 깨끗이 끝나면 지운다(S2-20, 아래 시험)
      const store = openStore(join(dataDir, 'wook.db'));
      try {
        expect(store.kv.get('instance'), label).toMatchObject({ pid: s.child.pid, kind: 'server', dataDir });
      } finally {
        store.close();
      }
      await shutdownBuilt(s);
    }
  }, 240_000);
});

describe('깨끗한 종료는 데이터 주인 기록을 지운다 (S2-20 — 리뷰 프로브 zz-lc2-new T1)', () => {
  it('관리 채널 shutdown으로 끝나면 저장소에 주인 기록이 남지 않는다 — 끝난 pid를 다른 프로그램이 다시 써도 다음 시작이 없는 욱채를 이유로 거부할 기록이 없다', async () => {
    // 남겨 두면: Windows가 그 pid를 다른 프로그램에 다시 주고, 다음 시작이 프로세스 생성 시각을 읽지 못하면(WMI 고장, 로그온 직후 PowerShell 시간 초과)
    // '실행 중인 욱채(서버, pid N)가 쓰고 있는 데이터입니다'로 거부했다 — 그런 욱채는 없고 운영자는 pid N을 끝낼 수도 없다
    const dataDir = tempDir('owner-clear');
    const s = await startBuilt({ entry, dataDir });
    servers.push(s);
    const instance = (): unknown => {
      const store = openStore(join(dataDir, 'wook.db'));
      try {
        return store.kv.get('instance');
      } finally {
        store.close();
      }
    };
    expect(instance()).toMatchObject({ pid: s.child.pid, kind: 'server', dataDir });
    await shutdownBuilt(s);
    expect(instance()).toBeNull();
    expect(readFileSync(join(dataDir, 'logs', 'backend.log'), 'utf8')).toContain('데이터 주인 기록을 지움 (깨끗한 종료)');
  }, 120_000);
});

describe('잠금 기다림 (S2-16)', () => {
  it('시각이 미래인 깨진 잠금 파일이 있어도 준비된다 (예전에는 영영 기다렸다)', async () => {
    const dataDir = tempDir('future-lock');
    const lockFile = join(dataDir, 'server.lock');
    writeFileSync(lockFile, '');
    const future = new Date(Date.now() + 60 * 60 * 1000);
    utimesSync(lockFile, future, future);
    const s = await startBuilt({ entry, dataDir, timeoutMs: 30_000 });
    servers.push(s);
    expect(JSON.parse(readFileSync(lockFile, 'utf8'))).toMatchObject({ pid: s.child.pid, kind: 'server' });
    await shutdownBuilt(s);
  }, 120_000);
});

describe('쓸 수 없는 데이터 폴더 (S2-16)', () => {
  it('stderr는 쓰지 못한 기록 파일을 가리키지 않고 그렇다고 말한다 — 날것의 스택은 내지 않는다', (ctx) => {
    const dataDir = tempDir('readonly');
    const user = `${process.env['USERDOMAIN']}\\${process.env['USERNAME']}`;
    if (isWin) {
      execFileSync('icacls', [dataDir, '/deny', `${user}:(OI)(CI)(W,AD,WD)`], { windowsHide: true, stdio: 'ignore' });
    } else {
      if (typeof process.getuid === 'function' && process.getuid() === 0) ctx.skip('root는 폴더 권한과 상관없이 쓸 수 있다');
      chmodSync(dataDir, 0o500);
    }
    let r: { code: number | null; stdout: string; stderr: string };
    try {
      r = serveOnce(dataDir);
    } finally {
      if (isWin) execFileSync('icacls', [dataDir, '/remove:d', user], { windowsHide: true, stdio: 'ignore' });
      else chmodSync(dataDir, 0o700);
    }
    const logFile = join(dataDir, 'logs', 'server.log');
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('욱채 서버를 시작하지 못했습니다: 실행 잠금 파일(');
    expect(r.stderr).toContain(`서버 기록(${logFile})을 쓰지 못해 자세한 기록이 남지 않았습니다 — 데이터 폴더에 쓸 수 있는지 확인해 주세요\n`);
    expect(r.stderr).not.toContain('자세한 기록: ');
    expect(existsSync(logFile)).toBe(false);
    expect(r.stderr.split(/\r?\n/).filter((l) => /^\s+at /.test(l) || l.includes('\\n    at '))).toEqual([]);
  }, 120_000);
});

describe('데이터 폴더의 다른 이름 (S2-16)', () => {
  it('접합(심볼릭 링크)으로 적은 데이터 폴더로도 운영자 명령이 실행 중인 서버에 닿는다', async () => {
    const dataDir = tempDir('alias-target');
    const alias = join(tempDir('alias-parent'), '다른 이름');
    symlinkSync(dataDir, alias, isWin ? 'junction' : 'dir');
    const s = await startBuilt({ entry, dataDir });
    servers.push(s);
    const st = clientJson(entry, ['status', '--data-dir', alias]);
    expect(st.code).toBe(0);
    expect(st.reply.result).toMatchObject({ pid: s.child.pid, runId: s.runId });
    expect(runClient(entry, ['shutdown', '--data-dir', alias]).code).toBe(0);
    expect((await s.exited).code).toBe(0);
    expect(existsSync(join(dataDir, 'server.lock'))).toBe(false);
  }, 120_000);
});
