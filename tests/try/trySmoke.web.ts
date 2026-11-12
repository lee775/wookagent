/**
 * 대표의 체험 도구를 실제로 돌려 본다 (리드 결정 S9-11 trySmoke — 웹 시험 설정 `npm run test:web`, headless Edge 하나씩): `scripts/try-server.mjs`의
 * local과 mock을 `--headless --smoke`로 띄워
 * - 로그인한 홈(프로젝트 현황)까지 열리고 — local은 운영자 시험 세션 쿠키로, mock은 가짜 구글 로그인으로 (리드 결정 S9-9 '(verify)': 세션 쿠키가 있으면
 *   대표 이메일과 상관없이 홈이 열린다. server.json에 체험용 대표의 이메일을 적어 두면 서버가 설정 코드를 아예 내지 않고, 등록되는 시험용 대표가 대표
 *   이메일과 같다 — 이 시험은 그 둘을 본다)
 * - 시작된 턴이 없고 (local은 데이터 폴더의 DB를 끝난 뒤 읽어 본다)
 * - 끝나면 아무것도 남지 않는다: 도구의 자손 프로세스(서버·Edge·vitest)가 없고, 서버는 실행 잠금과 중계 파일을 지우고 끝났다
 * - 세션 토큰은 도구의 출력에 없다
 * 실제 사용자 폴더·실제 데이터 폴더·저장소의 out/server·out/web을 쓰지 않는다: 체험 뿌리는 임시 폴더(WOOK_TRY_ROOT), 서버는 이 파일이 따로 묶은 빌드
 * (out/test-server-try-…, 끝에 지운다), 웹 화면은 globalSetup이 임시 폴더에 만든 빌드를 넘긴다. local의 데이터 폴더는 모의 메인 에이전트를 켠 하네스로
 * 먼저 만든다 — 도구가 띄우는 서버가 이 PC의 실제 Claude CLI를 띄우지 않게 (리드 결정 S6-19·S9-13)
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { MAIN_AGENT_ID, type Settings, type Turn } from '@shared/domain';
import { createHarness } from '../e2e/harness';
import { buildServerTo, clientJson, descendantsOf, removeDir, REPO, runClient, startBuilt, testBuildDir, type BuiltServer } from '../server/helpers';
import { poll } from '../web/rig';
import { hasTryMarker, MOCK_TEMP_PREFIX } from '../../scripts/try-server.mjs';

const e2e = inject('webE2e');
const KIT = join(REPO, 'scripts', 'try-server.mjs');
const TOKEN_SHAPE = /wos_[A-Za-z0-9_-]{20,}/;

interface KitRun {
  code: number | null;
  stdout: string;
  stderr: string;
  pid: number;
}

/** 도구를 띄우고 끝날 때까지 기다린다. 상한(8분)을 넘기면 이 시험이 띄운 그 프로세스만 손잡이로 끝내고 실패한다 */
function runKitProcess(args: string[], env: NodeJS.ProcessEnv): Promise<KitRun> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [KIT, ...args], { cwd: REPO, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout!.setEncoding('utf8').on('data', (c: string) => (stdout += c));
    child.stderr!.setEncoding('utf8').on('data', (c: string) => (stderr += c));
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      reject(new Error(`체험 도구가 8분 안에 끝나지 않았습니다\n${stdout}\n${stderr}`));
    }, 8 * 60_000);
    child.once('close', (code) => {
      clearTimeout(timer);
      resolveRun({ code, stdout, stderr, pid: child.pid! });
    });
  });
}

if (e2e.skipReason) {
  describe('체험 도구 점검 (trySmoke)', () => {
    it.skip(`건너뜀 — ${e2e.skipReason}`, () => undefined);
  });
} else {
  let outDir = '';
  let entry = '';
  const dirs: string[] = [];

  beforeAll(() => {
    outDir = testBuildDir('try');
    entry = buildServerTo(outDir);
  }, 300_000);

  afterAll(async () => {
    for (const d of dirs) await removeDir(d);
    if (outDir) await removeDir(outDir);
  });

  describe('체험 도구 점검 (trySmoke)', () => {
    it('trySmoke local — 실제 서버·https 중계·Edge로 시험 세션 쿠키의 로그인한 홈까지 열리고, 턴이 시작되지 않으며, 끝나면 아무것도 남지 않는다', async () => {
      const root = mkdtempSync(join(tmpdir(), 'wook-test-try-root-'));
      dirs.push(root);
      const dataDir = join(root, 'server');
      // 모의 메인 에이전트를 켠 데이터 폴더를 먼저 만든다 (실제 CLI가 뜨지 않게 — 시작 전에)
      const h = await createHarness({ noProject: true, mode: 'server', dataDir });
      dirs.push(resolve(h.projectDir, '..'));
      await h.close({ keepDirs: true });

      const r = await runKitProcess(['local', '--headless', '--smoke'], { WOOK_TRY_ROOT: root, WOOK_TRY_SERVER_ENTRY: entry, WOOK_TRY_WEB_DIR: e2e.webDir! });
      expect(r.code, `${r.stdout}\n${r.stderr}`).toBe(0);
      expect(r.stdout).toContain('점검 통과: 로그인한 홈(프로젝트 현황)이 열렸고, 진행 중인 작업이 없습니다');
      expect(r.stdout).toContain('모두 껐습니다');
      expect(`${r.stdout}${r.stderr}`).not.toMatch(TOKEN_SHAPE);

      // 남은 것이 없다 — 도구가 띄운 서버·Edge·운영자 명령의 자손 프로세스, 실행 잠금, 중계 파일
      const left = await poll(() => descendantsOf(r.pid), (x) => x.length === 0, 30_000);
      expect(left).toEqual([]);
      expect(existsSync(join(dataDir, 'server.lock'))).toBe(false);
      expect(existsSync(join(dataDir, 'try-front.json'))).toBe(false);
      expect(clientJson(entry, ['status', '--data-dir', dataDir]).reply.error?.code).toBe('not_running');

      // 시작된 턴이 없고, 모의 메인 에이전트가 끝까지 켜져 있었다
      const db = new DatabaseSync(join(dataDir, 'wook.db'), { readOnly: true });
      try {
        const turns = (db.prepare('SELECT data FROM turns').all() as { data: string }[]).map((x) => JSON.parse(x.data) as Turn);
        expect(turns.filter((t) => t.memberId === MAIN_AGENT_ID && !t.mock).map((t) => t.id)).toEqual([]);
        expect(turns.map((t) => t.id)).toEqual([]);
        const settings = JSON.parse((db.prepare("SELECT value FROM kv WHERE key = 'settings'").get() as { value: string }).value) as Settings;
        expect(settings.developer.mainAgentMock).toBe(true);
      } finally {
        db.close();
      }

      // 설정 코드 없이 시작했다 — server.json의 대표 이메일이 체험용 대표(운영자 시험 세션의 대표)라서 서버가 설정 코드를 내지 않았다 (S9-9 '(verify)')
      const serverLog = readFileSync(join(dataDir, 'logs', 'server.log'), 'utf8');
      expect(serverLog).toContain('준비 완료');
      expect(serverLog).not.toContain('설정 코드를 냈습니다');

      // 도구가 쓴 server.json — 화면 조작 끔, 체험 작업 폴더(체험 뿌리 아래)
      const cfg = JSON.parse(readFileSync(join(dataDir, 'server.json'), 'utf8')) as { screen: { enabled: boolean }; workspaceRoot: string; owner: { email: string } };
      expect(cfg.screen.enabled).toBe(false);
      expect(cfg.workspaceRoot).toBe(join(root, 'workspace'));
      expect(cfg.owner.email).toBe('operator-test@wook.local');
      // 작업 폴더는 도구가 만들었다 (표시 파일과 함께 — 서버는 그 안의 main을 만든다, 리드 결정 S9-22 DS-5·DF-5)
      expect(hasTryMarker(join(root, 'workspace'))).toBe(true);
      expect(existsSync(join(root, 'workspace', 'main'))).toBe(true);
    }, 10 * 60_000);

    it('trySmoke mock — 모의 무대(vitest)의 가짜 구글 로그인으로 홈까지 열리고 턴이 없으며, 끝나면 아무것도 남지 않는다', async () => {
      const root = mkdtempSync(join(tmpdir(), 'wook-test-try-root-'));
      dirs.push(root);
      const mockDirs = (): string[] => readdirSync(tmpdir()).filter((n) => n.startsWith(MOCK_TEMP_PREFIX));
      const before = mockDirs();
      const r = await runKitProcess(['mock', '--headless', '--smoke'], { WOOK_TRY_ROOT: root, WOOK_TRY_WEB_DIR: e2e.webDir! });
      expect(r.code, `${r.stdout}\n${r.stderr}`).toBe(0);
      // 모의 무대의 임시 폴더(도구가 이 실행의 임시 폴더 아래에 만든 wook-try-mock-…)는 지웠다 (리드 결정 S9-22 DF-3)
      expect(mockDirs().filter((n) => !before.includes(n))).toEqual([]);
      // 체험 시험이 실제로 돌았다 (WOOK_TRY가 빠지면 건너뛰고도 0으로 끝난다)
      expect(r.stdout).toMatch(/Tests\s+1 passed \(1\)/);
      expect(r.stdout).toContain('[모의 체험] 모의 무대: 로그인한 홈(프로젝트 현황)이 열렸고 실시간 연결이 열렸습니다. 시작된 턴은 없습니다');
      expect(r.stdout).toContain('점검 통과: 모의 무대의 로그인한 홈이 열렸습니다');
      const left = await poll(() => descendantsOf(r.pid), (x) => x.length === 0, 30_000);
      expect(left).toEqual([]);
    }, 10 * 60_000);

    it('trySmoke stop — 체험 데이터 폴더의 서버만 관리 채널 shutdown으로 끈다. 체험 뿌리 밖의 서버(같은 빌드)는 그대로 돈다', async () => {
      const root = mkdtempSync(join(tmpdir(), 'wook-test-try-root-'));
      dirs.push(root);
      const servers: BuiltServer[] = [];
      try {
        // 모의 메인 에이전트를 켠 두 데이터 폴더 — 하나는 체험 자리(root\server), 하나는 체험 뿌리 밖
        const tryDir = join(root, 'server');
        const otherDir = mkdtempSync(join(tmpdir(), 'wook-test-try-other-'));
        dirs.push(otherDir, `${otherDir}-ws`);
        for (const dataDir of [tryDir, otherDir]) {
          const h = await createHarness({ noProject: true, mode: 'server', dataDir });
          dirs.push(resolve(h.projectDir, '..'));
          await h.close({ keepDirs: true });
          servers.push(await startBuilt({ entry, dataDir }));
        }
        const [inTry, outside] = servers as [BuiltServer, BuiltServer];
        const r = await runKitProcess(['stop'], { WOOK_TRY_ROOT: root, WOOK_TRY_SERVER_ENTRY: entry });
        expect(r.code, `${r.stdout}\n${r.stderr}`).toBe(0);
        expect(r.stdout).toContain(`local 체험 서버: 끕니다 (pid ${inTry.child.pid}`);
        expect(r.stdout).toContain('local 체험 서버: 껐습니다');
        expect(r.stdout).toContain('phone 체험 서버: 돌고 있지 않습니다');
        // 끈 것은 체험 자리의 서버 하나 — 그 서버는 스스로 정상 종료(0)했고, 밖의 서버는 그대로 돈다
        expect(await Promise.race([inTry.exited, new Promise((r2) => setTimeout(() => r2('still running'), 30_000))])).toEqual({ code: 0, signal: null });
        expect(outside.child.exitCode).toBeNull();
        expect(clientJson(entry, ['status', '--data-dir', otherDir]).reply.ok).toBe(true);
      } finally {
        for (const s of servers) {
          if (s.child.exitCode !== null) continue;
          runClient(entry, ['shutdown', '--data-dir', s.dataDir]);
          await Promise.race([s.exited, new Promise((r2) => setTimeout(r2, 40_000))]);
          // 이 시험이 띄운 그 프로세스만, 아직 살아 있을 때 손잡이로
          if (s.child.exitCode === null) s.child.kill();
        }
      }
    }, 10 * 60_000);
  });
}
