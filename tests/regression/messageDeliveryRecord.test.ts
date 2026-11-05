/**
 * 메시지 기록이 전달 여부를 사실대로 남긴다 (AC-36-obs, CLI-10, ERR-03):
 * - 대기열에서 지운 항목이 전하던 메시지는 대표 직접 메시지든 팀원 메시지(send_message·instruct_member)든 전달 못 함(`undeliveredAt`·`undeliveredReason`)으로
 *   남는다 — 전달 대기인 메시지와 구별된다. 대표에게 알리는 것은 대표 직접 메시지뿐
 * - 재시작: 이어할 CLI 세션 없이 끊긴 턴(세션을 알리기 전에 끊긴 Codex 등)에 실린 메시지는 전달되지 않은 것이다 — 대기열로 되돌려 새 세션 첫 턴에
 *   전달하고, 그 전에는 전달됨으로 적지 않는다
 * - 이어하기 실패로 새 세션을 열면 그 업무 세션에 이미 전달한 대표 직접 메시지를 인계 요약으로 넘긴다
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID } from '@shared/domain';
import { directiveKey, enqueue, mainKey, reviewKey, taskKey } from '../../src/main/orchestrator/records';
import { artifactWorkDir } from '../../src/main/orchestrator/paths';
import { notices, seedDirective, waitFor } from './orchHarness';
import { bootSessions, launchesOfKey, liveCount, makeTask, toolOk, turnsOfKey, type SessEnv } from '../acceptance/sessions-helpers';
import { bootRestartable, seedDirective as seedRestartDirective, waitUntil, type RestartableEnv } from '../acceptance/stops-helpers';

let env: SessEnv | null = null;
let renv: { v: RestartableEnv } | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
  await renv?.v.close();
  renv = null;
});

const PASS = { verdict: 'pass', criteria: [{ criterion: '동작한다', pass: true, note: '확인' }], reason: '' };
const OWNER_FIRST = /이번 턴에 전달된 일 \d건\n\n(## 이전 세션에서 넘겨받은 내용\n(> [^\n]*\n)+\n)?### 1\. 메시지 확인 \(긴급 지시 우선 전달\)\n> 메인 에이전트 긴급 지시/;
const msgOf = (e: { ctx: SessEnv['ctx'] }, to: string, text: string) => e.ctx.store.messages.list({ ref1: to }).find((m) => m.text.includes(text))!;

/** 산출물형 작업을 제출해 검수 대기로 만든다 (검수 세션은 붙잡아 둔다) */
async function artifactInReview(e: SessEnv) {
  const d = seedDirective(e);
  const t = makeTask(e, { directiveId: d.id, assignee: e.devId, title: '안내서', type: 'docs', outputMode: 'artifact' });
  const key = taskKey(t.id);
  const rk = reviewKey(t.id);
  e.hold.add(key);
  e.hold.add(rk);
  e.tick();
  await waitFor(() => liveCount(e, key) === 1, '작업 턴');
  const p1 = e.liveProc(key)!;
  await toolOk(e, p1.turnId, 'set_steps', { steps: ['작성'] });
  writeFileSync(join(artifactWorkDir(e.ctx.paths, e.projectId, t.id), 'guide.md'), '# 안내\n', 'utf8');
  await toolOk(e, p1.turnId, 'complete_step', { step_index: 0, note: '작성' });
  await toolOk(e, p1.turnId, 'submit_for_review', { note: '제출' });
  p1.finishOk();
  await waitFor(() => e.ctx.store.tasks.require(t.id).state === 'in_review', '검수로');
  return { d, t, key, rk };
}

describe('지운 팀원 메시지도 전달 못 함으로 남는다 (AC-36-obs)', () => {
  it('검수 중 프로듀서가 send_message로 보낸 메시지가 완료 정리로 지워지면 기록·팀원 상세에 전달 못 함과 사유가 남고, 대표에게는 알리지 않는다', async () => {
    const e = (env = await bootSessions());
    const { t, key, rk } = await artifactInReview(e);
    e.tick();
    await waitFor(() => liveCount(e, rk) === 1, '검수 턴');
    const rv = e.liveProc(rk)!;
    const sent = await toolOk(e, rv.turnId, 'send_message', { to: e.devId, text: '목차를 줄여 주세요' });
    expect(String(sent.note)).toContain('검수 중');
    await toolOk(e, rv.turnId, 'submit_review', { task_id: t.id, ...PASS });
    rv.finishOk();
    await waitFor(() => e.ctx.store.tasks.require(t.id).state === 'done', '완료');
    await waitFor(() => e.ctx.store.queue.list({ ref2: key, state: 'queued' }).length === 0, '남은 항목 정리');
    const rec = msgOf(e, e.devId, '목차를 줄여 주세요');
    expect(rec.deliveredAt).toBeNull();
    expect(rec.undeliveredAt).not.toBeNull();
    expect(rec.undeliveredReason).toContain('완료');
    const view = (await e.invoke('members.getDetail', e.devId)).messages.find((m) => m.text === '목차를 줄여 주세요')!;
    expect([view.delivered, view.undelivered]).toEqual([false, rec.undeliveredReason]);
    expect(notices(e, '긴급 지시 전달 못 함')).toEqual([]);
  });

  it('메인 에이전트의 instruct_member 지시가 검수 중 완료로 지워져도 전달 못 함으로 남는다', async () => {
    const e = (env = await bootSessions());
    const { t, rk } = await artifactInReview(e);
    await e.invoke('command.send', { target: e.projectId, text: '윤슬에게 목차를 지시해 줘' });
    const mk = mainKey(e.projectId);
    e.hold.add(mk);
    e.tick();
    await waitFor(() => !!e.liveProc(mk, MAIN_AGENT_ID), '메인 에이전트 턴');
    const m = e.liveProc(mk, MAIN_AGENT_ID)!;
    const r = await toolOk(e, m.turnId, 'instruct_member', { member_id: e.devId, text: '목차는 세 단계까지만 쓰세요' });
    expect(String(r.note)).toContain('검수 중');
    m.finishOk('지시했습니다');
    await waitFor(() => !e.core.turns.hasLiveSession(mk), '메인 에이전트 턴 종료');
    e.tick();
    await waitFor(() => liveCount(e, rk) === 1, '검수 턴');
    const rv = e.liveProc(rk)!;
    await toolOk(e, rv.turnId, 'submit_review', { task_id: t.id, ...PASS });
    rv.finishOk();
    await waitFor(() => e.ctx.store.tasks.require(t.id).state === 'done', '완료');
    await waitFor(() => e.ctx.store.queue.list({ ref2: taskKey(t.id), state: 'queued' }).length === 0, '남은 항목 정리');
    const rec = msgOf(e, e.devId, '목차는 세 단계까지만');
    expect([rec.deliveredAt, !!rec.undeliveredAt]).toEqual([null, true]);
    const view = (await e.invoke('members.getDetail', e.devId)).messages.find((x) => x.text.includes('목차는 세 단계까지만'))!;
    expect(view.undelivered).toBe(rec.undeliveredReason);
    expect(notices(e, '긴급 지시 전달 못 함')).toEqual([]);
  });

  it('업무 시작이 세 번 실패해 멈춘 업무가 전하던 팀원 메시지도 전달 못 함으로 남는다', async () => {
    const e = (env = await bootSessions());
    const d = seedDirective(e);
    const key = directiveKey(d.id);
    const messageId = e.ctx.store.nextId('message');
    enqueue(e.ctx, { kind: 'message', memberId: e.producerId, sessionKey: key, projectId: e.projectId, directiveId: d.id, message: '윤슬(M-0002)의 메시지: 진행 상황 공유', messageId });
    e.ctx.store.messages.insert({ id: messageId, requestId: null, fromActor: e.devId, toMemberId: e.producerId, sessionKey: null, text: '진행 상황 공유', kind: 'agent', sharedWith: [], urgent: false, createdAt: e.ctx.now(), deliveredAt: null });
    e.prepareHook = (_launch, who) => {
      if (who.sessionKey === key) throw new Error('모델 이름이 올바르지 않습니다');
    };
    for (let i = 1; i <= 3; i++) {
      e.tick();
      await waitFor(() => {
        const q = e.ctx.store.queue.list({ ref2: key })[0]!;
        return !e.core.turns.hasLiveSession(key) && ((q.startFails ?? 0) >= i || q.state === 'cancelled');
      }, `시작 실패 ${i}`);
    }
    expect(e.ctx.store.queue.list({ ref2: key }).map((q) => q.state)).toEqual(['cancelled']);
    const rec = e.ctx.store.messages.get(messageId)!;
    expect([rec.deliveredAt, rec.undeliveredReason]).toEqual([null, expect.stringContaining('업무 시작이 3회 실패')]);
    expect(notices(e, '긴급 지시 전달 못 함')).toEqual([]);
  });
});

describe('재시작: 이어할 수 없는 세션의 끊긴 턴에 실린 메시지 (AC-36, ERR-03)', () => {
  it('Codex가 세션을 알리기 전에 끊긴 턴의 대표 메시지·팀원 메시지는 새 세션 첫 턴에 다시 전달된다 — 대표 메시지가 맨 앞, 전달 시각은 그 새 턴에 적는다', async () => {
    renv = { v: await bootRestartable({ mock: false }) };
    let e = renv.v;
    const d = seedRestartDirective(e);
    const t = e.core.tasks.create(
      { directiveId: d.id, title: '결제 화면', goal: '화면', type: 'development', assigneeId: e.devId, acceptanceCriteria: ['동작'], outputMode: 'repo' },
      e.producerId,
    );
    const key = taskKey(t.id);
    const dk = directiveKey(d.id);
    expect(e.ctx.store.members.require(e.devId).ai.kind).toBe('codex');
    e.hold.add(key);
    e.hold.add(dk);
    e.tick();
    await waitUntil(() => !!e.liveProc(key), '첫 턴');
    const p1 = e.liveProc(key)!;
    expect((await e.tool(p1.turnId, 'set_steps', { steps: ['화면', '테스트'] })).ok).toBe(true);
    // 프로듀서가 작업자에게 메시지를 보낸다 (지시 관리 턴에서)
    enqueue(e.ctx, { kind: 'message', memberId: e.producerId, sessionKey: dk, projectId: e.projectId, directiveId: d.id, message: '진행 상황을 점검하세요' });
    e.tick();
    await waitUntil(() => !!e.liveProc(dk, e.producerId), '프로듀서 턴');
    const pp = e.liveProc(dk, e.producerId)!;
    expect((await e.tool(pp.turnId, 'send_message', { to: e.devId, text: '테스트는 결제 실패 경우도 넣어 주세요' })).ok).toBe(true);
    pp.finishOk();
    const ownerText = '결제 버튼 문구를 "지금 결제"로 바꿔 주세요';
    await e.main('instruct_member', { member_id: e.devId, text: ownerText, urgent: true });
    p1.finishOk();
    await waitUntil(() => !e.core.turns.hasLiveSession(key) && !e.core.turns.hasLiveSession(dk), '첫 턴들 종료');
    // 둘째 턴: 두 메시지를 싣고 CLI를 띄운다 — Codex가 아직 세션 ID를 알리지 않았다
    e.tick();
    await waitUntil(() => !!e.liveProc(key), '메시지를 실은 둘째 턴');
    const second = e.launchesOf(key).at(-1)!.message;
    expect(second).toContain('지금 결제');
    expect(second).toContain('결제 실패 경우');
    expect(e.ctx.store.sessions.list({ ref2: key })[0]!.cliSessionId).toBeNull();
    e.crash();
    e = renv.v = await e.reboot({ holdAll: true });
    await waitUntil(() => !!e.liveProc(key), '재시작 뒤 작업 턴');
    const sessions = e.ctx.store.sessions.list({ ref2: key });
    expect(sessions.map((s) => !!s.closedAt)).toEqual([true, false]);
    const launch = e.launchesOf(key)[0]!;
    expect(launch.resume).toBeNull();
    expect(launch.message).toMatch(OWNER_FIRST);
    expect(launch.message).toContain('지금 결제');
    expect(launch.message).toContain('결제 실패 경우');
    expect(launch.message).toContain('앱이 다시 시작되어 이어서 진행합니다');
    // 전달 시각은 새 세션 첫 턴(재시작 뒤)에 적었다 — 끊긴 턴의 기록이 아니다
    const newTurn = e.ctx.store.turns.get(e.liveProc(key)!.turnId)!;
    for (const text of ['지금 결제', '결제 실패 경우']) {
      const m = msgOf(e, e.devId, text);
      expect(m.deliveredAt, text).not.toBeNull();
      expect(m.deliveredAt! >= newTurn.startedAt, text).toBe(true);
      expect(m.undeliveredAt ?? null, text).toBeNull();
    }
  });

  it('이어하기가 실패해 새 세션을 열면, 이전 세션에 전달한 대표 직접 메시지를 인계 요약으로 넘긴다 (다른 업무 세션의 메시지는 넣지 않는다)', async () => {
    const e = (env = await bootSessions());
    const d = seedDirective(e);
    const t = makeTask(e, { directiveId: d.id, assignee: e.devId, title: '결제 화면' });
    const key = taskKey(t.id);
    e.hold.add(key);
    e.tick();
    await waitFor(() => liveCount(e, key) === 1, '첫 턴');
    const p1 = e.liveProc(key)!;
    await toolOk(e, p1.turnId, 'set_steps', { steps: ['화면', '오류 처리', '테스트'] });
    await toolOk(e, p1.turnId, 'complete_step', { step_index: 0, note: '화면' });
    const text = '오류 문구는 모두 존댓말로 써 주세요';
    await e.main('instruct_member', { member_id: e.devId, text: text, urgent: true });
    p1.finishOk();
    await waitFor(() => !e.core.turns.hasLiveSession(key), '첫 턴 종료');
    // 둘째 턴(같은 CLI 세션)이 대표 메시지를 받는다
    e.tick();
    await waitFor(() => turnsOfKey(e, key).length === 2 && liveCount(e, key) === 1, '대표 메시지 전달 턴');
    expect(launchesOfKey(e, key)[1]!.message).toContain(text);
    const p2 = e.liveProc(key)!;
    await toolOk(e, p2.turnId, 'complete_step', { step_index: 1, note: '오류 처리' });
    p2.finishOk();
    await waitFor(() => !e.core.turns.hasLiveSession(key), '둘째 턴 종료');
    expect(msgOf(e, e.devId, text).deliveredAt).not.toBeNull();
    // 셋째 턴: 이어하기 대상 세션이 CLI에 없다 → 새 세션
    e.script.set(key, (p) => {
      p.emit({ kind: 'error', text: 'No conversation found with session ID: gone', data: { errorKind: 'other', resumeFailed: true } });
      p.exit(1);
    });
    e.tick();
    await waitFor(() => turnsOfKey(e, key).length === 3 && !e.core.turns.hasLiveSession(key), '이어하기 실패 턴');
    e.script.delete(key);
    e.tick();
    await waitFor(() => turnsOfKey(e, key).length === 4 && liveCount(e, key) === 1, '새 세션 첫 턴');
    const sessions = e.ctx.store.sessions.list({ ref2: key });
    expect(sessions).toHaveLength(2);
    const handover = sessions[1]!.handoverSummary ?? '';
    expect(handover).toContain('긴급 지시 (이전 세션에 전달됨');
    expect(handover).toContain(text);
    const launch = launchesOfKey(e, key)[3]!;
    expect(launch.resume).toBeNull();
    expect(launch.message).toContain('## 이전 세션에서 넘겨받은 내용');
    expect(launch.message).toContain(text);
    // 다른 업무 세션(지시 관리)의 인계에는 넣지 않는다 — 작업 세션 키로 온 것만
    expect(e.core.turns.buildHandover(directiveKey(d.id), sessions[0]!)).not.toContain(text);
  });
});
