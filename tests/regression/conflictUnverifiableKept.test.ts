/**
 * 충돌을 기록할 때 내용으로 확인할 수 없던 충돌 파일은 팀원이 직접 스테이징해도 계속 '확인하지 못한 파일'로 적는다 (GIT-07 재검수 안전장치).
 * 수정/삭제 충돌(main이 지운 파일을 이 작업이 고침)은 표시가 없어 내용으로 확인할 수 없다. 팀원이 규칙(CLI-09)을 어기고 git add로 자기 쪽을 스테이징하면
 * 인덱스에서 충돌이 풀려 지금 확인만으로는 표시 없는 텍스트 파일로 보인다 — 충돌 기록(TaskConflict.unverifiable)에 남긴 목록과 합친다:
 * - 해결 커밋 기록·도구 응답·검수 요청·get_review_target에 그 파일이 남는다 (팀원 검수자)
 * - 메인 에이전트가 검수자면(대체 검수, REV-06 v0.6) 메인의 검수 업무와 작업 상세(reviewNotes)에 남는다
 * - 충돌을 기록하기 전에 앱이 꺼져도 재시작 복구가 기록할 때 같은 목록을 남긴다
 * 턴 단위 하네스(orchHarness)와 서비스 단계 하네스(helpers.boot + 재시작), 실제 git.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Task } from '@shared/domain';
import { MAIN_AGENT_ID } from '@shared/domain';
import { git, identityOf, mergeBy, passedRepoTask, restartServices, settled } from '../acceptance/git-helpers';
import { bootOrch, notices, seedDirective, waitFor, type OrchEnv } from './orchHarness';
import { boot, type Env } from './helpers';

let env: OrchEnv | null = null;
let svc: Env | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
  await svc?.close();
  svc = null;
});

/** main에 x.txt를 두고, t1은 x.txt를 지우고, t2(QA 담당)는 고친다 → t1 병합 뒤 t2에 수정/삭제 충돌 */
async function modDeleteT2(o: OrchEnv, reviewer: 'main' | null = null): Promise<Task> {
  writeFileSync(join(o.projectDir, 'x.txt'), '원본\n', 'utf8');
  git(o.projectDir, ['add', 'x.txt']);
  git(o.projectDir, ['-c', 'user.name=other', '-c', 'user.email=o@o', 'commit', '-q', '-m', 'main: x.txt']);
  const dev = o.ctx.store.members.require(o.devId);
  const qa = o.ctx.store.members.require(o.qaId);
  const d = seedDirective(o);
  const t1 = await passedRepoTask(o.core, { projectId: o.projectId, assignee: dev, files: { 'other.txt': 'o\n' }, remove: ['x.txt'], directiveId: d.id });
  const t2 = await passedRepoTask(o.core, { projectId: o.projectId, assignee: qa, files: { 'x.txt': 'QA 수정\n' }, directiveId: d.id, reviewer });
  await mergeBy(o.core, t1.id);
  const r = await mergeBy(o.core, t2.id);
  expect(r.conflict).toMatchObject({ files: ['x.txt'], unverifiable: ['x.txt'] }); // 기록할 때(팀원이 손대기 전) 확인하지 못한 파일
  return r;
}

/** 해결 턴: 규칙을 어기고 자기 쪽을 스테이징한 뒤 보고 → 제출 처리(재검수 등록)까지 */
async function stageAndReport(o: OrchEnv, t2: Task): Promise<unknown> {
  const wt = t2.workspace!.worktreePath;
  let reply: unknown = null;
  o.script.set(`task:${t2.id}`, (p) => {
    void (async () => {
      git(wt, ['add', 'x.txt']); // 규칙 위반 (CLI-09): 수정/삭제 충돌에서 자기 쪽을 직접 스테이징 → 인덱스에서 충돌이 풀린다
      reply = await o.tool(p.turnId, 'report_conflict_resolved', { note: 'x.txt는 남김' });
      p.finishOk();
    })().catch((e: unknown) => {
      o.errors.push(String(e));
      p.finishOk('대본 오류');
    });
  });
  await o.drain(1);
  await waitFor(() => !o.core.tasks.isSubmitting(t2.id) && o.ctx.store.tasks.require(t2.id).state !== 'in_progress', '해결 뒤 재제출', 20_000);
  return reply;
}

describe('내용으로 확인하지 못한 충돌 파일은 팀원이 스테이징해도 남는다 (GIT-07)', () => {
  it('수정/삭제 충돌 파일을 팀원이 직접 스테이징하고 보고해도 해결 커밋·도구 응답·재검수 요청·검수 대상에 그 파일을 적는다', async () => {
    const o = (env = await bootOrch());
    const t2 = await modDeleteT2(o);
    const fix = o.ctx.store.queue.list({ ref2: `task:${t2.id}`, state: 'queued' }).map((q) => q.message).join('\n');
    expect(fix).toContain('충돌 표시가 없는 충돌 파일');
    const reply = await stageAndReport(o, t2);
    expect(o.errors).toEqual([]);
    expect(reply).toMatchObject({ ok: true, data: { unverified: ['x.txt'] } });
    const commit = o.ctx.store.execs.list({ ref1: t2.id }).filter((x) => x.kind === 'git_conflict_commit').pop();
    expect(commit?.result.unverified).toEqual(['x.txt']);
    expect(o.ctx.store.activity.search({ taskId: t2.id, text: '충돌 해결 커밋' }).map((a) => a.text).join('\n')).toContain('x.txt');
    const t = o.ctx.store.tasks.require(t2.id);
    expect(t.state).toBe('in_review');
    expect(o.core.tasks.uncheckedConflictFiles(t2.id)).toEqual(['x.txt']);
    const req = o.ctx.store.queue.list({ ref2: `review:${t2.id}`, state: 'queued' }).map((q) => q.message).join('\n');
    expect(req).toContain('충돌 해결 때 내용으로 확인하지 못한 파일');
    expect(req).toContain('x.txt');
    const reviewer = o.ctx.store.members.require(t.reviewerId!);
    const target = await o.core.tools.handle(identityOf(reviewer, `review:${t2.id}`), 'get_review_target', { task_id: t2.id });
    expect(target).toMatchObject({ ok: true, data: { uncheckedConflictFiles: ['x.txt'] } });
  }, 120_000);

  it('메인 에이전트가 검수자면 메인의 검수 업무와 작업 상세에 그 파일을 적는다', async () => {
    const o = (env = await bootOrch());
    const t2 = await modDeleteT2(o, 'main');
    await stageAndReport(o, t2);
    expect(o.errors).toEqual([]);
    const ask = o.ctx.store.queue.list({ ref2: `review:${t2.id}` }).filter((q) => q.kind === 'review' && q.memberId === MAIN_AGENT_ID && q.message.includes(t2.id));
    expect(ask.length).toBeGreaterThan(0);
    expect(ask[ask.length - 1]!.message).toContain('x.txt');
    expect((await o.core.views.taskDetail(t2.id)).reviewNotes).toMatchObject({ uncheckedConflictFiles: ['x.txt'] });
  }, 120_000);

  it('충돌을 낸 최신 main 반영 뒤 기록하기 전에 앱이 꺼져도, 재시작 복구가 기록할 때 확인하지 못한 파일을 남겨 스테이징 뒤 해결 커밋에도 적는다', async () => {
    svc = await boot({ team: ['developer', 'developer'] });
    let e = svc;
    const [dev1, dev2] = e.members as [Env['members'][number], Env['members'][number]];
    writeFileSync(join(e.projectDir, 'x.txt'), '원본\n', 'utf8');
    git(e.projectDir, ['add', 'x.txt']);
    git(e.projectDir, ['-c', 'user.name=other', '-c', 'user.email=o@o', 'commit', '-q', '-m', 'main: x.txt']);
    const t1 = await passedRepoTask(e.core, { projectId: e.project.id, assignee: dev1, files: { 'other.txt': 'o\n' }, remove: ['x.txt'] });
    const t2 = await passedRepoTask(e.core, { projectId: e.project.id, assignee: dev2, files: { 'x.txt': '개발자 2 수정\n' } });
    await mergeBy(e.core, t1.id);
    const c = await mergeBy(e.core, t2.id);
    expect(c.conflict?.files).toEqual(['x.txt']);
    // 최신 main 반영(충돌)은 끝났지만 실행 기록을 마치고 충돌을 기록하기 전에 꺼진 상태
    const upd = e.ctx.store.execs.list({ ref1: t2.id }).filter((x) => x.kind === 'git_update_from_base').pop()!;
    e.ctx.store.execs.put({ ...upd, state: 'started', endedAt: null });
    e.ctx.store.tasks.patch(t2.id, { conflict: null });
    e = svc = await restartServices(e);
    await settled(e.core, t2.id);
    expect(e.ctx.store.tasks.require(t2.id).conflict).toMatchObject({ files: ['x.txt'], unverifiable: ['x.txt'] });
    git(c.workspace!.worktreePath, ['add', 'x.txt']); // 규칙 위반: 직접 스테이징
    const r = await e.core.tasks.conflictResolved(e.ctx.store.tasks.require(t2.id), e.ctx.store.members.require(dev2.id), 'x.txt는 남김');
    expect(r).toMatchObject({ outcome: 'committed', unverified: ['x.txt'] });
    expect(e.core.tasks.uncheckedConflictFiles(t2.id)).toEqual(['x.txt']);
  }, 120_000);

  it('충돌 기록이 빠진 채 제출 처리가 작업 폴더의 충돌을 다시 기록할 때도 확인하지 못한 파일을 남긴다 — 해결 안내에도 적는다', async () => {
    svc = await boot({ team: ['developer', 'developer'] });
    const e = svc;
    const [dev1, dev2] = e.members as [Env['members'][number], Env['members'][number]];
    writeFileSync(join(e.projectDir, 'x.txt'), '원본\n', 'utf8');
    git(e.projectDir, ['add', 'x.txt']);
    git(e.projectDir, ['-c', 'user.name=other', '-c', 'user.email=o@o', 'commit', '-q', '-m', 'main: x.txt']);
    const t1 = await passedRepoTask(e.core, { projectId: e.project.id, assignee: dev1, files: { 'other.txt': 'o\n' }, remove: ['x.txt'] });
    const t2 = await passedRepoTask(e.core, { projectId: e.project.id, assignee: dev2, files: { 'x.txt': '개발자 2 수정\n' } });
    await mergeBy(e.core, t1.id);
    const c = await mergeBy(e.core, t2.id);
    for (const q of e.ctx.store.queue.list({ ref2: `task:${t2.id}`, state: 'queued' })) e.ctx.store.queue.put({ ...q, state: 'done', doneAt: e.ctx.now() });
    e.ctx.store.tasks.patch(t2.id, { conflict: null }); // 기록이 빠졌다 (작업 폴더에는 병합이 진행 중)
    await e.core.tasks.processSubmission(t2.id);
    expect(e.ctx.store.tasks.require(t2.id).conflict).toMatchObject({ files: ['x.txt'], unverifiable: ['x.txt'] });
    const fix = e.ctx.store.queue.list({ ref2: `task:${t2.id}`, state: 'queued' }).map((q) => q.message).join('\n');
    expect(fix).toContain('충돌 표시가 없는 충돌 파일(바이너리·한쪽에서 지운 파일 등): x.txt');
    git(c.workspace!.worktreePath, ['add', 'x.txt']);
    const r = await e.core.tasks.conflictResolved(e.ctx.store.tasks.require(t2.id), e.ctx.store.members.require(dev2.id), 'x.txt는 남김');
    expect(r.unverified).toEqual(['x.txt']);
  }, 120_000);
});
