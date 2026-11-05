/**
 * 개발 모드 로그인 스위치를 패키징 여부에서 떼어 냈다 (SERVER_DESIGN 3.5, 리드 결정 S2-2).
 * - auth.isLoggedIn(개발 모드 세션)·auth.getState의 devLoginAllowed·auth.devLogin은 isPackaged가 아니라 deps.allowDevLogin을 본다
 * - 서버는 늘 패키징으로 보고(isPackaged true) --allow-test-session일 때만 allowDevLogin을 켠다. 그 플래그 없이 다시 켜면 DB에 남은 개발 모드 세션은
 *   로그인으로 보지 않는다
 * - 데스크톱은 !isPackaged를 넘겨 예전과 같다(src/main/shell/index.wiring.test.ts). 값을 주지 않은 앱 조립(시험 하네스)도 예전 판정 그대로다
 */
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildOrchestratorDeps } from '../../src/main/backend/buildDeps';
import { createOrchestrator, type Orchestrator } from '../../src/main/orchestrator/orchestrator';

const dirs: string[] = [];
const running: Orchestrator[] = [];
afterEach(async () => {
  for (const o of running.splice(0)) await o.stop().catch(() => undefined);
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'wook-test-devlogin-'));
  dirs.push(d);
  return d;
}

async function boot(dataDir: string, o: { isPackaged: boolean; allowDevLogin?: boolean }): Promise<Orchestrator> {
  const deps = await buildOrchestratorDeps({
    dataDir,
    appRoot: process.cwd(),
    isPackaged: o.isPackaged,
    ...(o.allowDevLogin !== undefined ? { allowDevLogin: o.allowDevLogin } : {}),
    nodeExecPath: process.execPath,
    nodeExecEnv: {},
    shell: null,
    memorySecrets: true,
    runnerMode: process.platform === 'win32' ? 'taskkill' : 'pgroup',
    jobHelper: null,
    timing: { watchdogMs: 200, snapshotThrottleMs: 20 },
  });
  const orch = await createOrchestrator(deps);
  running.push(orch);
  return orch;
}

async function stop(orch: Orchestrator): Promise<void> {
  running.splice(running.indexOf(orch), 1);
  await orch.stop();
}

const state = async (orch: Orchestrator) => {
  const s = await orch.backend.invoke('auth.getState', []);
  return { loggedIn: s.loggedIn, devLoginAllowed: s.devLoginAllowed };
};

describe('개발 모드 로그인 스위치 allowDevLogin (S2-2)', () => {
  it('서버처럼 패키징으로 보고 시험용 세션을 켜면 개발 모드 로그인이 되고, 같은 플래그로 다시 켜도 그 세션이 이어진다. 플래그 없이 켜면 남은 세션은 로그인이 아니고 개발 모드 로그인도 거부한다', async () => {
    const dataDir = tempDir();
    const first = await boot(dataDir, { isPackaged: true, allowDevLogin: true });
    expect(await state(first)).toEqual({ loggedIn: false, devLoginAllowed: true });
    await first.backend.invoke('auth.devLogin', []);
    expect(await state(first)).toEqual({ loggedIn: true, devLoginAllowed: true });
    await expect(first.backend.invoke('snapshot.get', [])).resolves.toMatchObject({ version: expect.any(Number) });
    await stop(first);

    const again = await boot(dataDir, { isPackaged: true, allowDevLogin: true });
    expect(await state(again)).toEqual({ loggedIn: true, devLoginAllowed: true });
    await stop(again);

    // --allow-test-session 없이 띄운 서버: DB에 남은 개발 모드 세션은 로그인으로 보지 않는다
    const plain = await boot(dataDir, { isPackaged: true, allowDevLogin: false });
    expect(await state(plain)).toEqual({ loggedIn: false, devLoginAllowed: false });
    await expect(plain.backend.invoke('snapshot.get', [])).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(plain.backend.invoke('auth.devLogin', [])).rejects.toMatchObject({ code: 'forbidden', message: '개발 모드 로그인은 개발 실행에서만 쓸 수 있습니다' });
    expect(await state(plain)).toEqual({ loggedIn: false, devLoginAllowed: false });
  });

  it('패키징되지 않은 실행이라도 allowDevLogin이 꺼져 있으면 거부한다 — 패키징 여부를 보지 않는다', async () => {
    const orch = await boot(tempDir(), { isPackaged: false, allowDevLogin: false });
    expect(await state(orch)).toEqual({ loggedIn: false, devLoginAllowed: false });
    await expect(orch.backend.invoke('auth.devLogin', [])).rejects.toMatchObject({ code: 'forbidden' });
    expect(await state(orch)).toEqual({ loggedIn: false, devLoginAllowed: false });
  });

  it('값을 주지 않은 앱 조립은 예전 판정 그대로(!isPackaged) — 그 값을 의존성에 채워 넘긴다', async () => {
    const base = { appRoot: process.cwd(), nodeExecPath: process.execPath, nodeExecEnv: {}, shell: null, memorySecrets: true, runnerMode: process.platform === 'win32' ? ('taskkill' as const) : ('pgroup' as const), jobHelper: null };
    const dev = await buildOrchestratorDeps({ ...base, dataDir: tempDir(), isPackaged: false });
    const pkg = await buildOrchestratorDeps({ ...base, dataDir: tempDir(), isPackaged: true });
    const server = await buildOrchestratorDeps({ ...base, dataDir: tempDir(), isPackaged: true, allowDevLogin: true });
    expect([dev.allowDevLogin, pkg.allowDevLogin, server.allowDevLogin]).toEqual([true, false, true]);
    for (const d of [dev, pkg, server]) d.store.close();

    const devApp = await boot(tempDir(), { isPackaged: false });
    expect(await state(devApp)).toEqual({ loggedIn: false, devLoginAllowed: true });
    const pkgApp = await boot(tempDir(), { isPackaged: true });
    expect(await state(pkgApp)).toEqual({ loggedIn: false, devLoginAllowed: false });
  });
});
