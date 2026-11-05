/**
 * 산출물형 → 저장소 변경형 전환은 그 작업이 바꾼 것만 본다 (5.2 '산출물형이라도 추적 파일이 바뀌면 변경형으로 전환', AC-47).
 * 작업 브랜치가 main에서 갈라진 지점 이후의 변경만 세므로, 그 뒤에 다른 작업이 main을 움직여도 전환하지 않고(완료 기준 테스트),
 * 이 작업이 브랜치에 남긴 변경은 main이 움직였어도 놓치지 않는다 (이 파일). 서비스 + 실제 git (helpers.boot).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID } from '@shared/domain';
import { artifactWorkDir } from '../../src/main/orchestrator/paths';
import type { Env } from './helpers';
import { activate, boot, commitOnMain, git, newTask } from './helpers';

let env: Env | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

describe('산출물형 작업의 변경형 전환 (AC-47)', () => {
  it('작업 브랜치에 이 작업의 커밋이 있으면 그 뒤 main이 움직였어도 제출 처리에서 변경형으로 전환해 최신 main 반영·검수 대상 고정을 한다', async () => {
    env = await boot();
    const e = env;
    commitOnMain(e, 'README.md', '# 프로젝트\n');
    const planner = e.core.team.add({ projectId: e.project.id, roleId: 'planner' }, MAIN_AGENT_ID);
    const t = await activate(e, newTask(e, { assignee: planner, type: 'research', outputMode: 'artifact' }).id);
    const wt = t.workspace!.worktreePath;
    e.core.tasks.setSteps(t.id, ['조사']);
    const report = join(artifactWorkDir(e.ctx.paths, t.projectId, t.id), 'report.md');
    mkdirSync(dirname(report), { recursive: true });
    writeFileSync(report, '조사 결과\n', 'utf8');
    expect((await e.core.tasks.completeStep(t.id, 0, '조사', planner, null)).commitSha).toBeNull();
    // 프로그램을 거치지 않고 저장소 파일을 커밋해 둔 작업 (작업 폴더는 깨끗하다) — 그 뒤 다른 작업이 main을 움직인다
    writeFileSync(join(wt, 'README.md'), '# 프로젝트\n조사 요약\n', 'utf8');
    git(wt, ['-c', 'user.name=agent', '-c', 'user.email=a@a', 'commit', '-qam', '직접 커밋']);
    const moved = commitOnMain(e, 'other.txt', '다른 작업\n');
    expect(git(wt, ['status', '--porcelain'])).toBe('');

    e.core.tasks.requestSubmit(t.id, '제출', planner);
    await e.core.tasks.processSubmission(t.id);
    const cur = e.ctx.store.tasks.require(t.id);
    expect(cur.state).toBe('in_review');
    expect(cur.outputMode).toBe('repo');
    expect(cur.review.target?.kind === 'repo' && cur.review.target.baseMainSha).toBe(moved);
    expect(e.ctx.store.activity.search({ taskId: t.id, text: '산출물형 → 저장소 변경형 전환' })).toHaveLength(1);
  });
});
