/**
 * 서버 시작의 미리 보기는 값도 본다 (SERVER_DESIGN 3.7, 리드 결정 S3-35 — 둘째 검토 flows-lifecycle의 프로브 zz-s3fx-startcheck를 옮김).
 * - server.json의 owner.email·google.clientId·cli.claudePath·cli.codexPath와 --owner-email의 모양을 실행 잠금·백엔드(저장소·재시작 복구)보다 먼저 본다 —
 *   틀리면 1로 끝나고 server.lock·wook.db를 만들지 않는다(예전에는 백엔드가 저장소를 만들고 복구를 돌린 뒤에야 거부했다)
 * - 명령 줄의 --owner-email은 인자를 읽을 때 본다 — 틀리면 그 인자를 말하는 사용법 오류(2)이고 데이터 폴더에 아무것도 만들지 않는다. 글은 server.json을
 *   탓하지 않는다
 * - 적용(operator.applyServerConfig)도 같은 확인을 하고, 글은 값이 온 곳('--owner-email'·'server.json')을 말한다
 * 넣은 값은 글에 되풀이하지 않는다
 */
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createHarness } from '../e2e/harness';
import { createBackendOperator } from '../../src/main/backend/operator';
import { OWNER_EMAIL_FLAG_INVALID } from '../../src/main/orchestrator/serverLogin';
import { parseCli, runCli } from '../../src/server/cli';
import { precheckServerConfig } from '../../src/server/config';
import { runServe } from '../../src/server/serve';
import { removeDir } from './helpers';

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await removeDir(d);
});

const newDataDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'wook-test-precheck-'));
  dirs.push(d);
  return d;
};

/** 프로세스 안에서 서버를 띄워 본다 — runServe가 붙인 프로세스 처리기는 뗀다(이 시험 프로세스에 남기지 않는다) */
async function serveWith(file: unknown, opts: { ownerEmail?: string } = {}): Promise<{ code: number | null; stderr: string; lock: boolean; db: boolean }> {
  const dataDir = newDataDir();
  if (file !== null) writeFileSync(join(dataDir, 'server.json'), JSON.stringify(file));
  const events = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK', 'uncaughtException', 'unhandledRejection'];
  const before = new Map(events.map((e) => [e, process.listeners(e as NodeJS.Signals)]));
  const err: string[] = [];
  let code: number | null;
  try {
    code = await runServe(
      { dataDir, bind: '127.0.0.1', port: 0, webDir: null, allowTestSession: false, ...opts },
      { out: async () => undefined, err: async (t) => void err.push(t), exit: () => undefined },
    );
  } finally {
    for (const e of events) for (const l of process.listeners(e as NodeJS.Signals)) if (!before.get(e)!.includes(l)) process.off(e, l);
  }
  return { code, stderr: err.join(''), lock: existsSync(join(dataDir, 'server.lock')), db: existsSync(join(dataDir, 'wook.db')) };
}

const START_FAILED = '욱채 서버를 시작하지 못했습니다: 운영자 설정을 적용하지 못했습니다 — ';

describe('서버 시작의 미리 보기는 적용할 값도 본다 (S3-35)', () => {
  const cases: [name: string, file: unknown, message: string, bad: string][] = [
    ['owner.email', { owner: { email: 'owner at example.com' } }, 'server.json의 대표 이메일(owner.email) 모양이 아닙니다', 'owner at example.com'],
    [
      'google.clientId',
      { google: { clientId: 'not-a-client-id' } },
      'server.json의 구글 클라이언트 ID(google.clientId)가 구글 OAuth 클라이언트 ID 모양(…apps.googleusercontent.com)이 아닙니다',
      'not-a-client-id',
    ],
    ['cli.claudePath', { cli: { claudePath: 'C:\\tools\u0007claude.exe' } }, 'server.json의 Claude CLI 실행 파일 위치(cli.claudePath)가 올바르지 않습니다', 'claude.exe'],
    ['cli.codexPath', { cli: { codexPath: `C:\\${'긴경로'.repeat(400)}\\codex.exe` } }, 'server.json의 Codex CLI 실행 파일 위치(cli.codexPath)가 올바르지 않습니다', 'codex.exe'],
  ];

  for (const [name, file, message, bad] of cases) {
    it(`server.json의 틀린 ${name}은 1로 끝나고 실행 잠금·저장소를 만들지 않는다 — 글은 그 칸을 말하고 값은 되풀이하지 않는다`, async () => {
      const r = await serveWith(file);
      expect({ code: r.code, lock: r.lock, db: r.db }).toEqual({ code: 1, lock: false, db: false });
      expect(r.stderr.split('\n')[0]).toBe(`${START_FAILED}${message}`);
      expect(r.stderr.includes(bad)).toBe(false);
    });
  }

  it('--owner-email이 틀리면(서버를 바로 띄워도) 1로 끝나고 실행 잠금·저장소를 만들지 않는다 — 글은 그 인자를 말하고 server.json을 탓하지 않는다', async () => {
    const r = await serveWith(null, { ownerEmail: 'owner-at-example' });
    expect({ code: r.code, lock: r.lock, db: r.db }).toEqual({ code: 1, lock: false, db: false });
    const line = r.stderr.split('\n')[0]!;
    expect(line).toBe(`${START_FAILED}${OWNER_EMAIL_FLAG_INVALID}`);
    expect([line.includes('server.json'), r.stderr.includes('owner-at-example')]).toEqual([false, false]);
    // 파일의 owner.email이 맞아도 인자가 먼저다 — 틀린 인자로는 시작하지 않는다
    const withFile = await serveWith({ owner: { email: 'owner@example.com' } }, { ownerEmail: 'owner-at-example' });
    expect([withFile.code, withFile.db, withFile.stderr.split('\n')[0]]).toEqual([1, false, `${START_FAILED}${OWNER_EMAIL_FLAG_INVALID}`]);
  });

  it('미리 보기는 맞는 값을 통과시킨다 — 인자가 덮는 파일의 owner.email은 쓰지 않으므로 보지 않는다', () => {
    const dir = newDataDir();
    const path = join(dir, 'server.json');
    writeFileSync(path, JSON.stringify({ owner: { email: 'owner@example.com' }, google: { clientId: '123-tv.apps.googleusercontent.com' }, cli: { claudePath: 'C:\\tools\\claude.exe' } }));
    expect(precheckServerConfig(path, { ownerEmail: null })).toEqual({ ok: true });
    expect(precheckServerConfig(join(dir, '없는 파일.json'), { ownerEmail: 'owner@example.com' })).toEqual({ ok: true });
    writeFileSync(path, JSON.stringify({ owner: { email: 'owner at example.com' } }));
    expect(precheckServerConfig(path, { ownerEmail: 'flag-owner@example.com' })).toEqual({ ok: true });
    expect(precheckServerConfig(path, { ownerEmail: null })).toEqual({ ok: false, message: 'server.json의 대표 이메일(owner.email) 모양이 아닙니다' });
  });
});

describe('명령 줄의 --owner-email (S3-35)', () => {
  it('인자를 읽을 때 본다 — 틀리면 그 인자를 말하는 사용법 오류(2)이고 데이터 폴더에 아무것도 만들지 않는다', async () => {
    expect(parseCli(['serve', '--owner-email', 'owner-at-example', '--data-dir', 'd'], {})).toEqual({ kind: 'error', message: OWNER_EMAIL_FLAG_INVALID });
    expect(parseCli(['serve', '--owner-email', '', '--data-dir', 'd'], {})).toEqual({ kind: 'error', message: OWNER_EMAIL_FLAG_INVALID });
    expect(parseCli(['serve', '--owner-email', ' Owner@Example.com ', '--data-dir', 'd'], {})).toMatchObject({ kind: 'serve', options: { ownerEmail: ' Owner@Example.com ' } });
    const dataDir = newDataDir();
    const err: string[] = [];
    const code = await runCli(['serve', '--owner-email', 'owner-at-example', '--data-dir', dataDir, '--port', '0'], {
      out: async () => undefined,
      err: async (t) => void err.push(t),
      exit: () => undefined,
    });
    expect(code).toBe(2);
    // 첫 줄이 그 인자를 말하고(server.json을 탓하지 않는다), 그 뒤는 사용법이다
    expect(err.join('').startsWith(`${OWNER_EMAIL_FLAG_INVALID}\n\n욱채 서버 (`)).toBe(true);
    expect(readdirSync(dataDir)).toEqual([]);
  });

  it('적용(applyServerConfig)도 같은 확인을 하고 값이 온 곳을 말한다 — --owner-email이면 그 인자, server.json이면 그 칸. 아무것도 바꾸지 않는다', async () => {
    const h = await createHarness({ mode: 'server', noProject: true });
    try {
      const op = createBackendOperator(() => h.core);
      expect(() => op.applyServerConfig({ ownerEmail: { email: 'owner-at-example', source: 'flag' } }, 'server.json(파일 없음)')).toThrow(OWNER_EMAIL_FLAG_INVALID);
      expect(() => op.applyServerConfig({ ownerEmail: { email: 'owner at example.com', source: 'config' } }, 'server.json')).toThrow('server.json의 대표 이메일(owner.email) 모양이 아닙니다');
      // 앞의 값이 맞아도 뒤의 값 하나가 틀리면 아무것도 바꾸지 않는다
      expect(() => op.applyServerConfig({ ownerEmail: { email: 'owner@example.com', source: 'config' }, cli: { codexPath: 'a\u0000b' } }, 'server.json')).toThrow(
        'server.json의 Codex CLI 실행 파일 위치(cli.codexPath)가 올바르지 않습니다',
      );
      expect(h.core.serverLogin.ownerEmail()).toBeNull();
    } finally {
      await h.close();
    }
  });
});
