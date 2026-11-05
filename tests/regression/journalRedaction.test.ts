/**
 * 메인 일지와 인계 꾸러미는 저장 전에 가린다 (SERVER_DESIGN 6.3·10.4 journalRedaction, 리드 결정 S4-6, SEC-10):
 * - 대표 명령·메인의 도구 인자(지시 등록 글·넘기는 까닭과 남긴 말)·journal_write의 글과 닫는 조건·journal_close의 해결 글에 든 비밀 값(알려진 형식의 API 키와
 *   형식 규칙 밖의 등록 값)이 일지·인계 꾸러미·새 세션 인계(handoverSummary)·활동 기록 어디에도 원문으로 남지 않는다 — DB의 모든 표를 본다
 * - 가린 자리에는 가림 표시가 남는다 (무엇이 있었는지는 안다)
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID } from '@shared/domain';
import { bootOrch, waitFor, type OrchEnv } from './orchHarness';

let env: OrchEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

/** 알려진 형식(Anthropic API 키)과 형식 규칙 밖의 등록 값 */
const KEY = `sk-ant-api03-${'Q7v'.repeat(14)}xZ`;
const SECRET = 'wook-registered-9F3kQ2pL8mN4';

/** DB의 모든 표에서 그 글을 찾는다 (표 이름 목록) */
function tablesContaining(e: OrchEnv, needle: string): string[] {
  const db = e.ctx.store.db;
  const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map((t) => t.name);
  return tables.filter((t) => (db.prepare(`SELECT * FROM ${t}`).all() as Record<string, unknown>[]).some((r) => JSON.stringify(r).includes(needle)));
}

describe('메인 일지와 인계 꾸러미의 가림 (journalRedaction)', () => {
  it('명령·도구 인자·일지 글·닫는 조건·해결 글·넘기며 남긴 말의 비밀 값은 일지·꾸러미·세션 인계·활동 기록 어디에도 원문으로 남지 않는다', async () => {
    const e = (env = await bootOrch());
    e.ctx.redact.addSecret(SECRET, 'api-key');
    const KEYP = 'main:general';
    e.hold.add(KEYP);
    await e.invoke('command.send', { target: 'main', text: `이 키 ${KEY}와 ${SECRET}로 배포 설정을 바꿔 줘` });
    e.tick();
    await waitFor(() => !!e.liveProc(KEYP, MAIN_AGENT_ID), '메인 턴');
    const t = e.liveProc(KEYP, MAIN_AGENT_ID)!.turnId;
    const p = (await e.tool(t, 'journal_write', { kind: 'promise', text: `배포 키 ${KEY}를 운영자에게 넘긴다`, reason: `운영자가 ${SECRET}를 등록하면 닫는다` })) as { ok: true; data: { id: string } };
    expect(p.ok).toBe(true);
    expect((await e.tool(t, 'journal_write', { kind: 'note', text: `등록 값은 ${SECRET}이고 키는 ${KEY}다` })).ok).toBe(true);
    expect((await e.tool(t, 'journal_close', { id: p.data.id, resolution: `운영자에게 ${KEY}를 넘김` })).ok).toBe(true);
    expect((await e.tool(t, 'journal_write', { kind: 'promise', text: '새 메인이 운영자 확인을 받는다', reason: `확인 값 ${SECRET}` })).ok).toBe(true);
    expect((await e.tool(t, 'register_directive', { project_id: e.projectId, title: '배포 설정', text: `설정 파일에 ${KEY}를 넣지 않는다` })).ok).toBe(true);
    const h = await e.tool(t, 'hand_off_seat', { to: 'codex', reason: `대표 명령 (${SECRET})`, note: `키 ${KEY}는 운영자에게 있음` });
    expect(h.ok).toBe(true);
    e.liveProc(KEYP, MAIN_AGENT_ID)!.finishOk();
    await e.core.seat.settled();
    expect(e.core.seat.view()).toMatchObject({ generation: 2, state: 'active' });
    // 새 보유자의 첫 세션 인계에 꾸러미가 든다
    e.hold.clear();
    await e.invoke('command.send', { target: 'main', text: '이어서 해 줘' });
    await e.drain(1);
    const sessions = e.ctx.store.sessions.list({ ref1: MAIN_AGENT_ID });
    const fresh = sessions[sessions.length - 1]!;
    expect(fresh.handoverSummary).toContain('[메인 자리 인계 꾸러미 — 세대 2');
    expect(fresh.handoverSummary).toContain('넘기며 남긴 말 (세대 1): 키 [가림:');

    // 원문은 어디에도 없다 — 일지·꾸러미·세션·대기열·활동 기록 모두
    expect(tablesContaining(e, KEY)).toEqual([]);
    expect(tablesContaining(e, SECRET)).toEqual([]);
    // 가린 자리에는 표시가 남는다
    const journal = e.ctx.store.journal.query({ asc: true });
    const marked = (s: string) => s.includes('[가림:');
    expect(marked(journal.find((r) => r.kind === 'command')!.text)).toBe(true);
    expect(journal.filter((r) => r.author === 'agent').every((r) => marked(r.text))).toBe(true);
    expect(marked(journal.find((r) => r.id === p.data.id)!.promise!.resolution!)).toBe(true);
    expect(journal.filter((r) => r.kind === 'action').map((r) => marked(r.text))).toEqual([true, true]);
    const packet = e.core.seat.handover(2)!;
    expect(packet.sections.some((s) => s.lines.some(marked))).toBe(true);
    expect(e.core.handover.storedText(2)).not.toContain(KEY);
    // 보는 길(journal.list·get_handover)도 가린 글이다
    const listed = JSON.stringify(await e.invoke('journal.list', { limit: 200 }));
    expect([listed.includes(KEY), listed.includes(SECRET)]).toEqual([false, false]);
    const latest = e.core.handover.latest(2).text;
    expect([latest.includes(KEY), latest.includes(SECRET)]).toEqual([false, false]);
  });

  it('나중에 등록된 비밀 값도 꾸러미를 만들 때 가린다 — 그 전에 저장된 대화·질문 글에 원문이 있어도', async () => {
    const e = (env = await bootOrch());
    const LATE = 'late-registered-Zq81Xv02Wm';
    // 등록 전이라 원문 그대로 저장된다
    await e.invoke('command.send', { target: 'main', text: `나중에 등록할 값은 ${LATE}입니다` });
    await e.main('ask_owner', { question: `값 ${LATE}를 써도 될까요?` });
    expect(tablesContaining(e, LATE).length).toBeGreaterThan(0);
    e.ctx.redact.addSecret(LATE, 'api-key');
    const seat = { key: 'seat' as const, title: '자리 정보', unverified: false, lines: [`새 보유자: Codex CLI (${LATE})`], omitted: 0 };
    const sections = e.core.handover.build({ seat, generation: 2, now: e.ctx.now(), memo: null });
    const text = JSON.stringify(sections);
    expect(text).not.toContain(LATE);
    expect(text).toContain('[가림:');
    expect(e.core.handover.latest(1).text).not.toContain(LATE);
  });
});
