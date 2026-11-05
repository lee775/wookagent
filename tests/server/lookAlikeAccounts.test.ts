/**
 * 대표 이메일을 닮은 구글 계정 (SERVER_DESIGN 3.5, 리드 결정 S3-5·S3-30 — 첫 검토 tests-integrity가 찾은 시험 빈틈: 이메일을 일부만 견주는 변이 X-ES1(앞부분만)·
 * X-ES2(대표 이메일로 끝나면)와, 저장한 이메일이 글자 그대로 같을 때만 sub를 보는 변이 X-ES4가 살아남았다). 서버 모드 하네스 + 프로세스 안 서버 + 가짜 구글 서버.
 * - 대표가 아직 등록되지 않았을 때(처음 맞는 로그인이 sub를 등록하는 때) 닮은 계정 — 앞에 글자가 붙은 xowner@…, 같은 이름의 다른 도메인, 대표 이메일 뒤에
 *   도메인이 더 붙은 owner@example.com.evil.example — 은 거부되고, 세션 쿠키·기기 세션이 없고, 대표로 등록되지 않는다. 기록에는 도메인만 남는다
 * - 대표가 등록된 뒤에도 같은 닮은 계정은 '대표 계정이 아닌 구글 계정'으로 거부된다(같은 이메일의 다른 계정이라고 하지 않는다)
 * - 대소문자만 다른 대표 이메일의 다른 구글 계정(sub)은 거부된다 — 등록된 sub와 세션은 그대로
 * 브라우저 로그인은 공개 주소에서만 받으므로(S3-31) 서버에 공개 주소를 정하고, 브라우저 흉내는 tailscale serve처럼 그 Host·Origin을 루프백 소켓에 보낸다
 * 세션 값·device_code는 시험 출력에 내지 않는다 — 참거짓·수로만 본다
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DeviceLoginPoll, DeviceLoginStart } from '@shared/views';
import { createHarness, type Harness } from '../e2e/harness';
import type { BackendOperator } from '../../src/main/backend/types';
import { startServer, type RunningServer } from '../../src/server/server';
import { SESSION_COOKIE } from '../../src/server/sessions';
import { FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, OWNER_SUB, startFakeGoogle, type FakeGoogle } from './fakeGoogle';
import { httpCall, memoryLogger, remoteBackendOf, sleep, type HttpResult } from './helpers';

/** 서버의 공개 주소 (S3-31) — 브라우저 흉내는 이 Host로 루프백 소켓에 보낸다(tailscale serve가 하는 것처럼) */
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

const NOT_OWNER = '대표 계정이 아닌 구글 계정이라 로그인하지 않았습니다 — 대표 구글 계정으로 다시 시작하세요';
const rows = () => h.core.ctx.store.activity.search({ limit: 1000 });
const body = <T>(r: HttpResult) => r.json<{ ok: boolean; value: T; error?: { code: string; message: string } }>();
const setCookies = (r: HttpResult): string[] => {
  const v = r.headers['set-cookie'];
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
};
let seq = 0;

/**
 * 브라우저 하나(쿠키·X-Wook-Client·Origin, Tailscale 사용자는 시도마다 다르게 — 시작 횟수·자리 묶음에 걸리지 않게)로 로그인을 시작하고, 가짜 구글이 그
 * 계정(claims)으로 허락한 뒤 간격(1초)이 지나 묻는다. 세션 쿠키를 받았는지는 참거짓으로만 돌려준다
 */
async function loginAs(claims: Record<string, unknown>): Promise<{ poll: DeviceLoginPoll; gotSession: boolean }> {
  const jar = new Map<string, string>();
  const tailscale = `look-alike-${++seq}@tailnet`;
  const call = async (method: string, args: unknown[]): Promise<HttpResult> => {
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
        'Tailscale-User-Login': tailscale,
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: JSON.stringify({ id: `l-${seq}-${method}`, method, args }),
    });
    for (const c of setCookies(r)) {
      const pair = c.split(';')[0]!;
      jar.set(pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1));
    }
    return r;
  };
  const start = await call('auth.deviceLogin', ['닮은 계정 시험']);
  expect(start.status, `시작: ${body(start).error?.code ?? ''}`).toBe(200);
  g.answer(g.lastDeviceCode(), { kind: 'ok', claims });
  await sleep(1100);
  const r = await call('auth.deviceLoginPoll', [body<DeviceLoginStart>(start).value.loginId]);
  expect(r.status).toBe(200);
  return { poll: body<DeviceLoginPoll>(r).value, gotSession: setCookies(r).some((c) => c.startsWith(`${SESSION_COOKIE}=`)) };
}

/** 대표 이메일 owner@example.com을 닮았지만 다른 계정 — 저마다 다른 구글 계정이라 sub도 다르다 */
const LOOK_ALIKES = [
  { email: 'xowner@example.com', sub: 'look-alike-prefix', domain: '@example.com' },
  { email: 'owner@other.example', sub: 'look-alike-domain', domain: '@other.example' },
  { email: 'owner@example.com.evil.example', sub: 'look-alike-suffix', domain: '@example.com.evil.example' },
];

describe('대표 이메일을 닮은 구글 계정 (S3-5·S3-30)', () => {
  it('대표가 등록되기 전: 닮은 계정은 모두 거부된다 — 세션 쿠키·기기 세션이 없고 대표로 등록되지 않으며, 기록에는 도메인만 남는다', async () => {
    expect(h.core.auth.owner()).toBeNull();
    for (const a of LOOK_ALIKES) {
      const { poll, gotSession } = await loginAs({ email: a.email, sub: a.sub });
      expect([a.email, poll, gotSession]).toEqual([a.email, { status: 'denied', message: NOT_OWNER }, false]);
      expect(h.core.deviceSessions.list(), a.email).toEqual([]);
      expect(h.core.auth.owner(), a.email).toBeNull();
      expect(rows().map((e) => e.text)).toContain(`기기 코드 로그인 거부: 대표 이메일이 아닌 구글 계정 (${a.domain})`);
    }
    // 이메일 전체(이름 부분)는 기록에 없다 — 도메인만
    expect(rows().filter((e) => LOOK_ALIKES.some((a) => e.text.includes(a.email))).map((e) => e.text)).toEqual([]);
    // 같은 서버에서 진짜 대표는 로그인하고 sub를 등록한다 — 닮은 계정을 거부한 것이 설정 탓이 아니다
    const real = await loginAs({});
    expect([real.poll.status, real.gotSession]).toEqual(['ok', true]);
    expect(h.core.auth.owner()).toMatchObject({ sub: OWNER_SUB, email: 'owner@example.com' });
  });

  it('대표가 등록된 뒤: 닮은 계정은 그대로 대표 계정이 아닌 구글 계정이다 — 같은 이메일의 다른 계정이라고 말하지 않는다', async () => {
    const sessions = h.core.deviceSessions.list().length;
    for (const a of LOOK_ALIKES) {
      const { poll, gotSession } = await loginAs({ email: a.email, sub: a.sub });
      expect([a.email, poll, gotSession]).toEqual([a.email, { status: 'denied', message: NOT_OWNER }, false]);
    }
    expect(h.core.deviceSessions.list()).toHaveLength(sessions);
    expect(h.core.auth.owner()).toMatchObject({ sub: OWNER_SUB, email: 'owner@example.com' });
  });

  it('대소문자만 다른 대표 이메일의 다른 구글 계정(sub)은 거부된다 — 등록된 sub·이메일과 기기 세션은 그대로', async () => {
    const before = h.core.deviceSessions.list().map((s) => s.id);
    const { poll, gotSession } = await loginAs({ email: 'OWNER@EXAMPLE.COM', sub: 'another-google-account' });
    expect([poll.status, gotSession]).toEqual(['denied', false]);
    expect(poll.message?.startsWith('대표 이메일은 맞지만 처음 등록한 구글 계정이 아닙니다')).toBe(true);
    expect(h.core.deviceSessions.list().map((s) => s.id)).toEqual(before);
    expect(h.core.auth.owner()).toMatchObject({ sub: OWNER_SUB, email: 'owner@example.com' });
    expect(rows().some((e) => e.text.startsWith('기기 코드 로그인 거부: 대표 이메일은 같지만 처음 등록한 구글 계정이 아님 ('))).toBe(true);
    // 같은 대소문자 다른 이메일이라도 등록된 그 계정(sub)이면 받는다 — 거부는 sub 때문이다
    const same = await loginAs({ email: 'OWNER@EXAMPLE.COM' });
    expect([same.poll.status, same.gotSession]).toEqual(['ok', true]);
  });
});
