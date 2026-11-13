/**
 * 새 데이터 폴더는 그 사용자만 (SERVER_DESIGN 3.7, S2-5 2번, S2-17): prepareDataDir가 없는 폴더를 만들 때
 * - Windows: 상속을 끊고(icacls /inheritance:r) 지금 사용자 하나에게만 모든 권한을 주며, 안에 생기는 파일·폴더가 그 권한을 물려받는다((OI)(CI))
 * - POSIX: 0700
 * - 이미 있는 폴더는 권한을 바꾸지 않는다 — 데스크톱 앱이 만든 폴더를 서버가 건드리지 않는다
 * - 옆의 임시 이름에서 좁힌 뒤 제자리로 옮긴다 — 좁히기가 실패해도 물려받은 권한의 폴더가 제자리에 남지 않는다 (S2-20)
 * 빌드한 서버가 이 길로 데이터 폴더를 만드는지는 startup.test가 본다
 */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { dataDirPathProblem, dataDirPathProblemText, prepareDataDir, type DataDirPathFs } from '../../src/server/dataDir';
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

  // 리드 결정 S10-16 FPS-3: 그 자리에는 폴더를 만들 수 없다(링크 위로 옮기기가 ENOTDIR) — 예전에는 rename의 ENOTDIR만 말했다
  it.skipIf(isWin)('폴더에 닿지 않는 링크(가리키는 곳이 없음·고리)면 무엇도 만들기 전에 까닭과 할 일로 던진다 — 링크는 그대로, 임시 폴더도 남지 않는다 (POSIX — 링크를 만들 권한이 늘 있다)', () => {
    const parent = base();
    const dangling = join(parent, 'wook-data');
    const target = join(parent, 'not-mounted', 'wook');
    symlinkSync(target, dangling);
    expect(() => prepareDataDir(dangling)).toThrow(
      `데이터 폴더가 링크인데 가리키는 곳이 없습니다 (링크 → ${target}) — 서버는 그 자리에 폴더를 만들 수 없습니다. 가리키는 곳의 디스크를 붙이거나(mount) 그 폴더를 만들거나, 링크를 고치세요`,
    );
    const a = join(parent, 'a');
    const b = join(parent, 'b');
    symlinkSync(b, a);
    symlinkSync(a, b);
    expect(() => prepareDataDir(a)).toThrow(`데이터 폴더가 링크인데 링크가 고리를 이뤄 폴더에 닿지 않습니다 (링크 → ${b}) — 서버는 그 자리에 폴더를 만들 수 없습니다. 링크를 고치거나 지우세요`);
    expect(readdirSync(parent).sort()).toEqual(['a', 'b', 'wook-data']);
    expect(lstatSync(dangling).isSymbolicLink()).toBe(true);
    // 가리키는 곳이 생기면(디스크를 붙이면) 그 폴더를 그대로 쓴다
    mkdirSync(target, { recursive: true });
    expect(prepareDataDir(dangling)).toEqual({ created: false });
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

/**
 * 리드 결정 S10-16b: 위 폴더가 닿지 않는 링크(가리키는 곳이 없음·고리)이거나 위 폴더 자리에 파일이 있으면, 서버는 데이터 폴더를 만들 수 없다 —
 * 예전에는 mkdir의 ENOENT·ENOTDIR만 말했고 check는 '서버가 만든다'고 했다. 보통의 아직 없는 폴더(있는 폴더 아래의 없는 폴더 사슬)는 예전처럼 만든다
 */
describe('데이터 폴더 경로의 위 폴더 (S10-16b)', () => {
  /** 넣은 파일 시스템 — 경로마다 lstat의 모양(폴더·파일·링크) 또는 오류 코드, 링크는 적힌 곳과 따라간 곳(또는 오류) */
  type Node = { kind: 'dir' | 'file' } | { kind: 'link'; target: string; real: string | { code: string } } | { code: string };
  const fakeFs = (nodes: Record<string, Node>): DataDirPathFs => {
    const fail = (code: string): never => {
      throw Object.assign(new Error(code), { code });
    };
    const get = (p: string): Node => nodes[p] ?? { code: 'ENOENT' };
    const shape = (n: Node) => {
      if ('code' in n) return fail(n.code);
      return { isSymbolicLink: () => n.kind === 'link', isDirectory: () => n.kind === 'dir' };
    };
    return {
      lstat: (p) => shape(get(p)),
      stat: (p) => {
        const n = get(p);
        if ('kind' in n && n.kind === 'link') return typeof n.real === 'string' ? shape(get(n.real)) : fail(n.real.code);
        return shape(n);
      },
      readlink: (p) => {
        const n = get(p);
        return 'kind' in n && n.kind === 'link' ? n.target : fail('EINVAL');
      },
      realpath: (p) => {
        const n = get(p);
        if ('kind' in n && n.kind === 'link') return typeof n.real === 'string' ? n.real : fail(n.real.code);
        return 'code' in n ? fail(n.code) : p;
      },
    };
  };
  const D = '/home/u/wook/wook-data';

  it('넣은 파일 시스템: 위 폴더의 닿지 않는 링크·고리, 위 폴더 자리의 파일·파일로 가는 링크를 찾고, 보통의 아직 없는 폴더는 null (모든 OS)', () => {
    const home = { '/': { kind: 'dir' }, '/home': { kind: 'dir' }, '/home/u': { kind: 'dir' } } as const;
    expect(dataDirPathProblem(D, fakeFs({ ...home, '/home/u/wook': { kind: 'link', target: '/mnt/disk2/wook', real: { code: 'ENOENT' } } }))).toEqual({
      kind: 'link',
      path: '/home/u/wook',
      target: '/mnt/disk2/wook',
      code: 'ENOENT',
    });
    expect(dataDirPathProblem(D, fakeFs({ ...home, '/home/u/wook': { kind: 'link', target: 'w2', real: { code: 'ELOOP' } }, [D]: { code: 'ELOOP' } }))).toMatchObject({ kind: 'link', path: '/home/u/wook', code: 'ELOOP' });
    expect(dataDirPathProblem(D, fakeFs({ ...home, '/home/u/wook': { kind: 'file' }, [D]: { code: 'ENOTDIR' } }))).toEqual({ kind: 'notDir', path: '/home/u/wook' });
    expect(dataDirPathProblem(D, fakeFs({ ...home, '/home/u/wook': { kind: 'link', target: 'notes.txt', real: '/home/u/notes.txt' }, '/home/u/notes.txt': { kind: 'file' } }))).toEqual({
      kind: 'notDir',
      path: '/home/u/wook',
      link: '/home/u/notes.txt',
    });
    // 데이터 폴더 자신의 닿지 않는 링크 (FPS-3)
    expect(dataDirPathProblem(D, fakeFs({ ...home, '/home/u/wook': { kind: 'dir' }, [D]: { kind: 'link', target: '/x', real: { code: 'ENOENT' } } }))).toEqual({ kind: 'link', path: D, target: '/x', code: 'ENOENT' });
    // 보통: 있는 폴더 아래의 없는 폴더 사슬, 폴더에 닿는 위 링크, 있는 데이터 폴더(파일이어도 — 예전 글이 말한다), 아무것도 없는 경로, 판단하지 않는 오류
    for (const nodes of [
      { ...home },
      { '/': { kind: 'dir' } },
      { ...home, '/home/u/wook': { kind: 'link', target: '/mnt/disk2/wook', real: '/mnt/disk2/wook' }, '/mnt/disk2/wook': { kind: 'dir' } },
      { ...home, '/home/u/wook': { kind: 'dir' }, [D]: { kind: 'file' } },
      { ...home, '/home/u/wook': { kind: 'dir' }, [D]: { kind: 'link', target: '/x', real: '/x' }, '/x': { kind: 'dir' } },
      {},
      { [D]: { code: 'EACCES' } },
    ] as Array<Record<string, Node>>) {
      expect([nodes, dataDirPathProblem(D, fakeFs(nodes))]).toEqual([nodes, null]);
    }
  });

  it('글: 위 폴더는 그 경로를 적고 서버는 데이터 폴더를 만들 수 없다고 말한다 — 데이터 폴더 자신의 링크는 FPS-3의 글 그대로 (모든 OS)', () => {
    expect(dataDirPathProblemText(D, { kind: 'link', path: '/home/u/wook', target: '/mnt/disk2/wook', code: 'ENOENT' })).toEqual({
      text: '데이터 폴더 경로의 위 폴더(/home/u/wook)가 링크인데 가리키는 곳이 없습니다 (링크 → /mnt/disk2/wook) — 서버는 데이터 폴더를 만들 수 없습니다',
      fix: '가리키는 곳의 디스크를 붙이거나(mount) 그 폴더를 만들거나, 링크를 고치세요',
    });
    expect(dataDirPathProblemText(D, { kind: 'link', path: '/home/u/wook', target: 'w2', code: 'ELOOP' }).text).toBe(
      '데이터 폴더 경로의 위 폴더(/home/u/wook)가 링크인데 링크가 고리를 이뤄 폴더에 닿지 않습니다 (링크 → w2) — 서버는 데이터 폴더를 만들 수 없습니다',
    );
    expect(dataDirPathProblemText(D, { kind: 'notDir', path: '/home/u/wook', link: '/home/u/notes.txt' })).toEqual({
      text: '데이터 폴더 경로의 위 폴더 자리(/home/u/wook)에 폴더가 아닌 것이 있습니다 (링크 → /home/u/notes.txt) — 서버는 그 아래에 데이터 폴더를 만들 수 없습니다',
      fix: '그 자리의 파일을 옮기거나 지우세요, 아니면 다른 --data-dir을 쓰세요',
    });
    expect(dataDirPathProblemText(D, { kind: 'link', path: D, target: '/x', code: 'ENOENT' }).text).toBe(
      '데이터 폴더가 링크인데 가리키는 곳이 없습니다 (링크 → /x) — 서버는 그 자리에 폴더를 만들 수 없습니다',
    );
  });

  it('실제: 경로 가운데 파일이 있으면 무엇도 만들기 전에 그 자리를 말하고 던진다 (모든 OS — 링크가 들지 않는다)', () => {
    const parent = base();
    writeFileSync(join(parent, 'notes.txt'), 'x');
    const dir = join(parent, 'notes.txt', 'sub', 'wook-data');
    expect(() => prepareDataDir(dir)).toThrow(
      `데이터 폴더 경로의 위 폴더 자리(${join(parent, 'notes.txt')})에 폴더가 아닌 것이 있습니다 — 서버는 그 아래에 데이터 폴더를 만들 수 없습니다. 그 자리의 파일을 옮기거나 지우세요, 아니면 다른 --data-dir을 쓰세요`,
    );
    expect(readdirSync(parent)).toEqual(['notes.txt']);
  });

  it.skipIf(isWin)('실제: 가리키는 곳이 없는 위 폴더 링크·고리인 위 폴더는 무엇도 만들기 전에 던지고, 폴더에 닿는 링크 아래의 없는 폴더 사슬은 만든다 (POSIX — 링크를 만들 권한이 늘 있다)', () => {
    const parent = base();
    symlinkSync(join(parent, 'not-mounted'), join(parent, 'wook'));
    symlinkSync(join(parent, 'q'), join(parent, 'p'));
    symlinkSync(join(parent, 'p'), join(parent, 'q'));
    expect(() => prepareDataDir(join(parent, 'wook', 'wook-data'))).toThrow(
      `데이터 폴더 경로의 위 폴더(${join(parent, 'wook')})가 링크인데 가리키는 곳이 없습니다 (링크 → ${join(parent, 'not-mounted')}) — 서버는 데이터 폴더를 만들 수 없습니다. 가리키는 곳의 디스크를 붙이거나(mount) 그 폴더를 만들거나, 링크를 고치세요`,
    );
    expect(() => prepareDataDir(join(parent, 'p', 'a', 'wook-data'))).toThrow(
      `데이터 폴더 경로의 위 폴더(${join(parent, 'p')})가 링크인데 링크가 고리를 이뤄 폴더에 닿지 않습니다 (링크 → ${join(parent, 'q')}) — 서버는 데이터 폴더를 만들 수 없습니다. 링크를 고치거나 지우세요`,
    );
    expect(readdirSync(parent).sort()).toEqual(['p', 'q', 'wook']);
    mkdirSync(join(parent, 'disk'));
    symlinkSync(join(parent, 'disk'), join(parent, 'good'));
    expect(prepareDataDir(join(parent, 'good', 'a', 'wook-data'))).toEqual({ created: true });
    expect(statSync(join(parent, 'disk', 'a', 'wook-data')).mode & 0o777).toBe(0o700);
    // 디스크를 붙이면(가리키는 곳이 생기면) 그 아래에 만든다
    mkdirSync(join(parent, 'not-mounted'));
    expect(prepareDataDir(join(parent, 'wook', 'wook-data'))).toEqual({ created: true });
  });
});
