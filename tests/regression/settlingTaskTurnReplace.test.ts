/**
 * settlingTaskTurnReplace (리드 결정 S7-17 F1·S7-19 R1): 거부된 프로듀서 교체는 정지가 오기 전에 실행을 마친(마무리 중이던) 그 프로듀서의 작업 턴을 멈춘 턴으로 다루지
 * 않는다.
 * - 교체가 그 프로듀서의 턴을 멈출 때 CLI가 이미 결과를 내고 끝나 마무리 중인 작업 턴은 '이미 마친 턴'(멈추지 않음)이다 — 그 턴은 completed로 끝나고, 그 판정이
 *   다음 일(여기서는 남은 제출의 처리)을 정한다
 * - 교체가 거부되어도(부른 메인 턴이 끝남) 그 작업을 '그 정지로 멈춘 작업'으로 다시 맡기거나 그 제출 처리를 한 번 더 부르지 않고, 그렇게 적지도 않는다
 *   (예전: resumeStopped가 '이미 마친 턴'도 멈춘 턴으로 보아 판정이 이미 부른 제출 처리를 다시 부르고 '그 정지로 멈춘 작업의 제출 처리를 프로그램이 이어 감'을 적었다)
 * 가짜 CLI(orchHarness)만 쓴다. 프로그램 단계(제출 처리)는 부른 것만 본다 — 실제 git 단계는 그 시험들이 본다 (seatStaleAwait와 같은 방식)
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAIN_AGENT_ID } from '@shared/domain';
import { enqueue, mainKey, taskKey } from '../../src/main/orchestrator/records';
import type { StopResult } from '../../src/main/orchestrator/turns';
import type { FakeProc, OrchEnv } from './orchHarness';
import { bootOrch, seedDirective, sleep, waitFor } from './orchHarness';

let env: OrchEnv | null = null;
/** 시험이 붙잡은 문 — 단언이 먼저 실패해도 정리 전에 모두 연다 */
const gates: (() => void)[] = [];
afterEach(async () => {
  for (const open of gates.splice(0)) open();
  vi.restoreAllMocks();
  env?.hold.clear();
  await env?.close();
  env = null;
});

/** 프로듀서가 스스로 맡은 작업의 작업 턴 하나를 띄워 붙잡는다 (작은 프로젝트에서 프로듀서가 계획 작업을 직접 맡는 경우) */
async function producerTaskTurnUp(e: OrchEnv): Promise<{ taskId: string; key: string; proc: FakeProc }> {
  const d = seedDirective(e);
  const t = e.core.tasks.create(
    { directiveId: d.id, title: '계획 문서 (프로듀서가 맡음)', goal: '계획을 정리한다', type: 'plan', assigneeId: e.producerId, acceptanceCriteria: ['문서가 있다'], outputMode: 'repo' },
    e.producerId,
  );
  const key = taskKey(t.id);
  e.hold.add(key);
  await waitFor(() => {
    if (!e.liveProc(key, e.producerId)) e.tick();
    return !!e.liveProc(key, e.producerId);
  }, '프로듀서의 작업 턴');
  return { taskId: t.id, key, proc: e.liveProc(key, e.producerId)! };
}

/** 대표 명령을 실은 메인 턴(main:general) 하나를 띄워 붙잡는다 */
async function mainTurnUp(e: OrchEnv): Promise<FakeProc> {
  const key = mainKey(null);
  e.hold.add(key);
  enqueue(e.ctx, { kind: 'main_command', memberId: MAIN_AGENT_ID, sessionKey: key, projectId: null, priority: 'high', message: '대표 명령 (시험):\n프로듀서를 바꿔 줘' });
  await waitFor(
    () => {
      if (!e.liveProc(key, MAIN_AGENT_ID)) e.tick();
      return !!e.liveProc(key, MAIN_AGENT_ID);
    },
    '메인 턴',
    30_000,
  );
  return e.liveProc(key, MAIN_AGENT_ID)!;
}

describe('거부된 프로듀서 교체는 마무리 중이던(이미 마친) 작업 턴을 멈춘 턴으로 다루지 않는다 (리드 결정 S7-19 R1)', () => {
  it("제출하고 끝나 마무리 중인 작업 턴: 교체의 정지는 '이미 마친 턴', 턴은 completed — 거부된 교체는 그 제출 처리를 다시 부르지 않고 '그 정지로 멈춘' 일로 적지 않는다", async () => {
    const e = (env = await bootOrch());
    const old = e.producerId;
    const { taskId, key, proc } = await producerTaskTurnUp(e);
    // 그 턴은 submit_for_review를 부르고 끝난다 — 남은 제출을 처리하는 것이 그 판정의 다음 일이다
    e.ctx.store.tasks.patch(taskId, { pendingSubmit: { requestedAt: e.ctx.now(), note: '제출 (시험)' } } as never);
    const submitted = vi.spyOn(e.core.tasks, 'processSubmission').mockResolvedValue(undefined);
    // 그 턴의 마무리(정리·판정)를 문으로 붙잡는다
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    gates.push(() => open());
    let held = 0;
    const settle = e.core.hostExec.settleTurn.bind(e.core.hostExec);
    vi.spyOn(e.core.hostExec, 'settleTurn').mockImplementation(async (turnId, why) => {
      if (turnId === proc.turnId) {
        held += 1;
        await gate;
      }
      return settle(turnId, why);
    });
    // 교체가 그 프로듀서의 턴을 멈춘 결과
    const stops: StopResult[] = [];
    const stopMember = e.core.turns.stopMember.bind(e.core.turns);
    vi.spyOn(e.core.turns, 'stopMember').mockImplementation(async (memberId, reason, user) => {
      const r = await stopMember(memberId, reason, user);
      stops.push(...r);
      return r;
    });
    const mp = await mainTurnUp(e);

    // CLI가 결과를 내고 끝난다 — 마무리가 붙잡혀 그 턴은 아직 실행 중 목록에 있다
    proc.finishOk('계획을 정리해 제출했습니다');
    await waitFor(() => held > 0, '그 작업 턴의 마무리가 붙잡힘');
    expect(e.core.turns.hasLiveSession(key)).toBe(true);
    submitted.mockClear();

    const call = e.tool(mp.turnId, 'replace_producer', { project_id: e.projectId, reason: '프로듀서가 멈춤 (시험)' });
    await waitFor(() => stops.some((s) => s.turnId === proc.turnId), '교체가 그 프로듀서의 턴을 멈춤');
    expect(stops.filter((s) => s.turnId === proc.turnId)).toEqual([expect.objectContaining({ ok: true, detail: '이미 마친 턴', alreadyEnded: true })]);
    // 부른 메인 턴이 끝나 교체는 거부된다 (다시 보기 — stopped)
    mp.exit(1);
    await waitFor(() => !!e.ctx.store.turns.require(mp.turnId).endedAt, '부른 메인 턴이 끝남');
    open();
    const r = await call;
    expect(!r.ok && r.code).toBe('stopped');
    expect(e.ctx.store.projects.require(e.projectId).producerId).toBe(old);
    // 마무리와 그 뒤의 일이 모두 끝날 때까지
    await waitFor(() => !e.core.turns.hasLiveSession(key) && !!e.ctx.store.turns.require(proc.turnId).endedAt, '그 작업 턴의 마무리가 끝남');
    await e.core.turns.turnFlow(proc.turnId);
    await sleep(200);

    // 그 턴은 멈추지 않았다 — 실행이 낸 끝 까닭 그대로
    const t = e.ctx.store.turns.require(proc.turnId);
    expect([t.endReason, t.process.stopRequestedAt]).toEqual(['completed', null]);
    // 남은 제출의 처리는 그 판정이 한 번 불렀다 — 거부된 교체가 다시 부르지 않았고, '그 정지로 멈춘' 일로 적지 않았다
    expect(submitted.mock.calls.map((c) => c[0])).toEqual([taskId]);
    expect(e.ctx.store.activity.search({ text: '프로듀서 교체를 하지 않아', limit: 20 }).map((a) => a.text)).toEqual([]);
    expect(e.ctx.store.queue.list({ ref2: key, state: ['queued', 'running'] }).filter((q) => q.kind !== 'message' && q.message.includes('프로그램이 이 작업 턴을 멈췄다가'))).toEqual([]);
  }, 60_000);
});
