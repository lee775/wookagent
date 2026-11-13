/**
 * 한 번만 실행 잠금 (SERVER_DESIGN 3.2·3.3, S2-6): 한 데이터 폴더는 욱채 프로세스(서버 또는 데스크톱 앱) 하나만 쓴다.
 * - `<dataDir>/server.lock`을 `wx`로 만들고 pid·프로세스 생성 시각·(Linux) 부팅 기준 신원 start·종류('server'·'desktop')·시작 시각을 JSON으로 적는다
 * - 파일이 이미 있으면: 그 pid가 살아 있고 같은 프로세스면(둘 다 start가 있으면 정확히, 아니면 생성 시각 ±1초) 거부한다(종류와 pid를 알린다).
 *   아니면 오래된 잠금이다 — 고유한 이름으로 옮긴 뒤
 *   `wx`로 다시 만든다. 같은 오래된 잠금을 둘이 동시에 치우면, 늦게 옮긴 쪽이 먼저 잡은 쪽의 새 잠금을 옮겨 둘 다 잡는다. 그래서 옮기기 전에
 *   그 잠금 내용마다 하나인 표시 파일(`.claim-…`)을 `wx`로 만들고, 표시를 가진 쪽만 내용이 그대로인지 다시 본 뒤 옮긴다 — 둘이 함께 이기지 못한다
 * - 깨진 내용(쓰다 만 잠금)은 이 프로세스가 같은 내용을 2초 지켜본 뒤에야 오래된 잠금으로 본다 — 파일 시각이 아니라 단조 시계로. 다시 읽기와 시도에는
 *   상한이 있어 잡기는 끝없이 돌지 않는다 (S2-16)
 * - 놓을 때는 파일이 아직 이 프로세스를 가리킬 때만 지운다
 * 이 잠금은 백엔드(재시작 복구)보다 먼저 잡아야 한다 — 두 번째 프로세스의 복구(recovery.ts killTree)가 첫 프로세스의 CLI를 끊지 않게.
 * 그래서 러너 없이 쓰는 생존 확인(process/processRunner.ts `processLiveness`)을 쓴다. 잡기는 던지지 않는다 — 실패도 거부로 돌려준다
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { compareProcStart, parseProcStart, type ProcStart } from '../process/procfs';
import { processLiveness } from '../process/processRunner';
import type { ProcessRunner } from '../process/types';

export type LockKind = 'server' | 'desktop';

/** 잠금 파일 내용 */
export interface LockRecord {
  pid: number;
  /** 프로세스 생성 시각(epoch ms, 러너의 processCreatedAt과 같은 값). 읽지 못했으면 null */
  createdAt: number | null;
  /**
   * Linux: 그 프로세스의 부팅 기준 신원 (boot id + 시작 틱, 리드 결정 S10-5.1). 있으면 판정은 생성 시각 대신 이것으로 정확히 한다 — 벽시계가 움직여
   * 생성 시각이 바뀌어도 살아 있는 주인을 끝난 것으로 보지 않는다 (S2-22). 읽지 못했거나 다른 플랫폼·예전 기록이면 없다
   */
  start?: ProcStart;
  kind: LockKind;
  /** 잠금을 잡은 시각 (ISO) */
  startedAt: string;
}

/**
 * 이 욱채 프로세스 (S2-15): 잠금 내용 + 데이터 폴더. 껍데기(데스크톱·서버)가 잠금을 잡은 뒤 BackendDeps로 오케스트레이터에 넘기고,
 * 오케스트레이터가 저장소(kv `instance`)에 데이터의 주인으로 적는다 (orchestrator/dataOwner.ts)
 */
export interface InstanceIdentity extends LockRecord {
  dataDir: string;
}

/** 생존·생성 시각(·Linux 부팅 기준 신원) 확인 — 러너(ProcessRunner)와 같은 모양이라 러너를 그대로 넘겨도 된다 */
export type LockLiveness = Pick<ProcessRunner, 'isAlive' | 'processCreatedAt' | 'processStart'>;

export interface HeldInstanceLock {
  ok: true;
  path: string;
  record: LockRecord;
  /** 파일이 아직 이 프로세스를 가리킬 때만 지운다. 여러 번 불러도 된다 */
  release(): void;
}

export interface InstanceLockRefusal {
  ok: false;
  /** held = 다른 욱채가 쓰는 중, error = 잠금 파일을 만들거나 읽지 못함 */
  reason: 'held' | 'error';
  /** 잡고 있는 쪽 (held일 때. 내용을 알 수 없으면 null) */
  kind: LockKind | null;
  pid: number | null;
  /** 그대로 보여 줄 수 있는 한국어 글 */
  message: string;
}

export type InstanceLockResult = HeldInstanceLock | InstanceLockRefusal;

export interface AcquireInstanceLockOptions {
  /** 이미 있는 데이터 폴더 */
  dataDir: string;
  kind: LockKind;
  /** 시험: 생존·생성 시각 확인을 바꾼다 (기본: 러너 없는 processLiveness) */
  liveness?: LockLiveness;
  /** 시험: 이 프로세스 대신 적을 pid */
  pid?: number;
}

export const LOCK_FILE_NAME = 'server.lock';
/** 생성 시각 비교 여유 — POSIX ps는 초 단위로 자른다 (recovery.ts의 PID 시각 여유와 같다) */
const CREATED_AT_SLACK_MS = 1000;
/**
 * 읽은 잠금 내용이 깨져 있을 때: 다른 프로세스가 막 `wx`로 만들고 아직 쓰는 중일 수 있어, 이 프로세스가 같은 내용을 이만큼 지켜본 뒤에야 오래된 잠금으로 본다.
 * 파일 시각(mtime)이 아니라 이 프로세스의 단조 시계로 잰다 — 시계가 뒤로 갔거나 시각이 미래인 파일에서 영영 기다리지 않게 (S2-16)
 */
const PARTIAL_WRITE_MS = 2000;
/** 오래된 잠금을 치우던 프로세스가 표시 파일을 남기고 죽었으면 이만큼 지난 뒤 표시를 지운다 (치우기는 몇 ms면 끝난다) */
const CLAIM_STALE_MS = 10_000;
const RETRY_MS = 50;
const MAX_ATTEMPTS = 8;
/** 깨진 내용을 다시 읽는 상한 (약 8초) — 내용이 계속 바뀌어도 끝없이 기다리지 않는다 (S2-16) */
const MAX_PARTIAL_READS = Math.ceil(PARTIAL_WRITE_MS / RETRY_MS) * 4;

const KIND_LABEL: Record<LockKind, string> = { server: '서버', desktop: '데스크톱 앱' };

export function lockFilePath(dataDir: string): string {
  return join(dataDir, LOCK_FILE_NAME);
}

/** 거부 글: '이 데이터 폴더는 이미 다른 욱채(서버, pid 1234)가 쓰고 있습니다' */
export function lockHeldMessage(kind: LockKind | null, pid: number): string {
  return `이 데이터 폴더는 이미 다른 욱채(${kind ? `${KIND_LABEL[kind]}, ` : ''}pid ${pid})가 쓰고 있습니다`;
}

/**
 * 데이터 주인 거부 글 (S2-15): '이 데이터는 실행 중인 욱채(데스크톱 앱, pid 1234)가 쓰고 있는 데이터입니다(복사본이거나 잠금 파일이 지워짐) — …'.
 * 그 욱채의 데이터 폴더가 이 폴더와 다르면(복사본) 그 폴더도 알린다 — 운영자가 실행 중인 쪽을 찾게
 */
export function dataInUseMessage(owner: { kind: LockKind | null; pid: number; dataDir?: string }, here?: string): string {
  const where = owner.dataDir && here && !samePath(owner.dataDir, here) ? `, 데이터 폴더 ${owner.dataDir}` : '';
  return `이 데이터는 실행 중인 욱채(${owner.kind ? `${KIND_LABEL[owner.kind]}, ` : ''}pid ${owner.pid}${where})가 쓰고 있는 데이터입니다(복사본이거나 잠금 파일이 지워짐) — 그 욱채를 끝낸 뒤 다시 시작하세요`;
}

/** 같은 경로인지 (Windows는 대소문자를 가리지 않는다) */
function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const errCode = (e: unknown): string | undefined => (e as NodeJS.ErrnoException | null)?.code;
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** 읽은 잠금 내용 — 모르는 종류는 null */
export type ReadRecord = Omit<LockRecord, 'kind'> & { kind: LockKind | null };

/** 잠금 파일 내용. pid가 없거나 형식이 틀리면 null */
function parseRecord(raw: string): ReadRecord | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  return toRecord(v);
}

/** 읽은 값 → 잠금 내용 (데이터 주인 기록도 같은 모양, S2-15). pid가 없거나 형식이 틀리면 null */
export function toRecord(v: unknown): ReadRecord | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  const pid = o['pid'];
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return null;
  const createdAt = typeof o['createdAt'] === 'number' && Number.isFinite(o['createdAt']) ? o['createdAt'] : null;
  // 모르는 종류(앞으로 더할 다른 프로세스)도 pid로 판정한다 — 글에는 종류를 빼고 쓴다
  const kind = o['kind'] === 'server' || o['kind'] === 'desktop' ? o['kind'] : null;
  const startedAt = typeof o['startedAt'] === 'string' ? o['startedAt'] : '';
  // 모양이 틀린 신원은 없는 것으로 본다 — 그 기록은 예전 규칙(생성 시각)으로 판정한다
  const start = parseProcStart(o['start']);
  return { pid, createdAt, ...(start ? { start } : {}), kind, startedAt };
}

async function createdAtOf(live: LockLiveness, pid: number): Promise<number | null> {
  try {
    return (await live.processCreatedAt([pid])).get(pid) ?? null;
  } catch {
    return null;
  }
}

/** 그 PID의 부팅 기준 신원 (Linux만, 읽지 못하면 null) */
async function startOf(live: LockLiveness, pid: number): Promise<ProcStart | null> {
  if (!live.processStart) return null;
  try {
    return (await live.processStart([pid])).get(pid) ?? null;
  } catch {
    return null;
  }
}

/**
 * 잠금을 잡은 프로세스가 아직 그 잠금의 주인인지. 기록과 지금 둘 다 부팅 기준 신원이 있으면 그것으로 정확히 본다(같으면 'held', 다르면 'stale' —
 * 벽시계와 상관없음, S10-5.1). 아니면 예전 규칙: 살아 있고 생성 시각이 같으면(±1초) 'held'.
 * 생성 시각을 비교할 수 없으면 시작 시각으로 본다 — 잠금을 잡은 뒤에 생긴 프로세스면 PID를 다시 쓴 다른 프로세스다.
 * 그래도 모르면 쓰는 중으로 본다 — 남의 CLI를 끊지 않는 쪽으로
 */
async function judge(rec: ReadRecord, live: LockLiveness): Promise<'held' | 'stale'> {
  let alive: boolean;
  try {
    alive = await live.isAlive(rec.pid);
  } catch {
    return 'held';
  }
  if (!alive) return 'stale';
  if (rec.start) {
    const exact = compareProcStart(rec.start, await startOf(live, rec.pid));
    if (exact !== 'unknown') return exact === 'same' ? 'held' : 'stale';
  }
  const now = await createdAtOf(live, rec.pid);
  if (now !== null && rec.createdAt !== null) return Math.abs(now - rec.createdAt) <= CREATED_AT_SLACK_MS ? 'held' : 'stale';
  const started = Date.parse(rec.startedAt);
  if (now !== null && Number.isFinite(started)) return now <= started + CREATED_AT_SLACK_MS ? 'held' : 'stale';
  return 'held';
}

/**
 * 기록(pid·생성 시각·시작 시각)이 가리키는 프로세스가 아직 살아 있는 바로 그 프로세스인지 — 실행 잠금과 같은 판정이다.
 * 데이터 주인 확인(orchestrator/dataOwner.ts, S2-15)이 저장소에 적힌 욱채를 볼 때 쓴다
 */
export async function holderAlive(rec: ReadRecord, live: LockLiveness = processLiveness): Promise<boolean> {
  return (await judge(rec, live)) === 'held';
}

/**
 * 지금 있는 잠금 파일 (없으면 null). 깨진 내용은 막 쓰는 중일 수 있어, 같은 내용을 PARTIAL_WRITE_MS 동안 지켜볼 때까지 다시 읽는다.
 * 내용이 계속 바뀌면 MAX_PARTIAL_READS번에서 그만두고 던진다 (잡기가 거부로 바꾼다) — 끝없이 돌지 않는다 (S2-16)
 */
async function readExisting(path: string): Promise<{ raw: string; record: ReadRecord | null } | null> {
  /** 지켜보는 깨진 내용과 처음 본 때 (단조 시계) */
  let watched = { raw: '', since: -1 };
  for (let reads = 1; ; reads++) {
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch (e) {
      if (errCode(e) === 'ENOENT') return null;
      throw e;
    }
    const record = parseRecord(raw);
    if (record) return { raw, record };
    const t = performance.now();
    if (watched.since < 0 || watched.raw !== raw) watched = { raw, since: t };
    else if (t - watched.since >= PARTIAL_WRITE_MS) return { raw, record: null };
    if (reads >= MAX_PARTIAL_READS) throw new Error(`잠금 파일 내용이 깨진 채 계속 바뀌어 ${Math.round((reads * RETRY_MS) / 1000)}초 넘게 읽지 못했습니다. 잠시 뒤 다시 시작해 주세요`);
    await sleep(RETRY_MS);
  }
}

/**
 * 오래된 잠금(내용 raw)을 치운다. 그 내용마다 하나인 표시 파일을 wx로 만든 쪽만, 잠금이 아직 그 내용일 때 고유한 이름으로 옮기고 지운다.
 * 표시를 못 가지면(다른 쪽이 치우는 중) 아무것도 하지 않는다 — 호출자가 처음부터 다시 판단한다
 */
function takeOver(path: string, raw: string, pid: number): void {
  const claim = `${path}.claim-${createHash('sha256').update(raw).digest('hex').slice(0, 16)}`;
  try {
    writeFileSync(claim, String(pid), { flag: 'wx', mode: 0o600 });
  } catch (e) {
    if (errCode(e) !== 'EEXIST') throw e;
    try {
      // 시각이 미래인 표시(시계가 뒤로 감)도 오래된 것으로 본다 — 지금 만든 표시는 지금 시각이다 (S2-16)
      if (Math.abs(Date.now() - statSync(claim).mtimeMs) > CLAIM_STALE_MS) unlinkSync(claim);
    } catch {
      // 그사이 표시가 치워졌다 — 다시 판단하면 된다
    }
    return;
  }
  try {
    let now: string;
    try {
      now = readFileSync(path, 'utf8');
    } catch (e) {
      if (errCode(e) === 'ENOENT') return;
      throw e;
    }
    if (now !== raw) return;
    const moved = `${path}.stale-${pid}-${randomBytes(4).toString('hex')}`;
    renameSync(path, moved);
    try {
      unlinkSync(moved);
    } catch {
      // 옮긴 오래된 잠금은 아무도 보지 않는다 — 못 지워도 잡기에는 상관없다
    }
  } finally {
    try {
      unlinkSync(claim);
    } catch {
      // 이미 없다
    }
  }
}

function held(path: string, record: LockRecord, text: string): HeldInstanceLock {
  let released = false;
  return {
    ok: true,
    path,
    record,
    release() {
      if (released) return;
      released = true;
      try {
        // 다른 프로세스가 오래된 잠금으로 보고 넘겨받았으면 그쪽 잠금이다 — 지우지 않는다
        if (readFileSync(path, 'utf8') !== text) return;
        unlinkSync(path);
      } catch {
        // 이미 없다
      }
    },
  };
}

const failure = (path: string, detail: string): InstanceLockRefusal => ({
  ok: false,
  reason: 'error',
  kind: null,
  pid: null,
  message: `실행 잠금 파일(${path})을 만들지 못했습니다: ${detail}`,
});

/** 실행 잠금을 잡는다. 던지지 않는다 — 다른 욱채가 쓰는 중이거나 파일을 다룰 수 없으면 거부(ok: false)를 돌려준다 */
export async function acquireInstanceLock(o: AcquireInstanceLockOptions): Promise<InstanceLockResult> {
  const path = lockFilePath(o.dataDir);
  const live = o.liveness ?? processLiveness;
  const pid = o.pid ?? process.pid;
  try {
    const start = await startOf(live, pid);
    const record: LockRecord = { pid, createdAt: await createdAtOf(live, pid), ...(start ? { start } : {}), kind: o.kind, startedAt: new Date().toISOString() };
    const text = JSON.stringify(record);
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        writeFileSync(path, text, { flag: 'wx', mode: 0o600 });
        return held(path, record, text);
      } catch (e) {
        if (errCode(e) !== 'EEXIST') return failure(path, errText(e));
      }
      const existing = await readExisting(path);
      if (!existing) continue;
      if (existing.record && (await judge(existing.record, live)) === 'held') {
        return { ok: false, reason: 'held', kind: existing.record.kind, pid: existing.record.pid, message: lockHeldMessage(existing.record.kind, existing.record.pid) };
      }
      takeOver(path, existing.raw, pid);
      await sleep(attempt === 0 ? 0 : RETRY_MS);
    }
    return failure(path, '다른 욱채가 같은 데이터 폴더로 동시에 시작하는 중일 수 있습니다. 잠시 뒤 다시 시작해 주세요');
  } catch (e) {
    return failure(path, errText(e));
  }
}
