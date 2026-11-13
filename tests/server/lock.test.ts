/**
 * 실행 잠금과 서버 (SERVER_DESIGN 3.2·3.3, S2-5·S2-6, S2-11 lock): 빌드한 서버로 본다.
 * - 같은 데이터 폴더의 두 번째 서버는 시작하지 못하고(코드 1, 종류와 pid를 말함), 데스크톱 앱의 잠금도 거부된다. 첫 서버는 그대로 답한다
 * - 두 번째 서버는 백엔드를 만들기 전에 멈춘다 — 첫 서버의 모의 CLI를 재시작 복구가 끊지 않는다
 * - 오래된 잠금(죽은 pid, 생성 시각이 다른 다시 쓴 pid)은 넘겨받는다
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, sendCommand } from '../e2e/harness';
import { acquireInstanceLock, lockHeldMessage } from '../../src/main/backend/instanceLock';
import { processLiveness } from '../../src/main/process/processRunner';
import { startServer } from '../../src/server/server';
import { buildServerTo, childEnv, clientJson, memoryLogger, remoteBackendOf, removeDir, REPO, runClient, startBuilt, testBuildDir, workspaceArgs, type BuiltServer } from './helpers';

let buildDir = '';
let entry = '';
const dirs: string[] = [];
const servers: BuiltServer[] = [];

beforeAll(() => {
  buildDir = testBuildDir('lock');
  entry = buildServerTo(buildDir);
}, 120_000);

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
});

const tempDir = (tag: string): string => {
  const d = mkdtempSync(join(tmpdir(), `wook-test-lock-${tag}-`));
  dirs.push(d);
  return d;
};

/** 두 번째 서버를 띄워 끝날 때까지 */
function secondServer(dataDir: string): { code: number | null; stderr: string; stdout: string } {
  const r = spawnSync(process.execPath, [entry, 'serve', '--data-dir', dataDir, '--port', '0', '--allow-test-session', ...workspaceArgs(dataDir)], { cwd: REPO, env: childEnv(), encoding: 'utf8', windowsHide: true, timeout: 90_000 });
  return { code: r.status, stderr: r.stderr ?? '', stdout: r.stdout ?? '' };
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('같은 데이터 폴더', () => {
  it('두 번째 서버는 시작하지 못하고(코드 1) 데스크톱 잠금도 거부된다 — 첫 서버는 그대로 답한다', async () => {
    const dataDir = tempDir('two');
    const a = await startBuilt({ entry, dataDir });
    servers.push(a);
    const lockText = readFileSync(join(dataDir, 'server.lock'), 'utf8');
    expect(JSON.parse(lockText)).toMatchObject({ pid: a.child.pid, kind: 'server' });

    const b = secondServer(dataDir);
    expect(b.code).toBe(1);
    expect(b.stdout).not.toContain('준비 완료');
    expect(b.stderr).toContain(`욱채 서버를 시작하지 못했습니다: ${lockHeldMessage('server', a.child.pid)}`);
    expect(lockHeldMessage('server', a.child.pid)).toBe(`이 데이터 폴더는 이미 다른 욱채(서버, pid ${a.child.pid})가 쓰고 있습니다`);
    // 잠금 파일과 첫 서버의 관리 채널이 그대로다
    expect(readFileSync(join(dataDir, 'server.lock'), 'utf8')).toBe(lockText);
    const st = clientJson(entry, ['status', '--data-dir', dataDir]);
    expect(st.code).toBe(0);
    expect(st.reply.result).toMatchObject({ pid: a.child.pid, runId: a.runId });

    const desktop = await acquireInstanceLock({ dataDir, kind: 'desktop' });
    expect(desktop).toEqual({ ok: false, reason: 'held', kind: 'server', pid: a.child.pid, message: lockHeldMessage('server', a.child.pid) });

    const down = runClient(entry, ['shutdown', '--data-dir', dataDir]);
    expect(down.code).toBe(0);
    expect((await a.exited).code).toBe(0);
  }, 180_000);

  it('두 번째 서버는 백엔드를 만들기 전에 멈춘다 — 첫 서버의 모의 CLI가 살아 있고 그 턴이 이어진다', async () => {
    const h = await createHarness({ team: ['developer'], scenarios: { developer: 'hang' } });
    const lock = await acquireInstanceLock({ dataDir: h.dataDir, kind: 'server' });
    if (!lock.ok) throw new Error(lock.message);
    const first = await startServer({ backend: remoteBackendOf(h), dataDir: h.dataDir, port: 0, allowTestSession: false, logger: memoryLogger(), version: 'test' });
    try {
      await sendCommand(h, '로그인 화면을 만들어 줘');
      const dev = h.members.developer!;
      await h.waitFor(() => h.core.turns.isMemberRunning(dev) && !!h.core.turns.lastLineOf(dev)?.text.includes('업무를 시작합니다'), { timeoutMs: 90_000, label: '개발자 hang 턴' });
      const turn = h.core.ctx.store.turns.list().find((t) => t.memberId === dev && t.endedAt === null && t.process.pid !== null)!;
      const pid = turn.process.pid!;
      const createdBefore = (await processLiveness.processCreatedAt([pid])).get(pid);

      const b = secondServer(h.dataDir);
      expect(b.code).toBe(1);
      expect(b.stderr).toContain(lockHeldMessage('server', process.pid));

      // 같은 프로세스(같은 생성 시각)가 살아 있고, 턴은 끝나지 않았다
      expect(alive(pid)).toBe(true);
      expect((await processLiveness.processCreatedAt([pid])).get(pid)).toBe(createdBefore);
      expect(h.core.turns.isMemberRunning(dev)).toBe(true);
      expect(h.core.ctx.store.turns.require(turn.id).endedAt).toBeNull();
      // 두 번째 서버는 백엔드 기록을 남기지 않았다 (재시작 복구를 돌리지 않았다)
      expect(readFileSync(join(h.dataDir, 'logs', 'server.log'), 'utf8')).toContain('시작 실패');
      expect(() => readFileSync(join(h.dataDir, 'logs', 'backend.log'), 'utf8')).toThrow();
    } finally {
      await first.close();
      lock.release();
      await h.close();
    }
  }, 240_000);
});

describe('오래된 잠금', () => {
  it('죽은 pid의 잠금은 넘겨받아 시작한다', async () => {
    const dataDir = tempDir('dead');
    const gone = spawn(process.execPath, ['-e', ''], { stdio: 'ignore', windowsHide: true });
    const deadPid = gone.pid!;
    await new Promise((r) => gone.once('exit', r));
    writeFileSync(join(dataDir, 'server.lock'), JSON.stringify({ pid: deadPid, createdAt: Date.now() - 60_000, kind: 'server', startedAt: new Date().toISOString() }));
    const s = await startBuilt({ entry, dataDir });
    servers.push(s);
    expect(JSON.parse(readFileSync(join(dataDir, 'server.lock'), 'utf8'))).toMatchObject({ pid: s.child.pid, kind: 'server' });
    expect(runClient(entry, ['shutdown', '--data-dir', dataDir]).code).toBe(0);
    expect((await s.exited).code).toBe(0);
  }, 120_000);

  it('다시 쓴 pid(살아 있지만 생성 시각이 다름)의 잠금도 넘겨받는다', async () => {
    const dataDir = tempDir('reused');
    // 이 시험 프로세스는 살아 있다 — 기록된 생성 시각만 다르다
    writeFileSync(join(dataDir, 'server.lock'), JSON.stringify({ pid: process.pid, createdAt: 12_345, kind: 'desktop', startedAt: '2020-01-01T00:00:00.000Z' }));
    const s = await startBuilt({ entry, dataDir });
    servers.push(s);
    expect(JSON.parse(readFileSync(join(dataDir, 'server.lock'), 'utf8'))).toMatchObject({ pid: s.child.pid, kind: 'server' });
    expect(runClient(entry, ['shutdown', '--data-dir', dataDir]).code).toBe(0);
    expect((await s.exited).code).toBe(0);
  }, 120_000);
});
