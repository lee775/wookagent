/**
 * X11 화면 도우미(resources/desktophelper/x11Helper.mjs)를 가짜 X 도구(./fakeX11Tool.mjs)·가짜 곁 도우미(./fakeX11Sidecar.mjs)·가짜 /proc으로 띄우는 시험 도구 (S10c).
 * 진짜 도우미 스크립트를 띄운다 — X 서버에는 붙지 않는다(Windows·WSL에서 돈다). 장면은 이 실행의 임시 폴더의 JSON 파일이고, 가짜 도구가 읽고 바꾼다.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDesktopHelper, type DesktopHelperOptions } from '../../../src/main/desktop/desktopHelper';
import type { DesktopHelperClient, DesktopHelperLauncher } from '../../../src/main/desktop/types';

export const X11_HELPER_SCRIPT_PATH = fileURLToPath(new URL('../../../resources/desktophelper/x11Helper.mjs', import.meta.url));
export const FAKE_X11_TOOL = fileURLToPath(new URL('./fakeX11Tool.mjs', import.meta.url));
export const FAKE_X11_SIDECAR = fileURLToPath(new URL('./fakeX11Sidecar.mjs', import.meta.url));
export const X11_TOOL_NAMES = ['xdotool', 'maim', 'xprop', 'xwininfo', 'xrandr', 'xinput', 'xprintidle', 'xdpyinfo', 'xmodmap', 'xset'] as const;
export const FAKE_X11_IDENTITY = fileURLToPath(new URL('./fakeX11Identity.mjs', import.meta.url));
/** 가짜 /proc에서 도우미 자신(WOOK_X11_PROC_SELF)과 그 조상: 900 도우미 → 800 서버 → 700 bash → 600 터미널 → 1 */
export const PROC_SELF = 900;
export const PROC_TERMINAL = 600;
/** 이 시험이 쓰는 uid (Linux는 진짜 uid, Windows는 1000) */
export const TEST_UID = typeof process.getuid === 'function' ? process.getuid() : 1000;

export interface FakeX11Window {
  id: number;
  pid?: number | null;
  machine?: string | null;
  title: string;
  cls?: [string, string];
  /** 틀 안(클라이언트)의 절대 자리·크기 */
  x: number;
  y: number;
  w: number;
  h: number;
  /** _NET_FRAME_EXTENTS 왼·오른·위·아래 */
  frame?: [number, number, number, number];
  /** 창 관리자의 틀 창 (있으면 루트의 자식은 이 틀이고 창은 그 안에 든다) */
  frameId?: number;
  state?: string;
  type?: string;
  mapped?: boolean;
}

export interface FakeX11Scene {
  display: 'ok' | 'fail' | 'xwayland';
  virtual: boolean;
  wm: boolean;
  screens: { name: string; x: number; y: number; w: number; h: number; mmw: number; mmh: number; primary?: boolean }[];
  /** 아래 → 위 (_NET_CLIENT_LIST_STACKING 차례) */
  windows: FakeX11Window[];
  active: number | null;
  lastInputAt: number;
  /** 가짜 도구의 '지금'이 뒤로 가지 않게 하는 닻: 장면을 만든 때의 벽시계와 단조 시계(hrtime ms). 쉼 시간은 이 시계로 센다 (fakeX11Tool.mjs steadyNow) */
  clock?: { wall: number; monoMs: number };
  keysDown: number[];
  buttonsDown: number[];
  keymap: { free: number[]; syms: Record<string, string>; mapped?: Record<string, string> };
  /** 화면의 주인 확인의 답 (fakeX11Identity.mjs) */
  identity: { ok: true; pid: number } | { ok: false; detail: string };
  /** 관리되지 않는 창 (override-redirect — 위가 먼저, 늘 관리되는 창 위) */
  unmanaged: (FakeX11Window & { transientFor?: number })[];
  capsLock: boolean;
  numLock: boolean;
  /** 잠긴 Shift (xset q의 Shift Lock 표시등) */
  shiftLock: boolean;
  typed: Record<string, string>;
  keys: string[];
  clicks: number;
  pointer: [number, number];
  typeMoveFocus: { after: number; to: number } | null;
  clickActive: number;
  failTools: string[];
  sidecar: {
    xlib?: boolean;
    grab?: boolean;
    atspi?: boolean;
    password?: boolean | null;
    control?: string | null;
    indicator?: boolean;
    hotkeyAfterArmMs?: number;
    locked?: boolean;
    /** 표준 입력이 닫혀도 끝나지 않는다 (프로세스 묶음 SIGKILL만 끝낸다 — 장면 폴더가 지워지면 스스로 끝난다) */
    ignoreEof?: boolean;
    /** S10c2 (FSD-5): 첫 줄(hello)을 내기 전에 프로세스가 끝난다 */
    exitBeforeHello?: boolean;
    /** S10c2 (FSD-5): hello 뒤 이만큼 지나 프로세스가 끝난다 */
    exitAfterHelloMs?: number;
    /** S10c2 (FSD-5): xlib false일 때 그 까닭 — import(python3-xlib 없음) · connect(화면에 붙지 못함, 기본) */
    xlibWhy?: 'import' | 'connect';
  };
  /**
   * S10c2 (FSD-1): 사람 — 도우미의 xdotool이 type(또는 mousemove)을 n번 보낸 그 호출이 끝날 때부터 everyMs마다 입력한다 (xprintidle이 본다). from은 가짜 도구가 적는다
   */
  person?: { after: 'type' | 'mousemove'; n: number; everyMs: number; from?: number | null };
  /** S10c2 (FSD-4): 그 도구가 이만큼 늦게 끝난다 (ms) */
  toolDelayMs?: Partial<Record<(typeof X11_TOOL_NAMES)[number], number>>;
  /** 가짜 xdotool이 센 type·mousemove 수 */
  typeCalls?: number;
  moveCalls?: number;
}

export interface FakeX11Options {
  /** 곁 도우미를 붙인다 (가짜). 없으면 곁 도우미 없음 */
  sidecar?: boolean;
  typeUnknown?: boolean;
  requireXvfb?: boolean;
  /** 시험 문의 X 서버 PID (WOOK_X11_REQUIRE_XPID) */
  requireXpid?: number;
  forceReal?: boolean;
}

export function defaultScene(): FakeX11Scene {
  const me = hostname();
  return {
    display: 'ok',
    virtual: true,
    wm: true,
    screens: [{ name: 'screen', x: 0, y: 0, w: 1280, h: 800, mmw: 339, mmh: 212 }],
    windows: [
      { id: 0xa00003, pid: 4242, machine: me, title: '최소화된 창', x: 0, y: 0, w: 100, h: 100, state: '_NET_WM_STATE_HIDDEN', mapped: false },
      { id: 0x900003, pid: null, title: 'PID 없는 창', x: 1100, y: 600, w: 100, h: 100 },
      { id: 0x800003, pid: 4242, machine: 'other-host', title: '다른 기계의 창', x: 1100, y: 400, w: 100, h: 100 },
      { id: 0x700003, pid: 4343, machine: me, title: 'root 창', x: 1000, y: 100, w: 200, h: 200 },
      { id: 0x600003, pid: 4545, machine: me, title: '욱채 화면', x: 1000, y: 350, w: 50, h: 40 },
      { id: 0x500003, pid: PROC_TERMINAL, machine: me, title: '서버를 띄운 터미널', cls: ['gnome-terminal-server', 'Gnome-terminal'], x: 100, y: 100, w: 800, h: 700, frame: [1, 1, 20, 5] },
      { id: 0x400003, pid: 4242, machine: me, title: '메모.txt - Mousepad', cls: ['mousepad', 'Mousepad'], x: 320, y: 167, w: 640, h: 480, frame: [1, 1, 20, 5], frameId: 0x200175 },
    ],
    active: 0x400003,
    lastInputAt: Date.now() - 600_000,
    clock: { wall: Date.now(), monoMs: Number(process.hrtime.bigint() / 1_000_000n) },
    keysDown: [],
    buttonsDown: [],
    keymap: { free: [93, 97, 103, 120, 132, 149, 154, 168], syms: { '50': 'Shift_L', '37': 'Control_L', '64': 'Alt_L', '66': 'Caps_Lock' } },
    identity: { ok: true, pid: 4000 },
    unmanaged: [],
    capsLock: false,
    numLock: false,
    shiftLock: false,
    typed: {},
    keys: [],
    clicks: 0,
    pointer: [0, 0],
    typeMoveFocus: null,
    clickActive: 0x400003,
    failTools: [],
    sidecar: { xlib: true, grab: true, atspi: true, password: false, control: 'text' },
  };
}

export interface FakeX11 {
  readonly dir: string;
  readonly screensDir: string;
  readonly launcher: DesktopHelperLauncher;
  scene(): FakeX11Scene;
  set(patch: Partial<FakeX11Scene>): void;
  /** 도구 호출 기록 ({tool, args}) */
  calls(): { t: number; tool: string; args: string[] }[];
  client(o?: Partial<DesktopHelperOptions>): DesktopHelperClient;
  cleanup(): Promise<void>;
}

function procEntry(root: string, pid: number, comm: string, ppid: number, start: number, uid: number): void {
  const d = join(root, String(pid));
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'stat'), `${pid} (${comm}) S ${ppid} 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0 ${start} 0 0\n`);
  writeFileSync(join(d, 'status'), `Name:\t${comm}\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`);
  writeFileSync(join(d, 'comm'), `${comm}\n`);
}

export function createFakeX11(patch: Partial<FakeX11Scene> = {}, o: FakeX11Options = {}): FakeX11 {
  const dir = mkdtempSync(join(tmpdir(), 'wook-fakex11-'));
  const screensDir = join(dir, 'screens');
  const procRoot = join(dir, 'proc');
  mkdirSync(screensDir, { recursive: true });
  const scenePath = join(dir, 'scene.json');
  const logPath = join(dir, 'calls.jsonl');
  writeFileSync(scenePath, JSON.stringify({ ...defaultScene(), ...patch }));
  writeFileSync(logPath, '');
  procEntry(procRoot, PROC_SELF, 'node', 800, 5000, TEST_UID);
  procEntry(procRoot, 800, 'node', 700, 4000, TEST_UID);
  procEntry(procRoot, 700, 'bash', PROC_TERMINAL, 3000, TEST_UID);
  procEntry(procRoot, PROC_TERMINAL, 'gnome-terminal-', 1, 2000, TEST_UID);
  procEntry(procRoot, 4242, 'mousepad', 1, 6000, TEST_UID);
  procEntry(procRoot, 4545, 'node', 1, 6000, TEST_UID);
  procEntry(procRoot, 4343, 'rootapp', 1, 6000, 0);

  const launcher: DesktopHelperLauncher = {
    launch: () => {
      const env: Record<string, string> = {};
      // 진짜 화면 변수는 넘기지 않는다 — 가짜 도구는 X에 붙지 않지만, 도우미가 사람의 화면 이름을 보지 않게 (WSL의 DISPLAY=:0은 대표의 Windows 화면)
      for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string' && !['DISPLAY', 'XAUTHORITY', 'WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS'].includes(k)) env[k] = v;
      const tools: Record<string, string[]> = {};
      for (const n of X11_TOOL_NAMES) tools[n] = [process.execPath, FAKE_X11_TOOL, n];
      Object.assign(env, {
        DISPLAY: ':7',
        WOOK_X11_TOOLS: JSON.stringify(tools),
        WOOK_FAKE_X11: scenePath,
        WOOK_FAKE_X11_LOG: logPath,
        WOOK_X11_PROC_ROOT: procRoot,
        WOOK_X11_PROC_SELF: String(PROC_SELF),
        WOOK_X11_TEST_UID: String(TEST_UID),
      });
      if (o.sidecar) env.WOOK_X11_SIDECAR = JSON.stringify([process.execPath, FAKE_X11_SIDECAR]);
      if (o.typeUnknown) env.WOOK_X11_TYPE_UNKNOWN = '1';
      if (o.requireXvfb) env.WOOK_X11_REQUIRE_XVFB = '1';
      if (o.requireXpid !== undefined) env.WOOK_X11_REQUIRE_XPID = String(o.requireXpid);
      env.WOOK_X11_IDENTITY = JSON.stringify([process.execPath, FAKE_X11_IDENTITY]);
      if (o.forceReal) env.WOOK_X11_FORCE_REAL = '1';
      return { file: process.execPath, args: [X11_HELPER_SCRIPT_PATH], env };
    },
  };
  const scene = (): FakeX11Scene => JSON.parse(readFileSync(scenePath, 'utf8')) as FakeX11Scene;
  return {
    dir,
    screensDir,
    launcher,
    scene,
    set: (p) => {
      const tmp = `${scenePath}.test.tmp`;
      writeFileSync(tmp, JSON.stringify({ ...scene(), ...p }));
      // 가짜 도구가 읽는 중에 반쯤 쓴 파일을 보지 않게 이름 바꾸기로
      renameSync(tmp, scenePath);
    },
    calls: () =>
      existsSync(logPath)
        ? readFileSync(logPath, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((l) => JSON.parse(l) as { t: number; tool: string; args: string[] })
        : [],
    client: (extra = {}) =>
      createDesktopHelper({
        launcher,
        log: () => undefined,
        screensDir: () => screensDir,
        // 가짜 도구 하나하나가 Node 프로세스라 실제 도구보다 느리다 — 명령의 시간 상한을 넉넉히
        timeouts: { READY: 30_000, SCREENS: 20_000, WINDOWS: 30_000, FOCUS: 20_000, CAPTURE: 30_000, MOVE: 30_000, CLICK: 30_000, SCROLL: 30_000, KEY: 30_000, DRAG: 60_000, TYPE: 60_000, ARM: 20_000, RELEASE: 20_000 },
        ...extra,
      }),
    cleanup: () => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
  };
}
