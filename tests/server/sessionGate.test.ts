/**
 * 기기 세션과 호출자 게이트 (SERVER_DESIGN 3.4·3.5, 리드 결정 S3-2·S3-3·S3-4): 서버 모드 백엔드(하네스 mode 'server')를 프로세스 안 서버로 연다.
 * - S3-2: 서버 모드는 kv `auth.session`을 읽지도 쓰지도 않고, 개발 모드 로그인·브라우저 로그인·전체 로그아웃이 없다. 호출자 없는 요청은 세션 없음
 * - S3-3: 호출자마다 로그인 상태(auth.getState·스냅숏의 auth). 세션 없는 호출자는 로그인 전 메서드만, 거부 기록을 쌓지 못한다. SSE는 연결마다
 *   그 호출자로 거른다 — 세션 없는 연결은 업무 내용을 뺀 스냅숏과 navigate·emergency·openSettings만, 알림·CLI 이벤트는 받지 못한다
 * - S3-4: 쿠키 `__Host-wos_session`과 Bearer, 쿠키를 실은 상태 변경은 `X-Wook-Client: 1`과 허용 Origin, 그 기기만 로그아웃, 기기 목록(이 기기 표시)과 끊기,
 *   끊긴 세션의 SSE 닫기, 대표가 바뀌면 옛 세션이 죽음, 운영자 시험 세션은 등록된 대표의 실제 기기 세션
 * - S3-31: 쿠키를 싣는 길(grantSession·newLoginKey)은 공개 주소의 Host로 온 요청에만 있다 — 루프백 Host면 쿠키를 싣지 않고 로그인을 받지 않는 까닭을 싣는다
 * 토큰은 시험 출력에 나오지 않게 다룬다 — expect의 실제 값에 토큰이 담긴 글을 넣지 않는다
 */
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OPERATOR, OWNER } from '@shared/domain';
import type { AppSnapshot, DeviceSessionView } from '@shared/views';
import { createHarness, type Harness } from '../e2e/harness';
import { buildOrchestratorDeps } from '../../src/main/backend/buildDeps';
import { deviceSessionView } from '../../src/main/auth/deviceSessions';
import { adminRequest } from '../../src/server/admin';
import { SETUP_NOT_DONE } from '../../src/main/orchestrator/serverLogin';
import type { RemoteCaller } from '../../src/main/backend/types';
import { createHttpSurface } from '../../src/server/http';
import { LOGIN_COOKIE, loopbackLoginRefusal, SESSION_COOKIE } from '../../src/server/sessions';
import { startServer, type RunningServer } from '../../src/server/server';
import { fakeTopicBackend, httpCall, invokeHttp, memoryLogger, memorySessions, openSse, remoteBackendOf, removeDir, sleep, type SseClient } from './helpers';

const PUBLIC_ORIGIN = 'https://wook-pc.tailnet-test.ts.net';
const PUBLIC_HOST = 'wook-pc.tailnet-test.ts.net';
let h: Harness;
let server: RunningServer;
/** 관리 채널이 낸 운영자 시험 세션 */
let operatorToken = '';
let operatorSessionId = '';
const issueRows: { actor: string; text: string }[] = [];
const sse: SseClient[] = [];

const rows = () => h.core.ctx.store.activity.search({ limit: 500 });
const kvAuthSessionRows = () => Number((h.core.ctx.store.db.prepare(`SELECT COUNT(*) AS c FROM kv WHERE key = 'auth.session'`).get() as { c: number }).c);
/** 하네스에서 바로 낸 기기 세션 (이름이 다른 기기들) */
const device = (name: string) => h.core.deviceSessions.issue({ deviceName: name, tailscaleLogin: `${name}@tailnet` });
const origin = () => `http://127.0.0.1:${server.port}`;
/** 브라우저처럼: 쿠키로 invoke (요청 ID는 부를 때마다 새로 — 같은 ID는 한 번만 처리한다, S3-9) */
let cookieSeq = 0;
const cookieInvoke = (token: string, method: string, args: unknown[] = [], headers: Record<string, string> = {}) =>
  httpCall({ url: server.url, path: '/api/invoke', method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: `${SESSION_COOKIE}=${token}`, ...headers }, body: JSON.stringify({ id: `c-${++cookieSeq}`, method, args }) });
const screen = () => ({ 'X-Wook-Client': '1', Origin: origin() });
const setCookies = (r: { headers: Record<string, string | string[] | undefined> }): string[] => {
  const v = r.headers['set-cookie'];
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
};
const errorCode = (r: { json<T>(): T }) => r.json<{ error?: { code: string } }>().error?.code;

beforeAll(async () => {
  h = await createHarness({ mode: 'server' });
  // 실제 대표가 등록된 서버 — 운영자 시험 세션은 이 대표의 기기 세션이다
  h.core.ctx.store.kv.set('owner', { sub: 'google-owner-sub', email: 'owner@example.com', name: '대표', registeredAt: h.core.ctx.now(), lastLoginAt: null });
  server = await startServer({ backend: remoteBackendOf(h), dataDir: h.dataDir, port: 0, allowTestSession: true, logger: memoryLogger(), version: 'test', publicOrigin: PUBLIC_ORIGIN, sse: { heartbeatMs: 100 } });
  const before = new Set(rows().map((e) => e.seq));
  const reply = await adminRequest({ dataDir: h.dataDir, command: 'session.test' });
  if (!reply.ok) throw new Error('운영자 시험 세션을 받지 못했습니다');
  const grant = reply.result as { token: string; sessionId: string; ownerCreated: boolean };
  operatorToken = grant.token;
  operatorSessionId = grant.sessionId;
  for (const e of rows()) if (!before.has(e.seq)) issueRows.push({ actor: e.actor, text: e.text });
  expect(grant.ownerCreated).toBe(false);
}, 120_000);

afterAll(async () => {
  for (const c of sse) c.close();
  await server?.close();
  await h?.close();
});

describe('서버 모드 백엔드 (S3-2)', () => {
  it('호출자 없는 요청은 세션 없는 원격 호출자다 — 로그인 전 상태만 보이고 업무 메서드는 unauthorized', async () => {
    await expect(h.invoke('auth.getState')).resolves.toMatchObject({ loggedIn: false, owner: null, mode: 'server', devLoginAllowed: false, googleSetupOpen: false, ownerRegistered: true });
    await expect(h.invoke('snapshot.get')).rejects.toMatchObject({ code: 'unauthorized' });
    // 버스 스냅숏의 auth도 세션 없는 상태다 — 연결마다 바꿔 보낸다(topicFor)
    expect(h.snapshot().auth).toMatchObject({ loggedIn: false, mode: 'server' });
    // 데스크톱 길의 로그인 전 구글 설정 길도 없다 — 세션 없는 원격 호출자라 운영자 로컬 메서드에 닿지 않는다
    expect(h.core.auth.googleSetupOpen()).toBe(true);
    await expect(h.invoke('settings.setGoogleSecret', 'google-secret-서버-0000')).rejects.toMatchObject({ code: 'unauthorized' });
    expect(h.core.ctx.settings().account.googleClientSecretSet).toBe(false);
  });

  it('로그인 확인은 넘긴 호출자의 세션이 지금 살아 있는지다 — 끊긴 세션의 화면 모양을 들고 와도 unauthorized', async () => {
    const gone = device('끊긴 기기');
    const caller = { surface: 'remote' as const, session: deviceSessionView(gone.session, gone.session.id), clientKey: 'session:끊긴' };
    await expect(h.orch.backend.invoke('auth.getState', [], caller)).resolves.toMatchObject({ loggedIn: true });
    h.core.deviceSessions.revoke(gone.session.id, OWNER);
    await expect(h.orch.backend.invoke('snapshot.get', [], caller)).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(h.orch.backend.invoke('auth.getState', [], caller)).resolves.toMatchObject({ loggedIn: false, owner: null });
  });

  it('개발 모드 로그인·이 PC의 브라우저 로그인·전체 로그아웃은 없고, kv auth.session은 한 번도 쓰이지 않는다', async () => {
    await expect(h.internal('auth.devLogin')).rejects.toMatchObject({ code: 'forbidden', message: '서버에는 개발 모드 로그인이 없습니다 — 기기 코드로 로그인합니다' });
    await expect(h.internal('auth.login')).rejects.toMatchObject({ code: 'forbidden', message: '서버에 접속한 화면은 이 PC의 브라우저 로그인을 쓰지 않습니다 — 기기 코드로 로그인합니다' });
    await expect(h.internal('auth.logout')).rejects.toMatchObject({ code: 'forbidden' });
    // kv에 대표 세션을 남겨 두어도 서버 모드는 읽지 않는다
    h.core.ctx.store.kv.set('auth.session', { sub: 'google-owner-sub', at: h.core.ctx.now() });
    try {
      expect(h.core.auth.isLoggedIn()).toBe(false);
      await expect(h.invoke('snapshot.get')).rejects.toMatchObject({ code: 'unauthorized' });
      expect((await invokeHttp(server.url, null, 'auth.getState')).json()).toMatchObject({ value: { loggedIn: false } });
    } finally {
      h.core.ctx.store.db.prepare(`DELETE FROM kv WHERE key = 'auth.session'`).run();
    }
    expect(kvAuthSessionRows()).toBe(0);
  });

  it('의존성 조립은 서버 모드면 넘긴 allowDevLogin과 상관없이 개발 모드 로그인을 끈다', async () => {
    const deps = await buildOrchestratorDeps({ dataDir: h.dataDir + '-deps', appRoot: process.cwd(), isPackaged: false, allowDevLogin: true, mode: 'server', nodeExecPath: process.execPath, nodeExecEnv: {}, shell: null, memorySecrets: true });
    try {
      expect([deps.mode, deps.allowDevLogin]).toEqual(['server', false]);
    } finally {
      deps.runner.dispose?.();
      deps.store.close();
      await removeDir(h.dataDir + '-deps');
    }
  });

  it('운영자 시험 세션은 등록된 대표의 실제 기기 세션이다 — 대표를 새로 만들지 않고, 활동 기록은 행위자 operator 한 줄 (S3-4)', () => {
    expect(issueRows).toEqual([{ actor: OPERATOR, text: '운영자 시험 세션 발급 (대표 owner@example.com)' }]);
    expect(h.core.deviceSessions.live(operatorSessionId)).toMatchObject({ deviceName: '운영자 시험 세션', ownerSub: 'google-owner-sub' });
    expect(h.core.auth.owner()).toMatchObject({ sub: 'google-owner-sub', email: 'owner@example.com' });
    expect(kvAuthSessionRows()).toBe(0);
  });
});

describe('세션 없는 호출자 (S3-3)', () => {
  it('로그인 전 메서드만 — 업무·기기 메서드와 데스크톱 로그인 길은 401이고 거부 기록이 쌓이지 않는다', async () => {
    const seq0 = rows()[0]?.seq ?? 0;
    const state = await invokeHttp(server.url, null, 'auth.getState');
    expect(state.status).toBe(200);
    expect(state.json()).toMatchObject({ ok: true, value: { loggedIn: false, owner: null, mode: 'server' } });
    for (const [method, args] of [
      ['snapshot.get', []],
      ['command.send', [{ target: 'main', text: '세션 없이 보낸 명령' }]],
      ['auth.listDevices', []],
      ['auth.revokeDevice', [operatorSessionId]],
      ['auth.logout', []],
      ['auth.login', []],
      ['auth.devLogin', []],
      ['settings.setApiKey', ['claude', 'sk-ant-세션없음-0000']],
    ] as const) {
      const r = await invokeHttp(server.url, null, method, [...args]);
      expect([r.status, errorCode(r)], method).toEqual([401, 'unauthorized']);
    }
    expect(rows().filter((e) => e.seq > seq0)).toEqual([]);
    expect(h.core.deviceSessions.live(operatorSessionId)).not.toBeNull();
  });

  it('원격 호출자에게 데스크톱 글을 보이지 않는다 — 대표 이메일이 정해지지 않은 서버는 기기 코드 로그인을 시작하지 않는다고 사실대로 (S3b — S3-6)', async () => {
    // 브라우저 로그인을 받는 공개 주소의 Host로 (S3-31 — 루프백 Host면 그 까닭이 먼저다)
    const r = await invokeHttp(server.url, null, 'auth.deviceLogin', ['휴대폰'], { headers: { Host: PUBLIC_HOST } });
    expect([r.status, errorCode(r)]).toEqual([409, 'not_configured']);
    expect(r.json<{ error: { message: string } }>().error.message).toBe(SETUP_NOT_DONE);
    expect(r.json<{ error: { message: string } }>().error.message.includes('데스크톱')).toBe(false);
  });
});

describe('연결마다 거르는 SSE와 호출자별 상태 (S3-3)', () => {
  let anon: SseClient;
  let owner: SseClient;

  beforeAll(async () => {
    anon = await openSse(server.url, '', '?members=M-MAIN');
    owner = await openSse(server.url, operatorToken, '?members=M-MAIN');
    sse.push(anon, owner);
  });

  it('세션 없는 연결도 열린다 — 첫 스냅숏은 업무 내용을 뺀 것이고 auth는 로그인 전, 세션 연결은 전부와 로그인한 auth', async () => {
    expect(anon.status).toBe(200);
    expect(owner.status).toBe(200);
    for (const c of [anon, owner]) await c.waitFor((ev) => ev.some((e) => e.event === 'snapshot'), '첫 스냅숏', 10_000);
    const first = (c: SseClient) => c.events.find((e) => e.event === 'snapshot')!.data.payload as AppSnapshot;
    expect(first(anon).auth).toMatchObject({ loggedIn: false, owner: null, mode: 'server' });
    expect(first(anon).projects).toEqual([]);
    expect(first(anon).members).toEqual([]);
    expect(first(owner).auth).toMatchObject({ loggedIn: true, owner: { email: 'owner@example.com' }, mode: 'server' });
    expect(first(owner).projects.map((p) => p.id)).toEqual([h.projectId]);
  });

  it('알림·CLI 이벤트는 세션 연결에만, navigate·emergency·openSettings는 둘 다, 버스 스냅숏의 auth는 그 연결의 것', async () => {
    const mark = anon.events.length;
    const markOwner = owner.events.length;
    h.core.ctx.notify({ level: 'normal', title: '세션 연결만 받는 알림', body: '본문' });
    h.core.ctx.bus.emit('cliEvents', { memberId: 'M-MAIN', turnId: 'TN-1', events: [] });
    h.core.ctx.bus.emit('navigate', { tab: 'home' } as never);
    h.core.ctx.bus.emit('openSettings', { section: 'account' });
    await owner.waitFor((ev) => ev.slice(markOwner).some((e) => e.event === 'openSettings') && ev.slice(markOwner).some((e) => e.event === 'snapshot'), '세션 연결의 토픽', 10_000);
    await anon.waitFor((ev) => ev.slice(mark).some((e) => e.event === 'openSettings') && ev.slice(mark).some((e) => e.event === 'snapshot'), '세션 없는 연결의 토픽', 10_000);
    await sleep(100);
    const topics = (c: SseClient, from: number) => [...new Set(c.events.slice(from).map((e) => e.event))].sort();
    expect(topics(owner, markOwner)).toEqual(['cliEvents', 'navigate', 'notification', 'openSettings', 'snapshot']);
    expect(topics(anon, mark)).toEqual(['navigate', 'openSettings', 'snapshot']);
    const lastSnap = (c: SseClient) => c.events.filter((e) => e.event === 'snapshot').at(-1)!.data.payload as AppSnapshot;
    expect([lastSnap(anon).auth.loggedIn, lastSnap(anon).recentActivity, lastSnap(anon).notifications.unread]).toEqual([false, [], 0]);
    expect(lastSnap(owner).auth.loggedIn).toBe(true);
    expect(lastSnap(owner).notifications.unread).toBeGreaterThan(0);
  });

  it('auth.getState와 snapshot.get은 부른 호출자의 상태다', async () => {
    expect((await invokeHttp(server.url, operatorToken, 'auth.getState')).json()).toMatchObject({ value: { loggedIn: true, owner: { email: 'owner@example.com' } } });
    const snap = (await invokeHttp(server.url, operatorToken, 'snapshot.get')).json<{ value: AppSnapshot }>().value;
    expect(snap.auth).toMatchObject({ loggedIn: true, mode: 'server' });
    expect((await invokeHttp(server.url, null, 'auth.getState')).json()).toMatchObject({ value: { loggedIn: false } });
  });
});

describe('쿠키 __Host-wos_session과 CSRF 막기 (S3-4)', () => {
  it('쿠키로 온 상태 변경은 X-Wook-Client: 1과 허용 Origin(루프백·공개 주소)이 있으면 된다 — 하나라도 없으면 403이고 처리하지 않는다', async () => {
    const phone = device('휴대폰-쿠키');
    const ok = await cookieInvoke(phone.token, 'auth.getState', [], screen());
    expect([ok.status, ok.json<{ value: { loggedIn: boolean } }>().value.loggedIn]).toEqual([200, true]);
    expect((await cookieInvoke(phone.token, 'auth.getState', [], { 'X-Wook-Client': '1', Origin: PUBLIC_ORIGIN })).status).toBe(200);
    const seq0 = rows()[0]?.seq ?? 0;
    for (const [label, headers] of [
      ['X-Wook-Client 없음', { Origin: origin() }],
      ['Origin 없음', { 'X-Wook-Client': '1' }],
      ['다른 Origin', { 'X-Wook-Client': '1', Origin: 'https://evil.example' }],
      ['다른 포트', { 'X-Wook-Client': '1', Origin: `http://127.0.0.1:${server.port + 1}` }],
    ] as const) {
      const r = await cookieInvoke(phone.token, 'auth.logout', [], headers);
      expect([r.status, errorCode(r)], label).toEqual([403, 'forbidden_origin']);
    }
    // 로그아웃은 처리되지 않았다
    expect(h.core.deviceSessions.live(phone.session.id)).not.toBeNull();
    expect(rows().filter((e) => e.seq > seq0)).toEqual([]);
  });

  it('쿠키만으로 SSE가 열린다(GET은 상태 변경이 아니다) — 그 기기의 스냅숏', async () => {
    const tablet = device('태블릿');
    const c = await openSseWithCookie(tablet.token);
    sse.push(c);
    expect(c.status).toBe(200);
    await c.waitFor((ev) => ev.some((e) => e.event === 'snapshot'), '첫 스냅숏', 10_000);
    expect((c.events.find((e) => e.event === 'snapshot')!.data.payload as AppSnapshot).auth.loggedIn).toBe(true);
  });

  it('끝난 쿠키는 세션 없는 호출자로 받고 지운다 — 로그인 화면에 다시 들어올 수 있게', async () => {
    const r = await cookieInvoke(`wos_${'Z'.repeat(43)}`, 'auth.getState', [], screen());
    expect(r.status).toBe(200);
    expect(r.json()).toMatchObject({ value: { loggedIn: false } });
    expect(setCookies(r)).toEqual([`${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`]);
  });

  it('쿠키 없이 브라우저가 Origin을 붙인 상태 변경도 허용 Origin이어야 한다 — Origin 없는 운영자 도구(curl)와 Bearer는 그대로', async () => {
    const evil = await httpCall({ url: server.url, path: '/api/invoke', method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{"id":"1","method":"auth.getState","args":[]}' });
    expect([evil.status, errorCode(evil)]).toEqual([403, 'forbidden_origin']);
    expect((await invokeHttp(server.url, null, 'auth.getState')).status).toBe(200);
    expect((await invokeHttp(server.url, operatorToken, 'auth.getState', [], { headers: { Origin: 'https://evil.example' } })).status).toBe(200);
  });
});

describe('그 기기만 로그아웃, 기기 목록과 끊기 (S3-4)', () => {
  it('쿠키로 로그아웃하면 그 기기 세션만 끊기고 쿠키를 지운다 — 다른 기기는 그대로, 그 기기의 SSE는 닫힌다', async () => {
    const laptop = device('노트북');
    const stream = await openSseWithCookie(laptop.token);
    sse.push(stream);
    await stream.waitFor((ev) => ev.some((e) => e.event === 'snapshot'), '첫 스냅숏', 10_000);
    const r = await cookieInvoke(laptop.token, 'auth.logout', [], screen());
    expect(r.status).toBe(200);
    expect(r.json()).toMatchObject({ ok: true, value: { loggedIn: false, owner: null } });
    expect(setCookies(r)).toEqual([`${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`]);
    expect((await invokeHttp(server.url, laptop.token, 'auth.getState')).status).toBe(401);
    expect((await invokeHttp(server.url, operatorToken, 'auth.getState')).json()).toMatchObject({ value: { loggedIn: true } });
    await sleep(200);
    expect(stream.ended()).toBe(true);
    expect(rows().map((e) => ({ actor: e.actor, text: e.text }))).toContainEqual({ actor: OWNER, text: '대표 로그아웃 — 이 기기(노트북)만 (다른 기기와 진행 중인 작업은 그대로)' });
    expect(kvAuthSessionRows()).toBe(0);
  });

  it('auth.listDevices는 살아 있는 세션만, 부른 기기를 표시하고, 토큰·해시를 담지 않는다', async () => {
    const r = await invokeHttp(server.url, operatorToken, 'auth.listDevices');
    expect(r.status).toBe(200);
    const list = r.json<{ value: DeviceSessionView[] }>().value;
    expect(list.filter((d) => d.current).map((d) => d.id)).toEqual([operatorSessionId]);
    expect(list.map((d) => d.deviceName)).toContain('운영자 시험 세션');
    expect(list.map((d) => d.deviceName)).not.toContain('노트북');
    for (const d of list) expect(Object.keys(d).sort()).toEqual(['createdAt', 'current', 'deviceName', 'expiresAt', 'id', 'lastUsedAt', 'tailscaleLogin']);
    expect(/wos_|[0-9a-f]{64}/.test(r.text)).toBe(false);
  });

  it('auth.revokeDevice는 다른 기기를 끊는다 — 그 기기의 SSE가 닫히고 토큰은 401, 목록에서 빠진다. 없는 ID는 404, 모양이 틀리면 400', async () => {
    const lost = device('잃어버린 휴대폰');
    const stream = await openSse(server.url, lost.token);
    sse.push(stream);
    await stream.waitFor((ev) => ev.some((e) => e.event === 'snapshot'), '첫 스냅숏', 10_000);
    const r = await invokeHttp(server.url, operatorToken, 'auth.revokeDevice', [lost.session.id]);
    expect(r.status).toBe(200);
    expect(r.json<{ value: DeviceSessionView[] }>().value.map((d) => d.id)).not.toContain(lost.session.id);
    await sleep(200);
    expect(stream.ended()).toBe(true);
    expect((await invokeHttp(server.url, lost.token, 'auth.getState')).status).toBe(401);
    expect(rows().map((e) => ({ actor: e.actor, text: e.text }))).toContainEqual({ actor: OWNER, text: '기기 세션 끊음: 잃어버린 휴대폰' });
    const missing = await invokeHttp(server.url, operatorToken, 'auth.revokeDevice', [lost.session.id]);
    expect([missing.status, errorCode(missing)]).toEqual([404, 'not_found']);
    const bad = await invokeHttp(server.url, operatorToken, 'auth.revokeDevice', [42]);
    expect([bad.status, errorCode(bad)]).toEqual([400, 'invalid_args']);
  });

  it('이 기기를 끊으면(쿠키) 쿠키도 지운다', async () => {
    const self = device('스스로 끊는 기기');
    const r = await cookieInvoke(self.token, 'auth.revokeDevice', [self.session.id], screen());
    expect(r.status).toBe(200);
    expect(setCookies(r)).toEqual([`${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`]);
    expect(rows().map((e) => e.text)).toContain('기기 세션 끊음: 스스로 끊는 기기 (이 기기)');
  });
});

describe('대표가 바뀌면 (S3-3·S3-4)', () => {
  it('그 앞의 세션은 살아 있지 않다 — 토큰은 401이고 열린 SSE는 살아 있음 신호 때 닫힌다', async () => {
    const stream = await openSse(server.url, operatorToken);
    sse.push(stream);
    await stream.waitFor((ev) => ev.some((e) => e.event === 'snapshot'), '첫 스냅숏', 10_000);
    h.core.ctx.store.kv.set('owner', { sub: 'another-owner-sub', email: 'another@example.com', name: '다른 대표', registeredAt: h.core.ctx.now(), lastLoginAt: null });
    expect((await invokeHttp(server.url, operatorToken, 'auth.getState')).status).toBe(401);
    await sleep(400);
    expect(stream.ended()).toBe(true);
  });
});

describe('세션 쿠키 싣기 (S3-5 준비 — RemoteCaller.grantSession)', () => {
  it('대표 확인을 마친 처리가 grantSession을 부르면 그 응답에 세션 쿠키가 실린다 — 본문에는 토큰이 없다', async () => {
    const fake = fakeTopicBackend();
    const mem = memorySessions();
    const issued = { token: '' };
    fake.backend.invoke = (async (_m: string, _a: unknown[], caller?: { grantSession?: (g: { token: string; absoluteExpiresAt: string }) => void }) => {
      const { token, session } = mem.sessions.issue({ deviceName: '새 기기' });
      issued.token = token;
      caller?.grantSession?.({ token, absoluteExpiresAt: session.absoluteExpiresAt });
      return { status: 'ok' };
    }) as never;
    let port = 0;
    // 쿠키는 공개 주소의 Host로 온 요청에만 싣는다 (S3-31) — tailscale serve처럼 그 Host를 루프백 소켓에 보낸다
    const surface = createHttpSurface({ backend: fake.backend, sessions: mem.sessions, publicOrigin: PUBLIC_ORIGIN, logger: memoryLogger(), runId: 'run', port: () => port, webDir: null });
    const srv: Server = createServer((req, res) => surface.handle(req, res));
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    port = (srv.address() as { port: number }).port;
    try {
      const r = await invokeHttp(`http://127.0.0.1:${port}`, null, 'auth.deviceLoginPoll', ['login-1'], { headers: { Host: PUBLIC_HOST } });
      expect(r.status).toBe(200);
      const cookies = setCookies(r);
      expect(cookies).toHaveLength(1);
      expect(cookies[0]!.startsWith(`${SESSION_COOKIE}=${issued.token};`)).toBe(true);
      // 브라우저에서 사는 시간은 세션의 최대 만료(90일)까지
      expect(cookies[0]!.slice(cookies[0]!.indexOf(';'))).toMatch(/^; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=(7775\d{3}|7776000)$/);
      expect(r.text.includes(issued.token)).toBe(false);
      // 그 쿠키로 바로 세션이 된다
      expect(mem.sessions.verify(issued.token)).not.toBeNull();
    } finally {
      surface.dispose();
      srv.closeAllConnections();
      await new Promise<void>((r) => srv.close(() => r()));
      mem.close();
    }
  });

  it('루프백 Host(127.0.0.1·localhost·[::1])로 온 요청에는 세션 쿠키도 로그인 전 쿠키도 싣지 않는다 — 호출자에 그 길이 없고 되는 길을 말하는 까닭이 실린다 (S3-31)', async () => {
    const fake = fakeTopicBackend();
    const mem = memorySessions();
    const seen: RemoteCaller[] = [];
    // 백엔드가 무엇을 하든(세션 쿠키·로그인 전 쿠키를 싣는 길을 다 불러도) HTTP 층이 루프백 Host에는 쿠키를 싣지 않는다
    fake.backend.invoke = (async (_m: string, _a: unknown[], caller?: RemoteCaller) => {
      seen.push(caller!);
      const { token, session } = mem.sessions.issue({ deviceName: '새 기기' });
      caller?.grantSession?.({ token, absoluteExpiresAt: session.absoluteExpiresAt });
      caller?.newLoginKey?.();
      return { status: 'ok' };
    }) as never;
    let port = 0;
    let publicOrigin: string | null = PUBLIC_ORIGIN;
    const surface = createHttpSurface({
      backend: fake.backend,
      sessions: mem.sessions,
      access: () => ({ publicOrigin, tailscaleLogins: null }),
      logger: memoryLogger(),
      runId: 'run',
      port: () => port,
      webDir: null,
    });
    const srv: Server = createServer((req, res) => surface.handle(req, res));
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    port = (srv.address() as { port: number }).port;
    const poll = (host: string) => invokeHttp(`http://127.0.0.1:${port}`, null, 'auth.deviceLoginPoll', ['login-1'], { headers: { Host: host } });
    try {
      for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, `LOCALHOST:${port}`]) {
        const r = await poll(host);
        expect([r.status, setCookies(r)], host).toEqual([200, []]);
        const c = seen.at(-1)!;
        expect([c.grantSession, c.newLoginKey, c.loginRefusal], host).toEqual([undefined, undefined, loopbackLoginRefusal(PUBLIC_ORIGIN)]);
      }
      expect(loopbackLoginRefusal(PUBLIC_ORIGIN)).toBe(
        '이 PC 안의 주소로는 브라우저 로그인을 받지 않습니다. 같은 PC의 다른 프로그램이 로그인 쿠키를 받아 갈 수 있기 때문입니다. 공개 주소(https://wook-pc.tailnet-test.ts.net)로 여세요.',
      );
      // 공개 주소의 Host면 두 쿠키가 실린다 (대조)
      const pub = await poll(PUBLIC_HOST);
      expect(setCookies(pub).map((x) => x.slice(0, x.indexOf('=')))).toEqual([SESSION_COOKIE, LOGIN_COOKIE]);
      expect(seen.at(-1)!.loginRefusal).toBeUndefined();
      // 공개 주소가 없는 서버는 그 주소를 정하라고 말한다
      publicOrigin = null;
      const none = await poll(`127.0.0.1:${port}`);
      expect([none.status, setCookies(none), seen.at(-1)!.loginRefusal]).toEqual([
        200,
        [],
        '브라우저 로그인은 공개 주소에서만 받습니다. 서버 PC의 server.json에 network.publicOrigin(tailscale serve 주소)을 정한 뒤 그 주소로 여세요.',
      ]);
      // 끝난 세션 쿠키 지우기(Max-Age=0)는 루프백 Host에서도 된다
      const gone = await httpCall({
        url: `http://127.0.0.1:${port}`,
        path: '/api/invoke',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: `${SESSION_COOKIE}=wos_${'Q'.repeat(43)}`, 'X-Wook-Client': '1', Origin: `http://127.0.0.1:${port}` },
        body: '{"id":"x","method":"auth.getState","args":[]}',
      });
      expect(setCookies(gone)).toEqual([`${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`]);
    } finally {
      surface.dispose();
      srv.closeAllConnections();
      await new Promise<void>((r) => srv.close(() => r()));
      mem.close();
    }
  });
});

/** 쿠키로 GET /api/events (브라우저 EventSource처럼 — 머리를 더하지 않는다) */
function openSseWithCookie(token: string): Promise<SseClient> {
  return openSse(server.url, '', '', { Cookie: `${SESSION_COOKIE}=${token}` });
}
