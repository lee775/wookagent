/**
 * 재시작으로 끊긴 업무에도 상한이 있다 (리드 결정 39, 10-30 — S1F9 알아 둘 것 4):
 * - 결정 30부터 재시작으로 끊긴 업무는 비정상 종료 횟수(attempts)를 올리지 않는다. 그래서 그 업무의 턴이 앱째 끝내면(앱·PC가 그 턴마다 죽으면) 재시작
 *   복구가 재시작마다 그 업무를 다시 넣어 끝없이 돌았다. 결정 30 전에는 비정상 종료 상한이 이 고리를 끊었다
 * - 이제 재시작으로 끊긴 횟수를 항목마다 따로 센다(QueueEntry.restarts). 재시작 복구가 다시 넣을 때만 올리고, 3번째로 끊기면 다시 넣지 않고 버린 뒤
 *   비정상 종료 상한처럼 알린다 — 버린 대표 요청은 그 버림만의 알림 key로 이름을 적고 활동 기록을 남긴다(리드 결정 36). 알림은 프로그램이 그 업무를 처리하던
 *   중에 다시 시작됐다고 말한다. 끊긴 턴의 업무를 다시 넣을 때(requeue)는 횟수를 이어 간다
 * - 검수 업무를 버리면 비정상 종료 상한처럼 프로듀서에게 검수자 재배정이 간다 — 검수 중 작업에는 늘 처리할 수 있는 쪽의 업무가 있다 (리드 결정 11)
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID } from '@shared/domain';
import { directiveKey, mainKey, reviewKey } from '../../src/main/orchestrator/records';
import { bootRestartable, seedDirective, seedInReviewTask, sleep, waitUntil, type RestartableEnv } from '../acceptance/stops-helpers';

let renv: RestartableEnv | null = null;
afterEach(async () => {
  await renv?.close();
  renv = null;
});

const A = '결제 모듈을 토스로 바꾸고 테스트 결제까지 확인해 줘';
const B = '로그인 화면 문구를 존댓말로 고쳐 줘';
const crashNotices = (e: RestartableEnv) => e.ctx.store.notifications.list().filter((n) => n.title === '자동 복구 실패');
const commands = (e: RestartableEnv) =>
  e.ctx.store.queue
    .list({ ref2: mainKey(e.projectId) })
    .filter((q) => q.kind === 'main_command')
    .map((q) => ({ id: q.id, which: q.message.includes(A) ? 'A' : 'B', state: q.state, restarts: q.restarts ?? 0, attempts: q.attempts }));

async function mainTurnLive(e: RestartableEnv, label: string): Promise<string[]> {
  const key = mainKey(e.projectId);
  await waitUntil(
    () => {
      if (!e.liveProc(key, MAIN_AGENT_ID)) e.tick();
      return !!e.liveProc(key, MAIN_AGENT_ID);
    },
    label,
  );
  const p = e.liveProc(key, MAIN_AGENT_ID)!;
  return e.ctx.store.turns.get(p.turnId)!.queueEntryIds.map((id) => (e.ctx.store.queue.get(id)!.message.includes(A) ? 'A' : 'B'));
}

describe('재시작으로 끊긴 업무에도 상한이 있다 (리드 결정 39)', () => {
  it('대표 명령은 재시작 한두 번은 견디고 다시 전달되지만, 세 번째로 끊기면 버리고 그 이름을 알린다 — 함께 실린 다른 명령은 자기 횟수대로 남는다', async () => {
    let e = (renv = await bootRestartable({ holdAll: true }));
    const key = mainKey(e.projectId);
    const project = e.ctx.store.projects.require(e.projectId);
    await e.invoke('command.send', { target: e.projectId, text: A });
    expect(await mainTurnLive(e, 'A 첫 턴')).toEqual(['A']);
    // 1번째 재시작: A는 끊긴 횟수 1로 다시 들어가 다시 시작한 스케줄러가 곧바로 다시 띄운다
    e.crash();
    e = renv = await e.reboot();
    expect(await mainTurnLive(e, 'A 두 번째 턴')).toEqual(['A']);
    expect(commands(e).map((c) => [c.which, c.state, c.restarts, c.attempts])).toEqual([['A', 'running', 1, 0]]);
    expect(crashNotices(e)).toEqual([]);
    // 그 턴이 도는 사이 명령 B가 들어온다 (대기 — 이 턴에는 실리지 않음)
    await e.invoke('command.send', { target: e.projectId, text: B });
    // 2번째 재시작: A는 끊긴 횟수 2로 다시 들어가고, 끊긴 턴에 없던 B는 그대로 0 — 다음 턴이 둘을 함께 싣는다
    e.crash();
    e = renv = await e.reboot();
    expect((await mainTurnLive(e, 'A 세 번째 + B 첫 턴')).sort()).toEqual(['A', 'B']);
    expect(commands(e).map((c) => [c.which, c.state, c.restarts])).toEqual([
      ['A', 'running', 2],
      ['B', 'running', 0],
    ]);
    expect(crashNotices(e)).toEqual([]);
    const aId = commands(e).find((c) => c.which === 'A')!.id;
    // 3번째 재시작: A는 세 번째로 끊겨 버리고 알린다. B는 한 번 끊겼을 뿐이라 다시 들어가 전달된다
    e.crash();
    e = renv = await e.reboot();
    expect(await mainTurnLive(e, 'B 다시 전달')).toEqual(['B']);
    expect(commands(e).map((c) => [c.which, c.state, c.restarts])).toEqual([
      ['A', 'cancelled', 3],
      ['B', 'running', 1],
    ]);
    const n = crashNotices(e);
    expect(n.map((x) => [x.key, x.level, x.readAt])).toEqual([[`crash:${key}:${aId}`, 'urgent', null]]);
    expect(n[0]!.body).toBe(
      `명령 처리 — 이 업무를 처리하던 중에 프로그램이 3번 다시 시작돼(앱이 갑자기 꺼지거나 PC가 다시 켜지는 등) 더는 자동으로 다시 시도하지 않습니다. 메인 에이전트에게 전하지 못한 대표 요청: ${project.name}(${project.id}) 명령 "${A}" — 필요하면 명령창으로 메인 에이전트에게 다시 말해 주세요`,
    );
    expect(n[0]!.body).not.toContain(B);
    expect(e.ctx.store.activity.search({ text: '메인 에이전트에게 전하지 못한 대표 요청', limit: 10 }).map((a) => a.text)).toEqual([
      `메인 에이전트에게 전하지 못한 대표 요청: ${project.name}(${project.id}) 명령 "${A}" — 이 업무를 처리하던 중에 프로그램이 3번 다시 시작돼(앱이 갑자기 꺼지거나 PC가 다시 켜지는 등) 더는 자동으로 다시 시도하지 않습니다 (${aId}, 다시 전달하지 않음)`,
    ]);
    expect(e.ctx.store.activity.search({ text: '재시작 복구: 명령 처리', limit: 10 }).map((a) => a.text)).toEqual([
      `재시작 복구: 명령 처리 — 처리하던 중에 프로그램이 3번 다시 시작돼 다시 넣지 않음 (${key})`,
    ]);
    // 끊긴 턴의 업무를 다시 넣을 때(비정상 종료)는 재시작 횟수를 이어 간다 — 처음부터 다시 세지 않는다
    const p = e.liveProc(key, MAIN_AGENT_ID)!;
    p.exit(1);
    await waitUntil(() => commands(e).some((c) => c.which === 'B' && c.state === 'queued') || !!e.liveProc(key, MAIN_AGENT_ID), 'B 다시 넣기');
    await sleep(30);
    expect(commands(e).filter((c) => c.which === 'B' && c.state !== 'done').map((c) => [c.restarts, c.attempts])).toEqual([[1, 1]]);
  });

  it('검수 업무가 세 번째로 끊기면 버리고 프로듀서에게 검수자 재배정을 맡긴다 — 재시작 3)은 그 작업에 검수를 다시 등록하지 않는다', async () => {
    let e = (renv = await bootRestartable({ holdAll: true }));
    const d = seedDirective(e);
    const t = seedInReviewTask(e, { directiveId: d.id, assigneeId: e.devId, reviewerId: e.qaId });
    e.core.tasks.dispatchReview(e.ctx.store.tasks.require(t.id));
    const reviewLive = async (label: string) =>
      waitUntil(
        () => {
          if (!e.liveProc(reviewKey(t.id), e.qaId)) e.tick();
          return !!e.liveProc(reviewKey(t.id), e.qaId);
        },
        label,
      );
    const reviews = () =>
      e.ctx.store.queue
        .list({ ref2: reviewKey(t.id) })
        .filter((q) => q.kind === 'review')
        .map((q) => [q.state, q.restarts ?? 0]);
    await reviewLive('검수 턴');
    for (let i = 1; i <= 2; i++) {
      e.crash();
      e = renv = await e.reboot();
      await reviewLive(`검수 턴 (재시작 ${i}번 뒤)`);
      expect(reviews()).toEqual([['running', i]]);
    }
    e.crash();
    e = renv = await e.reboot();
    await sleep(50);
    expect(reviews()).toEqual([['cancelled', 3]]);
    expect(e.ctx.store.tasks.require(t.id).state).toBe('in_review');
    // 검수 중 작업에는 처리할 수 있는 쪽의 업무가 있다 — 프로듀서의 검수자 재배정 (리드 결정 11)
    const assign = e.ctx.store.queue.list({ ref2: directiveKey(d.id), state: ['queued', 'running'] }).filter((q) => q.kind === 'reviewer_assign' && q.taskId === t.id);
    expect(assign).toHaveLength(1);
    expect(assign[0]!.message).toContain(`${t.id} 검수 턴이 프로그램 재시작으로 3번 끊겼습니다`);
    expect(e.core.tasks.reviewPending(t.id)).toBe(false);
    const n = crashNotices(e);
    // 재시작 상한에서 버린 팀원 업무(검수)는 메인 에이전트에게 한 번 넘긴다 — 알림은 넘긴 사실로 끝난다 (리드 결정 44·45·S5-8). 시작 때 검수를 다시 등록하지 않는 것은
    // 그대로다(위)
    const dropped = e.ctx.store.queue.list({ ref2: reviewKey(t.id) }).filter((q) => q.kind === 'review').at(-1)!;
    expect(n.map((x) => [x.key, x.body])).toEqual([
      [
        `crash:${reviewKey(t.id)}`,
        `검수 ${t.id} — 이 업무를 처리하던 중에 프로그램이 3번 다시 시작돼(앱이 갑자기 꺼지거나 PC가 다시 켜지는 등) 더는 자동으로 다시 시도하지 않습니다. 그 일을 메인 에이전트에게 넘겼습니다. 메인 에이전트가 확인하고 이어 갑니다 — 서둘러야 하면 명령창으로 메인 에이전트에게 알려 주세요`,
      ],
    ]);
    const alerts = e.ctx.store.queue.list({ ref1: MAIN_AGENT_ID }).filter((q) => q.kind === 'alert');
    expect(alerts.map((q) => [q.alertKey, q.sessionKey, q.taskId])).toEqual([[`alert:restart-dropped:${dropped.id}`, mainKey(e.projectId), t.id]]);
    expect(alerts[0]!.message).toContain(`assign_reviewer(task_id="${t.id}", reviewer_id="…")`);
  });

  // 시험 빈틈 (리드 결정 45, tests-integrity 5차 재리뷰, 프로브 zz-s1fix5-ti-requeue-restart-count (4), 변이 N5-requeue-raises-restarts): 사용량 한도로 다시 넣는 것은
  // 재시작 횟수를 올리지 않는다. 올리면 사용량 한도로 두 번 끊긴 대표 명령이 첫 재시작에서 '3번 다시 시작돼'로 버려진다 — 실제로는 한 번 다시 시작했을 뿐이다
  it('사용량 한도로 두 번 끊긴 대표 명령도 재시작 두 번을 견딘다 — 다시 넣기는 재시작 횟수를 올리지 않는다', async () => {
    let e = (renv = await bootRestartable({ holdAll: true }));
    const key = mainKey(e.projectId);
    const live = () => e.ctx.store.queue.list({ ref2: key, state: ['queued', 'running'] }).filter((q) => q.kind === 'main_command');
    const turn = async (label: string) => {
      await waitUntil(
        () => {
          if (!e.liveProc(key, MAIN_AGENT_ID)) e.tick();
          return !!e.liveProc(key, MAIN_AGENT_ID);
        },
        label,
      );
      return e.liveProc(key, MAIN_AGENT_ID)!;
    };
    await e.invoke('command.send', { target: e.projectId, text: A });
    for (let i = 1; i <= 2; i++) {
      const p = await turn(`턴 ${i}`);
      p.emit({ kind: 'error', text: '사용량 한도에 도달했습니다', data: { errorKind: 'usage_limit' } });
      await waitUntil(() => !e.core.turns.liveTurnIds().includes(p.turnId), `사용량 한도로 끊김 ${i}`);
      await sleep(30);
      expect(live().map((q) => [q.attempts, q.restarts ?? 0])).toEqual([[0, 0]]);
    }
    await turn('사용량 한도로 두 번 끊긴 뒤의 턴');
    for (let r = 1; r <= 2; r++) {
      e.crash();
      e = renv = await e.reboot();
      // 그 명령이 다시 전달되거나(메인 턴이 뜸) 시작 때 버려진다('자동 복구 실패') — 다시 전달돼야 한다
      await waitUntil(
        () => {
          if (!e.liveProc(key, MAIN_AGENT_ID)) e.tick();
          return !!e.liveProc(key, MAIN_AGENT_ID) || crashNotices(e).length > 0;
        },
        `재시작 ${r}번 뒤 턴 (또는 버림 알림)`,
      );
      expect({ cmds: live().map((q) => [q.state, q.attempts, q.restarts ?? 0]), crash: crashNotices(e).map((n) => n.body) }).toEqual({ cmds: [['running', 0, r]], crash: [] });
    }
  });
});
