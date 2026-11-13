/**
 * 빌드한 서버의 처음부터 끝까지 (리드 결정 S3-30 — 첫 검토 flows-lifecycle의 프로브 zz-s3fl-built를 옮김, SERVER_DESIGN 3.5·10.3 '가짜 구글 토큰 서버'):
 * 빈 데이터 폴더 → 설정 코드 → 대표 이메일 → 운영자의 구글 클라이언트 설정 → 가짜 구글로 기기 코드 로그인 → 로그인한 대표.
 * 빌드한 서버에는 구글 주소를 바꾸는 길이 없고 `secret set`은 OS 보안 저장소에 쓴다. 제품 코드에 시험 스위치를 두지 않고, 서버를
 * `node --require tests/server/fakeGooglePreload.cjs`로 띄운다 — 구글 주소로 가는 fetch는 이 시험의 가짜 구글 서버로, @napi-rs/keyring은 파일 하나에
 * 쓰는 가짜로 바뀐다(실제 OS 보안 저장소와 실제 구글에 닿지 않는다). serve.ts·createBackend의 기기 코드 로그인 배선이 깨지면 여기서 드러난다 —
 * 프로세스 안 시험(deviceLogin.test 등)은 하네스로 백엔드를 만들어 그 배선을 거치지 않는다.
 * 브라우저 로그인은 공개 주소에서만 받으므로(S3-31) 서버를 --public-origin으로 띄우고, 브라우저 흉내는 tailscale serve처럼 그 Host·Origin을 루프백 소켓에 보낸다.
 * 세션 값·로그인 전 쿠키·설정 코드·device_code·보안 비밀은 시험 출력에 내지 않는다 — 참거짓·수로만 본다
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OPERATOR, OWNER } from '@shared/domain';
import type { AuthState, DeviceLoginPoll, DeviceLoginStart, DeviceSessionView, NotificationView } from '@shared/views';
import { openStore } from '../../src/main/db/store';
import { LOGIN_COOKIE, SESSION_COOKIE } from '../../src/server/sessions';
import { FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, OWNER_SUB, startFakeGoogle, type FakeGoogle } from './fakeGoogle';
import { secretPlace } from '../../src/server/cli';
import { storedSecrets } from './storedSecrets';
import { secretsDirOf } from '../../src/main/auth/fileSecretStore';
import { buildServerTo, childEnv, httpCall, openSse, REPO, removeDir, runClient, sleep, startBuilt, testBuildDir, type BuiltServer, type HttpResult, type SseClient } from './helpers';

const PRELOAD = join(REPO, 'tests', 'server', 'fakeGooglePreload.cjs');
/** 서버의 공개 주소 (S3-31) — 브라우저 흉내는 이 Host로 루프백 소켓에 보낸다(tailscale serve가 하는 것처럼) */
const PUBLIC = 'https://grok-pc.tailnet-test.ts.net';
const PUBLIC_HOST = 'grok-pc.tailnet-test.ts.net';

let g: FakeGoogle;
let outDir = '';
let entry = '';
let dataDir = '';
let keyringFile = '';
let srv: BuiltServer | null = null;
const temp: string[] = [];
const streams: SseClient[] = [];
/** 이 실행에서 본 비밀 값 — 마지막 시험이 데이터 폴더의 어느 파일에도 없는지 본다(값은 내지 않는다) */
const secrets: string[] = [];

beforeAll(async () => {
  g = await startFakeGoogle();
  outDir = testBuildDir('login');
  entry = buildServerTo(outDir);
  dataDir = mkdtempSync(join(tmpdir(), 'wook-test-login-data-'));
  const kdir = mkdtempSync(join(tmpdir(), 'wook-test-login-keyring-'));
  temp.push(dataDir, kdir);
  keyringFile = join(kdir, 'keyring.json');
  srv = await startBuilt({ entry, dataDir, args: ['--public-origin', PUBLIC], nodeArgs: ['--require', PRELOAD], env: { WOOK_TEST_FAKE_GOOGLE_URL: g.url, WOOK_TEST_KEYRING_FILE: keyringFile } });
}, 240_000);

afterAll(async () => {
  for (const s of streams) s.close();
  await shutdown().catch(() => undefined);
  await g?.close();
  for (const d of temp) await removeDir(d);
  if (outDir) await removeDir(outDir);
}, 120_000);

async function shutdown(): Promise<void> {
  if (!srv || srv.child.exitCode !== null) return;
  runClient(entry, ['shutdown', '--data-dir', dataDir]);
  await Promise.race([srv.exited, sleep(45_000)]);
  if (srv.child.exitCode === null) srv.child.kill();
}

const setCookies = (r: HttpResult): string[] => {
  const v = r.headers['set-cookie'];
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
};
const body = <T>(r: HttpResult) => r.json<{ ok: boolean; value: T; error?: { code: string; message: string } }>();
let seq = 0;

/** 브라우저 흉내: 공개 주소의 Host로 쿠키를 모으고 X-Wook-Client·공개 주소의 Origin을 싣는다. Tailscale 사용자 머리는 tailscale serve처럼 */
function browser(tailscale: string) {
  const jar = new Map<string, string>();
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const call = async (method: string, args: unknown[] = []): Promise<HttpResult> => {
    const r = await httpCall({
      url: srv!.url,
      path: '/api/invoke',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Host: PUBLIC_HOST,
        'X-Wook-Client': '1',
        Origin: PUBLIC,
        'Tailscale-User-Login': tailscale,
        ...(jar.size ? { Cookie: cookie() } : {}),
      },
      body: JSON.stringify({ id: `b-${++seq}`, method, args }),
    });
    for (const c of setCookies(r)) {
      const pair = c.split(';')[0]!;
      const name = pair.slice(0, pair.indexOf('='));
      if (/Max-Age=0(?:;|$)/.test(c)) jar.delete(name);
      else jar.set(name, pair.slice(pair.indexOf('=') + 1));
    }
    return r;
  };
  const sse = async (): Promise<SseClient> => {
    const s = await openSse(srv!.url, '', '', { Host: PUBLIC_HOST, Cookie: cookie(), 'Tailscale-User-Login': tailscale });
    streams.push(s);
    await s.waitFor((ev) => ev.some((e) => e.event === 'snapshot'), '첫 스냅숏', 15_000);
    return s;
  };
  return { jar, call, sse };
}
type Browser = ReturnType<typeof browser>;

/** 로그인을 시작하고 가짜 구글이 허락한 뒤 간격(1초)이 지나 묻는다 */
async function login(b: Browser, deviceName: string): Promise<HttpResult> {
  const start = await b.call('auth.deviceLogin', [deviceName]);
  expect([start.status, body(start).error?.code ?? null], `시작 ${deviceName}`).toEqual([200, null]);
  const s = body<DeviceLoginStart>(start).value;
  expect([s.verificationUrl, s.userCode.length > 0, b.jar.has(LOGIN_COOKIE)]).toEqual(['https://www.google.com/device', true, true]);
  secrets.push(b.jar.get(LOGIN_COOKIE)!);
  g.answer(g.lastDeviceCode(), { kind: 'ok' });
  await sleep(1200);
  return b.call('auth.deviceLoginPoll', [s.loginId]);
}

const phone = browser('owner@example.com');
const pc = browser('owner@example.com');

describe('빌드한 서버: 빈 데이터 폴더에서 로그인한 대표까지 (S3-30)', () => {
  it('설정 코드: 서버가 setup-code.txt에 보여 주는 꼴(ABCD-EFGH)을 소문자로 넣어도 대표 이메일만 정하고 그 파일을 지운다 — 그 전에는 로그인을 시작하지 않는다', async () => {
    const file = join(dataDir, 'setup-code.txt');
    const until = Date.now() + 15_000;
    while (!existsSync(file) && Date.now() < until) await sleep(50);
    const shown = /코드: ([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(readFileSync(file, 'utf8'))?.[1] ?? '';
    secrets.push(shown, shown.replace('-', ''));
    expect(shown.length).toBe(9);
    expect(body<AuthState>(await phone.call('auth.getState')).value).toMatchObject({ mode: 'server', setupRequired: true, loggedIn: false });
    const early = await phone.call('auth.deviceLogin', ['휴대폰']);
    expect([early.status, body(early).error?.code]).toEqual([409, 'not_configured']);
    const r = await phone.call('auth.setupOwner', [shown.toLowerCase(), 'owner@example.com']);
    expect([r.status, body<AuthState>(r).value]).toMatchObject([200, { setupRequired: false, loggedIn: false }]);
    expect(existsSync(file)).toBe(false);
    // 구글 클라이언트가 아직 없다 — 설정 코드는 대표 이메일만 정했다
    const noClient = await phone.call('auth.deviceLogin', ['휴대폰']);
    expect([noClient.status, body(noClient).error?.code]).toEqual([409, 'not_configured']);
    expect(g.codeRequests).toHaveLength(0);
  });

  it('운영자: config google-client-id와 secret set(표준 입력) — 보안 비밀은 가짜 보안 저장소에 들어가고 화면은 설정이 끝났다고 본다', async () => {
    expect(runClient(entry, ['config', 'google-client-id', FAKE_CLIENT_ID, '--data-dir', dataDir]).code).toBe(0);
    const s = spawnSync(process.execPath, [entry, 'secret', 'set', 'google-client-secret', '--data-dir', dataDir], {
      cwd: REPO,
      env: childEnv(),
      input: `${FAKE_CLIENT_SECRET}\n`,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 60_000,
    });
    expect([s.status, s.stdout.trim()]).toEqual([0, `구글 로그인 보안 비밀을 ${secretPlace()}에 넣었습니다 (값은 다시 보여 주지 않습니다).`]);
    // 서버 프로세스의 보안 저장소는 이 시험의 가짜다 — 실제 OS 보안 저장소에는 쓰지 않았다 (Linux는 시험의 임시 데이터 폴더 안 파일 저장소, S10-6.1)
    expect(Object.values(storedSecrets({ keyringFile, dataDir })).includes(FAKE_CLIENT_SECRET)).toBe(true);
    expect(body<AuthState>(await phone.call('auth.getState')).value).toMatchObject({ setupRequired: false, googleConfigured: true, googleSecretSet: true, loggedIn: false });
  });

  it('기기 코드 로그인: 허락한 묻기 응답에만 세션 쿠키가 실리고 그 브라우저는 로그인한 대표다 — 처음 맞는 로그인이 구글 계정을 등록한다', async () => {
    const r = await login(phone, '휴대폰');
    expect(r.status).toBe(200);
    expect(body<DeviceLoginPoll>(r).value).toMatchObject({ status: 'ok', auth: { loggedIn: true, mode: 'server', owner: { email: 'owner@example.com' } } });
    expect([phone.jar.has(SESSION_COOKIE), /wos_[A-Za-z0-9_-]{20,}/.test(r.text)]).toEqual([true, false]);
    secrets.push(phone.jar.get(SESSION_COOKIE)!);
    // 서버는 가짜 구글에 이 클라이언트로 물었다 (실제 구글이 아니다)
    expect([g.codeRequests.at(-1)?.get('client_id') === FAKE_CLIENT_ID, g.tokenRequests.length > 0]).toEqual([true, true]);
    expect(body<{ auth: { loggedIn: boolean } }>(await phone.call('snapshot.get')).value.auth.loggedIn).toBe(true);
    const devices = body<DeviceSessionView[]>(await phone.call('auth.listDevices')).value;
    expect(devices.map((d) => [d.deviceName, d.tailscaleLogin, d.current])).toEqual([['휴대폰', 'owner@example.com', true]]);
    // 쿠키로 연 SSE도 로그인한 대표의 스냅숏이다
    const stream = await phone.sse();
    const first = stream.events.find((e) => e.event === 'snapshot')!.data.payload as { auth: { loggedIn: boolean } };
    expect(first.auth.loggedIn).toBe(true);
  });

  it('둘째 기기(PC)가 로그인하면 휴대폰의 SSE에 새 기기 알림이 간다 — 두 기기는 저마다 제 세션이다', async () => {
    const phoneStream = streams.at(-1)!;
    const r = await login(pc, '사무실 PC');
    expect([r.status, body<DeviceLoginPoll>(r).value.status, pc.jar.has(SESSION_COOKIE)]).toEqual([200, 'ok', true]);
    secrets.push(pc.jar.get(SESSION_COOKIE)!);
    expect(pc.jar.get(SESSION_COOKIE) === phone.jar.get(SESSION_COOKIE)).toBe(false);
    const pcId = body<DeviceSessionView[]>(await pc.call('auth.listDevices')).value.find((d) => d.current)!.id;
    const key = `device-login:${pcId}`;
    await phoneStream.waitFor((ev) => ev.some((e) => e.event === 'notification' && (e.data.payload as NotificationView).key === key), '새 기기 알림', 10_000);
    const notice = phoneStream.events.find((e) => e.event === 'notification' && (e.data.payload as NotificationView).key === key)!.data.payload as NotificationView;
    expect([notice.title, notice.body.split('\n')[0]]).toEqual(['새 기기 로그인', '사무실 PC 기기가 로그인했습니다.']);
    expect(body<{ auth: { loggedIn: boolean } }>(await pc.call('snapshot.get')).value.auth.loggedIn).toBe(true);
  });

  it('끝: 활동 기록이 대표의 설정·등록과 운영자의 설정을 남기고, 데이터 폴더의 어느 파일에도 세션 값·로그인 전 쿠키·설정 코드·device_code·보안 비밀이 없다', async () => {
    for (const s of streams) s.close();
    await shutdown();
    expect(srv!.child.exitCode).toBe(0);
    const store = openStore(join(dataDir, 'wook.db'));
    try {
      const rows = store.activity.search({ limit: 1000 }).map((e) => ({ actor: e.actor, text: e.text }));
      expect(rows).toContainEqual({ actor: OWNER, text: '대표 이메일 정함: owner@example.com (설정 코드)' });
      expect(rows).toContainEqual({ actor: OWNER, text: '대표 등록 및 로그인 (owner@example.com) — 기기 코드 로그인, 기기 휴대폰' });
      expect(rows).toContainEqual({ actor: OWNER, text: '대표 로그인 — 기기 코드 로그인, 새 기기 사무실 PC' });
      expect(rows.some((x) => x.actor === OPERATOR && x.text.includes('서버 구글 클라이언트 ID'))).toBe(true);
      expect(store.kv.get<{ sub: string }>('owner')?.sub).toBe(OWNER_SUB);
    } finally {
      store.close();
    }
    const all = [...secrets, ...g.tokenRequests.map((f) => f.get('device_code') ?? ''), FAKE_CLIENT_SECRET].filter((x) => x.length >= 8);
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const f of readdirSync(dir)) {
        const full = join(dir, f);
        if (statSync(full).isDirectory()) walk(full);
        else files.push(full);
      }
    };
    walk(dataDir);
    // Linux의 비밀 값 파일 저장소(<데이터 폴더>/secrets, 0700 폴더의 0600 파일 — 리드 결정 S10-6.1)는 보안 비밀을 두는 자리다 — 그 자리의 보안 비밀만 빼고 본다.
    // 세션 값·로그인 전 쿠키·설정 코드·device_code는 그 자리에도 없어야 한다
    const storeDir = `${secretsDirOf(dataDir)}${sep}`;
    const inStore = (f: string): boolean => process.platform === 'linux' && f.startsWith(storeDir);
    const found = files.filter((f) => {
      const bytes = readFileSync(f);
      const text = bytes.toString('utf8') + bytes.toString('latin1');
      const look = inStore(f) ? all.filter((x) => x !== FAKE_CLIENT_SECRET) : all;
      return look.some((x) => text.includes(x)) || /wos_[A-Za-z0-9_-]{43}/.test(text);
    });
    expect({ checked: all.length >= 8, files: files.length > 0, found: found.map((f) => f.slice(dataDir.length)) }).toEqual({ checked: true, files: true, found: [] });
    if (process.platform === 'linux') {
      const stored = files.filter(inStore);
      expect(stored.some((f) => readFileSync(f, 'utf8').includes(FAKE_CLIENT_SECRET))).toBe(true);
      expect([statSync(secretsDirOf(dataDir)).mode & 0o777, ...stored.map((f) => statSync(f).mode & 0o777)]).toEqual([0o700, ...stored.map(() => 0o600)]);
    }
  });
});
