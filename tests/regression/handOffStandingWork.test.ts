/**
 * 멈춘 검수를 메인 에이전트에게 넘긴 업무는 대상이 풀릴 때까지 남는 업무다 (리드 결정 24, 10-30 — flows 재리뷰 medium, 프로브 zz-s1fx2fg-handoff-consumed):
 * - 예전에는 넘김(handReviewToMain)이 main:<P> 업무 하나뿐이었다. 그 업무를 실은 메인 턴이 (a) 아무 조치 없이 끝나거나 (b) 비정상 종료 상한으로 버려지면
 *   검수 중 작업에 대기·실행 중인 검수도, 검수자 재배정도, 메인 업무도 남지 않았다(리드 결정 11 위반). 대표 알림은 작업·검수자마다 이미 한 번 갔다
 * - 이제 메인 턴이 대상을 풀지 않고 끝나면 다시 넣는다(보고서 재촉처럼). 메인 턴 3번에 실려도 그대로면 대표에게 그 작업을 알린다 — 그 뒤에는 그 알림이
 *   처리할 수 있는 쪽의 업무다. 메인 턴이 다시 넣지 않는 끝(비정상 종료 상한·시작 실패 상한 등)도 조용히 버리지 않고 그 작업을 알린다
 * - 재시작 복구 3)은 검수가 넘어간 작업(넘김 업무·검수자 재배정 — 합쳐 둔 옛 항목은 글의 작업 ID도)에 검수를 다시 등록하지 않는다
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID, type QueueEntry, type Task } from '@shared/domain';
import { directiveKey, enqueue, mainKey, reviewKey } from '../../src/main/orchestrator/records';
import { bootRestartable, seedDirective as seedRestartDirective, seedInReviewTask as seedRestartReview, type RestartableEnv } from '../acceptance/stops-helpers';
import type { OrchEnv } from './orchHarness';
import { bootOrch, seedDirective, seedInReviewTask, sleep, waitFor } from './orchHarness';

let env: OrchEnv | null = null;
let renv: RestartableEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
  await renv?.close();
  renv = null;
});

const live = (e: OrchEnv) => e.ctx.store.queue.list({ state: ['queued', 'running'] });
const handOffs = (e: OrchEnv, t: Task) => live(e).filter((q) => q.memberId === MAIN_AGENT_ID && q.sessionKey.startsWith('main:') && q.taskId === t.id);
const stuckNotice = (e: OrchEnv, t: Task) => e.ctx.store.notifications.list().filter((n) => n.key === `handoff-stuck:${t.id}`);
/** 그 작업에 남은 일 — 대기·실행 중인 검수, 검수자 재배정, 그 작업의 메인 업무 */
function workFor(e: OrchEnv, t: Task) {
  return {
    state: e.ctx.store.tasks.require(t.id).state,
    review: live(e).filter((q) => q.sessionKey === reviewKey(t.id) && q.kind === 'review').length + (e.core.turns.hasLiveSession(reviewKey(t.id)) ? 1 : 0),
    reviewerAssign: live(e).filter((q) => q.kind === 'reviewer_assign' && q.taskId === t.id).length,
    mainWork: handOffs(e, t).length,
  };
}
async function ticks(e: OrchEnv, n: number) {
  for (let i = 0; i < n; i++) {
    e.tick();
    await sleep(25);
  }
}

/**
 * 메인 에이전트가 유일한 검수자이고 메인 검수 턴이 판정 없이 끝나며 프로듀서는 같은 "main"을 다시 고른다 → 다시 등록한 검수도 판정 없이 끝나 메인 에이전트에게
 * 넘긴다 (리드 결정 17). 메인 에이전트의 프로젝트 세션 턴은 hold면 띄운 채 둔다
 */
async function handedToMain(e: OrchEnv, o: { holdMain?: boolean } = {}): Promise<Task> {
  await e.internal('members.remove', e.qaId);
  const d = seedDirective(e);
  const t0 = seedInReviewTask(e, MAIN_AGENT_ID, { outputMode: 'repo', directiveId: d.id });
  e.ctx.store.tasks.patch(t0.id, { assigneeId: e.producerId, contributors: [e.producerId] });
  const t = e.ctx.store.tasks.require(t0.id);
  if (o.holdMain !== false) e.hold.add(mainKey(e.projectId));
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

/** 메인 프로젝트 세션의 다음 턴을 띄워 그 턴과 실은 항목을 돌려준다 */
async function nextMainTurn(e: OrchEnv, label: string) {
  const key = mainKey(e.projectId);
  await waitFor(
    () => {
      if (!e.liveProc(key, MAIN_AGENT_ID)) e.tick();
      return !!e.liveProc(key, MAIN_AGENT_ID);
    },
    label,
  );
  const p = e.liveProc(key, MAIN_AGENT_ID)!;
  const carried = e.ctx.store.turns.get(p.turnId)!.queueEntryIds.map((id) => e.ctx.store.queue.get(id)!);
  return { p, carried };
}
async function endTurn(e: OrchEnv, p: { turnId: string; finishOk(text?: string): void; done: boolean }) {
  p.finishOk('검수가 멈춘 것을 확인했습니다');
  await waitFor(() => !e.core.turns.liveTurnIds().includes(p.turnId), '메인 턴 마무리');
  await sleep(30);
}

describe('멈춘 검수 넘김은 대상이 풀릴 때까지 남는다 (리드 결정 24)', () => {
  it('(a) 넘김을 실은 메인 턴이 아무 조치 없이 끝나면 다시 넣고, 메인 턴 3번에 실려도 그대로면 대표에게 그 작업을 알린 뒤 더 넣지 않는다', async () => {
    const e = (env = await bootOrch());
    const t = await handedToMain(e);
    const original = e.ctx.store.queue.list().find((q) => q.taskId === t.id && q.memberId === MAIN_AGENT_ID && q.sessionKey === mainKey(e.projectId))!;
    for (let i = 0; i < 3; i++) {
      const { p, carried } = await nextMainTurn(e, `넘김을 실은 메인 턴 ${i + 1}`);
      const handOff = carried.filter((q) => q.taskId === t.id);
      // 다시 전달은 전달 횟수(deliveries)로 센다 — 비정상 종료 횟수(attempts)는 오르지 않는다 (리드 결정 30)
      expect(handOff.map((q) => [q.kind, q.deliveries ?? 0, q.attempts, q.priority])).toEqual([['message', i, 0, 'high']]);
      // 저장된 글은 원래 안내 그대로다 — 머리말은 전달할 때만 붙인다 (리드 결정 31)
      expect(handOff[0]!.message).toBe(original.message);
      const launched = e.launches.find((x) => x.turnId === p.turnId)!.message;
      if (i > 0) {
        // 다시 넣은 업무: 몇 번째 알림인지와 아직 검수가 다시 시작되지 않았다는 머리말 + 원래 안내 (머리말은 쌓이지 않는다)
        expect(launched).toContain(`> (${i + 1}번째 알림 — ${t.id} 검수가 아직 다시 시작되지 않았습니다)`);
        expect(launched).toContain('3번째에도 그대로면 대표에게 알립니다');
        expect(launched.match(/번째 알림 —/g)).toHaveLength(1);
        // 원래 안내는 첫 줄만이 아니라 모든 줄('할 수 있는 일:'과 그 목록)이 그대로 간다 — 턴 메시지는 본문 줄마다 '> '를 붙인다 (리드 결정 40)
        expect(original.message.split('\n').length).toBeGreaterThan(1);
        expect(launched).toContain(original.message.split('\n').map((l) => `> ${l}`).join('\n'));
      } else expect(launched).not.toContain('번째 알림 —');
      // 그 순간에도 검수 중 작업에는 처리할 수 있는 쪽의 업무가 있다 (리드 결정 11)
      expect(workFor(e, t)).toMatchObject({ state: 'in_review', mainWork: 1 });
      await endTurn(e, p);
      if (i < 2) expect(handOffs(e, t).map((q) => [q.state, q.deliveries, q.attempts])).toEqual([['queued', i + 1, 0]]);
    }
    // 세 번째 뒤: 다시 넣지 않고 대표에게 그 작업을 알린다 — 그 알림이 처리할 수 있는 쪽의 업무다
    expect(workFor(e, t)).toEqual({ state: 'in_review', review: 0, reviewerAssign: 0, mainWork: 0 });
    const n = stuckNotice(e, t);
    expect(n.map((x) => [x.title, x.level])).toEqual([['메인 에이전트 처리 지연', 'normal']]);
    expect(n[0]!.body).toBe(
      `${t.directiveId}: ${t.id} "${t.title}" 검수가 멈춘 채 남아 있습니다 — 메인 에이전트에게 3번 넘겼지만 검수가 다시 시작되지 않았습니다. 이 작업을 어떻게 할지 명령창으로 메인 에이전트에게 말해 주세요 (예: "${t.id} 검수를 다시 진행해", "${t.id}는 취소해").`,
    );
    expect(n[0]!.link).toEqual({ tab: 'projects', projectId: e.projectId, directiveId: t.directiveId, taskId: t.id });
    expect(e.ctx.store.activity.search({ text: '멈춘 검수를 대표에게 알림', limit: 10 }).map((a) => a.taskId)).toEqual([t.id]);
    // 더 돌지 않는다
    const mainTurns = e.launches.filter((l) => l.workKey === mainKey(e.projectId)).length;
    await ticks(e, 12);
    expect(e.launches.filter((l) => l.workKey === mainKey(e.projectId))).toHaveLength(mainTurns);
    expect(stuckNotice(e, t)).toHaveLength(1);
  });

  it('메인 턴이 대상을 풀면(검수를 다시 등록) 다시 넣지 않고 대표에게 알리지 않는다', async () => {
    const e = (env = await bootOrch());
    const t = await handedToMain(e);
    const { p } = await nextMainTurn(e, '넘김을 실은 메인 턴');
    await e.tool(p.turnId, 'interrupt_task', { task_id: t.id, then: 'hold', reason: '판정을 직접 남기려고 검수를 다시 시작' });
    await e.tool(p.turnId, 'resume_task', { task_id: t.id, reason: '판정을 직접 남기려고 검수를 다시 시작' });
    expect(live(e).filter((q) => q.sessionKey === reviewKey(t.id) && q.kind === 'review').map((q) => q.memberId)).toEqual([MAIN_AGENT_ID]);
    await endTurn(e, p);
    expect(handOffs(e, t)).toEqual([]);
    expect(stuckNotice(e, t)).toEqual([]);
  });

  it('메인 턴 동안 그 작업에 검수자 재배정 업무가 생겼으면(처리할 수 있는 쪽의 업무) 다시 넣지 않는다', async () => {
    const e = (env = await bootOrch());
    const t = await handedToMain(e);
    const { p } = await nextMainTurn(e, '넘김을 실은 메인 턴');
    // 메인 에이전트의 지시로 프로듀서에게 재배정 업무가 다시 갔다 (같은 지시 세션 — 프로듀서 턴은 띄우지 않고 둔다)
    e.hold.add(directiveKey(t.directiveId));
    enqueue(e.ctx, { kind: 'reviewer_assign', memberId: e.producerId, sessionKey: directiveKey(t.directiveId), projectId: e.projectId, directiveId: t.directiveId, taskId: t.id, priority: 'high', message: `${t.id} 검수자를 QA로 다시 정하세요` });
    await endTurn(e, p);
    expect(handOffs(e, t)).toEqual([]);
    expect(stuckNotice(e, t)).toEqual([]);
    expect(workFor(e, t).reviewerAssign).toBe(1);
  });

  it('같은 메인 턴에 다른 지시의 보고서 요청이 함께 실려도 보고서 재촉은 그 요청의 지시와 횟수로 본다 (다시 넣은 넘김의 횟수에 끌려가지 않음)', async () => {
    const e = (env = await bootOrch());
    const key = mainKey(e.projectId);
    const d1 = seedDirective(e, '검수 멈춘 지시');
    const t = seedInReviewTask(e, MAIN_AGENT_ID, { outputMode: 'repo', directiveId: d1.id });
    const d2 = seedDirective(e, '보고 단계 지시');
    e.ctx.store.directives.put({ ...d2, state: 'reporting' });
    // 세 번째로 실리는 넘김(먼저 들어옴)과 처음 실리는 보고서 요청 — 다시 전달은 전달 횟수(deliveries)로 센다 (리드 결정 30)
    enqueue(e.ctx, { kind: 'message', memberId: MAIN_AGENT_ID, sessionKey: key, projectId: e.projectId, directiveId: d1.id, taskId: t.id, priority: 'high', deliveries: 2, message: `${t.id} 검수가 멈췄습니다` });
    await sleep(5);
    enqueue(e.ctx, { kind: 'main_report', memberId: MAIN_AGENT_ID, sessionKey: key, projectId: e.projectId, directiveId: d2.id, priority: 'high', message: `지시 ${d2.id}를 보고하세요` });
    e.hold.add(key);
    const { p, carried } = await nextMainTurn(e, '넘김과 보고서 요청을 실은 메인 턴');
    expect(carried.map((q) => [q.kind, q.deliveries ?? 0])).toEqual([
      ['message', 2],
      ['main_report', 0],
    ]);
    await endTurn(e, p);
    // 보고서 요청은 처음 실린 것이라 다시 넣는다 (예전: 턴의 지시가 넘김의 지시라 재촉을 빠뜨렸다)
    expect(live(e).filter((q) => q.kind === 'main_report').map((q) => [q.directiveId, q.deliveries, q.attempts])).toEqual([[d2.id, 1, 0]]);
    expect(e.ctx.store.notifications.list().filter((n) => n.key === `report-stuck:${d2.id}`)).toEqual([]);
    // 넘김은 세 번째였으니 대표에게 그 작업을 알린다
    expect(stuckNotice(e, t)).toHaveLength(1);
    expect(handOffs(e, t)).toEqual([]);
  });

  it('(b) 넘김을 실은 메인 턴이 비정상 종료 상한까지 끝나면 그 업무를 조용히 버리지 않고 대표에게 그 작업을 알린다', async () => {
    const e = (env = await bootOrch());
    const key = mainKey(e.projectId);
    e.script.set(key, (p) => p.exit(1));
    const t = await handedToMain(e, { holdMain: false });
    const crashes = () => e.ctx.store.turns.list().filter((x) => x.memberId === MAIN_AGENT_ID && x.sessionKind === 'main_project' && x.endReason === 'crashed').length;
    const limit = e.ctx.settings().execution.crashRetryMax;
    await waitFor(
      () => {
        e.tick();
        return crashes() > limit && stuckNotice(e, t).length > 0;
      },
      '메인 턴 비정상 종료 상한과 대표 알림',
      40_000,
    );
    await ticks(e, 10);
    expect(crashes()).toBe(limit + 1);
    expect(e.ctx.store.notifications.list().some((n) => n.title === '자동 복구 실패' && n.key === `crash:${key}`)).toBe(true);
    const n = stuckNotice(e, t);
    expect(n).toHaveLength(1);
    expect(n[0]!.body).toContain(`${t.id} "${t.title}" 검수가 멈춘 채 남아 있습니다 — 메인 에이전트의 턴이 비정상 종료로 반복해서 끝나 이 업무를 처리하지 못했습니다`);
    expect(n[0]!.body).toContain('명령창으로 메인 에이전트에게 말해 주세요');
    expect(workFor(e, t)).toEqual({ state: 'in_review', review: 0, reviewerAssign: 0, mainWork: 0 });
  });

  it('넘김을 실은 메인 턴이 시작 실패 상한에 닿으면 항목을 지우기 전에 대표에게 그 작업을 알린다', async () => {
    const e = (env = await bootOrch());
    const key = mainKey(e.projectId);
    let fails = 0;
    e.prepareHook = (_launch, who) => {
      if (who.sessionKey === key) {
        fails++;
        throw new Error('모델 이름을 쓸 수 없습니다');
      }
    };
    const t = await handedToMain(e, { holdMain: false });
    await waitFor(
      () => {
        e.tick();
        return fails >= 3 && stuckNotice(e, t).length > 0;
      },
      '메인 턴 시작 실패 3번과 대표 알림',
      40_000,
    );
    await sleep(50);
    expect(e.ctx.store.queue.list({ ref2: key }).filter((q) => q.taskId === t.id).map((q) => [q.state, q.startFails])).toEqual([['cancelled', 3]]);
    expect(e.ctx.store.notifications.list().some((n) => n.title === '업무 시작 실패' && n.key === `start-fail:${key}`)).toBe(true);
    expect(stuckNotice(e, t)[0]!.body).toContain('메인 에이전트의 턴이 3번 시작하지 못해 (모델 이름을 쓸 수 없습니다) 이 업무를 처리하지 못했습니다');
  });

  // 시험 빈틈 (리드 결정 34, tests-integrity 변이 N-spin): 헛돌기로 끝난 메인 턴도 넘김을 조용히 버리지 않는다
  it('넘김을 실은 메인 턴이 헛돌기로 끝나면 대표에게 그 작업을 알린다', async () => {
    const e = (env = await bootOrch());
    const key = mainKey(e.projectId);
    e.script.set(key, (p) => {
      for (let i = 0; i < 5; i++) p.emit({ kind: 'error', text: '같은 오류', data: {} });
    });
    const t = await handedToMain(e, { holdMain: false });
    await waitFor(
      () => {
        e.tick();
        return stuckNotice(e, t).length > 0;
      },
      '헛돈 메인 턴과 대표 알림',
      40_000,
    );
    await ticks(e, 5);
    expect(e.ctx.store.turns.list().filter((x) => x.memberId === MAIN_AGENT_ID && x.sessionKind === 'main_project').map((x) => x.endReason)).toEqual(['spin']);
    const n = stuckNotice(e, t);
    expect(n).toHaveLength(1);
    expect(n[0]!.body).toContain(`${t.id} "${t.title}" 검수가 멈춘 채 남아 있습니다 — 메인 에이전트의 턴이 헛돌아 이 업무를 처리하지 못했습니다`);
    expect(workFor(e, t)).toEqual({ state: 'in_review', review: 0, reviewerAssign: 0, mainWork: 0 });
  });

  // 시험 빈틈 (리드 결정 34, tests-integrity 변이 N-percall): CLI 안전 검사 거부 상한도 같다 — 넘김의 비정상 종료형 끝 횟수로 본다 (리드 결정 30)
  it('넘김을 실은 메인 턴이 CLI 안전 검사 거부 상한까지 끝나면 대표에게 그 작업을 알린다', async () => {
    const e = (env = await bootOrch({ mock: false }));
    const key = mainKey(e.projectId);
    e.script.set(key, (p) => {
      p.emit({ kind: 'session', text: 'init', data: { permissionMode: 'bypassPermissions' } });
      p.emit({ kind: 'error', text: 'rm -rf "$OUT"/* — 안전 검사 거부', data: { errorKind: 'permission' } });
    });
    const t = await handedToMain(e, { holdMain: false });
    await waitFor(
      () => {
        e.tick();
        return stuckNotice(e, t).length > 0;
      },
      'CLI 안전 검사 거부 상한과 대표 알림',
      40_000,
    );
    await ticks(e, 5);
    const limit = e.ctx.settings().execution.crashRetryMax;
    expect(e.ctx.store.turns.list().filter((x) => x.memberId === MAIN_AGENT_ID && x.sessionKind === 'main_project').map((x) => x.endReason)).toEqual(Array(limit + 1).fill('bypass_mismatch'));
    expect(stuckNotice(e, t).map((n) => n.body)).toEqual([expect.stringContaining('메인 에이전트의 턴이 CLI 안전 검사 거부로 반복해서 끝나 이 업무를 처리하지 못했습니다')]);
    expect(e.ctx.store.notifications.list().filter((n) => n.key === `crash:${key}`).map((n) => n.body)).toEqual([expect.stringContaining('CLI 안전 검사 거부가 반복됩니다')]);
    expect(workFor(e, t)).toEqual({ state: 'in_review', review: 0, reviewerAssign: 0, mainWork: 0 });
  });
});

describe('재시작 복구 3)은 검수가 넘어간 작업에 검수를 다시 등록하지 않는다 (리드 결정 24)', () => {
  it('넘김 업무·검수자 재배정(합쳐 둔 옛 항목의 글에만 있는 작업 포함)이 기다리는 작업은 그대로 두고, 할 일이 없는 작업만 검수를 다시 등록한다', async () => {
    let e = (renv = await bootRestartable({ holdAll: true }));
    const d = seedRestartDirective(e);
    const seed = (title: string) => seedRestartReview(e, { directiveId: d.id, assigneeId: e.devId, reviewerId: e.qaId, title });
    const handed = seed('메인에게 넘김');
    const assigning = seed('재배정 대기');
    const merged = seed('합쳐 둔 재배정의 둘째 작업');
    const lost = seed('잃은 검수');
    enqueue(e.ctx, { kind: 'message', memberId: MAIN_AGENT_ID, sessionKey: mainKey(e.projectId), projectId: e.projectId, directiveId: d.id, taskId: handed.id, priority: 'high', message: `${handed.id} 검수가 멈췄습니다` });
    // 1단계 전 코드가 합쳐 둔 재배정 항목: taskId는 첫 작업, 둘째 작업은 글에만
    enqueue(e.ctx, {
      kind: 'reviewer_assign',
      memberId: e.producerId,
      sessionKey: directiveKey(d.id),
      projectId: e.projectId,
      directiveId: d.id,
      taskId: assigning.id,
      message: `${assigning.id} 검수 결과가 반복해서 등록되지 않았습니다.\n\n${merged.id} 검수 결과가 반복해서 등록되지 않았습니다.`,
    });
    const reviewOf = (x: RestartableEnv, id: string) => x.ctx.store.queue.list({ ref2: reviewKey(id), state: ['queued', 'running'] }).filter((q: QueueEntry) => q.kind === 'review');
    e.crash();
    e = renv = await e.reboot();
    // 넘어간 작업 셋에는 검수를 다시 등록하지 않는다 — 넘긴 업무는 그대로
    expect([handed, assigning, merged].map((t) => reviewOf(e, t.id).length)).toEqual([0, 0, 0]);
    expect(e.ctx.store.queue.list({ state: ['queued', 'running'] }).filter((q) => q.taskId === handed.id && q.memberId === MAIN_AGENT_ID)).toHaveLength(1);
    expect(e.ctx.store.queue.list({ state: ['queued', 'running'] }).filter((q) => q.kind === 'reviewer_assign')).toHaveLength(1);
    // 할 일이 없던 작업만 안전망이 다시 등록한다 (리드 결정 18)
    expect(reviewOf(e, lost.id).map((q) => q.memberId)).toEqual([e.qaId]);
    // 다시 재시작해도 같다
    e.crash();
    e = renv = await e.reboot();
    expect([handed, assigning, merged, lost].map((t) => reviewOf(e, t.id).length)).toEqual([0, 0, 0, 1]);
  });
});
