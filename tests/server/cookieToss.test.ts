/**
 * 한 tailnet의 형제 기계가 던진 쿠키로 대표를 로그아웃시키지 못한다 (SERVER_DESIGN 3.4·3.5, 리드 결정 S3-38 — 셋째 검토 security-surface의 프로브
 * zz-s3ss2-cookie-toss를 옮김). ts.net은 공공 접미사라 한 tailnet의 기계는 모두 같은 사이트다. 다른 기계의 페이지가 `Domain=<tailnet>.ts.net; Path=/api`로
 * 세션·로그인 쿠키를 던져 넣으면 브라우저는 경로가 긴 그 쿠키를 먼저 보낸다(RFC 6265 5.4). 프로브는 서버가 앞의 값만 읽어 대표를 로그아웃으로 보고
 * 진짜 쿠키를 지우는 것(실제 Chromium에서도 — cookie-toss-browser.txt)과, 던진 로그인 쿠키 때문에 대표의 로그인을 찾지 못하는 것을 보였다.
 * 브라우저 쪽 막기는 이름이다 — `__Host-` 쿠키는 Domain을 붙이면 브라우저가 받지 않는다. 이 시험은 그 이름과 속성, 그리고 서버 쪽 막기를 HTTP로 본다
 * (결정이 허락한 대로 브라우저 대신 Set-Cookie·Cookie 머리로).
 * - 같은 이름이 여럿 오면 값을 모두 본다: 세션은 살아 있는 첫 값, 로그인은 어느 값으로든 찾는다. 살아 있는 값이 하나도 없을 때만 세션 쿠키를 지운다
 * - 예전 이름(wos_session)은 자격으로 읽지 않는다
 * - 내보내는 Set-Cookie는 모두 `__Host-`로 시작하고 Path=/·Secure가 있고 Domain이 없다
 * - 쿠키가 쌓여 머리가 Node의 상한을 넘으면 431과 JSON InvokeResponse — 사이트 쿠키를 지우라고 말한다
 * 서버에 공개 주소를 정하고, 브라우저 흉내는 tailscale serve처럼 그 Host·Origin을 루프백 소켓에 보낸다(S3-31). 세션 값·로그인 쿠키 값은 시험 출력에 내지
 * 않는다 — 참거짓·상태 코드로만 본다
 */
import { connect } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppSnapshot, DeviceLoginPoll } from '@shared/views';
import { createHarness, type Harness } from '../e2e/harness';
import { startServer, type RunningServer } from '../../src/server/server';
import { LOGIN_COOKIE, SESSION_COOKIE } from '../../src/server/sessions';
import { FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, startFakeGoogle, type FakeGoogle } from './fakeGoogle';
import { httpCall, memoryLogger, openSse, remoteBackendOf, sleep, type HttpResult, type SseClient } from './helpers';

const PUBLIC = 'https://grok-pc.tailnet-s3f5.ts.net';
const PUBLIC_HOST = 'grok-pc.tailnet-s3f5.ts.net';
/** 세션 토큰 모양이지만 살아 있는 세션이 아닌 값 — 형제 기계가 던질 만한 것 */
const JUNK = `wos_${'A'.repeat(43)}`;

let g: FakeGoogle;
let h: Harness;
let server: RunningServer;
const streams: SseClient[] = [];
/** 이 파일이 받은 Set-Cookie 전부 — 이름·속성 시험이 본다 */
const issued: string[] = [];

beforeAll(async () => {
  g = await startFakeGoogle();
  h = await createHarness({ mode: 'server', noProject: true, googleDevice: { endpoints: g.endpoints } });
  const backend = remoteBackendOf(h);
  server = await startServer({ backend, dataDir: h.dataDir, port: 0, allowTestSession: false, logger: memoryLogger(), version: 'test', publicOrigin: PUBLIC });
  backend.operator.applyServerConfig({ ownerEmail: { email: 'owner@example.com', source: 'config' }, googleClientId: FAKE_CLIENT_ID }, 'server.json');
  await backend.operator.setGoogleClientSecret(FAKE_CLIENT_SECRET);
}, 120_000);

afterAll(async () => {
  for (const s of streams) s.close();
  await server?.close();
  await h?.close();
  await g?.close();
});

const setCookies = (r: HttpResult): string[] => {
  const v = r.headers['set-cookie'];
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
};
const body = <T>(r: HttpResult) => r.json<{ ok: boolean; value: T; error?: { code: string } }>();
let seq = 0;
/** 브라우저 흉내 — 공개 주소의 Host·Origin과 욱채 화면의 머리. who: tailscale serve가 붙이는 사용자(시험마다 달리 — 시작 횟수·자리 묶음이 겹치지 않게) */
const post = async (method: string, args: unknown[], cookie: string | undefined, who: string): Promise<HttpResult> => {
  const r = await httpCall({
    url: server.url,
    path: '/api/invoke',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Host: PUBLIC_HOST,
      Origin: PUBLIC,
      'X-Wook-Client': '1',
      'Tailscale-User-Login': who,
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify({ id: `t-${++seq}`, method, args }),
  });
  issued.push(...setCookies(r));
  return r;
};
/** Set-Cookie에서 그 이름의 `이름=값` 한 쌍 (지우는 것은 빼고) */
const pairOf = (r: HttpResult, name: string): string | undefined =>
  setCookies(r)
    .find((c) => c.startsWith(`${name}=`) && !c.startsWith(`${name}=;`))
    ?.split(';')[0];
const loggedIn = (r: HttpResult) => (r.json() as { value?: { loggedIn: boolean } }).value?.loggedIn ?? null;
const clearsSession = (r: HttpResult) => setCookies(r).some((c) => c.startsWith(`${SESSION_COOKIE}=;`) && /Max-Age=0/i.test(c));

/** 기기 코드 로그인을 시작한다 — 그 브라우저가 받은 로그인 전 쿠키 한 쌍과 로그인 ID */
async function start(who: string, cookie?: string): Promise<{ login: string; loginId: string; code: string }> {
  const r = await post('auth.deviceLogin', ['휴대폰'], cookie, who);
  expect(r.status, `시작 ${who}`).toBe(200);
  return { login: pairOf(r, LOGIN_COOKIE)!, loginId: body<{ loginId: string }>(r).value.loginId, code: g.lastDeviceCode() };
}

/** 공개 주소에서 실제로 로그인한다 — 브라우저가 이제 가진 세션 쿠키 한 쌍 */
async function login(who: string): Promise<string> {
  const s = await start(who);
  g.answer(s.code, { kind: 'ok' });
  await sleep(1100);
  const done = await post('auth.deviceLoginPoll', [s.loginId], s.login, who);
  expect([done.status, body<DeviceLoginPoll>(done).value.status]).toEqual([200, 'ok']);
  return pairOf(done, SESSION_COOKIE)!;
}

describe('던진 세션 쿠키 (S3-38)', () => {
  it('던진 값이 살아 있는 쿠키보다 앞에 와도 대표로 받고, 지우는 Set-Cookie를 보내지 않는다 — 살아 있는 값이 없을 때만 지운다', async () => {
    const who = 'toss-session@tailnet';
    const session = await login(who);
    const alone = await post('auth.getState', [], session, who);
    // 브라우저가 던져진 뒤 보내는 머리: 경로가 긴(/api) 던진 쿠키가 먼저, 대표의 host-only Path=/ 쿠키가 뒤
    const tossed = await post('auth.getState', [], `${SESSION_COOKIE}=${JUNK}; ${session}`, who);
    const tossedOdd = await post('auth.getState', [], `${SESSION_COOKIE}=tossed-by-sibling-host; ${SESSION_COOKIE}=; ${session}`, who);
    const liveFirst = await post('auth.getState', [], `${session}; ${SESSION_COOKIE}=${JUNK}`, who);
    const junkOnly = await post('auth.getState', [], `${SESSION_COOKIE}=${JUNK}; ${SESSION_COOKIE}=tossed-by-sibling-host`, who);
    expect({
      alone: [loggedIn(alone), clearsSession(alone)],
      tossed: [loggedIn(tossed), clearsSession(tossed)],
      tossedOdd: [loggedIn(tossedOdd), clearsSession(tossedOdd)],
      liveFirst: [loggedIn(liveFirst), clearsSession(liveFirst)],
      junkOnly: [loggedIn(junkOnly), clearsSession(junkOnly)],
    }).toEqual({ alone: [true, false], tossed: [true, false], tossedOdd: [true, false], liveFirst: [true, false], junkOnly: [false, true] });
    // SSE도 같은 규칙 — 던진 쿠키가 앞에 와도 대표의 스냅숏
    const stream = await openSse(server.url, '', '', { Host: PUBLIC_HOST, Cookie: `${SESSION_COOKIE}=${JUNK}; ${session}` });
    streams.push(stream);
    await stream.waitFor((ev) => ev.some((e) => e.event === 'snapshot'), '첫 스냅숏', 10_000);
    expect((stream.events.find((e) => e.event === 'snapshot')!.data.payload as AppSnapshot).auth.loggedIn).toBe(true);
  });

  it('예전 이름(wos_session)은 자격으로 읽지 않는다 — 살아 있는 토큰을 실어도 세션 없는 호출자다', async () => {
    const who = 'toss-old-name@tailnet';
    const session = await login(who);
    const token = session.slice(session.indexOf('=') + 1);
    const old = await post('auth.getState', [], `wos_session=${token}`, who);
    expect([old.status, loggedIn(old), clearsSession(old)]).toEqual([200, false, false]);
  });
});

describe('던진 로그인 전 쿠키 (S3-38)', () => {
  it('던진 값이 앞에 와도 그 브라우저의 묻기는 로그인을 찾아 마친다 — 던진 값만으로는 찾지 못한다', async () => {
    const who = 'toss-login@tailnet';
    const s = await start(who);
    g.answer(s.code, { kind: 'ok' });
    await sleep(1100);
    const onlyTossed = await post('auth.deviceLoginPoll', [s.loginId], `${LOGIN_COOKIE}=tossed-by-sibling-host`, who);
    expect([onlyTossed.status, body(onlyTossed).error?.code]).toEqual([404, 'not_found']);
    const poll = await post('auth.deviceLoginPoll', [s.loginId], `${LOGIN_COOKIE}=tossed-by-sibling-host; ${LOGIN_COOKIE}=; ${s.login}`, who);
    expect([poll.status, body<DeviceLoginPoll>(poll).value.status, pairOf(poll, SESSION_COOKIE) !== undefined]).toEqual([200, 'ok', true]);
  });

  it('다시 시작하면 던진 값이 앞에 있어도 이 브라우저의 앞선 기다림을 대신한다 — 자리를 막지 않는다', async () => {
    const who = 'toss-restart@tailnet';
    const first = await start(who);
    const second = await start(who, `${LOGIN_COOKIE}=tossed-by-sibling-host; ${first.login}`);
    // 앞선 기다림은 새 시작이 대신했다 — 그 브라우저의 쿠키로 물어도 찾지 못한다. 새 로그인은 새 쿠키로 찾는다
    const old = await post('auth.deviceLoginPoll', [first.loginId], first.login, who);
    const fresh = await post('auth.deviceLoginPoll', [second.loginId], second.login, who);
    expect([old.status, body(old).error?.code, fresh.status, body<DeviceLoginPoll>(fresh).value.status]).toEqual([404, 'not_found', 200, 'pending']);
    // 남은 기다림을 끝낸다
    g.answer(second.code, { kind: 'denied' });
    await sleep(1100);
    expect(body<DeviceLoginPoll>(await post('auth.deviceLoginPoll', [second.loginId], second.login, who)).value.status).toBe('denied');
  });
});

describe('내보내는 쿠키와 쌓인 쿠키 (S3-38)', () => {
  it('Set-Cookie는 모두 __Host-로 시작하고 Path=/·Secure·HttpOnly·SameSite=Strict가 있고 Domain이 없다 — 로그아웃의 지우기까지', async () => {
    const who = 'toss-names@tailnet';
    const session = await login(who);
    const out = await post('auth.logout', [], session, who);
    expect([out.status, clearsSession(out)]).toEqual([200, true]);
    const names = new Set(issued.map((c) => c.slice(0, c.indexOf('='))));
    expect([...names].sort()).toEqual([LOGIN_COOKIE, SESSION_COOKIE].sort());
    const bad = issued.filter((c) => {
      const attrs = c.split(';').slice(1).map((a) => a.trim().toLowerCase());
      return !c.startsWith('__Host-') || !attrs.includes('path=/') || !attrs.includes('secure') || !attrs.includes('httponly') || !attrs.includes('samesite=strict') || attrs.some((a) => a.startsWith('domain'));
    });
    expect({ count: issued.length > 4, bad: bad.length }).toEqual({ count: true, bad: 0 });
  });

  it('머리가 Node의 상한을 넘으면 431과 JSON InvokeResponse — 쿠키가 쌓였을 수 있으니 사이트 쿠키를 지우라고 말한다', async () => {
    // 형제 기계가 다른 이름의 쿠키로 쿠키 단지를 채운 꼴 — 머리가 16KB를 넘는다
    const filler = Array.from({ length: 40 }, (_, i) => `junk${i}=${'x'.repeat(500)}`).join('; ');
    const text = await new Promise<string>((resolveIt) => {
      let got = '';
      const c = connect(server.port, '127.0.0.1', () =>
        c.write(`POST /api/invoke HTTP/1.1\r\nHost: ${PUBLIC_HOST}\r\nContent-Type: application/json\r\nCookie: ${filler}\r\nContent-Length: 2\r\n\r\n{}`),
      );
      c.setEncoding('utf8');
      c.on('data', (d: string) => (got += d));
      c.on('error', () => undefined);
      c.on('close', () => resolveIt(got));
    });
    const [head, payload] = text.split('\r\n\r\n');
    expect({
      status: head!.split('\r\n')[0],
      json: head!.includes('Content-Type: application/json; charset=utf-8'),
      body: JSON.parse(payload!) as unknown,
    }).toEqual({
      status: 'HTTP/1.1 431 Request Header Fields Too Large',
      json: true,
      body: {
        ok: false,
        error: {
          code: 'headers_too_large',
          message: '요청 머리글이 너무 커서 읽지 못했습니다. 이 주소에 쿠키가 너무 많이 쌓였을 수 있습니다. 브라우저에서 이 사이트의 쿠키를 지운 뒤 다시 여세요.',
        },
      },
    });
  });
});
