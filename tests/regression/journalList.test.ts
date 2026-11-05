/**
 * 대표의 일지 보기 journal.list (리드 결정 S4-7, SERVER_DESIGN 6.1, S4b):
 * - 새 것부터. 조건: 프로젝트(null이면 프로젝트 없는 기록만)·종류·쓴 쪽·세대·열린 약속만
 * - 쪽 크기 기본 50·최대 200, 다음 쪽 표시(nextCursor)로 이어 보면 빠짐·겹침이 없다. 틀린 표시는 invalid
 * - 참조는 지금 기록의 이름으로 보이고, 없어진 대상(지운 팀원·사라진 보고서)은 '(지워짐)'. 약속에는 상태와 오래됨·확인 필요가 붙는다
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { AiConfig } from '@shared/domain';
import type { JournalEntryView, JournalFilter } from '@shared/views';
import { mainOpsIdentity } from './mainOps';
import { bootOrch, seedDirective, type OrchEnv } from './orchHarness';

let env: OrchEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const CODEX: AiConfig = { kind: 'codex', model: null, effortTier: 'high', effortOverride: null };
const ids = (es: JournalEntryView[]) => es.map((x) => x.id);

describe('대표의 일지 보기 (journal.list)', () => {
  it('조건으로 거르고 새 것부터 준다 — 참조 이름과 (지워짐), 약속 표시', async () => {
    const e = (env = await bootOrch());
    const j = e.core.journal;
    const P = e.projectId;
    const d = seedDirective(e, '로그인 화면');
    j.server('command', '대표 명령 (로그인 화면)', { projectId: P, refs: [{ kind: 'project', id: P }] });
    j.server('stop', '긴급 정지');
    const w = (turn: string, args: Parameters<typeof j.write>[1], key = `main:${P}`) => j.write(mainOpsIdentity(key, turn), args).id as string;
    const promise = w('TN-1', { kind: 'promise', text: '로그인 화면이 끝나면 보고한다', refs: [d.id, e.devId] });
    const closed = w('TN-1', { kind: 'promise', text: '이미 지킨 약속', reason: '지키면 닫는다' });
    j.close(mainOpsIdentity(`main:${P}`, 'TN-1'), { id: closed, resolution: '지켰다' });
    const note = w('TN-2', { kind: 'note', text: '전체 메모' }, 'main:general');
    // 세대 2 (강제 교체 — 인계 메모 턴 없음)
    await e.core.seat.assign({ holder: { kind: 'launched', ai: CODEX }, by: 'operator', reason: '시험', force: true }).done;
    const decision = w('TN-3', { kind: 'decision', text: '디자인은 Figma 시안을 따른다' });

    const list = (f: JournalFilter = {}) => e.invoke('journal.list', f).then((p) => p.entries);
    const all = await list({ limit: 200 });
    // 새 것부터 (때·순번 차례)
    expect(all[0]!.id).toBe(decision);
    expect([...all].sort((a, b) => (a.at === b.at ? Number(b.id.slice(2)) - Number(a.id.slice(2)) : a.at < b.at ? 1 : -1)).map((x) => x.id)).toEqual(ids(all));
    // 프로젝트: 주면 그 프로젝트만, null이면 프로젝트 없는 기록만
    const inP = await list({ projectId: P });
    expect(inP.length).toBeGreaterThan(0);
    expect(inP.every((x) => x.projectId === P && x.projectName === '턴 회귀')).toBe(true);
    expect(ids(inP)).toEqual(expect.arrayContaining([promise, closed, decision]));
    const none = await list({ projectId: null });
    expect(none.every((x) => x.projectId === null && x.projectName === null)).toBe(true);
    expect(ids(none)).toContain(note);
    expect(ids(none)).not.toContain(promise);
    // 종류·쓴 쪽·세대
    expect(ids(await list({ kinds: ['promise'] }))).toEqual([closed, promise]);
    expect((await list({ kinds: ['decision', 'note'] })).map((x) => x.kind)).toEqual(['decision', 'note']);
    expect((await list({ author: 'agent' })).every((x) => x.author === 'agent')).toBe(true);
    expect(ids(await list({ author: 'agent' }))).toEqual([decision, note, closed, promise]);
    expect((await list({ author: 'server' })).every((x) => x.author === 'server' && !x.promise)).toBe(true);
    const g2 = await list({ generation: 2 });
    expect(g2.every((x) => x.generation === 2)).toBe(true);
    expect(ids(g2)).toContain(decision);
    expect(g2.find((x) => x.id === decision)!.holderLabel).toBe('Codex CLI');
    expect((await list({ generation: 1 })).find((x) => x.id === promise)!.holderLabel).toBe('Claude CLI');
    // 열린 약속만
    expect(ids(await list({ openPromisesOnly: true }))).toEqual([promise]);
    // 약속 표시와 참조 이름
    const p = all.find((x) => x.id === promise)!;
    expect(p.promise).toEqual({ state: 'open', stale: false, needsCheck: false, closedAt: null, resolution: null });
    expect(p.refs).toEqual([
      { kind: 'directive', id: d.id, label: '로그인 화면' },
      { kind: 'member', id: e.devId, label: e.ctx.store.members.require(e.devId).name },
    ]);
    expect(all.find((x) => x.id === closed)!.promise).toMatchObject({ state: 'closed', resolution: '지켰다', closedAt: expect.any(String) });
    // 없어진 대상은 (지워짐) — 지운 팀원, 참조한 지시가 닫히면 그 약속은 확인 필요
    await e.main('remove_member', { member_id: e.devId });
    e.ctx.store.directives.put({ ...e.ctx.store.directives.require(d.id), state: 'cancelled', cancelledAt: e.ctx.now() });
    const after = (await list({ openPromisesOnly: true }))[0]!;
    expect(after.refs.map((r) => [r.kind, r.label])).toEqual([
      ['directive', '로그인 화면'],
      ['member', '(지워짐)'],
    ]);
    expect(after.promise).toMatchObject({ needsCheck: true });
    const ghost = e.ctx.store.journal.insert({ ...e.ctx.store.journal.get(note)!, at: new Date(Date.now() + 1000).toISOString(), refs: [{ kind: 'report', id: 'R-9999' }, { kind: 'project', id: 'P-9999' }], projectId: 'P-9999' });
    const g = (await list({ limit: 1 }))[0]!;
    expect(g.id).toBe(ghost.id);
    expect([g.projectName, g.refs.map((r) => r.label)]).toEqual(['(지워짐)', ['(지워짐)', '(지워짐)']]);
  });

  it('쪽 크기 기본 50·최대 200, 다음 쪽 표시로 이어 보면 빠짐·겹침이 없고, 틀린 표시는 거부된다', async () => {
    const e = (env = await bootOrch());
    for (let i = 0; i < 230; i++) e.core.journal.server('action', `행동 ${i}`);
    const total = e.ctx.store.journal.count({});
    expect(total).toBe(231); // 처음 보유자가 앉은 서버 기록 한 줄 + 230
    const first = await e.invoke('journal.list', {});
    expect(first.entries).toHaveLength(50);
    expect(first.entries[0]!.text).toBe('행동 229');
    expect(first.nextCursor).toMatch(/^c\d+@/);
    const seen = [...ids(first.entries)];
    let cursor = first.nextCursor;
    let pages = 1;
    // 다음 쪽 표시가 끝나지 않으면(같은 쪽만 되풀이) 열 쪽에서 멈춰 실패로 보인다
    while (cursor && pages < 10) {
      const page = await e.invoke('journal.list', { cursor });
      seen.push(...ids(page.entries));
      cursor = page.nextCursor;
      pages += 1;
    }
    expect(pages).toBe(5);
    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);
    // 쪽 크기: 최대 200 (대표 길은 인자 모양에서 201을 거부, 안쪽 처리기는 200으로 묶는다)
    const big = await e.invoke('journal.list', { limit: 200 });
    expect([big.entries.length, typeof big.nextCursor]).toEqual([200, 'string']);
    expect(ids(big.entries)).toEqual(seen.slice(0, 200));
    const tail = await e.invoke('journal.list', { limit: 200, cursor: big.nextCursor! });
    expect([...ids(big.entries), ...ids(tail.entries)]).toEqual(seen);
    expect(tail.nextCursor).toBeNull();
    await expect(e.invoke('journal.list', { limit: 201 })).rejects.toMatchObject({ code: 'invalid_args' });
    expect(e.core.journal.list({ limit: 1000 }).entries).toHaveLength(200);
    expect(e.core.journal.list({ limit: 5 })).toMatchObject({ entries: expect.any(Array), nextCursor: expect.any(String) });
    // 조건과 함께 이어 보기
    const kindPage = await e.invoke('journal.list', { kinds: ['action'], limit: 200 });
    expect(kindPage.entries).toHaveLength(200);
    const rest = await e.invoke('journal.list', { kinds: ['action'], limit: 100, cursor: kindPage.nextCursor! });
    expect([rest.entries.length, rest.nextCursor]).toEqual([30, null]);
    // 틀린 다음 쪽 표시
    await expect(e.invoke('journal.list', { cursor: 'abc' })).rejects.toMatchObject({ code: 'invalid', message: '다음 쪽 표시(cursor)가 맞지 않습니다 — 앞 쪽의 nextCursor를 그대로 넘기세요' });
  });
});
