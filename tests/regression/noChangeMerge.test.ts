/**
 * 변경 없는 저장소 변경형 작업 (spec:F4, GIT-05, AC-47): 병합할 변경이 없으면 빈 병합 커밋 없이 검수 통과 기록만으로 완료.
 * 예전에는 mergeIntoBase가 '병합할 변경이 없습니다'로 실패해 병합 보류 + 긴급 '병합 실패'로 멈췄다.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { MAIN_AGENT_ID } from '@shared/domain';
import type { Env } from './helpers';
import { boot, commitOnMain, git, mainSha, mergeAndSettle, mergeCommitsFor, notices, passedTask } from './helpers';

let env: Env | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

describe('변경 없는 저장소 작업의 완료 (F4)', () => {
  it('파일 변경 없음 + 기준 main 그대로 → 병합 커밋 없이 완료, 작업 공간 정리, 회차 마감 가능', async () => {
    env = await boot({ team: ['qa'] });
    const e = env;
    const directiveId = e.core.directives.register({ projectId: e.project.id, title: 'QA 확인', text: '확인' }, MAIN_AGENT_ID, null).id;
    const before = mainSha(e);
    const t = await passedTask(e, { directiveId, type: 'test', file: null, reviewer: 'main' });
    const done = await mergeAndSettle(e, t.id);
    expect(done.state).toBe('done');
    expect(done.merge).toBeNull();
    expect(mainSha(e)).toBe(before);
    expect(existsSync(t.workspace!.worktreePath)).toBe(false);
    expect(git(e.projectDir, ['branch', '--list', t.workspace!.branch])).toBe('');
    expect(notices(e, '병합 실패')).toHaveLength(0);
    // 끝난 작업으로 회차가 마감된다
    const d = e.core.directives.submitFinalResult({ directiveId, summary: '확인 완료', outputs: [], changedFiles: [], issues: [], nextSteps: [] }, e.producer, null);
    expect(d.state).toBe('reporting');
  });

  it('파일 변경 없음 + 제출 전에 main이 바뀜 → 최신 main 반영 커밋만 있는 작업도 병합 커밋 없이 완료', async () => {
    env = await boot({ team: ['qa'] });
    const e = env;
    commitOnMain(e, 'other.txt', '다른 작업\n');
    const t = await passedTask(e, { type: 'test', file: null, reviewer: 'main' });
    const before = mainSha(e);
    const done = await mergeAndSettle(e, t.id);
    expect(done.state).toBe('done');
    expect(done.merge).toBeNull();
    expect(mainSha(e)).toBe(before);
    expect(git(e.projectDir, ['log', '--format=%s', e.project.baseBranch])).not.toContain(`[${t.id}]`);
  });

  it('변경이 있는 작업은 그대로 작업별 병합 커밋으로 남는다', async () => {
    env = await boot();
    const e = env;
    const t = await passedTask(e, { file: 'fix.txt', reviewer: 'main' });
    const done = await mergeAndSettle(e, t.id);
    expect(done.state).toBe('done');
    expect(done.merge?.mergeCommitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(mergeCommitsFor(e, t.id)).toBe(1);
    expect(git(e.projectDir, ['diff', '--name-only', done.merge!.preMainSha, done.merge!.mergeCommitSha])).toBe('fix.txt');
  });
});
