/**
 * 해결 못 한 충돌 해결 턴과 진척 없는 재개 세기 (GIT-07, CLI-18, 8장 헛돌기, ERR-04).
 * - 병합을 취소하고(git merge --abort) 같은 턴에 해결을 보고해도 해결된 것이 없다: 보고는 받지 않고 사실대로 알리며, 그 턴은 해결 못 한 턴으로
 *   세어 3번째에 헛돌기 보류 → 프로듀서. 같은 충돌이 다시 기록돼도 since·횟수를 이어 간다
 * - 프로듀서가 같은 담당에게 다시 맡긴 뒤 같은 충돌로 다시 헛돌면 대표에게 긴급 보고 (기록이 다시 쓰여도)
 * - 제출 요청은 진척이 아니다: 검사가 계속 실패하는 작업이 쉬는 턴·제출 턴을 번갈아도 쉬는 턴이 쌓여 3번째에 헛돌기 (stage 5 이전과 같게)
 * - 제출만 되풀이해도 이어진 제출 거부(자동 검사 실패 등)에 상한이 있다 (ERR-04)
 * - 쉬는 턴이 쌓인 뒤 제출 처리에서 생긴 충돌도 해결 턴을 처음부터 3번 받는다 (그 충돌 기록에 따로 센다)
 * 턴 단위 하네스(orchHarness: 실제 오케스트레이터 + 가짜 CLI), 실제 git.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Task } from '@shared/domain';
import { activeRepoTask, git, mergeBy, passedRepoTask } from '../acceptance/git-helpers';
import { bootOrch, notices, seedDirective, waitFor, type FakeProc, type OrchEnv } from './orchHarness';

let env: OrchEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const STUCK = '병합 충돌 해결 실패';

/** t1(개발자)을 먼저 병합하고 같은 파일을 고친 t2(QA 담당)를 병합 요청 → t2에 충돌 */
async function conflictedT2(o: OrchEnv): Promise<Task> {
  const dev = o.ctx.store.members.require(o.devId);
  const qa = o.ctx.store.members.require(o.qaId);
  const d = seedDirective(o);
  const t1 = await passedRepoTask(o.core, { projectId: o.projectId, assignee: dev, files: { 'shared.txt': '개발자 줄\n' }, directiveId: d.id });
  const t2 = await passedRepoTask(o.core, { projectId: o.projectId, assignee: qa, files: { 'shared.txt': 'QA 줄\n' }, directiveId: d.id });
  await mergeBy(o.core, t1.id);
  const r = await mergeBy(o.core, t2.id);
  expect(r.conflict?.files).toEqual(['shared.txt']);
  return r;
}

/** 그 작업이 보류될 때까지 한 차례씩 턴을 돌린다 — 판정(다음 업무 등록·제출 처리·보류)이 끝나기를 기다린 뒤 다음 차례 */
async function runUntilHeld(o: OrchEnv, taskId: string, max = 12): Promise<Task> {
  const nextReady = () => {
    const t = o.ctx.store.tasks.require(taskId);
    if (t.state !== 'in_progress') return true;
    return !o.core.tasks.isSubmitting(taskId) && o.ctx.store.queue.list({ ref2: `task:${taskId}`, state: 'queued' }).length > 0;
  };
  for (let i = 0; i < max && o.ctx.store.tasks.require(taskId).state === 'in_progress'; i++) {
    await o.drain(1);
    await waitFor(nextReady, `${taskId} 판정 뒤 다음 차례`, 20_000);
  }
  return o.ctx.store.tasks.require(taskId);
}

/** 대본: 비동기 동작 뒤 정상 종료 (대본 오류는 errors에 남긴다) */
function scripted(o: OrchEnv, key: string, body: (p: FakeProc, i: number) => Promise<void>): void {
  let n = 0;
  o.script.set(key, (p) => {
    const i = n++;
    void body(p, i)
      .then(() => p.finishOk())
      .catch((e: unknown) => {
        o.errors.push(String(e));
        p.finishOk('대본 오류');
      });
  });
}

const fixTurnsOf = (o: OrchEnv, taskId: string, memberId: string) => o.launches.filter((l) => l.workKey === `task:${taskId}` && l.memberId === memberId);

describe('병합 취소와 해결 보고 (GIT-07, CLI-18)', () => {
  it('같은 턴에 병합을 취소하고 해결을 보고하면 받지 않고 사실대로 알린다 — 그 턴은 해결 못 한 턴으로 세어 3번째에 헛돌기 보류(프로듀서), 같은 충돌은 since를 이어 간다', async () => {
    const o = (env = await bootOrch());
    const t2 = await conflictedT2(o);
    const since0 = t2.conflict!.since;
    const wt = t2.workspace!.worktreePath;
    const replies: { ok: boolean; code?: string; message?: string }[] = [];
    const markersAtStart: boolean[] = [];
    scripted(o, `task:${t2.id}`, async (p) => {
      // 턴을 시작할 때마다 프로그램이 충돌 표시를 되살려 둔다 (해결할 것이 있는 해결 턴)
      markersAtStart.push((await o.ctx.deps.git.status(wt)).mergeInProgress);
      git(wt, ['merge', '--abort']); // 규칙 위반 (CLI-09) — 같은 턴에 보고
      const r = await o.tool(p.turnId, 'report_conflict_resolved', { note: '해결했다고 보고' });
      replies.push(r.ok ? { ok: true } : { ok: false, code: r.code, message: r.message });
    });
    const held = await runUntilHeld(o, t2.id);
    expect(o.errors).toEqual([]);
    expect(fixTurnsOf(o, t2.id, o.qaId)).toHaveLength(3);
    expect(markersAtStart).toEqual([true, true, true]);
    // 보고는 받지 않았다 — 해결된 것이 없다고 사실대로, 다음 일(턴을 마치면 다시 반영해 되살림·몇 번째인지)과 함께
    expect(replies.map((r) => [r.ok, r.code])).toEqual([
      [false, 'conflict'],
      [false, 'conflict'],
      [false, 'conflict'],
    ]);
    expect(replies[0]!.message).toContain('병합이 취소된 것으로 보입니다');
    expect(replies[0]!.message).toContain('1/3');
    expect(replies[2]!.message).toContain('3/3, 프로듀서에게 넘어감');
    expect(o.ctx.store.execs.list({ ref1: t2.id }).filter((x) => x.kind === 'git_conflict_commit')).toEqual([]);
    expect(held.state).toBe('on_hold');
    expect(held.hold.reasons.map((r) => [r.kind, r.note])).toEqual([['replan', '병합 충돌 미해결 — 진척 없는 자동 재개 3회']]);
    expect(held.conflict).toMatchObject({ files: ['shared.txt'], since: since0, unresolvedTurns: 3, spinHolds: 1, resolverId: null });
    expect(o.ctx.store.queue.list({}).filter((q) => q.kind === 'replan' && q.taskId === t2.id && q.memberId === o.producerId)).toHaveLength(1);
    expect(notices(o, STUCK)).toEqual([]); // 첫 헛돌기는 프로듀서까지
  }, 120_000);

  it('병합 취소 턴과 보고 턴을 번갈아 헛돈 작업을 프로듀서가 같은 담당에게 다시 맡겼는데 같은 충돌로 다시 헛돌면, 충돌 기록이 다시 쓰여도 대표에게 긴급 보고한다', async () => {
    const o = (env = await bootOrch());
    const t2 = await conflictedT2(o);
    const since0 = t2.conflict!.since;
    const wt = t2.workspace!.worktreePath;
    scripted(o, `task:${t2.id}`, async (p, i) => {
      if (i % 2 === 0) git(wt, ['merge', '--abort']);
      else await o.tool(p.turnId, 'report_conflict_resolved', { note: '해결했다고 보고' });
    });
    const h1 = await runUntilHeld(o, t2.id);
    expect(h1.state).toBe('on_hold');
    expect(fixTurnsOf(o, t2.id, o.qaId)).toHaveLength(3); // 보고 턴도 받아들인 해결 커밋이 없으면 센다
    expect(notices(o, STUCK)).toEqual([]);

    o.core.tasks.replan(t2.id, { note: '방법을 바꿔 다시 해결' }, o.producerId); // 같은 담당, 다른 방법
    const h2 = await runUntilHeld(o, t2.id);
    expect(o.errors).toEqual([]);
    expect(h2.state).toBe('on_hold');
    expect(fixTurnsOf(o, t2.id, o.qaId)).toHaveLength(6);
    expect(h2.conflict).toMatchObject({ files: ['shared.txt'], since: since0, spinHolds: 2 });
    const stuck = notices(o, STUCK);
    expect(stuck).toHaveLength(1);
    expect(stuck[0]).toMatchObject({ level: 'urgent' });
  }, 120_000);
});

describe('제출 요청은 진척이 아니다 (CLI-18, ERR-04)', () => {
  /** 단계를 다 마친 진행 작업 (자동 검사는 env.check가 정한다) */
  async function doneSteps(o: OrchEnv): Promise<Task> {
    const dev = o.ctx.store.members.require(o.devId);
    const t = await activeRepoTask(o.core, { projectId: o.projectId, assignee: dev });
    o.core.tasks.setSteps(t.id, ['단계 1']);
    writeFileSync(join(t.workspace!.worktreePath, 'a.txt'), 'a\n', 'utf8');
    await o.core.tasks.completeStep(t.id, 0, '완료', dev, null);
    return t;
  }

  it('검사가 계속 실패하는 작업이 쉬는 턴과 제출 턴을 번갈아도 쉬는 턴이 쌓여 3번째에 헛돌기 보류된다 — 제출 턴은 세지도 되돌리지도 않는다', async () => {
    const o = (env = await bootOrch({ checkCommands: ['npm test'] }));
    o.check = (c) => c.exit(1);
    const t = await doneSteps(o);
    scripted(o, `task:${t.id}`, async (p, i) => {
      if (i % 2 === 1) {
        const r = await o.tool(p.turnId, 'submit_for_review', { note: '다시 제출' });
        if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
      }
    });
    o.core.tasks.continueWork(t.id, '시작');
    const counts: number[] = [];
    for (let i = 0; i < 10 && o.ctx.store.tasks.require(t.id).state === 'in_progress'; i++) {
      await runUntilHeld(o, t.id, 1);
      counts.push(o.ctx.store.tasks.require(t.id).noProgressResumes);
    }
    const cur = o.ctx.store.tasks.require(t.id);
    expect(o.errors).toEqual([]);
    expect(counts).toEqual([1, 1, 2, 2, 3]);
    expect(o.checkProcs).toHaveLength(2);
    expect(cur.state).toBe('on_hold');
    expect(cur.hold.reasons.map((r) => [r.kind, r.note])).toEqual([['replan', '진척 없는 자동 재개 3회']]);
  }, 120_000);

  it('단계 진척 없이 제출만 되풀이해 자동 검사가 이어서 실패하면 상한(같은 오류 5회)에서 헛돌기 보류 + 프로듀서 [replan]', async () => {
    const o = (env = await bootOrch({ checkCommands: ['npm test'] }));
    o.check = (c) => c.exit(1);
    const t = await doneSteps(o);
    scripted(o, `task:${t.id}`, async (p) => {
      const r = await o.tool(p.turnId, 'submit_for_review', { note: '다시 제출' });
      if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
    });
    o.core.tasks.continueWork(t.id, '시작');
    const cur = await runUntilHeld(o, t.id, 12);
    expect(o.errors).toEqual([]);
    expect(o.launches.filter((l) => l.workKey === `task:${t.id}`)).toHaveLength(5);
    expect(o.checkProcs).toHaveLength(5);
    expect(cur.state).toBe('on_hold');
    // 상한은 자동 검사 실패만이 아니라 대상을 고정하지 못한 제출 거부 모두를 하나로 센다 (ERR-04) — 보류 사유는 이어진 제출 거부와 마지막 거부 까닭
    expect(cur.hold.reasons.map((r) => [r.kind, r.note])).toEqual([['replan', '제출 5회 연속 거부 — 단계 진척 없이 다시 제출 (마지막: 자동 검사 실패)']]);
    expect(cur).toMatchObject({ checkFailStreak: 5, noProgressResumes: 0, pendingSubmit: null });
    expect(o.ctx.store.queue.list({}).filter((q) => q.kind === 'replan' && q.taskId === t.id && q.memberId === o.producerId)).toHaveLength(1);
  }, 120_000);

  it('쉬는 턴이 쌓인 뒤 제출 처리에서 생긴 충돌도 해결 턴을 처음부터 3번 받는다 — 제출이 진척 없는 재개 수를 되돌리지 않아도 충돌은 그 기록에 따로 센다', async () => {
    const o = (env = await bootOrch());
    const t = await doneSteps(o);
    o.ctx.store.tasks.patch(t.id, { noProgressResumes: 2 }); // 단계를 다 마친 뒤 제출 없이 끝난 턴이 두 번 있었다
    // 다른 작업이 같은 파일을 main에 먼저 올렸다 → 이 작업의 제출 처리가 최신 main 반영에서 충돌
    writeFileSync(join(o.projectDir, 'a.txt'), 'main 쪽\n', 'utf8');
    git(o.projectDir, ['add', 'a.txt']);
    git(o.projectDir, ['-c', 'user.name=other', '-c', 'user.email=o@o', 'commit', '-q', '-m', 'main: a.txt']);
    scripted(o, `task:${t.id}`, async (p, i) => {
      if (i === 0) {
        const r = await o.tool(p.turnId, 'submit_for_review', { note: '제출' });
        if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
      }
    });
    o.core.tasks.continueWork(t.id, '제출하세요');
    const cur = await runUntilHeld(o, t.id);
    expect(o.errors).toEqual([]);
    const turns = o.launches.filter((l) => l.workKey === `task:${t.id}`);
    expect(turns).toHaveLength(4); // 제출 턴 1 + 해결 못 한 해결 턴 3
    expect(cur.state).toBe('on_hold');
    expect(cur.hold.reasons.map((r) => r.note)).toEqual(['병합 충돌 미해결 — 진척 없는 자동 재개 3회']);
    expect(cur).toMatchObject({ noProgressResumes: 2, conflict: { files: ['a.txt'], unresolvedTurns: 3 } });
  }, 120_000);
});
