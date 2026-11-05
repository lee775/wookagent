/**
 * 마지막 완료 조건 변경(update_task·replan_task)에서 더해지거나 바뀐 조건은 같은 글의 검수 결과로만 덮인다 — 같은 자리의 결과로 덮지 않는다
 * (REV-03, AC-43, 검수 규칙 '확인하지 못한 조건은 통과로 처리하지 않는다'). 검수 세션이 차수를 넘어 이어지므로 검수자가 이전 조건 목록을 제 말로
 * 옮기거나 이전 조건 글에 덧붙여 적은 통과가 바뀐 조건까지 통과로 묶이면 안 된다. 바뀌지 않은 조건은 지금처럼 자리로도 덮인다(조건 글을 조금 바꿔
 * 적은 결과). 대표 검수는 작업 화면이 조건마다 글 그대로 보낸다.
 * 순수 규칙 + 서비스 단계 하네스(helpers.boot, 실제 git) — 앱 도구(update_task → 다시 제출 → submit_review) 경로로 판정한다.
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
const r = (criterion: string, pass = true): CriterionResult => ({ criterion, pass, note: '확인' });

describe('더해지거나 바뀐 조건은 같은 글로만 덮인다 (REV-03)', () => {
  it('규칙: 바뀐 조건 자리의 이전 조건 바꿔 쓰기·덧붙인 글·제 말 결과는 덮지 않고, 같은 글(번호·공백 정리)이면 덮는다 — 바뀌지 않은 조건은 자리로 덮는다', () => {
    const changed = changedCriteria(OLD, NOW);
    expect(changed).toEqual(['목차가 있다']);
    const former = ['요약이 있다'];
    expect(uncoveredCriteria(NOW, [r('문서가 있다'), r('요약 확인함')], former, changed)).toEqual(['목차가 있다']);
    expect(uncoveredCriteria(NOW, [r('문서가 있다'), r('요약이 있다 — 충족')], former, changed)).toEqual(['목차가 있다']);
    expect(uncoveredCriteria(NOW, [r('문서 확인함'), r('목차 확인함')], former, changed)).toEqual(['목차가 있다']);
    expect(uncoveredCriteria(NOW, [r('문서 확인함'), r(' 2)  목차가   있다 ')], former, changed)).toEqual([]);

    // 바뀐 조건은 통과를 받을 때까지 쌓인다 — 목록이 그대로면(번호·공백만 다름) 앞 변경의 것을 두고, 새 조건을 더하면 앞 변경의 것에 더해진다
    expect(changedCriteria(NOW, ['1. 문서가 있다', '2.  목차가 있다'], changed)).toEqual(['목차가 있다']);
    const more = changedCriteria(NOW, [...NOW, '색인이 있다'], changed);
    expect(more).toEqual(['목차가 있다', '색인이 있다']);
    expect(uncoveredCriteria([...NOW, '색인이 있다'], [r('문서 확인함'), r('목차 확인함'), r('색인 확인함')], former, more)).toEqual(['목차가 있다', '색인이 있다']);
  });

  it('update_task로 조건을 바꾼 뒤 다시 제출한 버전에, 이전 목록을 제 말로 옮기거나 덧붙여 적은 통과는 받지 않는다 — 바뀐 조건 글을 적으면 받는다', async () => {
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
    await submit(); // V1 — 검수자는 ['문서가 있다', '요약이 있다']를 받았다

    // 프로듀서가 앱 도구로 완료 조건을 바꾼다(요약 → 목차) → 진행으로 돌아가고 바뀐 조건이 남는다 → 다시 제출해 V2
    const pd = identityOf(e.producer, `directive:${directiveId}`);
    const up = await e.core.tools.handle(pd, 'update_task', { task_id: t.id, acceptance_criteria: NOW });
    expect(up).toMatchObject({ ok: true });
    expect(e.ctx.store.tasks.require(t.id)).toMatchObject({ state: 'in_progress', acceptanceCriteria: NOW, formerCriteria: ['요약이 있다'], changedCriteria: ['목차가 있다'] });
    writeFileSync(join(t.workspace!.worktreePath, 'doc.md'), '# 문서\n목차\n', 'utf8');
    await submit();

    // 이어진 검수 세션이 이전 목록을 제 말로 옮기거나 이전 조건 글에 덧붙여 통과를 적는다 → '목차가 있다'를 판정하지 않은 통과
    const who = identityOf(qa, `review:${t.id}`);
    for (const criteria of [
      [r('문서 확인함'), r('요약 확인함')],
      [r('문서가 있다'), r('요약이 있다 — 충족')],
    ]) {
      const res = await e.core.tools.handle(who, 'submit_review', { task_id: t.id, verdict: 'pass', criteria, reason: '' });
      expect(res).toMatchObject({ ok: false, code: 'invalid' });
      expect(res.ok ? '' : res.message).toContain('"목차가 있다"');
    }
    expect(e.ctx.store.tasks.require(t.id).review.passed).toBeNull();
    expect(e.ctx.store.reviews.list({ ref1: t.id })).toEqual([]);

    // 바뀐 조건 글을 적으면 받는다 — 바뀌지 않은 조건은 제 말로 적어도 자리로 덮인다. 판정 기록에 바뀐 조건이 남는다
    const ok = await e.core.tools.handle(who, 'submit_review', { task_id: t.id, verdict: 'pass', criteria: [r('문서 확인함'), r('목차가 있다')], reason: '' });
    expect(ok).toMatchObject({ ok: true });
    expect(e.ctx.store.tasks.require(t.id).review.passed?.reviewerId).toBe(qa.id);
    expect(e.ctx.store.reviews.list({ ref1: t.id }).map((x) => x.criteria.map((c) => c.criterion))).toEqual([['문서 확인함', '목차가 있다']]);
    expect(e.errors).toEqual([]);
  }, 120_000);
});
