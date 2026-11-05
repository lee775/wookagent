/**
 * 하루 1회 자동 백업 (ENV-07). 매시간 확인하고, 마지막 백업 날짜(로컬 달력 기준)를 backup-state.json에 남긴다.
 * 실패하면 날짜를 남기지 않아 다음 확인 때 다시 시도한다.
 */
import type { Backend } from '../backend/types';
import { isRecord, readJsonFile, writeJsonFileAtomic } from './jsonFile';
import type { Logger } from './logger';

export type BackupCheckResult = 'disabled' | 'already_done' | 'done' | 'failed' | 'busy';

export interface BackupState {
  lastBackupDate: string;
  lastBackupAt: string;
  lastPath: string;
}

export interface BackupScheduler {
  start(): void;
  stop(): void;
  /** 오늘 백업이 아직이면 실행 */
  runIfDue(): Promise<BackupCheckResult>;
}

/** 대표 PC의 로컬 날짜 YYYY-MM-DD */
export function localDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function parseBackupState(value: unknown): BackupState | null {
  if (!isRecord(value)) return null;
  const { lastBackupDate, lastBackupAt, lastPath } = value;
  if (typeof lastBackupDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(lastBackupDate)) return null;
  return {
    lastBackupDate,
    lastBackupAt: typeof lastBackupAt === 'string' ? lastBackupAt : '',
    lastPath: typeof lastPath === 'string' ? lastPath : '',
  };
}

export function createBackupScheduler(deps: {
  backend: Pick<Backend, 'backupEnabled' | 'backupNow'>;
  stateFile: string;
  logger: Logger;
  now?: () => Date;
  /** 시작 후 첫 확인까지 (기본 2분 — 시작 직후 복구 작업과 겹치지 않게) */
  initialDelayMs?: number;
  /** 기본 1시간 */
  intervalMs?: number;
}): BackupScheduler {
  const { backend, logger, stateFile } = deps;
  const now = deps.now ?? (() => new Date());
  const initialDelayMs = deps.initialDelayMs ?? 2 * 60_000;
  const intervalMs = deps.intervalMs ?? 60 * 60_000;
  let running: Promise<BackupCheckResult> | null = null;
  let firstTimer: ReturnType<typeof setTimeout> | null = null;
  let repeatTimer: ReturnType<typeof setInterval> | null = null;

  const readState = (): BackupState | null => {
    const result = readJsonFile(stateFile);
    if (result.ok) {
      const state = parseBackupState(result.value);
      if (!state) logger.warn(`백업 기록 파일 형식이 올바르지 않아 새로 씁니다: ${stateFile}`);
      return state;
    }
    if (!result.missing) logger.warn(`백업 기록 파일을 읽지 못했습니다: ${stateFile}`, result.error);
    return null;
  };

  const check = async (): Promise<BackupCheckResult> => {
    let enabled: boolean;
    try {
      enabled = backend.backupEnabled();
    } catch (error) {
      logger.error('자동 백업 설정을 읽지 못했습니다', error);
      return 'failed';
    }
    if (!enabled) return 'disabled';
    const today = localDateKey(now());
    if (readState()?.lastBackupDate === today) return 'already_done';
    let path: string;
    try {
      ({ path } = await backend.backupNow());
    } catch (error) {
      logger.error('자동 백업 실패 (다음 확인 때 다시 시도)', error);
      return 'failed';
    }
    try {
      writeJsonFileAtomic(stateFile, { lastBackupDate: today, lastBackupAt: now().toISOString(), lastPath: path } satisfies BackupState);
    } catch (error) {
      // 기록을 못 남기면 같은 날 한 번 더 백업될 수 있다 (백업 자체는 성공)
      logger.error(`백업 기록을 저장하지 못했습니다: ${stateFile}`, error);
    }
    logger.info(`자동 백업 완료: ${path}`);
    return 'done';
  };

  const runIfDue = (): Promise<BackupCheckResult> => {
    if (running) return Promise.resolve('busy');
    const current = check().finally(() => {
      running = null;
    });
    running = current;
    return current;
  };

  const tick = (): void => {
    void runIfDue();
  };

  return {
    start() {
      if (firstTimer || repeatTimer) return;
      firstTimer = setTimeout(() => {
        firstTimer = null;
        tick();
        repeatTimer = setInterval(tick, intervalMs);
      }, initialDelayMs);
    },
    stop() {
      if (firstTimer) clearTimeout(firstTimer);
      if (repeatTimer) clearInterval(repeatTimer);
      firstTimer = null;
      repeatTimer = null;
    },
    runIfDue,
  };
}
