/**
 * Linux 묶음 (scripts/pack-linux.mjs — npm run pack:linux, SERVER_SETUP L2의 '묶음으로').
 * 묶음은 Linux PC에서 git clone·npm ci·빌드 없이 Node 24만으로 돌아야 한다. 그래서 만든 tar.gz를 OS의 tar로 저장소 밖(임시 폴더)에 풀고, 푼 것만으로 본다:
 * - 담긴 것: 빌드한 서버와 wook 명령, 웹 화면, resources, scripts/wook-server, 실행에 드는 꾸러미(package-lock.json의 개발용이 아닌 것 모두, 같은 판),
 *   문서와 AI용 문서, BUILD-INFO.json. 담기지 않은 것: 네이티브 모듈(@napi-rs — Linux 서버는 키링을 불러오지 않는다), 개발 도구, src·tests, 이 PC에서 컴파일한 것
 * - scripts/wook-server는 실행 권한(755), 글 파일은 LF — Windows에서 만들어도
 * - 푼 폴더에서 운영자 명령과 wook이 뜬다 — 저장소의 node_modules에 닿지 않는 곳이라, 빠진 꾸러미가 있으면 여기서 불러오기가 실패한다
 * - (Linux) 묶음의 서버가 뜨고 status에 답하고 shutdown으로 끝난다
 * 서버 빌드는 다른 서버 시험처럼 제 폴더(out/test-server-…)에 따로 하고, 웹 화면은 작은 가짜 폴더를 준다 — 이 시험은 묶는 일을 본다
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServerTo, childEnv, REPO, removeDir, runClient, startBuilt, testBuildDir } from './helpers';

/** OS의 tar — Windows는 System32의 bsdtar(Git의 GNU tar는 'C:'를 원격 호스트로 읽는다) */
const TAR = process.platform === 'win32' ? join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';

const buildDir = testBuildDir('bundle');
let work = '';
let tarball = '';
let root = '';
let packOut = '';

function run(cmd: string, args: string[], cwd: string): { code: number | null; stdout: string; stderr: string } {
  // NODE_PATH를 지운다 — 푼 묶음이 제 node_modules만으로 도는지 본다
  const { NODE_PATH: _nodePath, ...env } = childEnv();
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', windowsHide: true, env });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

beforeAll(() => {
  const serverDir = buildDir;
  buildServerTo(serverDir);
  work = mkdtempSync(join(tmpdir(), 'wook-test-bundle-'));
  const webDir = join(work, 'web');
  mkdirSync(join(webDir, 'assets'), { recursive: true });
  writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>욱채</title>\n');
  writeFileSync(join(webDir, 'assets', 'app.js'), 'export {};\n');

  const dist = join(work, 'dist');
  const pack = run(process.execPath, [join(REPO, 'scripts', 'pack-linux.mjs'), '--skip-build', '--server-dir', serverDir, '--web-dir', webDir, '--out', dist], REPO);
  expect([pack.code, pack.stderr]).toEqual([0, '']);
  packOut = pack.stdout;
  const made = readdirSync(dist).sort();
  expect(made.length).toBe(2);
  tarball = join(dist, made.find((n) => n.endsWith('.tar.gz'))!);

  const extract = join(work, 'x');
  mkdirSync(extract);
  const x = run(TAR, ['-xzf', tarball, '-C', extract], work);
  expect([x.code, x.stderr]).toEqual([0, '']);
  root = join(extract, 'wookagent');
}, 240_000);

afterAll(async () => {
  await removeDir(work);
  await removeDir(buildDir);
});

describe('Linux 묶음 — scripts/pack-linux.mjs', () => {
  it('이름은 wook-server-<판>-linux-<커밋 7자>.tar.gz이고, 곁의 .sha256 한 줄이 그 파일의 SHA-256이다 — 풀면 wookagent 폴더 하나', () => {
    const version = (JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { version: string }).version;
    const name = tarball.split(/[\\/]/).pop()!;
    expect(name).toMatch(new RegExp(`^wook-server-${version.replace(/\./g, '\\.')}-linux-[0-9a-f]{7}(-dirty)?\\.tar\\.gz$`));
    const sha = createHash('sha256').update(readFileSync(tarball)).digest('hex');
    expect(readFileSync(`${tarball}.sha256`, 'utf8')).toBe(`${sha}  ${name}\n`);
    expect(packOut).toContain(sha);
    expect(readdirSync(join(root, '..'))).toEqual(['wookagent']);
  });

  it('담긴 것: 서버·wook·웹 화면·resources·운영자 명령·문서·AI용 문서·BUILD-INFO — 담기지 않은 것: 네이티브 모듈, 개발 도구, 소스, 이 PC에서 컴파일한 것', () => {
    const has = (...p: string[]): boolean => existsSync(join(root, ...p));
    const present = [
      'package.json',
      'BUILD-INFO.json',
      'AGENTS.md',
      'CLAUDE.md',
      'README.md',
      'docs/ai/INSTALL.md',
      'docs/ai/OPERATE.md',
      'docs/ai/TROUBLESHOOT.md',
      'docs/ai/SYSTEM.md',
      'docs/SERVER_SETUP.md',
      'docs/SERVER_INSTALL.md',
      'docs/KNOWN_ISSUES.md',
      'docs/AGENT_GUIDE.md',
      'docs/기획서_v0.6_변경목록.md',
      'out/server/index.mjs',
      'out/server/wook.mjs',
      'out/server/serve.mjs',
      'out/web/index.html',
      'out/web/assets/app.js',
      'resources/desktophelper/x11Helper.mjs',
      'resources/desktophelper/x11Sidecar.py',
      'resources/mock-agent/mock-agent.mjs',
      'scripts/wook-server',
      'node_modules/zod/package.json',
      'node_modules/@modelcontextprotocol/sdk/package.json',
    ];
    expect(present.filter((p) => !has(...p.split('/')))).toEqual([]);
    const absent = [
      'node_modules/@napi-rs',
      'node_modules/vitest',
      'node_modules/vite',
      'node_modules/electron',
      'node_modules/typescript',
      'node_modules/.bin',
      'package-lock.json',
      'src',
      'tests',
      '.git',
      '.github',
      'packaging',
      'scripts/wook-server.cmd',
      'scripts/pack-linux.mjs',
      'resources/jobrunner/bin',
      'resources/desktophelper/bin',
    ];
    expect(absent.filter((p) => has(...p.split('/')))).toEqual([]);

    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Record<string, unknown>;
    const repoPkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { name: string; version: string };
    expect([pkg['name'], pkg['version'], pkg['devDependencies'], pkg['scripts']]).toEqual([repoPkg.name, repoPkg.version, undefined, undefined]);
    expect(Object.keys(pkg['dependencies'] as object).sort()).toEqual(['@modelcontextprotocol/sdk', 'zod']);

    const info = JSON.parse(readFileSync(join(root, 'BUILD-INFO.json'), 'utf8')) as Record<string, unknown>;
    expect([info['version'], info['node'], info['folder']]).toEqual([repoPkg.version, '>=24', 'wookagent']);
    expect(String(info['commit'])).toMatch(/^[0-9a-f]{40}$/);
  });

  it('실행에 드는 꾸러미는 package-lock.json의 개발용이 아닌 것 모두, 같은 판으로 — @napi-rs만 빠진다', () => {
    const lock = JSON.parse(readFileSync(join(REPO, 'package-lock.json'), 'utf8')) as { packages: Record<string, { version: string; dev?: boolean; devOptional?: boolean }> };
    const want = Object.entries(lock.packages).filter(([key, v]) => key !== '' && !v.dev && !v.devOptional && !key.includes('node_modules/@napi-rs/'));
    expect(want.length).toBeGreaterThan(50);
    const wrong = want.filter(([key, v]) => {
      const manifest = join(root, ...key.split('/'), 'package.json');
      return !existsSync(manifest) || (JSON.parse(readFileSync(manifest, 'utf8')) as { version: string }).version !== v.version;
    });
    expect(wrong.map(([key]) => key)).toEqual([]);
    // 개발용 꾸러미는 하나도 없다
    const dev = Object.entries(lock.packages).filter(([key, v]) => key !== '' && (v.dev || v.devOptional));
    expect(dev.length).toBeGreaterThan(50);
    expect(dev.filter(([key]) => existsSync(join(root, ...key.split('/'), 'package.json'))).map(([key]) => key)).toEqual([]);
  });

  it('scripts/wook-server는 실행 권한(755)으로, 나머지 파일은 644·폴더는 755로 담긴다 — 글 파일은 LF (Windows에서 만들어도)', () => {
    const list = run(TAR, ['-tvzf', tarball], work);
    expect(list.code).toBe(0);
    const lines = list.stdout.split(/\r?\n/).filter((l) => l.length > 0);
    const modeOf = (path: string): string | undefined => lines.find((l) => l.endsWith(` ${path}`))?.slice(0, 10);
    expect([modeOf('wookagent/scripts/wook-server'), modeOf('wookagent/out/server/index.mjs'), modeOf('wookagent/AGENTS.md'), modeOf('wookagent/scripts/')]).toEqual([
      '-rwxr-xr-x',
      '-rw-r--r--',
      '-rw-r--r--',
      'drwxr-xr-x',
    ]);
    // 실행 권한은 그 파일 하나뿐이다
    expect(lines.filter((l) => l.startsWith('-') && l.slice(0, 10) !== '-rw-r--r--').map((l) => l.slice(0, 10) + l.slice(l.lastIndexOf(' ')))).toEqual(['-rwxr-xr-x wookagent/scripts/wook-server']);
    if (process.platform !== 'win32') expect(statSync(join(root, 'scripts', 'wook-server')).mode & 0o777).toBe(0o755);
    for (const p of ['scripts/wook-server', 'AGENTS.md', 'docs/SERVER_DESIGN.md', 'docs/ARCHITECTURE.md', 'resources/desktophelper/x11Sidecar.py', 'resources/mock-agent/mock-agent.mjs']) {
      expect([p, readFileSync(join(root, ...p.split('/')), 'utf8').includes('\r')]).toEqual([p, false]);
    }
    expect(readFileSync(join(root, 'scripts', 'wook-server'), 'utf8').startsWith('#!/bin/sh\n')).toBe(true);
  });

  it('푼 폴더만으로 운영자 명령과 wook이 뜬다 — 저장소 밖이라 묶음의 node_modules만 쓴다', () => {
    // 임시 폴더는 저장소 밖이다 — 안이면 Node가 위 폴더의 node_modules를 찾아 빠진 꾸러미를 가린다
    expect(root.toLowerCase().startsWith(REPO.toLowerCase())).toBe(false);
    const help = run(process.execPath, [join(root, 'out', 'server', 'index.mjs'), '--help'], work);
    expect([help.code, help.stderr]).toEqual([0, '']);
    expect(help.stdout).toContain('wook-server install-task');
    const wook = run(process.execPath, [join(root, 'out', 'server', 'wook.mjs'), '--help'], work);
    expect([wook.code, wook.stderr, wook.stdout.includes('wook seat claim')]).toEqual([0, '', true]);
  });

  it.skipIf(process.platform === 'win32')('scripts/wook-server를 그대로 치면 뜬다 — 푼 파일의 실행 권한과 #!/bin/sh로 (POSIX)', () => {
    const direct = run(join(root, 'scripts', 'wook-server'), ['--help'], work);
    expect([direct.code, direct.stdout.includes('wook-server install-task')]).toEqual([0, true]);
  });

  it.skipIf(process.platform !== 'linux')('묶음의 서버가 뜨고 status에 답하고 shutdown으로 끝난다 — 묶음의 꾸러미만으로 (Linux)', async () => {
    const entry = join(root, 'out', 'server', 'index.mjs');
    const dataDir = join(work, 'data');
    const srv = await startBuilt({ entry, dataDir });
    try {
      const status = runClient(entry, ['status', '--data-dir', dataDir]);
      expect([status.code, status.stderr]).toEqual([0, '']);
      // 서버 기록(<데이터 폴더>/logs/server.log): 판은 묶음의 package.json에서 읽은 것이고, 비밀 값은 파일 저장소라 키링 모듈이 없다는 경고가 없다
      const version = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version;
      const log = readFileSync(join(dataDir, 'logs', 'server.log'), 'utf8');
      expect(log).toContain(`욱채 서버 시작 v${version}`);
      expect(log + srv.stderr() + srv.stdout()).not.toContain('@napi-rs/keyring');
    } finally {
      const down = runClient(entry, ['shutdown', '--data-dir', dataDir]);
      const exit = await Promise.race([srv.exited, new Promise<null>((r) => setTimeout(() => r(null), 40_000))]);
      if (!exit) srv.child.kill('SIGKILL');
      expect([down.code, exit?.code]).toEqual([0, 0]);
      await removeDir(dataDir);
    }
  });
});
