/**
 * 대표의 체험 도구 scripts/try-server.mjs (리드 결정 S9-9·S9-11 tryKit, S9-22). 프로세스·브라우저·중계·Tailscale은 가짜를 넣고(runKit의 deps) 도구가 무엇을
 * 부르고 무엇을 쓰는지 본다 — 실제 서버·Edge는 trySmoke(웹 시험 설정)가, 콘솔의 Ctrl+C는 consoleSignals가 본다.
 * - 자리: 모두 체험 뿌리(기본 %LOCALAPPDATA%\wookagent-try) 아래이고, 실제 데이터 폴더(기본 자리·WOOK_DATA_DIR)와 겹치면(Windows는 대소문자를 가리지 않고)
 *   아무것도 하지 않는다. 데스크톱은 real-data일 때만 실제 데이터 폴더를 쓴다(묻고 나서)
 * - 체험 폴더: 서버의 새 데이터 폴더처럼 상속을 끊고 이 사용자만 쓰게 만들고(ACL을 읽어 본다), 표시 파일을 넣는다. --fresh는 표시가 있는 폴더만 지운다
 * - server.json: 서버가 받는 꼴(parseServerConfig 경고 없음) — 체험용 대표는 서버의 시험용 대표와 같은 이메일, 화면 조작 끔
 * - local·mock은 secret·tailscale·claude를 부르지 않는다. 세션 토큰은 Edge 쿠키로만 가고 출력·명령 줄에 없다. phone은 tailscale을 읽기만 하고 serve 명령은
 *   보여 주기만 한다. stop은 관리 채널 shutdown만 쓰고 PID로 끄지 않는다
 * - Ctrl+C: 빌드·서버 시작 전부터 받는다(준비 중이면 띄운 서버를 손잡이로 끝낸다). mock을 Ctrl+C로 끝내면 정상 끝(130)이고 모의 무대의 임시 폴더를 지운다
 * - 이미 도는 체험 서버: 중계가 nonce로 증명할 때만 쿠키를 보낸다
 * - 빌드가 낡았으면(결과 없음·소스가 더 새로움·서버용 웹 빌드 아님) 다시 만들고, 만들기 전에 그렇다고 말한다. 빌드 셋의 소스는 그 빌드가 부르는 파일을 모두 덮는다
 * 이 파일이 만든 임시 폴더는 시험이 실패해도 afterEach가 모두 지운다 (리드 결정 S9-22 TI-1)
 */
import { EventEmitter } from 'node:events';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildSpecs,
  CLAUDE_LOGIN_LINE,
  desktopEnv,
  FRESH_TRASH_RE,
  freshProblem,
  freshRemove,
  frontMac,
  hasTryMarker,
  localServerConfig,
  mockEnv,
  MOCK_TEMP_PREFIX,
  pathsProblem,
  phoneServerConfig,
  prepareTryDir,
  readServeStatus,
  readTailscaleStatus,
  REPO,
  RESTORE_NOTE,
  restoreTarget,
  runKit,
  staleReason,
  tryPaths,
  TRY_MARKER,
  TRY_OWNER_EMAIL,
  FRONT_FILE,
  type BuildSpec,
  type KitDeps,
  type RunOptions,
  type TryPaths,
} from '../../scripts/try-server.mjs';
import { parseServerConfig } from '../../src/server/config';
import { normalizeOwnerEmail } from '../../src/main/orchestrator/serverLogin';
import { seatConfigProblem } from '../../src/main/orchestrator/seat';
import { TEST_OWNER } from '../../src/main/orchestrator/auth';
import { workspaceProblem } from '../../src/main/orchestrator/mainWork';

const FAKE_TOKEN = `wos_${'A1b2C3d4'.repeat(6)}`;
const WIN = process.platform === 'win32';

/** 이 파일이 만든 임시 폴더 — 시험이 실패해도 afterEach가 지운다 */
const made: string[] = [];
const tempBase = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  made.push(d);
  return d;
};

afterEach(async () => {
  vi.restoreAllMocks();
  for (const d of made.splice(0)) await rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => undefined);
});

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  pid = 4321;
  kills = 0;
  /** 도구의 창(콘솔)을 같이 쓰는 자식(빌드·vitest — inherit) — 그 창의 Ctrl+C를 같이 받아 끝난다 */
  sharesConsole = false;
  /** 창의 Ctrl+C를 받고도 끝나지 않는다 (붙잡힌 vitest) */
  ignoresCtrlC = false;
  exit(code = 0): void {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    this.stdout.end();
    this.stderr.end();
    this.emit('exit', code, null);
    this.emit('close', code, null);
  }
  kill(): boolean {
    this.kills++;
    this.exit(1);
    return true;
  }
}

interface Call {
  file: string;
  args: string[];
  o?: RunOptions;
}

interface FakeOptions {
  /** 체험 서버가 이미 도는지 (local·phone 데이터 폴더별) */
  running?: { server?: boolean; phone?: boolean };
  publicOrigin?: string | null;
  /** 이 포트에 중계를 띄우려 하면 EADDRINUSE */
  busyPort?: number;
  probeMac?: (challenge: string) => string | null;
  tailscale?: unknown;
  serve?: unknown;
  answer?: string;
  /** 도구가 이 글을 내면 그다음 차례에 Ctrl+C — 시험이 '언제'를 도구의 글로 정한다 (빠르기와 상관없다) */
  interruptWhenOut?: RegExp;
  /** 빌드 중에 Ctrl+C — 같은 창의 빌드도 그 신호로 끝난다(끝 코드 1) */
  interruptDuringBuild?: boolean;
  /** 서버가 준비 줄을 내지 않는다 (준비 중에 Ctrl+C를 받는 경우) */
  serverNeverReady?: boolean;
  /** 모의 무대(vitest)가 스스로 끝나지 않는다 (사람이 창을 닫거나 Ctrl+C할 때까지) */
  vitestStays?: boolean;
  /** 모의 무대(vitest)가 창의 Ctrl+C를 받고도 끝나지 않는다 — 도구가 손잡이로 끝내야 한다 */
  vitestIgnoresCtrlC?: boolean;
  /** 운영자 status를 묻는 동안 Ctrl+C (답은 그대로 돌아온다) */
  interruptOnStatus?: boolean;
  /** 가짜 빌드가 결과 파일을 쓴다 */
  onBuild?: (args: readonly string[]) => void;
  /** Edge 창의 점검이 실패한다 (로그인 화면이 보임) */
  checkFails?: boolean;
  /** Edge 창을 열 때 (중계 파일이 있는 때) */
  onBrowser?: () => void;
  /** 도구가 서버 준비를 기다리는 시간 — 답이 오지 않기를 바라는 창이면 짧게 */
  readyTimeoutMs?: number;
  /** 도구가 자식의 끝을 기다리는 시간 — 답이 오기를 바라는 창이면 넉넉하게 (리드 결정 S9-18) */
  exitWaitMs?: number;
}

interface Fake {
  deps: KitDeps;
  runs: Call[];
  starts: Call[];
  children: FakeChild[];
  events: string[];
  browsers: { origin: string; token: string; headless: boolean; path: string }[];
  fronts: { port: number; upstream: number; closed: boolean }[];
  /** 가짜 vitest가 임시 폴더(TEMP)에 만든 실행 폴더 */
  vitestRunDirs: string[];
  /** 처리기가 걸리지 않은 때 온 Ctrl+C 수 — 실제로는 그 순간 도구가 바로 끝난다 */
  unhandled(): number;
  out(): string;
  err(): string;
}

/** 체험 뿌리·서버 진입 파일·웹 화면 폴더를 임시 폴더에 두고 가짜 의존을 만든다 */
function setup(
  o: FakeOptions = {},
  extraEnv: NodeJS.ProcessEnv = {},
): { fake: Fake; root: string; paths: TryPaths; webDir: string; entry: string; repo: string; env: NodeJS.ProcessEnv } {
  const base = tempBase('wook-test-trykit-');
  const root = join(base, 'try-root');
  const repo = join(base, 'repo');
  mkdirSync(repo, { recursive: true });
  const entry = join(base, 'built', 'index.mjs');
  mkdirSync(join(base, 'built'), { recursive: true });
  writeFileSync(entry, '// 가짜 빌드\n');
  const webDir = join(base, 'web');
  mkdirSync(webDir, { recursive: true });
  writeFileSync(join(webDir, 'index.html'), '<meta name="wook-build" content="remote">\n');
  const env: NodeJS.ProcessEnv = {
    APPDATA: join(base, 'Roaming'),
    LOCALAPPDATA: join(base, 'Local'),
    WOOK_TRY_ROOT: root,
    WOOK_TRY_SERVER_ENTRY: entry,
    WOOK_TRY_WEB_DIR: webDir,
    ...extraEnv,
  };
  for (const [k, v] of Object.entries(extraEnv)) if (v === undefined) delete env[k];
  const paths = tryPaths(env);
  const fake = makeFake(o, env, repo, paths);
  return { fake, root, paths, webDir, entry, repo, env };
}

function makeFake(o: FakeOptions, env: NodeJS.ProcessEnv, repo: string, paths: TryPaths): Fake {
  const runs: Call[] = [];
  const starts: Call[] = [];
  const children: FakeChild[] = [];
  const events: string[] = [];
  const browsers: Fake['browsers'] = [];
  const fronts: Fake['fronts'] = [];
  const vitestRunDirs: string[] = [];
  let outText = '';
  let errText = '';
  let unhandled = 0;
  const running = { server: !!o.running?.server, phone: !!o.running?.phone };
  const which = (dir: string): 'server' | 'phone' => (resolve(dir) === resolve(paths.phone) ? 'phone' : 'server');
  const serverChildren = new Map<'server' | 'phone', FakeChild>();
  const reply = (v: unknown) => ({ code: 0, stdout: `${JSON.stringify(v)}\n`, stderr: '' });
  const handlers = new Set<{ handler: () => void; fire: () => void }>();
  /** 창의 Ctrl+C: 걸린 처리기를 부르고, 같은 창을 쓰는 자식은 그 신호로 끝난다 */
  const sigint = (): void => {
    events.push('sigint');
    if (handlers.size === 0) unhandled++;
    for (const h of [...handlers]) {
      h.handler();
      h.fire();
    }
    for (const c of children) if (c.sharesConsole && !c.ignoresCtrlC) setTimeout(() => c.exit(130), 1);
  };
  const deps: KitDeps = {
    env,
    platform: process.platform,
    repo,
    out: (t) => {
      outText += t;
      events.push(`out:${t}`);
      if (o.interruptWhenOut?.test(t)) setTimeout(sigint, 0);
    },
    err: (t) => {
      errText += t;
      events.push(`err:${t}`);
    },
    async run(file, args, opt) {
      runs.push({ file, args: [...args], o: opt });
      events.push(`run:${file} ${args.join(' ')}`);
      if (file === 'tailscale') {
        if (args[0] === 'status') return { code: 0, stdout: JSON.stringify(o.tailscale ?? {}), stderr: '' };
        return { code: 0, stdout: JSON.stringify(o.serve ?? {}), stderr: '' };
      }
      if (args[0]?.endsWith('vite.js') || args[0]?.endsWith('electron-vite.js')) {
        if (o.interruptDuringBuild) {
          // 빌드는 같은 창에서 돌아 그 Ctrl+C로 끝난다
          sigint();
          return { code: 1, stdout: '', stderr: '' };
        }
        o.onBuild?.(args);
        return { code: 0, stdout: '', stderr: '' };
      }
      // 운영자 명령: [entry, ...낱말, --json, --data-dir, 폴더]
      const dir = args[args.length - 1]!;
      const words = args.slice(1, args.indexOf('--json'));
      const who = which(dir);
      if (words[0] === 'status') {
        if (o.interruptOnStatus) sigint();
        return running[who]
          ? reply({ ok: true, result: { pid: who === 'server' ? 4321 : 4322, url: 'http://127.0.0.1:5555', runId: 'run-1', activeWork: false } })
          : { code: 1, stdout: `${JSON.stringify({ ok: false, error: { code: 'not_running', message: '실행 중인 욱채 서버가 없습니다' } })}\n`, stderr: '' };
      }
      if (words[0] === 'session') return reply({ ok: true, result: { token: FAKE_TOKEN, ownerCreated: false } });
      if (words[0] === 'config') return reply({ ok: true, result: { access: { publicOrigin: o.publicOrigin ?? null }, google: { secretSet: false } } });
      if (words[0] === 'shutdown') {
        running[who] = false;
        serverChildren.get(who)?.exit(0);
        return reply({ ok: true, result: { shuttingDown: true, stopped: true } });
      }
      return { code: 2, stdout: '', stderr: '모르는 명령' };
    },
    start(file, args, opt) {
      starts.push({ file, args: [...args], o: opt });
      events.push(`start:${args.join(' ')}`);
      const child = new FakeChild();
      child.sharesConsole = opt?.inherit === true;
      child.ignoresCtrlC = args[1] !== 'serve' && o.vitestIgnoresCtrlC === true;
      children.push(child);
      if (args[1] === 'serve') {
        const dir = args[args.indexOf('--data-dir') + 1]!;
        const who = which(dir);
        serverChildren.set(who, child);
        running[who] = true;
        if (!o.serverNeverReady) {
          setTimeout(() => child.stdout.write(`욱채 서버 준비 완료: 주소 http://127.0.0.1:5555 (127.0.0.1과 ::1에서 받음) · 실행 ID run-1 · 데이터 폴더 ${dir}\n`), 5);
        }
      } else {
        // 가짜 vitest: 받은 임시 폴더에 실행 폴더를 만든다 (실제 vitest의 runTemp처럼)
        const temp = opt?.env?.['TEMP'];
        if (temp) {
          const run = join(temp, 'wook-vitest-1-AbCdEf');
          mkdirSync(join(run, 'wook-test-web-proj-x'), { recursive: true });
          writeFileSync(join(run, 'wook-test-web-proj-x', 'data.txt'), 'x');
          vitestRunDirs.push(run);
        }
        if (!o.vitestStays) setTimeout(() => child.exit(0), 5);
      }
      return child as unknown as ChildProcess;
    },
    front: {
      async start(port) {
        if (o.busyPort !== undefined && port === o.busyPort) throw Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' });
        const f = { port: port || 4433, upstream: 0, closed: false };
        fronts.push(f);
        events.push(`front:${f.port}`);
        return {
          port: f.port,
          nonce: 'front-nonce',
          setUpstream: (p: number) => {
            f.upstream = p;
          },
          close: async () => {
            f.closed = true;
          },
        };
      },
      async probe(_port, challenge) {
        return o.probeMac ? o.probeMac(challenge) : null;
      },
    },
    async openBrowser(b) {
      browsers.push(b);
      events.push(`browser:${b.origin}`);
      o.onBrowser?.();
      return {
        closed: Promise.resolve(),
        check: async () => (o.checkFails ? { ok: false as const, detail: '로그인 화면이 보입니다' } : { ok: true as const }),
        close: async () => undefined,
      };
    },
    edgeInstalled: () => true,
    onInterrupt: (handler) => {
      let fire!: () => void;
      const fired = new Promise<void>((r) => (fire = r));
      const h = { handler, fire };
      handlers.add(h);
      return { fired, dispose: () => void handlers.delete(h) };
    },
    ask: async () => o.answer ?? '',
    readyTimeoutMs: o.readyTimeoutMs ?? 10_000,
    exitWaitMs: o.exitWaitMs ?? 50,
  };
  return { deps, runs, starts, children, events, browsers, fronts, vitestRunDirs, unhandled: () => unhandled, out: () => outText, err: () => errText };
}

/** 모든 부름(파일·인자) 글 — 토큰을 찾는다 */
const allCalls = (f: Fake): string[] => [...f.runs, ...f.starts].map((c) => `${c.file} ${c.args.join(' ')}`);
/**
 * 그 프로그램(파일 이름 — tailscale, claude)을 부르거나 그 낱말(운영자 명령의 secret)을 인자로 준 부름. 낱말 단위로 본다 — 임시 폴더 경로에 같은 글자가
 * 들어 있어도(예: …\Temp\claude\…) 세지 않는다
 */
const calledAny = (f: Fake, names: readonly string[]): string[] =>
  [...f.runs, ...f.starts]
    .filter((c) => names.includes(basename(c.file).toLowerCase().replace(/\.(?:exe|cmd)$/, '')) || c.args.some((a) => names.includes(a)))
    .map((c) => `${c.file} ${c.args.join(' ')}`);
const operatorWords = (f: Fake): string[] => f.runs.filter((c) => c.file === process.execPath && c.args.includes('--json')).map((c) => c.args.slice(1, c.args.indexOf('--json')).join(' '));

const TS_RUNNING = { BackendState: 'Running', Self: { DNSName: 'pc.tail1.ts.net.', UserID: 7 }, User: { '7': { LoginName: 'me@example.com' } }, CertDomains: ['pc.tail1.ts.net'] };
const PHONE_ARGS = ['phone', '--owner-email', 'owner@example.com', '--google-client-id', '123-abc.apps.googleusercontent.com'];

/** 그 빌드의 결과 파일을 빈 파일로 만든다 (빌드가 최신인 것으로) */
function writeOutputs(spec: BuildSpec): void {
  for (const f of spec.outputs) {
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, spec.marker ? '<meta name="wook-build" content="remote">' : '');
  }
}

describe('체험 도구 자리 (tryKit)', () => {
  it.skipIf(!WIN)('기본 뿌리는 %LOCALAPPDATA%\\wookagent-try이고 모든 체험 폴더가 그 아래다 — 실제 데이터 폴더(%APPDATA%\\wookagent)와 겹치지 않는다', () => {
    const env = { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', APPDATA: 'C:\\Users\\u\\AppData\\Roaming' };
    const p = tryPaths(env, 'win32');
    expect(p.root).toBe('C:\\Users\\u\\AppData\\Local\\wookagent-try');
    for (const d of [p.server, p.serverWorkspace, p.phone, p.phoneWorkspace, p.desktop]) expect(d.startsWith(`${p.root}\\`)).toBe(true);
    expect(p.real).toEqual(['C:\\Users\\u\\AppData\\Roaming\\wookagent']);
    expect(pathsProblem(p, 'win32')).toBeNull();
  });

  it('WOOK_TRY_ROOT가 실제 데이터 폴더·WOOK_DATA_DIR와 겹치거나 상대 경로면 아무것도 하지 않는다 (끝 코드 2, 부른 것 없음)', async () => {
    const base = tempBase('wook-test-trykit-');
    const appData = join(base, 'Roaming');
    for (const env of [
      { APPDATA: appData, WOOK_TRY_ROOT: join(appData, 'wookagent') },
      { APPDATA: appData, WOOK_TRY_ROOT: join(appData, 'wookagent', 'inner') },
      { APPDATA: appData, WOOK_TRY_ROOT: join(base, 'try'), WOOK_DATA_DIR: join(base, 'try', 'server') },
      { APPDATA: appData, WOOK_TRY_ROOT: 'relative-root' },
    ]) {
      const paths = tryPaths(env);
      expect(pathsProblem(paths), JSON.stringify(env)).not.toBeNull();
      const f = makeFake({}, env, base, paths);
      for (const argv of [['local', '--headless', '--smoke'], ['mock'], ['stop'], ['desktop', '--dry-run'], ['local', '--fresh']]) {
        expect(await runKit(argv, f.deps), argv.join(' ')).toBe(2);
      }
      expect([...f.runs, ...f.starts, ...f.browsers]).toEqual([]);
    }
    // 아무 폴더도 만들지 않았다
    expect(readdirSync(base)).toEqual([]);
  });

  it.skipIf(!WIN)('Windows: WOOK_TRY_ROOT가 실제 데이터 폴더와 글자 크기만 달라도 겹친다고 본다 — 아무것도 하지 않는다 (끝 코드 2, 부른 것 없음 — TI-5)', async () => {
    const base = tempBase('wook-test-trykit-');
    const appData = join(base, 'Roaming');
    for (const env of [
      { APPDATA: appData, WOOK_TRY_ROOT: join(appData, 'WookAgent') },
      { APPDATA: appData, WOOK_TRY_ROOT: join(appData.toUpperCase(), 'WOOKAGENT', 'inner') },
      { APPDATA: appData, WOOK_TRY_ROOT: join(base, 'try'), WOOK_DATA_DIR: join(base, 'TRY', 'Server') },
    ]) {
      const paths = tryPaths(env, 'win32');
      expect(pathsProblem(paths, 'win32'), JSON.stringify(env)).not.toBeNull();
      const f = makeFake({}, env, base, paths);
      for (const argv of [['local', '--headless', '--smoke'], ['mock'], ['stop'], ['desktop', '--dry-run'], ['local', '--fresh']]) {
        expect(await runKit(argv, f.deps), `${JSON.stringify(env)} ${argv.join(' ')}`).toBe(2);
      }
      expect([...f.runs, ...f.starts, ...f.browsers]).toEqual([]);
    }
    expect(readdirSync(base)).toEqual([]);
  });

  it('데스크톱: 체험은 WOOK_DATA_DIR을 체험 폴더로 바꾸고, real-data만 그 변수를 빼서 앱의 기본 자리(실제 데이터)를 쓴다 — real-data는 묻고 y가 아니면 아무것도 띄우지 않는다', async () => {
    const { fake, paths, repo } = setup({ answer: 'n' }, { WOOK_DATA_DIR: 'D:\\real-server-data' });
    expect(desktopEnv({ WOOK_DATA_DIR: 'D:\\x', wook_data_dir: 'D:\\y', PATH: 'p' }, paths, false)).toEqual({ WOOK_DATA_DIR: paths.desktop, PATH: 'p' });
    expect(desktopEnv({ WOOK_DATA_DIR: 'D:\\x', PATH: 'p' }, paths, true)).toEqual({ PATH: 'p' });
    expect(await runKit(['desktop', '--dry-run'], fake.deps)).toBe(0);
    expect(fake.out()).toContain(paths.desktop);
    expect(fake.out()).toContain('아무것도 띄우지 않았습니다');
    expect(existsSync(paths.desktop)).toBe(false);
    // real-data — 'n'이면 그만둔다
    expect(await runKit(['desktop', 'real-data'], fake.deps)).toBe(1);
    expect(fake.out()).toContain('마이그레이션');
    expect([...fake.runs, ...fake.starts]).toEqual([]);
    // 체험 — 빌드가 최신이면 앱만 띄우고, 그 환경의 데이터 폴더는 체험 폴더다 (도구가 이 사용자만 쓰게 만들어 둔다)
    writeOutputs(buildSpecs(repo).desktop);
    expect(await runKit(['desktop'], fake.deps)).toBe(0);
    const app = fake.starts.find((s) => s.args.includes('preview'))!;
    expect(app.args).toEqual([buildSpecs(repo).desktop.command[0], 'preview', '--skipBuild']);
    expect(app.o?.env?.['WOOK_DATA_DIR']).toBe(paths.desktop);
    expect(hasTryMarker(paths.desktop)).toBe(true);
    // real-data — 'y'면 WOOK_DATA_DIR 없이 (앱의 기본 자리)
    const yes = setup({ answer: 'y' }, { WOOK_DATA_DIR: 'D:\\real-server-data' });
    writeOutputs(buildSpecs(yes.repo).desktop);
    expect(await runKit(['desktop', 'real-data'], yes.fake.deps)).toBe(0);
    const real = yes.fake.starts.find((s) => s.args.includes('preview'))!;
    expect(Object.keys(real.o?.env ?? {}).some((k) => k.toUpperCase() === 'WOOK_DATA_DIR')).toBe(false);
    expect(existsSync(yes.paths.desktop)).toBe(false);
  });
});

/** 그 자리들의 ACL — Get-Acl로 읽기만 한다 (보호 여부, 허용·거부 항목의 SID) */
interface Acl {
  protectedDacl: boolean;
  allow: string[];
  deny: string[];
}
function aclsOf(paths: string[]): Acl[] {
  const ps = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = [
    "$list = $env:WOOK_TEST_ACL_PATHS -split '\\|'",
    '$rows = @(foreach ($p in $list) { $a = Get-Acl -LiteralPath $p; $r = @($a.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])); ' +
      "[pscustomobject]@{ p = $a.AreAccessRulesProtected; allow = @($r | Where-Object { [string]$_.AccessControlType -eq 'Allow' } | ForEach-Object { $_.IdentityReference.Value }); " +
      "deny = @($r | Where-Object { [string]$_.AccessControlType -ne 'Allow' } | ForEach-Object { $_.IdentityReference.Value }) } })",
    'ConvertTo-Json -InputObject $rows -Depth 4 -Compress',
  ].join('; ');
  // 경로는 '|'로 잇는다 (Windows 경로에는 '|'가 없다)
  const out = execFileSync(ps, ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, WOOK_TEST_ACL_PATHS: paths.join('|') }, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  const arr = (x: unknown): string[] => (Array.isArray(x) ? (x as string[]) : x == null ? [] : [x as string]);
  const rows = JSON.parse(out) as { p: boolean; allow: unknown; deny: unknown }[];
  return rows.map((r) => ({ protectedDacl: r.p, allow: [...new Set(arr(r.allow))], deny: arr(r.deny) }));
}

/** 이 사용자의 SID */
function mySid(): string {
  const who = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'whoami.exe');
  return /"(S-1-\d+(?:-\d+)+)"\s*$/m.exec(execFileSync(who, ['/user', '/fo', 'csv', '/nh'], { encoding: 'latin1', windowsHide: true }))![1]!;
}

describe.skipIf(!WIN)('체험 폴더의 권한 (tryKit, 리드 결정 S9-22 DS-5)', () => {
  it('local·phone·desktop이 만드는 체험 폴더는 상속을 끊고 이 사용자만 쓴다 — 그 안의 server.json·try-front.json(중계 증명 값)도 이 사용자만. 이미 있던 폴더는 바꾸지 않는다', async () => {
    const seen: { front?: Acl } = {};
    const s = setup({ onBrowser: () => void (seen.front = aclsOf([join(s.paths.server, FRONT_FILE)])[0]) });
    expect(await runKit(['local', '--headless', '--smoke'], s.fake.deps)).toBe(0);
    const phoneFake = makeFake({ tailscale: TS_RUNNING, interruptWhenOut: /다 쓴 뒤 되돌리기/ }, s.env, s.repo, s.paths);
    expect(await runKit(PHONE_ARGS, phoneFake.deps)).toBe(130);
    const desktopFake = makeFake({}, s.env, s.repo, s.paths);
    writeOutputs(buildSpecs(s.repo).desktop);
    expect(await runKit(['desktop'], desktopFake.deps)).toBe(0);
    // 미리 있던 폴더 — 도구는 권한을 바꾸지 않고 표시도 넣지 않는다
    const pre = join(s.root, 'pre-existing');
    mkdirSync(pre, { recursive: true });
    expect(prepareTryDir(pre)).toEqual({ created: false });
    expect(hasTryMarker(pre)).toBe(false);

    // 뿌리도 도구가 만들었으면 같다 (다른 계정이 뿌리에 쓸 수 있으면 그 안의 폴더를 바꿔 놓을 수 있다)
    const dirs = [s.root, s.paths.server, s.paths.serverWorkspace, s.paths.phone, s.paths.phoneWorkspace, s.paths.desktop];
    const files = [join(s.paths.server, 'server.json'), join(s.paths.phone, 'server.json')];
    const got = aclsOf([...dirs, ...files, pre]);
    const me = mySid();
    expect(seen.front, 'Edge 창을 열 때 try-front.json의 권한').toEqual({ protectedDacl: false, allow: [me], deny: [] });
    expect(got.slice(0, dirs.length)).toEqual(dirs.map(() => ({ protectedDacl: true, allow: [me], deny: [] })));
    expect(got.slice(dirs.length, dirs.length + files.length)).toEqual(files.map(() => ({ protectedDacl: false, allow: [me], deny: [] })));
    expect(got[dirs.length + files.length]!.protectedDacl).toBe(false);
    for (const d of dirs) expect(hasTryMarker(d), d).toBe(true);
    // 제자리 옆에 임시 이름의 폴더(.<이름>.tmp-<16진 8자>)가 남지 않았다
    const staging = (d: string) => readdirSync(d).filter((n) => /\.tmp-[0-9a-f]{8}$/.test(n));
    expect([...staging(s.root), ...staging(dirname(s.root))]).toEqual([]);
  });
});

describe('server.json (tryKit)', () => {
  it('local: 서버가 받는 꼴 — 체험용 대표는 서버의 시험용 대표와 같은 이메일(설정 코드 없이 로그인한 홈), 처음 보유자 Claude, 화면 조작 끔, 체험 작업 폴더', async () => {
    const { fake, paths } = setup();
    const cfg = localServerConfig(paths);
    const parsed = parseServerConfig(cfg);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.config.screen.enabled).toBe(false);
    expect(parsed.config.owner.email).toBe(TRY_OWNER_EMAIL);
    expect(TRY_OWNER_EMAIL).toBe(TEST_OWNER.email);
    expect(normalizeOwnerEmail(TRY_OWNER_EMAIL)).toBe(TRY_OWNER_EMAIL);
    expect(seatConfigProblem({ initialHolder: parsed.config.seat!.initialHolder, holders: null, drainMs: null }, 'server.json')).toBeNull();
    expect(parsed.config.seat!.initialHolder).toBe('launched:claude');
    expect(parsed.config.workspaceRoot).toBe(paths.serverWorkspace);
    expect(workspaceProblem({ root: paths.serverWorkspace, source: 'config' }, paths.server)).toBeNull();
    // 도구가 처음 실행에 쓰는 파일이 바로 이것이다
    expect(await runKit(['local', '--headless', '--smoke'], fake.deps)).toBe(0);
    expect(JSON.parse(readFileSync(join(paths.server, 'server.json'), 'utf8'))).toEqual(cfg);
  });

  it('phone: 있던 칸(구글 클라이언트 ID)은 두고 대표 이메일·공개 주소·받는 Tailscale 사용자·화면 조작 끔을 쓴다 — 서버가 받는 꼴', () => {
    const { paths } = setup();
    const cfg = phoneServerConfig(
      { google: { clientId: '123-abc.apps.googleusercontent.com' }, network: { port: 7330 } },
      { ownerEmail: 'owner@example.com', login: 'me@example.com', origin: 'https://pc.tail1.ts.net', googleClientId: null, workspace: paths.phoneWorkspace },
    );
    const parsed = parseServerConfig(cfg);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.config).toMatchObject({
      owner: { email: 'owner@example.com', tailscaleLogins: ['me@example.com'] },
      google: { clientId: '123-abc.apps.googleusercontent.com' },
      network: { publicOrigin: 'https://pc.tail1.ts.net', port: 7330 },
      screen: { enabled: false },
      workspaceRoot: paths.phoneWorkspace,
    });
  });
});

describe('부르는 것 (tryKit)', () => {
  it('local: 체험 서버를 시험 세션·공개 주소와 띄우고 토큰은 Edge 쿠키로만 — secret·tailscale·claude를 부르지 않고, 토큰은 출력·명령 줄에 없으며, 끝나면 관리 채널 shutdown으로 끈다', async () => {
    const { fake, paths, webDir, entry } = setup();
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    expect(await runKit(['local', '--headless', '--smoke'], fake.deps)).toBe(0);
    expect(fake.starts).toHaveLength(1);
    expect(fake.starts[0]!.args).toEqual([
      entry,
      'serve',
      '--data-dir',
      paths.server,
      '--port',
      '0',
      '--allow-test-session',
      '--public-origin',
      'https://wook-try.test:4433',
      '--web-dir',
      webDir,
    ]);
    expect(fake.fronts).toEqual([{ port: 4433, upstream: 5555, closed: true }]);
    expect(fake.browsers).toEqual([{ origin: 'https://wook-try.test:4433', token: FAKE_TOKEN, headless: true, path: '/?studio3d=0' }]);
    expect(calledAny(fake, ['secret', 'tailscale', 'claude'])).toEqual([]);
    expect(allCalls(fake).some((c) => c.includes(FAKE_TOKEN))).toBe(false);
    expect(`${fake.out()}${fake.err()}`).not.toContain(FAKE_TOKEN);
    expect(operatorWords(fake)).toEqual(['status', 'session test', 'status', 'shutdown']);
    expect(fake.children[0]!.exitCode).toBe(0);
    expect(fake.children[0]!.kills).toBe(0);
    expect(existsSync(join(paths.server, FRONT_FILE))).toBe(false);
    expect(fake.out()).toContain('점검 통과');
    expect(kill).not.toHaveBeenCalled();
    // 할 일을 먼저 말한다: 비용(실제 Claude·구독 사용량)과 host_exec가 이 PC에서 돈다는 것, 이 PC의 Claude 로그인을 쓴다는 것이 서버를 띄우기 전에 나온다
    const banner = fake.events.findIndex((e) => e.startsWith('out:') && e.includes('구독 사용량') && e.includes('host_exec') && e.includes(CLAUDE_LOGIN_LINE));
    const started = fake.events.findIndex((e) => e.startsWith('start:'));
    expect(banner).toBeGreaterThanOrEqual(0);
    expect(banner).toBeLessThan(started);
  });

  it("체험 도구가 말하는 Claude 로그인 줄은 대표가 보게 될 제품의 글('claude 인증 만료 — 재로그인 필요')과 확인 명령(claude auth status)을 담는다 (DF-7)", () => {
    expect(CLAUDE_LOGIN_LINE).toContain('claude auth status');
    expect(CLAUDE_LOGIN_LINE).toContain("'claude 인증 만료 — 재로그인 필요'");
    // 제품의 글이 그대로인지 (메인 에이전트의 AI 종류가 claude일 때 그 글이 된다)
    expect(readFileSync(join(REPO, 'src', 'core', 'runGate.ts'), 'utf8')).toContain('`${i.ai.kind} 인증 만료 — 재로그인 필요`');
  });

  it('local --smoke: 로그인한 홈이 보이지 않으면 실패(1)로 끝나고, 그래도 띄운 서버는 끈다', async () => {
    const { fake } = setup({ checkFails: true });
    expect(await runKit(['local', '--headless', '--smoke'], fake.deps)).toBe(1);
    expect(fake.err()).toContain('점검 실패: 로그인 화면이 보입니다');
    expect(operatorWords(fake)).toEqual(['status', 'session test', 'status', 'shutdown']);
    expect(fake.children[0]!.exitCode).toBe(0);
  });

  it('local 창 모드: 사람이 Edge 창을 닫으면 서버를 끄고 끝난다 (0)', async () => {
    const { fake } = setup();
    expect(await runKit(['local'], fake.deps)).toBe(0);
    expect(fake.browsers[0]!.headless).toBe(false);
    expect(fake.browsers[0]!.path).toBe('/');
    expect(operatorWords(fake)).toEqual(['status', 'session test', 'shutdown']);
    expect(fake.children[0]!.exitCode).toBe(0);
  });

  it('mock: vitest(체험 설정)를 WOOK_TRY=1로 띄울 뿐 — 서버·운영자 명령·secret·tailscale을 부르지 않는다. 무대의 임시 폴더는 도구가 만들어 주고 끝나면 지운다', async () => {
    const { fake, webDir, repo } = setup();
    expect(await runKit(['mock', '--headless', '--smoke'], fake.deps)).toBe(0);
    expect(fake.runs).toEqual([]);
    expect(fake.starts).toHaveLength(1);
    const s = fake.starts[0]!;
    expect(s.args).toEqual([join(repo, 'node_modules', 'vitest', 'vitest.mjs'), 'run', '--config', 'vitest.try.config.ts', '--maxWorkers=1']);
    expect(s.o?.env).toMatchObject({ WOOK_TRY: '1', WOOK_TRY_WEB_DIR: webDir, WOOK_TRY_HEADLESS: '1', WOOK_TRY_SMOKE: '1' });
    const runDir = s.o!.env!['TEMP']!;
    expect({ parent: dirname(runDir), prefix: basename(runDir).startsWith(MOCK_TEMP_PREFIX), tmp: s.o!.env!['TMP'], tmpdir: s.o!.env!['TMPDIR'] }).toEqual({
      parent: tmpdir(),
      prefix: true,
      tmp: runDir,
      tmpdir: runDir,
    });
    expect(fake.vitestRunDirs).toHaveLength(1);
    expect(existsSync(runDir)).toBe(false);
    expect(calledAny(fake, ['secret', 'tailscale', 'claude'])).toEqual([]);
    expect(fake.out()).toContain('비용: 없습니다');
  });

  it('phone: tailscale은 status·serve status를 읽기만 한다 — serve를 켜고 끄는 명령은 보여 주기만 하고, 포트 7330에 시험 세션 없이 띄운다. 다른 serve 항목(TCP 7878)을 알린다. Ctrl+C로 끝내면 관리 채널로 끄고 130', async () => {
    const { fake, paths, entry, webDir } = setup({
      tailscale: TS_RUNNING,
      serve: { TCP: { '7878': { TCPForward: '127.0.0.1:7878' } } },
      interruptWhenOut: /다 쓴 뒤 되돌리기/,
    });
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const code = await runKit(PHONE_ARGS, fake.deps);
    expect(code).toBe(130);
    expect(fake.runs.filter((r) => r.file === 'tailscale').map((r) => r.args.join(' '))).toEqual(['status --json', 'serve status --json']);
    expect(fake.starts).toHaveLength(1);
    expect(fake.starts[0]!.args).toEqual([entry, 'serve', '--data-dir', paths.phone, '--port', '7330', '--web-dir', webDir]);
    expect(calledAny(fake, ['secret', 'claude'])).toEqual([]);
    expect(operatorWords(fake)).toEqual(['status', 'config show', 'shutdown']);
    expect(fake.children[0]!.kills).toBe(0);
    const out = fake.out();
    expect(out).toContain('  tailscale serve --bg 7330');
    expect(out).toContain('tailscale serve --https=443 off');
    expect(out).toContain('TCP 7878 → 127.0.0.1:7878');
    expect(out).toContain('자격 증명 관리자');
    expect(out).toContain(CLAUDE_LOGIN_LINE);
    const cfg = parseServerConfig(JSON.parse(readFileSync(join(paths.phone, 'server.json'), 'utf8')));
    expect(cfg.config).toMatchObject({ owner: { email: 'owner@example.com', tailscaleLogins: ['me@example.com'] }, network: { publicOrigin: 'https://pc.tail1.ts.net' }, screen: { enabled: false } });
    expect(kill).not.toHaveBeenCalled();
  });

  it('phone: HTTPS 인증서가 꺼져 있거나 구글 클라이언트가 없으면 할 일을 보여 주고 서버를 띄우지 않는다', async () => {
    const ts = { BackendState: 'Running', Self: { DNSName: 'pc.tail1.ts.net.', UserID: 7 }, User: { '7': { LoginName: 'me@example.com' } } };
    const off = setup({ tailscale: { ...ts, CertDomains: null } });
    expect(await runKit(PHONE_ARGS, off.fake.deps)).toBe(1);
    expect(off.fake.err()).toContain('HTTPS');
    expect(off.fake.starts).toEqual([]);
    const noClient = setup({ tailscale: { ...ts, CertDomains: ['pc.tail1.ts.net'] } });
    expect(await runKit(['phone', '--owner-email', 'owner@example.com'], noClient.fake.deps)).toBe(1);
    expect(noClient.fake.err()).toContain('--google-client-id');
    expect(noClient.fake.starts).toEqual([]);
    expect(readTailscaleStatus({ BackendState: 'Stopped' })).toMatchObject({ running: false, dnsName: null, https: false });
    expect(readServeStatus({ Web: { 'pc.tail1.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:7330' } } } }, AllowFunnel: {} })).toEqual({
      entries: ['https://pc.tail1.ts.net:443/ → http://127.0.0.1:7330'],
      ours: true,
      funnel: false,
    });
  });

  it('stop: 체험 데이터 폴더마다 상태를 묻고 도는 것만 관리 채널 shutdown으로 끈다 — PID로 끄지 않는다', async () => {
    const { fake } = setup({ running: { server: true } });
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    expect(await runKit(['stop'], fake.deps)).toBe(0);
    expect(operatorWords(fake)).toEqual(['status', 'shutdown', 'status']);
    expect(fake.starts).toEqual([]);
    expect(kill).not.toHaveBeenCalled();
    expect(fake.out()).toContain('local 체험 서버: 껐습니다');
    expect(fake.out()).toContain('phone 체험 서버: 돌고 있지 않습니다');
  });
});

describe('Ctrl+C (tryKit, 리드 결정 S9-22 DF-3·DF-4)', () => {
  it('local: 빌드 중에 받은 Ctrl+C — 처리기가 이미 걸려 있어 도구가 정하고, 빌드 실패 글 없이 130으로 끝난다. 서버도 운영자 명령도 부르지 않는다', async () => {
    const { fake } = setup({ interruptDuringBuild: true }, { WOOK_TRY_SERVER_ENTRY: undefined });
    expect(await runKit(['local', '--headless', '--smoke'], fake.deps)).toBe(130);
    expect(fake.unhandled()).toBe(0);
    expect(fake.err()).toBe('');
    expect(fake.out()).toContain('Ctrl+C — 빌드를 멈췄습니다');
    expect(fake.starts).toEqual([]);
    expect(operatorWords(fake)).toEqual([]);
    expect(fake.fronts).toEqual([]);
  });

  it('local: 서버가 준비 줄을 내기 전에 받은 Ctrl+C — 이 도구가 띄운 그 서버를 손잡이로 끝내고, 중계를 닫고, 그렇다고 말한 뒤 130. 세션·Edge는 열지 않는다', async () => {
    const { fake, paths } = setup({ serverNeverReady: true, interruptWhenOut: /체험 서버를 띄웁니다/, readyTimeoutMs: 2_000 });
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    expect(await runKit(['local', '--headless', '--smoke'], fake.deps)).toBe(130);
    expect(fake.unhandled()).toBe(0);
    expect(fake.children).toHaveLength(1);
    expect(fake.children[0]!.kills).toBe(1);
    expect(fake.fronts).toEqual([{ port: 4433, upstream: 0, closed: true }]);
    expect(fake.out()).toContain('Ctrl+C — 아직 준비 중인 체험 서버를 끝냅니다');
    expect(fake.err()).toBe('');
    expect(operatorWords(fake)).toEqual(['status']);
    expect(fake.browsers).toEqual([]);
    expect(existsSync(join(paths.server, FRONT_FILE))).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });

  it('phone: 서버가 준비되기 전에 받은 Ctrl+C도 같다 — 띄운 서버를 손잡이로 끝내고 130', async () => {
    const { fake } = setup({ tailscale: TS_RUNNING, serverNeverReady: true, interruptWhenOut: /휴대폰 체험 서버를 띄웁니다/, readyTimeoutMs: 2_000 });
    expect(await runKit(PHONE_ARGS, fake.deps)).toBe(130);
    expect(fake.unhandled()).toBe(0);
    expect(fake.children[0]!.kills).toBe(1);
    expect(fake.out()).toContain('Ctrl+C — 아직 준비 중인 휴대폰 체험 서버를 끝냅니다');
    expect(fake.err()).toBe('');
    expect(operatorWords(fake)).toEqual(['status']);
  });

  it('mock: Ctrl+C로 끝내면 정상 끝이다 — 오류 글 없이 130, 같은 창의 vitest는 그 신호로 끝나고, 무대의 임시 폴더(OS 임시 폴더 아래, 이 도구가 만든 것)는 지운다', async () => {
    // 같은 창의 vitest가 Ctrl+C로 스스로 끝나기를 기다리는 창 — 답이 오기를 바라므로 넉넉하게 (끝나면 바로 넘어간다)
    const { fake } = setup({ vitestStays: true, interruptWhenOut: /모의 무대를 띄웁니다/, exitWaitMs: 30_000 });
    expect(await runKit(['mock', '--headless', '--smoke'], fake.deps)).toBe(130);
    expect(fake.unhandled()).toBe(0);
    expect(fake.err()).toBe('');
    expect(fake.out()).toContain('Ctrl+C — 모의 무대를 닫았습니다. 모두 껐습니다.');
    const env = fake.starts[0]!.o!.env!;
    const runDir = env['TEMP']!;
    expect(dirname(runDir)).toBe(tmpdir());
    expect(basename(runDir).startsWith(MOCK_TEMP_PREFIX)).toBe(true);
    // 가짜 vitest가 그 안에 실행 폴더를 남겼지만(실제 vitest는 Ctrl+C로 끝나 제 정리를 못 한다) 도구가 지웠다
    expect(fake.vitestRunDirs).toEqual([join(runDir, 'wook-vitest-1-AbCdEf')]);
    expect(existsSync(runDir)).toBe(false);
    expect(fake.children[0]!.exitCode).toBe(130);
    expect(fake.children[0]!.kills).toBe(0);
  });

  it('mock: 빌드 중에 받은 Ctrl+C — 오류 글 없이 130, 무대를 띄우지 않는다', async () => {
    const { fake } = setup({ interruptDuringBuild: true }, { WOOK_TRY_WEB_DIR: undefined });
    expect(await runKit(['mock', '--headless', '--smoke'], fake.deps)).toBe(130);
    expect(fake.unhandled()).toBe(0);
    expect(fake.err()).toBe('');
    expect(fake.starts).toEqual([]);
  });
});

describe('이미 도는 체험 서버 (tryKit)', () => {
  it('그 서버의 중계가 데이터 폴더의 nonce로 증명하면 창만 하나 더 열고 서버는 끄지 않는다', async () => {
    const { fake, paths } = setup({ running: { server: true }, publicOrigin: 'https://wook-try.test:4999', busyPort: 4999, probeMac: (c) => frontMac('the-nonce', c) });
    mkdirSync(paths.server, { recursive: true });
    writeFileSync(join(paths.server, FRONT_FILE), JSON.stringify({ version: 1, port: 4999, nonce: 'the-nonce' }));
    expect(await runKit(['local'], fake.deps)).toBe(0);
    expect(fake.starts).toEqual([]);
    expect(fake.browsers.map((b) => b.origin)).toEqual(['https://wook-try.test:4999']);
    expect(operatorWords(fake)).toEqual(['status', 'config show', 'session test']);
    expect(existsSync(join(paths.server, FRONT_FILE))).toBe(true);
  });

  it('중계 포트에서 다른 것이 답하면(증명 실패) 세션을 받지도 쿠키를 보내지도 않는다', async () => {
    const { fake, paths } = setup({ running: { server: true }, publicOrigin: 'https://wook-try.test:4999', busyPort: 4999, probeMac: () => 'not-the-mac' });
    mkdirSync(paths.server, { recursive: true });
    writeFileSync(join(paths.server, FRONT_FILE), JSON.stringify({ version: 1, port: 4999, nonce: 'the-nonce' }));
    expect(await runKit(['local'], fake.deps)).toBe(1);
    expect(fake.browsers).toEqual([]);
    expect(operatorWords(fake)).toEqual(['status', 'config show']);
    expect(fake.err()).toContain('쿠키를 보내지 않았습니다');
  });

  it('띄운 도구가 끝나 중계가 없으면 같은 포트에 중계를 다시 띄워 이어 쓰고, 끝날 때 그 서버를 관리 채널로 끈다', async () => {
    const { fake } = setup({ running: { server: true }, publicOrigin: 'https://wook-try.test:4999' });
    expect(await runKit(['local', '--headless', '--smoke'], fake.deps)).toBe(0);
    expect(fake.starts).toEqual([]);
    expect(fake.fronts).toEqual([{ port: 4999, upstream: 5555, closed: true }]);
    expect(operatorWords(fake)).toEqual(['status', 'config show', 'session test', 'status', 'shutdown']);
  });

  it('try-server가 띄우지 않은 서버(공개 주소가 체험 주소가 아님)에는 들어가지 않는다', async () => {
    const { fake } = setup({ running: { server: true }, publicOrigin: 'https://grok-pc.example.ts.net' });
    expect(await runKit(['local'], fake.deps)).toBe(1);
    expect(fake.browsers).toEqual([]);
    expect(fake.fronts).toEqual([]);
  });
});

describe('Ctrl+C — 준비 뒤의 창 열기·점검, 모의 무대, status 사이 (tryKit, 리드 결정 S9-24 R2K-2·R2K-3)', () => {
  it('local: Edge 창을 여는 중에 받은 Ctrl+C — 정리가 중계를 닫아 창 열기가 실패해도 오류 글 없이 130, 끝 줄은 "모두 껐습니다"', async () => {
    const s = setup({ interruptWhenOut: /Edge 창을 엽니다: https/ });
    // Playwright처럼: 도구의 중계가 닫히면 page.goto가 연결 거부로 실패하고 openBrowser는 그 오류를 던진다
    s.fake.deps.openBrowser = async () => {
      for (let i = 0; i < 3000 && !s.fake.fronts.every((f) => f.closed); i++) await new Promise((r) => setTimeout(r, 10));
      throw new Error('page.goto: net::ERR_CONNECTION_REFUSED at https://wook-try.test:4433/');
    };
    expect(await runKit(['local'], s.fake.deps)).toBe(130);
    expect(s.fake.err()).toBe('');
    expect(s.fake.out().trim().split('\n').pop()).toBe(`모두 껐습니다. 데이터는 ${s.paths.server}에 남아 있습니다 (지우고 새로 하려면 --fresh)`);
    expect(operatorWords(s.fake).filter((w) => w === 'shutdown')).toHaveLength(1);
    expect(s.fake.fronts.every((f) => f.closed)).toBe(true);
  });

  it('local --smoke: 로그인한 홈을 기다리는 점검 중에 받은 Ctrl+C — 점검 실패가 아니라 130, 오류 글 없이 "모두 껐습니다"', async () => {
    const s = setup({ interruptWhenOut: /Edge 창을 엽니다: https/ });
    let release!: () => void;
    const closed = new Promise<void>((r) => (release = r));
    s.fake.deps.openBrowser = async () => ({
      closed,
      // 정리가 창을 닫을 때까지 기다렸다가, 닫혀서 홈을 보지 못했다고 답한다 (실제 check와 같다)
      check: async () => {
        await closed;
        return { ok: false as const, detail: '2분 안에 로그인한 홈(프로젝트 현황)이 보이지 않았습니다 — Target page, context or browser has been closed' };
      },
      close: async () => release(),
    });
    expect(await runKit(['local', '--headless', '--smoke'], s.fake.deps)).toBe(130);
    expect(s.fake.err()).toBe('');
    expect(s.fake.out()).not.toContain('점검 통과');
    expect(s.fake.out().trim().split('\n').pop()).toContain('모두 껐습니다');
    expect(operatorWords(s.fake).filter((w) => w === 'shutdown')).toHaveLength(1);
  });

  it('mock: Ctrl+C를 받고도 끝나지 않는 vitest는 기다린 뒤 도구가 쥔 손잡이로 한 번 끝낸다 — 130, 오류 글 없음, 무대의 임시 폴더는 지운다 (R5)', async () => {
    // 기다림(exitWaitMs)은 답이 오지 않기를 바라는 창이라 짧게 둔다 — 이 vitest는 끝나지 않는다
    const { fake } = setup({ vitestStays: true, vitestIgnoresCtrlC: true, interruptWhenOut: /모의 무대를 띄웁니다/ });
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    expect(await runKit(['mock', '--headless', '--smoke'], fake.deps)).toBe(130);
    expect(fake.children).toHaveLength(1);
    expect(fake.children[0]!.kills).toBe(1);
    expect(fake.children[0]!.exitCode).not.toBeNull();
    expect(fake.err()).toBe('');
    expect(fake.out()).toContain('Ctrl+C — 모의 무대를 닫았습니다. 모두 껐습니다.');
    expect(existsSync(fake.starts[0]!.o!.env!['TEMP']!)).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });

  it('local: 운영자 status를 묻는 동안 받은 Ctrl+C — 그 답 뒤에 멈춘다: 폴더도 server.json도 만들지 않고, 중계·서버를 띄우지 않는다 (R4)', async () => {
    const { fake, paths } = setup({ interruptOnStatus: true });
    expect(await runKit(['local', '--headless', '--smoke'], fake.deps)).toBe(130);
    expect(fake.out()).toContain('Ctrl+C — 서버를 띄우기 전에 멈췄습니다');
    expect([existsSync(paths.root), existsSync(paths.server), fake.fronts.length, fake.starts.length]).toEqual([false, false, 0, 0]);
    expect(fake.err()).toBe('');
  });

  it('mockEnv: TEMP·TMP·TMPDIR는 글자 크기가 다른 이름(Temp, tmp …)까지 모두 빼고 도구의 폴더 하나로만 준다 (Windows는 이름의 크기를 가리지 않는다, R2)', async () => {
    const env = mockEnv({ Temp: 'C:\\other\\Temp', tmp: 'C:\\other\\tmp', TmpDir: 'C:\\other', TEMP: 'C:\\x', PATH: 'p' }, { runDir: 'C:\\run', webDir: 'C:\\web', headless: true, smoke: true });
    const tempKeys = Object.keys(env).filter((k) => /^(temp|tmp|tmpdir)$/i.test(k));
    expect(tempKeys.sort()).toEqual(['TEMP', 'TMP', 'TMPDIR']);
    expect(tempKeys.map((k) => env[k])).toEqual(['C:\\run', 'C:\\run', 'C:\\run']);
    expect(env['PATH']).toBe('p');
    // 도구를 거쳐도 같다 — 무대가 받는 환경에 다른 임시 폴더가 남지 않는다
    const { fake } = setup({}, { Temp: 'C:\\other\\Temp', tmp: 'C:\\other\\tmp' });
    expect(await runKit(['mock', '--headless', '--smoke'], fake.deps)).toBe(0);
    const child = fake.starts[0]!.o!.env!;
    const childTemp = Object.keys(child).filter((k) => /^(temp|tmp|tmpdir)$/i.test(k));
    expect(childTemp.sort()).toEqual(['TEMP', 'TMP', 'TMPDIR']);
    expect(new Set(childTemp.map((k) => child[k])).size).toBe(1);
  });
});

describe('체험 폴더 만들기의 경합 (tryKit, R2K-3 R1)', () => {
  it('옮기기 바로 앞에 다른 실행이 같은 폴더를 만들었으면 그 폴더를 쓴다 ({created:false}) — 옆의 임시 폴더는 남기지 않고, 그 폴더는 건드리지 않는다', () => {
    const base = tempBase('wook-test-trykit-');
    const dir = join(base, 'root', 'server');
    let staged = '';
    const r = prepareTryDir(dir, process.platform, {
      beforeRename: (staging) => {
        staged = staging;
        mkdirSync(dir);
        writeFileSync(join(dir, 'other-run.txt'), 'x');
      },
    });
    expect(r).toEqual({ created: false });
    expect(staged).not.toBe('');
    expect(existsSync(staged)).toBe(false);
    expect(readdirSync(join(base, 'root')).sort()).toEqual(['server']);
    expect(readdirSync(dir)).toEqual(['other-run.txt']);
    expect(hasTryMarker(dir)).toBe(false);
  });
});

describe('--fresh (tryKit, 리드 결정 S9-22 DF-5)', () => {
  it('서버가 돌면 지우지 않고, 아니면 이 도구가 만든 체험 데이터·작업 폴더만 지운다 (phone 폴더는 그대로) — 새로 만든 폴더도 표시가 있다', async () => {
    const live = setup({ running: { server: true }, publicOrigin: 'https://wook-try.test:4999' });
    expect(prepareTryDir(live.paths.server)).toEqual({ created: true });
    writeFileSync(join(live.paths.server, 'keep.txt'), 'x');
    expect(await runKit(['local', '--fresh'], live.fake.deps)).toBe(1);
    expect(existsSync(join(live.paths.server, 'keep.txt'))).toBe(true);

    const idle = setup();
    // 첫 실행이 체험 폴더를 만든다 (표시 파일과 함께)
    expect(await runKit(['local', '--headless', '--smoke'], idle.fake.deps)).toBe(0);
    expect([hasTryMarker(idle.paths.server), hasTryMarker(idle.paths.serverWorkspace)]).toEqual([true, true]);
    for (const d of [idle.paths.server, idle.paths.serverWorkspace, idle.paths.phone]) {
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, 'old.txt'), 'x');
    }
    const again = makeFake({}, idle.env, idle.repo, idle.paths);
    expect(await runKit(['local', '--fresh', '--headless', '--smoke'], again.deps)).toBe(0);
    expect(existsSync(join(idle.paths.server, 'old.txt'))).toBe(false);
    expect(existsSync(join(idle.paths.serverWorkspace, 'old.txt'))).toBe(false);
    expect(existsSync(join(idle.paths.phone, 'old.txt'))).toBe(true);
    expect([hasTryMarker(idle.paths.server), hasTryMarker(idle.paths.serverWorkspace)]).toEqual([true, true]);
  });

  it('표시(.wook-try-folder)가 없는 폴더는 지우지 않는다 — 까닭과 그 폴더를 말하고 1로 끝나며, 아무것도 지우거나 부르지 않는다 (WOOK_TRY_ROOT에 남의 server·workspace 폴더가 있을 때)', async () => {
    for (const which of ['server', 'serverWorkspace'] as const) {
      const s = setup();
      // 도구가 만든 다른 폴더(표시 있음)와, 남의 폴더(표시 없음)
      const other = which === 'server' ? s.paths.serverWorkspace : s.paths.server;
      expect(prepareTryDir(other)).toEqual({ created: true });
      writeFileSync(join(other, 'mine.txt'), 'x');
      mkdirSync(s.paths[which], { recursive: true });
      writeFileSync(join(s.paths[which], 'user-file.txt'), '남의 파일');
      expect(freshProblem(s.paths)).toContain(s.paths[which]);
      expect(await runKit(['local', '--fresh', '--headless', '--smoke'], s.fake.deps)).toBe(1);
      expect(s.fake.err()).toContain(`체험 도구가 만든 표시(${TRY_MARKER} 파일)가 없어 지우지 않았습니다`);
      expect(s.fake.err()).toContain(s.paths[which]);
      expect(s.fake.err()).toContain('아무것도 지우지 않았습니다');
      expect(readFileSync(join(s.paths[which], 'user-file.txt'), 'utf8')).toBe('남의 파일');
      expect(existsSync(join(other, 'mine.txt'))).toBe(true);
      expect([...s.fake.runs, ...s.fake.starts, ...s.fake.browsers]).toEqual([]);
    }
    // 표시 파일의 내용이 다르면(다른 프로그램의 같은 이름) 표시로 보지 않는다
    const s = setup();
    mkdirSync(s.paths.server, { recursive: true });
    writeFileSync(join(s.paths.server, TRY_MARKER), 'something else\n');
    expect(hasTryMarker(s.paths.server)).toBe(false);
    expect(freshProblem(s.paths)).not.toBeNull();
  });
});

/** 체험 뿌리 바로 아래의 이름들 (옮겨 둔 `.…del-…` 폴더가 남았는지 본다) */
const rootNames = (p: TryPaths): string[] => (existsSync(p.root) ? readdirSync(p.root).sort() : []);

describe('--fresh: 옮긴 뒤에만 지운다 (tryKit, 리드 결정 S9-24 R2K-1)', () => {
  it.skipIf(!WIN)('작업 폴더 안을 다른 프로세스가 현재 폴더로 쥐고 있으면 — 몇 초 안에 1로 끝나고, 그 폴더와 닫을 것을 말하며, 아무것도 지우지 않는다 (두 폴더 모두 제 이름·표시·파일 그대로). 놓은 뒤에는 지우고 새로 만든다', async () => {
    const s = setup();
    expect(await runKit(['local', '--headless', '--smoke'], s.fake.deps)).toBe(0);
    const proj = join(s.paths.serverWorkspace, 'main', 'proj');
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, 'notes.txt'), 'owner work');
    const before = rootNames(s.paths);
    // 그 안을 현재 폴더로 둔 창 (이 시험이 띄우고 쥔 손잡이로만 끝낸다)
    const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: proj, stdio: 'ignore', windowsHide: true });
    try {
      await new Promise<void>((r, j) => {
        holder.once('spawn', () => r());
        holder.once('error', j);
      });
      const held = makeFake({}, s.env, s.repo, s.paths);
      const t0 = Date.now();
      const code = await runKit(['local', '--fresh', '--headless', '--smoke'], held.deps);
      const took = Date.now() - t0;
      expect(code).toBe(1);
      // 넉넉한 상한 — 옮기기는 바로 거절된다(예전에는 지우기를 2분 넘게 다시 시도했다)
      expect(took).toBeLessThan(20_000);
      expect(held.err()).toContain('이 폴더를 다른 프로그램이 쓰고 있어 지우지 않았습니다');
      expect(held.err()).toContain(s.paths.serverWorkspace);
      expect(held.err()).toContain('현재 폴더로 둔 창');
      expect(held.err()).toContain('아무것도 지우지 않았습니다');
      expect([hasTryMarker(s.paths.server), hasTryMarker(s.paths.serverWorkspace)]).toEqual([true, true]);
      expect(existsSync(join(s.paths.server, 'server.json'))).toBe(true);
      expect(readFileSync(join(proj, 'notes.txt'), 'utf8')).toBe('owner work');
      expect(rootNames(s.paths)).toEqual(before);
      expect([held.starts.length, held.fronts.length]).toEqual([0, 0]);
    } finally {
      if (holder.exitCode === null && holder.signalCode === null) holder.kill();
      await new Promise((r) => (holder.exitCode !== null || holder.signalCode !== null ? r(undefined) : holder.once('exit', r)));
    }
    // 놓은 뒤에는 지우고 새로 만든다 (표시와 함께), 옮겨 둔 이름은 남지 않는다
    const again = makeFake({}, s.env, s.repo, s.paths);
    expect(await runKit(['local', '--fresh', '--headless', '--smoke'], again.deps)).toBe(0);
    expect(existsSync(proj)).toBe(false);
    expect([hasTryMarker(s.paths.server), hasTryMarker(s.paths.serverWorkspace)]).toEqual([true, true]);
    expect(rootNames(s.paths).filter((n) => FRESH_TRASH_RE.test(n))).toEqual([]);
  }, 60_000);

  it('지난번에 남은 옆 이름 폴더(.workspace.del-…)가 있어도 다음 --fresh는 된다 — 그 폴더는 건드리지 않고 손으로 지워도 된다고 알린다', async () => {
    const s = setup();
    expect(await runKit(['local', '--headless', '--smoke'], s.fake.deps)).toBe(0);
    const leftover = join(s.paths.root, '.workspace.del-0a1b2c3d');
    mkdirSync(join(leftover, 'main'), { recursive: true });
    writeFileSync(join(leftover, 'main', 'old.txt'), 'x');
    const again = makeFake({}, s.env, s.repo, s.paths);
    expect(await runKit(['local', '--fresh', '--headless', '--smoke'], again.deps)).toBe(0);
    expect(again.out()).toContain(`앞서 다 지우지 못하고 남은 폴더가 있습니다 — 쓰지 않는 폴더이니 손으로 지워도 됩니다: ${leftover}`);
    expect(existsSync(join(leftover, 'main', 'old.txt'))).toBe(true);
    expect([hasTryMarker(s.paths.server), hasTryMarker(s.paths.serverWorkspace)]).toEqual([true, true]);
  });

  it('freshRemove는 체험 뿌리 밖의 폴더와 표시 없는 폴더를 옮기지도 지우지도 않는다 — 이미 옮긴 것은 제 이름으로 되돌린다', async () => {
    const s = setup();
    const quiet = makeFake({}, s.env, s.repo, s.paths);
    // 뿌리 밖: 데이터 폴더 자리가 뿌리 옆을 가리키게 만든 자리 (표시 파일까지 있어도)
    const outside = join(dirname(s.paths.root), 'outside-server');
    expect(prepareTryDir(outside)).toEqual({ created: true });
    writeFileSync(join(outside, 'precious.txt'), 'x');
    expect(await freshRemove({ ...s.paths, server: outside }, quiet.deps, null)).toBe(1);
    expect(quiet.err()).toContain('체험 뿌리');
    expect([existsSync(join(outside, 'precious.txt')), hasTryMarker(outside)]).toEqual([true, true]);
    // 뿌리 자신도 지우지 않는다
    expect(prepareTryDir(s.paths.root)).toEqual({ created: true });
    expect(await freshRemove({ ...s.paths, server: s.paths.root, serverWorkspace: join(s.paths.root, 'none') }, quiet.deps, null)).toBe(1);
    expect(hasTryMarker(s.paths.root)).toBe(true);
    // 표시 있는 데이터 폴더는 먼저 옮겨졌다가, 표시 없는 작업 폴더(남의 폴더)에서 멈추면 제 이름으로 돌아온다
    expect(prepareTryDir(s.paths.server)).toEqual({ created: true });
    writeFileSync(join(s.paths.server, 'server.json'), '{}');
    mkdirSync(s.paths.serverWorkspace, { recursive: true });
    writeFileSync(join(s.paths.serverWorkspace, 'user-file.txt'), '남의 파일');
    const before = rootNames(s.paths);
    const f2 = makeFake({}, s.env, s.repo, s.paths);
    expect(await freshRemove(s.paths, f2.deps, null)).toBe(1);
    expect(f2.err()).toContain('표시');
    expect([hasTryMarker(s.paths.server), existsSync(join(s.paths.server, 'server.json')), readFileSync(join(s.paths.serverWorkspace, 'user-file.txt'), 'utf8')]).toEqual([true, true, '남의 파일']);
    expect(rootNames(s.paths)).toEqual(before);
  });

  it('되돌리기마저 실패하면(작업 폴더 옮기기 거절 + 데이터 폴더 되돌리기 거절) 참인 것만 말한다 — 지운 것 없음, 어느 옆 이름에 있는지와 되돌리는 명령. 그 폴더에는 메모가 남고, 다음 실행·다음 --fresh는 그 폴더를 "되돌릴 폴더"로 말하며 새 빈 폴더로 시작하지도 지우지도 않는다 (S9-25 R3-1)', async () => {
    const s = setup();
    expect(await runKit(['local', '--headless', '--smoke'], s.fake.deps)).toBe(0);
    writeFileSync(join(s.paths.server, 'owner-notes.txt'), 'important');
    const serverBefore = readdirSync(s.paths.server).sort();
    const workBefore = readdirSync(s.paths.serverWorkspace).sort();
    const f = makeFake({}, s.env, s.repo, s.paths);
    const refuse = (from: string, to: string): void => {
      // 작업 폴더의 옮기기는 거절되고(쥐고 있음), 데이터 폴더를 제 이름으로 되돌리는 것도 거절된다
      if (from === s.paths.serverWorkspace) throw Object.assign(new Error('EPERM: held'), { code: 'EPERM' });
      if (to === s.paths.server && /^\.server\.del-/.test(basename(from))) throw Object.assign(new Error('EPERM: held too'), { code: 'EPERM' });
    };
    expect(await freshRemove(s.paths, f.deps, null, { rename: refuse })).toBe(1);
    const side = rootNames(s.paths).filter((n) => FRESH_TRASH_RE.test(n));
    expect(side).toHaveLength(1);
    const sideDir = join(s.paths.root, side[0]!);
    // 참인 것만: 지운 것은 없다, 데이터 폴더의 내용은 그 옆 이름에 있다, 되돌리는 명령 하나 — '그대로입니다'는 말하지 않는다
    expect(f.err()).toContain('아무것도 지우지 않았습니다');
    expect(f.err()).not.toContain('그대로입니다');
    expect(f.err()).toContain(`server 폴더의 내용은 그대로 ${sideDir} 에 있습니다`);
    expect(f.err()).toContain(`Rename-Item -LiteralPath "${sideDir}" -NewName server`);
    // 두 데이터 모두 디스크에 있다: 데이터 폴더는 옆 이름에(메모와 함께), 작업 폴더는 제 이름에
    expect(existsSync(s.paths.server)).toBe(false);
    expect(readdirSync(sideDir).filter((n) => n !== RESTORE_NOTE).sort()).toEqual(serverBefore);
    expect(restoreTarget(sideDir)).toBe('server');
    expect(readdirSync(s.paths.serverWorkspace).sort()).toEqual(workBefore);
    // 다음 실행(--fresh 없이): 그 폴더를 되돌릴 폴더로 말하고, 새 빈 데이터 폴더로 시작하지 않는다 (1, 아무것도 만들지 않음)
    const plain = makeFake({}, s.env, s.repo, s.paths);
    expect(await runKit(['local', '--headless', '--smoke'], plain.deps)).toBe(1);
    expect(plain.err()).toContain(`되돌리지 못한 체험 폴더가 있습니다`);
    expect(plain.err()).toContain(`Rename-Item -LiteralPath "${sideDir}" -NewName server`);
    expect(plain.err()).toContain('새 빈 폴더로 시작하지 않았습니다');
    expect([existsSync(s.paths.server), plain.runs.length, plain.starts.length]).toEqual([false, 0, 0]);
    // 다음 --fresh: 같은 말, 그 폴더를 쓰지 않는 폴더라고 하지 않고 지우지 않는다
    const fresh = makeFake({}, s.env, s.repo, s.paths);
    expect(await runKit(['local', '--fresh', '--headless', '--smoke'], fresh.deps)).toBe(1);
    expect(`${fresh.out()}${fresh.err()}`).not.toContain('쓰지 않는 폴더이니 손으로 지워도 됩니다');
    expect(fresh.err()).toContain(`Rename-Item -LiteralPath "${sideDir}" -NewName server`);
    expect(readFileSync(join(sideDir, 'owner-notes.txt'), 'utf8')).toBe('important');
    expect(readdirSync(s.paths.serverWorkspace).sort()).toEqual(workBefore);
    // 대표가 그 명령대로 이름을 되돌리면 이어 쓴다 (메모 파일은 그 안에 남아도 된다)
    renameSync(sideDir, s.paths.server);
    const after = makeFake({}, s.env, s.repo, s.paths);
    expect(await runKit(['local', '--headless', '--smoke'], after.deps)).toBe(0);
    expect(after.out()).toContain('server.json은 있는 것을 그대로 씁니다');
    expect(readFileSync(join(s.paths.server, 'owner-notes.txt'), 'utf8')).toBe('important');
  });

  it('옮기는 동안 받은 Ctrl+C — 옮긴 것을 되돌리고 130, 아무것도 지우지 않는다', async () => {
    const s = setup();
    expect(await runKit(['local', '--headless', '--smoke'], s.fake.deps)).toBe(0);
    const before = rootNames(s.paths);
    const f = makeFake({}, s.env, s.repo, s.paths);
    // 첫 폴더를 옮긴 뒤에 Ctrl+C가 온 것으로 (그 전 확인에서는 아직 받지 않았다)
    let looks = 0;
    const stop = {
      get fired(): boolean {
        return looks++ > 0;
      },
    };
    expect(await freshRemove(s.paths, f.deps, stop)).toBe(130);
    expect(f.out()).toContain('Ctrl+C — --fresh를 멈췄습니다');
    expect([hasTryMarker(s.paths.server), hasTryMarker(s.paths.serverWorkspace), existsSync(join(s.paths.server, 'server.json'))]).toEqual([true, true, true]);
    expect(rootNames(s.paths)).toEqual(before);
  });
});

describe('빌드가 낡았는지 (tryKit)', () => {
  it('결과가 없거나, 소스가 결과보다 새롭거나, 서버용 웹 빌드가 아니면 낡았다고 그 까닭을 말한다', () => {
    const repo = tempBase('wook-test-trykit-repo-');
    const spec = buildSpecs(repo).web;
    mkdirSync(join(repo, 'src', 'renderer', 'src'), { recursive: true });
    const source = join(repo, 'src', 'renderer', 'src', 'App.tsx');
    writeFileSync(source, 'x');
    expect(staleReason(spec, repo)).toMatch(/index\.html이\(가\) 없습니다/);
    const html = spec.outputs[0]!;
    mkdirSync(join(html, '..'), { recursive: true });
    writeFileSync(html, '<meta name="wook-build" content="remote">');
    const t = Date.now() / 1000;
    utimesSync(source, t - 100, t - 100);
    utimesSync(html, t - 10, t - 10);
    expect(staleReason(spec, repo)).toBeNull();
    utimesSync(source, t, t);
    expect(staleReason(spec, repo)).toMatch(/App\.tsx이\(가\) 빌드보다 새롭습니다/);
    utimesSync(source, t - 100, t - 100);
    writeFileSync(html, '<html>개발용 빌드</html>');
    utimesSync(html, t - 10, t - 10);
    expect(staleReason(spec, repo)).toMatch(/서버용 웹 화면 빌드가 아닙니다/);
  });

  it('빌드가 읽는 src/server 파일이 바뀌어도 낡았다고 본다 — 웹 화면은 src/server/webScreen.ts(빌드 설정이 부른다), 데스크톱 앱은 src/main이 부르는 src/server 파일 (DF-6)', () => {
    const repo = tempBase('wook-test-trykit-repo-');
    const specs = buildSpecs(repo);
    const t = Date.now() / 1000;
    const file = (rel: string, age: number): string => {
      const p = join(repo, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, 'x');
      utimesSync(p, t - age, t - age);
      return p;
    };
    file('src/renderer/src/App.tsx', 100);
    file('src/main/index.ts', 100);
    writeOutputs(specs.web);
    writeOutputs(specs.desktop);
    for (const f of [...specs.web.outputs, ...specs.desktop.outputs]) utimesSync(f, t - 10, t - 10);
    expect([staleReason(specs.web, repo), staleReason(specs.desktop, repo)]).toEqual([null, null]);
    file('src/server/webScreen.ts', 0);
    expect(staleReason(specs.web, repo)).toMatch(/webScreen\.ts이\(가\) 빌드보다 새롭습니다/);
    file('src/server/webScreen.ts', 100);
    file('src/server/dataDir.ts', 0);
    expect(staleReason(specs.desktop, repo)).toMatch(/dataDir\.ts이\(가\) 빌드보다 새롭습니다/);
  });

  it('빌드 셋의 소스는 그 빌드가 부르는 파일을 모두 덮는다 — 소스 안의 코드(빌드 설정 포함)가 소스 밖의 파일을 import하지 않는다 (이 저장소 그대로, DF-6)', () => {
    const specs = buildSpecs(REPO);
    const CODE = /\.(?:[cm]?[jt]sx?)$/;
    /** 빌드에 들지 않는 것: 시험 파일, 화면 작업 도구(src/renderer/tools — vite는 src/renderer/index.html·src에서 시작한다) */
    const notBuilt = (p: string): boolean => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(p) || p.includes(`${join('src', 'renderer', 'tools')}`);
    const ALIAS: [string, string][] = [
      ['@shared', 'src/shared'],
      ['@core', 'src/core'],
      ['@renderer', 'src/renderer/src'],
    ];
    const inside = (child: string, parent: string): boolean => {
      const r = relative(parent, child);
      return r === '' || (!r.startsWith('..') && !isAbsolute(r));
    };
    const files = (p: string): string[] => {
      if (!existsSync(p)) return [];
      if (statSync(p).isDirectory()) return readdirSync(p).flatMap((n) => (n === 'node_modules' ? [] : files(join(p, n))));
      return CODE.test(p) && !notBuilt(p) ? [p] : [];
    };
    /** import가 가리키는 파일 (확장자를 붙여 찾는다 — 못 찾으면 그 자리 그대로) */
    const target = (from: string, spec: string): string | null => {
      const bare = spec.replace(/[?#].*$/, '');
      let base: string | null = null;
      if (bare.startsWith('.')) base = resolve(dirname(from), bare);
      else for (const [a, d] of ALIAS) if (bare === a || bare.startsWith(`${a}/`)) base = join(REPO, d, bare.slice(a.length));
      if (!base) return null; // 패키지·node: — 소스 파일이 아니다
      const found = [base, ...['.ts', '.tsx', '.mts', '.mjs', '.js'].map((x) => `${base}${x}`), join(base, 'index.ts'), join(base, 'index.tsx')].find(
        (c) => existsSync(c) && statSync(c).isFile(),
      );
      return found ?? base;
    };
    const outside: string[] = [];
    let seen = 0;
    for (const [kind, spec] of Object.entries(specs)) {
      for (const f of spec.sources.flatMap(files)) {
        const text = readFileSync(f, 'utf8');
        for (const m of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gm)) {
          const to = target(f, m[1]!);
          if (!to) continue;
          seen++;
          if (!spec.sources.some((s) => inside(to, s))) outside.push(`${kind}: ${relative(REPO, f)} → ${m[1]}`);
        }
      }
    }
    // 무언가를 보았다 (찾는 규칙이 망가져 아무것도 보지 않고 통과하지 않게)
    expect(seen).toBeGreaterThan(500);
    expect(outside).toEqual([]);
  });

  it('낡은 웹 화면은 다시 만들고(npm run build:web과 같은 vite 명령), 만들기 전에 그렇다고 말한다', async () => {
    const { fake, repo } = setup(
      {
        onBuild: (args) => {
          if (args.includes('vite.web.config.ts')) {
            const html = join(repo, 'out', 'web', 'index.html');
            mkdirSync(join(html, '..'), { recursive: true });
            writeFileSync(html, '<meta name="wook-build" content="remote">');
          }
        },
      },
      { WOOK_TRY_WEB_DIR: undefined },
    );
    expect(await runKit(['mock', '--headless', '--smoke'], fake.deps)).toBe(0);
    const build = fake.runs.find((r) => r.args.includes('vite.web.config.ts'))!;
    expect(build.args).toEqual([join(repo, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', 'vite.web.config.ts', '--mode', 'remote']);
    const said = fake.events.findIndex((e) => e.startsWith('out:빌드: 웹 화면을 다시 만듭니다'));
    const ran = fake.events.findIndex((e) => e.startsWith('run:') && e.includes('vite.web.config.ts'));
    expect(said).toBeGreaterThanOrEqual(0);
    expect(said).toBeLessThan(ran);
    expect(fake.starts[0]!.o?.env?.['WOOK_TRY_WEB_DIR']).toBe(join(repo, 'out', 'web'));
  });
});
