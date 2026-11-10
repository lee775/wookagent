/**
 * 화면 조작 서비스 (SERVER_DESIGN 8.3, 리드 결정 S6-6·S6-7·S6-10) — 메인 전용 도구 다섯 개의 처리기, 캡처 보관, 기록, 화면 보기 확인.
 *
 * - 도구: screen_capture · screen_info · gui_input · get_screen_check · answer_screen_check. tools.ts가 부른다(메인 전용, 조회 도구 아님 — 정지·인계 메모
 *   턴에는 거부된다). 결과의 이미지는 data 밖(images)에 실린다 — 도구 중복 캐시·onCall·기록에 바이트가 남지 않는다.
 * - gui_input 순서 (리드 결정 S6-6, 바꾸지 않는다): 1 모양(invalid) → 2 쓸 수 없음·교체 중·정지 → 3 비밀 값이 든 글(secret_blocked)·막는 키 조합(denied_target)
 *   → 4 캡처(모름 invalid, 다른 세대 seat_changed, 30초 넘음 stale_capture) → 5 사람 우선·멈춤 단축키(human_active)·횟수(rate_limited) → 6 준비·ARM →
 *   7 한 동기 구간에서 다시 보기(callerRecheck·정지·교체·멈춤) 뒤 'sent' 줄을 남기고 줄을 쓴다 → 8 답을 받아 줄을 고친다(이 뒤로는 거부하지 않는다) →
 *   9 then_capture: 0.5초 뒤 다시 보고 캡처하거나 after_note.
 * - 안전장치(막는 키·창, 사람 우선, 멈춤 단축키, 횟수 상한, 잠김 알림 — 리드 결정 S6-8·S6-11)는 rails로 붙는다(desktop/safety.ts ScreenSafety). 붙지 않은 rails는
 *   모든 화면 도구를 거부한다(CLOSED_RAILS — 닫힌 쪽이 기본, 리드 결정 S6-19). 정지·놓기·다시 시작 뒤 맞추기는 desktop/lifecycle.ts (S6-9).
 * - 화면 도우미가 없으면(OrchestratorDeps.desktop 없음) 도구는 unavailable('helper_failed')이고 화면 확인 업무를 넣지 않는다 (S6-3). 데스크톱 앱·Windows 밖·운영자가
 *   끈 실행(OrchestratorDeps.screenOff)도 같다 — 도우미를 띄우지 않는다 (S6-11).
 * - 대표의 보기: SeatView.screen(screenView)·system.prereqs의 screen(prereq)·screens.recent(recent)·screens.image(image)·/api/screens/:id(downloadTarget).
 *   이미지는 보관 중이고 기록의 해시와 맞을 때만 준다.
 */
import { createHash, randomBytes } from 'node:crypto';
import { MAIN_AGENT_ID, type Member, type QueueEntry } from '@shared/domain';
import type { PrereqStatus, ScreenFilter, ScreenImageView, ScreenRecentView, ScreenUnavailableCode, SeatScreenView } from '@shared/views';
import { controlCharIn, parseKeyCombo } from '@core/screenGuard';
import { BackendError } from '../backend/types';
import type { ScreenCaptureResult, ScreenCheckAnswer, ScreenCheckImage, ScreenFocusSummary, ScreenInfoResult, ScreenWindowInfo, ToolSpec, GuiInputResult } from '../mcp/catalog';
import type { TokenIdentity, ToolImage } from '../mcp/types';
import type { GuiActionRow, GuiCaptureRecord, MainSeatRow, SeatHolder } from '../db/store';
import type { Ctx } from '../orchestrator/context';
import type { Core } from '../orchestrator/core';
import { enqueue } from '../orchestrator/records';
import type { DownloadFile } from '../orchestrator/serverFiles';
import type { RunnerProblem } from '../process/types';
import { createDesktopHelper, INPUT_UNCONFIRMED_TEXT, NO_DESKTOP_TEXT, type DesktopHelperOptions } from './desktopHelper';
import type {
  DesktopHelperClient,
  DesktopHelperEvent,
  DesktopHelperLauncher,
  DesktopHelperProblem,
  DesktopPolicy,
  DesktopTimeouts,
  HelperArm,
  HelperCapture,
  HelperFailure,
  HelperFocus,
  HelperInput,
  HelperLease,
  HelperRequest,
  HelperResult,
  HelperUnavailable,
  HelperVerb,
  HelperWindow,
  LockKind,
  MouseButton,
  ReplyOf,
} from './types';
import { captureScale, insideCapture, rectToImage, toReal, type CaptureFrame } from './coords';
import { codePoints, GuiRecords, type GuiRecordInput } from './guiRecords';
import { NO_HELPER_RELEASE_TEXT, ScreenLifecycle, UNRELEASED_PROBLEM, UNRELEASED_REFUSAL, type ScreenStopOutcome, type ScreenStopReason } from './lifecycle';
import { ScreenSafety, serverWindowTitle, type ScreenLimits, type ScreenProbeOutcome } from './safety';
import { CAPTURE_ID_RE, isAllBlackPng, ScreenStore, sha256Of } from './screenStore';
import { newScreenCheckCode, screenCheckImage } from './testImage';

/** 화면 도우미 의존성 (OrchestratorDeps.desktop) — 시험은 가짜 도우미의 launcher (tests/fixtures/desktop/fakeDesktop.ts), 실제 앱은 realHelper.ts */
export interface DesktopDeps {
  launcher: DesktopHelperLauncher;
  /** 시험: 시간 상한을 줄인다 */
  timeouts?: Partial<DesktopTimeouts>;
  /** 시험: 쉼 끝내기 시간 */
  idleMs?: number;
  /** 시험: 끝내기 이음매 */
  kill?: DesktopHelperOptions['kill'];
  /** 시험 이음매: 횟수 상한 (기본은 코드 상한 SCREEN_LIMITS). 실제 조립(buildDeps)은 주지 않는다 — 상한은 설정으로 바꾸지 못한다 (리드 결정 S6-18 4) */
  limits?: Partial<ScreenLimits>;
  /**
   * 사전 점검의 확인 (리드 결정 S6-11) — 실제 조립은 화면 도우미의 확인 실행(--probe: 창·훅·캡처 없이 세션·잠김만 읽는다)을 준다. 준비 뒤 한 번, 60초 안에는 다시
   * 부르지 않는다. 없으면(데스크톱 앱·시험 중·가짜 도우미) 확인하지 않는다
   */
  probe?: () => Promise<ScreenProbeOutcome>;
  /** 화면 도우미 실행 파일이 준비할 때와 달라졌을 때마다 (realHelper.ts — 대표 알림용). 구독을 끊는 함수를 돌려준다 */
  onProblem?: (cb: (problem: RunnerProblem) => void) => () => void;
}

/** 처리기가 돌려주는 것 — 이미지는 data 밖 (캐시·기록에 남지 않는다) */
export interface ScreenToolOutput {
  data: unknown;
  images?: ToolImage[];
}

/** tools.ts가 넘기는 검사 — 정지(assertNotStopped)와 기다림 뒤 다시 보기(callerRecheck, 리드 결정 S5-63) */
export interface ScreenGuards {
  assertNotStopped(): void;
  recheck(already?: string): void;
}

/**
 * 안전장치 이음매 (리드 결정 S6-8 — desktop/safety.ts ScreenSafety가 채운다). 모든 칸이 꼭 있어야 한다 — 빠진 검사가 조용히 통과하지 않게. 거부는 글(사실과 출구)을
 * 돌려준다
 */
export interface ScreenRails {
  /** 3단계: 막는 키 조합 (Win+L·Ctrl+Alt+Del·멈춤 단축키·붙여넣기 조합 — core/screenGuard.ts) */
  deniedKeys(combo: string): string | null;
  /** 5단계: 사람 우선(마지막 사람 입력 + 30초)·멈춤 단축키(+5분) — 'input'은 release 밖의 gui_input, 'capture'는 screen_capture와 then_capture */
  paused(kind: 'input' | 'capture'): string | null;
  /** 5단계: 횟수 상한 — 모양을 지난 호출 가운데 받아들인 것을 센다. 넘으면 거부 글 */
  rate(kind: 'input' | 'capture' | 'info', identity: TokenIdentity): string | null;
  /** ARM 답 (사람 우선의 시작 값, 조작 중 표시, 멈춤 단축키를 등록했는지). stillArmed: 그 답 뒤에도 클라이언트가 무장한 채인지 — 아니면 표시를 켜지 않는다 (S6-25 N1) */
  armed(arm: HelperArm, identity: TokenIdentity, stillArmed: boolean): void;
  /** 무장 뒤: 멈춤 단축키를 등록하지 못해 입력을 받지 않는 까닭 — gui_input은 unavailable, 캡처는 된다 (S6F1a, 리드 결정 S6-21 D) */
  noHotkey(): string | null;
  /** 이 실행에서 화면 조작을 쓰지 않는 까닭 (데스크톱 앱·Windows 밖·운영자가 끔) — 있으면 도구는 unavailable */
  unavailable(): { code: ScreenUnavailableCode; text: string } | null;
  /** 시작·ARM 때 넘길 막는 대상에 더할 것 */
  policy(): Partial<DesktopPolicy>;
  /** 도우미 알림 (사람 입력·멈춤 단축키·끝남·문제) */
  onHelperEvent(e: DesktopHelperEvent): void;
  /** 도구가 보낸 명령의 답 하나 (잠김 알아채기·내 입력 시각). verb 'READY'는 도우미를 띄우지 못한 것. sentWall: 그 줄을 쓴 때 (벽시계 ms — S6F1a, S6-21 E2) */
  onResult(verb: HelperVerb | 'READY', r: HelperResult<unknown>, identity: TokenIdentity | null, sentWall?: number): void;
  /** 도구가 미리 본 도우미의 문제 (띄우지 않는 중 — 화면 세션 없음 60초·다시 띄우기 상한·띄우기 거부) */
  noteProblem(code: 'no_desktop' | 'helper_failed', text: string, identity: TokenIdentity | null): void;
}

export const RAILS_MISSING_TEXT =
  '화면 조작 안전장치가 붙지 않아 화면 도구를 쓸 수 없습니다 — 서버 PC의 운영자가 서버를 다시 시작해야 합니다. ask_owner로 대표에게 알리세요';

/** 안전장치가 붙기 전의 rails — 모든 화면 도구를 거부한다 (닫힌 쪽이 기본, 리드 결정 S6-19) */
export const CLOSED_RAILS: ScreenRails = Object.freeze({
  deniedKeys: () => RAILS_MISSING_TEXT,
  paused: () => RAILS_MISSING_TEXT,
  rate: () => RAILS_MISSING_TEXT,
  armed: () => undefined,
  noHotkey: () => RAILS_MISSING_TEXT,
  unavailable: () => ({ code: 'helper_failed' as const, text: RAILS_MISSING_TEXT }),
  policy: () => ({}),
  onHelperEvent: () => undefined,
  onResult: () => undefined,
  noteProblem: () => undefined,
});

/** 캡처의 유효 시간 (리드 결정 S6-6) */
export const CAPTURE_VALID_MS = 30_000;
/** 한 장의 PNG 상한 — 넘으면 0.7배로 한 번 다시 찍고, 그래도 크면 파일만 (too_large) */
export const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;
export const CAPTURE_RETAKE_FACTOR = 0.7;
export const DEFAULT_CAPTURE_EDGE = 1280;
/** type 한 번의 글 상한 (코드 포인트) */
export const GUI_TYPE_MAX = 2000;
/** then_capture를 찍기 전에 기다리는 시간 */
export const THEN_CAPTURE_DELAY_MS = 500;
/** screen_info가 싣는 창 수 */
export const SCREEN_INFO_WINDOWS = 50;

export const SCREEN_NO_HELPER_TEXT =
  '화면 조작을 쓸 수 없습니다 — 이 앱에는 화면 도우미가 없습니다 (화면 조작은 서버 모드의 Windows 서버 PC에서만 씁니다)';
export const SECRET_TEXT_REFUSAL =
  '입력할 글에 비밀 값(으로 보이는 글 — 앱이 아는 키·토큰과 그 형식)이 들어 있어 치지 않았습니다. 비밀 값은 화면 조작으로 입력하지 않습니다 — 로그인이 필요한 화면은 서버 PC의 운영자가 한 번 로그인해 두거나 CLI·API 키 같은 다른 길을 쓰고, 막히면 ask_owner로 대표에게 알리세요';
export const SECRET_KEYS_REFUSAL = '키 이름에 비밀 값(으로 보이는 글)이 들어 있어 보내지 않았습니다 — key에는 "ctrl+s" 같은 키 조합만 주세요';
/**
 * type의 글에 탭·줄바꿈 같은 제어 문자가 들었을 때의 거부 글 (리드 결정 S6-21 B1) — what: 처음 걸린 것('탭'·'줄바꿈'·'제어 문자 U+0007'). 글을 되풀이하지 않는다
 */
export const typeControlRefusal = (what: string): string =>
  `type의 글에 탭·줄바꿈 같은 제어 문자(${what})가 들어 있어 치지 않았습니다 — 탭과 Enter는 포커스를 다른 칸으로 옮기거나 양식을 보내므로 글과 한 번에 보내지 않습니다. 글은 type으로, 탭은 gui_input key "tab", 줄바꿈은 key "enter"로 따로 보내고, 그 뒤 다시 캡처해 포커스를 확인하세요`;
/**
 * S6F2b: type이 글자를 보낸 뒤 포커스가 암호 칸이거나 모르는 곳이었을 때 메인에게 가는 글 (리드 결정 S6-23 K2) — 앱이 치는 중에 포커스를 옮겼고, 보낸 글자
 * 일부가 그 칸에 들어갔을 수 있다. 글은 되풀이하지 않는다. sentChars: 보낸 글자 수. restChars: 도우미가 멈춰 치지 않은 글자 수 — null이면 다 친 뒤 다시 읽은
 * 포커스가 암호 칸이거나 모름이었다 (OK 답)
 */
export function typeFocusMovedText(sentChars: number, restChars: number | null): string {
  const sent = sentChars.toLocaleString('ko-KR');
  if (restChars === null) {
    return `글을 치는 동안 포커스가 암호 칸이나 알 수 없는 곳으로 옮겨 갔습니다 — ${sent}자를 보냈고 일부가 그 칸에 들어갔을 수 있습니다. 그 칸에는 다시 치지 마세요`;
  }
  return `글을 치는 동안 포커스가 암호 칸이나 알 수 없는 곳으로 옮겨 가(또는 포커스를 다시 확인하지 못해) 멈췄습니다 — ${sent}자를 보냈고 일부가 그 칸에 들어갔을 수 있습니다. 나머지 ${restChars.toLocaleString('ko-KR')}자는 치지 않았습니다. 그 칸에는 다시 치지 말고, 다시 캡처해 포커스를 확인하세요`;
}
/** 화면 보기 확인을 다른 모델로 띄운 턴이 부를 때의 거부 글 (리드 결정 S6-21 G) */
export const CHECK_OTHER_MODEL_REFUSAL =
  '이 턴은 지금 메인 보유자의 모델로 띄운 턴이 아닙니다 (이 턴을 띄운 뒤 모델이 바뀌었습니다) — 화면 보기 확인은 지금 모델로 띄운 턴만 받고 답합니다. 이 턴에서는 답하지 말고 하던 일을 마치세요';
export const VISION_FAILED_NOTE = '이 보유자는 화면 이미지를 볼 수 없다고 확인됨';
/** 화면 확인 업무가 가는 메인 세션 (records.mainKey(null) — 이 파일은 records와 서로 불러 모듈 시작 때는 그 함수를 쓰지 않는다) */
const MAIN_GENERAL_KEY = 'main:general';
const SWITCHING_REFUSAL = '메인 자리가 넘어가는 중이라 화면 조작을 하지 않았습니다 — 턴을 마치세요';

/** 화면 확인 업무 글에 넣는 표시 — 그 확인의 세대·모델 (다시 넣어도 글이 남는다) */
const CHECK_MARK_RE = /\(화면 확인 g(\d+):([a-z0-9.-]{1,40})\)/;

const VISION_INSTRUCTION =
  '이미지에 보이는 네 자리 숫자를 answer_screen_check(code)로 답하세요. 파일을 프로그램으로 풀어 읽지 말고 이미지로 보세요. 이미지를 볼 수 없으면 짐작하지 말고 답하지 않은 채 턴을 마치세요 — 그러면 이 보유자는 화면 이미지를 볼 수 없다고 기록되고 screen_capture는 글 정보만 줍니다.';

type Args = Record<string, unknown>;

interface VisionCheck {
  key: string;
  generation: number;
  modelKey: string;
  code: string;
  png: Buffer | null;
  file: string | null;
  answered: boolean;
}

/** 보유자의 모델 키 (확인 요청 ID 'screen-check:g<N>:<modelKey>', MainSeatRow.visionModel) */
export function visionModelKey(holder: SeatHolder | null): string {
  if (!holder) return 'none';
  if (holder.kind === 'external') return `ext.${createHash('sha256').update(holder.agentId).digest('hex').slice(0, 8)}`;
  return aiModelKey(holder.ai);
}

/**
 * AI 종류와 모델의 키 — 서버가 띄우는 보유자의 visionModelKey와 같은 값. 메인 턴을 띄울 때 그 턴의 AI로 만들어 토큰 신원(TokenIdentity.modelKey)에 적는다:
 * 화면 보기 확인은 지금 보유자의 모델로 띄운 턴만 받고 답한다 (리드 결정 S6-21 G — 띄운 뒤 모델이 바뀐 턴이 새 모델의 확인을 대신 답하지 못하게)
 */
export function aiModelKey(ai: { kind: string; model: string | null }): string {
  return `${ai.kind}.${createHash('sha256').update(ai.model ?? '').digest('hex').slice(0, 8)}`;
}

/** 화면 도구를 이 앱에서 내놓는지 — 화면 도우미가 있고, 쓰지 않는 실행(데스크톱 앱·Windows 밖·운영자가 끔 — 리드 결정 S6-11)이 아닐 때만 */
export function screenOffered(ctx: Ctx): boolean {
  return !!ctx.deps.desktop && !ctx.deps.screenOff;
}

/**
 * 화면 확인 업무(screen_check)가 끝났는지 (turns.deadWorkReason, 리드 결정 S6-10): 화면 도구를 내놓지 않음, 자리 세대가 바뀜, 보유자의 모델이 바뀜,
 * 이미 확인함(verified·failed). 끝났으면 그 까닭
 */
export function deadScreenCheck(ctx: Ctx, q: QueueEntry): string | null {
  if (!screenOffered(ctx)) return '화면 조작을 쓸 수 없어 화면 확인을 하지 않음';
  const mark = CHECK_MARK_RE.exec(q.message);
  const seat = ctx.store.seat.get('main');
  if (!mark || !seat) return null;
  if (Number(mark[1]) !== seat.generation) return `메인 자리 세대가 바뀜 (확인 세대 ${mark[1]}, 지금 ${seat.generation})`;
  if (mark[2] !== visionModelKey(seat.state === 'switching' ? seat.pendingHolder : seat.holder)) return '메인 보유자의 모델이 바뀜';
  if (seat.vision !== 'unknown') return `이미 확인함 (${seat.vision})`;
  return null;
}

export class DesktopService {
  readonly store: ScreenStore;
  readonly records: GuiRecords;
  /** 안전장치 (리드 결정 S6-8·S6-11) */
  readonly safety: ScreenSafety;
  /** 정지·놓기·다시 시작 뒤 맞추기 (리드 결정 S6-9) */
  readonly lifecycle: ScreenLifecycle;
  /** 처리기가 묻는 안전장치 — 붙기 전에는 모두 거부한다 (CLOSED_RAILS). 생성자가 safety를 붙인다 */
  rails: ScreenRails = CLOSED_RAILS;
  readonly noHelperText = SCREEN_NO_HELPER_TEXT;
  private helper: DesktopHelperClient | null = null;
  private offHelper: (() => void) | null = null;
  /** 끝난 메인 턴 (settleTurn이 적는다 — 최근 것만). 그 턴의 호출이 무장했으면 놓는다 (S6F1a, 리드 결정 S6-21 F1) */
  private readonly endedTurns = new Set<string>();
  /** 이 호출의 인자 개체가 처리기에 닿아 기록(gui_actions)을 남겼는지 — onCall이 성공·거부 줄을 따로 남기지 않게 (리드 결정 S6-7) */
  private readonly reached = new WeakSet<object>();
  /** 화면 확인 — 숫자는 메모리에만 (세대·모델마다) */
  private readonly checks = new Map<string, VisionCheck>();

  constructor(private readonly core: Core) {
    const ctx = core.ctx;
    this.store = new ScreenStore(() => core.mainWork.dir, () => ctx.clock.ms(), (l, m, e) => ctx.log(l, m, e));
    this.records = new GuiRecords(core);
    this.safety = new ScreenSafety(core, this);
    this.lifecycle = new ScreenLifecycle(core, this);
    this.rails = this.safety;
  }

  private get ctx() {
    return this.core.ctx;
  }

  private get deps(): DesktopDeps | undefined {
    return this.ctx.deps.desktop;
  }

  /** 화면 도구를 내놓는지 (도우미 의존성이 있고 쓰지 않는 실행이 아닐 때) */
  offered(): boolean {
    return screenOffered(this.ctx);
  }

  /** 화면 도우미 의존성이 있는지 */
  hasHelper(): boolean {
    return !!this.deps;
  }

  /** 이미 만든 도우미 클라이언트 (만들지 않는다 — 없으면 null) */
  peek(): DesktopHelperClient | null {
    return this.helper;
  }

  /** 잠김의 거부 글 (안전장치가 알림에 쓴다) */
  refusalText(_reason: 'LOCKED', lock: LockKind): string {
    return failureOf({ ok: false, kind: 'err', reason: 'LOCKED', detail: lock, sent: null, lock }, false).message;
  }

  /** 화면 도우미 클라이언트 (처음 부를 때 만든다 — 띄우지는 않는다). 의존성이 없거나 쓰지 않는 실행이면 null */
  client(): DesktopHelperClient | null {
    const d = this.deps;
    if (!d || this.ctx.deps.screenOff) return null;
    if (this.helper) return this.helper;
    const ctx = this.ctx;
    this.helper = createDesktopHelper({
      launcher: d.launcher,
      log: (l, m, e) => ctx.log(l, m, e),
      redact: (t) => ctx.redact.text(t),
      screensDir: () => this.store.ensure(),
      policy: () => this.policy(),
      now: () => Date.now(),
      ...(d.timeouts ? { timeouts: d.timeouts } : {}),
      ...(d.idleMs !== undefined ? { idleMs: d.idleMs } : {}),
      ...(d.kill ? { kill: d.kill } : {}),
    });
    // 정지의 결과('stopped')는 안전장치가 붙어 있든 아니든 lifecycle이 받는다 — 끝남을 확인하지 못한 도우미의 문 (S6F1a, 리드 결정 S6-21 A1·A3)
    this.offHelper = this.helper.onEvent((e) => {
      try {
        this.lifecycle.onHelperEvent(e);
      } finally {
        this.rails.onHelperEvent(e);
      }
    });
    return this.helper;
  }

  /** 끝남을 확인하지 못한 화면 도우미가 있으면 대표에게 보일 글과 그때 (안전장치가 자리 화면·사전 점검에 쓴다 — S6F1a) */
  unconfirmedView(): { text: string; sinceMs: number } | null {
    return this.lifecycle.ownerView();
  }

  /**
   * 막는 대상 (리드 결정 S6-8 '막는 창') — 서버 자신(PID와 콘솔 창 제목 '욱채 서버 (pid N)' — 서버가 process.title로 정한다)과 '욱채'로 시작하는 제목의 창(서버 PC의
   * 브라우저에 연 대표 화면 — 그 창을 누르면 메인이 대표처럼 행동한다). 도우미는 자기 PID와 서버의 조상 프로세스가 가진 콘솔 창을 스스로 더한다
   */
  policy(): DesktopPolicy {
    const extra = this.rails.policy();
    return {
      pids: [...new Set([process.pid, ...(extra.pids ?? [])])],
      titles: [...new Set([serverWindowTitle(process.pid), ...(extra.titles ?? [])])],
      titlePrefixes: [...new Set(['욱채', ...(extra.titlePrefixes ?? [])])],
    };
  }

  /** 지금 쓸 수 없는 까닭 — 없으면 null. 쓰지 않는 실행(안전장치) → 도우미 없음 → 도우미를 띄우지 않는 중 */
  unavailableNow(): { code: ScreenUnavailableCode; text: string } | null {
    const rail = this.rails.unavailable();
    if (rail) return rail;
    if (!this.deps) return { code: 'helper_failed', text: SCREEN_NO_HELPER_TEXT };
    this.client();
    const p = this.blockingProblem();
    return p ? { code: p.code, text: p.text } : null;
  }

  /**
   * 도우미를 지금 띄우지 않는 까닭 (없으면 null) — 화면 세션 없음(60초 동안)과 다시 띄우기 상한(다시 시작할 때까지)뿐이다. 한두 번의 실패(뜻밖의 종료·띄우기
   * 거부)는 마지막 문제로 남아 있어도 다음 호출이 다시 띄운다 — 그것으로 미리 거부하면 다시 띄울 기회가 없어 한 번의 실패가 다시 시작할 때까지 이어진다
   */
  blockingProblem(): DesktopHelperProblem | null {
    const p = this.helper?.problem() ?? null;
    return p && (p.permanent || p.code === 'no_desktop') ? p : null;
  }

  /**
   * 도우미 슬롯을 쥔다 — 그 슬롯으로 보낸 명령의 답마다 안전장치에 알린다(잠김 알아채기·내 입력 시각). 줄은 send 안에서 동기로 쓰인다(그대로). 띄우지 못했으면 그 실패
   */
  private async acquire(client: DesktopHelperClient, identity: TokenIdentity): Promise<HelperLease | HelperUnavailable> {
    const lease = await client.acquire();
    const tell = (verb: HelperVerb | 'READY', r: HelperResult<unknown>, sentWall?: number): void => {
      try {
        this.rails.onResult(verb, r, identity, sentWall);
      } catch (e) {
        this.ctx.log('error', '화면 안전장치가 도우미의 답을 처리하지 못했습니다', e);
      }
    };
    if ('kind' in lease) {
      // 우리가 멈춰서 뜨지 않은 것(긴급 정지·일시정지·교체·앱 종료, 끝남을 확인하지 못한 앞 도우미)은 도우미의 실패가 아니다 — '쓸 수 없음' 알림을 내지 않는다.
      // 부르는 쪽이 그 정지의 글로 거부한다 (leaseRefusal — S6F1a)
      if (!this.haltedNow()) tell('READY', lease);
      return lease;
    }
    return {
      send: <R extends HelperRequest>(req: R): Promise<HelperResult<ReplyOf<R>>> => {
        // 줄을 쓴 때 — 답 없이 끝난 입력은 이때까지만 내 입력으로 본다 (S6F1a, 리드 결정 S6-21 E2)
        const sentWall = Date.now();
        const p = lease.send(req);
        void p.then((r) => tell(req.verb, r, sentWall));
        return p;
      },
      end: () => lease.end(),
    };
  }

  /**
   * 이 호출이 무장한 뒤 거부하게 됐다 — 놓는다 (기다리지 않는다). 놓았다는 답을 받으면 조작 중 표시를 끄고, 답이 없으면 그 도우미를 멈추고 끝낸다 — 턴이 끝났는데
   * 무장한 채(훅·'조작 중' 표시) 남기지 않는다 (S6F1a, 리드 결정 S6-21 F1)
   */
  private dropArm(client: DesktopHelperClient, identity: TokenIdentity): void {
    void this.lifecycle.releaseOrStop(client, identity.turnId).catch((e) => this.ctx.log('warn', '화면 도우미를 놓지 못했습니다', e));
  }

  /**
   * 지금 화면 도우미를 우리가 멈춰 둔 때인지 — 긴급 정지·메인 일시정지·자리 교체·앱 종료, 끝남을 확인하지 못한 앞 도우미 (S6F1a). 표시 위의 놓기도 도우미를
   * 기다린 뒤 이것을 본다 (lifecycle.releaseOverMark — S6-25 N3)
   */
  haltedNow(): boolean {
    const stop = this.ctx.stop();
    return stop.global.active || !!stop.members[MAIN_AGENT_ID]?.paused || this.core.stopping || this.seatRow()?.state === 'switching' || this.lifecycle.gateRefusal() !== null;
  }

  /**
   * 도우미 슬롯을 얻지 못한 호출의 거부 — 기다리는 사이 정지·교체가 정해졌거나 끝남을 확인하지 못한 도우미가 생겼으면 그 글(stopped·conflict·seat_changed)로,
   * 아니면 도우미를 쓸 수 없다는 글(unavailable)로 (S6F1a, 리드 결정 S6-21 A1)
   */
  private leaseRefusal(identity: TokenIdentity, guards: ScreenGuards, lease: HelperUnavailable, already?: string): { code: string; message: string } {
    const why = this.recheckNow(identity, guards, 'capture', already);
    return why && why.code !== 'human_active' ? why : { code: 'unavailable', message: lease.text };
  }

  /** 그 호출의 메인 턴이 끝났는지 (끝나는 중·곧 끝낼 턴 포함) — 끝난 턴을 위해 무장한 채 두거나 찍지 않는다 (S6F1a, 리드 결정 S6-21 F1) */
  private turnGone(identity: TokenIdentity): boolean {
    return this.endedTurns.has(identity.turnId) || this.core.turns.mainCallerGone(identity.turnId);
  }

  // ───────────────────────── onCall·도구 설명 ─────────────────────────

  /** 처리기에 닿아 기록을 남긴 호출 (인자 개체로) */
  markReached(args: object): void {
    this.reached.add(args);
  }

  reachedHandler(args: object): boolean {
    return this.reached.has(args);
  }

  /** 호출자에게 보일 도구 설명 — 이미지를 볼 수 없다고 확인된 보유자의 screen_capture에 그 사실을 붙인다 (리드 결정 S6-6) */
  describe(identity: TokenIdentity, spec: ToolSpec): string {
    if (spec.name !== 'screen_capture' || !identity.isMain) return spec.description;
    return this.seatRow()?.vision === 'failed' ? `${spec.description} ${VISION_FAILED_NOTE} — 이미지 대신 글 정보(창 위치는 캡처 좌표)를 돌려줍니다.` : spec.description;
  }

  private seatRow(): MainSeatRow | null {
    return this.ctx.store.seat.get('main');
  }

  /** 지금 자리의 보유자 (교체 중이면 나가는 보유자) */
  private holder(): SeatHolder | null {
    return this.seatRow()?.holder ?? null;
  }

  private fallbackHint(): string {
    const h = this.holder();
    return h?.kind === 'launched' && h.ai.kind === 'codex' ? 'file을 view_image로 여세요' : 'file을 Read로 여세요';
  }

  // ───────────────────────── 기록 한 줄 ─────────────────────────

  private rowBase(identity: TokenIdentity, action: GuiActionRow['action'], requestId: string | null): RowFields {
    return {
      at: this.ctx.now(),
      generation: identity.seatGeneration ?? this.core.seat.generation(),
      turnId: identity.turnId,
      projectId: identity.workProjectId ?? null,
      by: 'main',
      action,
      requestId,
      dispatched: false,
      x: null,
      y: null,
      x2: null,
      y2: null,
      button: null,
      count: null,
      amount: null,
      beforeCaptureId: null,
      afterCaptureId: null,
      capture: null,
    };
  }

  // ───────────────────────── screen_capture ─────────────────────────

  /**
   * callArgs: 앱 도구 서버가 처리기와 기록(onCall)에 함께 넘긴 원래 인자 개체 — '처리기에 닿았다'는 표시는 여기에 한다. a는 tools.ts가 가린 사본이라 거기에
   * 표시하면 onCall이 알아보지 못해 거부마다 app_tool 줄이 하나 더 남는다 (리드 결정 S6-21 E1). 처리기를 직접 부르는 쪽은 주지 않아도 된다(a에 표시)
   */
  async capture(identity: TokenIdentity, member: Member, a: Args, guards: ScreenGuards, callArgs: object = a): Promise<ScreenToolOutput> {
    if (!member.isMain) throw new BackendError('forbidden', '메인 에이전트만 쓸 수 있는 도구입니다');
    this.markReached(callArgs);
    // 대표의 정지 해제가 화면 도우미의 끝남을 다시 확인하는 중이면 그 결과를 기다린다 (S6F1a, 리드 결정 S6-21 A2)
    await this.lifecycle.rechecked();
    const base = this.rowBase(identity, 'capture', null);
    const refuse = (code: string, message: string): never => {
      this.records.insert({ ...base, result: code as GuiActionRow['result'], detail: message });
      throw new BackendError(code, message);
    };
    // 1. 모양
    const screen = a.screen === undefined ? 1 : a.screen;
    if (screen !== 'all' && !(Number.isInteger(screen) && (screen as number) >= 1 && (screen as number) <= 16)) refuse('invalid', 'screen은 1~16의 모니터 번호나 "all"입니다');
    const maxEdge = a.max_width === undefined ? DEFAULT_CAPTURE_EDGE : a.max_width;
    if (!Number.isInteger(maxEdge) || (maxEdge as number) < 320 || (maxEdge as number) > 1568) refuse('invalid', 'max_width는 320~1568 사이의 정수입니다');
    // 2. 쓸 수 없음 · 교체 중 · 정지
    this.preflight(identity, guards, refuse);
    // 5. 사람 우선 · 횟수
    const paused = this.rails.paused('capture');
    if (paused) refuse('human_active', paused);
    const rate = this.rails.rate('capture', identity);
    if (rate) refuse('rate_limited', rate);
    const shot = await this.shoot(identity, { screen: screen as number | 'all', maxEdge: maxEdge as number, cause: 'capture' }, guards);
    if (!shot.ok) return refuse(shot.code, shot.message);
    this.records.insert({ ...base, at: shot.result.taken_at, result: 'ok', capture: shot.record, focus: shot.focus });
    return { data: shot.result, ...(shot.image ? { images: [shot.image] } : {}) };
  }

  /** 2단계 공통 (screen_capture·screen_info·gui_input): 쓸 수 없음 → 끝남을 확인하지 못한 화면 도우미 → 교체 중 → 정지 */
  private preflight(identity: TokenIdentity, guards: ScreenGuards, refuse: (code: string, message: string) => never): void {
    // 끝남을 확인하지 못한 화면 도우미가 있으면 화면 도구는 stopped다 — 그 도우미가 살아 있을 수 있어 새 도우미도 띄우지 않는다. 대표의 정지 해제가 다시 확인해
    // 풀거나 서버 시작이 푼다 (S6F1a, 리드 결정 S6-21 A1). 화면 조작을 쓰지 않는 실행·도우미 없는 실행은 아래의 unavailable이 먼저다
    if (!this.rails.unavailable() && this.deps) {
      const gate = this.lifecycle.gateRefusal();
      if (gate) refuse('stopped', gate);
    }
    const un = this.unavailableNow();
    if (un) {
      // 도우미가 띄우지 않는 중(화면 세션 없음·다시 띄우기 상한·띄우기 거부)이면 마지막으로 안 상태로 남긴다 — 대표 알림과 메인 알림 업무 (S6-11)
      if (!this.rails.unavailable() && this.deps && (un.code === 'no_desktop' || un.code === 'helper_failed')) this.rails.noteProblem(un.code, un.text, identity);
      refuse('unavailable', un.text);
    }
    if (this.seatRow()?.state === 'switching') refuse('conflict', SWITCHING_REFUSAL);
    try {
      guards.assertNotStopped();
    } catch (e) {
      if (e instanceof BackendError) refuse(e.code, e.message);
      throw e;
    }
  }

  /** 기다림 뒤 다시 보기 (리드 결정 S5-63) — 부른 쪽·자리·정지·교체·멈춤. 거부면 그 코드와 글 */
  private recheckNow(identity: TokenIdentity, guards: ScreenGuards, kind: 'input' | 'capture', already?: string): { code: string; message: string } | null {
    try {
      guards.recheck(already);
    } catch (e) {
      if (e instanceof BackendError) return { code: e.code, message: e.message };
      throw e;
    }
    const stop = this.ctx.stop();
    if (stop.global.active) return { code: 'stopped', message: `긴급 정지 중에는 화면 조작을 하지 않습니다. 턴을 마치세요${already ? ` (${already})` : ''}` };
    if (stop.members[MAIN_AGENT_ID]?.paused) return { code: 'stopped', message: `메인 에이전트 일시정지 중에는 화면 조작을 하지 않습니다. 턴을 마치세요${already ? ` (${already})` : ''}` };
    if (this.core.stopping) return { code: 'stopped', message: '앱을 끝내는 중이라 화면 조작을 하지 않았습니다' };
    // 기다리는 사이 어느 정지가 화면 도우미의 끝남을 확인하지 못했다 (S6F1a, 리드 결정 S6-21 A1)
    const gate = this.lifecycle.gateRefusal();
    if (gate) return { code: 'stopped', message: `${gate}${already ? ` (${already})` : ''}` };
    if (this.seatRow()?.state === 'switching') return { code: 'conflict', message: `${SWITCHING_REFUSAL}${already ? ` (${already})` : ''}` };
    const paused = this.rails.paused(kind);
    if (paused) return { code: 'human_active', message: paused };
    void identity;
    return null;
  }

  /**
   * 캡처 한 장 (screen_capture와 then_capture): 준비·ARM → CAPTURE → FOCUS (글 정보만이면 WINDOWS) → 다시 보기 → 파일 다시 해시 → 4MiB 넘으면 0.7배로 한 번 →
   * 결과. 거부·실패면 쓴 파일을 지운다. 기록 줄은 부르는 쪽이 남긴다
   */
  private async shoot(
    identity: TokenIdentity,
    o: { screen: number | 'all'; maxEdge: number; cause: 'capture' | 'after_input' },
    guards: ScreenGuards,
    already?: string,
  ): Promise<
    | { ok: true; result: ScreenCaptureResult; record: GuiCaptureRecord; image: ToolImage | null; focus: HelperFocus | null }
    | { ok: false; code: string; message: string }
  > {
    const client = this.client();
    if (!client) return { ok: false, code: 'unavailable', message: this.unavailableNow()?.text ?? SCREEN_NO_HELPER_TEXT };
    const lease = await this.acquire(client, identity);
    if ('kind' in lease) return { ok: false, ...this.leaseRefusal(identity, guards, lease, already) };
    const written: string[] = [];
    const drop = (): void => {
      for (const id of written) this.store.remove(id);
    };
    let armedHere = false;
    /**
     * 무장한 뒤의 거부·실패 (S6F1a, 리드 결정 S6-21 F1): 이 호출이 무장했는데 그 턴이 끝났으면 놓는다 — 턴 끝의 놓기가 이 무장보다 먼저 지나갔을 수 있다.
     * 다시 보기의 거부(정지·교체·자리 바뀜)도 놓는다. 턴이 살아 있는 사람 우선 멈춤·캡처 실패는 훅을 켜 둔다 — 그 사람의 다음 입력을 본다
     */
    const leave = (refusal: string | null): void => {
      if (armedHere && (this.turnGone(identity) || (refusal !== null && refusal !== 'human_active'))) this.dropArm(client, identity);
    };
    try {
      // 슬롯을 기다리는 사이 턴이 끝나거나 자리가 바뀌었으면 무장하지 않는다 (끝난 턴의 훅·표시가 남지 않게)
      const before = this.recheckNow(identity, guards, 'capture', already);
      if (before) return { ok: false, ...before };
      armedHere = !client.armed();
      const armed = await this.arm(client, lease, identity, guards, 'capture', already);
      if (armed) return { ok: false, ...armed };
      // 무장을 기다린 뒤 다른 무엇보다 먼저 다시 본다 — 그사이 턴이 끝났거나 정지·교체가 정해졌으면 찍지 않고 놓는다(끝난 턴을 위해 찍지 않는다). 무장하며 알게 된
      // 사람 입력(시작 값 — 방금 전까지 사람이 그 PC를 썼다)이면 찍지 않되 훅은 켜 둔다 (리드 결정 S6-8 '사람 우선', S6-21 F1)
      const armedCheck = this.recheckNow(identity, guards, 'capture', already);
      if (armedCheck) {
        leave(armedCheck.code);
        return { ok: false, ...armedCheck };
      }
      const vision = this.seatRow()?.vision ?? 'unknown';
      let edge = o.maxEdge;
      let id = this.ctx.store.nextId('capture');
      written.push(id);
      let cap = await lease.send({ verb: 'CAPTURE', screen: o.screen, maxEdge: edge, id });
      if (!cap.ok) {
        drop();
        leave(null);
        return { ok: false, ...failureOf(cap, false) };
      }
      let file = this.store.read(id);
      if (file && file.length > MAX_CAPTURE_BYTES) {
        // 4MiB를 넘었다 — 0.7배로 한 번 다시 찍는다 (앞 파일은 지운다). 그 앞에서도 다시 본다 — 끝난 턴을 위해 한 장 더 찍지 않는다
        this.store.remove(id);
        const retake = this.recheckNow(identity, guards, 'capture', already);
        if (retake) {
          drop();
          leave(retake.code);
          return { ok: false, ...retake };
        }
        edge = Math.max(1, Math.round(edge * CAPTURE_RETAKE_FACTOR));
        id = this.ctx.store.nextId('capture');
        written.push(id);
        cap = await lease.send({ verb: 'CAPTURE', screen: o.screen, maxEdge: edge, id });
        if (!cap.ok) {
          drop();
          leave(null);
          return { ok: false, ...failureOf(cap, false) };
        }
        file = this.store.read(id);
      }
      if (!file || sha256Of(file) !== cap.value.sha256) {
        drop();
        leave(null);
        return { ok: false, code: 'error', message: '캡처 파일을 확인하지 못했습니다 (파일이 없거나 해시가 도우미의 답과 다릅니다) — 다시 캡처하세요' };
      }
      const focusR = await lease.send({ verb: 'FOCUS' });
      const focus = focusR.ok ? focusR.value : null;
      const textOnly = vision === 'failed';
      const winsR = textOnly ? await lease.send({ verb: 'WINDOWS' }) : null;
      lease.end();
      // 기다림 뒤 다시 본다 — 그사이 자리가 바뀌거나 턴이 끝났으면 기록하지 않고 파일을 지운다 (S5-63)
      const again = this.recheckNow(identity, guards, 'capture', already);
      if (again) {
        drop();
        leave(again.code);
        return { ok: false, ...again };
      }
      const tooLarge = file.length > MAX_CAPTURE_BYTES;
      const image: ScreenCaptureResult['image'] = tooLarge ? 'too_large' : textOnly ? 'text_only' : 'attached';
      const frame = frameOf(cap.value);
      const takenMs = this.ctx.clock.ms();
      const notes: string[] = [];
      if (tooLarge) notes.push(`이미지가 ${Math.round(file.length / 1024 / 1024)}MiB로 너무 커 붙이지 않았습니다 — 파일만 남겼습니다 (${this.fallbackHint()}, 또는 max_width를 줄이세요)`);
      if (image === 'text_only') notes.push(`${VISION_FAILED_NOTE} — 이미지 대신 창 목록(캡처 좌표)과 포커스를 드립니다. gui_input 좌표는 이 캡처의 좌표입니다`);
      if (vision === 'unknown' && image === 'attached') notes.push(`이 보유자가 화면 이미지를 볼 수 있는지 아직 확인하지 않았습니다 — 이미지가 보이지 않으면 ${this.fallbackHint()}`);
      if (isAllBlackPng(file)) notes.push('캡처가 모두 검습니다 — 화면이 잠겼거나 꺼졌을 수 있습니다. screen_info로 확인하고, 잠겼으면 사람이 풀어야 하니 ask_owner로 대표에게 알리세요');
      const record: GuiCaptureRecord = {
        id,
        screen: o.screen,
        width: cap.value.width,
        height: cap.value.height,
        scale: captureScale(frame),
        originX: frame.originX,
        originY: frame.originY,
        realWidth: frame.realWidth,
        realHeight: frame.realHeight,
        layout: cap.value.layout,
        sha256: cap.value.sha256,
        bytes: file.length,
        cause: o.cause,
        image,
        focusApp: focus?.app ?? null,
      };
      const result: ScreenCaptureResult = {
        capture_id: id,
        screen: o.screen,
        width: record.width,
        height: record.height,
        scale: record.scale,
        origin: { x: frame.originX, y: frame.originY },
        taken_at: new Date(takenMs).toISOString(),
        expires_at: new Date(takenMs + CAPTURE_VALID_MS).toISOString(),
        file: this.store.capturePath(id),
        image,
        focus: this.focusSummary(focus),
        ...(textOnly && winsR?.ok ? { windows: winsR.value.windows.flatMap((w) => this.windowInCapture(w, frame)).slice(0, SCREEN_INFO_WINDOWS) } : {}),
        note: notes.length ? notes.join(' ') : null,
      };
      // 다른 캡처를 지운 뒤 남긴다 (24시간·최근 500장)
      this.store.sweep();
      written.length = 0;
      return { ok: true, result, record, image: image === 'attached' ? { mimeType: 'image/png', data: file.toString('base64') } : null, focus };
    } finally {
      lease.end();
    }
  }

  /**
   * 무장하지 않았으면 ARM (그 턴의 첫 캡처나 입력부터 — S6-4). 실패면 그 거부.
   * 놓았다는 답을 받지 못한 무장 표시(kv desktop:armed)가 남아 있으면 — 앞 도우미가 무장한 채 죽었거나 놓기·STOP에 답 없이 끝났다 — 이 도우미에 RELEASE를 먼저
   * 보내 답을 받은 뒤에 무장한다. 답을 받지 못하면 무장하지 않고 unavailable이다 (S6F1a, 리드 결정 S6-21 A4) — 대표의 자리 화면·사전 점검·알림에도 남긴다
   * (S6-23 M2). 무장이 실패하면 무장에 성공했을 때와 같은 다시 보기를 먼저 한다 — 기다리는 사이 정해진 긴급 정지·교체·끝난 턴은 그 글(stopped·conflict)로
   * 거부한다 (S6F2a, 리드 결정 S6-23 M4)
   */
  private async arm(
    client: DesktopHelperClient,
    lease: HelperLease,
    identity: TokenIdentity,
    guards: ScreenGuards,
    kind: 'input' | 'capture',
    already?: string,
  ): Promise<{ code: string; message: string } | null> {
    if (client.armed()) return null;
    if (this.safety.armedMark()) {
      const released = await this.lifecycle.releaseOverMark('arm');
      if (!released.ok) return this.halted(identity, guards, kind, already) ?? this.unreleased(identity, released.reason);
    }
    const r = await lease.send({ verb: 'ARM', policy: this.policy() });
    if (!r.ok) return this.halted(identity, guards, kind, already) ?? failureOf(r, false);
    // 조작 중 표시·놓기 표시는 도우미가 보낸 줄의 순서를 따른다 — 그 답 뒤에 먼저 처리된 HOTKEY·RELEASE의 답·STOP이 무장을 풀었으면 켜지 않는다 (S6-25 N1)
    this.rails.armed(r.value, identity, client.armed());
    return null;
  }

  /** 실패한 무장·놓기 뒤의 다시 보기 — 기다리는 사이 정해진 정지·교체·끝난 턴이면 그 거부(사람 우선 멈춤은 빼고 — 실패가 먼저다), 없으면 null (S6-23 M4) */
  private halted(identity: TokenIdentity, guards: ScreenGuards, kind: 'input' | 'capture', already?: string): { code: string; message: string } | null {
    const why = this.recheckNow(identity, guards, kind, already);
    return why && why.code !== 'human_active' ? why : null;
  }

  /**
   * 놓았다는 답을 받지 못한 표시 위에서 새 도우미로도 놓지 못했다 — unavailable. 대표의 자리 화면·사전 점검·알림과 메인 알림 업무에 남긴다 (noteProblem —
   * 리드 결정 S6-23 M2). reason: 그 실패의 사실 (응답 없음·띄우지 못함)
   */
  private unreleased(identity: TokenIdentity, reason: string): { code: string; message: string } {
    try {
      this.rails.noteProblem('helper_failed', `${UNRELEASED_PROBLEM} (${reason})`, identity);
    } catch (e) {
      this.ctx.log('error', '화면 안전장치가 놓기 실패를 남기지 못했습니다', e);
    }
    return { code: 'unavailable', message: UNRELEASED_REFUSAL };
  }

  private focusSummary(f: HelperFocus | null): ScreenFocusSummary | null {
    if (!f) return null;
    const redact = this.ctx.redact;
    return { app: redact.text(f.app), title: redact.text(f.title), control: f.control, password: f.password };
  }

  /** 실제 좌표의 창 → 그 캡처 좌표의 창 (겹치지 않으면 뺀다) */
  private windowInCapture(w: HelperWindow, f: CaptureFrame): ScreenWindowInfo[] {
    const r = rectToImage(f, w);
    if (!r) return [];
    const redact = this.ctx.redact;
    return [{ title: redact.text(w.title), app: redact.text(w.app), ...r, minimized: w.minimized, blocked: w.blocked || w.elevated }];
  }

  // ───────────────────────── screen_info ─────────────────────────

  async info(identity: TokenIdentity, member: Member, a: Args, guards: ScreenGuards): Promise<ScreenToolOutput> {
    if (!member.isMain) throw new BackendError('forbidden', '메인 에이전트만 쓸 수 있는 도구입니다');
    const refuse = (code: string, message: string): never => {
      throw new BackendError(code, message);
    };
    // 대표의 정지 해제가 화면 도우미의 끝남을 다시 확인하는 중이면 그 결과를 기다린다 (S6F1a, 리드 결정 S6-21 A2)
    await this.lifecycle.rechecked();
    this.preflight(identity, guards, refuse);
    // 사람 우선 멈춤 중에도 쓴다 (화면을 바꾸지 않는다) — 횟수만 센다 (리드 결정 S6-19)
    const rate = this.rails.rate('info', identity);
    if (rate) refuse('rate_limited', rate);
    const client = this.client()!;
    const lease = await this.acquire(client, identity);
    if ('kind' in lease) refuse(...codeMessage(this.leaseRefusal(identity, guards, lease)));
    const l = lease as HelperLease;
    try {
      const screens = await l.send({ verb: 'SCREENS' });
      if (!screens.ok) return refuse(...codeMessage(failureOf(screens, false)));
      const wins = await l.send({ verb: 'WINDOWS' });
      if (!wins.ok) return refuse(...codeMessage(failureOf(wins, false)));
      const focus = await l.send({ verb: 'FOCUS' });
      l.end();
      const again = this.recheckNow(identity, guards, 'input');
      if (again && again.code !== 'human_active') refuse(again.code, again.message);
      const redact = this.ctx.redact;
      const data: ScreenInfoResult = {
        screens: screens.value.screens.map((s) => ({ index: s.index, primary: s.primary, x: s.x, y: s.y, width: s.width, height: s.height, dpi: s.dpi })),
        windows: wins.value.windows.slice(0, SCREEN_INFO_WINDOWS).map((w) => ({
          title: redact.text(w.title),
          app: redact.text(w.app),
          x: w.x,
          y: w.y,
          width: w.width,
          height: w.height,
          minimized: w.minimized,
          blocked: w.blocked || w.elevated,
        })),
        windows_total: wins.value.total,
        focus: this.focusSummary(focus.ok ? focus.value : null),
        note: '좌표는 실제 픽셀(가상 화면 — 왼쪽·위 모니터는 음수)입니다. gui_input에는 screen_capture의 capture_id와 그 이미지의 좌표를 주세요. blocked인 창(욱채 서버·화면, 관리자 권한 창 등)에는 입력할 수 없습니다.',
      };
      void a;
      return { data };
    } finally {
      l.end();
    }
  }

  // ───────────────────────── gui_input ─────────────────────────

  async input(identity: TokenIdentity, member: Member, raw: Args, requestId: string | null, guards: ScreenGuards): Promise<ScreenToolOutput> {
    if (!member.isMain) throw new BackendError('forbidden', '메인 에이전트만 쓸 수 있는 도구입니다');
    this.markReached(raw);
    // 대표의 정지 해제가 화면 도우미의 끝남을 다시 확인하는 중이면 그 결과를 기다린다 (S6F1a, 리드 결정 S6-21 A2)
    await this.lifecycle.rechecked();
    const ctx = this.ctx;
    const action = (typeof raw.action === 'string' ? raw.action : '') as GuiActionRow['action'];
    const generation = identity.seatGeneration ?? this.core.seat.generation();
    // 같은 세대에서 같은 request_id로 이미 입력 줄을 썼으면 다시 보내지 않는다 — 도구 중복 캐시가 없어도(재시작·캐시 정리) (AC-45, 리드 결정 S6-6)
    if (requestId) {
      const prev = this.records.repo.dispatchedRequest(generation, requestId);
      if (prev) return { data: duplicateOf(prev, requestId) };
    }
    const text = typeof raw.text === 'string' ? raw.text : null;
    const keys = typeof raw.keys === 'string' ? raw.keys : null;
    const captureId = typeof raw.capture_id === 'string' ? raw.capture_id : null;
    // 글(rawText)은 어느 줄에도 길이만 남는다 — 글 자체는 도우미가 포커스를 판정한 칸에 쳤을 때만 답을 받은 뒤 채운다 (records.finish의 typedText, 리드 결정
    // S6-21 C2). 보내기 전의 거부(오래된 캡처·사람 우선·횟수·정지·교체·모양)는 그 글이 어느 칸에 갈 것이었는지 아무도 보지 않았다
    const fields = {
      ...this.rowBase(identity, GUI_ACTIONS.has(action) ? action : 'move', requestId),
      button: (['left', 'right', 'middle'] as const).find((b) => b === raw.button) ?? null,
      count: typeof raw.count === 'number' ? raw.count : null,
      amount: typeof raw.amount === 'number' ? raw.amount : null,
      beforeCaptureId: captureId,
      rawText: text,
      keys,
    };
    const refuse = (code: string, message: string, extra: Partial<GuiRecordInput> = {}): never => {
      this.records.insert({ ...fields, ...extra, result: code as GuiActionRow['result'], detail: message });
      throw new BackendError(code, message);
    };

    // ── 1. 모양 ──
    const shape = this.inputShape(action, raw, text, keys, captureId);
    if (typeof shape === 'string') refuse('invalid', shape);
    const s = shape as InputShape;
    // ── 2. 쓸 수 없음 · 교체 중 · 정지 ──
    this.preflight(identity, guards, refuse);
    // ── 3. 비밀 값이 든 글 · 막는 키 조합 (값을 되풀이하는 어떤 글보다 먼저 — 가리기가 실패해도 다른 글이 나와 막힌다, S5-83) ──
    if (text !== null && ctx.redact.text(text) !== text) refuse('secret_blocked', SECRET_TEXT_REFUSAL);
    if (keys !== null && ctx.redact.text(keys) !== keys) refuse('secret_blocked', SECRET_KEYS_REFUSAL);
    // 탭·줄바꿈 같은 제어 문자가 든 글은 치지 않는다 — 탭·Enter 뒤의 글자가 암호 칸 검사를 받지 않은 다음 칸에 들어간다. 비밀 값 검사 뒤에 본다 — 비밀 값이 든
    // 글은 secret_blocked가 먼저다 (리드 결정 S6-21 B1). 도우미도 같은 글을 거부한다(ERR BAD_TEXT)
    if (action === 'type' && text !== null) {
      const control = controlCharIn(text);
      if (control) refuse('invalid', typeControlRefusal(control));
    }
    if (keys !== null) {
      // 도우미와 같은 법으로 읽는다 — 읽지 못하는 조합은 막는 조합인지도 볼 수 없어 보내지 않는다(모양 거부). 비밀 값 검사 뒤에 본다 — 키 이름 자리에 든 비밀 값은
      // secret_blocked가 먼저다 (core/screenGuard.ts, 리드 결정 S6-8)
      if (!parseKeyCombo(keys)) {
        refuse('invalid', 'keys를 알아볼 수 없습니다 — 수정 키(ctrl·alt·shift·win)와 키 하나(enter·tab·esc·f1~f24·delete·up 같은 이름이나 글자 하나)를 +로 이어 주세요 (예: "ctrl+s")');
      }
      const denied = this.rails.deniedKeys(keys);
      if (denied) refuse('denied_target', denied);
    }
    // ── 4. 캡처 ──
    let cap: GuiActionRow | null = null;
    if (action !== 'release') {
      cap = captureId ? this.records.repo.byCapture(captureId) : null;
      if (!cap?.capture) refuse('invalid', `모르는 캡처입니다 (${captureId ?? '없음'}) — screen_capture로 새로 찍은 capture_id를 주세요`);
      if (cap!.generation !== generation) refuse('seat_changed', `다른 세대(${cap!.generation})의 캡처입니다 — 지금 세대에서 screen_capture로 다시 찍으세요`);
      const age = ctx.clock.ms() - Date.parse(cap!.at);
      if (!(age <= CAPTURE_VALID_MS)) refuse('stale_capture', `캡처(${captureId})가 ${Math.round(age / 1000)}초 전 것이라 오래됐습니다 (30초까지) — 오래된 화면을 보고 누르지 않게 screen_capture로 다시 찍으세요`);
    }
    // 점이 그 캡처 안인지 (1단계의 일부 — 캡처를 알아야 본다)
    const frame = cap?.capture ?? null;
    if (frame) {
      for (const [px, py] of s.points) {
        if (!insideCapture(frame, px, py)) refuse('invalid', `좌표 (${px}, ${py})가 캡처 ${frame.id}(${frame.width}×${frame.height}) 밖입니다 — 그 캡처 이미지의 픽셀로 주세요`);
      }
    }
    const real = frame ? s.points.map(([px, py]) => toReal(frame, px, py)) : [];
    const coordFields = { x: real[0]?.x ?? null, y: real[0]?.y ?? null, x2: real[1]?.x ?? null, y2: real[1]?.y ?? null };
    // ── 5. 사람 우선 · 횟수 (놓기는 늘 받는다) ──
    if (action !== 'release') {
      const paused = this.rails.paused('input');
      if (paused) refuse('human_active', paused, coordFields);
      const rate = this.rails.rate('input', identity);
      if (rate) refuse('rate_limited', rate, coordFields);
    }
    const client = this.client()!;
    if (action === 'release') return this.releaseInput(identity, guards, fields, requestId);

    // ── 6. 준비 · ARM ──
    const lease = await this.acquire(client, identity);
    if ('kind' in lease) {
      const why = this.leaseRefusal(identity, guards, lease);
      refuse(why.code, why.message, coordFields);
    }
    const l = lease as HelperLease;
    let row: GuiActionRow | null = null;
    let reply: Awaited<ReturnType<HelperLease['send']>> | null = null;
    try {
      // 슬롯을 기다리는 사이 턴이 끝나거나 자리가 바뀌었으면 무장하지 않는다
      const before = this.recheckNow(identity, guards, 'input');
      if (before) refuse(before.code, before.message, coordFields);
      const armedHere = !client.armed();
      const armed = await this.arm(client, l, identity, guards, 'input');
      if (armed) refuse(armed.code, armed.message, coordFields);
      // ── 7. 한 동기 구간: 다시 보기 → 'sent' 줄 → 줄 쓰기 ──
      const again = this.recheckNow(identity, guards, 'input');
      if (again) {
        // 이 호출이 무장한 뒤 턴이 끝났으면 놓는다 (턴 끝의 놓기가 무장보다 먼저 지나갔을 수 있다) — 정지·교체의 거부도. 턴이 살아 있는 사람 우선 멈춤은 훅을 켜 둔다
        // (S6F1a, 리드 결정 S6-21 F1)
        if (armedHere && (again.code !== 'human_active' || this.turnGone(identity))) this.dropArm(client, identity);
        refuse(again.code, again.message, coordFields);
      }
      // 멈춤 단축키를 등록하지 못한 도우미에는 입력을 보내지 않는다 — 서버 PC 앞의 사람이 멈출 길이 없다. 캡처는 된다 (S6F1a, 리드 결정 S6-21 D).
      // 거부하기 전에 무장을 놓는다(답을 기다린다) — 도우미는 ARM 때만 단축키를 다시 걸어 보므로, 같은 턴의 다음 gui_input이 다시 ARM해 그 프로그램이 닫혔는지
      // 알게 한다 (알림 업무의 '풀렸는지는 다음 gui_input이 알려 줍니다'가 참이게, S6F2a, 리드 결정 S6-23 L)
      const noHotkey = this.rails.noHotkey();
      if (noHotkey) {
        await this.lifecycle.releaseOrStop(client, identity.turnId).catch((e) => this.ctx.log('warn', '화면 도우미를 놓지 못했습니다', e));
        refuse('unavailable', noHotkey, coordFields);
      }
      const cmd = helperInputOf(action, s, real, frame!.layout);
      // 글은 답을 받은 뒤에 남긴다 — 도우미가 암호 칸이라 거부하면 그 글(비밀번호일 수 있다)은 기록에 남지 않는다 (길이만)
      row = this.records.insert({ ...fields, ...coordFields, result: 'sent', dispatched: true });
      const p = l.send(cmd);
      // ── 8. 답 (이 뒤로는 거부하지 않는다) ──
      reply = await p;
    } finally {
      l.end();
    }
    if (!row || !reply) throw new BackendError('error', '입력을 보내지 못했습니다');
    if (!reply.ok) {
      const f = failureOf(reply, true);
      // 글을 남기는 것은 도우미가 포커스를 판정한 뒤 일부라도 친 중단(sent > 0 — 정지·놓기·사람 입력)뿐이다. 그 밖의 거부·실패(잠김, 막는 창·높은 권한 창, 암호
      // 칸·모르는 포커스, 답 없음, 도우미가 끝남)는 포커스를 판정하기 전이거나 무엇을 쳤는지 모른다 — 길이만 남는다 (리드 결정 S6-21 C2)
      const typedSome = reply.kind === 'err' && reply.sent !== null && reply.sent > 0;
      // 치는 중에 포커스가 암호 칸·모르는 곳으로 옮겨 가 도우미가 멈췄다 (FOCUS_UNKNOWN sent > 0 — S6F2b, 리드 결정 S6-23 K2): 보낸 글자 일부가 그 칸에
      // 들어갔을 수 있다. secret_blocked이고 길이만 남는다 — 몇 자를 보냈는지 알린다
      if (action === 'type' && text !== null && typedSome && reply.kind === 'err' && reply.reason === 'FOCUS_UNKNOWN') {
        const sentChars = codePoints(text.slice(0, reply.sent!));
        const message = typeFocusMovedText(sentChars, codePoints(text) - sentChars);
        this.records.finish(row, { result: 'secret_blocked', detail: message, sentChars });
        throw new BackendError('secret_blocked', message);
      }
      this.records.finish(row, { result: f.code as GuiActionRow['result'], detail: f.message, ...(typedSome ? { typedText: text } : {}) });
      throw new BackendError(f.code, f.message);
    }
    const focus = reply.value as HelperFocus | null;
    const focusRecord = focus ? { app: focus.app, title: focus.title, password: focus.password } : null;
    // 도우미가 다 친 뒤 다시 읽은 포커스가 암호 칸이거나 모른다 — 치는 동안 앱이 포커스를 옮겼다 (S6F2b, 리드 결정 S6-23 K2). 글자는 모두 보냈고 일부가 그
    // 칸에 들어갔을 수 있다: secret_blocked로 끝내고 길이만 남긴다 (리드 결정 S6-21 C2)
    if (action === 'type' && text !== null && (!focus || focus.password !== false)) {
      const sentChars = codePoints(text);
      const message = typeFocusMovedText(sentChars, null);
      this.records.finish(row, { result: 'secret_blocked', focus: focusRecord, detail: message, sentChars });
      throw new BackendError('secret_blocked', message);
    }
    row = this.records.finish(row, { result: 'ok', focus: focusRecord, typedText: text });
    const realOut = real.length ? { x: real[0]!.x, y: real[0]!.y, ...(real[1] ? { x2: real[1].x, y2: real[1].y } : {}) } : null;
    const result: GuiInputResult = {
      request_id: requestId ?? '',
      action,
      real: realOut,
      focus: this.focusSummary(focus),
      after: null,
      after_note: null,
      message: `${GUI_ACTION_DONE[action]} (실제 좌표${realOut ? ` ${realOut.x},${realOut.y}${realOut.x2 !== undefined ? ` → ${realOut.x2},${realOut.y2}` : ''}` : ' 없음'})`,
    };
    // ── 9. then_capture (기본 켬) ──
    if (raw.then_capture === false) return { data: result };
    await new Promise<void>((r) => setTimeout(r, THEN_CAPTURE_DELAY_MS));
    const sent = '입력은 보냈습니다';
    const why = this.recheckNow(identity, guards, 'capture', sent) ?? (this.rails.rate('capture', identity) ? { code: 'rate_limited', message: '캡처 횟수 상한' } : null);
    if (why) {
      result.after_note = `${sent} — 그 뒤 ${afterReason(why.code)}로 캡처하지 않았습니다`;
      return { data: result };
    }
    const shot = await this.shoot(identity, { screen: frame!.screen, maxEdge: Math.max(frame!.width, frame!.height), cause: 'after_input' }, guards, sent);
    if (!shot.ok) {
      result.after_note = `${sent} — 그 뒤 ${afterReason(shot.code)}로 캡처하지 않았습니다`;
      return { data: result };
    }
    this.records.insert({ ...this.rowBase(identity, 'capture', null), at: shot.result.taken_at, result: 'ok', capture: shot.record, focus: shot.focus, beforeCaptureId: frame!.id });
    this.records.finish(row, { result: 'ok', afterCaptureId: shot.record.id });
    result.after = shot.result;
    return { data: result, ...(shot.image ? { images: [shot.image] } : {}) };
  }

  /**
   * gui_input release — 눌린 키·버튼을 모두 뗀다 (슬롯 밖, 도우미는 남는다). 캡처·사람 우선·횟수와 상관없이 받는다.
   * 떠 있는 도우미가 없으면: 놓았다는 답을 받지 못한 표시(kv desktop:armed — 앞 도우미가 무장한 채 끝났다)가 남았으면 무장 앞의 놓기와 같은 길로 새 도우미를 한 번
   * 띄워 놓고 뗀 수를 알린다. 놓지 못하면 그 거부 글(UNRELEASED_REFUSAL)이다. 표시도 없으면 화면 도우미가 누른 키가 없다는 사실만 (S6F2a, 리드 결정 S6-23 M1)
   */
  private async releaseInput(identity: TokenIdentity, guards: ScreenGuards, fields: RowFields, requestId: string | null): Promise<ScreenToolOutput> {
    const client = this.client()!;
    const row = this.records.insert({ ...fields, result: 'sent', dispatched: true });
    const done = (message: string): ScreenToolOutput => {
      this.records.finish(row, { result: 'ok', detail: message });
      const result: GuiInputResult = { request_id: requestId ?? '', action: 'release', real: null, focus: null, after: null, after_note: null, message };
      return { data: result };
    };
    if (client.state() !== 'ready') {
      if (!this.safety.armedMark()) return done(NO_HELPER_RELEASE_TEXT);
      const over = await this.lifecycle.releaseOverMark('release');
      if (!over.ok) {
        const why = this.halted(identity, guards, 'input') ?? this.unreleased(identity, over.reason);
        this.records.finish(row, { result: why.code as GuiActionRow['result'], detail: why.message });
        throw new BackendError(why.code, why.message);
      }
      // 그사이 다른 호출이 그 표시를 먼저 지웠다 (released null) — 떠 있는 도우미가 누른 키도 없다
      if (over.released === null) return done(NO_HELPER_RELEASE_TEXT);
      return done(`새 화면 도우미를 띄워 눌린 키·버튼 ${over.released}개를 뗐습니다 (앞선 화면 조작이 놓았다는 답을 받지 못하고 끝났었습니다)`);
    }
    // 실제로 뗀 키의 올림은 앱의 입력이다 — 다음 무장의 시작 값을 사람 입력으로 읽지 않는다 (S6F1a, 리드 결정 S6-21 F3)
    const r = await this.lifecycle.releaseKeys(client);
    if (!r.acked && r.hadProcess) {
      this.records.finish(row, { result: 'error', detail: r.detail });
      // 놓기에 답하지 않는 도우미는 남겨 두지 않는다 — STOP을 쓰고 끝낸다(기다리지 않는다). 다음 호출이 새 도우미로 먼저 놓는다 (S6F1a, 리드 결정 S6-21 A3·A4)
      void this.lifecycle.stop('놓기(RELEASE)에 답하지 않음', { turnId: identity.turnId });
      throw new BackendError('error', `${r.detail} — 키·버튼을 뗐는지 확인하지 못했습니다. 다시 캡처해 확인하세요`);
    }
    // 놓으면 도우미가 표시·훅도 끈다 — 다음 캡처·입력이 다시 무장한다. 그 답 뒤에 온 ARM 답이 먼저 처리돼 다시 무장했으면 그쪽이 맞다 — 조작 중 표시와
    // 놓기 표시를 지우지 않는다 (줄 순서, S6-25 N1)
    if (r.acked && !client.armed()) this.safety.disarmed(true);
    return done(r.hadProcess ? r.detail : NO_HELPER_RELEASE_TEXT);
  }

  /** 1단계: 동작에 맞는 인자인지 — 틀리면 거부 글 */
  private inputShape(action: string, a: Args, text: string | null, keys: string | null, captureId: string | null): InputShape | string {
    if (!GUI_ACTIONS.has(action as GuiActionRow['action']) || action === 'capture' || action === 'stop') return 'action은 move·click·double_click·drag·scroll·key·type·release 가운데 하나입니다';
    if (action !== 'release' && (!captureId || !CAPTURE_ID_RE.test(captureId))) return 'release 밖의 동작에는 capture_id(30초 안에 찍은 캡처)가 꼭 있어야 합니다';
    const int = (k: string): number | null => (typeof a[k] === 'number' && Number.isInteger(a[k]) && (a[k] as number) >= 0 ? (a[k] as number) : null);
    const has = (k: string): boolean => a[k] !== undefined;
    const point = (kx: string, ky: string): [number, number] | string => {
      const x = int(kx);
      const y = int(ky);
      return x === null || y === null ? `${action}에는 ${kx}·${ky}(캡처 이미지의 픽셀, 0 이상의 정수)가 있어야 합니다` : [x, y];
    };
    const shape = (points: [number, number][]): InputShape => ({
      points,
      button: (['left', 'right', 'middle'] as const).find((b) => b === a.button) ?? 'left',
      count: typeof a.count === 'number' ? a.count : 1,
      amount: typeof a.amount === 'number' ? a.amount : 0,
      keys: keys ?? '',
      text: text ?? '',
    });
    const only = (allowed: string[]): string | null => {
      const extra = ['x', 'y', 'x2', 'y2', 'button', 'count', 'keys', 'text', 'amount'].filter((k) => has(k) && !allowed.includes(k));
      return extra.length ? `${action}에는 ${extra.join('·')}을(를) 주지 않습니다` : null;
    };
    switch (action) {
      case 'move':
      case 'click':
      case 'double_click':
      case 'scroll': {
        const allowed = action === 'scroll' ? ['x', 'y', 'amount'] : action === 'move' ? ['x', 'y'] : ['x', 'y', 'button', 'count'];
        const bad = only(allowed);
        if (bad) return bad;
        const p = point('x', 'y');
        if (typeof p === 'string') return p;
        if (action === 'scroll' && (typeof a.amount !== 'number' || a.amount === 0)) return 'scroll에는 amount(-20~20, 0 아님 — 양수가 아래로)가 있어야 합니다';
        if (action === 'double_click' && has('count') && a.count !== 2) return 'double_click은 두 번 누릅니다 — count를 주지 마세요';
        return shape([p]);
      }
      case 'drag': {
        const bad = only(['x', 'y', 'x2', 'y2']);
        if (bad) return bad;
        const p1 = point('x', 'y');
        if (typeof p1 === 'string') return p1;
        const p2 = point('x2', 'y2');
        if (typeof p2 === 'string') return p2;
        return shape([p1, p2]);
      }
      case 'key': {
        const bad = only(['keys']);
        if (bad) return bad;
        if (!keys || !/^[\x21-\x7e]{1,60}$/.test(keys)) return 'key에는 keys("ctrl+s"·"enter"·"a" 같은 키 조합 — 공백 없는 ASCII)가 있어야 합니다';
        return shape([]);
      }
      case 'type': {
        const bad = only(['text']);
        if (bad) return bad;
        if (!text) return 'type에는 text(칠 글)가 있어야 합니다';
        const n = codePoints(text);
        if (n > GUI_TYPE_MAX) return `type은 한 번에 ${GUI_TYPE_MAX.toLocaleString('ko-KR')}자까지입니다 (지금 ${n.toLocaleString('ko-KR')}자) — 나눠서 치세요`;
        return shape([]);
      }
      case 'release': {
        const bad = only([]);
        if (bad) return bad;
        return shape([]);
      }
    }
    return 'action이 올바르지 않습니다';
  }

  // ───────────────────────── 화면 보기 확인 (S6-10) ─────────────────────────

  /** 지금 자리의 확인 키 (세대·모델) — 앉은 보유자가 없으면 null */
  private currentCheck(): { key: string; generation: number; modelKey: string } | null {
    const s = this.seatRow();
    if (!s || s.state !== 'active' || !s.holder) return null;
    const modelKey = visionModelKey(s.holder);
    return { key: `g${s.generation}:${modelKey}`, generation: s.generation, modelKey };
  }

  /**
   * 새 보유자·모델의 화면 확인 업무를 넣는다 (자리가 앉을 때·교체가 끝날 때·모델이 바뀔 때·시작 때 — 리드 결정 S6-10). 화면 도구를 내놓을 때만, 자리가 앉아 있고
   * vision이 unknown일 때만. 같은 확인은 한 번만 (요청 ID 'screen-check:g<N>:<modelKey>' — 대기·실행 중인 것이 있으면 그대로)
   */
  queueCheck(why: string): QueueEntry | null {
    const ctx = this.ctx;
    // 쓰지 않는 실행(데스크톱 앱·Windows 밖·운영자가 끔)과 도우미가 없는 실행에는 넣지 않는다 (리드 결정 S6-11)
    if (!this.offered()) return null;
    const s = this.seatRow();
    const cur = this.currentCheck();
    if (!s || !cur || s.vision !== 'unknown' || s.holder?.kind !== 'launched') return null;
    const live = ctx.store.queue
      .list({ ref2: MAIN_GENERAL_KEY, state: ['queued', 'running'] })
      .find((q) => q.kind === 'screen_check' && CHECK_MARK_RE.exec(q.message)?.[0] === checkMark(cur.generation, cur.modelKey));
    if (live) return live;
    // 앞서 같은 확인을 넣었다가 끝 없이 지운 적이 있으면(쓸 수 없던 때 등) 새 요청 ID로 넣는다 — 같은 ID면 enqueue가 지운 항목을 돌려준다
    const base = `screen-check:g${cur.generation}:${cur.modelKey}`;
    const earlier = ctx.store.queue.list({ ref2: MAIN_GENERAL_KEY }).filter((q) => q.requestId === base || q.requestId?.startsWith(`${base}:`)).length;
    const holderText = s.holder.kind === 'launched' ? `${s.holder.ai.kind === 'codex' ? 'Codex' : 'Claude'} CLI${s.holder.ai.model ? ` (${s.holder.ai.model})` : ''}` : '보유자';
    return enqueue(ctx, {
      kind: 'screen_check',
      memberId: MAIN_AGENT_ID,
      sessionKey: MAIN_GENERAL_KEY,
      priority: 'normal',
      requestId: earlier ? `${base}:${earlier + 1}` : base,
      message: [
        `지금 메인 보유자(${holderText}, 세대 ${cur.generation})가 화면 이미지를 볼 수 있는지 확인합니다 — ${why}.`,
        'get_screen_check로 시험 이미지를 받아, 보이는 네 자리 숫자를 answer_screen_check(code, request_id)로 답하세요. 한 번만 답할 수 있습니다.',
        '이미지를 볼 수 없으면 짐작하지 말고 답하지 않은 채 턴을 마치세요 — 그러면 볼 수 없다고 기록되고 screen_capture는 이미지 대신 글 정보를 줍니다.',
        checkMark(cur.generation, cur.modelKey),
      ].join('\n'),
    });
  }

  /** 시작 때: 화면 도구를 내놓는데 지금 보유자의 vision이 unknown이면 확인 업무를 넣는다 (같은 확인이 있으면 그대로) */
  startupSweep(): void {
    try {
      this.queueCheck('서버 시작 때 아직 확인하지 않은 보유자');
    } catch (e) {
      this.ctx.log('warn', '화면 확인 업무를 넣지 못했습니다', e);
    }
    this.sweep();
  }

  async getCheck(identity: TokenIdentity, member: Member): Promise<ScreenToolOutput> {
    if (!member.isMain) throw new BackendError('forbidden', '메인 에이전트만 쓸 수 있는 도구입니다');
    if (!this.offered()) throw new BackendError('unavailable', this.rails.unavailable()?.text ?? SCREEN_NO_HELPER_TEXT);
    const s = this.seatRow();
    const cur = this.currentCheck();
    if (!s || !cur || (identity.seatGeneration !== undefined && identity.seatGeneration !== cur.generation)) {
      throw new BackendError('conflict', '확인할 화면 확인 업무가 없습니다 — 메인 자리가 앉아 있지 않거나 세대가 바뀌었습니다');
    }
    // 이 턴을 띄운 뒤 모델이 바뀌었으면 시험 이미지를 주지 않는다 — 옛 모델의 턴이 새 모델의 확인을 받아 답하면 새 모델이 본 적 없는 이미지로 verified가 된다
    // (리드 결정 S6-21 G). 새 모델의 확인을 만들지도, 다른 확인을 지우지도 않는다
    if (identity.modelKey !== undefined && identity.modelKey !== cur.modelKey) throw new BackendError('conflict', CHECK_OTHER_MODEL_REFUSAL);
    if (s.vision !== 'unknown') throw new BackendError('conflict', `이 보유자는 이미 화면 보기를 확인했습니다 (${s.vision === 'verified' ? '본다' : '볼 수 없음'}) — 다시 확인하지 않습니다`);
    let check = this.checks.get(cur.key);
    if (!check) {
      this.forgetOtherChecks(cur.key);
      // 시험 이미지를 줄 때 만든다 — 그래서 이 표에 있는 확인은 모두 받은 것이다 (받지 않은 확인에 답하면 '없음'으로 conflict)
      check = { key: cur.key, generation: cur.generation, modelKey: cur.modelKey, code: newScreenCheckCode(), png: null, file: null, answered: false };
      this.checks.set(cur.key, check);
    }
    if (check.answered) throw new BackendError('conflict', '이 확인에는 이미 답했습니다 (한 확인에 한 번)');
    check.png ??= screenCheckImage(check.code);
    // 파일 이름에 숫자를 넣지 않는다 — 무작위 8자리
    check.file ??= this.store.writeCheck(`check-${randomBytes(4).toString('hex')}.png`, check.png);
    const data: ScreenCheckImage = { file: check.file, image: 'attached', instruction: `${VISION_INSTRUCTION} 이미지가 결과에 보이지 않으면 ${this.fallbackHint()}.` };
    return { data, images: [{ mimeType: 'image/png', data: check.png.toString('base64') }] };
  }

  async answerCheck(identity: TokenIdentity, member: Member, a: Args): Promise<ScreenToolOutput> {
    if (!member.isMain) throw new BackendError('forbidden', '메인 에이전트만 쓸 수 있는 도구입니다');
    if (!this.offered()) throw new BackendError('unavailable', this.rails.unavailable()?.text ?? SCREEN_NO_HELPER_TEXT);
    const cur = this.currentCheck();
    // 다른 모델로 띄운 턴의 답은 받지 않는다 — 그 확인(지금 모델의 것)은 답하지 않은 채 남아, 지금 모델로 띄운 턴이 답한다 (리드 결정 S6-21 G)
    if (cur && identity.modelKey !== undefined && identity.modelKey !== cur.modelKey) throw new BackendError('conflict', CHECK_OTHER_MODEL_REFUSAL);
    const check = cur ? this.checks.get(cur.key) : undefined;
    const generation = identity.seatGeneration ?? cur?.generation;
    if (!cur || !check || generation !== check.generation) throw new BackendError('conflict', '받은 시험 이미지가 없습니다 — get_screen_check로 시험 이미지를 먼저 받으세요');
    if (check.answered) throw new BackendError('conflict', '이 확인에는 이미 답했습니다 (한 확인에 한 번)');
    const given = typeof a.code === 'string' ? a.code : '';
    const ok = normalizeCode(given) === check.code;
    check.answered = true;
    const outcome = this.settleVision(check, ok ? 'verified' : 'failed', ok ? '시험 이미지의 숫자를 맞힘' : '시험 이미지의 숫자를 틀림', identity.modelKey);
    if (outcome) throw new BackendError(outcome.code, outcome.message);
    const data: ScreenCheckAnswer = ok
      ? { result: 'verified', message: '맞혔습니다 — 이 보유자는 화면 이미지를 본다고 기록했습니다. screen_capture는 이미지를 붙여 줍니다.' }
      : { result: 'failed', message: `틀렸습니다 — 이 보유자는 화면 이미지를 볼 수 없다고 기록했습니다. screen_capture는 이미지 대신 글 정보(창 목록·포커스)를 줍니다.` };
    return { data };
  }

  /**
   * vision을 정한다 (한 트랜잭션: 자리 — 세대가 그대로이고 아직 unknown일 때만, 대기 중인 같은 확인 업무, 활동 기록, 일지). 거부면 그 코드와 글.
   * 시험 이미지 파일은 지운다. answeredBy: 답한 턴의 모델 키(토큰 신원) — 그 확인의 모델과 다르면 받지 않는다 (리드 결정 S6-21 G). 답 없이 끝난 확인을
   * failed로 정하는 길(failOpenCheck)은 주지 않는다 — 그 길은 확인 업무의 표시와 지금 자리의 모델이 같은지를 deadScreenCheck로 먼저 본다
   */
  private settleVision(check: VisionCheck, vision: 'verified' | 'failed', why: string, answeredBy?: string): { code: string; message: string } | null {
    const ctx = this.ctx;
    if (answeredBy !== undefined && answeredBy !== check.modelKey) return { code: 'conflict', message: CHECK_OTHER_MODEL_REFUSAL };
    this.store.removeCheck(check.file ?? '');
    const r = ctx.store.tx((): { code: string; message: string } | null => {
      const s = ctx.store.seat.get('main');
      if (!s || s.generation !== check.generation) return { code: 'seat_changed', message: `메인 자리 세대가 바뀌었습니다 (확인 세대 ${check.generation}) — 이 답은 기록하지 않았습니다` };
      if (s.vision !== 'unknown') return { code: 'conflict', message: `이 보유자는 이미 화면 보기를 확인했습니다 (${s.vision})` };
      if (visionModelKey(s.holder) !== check.modelKey) return { code: 'seat_changed', message: '메인 보유자의 모델이 바뀌었습니다 — 이 답은 기록하지 않았습니다' };
      const now = ctx.now();
      ctx.store.seat.put({ ...s, vision, visionModel: check.modelKey, visionAt: now });
      const mark = checkMark(check.generation, check.modelKey);
      for (const q of ctx.store.queue.list({ ref2: MAIN_GENERAL_KEY, state: 'queued' })) {
        if (q.kind === 'screen_check' && CHECK_MARK_RE.exec(q.message)?.[0] === mark) ctx.store.queue.put({ ...q, state: 'done', doneAt: now });
      }
      const holder = this.core.journal.holderOf(check.generation);
      const text = `화면 보기 확인: ${holder}(세대 ${check.generation}) — ${vision === 'verified' ? '본다(verified)' : '볼 수 없음(failed) — screen_capture는 글 정보만 줌'} (${why})`;
      ctx.activity({ kind: 'seat', level: vision === 'verified' ? 'info' : 'warn', actor: 'system', memberId: MAIN_AGENT_ID, text });
      this.core.journal.server('seat', text, { generation: check.generation });
      return null;
    });
    if (!r) {
      this.checks.delete(check.key);
      ctx.bus.changed();
    }
    return r;
  }

  /**
   * 메인 턴이 정상으로 끝났다 (turns.judgeMain) — 실은 화면 확인 업무가 아직 답 없이 열려 있으면 failed (리드 결정 S6-10 '답하지 않으면 failed')
   */
  afterMainTurn(entries: readonly (QueueEntry | null | undefined)[]): void {
    for (const q of entries) {
      if (q?.kind !== 'screen_check') continue;
      this.failOpenCheck(q, '답하지 않고 턴을 마침');
    }
  }

  /** 비정상 종료 상한·재시작 상한·헛돌기로 버린 화면 확인 업무 → failed */
  checkDropped(entries: readonly QueueEntry[], why: string): void {
    for (const q of entries) if (q.kind === 'screen_check') this.failOpenCheck(q, why);
  }

  private failOpenCheck(q: QueueEntry, why: string): void {
    if (deadScreenCheck(this.ctx, q)) return;
    const mark = CHECK_MARK_RE.exec(q.message);
    if (!mark) return;
    const key = `g${mark[1]}:${mark[2]}`;
    const check: VisionCheck = this.checks.get(key) ?? { key, generation: Number(mark[1]), modelKey: mark[2]!, code: '', png: null, file: null, answered: false };
    if (check.answered) return;
    check.answered = true;
    const r = this.settleVision(check, 'failed', why);
    if (r) this.ctx.log('info', `화면 확인을 failed로 정하지 않음: ${r.message}`);
  }

  /** 다른 세대·모델의 확인은 버린다 (파일도) */
  private forgetOtherChecks(keep: string): void {
    for (const [k, c] of this.checks) {
      if (k === keep) continue;
      this.store.removeCheck(c.file ?? '');
      this.checks.delete(k);
    }
  }

  // ───────────────────────── 턴 끝 · 정리 · 종료 ─────────────────────────

  /**
   * 메인 턴이 끝날 때 (turns.ts finish — hostExec.settleTurn 뒤): 도우미가 무장해 있으면 놓고(RELEASE — 답이 없으면 STOP하고 끝낸다), 그 턴의 화면 조작을
   * 활동 기록 한 줄·일지 한 줄로 남긴다 (lifecycle.ts, 리드 결정 S6-9). 메인 턴은 한 번에 하나라 이 턴이 화면을 썼는지는 묻지 않는다 — 무장한 채 남은 도우미는 놓는다
   */
  async settleTurn(turnId: string, o: { memberId: string; sessionId: string | null; projectId: string | null; workKey: string; generation: number }): Promise<void> {
    for (const [k, c] of this.checks) if (c.answered) this.checks.delete(k);
    // 끝난 턴을 적어 둔다 — 그 턴의 호출이 기다리던 ARM의 답이 이 뒤에 오면 그 호출이 놓는다 (S6F1a, 리드 결정 S6-21 F1). 최근 것만 둔다
    this.endedTurns.add(turnId);
    if (this.endedTurns.size > 64) this.endedTurns.delete(this.endedTurns.values().next().value as string);
    await this.lifecycle.settleTurn(turnId, o);
  }

  /** 긴급 정지·앱 종료: STOP을 먼저 쓰고 끝내고 끝남을 확인한다 (2.8초 안, lifecycle.ts). 도는 정지가 있으면 그 결과를 준다 */
  stopAll(reason: Extract<ScreenStopReason, '긴급 정지' | '앱 종료'>): Promise<ScreenStopOutcome> {
    return this.lifecycle.stop(reason);
  }

  /**
   * 자리 교체의 STOP (seat.ts 1번·4번). 멈출 화면 도우미 프로세스가 없으면 null(기다릴 것이 없다), 있으면 그 결과의 약속 — 1번의 결과는 교체가 본다 (S6F1a,
   * 리드 결정 S6-21 A2b)
   */
  stopForSwap(): Promise<ScreenStopOutcome> | null {
    return this.lifecycle.stopForSwap();
  }

  /** 도는 화면 도우미 정지 (없으면 null) — 교체가 새 보유자를 앉히기 전에 기다린다 (S6F1a) */
  pendingStop(): Promise<unknown> | null {
    return this.lifecycle.pendingStop();
  }

  /** 끝남을 확인하지 못한 화면 도우미가 있으면 그 사실 글 (없으면 null) — 교체가 새 보유자를 앉히기 전에 본다 (S6F1a, 리드 결정 S6-21 A2b) */
  unconfirmedHelper(): string | null {
    return this.lifecycle.swapHold();
  }

  /**
   * 대표의 정지 해제 (StopService.release): 끝남을 확인하지 못한 화면 도우미를 한 번 더 끝내 확인한다 — 확인되면 화면 도구를 다시 쓴다. 기다리지 않아도 된다
   * (S6F1a, 리드 결정 S6-21 A2)
   */
  ownerReleased(): Promise<boolean> {
    return this.lifecycle.ownerReleased();
  }

  /** 다시 시작했을 때 (재시작 복구 뒤): 끊긴 입력 줄·빠진 턴 한 줄·놓지 못한 키 (lifecycle.ts) */
  reconcile(): void {
    this.lifecycle.reconcile();
  }

  // ───────────────────────── 대표의 보기 (리드 결정 S6-2·S6-11) ─────────────────────────

  /** 대표가 보는 화면 조작 상태 (SeatView.screen) — 바뀌는 때에만 바뀐다 */
  screenView(): SeatScreenView {
    return this.safety.view();
  }

  /** 사전 점검의 화면 칸 (system.prereqs·운영자 status) — 마지막으로 안 상태. 아무것도 띄우지 않는다 */
  prereq(): PrereqStatus['screen'] {
    return this.safety.prereq();
  }

  /**
   * 최근 캡처와 동작 기록 (screens.recent) — 보기만. 캡처는 최근 100장(kept: 파일이 있고 기록의 해시와 맞다), 동작은 새 것부터 limit개(기본 100, 500까지)이고
   * before(동작 ID)보다 앞선 것. 더 있으면 nextCursor가 마지막 줄의 ID다. 이미지 바이트는 없다
   */
  recent(filter: ScreenFilter = {}): ScreenRecentView {
    const limit = Math.min(Math.max(Number.isInteger(filter.limit) ? (filter.limit as number) : 100, 1), 500);
    let beforeSeq: number | undefined;
    if (filter.before !== undefined) {
      const m = /^GA-(\d{1,15})$/.exec(filter.before);
      if (!m) throw new BackendError('invalid', 'before에는 동작 기록 ID(GA-…)를 주세요');
      beforeSeq = Number(m[1]);
    }
    const rows = this.records.repo.query({ ...(beforeSeq !== undefined ? { beforeSeq } : {}), limit: limit + 1 });
    const page = rows.slice(0, limit);
    const captures = this.records.repo
      .query({ actions: ['capture'], results: ['ok'], limit: 100 })
      .flatMap((r) => {
        const v = r.capture ? this.records.captureView(r, this.store.keptQuick(r.capture.id, r.capture.sha256)) : null;
        return v ? [v] : [];
      });
    return { captures, actions: page.map((r) => this.records.view(r)), nextCursor: rows.length > limit && page.length ? page[page.length - 1]!.id : null };
  }

  /** 보관 중이고 기록의 해시와 맞는 캡처의 바이트 — 아니면(모르는 ID·지워짐·바뀜) null */
  private keptCapture(captureId: string): { row: GuiActionRow; capture: GuiCaptureRecord; bytes: Buffer } | null {
    if (typeof captureId !== 'string' || !CAPTURE_ID_RE.test(captureId)) return null;
    const row = this.records.repo.byCapture(captureId);
    if (!row?.capture || row.result !== 'ok') return null;
    const bytes = this.store.readKept(captureId, row.capture.sha256);
    return bytes ? { row, capture: row.capture, bytes } : null;
  }

  /** 캡처 이미지 (screens.image) — 보관 중이고 해시가 맞을 때만. 아니면 null */
  image(captureId: string): ScreenImageView | null {
    const k = this.keptCapture(captureId);
    return k ? { id: k.capture.id, mime: 'image/png', dataUrl: `data:image/png;base64,${k.bytes.toString('base64')}`, width: k.capture.width, height: k.capture.height } : null;
  }

  /** 내려받을 캡처 파일 (서버의 /api/screens/:id) — 보관 중이고 해시가 맞을 때만. HTTP 층이 실제 경로가 캡처 폴더 안인지 다시 본다 */
  downloadTarget(captureId: string): DownloadFile | null {
    const k = this.keptCapture(captureId);
    return k ? { path: this.store.capturePath(k.capture.id), root: this.store.dir(), name: `${k.capture.id}.png` } : null;
  }

  /** 캡처 정리 (시작 때·한 시간마다 — 쓸 때마다는 shoot이 한다) */
  sweep(): number {
    try {
      return this.store.sweep();
    } catch (e) {
      this.ctx.log('warn', '화면 캡처 정리 실패', e);
      return 0;
    }
  }

  /** 앱 종료 — 도우미를 끝낸다 (STOP 먼저 — 떠 있으면 기록에 남긴다). 그 뒤로는 띄우지 않는다. 시험 이미지 파일을 지운다 */
  async dispose(): Promise<void> {
    for (const c of this.checks.values()) this.store.removeCheck(c.file ?? '');
    this.checks.clear();
    const h = this.helper;
    try {
      await this.lifecycle.stop('앱 종료');
      await h?.dispose();
    } catch (e) {
      this.ctx.log('warn', '화면 도우미를 끝내지 못했습니다', e);
    }
    this.offHelper?.();
    this.safety.dispose();
  }
}

// ───────────────────────── 도움 ─────────────────────────

const GUI_ACTIONS: ReadonlySet<GuiActionRow['action']> = new Set<GuiActionRow['action']>(['move', 'click', 'double_click', 'drag', 'scroll', 'key', 'type', 'release']);

const GUI_ACTION_DONE: Record<string, string> = {
  move: '포인터를 옮겼습니다',
  click: '클릭했습니다',
  double_click: '두 번 클릭했습니다',
  drag: '끌었습니다',
  scroll: '스크롤했습니다',
  key: '키를 보냈습니다',
  type: '글을 쳤습니다',
  release: '눌린 키·버튼을 뗐습니다',
};

type RowFields = Omit<GuiRecordInput, 'result'>;

interface InputShape {
  /** 캡처 이미지 좌표 (move·click·scroll은 하나, drag는 둘) */
  points: [number, number][];
  button: MouseButton;
  count: number;
  amount: number;
  keys: string;
  text: string;
}

function checkMark(generation: number, modelKey: string): string {
  return `(화면 확인 g${generation}:${modelKey})`;
}

/** 답의 숫자 — NFKC로 맞추고 빈칸·하이픈을 뺀다 */
export function normalizeCode(s: string): string {
  return s.normalize('NFKC').replace(/[\s\-‐-―−]/g, '');
}

function frameOf(c: HelperCapture): CaptureFrame {
  return { width: c.width, height: c.height, originX: c.originX, originY: c.originY, realWidth: c.realWidth, realHeight: c.realHeight };
}

/** 동작 → 도우미 입력 명령 (좌표는 실제 픽셀) */
function helperInputOf(action: string, s: InputShape, real: { x: number; y: number }[], layout: string): HelperInput {
  const p = real[0] ?? { x: 0, y: 0 };
  switch (action) {
    case 'move':
      return { verb: 'MOVE', x: p.x, y: p.y, layout };
    case 'click':
      return { verb: 'CLICK', x: p.x, y: p.y, button: s.button, count: s.count, layout };
    case 'double_click':
      return { verb: 'CLICK', x: p.x, y: p.y, button: s.button, count: 2, layout };
    case 'drag':
      return { verb: 'DRAG', x1: p.x, y1: p.y, x2: real[1]!.x, y2: real[1]!.y, layout };
    case 'scroll':
      return { verb: 'SCROLL', x: p.x, y: p.y, amount: s.amount, layout };
    case 'key':
      return { verb: 'KEY', combo: s.keys, layout };
    default:
      return { verb: 'TYPE', text: s.text, layout };
  }
}

/** 중복 요청의 답 — 이미지 없이 그때의 결과 요약 (리드 결정 S6-6) */
function duplicateOf(prev: GuiActionRow, requestId: string): GuiInputResult & { duplicateRequest: true } {
  const real = prev.x !== null && prev.y !== null ? { x: prev.x, y: prev.y, ...(prev.x2 !== null && prev.y2 !== null ? { x2: prev.x2, y2: prev.y2 } : {}) } : null;
  return {
    request_id: requestId,
    action: prev.action,
    real,
    focus: prev.focus ? { app: prev.focus.app, title: prev.focus.title, control: null, password: prev.focus.password } : null,
    after: null,
    after_note: prev.afterCaptureId ? `이미 처리한 요청입니다 — 그때 찍은 캡처는 ${prev.afterCaptureId}입니다 (이미지는 다시 붙이지 않습니다)` : null,
    message: `이 request_id의 입력은 이미 보냈습니다 (${prev.id}, ${prev.result}) — 다시 보내지 않았습니다. 화면을 확인하려면 screen_capture로 다시 찍으세요`,
    duplicateRequest: true,
  };
}

function afterReason(code: string): string {
  switch (code) {
    case 'human_active':
      return '서버 PC 앞 사람의 입력·멈춤 단축키';
    case 'rate_limited':
      return '캡처 횟수 상한';
    case 'stopped':
      return '정지·턴 끝';
    case 'seat_changed':
      return '메인 자리 교체';
    case 'conflict':
      return '메인 자리 교체 중';
    case 'unavailable':
      return '화면을 쓸 수 없음(잠김 등)';
    default:
      return '캡처 오류';
  }
}

function codeMessage(f: { code: string; message: string }): [string, string] {
  return [f.code, f.message];
}

/** 도우미 실패 → 도구 거부 코드와 글 (리드 결정 S6-5·S6-8) */
export function failureOf(f: HelperFailure, input: boolean): { code: string; message: string } {
  if (f.kind === 'unavailable') return { code: 'unavailable', message: f.text };
  if (f.kind === 'timeout') return { code: 'error', message: f.input || input ? INPUT_UNCONFIRMED_TEXT : f.text };
  if (f.kind === 'gone') return { code: /멈췄습니다/.test(f.text) ? 'stopped' : 'error', message: `${f.text}${input ? ` — ${INPUT_UNCONFIRMED_TEXT}` : ''}` };
  const sent = f.sent !== null && f.sent > 0 ? ` (멈추기 전에 ${f.sent}${input ? '만큼 보냄' : ''})` : '';
  switch (f.reason) {
    case 'LOCKED':
      return {
        code: 'unavailable',
        message:
          f.lock === 'disconnected'
            ? '서버 PC의 원격 세션이 끊겨 화면이 없습니다 — 서버 PC 운영자가 다시 로그온하거나(클라우드 PC는 끊기 전에 tscon으로 세션을 콘솔에 돌려 둠) 해야 합니다. ask_owner로 대표에게 알리세요'
            : f.lock === 'secure_desktop'
              ? '서버 PC에 보안 화면(UAC 확인·Ctrl+Alt+Del 화면 등)이 떠 있어 화면 조작을 할 수 없습니다 — 사람이 처리해야 합니다. ask_owner로 대표에게 알리세요'
              : '서버 PC 화면이 잠겨 있어 화면 조작을 할 수 없습니다 — 사람이 잠금을 풀어야 합니다(서버 PC 운영자에게 잠금 해제·다시 로그온을 부탁). ask_owner로 대표에게 알리세요',
      };
    case 'NO_DESKTOP':
      return { code: 'unavailable', message: NO_DESKTOP_TEXT };
    case 'HUMAN_ACTIVE':
      return {
        code: 'human_active',
        message:
          f.detail === 'hotkey'
            ? `서버 PC 앞 사람이 멈춤 단축키(Ctrl+Alt+Shift+F12)를 눌러 화면 조작을 멈췄습니다${sent} — 그 사람이 쓰는 동안 기다리세요`
            : `서버 PC 앞에서 사람이 입력해 멈췄습니다${sent} — 30초 뒤 다시 캡처해 확인하세요`,
      };
    case 'PASSWORD_FIELD':
      return { code: 'secret_blocked', message: '포커스가 암호 칸이라 글자를 치지 않았습니다 — 비밀번호는 화면 조작으로 입력하지 않습니다. 로그인이 필요하면 ask_owner로 대표에게 알리세요' };
    case 'FOCUS_UNKNOWN':
      return { code: 'secret_blocked', message: `포커스가 어떤 칸인지(암호 칸인지) 확인하지 못해 글자를 치지 않았습니다${sent} — 칸을 클릭한 뒤 다시 캡처해 확인하세요` };
    case 'BLOCKED_TARGET':
      return {
        code: 'denied_target',
        message:
          f.detail === 'key'
            ? '그 키 조합은 보낼 수 없습니다 (화면 잠금·로그아웃·멈춤 단축키·붙여넣기 등)'
            : f.detail === 'shell'
              ? '바탕 화면·작업 표시줄에는 Alt+F4를 보낼 수 없습니다 (Windows 종료 창이 뜹니다)'
              : '그 창(욱채 서버·화면 도우미·욱채 화면 등 막힌 창)에는 입력할 수 없습니다',
      };
    case 'ELEVATED_TARGET':
      return { code: 'denied_target', message: '관리자 권한으로 도는 창에는 입력할 수 없습니다 — 사람이 처리해야 하면 ask_owner로 대표에게 알리세요' };
    case 'LAYOUT_CHANGED':
      return { code: 'stale_capture', message: '캡처한 뒤 모니터 배치가 바뀌었습니다 — screen_capture로 다시 찍으세요' };
    case 'STOPPED':
      return { code: 'stopped', message: `화면 도우미를 멈췄습니다 (긴급 정지·자리 교체·앱 종료)${sent} — 턴을 마치세요` };
    case 'RELEASED':
      return { code: 'stopped', message: `입력을 놓았습니다 (턴 끝·멈춤 단축키)${sent} — 다시 캡처한 뒤 하세요` };
    case 'BAD_ARGS':
      return { code: 'invalid', message: `화면 도우미가 인자를 받지 않았습니다${f.detail ? ` (${f.detail})` : ''} — 좌표가 화면 밖이거나 키 이름을 모릅니다` };
    case 'BAD_TEXT':
      // 처리기가 먼저 거르므로(S6-21 B1) 여기까지 오는 것은 처리기와 도우미의 규칙이 어긋났을 때뿐이다 — 같은 글로 답한다
      return { code: 'invalid', message: typeControlRefusal('화면 도우미가 거부함') };
    default:
      return { code: 'error', message: `화면 도우미 오류 (${f.reason}${f.detail ? `: ${f.detail}` : ''})${sent}${input ? ` — ${INPUT_UNCONFIRMED_TEXT}` : ''}` };
  }
}
