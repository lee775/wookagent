/**
 * 병합을 취소한 뒤 다시 반영한 최신 main이 충돌 없이 들어오면 남겨 둔 충돌 기록을 정리한다 (GIT-07, CLI-18, REV-07 작업 상태는 저장소와 맞아야).
 * - 팀원이 규칙을 어기고 병합을 취소(git merge --abort)한 뒤 손으로 main 쪽에 맞춰 커밋하고 해결을 보고하면 보고는 받지 않는다(해결된 것이 없다).
 *   안내는 사실대로 — 턴이 끝나면 최신 main을 다시 반영하고, 여전히 충돌하면 표시가 되살아나며, 충돌 없이 반영되면 기록을 정리하고 이어 간다
 * - 다시 반영이 충돌 없이 끝나면 기록·횟수를 지우고 자동 검사·대상 고정·검수로 이어 간다 — 지난 충돌 기록이 검수·반려 뒤 재작업 제출을 막지 않는다
 * - 병합을 취소한 사이 main이 바뀌어 다시 반영하면 충돌하지 않는 경우도 같다
 * - 다시 반영은 충돌 없이 끝났는데 충돌 파일에 충돌 표시 글이 남아 있으면 해결된 것이 아니다 — 기록을 두고 해결 업무로 (마무리된 병합과 같은 확인)
 * - 다시 반영한 뒤 기록을 정리하기 전에 앱이 꺼져도 재시작 뒤 같은 결과로 모인다 (마무리된 병합으로 보고 정리)
 * 턴 단위 하네스(orchHarness: 실제 오케스트레이터 + 가짜 CLI)와 서비스 단계 하네스(helpers.boot + 재시작), 실제 git.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Task } from '@shared/domain';
import type { ToolCallResult } from '../../src/main/mcp/types';
import { git, gitOk, mergeBy, passedRepoTask, restartServices, settled } from '../acceptance/git-helpers';
import { bootOrch, notices, seedDirective, waitFor, type FakeProc, type OrchEnv } from './orchHarness';
import { boot, type Env } from './helpers';

let env: OrchEnv | null = null;
let svc: Env | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
  await svc?.close();
  svc = null;
});

const msgOf = (r: ToolCallResult | undefined) => (r && !r.ok ? r.message : '');

/** t1(개발자)을 먼저 병합하고 같은 파일을 고친 t2(QA 담당)를 병합 요청 → t2에 충돌 (제출 요청은 남아 있다) */
async function conflictedT2(o: OrchEnv, files: { t1: Record<string, string>; t2: Record<string, string> } = { t1: { 'shared.txt': '개발자 줄\n' }, t2: { 'shared.txt': 'QA 줄\n' } }): Promise<Task> {
  const dev = o.ctx.store.members.require(o.devId);
  const qa = o.ctx.store.members.require(o.qaId);
  const d = seedDirective(o);
  const t1 = await passedRepoTask(o.core, { projectId: o.projectId, assignee: dev, files: files.t1, directiveId: d.id });
  const t2 = await passedRepoTask(o.core, { projectId: o.projectId, assignee: qa, files: files.t2, directiveId: d.id });
  await mergeBy(o.core, t1.id);
  const r = await mergeBy(o.core, t2.id);
  expect(r.conflict?.files).toEqual(Object.keys(files.t2));
  expect(r.pendingSubmit).not.toBeNull();
  return r;
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

/** 턴 하나를 돌리고 그 판정(제출 처리 포함)이 끝날 때까지 */
async function oneTurn(o: OrchEnv, taskId: string): Promise<Task> {
  await o.drain(1);
  await waitFor(() => !o.core.tasks.isSubmitting(taskId) && (o.ctx.store.tasks.require(taskId).state !== 'in_progress' || o.ctx.store.queue.list({ ref2: `task:${taskId}`, state: 'queued' }).length > 0), `${taskId} 판정`, 20_000);
  return o.ctx.store.tasks.require(taskId);
}

const cleared = (o: OrchEnv, taskId: string) => o.ctx.store.activity.search({ taskId, text: '충돌 기록 정리 — 병합 취소 뒤 다시 반영한 최신' }).map((a) => a.text);

describe('병합 취소 뒤 다시 반영한 최신 main이 충돌 없이 들어오면 (GIT-07, REV-07)', () => {
  it('병합을 취소하고 손으로 main 쪽에 맞춘 뒤 보고하면 받지 않되 사실대로 알리고, 턴이 끝나 다시 반영한 최신 main이 충돌 없이 들어오면 충돌 기록을 정리하고 검수로 이어 간다 — 반려 뒤 재작업 제출도 받는다', async () => {
    const o = (env = await bootOrch());
    const t2 = await conflictedT2(o);
    const wt = t2.workspace!.worktreePath;
    const base = o.ctx.store.projects.require(o.projectId).baseBranch;
    const replies: ToolCallResult[] = [];
    scripted(o, `task:${t2.id}`, async (p, i) => {
      if (i === 0) {
        // 규칙 위반 (CLI-09): 병합을 취소하고 main 쪽 파일로 손수 맞춰 커밋 — 충돌은 실제로 없어진다
        git(wt, ['merge', '--abort']);
        git(wt, ['checkout', base, '--', 'shared.txt']);
        git(wt, ['-c', 'user.name=qa', '-c', 'user.email=qa@x', 'commit', '-q', '-m', 'main 쪽으로 맞춤']);
        replies.push(await o.tool(p.turnId, 'report_conflict_resolved', { note: '손으로 맞춤' }));
      } else {
        replies.push(await o.tool(p.turnId, 'submit_for_review', { note: '고쳐서 다시 제출' }));
      }
    });
    const inReview = await oneTurn(o, t2.id);
    expect(o.errors).toEqual([]);
    // 보고는 받지 않았다 (해결된 것이 없었다) — 다음 일은 사실대로: 다시 반영하고, 충돌하면 표시가 되살아나고, 충돌 없이 들어오면 정리하고 이어 감
    expect(replies[0]).toMatchObject({ ok: false, code: 'conflict' });
    expect(msgOf(replies[0])).toContain('병합이 취소된 것으로 보입니다');
    expect(msgOf(replies[0])).toContain('여전히 충돌하면 충돌 표시가 되살아나고 해결 업무가 다시 옵니다');
    expect(msgOf(replies[0])).toContain('충돌 없이 반영되면 충돌 기록을 정리하고');
    // 다시 반영이 충돌 없이 끝나 기록을 정리하고 검수로 넘어갔다
    expect(inReview).toMatchObject({ state: 'in_review', conflict: null, review: { target: { kind: 'repo' } } });
    expect(cleared(o, t2.id)).toHaveLength(1);
    expect(cleared(o, t2.id)[0]).toContain('해결 못 한 해결 턴 1회 기록도 지움');
    const mainTip = git(o.projectDir, ['rev-parse', `refs/heads/${base}`]);
    expect(gitOk(wt, ['merge-base', '--is-ancestor', mainTip, 'HEAD'])).toBe(true); // 검수 대상에 최신 main이 들어 있다
    expect(o.ctx.store.queue.list({ ref2: `task:${t2.id}`, state: 'queued' }).filter((q) => q.kind === 'conflict_fix')).toEqual([]);
    expect((await o.core.views.taskDetail(t2.id)).task.conflictFiles).toEqual([]);

    // 반려 → 재작업 턴의 제출은 지난 충돌 기록에 막히지 않는다
    const reviewer = o.ctx.store.members.require(inReview.reviewerId!);
    o.core.tasks.submitReview(t2.id, reviewer, { verdict: 'reject', criteria: inReview.acceptanceCriteria.map((c) => ({ criterion: c, pass: false, note: '다시' })), reason: '다시' }, null);
    expect(o.ctx.store.tasks.require(t2.id).state).toBe('in_progress');
    const again = await oneTurn(o, t2.id);
    expect(o.errors).toEqual([]);
    expect(replies[1]).toMatchObject({ ok: true });
    expect(again).toMatchObject({ state: 'in_review', conflict: null });
    expect(again.hold.reasons).toEqual([]);
    expect(notices(o, '병합 충돌 해결 실패')).toEqual([]);
  }, 120_000);

  it('병합을 취소한 사이 main이 바뀌어 다시 반영하면 충돌하지 않는 경우에도 기록을 정리하고 이어 간다', async () => {
    const o = (env = await bootOrch());
    const t2 = await conflictedT2(o);
    const wt = t2.workspace!.worktreePath;
    const replies: ToolCallResult[] = [];
    scripted(o, `task:${t2.id}`, async (p) => {
      git(wt, ['merge', '--abort']); // 규칙 위반 — 해결은 하지 않았다
      // 그사이 다른 변경이 main에서 충돌 파일을 지웠다 → 다시 반영하면 이 작업의 파일이 충돌 없이 들어간다
      git(o.projectDir, ['rm', '-q', 'shared.txt']);
      git(o.projectDir, ['-c', 'user.name=other', '-c', 'user.email=o@o', 'commit', '-q', '-m', 'main: shared.txt 정리']);
      replies.push(await o.tool(p.turnId, 'report_conflict_resolved', { note: '해결했다고 보고' }));
    });
    const t = await oneTurn(o, t2.id);
    expect(o.errors).toEqual([]);
    expect(replies[0]).toMatchObject({ ok: false, code: 'conflict' });
    expect(t).toMatchObject({ state: 'in_review', conflict: null });
    expect(cleared(o, t2.id)).toHaveLength(1);
    expect(readFileSync(join(wt, 'shared.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('QA 줄\n');
  }, 120_000);

  it('다시 반영은 충돌 없이 끝났는데 충돌 파일에 충돌 표시 글이 남아 있으면 해결된 것이 아니다 — 기록을 두고 해결 업무로, 고치면 이어 간다', async () => {
    const o = (env = await bootOrch());
    // 두 작업이 같은 줄을 고친다 (공통 조상에 파일이 있음) → 수정/수정 충돌
    writeFileSync(join(o.projectDir, 'doc.txt'), '첫 줄\n둘째 줄\n', 'utf8');
    git(o.projectDir, ['add', 'doc.txt']);
    git(o.projectDir, ['-c', 'user.name=other', '-c', 'user.email=o@o', 'commit', '-q', '-m', 'main: doc.txt']);
    const t2 = await conflictedT2(o, { t1: { 'doc.txt': '개발자 첫 줄\n둘째 줄\n' }, t2: { 'doc.txt': 'QA 첫 줄\n둘째 줄\n' } });
    const wt = t2.workspace!.worktreePath;
    const base = o.ctx.store.projects.require(o.projectId).baseBranch;
    const replies: ToolCallResult[] = [];
    scripted(o, `task:${t2.id}`, async (p, i) => {
      if (i === 0) {
        // 병합을 취소하고 main 쪽 내용에 충돌 표시 글을 덧붙여 커밋 — 다시 반영은 충돌 없이 끝나지만 표시 글이 남는다
        git(wt, ['merge', '--abort']);
        git(wt, ['checkout', base, '--', 'doc.txt']);
        writeFileSync(join(wt, 'doc.txt'), `${readFileSync(join(wt, 'doc.txt'), 'utf8')}<<<<<<< HEAD\nQA 첫 줄\n=======\n>>>>>>> main\n`, 'utf8');
        git(wt, ['-c', 'user.name=qa', '-c', 'user.email=qa@x', 'commit', '-qam', '표시째 커밋']);
        replies.push(await o.tool(p.turnId, 'report_conflict_resolved', { note: '손으로 맞춤' }));
      } else {
        writeFileSync(join(wt, 'doc.txt'), '개발자 첫 줄\n둘째 줄\nQA 첫 줄\n', 'utf8');
        replies.push(await o.tool(p.turnId, 'report_conflict_resolved', { note: '표시 정리' }));
      }
    });
    const held = await oneTurn(o, t2.id);
    expect(o.errors).toEqual([]);
    expect(held).toMatchObject({ state: 'in_progress', conflict: { files: ['doc.txt'] }, review: { target: null } });
    const fix = o.ctx.store.queue.list({ ref2: `task:${t2.id}`, state: 'queued' }).filter((q) => q.kind === 'conflict_fix');
    expect(fix).toHaveLength(1);
    expect(fix[0]!.message).toContain('충돌 없이 반영됐지만 충돌이 해결되지 않았습니다');
    expect(fix[0]!.message).toContain('doc.txt');
    expect(cleared(o, t2.id)).toEqual([]);

    // 표시를 정리해 보고하면 해결로 받고(반영한 main이 HEAD에 들어 있어 마무리된 병합) 검수로 이어 간다
    const done = await oneTurn(o, t2.id);
    expect(o.errors).toEqual([]);
    expect(replies[1]).toMatchObject({ ok: true });
    expect(done).toMatchObject({ state: 'in_review', conflict: null });
  }, 120_000);

  it('다시 반영한 뒤 기록을 정리하기 전에 앱이 꺼져도 재시작 뒤 같은 결과로 모인다 — 마무리된 병합으로 보고 기록을 정리해 검수로', async () => {
    svc = await boot({ team: ['developer', 'developer'] });
    let e = svc;
    const [dev1, dev2] = e.members as [Env['members'][number], Env['members'][number]];
    const t1 = await passedRepoTask(e.core, { projectId: e.project.id, assignee: dev1, files: { 'shared.txt': '개발자 1 줄\n' } });
    const t2 = await passedRepoTask(e.core, { projectId: e.project.id, assignee: dev2, files: { 'shared.txt': '개발자 2 줄\n' } });
    await mergeBy(e.core, t1.id);
    const c = await mergeBy(e.core, t2.id);
    expect(c.conflict?.files).toEqual(['shared.txt']);
    const wt = c.workspace!.worktreePath;
    const base = e.project.baseBranch;
    // 팀원이 병합을 취소하고 손수 맞춘 뒤, 프로그램이 최신 main을 다시 반영(충돌 없음)했고 기록을 정리하기 전에 꺼진 상태
    git(wt, ['merge', '--abort']);
    git(wt, ['checkout', base, '--', 'shared.txt']);
    git(wt, ['-c', 'user.name=d', '-c', 'user.email=d@x', 'commit', '-q', '-m', 'main 쪽으로 맞춤']);
    git(wt, ['-c', 'user.name=wook', '-c', 'user.email=wook@wook.local', 'merge', '-q', '--no-edit', base]);
    e.ctx.store.tasks.patch(t2.id, { conflict: { ...e.ctx.store.tasks.require(t2.id).conflict!, unresolvedTurns: 1 } });
    e = svc = await restartServices(e);
    const t = await settled(e.core, t2.id);
    expect(e.errors).toEqual([]);
    expect(t).toMatchObject({ state: 'in_review', conflict: null, noProgressResumes: 0, review: { target: { kind: 'repo' } } });
    expect(e.ctx.store.activity.search({ taskId: t2.id, text: '충돌 기록 정리' })).toHaveLength(1);
  }, 120_000);
});
