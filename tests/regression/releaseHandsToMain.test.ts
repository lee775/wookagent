/**
 * 긴급 정지 해제는 보류 목록을 메인 에이전트에게 넘긴다 (CTL-10 v0.6, SERVER_DESIGN 2.2·10.1 releaseHandsToMain):
 * - 대표가 해제하면 서버가 메인 대기열(main:general)에 '정지 해제' 업무(stop_released)를 넣고 보류된 작업 목록(프로젝트·담당·정지 전 상태·다른 보류)을 함께 준다
 * - 해제해도 작업은 재개되지 않는다 — 메인 에이전트가 resume_task로 재개한 것만 실행된다. 정지 중에는 메인의 재개도 거부된다
 * - 보류가 없으면 업무를 넣지 않고, 메인이 처리하기 전에 다시 정지·해제해도 업무는 하나로 묶인다
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID } from '@shared/domain';
import { mainKey, reviewKey, taskKey } from '../../src/main/orchestrator/records';
import type { OrchEnv } from './orchHarness';
import { bootOrch, seedDirective, seedInReviewTask, sleep, waitFor } from './orchHarness';

let env: OrchEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const released = (e: OrchEnv) => e.ctx.store.queue.list({ ref2: mainKey(null) }).filter((q) => q.kind === 'stop_released' && q.memberId === MAIN_AGENT_ID && q.state !== 'cancelled');
const workLaunches = (e: OrchEnv) => e.launches.filter((l) => l.workKey.startsWith('task:') || l.workKey.startsWith('review:'));
async function ticks(e: OrchEnv, n: number) {
  for (let i = 0; i < n; i++) {
    e.tick();
    await sleep(20);
  }
}

describe('긴급 정지 해제 → 메인 에이전트가 항목별 재개 (CTL-10 v0.6)', () => {
  it('해제하면 메인 대기열에 보류 목록이 업무로 들어가고 작업은 재개되지 않는다 — 메인이 resume_task로 재개한 작업만 실행된다', async () => {
    const e = (env = await bootOrch());
    const d = seedDirective(e, '정지 해제 지시');
    const tDev = e.core.tasks.create({ directiveId: d.id, title: '로그인 화면', goal: '화면', type: 'development', assigneeId: e.devId, acceptanceCriteria: ['동작'], outputMode: 'repo' }, e.producerId);
    const tQa = e.core.tasks.create({ directiveId: d.id, title: '결제 시험', goal: '시험', type: 'test', assigneeId: e.qaId, acceptanceCriteria: ['통과'], outputMode: 'artifact' }, e.producerId);
    // 검수 중인 프로듀서 직접 작업 — 적격 팀원이 바빠도 메인 에이전트가 검수자 (각 팀원의 일반 작업은 하나씩이라 담당을 프로듀서로)
    const tRev = seedInReviewTask(e, MAIN_AGENT_ID, { directiveId: d.id });
    e.ctx.store.tasks.patch(tRev.id, { assigneeId: e.producerId, contributors: [e.producerId] });
    for (const k of [taskKey(tDev.id), taskKey(tQa.id), reviewKey(tRev.id)]) e.hold.add(k);
    e.tick();
    await waitFor(() => !!e.liveProc(taskKey(tDev.id)) && !!e.liveProc(taskKey(tQa.id)), '작업 턴 둘');
    const ask = await e.tool(e.liveProc(taskKey(tQa.id))!.turnId, 'ask_producer', { question: '결제 모듈은 무엇인가요?' });
    expect(ask.ok).toBe(true);
    await e.invoke('stop.emergency');
    await e.idle();
    const items = [tDev, tQa, tRev];
    for (const t of items) expect(e.ctx.store.tasks.require(t.id).hold.reasons.map((r) => r.kind)).toContain('emergency_stop');
    // 정지 중에는 메인 에이전트의 재개도 거부된다
    await expect(e.main('resume_task', { task_id: tDev.id })).rejects.toMatchObject({ code: 'stopped' });
    expect(released(e)).toEqual([]);
    const launchedBefore = workLaunches(e).length;

    e.hold.add(mainKey(null));
    await e.invoke('stop.release');
    // 메인 대기열(main:general)에 보류 목록 — 작업마다 프로젝트·담당·정지 전 상태·다른 보류 사유
    const rel = released(e);
    expect(rel).toHaveLength(1);
    expect(rel[0]!.priority).toBe('high');
    for (const t of items) expect(rel[0]!.message).toContain(`${t.id} "${t.title}"`);
    expect(rel[0]!.message).toContain('보류된 작업 3건');
    expect(rel[0]!.message).toContain('resume_task');
    const qaLine = rel[0]!.message.split('\n').find((l) => l.includes(tQa.id))!;
    expect(qaLine).toContain('다른 보류: 답변 대기');
    expect(rel[0]!.message.split('\n').find((l) => l.includes(tRev.id))).toContain('정지 전 상태 검수');
    // 해제만으로는 보류된 작업이 실행되지 않는다 — 메인 에이전트의 정지 해제 턴은 돈다
    await ticks(e, 6);
    expect(workLaunches(e)).toHaveLength(launchedBefore);
    for (const t of items) expect(e.ctx.store.tasks.require(t.id).state).toBe('on_hold');
    await waitFor(() => !!e.liveProc(mainKey(null), MAIN_AGENT_ID), '메인 에이전트 정지 해제 턴');
    expect(e.launches.find((l) => l.workKey === mainKey(null))!.message).toMatch(/### 1\. 정지 해제\n> 대표가 긴급 정지를 해제했습니다/);

    // 메인이 재개한 것만 실행된다
    await e.main('resume_task', { task_id: tDev.id, reason: '대표 명령: 로그인 화면부터' });
    await ticks(e, 6);
    await waitFor(() => !!e.liveProc(taskKey(tDev.id)), '재개한 작업 턴');
    expect(workLaunches(e).slice(launchedBefore).map((l) => l.workKey)).toEqual([taskKey(tDev.id)]);
    expect(e.ctx.store.tasks.require(tQa.id).state).toBe('on_hold');
    expect(e.ctx.store.tasks.require(tRev.id).state).toBe('on_hold');
  });

  it('보류가 없으면 정지 해제 업무를 넣지 않고, 메인이 처리하기 전에 다시 정지·해제해도 업무는 하나다', async () => {
    const e = (env = await bootOrch());
    await e.invoke('stop.emergency');
    await e.invoke('stop.release');
    expect(released(e)).toEqual([]);
    const d = seedDirective(e);
    const t = e.core.tasks.create({ directiveId: d.id, title: '대기 작업', goal: '목표', type: 'development', assigneeId: e.devId, acceptanceCriteria: ['동작'], outputMode: 'repo' }, e.producerId);
    await e.invoke('stop.emergency');
    await e.invoke('stop.release');
    await e.invoke('stop.emergency');
    await e.invoke('stop.release');
    const rel = released(e).filter((q) => q.state === 'queued');
    expect(rel).toHaveLength(1);
    expect(rel[0]!.message).toContain(t.id);
    expect(e.ctx.store.tasks.require(t.id).hold.reasons.map((r) => r.kind)).toEqual(['emergency_stop']);
  });
});
