/**
 * 화면 도우미 계약 (SERVER_DESIGN 8.3.2, 리드 결정 S6-4·S6-5). 형식만 둔다 — desktopHelper.ts가 Node 형식 제거로도 불러와지도록
 * (그 파일은 이 파일을 import type으로만 쓴다).
 *
 * 프로토콜 3판 (한 줄씩 · 명령은 ASCII · 응답은 UTF-8):
 *   시작:  READY 3 <화면 수> locked=<0|1> wda=<0|1> build=<n> | FAIL NO_DESKTOP|INIT <사유>     (잠김은 시작 실패가 아니다)
 *   <id> SCREENS | WINDOWS | FOCUS              → <id> OK <json>
 *   <id> ARM <policyB64>                        → <id> OK seed=<epochMs> hotkey=<0|1>
 *   <id> CAPTURE <screen|all> <maxEdge> <SC-id> → <id> OK <w> <h> <ox> <oy> <rw> <rh> <layout> <sha256>
 *   <id> MOVE x y L | CLICK x y <btn> <n> L | DRAG x1 y1 x2 y2 L | SCROLL x y <amt> L | KEY <combo> L | TYPE <b64> L
 *                                               → <id> OK <focusJson> | <id> ERR <사유> [<자세히>] [sent=<n>]
 *   <id> RELEASE → <id> OK <n>     STOP → STOP OK <n>     알림: HUMAN <epochMs> | HOTKEY <epochMs>
 *   ERR 사유: LOCKED <locked|disconnected|secure_desktop> · NO_DESKTOP · STOPPED · RELEASED · HUMAN_ACTIVE · PASSWORD_FIELD ·
 *             FOCUS_UNKNOWN · BLOCKED_TARGET · ELEVATED_TARGET · LAYOUT_CHANGED · BAD_ARGS · BAD_TEXT · TIMEOUT · INTERNAL
 * - TYPE의 글에는 제어 문자(탭·줄바꿈 등 U+0000~U+001F·U+007F)를 넣지 않는다 — 도우미가 ERR BAD_TEXT로 거부한다. 탭·Enter는 KEY로 따로 보낸다
 *   (리드 결정 S6-21 B1).
 * - S6F2b (리드 결정 S6-23 K2): TYPE은 글자 4개씩 보내고, 둘째 묶음부터는 보내기 전에 포커스를 다시 읽는다 — 암호 칸이거나 모르면(최상위 창이 바뀜 포함)
 *   ERR FOCUS_UNKNOWN sent=<보낸 UTF-16 단위>. OK의 포커스는 다 친 뒤 다시 읽은 것이다 — 서버는 그것이 암호 칸이거나 모름이면 secret_blocked로 끝낸다.
 * - 좌표는 늘 실제 픽셀(가상 화면 좌표, 음수 가능). L은 그 좌표를 얻은 캡처의 배치 해시 — 지금 배치와 다르면 LAYOUT_CHANGED.
 * - 캡처 파일: TS가 ID를 정하고, 도우미가 <화면 폴더>/<SC-id>.png.tmp에 쓴 뒤 이름을 바꾼다. TS가 파일을 다시 해시한다.
 * - 화면 폴더(WOOK_DESKTOP_SCREENS)와 처음 정책(WOOK_DESKTOP_POLICY, base64)은 환경 변수로 준다 — 표준 입력은 ASCII만.
 * - STOP·RELEASE는 도는 명령과 상관없이 바로 처리된다(읽는 스레드). STOP 뒤 명령은 모두 ERR STOPPED, 도우미는 표준 입력이 닫히면 끝난다.
 *   RELEASE 뒤 입력은 다시 ARM할 때까지 ERR RELEASED.
 * - SCROLL 양: 양수 = 아래로(휠을 몸 쪽으로), 음수 = 위로. 한 칸 = 휠 한 눈(120).
 * - KEY 조합: 소문자 이름을 +로 잇는다 — 수정 키 ctrl·alt·shift·win, 키 a-z·0-9·f1-f24·enter·tab·esc·space·backspace·delete·insert·home·end·
 *   pageup·pagedown·up·down·left·right·printscreen·menu, 또는 ASCII 글자 하나. 조합 하나는 한 번의 SendInput 배열이다.
 */

/** 잠김의 종류 (ERR LOCKED <kind>) */
export type LockKind = 'locked' | 'disconnected' | 'secure_desktop';

/** 도우미의 ERR 사유 (닫힌 목록 — 모르는 사유는 INTERNAL로 받는다) */
export type HelperErrReason =
  | 'LOCKED'
  | 'NO_DESKTOP'
  | 'STOPPED'
  | 'RELEASED'
  | 'HUMAN_ACTIVE'
  | 'PASSWORD_FIELD'
  | 'FOCUS_UNKNOWN'
  | 'BLOCKED_TARGET'
  | 'ELEVATED_TARGET'
  | 'LAYOUT_CHANGED'
  | 'BAD_ARGS'
  | 'BAD_TEXT' // S6F1b: TYPE의 글에 제어 문자 (리드 결정 S6-21 B1)
  | 'TIMEOUT'
  | 'INTERNAL';

/** READY 줄 */
export interface DesktopReadyInfo {
  version: number;
  /** 모니터 수 */
  screens: number;
  /** 시작할 때 잠겨 있었는지 (잠김·끊김·보안 화면) */
  locked: boolean;
  /** 캡처에서 조작 중 표시를 빼는 기능(WDA_EXCLUDEFROMCAPTURE, 빌드 19041+)이 있는지 — 없으면 표시가 캡처에 찍힌다 */
  wda: boolean;
  /** Windows 빌드 번호 */
  build: number;
  /** 도우미 프로세스 PID */
  pid: number | null;
  /** READY를 받은 때 (epoch ms) */
  at: number;
}

export interface HelperScreen {
  /** 1부터. 주 모니터가 1 */
  index: number;
  primary: boolean;
  /** 실제 픽셀 (가상 화면 좌표) */
  x: number;
  y: number;
  width: number;
  height: number;
  dpi: number;
}

export interface HelperScreens {
  /** 모니터 배치 해시 (입력 명령의 L) */
  layout: string;
  screens: HelperScreen[];
}

export interface HelperWindow {
  title: string;
  /** 프로세스 이름 (확장자 없이, 예: notepad) */
  app: string;
  pid: number;
  x: number;
  y: number;
  width: number;
  height: number;
  minimized: boolean;
  /** 막는 창 (정책의 PID·제목, 도우미 자신) */
  blocked: boolean;
  /** 도우미보다 높은 권한(무결성 수준)의 창 — 입력이 들어가지 않는다 */
  elevated: boolean;
}

export interface HelperWindows {
  /** z 순서 (위가 먼저), 도우미가 최대 200개까지 */
  windows: HelperWindow[];
  /** 보이는 최상위 창 전체 수 */
  total: number;
}

export interface HelperFocus {
  app: string;
  title: string;
  pid: number | null;
  /** UI Automation 컨트롤 종류 (예: Edit). 모르면 null */
  control: string | null;
  /** 암호 칸인지. 모르면(확인 시간 1.5초 넘음·오류) null — TS는 글자 입력을 막는다 */
  password: boolean | null;
  blocked: boolean;
  elevated: boolean;
}

export interface HelperArm {
  /** 마지막 입력 시각 (GetLastInputInfo, epoch ms) — 아무것도 주입하기 전에 읽은 값. 사람 우선 판정의 시작 값 */
  seed: number;
  /** 멈춤 단축키(Ctrl+Alt+Shift+F12)를 등록했는지 */
  hotkey: boolean;
}

export interface HelperCapture {
  /** 이미지 크기 (줄였을 수 있다) */
  width: number;
  height: number;
  /** 찍은 영역의 왼쪽 위 (실제 픽셀, 음수 가능) */
  originX: number;
  originY: number;
  /** 찍은 영역의 실제 크기 */
  realWidth: number;
  realHeight: number;
  /** 모니터 배치 해시 — 이 캡처로 얻은 좌표의 입력에 붙인다 */
  layout: string;
  /** 도우미가 쓴 파일 바이트의 SHA-256 (TS가 다시 해시해 견준다) */
  sha256: string;
}

export type MouseButton = 'left' | 'right' | 'middle';

/** 입력 명령 (좌표는 실제 픽셀) */
export type HelperInput =
  | { verb: 'MOVE'; x: number; y: number; layout: string }
  | { verb: 'CLICK'; x: number; y: number; button: MouseButton; count: number; layout: string }
  /** 왼쪽 버튼으로 끈다. 중간에 멈춰도 버튼은 늘 뗀다 */
  | { verb: 'DRAG'; x1: number; y1: number; x2: number; y2: number; layout: string }
  | { verb: 'SCROLL'; x: number; y: number; amount: number; layout: string }
  | { verb: 'KEY'; combo: string; layout: string }
  /** 글자 (UTF-8 base64로 보낸다 — 줄의 길이만 로그에 남긴다) */
  | { verb: 'TYPE'; text: string; layout: string };

export type InputVerb = HelperInput['verb'];

/** ARM과 시작 환경 변수로 보내는 막는 대상 (리드 결정 S6-8 막는 창). 도우미는 자기 PID를 스스로 더한다 */
export interface DesktopPolicy {
  /** 그 프로세스의 창은 막는다 (서버·조상 콘솔 등) */
  pids: number[];
  /** 제목이 정확히 같은 창 (예: '욱채 서버 (pid 1234)') */
  titles: string[];
  /** 제목이 이것으로 시작하는 창 (예: '욱채') */
  titlePrefixes: string[];
}

export type HelperRequest =
  | { verb: 'SCREENS' }
  | { verb: 'WINDOWS' }
  | { verb: 'FOCUS' }
  | { verb: 'ARM'; policy: DesktopPolicy }
  /** id는 TS가 정한 캡처 ID (SC-\d{6,12}) — 파일 이름이 된다 */
  | { verb: 'CAPTURE'; screen: number | 'all'; maxEdge: number; id: string }
  | HelperInput;

export type HelperVerb = HelperRequest['verb'];

/** 명령마다 성공 값 */
export type ReplyOf<R extends HelperRequest> = R extends { verb: 'SCREENS' }
  ? HelperScreens
  : R extends { verb: 'WINDOWS' }
    ? HelperWindows
    : R extends { verb: 'FOCUS' }
      ? HelperFocus | null
      : R extends { verb: 'ARM' }
        ? HelperArm
        : R extends { verb: 'CAPTURE' }
          ? HelperCapture
          : HelperFocus | null;

/** 실패: 도우미의 ERR · 쓸 수 없음(띄우지 못함·더 띄우지 않음·화면 세션 없음) · 시간 초과 · 답하기 전에 도우미가 끝남 */
export type HelperFailure =
  | {
      ok: false;
      kind: 'err';
      reason: HelperErrReason;
      /** ERR 사유 뒤의 자세히 (LOCKED면 잠김 종류). 가려 둔 글이다 */
      detail: string | null;
      /** 멈춘 입력이 그 전에 보낸 양 (TYPE: UTF-16 단위, DRAG: 단계) */
      sent: number | null;
      lock: LockKind | null;
    }
  | { ok: false; kind: 'unavailable'; code: 'no_desktop' | 'helper_failed'; text: string }
  | {
      ok: false;
      kind: 'timeout';
      text: string;
      /**
       * 입력 명령이었는지 — 입력은 보냈는지 모른다. 어느 명령이든(RELEASE 빼고) 시간 상한을 넘기면 도우미를 STOP하고 끝낸다(다시 띄우기 상한에 센다) —
       * 그 정지의 결과는 'stopped' 알림으로 간다 (S6F1a, 리드 결정 S6-21 A3)
       */
      input: boolean;
    }
  | { ok: false; kind: 'gone'; text: string };

export type HelperResult<T> = { ok: true; value: T } | HelperFailure;

export type HelperUnavailable = Extract<HelperFailure, { kind: 'unavailable' }>;

/** 도우미를 쓸 수 없는 까닭 (화면 세션 없음은 60초 뒤 다시 본다 — permanent false) */
export interface DesktopHelperProblem {
  code: 'no_desktop' | 'helper_failed';
  text: string;
  /** 생긴 때 (epoch ms) */
  at: number;
  /** 다시 시작할 때까지 그대로인지 */
  permanent: boolean;
}

export interface ReleaseResult {
  /** 도우미가 RELEASE에 답했는지 (1초 안에) */
  acked: boolean;
  /** 뗀 키·버튼 수 (답하지 않았으면 null) */
  released: number | null;
  /** 떠 있는 도우미가 있었는지 */
  hadProcess: boolean;
  detail: string;
}

export interface StopResult {
  /**
   * 끝남을 확인했고, 눌린 키·버튼이 남지 않았다 (떠 있는 도우미가 없었으면 true). 한 번도 무장하지 않은(ARM 줄을 받은 적 없는) 도우미는 주입한 것이 없으므로
   * STOP OK가 없어도 끝남만 확인하면 true다 (S6F1a, 리드 결정 S6-21 A3c)
   */
  ok: boolean;
  /** STOP OK를 받았는지 — 못 받았으면 (무장한 적이 있는 도우미는) 키·버튼을 뗐는지 모른다 */
  acked: boolean;
  /** 끝남을 확인했는지 (STOP을 쓴 때부터 2.8초 안 — 없었으면 true). false면 그 도우미가 아직 살아 있을 수 있다 (S6F1a, 리드 결정 S6-21 A1) */
  exited: boolean;
  released: number | null;
  hadProcess: boolean;
  /** 사실 글 — 실패면 '화면 도우미: …' (stops.ts가 실패 줄로 쓴다) */
  detail: string;
  durationMs: number;
}

export type DesktopHelperEvent =
  /** 서버 PC 앞 사람의 입력 (도우미 자신의 주입은 빼고, 250ms마다 많아야 한 번) */
  | { type: 'human'; at: number }
  /** 멈춤 단축키를 눌렀다 — 도우미는 도는 입력을 멈추고 키를 뗐다 */
  | { type: 'hotkey'; at: number }
  | { type: 'ready'; info: DesktopReadyInfo }
  /**
   * 도우미가 끝났다. expected: 정지·교체·종료·쉼(10분)·화면 세션 없음처럼 우리가 끝낸 것. counted: 다시 띄우기 상한에 셌는지
   */
  | { type: 'exit'; expected: boolean; counted: boolean; detail: string }
  | { type: 'problem'; problem: DesktopHelperProblem }
  /**
   * 정지 한 번이 끝났다 (S6F1a, 리드 결정 S6-21 A1·A3) — 정지의 결과가 정해진 바로 그때, 그 결과를 기다리던 쪽이 이어 가기 전에 온다. own: 클라이언트가 스스로 한
   * 정지(timeout 명령 시간 초과 · overlong 1MiB 넘는 줄 · idle 쉼 10분)면 그 까닭, 부른 정지(stop·dispose·confirmExit)면 null. result.exited가 false면 그 도우미가
   * 아직 살아 있을 수 있다
   */
  | { type: 'stopped'; own: 'timeout' | 'overlong' | 'idle' | null; reason: string; result: StopResult };

/** 띄울 프로그램 (도우미 실행 파일 또는 시험의 가짜 도우미) */
export interface DesktopLaunchSpec {
  file: string;
  args: string[];
  /** 자식 환경 전체 (클라이언트가 WOOK_DESKTOP_SCREENS·WOOK_DESKTOP_POLICY를 더한다) */
  env: Record<string, string>;
}

/** 띄우지 않는다 — 그 까닭 (해시가 다름·컴파일 실패·csc 없음·시험 중 실제 도우미 등) */
export interface DesktopLaunchRefusal {
  refuse: string;
}

/**
 * 띄우는 이음매 (리드 결정 S6-5). 시험은 가짜 도우미(tests/fixtures/desktop/fakeDesktopHelper.mjs), 실제 앱은 realHelper.ts.
 * prepare: 띄우기 전의 비동기 준비(컴파일). launch: 동기 — 해시 확인과 띄울 명세. 클라이언트는 launch()가 돌아온 같은 동기 구간에서 띄운다
 */
export interface DesktopHelperLauncher {
  prepare?(): Promise<void>;
  launch(): DesktopLaunchSpec | DesktopLaunchRefusal;
}

/** 명령마다 TS 쪽 시간 상한 (ms, 리드 결정 S6-5) */
export interface DesktopTimeouts {
  READY: number;
  SCREENS: number;
  WINDOWS: number;
  FOCUS: number;
  CAPTURE: number;
  MOVE: number;
  CLICK: number;
  SCROLL: number;
  KEY: number;
  DRAG: number;
  /** TYPE: 이 값 + 글자당 TYPE_PER_CHAR */
  TYPE: number;
  TYPE_PER_CHAR: number;
  ARM: number;
  RELEASE: number;
  /** STOP을 쓴 뒤 STOP OK를 기다리는 상한 — 넘으면 끝낸다 */
  STOP_ACK: number;
  /** STOP을 쓴 때부터 끝남을 확인하기까지의 상한 (stops.ts STOP_CONFIRM_MS와 같다) */
  STOP_CONFIRM: number;
}

/** 한 번에 하나: 이 슬롯을 쥔 동안 다른 요청은 기다린다. STOP·RELEASE는 슬롯 밖에서 바로 간다 */
export interface HelperLease {
  /**
   * 줄을 지금(동기로) 쓰고 답을 기다린다. 같은 슬롯에서 앞 요청의 답이 오기 전에 다시 부르면 던진다.
   * 도우미가 이미 멈췄으면 쓰지 않고 gone
   */
  send<R extends HelperRequest>(req: R): Promise<HelperResult<ReplyOf<R>>>;
  /** 슬롯을 돌려준다 (여러 번 불러도 된다). 기다리는 답은 그대로 온다 */
  end(): void;
}

export interface DesktopHelperClient {
  /** 떠 있는 도우미 PID (없으면 null) */
  readonly pid: number | null;
  /** idle 떠 있지 않음 · starting 띄우는 중 · ready 준비됨 · unavailable 쓸 수 없음(problem) */
  state(): 'idle' | 'starting' | 'ready' | 'unavailable';
  /** 쓸 수 없는 까닭 (화면 세션 없음 60초·다시 띄우기 상한·띄우기 거부). 없으면 null */
  problem(): DesktopHelperProblem | null;
  /** 마지막 READY */
  readyInfo(): DesktopReadyInfo | null;
  /** ARM에 답을 받은 뒤 RELEASE·STOP·HOTKEY·끝남 전까지 true */
  armed(): boolean;
  /** 도는 요청이 있는지 */
  busy(): boolean;
  onEvent(cb: (e: DesktopHelperEvent) => void): () => void;
  /** 띄우고(떠 있으면 그대로) READY를 기다린다 */
  ready(): Promise<{ ok: true; info: DesktopReadyInfo } | HelperUnavailable>;
  /** 준비된 도우미의 요청 슬롯 (차례를 기다린다) */
  acquire(): Promise<HelperLease | HelperUnavailable>;
  /** acquire → send → end */
  request<R extends HelperRequest>(req: R): Promise<HelperResult<ReplyOf<R>>>;
  /** 도는 요청이 끝날 때까지 (상한 timeoutMs). 끝났으면 true */
  settled(timeoutMs: number): Promise<boolean>;
  /**
   * 슬롯 밖: RELEASE (도는 입력을 멈추고 키·버튼을 떼고 표시·훅을 끈다). 도우미는 남는다. countFailure: 답하지 않거나 알아볼 수 없게 답하면 다른 명령의 시간
   * 초과처럼 그 도우미를 STOP하고 끝내고 다시 띄우기 상한에 센다 — 놓기 표시 위에서 새 도우미로 하는 놓기 (S6F2a, 리드 결정 S6-23 M2)
   */
  release(o?: { countFailure?: boolean }): Promise<ReleaseResult>; // S6F2a
  /**
   * 슬롯 밖: STOP을 먼저 쓰고, STOP OK(0.8초) 또는 상한 뒤 끝내고, 끝남을 확인한다(STOP을 쓴 때부터 2.8초). 상한에 세지 않는다.
   * 그 도우미의 정지가 이미 돌고 있으면(앞선 stop·시간 초과의 정지) 같은 결과를 준다 — '떠 있지 않다'고 하지 않는다. 끝남을 확인하지 못한 채 남은 도우미에는
   * 그 결과(exited false)를 다시 준다 — 한 번 더 끝내 보는 것은 confirmExit뿐이다 (S6F1a, 리드 결정 S6-21 A3b)
   */
  stop(reason: string): Promise<StopResult>;
  /** 앱 종료: stop과 같고, 그 뒤로는 띄우지 않는다 */
  dispose(): Promise<StopResult>;
  /** 떠 있거나, 멈췄지만 끝남을 아직 확인하지 못한 도우미 프로세스가 있는지 (S6F1a) */
  hasProcess(): boolean;
  /** 도는 정지 (없으면 null) — 클라이언트가 스스로 하는 정지도 (S6F1a) */
  stopping(): Promise<StopResult> | null;
  /**
   * 끝남을 확인하지 못한 채 남은 도우미를 한 번 더 끝내고 확인한다 (끝내기, STOP_CONFIRM까지). 그런 도우미가 없거나 끝난 것을 확인했으면 true —
   * 확인하기 전에는 새 도우미를 띄우지 않는다 (S6F1a, 리드 결정 S6-21 A1·A2)
   */
  confirmExit(): Promise<boolean>;
}
