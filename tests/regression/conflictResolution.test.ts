/**
 * 병합 충돌 해결 (GIT-07, CLI-09, AC-11): 팀원은 git 명령 없이 파일만 고친다 — 해결 여부는 작업 폴더 내용으로 보고,
 * 스테이징·커밋은 report_conflict_resolved를 받은 프로그램이 한다. 해결 커밋 뒤에는 남은 제출 요청이 최신 main 반영·검사·재검수로 이어진다.
 * - 충돌 표시가 남은 이른 보고는 예상한 거부(conflict)로, 기록·실행·오류 없이 남은 파일을 알려 준다
 * - 표시가 없는 충돌 파일(바이너리 등)은 안내에 따로 적고, 작업 폴더 그대로 커밋한 사실을 남긴다
 * - 보고를 받은 뒤 커밋 전/커밋 직후 앱이 꺼져도 재시작 뒤 같은 상태로 수렴한다 (팀원 턴을 더 쓰지 않음)
 * 서비스 단계 하네스(helpers.boot) + git 그룹 도우미(git-helpers).
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Env } from './helpers';
import { boot } from './helpers';
import { activeRepoTask, consumeQueued, driveToDone, fileAt, git, identityOf, mergeBy, passedRepoTask, restartServices, settled, waitUntil } from '../acceptance/git-helpers';

let env: Env | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const execsOf = (e: Env, taskId: string, kind: string) => e.ctx.store.execs.list({ ref1: taskId }).filter((x) => x.kind === kind);
const fixesFor = (e: Env, taskId: string) => e.ctx.store.queue.list({ ref2: `task:${taskId}`, state: 'queued' }).filter((q) => q.kind === 'conflict_fix');
const lastCommit = (wt: string) => git(wt, ['log', '-1', '--format=%ae|%s']);

/** 같은 파일을 고친 두 작업: t1을 먼저 병합한 뒤 t2를 병합 요청 → t2의 작업 폴더에 충돌 (해결은 dev2 몫) */
async function conflicted(e: Env, files1: Record<string, string>, files2: Record<string, string>) {
  const [dev1, dev2] = e.members as [Env['members'][number], Env['members'][number]];
  const t1 = await passedRepoTask(e.core, { projectId: e.project.id, assignee: dev1, files: files1 });
  const t2 = await passedRepoTask(e.core, { projectId: e.project.id, assignee: dev2, files: files2 });
  expect((await mergeBy(e.core, t1.id)).state).toBe('done');
  const r = await mergeBy(e.core, t2.id);
  expect(r.state).toBe('in_progress');
  return { dev1, dev2, t1, t2, wt: r.workspace!.worktreePath, who: identityOf(dev2, `task:${t2.id}`) };
}

describe('충돌 해결 보고 (GIT-07, CLI-09)', () => {
  it('충돌 표시가 남은 이른 보고와 충돌 중 제출은 예상한 거부로 할 일을 알려 주고, 파일만 고친 보고는 받아 프로그램이 커밋한다 — 표시 없는 바이너리 충돌은 작업 폴더 그대로 커밋됐다고 남긴다', async () => {
    env = await boot({ team: ['developer', 'developer'] });
    const e = env;
    const { dev2, t2, wt, who } = await conflicted(e, { 'shared.txt': '개발자1 줄\n', 'logo.bin': '\u0000로고 1' }, { 'shared.txt': '개발자2 줄\n', 'logo.bin': '\u0000로고 2' });
    expect(e.ctx.store.tasks.require(t2.id).conflict?.files).toEqual(['logo.bin', 'shared.txt']);
    // 해결 안내: git 명령 없이 표시 정리 → 보고, 표시가 없는 바이너리는 남길 내용을 직접 정하라고 따로 적는다
    const [fix] = fixesFor(e, t2.id);
    expect(fix?.memberId).toBe(dev2.id);
    expect(fix?.message).toContain('git 명령은 쓰지 마세요');
    expect(fix?.message).toMatch(/충돌 표시가 없는 충돌 파일[^\n]*logo\.bin/);

    // 이른 보고 (shared.txt에 표시가 남음): conflict로 거부 — 남은 파일만 알려 주고, 실행 기록·오류·해결자 기록을 남기지 않는다
    const early = await e.core.tools.handle(who, 'report_conflict_resolved', { note: '아직' });
    expect(early).toMatchObject({ ok: false, code: 'conflict' });
    const earlyMsg = early.ok ? '' : early.message;
    expect(earlyMsg).toContain('shared.txt');
    expect(earlyMsg).not.toContain('logo.bin');
    expect(earlyMsg).toContain('report_conflict_resolved');
    expect(execsOf(e, t2.id, 'git_conflict_commit')).toEqual([]);
    expect(e.ctx.store.activity.search({ taskId: t2.id, limit: 500 }).filter((a) => a.level === 'error')).toEqual([]);
    expect(e.ctx.store.tasks.require(t2.id).conflict?.resolverId).toBeNull();
    expect(e.errors).toEqual([]);

    // 충돌 중 제출은 해결 보고가 할 일이라고 알려 준다 (제출 요청은 이미 남아 있다)
    const submit = await e.core.tools.handle(who, 'submit_for_review', { note: '제출' });
    expect(submit).toMatchObject({ ok: false, code: 'conflict' });
    expect(submit.ok ? '' : submit.message).toContain('report_conflict_resolved');

    // 텍스트 충돌만 파일로 정리하고(git 없이) 바이너리는 그대로 둔다 → 받아서 해결자 이름으로 커밋
    const before = git(wt, ['rev-parse', 'HEAD']);
    writeFileSync(join(wt, 'shared.txt'), '개발자1 줄\n개발자2 줄\n', 'utf8');
    const ok = await e.core.tools.handle(who, 'report_conflict_resolved', { note: '두 줄 합침' });
    expect(ok).toMatchObject({ ok: true, data: { unverified: ['logo.bin'] } });
    expect(ok.ok ? (ok.data as { message: string }).message : '').toContain('logo.bin');
    expect(lastCommit(wt)).toMatch(new RegExp(`^${dev2.id}@wook\\.local\\|\\[${t2.id}\\] 최신 main 반영 충돌 해결: 두 줄 합침$`));
    const [exec] = execsOf(e, t2.id, 'git_conflict_commit');
    expect(exec).toMatchObject({ state: 'succeeded', result: { head: before, resolverId: dev2.id, unverified: ['logo.bin'] } });
    expect(e.ctx.store.activity.search({ taskId: t2.id, kinds: ['git'], limit: 100 }).some((a) => a.level === 'warn' && a.text.includes('충돌 해결 커밋') && a.text.includes('logo.bin'))).toBe(true);
    const after = e.ctx.store.tasks.require(t2.id);
    expect(after.conflict).toBeNull();
    expect(after.contributors).toContain(dev2.id);
    expect(after.noProgressResumes).toBe(0);
    expect(after.pendingSubmit).not.toBeNull();

    // 재검수 요청에 내용으로 확인하지 못한 충돌 파일을 적는다 — 재검수가 안전장치다 (GIT-07)
    await e.core.tasks.processSubmission(t2.id);
    expect(e.ctx.store.tasks.require(t2.id).state).toBe('in_review');
    const [rq] = e.ctx.store.queue.list({ ref2: `review:${t2.id}`, state: 'queued' });
    expect(rq?.message).toMatch(/내용으로 확인하지 못한 파일[^\n]*logo\.bin/);
    // 다시 검사·검수(해결자가 아닌 검수자) → 병합. 바이너리는 작업 폴더에 있던 그대로(이 작업 쪽)
    const done = await driveToDone(e.core, t2.id);
    expect(done.review.passed!.reviewerId).not.toBe(dev2.id);
    expect(fileAt(e.projectDir, 'refs/heads/main', 'shared.txt')).toBe('개발자1 줄\n개발자2 줄\n');
    expect(fileAt(e.projectDir, 'refs/heads/main', 'logo.bin')).toBe('\u0000로고 2');
    expect(e.errors).toEqual([]);
  });

  it('해결 보고를 받은 뒤 커밋 전에 앱이 꺼지면, 재시작 뒤 프로그램이 그 보고대로 해결자 이름으로 커밋하고 검수로 이어 간다 (팀원 턴을 다시 쓰지 않음)', async () => {
    env = await boot({ team: ['developer', 'developer'] });
    let e = env;
    const { dev2, t2, wt, who } = await conflicted(e, { 'shared.txt': 'A\n' }, { 'shared.txt': 'B\n' });
    consumeQueued(e.core, `task:${t2.id}`); // 해결 턴이 업무를 받았다
    writeFileSync(join(wt, 'shared.txt'), 'A\nB\n', 'utf8');
    e.ctx.deps.git.concludeMerge = () => new Promise<never>(() => undefined); // 커밋 직전에 앱 종료
    void e.core.tools.handle(who, 'report_conflict_resolved', { note: '두 줄' });
    await waitUntil(() => execsOf(e, t2.id, 'git_conflict_commit').some((x) => x.state === 'started'), '해결 커밋 시작');
    expect(e.ctx.store.tasks.require(t2.id).conflict).toMatchObject({ resolverId: dev2.id });

    e = env = await restartServices(e);
    const t = await settled(e.core, t2.id);
    expect(t.state).toBe('in_review');
    expect(t.conflict).toBeNull();
    expect(t.contributors).toContain(dev2.id);
    expect(lastCommit(wt)).toMatch(new RegExp(`^${dev2.id}@wook\\.local\\|\\[${t2.id}\\] 최신 main 반영 충돌 해결`));
    expect(execsOf(e, t2.id, 'git_conflict_commit').map((x) => [x.state, x.result.recovered ?? null])).toEqual([
      ['failed', 'not_applied'],
      ['succeeded', null],
    ]);
    expect(fixesFor(e, t2.id)).toEqual([]);
    const done = await driveToDone(e.core, t2.id);
    expect(done.review.passed!.reviewerId).not.toBe(dev2.id);
    expect(fileAt(e.projectDir, 'refs/heads/main', 'shared.txt')).toBe('A\nB\n');
  });

  it('해결 커밋 직후 기록 전에 앱이 꺼지면, 재시작 뒤 남은 충돌 기록을 정리하고 다시 커밋하지 않은 채 검수로 이어 간다 — 해결자는 이미 검수자에서 빠져 있다', async () => {
    env = await boot({ team: ['developer', 'developer'] });
    let e = env;
    const { dev2, t2, wt, who } = await conflicted(e, { 'shared.txt': 'A\n' }, { 'shared.txt': 'B\n' });
    consumeQueued(e.core, `task:${t2.id}`);
    writeFileSync(join(wt, 'shared.txt'), 'A\nB\n', 'utf8');
    const g = e.ctx.deps.git;
    const orig = g.concludeMerge.bind(g);
    let committed = false;
    g.concludeMerge = async (dir, message, identity) => {
      await orig(dir, message, identity);
      committed = true;
      return new Promise<never>(() => undefined); // 커밋 뒤 기록 전에 앱 종료
    };
    void e.core.tools.handle(who, 'report_conflict_resolved', { note: '두 줄' });
    await waitUntil(() => committed, '해결 커밋');
    expect(e.ctx.store.tasks.require(t2.id)).toMatchObject({ conflict: { resolverId: dev2.id } });

    e = env = await restartServices(e);
    const t = await settled(e.core, t2.id);
    expect(t.state).toBe('in_review');
    expect(t.conflict).toBeNull();
    expect(t.contributors).toContain(dev2.id);
    const fixes = git(wt, ['log', '--format=%s', 'HEAD']).split(/\r?\n/).filter((s) => s.startsWith(`[${t2.id}] 최신 main 반영 충돌 해결`));
    expect(fixes).toHaveLength(1);
    expect(execsOf(e, t2.id, 'git_conflict_commit').map((x) => [x.state, x.result.recovered ?? null])).toEqual([['succeeded', 'already_applied']]);
    expect(e.ctx.store.activity.search({ taskId: t2.id, kinds: ['git'], limit: 100 }).some((a) => a.text.includes('충돌 기록 정리'))).toBe(true);
    expect((await driveToDone(e.core, t2.id)).state).toBe('done');
  });

  it('제출 요청은 진척이 아니다 — 진척 없는 재개 수를 되돌리지 않고, 제출 처리에서 생긴 충돌은 그 충돌 기록에 해결 못 한 턴을 0부터 따로 센다', async () => {
    env = await boot();
    const e = env;
    const dev = e.members[0]!;
    const t = await activeRepoTask(e.core, { projectId: e.project.id, assignee: dev });
    e.core.tasks.setSteps(t.id, ['단계 1']);
    writeFileSync(join(t.workspace!.worktreePath, 'a.txt'), 'a\n', 'utf8');
    await e.core.tasks.completeStep(t.id, 0, '완료', dev, null);
    e.ctx.store.tasks.patch(t.id, { noProgressResumes: 2 }); // 단계를 다 마친 뒤 제출 없이 끝난 턴이 두 번 있었다
    e.core.tasks.requestSubmit(t.id, '제출', dev);
    expect(e.ctx.store.tasks.require(t.id)).toMatchObject({ noProgressResumes: 2, pendingSubmit: { note: '제출' } });
    // 다른 작업이 같은 파일을 main에 먼저 올렸다 → 제출 처리의 최신 main 반영이 충돌
    writeFileSync(join(e.projectDir, 'a.txt'), 'main 쪽\n', 'utf8');
    git(e.projectDir, ['add', 'a.txt']);
    git(e.projectDir, ['-c', 'user.name=other', '-c', 'user.email=o@o', 'commit', '-q', '-m', 'main: a.txt']);
    await e.core.tasks.processSubmission(t.id);
    expect(e.ctx.store.tasks.require(t.id)).toMatchObject({ state: 'in_progress', noProgressResumes: 2, conflict: { files: ['a.txt'], unresolvedTurns: 0, spinHolds: 0 } });
  });

  it('진행 중인 병합이 없는데 충돌 기록만 남은 상태에서 해결 보고가 오면 기록만 정리한다 — 남은 제출 처리가 최신 main 반영부터 다시 확인한다', async () => {
    env = await boot({ team: ['developer', 'developer'] });
    const e = env;
    const { t2, wt, who } = await conflicted(e, { 'shared.txt': 'A\n' }, { 'shared.txt': 'B\n' });
    // 앱 밖에서 병합이 끝나 버린 작업 폴더 (MERGE_HEAD 없음)
    writeFileSync(join(wt, 'shared.txt'), 'A\nB\n', 'utf8');
    git(wt, ['add', '-A']);
    git(wt, ['-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-q', '--no-edit']);
    const r = await e.core.tools.handle(who, 'report_conflict_resolved', { note: '이미 끝남' });
    expect(r).toMatchObject({ ok: true });
    expect(r.ok ? (r.data as { message: string }).message : '').toContain('진행 중인 병합이 없어');
    expect(execsOf(e, t2.id, 'git_conflict_commit')).toEqual([]);
    expect(e.ctx.store.tasks.require(t2.id).conflict).toBeNull();
    await e.core.tasks.processSubmission(t2.id);
    expect(e.ctx.store.tasks.require(t2.id).state).toBe('in_review');
    expect((await driveToDone(e.core, t2.id)).state).toBe('done');
    expect(fileAt(e.projectDir, 'refs/heads/main', 'shared.txt')).toBe('A\nB\n');
  });
});
