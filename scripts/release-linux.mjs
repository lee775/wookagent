#!/usr/bin/env node
/**
 * Linux 묶음을 GitHub 릴리스로 낸다 — npm run release:linux
 *
 * 릴리스를 올리는 것이 곧 배포다: 서버 PC가 최신 릴리스를 보다가 바뀌면 스스로 새 묶음으로 바꾼다(2026-11-16부터). 그래서 손으로 하지 않고 이 명령으로만 낸다.
 *   1. 작업 폴더가 깨끗하고, 지금 커밋이 원격 브랜치의 끝과 같아야 한다
 *   2. 그 커밋의 CI(GitHub Actions 'linux')가 통과했어야 한다 — 아니면 내지 않는다
 *   3. scripts/pack-linux.mjs로 묶음을 만든다 (dist/wook-server-<판>-linux-<커밋 7자>.tar.gz와 .sha256)
 *   4. 태그 linux-bundle-<판>-<커밋 7자>로 릴리스를 만들고 파일 넷을 올린다: 위 둘과, 이름이 늘 같은 사본 둘
 *      (wook-server-linux.tar.gz · .sha256) — 서버 PC는 로그인 없이 늘 같은 주소로 받는다:
 *        https://github.com/<저장소>/releases/latest/download/wook-server-linux.tar.gz(.sha256)
 *
 * 옵션: --dry-run (확인과 묶음 만들기까지만, 릴리스를 만들지 않는다)
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXED = 'wook-server-linux.tar.gz';
const dryRun = process.argv.includes('--dry-run');

function fail(message) {
  process.stderr.write(`release-linux: ${message}\n`);
  process.exit(1);
}

function run(cmd, args, { inherit = false } = {}) {
  const r = spawnSync(cmd, args, { cwd: REPO, encoding: 'utf8', windowsHide: true, stdio: inherit ? 'inherit' : 'pipe' });
  if (r.error) fail(`${cmd}를 실행하지 못했습니다: ${r.error.message}`);
  return { code: r.status, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

const git = (...args) => {
  const r = run('git', args);
  if (r.code !== 0) fail(`git ${args.join(' ')} 실패: ${r.err}`);
  return r.out;
};

// 1. 깨끗한 작업 폴더, 올라간 커밋
if (git('status', '--porcelain')) fail('커밋하지 않은 변경이 있습니다 — 커밋하고 올린 뒤에 내세요');
const sha = git('rev-parse', 'HEAD');
const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
git('fetch', 'origin', branch);
if (git('rev-parse', `origin/${branch}`) !== sha) fail(`지금 커밋이 origin/${branch}의 끝과 다릅니다 — 올린 뒤에 내세요`);

// 2. 그 커밋의 CI
const runs = run('gh', ['run', 'list', '--commit', sha, '--json', 'name,status,conclusion']);
if (runs.code !== 0) fail(`CI 결과를 읽지 못했습니다: ${runs.err}`);
const ci = JSON.parse(runs.out || '[]');
if (!ci.length) fail(`이 커밋(${sha.slice(0, 7)})의 CI 실행이 없습니다 — CI가 돈 뒤에 내세요`);
const notGreen = ci.filter((r) => r.status !== 'completed' || r.conclusion !== 'success');
if (notGreen.length) fail(`이 커밋(${sha.slice(0, 7)})의 CI가 통과하지 않았습니다: ${notGreen.map((r) => `${r.name} ${r.status}/${r.conclusion || '-'}`).join(', ')}`);

// 3. 묶음
const version = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version;
const short = sha.slice(0, 7);
const tag = `linux-bundle-${version}-${short}`;
const name = `wook-server-${version}-linux-${short}.tar.gz`;
const pack = run(process.execPath, [join(REPO, 'scripts', 'pack-linux.mjs')], { inherit: true });
if (pack.code !== 0) fail('묶음을 만들지 못했습니다');
const bundle = join(REPO, 'dist', name);
if (!existsSync(bundle) || !existsSync(`${bundle}.sha256`)) fail(`묶음이 없습니다: ${bundle}`);

// 4. 이름이 늘 같은 사본과 릴리스
const tmp = mkdtempSync(join(tmpdir(), 'wook-release-'));
try {
  const fixed = join(tmp, FIXED);
  copyFileSync(bundle, fixed);
  writeFileSync(`${fixed}.sha256`, `${createHash('sha256').update(readFileSync(fixed)).digest('hex')}  ${FIXED}\n`);
  const last = run('git', ['describe', '--tags', '--abbrev=0', '--match', 'linux-bundle-*', 'HEAD^']);
  const changes = git('log', '--format=- %s', ...(last.code === 0 ? [`${last.out}..HEAD`] : ['-10']));
  const notes = join(tmp, 'notes.md');
  writeFileSync(
    notes,
    [
      `욱채 서버 Linux 묶음 ${version} (커밋 ${short}). Node 24와 git만 있으면 돕니다 — 받은 뒤의 차례는 묶음 안의 AGENTS.md와 README.md에 있습니다.`,
      '',
      '늘 같은 주소 (로그인 없이):',
      '- `releases/latest/download/wook-server-linux.tar.gz`',
      '- `releases/latest/download/wook-server-linux.tar.gz.sha256`',
      '',
      last.code === 0 ? `바뀐 것 (${last.out} 뒤):` : '최근 커밋:',
      changes,
      '',
    ].join('\n'),
  );
  if (dryRun) {
    process.stdout.write(`(dry-run) 릴리스 ${tag}를 만들지 않았습니다 — 올릴 파일: ${name}, ${name}.sha256, ${FIXED}, ${FIXED}.sha256\n${readFileSync(notes, 'utf8')}`);
  } else {
    const made = run('gh', ['release', 'create', tag, bundle, `${bundle}.sha256`, fixed, `${fixed}.sha256`, '--target', sha, '--title', `욱채 서버 Linux 묶음 ${version} (${short})`, '--notes-file', notes, '--latest'], { inherit: true });
    if (made.code !== 0) fail(`릴리스를 만들지 못했습니다 (${tag})`);
    process.stdout.write(`릴리스를 냈습니다: ${tag}\n`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
