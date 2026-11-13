/**
 * 기기 코드 로그인의 간격은 단조 시계로 잰다 (SERVER_DESIGN 3.5, 리드 결정 S10t — S2-16·S9-24와 같은 규칙).
 * Linux 첫 실행(WSL2)에서 deviceLogin·cookieToss·lookAlikeAccounts가 가끔 '기다림'을 받았다: 허락 뒤 1.1초를 자고 물었는데 서버는 간격(1초) 전이라며 구글에
 * 묻지 않았다. 그 PC의 벽시계(Date.now)는 30초쯤마다 0.5초씩 뒤로 되돌려졌고(잰 값: 90초에 −580·−562·−472ms), 서버는 간격을 그 벽시계(ctx.clock)로 쟀다.
 * 이 시험은 앱 시계(벽시계)를 손으로 뒤로·앞으로 옮겨 그 결함을 Windows에서도 드러낸다:
 * - 벽시계가 뒤로 가도 간격이 지나면 구글에 묻는다 — 예전에는 '기다림'(구글에 묻지 않음)
 * - 벽시계가 앞으로 뛰어도 간격 전에는 구글에 묻지 않는다 — 예전에는 곧바로 물었다(진짜 구글이면 slow_down으로 간격이 5초 늘어난다)
 * - 화면에 보이는 만료 시각은 벽시계로 10분 뒤다
 * 세션 값·device_code는 시험 출력에 내지 않는다
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DeviceLoginPoll, DeviceLoginStart } from '@shared/views';
import { createHarness, type Harness } from '../e2e/harness';
import { startServer, type RunningServer } from '../../src/server/server';
import { offsetClock } from './externalRig';
import { FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, startFakeGoogle, type FakeGoogle } from './fakeGoogle';
import { httpCall, memoryLogger, remoteBackendOf, sleep, type HttpResult } from './helpers';

const PUBLIC = 'https://grok-pc.tailnet-clock.ts.net';
const PUBLIC_HOST = 'grok-pc.tailnet-clock.ts.net';

let g: FakeGoogle;
let h: Harness;
let server: RunningServer;
/** 앱 시계 = 실제 벽시계 + 손으로 옮긴 차이 */
const wall = offsetClock();

beforeAll(async () => {
  g = await startFakeGoogle();
  h = await createHarness({ mode: 'server', noProject: true, googleDevice: { endpoints: g.endpoints }, clock: wall });
  const backend = remoteBackendOf(h);
  server = await startServer({ backend, dataDir: h.dataDir, port: 0, allowTestSession: false, logger: memoryLogger(), version: 'test', publicOrigin: PUBLIC });
  backend.operator.applyServerConfig({ ownerEmail: { email: 'owner@example.com', source: 'config' }, googleClientId: FAKE_CLIENT_ID }, 'server.json');
  await backend.operator.setGoogleClientSecret(FAKE_CLIENT_SECRET);
}, 120_000);

afterAll(async () => {
  await server?.close();
  await h?.close();
  await g?.close();
});

const body = <T>(r: HttpResult) => r.json<{ ok: boolean; value: T; error?: { code: string } }>();
let seq = 0;

/** 브라우저 하나(쿠키·공개 주소의 Host·Origin, 시험마다 다른 Tailscale 사용자)로 로그인을 시작한다 */
async function startLogin(): Promise<{ loginId: string; code: string; start: DeviceLoginStart; poll(): Promise<DeviceLoginPoll> }> {
  const jar = new Map<string, string>();
  const who = `clock-${++seq}@tailnet`;
  const call = async (method: string, args: unknown[]): Promise<HttpResult> => {
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const r = await httpCall({
      url: server.url,
      path: '/api/invoke',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Host: PUBLIC_HOST, Origin: PUBLIC, 'X-Wook-Client': '1', 'Tailscale-User-Login': who, ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify({ id: `c-${seq}-${method}`, method, args }),
    });
    const set = r.headers['set-cookie'];
    for (const c of set === undefined ? [] : Array.isArray(set) ? set : [set]) {
      const pair = c.split(';')[0]!;
      jar.set(pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1));
    }
    return r;
  };
  const r = await call('auth.deviceLogin', ['시계 시험']);
  expect(r.status, `시작: ${body(r).error?.code ?? ''}`).toBe(200);
  const start = body<DeviceLoginStart>(r).value;
  expect(start.intervalSec).toBe(1);
  return {
    loginId: start.loginId,
    code: g.lastDeviceCode(),
    start,
    poll: async () => {
      const p = await call('auth.deviceLoginPoll', [start.loginId]);
      expect(p.status).toBe(200);
      return body<DeviceLoginPoll>(p).value;
    },
  };
}

describe('기기 코드 로그인의 간격은 단조 시계로 잰다 (S10t)', () => {
  it('벽시계가 5초 뒤로 가도 간격(1초)이 지나면 구글에 묻는다 — 예전에는 기다림으로 답하고 묻지 않았다', async () => {
    const l = await startLogin();
    g.answer(l.code, { kind: 'denied' });
    wall.advance(-5000);
    await sleep(1100);
    expect([(await l.poll()).status, g.tokenCalls(l.code)]).toEqual(['denied', 1]);
  });

  it('벽시계가 5초 앞으로 뛰어도 간격 전에는 구글에 묻지 않는다 — 간격이 지나면 묻는다', async () => {
    const l = await startLogin();
    // 화면에 보이는 만료는 지금 벽시계로 10분 뒤 (단조 시계 값이 아니다)
    const life = Date.parse(l.start.expiresAt) - wall.ms();
    expect(life > 590_000 && life <= 601_000, `life=${life}`).toBe(true);
    wall.advance(5000);
    expect([(await l.poll()).status, g.tokenCalls(l.code)]).toEqual(['pending', 0]);
    g.answer(l.code, { kind: 'denied' });
    await sleep(1100);
    expect([(await l.poll()).status, g.tokenCalls(l.code)]).toEqual(['denied', 1]);
  });
});
