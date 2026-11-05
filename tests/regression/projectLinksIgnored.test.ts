/**
 * 연결 지점 기록은 git이 따라가는 링크만 담고, 폴더를 읽지 못했을 때는 남기지 않는다.
 * - S9-D1 (stage-8 리뷰 guards-shutdown8 D1, stage-8 회귀 — AC-18 '남의 프로젝트 파일 변경 거부'는 git이 실제로 바꾸는 파일만, S7-D1):
 *   stage 8이 첫 커밋이 있는 저장소의 연결 지점도 기록·거부하면서 git이 무시하는 연결 지점까지 셌다. Windows의 npm은 file: 의존성을
 *   node_modules/<lib> → ../<lib> 연결 지점으로 만드는데, node_modules/는 .gitignore에 있어 git은 그 안에 들어가지 않는다(커밋·병합이 lib에
 *   쓰지 않는다). 그런데 같은 lib를 쓰는 두 앱, 앱과 lib를 함께 등록하지 못했다. 이제 git이 무시하는 경로(GitService.ignoredPaths — 첫 커밋 전
 *   폴더는 새 저장소가 볼 규칙으로)는 연결 지점 검사·기록에서 뺀다. 추적하는 연결 지점과 무시하지 않는 연결 지점은 그대로 거부한다.
 * - S9-D3 (같은 리뷰 D3): 기록이 없는 옛 프로젝트를 다시 볼 때 그 폴더를 잠시 읽지 못하면(드라이브를 뗐거나 폴더를 옮김) 빈 '끝까지 본' 기록을
 *   남겨 다시 보지 않았다. 이제 읽지 못한 폴더는 기록하지 않아 다음 등록이 다시 본다. 등록할 때 새 폴더를 읽지 못하면 등록하지 않는다(기록도,
 *   폴더 변경도 없다 — 연결 지점을 보지 못한 폴더의 첫 커밋은 연결 지점을 따라 들어간다).
 * 원래 탐침: probe-archive/stage8-guards-shutdown8-review/tests-acceptance__zz-gs8r-links.probe.ts, tests-acceptance__zz-gs8r-rescan.probe.ts
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OPERATOR, type Project } from '@shared/domain';
import { bootApp, removeDirs, tempDir, type App } from '../acceptance/security-helpers';

const apps: App[] = [];
const dirs: string[] = [];
const links: string[] = [];
afterEach(async () => {
  for (const l of links.splice(0)) {
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
function commitAll(dir: string): void {
  execFileSync('git', ['-C', dir, '-c', 'core.autocrlf=false', 'add', '-A']);
  execFileSync('git', ['-C', dir, '-c', 'user.name=o', '-c', 'user.email=o@example.invalid', 'commit', '-q', '-m', 'c']);
}
/** 첫 커밋이 있는 JS 저장소 — .gitignore가 node_modules/를 무시하고 ../lib를 file: 의존성으로 쓴다 */
function jsRepo(dir: string): string {
  plain(dir, 1);
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\n');
  writeFileSync(join(dir, 'package.json'), '{"name":"app","dependencies":{"lib":"file:../lib"}}\n');
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  commitAll(dir);
  return dir;
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
const tracked = (repo: string): string[] => execFileSync('git', ['-C', repo, 'ls-files'], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
const registrationText = (app: App, projectId: string): string => app.ctx.store.activity.search({ text: `프로젝트 등록 ${projectId}` })[0]?.text ?? '';
const rescanLines = (app: App): string[] => app.ctx.store.activity.search({ text: '연결 지점 기록' }).map((a) => a.text);
function insertOld(app: App, id: string, path: string): void {
  const now = app.ctx.now();
  app.ctx.store.projects.insert({
    id,
    name: '옛 프로젝트',
    path,
    baseBranch: 'main',
    checkCommands: [],
    networkPolicy: 'allow',
    deploy: { pushRemote: null, deployCommand: null },
    mock: { enabled: false, speed: 1, defaultScenario: 'normal' },
    producerId: 'M-0900',
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  });
}

describe.skipIf(process.platform !== 'win32')('git이 무시하는 연결 지점은 프로젝트 겹침으로 보지 않는다 (S9-D1, AC-18)', () => {
  it('npm file: 의존성처럼 node_modules/lib → ../lib — 같은 lib에 닿는 두 저장소와 lib가 모두 등록되고, 기록에 lib가 없다', async () => {
    const app = await boot();
    const root = base('li-shared');
    const lib = plain(join(root, 'lib'));
    const app1 = jsRepo(join(root, 'app1'));
    const app2 = jsRepo(join(root, 'app2'));
    junction(lib, join(app1, 'node_modules', 'lib'));
    junction(lib, join(app2, 'node_modules', 'lib'));
    // git은 그 연결 지점을 무시하고 아무것도 추적하지 않는다 — 커밋·병합이 lib에 쓰지 않는다
    expect(execFileSync('git', ['-C', app1, 'check-ignore', 'node_modules/lib'], { encoding: 'utf8' }).trim()).toBe('node_modules/lib');
    expect(tracked(app1).filter((f) => f.startsWith('node_modules'))).toEqual([]);

    expect([await create(app, app1, 'app1'), await create(app, app2, 'app2'), await create(app, lib, 'lib')]).toEqual(['accepted', 'accepted', 'accepted']);
    const [p1, p2] = [projectAt(app, app1), projectAt(app, app2)];
    expect([record(app, p1.id), record(app, p2.id)].map((r) => r && { targets: r.targets, complete: r.complete })).toEqual([
      { targets: [], complete: true },
      { targets: [], complete: true },
    ]);
    expect(registrationText(app, p1.id)).not.toContain('연결 지점이 닿는 바깥 폴더');
    expect(rescanLines(app)).toEqual([]);
  });

  it('lib가 먼저 프로젝트여도 node_modules/lib가 lib에 닿는 저장소를 받는다', async () => {
    const app = await boot();
    const root = base('li-libfirst');
    const lib = plain(join(root, 'lib'));
    const app1 = jsRepo(join(root, 'app1'));
    junction(lib, join(app1, 'node_modules', 'lib'));
    expect([await create(app, lib, 'lib'), await create(app, app1, 'app1')]).toEqual(['accepted', 'accepted']);
  });

  it('첫 커밋 전 폴더도 새 저장소가 볼 규칙으로 본다 — 무시하는 연결 지점(따라 들어간 폴더 안의 .gitignore 포함)은 빼고, 무시하지 않는 것은 기록·거부한다', async () => {
    const app = await boot();
    const root = base('li-first');
    const lib = plain(join(root, 'lib'));
    const shared = plain(join(root, 'shared'));
    const x = plain(join(root, 'x'));
    const y = plain(join(root, 'y'));
    writeFileSync(join(x, '.gitignore'), 'toY\n');
    junction(y, join(x, 'toY'));
    const p = plain(join(root, 'p'));
    writeFileSync(join(p, '.gitignore'), 'node_modules/\n');
    junction(lib, join(p, 'node_modules', 'lib'));
    junction(shared, join(p, 'shared'));
    junction(x, join(p, 'toX'));
    expect(existsSync(join(p, '.git'))).toBe(false);

    expect(await create(app, p, 'P')).toBe('accepted');
    const pid = projectAt(app, p).id;
    // 첫 커밋(git add -A)은 무시하지 않는 연결 지점만 따라갔다
    const files = tracked(p);
    expect(files).toEqual(expect.arrayContaining(['shared/src/f0.txt', 'toX/src/f0.txt', 'toX/.gitignore']));
    expect(files.filter((f) => f.startsWith('node_modules/') || f.startsWith('toX/toY/'))).toEqual([]);
    expect(record(app, pid)?.targets.slice().sort()).toEqual([real(shared), real(x)].sort());
    expect(registrationText(app, pid)).toContain('연결 지점이 닿는 바깥 폴더 2곳');

    expect(await create(app, lib, 'lib')).toBe('accepted');
    expect(await create(app, y, 'Y')).toBe('accepted');
    expect(await create(app, shared, 'shared')).toMatch(new RegExp(`^refused forbidden: 다른 프로젝트\\(${pid} P\\)가 폴더 안의 연결 지점으로 닿는 폴더`));
    expect(await create(app, x, 'X')).toMatch(/^refused forbidden: /);
  });

  it('추적하는 연결 지점은 .gitignore에 적어도 그대로 본다 — 병합·작업 트리 맞추기가 그 안에 쓴다', async () => {
    const app = await boot();
    const root = base('li-tracked');
    const lib = plain(join(root, 'lib'));
    const repo = plain(join(root, 'repo'), 1);
    junction(lib, join(repo, 'plain'));
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    commitAll(repo);
    writeFileSync(join(repo, '.gitignore'), 'plain\n');
    commitAll(repo);
    expect(tracked(repo)).toContain('plain/src/f0.txt');

    expect(await create(app, repo, 'repo')).toBe('accepted');
    expect(record(app, projectAt(app, repo).id)?.targets).toEqual([real(lib)]);
    expect(await create(app, lib, 'lib')).toMatch(/^refused forbidden: 다른 프로젝트\(P-\d+ repo\)가 폴더 안의 연결 지점으로 닿는 폴더/);
  });

  it('기록이 없는 옛 프로젝트를 다시 볼 때도 git이 무시하는 연결 지점은 뺀다', async () => {
    const app = await boot();
    const root = base('li-old');
    const lib = plain(join(root, 'lib'));
    const shared = plain(join(root, 'shared'));
    const old = jsRepo(join(root, 'old'));
    junction(lib, join(old, 'node_modules', 'lib'));
    junction(shared, join(old, 'shared'));
    insertOld(app, 'P-0900', old);

    expect(await create(app, lib, 'lib')).toBe('accepted');
    expect(record(app, 'P-0900')?.targets).toEqual([real(shared)]);
    expect(rescanLines(app)).toEqual([expect.stringContaining('P-0900 옛 프로젝트 연결 지점 기록: 폴더 안의 연결 지점이 닿는 바깥 폴더 1곳')]);
    expect(await create(app, shared, 'shared')).toMatch(/^refused forbidden: 다른 프로젝트\(P-0900 옛 프로젝트\)가 폴더 안의 연결 지점으로 닿는 폴더/);
  });
});

describe.skipIf(process.platform !== 'win32')('읽지 못한 폴더는 연결 지점 기록을 남기지 않는다 — 다음 등록이 다시 본다 (S9-D3)', () => {
  it('옛 프로젝트 폴더가 다시 볼 때 잠시 없으면 기록하지 않고, 돌아온 뒤 다음 등록이 다시 봐 그 연결 지점이 닿는 B를 거부한다', async () => {
    const app = await boot();
    const root = base('li-away');
    const a = plain(join(root, 'a'));
    const b = plain(join(root, 'b'));
    const n = plain(join(root, 'n'));
    junction(b, join(a, 'linkToB'));
    insertOld(app, 'P-0900', a);

    renameSync(a, join(root, 'a-away'));
    expect(await create(app, n, 'N')).toBe('accepted');
    expect(record(app, 'P-0900')).toBeNull();
    renameSync(join(root, 'a-away'), a);

    expect(await create(app, b, 'B')).toMatch(/^refused forbidden: 다른 프로젝트\(P-0900 옛 프로젝트\)가 폴더 안의 연결 지점으로 닿는 폴더/);
    expect(record(app, 'P-0900')?.targets).toEqual([real(b)]);
    expect(rescanLines(app)).toEqual([expect.stringContaining('바깥 폴더 1곳')]);
    expect(app.ctx.store.projects.list().map((p) => p.path)).toEqual([a, n]);
  });

  it('등록할 때 새 폴더를 읽지 못하면(검사 사이에 옮겨짐) 등록하지 않는다 — 빈 기록도, git 초기화도 없다. 돌아온 뒤 다시 등록하면 연결 지점을 기록한다', async () => {
    const app = await boot();
    const root = base('li-regaway');
    const a = plain(join(root, 'a'));
    const b = plain(join(root, 'b'));
    junction(b, join(a, 'linkToB'));
    const away = join(root, 'a-away');
    // 등록이 연결 지점 검사 바로 앞(첫 커밋이 있는 저장소인지 본 뒤) 폴더가 잠시 사라지고(한 번만), git 초기화 전에 돌아온다
    const git = app.ctx.deps.git;
    const isRepo = git.isRepo.bind(git);
    const ensureRepo = git.ensureRepo.bind(git);
    let moved = false;
    let initCalls = 0;
    git.isRepo = async (dir) => {
      const r = await isRepo(dir);
      if (dir === a && !moved) {
        moved = true;
        renameSync(a, away);
      }
      return r;
    };
    git.ensureRepo = async (dir, o) => {
      if (dir === a && existsSync(away)) {
        initCalls++;
        renameSync(away, a);
      }
      return ensureRepo(dir, o);
    };

    expect(await create(app, a, 'A')).toBe(`refused not_found: 연결할 폴더를 읽지 못해 연결 지점을 확인하지 못했습니다 (그사이 옮겨졌거나 열 수 없음) — ${a}`);
    // 연결 지점을 보지 못한 폴더는 git 초기화·첫 커밋(연결 지점을 따라 들어간다)까지 가지 않는다
    expect(initCalls).toBe(0);
    renameSync(away, a);
    expect([existsSync(join(a, '.git')), existsSync(join(a, 'AGENTS.md'))]).toEqual([false, false]);
    expect(app.ctx.store.projects.list()).toEqual([]);

    expect(await create(app, a, 'A')).toBe('accepted');
    const aId = projectAt(app, a).id;
    expect(record(app, aId)?.targets).toEqual([real(b)]);
    expect(await create(app, b, 'B')).toMatch(new RegExp(`^refused forbidden: 다른 프로젝트\\(${aId} A\\)가 폴더 안의 연결 지점으로 닿는 폴더`));
  });
});
