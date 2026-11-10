/**
 * 빌드한 서버가 뜨는지 (SERVER_DESIGN 10.2, S2-9·S2-11 boot): `npm run build:server`로 out/server/index.mjs를 한 번 만들고, 임시 데이터 폴더와
 * `--allow-test-session`으로 띄운 뒤 관리 채널로 운영자 시험 세션(실제 기기 세션, 리드 결정 S3-4)을 받아 HTTP로 `system.prereqs`를 부른다.
 * - 키링이 있는 운영체제(Windows·macOS)에서 비밀 값 저장소가 메모리로 떨어지지 않았는지 (import.meta.url을 살린 빌드)
 * - 서버의 대표 길은 원격 게이트이고, 셸은 화면 없는 셸이다. 서버 모드는 개발 모드 로그인·브라우저 로그인이 없고 kv 대표 세션을 쓰지 않는다 (S3-2)
 * - 끝낸 뒤 기록과 데이터 파일 어디에도 토큰·인자가 없다 — DB에는 세션 토큰의 해시만 있다
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OPERATOR, OWNER } from '@shared/domain';
import { hashSessionToken } from '../../src/main/auth/deviceSessions';
import { openStore } from '../../src/main/db/store';
import { PLACEHOLDER_PAGE } from '../../src/server/http';
import type { AdminStatus } from '../../src/server/server';
import { clientJson, httpCall, invokeHttp, issueTokenBuilt, REPO, removeDir, runClient, startBuilt, type BuiltServer } from './helpers';

const entry = join(REPO, 'out', 'server', 'index.mjs');
const version = (JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { version: string }).version;
const MARKER = 'WOOK-BOOT-ARG-MARKER-51c0e8';
let dataDir = '';
let srv: BuiltServer | null = null;
let token = '';
let stopped = false;

beforeAll(async () => {
  // 운영자가 하는 그대로: npm 스크립트로 빌드한다
  const build = spawnSync('npm run build:server', { cwd: REPO, shell: true, encoding: 'utf8', windowsHide: true, env: { ...process.env, VITE_CONFIG_NATIVE_IGNORE_WARNING: 'true' } });
  if (build.status !== 0) throw new Error(`npm run build:server 실패: ${build.stderr}`);
  dataDir = mkdtempSync(join(tmpdir(), 'wook-test-boot-'));
  srv = await startBuilt({ entry, dataDir, args: ['--allow-test-session'] });
  token = issueTokenBuilt(entry, dataDir);
}, 180_000);

afterAll(async () => {
  if (srv && !stopped) {
    runClient(entry, ['shutdown', '--data-dir', dataDir]);
    await Promise.race([srv.exited, new Promise((r) => setTimeout(r, 40_000))]);
    if (srv.child.exitCode === null) srv.child.kill();
  }
  if (dataDir) await removeDir(dataDir);
});

describe('빌드한 서버 (out/server/index.mjs)', () => {
  it('빌드 결과는 out/server의 Node ESM이고 electron을 불러오지 않는다', () => {
    const files = readdirSync(join(REPO, 'out', 'server')).filter((f) => f.endsWith('.mjs'));
    expect(files).toContain('index.mjs');
    for (const f of files) expect(readFileSync(join(REPO, 'out', 'server', f), 'utf8')).not.toMatch(/from ["']electron["']|require\(["']electron["']\)/);
  });

  it('임시 데이터 폴더로 떠서 준비 줄(주소·실행 ID·데이터 폴더)을 내고, status가 같은 값을 말한다', () => {
    expect(srv!.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(srv!.stdout()).toContain(`데이터 폴더 ${dataDir}`);
    const { code, reply } = clientJson(entry, ['status', '--data-dir', dataDir]);
    expect(code).toBe(0);
    const s = reply.result as AdminStatus;
    expect(s).toMatchObject({ pid: srv!.child.pid, port: srv!.port, url: srv!.url, runId: srv!.runId, dataDir, bind: '127.0.0.1', version, testSessions: { allowed: true, active: 1 } });
  });

  it('키링이 있는 운영체제에서는 비밀 값 저장소가 OS 보안 저장소다 — 빌드가 import.meta.url을 살려 메모리로 떨어지지 않았다', (ctx) => {
    if (process.platform === 'linux') ctx.skip('Linux: 화면 없는 PC에는 키링이 없을 수 있다 (3.7 — 파일 저장소는 뒤 단계)');
    const s = clientJson(entry, ['status', '--data-dir', dataDir]).reply.result as AdminStatus;
    expect(s.secretStore).toEqual({ backend: 'keyring', fallbackReason: null });
  });

  it('관리 채널로 받은 운영자 시험 세션으로 HTTP system.prereqs가 응답한다', async () => {
    expect(/^wos_[A-Za-z0-9_-]{43}$/.test(token)).toBe(true);
    const r = await invokeHttp(srv!.url, token, 'system.prereqs');
    expect(r.status).toBe(200);
    const body = r.json<{ ok: boolean; value: { git: { ok: boolean }; claude: object; codex: object; jobRunner: object } }>();
    expect(body.ok).toBe(true);
    expect(Object.keys(body.value).sort()).toEqual(['claude', 'codex', 'git', 'google', 'jobRunner', 'screen']);
    expect(typeof body.value.git.ok).toBe('boolean');
  }, 60_000);

  it('서버의 대표 길은 원격 게이트다 — 데스크톱 운영자 메서드는 403이고 활동 기록에 남는다', async () => {
    for (const [method, args] of [
      ['settings.update', [{ account: { authMode: { claude: 'subscription' } } }]],
      ['settings.setApiKey', ['claude', MARKER]],
      ['projects.setMock', ['P-0001', { enabled: false }]],
    ] as const) {
      const r = await invokeHttp(srv!.url, token, method, [...args]);
      expect(r.status, method).toBe(403);
      expect(r.json<{ error: { code: string } }>().error.code).toBe('forbidden');
    }
    const rows = await invokeHttp(srv!.url, token, 'logs.search', [{ text: '대표 권한 밖 요청 거부', limit: 20 }]);
    const texts = rows.json<{ value: { text: string }[] }>().value.map((x) => x.text);
    expect(texts).toEqual(expect.arrayContaining(['대표 권한 밖 요청 거부: settings.update', '대표 권한 밖 요청 거부: settings.setApiKey', '대표 권한 밖 요청 거부: projects.setMock']));
  });

  it('서버의 셸은 화면 없는 셸이다 — 파일 선택은 빈 목록이 아니라 unavailable_remote(409)', async () => {
    const r = await invokeHttp(srv!.url, token, 'system.pickFiles');
    expect(r.status).toBe(409);
    expect(r.json()).toEqual({ ok: false, error: { code: 'unavailable_remote', message: '서버 모드에서는 서버 PC의 파일 선택 창을 열 수 없습니다' } });
  });

  it('서버 모드에는 개발 모드 로그인과 이 PC의 브라우저 로그인이 없다(403) — auth.getState는 이 기기의 상태 (S3-2·S3-3)', async () => {
    const devLogin = await invokeHttp(srv!.url, token, 'auth.devLogin');
    expect([devLogin.status, devLogin.json<{ error: { code: string } }>().error.code]).toEqual([403, 'forbidden']);
    const login = await invokeHttp(srv!.url, token, 'auth.login');
    expect(login.status).toBe(403);
    expect(login.json()).toEqual({ ok: false, error: { code: 'forbidden', message: '서버에 접속한 화면은 이 PC의 브라우저 로그인을 쓰지 않습니다 — 기기 코드로 로그인합니다' } });
    expect((await invokeHttp(srv!.url, token, 'auth.getState')).json()).toMatchObject({
      ok: true,
      value: { loggedIn: true, devLoginAllowed: false, mode: 'server', ownerRegistered: true, owner: { email: 'operator-test@wook.local' } },
    });
    // 세션 없는 호출자는 로그인 전 상태만 받는다
    expect((await invokeHttp(srv!.url, null, 'auth.getState')).json()).toMatchObject({ ok: true, value: { loggedIn: false, owner: null, mode: 'server' } });
  });

  it('--web-dir 없이 띄우면 / 는 웹 화면을 붙이는 길을 알리는 안내 쪽이다', async () => {
    const r = await httpCall({ url: srv!.url, path: '/' });
    expect([r.status, r.text]).toEqual([200, PLACEHOLDER_PAGE]);
  });

  it('관리 채널 shutdown으로 끝나면(코드 0) 잠금·관리 토큰이 없고, 기록과 데이터 파일 어디에도 토큰·인자가 없다 — DB에는 해시만, kv 대표 세션은 쓰지 않았다', async () => {
    await invokeHttp(srv!.url, token, 'questions.answer', ['Q-9999', MARKER]);
    // 그 기기만 로그아웃 — 세션이 끊겨 같은 토큰은 401 (S3-4)
    expect((await invokeHttp(srv!.url, token, 'auth.logout', [MARKER])).json()).toMatchObject({ ok: true, value: { loggedIn: false } });
    expect((await invokeHttp(srv!.url, token, 'auth.getState')).status).toBe(401);
    const down = runClient(entry, ['shutdown', '--data-dir', dataDir]);
    expect([down.code, down.stdout.trim()]).toEqual([0, '서버를 종료했습니다.']);
    const exit = await srv!.exited;
    stopped = true;
    expect(exit.code).toBe(0);
    expect(existsSync(join(dataDir, 'server.lock'))).toBe(false);
    expect(existsSync(join(dataDir, 'admin.token'))).toBe(false);
    const log = readFileSync(join(dataDir, 'logs', 'server.log'), 'utf8');
    expect(log).toContain('HTTP POST /api/invoke system.prereqs → 200');
    // 서버는 서버 모드로 백엔드를 띄운다 (S3-2)
    expect(readFileSync(join(dataDir, 'logs', 'backend.log'), 'utf8')).toContain('로그인 방식 서버(기기 세션 — kv 대표 세션을 쓰지 않음)');
    // 데이터 폴더의 모든 파일(기록·DB 포함)을 바이트로 훑는다
    const files: string[] = [];
    const walk = (d: string): void => {
      for (const name of readdirSync(d)) {
        const p = join(d, name);
        if (statSync(p).isDirectory()) walk(p);
        else files.push(p);
      }
    };
    walk(dataDir);
    expect(files.some((f) => f.endsWith('wook.db'))).toBe(true);
    const leaks = files.filter((f) => {
      const bytes = readFileSync(f);
      return bytes.includes(token) || bytes.includes(MARKER) || /wos_[A-Za-z0-9_-]{43}/.test(bytes.toString('latin1'));
    });
    expect(leaks).toEqual([]);
    // DB: 세션은 토큰 해시로만 있고 그 기기 로그아웃으로 끊겼다. 서버 모드는 kv auth.session을 쓰지 않았다 (S3-2)
    const store = openStore(join(dataDir, 'wook.db'));
    try {
      const row = store.ownerSessions.byTokenHash(hashSessionToken(token));
      expect(row).toMatchObject({ deviceName: '운영자 시험 세션', ownerSub: 'operator-test', revokedBy: OWNER });
      expect(row!.revokedAt).not.toBeNull();
      expect(Number((store.db.prepare(`SELECT COUNT(*) AS c FROM kv WHERE key = 'auth.session'`).get() as { c: number }).c)).toBe(0);
      const auth = store.activity.search({ kinds: ['auth'], limit: 20 }).map((e) => ({ actor: e.actor, text: e.text }));
      expect(auth).toContainEqual({ actor: OPERATOR, text: '운영자 시험 세션 발급 — 등록된 대표가 없어 시험용 대표(operator-test@wook.local)를 만들었습니다 (--allow-test-session)' });
    } finally {
      store.close();
    }
  }, 90_000);
});
