import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBackupScheduler, localDateKey } from './backupScheduler';
import type { Logger } from './logger';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wook-test-백업 상태-'));
});
// rmSync는 Node 24.13(Windows)에서 한글 경로면 테스트 프로세스가 죽어 비동기 rm을 쓴다
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function setup(opts: { enabled?: boolean; fail?: boolean; at: { value: Date } }) {
  const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const backend = {
    backupEnabled: vi.fn(() => opts.enabled ?? true),
    backupNow: vi.fn(async () => {
      if (opts.fail) throw new Error('디스크 공간 부족');
      return { path: join(dir, 'backups', localDateKey(opts.at.value)) };
    }),
  };
  const stateFile = join(dir, 'backup-state.json');
  const scheduler = createBackupScheduler({ backend, stateFile, logger, now: () => opts.at.value });
  return { scheduler, backend, logger, stateFile };
}

describe('자동 백업 예약 (ENV-07)', () => {
  it('같은 달력 날짜에는 한 번만 백업하고, 다음 날 다시 한다', async () => {
    const at = { value: new Date(2026, 9, 27, 9, 0, 0) };
    const { scheduler, backend, stateFile } = setup({ at });
    await expect(scheduler.runIfDue()).resolves.toBe('done');
    expect(JSON.parse(readFileSync(stateFile, 'utf8'))).toMatchObject({ lastBackupDate: '2026-10-27' });
    at.value = new Date(2026, 9, 27, 23, 59, 0);
    await expect(scheduler.runIfDue()).resolves.toBe('already_done');
    at.value = new Date(2026, 9, 28, 0, 1, 0);
    await expect(scheduler.runIfDue()).resolves.toBe('done');
    expect(backend.backupNow).toHaveBeenCalledTimes(2);
  });

  it('프로그램을 다시 켜도 기록 파일로 오늘 백업 여부를 안다', async () => {
    const at = { value: new Date(2026, 9, 27, 9, 0, 0) };
    const first = setup({ at });
    await first.scheduler.runIfDue();
    const second = setup({ at });
    await expect(second.scheduler.runIfDue()).resolves.toBe('already_done');
    expect(second.backend.backupNow).not.toHaveBeenCalled();
  });

  it('꺼져 있으면 백업하지 않는다', async () => {
    const { scheduler, backend } = setup({ enabled: false, at: { value: new Date(2026, 9, 27) } });
    await expect(scheduler.runIfDue()).resolves.toBe('disabled');
    expect(backend.backupNow).not.toHaveBeenCalled();
  });

  it('실패하면 기록하고 날짜를 남기지 않아 다음 확인 때 다시 시도한다', async () => {
    const at = { value: new Date(2026, 9, 27, 9) };
    const opts = { fail: true, at };
    const { scheduler, backend, logger, stateFile } = setup(opts);
    await expect(scheduler.runIfDue()).resolves.toBe('failed');
    expect(logger.error).toHaveBeenCalled();
    expect(() => readFileSync(stateFile)).toThrow();
    opts.fail = false;
    await expect(scheduler.runIfDue()).resolves.toBe('done');
    expect(backend.backupNow).toHaveBeenCalledTimes(2);
  });

  it('기록 파일이 깨져 있으면 경고 후 백업한다', async () => {
    const at = { value: new Date(2026, 9, 27, 9) };
    const { scheduler, logger, stateFile } = setup({ at });
    writeFileSync(stateFile, '{깨진');
    await expect(scheduler.runIfDue()).resolves.toBe('done');
    expect(logger.warn).toHaveBeenCalled();
  });

  it('진행 중에 다시 부르면 겹쳐 실행하지 않는다', async () => {
    const at = { value: new Date(2026, 9, 27, 9) };
    const { scheduler, backend } = setup({ at });
    const [a, b] = await Promise.all([scheduler.runIfDue(), scheduler.runIfDue()]);
    expect([a, b]).toEqual(['done', 'busy']);
    expect(backend.backupNow).toHaveBeenCalledTimes(1);
  });

  it('start 후 첫 확인은 지연 뒤, 그다음은 주기마다', async () => {
    vi.useFakeTimers();
    try {
      const at = { value: new Date(2026, 9, 27, 9) };
      const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const backend = { backupEnabled: vi.fn(() => true), backupNow: vi.fn(async () => ({ path: 'x' })) };
      const scheduler = createBackupScheduler({
        backend,
        stateFile: join(dir, 's.json'),
        logger,
        now: () => at.value,
        initialDelayMs: 1_000,
        intervalMs: 10_000,
      });
      scheduler.start();
      await vi.advanceTimersByTimeAsync(999);
      expect(backend.backupEnabled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(backend.backupNow).toHaveBeenCalledTimes(1);
      at.value = new Date(2026, 9, 28, 9);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(backend.backupNow).toHaveBeenCalledTimes(2);
      scheduler.stop();
      at.value = new Date(2026, 9, 29, 9);
      await vi.advanceTimersByTimeAsync(50_000);
      expect(backend.backupNow).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
