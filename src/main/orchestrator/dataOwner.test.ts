/**
 * 데이터의 주인 기록 (SERVER_DESIGN 3.3, S2-15): 저장소(kv `instance`)에 적힌 욱채가 살아 있는 다른 프로세스면(실행 잠금과 같은 판정) 시작하지 않고
 * 저장소를 바꾸지 않는다. 기록 없음(예전 DB)·죽은 pid·생성 시각이 다른 다시 쓴 pid·이 프로세스면 이 프로세스를 적는다.
 * 의존성 조립(buildOrchestratorDeps)은 저장소를 열자마자 본다 — 거부면 프로세스 러너를 만들지 않는다. 판정은 실제 자식 프로세스로 본다.
 * 깨끗이 끝나면 기록이 아직 이 프로세스일 때만 지운다 (releaseDataOwner, S2-20 — createBackend의 shutdown이 부른다)
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, renameSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openStore, type Store } from '../db/store';
import { processLiveness } from '../process/processRunner';
import { buildOrchestratorDeps } from '../backend/buildDeps';
import { BackendError } from '../backend/types';
import type { InstanceIdentity } from '../backend/instanceLock';
import { claimDataOwner, DATA_IN_USE, INSTANCE_KEY, isDataOwnerRefusal, releaseDataOwner } from './dataOwner';

let holder: ChildProcess & { pid: number };
let holderCreatedAt = 0;
let deadPid = 0;
let myCreatedAt = 0;
const dirs: string[] = [];

beforeAll(async () => {
  // 같은 데이터를 쓰는 살아 있는 다른 욱채 (실제 프로세스)
  holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true }) as ChildProcess & { pid: number };
  await new Promise<void>((resolve, reject) => {
    holder.once('spawn', () => resolve());
    holder.once('error', reject);
  });
  const created = await processLiveness.processCreatedAt([holder.pid, process.pid]);
  holderCreatedAt = created.get(holder.pid)!;
  myCreatedAt = created.get(process.pid)!;
  const gone = spawn(process.execPath, ['-e', ''], { stdio: 'ignore', windowsHide: true });
  deadPid = gone.pid!;
  await new Promise((r) => gone.once('exit', r));
}, 60_000);

afterAll(async () => {
  holder?.kill();
  for (const d of dirs) await rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const self = (dataDir = 'C:\\여기'): InstanceIdentity => ({ pid: process.pid, createdAt: 1_700_000_000_000, kind: 'server', startedAt: new Date().toISOString(), dataDir });
const owner = (o: Partial<InstanceIdentity> & { pid: number }) => ({ createdAt: holderCreatedAt, kind: 'desktop', startedAt: new Date(holderCreatedAt + 500).toISOString(), dataDir: 'C:\\원래 폴더', ...o });

function withStore<T>(fn: (store: Store) => Promise<T>): Promise<T> {
  const store = openStore(':memory:');
  return fn(store).finally(() => store.close());
}

describe('데이터 주인 확인 (S2-15)', () => {
  it('살아 있고 생성 시각이 맞는 다른 욱채가 적혀 있으면 시작하지 않고 저장소를 바꾸지 않는다 — 그 욱채의 종류·pid·데이터 폴더를 알린다', async () => {
    await withStore(async (store) => {
      const recorded = owner({ pid: holder.pid });
      store.kv.set(INSTANCE_KEY, recorded);
      const logs: string[] = [];
      const err = await claimDataOwner({ store, self: self('C:\\복사본'), log: (_l, m) => logs.push(m) }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BackendError);
      expect(isDataOwnerRefusal(err)).toBe(true);
      expect((err as BackendError).code).toBe(DATA_IN_USE);
      expect((err as Error).message).toBe(
        `이 데이터는 실행 중인 욱채(데스크톱 앱, pid ${holder.pid}, 데이터 폴더 C:\\원래 폴더)가 쓰고 있는 데이터입니다(복사본이거나 잠금 파일이 지워짐) — 그 욱채를 끝낸 뒤 다시 시작하세요`,
      );
      expect(store.kv.get(INSTANCE_KEY)).toEqual(recorded);
      expect(logs).toEqual([`시작하지 않음: ${(err as Error).message}`]);
    });
  });

  it('같은 데이터 폴더(잠금 파일이 지워짐)면 폴더를 다시 말하지 않는다', async () => {
    await withStore(async (store) => {
      store.kv.set(INSTANCE_KEY, owner({ pid: holder.pid, kind: 'server', dataDir: 'C:\\여기' }));
      const err = await claimDataOwner({ store, self: self('C:\\여기') }).catch((e: unknown) => e);
      expect((err as Error).message).toBe(`이 데이터는 실행 중인 욱채(서버, pid ${holder.pid})가 쓰고 있는 데이터입니다(복사본이거나 잠금 파일이 지워짐) — 그 욱채를 끝낸 뒤 다시 시작하세요`);
    });
  });

  it('기록이 없거나(예전 DB) 깨졌거나, 죽은 pid, 생성 시각이 다른 다시 쓴 pid, 이 프로세스면 이 프로세스를 적는다', async () => {
    const cases: [string, unknown][] = [
      ['기록 없음', undefined],
      ['깨진 기록', { pid: 'x' }],
      ['죽은 pid', owner({ pid: deadPid })],
      ['다시 쓴 pid (생성 시각이 1분 다름)', owner({ pid: holder.pid, createdAt: holderCreatedAt - 60_000 })],
      ['이 프로세스 (재시작)', owner({ pid: process.pid, createdAt: 1 })],
      // 같은 프로세스가 다시 연 저장소(하네스 재시작 등) — 살아 있고 생성 시각까지 같아도 이 프로세스다
      ['이 프로세스 (같은 생성 시각)', owner({ pid: process.pid, createdAt: myCreatedAt })],
    ];
    for (const [label, recorded] of cases) {
      await withStore(async (store) => {
        if (recorded !== undefined) store.kv.set(INSTANCE_KEY, recorded);
        const me = self();
        await expect(claimDataOwner({ store, self: me }), label).resolves.toBeUndefined();
        expect(store.kv.get(INSTANCE_KEY), label).toEqual(me);
      });
    }
  });

  it('의존성 조립은 저장소를 열자마자 본다 — 거부면 프로세스 러너를 만들지 않고 저장소를 닫는다', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'wook-test-data-owner-'));
    dirs.push(dataDir);
    const seed = openStore(join(dataDir, 'wook.db'));
    seed.kv.set(INSTANCE_KEY, owner({ pid: holder.pid }));
    seed.close();
    const err = await buildOrchestratorDeps({
      dataDir,
      appRoot: process.cwd(),
      isPackaged: true,
      nodeExecPath: process.execPath,
      nodeExecEnv: {},
      shell: null,
      memorySecrets: true,
      instance: self(dataDir),
    }).catch((e: unknown) => e);
    expect(isDataOwnerRefusal(err)).toBe(true);
    // 러너(작업 개체 러너 컴파일 → bin/, 표준 입력 임시 폴더 → tmp/)가 아무것도 만들지 않았다 — 저장소 파일만
    expect(readdirSync(dataDir).filter((f) => !f.startsWith('wook.db'))).toEqual([]);
    if (process.platform === 'win32') {
      // 저장소 파일을 열어 둔 채면 Windows는 이름을 바꾸지 못한다 — 거부하며 닫았는지
      const db = join(dataDir, 'wook.db');
      renameSync(db, `${db}.옮김`);
      renameSync(`${db}.옮김`, db);
    }
    // 저장소를 닫았다 — 다시 열어 기록이 그대로인지 본다
    const again = openStore(join(dataDir, 'wook.db'));
    try {
      expect(again.kv.get<{ pid: number }>(INSTANCE_KEY)?.pid).toBe(holder.pid);
    } finally {
      again.close();
    }
  });
});

describe('깨끗한 종료 때 주인 기록 지우기 (S2-20)', () => {
  it('기록이 아직 이 프로세스(pid·생성 시각·시작 시각이 같음)면 지우고, 하나라도 다르면 그대로 둔다 — 지운 뒤 다음 시작은 기록 없음으로 본다', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'wook-test-data-owner-release-'));
    dirs.push(dataDir);
    const db = join(dataDir, 'wook.db');
    const me: InstanceIdentity = { ...self(dataDir), createdAt: myCreatedAt };
    const write = (v: unknown): void => {
      const store = openStore(db);
      store.kv.set(INSTANCE_KEY, v);
      store.close();
    };
    const read = (): unknown => {
      const store = openStore(db);
      try {
        return store.kv.get(INSTANCE_KEY);
      } finally {
        store.close();
      }
    };
    const cases: [string, unknown][] = [
      ['다른 pid (넘겨받은 다른 욱채)', { ...me, pid: holder.pid }],
      ['같은 pid, 다른 생성 시각 (pid를 다시 쓴 다른 프로세스)', { ...me, createdAt: myCreatedAt - 60_000 }],
      ['같은 pid, 다른 시작 시각', { ...me, startedAt: '2020-01-01T00:00:00.000Z' }],
    ];
    for (const [label, recorded] of cases) {
      write(recorded);
      releaseDataOwner({ dbPath: db, self: me });
      expect(read(), label).toEqual(recorded);
    }
    write(me);
    const logs: string[] = [];
    releaseDataOwner({ dbPath: db, self: me, log: (_l, m) => logs.push(m) });
    expect(read()).toBeNull();
    expect(logs).toEqual(['데이터 주인 기록을 지움 (깨끗한 종료)']);
    // 다음 시작(다른 프로세스)은 기록 없음으로 보고 자기를 적는다
    const store = openStore(db);
    try {
      const next = owner({ pid: holder.pid, dataDir });
      await expect(claimDataOwner({ store, self: next as InstanceIdentity })).resolves.toBeUndefined();
      expect(store.kv.get(INSTANCE_KEY)).toEqual(next);
    } finally {
      store.close();
    }
  });

  it('저장소 파일이 없으면 만들지 않고, 열지 못해도 던지지 않는다 — 기록만 남긴다', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'wook-test-data-owner-release-'));
    dirs.push(dataDir);
    releaseDataOwner({ dbPath: join(dataDir, 'wook.db'), self: self(dataDir) });
    expect(readdirSync(dataDir)).toEqual([]);
    // 저장소 자리에 폴더가 있으면 열지 못한다
    mkdirSync(join(dataDir, 'wook.db'));
    const logs: string[] = [];
    expect(() => releaseDataOwner({ dbPath: join(dataDir, 'wook.db'), self: self(dataDir), log: (_l, m) => logs.push(m) })).not.toThrow();
    expect(logs).toEqual(['데이터 주인 기록을 지우지 못했습니다 (다음 시작은 끝난 프로세스로 보고 넘어갑니다)']);
  });
});
