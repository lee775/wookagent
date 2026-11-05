/**
 * 브라우저 로그인은 공개 주소에서만 (SERVER_DESIGN 3.4–3.6, 리드 결정 S3-31 — 둘째 검토 security-surface의 프로브 zz-s3ss-cookie-port를 옮김). 쿠키는 포트로
 * 나뉘지 않는다(RFC 6265 8.5): 127.0.0.1에서 받은 세션 쿠키는 같은 PC에서 127.0.0.1의 다른 포트로 듣는 아무 프로그램(다른 계정의 프로세스 포함 — S2-14)에도
 * 간다. 프로브는 실제 브라우저로 그것을 보였고, 이 시험은 그 대신 HTTP로 Set-Cookie와 Host 규칙을 본다. 서버 모드 하네스 + 프로세스 안 서버 + 가짜 구글.
 * - 루프백 Host(127.0.0.1·localhost·[::1])로 온 auth.deviceLogin은 시작하지 않는다 — 구글에 묻지 않고, 기다림 자리를 쓰지 않고, __Host-wos_login을 싣지 않는다.
 *   글은 사실대로 되는 길(공개 주소)을 말한다. 공개 주소가 없는 서버는 그 주소를 정하라고 말한다
 * - 공개 주소에서 시작한 로그인도 루프백 Host로 물으면 세션을 주지 않는다 — 구글에 묻지 않고 그 로그인은 그대로 둔다(공개 주소에서 물으면 마친다)
 * - auth.setupOwner는 루프백에서도 된다(쿠키를 싣지 않는다). Bearer는 그대로다 — 토큰을 가진 쪽은 루프백에서도 쓴다
 * - 공개 주소에는 이 PC 안의 이름을 넣지 않는다 — 그 이름의 쿠키도 다른 포트로 간다
 * 세션 값·로그인 전 쿠키·device_code·설정 코드는 시험 출력에 내지 않는다 — 참거짓·수로만 본다
 */
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuthState, DeviceLoginPoll, DeviceLoginStart } from '@shared/views';
import { createHarness, type Harness } from '../e2e/harness';
import type { BackendOperator } from '../../src/main/backend/types';
import { parseCli } from '../../src/server/cli';
import { createHttpSurface } from '../../src/server/http';
import { startServer, type RunningServer } from '../../src/server/server';
import { LOGIN_COOKIE, parsePublicOrigin, SESSION_COOKIE } from '../../src/server/sessions';
import { FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, startFakeGoogle, type FakeGoogle } from './fakeGoogle';
import { httpCall, invokeHttp, memoryLogger, remoteBackendOf, sleep, type HttpResult } from './helpers';

const PUBLIC = 'https://grok-pc.tailnet-test.ts.net';
const PUBLIC_HOST = 'grok-pc.tailnet-test.ts.net';
const WITH_ORIGIN =
  '이 PC 안의 주소로는 브라우저 로그인을 받지 않습니다. 같은 PC의 다른 프로그램이 로그인 쿠키를 받아 갈 수 있기 때문입니다. 공개 주소(https://grok-pc.tailnet-test.ts.net)로 여세요.';
const WITHOUT_ORIGIN = '브라우저 로그인은 공개 주소에서만 받습니다. 서버 PC의 server.json에 network.publicOrigin(tailscale serve 주소)을 정한 뒤 그 주소로 여세요.';

let g: FakeGoogle;
let h: Harness;
let server: RunningServer;
let op: BackendOperator;

beforeAll(async () => {
  g = await startFakeGoogle();
  h = await createHarness({ mode: 'server', noProject: true, googleDevice: { endpoints: g.endpoints } });
  const backend = remoteBackendOf(h);
  op = backend.operator;
  server = await startServer({ backend, dataDir: h.dataDir, port: 0, allowTestSession: false, logger: memoryLogger(), version: 'test', publicOrigin: PUBLIC });
}, 120_000);

afterAll(async () => {
  await server?.close();
  await h?.close();
  await g?.close();
});

const body = <T>(r: HttpResult) => r.json<{ ok: boolean; value: T; error?: { code: string; message: string } }>();
const setCookies = (r: HttpResult): string[] => {
  const v = r.headers['set-cookie'];
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
};
const cookieNames = (r: HttpResult): string[] => setCookies(r).map((c) => c.slice(0, c.indexOf('=')));
const loopbackHosts = () => [`127.0.0.1:${server.port}`, `localhost:${server.port}`, `[::1]:${server.port}`];
let seq = 0;

/**
 * 브라우저 흉내 — 쿠키를 모으고 상태 변경에 X-Wook-Client·Origin을 싣는다. host: 보내는 Host(공개 주소면 tailscale serve처럼 루프백 소켓에), Origin은 그 Host의
 * 화면 주소(공개 주소 또는 루프백 주소)
 */
function browser(o: { host: string; tailscale?: string }) {
  const jar = new Map<string, string>();
  const origin = o.host === PUBLIC_HOST ? PUBLIC : `http://${o.host}`;
  const call = async (method: string, args: unknown[] = []): Promise<HttpResult> => {
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const r = await httpCall({
      url: server.url,
      path: '/api/invoke',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Host: o.host,
        'X-Wook-Client': '1',
        Origin: origin,
        ...(o.tailscale ? { 'Tailscale-User-Login': o.tailscale } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: JSON.stringify({ id: `p-${++seq}`, method, args }),
    });
    for (const c of setCookies(r)) {
      const pair = c.split(';')[0]!;
      const name = pair.slice(0, pair.indexOf('='));
      if (/Max-Age=0(?:;|$)/.test(c)) jar.delete(name);
      else jar.set(name, pair.slice(pair.indexOf('=') + 1));
    }
    return r;
  };
  return { jar, call };
}

describe('브라우저 로그인은 공개 주소에서만 (S3-31)', () => {
  it('auth.setupOwner는 루프백 Host에서도 된다 — 쿠키를 싣지 않는다', async () => {
    const code = op.issueSetupCode()!.code;
    const local = browser({ host: `127.0.0.1:${server.port}` });
    const r = await local.call('auth.setupOwner', [code, 'owner@example.com']);
    expect([r.status, body<AuthState>(r).value.setupRequired, setCookies(r)]).toEqual([200, false, []]);
    op.applyServerConfig({ googleClientId: FAKE_CLIENT_ID }, 'server.json');
    await op.setGoogleClientSecret(FAKE_CLIENT_SECRET);
  });

  it('루프백 Host로 온 auth.deviceLogin은 시작하지 않는다 — 구글에 묻지 않고, __Host-wos_login을 싣지 않고, 공개 주소를 말한다', async () => {
    const asked = g.codeRequests.length;
    for (const host of loopbackHosts()) {
      for (const tailscale of [undefined, 'owner@example.com']) {
        const b = browser({ host, ...(tailscale ? { tailscale } : {}) });
        const r = await b.call('auth.deviceLogin', ['이 PC의 브라우저']);
        expect([r.status, body(r).error, cookieNames(r)], `${host} ${tailscale ?? ''}`).toEqual([403, { code: 'forbidden', message: WITH_ORIGIN }, []]);
      }
    }
    expect(g.codeRequests.length).toBe(asked);
    // 거부한 시작은 기다림 자리도 시작 횟수도 쓰지 않았다 — 같은 'local' 묶음(머리 없음)이 공개 주소로 둘을 시작한다
    const first = await browser({ host: PUBLIC_HOST }).call('auth.deviceLogin', ['공개 주소 1']);
    const second = await browser({ host: PUBLIC_HOST }).call('auth.deviceLogin', ['공개 주소 2']);
    expect([first.status, second.status, cookieNames(first), cookieNames(second)]).toEqual([200, 200, [LOGIN_COOKIE], [LOGIN_COOKIE]]);
  });

  it('공개 주소에서 시작한 로그인을 루프백 Host로 물으면(같은 __Host-wos_login을 실어도) 세션을 주지 않는다 — 구글에 묻지 않고, 그 로그인은 공개 주소에서 마친다', async () => {
    const phone = browser({ host: PUBLIC_HOST, tailscale: 'owner@example.com' });
    const start = await phone.call('auth.deviceLogin', ['휴대폰']);
    expect([start.status, phone.jar.has(LOGIN_COOKIE)]).toEqual([200, true]);
    const loginId = body<DeviceLoginStart>(start).value.loginId;
    const deviceCode = g.lastDeviceCode();
    g.answer(deviceCode, { kind: 'ok' });
    await sleep(1100);
    const sessions = h.core.deviceSessions.list().length;
    for (const host of loopbackHosts()) {
      // 그 브라우저의 로그인 전 쿠키를 그대로 들고 루프백 주소로 — 같은 PC의 다른 프로그램이 그 쿠키를 얻었을 때
      const local = browser({ host, tailscale: 'owner@example.com' });
      local.jar.set(LOGIN_COOKIE, phone.jar.get(LOGIN_COOKIE)!);
      const r = await local.call('auth.deviceLoginPoll', [loginId]);
      expect([r.status, body(r).error, cookieNames(r)], host).toEqual([403, { code: 'forbidden', message: WITH_ORIGIN }, []]);
    }
    expect([g.tokenCalls(deviceCode), h.core.deviceSessions.list().length]).toEqual([0, sessions]);
    const done = await phone.call('auth.deviceLoginPoll', [loginId]);
    expect([done.status, body<DeviceLoginPoll>(done).value.status, cookieNames(done)]).toEqual([200, 'ok', [SESSION_COOKIE]]);
    expect(h.core.deviceSessions.list().length).toBe(sessions + 1);
  });

  it('Bearer는 그대로다 — 토큰을 가진 쪽은 루프백 Host에서도 쓰고, 그 응답에 쿠키를 싣지 않는다', async () => {
    const { token } = h.core.deviceSessions.issue({ deviceName: '명령 줄 도구' });
    for (const host of loopbackHosts()) {
      const r = await invokeHttp(server.url, token, 'auth.getState', [], { headers: { Host: host } });
      expect([r.status, body<AuthState>(r).value.loggedIn, setCookies(r)], host).toEqual([200, true, []]);
    }
    // 기기 세션이 있어도 루프백 Host로는 기기 코드 로그인을 시작하지 않는다
    const r = await invokeHttp(server.url, token, 'auth.deviceLogin', ['또 하나'], { headers: { Host: `127.0.0.1:${server.port}` } });
    expect([r.status, body(r).error?.message, cookieNames(r)]).toEqual([403, WITH_ORIGIN, []]);
  });

  it('공개 주소가 없는 서버는 루프백 로그인을 그 주소를 정하라는 글로 거부한다 — 구글에 묻지 않는다', async () => {
    let port = 0;
    const surface = createHttpSurface({ backend: remoteBackendOf(h), sessions: h.core.deviceSessions, logger: memoryLogger(), runId: 'run-no-origin', port: () => port, webDir: null });
    const srv: Server = createServer((req, res) => surface.handle(req, res));
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    port = (srv.address() as { port: number }).port;
    try {
      const asked = g.codeRequests.length;
      const r = await invokeHttp(`http://127.0.0.1:${port}`, null, 'auth.deviceLogin', ['휴대폰'], { headers: { 'X-Wook-Client': '1', Origin: `http://127.0.0.1:${port}` } });
      expect([r.status, body(r).error, cookieNames(r), g.codeRequests.length]).toEqual([403, { code: 'forbidden', message: WITHOUT_ORIGIN }, [], asked]);
    } finally {
      surface.dispose();
      srv.closeAllConnections();
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });

  it('공개 주소에는 이 PC 안의 이름을 넣지 않는다 — 인자·파일 모두 같은 글로 거부한다', () => {
    const refused = '공개 주소에는 이 PC 안의 주소(localhost·127.0.0.1·[::1])를 넣지 않습니다 — tailscale serve가 만든 https://<서버 PC 이름>.<tailnet>.ts.net 주소를 넣으세요';
    for (const value of ['https://localhost', 'https://LOCALHOST:8443', 'https://app.localhost', 'https://127.0.0.1:8443', 'https://127.1.2.3', 'https://[::1]:8443']) {
      expect(parsePublicOrigin(value), value).toEqual({ ok: false, message: refused });
    }
    expect(parseCli(['serve', '--public-origin', 'https://localhost:8443', '--data-dir', 'd'], {})).toEqual({ kind: 'error', message: `--public-origin: ${refused}` });
    // 이름에 localhost가 들어가기만 하는 다른 이름은 받는다
    expect(parsePublicOrigin('https://localhost-pc.tailnet.ts.net')).toEqual({ ok: true, origin: 'https://localhost-pc.tailnet.ts.net' });
  });
});
