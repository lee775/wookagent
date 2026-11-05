/**
 * 정지 종류 검사는 앱 도구 처리기 앞 한 곳(ToolHandlers.assertNotStopped)에서 한다 (AC-19 '정지 중 실행 요청은 앱 도구에서 거부·기록', 9장 중단,
 * CTL-09). 단계 5에서는 complete_step만 정지 종류(즉시 정지·정지가 아닌 보류)를 다시 봤고, 다른 상태 변경 도구는 전역·프로젝트·팀원 정지만 봤다:
 * - 대표 [중단] 뒤 종료 확인 중인 작업 턴(실제 CLI·실제 턴 토큰)의 ask_producer·report_blocked가 받아들여져 중단된 작업에 프로듀서 답변·재계획
 *   턴이 돌았다 (원래 탐침: probe-archive/auth-security/probes/tests/acceptance/zz-authsec-stop.probe.ts)
 * - 중단 뒤 report_conflict_resolved가 받아들여져 프로그램이 충돌 해결을 커밋했다 (…/tests/regression/zz-authsec-conflictstop.probe.ts)
 * 이제 그 턴에 즉시 종료 요청이 있거나(중단·긴급 정지·즉시 일시정지·감시·대표 즉시 전달 등) 그 세션의 작업이 중단·긴급 정지로 보류되면
 * 조회 도구만 받는다. 단계 마치고 정지(기본 일시정지)의 마무리인 complete_step은 그대로 받는다 (tests/acceptance/security.test.ts AC-19).
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID } from '@shared/domain';
import { addProject, bootApp, callTool, removeDirs, sendCommand, waitFor, type App } from '../acceptance/security-helpers';
import { git, identityOf, mergeBy, passedRepoTask } from '../acceptance/git-helpers';
import { boot, type Env } from './helpers';

const apps: App[] = [];
const dirs: string[] = [];
let env: Env | null = null;
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
  await removeDirs(dirs.splice(0));
  await env?.close();
  env = null;
});

const SLOW_KILL_MS = 1_500;

/** 개발자의 작업 턴이 돌고 있는 앱 (모의 'hang' — 스스로 끝내지 않는다). 그 턴의 프로세스 종료는 SLOW_KILL_MS 늦게 시작한다 */
async function liveTaskTurn(): Promise<{ app: App; dev: string; taskId: string; token: string }> {
  const app = await bootApp({ slowKill: (spec) => (String(spec.env.WOOK_MOCK_WORKKEY ?? '').startsWith('task:') ? SLOW_KILL_MS : 0) });
  apps.push(app);
  const p = await addProject(app, { name: '정지 검사', team: ['developer'], scenarios: { developer: 'hang' } });
  dirs.push(p.root);
  const dev = p.members.developer!;
  await sendCommand(app, p.id, '로그인 화면을 만들어 줘');
  await waitFor(() => app.core.turns.isMemberRunning(dev) && app.launches.some((l) => l.memberId === dev && l.workKey.startsWith('task:')), '작업 턴', 60_000);
  const l = app.launches.filter((x) => x.memberId === dev && x.workKey.startsWith('task:')).at(-1)!;
  return { app, dev, taskId: l.workKey.slice('task:'.length), token: l.token };
}

/** 이 팀원의 앱 도구 거부 기록 (앱 도구 서버 onCall → 활동 기록) */
const refusals = (app: App, memberId: string, tool: string) =>
  app.ctx.store.activity
    .search({ kinds: ['app_tool'], limit: 500 })
    .filter((e) => e.memberId === memberId && e.text === `${tool} 거부`)
    .map((e) => ({ level: e.level, result: e.result }));

describe('메인 에이전트의 중단(interrupt_task) 뒤 종료 확인 중인 작업 턴의 요청 (실제 CLI·실제 턴 토큰)', () => {
  for (const [tool, args] of [
    ['ask_producer', { question: '중단 뒤 질문' }],
    ['report_blocked', { reason: '중단 뒤 막힘 보고' }],
    ['submit_for_review', { note: '중단 뒤 제출' }],
  ] as const) {
    it(`${tool}: 중단 → 보류 저장 뒤 같은 턴의 요청은 stopped로 거부·기록되고 질문·보류 사유·프로듀서 업무가 생기지 않는다 (조회는 된다)`, async () => {
      const { app, dev, taskId, token } = await liveTaskTurn();
      const questions0 = app.ctx.store.questions.list().length;
      const interrupting = app.main('interrupt_task', { task_id: taskId, then: 'hold' });
      await waitFor(() => app.ctx.store.tasks.require(taskId).hold.reasons.some((r) => r.kind === 'interrupted'), '중단 보류 저장');
      const turnLive = app.core.turns.isMemberRunning(dev);
      const r = await callTool(app, token, tool, args);
      const ctxRead = await callTool(app, token, 'get_work_context', {});
      await interrupting;
      const t = app.ctx.store.tasks.require(taskId);
      expect({
        turnLive,
        result: r.ok ? 'accepted' : `refused ${r.code}`,
        message: r.message,
        readStillWorks: ctxRead.ok,
        holdKinds: t.hold.reasons.map((x) => x.kind),
        newQuestions: app.ctx.store.questions.list().length - questions0,
        producerWork: app.ctx.store.queue.list().filter((q) => q.taskId === taskId && (q.kind === 'answer' || q.kind === 'replan')).map((q) => `${q.kind}:${q.state}`),
        logged: refusals(app, dev, tool),
      }).toEqual({
        turnLive: true,
        result: 'refused stopped',
        message: expect.stringContaining('뒤에는 이 턴의 요청'),
        readStillWorks: true,
        holdKinds: ['interrupted'],
        newQuestions: 0,
        producerWork: [],
        logged: [{ level: 'warn', result: expect.stringContaining('뒤에는 이 턴의 요청') }],
      });
    }, 120_000);
  }

  it('긴급 지시 즉시 전달(urgent: "interrupt")로 끝나는 턴도 같다: 그 턴의 질문은 거부되고 메시지는 다음 턴 맨 앞에 남는다', async () => {
    const { app, dev, token } = await liveTaskTurn();
    const questions0 = app.ctx.store.questions.list().length;
    const sent = await app.main('instruct_member', { member_id: dev, text: '지금 하던 것을 멈추고 이 메시지를 먼저 보세요', urgent: 'interrupt' });
    await waitFor(() => app.ctx.store.turns.list().some((t) => t.memberId === dev && t.process.stopMode === 'immediate' && !t.endedAt), '즉시 종료 요청 저장');
    const turnLive = app.core.turns.isMemberRunning(dev);
    const r = await callTool(app, token, 'ask_producer', { question: '즉시 전달 뒤 질문' });
    expect({
      turnLive,
      result: r.ok ? 'accepted' : `refused ${r.code}`,
      newQuestions: app.ctx.store.questions.list().length - questions0,
      messageWaiting: app.ctx.store.queue.list({ state: 'queued' }).some((q) => q.messageId === sent.messageId),
    }).toEqual({ turnLive: true, result: 'refused stopped', newQuestions: 0, messageWaiting: true });
  }, 120_000);
});

describe('메인 에이전트의 중단(interrupt_task) 뒤의 충돌 해결 보고 (프로그램 커밋)', () => {
  it('중단(보류 interrupted) 뒤 report_conflict_resolved는 stopped로 거부되고 커밋하지 않는다 — 고친 파일은 작업 폴더에 남는다', async () => {
    env = await boot({ team: ['developer', 'developer'] });
    const e = env;
    const [dev1, dev2] = e.members as [Env['members'][number], Env['members'][number]];
    const t1 = await passedRepoTask(e.core, { projectId: e.project.id, assignee: dev1, files: { 'shared.txt': 'A\n' } });
    const t2 = await passedRepoTask(e.core, { projectId: e.project.id, assignee: dev2, files: { 'shared.txt': 'B\n' } });
    expect((await mergeBy(e.core, t1.id)).state).toBe('done');
    const r = await mergeBy(e.core, t2.id);
    expect(r.conflict?.files).toEqual(['shared.txt']);
    const wt = r.workspace!.worktreePath;
    const who = identityOf(dev2, `task:${t2.id}`);
    await e.core.tasks.interrupt(t2.id, 'hold', MAIN_AGENT_ID);
    writeFileSync(join(wt, 'shared.txt'), 'A\nB\n', 'utf8');
    const head0 = git(wt, ['rev-parse', 'HEAD']);
    const report = await e.core.tools.handle(who, 'report_conflict_resolved', { note: '중단 뒤 해결 보고' });
    expect({
      report: report.ok ? 'accepted' : `refused ${report.code}`,
      committed: git(wt, ['rev-parse', 'HEAD']) !== head0,
      conflictKept: e.ctx.store.tasks.require(t2.id).conflict?.files ?? null,
      hold: e.ctx.store.tasks.require(t2.id).hold.reasons.map((x) => x.kind),
      fileKept: git(wt, ['status', '--porcelain', '--', 'shared.txt']) !== '',
    }).toEqual({ report: 'refused stopped', committed: false, conflictKept: ['shared.txt'], hold: ['interrupted'], fileKept: true });
  });
});
