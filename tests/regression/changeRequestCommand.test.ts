/**
 * 수정 요청은 메인 에이전트에게 가는 명령이다 (FBK-03 v0.6, SERVER_DESIGN 2.2·2.6·10.1 changeRequestCommand):
 * - 대표가 보고서에 수정 요청을 하면 보고서는 '수정 요청'이 되고 지시는 확인 대기 그대로다. 메인 대기열(main:<P>)에 change_request(코멘트 포함)가 생기고,
 *   프로듀서에게는 아직 아무것도 가지 않는다
 * - 메인 에이전트가 revise_directive를 부르면 회차 +1, 확인 대기 → 계획(행위자 메인), 대표 코멘트(전체·부분)는 그대로 그 회차 요청으로 붙고 프로듀서 [plan]에
 *   대표 코멘트와 메인의 지시가 함께 간다. 사유 기록·대표 정보 알림. 같은 수정 요청으로 다시 열 수 없고, 수정 요청이 없는 보고서로는 열 수 없다
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Directive, Report } from '@shared/domain';
import { MAIN_AGENT_ID } from '@shared/domain';
import { directiveKey, mainKey } from '../../src/main/orchestrator/records';
import type { OrchEnv } from './orchHarness';
import { bootOrch, notices, seedDirective } from './orchHarness';

let env: OrchEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const SECTIONS = { summary: '로그인 화면을 만들었습니다', results: '로그인 화면', changedFiles: ['login.txt'], howToVerify: '화면을 엽니다', issues: '', nextSteps: '' };
const OVERALL = '버튼 색을 파란색으로 바꿔 주세요';
const ANCHORED = [{ quote: '결과', comment: '변경 파일을 더 자세히' }];

/** 1회차 보고가 도착해 확인 대기인 지시 */
async function awaitingDirective(e: OrchEnv): Promise<{ d: Directive; r: Report }> {
  const seeded = seedDirective(e, '로그인 화면');
  e.ctx.store.directives.put({ ...seeded, state: 'reporting' });
  const r = await e.core.reports.submit({ directiveId: seeded.id, sections: SECTIONS }, MAIN_AGENT_ID, null);
  const d = e.ctx.store.directives.require(seeded.id);
  expect([d.state, d.round, d.rounds[0]!.reportId]).toEqual(['awaiting_confirmation', 1, r.id]);
  return { d, r };
}

const changeRequests = (e: OrchEnv, directiveId: string) => e.ctx.store.queue.list({ ref1: MAIN_AGENT_ID }).filter((q) => q.kind === 'change_request' && q.directiveId === directiveId);
const plans = (e: OrchEnv, directiveId: string) => e.ctx.store.queue.list({ ref2: directiveKey(directiveId) }).filter((q) => q.kind === 'plan');

describe('수정 요청 → 메인 에이전트 → 다음 회차 (FBK-03 v0.6)', () => {
  it('대표의 수정 요청 뒤 지시는 확인 대기 그대로이고, 메인 대기열에 change_request(코멘트 포함)가 생기며 프로듀서에게는 아직 가지 않는다', async () => {
    const e = (env = await bootOrch());
    const { d, r } = await awaitingDirective(e);
    await e.invoke('reports.requestChanges', r.id, { overall: OVERALL, anchored: ANCHORED });
    const cur = e.ctx.store.directives.require(d.id);
    expect([cur.state, cur.round, cur.rounds.length]).toEqual(['awaiting_confirmation', 1, 1]);
    expect(e.ctx.store.transitions.list(d.id).some((x) => x.event === 'request_changes')).toBe(false);
    expect(e.ctx.store.reports.require(r.id).status).toBe('changes_requested');
    const items = changeRequests(e, d.id);
    expect(items.map((q) => [q.sessionKey, q.priority])).toEqual([[mainKey(e.projectId), 'high']]);
    expect(items[0]!.message).toContain(OVERALL);
    expect(items[0]!.message).toContain('"결과" → 변경 파일을 더 자세히');
    expect(items[0]!.message).toContain(`revise_directive(directive_id="${d.id}", report_id="${r.id}"`);
    expect(plans(e, d.id)).toEqual([]);
    // 메인이 회차를 열지 않고 지시를 취소하면(새 지시로 처리하기로 함) 그 수정 요청으로는 더 열 수 없고, 대표도 그 보고서를 더 승인할 수 없다 —
    // 수정 요청 뒤 그대로 승인은 메인이 회차를 열거나 지시를 끝내기 전까지만 된다 (리드 결정 10, approveAfterChangeRequest 시험)
    await e.main('cancel_directive', { directive_id: d.id, reason: '대표 요청은 새 지시로 처리' });
    await expect(e.main('revise_directive', { directive_id: d.id, report_id: r.id, instructions: '다시' })).rejects.toMatchObject({ code: 'conflict' });
    await expect(e.invoke('reports.approve', r.id, '')).rejects.toMatchObject({ code: 'conflict' });
    expect(e.ctx.store.reports.require(r.id).status).toBe('changes_requested');
    expect(e.ctx.store.directives.require(d.id)).toMatchObject({ state: 'cancelled', round: 1 });
  });

  it('메인 에이전트가 revise_directive를 부르면 회차 +1·계획(행위자 메인), 대표 코멘트가 그 회차 요청으로 붙고 프로듀서 계획이 간다 — 사유 기록·대표 알림, 다시 열 수는 없다', async () => {
    const e = (env = await bootOrch());
    const { d, r } = await awaitingDirective(e);
    // 수정 요청 전에는 열 수 없다
    await expect(e.main('revise_directive', { directive_id: d.id, report_id: r.id, instructions: '다시' })).rejects.toMatchObject({ code: 'conflict' });
    await e.invoke('reports.requestChanges', r.id, { overall: OVERALL, anchored: ANCHORED });
    // 다른 지시의 보고서로는 열 수 없다
    const other = await awaitingDirective(e);
    await expect(e.main('revise_directive', { directive_id: d.id, report_id: other.r.id, instructions: '다시' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(e.main('revise_directive', { directive_id: d.id, report_id: r.id, instructions: '  ' })).rejects.toMatchObject({ code: 'invalid' });

    const res = await e.main('revise_directive', { directive_id: d.id, report_id: r.id, instructions: '파란 버튼은 로그인 화면만 바꾸세요', request_id: 'rev-1' });
    expect(res).toMatchObject({ directiveId: d.id, round: 2, state: 'planning' });
    const nd = e.ctx.store.directives.require(d.id);
    expect([nd.state, nd.round]).toEqual(['planning', 2]);
    expect(nd.rounds[1]).toMatchObject({ round: 2, text: OVERALL, anchored: ANCHORED, reportId: null });
    expect(e.ctx.store.transitions.list(d.id).pop()).toMatchObject({ from: 'awaiting_confirmation', event: 'request_changes', to: 'planning', actor: MAIN_AGENT_ID, requestId: 'rev-1' });
    const plan = plans(e, d.id);
    expect(plan.map((q) => q.memberId)).toEqual([e.producerId]);
    expect(plan[0]!.message).toContain(OVERALL);
    expect(plan[0]!.message).toContain('"결과" → 변경 파일을 더 자세히');
    expect(plan[0]!.message).toContain('메인 에이전트 지시: 파란 버튼은 로그인 화면만 바꾸세요');
    // 사유 기록(행위자 메인)과 대표 정보 알림
    expect(e.ctx.store.activity.search({ text: '(revise_directive) — 사유: 파란 버튼은 로그인 화면만 바꾸세요', limit: 5 }).map((a) => a.actor)).toEqual([MAIN_AGENT_ID]);
    expect(notices(e, '메인 에이전트 조작').some((n) => n.body.includes(`지시 ${d.id} 2회차 시작`))).toBe(true);
    // 같은 요청의 재전송은 한 번만, 같은 수정 요청으로 다시 열 수는 없다
    expect(await e.main('revise_directive', { directive_id: d.id, report_id: r.id, instructions: '파란 버튼은 로그인 화면만 바꾸세요', request_id: 'rev-1' })).toMatchObject({ duplicateRequest: true });
    await expect(e.main('revise_directive', { directive_id: d.id, report_id: r.id, instructions: '한 번 더' })).rejects.toMatchObject({ code: 'conflict' });
    expect(e.ctx.store.directives.require(d.id).round).toBe(2);
    expect(plans(e, d.id)).toHaveLength(1);
    // 2회차 보고가 도착해 다시 확인 대기 — 이전 회차의 수정 요청 보고서로는 3회차를 열 수 없고, 수정 요청이 없는 새 보고서로도 열 수 없다
    e.ctx.store.directives.put({ ...e.ctx.store.directives.require(d.id), state: 'reporting' });
    const r2 = await e.core.reports.submit({ directiveId: d.id, sections: SECTIONS }, MAIN_AGENT_ID, null);
    expect(e.ctx.store.directives.require(d.id)).toMatchObject({ state: 'awaiting_confirmation', round: 2 });
    await expect(e.main('revise_directive', { directive_id: d.id, report_id: r.id, instructions: '이전 요청으로 다시' })).rejects.toMatchObject({ code: 'conflict' });
    await expect(e.main('revise_directive', { directive_id: d.id, report_id: r2.id, instructions: '요청 없이' })).rejects.toMatchObject({ code: 'conflict' });
    expect(e.ctx.store.directives.require(d.id)).toMatchObject({ state: 'awaiting_confirmation', round: 2 });
  });

  it('지시에 묶이지 않은 보고서의 수정 요청도 메인 에이전트에게 업무로 간다 — 회차를 열 지시가 없다고 안내한다', async () => {
    const e = (env = await bootOrch());
    const r = await e.core.reports.submit({ directiveId: null, title: '직접 명령 결과', sections: SECTIONS }, MAIN_AGENT_ID, null);
    await e.invoke('reports.requestChanges', r.id, { overall: '표로 정리해 주세요', anchored: [] });
    const items = e.ctx.store.queue.list({ ref1: MAIN_AGENT_ID }).filter((q) => q.kind === 'change_request');
    expect(items.map((q) => q.sessionKey)).toEqual([mainKey(null)]);
    expect(items[0]!.message).toContain('표로 정리해 주세요');
    expect(items[0]!.message).toContain('지시에 묶이지 않은');
  });
});
