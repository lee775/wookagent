/**
 * 화면 약속의 새 칸 (리드 결정 41, 10-30 — S1F8 알아 둘 것 4, S1F10 화면 후속):
 * - NotificationView.key: 알림 종류 key를 저장된 알림 그대로 보인다(없으면 null). 화면은 앞부분(usage:·review-stuck:·handoff-stuck:·pause-stuck:·crash:·
 *   start-fail:·spin: 등)으로 종류를 가린다 — 결정 36의 버림마다 key(crash:<세션>:<항목>)도 앞말은 그대로다. 실시간 알림(notification 주제)에도 같은 key가 간다
 * - OwnerTodo error.reachesMain: 그 보류로 메인 에이전트에게 업무가 가는지. 검수자 없음 보류(refId no_reviewer)는 그 넘김이, 다른 오류 보류와 병합 보류는
 *   그 보류의 알림 업무(alert, 5단계 S5b — 리드 결정 S5-7)가 살아 있을 때만 true. 알림 업무가 없는 보류(손으로 건 보류·예전 보류)와 버린 알림은 false —
 *   화면이 메인이 모르는 보류를 '메인 에이전트가 처리 중'이라고 쓰지 않게. recovery_check의 reachesMain도 그 복구 확인의 알림 업무로 본다
 * - 검수 멈춤 알림(review-stuck:<작업>:<검수자>)의 링크는 작업 ID를 싣는다 — 화면이 그 작업으로 가고 명령창 초안을 그 작업으로 채운다
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID, type QueueEntry } from '@shared/domain';
import type { NotificationView } from '@shared/views';
import { directiveKey, mainKey } from '../../src/main/orchestrator/records';
import { alertTaskHold } from '../../src/main/orchestrator/alerts';
import type { OrchEnv } from './orchHarness';
import { bootOrch, seedDirective, seedInReviewTask, sleep, waitFor } from './orchHarness';

let env: OrchEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

describe('알림 보기의 key (리드 결정 41)', () => {
  it('notifications.list와 실시간 알림이 저장된 key를 그대로 보인다 — 버림마다 key도, key 없는 알림은 null', async () => {
    const e = (env = await bootOrch());
    const pushed: NotificationView[] = [];
    e.orch.backend.onTopic('notification', (n) => pushed.push(n));
    const key = mainKey(e.projectId);
    e.script.set(key, (p) => p.exit(1));
    await e.invoke('command.send', { target: e.projectId, text: '배포 체크리스트 정리해 줘' });
    await waitFor(
      () => {
        e.tick();
        return e.ctx.store.notifications.list().some((n) => n.title === '자동 복구 실패');
      },
      '비정상 종료 상한',
      40_000,
    );
    await sleep(50);
    const dropped = e.ctx.store.queue.list().filter((q: QueueEntry) => q.kind === 'main_command').at(-1)!;
    // key 없는 알림
    e.ctx.notify({ level: 'normal', title: '되돌리기 보류', body: 'T-9999 되돌리기가 보류됐습니다 (시험)' });
    const list = await e.invoke('notifications.list', { limit: 50 });
    const crash = list.find((n) => n.title === '자동 복구 실패')!;
    expect(crash.key).toBe(`crash:${key}:${dropped.id}`);
    expect(crash.key!.startsWith('crash:')).toBe(true);
    expect(list.find((n) => n.title === '되돌리기 보류')!.key).toBeNull();
    // 저장된 알림과 하나하나 같다
    for (const n of list) expect(n.key).toBe(e.ctx.store.notifications.require(n.id).key);
    // 실시간 알림(바탕화면 알림 제목을 key로 정한다)에도 같은 key
    expect(pushed.filter((n) => n.title === '자동 복구 실패').map((n) => n.key)).toEqual([`crash:${key}:${dropped.id}`]);
    expect(pushed.filter((n) => n.title === '되돌리기 보류').map((n) => n.key)).toEqual([null]);
  });
});

describe('대표 할 일 error의 reachesMain (리드 결정 41)', () => {
  it('검수자 없음 보류만 메인 에이전트에게 간다(true) — 다른 오류 보류와 병합 보류는 false', async () => {
    const e = (env = await bootOrch());
    await e.internal('members.remove', e.qaId);
    const d = seedDirective(e);
    // 검수자 없음: 적격 팀원이 없고 메인 에이전트도 기여자 → 보류(refId no_reviewer) + 메인 업무
    const noReviewer = seedInReviewTask(e, MAIN_AGENT_ID, { outputMode: 'repo', directiveId: d.id });
    e.ctx.store.tasks.patch(noReviewer.id, { assigneeId: e.producerId, contributors: [e.producerId, MAIN_AGENT_ID] });
    e.core.tasks.dispatchReview(e.ctx.store.tasks.require(noReviewer.id));
    expect(e.ctx.store.queue.list({ ref2: mainKey(e.projectId), state: 'queued' }).filter((q) => q.kind === 'no_reviewer').map((q) => q.taskId)).toEqual([noReviewer.id]);
    // 메인 업무가 없는 오류 보류(시작 실패 상한 등)와 병합 보류
    const failed = seedInReviewTask(e, MAIN_AGENT_ID, { outputMode: 'repo', directiveId: d.id });
    e.core.tasks.hold(failed.id, 'error', 'task', '턴 시작 3회 실패: 모델 이름을 찾을 수 없습니다 (시험)', 'system');
    const blocked = seedInReviewTask(e, MAIN_AGENT_ID, { outputMode: 'repo', directiveId: d.id });
    e.core.tasks.hold(blocked.id, 'merge_blocked', 'task', '프로젝트 폴더에 커밋되지 않은 변경이 있음 (시험)', 'system');
    const todos = (await e.invoke('snapshot.get')).ownerTodos.flatMap((x) => (x.kind === 'error' ? [[x.id, x.taskId, x.reachesMain]] : []));
    expect(todos.sort()).toEqual(
      [
        [`error:${noReviewer.id}`, noReviewer.id, true],
        [`error:${failed.id}`, failed.id, false],
        [`merge:${blocked.id}`, blocked.id, false],
      ].sort(),
    );
  });
});

describe('보류의 알림 업무가 reachesMain을 정한다 (리드 결정 S5-7·S5-3 — holdReach 한 판정)', () => {
  it('알림 업무가 살아 있으면 오류·병합 보류·복구 확인이 true, 버리면 false — 작업 화면의 보류 사유도 같은 값, 앞선 보류에서 받아 마친 알림은 지금 보류의 것이 아니다', async () => {
    const e = (env = await bootOrch());
    const d = seedDirective(e);
    const failed = seedInReviewTask(e, MAIN_AGENT_ID, { outputMode: 'repo', directiveId: d.id });
    const blocked = seedInReviewTask(e, MAIN_AGENT_ID, { outputMode: 'repo', directiveId: d.id });
    // 진짜 넣는 곳(보류 뒤 알림): 되돌리기 처리 실패·병합 실패
    (e.core.merges as unknown as { revertFailed(id: string, err: unknown): void }).revertFailed(failed.id, new Error('시험 오류'));
    (e.core.merges as unknown as { mergeFailed(id: string, err: unknown): void }).mergeFailed(blocked.id, new Error('git 오류 (시험)'));
    // 작업 없는 복구 확인
    e.ctx.store.execs.insert({ requestId: 'X-3001', kind: 'deploy', projectId: e.projectId, taskId: null, cwd: e.projectDir, command: '배포', target: '배포', state: 'unknown', startedAt: e.ctx.now(), endedAt: e.ctx.now(), result: {} });
    (e.core.recovery as unknown as { holdForRecovery(x: unknown, note: string): number }).holdForRecovery(e.ctx.store.execs.require('X-3001'), '시험');
    const reach = async () => {
      const snap = await e.invoke('snapshot.get');
      return {
        todos: snap.ownerTodos.flatMap((x) => (x.kind === 'error' ? [[x.id, x.reachesMain]] : x.kind === 'recovery_check' ? [[x.id, x.reachesMain]] : [])).sort(),
        views: [failed.id, blocked.id].map((id) => e.core.views.taskView(e.ctx.store.tasks.require(id)).hold!.reasons.map((r) => r.reachesMain)),
      };
    };
    expect(await reach()).toEqual({
      todos: [
        [`error:${failed.id}`, true],
        [`merge:${blocked.id}`, true],
        ['recovery:X-3001', true],
      ].sort(),
      views: [[true], [true]],
    });
    // 상한에서 버린 알림(취소) → false
    const mainQueue = () => e.ctx.store.queue.list({ ref1: MAIN_AGENT_ID }).filter((q) => q.kind === 'alert');
    for (const q of mainQueue()) e.ctx.store.queue.put({ ...q, state: 'cancelled', doneAt: e.ctx.now() });
    expect(await reach()).toEqual({
      todos: [
        [`error:${failed.id}`, false],
        [`merge:${blocked.id}`, false],
        ['recovery:X-3001', false],
      ].sort(),
      views: [[false], [false]],
    });
  });

  it('받아 마친 알림은 그 보류에서만 true — 보류가 풀리고 알림 없이 다시 걸린 보류는 false', async () => {
    const e = (env = await bootOrch());
    const t = seedInReviewTask(e, MAIN_AGENT_ID, { outputMode: 'repo' });
    (e.core.merges as unknown as { revertFailed(id: string, err: unknown): void }).revertFailed(t.id, new Error('시험 오류'));
    const q = e.ctx.store.queue.list({ ref1: MAIN_AGENT_ID }).find((x) => x.kind === 'alert')!;
    e.ctx.store.queue.put({ ...q, state: 'done', doneAt: e.ctx.now() });
    const todo = async () => (await e.invoke('snapshot.get')).ownerTodos.flatMap((x) => (x.kind === 'error' && x.taskId === t.id ? [x.reachesMain] : []));
    expect(await todo()).toEqual([true]);
    await e.main('resume_task', { task_id: t.id });
    await sleep(5);
    e.core.tasks.hold(t.id, 'error', 'task', '손으로 건 보류 (시험)', 'system');
    expect(await todo()).toEqual([false]);
  });

  it('보류 사유마다 그 사유의 알림 키로 본다 — 종료 확인 실패 알림이 살아 있어도 같은 작업의 알림 없는 병합 보류는 메인에게 가 있지 않다 (리드 결정 S5-28)', async () => {
    const e = (env = await bootOrch());
    const d = seedDirective(e);
    const t = e.core.tasks.create({ directiveId: d.id, title: '로그인 화면', goal: '로그인 화면', type: 'development', assigneeId: e.devId, acceptanceCriteria: ['동작한다'], outputMode: 'repo', prerequisiteIds: [] }, e.producerId);
    e.core.tasks.hold(t.id, 'error', 'task', '턴 종료 뒤 하위 프로세스 1개가 남았습니다 (종료 확인 실패).', 'system');
    expect(alertTaskHold(e.ctx, 'kill-failed', t.id, { cause: '시험' })).not.toBeNull();
    e.core.tasks.hold(t.id, 'merge_blocked', 'task', '병합 보류 (시험, 알림 없음)', 'system');
    expect(e.core.views.taskView(e.ctx.store.tasks.require(t.id)).hold!.reasons.map((r) => [r.kind, r.reachesMain])).toEqual([
      ['error', true],
      ['merge_blocked', false],
    ]);
    const todos = (await e.invoke('snapshot.get')).ownerTodos.flatMap((x) => (x.kind === 'error' && x.taskId === t.id ? [[x.id, x.reachesMain]] : []));
    expect(todos.sort()).toEqual(
      [
        [`error:${t.id}`, true],
        [`merge:${t.id}`, false],
      ].sort(),
    );
  });
});

describe('검수 멈춤 알림의 링크는 작업을 가리킨다 (리드 결정 41)', () => {
  it('같은 검수자로 다시 등록한 검수도 판정 없이 끝나 메인에게 넘기면(검수 멈춤) 링크에 프로젝트·지시·작업이 있다', async () => {
    const e = (env = await bootOrch());
    const d = seedDirective(e);
    const t = seedInReviewTask(e, e.qaId, { outputMode: 'repo', directiveId: d.id });
    e.hold.add(mainKey(e.projectId));
    e.script.set(directiveKey(d.id), (p) => {
      void e.tool(p.turnId, 'assign_reviewer', { task_id: t.id, reviewer_id: e.qaId }).finally(() => p.finishOk());
    });
    e.core.tasks.dispatchReview(e.ctx.store.tasks.require(t.id));
    await waitFor(
      () => {
        e.tick();
        return e.ctx.store.notifications.list().some((n) => n.key === `review-stuck:${t.id}:${e.qaId}`);
      },
      '검수 멈춤 알림',
      40_000,
    );
    const n = (await e.invoke('notifications.list', { limit: 50 })).find((x) => x.key === `review-stuck:${t.id}:${e.qaId}`)!;
    expect([n.title, n.link]).toEqual(['검수 멈춤', { tab: 'projects', projectId: e.projectId, directiveId: d.id, taskId: t.id }]);
  });

  it('프로듀서가 검수자를 다시 정하지 않아 메인에게 넘겨도(프로듀서 처리 지연) 링크에 작업이 있다', async () => {
    const e = (env = await bootOrch());
    await e.internal('members.remove', e.qaId);
    const d = seedDirective(e);
    const t = seedInReviewTask(e, MAIN_AGENT_ID, { outputMode: 'repo', directiveId: d.id });
    e.ctx.store.tasks.patch(t.id, { assigneeId: e.producerId, contributors: [e.producerId] });
    e.hold.add(mainKey(e.projectId));
    // 프로듀서 턴은 세 번 시작하지 못한다 → 재배정 업무를 버리기 전에 메인에게 넘긴다
    e.prepareHook = (_launch, who) => {
      if (who.sessionKey === directiveKey(d.id)) throw new Error('모델 이름을 쓸 수 없습니다 (시험)');
    };
    e.core.tasks.dispatchReview(e.ctx.store.tasks.require(t.id));
    await waitFor(
      () => {
        e.tick();
        return e.ctx.store.notifications.list().some((n) => n.key === `review-stuck:${t.id}:${MAIN_AGENT_ID}`);
      },
      '프로듀서 처리 지연 알림',
      40_000,
    );
    const n = (await e.invoke('notifications.list', { limit: 50 })).find((x) => x.key === `review-stuck:${t.id}:${MAIN_AGENT_ID}`)!;
    expect([n.title, n.link]).toEqual(['프로듀서 처리 지연', { tab: 'projects', projectId: e.projectId, directiveId: d.id, taskId: t.id }]);
  });
});
