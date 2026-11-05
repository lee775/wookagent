/**
 * 메인 일지의 분량과 규칙 (SERVER_DESIGN 6.1·6.3·10.4 journalBounds, 리드 결정 S4-6):
 * - journal_write: 한 줄 1,000자, 한 턴에 5건(에이전트가 쓴 것만 — 같은 턴의 서버 기록은 세지 않는다). 약속은 지시·질문을 참조하거나 언제 닫을지(reason)를 적어야 한다. refs는 있는 대상의 ID만
 * - journal_close: 열린 약속만 닫는다 — 닫은 보유자·세대가 남고, 두 번 닫지 않는다
 * - 7일 넘게 열린 약속은 '오래됨', 참조한 지시가 닫히면 '확인 필요'. 꾸러미의 열린 약속은 50건까지(외 n건)
 * - 30일 지난 서버 기록은 월별 묶음 한 줄(종류별 건수와 그달에 닫힌 약속)로 줄인다 — 에이전트 기록은 그대로, 다시 돌려도 두 번 세지 않는다
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { HandoverSection } from '@shared/views';
import type { JournalRow } from '../../src/main/db/store';
import { mainOpsIdentity } from './mainOps';
import { bootOrch, seedDirective, type OrchEnv } from './orchHarness';

let env: OrchEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const DAY = 24 * 3600_000;

describe('메인 일지의 분량과 규칙 (journalBounds)', () => {
  it('한 줄 1,000자, 한 턴에 5건, 약속은 지시·질문 참조나 닫는 조건이 있어야 하고, refs는 있는 대상만', async () => {
    const e = (env = await bootOrch());
    const write = (turn: string, args: Record<string, unknown>) => e.core.tools.handle(mainOpsIdentity('main:general', turn), 'journal_write', args);
    expect(await write('TN-a', { kind: 'note', text: '가'.repeat(1001) })).toEqual({ ok: false, code: 'invalid', message: '일지 한 줄은 1,000자까지입니다 (지금 1,001자) — 줄여서 다시 쓰세요' });
    expect(await write('TN-a', { kind: 'note', text: '   ' })).toMatchObject({ ok: false, code: 'invalid', message: 'text(남길 내용)를 적으세요' });
    expect(await write('TN-a', { kind: 'wish', text: '바람' })).toMatchObject({ ok: false, code: 'invalid' });
    const ok = await write('TN-a', { kind: 'note', text: '가'.repeat(1000) });
    expect(ok).toMatchObject({ ok: true, data: { kind: 'note', generation: 1, message: '일지에 메모를 적었습니다 (J-000002). 이 턴에 4건을 더 쓸 수 있습니다' } });
    // 약속: 참조나 닫는 조건이 없으면 거부, 닫는 조건과 합쳐 1,000자
    expect(await write('TN-a', { kind: 'promise', text: '나중에 확인한다' })).toEqual({
      ok: false,
      code: 'invalid',
      message: '약속(promise)은 지켜야 할 지시(D-)나 질문(Q-)을 refs에 넣거나, 언제 무엇으로 닫을지 reason에 적어야 합니다',
    });
    expect(await write('TN-a', { kind: 'promise', text: '나'.repeat(990), reason: '확인하면 닫는다' })).toMatchObject({ ok: false, code: 'invalid', message: expect.stringContaining('닫는 조건 포함') });
    const withReason = await write('TN-a', { kind: 'promise', text: '배포 일정을 대표에게 다시 묻는다', reason: '대표가 일정을 정하면 닫는다' });
    expect(withReason.ok).toBe(true);
    const d = seedDirective(e, '로그인 화면');
    const withRef = await write('TN-a', { kind: 'promise', text: '지시가 끝나면 보고한다', refs: [d.id, e.devId, e.projectId] });
    expect(withRef.ok).toBe(true);
    // refs는 있는 대상의 ID만
    expect(await write('TN-b', { kind: 'note', text: '참조', refs: ['X-0001'] })).toMatchObject({ ok: false, code: 'invalid', message: "refs의 'X-0001'은(는) 지시(D-)·질문(Q-)·보고서(R-)·작업(T-)·프로젝트(P-)·팀원(M-) ID가 아닙니다" });
    expect(await write('TN-b', { kind: 'note', text: '참조', refs: ['D-9999'] })).toEqual({ ok: false, code: 'not_found', message: 'refs의 D-9999을(를) 찾을 수 없습니다' });
    // 한 턴에 5건 — 거부된 것은 세지 않는다. 다른 턴은 따로 센다
    expect((await write('TN-a', { kind: 'decision', text: '네 번째' })).ok).toBe(true);
    expect((await write('TN-a', { kind: 'decision', text: '다섯 번째' })).ok).toBe(true);
    expect(await write('TN-a', { kind: 'decision', text: '여섯 번째' })).toEqual({
      ok: false,
      code: 'conflict',
      message: '한 턴에는 일지를 5건까지 쓸 수 있습니다 — 이 턴에 이미 5건을 썼습니다. 꼭 남길 것은 한 줄로 합치거나 다음 턴에 쓰세요',
    });
    expect((await write('TN-b', { kind: 'note', text: '다음 턴' })).ok).toBe(true);
    const rows = e.ctx.store.journal.query({ author: 'agent', asc: true });
    expect(rows.map((r) => [r.kind, r.turnId])).toEqual([
      ['note', 'TN-a'],
      ['promise', 'TN-a'],
      ['promise', 'TN-a'],
      ['decision', 'TN-a'],
      ['decision', 'TN-a'],
      ['note', 'TN-b'],
    ]);
    expect(rows[1]!.text).toBe('배포 일정을 대표에게 다시 묻는다\n닫는 조건: 대표가 일정을 정하면 닫는다');
    expect(rows[2]!.refs).toEqual([
      { kind: 'directive', id: d.id },
      { kind: 'member', id: e.devId },
      { kind: 'project', id: e.projectId },
    ]);
    expect(rows.every((r) => r.text.length <= 1000 && r.holder === 'Claude CLI' && r.generation === 1)).toBe(true);
    // 활동 기록(일지)에 쓴 것이 남는다
    expect(e.ctx.store.activity.search({ kinds: ['journal'], limit: 20 })).toHaveLength(6);
  });

  it('한 턴에 5건은 에이전트가 쓴 것만 센다 — 같은 턴의 메인 행동(서버 기록)은 세지 않는다 (S4-22 7번)', async () => {
    const e = (env = await bootOrch());
    const who = mainOpsIdentity('main:general', 'TN-busy');
    // 한 턴에 메인 행동 5번 — 서버가 그 턴의 기록으로 남긴다
    for (let i = 0; i < 5; i++) expect((await e.core.tools.handle(who, 'ask_owner', { question: `질문 ${i}` })).ok).toBe(true);
    expect(e.ctx.store.journal.query({ author: 'server', kinds: ['action'] }).filter((r) => r.turnId === 'TN-busy')).toHaveLength(5);
    // 그래도 그 턴의 일지는 5건을 쓸 수 있다 — 넘겨줄 메모를 행동 때문에 못 쓰는 일이 없다
    for (let i = 0; i < 5; i++) {
      expect(await e.core.tools.handle(who, 'journal_write', { kind: 'note', text: `메모 ${i}` })).toMatchObject({
        ok: true,
        data: { message: expect.stringMatching(new RegExp(`이 턴에 ${4 - i}건을 더 쓸 수 있습니다$`)) },
      });
    }
    expect(await e.core.tools.handle(who, 'journal_write', { kind: 'note', text: '여섯 번째' })).toEqual({
      ok: false,
      code: 'conflict',
      message: '한 턴에는 일지를 5건까지 쓸 수 있습니다 — 이 턴에 이미 5건을 썼습니다. 꼭 남길 것은 한 줄로 합치거나 다음 턴에 쓰세요',
    });
  });

  it('journal_close는 열린 약속만 닫는다 — 닫은 보유자·세대가 남고, 7일 넘게 열리면 오래됨, 참조한 지시가 닫히면 확인 필요', async () => {
    const e = (env = await bootOrch());
    const id = mainOpsIdentity('main:general', 'TN-c');
    const tool = (name: string, args: Record<string, unknown>) => e.core.tools.handle(id, name, args);
    const d = seedDirective(e, '정산 화면');
    const p = (await tool('journal_write', { kind: 'promise', text: '정산 화면이 끝나면 대표에게 보고한다', refs: [d.id] })) as { ok: true; data: { id: string } };
    const n = (await tool('journal_write', { kind: 'decision', text: '정산은 월 단위로 한다' })) as { ok: true; data: { id: string } };
    const view = () => e.core.journal.view(e.ctx.store.journal.get(p.data.id)!);
    expect(view().promise).toEqual({ state: 'open', stale: false, needsCheck: false, closedAt: null, resolution: null });
    // 7일 넘게 열린 약속 → 오래됨
    const row = e.ctx.store.journal.get(p.data.id)!;
    e.ctx.store.journal.put({ ...row, at: new Date(Date.now() - 8 * DAY).toISOString() });
    expect(view().promise).toMatchObject({ stale: true, needsCheck: false });
    // 참조한 지시가 닫히면 확인 필요
    e.ctx.store.directives.put({ ...e.ctx.store.directives.require(d.id), state: 'closed', closedAt: e.ctx.now() });
    expect(view().promise).toMatchObject({ stale: true, needsCheck: true });
    // 닫기
    expect(await tool('journal_close', { id: n.data.id, resolution: '끝' })).toEqual({ ok: false, code: 'invalid', message: `약속(promise)만 닫을 수 있습니다 — ${n.data.id}은(는) 결정입니다` });
    expect(await tool('journal_close', { id: 'J-999999', resolution: '끝' })).toEqual({ ok: false, code: 'not_found', message: '일지 J-999999을(를) 찾을 수 없습니다' });
    expect(await tool('journal_close', { id: p.data.id, resolution: '  ' })).toMatchObject({ ok: false, code: 'invalid' });
    expect(await tool('journal_close', { id: p.data.id, resolution: '대표에게 보고서 R-0001로 알렸다' })).toEqual({ ok: true, data: { id: p.data.id, state: 'closed', message: `약속 ${p.data.id}을(를) 닫았습니다` } });
    const closed = e.ctx.store.journal.get(p.data.id)!;
    expect(closed.promise).toMatchObject({ state: 'closed', resolution: '대표에게 보고서 R-0001로 알렸다', closedGeneration: 1, closedBy: 'Claude CLI' });
    // 닫힌 약속에는 표시가 없고, 다시 닫지 않는다
    expect(view().promise).toMatchObject({ state: 'closed', stale: false, needsCheck: false, resolution: '대표에게 보고서 R-0001로 알렸다' });
    expect(await tool('journal_close', { id: p.data.id, resolution: '또' })).toMatchObject({ ok: false, code: 'conflict', message: expect.stringContaining('이미 닫힌 약속입니다') });
    // 닫기는 턴당 5건에 세지 않는다
    expect(e.ctx.store.journal.count({ author: 'agent', turnId: 'TN-c' })).toBe(2);
  });

  it('꾸러미의 열린 약속은 50건까지 — 나머지는 외 n건', async () => {
    const e = (env = await bootOrch());
    for (let i = 0; i < 55; i++) e.core.journal.write(mainOpsIdentity('main:general', `TN-q${i}`), { kind: 'promise', text: `약속 ${i}`, reason: '확인하면 닫는다' });
    const seat: HandoverSection = { key: 'seat', title: '자리 정보', unverified: false, lines: ['새 보유자: Codex CLI (세대 2)'], omitted: 0 };
    const memos = e.core.handover.build({ seat, generation: 2, now: e.ctx.now(), memo: null }).find((s) => s.key === 'memos')!;
    expect(memos.lines).toContain('[열린 약속] 55건 — 아래 50건, 외 5건');
    expect(memos.lines.filter((l) => l.startsWith('- J-'))).toHaveLength(50);
    expect(memos.omitted).toBe(5);
    // 가장 오래된 50건이 든다 (오래 열린 약속부터 챙긴다)
    expect(memos.lines.some((l) => l.includes(': 약속 0\n') || l.endsWith(': 약속 0\n닫는 조건: 확인하면 닫는다') || l.includes(': 약속 0 닫는 조건'))).toBe(true);
    expect(memos.lines.some((l) => l.includes('약속 54'))).toBe(false);
  });

  it('30일 지난 서버 기록은 월별 묶음 한 줄로 줄인다 — 종류별 건수와 그달에 닫힌 약속, 에이전트 기록은 그대로, 다시 돌려도 두 번 세지 않는다', async () => {
    const e = (env = await bootOrch());
    const store = e.ctx.store;
    const base: Pick<JournalRow, 'generation' | 'holder' | 'projectId' | 'workKey' | 'turnId' | 'refs' | 'promise' | 'rollup'> = { generation: 1, holder: 'Claude CLI', projectId: null, workKey: null, turnId: null, refs: [], promise: null, rollup: null };
    const old = (days: number) => new Date(Date.now() - days * DAY).toISOString();
    const insert = (r: Partial<JournalRow> & Pick<JournalRow, 'at' | 'author' | 'kind' | 'text'>) => store.journal.insert({ ...base, ...r });
    insert({ at: old(70), author: 'server', kind: 'command', text: '오래된 명령 1' });
    insert({ at: old(69), author: 'server', kind: 'action', text: '오래된 행동 1' });
    insert({ at: old(40), author: 'server', kind: 'command', text: '명령 2' });
    insert({ at: old(39), author: 'server', kind: 'stop', text: '정지' });
    insert({ at: old(38), author: 'server', kind: 'action', text: '행동 2' });
    insert({ at: old(40), author: 'agent', kind: 'decision', text: '오래된 결정' });
    const promise = insert({ at: old(45), author: 'agent', kind: 'promise', text: '보고서를 다시 낸다', promise: { state: 'closed', closedAt: old(39), resolution: '냈다', closedGeneration: 1, closedBy: 'Claude CLI' } });
    const recent = insert({ at: old(2), author: 'server', kind: 'action', text: '최근 행동' });
    const before = store.journal.count({ author: 'server', kinds: ['seat'] });
    expect(e.core.journal.rollup()).toBe(5);
    const rollups = store.journal.query({ kinds: ['rollup'], asc: true });
    const months = [...new Set([old(70), old(69), old(40), old(39), old(38)].map((a) => a.slice(0, 7)))];
    expect(rollups.map((r) => r.rollup!.month)).toEqual(months);
    expect(rollups.reduce((n, r) => n + r.rollup!.total, 0)).toBe(5);
    const promiseMonth = old(39).slice(0, 7);
    const withPromise = rollups.find((r) => r.rollup!.month === promiseMonth)!;
    expect(withPromise.rollup!.closedPromises).toEqual([{ id: promise.id, title: '보고서를 다시 낸다' }]);
    expect(withPromise.text).toContain(`그달에 닫힌 약속 1건: ${promise.id} 「보고서를 다시 낸다」`);
    expect(rollups.every((r) => r.author === 'server' && r.text.startsWith(`${r.rollup!.month} 서버 기록 ${r.rollup!.total}건을 한 줄로 묶음 (`) && r.text.length <= 1000)).toBe(true);
    // 서버 기록은 지워지고(원본은 백업에), 에이전트 기록과 30일 안의 기록은 그대로
    expect(store.journal.query({ author: 'server', kinds: ['command', 'action', 'stop'], asc: true }).map((r) => r.id)).toEqual([recent.id]);
    expect(store.journal.query({ author: 'agent', asc: true }).map((r) => r.kind)).toEqual(['promise', 'decision']);
    expect(store.journal.count({ author: 'server', kinds: ['seat'] })).toBe(before);
    // 다시 돌려도 그대로
    const snapshot = JSON.stringify(store.journal.query({ asc: true }));
    expect(e.core.journal.rollup()).toBe(0);
    expect(JSON.stringify(store.journal.query({ asc: true }))).toBe(snapshot);
    // 같은 달에 새로 30일이 지난 기록은 그 달 묶음에 더한다
    insert({ at: old(37), author: 'server', kind: 'command', text: '명령 3' });
    const month = old(37).slice(0, 7);
    const prevTotal = store.journal.query({ kinds: ['rollup'] }).find((r) => r.rollup!.month === month)?.rollup?.total ?? 0;
    expect(e.core.journal.rollup()).toBe(1);
    const after = store.journal.query({ kinds: ['rollup'] }).filter((r) => r.rollup!.month === month);
    expect(after).toHaveLength(1);
    expect(after[0]!.rollup!.total).toBe(prevTotal + 1);
    expect(after[0]!.rollup!.counts.command).toBeGreaterThanOrEqual(1);
  });
});
