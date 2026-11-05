/**
 * 충돌 해결 보고의 내용 확인은 기록된 충돌 파일 모두를 본다 (GIT-07, CLI-09).
 * - 팀원이 규칙을 어기고 충돌 표시가 남은 파일을 직접 스테이징해도(인덱스에서는 충돌이 풀림) 이른 보고로 거부한다
 * - 팀원이 병합을 직접 커밋해 진행 중인 병합이 없어도, 기록된 충돌 파일에 표시가 남았으면 거부하고, 고친 뒤에는 해결로 받는다
 * - 메인 에이전트가 검수자면(적격 팀원이 없을 때의 대체 검수, REV-06 v0.6) 메인의 검수 업무에도 충돌 해결 때 내용으로 확인하지 못한 파일(바이너리 등)을 적는다 (팀원 검수 요청과 같게)
 * 서비스 단계 하네스(helpers.boot) + git 그룹 도우미(git-helpers).
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Env } from './helpers';
import { MAIN_AGENT_ID } from '@shared/domain';
import { boot } from './helpers';
import { driveToDone, fileAt, git, identityOf, mergeBy, passedRepoTask } from '../acceptance/git-helpers';

let env: Env | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const execsOf = (e: Env, taskId: string, kind: string) => e.ctx.store.execs.list({ ref1: taskId }).filter((x) => x.kind === kind);

/** 같은 파일을 고친 두 작업: t1을 먼저 병합한 뒤 t2를 병합 요청 → t2의 작업 폴더에 충돌 */
async function conflicted(e: Env, files1: Record<string, string>, files2: Record<string, string>, reviewer2?: 'main') {
  const [dev1, dev2] = e.members as [Env['members'][number], Env['members'][number]];
  const t1 = await passedRepoTask(e.core, { projectId: e.project.id, assignee: dev1, files: files1 });
  const t2 = await passedRepoTask(e.core, { projectId: e.project.id, assignee: dev2, files: files2, reviewer: reviewer2 });
  expect((await mergeBy(e.core, t1.id)).state).toBe('done');
  const r = await mergeBy(e.core, t2.id);
  expect(r.state).toBe('in_progress');
  return { dev2, t2, wt: r.workspace!.worktreePath, who: identityOf(dev2, `task:${t2.id}`) };
}

describe('충돌 해결 보고의 내용 확인 (GIT-07)', () => {
  it('충돌 표시가 남은 파일을 팀원이 직접 스테이징해도 이른 보고로 거부하고 커밋하지 않는다', async () => {
    env = await boot({ team: ['developer', 'developer'] });
    const e = env;
    const { t2, wt, who } = await conflicted(e, { 'shared.txt': 'A\n' }, { 'shared.txt': 'B\n' });
    git(wt, ['add', 'shared.txt']); // 규칙 위반: 표시가 남은 채 스테이징 → 인덱스에서는 충돌이 풀린다
    expect((await e.ctx.deps.git.status(wt)).unmerged).toEqual([]);
    const r = await e.core.tools.handle(who, 'report_conflict_resolved', { note: '스테이징함' });
    expect(r).toMatchObject({ ok: false, code: 'conflict' });
    expect(r.ok ? '' : r.message).toContain('shared.txt');
    expect(execsOf(e, t2.id, 'git_conflict_commit')).toEqual([]);
    expect(e.ctx.store.tasks.require(t2.id).conflict).toMatchObject({ files: ['shared.txt'], resolverId: null });
    // 표시를 지우면 받아 프로그램이 커밋한다
    writeFileSync(join(wt, 'shared.txt'), 'A\nB\n', 'utf8');
    expect(await e.core.tools.handle(who, 'report_conflict_resolved', { note: '합침' })).toMatchObject({ ok: true });
    expect(execsOf(e, t2.id, 'git_conflict_commit').map((x) => x.state)).toEqual(['succeeded']);
    expect(e.ctx.store.tasks.require(t2.id).conflict).toBeNull();
  });

  it('팀원이 표시가 남은 채 병합을 직접 커밋했으면 진행 중인 병합이 없어도 거부하고, 파일을 고친 뒤에는 해결로 받아 최신 main 반영·검수로 이어 간다', async () => {
    env = await boot({ team: ['developer', 'developer'] });
    const e = env;
    const { t2, wt, who } = await conflicted(e, { 'shared.txt': 'A\n' }, { 'shared.txt': 'B\n' });
    git(wt, ['add', '-A']);
    git(wt, ['-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-q', '--no-edit']); // 규칙 위반: 표시째 커밋
    expect((await e.ctx.deps.git.status(wt)).mergeInProgress).toBe(false);
    const early = await e.core.tools.handle(who, 'report_conflict_resolved', { note: '커밋함' });
    expect(early).toMatchObject({ ok: false, code: 'conflict' });
    expect(early.ok ? '' : early.message).toContain('shared.txt');
    expect(e.ctx.store.tasks.require(t2.id).conflict?.files).toEqual(['shared.txt']);

    writeFileSync(join(wt, 'shared.txt'), 'A\nB\n', 'utf8'); // git 없이 파일만 고친다
    const ok = await e.core.tools.handle(who, 'report_conflict_resolved', { note: '표시 정리' });
    expect(ok).toMatchObject({ ok: true });
    expect(ok.ok ? (ok.data as { message: string }).message : '').toContain('진행 중인 병합이 없어');
    const t = e.ctx.store.tasks.require(t2.id);
    expect(t).toMatchObject({ conflict: null, noProgressResumes: 0 });
    expect(t.contributors).toContain(t.assigneeId);
    const done = await driveToDone(e.core, t2.id);
    expect(fileAt(e.projectDir, 'refs/heads/main', 'shared.txt')).toBe('A\nB\n');
    expect(done.state).toBe('done');
  });

  it('팀원이 표시가 남은 채 병합을 직접 커밋하고 보고하지 않아도, 제출 처리가 기록된 충돌 파일을 내용으로 보고 검수로 넘기지 않는다 — 고치면 이어 간다', async () => {
    env = await boot({ team: ['developer', 'developer'] });
    const e = env;
    const { t2, wt } = await conflicted(e, { 'shared.txt': 'A\n' }, { 'shared.txt': 'B\n' });
    git(wt, ['add', '-A']);
    git(wt, ['-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-q', '--no-edit']); // 규칙 위반: 표시째 커밋, 보고 없음
    await e.core.tasks.processSubmission(t2.id);
    const held = e.ctx.store.tasks.require(t2.id);
    expect(held).toMatchObject({ state: 'in_progress', conflict: { files: ['shared.txt'] }, review: { target: null } });
    const [fix] = e.ctx.store.queue.list({ ref2: `task:${t2.id}`, state: 'queued' }).filter((q) => q.kind === 'conflict_fix');
    expect(fix?.message).toContain('충돌 표시');
    expect(fix?.message).toContain('shared.txt');
    // 파일만 고치면(git 없이) 제출 처리가 해결로 받고 검수로 이어 간다
    writeFileSync(join(wt, 'shared.txt'), 'A\nB\n', 'utf8');
    await e.core.tasks.processSubmission(t2.id);
    expect(e.ctx.store.tasks.require(t2.id)).toMatchObject({ state: 'in_review', conflict: null });
    expect((await driveToDone(e.core, t2.id)).state).toBe('done');
    expect(fileAt(e.projectDir, 'refs/heads/main', 'shared.txt')).toBe('A\nB\n');
  });

  it('메인 에이전트가 검수자면 메인의 검수 업무에 충돌 해결 때 내용으로 확인하지 못한 파일을 적는다', async () => {
    env = await boot({ team: ['developer', 'developer'] });
    const e = env;
    const { t2, wt, who } = await conflicted(e, { 'shared.txt': 'A\n', 'logo.bin': '\u0000로고 1' }, { 'shared.txt': 'B\n', 'logo.bin': '\u0000로고 2' }, 'main');
    expect(e.ctx.store.tasks.require(t2.id).reviewerId).toBe(MAIN_AGENT_ID);
    writeFileSync(join(wt, 'shared.txt'), 'A\nB\n', 'utf8');
    expect(await e.core.tools.handle(who, 'report_conflict_resolved', { note: '합침' })).toMatchObject({ ok: true, data: { unverified: ['logo.bin'] } });
    await e.core.tasks.processSubmission(t2.id);
    expect(e.ctx.store.tasks.require(t2.id).state).toBe('in_review');
    // 메인 에이전트의 검수 세션(review:T)으로 간 검수 요청 — 팀원 검수 요청과 같은 안내
    const req = e.ctx.store.queue.list({ ref2: `review:${t2.id}`, state: 'queued' }).filter((q) => q.kind === 'review' && q.memberId === MAIN_AGENT_ID).pop();
    expect(req?.message).toMatch(/내용으로 확인하지 못한 파일[^\n]*logo\.bin/);
    // 작업 화면에도 같은 것을 준다
    expect((await e.core.views.taskDetail(t2.id)).reviewNotes).toEqual({ uncheckedConflictFiles: ['logo.bin'], deliverables: null });
  });
});
