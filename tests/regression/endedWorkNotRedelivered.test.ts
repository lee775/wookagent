/**
 * 대상이 끝난 업무는 턴이 끊겨도 다시 전달하지 않는다 (리드 결정 19, 10-29 — flows 재리뷰 medium, 프로브 zz-s1fxfg-approve-requeue):
 * - 리드 결정 10으로 수정 요청 업무(change_request)의 메인 턴이 돌고 있어도 대표가 보고서를 그대로 승인할 수 있다. 예전에는 그 턴이 비정상 종료·긴급 정지·
 *   재시작으로 끊기면 끊긴 턴의 업무를 다시 넣는 길(turns.requeue, recovery.settleCutTurnEntries)이 거둬들인 수정 요청을 '(다시 전달)'로 메인에게 다시
 *   주었다 — "revise_directive를 호출하세요 … 새 지시로 처리해도 됩니다"가 이미 끝난 지시에 대해. 스케줄러의 정리도 메인 세션은 보지 않았다
 * - 한 판정(turns.deadWorkReason)을 세 곳이 쓴다. 수정 요청은 그 보고서가 더는 수정 요청이 아니거나, 지시가 끝나거나 취소됐거나, 새 회차가 열리면 끝난 업무다.
 *   끝난 업무는 '취소'로 두고 까닭을 활동 기록에 남기며 다시 전달하지 않는다
 * - 같은 모양의 다른 업무도 본다: 검수자 없음(no_reviewer), 검수자 재배정(reviewer_assign), 멈춘 검수를 넘겨받은 메인 업무, 보고서 작성(main_report)
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID } from '@shared/domain';
import { directiveKey, enqueue, mainKey } from '../../src/main/orchestrator/records';
import { bootRestartable, type RestartableEnv } from '../acceptance/stops-helpers';
import type { OrchEnv } from './orchHarness';
import { bootOrch, seedDirective, seedInReviewTask, sleep, startReview, waitFor } from './orchHarness';

let env: OrchEnv | null = null;
let renv: RestartableEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
  await renv?.close();
  renv = null;
});

type AnyEnv = Pick<OrchEnv, 'ctx' | 'core' | 'projectId'>;

/** 보고 단계 지시에 메인 에이전트가 보고서를 냈다 — 지시는 확인 대기 */
async function reportAwaiting(e: AnyEnv) {
  const now = e.ctx.now();
  const d = {
    id: e.ctx.store.nextId('directive'),
    projectId: e.projectId,
    title: '로그인 화면',
    text: '로그인 화면',
    attachments: [],
    round: 1,
    state: 'reporting' as const,
    rounds: [{ round: 1, requestedAt: now, text: '로그인 화면', anchored: [], reportId: null }],
    finalResult: null,
    planApprovalRequired: false,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    cancelledAt: null,
  };
  e.ctx.store.directives.insert(d);
  const r = await e.core.reports.submit(
    { directiveId: d.id, title: '로그인 화면 보고', sections: { summary: '끝', results: '끝', changedFiles: [], howToVerify: '-', issues: '-', nextSteps: '-' } },
    MAIN_AGENT_ID,
    null,
  );
  return { d, r };
}

const WITHDRAWN = '버튼 색을 파랑으로';
/** 메인 턴 메시지에 수정 요청 업무가 실렸는지 — 그 업무 글만 revise_directive 호출 예(report_id="…")를 담는다. 수정 요청·승인의 기억 갱신 업무는 담지 않는다 */
const carriesRequest = (message: string) => message.includes('report_id="');
const changeRequests = (e: AnyEnv, state: ('queued' | 'running' | 'done' | 'cancelled')[]) => e.ctx.store.queue.list({ state }).filter((q) => q.kind === 'change_request');
const endedRows = (e: AnyEnv, text: string) => e.ctx.store.activity.search({ text: '끝난 일의', limit: 50 }).filter((a) => a.text.includes(text));

/** 수정 요청 업무의 메인 턴이 도는 중에 대표가 그대로 승인한다 — 그 턴의 가짜 프로세스를 돌려준다 */
async function approveDuringChangeRequestTurn(e: OrchEnv) {
  const { d, r } = await reportAwaiting(e);
  await e.drain(2);
  const key = mainKey(e.projectId);
  e.hold.add(key);
  await e.invoke('reports.requestChanges', r.id, { overall: `${WITHDRAWN} 바꿔 줘`, anchored: [] });
  expect(changeRequests(e, ['queued']).map((q) => q.reportId)).toEqual([r.id]);
  e.tick();
  await waitFor(() => !!e.liveProc(key, MAIN_AGENT_ID), '수정 요청 메인 턴');
  const proc = e.liveProc(key, MAIN_AGENT_ID)!;
  expect(e.launches.at(-1)!.message).toContain(WITHDRAWN);
  expect((await e.invoke('reports.get', r.id)).canApprove).toBe(true);
  await e.invoke('reports.approve', r.id, '그대로 좋습니다');
  expect(e.ctx.store.directives.require(d.id).state).toBe('closed');
  return { d, r, key, proc };
}

/** 메인 세션을 풀어 다음 메인 턴을 띄운다 — 그 턴들의 메시지 */
async function nextMainTurns(e: OrchEnv, key: string) {
  e.hold.delete(key);
  const before = e.launches.length;
  e.tick();
  await sleep(100);
  await e.idle();
  return e.launches.slice(before).filter((l) => l.workKey === key);
}

describe('거둬들인 수정 요청은 턴이 끊겨도 다시 전달하지 않는다 (리드 결정 19)', () => {
  for (const how of ['crash', 'emergency'] as const) {
    it(`수정 요청 턴이 도는 중 대표가 그대로 승인 → 그 턴이 ${how === 'crash' ? '비정상 종료' : '긴급 정지'}로 끝나도 수정 요청이 다시 대기열에 들어가지 않는다`, async () => {
      const e = (env = await bootOrch());
      const { r, key, proc } = await approveDuringChangeRequestTurn(e);
      if (how === 'crash') proc.exit(1);
      else {
        await e.invoke('stop.emergency');
        await e.invoke('stop.release');
      }
      await e.idle();
      expect(changeRequests(e, ['queued', 'running'])).toEqual([]);
      // 실린 항목은 '취소'로 남고 까닭이 활동 기록에 있다
      expect(changeRequests(e, ['cancelled']).map((q) => q.reportId)).toEqual([r.id]);
      expect(endedRows(e, `수정 요청 업무 정리 — 대표가 보고서 ${r.id}을(를) 그대로 결과 승인함 (${key}, 다시 전달하지 않음)`)).toHaveLength(1);
      // 다음 메인 턴은 승인 기억 업무만 받는다 — 거둬들인 수정 요청과 revise_directive 안내가 없다
      const next = await nextMainTurns(e, key);
      expect(next.length).toBeGreaterThan(0);
      expect(next.some((l) => carriesRequest(l.message))).toBe(false);
    });
  }

  it('재시작으로 끊긴 수정 요청 턴(대표가 그 사이 그대로 승인)도 재시작 복구가 되살리지 않는다', async () => {
    let e = (renv = await bootRestartable());
    const { d, r } = await reportAwaiting(e);
    await e.drain(2);
    const key = mainKey(e.projectId);
    e.hold.add(key);
    await e.invoke('reports.requestChanges', r.id, { overall: `${WITHDRAWN} 바꿔 줘`, anchored: [] });
    e.tick();
    await waitFor(() => !!e.liveProc(key, MAIN_AGENT_ID), '수정 요청 메인 턴');
    await e.invoke('reports.approve', r.id, '그대로 좋습니다');
    expect(e.ctx.store.directives.require(d.id).state).toBe('closed');
    expect(changeRequests(e, ['running']).map((q) => q.reportId)).toEqual([r.id]);
    // 전원이 꺼진 것처럼 끝내고 다시 띄운다 (첫 틱이 띄운 턴은 살려 둔다)
    e.crash();
    e = renv = await e.reboot({ holdAll: true });
    expect(changeRequests(e, ['queued', 'running'])).toEqual([]);
    expect(changeRequests(e, ['cancelled']).map((q) => q.reportId)).toEqual([r.id]);
    expect(endedRows(e, `수정 요청 업무 정리 — 재시작 복구: 대표가 보고서 ${r.id}을(를) 그대로 결과 승인함`)).toHaveLength(1);
    await sleep(50);
    expect(e.launchesOf(key).some((l) => carriesRequest(l.message))).toBe(false);
  });

  it('메인 에이전트가 그 턴에서 이미 다음 회차를 열었으면(revise_directive) 그 턴이 끊겨도 수정 요청을 다시 주지 않는다 — 새 회차가 열린 수정 요청은 끝난 업무', async () => {
    const e = (env = await bootOrch());
    const { d, r } = await reportAwaiting(e);
    await e.drain(2);
    const key = mainKey(e.projectId);
    e.hold.add(key);
    e.hold.add(directiveKey(d.id));
    await e.invoke('reports.requestChanges', r.id, { overall: `${WITHDRAWN} 바꿔 줘`, anchored: [] });
    e.tick();
    await waitFor(() => !!e.liveProc(key, MAIN_AGENT_ID), '수정 요청 메인 턴');
    const proc = e.liveProc(key, MAIN_AGENT_ID)!;
    const rev = await e.tool(proc.turnId, 'revise_directive', { directive_id: d.id, report_id: r.id, instructions: '버튼 색만 바꾸세요' });
    expect(rev.ok).toBe(true);
    expect(e.ctx.store.directives.require(d.id)).toMatchObject({ round: 2, state: 'planning' });
    proc.exit(1);
    await sleep(100);
    expect(changeRequests(e, ['queued', 'running'])).toEqual([]);
    expect(endedRows(e, `수정 요청 업무 정리 — 지시 ${d.id}의 2회차가 이미 열림`)).toHaveLength(1);
  });

  it('스케줄러도 메인 세션의 끝난 업무를 띄우지 않고 지운다 — 예전 기록(보고서 ID 칸 없음)의 거둬들인 수정 요청이 대기 중이어도', async () => {
    const e = (env = await bootOrch());
    const { r } = await reportAwaiting(e);
    await e.drain(2);
    await e.invoke('reports.requestChanges', r.id, { overall: `${WITHDRAWN} 바꿔 줘`, anchored: [] });
    const original = changeRequests(e, ['queued'])[0]!;
    await e.invoke('reports.approve', r.id, '그대로 좋습니다');
    // 고치기 전 코드가 다시 넣어 둔 항목 (보고서 ID 칸 없이 글만) — 업무 글의 보고서 ID로 판정한다
    enqueue(e.ctx, { kind: 'change_request', memberId: MAIN_AGENT_ID, sessionKey: original.sessionKey, projectId: original.projectId, directiveId: original.directiveId, priority: 'high', message: `이전 턴이 비정상 종료로 끝났습니다. 이어서 처리하세요.\n\n(다시 전달) ${original.message}` });
    expect(changeRequests(e, ['queued']).map((q) => q.reportId ?? null)).toEqual([null]);
    const next = await nextMainTurns(e, original.sessionKey);
    expect(changeRequests(e, ['queued', 'running'])).toEqual([]);
    expect(endedRows(e, `수정 요청 업무 정리 — 대표가 보고서 ${r.id}을(를) 그대로 결과 승인함`)).toHaveLength(1);
    expect(next.some((l) => carriesRequest(l.message))).toBe(false);
  });
});

describe('같은 모양의 다른 업무도 대상이 끝났으면 다시 전달하지 않는다 (리드 결정 19)', () => {
  it('검수자 재배정(reviewer_assign): 그 업무의 프로듀서 턴이 도는 중 작업이 취소되고 턴이 끊기면 다시 넣지 않는다', async () => {
    const e = (env = await bootOrch());
    const { task, proc: review } = await startReview(e, e.qaId);
    const dkey = directiveKey(task.directiveId);
    e.hold.add(dkey);
    for (let i = 0; i < 5; i++) review.emit({ kind: 'error', text: '같은 오류', data: {} });
    await waitFor(() => e.ctx.store.queue.list({ state: 'queued' }).some((q) => q.kind === 'reviewer_assign' && q.taskId === task.id), '재배정 업무');
    e.tick();
    await waitFor(() => !!e.liveProc(dkey, e.producerId), '재배정 업무의 프로듀서 턴');
    const producer = e.liveProc(dkey, e.producerId)!;
    await e.main('cancel_task', { task_id: task.id });
    expect(e.ctx.store.tasks.require(task.id).state).toBe('cancelled');
    producer.exit(1);
    await sleep(100);
    expect(e.ctx.store.queue.list({ state: ['queued', 'running'] }).filter((q) => q.kind === 'reviewer_assign')).toEqual([]);
    expect(endedRows(e, `검수자 배정 업무 정리 — ${task.id}이(가) 이미 취소됨 (${dkey}, 다시 전달하지 않음)`)).toHaveLength(1);
  });

  it('검수자 없음(no_reviewer): 그 업무의 메인 턴이 도는 중 작업이 취소되고 턴이 끊기면 다시 넣지 않는다', async () => {
    const e = (env = await bootOrch());
    await e.internal('members.remove', e.qaId);
    const t = seedInReviewTask(e, MAIN_AGENT_ID, { outputMode: 'repo' });
    // 메인 에이전트도 기여자 — 아무도 검수할 수 없어 보류하고 메인에게 '검수자 없음'
    e.ctx.store.tasks.patch(t.id, { assigneeId: e.producerId, contributors: [e.producerId, MAIN_AGENT_ID] });
    const key = mainKey(e.projectId);
    e.hold.add(key);
    e.core.tasks.dispatchReview(e.ctx.store.tasks.require(t.id));
    expect(e.ctx.store.queue.list({ state: 'queued' }).filter((q) => q.kind === 'no_reviewer').map((q) => q.taskId)).toEqual([t.id]);
    e.tick();
    await waitFor(() => !!e.liveProc(key, MAIN_AGENT_ID), '검수자 없음 메인 턴');
    const proc = e.liveProc(key, MAIN_AGENT_ID)!;
    await e.main('cancel_task', { task_id: t.id });
    proc.exit(1);
    await sleep(100);
    expect(e.ctx.store.queue.list({ state: ['queued', 'running'] }).filter((q) => q.kind === 'no_reviewer')).toEqual([]);
    expect(endedRows(e, `검수자 없음 업무 정리 — ${t.id}이(가) 이미 취소됨`)).toHaveLength(1);
  });

  it('멈춘 검수를 넘겨받은 메인 업무: 작업이 검수를 벗어나면(취소) 끊긴 턴에서 다시 넣지 않는다', async () => {
    const e = (env = await bootOrch());
    const d = seedDirective(e);
    const t = seedInReviewTask(e, e.qaId, { outputMode: 'repo', directiveId: d.id });
    const key = mainKey(e.projectId);
    e.hold.add(key);
    enqueue(e.ctx, { kind: 'message', memberId: MAIN_AGENT_ID, sessionKey: key, projectId: e.projectId, directiveId: d.id, taskId: t.id, priority: 'high', message: `${t.id} "${t.title}" 검수가 멈췄습니다`, dedupeKind: true });
    e.tick();
    await waitFor(() => !!e.liveProc(key, MAIN_AGENT_ID), '넘겨받은 업무의 메인 턴');
    const proc = e.liveProc(key, MAIN_AGENT_ID)!;
    await e.main('cancel_task', { task_id: t.id });
    proc.exit(1);
    await sleep(100);
    expect(e.ctx.store.queue.list({ ref2: key, state: ['queued', 'running'] }).filter((q) => q.taskId === t.id)).toEqual([]);
    expect(endedRows(e, `메시지 확인 업무 정리 — ${t.id}이(가) 이미 취소됨`)).toHaveLength(1);
  });

  it('보고서 작성(main_report): 그 턴에서 보고서를 낸 뒤 턴이 끊기면 보고 요청을 다시 주지 않는다', async () => {
    const e = (env = await bootOrch());
    const d = seedDirective(e);
    e.ctx.store.directives.patch(d.id, { state: 'reporting' });
    const key = mainKey(e.projectId);
    e.hold.add(key);
    enqueue(e.ctx, { kind: 'main_report', memberId: MAIN_AGENT_ID, sessionKey: key, projectId: e.projectId, directiveId: d.id, priority: 'high', message: `지시 ${d.id}의 결과를 submit_report(directive_id="${d.id}")로 보고하세요.` });
    e.tick();
    await waitFor(() => !!e.liveProc(key, MAIN_AGENT_ID), '보고서 작성 메인 턴');
    const proc = e.liveProc(key, MAIN_AGENT_ID)!;
    const sent = await e.tool(proc.turnId, 'submit_report', { directive_id: d.id, title: '보고', summary: '끝', results: '끝', how_to_verify: '-' });
    expect(sent.ok).toBe(true);
    expect(e.ctx.store.directives.require(d.id).state).toBe('awaiting_confirmation');
    proc.exit(1);
    await sleep(100);
    expect(e.ctx.store.queue.list({ state: ['queued', 'running'] }).filter((q) => q.kind === 'main_report')).toEqual([]);
    expect(endedRows(e, `보고서 작성 업무 정리 — 지시 ${d.id}이(가) 보고 단계가 아님 (확인 대기)`)).toHaveLength(1);
  });
});
