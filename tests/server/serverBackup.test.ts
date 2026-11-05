/**
 * 서버의 하루 1회 자동 백업 (ENV-07, 리드 결정 S2-18·S3-8 — src/server/serve.ts startServerBackups): 데스크톱 앱과 같은 예약(shell/backupScheduler.ts)·
 * 같은 설정(general.backup.enabled)·같은 기록 파일(`<dataDir>/backup-state.json`)로 서버 모드 백엔드를 백업한다. 첫 확인까지의 시간만 줄여 본다.
 * 빌드한 서버가 이 예약을 켜는지는 operatorCli.test가 서버 기록으로 본다
 */
import { existsSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../e2e/harness';
import { localDateKey } from '../../src/main/shell/backupScheduler';
import { startServerBackups } from '../../src/server/serve';
import { memoryLogger, sleep } from './helpers';

let h: Harness;
beforeAll(async () => {
  h = await createHarness({ mode: 'server', noProject: true });
}, 120_000);
afterAll(async () => {
  await h?.close();
});

const backups = () => (existsSync(h.core.ctx.paths.backups) ? readdirSync(h.core.ctx.paths.backups) : []);
const stateFile = () => join(h.dataDir, 'backup-state.json');

describe('서버 자동 백업 (S3-8)', () => {
  it('설정이 켜져 있으면 하루 한 번 백업하고 데스크톱과 같은 backup-state.json에 오늘 날짜를 적는다', async () => {
    expect(h.core.ctx.settings().general.backup.enabled).toBe(true);
    const log = memoryLogger();
    const scheduler = startServerBackups({ backend: h.orch.backend, dataDir: h.dataDir, logger: log, initialDelayMs: 20, intervalMs: 60_000 });
    try {
      const until = Date.now() + 20_000;
      while (!existsSync(stateFile()) && Date.now() < until) await sleep(50);
      expect(backups()).toHaveLength(1);
      expect(existsSync(join(h.core.ctx.paths.backups, backups()[0]!, 'wook.db'))).toBe(true);
      expect((JSON.parse(readFileSync(stateFile(), 'utf8')) as { lastBackupDate: string }).lastBackupDate).toBe(localDateKey(new Date()));
      expect(log.lines[0]).toBe('[INFO] 자동 백업 예약 시작 (하루 1회 — 설정 general.backup.enabled, 데스크톱 앱과 같은 backup-state.json)');
      expect(log.lines.some((l) => l.startsWith('[INFO] 자동 백업 완료: '))).toBe(true);
      // 같은 날 다시 확인해도 또 백업하지 않는다
      expect(await scheduler.runIfDue()).toBe('already_done');
    } finally {
      scheduler.stop();
    }
  });

  it('설정을 끄면 백업하지 않는다', async () => {
    unlinkSync(stateFile());
    await h.internal('settings.update', { general: { backup: { enabled: false } } });
    const before = backups().length;
    const scheduler = startServerBackups({ backend: h.orch.backend, dataDir: h.dataDir, logger: memoryLogger(), initialDelayMs: 20, intervalMs: 60_000 });
    try {
      await sleep(500);
      expect(await scheduler.runIfDue()).toBe('disabled');
      expect(backups()).toHaveLength(before);
      expect(existsSync(stateFile())).toBe(false);
    } finally {
      scheduler.stop();
    }
  });
});
