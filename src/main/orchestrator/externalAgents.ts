/**
 * 외부 에이전트 (SERVER_DESIGN 4.1·4.5, 리드 결정 S7-2·S7-3·S7-4).
 *
 * 등록 기록 (7단계 S7a — 이 파일의 위쪽):
 * - 등록·폐기는 서버 PC의 운영자만 한다 (관리 채널 `agent.add|revoke` — wook-server agent add --label <이름> | revoke <ID>). 대표는 목록만 본다(agents.list).
 *   메인 에이전트의 도구에는 등록·폐기가 없다
 * - 키는 `wsk_` + 32바이트 base64url. 원문은 add의 반환값으로 한 번만 나가고(운영자 명령의 표준 출력), DB에는 sha256만 둔다. 활동 기록(auth, 행위자
 *   operator)·서버 기록·메인 일지에는 키가 없다. 백엔드 가리개는 낼 때와 이 실행에서 처음 인증할 때 키를 등록 값으로 넣는다 — 다시 시작한 서버는 해시만
 *   있으므로 첫 인증이 넣는다. `wsk_` 모양 규칙(core/redact.ts)이 그 밖을 덮는다
 * - 이름은 1~40자, 제어·서식 문자 없이, 폐기하지 않은 에이전트끼리 겹치지 않는다(NFC·대소문자 무시). 거부 글은 적은 이름을 되풀이하지 않는다 (S3-39)
 * - 폐기는 되풀이해도 된다(이미 폐기됐으면 바꾸지 않고 already). 메인 자리에 앉은 에이전트를 폐기해도 서버는 자리를 바꾸지 않는다 — 응답 없음이 된다 (S7-4)
 * - 쓸 수 있는 외부 보유자 = 등록돼 있고 폐기되지 않은 에이전트 (운영자 배정·hand_off_seat·처음 보유자가 같은 판정 — seat.ts가 부른다, S7-4)
 *
 * 이음매: authenticate(키 → 에이전트, 마지막 접속), hooks.onRevoked(폐기 때 임대·턴 토큰을 거두고 응답 없음으로), 임대는 메인 자리 한 줄의
 * lease 칸(db/store.ts SeatLeaseRow)에 둔다 — list()의 connected가 그것을 읽는다
 *
 * 임대·일 받기 (7단계 S7b — 이 파일의 아래쪽, 리드 결정 S7-3·S7-4): 지금 살아 있는 임대는 메인 자리 보유자의 것 하나다(메모리가 기준, 자리 한 줄의 lease 칸이 사본).
 * claim은 배정된 에이전트만(키만으로는 못 앉는다), 같은 에이전트의 다시 claim은 앞 임대를 끝내고 그 턴을 비정상 종료로 다시 넣는다. 임대를 싣는 요청마다 늘리고, 끝나면
 * (heartbeat 없음·스스로 물러남·폐기) 돌던 턴을 비정상 종료로 다시 넣고 자리를 응답 없음으로 — 서버는 자리를 바꾸지 않는다. 일은 스케줄러가 고르고(seat.externalReady)
 * TurnRunner의 외부 갈래가 받아 둔 롱폴로 넘긴다(takePoll — 턴 기록 바로 앞 같은 동기 구간). 긴급 정지는 임대와 외부 턴 토큰을 모두 폐기한다(discardAll).
 * HTTP는 src/server/agentApi.ts가 맡고 agentBackendOf가 그 백엔드 쪽이다
 */
import { createHash, randomBytes } from 'node:crypto';
import { MAIN_AGENT_ID, OPERATOR, type Actor, type TurnEndReason } from '@shared/domain';
import type { ParsedCliEvent } from '@shared/events';
import { TURN_END_LABEL } from '@shared/labels'; // S7F1b (F3 — turnOf의 끝 까닭 이름)
import type { EmergencySummary, ExternalAgentView } from '@shared/views';
import { REDACT_KINDS } from '@core/redact';
import { BackendError, type AgentBackend, type ExternalAgentGrant, type ExternalAgentRevokeReport } from '../backend/types';
import type { ExternalAgentRow, MainSeatRow, SeatLeaseRow } from '../db/store';
import type { ExitInfo, ManagedProcess, TerminateResult } from '../process/types';
import type { ToolCallResult } from '../mcp/types';
import type { ClaimReply, HeartbeatReply, SeatReply, WorkItem } from '../../server/agentApiTypes';
import type { Core } from './core';
import { holderLabel, subjectJosa } from './seat';

/** 에이전트 키의 모양 — `wsk_` + 32바이트 base64url(43자) */
export const AGENT_KEY_RE = /^wsk_[A-Za-z0-9_-]{43}$/;
/** 에이전트 ID의 모양 ('X-0001' — core/ids.ts external_agent) */
export const AGENT_ID_RE = /^X-\d{4,9}$/;
/** agent revoke 뒤의 ID 모양이 틀렸을 때 — 적은 값은 되풀이하지 않는다 (S3-39) */
export const AGENT_ID_SHAPE = '외부 에이전트 ID는 X-0001 꼴입니다 (wook-server agent list로 확인합니다). 적은 값은 보이지 않습니다';
/** 이름 글자 수 상한 (코드 포인트) */
export const AGENT_LABEL_MAX = 40;
/** 마지막 접속을 DB에 다시 적기까지의 간격 — 요청마다 쓰지 않는다. 그 사이 값은 메모리에 있고 목록이 그것을 보인다 */
export const AGENT_SEEN_WRITE_MS = 30_000;

/** 이름에 넣지 않는 글자 — 제어 문자(Cc)·서식 문자(Cf: 방향 바꿈·폭 없는 글자 등)·줄·문단 나눔 */
const LABEL_BAD_CHAR = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/** 키 원문의 해시 (sha256 16진수) — DB에 두는 것은 이것뿐이다 */
export function agentKeyHash(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

/** 새 키 `wsk_` + 32바이트 base64url */
function newAgentKey(): string {
  return `wsk_${randomBytes(32).toString('base64url')}`;
}

/** 이름이 겹치는지 견주는 열쇠 — NFC로 맞추고 대소문자를 가리지 않는다 */
const labelKey = (label: string): string => label.normalize('NFC').toLowerCase();

/** 이름의 문제 (없으면 null) — 적은 이름은 글에 넣지 않는다 (S3-39). 앞뒤 공백은 부르는 쪽이 지운다 */
export function agentLabelProblem(label: string): string | null {
  const n = [...label].length;
  if (n === 0) return '외부 에이전트 이름이 비었습니다 — --label 뒤에 1~40자의 이름을 적으세요';
  if (n > AGENT_LABEL_MAX) return `외부 에이전트 이름은 ${AGENT_LABEL_MAX}자까지입니다 (${n}자) — 적은 이름은 보이지 않습니다`;
  if (LABEL_BAD_CHAR.test(label)) return '외부 에이전트 이름에 제어 문자(줄바꿈·탭·보이지 않는 서식 글자 등)를 넣을 수 없습니다 — 적은 이름은 보이지 않습니다';
  return null;
}

// ───────────────────────── 임대·일 받기 (7단계 S7b, 리드 결정 S7-3·S7-4) ─────────────────────────

/** 임대·롱폴의 기본값 (agentApiTypes.ts와 같은 값 — 시험은 timing.agentLeaseMs·agentPollMaxMs로 줄인다) */
export const AGENT_LEASE_DEFAULT_MS = 60_000;
export const AGENT_HEARTBEAT_DEFAULT_MS = 15_000;
export const AGENT_POLL_DEFAULT_MS = 25_000;
/** 임대가 끝났는지 따로 보는 간격 (스케줄러 차례마다도 본다) */
const AGENT_SWEEP_MS = 5_000;
/** 끝난 임대를 기억하는 수 — 늦게 온 heartbeat에 왜 끝났는지(seat_changed·lease_superseded·lease_expired) 말해 준다 */
const ENDED_LEASES_KEPT = 64;
/** 임대의 끝나는 때를 DB에 다시 적는 간격 — 요청마다 쓰지 않는다 (메모리 값이 기준, DB는 목록의 '연결됨'용) */
const LEASE_WRITE_STEP_MS = 1_000;

/**
 * 외부 보유자의 턴을 멈춘 결과 (리드 결정 S7-4) — 턴 토큰과 임대를 폐기했고, 그 에이전트 프로세스가 끝났는지는 알 수 없다. 턴 기록의 killDetail, 긴급 정지 요약의
 * failures 줄이 이 글이다
 */
export const EXTERNAL_STOP = '외부 메인 에이전트: 턴 토큰과 임대를 폐기함 — 프로세스 종료는 확인할 수 없음 (종료 확인 불가)';
/** 같은 에이전트의 다시 claim (옛 임대의 턴을 끝내는 까닭) */
export const EXTERNAL_RECLAIM = '같은 에이전트가 자리를 다시 요청함';
/** 스스로 물러남 (seat/release) */
export const EXTERNAL_RELEASED = '외부 에이전트가 스스로 물러남';
/** 키 폐기 (wook-server agent revoke) */
export const EXTERNAL_REVOKED = '키가 폐기됨 (운영자)';
/** 긴급 정지 중의 거부 — 대표가 풀어야 다시 잡는다 */
export const EXTERNAL_STOPPED = '긴급 정지 중입니다 — 임대와 턴 토큰을 폐기했습니다. 대표가 정지를 풀면 다시 claim하세요';

/** 1.5초·60초 같은 글 */
function secondsText(ms: number): string {
  const s = Math.round(ms / 100) / 10;
  return `${Number.isInteger(s) ? s.toFixed(0) : s}초`;
}

/** 임대가 끝나 턴을 끝내는 글과 자리의 응답 없음 까닭 */
export function leaseExpiredText(leaseMs: number): string {
  return `외부 에이전트 임대 만료 — ${secondsText(leaseMs)} 동안 heartbeat 없음`;
}

type LeaseEnd = 'superseded' | 'expired' | 'released' | 'revoked' | 'stopped' | 'seat_changed';
type WorkItemData = Omit<WorkItem, 'ok'>;
type PollOutcome = { kind: 'work'; item: WorkItemData } | { kind: 'none' } | { kind: 'refused'; code: string; message: string };

interface LivePoll {
  settled: boolean;
  settle(o: PollOutcome): void;
}

interface LiveLease {
  agentId: string;
  label: string;
  leaseHash: string;
  generation: number;
  claimedAt: string;
  heartbeatAt: string;
  expiresAtMs: number;
  /** 열린 롱폴 (work/next) — 한 에이전트에 하나. 새 롱폴은 옛 것에 204를 준다 */
  poll: LivePoll | null;
  /** 이 임대가 받아 간 턴 — 끝날 때까지 같은 일(WorkItem)을 다시 준다 (잃어버린 응답이 두 턴을 만들지 않게) */
  turn: { turnId: string; item: WorkItemData; run: ExternalRun } | null;
  /** 이 임대가 받아 간 턴 가운데 실행이 끝난 마지막 것 — 마무리 중에 다시 온 finish·progress에 '마무리 중'이라고 답한다 (리드 결정 S7-17 F3) */
  endedTurnId?: string;
}

const leaseKey = (leaseId: string): string => createHash('sha256').update(leaseId, 'utf8').digest('hex');

/**
 * 외부 보유자의 한 턴 (리드 결정 S7-4 — ManagedProcess를 따른다): 진행(progress) → 이벤트, 마침(finish) → 마지막 답·result·끝 코드(완료 0, 실패 1 — 비정상
 * 종료 규칙). 멈춤(terminate)은 턴 토큰을 폐기하고 끝난 것으로 풀며 늘 확인한 것으로 답한다 — 그 에이전트 프로세스가 끝났는지는 알 수 없고(그 사실은 글로 적는다),
 * 그 권한은 그 자리에서 거뒀으므로 CTL-11의 멈춤·교체 보류를 걸지 않는다
 */
export class ExternalRun implements ManagedProcess {
  readonly pid = null;
  readonly childPid = Promise.resolve(null);
  readonly exited: Promise<ExitInfo>;
  private resolveExit!: (e: ExitInfo) => void;
  private done = false;
  private readonly t0 = Date.now();
  /** TurnRunner가 잇는다 — 이벤트(가리기·기록·화면 푸시) */
  sink: ((events: ParsedCliEvent[]) => void) | null = null;
  /** TurnRunner가 잇는다 — 마지막 답 (빈 글이면 null) */
  onFinal: ((text: string | null) => void) | null = null;
  /** 끝날 때 (마침·멈춤) — 턴 토큰 폐기, 임대의 턴 지우기 */
  onEnd: (() => void) | null = null;

  constructor() {
    this.exited = new Promise((r) => (this.resolveExit = r));
  }

  get ended(): boolean {
    return this.done;
  }
  onStdoutLine(): void {
    // 외부 턴에는 표준 출력이 없다 — 진행은 progress로 온다
  }
  onStderrLine(): void {
    // 외부 턴에는 표준 오류가 없다
  }
  progress(text: string): void {
    if (this.done) return;
    this.sink?.([{ kind: 'text', text }]);
  }
  finish(finalText: string, outcome: 'completed' | 'failed'): void {
    if (this.done) return;
    this.sink?.([{ kind: 'result', text: finalText, data: { isError: outcome === 'failed' } }]);
    this.onFinal?.(finalText.trim() ? finalText : null);
    this.exit(outcome === 'completed' ? 0 : 1, false);
  }
  async terminate(): Promise<TerminateResult> {
    if (!this.done) this.exit(null, true);
    return { ok: true, remaining: 0, detail: EXTERNAL_STOP, durationMs: 0 };
  }
  private exit(code: number | null, terminated: boolean): void {
    this.done = true;
    try {
      this.onEnd?.();
    } finally {
      this.resolveExit({ code, signal: null, leftoverKilled: 0, remaining: 0, durationMs: Date.now() - this.t0, terminated });
    }
  }
}

export interface ExternalAgentHooks {
  /**
   * 폐기한 뒤 (같은 호출 안, 트랜잭션 밖) — S7b: 그 에이전트의 임대와 턴 토큰(revokeWhere(externalAgentId))을 거두고, 앉아 있으면 자리를 곧바로 응답 없음으로
   * ('키가 폐기됨 (운영자)'). 실패해도 폐기는 그대로다 (기록만 한다)
   */
  onRevoked?: (row: ExternalAgentRow) => void;
}

export class ExternalAgents {
  /** 폐기 뒤 정리 — 기본은 이 파일의 afterRevoke (임대·턴 토큰을 거두고 앉은 자리를 곧바로 응답 없음으로, 리드 결정 S7-15 7) */
  hooks: ExternalAgentHooks = { onRevoked: (row) => this.afterRevoke(row) };
  /** 이 실행에서 키를 백엔드 가리개에 넣은 에이전트 (낼 때·첫 인증 때 한 번) */
  private readonly secretsAdded = new Set<string>();
  /** 마지막 접속 (메모리 — DB에는 AGENT_SEEN_WRITE_MS 간격으로 적는다) */
  private readonly seenAt = new Map<string, string>();
  /** 지금 살아 있는 임대 — 메인 자리 보유자의 것 하나뿐이다 (자리 한 줄의 lease 칸이 그 사본) */
  private lease: LiveLease | null = null;
  /** 끝난 임대 (해시 → 왜 끝났나) — 늦게 온 요청에 참인 까닭을 말한다 */
  private readonly ended = new Map<string, { agentId: string; generation: number; end: LeaseEnd }>();
  /**
   * 외부 보유자가 임대 없이 기다린 때의 시작 — 서버 시작(임대는 시작 때 비운다)·긴급 정지(폐기)·그 해제. 앉은 때(since)와 이것 가운데 늦은 때부터 임대 시간 안에 claim하지
   * 않으면 응답 없음이다 (리드 결정 S7-4 '한 번도 claim하지 않은 보유자는 since + 60초부터')
   */
  private noLeaseSinceMs: number;
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(private readonly core: Core) {
    this.noLeaseSinceMs = core.ctx.clock.ms();
  }

  private get ctx() {
    return this.core.ctx;
  }

  // ───────────────────────── 운영자 (관리 채널) ─────────────────────────

  /** 등록 (agent add) — 새 ID와 키. 키 원문은 이 반환값에만 있다 */
  add(rawLabel: string): ExternalAgentGrant {
    const ctx = this.ctx;
    const label = typeof rawLabel === 'string' ? rawLabel.trim() : '';
    const problem = agentLabelProblem(label);
    if (problem) throw new BackendError('invalid', problem);
    // 비밀 값처럼 보이는 이름은 받지 않는다 — 이름은 활동 기록·목록·대표 화면에 그대로 보인다
    if (ctx.redact.text(label) !== label) throw new BackendError('invalid', '외부 에이전트 이름에 비밀 값처럼 보이는 글이 있어 받지 않습니다 — 다른 이름을 쓰세요 (적은 이름은 보이지 않습니다)');
    const key = newAgentKey();
    const keyHash = agentKeyHash(key);
    const createdAt = ctx.now();
    const row = ctx.store.tx(() => {
      const same = ctx.store.externalAgents.list().find((a) => !a.revokedAt && labelKey(a.label) === labelKey(label));
      if (same) throw new BackendError('conflict', `같은 이름의 외부 에이전트(${same.id})가 이미 있습니다 — 다른 이름을 쓰거나, 그 에이전트를 wook-server agent revoke ${same.id}로 폐기한 뒤 등록하세요`);
      const r: ExternalAgentRow = { id: ctx.store.nextId('external_agent'), label, keyHash, createdAt, revokedAt: null, revokedBy: null, lastSeenAt: null };
      ctx.store.externalAgents.insert(r);
      return r;
    });
    // 이 실행에서 키가 어디에 찍혀도(도구 인자·CLI 출력) 저장 전에 가린다 — 모양 규칙과 함께
    ctx.redact.addSecret(key, REDACT_KINDS.wookAgentKey);
    this.secretsAdded.add(row.id);
    ctx.activity({ kind: 'auth', actor: OPERATOR, text: `외부 에이전트를 등록함: ${row.id} (${row.label}) — 키는 운영자 명령에 한 번만 보였고 해시만 저장함` });
    ctx.bus.changed();
    return { id: row.id, label: row.label, key, createdAt: row.createdAt };
  }

  /** 폐기 (agent revoke) — 되풀이해도 된다. 모르는 ID는 not_found */
  revoke(rawId: string): ExternalAgentRevokeReport {
    const ctx = this.ctx;
    const id = typeof rawId === 'string' ? rawId.trim() : '';
    if (!AGENT_ID_RE.test(id)) throw new BackendError('invalid_args', AGENT_ID_SHAPE);
    const now = ctx.now();
    const r = ctx.store.tx(() => {
      const row = ctx.store.externalAgents.get(id);
      if (!row) throw new BackendError('not_found', `등록된 외부 에이전트 ${id}이(가) 없습니다 — wook-server agent list로 ID를 확인하세요`);
      if (row.revokedAt) return { row, already: true };
      ctx.store.externalAgents.revoke(id, now, 'operator');
      return { row: { ...row, revokedAt: now, revokedBy: 'operator' as const }, already: false };
    });
    const seated = this.seatOf(id) !== null;
    if (!r.already) {
      ctx.activity({
        kind: 'auth',
        actor: OPERATOR,
        text: `외부 에이전트 키를 폐기함: ${id} (${r.row.label})${seated ? ' — 메인 자리에 앉아 있거나 들어올 차례라, 자리는 그대로 두고 응답 없음이 됩니다(서버는 자리를 바꾸지 않음)' : ''}`,
      });
      try {
        this.hooks.onRevoked?.(r.row);
      } catch (e) {
        ctx.log('error', `외부 에이전트 ${id}의 폐기 뒤 정리를 하지 못했습니다 — 키는 폐기됐습니다`, e);
      }
      ctx.bus.changed();
    }
    return { id, label: r.row.label, revokedAt: r.row.revokedAt!, already: r.already, seated };
  }

  /** 목록 (agent list·대표의 agents.list) — ID 차례, 폐기한 것도. 키·해시는 없다 */
  list(): ExternalAgentView[] {
    const seat = this.ctx.store.seat.get('main');
    const nowMs = this.ctx.clock.ms();
    return this.ctx.store.externalAgents.list().map((a) => ({
      id: a.id,
      label: a.label,
      createdAt: a.createdAt,
      revokedAt: a.revokedAt,
      lastSeenAt: latest(this.seenAt.get(a.id) ?? null, a.lastSeenAt),
      seat: this.seatOf(a.id, seat),
      connected: !a.revokedAt && liveLease(seat, a.id, nowMs),
    }));
  }

  // ───────────────────────── 자리 (seat.ts가 부른다) ─────────────────────────

  /** 등록 기록 한 줄 (없으면 null) */
  get(id: string): ExternalAgentRow | null {
    return this.ctx.store.externalAgents.get(id.trim());
  }

  /**
   * 메인 자리에 쓸 수 없는 까닭 — 등록되지 않았거나 키가 폐기됐으면 그 글, 쓸 수 있으면 null (리드 결정 S7-4: 운영자·메인·처음 보유자 모두 같은 판정)
   */
  unusable(id: string): string | null {
    const row = this.get(id);
    if (!row) return '등록되지 않은 외부 에이전트입니다 — 서버 PC의 운영자가 wook-server agent add로 등록한 뒤 쓸 수 있습니다';
    if (row.revokedAt) return `키가 폐기된 외부 에이전트입니다 (${row.revokedAt} 폐기) — 다시 쓰려면 운영자가 wook-server agent add로 새로 등록합니다`;
    return null;
  }

  /** 그 에이전트가 메인 자리에 앉아 있는지(seated), 진행 중인 교체의 들어올 보유자인지(incoming) */
  seatOf(id: string, seat: MainSeatRow | null = this.ctx.store.seat.get('main')): 'seated' | 'incoming' | null {
    if (!seat) return null;
    if (seat.holder?.kind === 'external' && seat.holder.agentId === id) return 'seated';
    if (seat.state === 'switching' && seat.pendingHolder?.kind === 'external' && seat.pendingHolder.agentId === id) return 'incoming';
    return null;
  }

  // ───────────────────────── 에이전트 API의 인증 (S7b가 부른다) ─────────────────────────

  /**
   * 키 → 에이전트 (리드 결정 S7-3). 모양이 틀리거나, 모르는 키거나, 폐기된 키면 null — 무엇도 바꾸지 않는다. 맞으면 이 실행에서 처음일 때 키를 백엔드 가리개에
   * 넣고 마지막 접속을 적는다(DB는 간격을 두고). 키만으로 자리를 얻지는 못한다 — 자리는 배정(seat.ts)이 정한다
   */
  authenticate(key: unknown): ExternalAgentRow | null {
    if (typeof key !== 'string' || !AGENT_KEY_RE.test(key)) return null;
    const ctx = this.ctx;
    const row = ctx.store.externalAgents.byKeyHash(agentKeyHash(key));
    if (!row || row.revokedAt) return null;
    if (!this.secretsAdded.has(row.id)) {
      ctx.redact.addSecret(key, REDACT_KINDS.wookAgentKey);
      this.secretsAdded.add(row.id);
    }
    const now = ctx.now();
    this.seenAt.set(row.id, now);
    const last = row.lastSeenAt ? Date.parse(row.lastSeenAt) : NaN;
    if (!(Date.parse(now) - last < AGENT_SEEN_WRITE_MS)) {
      ctx.store.externalAgents.touch(row.id, now);
      return { ...row, lastSeenAt: now };
    }
    return row;
  }

  // ───────────────────────── 임대 (S7b — 리드 결정 S7-4) ─────────────────────────

  leaseMs(): number {
    return this.ctx.deps.timing?.agentLeaseMs ?? AGENT_LEASE_DEFAULT_MS;
  }
  private pollMaxMs(): number {
    return this.ctx.deps.timing?.agentPollMaxMs ?? AGENT_POLL_DEFAULT_MS;
  }
  private heartbeatMs(): number {
    return Math.max(1, Math.min(AGENT_HEARTBEAT_DEFAULT_MS, Math.floor(this.leaseMs() / 4)));
  }
  private stopped(): boolean {
    return this.ctx.stop().global.active;
  }

  /** 서버가 시작할 때 (재시작 복구 전): 앞 실행이 남긴 임대 칸을 비운다 — 임대는 실행마다 새로 잡는다 (리드 결정 S7-2) */
  clearAtStart(): void {
    const s = this.ctx.store.seat.get('main');
    if (s?.lease) this.ctx.store.seat.put({ ...s, lease: null });
    this.noLeaseSinceMs = this.ctx.clock.ms();
  }

  /** 임대 만료를 5초마다도 본다 (스케줄러 차례마다도 본다) */
  start(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      try {
        if (!this.core.stopping) this.sweep();
      } catch (e) {
        this.ctx.log('warn', '외부 에이전트 임대 확인 실패', e);
      }
    }, AGENT_SWEEP_MS);
    this.sweepTimer.unref?.();
  }

  /** 앱 종료 — 타이머를 멈추고 열린 롱폴에 답한다 (일 없음) */
  stopTimers(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    this.lease?.poll?.settle({ kind: 'none' });
  }

  private refuse(code: string, message: string): never {
    throw new BackendError(code, message);
  }

  private seatRow(): MainSeatRow | null {
    return this.ctx.store.seat.get('main');
  }

  /** 자리가 바뀌었다는 글 (리드 결정 S7-3) — '메인 자리가 바뀌었습니다 (이 임대는 세대 n, 지금은 세대 m — <보유자>)' */
  private seatChangedText(generation: number, what = '임대'): string {
    const s = this.seatRow();
    const holder = s?.state === 'switching' ? s.pendingHolder : (s?.holder ?? null);
    return `메인 자리가 바뀌었습니다 (이 ${what}는 세대 ${generation}, 지금은 세대 ${s?.generation ?? 0} — ${holderLabel(holder)})`;
  }

  /** 자리 한 줄의 lease 칸 (DB 사본) — 지금 임대와 맞춘다 */
  private persistLease(l: LiveLease | null): void {
    const s = this.seatRow();
    if (!s) return;
    const row: SeatLeaseRow | null = l
      ? { agentId: l.agentId, leaseHash: l.leaseHash, generation: l.generation, claimedAt: l.claimedAt, heartbeatAt: l.heartbeatAt, expiresAt: new Date(l.expiresAtMs).toISOString() }
      : null;
    if (!row && !s.lease) return;
    this.ctx.store.seat.put({ ...s, lease: row });
  }

  /** 임대를 끝낸다 — 끝난 까닭을 기억하고, 열린 롱폴에 답하고, 그 에이전트의 턴 토큰을 모두 거둔다. 돌던 턴은 부르는 쪽이 끝낸다 */
  private endLease(l: LiveLease, end: LeaseEnd, poll: { code: string; message: string }): void {
    if (this.lease === l) {
      this.lease = null;
      this.persistLease(null);
    }
    this.ended.set(l.leaseHash, { agentId: l.agentId, generation: l.generation, end });
    while (this.ended.size > ENDED_LEASES_KEPT) this.ended.delete(this.ended.keys().next().value as string);
    l.poll?.settle({ kind: 'refused', ...poll });
    l.poll = null;
    // 임대가 없으면 그 에이전트의 턴 토큰도 없다 — 키·토큰 한 짝이 살아 남지 않게
    this.core.toolServer?.revokeWhere?.((i) => i.externalAgentId === l.agentId);
  }

  /** 그 임대가 받아 간 턴을 끝낸다 (비정상 종료 — 비정상 종료 규칙으로 다시 넣는다) */
  private endTurnOf(l: LiveLease, why: string): void {
    const t = l.turn;
    if (!t) return;
    l.turn = null;
    this.core.turns.endExternal(t.turnId, why);
  }

  /** 늦게 온 요청의 임대를 확인한다 — 살아 있으면 그 임대(늘려 준다), 아니면 참인 까닭으로 거부 (리드 결정 S7-3 세대 확인 포함) */
  private leaseFor(agentId: string, leaseId: unknown, renew = true): LiveLease {
    if (typeof leaseId !== 'string' || !leaseId.trim()) this.refuse('invalid', 'leaseId가 없습니다 — seat/claim의 답에 있는 leaseId를 보내세요');
    const hash = leaseKey(leaseId.trim());
    this.sweep();
    const cur = this.lease;
    if (cur && cur.leaseHash === hash) {
      if (cur.agentId !== agentId) this.refuse('not_assigned', '이 임대는 이 키의 에이전트 것이 아닙니다');
      if (this.stopped()) this.refuse('stopped', EXTERNAL_STOPPED);
      if (!this.core.seat.acceptsGeneration(cur.generation)) this.refuse('seat_changed', this.seatChangedText(cur.generation));
      if (renew) this.renew(cur);
      return cur;
    }
    const dead = this.ended.get(hash);
    if (!dead) this.refuse('lease_expired', '모르는 임대입니다 — 서버가 다시 시작됐거나 오래전에 끝난 임대입니다. 다시 claim하세요');
    if (dead.agentId !== agentId) this.refuse('not_assigned', '이 임대는 이 키의 에이전트 것이 아닙니다');
    if (this.stopped()) this.refuse('stopped', EXTERNAL_STOPPED);
    if (dead.end === 'seat_changed' || !this.core.seat.acceptsGeneration(dead.generation)) this.refuse('seat_changed', this.seatChangedText(dead.generation));
    switch (dead.end) {
      case 'superseded':
        this.refuse('lease_superseded', '같은 에이전트가 자리를 다시 요청해 이 임대는 끝났습니다 — 새 임대(leaseId)를 쓰세요');
      case 'expired':
        this.refuse('lease_expired', `이 임대는 ${secondsText(this.leaseMs())} 동안 heartbeat가 없어 끝났습니다 — 다시 claim하세요`);
      case 'released':
        this.refuse('lease_expired', '이 임대는 스스로 놓았습니다 (seat/release) — 다시 잡으려면 claim하세요');
      case 'stopped':
        this.refuse('lease_expired', '이 임대는 긴급 정지로 폐기했습니다 — 대표가 정지를 풀었으니 다시 claim하세요');
      case 'revoked':
        this.refuse('unauthorized', '에이전트 키가 맞지 않거나 폐기됐습니다');
    }
    return this.refuse('lease_expired', '이 임대는 끝났습니다 — 다시 claim하세요');
  }

  /** 받아들인 호출마다 임대를 늘린다 (리드 결정 S7-4) — DB 사본은 1초 넘게 달라질 때만 고쳐 쓴다 */
  private renew(l: LiveLease): void {
    const now = this.ctx.clock.ms();
    const next = now + this.leaseMs();
    const stored = this.seatRow()?.lease;
    l.heartbeatAt = new Date(now).toISOString();
    const moved = !stored || stored.leaseHash !== l.leaseHash || Math.abs(Date.parse(stored.expiresAt) - next) >= LEASE_WRITE_STEP_MS;
    l.expiresAtMs = next;
    if (moved) this.persistLease(l);
  }

  /**
   * 임대가 끝났는지 본다 (스케줄러 차례마다·5초마다·요청마다): 끝났으면 돌던 턴을 비정상 종료로 끝내 다시 넣게 하고(비정상 종료 규칙), 앉은 자리를 응답 없음으로
   * 둔다 — 서버는 자리를 바꾸지 않는다 (리드 결정 S7-4·S4-5). 긴급 정지 중에는 세지 않는다
   */
  sweep(): void {
    const l = this.lease;
    if (!l || this.stopped() || l.expiresAtMs > this.ctx.clock.ms()) return;
    const why = leaseExpiredText(this.leaseMs());
    this.endLease(l, 'expired', { code: 'lease_expired', message: `${why} — 다시 claim하세요` });
    this.endTurnOf(l, why);
    this.ctx.activity({ kind: 'seat', level: 'warn', memberId: MAIN_AGENT_ID, text: `${why}: ${l.label}(${l.agentId}, 세대 ${l.generation})` });
    this.core.seat.markExternalUnresponsive(l.agentId, why);
  }

  /** 그 에이전트가 지금 세대(generation)의 살아 있는 임대를 가졌는지 */
  liveLease(agentId: string, generation: number): boolean {
    const l = this.lease;
    return !!l && l.agentId === agentId && l.generation === generation && l.expiresAtMs > this.ctx.clock.ms();
  }

  /** 그 에이전트가 지금 세대에 일을 받으러 와 있는지 (열린 롱폴, 받아 간 턴 없음) — 스케줄러·인계 메모 턴이 본다 (seat.externalReady) */
  pollOpen(agentId: string, generation: number): boolean {
    const l = this.lease;
    return this.liveLease(agentId, generation) && !!l!.poll && !l!.poll.settled && !l!.turn;
  }

  /**
   * 외부 보유자가 응답하지 않는 까닭 (자리 watch가 부른다 — 임대가 끝난 때·스스로 물러난 때·폐기 때는 그 자리에서 정한다): 키가 폐기됐거나, 임대 없이 앉은 때(또는 서버
   * 시작·긴급 정지 해제)부터 임대 시간이 지났다. 아니면 null
   */
  silentReason(s: MainSeatRow): string | null {
    if (s.holder?.kind !== 'external') return null;
    const id = s.holder.agentId;
    const row = this.get(id);
    if (!row || row.revokedAt) return EXTERNAL_REVOKED;
    if (this.lease?.agentId === id) return null;
    const since = Math.max(s.since ? Date.parse(s.since) : 0, this.noLeaseSinceMs);
    if (this.ctx.clock.ms() - since < this.leaseMs()) return null;
    return `외부 에이전트가 메인 자리를 잡지 않음 — ${secondsText(this.leaseMs())} 동안 claim하지 않음`;
  }

  /** 긴급 정지를 푼 뒤 (StopService.release) — 그때부터 임대 시간 안에 다시 claim하면 응답 없음이 아니다 */
  afterStopRelease(): void {
    this.noLeaseSinceMs = this.ctx.clock.ms();
  }

  // ───────────────────────── 에이전트 API의 자리·일 (S7b) ─────────────────────────

  /**
   * seat/claim (리드 결정 S7-4): 자리가 active이고 이 에이전트에게 배정돼 있을 때만 — 키만으로는 자리를 얻지 못한다. 같은 에이전트의 다시 claim은 옛 임대를 끝내고
   * (lease_superseded) 그 임대가 받아 간 턴을 비정상 종료로 끝내 다시 넣는다. claim하면 응답 없음이 풀린다
   */
  claim(agentId: string): Omit<ClaimReply, 'ok'> {
    const ctx = this.ctx;
    if (this.stopped()) this.refuse('stopped', EXTERNAL_STOPPED);
    const s = this.seatRow();
    if (s?.state === 'switching') {
      this.refuse('switching', `메인 자리를 ${holderLabel(s.pendingHolder)}에게 넘기는 중입니다 (세대 ${s.swap?.from ?? s.generation - 1} → ${s.generation}) — 교체가 끝난 뒤 GET seat로 확인하세요`);
    }
    if (!s || s.state !== 'active' || s.holder?.kind !== 'external' || s.holder.agentId !== agentId) {
      this.refuse(
        'not_assigned',
        `메인 자리는 이 에이전트(${agentId})에게 배정돼 있지 않습니다 — 지금 보유자: ${holderLabel(s?.holder ?? null)} (세대 ${s?.generation ?? 0}). 서버 PC의 운영자가 wook-server seat assign external:${agentId}로 배정해야 claim할 수 있습니다`,
      );
    }
    const label = s.holder.label;
    const old = this.lease;
    if (old) {
      const sameAgent = old.agentId === agentId;
      this.endLease(old, sameAgent ? 'superseded' : 'seat_changed', sameAgent ? { code: 'lease_superseded', message: '같은 에이전트가 자리를 다시 요청해 이 임대는 끝났습니다 — 새 임대(leaseId)를 쓰세요' } : { code: 'seat_changed', message: this.seatChangedText(old.generation) });
      this.endTurnOf(old, EXTERNAL_RECLAIM);
    }
    const leaseId = randomBytes(24).toString('base64url');
    const now = ctx.now();
    const lease: LiveLease = { agentId, label, leaseHash: leaseKey(leaseId), generation: s.generation, claimedAt: now, heartbeatAt: now, expiresAtMs: ctx.clock.ms() + this.leaseMs(), poll: null, turn: null };
    this.lease = lease;
    this.persistLease(lease);
    ctx.activity({ kind: 'seat', memberId: MAIN_AGENT_ID, text: `외부 에이전트가 메인 자리를 잡음: ${label}(${agentId}, 세대 ${s.generation})${old ? ' — 같은 에이전트의 앞 임대를 끝냄' : ''}` });
    this.core.seat.externalAnswered(agentId);
    ctx.bus.changed();
    const { rules, skills } = this.core.turns.mainRules();
    return {
      agentId,
      label,
      generation: s.generation,
      leaseId,
      leaseMs: this.leaseMs(),
      heartbeatMs: this.heartbeatMs(),
      pollMaxMs: this.pollMaxMs(),
      mcpUrl: this.core.toolServer.url ?? '',
      rules,
      skills,
      handover: this.core.seat.handover(s.generation),
    };
  }

  /** seat/heartbeat — 임대를 늘리고 자리 상태를 준다 */
  heartbeat(agentId: string, leaseId: unknown): Omit<HeartbeatReply, 'ok'> {
    const l = this.leaseFor(agentId, leaseId);
    const s = this.seatRow();
    const paused = !!this.ctx.stop().members[MAIN_AGENT_ID]?.paused;
    const queued = this.ctx.store.queue.list({ ref1: MAIN_AGENT_ID, state: 'queued' }).filter((q) => !q.ownerShared).length;
    return { state: s?.state === 'switching' ? 'switching' : paused ? 'stopped' : 'active', generation: l.generation, leaseExpiresAt: new Date(l.expiresAtMs).toISOString(), queued };
  }

  /** seat/release — 스스로 물러난다. 서버는 대체하지 않는다: 자리는 곧바로 응답 없음이 되고 운영자가 배정한다 (4.4, S4-5) */
  release(agentId: string, leaseId: unknown, note: string | null): void {
    const l = this.leaseFor(agentId, leaseId, false);
    this.endLease(l, 'released', { code: 'lease_expired', message: '이 임대는 스스로 놓았습니다 (seat/release) — 다시 잡으려면 claim하세요' });
    this.endTurnOf(l, EXTERNAL_RELEASED);
    const said = note?.trim() ? ` — 남긴 말: ${this.ctx.redact.text(note.trim()).replace(/\s+/g, ' ').slice(0, 300)}` : '';
    this.ctx.activity({ kind: 'seat', level: 'warn', memberId: MAIN_AGENT_ID, text: `${EXTERNAL_RELEASED}: ${l.label}(${l.agentId}, 세대 ${l.generation})${said}` });
    this.core.seat.markExternalUnresponsive(agentId, EXTERNAL_RELEASED);
  }

  /** GET seat — 보기만 한다 (임대를 늘리지 않는다) */
  seatInfo(agentId: string): Omit<SeatReply, 'ok'> {
    const s = this.seatRow();
    const view = this.core.seat.view();
    const l = this.lease?.agentId === agentId && this.lease.expiresAtMs > this.ctx.clock.ms() ? this.lease : null;
    return {
      assigned: s?.holder?.kind === 'external' && s.holder.agentId === agentId,
      generation: view.generation,
      state: this.stopped() ? 'stopped' : view.state,
      holder: view.holder,
      leaseExpiresAt: l ? new Date(l.expiresAtMs).toISOString() : null,
    };
  }

  /**
   * work/next — 롱폴. 이 임대가 받아 간 턴이 있으면 같은 일을 곧바로 준다. 없으면 기다린다(새 롱폴은 옛 것에 204) — 스케줄러가 이 롱폴을 보고(seat.externalReady)
   * 메인 일을 띄우면 그 일, 시간이 끝나면 null(204). 긴급 정지·자리 교체·폐기면 그 까닭으로 거부
   */
  next(agentId: string, leaseId: unknown, waitMs: number, closed: Promise<void>): Promise<WorkItemData | null> {
    const l = this.leaseFor(agentId, leaseId);
    if (l.turn) return Promise.resolve(l.turn.item);
    l.poll?.settle({ kind: 'none' });
    const wait = Math.max(0, Math.min(Number.isFinite(waitMs) ? waitMs : 0, this.pollMaxMs()));
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | null = null;
      const poll: LivePoll = {
        settled: false,
        settle: (o) => {
          if (poll.settled) return;
          poll.settled = true;
          if (timer) clearTimeout(timer);
          if (l.poll === poll) l.poll = null;
          if (o.kind === 'work') resolve(o.item);
          else if (o.kind === 'none') resolve(null);
          else reject(new BackendError(o.code, o.message));
        },
      };
      l.poll = poll;
      timer = setTimeout(() => poll.settle({ kind: 'none' }), wait);
      timer.unref?.();
      void closed.then(() => poll.settle({ kind: 'none' }));
      // 스케줄러가 곧바로 본다 — 쌓인 메인 일이 있으면 이 롱폴로 간다
      this.ctx.bus.signal('tick');
    });
  }

  /**
   * 턴을 띄우는 쪽(TurnRunner의 외부 갈래)이 같은 동기 구간에서 부른다 (리드 결정 S7-4 — S4-14처럼 턴 기록 바로 앞): 그 세대의 열린 롱폴을 하나 받아 둔다. 없으면 null —
   * 턴 기록 전 실패로, 일은 대기열에 그대로 남는다
   */
  takePoll(generation: number | null): { agentId: string; label: string; deliver: (turnId: string, item: WorkItemData, run: ExternalRun) => void } | null {
    const l = this.lease;
    if (!l || generation === null || !this.pollOpen(l.agentId, generation)) return null;
    const poll = l.poll!;
    l.poll = null;
    return {
      agentId: l.agentId,
      label: l.label,
      deliver: (turnId, item, run) => {
        l.turn = { turnId, item, run };
        poll.settle({ kind: 'work', item });
      },
    };
  }

  /** 외부 턴이 끝났다 (TurnRunner.finish·ExternalRun의 끝) — 임대의 받아 간 턴을 지운다 */
  turnEnded(turnId: string): void {
    const l = this.lease;
    if (l?.turn?.turnId !== turnId) return;
    l.turn = null;
    l.endedTurnId = turnId;
  }

  /**
   * 이 임대의 이 턴 (살아 있을 때만) — 아니면 turn_ended·seat_changed. 끝난 턴은 참인 글로 답한다 (리드 결정 S7-17 F3): 기록까지 끝났으면 끝 까닭을 한국어 이름으로
   * (끝 글이 있으면 덧붙여), 이 임대가 받아 간 턴인데 실행만 끝나고 마무리(답 남기기·화면 도우미 놓기 등)가 남았으면 '마무리 중'
   */
  private turnOf(agentId: string, leaseId: unknown, turnId: string): ExternalRun {
    const l = this.leaseFor(agentId, leaseId);
    const t = l.turn;
    if (!t || t.turnId !== turnId || t.run.ended) {
      const row = this.ctx.store.turns.get(turnId);
      const g = row?.seatGeneration;
      const mine = !!row && row.externalAgentId === agentId;
      if (mine && g !== undefined && !this.core.seat.acceptsGeneration(g)) this.refuse('seat_changed', this.seatChangedText(g, '턴'));
      if (mine && row.endedAt) {
        const label = row.endReason ? TURN_END_LABEL[row.endReason] : '끝남';
        this.refuse('turn_ended', `턴 ${turnId}은(는) 이미 끝났습니다 (${row.endDetail && row.endDetail !== label ? `${label}: ${row.endDetail}` : label})`);
      }
      if (mine && (l.endedTurnId === turnId || t?.turnId === turnId)) this.refuse('turn_ended', `턴 ${turnId}은(는) 이미 끝났습니다 (마무리 중)`);
      this.refuse('turn_ended', `이 임대가 받아 간 턴이 아닙니다 (${turnId})`);
    }
    return t.run;
  }

  /** work/{turnId}/progress */
  progress(agentId: string, leaseId: unknown, turnId: string, text: string): void {
    this.turnOf(agentId, leaseId, turnId).progress(text);
  }

  /** work/{turnId}/finish — 턴을 마친다. 그 턴의 마무리(판정·대화에 답 남기기)가 끝나기를 잠깐 기다려 끝 까닭을 준다 */
  async finish(agentId: string, leaseId: unknown, turnId: string, finalText: string, outcome: 'completed' | 'failed'): Promise<{ endReason: TurnEndReason }> {
    const run = this.turnOf(agentId, leaseId, turnId);
    run.finish(finalText, outcome);
    await Promise.race([this.core.turns.turnFlow(turnId), new Promise((r) => setTimeout(r, 10_000).unref?.())]);
    return { endReason: this.ctx.store.turns.get(turnId)?.endReason ?? (outcome === 'completed' ? 'completed' : 'crashed') };
  }

  // ───────────────────────── 자리 교체·정지·폐기 (S7b) ─────────────────────────

  /** 교체 4번 (seat.finish): 나가는 보유자의 임대를 거둔다 — 그 뒤 heartbeat는 새 보유자를 말하는 seat_changed (리드 결정 S7-4) */
  dropForSwap(): void {
    const l = this.lease;
    if (!l) return;
    this.endLease(l, 'seat_changed', { code: 'seat_changed', message: this.seatChangedText(l.generation) });
    this.endTurnOf(l, `메인 자리 교체 — ${l.label}의 임대를 거둠`);
  }

  /**
   * 긴급 정지 2번 (StopService.emergency, 리드 결정 S7-4): 임대와 외부 턴 토큰을 모두 폐기하고 열린 롱폴에 409 stopped. 돌던 외부 턴은 stopAll이 user_stop으로 끝낸다.
   * 살아 있는 임대나 턴이 있던 외부 보유자를 돌려준다 — 요약의 failures 줄 (종료 확인 불가)
   */
  discardAll(): { agentId: string; label: string }[] {
    const out = new Map<string, string>();
    const l = this.lease;
    if (l) {
      if (l.expiresAtMs > this.ctx.clock.ms() || l.turn) out.set(l.agentId, l.label);
      this.endLease(l, 'stopped', { code: 'stopped', message: EXTERNAL_STOPPED });
    }
    for (const t of this.core.turns.externalTurns()) out.set(t.agentId, t.label);
    this.core.toolServer?.revokeWhere?.((i) => !!i.externalAgentId);
    this.noLeaseSinceMs = this.ctx.clock.ms();
    return [...out].map(([agentId, label]) => ({ agentId, label }));
  }

  /** 키 폐기 뒤 (hooks.onRevoked의 기본): 임대와 턴 토큰을 거두고 돌던 턴을 끝내 다시 넣는다. 앉아 있으면 자리는 그대로 두고 곧바로 응답 없음 (S7-4·S7-15) */
  private afterRevoke(row: ExternalAgentRow): void {
    const l = this.lease;
    if (l?.agentId === row.id) {
      this.endLease(l, 'revoked', { code: 'unauthorized', message: '에이전트 키가 맞지 않거나 폐기됐습니다' });
      this.endTurnOf(l, EXTERNAL_REVOKED);
    }
    this.core.toolServer?.revokeWhere?.((i) => i.externalAgentId === row.id);
    this.core.seat.markExternalUnresponsive(row.id, EXTERNAL_REVOKED);
  }

  /**
   * 에이전트 API의 긴급 정지 (리드 결정 S7-12 1 — 등록·폐기되지 않은 키면 누구나. 풀기는 대표만). 이미 정지 중이면 정지를 다시 돌리지 않고 그 정지의 요약을
   * 돌려준다 — 처음 건 쪽(global.by)은 그대로이고, 활동 기록은 한 정지에 한 줄만 남긴다 (리드 결정 S7-17 A3). 처음 건 정지는 메인 일지에 이 에이전트를 적는다
   */
  async emergencyFrom(agentId: string): Promise<EmergencySummary> {
    const row = this.get(agentId);
    const name = row?.label ?? agentId;
    const seated = this.seatOf(agentId) === 'seated';
    const by: Actor = seated ? MAIN_AGENT_ID : 'system';
    const already = this.core.stops.activeSummary();
    if (already) {
      this.core.stops.noteRepeatedStop(
        by,
        `외부 에이전트가 이미 긴급 정지 중에 다시 정지를 요청함: ${name}(${agentId}) — 정지를 다시 돌리지 않고 그 요약을 돌려줌 (이 정지 동안의 다음 요청은 적지 않음)`,
      );
      return already;
    }
    this.ctx.activity({ kind: 'stop', level: 'warn', actor: by, text: `외부 에이전트가 에이전트 API로 긴급 정지를 요청함: ${name}(${agentId})` });
    return this.core.stops.emergency(by, { requester: `외부 에이전트 ${name}(${agentId})${subjectJosa(name)}` });
  }
}

/** 외부 에이전트 API의 백엔드 쪽 (서버 모드 — Backend.agents, 리드 결정 S7-2). HTTP는 src/server/agentApi.ts */
export function agentBackendOf(core: Core): AgentBackend {
  const agents = core.externalAgents;
  /**
   * 턴 토큰이 이 에이전트의 것인지 (키와 토큰이 같은 에이전트, S7-3) — 아니면 401. 임대가 끝났는지 먼저 본다(sweep) — 끝나는 때가 지난 임대의 토큰은 다음 스케줄러
   * 차례를 기다리지 않고 이 자리에서 죽는다 (리드 결정 S7-17 F4 — 임대 길이 lease_expired로 답하는 바로 그때)
   */
  const ownToken = (agentId: string, token: string) => {
    agents.sweep();
    const id = typeof token === 'string' && token ? (core.toolServer.identityOf?.(token) ?? null) : null;
    if (!id) throw new BackendError('unauthorized', '턴 토큰이 없거나 이미 폐기됐습니다 (턴이 끝났을 수 있습니다) — X-Wook-Turn-Token에 지금 턴의 토큰을 보내세요');
    if (id.externalAgentId !== agentId) throw new BackendError('unauthorized', '턴 토큰이 이 키의 에이전트 것이 아닙니다');
    return id;
  };
  return {
    baseUrl: () => core.toolServer.baseUrl ?? null,
    mcpUrl: () => core.toolServer.url,
    mount: (handler) => core.toolServer.mountAgentApi?.(handler),
    authenticate: (key) => {
      const row = agents.authenticate(key);
      return row ? { id: row.id, label: row.label } : null;
    },
    claim: (agentId) => agents.claim(agentId),
    heartbeat: (agentId, leaseId) => agents.heartbeat(agentId, leaseId),
    release: (agentId, leaseId, note) => agents.release(agentId, leaseId, note),
    seat: (agentId) => agents.seatInfo(agentId),
    next: (agentId, leaseId, waitMs, closed) => agents.next(agentId, leaseId, waitMs, closed),
    progress: (agentId, leaseId, turnId, text) => agents.progress(agentId, leaseId, turnId, text),
    finish: (agentId, leaseId, turnId, finalText, outcome) => agents.finish(agentId, leaseId, turnId, finalText, outcome),
    tool: async (agentId, token, name, args): Promise<ToolCallResult> => {
      ownToken(agentId, token);
      const r = (await core.toolServer.callTool?.(token, name, args)) ?? null;
      if (!r) throw new BackendError('unauthorized', '턴 토큰이 없거나 이미 폐기됐습니다 (턴이 끝났을 수 있습니다)');
      return r;
    },
    screen: (agentId, token, captureId) => {
      const id = ownToken(agentId, token);
      const g = id.seatGeneration;
      if (g === undefined || !core.seat.acceptsGeneration(g)) throw new BackendError('seat_changed', `메인 자리가 바뀌었습니다 (이 턴 토큰은 세대 ${g ?? '?'}, 지금은 세대 ${core.seat.generation()}) — 캡처를 주지 않습니다`);
      const cap = core.desktop.keptPng(captureId);
      if (!cap) throw new BackendError('not_found', '그 캡처는 없습니다 — 지워졌거나(24시간·500장 보관), 바뀌었거나(기록의 해시와 다름), 모르는 ID입니다');
      if (cap.generation !== g) throw new BackendError('seat_changed', `이 캡처는 다른 세대(세대 ${cap.generation})의 것이라 주지 않습니다 — 지금 턴(세대 ${g})에 찍은 캡처만 받습니다`);
      return cap.bytes;
    },
    stop: (agentId) => agents.emergencyFrom(agentId),
  };
}

function latest(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

/** 그 에이전트의 살아 있는 임대가 지금 세대에 있는지 (S7b가 lease 칸을 쓴다) */
function liveLease(seat: MainSeatRow | null, id: string, nowMs: number): boolean {
  const l = seat?.lease;
  return !!l && l.agentId === id && l.generation === seat!.generation && seat!.holder?.kind === 'external' && seat!.holder.agentId === id && Date.parse(l.expiresAt) > nowMs;
}
