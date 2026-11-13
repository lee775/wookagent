#!/usr/bin/env node
/**
 * 욱채 서버의 Linux 묶음을 만든다 — npm run pack:linux
 *
 *   dist/wook-server-<판>-linux-<커밋 7자>.tar.gz   풀면 wookagent/ 폴더 하나 (tar -xzf <파일> -C ~ → ~/wookagent)
 *   dist/wook-server-<판>-linux-<커밋 7자>.tar.gz.sha256   sha256sum -c 로 확인하는 한 줄
 *
 * Linux PC에서는 git clone·npm ci·빌드 없이 Node 24만 있으면 돈다(SERVER_SETUP L2 대신). 담는 것:
 *   out/server(빌드한 서버와 wook 명령) · out/web(빌드한 웹 화면) · resources(화면 도우미·모의 에이전트) · scripts/wook-server(실행 권한) ·
 *   node_modules(실행에 드는 꾸러미만 — package-lock.json에서 개발용이 아닌 것) · package.json(이름·판) · docs/*.md ·
 *   packaging/linux의 문서(AGENTS.md·CLAUDE.md·README.md·docs/ai — 그 PC의 AI가 읽는 설명) · BUILD-INFO.json
 * 담지 않는 것:
 *   @napi-rs/keyring(네이티브 모듈) — Linux 서버는 키링을 불러오지 않고 데이터 폴더의 파일 저장소를 쓴다(secretStore.ts, 리드 결정 S10-6.1).
 *   그래서 묶음은 순수 JS이고 x86_64·arm64에서 같은 파일로 돈다. 개발 도구(vite·vitest·electron…), src, tests, .git도 담지 않는다.
 *
 * 옵션:  --out <폴더>(기본 dist)  --skip-build(지금의 out/server·out/web을 그대로 담는다)  --server-dir <폴더>  --web-dir <폴더>(시험용)
 * 이 PC의 tar를 쓰지 않고 직접 쓴다 — Windows에는 실행 권한이 없어 OS의 tar로는 scripts/wook-server를 755로 담을 수 없다.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** tar 안의 맨 위 폴더 — 집 폴더에 풀면 SERVER_SETUP이 적은 ~/wookagent가 된다 */
const TOP = 'wookagent';
/** 묶음에 넣지 않는 꾸러미 (네이티브 모듈 — Linux 서버는 불러오지 않는다) */
const NOT_ON_LINUX = /(^|\/)node_modules\/@napi-rs\//;
/** 저장소에서 옮기는 글 파일 — Windows 작업 폴더의 CRLF를 LF로 바꿔 담는다 */
const TEXT_EXT = new Set(['', '.md', '.mjs', '.js', '.py', '.cs', '.json', '.txt', '.sh']);

function fail(message) {
  process.stderr.write(`pack-linux: ${message}\n`);
  process.exit(1);
}

// ───────────────────────── 인자 ─────────────────────────

function parseArgs(argv) {
  const o = { out: join(REPO, 'dist'), skipBuild: false, serverDir: join(REPO, 'out', 'server'), webDir: join(REPO, 'out', 'web'), help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) fail(`${a} 뒤에 값이 없습니다`);
      return resolve(v);
    };
    if (a === '--out') o.out = value();
    else if (a === '--server-dir') o.serverDir = value();
    else if (a === '--web-dir') o.webDir = value();
    else if (a === '--skip-build') o.skipBuild = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else fail(`모르는 옵션: ${a} (--help)`);
  }
  return o;
}

const HELP = `욱채 서버의 Linux 묶음을 만듭니다 (tar.gz — Linux PC에서 Node 24만으로 돕니다)

  node scripts/pack-linux.mjs [--out <폴더>] [--skip-build] [--server-dir <폴더>] [--web-dir <폴더>]

  --out <폴더>         결과를 둘 폴더 (기본 dist)
  --skip-build         빌드하지 않고 지금의 out/server·out/web을 담습니다
  --server-dir <폴더>  빌드한 서버 폴더 (기본 out/server)
  --web-dir <폴더>     빌드한 웹 화면 폴더 (기본 out/web)
`;

// ───────────────────────── 모으기 ─────────────────────────

/** 폴더 안의 파일을 모두 (폴더 기준 상대 경로, '/'로) — skipDir가 참인 폴더는 들어가지 않는다. 링크가 있으면 멈춘다 */
function walk(dir, skipDir = () => false, base = '') {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const rel = base ? `${base}/${e.name}` : e.name;
    const abs = join(dir, e.name);
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) fail(`링크는 담지 않습니다: ${abs}`);
    if (st.isDirectory()) {
      if (!skipDir(e.name, rel)) out.push(...walk(abs, skipDir, rel));
    } else if (st.isFile()) out.push(rel);
  }
  return out;
}

const toLf = (buf) => Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
const readText = (abs) => (TEXT_EXT.has(extname(abs).toLowerCase()) ? toLf(readFileSync(abs)) : readFileSync(abs));

/** package-lock.json에서 실행에 드는 꾸러미의 폴더들 (개발용·Linux에서 불러오지 않는 것 빼고) */
function productionPackages(lock) {
  const out = [];
  for (const [key, v] of Object.entries(lock.packages ?? {})) {
    if (!key || v.dev || v.devOptional || v.link || NOT_ON_LINUX.test(key)) continue;
    out.push({ key, version: v.version });
  }
  return out.sort((a, b) => (a.key < b.key ? -1 : 1));
}

function git(args) {
  const r = spawnSync('git', ['-C', REPO, ...args], { encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? r.stdout.trim() : null;
}

function build(config, extra = []) {
  const r = spawnSync(process.execPath, [join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', config, ...extra, '--logLevel', 'warn'], {
    cwd: REPO,
    stdio: 'inherit',
    windowsHide: true,
    env: { ...process.env, VITE_CONFIG_NATIVE_IGNORE_WARNING: 'true' },
  });
  if (r.status !== 0) fail(`빌드 실패 (${config}, 끝 코드 ${r.status})`);
}

function collect(o) {
  /** @type {Map<string, { mode: number, data: Buffer }>} */
  const files = new Map();
  const add = (path, data, mode = 0o644) => {
    if (files.has(path)) fail(`같은 경로가 두 번 들어갑니다: ${path}`);
    files.set(path, { mode, data });
  };

  const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(REPO, 'package-lock.json'), 'utf8'));

  // 빌드한 서버와 웹 화면
  for (const need of ['index.mjs', 'wook.mjs']) if (!existsSync(join(o.serverDir, need))) fail(`빌드한 서버가 없습니다: ${join(o.serverDir, need)} — npm run build:server`);
  if (!existsSync(join(o.webDir, 'index.html'))) fail(`빌드한 웹 화면이 없습니다: ${join(o.webDir, 'index.html')} — npm run build:web`);
  for (const rel of walk(o.serverDir)) add(`out/server/${rel}`, readFileSync(join(o.serverDir, rel)));
  for (const rel of walk(o.webDir)) add(`out/web/${rel}`, readFileSync(join(o.webDir, rel)));

  // 화면 도우미·모의 에이전트 등 — 이 PC에서 컴파일한 것(bin)과 파이썬 캐시는 빼고
  const resources = join(REPO, 'resources');
  for (const rel of walk(resources, (name) => name === 'bin' || name === '__pycache__')) {
    if (!rel.endsWith('.pyc')) add(`resources/${rel}`, readText(join(resources, rel)));
  }

  // 운영자 명령 (실행 권한)
  add('scripts/wook-server', readText(join(REPO, 'scripts', 'wook-server')), 0o755);

  // 실행에 드는 꾸러미 — 잠금 파일의 목록 그대로, 깔린 판이 같은지 본다
  const packages = productionPackages(lock);
  for (const p of packages) {
    const dir = join(REPO, ...p.key.split('/'));
    const manifest = join(dir, 'package.json');
    if (!existsSync(manifest)) fail(`node_modules에 ${p.key}가 없습니다 — npm ci를 먼저 하세요`);
    const installed = JSON.parse(readFileSync(manifest, 'utf8')).version;
    if (installed !== p.version) fail(`${p.key}의 판(${installed})이 package-lock.json(${p.version})과 다릅니다 — npm ci를 먼저 하세요`);
    // 안쪽 node_modules의 꾸러미는 잠금 파일에 제 줄이 따로 있다
    for (const rel of walk(dir, (name) => name === 'node_modules' || name === '.bin')) add(`${p.key}/${rel}`, readFileSync(join(dir, rel)));
  }

  // 이름과 판 — 서버가 판을 여기서 읽는다(serve.ts readVersion). 개발 도구와 Linux에서 쓰지 않는 꾸러미는 적지 않는다
  const dependencies = Object.fromEntries(Object.entries(pkg.dependencies ?? {}).filter(([name]) => !name.startsWith('@napi-rs/')));
  add('package.json', Buffer.from(`${JSON.stringify({ name: pkg.name, version: pkg.version, private: true, description: '욱채 서버 Linux 묶음 (빌드한 것 — 개발용 저장소가 아닙니다)', engines: { node: '>=24' }, dependencies }, null, 2)}\n`));

  // 문서 — 저장소의 것과 그 PC의 AI가 읽는 것
  const docs = join(REPO, 'docs');
  for (const e of readdirSync(docs, { withFileTypes: true })) if (e.isFile() && e.name.endsWith('.md')) add(`docs/${e.name}`, readText(join(docs, e.name)));
  const ai = join(REPO, 'packaging', 'linux');
  if (!existsSync(join(ai, 'AGENTS.md'))) fail(`AI용 문서가 없습니다: ${join(ai, 'AGENTS.md')}`);
  for (const rel of walk(ai)) add(rel, readText(join(ai, rel)));

  return { files, pkg, packages };
}

// ───────────────────────── tar (ustar + pax) ─────────────────────────

const octal = (n, width) => `${n.toString(8).padStart(width - 1, '0')}\0`;
const isAscii = (s) => /^[\x20-\x7e]*$/.test(s);

/** ustar의 이름 칸(100바이트)과 앞 칸(155바이트)에 나눠 담는다 — 안 되면 null (pax로) */
function splitName(path) {
  if (!isAscii(path)) return null;
  if (path.length <= 100) return { name: path, prefix: '' };
  for (let i = path.indexOf('/'); i >= 0; i = path.indexOf('/', i + 1)) {
    const prefix = path.slice(0, i);
    const name = path.slice(i + 1);
    if (prefix.length > 155) break;
    if (name.length > 0 && name.length <= 100) return { name, prefix };
  }
  return null;
}

function header({ name, prefix = '', mode, size, mtime, type }) {
  const b = Buffer.alloc(512);
  b.write(name, 0, 100, 'utf8');
  b.write(octal(mode, 8), 100, 8, 'ascii');
  b.write(octal(0, 8), 108, 8, 'ascii'); // uid
  b.write(octal(0, 8), 116, 8, 'ascii'); // gid
  b.write(octal(size, 12), 124, 12, 'ascii');
  b.write(octal(mtime, 12), 136, 12, 'ascii');
  b.fill(0x20, 148, 156); // 체크섬 칸은 빈칸으로 두고 더한다
  b.write(type, 156, 1, 'ascii');
  b.write('ustar\0', 257, 6, 'ascii');
  b.write('00', 263, 2, 'ascii');
  b.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const byte of b) sum += byte;
  b.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return b;
}

const padded = (data) => (data.length % 512 === 0 ? data : Buffer.concat([data, Buffer.alloc(512 - (data.length % 512))]));

/** pax 확장 머리 — 긴 경로나 ASCII 밖 이름(한글 파일 이름)을 'path' 기록으로 */
function paxFor(path, mtime, index) {
  const body = ` path=${path}\n`;
  let len = Buffer.byteLength(body) + 1;
  while (Buffer.byteLength(`${len}${body}`) !== len) len = Buffer.byteLength(`${len}${body}`);
  const record = Buffer.from(`${len}${body}`, 'utf8');
  return [header({ name: `PaxHeaders/${index}`, mode: 0o644, size: record.length, mtime, type: 'x' }), padded(record)];
}

function entryBlocks(path, { mode, size, mtime, type }, index) {
  const split = splitName(path);
  if (split) return [header({ ...split, mode, size, mtime, type })];
  // pax를 모르는 도구에는 줄인 ASCII 이름이 보인다 (GNU tar·bsdtar는 path 기록을 쓴다)
  const fallback = path.replace(/[^\x20-\x7e]/g, '_').slice(-100).replace(/^\/+/, '');
  return [...paxFor(path, mtime, index), header({ name: fallback, mode, size, mtime, type })];
}

/** 파일 목록(경로 → 권한·내용)을 tar로 — 폴더 항목(755)을 먼저 적고, 모두 같은 시각 */
function tarOf(files, mtime) {
  const dirs = new Set();
  for (const path of files.keys()) {
    const parts = `${TOP}/${path}`.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  const blocks = [];
  let index = 0;
  const all = [...[...dirs].map((d) => ({ path: `${d}/`, dir: true })), ...[...files.keys()].map((p) => ({ path: `${TOP}/${p}`, dir: false, file: files.get(p) }))];
  all.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const e of all) {
    index++;
    if (e.dir) blocks.push(...entryBlocks(e.path, { mode: 0o755, size: 0, mtime, type: '5' }, index));
    else blocks.push(...entryBlocks(e.path, { mode: e.file.mode, size: e.file.data.length, mtime, type: '0' }, index), padded(e.file.data));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

// ───────────────────────── 실행 ─────────────────────────

function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) {
    process.stdout.write(HELP);
    return;
  }
  if (!o.skipBuild) {
    build('vite.server.config.ts', ['--outDir', o.serverDir]);
    build('vite.web.config.ts', ['--mode', 'remote', '--outDir', o.webDir]);
  }

  const { files, pkg, packages } = collect(o);

  const commit = git(['rev-parse', 'HEAD']);
  const commitTime = Number(git(['log', '-1', '--format=%ct']) ?? '') || Math.floor(Date.now() / 1000);
  const status = git(['status', '--porcelain']);
  const dirty = status === null ? null : status.length > 0;
  const short = commit ? commit.slice(0, 7) : 'unknown';
  const name = `wook-server-${pkg.version}-linux-${short}${dirty ? '-dirty' : ''}.tar.gz`;

  const info = {
    name: 'wook-server',
    version: pkg.version,
    target: 'linux (x86_64 · arm64 — 순수 JS, 네이티브 모듈 없음)',
    node: '>=24',
    commit: commit ?? 'unknown',
    commitDate: commit ? new Date(commitTime * 1000).toISOString() : null,
    // 커밋하지 않은 변경이 있는 채 만들었는지 (git을 쓸 수 없으면 null)
    dirty,
    builtAt: new Date().toISOString(),
    builtOn: `${process.platform} ${process.arch}, Node ${process.versions.node}`,
    folder: TOP,
    entry: 'scripts/wook-server (= node out/server/index.mjs)',
    packages: packages.length,
    files: files.size + 1,
    start: 'AGENTS.md (AI) · README.md (사람) · docs/SERVER_SETUP.md의 Linux 편',
  };
  files.set('BUILD-INFO.json', { mode: 0o644, data: Buffer.from(`${JSON.stringify(info, null, 2)}\n`) });

  const tar = tarOf(files, commitTime);
  const gz = gzipSync(tar, { level: 9 });
  const sha = createHash('sha256').update(gz).digest('hex');
  mkdirSync(o.out, { recursive: true });
  writeFileSync(join(o.out, name), gz);
  writeFileSync(join(o.out, `${name}.sha256`), `${sha}  ${name}\n`);

  const mb = (n) => `${(n / 1048576).toFixed(1)}MB`;
  process.stdout.write(
    [
      `Linux 묶음을 만들었습니다: ${join(o.out, name)}`,
      `  크기       ${mb(gz.length)} (풀면 ${mb(tar.length)}) · 파일 ${files.size}개 · 꾸러미 ${packages.length}개`,
      `  판         ${pkg.version} · 커밋 ${short}${dirty ? ' (커밋하지 않은 변경 있음)' : ''}`,
      `  SHA-256    ${sha}`,
      `Linux PC에서:  sha256sum -c ${name}.sha256  →  tar -xzf ${name} -C ~  →  cd ~/${TOP} && scripts/wook-server --help`,
      '',
    ].join('\n'),
  );
}

main();
