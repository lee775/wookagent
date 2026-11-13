/**
 * Linux에서 서버를 띄우기 전의 확인과 systemd 아래의 설정 코드 (리드 결정 S10-6.4, src/server/serveLinux.ts·serve.ts).
 * - root(uid 0)는 띄우지 않는다, 관리 소켓 `<데이터 폴더>/admin.sock`이 107바이트를 넘으면 까닭(바이트 수와 한도)을 말한다 — 둘 다 데이터 폴더를 만들기 전에.
 *   순수 판단은 어느 OS에서나, 실제 runServe 길은 Linux에서: 긴 실제 경로로 runServe가 1과 그 글을 내고 폴더를 만들지 않는다. 같은 경로에 Node가 직접 들으면
 *   EINVAL로만 끝난다(제품이 그 전에 말하는 까닭)
 * - /proc 확인(S10a linuxProcProblem의 자리 — serveLinux.procProblem): 읽지 못하거나 비면 그 글. 비밀 값 폴더가 넓게 열려 있으면(Linux) runServe가 잠금 전에 1
 * - systemd 아래(INVOCATION_ID·JOURNAL_STREAM)에서는 설정 코드를 표준 출력(저널)에 내지 않고 파일만 가리킨다 — 빌드한 서버를 INVOCATION_ID로 띄워 본다
 *   (대표가 없는 새 데이터 폴더 — 메인 턴은 돌지 않는다, 끝에 모의가 아닌 메인 턴이 없는지 본다). systemd 밖의 글은 예전 그대로
 * 잡는 결함: root 서버, 긴 경로의 알 수 없는 EINVAL, 넓은 비밀 값 폴더로 시작, 저널에 남는 설정 코드
 */
import { chmodSync, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { openStore } from '../../src/main/db/store';
import { dataPaths } from '../../src/main/orchestrator/paths';
import { runServe } from '../../src/server/serve';
import { SCREEN_SESSION_TEXT } from '../../src/main/desktop/screenSession';
import { linuxProcProblem } from '../../src/main/process/procfs';
import { adminSocketPathProblem, linuxPreStartProblem, procProblem, ROOT_REFUSAL, setupCodeConsoleText, SOCKET_PATH_MAX_BYTES, underSystemd } from '../../src/server/serveLinux';
import { buildServerTo, REPO, removeDir, runClient, seedServerHelper, sleep, startBuilt, testBuildDir, workspaceArgs, type BuiltServer } from './helpers';
import { spawn, type ChildProcess } from 'node:child_process';

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await removeDir(d);
});
const temp = (tag: string): string => {
  const d = mkdtempSync(join(tmpdir(), `wook-test-servelinux-${tag}-`));
  dirs.push(d);
  return d;
};

/** 바이트 수가 정확히 n인 데이터 폴더 경로 (/로 시작, 끝에 admin.sock을 붙이면 n + 11) */
function dirOfBytes(n: number, korean = false): string {
  const unit = korean ? '가' : 'a';
  const per = Buffer.byteLength(unit, 'utf8');
  const fill = n - 1;
  return `/${unit.repeat(Math.floor(fill / per))}${'b'.repeat(fill % per)}`;
}

describe('띄우기 전의 확인 — 순수 판단 (모든 OS)', () => {
  it('Linux에서만: root는 그 글, 관리 소켓 경로가 107바이트를 넘으면 바이트 수와 한도(한글은 3바이트) — 107바이트까지는 된다', () => {
    expect(linuxPreStartProblem({ platform: 'win32', uid: 0, dataDir: dirOfBytes(300) })).toBeNull();
    expect(linuxPreStartProblem({ platform: 'linux', uid: 0, dataDir: '/srv/d' })).toBe(ROOT_REFUSAL);
    const ok = dirOfBytes(SOCKET_PATH_MAX_BYTES - '/admin.sock'.length);
    expect(Buffer.byteLength(join(ok, 'admin.sock'))).toBe(SOCKET_PATH_MAX_BYTES);
    expect(linuxPreStartProblem({ platform: 'linux', uid: 1000, dataDir: ok })).toBeNull();
    const over = `${ok}b`;
    expect(linuxPreStartProblem({ platform: 'linux', uid: 1000, dataDir: over })).toBe(adminSocketPathProblem(over));
    expect(adminSocketPathProblem(over)).toMatch(/108바이트로 Linux의 한도 107바이트를 넘습니다\. 96바이트 이하\(UTF-8 — 한글 한 글자는 3바이트\)의 데이터 폴더를 --data-dir로 주세요$/);
    // 한글 32자(96바이트)는 글자 수로는 짧아도 넘는다
    const hangul = `/${'가'.repeat(33)}`;
    expect(hangul.length < 40 && adminSocketPathProblem(hangul) !== null).toBe(true);
  });

  it('/proc 확인은 프로세스 갈래의 linuxProcProblem 그대로 — 읽지 못하는 뿌리면 그 글 (자세한 경우는 procfs.test)', () => {
    const none = join(tmpdir(), 'wook-test-no-such-proc-root');
    expect(procProblem(none)).toBe(linuxProcProblem(none));
    expect(procProblem(none)).toContain('를 읽지 못합니다');
    if (process.platform === 'linux') expect(procProblem()).toBeNull();
  });

  it('출력이 systemd 저널로 가면(JOURNAL_STREAM의 장치:inode가 표준 출력·오류와 같다) 설정 코드를 콘솔에 내지 않고 파일만 — 새어 든 변수만으로는 아니다, 밖이면 예전 글 그대로 (S10-13)', () => {
    const fds: Record<number, { dev: bigint; ino: bigint }> = { 1: { dev: 8n, ino: 100n }, 2: { dev: 8n, ino: 200n } };
    const fstat = (fd: number): { dev: bigint; ino: bigint } => fds[fd]!;
    expect([
      underSystemd({}, fstat),
      underSystemd({ INVOCATION_ID: 'x' }, fstat),
      underSystemd({ JOURNAL_STREAM: '8:100' }, fstat),
      underSystemd({ JOURNAL_STREAM: '8:200' }, fstat),
      // 데스크톱 터미널로 새어 든 값 — 이 프로세스의 출력이 아니다
      underSystemd({ JOURNAL_STREAM: '8:999' }, fstat),
      underSystemd({ JOURNAL_STREAM: 'x' }, fstat),
    ]).toEqual([false, false, true, true, false, false]);
    const base = { code: 'ABCD-EFGH', until: '오늘', file: '/d/setup-code.txt' };
    expect(setupCodeConsoleText({ ...base, fileWritten: true, systemd: false })).toBe(
      '대표 이메일이 아직 정해지지 않았습니다. 설정 코드 ABCD-EFGH (오늘까지, 한 번만 — /d/setup-code.txt에도 적었습니다)를 웹 화면의 서버 설정에 대표 이메일과 함께 넣거나, 운영자가 wook-server config owner-email <이메일>로 정하세요.\n',
    );
    for (const fileWritten of [true, false]) {
      const t = setupCodeConsoleText({ ...base, fileWritten, systemd: true });
      expect([fileWritten, t.includes('ABCD'), t.includes('/d/setup-code.txt')]).toEqual([fileWritten, false, true]);
    }
  });
});

describe.runIf(process.platform === 'linux')('runServe의 거부 — 실제 경로 (Linux)', () => {
  const io = () => {
    let err = '';
    return { io: { out: async () => undefined, err: async (t: string) => void (err += t), exit: () => undefined }, err: () => err };
  };
  const opts = (dataDir: string) => ({ dataDir, bind: '127.0.0.1', port: 0, webDir: null, allowTestSession: false });

  it('긴 데이터 폴더: Node가 직접 들으면 EINVAL뿐이다 — runServe는 그 전에 바이트 수와 한도를 말하고 1, 폴더를 만들지 않는다', async () => {
    const base = temp('long');
    const long = join(base, 'x'.repeat(Math.max(1, SOCKET_PATH_MAX_BYTES - Buffer.byteLength(base) - 1)), '데이터');
    const sock = join(long, 'admin.sock');
    expect(Buffer.byteLength(sock)).toBeGreaterThan(SOCKET_PATH_MAX_BYTES);
    // 제품이 막는 까닭 — Node(libuv)에 그대로 주면
    mkdirSync(long, { recursive: true });
    const code = await new Promise<string>((resolve) => {
      const s = createServer();
      s.once('error', (e: NodeJS.ErrnoException) => resolve(e.code ?? 'error'));
      s.listen(sock, () => s.close(() => resolve('listened')));
    });
    expect(code).toBe('EINVAL');
    expect(existsSync(sock)).toBe(false);
    const fresh = join(base, 'x'.repeat(Math.max(1, SOCKET_PATH_MAX_BYTES - Buffer.byteLength(base) - 1)), '새 데이터');
    const t = io();
    expect(await runServe(opts(fresh), t.io)).toBe(1);
    expect(t.err()).toBe(`욱채 서버를 시작하지 못했습니다: ${adminSocketPathProblem(fresh)}\n`);
    expect(existsSync(fresh)).toBe(false);
  });

  it('비밀 값 폴더가 넓게 열려 있으면(0755) 잠금 전에 1 — chmod 700 고칠 줄, 잠금 파일·기록이 없다', async () => {
    const data = temp('secrets');
    mkdirSync(join(data, 'secrets'), { mode: 0o700 });
    chmodSync(join(data, 'secrets'), 0o755);
    const t = io();
    expect(await runServe(opts(data), t.io)).toBe(1);
    expect(t.err()).toContain(`chmod 700 '${join(data, 'secrets')}'`);
    expect([existsSync(join(data, 'server.lock')), existsSync(join(data, 'logs'))]).toEqual([false, false]);
  });

  it('데이터 폴더가 가리키는 곳이 없는 링크면 1 — 까닭(링크에 적힌 곳)과 할 일을 말한다, rename의 ENOTDIR만이 아니다 (S10-16 FPS-3)', async () => {
    const base = temp('dangling');
    const link = join(base, 'wook-data');
    const target = join(base, 'not-mounted', 'wook');
    symlinkSync(target, link);
    const t = io();
    expect(await runServe(opts(link), t.io)).toBe(1);
    expect(t.err()).toBe(
      `욱채 서버를 시작하지 못했습니다: 데이터 폴더를 준비하지 못했습니다 (${link}) — 데이터 폴더가 링크인데 가리키는 곳이 없습니다 (링크 → ${target}) — 서버는 그 자리에 폴더를 만들 수 없습니다. 가리키는 곳의 디스크를 붙이거나(mount) 그 폴더를 만들거나, 링크를 고치세요\n`,
    );
    expect([readdirSync(base), lstatSync(link).isSymbolicLink()]).toEqual([['wook-data'], true]);
  });

  it('위 폴더가 가리키는 곳이 없는 링크면(붙지 않은 디스크) 1 — 그 위 폴더와 할 일을 말한다, mkdir의 ENOENT만이 아니다. 무엇도 만들지 않는다 (S10-16b)', async () => {
    const base = temp('dangling-parent');
    const link = join(base, 'wook');
    const target = join(base, 'not-mounted');
    symlinkSync(target, link);
    const dataDir = join(link, 'wook-data');
    const t = io();
    expect(await runServe(opts(dataDir), t.io)).toBe(1);
    expect(t.err()).toBe(
      `욱채 서버를 시작하지 못했습니다: 데이터 폴더를 준비하지 못했습니다 (${dataDir}) — 데이터 폴더 경로의 위 폴더(${link})가 링크인데 가리키는 곳이 없습니다 (링크 → ${target}) — 서버는 데이터 폴더를 만들 수 없습니다. 가리키는 곳의 디스크를 붙이거나(mount) 그 폴더를 만들거나, 링크를 고치세요\n`,
    );
    expect(readdirSync(base)).toEqual(['wook']);
  });
});

/** 모의 메인을 켠 새 데이터 폴더 — 시작 전에 (리드 결정 S10-0, S10-13 TD-12). 대표는 없다 */
function seededDataDir(tag: string): string {
  const d = temp(tag);
  const store = openStore(dataPaths(d).db);
  try {
    store.kv.set('settings', { developer: { mainAgentMock: true } });
  } finally {
    store.close();
  }
  return d;
}

/** 끝난 서버의 데이터: 모의가 아닌 메인 턴이 없고 모의 메인이 끝까지 켜져 있었다 */
function expectMockOnly(dataDir: string): void {
  const store = openStore(dataPaths(dataDir).db);
  try {
    expect(store.turns.list({ ref1: 'M-MAIN' }).filter((t) => !t.mock)).toEqual([]);
    expect(store.kv.get<{ developer?: { mainAgentMock?: boolean } }>('settings')?.developer?.mainAgentMock).toBe(true);
  } finally {
    store.close();
  }
}

/**
 * 저널로 가는 출력의 설정 코드 — 빌드한 서버의 표준 오류를 시험의 파일로 돌리고 JOURNAL_STREAM에 그 파일의 장치:inode를 적는다(systemd가 하는 그대로).
 * 서버의 표준 오류가 그 '저널'이므로 서버는 코드를 표준 출력에 내지 않고 파일만 가리킨다 (S10-6.4, S10-13)
 */
describe('저널로 가는 출력의 설정 코드 — 빌드한 서버 (JOURNAL_STREAM = 표준 오류의 장치:inode)', () => {
  let outDir = '';
  let entry = '';
  let child: ChildProcess | null = null;
  let dataDir = '';

  afterAll(async () => {
    if (child && child.exitCode === null) {
      runClient(entry, ['shutdown', '--data-dir', dataDir]);
      await Promise.race([new Promise((r) => child!.once('exit', r)), sleep(40_000)]);
      if (child.exitCode === null) child.kill();
    }
    if (outDir) await removeDir(outDir);
  }, 120_000);

  it('표준 출력에는 코드 없이 파일만 가리키고, setup-code.txt에는 코드가 있다 — 메인 턴은 모두 모의다', async () => {
    outDir = testBuildDir('servelinux');
    entry = buildServerTo(outDir);
    dataDir = seededDataDir('journal');
    seedServerHelper(dataDir);
    const journal = join(temp('journal-file'), 'journal.txt');
    const fd = openSync(journal, 'w');
    let out = '';
    try {
      const st = fstatSync(fd, { bigint: true });
      child = spawn(process.execPath, [entry, 'serve', '--data-dir', dataDir, '--port', '0', ...workspaceArgs(dataDir)], {
        cwd: REPO,
        env: { ...process.env, JOURNAL_STREAM: `${st.dev}:${st.ino}` },
        stdio: ['ignore', 'pipe', fd],
        windowsHide: true,
      });
    } finally {
      closeSync(fd);
    }
    const exited = new Promise<number | null>((r) => child!.once('exit', (c) => r(c)));
    child.stdout!.setEncoding('utf8').on('data', (c: string) => (out += c));
    const until = Date.now() + 60_000;
    while (!out.includes('대표 이메일이 아직 정해지지 않았습니다') && Date.now() < until && child.exitCode === null) await sleep(50);
    const file = join(dataDir, 'setup-code.txt');
    const code = /코드: ([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(readFileSync(file, 'utf8'))?.[1] ?? '';
    expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(out).toContain(`설정 코드는 ${file}에 적었습니다`);
    expect([out.includes(code), out.includes(code.replace('-', '')), readFileSync(journal, 'utf8').includes(code)]).toEqual([false, false, false]);
    expect(runClient(entry, ['shutdown', '--data-dir', dataDir]).code).toBe(0);
    expect(await exited).toBe(0);
    expectMockOnly(dataDir);
  }, 240_000);
});

/**
 * Linux 화면 칸이 실행 중인 서버에 닿는다 (리드 결정 S10-10.1 — S10c의 server.json screen.display·xauthority·typeWithoutA11y): serve가 시작할 때 읽어 백엔드의 화면 세션에
 * 넘기고, 시작 뒤 그 칸이 바뀐 reload는 '다시 시작해야 바뀝니다'를 말한다. 빌드한 서버를 screen.display가 든 server.json으로 띄운다 — 실제 X 화면은 없고, 시험(VITEST)
 * 중에는 Linux 화면 도우미의 문이 닫혀 있어 아무것도 띄우지 않는다. 화면 상태가 그것을 보인다: 그 칸이 백엔드에 닿지 않으면 서버의 화면 세션은 '화면 없음'(no_desktop —
 * 시험 중 서버의 환경은 비어 있다)이고, 닿으면 X11 화면이 정해져 도우미의 차례까지 간다(시험의 문 때문에 helper_failed). 대표가 없는 새 데이터 폴더 — 메인 턴은 돌지 않는다
 * 잡는 결함: serve가 screen.enabled만 넘김(S10c의 요청 1), reload가 시작 때의 화면 칸을 몰라 경고하지 않음
 */
describe.runIf(process.platform === 'linux')('Linux 화면 칸이 실행 중인 서버에 닿는다 — 빌드한 서버 (S10-10.1)', () => {
  let outDir = '';
  let entry = '';
  let srv: BuiltServer | null = null;
  let dataDir = '';

  afterAll(async () => {
    if (srv && srv.child.exitCode === null) {
      runClient(entry, ['shutdown', '--data-dir', dataDir]);
      await Promise.race([srv.exited, sleep(40_000)]);
      if (srv.child.exitCode === null) srv.child.kill();
    }
    if (outDir) await removeDir(outDir);
  }, 120_000);

  it('server.json의 screen.display로 띄운 서버는 그 X 화면을 쓴다(no_desktop이 아니다) — 바꾼 뒤 reload는 다시 시작해야 바뀐다고 말하고 상태는 그대로', async () => {
    outDir = testBuildDir('servescreen');
    entry = buildServerTo(outDir);
    dataDir = seededDataDir('screen');
    const config = join(dataDir, 'server.json');
    writeFileSync(config, JSON.stringify({ screen: { display: ':97', typeWithoutA11y: false } }));
    srv = await startBuilt({ entry, dataDir });
    const status = (): { state: string; detail: string } => {
      const r = runClient(entry, ['status', '--json', '--data-dir', dataDir]);
      return (JSON.parse(r.stdout) as { result: { screen: { state: string; detail: string } } }).result.screen;
    };
    const first = status();
    expect(first.state).not.toBe('no_desktop');
    expect(first.detail).not.toContain(SCREEN_SESSION_TEXT.no_desktop);
    expect(first.state).toBe('helper_failed');
    writeFileSync(config, JSON.stringify({ screen: { display: ':96', typeWithoutA11y: true } }));
    const reload = runClient(entry, ['config', 'reload', '--data-dir', dataDir]);
    expect(reload.code).toBe(0);
    expect(reload.stdout).toContain('경고: server.json의 screen.display는 서버를 다시 시작해야 바뀝니다 — 지금은 시작할 때의 값을 씁니다');
    expect(reload.stdout).toContain('경고: server.json의 screen.typeWithoutA11y는 서버를 다시 시작해야 바뀝니다');
    expect(status()).toEqual(first);
    expect(runClient(entry, ['shutdown', '--data-dir', dataDir]).code).toBe(0);
    await srv.exited;
    expectMockOnly(dataDir);
  }, 240_000);
});
