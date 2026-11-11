/**
 * 대표 이메일과 설정 코드 (SERVER_DESIGN 3.5, 리드 결정 S3-6 — src/main/orchestrator/serverLogin.ts):
 * - 설정 코드(SetupCodes, 손으로 돌리는 시계): 헷갈리지 않는 글자 8자, 1시간, 한 번만, 10분 안에 5번 틀리면 버림(창은 미끄러진다), 새 코드는 앞의 코드를 버림
 * - 대표 이메일 정하기: 처음 정할 때 같은 이메일로 등록된 대표(데스크톱 앱이 등록한 계정 등)는 그대로, 다른 이메일이면 그 대표를 지우고 세션을 끊음.
 *   바꾸면(대소문자만 다르면 바뀐 것이 아님) 등록된 sub를 지우고 기기 세션을 모두 끊음
 * - 데스크톱 앱은 그대로: 원격 호출자로 불러도 기기 코드 로그인·설정 코드는 데스크톱 글로 거부하고, 데스크톱 상태에는 setupRequired·mode가 없다
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OPERATOR } from '@shared/domain';
import { createHarness, type Harness } from '../e2e/harness';
import {
  normalizeOwnerEmail,
  SETUP_CODE_ALPHABET,
  SETUP_CODE_LENGTH,
  SETUP_CODE_MAX_FAILURES,
  SETUP_CODE_TRY_WINDOW_MS,
  SETUP_CODE_TTL_MS,
  SetupCodes,
} from '../../src/main/orchestrator/serverLogin';
import type { RemoteCaller } from '../../src/main/backend/types';
import { serverRedactor } from '../../src/server/serve';

const clock = () => {
  let t = 5_000_000;
  return { now: () => t, advance: (ms: number) => (t += ms) };
};
const other = (code: string) => (code[0] === 'A' ? `B${code.slice(1)}` : `A${code.slice(1)}`);

describe('설정 코드 (SetupCodes)', () => {
  it('결정 그대로의 상한 — 8자, 1시간, 10분에 5번', () => {
    expect([SETUP_CODE_LENGTH, SETUP_CODE_TTL_MS, SETUP_CODE_TRY_WINDOW_MS, SETUP_CODE_MAX_FAILURES]).toEqual([8, 3_600_000, 600_000, 5]);
    expect(SETUP_CODE_ALPHABET).not.toMatch(/[01OIL]/);
  });

  it('헷갈리지 않는 글자 8자이고 매번 다르다', () => {
    const c = clock();
    const codes = new Set(Array.from({ length: 200 }, () => new SetupCodes(c.now).issue().code));
    expect(codes.size).toBeGreaterThan(195);
    for (const code of codes) expect(code).toMatch(new RegExp(`^[${SETUP_CODE_ALPHABET}]{8}$`));
  });

  it('한 번만 쓴다 — 소문자·줄표·띄어쓰기를 넣어도 맞고, 맞은 뒤에는 쓸 수 있는 코드가 없다', () => {
    const c = clock();
    const s = new SetupCodes(c.now);
    const { code, expiresAt } = s.issue();
    expect(expiresAt - c.now()).toBe(SETUP_CODE_TTL_MS);
    expect(s.activeUntil()).toBe(expiresAt);
    expect(s.check(` ${code.slice(0, 4).toLowerCase()}-${code.slice(4)} `)).toEqual({ ok: true });
    expect(s.check(code)).toEqual({ ok: false, reason: 'none' });
    expect(s.activeUntil()).toBeNull();
  });

  it('1시간이 지나면 끝난다', () => {
    const c = clock();
    const s = new SetupCodes(c.now);
    const { code } = s.issue();
    c.advance(SETUP_CODE_TTL_MS - 1);
    expect(s.activeUntil()).not.toBeNull();
    c.advance(1);
    expect(s.activeUntil()).toBeNull();
    expect(s.check(code)).toEqual({ ok: false, reason: 'expired' });
    expect(s.check(code)).toEqual({ ok: false, reason: 'none' });
  });

  it('10분 안에 5번 틀리면 그 코드를 버린다 — 다섯째에 버렸다고 한 번 알리고, 그 뒤에는 맞는 코드도 받지 않는다', () => {
    const c = clock();
    const s = new SetupCodes(c.now);
    const { code } = s.issue();
    for (let left = 4; left >= 1; left--) {
      expect(s.check(other(code))).toEqual({ ok: false, reason: 'wrong', left });
      c.advance(60_000);
    }
    expect(s.check(other(code))).toEqual({ ok: false, reason: 'burnt', justBurnt: true });
    expect(s.check(code)).toEqual({ ok: false, reason: 'burnt' });
    expect(s.activeUntil()).toBeNull();
  });

  it('틀린 것은 10분 창 안에서만 센다 — 천천히 틀리면 버리지 않는다', () => {
    const c = clock();
    const s = new SetupCodes(c.now);
    const { code } = s.issue();
    for (let i = 0; i < 4; i++) expect(s.check(other(code)).ok).toBe(false);
    c.advance(SETUP_CODE_TRY_WINDOW_MS);
    expect(s.check(other(code))).toEqual({ ok: false, reason: 'wrong', left: 4 });
    expect(s.check(code)).toEqual({ ok: true });
  });

  it('새 코드를 내면 앞의 코드는 쓸 수 없다', () => {
    const c = clock();
    const s = new SetupCodes(c.now);
    const first = s.issue().code;
    const second = s.issue().code;
    if (first !== second) expect(s.check(first)).toMatchObject({ ok: false, reason: 'wrong' });
    expect(s.check(second)).toEqual({ ok: true });
  });
});

describe('서버 기록 가리기 (S3-6)', () => {
  it('이번에 낸 설정 코드를 가린다 — 세션 토큰 모양도', () => {
    const codes = new Set(['ABCD2345']);
    const redact = serverRedactor(() => null, codes);
    const out = redact(`코드 ABCD2345, 토큰 wos_${'Q'.repeat(43)}`);
    expect(out).toBe('코드 [가림:설정코드], 토큰 wos_[가림]');
    // 백엔드 가리개의 욱채 비밀 값 모양(wsk_ 에이전트 키·wtt_ 턴 토큰)도 — 등록 전·밖의 글, 예기치 않은 오류의 inspect 같은 것 (리드 결정 S7-17 A2)
    expect(redact(`에이전트 API 처리 오류: wsk_${'Ab1-'.repeat(10)}xyz wtt_${'Zq9_'.repeat(10)}abc 끝`)).toBe('에이전트 API 처리 오류: [가림:욱채 에이전트 키] [가림:욱채 턴 토큰] 끝');
  });
});

describe('대표 이메일 모양', () => {
  it('구글 계정 이메일 모양만 — 앞뒤 공백은 뗀다', () => {
    expect(normalizeOwnerEmail(' owner@example.com ')).toBe('owner@example.com');
    expect(normalizeOwnerEmail('Owner.Name+tag@sub.example.co.kr')).toBe('Owner.Name+tag@sub.example.co.kr');
    for (const bad of ['', 'owner', 'owner@', 'owner@example', 'a b@example.com', '<x>@example.com', `${'a'.repeat(250)}@example.com`, 42, null]) {
      expect(normalizeOwnerEmail(bad), String(bad)).toBeNull();
    }
  });
});

describe('대표 이메일 정하기와 바꾸기 (서버 모드)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness({ mode: 'server', noProject: true });
  }, 120_000);
  afterAll(async () => {
    await h?.close();
  });

  const registerOwner = (email: string, sub: string) =>
    h.core.ctx.store.kv.set('owner', { sub, email, name: '대표', registeredAt: h.core.ctx.now(), lastLoginAt: null });

  it('처음 정할 때 같은 이메일(대소문자 무시)로 등록된 대표는 그대로 둔다 — 그 기기 세션도 산다', () => {
    registerOwner('Owner@Example.com', 'desktop-sub');
    const s = h.core.deviceSessions.issue({ deviceName: '노트북' });
    expect(h.core.serverLogin.setOwnerEmail('owner@example.com', 'config', OPERATOR)).toBe(true);
    expect(h.core.auth.owner()?.sub).toBe('desktop-sub');
    expect(h.core.deviceSessions.live(s.session.id)).not.toBeNull();
    expect(h.core.ctx.store.activity.search({ limit: 5 })[0]).toMatchObject({ actor: OPERATOR, text: '대표 이메일 정함: owner@example.com (운영자 설정)' });
  });

  it('대소문자만 다른 이메일은 바뀐 것이 아니다 — 아무것도 끊지 않는다', () => {
    const before = h.core.deviceSessions.list().length;
    expect(h.core.serverLogin.setOwnerEmail('OWNER@example.com', 'config', OPERATOR)).toBe(false);
    expect(h.core.deviceSessions.list()).toHaveLength(before);
    expect(h.core.auth.owner()?.sub).toBe('desktop-sub');
  });

  it('바꾸면 등록된 대표(sub)를 지우고 기기 세션을 모두 끊는다 — 설정 코드도 버린다', () => {
    const code = h.core.serverLogin.setupCodes.issue().code;
    const ids = h.core.deviceSessions.list().map((x) => x.id);
    expect(h.core.serverLogin.setOwnerEmail('new@example.com', 'flag', OPERATOR)).toBe(true);
    expect(h.core.auth.owner()).toBeNull();
    expect(h.core.deviceSessions.list()).toEqual([]);
    for (const id of ids) expect(h.core.ctx.store.ownerSessions.get(id)?.revokedBy).toBe(OPERATOR);
    expect(h.core.serverLogin.setupCodes.check(code)).toEqual({ ok: false, reason: 'none' });
    expect(h.core.ctx.store.activity.search({ limit: 5 })[0]).toMatchObject({
      actor: OPERATOR,
      level: 'warn',
      text: '대표 이메일 바꿈: OWNER@example.com → new@example.com (--owner-email) — 등록된 대표 계정을 지우고 기기 세션 1개를 끊었습니다',
    });
  });

  it('처음 정할 때 다른 이메일로 등록된 대표가 있으면(시험용 대표 등) 그 대표를 지운다', async () => {
    const h2 = await createHarness({ mode: 'server', noProject: true });
    try {
      h2.core.ctx.store.kv.set('owner', { sub: 'operator-test', email: 'operator-test@wook.local', name: '시험용 대표', registeredAt: h2.core.ctx.now(), lastLoginAt: null });
      h2.core.deviceSessions.issue({ deviceName: '운영자 시험 세션' });
      expect(h2.core.serverLogin.setOwnerEmail('owner@example.com', 'setup', 'owner')).toBe(true);
      expect(h2.core.auth.owner()).toBeNull();
      expect(h2.core.deviceSessions.list()).toEqual([]);
    } finally {
      await h2.close();
    }
  });

  it('등록됨으로 적힌 서버 구글 보안 비밀이 OS 보안 저장소에 없으면 시작 때 등록 안 됨으로 맞춘다', async () => {
    h.core.ctx.store.kv.set('server.google', { clientId: '1-x.apps.googleusercontent.com', secretSet: true });
    h = await h.restart();
    expect(h.core.serverLogin.googleSecretSet()).toBe(false);
    expect(h.core.serverLogin.googleConfigured()).toBe(true);
    expect(h.core.ctx.store.activity.search({ limit: 20 }).map((e) => e.text)).toContain(
      '서버 구글 로그인 보안 비밀이 OS 보안 저장소에 없어 등록 안 됨으로 바꿨습니다 — 운영자가 wook-server secret set google-client-secret으로 다시 넣습니다',
    );
  });

  it('이메일 모양이 아니면 아무것도 바꾸지 않는다', () => {
    expect(() => h.core.serverLogin.setOwnerEmail('not-an-email', 'config', OPERATOR)).toThrow('대표 이메일 모양이 아닙니다');
    expect(h.core.serverLogin.ownerEmail()).toBe('new@example.com');
  });
});

describe('데스크톱 앱은 그대로 (mode desktop)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness({ noProject: true });
  }, 120_000);
  afterAll(async () => {
    await h?.close();
  });

  it('기기 코드 로그인·설정 코드는 데스크톱 글로 거부한다 — 원격 호출자로 불러도', async () => {
    const caller: RemoteCaller = { surface: 'remote', session: null, clientKey: 'anonymous' };
    for (const [method, args] of [
      ['auth.deviceLogin', ['휴대폰']],
      ['auth.deviceLoginPoll', ['dl_x']],
    ] as const) {
      for (const c of [undefined, caller]) {
        await expect(h.orch.backend.invoke(method, [...args] as never, c), `${method} ${c ? '원격' : '데스크톱'}`).rejects.toMatchObject({
          code: 'unavailable',
          message: '데스크톱 앱은 이 PC의 브라우저로 구글 로그인합니다 — 기기 코드 로그인은 서버 접속에서만 씁니다',
        });
      }
    }
    await expect(h.orch.backend.invoke('auth.setupOwner', ['ABCDEFGH', 'owner@example.com'])).rejects.toMatchObject({ code: 'unavailable' });
    expect(h.core.serverLogin.issueSetupCode()).toBeNull();
    expect(h.core.serverLogin.setupRequired()).toBe(false);
  });

  it('데스크톱 상태에는 setupRequired·mode 칸이 없고, 구글 설정은 데스크톱 설정이다', async () => {
    const state = await h.invoke('auth.getState');
    expect(Object.keys(state).sort()).toEqual(['devLoginAllowed', 'googleConfigured', 'googleSecretSet', 'googleSetupOpen', 'loggedIn', 'owner', 'ownerRegistered']);
    await h.internal('settings.update', { account: { googleClientId: '42-desktop.apps.googleusercontent.com' } });
    expect((await h.invoke('auth.getState')).googleConfigured).toBe(true);
  });
});
