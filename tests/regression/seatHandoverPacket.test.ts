/**
 * 인계 꾸러미 (SERVER_DESIGN 6.2·10.4 seatHandoverPacket, 리드 결정 S4-6):
 * - 서버가 DB에서 정해진 규칙으로 만든다 — 열린 질문, 닫히지 않은 지시, 메인이 맡은 일(메인 검수 작업 포함), 대상별 최근 대화, 승인을 기다리는 보고,
 *   처리하지 않은 대표 수정 요청, 최근 메인 행동(사실)과 이전 메인의 약속(확인되지 않은 주장), 기억 문서 위치가 6.2 순서로 든다
 * - 나가는 보유자가 한 번도 답하지 않아도(마무리 시간·인계 메모 시간을 모두 넘겨 멈춤) 만들어진다
 * - 12,000자를 넘지 않는다 — 넘치면 줄이 많은 묶음부터 빼고 '외 n건'으로 남기고, 칸의 omitted에 뺀 수가 있다. 같은 기록과 때면 늘 같은 꾸러미다
 * - 상한은 머리 줄까지 넣은 글 그대로다(12,000자면 빼지 않고 12,001자면 한 줄). 줄이 같으면 뒤 묶음에서 빼고, 시간 차례 묶음은 오래된 것부터, 나머지는 뒤에서부터 뺀다
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID, type AiConfig } from '@shared/domain';
import type { HandoverSection } from '@shared/views';
import { HANDOVER_MAX_CHARS, renderHandover } from '../../src/main/orchestrator/handover';
import { mainOpsIdentity } from './mainOps';
import { bootOrch, seedInReviewTask, waitFor, type OrchEnv } from './orchHarness';

let env: OrchEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const CODEX: AiConfig = { kind: 'codex', model: null, effortTier: 'high', effortOverride: null };
const section = (sections: readonly HandoverSection[], key: HandoverSection['key']) => sections.find((s) => s.key === key)!;

describe('인계 꾸러미 (seatHandoverPacket)', () => {
  it('열린 질문·지시·약속·최근 대화·처리하지 않은 수정 요청·메인 검수 작업이 든다 — 나가는 보유자가 한 번도 답하지 않아도 만들어진다', async () => {
    const e = (env = await bootOrch());
    e.core.seat.applyOperatorConfig({ holders: null, drainMs: 200, initialHolder: null }, '시험');
    e.ctx.deps.timing!.memoTurnMs = 300;
    const key = `main:${e.projectId}`;
    // 메인 턴 하나가 질문·지시·약속·보고를 남긴다
    e.hold.add(key);
    await e.invoke('command.send', { target: e.projectId, text: '로그인 화면을 새로 만들어 줘' });
    e.tick();
    await waitFor(() => !!e.liveProc(key, MAIN_AGENT_ID), '메인 턴');
    const t = e.liveProc(key, MAIN_AGENT_ID)!.turnId;
    const q = await e.tool(t, 'ask_owner', { question: '로그인은 구글만 받을까요, 이메일도 받을까요?' });
    const d = await e.tool(t, 'register_directive', { project_id: e.projectId, title: '로그인 화면', text: '구글 로그인 화면을 만든다' });
    const qid = (q as { data: { questionId: string } }).data.questionId;
    const did = (d as { data: { directiveId: string } }).data.directiveId;
    const p = await e.tool(t, 'journal_write', { kind: 'promise', text: '대표 답을 받으면 이메일 로그인 여부를 프로듀서에게 전한다', refs: [qid, did] });
    expect(p.ok).toBe(true);
    const pid = (p as { data: { id: string } }).data.id;
    const r1 = await e.tool(t, 'submit_report', { title: '현황 보고', summary: '지금 상황입니다', results: '정리', changed_files: [], how_to_verify: '-', issues: '', next_steps: '' });
    const r2 = await e.tool(t, 'submit_report', { title: '두 번째 보고', summary: '두 번째', results: '정리', changed_files: [], how_to_verify: '-', issues: '', next_steps: '' });
    const rid1 = (r1 as { data: { reportId: string } }).data.reportId;
    const rid2 = (r2 as { data: { reportId: string } }).data.reportId;
    await e.invoke('reports.requestChanges', rid1, { overall: '배포 일정도 넣어 주세요', anchored: [] });
    // 메인이 검수자인 작업
    const review = seedInReviewTask(e, MAIN_AGENT_ID);

    // 운영자 교체 — 나가는 보유자는 끝까지 답하지 않는다: 지금 턴은 마무리 시간을, 인계 메모 턴은 메모 시간을 넘겨 멈춘다
    const swap = e.core.seat.assign({ holder: { kind: 'launched', ai: CODEX }, by: 'operator', reason: '응답이 없어 운영자가 바꿈' });
    await swap.done;
    expect(e.core.seat.view()).toMatchObject({ generation: 2, state: 'active', holder: { label: 'Codex CLI' } });
    const mainTurns = e.ctx.store.turns.list({ ref1: MAIN_AGENT_ID });
    expect(mainTurns.map((x) => [x.endReason, x.endDetail])).toEqual([
      ['user_stop', '메인 자리 교체(세대 2) — 마무리 시간 0.2초를 넘김'],
      ['user_stop', '메인 자리 교체(세대 2) — 인계 메모 시간(0.3초)을 넘김'],
    ]);
    // 끝나지 않은 메모 업무는 새 보유자에게 가지 않는다
    expect(e.ctx.store.queue.list({ state: ['queued', 'running'] }).filter((x) => x.message.includes('[메인 자리 인계 메모]'))).toEqual([]);

    const packet = e.core.seat.handover(2)!;
    expect(packet.sections.map((s) => [s.key, s.title, s.unverified])).toEqual([
      ['seat', '자리 정보', false],
      ['facts', '확인된 사실 (기록에서 만든 것)', false],
      ['memos', '이전 메인 에이전트의 메모 (확인되지 않은 주장)', true],
      ['memory', '기억 문서 위치', false],
    ]);
    const facts = section(packet.sections, 'facts').lines;
    const has = (lines: string[], s: string) => expect(lines.some((l) => l.includes(s)), s).toBe(true);
    // 열린 질문 (메인이 대표에게)
    expect(facts).toContain('[답을 받지 못한 질문] 1건');
    has(facts, `- ${qid} 대표에게 (${e.projectId}),`);
    has(facts, '로그인은 구글만 받을까요, 이메일도 받을까요?');
    // 닫히지 않은 지시
    has(facts, `- ${did} "로그인 화면" (${e.projectId}, 1회차, `);
    // 메인이 맡은 일 — 쌓인 명령(키별)과 메인 검수
    has(facts, `- ${key}: `);
    has(facts, `- review:${review.id} 메인 검수 — "검수 대상 작업" (${e.projectId}, 검수)`);
    // 대상별 최근 대화 (대표 명령)
    has(facts, '[최근 대화 — ');
    has(facts, '대표: 로그인 화면을 새로 만들어 줘');
    // 승인을 기다리는 보고, 처리하지 않은 대표 수정 요청
    expect(facts).toContain('[대표 승인을 기다리는 보고] 1건');
    has(facts, `- ${rid2} "두 번째 보고"`);
    expect(facts).toContain('[처리하지 않은 대표 수정 요청] 1건');
    has(facts, `- ${rid1} "현황 보고" — 대표 코멘트: 배포 일정도 넣어 주세요`);
    // 최근 메인 행동 (일지의 서버 기록)
    has(facts, `대표에게 질문 ${qid}: 로그인은 구글만 받을까요, 이메일도 받을까요?`);
    has(facts, `지시 ${did} 등록 (${e.projectId}): "로그인 화면"`);
    // 이전 메인의 약속 — 확인되지 않은 주장 칸에만, 쓴 보유자와 세대가 붙는다
    const memos = section(packet.sections, 'memos').lines;
    expect(memos).toContain('[열린 약속] 1건');
    has(memos, `- ${pid} [세대 1 · Claude CLI · `);
    has(memos, `(참조: ${qid}, ${did})`);
    expect(facts.some((l) => l.includes(pid))).toBe(false);
    // 메모 턴에서 남긴 글은 없다 (답하지 않았다)
    expect(memos).toContain('[넘길 때 남긴 글 (인계 메모)] 없음');
    // 기억 문서 위치
    const memory = section(packet.sections, 'memory').lines;
    has(memory, '일반 기억: ');
    has(memory, `${e.projectId} 턴 회귀: `);
    has(memory, `read_memory(project_id="${e.projectId}")`);
    // 글 길이와 상한
    expect(packet.chars).toBe(renderHandover(packet).length);
    expect(packet.chars).toBeLessThanOrEqual(HANDOVER_MAX_CHARS);
    expect(packet.sections.every((s) => s.omitted === 0)).toBe(true);
    expect(e.errors).toEqual([]);
  });

  it('12,000자를 넘지 않는다 — 줄이 많은 묶음부터 빼고 외 n건과 뺀 수를 남긴다. 같은 기록과 때면 늘 같은 꾸러미다', async () => {
    const e = (env = await bootOrch());
    // 열린 약속 60건 (각 900자 안팎) — 목록 상한 50건과 글 상한을 모두 넘긴다
    for (let i = 0; i < 60; i++) {
      e.core.journal.write(mainOpsIdentity('main:general', `TN-p${i}`), { kind: 'promise', text: `약속 ${i}번: ${'다음 메인이 이어서 확인할 일입니다. '.repeat(40)}`.slice(0, 900), reason: '다음 메인이 확인하면 닫는다' });
    }
    for (let i = 0; i < 12; i++) await e.invoke('command.send', { target: 'main', text: `명령 ${i}: ${'긴 명령 글 '.repeat(30)}` });
    const seat: HandoverSection = { key: 'seat', title: '자리 정보', unverified: false, lines: ['이전 보유자: Claude CLI (세대 1)', '새 보유자: Codex CLI (세대 2)'], omitted: 0 };
    const now = e.ctx.now();
    const sections = e.core.handover.build({ seat, generation: 2, now, memo: null });
    const text = renderHandover({ generation: 2, createdAt: now, sections });
    expect(text.length).toBeLessThanOrEqual(HANDOVER_MAX_CHARS);
    expect(text.length).toBeGreaterThan(HANDOVER_MAX_CHARS - 1500);
    const memos = section(sections, 'memos');
    const head = memos.lines.find((l) => l.startsWith('[열린 약속] 60건'))!;
    const shown = memos.lines.filter((l) => l.startsWith('- J-')).length;
    expect(head).toBe(`[열린 약속] 60건 — 아래 ${memos.lines.filter((l) => l.startsWith('- J-') && l.includes('약속 ')).length}건, 외 ${60 - shown}건`);
    expect(shown).toBeLessThan(50);
    expect(memos.omitted).toBe(60 - shown);
    // 뺀 것은 새 약속 쪽이다 — 열린 약속은 오래된 것부터 늘어놓고 오래 열린 것부터 남긴다 (S4-22 8번)
    const kept = memos.lines.filter((l) => l.startsWith('- J-') && l.includes('약속 ')).map((l) => Number(/약속 (\d+)번/.exec(l)![1]));
    expect(kept).toEqual(kept.map((_, i) => i));
    // 자리·기억 칸은 줄이지 않는다
    expect(section(sections, 'seat').lines).toEqual(seat.lines);
    expect(section(sections, 'memory').omitted).toBe(0);
    // 같은 기록과 같은 때면 같은 꾸러미
    expect(e.core.handover.build({ seat, generation: 2, now, memo: null })).toEqual(sections);
    // 교체로 저장한 꾸러미도 상한 안이고, chars는 그 글의 길이다
    await e.core.seat.assign({ holder: { kind: 'launched', ai: CODEX }, by: 'operator', reason: '시험', force: true }).done;
    const packet = e.core.seat.handover(2)!;
    expect(packet.chars).toBe(renderHandover(packet).length);
    expect(packet.chars).toBeLessThanOrEqual(HANDOVER_MAX_CHARS);
    expect(packet.sections.reduce((n, s) => n + s.omitted, 0)).toBeGreaterThan(10);
  });

  it('상한은 머리 줄까지 넣은 글의 12,000자 그대로다 — 12,000자면 빼지 않고 1자 넘으면 한 줄만 뺀다. 줄이 가장 많은 묶음에서, 같으면 뒤 묶음에서, 시간 차례 묶음은 오래된 것부터 (S4-22 8번)', async () => {
    const e = (env = await bootOrch());
    // 최근 메인 행동(확인된 사실, 시간 차례 — 오래된 것부터 뺀다) 20건과 열린 약속(메모, 뒤에서부터 뺀다) 19건 — 다른 묶음은 거의 비었다
    for (let i = 0; i < 20; i++) e.core.journal.server('action', `행동 ${i}번: ${'메인이 한 일을 적은 서버 기록입니다. '.repeat(6)}`, { generation: 1 });
    const promise = (i: number) =>
      e.core.journal.write(mainOpsIdentity('main:general', `TN-p${i}`), { kind: 'promise', text: `약속 ${i}번: ${'다음 메인이 이어서 확인할 일입니다. '.repeat(5)}`, reason: '확인하면 닫는다' });
    for (let i = 0; i < 19; i++) promise(i);
    const now = e.ctx.now();
    const seatLines = ['이전 보유자: Claude CLI (세대 1)', '새 보유자: Codex CLI (세대 2)'];
    const build = (pad: number) => {
      const seat: HandoverSection = { key: 'seat', title: '자리 정보', unverified: false, lines: pad > 0 ? [...seatLines, '가'.repeat(pad)] : seatLines, omitted: 0 };
      const sections = e.core.handover.build({ seat, generation: 2, now, memo: null });
      return { sections, text: renderHandover({ generation: 2, createdAt: now, sections }) };
    };
    /** 꾸러미 글이 꼭 target자가 되게 자리 칸(줄이지 않는 칸)에 한 줄을 더한다 — 그 줄과 앞 줄 사이의 줄바꿈 1자를 셈에 넣는다 */
    const sized = (target: number) => build(target - build(0).text.length - 1);
    const group = (sections: readonly HandoverSection[], key: HandoverSection['key'], title: string) => {
      const lines = section(sections, key).lines;
      const at = lines.findIndex((l) => l.startsWith(`[${title}]`));
      const end = lines.findIndex((l, i) => i > at && l.startsWith('['));
      return { head: lines[at]!, items: lines.slice(at + 1, end < 0 ? undefined : end) };
    };
    const ACTIONS = '최근 메인 행동 (일지의 서버 기록)';
    const numbers = (items: string[], word: string) => items.map((l) => Number(new RegExp(`${word} (\\d+)번`).exec(l)![1]));
    const upTo = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
    expect(build(0).text.length).toBeLessThan(HANDOVER_MAX_CHARS - 500);

    // 꼭 12,000자: 빼지 않는다
    const exact = sized(HANDOVER_MAX_CHARS);
    expect(exact.text.length).toBe(HANDOVER_MAX_CHARS);
    expect(exact.sections.every((s) => s.omitted === 0)).toBe(true);
    // 12,001자: 줄이 가장 많은 묶음(최근 메인 행동 20건)에서 한 줄 — 시간 차례라 가장 오래된 행동
    const over = sized(HANDOVER_MAX_CHARS + 1);
    expect(over.text.length).toBeLessThanOrEqual(HANDOVER_MAX_CHARS);
    expect(over.sections.reduce((n, s) => n + s.omitted, 0)).toBe(1);
    const actions = group(over.sections, 'facts', ACTIONS);
    expect(actions.head).toBe(`[${ACTIONS}] 20건 — 아래 19건, 외 1건`);
    expect(numbers(actions.items, '행동')).toEqual(upTo(1, 19));
    expect(group(over.sections, 'memos', '열린 약속').head).toBe('[열린 약속] 19건');

    // 약속이 20건이 되면 두 묶음이 같다 — 뒤 묶음(메모 칸의 열린 약속)에서 한 줄, 뒤에서부터라 가장 새 약속
    promise(19);
    const tie = sized(HANDOVER_MAX_CHARS + 1);
    expect(tie.text.length).toBeLessThanOrEqual(HANDOVER_MAX_CHARS);
    const promises = group(tie.sections, 'memos', '열린 약속');
    expect(promises.head).toBe('[열린 약속] 20건 — 아래 19건, 외 1건');
    expect(numbers(promises.items, '약속')).toEqual(upTo(0, 18));
    expect(group(tie.sections, 'facts', ACTIONS).head).toBe(`[${ACTIONS}] 20건`);
    expect(sized(HANDOVER_MAX_CHARS).sections.every((s) => s.omitted === 0)).toBe(true);
  });
});
