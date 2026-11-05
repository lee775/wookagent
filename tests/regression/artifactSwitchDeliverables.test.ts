/**
 * 산출물형 → 저장소 변경형으로 정당하게 전환된 작업의 산출물 폴더 결과 파일 (AC-47 '독립 검수와 버전 보관', REV-05·08, 5.2).
 * 조사 작업이 결과 보고서를 산출물 폴더에 쓰고 추적 파일도 한 줄 고치면 변경형으로 전환된다. 그 보고서는 조용히 빠지지 않는다:
 * - 전환은 경고 활동으로 결과 파일을 적고, 팀원은 그 폴더를 계속 쓴다 (작업 카드·실행 위치)
 * - 대상 고정 때 그 버전의 사본을 찍어 검수 요청·get_review_target·검수 턴 실행 위치에 보인다
 * - 병합이 끝나면 검수한 사본을 보관하고 완료한다 (보관 뒤 완료 전에 끊겨도 한 번만)
 * 서비스 단계 하네스(helpers.boot) + 실제 git.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID } from '@shared/domain';
import { artifactVersionDir, artifactWorkDir } from '../../src/main/orchestrator/paths';
import type { Env } from './helpers';
import { activate, boot, commitOnMain, mergeAndSettle, newTask, pass, queued } from './helpers';
import { identityOf, restartServices, settled } from '../acceptance/git-helpers';

let env: Env | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

/** 산출물 폴더에 보고서를 쓰고 README도 고친 조사 작업을 제출해 검수 상태로 둔다 */
async function switchedInReview(e: Env) {
  commitOnMain(e, 'README.md', '# 프로젝트\n');
  const planner = e.core.team.add({ projectId: e.project.id, roleId: 'planner' }, MAIN_AGENT_ID);
  const t = await activate(e, newTask(e, { assignee: planner, type: 'research', outputMode: 'artifact' }).id);
  const workDir = artifactWorkDir(e.ctx.paths, t.projectId, t.id);
  e.core.tasks.setSteps(t.id, ['조사']);
  const report = join(workDir, 'report.md');
  mkdirSync(dirname(report), { recursive: true });
  writeFileSync(report, '# 조사 결과\n추천안: A\n', 'utf8');
  expect((await e.core.tasks.completeStep(t.id, 0, '조사', planner, null)).commitSha).toBeNull();
  writeFileSync(join(t.workspace!.worktreePath, 'README.md'), '# 프로젝트\n조사 요약: A 추천\n', 'utf8');
  e.core.tasks.requestSubmit(t.id, '제출', planner);
  await e.core.tasks.processSubmission(t.id);
  const inReview = e.ctx.store.tasks.require(t.id);
  expect(inReview).toMatchObject({ state: 'in_review', outputMode: 'repo', review: { target: { kind: 'repo' } } });
  return { planner, t: inReview, workDir, report };
}

describe('산출물형에서 전환된 작업의 산출물 폴더 결과 파일 (AC-47)', () => {
  it('전환은 결과 파일을 경고로 남기고, 그 버전의 사본을 검수 요청·검수 대상에 보이며, 병합이 끝나면 검수한 사본을 보관해 완료한다', async () => {
    env = await boot();
    const e = env;
    const { planner, t, workDir, report } = await switchedInReview(e);
    const acts = e.ctx.store.activity.search({ taskId: t.id, text: '산출물형 → 저장소 변경형 전환' });
    expect(acts).toHaveLength(1);
    expect(acts[0]).toMatchObject({ level: 'warn' });
    expect(acts[0]!.text).toContain('report.md');
    // 팀원은 계속 그 폴더를 쓴다
    const card = e.core.tools.workContext(identityOf(planner, `task:${t.id}`), planner).task!;
    expect(card.artifactDir).toBe(workDir);

    // 고정한 버전의 사본 — 검수 요청과 get_review_target에 보인다
    const copy = e.core.tasks.deliverablesCopyOf(t)!;
    expect(copy).toBeTruthy();
    expect(readFileSync(join(copy, 'report.md'), 'utf8')).toBe('# 조사 결과\n추천안: A\n');
    const [req] = queued(e, (q) => q.kind === 'review' && q.taskId === t.id);
    expect(req?.message).toContain(copy);
    expect(req?.message).toContain('report.md');
    const reviewer = e.ctx.store.members.require(t.reviewerId!);
    const target = await e.core.tools.handle(identityOf(reviewer, `review:${t.id}`), 'get_review_target', { task_id: t.id });
    expect(target).toMatchObject({ ok: true, data: { artifactCopyPath: copy, artifacts: [{ path: 'report.md' }] } });
    expect((await e.core.views.taskDetail(t.id)).reviewNotes).toEqual({ uncheckedConflictFiles: [], deliverables: { dir: copy, files: ['report.md'] } });

    // 검수 뒤 작업 폴더가 바뀌어도 보관본은 검수한 사본이다
    writeFileSync(report, '검수 뒤 고친 내용\n', 'utf8');
    pass(e, t.id);
    const done = await mergeAndSettle(e, t.id);
    expect(done.state).toBe('done');
    expect(done.merge).not.toBeNull();
    expect(done.artifact).toMatchObject({ version: 1, dir: artifactVersionDir(e.ctx.paths, t.projectId, t.id, 1), files: [{ path: 'report.md' }] });
    expect(readFileSync(join(done.artifact!.dir, 'report.md'), 'utf8')).toBe('# 조사 결과\n추천안: A\n');
    expect((await e.core.views.taskDetail(t.id)).artifact).toMatchObject({ version: 1, files: ['report.md'] });
    expect(existsSync(copy)).toBe(false); // 완료 정리로 검수 사본은 지워진다 (보관본은 남는다)
    expect(e.errors).toEqual([]);
  });

  it('보관 뒤 완료 기록 전에 앱이 꺼져도 재시작 뒤 다시 병합하지 않고 완료하며 보관본은 한 벌이다', async () => {
    env = await boot();
    let e = env;
    const { t } = await switchedInReview(e);
    pass(e, t.id);
    // main 반영 → 기록 → (보관) → 완료 전에 끊긴다: 완료 전이를 막아 흉내 낸다
    const g = e.ctx.deps.git;
    const orig = g.removeWorktree.bind(g);
    let archivedBeforeCut = false;
    g.removeWorktree = async (repo, path) => {
      // 완료 뒤 정리(작업 폴더 지우기)에 닿기 전 = 완료 직후. 여기서 멈추면 '완료 뒤 정리 중에 끊김'
      archivedBeforeCut = !!e.ctx.store.tasks.require(t.id).artifact;
      return orig(repo, path);
    };
    await mergeAndSettle(e, t.id);
    expect(archivedBeforeCut).toBe(true); // 보관이 완료(정리)보다 먼저다
    const done = e.ctx.store.tasks.require(t.id);
    expect(done.state).toBe('done');

    // 같은 작업에서 보관만 하고 완료 전에 끊긴 상태를 만든다: 완료를 되돌려 검수 상태로 둔다 (보관 기록은 남김)
    e.ctx.store.tasks.put({ ...done, state: 'in_review', completedAt: null });
    e = env = await restartServices(e);
    const again = await settled(e.core, t.id);
    expect(again.state).toBe('done');
    expect(again.artifact?.version).toBe(1);
    expect(readdirSync(join(e.ctx.paths.artifacts, t.projectId, t.id)).filter((n) => n.startsWith('v'))).toEqual(['v1']);
    expect(e.ctx.store.execs.list({ ref1: t.id }).filter((x) => x.kind === 'git_merge')).toHaveLength(1);
  });
});
