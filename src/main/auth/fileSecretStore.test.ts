/**
 * 비밀 값 파일 저장소 (리드 결정 S10-6.1, fileSecretStore.ts): Linux에서 데스크톱·서버 모두 쓰는 `<데이터 폴더>/secrets/`.
 * - 왕복·덮어쓰기·지우기·목록, 나눠 담기(긴 값)를 그대로 얹는다, 새 저장소(다시 시작)가 같은 값을 읽는다, 임시 파일이 남지 않는다
 * - 손상된 파일·다른 계정의 파일은 틀린 값을 주지 않고 corrupt
 * - 크게 실패한다: 다른 주인·넓은 권한·심볼릭 링크는 읽기·쓰기·지우기·목록 모두 backend 오류(chmod 고칠 줄), 상태(fallbackReason)도 그 문제 — 권한 판단은
 *   uid·stat을 넣어 어느 OS에서나, 실제 0700·0600과 실제 chmod는 Linux에서
 * 잡는 결함: 넓게 열린 폴더의 값을 그대로 읽고 씀(다른 사용자가 바꾼 값), 폴더를 0755로 만듦, 쓰다 끊긴 임시 파일을 목록에 넣음, 계정 이름을 파일 이름에
 * 그대로 씀(긴 이름·'/'), 해시가 같은 다른 계정의 값을 돌려줌
 */
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSecretStore, SecretStoreError } from './secretStore';
import { fileSecretBackend, fileSecretStoreProblem, fileStoreText, secretsDirOf, type SecretStat } from './fileSecretStore';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tempData = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'wook-test-filesecrets-'));
  dirs.push(d);
  return d;
};
const LONG = ('가나다라마바사😀abc' + '0123456789').repeat(300);
const isLinux = process.platform === 'linux';

describe('파일 저장소 — 왕복 (모든 OS)', () => {
  it('저장·읽기·덮어쓰기·삭제·목록, 긴 값은 나눠 담고, 새 저장소(다시 시작)도 같은 값을 읽는다 — 임시 파일은 남지 않는다', async () => {
    const dir = secretsDirOf(tempData());
    const s = createSecretStore({ service: 'wookagent', file: fileSecretBackend({ dir }) });
    expect([s.backend, s.fallbackReason]).toEqual(['file', null]);
    expect(await s.get('api-key-claude')).toBeNull();
    await s.set('api-key-claude', 'v1');
    await s.set('api-key-claude', 'v2 값 ✓');
    await s.set('google-client-secret', LONG);
    expect(await s.get('api-key-claude')).toBe('v2 값 ✓');
    expect(await s.get('google-client-secret')).toBe(LONG);
    // 다시 시작한 서버 — 새 저장소가 디스크에서 읽는다
    const again = createSecretStore({ service: 'wookagent', file: fileSecretBackend({ dir }) });
    expect(await again.get('google-client-secret')).toBe(LONG);
    const raw = fileSecretBackend({ dir });
    const accounts = await raw.list!();
    expect(accounts).toContain('api-key-claude');
    expect(accounts.filter((a) => a.startsWith('google-client-secret#')).length).toBeGreaterThan(1);
    // 파일 이름은 계정 이름의 해시 — 계정 이름은 파일 이름에 없다
    const names = readdirSync(dir);
    expect(names.every((n) => /^[0-9a-f]{64}\.json$/.test(n))).toBe(true);
    await again.delete('google-client-secret');
    await again.delete('api-key-claude');
    expect(await s.get('api-key-claude')).toBeNull();
    expect(readdirSync(dir)).toEqual([]);
    await expect(again.delete('api-key-claude')).resolves.toBeUndefined();
  });

  it('폴더가 없으면 읽기는 null·목록은 비고 폴더를 만들지 않는다 — 처음 쓸 때 만든다', async () => {
    const data = tempData();
    const dir = secretsDirOf(data);
    const raw = fileSecretBackend({ dir });
    expect([await raw.get('k'), await raw.list!(), await raw.delete('k')]).toEqual([null, [], false]);
    expect(readdirSync(data)).toEqual([]);
    await raw.set('k', 'v');
    expect(statSync(dir).isDirectory()).toBe(true);
    // 옆 임시 이름으로 만들었다 — 남은 것이 없다
    expect(readdirSync(data)).toEqual(['secrets']);
  });

  it('손상된 파일·다른 계정을 적은 파일은 틀린 값을 주지 않고 corrupt — 새로 쓰면 돌아온다. 이 저장소가 쓰지 않은 파일과 임시 파일은 목록에 없다', async () => {
    const dir = secretsDirOf(tempData());
    const raw = fileSecretBackend({ dir });
    await raw.set('a', '1');
    await raw.set('b', '2');
    const fileOf = async (account: string): Promise<string> => {
      for (const n of readdirSync(dir)) if (JSON.parse(readFileSync(join(dir, n), 'utf8')).account === account) return n;
      throw new Error('없음');
    };
    const nameA = await fileOf('a');
    // b의 내용을 a의 자리에 — 이름과 계정이 맞지 않는다
    writeFileSync(join(dir, nameA), readFileSync(join(dir, await fileOf('b'))), { mode: 0o600 });
    await expect(raw.get('a')).rejects.toMatchObject({ code: 'corrupt' });
    writeFileSync(join(dir, nameA), '{"v":1,"account":"a"', { mode: 0o600 });
    await expect(raw.get('a')).rejects.toMatchObject({ code: 'corrupt' });
    expect(await raw.list!()).toEqual(['b']);
    writeFileSync(join(dir, `.${nameA}.tmp-deadbeef`), '{"v":1,"account":"x","value":"y"}', { mode: 0o600 });
    writeFileSync(join(dir, 'other.json'), '{"v":1,"account":"x","value":"y"}', { mode: 0o600 });
    expect(await raw.list!()).toEqual(['b']);
    await raw.set('a', 'fresh');
    expect(await raw.get('a')).toBe('fresh');
  });
});

/** 넣는 stat — 실제 종류는 그대로, 주인·권한만 바꾼다 */
function fakeStat(over: (path: string) => Partial<{ uid: number; mode: number }>): (p: string) => SecretStat {
  return (p) => {
    const st = lstatSync(p);
    const o = over(p);
    return { uid: o.uid ?? 1000, mode: o.mode ?? (st.isDirectory() ? 0o40700 : 0o100600), isDirectory: () => st.isDirectory(), isFile: () => st.isFile(), isSymbolicLink: () => st.isSymbolicLink() };
  };
}

describe('파일 저장소 — 크게 실패한다 (권한 판단은 넣은 uid·stat으로, 모든 OS)', () => {
  it('다른 주인·넓은 폴더·넓은 파일이면 읽기·쓰기·지우기·목록이 모두 backend 오류이고 그 까닭과 고칠 줄을 말한다 — 상태도 같은 문제', async () => {
    const dir = secretsDirOf(tempData());
    await fileSecretBackend({ dir, uid: 1000, stat: fakeStat(() => ({})) }).set('k', 'v');
    const cases: [string, (p: string) => Partial<{ uid: number; mode: number }>, RegExp][] = [
      ['다른 주인(폴더)', (p) => (p === dir ? { uid: 0 } : {}), /비밀 값 폴더\(.*\)의 주인이 이 사용자\(uid 1000\)가 아닙니다 \(uid 0\)/],
      ['그룹이 읽음(폴더 0750)', (p) => (p === dir ? { mode: 0o40750 } : {}), /비밀 값 폴더\(.*\)의 권한이 넓습니다 \(750\).*chmod 700 '/],
      ['다른 사용자가 읽음(파일 0644)', (p) => (p !== dir ? { mode: 0o100644 } : {}), /비밀 값 파일\(.*\)의 권한이 넓습니다 \(644\).*chmod 600 '/],
      ['다른 주인(파일)', (p) => (p !== dir ? { uid: 1001 } : {}), /비밀 값 파일\(.*\)의 주인이 이 사용자\(uid 1000\)가 아닙니다 \(uid 1001\)/],
    ];
    for (const [label, over, re] of cases) {
      const raw = fileSecretBackend({ dir, uid: 1000, stat: fakeStat(over) });
      const s = createSecretStore({ service: 'wookagent', file: raw });
      for (const op of [() => raw.get('k'), () => raw.set('k', 'w'), () => raw.delete('k'), () => raw.list!()]) {
        const e = await op().then(
          () => null,
          (err: unknown) => err,
        );
        expect([label, e instanceof SecretStoreError && e.code === 'backend' && re.test(e.message)]).toEqual([label, true]);
      }
      // 폴더의 문제는 상태(fallbackReason)가 늘 말한다 — 파일의 문제는 그 파일을 읽을 때 (상태는 폴더만 본다)
      if (label.includes('폴더')) expect([label, re.test(s.fallbackReason ?? '')]).toEqual([label, true]);
    }
    // 고치면(권한이 맞으면) 그대로 읽는다 — 값은 바뀌지 않았다
    expect(await fileSecretBackend({ dir, uid: 1000, stat: fakeStat(() => ({})) }).get('k')).toBe('v');
  });

  it('비밀 값 폴더 자리가 파일이면 문제이고, 없으면 문제가 아니다 (서버 시작·check가 같은 것을 본다)', () => {
    const data = tempData();
    const dir = secretsDirOf(data);
    expect(fileSecretStoreProblem(dir, { uid: 1000, stat: fakeStat(() => ({})) })).toBeNull();
    writeFileSync(dir, 'x');
    expect(fileSecretStoreProblem(dir, { uid: 1000, stat: fakeStat(() => ({})) })).toMatch(/폴더가 아닌 것이 있습니다/);
  });

  it('상태 글은 폴더와 "이 사용자만, 암호화하지 않음"을 말한다 (리드 결정 S10-6.1)', () => {
    expect(fileStoreText('/home/u/.config/wookagent/secrets')).toBe('파일 (/home/u/.config/wookagent/secrets — 이 사용자만, 암호화하지 않음)');
  });
});

describe.runIf(isLinux)('파일 저장소 — 실제 권한 (Linux만: 0700·0600과 chmod는 POSIX 권한이 있어야 본다)', () => {
  it('처음 쓰면 폴더 0700·파일 0600이고 주인은 이 사용자다', async () => {
    const dir = secretsDirOf(tempData());
    await fileSecretBackend({ dir }).set('k', 'v');
    const d = statSync(dir);
    const f = statSync(join(dir, readdirSync(dir)[0]!));
    expect([d.mode & 0o777, f.mode & 0o777, d.uid, f.uid]).toEqual([0o700, 0o600, process.getuid!(), process.getuid!()]);
  });

  it('누가 chmod 755·644로 넓히면 실제 저장소가 거부한다 — 고치면(chmod 700·600) 다시 읽는다', async () => {
    const dir = secretsDirOf(tempData());
    const raw = fileSecretBackend({ dir });
    await raw.set('k', 'v');
    chmodSync(dir, 0o755);
    await expect(raw.get('k')).rejects.toMatchObject({ code: 'backend', message: expect.stringContaining(`chmod 700 '${dir}'`) });
    expect(fileSecretStoreProblem(dir)).toMatch(/권한이 넓습니다 \(755\)/);
    chmodSync(dir, 0o700);
    const file = join(dir, readdirSync(dir)[0]!);
    chmodSync(file, 0o644);
    await expect(raw.set('k', 'w')).rejects.toMatchObject({ code: 'backend', message: expect.stringContaining(`chmod 600 '${file}'`) });
    chmodSync(file, 0o600);
    expect(await raw.get('k')).toBe('v');
  });

  it('비밀 값 폴더가 심볼릭 링크면(다른 곳을 가리킴) 거부한다', async () => {
    const data = tempData();
    const elsewhere = join(data, 'elsewhere');
    mkdirSync(elsewhere, { mode: 0o700 });
    symlinkSync(elsewhere, secretsDirOf(data));
    await expect(fileSecretBackend({ dir: secretsDirOf(data) }).set('k', 'v')).rejects.toMatchObject({ code: 'backend', message: expect.stringContaining('심볼릭 링크') });
    expect(readdirSync(elsewhere)).toEqual([]);
  });
});

/**
 * 리드 결정 S10-13 SH-5·SH-6: 쓰다 끊긴 임시 파일(값이 그대로 든다)은 그 계정을 지울 때와, 연 때(1분 넘게 지난 것) 지운다 — 지운 값이 디스크에 남지 않는다.
 * 저장소의 문제 확인(serve·status·check가 쓴다)은 폴더뿐 아니라 값 파일(종류·주인·권한)도 본다 — 문서대로 넓은 파일 하나도 서버를 띄우지 않는다
 */
describe('파일 저장소 — 임시 파일과 파일의 문제 (S10-13, 모든 OS)', () => {
  it('지우기는 그 계정의 임시 파일도 지운다 — 다른 계정의 임시 파일은 남는다', async () => {
    const dir = secretsDirOf(tempData());
    const raw = fileSecretBackend({ dir });
    await raw.set('k', 'secret-v1');
    await raw.set('other', 'x');
    const nameOf = (account: string): string => readdirSync(dir).find((n) => JSON.parse(readFileSync(join(dir, n), 'utf8')).account === account)!;
    const k = nameOf('k');
    const o = nameOf('other');
    // 서버가 쓰는 도중에 끝났다 — 이 저장소의 임시 이름 꼴 그대로
    writeFileSync(join(dir, `.${k}.tmp-deadbeef`), '{"v":1,"account":"k","value":"secret-v0"}', { mode: 0o600 });
    writeFileSync(join(dir, `.${o}.tmp-cafebabe`), '{"v":1,"account":"other","value":"y"}', { mode: 0o600 });
    expect(await raw.delete('k')).toBe(true);
    expect(readdirSync(dir).sort()).toEqual([o, `.${o}.tmp-cafebabe`].sort());
    expect(readdirSync(dir).some((n) => readFileSync(join(dir, n), 'utf8').includes('secret-v'))).toBe(false);
  });

  it('연 때 1분 넘게 지난 임시 파일을 지운다 — 막 생긴 것(같은 때의 쓰기)은 두고, 이 저장소의 이름 꼴이 아닌 파일은 건드리지 않는다', async () => {
    const dir = secretsDirOf(tempData());
    await fileSecretBackend({ dir }).set('k', 'v');
    const hex = 'a'.repeat(64);
    const stale = join(dir, `.${hex}.json.tmp-00000001`);
    const fresh = join(dir, `.${hex}.json.tmp-00000002`);
    const foreign = join(dir, 'notes.tmp-00000003');
    for (const f of [stale, fresh, foreign]) writeFileSync(f, 'x', { mode: 0o600 });
    const old = new Date(Date.now() - 5 * 60_000);
    utimesSync(stale, old, old);
    utimesSync(foreign, old, old);
    fileSecretBackend({ dir });
    const left = readdirSync(dir);
    expect([left.includes(basename(stale)), left.includes(basename(fresh)), left.includes(basename(foreign))]).toEqual([false, true, true]);
  });

  it('문제 확인은 값 파일도 본다 — 넓은 파일·다른 주인의 파일·링크 파일이면 그 글(서버는 시작하지 않고 check는 실패로 본다), 괜찮으면 null', async () => {
    const dir = secretsDirOf(tempData());
    await fileSecretBackend({ dir, uid: 1000, stat: fakeStat(() => ({})) }).set('k', 'v');
    expect(fileSecretStoreProblem(dir, { uid: 1000, stat: fakeStat(() => ({})) })).toBeNull();
    expect(fileSecretStoreProblem(dir, { uid: 1000, stat: fakeStat((p) => (p !== dir ? { mode: 0o100644 } : {})) })).toMatch(/^비밀 값 파일\(.*\)의 권한이 넓습니다 \(644\).*chmod 600 '/);
    expect(fileSecretStoreProblem(dir, { uid: 1000, stat: fakeStat((p) => (p !== dir ? { uid: 0 } : {})) })).toMatch(/^비밀 값 파일\(.*\)의 주인이 이 사용자\(uid 1000\)가 아닙니다/);
    // 이 저장소의 이름 꼴이 아닌 파일은 보지 않는다
    writeFileSync(join(dir, 'README'), 'x', { mode: 0o644 });
    expect(fileSecretStoreProblem(dir, { uid: 1000, stat: fakeStat((p) => (p.endsWith('README') ? { mode: 0o100644 } : {})) })).toBeNull();
  });

  it.skipIf(!isLinux)('실제: chmod 644한 값 파일 하나로 문제가 생긴다 — 링크로 바꾼 값 파일도 (Linux — POSIX 권한과 링크가 있어야 본다)', async () => {
    const dir = secretsDirOf(tempData());
    await fileSecretBackend({ dir }).set('k', 'v');
    const file = join(dir, readdirSync(dir)[0]!);
    chmodSync(file, 0o644);
    expect(fileSecretStoreProblem(dir)).toMatch(/권한이 넓습니다 \(644\)/);
    rmSync(file);
    symlinkSync('/etc/hostname', file);
    expect(fileSecretStoreProblem(dir)).toMatch(/심볼릭 링크입니다/);
  });
});
