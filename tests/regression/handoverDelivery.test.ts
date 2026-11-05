/**
 * 인계 꾸러미 전달 (SERVER_DESIGN 6.2 '전달 방법', 리드 결정 S4-6):
 * - 새 세대의 키별 첫 세션 handoverSummary에 그 세대의 꾸러미가 든다 — 한 키가 아니라 메인의 모든 키(main:general·main:<P>·메인 검수 review:T)에.
 *   첫 턴 입력에도 실린다. 같은 세대의 다음 세션에는 다시 넣지 않는다
 * - 40턴 세션 교체(MEM-09)에는 지금 기록으로 다시 만든 최신판이 든다 — 교체 뒤에 생긴 일이 들어 있고, 교체가 한 번도 없었던 1세대에도 준다
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID, type AiConfig } from '@shared/domain';
import { bootOrch, seedInReviewTask, type OrchEnv } from './orchHarness';

let env: OrchEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const CODEX: AiConfig = { kind: 'codex', model: null, effortTier: 'high', effortOverride: null };
const MEM09 = '대화가 길어져 새 세션으로 이어감 (MEM-09)';
const LATEST = '이 꾸러미는 세션을 새로 열 때(대화가 길어진 세션 교체 등) 지금 기록으로 다시 만든 최신판입니다';
const openMain = (e: OrchEnv, key: string) => e.ctx.store.sessions.list({ ref1: MAIN_AGENT_ID, ref2: key, state: 'open' })[0];

describe('인계 꾸러미 전달 (handoverDelivery)', () => {
  it('새 세대의 키별 첫 세션마다 그 세대의 꾸러미가 든다 — 같은 세대의 다음 세션에는 다시 넣지 않는다', async () => {
    const e = (env = await bootOrch());
    const P = `main:${e.projectId}`;
    await e.invoke('command.send', { target: 'main', text: '첫 명령' });
    await e.invoke('command.send', { target: e.projectId, text: '프로젝트 명령' });
    await e.drain(2);
    expect([openMain(e, 'main:general')?.handoverSummary, openMain(e, P)?.handoverSummary]).toEqual([null, null]);
    await e.core.seat.assign({ holder: { kind: 'launched', ai: CODEX }, by: 'operator', reason: '시험 교체', force: true }).done;
    const stored = e.core.handover.storedText(2)!;
    expect(stored.startsWith('[메인 자리 인계 꾸러미 — 세대 2,')).toBe(true);

    // 새 세대: 직접 명령·프로젝트 대화·메인 검수 — 키마다 첫 세션
    await e.invoke('command.send', { target: 'main', text: '두 번째 명령' });
    await e.invoke('command.send', { target: e.projectId, text: '두 번째 프로젝트 명령' });
    const review = seedInReviewTask(e, MAIN_AGENT_ID);
    e.core.tasks.dispatchReview(e.ctx.store.tasks.require(review.id));
    // 메인 턴은 한 번에 하나 — 키 셋이면 세 차례
    await e.drain(3);
    for (const key of ['main:general', P, `review:${review.id}`]) {
      const s = e.ctx.store.sessions.list({ ref1: MAIN_AGENT_ID, ref2: key }).at(-1)!;
      expect([key, s.aiKind, s.replaceReason === null || s.replaceReason === '메인 자리 교체(세대 2)']).toEqual([key, 'codex', true]);
      expect(s.handoverSummary?.startsWith(stored), key).toBe(true);
      // 첫 턴 입력에도 실린다 (인용 줄로)
      const launch = e.launches.filter((l) => l.workKey === key).at(-1)!;
      expect(launch.message, key).toContain('## 이전 세션에서 넘겨받은 내용\n> [메인 자리 인계 꾸러미 — 세대 2,');
    }
    // 같은 세대의 다음 세션(실행 위치 변경 등으로 새로 연 세션)에는 다시 넣지 않는다
    e.core.turns.closeSessions('main:general', '시험: 세션 닫기');
    await e.invoke('command.send', { target: 'main', text: '세 번째 명령' });
    await e.drain(1);
    const again = e.ctx.store.sessions.list({ ref1: MAIN_AGENT_ID, ref2: 'main:general' }).at(-1)!;
    expect(again.replaceReason).toBe('시험: 세션 닫기');
    expect(again.handoverSummary).not.toContain('[메인 자리 인계 꾸러미');
    expect(e.errors).toEqual([]);
  });

  it('40턴 세션 교체(MEM-09)에는 지금 기록으로 다시 만든 최신판이 든다 — 교체 뒤에 생긴 일이 들고, 교체가 없던 1세대에도 준다', async () => {
    const e = (env = await bootOrch());
    // 1세대: 교체가 한 번도 없어도 MEM-09에는 최신판
    await e.invoke('command.send', { target: 'main', text: '첫 명령' });
    await e.drain(1);
    const s1 = openMain(e, 'main:general')!;
    e.ctx.store.sessions.put({ ...s1, turnCount: 40 });
    await e.invoke('command.send', { target: 'main', text: '마흔한 번째 명령' });
    await e.drain(1);
    const s2 = openMain(e, 'main:general')!;
    expect([s2.id !== s1.id, s2.replaceReason]).toEqual([true, MEM09]);
    expect(s2.handoverSummary).toContain('[메인 자리 인계 꾸러미 — 세대 1,');
    expect(s2.handoverSummary).toContain('## 자리 정보\n지금 보유자: Claude CLI (세대 1, ');
    expect(s2.handoverSummary).toContain(LATEST);

    // 교체 뒤에 생긴 질문은 저장된 꾸러미에는 없고 최신판에는 있다
    await e.core.seat.assign({ holder: { kind: 'launched', ai: CODEX }, by: 'operator', reason: '시험 교체', force: true }).done;
    await e.invoke('command.send', { target: 'main', text: '교체 뒤 명령' });
    await e.drain(1);
    const q = await e.main('ask_owner', { question: '교체 뒤에 생긴 질문입니다' });
    expect(e.core.handover.storedText(2)).not.toContain(String(q.questionId));
    const s3 = openMain(e, 'main:general')!;
    expect(s3.aiKind).toBe('codex');
    e.ctx.store.sessions.put({ ...s3, turnCount: 40 });
    await e.invoke('command.send', { target: 'main', text: '또 마흔한 번째' });
    await e.drain(1);
    const s4 = openMain(e, 'main:general')!;
    expect([s4.id !== s3.id, s4.replaceReason]).toEqual([true, MEM09]);
    const summary = s4.handoverSummary!;
    expect(summary).toContain('[메인 자리 인계 꾸러미 — 세대 2,');
    expect(summary).toContain('지금 보유자: Codex CLI (세대 2, ');
    expect(summary).toContain('이 세대를 연 쪽: 운영자 — 까닭: 시험 교체');
    expect(summary).toContain('이전 보유자: Claude CLI (세대 1)');
    expect(summary).toContain(LATEST);
    expect(summary).toContain(`- ${String(q.questionId)} 대표에게, `);
    // get_handover: 기본은 이 세대가 넘겨받은 꾸러미, latest면 최신판
    const got = await e.main('get_handover');
    expect([got.generation, got.latest, String(got.text).startsWith('[메인 자리 인계 꾸러미 — 세대 2,')]).toEqual([2, false, true]);
    expect(String(got.text)).not.toContain(String(q.questionId));
    const latest = await e.main('get_handover', { latest: true });
    expect([latest.latest, String(latest.text).includes(String(q.questionId)), String(latest.text).includes(LATEST)]).toEqual([true, true, true]);
    await expect(e.main('get_handover', { generation: 1 })).rejects.toMatchObject({ code: 'not_found', message: '세대 1의 인계 꾸러미가 없습니다 — 꾸러미는 자리를 교체해 시작한 세대에만 있습니다' });
  });
});
