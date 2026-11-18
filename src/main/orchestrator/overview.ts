/**
 * 전체 현황 (SERVER_DESIGN 5.1·5.2, 리드 결정 S5-3·S5-4·S5-6) — get_overview, 메인 대화 턴마다 넣는 현황 요약(digest), list_questions, 메인 세션
 * get_work_context의 요약, 대표 할 일·작업 화면의 reachesMain이 모두 이 파일의 고르는 함수를 쓴다(계산은 한곳). 인계 꾸러미(handover.ts)도 같은 고르는 함수로
 * 사실 칸을 채운다 — 글 모양은 꾸러미 쪽 그대로다.
 * 숫자의 정의 (overviewMultiProject가 못 박는다):
 * - 진행 중 지시: 열린 지시 중 확인 대기를 뺀 것(프로젝트 화면 projectView와 같다). 확인 대기는 따로 센다
 * - 작업 수: 열린 지시(확인 대기 포함)의 지금 회차 작업을 여섯 상태별로. 그 밖의 끝나지 않은 작업(되돌리기 작업·이전 회차에 남은 것)은 otherOpenTasks
 * - 대표 승인 대기 보고: 새 보고와 읽은 보고(reports.approve가 받는 상태) — 대표가 아직 읽지 않았으면 unread
 * - 보류가 메인에게 가 있는가: holdReach 하나 — 스냅숏·현황마다 메인 업무를 한 번만 읽어 만든다(대표 할 일마다 대기열을 다시 읽지 않는다)
 * 글은 자르기 전에 가린다 — 자른 뒤에 가리면 잘린 비밀 값 앞부분이 남는다. 결과 전체도 한 번 더 가린다(보류 사유는 저장할 때 가리지 않은 것이 있다)
 */
import type { HoldReason, Project, QueueEntry, Question, Report, Task, TaskState, Turn, WorkKind } from '@shared/domain';
import { MAIN_AGENT_ID } from '@shared/domain';
import { HOLD_REASON_LABEL, MEMBER_STATUS_LABEL, SESSION_KIND_LABEL, TASK_STATE_LABEL, WORK_KIND_LABEL } from '@shared/labels';
import type { JournalKind } from '@shared/views';
import { isDirectiveOpen } from '@core/directiveMachine';
import type { Listed, Overview, OverviewProject, QuestionList } from '../mcp/catalog';
import type { Core } from './core';
import type { Ctx } from './context';
import { JOURNAL_OPEN_PROMISES_LISTED } from './journal';
import { directiveTasks, memberName } from './lookups';
import { mainKey, newestEntry, parseKey, workProjectOf } from './records';
import { NO_REVIEWER_HOLD_REF } from './tasks';
import { isReviewHandOff } from './turns';
import { alertHead, alertKey, alertKeysOfReason, alertLabel, aliveFor } from './alerts';

/** 현황 요약의 상한 — 요약 글(제목 줄·인용 표시 빼고)의 길이 (SERVER_DESIGN 5.1, 리드 결정 S5-4) */
export const DIGEST_MAX_CHARS = 1_500;
/** 현황 요약 한 줄의 상한 */
export const DIGEST_LINE_MAX = 200;
/** get_overview 목록 상한 — 기본, detail (리드 결정 S5-3) */
export const OVERVIEW_LIST_MAX = 20;
export const OVERVIEW_DETAIL_MAX = 100;
/** list_questions 상한 (리드 결정 S5-6) */
export const QUESTION_LIST_MAX = 100;
const JOURNAL_RECENT = 10;
const TITLE_MAX = 80;
const NOTE_MAX = 200;
const QUESTION_TEXT_MAX = 1_000;
/** 현황 요약의 열린 약속 — 오래된 것 몇 건까지 */
const DIGEST_PROMISES = 3;
const TASK_STATES: readonly TaskState[] = ['waiting', 'in_progress', 'on_hold', 'in_review', 'done', 'cancelled'];
/** 일지 최근 칸 — 월별 묶음(rollup)만 뺀다 (6.3) */
const JOURNAL_RECENT_KINDS: readonly JournalKind[] = ['command', 'action', 'report', 'seat', 'stop', 'decision', 'promise', 'note'];
/** 메인 자리의 응답 없음 표시가 지워지는 때 — 정상으로 끝난 메인 턴이 지운다 (S4-5) */
const UNRESPONSIVE_NOTE = '이 턴이 정상으로 끝나면 지워집니다';

/** 한 줄로 — 줄바꿈·공백을 하나로 모으고 max자에서 자른다 */
const line = (s: string, max: number): string => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
/** 줄 모양은 그대로 두고 max자에서 자른다 */
const cut = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const listed = <T>(all: readonly T[], max: number): Listed<T> => ({ total: all.length, items: all.slice(0, max) });
/** 시각의 '시:분' (UTC) */
const hm = (iso: string | null): string => (iso ? iso.slice(11, 16) : '?');

// ───────────────────────── 고르는 함수 (현황·요약·인계 꾸러미·대표 화면이 함께 쓴다) ─────────────────────────

/** 대표에게 온 열린 질문 — 오래된 것부터 (지금은 메인 에이전트의 ask_owner만 만든다) */
export function ownerQuestions(ctx: Ctx): Question[] {
  return ctx.store.questions.list({ state: 'open' }).filter((q) => q.to === 'owner');
}

/** 열린 질문 — 오래된 것부터. projectId가 없으면 모두, 'general'이면 프로젝트가 없는 것(직접 명령에서 한 질문), 그 밖에는 그 프로젝트의 것 (list_questions) */
export function openQuestions(ctx: Ctx, projectId?: string): Question[] {
  const open = ctx.store.questions.list({ state: 'open' });
  if (projectId === undefined) return open;
  return open.filter((q) => (projectId === 'general' ? q.projectId === null : q.projectId === projectId));
}

/** 대표 승인을 기다리는 보고 — 새 보고와 읽은 보고 (reports.approve가 받는 상태) */
export function reportsAwaitingApproval(ctx: Ctx): Report[] {
  return ctx.store.reports.list({ state: ['new', 'read'] });
}

/**
 * 처리하지 않은 대표 수정 요청 — 그 보고서의 수정 요청 업무가 대기·실행 중이거나, 메인이 아직 회차를 열지 않아 대표가 그 보고서를 그대로 승인할 수 있는 것
 * (리드 결정 10)
 */
export function unhandledChangeRequests(core: Core): Report[] {
  const ctx = core.ctx;
  const queued = new Set(
    ctx.store.queue
      .list({ ref1: MAIN_AGENT_ID, state: ['queued', 'running'] })
      .filter((q) => q.kind === 'change_request')
      .map((q) => q.reportId ?? ''),
  );
  return ctx.store.reports.list({ state: 'changes_requested' }).filter((r) => queued.has(r.id) || core.reports.approveRefusal(r) === null);
}

/** 대기·실행 중인 메인 에이전트의 일 — skip에 맞는 것(인계 메모 업무, 이 턴이 실은 일 등)은 뺀다. 만든 차례 그대로 */
export function mainWork(ctx: Ctx, skip: (q: QueueEntry) => boolean = () => false): QueueEntry[] {
  return ctx.store.queue.list({ ref1: MAIN_AGENT_ID, state: ['queued', 'running'] }).filter((q) => !skip(q));
}

/** 메인이 검수자인 작업 — 검수 중이거나 검수로 돌아갈 보류 */
export function mainReviewTasks(ctx: Ctx): Task[] {
  return ctx.store.tasks.list({ state: ['in_review', 'on_hold'] }).filter((t) => t.reviewerId === MAIN_AGENT_ID && (t.state === 'in_review' || t.hold.returnState === 'in_review'));
}

/**
 * 메인에게 넘긴 보류와 남는 업무인지 — 정지 해제 목록(stop_released), 검수자 없음(no_reviewer), 멈춘 검수 넘김(isReviewHandOff), 일시정지된 팀원의 재개
 * (pausedMemberId), 대표에게만 가던 보류·실패를 넘긴 업무(alert, 5.3)
 */
export function isMainHandOver(q: QueueEntry): boolean {
  return q.memberId === MAIN_AGENT_ID && (q.kind === 'stop_released' || q.kind === 'no_reviewer' || q.kind === 'alert' || !!q.pausedMemberId || isReviewHandOff(q));
}

/** 넘겨받은 일의 한 줄 이름 — '검수자 없음 T-0003', '정지 해제 목록', '멈춘 검수 T-0007', '일시정지된 팀원 재개 M-0004', '병합 실패 T-0005'(알림 업무의 종류와 대상) */
function handOverLabel(q: QueueEntry): string {
  if (q.kind === 'alert') return alertLabel(q);
  if (q.kind === 'stop_released') return '정지 해제 목록';
  if (q.kind === 'no_reviewer') return `검수자 없음${q.taskId ? ` ${q.taskId}` : ''}`;
  if (q.pausedMemberId) return `일시정지된 팀원 재개 ${q.pausedMemberId}`;
  if (isReviewHandOff(q)) return `멈춘 검수 ${q.taskId}`;
  return `${WORK_KIND_LABEL[q.kind]}${q.taskId ? ` ${q.taskId}` : ''}`;
}

/** 보류가 메인 에이전트에게 처리할 일로 가 있는지 보는 판정 (holdReach) */
export interface HoldReach {
  /** 그 작업의 그 보류 사유 — HoldReasonView·대표 할 일 error의 reachesMain */
  reason(t: Task, r: HoldReason): boolean;
  /** 정지 해제 목록 — 대표 할 일 emergency_held의 reachesMain */
  stopReleased(): boolean;
  /** 복구 확인 항목(요청 ID, 그 실행의 프로젝트) — 대표 할 일 recovery_check의 reachesMain: 그 항목의 알림 업무(alert recovery:<요청 ID>)가 살아 있는가 */
  recovery(requestId: string, projectId: string | null): boolean;
}

/**
 * 보류가 메인에게 가 있는가 (리드 결정 41·43, S5-3·S5-7) — 그 보류의 가장 최근 메인 업무가 있고 취소(상한에서 버림 포함)되지 않았으면 참이다: 대기·실행 중이거나
 * 메인이 받아 마쳤다. 검수자 없음 보류는 그 작업의 가장 최근 검수자 없음 업무, 긴급 정지 보류는 가장 최근 정지 해제 목록(긴급 정지가 풀린 뒤에만) — 둘 다 상한에서
 * 버린 뒤 메인에게 한 번 더 넘겼으면(alert handover-dropped:<버린 항목>) 그 업무로도 본다. 대표에게만 가던 보류·실패(alerts.ts)는 그 보류 사유의 알림 키(작업
 * 보류의 종류별 키, 복구 확인은 요청 ID)의 가장 최근 항목이 대기·실행 중이거나, 그 보류가 걸린 뒤 받아 마쳤을 때 참이다 — 앞선 보류에서 받아 마친 항목은 지금
 * 보류의 것이 아니다(보류 한 번 규칙). 대표가 풀 보류(답변 대기 등)와 메인에게 업무가 가지 않는 보류는 거짓이다. 스냅숏·현황마다 하나를 만들어 쓴다 — 메인 세션
 * 키마다 대기열을 한 번만, 처음 물을 때 읽는다(보류가 없으면 읽지 않는다)
 */
export function holdReach(ctx: Ctx): HoldReach {
  const byKey = new Map<string, { kinds: Map<string, QueueEntry>; alerts: Map<string, QueueEntry> }>();
  /** 그 메인 세션 키의 업무 — 종류·작업마다, 그리고 알림 키마다 가장 최근 항목 */
  const newestOf = (sessionKey: string): { kinds: Map<string, QueueEntry>; alerts: Map<string, QueueEntry> } => {
    let m = byKey.get(sessionKey);
    if (m) return m;
    m = { kinds: new Map(), alerts: new Map() };
    for (const q of ctx.store.queue.list({ ref2: sessionKey })) {
      if (q.memberId !== MAIN_AGENT_ID) continue;
      const k = `${q.kind}:${q.taskId ?? ''}`;
      const cur = m.kinds.get(k);
      m.kinds.set(k, cur ? newestEntry([cur, q])! : q);
      if (q.alertKey) {
        const a = m.alerts.get(q.alertKey);
        m.alerts.set(q.alertKey, a ? newestEntry([a, q])! : q);
      }
    }
    byKey.set(sessionKey, m);
    return m;
  };
  const live = (q: QueueEntry | undefined): boolean => !!q && q.state !== 'cancelled';
  /** 보류 넘김의 가장 최근 항목이 살아 있거나, 상한에서 버린 뒤 메인에게 한 번 더 넘긴 알림이 살아 있다 (리드 결정 43·S5-8) */
  const handOverLive = (sessionKey: string, q: QueueEntry | undefined): boolean => live(q) || (!!q && live(newestOf(sessionKey).alerts.get(alertKey('handover-dropped', q.id))));
  const stopReleased = (): boolean => handOverLive(mainKey(null), newestOf(mainKey(null)).kinds.get('stop_released:'));
  const emergencyActive = ctx.stop().global.active;
  return {
    reason: (t, r) => {
      const key = mainKey(t.projectId);
      if (r.kind === 'error' && r.refId === NO_REVIEWER_HOLD_REF) return handOverLive(key, newestOf(key).kinds.get(`no_reviewer:${t.id}`));
      if (r.kind === 'emergency_stop') return !emergencyActive && stopReleased();
      const keys = alertKeysOfReason(t, r);
      return keys.length > 0 && keys.some((k) => aliveFor(newestOf(key).alerts.get(k), r.since));
    },
    stopReleased,
    recovery: (requestId, projectId) => live(newestOf(mainKey(projectId)).alerts.get(alertKey('recovery', requestId))),
  };
}

// ───────────────────────── 현황 요약의 줄 ─────────────────────────

/** 요약 한 줄의 한 조각 — text(수, 줄이지 않는다)와 items(뒤에서부터 뺄 수 있는 ID·이름). total: items가 가리키는 전체 건수 */
interface DigestPart {
  text: string;
  items: string[];
  total: number;
  shown: number;
}

interface DigestRow {
  lead: string;
  parts: DigestPart[];
  /** 통째로 뺄 수 있는 프로젝트 줄 */
  project?: true;
  dropped?: boolean;
}

const part = (text: string, items: string[] = [], total = items.length): DigestPart => ({ text, items, total, shown: items.length });

/** 조각 → 글: 'A 2건: X, Y', 일부만 보이면 'A 5건: X, Y 외 3건', 보일 것을 모두 뺐으면 'A 5건(목록 생략)' */
function renderPart(p: DigestPart): string {
  const shown = p.items.slice(0, p.shown);
  if (!shown.length) return p.items.length ? `${p.text}(목록 생략)` : p.text;
  const omitted = p.total - shown.length;
  return `${p.text}: ${shown.join(', ')}${omitted > 0 ? ` 외 ${omitted}건` : ''}`;
}

/**
 * 요약 글을 상한 안으로 줄인다 (리드 결정 S5-4) — 줄마다 200자, 전체 1,500자. 넘치면 아래 줄부터(한 줄 안에서는 뒤 조각부터) 목록 항목을 한 건씩 빼고 '외 n건'으로
 * 남긴다. 수는 빼지 않는다. 항목을 다 빼도 넘치면 맨 아래 프로젝트 줄부터 통째로 빼고 '외 프로젝트 n개' 줄을 둔다 — 지금 대화의 프로젝트 줄은 프로젝트 줄 맨 위라
 * 남는다(고정 줄 넷 — 정지·대표 쪽·메인이 할 일·열린 약속 — 이 줄마다 200자여도 그 줄, '외 프로젝트' 줄과 함께 1,500자 안에 든다). n은 진행 중 프로젝트 가운데
 * 줄이 없는 수다: projectsTotal − 남은 프로젝트 줄 (리드 결정 S5-27). 같은 입력이면 늘 같은 결과다.
 * 일은 프로젝트 수에 비례한다 (리드 결정 S5-38): 줄마다 한 번 그려(가려) 길이와 함께 둔다. 항목을 빼면 그 줄만 다시 그리고, 항목을 다 빼도 넘치면 아래 프로젝트
 * 줄부터 쌓은 길이로 한 번에 뺀다(다시 그리지 않는다). 결과는 줄 하나 빼고 전체를 다시 그리던 때와 같다(digestEveryTurn이 그때 계산과 견준다)
 */
export function fitDigest(rows: DigestRow[], redact: (s: string) => string, projectsTotal: number): string {
  const renderRow = (r: DigestRow): string => redact(`${r.lead}${r.parts.map(renderPart).join(' · ')}`);
  const dropOne = (r: DigestRow): boolean => {
    for (let i = r.parts.length - 1; i >= 0; i--) {
      const p = r.parts[i]!;
      if (p.shown > 0) {
        p.shown -= 1;
        return true;
      }
    }
    return false;
  };
  // 줄마다 200자 — 마지막으로 그린 글이 그 줄의 지금 모양이다(항목을 더 뺄 수 없으면 그대로)
  const drawn = rows.map((r) => {
    let s = renderRow(r);
    while (s.length > DIGEST_LINE_MAX && dropOne(r)) s = renderRow(r);
    return line(s, DIGEST_LINE_MAX);
  });
  const more = (gone: number): string => `외 프로젝트 ${gone}개 — get_overview로 보세요`;
  // 남은 줄의 길이 합·줄 수·프로젝트 줄 수 — 합친 글의 길이는 이것과 '외 프로젝트' 줄, 줄바꿈으로 센다
  let sum = drawn.reduce((n, s) => n + s.length, 0);
  let liveRows = rows.length;
  let liveProjects = rows.filter((r) => r.project).length;
  const length = (): number => {
    const gone = projectsTotal - liveProjects;
    const n = liveRows + (gone > 0 ? 1 : 0);
    return sum + (gone > 0 ? more(gone).length : 0) + Math.max(0, n - 1);
  };
  // 아래 줄부터(한 줄 안에서는 뒤 조각부터) 항목을 한 건씩 — 항목은 줄기만 하므로 다 뺀 아래 줄로는 돌아가지 않는다. 바뀐 줄만 다시 그린다
  for (let i = rows.length - 1; i >= 0 && length() > DIGEST_MAX_CHARS; ) {
    if (!dropOne(rows[i]!)) {
      i--;
      continue;
    }
    const s = line(renderRow(rows[i]!), DIGEST_LINE_MAX);
    sum += s.length - drawn[i]!.length;
    drawn[i] = s;
  }
  // 항목을 다 빼도 넘치면 맨 아래 프로젝트 줄부터 들어갈 때까지 통째로 — 한 번에, 쌓은 길이로
  for (let i = rows.length - 1; i >= 0 && length() > DIGEST_MAX_CHARS; i--) {
    const r = rows[i]!;
    if (!r.project) continue;
    r.dropped = true;
    sum -= drawn[i]!.length;
    liveRows -= 1;
    liveProjects -= 1;
  }
  const out = rows.flatMap((r, i) => (r.dropped ? [] : [drawn[i]!]));
  const gone = projectsTotal - liveProjects;
  if (gone > 0) out.splice(out.length - 1, 0, more(gone));
  const text = out.join('\n');
  return text.length > DIGEST_MAX_CHARS ? `${text.slice(0, DIGEST_MAX_CHARS - 1)}…` : text;
}

export class OverviewService {
  constructor(private readonly core: Core) {}

  private get ctx() {
    return this.core.ctx;
  }

  /** 가린 뒤 한 줄로 자른다 */
  private safeLine(s: string, max: number): string {
    return line(this.ctx.redact.text(s), max);
  }

  /**
   * 전체 현황 (get_overview) — projectId는 프로젝트 칸만 거른다. detail이면 목록 100건, 아니면 20건. excludeEntryIds: 부른 턴이 실은 메인 업무(메인이 할 일의 수에서
   * 뺀다). allProjects: 프로젝트 칸은 상한 없이 모든 진행 중 프로젝트 — 현황 요약만 쓴다(요약은 1,500자 안으로 스스로 줄인다, 리드 결정 S5-27). 결과는 가린 값이다
   */
  build(o: { projectId?: string | null; detail?: boolean; excludeEntryIds?: ReadonlySet<string>; allProjects?: boolean } = {}): Overview {
    const ctx = this.ctx;
    const core = this.core;
    const max = o.detail ? OVERVIEW_DETAIL_MAX : OVERVIEW_LIST_MAX;
    const exclude = o.excludeEntryIds ?? new Set<string>();
    const stop = ctx.stop();
    const reach = holdReach(ctx);
    const seatView = core.seat.view();
    const title = (s: string) => this.safeLine(s, TITLE_MAX);
    const note = (s: string) => this.safeLine(s, NOTE_MAX);

    // 메인이 할 일 — 세션 키별, 종류별
    const work = mainWork(ctx, (q) => exclude.has(q.id));
    const byKey = new Map<string, QueueEntry[]>();
    const byKind: Partial<Record<WorkKind, number>> = {};
    for (const q of work) {
      byKey.set(q.sessionKey, [...(byKey.get(q.sessionKey) ?? []), q]);
      byKind[q.kind] = (byKind[q.kind] ?? 0) + 1;
    }
    const queue = [...byKey].map(([sessionKey, qs]) => {
      const kinds: Partial<Record<WorkKind, number>> = {};
      for (const q of qs) kinds[q.kind] = (kinds[q.kind] ?? 0) + 1;
      return { sessionKey, projectId: workProjectOf(ctx, sessionKey), total: qs.length, kinds, running: qs.some((q) => q.state === 'running') };
    });

    const projects = ctx.store.projects.list({ state: 'active' }).filter((p) => !o.projectId || p.id === o.projectId);
    const running = ctx.store.turns.list({ state: 'running' });
    const urgent = ctx.store.notifications.list({ state: 'unread' }, { desc: true }).filter((n) => n.level === 'urgent');
    const open = ctx.store.journal.query({ openPromisesOnly: true, asc: true });
    const recent = ctx.store.journal.query({ kinds: JOURNAL_RECENT_KINDS, limit: JOURNAL_RECENT });

    const overview: Overview = {
      generatedAt: ctx.now(),
      seat: { ...seatView, unresponsiveForMs: core.seat.unresponsiveForMs(), ...(seatView.unresponsiveSince ? { unresponsiveNote: UNRESPONSIVE_NOTE } : {}) },
      stop: {
        emergency: { active: stop.global.active, since: stop.global.since },
        pausedProjects: Object.entries(stop.projects)
          .filter(([, s]) => s.paused)
          .map(([projectId, s]) => ({ projectId, mode: s.mode, by: s.by, since: s.since, ...(s.reason ? { reason: note(s.reason) } : {}) })),
        // 삭제된 팀원은 일시정지로 세지 않는다 — 지우는 트랜잭션이 정지 기록을 지우지만 그 전의 DB에는 남아 있을 수 있다 (리드 결정 S5-64)
        pausedMembers: Object.entries(stop.members)
          .filter(([memberId, s]) => s.paused && !ctx.store.members.get(memberId)?.deletedAt)
          .map(([memberId, s]) => ({ memberId, name: memberName(ctx, memberId), mode: s.mode, by: s.by, since: s.since, ...(s.reason ? { reason: note(s.reason) } : {}) })),
        heldByEmergency: core.stops.heldByEmergency(),
      },
      ai: core.views.aiStatus(),
      cpu: core.cpu.view(),
      owner: {
        questions: listed(
          ownerQuestions(ctx).map((q) => ({ questionId: q.id, projectId: q.projectId, text: note(q.text), createdAt: q.createdAt })),
          max,
        ),
        reportsAwaitingApproval: listed(
          reportsAwaitingApproval(ctx).map((r) => ({ reportId: r.id, title: title(r.title), projectId: r.projectId, directiveId: r.directiveId, round: r.round, unread: r.status === 'new', createdAt: r.createdAt })),
          max,
        ),
        changeRequests: listed(
          unhandledChangeRequests(core).map((r) => ({
            reportId: r.id,
            title: title(r.title),
            projectId: r.projectId,
            directiveId: r.directiveId,
            round: r.round,
            comments: ctx.store.reportComments.list({ ref1: r.id }).length,
          })),
          max,
        ),
      },
      main: {
        queue: listed(queue, max),
        byKind,
        reviews: listed(
          mainReviewTasks(ctx).map((t) => ({ taskId: t.id, title: title(t.title), projectId: t.projectId, state: t.state })),
          max,
        ),
        recovery: listed(
          core.recovery.items().map((x) => ({ requestId: x.requestId, kind: x.kind, projectId: x.projectId, taskId: x.taskId, finding: note(x.finding), startedAt: x.startedAt })),
          max,
        ),
        alerts: listed(
          work.filter(isMainHandOver).map((q) => ({
            entryId: q.id,
            kind: q.kind,
            label: handOverLabel(q),
            sessionKey: q.sessionKey,
            projectId: q.projectId,
            taskId: q.taskId,
            memberId: q.pausedMemberId ?? null,
            state: q.state,
            text: note(q.kind === 'alert' ? alertHead(q) : (q.message.split('\n')[0] ?? '')),
            ...(q.alertKey ? { alertKey: q.alertKey } : {}),
          })),
          max,
        ),
      },
      projects: listed(
        projects.map((p) => this.projectBlock(p, max, reach, running)),
        o.allProjects ? projects.length : max,
      ),
      notices: {
        unreadUrgent: listed(
          urgent.map((n) => ({ id: n.id, title: title(n.title), body: note(n.body), key: n.key, createdAt: n.createdAt })),
          max,
        ),
      },
      journal: {
        openPromises: {
          total: open.length,
          items: open.slice(0, JOURNAL_OPEN_PROMISES_LISTED).map((r) => ({
            id: r.id,
            at: r.at,
            generation: r.generation,
            holder: r.holder,
            text: note(r.text),
            refs: r.refs.map((x) => x.id),
            ...core.journal.promiseMarks(r),
          })),
        },
        recent: {
          total: ctx.store.journal.count({ kinds: JOURNAL_RECENT_KINDS }),
          items: recent.map((r) => ({ id: r.id, at: r.at, kind: r.kind, author: r.author, trust: r.author === 'server' ? ('fact' as const) : ('claim' as const), projectId: r.projectId, text: note(r.text) })),
        },
      },
    };
    return ctx.redact.value(overview);
  }

  /** 프로젝트 칸 하나 */
  private projectBlock(p: Project, max: number, reach: HoldReach, running: readonly Turn[]): OverviewProject {
    const ctx = this.ctx;
    const core = this.core;
    const stop = ctx.stop().projects[p.id];
    const open = ctx.store.directives.list({ project_id: p.id }).filter((d) => isDirectiveOpen(d));
    const active = open.filter((d) => d.state !== 'awaiting_confirmation').length;
    const roundTasks = open.flatMap((d) => directiveTasks(ctx, d.id, d.round));
    const inRound = new Set(roundTasks.map((t) => t.id));
    const tasks = { waiting: 0, in_progress: 0, on_hold: 0, in_review: 0, done: 0, cancelled: 0, otherOpenTasks: 0 };
    for (const t of roundTasks) tasks[t.state] += 1;
    const all = ctx.store.tasks.list({ project_id: p.id });
    tasks.otherOpenTasks = all.filter((t) => !inRound.has(t.id) && t.state !== 'done' && t.state !== 'cancelled').length;
    const producer = ctx.store.members.get(p.producerId);
    const members = ctx.store.members.list({ project_id: p.id, state: 'active' }).map((m) => core.views.memberView(m));
    return {
      id: p.id,
      name: this.safeLine(p.name, TITLE_MAX),
      producer: producer ? { memberId: producer.id, name: producer.name, status: MEMBER_STATUS_LABEL[core.views.memberView(producer).status] } : null,
      paused: stop?.paused ? { mode: stop.mode, by: stop.by, since: stop.since, ...(stop.reason ? { reason: this.safeLine(stop.reason, NOTE_MAX) } : {}) } : null,
      directives: { active, awaitingConfirmation: open.length - active },
      tasks,
      holds: listed(
        all
          .filter((t) => t.state === 'on_hold')
          .map((t) => ({
            taskId: t.id,
            title: this.safeLine(t.title, TITLE_MAX),
            reasons: t.hold.reasons.map((r) => ({ kind: r.kind, label: HOLD_REASON_LABEL[r.kind], note: this.safeLine(r.note, NOTE_MAX), since: r.since, by: r.by, reachesMain: reach.reason(t, r) })),
          })),
        max,
      ),
      running: listed(
        running
          .filter((t) => (t.projectId ?? t.workProjectId ?? null) === p.id)
          .map((t) => {
            const live = core.turns.liveOf(t.memberId);
            const mine = live?.turnId === t.id;
            const last = mine ? core.turns.lastLineOf(t.memberId) : null;
            return {
              turnId: t.id,
              memberId: t.memberId,
              name: memberName(ctx, t.memberId),
              taskId: t.taskId,
              work: mine && live!.label ? live!.label : SESSION_KIND_LABEL[t.sessionKind],
              startedAt: t.startedAt,
              lastOutputAt: t.lastActivityAt ?? null,
              lastLine: last ? this.safeLine(last.text, NOTE_MAX) : null,
            };
          }),
        max,
      ),
      members: listed(
        members.map((m) => ({ memberId: m.id, name: m.name, roleName: m.roleName, isProducer: m.isProducer, status: MEMBER_STATUS_LABEL[m.status], queued: m.queuedCount })),
        max,
      ),
      producerQuestions: listed(
        ctx.store.questions
          .list({ project_id: p.id, state: 'open' })
          .filter((q) => q.to === 'producer')
          .map((q) => ({ questionId: q.id, fromId: q.fromId, fromName: memberName(ctx, q.fromId), taskId: q.taskId, text: this.safeLine(q.text, NOTE_MAX), createdAt: q.createdAt })),
        max,
      ),
    };
  }

  /**
   * 현황 요약 (SERVER_DESIGN 5.1, 리드 결정 S5-4) — 1,500자 이하. 차례는 ① 정지 ② 대표 쪽(질문·승인 대기 보고·처리하지 않은 수정 요청 ID) ③ 메인이 할 일(남은
   * 업무의 종류별 수 — excludeEntryIds(이 턴이 실은 일)는 빼고, 메인 검수, 복구 확인, 넘겨받은 보류) ④ 진행 중 프로젝트마다 한 줄(지금 대화의 프로젝트 먼저) ⑤ 열린 약속(수와
   * 오래된 3건). 응답 없음 줄은 넣지 않는다 — 이 턴이 도는 동안에도 그 표시가 남아 있어(정상으로 끝나야 지워진다) 이 턴에게는 사실이 아니다
   */
  digest(o: { sessionKey: string; excludeEntryIds?: ReadonlySet<string> }): string {
    // 프로젝트 줄은 진행 중 프로젝트 모두에서 — get_overview의 100건 상한을 거치지 않는다. 1,500자 안으로 줄이는 것은 fitDigest가 한다 (리드 결정 S5-27)
    const v = this.build({ detail: true, excludeEntryIds: o.excludeEntryIds, allProjects: true });
    const { kind, ref } = parseKey(o.sessionKey);
    const current = kind === 'main_project' ? ref : null;
    const rows: DigestRow[] = [];

    // ① 정지
    const stopParts = [part(v.stop.emergency.active ? `긴급 정지 중(${hm(v.stop.emergency.since)} UTC부터)` : '긴급 정지 없음')];
    const pp = v.stop.pausedProjects;
    if (pp.length) stopParts.push(part(`일시정지된 프로젝트 ${pp.length}개`, pp.map((x) => `${x.projectId}(${x.mode === 'immediate' ? '즉시' : '단계 마치고'})`)));
    const pm = v.stop.pausedMembers;
    if (pm.length) stopParts.push(part(`일시정지된 팀원 ${pm.length}명`, pm.map((x) => `${line(x.name, 20)}(${x.memberId})`)));
    if (v.stop.heldByEmergency) stopParts.push(part(`긴급 정지 보류가 남은 작업 ${v.stop.heldByEmergency}건`));
    rows.push({ lead: '정지: ', parts: stopParts });
    // 이 PC의 CPU — 사용률을 알 때만. 상한 이상이면 프로그램이 새 일을 미루고 있음을 함께 적는다 (대표 지시 2026-11-18, cpuGuard.ts)
    if (v.cpu.percent !== null) {
      rows.push({ lead: '서버 PC CPU: ', parts: [part(v.cpu.holding ? `${v.cpu.percent}%(상한 ${v.cpu.limit}% 이상 — 새 팀 턴과 host_exec를 내려갈 때까지 미루는 중)` : `${v.cpu.percent}%(상한 ${v.cpu.limit}%)`)] });
    }

    // ② 대표 쪽
    const { questions, reportsAwaitingApproval: waiting, changeRequests } = v.owner;
    rows.push({
      lead: '대표 쪽: ',
      parts: [
        part(`답을 기다리는 질문 ${questions.total}건`, questions.items.map((x) => x.questionId), questions.total),
        part(`승인을 기다리는 보고 ${waiting.total}건`, waiting.items.map((x) => (x.unread ? `${x.reportId}(읽지 않음)` : x.reportId)), waiting.total),
        part(`처리하지 않은 수정 요청 ${changeRequests.total}건`, changeRequests.items.map((x) => x.reportId), changeRequests.total),
      ],
    });

    // ③ 메인이 할 일 — 이 턴이 실은 일은 뺀 수
    const kinds = (Object.entries(v.main.byKind) as [WorkKind, number][]).map(([k, n]) => `${WORK_KIND_LABEL[k]} ${n}`);
    const left = (Object.values(v.main.byKind) as number[]).reduce((a, b) => a + b, 0);
    const { reviews, recovery, alerts } = v.main;
    rows.push({
      lead: '메인이 할 일: ',
      parts: [
        part(left ? `남은 업무 ${left}건(${kinds.join('·')})` : '남은 업무 없음'),
        part(`메인 검수 ${reviews.total}건`, reviews.items.map((x) => x.taskId), reviews.total),
        part(`복구 확인 ${recovery.total}건`, recovery.items.map((x) => x.requestId), recovery.total),
        part(`넘겨받은 보류·남는 업무 ${alerts.total}건`, alerts.items.map((x) => x.label), alerts.total),
      ],
    });

    // ④ 진행 중 프로젝트마다 한 줄 — 지금 대화의 프로젝트 먼저(줄일 때 맨 아래부터 빼므로 남는다), 나머지는 ID 차례
    const ordered = v.projects.items.slice().sort((a, b) => (a.id === current ? -1 : b.id === current ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const p of ordered) {
      const counts = TASK_STATES.filter((s) => p.tasks[s]).map((s) => `${TASK_STATE_LABEL[s]} ${p.tasks[s]}`);
      const head = [
        `진행 중 지시 ${p.directives.active}건`,
        ...(p.directives.awaitingConfirmation ? [`확인 대기 지시 ${p.directives.awaitingConfirmation}건`] : []),
        counts.length ? `작업 ${counts.join('·')}` : '작업 없음',
        ...(p.tasks.otherOpenTasks ? [`그 밖의 열린 작업 ${p.tasks.otherOpenTasks}건`] : []),
        ...(p.paused ? [`일시정지(${p.paused.mode === 'immediate' ? '즉시' : '단계 마치고'})`] : []),
      ].join(', ');
      const parts = [part(head)];
      if (p.holds.total) {
        parts.push(
          part(
            `보류 ${p.holds.total}건`,
            p.holds.items.map((h) => `${h.taskId}(${[...new Set(h.reasons.map((r) => r.label))].join('·')}${h.reasons.some((r) => r.reachesMain) ? ', 메인에게 감' : ''})`),
            p.holds.total,
          ),
        );
      }
      if (p.running.total) parts.push(part(`일하는 팀원 ${p.running.total}명`, p.running.items.map((r) => `${line(r.name, 20)}(${r.memberId})`), p.running.total));
      rows.push({ lead: `${p.id} ${line(p.name, 40)} — `, parts, project: true });
    }

    // ⑤ 열린 약속 — 수와 오래된 3건
    const promises = v.journal.openPromises;
    rows.push({
      lead: '',
      parts: [
        part(
          `열린 약속 ${promises.total}건`,
          promises.items.slice(0, DIGEST_PROMISES).map((r) => `${r.id} "${line(r.text, 40)}"${r.stale ? '(오래됨)' : ''}${r.needsCheck ? '(확인 필요)' : ''}`),
          promises.total,
        ),
      ],
    });
    return fitDigest(rows, (s) => this.ctx.redact.text(s), v.projects.total);
  }

  /** 턴 메시지에 넣을 현황 요약과 계산한 때 (turns.ts begin) — 만들지 못하면 기록만 하고 요약 없이 턴을 띄운다 */
  digestFor(sessionKey: string, excludeEntryIds: ReadonlySet<string>): { text: string; at: string } | null {
    try {
      return { text: this.digest({ sessionKey, excludeEntryIds }), at: this.ctx.now() };
    } catch (e) {
      this.ctx.log('warn', `현황 요약을 만들지 못했습니다 (${sessionKey}) — 요약 없이 턴을 띄웁니다`, e);
      return null;
    }
  }

  /** 열린 질문 (list_questions, 리드 결정 S5-6) — 오래된 것부터 100건까지 */
  questions(projectId?: string): QuestionList {
    const ctx = this.ctx;
    const all = openQuestions(ctx, projectId);
    const items = all.slice(0, QUESTION_LIST_MAX).map((q) => ({
      questionId: q.id,
      to: q.to,
      fromId: q.fromId,
      fromName: memberName(ctx, q.fromId),
      projectId: q.projectId,
      taskId: q.taskId,
      directiveId: q.directiveId,
      text: cut(ctx.redact.text(q.text), QUESTION_TEXT_MAX),
      createdAt: q.createdAt,
    }));
    const omitted = all.length - items.length;
    return ctx.redact.value({ total: all.length, items, ...(omitted ? { message: `열린 질문 ${all.length}건 중 오래된 ${items.length}건만 보입니다 — 외 ${omitted}건` } : {}) });
  }
}
