/**
 * 턴 종료 처리 회귀:
 * - windows:F8 바이패스 확인 뒤의 개별 명령 거부(CLI 안전 검사)는 그 AI 종류 전체를 막지 않는다
 * - spec:F14 정리 뒤 남은 하위 프로세스(kill_failed) → 같은 작업에 새 턴을 겹쳐 띄우지 않고 대표에게 알린다
 * - concurrency:CONC-09 단계 마치고 정지(graceful)를 기다리는 턴도 응답 없음 감시를 받는다
 * - concurrency:CONC-13 단계 완료 300ms 뒤의 예약 종료가 끝난 턴 기록을 덮지 않는다
 * - concurrency:CONC-04 정지된 관리 턴의 재등록은 지금의 담당(교체된 프로듀서의 후임)·지시 상태를 따른다
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { DeepPartial } from '@shared/ipc';
import type { Settings } from '@shared/domain';
import { directiveKey, enqueue, taskKey } from '../../src/main/orchestrator/records';
import type { OrchEnv } from './orchHarness';
import { bootOrch, seedDirective, sleep, waitFor } from './orchHarness';

let env: OrchEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const turnsOf = (e: OrchEnv, key: string) => e.ctx.store.turns.list().filter((t) => e.ctx.store.sessions.get(t.sessionId)?.workKey === key);

/** 개발자 작업을 만들고 활성화 턴을 띄워 둔다 (hold) */
async function liveTaskTurn(e: OrchEnv) {
  const d = seedDirective(e);
  const t = e.core.tasks.create({ directiveId: d.id, title: '구현', goal: '목표', type: 'development', assigneeId: e.devId, acceptanceCriteria: ['동작'], outputMode: 'repo' }, e.producerId);
  e.hold.add(taskKey(t.id));
  e.tick();
  await waitFor(() => !!e.liveProc(taskKey(t.id)), '작업 턴 시작');
  return { t, proc: e.liveProc(taskKey(t.id))! };
}

describe('바이패스 개별 거부 (windows:F8)', () => {
  it('bypassPermissions 확인 뒤의 개별 거부는 AI 종류를 막지 않고, 알림은 그 세션에 — 다시 시도에는 상한이 있다', async () => {
    env = await bootOrch({ mock: false });
    const e = env;
    const d = seedDirective(e);
    e.script.set(directiveKey(d.id), (p) => {
      p.emit({ kind: 'session', text: 'init', data: { permissionMode: 'bypassPermissions' } });
      p.emit({ kind: 'error', text: 'rm -rf "$OUT"/* — 안전 검사 거부', data: { errorKind: 'permission' } });
    });
    enqueue(e.ctx, { kind: 'message', memberId: e.producerId, sessionKey: directiveKey(d.id), projectId: e.projectId, directiveId: d.id, message: '정리해 줘' });
    await e.drain(5);
    const turns = turnsOf(e, directiveKey(d.id));
    expect(turns.map((t) => t.endReason)).toEqual(['bypass_mismatch', 'bypass_mismatch', 'bypass_mismatch']);
    expect(e.ctx.ai('claude').cliProblem).toBeNull(); // 모든 Claude 턴을 막지 않는다
    expect(e.ctx.store.notifications.list().filter((n) => n.key === `bypass-denied:${directiveKey(d.id)}`)).toHaveLength(1);
    expect(e.ctx.store.notifications.list().filter((n) => n.key?.startsWith('ai-problem:'))).toEqual([]);
    // 다시 넣는 안내에 거부 사유가 들어간다
    expect(e.launches.filter((l) => l.workKey === directiveKey(d.id))[1]!.message).toContain('CLI 안전 검사가 명령을 거부');
  });

  it('권한 모드가 bypassPermissions가 아니면(설정 문제) 예전처럼 그 AI 종류를 막는다', async () => {
    env = await bootOrch({ mock: false });
    const e = env;
    const d = seedDirective(e);
    e.script.set(directiveKey(d.id), (p) => p.emit({ kind: 'session', text: 'init', data: { permissionMode: 'default' } }));
    enqueue(e.ctx, { kind: 'message', memberId: e.producerId, sessionKey: directiveKey(d.id), projectId: e.projectId, directiveId: d.id, message: '정리해 줘' });
    await e.drain(3);
    expect(turnsOf(e, directiveKey(d.id))).toHaveLength(1);
    expect(e.ctx.ai('claude').cliProblem).toContain('바이패스 설정 불일치');
  });
});

describe('남은 하위 프로세스 (F14)', () => {
  it('작업 턴 뒤 프로세스가 남으면 그 작업을 오류 보류하고 긴급 알림 — 같은 작업 폴더에 새 턴을 띄우지 않는다', async () => {
    env = await bootOrch();
    const e = env;
    const d = seedDirective(e);
    const t = e.core.tasks.create({ directiveId: d.id, title: '구현', goal: '목표', type: 'development', assigneeId: e.devId, acceptanceCriteria: ['동작'], outputMode: 'repo' }, e.producerId);
    e.script.set(taskKey(t.id), (p) => {
      p.emit({ kind: 'result', text: '끝', data: {} });
      p.exit(0, { remaining: 2 }); // 개발 서버 등 2개가 남음
    });
    await e.drain(3);
    const turns = turnsOf(e, taskKey(t.id));
    expect(turns).toHaveLength(1);
    expect(turns[0]!.process.state).toBe('kill_failed');
    const held = e.ctx.store.tasks.require(t.id);
    expect(held.state).toBe('on_hold');
    expect(held.hold.reasons.map((r) => r.kind)).toEqual(['error']);
    expect(e.ctx.store.notifications.list().filter((n) => n.key === `kill-failed:${taskKey(t.id)}` && n.level === 'urgent')).toHaveLength(1);
  });

  it('남은 후손을 확인하지 못한 종료(remaining -1, 작업 개체를 쓸 수 없는 러너)도 종료 확인 실패로 막는다 — 작업은 오류 보류 (CTL-11)', async () => {
    env = await bootOrch();
    const e = env;
    const d = seedDirective(e);
    const t = e.core.tasks.create({ directiveId: d.id, title: '구현', goal: '목표', type: 'development', assigneeId: e.devId, acceptanceCriteria: ['동작'], outputMode: 'repo' }, e.producerId);
    e.script.set(taskKey(t.id), (p) => {
      p.emit({ kind: 'result', text: '끝', data: {} });
      p.exit(0, { remaining: -1 });
    });
    await e.drain(3);
    const turns = turnsOf(e, taskKey(t.id));
    expect(turns.map((x) => [x.process.state, x.process.killDetail])).toEqual([['kill_failed', '정리 후 남은 하위 프로세스를 확인하지 못함']]);
    expect(e.ctx.store.tasks.require(t.id).hold.reasons.map((r) => r.kind)).toEqual(['error']);
    const n = e.ctx.store.notifications.list().filter((x) => x.key === `kill-failed:${taskKey(t.id)}`);
    expect(n.map((x) => x.level)).toEqual(['urgent']);
    expect(n[0]!.body).toContain('남은 하위 프로세스를 확인하지 못했습니다');
  });

  it('관리 세션(지시 관리) 턴 뒤 프로세스가 남으면 그 팀원을 일시정지해 다음 턴을 겹쳐 띄우지 않고, 팀원을 재개하면 쌓인 업무를 같은 세션에 전달한다 (CTL-11, AC-36)', async () => {
    env = await bootOrch();
    const e = env;
    const d = seedDirective(e);
    const key = directiveKey(d.id);
    let n = 0;
    e.script.set(key, (p) => {
      n += 1;
      p.emit({ kind: 'result', text: '끝', data: {} });
      p.exit(0, { remaining: n === 1 ? 2 : 0 });
    });
    enqueue(e.ctx, { kind: 'message', memberId: e.producerId, sessionKey: key, projectId: e.projectId, directiveId: d.id, message: '진행 상황을 점검하세요' });
    await e.drain(2);
    expect(turnsOf(e, key).map((x) => x.process.state)).toEqual(['kill_failed']);
    expect(e.ctx.stop().members[e.producerId]).toMatchObject({ paused: true, by: 'system' });
    // 그 사이 온 업무는 대기열에 남고 실행되지 않는다
    enqueue(e.ctx, { kind: 'message', memberId: e.producerId, sessionKey: key, projectId: e.projectId, directiveId: d.id, message: '접근성 점검도 넣어 주세요' });
    await e.drain(2);
    expect(turnsOf(e, key)).toHaveLength(1);
    expect(e.ctx.store.queue.list({ ref2: key, state: 'queued' })).toHaveLength(1);
    // 대표가 남은 프로세스를 정리한 뒤 팀원 재개 → 같은 세션의 다음 턴으로 전달
    await e.main('resume_member', { member_id: e.producerId });
    await e.drain(2);
    const turns = turnsOf(e, key);
    expect(turns.map((x) => x.process.state)).toEqual(['kill_failed', 'exited']);
    expect(turns[1]!.sessionId).toBe(turns[0]!.sessionId);
    expect(e.launches.filter((l) => l.workKey === key)[1]!.message).toContain('접근성 점검도 넣어 주세요');
  });
});

describe('정지를 기다리는 턴의 감시 (CONC-09, CONC-13)', () => {
  const fastWatch: DeepPartial<Settings> = { execution: { noOutputMin: 0.003, healthCheckMin: 0.003 } };

  it('단계 마치고 정지를 기다리는데 응답이 없으면 감시가 끝낸다 — 작업은 정지 보류 그대로, 재시도 횟수는 그대로', async () => {
    env = await bootOrch({ settings: fastWatch });
    const e = env;
    const { t, proc } = await liveTaskTurn(e);
    await e.main('pause_member', { member_id: e.devId, mode: 'graceful' });
    await waitFor(() => proc.done, '응답 없음으로 종료', 5000);
    await e.idle();
    const turn = turnsOf(e, taskKey(t.id))[0]!;
    expect(turn.endReason).toBe('no_response');
    const cur = e.ctx.store.tasks.require(t.id);
    expect(cur.state).toBe('on_hold');
    expect(cur.hold.reasons.map((r) => `${r.kind}/${r.scope}`)).toEqual(['paused/member']);
    expect(cur.crashRetries).toBe(0);

    e.hold.clear();
    await e.main('resume_member', { member_id: e.devId });
    await e.drain(1);
    expect(turnsOf(e, taskKey(t.id))).toHaveLength(2);
  });

  it('정지 요청 뒤 단계 완료 직후 턴이 스스로 끝나면, 300ms 뒤 예약 종료가 끝난 턴 기록을 바꾸지 않는다', async () => {
    env = await bootOrch();
    const e = env;
    const { t, proc } = await liveTaskTurn(e);
    expect((await e.tool(proc.turnId, 'set_steps', { steps: ['한 단계'] })).ok).toBe(true);
    await e.main('pause_member', { member_id: e.devId, mode: 'graceful' });
    const r = await e.tool(proc.turnId, 'complete_step', { step_index: 0, note: '완료' });
    expect(r.ok).toBe(true);
    proc.finishOk(); // 안내대로 바로 턴을 마침
    await e.idle();
    await sleep(500); // 예약 종료(300ms) 이후
    const turn = turnsOf(e, taskKey(t.id))[0]!;
    expect(turn.endedAt).not.toBeNull();
    expect(turn.process.state).toBe('exited');
  });
});

describe('정지된 관리 턴의 재등록 (CONC-04)', () => {
  it('계획 턴 실행 중 프로듀서 교체 → 새 프로듀서가 그 계획을 이어 받는다 (지시가 멈추지 않는다)', async () => {
    env = await bootOrch();
    const e = env;
    const d = e.core.directives.register({ projectId: e.projectId, title: '계획', text: '계획' }, 'M-MAIN', null);
    e.hold.add(directiveKey(d.id));
    e.tick();
    await waitFor(() => !!e.liveProc(directiveKey(d.id), e.producerId), '계획 턴');
    const fresh = { id: (await e.main('replace_producer', { project_id: e.projectId })).producerId as string };
    await e.idle();
    const plan = e.ctx.store.queue.list({ ref2: directiveKey(d.id), state: 'queued' });
    expect(plan.map((q) => `${q.kind}→${q.memberId}`)).toEqual([`plan→${fresh.id}`]);
    e.tick();
    await waitFor(() => !!e.liveProc(directiveKey(d.id), fresh.id), '새 프로듀서 계획 턴');
  });

  it('실행 중인 계획 턴의 지시를 취소하면 그 턴의 업무를 다시 넣지 않는다', async () => {
    env = await bootOrch();
    const e = env;
    const d = e.core.directives.register({ projectId: e.projectId, title: '계획', text: '계획' }, 'M-MAIN', null);
    e.hold.add(directiveKey(d.id));
    e.tick();
    await waitFor(() => !!e.liveProc(directiveKey(d.id)), '계획 턴');
    await e.main('cancel_directive', { directive_id: d.id });
    await e.idle();
    expect(e.ctx.store.directives.require(d.id).state).toBe('cancelled');
    expect(e.ctx.store.queue.list({ ref2: directiveKey(d.id), state: 'queued' })).toEqual([]);
    e.tick();
    await sleep(50);
    expect(turnsOf(e, directiveKey(d.id))).toHaveLength(1);
  });
});
