/**
 * 백엔드 조립(createBackend)이 껍데기의 값을 오케스트레이터 의존성 조립에 그대로 넘기는지 (리드 결정 S2-2·S2-7):
 * 개발 모드 로그인 스위치(allowDevLogin)는 패키징 여부와 따로 가고, 화면 없는 실행은 셸 서비스 없이(null) 돈다.
 * 깨끗이 끝나면(backend.shutdown 뒤) 저장소의 데이터 주인 기록이 아직 이 프로세스일 때 지운다 (S2-20 — 데스크톱 index.ts와 서버 serve.ts가 모두 이 shutdown으로 끝난다).
 * 의존성 조립과 오케스트레이터는 가짜로 바꾼다 — 실제 OS 보안 저장소·CLI를 건드리지 않는다. 저장소는 실제 파일이다.
 */
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openStore } from '../db/store';
import type { BackendDeps } from './types';

const h = vi.hoisted(() => ({
  built: [] as Record<string, unknown>[],
  shutdown: vi.fn(async () => undefined),
}));
vi.mock('./buildDeps', () => ({
  buildOrchestratorDeps: vi.fn(async (o: Record<string, unknown>) => {
    h.built.push(o);
    return { redactor: { text: (t: string) => t }, runner: { mode: 'pgroup', detail: '시험' } };
  }),
}));
vi.mock('../orchestrator/orchestrator', () => ({
  createOrchestrator: vi.fn(async () => ({ backend: { shutdown: h.shutdown } })),
}));

import { createBackend } from './createBackend';

const dirs: string[] = [];
afterEach(async () => {
  h.built.length = 0;
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

function deps(o: Partial<BackendDeps>): BackendDeps {
  const dataDir = mkdtempSync(join(tmpdir(), 'wook-test-create-backend-'));
  dirs.push(dataDir);
  const instance = { pid: process.pid, createdAt: null, kind: 'server' as const, startedAt: new Date().toISOString(), dataDir };
  return { dataDir, appRoot: process.cwd(), isPackaged: true, allowDevLogin: false, mode: 'desktop', instance, nodeExecPath: process.execPath, nodeExecEnv: {}, shell: null, ...o };
}

describe('createBackend가 넘기는 값', () => {
  it('allowDevLogin은 isPackaged와 따로 그대로 넘긴다 — 서버(패키징·시험용 세션), 설치된 데스크톱, 개발 실행', async () => {
    for (const o of [
      { isPackaged: true, allowDevLogin: true },
      { isPackaged: true, allowDevLogin: false },
      { isPackaged: false, allowDevLogin: true },
      { isPackaged: false, allowDevLogin: false },
    ]) {
      const backend = await createBackend(deps(o));
      await backend.shutdown();
    }
    expect(h.built.map((b) => [b['isPackaged'], b['allowDevLogin']])).toEqual([
      [true, true],
      [true, false],
      [false, true],
      [false, false],
    ]);
  });

  it('로그인 방식(mode)을 그대로 넘긴다 — 데스크톱과 서버 (S3-2)', async () => {
    for (const mode of ['desktop', 'server'] as const) {
      const backend = await createBackend(deps({ mode }));
      await backend.shutdown();
    }
    expect(h.built.map((b) => b['mode'])).toEqual(['desktop', 'server']);
  });

  it('셸 서비스가 없으면(null) 그대로 null을 넘긴다 (S2-7: BackendDeps.shell은 null 허용)', async () => {
    const backend = await createBackend(deps({ shell: null }));
    await backend.shutdown();
    expect(h.built[0]!['shell']).toBeNull();
    expect(h.shutdown).toHaveBeenCalled();
  });
});

describe('깨끗한 종료와 데이터 주인 기록 (S2-20)', () => {
  const seed = (dataDir: string, value: unknown): void => {
    const store = openStore(join(dataDir, 'wook.db'));
    store.kv.set('instance', value);
    store.close();
  };
  const recorded = (dataDir: string): unknown => {
    const store = openStore(join(dataDir, 'wook.db'));
    try {
      return store.kv.get('instance');
    } finally {
      store.close();
    }
  };

  it('backend.shutdown이 끝난 뒤 저장소의 주인 기록이 아직 이 프로세스면 지운다 — 데스크톱과 서버가 모두 이 길로 끝난다', async () => {
    const d = deps({});
    seed(d.dataDir, d.instance);
    let duringShutdown: unknown = 'not called';
    h.shutdown.mockImplementationOnce(async () => {
      duringShutdown = recorded(d.dataDir);
    });
    await (await createBackend(d)).shutdown();
    // 오케스트레이터가 끝나는 동안(CLI를 끝내고 체크포인트를 남기는 동안)에는 기록이 그대로다
    expect(duringShutdown).toEqual(d.instance);
    expect(recorded(d.dataDir)).toBeNull();
  });

  it('다른 프로세스를 적은 기록은 두고, 끝내기에 실패하면 지우지 않는다 (남은 기록은 비정상 종료를 뜻한다)', async () => {
    const d = deps({});
    const other = { ...d.instance, pid: d.instance.pid + 1 };
    seed(d.dataDir, other);
    await (await createBackend(d)).shutdown();
    expect(recorded(d.dataDir)).toEqual(other);

    const failing = deps({});
    seed(failing.dataDir, failing.instance);
    h.shutdown.mockRejectedValueOnce(new Error('체크포인트 실패'));
    await expect((await createBackend(failing)).shutdown()).rejects.toThrow('체크포인트 실패');
    expect(recorded(failing.dataDir)).toEqual(failing.instance);
  });
});
