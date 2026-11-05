/**
 * 지시가 이미 끝났거나 취소된 보고서의 수정 요청 (리드 결정 25, 10-30 — flows 재리뷰 medium, 프로브 zz-s1fx2fg-cancelled-change-request):
 * - 예전에는 메인 에이전트가 확인 대기 지시를 취소한 뒤에도 그 보고서('새 보고서'·'읽음')에 대표의 수정 요청을 받았다. 보고서는 '수정 요청'이 되고 대표는
 *   ok를 받았지만, 그 change_request는 태어날 때부터 끝난 업무라(지시 취소 — 리드 결정 19) 스케줄러가 메인 턴에 싣기 전에 지웠다. 수정 요청은 메인
 *   에이전트에게 가는 명령인데(SERVER_DESIGN 2.2) 메인은 그 명령을 받지 못했다
 * - 이제 reports.requestChanges가 지시가 끝났거나 취소된 보고서를 conflict로 거부하고 명령창으로 메인 에이전트에게 말하라고 알린다. 화면은
 *   ReportDetail.canRequestChanges(같은 판정)로 '수정 요청'을 보인다. canApprove는 reports.approve가 받는지와 같다 — 취소된 지시의 보고서도
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID, type Report } from '@shared/domain';
import { mainKey } from '../../src/main/orchestrator/records';
import { bootOrch, seedDirective, sleep, waitFor, type OrchEnv } from './orchHarness';

let env: OrchEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const SECTIONS = { summary: '로그인 화면을 만들었습니다', results: '로그인 화면', changedFiles: [], howToVerify: '-', issues: '-', nextSteps: '-' };
const codeOf = (p: Promise<unknown>) =>
  p.then(
    () => ({ code: 'ok', message: '' }),
    (err: { code?: string; message?: string }) => ({ code: err.code ?? 'error', message: err.message ?? '' }),
  );

/** 확인 대기 지시와 그 보고서 (메인 에이전트가 낸 보고서) */
async function reported(e: OrchEnv): Promise<{ directiveId: string; report: Report }> {
  const seeded = seedDirective(e, '로그인 화면');
  e.ctx.store.directives.put({ ...seeded, state: 'reporting' });
  const report = await e.core.reports.submit({ directiveId: seeded.id, sections: SECTIONS }, MAIN_AGENT_ID, null);
  await e.drain(2);
  expect(e.ctx.store.directives.require(seeded.id).state).toBe('awaiting_confirmation');
  return { directiveId: seeded.id, report };
}
const changeRequests = (e: OrchEnv, directiveId: string) => e.ctx.store.queue.list({ ref1: MAIN_AGENT_ID }).filter((q) => q.kind === 'change_request' && q.directiveId === directiveId);
const can = async (e: OrchEnv, id: string) => {
  const d = await e.invoke('reports.get', id);
  return { canApprove: d.canApprove, canRequestChanges: d.canRequestChanges };
};

describe('지시가 끝났거나 취소된 보고서에는 수정 요청을 받지 않는다 (리드 결정 25)', () => {
  it('메인 에이전트가 지시를 취소한 뒤의 수정 요청은 conflict로 거부되고 아무것도 바뀌지 않는다 — 화면 판정(canRequestChanges)도 같다', async () => {
    const e = (env = await bootOrch());
    const { directiveId, report } = await reported(e);
    expect(await can(e, report.id)).toEqual({ canApprove: true, canRequestChanges: true });
    await e.main('cancel_directive', { directive_id: directiveId, reason: '프로듀서 계획을 다시 짜기로 함' });
    expect(e.ctx.store.directives.require(directiveId).state).toBe('cancelled');
    expect(await can(e, report.id)).toEqual({ canApprove: true, canRequestChanges: false });

    const res = await codeOf(e.invoke('reports.requestChanges', report.id, { overall: '표 형식으로 다시 정리해 줘', anchored: [] }));
    expect(res).toEqual({
      code: 'conflict',
      message: `지시 ${directiveId}이(가) 이미 취소돼 이 보고서에는 수정 요청을 할 수 없습니다. 바꿀 것이 있으면 명령창으로 메인 에이전트에게 말해 주세요`,
    });
    // 보고서·코멘트·대기열·기록 모두 그대로 — 대표가 '수정 요청됨'만 보고 메인은 모르는 일이 없다
    expect(e.ctx.store.reports.require(report.id).status).toBe('new');
    expect(e.ctx.store.reportComments.list({ ref1: report.id })).toEqual([]);
    expect(changeRequests(e, directiveId)).toEqual([]);
    expect(e.ctx.store.activity.search({ text: '수정 요청 → 메인 에이전트', limit: 10 })).toEqual([]);

    // canApprove는 reports.approve가 받는지와 같다: 취소된 지시의 새 보고서도 결과 승인은 받는다(지시는 취소 그대로)
    await e.invoke('reports.approve', report.id, '');
    expect(e.ctx.store.reports.require(report.id).status).toBe('approved');
    expect(e.ctx.store.directives.require(directiveId).state).toBe('cancelled');
    expect(await can(e, report.id)).toEqual({ canApprove: false, canRequestChanges: false });
  });

  it('수정 요청한 뒤 지시가 취소되면: 그대로 승인도(canApprove false·conflict), 다시 수정 요청도(canRequestChanges false, 아무 일 없음) 받지 않는다', async () => {
    const e = (env = await bootOrch());
    const { directiveId, report } = await reported(e);
    const key = mainKey(e.projectId);
    e.hold.add(key);
    await e.invoke('reports.requestChanges', report.id, { overall: '버튼 색을 바꿔 줘', anchored: [] });
    // 지시가 열려 있으면 수정 요청이 메인 에이전트 턴에 실린다 (리드 결정 19의 판정에 걸리지 않는다)
    e.tick();
    await waitFor(() => !!e.liveProc(key, MAIN_AGENT_ID), '수정 요청을 실은 메인 턴');
    const turn = e.liveProc(key, MAIN_AGENT_ID)!;
    expect(e.ctx.store.turns.get(turn.turnId)!.queueEntryIds.map((id) => e.ctx.store.queue.get(id)!.kind)).toContain('change_request');
    expect(await can(e, report.id)).toEqual({ canApprove: true, canRequestChanges: false });
    // 메인 에이전트가 회차를 열지 않고 지시를 취소했다
    await e.tool(turn.turnId, 'cancel_directive', { directive_id: directiveId, reason: '따로 새 지시로 처리' });
    turn.finishOk();
    e.hold.delete(key);
    await sleep(50);
    expect(await can(e, report.id)).toEqual({ canApprove: false, canRequestChanges: false });
    expect((await codeOf(e.invoke('reports.approve', report.id, ''))).code).toBe('conflict');
    const before = e.ctx.store.queue.list().length;
    expect(await codeOf(e.invoke('reports.requestChanges', report.id, { overall: '다시 요청', anchored: [] }))).toEqual({ code: 'ok', message: '' });
    expect(e.ctx.store.queue.list()).toHaveLength(before);
    expect(e.ctx.store.reports.require(report.id).status).toBe('changes_requested');
  });

  it('결과 승인으로 끝난 지시의 보고서도 canRequestChanges false, 수정 요청은 conflict', async () => {
    const e = (env = await bootOrch());
    const { directiveId, report } = await reported(e);
    await e.invoke('reports.approve', report.id, '좋아요');
    expect(e.ctx.store.directives.require(directiveId).state).toBe('closed');
    expect(await can(e, report.id)).toEqual({ canApprove: false, canRequestChanges: false });
    expect(await codeOf(e.invoke('reports.requestChanges', report.id, { overall: '하나 더', anchored: [] }))).toEqual({ code: 'conflict', message: '이미 결과 승인한 보고서입니다' });
  });
});
