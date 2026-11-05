/**
 * 지시 전체 취소 (5.3 지시 상태표 '미완료 하위 작업만 취소, 완료 결과는 유지', TSK-09, CTL-08, AC-46).
 * - 취소 선택을 먼저 저장한다: 취소가 끝나기 전에 도착한 프로듀서 요청(작업 만들기·고치기·재계획)은 저장된 상태로 거부된다
 * - 처리하는 동안 저장된 작업까지 남지 않을 때까지 취소한다 (목록을 다시 읽음)
 * - 앱이 지시 취소 도중에 꺼지면 재시작 복구가 남은 작업을 마저 취소한다
 * - 지시가 취소된 뒤에는 그 지시의 작업이 시작·실행·병합되지 않는다 (아직 그 작업 차례가 오지 않았어도) — 별도 되돌리기는 예외
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Task } from '@shared/domain';
import { MAIN_AGENT_ID } from '@shared/domain';
import { emptyReviewState } from '@core/taskMachine';
import type { Env } from './helpers';
import { activate, boot, consumeMergeDecisions, mainSha, mergeAndSettle, newDirective, newTask, passedTask, queued, settleMainReview, waitFor } from './helpers';
import { bootOrch, seedDirective, type OrchEnv } from './orchHarness';
import { gate, git, restartServices, sleep } from '../acceptance/git-helpers';
import { directiveKey, enqueue, taskKey, transitionDirective } from '../../src/main/orchestrator/records';

let env: Env | null = null;
let orch: OrchEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
  await orch?.close();
  orch = null;
});

const stateOf = (e: Env, id: string) => e.ctx.store.tasks.require(id).state;
const directiveWork = (e: Env, did: string) => queued(e, (q) => q.directiveId === did || q.sessionKey === directiveKey(did));

describe('지시 전체 취소 (TSK-09, AC-46)', () => {
  it('취소 선택을 먼저 저장해 처리 중에 온 작업 만들기·고치기·재계획을 거부하고, 처리하는 동안 저장된 작업과 선행 취소 후속 작업까지 남김없이 취소한다', async () => {
    env = await boot({ team: ['developer', 'developer'] });
    const e = env;
    const [m1, m2] = e.members as [Env['members'][number], Env['members'][number]];
    const did = newDirective(e, '취소할 지시');
    const running = await activate(e, newTask(e, { directiveId: did, assignee: m1, title: '진행 중' }).id);
    const follower = newTask(e, { directiveId: did, assignee: m2, title: '후속', prerequisiteIds: [running.id] });
    // 취소가 진행 중 작업을 보관하는 동안, 그 전에 받아 둔 요청이 작업을 저장한 경우 (처음 목록에 없는 작업)
    let late: Task | null = null;
    const archive = e.core.tasks.archiveWorkspace.bind(e.core.tasks);
    e.core.tasks.archiveWorkspace = async (t, why) => {
      if (!late) {
        const now = e.ctx.now();
        late = { ...e.ctx.store.tasks.require(follower.id), id: e.ctx.store.nextId('task'), title: '처리 중 저장된 작업', prerequisiteIds: [], state: 'waiting', hold: { reasons: [], returnState: null }, review: emptyReviewState(), createdAt: now, updatedAt: now, queuedAt: now };
        e.ctx.store.tasks.insert(late);
      }
      return archive(t, why);
    };

    const cancelling = e.core.directives.cancel(did, MAIN_AGENT_ID);
    // 선택은 첫 await 전에 저장된다 (CTL-08) — 이 뒤에 처리되는 요청은 저장된 상태로 거부
    expect(e.ctx.store.directives.require(did).state).toBe('cancelled');
    expect(() => newTask(e, { directiveId: did, assignee: m2, title: '취소 중에 온 작업' })).toThrow(/작업을 추가할 수 없는/);
    expect(() => e.core.tasks.update(follower.id, { priority: 'high' }, e.producer.id)).toThrow(/취소·종료/);
    await cancelling;

    expect(late).not.toBeNull();
    for (const id of [running.id, follower.id, late!.id]) expect(stateOf(e, id), id).toBe('cancelled');
    expect(e.ctx.store.tasks.list({ ref1: did }).filter((t) => t.state !== 'cancelled')).toEqual([]);
    expect(directiveWork(e, did)).toEqual([]);
    expect(git(e.projectDir, ['rev-parse', '--verify', `refs/wook/archive/${running.id}-cancel`])).toMatch(/^[0-9a-f]{40}$/);
  });

  it('지시 취소 도중에 앱이 꺼지면 재시작 복구가 남은 미완료 작업을 마저 취소한다 (지시는 이미 취소 상태로 저장됨)', async () => {
    env = await boot({ team: ['developer', 'developer'] });
    let e = env;
    const [m1, m2] = e.members as [Env['members'][number], Env['members'][number]];
    const did = newDirective(e, '끊길 지시 취소');
    const first = await activate(e, newTask(e, { directiveId: did, assignee: m1, title: '먼저 취소될 작업' }).id);
    const second = newTask(e, { directiveId: did, assignee: m2, title: '아직 차례가 오지 않은 작업' });
    // 첫 작업의 중간 결과를 보관하는 중에 앱이 꺼진다
    let reached = false;
    e.core.tasks.archiveWorkspace = async () => {
      reached = true;
      return new Promise<never>(() => undefined);
    };
    void e.core.directives.cancel(did, MAIN_AGENT_ID);
    await waitFor(() => reached, '보관 시작');
    await sleep(30);
    expect(e.ctx.store.directives.require(did).state).toBe('cancelled');
    expect(stateOf(e, second.id)).toBe('waiting');

    e = env = await restartServices(e);
    expect(e.ctx.store.directives.require(did).state).toBe('cancelled');
    expect([stateOf(e, first.id), stateOf(e, second.id)]).toEqual(['cancelled', 'cancelled']);
    expect(directiveWork(e, did)).toEqual([]);
    expect(git(e.projectDir, ['rev-parse', '--verify', `refs/wook/archive/${first.id}-cancel`])).toMatch(/^[0-9a-f]{40}$/);
    // 한 번 더 시작해도 할 일이 없다 (멱등)
    e = env = await restartServices(e);
    expect(e.ctx.store.tasks.list({ ref1: did }).map((t) => t.state)).toEqual(['cancelled', 'cancelled']);
  });

  it('지시가 취소 상태로 저장된 뒤에는 아직 취소 차례가 오지 않은 작업도 병합되지 않는다 — 기다리던 병합은 main을 바꾸지 않고, 병합 요청·병합 판단도 받지 않으며, 지시 취소를 다시 하면 마저 취소된다', async () => {
    env = await boot({ team: ['developer'] });
    const e = env;
    const did = newDirective(e, '병합 대기 중 취소');
    const p = await passedTask(e, { directiveId: did, reviewer: 'main', file: 'p.txt', content: 'P\n', title: '병합 대기' });
    consumeMergeDecisions(e, p.id); // 프로듀서 턴이 병합 판단을 받아 request_merge를 보낸다
    const before = mainSha(e);
    // 병합이 잠금 뒤에서 기다리는 동안 지시 취소 선택이 저장된다 (작업 취소는 아직)
    const g = gate();
    void e.core.locks.run(e.project.id, '시험 잠금', () => g.promise);
    expect(e.core.merges.requestMerge(p.id, e.producer, null)).toEqual({ status: 'queued' });
    transitionDirective(e.ctx, did, { type: 'cancel', reason: '시험: 취소 선택 저장' }, MAIN_AGENT_ID);
    g.release();
    await waitFor(() => !e.core.merges.isPending(p.id), '병합 처리');
    expect(mainSha(e)).toBe(before);
    expect(e.ctx.store.tasks.require(p.id)).toMatchObject({ state: 'in_review', merge: null });
    expect(() => e.core.merges.requestMerge(p.id, e.producer, null)).toThrow(/취소·종료/);
    e.core.merges.queueMergeDecision(e.ctx.store.tasks.require(p.id));
    expect(queued(e, (q) => q.kind === 'merge_decision' && q.taskId === p.id)).toEqual([]);
    // 끊긴 지시 취소를 다시 부르면(재시작 복구와 같은 길) 남은 작업만 취소한다
    await e.core.directives.cancel(did, MAIN_AGENT_ID);
    expect(stateOf(e, p.id)).toBe('cancelled');
    expect(mainSha(e)).toBe(before);
  });

  it('지시 취소 전에 이미 있던 되돌리기 작업은 그 지시의 미완료 하위 작업으로 함께 취소되고 main에 넣지 않는다 (완료 결과 유지)', async () => {
    env = await boot({ team: ['developer'] });
    const e = env;
    const did = newDirective(e, '되돌리기 진행 중 취소');
    const done = await passedTask(e, { directiveId: did, reviewer: 'main', file: 'k.txt', content: 'K\n', title: '완료될 작업' });
    expect((await mergeAndSettle(e, done.id)).state).toBe('done');
    const r = await e.core.merges.requestRevert(done.id, e.producer, '되돌리기');
    const rt = r.revertTaskId!;
    await waitFor(() => stateOf(e, rt) === 'in_review' && !e.core.tasks.isSubmitting(rt), '되돌리기 검수');
    e.core.tasks.submitReview(rt, e.ctx.store.members.require(MAIN_AGENT_ID), { verdict: 'pass', criteria: e.ctx.store.tasks.require(rt).acceptanceCriteria.map((c) => ({ criterion: c, pass: true, note: '확인' })), reason: '' }, null);
    settleMainReview(e, rt); // 메인 검수 턴의 마무리 (병합 판단 등록)
    consumeMergeDecisions(e, rt);
    const before = mainSha(e);
    // 지시 취소 선택이 저장된 뒤에는 그 되돌리기도 병합하지 않는다
    transitionDirective(e.ctx, did, { type: 'cancel', reason: '시험: 취소 선택 저장' }, MAIN_AGENT_ID);
    expect(() => e.core.merges.requestMerge(rt, e.producer, null)).toThrow(/취소·종료/);
    await e.core.directives.cancel(did, MAIN_AGENT_ID);
    expect(stateOf(e, rt)).toBe('cancelled');
    expect(stateOf(e, done.id)).toBe('done');
    expect(mainSha(e)).toBe(before);
    expect(git(e.projectDir, ['show', `refs/heads/${e.project.baseBranch}:k.txt`])).toBe('K');
  });

  it('취소된 지시의 완료 작업을 되돌리는 별도 되돌리기는 지시 취소를 다시 해도(재시작 마무리) 취소되지 않고 끝까지 간다', async () => {
    env = await boot({ team: ['developer'] });
    const e = env;
    const did = newDirective(e, '되돌릴 지시');
    const done = await passedTask(e, { directiveId: did, reviewer: 'main', file: 'd.txt', content: 'D\n', title: '완료될 작업' });
    expect((await mergeAndSettle(e, done.id)).state).toBe('done');
    const left = newTask(e, { directiveId: did, title: '남은 작업' });
    await e.core.directives.cancel(did, MAIN_AGENT_ID);
    expect(stateOf(e, left.id)).toBe('cancelled');
    const r = await e.core.merges.requestRevert(done.id, e.producer, '취소된 지시의 변경 되돌리기');
    const rt = r.revertTaskId!;
    await waitFor(() => stateOf(e, rt) === 'in_review' && !e.core.tasks.isSubmitting(rt), '되돌리기 검수');
    // 지시 취소를 다시 불러도(재시작 복구의 마무리와 같은 길) 별도 되돌리기와 그 업무는 남는다
    await e.core.directives.cancel(did, MAIN_AGENT_ID);
    expect(stateOf(e, rt)).toBe('in_review');
    e.core.tasks.submitReview(rt, e.ctx.store.members.require(MAIN_AGENT_ID), { verdict: 'pass', criteria: e.ctx.store.tasks.require(rt).acceptanceCriteria.map((c) => ({ criterion: c, pass: true, note: '확인' })), reason: '' }, null);
    settleMainReview(e, rt); // 메인 검수 턴의 마무리 (병합 판단 등록)
    expect(queued(e, (q) => q.kind === 'merge_decision' && q.taskId === rt)).toHaveLength(1);
    expect((await mergeAndSettle(e, rt)).state).toBe('done');
    expect(() => git(e.projectDir, ['show', `refs/heads/${e.project.baseBranch}:d.txt`])).toThrow();
  });
});

describe('스케줄러와 취소된 지시 (TSK-09 예약된 턴 취소, AC-46)', () => {
  it('취소 상태로 저장된 지시의 대기 작업은 활성화하지 않고, 그 지시 세션·작업 세션의 대기 업무는 실행하지 않고 지운다', async () => {
    orch = await bootOrch();
    const o = orch;
    const ctx = o.ctx;
    const d = seedDirective(o, '스케줄러 취소 지시');
    const waiting = o.core.tasks.create({ directiveId: d.id, title: '대기 작업', goal: '대기', type: 'development', assigneeId: o.devId, acceptanceCriteria: ['동작한다'], outputMode: 'repo' }, o.producerId);
    enqueue(ctx, { kind: 'message', memberId: o.producerId, sessionKey: directiveKey(d.id), projectId: o.projectId, directiveId: d.id, message: '작업을 더 나눠 주세요' });
    transitionDirective(ctx, d.id, { type: 'cancel', reason: '시험: 취소 선택 저장' }, MAIN_AGENT_ID);
    o.tick();
    await o.idle();
    expect(o.launches.filter((l) => l.workKey === taskKey(waiting.id) || l.workKey === directiveKey(d.id))).toEqual([]);
    expect(ctx.store.tasks.require(waiting.id)).toMatchObject({ state: 'waiting', activatedAt: null, workspace: null });
    expect(ctx.store.queue.list({ state: 'queued' }).filter((q) => q.sessionKey === directiveKey(d.id))).toEqual([]);
    expect(ctx.store.queue.list({}).filter((q) => q.sessionKey === directiveKey(d.id)).map((q) => q.state)).toEqual(['cancelled']);
    // 지시 취소를 마치면 남은 작업도 취소된다
    await o.main('cancel_directive', { directive_id: d.id });
    expect(ctx.store.tasks.require(waiting.id).state).toBe('cancelled');
    await sleep(20);
  });
});
