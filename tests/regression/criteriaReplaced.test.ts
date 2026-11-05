/**
 * 통과는 지금 완료 조건마다 통과 결과가 있어야 한다 — 바뀌거나 빠진 이전 조건의 결과, 빈 글의 결과는 지금 조건을 덮지 않는다 (REV-03, AC-43,
 * 검수 규칙 '확인하지 못한 조건은 통과로 처리하지 않는다').
 * - 완료 조건을 바꾸면(update_task·replan_task) 빠진 조건 글을 작업에 남긴다 (formerCriteria)
 * - 같은 자리로 조건을 덮는 것(조건 글을 조금 바꿔 적은 결과)은 그 결과의 글이 이 작업의 이전 조건이 아닐 때만 — 검수 세션이 차수를 넘어 이어지므로
 *   검수자가 이전 조건 목록으로 통과를 적어도 새 조건이 통과로 묶이지 않는다. 마지막 조건 변경에서 더해지거나 바뀐 조건은 자리로 덮지 않는다
 *   (같은 글만, criteriaChangedText.test.ts)
 * - 공백·번호뿐인 글의 결과는 아무 조건도 덮지 않는다
 * 순수 규칙 + 서비스 단계 하네스(helpers.boot, 실제 git) — 앱 도구(submit_review) 경로로 판정한다.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CriterionResult } from '@shared/domain';
import { uncoveredCriteria } from '@core/reviewRules';
import { identityOf } from '../acceptance/git-helpers';
import { activate, boot, consumeQueued, newDirective, type Env } from './helpers';

let env: Env | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const NOW = ['문서가 있다', '목차가 있다'];
const OLD = ['문서가 있다', '요약이 있다'];
const r = (criterion: string, pass = true): CriterionResult => ({ criterion, pass, note: '확인' });

describe('이전 조건·빈 글의 결과는 지금 조건을 덮지 않는다 (REV-03)', () => {
  it('규칙: 바뀐 조건 자리의 이전 조건 결과는 덮지 않고, 조건 글을 조금 바꿔 적은 결과는 자리로 덮으며, 빈 글은 아무것도 덮지 않는다', () => {
    // 이전 조건 목록으로 적은 통과 — '요약이 있다'는 이 작업의 이전 조건이라 그 자리의 '목차가 있다'를 덮지 않는다
    expect(uncoveredCriteria(NOW, OLD.map((c) => r(c)), ['요약이 있다'])).toEqual(['목차가 있다']);
    // 조건 글을 조금 바꿔 적은 결과는 (이전 조건이 아니면) 자리로 덮는다
    expect(uncoveredCriteria(NOW, [r('문서 확인함'), r('목차 확인함')], ['요약이 있다'])).toEqual([]);
    // 같은 글이면 순서와 관계없이 덮는다 — 이전 조건이 다시 조건이 된 경우도
    expect(uncoveredCriteria(OLD, [r('요약이 있다'), r('문서가 있다')], ['요약이 있다'])).toEqual([]);
    // 빈 글(공백·번호뿐)의 결과는 자리로도 글로도 덮지 않는다
    expect(uncoveredCriteria(NOW, [r(''), r('   ')])).toEqual(NOW);
    expect(uncoveredCriteria(NOW, [r('1.'), r(' - ')])).toEqual(NOW);
    expect(uncoveredCriteria(NOW, [r('문서가 있다'), r('')])).toEqual(['목차가 있다']);
  });

  it('완료 조건을 바꾼 뒤 다시 제출한 버전에 이전 조건 목록으로 적은 통과는 받지 않는다 — 바뀐 조건을 적으면 받는다', async () => {
    env = await boot({ team: ['developer', 'qa'] });
    const e = env;
    const [dev, qa] = e.members as [Env['members'][number], Env['members'][number]];
    const t0 = e.core.tasks.create(
      { directiveId: newDirective(e), title: '문서 작업', goal: '문서 정리', type: 'docs', assigneeId: dev.id, reviewerId: qa.id, acceptanceCriteria: OLD, outputMode: 'repo' },
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
    await submit(); // V1 — 검수자는 ['문서가 있다', '요약이 있다']를 받았다

    // 검수 중 완료 조건이 바뀜(요약 → 목차): 진행으로 돌아가고 빠진 조건 글이 남는다 → 다시 제출해 V2
    e.core.tasks.update(t.id, { acceptanceCriteria: NOW }, e.producer.id);
    expect(e.ctx.store.tasks.require(t.id)).toMatchObject({ state: 'in_progress', acceptanceCriteria: NOW, formerCriteria: ['요약이 있다'] });
    consumeQueued(e, `task:${t.id}`);
    writeFileSync(join(t.workspace!.worktreePath, 'doc.md'), '# 문서\n목차\n', 'utf8');
    await submit();

    // 검수 세션이 이어져 이전 목록으로 통과를 적는다 → '목차가 있다'를 판정하지 않은 통과
    const who = identityOf(qa, `review:${t.id}`);
    const stale = await e.core.tools.handle(who, 'submit_review', { task_id: t.id, verdict: 'pass', criteria: OLD.map((c) => r(c)), reason: '' });
    expect(stale).toMatchObject({ ok: false, code: 'invalid' });
    expect(stale.ok ? '' : stale.message).toContain('"목차가 있다"');
    expect(e.ctx.store.tasks.require(t.id).review.passed).toBeNull();
    // 빈 글로 적은 통과도 받지 않는다
    const blank = await e.core.tools.handle(who, 'submit_review', { task_id: t.id, verdict: 'pass', criteria: NOW.map(() => r('')), reason: '' });
    expect(blank).toMatchObject({ ok: false, code: 'invalid' });

    // 바뀐 조건('목차가 있다')은 같은 글의 결과로만 덮인다 — 그 자리에 제 말로 적은 결과는 받지 않는다 (criteriaChangedText.test.ts)
    const para = await e.core.tools.handle(who, 'submit_review', { task_id: t.id, verdict: 'pass', criteria: [r('문서가 있다'), r('목차 확인함')], reason: '' });
    expect(para).toMatchObject({ ok: false, code: 'invalid' });
    // 지금 조건을 적으면 받는다 — 바뀌지 않은 조건은 글을 조금 바꿔 적어도(자리로) 덮고, 바뀐 조건은 번호를 붙여도 같은 글이면 덮는다.
    // 판정 기록의 조건별 결과에 바뀐 조건이 남는다 (REV-03)
    const ok = await e.core.tools.handle(who, 'submit_review', { task_id: t.id, verdict: 'pass', criteria: [r('문서 확인함'), r('2. 목차가 있다')], reason: '' });
    expect(ok).toMatchObject({ ok: true });
    expect(e.ctx.store.tasks.require(t.id).review.passed?.reviewerId).toBe(qa.id);
    const stored = e.ctx.store.reviews.list({ ref1: t.id }).map((x) => x.criteria.map((c) => c.criterion));
    expect(stored).toEqual([['문서 확인함', '2. 목차가 있다']]);
    expect(e.errors).toEqual([]);
  }, 120_000);
});
