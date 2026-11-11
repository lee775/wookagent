/**
 * finishedTurnStop (리드 결정 S7-17 F1 — CLI 쪽, 보유자와 무관한 규칙): 정지가 오기 전에 실행이 끝난 턴은 멈추지 않는다.
 * - CLI 프로세스가 결과를 내고 끝난 메인 턴의 마무리(화면 도우미 RELEASE — 가짜 도우미가 답하지 않는다, 3초 상한) 중에 긴급 정지가 오면: 끝 까닭은 completed,
 *   답은 대화에 한 번, 다시 넣지 않음, 요약의 멈춘 턴에 들지 않는다. 정지 자체(화면 도우미 STOP, 요약)는 그대로다
 * - 프로세스가 아직 살아 있는 턴은 지금처럼 멈춘다: user_stop '긴급 정지', 한 번 다시 넣음, 요약의 멈춘 턴
 * - 그 끝이 남긴 후손을 러너가 확인하지 못했으면(남은 수 −1) 정지의 답은 확인 실패다 (리드 결정 S7-22 S1): 긴급 정지 요약은 그 실패 줄로 완료가 아니고(멈춘 턴으로는
 *   세지 않는다), 작업 취소는 마무리 중인 그 턴의 작업 폴더를 지우지 않는다. 턴은 그 실행의 끝 까닭(completed)과 kill_failed로 끝난다
 * - 단계 마치고 정지(graceful)도 마무리 중인 턴에 정지를 걸지 않는다 (리드 결정 S7-22 S2) — 즉시 정지와 같다
 * 가짜 CLI(orchHarness)와 가짜 화면 도우미만 쓴다 — 실제 CLI·실제 화면 도우미는 띄우지 않는다 (guiRig가 확인한다, 리드 결정 S6-19)
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAIN_AGENT_ID, OWNER, type StopMode } from '@shared/domain';
import { taskKey } from '../../src/main/orchestrator/records';
import { killFakePids } from '../fixtures/desktop/fakeDesktop';
import { bootGui, capture, input, liveMain, MAIN_KEY, type GuiEnv } from './guiRig';
import { bootOrch, seedDirective, waitFor, type FakeProc, type OrchEnv } from './orchHarness';

const open: GuiEnv[] = [];
let env: OrchEnv | null = null;
/** 붙잡아 둔 마무리를 놓는 함수 — 실패한 시험도 정리에서 놓는다 */
const gates: (() => void)[] = [];
afterEach(async () => {
  for (const release of gates.splice(0)) release();
  vi.restoreAllMocks();
  env?.hold.clear();
  await env?.close();
  env = null;
  for (const g of open.splice(0)) {
    const pids = g.fake.pids();
    await g.close();
    killFakePids(pids);
  }
});

const releases = (g: GuiEnv) => g.fake.received().filter((l) => /^\d+ RELEASE$/.test(l)).length;
const stopLines = (g: GuiEnv) => g.fake.received().filter((l) => l === 'STOP').length;
const actsSeen = (g: GuiEnv) => g.fake.log().filter((e) => e.dir === 'note' && e.line === 'act set').length;
const replies = (g: GuiEnv, text: string) => g.e.ctx.store.conversation.list({ ref1: 'main' }).filter((m) => m.role === 'main_agent' && m.text === text).length;
const mainQueued = (g: GuiEnv) => g.e.ctx.store.queue.list({ ref1: MAIN_AGENT_ID, state: 'queued' });

/** 화면을 쓴(도우미 무장) 메인 턴 — 그 뒤 도우미는 마무리의 RELEASE에 답하지 않는다 */
async function armedMain(g: GuiEnv, text: string): Promise<string> {
  const turnId = await liveMain(g.e, text);
  const c = await capture(g.e, turnId);
  expect((await input(g.e, turnId, { action: 'move', capture_id: c.data.capture_id, x: 5, y: 5 })).ok).toBe(true);
  const seen = actsSeen(g);
  g.fake.act({ do: 'set', value: { noAck: ['RELEASE'] } });
  await waitFor(() => actsSeen(g) > seen, '도우미가 RELEASE에 답하지 않게 함');
  return turnId;
}

describe('finishedTurnStop — 정지가 오기 전에 끝난 CLI 턴은 그 끝 까닭을 지킨다 (리드 결정 S7-17 F1)', () => {
  it('결과를 내고 끝난 CLI 메인 턴의 마무리 중에 긴급 정지: completed, 답 한 번, 다시 넣지 않음, 요약의 멈춘 턴에 없음 — STOP은 보낸다', async () => {
    const g = await bootGui({}, { helper: { timeouts: { READY: 5000, RELEASE: 3000 } } });
    open.push(g);
    const answer = '화면을 보고 답했습니다';
    const turnId = await armedMain(g, '화면을 보고 답해 줘');
    const r0 = releases(g);
    g.e.liveProc(MAIN_KEY, MAIN_AGENT_ID)!.finishOk(answer);
    // 마무리가 RELEASE에서 기다린다 — 턴은 아직 실행 중 목록에 있고 기록은 끝나지 않았다
    await waitFor(() => releases(g) > r0, '마무리의 RELEASE');
    expect(g.e.core.turns.liveTurnIds()).toContain(turnId);
    expect(g.e.ctx.store.turns.get(turnId)!.endedAt).toBeNull();

    const s0 = stopLines(g);
    const summary = await g.e.core.stops.emergency(OWNER);
    await g.e.idle('마무리 끝');

    const t = g.e.ctx.store.turns.get(turnId)!;
    expect([t.endReason, t.endDetail, t.process.stopRequestedAt, t.process.state]).toEqual(['completed', '', null, 'exited']);
    expect(replies(g, answer)).toBe(1);
    expect(mainQueued(g)).toEqual([]);
    expect(summary.stoppedTurns).toEqual([]);
    expect(g.e.ctx.store.activity.search({ kinds: ['stop'], limit: 5 }).some((a) => a.text.includes('턴 0개 종료'))).toBe(true);
    // 정지 자체: 화면 도우미에 STOP, 끝남 확인 — 요약은 완료
    expect(stopLines(g)).toBeGreaterThan(s0);
    expect([summary.completed, summary.failures]).toEqual([true, []]);
  }, 60_000);

  it('프로세스가 아직 살아 있는 CLI 메인 턴은 지금처럼 멈춘다 — user_stop, 한 번 다시 넣음, 요약의 멈춘 턴', async () => {
    const g = await bootGui();
    open.push(g);
    const text = '오래 걸리는 일을 해 줘';
    const turnId = await liveMain(g.e, text);
    const summary = await g.e.core.stops.emergency(OWNER);
    await g.e.idle('정지한 턴 정리');

    const t = g.e.ctx.store.turns.get(turnId)!;
    expect([t.endReason, t.endDetail]).toEqual(['user_stop', '긴급 정지']);
    expect(summary.stoppedTurns).toEqual([expect.objectContaining({ turnId, ok: true })]);
    const again = mainQueued(g).filter((q) => q.message.includes(text));
    expect(again.map((q) => q.kind)).toEqual(['main_command']);
    expect(again[0]!.message).toContain('정지로 중단된 업무입니다');
  }, 60_000);
});

/** 러너가 끝난 프로세스에게 물었을 때의 답 — 남은 후손을 확인하지 못한 끝 (processRunner alreadyExited, remaining −1) */
const ALREADY_EXITED_UNCONFIRMED = { ok: false as const, remaining: -1, detail: '이미 종료됐지만 남은 후손 프로세스는 확인하지 못했습니다', durationMs: 0 };

/**
 * 프로듀서가 맡은 작업 턴 — 결과를 내고 끝났고(끝 코드 0), 그 마무리를 서버 명령 정리(hostExec.settleTurn)에서 붙잡아 둔다. unconfirmed면 러너가 남은 후손을
 * 확인하지 못한 끝(remaining −1)이고, 끝난 프로세스는 물으면 그 끝 그대로 답한다
 */
async function settlingTaskTurn(e: OrchEnv, unconfirmed: boolean): Promise<{ taskId: string; proc: FakeProc; release: () => void }> {
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
  const proc = e.liveProc(key, e.producerId)!;
  if (unconfirmed) proc.terminateResult = ALREADY_EXITED_UNCONFIRMED;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  gates.push(() => release());
  let held = 0;
  const settle = e.core.hostExec.settleTurn.bind(e.core.hostExec);
  vi.spyOn(e.core.hostExec, 'settleTurn').mockImplementation(async (turnId, why) => {
    if (turnId === proc.turnId) {
      held += 1;
      await gate;
    }
    return settle(turnId, why);
  });
  proc.emit({ kind: 'result', text: '계획을 정리했습니다', data: {} });
  proc.exit(0, { remaining: unconfirmed ? -1 : 0 });
  await waitFor(() => held > 0, '마무리가 붙잡힘');
  expect(e.core.turns.liveTurnIds()).toContain(proc.turnId);
  expect(e.ctx.store.turns.require(proc.turnId).endedAt).toBeNull();
  return { taskId: t.id, proc, release };
}

const turnEnded = (e: OrchEnv, turnId: string) => waitFor(() => !!e.ctx.store.turns.require(turnId).endedAt, '턴 끝');

describe('finishedTurnStop — 마무리 중인 턴의 끝이 남긴 후손을 확인하지 못했으면 정지는 확인했다고 하지 않는다 (리드 결정 S7-22 S1)', () => {
  it('긴급 정지: 요약은 그 실패 줄로 완료가 아니다 — 멈춘 턴으로 세지 않고, 턴은 completed·kill_failed로 끝난다', async () => {
    const e = (env = await bootOrch());
    const { proc, release } = await settlingTaskTurn(e, true);
    const summary = await e.core.stops.emergency(OWNER);
    release();
    await turnEnded(e, proc.turnId);
    await e.idle();

    expect(summary.completed).toBe(false);
    expect(summary.failures).toEqual([expect.objectContaining({ memberId: e.producerId, detail: `종료 확인 실패: ${ALREADY_EXITED_UNCONFIRMED.detail}`, remaining: -1 })]);
    expect(summary.stoppedTurns).toEqual([]);
    expect(e.ctx.store.activity.search({ kinds: ['stop'], limit: 5 }).some((a) => a.text.startsWith('긴급 정지 — 종료 실패 있음: 턴 0개 종료'))).toBe(true);
    const t = e.ctx.store.turns.require(proc.turnId);
    expect([t.endReason, t.process.state, t.process.stopRequestedAt]).toEqual(['completed', 'kill_failed', null]);
  }, 60_000);

  it('작업 취소: 마무리 중인 그 턴의 작업 폴더를 지우지 않고 다음 시작에 맡긴다 — 턴은 completed·kill_failed로 끝난다', async () => {
    const e = (env = await bootOrch());
    const { taskId, proc, release } = await settlingTaskTurn(e, true);
    vi.spyOn(e.core.tasks, 'archiveWorkspace').mockResolvedValue(undefined);
    const cleaned = vi.spyOn(e.core.tasks, 'cleanupWorkspace').mockResolvedValue(true);
    await e.core.tasks.cancel(taskId, '시험 취소', MAIN_AGENT_ID);
    expect(cleaned).not.toHaveBeenCalled();
    expect(e.ctx.store.activity.search({ limit: 20 }).some((a) => a.text === `${taskId} 취소 — 남은 프로세스가 있어 작업 폴더 정리는 다음 시작 때`)).toBe(true);
    release();
    await turnEnded(e, proc.turnId);
    await e.idle();
    expect(cleaned).not.toHaveBeenCalled();
    expect(e.ctx.store.tasks.require(taskId).state).toBe('cancelled');
    const t = e.ctx.store.turns.require(proc.turnId);
    expect([t.endReason, t.process.state]).toEqual(['completed', 'kill_failed']);
  }, 60_000);

  it('남은 후손까지 확인한 끝이면 그대로다 (긴급 정지): 요약은 완료이고 실패 줄도 멈춘 턴도 없다', async () => {
    const e = (env = await bootOrch());
    const { proc, release } = await settlingTaskTurn(e, false);
    const summary = await e.core.stops.emergency(OWNER);
    expect([summary.completed, summary.failures, summary.stoppedTurns]).toEqual([true, [], []]);
    release();
    await turnEnded(e, proc.turnId);
    await e.idle();
    expect([e.ctx.store.turns.require(proc.turnId).endReason, e.ctx.store.turns.require(proc.turnId).process.state]).toEqual(['completed', 'exited']);
  }, 60_000);

  it('남은 후손까지 확인한 끝이면 그대로다 (작업 취소): 작업 폴더를 정리한다', async () => {
    const e = (env = await bootOrch());
    const { taskId, proc, release } = await settlingTaskTurn(e, false);
    vi.spyOn(e.core.tasks, 'archiveWorkspace').mockResolvedValue(undefined);
    const cleaned = vi.spyOn(e.core.tasks, 'cleanupWorkspace').mockResolvedValue(true);
    await e.core.tasks.cancel(taskId, '시험 취소', MAIN_AGENT_ID);
    expect(cleaned).toHaveBeenCalledTimes(1);
    release();
    await turnEnded(e, proc.turnId);
  }, 60_000);
});

describe("finishedTurnStop — '실행이 끝났다'는 러너가 끝을 알려 온 것이다 (리드 결정 S7-23·S7-24 W3)", () => {
  it('프로세스를 띄운 뒤 시작이 실패해 마무리 중인 턴(프로세스는 살아 있다)은 지금처럼 멈춘다: 그 프로세스를 끝내고 멈춘 턴으로 센다', async () => {
    const e = (env = await bootOrch());
    const d = seedDirective(e);
    // 띄운 뒤의 '실행 중' 턴 기록 쓰기가 한 번 실패한다 (DB 오류) → 시작 실패 → 마무리, 프로세스는 아직 살아 있다
    const put = e.ctx.store.turns.put.bind(e.ctx.store.turns);
    let thrown = 0;
    vi.spyOn(e.ctx.store.turns, 'put').mockImplementation((t) => {
      if (thrown === 0 && t.memberId === e.producerId && t.process.state === 'running' && t.process.pid !== null) {
        thrown += 1;
        throw new Error('시험: 띄운 뒤 턴 기록 쓰기 실패');
      }
      return put(t);
    });
    const t = e.core.tasks.create(
      { directiveId: d.id, title: '계획 문서', goal: '계획을 정리한다', type: 'plan', assigneeId: e.producerId, acceptanceCriteria: ['문서가 있다'], outputMode: 'repo' },
      e.producerId,
    );
    const key = taskKey(t.id);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    gates.push(() => release());
    let held = 0;
    const settle = e.core.hostExec.settleTurn.bind(e.core.hostExec);
    vi.spyOn(e.core.hostExec, 'settleTurn').mockImplementation(async (turnId, why) => {
      const row = e.ctx.store.turns.get(turnId);
      if (row?.taskId === t.id && row.sessionKind === 'task') {
        held += 1;
        await gate;
      }
      return settle(turnId, why);
    });
    e.hold.add(key);
    await waitFor(() => {
      if (thrown === 0) e.tick();
      return thrown > 0 && held > 0;
    }, '띄운 뒤 기록 쓰기 실패, 마무리 붙잡힘');
    const proc = e.procs.find((p) => p.workKey === key)!;
    expect([proc.done, proc.terminatedByApp]).toEqual([false, false]);

    const summary = await e.core.stops.emergency(OWNER);
    // 살아 있는 프로세스에 종료가 갔고, 이 정지가 끝낸 턴으로 센다
    expect(proc.terminatedByApp).toBe(true);
    expect(summary.stoppedTurns).toEqual([expect.objectContaining({ turnId: proc.turnId, ok: true })]);
    expect(summary.completed).toBe(true);
    release();
    await turnEnded(e, proc.turnId);
    await e.idle();
    expect(e.ctx.store.turns.require(proc.turnId).endReason).toBe('user_stop');
  }, 60_000);
});

describe('finishedTurnStop — 단계 마치고 정지도 마무리 중인 턴을 멈추지 않는다 (리드 결정 S7-22 S2)', () => {
  for (const mode of ['immediate', 'graceful'] as StopMode[]) {
    it(`팀원 일시정지(${mode})가 결과를 내고 끝난 작업 턴의 마무리 중에 온다: completed, 정지 기록 없음, 다시 넣지 않음`, async () => {
      const e = (env = await bootOrch());
      const { taskId, proc, release } = await settlingTaskTurn(e, false);
      await e.core.stops.pauseMember(e.producerId, mode, OWNER);
      release();
      await turnEnded(e, proc.turnId);
      await e.idle();
      const t = e.ctx.store.turns.require(proc.turnId);
      expect([t.endReason, t.endDetail, t.process.stopRequestedAt, t.process.stopMode]).toEqual(['completed', '', null, null]);
      expect(e.ctx.store.queue.list({ ref2: taskKey(taskId), state: 'queued' }).filter((q) => q.message.includes('정지로 중단된 업무'))).toEqual([]);
    }, 60_000);
  }
});
