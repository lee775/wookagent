/**
 * 서버 시작 (SERVER_DESIGN 3.2, S2-5): 빌드한 서버로 본다.
 * - 시작이 실패하면 stderr와 기록에 남기고, 잠금을 놓고, 1로 끝낸다 (포트를 이미 씀, 루프백 밖 --bind)
 * - 없는 데이터 폴더는 그 사용자만 쓰게 만든다 (S2-17 — prepareDataDir 자체는 dataDir.test). 좁히지 못한 시작은 폴더를 남기지 않는다 (S2-20)
 * - 작업 개체 러너를 쓸 수 없어 taskkill 방식으로 대체하는 PC에서도 준비될 때까지 기다린다 — 백엔드 준비가 프로세스를 붙잡지 않는 핸들만 기다리는 동안
 *   Node가 할 일이 없다고 보고 조용히 0으로 끝나지 않는다 (2단계에서 찾은 문제)
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServerTo, childEnv, clientJson, removeDir, REPO, runClient, startBuilt, testBuildDir, workspaceArgs, windowsAcl, windowsMe } from './helpers';

let buildDir = '';
let entry = '';
const dirs: string[] = [];

beforeAll(() => {
  buildDir = testBuildDir('startup');
  entry = buildServerTo(buildDir);
}, 120_000);

afterAll(async () => {
  for (const d of dirs) await removeDir(d);
  await removeDir(buildDir);
});

const tempDir = (tag: string): string => {
  const d = mkdtempSync(join(tmpdir(), `wook-test-startup-${tag}-`));
  dirs.push(d);
  return d;
};

function serveOnce(dataDir: string, args: string[], env: NodeJS.ProcessEnv = {}): { code: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [entry, 'serve', '--data-dir', dataDir, ...workspaceArgs(dataDir, args), ...args], { cwd: REPO, encoding: 'utf8', windowsHide: true, timeout: 90_000, env: childEnv(env) });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

describe('시작 실패', () => {
  it('포트를 이미 다른 프로그램이 쓰면 1로 끝내고, 잠금을 놓고, 기록에 남긴다', async () => {
    const busy: Server = createServer();
    await new Promise<void>((r) => busy.listen(0, '127.0.0.1', () => r()));
    const port = (busy.address() as { port: number }).port;
    try {
      const dataDir = tempDir('port');
      const r = serveOnce(dataDir, ['--port', String(port)]);
      expect(r.code).toBe(1);
      expect(r.stdout).not.toContain('준비 완료');
      expect(r.stderr).toContain(`욱채 서버를 시작하지 못했습니다: 포트 ${port}을 이미 다른 프로그램이 쓰고 있습니다 — --port로 다른 포트를 고르세요`);
      expect(existsSync(join(dataDir, 'server.lock'))).toBe(false);
      expect(existsSync(join(dataDir, 'admin.token'))).toBe(false);
      expect(readFileSync(join(dataDir, 'logs', 'server.log'), 'utf8')).toContain(`시작 실패: 포트 ${port}을 이미 다른 프로그램이 쓰고 있습니다`);
      // 같은 데이터 폴더로 바로 다시 시작할 수 있다 (잠금이 남지 않았다)
      const again = await startBuilt({ entry, dataDir });
      expect(runClient(entry, ['shutdown', '--data-dir', dataDir]).code).toBe(0);
      expect((await again.exited).code).toBe(0);
    } finally {
      busy.close();
    }
  }, 120_000);

  it('루프백 밖 --bind는 무엇도 만들기 전에 거부한다 (1) — 잠금·기록·DB가 생기지 않는다', () => {
    for (const bind of ['0.0.0.0', '192.168.0.10', '::']) {
      const dataDir = join(tempDir('bind'), '데이터');
      const r = serveOnce(dataDir, ['--bind', bind, '--port', '0']);
      expect(r.code, bind).toBe(1);
      expect(r.stderr).toContain(`욱채 서버를 시작하지 못했습니다: --bind ${bind}는 받지 않습니다 — 서버는 이 PC 안(127.0.0.1, ::1, localhost)에만 엽니다`);
      expect(existsSync(dataDir), bind).toBe(false);
    }
  }, 120_000);
});

describe('새 데이터 폴더 (S2-5 2번, S2-17)', () => {
  it('없는 데이터 폴더는 그 사용자만 쓰게 만들고 시작한다 — Windows는 상속 끊고 지금 사용자만, POSIX는 0700', async () => {
    const dataDir = join(tempDir('new'), '새 데이터 폴더');
    const srv = await startBuilt({ entry, dataDir });
    try {
      if (process.platform === 'win32') {
        const acl = windowsAcl(dataDir);
        expect(acl.protected).toBe(true);
        expect(acl.rules.map((r) => [r.id, r.inherited, r.rights, r.flags])).toEqual([[windowsMe(), false, 'FullControl', 'ContainerInherit, ObjectInherit']]);
        // 서버가 만든 DB도 그 권한을 물려받았다
        expect(windowsAcl(join(dataDir, 'wook.db')).rules.map((r) => [r.id, r.inherited])).toEqual([[windowsMe(), true]]);
      } else {
        expect(statSync(dataDir).mode & 0o777).toBe(0o700);
      }
    } finally {
      expect(runClient(entry, ['shutdown', '--data-dir', dataDir]).code).toBe(0);
      expect((await srv.exited).code).toBe(0);
    }
  }, 120_000);

  it('Windows: 새 데이터 폴더를 좁히지 못한 시작(1)은 폴더를 남기지 않는다 — 다시 시작하면 좁혀서 만든다 (S2-20, 리뷰 프로브 zz-lc2-new T2)', async (ctx) => {
    if (process.platform !== 'win32') ctx.skip('Windows ACL(icacls) 실패를 흉내 낸다 — POSIX의 chmod는 막 만든 그 사용자 폴더에서 실패하지 않는다');
    const parent = tempDir('acl-fail');
    const dataDir = join(parent, '새 데이터 폴더');
    // 풀 수 없는 계정 이름이라 icacls가 실패한다 (이 서버 프로세스만)
    const r = serveOnce(dataDir, ['--port', '0'], { USERNAME: 'no-such-user-wook-test', USERDOMAIN: 'NO-SUCH-DOMAIN' });
    expect(r.code).toBe(1);
    expect(r.stdout).not.toContain('준비 완료');
    expect(r.stderr).toContain(`욱채 서버를 시작하지 못했습니다: 데이터 폴더를 준비하지 못했습니다 (${dataDir}) — `);
    expect(existsSync(dataDir)).toBe(false);
    expect(readdirSync(parent)).toEqual([]);
    const srv = await startBuilt({ entry, dataDir });
    try {
      const acl = windowsAcl(dataDir);
      expect(acl.protected).toBe(true);
      expect(acl.rules.map((x) => [x.id, x.inherited, x.rights])).toEqual([[windowsMe(), false, 'FullControl']]);
    } finally {
      expect(runClient(entry, ['shutdown', '--data-dir', dataDir]).code).toBe(0);
      expect((await srv.exited).code).toBe(0);
    }
  }, 120_000);
});

describe('준비까지 기다리기', () => {
  it('작업 개체 러너를 쓸 수 없어 taskkill 방식으로 대체해도 준비될 때까지 기다린다', async (ctx) => {
    if (process.platform !== 'win32') ctx.skip('작업 개체 러너와 taskkill 대체는 Windows에만 있다');
    const dataDir = tempDir('taskkill');
    // C# 컴파일러를 찾지 못하게 해 러너 대신 taskkill + 작업 개체 도우미(PowerShell)로 시작하게 한다
    const srv = await startBuilt({ entry, dataDir, env: { WINDIR: join(dataDir, '없는 Windows') } });
    expect(clientJson(entry, ['status', '--data-dir', dataDir]).reply.ok).toBe(true);
    expect(readFileSync(join(dataDir, 'logs', 'backend.log'), 'utf8')).toContain('taskkill 방식으로 대체');
    expect(runClient(entry, ['shutdown', '--data-dir', dataDir]).code).toBe(0);
    expect((await srv.exited).code).toBe(0);
    expect(existsSync(join(dataDir, 'server.lock'))).toBe(false);
  }, 120_000);
});
