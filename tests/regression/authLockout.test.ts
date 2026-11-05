/**
 * 등록된 대표가 설정만으로 패키징 실행에서 영영 갇히지 않는다 (AC-01 '대표 계정으로 로그인하면 홈이 열리고', AUTH-01·03, ENV-04).
 * 단계 5에서는 로그인한 대표가 운영 설정 > 계정의 클라이언트 ID를 비우거나 보안 비밀을 지우거나 틀린(형식은 맞는) 값을 넣은 뒤 로그아웃하면
 * (auth.logout은 공개) 다시 들어올 길이 없었다: 로그인은 not_configured·실패, 로그인 없는 설정은 대표 등록 뒤라 unauthorized, 개발 모드
 * 로그인은 패키징 실행에서 금지. 안내 문구는 로그인이 필요한 화면(운영 설정 > 계정)을 가리켰다.
 * 이제: 대표가 있으면 비우기·지우기는 거부하고, 바뀐 설정은 대표 로그인으로 확인될 때까지(그리고 등록해 둔 보안 비밀이 저장소에서 사라졌을 때)
 * 로그인 화면이 설정을 다시 받는다 (auth.googleSetupOpen). 로그인은 그래도 대표의 구글 계정으로만 된다.
 * 원래 탐침: probe-archive/auth-security/probes/tests/regression/zz-authsec-lockout.probe.ts
 */
import { afterEach, describe, expect, it } from 'vitest';
import { GoogleLoginError, type GoogleLoginOptions, type GoogleProfile, type SecretStore } from '../../src/main/auth/types';
import { bootApp, fakeShell, persistentSecrets, removeDirs, tempDir, type App } from '../acceptance/security-helpers';

const apps: App[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
  await removeDirs(dirs.splice(0));
});

const OWNER_A = { sub: 'google-sub-owner-0001', email: 'owner@example.com', emailVerified: true, name: '대표' };
const OTHER_B = { sub: 'google-sub-other-0002', email: 'intruder@example.com', emailVerified: true, name: '다른 사람' };
const GOOD_ID = '1234567890-wooklockout.apps.googleusercontent.com';
const GOOD_SECRET = 'GOCSPX-wook-lockout-good-secret-1';
const TYPO_ID = '1234567890-wooklockuot.apps.googleusercontent.com';
const TYPO_SECRET = 'GOCSPX-wook-lockout-typo-secret-1';

/** 실제 구글처럼 맞는 클라이언트 ID·보안 비밀일 때만 로그인되는 가짜 (틀린 ID는 브라우저에서 멈춰 시간 초과, 틀린 비밀은 토큰 교환 실패) */
function strictGoogle(): { login: (o: GoogleLoginOptions) => Promise<GoogleProfile>; queue: GoogleProfile[] } {
  const queue: GoogleProfile[] = [];
  return {
    queue,
    async login(o) {
      await o.openExternal(`https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(o.clientId)}`);
      // 로그인 시도마다 그 시도를 한 계정을 하나 꺼낸다 (실패한 시도도)
      const p = queue.shift();
      if (o.clientId !== GOOD_ID) throw new GoogleLoginError('timeout', '로그인 창에서 응답이 오지 않았습니다 (구글: OAuth 클라이언트를 찾을 수 없음)');
      if (o.clientSecret !== GOOD_SECRET) throw new GoogleLoginError('token_exchange', '구글 토큰 교환에 실패했습니다 (HTTP 401, invalid_client)');
      if (!p) throw new GoogleLoginError('cancelled', '대표가 로그인을 취소했습니다');
      return p;
    },
  };
}

async function outcome(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'resolved';
  } catch (e) {
    return (e as { code?: string }).code ?? `error:${(e as Error).message}`;
  }
}

async function messageOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return '';
  } catch (e) {
    return (e as Error).message;
  }
}

/** 패키징 실행, 구글 설정을 넣고 대표가 등록·로그인한 상태 */
async function registeredOwner(o: { secrets?: SecretStore; dataDir?: string } = {}) {
  const google = strictGoogle();
  const secrets = o.secrets ?? persistentSecrets();
  const dataDir = o.dataDir ?? tempDir('lockout');
  if (!o.dataDir) dirs.push(dataDir);
  const app = await bootApp({ dataDir, isPackaged: true, googleLogin: google.login, shell: fakeShell(), secrets, stopScheduler: true, runnerMode: 'taskkill' });
  apps.push(app);
  await app.invoke('settings.update', { account: { googleClientId: GOOD_ID } });
  await app.invoke('settings.setGoogleSecret', GOOD_SECRET);
  google.queue.push(OWNER_A);
  await app.invoke('auth.login');
  return { app, google, secrets, dataDir };
}

describe('등록된 대표는 구글 로그인 설정 때문에 갇히지 않는다 (AC-01)', () => {
  it('로그인한 대표가 클라이언트 ID를 비우거나 보안 비밀을 지우려 하면 conflict로 거부되고 설정은 그대로다 — 로그아웃 뒤에도 다시 로그인된다', async () => {
    const { app, google, secrets } = await registeredOwner();
    const clear = await outcome(app.invoke('settings.update', { account: { googleClientId: '' } }));
    const clearSpaces = await outcome(app.invoke('settings.update', { account: { googleClientId: '   ' } }));
    const clearMsg = await messageOf(app.invoke('settings.update', { account: { googleClientId: '' } }));
    const del = await outcome(app.invoke('settings.setGoogleSecret', ''));
    const delMsg = await messageOf(app.invoke('settings.setGoogleSecret', '  '));
    await app.invoke('auth.logout');
    google.queue.push(OWNER_A);
    const login = await outcome(app.invoke('auth.login'));
    expect({
      clear,
      clearSpaces,
      clearMsg,
      del,
      delMsg,
      kept: [app.ctx.settings().account.googleClientId, await secrets.get('google-client-secret')],
      login,
    }).toEqual({
      clear: 'conflict',
      clearSpaces: 'conflict',
      clearMsg: expect.stringContaining('클라이언트 ID를 비울 수 없습니다'),
      del: 'conflict',
      delMsg: expect.stringContaining('보안 비밀을 지울 수 없습니다'),
      kept: [GOOD_ID, GOOD_SECRET],
      login: 'resolved',
    });
  });

  for (const typo of ['client id', 'secret'] as const) {
    it(`로그인한 대표가 형식은 맞지만 틀린 ${typo === 'client id' ? '클라이언트 ID' : '보안 비밀'}을 넣고 로그아웃해도, 로그인 화면이 설정을 다시 받아 대표가 다시 들어온다 — 다른 계정은 여전히 거부`, async () => {
      const { app, google } = await registeredOwner();
      expect((await app.invoke('auth.getState')).googleSetupOpen).toBe(false);
      if (typo === 'client id') await app.invoke('settings.update', { account: { googleClientId: TYPO_ID } });
      else await app.invoke('settings.setGoogleSecret', TYPO_SECRET);
      await app.invoke('auth.logout');
      const locked = await app.invoke('auth.getState');
      google.queue.push(OWNER_A);
      const failMsg = await messageOf(app.invoke('auth.login'));
      // 로그인 화면이 넣는 구글 설정 (로그인 없이) — 다른 설정은 그대로 막힌다
      const otherSetting = await outcome(app.invoke('settings.update', { execution: { maxConcurrent: 9 } }));
      await app.invoke('settings.update', { account: { googleClientId: GOOD_ID } });
      await app.invoke('settings.setGoogleSecret', GOOD_SECRET);
      google.queue.push(OTHER_B);
      const stranger = await outcome(app.invoke('auth.login'));
      google.queue.push(OWNER_A);
      const owner = await outcome(app.invoke('auth.login'));
      await app.invoke('auth.logout');
      const after = await app.invoke('auth.getState');
      const reopen = await outcome(app.invoke('settings.update', { account: { googleClientId: TYPO_ID } }));
      expect({
        locked: { configured: locked.googleConfigured, secret: locked.googleSecretSet, owner: locked.ownerRegistered, open: locked.googleSetupOpen },
        failHint: [failMsg.includes('로그인 화면'), failMsg.includes('운영 설정')],
        otherSetting,
        stranger,
        owner,
        closedAgain: after.googleSetupOpen,
        reopen,
        clientId: app.ctx.settings().account.googleClientId,
      }).toEqual({
        locked: { configured: true, secret: true, owner: true, open: true },
        failHint: [true, false],
        otherSetting: 'unauthorized',
        stranger: 'forbidden',
        owner: 'resolved',
        closedAgain: false,
        reopen: 'unauthorized',
        clientId: GOOD_ID,
      });
    });
  }

  it('등록해 둔 보안 비밀이 OS 보안 저장소에서 사라지면 — 앱이 꺼져 있던 사이(시작할 때 알아챔)든 실행 중이든(로그인 때 알아챔) — 로그인 화면이 설정을 다시 받고, 안내는 로그인 화면을 가리킨다', async () => {
    // ① 앱이 꺼져 있는 사이에 사라짐 → 시작할 때 등록 안 됨으로 맞추고 설정 입력을 연다
    const first = await registeredOwner();
    await first.app.invoke('auth.logout');
    await first.app.stop();
    await first.secrets.delete('google-client-secret');
    const again = await bootApp({ dataDir: first.dataDir, isPackaged: true, googleLogin: first.google.login, shell: fakeShell(), secrets: first.secrets, stopScheduler: true, runnerMode: 'taskkill' });
    apps.push(again);
    const restarted = await again.invoke('auth.getState');
    const restartLog = again.ctx.store.activity.search({ kinds: ['auth'], limit: 20 }).some((e) => e.level === 'warn' && e.text.includes('OS 보안 저장소에 없어'));
    await again.invoke('settings.setGoogleSecret', GOOD_SECRET);
    first.google.queue.push(OWNER_A);
    const restartLogin = await outcome(again.invoke('auth.login'));

    // ② 실행 중에 사라짐 → 로그인할 때 알아챈다
    const second = await registeredOwner();
    await second.app.invoke('auth.logout');
    await second.secrets.delete('google-client-secret');
    second.google.queue.push(OWNER_A);
    const running = await messageOf(second.app.invoke('auth.login'));
    const runningState = await second.app.invoke('auth.getState');
    await second.app.invoke('settings.setGoogleSecret', GOOD_SECRET);
    second.google.queue.push(OWNER_A);
    const runningLogin = await outcome(second.app.invoke('auth.login'));

    expect({
      restarted: { configured: restarted.googleConfigured, secret: restarted.googleSecretSet, owner: restarted.ownerRegistered, open: restarted.googleSetupOpen },
      restartLog,
      restartLogin,
      running: [running.includes('보안 비밀이 OS 보안 저장소에 없습니다'), running.includes('로그인 화면'), running.includes('운영 설정')],
      runningState: { secret: runningState.googleSecretSet, open: runningState.googleSetupOpen },
      runningLogin,
    }).toEqual({
      restarted: { configured: true, secret: false, owner: true, open: true },
      restartLog: true,
      restartLogin: 'resolved',
      running: [true, true, false],
      runningState: { secret: false, open: true },
      runningLogin: 'resolved',
    });
  });

  it('대표가 있는데 클라이언트 ID가 없는 설치본(예전 버전에서 비운 경우)은 로그인 화면에서 다시 넣는다 — 안내가 로그인이 필요한 화면을 가리키지 않는다', async () => {
    const { app, google } = await registeredOwner();
    await app.invoke('auth.logout');
    const s = app.ctx.settings();
    app.ctx.saveSettings({ ...s, account: { ...s.account, googleClientId: '' } });
    google.queue.push(OWNER_A);
    const msg = await messageOf(app.invoke('auth.login'));
    const state = await app.invoke('auth.getState');
    const setup = await outcome(app.invoke('settings.update', { account: { googleClientId: GOOD_ID } }));
    google.queue.push(OWNER_A);
    const login = await outcome(app.invoke('auth.login'));
    expect({ hint: [msg.includes('로그인 화면'), msg.includes('운영 설정')], open: state.googleSetupOpen, setup, login }).toEqual({ hint: [true, false], open: true, setup: 'resolved', login: 'resolved' });
  });
});
