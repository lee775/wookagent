/**
 * 상태 규칙 수정의 서비스 경계 확인 (CORE-01·02·03·04·05·06). 순수 규칙 표는 tests/unit/core가 다루고,
 * 여기서는 실제 서비스로 몰았을 때 대표·팀원이 보는 결과를 확인한다.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAIN_AGENT_ID, OWNER } from '@shared/domain';
import { TransitionError } from '@core/taskMachine';
import { transitionTask } from '../../src/main/orchestrator/records';
import type { Env } from './helpers';
import { activate, boot, newTask, pass, submittedTask, waitFor } from './helpers';

let env: Env | null = null;
const cleanups: (() => void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) c();
  await env?.close();
  env = null;
});

describe('CORE-01 재배정은 중단·이전 담당 정지를 풀고 새 담당이 다시 시작하게 한다', () => {
  it('메인 에이전트 중단(보류) 뒤 재배정 → 새 담당의 대기 작업 (재개를 따로 누르지 않아도 됨)', async () => {
    env = await boot({ team: ['developer', 'developer'] });
    const e = env;
    const t = await activate(e, newTask(e).id);
    await e.core.tasks.interrupt(t.id, 'hold', MAIN_AGENT_ID);
    e.core.tasks.update(t.id, { assigneeId: e.members[1]!.id }, e.producer.id);
    const r = e.ctx.store.tasks.require(t.id);
    expect(r.state).toBe('waiting');
    expect(r.assigneeId).toBe(e.members[1]!.id);
    expect(r.hold.reasons).toEqual([]);
  });

  it('이전 담당 팀원 일시정지는 재배정된 작업을 막지 않고, 프로젝트 정지는 그대로 막는다', async () => {
    env = await boot({ team: ['developer', 'developer'] });
    const e = env;
    const [a, b] = e.members;
    const t = await activate(e, newTask(e, { assignee: a }).id);
    await e.core.stops.pauseMember(a!.id, 'graceful', MAIN_AGENT_ID);
    e.core.tasks.reassign(t.id, b!.id, MAIN_AGENT_ID);
    expect(e.ctx.store.tasks.require(t.id).state).toBe('waiting');

    const t2 = await activate(e, newTask(e, { assignee: b }).id);
    await e.core.stops.pauseProject(e.project.id, 'graceful', MAIN_AGENT_ID);
    e.core.stops.resumeMember(a!.id, MAIN_AGENT_ID);
    e.core.tasks.reassign(t2.id, a!.id, MAIN_AGENT_ID);
    const held = e.ctx.store.tasks.require(t2.id);
    expect(held.state).toBe('on_hold');
    expect(held.hold.reasons.map((x) => x.kind)).toEqual(['paused']);
    expect(held.hold.returnState).toBe('waiting');
  });
});

describe('CORE-02·03 팀원 상태 표시', () => {
  it('턴이 끝나고 자동 검사가 도는 동안 "맡은 작업 없음"이 아니라 자동 검사 중으로 표시', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wook-test-reg-script-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, 'slow.js'), 'setTimeout(() => process.exit(0), 30000);\n');
    env = await boot({ runner: true, checkCommands: [`node ${join(dir, 'slow.js')}`] });
    const e = env;
    const t = await activate(e, newTask(e).id);
    e.core.tasks.setSteps(t.id, ['단계']);
    writeFileSync(join(t.workspace!.worktreePath, 'a.txt'), 'a\n');
    const dev = e.ctx.store.members.require(t.assigneeId);
    await e.core.tasks.completeStep(t.id, 0, '', dev, null);
    e.core.tasks.requestSubmit(t.id, '제출', dev);
    const sub = e.core.tasks.processSubmission(t.id);
    await waitFor(() => e.core.checks.running.has(t.id), '검사 시작');
    const view = e.core.views.memberView(dev);
    expect(view.statusReasons).not.toContain('맡은 작업 없음');
    expect(view.statusReasons).toContain(`${t.id} 자동 검사 중`);
    await e.core.checks.terminateFor(() => true);
    await sub;
  });

  it('긴급 정지 해제 후 항목별 재개 전·메인 에이전트 중단 보류는 일시정지로 표시 (메인 에이전트가 풀어야 함)', async () => {
    env = await boot({ team: ['developer', 'developer'] });
    const e = env;
    const [a, b] = e.members;
    await activate(e, newTask(e, { assignee: a }).id);
    const t2 = await activate(e, newTask(e, { assignee: b }).id);
    await e.core.stops.emergency(OWNER);
    e.core.stops.release(OWNER);
    expect(e.core.views.memberView(e.ctx.store.members.require(a!.id)).status).toBe('paused');
    e.core.tasks.resumeByOwner(t2.id, MAIN_AGENT_ID);
    await e.core.tasks.interrupt(t2.id, 'hold', MAIN_AGENT_ID);
    const v = e.core.views.memberView(e.ctx.store.members.require(b!.id));
    expect(v.status).toBe('paused');
    expect(v.statusReasons[0]).toBe(`${t2.id} 중단됨 — 재개 대기`);
  });
});

describe('CORE-04·05·06 전이 방어선', () => {
  it('보류 복귀 상태는 대기·진행·검수만, 재계획 사유는 일반 해제로 풀 수 없다', async () => {
    env = await boot();
    const e = env;
    const t = await activate(e, newTask(e).id);
    expect(() => e.core.tasks.hold(t.id, 'error', 'task', 'x', 'system', null, 'done')).toThrow(TransitionError);
    expect(() => e.core.tasks.hold(t.id, 'error', 'task', 'x', 'system', null, 'in_review')).toThrow(TransitionError);
    e.core.tasks.hold(t.id, 'replan', 'task', '헛돌기', 'system');
    expect(() => transitionTask(e.ctx, t.id, { type: 'release', match: () => true, note: '모두 해제' }, MAIN_AGENT_ID)).toThrow(TransitionError);
    expect(e.core.tasks.replan(t.id, { note: '방법 변경' }, e.producer.id).review.round).toBe(2);
  });

  it('통과는 지금 고정된 대상에만 — 이전 대상으로는 통과·완료를 기록할 수 없다', async () => {
    env = await boot();
    const e = env;
    const t = await submittedTask(e, { reviewer: 'main' });
    const old = t.review.target!;
    const moved = { ...old, pinnedAt: e.ctx.now(), ...(old.kind === 'repo' ? { baseMainSha: '0'.repeat(40) } : {}) } as typeof old;
    transitionTask(e.ctx, t.id, { type: 'repin', target: moved }, 'system');
    expect(() => transitionTask(e.ctx, t.id, { type: 'review_pass', reviewId: 'RV-X', reviewerId: MAIN_AGENT_ID, target: old }, MAIN_AGENT_ID)).toThrow(TransitionError);
    pass(e, t.id);
    expect(e.ctx.store.tasks.require(t.id).review.passed?.target).toEqual(moved);
  });
});
