/**
 * 화면 없는 셸 서비스 (SERVER_DESIGN 3.2, S2-7): 서버 PC의 창·브라우저·파일 선택은 `unavailable_remote`로 분명히 거부하고(성공한 척하지 않음),
 * OS 알림·창 앞으로는 아무것도 하지 않는다. 백엔드에 넘기면 `system.pickFiles`는 빈 목록이 아니라 그 오류다.
 */
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackendError } from '../main/backend/types';
import { buildOrchestratorDeps } from '../main/backend/buildDeps';
import { createInvokeCore } from '../main/backend/invokeCore';
import { createOrchestrator, type Orchestrator } from '../main/orchestrator/orchestrator';
import { createHeadlessShell, HEADLESS_UNAVAILABLE } from './headlessShell';

const dirs: string[] = [];
const orchs: Orchestrator[] = [];
afterEach(async () => {
  for (const o of orchs.splice(0)) await o.stop().catch(() => undefined);
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

async function rejection(p: Promise<unknown>): Promise<BackendError> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(BackendError);
  return e as BackendError;
}

describe('화면 없는 셸 서비스', () => {
  it('서버 PC의 브라우저·파일·파일 선택 창은 unavailable_remote로 거부한다 — 성공한 척하지 않는다', async () => {
    const shell = createHeadlessShell();
    for (const [name, p] of [
      ['openExternal', shell.openExternal('https://accounts.google.com/')],
      ['openPath', shell.openPath(join(tmpdir(), '보고서.md'))],
      ['pickFiles', shell.pickFiles()],
    ] as const) {
      const e = await rejection(p);
      expect([e.code, e.message], name).toEqual(['unavailable_remote', HEADLESS_UNAVAILABLE[name]]);
    }
    expect(HEADLESS_UNAVAILABLE).toEqual({
      openExternal: '서버 모드에서는 서버 PC에서 브라우저를 열 수 없습니다',
      openPath: '서버 모드에서는 서버 PC의 파일이나 폴더를 열 수 없습니다',
      pickFiles: '서버 모드에서는 서버 PC의 파일 선택 창을 열 수 없습니다',
    });
  });

  it('OS 알림·창 앞으로는 아무것도 하지 않는다 (알림은 notification 토픽으로 간다)', () => {
    const shell = createHeadlessShell();
    const onClick = vi.fn();
    expect(shell.showOsNotification({ level: 'urgent', title: '긴급', body: '본문', onClick })).toBeUndefined();
    expect(shell.focusWindow()).toBeUndefined();
    expect(onClick).not.toHaveBeenCalled();
    expect(Object.keys(shell).sort()).toEqual(['focusWindow', 'openExternal', 'openPath', 'pickFiles', 'showOsNotification']);
  });

  it('백엔드에 넘기면: system.pickFiles·openPath는 그 오류를 돌려주고(빈 목록·조용한 성공이 아님), 긴급 알림은 화면 토픽으로만 간다', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'wook-test-headless-'));
    dirs.push(dataDir);
    const deps = await buildOrchestratorDeps({
      dataDir,
      appRoot: process.cwd(),
      // 서버처럼: 늘 패키징으로 보고 시험용 세션으로 들어온다 (S2-2)
      isPackaged: true,
      allowDevLogin: true,
      nodeExecPath: process.execPath,
      nodeExecEnv: {},
      shell: createHeadlessShell(),
      memorySecrets: true,
      runnerMode: process.platform === 'win32' ? 'taskkill' : 'pgroup',
      jobHelper: null,
      timing: { watchdogMs: 200, snapshotThrottleMs: 20 },
    });
    const orch = await createOrchestrator(deps);
    orchs.push(orch);
    await orch.backend.invoke('auth.devLogin', []);
    await expect(orch.backend.invoke('system.pickFiles', [])).rejects.toMatchObject({ code: 'unavailable_remote', message: HEADLESS_UNAVAILABLE.pickFiles });
    await expect(orch.backend.invoke('system.openPath', [join(dataDir, 'reports')])).rejects.toMatchObject({ code: 'unavailable_remote', message: HEADLESS_UNAVAILABLE.openPath });
    // 요청 길(invokeCore)로는 화면에 그대로 보일 오류 응답이다
    const invoke = createInvokeCore({ backend: orch.backend, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, channel: 'HTTP' });
    await expect(invoke('system.pickFiles', [])).resolves.toEqual({ ok: false, error: { code: 'unavailable_remote', message: HEADLESS_UNAVAILABLE.pickFiles } });
    const pushed: string[] = [];
    const off = orch.backend.onTopic('notification', (n) => pushed.push(n.title));
    orch.core.ctx.notify({ level: 'urgent', title: '서버 긴급 알림', body: '본문' });
    off();
    expect(pushed).toEqual(['서버 긴급 알림']);
  });
});
