/**
 * 메인의 일이 어느 프로젝트의 일인지 (SERVER_DESIGN 5.4, 리드 결정 S5-5 — workProjectId):
 * - 작업 키에서 프로젝트를 뽑는다(records.workProjectOf): main:P → P, task:T·review:T → T의 프로젝트, directive:D → D의 프로젝트, main:general → null
 * - 메인 턴·세션 기록은 workProjectId를 갖고(팀원 프로젝트 projectId는 그대로 null — 보고 통계·알림 링크는 바뀌지 않는다), 토큰에도 실려 도구 호출 기록이 그 프로젝트로
 *   남는다. 턴의 활동 기록(세션 시작·실행 시작·턴 끝, 종료 확인 실패의 일시정지)도 그 프로젝트로 남아 프로젝트별 기록 찾기에 나온다
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID } from '@shared/domain';
import { workProjectOf } from '../../src/main/orchestrator/records';
import { bootOrch, seedDirective, startReview, waitFor, type OrchEnv } from './orchHarness';

let env: OrchEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

describe('메인 일의 프로젝트 (workProjectId)', () => {
  it('작업 키마다 프로젝트를 뽑는다 — 없는 작업·지시와 직접 명령은 null', async () => {
    const e = (env = await bootOrch());
    const d = seedDirective(e);
    const t = e.core.tasks.create({ directiveId: d.id, title: '작업', goal: 'g', type: 'development', assigneeId: e.devId, acceptanceCriteria: ['a'], outputMode: 'repo' }, e.producerId);
    expect([
      workProjectOf(e.ctx, 'main:P-0042'),
      workProjectOf(e.ctx, `task:${t.id}`),
      workProjectOf(e.ctx, `review:${t.id}`),
      workProjectOf(e.ctx, `directive:${d.id}`),
      workProjectOf(e.ctx, 'main:general'),
      workProjectOf(e.ctx, 'task:T-9999'),
      workProjectOf(e.ctx, 'directive:D-9999'),
    ]).toEqual(['P-0042', e.projectId, e.projectId, e.projectId, null, null, null]);
  });

  it('main:P 메인 턴의 턴·세션·토큰과 턴 활동 기록이 그 프로젝트로 남는다 — projectId는 null 그대로, 프로젝트 기록 찾기에 나온다', async () => {
    const e = (env = await bootOrch());
    const p2 = (await e.internal('projects.create', { mode: 'new', path: `${e.projectDir}-둘째`, name: '둘째' })).id;
    await e.invoke('command.send', { target: p2, text: '둘째 프로젝트 명령' });
    await e.invoke('command.send', { target: 'main', text: '직접 명령' });
    await e.drain(2);
    const turns = e.ctx.store.turns.list({ ref1: MAIN_AGENT_ID });
    const keyOf = (sessionId: string) => e.ctx.store.sessions.require(sessionId).workKey;
    const pTurn = turns.find((t) => keyOf(t.sessionId) === `main:${p2}`)!;
    const gTurn = turns.find((t) => keyOf(t.sessionId) === 'main:general')!;
    expect([pTurn.projectId, pTurn.workProjectId, gTurn.projectId, gTurn.workProjectId]).toEqual([null, p2, null, null]);
    const pSession = e.ctx.store.sessions.require(pTurn.sessionId);
    expect([pSession.projectId, pSession.workProjectId]).toEqual([null, p2]);
    expect(e.ctx.store.sessions.require(gTurn.sessionId).workProjectId).toBeNull();
    // 토큰 — 도구 호출 기록(app_tool)이 이 값으로 프로젝트를 남긴다 (orchestrator.ts)
    expect([e.identity(pTurn.id).projectId, e.identity(pTurn.id).workProjectId, e.identity(gTurn.id).workProjectId]).toEqual([null, p2, null]);
    // 턴의 활동 기록: 세션 시작, 실행 시작, 턴 끝
    const rows = e.ctx.store.activity.search({ memberId: MAIN_AGENT_ID, limit: 200 });
    const ofTurn = (turnId: string, sessionId: string) => rows.filter((r) => r.turnId === turnId || (r.sessionId === sessionId && r.kind === 'session'));
    const pRows = ofTurn(pTurn.id, pTurn.sessionId);
    expect(pRows.map((r) => r.kind).sort()).toEqual(['exec', 'session', 'session'].sort());
    expect(pRows.every((r) => r.projectId === p2)).toBe(true);
    expect(ofTurn(gTurn.id, gTurn.sessionId).every((r) => r.projectId === null)).toBe(true);
    // 프로젝트 기록 찾기 — 대표의 logs.search와 메인의 search_activity
    const found = (await e.invoke('logs.search', { projectId: p2, memberId: MAIN_AGENT_ID, limit: 200 })).map((r) => r.seq);
    expect(found).toEqual(expect.arrayContaining(pRows.map((r) => r.seq)));
    const mine = (await e.main('search_activity', { project_id: p2, member_id: MAIN_AGENT_ID })) as unknown as { seq: number }[];
    expect(mine.map((r) => r.seq)).toEqual(found);
    expect((await e.invoke('logs.search', { projectId: e.projectId, memberId: MAIN_AGENT_ID, limit: 200 })).filter((r) => r.turnId === pTurn.id)).toEqual([]);
    // 보고 통계·알림 링크가 보는 projectId는 그대로라 turns.list({project_id})에 메인 턴이 섞이지 않는다
    expect(e.ctx.store.turns.list({ project_id: p2 })).toEqual([]);
  });

  it('메인 검수 턴(review:T)은 그 작업의 프로젝트, 하위 프로세스가 남은 main:P 턴의 일시정지 기록도 그 프로젝트로 남는다 (알림 링크는 그대로)', async () => {
    const e = (env = await bootOrch());
    const review = await startReview(e, MAIN_AGENT_ID);
    expect(e.ctx.store.turns.require(review.turnId)).toMatchObject({ projectId: e.projectId, workProjectId: e.projectId });
    expect(e.identity(review.turnId).workProjectId).toBe(e.projectId);
    e.hold.clear();
    review.proc.finishOk();
    await e.idle();
    // 판정 없이 끝난 검수를 다시 띄우지 않게 그 작업을 거둔다
    await e.main('cancel_task', { task_id: review.task.id });
    // main:P 턴이 하위 프로세스를 남기고 끝난다 → 메인 일시정지(CTL-11) — 그 기록은 그 프로젝트로
    const key = `main:${e.projectId}`;
    e.script.set(key, (p) => {
      p.emit({ kind: 'result', text: '끝', data: {} });
      p.exit(0, { remaining: 2 });
    });
    await e.invoke('command.send', { target: e.projectId, text: '프로젝트 명령' });
    await e.drain(1);
    await waitFor(() => !!e.ctx.stop().members[MAIN_AGENT_ID]?.paused, '메인 일시정지');
    const paused = e.ctx.store.activity.search({ kinds: ['stop'], memberId: MAIN_AGENT_ID, text: '프로세스 종료 확인 실패로 일시정지' });
    expect(paused.map((r) => r.projectId)).toEqual([e.projectId]);
    const notice = e.ctx.store.notifications.list().find((n) => n.title === '프로세스 종료 확인 실패')!;
    expect(notice.link).toBeNull();
  });
});
