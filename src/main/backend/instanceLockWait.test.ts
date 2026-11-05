/**
 * 실행 잠금 잡기는 끝없이 기다리지 않는다 (SERVER_DESIGN 3.3, S2-6·S2-16 — 리뷰 lifecycle-guarantees의 zz-lc-lockhang 'acquire'를 옮김).
 * - 깨진 잠금(쓰다 만 잠금)은 이 프로세스가 같은 내용을 2초 지켜본 뒤 넘겨받는다 — 파일 시각이 미래여도(시계가 뒤로 감·되살린 파일)
 * - 깨진 내용이 계속 바뀌면 다시 읽기 상한에서 거부로 끝난다
 * - 오래된 잠금을 치우던 쪽이 남긴 표시 파일의 시각이 미래여도 오래된 표시로 본다
 * 빌드한 서버로 같은 경우를 보는 시험은 tests/server/dataGuards.test
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireInstanceLock, lockFilePath, type InstanceLockResult, type LockLiveness } from './instanceLock';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wook-test-잠금 기다림-'));
});
// rmSync는 Node 24.13(Windows)에서 한글 경로면 테스트 프로세스가 죽어 비동기 rm을 쓴다
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** 2222만 살아 있다 (생성 시각 9000) */
const live: LockLiveness = {
  isAlive: async (pid) => pid === 2222,
  processCreatedAt: async (pids) => new Map(pids.filter((p) => p === 2222).map((p) => [p, 9_000] as [number, number])),
};
const HOUR_AHEAD = () => new Date(Date.now() + 60 * 60 * 1000);

/** 상한(ms) 안에 끝나는지 — 끝나지 않으면 'timeout' (영영 돌던 예전 동작을 시험 시간 초과가 아닌 분명한 실패로) */
async function within(ms: number, p: Promise<InstanceLockResult>): Promise<{ result: InstanceLockResult | 'timeout'; elapsed: number }> {
  const t0 = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([p, new Promise<'timeout'>((r) => (timer = setTimeout(() => r('timeout'), ms)))]);
  clearTimeout(timer);
  return { result, elapsed: Date.now() - t0 };
}

describe('깨진 잠금 기다리기 (S2-16)', () => {
  it('시각이 미래인 깨진 잠금도 같은 내용을 2초 지켜본 뒤 넘겨받는다', async () => {
    writeFileSync(lockFilePath(dir), '');
    utimesSync(lockFilePath(dir), HOUR_AHEAD(), HOUR_AHEAD());
    const { result, elapsed } = await within(10_000, acquireInstanceLock({ dataDir: dir, kind: 'server', liveness: live, pid: 2222 }));
    expect(result).not.toBe('timeout');
    expect((result as InstanceLockResult).ok).toBe(true);
    expect(JSON.parse(readFileSync(lockFilePath(dir), 'utf8'))).toMatchObject({ pid: 2222, kind: 'server' });
    // 바로 넘겨받지 않았다 — 쓰는 중일 수 있는 내용을 지켜봤다
    expect(elapsed).toBeGreaterThanOrEqual(1_900);
    expect(readdirSync(dir)).toEqual(['server.lock']);
  }, 30_000);

  it('깨진 내용이 계속 바뀌면 끝없이 기다리지 않고 거부로 끝낸다', async () => {
    let n = 0;
    writeFileSync(lockFilePath(dir), `깨짐 ${n}`);
    const writer = setInterval(() => {
      try {
        writeFileSync(lockFilePath(dir), `깨짐 ${++n}`);
      } catch {
        // 시험 끝 정리와 겹침
      }
    }, 20);
    try {
      const { result } = await within(20_000, acquireInstanceLock({ dataDir: dir, kind: 'server', liveness: live, pid: 2222 }));
      expect(result).not.toBe('timeout');
      expect(result).toMatchObject({ ok: false, reason: 'error', kind: null, pid: null });
      expect((result as { message: string }).message).toContain('잠금 파일 내용이 깨진 채 계속 바뀌어');
      // 남의(쓰는 중인) 파일은 옮기지 않았다
      expect(readFileSync(lockFilePath(dir), 'utf8')).toMatch(/^깨짐 \d+$/);
    } finally {
      clearInterval(writer);
    }
  }, 40_000);

  it('오래된 잠금을 치우던 쪽이 남긴 표시 파일의 시각이 미래여도(시계가 뒤로 감) 오래된 표시로 보고 넘겨받는다', async () => {
    const stale = JSON.stringify({ pid: 999_999, createdAt: 5_000, kind: 'server', startedAt: new Date().toISOString() });
    writeFileSync(lockFilePath(dir), stale);
    const claim = `${lockFilePath(dir)}.claim-${createHash('sha256').update(stale).digest('hex').slice(0, 16)}`;
    writeFileSync(claim, '7777');
    utimesSync(claim, HOUR_AHEAD(), HOUR_AHEAD());
    const { result } = await within(10_000, acquireInstanceLock({ dataDir: dir, kind: 'server', liveness: live, pid: 2222 }));
    expect((result as InstanceLockResult).ok).toBe(true);
    expect(existsSync(claim)).toBe(false);
    expect(readdirSync(dir)).toEqual(['server.lock']);
  }, 30_000);
});
