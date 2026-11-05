/**
 * 등록된 프로젝트가 폴더 안의 연결 지점(junction)으로 닿는 폴더는 다른 프로젝트로 등록하지 않는다 — 그 반대도 (stage-7 리뷰 guards-shutdown7 D2 →
 * S8-D2, AC-18 남의 프로젝트 파일 변경 거부, S7-D1 '한 폴더는 두 프로젝트로 등록하지 않는다').
 * 예전에는 등록할 때 새 폴더 안의 연결 지점만 봤다(첫 커밋 전에만). 프로젝트 A의 폴더에 B를 가리키는 연결 지점이 있으면 A의 첫 커밋(git add -A)이
 * B의 파일을 담고, A의 병합·작업 트리 맞추기가 연결 지점을 따라 B에 쓴다. 그런데 뒤에 B를 등록하면 받아들였다 — 두 프로젝트가 같은 파일을 바꿨다.
 * 이제 등록할 때 폴더 안의 연결 지점이 닿는 바깥 폴더를 그 프로젝트의 기록으로 남기고(첫 커밋이 있는 저장소도 본다 — 병합이 연결 지점을 따라
 * 쓴다), 기록이 없는 프로젝트(이전 버전에서 등록)는 다음 등록 때 다시 본다. 그 폴더와 같거나 그 안이거나 그것을 품은 폴더는 forbidden,
 * 지금 등록 중인 폴더의 연결 지점이 닿는 곳과 겹치면 conflict다.
 * 원래 탐침: probe-archive/stage7-guards-shutdown7-review/tests-acceptance__zz-gs7r-d1attack.probe.ts -t "REVERSE JUNCTION"
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OPERATOR } from '@shared/domain';
import { bootApp, callTool, mainToken, removeDirs, tempDir, type App } from '../acceptance/security-helpers';

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

const outcome = (r: { ok: boolean; code?: string }): string => (r.ok ? 'accepted' : `refused ${r.code}`);
const settle = (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => 'accepted',
    (e: { code?: string; message?: string }) => `refused ${e.code}: ${e.message}`,
  );

function base(tag: string): string {
  const d = tempDir(tag);
  dirs.push(d);
  return d;
}

function plain(dir: string, n = 3): string {
  mkdirSync(join(dir, 'src'), { recursive: true });
  for (let i = 0; i < n; i++) writeFileSync(join(dir, 'src', `f${i}.txt`), `${i}\n`);
  return dir;
}

function committed(dir: string): string {
  plain(dir, 1);
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  execFileSync('git', ['-C', dir, '-c', 'core.autocrlf=false', 'add', '-A']);
  execFileSync('git', ['-C', dir, '-c', 'user.name=o', '-c', 'user.email=o@example.invalid', 'commit', '-q', '-m', 'init']);
  return dir;
}

function junction(target: string, at: string): void {
  symlinkSync(target, at, 'junction');
  links.push(at);
}

/** 거부된 등록이 그 폴더를 건드리지 않았는지 (git 초기화·지침 파일) */
const untouched = (dir: string): boolean => !existsSync(join(dir, '.git')) && !existsSync(join(dir, 'AGENTS.md'));
const registrationText = (app: App, projectId: string): string => app.ctx.store.activity.search({ text: `프로젝트 등록 ${projectId}` })[0]?.text ?? '';

describe.skipIf(process.platform !== 'win32')('연결 지점으로 닿는 폴더는 다른 프로젝트로 등록하지 않는다 (S8-D2, AC-18)', () => {
  it('A의 폴더에 B를 가리키는 연결 지점 — A를 등록한 뒤 B·B 안의 폴더·B를 품은 폴더는 forbidden, B는 그대로', async () => {
    const app = await boot();
    const root = base('lt-rev');
    const a = join(root, 'a');
    mkdirSync(a, { recursive: true });
    writeFileSync(join(a, 'readme.txt'), 'a\n');
    const outer = join(root, 'outer');
    const b = plain(join(outer, 'b'));
    junction(b, join(a, 'linkToB'));

    const rA = await callTool(app, mainToken(app, null), 'create_project', { name: 'A', path: a, mode: 'existing' });
    expect(outcome(rA)).toBe('accepted');
    const aId = app.ctx.store.projects.list()[0]!.id;
    // A의 첫 커밋이 연결 지점을 따라 B의 파일을 담았다 — B의 파일은 A가 바꾸는 파일이다
    expect(execFileSync('git', ['-C', a, 'ls-files'], { encoding: 'utf8' })).toContain('linkToB/src/f0.txt');
    expect(registrationText(app, aId)).toContain('연결 지점이 닿는 바깥 폴더 1곳');

    const rB = await callTool(app, mainToken(app, null), 'create_project', { name: 'B', path: b, mode: 'existing' });
    const rOwner = await settle(app.internal('projects.create', { mode: 'existing', path: b, name: 'B(운영자)', checkCommands: [] }));
    const rInside = await settle(app.core.projects.create({ mode: 'existing', path: join(b, 'src'), name: 'B 안' }, OPERATOR));
    const rParent = await settle(app.core.projects.create({ mode: 'existing', path: outer, name: 'B를 품은 폴더' }, OPERATOR));
    expect([outcome(rB), rB.message]).toEqual(['refused forbidden', expect.stringContaining(`다른 프로젝트(${aId} A)가 폴더 안의 연결 지점으로 닿는 폴더(`)]);
    expect(rOwner).toMatch(/^refused forbidden: 다른 프로젝트\(P-\d+ A\)가 폴더 안의 연결 지점으로 닿는 폴더/);
    expect(rInside).toMatch(/^refused forbidden: /);
    expect(rParent).toMatch(/^refused forbidden: /);
    expect([untouched(b), untouched(join(b, 'src')), untouched(outer)]).toEqual([true, true, true]);
    expect(app.ctx.store.projects.list().map((p) => p.id)).toEqual([aId]);
    expect(app.ctx.store.members.list().filter((m) => m.isProducer)).toHaveLength(1);
    // A는 등록할 때 기록했다 — 뒤의 등록들이 A의 폴더를 다시 훑지 않는다 (다시 훑으면 '연결 지점 기록' 줄이 남는다)
    expect(app.ctx.store.activity.search({ text: '연결 지점 기록' })).toEqual([]);
  });

  it('첫 커밋이 있는 저장소도 같다: 연결 지점으로 B에 닿는 저장소를 등록하면 B는 forbidden — 거꾸로 B가 먼저면 그 저장소가 forbidden (병합이 연결 지점을 따라 쓴다)', async () => {
    const app = await boot();
    const root = base('lt-repo');
    const b = plain(join(root, 'b'));
    const repo = committed(join(root, 'repo'));
    junction(b, join(repo, 'linkToB'));
    expect(await settle(app.core.projects.create({ mode: 'existing', path: repo, name: '저장소' }, OPERATOR))).toBe('accepted');
    expect(await settle(app.core.projects.create({ mode: 'existing', path: b, name: 'B' }, OPERATOR))).toMatch(/^refused forbidden: 다른 프로젝트\(P-\d+ 저장소\)가 폴더 안의 연결 지점으로 닿는 폴더/);
    expect(untouched(b)).toBe(true);

    // 반대 순서 (다른 앱): B가 먼저 등록돼 있으면 B에 닿는 연결 지점을 품은 저장소를 받지 않는다
    const app2 = await boot();
    const root2 = base('lt-repo2');
    const b2 = plain(join(root2, 'b'));
    const repo2 = committed(join(root2, 'repo'));
    junction(b2, join(repo2, 'linkToB'));
    expect(await settle(app2.core.projects.create({ mode: 'existing', path: b2, name: 'B' }, OPERATOR))).toBe('accepted');
    const r = await settle(app2.core.projects.create({ mode: 'existing', path: repo2, name: '저장소' }, OPERATOR));
    expect(r).toMatch(/^refused forbidden: 폴더 안의 연결 지점 .*linkToB.*이 가리키는 다른 프로젝트\(P-\d+ B\)의 폴더 때문에 .*병합·작업 트리 맞추기가 연결 지점을 따라 들어가/);
    expect(existsSync(join(repo2, 'AGENTS.md'))).toBe(false);
    expect(app2.ctx.store.projects.list().map((p) => p.name)).toEqual(['B']);
  });

  it('두 프로젝트가 한 바깥 폴더에 닿지 않는다: A가 T에 닿으면 T 안을 가리키는 연결 지점을 품은 폴더는 forbidden', async () => {
    const app = await boot();
    const root = base('lt-shared');
    const t = plain(join(root, 't'));
    const a = plain(join(root, 'a'));
    junction(t, join(a, 'shared'));
    const c = plain(join(root, 'c'));
    junction(join(t, 'src'), join(c, 'shared-src'));
    expect(await settle(app.core.projects.create({ mode: 'existing', path: a, name: 'A' }, OPERATOR))).toBe('accepted');
    const r = await settle(app.core.projects.create({ mode: 'existing', path: c, name: 'C' }, OPERATOR));
    expect(r).toMatch(/^refused forbidden: 폴더 안의 연결 지점 .*shared-src.*이 가리키는 다른 프로젝트\(P-\d+ A\)가 연결 지점으로 닿는 폴더/);
    expect(untouched(c)).toBe(true);
  });

  it('연결 지점 기록이 없는 프로젝트(이전 버전에서 등록)는 다음 등록 때 한 번 기록하고, 그 등록을 폴더를 건드리기 전에 거부한다', async () => {
    const app = await boot();
    const root = base('lt-old');
    const a = committed(join(root, 'a'));
    const b = plain(join(root, 'b'));
    junction(b, join(a, 'linkToB'));
    // 이전 버전이 등록한 프로젝트 (연결 지점 기록 없음)
    const now = app.ctx.now();
    app.ctx.store.projects.insert({
      id: 'P-0900',
      name: '옛 프로젝트',
      path: a,
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
    const first = await settle(app.core.projects.create({ mode: 'existing', path: b, name: 'B' }, OPERATOR));
    const again = await settle(callTool(app, mainToken(app, null), 'create_project', { name: 'B', path: b, mode: 'existing' }).then((x) => (x.ok ? undefined : Promise.reject(x))));
    expect(first).toMatch(/^refused forbidden: 다른 프로젝트\(P-0900 옛 프로젝트\)가 폴더 안의 연결 지점으로 닿는 폴더/);
    expect(again).toMatch(/^refused forbidden: 다른 프로젝트\(P-0900 옛 프로젝트\)/);
    expect(untouched(b)).toBe(true);
    // 기록은 한 번 (두 번째 등록은 기록을 다시 만들지 않는다)
    expect(app.ctx.store.activity.search({ text: 'P-0900 옛 프로젝트 연결 지점 기록' }).map((x) => x.text)).toEqual([expect.stringContaining('바깥 폴더 1곳')]);
    expect(app.ctx.store.projects.list().map((p) => p.id)).toEqual(['P-0900']);
  });

  it('등록 중인 A의 연결 지점 검사가 이미 B를 지났으면 B 등록은 conflict — A가 끝나면 forbidden', async () => {
    const app = await boot();
    const root = base('lt-inflight');
    const a = plain(join(root, 'a'));
    const b = plain(join(root, 'b'));
    junction(b, join(a, 'linkToB'));
    const g = app.ctx.deps.git;
    const orig = g.ensureRepo.bind(g);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let gated = false;
    g.ensureRepo = async (dir, o) => {
      if (dir.toLowerCase() === a.toLowerCase()) {
        gated = true;
        await gate; // A는 연결 지점 검사를 마치고 첫 커밋 단계에 있다
      }
      return orig(dir, o);
    };
    const first = settle(app.core.projects.create({ mode: 'existing', path: a, name: 'A' }, OPERATOR));
    while (!gated) await new Promise((r) => setTimeout(r, 10));
    const during = await settle(app.core.projects.create({ mode: 'existing', path: b, name: 'B' }, OPERATOR));
    release();
    expect(await first).toBe('accepted');
    const after = await settle(app.core.projects.create({ mode: 'existing', path: b, name: 'B' }, OPERATOR));
    expect(during).toMatch(/^refused conflict: 지금 프로젝트로 등록하는 중인 폴더\(.*\)가 연결 지점으로 닿는 폴더\(.*\)와 겹칩니다/);
    expect(after).toMatch(/^refused forbidden: 다른 프로젝트\(P-\d+ A\)가 폴더 안의 연결 지점으로 닿는 폴더/);
    expect(untouched(b)).toBe(true);
    expect(app.ctx.store.projects.list().map((p) => p.name)).toEqual(['A']);
  });

  it('등록 중인 A가 바깥 폴더 T에 닿는 동안, T를 가리키는 연결 지점을 품은 C는 conflict (A의 연결 지점 검사가 이미 T를 지났다)', async () => {
    const app = await boot();
    const root = base('lt-inflight2');
    const t = plain(join(root, 't'));
    const a = plain(join(root, 'a'));
    junction(t, join(a, 'shared'));
    const c = plain(join(root, 'c'));
    junction(t, join(c, 'shared'));
    const g = app.ctx.deps.git;
    const orig = g.ensureRepo.bind(g);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let gated = false;
    g.ensureRepo = async (dir, o) => {
      if (dir.toLowerCase() === a.toLowerCase()) {
        gated = true;
        await gate;
      }
      return orig(dir, o);
    };
    const first = settle(app.core.projects.create({ mode: 'existing', path: a, name: 'A' }, OPERATOR));
    while (!gated) await new Promise((r) => setTimeout(r, 10));
    const during = await settle(app.core.projects.create({ mode: 'existing', path: c, name: 'C' }, OPERATOR));
    release();
    expect(await first).toBe('accepted');
    expect(during).toMatch(/^refused conflict: 폴더 안의 연결 지점 .*이 가리키는 지금 프로젝트로 등록 중인 다른 폴더\(.*\)가 연결 지점으로 닿는 폴더/);
    expect(untouched(c)).toBe(true);
    expect(app.ctx.store.projects.list().map((p) => p.name)).toEqual(['A']);
  });

  it('기다리는 사이 연결 지점이 닿는 폴더가 다른 길로 프로젝트가 됐으면 저장하기 바로 앞에서 거부한다 (두 번째 프로듀서 없음)', async () => {
    const app = await boot();
    const root = base('lt-recheck');
    const t = plain(join(root, 't'));
    const a = plain(join(root, 'a'));
    junction(t, join(a, 'shared'));
    const g = app.ctx.deps.git;
    const orig = g.ensureRepo.bind(g);
    g.ensureRepo = async (dir, o) => {
      const r = await orig(dir, o);
      const now = app.ctx.now();
      // 첫 커밋을 기다리는 사이 T가 프로젝트로 저장됐다 (다른 길로 끝난 등록)
      app.ctx.store.projects.insert({
        id: 'P-0901',
        name: 'T 프로젝트',
        path: t,
        baseBranch: 'main',
        checkCommands: [],
        networkPolicy: 'allow',
        deploy: { pushRemote: null, deployCommand: null },
        mock: { enabled: false, speed: 1, defaultScenario: 'normal' },
        producerId: 'M-0901',
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
      });
      return r;
    };
    const r = await settle(app.core.projects.create({ mode: 'existing', path: a, name: 'A' }, OPERATOR));
    expect(r).toMatch(/^refused forbidden: 폴더 안의 연결 지점이 닿는 폴더\(.*\)가 다른 프로젝트\(P-0901 T 프로젝트\)의 파일과 겹쳐/);
    expect(app.ctx.store.projects.list().map((p) => p.id)).toEqual(['P-0901']);
    expect(app.ctx.store.members.list().filter((m) => m.isProducer)).toHaveLength(0);
  });

  it('첫 커밋이 있는 저장소라도 앱 데이터 폴더를 가리키는 연결 지점을 품으면 등록하지 않는다 (병합이 연결 지점을 따라 앱 기록에 쓴다)', async () => {
    const app = await boot();
    const root = base('lt-app');
    const repo = committed(join(root, 'repo'));
    junction(app.dataDir, join(repo, 'appdata'));
    const r = await settle(app.core.projects.create({ mode: 'existing', path: repo, name: '저장소' }, OPERATOR));
    expect(r).toMatch(/^refused forbidden: 앱 금지 정책: 폴더 안의 연결 지점 .*appdata.*앱 데이터 폴더/);
    expect(existsSync(join(repo, 'AGENTS.md'))).toBe(false);
    expect(app.ctx.store.projects.list()).toHaveLength(0);
  });
});
