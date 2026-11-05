/**
 * 로그인 전 길과 횟수 제한 (리드 결정 S3-11, SERVER_DESIGN 3.5 '로그인 전에 열린 메서드를 줄인다'·9.2):
 * - 1분 창마다 호출자 열쇠별 요청 수 — 세션 없는 요청은 Tailscale 사용자(없으면 이름 없는 쪽 하나)마다와 모두 합쳐, 기기 세션은 세션마다. 넘으면 429
 *   `rate_limited`와 Retry-After이고 처리하지 않는다. 로그인 전 쿠키(__Host-wos_login)를 바꿔 보내도 새 열쇠가 되지 않는다. 그 거부의 접근 줄은 모은다(S2-20)
 * - 세션 없는 SSE 연결은 모두 합쳐 상한까지
 * - 로그인 전의 system.prereqs는 60초에 한 번만 다시 확인하고(프로세스를 띄우지 않게) 되는지 여부만 준다 — 로그인한 대표는 예전 그대로 전체
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Clock } from '@core/time';
import type { PrereqStatus } from '@shared/views';
import { PUBLIC_PREREQS_TTL_MS } from '../../src/main/orchestrator/api';
import { startServer, type RunningServer } from '../../src/server/server';
import type { RateLimits } from '../../src/server/http';
import { LOGIN_COOKIE } from '../../src/server/sessions';
import { fakeServerBackend, httpCall, invokeHttp, memoryLogger, openSse, removeDir, sleep, type SseClient } from './helpers';
import { ownerServer, type OwnerServer } from './ownerServer';

const closers: (() => Promise<void> | void)[] = [];
afterAll(async () => {
  for (const c of closers.reverse()) await c();
});

async function open(rateLimits: Partial<RateLimits>) {
  const fake = fakeServerBackend();
  const dir = mkdtempSync(join(tmpdir(), 'wook-test-ratelimit-'));
  const log = memoryLogger();
  const server: RunningServer = await startServer({ backend: fake.backend, dataDir: dir, port: 0, allowTestSession: true, logger: log, version: 'test', rateLimits });
  closers.push(async () => {
    await server.close();
    fake.close();
    await removeDir(dir);
  });
  return { server, log, issue: () => fake.backend.operator.openTestSession().token };
}

const anon = (url: string, headers: Record<string, string> = {}) => invokeHttp(url, null, 'auth.getState', [], { headers });
const statuses = async (n: number, f: () => Promise<{ status: number }>) => {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push((await f()).status);
  return out;
};

describe('횟수 제한 (S3-11)', () => {
  it('세션 없는 요청은 열쇠(Tailscale 사용자, 없으면 이름 없는 쪽)마다 1분 상한 — 넘으면 429와 Retry-After, 다른 사용자는 따로. 로그인 전 쿠키를 바꿔도 피하지 못한다', async () => {
    const { server } = await open({ anonymousPerKey: 5, anonymousTotal: 1000 });
    expect(await statuses(5, () => anon(server.url))).toEqual([200, 200, 200, 200, 200]);
    const over = await anon(server.url);
    expect([over.status, over.json()]).toEqual([429, { ok: false, error: { code: 'rate_limited', message: '요청이 너무 잦습니다 — 잠시 뒤에 다시 해 주세요' } }]);
    expect(Number(over.headers['retry-after'])).toBeGreaterThan(0);
    expect(Number(over.headers['retry-after'])).toBeLessThanOrEqual(60);
    // 로그인 전 쿠키는 아무 값이나 지어 보낼 수 있다 — 열쇠가 되지 않는다
    expect((await anon(server.url, { Cookie: `${LOGIN_COOKIE}=made-up-value-1`, 'X-Wook-Client': '1', Origin: `http://127.0.0.1:${server.port}` })).status).toBe(429);
    // 다른 Tailscale 사용자는 따로 센다
    expect(await statuses(5, () => anon(server.url, { 'Tailscale-User-Login': 'phone@example.com' }))).toEqual([200, 200, 200, 200, 200]);
    expect((await anon(server.url, { 'Tailscale-User-Login': 'PHONE@example.com' })).status).toBe(429);
    // SSE·없는 경로도 같은 상한이다
    expect((await httpCall({ url: server.url, path: '/api/events' })).status).toBe(429);
  });

  it('세션 없는 요청은 모두 합친 상한도 있다 — Tailscale 머리를 바꿔 가며 보내도', async () => {
    const { server } = await open({ anonymousPerKey: 100, anonymousTotal: 6 });
    const got = await statuses(8, (() => {
      let i = 0;
      return () => anon(server.url, { 'Tailscale-User-Login': `user${i++}@example.com` });
    })());
    expect(got).toEqual([200, 200, 200, 200, 200, 200, 429, 429]);
  });

  it('기기 세션은 세션마다 센다 — 한 기기가 넘어도 다른 기기와 세션 없는 요청은 그대로', async () => {
    const { server, issue } = await open({ perSession: 3, anonymousPerKey: 100, anonymousTotal: 100 });
    const a = issue();
    const b = issue();
    expect(await statuses(4, () => invokeHttp(server.url, a, 'auth.getState'))).toEqual([200, 200, 200, 429]);
    expect((await invokeHttp(server.url, b, 'auth.getState')).status).toBe(200);
    expect((await anon(server.url)).status).toBe(200);
  });

  it('창이 끝나면 다시 받는다', async () => {
    const { server } = await open({ anonymousPerKey: 2, anonymousTotal: 100, windowMs: 400 });
    expect(await statuses(3, () => anon(server.url))).toEqual([200, 200, 429]);
    await sleep(500);
    expect((await anon(server.url)).status).toBe(200);
  });

  it('횟수 제한으로 거부한 요청의 접근 줄은 1분 창의 첫 줄 하나만 쓴다', async () => {
    const { server, log } = await open({ anonymousPerKey: 1, anonymousTotal: 1000 });
    await statuses(40, () => anon(server.url));
    expect(log.lines.filter((l) => l.includes('→ 429'))).toHaveLength(1);
  });

  it('세션 없는 SSE 연결은 모두 합쳐 상한까지 — 기기 세션의 연결은 따로', async () => {
    const { server, issue } = await open({ anonymousStreams: 2, anonymousPerKey: 100, anonymousTotal: 100 });
    const streams: SseClient[] = [];
    closers.push(() => streams.forEach((s) => s.close()));
    for (let i = 0; i < 2; i++) streams.push(await openSse(server.url, ''));
    expect(streams.map((s) => s.status)).toEqual([200, 200]);
    const third = await openSse(server.url, '');
    streams.push(third);
    expect(third.status).toBe(429);
    const withSession = await openSse(server.url, issue());
    streams.push(withSession);
    expect(withSession.status).toBe(200);
    // 하나가 닫히면 다시 열린다
    streams[0]!.close();
    await sleep(100);
    const again = await openSse(server.url, '');
    streams.push(again);
    expect(again.status).toBe(200);
  });
});

describe('로그인 전의 system.prereqs (S3-11)', () => {
  let s: OwnerServer;
  afterAll(async () => {
    await s?.close();
  });

  it('60초에 한 번만 다시 확인하고 되는지 여부만 준다 — 로그인한 대표는 그때 확인한 전체 상태', async () => {
    s = await ownerServer();
    // 시작 때의 CLI 확인이 끝난 뒤에 센다
    await s.h.waitFor(() => s.h.core.ctx.ai('claude').checkedAt !== null && s.h.core.ctx.ai('codex').checkedAt !== null, { label: '시작 때 CLI 확인' });
    const adapters = s.h.core.ctx.deps.adapters;
    let detects = 0;
    for (const kind of ['claude', 'codex'] as const) {
      const real = adapters[kind].detect.bind(adapters[kind]);
      adapters[kind] = { ...adapters[kind], detect: async () => (detects++, { ...(await real()), installed: true, version: '9.9.9', detail: `${kind} 설치 경로 C:/secret/${kind}.exe`, problem: null, loggedIn: true }) };
    }
    const real = s.h.core.ctx.clock;
    let shift = 0;
    (s.h.core.ctx as { clock: Clock }).clock = { ...real, ms: () => real.ms() + shift };
    const pre = async () => (await invokeHttp(s.server.url, null, 'system.prereqs')).json<{ ok: boolean; value: PrereqStatus }>();
    const first = await pre();
    for (let i = 0; i < 4; i++) await pre();
    expect(detects).toBe(2);
    expect(first).toMatchObject({ ok: true, value: { git: { version: null }, claude: { ok: true, version: null, loggedIn: null, detail: '' }, codex: { ok: true, version: null, loggedIn: null, detail: '' }, jobRunner: { detail: '' } } });
    expect(JSON.stringify(first).includes('secret')).toBe(false);
    shift = PUBLIC_PREREQS_TTL_MS - 1000;
    await pre();
    expect(detects).toBe(2);
    shift = PUBLIC_PREREQS_TTL_MS + 1000;
    await pre();
    expect(detects).toBe(4);
    // 로그인한 대표: 부를 때마다 확인한 전체 상태
    const full = (await invokeHttp(s.server.url, s.token, 'system.prereqs')).json<{ value: PrereqStatus }>();
    expect(full.value.claude).toMatchObject({ version: '9.9.9', detail: 'claude 설치 경로 C:/secret/claude.exe', loggedIn: true });
    expect(detects).toBe(6);
  });
});
