/**
 * 산출물형에서 전환된 작업의 산출물 폴더 결과 파일은 고정 때의 해시에 묶인다 — 보관하는 것은 검수한 그 내용뿐이다 (REV-05 버전 보관, REV-07
 * '산출물 버전·해시에 연결', REV-08 검수자는 사본을 고치지 않는다, AC-47).
 * - 대상 고정 때 찍은 사본의 해시를 검수 대상(target.deliverables)에 남긴다
 * - 검수 사본(검수 턴의 실행 위치라 바뀔 수 있다)이 고정 뒤 바뀌어도 바뀐 내용은 보관하지 않는다: 고정 때 그대로인 산출물 폴더(검수 중에는 작업 턴이
 *   돌지 않는다)에서 고정한 내용을 보관한다 (경고 활동) — 판정은 고정한 버전에 묶이고, 사본을 고치는 검수 턴 때문에 고정·검수가 되풀이되지 않는다
 * - 사본과 산출물 폴더가 모두 바뀌었으면 병합 전에는 main을 바꾸지 않고 진행으로 돌린다 (산출물 확정과 같게 다시 제출·검수). 병합 뒤면 보관하지 않고
 *   보류(오류) + 긴급 알림 — 검수한 내용으로 되돌린 뒤 재개하면 보관하고 완료한다
 * 서비스 단계 하네스(helpers.boot) + 실제 git.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Task } from '@shared/domain';
import { MAIN_AGENT_ID } from '@shared/domain';
import { artifactWorkDir } from '../../src/main/orchestrator/paths';
import type { Env } from './helpers';
import { activate, boot, commitOnMain, consumeQueued, mainSha, mergeAndSettle, mergeCommitsFor, newTask, notices, pass, queued, waitFor } from './helpers';

let env: Env | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const REVIEWED = '# 조사 결과\n추천안: A\n';

/** 산출물 폴더에 보고서를 쓰고 README도 고친 조사 작업을 제출해 검수 상태로 둔다 (변경형 전환) */
async function switchedInReview(e: Env): Promise<{ t: Task; workDir: string; planner: Env['members'][number] }> {
  commitOnMain(e, 'README.md', '# 프로젝트\n');
  const planner = e.core.team.add({ projectId: e.project.id, roleId: 'planner' }, MAIN_AGENT_ID);
  const t = await activate(e, newTask(e, { assignee: planner, type: 'research', outputMode: 'artifact' }).id);
  const workDir = artifactWorkDir(e.ctx.paths, t.projectId, t.id);
  e.core.tasks.setSteps(t.id, ['조사']);
  const report = join(workDir, 'report.md');
  mkdirSync(dirname(report), { recursive: true });
  writeFileSync(report, REVIEWED, 'utf8');
  await e.core.tasks.completeStep(t.id, 0, '조사', planner, null);
  writeFileSync(join(t.workspace!.worktreePath, 'README.md'), '# 프로젝트\n조사 요약: A 추천\n', 'utf8');
  e.core.tasks.requestSubmit(t.id, '제출', planner);
  await e.core.tasks.processSubmission(t.id);
  const inReview = e.ctx.store.tasks.require(t.id);
  expect(inReview).toMatchObject({ state: 'in_review', outputMode: 'repo', review: { target: { kind: 'repo', deliverables: [{ path: 'report.md' }] } } });
  return { t: inReview, workDir, planner };
}

/** 검수 사본을 고친다 (검수 턴이 실행 위치로 받은 사본에 쓰는 경우) */
function scribble(dir: string): void {
  writeFileSync(join(dir, 'report.md'), '# 조사 결과\n추천안: B (검수 중 바뀜)\n', 'utf8');
  writeFileSync(join(dir, 'reviewer-notes.md'), '검수 메모\n', 'utf8');
}

describe('전환된 작업의 산출물 폴더 결과 파일은 고정 때의 해시에 묶인다 (REV-07)', () => {
  it('검수 중 검수 사본이 바뀌어도 바뀐 내용은 보관하지 않는다 — 병합하고, 고정 때 그대로인 산출물 폴더에서 검수한 내용을 보관한다 (경고 활동)', async () => {
    env = await boot();
    const e = env;
    const { t } = await switchedInReview(e);
    const copy = e.core.tasks.deliverablesCopyOf(t)!;
    scribble(copy); // 검수 턴이 실행 위치로 받은 사본에 쓴다 (REV-08 위반)
    pass(e, t.id);
    const done = await mergeAndSettle(e, t.id);
    expect(done.state).toBe('done');
    expect(done.merge).not.toBeNull();
    expect(done.artifact?.files.map((f) => f.path)).toEqual(['report.md']);
    expect(readdirSync(done.artifact!.dir)).toEqual(['report.md']);
    expect(readFileSync(join(done.artifact!.dir, 'report.md'), 'utf8')).toBe(REVIEWED);
    const acts = e.ctx.store.activity.search({ taskId: t.id, text: '고정 때 그대로인 산출물 폴더에서' });
    expect(acts).toHaveLength(1);
    expect(acts[0]).toMatchObject({ level: 'warn' });
    expect(e.errors).toEqual([]);
  });

  it('검수 사본과 산출물 폴더가 모두 고정 뒤 바뀌면 병합하지 않고 진행으로 돌린다 — 다시 제출해 새로 찍은 내용으로 검수·병합하면 그 내용을 보관한다', async () => {
    env = await boot();
    const e = env;
    const { t, planner, workDir } = await switchedInReview(e);
    const copy = e.core.tasks.deliverablesCopyOf(t)!;
    const mainBefore = mainSha(e);
    scribble(copy);
    const changed = '# 조사 결과\n추천안: C (검수 중 산출물 폴더도 바뀜)\n';
    writeFileSync(join(workDir, 'report.md'), changed, 'utf8');
    pass(e, t.id);
    const back = await mergeAndSettle(e, t.id);
    // main을 바꾸지 않고 진행으로 돌렸다 (반려 아님) — 보관본도 없다
    expect(back).toMatchObject({ state: 'in_progress', merge: null, artifact: null, review: { target: null, rejectsInRound: 0 } });
    expect(mainSha(e)).toBe(mainBefore);
    expect(mergeCommitsFor(e, t.id)).toBe(0);
    expect(queued(e, (q) => q.sessionKey === `task:${t.id}`).map((q) => q.message).join('\n')).toContain('검수한 산출물 폴더 결과 파일이 대상 고정 뒤 바뀌어(검수 사본과 산출물 폴더 모두) 병합하지 않았습니다');
    expect(e.ctx.store.activity.search({ taskId: t.id, text: '병합 안 함 — 검수한 산출물 폴더 결과 파일이 대상 고정 뒤 바뀜' })).toHaveLength(1);

    // 다시 제출하면 산출물 폴더에서 새로 찍는다 — 검수 중에 사본에 생긴 파일은 없다. 그 내용으로 다시 검수하고 병합하면 그 내용을 보관한다
    consumeQueued(e, `task:${t.id}`);
    e.core.tasks.requestSubmit(t.id, '다시 제출', planner);
    await e.core.tasks.processSubmission(t.id);
    const again = e.ctx.store.tasks.require(t.id);
    expect(again.state).toBe('in_review');
    const copy2 = e.core.tasks.deliverablesCopyOf(again)!;
    expect(readFileSync(join(copy2, 'report.md'), 'utf8')).toBe(changed);
    expect(existsSync(join(copy2, 'reviewer-notes.md'))).toBe(false);
    pass(e, t.id);
    const done = await mergeAndSettle(e, t.id);
    expect(done.state).toBe('done');
    expect(readdirSync(done.artifact!.dir)).toEqual(['report.md']);
    expect(readFileSync(join(done.artifact!.dir, 'report.md'), 'utf8')).toBe(changed);
    expect(e.errors).toEqual([]);
  });

  it('병합 직전 확인 뒤에 검수 사본이 바뀌면 고정 때 그대로인 산출물 폴더에서 보관한다 (경고 활동)', async () => {
    env = await boot();
    const e = env;
    const { t } = await switchedInReview(e);
    const copy = e.core.tasks.deliverablesCopyOf(t)!;
    const g = e.ctx.deps.git;
    const orig = g.mergeIntoBase.bind(g);
    g.mergeIntoBase = async (repo, m) => {
      const res = await orig(repo, m);
      scribble(copy); // main을 바꾼 뒤, 보관 전
      return res;
    };
    pass(e, t.id);
    const done = await mergeAndSettle(e, t.id);
    expect(done.state).toBe('done');
    expect(done.merge).not.toBeNull();
    expect(readdirSync(done.artifact!.dir)).toEqual(['report.md']);
    expect(readFileSync(join(done.artifact!.dir, 'report.md'), 'utf8')).toBe(REVIEWED);
    const acts = e.ctx.store.activity.search({ taskId: t.id, text: '고정 때 그대로인 산출물 폴더에서' });
    expect(acts).toHaveLength(1);
    expect(acts[0]).toMatchObject({ level: 'warn' });
    expect(e.errors).toEqual([]);
  });

  it('검수 사본과 산출물 폴더가 모두 고정 뒤 바뀌면 보관하지 않고 보류(오류) + 긴급 알림 — 검수한 내용으로 되돌린 뒤 재개하면 보관하고 완료한다', async () => {
    env = await boot();
    const e = env;
    const { t, workDir } = await switchedInReview(e);
    const copy = e.core.tasks.deliverablesCopyOf(t)!;
    const g = e.ctx.deps.git;
    const orig = g.mergeIntoBase.bind(g);
    g.mergeIntoBase = async (repo, m) => {
      const res = await orig(repo, m);
      scribble(copy);
      writeFileSync(join(workDir, 'report.md'), '검수 뒤 고친 내용\n', 'utf8');
      return res;
    };
    pass(e, t.id);
    const held = await mergeAndSettle(e, t.id);
    // main에는 병합됐다 (되돌리지 않는다) — 보관하지 않고 완료도 하지 않는다
    expect(held.merge).not.toBeNull();
    expect(held).toMatchObject({ state: 'on_hold', artifact: null });
    expect(held.hold.reasons.map((r) => r.kind)).toEqual(['error']);
    expect(held.hold.reasons[0]!.note).toContain('대상 고정 뒤 바뀌어 보관하지 않았습니다');
    const alarm = notices(e, '산출물 보관 실패');
    expect(alarm).toHaveLength(1);
    expect(alarm[0]).toMatchObject({ level: 'urgent' });
    expect(readdirSync(join(e.ctx.paths.artifacts, t.projectId, t.id)).filter((n) => /^v\d+$/.test(n))).toEqual([]);

    // 되돌리지 않고 재개하면 다시 대조해 다시 보류한다 (바뀐 내용을 보관하지 않는다)
    e.core.tasks.resumeByOwner(t.id, MAIN_AGENT_ID);
    await waitFor(() => e.ctx.store.tasks.require(t.id).state === 'on_hold', '다시 보류');
    expect(e.ctx.store.tasks.require(t.id).artifact).toBeNull();
    // 검수 사본을 검수한 내용으로 되돌리고 재개 → 보관하고 완료 (다시 병합하지 않는다)
    writeFileSync(join(copy, 'report.md'), REVIEWED, 'utf8');
    rmSync(join(copy, 'reviewer-notes.md'));
    e.core.tasks.resumeByOwner(t.id, MAIN_AGENT_ID);
    await waitFor(() => e.ctx.store.tasks.require(t.id).state === 'done', '보관 뒤 완료');
    const done = e.ctx.store.tasks.require(t.id);
    expect(readFileSync(join(done.artifact!.dir, 'report.md'), 'utf8')).toBe(REVIEWED);
    expect(readdirSync(done.artifact!.dir)).toEqual(['report.md']);
    expect(e.ctx.store.execs.list({ ref1: t.id }).filter((x) => x.kind === 'git_merge')).toHaveLength(1);
  });
});
