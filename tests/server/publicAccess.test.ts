/**
 * 공개 주소와 Tailscale 사용자 검사 (리드 결정 S3-7, SERVER_DESIGN 3.4·3.6): 가짜 백엔드(메모리 기기 세션)를 연 프로세스 안 서버.
 * - 공개 주소(--public-origin·server.json network.publicOrigin)의 Host를 받는다 — 이름과 포트를 통째로 견주고, 닮은 다른 이름은 403 (S2-17과 같다)
 * - 쿠키를 실은 상태 변경은 공개 주소나 루프백 주소의 Origin과 X-Wook-Client가 있어야 한다 — Origin이 없으면 403
 * - 받는 Tailscale 사용자 목록이 있으면 머리가 없거나 목록 밖인 요청은 로그인 전에 403 — 세션을 보지 않고, 접근 줄은 모은다. 목록이 비면 보지 않는다
 * - 운영자 설정을 고치고 config reload하면 다음 요청부터 따른다. 모양이 틀린 공개 주소는 인자·파일·startServer 모두 거부한다
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { adminRequest } from '../../src/server/admin';
import { parseCli } from '../../src/server/cli';
import { createOperatorConfig, readServerConfig } from '../../src/server/config';
import { startServer, ServerStartError, type RunningServer } from '../../src/server/server';
import { parsePublicOrigin, SESSION_COOKIE } from '../../src/server/sessions';
import { fakeServerBackend, httpCall, memoryLogger, openSse, removeDir } from './helpers';

const PUBLIC = 'https://grok-pc.tailnet-test.ts.net';
const closers: (() => Promise<void> | void)[] = [];
afterAll(async () => {
  for (const c of closers.reverse()) await c();
});

async function open(o: { publicOrigin?: string | null; tailscaleLogins?: string[] | null; withConfig?: boolean } = {}) {
  const fake = fakeServerBackend();
  const dir = mkdtempSync(join(tmpdir(), 'wook-test-public-'));
  const log = memoryLogger();
  const configPath = join(dir, 'server.json');
  const operatorConfig = o.withConfig ? createOperatorConfig({ path: configPath, ownerEmailFlag: null, operator: fake.backend.operator, logger: log }) : undefined;
  const server: RunningServer = await startServer({
    backend: fake.backend,
    dataDir: dir,
    port: 0,
    allowTestSession: true,
    logger: log,
    version: 'test',
    ...(o.publicOrigin !== undefined ? { publicOrigin: o.publicOrigin } : {}),
    ...(o.tailscaleLogins !== undefined ? { tailscaleLogins: o.tailscaleLogins } : {}),
    ...(operatorConfig ? { operatorConfig } : {}),
  });
  closers.push(async () => {
    await server.close();
    fake.close();
    await removeDir(dir);
  });
  const token = fake.backend.operator.openTestSession().token;
  return { server, token, log, dir, configPath, fake };
}

const getState = (url: string, headers: Record<string, string>) =>
  httpCall({ url, path: '/api/invoke', method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: '{"id":"1","method":"auth.getState","args":[]}' });
const code = (r: { json<T>(): T }) => r.json<{ error?: { code: string } }>().error?.code;

describe('공개 주소의 Host와 Origin (S3-7)', () => {
  it('공개 주소의 Host를 받는다(기본 포트를 적은 것도) — 닮은 다른 이름·다른 포트·사용자 정보는 403이고, 공개 주소가 없는 서버는 그 Host를 받지 않는다', async () => {
    const { server } = await open({ publicOrigin: PUBLIC });
    for (const host of ['grok-pc.tailnet-test.ts.net', 'GROK-PC.tailnet-test.ts.net', 'grok-pc.tailnet-test.ts.net:443']) {
      expect((await getState(server.url, { Host: host })).status, host).toBe(200);
      expect((await httpCall({ url: server.url, path: '/', headers: { Host: host } })).status, host).toBe(200);
    }
    for (const host of ['grok-pc.tailnet-test.ts.net.evil.test', 'evil-grok-pc.tailnet-test.ts.net', 'grok-pc.tailnet-test.ts.net:8443', 'x@grok-pc.tailnet-test.ts.net', 'tailnet-test.ts.net']) {
      const r = await getState(server.url, { Host: host });
      expect([r.status, code(r)], host).toEqual([403, 'forbidden_host']);
    }
    const plain = await open();
    expect(code(await getState(plain.server.url, { Host: 'grok-pc.tailnet-test.ts.net' }))).toBe('forbidden_host');
  });

  it('쿠키를 실은 상태 변경은 공개 주소의 Origin이면 받고, Origin이 없거나 다른 주소면 403 — Bearer는 Origin과 상관없다', async () => {
    const { server, token } = await open({ publicOrigin: PUBLIC });
    const cookie = { Cookie: `${SESSION_COOKIE}=${token}`, 'X-Wook-Client': '1', Host: 'grok-pc.tailnet-test.ts.net' };
    expect((await getState(server.url, { ...cookie, Origin: PUBLIC })).status).toBe(200);
    expect((await getState(server.url, { ...cookie, Origin: `http://127.0.0.1:${server.port}` })).status).toBe(200);
    for (const origin of [undefined, 'https://evil.example', 'http://grok-pc.tailnet-test.ts.net', `${PUBLIC}:8443`]) {
      const r = await getState(server.url, { ...cookie, ...(origin ? { Origin: origin } : {}) });
      expect([r.status, code(r)], String(origin)).toEqual([403, 'forbidden_origin']);
    }
    expect((await getState(server.url, { Authorization: `Bearer ${token}` })).status).toBe(200);
  });

  it('모양이 틀린 공개 주소는 받지 않는다 — 서버 인자(--public-origin)·server.json·startServer', async () => {
    for (const bad of ['http://grok-pc.ts.net', 'https://grok-pc.ts.net/app', 'https://grok-pc.ts.net/?x=1', 'https://u:p@grok-pc.ts.net', 'grok-pc.ts.net', 'https://grok-pc.ts.net/#a']) {
      expect(parsePublicOrigin(bad).ok, bad).toBe(false);
      expect(parseCli(['serve', '--public-origin', bad], {}, 'win32').kind, bad).toBe('error');
    }
    expect(parsePublicOrigin('https://GROK-PC.tailnet.ts.net/')).toEqual({ ok: true, origin: 'https://grok-pc.tailnet.ts.net' });
    expect(parseCli(['serve', '--public-origin', 'https://GROK-PC.tailnet.ts.net'], {}, 'win32')).toMatchObject({ kind: 'serve', options: { publicOrigin: 'https://grok-pc.tailnet.ts.net' } });
    // 운영자 명령에는 서버 인자를 쓰지 않는다
    expect(parseCli(['status', '--public-origin', PUBLIC], {}, 'win32')).toMatchObject({ kind: 'error' });
    const dir = mkdtempSync(join(tmpdir(), 'wook-test-public-cfg-'));
    closers.push(() => removeDir(dir));
    const file = join(dir, 'server.json');
    writeFileSync(file, JSON.stringify({ network: { publicOrigin: 'http://grok-pc.ts.net' } }));
    expect(readServerConfig(file)).toMatchObject({ ok: false, message: expect.stringContaining('network.publicOrigin — 공개 주소는 https여야 합니다') });
    writeFileSync(file, JSON.stringify({ owner: { tailscaleLogins: ['a@b.com, c@d.com'] } }));
    expect(readServerConfig(file).ok).toBe(false);
    writeFileSync(file, JSON.stringify({ network: { publicOrigin: 'https://GROK-PC.ts.net' }, owner: { tailscaleLogins: [' Owner@Example.com '] } }));
    expect(readServerConfig(file)).toMatchObject({ ok: true, config: { network: { publicOrigin: 'https://grok-pc.ts.net' }, owner: { tailscaleLogins: ['Owner@Example.com'] } } });
    const fake = fakeServerBackend();
    closers.push(() => fake.close());
    await expect(startServer({ backend: fake.backend, dataDir: dir, port: 0, allowTestSession: false, logger: memoryLogger(), version: 'test', publicOrigin: 'http://x.ts.net' })).rejects.toBeInstanceOf(ServerStartError);
  });
});

describe('Tailscale 사용자 검사 (S3-7·3.6)', () => {
  it('목록이 있으면 머리가 없거나 목록 밖인 요청은 로그인 전에 403이다 — API·SSE·화면 모두, 맞는 토큰을 실어도. 대소문자는 가리지 않는다', async () => {
    const { server, token, fake } = await open({ publicOrigin: PUBLIC, tailscaleLogins: ['owner@example.com'] });
    const verify = fake.backend.sessions.verify.bind(fake.backend.sessions);
    let verified = 0;
    (fake.backend.sessions as { verify: typeof verify }).verify = (t) => {
      verified++;
      return verify(t);
    };
    for (const who of [undefined, 'someone@example.com', 'owner@example.com.evil']) {
      const h: Record<string, string> = who ? { 'Tailscale-User-Login': who } : {};
      const api = await getState(server.url, { Authorization: `Bearer ${token}`, ...h });
      expect([api.status, code(api)], String(who)).toEqual([403, 'forbidden_tailscale_user']);
      const page = await httpCall({ url: server.url, path: '/', headers: h });
      expect([page.status, page.text], String(who)).toEqual([403, '이 서버가 받는 Tailscale 사용자의 요청이 아닙니다 (Tailscale-User-Login)']);
      const sse = await openSse(server.url, token, '', h);
      expect(sse.status).toBe(403);
      sse.close();
    }
    // 세션을 보기 전에 거른다
    expect(verified).toBe(0);
    for (const who of ['owner@example.com', 'OWNER@Example.COM']) {
      expect((await getState(server.url, { Authorization: `Bearer ${token}`, 'Tailscale-User-Login': who })).json()).toMatchObject({ ok: true, value: { loggedIn: true } });
    }
  });

  it('목록이 비었거나 없으면 보지 않는다', async () => {
    for (const tailscaleLogins of [[], null]) {
      const { server } = await open({ tailscaleLogins });
      expect((await getState(server.url, {})).status, JSON.stringify(tailscaleLogins)).toBe(200);
    }
  });

  it('거부한 요청의 접근 줄은 모은다 — 1분 창의 첫 줄 하나, 그 뒤는 그 종류의 수 한 줄', async () => {
    const { server, log } = await open({ tailscaleLogins: ['owner@example.com'] });
    for (let i = 0; i < 30; i++) await getState(server.url, { 'Tailscale-User-Login': `x${i}@example.com` });
    expect(log.lines.filter((l) => l.includes('Tailscale 사용자 거부'))).toHaveLength(1);
    // 닫을 때 남은 수 — 그 종류의 이름으로
    await server.close();
    expect(log.lines.filter((l) => /HTTP: Tailscale 사용자 검사에서 거부한 요청이 지난 .+ 동안 29번 더 있었습니다/.test(l))).toHaveLength(1);
  });
});

describe('운영자 설정을 다시 읽으면 바로 따른다 (S3-7·S3-8)', () => {
  it('server.json의 공개 주소·Tailscale 사용자를 config reload가 바꾼다 — 서버를 다시 시작하지 않는다', async () => {
    const { server, configPath, dir } = await open({ withConfig: true });
    const host = { Host: 'pc.tailnet-test.ts.net' };
    expect(code(await getState(server.url, host))).toBe('forbidden_host');
    writeFileSync(configPath, JSON.stringify({ network: { publicOrigin: 'https://pc.tailnet-test.ts.net' }, owner: { tailscaleLogins: ['owner@example.com'] } }));
    expect(await adminRequest({ dataDir: dir, command: 'config.reload' })).toMatchObject({ ok: true });
    expect(code(await getState(server.url, host))).toBe('forbidden_tailscale_user');
    expect((await getState(server.url, { ...host, 'Tailscale-User-Login': 'owner@example.com' })).status).toBe(200);
    const shown = await adminRequest({ dataDir: dir, command: 'config.show' });
    expect(shown).toMatchObject({ ok: true, result: { access: { publicOrigin: 'https://pc.tailnet-test.ts.net', publicOriginSource: 'config', tailscaleLogins: ['owner@example.com'] } } });
    writeFileSync(configPath, JSON.stringify({ owner: { tailscaleLogins: [] } }));
    expect(await adminRequest({ dataDir: dir, command: 'config.reload' })).toMatchObject({ ok: true });
    expect(code(await getState(server.url, host))).toBe('forbidden_host');
    expect((await getState(server.url, {})).status).toBe(200);
  });
});
