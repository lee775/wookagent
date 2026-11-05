/**
 * 서버의 대표 로그인 (SERVER_DESIGN 3.5, 리드 결정 S3-5·S3-6): 서버 모드 하네스 + 프로세스 안 서버 + 가짜 구글 서버(fakeGoogle.ts)로 브라우저처럼 부른다
 * (쿠키를 모으고 상태 변경에 X-Wook-Client·Origin을 싣는다).
 * - S3-6: 대표 이메일이 정해지기 전에는 setupRequired이고 기기 코드 로그인을 시작하지 않는다. 설정 코드는 10분에 5번 틀리면 버리고, 맞으면 대표 이메일만
 *   정하고 코드 파일을 지운다
 * - S3-5: 시작 응답에 로그인 전 쿠키(__Host-wos_login), 간격 전에는 구글에 묻지 않음, 다른 호출자는 그 로그인을 찾지 못함, 허락하면 시작한 브라우저의 묻기
 *   응답에만 세션 쿠키(본문에는 없음), 처음 맞는 로그인이 sub 등록, 대표 이메일이 아닌 계정·다른 sub 거부(도메인만 기록), access_denied·expired_token·
 *   slow_down·잘못된 id_token, 동시에 6개(S3-22)·1분에 5번, 새 기기 알림(key device-login:<세션 ID> — 그 기기 자신에게는 밀어주지 않음), 대표 이메일을
 *   바꾸면 sub를 지우고 세션을 모두 끊음
 * 브라우저 로그인은 공개 주소에서만 받으므로(S3-31) 서버에 공개 주소를 정하고, 브라우저 흉내는 tailscale serve처럼 그 Host·Origin을 루프백 소켓에 보낸다
 * 세션 값·device_code·id_token·보안 비밀·설정 코드는 시험 출력에 내지 않는다 — 참거짓·수로만 본다
 */
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OPERATOR, OWNER } from '@shared/domain';
import type { AuthState, DeviceLoginPoll, DeviceLoginStart, DeviceSessionView, NotificationView } from '@shared/views';
import { createHarness, type Harness } from '../e2e/harness';
import { deviceSessionView } from '../../src/main/auth/deviceSessions';
import { SETUP_CODE_FILE, SETUP_NOT_DONE } from '../../src/main/orchestrator/serverLogin';
import type { BackendOperator, RemoteCaller } from '../../src/main/backend/types';
import { startServer, type RunningServer } from '../../src/server/server';
import { LOGIN_COOKIE, SESSION_COOKIE } from '../../src/server/sessions';
import { FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, OWNER_SUB, startFakeGoogle, type FakeGoogle } from './fakeGoogle';
import { httpCall, memoryLogger, openSse, remoteBackendOf, sleep, type HttpResult, type SseClient } from './helpers';

/** 서버의 공개 주소 (S3-31) — 브라우저 흉내는 이 Host로 루프백 소켓에 보낸다(tailscale serve가 하는 것처럼) */
const PUBLIC = 'https://grok-pc.tailnet-test.ts.net';
const PUBLIC_HOST = 'grok-pc.tailnet-test.ts.net';

let g: FakeGoogle;
let h: Harness;
let server: RunningServer;
let op: BackendOperator;
const log = memoryLogger();
/** 받은 응답 글 전부 — 마지막 시험이 비밀 값이 없는지 본다 */
const replies: string[] = [];
const streams: SseClient[] = [];

beforeAll(async () => {
  g = await startFakeGoogle();
  h = await createHarness({ mode: 'server', noProject: true, googleDevice: { endpoints: g.endpoints } });
  const backend = remoteBackendOf(h);
  op = backend.operator;
  server = await startServer({ backend, dataDir: h.dataDir, port: 0, allowTestSession: false, logger: log, version: 'test', publicOrigin: PUBLIC, sse: { heartbeatMs: 100 } });
}, 120_000);

afterAll(async () => {
  for (const s of streams) s.close();
  await server?.close();
  await h?.close();
  await g?.close();
});

const rows = () => h.core.ctx.store.activity.search({ limit: 1000 });
const setCookies = (r: HttpResult): string[] => {
  const v = r.headers['set-cookie'];
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
};
const body = <T>(r: HttpResult) => r.json<{ ok: boolean; value: T; error?: { code: string; message: string } }>();
let seq = 0;

/** 브라우저 흉내: 공개 주소의 Host로 쿠키를 모으고, 상태 변경에 욱채 화면의 머리(X-Wook-Client·공개 주소 Origin)를 싣는다. tailscale: tailscale serve가 붙이는 사용자 */
function browser(tailscale?: string) {
  const jar = new Map<string, string>();
  const call = async (method: string, args: unknown[] = []): Promise<HttpResult> => {
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const r = await httpCall({
      url: server.url,
      path: '/api/invoke',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Host: PUBLIC_HOST,
        'X-Wook-Client': '1',
        Origin: PUBLIC,
        ...(cookie ? { Cookie: cookie } : {}),
        ...(tailscale ? { 'Tailscale-User-Login': tailscale } : {}),
      },
      body: JSON.stringify({ id: `b-${++seq}`, method, args }),
    });
    replies.push(r.text, ...setCookies(r));
    for (const c of setCookies(r)) {
      const pair = c.split(';')[0]!;
      const name = pair.slice(0, pair.indexOf('='));
      if (/Max-Age=0(?:;|$)/.test(c)) jar.delete(name);
      else jar.set(name, pair.slice(pair.indexOf('=') + 1));
    }
    return r;
  };
  return {
    jar,
    call,
    start: async (name: string) => {
      const r = await call('auth.deviceLogin', [name]);
      expect(r.status, `시작 ${name}: ${r.status} ${body(r).error?.code ?? ''}`).toBe(200);
      return { r, start: body<DeviceLoginStart>(r).value, code: g.lastDeviceCode() };
    },
    poll: (loginId: string) => call('auth.deviceLoginPoll', [loginId]),
  };
}
type Browser = ReturnType<typeof browser>;

/** 허락 받은 뒤 간격(가짜 구글 1초)이 지나 묻는다 */
async function approveAndPoll(b: Browser, loginId: string, code: string, answer: Parameters<FakeGoogle['answer']>[1] = { kind: 'ok' }): Promise<HttpResult> {
  g.answer(code, answer);
  await sleep(1100);
  return b.poll(loginId);
}

describe('대표 이메일이 정해지기 전 (S3-6)', () => {
  it('auth.getState는 setupRequired이고, 기기 코드 로그인은 시작하지 않는다 — 구글에 묻지도 않고 로그인 전 쿠키도 주지 않는다', async () => {
    const b = browser('t-setup@tailnet');
    const state = body<AuthState>(await b.call('auth.getState')).value;
    expect(state).toMatchObject({ loggedIn: false, mode: 'server', setupRequired: true, googleConfigured: false, googleSecretSet: false });
    const r = await b.call('auth.deviceLogin', ['휴대폰']);
    expect([r.status, body(r).error]).toEqual([409, { code: 'not_configured', message: SETUP_NOT_DONE }]);
    expect(g.codeRequests).toHaveLength(0);
    expect(b.jar.has(LOGIN_COOKIE)).toBe(false);
  });

  it('설정 코드는 10분 안에 5번 틀리면 버린다 — 그 뒤에는 맞는 코드도 받지 않고, 틀린 이메일 모양은 횟수에 넣지 않는다', async () => {
    const b = browser('t-setup@tailnet');
    const grant = op.issueSetupCode()!;
    expect(grant.code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
    // 원문은 콘솔과 코드 파일에만 — 백엔드 가리개에도 넣어 활동 기록·기록으로 새지 않게
    expect(h.core.ctx.redact.text(`코드 ${grant.code}`).includes(grant.code)).toBe(false);
    const wrong = grant.code[0] === 'A' ? `B${grant.code.slice(1)}` : `A${grant.code.slice(1)}`;
    const badEmail = await b.call('auth.setupOwner', [wrong, '이메일 아님']);
    expect([badEmail.status, body(badEmail).error?.code]).toEqual([400, 'invalid']);
    for (let left = 4; left >= 1; left--) {
      const r = await b.call('auth.setupOwner', [wrong, 'owner@example.com']);
      expect([r.status, body(r).error?.code]).toEqual([400, 'invalid']);
      expect(body(r).error?.message).toBe(`설정 코드가 맞지 않습니다 — 서버 PC의 콘솔이나 setup-code.txt에 나온 코드를 넣으세요 (이 코드로 ${left}번 더 해 볼 수 있습니다)`);
    }
    const fifth = await b.call('auth.setupOwner', [wrong, 'owner@example.com']);
    expect([fifth.status, body(fifth).error?.code]).toEqual([429, 'rate_limited']);
    const late = await b.call('auth.setupOwner', [grant.code, 'owner@example.com']);
    expect([late.status, body(late).error?.code]).toEqual([429, 'rate_limited']);
    expect(op.serverConfigState().ownerEmail).toBeNull();
    expect(rows().filter((e) => e.text === '대표 이메일 설정 코드를 10분 안에 5번 틀려 그 코드를 버림')).toHaveLength(1);
  });

  it('맞는 코드(소문자·줄표를 넣어도)는 대표 이메일만 정하고 코드 파일을 지운다 — 다른 설정·비밀 값·대표 계정은 그대로', async () => {
    const b = browser('t-setup@tailnet');
    const grant = op.issueSetupCode()!;
    const file = join(h.dataDir, SETUP_CODE_FILE);
    writeFileSync(file, '서버가 쓴 설정 코드 파일 흉내');
    const settingsBefore = JSON.stringify(h.core.ctx.settings());
    const secretBefore = await h.core.ctx.deps.secrets.get('google-device-client-secret');
    const r = await b.call('auth.setupOwner', [`${grant.code.slice(0, 4).toLowerCase()}-${grant.code.slice(4)}`, ' owner@example.com ']);
    expect(r.status).toBe(200);
    expect(body<AuthState>(r).value).toMatchObject({ setupRequired: false, loggedIn: false, mode: 'server' });
    expect(op.serverConfigState()).toMatchObject({ ownerEmail: 'owner@example.com', ownerEmailSource: 'setup', ownerRegistered: false, setupCodeExpiresAt: null, google: { clientId: null, secretSet: false } });
    expect(existsSync(file)).toBe(false);
    expect(JSON.stringify(h.core.ctx.settings())).toBe(settingsBefore);
    expect(await h.core.ctx.deps.secrets.get('google-device-client-secret')).toBe(secretBefore);
    expect(h.core.auth.owner()).toBeNull();
    expect(rows().map((e) => ({ actor: e.actor, text: e.text }))).toContainEqual({ actor: OWNER, text: '대표 이메일 정함: owner@example.com (설정 코드)' });
    // 대표 이메일이 정해진 뒤에는 설정 코드 길이 닫힌다 — 바꾸는 일은 운영자
    const again = await b.call('auth.setupOwner', [grant.code, 'other@example.com']);
    expect([again.status, body(again).error?.code]).toEqual([409, 'conflict']);
    expect(op.issueSetupCode()).toBeNull();
    expect(op.serverConfigState().ownerEmail).toBe('owner@example.com');
  });
});

describe('서버의 구글 로그인 설정이 없으면 (S3-8)', () => {
  it('클라이언트 ID가 없으면, 그다음 보안 비밀이 없으면 시작하지 않고 운영자 명령을 말한다', async () => {
    const b = browser('t-config@tailnet');
    const noId = await b.call('auth.deviceLogin', ['휴대폰']);
    expect([noId.status, body(noId).error?.code, body(noId).error?.message]).toEqual([
      409,
      'not_configured',
      '서버에 구글 로그인 설정(클라이언트 ID)이 없습니다 — 서버 PC의 운영자가 wook-server config google-client-id로 넣습니다',
    ]);
    expect(op.applyServerConfig({ googleClientId: FAKE_CLIENT_ID }, 'server.json')).toEqual([{ item: 'google.clientId', text: `구글 클라이언트 ID → ${FAKE_CLIENT_ID}` }]);
    const noSecret = await b.call('auth.deviceLogin', ['휴대폰']);
    expect(body(noSecret).error?.message).toBe('서버에 구글 로그인 보안 비밀이 없습니다 — 서버 PC의 운영자가 wook-server secret set google-client-secret으로 넣습니다');
    await op.setGoogleClientSecret(FAKE_CLIENT_SECRET);
    expect(body<AuthState>(await b.call('auth.getState')).value).toMatchObject({ googleConfigured: true, googleSecretSet: true, setupRequired: false });
    expect(g.codeRequests).toHaveLength(0);
  });
});

describe('기기 코드 로그인 (S3-5)', () => {
  const phone = browser('owner@example.com');
  let phoneLogin = { loginId: '', code: '' };

  it('시작: 코드·주소·만료(10분까지)·간격을 주고 이 브라우저에 로그인 전 쿠키를 싣는다 — device_code는 화면에 오지 않는다', async () => {
    const t0 = Date.now();
    const { r, start, code } = await phone.start('휴대폰');
    phoneLogin = { loginId: start.loginId, code };
    expect(Object.keys(start).sort()).toEqual(['expiresAt', 'intervalSec', 'loginId', 'userCode', 'verificationUrl']);
    expect(start.verificationUrl).toBe('https://www.google.com/device');
    expect(start.intervalSec).toBe(1);
    const life = Date.parse(start.expiresAt) - t0;
    expect(life > 590_000 && life <= 601_000, `life=${life}`).toBe(true);
    const login = setCookies(r).find((c) => c.startsWith(`${LOGIN_COOKIE}=`));
    expect(login?.replace(new RegExp(`^${LOGIN_COOKIE}=[A-Za-z0-9_-]{43};`), `${LOGIN_COOKIE}=…;`)).toBe(`${LOGIN_COOKIE}=…; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=600`);
    expect(r.text.includes(code)).toBe(false);
    expect(g.codeRequests.at(-1)?.get('client_id')).toBe(FAKE_CLIENT_ID);
  });

  it('간격 전에는 구글에 묻지 않고 기다림, 간격 뒤에는 묻는다 (authorization_pending → 기다림) — 기다림 답은 다음에 물을 간격을 싣는다', async () => {
    const early = await phone.poll(phoneLogin.loginId);
    expect([early.status, body<DeviceLoginPoll>(early).value]).toEqual([200, { status: 'pending', intervalSec: 1 }]);
    expect(g.tokenCalls(phoneLogin.code)).toBe(0);
    await sleep(1100);
    expect(body<DeviceLoginPoll>(await phone.poll(phoneLogin.loginId)).value).toEqual({ status: 'pending', intervalSec: 1 });
    expect(g.tokenCalls(phoneLogin.code)).toBe(1);
  });

  it('다른 호출자는 그 로그인을 찾지 못한다 — 쿠키 없이, 지어낸 로그인 전 쿠키로 모두 404이고 구글에 묻지 않는다', async () => {
    g.answer(phoneLogin.code, { kind: 'ok' });
    await sleep(1100);
    const stranger = browser('owner@example.com');
    const forged = browser('owner@example.com');
    forged.jar.set(LOGIN_COOKIE, 'A'.repeat(43));
    for (const b of [stranger, forged]) {
      const r = await b.poll(phoneLogin.loginId);
      expect([r.status, body(r).error?.code]).toEqual([404, 'not_found']);
      expect(b.jar.has(SESSION_COOKIE)).toBe(false);
    }
    expect(g.tokenCalls(phoneLogin.code)).toBe(1);
  });

  it('대표가 허락하면 시작한 브라우저의 묻기 응답에 세션 쿠키가 실린다 — 본문에는 세션 값이 없고, 처음 맞는 로그인이 구글 계정(sub)을 등록한다', async () => {
    // 응답의 쿠키를 받지 못한 브라우저 흉내 — 로그인 전 쿠키만 가진 채로 남긴다
    const lost = browser('owner@example.com');
    lost.jar.set(LOGIN_COOKIE, phone.jar.get(LOGIN_COOKIE)!);
    // 등록된 구글 대표가 없을 때 운영자 시험 세션이 만든 시험용 대표는 등록된 대표가 아니다 — 처음 맞는 로그인이 그 자리를 갖고 시험용 세션은 죽는다
    const testGrant = op.openTestSession();
    expect(testGrant.ownerCreated).toBe(true);
    const r = await phone.poll(phoneLogin.loginId);
    expect(r.status).toBe(200);
    expect(body<DeviceLoginPoll>(r).value).toMatchObject({ status: 'ok', auth: { loggedIn: true, owner: { email: 'owner@example.com', name: '김대표' }, mode: 'server', setupRequired: false } });
    const cookie = setCookies(r).find((c) => c.startsWith(`${SESSION_COOKIE}=`));
    expect(cookie?.replace(new RegExp(`^${SESSION_COOKIE}=wos_[A-Za-z0-9_-]{43};`), `${SESSION_COOKIE}=…;`)).toMatch(new RegExp(`^${SESSION_COOKIE}=…; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=(7775\\d{3}|7776000)$`));
    expect(/wos_[A-Za-z0-9_-]{20,}/.test(r.text)).toBe(false);
    expect(body<AuthState>(await phone.call('auth.getState')).value).toMatchObject({ loggedIn: true });
    const devices = body<DeviceSessionView[]>(await phone.call('auth.listDevices')).value;
    expect(devices.map((d) => [d.deviceName, d.tailscaleLogin, d.current])).toEqual([['휴대폰', 'owner@example.com', true]]);
    expect(h.core.auth.owner()).toMatchObject({ sub: OWNER_SUB, email: 'owner@example.com' });
    expect(h.core.deviceSessions.live(testGrant.sessionId)).toBeNull();
    expect(rows().map((e) => ({ actor: e.actor, text: e.text }))).toContainEqual({ actor: OWNER, text: '대표 등록 및 로그인 (owner@example.com) — 기기 코드 로그인, 기기 휴대폰' });
    expect(Number((h.core.ctx.store.db.prepare(`SELECT COUNT(*) AS c FROM kv WHERE key = 'auth.session'`).get() as { c: number }).c)).toBe(0);
    // 세션을 받은 브라우저는 이제 그 세션의 호출자다 — 끝난 로그인을 다시 찾지 않는다. 쿠키를 받지 못한 쪽은 같은 답을 받지만 세션을 또 받지 않는다
    expect((await phone.poll(phoneLogin.loginId)).status).toBe(404);
    const replay = await lost.poll(phoneLogin.loginId);
    expect(body<DeviceLoginPoll>(replay).value).toMatchObject({ status: 'ok', auth: { loggedIn: false } });
    expect(setCookies(replay).some((c) => c.startsWith(`${SESSION_COOKIE}=`))).toBe(false);
    expect(h.core.deviceSessions.list()).toHaveLength(1);
    expect((await browser('owner@example.com').poll(phoneLogin.loginId)).status).toBe(404);
  });

  it('새 기기가 로그인하면 다른 기기에 알림이 간다 — 기기 이름·Tailscale 사용자·시각, key device-login:<세션 ID>. 그 기기 자신에게는 밀어주지 않는다', async () => {
    const phoneStream = await openSse(server.url, '', '', { Cookie: `${SESSION_COOKIE}=${phone.jar.get(SESSION_COOKIE)}` });
    streams.push(phoneStream);
    await phoneStream.waitFor((ev) => ev.some((e) => e.event === 'snapshot'), '첫 스냅숏', 10_000);
    const tablet = browser('owner@example.com');
    const { start, code } = await tablet.start('태블릿');
    expect(body<DeviceLoginPoll>(await approveAndPoll(tablet, start.loginId, code)).value.status).toBe('ok');
    const tabletSession = h.core.deviceSessions.list().find((s) => s.deviceName === '태블릿')!;
    const key = `device-login:${tabletSession.id}`;
    await phoneStream.waitFor((ev) => ev.some((e) => e.event === 'notification'), '새 기기 알림', 10_000);
    const notice = phoneStream.events.find((e) => e.event === 'notification')!.data.payload as NotificationView;
    expect({ key: notice.key, title: notice.title, level: notice.level, link: notice.link }).toEqual({ key, title: '새 기기 로그인', level: 'normal', link: { tab: 'settings', section: 'account' } });
    const lines = notice.body.split('\n');
    expect(lines[0]).toBe('태블릿 기기가 로그인했습니다.');
    expect(lines[1]).toBe('Tailscale 사용자: owner@example.com');
    expect(lines[2]).toMatch(/^로그인 시각: \S/);
    expect(lines[3]).toBe('대표님이 한 로그인이 아니면 내 계정의 기기 목록에서 이 기기를 바로 끊으세요.');
    // 그 알림은 막 로그인한 기기의 연결에는 가지 않고, 다른 기기의 연결에는 간다 (연결마다 거르기)
    const caller = (s: typeof tabletSession): RemoteCaller => ({ surface: 'remote', session: deviceSessionView(s, s.id), clientKey: `session:${s.id}` });
    const phoneSession = h.core.deviceSessions.list().find((s) => s.deviceName === '휴대폰')!;
    expect(h.orch.backend.topicFor('notification', notice, caller(tabletSession))).toBeUndefined();
    expect(h.orch.backend.topicFor('notification', notice, caller(phoneSession))).toEqual(notice);
    expect(rows().map((e) => ({ actor: e.actor, text: e.text }))).toContainEqual({ actor: OWNER, text: '대표 로그인 — 기기 코드 로그인, 새 기기 태블릿' });
  });

  it('대표 이메일이 아닌 계정은 거부하고 기록한다 — 이메일 도메인만 남기고, 세션을 주지 않으며, 끝난 뒤에는 구글에 다시 묻지 않는다', async () => {
    const b = browser('t-intruder@tailnet');
    const { start, code } = await b.start('모르는 기기');
    const sessions = h.core.deviceSessions.list().length;
    const r = await approveAndPoll(b, start.loginId, code, { kind: 'ok', claims: { email: 'intruder@other.example', sub: '555' } });
    expect(body<DeviceLoginPoll>(r).value).toEqual({ status: 'denied', message: '대표 계정이 아닌 구글 계정이라 로그인하지 않았습니다 — 대표 구글 계정으로 다시 시작하세요' });
    expect(b.jar.has(SESSION_COOKIE)).toBe(false);
    expect(h.core.deviceSessions.list()).toHaveLength(sessions);
    expect(rows().map((e) => e.text)).toContain('기기 코드 로그인 거부: 대표 이메일이 아닌 구글 계정 (@other.example)');
    expect(rows().some((e) => e.text.includes('intruder'))).toBe(false);
    const calls = g.tokenCalls(code);
    await sleep(1100);
    expect(body<DeviceLoginPoll>(await b.poll(start.loginId)).value.status).toBe('denied');
    expect(g.tokenCalls(code)).toBe(calls);
  });

  it('대표 이메일은 같아도 등록된 구글 계정(sub)이 아니면 거부한다 — 대소문자만 다른 대표 이메일은 받는다', async () => {
    const b = browser('t-sub@tailnet');
    const other = await b.start('같은 이메일 다른 계정');
    const r = await approveAndPoll(b, other.start.loginId, other.code, { kind: 'ok', claims: { sub: 'another-google-account' } });
    // 같은 이메일의 다른 계정 — config owner-email을 다시 실행해도 풀리지 않으므로 되는 길을 말한다 (S3-29)
    expect(body<DeviceLoginPoll>(r).value).toEqual({
      status: 'denied',
      message:
        '대표 이메일은 맞지만 처음 등록한 구글 계정이 아닙니다 — 처음 등록한 구글 계정으로 로그인하세요. 그 계정을 더 쓰지 않으면 서버 PC의 운영자가 대표 이메일을 다른 이메일로 바꿨다가 되돌려 등록을 풀어야 합니다',
    });
    expect(rows().map((e) => e.text)).toContain('기기 코드 로그인 거부: 대표 이메일은 같지만 처음 등록한 구글 계정이 아님 (@example.com)');
    expect(h.core.auth.owner()?.sub).toBe(OWNER_SUB);
    const c = browser('t-case@tailnet');
    const mixed = await c.start('노트북');
    expect(body<DeviceLoginPoll>(await approveAndPoll(c, mixed.start.loginId, mixed.code, { kind: 'ok', claims: { email: 'Owner@Example.COM' } })).value.status).toBe('ok');
  });

  it('access_denied는 거부, expired_token은 만료로 끝난다', async () => {
    const b = browser('t-deny@tailnet');
    const denied = await b.start('거부');
    expect(body<DeviceLoginPoll>(await approveAndPoll(b, denied.start.loginId, denied.code, { kind: 'denied' })).value).toEqual({
      status: 'denied',
      message: '구글 로그인을 허락하지 않았습니다 — 다시 시작할 수 있습니다',
    });
    const expired = await b.start('만료');
    expect(body<DeviceLoginPoll>(await approveAndPoll(b, expired.start.loginId, expired.code, { kind: 'expired' })).value).toEqual({
      status: 'expired',
      message: '로그인 코드가 끝났습니다 — 다시 시작하세요',
    });
  });

  it('slow_down이면 간격이 5초 늘어 그 사이에는 구글에 묻지 않는다 — 기다림 답이 늘어난 간격을 화면에 알린다', async () => {
    const b = browser('t-slow@tailnet');
    const { start, code } = await b.start('느린 기기');
    expect(body<DeviceLoginPoll>(await approveAndPoll(b, start.loginId, code, { kind: 'slow_down' })).value).toEqual({ status: 'pending', intervalSec: 6 });
    expect(g.tokenCalls(code)).toBe(1);
    await sleep(1100);
    expect(body<DeviceLoginPoll>(await b.poll(start.loginId)).value).toEqual({ status: 'pending', intervalSec: 6 });
    expect(g.tokenCalls(code)).toBe(1);
    // 늘어난 간격(6초)이 지나면 다시 묻는다 — 거부로 끝내 다음 시험의 자리를 비운다
    g.answer(code, { kind: 'denied' });
    await sleep(5000);
    expect(body<DeviceLoginPoll>(await b.poll(start.loginId)).value.status).toBe('denied');
    expect(g.tokenCalls(code)).toBe(2);
  });

  it('구글에 잠시 닿지 못하면(5xx) 기다림 그대로 두고 다음 간격에 다시 묻는다', async () => {
    const b = browser('t-down@tailnet');
    const { start, code } = await b.start('구글 장애');
    expect(body<DeviceLoginPoll>(await approveAndPoll(b, start.loginId, code, { kind: 'down' })).value).toEqual({
      status: 'pending',
      intervalSec: 1,
      message: '구글 서버에 잠시 닿지 못했습니다 — 계속 확인합니다',
    });
    expect(body<DeviceLoginPoll>(await approveAndPoll(b, start.loginId, code, { kind: 'denied' })).value.status).toBe('denied');
    expect(g.tokenCalls(code)).toBe(2);
  });

  it('구글이 준 id_token이 이 클라이언트 것이 아니면 오류로 끝내고 기록한다', async () => {
    const b = browser('t-aud@tailnet');
    const { start, code } = await b.start('잘못된 토큰');
    const r = await approveAndPoll(b, start.loginId, code, { kind: 'ok', claims: { aud: 'someone-else.apps.googleusercontent.com', azp: 'someone-else.apps.googleusercontent.com' } });
    expect(body<DeviceLoginPoll>(r).value).toEqual({ status: 'error', message: '이 프로그램에 발급된 ID 토큰이 아닙니다 (대상 불일치) — 다시 시작하세요' });
    expect(rows().map((e) => e.text)).toContain('기기 코드 로그인 실패: 이 프로그램에 발급된 ID 토큰이 아닙니다 (대상 불일치)');
    expect(b.jar.has(SESSION_COOKIE)).toBe(false);
  });

  it('같은 호출자(Tailscale 사용자)는 1분에 다섯 번까지 시작한다 — 쿠키를 버리거나 지어내도 같다. 같은 브라우저의 새 시작은 앞의 기다림을 대신한다', async () => {
    const b = browser('t-rate@tailnet');
    let last = { loginId: '', code: '' };
    for (let i = 0; i < 5; i++) {
      const s = await b.start(`시작 ${i + 1}`);
      if (last.loginId) expect((await b.poll(last.loginId)).status, '앞의 기다림은 새 시작이 대신했다').toBe(404);
      last = { loginId: s.start.loginId, code: s.code };
    }
    const sixth = await b.call('auth.deviceLogin', ['여섯째']);
    expect([sixth.status, body(sixth).error?.code, body(sixth).error?.message]).toEqual([429, 'rate_limited', '로그인 시작이 너무 잦습니다 (1분에 5번까지) — 잠시 뒤 다시 시작하세요']);
    const fresh = browser('t-rate@tailnet');
    expect((await fresh.call('auth.deviceLogin', ['쿠키 없이'])).status).toBe(429);
    const forged = browser('t-rate@tailnet');
    forged.jar.set(LOGIN_COOKIE, 'Z'.repeat(43));
    expect((await forged.call('auth.deviceLogin', ['지어낸 쿠키'])).status).toBe(429);
    // 남은 기다림을 끝내 다음 시험의 자리를 비운다
    expect(body<DeviceLoginPoll>(await approveAndPoll(b, last.loginId, last.code, { kind: 'denied' })).value.status).toBe('denied');
  });

  it('기다리는 로그인은 모두 합쳐 동시에 6개까지 — 일곱째 브라우저는 429 (S3-22)', async () => {
    const entries: { b: Browser; loginId: string; code: string }[] = [];
    for (const who of ['t-cap1@tailnet', 't-cap2@tailnet', 't-cap3@tailnet', 't-cap5@tailnet', 't-cap6@tailnet', 't-cap7@tailnet']) {
      const b = browser(who);
      const s = await b.start(who);
      entries.push({ b, loginId: s.start.loginId, code: s.code });
    }
    const fourth = await browser('t-cap4@tailnet').call('auth.deviceLogin', ['일곱째']);
    expect([fourth.status, body(fourth).error?.message]).toEqual([429, '진행 중인 기기 코드 로그인이 이미 6개입니다 — 끝나거나 10분이 지나면 다시 시작할 수 있습니다']);
    // 같은 브라우저가 다시 시작하면 자리를 막지 않는다 (앞의 기다림을 대신한다)
    const again = await entries[0]!.b.start('다시');
    entries[0] = { b: entries[0]!.b, loginId: again.start.loginId, code: again.code };
    // 남은 기다림을 끝내 둔다
    for (const e of entries) g.answer(e.code, { kind: 'denied' });
    await sleep(1100);
    for (const e of entries) expect(body<DeviceLoginPoll>(await e.b.poll(e.loginId)).value.status).toBe('denied');
  });

  it('대표 이메일을 바꾸면(운영자) 등록된 구글 계정을 지우고 기기 세션을 모두 끊는다 — 열린 SSE도 닫히고, 옛 대표로는 로그인하지 못한다', async () => {
    const stream = await openSse(server.url, '', '', { Cookie: `${SESSION_COOKIE}=${phone.jar.get(SESSION_COOKIE)}` });
    streams.push(stream);
    await stream.waitFor((ev) => ev.some((e) => e.event === 'snapshot'), '첫 스냅숏', 10_000);
    const liveIds = h.core.deviceSessions.list().map((x) => x.id);
    const live = liveIds.length;
    expect(live).toBeGreaterThanOrEqual(2);
    const changes = op.applyServerConfig({ ownerEmail: { email: 'new-owner@example.com', source: 'config' } }, 'server.json');
    expect(changes).toEqual([{ item: 'owner.email', text: '대표 이메일 → new-owner@example.com' }]);
    expect(h.core.auth.owner()).toBeNull();
    expect(h.core.deviceSessions.list()).toEqual([]);
    // 대표가 바뀌어 저절로 죽는 것에 더해, 세션마다 운영자가 끊은 것으로 남는다 (S3-5 '모든 기기 세션을 끊는다')
    for (const id of liveIds) expect(h.core.ctx.store.ownerSessions.get(id)).toMatchObject({ revokedBy: OPERATOR });
    expect(body<AuthState>(await phone.call('auth.getState')).value).toMatchObject({ loggedIn: false });
    await sleep(300);
    expect(stream.ended()).toBe(true);
    expect(rows().map((e) => ({ actor: e.actor, text: e.text }))).toContainEqual({
      actor: OPERATOR,
      text: `대표 이메일 바꿈: owner@example.com → new-owner@example.com (운영자 설정) — 등록된 대표 계정을 지우고 기기 세션 ${live}개를 끊었습니다`,
    });
    const old = browser('owner@example.com');
    const o = await old.start('옛 대표');
    expect(body<DeviceLoginPoll>(await approveAndPoll(old, o.start.loginId, o.code)).value.status).toBe('denied');
    const fresh = browser('new-owner@example.com');
    const n = await fresh.start('새 대표 휴대폰');
    expect(body<DeviceLoginPoll>(await approveAndPoll(fresh, n.start.loginId, n.code, { kind: 'ok', claims: { email: 'new-owner@example.com', sub: 'new-owner-sub' } })).value.status).toBe('ok');
    expect(h.core.auth.owner()).toMatchObject({ sub: 'new-owner-sub', email: 'new-owner@example.com' });
  });

  it('기록·활동 기록·알림·응답 어디에도 세션 값·device_code·id_token·access token·보안 비밀이 없다', () => {
    const texts = [
      ...log.lines,
      ...rows().flatMap((e) => [e.text, e.result ?? '']),
      ...h.core.ctx.store.notifications.list().flatMap((n) => [n.title, n.body]),
      ...replies.filter((t) => !t.startsWith(`${SESSION_COOKIE}=`) && !t.startsWith(`${LOGIN_COOKIE}=`)),
    ].join('\n');
    const found = {
      sessionToken: /wos_[A-Za-z0-9_-]{20,}/.test(texts),
      deviceCode: texts.includes('fake-device-code-'),
      idToken: /eyJ[A-Za-z0-9_-]{10,}\./.test(texts),
      accessToken: texts.includes('ya29.'),
      secret: texts.includes(FAKE_CLIENT_SECRET),
    };
    expect(found).toEqual({ sessionToken: false, deviceCode: false, idToken: false, accessToken: false, secret: false });
  });
});
