/**
 * 수정 요청 뒤에도 메인 에이전트가 새 회차를 열기 전이면 대표가 보고서를 그대로 결과 승인할 수 있다 (리드 결정 10, 10-29 — owner-surface 리뷰 M4, 프로브 P4).
 * 수정 요청은 메인에게 가는 명령이고, 메인은 회차를 열지 않고 대표에게 되묻거나 새 지시로 처리할 수 있다(SERVER_DESIGN 2.2). 그때 대표가 "그대로 좋다"고
 * 하면 승인할 길이 있어야 한다 — 없으면 지시가 확인 대기로 영영 남는다.
 * - reports.approve는 수정 요청한 보고서도 받는다: 그 지시가 아직 확인 대기이고 지금 회차가 그 보고서일 때(메인이 revise_directive를 부르기 전)
 * - 승인하면 지시가 끝나고, 대기 중인 그 지시의 수정 요청 업무(change_request)를 지운다. 그 업무의 메인 턴이 이미 돌고 있어도 승인하고, 그 뒤의
 *   revise_directive는 conflict다
 * - ReportDetail.canApprove는 reports.approve가 지금 받는지와 같다 (화면은 이 값으로 승인 버튼을 보인다)
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Directive, Report } from '@shared/domain';
import { MAIN_AGENT_ID } from '@shared/domain';
import { buildSystemPrompt } from '../../src/main/orchestrator/prompts';
import { mainKey } from '../../src/main/orchestrator/records';
import type { OrchEnv } from './orchHarness';
import { bootOrch, seedDirective, waitFor } from './orchHarness';

let env: OrchEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const SECTIONS = { summary: '로그인 화면을 만들었습니다', results: '로그인 화면', changedFiles: [], howToVerify: '-', issues: '-', nextSteps: '-' };

/** 1회차 보고가 도착해 확인 대기인 지시 */
async function awaitingDirective(e: OrchEnv, title = '로그인 화면'): Promise<{ d: Directive; r: Report }> {
  const seeded = seedDirective(e, title);
  e.ctx.store.directives.put({ ...seeded, state: 'reporting' });
  const r = await e.core.reports.submit({ directiveId: seeded.id, sections: SECTIONS }, MAIN_AGENT_ID, null);
  return { d: e.ctx.store.directives.require(seeded.id), r };
}

const changeRequests = (e: OrchEnv, directiveId: string) => e.ctx.store.queue.list({ ref1: MAIN_AGENT_ID }).filter((q) => q.kind === 'change_request' && q.directiveId === directiveId);
const canApprove = async (e: OrchEnv, id: string) => (await e.invoke('reports.get', id)).canApprove;
const codeOf = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (err: { code?: string }) => err.code ?? 'error',
  );

describe('수정 요청 뒤 그대로 승인 (리드 결정 10)', () => {
  it('메인이 회차를 열지 않았으면 대표가 수정 요청한 보고서를 그대로 승인한다 — 지시가 끝나고, 대기 중인 수정 요청 업무가 지워지며, 그 뒤의 revise_directive는 conflict', async () => {
    const e = (env = await bootOrch());
    const { d, r } = await awaitingDirective(e);
    expect(await canApprove(e, r.id)).toBe(true);
    await e.invoke('reports.requestChanges', r.id, { overall: '버튼 색을 바꿔 줘', anchored: [] });
    expect(changeRequests(e, d.id).map((q) => q.state)).toEqual(['queued']);
    // 메인은 아직 회차를 열지 않았다 — 대표가 "그대로 좋다"
    expect(await canApprove(e, r.id)).toBe(true);
    await e.invoke('reports.approve', r.id, '그대로 좋습니다');
    expect(e.ctx.store.directives.require(d.id)).toMatchObject({ state: 'closed', round: 1 });
    expect(e.ctx.store.transitions.list(d.id).pop()).toMatchObject({ from: 'awaiting_confirmation', event: 'approve', to: 'closed', actor: 'owner' });
    expect(e.ctx.store.reports.require(r.id).status).toBe('approved');
    expect(changeRequests(e, d.id).map((q) => q.state)).toEqual(['cancelled']);
    expect(e.ctx.store.activity.search({ text: `보고서 ${r.id} 결과 승인`, limit: 5 }).map((a) => [a.actor, a.text])).toEqual([
      ['owner', `보고서 ${r.id} 결과 승인 (수정 요청 뒤 그대로 승인): 그대로 좋습니다`],
    ]);
    // 메인은 그 사실을 기억 업무로 받는다 (그 수정 요청으로 회차를 열지 않는다)
    const memo = e.ctx.store.queue.list({ ref1: MAIN_AGENT_ID, state: 'queued' }).filter((q) => q.kind === 'memory_update' && q.message.includes('수정 요청 뒤 그대로 결과 승인'));
    expect(memo.map((q) => q.sessionKey)).toEqual([mainKey(e.projectId)]);
    expect(await canApprove(e, r.id)).toBe(false);
    // 다시 승인해도 같은 결과 (아무것도 하지 않는다)
    await e.invoke('reports.approve', r.id, '');
    expect(e.ctx.store.activity.search({ text: `보고서 ${r.id} 결과 승인`, limit: 5 })).toHaveLength(1);
    await expect(e.main('revise_directive', { directive_id: d.id, report_id: r.id, instructions: '버튼 색만' })).rejects.toMatchObject({ code: 'conflict', message: expect.stringContaining('그대로 결과 승인') });
    expect(e.ctx.store.directives.require(d.id)).toMatchObject({ state: 'closed', round: 1 });
  });

  it('수정 요청 업무의 메인 턴이 이미 돌고 있어도 승인한다 — 그 턴의 revise_directive는 conflict이고 지시는 끝난 채다', async () => {
    const e = (env = await bootOrch());
    const { d, r } = await awaitingDirective(e);
    const key = mainKey(e.projectId);
    e.hold.add(key);
    await e.invoke('reports.requestChanges', r.id, { overall: '버튼 색을 바꿔 줘', anchored: [] });
    e.tick();
    await waitFor(() => !!e.liveProc(key, MAIN_AGENT_ID), '수정 요청 업무의 메인 턴');
    expect(changeRequests(e, d.id).map((q) => q.state)).toEqual(['running']);
    expect(await canApprove(e, r.id)).toBe(true);
    await e.invoke('reports.approve', r.id, '');
    expect(e.ctx.store.directives.require(d.id).state).toBe('closed');
    const turnId = e.launches.filter((l) => l.workKey === key).at(-1)!.turnId;
    const res = await e.tool(turnId, 'revise_directive', { directive_id: d.id, report_id: r.id, instructions: '버튼 색만' });
    expect(res).toMatchObject({ ok: false, code: 'conflict' });
    e.liveProc(key, MAIN_AGENT_ID)!.finishOk();
    e.hold.clear();
    await e.idle();
    expect(e.ctx.store.directives.require(d.id)).toMatchObject({ state: 'closed', round: 1 });
    expect(e.ctx.store.queue.list({ ref2: `directive:${d.id}` }).filter((q) => q.kind === 'plan')).toEqual([]);
  });

  it('메인이 새 회차를 열었거나 지시를 끝낸 뒤, 지시에 묶이지 않은 보고서면 수정 요청한 보고서는 승인할 수 없다 — canApprove도 false', async () => {
    const e = (env = await bootOrch());
    // 1) 메인이 새 회차를 열었다
    const a = await awaitingDirective(e, '회차를 연 지시');
    await e.invoke('reports.requestChanges', a.r.id, { overall: '다시', anchored: [] });
    await e.main('revise_directive', { directive_id: a.d.id, report_id: a.r.id, instructions: '다시 만드세요' });
    expect(await codeOf(e.invoke('reports.approve', a.r.id, ''))).toBe('conflict');
    expect(await canApprove(e, a.r.id)).toBe(false);
    expect(e.ctx.store.directives.require(a.d.id)).toMatchObject({ state: 'planning', round: 2 });
    // 그 회차의 보고가 오면 새 보고서는 승인할 수 있다 (이전 회차의 수정 요청 보고서는 여전히 아니다)
    e.ctx.store.directives.put({ ...e.ctx.store.directives.require(a.d.id), state: 'reporting' });
    const r2 = await e.core.reports.submit({ directiveId: a.d.id, sections: SECTIONS }, MAIN_AGENT_ID, null);
    expect([await canApprove(e, r2.id), await canApprove(e, a.r.id)]).toEqual([true, false]);
    expect(await codeOf(e.invoke('reports.approve', a.r.id, ''))).toBe('conflict');
    // 2) 메인이 지시를 취소했다
    const b = await awaitingDirective(e, '취소한 지시');
    await e.invoke('reports.requestChanges', b.r.id, { overall: '새 지시로', anchored: [] });
    await e.main('cancel_directive', { directive_id: b.d.id, reason: '대표 요청은 새 지시로 처리' });
    expect(await codeOf(e.invoke('reports.approve', b.r.id, ''))).toBe('conflict');
    expect(await canApprove(e, b.r.id)).toBe(false);
    // 3) 지시에 묶이지 않은 직접 명령의 보고서
    const c = await e.core.reports.submit({ directiveId: null, title: '직접 명령 결과', sections: SECTIONS }, MAIN_AGENT_ID, null);
    expect(await canApprove(e, c.id)).toBe(true);
    await e.invoke('reports.requestChanges', c.id, { overall: '표로', anchored: [] });
    expect(await codeOf(e.invoke('reports.approve', c.id, ''))).toBe('conflict');
    expect(await canApprove(e, c.id)).toBe(false);
    for (const id of [a.r.id, b.r.id, c.id]) expect(e.ctx.store.reports.require(id).status).toBe('changes_requested');
  });

  it('메인 에이전트는 회차를 열지 않고 처리하면 대표에게 그대로 승인할 수 있다고 알리거나 지시를 취소하라고 안내받는다 (지침·수정 요청 업무)', async () => {
    const e = (env = await bootOrch());
    const main = buildSystemPrompt({ member: e.ctx.store.members.require(MAIN_AGENT_ID), role: null, project: null, sessionKind: 'main_project', cwd: 'C:\\wook\\main-agent', manualSkills: [] });
    expect(main).toContain('회차를 열지 않고 처리하면 대표에게 그 보고서를 그대로 결과 승인할 수 있다고 알리거나, 지시를 끝내야 하면 cancel_directive로 까닭과 함께 취소한다');
    const { d, r } = await awaitingDirective(e);
    await e.invoke('reports.requestChanges', r.id, { overall: '버튼 색을 바꿔 줘', anchored: [] });
    const msg = changeRequests(e, d.id)[0]!.message;
    expect(msg).toContain('회차를 열지 않고 처리하면 대표에게 이 보고서를 그대로 결과 승인할 수 있다고 알리거나');
    expect(msg).toContain('cancel_directive');
  });
});
