/**
 * 첫 실행 구글 로그인 설정과 개발 모드 로그인 (AC-01, AUTH-01·03, ENV-04, SEC-09).
 * - 패키징된 첫 실행에는 개발 모드 로그인이 없고 설정 변경은 로그인이 필요해, 구글 클라이언트 ID를 넣을 길이 없어 대표가 로그인하지 못했다.
 *   → 대표 등록 전에는 구글 로그인 설정(클라이언트 ID·보안 비밀)만 로그인 없이 받는다. 대표가 등록되면 다시 로그인한 대표만 바꾼다.
 * - 개발 모드 로그인이 'dev-local'을 대표로 등록해, 그 뒤 실제 대표의 구글 로그인이 영구히 거부됐다. 같은 앱 데이터 폴더를 쓰는
 *   패키징 실행은 개발 모드 세션을 그대로 인정해 구글 로그인 없이 열렸다.
 *   → 개발 모드 로그인은 세션만 남기고(패키징 실행에서는 무효), 대표 기록에는 구글 계정만 들어간다. 예전 'dev-local' 기록은 빈 자리로 본다.
 * 실제 오케스트레이터 Backend.invoke(로그인 게이트 포함)로 확인한다 (tests/acceptance/security-helpers.ts bootApp).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { bootApp, dumpDb, fakeGoogle, fakeShell, persistentSecrets, removeDirs, scanFiles, tempDir, waitFor, type App } from '../acceptance/security-helpers';

const apps: App[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
  await removeDirs(dirs.splice(0));
});

async function boot(o: Parameters<typeof bootApp>[0]): Promise<App> {
  const a = await bootApp({ stopScheduler: true, runnerMode: 'taskkill', ...o });
  apps.push(a);
  return a;
}

function dataDir(): string {
  const d = tempDir('auth');
  dirs.push(d);
  return d;
}

async function rejectCode(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'resolved';
  } catch (e) {
    return (e as { code?: string }).code ?? `error:${(e as Error).message}`;
  }
}

const OWNER_A = { sub: 'google-sub-owner-0001', email: 'owner@example.com', emailVerified: true, name: '대표' };
const OTHER_B = { sub: 'google-sub-other-0002', email: 'intruder@example.com', emailVerified: true, name: '다른 사람' };
const CLIENT_ID = '1234567890-wookfirstrun.apps.googleusercontent.com';
const OTHER_CLIENT_ID = '999-attacker.apps.googleusercontent.com';
const CLIENT_SECRET = 'GOCSPX-wook-first-run-secret-7Hq2';
const DEV_OWNER = { email: 'dev@localhost', name: '대표(개발 모드)' };

describe('패키징된 첫 실행: 대표 등록 전에는 구글 로그인 설정만 로그인 없이 받는다 (AC-01, ENV-04)', () => {
  it('클라이언트 ID·보안 비밀을 넣고 처음 로그인한 구글 계정이 대표가 된다. 비밀은 OS 보안 저장소에만, 다른 요청은 막히고, 대표가 등록되면 설정도 로그인한 대표만 바꾼다', async () => {
    const google = fakeGoogle();
    const secrets = persistentSecrets();
    const dir = dataDir();
    const app = await boot({ dataDir: dir, isPackaged: true, googleLogin: google.login, shell: fakeShell(), secrets });
    expect(await app.invoke('auth.getState')).toEqual({ loggedIn: false, owner: null, googleConfigured: false, googleSecretSet: false, ownerRegistered: false, devLoginAllowed: false, googleSetupOpen: true });
    expect(await rejectCode(app.invoke('auth.login'))).toBe('not_configured');
    expect(await rejectCode(app.invoke('auth.devLogin'))).toBe('forbidden');

    // 대표 등록 전에도 구글 로그인 설정이 아닌 요청은 막힌다 (다른 값이 섞인 설정 변경 포함)
    expect(await rejectCode(app.invoke('settings.update', { account: { googleClientId: CLIENT_ID }, execution: { maxConcurrent: 9 } }))).toBe('unauthorized');
    expect(await rejectCode(app.invoke('settings.update', { account: { googleClientId: CLIENT_ID, authMode: { claude: 'api_key', codex: 'api_key' } } }))).toBe('unauthorized');
    expect(await rejectCode(app.invoke('settings.update', { developer: { mainAgentMock: true } }))).toBe('unauthorized');
    expect(await rejectCode(app.invoke('settings.get'))).toBe('unauthorized');
    expect(await rejectCode(app.invoke('settings.setApiKey', 'claude', 'sk-ant-api03-first-run-should-not-pass'))).toBe('unauthorized');
    expect(await rejectCode(app.invoke('snapshot.get'))).toBe('unauthorized');
    expect(app.ctx.settings().execution.maxConcurrent).not.toBe(9);

    // 클라이언트 ID가 아닌 값(보안 비밀을 잘못 붙여 넣음 등)은 저장 전에 거부한다
    expect(await rejectCode(app.invoke('settings.update', { account: { googleClientId: CLIENT_SECRET } }))).toBe('invalid');
    expect(await rejectCode(app.invoke('settings.update', { account: { googleClientId: '12 34.apps.googleusercontent.com' } }))).toBe('invalid');
    expect(await app.invoke('auth.getState')).toMatchObject({ googleConfigured: false });

    // 로그인 화면에서 넣는 구글 로그인 설정 (운영 설정 > 계정과 같은 요청)
    await app.invoke('settings.update', { account: { googleClientId: `  ${CLIENT_ID}  ` } });
    await app.invoke('settings.setGoogleSecret', CLIENT_SECRET);
    expect(await app.invoke('auth.getState')).toEqual({ loggedIn: false, owner: null, googleConfigured: true, googleSecretSet: true, ownerRegistered: false, devLoginAllowed: false, googleSetupOpen: true });
    expect(app.ctx.settings().account).toMatchObject({ googleClientId: CLIENT_ID, googleClientSecretSet: true });
    // SEC-09: 비밀 값은 OS 보안 저장소에만 — DB·앱 데이터 파일·활동 기록에는 없다
    expect(await secrets.get('google-client-secret')).toBe(CLIENT_SECRET);
    expect(dumpDb(app)).not.toContain(CLIENT_SECRET);
    expect(scanFiles(dir, [CLIENT_SECRET])).toEqual([]);
    const setupLog = app.ctx.store.activity.search({ kinds: ['settings'], limit: 20 }).map((e) => e.text);
    expect(setupLog.some((t) => t.includes(CLIENT_ID) && t.includes('로그인 없이'))).toBe(true);
    expect(setupLog.some((t) => t.includes('보안 비밀 등록') && t.includes('로그인 없이'))).toBe(true);
    // 화면에는 로그인 전에도 설정됨 신호가 간다 (스냅샷 auth — 업무 내용은 빠진 잠긴 스냅샷)
    await waitFor(() => app.pushed.some((p) => p.topic === 'snapshot' && (p.payload as { auth: { googleConfigured: boolean } }).auth.googleConfigured), '설정됨 스냅샷', 10_000);

    // 처음 로그인한 구글 계정이 대표가 된다 — 넣은 ID·비밀로 로그인한다 (AUTH-03)
    google.queue.push(OWNER_A);
    expect(await app.invoke('auth.login')).toMatchObject({ loggedIn: true, owner: { email: OWNER_A.email } });
    expect(google.calls.at(-1)).toMatchObject({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    expect((await app.invoke('snapshot.get')).auth.loggedIn).toBe(true);

    // 대표가 등록되면 로그아웃 중에는 구글 설정도 바꿀 수 없다 (등록된 설치본의 로그인 게이트는 그대로)
    await app.invoke('auth.logout');
    // 로그인 화면은 로그아웃 상태에서도 대표 등록 여부를 안다 — 등록 뒤(대표 로그인으로 확인된 설정)에는 로그인 없는 설정 다시 입력 경로를 닫는다
    expect(await app.invoke('auth.getState')).toEqual({ loggedIn: false, owner: null, googleConfigured: true, googleSecretSet: true, ownerRegistered: true, devLoginAllowed: false, googleSetupOpen: false });
    expect(await rejectCode(app.invoke('settings.update', { account: { googleClientId: OTHER_CLIENT_ID } }))).toBe('unauthorized');
    expect(await rejectCode(app.invoke('settings.setGoogleSecret', 'GOCSPX-attacker'))).toBe('unauthorized');
    expect(await rejectCode(app.invoke('settings.setGoogleSecret', ''))).toBe('unauthorized');
    expect(app.ctx.settings().account.googleClientId).toBe(CLIENT_ID);
    expect(await secrets.get('google-client-secret')).toBe(CLIENT_SECRET);
    google.queue.push(OTHER_B);
    expect(await rejectCode(app.invoke('auth.login'))).toBe('forbidden');

    // 재시작해도 같다. 로그인한 대표는 바꿀 수 있다
    await app.stop();
    const again = await boot({ dataDir: dir, isPackaged: true, googleLogin: google.login, shell: fakeShell(), secrets });
    expect(await rejectCode(again.invoke('settings.update', { account: { googleClientId: OTHER_CLIENT_ID } }))).toBe('unauthorized');
    google.queue.push(OWNER_A);
    expect(await again.invoke('auth.login')).toMatchObject({ loggedIn: true, owner: { email: OWNER_A.email } });
    expect((await again.invoke('settings.update', { account: { googleClientId: OTHER_CLIENT_ID } })).account.googleClientId).toBe(OTHER_CLIENT_ID);
  });
});

describe('개발 모드 로그인은 대표 자리를 차지하지 않는다 (AUTH-03, AC-01)', () => {
  it('개발 실행에서 구글 설정 → 처음 구글 로그인한 계정이 대표, 다른 계정은 거부. 그 뒤 개발 모드 로그인은 그 대표로 열리고, 같은 폴더의 패키징 실행은 개발 모드 세션을 인정하지 않는다', async () => {
    const google = fakeGoogle();
    const dir = dataDir();
    // bootApp가 개발 모드 로그인을 한다
    const dev = await boot({ dataDir: dir, isPackaged: false, googleLogin: google.login, shell: fakeShell() });
    expect(await dev.invoke('auth.getState')).toEqual({ loggedIn: true, owner: DEV_OWNER, googleConfigured: false, googleSecretSet: false, ownerRegistered: false, devLoginAllowed: true, googleSetupOpen: true });
    expect(dev.core.auth.owner()).toBeNull();
    await dev.invoke('settings.update', { account: { googleClientId: CLIENT_ID } });

    // 개발 모드로 들어온 채로 구글 로그인 → 그 계정이 대표로 등록된다
    google.queue.push(OWNER_A);
    expect(await dev.invoke('auth.login')).toMatchObject({ loggedIn: true, owner: { email: OWNER_A.email } });
    expect(dev.core.auth.owner()?.sub).toBe(OWNER_A.sub);
    await dev.invoke('auth.logout');
    google.queue.push(OTHER_B);
    expect(await rejectCode(dev.invoke('auth.login'))).toBe('forbidden');
    // 대표가 있으면 개발 모드 로그인은 그 대표로 연다 (대표 기록은 그대로)
    expect(await dev.invoke('auth.devLogin')).toMatchObject({ loggedIn: true, owner: { email: OWNER_A.email } });
    expect(dev.core.auth.owner()?.sub).toBe(OWNER_A.sub);

    // 개발 모드로 로그인한 채 끝낸 뒤 같은 폴더로 패키징 실행 → 구글 로그인 없이는 열리지 않는다
    await dev.stop();
    const pkg = await boot({ dataDir: dir, isPackaged: true, googleLogin: google.login, shell: fakeShell() });
    // 대표가 개발 실행에서 로그인한 설정 그대로다 (대표 로그인으로 확인됨) — 로그인 없는 구글 설정 입력은 닫혀 있다
    expect(await pkg.invoke('auth.getState')).toEqual({ loggedIn: false, owner: null, googleConfigured: true, googleSecretSet: false, ownerRegistered: true, devLoginAllowed: false, googleSetupOpen: false });
    expect(await rejectCode(pkg.invoke('snapshot.get'))).toBe('unauthorized');
    expect(await rejectCode(pkg.invoke('settings.update', { account: { googleClientId: OTHER_CLIENT_ID } }))).toBe('unauthorized');
    google.queue.push(OWNER_A);
    expect(await pkg.invoke('auth.login')).toMatchObject({ loggedIn: true, owner: { email: OWNER_A.email } });
  });

  it('구글 대표 등록 전에 개발 모드로 로그인한 채 끝낸 폴더도 패키징 실행에서는 잠겨 있고, 대표가 구글 설정을 넣고 로그인하면 대표로 등록된다', async () => {
    const google = fakeGoogle();
    const dir = dataDir();
    const dev = await boot({ dataDir: dir, isPackaged: false, googleLogin: google.login, shell: fakeShell() });
    expect(await dev.invoke('auth.getState')).toMatchObject({ loggedIn: true, owner: DEV_OWNER });
    await dev.stop();

    const pkg = await boot({ dataDir: dir, isPackaged: true, googleLogin: google.login, shell: fakeShell() });
    expect(await pkg.invoke('auth.getState')).toEqual({ loggedIn: false, owner: null, googleConfigured: false, googleSecretSet: false, ownerRegistered: false, devLoginAllowed: false, googleSetupOpen: true });
    expect(await rejectCode(pkg.invoke('snapshot.get'))).toBe('unauthorized');
    await pkg.invoke('settings.update', { account: { googleClientId: CLIENT_ID } });
    google.queue.push(OWNER_A);
    expect(await pkg.invoke('auth.login')).toMatchObject({ loggedIn: true, owner: { email: OWNER_A.email } });
    expect(pkg.core.auth.owner()?.sub).toBe(OWNER_A.sub);
  });

  it("예전 개발 모드 로그인이 남긴 'dev-local' 대표 기록은 빈 자리로 본다: 개발 실행은 그대로 열리고, 패키징 실행은 잠긴 채 구글 설정을 받아 실제 대표를 등록한다", async () => {
    const google = fakeGoogle();
    const dir = dataDir();
    // 이전 버전이 저장한 값 (개발 모드 로그인 → 대표 등록)
    const old = await boot({ dataDir: dir, isPackaged: false, devLogin: false });
    const at = old.ctx.now();
    old.ctx.store.kv.set('owner', { sub: 'dev-local', email: 'dev@localhost', name: '대표(개발 모드)', registeredAt: at, lastLoginAt: at });
    old.ctx.store.kv.set('auth.session', { sub: 'dev-local', at });
    await old.stop();

    // 개발 실행: 예전 개발 모드 세션은 그대로 열리지만 대표로 등록된 것은 아니다
    const dev = await boot({ dataDir: dir, isPackaged: false, devLogin: false, googleLogin: google.login, shell: fakeShell() });
    expect(await dev.invoke('auth.getState')).toMatchObject({ loggedIn: true, owner: DEV_OWNER });
    expect(dev.core.auth.owner()).toBeNull();
    await dev.stop();

    // 패키징 실행: 개발 모드 세션은 무효, 대표 자리는 비어 있어 구글 설정을 로그인 없이 받는다
    const pkg = await boot({ dataDir: dir, isPackaged: true, googleLogin: google.login, shell: fakeShell() });
    expect(await pkg.invoke('auth.getState')).toEqual({ loggedIn: false, owner: null, googleConfigured: false, googleSecretSet: false, ownerRegistered: false, devLoginAllowed: false, googleSetupOpen: true });
    expect(await rejectCode(pkg.invoke('snapshot.get'))).toBe('unauthorized');
    await pkg.invoke('settings.update', { account: { googleClientId: CLIENT_ID } });
    google.queue.push(OWNER_A);
    expect(await pkg.invoke('auth.login')).toMatchObject({ loggedIn: true, owner: { email: OWNER_A.email } });
    expect(pkg.core.auth.owner()).toMatchObject({ sub: OWNER_A.sub, email: OWNER_A.email });
    // 이제 등록된 설치본: 다른 계정은 거부, 설정은 로그인한 대표만
    await pkg.invoke('auth.logout');
    google.queue.push(OTHER_B);
    expect(await rejectCode(pkg.invoke('auth.login'))).toBe('forbidden');
    expect(await rejectCode(pkg.invoke('settings.update', { account: { googleClientId: OTHER_CLIENT_ID } }))).toBe('unauthorized');
  });
});
