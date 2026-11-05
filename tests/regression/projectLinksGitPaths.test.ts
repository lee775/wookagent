/**
 * 연결 지점 검사는 git이 따라가는 링크를 모두 본다 — git이 그 링크를 보는 경로가 하나라도 무시되지 않으면 본다 (stage-9 리뷰 guards-shutdown9
 * D1·D2 → S10-D1·D2, stage-9 회귀 — AC-18 남의 프로젝트 파일 변경 거부, S9-D1 '추적하는 연결 지점과 무시하지 않는 연결 지점은 그대로 거부').
 * - S10-D1: stage 9는 `ls-files --ignored --directory` 목록에 든 경로를 건너뛰었다. 그 목록은 안에 든 파일이 모두 무시될 뿐인 폴더도 넣는다 —
 *   무시 파일(*.psd)만 든 B/assets를 가리키는 연결 지점 art는 어느 규칙에도 걸리지 않는데 빠졌고, B/assets에 보통 파일이 생기면 git이 art/를
 *   따라갔다. 이제 그 경로나 상위 폴더가 무시 규칙에 걸릴 때만 뺀다(`git check-ignore`).
 * - S10-D2: stage 9는 무시 여부를 경로로 보면서 폴더 안을 가리키는 링크는 건너뛰고(그 폴더는 따로 본다) 바깥 폴더는 처음 닿은 경로로만 봤다 —
 *   무시된 build를 가리키는 x를 통한 x/link, a·b가 함께 가리키는 T의 b/sub를 놓쳐 첫 커밋이 B의 파일을 담았다. 이제 폴더를 모두 돌고, 찾은
 *   바깥 링크마다 git이 보는 경로를 모두 모아 모두 무시될 때만 뺀다.
 * 원래 탐침: probe-archive/stage9-guards-shutdown9-review/tests-acceptance__zz-gs9r-attack.probe.ts
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OPERATOR, type Project } from '@shared/domain';
import { bootApp, removeDirs, tempDir, type App } from '../acceptance/security-helpers';

const apps: App[] = [];
const dirs: string[] = [];
const links: string[] = [];
afterEach(async () => {
  for (const l of links.splice(0).reverse()) {
    try {
      unlinkSync(l);
    } catch {
      // 이미 지워짐
    }
  }
  for (const a of apps.splice(0)) await a.close();
  await removeDirs(dirs.splice(0));
});

async function boot(): Promise<App> {
  const app = await bootApp({ stopScheduler: true, runnerMode: 'taskkill' });
  apps.push(app);
  return app;
}
function base(tag: string): string {
  const d = tempDir(tag);
  dirs.push(d);
  return d;
}
function plain(dir: string, n = 2): string {
  mkdirSync(join(dir, 'src'), { recursive: true });
  for (let i = 0; i < n; i++) writeFileSync(join(dir, 'src', `f${i}.txt`), `${i}\n`);
  return dir;
}
function junction(target: string, at: string): void {
  mkdirSync(join(at, '..'), { recursive: true });
  symlinkSync(target, at, 'junction');
  links.push(at);
}
const settle = (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => 'accepted',
    (e: { code?: string; message?: string }) => `refused ${e.code}: ${e.message}`,
  );
const create = (app: App, path: string, name: string): Promise<string> => settle(app.core.projects.create({ mode: 'existing', path, name }, OPERATOR));
const projectAt = (app: App, path: string): Project => app.ctx.store.projects.list().find((p) => p.path === path)!;
const record = (app: App, projectId: string) => app.ctx.store.kv.get<{ targets: string[]; complete: boolean }>(`project.links:${projectId}`);
const real = (p: string): string => realpathSync.native(p);
/** 첫 커밋 전 폴더에 git init을 하면 첫 커밋(add -A)이 담을 파일 — 폴더는 건드리지 않고 빈 임시 저장소를 붙여 본다 */
function firstCommitWouldAdd(dir: string): string[] {
  const scratch = base('gp-scratch');
  execFileSync('git', ['init', '-q', scratch]);
  return execFileSync('git', [`--git-dir=${join(scratch, '.git')}`, `--work-tree=${dir}`, '-c', 'core.autocrlf=false', 'add', '-A', '--dry-run'], { cwd: dir, encoding: 'utf8' })
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => l.replace(/^add '(.*)'$/, '$1'));
}
/** B(P-0001)를 가리키는 연결 지점 때문에 거부 */
const refusedByB = /^refused forbidden: 폴더 안의 연결 지점 .*이 가리키는 다른 프로젝트\(P-0001 B\)의 폴더 때문에/;

describe.skipIf(process.platform !== 'win32')('git이 따라가는 연결 지점은 모두 본다 (S10-D1·D2, AC-18)', () => {
  it('S10-D1: 무시 파일만 든 폴더를 가리키는 연결 지점은 무시되지 않는다 — 첫 커밋 전 폴더와 커밋된 저장소 모두 거부, 그 경로를 무시 규칙에 넣으면 받는다', async () => {
    const app = await boot();
    const root = base('gp-content');
    const b = plain(join(root, 'b'));
    mkdirSync(join(b, 'assets'));
    writeFileSync(join(b, 'assets', 'logo.psd'), 'psd\n');
    expect(await create(app, b, 'B')).toBe('accepted');

    // 첫 커밋 전 폴더: art는 어느 규칙에도 걸리지 않는다 — B/assets에 보통 파일이 생기면 첫 커밋이 그 파일을 담는다
    const a = plain(join(root, 'a'));
    writeFileSync(join(a, '.gitignore'), '*.psd\n');
    junction(join(b, 'assets'), join(a, 'art'));
    writeFileSync(join(b, 'assets', 'readme.md'), 'about\n');
    expect(firstCommitWouldAdd(a)).toContain('art/readme.md');
    unlinkSync(join(b, 'assets', 'readme.md'));
    expect(await create(app, a, 'A')).toMatch(refusedByB);
    expect(existsSync(join(a, '.git'))).toBe(false);

    // 커밋된 저장소도 같다 (병합·작업 트리 맞추기가 연결 지점을 따라 B에 쓴다)
    const c = plain(join(root, 'c'));
    writeFileSync(join(c, '.gitignore'), '*.psd\n');
    execFileSync('git', ['init', '-q', '-b', 'main', c]);
    execFileSync('git', ['-C', c, '-c', 'core.autocrlf=false', 'add', '-A']);
    execFileSync('git', ['-C', c, '-c', 'user.name=o', '-c', 'user.email=o@example.invalid', 'commit', '-q', '-m', 'c']);
    junction(join(b, 'assets'), join(c, 'art'));
    expect(await create(app, c, 'C')).toMatch(refusedByB);

    // 연결 지점 경로 자체를 무시하면 git이 따라가지 않는다 — 받고, 기록에도 없다
    appendFileSync(join(a, '.gitignore'), 'art/\n');
    expect(await create(app, a, 'A')).toBe('accepted');
    expect(record(app, projectAt(app, a).id)).toMatchObject({ targets: [], complete: true });
  });

  it('S10-D2: 무시된 폴더를 가리키는 폴더 안 연결 지점 — build/link는 build로는 무시되지만 x/link로 git이 따라간다', async () => {
    const app = await boot();
    const root = base('gp-inroot');
    const b = plain(join(root, 'b'));
    expect(await create(app, b, 'B')).toBe('accepted');
    const a = plain(join(root, 'a'));
    writeFileSync(join(a, '.gitignore'), 'build/\n');
    mkdirSync(join(a, 'build'));
    writeFileSync(join(a, 'build', 'out.js'), 'x\n');
    junction(join(b, 'src'), join(a, 'build', 'link'));
    junction(join(a, 'build'), join(a, 'x'));
    expect(firstCommitWouldAdd(a)).toEqual(expect.arrayContaining(['x/link/f0.txt', 'x/link/f1.txt']));
    expect(await create(app, a, 'A')).toMatch(refusedByB);
    expect(existsSync(join(a, '.git'))).toBe(false);

    // x도 무시하면 git은 어느 경로로도 들어가지 않는다
    appendFileSync(join(a, '.gitignore'), 'x\n');
    expect(firstCommitWouldAdd(a).filter((f) => f.includes('link/'))).toEqual([]);
    expect(await create(app, a, 'A')).toBe('accepted');
    expect(record(app, projectAt(app, a).id)).toMatchObject({ targets: [], complete: true });
  });

  it('S10-D2: 같은 바깥 폴더 T를 가리키는 a·b — /a/sub/만 무시하면 T/sub는 b/sub로 git이 따라간다', async () => {
    const app = await boot();
    const root = base('gp-twopaths');
    const b = plain(join(root, 'b'));
    expect(await create(app, b, 'B')).toBe('accepted');
    const t = plain(join(root, 't'));
    junction(join(b, 'src'), join(t, 'sub'));
    const a = plain(join(root, 'a'));
    writeFileSync(join(a, '.gitignore'), '/a/sub/\n');
    junction(t, join(a, 'a'));
    junction(t, join(a, 'b'));
    expect(firstCommitWouldAdd(a)).toEqual(expect.arrayContaining(['b/sub/f0.txt']));
    expect(firstCommitWouldAdd(a).filter((f) => f.startsWith('a/sub/'))).toEqual([]);
    expect(await create(app, a, 'A')).toMatch(refusedByB);
    expect(existsSync(join(a, '.git'))).toBe(false);

    // 두 경로를 다 무시하면 받고, T는 기록된다(a·b로 git이 T의 다른 파일을 담는다)
    appendFileSync(join(a, '.gitignore'), '/b/sub/\n');
    expect(await create(app, a, 'A')).toBe('accepted');
    expect(record(app, projectAt(app, a).id)?.targets).toEqual([real(t)]);
  });

  it('S10-D2: 따라 들어간 바깥 폴더가 다시 폴더 안의 무시된 폴더를 가리키면 그 경로로도 본다 (ext → T, T/back → build)', async () => {
    const app = await boot();
    const root = base('gp-back');
    const b = plain(join(root, 'b'));
    expect(await create(app, b, 'B')).toBe('accepted');
    const a = plain(join(root, 'a'));
    writeFileSync(join(a, '.gitignore'), 'build/\n');
    mkdirSync(join(a, 'build'));
    junction(join(b, 'src'), join(a, 'build', 'link'));
    const t = plain(join(root, 't'));
    junction(join(a, 'build'), join(t, 'back'));
    junction(t, join(a, 'ext'));
    expect(firstCommitWouldAdd(a)).toEqual(expect.arrayContaining(['ext/back/link/f0.txt']));
    expect(await create(app, a, 'A')).toMatch(refusedByB);
    expect(existsSync(join(a, '.git'))).toBe(false);

    // ext를 무시하면 git은 T로도 build로도 들어가지 않는다 — 받고, 기록에 T도 없다
    appendFileSync(join(a, '.gitignore'), 'ext\n');
    expect(await create(app, a, 'A')).toBe('accepted');
    expect(record(app, projectAt(app, a).id)).toMatchObject({ targets: [], complete: true });
  });
});
