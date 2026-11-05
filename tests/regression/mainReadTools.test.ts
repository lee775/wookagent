/**
 * 메인 조회 도구 (SERVER_DESIGN 5.2, 리드 결정 S5-6) — get_member_activity·read_report·list_questions·search_activity·get_overview:
 * - get_member_activity: 팀원 한 줄, 최근 턴 5개, 한 턴(없으면 가장 최근)의 마지막 이벤트 limit개(기본 30·최대 100, 오래된 것부터). 원본(raw)은 싣지 않고 글은 300자,
 *   data는 정해진 칸만, 전체 12,000자. 메인 에이전트와 지운 팀원도 보고, 없는 ID만 not_found. 이벤트 파일은 끝에서 정해진 크기만 읽는다. 나중에 등록된 비밀 값도 가린다
 * - read_report: 본문·대표 코멘트·통계·판정, 마크다운 원문과 파일 경로는 없다. 변경 파일 200개, 코멘트 50건 × 2,000자. 읽어도 대표의 읽지 않음('new')은 그대로다
 * - list_questions: 열린 질문만 오래된 것부터 100건('외 n건'), project_id로 그 프로젝트, 'general'이면 프로젝트 없는 질문
 * - search_activity: 대표의 logs.search와 같은 줄(같은 차례·같은 수), 글과 결과만 1,000자로 자른다
 * - 모두 메인 전용(처리기도 다시 본다 — list_projects·get_project_status·read_memory·list_ai_options 포함), 조회 도구라 긴급 정지 중에도·인계 메모 턴에도 되고,
 *   이전 세대 토큰은 seat_changed, 일지에 남지 않는다
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID, type AiConfig } from '@shared/domain';
import type { MemberActivity, QuestionList, ReportReadout } from '../../src/main/mcp/catalog';
import type { TokenIdentity } from '../../src/main/mcp/types';
import { readTail } from '../../src/main/orchestrator/fsutil';
import { mainOpsIdentity } from './mainOps';
import { bootOrch, seedDirective, waitFor, type OrchEnv } from './orchHarness';

let env: OrchEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

/** 모양으로는 알아볼 수 없는 비밀 값 — 기록한 뒤에 등록해, 읽을 때 다시 가리는지 본다 */
const SECRET = 'zebra-orchard-4471-quartz-plum';
const READ_TOOLS: [string, Record<string, unknown>][] = [
  ['get_overview', {}],
  ['get_member_activity', { member_id: MAIN_AGENT_ID }],
  ['read_report', { report_id: 'R-0001' }],
  ['list_questions', {}],
];
const asProducer = (e: OrchEnv): TokenIdentity => ({ turnId: 'TN-p', sessionId: 'S-p', sessionKey: 'directive:D-0001', sessionKind: 'directive', memberId: e.producerId, projectId: e.projectId, isMain: false, isProducer: true, canReview: true });

async function report(e: OrchEnv, o: { changedFiles?: string[]; title?: string } = {}): Promise<string> {
  const r = await e.main('submit_report', { title: o.title ?? '현황 보고', summary: '요약입니다', results: '결과입니다', changed_files: o.changedFiles ?? [], how_to_verify: '화면에서 확인', issues: '없음', next_steps: '다음' });
  return String(r.reportId);
}

describe('메인 조회 도구 (mainReadTools)', () => {
  it('get_member_activity: 가장 최근 턴의 마지막 이벤트(기본 30) — 원본 없이 300자·정해진 data 칸, 12,000자 안, 나중에 등록된 비밀 값도 가린다', async () => {
    const e = (env = await bootOrch());
    const d = e.core.directives.register({ projectId: e.projectId, title: '계획할 지시', text: '계획' }, MAIN_AGENT_ID, null);
    const key = `directive:${d.id}`;
    e.script.set(key, (p) => {
      for (let i = 1; i <= 150; i++) {
        p.emit({
          kind: i % 3 ? 'text' : 'command_end',
          // 마지막 이벤트는 비밀 값이 300자 경계에 걸친다 — 자르기 전에 가려야 앞부분도 남지 않는다
          text: i === 150 ? `${'가'.repeat(290)} ${SECRET} 뒤의 글` : `이벤트 ${i}: ${'긴 출력 '.repeat(100)}`,
          data: { cliSessionId: 'sess-raw-1234', tool: 'Bash', command: `echo ${i} ${'x'.repeat(400)}`, exitCode: 0, permissionMode: 'bypassPermissions', paths: Array.from({ length: 30 }, (_, k) => `src/${k}.ts`) },
          raw: { full: 'RAW-OUTPUT '.repeat(50) },
        });
      }
      p.finishOk();
    });
    await e.drain(1);
    e.script.clear();
    e.ctx.redact.addSecret(SECRET, 'api-key');
    const turn = e.ctx.store.turns.list({ ref1: e.producerId })[0]!;
    const a = (await e.main('get_member_activity', { member_id: e.producerId })) as unknown as MemberActivity;
    expect(a.member).toMatchObject({ memberId: e.producerId, isProducer: true, projectId: e.projectId, deleted: false });
    expect(a.turnId).toBe(turn.id);
    expect(a.turns.map((t) => t.turnId)).toEqual([turn.id]);
    expect(a.turns[0]).toMatchObject({ sessionKey: key, projectId: e.projectId, endReason: '정상 종료', running: false });
    // 기본 30건 — 마지막 30건, 오래된 것부터 (마지막 결과 이벤트 포함)
    const seqs = a.events.map((x) => x.seq);
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => seqs[0]! + i));
    expect(seqs.at(-1)).toBe(e.ctx.store.turns.require(turn.id).eventCount);
    expect(a.events.length + a.omittedEvents).toBe(seqs.at(-1));
    expect(a.events.length).toBeLessThanOrEqual(30);
    expect(a.events.every((x) => x.text.length <= 300)).toBe(true);
    const text = JSON.stringify(a);
    expect(text.length).toBeLessThanOrEqual(12_000);
    expect(text).not.toContain('RAW-OUTPUT');
    expect(text).not.toContain('sess-raw-1234');
    expect(text).not.toContain('bypassPermissions');
    expect(text).not.toContain(SECRET.slice(0, 6));
    const withData = a.events.find((x) => x.data)!;
    expect(Object.keys(withData.data!).sort()).toEqual(['command', 'exitCode', 'paths', 'tool']);
    expect(String(withData.data!.command).length).toBeLessThanOrEqual(300);
    expect((withData.data!.paths as string[]).length).toBe(20);
    // limit 100이어도 12,000자 안 — 오래된 이벤트부터 빼고 그 수와 안내를 남긴다
    const big = (await e.main('get_member_activity', { member_id: e.producerId, limit: 100 })) as unknown as MemberActivity;
    expect(JSON.stringify(big).length).toBeLessThanOrEqual(12_000);
    expect(big.events.at(-1)!.seq).toBe(seqs.at(-1));
    expect(big.events.length).toBeLessThan(100);
    expect(big.omittedEvents).toBe(seqs.at(-1)! - big.events.length);
    expect(big.message).toBe(`앞 이벤트 ${big.omittedEvents}건은 싣지 않았습니다 — turn_id·limit로 다시 보거나 search_activity로 찾으세요`);
    // limit이 작으면 그만큼만, 짧은 이벤트는 그대로
    const few = (await e.main('get_member_activity', { member_id: e.producerId, limit: 3 })) as unknown as MemberActivity;
    expect(few.events.map((x) => x.seq)).toEqual(seqs.slice(-3));
  });

  it('get_member_activity: 메인 에이전트(세대 표시)와 지운 팀원도 보고, 없는 ID·남의 턴은 not_found — 짧은 이벤트는 기본 30건, 최대 100건', async () => {
    const e = (env = await bootOrch());
    e.script.set('main:general', (p) => {
      for (let i = 1; i <= 150; i++) p.emit({ kind: 'text', text: `짧은 줄 ${i}` });
      p.finishOk();
    });
    await e.invoke('command.send', { target: 'main', text: '첫 명령' });
    await e.drain(1);
    e.script.clear();
    const m = (await e.main('get_member_activity', { member_id: MAIN_AGENT_ID })) as unknown as MemberActivity;
    expect(m.member).toMatchObject({ memberId: MAIN_AGENT_ID, isMain: true, roleName: '메인 에이전트' });
    expect(m.turns).toHaveLength(1);
    expect(m.turns[0]).toMatchObject({ sessionKey: 'main:general', generation: 1 });
    const last = e.ctx.store.turns.require(m.turnId!).eventCount;
    expect(m.events.map((x) => x.seq)).toEqual(Array.from({ length: 30 }, (_, i) => last - 29 + i));
    expect([m.omittedEvents, m.message]).toEqual([last - 30, `앞 이벤트 ${last - 30}건은 싣지 않았습니다 — turn_id·limit로 다시 보거나 search_activity로 찾으세요`]);
    // 최대 100건 — 처리기에 더 큰 값을 줘도 (도구 서버는 100 넘는 값을 먼저 거른다)
    const most = (await e.core.tools.handle(mainOpsIdentity(), 'get_member_activity', { member_id: MAIN_AGENT_ID, limit: 500 })) as { ok: true; data: MemberActivity };
    expect(most.data.events.map((x) => x.seq)).toEqual(Array.from({ length: 100 }, (_, i) => last - 99 + i));
    await e.main('remove_member', { member_id: e.qaId });
    const gone = (await e.main('get_member_activity', { member_id: e.qaId })) as unknown as MemberActivity;
    expect(gone).toMatchObject({ member: { memberId: e.qaId, deleted: true }, turns: [], turnId: null, events: [], message: '아직 턴 기록이 없습니다' });
    await expect(e.main('get_member_activity', { member_id: 'M-9999' })).rejects.toMatchObject({ code: 'not_found', message: '팀원 M-9999을(를) 찾을 수 없습니다' });
    await expect(e.main('get_member_activity', { member_id: e.devId, turn_id: m.turns[0]!.turnId })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('이벤트 파일은 끝에서 정해진 크기만 읽는다 — 앞의 잘린 줄은 빼고 마지막 줄까지', () => {
    const file = join(process.env.TEMP ?? process.env.TMPDIR ?? '.', `wook-test-tail-${process.pid}-${Date.now()}.jsonl`);
    const line = (i: number) => JSON.stringify({ seq: i, text: `${i} ${'가'.repeat(500)}` });
    writeFileSync(file, Array.from({ length: 3000 }, (_, i) => line(i + 1)).join('\n') + '\n', 'utf8');
    const bound = 64 * 1024;
    const t = readTail(file, bound);
    expect(t.truncated).toBe(true);
    expect(Buffer.byteLength(t.lines.join('\n'), 'utf8')).toBeLessThanOrEqual(bound);
    expect(t.lines.length).toBeGreaterThan(10);
    expect(t.lines.every((l) => typeof (JSON.parse(l) as { seq: number }).seq === 'number')).toBe(true);
    expect((JSON.parse(t.lines.at(-1)!) as { seq: number }).seq).toBe(3000);
    expect(readTail(`${file}.없음`, bound)).toEqual({ lines: [], truncated: false });
  });

  it('read_report: 본문·코멘트(50건×2,000자)·변경 파일(200개)·통계·판정 — 원문·경로는 없고, 읽어도 대표의 읽지 않음은 그대로', async () => {
    const e = (env = await bootOrch());
    const id = await report(e, { changedFiles: Array.from({ length: 250 }, (_, i) => `src/file-${i}.ts`) });
    const now = e.ctx.now();
    for (let i = 0; i < 55; i++) e.ctx.store.reportComments.insert({ id: `RC-${i}`, reportId: id, kind: i % 2 ? 'anchored' : 'overall', quote: i % 2 ? '요약입니다' : null, text: `코멘트 ${i} ${'자세히 '.repeat(500)}`, createdAt: now });
    e.ctx.store.reportComments.insert({ id: 'RC-secret', reportId: id, kind: 'overall', quote: null, text: `키 ${SECRET}`, createdAt: now });
    e.ctx.redact.addSecret(SECRET, 'api-key');
    const r = (await e.main('read_report', { report_id: id })) as unknown as ReportReadout;
    expect(r).toMatchObject({ reportId: id, title: '현황 보고', status: 'new', unread: true, projectId: null, projectName: '일반', canApprove: true, canRequestChanges: true });
    expect(r.sections).toMatchObject({ summary: '요약입니다', results: '결과입니다', howToVerify: '화면에서 확인', issues: '없음', nextSteps: '다음' });
    expect([r.sections.changedFiles.total, r.sections.changedFiles.items.length, r.sections.changedFiles.items[199]]).toEqual([250, 200, 'src/file-199.ts']);
    expect([r.comments.total, r.comments.items.length]).toEqual([56, 50]);
    expect(r.comments.items.every((c) => c.text.length <= 2000)).toBe(true);
    expect(r.comments.items[1]).toMatchObject({ kind: 'anchored', quote: '요약입니다' });
    expect(r.stats).toMatchObject({ taskCount: expect.any(Number) });
    expect(Object.keys(r)).not.toContain('markdown');
    expect(Object.keys(r)).not.toContain('filePath');
    expect(JSON.stringify(r)).not.toContain(e.ctx.store.reports.require(id).filePath.replace(/\\/g, '\\\\'));
    // 읽음 표시는 대표의 것 — 그대로 '새 보고'
    expect(e.ctx.store.reports.require(id).status).toBe('new');
    const all = (await e.main('read_report', { report_id: 'RC-secret' }).catch((x: Error & { code: string }) => x)) as Error & { code: string };
    expect(all.code).toBe('not_found');
    // 비밀 값은 코멘트가 50건 밖이라도 결과에 없다 — 결과 전체를 가린다
    e.ctx.store.reportComments.put({ ...e.ctx.store.reportComments.list({ ref1: id })[0]!, text: `앞 코멘트에도 ${SECRET}` });
    expect(JSON.stringify(await e.main('read_report', { report_id: id }))).not.toContain(SECRET);
  });

  it('list_questions: 열린 질문만 오래된 것부터 100건 — project_id로 그 프로젝트, general이면 프로젝트 없는 질문', async () => {
    const e = (env = await bootOrch());
    const ctx = e.ctx;
    const q = (o: { projectId: string | null; to: 'owner' | 'producer'; status?: 'open' | 'answered' | 'cancelled'; text: string }) => {
      const id = ctx.store.nextId('question');
      ctx.store.questions.insert({ id, projectId: o.projectId, fromId: o.to === 'owner' ? MAIN_AGENT_ID : e.devId, to: o.to, taskId: null, directiveId: null, sessionKey: 'main:general', text: o.text, status: o.status ?? 'open', answer: null, answeredBy: null, createdAt: ctx.now(), answeredAt: null });
      return id;
    };
    const general = q({ projectId: null, to: 'owner', text: '직접 명령의 질문' });
    q({ projectId: null, to: 'owner', status: 'answered', text: '답한 질문' });
    q({ projectId: e.projectId, to: 'owner', status: 'cancelled', text: '취소된 질문' });
    const toProducer = q({ projectId: e.projectId, to: 'producer', text: `프로듀서에게 ${'긴 질문 '.repeat(200)}` });
    const owner = q({ projectId: e.projectId, to: 'owner', text: '프로젝트 질문' });
    const all = (await e.main('list_questions')) as unknown as QuestionList;
    expect(all.items.map((x) => [x.questionId, x.to])).toEqual([
      [general, 'owner'],
      [toProducer, 'producer'],
      [owner, 'owner'],
    ]);
    expect(all.total).toBe(3);
    expect(all.message).toBeUndefined();
    expect(all.items[1]).toMatchObject({ fromId: e.devId, fromName: ctx.store.members.require(e.devId).name });
    expect(all.items[1]!.text.length).toBe(1000);
    expect(((await e.main('list_questions', { project_id: e.projectId })) as unknown as QuestionList).items.map((x) => x.questionId)).toEqual([toProducer, owner]);
    expect(((await e.main('list_questions', { project_id: 'general' })) as unknown as QuestionList).items.map((x) => x.questionId)).toEqual([general]);
    await expect(e.main('list_questions', { project_id: 'P-9999' })).rejects.toMatchObject({ code: 'not_found' });
    for (let i = 0; i < 100; i++) q({ projectId: null, to: 'owner', text: `질문 ${i}` });
    const capped = (await e.main('list_questions')) as unknown as QuestionList;
    expect([capped.total, capped.items.length, capped.items[0]!.questionId]).toEqual([103, 100, general]);
    expect(capped.message).toBe('열린 질문 103건 중 오래된 100건만 보입니다 — 외 3건');
  });

  it('search_activity는 logs.search와 같은 줄이고 글·결과만 1,000자로 자른다', async () => {
    const e = (env = await bootOrch());
    for (let i = 0; i < 5; i++) e.ctx.activity({ kind: 'system', text: `긴 기록 ${i} ${'가나다 '.repeat(500)}`, result: i % 2 ? `결과 ${'라마바 '.repeat(500)}` : null });
    e.ctx.activity({ kind: 'system', text: '짧은 기록' });
    const owner = await e.invoke('logs.search', { kinds: ['system'], limit: 50 });
    const main = (await e.main('search_activity', { kinds: ['system'], limit: 50 })) as unknown as typeof owner;
    expect(main.map((r) => r.seq)).toEqual(owner.map((r) => r.seq));
    const cut = (t: string) => (t.length > 1000 ? `${t.slice(0, 999)}…` : t);
    expect(main).toEqual(owner.map((r) => ({ ...r, text: cut(r.text), result: r.result === null ? null : cut(r.result) })));
    expect(owner.some((r) => r.text.length > 1000)).toBe(true);
    expect(main.every((r) => r.text.length <= 1000 && (r.result ?? '').length <= 1000)).toBe(true);
  });

  it('get_overview: 없는 project_id는 not_found, 부른 턴이 실은 일은 메인이 할 일에서 뺀다', async () => {
    const e = (env = await bootOrch());
    await expect(e.main('get_overview', { project_id: 'P-9999' })).rejects.toMatchObject({ code: 'not_found' });
    e.hold.add('main:general');
    await e.invoke('command.send', { target: 'main', text: '첫 명령' });
    await e.invoke('command.send', { target: e.projectId, text: '프로젝트 명령' });
    e.tick();
    await waitFor(() => !!e.liveProc('main:general', MAIN_AGENT_ID) || !!e.liveProc(`main:${e.projectId}`, MAIN_AGENT_ID), '메인 턴');
    const live = e.liveProc('main:general', MAIN_AGENT_ID) ?? e.liveProc(`main:${e.projectId}`, MAIN_AGENT_ID)!;
    const r = (await e.tool(live.turnId, 'get_overview', { detail: true })) as { ok: true; data: { main: { byKind: Record<string, number> }; projects: { total: number } } };
    expect(r.data.main.byKind).toEqual({ main_command: 1 });
    expect(r.data.projects.total).toBe(1);
    e.hold.clear();
    live.finishOk();
  });

  it('메인 전용이고(처리기도 본다), 긴급 정지 중에도 되며, 이전 세대 토큰은 seat_changed, 일지에 남지 않는다', async () => {
    const e = (env = await bootOrch());
    await report(e);
    const journal = () => e.ctx.store.journal.count({});
    // 프로듀서 토큰으로 처리기를 바로 부르면 거부 — 도구 서버는 역할로 먼저 거른다
    for (const [tool, args] of [...READ_TOOLS, ['list_projects', {}], ['get_project_status', { project_id: e.projectId }], ['read_memory', {}], ['list_ai_options', {}]] as [string, Record<string, unknown>][]) {
      expect(await e.core.tools.handle(asProducer(e), tool, args), tool).toEqual({ ok: false, code: 'forbidden', message: '메인 에이전트만 쓸 수 있는 도구입니다' });
    }
    const before = journal();
    await e.invoke('stop.emergency');
    for (const [tool, args] of READ_TOOLS) expect((await e.core.tools.handle(mainOpsIdentity(), tool, args)).ok, tool).toBe(true);
    await e.invoke('stop.release');
    // 이전 세대 토큰
    const stale: TokenIdentity = { ...mainOpsIdentity(), seatGeneration: 99 };
    for (const [tool, args] of READ_TOOLS) expect(await e.core.tools.handle(stale, tool, args), tool).toMatchObject({ ok: false, code: 'seat_changed' });
    // 조회는 일지에 남지 않는다 (정지·해제의 서버 기록만 늘었다)
    expect(e.ctx.store.journal.query({ limit: 50 }).filter((r) => r.kind === 'action')).toEqual([]);
    expect(journal() - before).toBe(e.ctx.store.journal.count({ kinds: ['stop'] }));
  });

  it('인계 메모 턴에도 쓸 수 있다 (조회 도구)', async () => {
    const e = (env = await bootOrch());
    await report(e);
    await e.invoke('command.send', { target: 'main', text: '지금 상황은?' });
    await e.drain(1);
    e.hold.add('main:general');
    const codex: AiConfig = { kind: 'codex', model: null, effortTier: 'high', effortOverride: null };
    const swap = e.core.seat.assign({ holder: { kind: 'launched', ai: codex }, by: 'operator', reason: '운영자 교체' });
    await waitFor(() => !!e.liveProc('main:general', MAIN_AGENT_ID), '인계 메모 턴');
    const memo = e.liveProc('main:general', MAIN_AGENT_ID)!.turnId;
    expect(e.core.seat.isMemoTurn(memo)).toBe(true);
    for (const [tool, args] of READ_TOOLS) expect((await e.tool(memo, tool, args)).ok, tool).toBe(true);
    expect((await e.tool(memo, 'ask_owner', { question: '질문' })).ok).toBe(false);
    e.liveProc('main:general', MAIN_AGENT_ID)!.finishOk();
    await swap.done;
    seedDirective(e);
  });
});
