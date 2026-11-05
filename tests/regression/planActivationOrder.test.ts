/**
 * 계획 턴이 만든 작업의 시작 순서 (S7-B7, TSK-05, 5.7 '같은 분류에서는 작업 우선순위 → 대기 등록 시각 순', AC-38).
 * 예전에는 프로듀서의 계획 턴이 작업을 만드는 즉시 그 작업을 시작했다. 그래서 시작 순서가 도구 호출 사이의 시간에 따라 달라졌다 — 계획 중에 먼저 만든 작업의
 * 담당이 잠깐 멈춰 있으면(대표가 검수자를 정한 뒤 재개) 나중에 만든 작업이 먼저 시작했다. stage 6이 같은 저장소의 작업 폴더 만들기를 차례로 하게 한 뒤로는
 * (gitService inWorktreeQueue) 먼저 시작한 작업이 작업 폴더 하나 만드는 시간만큼 앞서 가 병합도 먼저 됐고, 늦은 작업은 기준 main이 바뀌어 다시 검수됐다
 * (AC-38 모의 흐름이 간헐적으로 실패). 같은 계획의 더 급한 작업도 먼저 만든 덜 급한 작업에 밀렸다.
 * 이제 그 지시의 계획 턴이 막 만든 작업은 마지막으로 만든 뒤 정착 시간(PLAN_SETTLE_MS, 1.5초) 동안 시작하지 않고, 그 시간이 지나거나 계획이 끝나면
 * 우선순위 → 대기 등록 순으로 한꺼번에 시작한다 (S8-B2 — 계획 턴 내내 묶어 두지 않는다: planSettleWindow.test.ts). 아래 경우는 모두 정착 시간 안에서 본다.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID } from '@shared/domain';
import { directiveKey, taskKey } from '../../src/main/orchestrator/records';
import { sleep, waitFor } from './orchHarness';
import { bootSessions, toolOk, type SessEnv } from '../acceptance/sessions-helpers';

let env: SessEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

/** 작업이 시작(대기 → 진행)된 전이 순번. 시작하지 않았으면 null */
const activatedSeq = (e: SessEnv, id: string): number | null => e.ctx.store.transitions.list(id).find((x) => x.event === 'activate')?.seq ?? null;

async function planTurn(e: SessEnv): Promise<{ did: string; turnId: string; finish: () => Promise<void> }> {
  const d = e.core.directives.register({ projectId: e.projectId, title: '결제 화면', text: '결제 화면을 만들어 줘' }, MAIN_AGENT_ID, null);
  const key = directiveKey(d.id);
  e.hold.add(key);
  e.tick();
  await waitFor(() => !!e.liveProc(key), '계획 턴');
  const p = e.liveProc(key)!;
  return {
    did: d.id,
    turnId: p.turnId,
    finish: async () => {
      p.finishOk('계획했습니다');
      await waitFor(() => !e.core.turns.hasLiveSession(key), '계획 턴 종료');
    },
  };
}

const create = (e: SessEnv, turnId: string, did: string, assignee: string, title: string, priority: 'normal' | 'high' = 'normal') =>
  toolOk(e, turnId, 'create_task', { directive_id: did, title, goal: title, type: 'development', assignee_id: assignee, priority, acceptance_criteria: ['동작'], output_mode: 'repo' }).then(
    (r) => String(r.taskId),
  );

describe('계획 턴이 만든 작업은 계획이 끝난 뒤 우선순위 → 대기 등록 순으로 시작한다 (TSK-05, S7-B7)', () => {
  it('먼저 만든 작업의 담당이 계획 중에 멈췄다가 재개돼도, 계획이 끝나면 먼저 만든 작업이 먼저 시작한다 (AC-38 모의 흐름의 순서)', async () => {
    const e = (env = await bootSessions({ developers: 2 }));
    const [dev1, dev2] = e.devs as [string, string];
    await e.main('pause_member', { member_id: dev1, mode: 'immediate' });
    const plan = await planTurn(e);
    const t1 = await create(e, plan.turnId, plan.did, dev1, '개발자 1 작업');
    const t2 = await create(e, plan.turnId, plan.did, dev2, '개발자 2 작업');
    e.tick();
    await sleep(150);
    // 계획 턴이 도는 동안에는 어느 것도 시작하지 않는다 (예전: 개발자 2 작업이 만들어지자마자 시작)
    expect({ t1: activatedSeq(e, t1), t2: activatedSeq(e, t2) }).toEqual({ t1: null, t2: null });
    expect(e.core.turns.hasLiveSession(taskKey(t2))).toBe(false);
    // 검수자를 정하고 메인 에이전트가 개발자 1을 재개한다 (계획 중)
    e.core.tasks.update(t1, { reviewerId: e.qaId }, e.producerId);
    await e.main('resume_member', { member_id: dev1 });
    e.tick();
    await sleep(100);
    expect(activatedSeq(e, t2)).toBeNull();
    await plan.finish();
    e.tick();
    await waitFor(() => activatedSeq(e, t1) !== null && activatedSeq(e, t2) !== null, '두 작업 시작');
    expect(activatedSeq(e, t1)!).toBeLessThan(activatedSeq(e, t2)!);
  });

  it('같은 계획에서 나중에 만든 더 급한 작업이 같은 담당의 덜 급한 작업보다 먼저 시작한다 — 계획 중에 먼저 만든 작업이 자리를 차지하지 않는다', async () => {
    const e = (env = await bootSessions());
    const plan = await planTurn(e);
    const low = await create(e, plan.turnId, plan.did, e.devId, '덜 급한 작업');
    e.tick();
    await sleep(150);
    const high = await create(e, plan.turnId, plan.did, e.devId, '급한 작업', 'high');
    expect(activatedSeq(e, low)).toBeNull();
    await plan.finish();
    e.tick();
    await waitFor(() => activatedSeq(e, high) !== null, '급한 작업 시작');
    // 팀원당 일반 작업은 하나씩 (5.7) — 덜 급한 작업은 기다린다
    expect(activatedSeq(e, low)).toBeNull();
    expect(e.ctx.store.tasks.require(low).state).toBe('waiting');
  });

  it('다른 지시(계획이 끝난 지시)의 대기 작업은 이 계획 턴과 상관없이 바로 시작한다', async () => {
    const e = (env = await bootSessions({ developers: 2 }));
    const [, dev2] = e.devs as [string, string];
    const plan = await planTurn(e);
    // 다른 지시(계획이 끝난 지시)의 대기 작업은 이 계획 턴과 상관없이 시작한다
    const other = e.core.directives.register({ projectId: e.projectId, title: '다른 지시', text: '다른 일' }, MAIN_AGENT_ID, null);
    e.ctx.store.queue.list({ ref2: directiveKey(other.id), state: 'queued' }).forEach((q) => e.ctx.store.queue.put({ ...q, state: 'done', doneAt: e.ctx.now() }));
    e.ctx.store.directives.put({ ...e.ctx.store.directives.require(other.id), state: 'in_progress' });
    const ot = e.core.tasks.create({ directiveId: other.id, title: '다른 지시 작업', goal: '다른 일', type: 'development', assigneeId: dev2, acceptanceCriteria: ['동작'], outputMode: 'repo' }, e.producerId);
    e.tick();
    await waitFor(() => activatedSeq(e, ot.id) !== null, '다른 지시 작업 시작');
    await plan.finish();
  });
});
