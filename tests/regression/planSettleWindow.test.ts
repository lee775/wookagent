/**
 * 계획 중인 지시가 만든 작업의 기다림은 짧은 정착 시간뿐이다 (S8-B2 — TSK-05, TSK-07, 5.7).
 * stage 7(S7-B7)은 지시의 계획 턴이 도는 내내 그 지시의 대기 작업을 시작하지 않았다. 실제 CLI의 계획 턴은 몇 분(멈추면 응답 없음 10분·시간 상한 60분)
 * 걸리므로 그동안 모든 작업이 대기로 남았다 — 계획 동안 실행 보류는 TSK-07 '계획 승인 후 시작'(기본 꺼짐)을 켰을 때만이다. 게다가 팀원별 다음 작업을 고른
 * 뒤에 막아서, 계획 중인 지시가 같은 팀원에게 더 급한 작업을 만들면 그 팀원의 다른 지시 대기 작업까지 계획이 끝날 때까지 서 있었다(팀원은 쉬는데).
 * 이제 계획 턴이 마지막으로 작업을 만든 뒤 PLAN_SETTLE_MS(1.5초)만 기다리고, 그 기다림은 팀원별 다음 작업을 고르기 전에 뺀다. 같은 계획에서 곧이어
 * 만든 작업은 여전히 같은 차례에 우선순위 → 대기 등록 순으로 시작한다 (planActivationOrder.test.ts, AC-38).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID } from '@shared/domain';
import type { StartCandidate } from '@core/scheduling';
import { directiveKey } from '../../src/main/orchestrator/records';
import { PLAN_SETTLE_MS } from '../../src/main/orchestrator/turns';
import { sleep, waitFor } from './orchHarness';
import { bootSessions, toolOk, type SessEnv } from '../acceptance/sessions-helpers';

let env: SessEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const activatedSeq = (e: SessEnv, id: string): number | null => e.ctx.store.transitions.list(id).find((x) => x.event === 'activate')?.seq ?? null;

async function planTurn(e: SessEnv) {
  const d = e.core.directives.register({ projectId: e.projectId, title: '결제 화면', text: '결제 화면을 만들어 줘' }, MAIN_AGENT_ID, null);
  const key = directiveKey(d.id);
  e.hold.add(key);
  e.tick();
  await waitFor(() => !!e.liveProc(key), '계획 턴');
  return { did: d.id, key, proc: e.liveProc(key)! };
}

const create = (e: SessEnv, turnId: string, did: string, assignee: string, title: string, priority: 'normal' | 'high' = 'normal') =>
  toolOk(e, turnId, 'create_task', { directive_id: did, title, goal: title, type: 'development', assignee_id: assignee, priority, acceptance_criteria: ['동작'], output_mode: 'repo' }).then(
    (r) => String(r.taskId),
  );

/**
 * 작업 세션 턴을 띄운 때(스케줄러가 고른 순간 — 자리 예약은 동기). 활성화(작업 폴더 만들기·git)는 그 뒤라 부하에서 수백 ms 늦어질 수 있어 시각을 재지 않는다
 * (S9-B4)
 */
function recordTaskLaunches(e: SessEnv): Map<string, number> {
  const at = new Map<string, number>();
  const turns = e.core.turns as unknown as { launch: (c: StartCandidate, ids: string[]) => void };
  const original = turns.launch;
  turns.launch = (c, ids) => {
    if (c.sessionKey.startsWith('task:') && !at.has(c.sessionKey)) at.set(c.sessionKey, Date.now());
    original.call(e.core.turns, c, ids);
  };
  return at;
}

/** 계획이 끝난 다른 지시 */
function plannedDirective(e: SessEnv) {
  const other = e.core.directives.register({ projectId: e.projectId, title: '다른 지시', text: '다른 일' }, MAIN_AGENT_ID, null);
  e.ctx.store.queue.list({ ref2: directiveKey(other.id), state: 'queued' }).forEach((q) => e.ctx.store.queue.put({ ...q, state: 'done', doneAt: e.ctx.now() }));
  e.ctx.store.directives.put({ ...e.ctx.store.directives.require(other.id), state: 'in_progress' });
  return other;
}

describe('계획 중인 지시가 만든 작업은 정착 시간만 기다린다 (S8-B2, TSK-05, TSK-07)', () => {
  it('계획 중인 지시가 같은 팀원에게 더 급한 작업을 만들어도 그 팀원의 다른 지시 대기 작업은 기다리지 않고 시작한다 — 팀원이 대기 작업을 두고 쉬지 않는다', async () => {
    const e = (env = await bootSessions());
    const other = plannedDirective(e);
    const plan = await planTurn(e);
    const high = await create(e, plan.proc.turnId, plan.did, e.devId, '급한 작업', 'high');
    const ot = e.core.tasks.create({ directiveId: other.id, title: '다른 지시 작업', goal: '다른 일', type: 'development', assigneeId: e.devId, acceptanceCriteria: ['동작'], outputMode: 'repo' }, e.producerId);
    e.tick();
    // 그 tick의 결정을 본다 — 고른 턴은 그 자리에서 띄워진다. 작업 폴더 만들기(git)를 기다리는 고정 대기는 부하에서 짧았다 (S9-B4)
    const live = (id: string) => e.core.turns.hasLiveSession(`task:${id}`);
    expect({ other: live(ot.id), high: live(high), planLive: e.core.turns.hasLiveSession(plan.key) }).toEqual({ other: true, high: false, planLive: true });
    await waitFor(() => activatedSeq(e, ot.id) !== null, '다른 지시 작업 시작', 15_000);
    // 팀원당 하나 — 급한 작업은 그 뒤에도 시작하지 않는다
    e.tick();
    expect({ high: live(high) || activatedSeq(e, high) !== null, planLive: e.core.turns.hasLiveSession(plan.key) }).toEqual({ high: false, planLive: true });
    plan.proc.finishOk('계획했습니다');
    await waitFor(() => !e.core.turns.hasLiveSession(plan.key), '계획 턴 종료');
  }, 60_000);

  it('계획 턴이 끝나지 않아도 마지막으로 작업을 만든 뒤 정착 시간이 지나면 시작한다 — 계획 턴 내내 묶어 두지 않는다', async () => {
    const e = (env = await bootSessions({ developers: 2 }));
    const [dev1, dev2] = e.devs as [string, string];
    const plan = await planTurn(e);
    const t1 = await create(e, plan.proc.turnId, plan.did, dev1, '개발자 1 작업');
    e.tick();
    await sleep(Math.min(400, PLAN_SETTLE_MS / 3));
    // 곧이어 하나 더 만든다 — 기다림은 마지막으로 만든 때부터
    const t2 = await create(e, plan.proc.turnId, plan.did, dev2, '개발자 2 작업');
    const madeAt = Date.now();
    e.tick();
    await sleep(Math.min(400, PLAN_SETTLE_MS / 3));
    expect({ t1: activatedSeq(e, t1), t2: activatedSeq(e, t2) }).toEqual({ t1: null, t2: null });
    await sleep(Math.max(0, PLAN_SETTLE_MS - (Date.now() - madeAt)) + 100);
    e.tick();
    await waitFor(() => activatedSeq(e, t1) !== null && activatedSeq(e, t2) !== null, '정착 시간 뒤 두 작업 시작');
    expect(e.core.turns.hasLiveSession(plan.key)).toBe(true);
    // 같은 차례에 대기 등록 순으로 시작했다
    expect(activatedSeq(e, t1)!).toBeLessThan(activatedSeq(e, t2)!);
    plan.proc.finishOk('계획했습니다');
    await waitFor(() => !e.core.turns.hasLiveSession(plan.key), '계획 턴 종료');
  }, 60_000);

  it('자동 실행 중이면 정착 시간이 끝날 때 바로 다시 보고 시작한다 (2초 주기를 기다리지 않음)', async () => {
    const e = (env = await bootSessions({ autoSchedule: true }));
    // 2초 주기를 끈다 (tick 신호는 그대로) — 그래도 시작하면 정착 시간이 끝나는 때 스스로 다시 본 것이다. 시각 상한(작업 폴더 만들기 포함)은 부하에서
    // 넘었다 — 결정만 본다 (S9-B4)
    const scheduler = e.core.scheduler as unknown as { timer: NodeJS.Timeout | null };
    clearInterval(scheduler.timer!);
    scheduler.timer = setInterval(() => undefined, 3_600_000);
    scheduler.timer.unref();
    const launched = recordTaskLaunches(e);
    const plan = await planTurn(e);
    const t = await create(e, plan.proc.turnId, plan.did, e.devId, '개발자 작업');
    const madeAt = Date.parse(e.ctx.store.tasks.require(t).createdAt);
    expect(launched.has(`task:${t}`)).toBe(false);
    await waitFor(() => launched.has(`task:${t}`), '정착 시간 뒤 시작 (주기 tick 없이)', 10_000);
    expect(launched.get(`task:${t}`)! - madeAt).toBeGreaterThanOrEqual(PLAN_SETTLE_MS - 50);
    await waitFor(() => activatedSeq(e, t) !== null, '그 작업 활성화', 15_000);
    plan.proc.finishOk('계획했습니다');
    await waitFor(() => !e.core.turns.hasLiveSession(plan.key), '계획 턴 종료');
  }, 60_000);
});
