/**
 * 서버 재시작으로 끊긴 host_exec (리드 결정 S5-18): 'started'로 남은 실행 기록을 재시작 복구가 맞춘다.
 * - 남긴 PID가 그 실행의 프로세스인지 생성 시각으로 보고(턴과 같은 판정) 그 트리를 끝낸다. 실행 기록은 실패('서버 재시작으로 끊김') — 복구 확인 목록에 넣지 않는다
 * - 메인 일지 서버 기록 한 줄, 메인에게 알림 업무 alert:host_exec:<실행 ID> 하나(다시 복구해도 하나)
 * - 끝내지 못하면(종료 확인 실패) 턴과 같이 막는다 — 메인 에이전트 일시정지(CTL-11), 출구는 대표의 정지 해제
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID, type ExecRecord } from '@shared/domain';
import type { ProcessRunner, TerminateResult } from '../../src/main/process/types';
import { alertLabel } from '../../src/main/orchestrator/alerts';
import { bootOrch, type OrchEnv } from './orchHarness';
import { MAIN_KEY } from './hostExecRig';

let env: OrchEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const PID = 99_731;

/** 앞 실행이 띄운 채 끊긴 서버 명령의 실행 기록 */
function cutRecord(e: OrchEnv, o: { pid?: number | null } = {}): ExecRecord {
  const at = e.ctx.now();
  const rec: ExecRecord = {
    requestId: e.ctx.store.nextId('request'),
    kind: 'host_exec',
    projectId: null,
    taskId: null,
    cwd: e.mainWorkDir!,
    command: 'winget install --id Git.Git --accept-source-agreements --accept-package-agreements',
    target: 'git 설치',
    state: 'started',
    startedAt: at,
    endedAt: null,
    result: { toolRequestId: 'rq-install-git', turnId: 'TN-prev', sessionKey: MAIN_KEY, generation: 1, timeoutS: 600, ...(o.pid === null ? {} : { pid: o.pid ?? PID, spawnedAt: at }) },
  };
  e.ctx.store.execs.put(rec);
  return rec;
}

/** 재시작 뒤 그 PID가 아직 그 실행의 프로세스다 (생성 시각이 기록한 시작 시각 이전) */
function stillOurs(e: OrchEnv, rec: ExecRecord, killTree: TerminateResult): { kills: number[] } {
  const kills: number[] = [];
  Object.assign(e.ctx.deps.runner as ProcessRunner, {
    isAlive: async (pid: number) => pid === PID,
    processCreatedAt: async (pids: number[]) => new Map(pids.map((p) => [p, Date.parse(rec.startedAt) - 500])),
    killTree: async (pid: number) => (kills.push(pid), killTree),
  });
  return { kills };
}

const alerts = (e: OrchEnv, id: string) => e.ctx.store.queue.list({ ref2: MAIN_KEY }).filter((q) => q.alertKey === `alert:host_exec:${id}`);

describe('재시작으로 끊긴 host_exec (hostExecRecovery)', () => {
  it('그 프로세스 트리를 끝내고 실패(서버 재시작으로 끊김)로 둔다 — 복구 확인에 넣지 않고, 일지 한 줄과 메인 알림 하나', async () => {
    const e = (env = await bootOrch({ workspace: true }));
    const rec = cutRecord(e);
    const { kills } = stillOurs(e, rec, { ok: true, remaining: 0, detail: '', durationMs: 1 });
    await e.core.recovery.run();
    expect(kills).toEqual([PID]);
    expect(e.ctx.store.execs.get(rec.requestId)).toMatchObject({ state: 'failed', result: { recovered: 'interrupted_by_restart', error: '서버 재시작으로 끊김', processes: 'killed' } });
    expect(e.core.recovery.items()).toEqual([]);
    const q = alerts(e, rec.requestId);
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({ kind: 'alert', memberId: MAIN_AGENT_ID, state: 'queued', priority: 'high' });
    // 현황·요약·인계 꾸러미가 쓰는 한 줄 이름 — 알림 키를 알아본다
    expect(alertLabel(q[0]!)).toBe(`재시작으로 끊긴 서버 명령 ${rec.requestId}`);
    expect(q[0]!.message.split('\n')).toEqual([
      `서버 명령 ${rec.requestId} "${rec.command}" — 서버(앱)가 다시 시작되며 끊겼습니다`,
      '- 목적: git 설치',
      `- 실행 위치: ${rec.cwd} · 시작: ${rec.startedAt} · request_id rq-install-git`,
      `- 프로세스: PID ${PID} — 남은 프로세스 종료 확인`,
      '명령이 어디까지 했는지(설치가 끝났는지 등)는 알 수 없습니다. 결과를 확인하고(필요하면 확인하는 명령을 host_exec로) 다시 돌려야 하면 새 request_id로 부르세요 — 같은 request_id로는 다시 돌지 않습니다.',
    ]);
    const journal = e.ctx.store.journal.query({ kinds: ['action'], limit: 20 }).filter((j) => j.text.startsWith(`서버 재시작으로 끊긴 서버 명령 (host_exec ${rec.requestId})`));
    expect(journal).toHaveLength(1);
    expect(journal[0]).toMatchObject({ author: 'server', workKey: MAIN_KEY });
    expect(e.ctx.stop().members[MAIN_AGENT_ID]).toBeUndefined();
    // 다시 복구해도 같다 — 실행 기록은 더 'started'가 아니고 알림은 하나
    await e.core.recovery.run();
    expect(kills).toEqual([PID]);
    expect(alerts(e, rec.requestId)).toHaveLength(1);
  });

  it('종료를 확인하지 못하면 턴과 같이 막는다 — 메인 에이전트 일시정지(정지 해제가 출구), 알림 업무도 하나 남는다', async () => {
    const e = (env = await bootOrch({ workspace: true }));
    const rec = cutRecord(e);
    stillOurs(e, rec, { ok: false, remaining: -1, detail: '가짜 트리 종료 실패', durationMs: 1 });
    await e.core.recovery.run();
    expect(e.ctx.store.execs.get(rec.requestId)).toMatchObject({ state: 'failed', result: { processes: 'unconfirmed', remaining: -1, leftoverDetail: '가짜 트리 종료 실패' } });
    expect(e.ctx.stop().members[MAIN_AGENT_ID]).toMatchObject({ paused: true, by: 'system' });
    const notice = e.ctx.store.notifications.list().find((n) => n.key === `kill-failed:${MAIN_KEY}`);
    expect(notice?.body).toContain('이전 실행 종료 뒤 남은 하위 프로세스를 확인하지 못했습니다');
    expect(notice?.body).toContain("'정지 해제'를 누르세요");
    expect(alerts(e, rec.requestId)).toHaveLength(1);
  });

  it('PID가 이미 끝났거나 다른 프로세스면 건드리지 않고, 띄우기 전에 끊겼으면 그렇다고 적는다', async () => {
    const e = (env = await bootOrch({ workspace: true }));
    const gone = cutRecord(e, { pid: 12_345 });
    const none = cutRecord(e, { pid: null });
    const other = cutRecord(e, { pid: PID });
    const kills: number[] = [];
    Object.assign(e.ctx.deps.runner as ProcessRunner, {
      isAlive: async (pid: number) => pid === PID,
      // 그 PID는 실행 기록의 시작보다 늦게 생긴 다른 프로세스다 (PID 재사용)
      processCreatedAt: async (pids: number[]) => new Map(pids.map((p) => [p, Date.parse(other.startedAt) + 60_000])),
      killTree: async (pid: number) => (kills.push(pid), { ok: true, remaining: 0, detail: '', durationMs: 0 }),
    });
    await e.core.recovery.run();
    expect(kills).toEqual([]);
    expect(e.ctx.store.execs.get(other.requestId)).toMatchObject({ state: 'failed', result: { processes: 'other' } });
    expect(alerts(e, other.requestId)[0]!.message).toContain(`- 프로세스: PID ${PID}는 다른 프로세스가 쓰고 있어 건드리지 않음`);
    expect(e.ctx.store.execs.get(gone.requestId)).toMatchObject({ state: 'failed', result: { processes: 'gone' } });
    expect(e.ctx.store.execs.get(none.requestId)).toMatchObject({ state: 'failed', result: { processes: 'gone' } });
    expect(alerts(e, gone.requestId)[0]!.message).toContain('- 프로세스: PID 12345 — 이미 끝남');
    expect(alerts(e, none.requestId)[0]!.message).toContain('- 프로세스: 띄우기 전에 끊겼거나 PID 기록이 없음');
  });
});
