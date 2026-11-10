/**
 * 메인 에이전트 자리 (SERVER_DESIGN 4.1·4.3, 리드 결정 S4-1·S4-2·S4-3·S4-4·S4-9·S4-12).
 * - 자리는 이 서비스의 assign 한 곳에서만, 한 트랜잭션으로 바뀐다. 부르는 쪽은 셋뿐이다: 지금 메인 에이전트(hand_off_seat), 운영자(데스크톱 운영 설정의
 *   메인 AI — S4-9, 서버 관리 채널 seat assign — S4-8), 서버 초기화(자리가 비었을 때의 처음 보유자 — S4-12). 대표의 길은 없다: 대표 메서드는
 *   seat.get·seat.history·seat.handover로 보기만 한다
 * - 동시에 들어온 요청은 먼저 트랜잭션에 든 것이 이기고, 나머지는 까닭을 말하며 거부된다. 어느 순간에도 메인 턴은 하나 이하다 — 스케줄러는 자리가
 *   active일 때만 M-MAIN 일을 띄우고(runsMain), 교체는 나가는 턴의 종료를 확인한 뒤에만 새 보유자를 앉힌다
 * - 교체 순서 (4.3): ① 같은 트랜잭션에서 switching·세대 +1·이력 닫기/열기 ② 나가는 메인 턴의 마무리를 drainMs까지 기다리고 넘으면 멈춘다(운영자 강제는
 *   바로 멈춘다). 종료를 확인하지 못하면(CTL-11) 새 보유자를 앉히지 않고 switching으로 멈춰 알린다 — 대표의 '정지 해제'가 이어 가게 한다 ③ 나가는 보유자의
 *   인계 메모 턴 (S4b — handover.ts가 hooks.memoTurn으로 채운다) ④ 메인 토큰 폐기(revokeWhere) ⑤ M-MAIN 세션(main:*·메인 검수 review:*)을 한꺼번에 닫는다
 *   ⑥ 인계 꾸러미 (자리 칸 뒤는 handover.ts가 hooks.packetSections로 채운다) ⑦ active — 대기열의 M-MAIN 일은 그대로 새 보유자에게 간다
 *   ⑧ 활동 기록(seat)·메인 일지(seat)·대표 알림
 * - 같은 종류에서 모델·노력치만 바꾸면 세대를 올리지 않고 다음 턴부터 적용한다 (ARCHITECTURE 19.1의 메인 예외)
 * - 외부 보유자(external:<id>)는 저장 모양만 있고 7단계 전까지 앉히지 않는다 (S4-1)
 * - 응답 없음 (4.4, S4-5): 서버가 띄운 보유자의 메인 턴이 시작 실패·사용량 한도·재로그인 필요로 연달아 3번 끝나거나, 메인 일이 쌓였는데 그 AI 종류를 쓸
 *   수 없으면 그때부터 센다. 정상으로 끝난 메인 턴이 비운다. 5분·30분·2시간에 대표에게 다시 알리고, 긴급 정지한 시간은 세지 않는다. 서버는 자리를 바꾸지
 *   않는다 (대표 결정 '넘기지 않는다') — 출구는 대표의 명령(쌓였다가 돌아오면 처리)·긴급 정지, 운영자의 seat assign이다
 * - M-MAIN의 AI(member.ai)와 운영 설정의 메인 AI(general.mainAgent)는 자리 보유자를 따라 이 서비스가 함께 쓴다 — 다른 곳은 바꾸지 않는다
 */
import type { Actor, AiConfig, AiKind, SessionKind, TurnEndReason } from '@shared/domain';
import { AI_KINDS, MAIN_AGENT_ID, OPERATOR } from '@shared/domain';
import { TURN_END_LABEL } from '@shared/labels';
import type { HandoverSection, SeatHandoverView, SeatHistoryEntry, SeatHolderView, SeatView } from '@shared/views';
import { BackendError, type SeatOperatorStatus, type ServerConfigChange } from '../backend/types';
// 저장 모양은 타입만 가져온다 — 운영자 명령 줄(wook-server, config.ts → serverLogin.ts)도 이 파일을 읽는데 저장소(node:sqlite)를 띄우지 않게
import type { MainSeatRow, SeatChanger, SeatHandoverRow, SeatHolder, SeatSwapRow } from '../db/store';
import type { Core } from './core';
import { visionModelKey } from '../desktop/service';

/** 자리 이력·인계 꾸러미의 줄 ID (세대 1 → 'G-0001') */
export function seatGenerationId(generation: number): string {
  return `G-${String(generation).padStart(4, '0')}`;
}

/**
 * 턴을 누가 실행하나 (4.1 RunnerKind) — 서버가 띄우는 CLI(cli) 또는 스스로 도는 외부 에이전트(external, 7단계). 외부 턴의 AI 종류만 이 두 기록(턴·세션)에서
 * 'external'로 넓힌다. 계약(src/shared의 Turn·AgentSession)에 칸이 생길 때까지 저장 기록에 이 칸을 더해 둔다 — 지금은 늘 cli (리드 결정 S4-1)
 */
export type RunnerKind = AiKind | 'external';
export interface RunnerFields {
  runner: 'cli' | 'external';
  externalAgentId: string | null;
  /** 메인 턴·세션이면 띄울 때의 자리 세대 (S4-4) — 새 세대의 키별 첫 세션을 가린다 (6.2, S4b) */
  seatGeneration?: number;
}

/** 외부 보유자를 앉히려는 요청의 거부 글 (리드 결정 S4-1) */
export const SEAT_EXTERNAL_LATER = '외부 에이전트 접속은 7단계에서 붙습니다';

/** 운영자 seat assign의 보유자 모양이 틀렸을 때 (S4-8) — 적은 값은 되풀이하지 않는다 (S3-39) */
export const SEAT_HOLDER_SHAPE = '보유자는 launched:claude나 launched:codex 꼴로 적습니다 (외부 에이전트 external:<ID>는 7단계에서 붙습니다). 적은 값은 보이지 않습니다';

/** 응답 없음으로 세는 메인 턴의 끝 (4.4, 리드 결정 S4-5) — 시작 실패·사용량 한도·재로그인 필요 */
const UNRESPONSIVE_END: Readonly<Partial<Record<TurnEndReason, string>>> = { spawn_failed: '시작 실패', usage_limit: '사용량 한도', auth_required: '재로그인 필요' };
/** 응답 없음으로 세는 끝이 연달아 몇 번이면 응답 없음인지 */
const UNRESPONSIVE_STREAK = 3;
/** 대표에게 응답 없음을 다시 알리는 때 — 응답 없음이 시작된 뒤 5분·30분·2시간 (긴급 정지한 시간은 빼고 잰다, S4-5) */
export const SEAT_UNRESPONSIVE_NOTICE_MS: readonly number[] = [5 * 60_000, 30 * 60_000, 2 * 3_600_000];
/** 그 AI 종류를 쓸 수 없는 허용 검사 결과 (CTL-09) — 재로그인 필요·사용량 한도 대기(모델별 한도 포함)·CLI-15의 시작 정지(설치 안 됨·버전 문제) */
const AI_BLOCKS: ReadonlySet<string> = new Set(['auth', 'usage_limit', 'cli_problem']);

/** 자리 정책 (4.1 settings.seat) — 운영자 설정이다. 데스크톱은 kv, 서버는 server.json에서 (S4-12) */
export interface SeatPolicy {
  /** 앉을 수 있는 보유자: launched:claude·launched:codex·external:<id>·external:* (외부는 7단계 전까지 저장만) */
  holders: string[];
  /** 교체 때 나가는 메인 턴의 마무리를 기다리는 상한 (ms) */
  drainMs: number;
}

export const DEFAULT_SEAT_POLICY: SeatPolicy = { holders: ['launched:claude', 'launched:codex', 'external:*'], drainMs: 120_000 };
/** drainMs 상한 — 1시간 (0이면 기다리지 않고 바로 멈춘다) */
export const SEAT_DRAIN_MAX_MS = 3_600_000;
/** 멈춘 메인 턴의 마무리(종료 판정·기록)를 기다리는 상한 — 종료 확인(2.8초)과 판정을 넉넉히 덮는다 */
const STOP_SETTLE_MS = 15_000;
/** 교체가 마무리를 기다리는 나가는 M-MAIN 턴의 세션 종류 — 메인 대화(main:*)와 메인이 검수자인 검수(review:*) (리드 결정 S4-26) */
const OUTGOING_KINDS: ReadonlySet<SessionKind> = new Set<SessionKind>(['main_general', 'main_project', 'review']);
const POLICY_KEY = 'seat.policy';

/** 보유자 표기 'launched:claude' | 'launched:codex' | 'external:*' | 'external:<id>' */
const HOLDER_SPEC_RE = /^(?:launched:(claude|codex)|external:(\*|[A-Za-z0-9][A-Za-z0-9._-]{0,63}))$/;

export type HolderSpec = { kind: 'launched'; ai: AiKind } | { kind: 'external'; agentId: string } | { kind: 'any_external' };

/** 보유자 표기를 읽는다 (모양이 틀리면 null) */
export function parseHolderSpec(spec: string): HolderSpec | null {
  const m = HOLDER_SPEC_RE.exec(spec.trim());
  if (!m) return null;
  if (m[1]) return { kind: 'launched', ai: m[1] as AiKind };
  return m[2] === '*' ? { kind: 'any_external' } : { kind: 'external', agentId: m[2]! };
}

/** 보유자의 표기 (holders 목록과 견준다) */
export function holderSpecOf(h: SeatHolder): string {
  return h.kind === 'launched' ? `launched:${h.ai.kind}` : `external:${h.agentId}`;
}

const AI_LABEL: Readonly<Record<AiKind, string>> = { claude: 'Claude CLI', codex: 'Codex CLI' };

/** 사람이 읽는 보유자 이름 ('Claude CLI', 외부 에이전트는 등록한 이름) */
export function holderLabel(h: SeatHolder | null): string {
  if (!h) return '없음';
  return h.kind === 'launched' ? AI_LABEL[h.ai.kind] : h.label;
}

function holderView(h: SeatHolder | null): SeatHolderView | null {
  if (!h) return null;
  return h.kind === 'launched' ? { kind: 'launched', ai: { ...h.ai }, label: holderLabel(h) } : { kind: 'external', agentId: h.agentId, label: h.label };
}

/** 두 AI 설정이 같은지 (칸 순서와 상관없이) */
export const sameAiConfig = (a: AiConfig, b: AiConfig): boolean =>
  a.kind === b.kind && (a.model ?? null) === (b.model ?? null) && a.effortTier === b.effortTier && (a.effortOverride ?? null) === (b.effortOverride ?? null);
const sameAi = sameAiConfig;

const CHANGED_BY_TEXT: Readonly<Record<SeatChanger, string>> = { main: '메인 에이전트가 넘김', operator: '운영자가 바꿈', server: '서버가 처음 보유자로 앉힘' };
const CHANGED_BY_LABEL: Readonly<Record<SeatChanger, string>> = { main: '메인 에이전트', operator: '운영자', server: '서버' };
/** 대표 알림의 문장 */
const CHANGED_BY_SENTENCE: Readonly<Record<SeatChanger, string>> = { main: '메인 에이전트가 넘겼습니다', operator: '운영자가 바꿨습니다', server: '서버가 처음 보유자로 앉혔습니다' };

/** 받침이 있으면 '이', 없으면 '가' — 'Codex CLI가'(씨엘아이)처럼 영문 끝 글자도 읽는 소리로 본다 */
function subjectJosa(word: string): string {
  const last = word.trim().slice(-1);
  const c = last.charCodeAt(0) - 0xac00;
  if (c >= 0 && c <= 11171) return c % 28 !== 0 ? '이' : '가';
  return /[013678lmnrLMNR]/.test(last) ? '이' : '가';
}

/** 받침이 있으면 '을', 없으면 '를' — 'Claude CLI를' (subjectJosa와 같은 소리 판정) */
function objectJosa(word: string): string {
  return subjectJosa(word) === '이' ? '을' : '를';
}

/** 받침이 있으면(ㄹ 받침 빼고) '으로', 아니면 '로' — '사용량 한도로' */
function instrumentalJosa(word: string): string {
  const c = word.trim().slice(-1).charCodeAt(0) - 0xac00;
  return c >= 0 && c <= 11171 && c % 28 !== 0 && c % 28 !== 8 ? '으로' : '로';
}

/** 이어진 시간 ('5분', '2시간', '1시간 15분') — 1분이 안 되면 null */
export function seatDurationText(ms: number): string | null {
  const min = Math.floor(Math.max(0, ms) / 60_000);
  if (min < 1) return null;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? (m ? `${h}시간 ${m}분` : `${h}시간`) : `${m}분`;
}

const clip = (s: string, max: number): string => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

const VACANT: MainSeatRow = {
  id: 'main',
  generation: 0,
  state: 'vacant',
  holder: null,
  since: null,
  unresponsiveSince: null,
  unresponsiveReason: null,
  pendingHolder: null,
  vision: 'unknown',
  swap: null,
};

/** 응답 없음을 센 것이 없는 자리 칸들 (S4-5) — 보유자가 다시 답하거나 새 보유자가 앉을 때 */
/**
 * 화면 보기는 보유자·모델마다 새로 확인한다 (리드 결정 S6-10) — 새 세대(빈 자리에 앉음·교체 7번)와 같은 종류의 모델 바뀜에서 unknown으로 되돌린다.
 * 이어받지 않는다: 이전 보유자의 verified가 새 보유자에게 '본다'로 보이면 거짓이다 (CLI-21)
 */
const VISION_UNKNOWN: Pick<MainSeatRow, 'vision' | 'visionModel' | 'visionAt'> = { vision: 'unknown', visionModel: null, visionAt: null };

const NOT_UNRESPONSIVE: Pick<MainSeatRow, 'unresponsiveSince' | 'unresponsiveReason' | 'unresponsiveStreak' | 'unresponsiveNotices'> = {
  unresponsiveSince: null,
  unresponsiveReason: null,
  unresponsiveStreak: [],
  unresponsiveNotices: 0,
};

/** 자리를 바꾸는 요청 하나 */
export interface SeatRequest {
  holder: SeatHolder;
  by: SeatChanger;
  /** 바꾸는 까닭 — 이력·활동 기록·대표 알림에 남는다 (저장 전에 가린다) */
  reason: string;
  /** 넘기는 쪽이 남긴 말 (hand_off_seat의 note) */
  note?: string | null;
  /** 운영자 강제: 실행 중인 메인 턴을 바로 멈추고 마무리를 기다리지 않는다 */
  force?: boolean;
  /** hand_off_seat를 부른 턴 — 그 턴이 끝나면 넘어간다 */
  callerTurnId?: string | null;
  /** 서버 초기화(처음 보유자) — 자리가 비었을 때만 된다 */
  initial?: boolean;
  /**
   * 이 요청 뒤에 쓰일 메인 모의 실행 값 (개발자 옵션). 데스크톱 운영 설정이 모의 실행 끄기와 메인 AI 종류 바꾸기를 한 요청에 보내면, 지금 쓸 수 있는지는
   * 끈 뒤의 값으로 본다 (리드 결정 S4-28). 주지 않으면 저장된 값
   */
  mainMock?: boolean;
}

export interface SeatAssignResult {
  generation: number;
  /** swap: 새 세대로 교체(진행 중이거나 끝남) · same: 같은 종류에서 모델·노력치만(세대 그대로, 다음 턴부터) · seated: 빈 자리에 앉힘 */
  outcome: 'swap' | 'same' | 'seated';
  /** 교체가 끝나거나 멈출 때 풀린다 */
  done: Promise<void>;
}

/** S4b가 채우는 교체 순서의 칸 (3·6번 — handover.ts HandoverService.seatHooks) */
export interface SeatHooks {
  /**
   * 3번: 나가는 보유자의 인계 메모 턴. 주지 않으면(건너뜀) 바로 null — 교체가 그 호출 안에서 이어진다. 주면 그 턴이 끝날 때 풀리고, 멈춘 메모 턴의 종료를 확인하지
   * 못하면 그 까닭을 돌려준다 — 교체는 switching으로 멈춘다 (CTL-11)
   */
  memoTurn?: (swap: SeatSwapRow) => Promise<void | { unconfirmed: string }> | null;
  /**
   * 6번: 인계 꾸러미의 모든 칸 (자리 칸 seat 다음에 확인된 사실·메모·기억 문서, 6.2) — 가리고 12,000자 안으로 줄인 것과 그 글 길이. 없으면 자리 칸만
   */
  packetSections?: (swap: SeatSwapRow, holder: SeatHolder, seat: HandoverSection, now: string) => { sections: HandoverSection[]; chars: number };
}

export class SeatService {
  /** 교체 순서의 3·6번 — S4b가 채운다 */
  hooks: SeatHooks = {};
  /** 진행 중인 교체 작업 (한 번에 하나) */
  private job: Promise<void> | null = null;

  constructor(private readonly core: Core) {}

  private get ctx() {
    return this.core.ctx;
  }

  // ───────────────────────── 읽기 ─────────────────────────

  private row(): MainSeatRow {
    return this.ctx.store.seat.get('main') ?? VACANT;
  }

  /** 지금 세대 (빈 자리면 마지막 세대, 처음이면 0) */
  generation(): number {
    return this.row().generation;
  }

  /**
   * 메인 턴을 띄울 때 그 턴에 적을 세대 — 교체 중에 띄우는 것은 나가는 보유자의 인계 메모 턴뿐이라 나가는 세대다 (S4b). 그 밖에는 지금 세대
   */
  launchGeneration(): number {
    const s = this.row();
    return s.state === 'switching' && s.swap ? s.swap.from : s.generation;
  }

  /** 이 턴이 교체 중인 자리의 인계 메모 턴인지 (3번, S4b) — 그 턴의 도구는 일지·기억 쓰기와 조회만 받는다 */
  isMemoTurn(turnId: string): boolean {
    const s = this.row();
    return s.state === 'switching' && !!s.swap?.memoTurnId && s.swap.memoTurnId === turnId;
  }

  /** 인계 메모 턴을 띄웠다 (handover.ts) — 한 교체에 한 번만 준다 */
  noteMemoTurn(to: number, turnId: string | null): void {
    const cur = this.row();
    if (cur.state === 'switching' && cur.swap?.to === to) this.ctx.store.seat.put({ ...cur, swap: { ...cur.swap, memoTurnId: turnId ?? 'started' } });
  }

  /** 스케줄러가 M-MAIN 일을 띄워도 되는지 — 서버가 띄우는 보유자가 앉아 있을 때만 (교체 중·빈 자리에는 띄우지 않는다, 4.3 1번) */
  runsMain(): boolean {
    const s = this.row();
    return s.state === 'active' && s.holder?.kind === 'launched';
  }

  /** 앉은 보유자가 서버가 띄우는 CLI면 그 AI 설정 (M-MAIN의 AI) */
  launchedAi(): AiConfig | null {
    const h = this.row().holder;
    return h?.kind === 'launched' ? { ...h.ai } : null;
  }

  /**
   * 이 세대의 메인 토큰을 받는지 (리드 결정 S4-4): 지금 세대이거나, 교체 중인 나가는 세대(마무리 중인 턴 — hand_off_seat를 부른 턴이 그 턴 안에서 남길
   * 말을 적는다)일 때만. 교체가 끝나면(4~7번은 한 호출 안에서 끝난다) 나가는 세대는 seat_changed
   */
  acceptsGeneration(generation: number): boolean {
    const s = this.row();
    if (generation === s.generation) return true;
    return s.state === 'switching' && !!s.swap && generation === s.swap.from;
  }

  /** 운영자의 자리 정책 (S4-12) — 저장된 값이 틀리면 기본값 */
  policy(): SeatPolicy {
    const p = this.ctx.store.kv.get<Partial<SeatPolicy>>(POLICY_KEY);
    const holders = Array.isArray(p?.holders) && p.holders.length && p.holders.every((h) => typeof h === 'string' && parseHolderSpec(h)) ? [...p.holders] : [...DEFAULT_SEAT_POLICY.holders];
    const drainMs = typeof p?.drainMs === 'number' && Number.isInteger(p.drainMs) && p.drainMs >= 0 && p.drainMs <= SEAT_DRAIN_MAX_MS ? p.drainMs : DEFAULT_SEAT_POLICY.drainMs;
    return { holders, drainMs };
  }

  /** 대표가 보는 지금 자리 (seat.get·스냅숏 seat) */
  view(): SeatView {
    const s = this.row();
    return {
      generation: s.generation,
      state: s.state,
      holder: holderView(s.holder),
      since: s.since,
      unresponsiveSince: s.unresponsiveSince,
      unresponsiveReason: s.unresponsiveReason,
      pendingHolder: s.state === 'switching' ? holderView(s.pendingHolder) : null,
      vision: s.vision,
      // 화면 조작 상태 (리드 결정 S6-2·S6-11) — 쓸 수 없는 까닭, 조작 중, 멈춤. 바뀌는 때에만 바뀐다 (desktop/safety.ts)
      screen: this.core.desktop.screenView(),
    };
  }

  /** 자리 이력 (seat.history) — 새 것부터, 200줄까지 */
  history(): SeatHistoryEntry[] {
    return this.ctx.store.seatHistory.list(undefined, { desc: true, limit: 200 }).map((h) => ({
      generation: h.generation,
      holder: holderView(h.holder)!,
      startedAt: h.startedAt,
      endedAt: h.endedAt,
      endReason: h.endReason,
      changedBy: h.changedBy,
      hasHandover: !!h.handoverId,
    }));
  }

  /** 그 세대의 인계 꾸러미 (seat.handover) — 세대를 주지 않으면 지금 세대. 없으면 null */
  handover(generation?: number | null): SeatHandoverView | null {
    const g = generation ?? this.generation();
    if (!Number.isInteger(g) || g < 1) return null;
    const p = this.ctx.store.seatHandovers.get(seatGenerationId(g));
    if (!p) return null;
    return { generation: p.generation, createdAt: p.createdAt, holder: holderView(p.holder)!, previous: holderView(p.previous), sections: p.sections, chars: p.chars };
  }

  // ───────────────────────── 시작 ─────────────────────────

  /**
   * 앱 시작 때 (M-MAIN을 만들기 전): 자리 한 줄이 없으면 채운다 (S4-12). 앞 판 DB(M-MAIN이 이미 있다)는 운영 설정의 메인 AI(general.mainAgent)로
   * 1세대·active, 이력은 바꾼 쪽 server. 새 DB는 서버면 운영자 설정 seat.initialHolder, 없으면 general.mainAgent로 — 서버 초기화 요청으로 assign을 거친다.
   * 서버가 넘긴 자리 정책(server.json)도 여기서 먼저 적용한다
   */
  init(): void {
    const ctx = this.ctx;
    const cfg = ctx.deps.seat;
    if (cfg) this.applyOperatorConfig({ holders: cfg.holders ?? null, drainMs: cfg.drainMs ?? null, initialHolder: null }, 'server.json');
    if (ctx.store.seat.get('main')) return;
    const migrated = !!ctx.store.members.get(MAIN_AGENT_ID);
    ctx.store.seat.insert({ ...VACANT });
    const main = ctx.settings().general.mainAgent;
    let holder: SeatHolder = { kind: 'launched', ai: { ...main } };
    let reason = migrated ? '4단계 이전 데이터에서 옮김 — 운영 설정의 메인 AI(general.mainAgent)' : '처음 보유자 — 운영 설정의 메인 AI(general.mainAgent)';
    const spec = !migrated && cfg?.initialHolder ? parseHolderSpec(cfg.initialHolder) : null;
    if (spec?.kind === 'launched') {
      holder = { kind: 'launched', ai: spec.ai === main.kind ? { ...main } : { kind: spec.ai, model: null, effortTier: main.effortTier, effortOverride: null } };
      reason = `처음 보유자 — 운영자 설정 seat.initialHolder(${cfg!.initialHolder})`;
    } else if (spec) {
      // 운영자 설정 확인(serverConfigValueError)이 시작 전에 거부한다 — 여기까지 왔으면 기록만 하고 운영 설정의 메인 AI로 앉힌다
      ctx.log('warn', `메인 자리: 처음 보유자 ${cfg!.initialHolder}은(는) 앉힐 수 없어 운영 설정의 메인 AI로 앉힙니다 — ${SEAT_EXTERNAL_LATER}`);
    }
    this.assign({ holder, by: 'server', reason, initial: true });
  }

  /**
   * 앱 시작 때 (재시작 복구 뒤): 앞 실행이 끝내지 못한 교체를 이어 간다. 종료를 확인하지 못해 멈춘 교체는 그대로 정지 해제를 기다린다 — 그 출구(M-MAIN
   * 일시정지)가 없으면(이 규칙 전에 멈춘 교체) 건다 (S4-18)
   */
  resumeAfterRestart(): void {
    const swap = this.row().swap;
    if (!swap) return;
    if (swap.stage === 'unconfirmed') {
      this.holdMain(swap);
      return;
    }
    this.ctx.activity({ kind: 'seat', text: `메인 자리 교체 이어 감 (세대 ${swap.from} → ${swap.to}) — 앞 실행이 마치기 전에 끝났습니다` });
    this.job = this.runSwap({ ...swap, stage: 'draining' });
  }

  /**
   * 대표의 정지 해제 뒤 (StopService.release): 나가는 턴의 종료를 확인하지 못해 멈춘 교체를 이어 간다 — 알림이 '남은 프로세스가 사라졌는지 확인한 뒤
   * 정지 해제'를 안내한다 (CTL-11, 4.3 2번)
   */
  continueAfterRelease(): void {
    const swap = this.row().swap;
    if (!swap || swap.stage !== 'unconfirmed') return;
    if (this.core.turns.hasMemberFlow(MAIN_AGENT_ID)) {
      // 나가는 메인 턴의 흐름이 아직 남았다 — 두 메인이 겹치지 않게 이어 가지 않는다. 교체는 그대로 멈춰 있으므로 출구(정지 해제)가 화면에 남게 M-MAIN
      // 일시정지를 그대로 두고(정지 해제가 풀지 않았다 — keepsMainHold, S4-27) 그 까닭만 고친다. 멈춘 교체 알림도 고친다 (CTL-11, S4-18)
      const s = this.row();
      this.ctx.activity({ kind: 'seat', level: 'warn', text: `정지 해제를 받았지만 이전 메인 턴이 아직 끝나지 않아 메인 자리 교체를 이어 가지 않음 (세대 ${swap.from} → ${swap.to}) — 메인 에이전트의 일시정지를 그대로 둠` });
      this.holdMain(swap, '정지 해제 때 이전 메인 턴이 아직 끝나지 않음', true);
      this.ctx.notify({
        level: 'urgent',
        title: '메인 자리 교체가 멈췄습니다',
        body: `정지 해제를 눌렀지만 이전 메인 턴(${holderLabel(s.holder)})이 아직 끝나지 않아 ${holderLabel(s.pendingHolder)}에게 넘기지 않았습니다. 메인 에이전트는 일시정지한 채로 두었습니다. 잠시 뒤 다시 '정지 해제'를 누르세요 — 그때 이전 메인 턴이 끝났으면 교체를 이어 갑니다`,
        link: { tab: 'seat' },
        key: `seat-switch:${swap.to}`,
      });
      return;
    }
    this.ctx.activity({ kind: 'seat', text: `정지 해제로 멈췄던 메인 자리 교체를 이어 감 (세대 ${swap.from} → ${swap.to})` });
    // 종료를 확인하지 못했던 보유자에게는 인계 메모 턴(3번)을 다시 주지 않는다 — 대표가 남은 프로세스를 정리했다고 본 뒤라 새로 띄우지 않는다 (S4b)
    const memoSkip = '나가는 턴의 종료를 확인하지 못해 멈췄던 교체를 정지 해제로 이어 갑니다';
    this.job = this.runSwap({ ...this.saveSwap({ ...swap, stage: 'finishing', memoSkip }) });
  }

  /**
   * 대표의 정지 해제가 M-MAIN 일시정지를 풀지 말아야 하는지 (StopService.release가 그 정지를 풀기 전에 본다, 리드 결정 S4-27) — 멈춘 교체의 나가는 메인 턴
   * 흐름이 아직 남았으면 continueAfterRelease가 교체를 잇지 않고 그 정지를 출구로 남긴다. 풀었다 다시 걸면 '메인 에이전트 다시 시작'(쌓인 명령을 이어서
   * 처리합니다) 알림이 나가 참이 아니게 된다
   */
  keepsMainHold(): boolean {
    return this.row().swap?.stage === 'unconfirmed' && this.core.turns.hasMemberFlow(MAIN_AGENT_ID);
  }

  // ───────────────────────── 운영자 정책 ─────────────────────────

  /**
   * 운영자 설정의 자리 정책을 적용한다 (서버 server.json 시작·config reload, S4-12): 값이 지금과 다르면 바꾸고 바꾼 것마다 활동 기록(행위자 operator).
   * null 칸은 그대로 둔다. 처음 보유자는 자리가 비었을 때만 앉힌다 — 앉은 자리는 설정을 바꿔도 그대로다(바꾸려면 seat assign). 값의 모양은
   * seatConfigProblem이 먼저 본다
   */
  applyOperatorConfig(values: { holders: string[] | null; drainMs: number | null; initialHolder: string | null }, origin: string): ServerConfigChange[] {
    const ctx = this.ctx;
    const cur = this.policy();
    const next: SeatPolicy = { holders: values.holders ? values.holders.map((h) => h.trim()) : cur.holders, drainMs: values.drainMs ?? cur.drainMs };
    const changes: ServerConfigChange[] = [];
    if (next.holders.join(',') !== cur.holders.join(',')) {
      ctx.activity({ kind: 'settings', actor: OPERATOR, text: `${origin}: 메인 자리에 앉을 수 있는 보유자를 바꿈 (${cur.holders.join(', ')} → ${next.holders.join(', ')})` });
      changes.push({ item: 'seat.holders', text: `메인 자리에 앉을 수 있는 보유자 → ${next.holders.join(', ')}` });
    }
    if (next.drainMs !== cur.drainMs) {
      ctx.activity({ kind: 'settings', actor: OPERATOR, text: `${origin}: 메인 자리 교체 때 마무리를 기다리는 시간을 바꿈 (${cur.drainMs / 1000}초 → ${next.drainMs / 1000}초)` });
      changes.push({ item: 'seat.drainMs', text: `교체 때 마무리를 기다리는 시간 → ${next.drainMs / 1000}초` });
    }
    if (changes.length) ctx.store.kv.set(POLICY_KEY, next);
    const spec = values.initialHolder ? parseHolderSpec(values.initialHolder) : null;
    if (spec?.kind === 'launched' && this.row().state === 'vacant') {
      const main = ctx.settings().general.mainAgent;
      const ai: AiConfig = spec.ai === main.kind ? { ...main } : { kind: spec.ai, model: null, effortTier: main.effortTier, effortOverride: null };
      this.assign({ holder: { kind: 'launched', ai }, by: 'server', reason: `처음 보유자 — ${origin} seat.initialHolder(${values.initialHolder})`, initial: true });
      changes.push({ item: 'seat.initialHolder', text: `빈 메인 자리에 처음 보유자 ${AI_LABEL[spec.ai]}${subjectJosa(AI_LABEL[spec.ai])} 앉음` });
    }
    return changes;
  }

  // ───────────────────────── 바꾸기 (한 곳) ─────────────────────────

  /**
   * 자리를 바꾸는 단 하나의 길 (리드 결정 S4-2). 거부 판정과 바꾸기는 한 트랜잭션이다 — 동시에 온 요청 중 먼저 든 것만 이기고, 나머지는 BackendError
   * (conflict·forbidden)로 까닭을 말한다. 교체(새 세대)는 1번을 여기서 마치고 나머지를 이어서 한다(실행 중인 메인 턴이 없으면 이 호출 안에서 끝난다)
   */
  assign(req: SeatRequest): SeatAssignResult {
    const ctx = this.ctx;
    const holder = this.normalized(req.holder);
    const label = holderLabel(holder);
    const reason = clip(ctx.redact.text(req.reason), 500) || '(까닭을 적지 않음)';
    const note = req.note?.trim() ? clip(ctx.redact.text(req.note), 1000) : null;
    const now = ctx.now();
    const decided = ctx.store.tx(() => {
      const cur = this.row();
      if (holder.kind === 'external') throw new BackendError('forbidden', `${label}에게 메인 자리를 줄 수 없습니다 — ${SEAT_EXTERNAL_LATER}`);
      if (cur.state === 'switching' && cur.swap?.stage === 'unconfirmed') {
        // 나가는 턴의 종료를 확인하지 못해 멈춘 교체 — 운영자의 강제 배정도 두 메인이 겹칠 수 있어 받지 않는다. 출구는 대표의 정지 해제다 (CTL-11, 4.3 2번).
        // 화면 도우미가 끝났는지 확인하지 못해 멈춘 교체도 같다 — 글만 그 사실대로 (리드 결정 S6-21 A2b)
        throw new BackendError(
          'conflict',
          this.core.desktop.unconfirmedHelper()
            ? `메인 자리 교체가 멈춰 있습니다(세대 ${cur.swap.from} → ${cur.generation}, 화면 도우미가 끝났는지 확인하지 못함) — 대표가 '정지 해제'를 누르면 화면 도우미가 끝났는지 한 번 더 확인하고 ${holderLabel(cur.pendingHolder)}에게 넘어갑니다`
            : `메인 자리 교체가 멈춰 있습니다(세대 ${cur.swap.from} → ${cur.generation}, 나가는 메인 턴의 종료를 확인하지 못함) — 남은 프로세스가 모두 사라졌는지 확인한 뒤 대표가 '정지 해제'를 누르면 ${holderLabel(cur.pendingHolder)}에게 넘어갑니다`,
        );
      }
      if (cur.state === 'switching') {
        throw new BackendError('conflict', `메인 자리를 ${holderLabel(cur.pendingHolder)}에게 넘기는 중입니다(세대 ${cur.swap?.from ?? cur.generation - 1} → ${cur.generation}) — 교체가 끝난 뒤에 다시 하세요`);
      }
      if (req.initial) {
        if (cur.state !== 'vacant') {
          throw new BackendError('conflict', `메인 자리에 이미 ${holderLabel(cur.holder)}${subjectJosa(holderLabel(cur.holder))} 앉아 있습니다(세대 ${cur.generation}) — 처음 보유자는 자리가 비었을 때만 씁니다`);
        }
      } else {
        const spec = holderSpecOf(holder);
        if (!this.policy().holders.includes(spec)) {
          throw new BackendError('forbidden', `${label}(${spec})은(는) 운영자가 정한 메인 자리 보유자 목록(seat.holders: ${this.policy().holders.join(', ')})에 없습니다`);
        }
        // 같은 종류에서 모델·노력치만 바꾸면 자리를 넘기는 것이 아니다 — 지금 쓸 수 있는지 보지 않고 다음 턴부터 적용한다(4단계 전 데스크톱과 같다). 종류를
        // 바꿀 때만 지금 쓸 수 있는 보유자여야 한다 — 시작하지 못할 보유자를 앉히면 자리가 곧 응답 없음이 된다 (리드 결정 S4-15)
        const sameKind = cur.state === 'active' && cur.holder?.kind === 'launched' && holder.kind === 'launched' && cur.holder.ai.kind === holder.ai.kind;
        const why = sameKind ? null : this.unavailable(holder, req.mainMock);
        if (why) throw new BackendError('conflict', this.unavailableRefusal(req.by, holder, why));
        if (cur.state === 'active' && cur.holder?.kind === 'launched' && sameAi(cur.holder.ai, holder.ai)) {
          throw new BackendError('conflict', `메인 자리에는 이미 ${label}${subjectJosa(label)} 같은 설정으로 앉아 있습니다(세대 ${cur.generation})`);
        }
      }
      if (cur.state === 'vacant') {
        const generation = cur.generation + 1;
        ctx.store.seat.put({ ...cur, generation, state: 'active', holder, since: now, pendingHolder: null, swap: null, ...NOT_UNRESPONSIVE, ...VISION_UNKNOWN });
        ctx.store.seatHistory.insert({ id: seatGenerationId(generation), generation, holder, startedAt: now, endedAt: null, startReason: reason, endReason: null, changedBy: req.by, handoverId: null });
        this.syncMainAi(holder, req.by, `메인 자리 세대 ${generation} — ${reason}`);
        return { outcome: 'seated' as const, generation, previous: null, swap: null, modelChanged: true };
      }
      if (cur.holder?.kind === 'launched' && holder.kind === 'launched' && cur.holder.ai.kind === holder.ai.kind) {
        // 같은 종류에서 모델·노력치만 — 세대를 올리지 않는다. 실행 중인 턴은 띄울 때의 값 그대로, 다음 턴부터 새 값 (ARCHITECTURE 19.1)
        // 모델이 바뀌면 화면 보기를 다시 확인한다 — 모델마다 이미지를 보는지가 다를 수 있다. 노력치만 바뀌면 그대로 (리드 결정 S6-10)
        const modelChanged = visionModelKey(cur.holder) !== visionModelKey(holder);
        ctx.store.seat.put({ ...cur, holder, ...(modelChanged ? VISION_UNKNOWN : {}) });
        const h = ctx.store.seatHistory.get(seatGenerationId(cur.generation));
        if (h) ctx.store.seatHistory.put({ ...h, holder });
        this.syncMainAi(holder, req.by, `메인 자리 세대 ${cur.generation} — ${reason}`);
        return { outcome: 'same' as const, generation: cur.generation, previous: cur.holder, swap: null, modelChanged };
      }
      // 교체 1번: switching·세대 +1·이력 닫기/열기 — 이 순간부터 스케줄러는 M-MAIN 일을 새로 시작하지 않는다
      const generation = cur.generation + 1;
      const swap: SeatSwapRow = {
        from: cur.generation,
        to: generation,
        by: req.by,
        reason,
        note,
        force: !!req.force,
        callerTurnId: req.callerTurnId ?? null,
        requestedAt: now,
        stage: 'draining',
      };
      ctx.store.seat.put({ ...cur, generation, state: 'switching', pendingHolder: holder, swap });
      const prev = ctx.store.seatHistory.get(seatGenerationId(cur.generation));
      if (prev) ctx.store.seatHistory.put({ ...prev, endedAt: now, endReason: `${CHANGED_BY_TEXT[req.by]}: ${reason}` });
      ctx.store.seatHistory.insert({ id: seatGenerationId(generation), generation, holder, startedAt: now, endedAt: null, startReason: reason, endReason: null, changedBy: req.by, handoverId: null });
      return { outcome: 'swap' as const, generation, previous: cur.holder, swap, modelChanged: false };
    });
    ctx.bus.changed();
    const actor = actorOf(req.by);
    // 자리가 바뀐 일은 활동 기록과 함께 메인 일지에도 서버 기록(seat)으로 남는다 (6.1, S4b)
    const record = (text: string) => {
      ctx.activity({ kind: 'seat', actor, text });
      this.core.journal.server('seat', text, { generation: decided.generation });
    };
    if (decided.outcome === 'seated') {
      record(`메인 자리에 ${label}${subjectJosa(label)} 앉음 (세대 ${decided.generation}, ${CHANGED_BY_LABEL[req.by]}) — ${reason}`);
      this.queueVisionCheck(`메인 자리에 새로 앉음 (세대 ${decided.generation})`);
      ctx.bus.signal('tick');
      return { generation: decided.generation, outcome: 'seated', done: Promise.resolve() };
    }
    if (decided.outcome === 'same') {
      const ai = (holder as Extract<SeatHolder, { kind: 'launched' }>).ai;
      record(`메인 자리 ${label}의 모델·노력치를 바꿈 (세대 ${decided.generation} 그대로 — 다음 턴부터: 모델 ${this.core.team.modelValue(ai) ?? 'CLI 기본'}, 노력치 ${this.core.team.effortValue(ai)}) — ${reason}`);
      if (decided.modelChanged) this.queueVisionCheck('메인 보유자의 모델이 바뀜');
      return { generation: decided.generation, outcome: 'same', done: Promise.resolve() };
    }
    record(
      `메인 자리 교체 시작: ${holderLabel(decided.previous)} → ${label} (세대 ${decided.swap!.from} → ${decided.generation}, ${CHANGED_BY_TEXT[req.by]}${req.force ? ', 강제' : ''}) — ${reason}${note ? ` / 남긴 말: ${clip(note, 200)}` : ''}`,
    );
    // 교체 1번: 화면 도우미에 STOP — 눌린 키·버튼을 떼고 끝낸다. 이 순간부터 화면 도구는 conflict로 거부된다(자리가 switching) — 나가는 자리가 입력을 더
    // 보내지 않는다 (리드 결정 S6-9, SERVER_DESIGN 8.3.5 '정지'). 그 결과는 4번 앞에서 본다 — 끝남을 확인하지 못했으면 새 보유자를 앉히지 않는다
    // (finishAfterScreenStop, 리드 결정 S6-21 A2b). 떠 있는 화면 도우미가 없으면(데스크톱 앱 등) 기다릴 것이 없어 지금처럼 이 호출 안에서 끝난다
    this.core.desktop.stopForSwap();
    const done = this.runSwap(decided.swap!);
    this.job = done;
    return { generation: decided.generation, outcome: 'swap', done };
  }

  /** 화면 보기 확인 업무 (리드 결정 S6-10) — 화면 도구를 내놓을 때만 (desktop/service.ts가 판정한다). 실패해도 자리 바꾸기는 그대로 */
  private queueVisionCheck(why: string): void {
    try {
      this.core.desktop.queueCheck(why);
    } catch (e) {
      this.ctx.log('warn', '화면 확인 업무를 넣지 못했습니다', e);
    }
  }

  // ───────────────────────── 교체 2~8번 ─────────────────────────

  /**
   * 교체 2번부터. 기다릴 것(실행 중인 메인 턴·인계 메모 턴)이 없으면 이 호출 안에서 끝난다 — 데스크톱 운영 설정이 바꾼 메인 AI가 그 답과 함께
   * 보이게 (S4-9). 실패는 기록만 하고 던지지 않는다
   */
  private runSwap(swap: SeatSwapRow): Promise<void> {
    try {
      if (swap.stage === 'draining' && this.core.turns.hasMemberFlow(MAIN_AGENT_ID)) return this.drainThenFinish(swap).catch((e) => this.failed(swap, e));
      if (swap.stage === 'draining' && !swap.memoSkip) {
        // 기다릴 흐름이 없어도 나가는 메인 턴이 교체를 청한 뒤 종료를 확인하지 못한 채 끝났으면 멈춘다 — 앱이 2번 중에 끝나 다음 시작이 이어 가는 교체다
        // (resumeAfterRestart). 재시작 복구는 실행 중이던 턴을 끊어 종료를 확인하면 exited, 못 하면 kill_failed로 적으므로 그 기록을 따른다. 앞 실행이 이미
        // kill_failed로 적은 턴은 복구가 다시 보지 않아 그대로 멈춘다 — 출구는 정지 해제 한 번이다 (리드 결정 S4-32·S4-26). assign이 막 시작한 교체는 청한 뒤에
        // 끝난 턴이 없어 찾지 못하고, continueAfterRelease는 finishing으로 넘기므로 보지 않는다. 정지 해제로 이미 이어 가던 교체(memoSkip)가 4번 전에 끊겨
        // 다음 시작이 draining으로 이어 가도 보지 않는다 — 대표가 남은 프로세스를 확인하고 푼 교체이고, 그 뒤로는 M-MAIN 턴이 뜨지 않았다 (리드 결정 S4-38)
        const unconfirmed = this.unconfirmedOutgoingEnd(swap);
        if (unconfirmed) {
          this.holdUnconfirmed(swap, unconfirmed);
          return Promise.resolve();
        }
      }
      const ready = swap.stage === 'draining' ? this.saveSwap({ ...swap, stage: 'finishing' }) : swap;
      if (ready.stage !== 'finishing') return Promise.resolve();
      const memo = this.memoThenFinish(ready);
      if (memo) return memo.catch((e) => this.failed(ready, e));
    } catch (e) {
      this.failed(swap, e);
    }
    return Promise.resolve();
  }

  private async drainThenFinish(swap: SeatSwapRow): Promise<void> {
    const turns = this.core.turns;
    const drainMs = this.policy().drainMs;
    // 2번: 나가는 메인 턴의 마무리를 기다린다(hand_off_seat를 부른 턴이면 그 턴이 끝날 때까지). 운영자 강제는 기다리지 않는다
    const settled = !swap.force && drainMs > 0 && (await turns.settleMember(MAIN_AGENT_ID, drainMs));
    if (this.core.stopping) return;
    if (!settled) {
      const why = swap.force ? `메인 자리 교체(세대 ${swap.to}) — 운영자가 바로 멈춤` : `메인 자리 교체(세대 ${swap.to}) — 마무리 시간 ${Math.round(drainMs / 100) / 10}초를 넘김`;
      const results = await turns.stopMember(MAIN_AGENT_ID, why, true);
      const confirmed = await turns.settleMember(MAIN_AGENT_ID, STOP_SETTLE_MS);
      if (this.core.stopping) return;
      const failed = results.filter((r) => !r.ok);
      if (failed.length || !confirmed) {
        this.holdUnconfirmed(swap, failed.map((r) => r.detail).join('; ') || '멈춘 턴의 마무리가 끝나지 않았습니다');
        return;
      }
    }
    // 교체가 멈추지 않았어도 나가는 메인 턴이 종료를 확인하지 못한 채 끝났으면(대표의 긴급 정지가 메인 검수 턴을 끝냄 등) 같이 멈춘다 — 메인 검수 턴은 작업
    // 보류로만 막혀 새 보유자가 곧 메인 턴을 띄울 수 있다 (리드 결정 S4-26, 4.3 2번)
    const unconfirmed = this.unconfirmedOutgoingEnd(swap);
    if (unconfirmed) {
      this.holdUnconfirmed(swap, unconfirmed);
      return;
    }
    const ready = this.saveSwap({ ...swap, stage: 'finishing' });
    await this.memoThenFinish(ready);
  }

  /**
   * 교체를 청한 뒤에 끝난 나가는 M-MAIN 턴(main:*·메인 검수 review:*) 가운데 종료를 확인하지 못한 것 — turns.blockUnconfirmedRun이 막는 것과 같은 표시(턴 기록의
   * kill_failed)로 본다. 있으면 그 턴의 글, 없으면 null (리드 결정 S4-26). 교체 중에 새로 뜨는 M-MAIN 턴은 나가는 보유자의 인계 메모 턴뿐이므로 그 턴들은
   * 교체를 청할 때 돌던 것이나 메모 턴이고(S4-31), 최근 기록 안에 있다. 부르는 곳: 2번 마무리 뒤, 메모 턴 뒤, 재시작으로 이어 가는 교체(S4-32)
   */
  private unconfirmedOutgoingEnd(swap: SeatSwapRow): string | null {
    const since = Date.parse(swap.requestedAt);
    const t = this.ctx.store.turns
      .list({ ref1: MAIN_AGENT_ID, state: 'ended' }, { desc: true, limit: 200 })
      .find((x) => OUTGOING_KINDS.has(x.sessionKind) && x.process.state === 'kill_failed' && !!x.endedAt && Date.parse(x.endedAt) >= since);
    // 스스로 끝난 턴은 끝 글이 비어 있다 — 끝 까닭을 한국어 이름으로 ('정상 종료')
    return t ? `턴 ${t.id}(${clip(t.endDetail || (t.endReason ? TURN_END_LABEL[t.endReason] : '끝남'), 80)}): ${clip(t.process.killDetail ?? '남은 하위 프로세스를 확인하지 못함', 200)}` : null;
  }

  /**
   * 3번(인계 메모 턴) 뒤 4~8번. 메모 턴을 주지 않으면 이 호출 안에서 끝나고 null — 기다릴 것이 없는 교체는 assign 안에서 끝난다(데스크톱 운영 설정의 답과
   * 함께 바뀐 메인 AI가 보인다, S4-9). 메모 턴을 주면 그 턴이 끝난 뒤에 마친다
   */
  private memoThenFinish(swap: SeatSwapRow): Promise<void> | null {
    const memo = this.hooks.memoTurn?.(swap) ?? null;
    if (!memo) return this.finishAfterScreenStop(swap);
    return memo.then((r) => {
      if (this.core.stopping) return;
      // 멈춘 인계 메모 턴의 종료를 확인하지 못했다 — 2번과 같이 새 보유자를 앉히지 않고 멈춘다 (S4b)
      if (r && 'unconfirmed' in r) {
        this.holdUnconfirmed(swap, r.unconfirmed);
        return;
      }
      // 메모 턴이 교체 밖의 정지(대표의 긴급 정지)로 끝났거나 스스로 끝났는데 종료를 확인하지 못했어도(남은 하위 프로세스) 같이 멈춘다 — 메모 턴도 교체를
      // 청한 뒤에 끝난 M-MAIN의 main:* 턴이다 (리드 결정 S4-31·S4-26). 메모 턴을 주지 않은 갈래(정지 해제로 잇는 memoSkip 포함)는 보지 않는다 — 대표가
      // 멈춘 교체를 확인하고 풀었는데 그 전의 kill_failed 턴이 기록에 남아 있어, 보면 다시 멈춘다
      const unconfirmed = this.unconfirmedOutgoingEnd(swap);
      if (unconfirmed) {
        this.holdUnconfirmed(swap, unconfirmed);
        return;
      }
      return this.finishAfterScreenStop(swap) ?? undefined;
    });
  }

  /**
   * 4~8번 앞에서 화면 도우미의 정지를 본다 (리드 결정 S6-21 A2b): 1번의 STOP(과 그 뒤의 다른 정지)이 아직 돌면 그 결과를 기다리고, 끝남을 확인하지 못한 화면
   * 도우미가 있으면 — 나가는 메인 턴의 종료를 확인하지 못한 때와 똑같이 — 새 보유자를 앉히지 않고 멈춘다(holdUnconfirmed). 새 보유자가 살아 있을지 모르는 화면
   * 도우미 위에서 턴을 얻지 않는다. 출구는 대표의 정지 해제다 — 그때 한 번 더 확인하고(StopService.release → desktop.ownerReleased) 교체를 잇는다. 그렇게 이어 가는
   * 교체(memoSkip)는 다시 멈추지 않는다: 대표가 확인하고 푼 교체이고, 그래도 끝나지 않은 화면 도우미는 화면 도구만 막는다(메인은 화면 없이 일한다).
   * 기다릴 정지가 없으면 이 호출 안에서 끝나고 null (데스크톱 운영 설정의 답과 함께 바뀐 메인 AI가 보인다, S4-9)
   */
  private finishAfterScreenStop(swap: SeatSwapRow): Promise<void> | null {
    const go = (): void => {
      if (this.core.stopping) return;
      const unconfirmed = swap.memoSkip ? null : this.core.desktop.unconfirmedHelper();
      if (unconfirmed) this.holdUnconfirmed(swap, unconfirmed, 'screen');
      else this.finish(swap);
    };
    const pending = this.core.desktop.pendingStop();
    if (!pending) {
      go();
      return null;
    }
    return pending.then(go, go);
  }

  /**
   * 2번에서 나가는 턴의 종료를 확인하지 못함 (CTL-11) — 새 보유자를 앉히지 않고 switching으로 멈춘다. 겹쳐 띄우지 않는다. 멈춘 교체는 모두 여기로 온다(마무리 시간을
   * 넘겨 멈춤·운영자 강제·메인 검수 턴·멈춘 턴의 마무리 15초 초과·인계 메모 턴) — 대표 화면에 '정지 해제'가 보이게 M-MAIN 일시정지를 건다 (holdMain, 리드 결정 S4-18)
   */
  private holdUnconfirmed(swap: SeatSwapRow, detail: string, what: 'turn' | 'screen' = 'turn'): void {
    const ctx = this.ctx;
    const s = this.row();
    this.saveSwap({ ...swap, stage: 'unconfirmed' });
    const from = holderLabel(s.holder);
    const to = holderLabel(s.pendingHolder);
    // what 'screen': 나가는 턴은 끝났지만 교체 1번에서 멈춘 화면 도우미가 끝났는지 확인하지 못했다 (리드 결정 S6-21 A2b) — 글은 그 사실대로
    const fact = what === 'screen' ? '화면 도우미가 끝났는지 확인하지 못해' : '나가는 메인 턴의 종료를 확인하지 못해';
    const text = `메인 자리 교체 멈춤 (세대 ${swap.from} → ${swap.to}): ${fact} ${to}${subjectJosa(to)} 앉지 않았습니다 — ${clip(detail, 300)}`;
    ctx.activity({ kind: 'seat', level: 'error', text });
    this.core.journal.server('seat', text, { generation: swap.to });
    ctx.log(
      'warn',
      what === 'screen'
        ? `메인 자리 교체 멈춤 (세대 ${swap.from} → ${swap.to}): 이전 메인 에이전트(${from})가 쓰던 화면 도우미가 끝났는지 확인하지 못해 새 보유자(${to})를 앉히지 않았습니다`
        : `메인 자리 교체 멈춤 (세대 ${swap.from} → ${swap.to}): 이전 메인 턴(${from})의 종료를 확인하지 못해 새 보유자(${to})를 앉히지 않았습니다 — 남은 프로세스를 확인하세요`,
    );
    this.holdMain(swap, what === 'screen' ? '화면 도우미가 끝났는지 확인하지 못함' : undefined);
    ctx.notify({
      level: 'urgent',
      title: '메인 자리 교체가 멈췄습니다',
      body:
        what === 'screen'
          ? `${to}에게 메인 자리를 넘기던 중 이전 메인 에이전트(${from})가 쓰던 화면 도우미가 끝났는지 확인하지 못했습니다. 새 메인 에이전트가 살아 있을지 모르는 화면 도우미와 겹치지 않게 새 보유자를 아직 앉히지 않고 메인 에이전트를 일시정지해 두었습니다. '정지 해제'를 누르면 화면 도우미가 끝났는지 한 번 더 확인하고 교체를 이어 갑니다 — 그때도 끝나지 않았으면 새 메인 에이전트는 화면 없이 일하고, 화면 조작은 서버 PC 운영자가 서버를 다시 시작해야 다시 쓸 수 있습니다`
          : `${to}에게 메인 자리를 넘기던 중 이전 메인 턴(${from})이 끝났는지 확인하지 못했습니다. 두 메인 에이전트가 겹쳐 돌지 않게 새 보유자를 아직 앉히지 않고 메인 에이전트를 일시정지해 두었습니다. ${this.processCheck()} '정지 해제'를 누르면 교체를 이어 갑니다`,
      // 누르면 자리 보기로 간다 (리드 결정 S4-19)
      link: { tab: 'seat' },
      key: `seat-switch:${swap.to}`,
    });
  }

  /**
   * 멈춘 교체의 출구를 대표 화면에 남긴다 (리드 결정 S4-18) — M-MAIN에 종료를 확인하지 못한 메인 실행(CTL-11, turns.blockUnconfirmedRun)과 같은 일시정지를 건다.
   * 이미 걸려 있으면 그대로 둔다 — renew면 그 까닭만 이 교체의 글로 고친다(정지 해제가 풀지 않고 남긴 정지, S4-27). 화면은 긴급 정지나 메인 일시정지 때
   * '정지 해제'를 보이고, 대표의 정지 해제(StopService.release)가 이 정지를 푼 뒤 continueAfterRelease가 교체를 잇는다
   */
  private holdMain(swap: SeatSwapRow, why = '나가는 메인 턴의 종료를 확인하지 못함', renew = false): void {
    const reason = `메인 자리 교체 멈춤 (세대 ${swap.from} → ${swap.to}) — ${why}`;
    const stop = this.ctx.stop();
    const held = stop.members[MAIN_AGENT_ID];
    if (held?.paused) {
      if (renew) {
        stop.members[MAIN_AGENT_ID] = { ...held, reason };
        this.ctx.saveStop(stop);
      }
      return;
    }
    this.core.stops.pauseMember(MAIN_AGENT_ID, 'graceful', 'system', reason).catch((e) => this.ctx.log('error', '메인 자리: 멈춘 교체의 메인 일시정지를 걸지 못했습니다', e));
  }

  /** 남은 프로세스를 확인하라는 문장 (리드 결정 S4-18) — 데스크톱은 이 PC의 작업 관리자, 서버는 서버 PC의 프로세스다(원격 대표는 그 PC를 볼 수 없을 수 있다) */
  private processCheck(): string {
    return this.ctx.deps.mode === 'server'
      ? '서버 PC에 남은 프로세스가 모두 사라졌는지 확인한 뒤(서버 PC를 직접 볼 수 없으면 서버 PC의 운영자에게 확인을 부탁하세요)'
      : '작업 관리자 등에서 남은 프로세스가 모두 사라졌는지 확인한 뒤';
  }

  /** 4~8번 — 나가는 턴은 끝났다(종료 확인). 한 호출 안에서 끝난다 */
  private finish(swap: SeatSwapRow): void {
    const ctx = this.ctx;
    if (this.core.stopping) return;
    // 4번: 메인 토큰을 모두 폐기한다 — 남은 토큰이 있어도(끝난 턴은 제 토큰을 이미 폐기했다) 앱 도구 서버가 401로 막는다. 7번 뒤로 나가는 세대의 신원은
    // 도구 처리기가 seat_changed로 막는다 (S4-4)
    const revoked = this.core.toolServer?.revokeWhere?.((identity) => identity.isMain) ?? 0;
    // 화면 도우미에도 STOP을 한 번 더 — 1번 뒤에 떠 있는 도우미가 있으면 눌린 키를 떼고 끝낸다. 새 보유자는 새 도우미를 쓴다 (4.3 4번, 리드 결정 S6-9).
    // 기다리지 않는다 — 이 정지가 끝남을 확인하지 못하면 화면 도구가 막히고 메인 에이전트가 곧바로 일시정지돼(도는 메인 턴이 없다) 새 보유자가 턴을 얻지 못한다
    // (desktop/lifecycle.ts, 리드 결정 S6-21 A1)
    void this.core.desktop.stopForSwap();
    // 5번: 열린 M-MAIN 세션(main:*·메인이 검수자인 review:*)을 한꺼번에 닫는다 — 키마다 다음 턴에 가서야 바뀌어 두 AI 종류의 세션이 섞이지 않게
    this.core.turns.closeMemberSessions(MAIN_AGENT_ID, `메인 자리 교체(세대 ${swap.to})`);
    const cur = this.row();
    const holder = cur.pendingHolder;
    if (!holder) throw new Error(`메인 자리 교체(세대 ${swap.to})에 들어올 보유자가 없습니다`);
    const previous = cur.holder;
    const now = ctx.now();
    // 6번: 인계 꾸러미 — 자리 칸 다음은 S4b(handover.ts)가 채운다
    const packet = this.packet(swap, holder, previous, cur.since, now);
    ctx.store.tx(() => {
      ctx.store.seatHandovers.put(packet);
      const h = ctx.store.seatHistory.get(seatGenerationId(swap.to));
      if (h) ctx.store.seatHistory.put({ ...h, handoverId: packet.id });
      // 7번: active — 대기열의 M-MAIN 일은 그대로 남아 새 보유자에게 간다. 이전 보유자의 응답 없음은 새 세대에 넘기지 않는다 (S4-5)
      ctx.store.seat.put({ ...cur, state: 'active', holder, since: now, pendingHolder: null, swap: null, ...NOT_UNRESPONSIVE, ...VISION_UNKNOWN });
      this.syncMainAi(holder, swap.by, `메인 자리 교체(세대 ${swap.to}) — ${swap.reason}`);
    });
    this.queueVisionCheck(`메인 자리 교체로 새 보유자 (세대 ${swap.to})`);
    // 8번: 활동 기록·메인 일지(seat)·대표 알림
    const to = holderLabel(holder);
    const from = holderLabel(previous);
    const done = `메인 자리 교체 끝: ${from} → ${to} (세대 ${swap.to}, ${CHANGED_BY_TEXT[swap.by]}) — 메인 토큰 ${revoked}개 폐기, 메인 세션을 닫고 인계 꾸러미를 만듦`;
    ctx.activity({ kind: 'seat', actor: actorOf(swap.by), text: done });
    this.core.journal.server('seat', `${done} — 까닭: ${swap.reason}`, { generation: swap.to });
    ctx.notify({
      level: 'normal',
      title: '메인 에이전트가 바뀌었습니다',
      body: `이제 ${to}${subjectJosa(to)} 메인 에이전트입니다 (세대 ${swap.to}, 이전 ${from}). ${CHANGED_BY_SENTENCE[swap.by]} — 까닭: ${swap.reason}. 쌓여 있던 명령은 새 메인 에이전트가 이어서 처리합니다`,
      // 누르면 자리 보기로 간다 (리드 결정 S4-19)
      link: { tab: 'seat' },
      key: `seat-change:${swap.to}`,
    });
    // 이 교체가 멈췄다고 한 알림('다시 정지 해제를 누르세요')은 교체가 끝나 더는 참이 아니다 — 읽지 않았으면 읽음으로 둔다. 위 '바뀌었습니다'가 그 자리를
    // 잇는다. 새 알림·활동 기록은 남기지 않는다 (리드 결정 S4-36)
    for (const n of ctx.store.notifications.list({ ref1: `seat-switch:${swap.to}`, state: 'unread' })) ctx.store.notifications.put({ ...n, readAt: now });
    ctx.bus.changed();
    ctx.bus.signal('tick');
  }

  /**
   * 6번의 꾸러미 — 자리 칸(이전 보유자·기간·까닭·바꾼 쪽)과 S4b의 칸들(handover.ts — 확인된 사실·메모·기억 문서, 12,000자 안). 저장 전에 가린다 (S4-6).
   * 기록만으로 만들므로 나가는 보유자가 한 번도 답하지 않아도 만들어진다
   */
  private packet(swap: SeatSwapRow, holder: SeatHolder, previous: SeatHolder | null, since: string | null, now: string): SeatHandoverRow {
    const redact = this.ctx.redact;
    const seat: HandoverSection = {
      key: 'seat',
      title: '자리 정보',
      unverified: false,
      lines: [
        `이전 보유자: ${holderLabel(previous)} (세대 ${swap.from}${since ? `, ${since}부터 ${now}까지` : ''})`,
        `바꾼 쪽: ${CHANGED_BY_LABEL[swap.by]}${swap.force ? ' (강제 — 마무리를 기다리지 않음)' : ''}`,
        `까닭: ${swap.reason}`,
        `새 보유자: ${holderLabel(holder)} (세대 ${swap.to})`,
      ].map((l) => redact.text(l)),
      omitted: 0,
    };
    const built = this.hooks.packetSections?.(swap, holder, seat, now);
    const sections = built?.sections ?? [seat];
    const chars = built?.chars ?? sections.reduce((n, s) => n + s.title.length + s.lines.reduce((m, l) => m + l.length + 1, 0), 0);
    return { id: seatGenerationId(swap.to), generation: swap.to, createdAt: now, holder, previous, sections, chars, note: swap.note };
  }

  private failed(swap: SeatSwapRow, e: unknown): void {
    if (this.core.stopping) return;
    this.ctx.log('error', `메인 자리 교체 실패 (세대 ${swap.from} → ${swap.to})`, e);
    this.ctx.activity({ kind: 'seat', level: 'error', text: `메인 자리 교체 중 오류 (세대 ${swap.from} → ${swap.to}): ${e instanceof Error ? e.message : String(e)} — 자리는 교체 중으로 남습니다` });
  }

  private saveSwap(swap: SeatSwapRow): SeatSwapRow {
    const cur = this.row();
    if (cur.state !== 'switching' || cur.swap?.to !== swap.to) return swap;
    // 인계 메모 턴을 띄운 것은 저장된 값에만 있다(noteMemoTurn) — 들고 있던 값으로 덮어 지우지 않는다
    const next: SeatSwapRow = { ...swap, memoTurnId: swap.memoTurnId ?? cur.swap.memoTurnId ?? null };
    this.ctx.store.seat.put({ ...cur, swap: next });
    return next;
  }

  /** 진행 중인 교체가 끝날 때까지 (시험·종료용) */
  settled(): Promise<void> {
    return this.job ?? Promise.resolve();
  }

  // ───────────────────────── 응답 없음 (4.4, 리드 결정 S4-5) ─────────────────────────

  /**
   * 메인 턴이 끝났다 (TurnRunner.finish, 턴 기록 전 시작 실패) — 응답 없음을 센다. 앉은 세대의 턴만 본다(교체 중 나가는 턴·인계 메모 턴은 보지 않는다).
   * 긴급 정지 중이거나 정지로 끝난 턴(user_stop — 긴급 정지·일시정지·교체가 멈춘 것)은 세지 않는다. 정상으로 끝나면(completed) 보유자가 다시 답한 것이라
   * 응답 없음을 비운다. 시작 실패·사용량 한도·재로그인 필요로 연달아 3번 끝나면 그때부터 응답 없음이다. 그 밖의 끝(비정상 종료·시간 상한 등)은 '연달아'를
   * 끊지만, 이미 시작된 응답 없음은 정상으로 끝난 턴만 비운다
   */
  noteMainTurnEnd(generation: number | null, reason: TurnEndReason): void {
    try {
      const s = this.row();
      if (s.state !== 'active' || s.holder?.kind !== 'launched' || generation !== s.generation) return;
      if (reason === 'user_stop' || this.ctx.stop().global.active) return;
      if (reason === 'completed') {
        this.answered(s);
        return;
      }
      const streak = UNRESPONSIVE_END[reason] ? [...(s.unresponsiveStreak ?? []), reason].slice(-UNRESPONSIVE_STREAK) : [];
      if (!s.unresponsiveSince && streak.length === UNRESPONSIVE_STREAK) {
        const labels = [...new Set(streak.map((r) => UNRESPONSIVE_END[r as TurnEndReason]!))];
        const why =
          labels.length === 1
            ? `${labels[0]}${instrumentalJosa(labels[0]!)} 메인 턴이 ${UNRESPONSIVE_STREAK}번 연달아 끝났습니다`
            : `메인 턴이 ${UNRESPONSIVE_STREAK}번 연달아 ${labels.join('·')}${instrumentalJosa(labels.at(-1)!)} 끝났습니다`;
        this.becameUnresponsive({ ...s, unresponsiveStreak: streak }, why);
        return;
      }
      if ((s.unresponsiveStreak ?? []).join(',') !== streak.join(',')) this.ctx.store.seat.put({ ...s, unresponsiveStreak: streak });
    } catch (e) {
      if (!this.core.stopping) this.ctx.log('warn', '메인 자리: 메인 턴의 끝으로 응답 없음을 세지 못했습니다', e);
    }
  }

  /**
   * 스케줄러가 돌 때마다 (Scheduler.runOnce — 긴급 정지 중에는 돌지 않는다): ① 메인 일이 쌓였는데 그 AI 종류를 쓸 수 없으면(재로그인 필요·사용량 한도 대기·
   * CLI-15의 시작 정지) 응답 없음을 센다 ② 응답 없음이 5분·30분·2시간을 넘기면 대표에게 다시 알린다. 서버는 자리를 바꾸지 않는다 (대표 결정 '넘기지 않는다').
   * 실패해도 스케줄러를 막지 않게 기록만 한다
   */
  watch(): void {
    try {
      const s = this.row();
      if (s.state !== 'active' || s.holder?.kind !== 'launched' || this.ctx.stop().global.active) return;
      if (s.unresponsiveSince) {
        this.remind(s);
        return;
      }
      const blocked = this.mainBlocked(s.holder);
      if (blocked) this.becameUnresponsive(s, blocked);
    } catch (e) {
      if (!this.core.stopping) this.ctx.log('warn', '메인 자리: 응답 없음을 확인하지 못했습니다', e);
    }
  }

  /**
   * 긴급 정지를 푼 뒤 (StopService.release): 정지한 동안은 세지 않는다 — 응답 없음을 처음 본 때를 정지한 시간만큼 뒤로 민다. 그래서 보이는 시간과 5분·30분·
   * 2시간 알림은 정지하지 않은 시간만 센다 (S4-5). 정지한 동안에는 그 때를 그대로 둔다
   */
  afterStopRelease(stoppedSince: string | null, releasedAt: string): void {
    const s = this.row();
    if (!s.unresponsiveSince || !stoppedSince) return;
    const paused = Date.parse(releasedAt) - Math.max(Date.parse(stoppedSince), Date.parse(s.unresponsiveSince));
    if (!(paused > 0)) return;
    this.ctx.store.seat.put({ ...s, unresponsiveSince: new Date(Date.parse(s.unresponsiveSince) + paused).toISOString() });
    this.ctx.bus.changed();
  }

  /** 응답 없음이 이어진 시간 (ms, 긴급 정지한 시간은 세지 않는다 — silentMs) — 응답하면 null */
  unresponsiveForMs(): number | null {
    return this.silentMs(this.row());
  }

  /**
   * 응답 없음이 이어진 시간 (ms) — 시간을 재거나 글에 남기는 곳은 모두 이것을 쓴다 (리드 결정 S4-17): 운영자 배정의 까닭(이력·꾸러미·알림·일지), seat status,
   * 다시 알림, 다시 응답함. 긴급 정지 중이면 지금이 아니라 정지가 시작된 때(응답 없음이 그 뒤에 시작됐으면 그때)에서 끊는다 — 정지한 시간은 세지 않는다.
   * 해제 때는 afterStopRelease가 시작 때를 정지한 만큼 뒤로 미므로 그대로 이어진다 (S4-5). 응답 없음이 아니면 null
   */
  private silentMs(s: MainSeatRow): number | null {
    if (!s.unresponsiveSince) return null;
    const since = Date.parse(s.unresponsiveSince);
    const stop = this.ctx.stop().global;
    const now = this.ctx.clock.ms();
    const end = stop.active && stop.since ? Math.max(since, Date.parse(stop.since)) : now;
    return Math.max(0, end - since);
  }

  /**
   * 메인 일이 쌓였는데 그 AI 종류를 쓸 수 없는지 — 스케줄러와 같은 허용 검사(entryRunGate)로 본다. 하나라도 띄울 수 있으면 아니다. 띄울 수 없는 까닭이 AI
   * 종류(재로그인 필요·사용량 한도·CLI 확인)일 때만 그 글을 돌려준다 (일시정지·보류로 기다리는 일은 보유자의 응답과 상관없다)
   */
  private mainBlocked(holder: Extract<SeatHolder, { kind: 'launched' }>): string | null {
    const ctx = this.ctx;
    const member = ctx.store.members.get(MAIN_AGENT_ID);
    const entries = ctx.store.queue.list({ ref1: MAIN_AGENT_ID, state: 'queued' }).filter((q) => !q.ownerShared);
    if (!member || !entries.length) return null;
    const stop = ctx.stop();
    const nowMs = ctx.clock.ms();
    let detail: string | null = null;
    for (const e of entries) {
      // 작업·검수 세션의 작업 (records.parseKey와 같은 키 모양 — 운영자 명령 줄이 이 파일을 읽으므로 업무 모듈을 끌어오지 않는다)
      const [prefix, ref = ''] = e.sessionKey.split(':', 2);
      const task = prefix === 'review' || prefix === 'task' ? (ctx.store.tasks.get(ref) ?? null) : null;
      const gate = this.core.turns.entryRunGate(member, e.sessionKey, task, e, stop, nowMs);
      if (gate.ok) return null;
      if (AI_BLOCKS.has(gate.block)) detail ??= gate.detail;
    }
    if (!detail) return null;
    const label = AI_LABEL[holder.ai.kind];
    return `${label}${objectJosa(label)} 쓸 수 없어 메인 일이 쌓여 있습니다 — ${detail}`;
  }

  /** 응답 없음을 센다 — 그 때와 까닭을 자리에 적고, 활동 기록·메인 일지·운영자 기록에 남긴다. 대표 알림은 5분부터 (remind) */
  private becameUnresponsive(s: MainSeatRow, why: string): void {
    const ctx = this.ctx;
    const reason = clip(ctx.redact.text(why), 300);
    ctx.store.seat.put({ ...s, unresponsiveSince: ctx.now(), unresponsiveReason: reason, unresponsiveNotices: 0 });
    const label = holderLabel(s.holder);
    const text = `메인 에이전트 응답 없음: ${label} (세대 ${s.generation}) — ${reason}. 서버는 메인 자리를 바꾸지 않습니다`;
    ctx.activity({ kind: 'seat', level: 'warn', text });
    this.core.journal.server('seat', text, { generation: s.generation });
    ctx.log('warn', `${text} — 바꾸려면 ${this.operatorExit()}`);
    ctx.bus.changed();
  }

  /** 응답 없음이 5분·30분·2시간을 넘겼으면 대표에게 알린다 (key seat-unresponsive:<세대>). 한 번에 여러 때를 넘겼으면 한 번만, 지금 시간으로 */
  private remind(s: MainSeatRow): void {
    const ctx = this.ctx;
    const elapsed = this.silentMs(s) ?? 0;
    const due = SEAT_UNRESPONSIVE_NOTICE_MS.filter((ms) => elapsed >= ms).length;
    if (due <= (s.unresponsiveNotices ?? 0)) return;
    ctx.store.seat.put({ ...s, unresponsiveNotices: due });
    const label = holderLabel(s.holder);
    const dur = seatDurationText(elapsed) ?? '1분';
    const desktop = ctx.deps.mode !== 'server';
    ctx.notify({
      level: 'normal',
      title: '메인 에이전트 응답 없음',
      body:
        `메인 에이전트 ${label}(세대 ${s.generation})${subjectJosa(label)} ${dur}째 응답하지 않습니다 — ${s.unresponsiveReason ?? '까닭을 알 수 없습니다'}. ` +
        '서버는 메인 자리를 다른 AI에게 넘기지 않습니다. 명령은 그대로 보내셔도 됩니다 — 쌓아 두었다가 메인 에이전트가 돌아오면 이어서 처리합니다. 급하면 긴급 정지를 누르세요. ' +
        (desktop ? '메인 자리를 다른 AI에게 넘기는 것은 이 PC의 운영자가 운영 설정의 메인 AI로 합니다' : '메인 자리를 다른 AI에게 넘기는 것은 서버 PC의 운영자만 할 수 있습니다(wook-server seat assign)'),
      // 누르면 자리 보기로 간다 (리드 결정 S4-19)
      link: { tab: 'seat' },
      key: `seat-unresponsive:${s.generation}`,
    });
    ctx.log('warn', `메인 에이전트 응답 없음 ${dur}째: ${label} (세대 ${s.generation}) — 대표에게 알림. 바꾸려면 ${this.operatorExit()}`);
  }

  /** 정상으로 끝난 메인 턴 — 보유자가 다시 답했다. 응답 없음과 센 것을 비운다. 대표에게 알렸던 응답 없음이면 같은 key로 다시 응답한다고 알린다 */
  private answered(s: MainSeatRow): void {
    const ctx = this.ctx;
    if (!s.unresponsiveSince) {
      if (s.unresponsiveStreak?.length) ctx.store.seat.put({ ...s, unresponsiveStreak: [] });
      return;
    }
    const lasted = seatDurationText(this.silentMs(s) ?? 0);
    ctx.store.seat.put({ ...s, ...NOT_UNRESPONSIVE });
    const label = holderLabel(s.holder);
    const text = `메인 에이전트가 다시 응답함: ${label} (세대 ${s.generation}, 응답 없음 ${lasted ?? '1분 미만'}) — 쌓인 일을 이어서 처리합니다`;
    ctx.activity({ kind: 'seat', text });
    this.core.journal.server('seat', text, { generation: s.generation });
    if (s.unresponsiveNotices) {
      ctx.notify({
        level: 'info',
        title: '메인 에이전트가 다시 응답합니다',
        body: `메인 에이전트 ${label}(세대 ${s.generation})${subjectJosa(label)} ${lasted ? `${lasted} 만에` : '1분 안에'} 다시 응답했습니다. 쌓여 있던 명령을 이어서 처리합니다`,
        // 같은 key의 읽지 않은 '응답 없음' 알림을 이 글로 바꾸므로 갈 곳도 같게 둔다 — 자리 보기 (S4-19)
        link: { tab: 'seat' },
        key: `seat-unresponsive:${s.generation}`,
      });
    }
    ctx.bus.changed();
  }

  /** 운영자가 자리를 바꾸는 길 (기록 글) — 서버는 관리 채널 seat assign, 데스크톱은 운영 설정의 메인 AI (S4-8·S4-9) */
  private operatorExit(): string {
    return this.ctx.deps.mode === 'server' ? '운영자가 wook-server seat assign <보유자>로 배정합니다' : '이 PC의 운영자가 운영 설정에서 메인 AI를 바꿉니다';
  }

  // ───────────────────────── 운영자 (서버 관리 채널, 리드 결정 S4-8) ─────────────────────────

  /**
   * 운영자 배정 (`wook-server seat assign <보유자> [--force]`) — 바꾼 쪽 operator로 assign을 거친다. 보유자 표기는 launched:claude·launched:codex(외부는
   * 7단계 전까지 거부 — S4-1). 서버가 띄우는 보유자의 AI 설정은 처음 보유자와 같은 규칙이다: 지금 보유자와 같은 종류면 그 설정, 아니면 그 종류의 CLI 기본
   * 모델과 같은 노력치 단계. force면 실행 중인 메인 턴을 바로 멈추고 마무리·인계 메모 턴을 건너뛴다. 모양이 틀린 표기는 되풀이하지 않는다 (S3-39)
   */
  operatorAssign(spec: string, force: boolean): SeatAssignResult {
    const parsed = parseHolderSpec(spec);
    if (!parsed) throw new BackendError('invalid_args', SEAT_HOLDER_SHAPE);
    if (parsed.kind === 'any_external') {
      throw new BackendError('invalid_args', 'external:*는 앉을 수 있는 보유자 목록(seat.holders)에 쓰는 표기입니다 — 앉힐 보유자 하나를 적으세요 (launched:claude·launched:codex)');
    }
    const s = this.row();
    let holder: SeatHolder;
    if (parsed.kind === 'external') {
      holder = { kind: 'external', agentId: parsed.agentId, label: parsed.agentId };
    } else {
      const cur = s.holder?.kind === 'launched' ? s.holder.ai : this.ctx.settings().general.mainAgent;
      holder = { kind: 'launched', ai: parsed.ai === cur.kind ? { ...cur } : { kind: parsed.ai, model: null, effortTier: cur.effortTier, effortOverride: null } };
    }
    // 긴급 정지 중의 복구 배정이어도 정지한 시간은 넣지 않는다 — 이 글은 이력·꾸러미·알림·일지에 그대로 남는다 (S4-17)
    const silentFor = this.silentMs(s);
    const silent = silentFor === null ? null : seatDurationText(silentFor);
    const why = `운영자 복구 배정 (wook-server seat assign${force ? ' --force' : ''})${s.unresponsiveSince ? ` — 이전 보유자가 ${silent ? `${silent}째 ` : ''}응답하지 않음` : ''}`;
    return this.assign({ holder, by: 'operator', reason: why, force });
  }

  /** 운영자 `seat status` — 보기만 한다: 지금 자리, 응답 없음이 이어진 시간, 진행 중인 교체, 자리 정책, 최근 이력 5줄 */
  operatorStatus(): SeatOperatorStatus {
    const swap = this.row().swap;
    return {
      seat: this.view(),
      unresponsiveForMs: this.unresponsiveForMs(),
      swap: swap ? { from: swap.from, to: swap.to, by: swap.by, force: swap.force, stage: swap.stage, requestedAt: swap.requestedAt } : null,
      policy: this.policy(),
      history: this.history().slice(0, 5),
    };
  }

  // ───────────────────────── 도움 ─────────────────────────

  private normalized(h: SeatHolder): SeatHolder {
    if (h.kind === 'external') return { kind: 'external', agentId: h.agentId.trim(), label: h.label.trim() || h.agentId.trim() };
    if (!AI_KINDS.includes(h.ai.kind)) throw new BackendError('invalid', `AI 종류는 ${AI_KINDS.join('·')} 중 하나여야 합니다`);
    return { kind: 'launched', ai: { kind: h.ai.kind, model: h.ai.model?.trim() || null, effortTier: h.ai.effortTier, effortOverride: h.ai.effortOverride || null } };
  }

  /**
   * 넘길 수 있는 보유자인지 — 서버가 띄우는 CLI는 설치되고 로그인돼 있어야 한다 (4.3 '지금 쓸 수 있는 보유자'). 모의 메인 실행(개발자 옵션)은 CLI를 쓰지
   * 않으므로 보지 않는다 — 요청이 모의 실행 값을 함께 바꾸면 바뀐 값으로 본다(mock, S4-28). 쓸 수 없으면 그 까닭
   */
  private unavailable(h: SeatHolder, mock = this.ctx.settings().developer.mainAgentMock): string | null {
    if (h.kind === 'external') return SEAT_EXTERNAL_LATER;
    if (mock) return null;
    const a = this.ctx.ai(h.ai.kind);
    if (!a.cliInstalled) return `${AI_LABEL[h.ai.kind]}${subjectJosa(AI_LABEL[h.ai.kind])} ${this.ctx.deps.mode === 'server' ? '서버 PC' : '이 PC'}에 설치되지 않았습니다`;
    if (a.cliProblem) return `${AI_LABEL[h.ai.kind]}를 지금 쓸 수 없습니다 (${clip(a.cliProblem, 160)})`;
    if (a.authRequired) return `${AI_LABEL[h.ai.kind]}에 로그인돼 있지 않습니다 (재로그인 필요)`;
    return null;
  }

  /**
   * 쓸 수 없는 보유자로 바꾸려는 요청의 거부 글 (리드 결정 S4-15) — 부른 쪽이 한 일을 말한다: 메인의 hand_off_seat는 '넘길 수 없습니다', 운영자는 데스크톱이면
   * 운영 설정의 메인 AI를 '바꿀 수 없습니다', 서버면 seat assign의 '배정할 수 없습니다'. 운영자 글에는 그 독자에게 실제로 있는 출구만 붙인다 — 데스크톱은 이 PC에서
   * 고친 뒤 설치 설정 'CLI 준비 상태'의 '다시 확인', 서버는 서버 PC에서 고친 뒤 CLI 상태를 다시 확인하는 것(서버를 다시 시작하면 시작할 때 확인한다)
   */
  private unavailableRefusal(by: SeatChanger, h: SeatHolder, why: string): string {
    const label = holderLabel(h);
    if (by !== 'operator' || h.kind !== 'launched') return `${label}에게 메인 자리를 넘길 수 없습니다 — ${why}`;
    const a = this.ctx.ai(h.ai.kind);
    const fix = !a.cliInstalled ? `${label}${objectJosa(label)} 설치한` : a.cliProblem ? `${label}의 문제를 고친` : `${label}에 로그인한`;
    return this.ctx.deps.mode === 'server'
      ? `${label}에게 메인 자리를 배정할 수 없습니다 — ${why}. 서버 PC에서 ${fix} 뒤 CLI 상태를 다시 확인하면 배정할 수 있습니다. 서버를 다시 시작하면 시작할 때 확인하고, 대표 화면 설치 설정의 'CLI 준비 상태'에서 '다시 확인'을 눌러도 됩니다`
      : `메인 AI를 ${label}${instrumentalJosa(label)} 바꿀 수 없습니다 — ${why}. 이 PC에서 ${fix} 뒤 설치 설정의 'CLI 준비 상태'에서 '다시 확인'을 누르고 다시 바꾸세요`;
  }

  /** M-MAIN의 AI와 운영 설정의 메인 AI를 보유자에 맞춘다 (트랜잭션 안에서 부른다) */
  private syncMainAi(h: SeatHolder, by: SeatChanger, why: string): void {
    if (h.kind !== 'launched') return;
    const ctx = this.ctx;
    const now = ctx.now();
    const m = ctx.store.members.get(MAIN_AGENT_ID);
    if (m && !sameAi(m.ai, h.ai)) ctx.store.members.put({ ...m, ai: { ...h.ai }, pendingAi: null, aiDecision: { by: actorOf(by), reason: clip(why, 300), at: now }, updatedAt: now });
    const s = ctx.settings();
    if (!sameAi(s.general.mainAgent, h.ai)) ctx.saveSettings({ ...s, general: { ...s.general, mainAgent: { ...h.ai } } });
  }
}

function actorOf(by: SeatChanger): Actor {
  return by === 'main' ? MAIN_AGENT_ID : by === 'operator' ? OPERATOR : 'system';
}

/**
 * 운영자 설정의 seat 값 확인 (server.json, S4-12) — 시작의 미리 보기와 config reload가 같은 확인을 쓴다. 틀리면 그 칸을 말하는 글, 맞으면 null.
 * 외부 보유자를 처음 보유자로 둘 수는 없다 (S4-1)
 */
export function seatConfigProblem(v: { initialHolder: string | null; holders: string[] | null; drainMs: number | null }, origin: string): string | null {
  if (v.holders) {
    if (!v.holders.length) return `${origin}의 seat.holders가 비었습니다 — 앉을 수 있는 보유자(launched:claude·launched:codex 등)를 하나 이상 넣으세요`;
    const bad = v.holders.find((h) => !parseHolderSpec(h));
    if (bad !== undefined) return `${origin}의 seat.holders에 모르는 보유자가 있습니다 — launched:claude·launched:codex·external:*·external:<ID>만 씁니다`;
    if (!v.holders.some((h) => parseHolderSpec(h)?.kind === 'launched')) return `${origin}의 seat.holders에 서버가 띄우는 보유자(launched:claude·launched:codex)가 없습니다 — ${SEAT_EXTERNAL_LATER}`;
  }
  if (v.drainMs !== null && (!Number.isInteger(v.drainMs) || v.drainMs < 0 || v.drainMs > SEAT_DRAIN_MAX_MS)) {
    return `${origin}의 seat.drainMs는 0~${SEAT_DRAIN_MAX_MS}의 정수(밀리초)여야 합니다`;
  }
  if (v.initialHolder !== null) {
    const spec = parseHolderSpec(v.initialHolder);
    if (!spec || spec.kind === 'any_external') return `${origin}의 seat.initialHolder는 launched:claude나 launched:codex여야 합니다`;
    if (spec.kind === 'external') return `${origin}의 seat.initialHolder(${v.initialHolder}) — ${SEAT_EXTERNAL_LATER}. 지금은 launched:claude나 launched:codex를 넣으세요`;
    if (v.holders && !v.holders.includes(v.initialHolder.trim())) return `${origin}의 seat.initialHolder(${v.initialHolder})가 seat.holders에 없습니다`;
  }
  return null;
}
