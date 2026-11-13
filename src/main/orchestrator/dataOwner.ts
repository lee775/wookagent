/**
 * 데이터의 주인 기록 (SERVER_DESIGN 3.3, S2-15): 실행 잠금(backend/instanceLock.ts)은 경로 하나만 지킨다. 살아 있는 욱채의 데이터 폴더를 복사했거나
 * (손으로, 또는 앱의 백업 wook.db를 되살림) 잠금 파일을 손으로 지우면 두 번째 프로세스도 잠금을 잡는다. 그러면 그 재시작 복구가 첫 프로세스의
 * CLI를 끊는다 — 턴의 pid가 살아 있고 생성 시각도 맞기 때문이다.
 * 그래서 저장소(kv `instance`)에 이 데이터를 쓰는 욱채({pid, createdAt, start(Linux 부팅 기준 신원, S10-5.1), kind, startedAt, dataDir})를 적어 두고,
 * 무엇도 바꾸기 전에(복구보다 먼저) 본다:
 * - 다른 프로세스가 적혀 있고 그 프로세스가 살아 있으며 같은 프로세스면(실행 잠금과 같은 판정 — start가 둘 다 있으면 정확히, 아니면 생성 시각) 시작하지
 *   않는다. 복구를 돌리지 않고 저장소를 바꾸지 않는다
 * - 아니면(기록 없음 — 예전 DB 포함, 죽은 pid, 생성 시각이 다른 다시 쓴 pid, 이 프로세스) 이 프로세스를 적는다
 * 깨끗이 끝나면(backend.shutdown 뒤) 기록이 아직 이 프로세스일 때만 지운다(releaseDataOwner, S2-20) — 남은 기록은 실행 잠금 파일처럼 비정상 종료나
 * 살아 있는 주인만 뜻한다. 실행 잠금을 잡은 껍데기(데스크톱·서버)만 이 프로세스를 넘긴다 (BackendDeps.instance → BuildDepsOptions.instance).
 * 의존성 조립(buildOrchestratorDeps)이 저장소를 열자마자 — 프로세스 러너와 복구보다 먼저 — 부른다
 */
import { existsSync } from 'node:fs';
import { holderAlive, dataInUseMessage, toRecord, type InstanceIdentity, type LockLiveness } from '../backend/instanceLock';
import { isBackendError } from '../backend/invokeCore';
import { BackendError } from '../backend/types';
import { openStore, type Store } from '../db/store';
import type { LogFn } from './context';

export const INSTANCE_KEY = 'instance';
/** 살아 있는 다른 욱채의 데이터라 시작하지 않음 */
export const DATA_IN_USE = 'data_in_use';

/** 껍데기가 이 거부를 따로 알아본다 — 글을 그대로 보여 주고 끝낸다 */
export function isDataOwnerRefusal(error: unknown): error is BackendError {
  return isBackendError(error) && error.code === DATA_IN_USE;
}

/**
 * 저장소에 적힌 주인을 보고, 살아 있는 다른 욱채면 BackendError(DATA_IN_USE)를 던진다(저장소는 바꾸지 않는다). 아니면 이 프로세스를 적는다.
 * 저장소를 연 뒤, 어떤 쓰기보다도 먼저 부른다
 */
export async function claimDataOwner(o: { store: Store; self: InstanceIdentity; log?: LogFn; liveness?: LockLiveness }): Promise<void> {
  const raw = o.store.kv.get<unknown>(INSTANCE_KEY);
  const recorded = toRecord(raw);
  const recordedDir = typeof (raw as { dataDir?: unknown } | null)?.dataDir === 'string' ? (raw as { dataDir: string }).dataDir : undefined;
  // 같은 pid는 이 프로세스다 — 살아 있는 두 프로세스가 pid를 나눠 쓰지 않는다 (같은 프로세스의 재시작이거나, 끝난 주인의 pid를 이 프로세스가 다시 씀)
  if (recorded && recorded.pid !== o.self.pid && (await holderAlive(recorded, o.liveness))) {
    const message = dataInUseMessage({ kind: recorded.kind, pid: recorded.pid, dataDir: recordedDir }, o.self.dataDir);
    o.log?.('warn', `시작하지 않음: ${message}`);
    throw new BackendError(DATA_IN_USE, message);
  }
  o.store.kv.set(INSTANCE_KEY, o.self);
  if (recorded && recorded.pid !== o.self.pid) o.log?.('info', `데이터 주인 기록을 넘겨받음 (이전 기록 pid ${recorded.pid}는 끝난 프로세스)`);
}

/**
 * 깨끗한 종료 (S2-20): 저장소의 주인 기록이 아직 이 프로세스(pid·생성 시각·시작 시각이 같음)면 지운다. backend.shutdown이 저장소를 닫은 뒤에 부르므로
 * 저장소 파일을 다시 연다. 기록을 남겨 두면, 끝난 뒤 그 pid를 다른 프로그램이 다시 쓰고 다음 시작이 생성 시각을 읽지 못할 때(WMI 고장 등) 없는 욱채를
 * 이유로 시작을 거부한다. 다른 프로세스를 적은 기록은 건드리지 않는다. kv에는 지우기가 없어 null로 둔다 — 읽는 쪽(toRecord)은 기록 없음으로 본다.
 * 던지지 않는다 — 지우지 못해도 다음 시작은 죽은 pid로 보고 넘어간다
 */
export function releaseDataOwner(o: { dbPath: string; self: InstanceIdentity; log?: LogFn }): void {
  if (!existsSync(o.dbPath)) return;
  try {
    const store = openStore(o.dbPath);
    try {
      const recorded = toRecord(store.kv.get<unknown>(INSTANCE_KEY));
      if (!recorded || recorded.pid !== o.self.pid || recorded.createdAt !== o.self.createdAt || recorded.startedAt !== o.self.startedAt) return;
      store.kv.set(INSTANCE_KEY, null);
      o.log?.('info', '데이터 주인 기록을 지움 (깨끗한 종료)');
    } finally {
      store.close();
    }
  } catch (error) {
    o.log?.('warn', '데이터 주인 기록을 지우지 못했습니다 (다음 시작은 끝난 프로세스로 보고 넘어갑니다)', error);
  }
}
