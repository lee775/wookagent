/**
 * 비정상 종료 상한은 항목마다 보고, 남는 업무의 다시 전달은 따로 센다 (리드 결정 30, 10-30 — 재리뷰 세 영역 medium, 프로브 zz-s1fx3fg-crash-drops-owner-command
 * 두 갈래, zz-s1fix3-os-c3-command-dropped, zz-s1fix3-ti-handoff-crash-command와 그 대조):
 * - 예전에는 메인 턴의 비정상 종료 상한을 턴 단위로 보았다(실은 항목 중 가장 큰 attempts). 결정 24·26의 다시 넣기가 attempts를 올려서, 세 번째로 전달하는
 *   멈춘 검수 넘김(attempts 2)과 같은 턴에 실린 대표 명령·수정 요청(attempts 0)이 한 번의 비정상 종료로 버려졌다. 알림은 '…가 반복됩니다'라고 했고 그 명령은
 *   이름도 나오지 않았다
 * - 이제 attempts는 그 항목의 비정상 종료형 끝(비정상 종료·응답 없음·CLI 안전 검사 거부)만 세고, 상한은 항목마다 본다. 다시 전달(남는 업무·보고서 재촉)은
 *   deliveries로 따로 센다. 사용량 한도·재로그인 필요·이어하기 실패·정지·재시작으로 다시 넣는 것은 attempts를 올리지 않는다
 * - '자동 복구 실패' 알림은 버린 대표 명령·수정 요청을 프로젝트와 글 앞부분(또는 보고서 ID)으로 적고, '반복'은 정말 두 번 이상 그렇게 끝났을 때만 쓴다
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID, type QueueEntry, type Task } from '@shared/domain';
import { directiveKey, mainKey } from '../../src/main/orchestrator/records';
import { bootRestartable, type RestartableEnv } from '../acceptance/stops-helpers';
import type { FakeProc, OrchEnv } from './orchHarness';
import { bootOrch, seedDirective, seedInReviewTask, sleep, waitFor } from './orchHarness';

let env: OrchEnv | null = null;
let renv: RestartableEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
  await renv?.close();
  renv = null;
});

const SECTIONS = { summary: '로그인 화면을 만들었습니다', results: '로그인 화면', changedFiles: [], howToVerify: '-', issues: '-', nextSteps: '-' };
const liveMain = (e: OrchEnv) => e.ctx.store.queue.list({ ref2: mainKey(e.projectId), state: ['queued', 'running'] });
const crashNotices = (e: OrchEnv) => e.ctx.store.notifications.list().filter((n) => n.title === '자동 복구 실패');

/** 메인 에이전트가 유일한 검수자인 작업의 검수가 멈춰 메인 에이전트에게 넘어간다 (handOffStandingWork와 같은 준비). 메인 프로젝트 세션의 턴은 띄운 채 둔다 */
async function handedToMain(e: OrchEnv): Promise<Task> {
  await e.internal('members.remove', e.qaId);
  const d = seedDirective(e);
  const t0 = seedInReviewTask(e, MAIN_AGENT_ID, { outputMode: 'repo', directiveId: d.id });
  e.ctx.store.tasks.patch(t0.id, { assigneeId: e.producerId, contributors: [e.producerId] });
  const t = e.ctx.store.tasks.require(t0.id);
  e.hold.add(mainKey(e.projectId));
  e.script.set(directiveKey(d.id), (p) => {
    void e.tool(p.turnId, 'assign_reviewer', { task_id: t.id, reviewer_id: 'main' }).finally(() => p.finishOk());
  });
  e.core.tasks.dispatchReview(t);
  await waitFor(
    () => {
      e.tick();
      return e.ctx.store.queue.list().some((q) => q.memberId === MAIN_AGENT_ID && q.sessionKey === mainKey(e.projectId) && q.taskId === t.id);
    },
    '메인 에이전트에게 넘김',
    40_000,
  );
  await sleep(50);
  return t;
}

/** 메인 프로젝트 세션의 다음 턴(띄운 채)과 그 턴이 실은 항목 */
async function nextMainTurn(e: OrchEnv, label: string): Promise<{ p: FakeProc; carried: QueueEntry[] }> {
  const key = mainKey(e.projectId);
  await waitFor(
    () => {
      if (!e.liveProc(key, MAIN_AGENT_ID)) e.tick();
      return !!e.liveProc(key, MAIN_AGENT_ID);
    },
    label,
  );
  const p = e.liveProc(key, MAIN_AGENT_ID)!;
  return { p, carried: e.ctx.store.turns.get(p.turnId)!.queueEntryIds.map((id) => e.ctx.store.queue.get(id)!) };
}
async function ended(e: OrchEnv, p: FakeProc): Promise<void> {
  await waitFor(() => !e.core.turns.liveTurnIds().includes(p.turnId), '메인 턴 마무리');
  await sleep(30);
}

/** 넘김을 두 번 전달하고(아무 조치 없이 끝남), 그 두 번째 턴 동안 대표가 일을 보낸다 → 세 번째 턴에 넘김(전달 2)과 대표의 일이 함께 실린다 */
async function thirdDeliveryWithOwnerWork(e: OrchEnv, send: () => Promise<unknown>): Promise<{ t: Task; p3: FakeProc; carried: QueueEntry[] }> {
  const t = await handedToMain(e);
  const { p: p1 } = await nextMainTurn(e, '넘김 첫 전달');
  p1.finishOk('확인했습니다');
  await ended(e, p1);
  const { p: p2 } = await nextMainTurn(e, '넘김 두 번째 전달');
  await send();
  p2.finishOk('확인했습니다');
  await ended(e, p2);
  const { p: p3, carried } = await nextMainTurn(e, '넘김 세 번째 전달 + 대표의 일');
  return { t, p3, carried };
}

describe('대표의 일은 같은 턴에 실린 다른 업무의 횟수에 끌려 버려지지 않는다 (리드 결정 30)', () => {
  it('세 번째로 전달하는 멈춘 검수 넘김과 한 턴에 실린 대표 명령은 비정상 종료 한 번 뒤 다시 들어가고, 다음 턴에 전달된다', async () => {
    const e = (env = await bootOrch());
    const { t, p3, carried } = await thirdDeliveryWithOwnerWork(e, () => e.invoke('command.send', { target: e.projectId, text: '로그인 화면에 비밀번호 찾기도 넣어 줘' }));
    // 넘김은 전달 횟수로 세고 비정상 종료 횟수는 0이다
    expect(carried.map((q) => [q.kind, q.attempts, q.deliveries ?? 0]).sort()).toEqual([
      ['main_command', 0, 0],
      ['message', 0, 2],
    ]);
    p3.exit(1); // CLI가 한 번 비정상 종료
    await ended(e, p3);
    expect(e.ctx.store.turns.get(p3.turnId)!.endReason).toBe('crashed');
    // 둘 다 다시 대기 — 자기 비정상 종료 횟수 1, 넘김의 전달 횟수는 그대로
    expect(liveMain(e).map((q) => [q.kind, q.state, q.attempts, q.deliveries ?? 0]).sort()).toEqual([
      ['main_command', 'queued', 1, 0],
      ['message', 'queued', 1, 2],
    ]);
    expect(crashNotices(e)).toEqual([]);
    expect(e.ctx.store.notifications.list().filter((n) => n.key === `handoff-stuck:${t.id}`)).toEqual([]);
    // 다음 턴이 대표 명령을 전달한다
    const { p: p4, carried: c4 } = await nextMainTurn(e, '다시 넣은 대표 명령');
    expect(c4.map((q) => q.kind).sort()).toEqual(['main_command', 'message']);
    expect(e.launches.find((x) => x.turnId === p4.turnId)!.message).toContain('로그인 화면에 비밀번호 찾기도 넣어 줘');
    p4.finishOk('비밀번호 찾기를 지시로 등록했습니다');
    await ended(e, p4);
    expect(liveMain(e).filter((q) => q.kind === 'main_command')).toEqual([]);
    // 비정상 종료로 끊긴 전달은 세지 않는다 — 넘김은 끝까지 마친 세 번째 전달 뒤에야 대표에게 알린다
    expect(e.ctx.store.notifications.list().filter((n) => n.key === `handoff-stuck:${t.id}`).map((n) => n.body)).toEqual([
      expect.stringContaining('메인 에이전트에게 3번 넘겼지만 검수가 다시 시작되지 않았습니다'),
    ]);
  });

  it('세 번째로 전달하는 넘김과 한 턴에 실린 대표의 수정 요청도 비정상 종료 한 번 뒤 다시 들어간다 (보고서는 수정 요청 그대로)', async () => {
    const e = (env = await bootOrch());
    const d2 = seedDirective(e, '보고 지시');
    e.ctx.store.directives.put({ ...d2, state: 'reporting' });
    const report = await e.core.reports.submit({ directiveId: d2.id, sections: SECTIONS }, MAIN_AGENT_ID, null);
    const { p3, carried } = await thirdDeliveryWithOwnerWork(e, () => e.invoke('reports.requestChanges', report.id, { overall: '표로 바꿔 주세요', anchored: [] }));
    expect(carried.filter((q) => q.kind === 'change_request').map((q) => [q.attempts, q.deliveries ?? 0])).toEqual([[0, 0]]);
    expect(carried.find((q) => q.taskId)!.deliveries).toBe(2);
    p3.exit(1);
    await ended(e, p3);
    expect(liveMain(e).filter((q) => q.kind === 'change_request').map((q) => [q.state, q.attempts])).toEqual([['queued', 1]]);
    expect(crashNotices(e)).toEqual([]);
    expect(e.ctx.store.reports.require(report.id).status).toBe('changes_requested');
    const { p: p4 } = await nextMainTurn(e, '다시 넣은 수정 요청');
    expect(e.launches.find((x) => x.turnId === p4.turnId)!.message).toContain('표로 바꿔 주세요');
  });

  it('상한은 항목마다 본다: 두 번 끊긴 대표 명령은 세 번째에 버리고 이름과 글 앞부분을 알린다 — 같은 턴의 새 대표 명령은 다시 들어가 다음 턴에 전달된다', async () => {
    const e = (env = await bootOrch());
    const key = mainKey(e.projectId);
    e.hold.add(key);
    const project = e.ctx.store.projects.require(e.projectId);
    const A = '결제 모듈을 토스로 바꾸고 테스트 결제까지 한 번 확인해 줘 — 실패하면 이유도 같이 보고해';
    await e.invoke('command.send', { target: e.projectId, text: A });
    const { p: t1 } = await nextMainTurn(e, 'A 첫 턴');
    t1.exit(1);
    await ended(e, t1);
    const { p: t2 } = await nextMainTurn(e, 'A 두 번째 턴');
    await e.invoke('command.send', { target: e.projectId, text: '로그인 문구를 고쳐 줘' });
    t2.exit(1);
    await ended(e, t2);
    const { p: t3, carried } = await nextMainTurn(e, 'A 세 번째 + B 첫 턴');
    expect(carried.map((q) => q.attempts).sort()).toEqual([0, 2]);
    t3.exit(1);
    await ended(e, t3);
    // A는 자기 상한(crashRetryMax 2)에 닿아 버렸고, B는 한 번 끊겼을 뿐이라 다시 대기
    const cmds = liveMain(e).filter((q) => q.kind === 'main_command');
    expect(cmds.map((q) => [q.state, q.attempts, q.message.includes('로그인 문구를 고쳐 줘')])).toEqual([['queued', 1, true]]);
    const n = crashNotices(e);
    expect(n.map((x) => x.level)).toEqual(['urgent']);
    expect(n[0]!.body).toBe(
      `명령 처리 — 비정상 종료가 반복됩니다. 메인 에이전트에게 전하지 못한 대표 요청: ${project.name}(${project.id}) 명령 "결제 모듈을 토스로 바꾸고 테스트 결제까지 한 번 확인해 줘 — 실패하…" — 필요하면 명령창으로 메인 에이전트에게 다시 말해 주세요`,
    );
    expect(n[0]!.body).not.toContain('로그인 문구');
    const { p: t4 } = await nextMainTurn(e, 'B 다시 전달');
    expect(e.launches.find((x) => x.turnId === t4.turnId)!.message).toContain('로그인 문구를 고쳐 줘');
  });

  it("'반복'은 사실일 때만: 자동 재시도 0회면 한 번 끊긴 대표 명령을 버리고 그렇게 알린다 — 응답 없음도 자연스러운 글로", async () => {
    const e = (env = await bootOrch({ settings: { execution: { crashRetryMax: 0, noOutputMin: 0.003, healthCheckMin: 0.003 } } }));
    const key = mainKey(e.projectId);
    e.hold.add(key);
    const project = e.ctx.store.projects.require(e.projectId);
    await e.invoke('command.send', { target: e.projectId, text: '배포 체크리스트 정리' });
    const { p } = await nextMainTurn(e, '메인 턴');
    p.exit(1);
    await ended(e, p);
    expect(liveMain(e)).toEqual([]);
    const body = crashNotices(e)[0]!.body;
    expect(body).toBe(
      `명령 처리 — 비정상 종료로 끝났습니다 — 자동 재시도가 0회로 정해져 있어 다시 시도하지 않습니다. 메인 에이전트에게 전하지 못한 대표 요청: ${project.name}(${project.id}) 명령 "배포 체크리스트 정리" — 필요하면 명령창으로 메인 에이전트에게 다시 말해 주세요`,
    );
    expect(body).not.toContain('반복');
    // 응답 없음(감시가 끝냄)도 같은 규칙 — '응답 없음으로 끝났습니다'
    await e.invoke('command.send', { target: e.projectId, text: '회의록 요약' });
    const { p: q } = await nextMainTurn(e, '응답 없는 메인 턴');
    await waitFor(() => q.done, '응답 없음으로 종료', 10_000);
    await ended(e, q);
    expect(e.ctx.store.turns.get(q.turnId)!.endReason).toBe('no_response');
    // 대표 명령을 버린 알림은 버림마다 따로다 — 앞 알림('배포 체크리스트 정리')을 덮지 않는다 (리드 결정 36)
    expect(crashNotices(e).map((n) => n.body.includes('명령 "회의록 요약"'))).toEqual([false, true]);
    expect(crashNotices(e)[0]!.body).toBe(body);
    expect(crashNotices(e)[1]!.body).toContain('명령 처리 — 응답 없음으로 끝났습니다 — 자동 재시도가 0회로');
  });
});

// 시험 빈틈 (리드 결정 40, tests-integrity 4차 재리뷰 [3], 프로브 zz-s1fix4-ti-dropped-owner-requests, 변이 N4-cr-name·N4-spin-owner·N4-startfail-owner):
// 버린 대표 요청을 알림에 적는 보장의 나머지 절반 — 수정 요청은 보고서 ID로, 헛돌기·업무 시작 실패로 버린 대표 명령도 그 알림에 적는다
describe('버린 대표 요청은 어떤 끝이든 알림에 이름이 남는다 (리드 결정 30·40)', () => {
  it('비정상 종료 상한에서 버린 수정 요청은 보고서 ID로 적는다', async () => {
    const e = (env = await bootOrch());
    const key = mainKey(e.projectId);
    e.script.set(key, (p) => p.exit(1));
    const project = e.ctx.store.projects.require(e.projectId);
    const d = seedDirective(e, '보고 지시');
    e.ctx.store.directives.put({ ...d, state: 'reporting' });
    const report = await e.core.reports.submit({ directiveId: d.id, sections: SECTIONS }, MAIN_AGENT_ID, null);
    await e.invoke('reports.requestChanges', report.id, { overall: '표로 바꿔 주세요', anchored: [] });
    await waitFor(
      () => {
        e.tick();
        return crashNotices(e).length > 0;
      },
      '비정상 종료 상한',
      40_000,
    );
    await sleep(50);
    const bodies = crashNotices(e).map((n) => n.body);
    expect(bodies.filter((b) => b.includes(`메인 에이전트에게 전하지 못한 대표 요청: ${project.name}(${project.id}) 보고서 ${report.id} 수정 요청 — 필요하면 명령창으로 메인 에이전트에게 다시 말해 주세요`))).toHaveLength(1);
    expect(bodies.every((b) => b.includes('비정상 종료가 반복됩니다'))).toBe(true);
    expect(e.ctx.store.reports.require(report.id).status).toBe('changes_requested');
  });

  it('헛돌기로 끝난 메인 턴이 버린 대표 명령은 헛돌기 알림에 적는다 (다시 넣지 않음)', async () => {
    const e = (env = await bootOrch());
    const key = mainKey(e.projectId);
    e.script.set(key, (p) => {
      for (let i = 0; i < 5; i++) p.emit({ kind: 'error', text: '같은 오류', data: {} });
    });
    const project = e.ctx.store.projects.require(e.projectId);
    await e.invoke('command.send', { target: e.projectId, text: '결제 화면 문구를 고쳐 줘' });
    await waitFor(
      () => {
        e.tick();
        return e.ctx.store.notifications.list().some((n) => n.title === '헛돌기');
      },
      '헛돌기',
      40_000,
    );
    await sleep(50);
    const body = e.ctx.store.notifications.list().find((n) => n.title === '헛돌기')!.body;
    expect(body).toContain(`같은 오류가 반복됐습니다. 메인 에이전트에게 전하지 못한 대표 요청: ${project.name}(${project.id}) 명령 "결제 화면 문구를 고쳐 줘" — 필요하면 명령창으로 메인 에이전트에게 다시 말해 주세요`);
    expect(liveMain(e)).toEqual([]);
  });

  it('업무 시작 실패 상한에서 버린 대표 명령은 업무 시작 실패 알림에 적는다', async () => {
    const e = (env = await bootOrch());
    const key = mainKey(e.projectId);
    let fails = 0;
    e.prepareHook = (_launch, who) => {
      if (who.sessionKey === key) {
        fails += 1;
        throw new Error('모델 이름을 찾을 수 없습니다 (시험)');
      }
    };
    const project = e.ctx.store.projects.require(e.projectId);
    await e.invoke('command.send', { target: e.projectId, text: '배포 체크리스트 정리해 줘' });
    await waitFor(
      () => {
        if (e.core.turns.count() === 0) e.tick();
        return fails >= 3 && e.core.turns.count() === 0 && e.ctx.store.notifications.list().some((n) => n.title === '업무 시작 실패');
      },
      '업무 시작 실패 상한',
      20_000,
    );
    await sleep(50);
    expect(e.ctx.store.notifications.list().filter((n) => n.title === '업무 시작 실패').map((n) => n.body)).toEqual([
      `${key}: 모델 이름을 찾을 수 없습니다 (시험) — 3번 시작하지 못해 멈춘 업무: 명령 처리. 메인 에이전트에게 전하지 못한 대표 요청: ${project.name}(${project.id}) 명령 "배포 체크리스트 정리해 줘" — 필요하면 명령창으로 메인 에이전트에게 다시 말해 주세요`,
    ]);
  });
});

describe('비정상 종료형이 아닌 끝은 비정상 종료 횟수(attempts)를 올리지 않는다 (리드 결정 30)', () => {
  it.each([
    ['사용량 한도', (p: FakeProc) => p.emit({ kind: 'error', text: '사용량 한도에 도달했습니다', data: { errorKind: 'usage_limit' } })],
    ['재로그인 필요', (p: FakeProc) => p.emit({ kind: 'error', text: '로그인이 필요합니다', data: { errorKind: 'auth' } })],
    [
      '이어하기 실패',
      (p: FakeProc) => {
        p.emit({ kind: 'error', text: 'No conversation found with session ID: gone', data: { errorKind: 'other', resumeFailed: true } });
        p.exit(1);
      },
    ],
  ] as const)('%s로 끊긴 메인 턴의 대표 명령은 attempts 0 그대로 다시 넣는다 — 재시작 횟수(restarts)도 올리지 않는다', async (_label, cut) => {
    const e = (env = await bootOrch());
    const key = mainKey(e.projectId);
    e.hold.add(key);
    await e.invoke('command.send', { target: e.projectId, text: '스프린트 계획 세워 줘' });
    const { p } = await nextMainTurn(e, '메인 턴');
    cut(p);
    await ended(e, p);
    // 결정 39: 사용량 한도·재로그인 필요·이어하기 실패는 어느 횟수도 올리지 않는다 (리드 결정 45, tests-integrity 변이 N5-requeue-raises-restarts)
    expect(liveMain(e).map((q) => [q.kind, q.state, q.attempts, q.restarts ?? 0])).toEqual([['main_command', 'queued', 0, 0]]);
  });

  it('긴급 정지로 끊긴 메인 턴의 대표 명령도 attempts 0, restarts 0 그대로다', async () => {
    const e = (env = await bootOrch());
    const key = mainKey(e.projectId);
    e.hold.add(key);
    await e.invoke('command.send', { target: e.projectId, text: '스프린트 계획 세워 줘' });
    const { p } = await nextMainTurn(e, '메인 턴');
    await e.invoke('stop.emergency');
    await ended(e, p);
    expect(liveMain(e).map((q) => [q.kind, q.state, q.attempts, q.restarts ?? 0])).toEqual([['main_command', 'queued', 0, 0]]);
  });

  it('재시작으로 끊긴 메인 턴의 대표 명령도 attempts 0 그대로 대기열로 돌아간다 (settleCutTurnEntries) — 재시작 횟수만 1 오른다', async () => {
    let e = (renv = await bootRestartable({ holdAll: true }));
    await e.invoke('command.send', { target: e.projectId, text: '스프린트 계획 세워 줘' });
    e.tick();
    await waitFor(() => e.ctx.store.queue.list({ ref2: mainKey(e.projectId), state: 'running' }).length > 0, '메인 턴');
    e.crash();
    e = renv = await e.reboot();
    // 되돌린 항목은 다시 시작한 스케줄러가 곧바로 다시 띄울 수 있다 — 상태와 상관없이 비정상 종료 횟수는 0, 재시작으로 끊긴 횟수는 1이다 (리드 결정 39)
    expect(e.ctx.store.queue.list({ ref2: mainKey(e.projectId), state: ['queued', 'running'] }).map((q) => [q.kind, q.attempts, q.restarts ?? 0])).toEqual([['main_command', 0, 1]]);
    expect(e.ctx.store.turns.list().filter((x) => x.endReason === 'app_restart').length).toBe(1);
  });
});
