/**
 * 실제 AI 시험의 서버 모드 조립(tests/real/serverMode.ts, 리드 결정 S9-10)을 AI 없이 본다 — 실제 시험은 에이전트가 돌리지 않으므로(S9-17) 그 시험이 쓰는
 * 길만 여기서 확인한다. 모의 메인 에이전트를 시작 전에 켠다(S6-19).
 * - server: 시작 전에 넣은 운영 설정이 시작 때 이미 들어 있고(처음 메인 자리 보유자가 그 설정으로 앉음), 대표 호출은 HTTP의 원격 길로 간다 — 데스크톱
 *   운영자 메서드(auth.devLogin)는 대표 게이트에 막힌다. 운영자 내부 API로 프로젝트를 만들 수 있다. 끝나면 서버·관리 채널 파일이 남지 않는다
 * - desktop: 개발 모드 로그인으로 대표 호출이 된다
 * - WOOK_REAL_MODE는 server·desktop만 받는다
 * 만든 임시 폴더(데이터 폴더·프로젝트 폴더)는 시험이 실패해도 afterEach가 지운다 — 앱을 닫은 뒤에 (리드 결정 S9-22 TI-1)
 */
import { existsSync, mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID } from '@shared/domain';
import { bootReal, realMode, type RealApp } from './serverMode';

/** 이 파일이 만든 임시 폴더와 연 앱 — 시험이 실패해도 afterEach가 앱을 닫고 폴더를 지운다 */
const made: string[] = [];
const opened: RealApp[] = [];
const tempDir = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  made.push(d);
  return d;
};

afterEach(async () => {
  // 앱을 먼저 닫는다 (Windows는 열린 DB가 있는 폴더를 지우지 못한다). 이미 닫은 앱을 다시 닫아도 된다
  for (const app of opened.splice(0)) await app.close().catch(() => undefined);
  for (const d of made.splice(0)) await rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => undefined);
});

async function boot(mode: 'server' | 'desktop'): Promise<{ app: RealApp; dataDir: string }> {
  const dataDir = tempDir('wook-test-realmode-');
  const app = await bootReal({ mode, dataDir, settings: { developer: { mainAgentMock: true }, general: { mainAgent: { kind: 'codex', model: null, effortTier: 'normal', effortOverride: null } } } });
  if ('skip' in app) throw new Error(app.skip);
  opened.push(app);
  return { app, dataDir };
}

describe('실제 시험의 서버 모드 조립 (serverMode)', () => {
  it('server: 시작 전에 넣은 설정으로 시작하고(모의 메인, 처음 보유자 Codex), 대표 호출은 HTTP 원격 길이며, 끝나면 서버 파일이 남지 않는다', async () => {
    const { app, dataDir } = await boot('server');
    try {
      expect(app.mode).toBe('server');
      const ctx = app.core.ctx;
      // 백엔드가 서버 모드다 — 서버의 대표 이메일 설정 판정(setupRequired)이 대표의 로그인 상태에 있다 (데스크톱 모드에는 없다)
      expect(ctx.deps.mode).toBe('server');
      expect(await app.invoke('auth.getState')).toHaveProperty('setupRequired');
      expect(ctx.settings().developer.mainAgentMock).toBe(true);
      // 처음 메인 자리 보유자가 시작 전에 넣은 메인 AI(Codex)다 — 시작 뒤에 넣었다면 기본값(Claude)으로 앉았다
      expect(ctx.store.seat.get('main')?.holder).toMatchObject({ kind: 'launched', ai: { kind: 'codex' } });
      // 대표 호출은 HTTP(Bearer 기기 세션)로 — 로그인돼 있고, 데스크톱 운영자 메서드는 원격 길의 대표 게이트에 막힌다
      expect(await app.invoke('auth.getState')).toMatchObject({ loggedIn: true, mode: 'server' });
      await expect(app.invoke('auth.devLogin')).rejects.toThrow(/auth\.devLogin 실패 \(HTTP 403/);
      // 운영자 내부 API로 준비
      const projectDir = join(tempDir('wook-test-realmode-proj-'), '서버 모드 점검');
      const p = await app.internal('projects.create', { mode: 'new', path: projectDir, name: '서버 모드 점검', checkCommands: [] });
      expect((await app.invoke('snapshot.get')).projects.map((x) => x.id)).toContain(p.id);
      expect(existsSync(join(dataDir, 'admin.endpoint'))).toBe(true);
    } finally {
      const mainTurns = app.core.ctx.store.turns.list({ ref1: MAIN_AGENT_ID });
      await app.close();
      expect(mainTurns.filter((t) => !t.mock).map((t) => t.id)).toEqual([]);
    }
    expect(existsSync(join(dataDir, 'admin.endpoint'))).toBe(false);
    expect(existsSync(join(dataDir, 'admin.token'))).toBe(false);
  });

  it('desktop: 개발 모드 로그인 뒤 운영 설정을 넣고, 대표 호출은 Backend.invoke다', async () => {
    const { app } = await boot('desktop');
    try {
      expect(app.mode).toBe('desktop');
      expect(app.core.ctx.settings().developer.mainAgentMock).toBe(true);
      expect(await app.invoke('auth.getState')).toMatchObject({ loggedIn: true });
      expect(await app.invoke('auth.devLogin')).toMatchObject({ loggedIn: true });
    } finally {
      await app.close();
    }
  });

  it('WOOK_REAL_MODE는 server·desktop만 받고, 없으면 정한 기본값이다', () => {
    expect(realMode({})).toBe('desktop');
    expect(realMode({}, 'server')).toBe('server');
    expect(realMode({ WOOK_REAL_MODE: 'server' })).toBe('server');
    expect(realMode({ WOOK_REAL_MODE: 'desktop' }, 'server')).toBe('desktop');
    expect(() => realMode({ WOOK_REAL_MODE: 'Server ' })).toThrow(/server나 desktop/);
  });
});
