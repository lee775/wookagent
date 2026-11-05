/**
 * 메인 에이전트 일지 (SERVER_DESIGN 6.1·6.3, 리드 결정 S4-6). AI와 상관없이 서버가 쥐고 있는 인계 기록이다 — 보유자가 바뀌어도 다음 메인이 읽는다.
 * - 서버가 쓰는 사실(author server): 받은 명령, 메인이 상태를 바꾼 도구 호출(6.1 목록), 보고 도착·결과 승인·수정 요청, 자리 교체, 긴급 정지·해제.
 *   에이전트는 고칠 수 없다
 * - 에이전트가 쓰는 주장(author agent): journal_write(decision·promise·note)와 journal_close(약속 닫기). 쓴 보유자와 세대가 붙고, 인계 꾸러미의 '메모'
 *   칸에만 나온다(6.3)
 * - 분량: 한 줄 1,000자, 에이전트 기록은 턴당 5건, 꾸러미·목록의 열린 약속은 50건까지. 30일 지난 서버 기록은 월별 묶음(종류별 건수와 그달에 닫힌 약속)으로
 *   줄인다 — 원본은 백업에 남는다
 * - 비밀 값은 저장 전에 가린다(SEC-10). 7일 넘게 열린 약속은 '오래됨', 참조한 지시가 닫히면 '확인 필요' — 보일 때 지금 기록으로 정한다
 */
import { MAIN_AGENT_ID } from '@shared/domain';
import type { JournalEntryView, JournalFilter, JournalKind, JournalPage, JournalRef } from '@shared/views';
import { isDirectiveOpen } from '@core/directiveMachine';
import { BackendError } from '../backend/types';
import type { TokenIdentity } from '../mcp/types';
import type { JournalRefRow, JournalRollupRow, JournalRow } from '../db/store';
import type { Core } from './core';
import { holderLabel, seatGenerationId } from './seat';
import { parseKey } from './records';

/** 일지 한 줄의 상한 (6.3) */
export const JOURNAL_TEXT_MAX = 1000;
/** 한 턴에 에이전트가 쓸 수 있는 일지 (6.3) */
export const JOURNAL_AGENT_PER_TURN = 5;
/** 꾸러미·목록에 싣는 열린 약속 (6.2) */
export const JOURNAL_OPEN_PROMISES_LISTED = 50;
/** 이만큼 열린 약속은 '오래됨' (6.3) */
export const JOURNAL_STALE_MS = 7 * 24 * 3600_000;
/** 이만큼 지난 서버 기록은 월별 묶음으로 줄인다 (6.3) */
export const JOURNAL_ROLLUP_AFTER_MS = 30 * 24 * 3600_000;
const PAGE_DEFAULT = 50;
const PAGE_MAX = 200;
const REFS_MAX = 10;
/** 서버가 쓰는 종류 — 월별 묶음 대상 */
const SERVER_KINDS = ['command', 'action', 'report', 'seat', 'stop'] as const;
export type JournalServerKind = (typeof SERVER_KINDS)[number];
/** 에이전트가 쓰는 종류 */
const AGENT_KINDS = ['decision', 'promise', 'note'] as const;
type JournalAgentKind = (typeof AGENT_KINDS)[number];

const KIND_LABEL: Readonly<Record<JournalKind, string>> = {
  command: '받은 명령',
  action: '메인 행동',
  report: '보고',
  seat: '자리',
  stop: '정지',
  decision: '결정',
  promise: '약속',
  note: '메모',
  rollup: '월별 묶음',
};

/** 참조 ID의 모양 → 종류 (journal_write의 refs) */
const REF_PATTERNS: readonly [RegExp, JournalRef['kind']][] = [
  [/^D-\d+$/, 'directive'],
  [/^Q-\d+$/, 'question'],
  [/^R-\d+$/, 'report'],
  [/^T-\d+$/, 'task'],
  [/^P-\d+$/, 'project'],
  [/^M-(?:\d+|MAIN)$/, 'member'],
];

/** 다음 쪽 표시 — 그 쪽 마지막 줄의 때와 순번 */
const CURSOR_RE = /^c(\d{1,15})@(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)$/;
const cursorOf = (r: JournalRow): string => `c${r.seq}@${r.at}`;

const clip = (s: string, max: number): string => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** 서버 기록을 남길 때의 칸 */
export interface JournalServerInput {
  projectId?: string | null;
  refs?: JournalRefRow[];
  workKey?: string | null;
  turnId?: string | null;
  /** 그 행동을 한 메인 턴의 세대 (없으면 지금 세대) */
  generation?: number;
}

export class JournalService {
  constructor(private readonly core: Core) {}

  private get ctx() {
    return this.core.ctx;
  }

  /** 그 세대의 보유자 이름 — 자리 이력에서, 없으면 지금 자리에서 */
  holderOf(generation: number): string {
    const h = this.ctx.store.seatHistory.get(seatGenerationId(generation));
    if (h) return holderLabel(h.holder);
    return this.core.seat.view().holder?.label ?? '없음';
  }

  // ───────────────────────── 서버 기록 ─────────────────────────

  /**
   * 서버가 적는 사실 한 줄 (6.1). 기록이 실패해도 그 일(명령·도구·승인 등)은 이미 일어났으므로 던지지 않고 서버 기록에 남긴다. 글은 가리고 1,000자로 자른다
   */
  server(kind: JournalServerKind, text: string, o: JournalServerInput = {}): JournalRow | null {
    const ctx = this.ctx;
    try {
      const generation = o.generation ?? this.core.seat.generation();
      const row = ctx.store.journal.insert({
        at: ctx.now(),
        generation,
        holder: this.holderOf(generation),
        author: 'server',
        kind,
        projectId: o.projectId ?? null,
        workKey: o.workKey ?? null,
        turnId: o.turnId ?? null,
        text: clip(ctx.redact.text(text), JOURNAL_TEXT_MAX),
        refs: dedupeRefs(o.refs ?? []),
        promise: null,
        rollup: null,
      });
      return row;
    } catch (e) {
      if (!this.core.stopping) ctx.log('warn', `메인 일지에 서버 기록(${kind})을 남기지 못했습니다`, e);
      return null;
    }
  }

  // ───────────────────────── 에이전트 기록 (journal_write·journal_close) ─────────────────────────

  /**
   * journal_write (6.1): 메인 에이전트의 결정·약속·메모. 약속은 지시(D-)·질문(Q-)을 참조하거나 언제 닫을지(reason)를 적어야 한다. 한 줄 1,000자, 턴당 5건.
   * 프로젝트를 주지 않으면 그 대화의 프로젝트(main:<P>), 직접 명령(main:general)이면 전체. 인자는 처리기가 이미 가렸다
   */
  write(identity: TokenIdentity, a: { kind: string; text: string; projectId?: string; refs?: string[]; reason?: string }): Record<string, unknown> {
    const ctx = this.ctx;
    if (!(AGENT_KINDS as readonly string[]).includes(a.kind)) throw new BackendError('invalid', "kind는 'decision'(결정)·'promise'(약속)·'note'(메모) 중 하나입니다");
    const kind = a.kind as JournalAgentKind;
    const body = a.text.trim();
    if (!body) throw new BackendError('invalid', 'text(남길 내용)를 적으세요');
    const refs = this.parseRefs(a.refs ?? []);
    const reason = a.reason?.trim() ?? '';
    if (kind === 'promise' && !refs.some((r) => r.kind === 'directive' || r.kind === 'question') && !reason) {
      throw new BackendError('invalid', '약속(promise)은 지켜야 할 지시(D-)나 질문(Q-)을 refs에 넣거나, 언제 무엇으로 닫을지 reason에 적어야 합니다');
    }
    const text = kind === 'promise' && reason ? `${body}\n닫는 조건: ${reason}` : body;
    if (text.length > JOURNAL_TEXT_MAX) {
      throw new BackendError('invalid', `일지 한 줄은 ${JOURNAL_TEXT_MAX.toLocaleString('en-US')}자까지입니다 (지금 ${text.length.toLocaleString('en-US')}자${kind === 'promise' && reason ? ', 닫는 조건 포함' : ''}) — 줄여서 다시 쓰세요`);
    }
    const projectId = this.projectFor(identity, a.projectId);
    const generation = identity.seatGeneration ?? this.core.seat.generation();
    const row = ctx.store.tx(() => {
      const written = ctx.store.journal.count({ author: 'agent', turnId: identity.turnId });
      if (written >= JOURNAL_AGENT_PER_TURN) {
        throw new BackendError('conflict', `한 턴에는 일지를 ${JOURNAL_AGENT_PER_TURN}건까지 쓸 수 있습니다 — 이 턴에 이미 ${written}건을 썼습니다. 꼭 남길 것은 한 줄로 합치거나 다음 턴에 쓰세요`);
      }
      return ctx.store.journal.insert({
        at: ctx.now(),
        generation,
        holder: this.holderOf(generation),
        author: 'agent',
        kind,
        projectId,
        workKey: identity.sessionKey,
        turnId: identity.turnId,
        text,
        refs,
        promise: kind === 'promise' ? { state: 'open', closedAt: null, resolution: null, closedGeneration: null, closedBy: null } : null,
        rollup: null,
      });
    });
    ctx.activity({
      kind: 'journal',
      actor: MAIN_AGENT_ID,
      memberId: MAIN_AGENT_ID,
      projectId,
      sessionId: identity.sessionId,
      turnId: identity.turnId,
      text: `메인 일지에 ${KIND_LABEL[kind]} ${row.id}을(를) 적음 (세대 ${generation}, ${row.holder}) — ${clip(text, 120)}`,
    });
    const left = JOURNAL_AGENT_PER_TURN - ctx.store.journal.count({ author: 'agent', turnId: identity.turnId });
    const what = { decision: '결정을', promise: '약속을', note: '메모를' }[kind];
    return {
      id: row.id,
      kind,
      generation,
      projectId,
      message: `일지에 ${what} 적었습니다 (${row.id}). 이 턴에 ${left}건을 더 쓸 수 있습니다${kind === 'promise' ? ' — 지킨 뒤에는 journal_close로 닫으세요' : ''}`,
    };
  }

  /** journal_close (6.1): 열린 약속을 닫는다. 어느 세대의 약속이든 지금 메인이 닫을 수 있다 — 닫은 쪽과 세대가 남는다 */
  close(identity: TokenIdentity, a: { id: string; resolution: string }): Record<string, unknown> {
    const ctx = this.ctx;
    const id = a.id.trim();
    const resolution = a.resolution.trim();
    if (!resolution) throw new BackendError('invalid', 'resolution(어떻게 지켰는지·왜 닫는지)을 적으세요');
    if (resolution.length > JOURNAL_TEXT_MAX) throw new BackendError('invalid', `resolution은 ${JOURNAL_TEXT_MAX.toLocaleString('en-US')}자까지입니다 (지금 ${resolution.length.toLocaleString('en-US')}자)`);
    const generation = identity.seatGeneration ?? this.core.seat.generation();
    const holder = this.holderOf(generation);
    const closed = ctx.store.tx(() => {
      const row = ctx.store.journal.get(id);
      if (!row) throw new BackendError('not_found', `일지 ${id}을(를) 찾을 수 없습니다`);
      if (row.kind !== 'promise' || !row.promise) throw new BackendError('invalid', `약속(promise)만 닫을 수 있습니다 — ${row.id}은(는) ${KIND_LABEL[row.kind]}입니다`);
      if (row.promise.state === 'closed') throw new BackendError('conflict', `${row.id}은(는) 이미 닫힌 약속입니다 (${row.promise.closedAt}, ${row.promise.closedBy ?? '?'}: ${clip(row.promise.resolution ?? '', 120)})`);
      const next: JournalRow = { ...row, promise: { state: 'closed', closedAt: ctx.now(), resolution, closedGeneration: generation, closedBy: holder } };
      ctx.store.journal.put(next);
      return next;
    });
    ctx.activity({
      kind: 'journal',
      actor: MAIN_AGENT_ID,
      memberId: MAIN_AGENT_ID,
      projectId: closed.projectId,
      sessionId: identity.sessionId,
      turnId: identity.turnId,
      text: `메인 일지의 약속 ${closed.id}을(를) 닫음 (세대 ${generation}, ${holder}) — ${clip(resolution, 120)}`,
    });
    return { id: closed.id, state: 'closed', message: `약속 ${closed.id}을(를) 닫았습니다` };
  }

  /** 프로젝트: 준 것이 있으면 그것(있는 프로젝트만), 없으면 그 대화의 프로젝트 */
  private projectFor(identity: TokenIdentity, given: string | undefined): string | null {
    const ctx = this.ctx;
    const id = given?.trim();
    if (id) {
      const p = ctx.store.projects.get(id);
      if (!p) throw new BackendError('not_found', `프로젝트 ${id}을(를) 찾을 수 없습니다`);
      return p.id;
    }
    const { kind, ref } = parseKey(identity.sessionKey);
    if (kind === 'main_project') return ctx.store.projects.get(ref)?.id ?? null;
    if (kind === 'review') return ctx.store.tasks.get(ref)?.projectId ?? null;
    return null;
  }

  /** refs: 지시·질문·보고서·작업·프로젝트·팀원 ID — 모양과 있는지를 본다 */
  private parseRefs(ids: readonly string[]): JournalRefRow[] {
    const ctx = this.ctx;
    if (ids.length > REFS_MAX) throw new BackendError('invalid', `refs는 ${REFS_MAX}개까지입니다`);
    const out: JournalRefRow[] = [];
    for (const raw of ids) {
      const id = raw.trim();
      const kind = REF_PATTERNS.find(([re]) => re.test(id))?.[1];
      if (!kind) throw new BackendError('invalid', `refs의 '${clip(id, 40)}'은(는) 지시(D-)·질문(Q-)·보고서(R-)·작업(T-)·프로젝트(P-)·팀원(M-) ID가 아닙니다`);
      const exists =
        kind === 'directive'
          ? !!ctx.store.directives.get(id)
          : kind === 'question'
            ? !!ctx.store.questions.get(id)
            : kind === 'report'
              ? !!ctx.store.reports.get(id)
              : kind === 'task'
                ? !!ctx.store.tasks.get(id)
                : kind === 'project'
                  ? !!ctx.store.projects.get(id)
                  : !!ctx.store.members.get(id);
      if (!exists) throw new BackendError('not_found', `refs의 ${id}을(를) 찾을 수 없습니다`);
      out.push({ kind, id });
    }
    return dedupeRefs(out);
  }

  // ───────────────────────── 보기 ─────────────────────────

  /**
   * journal.list (S4-7): 새 것부터, 조건(프로젝트·종류·쓴 쪽·세대·열린 약속만), 쪽 크기 기본 50·최대 200, 다음 쪽 표시(nextCursor). 프로젝트 null은 프로젝트
   * 없는 기록만
   */
  list(filter: JournalFilter = {}): JournalPage {
    const limit = Math.min(Math.max(Math.trunc(filter.limit ?? PAGE_DEFAULT) || PAGE_DEFAULT, 1), PAGE_MAX);
    let after: { at: string; seq: number } | undefined;
    if (filter.cursor) {
      const m = CURSOR_RE.exec(filter.cursor);
      if (!m) throw new BackendError('invalid', '다음 쪽 표시(cursor)가 맞지 않습니다 — 앞 쪽의 nextCursor를 그대로 넘기세요');
      after = { seq: Number(m[1]), at: m[2]! };
    }
    const rows = this.ctx.store.journal.query({
      ...(filter.projectId !== undefined ? { projectId: filter.projectId } : {}),
      ...(filter.kinds?.length ? { kinds: filter.kinds } : {}),
      ...(filter.author ? { author: filter.author } : {}),
      ...(filter.generation !== undefined && filter.generation !== null ? { generation: filter.generation } : {}),
      openPromisesOnly: !!filter.openPromisesOnly,
      ...(after ? { after } : {}),
      limit: limit + 1,
    });
    const page = rows.slice(0, limit);
    return { entries: page.map((r) => this.view(r)), nextCursor: rows.length > limit ? cursorOf(page[page.length - 1]!) : null };
  }

  /** 대표가 보는 한 줄 — 참조 이름과 약속 표시(오래됨·확인 필요)는 지금 기록으로 */
  view(r: JournalRow): JournalEntryView {
    const ctx = this.ctx;
    const project = r.projectId ? ctx.store.projects.get(r.projectId) : null;
    return {
      id: r.id,
      at: r.at,
      generation: r.generation,
      holderLabel: r.holder,
      author: r.author,
      kind: r.kind,
      projectId: r.projectId,
      projectName: r.projectId ? (project?.name ?? '(지워짐)') : null,
      text: r.text,
      refs: r.refs.map((x) => ({ ...x, label: this.refLabel(x) })),
      ...(r.promise ? { promise: { state: r.promise.state, ...this.promiseMarks(r), closedAt: r.promise.closedAt, resolution: r.promise.resolution } } : {}),
    };
  }

  /** 열린 약속의 표시 (6.3): 7일 넘게 열림 → 오래됨, 참조한 지시가 닫힘(없어짐) → 확인 필요 */
  promiseMarks(r: JournalRow): { stale: boolean; needsCheck: boolean } {
    if (r.promise?.state !== 'open') return { stale: false, needsCheck: false };
    const ctx = this.ctx;
    const stale = ctx.clock.ms() - Date.parse(r.at) > JOURNAL_STALE_MS;
    const needsCheck = r.refs.some((x) => {
      if (x.kind !== 'directive') return false;
      const d = ctx.store.directives.get(x.id);
      return !d || !isDirectiveOpen(d);
    });
    return { stale, needsCheck };
  }

  /** 참조 대상의 이름 — 없어졌거나 지운 팀원이면 '(지워짐)' */
  refLabel(x: JournalRefRow): string {
    const ctx = this.ctx;
    const gone = '(지워짐)';
    switch (x.kind) {
      case 'directive':
        return ctx.store.directives.get(x.id)?.title ?? gone;
      case 'question': {
        const q = ctx.store.questions.get(x.id);
        return q ? clip(q.text, 60) : gone;
      }
      case 'report':
        return ctx.store.reports.get(x.id)?.title ?? gone;
      case 'task':
        return ctx.store.tasks.get(x.id)?.title ?? gone;
      case 'project':
        return ctx.store.projects.get(x.id)?.name ?? gone;
      case 'member': {
        const m = ctx.store.members.get(x.id);
        return m && !m.deletedAt ? m.name : gone;
      }
    }
  }

  // ───────────────────────── 월별 묶음 ─────────────────────────

  /**
   * 30일 지난 서버 기록을 달마다 한 줄로 줄인다 (6.3) — 종류별 건수와 그달에 닫힌 약속(이미 30일 지난 것)의 제목. 같은 달 묶음이 있으면 더한다(다시 돌려도
   * 같은 기록을 두 번 세지 않는다 — 센 서버 기록은 지운다). 에이전트 기록(결정·약속·메모)은 지우지 않는다. 시작 때와 6시간마다(orchestrator.ts의 정리). 줄인 수
   */
  rollup(): number {
    const ctx = this.ctx;
    const cutoff = new Date(ctx.clock.ms() - JOURNAL_ROLLUP_AFTER_MS).toISOString();
    const old = ctx.store.journal.query({ author: 'server', kinds: SERVER_KINDS, before: cutoff, asc: true });
    const months = new Map<string, JournalRow[]>();
    for (const r of old) {
      const m = r.at.slice(0, 7);
      months.set(m, [...(months.get(m) ?? []), r]);
    }
    const promises = ctx.store.journal.query({ kinds: ['promise'], author: 'agent', asc: true }).filter((p) => p.promise?.state === 'closed' && !!p.promise.closedAt && p.promise.closedAt < cutoff);
    const existing = ctx.store.journal.query({ kinds: ['rollup'] });
    const listed = (month: string, id: string) => existing.some((x) => x.rollup?.month === month && x.rollup.closedPromises.some((c) => c.id === id));
    // 묶을 달: 30일 지난 서버 기록이 있는 달, 그리고 이미 묶은 달에 새로 30일 지난 닫힌 약속이 있으면 그 달도 (제목만 더한다)
    for (const p of promises) {
      const m = p.promise!.closedAt!.slice(0, 7);
      if (!months.has(m) && existing.some((x) => x.rollup?.month === m) && !listed(m, p.id)) months.set(m, []);
    }
    if (!months.size) return 0;
    ctx.store.tx(() => {
      for (const [month, rows] of months) {
        const prev = existing.find((x) => x.rollup?.month === month) ?? null;
        const counts: JournalRollupRow['counts'] = { ...(prev?.rollup?.counts ?? {}) };
        for (const r of rows) counts[r.kind] = (counts[r.kind] ?? 0) + 1;
        const closedPromises = [
          ...(prev?.rollup?.closedPromises ?? []),
          ...promises.filter((p) => p.promise!.closedAt!.slice(0, 7) === month && !listed(month, p.id)).map((p) => ({ id: p.id, title: clip(p.text.split('\n')[0]!, 80) })),
        ];
        const rollup: JournalRollupRow = { month, counts, total: (prev?.rollup?.total ?? 0) + rows.length, closedPromises };
        const last = rows[rows.length - 1] ?? prev!;
        const at = prev && prev.at > last.at ? prev.at : last.at;
        const holders = new Set([...(prev ? [prev.holder] : []), ...rows.map((r) => r.holder)]);
        const base = {
          at,
          generation: Math.max(prev?.generation ?? 0, last.generation),
          holder: holders.size === 1 ? [...holders][0]! : '여러 보유자',
          author: 'server' as const,
          kind: 'rollup' as const,
          projectId: null,
          workKey: null,
          turnId: null,
          text: rollupText(rollup),
          refs: [],
          promise: null,
          rollup,
        };
        if (prev) ctx.store.journal.put({ ...prev, ...base });
        else ctx.store.journal.insert(base);
        ctx.store.journal.deleteSeqs(rows.map((r) => r.seq));
      }
    });
    return old.length;
  }
}

/** 같은 대상은 한 번만 */
function dedupeRefs(refs: readonly JournalRefRow[]): JournalRefRow[] {
  const seen = new Set<string>();
  return refs.filter((r) => {
    const k = `${r.kind}:${r.id}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** 월별 묶음의 글 (1,000자 안) */
function rollupText(r: JournalRollupRow): string {
  const counts = SERVER_KINDS.filter((k) => r.counts[k]).map((k) => `${KIND_LABEL[k]} ${r.counts[k]}`);
  const head = `${r.month} 서버 기록 ${r.total}건을 한 줄로 묶음 (${counts.join(', ')}) — 원본은 그 무렵의 백업에 있습니다.`;
  if (!r.closedPromises.length) return head;
  const titles: string[] = [];
  let len = head.length + 30;
  for (const p of r.closedPromises) {
    const t = `${p.id} 「${p.title}」`;
    if (len + t.length + 2 > JOURNAL_TEXT_MAX - 20) break;
    titles.push(t);
    len += t.length + 2;
  }
  const more = r.closedPromises.length - titles.length;
  return `${head} 그달에 닫힌 약속 ${r.closedPromises.length}건: ${titles.join(', ')}${more ? ` 외 ${more}건` : ''}`;
}
