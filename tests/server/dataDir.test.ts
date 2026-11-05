/**
 * 새 데이터 폴더는 그 사용자만 (SERVER_DESIGN 3.7, S2-5 2번, S2-17): prepareDataDir가 없는 폴더를 만들 때
 * - Windows: 상속을 끊고(icacls /inheritance:r) 지금 사용자 하나에게만 모든 권한을 주며, 안에 생기는 파일·폴더가 그 권한을 물려받는다((OI)(CI))
 * - POSIX: 0700
 * - 이미 있는 폴더는 권한을 바꾸지 않는다 — 데스크톱 앱이 만든 폴더를 서버가 건드리지 않는다
 * - 옆의 임시 이름에서 좁힌 뒤 제자리로 옮긴다 — 좁히기가 실패해도 물려받은 권한의 폴더가 제자리에 남지 않는다 (S2-20)
 * 빌드한 서버가 이 길로 데이터 폴더를 만드는지는 startup.test가 본다
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareDataDir } from '../../src/server/dataDir';
import { removeDir, windowsAcl, windowsMe } from './helpers';

const isWin = process.platform === 'win32';
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await removeDir(d);
});

const base = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'wook-test-datadir-'));
  dirs.push(d);
  return d;
};

describe('새 데이터 폴더 (S2-5)', () => {
  it('Windows: 상속을 끊고 지금 사용자 하나만 모든 권한 — 안에 생기는 파일·폴더도 그 사용자만', (ctx) => {
    if (!isWin) ctx.skip('Windows ACL(icacls) 시험 — POSIX는 아래 0700 시험');
    const dir = join(base(), '새 데이터');
    expect(prepareDataDir(dir)).toEqual({ created: true });
    expect(windowsAcl(dir)).toEqual({ protected: true, rules: [{ id: windowsMe(), inherited: false, rights: 'FullControl', flags: 'ContainerInherit, ObjectInherit', type: 'Allow' }] });
    // 서버가 나중에 만드는 것(wook.db·logs/)이 같은 권한을 물려받는다
    writeFileSync(join(dir, 'wook.db'), '');
    mkdirSync(join(dir, 'logs'));
    expect(windowsAcl(join(dir, 'wook.db')).rules.map((r) => [r.id, r.inherited, r.rights])).toEqual([[windowsMe(), true, 'FullControl']]);
    expect(windowsAcl(join(dir, 'logs')).rules.map((r) => [r.id, r.inherited, r.rights])).toEqual([[windowsMe(), true, 'FullControl']]);
  });

  it('POSIX: 0700', (ctx) => {
    if (isWin) ctx.skip('POSIX 권한 비트 시험 — Windows는 위 ACL 시험');
    const dir = join(base(), '새 데이터');
    expect(prepareDataDir(dir)).toEqual({ created: true });
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('이미 있는 폴더는 권한을 바꾸지 않고 그대로 쓴다', () => {
    const dir = base();
    const before = isWin ? windowsAcl(dir) : statSync(dir).mode;
    expect(prepareDataDir(dir)).toEqual({ created: false });
    expect(isWin ? windowsAcl(dir) : statSync(dir).mode).toEqual(before);
    if (isWin) expect((before as ReturnType<typeof windowsAcl>).protected).toBe(false);
  });

  it('데이터 폴더 자리에 파일이 있으면 던진다', () => {
    const file = join(base(), '파일');
    writeFileSync(file, 'x');
    expect(() => prepareDataDir(file)).toThrow(`데이터 폴더 자리에 폴더가 아닌 것이 있습니다: ${file}`);
  });

  it('새 폴더는 옆의 임시 이름에서 좁힌 뒤 제자리로 옮긴다 — 끝나면 그 폴더 하나만 남고, 없는 위 폴더도 만든다 (S2-20)', () => {
    const parent = base();
    expect(prepareDataDir(join(parent, '새 데이터'))).toEqual({ created: true });
    expect(readdirSync(parent)).toEqual(['새 데이터']);
    const nested = join(parent, '위', '아래');
    expect(prepareDataDir(nested)).toEqual({ created: true });
    expect(readdirSync(join(parent, '위'))).toEqual(['아래']);
    if (isWin) expect(windowsAcl(nested).protected).toBe(true);
    else expect(statSync(nested).mode & 0o777).toBe(0o700);
  });

  it('Windows: 좁히기(icacls)가 실패하면 만들던 폴더를 남기지 않는다 — 다시 시작하면 좁힌 새 폴더를 만든다 (S2-20, 리뷰 프로브 zz-s2f1sec-n6-datadirretry)', (ctx) => {
    if (!isWin) ctx.skip('Windows ACL(icacls) 실패를 흉내 낸다 — POSIX의 chmod는 막 만든 그 사용자 폴더에서 실패하지 않는다');
    const parent = base();
    const dir = join(parent, '새 데이터');
    const saved = process.env['USERNAME'];
    let failure = '';
    try {
      // 없는 계정 이름이라 icacls가 실패한다 (계정을 풀지 못함 — 시간 초과·정책으로 막힌 icacls와 같은 실패 길)
      process.env['USERNAME'] = 'wook-no-such-user-7c1e';
      prepareDataDir(dir);
    } catch (error) {
      failure = (error as Error).message;
    } finally {
      if (saved === undefined) delete process.env['USERNAME'];
      else process.env['USERNAME'] = saved;
    }
    expect(failure).toContain('icacls');
    // 물려받은 권한의 폴더가 남지 않는다 — 다음 시작이 그것을 '이미 있는 폴더'로 그대로 쓰지 않게. 옆의 임시 폴더도 남지 않는다
    expect(existsSync(dir)).toBe(false);
    expect(readdirSync(parent)).toEqual([]);
    expect(prepareDataDir(dir)).toEqual({ created: true });
    expect(windowsAcl(dir)).toEqual({ protected: true, rules: [{ id: windowsMe(), inherited: false, rights: 'FullControl', flags: 'ContainerInherit, ObjectInherit', type: 'Allow' }] });
  });
});
