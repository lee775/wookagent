/**
 * 겹친 두 프로젝트 등록은 한 프로젝트와 거부(conflict) 하나가 된다 (stage-6 리뷰 guards-stops D1 → S7-D1 — AC-18 남의 프로젝트 파일 변경 거부,
 * GIT-03 앱 도구 요청의 경로 검사, S6-D1/D2 결정 '같은 폴더 = conflict').
 * 예전에는 경로 검사(등록된 프로젝트와 겹치는지)를 한 뒤 git 초기화·첫 커밋·연결 지점 검사를 기다리고 나서야 저장했다. 그 사이 같은 폴더의 다른
 * 등록(대표 화면의 projects.create와 메인 에이전트의 create_project, 한 턴의 도구 두 번 호출, 시간 초과 뒤 다시 보낸 요청)이 같은 검사를 지나
 * 한 폴더(저장소)가 두 프로젝트로 등록됐다. 이제 경로 검사와 같은 동기 구간에서 그 폴더를 '등록 중'으로 두고 겹치는 등록은 conflict로 거부하며,
 * 저장하기 바로 앞(같은 트랜잭션)에서 등록된 프로젝트와 다시 견준다. 등록이 끝나거나 실패하면 '등록 중'을 푼다.
 * 원래 탐침: probe-archive/stage6-guards-stops-review/tests/acceptance/zz-s6gsr-paths.probe.ts
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Project } from '@shared/domain';
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
  const app = await bootApp({ stopScheduler: true, runnerMode: process.platform === 'win32' ? 'taskkill' : 'pgroup' });
  apps.push(app);
  return app;
}

const outcome = (r: { ok: boolean; code?: string }): string => (r.ok ? 'accepted' : `refused ${r.code}`);
const settle = (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => 'accepted',
    (e: { code?: string }) => `refused ${e.code}`,
  );
const projectsAt = (app: App, dir: string): Project[] => app.ctx.store.projects.list().filter((p) => p.path.toLowerCase() === dir.toLowerCase());

function committedRepo(tag: string): string {
  const base = tempDir(tag);
  dirs.push(base);
  const repo = join(base, 'repo');
  mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  execFileSync('git', ['-C', repo, 'add', '-A']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=o', '-c', 'user.email=o@example.invalid', 'commit', '-q', '-m', 'init']);
  return repo;
}

/** git 저장소가 아닌 폴더 (첫 커밋 전 연결 지점 검사가 폴더 전체를 훑어 등록이 길어진다) */
function plainFolder(tag: string, files = 200): string {
  const base = tempDir(tag);
  dirs.push(base);
  const dir = join(base, 'plain');
  mkdirSync(join(dir, 'src'), { recursive: true });
  for (let i = 0; i < files; i++) writeFileSync(join(dir, 'src', `f${i}.txt`), `${i}\n`);
  return dir;
}

describe('겹친 두 프로젝트 등록 — 한 폴더는 한 프로젝트 (S7-D1, AC-18, GIT-03)', () => {
  it('메인 에이전트의 create_project 두 번(같은 커밋된 저장소)이 겹치면 하나만 등록되고 다른 하나는 conflict — 끝난 뒤 다시 보내도 conflict', async () => {
    const app = await boot();
    const repo = committedRepo('race-tool');
    const [r1, r2] = await Promise.all([
      callTool(app, mainToken(app, null), 'create_project', { name: 'dup1', path: repo, mode: 'existing' }),
      callTool(app, mainToken(app, null), 'create_project', { name: 'dup2', path: repo, mode: 'existing' }),
    ]);
    expect([outcome(r1), outcome(r2)].sort()).toEqual(['accepted', 'refused conflict']);
    expect((r1.ok ? r2 : r1).message).toContain('지금 프로젝트로 등록하는 중');
    expect(app.ctx.store.projects.list()).toHaveLength(1);
    // 프로듀서도 하나 (실패한 등록이 팀원을 남기지 않음)
    expect(app.ctx.store.members.list().filter((m) => m.isProducer)).toHaveLength(1);
    // 시간 초과 뒤 다시 보낸 요청: 이미 등록된 폴더
    const r3 = await callTool(app, mainToken(app, null), 'create_project', { name: 'dup3', path: repo, mode: 'existing' });
    expect([outcome(r3), r3.message]).toEqual(['refused conflict', expect.stringContaining('이미 등록된 폴더')]);
    expect(app.ctx.store.projects.list()).toHaveLength(1);
  });

  it('운영자 경로(내부 API, 옛 대표 화면 projects.create)와 메인 에이전트(create_project)가 같은 git 아닌 폴더를 함께 등록하면 하나만 등록된다', async () => {
    const app = await boot();
    const plain = plainFolder('race-owner');
    const outcomes = await Promise.all([
      settle(app.internal('projects.create', { mode: 'existing', path: plain, name: 'owner', checkCommands: [] })),
      callTool(app, mainToken(app, null), 'create_project', { name: 'agent', path: plain, mode: 'existing' }).then(outcome),
    ]);
    expect(outcomes.sort()).toEqual(['accepted', 'refused conflict']);
    expect(projectsAt(app, plain)).toHaveLength(1);
    expect(app.ctx.store.projects.list()).toHaveLength(1);
  });

  it.skipIf(process.platform !== 'win32')('다른 철자(대소문자를 바꾼 경로)로 겹쳐 등록해도 같은 폴더로 본다', async () => {
    const app = await boot();
    const repo = committedRepo('race-case');
    const flipped = repo.slice(0, 3) + [...repo.slice(3)].map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase())).join('');
    const outcomes = await Promise.all([
      settle(app.core.projects.create({ mode: 'existing', path: repo, name: 'a' }, OPERATOR)),
      settle(app.core.projects.create({ mode: 'existing', path: flipped, name: 'b' }, OPERATOR)),
    ]);
    expect(outcomes).toEqual(['accepted', 'refused conflict']);
    expect(app.ctx.store.projects.list()).toHaveLength(1);
  });

  it('등록 중인 폴더 안의 폴더와 그 폴더를 품은 상위 폴더도 겹쳐 등록하지 않는다 (먼저 시작한 등록만)', async () => {
    const app = await boot();
    const outer = plainFolder('race-nest');
    const inner = join(outer, 'src');
    const [a, b] = await Promise.all([
      settle(app.core.projects.create({ mode: 'existing', path: outer, name: 'outer' }, OPERATOR)),
      app.core.projects.create({ mode: 'existing', path: inner, name: 'inner' }, OPERATOR).then(
        () => 'accepted',
        (e: { code?: string; message?: string }) => `refused ${e.code}: ${e.message}`,
      ),
    ]);
    expect(a).toBe('accepted');
    expect(b).toMatch(/^refused conflict: 이 폴더를 품은 폴더\(.*\)를 지금 프로젝트로 등록하는 중입니다/);
    expect(app.ctx.store.projects.list().map((p) => p.name)).toEqual(['outer']);

    const outer2 = plainFolder('race-nest2');
    const [c, d] = await Promise.all([
      settle(app.core.projects.create({ mode: 'existing', path: join(outer2, 'src'), name: 'inner2' }, OPERATOR)),
      settle(app.core.projects.create({ mode: 'existing', path: outer2, name: 'outer2' }, OPERATOR)),
    ]);
    expect([c, d]).toEqual(['accepted', 'refused conflict']);
    expect(app.ctx.store.projects.list().map((p) => p.name).sort()).toEqual(['inner2', 'outer']);
  });

  it.skipIf(process.platform !== 'win32')('폴더 안의 연결 지점이 지금 등록 중인 다른 폴더를 가리키면 그 등록이 끝나기 전에도 겹친 것으로 거부한다 (conflict)', async () => {
    const app = await boot();
    const target = committedRepo('race-link-target');
    const plain = plainFolder('race-link', 20);
    const link = join(plain, 'linked');
    symlinkSync(target, link, 'junction');
    links.push(link);
    const g = app.ctx.deps.git;
    const orig = g.ensureRepo.bind(g);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let gated = false;
    g.ensureRepo = async (dir, o) => {
      if (dir.toLowerCase() === target.toLowerCase()) {
        gated = true;
        await gate; // 대상 폴더의 등록이 첫 커밋 단계에 있다
      }
      return orig(dir, o);
    };
    const first = settle(app.core.projects.create({ mode: 'existing', path: target, name: 'target' }, OPERATOR));
    while (!gated) await new Promise((r) => setTimeout(r, 10));
    const second = await app.core.projects.create({ mode: 'existing', path: plain, name: 'with link' }, OPERATOR).then(
      () => 'accepted',
      (e: { code?: string; message?: string }) => `refused ${e.code}: ${e.message}`,
    );
    release();
    expect(await first).toBe('accepted');
    expect(second).toMatch(/^refused conflict: 폴더 안의 연결 지점 .*이 가리키는 지금 프로젝트로 등록 중인 다른 폴더/);
    expect(app.ctx.store.projects.list().map((p) => p.name)).toEqual(['target']);
  });

  it('등록이 실패하면 등록 중 표시를 푼다 — 그 사이 겹친 요청은 conflict, 실패 뒤에는 같은 폴더를 다시 등록할 수 있다', async () => {
    const app = await boot();
    const repo = committedRepo('race-fail');
    const g = app.ctx.deps.git;
    const orig = g.ensureRepo.bind(g);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    g.ensureRepo = async (dir, o) => {
      if (++calls === 1) {
        await gate;
        throw new Error('git 초기화 실패 (시험)');
      }
      return orig(dir, o);
    };
    const first = app.core.projects.create({ mode: 'existing', path: repo, name: 'first' }, OPERATOR).then(
      () => 'accepted',
      (e: Error) => `failed: ${e.message}`,
    );
    while (calls === 0) await new Promise((r) => setTimeout(r, 10));
    const second = await settle(app.core.projects.create({ mode: 'existing', path: repo, name: 'second' }, OPERATOR));
    expect(second).toBe('refused conflict');
    release();
    expect(await first).toContain('git 초기화 실패 (시험)');
    expect(app.ctx.store.projects.list()).toHaveLength(0);
    const third = await settle(app.core.projects.create({ mode: 'existing', path: repo, name: 'third' }, OPERATOR));
    expect(third).toBe('accepted');
    expect(app.ctx.store.projects.list().map((p) => p.name)).toEqual(['third']);
  });

  it('기다리는 사이 같은 폴더가 등록됐으면 저장하기 바로 앞에서 다시 견주어 넣지 않는다 (conflict, 두 번째 프로듀서 없음)', async () => {
    const app = await boot();
    const repo = committedRepo('race-recheck');
    const g = app.ctx.deps.git;
    const orig = g.ensureRepo.bind(g);
    g.ensureRepo = async (dir, o) => {
      const r = await orig(dir, o);
      // 첫 커밋을 기다리는 사이 같은 폴더의 프로젝트가 저장됐다 (다른 길로 끝난 등록)
      const now = app.ctx.now();
      app.ctx.store.projects.insert({
        id: 'P-9999',
        name: '먼저 끝난 등록',
        path: repo,
        baseBranch: 'main',
        checkCommands: [],
        networkPolicy: 'allow',
        deploy: { pushRemote: null, deployCommand: null },
        mock: { enabled: false, speed: 1, defaultScenario: 'normal' },
        producerId: 'M-9999',
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
      });
      return r;
    };
    const r = await app.core.projects.create({ mode: 'existing', path: repo, name: 'late' }, OPERATOR).then(
      () => 'accepted',
      (e: { code?: string; message?: string }) => `refused ${e.code}: ${e.message}`,
    );
    expect(r).toMatch(/^refused conflict: 이미 등록된 폴더입니다 \(P-9999/);
    expect(app.ctx.store.projects.list().map((p) => p.id)).toEqual(['P-9999']);
    expect(app.ctx.store.members.list().filter((m) => m.isProducer)).toHaveLength(0);
  });
});
