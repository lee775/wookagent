/**
 * 세션 이어하기 (ERR-03, MEM-11, AC-14): 세션 턴 수는 CLI를 띄운 턴만 센다.
 * - 프로세스를 띄우기 전에 멈춘 턴은 세지 않는다 → 다음 턴이 만들어지지 않은 CLI 세션을 이어하려다 헛돌지 않는다
 * - PC가 꺼져 끊긴 턴(재시작 복구가 마감)도 CLI를 띄웠으면 센다. 이어할 CLI 세션 ID가 없으면 그 세션을 닫아 새 세션이 인계 요약을 받는다
 * 가짜 CLI 오케스트레이터 (orchHarness), 같은 데이터 폴더로 다시 띄우는 것은 완료 기준 도우미(stops-helpers.bootRestartable).
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { taskKey } from '../../src/main/orchestrator/records';
import { bootRestartable, seedDirective as seedRestartDirective, waitUntil, type RestartableEnv } from '../acceptance/stops-helpers';
import type { OrchEnv } from './orchHarness';
import { bootOrch, seedDirective, waitFor } from './orchHarness';

let env: OrchEnv | null = null;
let restartable: RestartableEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
  await restartable?.close();
  restartable = null;
});

const devTask = (directiveId: string, assigneeId: string, title: string) => ({
  directiveId,
  title,
  goal: title,
  type: 'development' as const,
  assigneeId,
  acceptanceCriteria: ['동작한다'],
  outputMode: 'repo' as const,
});

describe('세션 턴 수와 이어하기 (ERR-03)', () => {
  it('프로세스를 띄우기 전에 멈춘 턴은 세션 턴으로 세지 않는다 — 다음 턴은 만들어지지 않은 CLI 세션을 이어하지 않고 새 CLI 세션으로 시작한다', async () => {
    env = await bootOrch();
    const e = env;
    const d = seedDirective(e);
    const t = e.core.tasks.create(devTask(d.id, e.devId, '시작 전 정지'), e.producerId);
    const key = taskKey(t.id);
    e.hold.add(key);
    // 어댑터 준비 중(CLI 세션 ID를 정한 뒤, 프로세스를 띄우기 전) 정지 요청이 들어온다
    e.prepareHook = (_launch, who) => {
      if (who.sessionKey === key) void e.core.turns.stopSessions([key], '시작 전 정지', true);
    };
    e.tick();
    await e.idle();
    e.prepareHook = null;
    const first = e.launches.filter((l) => l.workKey === key)[0]!;
    expect(first.resume).toBeNull();
    expect(e.ctx.store.turns.list().filter((x) => x.taskId === t.id).map((x) => [x.endReason, x.process.pid])).toEqual([['user_stop', null]]);
    expect(e.ctx.store.sessions.list({ ref2: key }).map((s) => s.turnCount)).toEqual([0]);

    e.tick();
    await waitFor(() => !!e.liveProc(key), '다음 턴');
    const second = e.launches.filter((l) => l.workKey === key)[1]!;
    expect(second.resume).toBeNull();
    expect(second.newSessionId).toBeTruthy();
    expect(second.newSessionId).not.toBe(first.newSessionId);
    expect(e.ctx.store.sessions.list({ ref2: key }).map((s) => s.cliSessionId)).toEqual([second.newSessionId]);
  });

  it('PC가 꺼질 때 이어할 CLI 세션 ID가 없던 세션(세션을 알리기 전에 끊긴 CLI)은 재시작 뒤 닫고, 새 세션이 인계 요약(목표·완료/남은 단계·마지막 커밋)을 받아 이어 간다', async () => {
    restartable = await bootRestartable();
    let e = restartable;
    const d = seedRestartDirective(e);
    const t = e.core.tasks.create(devTask(d.id, e.devId, '로그인 화면'), e.producerId);
    const key = taskKey(t.id);
    e.hold.add(key);
    e.tick();
    await waitUntil(() => !!e.liveProc(key), '작업 턴');
    const p = e.liveProc(key)!;
    expect((await e.tool(p.turnId, 'set_steps', { steps: ['화면', '테스트'] })).ok).toBe(true);
    writeFileSync(join(e.ctx.store.tasks.require(t.id).workspace!.worktreePath, 'screen.txt'), '화면\n', 'utf8');
    expect((await e.tool(p.turnId, 'complete_step', { step_index: 0, note: '화면 완료' })).ok).toBe(true);
    // CLI가 세션 ID를 알리기 전에 전원이 꺼진 경우 (Codex는 thread.started로 알린다)
    const s1 = e.ctx.store.sessions.list({ ref2: key })[0]!;
    e.ctx.store.sessions.put({ ...s1, cliSessionId: null });

    e.crash();
    e = restartable = await e.reboot({ holdAll: true });

    const next = e.launchesOf(key);
    expect(next).toHaveLength(1);
    expect(next[0]!.resume).toBeNull();
    for (const text of ['이전 세션에서 넘겨받은 내용', '완료 단계: 화면', '남은 단계: 테스트', '마지막 커밋:']) expect(next[0]!.message).toContain(text);
    const [old, fresh] = e.ctx.store.sessions.list({ ref2: key });
    expect(old).toMatchObject({ id: s1.id, turnCount: 1 });
    expect(old!.closedAt).not.toBeNull();
    expect(old!.replaceReason).toContain('이어할 CLI 세션 없음');
    expect(fresh!.closedAt).toBeNull();
    expect(fresh!.memberId).toBe(e.devId);
    expect(fresh!.handoverSummary).toContain(`이전 세션 ${s1.id}`);
  });
});
