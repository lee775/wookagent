/**
 * 화면 도우미 클라이언트 (SERVER_DESIGN 8.3.2, 리드 결정 S6-4·S6-5). 오래 떠 있는 도우미 프로세스 하나와 한 줄 명령을 주고받는다.
 * 프로토콜은 ./types.ts 머리말. 실제 도우미는 resources/desktophelper/DesktopHelper.cs(WookDesktopHelper.exe, ./realHelper.ts가 띄운다),
 * 시험은 tests/fixtures/desktop/fakeDesktopHelper.mjs (Node 가짜 — 모든 시험의 기본).
 *
 * - 띄우기: 처음 쓸 때(acquire·ready). 이음매 launcher가 준비(prepare, 비동기 — 컴파일)와 명세(launch, 동기 — 해시 확인)를 주고, launch가
 *   돌아온 같은 동기 구간에서 띄운다. 직접 띄운다(windowsHide, 파이프, unref) — 러너의 작업 개체 안이 아니다(러너의 표준 입력은 그 제어 채널).
 *   Node(libuv)가 자식을 KILL_ON_JOB_CLOSE 작업 개체(0x3C00)에 넣으므로 서버가 끝나면(죽어도) 도우미도 끝난다. 도우미는 프로세스를 띄우지 않는다.
 *   POSIX(X11 도우미 x11Helper.mjs — 도구·곁 도우미를 자식으로 띄운다): 따로 프로세스 묶음으로 띄우고, 끝낼 때 그 묶음에 SIGKILL을 보낸다. 서버가 죽으면 도우미는
 *   표준 입력이 닫혀(EOF) 키를 떼고 스스로 끝난다 (리드 결정 S10-7.9).
 * - 한 번에 하나: 요청 슬롯(acquire → send → end). 처리기는 슬롯을 쥔 뒤 같은 동기 구간에서 검사하고 줄을 쓴다(S6-6 7단계 — send는 동기로 쓴다).
 *   STOP·RELEASE는 슬롯 밖에서 바로 쓴다.
 * - 시간 상한(DESKTOP_TIMEOUTS): 어느 명령이든(입력·캡처·창·포커스·ARM) 넘으면 그 도우미에 STOP을 쓰고 끝낸다(상한에 센다) — 답하지 않는 도우미를 남겨
 *   두지 않는다. 입력은 보냈는지 모른다. RELEASE의 무응답은 부른 쪽(lifecycle)이 STOP으로 잇는다 — 새 도우미로 하는 표시 위의 놓기(release countFailure)만
 *   다른 명령처럼 여기서 멈추고 센다 (S6-23 M2). 늦게 온 답은 (도우미, 번호)로 맞춰 버린다 (리드 결정 S6-21 A3).
 * - 무장 표시(armed)는 도우미가 보낸 줄의 순서를 따른다: ARM 답·RELEASE 답·HOTKEY·STOP OK를 읽는 그때 바꾸고, 입력이 RELEASED·STOPPED로 돌아오면 푼다 (S6-23 M3).
 * - 정지의 결과는 버리지 않는다: 정지 한 번이 끝날 때마다 'stopped' 알림을 낸다(스스로 한 정지 — 시간 초과·긴 줄·쉼 — 도). 끝남을 확인하지 못한 도우미는
 *   쥐고 있는다(leaving) — 그동안 stop은 그 도우미의 같은 정지를 주고, 새 도우미를 띄우지 않는다(두 도우미가 겹치지 않게). confirmExit가 한 번 더 끝내 확인한다
 *   (리드 결정 S6-21 A1·A3b). 한 번도 무장하지 않은 도우미는 뗄 키가 없다 — 끝남만 확인하면 그 정지는 성공이다 (A3c).
 * - 다시 띄우기 상한: 시작 실패·뜻밖의 종료·시간 초과·긴 줄이 앱 수명 동안 3번이면 다시 시작할 때까지 helper_failed — 센 수만 본다. 이미 센(시작 실패) 도우미와
 *   끝내는 중인 도우미가 준비 전에 보낸 줄은 읽지 않는다(늦은 READY가 상한을 풀지 않는다, 리드 결정 S6-21 H1). 세지 않는 것: STOP(긴급 정지·교체·턴 끝의
 *   무응답)·dispose·쉼(10분 무장 해제 상태)·화면 세션 없음(FAIL NO_DESKTOP — 60초 동안 다시 띄우지 않음). 해시가 다름·csc 없음·컴파일 실패는
 *   launcher가 띄우기를 거부한다(곧바로 쓸 수 없음, 세지 않음).
 * - 줄 상한 1MiB — 넘으면 STOP을 쓰고 끝낸다(센다). 로그에는 명령 이름과 길이만, 오류 출력은 가린 첫 줄만 남긴다 (TYPE 글자·base64를 남기지 않는다, AC-20).
 *
 * 이 파일은 Node 형식 제거로도 불러와진다(시험의 '서버와 함께 끝남' 확인 — tests/fixtures/desktop/serverHost.mjs): 런타임 import는 node: 모듈만,
 * ./types는 import type으로만, 지울 수 있는 TS 문법만 쓴다 (매개변수 속성·enum 금지).
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type {
  DesktopHelperClient,
  DesktopHelperEvent,
  DesktopHelperLauncher,
  DesktopHelperProblem,
  DesktopPolicy,
  DesktopReadyInfo,
  DesktopTimeouts,
  HelperArm,
  HelperCapture,
  HelperErrReason,
  HelperFailure,
  HelperFocus,
  HelperLease,
  HelperRequest,
  HelperResult,
  HelperScreens,
  HelperUnavailable,
  HelperVerb,
  HelperWindows,
  LockKind,
  ReleaseResult,
  ReplyOf,
  StopResult,
} from './types';

/** DesktopHelper.cs ProtocolVersion · compiledTool.ts DESKTOP_HELPER_TOOL.protocolVersion과 같아야 한다 */
export const DESKTOP_PROTOCOL_VERSION = 3;

/** 명령마다 TS 쪽 시간 상한 (ms, 리드 결정 S6-5) */
export const DESKTOP_TIMEOUTS: Readonly<DesktopTimeouts> = Object.freeze({
  READY: 10_000,
  SCREENS: 3000,
  WINDOWS: 3000,
  FOCUS: 2000,
  CAPTURE: 5000,
  MOVE: 2000,
  CLICK: 2000,
  SCROLL: 2000,
  KEY: 3500,
  DRAG: 5000,
  TYPE: 5000, // S6F2b: 포커스를 처음과 끝에 한 번씩 읽는다 (각 1.5초까지 — 리드 결정 S6-23 K2)
  TYPE_PER_CHAR: 80, // S6F2b: 4자마다 포커스를 다시 읽는다 (0.25초까지) — 2,000자의 가장 늦은 경우 약 137초 < 165초 (guiDeniedTargets가 셈해 본다)
  ARM: 1000,
  RELEASE: 1000,
  STOP_ACK: 800,
  STOP_CONFIRM: 2800,
});

/** 시작 실패·뜻밖의 종료가 이만큼이면 다시 시작할 때까지 띄우지 않는다 */
export const MAX_HELPER_FAILURES = 3;
/** 화면 세션 없음(FAIL NO_DESKTOP)을 기억하는 시간 — 그동안 띄우지 않는다 */
export const NO_DESKTOP_CACHE_MS = 60_000;
/** 무장 해제 상태로 이만큼 쓰지 않으면 도우미를 끝낸다 (세지 않는다) */
export const HELPER_IDLE_MS = 10 * 60_000;
/** 도우미가 보내는 한 줄의 상한 (창 목록 JSON) — 넘으면 끝낸다 */
export const MAX_HELPER_LINE = 1024 * 1024;
/** 슬롯을 쥔 채 요청 없이 이만큼 지나면 돌려받는다 (쥔 쪽이 end를 잊은 경우) */
export const LEASE_IDLE_MS = 15_000;
/** 입력 명령이 시간 상한을 넘었을 때의 글 (리드 결정 S6-5) */
export const INPUT_UNCONFIRMED_TEXT = '보냈는지 확인하지 못했습니다 — 다시 캡처해 확인하세요';
/** 화면 세션 없음 (리드 결정 S6-11, session-safety §4) — Windows 도우미의 FAIL NO_DESKTOP session0·noninteractive */
export const NO_DESKTOP_TEXT =
  '화면 세션 없음 — 서버가 화면 없는 세션(서비스·세션 0·비대화형 작업)에서 돌고 있습니다. 서버 PC의 운영자가 로그온한 사용자 작업으로 다시 띄워야 합니다';
/**
 * X11 도우미의 FAIL NO_DESKTOP 사유마다의 글 (S10c, 리드 결정 S10-7.7). wayland: 그 화면이 Xwayland다(SERVER_DESIGN 8.3.6의 글). nodisplay: 그 화면에 붙지 못했다.
 * notxvfb: 시험 중에는 Xvfb에만 붙는다(리드 결정 S10-7.11 — 사람의 화면을 움직이지 않게)
 */
export const NO_DESKTOP_TEXTS: Readonly<Record<string, string>> = Object.freeze({
  wayland: 'Wayland: X11 세션이나 Xvfb가 필요합니다 — 이 화면은 Wayland(Xwayland)라 화면 조작을 쓸 수 없습니다. 서버 PC의 운영자가 Xvfb 화면을 띄우고 server.json의 screen.display에 그 화면을 적은 뒤 서버를 다시 시작해야 합니다',
  nodisplay:
    '화면에 붙지 못했습니다 — 서버가 쓰는 X 화면(server.json의 screen.display, 없으면 서버의 DISPLAY)이 없거나 권한(screen.xauthority)이 맞지 않습니다. 서버 PC의 운영자가 그 화면을 띄우고 값을 고친 뒤 서버를 다시 시작해야 합니다',
  notxvfb: '시험 중에는 Xvfb 화면에만 붙습니다 — 그 화면의 X 서버가 Xvfb가 아니어서 화면 도우미를 쓰지 않았습니다',
  notours: '시험 중에는 그 시험이 띄운 Xvfb에만 붙습니다 — 그 화면의 X 서버가 시험이 적어 둔 것이 아니어서 화면 도우미를 쓰지 않았습니다',
  // 화면의 주인 확인 (리드 결정 S10-13 SC-1) — 이 사유들에는 X 도구를 하나도 띄우지 않았다 (쿠키를 보내지 않았다)
  noabstract:
    '화면의 X 서버가 추상 소켓 이름(@/tmp/.X11-unix/X<번호>)을 쥐고 있지 않습니다 — -nolisten local로 띄운 화면은 다른 프로그램이 그 이름을 가로채 X 도구의 연결과 쿠키를 받을 수 있어 쓰지 않습니다. 서버 PC의 운영자가 Xvfb를 -nolisten local 없이(-auth와 -nolisten tcp는 둔 채) 다시 띄워야 합니다',
  foreign:
    '화면의 이름(추상 소켓)을 쥔 프로세스가 소켓 파일의 X 서버와 다릅니다 — 다른 프로그램이 그 화면의 이름을 가로챘을 수 있어 쓰지 않았습니다(쿠키도 보내지 않았습니다). 서버 PC의 운영자가 그 이름을 쥔 프로세스를 확인하고 X 서버를 다시 띄워야 합니다',
  otheruser:
    '화면의 X 서버가 서버와 다른 사용자의 것입니다 — 쓰지 않았습니다(쿠키도 보내지 않았습니다). 서버 PC의 운영자가 서버를 돌리는 사용자로 Xvfb를 띄워야 합니다',
  unverified: '화면의 X 서버가 누구인지 확인하지 못해(python3 확인 실패) 쓰지 않았습니다 — 서버 PC의 운영자가 python3를 설치하고 서버를 다시 시작해야 합니다',
  remote: '서버의 DISPLAY가 다른 기계의 화면을 가리킵니다(ssh -X 등) — 이 기계의 화면만 씁니다. 서버 PC의 운영자가 server.json의 screen.display에 이 기계의 화면(예: ":99")을 적어야 합니다',
});
/** FAIL NO_DESKTOP <사유> → 글. Windows의 사유(session0·noninteractive)와 모르는 사유는 예전 글 그대로다 */
export function noDesktopText(detail: string | null | undefined): string {
  return (detail && Object.prototype.hasOwnProperty.call(NO_DESKTOP_TEXTS, detail) ? NO_DESKTOP_TEXTS[detail] : undefined) ?? NO_DESKTOP_TEXT;
}
export const STOP_UNCONFIRMED_KEYS = '화면 도우미: 키·버튼을 뗐는지 확인하지 못했습니다';
export const STOP_UNCONFIRMED_EXIT = '화면 도우미: 끝났는지 확인하지 못했습니다';
/** 끝남을 확인하지 못한 도우미가 남아 있어 새로 띄우지 않을 때의 글 (리드 결정 S6-21 A1 — 도구의 거부 글은 lifecycle.ts UNCONFIRMED_REFUSAL) */
export const HELPER_UNCONFIRMED_TEXT =
  '앞서 멈춘 화면 도우미가 끝났는지 확인하지 못해 새 화면 도우미를 띄우지 않습니다 — 대표가 메인 에이전트를 다시 시작하면 한 번 더 확인합니다. 그래도 안 되면 서버를 다시 시작하세요';
const HELPER_STOPPED_TEXT = '화면 도우미를 멈췄습니다';
const NO_PROCESS_TEXT = '화면 도우미가 떠 있지 않습니다';
/** 표시 위의 놓기(새 도우미)에 답하지 않은 도우미를 멈춘 까닭 — 다시 띄우기 상한에 센다 (S6F2a, 리드 결정 S6-23 M2) */
export const RELEASE_UNANSWERED_STOP = '화면 도우미가 놓기(RELEASE)에 답하지 않아 끝냈습니다';
/** RELEASE의 답 'OK <뗀 수>' */
const RELEASE_OK_RE = /^(\d{1,9})$/;

export const HELPER_ERR_REASONS: readonly HelperErrReason[] = Object.freeze([
  'LOCKED',
  'NO_DESKTOP',
  'STOPPED',
  'RELEASED',
  'HUMAN_ACTIVE',
  'PASSWORD_FIELD',
  'FOCUS_UNKNOWN',
  'BLOCKED_TARGET',
  'ELEVATED_TARGET',
  'LAYOUT_CHANGED',
  'BAD_ARGS',
  'BAD_TEXT', // S6F1b: TYPE의 글에 제어 문자 (리드 결정 S6-21 B1)
  'TIMEOUT',
  'INTERNAL',
] as HelperErrReason[]);

const INPUT_VERBS: ReadonlySet<HelperVerb> = new Set<HelperVerb>(['MOVE', 'CLICK', 'DRAG', 'SCROLL', 'KEY', 'TYPE']);
const LOCK_KINDS: ReadonlySet<string> = new Set<LockKind>(['locked', 'disconnected', 'secure_desktop']);
const CAPTURE_ID_RE = /^SC-\d{6,12}$/;
const LAYOUT_RE = /^[0-9a-f]{8,64}$/;
/** KEY 조합: 공백 없는 ASCII (도우미가 이름을 푼다) */
const COMBO_RE = /^[\x21-\x7e]{1,60}$/;
const COORD_MAX = 1_000_000;

type Log = (level: 'info' | 'warn' | 'error', msg: string, extra?: unknown) => void;

export interface DesktopHelperOptions {
  launcher: DesktopHelperLauncher;
  log: Log;
  /** 도우미 오류 출력의 첫 줄을 사유에 넣기 전에 가린다. 없으면 오류 출력은 사유에 넣지 않는다 */
  redact?: (text: string) => string;
  /** 캡처를 쓸 폴더 (WOOK_DESKTOP_SCREENS) — 띄울 때마다 묻는다 */
  screensDir: () => string;
  /** 시작 때 줄 막는 대상 (WOOK_DESKTOP_POLICY) — 없으면 빈 정책. ARM이 그때의 정책을 다시 준다 */
  policy?: () => DesktopPolicy;
  /** epoch ms 시계 (화면 세션 없음 기억) */
  now?: () => number;
  /** 시험: 시간 상한을 줄인다 */
  timeouts?: Partial<DesktopTimeouts>;
  /** 시험: 쉼 끝내기 시간 */
  idleMs?: number;
  /**
   * 시험 이음매: 끝내기. 기본은 Windows에서 proc.kill(TerminateProcess), 그 밖에서는 그 도우미의 프로세스 묶음 전체에 SIGKILL(도우미는 따로 묶음으로 띄운다 —
   * 곁 도우미·도구 자식도 함께 끝난다, 리드 결정 S10-7.9). 끝나지 않는 도우미를 흉내 낸다
   */
  kill?: (proc: ChildProcessWithoutNullStreams) => void;
  /** 시험 이음매: OS (기본 process.platform) — 띄우는 방식(POSIX는 따로 묶음)과 끝내기를 정한다 */
  platform?: NodeJS.Platform;
}

interface Pending {
  verb: HelperVerb | 'RELEASE';
  input: boolean;
  lineLength: number;
  timer: NodeJS.Timeout;
  resolve: (reply: { status: 'OK' | 'ERR'; rest: string } | HelperFailure) => void;
}

interface Instance {
  readonly n: number;
  readonly proc: ChildProcessWithoutNullStreams;
  readonly pid: number | null;
  readonly startedAt: number;
  seq: number;
  readonly pending: Map<number, Pending>;
  info: DesktopReadyInfo | null;
  readonly ready: Promise<{ ok: true; info: DesktopReadyInfo } | HelperUnavailable>;
  resolveReady: (r: { ok: true; info: DesktopReadyInfo } | HelperUnavailable) => void;
  readyTimer: NodeJS.Timeout | null;
  /** 우리가 끝내는 까닭 (정지·종료·쉼·화면 세션 없음) — 이 뒤의 끝남은 세지 않는다 */
  expected: string | null;
  /** 이 도우미의 끝남을 이미 셌다 */
  counted: boolean;
  exited: boolean;
  readonly exitP: Promise<void>;
  resolveExit: () => void;
  armed: boolean;
  /** ARM 줄을 쓴 적이 있는지 — 없으면 입력을 보낸 적이 없어 뗄 키·버튼도 없다 (리드 결정 S6-21 A3c) */
  everArmed: boolean;
  stdinBroken: boolean;
  stopAck: (() => void) | null;
  /** STOP OK를 받았는지와 그때 뗀 수 — 정지를 다시 해도 남는다 */
  stopAcked: boolean;
  stopReleased: number | null;
  /** FAIL NO_DESKTOP의 글 (사유마다 — noDesktopText) */
  noDesktopText: string | null;
  /** 따로 프로세스 묶음으로 띄웠는지 (POSIX) — 끝낼 때 그 묶음 전체에 SIGKILL */
  group: boolean;
  /** 도는 정지 (끝나면 null — 끝남을 확인하지 못했으면 confirmExit가 한 번 더 한다) */
  stopP: Promise<StopResult> | null;
  /** 마지막 정지의 결과 — 끝남을 확인하지 못한 도우미에 다시 온 stop은 이것을 준다 */
  lastStop: StopResult | null;
  buf: string;
  stderrFirst: string;
}

type OwnStop = 'timeout' | 'overlong' | 'idle';

/** 화면 도우미 클라이언트를 만든다. 띄우지는 않는다 (처음 쓸 때 띄운다) */
export function createDesktopHelper(opts: DesktopHelperOptions): DesktopHelperClient {
  return new DesktopHelper(opts);
}

class DesktopHelper implements DesktopHelperClient {
  private readonly o: DesktopHelperOptions;
  private readonly t: DesktopTimeouts;
  private readonly now: () => number;
  private readonly idleMs: number;
  private current: Instance | null = null;
  /**
   * 멈춘 도우미 — 그 끝남을 확인할 때까지 쥐고 있는다 (리드 결정 S6-21 A1·A3b). 정지가 도는 동안에는 stop이 그 정지를 주고 새 도우미는 그 결과를 기다린다.
   * 끝남을 확인하지 못한 채 정지가 끝났으면 그대로 남아 새 도우미를 띄우지 않는다 — 끝난 것을 알게 되거나(exit) confirmExit가 확인하면 비운다
   */
  private leaving: Instance | null = null;
  private spawning: Promise<{ ok: true; info: DesktopReadyInfo } | HelperUnavailable> | null = null;
  private instances = 0;
  private failures = 0;
  private lastProblem: DesktopHelperProblem | null = null;
  /** 다시 띄우기 상한에 닿은 때의 문제 — 다시 시작할 때까지 그대로다 (늦은 READY가 지우지 못한다, 리드 결정 S6-21 H1) */
  private capProblem: DesktopHelperProblem | null = null;
  private noDesktopUntil = 0;
  private disposed = false;
  private readonly listeners = new Set<(e: DesktopHelperEvent) => void>();
  /** 슬롯을 누가 쥐었거나(넘겨받는 중 포함) — 동기로 정해 두 요청이 같은 슬롯을 쥐지 않게 */
  private slotBusy = false;
  private slotHeld: Lease | null = null;
  private readonly slotWaiters: (() => void)[] = [];
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(opts: DesktopHelperOptions) {
    this.o = opts;
    this.t = { ...DESKTOP_TIMEOUTS, ...(opts.timeouts ?? {}) };
    this.now = opts.now ?? Date.now;
    this.idleMs = opts.idleMs ?? HELPER_IDLE_MS;
  }

  get pid(): number | null {
    const inst = this.current;
    return inst && !inst.exited ? inst.pid : null;
  }

  state(): 'idle' | 'starting' | 'ready' | 'unavailable' {
    const inst = this.current;
    if (inst && !inst.exited && !inst.expected) return inst.info ? 'ready' : 'starting';
    return this.problem() ? 'unavailable' : 'idle';
  }

  problem(): DesktopHelperProblem | null {
    if (this.capProblem) return this.capProblem;
    const p = this.lastProblem;
    if (!p) return null;
    if ((p.code === 'no_desktop' || p.code === 'wayland') && this.now() >= this.noDesktopUntil) return null;
    return p;
  }

  readyInfo(): DesktopReadyInfo | null {
    const inst = this.current;
    return inst && !inst.exited ? inst.info : null;
  }

  armed(): boolean {
    const inst = this.current;
    return !!inst && !inst.exited && inst.armed;
  }

  busy(): boolean {
    return !!this.slotHeld?.inFlight;
  }

  hasProcess(): boolean {
    return (!!this.current && !this.current.exited) || (!!this.leaving && !this.leaving.exited);
  }

  stopping(): Promise<StopResult> | null {
    return this.leaving?.stopP ?? null;
  }

  onEvent(cb: (e: DesktopHelperEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  // ───── 띄우기 ─────

  ready(): Promise<{ ok: true; info: DesktopReadyInfo } | HelperUnavailable> {
    if (this.disposed) return Promise.resolve(unavailable('helper_failed', '서버가 끝나는 중이라 화면 도우미를 띄우지 않습니다'));
    const blocked = this.blockedReason();
    if (blocked) return Promise.resolve(blocked);
    const inst = this.current;
    if (inst && !inst.exited && !inst.expected) return inst.ready;
    if (!this.spawning) {
      this.spawning = this.spawnNew().finally(() => {
        this.spawning = null;
      });
    }
    return this.spawning;
  }

  /** 지금 띄우지 않는 까닭 (상한·화면 세션 없음 기억·끝남을 확인하지 못한 도우미) */
  private blockedReason(): HelperUnavailable | null {
    // 상한은 센 수만 본다 — 마지막 문제 기록이 지워져도(늦은 READY 등) 풀리지 않는다 (리드 결정 S6-21 H1)
    if (this.failures >= MAX_HELPER_FAILURES) {
      return unavailable('helper_failed', this.capProblem?.text ?? `화면 도우미가 ${MAX_HELPER_FAILURES}번 실패해 더 띄우지 않습니다 (서버를 다시 시작하면 다시 시도합니다)`);
    }
    const lp = this.lastProblem;
    if (lp && (lp.code === 'no_desktop' || lp.code === 'wayland') && this.now() < this.noDesktopUntil) return unavailable(lp.code, lp.text);
    // 멈춘 도우미가 끝났는지 확인하지 못했다 — 그 위에 하나 더 띄우지 않는다 (리드 결정 S6-21 A1)
    const left = this.leaving;
    if (left && !left.exited && !left.stopP) return unavailable('helper_failed', HELPER_UNCONFIRMED_TEXT);
    return null;
  }

  private async spawnNew(): Promise<{ ok: true; info: DesktopReadyInfo } | HelperUnavailable> {
    // 앞 도우미의 정지가 도는 중이면 그 끝남을 확인한 뒤에 띄운다 (확인하지 못했으면 아래 blockedReason이 막는다)
    const left = this.leaving;
    if (left?.stopP) await left.stopP;
    try {
      await this.o.launcher.prepare?.();
    } catch (err) {
      return this.refused(`화면 도우미를 준비하지 못했습니다 (${errorText(err)})`);
    }
    if (this.disposed) return unavailable('helper_failed', '서버가 끝나는 중이라 화면 도우미를 띄우지 않습니다');
    const blocked = this.blockedReason();
    if (blocked) return blocked;
    // ── 여기부터 띄우기까지 동기: launch()의 해시 확인과 spawn 사이에 await가 없다 ──
    let spec: ReturnType<DesktopHelperLauncher['launch']>;
    try {
      spec = this.o.launcher.launch();
    } catch (err) {
      return this.refused(`화면 도우미를 띄울 준비가 되지 않았습니다 (${errorText(err)})`);
    }
    if ('refuse' in spec) return this.refused(spec.refuse);
    let env: Record<string, string>;
    try {
      env = { ...spec.env, WOOK_DESKTOP_SCREENS: this.o.screensDir(), WOOK_DESKTOP_POLICY: encodePolicy(this.o.policy?.() ?? EMPTY_POLICY) };
    } catch (err) {
      return this.refused(`화면 도우미 환경을 만들지 못했습니다 (${errorText(err)})`);
    }
    // POSIX: 따로 프로세스 묶음으로 띄운다 — 정지 뒤 SIGKILL을 그 묶음에 보내 곁 도우미·도구 자식도 함께 끝낸다 (리드 결정 S10-7.9). 서버가 죽으면 도우미는
    // 표준 입력이 닫혀 스스로 끝난다(EOF). Windows는 예전 그대로 (Node의 작업 개체)
    const group = (this.o.platform ?? process.platform) !== 'win32';
    let proc: ChildProcessWithoutNullStreams;
    try {
      proc = spawn(spec.file, spec.args, { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], ...(group ? { detached: true } : {}) });
    } catch (err) {
      return this.countFailure(`화면 도우미를 실행하지 못했습니다 (${errorText(err)})`);
    }
    const inst = this.wire(proc, group);
    return inst.ready;
  }

  /** launcher가 띄우기를 거부했다 — 곧바로 쓸 수 없음 (세지 않는다). 다음 요청은 launcher에게 다시 묻는다 */
  private refused(text: string): HelperUnavailable {
    this.setProblem({ code: 'helper_failed', text, at: this.now(), permanent: false });
    return unavailable('helper_failed', text);
  }

  private wire(proc: ChildProcessWithoutNullStreams, group: boolean): Instance {
    let resolveReady!: Instance['resolveReady'];
    const ready = new Promise<{ ok: true; info: DesktopReadyInfo } | HelperUnavailable>((r) => (resolveReady = r));
    let resolveExit!: () => void;
    const exitP = new Promise<void>((r) => (resolveExit = r));
    const inst: Instance = {
      n: ++this.instances,
      proc,
      pid: proc.pid ?? null,
      startedAt: this.now(),
      seq: 0,
      pending: new Map(),
      info: null,
      ready,
      resolveReady,
      readyTimer: null,
      expected: null,
      counted: false,
      exited: false,
      exitP,
      resolveExit,
      armed: false,
      everArmed: false,
      stdinBroken: false,
      stopAck: null,
      stopAcked: false,
      stopReleased: null,
      noDesktopText: null,
      group,
      stopP: null,
      lastStop: null,
      buf: '',
      stderrFirst: '',
    };
    this.current = inst;
    inst.readyTimer = setTimeout(() => {
      inst.readyTimer = null;
      if (inst.info || inst.exited) return;
      this.startFailed(inst, `화면 도우미가 ${formatSeconds(this.t.READY)}초 안에 준비되지 않았습니다`);
    }, this.t.READY);
    inst.readyTimer.unref?.();

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => this.onStdout(inst, chunk));
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk: string) => {
      if (inst.stderrFirst.includes('\n') || inst.stderrFirst.length >= 400) return;
      inst.stderrFirst += chunk.slice(0, 400);
    });
    proc.stdout.on('error', () => undefined);
    proc.stderr.on('error', () => undefined);
    proc.stdin.on('error', () => {
      // 끝난 도우미에 쓰기 — 'exit'가 처리한다. STOP은 이것을 보고 바로 끝낸다
      inst.stdinBroken = true;
    });
    proc.on('error', (err) => {
      if (!inst.info) this.startFailed(inst, `화면 도우미를 실행하지 못했습니다 (${errorText(err)})`);
      // 끝남은 'exit'가 마무리한다 (실행하지 못했으면 'exit'가 오지 않을 수 있다)
      if (proc.pid === undefined) this.onExit(inst, null, null);
    });
    proc.on('exit', (code, signal) => this.onExit(inst, code, signal));
    // 도우미가 서버 종료를 붙잡지 않게 한다 (서버가 끝나면 Node의 작업 개체가 도우미도 끝낸다)
    proc.unref();
    for (const s of [proc.stdin, proc.stdout, proc.stderr] as unknown as { unref?: () => void }[]) s.unref?.();
    return inst;
  }

  // ───── 줄 읽기 ─────

  /**
   * 준비 전에 이미 센(시작 실패) 도우미, 준비 전에 끝내기로 한 도우미 — 그 줄은 읽지 않는다. 늦게 온 READY가 문제 기록을 지워 다시 띄우기 상한을 풀지 않게
   * (리드 결정 S6-21 H1). 준비된 뒤에 멈추는 도우미의 줄은 읽는다: STOP OK, 기다리던 명령의 답(멈추기 전에 보낸 양), 그리고 사람의 입력·멈춤 단축키 — 끝내는
   * 중에도 서버 PC 앞 사람의 멈춤은 잃지 않는다
   */
  private deaf(inst: Instance): boolean {
    return inst.exited || (!inst.info && (inst.counted || !!inst.expected));
  }

  private onStdout(inst: Instance, chunk: string): void {
    if (this.deaf(inst)) {
      inst.buf = '';
      return;
    }
    inst.buf += chunk;
    for (let i = inst.buf.indexOf('\n'); i >= 0; i = inst.buf.indexOf('\n')) {
      const line = inst.buf.slice(0, i).replace(/\r$/, '');
      inst.buf = inst.buf.slice(i + 1);
      if (line.length > MAX_HELPER_LINE) {
        this.overlong(inst);
        return;
      }
      this.onLine(inst, line);
      if (this.deaf(inst)) {
        inst.buf = '';
        return;
      }
    }
    if (inst.buf.length > MAX_HELPER_LINE) this.overlong(inst);
  }

  private overlong(inst: Instance): void {
    inst.buf = '';
    if (!inst.info) {
      this.o.log('warn', `화면 도우미가 ${MAX_HELPER_LINE / 1024 / 1024}MiB보다 긴 줄을 보내 끝냅니다`);
      this.startFailed(inst, `화면 도우미가 준비 전에 ${MAX_HELPER_LINE / 1024 / 1024}MiB보다 긴 줄을 보냈습니다`);
      return;
    }
    // 이미 끝내는 중이면(긴 줄의 나머지가 이어서 온다) 다시 하지 않는다
    if (inst.expected) return;
    this.o.log('warn', `화면 도우미가 ${MAX_HELPER_LINE / 1024 / 1024}MiB보다 긴 줄을 보내 끝냅니다`);
    void this.stopInstance(inst, `화면 도우미가 ${MAX_HELPER_LINE / 1024 / 1024}MiB보다 긴 줄을 보냈습니다`, 'overlong');
  }

  private onLine(inst: Instance, line: string): void {
    if (!inst.info) {
      this.onStartLine(inst, line);
      return;
    }
    const reply = /^(\d{1,9}) (OK|ERR)(?: (.*))?$/.exec(line);
    if (reply) {
      this.onReply(inst, Number(reply[1]), reply[2] as 'OK' | 'ERR', reply[3] ?? '');
      return;
    }
    const stop = /^STOP OK (\d{1,9})$/.exec(line);
    if (stop) {
      // 눌린 키·버튼을 뗐다는 답 — 답을 기다리는 시간(STOP_ACK)이 지난 뒤에 와도, 끝나기 전에 왔으면 받은 것이다
      inst.armed = false;
      inst.stopAcked = true;
      inst.stopReleased = Number(stop[1]);
      inst.stopAck?.();
      return;
    }
    const human = /^HUMAN (\d{1,15})$/.exec(line);
    if (human) {
      this.emit({ type: 'human', at: Number(human[1]) });
      return;
    }
    const hotkey = /^HOTKEY (\d{1,15})$/.exec(line);
    if (hotkey) {
      // 도우미는 도는 입력을 멈추고 키를 떼고 표시·훅을 껐다 — 다시 ARM할 때까지 입력은 RELEASED
      inst.armed = false;
      this.emit({ type: 'hotkey', at: Number(hotkey[1]) });
      this.armIdle();
      return;
    }
    this.o.log('warn', `화면 도우미가 알 수 없는 줄을 보냈습니다 (${line.length}자)`);
  }

  private onStartLine(inst: Instance, line: string): void {
    // 끝의 key=value 낱말은 X11 도우미가 더한다 — 판은 3 그대로다 (S10c, 리드 결정 S10-7.1). 낱말 모양이 틀리면 READY로 받지 않는다(아래 판 불일치)
    const ready = /^READY (\d+) (\d+) locked=([01]) wda=([01]) build=(\d+)((?: [a-z][a-z0-9_]{0,23}=[A-Za-z0-9._:-]{0,64}){0,16})$/.exec(line);
    if (ready) {
      const version = Number(ready[1]);
      if (version !== DESKTOP_PROTOCOL_VERSION) {
        this.startFailed(inst, `화면 도우미 프로토콜 버전이 맞지 않습니다 (${version} ≠ ${DESKTOP_PROTOCOL_VERSION})`);
        return;
      }
      if (inst.readyTimer) clearTimeout(inst.readyTimer);
      inst.readyTimer = null;
      const tokens = parseReadyTokens(ready[6] ?? '');
      const info: DesktopReadyInfo = {
        version,
        screens: Number(ready[2]),
        locked: ready[3] === '1',
        wda: ready[4] === '1',
        build: Number(ready[5]),
        tokens,
        virtual: tokens.virtual === '1',
        pid: inst.pid,
        at: this.now(),
      };
      inst.info = info;
      // 준비 전에 멈춘 도우미·이미 센 도우미의 READY는 여기까지 오지 않는다 (deaf — 리드 결정 S6-21 H1)
      this.lastProblem = null;
      inst.resolveReady({ ok: true, info });
      this.emit({ type: 'ready', info });
      this.armIdle();
      return;
    }
    if (line.startsWith('READY')) {
      this.startFailed(inst, `화면 도우미 프로토콜 버전이 맞지 않습니다 (${clip(line, 40)})`);
      return;
    }
    const fail = /^FAIL (\S+)(?: (.*))?$/.exec(line);
    if (fail) {
      if (fail[1] === 'NO_DESKTOP') {
        // 영구적인 처지(이 프로세스의 세션은 바뀌지 않는다) — 세지 않고 60초 동안 다시 띄우지 않는다. 글은 사유마다 (Windows의 session0·noninteractive는 예전 글,
        // X11의 wayland·nodisplay·notxvfb는 그 글 — 리드 결정 S10-7.7)
        const detail = fail[2]?.trim().split(' ')[0];
        const text = noDesktopText(detail);
        // Xwayland는 화면 없음이 아니라 wayland다 (SC-10, 리드 결정 S10-13)
        const code = detail === 'wayland' ? 'wayland' : 'no_desktop';
        inst.expected = 'no_desktop';
        inst.noDesktopText = text;
        if (inst.readyTimer) clearTimeout(inst.readyTimer);
        inst.readyTimer = null;
        this.noDesktopUntil = this.now() + NO_DESKTOP_CACHE_MS;
        this.setProblem({ code, text, at: this.now(), permanent: false });
        inst.resolveReady(unavailable(code, text));
        this.killQuietly(inst);
        return;
      }
      const detail = fail[2] ? this.cleanDetail(fail[2]) : '';
      this.startFailed(inst, `화면 도우미를 준비하지 못했습니다 (${fail[1]}${detail ? `: ${detail}` : ''})`);
      return;
    }
    // 준비 전의 다른 줄은 버린다 (길이만)
    this.o.log('info', `화면 도우미가 준비 전에 다른 줄을 보냈습니다 (${line.length}자)`);
  }

  private onReply(inst: Instance, id: number, status: 'OK' | 'ERR', rest: string): void {
    const p = inst.pending.get(id);
    if (!p) {
      // 시간 초과 뒤 늦게 온 답, 또는 모르는 번호 — 버린다
      this.o.log('info', `화면 도우미의 늦은 답을 버렸습니다 (명령 번호 ${id})`);
      return;
    }
    inst.pending.delete(id);
    clearTimeout(p.timer);
    // 무장 표시는 도우미가 보낸 줄의 순서를 따른다 — 이 답을 읽은 바로 그때 바꾼다. 같은 덩어리에서 뒤따르는 줄(HOTKEY·RELEASE의 답)이 그 뒤에 다시 바꾼다
    // (나중의 마이크로태스크에서 바꾸면 ARM 답 뒤의 HOTKEY가 푼 무장을 다시 세운다). 입력이 RELEASED·STOPPED로 돌아오면 도우미는 무장하지 않았다 — 다음 호출이
    // 다시 ARM한다 (리드 결정 S6-23 M3)
    if (status === 'OK') {
      if (p.verb === 'ARM' && !inst.expected && parseOk('ARM', rest) !== undefined) inst.armed = true;
      else if (p.verb === 'RELEASE' && RELEASE_OK_RE.test(rest)) inst.armed = false;
    } else if (p.input && /^(?:RELEASED|STOPPED)(?: |$)/.test(rest)) inst.armed = false;
    p.resolve({ status, rest });
  }

  // ───── 요청 ─────

  async acquire(): Promise<HelperLease | HelperUnavailable> {
    this.clearIdle();
    const r = await this.ready();
    if (!r.ok) return r;
    await this.takeSlot();
    const inst = this.current;
    const lease = new Lease(this, inst && !inst.exited && inst.info && !inst.expected ? inst : null);
    this.slotHeld = lease;
    lease.touch();
    return lease;
  }

  async request<R extends HelperRequest>(req: R): Promise<HelperResult<ReplyOf<R>>> {
    const lease = await this.acquire();
    if ('kind' in lease) return lease;
    try {
      return await lease.send(req);
    } finally {
      lease.end();
    }
  }

  async settled(timeoutMs: number): Promise<boolean> {
    const flight = this.slotHeld?.inFlight;
    if (!flight) return true;
    return await raceTimeout(flight.then(() => true), timeoutMs, false);
  }

  private takeSlot(): Promise<void> {
    if (!this.slotBusy) {
      this.slotBusy = true;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.slotWaiters.push(resolve));
  }

  /** Lease.end가 부른다 — 기다리는 다음 요청에 바로 넘긴다 */
  giveSlot(lease: Lease): void {
    if (this.slotHeld !== lease) return;
    this.slotHeld = null;
    const next = this.slotWaiters.shift();
    if (next) {
      next();
      return;
    }
    this.slotBusy = false;
    this.armIdle();
  }

  /** Lease.send가 부른다: 줄을 지금 쓰고 답을 기다린다 */
  send<R extends HelperRequest>(inst: Instance | null, req: R): Promise<HelperResult<ReplyOf<R>>> {
    if (!inst || inst.exited || inst.expected || !inst.info) {
      return Promise.resolve(gone(inst?.expected ? HELPER_STOPPED_TEXT : NO_PROCESS_TEXT));
    }
    const formatted = formatRequest(req);
    if (!formatted.ok) return Promise.resolve(errFailure('BAD_ARGS', formatted.field, null));
    const verb = req.verb;
    const timeoutMs = this.timeoutFor(req);
    // ARM 줄을 쓰면 그 답을 받지 못해도 도우미는 무장했을 수 있다 — 이 뒤로는 뗄 키가 있을 수 있는 도우미다 (A3c)
    if (verb === 'ARM') inst.everArmed = true;
    // 무장 표시(armed)는 답을 읽을 때(onReply) 줄 순서대로 바꾼다 — 여기서 바꾸지 않는다 (S6F2a, 리드 결정 S6-23 M3)
    return this.write(inst, verb, formatted.line, timeoutMs, INPUT_VERBS.has(verb), true).then((reply): HelperResult<ReplyOf<R>> => {
      if ('kind' in reply) return reply;
      if (reply.status === 'ERR') return parseErr(reply.rest, (t) => this.cleanDetail(t));
      const value = parseOk(verb, reply.rest);
      if (value === undefined) return errFailure('INTERNAL', '알아볼 수 없는 답', null);
      return { ok: true, value: value as ReplyOf<R> };
    });
  }

  /**
   * 줄 하나를 쓰고 답을 기다린다. stopOnTimeout: 시간 상한을 넘기면 그 도우미에 STOP을 쓰고 끝낸다(다시 띄우기 상한에 센다). 놓기(RELEASE)는 보통 끄고
   * 부른다 — 턴 끝·`gui_input release`의 놓기는 부른 쪽(lifecycle)이 STOP으로 잇는다. 새 도우미로 하는 표시 위의 놓기만 켠다 (S6F2a, 리드 결정 S6-23 M2)
   */
  private write(
    inst: Instance,
    verb: HelperVerb | 'RELEASE',
    body: string,
    timeoutMs: number,
    input: boolean,
    stopOnTimeout: boolean,
  ): Promise<{ status: 'OK' | 'ERR'; rest: string } | HelperFailure> {
    const id = ++inst.seq;
    const line = `${id} ${body}\n`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!inst.pending.delete(id)) return;
        // 명령 이름과 길이만 남긴다 — 인자(글자·좌표)는 남기지 않는다 (AC-20)
        this.o.log('warn', `화면 도우미가 ${verb} 명령(${body.length}자)에 ${timeoutMs}ms 안에 답하지 않았습니다`);
        if (verb === 'RELEASE') {
          // 놓기의 무응답은 보통 부른 쪽이 STOP으로 잇는다 (lifecycle.ts — 턴 끝의 놓기·gui_input release). 표시 위의 놓기(새 도우미)는 다른 명령의 시간 초과처럼
          // 여기서 멈추고 센다 — 답하지 않는 새 도우미를 호출마다 끝없이 띄우지 않게 (S6F2a, 리드 결정 S6-23 M2)
          resolve({ ok: false, kind: 'timeout', input: false, text: `화면 도우미가 ${formatSeconds(timeoutMs)}초 안에 답하지 않았습니다` });
          if (stopOnTimeout) void this.stopInstance(inst, RELEASE_UNANSWERED_STOP, 'timeout');
          return;
        }
        // 어느 명령이든 답하지 않는 도우미는 STOP을 쓰고 끝낸다 (상한에 센다) — 입력은 보냈는지 모른다. 그 정지의 결과는 'stopped' 알림으로 간다
        // (리드 결정 S6-5·S6-21 A3)
        resolve(
          input
            ? { ok: false, kind: 'timeout', input: true, text: INPUT_UNCONFIRMED_TEXT }
            : { ok: false, kind: 'timeout', input: false, text: `화면 도우미가 ${formatSeconds(timeoutMs)}초 안에 답하지 않아 끝냅니다 — 다시 하면 새 화면 도우미로 합니다` },
        );
        void this.stopInstance(inst, input ? `화면 도우미가 입력 명령(${verb})에 답하지 않아 끝냈습니다` : `화면 도우미가 ${verb} 명령에 답하지 않아 끝냈습니다`, 'timeout');
      }, timeoutMs);
      timer.unref?.();
      inst.pending.set(id, { verb, input, lineLength: body.length, timer, resolve });
      try {
        if (inst.stdinBroken) throw new Error('표준 입력이 닫혔습니다');
        inst.proc.stdin.write(line);
      } catch {
        inst.pending.delete(id);
        clearTimeout(timer);
        inst.stdinBroken = true;
        resolve(gone('화면 도우미에 명령을 쓰지 못했습니다'));
      }
    });
  }

  private timeoutFor(req: HelperRequest): number {
    if (req.verb === 'TYPE') return this.t.TYPE + this.t.TYPE_PER_CHAR * [...req.text].length;
    return this.t[req.verb];
  }

  // ───── RELEASE · STOP ─────

  async release(o: { countFailure?: boolean } = {}): Promise<ReleaseResult> {
    const inst = this.current;
    if (!inst || inst.exited || inst.expected || !inst.info) {
      return { acked: false, released: null, hadProcess: !!inst && !inst.exited, detail: '화면 도우미가 떠 있지 않습니다' };
    }
    const counted = o.countFailure === true;
    const reply = await this.write(inst, 'RELEASE', 'RELEASE', this.t.RELEASE, false, counted);
    // 알아볼 수 없는 답 — 답하지 않은 것과 같다. 세는 놓기면 멈추고 센다 (S6F2a, 리드 결정 S6-23 M2 — 실제 도우미는 RELEASE에 늘 'OK <n>'으로 답한다)
    const badAnswer = (): void => {
      if (counted) void this.stopInstance(inst, RELEASE_UNANSWERED_STOP, 'timeout');
    };
    if ('kind' in reply) {
      return {
        acked: false,
        released: null,
        hadProcess: true,
        detail:
          reply.kind === 'timeout'
            ? `화면 도우미가 ${formatSeconds(this.t.RELEASE)}초 안에 RELEASE에 답하지 않았습니다`
            : reply.kind === 'err'
              ? `화면 도우미가 RELEASE를 하지 못했습니다 (${reply.reason})`
              : reply.text,
      };
    }
    if (reply.status === 'ERR') {
      const e = parseErr(reply.rest, (t) => this.cleanDetail(t));
      badAnswer();
      return { acked: false, released: null, hadProcess: true, detail: `화면 도우미가 RELEASE를 하지 못했습니다 (${e.reason})` };
    }
    const n = RELEASE_OK_RE.exec(reply.rest);
    if (!n) {
      badAnswer();
      return { acked: false, released: null, hadProcess: true, detail: '화면 도우미의 RELEASE 답을 알아볼 수 없습니다' };
    }
    // 무장 표시는 답을 읽을 때 이미 풀었다 (onReply — 줄 순서, S6-23 M3)
    this.armIdle();
    return { acked: true, released: Number(n[1]), hadProcess: true, detail: `키·버튼 ${n[1]}개를 뗐습니다` };
  }

  stop(reason: string): Promise<StopResult> {
    // 떠 있는 도우미, 없으면 멈추는 중이거나 끝남을 확인하지 못한 도우미 — 그 정지가 돌고 있으면 같은 결과를 준다 (리드 결정 S6-21 A3b)
    const inst = this.current ?? this.leaving;
    if (!inst || (inst.exited && !inst.stopP)) return Promise.resolve(noProcess());
    // 이미 멈췄지만 끝남을 확인하지 못한 도우미 — '떠 있지 않다'고 하지 않고 그 결과를 다시 준다. 한 번 더 끝내 보는 것은 대표의 정지 해제(confirmExit)뿐이다:
    // 긴급 정지·교체·앱 종료가 부를 때마다 2.8초씩 다시 기다리지 않게 (앱 종료는 stopAll·dispose가 잇달아 부른다)
    if (inst !== this.current && !inst.stopP && inst.lastStop && !inst.lastStop.exited) return Promise.resolve({ ...inst.lastStop, durationMs: 0 });
    return this.stopInstance(inst, reason, null);
  }

  dispose(): Promise<StopResult> {
    this.disposed = true;
    this.clearIdle();
    return this.stop('앱 종료');
  }

  async confirmExit(): Promise<boolean> {
    const inst = this.leaving;
    if (!inst) return true;
    if (inst.exited && !inst.stopP) {
      this.leaving = null;
      return true;
    }
    return (await this.stopInstance(inst, inst.expected ?? '끝남을 다시 확인', null)).exited;
  }

  /**
   * STOP을 먼저 쓰고(표준 입력이 깨졌으면 바로 끝낸다) STOP OK를 STOP_ACK까지 기다린 뒤 끝내고, STOP을 쓴 때부터 STOP_CONFIRM 안에 끝남을 확인한다.
   * own: 클라이언트가 스스로 하는 정지의 까닭 — 시간 초과·긴 줄은 다시 띄우기 상한에 센다. null이면 부른 정지 (세지 않는다).
   * 정지가 도는 동안 다시 부르면 같은 결과다. 끝남을 확인하지 못하고 끝난 정지 뒤에 다시 부르면 한 번 더 한다 (STOP·끝내기·확인).
   * 결과가 정해지면 'stopped' 알림을 먼저 내고 돌려준다 — 끝남을 확인하지 못한 것을 듣는 쪽(lifecycle)이, 기다리던 쪽이 이어 가기 전에 안다
   */
  private stopInstance(inst: Instance, reason: string, own: OwnStop | null): Promise<StopResult> {
    if (inst.stopP) return inst.stopP;
    if ((own === 'timeout' || own === 'overlong') && !inst.counted && !inst.expected) {
      inst.counted = true;
      this.countFailure(reason);
    }
    if (!inst.expected) inst.expected = reason;
    if (this.current === inst) this.current = null;
    // 끝남을 확인할 때까지 쥐고 있는다 — 그동안 stop은 이 정지를 주고, 새 도우미를 띄우지 않는다
    this.leaving = inst;
    inst.armed = false;
    this.clearIdle();
    if (!inst.info) {
      // 준비 전에 멈춘다 — 준비를 기다리던 쪽에 바로 알린다 (이 뒤의 READY는 읽지 않는다)
      if (inst.readyTimer) clearTimeout(inst.readyTimer);
      inst.readyTimer = null;
      inst.resolveReady(unavailable('helper_failed', HELPER_STOPPED_TEXT));
    }
    const p = (async (): Promise<StopResult> => {
      const t0 = performance.now();
      if (!inst.exited) {
        let wrote = false;
        const ack = new Promise<void>((r) => (inst.stopAck = r));
        if (!inst.stdinBroken) {
          try {
            inst.proc.stdin.write('STOP\n');
            wrote = true;
          } catch {
            inst.stdinBroken = true;
          }
        }
        // 준비 전의 도우미는 STOP에 답하지 못한다(아직 명령을 읽지 않는다) — 답을 기다리지 않고 끝낸다. 무장한 적이 없어 뗄 키도 없다
        if (wrote && inst.info && !inst.stopAcked) await raceTimeout(Promise.race([ack, inst.exitP]), this.t.STOP_ACK, undefined);
        inst.stopAck = null;
        if (!inst.exited) this.killQuietly(inst);
        const left = Math.max(0, this.t.STOP_CONFIRM - (performance.now() - t0));
        await raceTimeout(inst.exitP.then(() => true), left, false);
      }
      const exited = inst.exited;
      const acked = inst.stopAcked;
      // 한 번도 무장하지 않은 도우미는 입력을 보낸 적이 없다 — 뗄 키·버튼이 없으니 끝남만 확인하면 된다 (리드 결정 S6-21 A3c)
      const ok = exited && (acked || !inst.everArmed);
      const detail = !exited
        ? STOP_UNCONFIRMED_EXIT
        : acked
          ? `화면 도우미를 멈췄습니다 (키·버튼 ${String(inst.stopReleased ?? 0)}개 뗌)`
          : !inst.everArmed
            ? '화면 도우미를 멈췄습니다 (무장한 적이 없어 뗄 키·버튼이 없음)'
            : STOP_UNCONFIRMED_KEYS;
      const result: StopResult = { ok, acked, exited, released: inst.stopReleased, hadProcess: true, detail, durationMs: Math.round(performance.now() - t0) };
      inst.stopP = null;
      inst.lastStop = result;
      if (exited && this.leaving === inst) this.leaving = null;
      this.emit({ type: 'stopped', own, reason, result });
      return result;
    })();
    inst.stopP = p;
    return p;
  }

  // ───── 끝남 · 실패 ─────

  /** 준비 전 실패 (센다) — 그 도우미는 끝낸다 */
  private startFailed(inst: Instance, why: string): void {
    if (inst.counted || inst.expected) return;
    inst.counted = true;
    if (inst.readyTimer) clearTimeout(inst.readyTimer);
    inst.readyTimer = null;
    const r = this.countFailure(why);
    inst.resolveReady(r);
    if (this.current === inst) this.current = null;
    this.killQuietly(inst);
  }

  private onExit(inst: Instance, code: number | null, signal: NodeJS.Signals | null): void {
    if (inst.exited) return;
    inst.exited = true;
    inst.armed = false;
    if (inst.readyTimer) clearTimeout(inst.readyTimer);
    inst.readyTimer = null;
    if (this.current === inst) this.current = null;
    // 끝남을 확인하지 못한 채 쥐고 있던 도우미가 끝났다 — 이제 새 도우미를 띄울 수 있다 (도는 정지가 있으면 그 정지가 비운다)
    if (this.leaving === inst && !inst.stopP) this.leaving = null;
    const stderr = this.stderrNote(inst);
    const how = `종료 코드 ${String(code)}${signal ? `, ${signal}` : ''}${stderr ? `, ${stderr}` : ''}`;
    let counted = false;
    if (!inst.counted && !inst.expected) {
      inst.counted = true;
      counted = true;
      const r = this.countFailure(inst.info ? `화면 도우미가 뜻밖에 끝났습니다 (${how})` : `화면 도우미가 준비 전에 끝났습니다 (${how})`);
      inst.resolveReady(r);
    } else {
      inst.resolveReady(unavailable('helper_failed', inst.expected === 'no_desktop' ? (inst.noDesktopText ?? NO_DESKTOP_TEXT) : '화면 도우미가 끝났습니다'));
    }
    for (const [id, p] of inst.pending) {
      inst.pending.delete(id);
      clearTimeout(p.timer);
      p.resolve(gone(inst.expected ? HELPER_STOPPED_TEXT : '화면 도우미가 답하기 전에 끝났습니다'));
    }
    inst.resolveExit();
    if (this.slotHeld && this.slotHeld.inst === inst && !this.slotHeld.inFlight) this.slotHeld.end();
    this.emit({ type: 'exit', expected: !!inst.expected, counted: counted || inst.counted, detail: inst.expected ?? how });
  }

  /** 시작 실패·뜻밖의 종료를 센다. 상한이면 다시 시작할 때까지 쓸 수 없다 */
  private countFailure(why: string): HelperUnavailable {
    this.failures += 1;
    const capped = this.failures >= MAX_HELPER_FAILURES;
    const text = capped ? `${why} — 화면 도우미가 ${MAX_HELPER_FAILURES}번 실패해 더 띄우지 않습니다 (서버를 다시 시작하면 다시 시도합니다)` : why;
    this.o.log('warn', `화면 도우미 실패 ${this.failures}/${MAX_HELPER_FAILURES}: ${why}`);
    const problem: DesktopHelperProblem = { code: 'helper_failed', text, at: this.now(), permanent: capped };
    if (capped) this.capProblem = problem;
    this.setProblem(problem);
    return unavailable('helper_failed', text);
  }

  private setProblem(p: DesktopHelperProblem): void {
    this.lastProblem = p;
    this.emit({ type: 'problem', problem: p });
  }

  private killQuietly(inst: Instance): void {
    try {
      if (this.o.kill) this.o.kill(inst.proc);
      else if (inst.group && inst.pid !== null && !inst.exited) {
        // POSIX: 그 도우미의 프로세스 묶음 전체에 SIGKILL — 곁 도우미·도구 자식도 함께 (리드 결정 S10-7.9). STOP OK로 이미 키를 뗐거나 답이 없어 기다릴 수 없다.
        // 도우미를 아직 거두지 않았으니(exit 전) 그 번호는 다른 프로세스의 것이 아니다. 묶음이 이미 비었으면(ESRCH) 도우미에만 한 번 더
        try {
          process.kill(-inst.pid, 'SIGKILL');
        } catch {
          inst.proc.kill('SIGKILL');
        }
      } else inst.proc.kill();
    } catch {
      // 이미 끝났다
    }
  }

  // ───── 쉼 ─────

  private armIdle(): void {
    this.clearIdle();
    const inst = this.current;
    if (!inst || !inst.info || inst.exited || inst.armed || this.slotBusy || this.disposed) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.current !== inst || inst.armed || this.slotBusy) return;
      // 무장 해제 상태로 오래 쓰지 않았다 — 세지 않고 끝낸다 (다음에 쓰면 새로 띄운다). 끝남을 확인하지 못하면 그 결과가 'stopped' 알림으로 간다
      void this.stopInstance(inst, '쓰지 않은 지 오래돼 끝냄', 'idle');
    }, this.idleMs);
    this.idleTimer.unref?.();
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  // ───── 글 ─────

  /** 도우미 오류 출력의 첫 줄 — 가리개가 있을 때만, 가려서 200자까지 */
  private stderrNote(inst: Instance): string {
    const first = inst.stderrFirst.split(/\r?\n/)[0]?.trim() ?? '';
    if (!first || !this.o.redact) return '';
    return clip(this.o.redact(first), 200);
  }

  /**
   * 도우미가 보낸 자세히 글. 도우미가 정한 짧은 낱말(window·key·shell·hotkey·layout 같은 소문자 ASCII)은 그대로 둔다 — 비밀이 들 수 없고 거부의
   * 종류를 가른다. 그 밖의 글은 가리개가 있으면 가리고 200자까지, 없으면 남기지 않는다
   */
  private cleanDetail(text: string): string {
    if (/^[a-z][a-z_/]{0,23}$/.test(text)) return text;
    if (!this.o.redact) return '';
    return clip(this.o.redact(text), 200);
  }

  private emit(e: DesktopHelperEvent): void {
    for (const cb of this.listeners) {
      try {
        cb(e);
      } catch (err) {
        this.o.log('error', '화면 도우미 알림 처리 오류', err);
      }
    }
  }
}

class Lease implements HelperLease {
  readonly client: DesktopHelper;
  readonly inst: Instance | null;
  inFlight: Promise<unknown> | null = null;
  private ended = false;
  private idle: NodeJS.Timeout | null = null;

  constructor(client: DesktopHelper, inst: Instance | null) {
    this.client = client;
    this.inst = inst;
  }

  send<R extends HelperRequest>(req: R): Promise<HelperResult<ReplyOf<R>>> {
    if (this.ended) throw new Error('돌려준 화면 도우미 슬롯입니다');
    if (this.inFlight) throw new Error('앞 요청의 답을 기다리는 중입니다 — 화면 도우미 요청은 한 번에 하나');
    this.clearIdle();
    const p = this.client.send(this.inst, req);
    this.inFlight = p;
    void p.then(() => {
      this.inFlight = null;
      if (this.ended) return;
      // 도우미가 끝났으면 슬롯을 바로 돌려준다
      if (this.inst?.exited) this.end();
      else this.touch();
    });
    return p;
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.clearIdle();
    this.client.giveSlot(this);
  }

  /** 요청 없이 오래 쥐고 있으면 돌려받는다 */
  touch(): void {
    this.clearIdle();
    this.idle = setTimeout(() => {
      this.idle = null;
      if (this.ended || this.inFlight) return;
      this.end();
    }, LEASE_IDLE_MS);
    this.idle.unref?.();
  }

  private clearIdle(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
  }
}

// ───── 줄 만들기 · 읽기 ─────

const EMPTY_POLICY: DesktopPolicy = { pids: [], titles: [], titlePrefixes: [] };

/**
 * 막는 대상 정책 → base64(UTF-8 줄): `pid <n>` · `title <제목>` · `prefix <앞부분>`. 줄바꿈이 든 제목은 줄바꿈을 공백으로.
 * 도우미는 자기 PID를 스스로 더한다
 */
export function encodePolicy(policy: DesktopPolicy): string {
  const lines = ['v1'];
  for (const pid of policy.pids) if (Number.isSafeInteger(pid) && pid > 0) lines.push(`pid ${pid}`);
  for (const t of policy.titles) if (t) lines.push(`title ${t.replace(/[\r\n]+/g, ' ')}`);
  for (const t of policy.titlePrefixes) if (t) lines.push(`prefix ${t.replace(/[\r\n]+/g, ' ')}`);
  return Buffer.from(lines.join('\n'), 'utf8').toString('base64');
}

/** encodePolicy의 반대 (가짜 도우미·시험용) */
export function decodePolicy(b64: string): DesktopPolicy {
  const policy: DesktopPolicy = { pids: [], titles: [], titlePrefixes: [] };
  for (const line of Buffer.from(b64, 'base64').toString('utf8').split('\n')) {
    const sp = line.indexOf(' ');
    if (sp < 0) continue;
    const k = line.slice(0, sp);
    const v = line.slice(sp + 1);
    if (k === 'pid' && /^\d+$/.test(v)) policy.pids.push(Number(v));
    else if (k === 'title') policy.titles.push(v);
    else if (k === 'prefix') policy.titlePrefixes.push(v);
  }
  return policy;
}

function isCoord(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && Math.abs(v) <= COORD_MAX;
}

/** 요청 → 줄 (번호 없이). 인자가 틀리면 쓰지 않는다 — 그 칸 이름 */
export function formatRequest(req: HelperRequest): { ok: true; line: string } | { ok: false; field: string } {
  const bad = (field: string): { ok: false; field: string } => ({ ok: false, field });
  const tail = (layout: string): string | null => (LAYOUT_RE.test(layout) ? layout : null);
  switch (req.verb) {
    case 'SCREENS':
    case 'WINDOWS':
    case 'FOCUS':
      return { ok: true, line: req.verb };
    case 'ARM':
      return { ok: true, line: `ARM ${encodePolicy(req.policy)}` };
    case 'CAPTURE': {
      const screen = req.screen === 'all' ? 'all' : Number.isSafeInteger(req.screen) && req.screen >= 1 && req.screen <= 16 ? String(req.screen) : null;
      if (!screen) return bad('screen');
      if (!Number.isSafeInteger(req.maxEdge) || req.maxEdge < 1 || req.maxEdge > 16384) return bad('maxEdge');
      if (!CAPTURE_ID_RE.test(req.id)) return bad('id');
      return { ok: true, line: `CAPTURE ${screen} ${req.maxEdge} ${req.id}` };
    }
    case 'MOVE': {
      const l = tail(req.layout);
      if (!isCoord(req.x) || !isCoord(req.y)) return bad('x/y');
      return l ? { ok: true, line: `MOVE ${req.x} ${req.y} ${l}` } : bad('layout');
    }
    case 'CLICK': {
      const l = tail(req.layout);
      if (!isCoord(req.x) || !isCoord(req.y)) return bad('x/y');
      if (req.button !== 'left' && req.button !== 'right' && req.button !== 'middle') return bad('button');
      if (!Number.isSafeInteger(req.count) || req.count < 1 || req.count > 3) return bad('count');
      return l ? { ok: true, line: `CLICK ${req.x} ${req.y} ${req.button} ${req.count} ${l}` } : bad('layout');
    }
    case 'DRAG': {
      const l = tail(req.layout);
      if (![req.x1, req.y1, req.x2, req.y2].every(isCoord)) return bad('x/y');
      return l ? { ok: true, line: `DRAG ${req.x1} ${req.y1} ${req.x2} ${req.y2} ${l}` } : bad('layout');
    }
    case 'SCROLL': {
      const l = tail(req.layout);
      if (!isCoord(req.x) || !isCoord(req.y)) return bad('x/y');
      if (!Number.isSafeInteger(req.amount) || req.amount === 0 || Math.abs(req.amount) > 20) return bad('amount');
      return l ? { ok: true, line: `SCROLL ${req.x} ${req.y} ${req.amount} ${l}` } : bad('layout');
    }
    case 'KEY': {
      const l = tail(req.layout);
      if (!COMBO_RE.test(req.combo)) return bad('combo');
      // 대소문자는 그대로 — 글자 하나는 도우미가 VkKeyScan으로 Shift까지 푼다 ('A' = shift+a). 이름은 도우미가 대소문자를 가리지 않는다
      return l ? { ok: true, line: `KEY ${req.combo} ${l}` } : bad('layout');
    }
    case 'TYPE': {
      const l = tail(req.layout);
      if (typeof req.text !== 'string' || req.text.length === 0) return bad('text');
      return l ? { ok: true, line: `TYPE ${Buffer.from(req.text, 'utf8').toString('base64')} ${l}` } : bad('layout');
    }
  }
}

/** `<사유> [<자세히>] [sent=<n>]` */
export function parseErr(rest: string, clean: (text: string) => string): HelperFailure & { kind: 'err' } {
  const m = /^([A-Z_]+)(?: (.*))?$/.exec(rest.trim());
  if (!m) return errFailure('INTERNAL', clean(rest) || null, null);
  let tailText = m[2] ?? '';
  let sent: number | null = null;
  const s = /(?:^| )sent=(\d{1,9})$/.exec(tailText);
  if (s) {
    sent = Number(s[1]);
    tailText = tailText.slice(0, s.index).trim();
  }
  const known = (HELPER_ERR_REASONS as readonly string[]).includes(m[1]!);
  if (!known) return errFailure('INTERNAL', clean(`${m[1]}${tailText ? ` ${tailText}` : ''}`) || null, sent);
  const reason = m[1] as HelperErrReason;
  if (reason === 'LOCKED') {
    const kind = LOCK_KINDS.has(tailText) ? (tailText as LockKind) : 'locked';
    return { ok: false, kind: 'err', reason, detail: kind, sent, lock: kind };
  }
  return errFailure(reason, tailText ? clean(tailText) || null : null, sent);
}

/** OK 뒤 글 → 명령마다의 값. 알아볼 수 없으면 undefined */
export function parseOk(verb: HelperVerb, rest: string): unknown {
  switch (verb) {
    case 'SCREENS':
      return parseScreens(parseJson(rest));
    case 'WINDOWS':
      return parseWindows(parseJson(rest));
    case 'FOCUS':
    case 'MOVE':
    case 'CLICK':
    case 'DRAG':
    case 'SCROLL':
    case 'KEY':
    case 'TYPE': {
      if (rest.trim() === '' || rest.trim() === 'null') return null;
      return parseFocus(parseJson(rest));
    }
    case 'ARM': {
      // X11 도우미는 곁 도우미가 없으면 그 까닭을 끝에 붙인다 (sidecar=<까닭> — S10c2, 리드 결정 S10-17 FSD-5). Windows 도우미는 붙이지 않는다
      const m = /^seed=(\d{1,15}) hotkey=([01])(?: sidecar=([a-z]{1,16}))?$/.exec(rest);
      if (!m) return undefined;
      const arm: HelperArm = { seed: Number(m[1]), hotkey: m[2] === '1' };
      if (m[3]) arm.sidecar = m[3];
      return arm;
    }
    case 'CAPTURE': {
      const m = /^(\d{1,6}) (\d{1,6}) (-?\d{1,7}) (-?\d{1,7}) (\d{1,6}) (\d{1,6}) ([0-9a-f]{8,64}) ([0-9a-f]{64})$/.exec(rest);
      if (!m) return undefined;
      const v: HelperCapture = {
        width: Number(m[1]),
        height: Number(m[2]),
        originX: Number(m[3]),
        originY: Number(m[4]),
        realWidth: Number(m[5]),
        realHeight: Number(m[6]),
        layout: m[7]!,
        sha256: m[8]!,
      };
      return v.width > 0 && v.height > 0 && v.realWidth > 0 && v.realHeight > 0 ? v : undefined;
    }
  }
}

/** READY 끝의 ' key=value' 낱말들 → 객체 (같은 key는 뒤의 것). 모양은 READY 정규식이 이미 보았다 */
export function parseReadyTokens(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of text.trim().split(' ')) {
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    out[t.slice(0, eq)] = t.slice(eq + 1);
  }
  return out;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function parseScreens(v: unknown): HelperScreens | undefined {
  if (!isObj(v) || typeof v.layout !== 'string' || !LAYOUT_RE.test(v.layout) || !Array.isArray(v.screens)) return undefined;
  const screens = [];
  for (const s of v.screens) {
    if (!isObj(s)) return undefined;
    const index = num(s.index);
    const x = num(s.x);
    const y = num(s.y);
    const width = num(s.width);
    const height = num(s.height);
    if (index === undefined || x === undefined || y === undefined || !width || !height) return undefined;
    screens.push({ index, primary: s.primary === true, x, y, width, height, dpi: num(s.dpi) ?? 96 });
  }
  return { layout: v.layout, screens };
}

function parseWindows(v: unknown): HelperWindows | undefined {
  if (!isObj(v) || !Array.isArray(v.windows)) return undefined;
  const windows = [];
  for (const w of v.windows) {
    if (!isObj(w)) return undefined;
    windows.push({
      title: str(w.title),
      app: str(w.app),
      pid: num(w.pid) ?? 0,
      x: num(w.x) ?? 0,
      y: num(w.y) ?? 0,
      width: num(w.width) ?? 0,
      height: num(w.height) ?? 0,
      minimized: w.minimized === true,
      blocked: w.blocked === true,
      elevated: w.elevated === true,
    });
  }
  return { windows, total: num(v.total) ?? windows.length };
}

function parseFocus(v: unknown): HelperFocus | null | undefined {
  if (v === null) return null;
  if (!isObj(v)) return undefined;
  return {
    app: str(v.app),
    title: str(v.title),
    pid: num(v.pid) ?? null,
    control: typeof v.control === 'string' ? v.control : null,
    // 모르면 null — 사실로 바꾸지 않는다 (TS는 null을 막는 쪽으로 다룬다)
    password: v.password === true ? true : v.password === false ? false : null,
    blocked: v.blocked === true,
    elevated: v.elevated === true,
  };
}

function errFailure(reason: HelperErrReason, detail: string | null, sent: number | null): HelperFailure & { kind: 'err' } {
  return { ok: false, kind: 'err', reason, detail, sent, lock: null };
}

function unavailable(code: HelperUnavailable['code'], text: string): HelperUnavailable {
  return { ok: false, kind: 'unavailable', code, text };
}

function gone(text: string): HelperFailure {
  return { ok: false, kind: 'gone', text };
}

function noProcess(): StopResult {
  return { ok: true, acked: false, exited: true, released: null, hadProcess: false, detail: NO_PROCESS_TEXT, durationMs: 0 };
}

function raceTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), Math.max(0, ms));
    timer.unref?.();
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

function formatSeconds(ms: number): string {
  return String(Math.round(ms / 100) / 10);
}

function clip(text: string, n: number): string {
  return text.length > n ? `${text.slice(0, n)}…` : text;
}

function errorText(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    return code ? `${code}: ${err.message}` : err.message;
  }
  return String(err);
}
