/**
 * main에 병합이 반영된 뒤 보류된 작업과 지시 취소 (5.3 '미완료 지시 → 취소: 완료 결과는 유지', AC-46, CTL-10, TSK-04 — S7-B1·B2).
 * - S7-B1: 그 작업이 같은 지시의 다른 작업을 선행 작업으로 두면, 예전에는 지시 취소가 그 선행 작업을 취소하며 이 작업에 '선행 작업 취소' 보류를 더했다.
 *   그 보류는 대표 재개로 풀리지 않고, resolve_hold는 '선행 작업을 다시 정하라'며 거부하고, update_task는 지시가 취소됐다며 거부해 main에 반영된 작업이
 *   영영 끝나지 못했다. 이제 병합이 반영된 후속 작업에는 그 보류를 더하지 않고, 이전 기록으로 남은 그 보류는 재시작 복구·다시 취소·resolve_hold가 푼다.
 * - S7-B2: 취소 거부 안내와 지시 취소 알림이 보류 사유와 상관없이 '재개하면 완료'라고 했다 — 팀원·프로젝트 일시정지 보류는 작업 재개가 받지 않는다.
 *   이제 사유마다 푸는 길(작업 재개·팀원 재개·프로젝트 재개 …)을 적고, 작업 재개 거부도 같은 길을 가리킨다.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Task } from '@shared/domain';
import { MAIN_AGENT_ID, OWNER } from '@shared/domain';
import type { Env } from './helpers';
import { activate, boot, consumeMergeDecisions, mainSha, mergeCommitsFor, newDirective, newTask, notices, passedTask, queued, sleep, waitFor } from './helpers';
import { restartServices } from '../acceptance/git-helpers';

let env: Env | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const kinds = (t: Task) => t.hold.reasons.map((r) => r.kind);
const errorOf = async (p: Promise<unknown> | (() => unknown)): Promise<string> => {
  try {
    await (typeof p === 'function' ? p() : p);
    return '';
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
};

/** 검수를 통과한 P의 병합이 main에 반영되는 순간 onMerge가 정지를 건다 → P는 병합이 기록된 채 보류 */
async function mergedButHeld(e: Env, p: Task, onMerge: () => void): Promise<string> {
  consumeMergeDecisions(e, p.id);
  const g = e.ctx.deps.git;
  const orig = g.mergeIntoBase.bind(g);
  let fired = false;
  g.mergeIntoBase = async (dir, o) => {
    if (!fired) {
      fired = true;
      onMerge();
    }
    return orig(dir, o);
  };
  const before = mainSha(e);
  e.core.merges.requestMerge(p.id, e.producer, null);
  await waitFor(() => !e.core.merges.isPending(p.id), '병합 처리');
  await sleep(50);
  const merged = mainSha(e);
  expect(merged).not.toBe(before);
  const held = e.ctx.store.tasks.require(p.id);
  expect(held.state).toBe('on_hold');
  expect(held.merge?.mergeCommitSha).toBe(merged);
  return merged;
}

describe('병합이 반영된 뒤 보류된 작업의 선행 작업을 지시 취소가 취소해도 그 작업은 완료로 끝날 수 있다 (S7-B1)', () => {
  /** 같은 지시: 진행 중인 T1, T1을 선행 작업으로 둔(검수 중에 바꿈) P — P의 병합 도중 긴급 정지 */
  async function setup(e: Env): Promise<{ did: string; t1: Task; p: Task; merged: string }> {
    const [m1, m2] = e.members as [Env['members'][number], Env['members'][number]];
    const did = newDirective(e, '병합 중 긴급 정지 + 선행 작업');
    const t1 = await activate(e, newTask(e, { directiveId: did, assignee: m1, title: '선행 작업' }).id);
    const p = await passedTask(e, { directiveId: did, assignee: m2, reviewer: 'main', file: 'p.txt', content: 'P\n', title: '병합될 작업' });
    // update_task는 선행 작업만 바꾸면 검수·병합 상태와 상관없이 받는다
    e.core.tasks.update(p.id, { prerequisiteIds: [t1.id] }, e.producer.id);
    const merged = await mergedButHeld(e, p, () => void e.core.stops.emergency(OWNER));
    e.core.stops.release(OWNER);
    return { did, t1, p, merged };
  }

  it('지시 취소가 선행 작업을 취소해도 병합이 반영된 작업에는 선행 작업 취소 보류를 더하지 않는다 — 취소 안내대로 재개하면 다시 병합하지 않고 완료된다 (재시작해도 그대로)', async () => {
    env = await boot({ team: ['developer', 'developer'] });
    let e = env;
    const { did, t1, p, merged } = await setup(e);
    await e.core.directives.cancel(did, MAIN_AGENT_ID);
    expect(e.ctx.store.tasks.require(t1.id).state).toBe('cancelled');
    const held = e.ctx.store.tasks.require(p.id);
    expect(kinds(held)).toEqual(['emergency_stop']);
    // 선행 작업 취소 [replan]도 이 작업 몫으로 가지 않는다 (이미 완료 결과)
    expect(queued(e, (q) => q.taskId === p.id && q.kind === 'replan')).toEqual([]);
    expect(await errorOf(e.core.tasks.cancel(p.id, '대표 취소', MAIN_AGENT_ID))).toMatch(/지금 보류 중입니다\(긴급 정지\) — 재개하면 다시 병합하지 않고 완료합니다/);
    e.core.tasks.resumeByOwner(p.id, MAIN_AGENT_ID);
    await waitFor(() => e.ctx.store.tasks.require(p.id).state === 'done', '재개 뒤 완료');
    expect(mainSha(e)).toBe(merged);
    expect(mergeCommitsFor(e, p.id)).toBe(1);
    await sleep(200);
    e = env = await restartServices(e);
    expect(e.ctx.store.tasks.require(p.id).state).toBe('done');
    expect(mergeCommitsFor(e, p.id)).toBe(1);
  });

  it('지시가 열린 채 프로듀서가 선행 작업만 취소해도 병합이 반영된 작업에는 선행 작업 취소 보류·[replan]을 더하지 않는다 — 메인 에이전트 재개만으로 완료된다', async () => {
    env = await boot({ team: ['developer', 'developer'] });
    const e = env;
    const { did, t1, p, merged } = await setup(e);
    await e.core.tasks.cancel(t1.id, '필요 없어짐', e.producer.id);
    expect(e.ctx.store.tasks.require(t1.id).state).toBe('cancelled');
    expect(e.ctx.store.directives.require(did).state).not.toBe('cancelled');
    expect(kinds(e.ctx.store.tasks.require(p.id))).toEqual(['emergency_stop']);
    expect(queued(e, (q) => q.taskId === p.id && q.kind === 'replan')).toEqual([]);
    e.core.tasks.resumeByOwner(p.id, MAIN_AGENT_ID);
    await waitFor(() => e.ctx.store.tasks.require(p.id).state === 'done', '재개 뒤 완료');
    expect(mainSha(e)).toBe(merged);
    expect(mergeCommitsFor(e, p.id)).toBe(1);
  });

  it.each([
    ['재시작 복구', 'restart'],
    ['다시 취소', 'cancel'],
    ['프로듀서의 resolve_hold(선행 작업은 취소된 그대로)', 'resolve'],
  ] as const)('이전 기록으로 선행 작업 취소 보류가 남은 병합 반영 작업은 %s(으)로 풀려 다시 병합하지 않고 완료된다', async (_label, how) => {
    env = await boot({ team: ['developer', 'developer'] });
    let e = env;
    const { did, t1, p, merged } = await setup(e);
    await e.core.directives.cancel(did, MAIN_AGENT_ID);
    // 이전 코드가 남긴 기록: 지시 취소가 병합이 반영된 이 작업에도 '선행 작업 취소' 보류를 더했다
    e.core.tasks.hold(p.id, 'prereq_cancelled', 'task', `선행 작업 ${t1.id} 취소`, 'system');
    e.core.tasks.resumeByOwner(p.id, MAIN_AGENT_ID); // 긴급 정지 보류만 풀린다
    expect(kinds(e.ctx.store.tasks.require(p.id))).toEqual(['prereq_cancelled']);
    if (how === 'restart') e = env = await restartServices(e);
    // 취소는 거부되지만 그 처리가 기다릴 것 없는 보류를 풀어 그 자리에서 완료된다 — 거부 안내도 완료를 알린다
    else if (how === 'cancel') expect(await errorOf(e.core.tasks.cancel(p.id, '대표 취소', MAIN_AGENT_ID))).toMatch(/이미 (완료돼|main에 병합돼) 취소할 수 없습니다/);
    else e.core.tasks.resolveHold(p.id, 'prereq_cancelled', '병합이 이미 반영된 완료 결과', e.producer.id);
    await waitFor(() => e.ctx.store.tasks.require(p.id).state === 'done', `${how} 뒤 완료`);
    expect(e.ctx.store.tasks.require(t1.id).state).toBe('cancelled');
    expect(mainSha(e)).toBe(merged);
    expect(mergeCommitsFor(e, p.id)).toBe(1);
  });
});

describe('병합이 반영된 뒤 보류된 작업의 취소 거부·지시 취소 알림은 그 보류를 실제로 푸는 길을 가리킨다 (S7-B2)', () => {
  it.each([
    ['팀원 일시정지', 'member'],
    ['프로젝트 일시정지', 'project'],
  ] as const)('%s로 보류됨 — 안내는 작업 재개가 아니라 그 정지의 재개를 가리키고, 작업 재개 거부도 같은 길을 알리며, 그 재개로 다시 병합하지 않고 완료된다', async (_label, scope) => {
    env = await boot({ team: ['developer'] });
    const e = env;
    const did = newDirective(e, '병합 중 일시정지');
    const p = await passedTask(e, { directiveId: did, reviewer: 'main', file: 'm.txt', content: 'M\n', title: '병합될 작업' });
    const name = e.ctx.store.members.require(p.assigneeId).name;
    const merged = await mergedButHeld(e, p, () =>
      void (scope === 'member' ? e.core.stops.pauseMember(p.assigneeId, 'graceful', MAIN_AGENT_ID) : e.core.stops.pauseProject(p.projectId, 'graceful', MAIN_AGENT_ID)),
    );
    const path = scope === 'member' ? `일시정지 — 팀원 ${name} 재개로 풀림` : '일시정지 — 프로젝트 재개로 풀림';
    await e.core.directives.cancel(did, MAIN_AGENT_ID);
    const body = notices(e, '지시 취소').map((n) => n.body).join(' ');
    expect(body).toContain(`${p.id}(보류)`);
    expect(body).toContain(`${p.id}: ${path}`);
    expect(body).not.toContain('재개하면');
    const cancelError = await errorOf(e.core.tasks.cancel(p.id, '대표 취소', MAIN_AGENT_ID));
    expect(cancelError).toContain(`지금 보류 중입니다(${path}) — 보류가 모두 풀리면 다시 병합하지 않고 완료합니다`);
    expect(cancelError).not.toContain('재개하면');
    // 안내가 가리키지 않는 작업 재개는 받지 않고, 거부도 같은 길을 알린다
    expect(await errorOf(() => e.core.tasks.resumeByOwner(p.id, MAIN_AGENT_ID))).toBe(`메인 에이전트가 바로 재개할 수 있는 보류가 아닙니다 (${path})`);
    if (scope === 'member') e.core.stops.resumeMember(p.assigneeId, MAIN_AGENT_ID);
    else e.core.stops.resumeProject(p.projectId, MAIN_AGENT_ID);
    await waitFor(() => e.ctx.store.tasks.require(p.id).state === 'done', '정지 재개 뒤 완료');
    expect(mainSha(e)).toBe(merged);
    expect(mergeCommitsFor(e, p.id)).toBe(1);
  });

  it('보류 사유가 섞이면 사유마다 푸는 길을 적는다 — 긴급 정지(작업 재개)와 팀원 일시정지(팀원 재개)', async () => {
    env = await boot({ team: ['developer'] });
    const e = env;
    const did = newDirective(e, '병합 중 정지 둘');
    const p = await passedTask(e, { directiveId: did, reviewer: 'main', file: 'n.txt', content: 'N\n', title: '병합될 작업' });
    const name = e.ctx.store.members.require(p.assigneeId).name;
    await mergedButHeld(e, p, () => {
      void e.core.stops.pauseMember(p.assigneeId, 'graceful', MAIN_AGENT_ID);
      void e.core.stops.emergency(OWNER);
    });
    e.core.stops.release(OWNER);
    const cancelError = await errorOf(e.core.tasks.cancel(p.id, '대표 취소', MAIN_AGENT_ID));
    expect(cancelError).toContain(`(일시정지 — 팀원 ${name} 재개로 풀림, 긴급 정지 — 작업 재개로 풀림) — 보류가 모두 풀리면 다시 병합하지 않고 완료합니다`);
    e.core.tasks.resumeByOwner(p.id, MAIN_AGENT_ID);
    expect(kinds(e.ctx.store.tasks.require(p.id))).toEqual(['paused']);
    e.core.stops.resumeMember(p.assigneeId, MAIN_AGENT_ID);
    await waitFor(() => e.ctx.store.tasks.require(p.id).state === 'done', '모두 풀린 뒤 완료');
    expect(mergeCommitsFor(e, p.id)).toBe(1);
  });
});
