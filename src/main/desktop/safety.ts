/**
 * 화면 조작 안전장치 (SERVER_DESIGN 8.3.5, 리드 결정 S6-8·S6-11) — desktop/service.ts의 ScreenRails를 채운다. 여기 없는 것: 정지·놓기(lifecycle.ts), 비밀 값이 든 글
 * (service.ts 3단계), 암호 칸·막는 창·높은 권한 창(도우미가 SendInput 바로 전에 본다 — service.ts failureOf가 거부 코드로 잇는다).
 *
 * - 쓰지 않는 실행 (S6-11): 데스크톱 앱(desktop_mode)·Windows 밖(unsupported_os)·운영자가 끔(server.json screen.enabled: false — disabled). 앱 조립(buildDeps)이
 *   screenModeOff로 정해 OrchestratorDeps.screenOff에 둔다. 그 실행에서는 도우미를 띄우지 않고 화면 확인 업무도 넣지 않는다.
 * - 횟수 상한: 입력 초당 5·분당 300, 캡처 초당 2·턴당 60, screen_info 초당 2. 서버 전체에 하나인 미끄러지는 창이고(턴·세대가 바뀌어도 이어진다), 받아들인
 *   호출만 센다(상한에 걸린 호출은 세지 않는다 — 되풀이해 부르는 메인이 스스로를 잠그지 않게). 코드 상한이다 — 설정으로 바꾸지 못한다 (S6-18 4).
 * - 사람 우선: 마지막 사람 입력(ARM의 시작 값과 도우미의 HUMAN) + 30초 동안 캡처·입력을 거부한다(human_active). 값은 TS가 쥔다 — 도우미·턴이 바뀌어도 남는다.
 *   시작 값(GetLastInputInfo)은 주입한 입력도 세므로, 내 마지막 입력의 답을 받은 때보다 앞선 시작 값은 내 입력으로 보고 쓰지 않는다. 놓기(RELEASE·STOP)가 실제로 뗀
 *   키의 올림도 내 입력이다 — 그 놓기를 쓴 때부터 답을 받은 때까지의 시작 값은 사람 입력이 아니다(리드 결정 S6-21 F3). 답 없이 끝난 입력(시간 초과·도우미 끝남)은
 *   주입했는지 모른다: 줄을 쓴 때까지만 내 입력으로 보고, 그때부터 30초는 사람 입력과 가를 수 없어 멈춘다(E2). 한 번의 멈춤마다 활동 기록 한 줄.
 * - 멈춤 단축키를 등록하지 못한 도우미(ARM의 hotkey=0): 서버 PC 앞의 사람이 멈출 길이 없다 — gui_input을 unavailable로 거부한다(캡처는 된다). 도우미마다 한 번
 *   활동 기록·메인 알림 업무(alert:screen:no_hotkey:<시작>), 자리 화면·사전 점검에 그 까닭. 다음 ARM이 등록했다고 하거나 그 도우미가 끝나면 풀린다 (리드 결정 S6-21 D).
 * - 멈춤 단축키(Ctrl+Alt+Shift+F12): 누른 때부터 5분, 다시 누르면 그때부터 5분. kv(desktop:localStop)에 두어 다시 시작해도 남는다. 풀 수 있는 도구·대표 메서드는 없다.
 *   메인에게 알림 업무(alert:screen:local_stop:<시작>)를 넣는다 — 한 번의 멈춤에 한 번.
 * - 쓸 수 없음 알림: 도구가 부딪힌 잠김·끊김·보안 화면·화면 세션 없음·도우미 실패를 마지막으로 안 상태로 둔다. 바뀔 때마다 활동 기록 한 줄, 대표 알림
 *   (key screen:<code> — 같은 종류는 갱신), 메인 알림 업무(alert:screen:<code>:<시작> — 도구가 알아챈 것만). 다시 되면 지운다. 도구는 이 상태로 미리 거부하지
 *   않는다 — 다음 호출이 도우미에게 다시 물어야 풀린 것을 안다.
 * - 조작 중: ARM에 답을 받은 때부터 놓기·정지·멈춤 단축키·도우미 끝남까지 (서버 PC의 테두리와 띠가 떠 있는 동안). kv desktop:armed는 놓았다는 답을 받아야 지운다 —
 *   남아 있으면 다음 시작이 새 도우미로 한 번 놓는다(lifecycle.ts reconcile).
 * - 대표 화면의 상태(SeatView.screen)는 바뀌는 때에만 바뀐다: 사람 입력마다 스냅숏을 밀지 않는다(멈춤이 시작·끝날 때와 끝 시각이 10초 넘게 밀릴 때만).
 */
import { MAIN_AGENT_ID } from '@shared/domain';
import { SCREEN_UNAVAILABLE_LABEL } from '@shared/labels';
import type { PrereqStatus, ScreenUnavailableCode, SeatScreenView } from '@shared/views';
import { deniedKeyCombo, parseKeyCombo } from '@core/screenGuard';
import type { TokenIdentity } from '../mcp/types';
import type { RunnerProblem } from '../process/types';
import type { Core } from '../orchestrator/core';
import type { Ctx } from '../orchestrator/context';
import { alertMain } from '../orchestrator/alerts';
import { NO_DESKTOP_TEXT } from './desktopHelper';
import type {
  DesktopHelperClient,
  DesktopHelperEvent,
  DesktopHelperProblem,
  DesktopPolicy,
  DesktopReadyInfo,
  HelperArm,
  HelperErrReason,
  HelperResult,
  HelperVerb,
  LockKind,
} from './types';
import type { ScreenRails } from './service';

// ───────────────────────── 쓰지 않는 실행 (S6-11) ─────────────────────────

export type ScreenOffCode = 'desktop_mode' | 'unsupported_os' | 'disabled';

export interface ScreenOff {
  code: ScreenOffCode;
  text: string;
}

export const SCREEN_OFF_TEXT: Readonly<Record<ScreenOffCode, string>> = {
  desktop_mode: '데스크톱 앱에서는 화면 조작을 쓰지 않습니다 — 서버 모드의 서버 PC에서만 씁니다',
  unsupported_os: '이 서버의 운영체제에서는 화면 조작을 쓸 수 없습니다 — 지금은 Windows 서버에서만 씁니다',
  disabled: '서버 PC의 운영자가 화면 조작을 꺼 두었습니다 (server.json의 screen.enabled: false) — 켜려면 운영자가 그 값을 바꾸고 서버를 다시 시작해야 합니다',
};

/**
 * 이 실행에서 화면 조작을 쓰지 않는 까닭 (없으면 null). mode는 껍데기가 넘긴 값 그대로다(데스크톱 앱·서버는 늘 넘긴다). 넘기지 않은 실행(시험 하네스)은 화면 도우미를
 * 직접 준 때만 쓴다 — 주지 않으면 기본인 데스크톱 방식이다. Windows 밖 판정도 도우미를 직접 주지 않은 실행에만 건다(가짜 도우미는 어느 OS에서나 돈다)
 */
export function screenModeOff(o: { mode?: 'desktop' | 'server'; platform: string; enabled?: boolean | null; helperGiven: boolean }): ScreenOff | null {
  const off = (code: ScreenOffCode): ScreenOff => ({ code, text: SCREEN_OFF_TEXT[code] });
  if (o.mode === 'desktop' || (o.mode === undefined && !o.helperGiven)) return off('desktop_mode');
  if (o.platform !== 'win32' && !o.helperGiven) return off('unsupported_os');
  if (o.enabled === false) return off('disabled');
  return null;
}

// ───────────────────────── 상수 ─────────────────────────

export interface ScreenLimits {
  inputPerSec: number;
  inputPerMin: number;
  capturePerSec: number;
  capturePerTurn: number;
  infoPerSec: number;
}

/** 코드 상한 (SERVER_DESIGN 8.3.5 '속도 상한', 리드 결정 S6-8) */
export const SCREEN_LIMITS: Readonly<ScreenLimits> = Object.freeze({ inputPerSec: 5, inputPerMin: 300, capturePerSec: 2, capturePerTurn: 60, infoPerSec: 2 });
/** 사람 입력 뒤 멈추는 시간 */
export const HUMAN_PAUSE_MS = 30_000;
/** 멈춤 단축키를 누른 때부터 멈추는 시간 (S6-18 2) */
export const LOCAL_STOP_MS = 5 * 60_000;
/** 멈춤의 끝 시각이 이만큼 밀리면 대표 화면에 다시 민다 (사람 입력마다 밀지 않는다) */
const PAUSE_PUSH_STEP_MS = 10_000;

export const LOCAL_STOP_KEY = 'desktop:localStop';
export const SCREEN_ARMED_KEY = 'desktop:armed';
export const SCREEN_UNAVAILABLE_KEY = 'desktop:unavailable';
/** 지금 도우미가 멈춤 단축키를 등록하지 못했다 ({sinceMs}) — 그 알림 업무가 끝났는지 본다 (리드 결정 S6-21 D) */
export const SCREEN_NO_HOTKEY_KEY = 'desktop:noHotkey';

/** 멈춤 단축키가 없을 때 gui_input의 거부 글 (unavailable — 리드 결정 S6-21 D) */
export const NO_HOTKEY_REFUSAL =
  '멈춤 단축키를 등록하지 못했습니다 — 같은 단축키를 쓰는 프로그램을 닫거나 서버를 다시 시작하세요. 서버 PC 앞의 사람이 화면 조작을 멈출 길(Ctrl+Alt+Shift+F12)이 없어 입력을 보내지 않았습니다. 서버 PC 운영자가 할 일입니다 — ask_owner로 대표에게 알리세요. 그동안 screen_capture와 screen_info는 됩니다';
const NO_HOTKEY_OWNER_TEXT =
  '화면 도우미가 멈춤 단축키(Ctrl+Alt+Shift+F12)를 등록하지 못해 메인 에이전트의 입력(클릭·키)을 받지 않습니다 — 화면 캡처는 됩니다. 서버 PC 운영자에게 같은 단축키를 쓰는 프로그램을 닫거나 서버를 다시 시작해 달라고 부탁하세요';

/** 서버 콘솔 창의 제목 — 서버가 process.title로 정하고(server/serve.ts), 화면 도우미가 그 제목의 창을 막는다 (리드 결정 S6-8 '막는 창') */
export const serverWindowTitle = (pid: number): string => `욱채 서버 (pid ${pid})`;

/** 도구가 부딪혀 알게 되는 쓸 수 없음 */
export type DetectedCode = LockKind | 'no_desktop' | 'helper_failed';

/** 대표에게 보이는 글 (자리 화면·알림·사전 점검) — 대표가 할 수 있는 일만 적는다: 서버 PC 운영자에게 부탁 */
const OWNER_TEXT: Readonly<Record<DetectedCode, string>> = {
  locked: '서버 PC 화면이 잠겨 있어 메인 에이전트가 화면을 보거나 조작할 수 없습니다 — 서버 PC 운영자에게 잠금 해제·다시 로그온을 부탁하세요',
  disconnected:
    '서버 PC의 원격 세션이 끊겨 화면이 없습니다 — 서버 PC 운영자에게 잠금 해제·다시 로그온을 부탁하세요 (클라우드 PC는 끊기 전에 tscon으로 세션을 콘솔에 돌려 둡니다 — 설치 안내)',
  secure_desktop:
    '서버 PC에 보안 화면(관리자 권한 확인 창·Ctrl+Alt+Del 화면)이 떠 있어 메인 에이전트가 화면을 조작할 수 없습니다 — 서버 PC 운영자에게 그 화면을 처리해 달라고 부탁하세요',
  no_desktop:
    '서버가 화면 없는 세션(서비스·세션 0·비대화형 작업)에서 돌고 있어 화면 조작을 쓸 수 없습니다 — 서버 PC 운영자에게 로그온한 사용자 작업으로 서버를 다시 띄워 달라고 부탁하세요',
  helper_failed: '화면 도우미를 쓸 수 없습니다 — 서버 PC 운영자에게 서버 기록(logs/backend.log)을 확인하고 서버를 다시 시작해 달라고 부탁하세요',
};

/** 주입하기 전에 거부한 입력 명령의 사유 — 이 답은 '내 마지막 입력'으로 세지 않는다 */
const BEFORE_INJECTION: ReadonlySet<HelperErrReason> = new Set<HelperErrReason>(['LOCKED', 'NO_DESKTOP', 'PASSWORD_FIELD', 'BLOCKED_TARGET', 'ELEVATED_TARGET', 'LAYOUT_CHANGED', 'BAD_ARGS']);
const INPUT_VERBS: ReadonlySet<string> = new Set(['MOVE', 'CLICK', 'DRAG', 'SCROLL', 'KEY', 'TYPE']);
/** 잠김을 보는 명령 — 성공하면 화면을 다시 쓸 수 있다 */
const LOCK_CHECKED: ReadonlySet<string> = new Set(['CAPTURE', 'WINDOWS', 'FOCUS', 'MOVE', 'CLICK', 'DRAG', 'SCROLL', 'KEY', 'TYPE']);

/** 사전 점검(--probe)의 답 — realHelper.probeRealDesktopHelper가 돌려주는 모양 */
export type ScreenProbeOutcome = { ok: true; reply: Record<string, unknown> } | { ok: false; reason: string };

/** 안전장치가 화면 서비스에서 빌리는 것 */
export interface ScreenSafetyHost {
  /** 이미 만든 도우미 클라이언트 (만들지 않는다 — 없으면 null) */
  peek(): DesktopHelperClient | null;
  /** 화면 도우미 의존성이 있는지 */
  hasHelper(): boolean;
  /** 도우미를 지금 띄우지 않는 까닭 (화면 세션 없음 60초·다시 띄우기 상한). 한두 번의 실패는 아니다 — 다음 호출이 다시 띄운다 */
  blockingProblem(): DesktopHelperProblem | null;
  /** 도우미가 없을 때의 글 */
  noHelperText: string;
  /** 도우미 실패 → 메인에게 가는 거부 글 (service.ts failureOf) */
  refusalText(reason: 'LOCKED', lock: LockKind): string;
  /** 끝남을 확인하지 못한 화면 도우미가 있으면 대표에게 보일 글과 그때 (lifecycle.ts, 리드 결정 S6-21 A1) — 없으면 null */
  unconfirmedView(): { text: string; sinceMs: number } | null;
}

const clip = (s: string, max: number): string => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

const hms = (ms: number): string => new Date(ms).toLocaleTimeString('ko-KR', { hour12: false });

/** 알림 키 대상 '<종류>:<시작 ms>'가 가리키는 쓸 수 없음이 끝났는지 (alerts.alertEnded의 screen 갈래) — 멈춤 단축키는 한 번 알리는 일이라 끝나지 않는다 */
export function screenAlertEnded(ctx: Ctx, target: string): string | null {
  const m = /^([a-z_]+):(\d{1,16})$/.exec(target);
  if (!m) return null;
  if (m[1] === 'local_stop') return null;
  if (m[1] === 'no_hotkey') {
    // 그 도우미가 다음 무장 때 단축키를 등록했거나 끝났으면 끝난 일이다 (리드 결정 S6-21 D)
    const missing = ctx.store.kv.get<{ sinceMs: number }>(SCREEN_NO_HOTKEY_KEY);
    return missing && String(missing.sinceMs) === m[2] ? null : '화면 도우미가 멈춤 단축키를 다시 등록했거나 그 화면 도우미가 끝남';
  }
  const cur = ctx.store.kv.get<{ code: string; sinceMs: number }>(SCREEN_UNAVAILABLE_KEY);
  if (cur && cur.code === m[1] && String(cur.sinceMs) === m[2]) return null;
  return `서버 PC 화면을 다시 쓸 수 있거나 상태가 바뀜 (${SCREEN_UNAVAILABLE_LABEL[m[1] as ScreenUnavailableCode] ?? m[1]})`;
}

export class ScreenSafety implements ScreenRails {
  private readonly limits: ScreenLimits;
  /** 받아들인 호출의 시각 (앱 시계 ms) — 미끄러지는 창 */
  private inputs: number[] = [];
  private captures: number[] = [];
  private infos: number[] = [];
  private readonly turnCaptures = new Map<string, number>();
  /** 사람 우선: ARM의 시작 값과 마지막 HUMAN (앱 시계 ms) */
  private seedMs: number | null = null;
  private humanMs: number | null = null;
  /** 답 없이 끝난 입력(보냈는지 모른다)을 안 때 (앱 시계 ms) — 그때부터 30초는 사람 입력과 가를 수 없다 (리드 결정 S6-21 E2) */
  private unsureMs: number | null = null;
  /** 지금 이어지는 사람 입력 멈춤 한 번 */
  private episode: { since: number; until: number; pushedUntil: number } | null = null;
  /** 멈춤 단축키 */
  private local: { since: number; until: number } | null = null;
  /** 내 마지막 입력의 답을 받은 때 (벽시계 ms — 도우미의 시각과 견준다). 답 없이 끝난 입력은 그 줄을 쓴 때까지만 */
  private lastOwnInputWall = 0;
  /** 마지막 놓기(RELEASE·STOP)가 실제로 키·버튼을 뗀 동안 (벽시계 ms — 쓴 때부터 답을 받은 때까지). 그 키 올림은 내 입력이다 (리드 결정 S6-21 F3) */
  private ownLift: { from: number; to: number } | null = null;
  /** 지금 도우미가 멈춤 단축키를 등록하지 못했다 — 그 도우미의 PID와 알아챈 때 (리드 결정 S6-21 D) */
  private hotkeyMissing: { sinceMs: number; pid: number | null } | null = null;
  private operatingMs: number | null = null;
  /** toldMain: 이 쓸 수 없음을 메인에게 알림 업무로 넘겼는지 — 사전 점검만 본 것은 도구가 처음 부딪힐 때 넘긴다 (리드 결정 S6-21 H2) */
  private unavailableState: { code: DetectedCode; text: string; ownerText: string; sinceMs: number; toldMain: boolean } | null = null;
  /** 화면을 쓸 수 있다고 마지막으로 안 때 (앱 시계 ms) */
  private okAt: number | null = null;
  private ready: DesktopReadyInfo | null = null;
  private probeInfo: { monitors: number | null; wda: boolean | null; elevated: boolean | null } | null = null;
  private probeAt = 0;
  private probing: Promise<void> | null = null;
  /** 화면을 마지막으로 쓴 메인 턴 (알림 업무의 업무 세션) */
  private lastUse: { turnId: string; projectId: string | null } | null = null;
  private pauseTimer: NodeJS.Timeout | null = null;
  private readonly bootIso: string;

  constructor(
    private readonly core: Core,
    private readonly host: ScreenSafetyHost,
  ) {
    const ctx = core.ctx;
    // 시험 이음매(DesktopDeps.limits)가 있으면 그 값 — 실제 조립(buildDeps)은 주지 않는다
    this.limits = { ...SCREEN_LIMITS, ...(ctx.deps.desktop?.limits ?? {}) };
    this.bootIso = ctx.now();
    this.loadLocalStop();
  }

  private get ctx() {
    return this.core.ctx;
  }

  private now(): number {
    return this.ctx.clock.ms();
  }

  /** 도우미의 시각(벽시계 ms) → 앱 시계 ms. 앞선 시각은 지금으로 당긴다 — 틀린 시각이 멈춤을 끝없이 늘리지 않게 */
  private clockOf(wallMs: number): number {
    const wall = Date.now();
    return Math.min(wallMs, wall) + (this.now() - wall);
  }

  // ───────────────────────── 쓰지 않는 실행 ─────────────────────────

  /** 이 실행에서 화면 조작을 쓰지 않는 까닭 (모드·OS·운영자 설정) */
  modeOff(): ScreenOff | null {
    return this.ctx.deps.screenOff ?? null;
  }

  unavailable(): { code: ScreenUnavailableCode; text: string } | null {
    return this.modeOff();
  }

  // ───────────────────────── 막는 키 · 막는 대상 ─────────────────────────

  deniedKeys(combo: string): string | null {
    // 읽지 못한 조합은 막는 쪽으로 — 처리기가 모양 검사에서 먼저 거르므로 여기까지 오면 안 된다
    if (!parseKeyCombo(combo)) return '키 조합을 알아볼 수 없어 보내지 않았습니다 — "ctrl+s"·"enter"·"a"처럼 수정 키와 키 하나를 +로 이어 주세요';
    return deniedKeyCombo(combo)?.text ?? null;
  }

  /**
   * 막는 창에 더할 것 — 지금은 없다. 서버 자신(PID·콘솔 제목 serverWindowTitle)과 욱채 화면('욱채'로 시작하는 제목)은 service.policy가 늘 넣고, 서버의 조상
   * 프로세스가 가진 콘솔 창은 도우미가 스스로 막는다 (DesktopHelper.cs IsServerConsole)
   */
  policy(): Partial<DesktopPolicy> {
    return {};
  }

  // ───────────────────────── 횟수 상한 ─────────────────────────

  rate(kind: 'input' | 'capture' | 'info', identity: TokenIdentity): string | null {
    const now = this.now();
    const L = this.limits;
    const within = (list: number[], ms: number): number => list.reduce((n, t) => (t > now - ms ? n + 1 : n), 0);
    const fixed = '코드 상한이라 설정으로 올릴 수 없습니다';
    if (kind === 'input') {
      this.inputs = this.inputs.filter((t) => t > now - 60_000);
      if (within(this.inputs, 1000) >= L.inputPerSec) return `입력은 초당 ${L.inputPerSec}회까지입니다 — 1초쯤 뒤에 다시 하세요 (${fixed})`;
      if (this.inputs.length >= L.inputPerMin) {
        const wait = Math.max(1, Math.ceil((this.inputs[0]! + 60_000 - now) / 1000));
        return `입력은 분당 ${L.inputPerMin}회까지입니다 — ${wait}초쯤 뒤에 다시 하세요 (${fixed})`;
      }
      this.inputs.push(now);
      return null;
    }
    if (kind === 'info') {
      this.infos = this.infos.filter((t) => t > now - 1000);
      if (this.infos.length >= L.infoPerSec) return `screen_info는 초당 ${L.infoPerSec}회까지입니다 — 1초쯤 뒤에 다시 하세요 (${fixed})`;
      this.infos.push(now);
      return null;
    }
    this.captures = this.captures.filter((t) => t > now - 1000);
    if (this.captures.length >= L.capturePerSec) return `캡처는 초당 ${L.capturePerSec}장까지입니다 — 1초쯤 뒤에 다시 하세요 (${fixed})`;
    const used = this.turnCaptures.get(identity.turnId) ?? 0;
    if (used >= L.capturePerTurn) {
      return `캡처는 한 턴에 ${L.capturePerTurn}장까지입니다 (동작 뒤 자동 캡처 포함) — 이 턴에서는 더 찍지 않습니다. 턴을 마치고 다음 턴에서 이어 하세요 (${fixed})`;
    }
    this.captures.push(now);
    this.turnCaptures.set(identity.turnId, used + 1);
    return null;
  }

  /** 그 턴이 끝났다 — 턴마다 세던 것을 지운다 */
  turnEnded(turnId: string): void {
    this.turnCaptures.delete(turnId);
  }

  // ───────────────────────── 사람 우선 · 멈춤 단축키 ─────────────────────────

  private humanUntil(): number | null {
    const last = Math.max(this.seedMs ?? Number.NEGATIVE_INFINITY, this.humanMs ?? Number.NEGATIVE_INFINITY, this.unsureMs ?? Number.NEGATIVE_INFINITY);
    return Number.isFinite(last) ? last + HUMAN_PAUSE_MS : null;
  }

  /** 지금의 멈춤이 사람 입력이 아니라 답 없이 끝난 입력 때문인지 (그것이 가장 늦은 까닭일 때) */
  private unsureLatest(): boolean {
    return this.unsureMs !== null && this.unsureMs >= Math.max(this.seedMs ?? Number.NEGATIVE_INFINITY, this.humanMs ?? Number.NEGATIVE_INFINITY);
  }

  /** 지금 걸린 멈춤 단축키 (끝났으면 지우고 null) */
  private localNow(now: number): { since: number; until: number } | null {
    if (!this.local) return null;
    if (now < this.local.until) return this.local;
    this.local = null;
    this.ctx.store.kv.set(LOCAL_STOP_KEY, null);
    return null;
  }

  private loadLocalStop(): void {
    const saved = this.ctx.store.kv.get<{ since: number; until: number }>(LOCAL_STOP_KEY);
    if (!saved || typeof saved.since !== 'number' || typeof saved.until !== 'number') return;
    const now = this.now();
    // 저장된 끝 시각이 지금부터 5분보다 멀 수는 없다 (시계가 바뀐 경우) — 그만큼으로 줄인다
    const until = Math.min(saved.until, now + LOCAL_STOP_MS);
    if (until > now) {
      this.local = { since: Math.min(saved.since, now), until };
      this.schedulePauseEnd();
    } else this.ctx.store.kv.set(LOCAL_STOP_KEY, null);
  }

  paused(_kind: 'input' | 'capture'): string | null {
    const now = this.now();
    const local = this.localNow(now);
    if (local) {
      return `서버 PC 앞의 사람이 멈춤 단축키(Ctrl+Alt+Shift+F12)를 눌러 화면 조작을 멈췄습니다 — ${hms(local.until)}까지(누른 때부터 5분) 캡처와 입력을 하지 않습니다. 어떤 도구로도, 대표도 풀 수 없습니다 — 그동안 화면 없이 할 수 있는 길로 하거나 기다리고, 급하면 ask_owner로 대표에게 알리세요`;
    }
    const until = this.humanUntil();
    if (until !== null && now < until) {
      const left = Math.max(1, Math.ceil((until - now) / 1000));
      if (this.unsureLatest()) {
        return `방금 보낸 입력이 들어갔는지 확인하지 못해(화면 도우미가 답하지 않았습니다) 화면 조작을 30초 멈췄습니다 — 그동안의 입력을 서버 PC 앞 사람의 입력과 가를 수 없어 캡처와 입력을 하지 않습니다 (약 ${left}초 남음). 그 뒤 다시 캡처해 화면을 확인하세요`;
      }
      return `서버 PC 앞에서 사람이 마우스·키보드를 쓰고 있어 화면 조작을 멈췄습니다 — 마지막 입력부터 30초 동안 캡처와 입력을 하지 않습니다 (약 ${left}초 남음). 그 뒤 다시 캡처해 화면을 확인하세요`;
    }
    return null;
  }

  /**
   * 사람 입력을 알았다 (앱 시계 ms) — 멈춤 한 번의 시작이면 활동 기록 한 줄. unsure: 사람 입력이 아니라 답 없이 끝난 입력이다(보냈는지 모른다) — 같은 30초 멈춤이고
   * 기록의 글만 다르다 (리드 결정 S6-21 E2)
   */
  private noteHuman(at: number, source: 'seed' | 'event' | 'unsure'): void {
    if (source === 'seed') this.seedMs = Math.max(this.seedMs ?? at, at);
    else if (source === 'unsure') this.unsureMs = Math.max(this.unsureMs ?? at, at);
    else this.humanMs = Math.max(this.humanMs ?? at, at);
    const now = this.now();
    const until = this.humanUntil();
    if (until === null || now >= until) return;
    const ep = this.episode;
    if (ep && now < ep.until) {
      ep.until = until;
      if (until - ep.pushedUntil >= PAUSE_PUSH_STEP_MS) {
        ep.pushedUntil = until;
        this.ctx.bus.changed();
      }
    } else {
      this.episode = { since: Math.min(at, now), until, pushedUntil: until };
      this.ctx.activity({
        kind: 'screen',
        level: 'info',
        memberId: MAIN_AGENT_ID,
        projectId: this.lastUse?.projectId ?? null,
        text:
          source === 'unsure'
            ? '보낸 입력이 들어갔는지 확인하지 못해(화면 도우미가 답하지 않음) 화면 조작을 멈춤 — 30초 동안 캡처와 입력을 하지 않음 (그동안의 입력을 사람 입력과 가를 수 없음)'
            : '서버 PC 앞 사람의 입력으로 화면 조작을 멈춤 — 마지막 입력부터 30초 동안 캡처와 입력을 하지 않음',
      });
    }
    this.schedulePauseEnd();
  }

  private onHotkey(atWall: number): void {
    const at = this.clockOf(atWall);
    const now = this.now();
    const cur = this.localNow(now);
    this.local = { since: cur ? cur.since : at, until: at + LOCAL_STOP_MS };
    this.ctx.store.kv.set(LOCAL_STOP_KEY, this.local);
    // 도우미가 도는 입력을 멈추고 키를 떼고 표시·훅을 껐다
    this.disarmed(true);
    const until = hms(this.local.until);
    this.ctx.activity({
      kind: 'screen',
      level: 'warn',
      memberId: MAIN_AGENT_ID,
      projectId: this.lastUse?.projectId ?? null,
      text: `서버 PC 앞의 사람이 멈춤 단축키(Ctrl+Alt+Shift+F12)를 눌러 화면 조작을 멈춤 — ${until}까지 (누른 때부터 5분${cur ? ', 다시 눌러 늘림' : ''})`,
    });
    try {
      alertMain(this.ctx, {
        kind: 'screen',
        target: `local_stop:${this.local.since}`,
        projectId: this.lastUse?.projectId ?? null,
        since: new Date(this.local.since).toISOString(),
        message: [
          `화면 조작 멈춤 — 서버 PC 앞의 사람이 멈춤 단축키(Ctrl+Alt+Shift+F12)를 눌렀습니다 (${hms(this.local.since)})`,
          `- screen_capture와 gui_input(release 빼고)은 ${until}까지 human_active로 거부됩니다 — 누른 때부터 5분이고, 다시 누르면 그때부터 5분입니다. screen_info는 됩니다.`,
          '- 그 사람이 서버 PC를 쓰는 중입니다. 이 멈춤을 푸는 도구는 없고 대표도 풀 수 없습니다 — 기다렸다가 다시 캡처하거나, 화면 없이 할 수 있는 길(host_exec·네 셸)로 하세요. 화면이 꼭 필요하고 급하면 ask_owner로 대표에게 알리세요.',
          '- 긴급 정지가 아닙니다 — 다른 일은 그대로 합니다.',
        ].join('\n'),
      });
    } catch (e) {
      this.ctx.log('warn', '멈춤 단축키 알림 업무를 넣지 못했습니다', e);
    }
    this.ctx.bus.changed();
    this.schedulePauseEnd();
  }

  /** 멈춤이 끝나는 때에 대표 화면을 한 번 민다 (끝 시각이 밀렸으면 다시 잡는다) */
  private schedulePauseEnd(): void {
    if (this.pauseTimer) clearTimeout(this.pauseTimer);
    this.pauseTimer = null;
    const now = this.now();
    const ends = [this.local?.until ?? 0, this.humanUntil() ?? 0].filter((t) => t > now);
    if (!ends.length) return;
    this.pauseTimer = setTimeout(() => {
      this.pauseTimer = null;
      const at = this.now();
      this.localNow(at);
      if (this.episode && at >= this.episode.until) this.episode = null;
      this.ctx.bus.changed();
      this.schedulePauseEnd();
    }, Math.min(Math.max(...ends) - now + 50, 0x7fffffff));
    this.pauseTimer.unref?.();
  }

  // ───────────────────────── 도우미가 알려 주는 것 ─────────────────────────

  /**
   * ARM 답. 시작 값(사람 입력)과 멈춤 단축키 등록 여부는 늘 본다. 조작 중 표시와 놓기 표시(kv desktop:armed)는 stillArmed일 때만 켠다 — 그 답을 기다린 쪽이
   * 이어 가는 때에 클라이언트가 아직 무장한 채인지. 같은 덩어리에서 그 답 뒤에 온 HOTKEY·RELEASE의 답·STOP이 먼저 처리돼 무장이 풀렸으면 그쪽이 맞다
   * (클라이언트는 줄 순서를 따른다 — 리드 결정 S6-23 M3, S6-25 N1)
   */
  armed(arm: HelperArm, identity: TokenIdentity, stillArmed: boolean): void {
    this.lastUse = { turnId: identity.turnId, projectId: identity.workProjectId ?? null };
    // 시작 값은 주입한 입력도 센다 — 내 마지막 입력의 답을 받은 때보다 뒤이고, 내 놓기가 키를 뗀 동안도 아니어야 사람 입력이다
    if (Number.isFinite(arm.seed) && !this.ownSeed(arm.seed)) this.noteHuman(this.clockOf(arm.seed), 'seed');
    this.noteHotkey(arm.hotkey);
    if (stillArmed && this.operatingMs === null) {
      this.operatingMs = this.now();
      // 놓았다는 답을 받지 못한 표시가 남아 있으면 덮어쓰지 않는다 — 그 표시는 놓기·정지의 답만 지운다. 무장 앞의 놓기(service.arm → lifecycle.releaseOverMark)가
      // 먼저 지우므로 여기까지 남아 있지 않아야 한다 (리드 결정 S6-21 A4)
      if (!this.ctx.store.kv.get(SCREEN_ARMED_KEY)) {
        this.ctx.store.kv.set(SCREEN_ARMED_KEY, { at: this.ctx.now(), pid: this.host.peek()?.pid ?? null, turnId: identity.turnId });
      }
      this.ctx.bus.changed();
    }
  }

  /** 그 시작 값(벽시계 ms)이 앱의 입력인지 — 내 마지막 입력의 답보다 앞섰거나, 내 놓기가 실제로 키를 뗀 동안이다 */
  private ownSeed(seed: number): boolean {
    if (seed <= this.lastOwnInputWall) return true;
    const lift = this.ownLift;
    return !!lift && seed >= lift.from && seed <= lift.to;
  }

  /**
   * 놓기(RELEASE·STOP)가 실제로 키·버튼을 뗐다 — 쓴 때부터 답을 받은 때까지(벽시계 ms)의 키 올림은 앱의 입력이다. 그 사이의 시작 값으로 사람 입력 멈춤을 걸지
   * 않는다 (리드 결정 S6-21 F3). 그 앞의 시작 값(놓기 전에 사람이 쓴 것)은 그대로 사람 입력이다
   */
  ownKeyUps(fromWall: number, toWall: number): void {
    this.ownLift = { from: Math.min(fromWall, toWall), to: Math.max(fromWall, toWall) };
  }

  /** ARM이 알려 준 멈춤 단축키 등록 여부 — 못 했으면 그 도우미에 한 번 활동 기록과 메인 알림 업무, 다시 등록했으면 푼다 (리드 결정 S6-21 D) */
  private noteHotkey(registered: boolean): void {
    const ctx = this.ctx;
    const pid = this.host.peek()?.pid ?? null;
    if (registered) {
      if (!this.hotkeyMissing) return;
      this.hotkeyMissing = null;
      ctx.store.kv.set(SCREEN_NO_HOTKEY_KEY, null);
      ctx.activity({ kind: 'screen', level: 'info', memberId: MAIN_AGENT_ID, text: '화면 도우미가 멈춤 단축키(Ctrl+Alt+Shift+F12)를 다시 등록함 — 메인 에이전트의 입력을 다시 받음' });
      ctx.bus.changed();
      return;
    }
    // 같은 도우미에는 한 번만
    if (this.hotkeyMissing && this.hotkeyMissing.pid === pid) return;
    const sinceMs = this.now();
    this.hotkeyMissing = { sinceMs, pid };
    ctx.store.kv.set(SCREEN_NO_HOTKEY_KEY, { sinceMs });
    ctx.activity({
      kind: 'screen',
      level: 'warn',
      memberId: MAIN_AGENT_ID,
      projectId: this.lastUse?.projectId ?? null,
      text: '화면 도우미가 멈춤 단축키(Ctrl+Alt+Shift+F12)를 등록하지 못함 — 서버 PC 앞의 사람이 화면 조작을 멈출 길이 없어 메인 에이전트의 입력(gui_input)을 받지 않음. 캡처는 됨. 같은 단축키를 쓰는 프로그램을 닫거나 서버를 다시 시작해야 함',
    });
    try {
      alertMain(ctx, {
        kind: 'screen',
        target: `no_hotkey:${sinceMs}`,
        projectId: this.lastUse?.projectId ?? null,
        since: new Date(sinceMs).toISOString(),
        message: [
          `화면 입력을 쓸 수 없음 — 화면 도우미가 멈춤 단축키(Ctrl+Alt+Shift+F12)를 등록하지 못했습니다 (${hms(sinceMs)}에 알아챔)`,
          '- gui_input(release 빼고)은 unavailable로 거부됩니다 — 서버 PC 앞의 사람이 화면 조작을 멈출 길이 없는 채로는 입력을 보내지 않습니다. screen_capture와 screen_info는 됩니다.',
          '- 같은 단축키를 쓰는 다른 프로그램이 있거나, 앞서 끝나지 않은 화면 도우미가 그 단축키를 쥐고 있을 수 있습니다. 서버 PC 운영자가 그 프로그램을 닫거나 서버를 다시 시작해야 합니다 — 네가 풀 수 없습니다.',
          '- 그동안 화면 입력 없이 할 수 있는 길(host_exec·네 셸)로 하세요. 화면 입력이 꼭 필요하면 ask_owner로 대표에게 서버 PC 운영자의 확인을 부탁하세요. 풀렸는지는 다음 gui_input이 알려 줍니다.',
        ].join('\n'),
      });
    } catch (e) {
      ctx.log('warn', '멈춤 단축키를 등록하지 못했다는 알림 업무를 넣지 못했습니다', e);
    }
    ctx.bus.changed();
  }

  /** 멈춤 단축키가 없어 입력을 받지 않는 까닭 — 없으면 null (service.ts가 gui_input의 무장 뒤에 본다, 리드 결정 S6-21 D) */
  noHotkey(): string | null {
    return this.hotkeyMissing ? NO_HOTKEY_REFUSAL : null;
  }

  /** 놓았거나 멈췄다 — 조작 중 표시가 꺼졌다. released: 눌린 키·버튼을 뗐다는 답을 받았는지 (받아야 다음 시작의 놓기 표시를 지운다) */
  disarmed(released: boolean): void {
    if (released && this.ctx.store.kv.get(SCREEN_ARMED_KEY)) this.ctx.store.kv.set(SCREEN_ARMED_KEY, null);
    if (this.operatingMs === null) return;
    this.operatingMs = null;
    this.ctx.bus.changed();
  }

  /** 앞 실행이 놓았다는 답을 받지 못하고 끝났는지 (kv desktop:armed) */
  armedMark(): { at: string; pid: number | null; turnId: string | null } | null {
    return this.ctx.store.kv.get<{ at: string; pid: number | null; turnId: string | null }>(SCREEN_ARMED_KEY);
  }

  clearArmedMark(): void {
    this.ctx.store.kv.set(SCREEN_ARMED_KEY, null);
  }

  onHelperEvent(e: DesktopHelperEvent): void {
    switch (e.type) {
      case 'human':
        this.noteHuman(this.clockOf(e.at), 'event');
        break;
      case 'hotkey':
        this.onHotkey(e.at);
        break;
      case 'ready':
        this.ready = e.info;
        break;
      case 'exit':
        // 뜻밖에 끝났으면 키를 뗐는지 모른다 — 표시는 꺼졌고 놓기 표시(kv)는 남긴다. 우리가 끝낸 것은 lifecycle이 답을 보고 정한다
        this.disarmed(false);
        // 멈춤 단축키를 등록하지 못한 그 도우미가 끝났다 — 다음 도우미의 ARM이 다시 알려 준다 (떠 있는 다른 도우미의 것이면 그대로)
        if (this.hotkeyMissing && this.hotkeyMissing.pid !== (this.host.peek()?.pid ?? null)) {
          this.hotkeyMissing = null;
          this.ctx.store.kv.set(SCREEN_NO_HOTKEY_KEY, null);
          this.ctx.bus.changed();
        }
        break;
      default:
        break;
    }
  }

  /**
   * 도우미의 답 하나 (도구가 보낸 명령 — service.ts가 슬롯을 감싸 알려 준다). 잠김·화면 세션 없음·도우미 실패를 알아채고, 성공하면 다시 쓸 수 있다고 본다.
   * verb 'READY'는 도우미를 띄우지 못한 것(acquire)
   */
  onResult(verb: HelperVerb | 'READY', r: HelperResult<unknown>, identity: TokenIdentity | null, sentWall?: number): void {
    if (identity) this.lastUse = { turnId: identity.turnId, projectId: identity.workProjectId ?? null };
    if (INPUT_VERBS.has(verb)) {
      if (!r.ok && (r.kind === 'timeout' || r.kind === 'gone')) {
        // 답 없이 끝났다 — 주입했는지 모른다. 실패한 때가 아니라 줄을 쓴 때까지만 내 입력으로 본다(그 뒤의 시작 값은 사람 입력일 수 있다). 그리고 그때부터 30초는
        // 사람 입력과 가를 수 없어 멈춘다 (리드 결정 S6-21 E2)
        if (sentWall !== undefined) this.lastOwnInputWall = Math.max(this.lastOwnInputWall, sentWall);
        this.noteHuman(this.now(), 'unsure');
      } else if (r.ok || r.kind !== 'err' || !BEFORE_INJECTION.has(r.reason)) this.lastOwnInputWall = Date.now();
    }
    if (r.ok) {
      if (LOCK_CHECKED.has(verb)) this.available();
      return;
    }
    if (r.kind === 'err' && r.reason === 'LOCKED') {
      const lock = r.lock ?? 'locked';
      this.detected(lock, this.host.refusalText('LOCKED', lock), true);
    } else if (r.kind === 'err' && r.reason === 'NO_DESKTOP') this.detected('no_desktop', NO_DESKTOP_TEXT, true);
    else if (r.kind === 'unavailable') this.detected(r.code, r.text, true);
  }

  /** 도구가 미리 본 도우미의 문제 (띄우지 않는 중 — 화면 세션 없음 60초·다시 띄우기 상한·띄우기 거부) */
  noteProblem(code: 'no_desktop' | 'helper_failed', text: string, identity: TokenIdentity | null): void {
    if (identity) this.lastUse = { turnId: identity.turnId, projectId: identity.workProjectId ?? null };
    this.detected(code, text, true);
  }

  /** 쓸 수 없음을 알았다 — 같은 종류가 이어지면 한 번만. toMain: 도구가 알아챈 것이면 메인에게 알림 업무도 넣는다 */
  private detected(code: DetectedCode, text: string, toMain: boolean): void {
    const ctx = this.ctx;
    const cur = this.unavailableState;
    const label = SCREEN_UNAVAILABLE_LABEL[code];
    /** 메인에게 알림 업무로 넘긴다 (alert:screen:<종류>:<시작>) — 넘겼으면 true */
    const tellMain = (sinceMs: number): boolean => {
      try {
        return !!alertMain(ctx, {
          kind: 'screen',
          target: `${code}:${sinceMs}`,
          projectId: this.lastUse?.projectId ?? null,
          since: new Date(sinceMs).toISOString(),
          message: [
            `화면 조작을 쓸 수 없음 — ${label} (${hms(sinceMs)}에 알아챔)`,
            `- ${clip(text, 600)}`,
            '- 화면 도구(screen_capture·screen_info·gui_input)는 풀릴 때까지 unavailable입니다. 서버 PC에서 사람이 풀어야 합니다 — 네가 풀 수 없고 대표도 직접 풀 수 없습니다. 대표에게는 서버 PC 운영자에게 부탁하라는 알림을 보냈습니다.',
            '- 그동안 화면 없이 할 수 있는 길(host_exec·네 셸)로 하세요. 화면이 꼭 필요하고 급하면 ask_owner로 대표에게 알리세요. 풀렸는지는 screen_info를 다시 불러 보면 압니다.',
          ].join('\n'),
        });
      } catch (e) {
        ctx.log('warn', '화면을 쓸 수 없다는 알림 업무를 넣지 못했습니다', e);
        return false;
      }
    };
    if (cur?.code === code) {
      cur.text = text;
      // 사전 점검만 본 쓸 수 없음에 도구가 처음 부딪혔다 — 그때 메인에게 넘기고, 대표 알림에도 넘겼다고 적는다 (리드 결정 S6-21 H2). 같은 쓸 수 없음에 한 번만
      if (toMain && !cur.toldMain) {
        cur.toldMain = true;
        if (tellMain(cur.sinceMs)) {
          ctx.notify({
            level: 'normal',
            title: `화면 조작을 쓸 수 없습니다 — ${label}`,
            body: `${cur.ownerText}. 풀리면 메인 에이전트가 화면 도구를 다시 쓸 때 이어집니다 — 메인 에이전트에게도 알렸습니다`,
            link: { tab: 'seat', panel: 'screen' },
            key: `screen:${code}`,
          });
        }
      }
      return;
    }
    const sinceMs = this.now();
    const ownerText = code === 'helper_failed' ? `${OWNER_TEXT.helper_failed} (${clip(text, 200)})` : OWNER_TEXT[code];
    this.unavailableState = { code, text, ownerText, sinceMs, toldMain: toMain };
    this.okAt = null;
    ctx.store.kv.set(SCREEN_UNAVAILABLE_KEY, { code, sinceMs });
    ctx.activity({ kind: 'screen', level: 'warn', memberId: MAIN_AGENT_ID, projectId: this.lastUse?.projectId ?? null, text: `서버 PC 화면을 쓸 수 없음 (${label}) — ${clip(text, 300)}` });
    const handed = toMain && tellMain(sinceMs);
    ctx.notify({
      level: 'normal',
      title: `화면 조작을 쓸 수 없습니다 — ${label}`,
      body: `${ownerText}. 풀리면 메인 에이전트가 화면 도구를 다시 쓸 때 이어집니다${handed ? ' — 메인 에이전트에게도 알렸습니다' : ''}`,
      link: { tab: 'seat', panel: 'screen' },
      key: `screen:${code}`,
    });
    ctx.bus.changed();
  }

  /** 화면을 다시 쓸 수 있다 (잠김을 보는 명령이 성공했다) */
  private available(): void {
    const ctx = this.ctx;
    this.okAt = this.now();
    const cur = this.unavailableState;
    if (!cur) return;
    this.unavailableState = null;
    ctx.store.kv.set(SCREEN_UNAVAILABLE_KEY, null);
    ctx.activity({ kind: 'screen', level: 'info', memberId: MAIN_AGENT_ID, text: `서버 PC 화면을 다시 쓸 수 있음 (${SCREEN_UNAVAILABLE_LABEL[cur.code]} 풀림)` });
    // 그 쓸 수 없음 알림은 더는 참이 아니다 — 읽지 않았으면 읽음으로 둔다
    const now = ctx.now();
    for (const n of ctx.store.notifications.list({ ref1: `screen:${cur.code}`, state: 'unread' })) ctx.store.notifications.put({ ...n, readAt: now });
    ctx.bus.changed();
  }

  /** 다시 시작했다 — 앞 실행이 안 쓸 수 없음은 이 프로세스의 사실이 아니다 (그 알림 업무는 끝난 일이 된다) */
  resetAtStart(): void {
    this.ctx.store.kv.set(SCREEN_UNAVAILABLE_KEY, null);
    this.ctx.store.kv.set(SCREEN_NO_HOTKEY_KEY, null);
  }

  // ───────────────────────── 실행 환경 문제 · 사전 점검 ─────────────────────────

  /** 화면 도우미 실행 파일이 준비할 때와 다르다 (띄울 때마다 해시를 본다 — 리드 결정 S6-5). 그 파일로는 띄우지 않았다 */
  binaryProblem(problem: RunnerProblem): void {
    const ctx = this.ctx;
    ctx.notify({
      level: 'urgent',
      title: '화면 도우미 파일이 바뀜',
      body: `${problem.text}. 바뀐 파일로는 화면 도우미를 띄우지 않습니다 — 그동안 메인 에이전트의 화면 도구는 쓸 수 없습니다. 원본에서 한 번 다시 컴파일하고, 되면 다시 씁니다. 에이전트나 다른 프로그램이 서버의 데이터 폴더(bin)의 실행 파일을 바꿨을 수 있습니다. 이 알림이 다시 오면 서버 PC의 운영자에게 그 폴더를 바꾸는 프로그램이 없는지 확인하고 서버를 다시 시작해 달라고 부탁하세요`,
      link: { tab: 'seat', panel: 'screen' },
      key: 'screen-helper-problem',
    });
    ctx.activity({ kind: 'system', level: 'error', text: `실행 환경 문제: 화면 도우미 파일이 바뀜 — ${problem.text}` });
  }

  /**
   * 사전 점검 (리드 결정 S6-11): 준비 뒤 한 번, 60초 안에는 다시 하지 않는다. 화면 도우미 의존성이 준 확인(실제 앱은 `WookDesktopHelper.exe --probe` — 창·훅·캡처 없이
   * 세션·잠김만 읽는다)을 부른다. 데스크톱 앱·시험 중(VITEST)·쓰지 않는 실행에는 그 확인이 없어 아무것도 띄우지 않는다. system.prereqs는 이것을 부르지 않는다
   */
  probe(): Promise<void> {
    const fn = this.ctx.deps.desktop?.probe;
    if (!fn || this.modeOff()) return Promise.resolve();
    if (this.probing) return this.probing;
    const wall = Date.now();
    if (this.probeAt && wall - this.probeAt < 60_000) return Promise.resolve();
    this.probeAt = wall;
    this.probing = (async () => {
      try {
        this.applyProbe(await fn());
      } catch (e) {
        this.ctx.log('warn', '화면 조작 사전 점검을 하지 못했습니다', e);
      } finally {
        this.probing = null;
      }
      const p = this.prereq();
      this.ctx.log(p.ok ? 'info' : 'warn', `화면 조작 사전 점검: ${p.state} — ${p.detail}`);
    })();
    return this.probing;
  }

  private applyProbe(r: ScreenProbeOutcome): void {
    if (!r.ok) {
      this.detected('helper_failed', `화면 도우미를 확인하지 못했습니다: ${r.reason}`, false);
      return;
    }
    const reply = r.reply;
    const lock = reply.lock;
    this.probeInfo = {
      monitors: typeof reply.monitors === 'number' ? reply.monitors : null,
      wda: typeof reply.wda === 'boolean' ? reply.wda : null,
      elevated: typeof reply.elevated === 'boolean' ? reply.elevated : null,
    };
    if (lock === 'no_desktop') this.detected('no_desktop', NO_DESKTOP_TEXT, false);
    else if (lock === 'locked' || lock === 'disconnected' || lock === 'secure_desktop') this.detected(lock, this.host.refusalText('LOCKED', lock), false);
    else if (lock === null || lock === undefined) this.available();
    else this.detected('helper_failed', '화면 도우미의 확인 답을 알아볼 수 없습니다', false);
  }

  // ───────────────────────── 대표가 보는 상태 ─────────────────────────

  /** 지금 쓸 수 없는 까닭과 대표에게 보일 글 — 쓰지 않는 실행, 도우미 없음, 마지막으로 안 잠김·실패, 도우미를 띄우지 않는 중 */
  private unavailableView(): { code: ScreenUnavailableCode; text: string; sinceMs: number | null } | null {
    const off = this.modeOff();
    if (off) return { code: off.code, text: off.text, sinceMs: null };
    if (!this.host.hasHelper()) return { code: 'helper_failed', text: this.host.noHelperText, sinceMs: null };
    // 끝남을 확인하지 못한 화면 도우미가 있다 — 화면 도구가 모두 거부된다. 까닭과 출구(정지 해제 → 그래도 안 되면 서버 다시 시작)를 말한다 (리드 결정 S6-21 A1·A2)
    const gate = this.host.unconfirmedView();
    if (gate) return { code: 'helper_failed', text: gate.text, sinceMs: gate.sinceMs };
    const cur = this.unavailableState;
    if (cur) return { code: cur.code, text: cur.ownerText, sinceMs: cur.sinceMs };
    const p = this.host.blockingProblem();
    if (p) return { code: p.code, text: p.code === 'no_desktop' ? OWNER_TEXT.no_desktop : `${OWNER_TEXT.helper_failed} (${clip(p.text, 200)})`, sinceMs: this.clockOf(p.at) };
    // 멈춤 단축키를 등록하지 못했다 — 입력만 받지 않는다 (캡처는 된다). 그 까닭을 보인다 (리드 결정 S6-21 D)
    if (this.hotkeyMissing) return { code: 'helper_failed', text: NO_HOTKEY_OWNER_TEXT, sinceMs: this.hotkeyMissing.sinceMs };
    return null;
  }

  /** 대표가 보는 화면 조작 상태 (SeatView.screen) */
  view(): SeatScreenView {
    const now = this.now();
    const un = this.unavailableView();
    const local = this.localNow(now);
    const until = this.humanUntil();
    const human = !local && until !== null && now < until;
    const iso = (ms: number): string => new Date(ms).toISOString();
    return {
      unavailable: un ? { code: un.code, text: un.text, since: un.sinceMs === null ? this.bootIso : iso(un.sinceMs) } : null,
      operatingSince: this.operatingMs !== null && this.host.peek()?.armed() ? iso(this.operatingMs) : null,
      paused: local ? { by: 'local', since: iso(local.since), until: iso(local.until) } : human ? { by: 'human', since: iso(this.episode?.since ?? until - HUMAN_PAUSE_MS), until: iso(until) } : null,
    };
  }

  /** 사전 점검의 화면 칸 (system.prereqs·운영자 status·시작 기록) — 마지막으로 안 상태. 아무것도 띄우지 않는다 */
  prereq(): PrereqStatus['screen'] {
    const elevated = this.probeInfo?.elevated ?? null;
    const un = this.unavailableView();
    if (un) return { ok: false, state: un.code, detail: un.text, elevated };
    if (this.okAt === null) {
      return { ok: false, state: 'unknown', detail: '화면 조작을 쓸 수 있는지 아직 확인하지 않았습니다 — 메인 에이전트가 화면 도구를 처음 쓸 때 확인합니다', elevated };
    }
    const notes: string[] = [];
    const monitors = this.ready?.screens ?? this.probeInfo?.monitors ?? null;
    if (monitors !== null) notes.push(`모니터 ${monitors}개`);
    notes.push(`마지막 확인 ${hms(this.okAt)}`);
    const wda = this.ready ? this.ready.wda : (this.probeInfo?.wda ?? null);
    if (wda === false) notes.push('이 Windows 빌드(19041 미만)에서는 조작 중 표시가 캡처에 함께 찍힙니다');
    if (elevated) notes.push('서버가 관리자 권한으로 돌고 있습니다 — 화면 도우미도 관리자 권한이라 관리자 권한 창에도 입력이 갑니다. 보통 사용자 권한으로 띄우기를 권합니다');
    return { ok: true, state: 'available', detail: `화면 조작을 쓸 수 있습니다 (${notes.join(', ')})`, elevated };
  }

  dispose(): void {
    if (this.pauseTimer) clearTimeout(this.pauseTimer);
    this.pauseTimer = null;
  }
}
