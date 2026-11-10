/**
 * 운영자 설정과 운영자 명령 (SERVER_DESIGN 3.2·3.7, 리드 결정 S3-8): server.json 읽기, 파일 값이 DB 값을 덮어쓰고 덮어쓴 것마다 활동 기록(행위자 operator),
 * 관리 채널 config show|reload|owner-email|google-client-id와 secret set|clear google-client-secret. 서버 모드 하네스(비밀 값은 메모리)를 감싼 프로세스 안
 * 서버로 본다 — 관리 채널은 서로 증명한 뒤에 쓴다(adminRequest, S3-16).
 * 비밀 값은 시험 출력에 내지 않는다 — 참거짓으로만 본다
 */
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OPERATOR } from '@shared/domain';
import { createHarness, type Harness } from '../e2e/harness';
import { adminRequest, type AdminReply } from '../../src/server/admin';
import { formatConfig } from '../../src/server/cli';
import { createOperatorConfig, parseServerConfig, readServerConfig, type ServerConfigView } from '../../src/server/config';
import { startServer, type RunningServer } from '../../src/server/server';
import { memoryLogger, remoteBackendOf, removeDir, windowsAcl, windowsMe } from './helpers';

const CLIENT_ID = '424242-tvclient.apps.googleusercontent.com';
const SECRET = 'GOCSPX-operator-config-secret-91b2';
let h: Harness;
let server: RunningServer;
let dir = '';
let configPath = '';
const log = memoryLogger();
const replies: string[] = [];

beforeAll(async () => {
  h = await createHarness({ mode: 'server', noProject: true });
  dir = mkdtempSync(join(tmpdir(), 'wook-test-opconfig-'));
  configPath = join(dir, 'server.json');
  const backend = remoteBackendOf(h);
  const operatorConfig = createOperatorConfig({ path: configPath, ownerEmailFlag: null, operator: backend.operator, logger: log });
  server = await startServer({ backend, dataDir: h.dataDir, port: 0, allowTestSession: false, logger: log, version: 'test', operatorConfig });
}, 120_000);

afterAll(async () => {
  await server?.close();
  await h?.close();
  if (dir) await removeDir(dir);
});

async function admin(command: Parameters<typeof adminRequest>[0]['command'], args?: string[], secret?: string): Promise<AdminReply> {
  const r = await adminRequest({ dataDir: h.dataDir, command, ...(args ? { args } : {}), ...(secret !== undefined ? { secret } : {}) });
  replies.push(JSON.stringify(r));
  return r;
}
const operatorRows = () => h.core.ctx.store.activity.search({ limit: 500 }).filter((e) => e.actor === OPERATOR).map((e) => e.text);
const writeConfig = (v: unknown): void => writeFileSync(configPath, typeof v === 'string' ? v : JSON.stringify(v, null, 2));

describe('server.json 읽기 (3.7)', () => {
  it('없으면 빈 설정, 있으면 문서의 예 그대로 읽는다', () => {
    expect(readServerConfig(join(dir, '없는.json'))).toMatchObject({ ok: true, exists: false, warnings: [] });
    const example = {
      owner: { email: 'owner@example.com', tailscaleLogins: [] },
      google: { clientId: CLIENT_ID },
      seat: { initialHolder: 'external:X-0001', holders: ['launched:claude', 'launched:codex', 'external:*'] },
      cli: { claudePath: null, codexPath: null },
      network: { bind: '127.0.0.1', port: 7317, publicOrigin: 'https://grok-pc.example.ts.net' },
      workspaceRoot: 'D:/wook-workspace',
      screen: { enabled: true },
    };
    expect(parseServerConfig(example)).toEqual({
      config: {
        owner: { email: 'owner@example.com', tailscaleLogins: [] },
        google: { clientId: CLIENT_ID },
        cli: { claudePath: null, codexPath: null },
        network: { bind: '127.0.0.1', port: 7317, publicOrigin: 'https://grok-pc.example.ts.net' },
        // 메인 자리는 칸마다 읽는다 (S4-12) — 적지 않은 drainMs는 null. 외부 처음 보유자는 모양으로는 받고 값 확인(serverConfigValueError)이 거부한다
        seat: { ...example.seat, drainMs: null },
        workspaceRoot: 'D:/wook-workspace',
        // 화면 조작 (리드 결정 S6-11) — false면 끈다, 칸이 없으면 null(쓴다)
        screen: { enabled: true },
      },
      warnings: [],
    });
    expect(parseServerConfig({}).config.screen).toEqual({ enabled: null });
  });

  it('모르는 칸은 경고하고, 비밀 값처럼 보이는 칸은 쓰지 않고 경고한다', () => {
    const { config, warnings } = parseServerConfig({ google: { clientId: CLIENT_ID, clientSecret: 'x' }, extra: 1, owner: { mail: 'x' } });
    expect(config.google).toEqual({ clientId: CLIENT_ID });
    expect(warnings).toEqual([
      '모르는 칸 extra은(는) 쓰지 않습니다',
      '모르는 칸 owner.mail은(는) 쓰지 않습니다',
      'google.clientSecret은(는) 비밀 값처럼 보여 쓰지 않습니다 — 비밀 값은 server.json에 넣지 말고 wook-server secret set으로 넣은 뒤 파일에서 지우세요',
    ]);
  });

  it('모양이 틀리면 그 칸을 말하며 거부한다', () => {
    for (const [bad, message] of [
      [[], 'server.json은 JSON 객체여야 합니다'],
      [{ owner: 'x' }, 'server.json의 owner은(는) 객체여야 합니다'],
      [{ owner: { email: 42 } }, 'server.json의 owner.email은(는) 글이어야 합니다'],
      [{ owner: { tailscaleLogins: 'a@b' } }, 'server.json의 owner.tailscaleLogins는 글의 목록이어야 합니다'],
      [{ network: { port: 70000 } }, 'server.json의 network.port는 0~65535의 정수여야 합니다'],
      [{ cli: { claudePath: true } }, 'server.json의 cli.claudePath은(는) 글이어야 합니다'],
    ] as const) {
      expect(() => parseServerConfig(bad), message).toThrow(message);
    }
    writeFileSync(join(dir, 'broken.json'), '{ "owner": ');
    const r = readServerConfig(join(dir, 'broken.json'));
    expect(r.ok).toBe(false);
    expect((r as { message: string }).message.startsWith(`운영자 설정 파일(${join(dir, 'broken.json')})이 JSON이 아닙니다: `)).toBe(true);
  });
});

describe('config reload — 파일 값이 DB 값을 덮어쓰고 기록한다 (S3-8)', () => {
  it('대표 이메일·구글 클라이언트 ID·CLI 위치를 적용하고 덮어쓴 것마다 행위자 operator로 남긴다', async () => {
    writeConfig({ owner: { email: 'owner@example.com' }, google: { clientId: CLIENT_ID }, cli: { claudePath: 'C:/tools/claude.exe' } });
    const r = await admin('config.reload');
    expect(r).toEqual({
      ok: true,
      result: {
        changes: [
          { item: 'owner.email', text: '대표 이메일 → owner@example.com' },
          { item: 'google.clientId', text: `구글 클라이언트 ID → ${CLIENT_ID}` },
          { item: 'cli.claudePath', text: 'Claude CLI 위치 → C:/tools/claude.exe' },
        ],
        warnings: [],
      },
    });
    expect(h.core.ctx.settings().cli.claudePath).toBe('C:/tools/claude.exe');
    expect(h.core.serverLogin.ownerEmail()).toBe('owner@example.com');
    expect(operatorRows().slice(0, 3).reverse()).toEqual([
      '대표 이메일 정함: owner@example.com (운영자 설정)',
      `server.json: 서버 구글 클라이언트 ID를 바꿈 (${CLIENT_ID})`,
      'server.json: Claude CLI 실행 파일 위치를 바꿈 (C:/tools/claude.exe)',
    ]);
    // 데스크톱 앱의 구글 설정은 건드리지 않는다 — 클라이언트 종류가 다르다
    expect(h.core.ctx.settings().account.googleClientId).toBe('');
  });

  it('값이 같으면 덮어쓰지 않고 기록도 없다 — DB 값이 다른 길로 바뀌었으면 다시 덮어쓰고 기록한다', async () => {
    const before = operatorRows().length;
    expect(await admin('config.reload')).toEqual({ ok: true, result: { changes: [], warnings: [] } });
    expect(operatorRows()).toHaveLength(before);
    await h.internal('settings.update', { cli: { claudePath: 'D:/elsewhere/claude.exe' } });
    expect((await admin('config.reload')) as { result: { changes: { item: string }[] } }).toMatchObject({ ok: true, result: { changes: [{ item: 'cli.claudePath' }] } });
    expect(h.core.ctx.settings().cli.claudePath).toBe('C:/tools/claude.exe');
    expect(operatorRows()[0]).toBe('server.json: Claude CLI 실행 파일 위치를 바꿈 (C:/tools/claude.exe)');
  });

  it('파일이 틀리면 아무것도 바꾸지 않는다 — 다른 칸이 맞아도 (모두 먼저 본다)', async () => {
    const before = operatorRows().length;
    writeConfig({ owner: { email: 'someone-else@example.com' }, google: { clientId: 'not-a-client-id' } });
    const bad = await admin('config.reload');
    expect(bad).toEqual({ ok: false, error: { code: 'invalid', message: 'server.json의 구글 클라이언트 ID(google.clientId)가 구글 OAuth 클라이언트 ID 모양(…apps.googleusercontent.com)이 아닙니다' } });
    writeConfig('{ 깨진 JSON');
    const broken = await admin('config.reload');
    expect(broken.ok).toBe(false);
    expect((broken as { error: { message: string } }).error.message.endsWith('— 아무것도 바꾸지 않았습니다')).toBe(true);
    expect(h.core.serverLogin.ownerEmail()).toBe('owner@example.com');
    expect(h.core.serverLogin.status().google.clientId).toBe(CLIENT_ID);
    expect(operatorRows()).toHaveLength(before);
    writeConfig({ owner: { email: 'owner@example.com' }, google: { clientId: CLIENT_ID }, cli: { claudePath: 'C:/tools/claude.exe' } });
  });
});

describe('config owner-email·google-client-id — server.json에 쓰고 적용한다 (S3-8)', () => {
  it('owner-email은 파일의 다른 칸을 두고 owner.email만 바꿔 쓴 뒤 적용한다 — 등록된 대표와 기기 세션이 끊긴다. 파일은 그 사용자만 읽는다', async () => {
    writeConfig({ owner: { email: 'owner@example.com', tailscaleLogins: ['owner@example.com'] }, google: { clientId: CLIENT_ID }, seat: { initialHolder: 'launched:codex' }, extra: true });
    h.core.ctx.store.kv.set('owner', { sub: 'sub-1', email: 'owner@example.com', name: '대표', registeredAt: h.core.ctx.now(), lastLoginAt: null });
    h.core.deviceSessions.issue({ deviceName: '휴대폰' });
    const r = await admin('config.owner-email', ['new-owner@example.com']);
    // 이 파일에서 처음 켠 받는 Tailscale 사용자도 다시 읽으며 적용된 것이다 — 바뀐 것으로 함께 말한다 (S3-19)
    expect(r).toMatchObject({
      ok: true,
      result: {
        changes: [
          { item: 'owner.email', text: '대표 이메일 → new-owner@example.com' },
          { item: 'owner.tailscaleLogins', text: '받는 Tailscale 사용자 → 켬 (1명)' },
        ],
      },
    });
    const file = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    expect(file).toEqual({ owner: { email: 'new-owner@example.com', tailscaleLogins: ['owner@example.com'] }, google: { clientId: CLIENT_ID }, seat: { initialHolder: 'launched:codex' }, extra: true });
    expect(h.core.auth.owner()).toBeNull();
    expect(h.core.deviceSessions.list()).toEqual([]);
    if (process.platform === 'win32') {
      const acl = windowsAcl(configPath);
      expect(acl.protected).toBe(true);
      expect(acl.rules.map((x) => [x.id, x.inherited, x.rights, x.type])).toEqual([[windowsMe(), false, 'FullControl', 'Allow']]);
    } else {
      expect(statSync(configPath).mode & 0o777).toBe(0o600);
    }
  });

  it('이메일·클라이언트 ID 모양이 아니면 파일을 바꾸지 않는다', async () => {
    const before = readFileSync(configPath, 'utf8');
    expect(await admin('config.owner-email', ['not-an-email'])).toMatchObject({ ok: false, error: { code: 'invalid' } });
    expect(await admin('config.google-client-id', ['GOCSPX-붙여넣은-비밀'])).toMatchObject({ ok: false, error: { code: 'invalid' } });
    expect(await admin('config.owner-email', [])).toMatchObject({ ok: false, error: { code: 'invalid_args' } });
    expect(readFileSync(configPath, 'utf8')).toBe(before);
    // 넣은 낱말은 거부 글에도 되풀이하지 않는다 — 관리 채널은 거부 글을 서버 기록에 남기고, 운영자가 비밀 값을 잘못 붙여 넣을 수 있다
    expect(log.lines.some((l) => l.includes('not-an-email') || l.includes('붙여넣은'))).toBe(false);
  });

  it('google-client-id는 파일에 쓰고 적용한다 — 파일이 없으면 만든다', async () => {
    const id = '777-newtv.apps.googleusercontent.com';
    expect(await admin('config.google-client-id', [id])).toMatchObject({ ok: true, result: { changes: [{ item: 'google.clientId' }] } });
    expect((JSON.parse(readFileSync(configPath, 'utf8')) as { google: { clientId: string } }).google.clientId).toBe(id);
    expect(h.core.serverLogin.status().google.clientId).toBe(id);
  });

  it('--owner-email로 띄운 서버는 그 인자가 파일보다 먼저이고, config owner-email은 거부한다', async () => {
    const flagged = createOperatorConfig({ path: configPath, ownerEmailFlag: 'flag-owner@example.com', operator: remoteBackendOf(h).operator, logger: memoryLogger() });
    expect(flagged.reload().changes.map((c) => c.text)).toContain('대표 이메일 → flag-owner@example.com');
    expect(flagged.show()).toMatchObject({ ownerEmail: 'flag-owner@example.com', ownerEmailSource: 'flag', ownerEmailFlag: true });
    expect(() => flagged.setOwnerEmail('other@example.com')).toThrow('이 서버는 --owner-email로 시작해 대표 이메일을 그 인자로 정합니다');
  });
});

describe('secret set|clear google-client-secret (S3-8)', () => {
  it('표준 입력으로 받은 값을 OS 보안 저장소에 넣는다 — 답·기록·활동 기록에 값이 없고, 데스크톱 앱의 보안 비밀은 그대로', async () => {
    const r = await admin('secret.set', ['google-client-secret'], SECRET);
    expect(r).toEqual({ ok: true, result: { name: 'google-client-secret', stored: true } });
    expect((await h.core.ctx.deps.secrets.get('google-device-client-secret')) === SECRET).toBe(true);
    expect(await h.core.ctx.deps.secrets.get('google-client-secret')).toBeNull();
    expect(operatorRows()[0]).toBe('서버 구글 로그인 보안 비밀 등록 (운영자 명령)');
    const shown = (await admin('config.show')) as { result: ServerConfigView };
    expect(shown.result.google).toEqual({ clientId: '777-newtv.apps.googleusercontent.com', secretSet: true });
    // 가리개에도 들어갔다 — 그 값이 섞인 글은 기록 전에 가려진다
    expect(h.core.ctx.redact.text(`x ${SECRET} y`).includes(SECRET)).toBe(false);
  });

  it('이름이 다르거나 값이 비면 거부한다', async () => {
    expect(await admin('secret.set', ['api-key-claude'], SECRET)).toMatchObject({ ok: false, error: { code: 'invalid_args' } });
    expect(await admin('secret.set', ['google-client-secret'], '   ')).toMatchObject({ ok: false, error: { code: 'invalid' } });
    expect(await admin('secret.set', ['google-client-secret'])).toMatchObject({ ok: false, error: { code: 'invalid' } });
  });

  it('clear는 지운다 — 다시 넣기 전까지 등록 안 됨', async () => {
    expect(await admin('secret.clear', ['google-client-secret'])).toEqual({ ok: true, result: { name: 'google-client-secret', cleared: true } });
    expect(await h.core.ctx.deps.secrets.get('google-device-client-secret')).toBeNull();
    expect(h.core.serverLogin.googleSecretSet()).toBe(false);
    expect(operatorRows()[0]).toBe('서버 구글 로그인 보안 비밀 지움 (운영자 명령)');
  });

  it('비밀 값은 관리 채널의 답·서버 기록·활동 기록 어디에도 없다', () => {
    const texts = [...replies, ...log.lines, ...h.core.ctx.store.activity.search({ limit: 1000 }).map((e) => `${e.text} ${e.result ?? ''}`)].join('\n');
    expect(texts.includes(SECRET)).toBe(false);
  });
});

describe('config show (S3-8)', () => {
  it('파일 자리·대표 이메일과 정한 곳·대표 계정·구글 설정(비밀은 등록 여부만)·CLI 위치·접속 허용(공개 주소·Tailscale 사용자, S3-7)·아직 쓰지 않는 칸·메인 자리 정책(S4-12)을 말한다', async () => {
    writeConfig({ owner: { email: 'new-owner@example.com', tailscaleLogins: ['a@tailnet'] }, google: { clientId: '777-newtv.apps.googleusercontent.com' }, network: { port: 7400, publicOrigin: 'https://pc.tailnet.ts.net' }, seat: {} });
    await admin('config.reload');
    const r = (await admin('config.show')) as { ok: true; result: ServerConfigView };
    expect(r.result).toMatchObject({
      path: configPath,
      exists: true,
      ownerEmail: 'new-owner@example.com',
      ownerEmailSource: 'config',
      ownerEmailFlag: false,
      ownerRegistered: false,
      setupCodeExpiresAt: null,
      google: { clientId: '777-newtv.apps.googleusercontent.com', secretSet: false },
      cli: { claudePath: 'C:/tools/claude.exe', codexPath: null },
      access: { publicOrigin: 'https://pc.tailnet.ts.net', publicOriginSource: 'config', tailscaleLogins: ['a@tailnet'] },
      // 작업 폴더 위치는 5단계부터 시작할 때 적용한다 — 아직 쓰지 않는 칸이 아니다 (리드 결정 S5-20). 이 하네스는 시작할 때 정한 위치를 넘기지 않는다
      pending: { network: { bind: null, port: 7400 } },
      workspace: null,
      initialHolder: null,
      seat: { holders: ['launched:claude', 'launched:codex', 'external:*'], drainMs: 120_000 },
      warnings: [],
    });
    expect(typeof r.result.loadedAt).toBe('string');
    expect(r.result.pending).toEqual({ network: { bind: null, port: 7400 } });
    const text = formatConfig(r.result);
    expect(text.split('\n').slice(0, 12)).toEqual([
      '욱채 서버 운영자 설정',
      `  설정 파일       ${configPath} (있음, ${r.result.loadedAt}에 읽음)`,
      '  대표 이메일     new-owner@example.com (server.json에서)',
      '  대표 계정       아직 등록 전 — 대표 이메일의 구글 계정으로 처음 로그인하면 등록됩니다',
      '  구글 클라이언트 777-newtv.apps.googleusercontent.com',
      '  구글 보안 비밀  없음 — wook-server secret set google-client-secret으로 넣습니다',
      '  CLI 위치        Claude C:/tools/claude.exe',
      '  기기 세션       살아 있는 것 0개',
      '  공개 주소       https://pc.tailnet.ts.net (server.json에서 — 이 주소의 Host·Origin도 받습니다)',
      '  Tailscale 사용자 a@tailnet의 요청만 받습니다',
      '  아직 쓰지 않음  network(port 7400) — 이 단계에서는 읽기만 합니다',
      '  메인 자리       앉을 수 있는 보유자 launched:claude, launched:codex, external:* · 교체 때 마무리 기다림 120초',
    ]);
  });

  it('종료가 시작되면 바꾸는 명령은 받지 않고 보기만 한다', async () => {
    const s2dir = mkdtempSync(join(tmpdir(), 'wook-test-opconfig-sd-'));
    const h2 = await createHarness({ mode: 'server', noProject: true });
    const s2 = await startServer({ backend: remoteBackendOf(h2), dataDir: h2.dataDir, port: 0, allowTestSession: false, logger: memoryLogger(), version: 'test' });
    try {
      s2.beginShutdown();
      for (const command of ['config.reload', 'secret.clear'] as const) {
        expect(await adminRequest({ dataDir: h2.dataDir, command, args: command === 'secret.clear' ? ['google-client-secret'] : undefined })).toEqual({
          ok: false,
          error: { code: 'shutting_down', message: '서버를 끝내는 중입니다' },
        });
      }
      expect((await adminRequest({ dataDir: h2.dataDir, command: 'config.show' })).ok).toBe(true);
      // 따로 넘긴 설정이 없으면 데이터 폴더의 server.json을 쓴다
      expect(((await adminRequest({ dataDir: h2.dataDir, command: 'config.show' })) as { result: ServerConfigView }).result.path).toBe(join(h2.dataDir, 'server.json'));
      expect(existsSync(join(h2.dataDir, 'server.json'))).toBe(false);
    } finally {
      await s2.close();
      await h2.close();
      await removeDir(s2dir);
    }
  });
});
