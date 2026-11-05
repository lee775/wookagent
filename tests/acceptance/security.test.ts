/**
 * 완료 기준 보안 그룹: AC-01 · AC-02 · AC-18 · AC-19 · AC-20 · AC-30 · AC-31 · AC-32 · AC-33 (기획서 17장).
 * 실제 오케스트레이터·저장소·git·프로세스 러너·앱 도구 서버(HTTP)·모의 에이전트로 확인한다 (security-helpers.ts).
 * 트레이·창·절전 방지는 Electron 껍데기 모듈(src/main/shell)을 가짜 electron 위에서 실제 백엔드에 연결해 확인한다.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IPC_METHODS } from '@shared/ipc';
import { MAIN_AGENT_ID } from '@shared/domain';
import { TOOL_SPECS } from '../../src/main/mcp/catalog';
import { isPublicMethod } from '../../src/main/orchestrator/api';
import { googleLogin } from '../../src/main/auth/googleAuth';
import { createClaudeAdapter, createCodexAdapter } from '../../src/main/agents';
import { createPowerGuard } from '../../src/main/shell/power';
import { createTray } from '../../src/main/shell/tray';
import { createMainWindowController } from '../../src/main/shell/window';
import { createBackendOperator } from '../../src/main/backend/operator';
import { deviceSessionView } from '../../src/main/auth/deviceSessions';
import { createFileLogger } from '../../src/main/shell/logger';
import { startServer, type RunningServer } from '../../src/server/server';
import { serverRedactor } from '../../src/server/serve';
import { showSetupCode } from '../../src/main/orchestrator/serverLogin';
import {
  addProject,
  bootApp,
  callTool,
  canConnect,
  dumpDb,
  fakeGoogle,
  fakeShell,
  isLoopback,
  lanAddresses,
  listeners,
  mainToken,
  persistentSecrets,
  processTree,
  removeDirs,
  revParse,
  samePath,
  scanFiles,
  screenDump,
  sendCommand,
  sleep,
  tempDir,
  tokenFor,
  toolRejections,
  waitFor,
  type App,
} from './security-helpers';

// ───────────────────────── 가짜 electron (창·트레이·절전 방지) ─────────────────────────

const fx = vi.hoisted(() => {
  type Handler = (...args: unknown[]) => unknown;
  class Emitter {
    private handlers = new Map<string, Handler[]>();
    on(event: string, cb: Handler) {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), cb]);
      return this;
    }
    once(event: string, cb: Handler) {
      const wrapped: Handler = (...args) => {
        this.handlers.set(event, (this.handlers.get(event) ?? []).filter((h) => h !== wrapped));
        return cb(...args);
      };
      return this.on(event, wrapped);
    }
    emit(event: string, ...args: unknown[]) {
      for (const cb of [...(this.handlers.get(event) ?? [])]) cb(...args);
    }
  }
  class FakeWebContents extends Emitter {
    session = { setPermissionRequestHandler: () => undefined, setPermissionCheckHandler: () => undefined };
    setWindowOpenHandler() {}
    toggleDevTools() {}
  }
  const windows: FakeWindow[] = [];
  class FakeWindow extends Emitter {
    webContents = new FakeWebContents();
    visible = false;
    minimized = false;
    destroyed = false;
    loadURL = async () => undefined;
    loadFile = async () => undefined;
    show() {
      this.visible = true;
      this.emit('show');
    }
    hide() {
      this.visible = false;
    }
    focus() {}
    restore() {
      this.minimized = false;
    }
    constructor(public options: Record<string, unknown>) {
      super();
      windows.push(this);
    }
    isVisible() {
      return this.visible;
    }
    isMinimized() {
      return this.minimized;
    }
    isDestroyed() {
      return this.destroyed;
    }
    /** 실제 창 닫기 흐름: close(막을 수 있음) → closed */
    tryClose() {
      const event = { defaultPrevented: false, preventDefault: () => (event.defaultPrevented = true) };
      this.emit('close', event);
      if (!event.defaultPrevented) {
        this.destroyed = true;
        this.emit('closed');
      }
      return event;
    }
  }
  const trays: FakeTray[] = [];
  class FakeTray {
    tooltip = '';
    image: unknown;
    menu: { label?: string; type?: string; click?: () => void }[] = [];
    handlers = new Map<string, () => void>();
    destroyed = false;
    constructor(image: unknown) {
      this.image = image;
      trays.push(this);
    }
    setToolTip(t: string) {
      this.tooltip = t;
    }
    setContextMenu(m: FakeTray['menu']) {
      this.menu = m;
    }
    setImage(i: unknown) {
      this.image = i;
    }
    on(event: string, cb: () => void) {
      this.handlers.set(event, cb);
      return this;
    }
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      this.destroyed = true;
    }
  }
  const started = new Set<number>();
  let next = 1;
  const powerSaveBlocker = {
    start: (_type: string) => {
      const id = next++;
      started.add(id);
      return id;
    },
    stop: (id: number) => void started.delete(id),
    isStarted: (id: number) => started.has(id),
  };
  return {
    windows,
    trays,
    started,
    electron: {
      BrowserWindow: FakeWindow,
      Tray: FakeTray,
      Menu: { buildFromTemplate: (t: unknown) => t },
      nativeImage: { createFromBitmap: (buffer: Buffer, opts: unknown) => ({ buffer, opts, addRepresentation() {} }) },
      powerSaveBlocker,
      screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }) },
      shell: { openExternal: async () => undefined },
      ipcMain: { handle: () => undefined, removeHandler: () => undefined },
    },
  };
});
vi.mock('electron', () => fx.electron);

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };

// ───────────────────────── 공용 ─────────────────────────

const apps: App[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
  await removeDirs(dirs.splice(0));
});

async function boot(o: Parameters<typeof bootApp>[0] = {}): Promise<App> {
  const a = await bootApp(o);
  apps.push(a);
  return a;
}

const OWNER_A = { sub: 'google-sub-owner-0001', email: 'owner@example.com', emailVerified: true, name: '대표' };
const OTHER_B = { sub: 'google-sub-other-0002', email: 'intruder@example.com', emailVerified: true, name: '다른 사람' };
const CLIENT_ID = 'wook-acceptance.apps.googleusercontent.com';

async function rejectCode(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'resolved';
  } catch (e) {
    return (e as { code?: string }).code ?? `error:${(e as Error).message}`;
  }
}

/** 지금까지의 마지막 활동 기록 번호 */
const lastSeq = (app: App): number => Math.max(0, ...app.ctx.store.activity.search({ limit: 1 }).map((e) => e.seq));

/**
 * seq0 뒤로 그 도구들의 거부 기록(활동 기록 app_tool, 경고, 사유)이 없는 도구 목록 (비어 있어야 함).
 * 토큰을 폐기해 HTTP 401로 거부하는 고침도 맞는 고침이라, 신원이 없는(memberId null) 401 거부 기록도 인정한다
 */
function unloggedRefusals(app: App, seq0: number, memberId: string, tools: string[]): string[] {
  const rej = toolRejections(app).filter((r) => r.seq > seq0 && r.level === 'warn' && !!r.result && (r.memberId === memberId || r.memberId === null));
  return tools.filter((t) => !rej.some((r) => r.tool === t));
}

/** 로그인 전에 원래 열려 있던 화면 메서드 (구글 설정을 넣을 수 없는 것들) */
const BASE_PUBLIC = new Set<string>(['auth.getState', 'auth.login', 'auth.devLogin', 'auth.logout', 'system.prereqs']);
const GOOGLE_SECRET = 'wook-acceptance-google-secret';

// ═════════════════════════ AC-01 ═════════════════════════

describe('AC-01 대표 계정으로 로그인하면 홈이 열리고, 다른 구글 계정은 거부된다', () => {
  it('AC-01: 구글 설정이 된 설치본 — 처음 로그인한 구글 계정이 대표가 되어 홈 데이터가 열리고, 다른 구글 계정은 거부·기록되며 대표 세션은 그대로다', async () => {
    const google = fakeGoogle();
    const shell = fakeShell();
    const dataDir = tempDir('data');
    dirs.push(dataDir);
    const app = await boot({ dataDir, isPackaged: true, googleLogin: google.login, shell, preSettings: { account: { googleClientId: CLIENT_ID } }, stopScheduler: true, runnerMode: 'taskkill' });

    // 로그인 전: 화면 접근 불가, 개발 모드 로그인 없음 (패키징)
    expect(await app.invoke('auth.getState')).toEqual({ loggedIn: false, owner: null, googleConfigured: true, googleSecretSet: false, ownerRegistered: false, devLoginAllowed: false, googleSetupOpen: true });
    expect(await rejectCode(app.invoke('snapshot.get'))).toBe('unauthorized');
    expect(await rejectCode(app.invoke('auth.devLogin'))).toBe('forbidden');

    // 대표 로그인 (시스템 기본 브라우저로 진행 — AUTH-05)
    google.queue.push(OWNER_A);
    const st = await app.invoke('auth.login');
    expect(st).toMatchObject({ loggedIn: true, owner: { email: OWNER_A.email, name: OWNER_A.name } });
    expect(google.calls[0]!.clientId).toBe(CLIENT_ID);
    expect(shell.opened.some((u) => u.startsWith('https://accounts.google.com/'))).toBe(true);
    // 홈(App.tsx: snapshot.auth.loggedIn이면 프로젝트 탭 홈)에 쓰는 전체 스냅샷이 열린다
    const snap = await app.invoke('snapshot.get');
    expect(snap.auth.loggedIn).toBe(true);
    expect(Array.isArray(snap.projects) && Array.isArray(snap.ownerTodos)).toBe(true);

    // 대표가 로그인한 채로 다른 계정 로그인 시도 → 거부, 대표 세션 유지
    google.queue.push(OTHER_B);
    expect(await rejectCode(app.invoke('auth.login'))).toBe('forbidden');
    expect(await app.invoke('auth.getState')).toMatchObject({ loggedIn: true, owner: { email: OWNER_A.email } });

    // 로그아웃 뒤 다른 계정 → 거부, 화면 계속 잠김, 기록 남음
    await app.invoke('auth.logout');
    google.queue.push(OTHER_B);
    let message = '';
    await app.invoke('auth.login').catch((e: Error) => (message = e.message));
    expect(message).toContain('대표 계정');
    expect(await app.invoke('auth.getState')).toMatchObject({ loggedIn: false, owner: null });
    expect(await rejectCode(app.invoke('snapshot.get'))).toBe('unauthorized');
    const authLog = app.ctx.store.activity.search({ kinds: ['auth'], limit: 50 });
    expect(authLog.some((e) => e.level === 'warn' && e.text.includes(OTHER_B.email) && e.text.includes('거부'))).toBe(true);
    expect(app.core.auth.owner()?.sub).toBe(OWNER_A.sub);

    // 이메일 인증 안 된 계정 → 거부
    google.queue.push({ ...OWNER_A, emailVerified: false });
    expect(await rejectCode(app.invoke('auth.login'))).toBe('login_failed');

    // 대표(같은 sub, 이메일이 바뀌어도)는 다시 로그인된다
    google.queue.push({ ...OWNER_A, email: 'owner.renamed@example.com' });
    expect(await app.invoke('auth.login')).toMatchObject({ loggedIn: true, owner: { email: 'owner.renamed@example.com' } });

    // 재시작해도 대표 등록은 유지되어 다른 계정은 계속 거부된다
    await app.stop();
    const again = await boot({ dataDir, isPackaged: true, googleLogin: google.login, shell, stopScheduler: true, runnerMode: 'taskkill' });
    google.queue.push(OTHER_B);
    expect(await rejectCode(again.invoke('auth.login'))).toBe('forbidden');
    google.queue.push(OWNER_A);
    expect(await again.invoke('auth.login')).toMatchObject({ loggedIn: true });
  });

  it('AC-01: 패키징된 첫 실행(구글 설정 없음)에서도 로그인 전에 쓸 수 있는 경로만으로 구글 로그인을 설정하고, 대표 구글 계정으로 로그인해 홈이 열린다', async () => {
    const google = fakeGoogle();
    const app = await boot({ isPackaged: true, googleLogin: google.login, shell: fakeShell(), stopScheduler: true, runnerMode: 'taskkill' });
    const first = await app.invoke('auth.getState');
    expect([first.loggedIn, first.devLoginAllowed]).toEqual([false, false]); // 설치본: 개발 모드 로그인 없음
    // 어느 경로든 된다 (고치는 방식을 정하지 않는다): ① 로그인 화면 안내의 운영 설정 → 계정(settings.update)을 로그인 전에 쓸 수 있음
    // ② 로그인 전에 열린 설정용 메서드 ({clientId, clientSecret} 또는 (clientId, clientSecret)) ③ 설치본에 들어 있는 기본 클라이언트 ID
    const configured = async () => (await app.invoke('auth.getState')).googleConfigured;
    const tried: Record<string, string> = {};
    if (!(await configured())) tried['settings.update'] = await rejectCode(app.invoke('settings.update', { account: { googleClientId: CLIENT_ID } }));
    for (const m of IPC_METHODS.filter((x) => isPublicMethod(x) && !BASE_PUBLIC.has(x))) {
      for (const args of [[{ clientId: CLIENT_ID, clientSecret: GOOGLE_SECRET }], [CLIENT_ID, GOOGLE_SECRET]]) {
        if (await configured()) break;
        tried[`${m}(${typeof args[0] === 'string' ? '값' : '객체'})`] = await rejectCode(app.orch.backend.invoke(m, args as never));
      }
    }
    const googleConfigured = await configured();
    google.queue.push(OWNER_A);
    const login = await rejectCode(app.invoke('auth.login'));
    const home = await rejectCode(app.invoke('snapshot.get'));
    // 대표가 등록된 뒤에는 로그인하지 않고 구글 설정을 바꿀 수 없다 (다른 사람이 로그인 설정을 바꿔 대표를 막거나 우회하지 못하게)
    const clientIdBefore = app.ctx.settings().account.googleClientId;
    await app.invoke('auth.logout');
    const changeAfterOwner = await rejectCode(app.invoke('settings.update', { account: { googleClientId: 'intruder-client.apps.googleusercontent.com' } }));
    expect({ googleConfigured, login, home, changeAfterOwnerRefused: changeAfterOwner !== 'resolved', clientIdKept: app.ctx.settings().account.googleClientId === clientIdBefore, tried }).toEqual({
      googleConfigured: true,
      login: 'resolved',
      home: 'resolved',
      changeAfterOwnerRefused: true,
      clientIdKept: true,
      tried: expect.any(Object),
    });
  });

  it('AC-01: 개발 실행과 같은 앱 데이터 폴더를 쓰는 설치본에서는 남은 개발 모드 세션으로 홈이 열리지 않고, 대표 구글 계정으로 로그인해야 홈이 열리며 다른 구글 계정은 거부된다', async () => {
    const google = fakeGoogle();
    const dataDir = tempDir('data');
    dirs.push(dataDir);
    // 개발 실행: 개발 모드로 시작해 구글 설정을 넣고, 개발 모드 세션이 남은 채로 끝낸다
    const dev = await boot({ dataDir, isPackaged: false, googleLogin: google.login, shell: fakeShell(), stopScheduler: true, runnerMode: 'taskkill' });
    await dev.invoke('settings.update', { account: { googleClientId: CLIENT_ID } });
    await dev.stop();
    // 같은 데이터 폴더의 설치본
    const app = await boot({ dataDir, isPackaged: true, googleLogin: google.login, shell: fakeShell(), stopScheduler: true, runnerMode: 'taskkill' });
    const before = await app.invoke('auth.getState');
    const homeBeforeLogin = await rejectCode(app.invoke('snapshot.get'));
    google.queue.push(OWNER_A);
    const login = await rejectCode(app.invoke('auth.login'));
    const home = await rejectCode(app.invoke('snapshot.get'));
    await app.invoke('auth.logout');
    google.queue.push(OTHER_B);
    const other = await rejectCode(app.invoke('auth.login'));
    expect({ loggedInBefore: before.loggedIn, homeBeforeLogin, login, home, other }).toEqual({
      loggedInBefore: false,
      homeBeforeLogin: 'unauthorized',
      login: 'resolved',
      home: 'resolved',
      other: 'forbidden',
    });
  });

  it('AC-01: 로그인 화면 안내대로 개발 모드로 시작해 구글 설정(클라이언트 ID·보안 비밀)을 등록하면, 그 뒤 대표의 구글 계정으로 로그인해 홈이 열리고 다른 구글 계정은 거부된다', async () => {
    const google = fakeGoogle();
    const app = await boot({ isPackaged: false, googleLogin: google.login, shell: fakeShell(), stopScheduler: true, runnerMode: 'taskkill' });
    // bootApp가 개발 모드 로그인을 했다 (App.tsx 안내: "개발 모드로 시작한 뒤 운영 설정 → 계정에서 OAuth 클라이언트 ID와 보안 비밀을 등록")
    await app.invoke('settings.update', { account: { googleClientId: CLIENT_ID } });
    await app.invoke('settings.setGoogleSecret', GOOGLE_SECRET);
    await app.invoke('auth.logout');
    google.queue.push(OWNER_A);
    let ownerError = '';
    const st = await app.invoke('auth.login').catch((e: Error) => {
      ownerError = e.message;
      return null;
    });
    const home = await rejectCode(app.invoke('snapshot.get'));
    await app.invoke('auth.logout');
    google.queue.push(OTHER_B);
    const other = await rejectCode(app.invoke('auth.login'));
    expect({ ownerError, loggedIn: st?.loggedIn ?? false, owner: st?.owner?.email ?? null, home, other }).toEqual({
      ownerError: '',
      loggedIn: true,
      owner: OWNER_A.email,
      home: 'resolved',
      other: 'forbidden',
    });
  });
});

// ═════════════════════════ AC-02 ═════════════════════════

describe('AC-02 프로그램이 실행 중일 때 다른 기기에서 접속할 수 있는 열린 포트가 없다', () => {
  it('AC-02: 실행 중(앱 도구 서버·CLI 턴·구글 로그인 대기) 이 프로세스와 하위 프로세스가 연 수신 포트는 모두 루프백뿐이고, 이 PC의 다른 주소로는 접속되지 않는다', async () => {
    const app = await boot({});
    const url = new URL(app.core.toolServer.url!);
    expect(url.hostname).toBe('127.0.0.1');
    const toolPort = Number(url.port);

    // CLI 턴이 도는 동안 (응답 없음 시나리오로 턴을 살려 둔다)
    const p = await addProject(app, { team: ['developer'], scenarios: { developer: 'hang' } });
    await sendCommand(app, p.id, '로그인 화면을 만들어 줘');
    await waitFor(() => app.core.turns.isMemberRunning(p.members.developer!), '개발자 턴 실행');
    await sleep(300);
    const tree = processTree(process.pid);
    expect(tree.length).toBeGreaterThan(1); // 러너·모의 에이전트가 하위 프로세스로 떠 있다
    const during = listeners(tree);
    expect(during.some((l) => l.proto === 'TCP' && l.port === toolPort && l.pid === process.pid)).toBe(true);
    expect(during.filter((l) => !isLoopback(l.address))).toEqual([]);

    // 구글 로그인용 임시 주소 (시스템 브라우저 결과를 받는 곳)
    const abort = new AbortController();
    let authUrl = '';
    const pending = googleLogin({ clientId: CLIENT_ID, clientSecret: null, openExternal: async (u) => void (authUrl = u), signal: abort.signal, timeoutMs: 60_000 }).catch((e: Error) => e);
    await waitFor(() => authUrl !== '', '로그인 주소');
    const redirect = new URL(new URL(authUrl).searchParams.get('redirect_uri')!);
    expect(redirect.hostname).toBe('127.0.0.1');
    const loginPort = Number(redirect.port);
    const withLogin = listeners([process.pid]);
    expect(withLogin.some((l) => l.proto === 'TCP' && l.port === loginPort)).toBe(true);
    expect(withLogin.filter((l) => !isLoopback(l.address))).toEqual([]);

    // 다른 기기에서 쓰는 이 PC의 주소로는 두 포트 모두 접속되지 않는다 (루프백으로는 된다)
    expect(await canConnect('127.0.0.1', toolPort)).toBe(true);
    for (const addr of lanAddresses()) {
      expect(await canConnect(addr, toolPort), `${addr}:${toolPort}`).toBe(false);
      expect(await canConnect(addr, loginPort), `${addr}:${loginPort}`).toBe(false);
    }
    abort.abort();
    expect(await pending).toMatchObject({ code: 'cancelled' });
    dirs.push(p.root);
  }, 90_000);
});

// ───────────────────────── 두 프로젝트 고정 장면 (턴 없이 앱 도구 경계만) ─────────────────────────

interface Two {
  app: App;
  A: Awaited<ReturnType<typeof addProject>>;
  B: Awaited<ReturnType<typeof addProject>>;
  dA: string;
  dB: string;
  tA1: string;
  tA2: string;
  tB1: string;
}

/** 프로젝트 A(프로듀서·개발자·QA[·QA2]), B(프로듀서·개발자). 지시 dA·dB, 작업 tA1(A 개발자)·tA2(A QA)·tB1(B 개발자) */
async function twoProjects(o: { qa2?: boolean; boot?: Parameters<typeof bootApp>[0] } = {}): Promise<Two> {
  const app = await boot({ stopScheduler: true, runnerMode: 'taskkill', ...(o.boot ?? {}) });
  const A = await addProject(app, { name: '프로젝트A', team: o.qa2 ? ['developer', 'qa', 'qa'] : ['developer', 'qa'], mock: false });
  const B = await addProject(app, { name: '프로젝트B', team: ['developer'], mock: false });
  dirs.push(A.root, B.root);
  const { core } = app;
  const dA = core.directives.register({ projectId: A.id, title: 'A 지시', text: 'A 지시' }, MAIN_AGENT_ID, null).id;
  const dB = core.directives.register({ projectId: B.id, title: 'B 지시', text: 'B 지시' }, MAIN_AGENT_ID, null).id;
  const mk = (directiveId: string, assigneeId: string, by: string, type: 'development' | 'test' = 'development') =>
    core.tasks.create({ directiveId, title: `${type} 작업`, goal: '목표', type, assigneeId, reviewerId: null, acceptanceCriteria: ['동작한다'], outputMode: 'repo' }, by).id;
  const tA1 = mk(dA, A.members.developer!, A.producerId);
  const tA2 = mk(dA, A.members.qa!, A.producerId, 'test');
  const tB1 = mk(dB, B.members.developer!, B.producerId);
  return { app, A, B, dA, dB, tA1, tA2, tB1 };
}

/** 작업을 활성화 → 파일 변경 → 단계 완료 → 제출 처리까지 (검수 상태, 대상 고정) */
async function toReview(app: App, taskId: string): Promise<void> {
  const { core, ctx } = app;
  expect(await core.tasks.activateForLaunch(taskId)).toBe(true);
  for (const q of ctx.store.queue.list({ ref2: `task:${taskId}`, state: 'queued' })) ctx.store.queue.put({ ...q, state: 'done', doneAt: ctx.now() });
  core.tasks.setSteps(taskId, ['단계 1']);
  const t = ctx.store.tasks.require(taskId);
  const m = ctx.store.members.require(t.assigneeId);
  writeFileSync(join(t.workspace!.worktreePath, `${taskId}.txt`), `${taskId} 변경\n`, 'utf8');
  await core.tasks.completeStep(taskId, 0, '완료', m, null);
  core.tasks.requestSubmit(taskId, '제출', m);
  await core.tasks.processSubmission(taskId);
  expect(ctx.store.tasks.require(taskId).state).toBe('in_review');
}

const PASS_ARGS = (taskId: string) => ({ task_id: taskId, verdict: 'pass', criteria: [{ criterion: '동작한다', pass: true, note: '확인' }], reason: '' });

/** 호출들을 차례로 보내고 결과를 모은다 */
async function callAll(app: App, token: string | null, calls: [string, Record<string, unknown>][]) {
  const out: { name: string; ok: boolean; code?: string; message?: string }[] = [];
  for (const [name, args] of calls) {
    const r = await callTool(app, token, name, args);
    out.push({ name, ok: r.ok, code: r.code, message: r.message });
  }
  return out;
}

/** 그 팀원 이름으로 각 도구의 거부 기록(활동 기록 app_tool, 경고, 사유)이 남았는지 */
function expectLogged(app: App, memberId: string | null, tools: string[]): void {
  const rej = toolRejections(app).filter((r) => r.memberId === memberId);
  const missing = tools.filter((t) => !rej.some((r) => r.tool === t && r.level === 'warn' && !!r.result));
  expect(missing, '거부 기록이 없는 도구').toEqual([]);
}

// ═════════════════════════ AC-18 ═════════════════════════

describe('AC-18 앱 도구로 다른 팀원·프로젝트의 파일 변경이나 담당 범위를 벗어난 조작을 요청하면 거부·기록된다', () => {
  it('AC-18: 프로듀서가 다른 프로젝트의 작업·지시·팀원을 바꾸려는 요청은 거부·기록되고 그 프로젝트는 바뀌지 않는다', async () => {
    const f = await twoProjects();
    const pa = tokenFor(f.app, f.A.producerId, `directive:${f.dA}`);
    const before = f.app.ctx.store.tasks.require(f.tB1);
    const calls: [string, Record<string, unknown>][] = [
      ['update_task', { task_id: f.tB1, priority: 'urgent', goal: '다른 프로젝트 목표 바꾸기' }],
      ['cancel_task', { task_id: f.tB1, reason: '취소 시도' }],
      ['assign_reviewer', { task_id: f.tB1, reviewer_id: 'main' }],
      ['request_merge', { task_id: f.tB1 }],
      ['request_revert', { task_id: f.tB1, reason: '되돌리기 시도' }],
      ['resolve_hold', { task_id: f.tB1, kind: 'blocked', note: '해제 시도' }],
      ['replan_task', { task_id: f.tB1, note: '재계획 시도' }],
      ['create_task', { directive_id: f.dB, title: '끼워 넣기', goal: '다른 프로젝트 작업 추가', type: 'development', assignee_id: f.B.members.developer, acceptance_criteria: ['된다'], output_mode: 'repo' }],
      ['submit_final_result', { directive_id: f.dB, summary: '남의 지시 결과 제출' }],
      ['send_message', { to: f.B.members.developer, text: '다른 프로젝트 팀원에게 지시' }],
    ];
    const res = await callAll(f.app, pa, calls);
    expect(res.map((r) => [r.name, r.ok, r.code])).toEqual(calls.map(([n]) => [n, false, 'forbidden']));
    expectLogged(f.app, f.A.producerId, calls.map(([n]) => n));
    const after = f.app.ctx.store.tasks.require(f.tB1);
    expect({ state: after.state, priority: after.priority, goal: after.goal, reviewerId: after.reviewerId, hold: after.hold.reasons.length }).toEqual({
      state: before.state,
      priority: before.priority,
      goal: before.goal,
      reviewerId: before.reviewerId,
      hold: 0,
    });
    expect(f.app.ctx.store.tasks.list({ ref1: f.dB })).toHaveLength(1);
    expect(f.app.ctx.store.directives.require(f.dB).state).toBe('planning');
    expect(f.app.ctx.store.queue.list().filter((q) => q.memberId === f.B.members.developer && q.kind === 'message')).toEqual([]);
  });

  it('AC-18: 다른 프로젝트 팀원을 담당자·검수자로 넣는 요청은 거부·기록되고 배정이 바뀌지 않는다', async () => {
    const f = await twoProjects();
    const pa = tokenFor(f.app, f.A.producerId, `directive:${f.dA}`);
    const base = { directive_id: f.dA, title: '배정 시험', goal: '배정', type: 'development', acceptance_criteria: ['된다'], output_mode: 'repo' };
    const calls: [string, Record<string, unknown>][] = [
      ['create_task', { ...base, assignee_id: f.B.members.developer }],
      ['create_task', { ...base, assignee_id: f.A.members.developer, reviewer_id: f.B.producerId }],
      ['update_task', { task_id: f.tA1, assignee_id: f.B.members.developer }],
      ['update_task', { task_id: f.tA1, reviewer_id: f.B.producerId }],
      ['assign_reviewer', { task_id: f.tA1, reviewer_id: f.B.producerId }],
    ];
    const res = await callAll(f.app, pa, calls);
    expect(res.filter((r) => r.ok)).toEqual([]);
    expectLogged(f.app, f.A.producerId, ['create_task', 'update_task', 'assign_reviewer']);
    const t = f.app.ctx.store.tasks.require(f.tA1);
    expect({ assignee: t.assigneeId, reviewer: t.reviewerId }).toEqual({ assignee: f.A.members.developer, reviewer: f.A.producerId });
    expect(f.app.ctx.store.tasks.list({ ref1: f.dA })).toHaveLength(2);
  });

  it('AC-18: 다른 팀원에게 재배정된 작업의 작업 폴더를 이전 담당자가 바꾸려는 요청은 거부·기록되고 커밋되지 않는다', async () => {
    const f = await twoProjects();
    const { app } = f;
    expect(await app.core.tasks.activateForLaunch(f.tA1)).toBe(true);
    app.core.tasks.setSteps(f.tA1, ['단계 1', '단계 2']);
    const ws = app.ctx.store.tasks.require(f.tA1).workspace!;
    const da = tokenFor(app, f.A.members.developer!, `task:${f.tA1}`);
    const pa = tokenFor(app, f.A.producerId, `directive:${f.dA}`);
    expect((await callTool(app, pa, 'update_task', { task_id: f.tA1, assignee_id: f.A.members.qa })).ok).toBe(true);
    const head = execFileSync('git', ['-C', f.A.dir, 'rev-parse', `refs/heads/${ws.branch}`], { encoding: 'utf8' }).trim();
    if (existsSync(ws.worktreePath)) writeFileSync(join(ws.worktreePath, 'stale-change.txt'), '이전 담당자의 변경\n', 'utf8');
    const calls: [string, Record<string, unknown>][] = [
      ['complete_step', { step_index: 0, note: '이전 담당자' }],
      ['set_steps', { steps: ['바꿔치기'] }],
      ['add_steps', { steps: ['추가'] }],
      ['submit_for_review', { note: '제출 시도' }],
      ['report_conflict_resolved', { note: '충돌 해결 시도' }],
      ['report_blocked', { reason: '막힘 시도' }],
      ['ask_producer', { question: '질문 시도' }],
    ];
    const res = await callAll(app, da, calls);
    expect(res.map((r) => [r.name, r.code])).toEqual(calls.map(([n]) => [n, 'forbidden']));
    expect(res.every((r) => r.message?.includes('담당자가 아닙니다'))).toBe(true);
    expectLogged(app, f.A.members.developer!, calls.map(([n]) => n));
    expect(execFileSync('git', ['-C', f.A.dir, 'rev-parse', `refs/heads/${ws.branch}`], { encoding: 'utf8' }).trim()).toBe(head);
    expect(app.ctx.store.steps.list(f.tA1).map((s) => [s.title, s.done])).toEqual([
      ['단계 1', false],
      ['단계 2', false],
    ]);
    expect(app.ctx.store.questions.list()).toEqual([]);
  });

  it('AC-18: 팀원이 프로듀서·메인 에이전트 범위의 조작(작업 생성·병합·취소·검수자 배정·팀원 추가·삭제·프로젝트 생성·지시·기억 수정·직접 지시)을 요청하면 거부·기록되고 아무것도 바뀌지 않는다', async () => {
    const f = await twoProjects();
    const { app } = f;
    const da = tokenFor(app, f.A.members.developer!, `task:${f.tA1}`);
    const qa = tokenFor(app, f.A.members.qa!, `review:${f.tA1}`);
    const memoryBefore = app.core.memory.read(f.A.id);
    const evil = tempDir('evil');
    dirs.push(evil);
    const newDir = join(evil, 'p');
    const calls: [string, Record<string, unknown>][] = [
      ['create_task', { directive_id: f.dA, title: '스스로 작업 만들기', goal: '권한 밖', type: 'development', assignee_id: f.A.members.developer, acceptance_criteria: ['된다'], output_mode: 'repo' }],
      ['request_merge', { task_id: f.tA2 }],
      ['cancel_task', { task_id: f.tA2, reason: '남의 작업 취소' }],
      ['assign_reviewer', { task_id: f.tA1, reviewer_id: f.A.members.developer }],
      ['remove_member', { member_id: f.A.members.qa }],
      ['add_member', { project_id: f.A.id, role_id: 'developer' }],
      ['create_project', { name: '몰래 프로젝트', path: newDir, mode: 'new' }],
      ['register_directive', { project_id: f.A.id, title: '스스로 지시', text: '권한 밖 지시' }],
      ['write_memory', { project_id: f.A.id, content: '기억 덮어쓰기' }],
      ['instruct_member', { member_id: f.A.members.qa, text: '직접 지시' }],
    ];
    const resDev = await callAll(app, da, calls);
    const resQa = await callAll(app, qa, calls);
    expect(resDev.map((r) => [r.name, r.code])).toEqual(calls.map(([n]) => [n, 'forbidden']));
    expect(resQa.map((r) => [r.name, r.code])).toEqual(calls.map(([n]) => [n, 'forbidden']));
    expectLogged(app, f.A.members.developer!, calls.map(([n]) => n));
    expectLogged(app, f.A.members.qa!, calls.map(([n]) => n));
    expect(app.ctx.store.members.require(f.A.members.qa!).deletedAt).toBeNull();
    expect(app.ctx.store.tasks.require(f.tA2).state).toBe('waiting');
    expect(app.ctx.store.tasks.require(f.tA1).reviewerId).toBe(f.A.producerId);
    expect(app.ctx.store.projects.list()).toHaveLength(2);
    expect(app.ctx.store.directives.list()).toHaveLength(2);
    expect(app.ctx.store.members.list({ project_id: f.A.id, state: 'active' })).toHaveLength(3);
    expect(existsSync(newDir)).toBe(false);
    expect(app.core.memory.read(f.A.id)).toBe(memoryBefore);
  });

  it('AC-18: 일반 팀원이 프로듀서를 거치지 않고 다른 팀원·다른 프로젝트에 메시지로 지시하면 거부·기록된다 (자기 프로듀서에게는 보낼 수 있다)', async () => {
    const f = await twoProjects();
    const { app } = f;
    await app.core.tasks.activateForLaunch(f.tA1);
    const da = tokenFor(app, f.A.members.developer!, `task:${f.tA1}`);
    const res = await callAll(app, da, [
      ['send_message', { to: f.A.members.qa, text: 'QA에게 직접 지시' }],
      ['send_message', { to: f.B.members.developer, text: '다른 프로젝트 개발자에게' }],
      ['send_message', { to: f.B.producerId, text: '다른 프로젝트 프로듀서에게' }],
    ]);
    expect(res.map((r) => r.code)).toEqual(['forbidden', 'forbidden', 'forbidden']);
    expect(toolRejections(app).filter((r) => r.memberId === f.A.members.developer && r.tool === 'send_message' && r.level === 'warn')).toHaveLength(3);
    expect((await callTool(app, da, 'send_message', { to: 'producer', text: '진행 상황 공유' })).ok).toBe(true);
  });

  it('AC-18: 메인 에이전트가 다른 팀원의 작업 폴더(앱이 관리하는 worktree)를 새 프로젝트로 등록해 그 팀원의 브랜치를 바꿀 수 있게 하는 요청은 거부·기록된다', async () => {
    const f = await twoProjects();
    const { app } = f;
    expect(await app.core.tasks.activateForLaunch(f.tA1)).toBe(true);
    const ws = app.ctx.store.tasks.require(f.tA1).workspace!;
    const main = mainToken(app, null);
    const branchHead = () => execFileSync('git', ['-C', f.A.dir, 'rev-parse', `refs/heads/${ws.branch}`], { encoding: 'utf8' }).trim();
    const head0 = branchHead();
    const r = await callTool(app, main, 'create_project', { name: '남의 작업 폴더', path: ws.worktreePath, mode: 'existing' });
    const registered = app.ctx.store.projects.list().find((p) => p.path.toLowerCase() === ws.worktreePath.toLowerCase()) ?? null;
    // 등록됐다면 그 결과를 끝까지 따라가 본다: 새 프로젝트의 작업을 병합하면 개발자 A의 작업 브랜치·작업 폴더가 바뀌는가
    let foreignFile: string | null = null;
    if (registered) {
      const { core, ctx } = app;
      const d3 = core.directives.register({ projectId: registered.id, title: '끼어들기', text: '끼어들기' }, MAIN_AGENT_ID, null).id;
      const t3 = core.tasks.create({ directiveId: d3, title: '남의 브랜치에 병합', goal: 'x', type: 'development', assigneeId: registered.producerId, reviewerId: 'main', acceptanceCriteria: ['x'], outputMode: 'repo' }, registered.producerId).id;
      await toReview(app, t3);
      core.tasks.submitReview(t3, ctx.store.members.require(MAIN_AGENT_ID), { verdict: 'pass', criteria: [{ criterion: 'x', pass: true, note: '' }], reason: '' }, null);
      core.merges.requestMerge(t3, ctx.store.members.require(registered.producerId), null);
      await waitFor(() => !core.merges.isPending(t3), '병합 처리');
      foreignFile = existsSync(join(ws.worktreePath, `${t3}.txt`)) ? `${t3}.txt` : null;
    }
    expect({
      refused: !r.ok,
      registered: registered ? `${registered.id} 기준 브랜치 ${registered.baseBranch}` : null,
      developerBranchMoved: branchHead() !== head0,
      foreignFileInDeveloperFolder: foreignFile,
    }).toEqual({ refused: true, registered: null, developerBranchMoved: false, foreignFileInDeveloperFolder: null });
    expectLogged(app, MAIN_AGENT_ID, ['create_project']);
  });

  it('AC-18: 메인 에이전트가 다른 팀원의 작업 폴더(앱이 관리하는 worktree)를 프로젝트로 등록하려 하면 거부·기록되고, 그 팀원이 작업 중인 파일과 작업 브랜치는 바뀌지 않는다', async () => {
    const f = await twoProjects();
    const { app } = f;
    expect(await app.core.tasks.activateForLaunch(f.tA1)).toBe(true);
    const ws = app.ctx.store.tasks.require(f.tA1).workspace!;
    // 개발자 A가 작업 중 CLAUDE.md를 고쳐 두었다 (아직 커밋 전)
    const mine = '# 개발자 A의 작업 메모\n로그인 화면은 파란색 버튼\n';
    writeFileSync(join(ws.worktreePath, 'CLAUDE.md'), mine, 'utf8');
    const head0 = revParse(f.A.dir, `refs/heads/${ws.branch}`);
    const seq0 = lastSeq(app);
    const r = await callTool(app, mainToken(app, null), 'create_project', { name: '남의 작업 폴더', path: ws.worktreePath, mode: 'existing' });
    expect({
      refused: !r.ok,
      registered: app.ctx.store.projects.list().some((p) => samePath(p.path, ws.worktreePath)),
      developerBranchMoved: revParse(f.A.dir, `refs/heads/${ws.branch}`) !== head0,
      developerFile: readFileSync(join(ws.worktreePath, 'CLAUDE.md'), 'utf8'),
      unlogged: unloggedRefusals(app, seq0, MAIN_AGENT_ID, ['create_project']),
    }).toEqual({ refused: true, registered: false, developerBranchMoved: false, developerFile: mine, unlogged: [] });
  });

  it('AC-18: 프로듀서가 팀원에게 배정된 작업의 단계 완료(프로그램 커밋)·단계 변경·제출·충돌 해결 보고를 대신 요청하면 거부·기록되고, 그 팀원의 작업 폴더·단계는 그대로다', async () => {
    const f = await twoProjects();
    const { app, A } = f;
    expect(await app.core.tasks.activateForLaunch(f.tA1)).toBe(true);
    app.core.tasks.setSteps(f.tA1, ['단계 1']);
    const ws = app.ctx.store.tasks.require(f.tA1).workspace!;
    writeFileSync(join(ws.worktreePath, 'dev-work.txt'), '개발자 작업 중\n', 'utf8');
    const head0 = revParse(A.dir, `refs/heads/${ws.branch}`);
    const pa = tokenFor(app, A.producerId, `directive:${f.dA}`);
    const calls: [string, Record<string, unknown>][] = [
      ['complete_step', { step_index: 0, note: '대신 완료' }],
      ['set_steps', { steps: ['바꿔치기'] }],
      ['submit_for_review', { note: '대신 제출' }],
      ['report_conflict_resolved', { note: '대신 보고' }],
    ];
    const res = await callAll(app, pa, calls);
    expect(res.map((r) => [r.name, r.code])).toEqual(calls.map(([n]) => [n, 'forbidden']));
    expectLogged(app, A.producerId, calls.map(([n]) => n));
    expect(revParse(A.dir, `refs/heads/${ws.branch}`)).toBe(head0);
    expect(app.ctx.store.steps.list(f.tA1).map((s) => [s.title, s.done])).toEqual([['단계 1', false]]);
    expect(app.ctx.store.tasks.require(f.tA1).pendingSubmit).toBeNull();
  });

  it('AC-18: 기억 도구의 project_id로 앱 데이터 밖이나 없는 프로젝트의 파일을 만들 수 없다 (SEC-02)', async () => {
    const f = await twoProjects();
    const { app } = f;
    const main = mainToken(app, f.A.id);
    const res = await callAll(app, main, [
      ['write_memory', { project_id: '..\\..\\..\\escape', content: '탈출 시험' }],
      ['write_memory', { project_id: '../../escape', content: '탈출 시험' }],
      ['read_memory', { project_id: '..\\x' }],
      ['write_memory', { project_id: 'P-9999', content: '없는 프로젝트' }],
    ]);
    expect(res.map((r) => r.code)).toEqual(['not_found', 'not_found', 'not_found', 'not_found']);
    expectLogged(app, MAIN_AGENT_ID, ['write_memory', 'read_memory']);
    expect(scanFiles(app.dataDir, ['탈출 시험', '없는 프로젝트'])).toEqual([]);
    expect(existsSync(join(app.dataDir, '..', 'escape.md'))).toBe(false);
  });
});

// ═════════════════════════ AC-19 ═════════════════════════

describe('AC-19 실행 권한 승인 화면·승인 타이머 없이 작업이 진행되고, 앱 금지 정책·잘못된 역할·본인 검수·정지 중 실행 요청은 앱 도구에서 거부·기록된다', () => {
  it('AC-19: 실행 권한 승인을 요청하는 앱 도구·화면 메서드·설정(타이머)·상태·업무 종류가 없다 (결과 승인만 있다)', async () => {
    const { TASK_STATE_LABEL, HOLD_REASON_LABEL, MEMBER_STATUS_LABEL, WORK_KIND_LABEL, DIRECTIVE_STATE_LABEL } = await import('@shared/labels');
    const { defaultSettings } = await import('../../src/main/orchestrator/defaults');
    const approvalish = /approv|permission|grant|consent|authoriz/i;
    expect(TOOL_SPECS.map((t) => t.name).filter((n) => approvalish.test(n))).toEqual([]);
    expect(TOOL_SPECS.map((t) => t.description).filter((d) => /승인 요청|승인을 요청|허가를 요청/.test(d))).toEqual([]);
    expect(IPC_METHODS.filter((m) => approvalish.test(m))).toEqual(['reports.approve']); // 결과 승인 (FBK-01, 사후 확인)
    const keys: string[] = [];
    const walk = (o: unknown, path: string) => {
      if (o && typeof o === 'object' && !Array.isArray(o)) for (const [k, v] of Object.entries(o)) walk(v, path ? `${path}.${k}` : k);
      else keys.push(path);
    };
    walk(defaultSettings(), '');
    expect(keys.filter((k) => approvalish.test(k))).toEqual([]);
    const labels = [TASK_STATE_LABEL, HOLD_REASON_LABEL, MEMBER_STATUS_LABEL, WORK_KIND_LABEL, DIRECTIVE_STATE_LABEL].flatMap((m) => Object.values(m));
    expect(labels.filter((l) => /승인|허가/.test(l))).toEqual([]);
  });

  it('AC-19: 대표의 실행 승인 없이 모의 팀이 지시를 끝까지 처리하고, 그동안 승인 대기·승인 요청·보류가 한 번도 생기지 않는다', async () => {
    const app = await boot({});
    const p = await addProject(app, { team: ['developer', 'qa'] });
    dirs.push(p.root);
    const did = await sendCommand(app, p.id, '로그인 화면을 만들어 줘');
    await waitFor(() => app.ctx.store.directives.get(did)?.state === 'awaiting_confirmation', '보고 도착', 120_000);
    await waitFor(() => app.core.turns.count() === 0, '턴 종료');
    type Snap = { ownerTodos: { kind: string }[]; tasks: { hold: { reasons: { kind: string }[] } | null }[] };
    const snaps = app.pushed.filter((x) => x.topic === 'snapshot').map((x) => x.payload as Snap);
    expect(snaps.length).toBeGreaterThan(3);
    expect([...new Set(snaps.flatMap((s) => s.ownerTodos.map((t) => t.kind)))].filter((k) => k !== 'unread_report')).toEqual([]);
    expect([...new Set(snaps.flatMap((s) => s.tasks.flatMap((t) => t.hold?.reasons.map((r) => r.kind) ?? [])))]).toEqual([]);
    expect(app.ctx.store.notifications.list().filter((n) => /승인|허가|권한/.test(`${n.title} ${n.body}`))).toEqual([]);
    const turns = app.ctx.store.turns.list();
    expect(turns.length).toBeGreaterThan(4);
    expect(turns.filter((t) => t.bypass === 'mismatch' || t.endReason !== 'completed').map((t) => `${t.id} ${t.bypass} ${t.endReason}`)).toEqual([]);
    expect(app.ctx.store.tasks.list({ ref1: did }).every((t) => t.state === 'done')).toBe(true);
  }, 150_000);

  it('AC-19: 잘못된 역할의 요청은 앱 도구에서 거부되고 기록되며, 거부가 대표 실행 승인 요청으로 바뀌지 않는다', async () => {
    const f = await twoProjects();
    const { app } = f;
    const todosBefore = (await app.invoke('snapshot.get')).ownerTodos.length;
    const notesBefore = app.ctx.store.notifications.list().length;
    const da = tokenFor(app, f.A.members.developer!, `task:${f.tA1}`);
    const main = mainToken(app, f.A.id);
    const pa = tokenFor(app, f.A.producerId, `directive:${f.dA}`);
    const qa = tokenFor(app, f.A.members.qa!, `review:${f.tA1}`);
    const create = { directive_id: f.dA, title: 'x', goal: 'x', type: 'development', assignee_id: f.A.members.developer, acceptance_criteria: ['x'], output_mode: 'repo' };
    const r1 = await callAll(app, da, [['create_task', create]]);
    const r2 = await callAll(app, main, [
      ['complete_step', { step_index: 0 }],
      ['submit_review', PASS_ARGS(f.tA1)],
      ['create_task', create],
    ]);
    const r3 = await callAll(app, pa, [
      ['create_project', { name: 'x', path: join(app.dataDir, 'nope'), mode: 'new' }],
      ['write_memory', { content: 'x' }],
    ]);
    const r4 = await callAll(app, qa, [
      ['request_merge', { task_id: f.tA1 }],
      ['answer_question', { question_id: 'Q-0001', answer: 'x' }],
    ]);
    const all = [...r1, ...r2, ...r3, ...r4];
    expect(all.map((r) => `${r.name}:${r.code}`)).toEqual([
      'create_task:forbidden',
      'complete_step:forbidden',
      'submit_review:forbidden',
      'create_task:forbidden',
      'create_project:forbidden',
      'write_memory:forbidden',
      'request_merge:forbidden',
      'answer_question:forbidden',
    ]);
    for (const r of all) expect(r.message).toContain('역할');
    expectLogged(app, f.A.members.developer!, ['create_task']);
    expectLogged(app, MAIN_AGENT_ID, ['complete_step', 'submit_review', 'create_task']);
    expectLogged(app, f.A.producerId, ['create_project', 'write_memory']);
    expectLogged(app, f.A.members.qa!, ['request_merge', 'answer_question']);
    expect((await app.invoke('snapshot.get')).ownerTodos.length).toBe(todosBefore);
    expect(app.ctx.store.notifications.list().length).toBe(notesBefore);
  });

  it('AC-19: 본인 검수 요청(작업자 본인·실질 수정 참여자·자기 자신을 검수자로 지정)은 거부되고 기록되며 판정이 남지 않는다', async () => {
    const f = await twoProjects({ qa2: true });
    const { app, A } = f;
    const pa = tokenFor(app, A.producerId, `directive:${f.dA}`);
    // (1) QA가 자기 작업 tA2를 검수
    await toReview(app, f.tA2);
    const qaOwn = tokenFor(app, A.members.qa!, `review:${f.tA2}`);
    const own = await callAll(app, qaOwn, [
      ['get_review_target', { task_id: f.tA2 }],
      ['submit_review', PASS_ARGS(f.tA2)],
    ]);
    // (2) 프로듀서가 직접 맡은 작업에 자기 자신을 검수자로
    const tA3 = app.core.tasks.create({ directiveId: f.dA, title: '프로듀서 직접 작업', goal: '직접', type: 'development', assigneeId: A.producerId, reviewerId: null, acceptanceCriteria: ['된다'], outputMode: 'repo' }, A.producerId).id;
    expect(app.ctx.store.tasks.require(tA3).reviewerId).not.toBe(A.producerId);
    const selfAssign = await callAll(app, pa, [
      ['assign_reviewer', { task_id: tA3, reviewer_id: A.producerId }],
      ['update_task', { task_id: tA3, reviewer_id: A.producerId }],
      ['create_task', { directive_id: f.dA, title: '자기 검수', goal: 'x', type: 'development', assignee_id: A.producerId, reviewer_id: A.producerId, acceptance_criteria: ['x'], output_mode: 'repo' }],
    ]);
    // (3) 검수자로 배정된 QA2가 그 작업의 충돌을 직접 고쳐 실질 수정 참여자가 된 경우 (GIT-07)
    await toReview(app, f.tA1);
    expect((await callTool(app, pa, 'assign_reviewer', { task_id: f.tA1, reviewer_id: A.members.qa2 })).ok).toBe(true);
    const t1 = app.ctx.store.tasks.require(f.tA1);
    app.ctx.store.tasks.patch(f.tA1, { contributors: [...t1.contributors, A.members.qa2!] });
    const qa2 = tokenFor(app, A.members.qa2!, `review:${f.tA1}`);
    const contributor = await callAll(app, qa2, [['submit_review', PASS_ARGS(f.tA1)]]);

    expect([...own, ...selfAssign, ...contributor].map((r) => `${r.name}:${r.ok}:${r.code}`)).toEqual([
      'get_review_target:false:forbidden',
      'submit_review:false:forbidden',
      'assign_reviewer:false:forbidden',
      'update_task:false:forbidden',
      'create_task:false:forbidden',
      'submit_review:false:forbidden',
    ]);
    expect(contributor[0]!.message).toContain('작업자 또는 실질 수정 참여자');
    expect(selfAssign[0]!.message).toContain('작업자 또는 실질 수정 참여자');
    expectLogged(app, A.members.qa!, ['get_review_target', 'submit_review']);
    expectLogged(app, A.producerId, ['assign_reviewer', 'update_task', 'create_task']);
    expectLogged(app, A.members.qa2!, ['submit_review']);
    expect(app.ctx.store.reviews.list()).toEqual([]);
    expect([f.tA1, f.tA2].map((id) => app.ctx.store.tasks.require(id).review.passed)).toEqual([null, null]);
  });

  it('AC-19: 정지 중(긴급 정지·프로젝트 일시정지·팀원 일시정지) 실행 요청은 앱 도구에서 거부·기록되고, 정지와 무관한 범위는 막지 않는다', async () => {
    const f = await twoProjects();
    const { app, A, B } = f;
    await toReview(app, f.tA1);
    const pa = tokenFor(app, A.producerId, `directive:${f.dA}`);
    const pb = tokenFor(app, B.producerId, `directive:${f.dB}`);
    const da = tokenFor(app, A.members.developer!, `task:${f.tA1}`);
    const main = mainToken(app, A.id);
    const create = { directive_id: f.dA, title: '정지 중 작업', goal: 'x', type: 'development', assignee_id: A.members.developer, acceptance_criteria: ['x'], output_mode: 'repo' };

    await app.invoke('stop.emergency');
    const emergency = [
      ...(await callAll(app, pa, [
        ['create_task', create],
        ['request_merge', { task_id: f.tA1 }],
        ['submit_review', PASS_ARGS(f.tA1)],
      ])),
      ...(await callAll(app, da, [
        ['set_steps', { steps: ['x'] }],
        ['submit_for_review', {}],
      ])),
      ...(await callAll(app, main, [['register_directive', { project_id: A.id, title: '정지 중 지시', text: 'x' }]])),
    ];
    const readOnly = await callTool(app, pa, 'get_work_context', {});
    await app.invoke('stop.release');

    await app.main('pause_project', { project_id: A.id, mode: 'immediate' });
    const projectPause = [
      ...(await callAll(app, pa, [
        ['create_task', create],
        ['assign_reviewer', { task_id: f.tA1, reviewer_id: 'main' }],
      ])),
      ...(await callAll(app, da, [['send_message', { to: 'producer', text: 'x' }]])),
    ];
    const otherProject = await callTool(app, pb, 'update_task', { task_id: f.tB1, priority: 'high' });
    await app.main('resume_project', { project_id: A.id });

    await app.main('pause_member', { member_id: A.members.developer!, mode: 'immediate' });
    const memberPause = await callAll(app, da, [['ask_producer', { question: '정지 중 질문' }]]);
    const otherMember = await callTool(app, pa, 'update_task', { task_id: f.tA2, priority: 'high' });
    await app.main('resume_member', { member_id: A.members.developer! });

    expect([...emergency, ...projectPause, ...memberPause].map((r) => `${r.name}:${r.code}`)).toEqual([
      'create_task:stopped',
      'request_merge:stopped',
      'submit_review:stopped',
      'set_steps:stopped',
      'submit_for_review:stopped',
      'register_directive:stopped',
      'create_task:stopped',
      'assign_reviewer:stopped',
      'send_message:stopped',
      'ask_producer:stopped',
    ]);
    expect([readOnly.ok, otherProject.ok, otherMember.ok]).toEqual([true, true, true]);
    expectLogged(app, A.producerId, ['create_task', 'request_merge', 'submit_review', 'assign_reviewer']);
    expectLogged(app, A.members.developer!, ['set_steps', 'submit_for_review', 'send_message', 'ask_producer']);
    expectLogged(app, MAIN_AGENT_ID, ['register_directive']);
    expect(app.ctx.store.tasks.list({ ref1: f.dA })).toHaveLength(2);
    expect(app.ctx.store.reviews.list()).toEqual([]);
  });

  it('AC-19: 정지가 저장된 뒤 아직 종료 확인 중인 작업 턴(실제 CLI 프로세스·실제 턴 토큰)이 단계 완료(프로그램 커밋)를 요청하면 — 긴급 정지·즉시 일시정지는 거부·기록되고 커밋되지 않으며, 단계 마치고 정지(기본)는 그 단계를 커밋한 뒤 턴을 끝낸다', async () => {
    // 작업 턴의 프로세스 종료를 1.5초 늦춘다 (제품의 종료 확인 상한 2.8초 안) — 그동안 CLI는 살아 있고 그 턴의 토큰도 유효하다
    const SLOW_MS = 1_500;
    const app = await boot({ slowKill: (spec) => (String(spec.env.WOOK_MOCK_WORKKEY ?? '').startsWith('task:') ? SLOW_MS : 0) });
    const legs = ['graceful', 'immediate', 'emergency'] as const;
    const setup = {} as Record<(typeof legs)[number], { projectId: string; dev: string }>;
    for (const leg of legs) {
      const p = await addProject(app, { name: `정지 ${leg}`, team: ['developer'], scenarios: { developer: 'hang' } });
      dirs.push(p.root);
      setup[leg] = { projectId: p.id, dev: p.members.developer! };
      await sendCommand(app, p.id, '로그인 화면을 만들어 줘');
    }
    /** 그 개발자의 작업 턴이 떠서(hang: 첫 출력 뒤 대기) 살아 있을 때의 실제 턴 토큰·작업 폴더 */
    const liveTurn = async (dev: string) => {
      await waitFor(() => app.core.turns.isMemberRunning(dev) && app.launches.some((l) => l.memberId === dev && l.workKey.startsWith('task:')), `${dev} 작업 턴`, 60_000);
      const l = app.launches.filter((x) => x.memberId === dev && x.workKey.startsWith('task:')).at(-1)!;
      const taskId = l.workKey.slice('task:'.length);
      const ws = app.ctx.store.tasks.require(taskId).workspace!.worktreePath;
      expect((await callTool(app, l.token, 'set_steps', { steps: ['단계 1', '단계 2'] })).ok).toBe(true);
      return { token: l.token, ws, dev };
    };
    const tryStep = async (x: { token: string; ws: string; dev: string }) => {
      writeFileSync(join(x.ws, 'step-during-stop.txt'), '정지 요청 뒤의 단계 변경\n', 'utf8');
      const before = revParse(x.ws, 'HEAD');
      const turnLive = app.core.turns.isMemberRunning(x.dev);
      const r = await callTool(app, x.token, 'complete_step', { step_index: 0, note: '정지 요청 뒤 단계 완료' });
      return { turnLive, refused: !r.ok, committed: revParse(x.ws, 'HEAD') !== before };
    };

    // ① 단계 마치고 정지 (프로젝트 일시정지 기본값)
    const g = await liveTurn(setup.graceful.dev);
    await app.main('pause_project', { project_id: setup.graceful.projectId, mode: 'graceful' });
    const graceful = await tryStep(g);
    const gracefulTurnEnded = await waitFor(() => !app.core.turns.isMemberRunning(g.dev), '단계 마치고 정지 — 턴 종료', 20_000).then(
      () => true,
      () => false,
    );

    // ② 즉시 일시정지 — 정지 값은 저장됐고 프로세스는 종료 확인 중
    const i = await liveTurn(setup.immediate.dev);
    const seqI = lastSeq(app);
    const pausing = app.main('pause_project', { project_id: setup.immediate.projectId, mode: 'immediate' });
    await waitFor(() => !!app.ctx.stop().projects[setup.immediate.projectId]?.paused, '즉시 일시정지 저장');
    const immediate = await tryStep(i);
    await pausing;

    // ③ 긴급 정지
    const e = await liveTurn(setup.emergency.dev);
    const seqE = lastSeq(app);
    const stopping = app.invoke('stop.emergency');
    await waitFor(() => app.ctx.stop().global.active, '긴급 정지 저장');
    const emergency = await tryStep(e);
    await stopping;

    expect({ graceful: { ...graceful, turnEnded: gracefulTurnEnded }, immediate, emergency }).toEqual({
      graceful: { turnLive: true, refused: false, committed: true, turnEnded: true },
      immediate: { turnLive: true, refused: true, committed: false },
      emergency: { turnLive: true, refused: true, committed: false },
    });
    expect({ immediate: unloggedRefusals(app, seqI, i.dev, ['complete_step']), emergency: unloggedRefusals(app, seqE, e.dev, ['complete_step']) }).toEqual({ immediate: [], emergency: [] });
  }, 120_000);

  it('AC-19: 앱 금지 정책 — 앱 설정·기록을 직접 바꾸는 앱 도구는 없고(없는 도구로 거부·기록), 앱 데이터 폴더(또는 그 안)를 프로젝트로 등록해 앱 기록을 git 저장소에 넣으려는 요청은 거부·기록되고 저장소·지침 파일을 만들지 않는다', async () => {
    const f = await twoProjects();
    const { app } = f;
    const main = mainToken(app, null);
    const missing = await callAll(app, main, [
      ['delete_activity_log', {}],
      ['format_disk', { drive: 'C:' }],
      ['disable_security', {}],
    ]);
    expect(missing.map((r) => r.code)).toEqual(['not_found', 'not_found', 'not_found']);
    expectLogged(app, MAIN_AGENT_ID, ['delete_activity_log', 'format_disk', 'disable_security']);
    // 앱 설정은 메인 에이전트의 설정 도구(update_settings)가 허용 항목만 바꾼다 (v0.6 SEC-02, SERVER_DESIGN 2.6) — 보안 정책·개발자 옵션은 거부·기록되고 그대로다
    const settingsBefore = app.ctx.settings();
    const outside = await callAll(app, main, [
      ['update_settings', { patch: { policy: { sensitiveAreas: [] } }, reason: '민감 영역을 비우려는 시도' }],
      ['update_settings', { patch: { developer: { mainAgentMock: !settingsBefore.developer.mainAgentMock } }, reason: '모의 실행을 바꾸려는 시도' }],
    ]);
    expect(outside.map((r) => r.code)).toEqual(['forbidden', 'forbidden']);
    expectLogged(app, MAIN_AGENT_ID, ['update_settings']);
    expect(toolRejections(app).filter((r) => r.memberId === MAIN_AGENT_ID && r.tool === 'update_settings')).toHaveLength(2);
    expect({ policy: app.ctx.settings().policy, developer: app.ctx.settings().developer }).toEqual({ policy: settingsBefore.policy, developer: settingsBefore.developer });

    const attempts = [
      { name: '앱 데이터 폴더', path: app.dataDir, mode: 'existing' },
      { name: '앱 보고서 폴더 안', path: join(app.dataDir, 'reports', 'evil'), mode: 'new' },
    ];
    const outcome: Record<string, unknown>[] = [];
    for (const a of attempts) {
      const seq0 = lastSeq(app);
      const r = await callTool(app, main, 'create_project', a);
      outcome.push({
        target: a.name,
        refused: !r.ok,
        unlogged: unloggedRefusals(app, seq0, MAIN_AGENT_ID, ['create_project']),
        registered: app.ctx.store.projects.list().some((p) => samePath(p.path, a.path)),
        gitCreated: existsSync(join(a.path, '.git')),
        guidelinesWritten: existsSync(join(a.path, 'AGENTS.md')) || existsSync(join(a.path, 'CLAUDE.md')),
      });
    }
    // 등록됐다면 앱 기록(DB 등)이 그 프로젝트 저장소에 커밋됐는지 — 이후 병합·되돌리기·체크아웃이 앱 기록 파일을 덮을 수 있는 상태
    const tracked = existsSync(join(app.dataDir, '.git')) ? execFileSync('git', ['-C', app.dataDir, 'ls-files'], { encoding: 'utf8' }).split(/\r?\n/) : [];
    expect({ outcome, appRecordsCommitted: ['wook.db', 'logs/backend.log'].filter((x) => tracked.includes(x)) }).toEqual({
      outcome: attempts.map((a) => ({ target: a.name, refused: true, unlogged: [], registered: false, gitCreated: false, guidelinesWritten: false })),
      appRecordsCommitted: [],
    });
  });

  it('AC-19: 앱 금지 정책 — 앱 데이터 폴더를 품은 상위 폴더(사용자 폴더 등)를 프로젝트로 등록해 앱 DB·기록을 그 저장소에 커밋하려는 요청도 거부·기록된다', async () => {
    const home = tempDir('apphome');
    dirs.push(home);
    const dataDir = join(home, 'AppData', 'Roaming', 'wookagent');
    mkdirSync(dataDir, { recursive: true });
    const app = await boot({ dataDir, stopScheduler: true, runnerMode: 'taskkill' });
    const seq0 = lastSeq(app);
    const r = await callTool(app, mainToken(app, null), 'create_project', { name: '사용자 폴더', path: home, mode: 'existing' });
    const gitCreated = existsSync(join(home, '.git'));
    const tracked = gitCreated ? execFileSync('git', ['-C', home, 'ls-files'], { encoding: 'utf8' }).split(/\r?\n/) : [];
    expect({
      refused: !r.ok,
      unlogged: unloggedRefusals(app, seq0, MAIN_AGENT_ID, ['create_project']),
      registered: app.ctx.store.projects.list().some((p) => samePath(p.path, home)),
      gitCreated,
      appRecordsCommitted: tracked.filter((x) => /wookagent\/(wook\.db|logs\/)/.test(x)),
    }).toEqual({ refused: true, unlogged: [], registered: false, gitCreated: false, appRecordsCommitted: [] });
  });

  it('AC-19 (10.3·12장): 앱 금지 정책 위반 요청(앱 데이터 폴더를 프로젝트로 등록)은 거부와 함께 긴급 알림으로 알린다', async () => {
    const app = await boot({ stopScheduler: true, runnerMode: 'taskkill' });
    const t0 = Date.now() - 1;
    const r = await callTool(app, mainToken(app, null), 'create_project', { name: '앱 데이터 폴더', path: app.dataDir, mode: 'existing' });
    const urgent = app.ctx.store.notifications.list().filter((n) => n.level === 'urgent' && Date.parse(n.createdAt) >= t0);
    expect({ refused: !r.ok, urgentAlert: urgent.length > 0 }).toEqual({ refused: true, urgentAlert: true });
  });
});

// ═════════════════════════ AC-32 ═════════════════════════

describe('AC-32 세션 토큰 누락·역할 불일치·다른 프로젝트/작업 요청을 거부하고, 검수 도구는 미배정·작업자 본인이면 거부한다', () => {
  it('AC-32: 토큰이 없거나 형식이 틀리거나 모르는 토큰이면 401로 거부되고 처리기를 거치지 않으며 기록된다', async () => {
    const f = await twoProjects();
    const { app } = f;
    const args = { directive_id: f.dA, title: '토큰 없이', goal: 'x', type: 'development', assignee_id: f.A.members.developer, acceptance_criteria: ['x'], output_mode: 'repo' };
    const seq0 = Math.max(0, ...app.ctx.store.activity.search({ limit: 1 }).map((e) => e.seq));
    const noToken = await callTool(app, null, 'create_task', args);
    const basic = await callTool(app, null, 'create_task', args, { authorization: `Basic ${Buffer.from('a:b').toString('base64')}` });
    const forged = await callTool(app, 'forged-token-0000000000000000000000000000000', 'create_task', args);
    expect([noToken, basic, forged].map((r) => [r.status, r.code])).toEqual([
      [401, 'unauthorized'],
      [401, 'unauthorized'],
      [401, 'unauthorized'],
    ]);
    expect(app.ctx.store.tasks.list({ ref1: f.dA })).toHaveLength(2);
    const logged = app.ctx.store.activity
      .search({ kinds: ['app_tool'], limit: 5000 })
      .filter((e) => e.seq > seq0)
      .reverse();
    expect(logged.map((e) => [e.text, e.memberId, e.level, e.result])).toEqual([
      ['create_task 거부', null, 'warn', 'Authorization: Bearer <토큰> 헤더가 없습니다'],
      ['create_task 거부', null, 'warn', 'Authorization 헤더가 "Bearer <토큰>" 형식이 아닙니다'],
      ['create_task 거부', null, 'warn', '토큰이 유효하지 않거나 이미 폐기되었습니다 (턴이 끝났을 수 있습니다)'],
    ]);
  });

  it('AC-32: 실제 턴이 끝나면 그 턴의 세션 토큰은 폐기되어 다시 쓰면 거부·기록된다', async () => {
    const app = await boot({});
    const p = await addProject(app, { team: ['developer'] });
    dirs.push(p.root);
    const did = await sendCommand(app, p.id, '간단한 문서를 정리해 줘');
    await waitFor(() => app.ctx.store.directives.get(did)?.state === 'awaiting_confirmation', '보고 도착', 120_000);
    await waitFor(() => app.core.turns.count() === 0, '턴 종료');
    expect(app.launches.length).toBeGreaterThan(3);
    const seq0 = Math.max(0, ...app.ctx.store.activity.search({ limit: 1 }).map((e) => e.seq));
    const results = [];
    for (const l of app.launches) results.push(await callTool(app, l.token, 'get_work_context', {}));
    expect(results.map((r) => r.status)).toEqual(app.launches.map(() => 401));
    expect(results.every((r) => r.message?.includes('폐기'))).toBe(true);
    const rej = toolRejections(app).filter((r) => r.seq > seq0);
    expect(rej.map((r) => [r.tool, r.memberId])).toEqual(app.launches.map(() => ['get_work_context', null]));
  }, 150_000);

  it('AC-32: 다른 프로젝트·다른 작업을 대상으로 한 요청은 거부된다 (프로듀서 작업 변경·질문 답변·검수 도구)', async () => {
    const f = await twoProjects();
    const { app, A, B } = f;
    await toReview(app, f.tB1);
    const qB = app.core.tasks.askProducer(app.ctx.store.tasks.require(f.tB1), app.ctx.store.members.require(B.members.developer!), 'B 질문', `task:${f.tB1}`);
    const pa = tokenFor(app, A.producerId, `directive:${f.dA}`);
    const qa = tokenFor(app, A.members.qa!, `review:${f.tA1}`);
    const res = [
      ...(await callAll(app, pa, [
        ['update_task', { task_id: f.tB1, priority: 'low' }],
        ['answer_question', { question_id: qB.id, answer: '남의 질문에 답' }],
        ['get_review_target', { task_id: f.tB1 }],
        ['submit_review', PASS_ARGS(f.tB1)],
      ])),
      ...(await callAll(app, qa, [
        ['get_review_target', { task_id: f.tB1 }],
        ['submit_review', PASS_ARGS(f.tB1)],
      ])),
    ];
    expect(res.map((r) => `${r.name}:${r.code}`)).toEqual([
      'update_task:forbidden',
      'answer_question:forbidden',
      'get_review_target:forbidden',
      'submit_review:forbidden',
      'get_review_target:forbidden',
      'submit_review:forbidden',
    ]);
    expectLogged(app, A.producerId, ['update_task', 'answer_question', 'get_review_target', 'submit_review']);
    expectLogged(app, A.members.qa!, ['get_review_target', 'submit_review']);
    expect(app.ctx.store.questions.require(qB.id).status).toBe('open');
    expect(app.ctx.store.reviews.list()).toEqual([]);
  });

  it('AC-32: 검수 도구는 검수 권한이 있어도 검수자로 배정되지 않았거나 작업자 본인이면 거부하고, 배정된 독립 검수자만 판정을 등록한다', async () => {
    const f = await twoProjects();
    const { app, A } = f;
    await toReview(app, f.tA1);
    await toReview(app, f.tA2);
    const pa = tokenFor(app, A.producerId, `directive:${f.dA}`);
    const qa = tokenFor(app, A.members.qa!, `review:${f.tA1}`);
    const dev = tokenFor(app, A.members.developer!, `task:${f.tA1}`);
    // tA1의 검수자는 프로듀서 — QA는 검수 권한이 있지만 미배정
    const unassigned = await callAll(app, qa, [
      ['get_review_target', { task_id: f.tA1 }],
      ['submit_review', PASS_ARGS(f.tA1)],
    ]);
    // 작업자 본인 (QA의 tA2) — 개발자는 검수 도구 자체가 역할 밖
    const self = [
      ...(await callAll(app, tokenFor(app, A.members.qa!, `review:${f.tA2}`), [['submit_review', PASS_ARGS(f.tA2)]])),
      ...(await callAll(app, dev, [['submit_review', PASS_ARGS(f.tA1)]])),
    ];
    expect([...unassigned, ...self].map((r) => `${r.name}:${r.code}`)).toEqual(['get_review_target:forbidden', 'submit_review:forbidden', 'submit_review:forbidden', 'submit_review:forbidden']);
    expect(unassigned[1]!.message).toContain('배정되지 않았습니다');
    expect(app.ctx.store.reviews.list()).toEqual([]);
    // QA를 tA1 검수자로 배정하면 그때 등록된다 (독립 검수자)
    expect((await callTool(app, pa, 'assign_reviewer', { task_id: f.tA1, reviewer_id: A.members.qa })).ok).toBe(true);
    const target = await callTool(app, qa, 'get_review_target', { task_id: f.tA1 });
    const passed = await callTool(app, qa, 'submit_review', PASS_ARGS(f.tA1));
    expect([target.ok, passed.ok]).toEqual([true, true]);
    expect(app.ctx.store.reviews.list().map((r) => [r.taskId, r.reviewerId, r.verdict])).toEqual([[f.tA1, A.members.qa, 'pass']]);
  });

  it('AC-32: 다른 작업 요청 — 배정된 검수자라도 자기 다른 작업(task:T-0002) 세션의 토큰으로 T-0001의 검수 대상 조회·판정을 보내면 거부·기록되고 판정이 남지 않는다', async () => {
    const f = await twoProjects();
    const { app, A } = f;
    await toReview(app, f.tA1);
    const pa = tokenFor(app, A.producerId, `directive:${f.dA}`);
    expect((await callTool(app, pa, 'assign_reviewer', { task_id: f.tA1, reviewer_id: A.members.qa })).ok).toBe(true);
    // QA는 tA1의 검수자로 배정됐고, 지금은 자기 작업 tA2의 작업 세션을 돌리고 있다
    expect(await app.core.tasks.activateForLaunch(f.tA2)).toBe(true);
    const qaTaskSession = tokenFor(app, A.members.qa!, `task:${f.tA2}`);
    const seq0 = lastSeq(app);
    const res = await callAll(app, qaTaskSession, [
      ['get_review_target', { task_id: f.tA1 }],
      ['submit_review', PASS_ARGS(f.tA1)],
    ]);
    const t = app.ctx.store.tasks.require(f.tA1);
    expect({
      results: res.map((r) => `${r.name}:${r.ok ? 'accepted' : 'refused'}`),
      unlogged: unloggedRefusals(app, seq0, A.members.qa!, ['get_review_target', 'submit_review']),
      reviews: app.ctx.store.reviews.list().length,
      taskState: t.state,
      passed: t.review.passed,
    }).toEqual({ results: ['get_review_target:refused', 'submit_review:refused'], unlogged: [], reviews: 0, taskState: 'in_review', passed: null });
  });

  it('AC-32: 검수자를 바꾼 직후 아직 종료 확인 중인 이전 검수자의 검수 턴(실제 CLI 프로세스·실제 턴 토큰)이 그 작업에 질문·판정을 보내면 배정 재확인으로 거부·기록되고, 작업은 검수 중 그대로다', async () => {
    // 검수 턴의 프로세스 종료를 1.5초 늦춘다 (제품의 종료 확인 상한 2.8초 안) — 그동안 이전 검수자의 CLI와 턴 토큰이 살아 있다
    const SLOW_MS = 1_500;
    const app = await boot({ stopScheduler: true, slowKill: (spec) => (String(spec.env.WOOK_MOCK_WORKKEY ?? '').startsWith('review:') ? SLOW_MS : 0) });
    const A = await addProject(app, { name: '검수자 교체', team: ['developer', 'qa'], scenarios: { qa: 'hang' } });
    dirs.push(A.root);
    const { core, ctx } = app;
    const qa = A.members.qa!;
    const dA = core.directives.register({ projectId: A.id, title: 'A 지시', text: 'A 지시' }, MAIN_AGENT_ID, null).id;
    const t1 = core.tasks.create(
      { directiveId: dA, title: '개발 작업', goal: '목표', type: 'development', assigneeId: A.members.developer!, reviewerId: null, acceptanceCriteria: ['동작한다'], outputMode: 'repo' },
      A.producerId,
    ).id;
    await toReview(app, t1);
    // 계획·프로듀서 검수 같은 다른 업무는 띄우지 않는다 — QA의 검수 턴 하나만
    for (const q of ctx.store.queue.list({ state: 'queued' })) ctx.store.queue.put({ ...q, state: 'done', doneAt: ctx.now() });
    const pa = tokenFor(app, A.producerId, `directive:${dA}`);
    expect((await callTool(app, pa, 'assign_reviewer', { task_id: t1, reviewer_id: qa })).ok).toBe(true);
    core.scheduler.tick();
    await waitFor(() => core.turns.isMemberRunning(qa) && app.launches.some((l) => l.memberId === qa && l.workKey === `review:${t1}`), 'QA 검수 턴', 30_000);
    const qaToken = app.launches.filter((l) => l.memberId === qa && l.workKey === `review:${t1}`).at(-1)!.token;
    // 프로듀서가 검수자를 메인 에이전트로 바꾼다 → 이전 검수 턴은 정지 요청을 받고 종료 확인 중
    expect((await callTool(app, pa, 'assign_reviewer', { task_id: t1, reviewer_id: 'main' })).ok).toBe(true);
    const seq0 = lastSeq(app);
    const oldTurnLive = core.turns.isMemberRunning(qa);
    const question = await callTool(app, qaToken, 'ask_producer', { question: '검수 기준을 알려 주세요' });
    const verdict = await callTool(app, qaToken, 'submit_review', PASS_ARGS(t1));
    const t = ctx.store.tasks.require(t1);
    expect({
      oldTurnLive,
      question: question.ok ? 'accepted' : 'refused',
      verdict: verdict.ok ? 'accepted' : 'refused',
      unlogged: unloggedRefusals(app, seq0, qa, ['ask_producer', 'submit_review']),
      taskState: t.state,
      reviewerId: t.reviewerId,
      holdKinds: t.hold.reasons.map((r) => r.kind),
      openQuestions: ctx.store.questions.list().filter((q) => q.status === 'open').length,
      reviews: ctx.store.reviews.list().length,
    }).toEqual({ oldTurnLive: true, question: 'refused', verdict: 'refused', unlogged: [], taskState: 'in_review', reviewerId: 'M-MAIN', holdKinds: [], openQuestions: 0, reviews: 0 });
  }, 60_000);
});

// ═════════════════════════ AC-20 ═════════════════════════

/** 시험용 API 키: Anthropic 형식(알려진 형식) + 형식 규칙에 없는 값(대표 등록으로만 가려진다) */
const K_ANTHROPIC = 'sk-ant-api03-WookAccTestKey7Qx9Zr2Lm4Pv8Ks1Hn6Tb3Yc5Vd0Fg';
const K_CUSTOM = 'wtk9AccTestKeyQ7x9Zr2Lm4Pv8Ks1Hn6Tb3';

/** 앱이 저장·표시·검색·내보내기·백업한 모든 곳에서 값 찾기 → { 위치: [찾은 값] } (비어 있어야 함) */
async function leakReport(app: App, needles: string[], shell?: ReturnType<typeof fakeShell>): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  const add = (where: string, text: string) => {
    const found = needles.filter((n) => text.includes(n));
    if (found.length) out[where] = found;
  };
  // 내보내기·백업 (파일 검사보다 먼저 만들어 둔다)
  const exp = await app.invoke('logs.export', {});
  add('내보내기', readFileSync(exp.path, 'utf8'));
  const bak = await app.internal('system.backupNow');
  for (const h of scanFiles(bak.path, needles)) (out[`백업 ${h.file}`] ??= []).push(h.needle);
  // 검색 (그 값으로 찾아지면 원문이 남아 있다는 뜻)
  for (const n of needles) {
    if ((await app.invoke('logs.search', { text: n, limit: 5000 })).length) (out['검색: 활동 기록'] ??= []).push(n);
    if ((await app.invoke('reports.list', { text: n })).length) (out['검색: 문서함'] ??= []).push(n);
  }
  // 화면 (스냅샷·팀원 상세·원본 형식 보기·작업 상세·diff·보고서·알림·대화·기록·푸시)
  add('화면', await screenDump(app));
  if (shell) add('OS 알림', JSON.stringify(shell.toasts));
  // DB (모든 표)
  add('DB 표', dumpDb(app));
  // 앱 데이터 폴더의 모든 파일 (DB·WAL·로그·이벤트·보고서·기억·내보내기·백업·임시) — 프로젝트 파일 사본(작업 폴더·검수 사본·산출물)은 제외
  for (const h of scanFiles(app.dataDir, needles, { exclude: ['worktrees', 'review', 'artifacts'] })) (out[`파일 ${h.file}`] ??= []).push(h.needle);
  return out;
}

describe('AC-20 테스트용 API 키를 CLI 출력·로그·보고에 넣어도 앱이 저장한 파일·DB·화면·검색·내보내기·백업·원본 형식 보기에 그 값이 남지 않는다', () => {
  it('AC-20: 대표가 등록한 테스트 API 키를 CLI 출력(답변·명령·결과·표준 오류)·작업 파일·자동 검사 로그·보고서·질문에 넣어도 앱이 저장·표시한 어디에도 남지 않는다', async () => {
    const shell = fakeShell();
    const app = await boot({ shell, leak: [K_ANTHROPIC, K_CUSTOM] });
    await app.invoke('settings.setApiKey', 'claude', K_ANTHROPIC);
    await app.invoke('settings.setApiKey', 'codex', K_CUSTOM);
    const check = process.platform === 'win32' ? 'type leak-config.txt' : 'cat leak-config.txt';
    const p = await addProject(app, { team: ['developer'], checkCommands: [check], files: { 'leak-config.txt': `${K_ANTHROPIC}\n${K_CUSTOM}\n`, 'README.md': '# 시험\n' } });
    dirs.push(p.root);
    const did = await sendCommand(app, p.id, '설정 파일을 정리해 줘');
    await waitFor(() => app.ctx.store.directives.get(did)?.state === 'awaiting_confirmation', '보고 도착', 120_000);
    await waitFor(() => app.core.turns.count() === 0, '턴 종료');
    // 보고서·질문 (메인 에이전트 앱 도구 인자, 실제 HTTP)
    const rep = await callTool(app, mainToken(app, null), 'submit_report', {
      title: `키 정리 ${K_CUSTOM}`,
      summary: `요약 ${K_ANTHROPIC} ${K_CUSTOM}`,
      results: `결과: ${K_CUSTOM}`,
      changed_files: [`config/${K_CUSTOM}.txt`],
      how_to_verify: `${K_ANTHROPIC} 로 확인`,
      issues: K_CUSTOM,
      next_steps: '',
    });
    const ask = await callTool(app, mainToken(app, p.id), 'ask_owner', { question: `이 키를 계속 쓸까요? ${K_ANTHROPIC} ${K_CUSTOM}` });
    expect([rep.ok, ask.ok]).toEqual([true, true]);

    // 시험이 실제로 일어났는지: 가린 표시로 저장·표시됐다
    const dump = await screenDump(app);
    expect(dump).toContain('확인한 값: [가림:');
    expect(dump).toContain('wook-leak-note.txt');
    const checked = app.ctx.store.tasks.list({ ref1: did }).map((t) => t.review.autoCheck);
    expect(checked.some((c) => c.status === 'passed' && c.detail.includes('[가림:'))).toBe(true);
    expect(app.ctx.store.reports.list().some((r) => r.title.includes('[가림:'))).toBe(true);
    expect(shell.toasts.some((t) => t.body.includes('[가림:'))).toBe(true);

    expect(await leakReport(app, [K_ANTHROPIC, K_CUSTOM], shell)).toEqual({});
  }, 150_000);

  it('AC-20: 앱을 다시 시작한 뒤에도 등록해 둔 API 키가 CLI 출력에서 가려져 저장·표시되지 않는다', async () => {
    const secrets = persistentSecrets();
    const dataDir = tempDir('data');
    dirs.push(dataDir);
    const first = await boot({ dataDir, secrets, stopScheduler: true });
    await first.invoke('settings.setApiKey', 'claude', K_ANTHROPIC);
    await first.invoke('settings.setApiKey', 'codex', K_CUSTOM);
    await first.stop();
    expect(await secrets.get('api-key-codex')).toBe(K_CUSTOM); // OS 보안 저장소에는 남아 있다 (SEC-09)

    const app = await boot({ dataDir, secrets, leak: [K_ANTHROPIC, K_CUSTOM] });
    await app.invoke('command.send', { target: 'main', text: '오늘 할 일을 정리해 줘' });
    await waitFor(() => app.ctx.store.turns.list().some((t) => !!t.endedAt), '메인 에이전트 턴 종료');
    await waitFor(() => app.core.turns.count() === 0, '턴 종료');
    expect(await screenDump(app)).toContain('확인한 값: [가림:');
    expect(await leakReport(app, [K_ANTHROPIC, K_CUSTOM])).toEqual({});
  }, 120_000);

  it('AC-20: 앱 도구 요청의 request_id에 들어간 API 키도 DB·화면·검색·내보내기·백업과 프로그램이 쓴 병합 커밋 기록에 남지 않고, 같은 요청의 중복 판정은 그대로 된다', async () => {
    const f = await twoProjects();
    const { app, A } = f;
    await app.invoke('settings.setApiKey', 'claude', K_ANTHROPIC);
    const main = mainToken(app, null);
    // 질문 (캐시 키·활동 기록) — 같은 요청을 두 번 보내면 두 번째는 중복으로 답한다
    const ask1 = await callTool(app, main, 'ask_owner', { question: '확인 부탁드립니다', request_id: K_ANTHROPIC });
    const ask2 = await callTool(app, main, 'ask_owner', { question: '확인 부탁드립니다', request_id: K_ANTHROPIC });
    // 지시 등록 (상태 전이 기록) · 역할 밖 요청의 거부 기록
    const reg = await callTool(app, mainToken(app, A.id), 'register_directive', { project_id: A.id, title: '설정 정리', text: '설정 파일을 정리해 줘', request_id: K_ANTHROPIC });
    const refused = await callTool(app, main, 'complete_step', { step_index: 0, request_id: K_ANTHROPIC });
    // 병합 요청 (병합 실행 기록·작업의 병합 기록·병합 커밋 메시지)
    await toReview(app, f.tA1);
    const passed = await callTool(app, tokenFor(app, A.producerId, `review:${f.tA1}`), 'submit_review', PASS_ARGS(f.tA1));
    const merge = await callTool(app, tokenFor(app, A.producerId, `directive:${f.dA}`), 'request_merge', { task_id: f.tA1, request_id: K_ANTHROPIC });
    await waitFor(() => app.ctx.store.tasks.require(f.tA1).state === 'done', '병합 완료', 30_000);
    expect([ask1.ok, ask2.data?.duplicateRequest, reg.ok, refused.code, passed.ok, merge.ok]).toEqual([true, true, true, 'forbidden', true, true]);
    expect(app.ctx.store.questions.list().filter((q) => q.to === 'owner')).toHaveLength(1);
    const leaks = await leakReport(app, [K_ANTHROPIC]);
    const mergeLog = execFileSync('git', ['-C', A.dir, 'log', '--format=%B', '-n', '5', app.ctx.store.projects.require(A.id).baseBranch], { encoding: 'utf8' });
    if (mergeLog.includes(K_ANTHROPIC)) leaks['병합 커밋 메시지 (프로그램이 쓴 git 기록)'] = [K_ANTHROPIC];
    expect(leaks).toEqual({});
  });

  it('AC-20: 3단계의 비밀 형식 — 서버가 낸 대표의 기기 세션 토큰(wos_)과 대표 이메일 설정 코드 — 도 CLI 출력·대표 명령에 넣어도 앱이 저장·표시·검색·내보내기·백업한 어디에도, 서버 기록과 HTTP 응답에도 남지 않는다 (리드 결정 S3-14)', async () => {
    const leak: string[] = [];
    const app = await boot({ mode: 'server', leak });
    const operator = createBackendOperator(() => app.core);
    // 서버(serve.ts)처럼: 설정 코드는 setup-code.txt에 보이는 꼴(ABCD-EFGH)로, 서버 기록은 서버의 가리기를 끼운 server.log에
    const setup = operator.issueSetupCode()!;
    // auth.setupOwner가 받는 꼴 — 원문, 서버가 보여 주는 꼴, 소문자로 옮겨 적은 꼴 (리드 결정 S3-18, 10.11 AC-20 행)
    const codeForms = [setup.code, showSetupCode(setup.code), showSetupCode(setup.code).toLowerCase()];
    writeFileSync(join(app.dataDir, 'setup-code.txt'), `코드: ${showSetupCode(setup.code)}\n`);
    const serverLog = createFileLogger({ dir: join(app.dataDir, 'logs'), fileName: 'server.log' });
    let server: RunningServer | null = null;
    serverLog.setRedactor(serverRedactor(() => server, new Set([setup.code])));
    const b = app.orch.backend;
    server = await startServer({
      backend: { invoke: b.invoke, onTopicRaw: b.onTopicRaw, topicFor: b.topicFor, snapshotFor: b.snapshotFor, hasActiveWork: b.hasActiveWork, operator, sessions: app.core.deviceSessions, files: app.core.serverFiles },
      dataDir: app.dataDir,
      port: 0,
      allowTestSession: false,
      logger: serverLog,
      version: 'test',
    });
    const url = server.url;
    const bodies: string[] = [];
    const call = async (method: string, args: unknown[], token?: string, query = ''): Promise<number> => {
      const r = await fetch(`${url}/api/invoke${query}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ id: `ac20-${bodies.length}`, method, args }),
      });
      bodies.push(`${await r.text()} ${JSON.stringify([...r.headers])}`);
      return r.status;
    };
    // 서버 기록에도 세 꼴이 들어간다 (운영자 도구의 출력 등을 옮겨 적은 줄)
    serverLog.info(`옮겨 적은 설정 코드: ${codeForms.join(' / ')}`);
    // 설정 코드로 대표 이메일을 정한다 (로그인 전, 보이는 꼴 그대로) — 코드 파일은 지워진다
    expect(await call('auth.setupOwner', [codeForms[1], OWNER_A.email])).toBe(200);
    expect(existsSync(join(app.dataDir, 'setup-code.txt'))).toBe(false);
    // 대표 등록(기기 코드 로그인이 하는 일) 뒤의 기기 세션 — 토큰 원문은 발급할 때만 나온다
    app.ctx.store.kv.set('owner', { sub: OWNER_A.sub, email: OWNER_A.email, name: OWNER_A.name, registeredAt: app.ctx.now(), lastLoginAt: null });
    const { token, session } = app.core.deviceSessions.issue({ deviceName: '휴대폰' });
    // 두 값(코드는 세 꼴 모두)을 CLI 출력(모의 에이전트)에 끼우고, 대표가 명령 글에도 붙여 넣는다
    leak.push(token, ...codeForms);
    expect(await call('command.send', [{ target: 'main', text: `이 세션 ${token} 와 코드 ${codeForms.join(', ')} 를 기억해 둬` }], token)).toBe(200);
    await waitFor(() => app.ctx.store.turns.list().some((t) => !!t.endedAt), '메인 에이전트 턴 종료', 120_000);
    await waitFor(() => app.core.turns.count() === 0, '턴 종료');
    for (const [m, a] of [
      ['snapshot.get', []],
      ['auth.getState', []],
      ['auth.listDevices', []],
      ['command.history', ['main', { limit: 100 }]],
      ['logs.search', [{ limit: 1000 }]],
      ['logs.export', [{}]],
    ] as [string, unknown[]][]) {
      expect(await call(m, a, token), m).toBe(200);
    }
    // 주소에 넣은 토큰은 받지 않는다 (기록에도 남지 않는다)
    expect(await call('snapshot.get', [], undefined, `?token=${token}`)).toBe(401);
    // 그 기기 세션으로 본 화면 — 대표가 보는 것
    const caller = { surface: 'remote' as const, session: deviceSessionView(session, session.id), clientKey: `session:${session.id}` };
    const viewed: App = { ...app, invoke: ((m: never, ...a: never[]) => b.invoke(m, a as never, caller)) as App['invoke'] };

    // 시험이 실제로 일어났는지: 두 값이 가린 표시로 저장·표시됐다 (실패 글에 화면 내용을 내지 않는다 — 토큰이 섞였을 수 있다)
    const dump = await screenDump(viewed);
    expect([dump.includes('확인한 값: [가림:'), dump.includes('[가림:욱채 세션 토큰]')]).toEqual([true, true]);
    expect(app.ctx.store.conversation.list({ ref1: 'main' }).some((m) => m.role === 'owner' && m.text.includes('[가림:욱채 세션 토큰]') && m.text.includes('[가림:setup-code]'))).toBe(true);

    await server.close();
    server = null;
    serverLog.close();
    // 찾은 값 대신 이름으로 — 시험 출력에 토큰·코드를 내지 않는다
    const named = (n: string) => (n === token ? '세션 토큰' : ['설정 코드 (원문)', '설정 코드 (보이는 꼴)', '설정 코드 (소문자 보이는 꼴)'][codeForms.indexOf(n)]!);
    const leaks = Object.fromEntries(Object.entries(await leakReport(viewed, [token, ...codeForms])).map(([where, found]) => [where, found.map(named)]));
    for (const n of [token, ...codeForms]) if (bodies.some((x) => x.includes(n))) (leaks['HTTP 응답'] ??= []).push(named(n));
    expect(leaks).toEqual({});
  }, 180_000);
});

// ═════════════════════════ AC-30 ═════════════════════════

const TIP = (s: string) => `욱채 — ${s}`;

describe('AC-30 창을 닫아도 작업이 계속되고, 트레이 아이콘에서 상태를 확인할 수 있다', () => {
  it('AC-30: 창을 닫으면 트레이로 숨고(종료되지 않음) 작업은 끝까지 계속되며, 트레이가 실제 상태(정상·일시정지·답변 대기·긴급 정지 최우선)를 보여 주고 창을 다시 연다', async () => {
    const app = await boot({});
    const p = await addProject(app, { team: ['developer'] });
    const shellDir = tempDir('shell');
    dirs.push(p.root, shellDir);
    const { TRAY_HINT_TEXT } = await import('../../src/main/shell/window');
    const notified: { body: string }[] = [];
    const ctl = createMainWindowController({
      preloadPath: join(shellDir, 'preload.js'),
      target: { kind: 'file', path: join(shellDir, 'index.html') },
      isDev: false,
      logger: quiet,
      shellStateFile: join(shellDir, 'shell-state.json'),
      notify: (n) => void notified.push(n),
      onSessionEnd: () => undefined,
    });
    ctl.create({ show: true });
    const win = fx.windows.at(-1)!;
    win.show();
    const tray = createTray({ backend: app.orch.backend, onOpenWindow: () => ctl.show(), onEmergency: () => void app.orch.backend.emergencyStop(), onQuit: () => undefined, logger: quiet });
    const fakeTray = fx.trays.at(-1)!;
    expect(fakeTray.menu.map((m) => m.label ?? m.type)).toEqual(['창 열기', '긴급 정지', 'separator', '완전 종료']);

    // 창 닫기 → 숨김 (종료·파괴 아님) + 트레이 안내
    const ev = win.tryClose();
    expect([ev.defaultPrevented, win.visible, win.destroyed, ctl.getWindow() !== null]).toEqual([true, false, false, true]);
    expect(notified.map((n) => n.body)).toContain(TRAY_HINT_TEXT);

    // 창이 숨은 채로 지시가 끝까지 처리된다
    const did = await sendCommand(app, p.id, '로그인 화면을 만들어 줘');
    await waitFor(() => app.ctx.store.directives.get(did)?.state === 'awaiting_confirmation', '보고 도착', 120_000);
    await waitFor(() => app.core.turns.count() === 0, '턴 종료');
    expect(app.ctx.store.tasks.list({ ref1: did }).every((t) => t.state === 'done')).toBe(true);
    expect(win.visible).toBe(false);

    const tip = () => fakeTray.tooltip;
    await waitFor(() => tip() === TIP('정상'), `정상 (지금 ${tip()})`);
    await app.internal('projects.pause', p.id, 'graceful');
    await waitFor(() => tip() === TIP('일시정지'), `일시정지 (지금 ${tip()})`);
    await app.internal('projects.resume', p.id);
    await waitFor(() => tip() === TIP('정상'), `정상 복귀 (지금 ${tip()})`);
    expect((await callTool(app, mainToken(app, p.id), 'ask_owner', { question: '버튼 색을 정해 주세요' })).ok).toBe(true);
    await waitFor(() => tip() === TIP('답변 대기'), `답변 대기 (지금 ${tip()})`);
    // 트레이 메뉴의 긴급 정지 → 일시정지·답변 대기가 함께 있어도 긴급 정지가 최우선
    await app.internal('projects.pause', p.id, 'graceful');
    fakeTray.menu.find((m) => m.label === '긴급 정지')!.click!();
    await waitFor(() => tip() === TIP('긴급 정지'), `긴급 정지 (지금 ${tip()})`);
    expect(app.orch.backend.getTrayStatus()).toBe('emergency');
    await app.invoke('stop.release');
    await app.invoke('notifications.markRead', 'all');
    await waitFor(() => tip() === TIP('일시정지'), `해제 후 일시정지 (지금 ${tip()})`);
    await app.internal('projects.resume', p.id);
    await waitFor(() => tip() === TIP('답변 대기'), `해제 후 답변 대기 (지금 ${tip()})`);
    // 트레이에서 창을 다시 연다
    fakeTray.handlers.get('double-click')!();
    expect(win.visible).toBe(true);
    tray.destroy();
  }, 150_000);

  it('AC-30: 팀원 오류(바이패스 설정 불일치 등 긴급 알림)가 나면 트레이가 오류를 보여 준다', async () => {
    const app = await boot({});
    const p = await addProject(app, { team: ['developer'], scenarios: { developer: 'bypass_mismatch' } });
    dirs.push(p.root);
    const tray = createTray({ backend: app.orch.backend, onOpenWindow: () => undefined, onEmergency: () => undefined, onQuit: () => undefined, logger: quiet });
    const fakeTray = fx.trays.at(-1)!;
    expect(fakeTray.tooltip).toBe(TIP('정상'));
    await sendCommand(app, p.id, '로그인 화면을 만들어 줘');
    await waitFor(() => fakeTray.tooltip === TIP('오류'), `오류 (지금 ${fakeTray.tooltip})`, 120_000);
    expect(app.ctx.store.notifications.list().some((n) => n.level === 'urgent')).toBe(true);
    tray.destroy();
  }, 150_000);
});

// ═════════════════════════ AC-31 ═════════════════════════

describe('AC-31 작업이 진행 중이면 PC가 절전 모드로 들어가지 않는다', () => {
  it('AC-31: CLI 턴이 도는 동안 절전 방지(prevent-app-suspension)가 켜지고, 작업이 끝나면 풀리며, 메인 에이전트가 운영 설정(update_settings)에서 끌 수 있다 — 대표 세션의 settings.update는 forbidden', async () => {
    const app = await boot({});
    const p = await addProject(app, { team: ['developer'], scenarios: { developer: 'hang' } });
    dirs.push(p.root);
    const guard = createPowerGuard({ backend: app.orch.backend, logger: quiet });
    expect([guard.blocking, fx.started.size]).toEqual([false, 0]);
    await sendCommand(app, p.id, '로그인 화면을 만들어 줘');
    await waitFor(() => app.core.turns.isMemberRunning(p.members.developer!), '개발자 턴 실행');
    await waitFor(() => guard.blocking, '절전 방지 시작');
    expect(fx.started.size).toBe(1);
    // 운영 설정에서 끄기·켜기 — 메인 에이전트가 update_settings로 한다 (껍데기는 설정 변경을 주기적으로 update()로 맞춘다)
    await expect(app.invoke('settings.update', { execution: { preventSleep: false } })).rejects.toMatchObject({ code: 'forbidden' });
    expect(app.ctx.settings().execution.preventSleep).toBe(true);
    await app.main('update_settings', { patch: { execution: { preventSleep: false } } });
    guard.update();
    expect([guard.blocking, fx.started.size]).toEqual([false, 0]);
    await app.main('update_settings', { patch: { execution: { preventSleep: true } } });
    guard.update();
    expect([guard.blocking, fx.started.size]).toEqual([true, 1]);
    // 실행 중인 작업을 모두 멈추면 풀린다
    await app.invoke('stop.emergency');
    await waitFor(() => app.core.turns.count() === 0, '턴 종료');
    await waitFor(() => !guard.blocking, '절전 방지 해제');
    expect(fx.started.size).toBe(0);
    guard.dispose();
  }, 120_000);

  it('AC-31: 턴과 턴 사이에 작업의 자동 검사(빌드·테스트 명령)가 도는 동안(작업은 진행 상태, 5.3)에도 절전 방지가 유지된다', async () => {
    const check = process.platform === 'win32' ? 'ping -n 7 127.0.0.1 > nul' : 'sleep 6';
    const app = await boot({});
    const p = await addProject(app, { team: ['developer'], checkCommands: [check] });
    dirs.push(p.root);
    const guard = createPowerGuard({ backend: app.orch.backend, logger: quiet });
    await sendCommand(app, p.id, '로그인 화면을 만들어 줘');
    await waitFor(() => app.core.checks.running.size > 0, '자동 검사 시작', 90_000);
    await sleep(300);
    const taskOf = () => app.ctx.store.tasks.list().find((t) => t.assigneeId === p.members.developer);
    // 살아 있는 CLI 턴 = 끝나지 않은 턴 기록 (제품의 '진행 중 작업' 판정과 따로 센다)
    const liveCliTurns = () => app.ctx.store.turns.list().filter((t) => !t.endedAt).length;
    const samples: { turns: number; blocking: boolean; inProgress: boolean; checking: boolean }[] = [];
    const t0 = Date.now();
    while (app.core.checks.running.size > 0 && Date.now() - t0 < 20_000) {
      const t = taskOf();
      samples.push({ turns: liveCliTurns(), blocking: guard.blocking, inProgress: t?.state === 'in_progress', checking: t?.review.autoCheck.status === 'running' });
      await sleep(100);
    }
    // CLI 턴 없이 그 작업의 자동 검사만 도는 구간 — 작업은 진행 상태다 (5.3 "진행: 자동 검사도 이 상태에서 수행")
    const checkOnly = samples.filter((s) => s.turns === 0 && s.inProgress && s.checking);
    expect(checkOnly.length).toBeGreaterThan(10);
    expect({ checkOnlySamples: checkOnly.length, sleepAllowedSamples: checkOnly.filter((s) => !s.blocking).length }).toEqual({ checkOnlySamples: checkOnly.length, sleepAllowedSamples: 0 });
    guard.dispose();
  }, 150_000);
});

// ═════════════════════════ AC-33 ═════════════════════════

const MARK_CLAUDE_ACCESS = 'WookAccClaudeOauthAccessMarker4f9c2a';
const MARK_CLAUDE_REFRESH = 'WookAccClaudeOauthRefreshMarker8d1e7b';
const MARK_CODEX = 'WookAccCodexChatgptTokenMarker3a6b9c';
const MARK_ENV = 'WookAccEnvOauthTokenMarker5c2d8e';
const CLI_MARKS = [MARK_CLAUDE_ACCESS, MARK_CLAUDE_REFRESH, MARK_CODEX, MARK_ENV];

/** 가짜 사용자 홈: Claude·Codex 구독 로그인 파일과 스킬 폴더 */
function fakeCliHome(): { home: string; claudeDir: string; codexDir: string } {
  const home = tempDir('home');
  const claudeDir = join(home, '.claude');
  const codexDir = join(home, '.codex');
  mkdirSync(join(claudeDir, 'skills', 'demo'), { recursive: true });
  mkdirSync(join(codexDir, 'skills', 'demo2'), { recursive: true });
  writeFileSync(join(claudeDir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: MARK_CLAUDE_ACCESS, refreshToken: MARK_CLAUDE_REFRESH, expiresAt: 9_999_999_999_999, scopes: ['user:inference'], subscriptionType: 'max' } }));
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'owner@example.com', accountUuid: MARK_CLAUDE_ACCESS }, primaryApiKey: MARK_CLAUDE_REFRESH }));
  writeFileSync(join(codexDir, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: null, tokens: { id_token: MARK_CODEX, access_token: MARK_CODEX, refresh_token: MARK_CODEX, account_id: 'acct' }, last_refresh: '2026-10-27T00:00:00Z' }));
  writeFileSync(join(claudeDir, 'skills', 'demo', 'SKILL.md'), '---\nname: demo\ndescription: 시험 스킬\n---\n본문\n');
  writeFileSync(join(codexDir, 'skills', 'demo2', 'SKILL.md'), '---\nname: demo2\ndescription: 시험 스킬 2\n---\n본문\n');
  return { home, claudeDir, codexDir };
}

describe('AC-33 프로그램 데이터 어디에도 CLI의 구독 로그인 토큰이 저장되지 않는다', () => {
  it('AC-33: CLI 구독 로그인 정보(설정 폴더의 인증 파일·환경 변수)가 있는 PC에서 지시 처리·CLI 확인·스킬 목록·백업·내보내기를 해도 앱 데이터 어디에도 그 토큰이 저장되지 않는다', async () => {
    const fake = fakeCliHome();
    dirs.push(fake.home);
    const keys = ['USERPROFILE', 'HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'CLAUDE_CODE_OAUTH_TOKEN'] as const;
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    Object.assign(process.env, { USERPROFILE: fake.home, HOME: fake.home, CLAUDE_CONFIG_DIR: fake.claudeDir, CODEX_HOME: fake.codexDir, CLAUDE_CODE_OAUTH_TOKEN: MARK_ENV });
    try {
      const app = await boot({});
      const p = await addProject(app, { team: ['developer'] });
      dirs.push(p.root);
      const did = await sendCommand(app, p.id, '로그인 화면을 만들어 줘');
      await waitFor(() => app.ctx.store.directives.get(did)?.state === 'awaiting_confirmation', '보고 도착', 120_000);
      await waitFor(() => app.core.turns.count() === 0, '턴 종료');
      const prereqs = await app.invoke('system.prereqs');
      const recheck = [await app.internal('system.recheckAi', 'claude'), await app.internal('system.recheckAi', 'codex')];
      const skills = await app.invoke('skills.list');
      expect(skills.map((s) => s.name)).toEqual(expect.arrayContaining(['demo']));
      await app.internal('system.backupNow');
      await app.invoke('logs.export', {});
      // 화면: 전체 화면 데이터 + 운영 설정의 스킬 목록·사전 조건·CLI 다시 확인 결과
      const screen = (await screenDump(app)) + JSON.stringify({ prereqs, recheck, skills });
      const db = dumpDb(app);
      const found = {
        files: scanFiles(app.dataDir, CLI_MARKS).map((h) => `${h.file}: ${h.needle}`),
        db: CLI_MARKS.filter((m) => db.includes(m)),
        screen: CLI_MARKS.filter((m) => screen.includes(m)),
      };
      expect(found).toEqual({ files: [], db: [], screen: [] });
    } finally {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  }, 150_000);

  it('AC-33: 실제 Claude·Codex 어댑터가 만드는 실행 준비물(임시 설정 파일·명령줄·표시 문구·자식 환경)에 CLI 설정 폴더의 구독 로그인 정보가 들어가지 않는다', async () => {
    const fake = fakeCliHome();
    const work = tempDir('work');
    dirs.push(fake.home, work);
    const resolved = (kind: 'claude' | 'codex') => async () => ({ kind, path: process.execPath, source: 'settings' as const, npmPackageRoot: null, note: '' });
    const baseEnv = () => {
      const e: Record<string, string | undefined> = { ...process.env, CLAUDE_CONFIG_DIR: fake.claudeDir, CODEX_HOME: fake.codexDir };
      delete e.CLAUDE_CODE_OAUTH_TOKEN;
      return e;
    };
    const adapters = [
      createClaudeAdapter({ resolveExecutable: resolved('claude'), baseEnv, homeDir: fake.home }),
      createCodexAdapter({ resolveExecutable: resolved('codex'), baseEnv }),
    ];
    const seen: string[] = [];
    for (const [i, adapter] of adapters.entries()) {
      const tempDirPath = join(work, `turn-${i}`);
      const run = await adapter.prepare({
        format: i === 0 ? 'claude' : 'codex',
        cwd: work,
        message: '작업 메시지',
        systemPrompt: '역할 지침',
        resumeCliSessionId: null,
        newSessionId: i === 0 ? '7f9c2a10-1111-4222-8333-944455556666' : null,
        model: null,
        effort: 'medium',
        mcp: { url: 'http://127.0.0.1:1/mcp', token: 'turn-token-only', serverName: 'wook' },
        maxTurns: 10,
        images: [],
        addDirs: [],
        tempDir: tempDirPath,
        env: {},
      });
      seen.push(JSON.stringify(run.spec.args), run.display, run.spec.stdinText ?? '', JSON.stringify(Object.values(run.spec.env)));
      for (const f of run.cleanup) if (existsSync(f)) seen.push(readFileSync(f, 'utf8'));
      if (existsSync(tempDirPath)) for (const h of scanFiles(tempDirPath, CLI_MARKS)) seen.push(`파일 ${h.file} ${h.needle}`);
    }
    const all = seen.join('\n');
    expect(CLI_MARKS.filter((m) => all.includes(m))).toEqual([]);
  });
});
