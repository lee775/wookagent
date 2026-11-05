/**
 * 조건 변경에서 더해지거나 바뀐 조건은 통과를 받을 때까지 쌓인다 (REV-03, AC-43, 검수 규칙 '확인하지 못한 조건은 통과로 처리하지 않는다'):
 * 다음 검수 전에 조건을 또 바꿔도(조건 더하기·순서 바꾸기) 앞 변경에서 바뀐 조건은 같은 글의 결과로만 덮이고, 이어진 검수 세션이 이전 목록을
 * 제 말로 옮겨 적은 통과는 받지 않는다. 바뀐 조건까지 같은 글로 적은 통과가 기록되면 비운다 — 그 뒤에는 그 검수자가 지금 목록을 본 것이라
 * 바뀌지 않은 조건처럼 자리로도 덮인다.
 * 순수 규칙 + 서비스 단계 하네스(helpers.boot, 실제 git) — 앱 도구(update_task 두 번 → 다시 제출 → submit_review) 경로로 판정한다.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CriterionResult } from '@shared/domain';
import { changedCriteria, uncoveredCriteria } from '@core/reviewRules';
import { identityOf } from '../acceptance/git-helpers';
import { activate, boot, newDirective, type Env } from './helpers';

let env: Env | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const OLD = ['문서가 있다', '요약이 있다'];
const NOW = ['문서가 있다', '목차가 있다'];
const ADDED = [...NOW, '표가 있다'];
const REORDERED = ['목차가 있다', '문서가 있다'];
const r = (criterion: string, pass = true): CriterionResult => ({ criterion, pass, note: '확인' });

describe('바뀐 조건은 통과를 받을 때까지 쌓인다 (REV-03)', () => {
  it('규칙: 두 번째 변경(더하기·순서 바꾸기)도 첫 변경의 조건을 남기고, 목록에서 빠진 조건만 뗀다', () => {
    const first = changedCriteria(OLD, NOW);
    expect(first).toEqual(['목차가 있다']);
    const added = changedCriteria(NOW, ADDED, first);
    expect(added).toEqual(['목차가 있다', '표가 있다']);
    expect(uncoveredCriteria(ADDED, [r('문서 확인함'), r('요약 확인함'), r('표가 있다')], ['요약이 있다'], added)).toEqual(['목차가 있다']);
    const reordered = changedCriteria(NOW, REORDERED, first);
    expect(reordered).toEqual(['목차가 있다']);
    expect(uncoveredCriteria(REORDERED, [r('문서 확인함'), r('요약 확인함')], ['요약이 있다'], reordered)).toEqual(['목차가 있다']);
    // 같은 글(번호·공백 정리)이면 덮는다. 목록에서 빠진 바뀐 조건은 남기지 않는다
    expect(uncoveredCriteria(ADDED, [r('문서 확인함'), r('2. 목차가 있다'), r('표가 있다')], ['요약이 있다'], added)).toEqual([]);
    expect(changedCriteria(ADDED, ['문서가 있다', '표가 있다'], added)).toEqual(['표가 있다']);
  });

  for (const [label, second, stale, exact, later] of [
    ['조건을 하나 더함', ADDED, [r('문서 확인함'), r('요약 확인함'), r('표가 있다')], [r('문서 확인함'), r('목차가 있다'), r('표가 있다')], [r('문서 확인함'), r('목차 확인함'), r('표 확인함')]],
    ['순서만 바꿈', REORDERED, [r('문서 확인함'), r('요약 확인함')], [r('목차가 있다'), r('문서 확인함')], [r('목차 확인함'), r('문서 확인함')]],
  ] as const) {
    it(`update_task 두 번(요약→목차, 그다음 ${label}) 뒤 다시 제출한 버전에 이전 목록을 제 말로 옮긴 통과는 받지 않는다 — 바뀐 조건 글로 통과하면 비운다`, async () => {
      env = await boot({ team: ['developer', 'qa'] });
      const e = env;
      const [dev, qa] = e.members as [Env['members'][number], Env['members'][number]];
      const directiveId = newDirective(e);
      const t0 = e.core.tasks.create(
        { directiveId, title: '문서 작업', goal: '문서 정리', type: 'docs', assigneeId: dev.id, reviewerId: qa.id, acceptanceCriteria: OLD, outputMode: 'repo' },
        e.producer.id,
      );
      const t = await activate(e, t0.id);
      e.core.tasks.setSteps(t.id, ['문서']);
      writeFileSync(join(t.workspace!.worktreePath, 'doc.md'), '# 문서\n요약\n', 'utf8');
      await e.core.tasks.completeStep(t.id, 0, '문서', dev, null);
      const submit = async () => {
        e.core.tasks.requestSubmit(t.id, '제출', dev);
        await e.core.tasks.processSubmission(t.id);
        expect(e.ctx.store.tasks.require(t.id).state).toBe('in_review');
      };
      await submit(); // V1 — 검수자는 OLD를 받았다

      const pd = identityOf(e.producer, `directive:${directiveId}`);
      expect(await e.core.tools.handle(pd, 'update_task', { task_id: t.id, acceptance_criteria: NOW })).toMatchObject({ ok: true });
      // 다음 검수 전에 조건을 또 바꾼다 → 첫 변경의 '목차가 있다'도 바뀐 조건으로 남는다
      expect(await e.core.tools.handle(pd, 'update_task', { task_id: t.id, acceptance_criteria: [...second] })).toMatchObject({ ok: true });
      expect(e.ctx.store.tasks.require(t.id).changedCriteria).toContain('목차가 있다');
      writeFileSync(join(t.workspace!.worktreePath, 'doc.md'), '# 문서\n목차\n표\n', 'utf8');
      await submit(); // V2

      const who = identityOf(qa, `review:${t.id}`);
      const res = await e.core.tools.handle(who, 'submit_review', { task_id: t.id, verdict: 'pass', criteria: [...stale], reason: '' });
      expect(res).toMatchObject({ ok: false, code: 'invalid' });
      expect(res.ok ? '' : res.message).toContain('"목차가 있다"');
      expect(e.ctx.store.tasks.require(t.id).review.passed).toBeNull();
      expect(e.ctx.store.reviews.list({ ref1: t.id })).toEqual([]);

      // 바뀐 조건을 같은 글로 적은 통과는 받고, 쌓인 바뀐 조건을 비운다
      expect(await e.core.tools.handle(who, 'submit_review', { task_id: t.id, verdict: 'pass', criteria: [...exact], reason: '' })).toMatchObject({ ok: true });
      expect(e.ctx.store.tasks.require(t.id)).toMatchObject({ changedCriteria: [], review: { passed: { reviewerId: qa.id } } });

      // 그 뒤 목표만 바뀌어 다시 제출한 V3 — 검수자는 지금 목록을 V2에서 판정했으므로 제 말로 적은 결과도 자리로 덮인다
      expect(await e.core.tools.handle(pd, 'update_task', { task_id: t.id, goal: '문서 정리 (목표 수정)' })).toMatchObject({ ok: true });
      expect(e.ctx.store.tasks.require(t.id).state).toBe('in_progress');
      writeFileSync(join(t.workspace!.worktreePath, 'doc.md'), '# 문서\n목차\n표\n끝\n', 'utf8');
      await submit();
      expect(await e.core.tools.handle(who, 'submit_review', { task_id: t.id, verdict: 'pass', criteria: [...later], reason: '' })).toMatchObject({ ok: true });
      expect(e.ctx.store.reviews.list({ ref1: t.id })).toHaveLength(2);
      expect(e.errors).toEqual([]);
    }, 120_000);
  }
});
