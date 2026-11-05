/**
 * 구글 기기 코드 로그인 (SERVER_DESIGN 3.5, 리드 결정 S3-5 — src/main/auth/googleDevice.ts): 가짜 구글 서버(fakeGoogle.ts)로 본다.
 * - 기기 코드 요청: client_id·scope=openid email profile, 응답 모양 확인(https verification_url), invalid_client는 클라이언트 종류를 말한다, 닿지 못하면 network
 * - 토큰 묻기: grant_type device_code·client_id·client_secret·device_code. authorization_pending → 기다림, slow_down, access_denied → 거부,
 *   expired_token → 만료. id_token은 서명·aud=client_id·iss·exp·email_verified를 본다 — nonce는 없다. 구글 장애(5xx)는 network
 * - 진행 중인 로그인(DeviceLoginFlows, 손으로 돌리는 시계): 동시에 3개, 하나에 10분(구글 코드가 더 빨리 끝나면 그쪽), 열쇠마다 1분에 시작 5번,
 *   간격 전에는 구글에 묻지 않음, slow_down이면 간격 +5초, 시작한 열쇠만 찾음, 같은 호출자의 새 시작은 앞의 기다림을 대신함
 * 보안 비밀·device_code·id_token은 시험 출력에 내지 않는다 — 참거짓·수로만 본다
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEVICE_LOGIN_LIMITS, DeviceLoginFlows, pollDeviceToken, requestDeviceCode, type DeviceCodeGrant } from '../../src/main/auth/googleDevice';
import { GoogleLoginError } from '../../src/main/auth/types';
import { FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, OWNER_SUB, startFakeGoogle, type FakeGoogle } from './fakeGoogle';

let g: FakeGoogle;
beforeAll(async () => {
  g = await startFakeGoogle();
});
afterAll(async () => {
  await g?.close();
});

const opts = () => ({ endpoints: g.endpoints });
const errorOf = async (p: Promise<unknown>): Promise<GoogleLoginError> => {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(GoogleLoginError);
  return e as GoogleLoginError;
};
const poll = (deviceCode: string) => pollDeviceToken({ clientId: FAKE_CLIENT_ID, clientSecret: FAKE_CLIENT_SECRET, deviceCode }, opts());

describe('기기 코드 받기', () => {
  it('client_id와 scope(openid email profile)를 보내고 user_code·verification_url·만료·간격을 받는다 — device_code는 부른 쪽(서버)만 가진다', async () => {
    const before = g.codeRequests.length;
    const grant = await requestDeviceCode(FAKE_CLIENT_ID, opts());
    const sent = g.codeRequests[before]!;
    expect([...sent.keys()].sort()).toEqual(['client_id', 'scope']);
    expect([sent.get('client_id'), sent.get('scope')]).toEqual([FAKE_CLIENT_ID, 'openid email profile']);
    expect(grant.deviceCode === g.lastDeviceCode()).toBe(true);
    expect(grant).toMatchObject({ verificationUrl: 'https://www.google.com/device', expiresInSec: 1800, intervalSec: 1 });
    expect(grant.userCode).toMatch(/^[A-Z]{4}-[A-Z]{4}$/);
  });

  it("구글이 클라이언트를 받지 않으면(invalid_client) 'TV 및 입력 제한 기기' 종류인지 보라고 말한다", async () => {
    const e = await errorOf(requestDeviceCode('9999-other.apps.googleusercontent.com', opts()));
    expect(e.code).toBe('token_exchange');
    expect(e.message).toBe("구글이 이 클라이언트 ID로 기기 코드를 내주지 않았습니다 (invalid_client) — 'TV 및 입력 제한 기기' 종류의 클라이언트 ID인지 확인하세요");
  });

  it('응답 모양이 틀리면(https가 아닌 주소, 빈 user_code) 받지 않는다', async () => {
    for (const body of [
      { device_code: 'x', user_code: 'ABCD-EFGH', verification_url: 'http://www.google.com/device', expires_in: 1800, interval: 5 },
      { device_code: 'x', user_code: 'ABCD-EFGH', verification_url: 'javascript:alert(1)', expires_in: 1800, interval: 5 },
      { device_code: 'x', user_code: '', verification_url: 'https://www.google.com/device', expires_in: 1800, interval: 5 },
      { device_code: '', user_code: 'ABCD-EFGH', verification_url: 'https://www.google.com/device', expires_in: 1800, interval: 5 },
    ]) {
      g.codeAnswer = { status: 200, body };
      try {
        expect((await errorOf(requestDeviceCode(FAKE_CLIENT_ID, opts()))).code).toBe('invalid_token');
      } finally {
        g.codeAnswer = null;
      }
    }
  });

  it('구글에 닿지 못하거나 구글이 잠시 답하지 못하면(5xx) network — 기다리는 로그인은 다음에 다시 묻는다', async () => {
    const closed = await errorOf(requestDeviceCode(FAKE_CLIENT_ID, { endpoints: { deviceCode: 'http://127.0.0.1:9/device/code' } }));
    expect(closed.code).toBe('network');
    g.codeAnswer = { status: 503, body: 'unavailable' };
    try {
      expect((await errorOf(requestDeviceCode(FAKE_CLIENT_ID, opts()))).code).toBe('network');
    } finally {
      g.codeAnswer = null;
    }
  });
});

describe('토큰 묻기', () => {
  it('device_code 방식으로 묻는다 — grant_type·client_id·client_secret·device_code만', async () => {
    const grant = await requestDeviceCode(FAKE_CLIENT_ID, opts());
    const before = g.tokenRequests.length;
    expect(await poll(grant.deviceCode)).toEqual({ kind: 'pending' });
    const sent = g.tokenRequests[before]!;
    expect([...sent.keys()].sort()).toEqual(['client_id', 'client_secret', 'device_code', 'grant_type']);
    expect(sent.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:device_code');
    expect(sent.get('client_id')).toBe(FAKE_CLIENT_ID);
    expect(sent.get('client_secret') === FAKE_CLIENT_SECRET).toBe(true);
    expect(sent.get('device_code') === grant.deviceCode).toBe(true);
  });

  it('authorization_pending → 기다림, slow_down, access_denied → 거부, expired_token → 만료', async () => {
    const cases: [Parameters<FakeGoogle['answer']>[1], unknown][] = [
      [{ kind: 'pending' }, { kind: 'pending' }],
      [{ kind: 'slow_down' }, { kind: 'slow_down' }],
      [{ kind: 'denied' }, { kind: 'denied' }],
      [{ kind: 'expired' }, { kind: 'expired' }],
    ];
    for (const [answer, want] of cases) {
      const grant = await requestDeviceCode(FAKE_CLIENT_ID, opts());
      g.answer(grant.deviceCode, answer);
      expect(await poll(grant.deviceCode), answer.kind).toEqual(want);
    }
  });

  it('허락하면 id_token을 확인한 프로필 — nonce 없이 서명·aud·iss·exp·email_verified를 본다', async () => {
    const grant = await requestDeviceCode(FAKE_CLIENT_ID, opts());
    g.answer(grant.deviceCode, { kind: 'ok' });
    expect(await poll(grant.deviceCode)).toEqual({ kind: 'ok', profile: { sub: OWNER_SUB, email: 'owner@example.com', emailVerified: true, name: '김대표' } });
    // 허락한 코드는 한 번만 — 그 뒤는 구글이 거부한다
    expect((await errorOf(poll(grant.deviceCode))).code).toBe('token_exchange');
  });

  it('다른 클라이언트의 토큰·다른 키의 서명·다른 발급자·끝난 토큰·이메일 미인증은 받지 않는다', async () => {
    const now = Math.floor(Date.now() / 1000);
    const bad: [string, Parameters<FakeGoogle['answer']>[1], string][] = [
      ['aud', { kind: 'ok', claims: { aud: 'someone-else.apps.googleusercontent.com', azp: 'someone-else.apps.googleusercontent.com' } }, 'invalid_token'],
      ['서명', { kind: 'ok', otherKey: true }, 'invalid_token'],
      ['iss', { kind: 'ok', claims: { iss: 'https://evil.example' } }, 'invalid_token'],
      ['exp', { kind: 'ok', claims: { exp: now - 3600 } }, 'invalid_token'],
      ['email_verified', { kind: 'ok', claims: { email_verified: false } }, 'email_unverified'],
    ];
    for (const [label, answer, code] of bad) {
      const grant = await requestDeviceCode(FAKE_CLIENT_ID, opts());
      g.answer(grant.deviceCode, answer);
      expect((await errorOf(poll(grant.deviceCode))).code, label).toBe(code);
    }
  });

  it('잘못된 보안 비밀(invalid_client)은 거부, 구글 장애(5xx)는 network', async () => {
    const grant = await requestDeviceCode(FAKE_CLIENT_ID, opts());
    const wrong = await errorOf(pollDeviceToken({ clientId: FAKE_CLIENT_ID, clientSecret: 'GOCSPX-wrong', deviceCode: grant.deviceCode }, opts()));
    expect([wrong.code, wrong.message]).toEqual(['token_exchange', '구글이 로그인 확인을 거부했습니다 (HTTP 401, invalid_client)']);
    g.answer(grant.deviceCode, { kind: 'down' });
    expect((await errorOf(poll(grant.deviceCode))).code).toBe('network');
  });
});

describe('진행 중인 로그인 (DeviceLoginFlows)', () => {
  const grant = (over: Partial<DeviceCodeGrant> = {}): DeviceCodeGrant => ({ deviceCode: 'dc', userCode: 'ABCD-EFGH', verificationUrl: 'https://www.google.com/device', expiresInSec: 1800, intervalSec: 5, ...over });
  const clock = () => {
    let t = 1_000_000;
    return { now: () => t, advance: (ms: number) => (t += ms) };
  };

  it('기본 상한은 결정 그대로 — 모두 합쳐 동시에 6개·자리 묶음마다 2개(S3-22), 10분, 1분에 시작 5번, slow_down +5초', () => {
    expect(DEVICE_LOGIN_LIMITS).toEqual({ maxPending: 6, maxPendingPerBucket: 2, maxLifetimeMs: 600_000, startsPerWindow: 5, startWindowMs: 60_000, slowDownSec: 5 });
  });

  it('동시에 기다리는 로그인은 모두 합쳐 6개까지 — 하나가 끝나면 다시 받는다 (S3-22)', () => {
    const c = clock();
    const f = new DeviceLoginFlows(c.now);
    const logins = ['a', 'b', 'c', 'e', 'f', 'g'].map((k) => {
      expect(f.admit(k, k)).toEqual({ ok: true });
      return f.add(k, grant(), k);
    });
    expect(f.admit('d', 'd')).toEqual({ ok: false, reason: 'full' });
    f.finish(logins[0]!, { status: 'denied' });
    expect(f.admit('d', 'd')).toEqual({ ok: true });
  });

  it('같은 열쇠는 1분에 시작 5번까지(거부된 시작도 센다) — 1분이 지나면 다시', () => {
    const c = clock();
    const f = new DeviceLoginFlows(c.now);
    for (let i = 0; i < 5; i++) expect(f.admit('anonymous', null).ok, `시작 ${i + 1}`).toBe(true);
    expect(f.admit('anonymous', null)).toEqual({ ok: false, reason: 'rate' });
    expect(f.admit('tailscale:other@x', null).ok).toBe(true);
    c.advance(59_000);
    expect(f.admit('anonymous', null).ok).toBe(false);
    c.advance(2_000);
    expect(f.admit('anonymous', null).ok).toBe(true);
  });

  it('같은 호출자의 새 시작은 앞의 기다림을 대신한다 — 다시 시작해도 자리를 막지 않는다', () => {
    const c = clock();
    const f = new DeviceLoginFlows(c.now);
    const first = f.add('login:a', grant(), '휴대폰');
    f.add('login:b', grant(), '다른 휴대폰');
    expect(f.admit('anonymous', 'login:a').ok).toBe(true);
    expect(f.find(first.loginId, 'login:a')).toBeNull();
    expect(f.pending()).toBe(1);
  });

  it('하나는 10분까지 — 구글 코드가 더 빨리 끝나면 그쪽. 끝나면 만료 답이고 1분 뒤에는 찾지 못한다', () => {
    const c = clock();
    const f = new DeviceLoginFlows(c.now);
    const long = f.add('k', grant({ expiresInSec: 1800 }), 'x');
    const short = f.add('k2', grant({ expiresInSec: 120 }), 'x');
    expect(long.expiresAt - long.startedAt).toBe(600_000);
    expect(short.expiresAt - short.startedAt).toBe(120_000);
    c.advance(120_000);
    expect(f.next(short)).toBe('done');
    expect(short.outcome).toEqual({ status: 'expired', message: '로그인 코드가 끝났습니다 — 다시 시작하세요' });
    expect(f.next(long)).not.toBe('done');
    c.advance(60_000);
    expect(f.find(short.loginId, 'k2')).toBeNull();
    expect(f.find(long.loginId, 'k')).not.toBeNull();
  });

  it('간격 전이나 묻는 중에는 구글에 묻지 않는다 — slow_down이면 간격이 5초 늘어난다', () => {
    const c = clock();
    const f = new DeviceLoginFlows(c.now);
    const l = f.add('k', grant({ intervalSec: 5 }), 'x');
    expect(f.next(l)).toBe('wait');
    c.advance(5_000);
    expect(f.next(l)).toBe('go');
    expect(f.next(l)).toBe('wait');
    f.waitMore(l, true);
    expect(l.intervalSec).toBe(10);
    c.advance(9_999);
    expect(f.next(l)).toBe('wait');
    c.advance(1);
    expect(f.next(l)).toBe('go');
    f.waitMore(l, false);
    expect(l.intervalSec).toBe(10);
  });

  it('그 로그인을 시작한 열쇠만 찾는다 — 끝난 답은 다시 물어도 같고 device_code는 지운다', () => {
    const c = clock();
    const f = new DeviceLoginFlows(c.now);
    const l = f.add('login:mine', grant(), 'x');
    expect(f.find(l.loginId, 'login:mine')).toBe(l);
    expect(f.find(l.loginId, 'login:other')).toBeNull();
    expect(f.find(l.loginId, 'anonymous')).toBeNull();
    expect(f.find('dl_없는', 'login:mine')).toBeNull();
    f.finish(l, { status: 'denied', message: '거부' });
    expect(f.next(l)).toBe('done');
    expect(l.outcome).toEqual({ status: 'denied', message: '거부' });
    expect(l.deviceCode).toBe('');
  });

  it('로그인 ID는 짐작할 수 없는 난수다', () => {
    const f = new DeviceLoginFlows(() => 0);
    const ids = new Set(Array.from({ length: 20 }, (_, i) => f.add(`k${i}`, grant(), 'x').loginId));
    expect(ids.size).toBe(20);
    for (const id of ids) expect(id).toMatch(/^dl_[A-Za-z0-9_-]{24}$/);
  });
});
