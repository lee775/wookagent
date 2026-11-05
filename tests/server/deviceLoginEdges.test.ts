/**
 * 기기 코드 로그인의 가장자리 (SERVER_DESIGN 3.5, 리드 결정 S3-22·S3-25·S3-28·S3-29 — 검토 프로브 zz-s3sec-pendingcap, zz-s3fl-harness의 P3·P5를
 * 옮김). 서버 모드 하네스 + 프로세스 안 서버 + 가짜 구글 서버.
 * - S3-22: 기다리는 로그인의 자리는 묶음(Tailscale 사용자, 머리가 없으면 'local')마다 2개 — 대표가 아닌 쪽이 모든 자리를 쥐어 대표를 막지 못한다
 * - S3-25: 브라우저가 아닌 쪽은 받은 __Host-wos_login 쿠키와 함께 X-Wook-Client: 1과 허용 Origin을 보내 로그인을 마친다 — CSRF 막기는 그대로
 * - S3-28: 기다리는 동안 설정이 빠지면 묻기 답이 빠진 항목을 말한다(시작 때와 같은 글)
 * - S3-29: 같은 대표 이메일을 다시 정하면, 등록된 대표가 다른 이메일의 계정일 때 그 등록을 지운다 — 거부 글이 그 길을 말한다. 예전 기기 세션은 운영자가
 *   끊은 것으로 남아, 그 계정이 다시 등록되어도 되살아나지 않는다 (S3-36 — 검토 프로브 zz-s3fti-reset-revokes를 옮김)
 * 브라우저 로그인은 공개 주소에서만 받으므로(S3-31) 서버에 공개 주소를 정하고, 클라이언트 흉내는 tailscale serve처럼 그 Host를 루프백 소켓에 보낸다
 * 세션 값·device_code·보안 비밀은 시험 출력에 내지 않는다
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OPERATOR } from '@shared/domain';
import type { AuthState, DeviceLoginPoll, DeviceLoginStart } from '@shared/views';
import { createHarness, type Harness } from '../e2e/harness';
import { DeviceLoginFlows } from '../../src/main/auth/googleDevice';
import { TEST_OWNER } from '../../src/main/orchestrator/auth';
import type { BackendOperator } from '../../src/main/backend/types';
import { startServer, type RunningServer } from '../../src/server/server';
import { LOGIN_COOKIE, SESSION_COOKIE } from '../../src/server/sessions';
import { FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, OWNER_SUB, startFakeGoogle, type FakeGoogle } from './fakeGoogle';
import { httpCall, memoryLogger, remoteBackendOf, sleep, type HttpResult } from './helpers';

/** 서버의 공개 주소 (S3-31) — 클라이언트 흉내는 이 Host로 루프백 소켓에 보낸다(tailscale serve가 하는 것처럼) */
const PUBLIC = 'https://grok-pc.tailnet-test.ts.net';
const PUBLIC_HOST = 'grok-pc.tailnet-test.ts.net';

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
  op.applyServerConfig({ ownerEmail: { email: 'owner@example.com', source: 'config' }, googleClientId: FAKE_CLIENT_ID }, 'server.json');
  await op.setGoogleClientSecret(FAKE_CLIENT_SECRET);
}, 120_000);

afterAll(async () => {
  await server?.close();
  await h?.close();
  await g?.close();
});

const rows = () => h.core.ctx.store.activity.search({ limit: 1000 });
const body = <T>(r: HttpResult) => r.json<{ ok: boolean; value: T; error?: { code: string; message: string } }>();
const code = (r: HttpResult): string => body(r).error?.code ?? 'ok';
const setCookies = (r: HttpResult): string[] => {
  const v = r.headers['set-cookie'];
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
};
let seq = 0;

/** 클라이언트 흉내: 공개 주소의 Host로 쿠키를 모은다. screen이면 욱채 화면의 머리(X-Wook-Client·공개 주소 Origin)를 싣는다. tailscale: tailscale serve가 붙이는 사용자 */
function client(o: { tailscale?: string; screen?: boolean } = {}) {
  const jar = new Map<string, string>();
  const call = async (method: string, args: unknown[] = [], extra: Record<string, string> = {}): Promise<HttpResult> => {
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const r = await httpCall({
      url: server.url,
      path: '/api/invoke',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Host: PUBLIC_HOST,
        ...(o.screen === false ? {} : { 'X-Wook-Client': '1', Origin: PUBLIC }),
        ...(cookie ? { Cookie: cookie } : {}),
        ...(o.tailscale ? { 'Tailscale-User-Login': o.tailscale } : {}),
        ...extra,
      },
      body: JSON.stringify({ id: `e-${++seq}`, method, args }),
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

/** 로그인 하나를 시작하고 허락한 뒤 간격(가짜 구글 1초)이 지나 묻는다 */
async function login(c: ReturnType<typeof client>, name: string, answer: Parameters<FakeGoogle['answer']>[1] = { kind: 'ok' }): Promise<DeviceLoginPoll> {
  const s = await c.call('auth.deviceLogin', [name]);
  expect(s.status, `시작 ${name}: ${code(s)}`).toBe(200);
  g.answer(g.lastDeviceCode(), answer);
  await sleep(1100);
  return body<DeviceLoginPoll>(await c.call('auth.deviceLoginPoll', [body<DeviceLoginStart>(s).value.loginId])).value;
}

/** 남은 기다림을 거부로 끝낸다 — 다음 시험의 자리를 비운다 */
async function deny(entries: { c: ReturnType<typeof client>; loginId: string; deviceCode: string }[]): Promise<void> {
  for (const e of entries) g.answer(e.deviceCode, { kind: 'denied' });
  await sleep(1100);
  for (const e of entries) expect(body<DeviceLoginPoll>(await e.c.call('auth.deviceLoginPoll', [e.loginId])).value.status).toBe('denied');
}

describe('브라우저가 아닌 쪽의 기기 코드 로그인 (S3-25)', () => {
  it('받은 __Host-wos_login 쿠키만 보내면 403 forbidden_origin이고(CSRF 막기 그대로), X-Wook-Client: 1과 허용 Origin을 함께 보내면 로그인을 마친다', async () => {
    const cli = client({ screen: false });
    // 시작은 쿠키도 Origin도 없는 요청이다 — 브라우저가 아닌 쪽의 첫 요청
    const start = await cli.call('auth.deviceLogin', ['명령 줄 도구']);
    expect([start.status, cli.jar.has(LOGIN_COOKIE)]).toEqual([200, true]);
    const loginId = body<DeviceLoginStart>(start).value.loginId;
    g.answer(g.lastDeviceCode(), { kind: 'ok' });
    await sleep(1100);
    const bare = await cli.call('auth.deviceLoginPoll', [loginId]);
    expect([bare.status, code(bare)]).toEqual([403, 'forbidden_origin']);
    // 3.5가 말하는 대로: 쿠키 + X-Wook-Client: 1 + 허용 Origin (공개 주소로 — 루프백 Host로는 로그인을 마치지 않는다, S3-31)
    const done = await cli.call('auth.deviceLoginPoll', [loginId], { 'X-Wook-Client': '1', Origin: PUBLIC });
    expect([done.status, body<DeviceLoginPoll>(done).value.status, cli.jar.has(SESSION_COOKIE)]).toEqual([200, 'ok', true]);
    // 그 세션 쿠키로 로그인한 대표다 (GET이 아닌 요청이라 같은 머리를 싣는다)
    const state = await cli.call('auth.getState', [], { 'X-Wook-Client': '1', Origin: PUBLIC });
    expect(body<AuthState>(state).value).toMatchObject({ loggedIn: true, owner: { email: 'owner@example.com' }, mode: 'server' });
  });
});

describe('기다리는 로그인의 자리 (S3-22, 프로브 zz-s3sec-pendingcap)', () => {
  it('DeviceLoginFlows: 자리 묶음마다 2개, 모두 합쳐 6개 — 묶음이 차면 bucket, 모두 차면 full. 같은 호출자의 새 시작은 제 자리를 비운다', () => {
    let t = 1_000_000;
    const f = new DeviceLoginFlows(() => t);
    const grant = { deviceCode: 'dc', userCode: 'ABCD-EFGH', verificationUrl: 'https://www.google.com/device', expiresInSec: 1800, intervalSec: 5 };
    const start = (key: string, holder: string) => {
      const a = f.admit(key, key, holder);
      if (a.ok) f.add(key, grant, 'x', holder);
      return a.ok ? 'ok' : a.reason;
    };
    expect([start('k1', 'tailscale:m'), start('k2', 'tailscale:m'), start('k3', 'tailscale:m')]).toEqual(['ok', 'ok', 'bucket']);
    // 같은 호출자(k1)가 다시 시작하면 제 앞의 기다림을 대신하므로 묶음이 차 있어도 된다
    expect(start('k1', 'tailscale:m')).toBe('ok');
    expect([start('a1', 'tailscale:a'), start('a2', 'tailscale:a'), start('l1', 'local'), start('l2', 'local')]).toEqual(['ok', 'ok', 'ok', 'ok']);
    expect(start('o1', 'tailscale:owner')).toBe('full');
    t += 11 * 60_000; // 10분이 지나면 기다림은 끝난다
    expect(start('o1', 'tailscale:owner')).toBe('ok');
  });

  it('대표가 아닌 Tailscale 사용자는 자리를 2개까지만 쥔다 — 대표는 그래도 로그인을 시작하고 다시 시작할 수 있다', async () => {
    const held: { c: ReturnType<typeof client>; loginId: string; deviceCode: string }[] = [];
    const statuses: [number, string][] = [];
    for (let i = 0; i < 3; i++) {
      // 쿠키를 버린 새 브라우저마다 — 같은 브라우저의 새 시작이 앞의 것을 대신하는 길로 피하지 않는다
      const c = client({ tailscale: 'mallory@tailnet' });
      const r = await c.call('auth.deviceLogin', ['x']);
      statuses.push([r.status, code(r)]);
      if (r.status === 200) held.push({ c, loginId: body<DeviceLoginStart>(r).value.loginId, deviceCode: g.lastDeviceCode() });
    }
    expect(statuses).toEqual([
      [200, 'ok'],
      [200, 'ok'],
      [429, 'rate_limited'],
    ]);
    const third = await client({ tailscale: 'MALLORY@tailnet' }).call('auth.deviceLogin', ['대소문자만 다름']);
    expect([third.status, body(third).error?.message]).toEqual([429, '이 Tailscale 사용자로 진행 중인 기기 코드 로그인이 이미 2개입니다 — 그 로그인이 끝나거나 10분이 지나면 다시 시작할 수 있습니다']);
    const owner = client({ tailscale: 'owner@example.com' });
    const first = await owner.call('auth.deviceLogin', ['휴대폰']);
    const retry = await owner.call('auth.deviceLogin', ['휴대폰']);
    expect([first.status, retry.status]).toEqual([200, 200]);
    held.push({ c: owner, loginId: body<DeviceLoginStart>(retry).value.loginId, deviceCode: g.lastDeviceCode() });
    await deny(held);
  });

  it('Tailscale 머리가 없는 접속은 모두 local 묶음 하나다 — 2개까지, 그다음은 그 까닭을 말하는 429', async () => {
    const held: { c: ReturnType<typeof client>; loginId: string; deviceCode: string }[] = [];
    for (let i = 0; i < 2; i++) {
      const c = client();
      const r = await c.call('auth.deviceLogin', ['이 PC']);
      expect(r.status).toBe(200);
      held.push({ c, loginId: body<DeviceLoginStart>(r).value.loginId, deviceCode: g.lastDeviceCode() });
    }
    const more = await client().call('auth.deviceLogin', ['셋째']);
    expect([more.status, body(more).error?.message]).toEqual([429, 'Tailscale을 거치지 않은 접속으로 진행 중인 기기 코드 로그인이 이미 2개입니다 — 그 로그인이 끝나거나 10분이 지나면 다시 시작할 수 있습니다']);
    // 같은 브라우저의 새 시작은 제 앞의 기다림을 대신하므로 자리를 막지 않는다
    const again = await held[0]!.c.call('auth.deviceLogin', ['다시']);
    expect(again.status).toBe(200);
    held[0] = { c: held[0]!.c, loginId: body<DeviceLoginStart>(again).value.loginId, deviceCode: g.lastDeviceCode() };
    await deny(held);
  });
});

describe('기다리는 동안 빠진 서버 설정 (S3-28, 프로브 P5)', () => {
  it('보안 비밀을 지우면 묻기 답이 보안 비밀을 말한다 — 대표 이메일이 정해지지 않았다고 하지 않는다', async () => {
    const c = client({ tailscale: 't-secret@tailnet' });
    const s = await c.call('auth.deviceLogin', ['휴대폰']);
    expect(s.status).toBe(200);
    await op.setGoogleClientSecret(null);
    try {
      await sleep(1100);
      const r = body<DeviceLoginPoll>(await c.call('auth.deviceLoginPoll', [body<DeviceLoginStart>(s).value.loginId])).value;
      expect(body<AuthState>(await c.call('auth.getState')).value.setupRequired).toBe(false);
      expect(r).toEqual({ status: 'error', message: '서버에 구글 로그인 보안 비밀이 없습니다 — 서버 PC의 운영자가 wook-server secret set google-client-secret으로 넣습니다' });
    } finally {
      // 다음 시험이 이 설정에 기대지 않게 되돌린다
      await op.setGoogleClientSecret(FAKE_CLIENT_SECRET);
    }
  });

  it('클라이언트 ID가 빠지면 클라이언트 ID를, 보안 비밀을 읽지 못하면 읽지 못했다고 말한다 — 시작과 묻기가 같은 글', async () => {
    const c = client({ tailscale: 't-config@tailnet' });
    const s = await c.call('auth.deviceLogin', ['휴대폰']);
    expect(s.status).toBe(200);
    const google = h.core.ctx.store.kv.get<Record<string, unknown>>('server.google')!;
    h.core.ctx.store.kv.set('server.google', { ...google, clientId: '' });
    try {
      await sleep(1100);
      const noId = body<DeviceLoginPoll>(await c.call('auth.deviceLoginPoll', [body<DeviceLoginStart>(s).value.loginId])).value;
      const startNoId = await c.call('auth.deviceLogin', ['휴대폰']);
      const ID_MISSING = '서버에 구글 로그인 설정(클라이언트 ID)이 없습니다 — 서버 PC의 운영자가 wook-server config google-client-id로 넣습니다';
      expect([noId, [startNoId.status, body(startNoId).error?.message]]).toEqual([{ status: 'error', message: ID_MISSING }, [409, ID_MISSING]]);
    } finally {
      h.core.ctx.store.kv.set('server.google', google);
    }
    // OS 보안 저장소를 읽지 못함 (잠깐의 장애)
    const s2 = await c.call('auth.deviceLogin', ['휴대폰']);
    expect(s2.status).toBe(200);
    const secrets = h.core.ctx.deps.secrets;
    const get = secrets.get.bind(secrets);
    secrets.get = async () => {
      throw new Error('저장소를 열지 못함');
    };
    try {
      await sleep(1100);
      const unreadable = body<DeviceLoginPoll>(await c.call('auth.deviceLoginPoll', [body<DeviceLoginStart>(s2).value.loginId])).value;
      const startUnreadable = await c.call('auth.deviceLogin', ['휴대폰']);
      const UNREADABLE = '서버가 구글 로그인 보안 비밀을 OS 보안 저장소에서 읽지 못했습니다 — 잠시 뒤 다시 시작하세요. 계속되면 서버 PC의 운영자가 서버 기록을 확인합니다';
      expect([unreadable, [startUnreadable.status, body(startUnreadable).error?.message]]).toEqual([{ status: 'error', message: UNREADABLE }, [409, UNREADABLE]]);
    } finally {
      secrets.get = get;
    }
  });
});

describe('같은 대표 이메일을 다시 정하기 (S3-29, 프로브 P3)', () => {
  it('데스크톱 앱이 다른 계정을 대표로 등록해 막히면, 거부 글이 config owner-email을 말하고, 운영자가 같은 이메일을 다시 정하면 그 등록을 지우고 예전 기기 세션을 끊어 대표가 들어온다', async () => {
    // 같은 데이터 폴더의 데스크톱 앱이 처음 구글 로그인한 계정을 등록한다 (AuthService.establish가 kv owner를 쓴다)
    const now = h.core.ctx.now();
    const desktop = { sub: 'desktop-account-sub', email: 'personal@example.com', name: '다른 계정', registeredAt: now, lastLoginAt: now };
    h.core.ctx.store.kv.set('owner', desktop);
    const stale = h.core.deviceSessions.issue({ deviceName: '데스크톱 계정의 기기' });
    const first = await login(client({ tailscale: 't-p3@tailnet' }), '휴대폰');
    expect(first).toEqual({
      status: 'denied',
      message:
        '대표 이메일은 맞지만 이 서버에는 다른 이메일의 구글 계정이 대표로 등록되어 있습니다 — 서버 PC의 운영자가 wook-server config owner-email로 대표 이메일을 다시 정하면 그 등록이 풀리고, 그다음 로그인한 대표 계정이 등록됩니다',
    });
    // 운영자가 같은 이메일을 다시 정한다 (config owner-email·config reload·서버 시작이 모두 이 길이다)
    const changes = op.applyServerConfig({ ownerEmail: { email: 'owner@example.com', source: 'config' } }, 'server.json');
    expect(changes).toEqual([{ item: 'owner.email', text: '대표 이메일 owner@example.com 다시 정함 — 대표 이메일과 다른 등록된 계정을 지웠습니다' }]);
    expect([h.core.auth.owner(), h.core.deviceSessions.live(stale.session.id)]).toEqual([null, null]);
    expect(rows().filter((e) => e.actor === OPERATOR).map((e) => e.text)).toContain(
      '대표 이메일 다시 정함: owner@example.com (운영자 설정) — 등록된 대표 계정(@example.com)이 대표 이메일과 달라 지우고 기기 세션 1개를 끊었습니다',
    );
    expect(rows().some((e) => e.text.includes('personal@'))).toBe(false);
    // 끊은 것이다 — 등록이 지워져 잠깐 살아 있지 않게 보이는 것만이 아니다 (S3-36, 프로브 zz-s3fti-reset-revokes). 세션은 그 대표의 것일 때만 살아 있어
    // 위의 live 확인은 끊지 않아도 맞는다. 같은 데이터 폴더의 데스크톱 앱이 그 계정으로 다시 로그인해 등록해도 예전 기기 세션은 되살아나지 않는다
    expect(h.core.ctx.store.ownerSessions.get(stale.session.id)?.revokedBy).toBe(OPERATOR);
    h.core.ctx.store.kv.set('owner', desktop);
    expect(h.core.deviceSessions.live(stale.session.id) !== null, '다시 등록된 계정의 예전 세션').toBe(false);
    // 데스크톱 앱의 등록을 되돌린다 — 다음 로그인이 대표 계정을 등록한다
    h.core.ctx.store.kv.set('owner', null);
    const again = await login(client({ tailscale: 't-p3@tailnet' }), '휴대폰');
    expect([again.status, h.core.auth.owner()?.sub]).toEqual(['ok', OWNER_SUB]);
  });

  it('등록된 대표가 대표 이메일의 계정이면(대소문자만 다름 포함) 같은 이메일을 다시 정해도 아무것도 바꾸지 않는다 — 운영자 시험 세션의 시험용 대표도 그대로', async () => {
    const sessions = h.core.deviceSessions.list().length;
    expect(op.applyServerConfig({ ownerEmail: { email: 'OWNER@example.com', source: 'config' } }, 'server.json')).toEqual([]);
    expect([h.core.auth.owner()?.sub, h.core.deviceSessions.list().length]).toEqual([OWNER_SUB, sessions]);
    // 시험용 대표 (--allow-test-session 서버의 운영자 시험 세션, 등록된 대표로 보지 않는다)
    const now = h.core.ctx.now();
    h.core.ctx.store.kv.set('owner', { sub: TEST_OWNER.sub, email: TEST_OWNER.email, name: TEST_OWNER.name, registeredAt: now, lastLoginAt: now });
    const test = h.core.deviceSessions.issue({ deviceName: '운영자 시험 세션' });
    expect(op.applyServerConfig({ ownerEmail: { email: 'owner@example.com', source: 'config' } }, 'server.json')).toEqual([]);
    expect([h.core.auth.owner()?.sub, h.core.deviceSessions.live(test.session.id) !== null]).toEqual([TEST_OWNER.sub, true]);
  });
});
