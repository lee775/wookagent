/**
 * 프로젝트 등록 경로 검사는 경로 글자가 아니라 같은 폴더인지로 본다 (AC-18·19, 10.2·10.3 앱 금지 정책, GIT-03, 12장 긴급 알림).
 * 단계 5의 검사는 실제 경로 문자열을 비교해 같은 폴더의 다른 철자를 놓쳤다:
 * - 루프백 관리 공유(\\localhost\C$\…) — realpath는 C:\로 바꾸지 않는다. 앱 데이터 폴더·그 상위 폴더·다른 팀원의 작업 폴더(worktree)·
 *   이미 등록된 프로젝트가 그대로 등록됐다 (앱 DB·기록이 커밋되고, 팀원의 작업 브랜치가 새 프로젝트의 기준 브랜치가 됐다)
 * - 끝에 점·공백을 붙인 새 폴더 — Node는 글자 그대로 새 폴더를 만들지만 git은 끝 글자를 지운 앱 데이터 폴더에서 돌았다
 * - 앱 데이터 폴더를 가리키는 연결 지점(junction)을 품은 폴더 — 첫 커밋(git add -A)이 연결 지점을 따라가 앱 DB를 커밋했다
 * 이제 파일 식별자로 비교하고, 로컬 드라이브 폴더가 아닌 경로·끝이 점·공백인 이름은 등록하지 않고, 첫 커밋 전에 연결 지점을 본다.
 * 원래 탐침: probe-archive/auth-security/probes/tests/acceptance/zz-authsec-unc.probe.ts
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID, OPERATOR } from '@shared/domain';
import { addProject, bootApp, callTool, mainToken, removeDirs, revParse, tempDir, type App } from '../acceptance/security-helpers';

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

async function boot(o: Parameters<typeof bootApp>[0] = {}): Promise<App> {
  const app = await bootApp({ stopScheduler: true, runnerMode: 'taskkill', ...o });
  apps.push(app);
  return app;
}

/** C:\x\y → \\localhost\C$\x\y (같은 폴더를 루프백 관리 공유로) */
const unc = (p: string): string => `\\\\localhost\\${p[0]}$${p.slice(2)}`;

const sameFolder = (a: string, b: string): boolean => {
  const x = statSync(a, { bigint: true });
  const y = statSync(b, { bigint: true });
  return x.dev === y.dev && x.ino === y.ino;
};

const tracked = (dir: string): string[] => (existsSync(join(dir, '.git')) ? execFileSync('git', ['-C', dir, 'ls-files'], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean) : []);
const urgentTitles = (app: App): string[] => app.ctx.store.notifications.list().filter((n) => n.level === 'urgent').map((n) => n.title);
const outcome = (r: { ok: boolean; code?: string }): string => (r.ok ? 'accepted' : `refused ${r.code}`);

describe.skipIf(process.platform !== 'win32')('프로젝트 등록 경로 검사 — 같은 폴더의 다른 철자 (AC-18·19)', () => {
  it('AC-19: 앱 데이터 폴더를 \\\\localhost\\C$로 적어도 앱 금지 정책 위반으로 거부·긴급 알림하고, 앱 데이터에 저장소·지침 파일을 만들지 않는다', async () => {
    const app = await boot();
    const target = unc(app.dataDir);
    expect(sameFolder(target, app.dataDir)).toBe(true);
    const r = await callTool(app, mainToken(app, null), 'create_project', { name: '앱 데이터(UNC)', path: target, mode: 'existing' });
    expect({
      result: outcome(r),
      message: r.message,
      registered: app.ctx.store.projects.list().length,
      gitCreated: existsSync(join(app.dataDir, '.git')),
      guidelines: existsSync(join(app.dataDir, 'AGENTS.md')),
      urgent: urgentTitles(app),
    }).toEqual({
      result: 'refused forbidden',
      message: expect.stringContaining('앱 금지 정책: 앱 데이터 폴더(앱 설정·기록)'),
      registered: 0,
      gitCreated: false,
      guidelines: false,
      urgent: ['앱 금지 정책 위반'],
    });
  });

  it('AC-19: 앱 데이터 폴더를 품은 상위 폴더(사용자 폴더)를 \\\\localhost\\C$로 적어도 거부하고 앱 DB·기록을 커밋하지 않는다', async () => {
    const home = tempDir('apphome');
    dirs.push(home);
    const dataDir = join(home, 'AppData', 'Roaming', 'wookagent');
    mkdirSync(dataDir, { recursive: true });
    const app = await boot({ dataDir });
    const r = await callTool(app, mainToken(app, null), 'create_project', { name: '사용자 폴더(UNC)', path: unc(home), mode: 'existing' });
    expect({ result: outcome(r), message: r.message, gitCreated: existsSync(join(home, '.git')), committed: tracked(home).filter((x) => /wookagent\/(wook\.db|logs\/)/.test(x)) }).toEqual({
      result: 'refused forbidden',
      message: expect.stringContaining('앱 데이터 폴더를 품은 상위 폴더'),
      gitCreated: false,
      committed: [],
    });
  });

  it('AC-18: 다른 팀원의 작업 폴더(앱이 관리하는 worktree)를 \\\\localhost\\C$로 적어도 거부하고, 그 팀원의 작업 브랜치는 새 프로젝트의 기준 브랜치가 되지 않는다', async () => {
    const app = await boot();
    const A = await addProject(app, { name: '프로젝트A', team: ['developer'], mock: false });
    dirs.push(A.root);
    const d = app.core.directives.register({ projectId: A.id, title: 'A 지시', text: 'A 지시' }, MAIN_AGENT_ID, null).id;
    const t = app.core.tasks.create({ directiveId: d, title: '작업', goal: '목표', type: 'development', assigneeId: A.members.developer!, reviewerId: null, acceptanceCriteria: ['x'], outputMode: 'repo' }, A.producerId).id;
    expect(await app.core.tasks.activateForLaunch(t)).toBe(true);
    const ws = app.ctx.store.tasks.require(t).workspace!;
    const head0 = revParse(A.dir, `refs/heads/${ws.branch}`);
    const r = await callTool(app, mainToken(app, null), 'create_project', { name: '남의 작업 폴더(UNC)', path: unc(ws.worktreePath), mode: 'existing' });
    expect({
      result: outcome(r),
      message: r.message,
      projects: app.ctx.store.projects.list().map((p) => p.id),
      branchMoved: revParse(A.dir, `refs/heads/${ws.branch}`) !== head0,
      urgent: urgentTitles(app),
    }).toEqual({ result: 'refused forbidden', message: expect.stringContaining('다른 팀원의 작업 폴더'), projects: [A.id], branchMoved: false, urgent: ['앱 금지 정책 위반'] });
  });

  it('이미 등록된 프로젝트 폴더를 \\\\localhost\\C$로 적어도 같은 폴더로 보고(conflict) 두 번 등록하지 않는다', async () => {
    const app = await boot();
    const A = await addProject(app, { name: '프로젝트A', team: ['developer'], mock: false, files: { 'README.md': 'a\n' } });
    dirs.push(A.root);
    const r = await callTool(app, mainToken(app, null), 'create_project', { name: '같은 저장소(UNC)', path: unc(A.dir), mode: 'existing' });
    expect({ result: outcome(r), message: r.message, projects: app.ctx.store.projects.list().length }).toEqual({ result: 'refused conflict', message: expect.stringContaining('이미 등록된 폴더'), projects: 1 });
  });

  it('AC-19: 앱 데이터 폴더를 가리키는 연결 지점(junction)을 품은 폴더는 첫 커밋 전에 거부·긴급 알림하고 저장소를 만들지 않는다 (git add -A가 연결 지점을 따라간다)', async () => {
    const app = await boot();
    const outer = tempDir('junc');
    dirs.push(outer);
    const evil = join(outer, 'evil');
    mkdirSync(join(evil, 'src'), { recursive: true });
    writeFileSync(join(evil, 'src', 'index.js'), 'console.log(1)\n', 'utf8');
    const link = join(evil, 'src', 'appdata');
    symlinkSync(app.dataDir, link, 'junction');
    links.push(link);
    const r = await callTool(app, mainToken(app, null), 'create_project', { name: '연결 지점', path: evil, mode: 'existing' });
    expect({ result: outcome(r), message: r.message, gitCreated: existsSync(join(evil, '.git')), projects: app.ctx.store.projects.list().length, urgent: urgentTitles(app) }).toEqual({
      result: 'refused forbidden',
      message: expect.stringMatching(/앱 금지 정책: 폴더 안의 연결 지점 .*appdata.*앱 데이터 폴더/),
      gitCreated: false,
      projects: 0,
      urgent: ['앱 금지 정책 위반'],
    });
  });

  it('다른 프로젝트 폴더를 가리키는 연결 지점을 품은 폴더, 다른 프로젝트 폴더를 품은 상위 폴더도 등록하지 않는다 — 연결 지점이 자기 폴더 안을 가리키는 것은 괜찮다', async () => {
    const app = await boot();
    const A = await addProject(app, { name: '프로젝트A', mock: false, files: { 'a.txt': 'a\n' } });
    dirs.push(A.root);
    const outer = tempDir('junc2');
    dirs.push(outer);
    const viaLink = join(outer, 'via-link');
    mkdirSync(viaLink, { recursive: true });
    const link = join(viaLink, 'other-project');
    symlinkSync(A.dir, link, 'junction');
    links.push(link);
    const r1 = await callTool(app, mainToken(app, null), 'create_project', { name: '남의 프로젝트 연결', path: viaLink, mode: 'existing' });
    // A.root는 A.dir(등록된 프로젝트)을 품는다
    const r2 = await callTool(app, mainToken(app, null), 'create_project', { name: '상위 폴더', path: A.root, mode: 'existing' });
    // pnpm처럼 연결 지점이 자기 폴더 안을 가리키면 막지 않는다
    const ok = join(outer, 'ok');
    mkdirSync(join(ok, 'node_modules', '.store', 'pkg'), { recursive: true });
    writeFileSync(join(ok, 'node_modules', '.store', 'pkg', 'index.js'), '1\n', 'utf8');
    const inner = join(ok, 'node_modules', 'pkg');
    symlinkSync(join(ok, 'node_modules', '.store', 'pkg'), inner, 'junction');
    links.push(inner);
    const r3 = await callTool(app, mainToken(app, null), 'create_project', { name: '안쪽 연결 지점', path: ok, mode: 'existing' });
    expect({
      viaLink: [outcome(r1), r1.message?.includes(`다른 프로젝트(${A.id}`), existsSync(join(viaLink, '.git'))],
      parent: [outcome(r2), r2.message?.includes('품은 상위 폴더'), existsSync(join(A.root, '.git'))],
      inner: outcome(r3),
      urgent: urgentTitles(app),
    }).toEqual({ viaLink: ['refused forbidden', true, false], parent: ['refused forbidden', true, false], inner: 'accepted', urgent: [] });
  });

  for (const suffix of ['.', ' ']) {
    it(`AC-19: 새 폴더로 앱 데이터 폴더 경로 끝에 ${JSON.stringify(suffix)}를 붙이면 (git은 끝 글자를 지운 앱 데이터 폴더에서 돈다) 거부·긴급 알림하고 폴더도 저장소도 만들지 않는다`, async () => {
      const app = await boot();
      const r = await callTool(app, mainToken(app, null), 'create_project', { name: '끝 글자', path: app.dataDir + suffix, mode: 'new' });
      const literal = `\\\\?\\${app.dataDir}${suffix}`;
      const literalMade = existsSync(literal);
      if (literalMade) dirs.push(literal);
      expect({
        result: outcome(r),
        message: r.message,
        projects: app.ctx.store.projects.list().length,
        literalFolder: literalMade,
        gitInAppData: existsSync(join(app.dataDir, '.git')),
        committed: tracked(app.dataDir),
        urgent: urgentTitles(app),
      }).toEqual({
        result: 'refused forbidden',
        message: expect.stringContaining('앱 데이터 폴더(앱 설정·기록)'),
        projects: 0,
        literalFolder: false,
        gitInAppData: false,
        committed: [],
        urgent: ['앱 금지 정책 위반'],
      });
    });
  }

  it('로컬 드라이브 폴더가 아닌 경로(끝이 점·공백인 이름, 다른 PC의 공유 폴더, 장치 경로)는 무엇을 쓸 수 있는지 알려 주며 거부하고, 다른 PC 경로에는 손대지 않는다', async () => {
    const app = await boot();
    const base = tempDir('names');
    dirs.push(base);
    const cases: [string, string][] = [
      ['끝 점', join(base, 'proj.')],
      ['끝 공백', join(base, 'proj ')],
      ['중간 끝 점', join(base, 'a.', 'proj')],
      ['장치 이름', join(base, 'nul')],
      ['다른 PC', '\\\\192.0.2.1\\share\\proj'],
      ['장치 경로', `\\\\?\\${join(base, 'proj2')}`],
    ];
    const got: Record<string, unknown> = {};
    for (const [label, path] of cases) {
      const t0 = Date.now();
      const r = await app.core.projects.create({ name: label, path, mode: 'new' }, OPERATOR).then(
        () => ({ ok: true, code: undefined, message: '' }),
        (e: { code?: string; message: string }) => ({ ok: false, code: e.code, message: e.message }),
      );
      got[label] = { result: outcome(r), explains: r.message.includes('로컬 드라이브 폴더(예: C:\\work\\my-app)만 등록할 수 있습니다'), fast: Date.now() - t0 < 5_000 };
    }
    const made = ['proj.', 'proj ', 'a.', 'nul', 'proj2'].filter((n) => existsSync(`\\\\?\\${join(base, n)}`));
    for (const n of made) rmSync(`\\\\?\\${join(base, n)}`, { recursive: true, force: true });
    const want = { result: 'refused invalid', explains: true, fast: true };
    expect({ got, made, projects: app.ctx.store.projects.list().length, urgent: urgentTitles(app) }).toEqual({
      got: Object.fromEntries(cases.map(([label]) => [label, want])),
      made: [],
      projects: 0,
      urgent: [],
    });
  });

  it('폴더가 지워진 프로젝트의 경로를 다시 등록해도 같은 폴더로 본다(conflict) — 파일 식별자가 없으면 실제 경로 글자로 비교한다', async () => {
    const app = await boot();
    const A = await addProject(app, { name: '프로젝트A', mock: false });
    dirs.push(A.root);
    rmSync(A.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    const r = await callTool(app, mainToken(app, null), 'create_project', { name: '같은 경로', path: A.dir, mode: 'new' });
    expect({ result: outcome(r), projects: app.ctx.store.projects.list().length }).toEqual({ result: 'refused conflict', projects: 1 });
  });

  it('운영자 경로(내부 API, 옛 대표 화면 projects.create)에서도 같은 폴더의 다른 철자를 막는다 — 에이전트가 아닌 요청은 기록만 하고 긴급 알림은 띄우지 않는다', async () => {
    const app = await boot();
    const err = await app.internal('projects.create', { mode: 'existing', path: unc(app.dataDir), name: '운영자 실수', checkCommands: [] }).then(
      () => null,
      (e: { code?: string; message: string }) => e,
    );
    const warn = app.ctx.store.activity.search({ kinds: ['system'], limit: 20 }).find((e) => e.text.startsWith('프로젝트 등록 거부'));
    expect({ code: err?.code, gitCreated: existsSync(join(app.dataDir, '.git')), warn: warn?.level, urgent: urgentTitles(app) }).toEqual({ code: 'forbidden', gitCreated: false, warn: 'warn', urgent: [] });
  });
});

/**
 * Linux (리드 결정 S10-6.6): 위의 묶음은 Windows의 철자(루프백 관리 공유·끝 점·공백·8.3·연결 지점)라 Windows만이다 — Linux에는 그런 철자가 없다. Linux의
 * 규칙은 /proc·/sys·/dev와 그 안, 네트워크 파일 시스템을 등록하지 않는 것이다(네트워크 마운트는 이 PC에 만들 수 없어 pathGuardLinux.test가 넣은 mountinfo로 본다).
 * 링크로 가리켜도 같다. 거부는 invalid이고 그 까닭(가상 파일 시스템)을 말하며, 폴더·저장소를 만들지 않는다
 */
describe.runIf(process.platform === 'linux')('프로젝트 등록 경로 검사 — Linux의 가상 파일 시스템 (S10-6.6)', () => {
  it('/proc·/sys 아래와 /proc을 가리키는 링크는 등록하지 않는다 — invalid, 그 까닭, 저장소·긴급 알림 없음', async () => {
    const app = await boot();
    const base = tempDir('linuxpaths');
    dirs.push(base);
    const link = join(base, 'proc-link');
    symlinkSync('/proc/self', link);
    links.push(link);
    const cases: [string, string, 'new' | 'existing'][] = [
      ['/proc', '/proc/self', 'existing'],
      ['/sys', '/sys/kernel', 'existing'],
      ['/proc 링크', link, 'existing'],
      ['/proc 링크 아래 새 폴더', join(link, 'new-proj'), 'new'],
    ];
    const got: Record<string, unknown> = {};
    for (const [label, path, mode] of cases) {
      const r = await app.core.projects.create({ name: label, path, mode }, OPERATOR).then(
        () => ({ ok: true, code: undefined, message: '' }),
        (e: { code?: string; message: string }) => ({ ok: false, code: e.code, message: e.message }),
      );
      // Linux 예시로 말한다 (team.ts가 pathGuard.projectPathRefusal을 쓴다 — 리드 결정 S10-10)
      got[label] = { result: outcome(r), why: /가상 파일 시스템\((\/proc|\/sys)\)의 경로는 쓸 수 없습니다/.test(r.message) && r.message.startsWith('프로젝트 폴더는 이 PC의 로컬 폴더(예: /home/<사용자>/work/my-app)만 등록할 수 있습니다.') };
    }
    expect({ got, projects: app.ctx.store.projects.list().length, urgent: urgentTitles(app), newMade: existsSync('/proc/self/new-proj') }).toEqual({
      got: Object.fromEntries(cases.map(([label]) => [label, { result: 'refused invalid', why: true }])),
      projects: 0,
      urgent: [],
      newMade: false,
    });
  });
});
