/**
 * 인계 꾸러미와 인계 메모 턴 (SERVER_DESIGN 4.3 3·6번·6.2, 리드 결정 S4-6).
 * - 꾸러미는 서버가 DB에서 정해진 규칙으로 만든다 — 같은 기록과 같은 때면 늘 같은 꾸러미다. 순서는 6.2 그대로: ① 자리 정보 ② 확인된 사실(기록에서 만든 것)
 *   ③ 이전 메인 에이전트의 메모(확인되지 않은 주장) ④ 기억 문서 위치. 글(머리 줄 포함)은 12,000자를 넘지 않는다 — 넘치면 줄이 가장 많은 묶음부터 덜
 *   중요한 줄을 빼고 '외 n건'으로 남긴다. 나가는 보유자가 한 번도 답하지 않아도 만들어진다(기록만 쓴다). 저장 전에 가린다
 * - 세대별로 seat_handover에 저장하고(seat.ts 6번), 새 세대의 키별 첫 세션 handoverSummary에 넣는다. 40턴 세션 교체(MEM-09) 때는 지금 기록으로 다시 만든
 *   최신판을 넣는다 (turns.ts resolveSession)
 * - 인계 메모 턴(3번): 운영자가 강제 없이 바꿀 때 나가는 보유자에게 한 번(최대 2분). 그 턴은 journal_write·write_memory와 조회 도구만 쓴다(tools.ts).
 *   메인이 스스로 넘긴 교체(hand_off_seat)는 그 턴이 남길 말을 적는 턴이라 따로 주지 않는다(4.3 '2·3번은 지금 턴을 마치면'). 운영자 강제·사용량 한도·
 *   재로그인 필요·CLI 문제·정지 중이면 건너뛴다. 나가는 보유자가 외부 에이전트면(7단계, 리드 결정 S7-4) 2분 안에 일을 받으러 올 때만 준다 — 살아 있는 임대가 없거나
 *   그 안에 오지 않으면 '외부 보유자가 연결돼 있지 않음'으로 건너뛴다
 */
import type { QueueEntry } from '@shared/domain';
import { MAIN_AGENT_ID } from '@shared/domain';
import { DIRECTIVE_STATE_LABEL, TASK_STATE_LABEL, WORK_KIND_LABEL } from '@shared/labels';
import type { HandoverSection } from '@shared/views';
import { isDirectiveOpen } from '@core/directiveMachine';
import { pickStarts } from '@core/scheduling';
import { BackendError } from '../backend/types';
import type { TokenIdentity } from '../mcp/types';
import type { JournalRow, SeatHolder, SeatSwapRow } from '../db/store';
import type { Core } from './core';
import { holderLabel, seatGenerationId, type SeatHooks } from './seat';
import { cancelQueued, enqueue, parseKey, slotClassOf } from './records';
import { projectMemoryFile } from './paths';
import { JOURNAL_OPEN_PROMISES_LISTED } from './journal';
import { mainReviewTasks, mainWork, reportsAwaitingApproval, unhandledChangeRequests } from './overview';
import { alertHead, alertLabel } from './alerts';

/** 꾸러미 글의 상한 (6.2) */
export const HANDOVER_MAX_CHARS = 12_000;
/** 인계 메모 턴의 상한 (4.3 3번) */
export const MEMO_TURN_MS = 120_000;
/** 인계 메모 업무의 표시 — 이 글로 시작하는 메인 기억 갱신 업무가 인계 메모다 */
export const MEMO_MARK = '[메인 자리 인계 메모]';
/** 나가는 외부 보유자에게 메모 턴을 주지 않은 까닭 (리드 결정 S7-4) */
export const EXTERNAL_MEMO_SKIP = '외부 보유자가 연결돼 있지 않음';
/** 멈춘 메모 턴의 마무리(종료 판정)를 기다리는 상한 — seat.ts와 같다 */
const STOP_SETTLE_MS = 15_000;

const SECTION_TITLE: Readonly<Record<HandoverSection['key'], string>> = {
  seat: '자리 정보',
  facts: '확인된 사실 (기록에서 만든 것)',
  memos: '이전 메인 에이전트의 메모 (확인되지 않은 주장)',
  memory: '기억 문서 위치',
};

const CHANGED_BY_LABEL: Readonly<Record<'main' | 'operator' | 'server', string>> = { main: '메인 에이전트', operator: '운영자', server: '서버' };

const clip = (s: string, max: number): string => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
/** 꾸러미의 때 — 분까지 (UTC) */
const at = (iso: string): string => `${iso.slice(0, 16)}Z`;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.());

/** 한 칸 안의 묶음 — 넘치면 drop 쪽부터 줄을 뺀다 */
interface Group {
  title: string;
  items: string[];
  /** 기록에 있는 전체 건수 (뺀 줄 = total - items.length) */
  total: number;
  /** 'start': 오래된 것부터 뺀다(시간 차례 목록) · 'end': 뒤에서부터 */
  drop: 'start' | 'end';
}

interface DraftSection {
  key: HandoverSection['key'];
  /** 자리·기억 칸은 줄이지 않는다 */
  lines?: string[];
  groups?: Group[];
  fixedOmitted?: number;
}

/** 묶음 → 칸의 줄 */
function groupLines(g: Group): string[] {
  const omitted = g.total - g.items.length;
  const head = g.total === 0 ? `[${g.title}] 없음` : `[${g.title}] ${g.total}건${omitted ? ` — 아래 ${g.items.length}건, 외 ${omitted}건` : ''}`;
  return [head, ...g.items.map((i) => `- ${i}`)];
}

function finishSection(d: DraftSection): HandoverSection {
  const lines = d.lines ?? (d.groups ?? []).flatMap(groupLines);
  const omitted = (d.fixedOmitted ?? 0) + (d.groups ?? []).reduce((n, g) => n + g.total - g.items.length, 0);
  return { key: d.key, title: SECTION_TITLE[d.key], unverified: d.key === 'memos', lines, omitted };
}

/** 꾸러미 글 — 세션 인계(handoverSummary)·get_handover가 이 글을 쓴다. chars는 이 글의 길이다 */
export function renderHandover(p: { generation: number; createdAt: string; sections: readonly HandoverSection[] }): string {
  const parts = [
    `[메인 자리 인계 꾸러미 — 세대 ${p.generation}, ${p.createdAt} 기준]`,
    "서버가 기록에서 만든 것입니다. '이전 메인 에이전트의 메모'는 확인되지 않은 주장이니 기록과 견주어 확인하세요.",
  ];
  for (const s of p.sections) parts.push('', `## ${s.title}`, ...s.lines);
  return parts.join('\n');
}

/**
 * 칸들을 상한 안으로 줄인다 — 줄이 가장 많이 남은 묶음(같으면 뒤 칸·뒤 묶음)에서 한 줄씩 뺀다. 자리·기억 칸은 그대로다. 같은 입력이면 늘 같은 결과다
 */
function fitSections(drafts: DraftSection[], generation: number, createdAt: string): HandoverSection[] {
  const length = () => renderHandover({ generation, createdAt, sections: drafts.map(finishSection) }).length;
  while (length() > HANDOVER_MAX_CHARS) {
    let pick: Group | null = null;
    for (const d of drafts) for (const g of d.groups ?? []) if (g.items.length && (!pick || g.items.length >= pick.items.length)) pick = g;
    if (!pick) break;
    pick.items = pick.drop === 'start' ? pick.items.slice(1) : pick.items.slice(0, -1);
  }
  return drafts.map(finishSection);
}

/** 꾸러미의 메모 칸이 '넘길 때 남긴 글'로 싣는 것 — 나가는 세대가 교체를 시작한 뒤에 적은 메모와 넘기며 남긴 말 */
export interface MemoWindow {
  generation: number;
  since: string;
  note: string | null;
}

export class HandoverService {
  constructor(private readonly core: Core) {}

  private get ctx() {
    return this.core.ctx;
  }

  /** 자리 교체의 3·6번 (seat.ts SeatService.hooks) */
  seatHooks(): SeatHooks {
    return {
      memoTurn: (swap) => this.memoTurn(swap),
      packetSections: (swap, _holder, seat, now) => {
        const sections = this.build({ seat, generation: swap.to, now, memo: { generation: swap.from, since: swap.requestedAt, note: swap.note } });
        return { sections, chars: renderHandover({ generation: swap.to, createdAt: now, sections }).length };
      },
    };
  }

  // ───────────────────────── 꾸러미 ─────────────────────────

  /** 자리 칸 뒤의 칸을 만들고 상한 안으로 줄인다 (6.2). 글은 모두 가린다 */
  build(i: { seat: HandoverSection; generation: number; now: string; memo: MemoWindow | null }): HandoverSection[] {
    const redact = this.ctx.redact;
    const drafts: DraftSection[] = [
      { key: 'seat', lines: i.seat.lines, fixedOmitted: i.seat.omitted },
      { key: 'facts', groups: this.facts() },
      { key: 'memos', groups: this.memos(i.memo) },
      this.memoryDocs(),
    ];
    for (const d of drafts) {
      if (d.lines) d.lines = d.lines.map((l) => redact.text(l));
      for (const g of d.groups ?? []) g.items = g.items.map((l) => redact.text(l));
    }
    return fitSections(drafts, i.generation, i.now);
  }

  /** ② 확인된 사실 — 기록에서 만든 것 */
  private facts(): Group[] {
    const ctx = this.ctx;
    const store = ctx.store;
    const groups: Group[] = [];
    // M-MAIN이 대표·프로듀서에게 물어 놓고 답을 받지 못한 질문
    const questions = store.questions.list({ state: 'open', ref2: MAIN_AGENT_ID });
    groups.push({
      title: '답을 받지 못한 질문',
      total: questions.length,
      drop: 'end',
      items: questions.map((q) => `${q.id} ${q.to === 'owner' ? '대표에게' : '프로듀서에게'}${q.projectId ? ` (${q.projectId})` : ''}, ${at(q.createdAt)}: ${clip(q.text, 300)}`),
    });
    // 닫히지 않은 지시와 작업 상태 (확인 대기는 아래 묶음)
    const directives = store.directives.list().filter((d) => isDirectiveOpen(d));
    const working = directives.filter((d) => d.state !== 'awaiting_confirmation');
    groups.push({
      title: '닫히지 않은 지시와 작업',
      total: working.length,
      drop: 'end',
      items: working.map((d) => {
        const tasks = store.tasks.list({ ref1: d.id }).filter((t) => t.round === d.round);
        return clip(`${d.id} "${clip(d.title, 80)}" (${d.projectId ?? '일반'}, ${d.round}회차, ${DIRECTIVE_STATE_LABEL[d.state]}) — 작업: ${tasks.map((t) => `${t.id} ${TASK_STATE_LABEL[t.state]}`).join(', ') || '없음'}`, 400);
      }),
    });
    // 대기 중이거나 실행 중이던 M-MAIN 일 (키별) — 인계 메모 업무는 뺀다. 메인이 검수자인 작업도 넣는다. 고르는 함수는 현황(overview.ts)과 같다 (리드 결정 S5-3)
    const work = mainWork(ctx, isMemoEntry);
    const byKey = new Map<string, QueueEntry[]>();
    for (const q of work) byKey.set(q.sessionKey, [...(byKey.get(q.sessionKey) ?? []), q]);
    const keyItems = [...byKey].map(([key, qs]) => {
      const kinds = new Map<string, number>();
      for (const q of qs) kinds.set(WORK_KIND_LABEL[q.kind], (kinds.get(WORK_KIND_LABEL[q.kind]) ?? 0) + 1);
      return `${key}: ${[...kinds].map(([k, n]) => `${k} ${n}건`).join(', ')}${qs.some((q) => q.state === 'running') ? ' (실행 중이던 것 포함)' : ''}`;
    });
    const reviews = mainReviewTasks(ctx).map((t) => `review:${t.id} 메인 검수 — "${clip(t.title, 80)}" (${t.projectId}, ${TASK_STATE_LABEL[t.state]})`);
    groups.push({ title: '메인이 맡은 일 (키별 대기·실행, 메인 검수)', total: keyItems.length + reviews.length, drop: 'end', items: [...keyItems, ...reviews] });
    // 대상별 최근 대화 5건
    const targets = ['main', ...store.projects.list({ state: 'active' }).map((p) => p.id)];
    for (const target of targets) {
      const recent = store.conversation.list({ ref1: target }, { desc: true, limit: 5 }).reverse();
      if (!recent.length) continue;
      const name = target === 'main' ? '직접 명령' : `${target} ${store.projects.get(target)?.name ?? ''}`.trim();
      groups.push({
        title: `최근 대화 — ${name}`,
        total: recent.length,
        drop: 'start',
        items: recent.map((m) => `${at(m.createdAt)} ${m.role === 'owner' ? '대표' : m.role === 'main_agent' ? '메인' : '알림'}: ${clip(m.text, 200)}`),
      });
    }
    // 대표 승인을 기다리는 보고, 처리하지 않은 대표 수정 요청, 확인을 기다리는 지시
    const waiting = reportsAwaitingApproval(ctx);
    groups.push({
      title: '대표 승인을 기다리는 보고',
      total: waiting.length,
      drop: 'end',
      items: waiting.map((r) => `${r.id} "${clip(r.title, 80)}" (${r.projectId ?? '일반'}${r.directiveId ? `, 지시 ${r.directiveId}` : ''}, ${at(r.createdAt)})`),
    });
    const changes = unhandledChangeRequests(this.core);
    groups.push({
      title: '처리하지 않은 대표 수정 요청',
      total: changes.length,
      drop: 'end',
      items: changes.map((r) => {
        const comments = store.reportComments.list({ ref1: r.id }).map((c) => (c.quote ? `"${clip(c.quote, 40)}" → ${c.text}` : c.text));
        return clip(`${r.id} "${clip(r.title, 80)}"${r.directiveId ? ` (지시 ${r.directiveId})` : ''} — 대표 코멘트: ${comments.join(' / ') || '(없음)'}`, 400);
      }),
    });
    const confirming = directives.filter((d) => d.state === 'awaiting_confirmation');
    groups.push({
      title: '확인을 기다리는 지시',
      total: confirming.length,
      drop: 'end',
      items: confirming.map((d) => `${d.id} "${clip(d.title, 80)}" (${d.projectId ?? '일반'}, ${d.round}회차, 보고서 ${d.rounds.find((r) => r.round === d.round)?.reportId ?? '없음'})`),
    });
    // 메인이 처리할 일: 복구 확인, 정지 해제 뒤 보류, 검수자 없음, 대표에게만 가던 보류·실패를 넘긴 알림 업무 (리드 결정 S5-7)
    const recovery = this.core.recovery.items().map((x) => `복구 확인 ${x.requestId} (${x.kind}${x.taskId ? `, ${x.taskId}` : ''}): ${clip(x.finding, 200)}`);
    const handed = work
      .filter((q) => q.kind === 'stop_released' || q.kind === 'no_reviewer' || q.kind === 'alert')
      .map((q) => `${q.kind === 'alert' ? alertLabel(q) : WORK_KIND_LABEL[q.kind]} (${q.sessionKey}): ${clip(q.kind === 'alert' ? alertHead(q) : q.message.split('\n')[0]!, 200)}`);
    groups.push({ title: '메인이 처리할 일 (복구 확인·정지 해제 뒤 보류·검수자 없음·넘겨받은 보류와 실패)', total: recovery.length + handed.length, drop: 'end', items: [...recovery, ...handed] });
    // 최근 메인 행동 20건 (일지의 서버 기록)
    const actions = store.journal.query({ author: 'server', kinds: ['action'], limit: 20 }).reverse();
    groups.push({
      title: '최근 메인 행동 (일지의 서버 기록)',
      total: actions.length,
      drop: 'start',
      items: actions.map((r) => `${at(r.at)} [세대 ${r.generation}] ${clip(r.text, 300)}`),
    });
    return groups;
  }

  /** ③ 이전 메인 에이전트의 메모 — 확인되지 않은 주장. 쓴 보유자와 세대를 붙인다 */
  private memos(memo: MemoWindow | null): Group[] {
    const store = this.ctx.store;
    const journal = this.core.journal;
    const tag = (r: JournalRow) => `${r.id} [세대 ${r.generation} · ${r.holder} · ${at(r.at)}]`;
    const refs = (r: JournalRow) => (r.refs.length ? ` (참조: ${r.refs.map((x) => x.id).join(', ')})` : '');
    const open = store.journal.query({ openPromisesOnly: true, asc: true });
    const listed = open.slice(0, JOURNAL_OPEN_PROMISES_LISTED);
    const promises: Group = {
      title: '열린 약속',
      total: open.length,
      drop: 'end',
      items: listed.map((r) => {
        const m = journal.promiseMarks(r);
        return clip(`${tag(r)}${m.stale ? ' (오래됨)' : ''}${m.needsCheck ? ' (확인 필요 — 참조한 지시가 닫힘)' : ''}: ${r.text}${refs(r)}`, 600);
      }),
    };
    const decisions = store.journal.query({ author: 'agent', kinds: ['decision'], limit: 10 }).reverse();
    const recent: Group = { title: '최근 결정', total: decisions.length, drop: 'start', items: decisions.map((r) => clip(`${tag(r)}: ${r.text}${refs(r)}`, 600)) };
    const left: string[] = [];
    if (memo?.note) left.push(clip(`넘기며 남긴 말 (세대 ${memo.generation}): ${memo.note}`, 600));
    if (memo) {
      const notes = store.journal.query({ author: 'agent', kinds: ['note'], generation: memo.generation, asc: true }).filter((r) => r.at >= memo.since);
      left.push(...notes.map((r) => clip(`${tag(r)}: ${r.text}${refs(r)}`, 600)));
    }
    return [promises, recent, { title: '넘길 때 남긴 글 (인계 메모)', total: left.length, drop: 'end', items: left }];
  }

  /** ④ 기억 문서 위치 — 프로젝트별과 general.md */
  private memoryDocs(): DraftSection {
    const ctx = this.ctx;
    const projects = ctx.store.projects.list({ state: 'active' });
    const shown = projects.slice(0, 40);
    return {
      key: 'memory',
      lines: [
        `일반 기억: ${projectMemoryFile(ctx.paths, null)} — read_memory(project_id 없이)`,
        ...shown.map((p) => `${p.id} ${p.name}: ${projectMemoryFile(ctx.paths, p.id)} — read_memory(project_id="${p.id}")`),
        ...(projects.length > shown.length ? [`외 ${projects.length - shown.length}개 프로젝트 — list_projects로 보세요`] : []),
      ],
      fixedOmitted: projects.length - shown.length,
    };
  }

  /** 저장된 그 세대의 꾸러미 글 (없으면 null) */
  storedText(generation: number): string | null {
    const p = this.ctx.store.seatHandovers.get(seatGenerationId(generation));
    return p ? renderHandover(p) : null;
  }

  /**
   * 지금 기록으로 다시 만든 최신판 (MEM-09 세션 교체·get_handover latest) — 자리 칸은 지금 보유자와 이 세대가 열린 까닭, 메모 칸의 '넘길 때 남긴 글'은 이 세대를
   * 연 교체의 것. 저장하지 않는다 (seat_handover는 교체 때 넘겨받은 그대로 둔다)
   */
  latest(generation: number): { text: string; sections: HandoverSection[]; chars: number; createdAt: string } {
    const ctx = this.ctx;
    const now = ctx.now();
    const h = ctx.store.seatHistory.get(seatGenerationId(generation));
    const prev = generation > 1 ? ctx.store.seatHistory.get(seatGenerationId(generation - 1)) : null;
    const stored = ctx.store.seatHandovers.get(seatGenerationId(generation));
    const seat: HandoverSection = {
      key: 'seat',
      title: SECTION_TITLE.seat,
      unverified: false,
      lines: [
        `지금 보유자: ${h ? holderLabel(h.holder) : (this.core.seat.view().holder?.label ?? '없음')} (세대 ${generation}${h ? `, ${h.startedAt}부터` : ''})`,
        ...(h ? [`이 세대를 연 쪽: ${CHANGED_BY_LABEL[h.changedBy]} — 까닭: ${h.startReason}`] : []),
        ...(prev ? [`이전 보유자: ${holderLabel(prev.holder)} (세대 ${prev.generation})`] : []),
        '이 꾸러미는 세션을 새로 열 때(대화가 길어진 세션 교체 등) 지금 기록으로 다시 만든 최신판입니다',
      ],
      omitted: 0,
    };
    const memo: MemoWindow | null = prev?.endedAt && stored ? { generation: prev.generation, since: prev.endedAt, note: stored.note ?? null } : null;
    const sections = this.build({ seat, generation, now, memo });
    const text = renderHandover({ generation, createdAt: now, sections });
    return { text, sections, chars: text.length, createdAt: now };
  }

  /** get_handover (6.2 '언제든 다시 볼 수 있다'): 세대를 주면 그 세대에 넘겨받은 꾸러미, latest면 지금 기록으로 만든 최신판 */
  toolGet(identity: TokenIdentity, a: { generation?: number; latest?: boolean }): Record<string, unknown> {
    const g = a.generation ?? identity.seatGeneration ?? this.core.seat.generation();
    if (a.latest) {
      const l = this.latest(this.core.seat.generation());
      return { generation: this.core.seat.generation(), latest: true, createdAt: l.createdAt, chars: l.chars, text: l.text };
    }
    const p = this.ctx.store.seatHandovers.get(seatGenerationId(g));
    if (!p) {
      if (a.generation !== undefined) throw new BackendError('not_found', `세대 ${g}의 인계 꾸러미가 없습니다 — 꾸러미는 자리를 교체해 시작한 세대에만 있습니다`);
      return { generation: g, latest: false, text: null, message: `세대 ${g}은(는) 교체로 시작한 세대가 아니라 넘겨받은 꾸러미가 없습니다. 지금 기록으로 만든 최신판은 latest: true로 보세요` };
    }
    return { generation: p.generation, latest: false, createdAt: p.createdAt, chars: p.chars, text: renderHandover(p) };
  }

  /**
   * 세션 인계에 넣을 꾸러미 글 (6.2 '전달 방법') — 메인 세션(main:*·메인 검수 review:*)만. 새 세대의 키별 첫 세션이면 그 세대에 저장된 꾸러미, 40턴 세션
   * 교체(MEM-09)면 지금 기록으로 만든 최신판. 그 밖에는 null
   */
  forSession(seatGeneration: number | null, prevGeneration: number | null | undefined, mem09: boolean): string | null {
    if (seatGeneration === null) return null;
    if (mem09) return this.latest(seatGeneration).text;
    if (prevGeneration === seatGeneration) return null;
    return this.storedText(seatGeneration);
  }

  // ───────────────────────── 인계 메모 턴 (3번) ─────────────────────────

  /** 3번을 건너뛰는 까닭 (줄 수 있으면 null) — 정지·한도·재로그인 같은 실행 조건은 memoTurn이 허용 검사로 본다 */
  private memoSkip(swap: SeatSwapRow, outgoing: SeatHolder | null): string | null {
    if (swap.memoSkip) return swap.memoSkip;
    if (swap.memoTurnId) return '인계 메모 턴을 이미 줬습니다';
    if (swap.by === 'main') return '메인 에이전트가 스스로 넘겨, 넘긴 턴(hand_off_seat)에서 남길 말을 적었습니다';
    if (swap.force) return '운영자 강제 교체';
    if (!outgoing) return '나가는 보유자가 없습니다';
    // 외부 보유자 (리드 결정 S7-4): 2분 안에 일을 받으러 오는 에이전트에게만 준다. 지금 세대의 살아 있는 임대가 없으면 교체 중에는 claim할 수 없어(409 switching) 올 수
    // 없으므로 곧바로 건너뛴다
    if (outgoing.kind === 'external' && !this.core.externalAgents.liveLease(outgoing.agentId, swap.from)) return EXTERNAL_MEMO_SKIP;
    return null;
  }

  /** 메모 턴의 세션 키 — 메인이 가장 최근에 쓴 대화(main:*), 없으면 직접 명령 */
  private memoKey(): string {
    const open = this.ctx.store.sessions
      .list({ ref1: MAIN_AGENT_ID, state: 'open' })
      .filter((s) => s.workKey.startsWith('main:'))
      .sort((a, b) => ((a.lastTurnAt ?? a.createdAt) < (b.lastTurnAt ?? b.createdAt) ? 1 : -1));
    return open[0]?.workKey ?? 'main:general';
  }

  /**
   * 나가는 보유자의 인계 메모 턴 — 최대 2분. 주지 않으면(건너뛸 까닭·허용 검사) 바로 null. 주면 업무를 넣고 그 턴이 끝날 때 풀리는 약속을 돌려준다
   * (memoRun)
   */
  private memoTurn(swap: SeatSwapRow): Promise<void | { unconfirmed: string }> | null {
    const ctx = this.ctx;
    const core = this.core;
    // 앞 실행이 메모 턴 중에 끝났으면 그 메모 업무가 남아 있다(재시작 복구가 다시 넣은 것 포함) — 새 보유자에게 가지 않게 먼저 지운다
    cancelQueued(ctx, (q) => isMemoEntry(q), `메인 자리 교체(세대 ${swap.to}) — 앞 실행의 인계 메모 업무`);
    const seatRow = ctx.store.seat.get('main');
    const skip = this.memoSkip(swap, seatRow?.holder ?? null);
    const note = (text: string) => ctx.activity({ kind: 'seat', text: `메인 자리 교체 (세대 ${swap.from} → ${swap.to}): ${text}` });
    if (skip) {
      note(`인계 메모 턴을 주지 않음 — ${skip}`);
      return null;
    }
    const member = ctx.store.members.get(MAIN_AGENT_ID);
    if (!member) return null;
    const key = this.memoKey();
    // 정지 중·사용량 한도·재로그인 필요·CLI 문제면 주지 않는다 — 스케줄러가 메인 턴을 띄우기 전에 보는 것과 같은 검사
    const gate = core.turns.entryRunGate(member, key, null, { kind: 'memory_update', taskId: null } as QueueEntry, ctx.stop(), ctx.clock.ms());
    if (!gate.ok) {
      note(`인계 메모 턴을 주지 않음 — 나가는 보유자가 지금 답할 수 없습니다 (${gate.detail})`);
      return null;
    }
    return this.memoRun(swap, key, note);
  }

  /**
   * 메모 업무를 넣고 실행 자리가 날 때까지 기다려(그 시간도 상한에 든다) 띄운다. 상한을 넘으면 멈추고, 멈춘 턴의 종료를 확인하지 못하면 그 까닭을 돌려준다
   * (겹쳐 띄우지 않는다, CTL-11). 끝나면 남은 메모 업무를 지운다 — 새 보유자에게 가지 않게
   */
  private async memoRun(swap: SeatSwapRow, key: string, note: (text: string) => void): Promise<void | { unconfirmed: string }> {
    const ctx = this.ctx;
    const core = this.core;
    const seatRow = ctx.store.seat.get('main');
    const ms = ctx.deps.timing?.memoTurnMs ?? MEMO_TURN_MS;
    const minutes = ms >= 60_000 ? `${Math.round(ms / 6_000) / 10}분` : `${Math.round(ms / 100) / 10}초`;
    const to = holderLabel(seatRow?.pendingHolder ?? null);
    const by = swap.by === 'operator' ? '운영자가 바꿈' : '서버';
    const { kind, ref } = parseKey(key);
    const entry = enqueue(ctx, {
      kind: 'memory_update',
      memberId: MAIN_AGENT_ID,
      sessionKey: key,
      projectId: kind === 'main_project' ? ref : null,
      priority: 'urgent',
      message: [
        `${MEMO_MARK} 메인 자리가 ${to}에게 넘어갑니다 (세대 ${swap.from} → ${swap.to}, ${by} — 까닭: ${swap.reason}).`,
        '다음 메인 에이전트가 이어받을 수 있게 지금 알고 있는 것을 남겨 주세요.',
        '- 지킬 약속은 journal_write(kind "promise")로 — 그 지시·질문 ID를 refs에 넣고, 없으면 언제 무엇으로 닫을지 reason에 적습니다',
        '- 정한 것은 kind "decision", 그 밖에 알릴 것은 kind "note"로 적습니다 (한 줄 1,000자, 이 턴에 5건까지)',
        '- 프로젝트 기억 문서는 read_memory로 읽은 뒤 write_memory로 고칩니다',
        `이 턴에는 journal_write·write_memory와 조회 도구만 쓸 수 있습니다. ${minutes} 안에 마치지 않으면 프로그램이 턴을 끝냅니다. 다 적었으면 턴을 마치세요.`,
      ].join('\n'),
    });
    const deadline = Date.now() + ms;
    let launched = false;
    let gateSkip: string | null = null;
    // 나가는 보유자가 외부 에이전트면 그 에이전트가 일을 받으러 와 있을 때만(그 세대의 열린 롱폴) 띄운다 — 2분 안에 오지 않거나 임대가 끝나면 주지 않는다 (리드 결정 S7-4)
    const outgoing = seatRow?.holder?.kind === 'external' ? seatRow.holder.agentId : null;
    let externalGone = false;
    try {
      while (!core.stopping && Date.now() < deadline) {
        if (outgoing && !core.externalAgents.liveLease(outgoing, swap.from)) {
          externalGone = true;
          break;
        }
        const candidate = { sessionKey: key, memberId: MAIN_AGENT_ID, slotClass: slotClassOf(key), priority: entry.priority, queuedAt: entry.queuedAt, urgent: false };
        const [pick] = pickStarts({ cap: ctx.settings().execution.maxConcurrent, running: core.turns.running(), candidates: [candidate] });
        if (pick && !core.turns.hasMemberFlow(MAIN_AGENT_ID) && (!outgoing || core.externalAgents.pollOpen(outgoing, swap.from))) {
          // 띄우기 바로 앞(같은 동기 구간)에서 허용 검사를 지금 정지 값·시계로 다시 본다 — 자리를 기다리는 동안 긴급 정지·메인 일시정지·사용량 한도·
          // 재로그인 필요가 생겼으면 메모 턴을 주지 않고 교체를 마친다 (리드 결정 S4-14)
          const member = ctx.store.members.get(MAIN_AGENT_ID);
          const gate = member ? core.turns.entryRunGate(member, key, null, entry, ctx.stop(), ctx.clock.ms()) : null;
          if (!gate?.ok) {
            gateSkip = gate?.detail ?? '메인 에이전트 기록이 없습니다';
            break;
          }
          core.turns.launch(pick, [entry.id]);
          const turnId = core.turns.liveOf(MAIN_AGENT_ID)?.turnId ?? null;
          core.seat.noteMemoTurn(swap.to, turnId);
          launched = true;
          note(`나가는 보유자에게 인계 메모 턴을 줌 (${key}, 최대 ${minutes})${turnId ? ` — ${turnId}` : ''}`);
          break;
        }
        await sleep(200);
      }
      if (core.stopping) return;
      if (gateSkip !== null) {
        note(`인계 메모 턴을 주지 않음 — 나가는 보유자가 지금 답할 수 없습니다 (${gateSkip})`);
        return;
      }
      if (!launched && outgoing) {
        note(`인계 메모 턴을 주지 않음 — ${EXTERNAL_MEMO_SKIP}${externalGone ? ' (기다리는 사이 임대가 끝남)' : ` (${minutes} 안에 일을 받으러 오지 않음)`}`);
        return;
      }
      if (!launched) {
        note(`인계 메모 턴을 띄우지 못함 — 실행 자리가 ${minutes} 안에 나지 않았습니다`);
        return;
      }
      const settled = await core.turns.settleMember(MAIN_AGENT_ID, Math.max(0, deadline - Date.now()));
      if (core.stopping || settled) return;
      const results = await core.turns.stopMember(MAIN_AGENT_ID, `메인 자리 교체(세대 ${swap.to}) — 인계 메모 시간(${minutes})을 넘김`, true);
      const confirmed = await core.turns.settleMember(MAIN_AGENT_ID, STOP_SETTLE_MS);
      const failed = results.filter((r) => !r.ok);
      if (failed.length || !confirmed) return { unconfirmed: failed.map((r) => r.detail).join('; ') || '멈춘 인계 메모 턴의 마무리가 끝나지 않았습니다' };
    } finally {
      // 끝나지 않은 메모 업무(띄우지 못함·끊긴 턴을 다시 넣은 것)는 새 보유자에게 가지 않게 지운다
      if (!core.stopping) cancelQueued(ctx, (q) => isMemoEntry(q), `메인 자리 교체(세대 ${swap.to}) — 인계 메모 시간이 끝남`);
    }
  }
}

/** 인계 메모 업무인지 (다시 넣은 것 포함 — 앞에 '(다시 전달)' 머리말이 붙는다) */
export function isMemoEntry(q: QueueEntry): boolean {
  return q.memberId === MAIN_AGENT_ID && q.kind === 'memory_update' && q.message.includes(MEMO_MARK);
}
