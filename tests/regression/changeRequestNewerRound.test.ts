/**
 * 새 회차가 이미 열린 지시의 이전 회차 보고서에는 수정 요청을 받지 않는다 (리드 결정 34, 10-30 — flows 재리뷰 low, 프로브 zz-s1fx3fg-report-states):
 * - 끝난 업무 판정(deadWorkReason, 리드 결정 19)은 지시에 그 보고서보다 새 회차가 열린 수정 요청을 끝난 업무로 본다. 그런데 reports.requestChanges와 화면의
 *   canRequestChanges는 끝났거나 취소된 지시만 거부해서, 이전 회차의 '새 보고서'·'읽음' 보고서에 받은 수정 요청은 태어날 때부터 끝난 업무였다 — 스케줄러가
 *   메인 턴에 싣기 전에 지웠고, 대표는 '수정 요청됨'만 보았다
 * - 이제 requestChangesRefusal이 그 조건도 conflict로 거부하고(새 회차가 이미 열렸다는 글), canRequestChanges도 같은 판정이다. 지금 회차 보고서는 그대로 받는다
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Directive, DirectiveState, Report } from '@shared/domain';
import { deadWorkReason } from '../../src/main/orchestrator/turns';
import { bootOrch, seedDirective, type OrchEnv } from './orchHarness';

let env: OrchEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const OPEN: DirectiveState[] = ['received', 'planning', 'in_progress', 'reporting', 'awaiting_confirmation'];

/** 지시(state, 회차 round)와 그 지시 1회차 보고서(status). round 2면 1회차 보고서는 이전 회차다 */
function seedPair(e: OrchEnv, state: DirectiveState, status: Report['status'], round: 1 | 2): { d: Directive; r: Report } {
  const ctx = e.ctx;
  const base = seedDirective(e, `${state}-${status}-${round}`);
  const now = ctx.now();
  const r = {
    id: ctx.store.nextId('report'),
    projectId: e.projectId,
    directiveId: base.id,
    round: 1,
    title: '보고',
    filePath: 'x.md',
    status,
    sections: { summary: 's', results: 'r', changedFiles: [], howToVerify: '-', issues: '-', nextSteps: '-' },
    stats: { taskCount: 0, rejectCount: 0, durationSec: 0, inputTokens: 0, outputTokens: 0, costUsd: null },
    createdAt: now,
    readAt: null,
    decidedAt: null,
  } as Report;
  ctx.store.reports.insert(r);
  const rounds = [{ round: 1, requestedAt: now, text: 't', anchored: [], reportId: r.id }, ...(round === 2 ? [{ round: 2, requestedAt: now, text: 't2', anchored: [], reportId: null }] : [])];
  const d = { ...base, state, round, rounds } as Directive;
  ctx.store.directives.put(d);
  return { d, r };
}
const codeOf = (p: Promise<unknown>) =>
  p.then(
    () => ({ code: 'ok', message: '' }),
    (err: { code?: string; message?: string }) => ({ code: err.code ?? 'error', message: err.message ?? '' }),
  );

describe('새 회차가 열린 지시의 이전 회차 보고서에는 수정 요청을 받지 않는다 (리드 결정 34)', () => {
  it.each(OPEN.flatMap((state) => (['new', 'read'] as const).map((status) => [state, status] as const)))(
    '지시 %s, 1회차 보고서 %s — conflict(새 회차 글), canRequestChanges false, 아무것도 바뀌지 않음',
    async (state, status) => {
      const e = (env = await bootOrch());
      const { d, r } = seedPair(e, state, status, 2);
      expect((await e.invoke('reports.get', r.id)).canRequestChanges).toBe(false);
      expect(await codeOf(e.invoke('reports.requestChanges', r.id, { overall: '표로 바꿔 주세요', anchored: [] }))).toEqual({
        code: 'conflict',
        message: `지시 ${d.id}의 2회차가 이미 열려 있어 1회차 보고서에는 수정 요청을 할 수 없습니다. 바꿀 것이 있으면 명령창으로 메인 에이전트에게 말해 주세요`,
      });
      expect(e.ctx.store.reports.require(r.id).status).toBe(status);
      expect(e.ctx.store.reportComments.list({ ref1: r.id })).toEqual([]);
      expect(e.ctx.store.queue.list().filter((q) => q.kind === 'change_request')).toEqual([]);
    },
  );

  it('지금 회차 보고서는 그대로 받고, 받은 수정 요청은 끝난 업무가 아니다 — canRequestChanges가 처리와 같다', async () => {
    const e = (env = await bootOrch());
    for (const state of OPEN) {
      const { r } = seedPair(e, state, 'new', 1);
      expect((await e.invoke('reports.get', r.id)).canRequestChanges).toBe(true);
      expect((await codeOf(e.invoke('reports.requestChanges', r.id, { overall: '표로 바꿔 주세요', anchored: [] }))).code).toBe('ok');
      const cr = e.ctx.store.queue.list().filter((q) => q.kind === 'change_request' && q.reportId === r.id);
      expect(cr).toHaveLength(1);
      expect(deadWorkReason(e.ctx, cr[0]!)).toBeNull();
      expect((await e.invoke('reports.get', r.id)).canRequestChanges).toBe(false);
      e.ctx.store.queue.put({ ...cr[0]!, state: 'cancelled' });
    }
  });
});
