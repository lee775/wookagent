/**
 * 한 번만 실행 잠금 (SERVER_DESIGN 3.2, S2-6): 잡기·거부·오래된 잠금 넘겨받기·놓기, 그리고 러너 없는 생존 확인(processLiveness).
 * 판정 시험은 생존·생성 시각 확인을 가짜로 바꾸고, 실제 프로세스 시험은 자식 node 프로세스로 한다.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { processLiveness } from '../process/processRunner';
import { acquireInstanceLock, lockFilePath, lockHeldMessage, type HeldInstanceLock, type InstanceLockResult, type LockLiveness, type LockRecord } from './instanceLock';

let dir: string;
const children: ChildProcess[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wook-test-실행 잠금-'));
});
// rmSync는 Node 24.13(Windows)에서 한글 경로면 테스트 프로세스가 죽어 비동기 rm을 쓴다
afterEach(async () => {
  for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill();
  await rm(dir, { recursive: true, force: true });
});

/** 가짜 생존 확인: alive에 있는 pid만 살아 있고, 그 값이 생성 시각(없으면 '모름') */
function fakeLiveness(alive: Map<number, number | null>): LockLiveness & { gate?: (pid: number) => Promise<void> } {
  const live: LockLiveness & { gate?: (pid: number) => Promise<void> } = {
    async isAlive(pid) {
      await live.gate?.(pid);
      return alive.has(pid);
    },
    async processCreatedAt(pids) {
      const out = new Map<number, number>();
      for (const p of pids) {
        const at = alive.get(p);
        if (at != null) out.set(p, at);
      }
      return out;
    },
  };
  return live;
}

const lockText = (d = dir) => readFileSync(lockFilePath(d), 'utf8');
const lockRecord = (d = dir) => JSON.parse(lockText(d)) as LockRecord;
const writeLock = (rec: Partial<LockRecord> & { pid: number }) =>
  writeFileSync(lockFilePath(dir), JSON.stringify({ createdAt: null, kind: 'server', startedAt: new Date().toISOString(), ...rec }));
/** 데이터 폴더에 남은 파일 — 잠금 말고 표시·옮긴 파일이 남지 않아야 한다 */
const files = () => readdirSync(dir).sort();
const okLock = (r: InstanceLockResult) => {
  if (!r.ok) throw new Error(`잠금을 잡지 못함: ${r.message}`);
  return r;
};

describe('실행 잠금 잡기·놓기', () => {
  it('server.lock을 만들고 pid·생성 시각·종류·시작 시각을 적는다. 놓으면 지우고, 두 번 놓아도 된다', async () => {
    const live = fakeLiveness(new Map([[4321, 1_700_000_000_000]]));
    const before = Date.now();
    const lock = okLock(await acquireInstanceLock({ dataDir: dir, kind: 'server', liveness: live, pid: 4321 }));
    expect(lock.path).toBe(join(dir, 'server.lock'));
    const rec = lockRecord();
    expect(rec).toEqual({ pid: 4321, createdAt: 1_700_000_000_000, kind: 'server', startedAt: expect.any(String) });
    expect(Date.parse(rec.startedAt)).toBeGreaterThanOrEqual(before - 1);
    expect(lock.record).toEqual(rec);
    expect(files()).toEqual(['server.lock']);
    lock.release();
    expect(files()).toEqual([]);
    lock.release();
    expect(files()).toEqual([]);
  });

  it('살아 있고 생성 시각이 같은 잠금은 거부한다 — 종류와 pid를 알리고 잠금 파일은 그대로 둔다', async () => {
    const live = fakeLiveness(new Map([
      [1234, 5_000],
      [2222, 9_000],
    ]));
    const first = okLock(await acquireInstanceLock({ dataDir: dir, kind: 'server', liveness: live, pid: 1234 }));
    const text = lockText();
    const second = await acquireInstanceLock({ dataDir: dir, kind: 'desktop', liveness: live, pid: 2222 });
    expect(second).toEqual({ ok: false, reason: 'held', kind: 'server', pid: 1234, message: '이 데이터 폴더는 이미 다른 욱채(서버, pid 1234)가 쓰고 있습니다' });
    expect(lockText()).toBe(text);
    expect(files()).toEqual(['server.lock']);
    first.release();
    // 데스크톱 앱이 잡고 있으면 그렇게 말한다
    okLock(await acquireInstanceLock({ dataDir: dir, kind: 'desktop', liveness: live, pid: 2222 }));
    const third = await acquireInstanceLock({ dataDir: dir, kind: 'server', liveness: live, pid: 1234 });
    expect(third).toMatchObject({ ok: false, reason: 'held', kind: 'desktop', pid: 2222, message: '이 데이터 폴더는 이미 다른 욱채(데스크톱 앱, pid 2222)가 쓰고 있습니다' });
  });

  it('생성 시각 차이가 1초 안이면 같은 프로세스로 본다 (POSIX ps는 초 단위)', async () => {
    writeLock({ pid: 1234, createdAt: 5_000 });
    const live = fakeLiveness(new Map([
      [1234, 5_600],
      [2222, 9_000],
    ]));
    expect(await acquireInstanceLock({ dataDir: dir, kind: 'desktop', liveness: live, pid: 2222 })).toMatchObject({ ok: false, reason: 'held', pid: 1234 });
  });

  it('죽은 pid의 잠금은 오래된 잠금이라 넘겨받는다 — 표시·옮긴 파일을 남기지 않는다', async () => {
    writeLock({ pid: 999_999, createdAt: 5_000, kind: 'desktop' });
    const live = fakeLiveness(new Map([[2222, 9_000]]));
    const lock = okLock(await acquireInstanceLock({ dataDir: dir, kind: 'server', liveness: live, pid: 2222 }));
    expect(lockRecord()).toMatchObject({ pid: 2222, createdAt: 9_000, kind: 'server' });
    expect(files()).toEqual(['server.lock']);
    lock.release();
    expect(files()).toEqual([]);
  });

  it('pid를 다시 쓴 다른 프로세스(살아 있지만 생성 시각이 다름)의 잠금도 넘겨받는다', async () => {
    writeLock({ pid: 1234, createdAt: 5_000 });
    const live = fakeLiveness(new Map([
      [1234, 65_000],
      [2222, 9_000],
    ]));
    okLock(await acquireInstanceLock({ dataDir: dir, kind: 'server', liveness: live, pid: 2222 }));
    expect(lockRecord().pid).toBe(2222);
  });

  it('생성 시각을 비교할 수 없으면 시작 시각으로 본다: 잠금보다 늦게 생긴 프로세스면 넘겨받고, 먼저 생겼거나 모르면 쓰는 중으로 본다', async () => {
    const startedAt = '2026-10-30T01:00:00.000Z';
    const t = Date.parse(startedAt);
    // 잠금을 잡을 때 생성 시각을 읽지 못한 기록 + 지금은 읽힘: 잠금 전에 생긴 프로세스 → 주인
    writeLock({ pid: 1234, createdAt: null, startedAt });
    expect(await acquireInstanceLock({ dataDir: dir, kind: 'desktop', liveness: fakeLiveness(new Map([[1234, t - 5_000], [2222, 1]])), pid: 2222 })).toMatchObject({ ok: false, reason: 'held', pid: 1234 });
    // 지금도 읽지 못함 → 모름 → 쓰는 중 (남의 CLI를 끊지 않는 쪽)
    expect(await acquireInstanceLock({ dataDir: dir, kind: 'desktop', liveness: fakeLiveness(new Map([[1234, null], [2222, 1]])), pid: 2222 })).toMatchObject({ ok: false, reason: 'held', pid: 1234 });
    // 잠금보다 늦게 생긴 프로세스 → pid를 다시 쓴 다른 프로세스
    okLock(await acquireInstanceLock({ dataDir: dir, kind: 'desktop', liveness: fakeLiveness(new Map([[1234, t + 5_000], [2222, 1]])), pid: 2222 }));
    expect(lockRecord().pid).toBe(2222);
  });

  it('놓기는 파일이 아직 이 프로세스를 가리킬 때만 지운다', async () => {
    const lock = okLock(await acquireInstanceLock({ dataDir: dir, kind: 'server', liveness: fakeLiveness(new Map([[1234, 5_000]])), pid: 1234 }));
    // 다른 프로세스가 이 잠금을 오래된 것으로 보고 넘겨받은 뒤
    writeLock({ pid: 2222, createdAt: 9_000, kind: 'desktop' });
    const other = lockText();
    lock.release();
    expect(lockText()).toBe(other);
  });

  it('깨진 잠금 파일: 막 만든 것이면 쓰기가 끝나기를 기다렸다가 다시 읽고, 오래된 것이면 넘겨받는다', async () => {
    const live = fakeLiveness(new Map([
      [1234, 5_000],
      [2222, 9_000],
    ]));
    // 다른 프로세스가 wx로 막 만들고 아직 쓰기 전 — 곧 살아 있는 잠금 내용이 들어온다
    writeFileSync(lockFilePath(dir), '');
    setTimeout(() => writeLock({ pid: 1234, createdAt: 5_000 }), 150);
    expect(await acquireInstanceLock({ dataDir: dir, kind: 'desktop', liveness: live, pid: 2222 })).toMatchObject({ ok: false, reason: 'held', pid: 1234 });
    // 오래전에 깨진 채 남은 파일 (쓰다가 죽음)
    writeFileSync(lockFilePath(dir), '{"pid":');
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockFilePath(dir), old, old);
    okLock(await acquireInstanceLock({ dataDir: dir, kind: 'desktop', liveness: live, pid: 2222 }));
    expect(lockRecord()).toMatchObject({ pid: 2222, kind: 'desktop' });
    expect(files()).toEqual(['server.lock']);
  });

  it('같은 오래된 잠금을 둘이 동시에 넘겨받아도 하나만 잡는다 — 늦은 쪽이 먼저 잡은 쪽의 새 잠금을 옮기지 않는다', async () => {
    writeLock({ pid: 999_999, createdAt: 5_000 });
    const live = fakeLiveness(new Map([
      [1111, 1_000],
      [2222, 2_000],
    ]));
    // 둘 다 오래된 잠금을 읽고 '죽음'을 확인한다. 두 번째 확인은 먼저 확인한 쪽이 새 잠금을 잡은 뒤에야 끝난다 — 가장 나쁜 순서
    const holder = (): number | null => {
      try {
        return lockRecord().pid;
      } catch {
        return null;
      }
    };
    let staleChecks = 0;
    live.gate = async (pid) => {
      if (pid !== 999_999 || ++staleChecks !== 2) return;
      const deadline = Date.now() + 5_000;
      while (![1111, 2222].includes(holder() ?? 0) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    };
    const results = await Promise.all([
      acquireInstanceLock({ dataDir: dir, kind: 'server', liveness: live, pid: 1111 }),
      acquireInstanceLock({ dataDir: dir, kind: 'desktop', liveness: live, pid: 2222 }),
    ]);
    expect(staleChecks).toBe(2);
    const winners = results.filter((r): r is HeldInstanceLock => r.ok);
    expect(winners).toHaveLength(1);
    const winner = winners[0]!.record;
    expect(results.find((r) => !r.ok)).toMatchObject({ reason: 'held', kind: winner.kind, pid: winner.pid });
    expect(lockRecord()).toEqual(winner);
    expect(files()).toEqual(['server.lock']);
  });

  it('다른 프로세스가 같은 오래된 잠금을 치우는 중(표시 파일이 있음)이면 옮기지 않는다. 표시가 오래됐으면(치우던 쪽이 죽음) 지우고 넘겨받는다', async () => {
    writeLock({ pid: 999_999, createdAt: 5_000 });
    const stale = lockText();
    const claim = `${lockFilePath(dir)}.claim-${createHash('sha256').update(stale).digest('hex').slice(0, 16)}`;
    writeFileSync(claim, '7777');
    const live = fakeLiveness(new Map([[2222, 9_000]]));
    const busy = await acquireInstanceLock({ dataDir: dir, kind: 'server', liveness: live, pid: 2222 });
    expect(busy).toMatchObject({ ok: false, reason: 'error', kind: null, pid: null });
    expect(!busy.ok && busy.message).toContain('다른 욱채가 같은 데이터 폴더로 동시에 시작하는 중일 수 있습니다. 잠시 뒤 다시 시작해 주세요');
    expect(lockText()).toBe(stale);
    expect(existsSync(claim)).toBe(true);
    const old = new Date(Date.now() - 60_000);
    utimesSync(claim, old, old);
    okLock(await acquireInstanceLock({ dataDir: dir, kind: 'server', liveness: live, pid: 2222 }));
    expect(lockRecord().pid).toBe(2222);
    expect(files()).toEqual(['server.lock']);
  });

  it('잠금 파일을 만들 수 없으면 던지지 않고 오류 거부를 돌려준다', async () => {
    const missing = join(dir, '없는 폴더');
    const r = await acquireInstanceLock({ dataDir: missing, kind: 'server', liveness: fakeLiveness(new Map([[1234, 5_000]])), pid: 1234 });
    expect(r).toMatchObject({ ok: false, reason: 'error', kind: null, pid: null });
    expect(!r.ok && r.message).toContain(`실행 잠금 파일(${join(missing, 'server.lock')})을 만들지 못했습니다: `);
  });

  it('거부 글', () => {
    expect(lockHeldMessage('server', 1234)).toBe('이 데이터 폴더는 이미 다른 욱채(서버, pid 1234)가 쓰고 있습니다');
    expect(lockHeldMessage('desktop', 7)).toBe('이 데이터 폴더는 이미 다른 욱채(데스크톱 앱, pid 7)가 쓰고 있습니다');
    expect(lockHeldMessage(null, 7)).toBe('이 데이터 폴더는 이미 다른 욱채(pid 7)가 쓰고 있습니다');
  });
});

describe('실제 프로세스로 (러너 없는 생존 확인 processLiveness)', () => {
  /** 잠깐 살아 있는 자식 node 프로세스 */
  async function liveChild(): Promise<ChildProcess & { pid: number }> {
    const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
    children.push(c);
    await new Promise<void>((resolve, reject) => {
      c.once('spawn', () => resolve());
      c.once('error', reject);
    });
    return c as ChildProcess & { pid: number };
  }
  const exited = (c: ChildProcess) => new Promise<void>((r) => (c.exitCode !== null || c.signalCode !== null ? r() : c.once('exit', () => r())));

  it('이 프로세스의 생성 시각을 적고, 같은 프로세스가 두 번 잡으면 거부한다', async () => {
    const first = okLock(await acquireInstanceLock({ dataDir: dir, kind: 'desktop' }));
    expect(first.record.pid).toBe(process.pid);
    expect(first.record.createdAt).toEqual(expect.any(Number));
    expect(Math.abs(first.record.createdAt! - (Date.now() - process.uptime() * 1000))).toBeLessThan(10_000);
    expect(await acquireInstanceLock({ dataDir: dir, kind: 'server' })).toMatchObject({ ok: false, reason: 'held', kind: 'desktop', pid: process.pid });
    first.release();
    expect(files()).toEqual([]);
  });

  it('살아 있는 다른 프로세스의 잠금은 거부하고, 그 프로세스가 끝나면 넘겨받는다', async () => {
    const child = await liveChild();
    const createdAt = (await processLiveness.processCreatedAt([child.pid])).get(child.pid);
    expect(createdAt).toEqual(expect.any(Number));
    writeLock({ pid: child.pid, createdAt: createdAt!, kind: 'server' });
    const refused = await acquireInstanceLock({ dataDir: dir, kind: 'desktop' });
    expect(refused).toEqual({ ok: false, reason: 'held', kind: 'server', pid: child.pid, message: `이 데이터 폴더는 이미 다른 욱채(서버, pid ${child.pid})가 쓰고 있습니다` });
    expect(lockRecord().pid).toBe(child.pid);
    child.kill();
    await exited(child);
    const lock = okLock(await acquireInstanceLock({ dataDir: dir, kind: 'desktop' }));
    expect(lockRecord()).toMatchObject({ pid: process.pid, kind: 'desktop' });
    lock.release();
  });

  it('살아 있는 pid라도 생성 시각이 다르면(다시 쓴 pid) 넘겨받는다', async () => {
    const child = await liveChild();
    const createdAt = (await processLiveness.processCreatedAt([child.pid])).get(child.pid)!;
    writeLock({ pid: child.pid, createdAt: createdAt - 60_000, kind: 'server' });
    const lock = okLock(await acquireInstanceLock({ dataDir: dir, kind: 'desktop' }));
    expect(lockRecord().pid).toBe(process.pid);
    lock.release();
  });

  it('processLiveness: 살아 있는 pid·끝난 pid·잘못된 번호, 생성 시각은 읽은 pid만', async () => {
    const child = await liveChild();
    expect(await processLiveness.isAlive(process.pid)).toBe(true);
    expect(await processLiveness.isAlive(child.pid)).toBe(true);
    for (const bad of [0, 1, -5, 1.5, Number.NaN]) expect(await processLiveness.isAlive(bad), String(bad)).toBe(false);
    const created = await processLiveness.processCreatedAt([child.pid, process.pid, 0]);
    expect([...created.keys()].sort((x, y) => x - y)).toEqual([child.pid, process.pid].sort((x, y) => x - y));
    expect(created.get(child.pid)!).toBeGreaterThan(created.get(process.pid)!);
    child.kill();
    await exited(child);
    await expect.poll(() => processLiveness.isAlive(child.pid), { timeout: 5_000 }).toBe(false);
    expect((await processLiveness.processCreatedAt([child.pid])).has(child.pid)).toBe(false);
    expect(existsSync(lockFilePath(dir))).toBe(false);
  });
});
