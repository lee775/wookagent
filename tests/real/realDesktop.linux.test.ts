/**
 * 실제 화면 조작 — Linux X11 (S10c, 리드 결정 S10-7.11, SERVER_DESIGN 10.10). 진짜 X11 화면 도우미(x11Helper.mjs + 곁 도우미 x11Sidecar.py)로, 이 시험이 스스로
 * 띄운 Xvfb 화면을 찍고 입력을 보낸다. 사람의 화면은 쓰지 않는다:
 *   - Xvfb는 이 시험이 띄운다: -displayfd(번호를 고르지 않는다), 쿠키(-auth — 쿠키 없는 연결은 거부), -nolisten tcp, -s 0(화면보호기 끔). -nolisten local은 쓰지
 *     않는다 — X 서버가 추상 이름 @/tmp/.X11-unix/X<n>을 쥐어야 다른 프로그램이 그 이름을 가로채지 못한다 (리드 결정 S10-13 SC-1·SC-2). 창 관리자 openbox와
 *     세션 버스(dbus-daemon, AT-SPI)도 띄운다. 이 시험이 띄운 프로그램의 HOME·XDG 폴더는 시험의 임시 폴더 안이다 (TD-9)
 *   - 제품의 문(process/scriptTool.ts)은 WOOK_REAL_DESKTOP_DISPLAY가 그 화면이고, WOOK_REAL_DESKTOP_XPID가 그 화면의 주인(추상 이름과 소켓 파일을 쥔 X 서버 —
 *     SO_PEERCRED로 본다)이고, 그 X 서버가 Xvfb일 때만 연다 — 이 시험이 두 변수를 자기 Xvfb로 둔다
 *   - x11-run.sh는 부를 때마다 따로 네트워크 이름 공간을 준다(추상 소켓이 밖과 섞이지 않는다). CI는 버리는 VM이다
 * 문 (CI 작업 또는 사람이 연다 — 에이전트는 Xvfb 안에서만):
 *   WOOK_REAL_DESKTOP=1 WOOK_REAL_DESKTOP_HOST=$(hostname) npx vitest run tests/real/realDesktop.linux.test.ts
 * 필요한 꾸러미 (Ubuntu 24.04): xvfb openbox xdotool maim x11-utils x11-xserver-utils xinput xprintidle python3 python3-xlib python3-gi gir1.2-atspi-2.0
 *   at-spi2-core dbus-daemon dbus-bin mousepad zenity fonts-noto-cjk
 *
 * 보는 것: 편집기 → 캡처 → 이동(포인터가 그 픽셀) → 클릭 → '안녕하세요' → Ctrl+S → 파일 · 여러 글(한국어·섞인 글·문장 부호·200자)을 열 번 쳐 저장한 파일이 바이트까지
 * 같다 · 암호 칸(zenity --password)에는 치지 않는다 · 무장한 동안 밖에서 움직인 포인터 → human_active · Shift가 눌린 채 긴급 정지 → 3초 안에 끝나고 키가 풀리고
 * 도우미가 없다 · 조작 중 표시(실제 화면처럼 다룬 도우미)는 무장하면 뜨고 캡처에는 없다 · 멈춤 단축키(xdotool로 누름) → HOTKEY · Wayland 같은 환경·화면 없음 →
 * 맞는 unavailable · 메인 턴은 모두 모의 실행. 끝나면 띄운 것을 모두 끝내고 임시 폴더를 지운다.
 * 검토 2차의 고침 (S10c2, 리드 결정 S10-17): 긴 type 도중 다른 프로세스가 포인터를 계속 움직이면 HUMAN_ACTIVE(보낸 글자 < 친 글)이고 아무도 없으면 끝까지
 * 정확하다(FSD-1) · Caps Lock·Shift Lock이 켜진 채 type 도중에 정지해도 켜진 채 남는다(FSD-2) · 무장한 채 X 서버가 끝나고 다른 프로세스가 그 이름을 잡아도
 * 쿠키가 간 연결은 하나까지다(FSD-3) · 세션 버스가 없거나 죽은 주소여도 곁 도우미가 단축키와 표시를 지킨다(FSD-5).
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID, OPERATOR } from '@shared/domain';
import { buildOrchestratorDeps } from '../../src/main/backend/buildDeps';
import type { GuiInputResult, ScreenCaptureResult, ScreenInfoResult } from '../../src/main/mcp/catalog';
import type { ToolCallResult } from '../../src/main/mcp/types';
import { createOrchestrator, type Orchestrator } from '../../src/main/orchestrator/orchestrator';
import { createDesktopHelper, NO_DESKTOP_TEXTS } from '../../src/main/desktop/desktopHelper';
import { createX11DesktopLauncher, resolveX11Tools } from '../../src/main/desktop/x11Launcher';
import { mainOpsIdentity } from '../regression/mainOps';

const ENABLED =
  process.platform === 'linux' && process.env.WOOK_REAL_DESKTOP === '1' && !!process.env.WOOK_REAL_DESKTOP_HOST && process.env.WOOK_REAL_DESKTOP_HOST === hostname();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 그 X 화면의 쿠키 파일 — 모든 주소·번호에 맞는(FamilyWild, 빈 번호) MIT-MAGIC-COOKIE-1 하나. -displayfd로 번호를 모르고 띄우므로. 번호를 안 뒤에는 같은 쿠키를 그
 * 번호로 한 줄 더 적는다 (python3-xlib — 곁 도우미 — 은 빈 번호 줄을 쓰지 않는다)
 */
function writeWildCookie(path: string, cookie: Buffer): void {
  const field = (b: Buffer): Buffer => {
    const l = Buffer.alloc(2);
    l.writeUInt16BE(b.length);
    return Buffer.concat([l, b]);
  };
  const fam = Buffer.alloc(2);
  fam.writeUInt16BE(0xffff);
  writeFileSync(path, Buffer.concat([fam, field(Buffer.alloc(0)), field(Buffer.alloc(0)), field(Buffer.from('MIT-MAGIC-COOKIE-1')), field(cookie)]), { mode: 0o600 });
}

/** 8비트 RGB·RGBA PNG → 픽셀 읽기 (tests/real/realDesktop.test.ts와 같은 풀이) */
function decodePng(png: Buffer): { width: number; height: number; at(x: number, y: number): [number, number, number] } {
  let off = 8;
  let ihdr: Buffer | null = null;
  const idat: Buffer[] = [];
  while (off + 8 <= png.length) {
    const len = png.readUInt32BE(off);
    const type = png.toString('ascii', off + 4, off + 8);
    const data = png.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') ihdr = data;
    else if (type === 'IDAT') idat.push(data);
    off += 12 + len;
  }
  if (!ihdr) throw new Error('PNG에 IHDR이 없습니다');
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const bpp = ihdr[9] === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    for (let i = 0; i < stride; i++) {
      const cur = raw[y * (stride + 1) + 1 + i]!;
      const a = i >= bpp ? out[y * stride + i - bpp]! : 0;
      const b = y > 0 ? out[(y - 1) * stride + i]! : 0;
      const c = i >= bpp && y > 0 ? out[(y - 1) * stride + i - bpp]! : 0;
      let pred = 0;
      if (filter === 1) pred = a;
      else if (filter === 2) pred = b;
      else if (filter === 3) pred = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[y * stride + i] = (cur + pred) & 0xff;
    }
  }
  return { width, height, at: (x, y) => [out[y * stride + x * bpp]!, out[y * stride + x * bpp + 1]!, out[y * stride + x * bpp + 2]!] };
}

describe.skipIf(!ENABLED)('실제 화면 조작 — Linux X11, 이 시험이 띄운 Xvfb (WOOK_REAL_DESKTOP=1 · WOOK_REAL_DESKTOP_HOST=이 PC 이름 · Linux만)', () => {
  let tmp = '';
  let dataDir = '';
  let workRoot = '';
  let file = '';
  let display = '';
  let auth = '';
  let busAddress = '';
  let xvfbPid = 0;
  const procs: ChildProcess[] = [];
  let editor: ChildProcess | null = null;
  let orch: Orchestrator;
  const savedEnv: Record<string, string | undefined> = {};

  /** 이 시험이 띄운 프로그램의 홈 (mousepad·openbox·dconf·mesa가 여기에 쓴다 — 사람의 홈에 남기지 않는다, TD-9) */
  const home = (): string => join(tmp, 'home');
  /** 이 시험의 X 도구 환경 — 이 시험의 화면만 */
  const xenv = (): NodeJS.ProcessEnv => ({
    PATH: '/usr/bin:/bin',
    HOME: home(),
    XDG_CONFIG_HOME: join(home(), '.config'),
    XDG_CACHE_HOME: join(home(), '.cache'),
    XDG_DATA_HOME: join(home(), '.local', 'share'),
    XDG_STATE_HOME: join(home(), '.local', 'state'),
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    DISPLAY: display,
    XAUTHORITY: auth,
    DBUS_SESSION_BUS_ADDRESS: busAddress,
    XDG_RUNTIME_DIR: join(tmp, 'run'),
  });
  const x = (cmd: string, args: string[]): string => execFileSync(cmd, args, { env: xenv(), encoding: 'utf8', timeout: 10_000 }).trim();
  const start = (cmd: string, args: string[]): ChildProcess => {
    const p = spawn(cmd, args, { env: xenv(), stdio: 'ignore' });
    procs.push(p);
    return p;
  };
  /** 그 화면의 주인 확인 (제품과 같은 곁 도우미 파일의 --identity — 연결만 하고 아무것도 보내지 않는다) */
  const identityOf = (d: string): { ok: boolean; pid?: number; detail?: string } =>
    JSON.parse(execFileSync('python3', ['-I', '-B', '-s', join(process.cwd(), 'resources', 'desktophelper', 'x11Sidecar.py'), '--identity', d.slice(1)], { env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, encoding: 'utf8', timeout: 5000 }).trim()) as { ok: boolean; pid?: number; detail?: string };
  const xtestDown = (): number => (x('xinput', ['query-state', 'Virtual core XTEST keyboard']).match(/=down/g) ?? []).length;

  const call = (tool: string, args: Record<string, unknown> = {}): Promise<ToolCallResult> => orch.core.tools.handle(mainOpsIdentity(), tool, args);
  /**
   * 횟수 상한이면 1초 뒤, 사람 입력 멈춤이면 풀릴 때까지 다시 부른다 — 새로 띄운 Xvfb는 '마지막 입력'이 그 서버가 뜬 때라 처음 30초는 멈춘다(Windows의 부팅 직후와 같다).
   * 사람 입력을 보는 시험은 이것을 쓰지 않는다
   */
  async function paced(tool: string, args: Record<string, unknown> = {}): Promise<ToolCallResult> {
    for (let i = 0; i < 60; i++) {
      const r = await call(tool, args);
      if (r.ok || (r.code !== 'rate_limited' && r.code !== 'human_active')) return r;
      if (r.code === 'human_active') humanWaits.push(`${tool} ${new Date().toISOString()}`);
      await sleep(r.code === 'rate_limited' ? 1100 : 2000);
    }
    return call(tool, args);
  }
  /** 사람 입력 멈춤을 기다린 때 (시험 끝에 몇 번인지 본다 — 도우미가 자기 주입을 사람으로 읽으면 늘어난다) */
  const humanWaits: string[] = [];
  const data = <T>(r: ToolCallResult): T => {
    if (!r.ok) throw new Error(`거부: ${r.code} ${r.message}`);
    return r.data as T;
  };
  let seq = 0;
  const input = async (args: Record<string, unknown>): Promise<GuiInputResult> => data<GuiInputResult>(await paced('gui_input', { request_id: `real-x11-${Date.now()}-${++seq}`, then_capture: false, ...args }));
  const shoot = async (): Promise<ScreenCaptureResult> => data<ScreenCaptureResult>(await paced('screen_capture', { max_width: 1280 }));
  async function editorWindow() {
    const info = data<ScreenInfoResult>(await paced('screen_info'));
    const win = info.windows.find((w) => w.title.includes(basename(file)));
    if (!win) throw new Error(`편집기 창을 찾지 못했습니다 (창 ${info.windows_total}개)`);
    return win;
  }

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'wook-real-x11-'));
    dataDir = mkdtempSync(join(tmp, 'data-'));
    workRoot = mkdtempSync(join(tmp, 'work-'));
    file = join(tmp, `wook-real-${Date.now()}.txt`);
    writeFileSync(file, '');
    mkdirSync(home(), { recursive: true });
    mkdirSync(join(tmp, 'run'), { mode: 0o700 });
    auth = join(tmp, 'xauth');
    const cookie = randomBytes(16);
    writeWildCookie(auth, cookie);
    // 화면: 번호는 Xvfb가 고른다(-displayfd 3)
    // -nolisten local 없이: X 서버가 추상 이름을 쥔다 (SC-1·SC-2)
    const xvfb = spawn('Xvfb', ['-displayfd', '3', '-auth', auth, '-nolisten', 'tcp', '-s', '0', '-screen', '0', '1280x800x24'], {
      stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
      env: { PATH: '/usr/bin:/bin' },
    });
    procs.push(xvfb);
    xvfbPid = xvfb.pid!;
    const fd3 = xvfb.stdio[3] as NodeJS.ReadableStream;
    display = await new Promise<string>((resolve, reject) => {
      let buf = '';
      const t = setTimeout(() => reject(new Error('Xvfb가 10초 안에 화면 번호를 말하지 않았습니다')), 10_000);
      fd3.on('data', (d: Buffer) => {
        buf += d.toString('utf8');
        const m = /^(\d+)\n/.exec(buf);
        if (m) {
          clearTimeout(t);
          resolve(`:${m[1]}`);
        }
      });
    });
    // 이 화면의 주인(추상 이름과 소켓 파일을 쥔 프로세스)이 이 시험의 Xvfb다 — 이 시험의 xdotool 등도 이 이름으로 붙는다 (연결만 하고 아무것도 보내지 않는다)
    expect(identityOf(display)).toEqual({ ok: true, pid: xvfbPid });
    // 세션 버스 (AT-SPI가 쓴다)
    const bus = spawn('dbus-daemon', ['--session', '--nofork', '--nopidfile', `--address=unix:path=${join(tmp, 'bus')}`, '--print-address=1'], { stdio: ['ignore', 'pipe', 'ignore'], env: { PATH: '/usr/bin:/bin', HOME: home(), XDG_CONFIG_HOME: join(home(), '.config'), XDG_CACHE_HOME: join(home(), '.cache') } });
    procs.push(bus);
    busAddress = await new Promise<string>((resolve, reject) => {
      let buf = '';
      const t = setTimeout(() => reject(new Error('세션 버스가 뜨지 않았습니다')), 10_000);
      bus.stdout!.on('data', (d: Buffer) => {
        buf += d.toString('utf8');
        const l = buf.split('\n')[0];
        if (buf.includes('\n') && l) {
          clearTimeout(t);
          resolve(l.trim());
        }
      });
    });
    execFileSync('xauth', ['-f', auth, 'add', display, '.', cookie.toString('hex')], { env: { PATH: '/usr/bin:/bin' }, stdio: 'ignore', timeout: 5000 });
    // 쿠키 없는 연결은 거부된다 (이 화면은 이 시험만 쓴다)
    expect(() => execFileSync('xdpyinfo', [], { env: { PATH: '/usr/bin:/bin', DISPLAY: display, XAUTHORITY: '/dev/null' }, stdio: 'ignore', timeout: 5000 })).toThrow();
    start('openbox', []);
    for (let i = 0; i < 50; i++) {
      try {
        if (/window id/.test(x('xprop', ['-root', '_NET_SUPPORTING_WM_CHECK']))) break;
      } catch {
        // 아직
      }
      await sleep(100);
    }
    // Num Lock을 켠 채로 모든 시험을 한다 — 보내는 글자는 숫자판을 쓰지 않으니 그대로여야 한다 (SC-3)
    x('xdotool', ['key', 'Num_Lock']);
    expect(x('xset', ['q'])).toMatch(/Num Lock:\s+on/);
    editor = start('mousepad', [file]);
    for (let i = 0; i < 100; i++) {
      try {
        if (x('xdotool', ['search', '--name', basename(file)])) break;
      } catch {
        // 아직
      }
      await sleep(100);
    }
    await sleep(800);
    // 제품의 문: 이 화면 (이 시험이 띄운 Xvfb). 도우미는 서버 환경의 세션 버스 주소를 받는다
    for (const k of ['WOOK_REAL_DESKTOP_DISPLAY', 'WOOK_REAL_DESKTOP_XPID', 'DBUS_SESSION_BUS_ADDRESS', 'DISPLAY', 'XAUTHORITY', 'WAYLAND_DISPLAY', 'XDG_SESSION_TYPE']) savedEnv[k] = process.env[k];
    process.env.WOOK_REAL_DESKTOP_DISPLAY = display;
    // 이 시험이 띄운 Xvfb의 PID — 문은 그 X 서버가 이 화면의 주인일 때만 연다 (SC-2)
    process.env.WOOK_REAL_DESKTOP_XPID = String(xvfbPid);
    process.env.DBUS_SESSION_BUS_ADDRESS = busAddress;
    delete process.env.DISPLAY;
    delete process.env.XAUTHORITY;
    delete process.env.WAYLAND_DISPLAY;
    const deps = await buildOrchestratorDeps({
      dataDir,
      appRoot: process.cwd(),
      isPackaged: false,
      nodeExecPath: process.execPath,
      nodeExecEnv: {},
      shell: null,
      memorySecrets: true,
      mode: 'server',
      workspaceRoot: workRoot,
      // 운영자가 server.json에 적는 화면 (리드 결정 S10-7.7)
      screen: { enabled: true, display, xauthority: auth },
      // 화면 세션의 환경은 이 시험이 적는다 — 이 PC의 화면 변수는 읽지 않는다
      screenEnv: {},
    });
    if (!deps.desktop) throw new Error('실제 X11 화면 도우미가 붙지 않았습니다 — 문(WOOK_REAL_DESKTOP·HOST)·화면을 확인하세요');
    deps.store.kv.set('settings', { developer: { mainAgentMock: true, mockSpeed: 25 } });
    const stub = { installed: true, path: 'stub', version: '9.9.9', loggedIn: true, problem: null, detail: '시험용 고정 CLI 상태' };
    deps.adapters.claude = { ...deps.adapters.claude, detect: async () => stub };
    deps.adapters.codex = { ...deps.adapters.codex, detect: async () => stub };
    orch = await createOrchestrator(deps);
  }, 180_000);

  afterAll(async () => {
    try {
      if (display) x('xdotool', ['keyup', 'shift']);
    } catch {
      // 확인용 — 화면이 이미 없을 수 있다
    }
    await orch?.stop().catch(() => undefined);
    // 이 시험이 띄운 것을 그 핸들로 끝낸다 (기록한 PID로 죽이지 않는다)
    for (const p of procs.reverse()) {
      if (p.exitCode === null && p.signalCode === null) p.kill('SIGTERM');
    }
    await sleep(500);
    for (const p of procs) if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL');
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (tmp) await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
  }, 60_000);

  it('편집기: 캡처 → 이동(포인터가 그 실제 픽셀) → 클릭 → 안녕하세요 → Ctrl+S → 파일에 그 글', async () => {
    const win = await editorWindow();
    expect(win.blocked).toBe(false);
    const cap = await shoot();
    expect(cap.image === 'attached' || cap.image === 'text_only').toBe(true);
    const cx = Math.floor((win.x + win.width / 2 - cap.origin.x) / cap.scale);
    const cy = Math.floor((win.y + win.height / 2 - cap.origin.y) / cap.scale);
    const moved = await input({ action: 'move', capture_id: cap.capture_id, x: cx, y: cy });
    const loc = x('xdotool', ['getmouselocation', '--shell']);
    expect([Number(/X=(\d+)/.exec(loc)![1]), Number(/Y=(\d+)/.exec(loc)![1])]).toEqual([moved.real!.x, moved.real!.y]);
    const clicked = await input({ action: 'click', capture_id: cap.capture_id, x: cx, y: cy });
    expect(clicked.focus?.title).toContain(basename(file));
    const typed = await input({ action: 'type', capture_id: cap.capture_id, text: '안녕하세요' });
    expect(typed.focus?.password).toBe(false);
    await input({ action: 'key', capture_id: cap.capture_id, keys: 'ctrl+s' });
    let text = '';
    for (let i = 0; i < 25 && text !== '안녕하세요'; i++) {
      await sleep(200);
      text = readFileSync(file, 'utf8');
    }
    expect(text).toBe('안녕하세요');
  }, 180_000);

  it('글자 입력이 정확하다: 한국어·섞인 글·문장 부호·200자를 열 번씩 쳐서 저장한 파일이 바이트까지 같다 (S10-7.2)', async () => {
    // 잡는 결함: xdotool이 한 키 자리를 바꿔 가며 쳐서 앱이 옛 배열로 읽음 — '안녕하세요'가 '안하세요'·'안세세요'가 됨 (Xvfb에서 본 것)
    const pool = '가나다라마바사아자차카타파하한글입력시험욱채서버화면조작 abcXYZ019.,!?';
    let r200 = '';
    let s = 7;
    for (let i = 0; i < 200; i++) {
      s = (s * 1103515245 + 12345) % 2147483648;
      r200 += pool[s % pool.length];
    }
    const texts = ['안녕하세요', 'Hello 안녕 World! 123 한글과 English 섞기', "~!@#$%^&*()_+{}|:\"<>?`-=[]\\;',./ 가나다", r200];
    // 캡처는 30초 뒤 쓸 수 없다 — 15초마다 새로 찍는다 (턴당 캡처 상한 60 안에서)
    let cap = await shoot();
    let capAt = Date.now();
    const failures: string[] = [];
    // 도우미가 자기 주입(키 배열 바꾸기 포함)을 사람 입력으로 읽으면 멈춤이 걸린다 — 치는 동안 한 번도 없어야 한다
    const waitsBefore = humanWaits.length;
    for (let round = 1; round <= 10; round++) {
      for (const t of texts) {
        if (Date.now() - capAt > 15_000) {
          cap = await shoot();
          capAt = Date.now();
        }
        await input({ action: 'key', capture_id: cap.capture_id, keys: 'ctrl+a' });
        await input({ action: 'key', capture_id: cap.capture_id, keys: 'delete' });
        await input({ action: 'type', capture_id: cap.capture_id, text: t });
        await input({ action: 'key', capture_id: cap.capture_id, keys: 'ctrl+s' });
        let got = Buffer.alloc(0);
        for (let i = 0; i < 25; i++) {
          await sleep(150);
          got = readFileSync(file);
          if (got.equals(Buffer.from(t, 'utf8'))) break;
        }
        if (!got.equals(Buffer.from(t, 'utf8'))) failures.push(`${round}회 ${t.slice(0, 12)}… → ${got.toString('utf8').slice(0, 40)}`);
      }
    }
    expect(failures).toEqual([]);
    expect(humanWaits.slice(waitsBefore)).toEqual([]);
  }, 900_000);

  it('Caps Lock이 켜져 있어도(메인 에이전트가 capslock 키를 눌렀어도) type과 글자 키는 보낸 그대로 — Num Lock도 켜진 채 (SC-3)', async () => {
    // 잡는 결함: Caps Lock이 켜진 X 화면에서 'abc Hello'가 'ABC hELLO'로, 글자 키 'A'가 'a'로 들어감 (검토가 Xvfb에서 본 것)
    const cap = await shoot();
    await input({ action: 'key', capture_id: cap.capture_id, keys: 'ctrl+a' });
    await input({ action: 'key', capture_id: cap.capture_id, keys: 'delete' });
    await input({ action: 'key', capture_id: cap.capture_id, keys: 'capslock' });
    try {
      expect(x('xset', ['q'])).toMatch(/Caps Lock:\s+on/);
      await input({ action: 'type', capture_id: cap.capture_id, text: 'abc Hello 123' });
      await input({ action: 'key', capture_id: cap.capture_id, keys: 'A' });
      // Caps Lock은 켜진 채로 돌아왔다 (사람의 상태를 바꿔 두지 않는다)
      expect(x('xset', ['q'])).toMatch(/Caps Lock:\s+on/);
      await input({ action: 'key', capture_id: cap.capture_id, keys: 'ctrl+s' });
    } finally {
      await input({ action: 'key', capture_id: cap.capture_id, keys: 'capslock' });
    }
    expect(x('xset', ['q'])).toMatch(/Caps Lock:\s+off\s+01: Num Lock:\s+on/);
    let got = '';
    for (let i = 0; i < 25 && got !== 'abc Hello 123A'; i++) {
      await sleep(150);
      got = readFileSync(file, 'utf8');
    }
    expect(got).toBe('abc Hello 123A');
  }, 180_000);

  it('암호 칸(zenity --password, GTK 4)에는 글자를 치지 않는다 — secret_blocked. GTK 4.14는 암호 칸을 보통 글 칸(text)으로 내놓아 도우미는 "가를 수 없음"으로 본다', async () => {
    // 잡는 결함: AT-SPI 역할만 보고(password text가 아니니 보통 칸) GTK 4 암호 칸에 비밀번호를 침 — 이 Xvfb에서 처음 돌렸을 때 실제로 쳤다
    const dlg = start('zenity', ['--password', '--title', 'wook-real-password']);
    try {
      for (let i = 0; i < 100; i++) {
        try {
          if (x('xdotool', ['search', '--name', 'wook-real-password'])) break;
        } catch {
          // 아직
        }
        await sleep(100);
      }
      await sleep(1500);
      const cap = await shoot();
      const r = await paced('gui_input', { request_id: `real-x11-pw-${Date.now()}`, action: 'type', capture_id: cap.capture_id, text: 'hunter2', then_capture: false });
      expect(r).toMatchObject({ ok: false, code: 'secret_blocked' });
      expect(!r.ok && r.message).toContain('확인하지 못해');
    } finally {
      dlg.kill('SIGTERM');
    }
    await sleep(800);
  }, 120_000);

  it('무장한 동안 밖에서 포인터를 움직이면(사람 입력) human_active', async () => {
    // 잡는 결함: 쉼 시간이 XTEST 입력에도 되돌아가는데 도우미 밖의 입력을 사람으로 보지 않음
    const cap = await shoot();
    await sleep(600);
    x('xdotool', ['mousemove', '20', '20']);
    let r: ToolCallResult | null = null;
    for (let i = 0; i < 20; i++) {
      await sleep(300);
      r = await call('gui_input', { request_id: `real-x11-human-${Date.now()}-${i}`, action: 'move', capture_id: cap.capture_id, x: 100, y: 100, then_capture: false });
      if (!r.ok && r.code === 'human_active') break;
    }
    expect(r).toMatchObject({ ok: false, code: 'human_active' });
  }, 120_000);

  it('Shift가 눌린 채 긴급 정지하면 3초 안에 끝나고 키가 풀리고 화면 도우미가 없다 — 요약은 완료', async () => {
    // 사람 입력 멈춤(30초)이 풀리기를 기다린다 — 무장해야 하므로
    for (let i = 0; i < 40; i++) {
      const r = await call('screen_capture', { max_width: 640 });
      if (r.ok) break;
      await sleep(1000);
    }
    expect(orch.core.desktop.peek()?.armed()).toBe(true);
    const helperPid = orch.core.desktop.peek()!.pid!;
    x('xdotool', ['keydown', 'shift']);
    expect(xtestDown()).toBeGreaterThan(0);
    const t0 = Date.now();
    const summary = await orch.core.stops.emergency(OPERATOR);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect([summary.completed, summary.failures]).toEqual([true, []]);
    expect(xtestDown()).toBe(0);
    expect(orch.core.desktop.peek()?.pid ?? null).toBeNull();
    let alive = true;
    try {
      process.kill(helperPid, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
    expect(await call('screen_capture', {})).toMatchObject({ ok: false, code: 'stopped' });
  }, 180_000);

  it('조작 중 표시: 실제 화면처럼 다룬 도우미는 무장하면 테두리를 띄우고, 캡처 동안 걷어 PNG에 없다 · 멈춤 단축키(xdotool로 누름)는 HOTKEY (S10-7.4·S10-7.5)', async () => {
    // Xvfb에서 볼 수 있는 것만: 테두리 창이 뜨고, 캡처에 찍히지 않고, 놓으면 사라진다. 사람 눈에 보이는지는 Xvfb에서 볼 수 없다 (보고서)
    const screens = mkdtempSync(join(tmp, 'screens-'));
    const launcher = createX11DesktopLauncher({
      dataDir,
      appRoot: process.cwd(),
      nodePath: process.execPath,
      display,
      xauthority: auth,
      typeWithoutA11y: false,
      log: () => undefined,
      extraEnv: { WOOK_X11_FORCE_REAL: '1' },
    });
    const client = createDesktopHelper({ launcher, log: () => undefined, screensDir: () => screens });
    const events: string[] = [];
    client.onEvent((e) => events.push(e.type));
    try {
      const ready = await client.ready();
      expect(ready.ok).toBe(true);
      expect(client.readyInfo()?.tokens).toMatchObject({ virtual: '0', sidecar: '1' });
      const arm = await client.request({ verb: 'ARM', policy: { pids: [], titles: [], titlePrefixes: [] } });
      expect(arm).toMatchObject({ ok: true, value: { hotkey: true } });
      const indicators = (): string[] => x('xwininfo', ['-root', '-tree']).split('\n').filter((l) => l.includes('"wook-indicator"'));
      expect(indicators()).toHaveLength(4);
      const cap = await client.request({ verb: 'CAPTURE', screen: 1, maxEdge: 1280, id: 'SC-0000001' });
      if (!cap.ok) throw new Error(JSON.stringify(cap));
      const png = decodePng(readFileSync(join(screens, 'SC-0000001.png')));
      const orange = ([r, g, b]: [number, number, number]) => Math.abs(r - 0xe6) < 40 && Math.abs(g - 0x51) < 40 && b < 60;
      const edge: [number, number][] = [
        [1, 1],
        [png.width - 2, 1],
        [1, png.height - 2],
        [png.width - 2, png.height - 2],
        [Math.floor(png.width / 2), 1],
        [1, Math.floor(png.height / 2)],
      ];
      expect(edge.filter(([px, py]) => orange(png.at(px, py)))).toEqual([]);
      // 캡처 뒤 다시 떠 있다 (무장한 채)
      const mapped = x('xwininfo', ['-root', '-tree']).split('\n').filter((l) => l.includes('"wook-indicator"')).map((l) => /0x[0-9a-f]+/.exec(l)![0]);
      expect(mapped.every((id) => /IsViewable/.test(x('xwininfo', ['-id', id])))).toBe(true);
      // 멈춤 단축키
      x('xdotool', ['key', 'ctrl+alt+shift+F12']);
      for (let i = 0; i < 30 && !events.includes('hotkey'); i++) await sleep(100);
      expect(events).toContain('hotkey');
      await sleep(300);
      expect(indicators()).toHaveLength(0);
    } finally {
      await client.dispose();
    }
  }, 120_000);

  /** 이 시험의 화면에 붙는 도우미 하나 (제품의 문을 지나 — 오케스트레이터 없이) */
  const helperClient = (o: { display?: string; xauthority?: string; env?: NodeJS.ProcessEnv; tools?: Record<string, string[]>; sidecarCommand?: string[]; extraEnv?: Record<string, string> } = {}) => {
    const screens = mkdtempSync(join(tmp, 'screens-'));
    const launcher = createX11DesktopLauncher({
      dataDir,
      appRoot: process.cwd(),
      nodePath: process.execPath,
      display: o.display ?? display,
      xauthority: o.xauthority ?? auth,
      typeWithoutA11y: false,
      log: () => undefined,
      ...(o.env ? { env: o.env } : {}),
      ...(o.tools ? { tools: o.tools } : {}),
      ...(o.sidecarCommand ? { sidecarCommand: o.sidecarCommand } : {}),
      ...(o.extraEnv ? { extraEnv: o.extraEnv } : {}),
    });
    return { launcher, client: createDesktopHelper({ launcher, log: () => undefined, screensDir: () => screens }) };
  };
  const okv = <T,>(r: { ok: true; value: T } | { ok: false }): T => {
    if (!r.ok) throw new Error(`실패: ${JSON.stringify(r)}`);
    return r.value;
  };

  it('Shift Lock이 잠겨 있어도 type·단축키는 보낸 그대로, 끝나면 Shift Lock은 다시 잠긴 채 (Lock 수정 키에 Shift_Lock을 단 자판 — SC-3)', async () => {
    // 잡는 결함: Caps_Lock만 눌러 풀면 Shift가 잠긴 채 남아 '1'이 '!'로, ctrl+s가 ctrl+S(다른 이름으로 저장)로 감 (이 시험이 처음에 잡은 것)
    const free = x('xmodmap', ['-pke']).split('\n').map((l) => /^keycode\s+(\d+)\s*=\s*$/.exec(l)?.[1]).filter((v): v is string => !!v).map(Number).filter((k) => k > 8)[0]!;
    x('xmodmap', ['-e', `keycode ${free} = Shift_Lock`, '-e', 'add lock = Shift_Lock']);
    const { client } = helperClient();
    try {
      x('xdotool', ['key', 'Shift_Lock']);
      // Shift_Lock은 Shift와 Lock을 함께 잠근다 (두 표시등)
      expect(x('xset', ['q'])).toMatch(/Caps Lock:\s+on/);
      expect(x('xset', ['q'])).toMatch(/Shift Lock:\s+on/);
      expect((await client.ready()).ok).toBe(true);
      const layout = okv(await client.request({ verb: 'SCREENS' })).layout;
      okv(await client.request({ verb: 'ARM', policy: { pids: [], titles: [], titlePrefixes: [] } }));
      // 편집기 창의 가운데 (창 관리자가 놓은 자리)
      const g = Object.fromEntries(x('xdotool', ['search', '--name', basename(file), 'getwindowgeometry', '--shell']).split('\n').map((l) => l.split('=') as [string, string]));
      const cx = Number(g.X) + Math.floor(Number(g.WIDTH) / 2);
      const cy = Number(g.Y) + Math.floor(Number(g.HEIGHT) / 2);
      okv(await client.request({ verb: 'CLICK', x: cx, y: cy, button: 'left', count: 1, layout }));
      okv(await client.request({ verb: 'KEY', combo: 'ctrl+a', layout }));
      okv(await client.request({ verb: 'KEY', combo: 'delete', layout }));
      okv(await client.request({ verb: 'TYPE', text: 'abc 123 Hello!', layout }));
      okv(await client.request({ verb: 'KEY', combo: 'ctrl+s', layout }));
      let got = '';
      for (let i = 0; i < 25 && got !== 'abc 123 Hello!'; i++) {
        await sleep(150);
        got = readFileSync(file, 'utf8');
      }
      expect(got).toBe('abc 123 Hello!');
      // 처음대로 다시 잠겼다
      expect(x('xset', ['q'])).toMatch(/Caps Lock:\s+on/);
      expect(x('xset', ['q'])).toMatch(/Shift Lock:\s+on/);
    } finally {
      await client.dispose();
      // 이 시험이 잠근 것을 푼다: 잠긴 Shift는 Shift를 한 번, Lock은 Caps_Lock
      x('xdotool', ['key', 'shift']);
      if (/Caps Lock:\s+on/.test(x('xset', ['q']))) x('xdotool', ['key', 'Caps_Lock']);
      x('xmodmap', ['-e', 'remove lock = Shift_Lock', '-e', `keycode ${free} =`]);
    }
    expect(x('xset', ['q'])).toMatch(/Caps Lock:\s+off/);
    expect(x('xset', ['q'])).toMatch(/Shift Lock:\s+off/);
  }, 120_000);

  it('메뉴·팝업 같은 관리되지 않는 창(override-redirect)이 덮은 자리는 그 주인으로 본다 — 주인을 모르는 창에는 누르지 않는다 (SC-6)', async () => {
    // 잡는 결함: 관리되는 창 목록만 보고 위에 뜬 팝업(서버 터미널의 메뉴 등)에 클릭이 감 (검토의 P-override)
    const log = join(tmp, 'or.txt');
    const py = [
      'import sys,time',
      'from Xlib import X, display',
      'd=display.Display(); s=d.screen()',
      'w=s.root.create_window(300,250,300,200,0,s.root_depth,X.InputOutput,X.CopyFromParent,background_pixel=s.white_pixel,override_redirect=True,event_mask=X.ButtonPressMask)',
      'w.set_wm_name("욱채 popup".encode()); w.map(); w.raise_window(); d.sync()',
      "open(sys.argv[1],'a').write('mapped\\n')",
      'end=time.time()+40',
      'while time.time()<end:',
      '    while d.pending_events():',
      '        e=d.next_event()',
      "        if e.type==X.ButtonPress: open(sys.argv[1],'a').write('pressed\\n')",
      '    time.sleep(0.05)',
    ].join('\n');
    const or = start('python3', ['-I', '-c', py, log]);
    const { client } = helperClient();
    try {
      for (let i = 0; i < 50 && !(existsSync(log) && readFileSync(log, 'utf8').includes('mapped')); i++) await sleep(100);
      expect((await client.ready()).ok).toBe(true);
      const layout = okv(await client.request({ verb: 'SCREENS' })).layout;
      okv(await client.request({ verb: 'ARM', policy: { pids: [], titles: [], titlePrefixes: ['욱채'] } }));
      const r = await client.request({ verb: 'CLICK', x: 450, y: 350, button: 'left', count: 1, layout });
      expect(r).toMatchObject({ ok: false, kind: 'err', reason: 'BLOCKED_TARGET' });
      await sleep(500);
      expect(readFileSync(log, 'utf8').includes('pressed')).toBe(false);
    } finally {
      await client.dispose();
      or.kill('SIGTERM');
    }
  }, 120_000);

  it('추상 이름을 가로챈 프로세스: -nolisten local로 띄운 다른 화면의 이름을 다른 프로세스가 쥐면 도우미는 foreign으로 거부하고 쿠키를 보내지 않는다 · 아무도 쥐지 않으면 noabstract · 문은 시험이 적은 X 서버에만 (SC-1·SC-2)', async () => {
    // 잡는 결함: libxcb가 추상 이름을 먼저 써서 가로챈 프로세스가 X 도구의 연결과 쿠키를 받음 (검토의 P-squat)
    const authC = join(tmp, 'xauth-c');
    const cookieC = randomBytes(16);
    writeWildCookie(authC, cookieC);
    // 번호는 지금 비어 있는 것을 고른다(정해 둔 번호가 아니다). -displayfd만 주면 안 된다: -nolisten local인 Xvfb는 잠금 파일을 쓰지 않는 -displayfd로 이미 쓰이는
    // :0을 다시 골라 이 시험의 화면의 소켓 파일을 제 것으로 바꾼다 — 그때 주인 확인은 이 시험의 화면을 foreign으로 본다 [Xvfb에서 본 것]
    const used = new Set<number>();
    for (const l of readFileSync('/proc/net/unix', 'utf8').split('\n')) {
      const m = /\/tmp\/\.X11-unix\/X(\d+)$/.exec(l.trim());
      if (m) used.add(Number(m[1]));
    }
    for (const f of existsSync('/tmp/.X11-unix') ? readdirSync('/tmp/.X11-unix') : []) {
      const m = /^X(\d+)$/.exec(f);
      if (m) used.add(Number(m[1]));
    }
    let free = 1;
    while (used.has(free) || existsSync(`/tmp/.X${free}-lock`)) free++;
    const xc = spawn('Xvfb', [`:${free}`, '-displayfd', '3', '-auth', authC, '-nolisten', 'tcp', '-nolisten', 'local', '-s', '0', '-screen', '0', '640x480x24'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe'], env: { PATH: '/usr/bin:/bin' } });
    procs.push(xc);
    const numC = await new Promise<string>((resolve, reject) => {
      let buf = '';
      const t = setTimeout(() => reject(new Error('두 번째 Xvfb가 번호를 말하지 않았습니다')), 10_000);
      (xc.stdio[3] as NodeJS.ReadableStream).on('data', (d: Buffer) => {
        buf += d.toString('utf8');
        const m = /^(\d+)\n/.exec(buf);
        if (m) {
          clearTimeout(t);
          resolve(m[1]!);
        }
      });
    });
    execFileSync('xauth', ['-f', authC, 'add', `:${numC}`, '.', cookieC.toString('hex')], { env: { PATH: '/usr/bin:/bin' }, stdio: 'ignore', timeout: 5000 });
    // 문은 그 화면(:C, 그 Xvfb의 PID)으로 연다. 준비의 Xvfb 확인은 도구 이음매로 건너뛰어(실제 도구를 그대로 넘긴다) 도우미 자신의 주인 확인을 본다 —
    // 운영 서버에서 처음 붙는 것도 이 도우미다. 곁 도우미는 주인 확인 뒤에야 뜬다
    const real = resolveX11Tools();
    expect(real.missing).toEqual([]);
    const gateC = { ...process.env, WOOK_REAL_DESKTOP_DISPLAY: `:${numC}`, WOOK_REAL_DESKTOP_XPID: String(xc.pid) };
    const atC = { display: `:${numC}`, xauthority: authC, env: gateC, tools: real.tools, sidecarCommand: [real.python3!, '-I', '-B', '-s'] };
    try {
      // (1) 아무도 추상 이름을 쥐지 않았다 → noabstract
      const a = helperClient(atC);
      expect(await a.client.ready()).toEqual({ ok: false, kind: 'unavailable', code: 'no_desktop', text: NO_DESKTOP_TEXTS.noabstract });
      await a.client.dispose();
      // (2) 다른 프로세스가 그 이름을 쥐었다 → foreign, 그 프로세스는 아무것도(쿠키도) 받지 않았다
      const verdict = join(tmp, 'squat.txt');
      const squat = [
        'import socket,os,sys',
        's=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)',
        "s.bind('\\0/tmp/.X11-unix/X'+sys.argv[1]); s.listen(8); s.settimeout(30)",
        "want=bytes.fromhex(os.environ['WANT']); out=open(sys.argv[2],'a',buffering=1); out.write('listening\\n')",
        'while True:',
        '  try: c,_=s.accept()',
        '  except Exception: break',
        "  c.settimeout(2); d=b''",
        '  try:',
        '    while len(d)<4096:',
        '      b=c.recv(4096)',
        '      if not b: break',
        '      d+=b',
        '  except Exception: pass',
        "  out.write('conn bytes=%d cookie=%s\\n'%(len(d), want in d))",
        '  c.close()',
      ].join('\n');
      const sq = spawn('python3', ['-I', '-c', squat, numC, verdict], { env: { PATH: '/usr/bin:/bin', WANT: cookieC.toString('hex') }, stdio: 'ignore' });
      procs.push(sq);
      for (let i = 0; i < 50 && !(existsSync(verdict) && readFileSync(verdict, 'utf8').includes('listening')); i++) await sleep(100);
      const b = helperClient(atC);
      expect(await b.client.ready()).toEqual({ ok: false, kind: 'unavailable', code: 'no_desktop', text: NO_DESKTOP_TEXTS.foreign });
      await b.client.dispose();
      await sleep(300);
      const lines = readFileSync(verdict, 'utf8').trim().split('\n').filter((l) => l.startsWith('conn'));
      // 주인 확인은 연결만 하고 아무것도 보내지 않는다 — 쿠키를 받은 연결이 없다
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.filter((l) => !l.startsWith('conn bytes=0 cookie=False'))).toEqual([]);
      sq.kill('SIGTERM');
      // (3) 문: 시험이 적어 둔 X 서버 PID가 아니면 준비가 거부한다 (붙지도 않는다)
      const c = helperClient({ env: { ...process.env, WOOK_REAL_DESKTOP_XPID: '1' } });
      const r = await c.client.ready();
      // 준비(실행기)가 먼저 거부한다 — 도우미의 notours는 그 뒤의 두 번째 벽이다
      expect(r.ok ? '' : r.text).toContain(`${display}의 주인이 그 Xvfb가 아닙니다 (PID ${xvfbPid})`);
      await c.client.dispose();
    } finally {
      xc.kill('SIGTERM');
    }
    // 이 시험의 화면은 그대로 이 시험의 Xvfb 것이다
    expect(identityOf(display)).toEqual({ ok: true, pid: xvfbPid });
  }, 120_000);

  // ───── 검토 2차의 고침 (S10c2, 리드 결정 S10-17) ─────

  /** 이 시험의 도우미로 편집기 창 가운데를 눌러 포커스를 주고 비운다 */
  async function focusEditor(client: ReturnType<typeof helperClient>['client'], layout: string): Promise<void> {
    const g = Object.fromEntries(x('xdotool', ['search', '--name', basename(file), 'getwindowgeometry', '--shell']).split('\n').map((l) => l.split('=') as [string, string]));
    const cx = Number(g.X) + Math.floor(Number(g.WIDTH) / 2);
    const cy = Number(g.Y) + Math.floor(Number(g.HEIGHT) / 2);
    okv(await client.request({ verb: 'CLICK', x: cx, y: cy, button: 'left', count: 1, layout }));
    okv(await client.request({ verb: 'KEY', combo: 'ctrl+a', layout }));
    okv(await client.request({ verb: 'KEY', combo: 'delete', layout }));
  }
  /** 저장한 파일이 그 글이 될 때까지 (3초까지) */
  async function savedAs(want: string): Promise<string> {
    let got = '';
    for (let i = 0; i < 20 && got !== want; i++) {
      await sleep(150);
      got = readFileSync(file, 'utf8');
    }
    return got;
  }
  const NO_POLICY = { pids: [], titles: [], titlePrefixes: [] };

  it('사람이 긴 type 도중에 포인터를 계속 움직이면(다른 프로세스의 XTEST) 다음 묶음 전에 HUMAN_ACTIVE와 HUMAN — 보낸 글자가 친 글보다 적다 · 아무도 없으면 긴 type이 끝까지 정확하다 (S10c2 FSD-1)', async () => {
    // 잡는 결함: 묶음이 잇달아 가서 사람 입력 보기가 사람을 보지 못하고 TYPE이 OK로 끝남 (검토 2차 R8: 400자 TYPE 동안 3초를 움직여도 OK, HUMAN 없음) ·
    // 거꾸로 도우미 자신의 묶음을 사람으로 봄 (아무도 없는 긴 type이 잡는다 — 그때는 HUMAN_ACTIVE로 끊긴다)
    const { client } = helperClient();
    const events: string[] = [];
    client.onEvent((e) => events.push(e.type));
    let mover: ChildProcess | null = null;
    try {
      expect((await client.ready()).ok).toBe(true);
      const layout = okv(await client.request({ verb: 'SCREENS' })).layout;
      okv(await client.request({ verb: 'ARM', policy: NO_POLICY }));
      await focusEditor(client, layout);
      // 아무도 없음: 400자 — 끝까지 가고, 저장한 파일이 같고, HUMAN이 없다
      const quiet = 'The quick brown fox jumps over the lazy dog 0123456789. '.repeat(8).slice(0, 400);
      okv(await client.request({ verb: 'TYPE', text: quiet, layout }));
      okv(await client.request({ verb: 'KEY', combo: 'ctrl+s', layout }));
      expect(await savedAs(quiet)).toBe(quiet);
      expect(events.filter((e) => e === 'human')).toEqual([]);
      okv(await client.request({ verb: 'KEY', combo: 'ctrl+a', layout }));
      okv(await client.request({ verb: 'KEY', combo: 'delete', layout }));
      // 사람: 다른 프로세스가 20ms마다 포인터를 1픽셀씩 움직인다 (실제 마우스처럼 쉼 시간이 0으로)
      const text = 'abcdefghij'.repeat(60);
      const typing = client.request({ verb: 'TYPE', text, layout });
      await sleep(800);
      mover = start('bash', ['-c', 'for i in $(seq 1 400); do xdotool mousemove_relative -- 1 0; sleep 0.02; done']);
      const t0 = Date.now();
      const r = await typing;
      const sent = !r.ok && r.kind === 'err' ? r.sent : null;
      // 보고서의 근거 (vitest --silent=false)
      console.log(`FSD-1 real: TYPE ${text.length} -> ${r.ok ? 'OK' : `${r.kind} ${'reason' in r ? r.reason : ''} sent=${String(sent)}`}, answered ${Date.now() - t0} ms after the mover started; events ${JSON.stringify(events)}`);
      expect(r).toMatchObject({ ok: false, kind: 'err', reason: 'HUMAN_ACTIVE' });
      expect(sent).not.toBeNull();
      expect(sent!).toBeLessThan(text.length);
      expect(events).toContain('human');
    } finally {
      if (mover && mover.exitCode === null && mover.signalCode === null) mover.kill('SIGTERM');
      await client.dispose();
      await sleep(200);
    }
  }, 180_000);

  it('Caps Lock(그리고 Shift Lock)이 켜진 채 type 도중에 정지하면 정지 뒤에도 켜져 있다 — 도우미가 STOP OK를 내기 전에 되돌린다 (S10c2 FSD-2)', async () => {
    // 잡는 결함: 되돌리기가 TYPE의 finally에만 있어, STOP OK를 받은 클라이언트가 도우미의 묶음을 SIGKILL로 끝내면 사람의 Caps Lock이 꺼진 채 남음
    // (검토 2차 R4: 300·700·1100·2500ms에 멈춘 네 번 모두 꺼짐)
    const q = () => x('xset', ['q']);
    const free = x('xmodmap', ['-pke']).split('\n').map((l) => /^keycode\s+(\d+)\s*=\s*$/.exec(l)?.[1]).filter((v): v is string => !!v).map(Number).filter((k) => k > 8)[0]!;
    for (const mode of ['caps', 'shiftlock'] as const) {
      if (mode === 'caps') x('xdotool', ['key', 'Caps_Lock']);
      else {
        x('xmodmap', ['-e', `keycode ${free} = Shift_Lock`, '-e', 'add lock = Shift_Lock']);
        x('xdotool', ['key', 'Shift_Lock']);
      }
      const { client } = helperClient();
      try {
        expect(q()).toMatch(/Caps Lock:\s+on/);
        if (mode === 'shiftlock') expect(q()).toMatch(/Shift Lock:\s+on/);
        expect((await client.ready()).ok).toBe(true);
        const layout = okv(await client.request({ verb: 'SCREENS' })).layout;
        okv(await client.request({ verb: 'ARM', policy: NO_POLICY }));
        await focusEditor(client, layout);
        const typing = client.request({ verb: 'TYPE', text: 'uvwxyzabcd'.repeat(40), layout });
        await sleep(700);
        // 치는 동안에는 풀려 있다
        expect(q()).toMatch(/Caps Lock:\s+off/);
        const stop = await client.stop('시험');
        expect(stop).toMatchObject({ ok: true, acked: true, exited: true });
        await typing;
        expect(q()).toMatch(/Caps Lock:\s+on/);
        if (mode === 'shiftlock') expect(q()).toMatch(/Shift Lock:\s+on/);
      } finally {
        await client.dispose();
        // 이 시험이 잠근 것을 푼다
        if (mode === 'shiftlock') x('xdotool', ['key', 'shift']);
        if (/Caps Lock:\s+on/.test(q())) x('xdotool', ['key', 'Caps_Lock']);
        if (mode === 'shiftlock') x('xmodmap', ['-e', 'remove lock = Shift_Lock', '-e', `keycode ${free} =`]);
      }
      expect(q()).toMatch(/Caps Lock:\s+off/);
      expect(q()).toMatch(/Shift Lock:\s+off/);
    }
  }, 180_000);

  it('세션 버스가 없거나 그 주소가 죽었어도 곁 도우미는 살아 멈춤 단축키를 잡고 조작 중 표시를 띄운다 — AT-SPI만 빠진다(a11y=0) (S10c2 FSD-5)', async () => {
    // 잡는 결함: Atspi.init()이 C 수준에서 곁 도우미 프로세스를 끝내(코어 덤프) 단축키·표시까지 잃음 — 버스가 없을 때(검토 2차 R9)도, 죽은 주소일 때(S10c2가 Xvfb에서 봄)도
    for (const bus of [undefined, `unix:path=${join(tmp, 'no-such-bus')}`]) {
      const { client } = helperClient({ env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: bus }, extraEnv: { WOOK_X11_FORCE_REAL: '1' } });
      try {
        expect((await client.ready()).ok).toBe(true);
        expect(client.readyInfo()?.tokens).toEqual({ virtual: '0', sidecar: '1', a11y: '0' });
        expect(await client.request({ verb: 'ARM', policy: NO_POLICY })).toMatchObject({ ok: true, value: { hotkey: true } });
        expect(x('xwininfo', ['-root', '-tree']).split('\n').filter((l) => l.includes('"wook-indicator"'))).toHaveLength(4);
      } finally {
        await client.dispose();
      }
    }
  }, 120_000);

  it('무장한 동안 X 서버가 끝나고 다른 프로세스가 그 이름을 잡아도 쿠키가 간 연결은 하나까지다 — 붙지 못한 도구 뒤에는 주인을 다시 본다 (S10c2 FSD-3)', async () => {
    // 잡는 결함: 사람 입력 보기의 xprintidle이 250ms마다, 주인을 다시 볼 때(2초)까지 가로챈 쪽에 붙어 쿠키를 보냄 (검토 2차 R3: 7번)
    const used = new Set<number>();
    for (const l of readFileSync('/proc/net/unix', 'utf8').split('\n')) {
      const m = /\/tmp\/\.X11-unix\/X(\d+)$/.exec(l.trim());
      if (m) used.add(Number(m[1]));
    }
    for (const f of existsSync('/tmp/.X11-unix') ? readdirSync('/tmp/.X11-unix') : []) {
      const m = /^X(\d+)$/.exec(f);
      if (m) used.add(Number(m[1]));
    }
    let n = 1;
    while (used.has(n) || existsSync(`/tmp/.X${n}-lock`)) n++;
    // 쿠키 파일은 설치 안내처럼 그 화면 번호의 줄 하나만 (와일드카드 줄 없이 — Xvfb는 -auth 파일의 쿠키를 모두 받는다)
    const authD = join(tmp, 'xauth-d');
    const cookieD = randomBytes(16);
    writeFileSync(authD, '', { mode: 0o600 });
    execFileSync('xauth', ['-f', authD, 'add', `:${n}`, '.', cookieD.toString('hex')], { env: { PATH: '/usr/bin:/bin' }, stdio: 'ignore', timeout: 5000 });
    // 가로챈 쪽이 받았을 쿠키 (같은 값을 따로 둔다 — 시험이 아는 값)
    const oldAuth = join(tmp, 'xauth-d-old');
    writeFileSync(oldAuth, '', { mode: 0o600 });
    execFileSync('xauth', ['-f', oldAuth, 'add', `:${n}`, '.', cookieD.toString('hex')], { env: { PATH: '/usr/bin:/bin' }, stdio: 'ignore', timeout: 5000 });
    const xd = spawn('Xvfb', [`:${n}`, '-auth', authD, '-nolisten', 'tcp', '-s', '0', '-screen', '0', '800x600x24'], { stdio: 'ignore', env: { PATH: '/usr/bin:/bin' } });
    procs.push(xd);
    for (let i = 0; i < 50 && !existsSync(`/tmp/.X11-unix/X${n}`); i++) await sleep(100);
    const envD = { ...xenv(), DISPLAY: `:${n}`, XAUTHORITY: authD };
    const ob = spawn('openbox', [], { env: envD, stdio: 'ignore' });
    procs.push(ob);
    for (let i = 0; i < 50; i++) {
      try {
        if (/window id/.test(execFileSync('xprop', ['-root', '_NET_SUPPORTING_WM_CHECK'], { env: envD, encoding: 'utf8', timeout: 5000 }))) break;
      } catch {
        // 아직
      }
      await sleep(100);
    }
    // 가로채는 프로세스: 그 이름이 풀릴 때까지 2ms마다 묶어 보고, 붙은 연결마다 X 연결 머리(쿠키 자리)를 읽어 쿠키인지만 적는다 (쿠키 자체는 적지 않는다)
    const verdict = join(tmp, 'squat-d.txt');
    const squat = [
      'import socket,os,sys,struct,time',
      "n=sys.argv[1]; out=open(sys.argv[2],'a',buffering=1); want=bytes.fromhex(os.environ['WANT'])",
      's=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM); end=time.time()+15',
      'while True:',
      "  try: s.bind('\\0/tmp/.X11-unix/X'+n); break",
      '  except OSError:',
      "    if time.time()>end: out.write('nobind\\n'); sys.exit(0)",
      '    time.sleep(0.002)',
      "s.listen(16); s.settimeout(8); out.write('listening\\n')",
      'while True:',
      '  try: c,_=s.accept()',
      '  except Exception: break',
      "  c.settimeout(2); d=b''",
      '  try:',
      '    while len(d)<12:',
      '      b=c.recv(4096)',
      '      if not b: break',
      '      d+=b',
      '    if len(d)>=12:',
      "      f='<' if d[0:1]==b'l' else '>'; nl,dl=struct.unpack(f+'HH',d[6:10]); need=12+((nl+3)//4)*4+((dl+3)//4)*4",
      '      while len(d)<need:',
      '        b=c.recv(4096)',
      '        if not b: break',
      '        d+=b',
      "      out.write('conn cookie=%s mono=%d\\n'%(d[12+((nl+3)//4)*4:12+((nl+3)//4)*4+dl]==want, int(time.monotonic()*1000)))",
      "    else: out.write('conn bytes=%d mono=%d\\n'%(len(d), int(time.monotonic()*1000)))",
      "  except Exception as e: out.write('err %s\\n'%type(e).__name__)",
      '  c.close()',
    ].join('\n');
    const gateD = { ...process.env, WOOK_REAL_DESKTOP_DISPLAY: `:${n}`, WOOK_REAL_DESKTOP_XPID: String(xd.pid) };
    const { client } = helperClient({ display: `:${n}`, xauthority: authD, env: gateD });
    let sq: ChildProcess | null = null;
    try {
      expect((await client.ready()).ok).toBe(true);
      okv(await client.request({ verb: 'SCREENS' }));
      sq = spawn('python3', ['-I', '-c', squat, String(n), verdict], { env: { PATH: '/usr/bin:/bin', WANT: cookieD.toString('hex') }, stdio: 'ignore' });
      procs.push(sq);
      await sleep(300);
      okv(await client.request({ verb: 'ARM', policy: NO_POLICY }));
      // X 서버가 끝난다 (운영자가 Xvfb 유닛을 다시 시작함·죽음) — 아무 명령도 보내지 않는다: 무장한 도우미의 사람 입력 보기만 돈다
      const killMono = Number(process.hrtime.bigint() / 1_000_000n);
      xd.kill('SIGTERM');
      for (let i = 0; i < 200 && !(existsSync(verdict) && readFileSync(verdict, 'utf8').includes('listening')); i++) await sleep(10);
      expect(readFileSync(verdict, 'utf8')).toContain('listening');
      await sleep(3000);
      const next = await client.request({ verb: 'SCREENS' });
      // 가로챈 쪽이 받은 연결 — 쿠키가 든 것과 주인 확인(0바이트), X 서버를 끝낸 때부터 몇 ms 뒤인지 (둘 다 CLOCK_MONOTONIC)
      const conns = readFileSync(verdict, 'utf8')
        .split('\n')
        .filter((l) => l.startsWith('conn'))
        .map((l) => l.replace(/mono=(\d+)/, (_m, t: string) => `+${Number(t) - killMono}ms`));
      // 보고서의 근거 (vitest --silent=false)
      console.log(`FSD-3 real: squatter connections ${JSON.stringify(conns)}; next command -> ${JSON.stringify(next)}`);
      expect(next).toMatchObject({ ok: false, kind: 'err', reason: 'NO_DESKTOP' });
      expect(conns.filter((l) => l.startsWith('conn cookie=True')).length).toBeLessThanOrEqual(1);
      // 주인 확인은 붙기만 했다 (아무것도 보내지 않음) — 그 연결이 있다
      expect(conns.some((l) => l.startsWith('conn bytes=0'))).toBe(true);
      // 설치 안내의 고친 유닛처럼 X 서버가 다시 뜰 때마다 새 쿠키를 쓰면(ExecStartPre의 xauth add — 그 줄을 바꾼다) 가로챈 옛 쿠키로는 붙지 못한다 (리드 결정 S10-17 FSD-3 a)
      await client.dispose();
      const squatter = sq;
      squatter.kill('SIGTERM');
      await new Promise<void>((r) => (squatter.exitCode !== null || squatter.signalCode !== null ? r() : squatter.once('exit', () => r())));
      execFileSync('xauth', ['-f', authD, 'add', `:${n}`, '.', randomBytes(16).toString('hex')], { env: { PATH: '/usr/bin:/bin' }, stdio: 'ignore', timeout: 5000 });
      expect(execFileSync('xauth', ['-f', authD, 'list'], { env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 5000 }).trim().split('\n')).toHaveLength(1);
      const xd2 = spawn('Xvfb', [`:${n}`, '-auth', authD, '-nolisten', 'tcp', '-s', '0', '-screen', '0', '800x600x24'], { stdio: 'ignore', env: { PATH: '/usr/bin:/bin' } });
      procs.push(xd2);
      try {
        for (let i = 0; i < 50 && !existsSync(`/tmp/.X11-unix/X${n}`); i++) await sleep(100);
        const opens = (a: string): boolean => {
          try {
            execFileSync('xdpyinfo', [], { env: { PATH: '/usr/bin:/bin', DISPLAY: `:${n}`, XAUTHORITY: a }, stdio: 'ignore', timeout: 5000 });
            return true;
          } catch {
            return false;
          }
        };
        expect([opens(oldAuth), opens(authD)]).toEqual([false, true]);
      } finally {
        xd2.kill('SIGTERM');
      }
    } finally {
      await client.dispose();
      if (sq && sq.exitCode === null && sq.signalCode === null) sq.kill('SIGTERM');
      if (ob.exitCode === null && ob.signalCode === null) ob.kill('SIGTERM');
    }
  }, 120_000);

  it('Wayland처럼 보이는 환경·화면 없음은 맞는 unavailable이다 (실제 도우미를 띄우지 않는다)', async () => {
    const base = { appRoot: process.cwd(), isPackaged: false, nodeExecPath: process.execPath, nodeExecEnv: {}, shell: null, memorySecrets: true, mode: 'server' as const };
    // 시험은 이 PC의 화면 변수를 읽지 않는다 — 화면 세션의 환경은 이 시험이 적는다 (screenEnv)
    const d1 = await buildOrchestratorDeps({ ...base, dataDir: mkdtempSync(join(tmp, 'd1-')), screen: { enabled: null }, screenEnv: { WAYLAND_DISPLAY: 'wayland-0', DISPLAY: display, XAUTHORITY: auth } });
    expect([!!d1.desktop, d1.screenOff?.code]).toEqual([false, 'wayland']);
    d1.store.close();
    d1.runner.dispose?.();
    const d2 = await buildOrchestratorDeps({ ...base, dataDir: mkdtempSync(join(tmp, 'd2-')), screen: { enabled: null }, screenEnv: {} });
    expect([!!d2.desktop, d2.screenOff?.code]).toEqual([false, 'no_desktop']);
    d2.store.close();
    d2.runner.dispose?.();
  }, 60_000);

  it('이 시험이 띄운 메인 턴은 모두 모의 실행이다 — 실제 CLI는 뜨지 않았다', () => {
    const turns = orch.core.ctx.store.turns.list({ ref1: MAIN_AGENT_ID });
    expect(turns.filter((t) => !t.mock)).toEqual([]);
  });
});
