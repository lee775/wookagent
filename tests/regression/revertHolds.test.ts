/**
 * 되돌리기 보류의 빈틈 (GIT-10 '충돌·의존성 문제가 있으면 자동 완료하지 않고 보류', 7.1 충돌·의존성, AC-12, AC-46).
 * - 되돌리기가 최신 main을 반영하다 그 뒤 들어온 변경과 충돌하면(재계획 뒤·검수 중 main이 움직임·재시작) 담당에게 일반 충돌 해결을 주지 않고
 *   보류한다. 재계획으로 맡긴 담당은 '되돌릴 변경만 취소, 이후 변경은 남김' 안내를 받아 해결하고, 검사·검수·병합으로 이어진다
 * - 병합 직전(main을 바꾸기 바로 앞)에 되돌릴 변경에 기대는 뒤 작업을 다시 보고, 프로듀서가 지난 보류·재계획 때 확인하지 않은 작업이 있으면 보류한다
 * - 되돌리기 커밋이 충돌한 보류의 [replan]에도 기대는 뒤 작업을 적는다 — 재계획하면 확인된 작업이라 병합 직전에 다시 묻지 않는다
 * - 지시 취소 전에 시작된 그 지시의 프로듀서 턴이 취소 뒤에 처리된 request_revert는 받지 않는다 (취소 뒤에 시작한 턴의 별도 되돌리기는 받는다)
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Task, Turn } from '@shared/domain';
import { MAIN_AGENT_ID } from '@shared/domain';
import type { Env } from './helpers';
import { boot, commitOnMain, consumeQueued, newDirective, notices, queued, sleep } from './helpers';
import {
  driveToDone,
  fileAt,
  gate,
  identityOf,
  mainSha,
  mergeBy,
  mergeCommitsFor,
  passBy,
  passedRepoTask,
  restartServices,
  samePath,
  settled,
  waitUntil,
  writeFiles,
} from '../acceptance/git-helpers';
import { directiveKey, reviewKey, taskKey } from '../../src/main/orchestrator/records';

let env: Env | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const kinds = (t: Task) => t.hold.reasons.map((r) => r.kind);
const queuedFor = (e: Env, taskId: string) => queued(e, (q) => q.taskId === taskId || q.sessionKey === taskKey(taskId) || q.sessionKey === reviewKey(taskId));
const onMain = (e: Env, path: string) => fileAt(e.projectDir, `refs/heads/${e.project.baseBranch}`, path);

/** A(shared.txt에 줄 하나 + a.txt)를 병합한다 */
async function mergedA(e: Env): Promise<Task> {
  commitOnMain(e, 'shared.txt', 'base\n');
  const A = await passedRepoTask(e.core, { projectId: e.project.id, assignee: e.members[0]!, files: { 'shared.txt': 'base\nA가 만든 줄\n', 'a.txt': 'A 기능\n' }, title: 'A 작업' });
  expect((await mergeBy(e.core, A.id)).state).toBe('done');
  return e.ctx.store.tasks.require(A.id);
}

/** C가 A가 만든 줄을 고쳐 main에 병합된다 (되돌리기와 같은 줄을 바꾼 이후 변경) */
async function mergedC(e: Env): Promise<Task> {
  const C = await passedRepoTask(e.core, { projectId: e.project.id, assignee: e.members[0]!, files: { 'shared.txt': 'base\nA가 만든 줄을 C가 고침\n' }, title: 'C 작업' });
  expect((await mergeBy(e.core, C.id)).state).toBe('done');
  return C;
}

/** 검수를 통과한 A의 되돌리기 작업 (기대는 뒤 작업 없음) */
async function passedRevertOf(e: Env, A: Task): Promise<string> {
  const res = await e.core.merges.requestRevert(A.id, e.producer, 'A 철회');
  const rt = await settled(e.core, res.revertTaskId!);
  expect(rt.state).toBe('in_review');
  consumeQueued(e, reviewKey(rt.id)); // 검수 턴이 검수 업무를 받아 처리
  passBy(e.core, rt.id);
  return rt.id;
}

describe('되돌리기의 최신 main 반영 충돌은 보류 — 프로듀서가 계획한다 (GIT-10, 7.1, AC-12)', () => {
  it('의존성 보류를 재계획했는데 그사이 main의 다른 변경과 충돌하면 담당에게 일반 충돌 해결을 주지 않고 보류한다 — 재계획으로 맡긴 담당이 되돌릴 변경만 취소하게 해결하면 검사·검수·병합으로 이어진다', async () => {
    env = await boot({ team: ['developer', 'qa'] });
    const e = env;
    const [dev, qa] = e.members as [Env['members'][number], Env['members'][number]];
    const pid = e.project.id;
    const A = await mergedA(e);
    const B = await passedRepoTask(e.core, { projectId: pid, assignee: dev, files: { 'b.txt': 'A를 쓰는 B\n' }, title: 'B 작업', prerequisiteIds: [A.id], directiveId: A.directiveId });
    expect((await mergeBy(e.core, B.id)).state).toBe('done');
    const res = await e.core.merges.requestRevert(A.id, e.producer, 'A 철회');
    const rtId = res.revertTaskId!;
    expect(kinds(await settled(e.core, rtId))).toEqual(['replan']); // 의존성 보류 (B)
    // 프로듀서가 계획하는 동안 C가 A가 만든 줄을 고쳐 main에 병합된다
    await mergedC(e);
    const mainAfterC = mainSha(e.core, pid);
    consumeQueued(e, directiveKey(A.directiveId));
    e.core.tasks.replan(rtId, { note: 'B는 그대로 두고 A만 되돌린다' }, e.producer.id);

    const held = await settled(e.core, rtId);
    expect({ state: held.state, holds: kinds(held), conflict: held.conflict?.files ?? null }).toEqual({ state: 'on_hold', holds: ['replan'], conflict: ['shared.txt'] });
    expect(held.pendingSubmit).not.toBeNull();
    const asks = queuedFor(e, rtId);
    expect(asks.map((q) => `${q.kind}→${q.memberId}`)).toEqual([`replan→${e.producer.id}`]);
    expect(asks[0]!.message).toContain('shared.txt');
    expect(asks[0]!.message).toContain(B.id); // 기대는 뒤 작업도 적는다
    expect(notices(e, '되돌리기 보류')).toHaveLength(2);
    // 충돌 표시는 되돌리기 작업 폴더에 남고 main은 그대로다
    const wt = held.workspace!.worktreePath;
    expect((await e.ctx.deps.git.status(wt)).mergeInProgress).toBe(true);
    expect(mainSha(e.core, pid)).toBe(mainAfterC);

    // 프로듀서가 재계획하며 개발자에게 맡긴다 → 그 개발자의 작업 카드에 충돌과 7.1 규칙이 간다
    consumeQueued(e, directiveKey(A.directiveId));
    e.core.tasks.replan(rtId, { note: '개발자가 충돌 해결 — A의 변경만 취소, C의 수정은 유지', assigneeId: dev.id }, e.producer.id);
    expect(e.ctx.store.tasks.require(rtId)).toMatchObject({ state: 'waiting', assigneeId: dev.id });
    expect(await e.core.tasks.activateForLaunch(rtId)).toBe(true);
    const work = queuedFor(e, rtId);
    expect(work.map((q) => `${q.kind}→${q.memberId}`)).toEqual([`conflict_fix→${dev.id}`]);
    expect(work[0]!.message).toContain('이후 변경을 통째로 지우지');
    expect(work[0]!.message).toContain(`${A.id}의 변경만 취소`);
    consumeQueued(e, taskKey(rtId));
    // 담당은 되돌릴 변경만 취소하고 C의 수정은 남겨 해결을 보고한다 → 해결 커밋 → 턴이 끝나면 검사·검수
    writeFiles(wt, { 'shared.txt': 'base\nA가 만든 줄을 C가 고침\n' });
    await e.core.tasks.conflictResolved(e.ctx.store.tasks.require(rtId), dev, 'A의 줄은 C가 고쳐 유지');
    await e.core.tasks.processSubmission(rtId);
    const reviewing = await settled(e.core, rtId);
    expect(reviewing.state).toBe('in_review');
    expect(reviewing.reviewerId).toBe(qa.id);
    const done = await driveToDone(e.core, rtId);
    expect(done.state).toBe('done');
    expect(onMain(e, 'a.txt')).toBeNull();
    expect(onMain(e, 'shared.txt')).toBe('base\nA가 만든 줄을 C가 고침\n');
    expect(onMain(e, 'b.txt')).toBe('A를 쓰는 B\n');
    // B는 보류 때 알린 뒤 재계획했으므로 병합 직전에 다시 보류하지 않았다
    expect(notices(e, '되돌리기 보류')).toHaveLength(2);
  }, 90_000);

  it('검수를 통과한 되돌리기 아래로 main이 움직여 되돌릴 줄을 바꿨으면, 병합 단계의 최신 main 반영 충돌은 일반 충돌 해결이 아니라 보류(재계획)다', async () => {
    env = await boot({ team: ['developer', 'qa'] });
    const e = env;
    const A = await mergedA(e);
    const rtId = await passedRevertOf(e, A);
    await mergedC(e);
    const before = mainSha(e.core, e.project.id);
    const held = await mergeBy(e.core, rtId);
    expect({ state: held.state, holds: kinds(held), conflict: held.conflict?.files ?? null }).toEqual({ state: 'on_hold', holds: ['replan'], conflict: ['shared.txt'] });
    expect(queuedFor(e, rtId).map((q) => `${q.kind}→${q.memberId}`)).toEqual([`replan→${e.producer.id}`]);
    expect(notices(e, '되돌리기 보류')).toHaveLength(1);
    expect(mainSha(e.core, e.project.id)).toBe(before);
    expect(mergeCommitsFor(e.projectDir, e.project.baseBranch, rtId)).toBe(0);
    // 프로듀서가 담당을 바꾸지 않고 재계획하면 지금 담당(프로듀서)이 그 작업 폴더에서 해결한다 — 같은 충돌로 다시 보류하지 않는다
    consumeQueued(e, directiveKey(A.directiveId));
    e.core.tasks.replan(rtId, { note: '직접 해결 — A의 변경만 취소' }, e.producer.id);
    const back = await settled(e.core, rtId);
    expect({ state: back.state, holds: kinds(back) }).toEqual({ state: 'in_progress', holds: [] });
    const work = queuedFor(e, rtId);
    expect(work.map((q) => `${q.kind}→${q.memberId}`)).toEqual([`conflict_fix→${e.producer.id}`]);
    expect(work[0]!.message).toContain('이후 변경을 통째로 지우지');
    expect(notices(e, '되돌리기 보류')).toHaveLength(1);
  });

  it('되돌리기의 최신 main 반영이 충돌을 남긴 뒤 보류하기 전에 앱이 꺼져도, 재시작 복구는 담당에게 일반 충돌 해결을 주지 않고 보류한다', async () => {
    env = await boot({ team: ['developer', 'qa'] });
    let e = env;
    const A = await mergedA(e);
    const rtId = await passedRevertOf(e, A);
    await mergedC(e);
    const wt = e.ctx.store.tasks.require(rtId).workspace!.worktreePath;
    const g = e.ctx.deps.git;
    const orig = g.mergeBaseInto.bind(g);
    let cut = false;
    g.mergeBaseInto = async (dir, base, msg, who) => {
      const r = await orig(dir, base, msg, who);
      if (!cut && samePath(dir, wt) && !r.ok) {
        cut = true;
        return new Promise<never>(() => undefined); // 충돌을 작업 폴더에 남긴 직후, 기록하기 전에 앱이 꺼진다
      }
      return r;
    };
    const before = mainSha(e.core, e.project.id);
    e.core.merges.requestMerge(rtId, e.producer, null);
    await waitUntil(() => cut, '충돌 직후 끊김');
    await sleep(30);

    e = env = await restartServices(e);
    const held = await settled(e.core, rtId);
    expect({ state: held.state, holds: kinds(held), conflict: held.conflict?.files ?? null }).toEqual({ state: 'on_hold', holds: ['replan'], conflict: ['shared.txt'] });
    expect(queuedFor(e, rtId).map((q) => `${q.kind}→${q.memberId}`)).toEqual([`replan→${e.producer.id}`]);
    expect((await e.ctx.deps.git.status(wt)).mergeInProgress).toBe(true);
    expect(mainSha(e.core, e.project.id)).toBe(before);
  });
});

describe('되돌리기 보류의 순서는 시계가 아니라 상태 전이 순서로 본다', () => {
  it('보류 뒤 시계가 뒤로 맞춰진 다음 프로듀서가 재계획해도, 재계획한 충돌은 다시 보류하지 않고 확인한 뒤 작업은 병합 직전에 다시 묻지 않는다', async () => {
    env = await boot({ team: ['developer', 'qa'] });
    const e = env;
    const dev = e.members[0]!;
    const pid = e.project.id;
    const A = await mergedA(e);
    const B = await passedRepoTask(e.core, { projectId: pid, assignee: dev, files: { 'b.txt': 'A를 쓰는 B\n' }, title: 'B 작업', prerequisiteIds: [A.id], directiveId: A.directiveId });
    expect((await mergeBy(e.core, B.id)).state).toBe('done');
    const res = await e.core.merges.requestRevert(A.id, e.producer, 'A 철회');
    const rtId = res.revertTaskId!;
    expect(kinds(await settled(e.core, rtId))).toEqual(['replan']); // 의존성 보류 (B를 알림)
    await mergedC(e);
    consumeQueued(e, directiveKey(A.directiveId));
    e.core.tasks.replan(rtId, { note: 'B는 그대로 두고 A만 되돌린다' }, e.producer.id);
    expect((await settled(e.core, rtId)).conflict?.files).toEqual(['shared.txt']); // 최신 main 반영 충돌로 보류

    // PC 시계가 한 시간 뒤로 맞춰진다 (시각 동기화 등) — 그 뒤의 재계획·전이 시각은 앞선 보류·충돌 기록보다 이르다
    const ctx = e.ctx as unknown as { clock: Env['ctx']['clock'] };
    const real = ctx.clock;
    ctx.clock = { ...real, now: () => new Date(Date.now() - 3_600_000), iso: () => new Date(Date.now() - 3_600_000).toISOString() };
    consumeQueued(e, directiveKey(A.directiveId));
    e.core.tasks.replan(rtId, { note: '직접 해결 — A의 변경만 취소' }, e.producer.id);
    const back = await settled(e.core, rtId);
    expect({ state: back.state, holds: kinds(back) }).toEqual({ state: 'in_progress', holds: [] });
    expect(queuedFor(e, rtId).map((q) => `${q.kind}→${q.memberId}`)).toEqual([`conflict_fix→${e.producer.id}`]);
    consumeQueued(e, taskKey(rtId));
    writeFiles(back.workspace!.worktreePath, { 'shared.txt': 'base\nA가 만든 줄을 C가 고침\n' });
    await e.core.tasks.conflictResolved(e.ctx.store.tasks.require(rtId), e.producer, 'C의 수정 유지');
    await e.core.tasks.processSubmission(rtId);
    const done = await driveToDone(e.core, rtId);
    expect(done.state).toBe('done');
    expect(onMain(e, 'a.txt')).toBeNull();
    expect(notices(e, '되돌리기 보류')).toHaveLength(2); // 의존성·충돌 보류뿐 — 재계획한 충돌·확인한 B로 다시 보류하지 않았다
  }, 90_000);

  it('병합 직전 다시 확인으로 보류한 뒤 시계가 뒤로 맞춰진 다음 재계획해도, 그 보류 때 알린 뒤 작업은 확인된 것이라 다시 묻지 않고 병합한다', async () => {
    env = await boot({ team: ['developer', 'qa'] });
    const e = env;
    const dev = e.members[0]!;
    const A = await passedRepoTask(e.core, { projectId: e.project.id, assignee: dev, files: { 'a.txt': 'A 모듈\n' }, title: 'A 작업' });
    expect((await mergeBy(e.core, A.id)).state).toBe('done');
    const rtId = await passedRevertOf(e, A);
    const d2 = newDirective(e, '다른 지시');
    const C = e.core.tasks.create({ directiveId: d2, title: 'A 모듈을 쓰는 C', goal: 'A를 쓴다', type: 'development', assigneeId: dev.id, acceptanceCriteria: ['동작한다'], outputMode: 'repo', prerequisiteIds: [A.id] }, e.producer.id);
    const held = await mergeBy(e.core, rtId);
    expect(held.hold.reasons[0]!.note).toContain(C.id);
    // PC 시계가 한 시간 뒤로 맞춰진 뒤 프로듀서가 재계획한다 — 재계획 시각이 그 보류(C를 알림)보다 이르다
    const clocked = e.ctx as unknown as { clock: Env['ctx']['clock'] };
    const real = clocked.clock;
    clocked.clock = { ...real, now: () => new Date(Date.now() - 3_600_000), iso: () => new Date(Date.now() - 3_600_000).toISOString() };
    consumeQueued(e, directiveKey(A.directiveId));
    e.core.tasks.replan(rtId, { note: 'C는 따로 고친다' }, e.producer.id);
    const done = await driveToDone(e.core, rtId);
    expect(done.state).toBe('done');
    expect(onMain(e, 'a.txt')).toBeNull();
    expect(notices(e, '되돌리기 보류')).toHaveLength(1);
  }, 90_000);
});

describe('되돌리기 병합 직전의 뒤 작업 의존성 다시 확인 (7.1, GIT-10, AC-12)', () => {
  it('검수 중 다른 지시가 되돌릴 작업을 선행 작업으로 둔 작업을 만들면 병합 직전에 보류하고 main은 그대로다 — 재계획 뒤 또 생긴 작업만 다시 묻고, 확인된 작업은 다시 묻지 않는다', async () => {
    env = await boot({ team: ['developer', 'qa'] });
    const e = env;
    const dev = e.members[0]!;
    const pid = e.project.id;
    const A = await passedRepoTask(e.core, { projectId: pid, assignee: dev, files: { 'a.txt': 'A 모듈\n' }, title: 'A 작업' });
    expect((await mergeBy(e.core, A.id)).state).toBe('done');
    const rtId = await passedRevertOf(e, A);
    // 다른 지시의 계획(따로 도는 프로듀서 세션)이 A를 선행 작업으로 둔 작업을 만든다
    const d2 = newDirective(e, '다른 지시');
    const dependent = (title: string) =>
      e.core.tasks.create({ directiveId: d2, title, goal: 'A 모듈을 쓴다', type: 'development', assigneeId: dev.id, acceptanceCriteria: ['동작한다'], outputMode: 'repo', prerequisiteIds: [A.id] }, e.producer.id);
    const C = dependent('A 모듈을 쓰는 C');
    const before = mainSha(e.core, pid);

    let held = await mergeBy(e.core, rtId);
    expect({ state: held.state, holds: kinds(held), mainChanged: mainSha(e.core, pid) !== before, a: onMain(e, 'a.txt') }).toEqual({ state: 'on_hold', holds: ['replan'], mainChanged: false, a: 'A 모듈\n' });
    expect(held.hold.reasons[0]!.note).toContain(C.id);
    expect(held.pendingSubmit).not.toBeNull();
    let asks = queuedFor(e, rtId);
    expect(asks.map((q) => `${q.kind}→${q.memberId}`)).toEqual([`replan→${e.producer.id}`]);
    expect(asks[0]!.message).toContain(C.id);
    expect(mergeCommitsFor(e.projectDir, e.project.baseBranch, rtId)).toBe(0);

    // 프로듀서가 계획하는 사이 또 다른 작업 D가 A를 선행 작업으로 둔다 (지난 보류 때 알리지 않은 작업)
    const D = dependent('A 모듈을 쓰는 D');
    consumeQueued(e, directiveKey(A.directiveId));
    e.core.tasks.replan(rtId, { note: 'C는 A 없이 되게 따로 고친다' }, e.producer.id);
    const again = await settled(e.core, rtId);
    expect(again).toMatchObject({ state: 'in_review', review: { round: 2 } }); // 최신 main 반영·검사·고정부터 다시 → 새 검수 차수
    consumeQueued(e, reviewKey(rtId));
    passBy(e.core, rtId);
    held = await mergeBy(e.core, rtId);
    expect(held.state).toBe('on_hold');
    expect(held.hold.reasons[0]!.note).toContain(D.id);
    expect(held.hold.reasons[0]!.note).not.toContain(C.id); // C는 프로듀서가 확인했다
    asks = queuedFor(e, rtId);
    expect(asks[0]!.message).toMatch(new RegExp(`${C.id}[\\s\\S]*${D.id}`)); // 어떤 작업까지 조정할지 정하도록 지금 목록 전체
    expect(mainSha(e.core, pid)).toBe(before);

    consumeQueued(e, directiveKey(A.directiveId));
    e.core.tasks.replan(rtId, { note: 'D도 따로 고친다' }, e.producer.id);
    const done = await driveToDone(e.core, rtId);
    expect(done.state).toBe('done');
    expect(onMain(e, 'a.txt')).toBeNull();
    expect(mergeCommitsFor(e.projectDir, e.project.baseBranch, rtId)).toBe(1);
    expect(notices(e, '되돌리기 보류')).toHaveLength(2);
  }, 90_000);

  it('되돌리기 커밋이 이후 변경과 충돌해 보류할 때도 [replan]에 기대는 뒤 작업을 적고, 재계획하면 그 작업은 확인된 것이라 병합 직전에 다시 보류하지 않는다', async () => {
    env = await boot({ team: ['developer', 'qa'] });
    const e = env;
    const dev = e.members[0]!;
    const pid = e.project.id;
    const A = await passedRepoTask(e.core, { projectId: pid, assignee: dev, files: { 'shared.txt': 'A가 만든 줄\n', 'a.txt': 'A 기능\n' }, title: 'A 작업' });
    expect((await mergeBy(e.core, A.id)).state).toBe('done');
    const B = await passedRepoTask(e.core, {
      projectId: pid,
      assignee: dev,
      files: { 'shared.txt': 'A가 만든 줄을 B가 고침\n', 'b.txt': 'B 기능\n' },
      title: 'A를 고쳐 쓰는 B',
      prerequisiteIds: [A.id],
      directiveId: A.directiveId,
    });
    expect((await mergeBy(e.core, B.id)).state).toBe('done');
    const res = await e.core.merges.requestRevert(A.id, e.producer, 'A 철회');
    const rtId = res.revertTaskId!;
    const held = await settled(e.core, rtId);
    expect(kinds(held)).toEqual(['replan']);
    expect(held.hold.reasons[0]!.note).toContain('충돌');
    const asks = queuedFor(e, rtId);
    expect(asks.map((q) => `${q.kind}→${q.memberId}`)).toEqual([`replan→${e.producer.id}`]);
    expect(asks[0]!.message).toContain(`${B.id} "A를 고쳐 쓰는 B"`);

    // 재계획: 담당(프로듀서)이 그 작업 폴더에서 A의 파일만 되돌리고 B가 고친 줄은 남긴다
    consumeQueued(e, directiveKey(A.directiveId));
    e.core.tasks.replan(rtId, { note: 'B는 유지하고 A의 파일만 되돌린다' }, e.producer.id);
    expect(e.ctx.store.tasks.require(rtId).state).toBe('in_progress');
    consumeQueued(e, taskKey(rtId));
    writeFiles(held.workspace!.worktreePath, {}, ['a.txt']);
    e.core.tasks.setSteps(rtId, ['A의 파일 되돌리기']);
    await e.core.tasks.completeStep(rtId, 0, '되돌림', e.producer, null);
    e.core.tasks.requestSubmit(rtId, '제출', e.producer);
    await e.core.tasks.processSubmission(rtId);
    const done = await driveToDone(e.core, rtId);
    expect(done.state).toBe('done');
    expect(onMain(e, 'a.txt')).toBeNull();
    expect(onMain(e, 'shared.txt')).toBe('A가 만든 줄을 B가 고침\n');
    expect(onMain(e, 'b.txt')).toBe('B 기능\n');
    expect(notices(e, '되돌리기 보류')).toHaveLength(1);
  }, 90_000);
});

/** 프로듀서의 지시 세션 턴 기록 — 앱 도구 신원이 가리키는 턴. 그 턴의 시작 시각으로 요청을 가린다 */
function producerTurn(e: Env, directiveId: string): string {
  const now = e.ctx.now();
  const id = e.ctx.store.nextId('turn');
  const turn: Turn = {
    id,
    sessionId: `S-test-${id}`,
    memberId: e.producer.id,
    projectId: e.project.id,
    taskId: null,
    directiveId,
    sessionKind: 'directive',
    slotClass: 'management',
    queueEntryIds: [],
    isResume: false,
    aiKind: e.producer.ai.kind,
    mock: true,
    startedAt: now,
    endedAt: null,
    lastActivityAt: now,
    process: { state: 'running', pid: null, exitCode: null, stopRequestedAt: null, stopMode: null, killDetail: null },
    endReason: null,
    endDetail: '',
    stepsCompleted: 0,
    toolCalls: 0,
    usage: null,
    bypass: 'requested',
    mcp: 'connected',
    eventsFile: '',
    eventCount: 0,
    finalText: null,
  };
  e.ctx.store.turns.insert(turn);
  return id;
}

describe('지시 취소와 처리 중이던 되돌리기 요청 (AC-46, TSK-09)', () => {
  it('지시 취소 전에 시작된 그 지시의 프로듀서 턴이 보낸 request_revert는 프로젝트 잠금을 기다리다 취소 뒤에 처리되거나 취소 뒤에 도착해도 받지 않는다 — 취소 뒤에 시작한 턴의 별도 되돌리기는 받는다 (시계가 뒤로 맞춰져도 같다)', async () => {
    env = await boot({ team: ['developer', 'qa'] });
    const e = env;
    const dev = e.members[0]!;
    const pid = e.project.id;
    const A = await passedRepoTask(e.core, { projectId: pid, assignee: dev, files: { 'a.txt': 'A\n' }, title: 'A 작업' });
    expect((await mergeBy(e.core, A.id)).state).toBe('done');
    const did = A.directiveId;
    // 다른(열린) 지시의 진행 중 작업 — 취소된 지시의 턴이 보낸 '병합 전 폐기'도 받지 않아야 한다
    const d2 = newDirective(e, '다른 지시');
    const other = e.core.tasks.create({ directiveId: d2, title: '다른 지시의 작업', goal: '다른 일', type: 'development', assigneeId: dev.id, acceptanceCriteria: ['동작한다'], outputMode: 'repo' }, e.producer.id);
    const before = mainSha(e.core, pid);
    const oldTurn = producerTurn(e, did);
    const asOld = identityOf(e.producer, directiveKey(did), { turnId: oldTurn });
    // 그 턴이 시작된 뒤 PC 시계가 한 시간 뒤로 맞춰진다 — 이제 취소 시각이 그 턴의 시작 시각보다 이르다 (시각으로 견주면 '취소 뒤의 턴'으로 보인다)
    const clocked = e.ctx as unknown as { clock: Env['ctx']['clock'] };
    const real = clocked.clock;
    const setBack = (ms: number) => {
      clocked.clock = { ...real, now: () => new Date(Date.now() - ms), iso: () => new Date(Date.now() - ms).toISOString() };
    };
    setBack(3_600_000);

    // 병합 처리 등이 프로젝트 잠금을 잡고 있는 동안 그 턴의 되돌리기 요청이 도착해 잠금을 기다린다
    const g = gate();
    void e.core.locks.run(pid, '시험 잠금', () => g.promise);
    const pending = e.core.tools.handle(asOld, 'request_revert', { task_id: A.id, reason: '계획하던 되돌리기' });
    await sleep(50);
    await e.core.directives.cancel(did, MAIN_AGENT_ID);
    g.release();
    const r1 = await pending;
    expect(r1.ok ? 'ok' : r1.code).toBe('conflict');
    expect(r1.ok ? '' : r1.message).toMatch(/지시 .*취소돼 이 턴의 되돌리기 요청은 받지 않았습니다/);
    // 취소 뒤에 도착한 같은 턴의 요청도 (병합 전 폐기 포함) 받지 않는다
    const r2 = await e.core.tools.handle(asOld, 'request_revert', { task_id: other.id, reason: '계획하던 폐기' });
    expect(r2.ok ? 'ok' : r2.code).toBe('conflict');
    expect(e.ctx.store.tasks.require(other.id).state).toBe('waiting');
    expect(e.ctx.store.tasks.require(A.id)).toMatchObject({ state: 'done', revertedByTaskId: null });
    expect(e.ctx.store.tasks.list().filter((t) => t.type === 'revert')).toEqual([]);
    expect(mainSha(e.core, pid)).toBe(before);

    // 지시 취소 뒤에 시작한 턴(그 취소를 알고) — 취소된 지시의 완료 변경을 없애는 별도 되돌리기는 받는다 (AC-46 '별도 되돌리기 전까지 유지').
    // 시계가 더 뒤로 맞춰져 그 턴의 시작 시각이 취소 시각보다 일러도 받는다 (시각으로 견주면 '취소 전의 턴'으로 보인다)
    setBack(7_200_000);
    const newTurn = producerTurn(e, did);
    expect(e.ctx.store.turns.require(newTurn).startedAt < e.ctx.store.directives.require(did).cancelledAt!).toBe(true);
    const r3 = await e.core.tools.handle(identityOf(e.producer, directiveKey(did), { turnId: newTurn }), 'request_revert', { task_id: A.id, reason: '취소된 지시의 변경 되돌리기' });
    expect(r3.ok).toBe(true);
    const rtId = r3.ok ? (r3.data as { revertTaskId: string }).revertTaskId : '';
    expect((await settled(e.core, rtId)).state).toBe('in_review');
    await e.core.directives.cancel(did, MAIN_AGENT_ID); // 다시 불러도(재시작 마무리와 같은 길) 그 되돌리기는 남는다
    expect(e.ctx.store.tasks.require(rtId).state).toBe('in_review');
  });
});
