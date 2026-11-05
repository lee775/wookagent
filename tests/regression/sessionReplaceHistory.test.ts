/**
 * 세션 교체 이력 (MEM-11 "세션 ID, 이전 세션, 교체 사유, 인계 요약을 보관", MBR-01, ERR-03, AC-40):
 * 어느 경로로 세션이 바뀌든 새 세션은 이전 세션과 교체 사유를 기록한다 — 열린 세션을 바꾸는 경우(실행 위치·AI 설정 변경)뿐 아니라
 * 이미 닫힌 세션을 잇는 경우(이어하기 실패, 재시작 때 이어할 CLI 세션 없음)도. 닫는 사유가 그 세션의 교체 사유다 — 그 세션이 만들어진 까닭으로
 * 덮이지 않는다 (교체가 이어진 경우).
 * 턴 단위 하네스(orchHarness·sessions-helpers), 재시작은 완료 기준 도우미(stops-helpers.bootRestartable).
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ParsedCliEvent } from '@shared/events';
import { taskKey } from '../../src/main/orchestrator/records';
import { bootSessions, makeTask, scriptTurns, toolOk, turnsOfKey, waitFor, type SessEnv } from '../acceptance/sessions-helpers';
import { bootRestartable, seedDirective as seedRestartDirective, waitUntil, type RestartableEnv } from '../acceptance/stops-helpers';
import { seedDirective } from './orchHarness';

let env: SessEnv | null = null;
let restartable: RestartableEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
  await restartable?.close();
  restartable = null;
});

/** 실제 CLI 파서가 내는 이어하기 실패 (Claude "No conversation found") */
const RESUME_FAILED: ParsedCliEvent = { kind: 'error', text: 'No conversation found with session ID: gone', data: { errorKind: 'other', resumeFailed: true } };

describe('세션 교체 이력 (MEM-11)', () => {
  it('교체가 이어져도(AI 설정 변경 → 이어하기 실패) 각 세션이 이전 세션·교체 사유를 기록하고, 닫힌 세션에는 닫힌 까닭이 남는다 — 화면 상세에도 이어진다', async () => {
    const e = (env = await bootSessions({ autoSchedule: true }));
    const d = seedDirective(e);
    const t = makeTask(e, { directiveId: d.id, assignee: e.devId, title: '알림 설정' });
    const key = taskKey(t.id);
    scriptTurns(e, key, [
      async (p) => {
        await toolOk(e, p.turnId, 'set_steps', { steps: ['화면', '저장', '점검'] });
        await toolOk(e, p.turnId, 'complete_step', { step_index: 0, note: '화면' });
        // 다음 턴 전에 실행 방식이 바뀐다 → 열린 세션을 'AI 설정 변경'으로 교체
        await e.internal('projects.setMock', e.projectId, { enabled: false });
        p.finishOk('1단계');
      },
      async (p) => {
        const wt = e.ctx.store.tasks.require(t.id).workspace!.worktreePath;
        writeFileSync(join(wt, 'save.txt'), '저장\n', 'utf8');
        await toolOk(e, p.turnId, 'complete_step', { step_index: 1, note: '저장' });
        p.finishOk('2단계');
      },
      (p) => {
        p.emit(RESUME_FAILED); // 교체로 만든 세션의 이어하기가 실패
        p.exit(1);
      },
      () => undefined, // 새 세션 첫 턴 — 살아 있게
    ]);
    await waitFor(() => turnsOfKey(e, key).length === 4, '세 번째 세션 첫 턴', 20_000);
    expect(e.scriptErrors).toEqual([]);
    const [s1, s2, s3] = e.ctx.store.sessions.list({ ref2: key });
    expect(s1).toMatchObject({ previousSessionId: null, replaceReason: 'AI 설정 변경' });
    expect(s1!.closedAt).not.toBeNull();
    // 교체로 만든 세션: 만들 때는 앞 세션과 그 사유, 닫힐 때는 닫힌 까닭(이어하기 실패)
    expect(s2!.previousSessionId).toBe(s1!.id);
    expect(s2!.closedAt).not.toBeNull();
    expect(s2!.replaceReason).toContain('이어하기 실패');
    // 닫힌 세션을 잇는 새 세션도 이전 세션·교체 사유·인계 요약을 기록한다
    expect(s3!.closedAt).toBeNull();
    expect(s3!.previousSessionId).toBe(s2!.id);
    expect(s3!.replaceReason).toContain('이어하기 실패');
    expect(s3!.handoverSummary).toContain(`이전 세션 ${s2!.id}`);
    expect(e.ctx.store.activity.search({ text: `세션 ${s3!.id} 시작`, limit: 10 }).map((a) => a.text)).toEqual([expect.stringContaining('교체: 이어하기 실패')]);
    const detail = await e.invoke('members.getDetail', e.devId);
    const chain = new Map(detail.sessions.map((s) => [s.id, s.previousSessionId]));
    expect([chain.get(s1!.id), chain.get(s2!.id), chain.get(s3!.id)]).toEqual([null, s1!.id, s2!.id]);
  });

  it('재시작 때 이어할 CLI 세션이 없어 닫힌 세션(교체로 만들어졌던 세션이어도)을 다음 세션이 이전 세션·교체 사유로 잇는다', async () => {
    restartable = await bootRestartable();
    let e = restartable;
    const d = seedRestartDirective(e);
    const t = e.core.tasks.create(
      { directiveId: d.id, title: '로그인 화면', goal: '로그인 화면', type: 'development', assigneeId: e.devId, acceptanceCriteria: ['동작한다'], outputMode: 'repo' },
      e.producerId,
    );
    const key = taskKey(t.id);
    e.hold.add(key);
    e.tick();
    await waitUntil(() => !!e.liveProc(key), '작업 턴');
    const p = e.liveProc(key)!;
    expect((await e.tool(p.turnId, 'set_steps', { steps: ['화면', '테스트'] })).ok).toBe(true);
    // 그 세션은 앞 세션을 'AI 설정 변경'으로 바꿔 만든 세션이었고, CLI가 세션 ID를 알리기 전에 전원이 꺼진다
    const s1 = e.ctx.store.sessions.list({ ref2: key })[0]!;
    e.ctx.store.sessions.put({ ...s1, cliSessionId: null, replaceReason: 'AI 설정 변경' });

    e.crash();
    e = restartable = await e.reboot({ holdAll: true });
    await waitUntil(() => e.launchesOf(key).length === 1, '재시작 뒤 첫 턴');
    const [old, fresh] = e.ctx.store.sessions.list({ ref2: key });
    expect(old!.id).toBe(s1.id);
    expect(old!.closedAt).not.toBeNull();
    expect(old!.replaceReason).toContain('이어할 CLI 세션 없음');
    expect(fresh!.closedAt).toBeNull();
    expect(fresh!.previousSessionId).toBe(s1.id);
    expect(fresh!.replaceReason).toContain('이어할 CLI 세션 없음');
    expect(fresh!.handoverSummary).toContain(`이전 세션 ${s1.id}`);
  });
});
