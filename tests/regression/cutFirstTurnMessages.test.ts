/**
 * 재시작: 세션의 첫 턴이 끊겼을 때 그 턴에 실린 팀원 메시지 (S7-B5 — AC-36-obs '메시지 기록은 전달 여부를 사실대로', CLI-10, ERR-03, S6-C5 이웃).
 * Claude는 세션 ID를 띄울 때 정하므로 끊긴 턴의 세션이 '이어할 수 있음'으로 남고, 그 턴에 실린 메시지는 전달됨이 된다. 그런데 세션의 첫 턴이 Claude가 대화
 * 기록을 쓰기 전에 끊겼으면 다음 이어하기가 실패해 새 세션이 열린다. 새 세션의 인계 요약은 대표 직접 메시지만 넘기므로(S6-C5), 같은 턴에 실린 팀원
 * 메시지(send_message·instruct_member)는 어느 CLI 세션에도 닿지 않았는데 기록은 '전달됨'으로 남았다 (Codex처럼 세션 ID가 없으면 다시 넣었다 — CLI 종류에
 * 따라 달랐다). 이제 끊긴 턴이 그 세션의 첫 턴이면 팀원 메시지를 '(다시 전달)'로 다시 넣고 전달 기록을 지운다 — 이어하기가 되면 한 번 더 받을 뿐 잃지 않는다.
 * 대표 직접 메시지는 그대로(전달됨) 두고 인계 요약이 넘긴다.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { enqueue, taskKey } from '../../src/main/orchestrator/records';
import { bootRestartable, seedDirective, waitUntil, type RestartableEnv } from '../acceptance/stops-helpers';

let renv: { v: RestartableEnv } | null = null;
afterEach(async () => {
  await renv?.v.close();
  renv = null;
});

const OWNER_TEXT = '결제 버튼 문구를 "지금 결제"로 바꿔 주세요';
const AGENT_TEXT = '테스트는 결제 실패 경우도 넣어 주세요';

/** Claude 팀원의 새 세션 첫 턴이 대표 메시지·팀원 메시지를 싣고 뜬 뒤 앱이 끊긴다 → 재시작 뒤 이어하기 턴까지 */
async function cutFirstTurn(): Promise<{ e: RestartableEnv; key: string; messageId: string; cliSessionId: string }> {
  renv = { v: await bootRestartable({ mock: false }) };
  let e = renv.v;
  await e.internal('members.update', e.devId, { ai: { kind: 'claude' } });
  const d = seedDirective(e);
  const t = e.core.tasks.create({ directiveId: d.id, title: '결제 화면', goal: '화면', type: 'development', assigneeId: e.devId, acceptanceCriteria: ['동작'], outputMode: 'repo' }, e.producerId);
  const key = taskKey(t.id);
  e.hold.add(key);
  e.tick();
  await waitUntil(() => !!e.liveProc(key), '첫 턴');
  const p1 = e.liveProc(key)!;
  expect((await e.tool(p1.turnId, 'set_steps', { steps: ['화면', '테스트'] })).ok).toBe(true);
  await e.main('instruct_member', { member_id: e.devId, text: OWNER_TEXT, urgent: true });
  // 프로듀서의 팀원 메시지 (send_message와 같은 항목·기록)
  const messageId = e.ctx.store.nextId('message');
  enqueue(e.ctx, { kind: 'message', memberId: e.devId, sessionKey: key, projectId: e.projectId, taskId: t.id, directiveId: d.id, message: `프로듀서의 메시지: ${AGENT_TEXT}`, messageId });
  e.ctx.store.messages.insert({ id: messageId, requestId: null, fromActor: e.producerId, toMemberId: e.devId, sessionKey: null, text: AGENT_TEXT, kind: 'agent', sharedWith: [], urgent: false, createdAt: e.ctx.now(), deliveredAt: null });
  p1.finishOk();
  await waitUntil(() => !e.core.turns.hasLiveSession(key), '첫 턴 종료');
  // 세션을 바꿔 다음 턴이 새 Claude 세션의 첫 턴이 되게 한다 — 그 턴이 두 메시지를 싣는다
  e.core.turns.closeSessions(key, '테스트: 세션 교체');
  e.tick();
  await waitUntil(() => !!e.liveProc(key), '두 메시지를 실은 새 세션 첫 턴');
  const s2 = e.ctx.store.sessions.list({ ref2: key }).find((s) => !s.closedAt)!;
  expect(e.launchesOf(key).at(-1)!.message).toContain('지금 결제');
  expect(e.launchesOf(key).at(-1)!.message).toContain('결제 실패 경우');
  e.crash();
  e = renv.v = await e.reboot({ holdAll: true });
  // 재시작 뒤 첫 턴은 끊긴 세션을 이어하려 한다
  await waitUntil(() => !!e.liveProc(key), '재시작 뒤 이어하기 턴');
  expect(e.launchesOf(key).at(-1)!.resume).toBe(s2.cliSessionId);
  return { e, key, messageId, cliSessionId: s2.cliSessionId! };
}

describe('세션 첫 턴이 끊긴 뒤의 팀원 메시지는 조용히 잃지 않는다 (S7-B5, AC-36-obs)', () => {
  it('이어하기가 실패하면 새 세션 첫 턴이 팀원 메시지도 받는다 — 대표 메시지는 인계 요약으로, 기록은 새 세션에 닿은 뒤 전달됨', async () => {
    const { e: e0, key, messageId, cliSessionId } = await cutFirstTurn();
    let e = e0;
    const pr = e.liveProc(key)!;
    // 재시작 뒤 이어하기 턴이 뜨기 전 기록: 팀원 메시지는 전달됨이 아니다 (다시 넣음)
    expect(e.launchesOf(key).at(-1)!.message).toContain('결제 실패 경우');
    pr.emit({ kind: 'error', text: `No conversation found with session ID: ${cliSessionId}`, data: { errorKind: 'other', resumeFailed: true } });
    pr.exit(1);
    await waitUntil(() => pr.done && !e.core.turns.hasLiveSession(key), '이어하기 실패 턴 종료');
    e.tick();
    await waitUntil(() => !!e.liveProc(key), '새 세션 첫 턴');
    e = renv!.v;
    const launch = e.launchesOf(key).at(-1)!;
    expect(launch.resume).toBeNull();
    expect(launch.message).toContain('지금 결제'); // 대표 메시지: 인계 요약 (S6-C5)
    expect(launch.message).toContain('결제 실패 경우'); // 팀원 메시지: 다시 전달
    const startedAt = e.ctx.store.turns.get(e.liveProc(key)!.turnId)!.startedAt;
    const rec = e.ctx.store.messages.get(messageId)!;
    expect(rec.deliveredAt).not.toBeNull();
    expect(rec.deliveredAt! >= startedAt).toBe(true);
    expect(rec.undeliveredAt ?? null).toBeNull();
  });

  it('이어하기가 되면 팀원 메시지를 "(다시 전달)"로 한 번 더 받는다 — 대표 메시지는 다시 넣지 않는다 (같은 세션에 이미 전달)', async () => {
    const { e, key, messageId } = await cutFirstTurn();
    const launch = e.launchesOf(key).at(-1)!;
    expect(launch.message).toMatch(/\(다시 전달[^)]*\)[^\n]*결제 실패 경우/);
    expect(launch.message.split('지금 결제').length - 1).toBe(0);
    const rec = e.ctx.store.messages.get(messageId)!;
    expect(rec.deliveredAt).not.toBeNull(); // 이 이어하기 턴이 띄워질 때 다시 적었다
  });
});
