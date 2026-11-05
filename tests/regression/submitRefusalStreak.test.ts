/**
 * 다시 제출하기만 되풀이하는 작업에도 상한이 있다 — 제출 처리가 대상을 고정하지 않고 제출 요청을 지운 거부는 모두 한 줄로 센다 (ERR-04 자동 재시도
 * 상한, 8장 헛돌기 '같은 오류·명령 실패 5회', CLI-18).
 * 제출 턴은 진척 없는 재개로 세지 않으므로 거부만 이어지면 그것만으로는 멈추지 않는다. 자동 검사 실패뿐 아니라 검사는 통과했지만 커밋되지 않은 파일
 * (빌드 산출물)이 생긴 경우, 산출물형의 빈 산출물 폴더, 검사 중 작업 버전 변경도 같은 줄(Task.checkFailStreak)에 센다:
 * - 상한(spinSameErrorCount, 기본 5)이면 헛돌기 보류 + 프로듀서 [replan] — 팀원에게 가는 거부 안내는 그대로
 * - 검사 통과만으로는 0이 아니다 (통과 뒤 거부되는 제출도 이어서 센다). 대상이 고정되면 0
 * 턴 단위 하네스(orchHarness: 실제 오케스트레이터 + 가짜 CLI·가짜 자동 검사).
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Task } from '@shared/domain';
import { activeRepoTask } from '../acceptance/git-helpers';
import { bootOrch, seedDirective, waitFor, type FakeProc, type OrchEnv } from './orchHarness';

let env: OrchEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

/** 매 턴 submit_for_review만 부른다 */
function resubmitOnly(o: OrchEnv, t: Task): void {
  o.script.set(`task:${t.id}`, (p: FakeProc) => {
    void (async () => {
      const r = await o.tool(p.turnId, 'submit_for_review', { note: '다시 제출' });
      if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
      p.finishOk();
    })().catch((e: unknown) => {
      o.errors.push(String(e));
      p.finishOk('대본 오류');
    });
  });
}

/** 작업이 진행 상태에서 벗어나거나 rounds번 돌 때까지 한 차례씩 — 차례마다 그 작업 세션에 들어온 안내를 모은다 */
async function drive(o: OrchEnv, taskId: string, rounds: number): Promise<{ t: Task; notes: string[] }> {
  const notes: string[] = [];
  for (let i = 0; i < rounds && o.ctx.store.tasks.require(taskId).state === 'in_progress'; i++) {
    await o.drain(1);
    await waitFor(() => {
      const x = o.ctx.store.tasks.require(taskId);
      return !o.core.tasks.isSubmitting(taskId) && (x.state !== 'in_progress' || o.ctx.store.queue.list({ ref2: `task:${taskId}`, state: 'queued' }).length > 0);
    }, `${taskId} 차례 ${i}`, 20_000);
    notes.push(o.ctx.store.queue.list({ ref2: `task:${taskId}`, state: 'queued' }).map((q) => q.message).join(' | '));
  }
  return { t: o.ctx.store.tasks.require(taskId), notes };
}

/** 단계를 다 마친 저장소 변경형 진행 작업 */
async function doneSteps(o: OrchEnv): Promise<Task> {
  const dev = o.ctx.store.members.require(o.devId);
  const t = await activeRepoTask(o.core, { projectId: o.projectId, assignee: dev });
  o.core.tasks.setSteps(t.id, ['단계 1']);
  writeFileSync(join(t.workspace!.worktreePath, 'a.txt'), 'a\n', 'utf8');
  await o.core.tasks.completeStep(t.id, 0, '완료', dev, null);
  return t;
}

const replansFor = (o: OrchEnv, taskId: string) => o.ctx.store.queue.list({}).filter((q) => q.kind === 'replan' && q.taskId === taskId && q.memberId === o.producerId);

describe('다시 제출만 되풀이하는 거부에도 상한이 있다 (ERR-04)', () => {
  it('자동 검사는 통과하지만 빌드 산출물이 남아 거부되는 제출을 되풀이하면 5번째에 헛돌기 보류 + 프로듀서 [replan] — 거부 안내는 그대로', async () => {
    const o = (env = await bootOrch({ checkCommands: ['npm run build'] }));
    const t = await doneSteps(o);
    const wt = t.workspace!.worktreePath;
    o.check = (c) => {
      writeFileSync(join(wt, 'build.out'), `빌드 ${Date.now()}\n`, 'utf8'); // 빌드가 작업 폴더에 산출물을 쓴다
      c.exit(0);
    };
    resubmitOnly(o, t);
    o.core.tasks.continueWork(t.id, '시작');
    const { t: cur, notes } = await drive(o, t.id, 10);
    expect(o.errors).toEqual([]);
    expect(o.launches.filter((l) => l.workKey === `task:${t.id}`)).toHaveLength(5);
    expect(o.checkProcs).toHaveLength(5);
    expect(cur.state).toBe('on_hold');
    expect(cur.hold.reasons.map((r) => [r.kind, r.note])).toEqual([['replan', '제출 5회 연속 거부 — 단계 진척 없이 다시 제출 (마지막: 자동 검사 뒤 커밋되지 않은 파일 (build.out))']]);
    expect(cur).toMatchObject({ checkFailStreak: 5, pendingSubmit: null, noProgressResumes: 0 });
    expect(replansFor(o, t.id)).toHaveLength(1);
    expect(notes[0]).toContain('자동 검사 뒤 커밋되지 않은 파일이 생겼습니다(빌드 산출물이면 .gitignore에 추가하세요): build.out');
    expect(o.ctx.store.activity.search({ taskId: t.id, text: '제출 거부' }).map((a) => a.text).filter((x) => x.includes('5/5 — 헛돌기 보류'))).toHaveLength(1);
  }, 180_000);

  it('산출물 폴더가 빈 산출물형 작업이 다시 제출만 되풀이해도 5번째에 헛돌기 보류', async () => {
    const o = (env = await bootOrch());
    const planner = o.ctx.store.members.require(o.devId);
    const d = seedDirective(o);
    const t0 = o.core.tasks.create(
      { directiveId: d.id, title: '조사', goal: '조사', type: 'research', assigneeId: planner.id, reviewerId: null, acceptanceCriteria: ['보고서가 있다'], outputMode: 'artifact' },
      o.producerId,
    );
    expect(await o.core.tasks.activateForLaunch(t0.id)).toBe(true);
    for (const q of o.ctx.store.queue.list({ ref2: `task:${t0.id}`, state: 'queued' })) o.ctx.store.queue.put({ ...q, state: 'done', doneAt: o.ctx.now() });
    o.core.tasks.setSteps(t0.id, ['조사']);
    await o.core.tasks.completeStep(t0.id, 0, '조사', planner, null);
    const t = o.ctx.store.tasks.require(t0.id);
    resubmitOnly(o, t);
    o.core.tasks.continueWork(t.id, '시작');
    const { t: cur, notes } = await drive(o, t.id, 10);
    expect(o.errors).toEqual([]);
    expect(o.launches.filter((l) => l.workKey === `task:${t.id}`)).toHaveLength(5);
    expect(cur.state).toBe('on_hold');
    expect(cur.hold.reasons.map((r) => r.note)).toEqual(['제출 5회 연속 거부 — 단계 진척 없이 다시 제출 (마지막: 산출물 없음)']);
    expect(replansFor(o, t.id)).toHaveLength(1);
    expect(notes[0]).toContain('산출물이 없습니다.');
  }, 180_000);

  it('거부 까닭이 섞여도 한 줄로 센다 — 검사 통과만으로는 다시 세지 않는다 (실패·실패·통과 뒤 산출물·통과 뒤 산출물·실패 → 5번째에 보류)', async () => {
    const o = (env = await bootOrch({ checkCommands: ['npm test'] }));
    const t = await doneSteps(o);
    const wt = t.workspace!.worktreePath;
    let run = 0;
    o.check = (c) => {
      const i = run++;
      if (i === 2 || i === 3) {
        writeFileSync(join(wt, 'build.out'), `빌드 ${i}\n`, 'utf8');
        c.exit(0);
      } else c.exit(1);
    };
    resubmitOnly(o, t);
    o.core.tasks.continueWork(t.id, '시작');
    const { t: cur } = await drive(o, t.id, 10);
    expect(o.errors).toEqual([]);
    expect(o.checkProcs).toHaveLength(5);
    expect(cur.state).toBe('on_hold');
    expect(cur.hold.reasons.map((r) => r.note)).toEqual(['제출 5회 연속 거부 — 단계 진척 없이 다시 제출 (마지막: 자동 검사 실패)']);
    const streaks = o.ctx.store.activity.search({ taskId: t.id, text: '제출 거부' }).map((a) => /이어진 제출 거부 (\d)\/5/.exec(a.text)?.[1]);
    expect(streaks.sort()).toEqual(['1', '2', '3', '4', '5']);
  }, 180_000);

  it('대상이 고정되면 이어진 거부 수를 다시 센다 — 반려 뒤의 첫 거부는 1부터', async () => {
    const o = (env = await bootOrch({ checkCommands: ['npm test'] }));
    const t = await doneSteps(o);
    let run = 0;
    o.check = (c) => c.exit(run++ === 4 ? 0 : 1); // 4번 실패 → 5번째 통과(고정) → 그 뒤 실패
    resubmitOnly(o, t);
    o.core.tasks.continueWork(t.id, '시작');
    const first = await drive(o, t.id, 6);
    expect(o.errors).toEqual([]);
    expect(first.t).toMatchObject({ state: 'in_review', checkFailStreak: 0 });
    const reviewer = o.ctx.store.members.require(first.t.reviewerId!);
    o.core.tasks.submitReview(t.id, reviewer, { verdict: 'reject', criteria: first.t.acceptanceCriteria.map((c) => ({ criterion: c, pass: false, note: '다시' })), reason: '다시' }, null);
    const after = await drive(o, t.id, 1);
    expect(o.errors).toEqual([]);
    expect(after.t).toMatchObject({ state: 'in_progress', checkFailStreak: 1 });
    expect(after.notes[0]).toContain('이어진 실패 1/5');
  }, 180_000);
});
