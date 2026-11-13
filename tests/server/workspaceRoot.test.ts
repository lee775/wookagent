/**
 * 서버의 메인 에이전트 작업 폴더 위치 (SERVER_DESIGN 3.7, 리드 결정 S5-20):
 * - `--workspace-root` > server.json `workspaceRoot` > `~/wook-workspace`, 그 아래 main. 시작할 때만 정한다
 * - 절대 경로가 아니거나 그 아래 main이 데이터 폴더와 겹치면 잠금·저장소를 만들기 전에 1로 끝난다 (글은 값이 온 곳을 말한다)
 * - config show는 쓰는 폴더와 정한 곳을 말하고 '아직 쓰지 않음'에 넣지 않는다. config reload는 바꾸지 않고 다시 시작해야 바뀐다고(인자가 먼저면 그렇다고) 경고한다
 */
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { chooseWorkspaceRoot, workspaceExample, workspaceProblem } from '../../src/main/orchestrator/mainWork';
import { adminRequest } from '../../src/server/admin';
import { formatConfig, parseCli } from '../../src/server/cli';
import type { ServerConfigView } from '../../src/server/config';
import { runServe } from '../../src/server/serve';
import { removeDir } from './helpers';

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await removeDir(d);
});
const temp = (tag: string): string => {
  const d = mkdtempSync(join(tmpdir(), `wook-test-ws-${tag}-`));
  dirs.push(d);
  return d;
};

const EVENTS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK', 'uncaughtException', 'unhandledRejection'];

/** 프로세스 안에서 서버를 띄운다 — 준비되면 during을 부른 뒤 관리 채널 shutdown으로 끝낸다. runServe가 붙인 프로세스 처리기는 뗀다 */
async function serve(dataDir: string, o: { workspaceRoot?: string; file?: unknown } = {}, during?: () => Promise<void>): Promise<{ code: number | null; stderr: string }> {
  if (o.file !== undefined) writeFileSync(join(dataDir, 'server.json'), JSON.stringify(o.file));
  const before = new Map(EVENTS.map((e) => [e, process.listeners(e as NodeJS.Signals)]));
  const err: string[] = [];
  let exited!: (code: number) => void;
  const exit = new Promise<number>((r) => (exited = r));
  try {
    const code = await runServe(
      { dataDir, bind: '127.0.0.1', port: 0, webDir: null, allowTestSession: false, ...(o.workspaceRoot !== undefined ? { workspaceRoot: o.workspaceRoot } : {}) },
      { out: async () => undefined, err: async (t) => void err.push(t), exit: (c) => exited(c) },
    );
    if (code !== null) return { code, stderr: err.join('') };
    try {
      await during?.();
    } finally {
      expect((await adminRequest({ dataDir, command: 'shutdown' })).ok).toBe(true);
    }
    return { code: await exit, stderr: err.join('') };
  } finally {
    for (const e of EVENTS) for (const l of process.listeners(e as NodeJS.Signals)) if (!before.get(e)!.includes(l)) process.off(e, l);
  }
}

async function show(dataDir: string): Promise<ServerConfigView> {
  const r = await adminRequest({ dataDir, command: 'config.show' });
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r.result as ServerConfigView;
}

describe('작업 폴더 위치 고르기 (S5-20)', () => {
  it('--workspace-root > server.json workspaceRoot > ~/wook-workspace', () => {
    expect(chooseWorkspaceRoot(' D:\\ws-flag ', 'D:\\ws-file')).toEqual({ root: 'D:\\ws-flag', source: 'flag' });
    expect(chooseWorkspaceRoot(null, 'D:\\ws-file')).toEqual({ root: 'D:\\ws-file', source: 'config' });
    expect(chooseWorkspaceRoot('', '  ')).toEqual({ root: join(homedir(), 'wook-workspace'), source: 'default' });
  });

  it('절대 경로가 아니거나 그 아래 main이 데이터 폴더와 겹치면 그 까닭 — 값이 온 곳을 말한다', () => {
    const data = temp('pure');
    // 예시는 OS마다 — Windows는 D:\wook-workspace 그대로, Linux는 /srv/wook-workspace (리드 결정 S10-6.6)
    expect(workspaceProblem({ root: 'ws', source: 'flag' }, data)).toBe(`메인 에이전트 작업 폴더 위치(--workspace-root)가 절대 경로가 아닙니다: ws — 예: ${workspaceExample()}`);
    expect(workspaceProblem({ root: data, source: 'config' }, data)).toBe(
      `메인 에이전트 작업 폴더(${join(data, 'main')})가 데이터 폴더(${data})와 그 안입니다 — 데이터 폴더 밖의 다른 위치를 메인 에이전트 작업 폴더 위치(server.json의 workspaceRoot)로 정하세요`,
    );
    expect(workspaceProblem({ root: join(data, '..', 'beside'), source: 'flag' }, data)).toBeNull();
  });

  it('--workspace-root는 serve의 인자다', () => {
    expect(parseCli(['serve', '--workspace-root', 'D:\\ws', '--data-dir', 'd'], {})).toMatchObject({ kind: 'serve', options: { workspaceRoot: 'D:\\ws' } });
    // install-task도 받아 작업에 옮긴다 (리드 결정 S9-3)
    expect(parseCli(['status', '--workspace-root', 'D:\\ws'], {})).toEqual({ kind: 'error', message: '--workspace-root는 서버를 띄울 때(serve·install-task)만 씁니다' });
  });
});

describe('서버 시작 (S5-20)', () => {
  it('상대 경로 --workspace-root, 데이터 폴더 안을 가리키는 server.json은 1로 끝나고 잠금·저장소를 만들지 않는다', async () => {
    const a = temp('rel');
    const r1 = await serve(a, { workspaceRoot: 'ws' });
    expect({ code: r1.code, lock: existsSync(join(a, 'server.lock')), db: existsSync(join(a, 'wook.db')) }).toEqual({ code: 1, lock: false, db: false });
    expect(r1.stderr.split('\n')[0]).toBe(`욱채 서버를 시작하지 못했습니다: 메인 에이전트 작업 폴더 위치(--workspace-root)가 절대 경로가 아닙니다: ws — 예: ${workspaceExample()}`);
    const b = temp('inside');
    const r2 = await serve(b, { file: { workspaceRoot: b } });
    expect({ code: r2.code, lock: existsSync(join(b, 'server.lock')), db: existsSync(join(b, 'wook.db')) }).toEqual({ code: 1, lock: false, db: false });
    expect(r2.stderr.split('\n')[0]).toContain('메인 에이전트 작업 폴더 위치(server.json의 workspaceRoot)로 정하세요');
  }, 60_000);

  it('인자가 server.json보다 먼저다 — 그 아래 main을 git 저장소로 만들고, config show가 그 폴더와 정한 곳을, reload가 파일 값은 쓰지 않는다고 말한다', async () => {
    const data = temp('flag');
    const flagRoot = join(temp('flag-root'), 'ws');
    const fileRoot = join(temp('file-root'), 'ws');
    let view: ServerConfigView | null = null;
    let reloadWarnings: string[] = [];
    const r = await serve(data, { workspaceRoot: flagRoot, file: { workspaceRoot: fileRoot } }, async () => {
      view = await show(data);
      const reload = await adminRequest({ dataDir: data, command: 'config.reload' });
      reloadWarnings = reload.ok ? (reload.result as { warnings: string[] }).warnings : [];
    });
    expect(r.code).toBe(0);
    expect(existsSync(join(flagRoot, 'main', '.git'))).toBe(true);
    expect(existsSync(join(fileRoot, 'main'))).toBe(false);
    expect(existsSync(join(data, 'main-agent'))).toBe(false);
    expect(view!.workspace).toEqual({ root: flagRoot, mainDir: join(flagRoot, 'main'), source: 'flag' });
    expect(view!.pending).toEqual({ network: { bind: null, port: null } });
    expect(formatConfig(view!)).toContain(`  메인 작업 폴더  ${join(flagRoot, 'main')} (--workspace-root에서 — 서버를 시작할 때만 정합니다)\n`);
    expect(formatConfig(view!)).not.toContain('아직 쓰지 않음');
    expect(reloadWarnings).toContain('server.json의 workspaceRoot는 쓰지 않습니다 — 서버를 --workspace-root로 시작해 그 인자의 위치가 먼저입니다');
  }, 120_000);

  it('server.json의 위치를 쓰고, 파일을 바꿔 reload하면 바꾸지 않고 다시 시작해야 바뀐다고 경고한다', async () => {
    const data = temp('file');
    const fileRoot = join(temp('file-root2'), 'ws');
    const nextRoot = join(temp('next-root'), 'ws');
    let before: ServerConfigView | null = null;
    let after: ServerConfigView | null = null;
    let warnings: string[] = [];
    const r = await serve(data, { file: { workspaceRoot: fileRoot } }, async () => {
      before = await show(data);
      writeFileSync(join(data, 'server.json'), JSON.stringify({ workspaceRoot: nextRoot }));
      const reload = await adminRequest({ dataDir: data, command: 'config.reload' });
      warnings = reload.ok ? (reload.result as { warnings: string[] }).warnings : [];
      after = await show(data);
    });
    expect(r.code).toBe(0);
    expect(before!.workspace).toEqual({ root: fileRoot, mainDir: join(fileRoot, 'main'), source: 'config' });
    expect(warnings).toEqual([`server.json의 workspaceRoot(작업 폴더 위치)는 서버를 다시 시작해야 바뀝니다 — 지금은 ${join(fileRoot, 'main')}에서 일하고, 다시 시작하면 ${join(nextRoot, 'main')}로 옮깁니다`]);
    expect(after!.workspace).toEqual(before!.workspace);
    expect(existsSync(join(fileRoot, 'main', '.git'))).toBe(true);
    expect(existsSync(join(nextRoot, 'main'))).toBe(false);
  }, 120_000);
});
