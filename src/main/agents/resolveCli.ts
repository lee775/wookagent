/**
 * CLI 실행 파일 찾기와 상태 확인 (ENV-04, CLI-15).
 * - 순서: 설정의 경로 → PATH → 알려진 설치 위치
 * - Windows는 항상 실제 .exe를 돌려준다. npm 설치본(codex.cmd/.ps1 → bin/codex.js)은
 *   node_modules/@openai/codex-win32-x64/vendor/<triple>/bin/codex.exe 로 바꾼다 (.cmd를 띄우면 셸이 끼고 종료가 꼬인다)
 */
import { execFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, readFile, readdir, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AiKind } from '@shared/domain';
import { buildChildEnv } from './common';
import type { CliStatus } from './types';

// ───────────────────────── 검증된 버전 범위 (CLI-15) ─────────────────────────

export interface VerifiedRange {
  label: string;
  test(version: string): boolean;
}

/** 1차-B에서 실제로 첫 턴·이어하기·바이패스·MCP를 확인한 범위 */
export const VERIFIED_VERSIONS: Record<AiKind, VerifiedRange> = {
  claude: {
    label: 'Claude Code 2.1.x',
    test: (v) => {
      const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
      return !!m && Number(m[1]) === 2 && Number(m[2]) === 1;
    },
  },
  codex: {
    label: 'codex-cli 0.160–0.169',
    test: (v) => {
      const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
      return !!m && Number(m[1]) === 0 && Number(m[2]) >= 160 && Number(m[2]) <= 169;
    },
  },
};

const CLI_LABEL: Record<AiKind, string> = { claude: 'Claude Code', codex: 'Codex' };

/** `claude --version` → "2.1.311 (Claude Code)", `codex --version` → "codex-cli 0.163.0" */
export function parseCliVersion(kind: AiKind, output: string): string | null {
  const text = output.trim();
  const re = kind === 'claude' ? /(?:^|\s)(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?:\s*\(Claude Code\))?/ : /codex(?:-cli)?\s+(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/i;
  const m = re.exec(text);
  return m ? m[1]! : null;
}

// ───────────────────────── 실행 파일 찾기 ─────────────────────────

export interface ResolvedCli {
  kind: AiKind;
  /** 실행 파일 절대 경로 (Windows는 .exe) */
  path: string;
  source: 'settings' | 'path' | 'known_location';
  /** npm 설치본이면 @openai/codex 패키지 루트 (codex 런처가 넣는 CODEX_MANAGED_* 환경 변수 재현용) */
  npmPackageRoot: string | null;
  /** 찾은 과정 (설정 화면 표시용) */
  note: string;
}

export type ResolveResult = { ok: true; cli: ResolvedCli } | { ok: false; reason: string };

export interface ResolveOptions {
  /** 설정의 실행 파일 경로 (Settings.cli.claudePath / codexPath) */
  override?: string | null;
  platform?: NodeJS.Platform;
  arch?: string;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  homeDir?: string;
}

const SHIM_EXTS = ['.cmd', '.bat', '.ps1', ''];

export async function resolveCli(kind: AiKind, opts: ResolveOptions = {}): Promise<ResolveResult> {
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const env = opts.env ?? process.env;
  const home = opts.homeDir ?? os.homedir();
  const p = platform === 'win32' ? path.win32 : path.posix;
  const ctx: Ctx = { kind, platform, arch, p };

  const override = cleanPath(opts.override ?? '');
  if (override) {
    if (!p.isAbsolute(override)) return { ok: false, reason: `설정의 ${CLI_LABEL[kind]} 경로는 절대 경로여야 합니다: ${override}` };
    const st = await statOrNull(override);
    if (!st) return { ok: false, reason: `설정한 ${CLI_LABEL[kind]} 실행 파일이 없습니다: ${override}` };
    let target = override;
    if (st.isDirectory()) {
      const inDir = p.join(override, exeName(kind, platform));
      if (!(await isFile(inDir))) return { ok: false, reason: `설정한 폴더에 ${exeName(kind, platform)}가 없습니다: ${override}` };
      target = inDir;
    }
    const r = await interpretCandidate(ctx, target);
    if (r.kind === 'exe') return { ok: true, cli: { kind, path: r.path, source: 'settings', npmPackageRoot: r.npmRoot, note: `설정한 경로 사용${r.note ? ` (${r.note})` : ''}` } };
    return { ok: false, reason: r.reason };
  }

  // PATH (where/which와 같은 순서: 앞 폴더 우선)
  const shimProblems: string[] = [];
  for (const dir of pathDirs(env, platform)) {
    for (const cand of candidateNames(kind, platform)) {
      const full = p.join(dir, cand);
      if (!(await isFile(full))) continue;
      const r = await interpretCandidate(ctx, full);
      if (r.kind === 'exe') return { ok: true, cli: { kind, path: r.path, source: 'path', npmPackageRoot: r.npmRoot, note: `PATH에서 찾음${r.note ? ` (${r.note})` : ''}` } };
      if (r.kind === 'problem') shimProblems.push(r.reason);
    }
  }

  for (const known of knownLocations(kind, platform, env, home)) {
    if (!(await isFile(known))) continue;
    const r = await interpretCandidate(ctx, known);
    if (r.kind === 'exe') return { ok: true, cli: { kind, path: r.path, source: 'known_location', npmPackageRoot: r.npmRoot, note: `기본 설치 위치에서 찾음${r.note ? ` (${r.note})` : ''}` } };
    if (r.kind === 'problem') shimProblems.push(r.reason);
  }

  const base = `${CLI_LABEL[kind]} 실행 파일(${exeName(kind, platform)})을 PATH와 기본 설치 위치에서 찾지 못했습니다`;
  const extra = [...new Set(shimProblems)].join(' / ');
  return { ok: false, reason: extra ? `${base}. ${extra}` : `${base}. 설치했다면 운영 설정에서 실행 파일 경로를 지정하세요` };
}

interface Ctx {
  kind: AiKind;
  platform: NodeJS.Platform;
  arch: string;
  p: path.PlatformPath;
}

type Interpreted = { kind: 'exe'; path: string; npmRoot: string | null; note: string } | { kind: 'problem'; reason: string };

function exeName(kind: AiKind, platform: NodeJS.Platform): string {
  return platform === 'win32' ? `${kind}.exe` : kind;
}

function candidateNames(kind: AiKind, platform: NodeJS.Platform): string[] {
  if (platform !== 'win32') return [kind];
  // .exe를 먼저 본다. 같은 폴더에 shim만 있으면 그 다음
  return [`${kind}.exe`, ...SHIM_EXTS.map((e) => `${kind}${e}`)];
}

async function interpretCandidate(ctx: Ctx, file: string): Promise<Interpreted> {
  const { kind, platform, p } = ctx;
  const ext = p.extname(file).toLowerCase();
  if (platform === 'win32') {
    if (ext === '.exe') return { kind: 'exe', path: file, npmRoot: null, note: '' };
    if (ext === '.js' || SHIM_EXTS.includes(ext)) return fromShimOrScript(ctx, file);
    return { kind: 'problem', reason: `${file}은(는) 실행 파일(.exe)이 아닙니다` };
  }
  // POSIX: 심볼릭 링크를 따라가 npm의 bin/codex.js 인지 본다
  const real = await realpath(file).catch(() => file);
  if (real.endsWith('.js')) return fromShimOrScript(ctx, real);
  const executable = await access(real, fsConstants.X_OK).then(
    () => true,
    () => false,
  );
  if (!executable) return { kind: 'problem', reason: `${file}에 실행 권한이 없습니다` };
  // Claude 네이티브 설치는 ~/.local/bin/claude → ~/.local/share/claude/versions/<v> 링크. 링크 원본을 그대로 쓴다
  return { kind: 'exe', path: kind === 'claude' ? file : real, npmRoot: null, note: '' };
}

/** npm·pnpm shim(.cmd/.ps1/sh) 또는 bin/*.js 에서 실제 네이티브 실행 파일을 찾는다 */
async function fromShimOrScript(ctx: Ctx, file: string): Promise<Interpreted> {
  const { kind, platform, p } = ctx;
  if (kind === 'codex') {
    const root = await codexPackageRootFrom(ctx, file);
    if (!root) return { kind: 'problem', reason: `${file}에서 @openai/codex 패키지를 찾지 못했습니다` };
    const native = await codexNativeFromPackageRoot(root, platform, ctx.arch);
    if (!native) {
      return {
        kind: 'problem',
        reason: `npm 설치본(${root})에 이 OS용 codex 실행 파일이 없습니다. npm install -g @openai/codex 로 다시 설치하세요`,
      };
    }
    return { kind: 'exe', path: native, npmRoot: root, note: `npm 설치본의 실제 실행 파일: ${p.basename(native)}` };
  }
  // Claude: npm 패키지 안에 네이티브 실행 파일이 있으면 쓴다 (2.1.x 기본 설치는 claude.exe)
  const root = p.join(p.dirname(file), 'node_modules', '@anthropic-ai', 'claude-code');
  const native = (await isDir(root)) ? await findFileBounded(root, exeName('claude', platform), 4, 3000) : null;
  if (native) return { kind: 'exe', path: native, npmRoot: null, note: 'npm 설치본의 실제 실행 파일' };
  return {
    kind: 'problem',
    reason: `npm 설치본 실행 스크립트(${p.basename(file)})는 직접 띄울 수 없습니다. 기본 설치 프로그램으로 claude${platform === 'win32' ? '.exe' : ''}를 설치하거나 운영 설정에서 실행 파일 경로를 지정하세요`,
  };
}

async function codexPackageRootFrom(ctx: Ctx, file: string): Promise<string | null> {
  const { p } = ctx;
  const candidates: string[] = [];
  if (file.toLowerCase().endsWith('.js')) {
    // <root>/bin/codex.js
    candidates.push(p.dirname(p.dirname(file)));
  } else {
    const content = await readSmallText(file, 64 * 1024);
    if (content) {
      const shimDir = p.dirname(file);
      const m = /([^"'\s]*@openai[\\/]codex[\\/]bin[\\/]codex\.js)/i.exec(content);
      if (m) {
        let js = m[1]!
          .replace(/%~?dp0%?\\?/gi, shimDir + p.sep)
          .replace(/\$\{?basedir\}?[\\/]?/gi, shimDir + p.sep)
          .replace(/\$PSScriptRoot[\\/]?/gi, shimDir + p.sep);
        if (!p.isAbsolute(js)) js = p.join(shimDir, js);
        candidates.push(p.dirname(p.dirname(p.normalize(js))));
      }
    }
    candidates.push(p.join(p.dirname(file), 'node_modules', '@openai', 'codex'));
  }
  for (const root of candidates) {
    const pkg = await readSmallText(p.join(root, 'package.json'), 256 * 1024);
    if (!pkg) continue;
    try {
      const name = (JSON.parse(pkg) as { name?: unknown }).name;
      if (name === '@openai/codex') return root;
    } catch {
      continue;
    }
  }
  return null;
}

const CODEX_TARGETS: Record<string, { pkg: string; triple: string }> = {
  'win32-x64': { pkg: '@openai/codex-win32-x64', triple: 'x86_64-pc-windows-msvc' },
  'win32-arm64': { pkg: '@openai/codex-win32-arm64', triple: 'aarch64-pc-windows-msvc' },
  'darwin-x64': { pkg: '@openai/codex-darwin-x64', triple: 'x86_64-apple-darwin' },
  'darwin-arm64': { pkg: '@openai/codex-darwin-arm64', triple: 'aarch64-apple-darwin' },
  'linux-x64': { pkg: '@openai/codex-linux-x64', triple: 'x86_64-unknown-linux-musl' },
  'linux-arm64': { pkg: '@openai/codex-linux-arm64', triple: 'aarch64-unknown-linux-musl' },
};

/** bin/codex.js 의 require.resolve(`${플랫폼 패키지}/package.json`) 순서를 따른다 */
export async function codexNativeFromPackageRoot(root: string, platform: NodeJS.Platform, arch: string): Promise<string | null> {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const target = CODEX_TARGETS[`${platform}-${arch}`];
  if (!target) return null;
  const bin = platform === 'win32' ? 'codex.exe' : 'codex';
  const pkgParts = target.pkg.split('/');
  const vendorRoots: string[] = [];
  // root/bin/node_modules, root/node_modules, 그 위 폴더들의 node_modules
  let dir = p.join(root, 'bin');
  for (let i = 0; i < 8; i++) {
    if (p.basename(dir) !== 'node_modules') vendorRoots.push(p.join(dir, 'node_modules', ...pkgParts, 'vendor'));
    const parent = p.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  vendorRoots.push(p.join(root, 'vendor'));
  for (const vendor of vendorRoots) {
    const tripleDir = p.join(vendor, target.triple);
    if (!(await isDir(tripleDir))) continue;
    const manifest = await readSmallText(p.join(tripleDir, 'codex-package.json'), 64 * 1024);
    if (manifest) {
      try {
        const entry = (JSON.parse(manifest) as { entrypoint?: unknown }).entrypoint;
        if (typeof entry === 'string' && entry && !entry.includes('..')) {
          const full = p.join(tripleDir, ...entry.split('/'));
          if (await isFile(full)) return full;
        }
      } catch {
        // 설명 파일이 깨졌으면 아래 고정 위치로 찾는다
      }
    }
    for (const rel of [['bin', bin], ['codex', bin], [bin]]) {
      const full = p.join(tripleDir, ...rel);
      if (await isFile(full)) return full;
    }
  }
  return null;
}

function knownLocations(kind: AiKind, platform: NodeJS.Platform, env: NodeJS.ProcessEnv | Record<string, string | undefined>, home: string): string[] {
  const get = (name: string) => envGet(env, name, platform);
  if (platform === 'win32') {
    const p = path.win32;
    const profile = get('USERPROFILE') || home;
    const appData = get('APPDATA') || p.join(profile, 'AppData', 'Roaming');
    if (kind === 'claude') return [p.join(profile, '.local', 'bin', 'claude.exe'), p.join(appData, 'npm', 'claude.cmd')];
    return [p.join(appData, 'npm', 'codex.cmd'), p.join(profile, '.local', 'bin', 'codex.exe')];
  }
  const p = path.posix;
  if (kind === 'claude') return [p.join(home, '.local', 'bin', 'claude'), p.join(home, '.claude', 'local', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'];
  return ['/opt/homebrew/bin/codex', '/usr/local/bin/codex', p.join(home, '.local', 'bin', 'codex'), p.join(home, '.npm-global', 'bin', 'codex')];
}

function pathDirs(env: NodeJS.ProcessEnv | Record<string, string | undefined>, platform: NodeJS.Platform): string[] {
  const raw = envGet(env, 'PATH', platform) ?? '';
  const sep = platform === 'win32' ? ';' : ':';
  const p = platform === 'win32' ? path.win32 : path.posix;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(sep)) {
    const d = cleanPath(part);
    if (!d || !p.isAbsolute(d)) continue;
    const key = platform === 'win32' ? d.toLowerCase() : d;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out;
}

export function envGet(env: NodeJS.ProcessEnv | Record<string, string | undefined>, name: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== 'win32') return env[name] ?? undefined;
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key ? (env[key] ?? undefined) : undefined;
}

function cleanPath(s: string): string {
  let t = s.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) t = t.slice(1, -1).trim();
  return t;
}

async function statOrNull(p: string) {
  return stat(p).catch(() => null);
}
async function isFile(p: string): Promise<boolean> {
  return (await statOrNull(p))?.isFile() ?? false;
}
async function isDir(p: string): Promise<boolean> {
  return (await statOrNull(p))?.isDirectory() ?? false;
}
async function readSmallText(p: string, maxBytes: number): Promise<string | null> {
  const st = await statOrNull(p);
  if (!st || !st.isFile() || st.size > maxBytes) return null;
  return readFile(p, 'utf8').catch(() => null);
}

/** 깊이·개수 제한을 둔 파일 찾기 (npm 패키지 안 네이티브 실행 파일) */
async function findFileBounded(root: string, name: string, maxDepth: number, maxEntries: number): Promise<string | null> {
  let budget = maxEntries;
  const queue: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
  while (queue.length > 0 && budget > 0) {
    const { dir, depth } = queue.shift()!;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (--budget <= 0) break;
      const full = path.join(dir, e.name);
      if (e.isFile() && e.name.toLowerCase() === name.toLowerCase()) return full;
      if (e.isDirectory() && depth < maxDepth) queue.push({ dir: full, depth: depth + 1 });
    }
  }
  return null;
}

// ───────────────────────── 상태 확인 (detect) ─────────────────────────

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** 실행 자체가 실패한 경우 (ENOENT 등) */
  error: string | null;
}

export type RunCommand = (file: string, args: string[], opts: { env: Record<string, string | undefined>; timeoutMs: number; cwd?: string }) => Promise<CommandResult>;

/** 셸 없이 실행 (ARCHITECTURE 17장: shell 금지) */
export const runCommand: RunCommand = (file, args, opts) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      { env: opts.env, timeout: opts.timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8', cwd: opts.cwd ?? os.tmpdir() },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { code?: unknown; killed?: boolean; signal?: string | null }) | null;
        const timedOut = !!e && e.killed === true && e.signal != null;
        const code = e ? (typeof e.code === 'number' ? e.code : null) : 0;
        const spawnError = e && typeof e.code === 'string' ? `${e.code}: ${e.message}` : null;
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), timedOut, error: spawnError });
      },
    );
  });

export interface DetectOptions extends ResolveOptions {
  /** 상태 확인 명령에 더할 환경 변수 (API 키 방식 등) */
  statusEnv?: Record<string, string>;
  timeoutMs?: number;
  run?: RunCommand;
  /** 해석을 대신할 결과 (테스트) */
  resolved?: ResolveResult;
}

export async function detectCli(kind: AiKind, opts: DetectOptions = {}): Promise<CliStatus> {
  const label = CLI_LABEL[kind];
  const platform = opts.platform ?? process.platform;
  const run = opts.run ?? runCommand;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const resolved = opts.resolved ?? (await resolveCli(kind, opts));
  if (!resolved.ok) {
    return { installed: false, path: null, version: null, loggedIn: null, problem: resolved.reason, detail: resolved.reason };
  }
  const exe = resolved.cli.path;
  const env = buildChildEnv(opts.env ?? process.env, { ...cliLauncherEnv(resolved.cli), ...(opts.statusEnv ?? {}) }, platform);

  const ver = await run(exe, ['--version'], { env, timeoutMs });
  const verText = `${ver.stdout}\n${ver.stderr}`;
  const version = ver.error || ver.timedOut ? null : parseCliVersion(kind, verText);
  let problem: string | null = null;
  if (ver.error) problem = `${label}를 실행하지 못했습니다: ${ver.error}`;
  else if (ver.timedOut) problem = `${label} 버전 확인이 ${Math.round(timeoutMs / 1000)}초 안에 끝나지 않았습니다`;
  else if (!version) problem = `${label} 버전을 해석하지 못했습니다: ${firstLine(verText) || '(출력 없음)'}`;
  else if (!VERIFIED_VERSIONS[kind].test(version)) problem = `검증된 버전 범위(${VERIFIED_VERSIONS[kind].label}) 밖입니다: ${version}. 이벤트 형식이 달라졌을 수 있어 새 작업을 멈춥니다`;

  let loggedIn: boolean | null = null;
  let authDetail = '';
  const statusP = ver.error ? null : run(exe, kind === 'claude' ? ['auth', 'status', '--json'] : ['login', 'status'], { env, timeoutMs });
  // Codex: 이 실행 파일이 내놓는 기능 목록을 한 번 읽어 둔다 — 턴을 띄울 때 내장 화면·브라우저 조작을 그 이름들로 끈다 (리드 결정 S6-21 E4). 읽기만 하는 명령,
  // 실행 파일마다 한 번. 로그인 확인과 함께 돌려 확인을 늦추지 않고, 읽지 못해도 확인 결과(problem)는 바꾸지 않는다 (상세 글에 한 줄)
  const featsP = kind === 'codex' && !ver.error && !ver.timedOut ? readCodexScreenFeatures(exe, { env, run, timeoutMs }) : null;
  if (statusP) {
    const st = await statusP;
    const parsed = kind === 'claude' ? parseClaudeAuthStatus(st) : parseCodexLoginStatus(st);
    loggedIn = parsed.loggedIn;
    authDetail = parsed.detail;
  }

  const parts = [exe, version ?? '버전 모름', loggedIn === true ? `로그인됨${authDetail ? ` (${authDetail})` : ''}` : loggedIn === false ? '로그인 필요' : `로그인 확인 불가${authDetail ? ` (${authDetail})` : ''}`];
  if (resolved.cli.note) parts.push(resolved.cli.note);
  if (featsP) {
    const feats = await featsP;
    parts.push(
      feats.listed
        ? `내장 화면·브라우저 조작 끔${feats.names.length ? ` (${feats.names.join(', ')})` : ' (이 버전에는 그런 기능이 없음)'}`
        : `기능 목록(features list)을 읽지 못해 ${CODEX_SCREEN_FEATURES_VERIFIED.join('·')}만 끕니다 (${feats.reason})`,
    );
  }
  if (problem) parts.push(problem);
  return { installed: true, path: exe, version, loggedIn, problem, detail: parts.join(' · ') };
}

// ───────────────────────── Codex 내장 화면·브라우저 조작 (리드 결정 S6-0·S6-7·S6-21 E4) ─────────────────────────

/** 끄는 기능 이름의 앞머리 — 설치된 버전이 내놓는 이름 가운데 이것으로 시작하는 것을 모두 끈다 (0.167: browser_use · browser_use_external · browser_use_full_cdp_access · computer_use) */
export const CODEX_SCREEN_FEATURE_PREFIXES: readonly string[] = ['computer_use', 'browser_use'];

/**
 * 기능 목록을 읽지 못했을 때 끄는 이름 — 검증된 버전 범위(0.160–0.169)의 0.163.0과 0.167.0에서 `features list`에 있는 것을 손으로 확인한 둘.
 * 목록을 읽었으면 쓰지 않는다 (그 버전이 내놓지 않는 이름은 넘기지 않는다)
 */
export const CODEX_SCREEN_FEATURES_VERIFIED: readonly string[] = ['computer_use', 'browser_use'];

/** `codex features list`의 줄 `<이름> <단계 …> <true|false>` → 기능 이름들 (나온 순서, 겹치지 않게). 모양이 다른 줄은 버린다 */
export function parseCodexFeatureNames(output: string): string[] {
  const names = new Set<string>();
  for (const raw of output.split(/\r?\n/)) {
    const m = /^([a-z0-9][a-z0-9_.-]{0,80})\s+\S.*\s(true|false)$/i.exec(raw.trim());
    if (m) names.add(m[1]!);
  }
  return [...names];
}

/** 기능 이름들 가운데 내장 화면·브라우저 조작 (앞머리가 computer_use·browser_use인 것) */
export function codexScreenFeatures(names: readonly string[]): string[] {
  return names.filter((n) => CODEX_SCREEN_FEATURE_PREFIXES.some((p) => n.startsWith(p)));
}

export type CodexScreenFeatures = { listed: true; names: string[] } | { listed: false; reason: string };

/** 읽지 못한 결과를 다시 읽기까지 (그동안은 그 결과를 그대로 준다 — 턴마다 실패하는 명령을 다시 돌리지 않는다) */
const FEATURES_RETRY_MS = 60_000;
/** 실행 함수마다(실제 앱은 runCommand 하나, 시험은 저마다의 가짜) 실행 파일별로 기억한다 */
const featureCache = new WeakMap<RunCommand, Map<string, { at: number; value: Promise<CodexScreenFeatures> }>>();

/** 실행 파일을 가리는 키 — 같은 경로에 다른 버전을 덮어 깔면(크기·바뀐 때가 달라진다) 다시 읽는다 */
async function binaryKey(exe: string): Promise<string> {
  const st = await statOrNull(exe);
  return st ? `${exe}|${st.size}|${st.mtimeMs}` : exe;
}

/**
 * 이 Codex 실행 파일의 내장 화면·브라우저 조작 기능 이름 (`codex features list` — 읽기만 한다). 실행 파일마다 한 번 읽어 기억한다: CLI를 확인할 때(detectCli)
 * 읽고, 그보다 먼저 턴을 띄우면 그때 읽는다 (같은 읽기를 함께 기다린다). 읽지 못했으면(명령 실패·시간 초과·알아볼 줄이 없음) listed: false — 부르는 쪽이
 * 확인된 두 이름으로 대신한다
 */
export async function readCodexScreenFeatures(
  exe: string,
  o: { env: Record<string, string | undefined>; run?: RunCommand; timeoutMs?: number },
): Promise<CodexScreenFeatures> {
  const run = o.run ?? runCommand;
  let byExe = featureCache.get(run);
  if (!byExe) featureCache.set(run, (byExe = new Map()));
  const key = await binaryKey(exe);
  const hit = byExe.get(key);
  if (hit) {
    const v = await hit.value;
    if (v.listed || Date.now() - hit.at < FEATURES_RETRY_MS) return v;
  }
  const value = (async (): Promise<CodexScreenFeatures> => {
    const timeoutMs = o.timeoutMs ?? 20_000;
    let r: CommandResult;
    try {
      r = await run(exe, ['features', 'list'], { env: o.env, timeoutMs });
    } catch (e) {
      return { listed: false, reason: e instanceof Error ? e.message : String(e) };
    }
    if (r.error) return { listed: false, reason: r.error };
    if (r.timedOut) return { listed: false, reason: `${Math.round(timeoutMs / 1000)}초 안에 끝나지 않음` };
    const names = r.code === 0 ? parseCodexFeatureNames(r.stdout) : [];
    if (!names.length) return { listed: false, reason: `종료 코드 ${String(r.code)}, ${firstLine(`${r.stdout}\n${r.stderr}`) || '출력 없음'}` };
    return { listed: true, names: codexScreenFeatures(names) };
  })();
  byExe.set(key, { at: Date.now(), value });
  return value;
}

/** `claude auth status --json` → {"loggedIn":true,"authMethod":"claude.ai",...}. 로그인 안 됐으면 종료 코드 1 */
export function parseClaudeAuthStatus(r: CommandResult): { loggedIn: boolean | null; detail: string } {
  if (r.error) return { loggedIn: null, detail: r.error };
  if (r.timedOut) return { loggedIn: null, detail: '상태 확인 시간 초과' };
  const text = r.stdout.trim();
  const start = text.indexOf('{');
  if (start >= 0) {
    try {
      const j = JSON.parse(text.slice(start)) as { loggedIn?: unknown; authMethod?: unknown };
      if (typeof j.loggedIn === 'boolean') {
        const method = typeof j.authMethod === 'string' && j.authMethod !== 'none' ? j.authMethod : '';
        return { loggedIn: j.loggedIn, detail: method };
      }
    } catch {
      // 아래 문구 판정으로 넘어간다
    }
  }
  const all = `${r.stdout}\n${r.stderr}`;
  if (/not logged in/i.test(all)) return { loggedIn: false, detail: '' };
  return { loggedIn: null, detail: firstLine(all) };
}

/** `codex login status` → "Logged in using ChatGPT" (0) / "Not logged in" (1) */
export function parseCodexLoginStatus(r: CommandResult): { loggedIn: boolean | null; detail: string } {
  if (r.error) return { loggedIn: null, detail: r.error };
  if (r.timedOut) return { loggedIn: null, detail: '상태 확인 시간 초과' };
  const all = `${r.stdout}\n${r.stderr}`;
  if (/not logged in/i.test(all)) return { loggedIn: false, detail: '' };
  const m = /logged in using (an api key|chatgpt|[^\n\r-]+)/i.exec(all);
  if (m) return { loggedIn: true, detail: /api key/i.test(m[1]!) ? 'API 키' : m[1]!.trim() };
  return { loggedIn: null, detail: firstLine(all) };
}

/** npm 런처(bin/codex.js)가 네이티브 실행 파일에 넣는 환경 변수를 똑같이 넣는다 */
export function cliLauncherEnv(cli: ResolvedCli): Record<string, string> {
  if (cli.kind !== 'codex' || !cli.npmPackageRoot) return {};
  return { CODEX_MANAGED_BY_NPM: '1', CODEX_MANAGED_PACKAGE_ROOT: cli.npmPackageRoot };
}

function firstLine(s: string): string {
  return (s.split(/\r?\n/).find((l) => l.trim() !== '') ?? '').trim().slice(0, 200);
}
