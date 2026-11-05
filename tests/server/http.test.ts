/**
 * 대표용 HTTP (SERVER_DESIGN 3.4·3.6, S2-2·S2-3·S2-8, S2-11 'HTTP 시험'): 하네스 백엔드를 서버 모양으로 감싸 프로세스 안에서 서버를 연다.
 * - 틀린 토큰·Bearer가 아닌 방식·주소(?token=)로 보낸 토큰 401, 토큰이 없으면 세션 없는 호출자(로그인 전 메서드만 — S3-3), Host가 루프백 이름과 포트
 *   그대로가 아니면(닮은 다른 도메인 포함, 어느 HTTP 메서드든, Host 머리가 없어도) 403, 대표 권한 밖 메서드 403 + 활동 기록, 데스크톱 운영자 메서드는
 *   원격 길에서 거부
 * - 서버에는 개발 모드 로그인과 브라우저 로그인이 없다(403). 로그아웃은 그 기기 세션만 끊는다 (S3-2·S3-4 — 세션 쪽 자세한 것은 sessionGate.test)
 * - 본문·형식 오류 400, 너무 큰 본문 413, 없는 메서드 404, 상태 코드 표, 종료 중 503
 * - 정적: 기본은 8단계 안내 쪽(지금의 out/web을 주지 않는다), --web-dir은 경로 탈출·폴더 밖을 가리키는 링크(Windows는 접합) 없이, 보안 머리
 * - 기록에 인자·토큰·머리가 없다
 */
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OPERATOR, OWNER } from '@shared/domain';
import { createHarness, type Harness } from '../e2e/harness';
import { adminRequest } from '../../src/server/admin';
import { httpStatusFor, PLACEHOLDER_PAGE, webPathFor } from '../../src/server/http';
import { startServer, type RunningServer } from '../../src/server/server';
import { httpCall, invokeHttp, memoryLogger, remoteBackendOf, removeDir } from './helpers';

let h: Harness;
let server: RunningServer;
let token = '';
const log = memoryLogger();
const SECRET_ARG = 'WOOK-ARG-MARKER-7f3a9c2e';
/** 운영자 시험 세션을 발급하며 새로 생긴 활동 기록 */
let issueRows: { actor: string; text: string }[] = [];

const activityTexts = () => h.core.ctx.store.activity.search({ limit: 500 }).map((e) => ({ actor: e.actor, text: e.text }));

/** 응답 머리의 상태 코드만 받고 끊는다 — 열리면 끝나지 않는 SSE(받아들이면 안 되는 요청이 200이 될 때)에도 기다리지 않는다 */
function statusOf(o: { path: string; method?: string; headers?: Record<string, string>; body?: string }): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: server.port, path: o.path, method: o.method ?? 'GET', headers: o.headers, agent: false }, (res) => {
      resolve(res.statusCode ?? 0);
      req.destroy();
    });
    req.on('error', reject);
    req.end(o.body);
  });
}

/** Host 머리 없는 날것의 HTTP/1.0 요청 — 상태 줄의 코드 */
function rawNoHost(port: number, requestLine: string, headers: string[] = []): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = connect(port, '127.0.0.1');
    let text = '';
    s.setEncoding('utf8');
    s.on('connect', () => s.write(`${requestLine}\r\n${headers.map((x) => `${x}\r\n`).join('')}\r\n`));
    s.on('data', (c: string) => (text += c));
    s.on('error', reject);
    s.on('close', () => resolve(Number(/^HTTP\/1\.[01] (\d{3})/.exec(text)?.[1] ?? 0)));
  });
}

beforeAll(async () => {
  h = await createHarness({ noProject: true });
  server = await startServer({ backend: remoteBackendOf(h), dataDir: h.dataDir, port: 0, allowTestSession: true, logger: log, version: 'test' });
  const before = h.core.ctx.store.activity.search({ limit: 500 }).map((e) => e.seq);
  const reply = await adminRequest({ dataDir: h.dataDir, command: 'session.test' });
  if (!reply.ok) throw new Error('시험용 세션을 받지 못했습니다');
  token = (reply.result as { token: string }).token;
  issueRows = h.core.ctx.store.activity
    .search({ limit: 500 })
    .filter((e) => !before.includes(e.seq))
    .map((e) => ({ actor: e.actor, text: e.text }));
}, 120_000);

afterAll(async () => {
  await server?.close();
  await h?.close();
});

describe('토큰 (S2-2, S3-3·S3-4)', () => {
  it('토큰이 틀리거나 Bearer가 아니면 401이고 응답은 InvokeResponse다', async () => {
    const fake = `wos_${'A'.repeat(43)}`;
    for (const auth of [fake, `Bearer ${fake}`, 'Basic abc', `Bearer`, `Bearer ${token}x`]) {
      const r = await invokeHttp(server.url, null, 'auth.getState', [], { headers: { Authorization: auth } });
      expect(r.status).toBe(401);
      expect(r.json()).toEqual({ ok: false, error: { code: 'unauthorized', message: '세션 토큰이 맞지 않거나 끝났습니다 — 다시 로그인하세요' } });
    }
    // 토큰이 없으면 세션 없는 호출자다 (S3-3): 로그인 전 메서드(auth.getState)만 되고, 업무 메서드는 401, 없는 API 경로도 401(있는지 말하지 않는다)
    const anonymous = await invokeHttp(server.url, null, 'auth.getState');
    expect(anonymous.status).toBe(200);
    expect(anonymous.json()).toMatchObject({ ok: true, value: { loggedIn: false, owner: null, mode: 'server' } });
    const work = await invokeHttp(server.url, null, 'snapshot.get');
    expect(work.status).toBe(401);
    expect(work.json()).toEqual({ ok: false, error: { code: 'unauthorized', message: '로그인이 필요합니다' } });
    const unknownPath = await httpCall({ url: server.url, path: '/api/nothing' });
    expect(unknownPath.status).toBe(401);
  });

  it('맞는 토큰이면 auth.getState가 200 — 관리 채널이 연 대표의 기기 세션이다', async () => {
    const r = await invokeHttp(server.url, token, 'auth.getState');
    expect(r.status).toBe(200);
    expect(r.json()).toMatchObject({ ok: true, value: { loggedIn: true } });
  });

  it('맞는 토큰이라도 Bearer 방식으로 보내지 않으면 401 — 방식 없이, Basic·Token으로, 띄어 쓰지 않고 (S2-17)', async () => {
    // 실패 글에 토큰이 들어가지 않게 상태 코드와 이름표만 비교한다
    for (const [label, auth] of [
      ['방식 없음', token],
      ['Basic', `Basic ${token}`],
      ['Token', `Token ${token}`],
      ['Bearer 붙여 씀', `Bearer${token}`],
    ] as const) {
      expect((await invokeHttp(server.url, null, 'auth.getState', [], { headers: { Authorization: auth } })).status, label).toBe(401);
      expect((await httpCall({ url: server.url, path: '/api/events', headers: { Authorization: auth } })).status, label).toBe(401);
    }
    // 방식 이름은 대소문자를 가리지 않는다 (RFC 9110 11.1) — 같은 토큰을 bearer로 보내면 받는다
    expect((await invokeHttp(server.url, null, 'auth.getState', [], { headers: { Authorization: `bearer ${token}` } })).status).toBe(200);
  });

  it('토큰은 Authorization: Bearer 머리로만 받는다 — 맞는 토큰을 ?token=·?access_token=으로 보내면 /api/invoke와 /api/events 모두 401 (S2-2, S2-20)', async () => {
    // 주소에 든 토큰은 브라우저 방문 기록·앞단 접근 기록·복사한 링크에 남는다. 실패 글에 토큰이 들어가지 않게 상태 코드와 이름표만 비교한다
    for (const q of ['token', 'access_token']) {
      const query = `?${q}=${encodeURIComponent(token)}`;
      const body = '{"id":"1","method":"auth.getState","args":[]}';
      expect(await statusOf({ path: `/api/invoke${query}`, method: 'POST', headers: { 'Content-Type': 'application/json' }, body }), `invoke ?${q}=`).toBe(401);
      expect(await statusOf({ path: `/api/events${query}` }), `events ?${q}=`).toBe(401);
    }
  });
});

describe('Host 검사 (S2-3)', () => {
  it('Host가 127.0.0.1·localhost·[::1]과 실제 포트가 아니면 어느 경로든 403', async () => {
    const port = server.port;
    for (const host of ['evil.example', `evil.example:${port}`, `127.0.0.1:${port + 1}`, `localhost`, `wook.tailnet.ts.net`, `0.0.0.0:${port}`]) {
      const api = await invokeHttp(server.url, token, 'auth.getState', [], { headers: { Host: host } });
      expect(api.status, host).toBe(403);
      expect(api.json<{ error: { code: string } }>().error.code).toBe('forbidden_host');
      const page = await httpCall({ url: server.url, path: '/', headers: { Host: host } });
      expect(page.status, host).toBe(403);
    }
  });

  it('루프백처럼 보이는 다른 도메인, 사용자 정보를 붙인 형식, 틀린 포트도 403 — 앞뒤 일부만 맞춰 보지 않는다 (S2-17)', async () => {
    // DNS 재바인딩은 공격자 도메인(127.0.0.1.nip.io, localhost.<공격자>)으로 온다 — 그 Host가 이름 앞부분이나 포트만 맞아도 받으면 안 된다
    const port = server.port;
    for (const host of [
      `127.0.0.1.evil.test:${port}`,
      `localhost.evil:${port}`,
      `[::1].evil:${port}`,
      `127.0.0.1:${port}.evil.test`,
      `localhost:${port}0`,
      `evil.test@127.0.0.1:${port}`,
      `127.0.0.1:${port}@evil.test`,
      `localhost:${port + 1}`,
      `[::1]:${port - 1}`,
    ]) {
      const api = await invokeHttp(server.url, token, 'auth.getState', [], { headers: { Host: host } });
      expect(api.status, host).toBe(403);
      expect(api.json<{ error: { code: string } }>().error.code, host).toBe('forbidden_host');
      const page = await httpCall({ url: server.url, path: '/', headers: { Host: host } });
      expect(page.status, host).toBe(403);
    }
  });

  it('Host 검사는 HTTP 메서드와 상관없다 — HEAD·OPTIONS도 /, /api/invoke, /api/events에서 403 (S2-3, S2-20)', async () => {
    // 3단계의 CORS·Origin 사전 요청(OPTIONS) 길이 Host 검사 앞에 끼어들지 않게 — 맞는 토큰을 붙여도 403이다
    const bad = `attacker.example:${server.port}`;
    for (const method of ['HEAD', 'OPTIONS']) {
      for (const path of ['/', '/api/invoke', '/api/events']) {
        expect(await statusOf({ path, method, headers: { Host: bad, Authorization: `Bearer ${token}` } }), `${method} ${path}`).toBe(403);
      }
    }
  });

  it('Host 머리가 없는 요청도 403 — Node는 HTTP/1.0에 Host를 요구하지 않는다 (S2-3, S2-20)', async () => {
    expect(await rawNoHost(server.port, 'GET / HTTP/1.0')).toBe(403);
    expect(await rawNoHost(server.port, 'POST /api/invoke HTTP/1.0', [`Authorization: Bearer ${token}`, 'Content-Type: application/json', 'Content-Length: 0'])).toBe(403);
  });

  it('루프백 이름 셋(대소문자 무관)은 받는다', async () => {
    for (const host of [`127.0.0.1:${server.port}`, `localhost:${server.port}`, `LocalHost:${server.port}`, `[::1]:${server.port}`]) {
      const r = await invokeHttp(server.url, token, 'auth.getState', [], { headers: { Host: host } });
      expect(r.status, host).toBe(200);
    }
  });
});

describe('대표 게이트 — 원격 길 (2.5, S2-2)', () => {
  it('대표 권한 밖 메서드는 403이고 활동 기록에 남으며 아무것도 바꾸지 않는다', async () => {
    const before = h.core.ctx.store.projects.list().length;
    const r = await invokeHttp(server.url, token, 'projects.create', [{ mode: 'new', path: join(tmpdir(), 'x'), name: 'x', checkCommands: [] }]);
    expect(r.status).toBe(403);
    expect(r.json()).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    expect(h.core.ctx.store.projects.list()).toHaveLength(before);
    expect(activityTexts()).toContainEqual({ actor: OWNER, text: '대표 권한 밖 요청 거부: projects.create' });
  });

  it('데스크톱 운영자 메서드(API 키·운영자 설정·모의 실행 끄기)는 원격 길에서 거부한다 — 데스크톱 길에서는 받는 같은 요청', async () => {
    const calls: [string, unknown[]][] = [
      ['settings.setApiKey', ['claude', SECRET_ARG]],
      ['settings.update', [{ account: { authMode: { claude: 'subscription' } } }]],
      ['settings.update', [{ developer: { mainAgentMock: false } }]],
      ['settings.setGoogleSecret', [SECRET_ARG]],
    ];
    for (const [method, args] of calls) {
      const r = await invokeHttp(server.url, token, method, args);
      expect(r.status, method).toBe(403);
      expect(r.json<{ error: { code: string } }>().error.code).toBe('forbidden');
      expect(activityTexts()).toContainEqual({ actor: OWNER, text: `대표 권한 밖 요청 거부: ${method}` });
    }
    // 같은 백엔드의 데스크톱 길은 운영자 설정을 받는다 — 거부는 길(surface) 때문이다
    await expect(h.orch.backend.invoke('settings.update', [{ account: { authMode: { claude: 'subscription' } } }])).resolves.toBeDefined();
  });

  it('원격 길에는 개발 모드 로그인과 이 PC의 브라우저 로그인이 없다 — 403이고 데스크톱 대표 세션(kv)도 기기 세션도 그대로다 (S3-2)', async () => {
    const authRows = () => activityTexts().filter((a) => a.text.includes('로그아웃') || a.text.includes('로그인')).length;
    const before = authRows();
    const kvSession = h.core.ctx.store.kv.get('auth.session');
    const devLogin = await invokeHttp(server.url, token, 'auth.devLogin', [SECRET_ARG]);
    expect(devLogin.status).toBe(403);
    expect(devLogin.json()).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    const login = await invokeHttp(server.url, token, 'auth.login', [SECRET_ARG]);
    expect(login.status).toBe(403);
    expect(login.json()).toEqual({ ok: false, error: { code: 'forbidden', message: '서버에 접속한 화면은 이 PC의 브라우저 로그인을 쓰지 않습니다 — 기기 코드로 로그인합니다' } });
    expect((await invokeHttp(server.url, token, 'auth.getState')).json()).toMatchObject({ value: { loggedIn: true } });
    expect(h.core.ctx.store.kv.get('auth.session')).toEqual(kvSession);
    // 로그인·로그아웃 기록도 남지 않는다
    expect(authRows()).toBe(before);
  });
});

describe('요청 형식과 상태 코드 (S2-8)', () => {
  it('없는 메서드 404, 형식 오류 400, Content-Type이 JSON이 아니면 400, 너무 크면 413', async () => {
    expect((await invokeHttp(server.url, token, 'no.such.method')).status).toBe(404);
    expect((await invokeHttp(server.url, token, 'no.such.method')).json()).toMatchObject({ ok: false, error: { code: 'unknown_method' } });
    const raw = (body: string, type = 'application/json') =>
      httpCall({ url: server.url, path: '/api/invoke', method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': type }, body });
    for (const body of ['not json', '[]', '{"method":"auth.getState","args":[]}', '{"id":"1","args":[]}', '{"id":"","method":"auth.getState","args":[]}', '{"id":{},"method":"auth.getState","args":[]}']) {
      const r = await raw(body);
      expect(r.status, body).toBe(400);
      expect(r.json<{ error: { code: string } }>().error.code).toBe('invalid_body');
    }
    const notArray = await raw('{"id":"1","method":"auth.getState","args":{}}');
    expect(notArray.status).toBe(400);
    expect(notArray.json()).toMatchObject({ ok: false, error: { code: 'invalid_args' } });
    expect((await raw('{"id":"1","method":"auth.getState","args":[]}', 'text/plain')).status).toBe(400);
    expect((await raw('{"id":"1","method":"auth.getState","args":[]}', 'application/json; charset=utf-8')).status).toBe(200);
    const big = await raw(JSON.stringify({ id: '1', method: 'auth.getState', args: ['x'.repeat(1024 * 1024 + 10)] }));
    expect(big.status).toBe(413);
    expect(big.json()).toMatchObject({ ok: false, error: { code: 'too_large' } });
    // 큰 본문 뒤에도 서버는 계속 답한다
    expect((await invokeHttp(server.url, token, 'auth.getState')).status).toBe(200);
  });

  it('다른 HTTP 메서드는 405, 없는 API 경로는 404 (토큰이 맞을 때)', async () => {
    const auth = { Authorization: `Bearer ${token}` };
    expect((await httpCall({ url: server.url, path: '/api/invoke', headers: auth })).status).toBe(405);
    expect((await httpCall({ url: server.url, path: '/api/events', method: 'POST', headers: auth })).status).toBe(405);
    expect((await httpCall({ url: server.url, path: '/api/nothing', headers: auth })).status).toBe(404);
    expect((await httpCall({ url: server.url, path: '/', method: 'POST' })).status).toBe(405);
  });

  it('상태 코드 표: 성공 200 · 인자 400 · 로그인 401 · 권한 403 · 없음 404 · 내부 500 · 그 밖 409', () => {
    const fail = (code: string) => httpStatusFor({ ok: false, error: { code, message: 'x' } });
    expect(httpStatusFor({ ok: true, value: null })).toBe(200);
    for (const c of ['invalid_args', 'invalid_body', 'invalid', 'invalid_url', 'invalid_path']) expect(fail(c), c).toBe(400);
    expect(fail('unauthorized')).toBe(401);
    expect(fail('forbidden')).toBe(403);
    expect(fail('unknown_method')).toBe(404);
    expect(fail('not_found')).toBe(404);
    for (const c of ['internal', 'backend_unavailable', 'db_failed']) expect(fail(c), c).toBe(500);
    for (const c of ['conflict', 'stopped', 'unavailable_remote', 'not_configured']) expect(fail(c), c).toBe(409);
  });

});

describe('정적 화면 (S2-8)', () => {
  it('--web-dir 없이 띄우면 / 는 8단계 안내 쪽, 다른 경로는 404 — 지금의 out/web을 주지 않는다', async () => {
    const page = await httpCall({ url: server.url, path: '/' });
    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(page.text).toBe(PLACEHOLDER_PAGE);
    expect(page.text).toContain('웹 화면은 8단계에서 붙습니다');
    expect(page.text).toContain('API(<code>/api/invoke</code>, <code>/api/events</code>)만 열려 있고');
    for (const p of ['/assets/index.js', '/favicon.ico', '/settings']) expect((await httpCall({ url: server.url, path: p })).status, p).toBe(404);
  });

  it('모든 응답에 보안 머리(nosniff, no-referrer, frame-ancestors none)가 붙는다', async () => {
    for (const r of [await httpCall({ url: server.url, path: '/' }), await invokeHttp(server.url, token, 'auth.getState'), await invokeHttp(server.url, null, 'auth.getState')]) {
      expect(r.headers['x-content-type-options']).toBe('nosniff');
      expect(r.headers['referrer-policy']).toBe('no-referrer');
      expect(r.headers['content-security-policy']).toBe("frame-ancestors 'none'");
      expect(r.headers['x-frame-options']).toBe('DENY');
    }
  });

  it('webPathFor: 폴더 밖을 가리키는 경로를 받지 않는다', () => {
    const root = process.platform === 'win32' ? 'C:\\web' : '/srv/web';
    const inside = (p: string) => webPathFor(root, p);
    expect(inside('/index.html')).toBe(join(root, 'index.html'));
    expect(inside('/assets/a.js')).toBe(join(root, 'assets', 'a.js'));
    expect(inside('/')).toBe(root);
    for (const p of ['/../secret', '/a/../../secret', '/%2e%2e/secret', '/..%2fsecret', '/..%5csecret', '/a\\..\\..\\b', '/C:/Windows/win.ini', '/a%00b', '/%E0%A4%A', 'relative']) {
      expect(inside(p), p).toBeNull();
    }
  });

  it('--web-dir은 그 폴더의 파일을 형식과 함께 주고, 확장자 없는 화면 경로는 index.html, 없는 파일은 404, 경로 탈출은 404', async () => {
    const base = mkdtempSync(join(tmpdir(), 'wook-test-webdir-'));
    const web = join(base, 'web');
    mkdirSync(join(web, 'assets'), { recursive: true });
    writeFileSync(join(web, 'index.html'), '<!doctype html><title>화면</title>');
    writeFileSync(join(web, 'assets', 'app.js'), 'console.log(1)');
    writeFileSync(join(web, 'assets', 'app.css'), 'body{}');
    writeFileSync(join(base, 'secret.txt'), 'SECRET-OUTSIDE');
    mkdirSync(join(base, 'data'));
    let linked = false;
    try {
      symlinkSync(join(base, 'secret.txt'), join(web, 'link.txt'));
      linked = true;
    } catch {
      // Windows에서 심볼릭 링크를 만들 권한이 없으면 링크 탈출 확인은 건너뛴다
    }
    const s = await startServer({ backend: remoteBackendOf(h), dataDir: join(base, 'data'), port: 0, webDir: web, allowTestSession: false, logger: memoryLogger(), version: 'test' });
    try {
      const js = await httpCall({ url: s.url, path: '/assets/app.js' });
      expect([js.status, js.headers['content-type'], js.text]).toEqual([200, 'text/javascript; charset=utf-8', 'console.log(1)']);
      expect((await httpCall({ url: s.url, path: '/assets/app.css' })).headers['content-type']).toBe('text/css; charset=utf-8');
      for (const p of ['/', '/index.html', '/projects/P-0001', '/settings']) {
        const r = await httpCall({ url: s.url, path: p });
        expect([r.status, r.text], p).toEqual([200, '<!doctype html><title>화면</title>']);
      }
      expect((await httpCall({ url: s.url, path: '/assets/missing.js' })).status).toBe(404);
      for (const p of ['/../secret.txt', '/%2e%2e/secret.txt', '/..%2fsecret.txt', '/..%5csecret.txt', '/assets/..%2f..%2fsecret.txt']) {
        const r = await httpCall({ url: s.url, path: p });
        expect(r.text.includes('SECRET-OUTSIDE'), p).toBe(false);
      }
      if (linked) expect((await httpCall({ url: s.url, path: '/link.txt' })).text.includes('SECRET-OUTSIDE')).toBe(false);
      const head = await httpCall({ url: s.url, path: '/assets/app.js', method: 'HEAD' });
      expect([head.status, head.text, head.headers['x-content-type-options']]).toEqual([200, '', 'nosniff']);
    } finally {
      await s.close();
      await removeDir(base);
    }
  });

  it('--web-dir 안의 링크가 폴더 밖을 가리키면 주지 않는다 — Windows는 권한 없이 만드는 디렉터리 접합으로 늘 본다 (S2-17)', async () => {
    const base = mkdtempSync(join(tmpdir(), 'wook-test-webdir-link-'));
    const web = join(base, 'web');
    const outside = join(base, 'outside');
    mkdirSync(web);
    mkdirSync(outside);
    mkdirSync(join(base, 'data'));
    writeFileSync(join(web, 'index.html'), '<!doctype html><title>화면</title>');
    writeFileSync(join(outside, 'secret.txt'), 'SECRET-OUTSIDE');
    writeFileSync(join(outside, 'index.html'), 'OUTSIDE-INDEX');
    // 파일 심볼릭 링크는 Windows에서 권한이 있어야 만들어져 위 시험이 건너뛸 수 있다. 접합(폴더)은 권한 없이 만들고 같은 실제 경로 확인을 거친다
    symlinkSync(outside, join(web, 'linkdir'), process.platform === 'win32' ? 'junction' : 'dir');
    const s = await startServer({ backend: remoteBackendOf(h), dataDir: join(base, 'data'), port: 0, webDir: web, allowTestSession: false, logger: memoryLogger(), version: 'test' });
    try {
      for (const p of ['/linkdir/secret.txt', '/linkdir/index.html']) {
        const r = await httpCall({ url: s.url, path: p });
        expect(r.text.includes('SECRET-OUTSIDE'), p).toBe(false);
        expect(r.status, p).toBe(404);
      }
      // 확장자 없는 화면 경로는 폴더 밖의 index.html이 아니라 이 화면의 index.html
      for (const p of ['/linkdir', '/linkdir/']) {
        const r = await httpCall({ url: s.url, path: p });
        expect([r.status, r.text], p).toEqual([200, '<!doctype html><title>화면</title>']);
      }
    } finally {
      await s.close();
      await removeDir(base);
    }
  });

  it('index.html이 없는 --web-dir은 시작 때 거부한다', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'wook-test-webdir-empty-'));
    try {
      await expect(startServer({ backend: remoteBackendOf(h), dataDir: empty, port: 0, webDir: empty, allowTestSession: false, logger: memoryLogger(), version: 'test' })).rejects.toThrow(
        `--web-dir 폴더에 index.html이 없습니다: ${empty} (npm run build:web으로 만든 폴더를 넘기세요)`,
      );
    } finally {
      await removeDir(empty);
    }
  });
});

describe('종료 중 (S2-5)', () => {
  it('종료를 시작하면 새 API 요청과 SSE 연결은 503', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wook-test-503-'));
    const s = await startServer({ backend: remoteBackendOf(h), dataDir: dir, port: 0, allowTestSession: true, logger: memoryLogger(), version: 'test' });
    try {
      const reply = await adminRequest({ dataDir: dir, command: 'session.test' });
      const t = (reply as { result: { token: string } }).result.token;
      expect((await invokeHttp(s.url, t, 'auth.getState')).status).toBe(200);
      s.beginShutdown();
      const r = await invokeHttp(s.url, t, 'auth.getState');
      expect(r.status).toBe(503);
      expect(r.json()).toEqual({ ok: false, error: { code: 'shutting_down', message: '서버를 끝내는 중입니다' } });
      expect((await httpCall({ url: s.url, path: '/api/events', headers: { Authorization: `Bearer ${t}` } })).status).toBe(503);
    } finally {
      await s.close();
      await removeDir(dir);
    }
  });
});

describe('기록 (S2-8)', () => {
  it('기록에는 메서드·상태·시간만 — 인자, 토큰, Authorization 머리가 없다', async () => {
    await invokeHttp(server.url, token, 'questions.answer', ['Q-9999', { text: SECRET_ARG }]);
    await invokeHttp(server.url, token, 'settings.setApiKey', ['codex', SECRET_ARG]);
    await httpCall({ url: server.url, path: '/api/invoke', method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: `{"id":"1","method":"x","args":["${SECRET_ARG}"]` });
    const text = log.text();
    expect(text).toContain('HTTP POST /api/invoke questions.answer →');
    expect(text.includes(SECRET_ARG)).toBe(false);
    expect(text.includes(token)).toBe(false);
    expect(/wos_[A-Za-z0-9_-]{20,}/.test(text)).toBe(false);
    expect(text.includes('Bearer')).toBe(false);
    // 활동 기록에도 인자·토큰이 없다
    const rows = JSON.stringify(h.core.ctx.store.activity.search({ limit: 500 }));
    expect(rows.includes(SECRET_ARG)).toBe(false);
    expect(rows.includes(token)).toBe(false);
  });

  it('운영자 시험 세션 발급은 행위자 operator의 활동 기록 하나로 남는다 — 대표가 없어 시험용 대표를 만들었다고 말하고, 토큰은 남지 않는다 (S3-4)', () => {
    expect(issueRows).toEqual([{ actor: OPERATOR, text: '운영자 시험 세션 발급 — 등록된 대표가 없어 시험용 대표(operator-test@wook.local)를 만들었습니다 (--allow-test-session)' }]);
    expect(JSON.stringify(issueRows).includes('wos_')).toBe(false);
  });
});
