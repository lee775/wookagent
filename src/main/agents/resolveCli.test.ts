import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  VERIFIED_VERSIONS,
  cliLauncherEnv,
  codexNativeFromPackageRoot,
  detectCli,
  parseClaudeAuthStatus,
  parseCliVersion,
  parseCodexLoginStatus,
  resolveCli,
  type CommandResult,
  type ResolvedCli,
} from './resolveCli';

const res = (o: Partial<CommandResult>): CommandResult => ({ code: 0, stdout: '', stderr: '', timedOut: false, error: null, ...o });

describe('버전 해석과 받는 버전 (CLI-15, 리드 결정 S10-38)', () => {
  it.each([
    ['claude', '2.1.311 (Claude Code)\n', '2.1.311'],
    ['claude', '2.1.0', '2.1.0'],
    ['codex', 'codex-cli 0.163.0\n', '0.163.0'],
    ['codex', 'codex 0.160.1-alpha.2', '0.160.1-alpha.2'],
    ['claude', 'claude: command not found', null],
    ['codex', '', null],
    // 새 판이 글의 꼴을 바꿔도 읽는다 — 앞의 v, 달라진 이름
    ['codex', 'OpenAI Codex v1.2.0\n', '1.2.0'],
    ['codex', 'Codex CLI 0.171.3', '0.171.3'],
    ['claude', 'Claude Code v3.0.1', '3.0.1'],
    // 버전이 아닌 점 숫자(주소)는 버전으로 읽지 않는다
    ['codex', 'error: could not reach 127.0.0.1', null],
    ['codex', 'weird output', null],
  ] as const)('%s %j → %s', (kind, out, v) => {
    expect(parseCliVersion(kind, out)).toBe(v);
  });

  it.each([
    ['claude', '2.1.0', true],
    ['claude', '2.1.999', true],
    ['claude', '2.0.77', false],
    ['claude', '1.9.9', false],
    // 확인한 범위보다 새 버전도 받는다 — 작은 판·큰 판 모두
    ['claude', '2.2.0', true],
    ['claude', '3.1.0', true],
    ['codex', '0.160.0', true],
    ['codex', '0.169.12', true],
    ['codex', '0.159.9', false],
    ['codex', '0.170.0', true],
    ['codex', '0.171.0', true],
    ['codex', '1.0.0', true],
    ['codex', '1.163.0', true],
    ['codex', 'not-a-version', false],
  ] as const)('%s %s 받는가 %s', (kind, v, ok) => {
    expect(VERIFIED_VERSIONS[kind].test(v)).toBe(ok);
  });

  it.each([
    ['claude', '2.1.999', false],
    ['claude', '2.2.0', true],
    ['claude', '3.0.0', true],
    ['codex', '0.169.12', false],
    ['codex', '0.170.0', true],
    ['codex', '0.171.0', true],
    ['codex', '1.0.0', true],
    // 가장 낮은 버전보다 낮은 것은 '새 버전'이 아니다
    ['codex', '0.159.9', false],
  ] as const)('%s %s 확인한 범위보다 새 버전인가 %s', (kind, v, newer) => {
    expect(VERIFIED_VERSIONS[kind].newer(v)).toBe(newer);
  });

  it('가장 낮은 버전을 글로 내놓는다', () => {
    expect([VERIFIED_VERSIONS.claude.min, VERIFIED_VERSIONS.codex.min]).toEqual(['2.1.0', '0.160.0']);
  });
});

describe('로그인 상태 해석', () => {
  it('claude auth status --json', () => {
    expect(parseClaudeAuthStatus(res({ stdout: '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}' }))).toEqual({ loggedIn: true, detail: 'claude.ai' });
    expect(parseClaudeAuthStatus(res({ code: 1, stdout: '{\n  "loggedIn": false,\n  "authMethod": "none"\n}' }))).toEqual({ loggedIn: false, detail: '' });
    expect(parseClaudeAuthStatus(res({ code: 1, stdout: 'Not logged in. Run claude auth login to authenticate.' }))).toEqual({ loggedIn: false, detail: '' });
    expect(parseClaudeAuthStatus(res({ code: null, error: 'ETIMEDOUT' })).loggedIn).toBeNull();
    expect(parseClaudeAuthStatus(res({ timedOut: true })).loggedIn).toBeNull();
    expect(parseClaudeAuthStatus(res({ stdout: 'something else' })).loggedIn).toBeNull();
  });

  it('codex login status', () => {
    expect(parseCodexLoginStatus(res({ stderr: 'Logged in using ChatGPT\n' }))).toEqual({ loggedIn: true, detail: 'ChatGPT' });
    expect(parseCodexLoginStatus(res({ stdout: 'Logged in using an API key - sk-proj-***ABCD' }))).toEqual({ loggedIn: true, detail: 'API 키' });
    expect(parseCodexLoginStatus(res({ code: 1, stdout: 'Not logged in' }))).toEqual({ loggedIn: false, detail: '' });
    expect(parseCodexLoginStatus(res({ stdout: '' })).loggedIn).toBeNull();
  });
});

describe('detectCli (주입한 실행 결과)', () => {
  const cli: ResolvedCli = { kind: 'codex', path: 'C:\\x\\codex.exe', source: 'path', npmPackageRoot: 'C:\\npm\\node_modules\\@openai\\codex', note: 'PATH에서 찾음' };

  it('버전 해석 실패·시간 초과는 problem', async () => {
    const garbled = await detectCli('codex', { resolved: { ok: true, cli }, run: async () => res({ stdout: 'weird output' }) });
    expect(garbled.problem).toMatch(/버전을 해석하지 못했습니다: weird output/);
    const slow = await detectCli('codex', { resolved: { ok: true, cli }, run: async () => res({ code: null, timedOut: true }), timeoutMs: 5000 });
    expect(slow.problem).toMatch(/5초 안에 끝나지 않았습니다/);
  });

  const versionRun = (text: string) => async (_f: string, args: readonly string[]) => (args[0] === '--version' ? res({ stdout: text }) : res({ stderr: 'Logged in using ChatGPT\n' }));

  it('확인한 범위보다 새 버전은 문제가 아니다 — 그대로 쓰고 상세 글에만 적는다 (리드 결정 S10-38)', async () => {
    for (const text of ['codex-cli 0.170.0', 'codex-cli 0.171.0', 'codex-cli 1.0.0', 'OpenAI Codex v2.4.1']) {
      const st = await detectCli('codex', { resolved: { ok: true, cli }, run: versionRun(text) });
      expect([text, st.installed, st.problem, st.loggedIn]).toEqual([text, true, null, true]);
      expect(st.detail).toContain('확인한 범위(codex-cli 0.160–0.169)보다 새 버전 — 그대로 씁니다');
    }
    // 확인한 범위 안이면 그 줄이 없다
    for (const text of ['codex-cli 0.163.0', 'codex-cli 0.169.4']) {
      const st = await detectCli('codex', { resolved: { ok: true, cli }, run: versionRun(text) });
      expect([text, st.problem]).toEqual([text, null]);
      expect(st.detail).not.toContain('새 버전');
    }
  });

  it('받는 가장 낮은 버전보다 낮으면 problem — 업데이트하라고 알린다', async () => {
    const st = await detectCli('codex', { resolved: { ok: true, cli }, run: versionRun('codex-cli 0.159.9') });
    expect(st.version).toBe('0.159.9');
    expect(st.problem).toBe('받는 가장 낮은 버전(0.160.0)보다 낮습니다: 0.159.9. Codex를 업데이트하세요 — 그때까지 새 작업을 멈춥니다');
    expect(st.detail).toContain(st.problem!);
    expect(st.detail).not.toContain('새 버전');
  });

  it('npm 설치본이면 상태 확인에도 런처 환경 변수를 넣는다', async () => {
    const envs: Record<string, string | undefined>[] = [];
    await detectCli('codex', {
      resolved: { ok: true, cli },
      env: { PATH: 'C:\\Windows' },
      statusEnv: { CODEX_API_KEY: 'k' },
      platform: 'win32',
      run: async (_f, args, o) => {
        envs.push(o.env);
        return args[0] === '--version' ? res({ stdout: 'codex-cli 0.163.0' }) : res({ stdout: 'Logged in using an API key' });
      },
    });
    expect(envs[1]).toMatchObject({ CODEX_MANAGED_BY_NPM: '1', CODEX_MANAGED_PACKAGE_ROOT: cli.npmPackageRoot, CODEX_API_KEY: 'k', PATH: 'C:\\Windows' });
    expect(cliLauncherEnv({ ...cli, npmPackageRoot: null })).toEqual({});
  });

  it('찾지 못하면 installed=false + 사유', async () => {
    const st = await detectCli('claude', { resolved: { ok: false, reason: '못 찾음' } });
    expect(st).toEqual({ installed: false, path: null, version: null, loggedIn: null, problem: '못 찾음', detail: '못 찾음' });
  });
});

// 실제 파일 배치로 확인 (Windows 경로 규칙)
describe.runIf(process.platform === 'win32')('resolveCli — Windows 설치 배치', () => {
  let root: string;
  const CODEX_SHIM = '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n';
  const TRIPLE = 'x86_64-pc-windows-msvc';

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'wook-test-resolve-'));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function touch(file: string, content = '') {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  async function npmCodex(dir: string, layout: 'nested' | 'hoisted' | 'legacy' | 'none') {
    const pkg = path.join(dir, 'node_modules', '@openai', 'codex');
    await touch(path.join(dir, 'codex.cmd'), CODEX_SHIM);
    await touch(path.join(dir, 'codex.ps1'), '# shim');
    await touch(path.join(dir, 'codex'), '#!/bin/sh\nexec node "$basedir/node_modules/@openai/codex/bin/codex.js" "$@"\n');
    await touch(path.join(pkg, 'package.json'), JSON.stringify({ name: '@openai/codex', version: '0.163.0' }));
    await touch(path.join(pkg, 'bin', 'codex.js'), '// launcher');
    const manifest = JSON.stringify({ layoutVersion: 1, version: '0.163.0', target: TRIPLE, variant: 'codex', entrypoint: 'bin/codex.exe' });
    if (layout === 'nested') {
      const v = path.join(pkg, 'node_modules', '@openai', 'codex-win32-x64', 'vendor', TRIPLE);
      await touch(path.join(v, 'codex-package.json'), manifest);
      await touch(path.join(v, 'bin', 'codex.exe'), 'MZ');
      return { pkg, exe: path.join(v, 'bin', 'codex.exe') };
    }
    if (layout === 'hoisted') {
      const v = path.join(dir, 'node_modules', '@openai', 'codex-win32-x64', 'vendor', TRIPLE);
      await touch(path.join(v, 'codex-package.json'), manifest);
      await touch(path.join(v, 'bin', 'codex.exe'), 'MZ');
      return { pkg, exe: path.join(v, 'bin', 'codex.exe') };
    }
    if (layout === 'legacy') {
      const exe = path.join(pkg, 'vendor', TRIPLE, 'codex', 'codex.exe');
      await touch(exe, 'MZ');
      return { pkg, exe };
    }
    return { pkg, exe: null };
  }
  const envFor = (pathDirs: string[], home = path.join(root, 'empty-home')) => ({ Path: pathDirs.join(';'), USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming') });

  it('PATH 앞 폴더부터, 따옴표 친 항목도 읽는다', async () => {
    const a = path.join(root, 'path a');
    const b = path.join(root, 'path b');
    await touch(path.join(b, 'claude.exe'), 'MZ');
    await touch(path.join(root, 'path c', 'claude.exe'), 'MZ');
    const r = await resolveCli('claude', { platform: 'win32', env: envFor([a, `"${b}"`, path.join(root, 'path c')]) });
    expect(r).toEqual({ ok: true, cli: { kind: 'claude', path: path.join(b, 'claude.exe'), source: 'path', npmPackageRoot: null, note: 'PATH에서 찾음' } });
  });

  it.each(['nested', 'hoisted', 'legacy'] as const)('npm codex.cmd → 네이티브 codex.exe (%s 배치), .cmd는 절대 돌려주지 않는다', async (layout) => {
    const dir = path.join(root, `npm-${layout}`);
    const { pkg, exe } = await npmCodex(dir, layout);
    const r = await resolveCli('codex', { platform: 'win32', arch: 'x64', env: envFor([dir]) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.cli.path).toBe(exe);
    expect(r.cli.path.toLowerCase().endsWith('.exe')).toBe(true);
    expect(r.cli.npmPackageRoot).toBe(pkg);
    expect(r.cli.source).toBe('path');
  });

  it('npm 패키지에 이 OS용 실행 파일이 없으면 사유와 함께 실패', async () => {
    const dir = path.join(root, 'npm-none');
    await npmCodex(dir, 'none');
    const r = await resolveCli('codex', { platform: 'win32', arch: 'x64', env: envFor([dir]) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/이 OS용 codex 실행 파일이 없습니다/);
  });

  it('pnpm처럼 shim이 다른 위치를 가리키면 shim 내용의 경로를 따른다', async () => {
    const shimDir = path.join(root, 'pnpm');
    const store = path.join(shimDir, 'global', '5');
    const { exe } = await npmCodex(store, 'nested');
    await touch(path.join(shimDir, 'codex.cmd'), '@SETLOCAL\r\n@"%~dp0\\global\\5\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n');
    const r = await resolveCli('codex', { platform: 'win32', arch: 'x64', env: envFor([shimDir]) });
    expect(r.ok && r.cli.path).toBe(exe);
  });

  it('arm64는 codex-win32-arm64 / aarch64-pc-windows-msvc', async () => {
    const pkg = path.join(root, 'arm', 'node_modules', '@openai', 'codex');
    const exe = path.join(pkg, 'node_modules', '@openai', 'codex-win32-arm64', 'vendor', 'aarch64-pc-windows-msvc', 'bin', 'codex.exe');
    await touch(exe, 'MZ');
    expect(await codexNativeFromPackageRoot(pkg, 'win32', 'arm64')).toBe(exe);
    expect(await codexNativeFromPackageRoot(pkg, 'win32', 'x64')).toBeNull();
    expect(await codexNativeFromPackageRoot(pkg, 'win32', 'ia32')).toBeNull();
  });

  it('설정 경로: .exe 파일·폴더는 그대로, 없는 파일·상대 경로·npm .cmd(네이티브 없음)는 사유', async () => {
    const exe = path.join(root, 'custom', 'claude.exe');
    await touch(exe, 'MZ');
    expect(await resolveCli('claude', { platform: 'win32', override: exe, env: envFor([]) })).toMatchObject({ ok: true, cli: { path: exe, source: 'settings' } });
    expect(await resolveCli('claude', { platform: 'win32', override: `"${path.dirname(exe)}"`, env: envFor([]) })).toMatchObject({ ok: true, cli: { path: exe } });
    const missing = await resolveCli('claude', { platform: 'win32', override: path.join(root, 'nope', 'claude.exe'), env: envFor([]) });
    expect(!missing.ok && missing.reason).toMatch(/설정한 Claude Code 실행 파일이 없습니다/);
    const rel = await resolveCli('claude', { platform: 'win32', override: 'bin\\claude.exe', env: envFor([]) });
    expect(!rel.ok && rel.reason).toMatch(/절대 경로/);
    const cmd = path.join(root, 'npm-claude', 'claude.cmd');
    await touch(cmd, '@"%~dp0\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*');
    const shim = await resolveCli('claude', { platform: 'win32', override: cmd, env: envFor([]) });
    expect(!shim.ok && shim.reason).toMatch(/직접 띄울 수 없습니다/);
  });

  it('설정 경로의 codex.cmd도 네이티브로 바꾼다', async () => {
    const dir = path.join(root, 'npm-override');
    const { exe } = await npmCodex(dir, 'nested');
    const r = await resolveCli('codex', { platform: 'win32', arch: 'x64', override: path.join(dir, 'codex.cmd'), env: envFor([]) });
    expect(r).toMatchObject({ ok: true, cli: { path: exe, source: 'settings' } });
  });

  it('PATH에 없으면 기본 설치 위치(~/.local/bin/claude.exe, %APPDATA%/npm)', async () => {
    const home = path.join(root, 'home-known');
    await touch(path.join(home, '.local', 'bin', 'claude.exe'), 'MZ');
    const r = await resolveCli('claude', { platform: 'win32', env: envFor([], home) });
    expect(r).toMatchObject({ ok: true, cli: { path: path.join(home, '.local', 'bin', 'claude.exe'), source: 'known_location' } });
    const { exe } = await npmCodex(path.join(home, 'AppData', 'Roaming', 'npm'), 'nested');
    expect(await resolveCli('codex', { platform: 'win32', arch: 'x64', env: envFor([], home) })).toMatchObject({ ok: true, cli: { path: exe, source: 'known_location' } });
  });

  it('어디에도 없으면 실패 사유 (shim만 있으면 그 사유도)', async () => {
    const empty = await resolveCli('claude', { platform: 'win32', env: envFor([path.join(root, 'nothing')], path.join(root, 'home-empty')) });
    expect(!empty.ok && empty.reason).toMatch(/찾지 못했습니다\. 설치했다면 운영 설정에서/);
    const onlyShim = path.join(root, 'only-shim');
    await touch(path.join(onlyShim, 'claude.cmd'), '@"%~dp0\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*');
    const r = await resolveCli('claude', { platform: 'win32', env: envFor([onlyShim], path.join(root, 'home-empty')) });
    expect(!r.ok && r.reason).toMatch(/직접 띄울 수 없습니다/);
  });
});
