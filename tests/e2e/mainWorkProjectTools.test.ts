/**
 * 메인의 도구 호출 기록이 그 대화의 프로젝트로 남는다 (SERVER_DESIGN 5.4, 리드 결정 S5-5) — 실제 앱 도구 서버와 모의 메인 에이전트로: main:P 대화 턴이 부른
 * 도구(app_tool 기록)는 그 프로젝트로 남아 대표의 logs.search({projectId})와 메인의 search_activity({project_id})에 나온다. 직접 명령(main:general) 턴의
 * 기록은 프로젝트가 없다. 메인 턴·세션 기록의 projectId는 그대로 null이다
 */
import { describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID } from '@shared/domain';
import { createHarness } from './harness';

describe('메인 도구 호출 기록의 프로젝트 (workProjectId)', () => {
  it('main:P 턴의 app_tool 기록은 그 프로젝트로 남아 기록 찾기에 나오고, 직접 명령 턴의 기록은 프로젝트가 없다', async () => {
    const h = await createHarness({ team: [] });
    try {
      const ctx = h.core.ctx;
      const p2 = (await h.internal('projects.create', { mode: 'new', path: `${h.projectDir}-둘째`, name: '둘째' })).id;
      await h.internal('projects.setMock', p2, { enabled: true, speed: 25, defaultScenario: 'normal' });
      await h.invoke('command.send', { target: p2, text: '둘째 프로젝트에 로그인 화면을 만들어 줘' });
      await h.waitFor(() => ctx.store.directives.list({ project_id: p2 }).length === 1, { label: '둘째 프로젝트 지시 등록' });
      await h.invoke('command.send', { target: 'main', text: '오늘 할 일을 정리해 줘' });
      const sessionOf = (key: string) => ctx.store.sessions.list({ ref1: MAIN_AGENT_ID, ref2: key })[0];
      await h.waitFor(() => !!sessionOf('main:general') && ctx.store.turns.list({ ref2: sessionOf('main:general')!.id }).some((t) => !!t.endedAt), { label: '직접 명령 턴' });
      const pTurn = ctx.store.turns.list({ ref2: sessionOf(`main:${p2}`)!.id })[0]!;
      const gTurn = ctx.store.turns.list({ ref2: sessionOf('main:general')!.id })[0]!;
      expect([pTurn.projectId, pTurn.workProjectId, gTurn.workProjectId]).toEqual([null, p2, null]);
      const tools = (turnId: string) => ctx.store.activity.search({ kinds: ['app_tool'], turnId, limit: 200 });
      const pTools = tools(pTurn.id);
      expect(pTools.map((r) => r.text)).toEqual(expect.arrayContaining(['get_work_context', 'register_directive']));
      expect([...new Set(pTools.map((r) => r.projectId))]).toEqual([p2]);
      const gTools = tools(gTurn.id);
      expect(gTools.length).toBeGreaterThan(0);
      expect([...new Set(gTools.map((r) => r.projectId))]).toEqual([null]);
      // 대표의 기록 찾기와 메인의 search_activity가 찾는다
      const ownerFound = (await h.invoke('logs.search', { projectId: p2, kinds: ['app_tool'], memberId: MAIN_AGENT_ID, limit: 200 })).map((r) => r.seq);
      expect(ownerFound).toEqual(expect.arrayContaining(pTools.map((r) => r.seq)));
      const mainFound = (await h.main('search_activity', { project_id: p2, kinds: ['app_tool'], member_id: MAIN_AGENT_ID })) as unknown as { seq: number }[];
      expect(mainFound.map((r) => r.seq)).toEqual(ownerFound);
      expect((await h.invoke('logs.search', { projectId: h.projectId, kinds: ['app_tool'], limit: 200 })).filter((r) => r.turnId === pTurn.id)).toEqual([]);
    } finally {
      await h.close();
    }
  }, 120_000);

  it('재시작 복구가 끊은 main:P 메인 턴의 기록도 그 프로젝트로 남는다', async () => {
    let h = await createHarness({ team: [] });
    try {
      const ctx = h.core.ctx;
      await h.invoke('command.send', { target: h.projectId, text: '로그인 화면을 만들어 줘' });
      await h.waitFor(() => ctx.store.directives.list({ project_id: h.projectId }).length === 1, { label: '지시 등록' });
      // 뒤이은 팀 흐름은 멈춰 둔다 — 재시작 뒤에도 새 턴이 뜨지 않게 (복구는 정지 중에도 돈다)
      await h.invoke('stop.emergency');
      await h.waitFor(() => h.core.turns.count() === 0, { label: '턴 정리' });
      // 앱이 꺼질 때 돌고 있던 메인 턴(프로세스 기록 없음)이 남았다고 하자
      const ended = ctx.store.turns.list({ ref1: MAIN_AGENT_ID })[0]!;
      const cut = { ...ended, id: ctx.store.nextId('turn'), endedAt: null, endReason: null, endDetail: '', queueEntryIds: [], process: { ...ended.process, state: 'running' as const, pid: null } };
      ctx.store.turns.insert(cut);
      expect([cut.projectId, cut.workProjectId]).toEqual([null, h.projectId]);
      h = await h.restart();
      const rows = h.core.ctx.store.activity.search({ text: `재시작 복구: 턴 ${cut.id}`, limit: 5 });
      expect(rows.map((r) => r.projectId)).toEqual([h.projectId]);
    } finally {
      await h.close();
    }
  }, 120_000);
});
