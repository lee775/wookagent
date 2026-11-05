/**
 * 되돌리기 작업의 프로그램 단계 (GIT-10·15, 7.1, CLI-09, AC-12).
 * - 뒤 작업이 되돌릴 작업을 선행 작업으로 두면(이어서 기대는 작업까지) 자동 진행하지 않고 보류 → 프로듀서 재계획 뒤 검사·검수로
 * - 되돌린 결과가 자동 검사에 실패하면 일반 재작업이 아니라 보류 → 재계획 뒤 담당이 조정해 다시 제출
 * - 작업 폴더를 만들기 전·되돌리기 커밋 직전·커밋 직후 기록 전에 앱이 꺼져도 재시작 복구가 되돌리기를 한 번만, 그 작업만 되돌린다
 * - 스케줄러는 되돌리기 커밋을 기록하지 못한 되돌리기 작업을 담당에게 작업 카드로 주지 않고 프로그램 단계로 이어 간다
 * 서비스 단계는 실제 git·저장소(helpers.boot, 재시작은 git-helpers.restartServices), 스케줄러는 가짜 CLI 오케스트레이터(orchHarness)로 본다.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Task } from '@shared/domain';
import { MAIN_AGENT_ID } from '@shared/domain';
import { emptyReviewState } from '@core/taskMachine';
import type { Env } from './helpers';
import { boot, commitOnMain, consumeQueued, queued, notices } from './helpers';
import { bootOrch, sleep, waitFor, type OrchEnv } from './orchHarness';
import { activeRepoTask, driveToDone, fileAt, git, mainSha, mergeBy, passedRepoTask, restartServices, settled, waitUntil, writeFiles } from '../acceptance/git-helpers';
import { directiveKey, reviewKey, taskKey } from '../../src/main/orchestrator/records';

let env: Env | null = null;
let orch: OrchEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
  await orch?.close();
  orch = null;
});

const kinds = (t: Task) => t.hold.reasons.map((r) => r.kind);
const queuedFor = (e: Env, taskId: string) => queued(e, (q) => q.taskId === taskId || q.sessionKey === taskKey(taskId) || q.sessionKey === reviewKey(taskId));
const revertSubjects = (dir: string, rtId: string, origId: string) =>
  git(dir, ['log', '--format=%s', 'HEAD']).split(/\r?\n/).filter((l) => l === `[${rtId}] ${origId} 되돌리기`);

/** A·B를 차례로 병합한 프로젝트 (B는 A와 무관) */
async function twoMerged(e: Env): Promise<{ A: Task; B: Task }> {
  const dev = e.members[0]!;
  const A = await passedRepoTask(e.core, { projectId: e.project.id, assignee: dev, files: { 'a.txt': 'A\n' }, title: 'A 작업' });
  expect((await mergeBy(e.core, A.id)).state).toBe('done');
  const B = await passedRepoTask(e.core, { projectId: e.project.id, assignee: dev, files: { 'b.txt': 'B\n' }, title: 'B 작업' });
  expect((await mergeBy(e.core, B.id)).state).toBe('done');
  return { A: e.ctx.store.tasks.require(A.id), B: e.ctx.store.tasks.require(B.id) };
}

describe('되돌리기 보류 — 의존성·검사 실패 (7.1, AC-12)', () => {
  it('뒤 작업 의존성: 병합된 B와 B에 기대는 진행 중 C까지 보류 사유·프로듀서 안내에 넣고(취소된 D는 빼고) main은 그대로 — 재계획하면 검사·검수·병합으로 이어진다', async () => {
    env = await boot({ team: ['developer', 'qa'] });
    const e = env;
    const [dev, qa] = e.members as [Env['members'][number], Env['members'][number]];
    const pid = e.project.id;
    const A = await passedRepoTask(e.core, { projectId: pid, assignee: dev, files: { 'a.txt': 'A 모듈\n' }, title: 'A 작업' });
    expect((await mergeBy(e.core, A.id)).state).toBe('done');
    const B = await passedRepoTask(e.core, { projectId: pid, assignee: dev, files: { 'b.txt': 'A를 쓰는 B\n' }, title: 'B 작업', prerequisiteIds: [A.id], directiveId: A.directiveId });
    expect((await mergeBy(e.core, B.id)).state).toBe('done');
    // C는 B에 기대는 아직 진행 중인 작업 (A에는 B를 거쳐 기댄다), D는 A에 기대지만 취소됨
    const C = await activeRepoTask(e.core, { projectId: pid, assignee: dev, title: 'C 작업', prerequisiteIds: [B.id], directiveId: A.directiveId });
    const D = e.core.tasks.create(
      { directiveId: A.directiveId, title: 'D 작업', goal: 'D', type: 'development', assigneeId: dev.id, acceptanceCriteria: ['동작한다'], outputMode: 'repo', prerequisiteIds: [A.id] },
      e.producer.id,
    );
    await e.core.tasks.cancel(D.id, '필요 없음', e.producer.id);
    const before = mainSha(e.core, pid);

    const res = await e.core.merges.requestRevert(A.id, e.producer, 'A 철회');
    const rt = await settled(e.core, res.revertTaskId!);
    expect(rt.state).toBe('on_hold');
    expect(kinds(rt)).toEqual(['replan']);
    const note = rt.hold.reasons[0]!.note;
    expect(note).toContain(B.id);
    expect(note).toContain(C.id);
    expect(note).not.toContain(D.id);
    const asks = queuedFor(e, rt.id);
    expect(asks.map((q) => `${q.kind}→${q.memberId}`)).toEqual([`replan→${e.producer.id}`]);
    expect(asks[0]!.message).toMatch(new RegExp(`${B.id}[\\s\\S]*${C.id}`));
    expect(asks[0]!.message).toContain(`replan_task(task_id="${rt.id}")`);
    expect(notices(e, '되돌리기 보류')).toHaveLength(1);
    // 되돌리기 커밋은 되돌리기 작업 폴더에만 있고 기록돼 있다 (재계획 뒤 다시 만들지 않음), main은 그대로
    const wt = rt.workspace!.worktreePath;
    expect(revertSubjects(wt, rt.id, A.id)).toHaveLength(1);
    expect(e.ctx.store.steps.list(rt.id)).toMatchObject([{ idx: 0, title: `${A.id} 병합 변경 취소 커밋`, done: true, commitSha: git(wt, ['rev-parse', 'HEAD']) }]);
    expect(rt.pendingSubmit).not.toBeNull();
    expect(mainSha(e.core, pid)).toBe(before);
    // 대표의 단순 재개로는 풀리지 않는다 — 프로듀서가 조정 범위를 계획한다
    expect(() => e.core.tasks.resumeByOwner(rt.id, MAIN_AGENT_ID)).toThrow();

    consumeQueued(e, directiveKey(rt.directiveId)); // 프로듀서 턴이 [replan]을 받아 처리
    e.core.tasks.replan(rt.id, { note: 'B·C는 그대로 두고 A만 되돌린다' }, e.producer.id);
    const back = await settled(e.core, rt.id);
    expect(back.state).toBe('in_review');
    expect(back.reviewerId).toBe(qa.id);
    expect(queuedFor(e, rt.id).map((q) => q.kind)).toEqual(['review']);
    expect(revertSubjects(back.workspace!.worktreePath, rt.id, A.id)).toHaveLength(1);
    const done = await driveToDone(e.core, rt.id);
    expect(done.state).toBe('done');
    expect(fileAt(e.projectDir, 'refs/heads/main', 'a.txt')).toBeNull();
    expect(fileAt(e.projectDir, 'refs/heads/main', 'b.txt')).toBe('A를 쓰는 B\n');
    expect(e.ctx.store.tasks.require(C.id).state).toBe('in_progress');
  });

  it('검사 실패: 되돌린 결과가 자동 검사에 실패하면 일반 재작업이 아니라 보류(재계획) + 프로듀서 안내 — 재계획 뒤 담당이 그 작업 폴더에서 조정해 다시 제출하면 다시 검사해 검수로', async () => {
    env = await boot({ team: ['developer', 'qa'], runner: true, checkCommands: ['node check.js'] });
    const e = env;
    const dev = e.members[0]!;
    commitOnMain(
      e,
      'check.js',
      "const fs = require('fs');\nif (fs.existsSync('needs-a.txt') && fs.readFileSync('needs-a.txt', 'utf8').includes('a.txt 필요') && !fs.existsSync('a.txt')) { console.error('needs-a.txt는 a.txt가 있어야 합니다'); process.exit(1); }\nconsole.log('검사 통과');\n",
    );
    const A = await passedRepoTask(e.core, { projectId: e.project.id, assignee: dev, files: { 'a.txt': 'A\n' }, title: 'A 작업' });
    expect((await mergeBy(e.core, A.id)).state).toBe('done');
    const B = await passedRepoTask(e.core, { projectId: e.project.id, assignee: dev, files: { 'needs-a.txt': 'B: a.txt 필요\n' }, title: 'B 작업' });
    expect((await mergeBy(e.core, B.id)).state).toBe('done');
    const before = mainSha(e.core, e.project.id);

    const res = await e.core.merges.requestRevert(A.id, e.producer, 'A 철회');
    const rt = await settled(e.core, res.revertTaskId!, 60_000);
    expect(rt.review.autoCheck.status).toBe('failed');
    expect(rt).toMatchObject({ state: 'on_hold', pendingSubmit: null });
    expect(kinds(rt)).toEqual(['replan']);
    const asks = queuedFor(e, rt.id);
    expect(asks.map((q) => `${q.kind}→${q.memberId}`)).toEqual([`replan→${e.producer.id}`]);
    expect(asks[0]!.message).toContain('needs-a.txt는 a.txt가 있어야 합니다');
    expect(notices(e, '되돌리기 보류')).toHaveLength(1);
    expect(mainSha(e.core, e.project.id)).toBe(before);

    // 재계획: 이 되돌리기 안에서 조정하기로 → 담당(프로듀서)에게 작업으로 돌아간다 (되돌리기 커밋은 이미 기록돼 있다)
    consumeQueued(e, directiveKey(rt.directiveId)); // 프로듀서 턴이 [replan]을 받아 처리
    e.core.tasks.replan(rt.id, { note: '되돌리기 안에서 B가 a.txt 없이 동작하게 조정' }, e.producer.id);
    expect(e.ctx.store.tasks.require(rt.id).state).toBe('in_progress');
    expect(queuedFor(e, rt.id).map((q) => `${q.kind}→${q.memberId}`)).toEqual([`task_work→${e.producer.id}`]);
    consumeQueued(e, taskKey(rt.id));
    const wt = rt.workspace!.worktreePath;
    writeFiles(wt, { 'needs-a.txt': 'B: A 없이 동작\n' });
    e.core.tasks.setSteps(rt.id, [`${A.id} 병합 변경 취소 커밋`, 'B가 A 없이 동작하게 조정']);
    await e.core.tasks.completeStep(rt.id, 1, '조정', e.producer, null);
    e.core.tasks.requestSubmit(rt.id, '조정 뒤 다시 제출', e.producer);
    await e.core.tasks.processSubmission(rt.id);
    const again = await settled(e.core, rt.id, 60_000);
    expect(again.review.autoCheck.status).toBe('passed');
    expect(again.state).toBe('in_review');
    expect(revertSubjects(wt, rt.id, A.id)).toHaveLength(1);
    expect(mainSha(e.core, e.project.id)).toBe(before);
  }, 120_000);
});

describe('되돌리기 단계 재시작 수렴 (GIT-15, ERR-08, AC-12)', () => {
  /** 되돌리기 요청 중 지정한 지점에서 앱이 멈춘다 (그 약속은 끝나지 않는다) → 같은 데이터로 재시작 + 복구 */
  async function interrupted(where: 'before_workspace' | 'before_commit' | 'after_commit') {
    env = await boot({ team: ['developer', 'qa'] });
    let e = env;
    const { A, B } = await twoMerged(e);
    const g = e.ctx.deps.git;
    let reached = false;
    let committed: string | null = null;
    const never = () => new Promise<never>(() => undefined);
    if (where === 'before_workspace') {
      const orig = g.addWorktree.bind(g);
      g.addWorktree = async (repo, o) => {
        if (!reached && o.branch.startsWith('task/') && e.ctx.store.tasks.list().some((t) => t.type === 'revert' && o.branch.startsWith(`task/${t.id}`))) {
          reached = true;
          return never();
        }
        return orig(repo, o);
      };
    } else {
      const orig = g.revertMerge.bind(g);
      g.revertMerge = async (dir, sha, msg, who) => {
        if (where === 'after_commit') {
          // 커밋까지 끝난 뒤에 멈춘다 (진짜 종료처럼 이 인스턴스의 git 작업이 재시작 뒤에 이어지지 않게)
          const r = await orig(dir, sha, msg, who);
          committed = r.ok ? r.sha : null;
        }
        reached = true;
        return never();
      };
    }
    void e.core.merges.requestRevert(A.id, e.producer, 'A 철회');
    await waitUntil(() => reached, '멈출 지점');
    await sleep(50);
    const rtId = e.ctx.store.tasks.require(A.id).revertedByTaskId!;
    const atCrash = e.ctx.store.tasks.require(rtId);
    e = env = await restartServices(e);
    const rt = await settled(e.core, rtId);
    return { e, A, B, rtId, atCrash, rt, committed };
  }

  const expectConverged = (r: Awaited<ReturnType<typeof interrupted>>) => {
    const { e, A, rt } = r;
    expect(rt.state, JSON.stringify({ holds: rt.hold.reasons.map((x) => `${x.kind}:${x.note}`), execs: e.ctx.store.execs.list({ ref1: rt.id }).map((x) => `${x.kind}:${x.state}`) })).toBe('in_review');
    const wt = rt.workspace!.worktreePath;
    // 되돌리기 커밋은 하나, A의 파일만 지웠다 (B는 그대로)
    expect(revertSubjects(wt, rt.id, A.id)).toHaveLength(1);
    expect(fileAt(wt, 'HEAD', 'a.txt')).toBeNull();
    expect(fileAt(wt, 'HEAD', 'b.txt')).toBe('B\n');
    expect(e.ctx.store.steps.list(rt.id).map((s) => [s.title, s.done])).toEqual([[`${A.id} 병합 변경 취소 커밋`, true]]);
    // 담당(프로듀서)에게 '이어서 진행' 작업으로 넘기지 않았다 — 검수만 대기
    expect(queuedFor(e, rt.id).map((q) => q.kind)).toEqual(['review']);
    expect(e.ctx.store.transitions.list(rt.id).filter((x) => x.event === 'activate')).toHaveLength(1);
  };

  it('작업 폴더를 만들기 전(대기)에 끊기면 재시작 복구가 작업 폴더·되돌리기 커밋을 프로그램이 만들고 검수로 넘긴다', async () => {
    const r = await interrupted('before_workspace');
    expect(r.atCrash.state).toBe('waiting');
    expectConverged(r);
    expect(r.e.ctx.store.execs.list({ ref1: r.rtId }).filter((x) => x.kind === 'git_revert').map((x) => x.state)).toEqual(['succeeded']);
  });

  it('되돌리기 커밋 직전에 끊기면 시작 기록을 대조(미반영)한 뒤 같은 되돌리기를 다시 한 번 만든다', async () => {
    const r = await interrupted('before_commit');
    expect(r.atCrash.state).toBe('in_progress');
    expectConverged(r);
    const execs = r.e.ctx.store.execs.list({ ref1: r.rtId }).filter((x) => x.kind === 'git_revert');
    expect(execs.map((x) => `${x.state}:${String(x.result.recovered ?? '-')}`).sort()).toEqual(['failed:not_applied', 'succeeded:-']);
    // 시작 기록에 커밋 전 HEAD를 남겨 대조했다
    expect(execs.every((x) => typeof x.result.head === 'string')).toBe(true);
  });

  it('되돌리기 커밋 직후 기록 전에 끊기면 그 커밋을 다시 만들지 않고 기록만 한다', async () => {
    const r = await interrupted('after_commit');
    expect(r.committed).toMatch(/^[0-9a-f]{40}$/);
    expectConverged(r);
    expect(r.e.ctx.store.steps.list(r.rtId)[0]!.commitSha).toBe(r.committed);
    expect(r.e.ctx.store.execs.list({ ref1: r.rtId }).filter((x) => x.kind === 'git_revert').map((x) => `${x.state}:${String(x.result.recovered)}`)).toEqual([
      'succeeded:already_applied',
    ]);
  });
});

describe('되돌리기 단계 중 정지·재개 (CTL-09, CLI-09)', () => {
  it('되돌리기 커밋 중에 메인 에이전트가 작업을 중단하면(interrupt_task) 기록하지 않고 멈추고, 재개하면 담당에게 "이어서 진행"을 주지 않고 프로그램이 그 커밋을 기록해 검수로 넘긴다', async () => {
    env = await boot({ team: ['developer', 'qa'] });
    const e = env;
    const { A } = await twoMerged(e);
    const g = e.ctx.deps.git;
    const orig = g.revertMerge.bind(g);
    g.revertMerge = async (dir, sha, msg, who) => {
      // 되돌리기 커밋을 만드는 사이에 대표 중단이 저장된다
      const rtId = e.ctx.store.tasks.require(A.id).revertedByTaskId!;
      e.core.tasks.hold(rtId, 'interrupted', 'task', '대표 중단', MAIN_AGENT_ID);
      return orig(dir, sha, msg, who);
    };
    const res = await e.core.merges.requestRevert(A.id, e.producer, 'A 철회');
    const held = await settled(e.core, res.revertTaskId!);
    expect(held).toMatchObject({ state: 'on_hold', pendingSubmit: null });
    expect(kinds(held)).toEqual(['interrupted']);
    expect(e.ctx.store.steps.list(held.id)).toEqual([]); // 기록 전에 멈췄다 (커밋은 작업 폴더에 있다)
    expect(revertSubjects(held.workspace!.worktreePath, held.id, A.id)).toHaveLength(1);

    e.core.tasks.resumeByOwner(held.id, MAIN_AGENT_ID);
    const rt = await settled(e.core, held.id);
    expect(rt.state).toBe('in_review');
    expect(queuedFor(e, rt.id).map((q) => q.kind)).toEqual(['review']);
    expect(revertSubjects(rt.workspace!.worktreePath, rt.id, A.id)).toHaveLength(1);
    expect(e.ctx.store.execs.list({ ref1: rt.id }).filter((x) => x.kind === 'git_revert')).toHaveLength(1);
  });
});

describe('스케줄러와 되돌리기 작업 (CLI-09, AC-12)', () => {
  it('되돌리기 커밋을 기록하지 못한 대기 되돌리기 작업은 담당에게 작업 카드로 주지 않고, 스케줄러가 프로그램 단계로 이어 가 검수로 넘긴다', async () => {
    orch = await bootOrch();
    const o = orch;
    const ctx = o.ctx;
    // 병합된 A (서비스로 바로 몬다 — 턴 없이)
    const e = { core: o.core, ctx, project: ctx.store.projects.require(o.projectId), producer: ctx.store.members.require(o.producerId), members: [ctx.store.members.require(o.devId)] } as unknown as Env;
    const A = await passedRepoTask(e.core, { projectId: o.projectId, assignee: e.members[0]!, files: { 'a.txt': 'A\n' }, title: 'A 작업' });
    expect((await mergeBy(e.core, A.id)).state).toBe('done');
    // 되돌리기 작업 기록만 남고 끊긴 상태 (대기, 작업 폴더 없음) — createRevertTask 직후
    const now = ctx.now();
    const id = ctx.store.nextId('task');
    const rt: Task = {
      ...ctx.store.tasks.require(A.id),
      id,
      title: `[되돌리기] A 작업`,
      goal: `${A.id}의 병합 변경만 취소`,
      type: 'revert',
      priority: 'high',
      assigneeId: o.producerId,
      reviewerId: o.qaId,
      prerequisiteIds: [],
      acceptanceCriteria: [`${A.id}의 변경 효과만 취소된다`],
      state: 'waiting',
      hold: { reasons: [], returnState: null },
      workspace: null,
      review: emptyReviewState(),
      contributors: [o.producerId],
      merge: null,
      artifact: null,
      revertOfTaskId: A.id,
      revertedByTaskId: null,
      pendingSubmit: null,
      conflict: null,
      createdAt: now,
      updatedAt: now,
      queuedAt: now,
      activatedAt: null,
      completedAt: null,
      cancelledAt: null,
    };
    ctx.store.tasks.insert(rt);
    ctx.store.tasks.patch(A.id, { revertedByTaskId: id });
    expect(o.core.merges.revertPending(rt)).toBe(true);

    // 1) 프로그램 단계를 잠시 멈춰 두고 본다: 스케줄러가 이 대기 작업을 담당에게 작업 카드로 활성화하지 않는다
    const resume = o.core.merges.resumeRevert.bind(o.core.merges);
    const kicked: string[] = [];
    o.core.merges.resumeRevert = async (taskId: string) => {
      kicked.push(taskId);
    };
    o.tick();
    await o.idle();
    await sleep(100);
    expect(kicked).toContain(id);
    expect(o.launches.filter((l) => l.workKey === taskKey(id))).toEqual([]);
    expect(ctx.store.tasks.require(id)).toMatchObject({ state: 'waiting', activatedAt: null });
    expect(ctx.store.queue.list({}).filter((q) => q.sessionKey === taskKey(id))).toEqual([]);

    // 2) 프로그램 단계가 이어 가면 되돌리기 커밋을 만들어 검수로 넘긴다
    o.core.merges.resumeRevert = resume;
    o.tick();
    await waitFor(() => ctx.store.tasks.require(id).state === 'in_review' && !o.core.tasks.isSubmitting(id) && !o.core.merges.isPending(id), '되돌리기 검수');
    await o.idle();
    expect(o.launches.filter((l) => l.workKey === taskKey(id))).toEqual([]);
    expect(ctx.store.queue.list({}).filter((q) => q.sessionKey === taskKey(id))).toEqual([]);
    const wt = ctx.store.tasks.require(id).workspace!.worktreePath;
    expect(revertSubjects(wt, id, A.id)).toHaveLength(1);
    expect(o.core.merges.revertPending(ctx.store.tasks.require(id))).toBe(false);
  });
});
