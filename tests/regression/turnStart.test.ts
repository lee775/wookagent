/**
 * 턴 기록 뒤 프로세스를 띄우기 전 실패 (spec:F1, concurrency:CONC-01, ERR-04).
 * 예전에는 항목을 시도 횟수 그대로 대기열에 되돌려 곧바로 다시 실행했다 — 저장된 잘못된 모델 이름 하나로 턴이 끝없이 쌓였다.
 * 지금은 시작 시도로 세어 3회에서 멈추고(작업·검수 세션이면 작업을 오류 보류), CLI 실행 파일 문제는 AI 종류 단위로 막는다.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { LaunchError } from '../../src/main/agents/common';
import { directiveKey, enqueue, taskKey } from '../../src/main/orchestrator/records';
import type { OrchEnv } from './orchHarness';
import { bootOrch, seedDirective, sleep } from './orchHarness';

let env: OrchEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const turnsOf = (e: OrchEnv, key: string) => e.ctx.store.turns.list().filter((t) => e.ctx.store.sessions.get(t.sessionId)?.workKey === key);

describe('시작 실패 상한 (F1, CONC-01)', () => {
  it('작업 세션: 실행 값 검사 실패가 3번이면 멈추고 작업을 오류 보류 — 대표가 고친 뒤 재개하면 다시 시작한다', async () => {
    env = await bootOrch();
    const e = env;
    const d = seedDirective(e);
    const t = e.core.tasks.create(
      { directiveId: d.id, title: '구현', goal: '목표', type: 'development', assigneeId: e.devId, acceptanceCriteria: ['동작'], outputMode: 'repo' },
      e.producerId,
    );
    let broken = true;
    e.prepareHook = (_launch, who) => {
      if (broken && who.sessionKey === taskKey(t.id)) throw new LaunchError('Codex 모델 이름이 올바르지 않습니다: "GPT-6 Sol"');
    };
    await e.drain(6); // 상한이 없으면 tick마다 다시 실패한다
    expect(turnsOf(e, taskKey(t.id)).map((x) => x.endReason)).toEqual(['spawn_failed', 'spawn_failed', 'spawn_failed']);
    const held = e.ctx.store.tasks.require(t.id);
    expect(held.state).toBe('on_hold');
    expect(held.hold.reasons.map((r) => r.kind)).toEqual(['error']);
    expect(held.hold.reasons[0]!.note).toContain('턴 시작 3회 실패');
    expect(e.ctx.store.queue.list({ ref2: taskKey(t.id), state: 'queued' })).toEqual([]);
    expect(e.ctx.store.notifications.list().filter((n) => n.key === `start-fail:${taskKey(t.id)}`)).toHaveLength(1);
    // 'CLI 실행 실패'(설정·계정 화면 안내)는 이 경우가 아니다 — 이 업무만의 문제
    expect(e.ctx.store.notifications.list().filter((n) => n.title === 'CLI 실행 실패')).toEqual([]);

    broken = false;
    await e.main('resume_task', { task_id: t.id });
    await e.drain(1);
    const after = turnsOf(e, taskKey(t.id));
    expect(after).toHaveLength(4);
    expect(after[3]!.endReason).toBe('completed');
  });

  it('지시 세션: 프로듀서 계획 턴이 3번 시작에 실패하면 계획 항목을 멈추고 긴급 알림, 더 띄우지 않는다', async () => {
    env = await bootOrch();
    const e = env;
    e.prepareHook = (_launch, who) => {
      if (who.sessionKey.startsWith('directive:')) throw new LaunchError('Claude Code 작업 폴더가 없습니다: C:\\없음');
    };
    const d = e.core.directives.register({ projectId: e.projectId, title: '계획', text: '계획' }, 'M-MAIN', null);
    await e.drain(6);
    expect(turnsOf(e, directiveKey(d.id))).toHaveLength(3);
    const plan = e.ctx.store.queue.list({ ref2: directiveKey(d.id) });
    // 시작 실패는 재전달 횟수(attempts)와 따로 센다 (S9-B2)
    expect(plan.map((q) => `${q.kind}:${q.state}:${q.startFails}:${q.attempts}`)).toEqual(['plan:cancelled:3:0']);
    expect(e.ctx.store.notifications.list().filter((n) => n.key === `start-fail:${directiveKey(d.id)}` && n.level === 'urgent')).toHaveLength(1);
  });

  it('CLI 실행 파일 문제는 AI 종류 단위로 막는다 — 시도로 세지 않아 항목이 남고, 다시 확인하기 전에는 띄우지 않는다 (CLI-15)', async () => {
    env = await bootOrch({ mock: false });
    const e = env;
    e.prepareHook = (_launch, who) => {
      if (who.memberId === e.producerId) throw new LaunchError('Claude Code 실행 파일을 찾지 못했습니다 (PATH·설정 경로 확인)', true);
    };
    const d = e.core.directives.register({ projectId: e.projectId, title: '계획', text: '계획' }, 'M-MAIN', null);
    await e.drain(3);
    expect(turnsOf(e, directiveKey(d.id))).toHaveLength(1);
    const ai = e.ctx.ai('claude');
    expect(ai.cliInstalled).toBe(false);
    expect(ai.cliProblem).toContain('찾지 못했습니다');
    const plan = e.ctx.store.queue.list({ ref2: directiveKey(d.id) });
    expect(plan.map((q) => `${q.kind}:${q.state}:${q.attempts}`)).toEqual(['plan:queued:0']);
    expect(e.ctx.store.notifications.list().filter((n) => n.title === 'CLI 실행 실패')).toHaveLength(1);
  });

  it('정지 요청으로 시작 전에 멈춘 턴은 시작 실패로 세지 않는다', async () => {
    env = await bootOrch();
    const e = env;
    const d = seedDirective(e);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    // prepare가 끝나기 전에 정지 → begin이 정지 요청을 보고 프로세스를 띄우지 않는다
    const adapter = e.core.ctx.deps.adapters.mock;
    const original = adapter.prepare.bind(adapter);
    adapter.prepare = async (launch) => {
      await gate;
      return original(launch);
    };
    enqueue(e.ctx, { kind: 'message', memberId: e.producerId, sessionKey: directiveKey(d.id), projectId: e.projectId, directiveId: d.id, message: '확인' });
    e.tick();
    await sleep(30);
    const stopping = e.core.turns.stopMember(e.producerId, '테스트 정지', true);
    release();
    await stopping;
    await e.idle();
    const turns = turnsOf(e, directiveKey(d.id));
    expect(turns.map((t) => t.endReason)).toEqual(['user_stop']);
    // 전달하지 못한 항목은 시도 횟수 그대로 대기열에 남는다
    expect(e.ctx.store.queue.list({ ref2: directiveKey(d.id), state: 'queued' }).map((x) => x.attempts)).toEqual([0]);
  });
});
