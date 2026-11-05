/**
 * 정지 해제 업무(stop_released)의 보류 목록이 resume_task의 실제 동작과 같다 (리드 결정 12, 10-29 — flows M2, 프로브 zz-s1fg-released-list; CTL-10 v0.6).
 * 메인은 이 목록을 보고 항목별로 재개할지 정한다. resume_task는 긴급 정지와 함께 대표 재개로 풀리는 보류(isOwnerResumable — 중단·오류·병합 보류·작업
 * 일시정지)를 한 번에 푼다. 예전 목록은 다른 보류를 모두 '(재개해도 그 사유가 풀릴 때까지 실행되지 않음)'이라고 적어, 메인이 긴급 정지 몫만 풀려고
 * 재개한 중단 작업이 그대로 실행됐다. 이제 '재개하면 함께 풀림'과 '다른 보류(…실행되지 않음)'로 나눠 적는다
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID } from '@shared/domain';
import { mainKey, taskKey } from '../../src/main/orchestrator/records';
import type { OrchEnv } from './orchHarness';
import { bootOrch, seedDirective, seedInReviewTask, waitFor } from './orchHarness';

let env: OrchEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const SAY_STAYS = '(재개해도 그 사유가 풀릴 때까지 실행되지 않음)';
function releasedLine(e: OrchEnv, taskId: string): string {
  const rel = e.ctx.store.queue.list({ ref1: MAIN_AGENT_ID, state: 'queued' }).filter((q) => q.kind === 'stop_released' && q.sessionKey === mainKey(null));
  expect(rel).toHaveLength(1);
  return rel[0]!.message.split('\n').find((l) => l.includes(taskId))!;
}
const holdKinds = (e: OrchEnv, taskId: string) => {
  const t = e.ctx.store.tasks.require(taskId);
  return [t.state, t.hold.reasons.map((r) => r.kind)];
};

describe('정지 해제 보류 목록 = resume_task 동작 (리드 결정 12)', () => {
  it('메인이 중단해 둔 작업: 목록은 "재개하면 함께 풀림: 중단"이라 적고, 재개하면 실제로 검수로 돌아간다', async () => {
    const e = (env = await bootOrch());
    const d = seedDirective(e);
    const t = seedInReviewTask(e, e.qaId, { outputMode: 'repo', directiveId: d.id });
    await e.main('interrupt_task', { task_id: t.id, then: 'hold', reason: '대표가 잠깐 세워 두라고 함' });
    expect(holdKinds(e, t.id)).toEqual(['on_hold', ['interrupted']]);
    await e.invoke('stop.emergency');
    await e.invoke('stop.release');
    const line = releasedLine(e, t.id);
    expect(line).toContain('재개하면 함께 풀림: 중단');
    expect(line).not.toContain(SAY_STAYS);
    expect(line).not.toContain('다른 보류');
    await e.main('resume_task', { task_id: t.id, reason: '목록대로 재개' });
    expect(holdKinds(e, t.id)).toEqual(['in_review', []]);
  });

  it('답변 대기처럼 resume_task가 풀지 않는 보류만 "다른 보류 … (재개해도 … 실행되지 않음)"이고, 재개해도 그 보류가 남는다 — 섞이면 둘로 나눠 적는다', async () => {
    const e = (env = await bootOrch());
    const d = seedDirective(e);
    const asked = e.core.tasks.create({ directiveId: d.id, title: '질문한 작업', goal: '목표', type: 'test', assigneeId: e.qaId, acceptanceCriteria: ['동작'], outputMode: 'repo' }, e.producerId);
    const mixed = seedInReviewTask(e, e.qaId, { outputMode: 'repo', directiveId: d.id });
    e.hold.add(taskKey(asked.id));
    e.tick();
    await waitFor(() => !!e.liveProc(taskKey(asked.id)), '작업 턴');
    expect((await e.tool(e.liveProc(taskKey(asked.id))!.turnId, 'ask_producer', { question: '어느 API를 쓰나요?' })).ok).toBe(true);
    // 섞인 작업: 메인이 중단(재개로 풀림) + 프로젝트 일시정지(재개로 안 풀림)
    await e.main('interrupt_task', { task_id: mixed.id, then: 'hold', reason: '세워 둠' });
    await e.main('pause_project', { project_id: e.projectId, mode: 'immediate' });
    await e.invoke('stop.emergency');
    await e.idle();
    await e.invoke('stop.release');

    const askedLine = releasedLine(e, asked.id);
    expect(askedLine).toContain(`다른 보류: 답변 대기·일시정지 ${SAY_STAYS}`);
    expect(askedLine).not.toContain('재개하면 함께 풀림');
    const mixedLine = releasedLine(e, mixed.id);
    expect(mixedLine).toContain('재개하면 함께 풀림: 중단');
    expect(mixedLine).toContain(`다른 보류: 일시정지 ${SAY_STAYS}`);

    // 목록대로: 재개하면 '함께 풀림'만 풀리고 '다른 보류'는 남는다
    await e.main('resume_task', { task_id: mixed.id });
    expect(holdKinds(e, mixed.id)).toEqual(['on_hold', ['paused']]);
    await expect(e.main('resume_task', { task_id: asked.id })).resolves.toBeTruthy();
    expect(holdKinds(e, asked.id)).toEqual(['on_hold', ['answer_wait', 'paused']]);
  });
});
