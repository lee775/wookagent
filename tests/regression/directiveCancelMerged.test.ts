/**
 * 지시 전체 취소와 끝나지 않은 완료 결과 (5.3 '미완료 지시 → 취소: 미완료 하위 작업만 취소, 완료 결과는 유지', TSK-09, CTL-10, AC-46).
 * - main에 병합이 반영된 뒤 보류된 작업(병합 도중 긴급 정지)은 지시를 취소해도 완료 결과다: 대표가 재개하면 다시 병합하지 않고 완료되고,
 *   취소 안내와 재개 안내가 같은 길을 가리킨다
 * - 지시 취소가 병합과 겹쳐 '취소 보류'만 남긴 채 앱이 꺼져도 재시작 복구가 그 보류를 풀어 다시 병합하지 않고 완료로 수렴한다
 * - 지시 취소 선택이 저장된 뒤 늦게 온 산출물형 작업의 검수 통과는 확정·완료·진행 되돌림으로 가지 않고, 그 작업은 지시 취소가 취소한다
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Task } from '@shared/domain';
import { MAIN_AGENT_ID, OWNER } from '@shared/domain';
import { CANCEL_HOLD_REF } from '@core/taskMachine';
import type { Env } from './helpers';
import { activate, boot, consumeMergeDecisions, mainSha, mergeCommitsFor, newDirective, newTask, notices, pass, passedTask, sleep, waitFor } from './helpers';
import { gate, restartServices } from '../acceptance/git-helpers';
import { artifactVersionDir, artifactWorkDir } from '../../src/main/orchestrator/paths';
import { enqueue, taskKey, transitionDirective } from '../../src/main/orchestrator/records';

let env: Env | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const kinds = (t: Task) => t.hold.reasons.map((r) => r.kind);

describe('지시 취소 뒤에도 main에 반영된 작업은 완료 결과로 마무리된다 (5.3, AC-46, CTL-10)', () => {
  it('병합이 main에 반영된 직후 긴급 정지로 보류된 작업은 지시를 취소해도 남고, 메인 에이전트가 재개하면 다시 병합하지 않고 완료된다 — 취소 안내도 재개를 가리킨다', async () => {
    env = await boot({ team: ['developer'] });
    const e = env;
    const did = newDirective(e, '병합 중 긴급 정지 후 지시 취소');
    const p = await passedTask(e, { directiveId: did, reviewer: 'main', file: 'p.txt', content: 'P\n', title: '병합될 작업' });
    consumeMergeDecisions(e, p.id);
    const g = e.ctx.deps.git;
    const orig = g.mergeIntoBase.bind(g);
    let stopped = false;
    g.mergeIntoBase = async (dir, o) => {
      // main을 바꾸는 git 호출이 이미 시작된 뒤 대표가 긴급 정지를 누른다 (정지 값 저장·작업 보류는 동기)
      if (!stopped) {
        stopped = true;
        void e.core.stops.emergency(OWNER);
      }
      return orig(dir, o);
    };
    const before = mainSha(e);
    e.core.merges.requestMerge(p.id, e.producer, null);
    await waitFor(() => !e.core.merges.isPending(p.id), '병합 처리');
    await sleep(50);
    const merged = mainSha(e);
    expect(merged).not.toBe(before);
    expect(e.ctx.store.tasks.require(p.id)).toMatchObject({ state: 'on_hold', merge: { mergeCommitSha: merged } });
    e.core.stops.release(OWNER);

    await e.core.directives.cancel(did, MAIN_AGENT_ID);
    // 완료 결과는 지시 취소가 취소하지 않는다 — 대표의 항목별 재개를 기다린다 (CTL-10)
    const held = e.ctx.store.tasks.require(p.id);
    expect(held.state).toBe('on_hold');
    expect(kinds(held)).toEqual(['emergency_stop']);
    expect(notices(e, '지시 취소').map((n) => n.body).join(' ')).toContain(`${p.id}(보류)`);
    // 취소 안내는 재개하면 완료된다고 알린다 — 재개를 거부하던 안내와 어긋나지 않는다
    await expect(e.core.tasks.cancel(p.id, '대표 취소', MAIN_AGENT_ID)).rejects.toThrow(/재개하면 다시 병합하지 않고 완료/);

    e.core.tasks.resumeByOwner(p.id, MAIN_AGENT_ID);
    await waitFor(() => e.ctx.store.tasks.require(p.id).state === 'done', '재개 뒤 완료');
    expect(mainSha(e)).toBe(merged); // 다시 병합하지 않는다
    expect(mergeCommitsFor(e, p.id)).toBe(1);
    expect(e.ctx.store.directives.require(did).state).toBe('cancelled');
    // 재시작해도 그대로다 (완료 뒤 정리가 끝난 뒤)
    await sleep(200);
    const r = (env = await restartServices(e));
    expect(r.ctx.store.tasks.require(p.id).state).toBe('done');
    expect(mainSha(r)).toBe(merged);
  });

  it('지시 취소가 진행 중인 병합과 겹쳐 main 반영 뒤 취소 보류만 남긴 채 앱이 꺼지면, 재시작 복구가 그 보류를 풀어 다시 병합하지 않고 완료한다 (두 번 시작해도 같다)', async () => {
    env = await boot({ team: ['developer'] });
    let e = env;
    const did = newDirective(e, '병합 중 지시 취소');
    const p = await passedTask(e, { directiveId: did, reviewer: 'main', file: 'q.txt', content: 'Q\n', title: '병합될 작업' });
    consumeMergeDecisions(e, p.id);
    const g = e.ctx.deps.git;
    const orig = g.mergeIntoBase.bind(g);
    let applied = false;
    g.mergeIntoBase = async (dir, o) => {
      await orig(dir, o); // main에 반영됨
      applied = true;
      return new Promise<never>(() => undefined); // 기록하기 전에 앱이 꺼진다
    };
    const before = mainSha(e);
    e.core.merges.requestMerge(p.id, e.producer, null);
    await waitFor(() => applied, 'main 반영');
    // 대표가 지시를 취소한다 — 선택이 저장되고, 그 작업의 취소는 병합 처리가 끝나기를 기다리는 중이다
    void e.core.directives.cancel(did, MAIN_AGENT_ID);
    await waitFor(() => e.ctx.store.tasks.require(p.id).hold.reasons.some((x) => x.kind === 'interrupted' && x.refId === CANCEL_HOLD_REF), '취소 보류');
    await sleep(30);
    const merged = mainSha(e);
    expect(merged).not.toBe(before);
    expect(e.ctx.store.directives.require(did).state).toBe('cancelled');

    e = env = await restartServices(e);
    const t = e.ctx.store.tasks.require(p.id);
    expect({ state: t.state, holds: kinds(t) }, `재시작 뒤 ${p.id}`).toEqual({ state: 'done', holds: [] });
    expect(t.merge?.mergeCommitSha).toBe(merged);
    expect(mainSha(e)).toBe(merged);
    expect(mergeCommitsFor(e, p.id)).toBe(1);
    expect(e.ctx.store.directives.require(did).state).toBe('cancelled');
    await sleep(200); // 완료 뒤 정리가 끝난 뒤
    e = env = await restartServices(e);
    expect(e.ctx.store.tasks.require(p.id).state).toBe('done');
    expect(mergeCommitsFor(e, p.id)).toBe(1);
  });
});

describe('지시 취소 선택이 저장된 뒤 산출물형 작업의 검수 통과 (TSK-09, CTL-08, AC-46)', () => {
  /** 산출물형 작업을 검수 상태까지 */
  async function artifactInReview(e: Env, did: string, assignee: Env['members'][number]): Promise<Task> {
    const art = newTask(e, { directiveId: did, assignee, reviewer: null, outputMode: 'artifact', type: 'docs', title: '문서 산출물' });
    await activate(e, art.id);
    e.core.tasks.setSteps(art.id, ['문서']);
    const dir = artifactWorkDir(e.ctx.paths, art.projectId, art.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'spec.md'), '# 문서\n', 'utf8');
    await e.core.tasks.completeStep(art.id, 0, '완료', assignee, null);
    e.core.tasks.requestSubmit(art.id, '제출', assignee);
    await e.core.tasks.processSubmission(art.id);
    const t = e.ctx.store.tasks.require(art.id);
    expect(t.state).toBe('in_review');
    return t;
  }

  it('지시 취소가 다른 작업을 처리하는 동안 도착한 검수 통과는 기록만 되고 산출물을 확정·보관하지 않으며(보류 해제·재시작 복구의 확정 경로도), 그 작업은 지시 취소가 취소한다', async () => {
    env = await boot({ team: ['developer', 'developer'] });
    const e = env;
    const [m1, m2] = e.members as [Env['members'][number], Env['members'][number]];
    const did = newDirective(e, '취소 중 산출물 검수 통과');
    const running = await activate(e, newTask(e, { directiveId: did, assignee: m1, title: '진행 중' }).id);
    const art = await artifactInReview(e, did, m2);
    const g = gate();
    const archive = e.core.tasks.archiveWorkspace.bind(e.core.tasks);
    let reachedArchive = false;
    e.core.tasks.archiveWorkspace = async (t, why) => {
      if (t.id === running.id) {
        reachedArchive = true;
        await g.promise;
      }
      return archive(t, why);
    };
    const cancelling = e.core.directives.cancel(did, MAIN_AGENT_ID);
    expect(e.ctx.store.directives.require(did).state).toBe('cancelled');
    await waitFor(() => reachedArchive, '첫 작업 보관 중');

    // 아직 취소 차례가 오지 않은 산출물 작업의 검수 턴이 통과를 등록한다 → 통과 기록만 남는다
    const passed = pass(e, art.id);
    expect(passed.state).toBe('in_review');
    expect(passed.review.passed).not.toBeNull();
    // 보류 해제·재시작 복구가 부르는 확정 경로도 확정하지 않는다
    e.core.merges.finalizeArtifactOrHold(art.id);
    await sleep(100);
    expect(e.ctx.store.tasks.require(art.id)).toMatchObject({ state: 'in_review', artifact: null });
    expect(existsSync(artifactVersionDir(e.ctx.paths, e.project.id, art.id, 1))).toBe(false);

    g.release();
    await cancelling;
    expect(e.ctx.store.tasks.require(art.id)).toMatchObject({ state: 'cancelled', artifact: null });
    expect(e.ctx.store.tasks.require(running.id).state).toBe('cancelled');
    expect(existsSync(artifactVersionDir(e.ctx.paths, e.project.id, art.id, 1))).toBe(false);
  });

  it('작업자에게 온 긴급 지시가 남아 있어도, 취소 선택이 저장된 지시의 산출물 작업에 온 검수 통과는 그 작업을 진행으로 되돌려 일을 이어 가게 하지 않는다', async () => {
    env = await boot({ team: ['developer', 'developer'] });
    const e = env;
    const [, m2] = e.members as [Env['members'][number], Env['members'][number]];
    const did = newDirective(e, '취소된 지시의 검수 통과');
    const art = await artifactInReview(e, did, m2);
    enqueue(e.ctx, { kind: 'message', memberId: m2.id, sessionKey: taskKey(art.id), projectId: e.project.id, taskId: art.id, message: '대표: 표를 하나 더 넣어 주세요', urgent: true });
    // 지시 취소 선택만 저장된 상태 (작업 취소는 아직)
    transitionDirective(e.ctx, did, { type: 'cancel', reason: '시험: 취소 선택 저장' }, MAIN_AGENT_ID);
    const passed = pass(e, art.id);
    expect(passed).toMatchObject({ state: 'in_review', artifact: null });
    expect(notices(e, '긴급 지시 먼저 전달')).toEqual([]);
    expect(e.ctx.store.queue.list({ state: 'queued' }).filter((q) => q.sessionKey === taskKey(art.id) && q.kind === 'task_work')).toEqual([]);
    // 끊긴 지시 취소를 마저 하면(재시작 복구와 같은 길) 그 작업이 취소된다
    await e.core.directives.cancel(did, MAIN_AGENT_ID);
    expect(e.ctx.store.tasks.require(art.id)).toMatchObject({ state: 'cancelled', artifact: null });
  });
});
