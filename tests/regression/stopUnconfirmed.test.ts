/**
 * 종료를 확인하지 못한 실행의 처리 (CTL-11 '종료를 확인하지 못한 실행에 새 프로세스를 겹쳐 띄우지 않는다', stage-5 process-sleep 결함 3·5, 곁가지 1, PAUSE-REASON):
 * - 정지 때 종료 확인이 실패했으면(terminate ok=false) 프로세스의 ExitInfo.remaining이 0이어도 턴 기록은 kill_failed로 남고 그 실행을 막는다 —
 *   작업 개체 러너가 제한 시간 안에 보고하지 않아 러너째 끊은 결과가 이 모양이다 (예전: exited로 덮고, 응답 없음 자동 재개 턴이 같은 작업 폴더에 떴다)
 * - 자동 검사 프로세스의 종료를 확인하지 못하면(남은 하위 프로세스·확인 불가) 검사 결과로 치지 않고 그 작업을 막는다 (예전: 무시하고 검수로 넘김)
 * - 앱 종료(stopAll '앱 종료')가 끝낸 실행은 확인하지 못해도 보류·팀원 정지를 남기지 않는다 — 재시작 뒤 일이 이유 없이 멈추지 않게
 * - 프로그램이 건 팀원 일시정지는 까닭을 남기고 화면(StopView)에 누가·왜를 보낸다
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openStore } from '../../src/main/db/store';
import { dataPaths } from '../../src/main/orchestrator/paths';
import { directiveKey, enqueue, reviewKey, taskKey } from '../../src/main/orchestrator/records';
import type { OrchEnv } from './orchHarness';
import { bootOrch, seedDirective, sleep, waitFor } from './orchHarness';

let env: OrchEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const turnsOf = (e: OrchEnv, key: string) => e.ctx.store.turns.list().filter((t) => e.ctx.store.sessions.get(t.sessionId)?.workKey === key);
const noticesByKey = (e: OrchEnv, key: string) => e.ctx.store.notifications.list().filter((n) => n.key === key);
/** 러너가 제한 시간 안에 보고하지 않아 러너째 끊은 결과 (작업 개체 러너의 대체 분기): 종료 확인 실패인데 알던 PID는 모두 끝남 */
const RUNNER_SILENT = {
  ok: false,
  remaining: 0,
  detail: '러너가 2800ms 안에 종료를 보고하지 않아 taskkill /T /F로 러너를 강제 종료했습니다: taskkill /T /F로 프로세스 2개 종료 확인 (부모가 먼저 끝난 후손은 확인 범위 밖)',
  durationMs: 2800,
};

function devTask(e: OrchEnv) {
  const d = seedDirective(e);
  return e.core.tasks.create({ directiveId: d.id, title: '구현', goal: '목표', type: 'development', assigneeId: e.devId, acceptanceCriteria: ['동작'], outputMode: 'repo' }, e.producerId);
}

describe('정지의 종료 확인 실패는 ExitInfo.remaining이 0이어도 kill_failed로 남는다 (CTL-11)', () => {
  it('응답 없음 감시가 끊은 작업 턴: 종료를 확인하지 못했으면 kill_failed·작업 오류 보류·긴급 알림, 자동 재개 턴을 띄우지 않는다', async () => {
    env = await bootOrch({ settings: { execution: { noOutputMin: 0.003, healthCheckMin: 0.003 } } });
    const e = env;
    const t = devTask(e);
    const key = taskKey(t.id);
    e.hold.add(key);
    e.tick();
    await waitFor(() => !!e.liveProc(key), '작업 턴 시작');
    const p = e.liveProc(key)!;
    p.terminateResult = RUNNER_SILENT;
    await waitFor(() => p.done, '응답 없음으로 종료', 5000);
    await e.idle();
    e.tick(); // 자동 재개(비정상 종료 재시도)가 있었다면 여기서 뜬다
    await sleep(300);
    const first = turnsOf(e, key)[0]!;
    const task = e.ctx.store.tasks.require(t.id);
    expect({
      end: first.endReason,
      state: first.process.state,
      killDetail: first.process.killDetail,
      task: task.state,
      holds: task.hold.reasons.map((r) => r.kind),
      notices: noticesByKey(e, `kill-failed:${key}`).map((n) => n.level),
      launches: e.launches.filter((l) => l.workKey === key).length,
    }).toEqual({ end: 'no_response', state: 'kill_failed', killDetail: RUNNER_SILENT.detail, task: 'on_hold', holds: ['error'], notices: ['urgent'], launches: 1 });
    expect(task.crashRetries).toBe(0);
  });

  it('응답 없음 감시가 끊은 관리 세션(지시 관리) 턴도 같다 — 팀원을 일시정지해, 다시 넣은 업무를 그 실행 위에 띄우지 않는다', async () => {
    env = await bootOrch({ settings: { execution: { noOutputMin: 0.003, healthCheckMin: 0.003 } } });
    const e = env;
    const d = seedDirective(e);
    const key = directiveKey(d.id);
    e.hold.add(key);
    enqueue(e.ctx, { kind: 'message', memberId: e.producerId, sessionKey: key, projectId: e.projectId, directiveId: d.id, message: '진행 상황을 점검하세요' });
    e.tick();
    await waitFor(() => !!e.liveProc(key), '프로듀서 턴');
    const p = e.liveProc(key)!;
    p.terminateResult = RUNNER_SILENT;
    await waitFor(() => p.done, '응답 없음으로 종료', 5000);
    await e.idle();
    e.tick();
    await sleep(300);
    expect({
      states: turnsOf(e, key).map((x) => x.process.state),
      paused: e.ctx.stop().members[e.producerId]?.by ?? null,
      launches: e.launches.filter((l) => l.workKey === key).length,
      notices: noticesByKey(e, `kill-failed:${key}`).map((n) => n.level),
    }).toEqual({ states: ['kill_failed'], paused: 'system', launches: 1, notices: ['urgent'] });
    // 다시 넣은 업무는 대기열에 남아 팀원 재개 때 같은 세션으로 간다
    expect(e.ctx.store.queue.list({ ref2: key, state: 'queued' }).length).toBeGreaterThan(0);
  });
});

describe('자동 검사 프로세스의 종료를 확인하지 못하면 검사 결과로 치지 않고 막는다 (CTL-11)', () => {
  it('검사 명령은 통과(0)했지만 그 하위 프로세스가 끝났는지 확인하지 못함(-1) — 작업 오류 보류·긴급 알림, 제출 요청은 남기고 검수로 넘기지 않는다', async () => {
    env = await bootOrch({ checkCommands: ['npm test'] });
    const e = env;
    e.check = (c) => c.exit(0, { remaining: -1 });
    const t = devTask(e);
    const key = taskKey(t.id);
    e.hold.add(key);
    e.tick();
    await waitFor(() => !!e.liveProc(key), '작업 턴');
    const p = e.liveProc(key)!;
    expect((await e.tool(p.turnId, 'set_steps', { steps: ['구현'] })).ok).toBe(true);
    writeFileSync(join(e.ctx.store.tasks.require(t.id).workspace!.worktreePath, 'feature.txt'), '기능\n', 'utf8');
    expect((await e.tool(p.turnId, 'complete_step', { step_index: 0, note: '완료' })).ok).toBe(true);
    expect((await e.tool(p.turnId, 'submit_for_review', { note: '제출' })).ok).toBe(true);
    p.finishOk();
    await waitFor(() => e.checkProcs.length === 1 && !e.core.tasks.isSubmitting(t.id) && e.core.turns.count() === 0, '제출 처리 끝');
    const task = e.ctx.store.tasks.require(t.id);
    expect({ state: task.state, holds: task.hold.reasons.map((r) => r.kind), check: task.review.autoCheck.status, pendingSubmit: !!task.pendingSubmit }).toEqual({
      state: 'on_hold',
      holds: ['error'],
      check: 'not_run',
      pendingSubmit: true,
    });
    expect(task.hold.reasons[0]!.note).toContain('자동 검사 종료 뒤 남은 하위 프로세스를 확인하지 못했습니다');
    expect(task.hold.reasons[0]!.note).not.toContain('정리한 뒤');
    expect(noticesByKey(e, `kill-failed:check:${t.id}`).map((n) => n.level)).toEqual(['urgent']);
    expect(e.ctx.store.queue.list({ ref2: reviewKey(t.id) })).toEqual([]);
    const exec = e.ctx.store.execs.list({ ref1: t.id }).find((x) => x.kind === 'auto_check')!;
    expect({ state: exec.state, remaining: exec.result.remaining }).toEqual({ state: 'failed', remaining: -1 });
  });
});

describe('앱 종료가 끝낸 실행은 종료를 확인하지 못해도 보류·팀원 정지를 남기지 않는다', () => {
  it('작업 턴·관리 턴이 돌던 중 앱 종료 — 턴 기록은 kill_failed(정직하게)지만 작업 오류 보류·팀원 일시정지·긴급 알림은 없다', async () => {
    env = await bootOrch();
    const e = env;
    const t = devTask(e);
    const tkey = taskKey(t.id);
    const d = seedDirective(e);
    const dkey = directiveKey(d.id);
    e.hold.add(tkey);
    e.hold.add(dkey);
    enqueue(e.ctx, { kind: 'message', memberId: e.producerId, sessionKey: dkey, projectId: e.projectId, directiveId: d.id, message: '점검하세요' });
    e.tick();
    await waitFor(() => !!e.liveProc(tkey) && !!e.liveProc(dkey), '두 턴');
    // 작업 개체 도우미를 쓸 수 없는 러너처럼: 끝내도 남은 후손을 확인하지 못한다 (ExitInfo remaining -1, 종료 확인 실패)
    for (const p of [e.liveProc(tkey)!, e.liveProc(dkey)!]) {
      p.terminate = async () => {
        p.terminatedByApp = true;
        p.exit(null, { terminated: true, remaining: -1 });
        return { ok: false, remaining: -1, detail: '작업 개체 도우미를 쓸 수 없습니다', durationMs: 1 };
      };
    }
    await e.orch.stop();
    const store = openStore(dataPaths(e.dataDir).db);
    try {
      const task = store.tasks.require(t.id);
      const stop = store.kv.get<{ members: Record<string, unknown> }>('stop');
      const turns = store.turns.list();
      expect({
        holds: task.hold.reasons.map((r) => r.kind),
        paused: Object.keys(stop?.members ?? {}),
        killNotices: store.notifications.list().filter((n) => n.key?.startsWith('kill-failed:')).length,
        states: turns.map((x) => x.process.state).sort(),
      }).toEqual({ holds: [], paused: [], killNotices: 0, states: ['kill_failed', 'kill_failed'] });
    } finally {
      store.close();
    }
  });
});

describe('프로그램이 건 일시정지의 까닭 (PAUSE-REASON)', () => {
  it('관리 세션 턴이 하위 프로세스를 남겨 팀원을 일시정지하면 누가·왜를 정지 기록과 화면(StopView)에 남긴다 — 메인 에이전트가 건 정지(옛 대표 정지)는 누가만', async () => {
    env = await bootOrch();
    const e = env;
    const d = seedDirective(e);
    const key = directiveKey(d.id);
    e.script.set(key, (p) => {
      p.emit({ kind: 'result', text: '끝', data: {} });
      p.exit(0, { remaining: 2 });
    });
    enqueue(e.ctx, { kind: 'message', memberId: e.producerId, sessionKey: key, projectId: e.projectId, directiveId: d.id, message: '점검하세요' });
    await e.drain(2);
    const stop = e.ctx.stop().members[e.producerId]!;
    expect(stop).toMatchObject({ paused: true, by: 'system' });
    expect(stop.reason).toContain('프로세스 종료를 확인하지 못함');
    // 사람 쪽 정지(v0.6: 메인 에이전트가 건 일시정지, 옛 대표 정지)는 누가만 남는다 — 까닭(reason)은 프로그램이 건 정지에만
    await e.main('pause_member', { member_id: e.devId, mode: 'graceful' });
    const view = e.core.views.snapshot().stop.pausedMembers;
    expect(view.find((m) => m.memberId === e.producerId)).toMatchObject({ mode: 'graceful', by: 'system', reason: stop.reason });
    const owner = view.find((m) => m.memberId === e.devId)!;
    expect(owner).toMatchObject({ mode: 'graceful', by: 'M-MAIN' });
    expect(owner.reason).toBeUndefined();
    // 활동 기록에도 까닭
    expect(e.ctx.store.activity.search({ limit: 50 }).some((a) => a.kind === 'stop' && a.text.includes('일시정지') && a.text.includes('프로세스 종료를 확인하지 못함'))).toBe(true);
  });
});
