/**
 * 메인 에이전트가 지시를 취소하면 대기 중인 대표의 수정 요청은 이름이 남는 기록과 함께 지운다 (리드 결정 19·36·45, 10-30 — flows 5차 재리뷰 low,
 * 프로브 zz-s1fx5fg-cancel-drops-change-request):
 * - 대표가 확인 대기 중인 지시의 보고서에 수정을 요청했고, 그 요청은 다른 일로 도는 메인 턴 뒤에 대기 중이다. 그 턴에서 메인이 cancel_directive를 부르면
 *   directives.cancel이 그 수정 요청을 cancelQueued로 지웠다. cancelQueued는 메시지 기록이 없는 항목을 기록 없이 지우므로, 대표의 요청이 메인에게 닿지 못했다는
 *   활동 기록도 알림도 없었다. 보고서는 '수정 요청됨' 그대로 남았다
 * - 이제 지시 취소는 메인 에이전트에게 남은 그 지시의 수정 요청·보고서 작성 업무를 끝난 업무 정리(dropDeadWork)로 지운다 — 까닭을 적은 활동 기록이 남는다.
 *   수정 요청이면 그 기록이 보고서 ID를 적고, '지시 취소' 알림도 '대표의 보고서 R-… 수정 요청은 메인 에이전트에게 전하지 못했습니다'라고 적는다
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID } from '@shared/domain';
import { mainKey } from '../../src/main/orchestrator/records';
import { bootOrch, seedDirective, sleep, waitFor, type OrchEnv } from './orchHarness';

let env: OrchEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const SECTIONS = { summary: '로그인 화면을 만들었습니다', results: '로그인 화면', changedFiles: [], howToVerify: '-', issues: '-', nextSteps: '-' };

/** 다른 대표 명령으로 메인 프로젝트 세션의 턴이 도는 동안(띄운 채) */
async function mainTurnRunning(e: OrchEnv): Promise<void> {
  const key = mainKey(e.projectId);
  e.hold.add(key);
  await e.invoke('command.send', { target: e.projectId, text: '다른 일을 처리해 줘' });
  await waitFor(
    () => {
      e.tick();
      return e.procs.some((p) => p.workKey === key && !p.done);
    },
    '메인 턴',
    20_000,
  );
}

describe('지시 취소는 대기 중인 대표의 수정 요청을 이름이 남게 지운다 (리드 결정 45)', () => {
  it('메인이 도는 턴에서 지시를 취소하면 대기 중인 수정 요청은 취소되고, 활동 기록과 지시 취소 알림이 그 보고서를 적는다', async () => {
    const e = (env = await bootOrch());
    const d = seedDirective(e, '로그인 화면');
    e.ctx.store.directives.put({ ...d, state: 'reporting' });
    const report = await e.core.reports.submit({ directiveId: d.id, sections: SECTIONS }, MAIN_AGENT_ID, null);
    await e.drain(2);
    await mainTurnRunning(e);
    // 그 사이 대표가 수정을 요청한다 (받아들여짐 — 지시는 확인 대기)
    await e.invoke('reports.requestChanges', report.id, { overall: '표로 바꿔 주세요', anchored: [] });
    const cr = () => e.ctx.store.queue.list({ ref1: MAIN_AGENT_ID }).filter((q) => q.kind === 'change_request');
    expect(cr().map((q) => q.state)).toEqual(['queued']);
    // 도는 턴에서 메인이 지시를 취소한다
    await e.main('cancel_directive', { directive_id: d.id, reason: '새 지시로 다시 하기로 함' });
    await sleep(100);
    expect(cr().map((q) => q.state)).toEqual(['cancelled']);
    // 활동 기록이 그 보고서의 수정 요청을 적는다 (보고서 ID로 찾을 수 있다)
    expect(
      e.ctx.store.activity
        .search({ text: '끝난 일의 수정 요청 업무 정리', limit: 10 })
        .map((a) => [a.kind, a.directiveId, a.text]),
    ).toEqual([
      ['report', d.id, `끝난 일의 수정 요청 업무 정리 — 지시 ${d.id}이(가) 취소돼 대표의 보고서 ${report.id} 수정 요청을 메인 에이전트에게 전하지 못함 (${mainKey(e.projectId)}, 다시 전달하지 않음)`],
    ]);
    expect(e.ctx.store.activity.search({ text: report.id, limit: 50 }).some((a) => a.text.includes('수정 요청을 메인 에이전트에게 전하지 못함'))).toBe(true);
    // 지시 취소 알림도 그 요청을 적는다
    expect(e.ctx.store.notifications.list().filter((n) => n.title === '지시 취소').map((n) => n.body)).toEqual([
      `${d.id} ${d.title} — 완료된 결과와 main 반영은 유지됩니다. 대표의 보고서 ${report.id} 수정 요청은 메인 에이전트에게 전하지 못했습니다`,
    ]);
    // 메인 에이전트에게 다시 가지 않는다
    expect(e.ctx.store.queue.list({ ref1: MAIN_AGENT_ID, state: ['queued', 'running'] }).filter((q) => q.directiveId === d.id && q.kind !== 'main_command')).toEqual([]);
  });

  it('대기 중인 보고서 작성 업무도 끝난 업무 정리로 지운다 — 대표 요청이 아니라 알림에는 적지 않는다', async () => {
    const e = (env = await bootOrch());
    const d = seedDirective(e, '정산 화면');
    e.ctx.store.directives.put({ ...d, state: 'reporting', finalResult: { round: 1, summary: '요약', outputs: [], changedFiles: [], issues: [], nextSteps: [], submittedAt: e.ctx.now(), by: e.producerId } });
    await mainTurnRunning(e);
    e.core.directives.queueMainReport(e.ctx.store.directives.require(d.id));
    const reports = () => e.ctx.store.queue.list({ ref1: MAIN_AGENT_ID }).filter((q) => q.kind === 'main_report' && q.directiveId === d.id);
    expect(reports().map((q) => q.state)).toEqual(['queued']);
    await e.main('cancel_directive', { directive_id: d.id, reason: '필요 없어짐' });
    await sleep(100);
    expect(reports().map((q) => q.state)).toEqual(['cancelled']);
    expect(e.ctx.store.activity.search({ text: '끝난 일의 보고서 작성 업무 정리', limit: 10 }).map((a) => [a.kind, a.directiveId, a.text])).toEqual([
      ['report', d.id, `끝난 일의 보고서 작성 업무 정리 — 지시 ${d.id}이(가) 보고 단계가 아님 (취소) (${mainKey(e.projectId)}, 다시 전달하지 않음)`],
    ]);
    expect(e.ctx.store.notifications.list().filter((n) => n.title === '지시 취소').map((n) => n.body)).toEqual([`${d.id} ${d.title} — 완료된 결과와 main 반영은 유지됩니다`]);
  });
});
