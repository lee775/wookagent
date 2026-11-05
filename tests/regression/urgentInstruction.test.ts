/**
 * 메인 에이전트의 긴급 지시 (instruct_member urgent, SERVER_DESIGN 2.7·10.1 urgentInstruction, CLI-10 v0.6):
 * 옛 대표 직접 메시지의 보장 세 가지가 메인 긴급 지시로 그대로 성립한다 — 보통 지시(urgent 없음)에는 없는 보장이다.
 *  ① 지금 턴이 끝난 뒤 같은 업무 세션(같은 CLI 세션) 맨 앞에 우선 표시로 전달 ('interrupt'면 지금 턴을 끝내고 바로)
 *  ② 검수·병합 전에 반드시 전달 — 검수 중 작업에 온 지시는 통과해도 완료 전에 진행으로 돌려 먼저 전달한다 (반려 아님)
 *  ③ 통과 뒤 검수자에게 오면 병합 판단을 미루고 그 검수 세션에 먼저 전달해 다시 판정하게 한다
 * 대표 세션의 팀원 직접 메시지는 forbidden이다.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID } from '@shared/domain';
import { reviewKey, taskKey } from '../../src/main/orchestrator/records';
import { artifactWorkDir } from '../../src/main/orchestrator/paths';
import { seedDirective, startReview, waitFor } from './orchHarness';
import { bootSessions, launchesOfKey, liveCount, makeTask, stepsDone, toolOk, turnsOfKey, type SessEnv } from '../acceptance/sessions-helpers';

let env: SessEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const URGENT_FIRST = /이번 턴에 전달된 일 \d건\n\n### 1\. 메시지 확인 \(긴급 지시 우선 전달\)\n> 메인 에이전트 긴급 지시/;
const PASS = (taskId: string) => ({ task_id: taskId, verdict: 'pass', criteria: [{ criterion: '동작한다', pass: true, note: '확인' }], reason: '' });

/** 개발자 작업 턴 — 단계 하나를 마치고 살아 있다 (다음 턴이 이어 갈 일이 남음) */
async function devTurnWithStepLeft(e: SessEnv): Promise<{ key: string; taskId: string }> {
  const d = seedDirective(e);
  const t = makeTask(e, { directiveId: d.id, assignee: e.devId });
  const key = taskKey(t.id);
  e.hold.add(key);
  e.tick();
  await waitFor(() => liveCount(e, key) === 1, '작업 턴');
  const p = e.liveProc(key)!;
  await toolOk(e, p.turnId, 'set_steps', { steps: ['하나', '둘'] });
  await toolOk(e, p.turnId, 'complete_step', { step_index: 0, note: '하나' });
  return { key, taskId: t.id };
}

/** 산출물형 작업을 제출하는 턴 — 제출 전에 지시를 보내고(send), 제출한 뒤 검수 턴을 띄운다 */
async function submitWith(e: SessEnv, assignee: string, send: (taskId: string) => Promise<unknown>) {
  const d = seedDirective(e);
  const t = makeTask(e, { directiveId: d.id, assignee, title: '사용 안내서', type: 'docs', outputMode: 'artifact' });
  const key = taskKey(t.id);
  const rk = reviewKey(t.id);
  e.hold.add(key);
  e.hold.add(rk);
  e.tick();
  await waitFor(() => liveCount(e, key) === 1, '작업 턴');
  const p = e.liveProc(key)!;
  await toolOk(e, p.turnId, 'set_steps', { steps: ['안내서'] });
  writeFileSync(join(artifactWorkDir(e.ctx.paths, e.projectId, t.id), 'guide.md'), '# 안내\n', 'utf8');
  await toolOk(e, p.turnId, 'complete_step', { step_index: 0, note: '작성' });
  await send(t.id);
  await toolOk(e, p.turnId, 'submit_for_review', { note: '제출' });
  p.finishOk();
  await waitFor(() => e.ctx.store.tasks.require(t.id).state === 'in_review', '검수로');
  // 프로듀서에게 간 공유 메시지 턴이 먼저 돌 수 있다 — 검수 턴이 뜰 때까지 스케줄러를 돌린다
  await waitFor(() => {
    e.tick();
    return liveCount(e, rk) === 1;
  }, '검수 턴');
  return { t, key, rk, rv: e.liveProc(rk)! };
}

describe('메인 에이전트 긴급 지시의 전달 보장 (옛 대표 직접 메시지, CLI-10 v0.6)', () => {
  it('대표 세션에는 직접 메시지 길이 없다 — 메인 에이전트의 긴급 지시는 기록(보낸 쪽 M-MAIN)·프로듀서 공유와 함께 지금 턴이 끝난 뒤 같은 세션 맨 앞에 우선 전달된다 (보통 지시는 우선 표시가 없다)', async () => {
    const e = (env = await bootSessions());
    const { key } = await devTurnWithStepLeft(e);
    // 대표 직접 메시지는 화면 약속에서 지웠다 — 대표 세션에는 알 수 없는 요청이다 (리드 결정 21)
    await expect((e.invoke as unknown as (m: string, ...a: unknown[]) => Promise<unknown>)('members.sendMessage', e.devId, '대표가 직접', false)).rejects.toMatchObject({ code: 'not_found' });
    await e.main('instruct_member', { member_id: e.devId, text: '보통 지시: 로그를 남겨 주세요' });
    const sent = await e.main('instruct_member', { member_id: e.devId, text: '로그인은 OAuth로 바꿔 주세요', urgent: true });
    expect(sent).toMatchObject({ sessionKey: key, urgent: true, note: null, sharedWith: [e.producerId] });
    const msg = e.ctx.store.messages.require(String(sent.messageId));
    expect([msg.fromActor, msg.kind, msg.urgent, msg.text, msg.sharedWith]).toEqual([MAIN_AGENT_ID, 'urgent', true, '로그인은 OAuth로 바꿔 주세요', [e.producerId]]);
    expect(e.ctx.store.queue.list({ ref2: key, state: 'queued' }).map((q) => [q.urgent, q.priority]).sort()).toEqual([
      [false, 'normal'],
      [true, 'urgent'],
    ]);
    // 지금 턴에는 끼어들지 않는다 → 끝난 뒤 같은 CLI 세션 맨 앞에 긴급 지시, 그 뒤에 보통 지시
    e.tick();
    expect(turnsOfKey(e, key)).toHaveLength(1);
    e.liveProc(key)!.finishOk('1단계 마침');
    await waitFor(() => !e.core.turns.hasLiveSession(key), '첫 턴 종료');
    e.tick();
    await waitFor(() => turnsOfKey(e, key).length === 2 && liveCount(e, key) === 1, '둘째 턴');
    const [l1, l2] = launchesOfKey(e, key);
    expect(l2!.resume).toBe(l1!.newSessionId);
    expect(l2!.message).toMatch(URGENT_FIRST);
    expect(l2!.message).toContain('로그인은 OAuth로 바꿔 주세요');
    expect(l2!.message).toMatch(/### 2\. 메시지 확인\n> 메인 에이전트 직접 지시: 보통 지시/);
    const wc = await toolOk(e, e.liveProc(key)!.turnId, 'get_work_context');
    // 업무 문맥의 보낸 쪽: 긴급 지시 하나, 나머지(보통 지시·프로그램의 '계속' 안내)는 욱채
    expect((wc.messages as { from: string }[]).map((m) => m.from).sort()).toEqual(['긴급 지시', '욱채', '욱채'].sort());
    // 'interrupt'는 지금 턴을 끝내고(종료 확인) 바로 같은 세션 맨 앞에 전달한다 — 비정상 종료로 세지 않는다
    const p2 = e.liveProc(key)!;
    await e.main('instruct_member', { member_id: e.devId, text: '지금 하던 것을 멈추고 오류 문구부터', urgent: 'interrupt' });
    await waitFor(() => p2.done && !e.core.turns.hasLiveSession(key), '지금 턴 종료');
    expect(p2.terminatedByApp).toBe(true);
    e.tick();
    await waitFor(() => turnsOfKey(e, key).length === 3, '셋째 턴');
    expect(launchesOfKey(e, key)[2]!.message).toMatch(URGENT_FIRST);
    expect(launchesOfKey(e, key)[2]!.message).toContain('오류 문구부터');
    expect(e.ctx.store.tasks.require(parseTask(key)).crashRetries).toBe(0);
  });

  it('검수 중 작업에 온 긴급 지시는 통과해도 완료 전에 진행으로 돌려 같은 세션에 먼저 전달된다 — 같은 때의 보통 지시는 그대로 완료되며 전달되지 못한다', async () => {
    const e = (env = await bootSessions());
    // 긴급 지시: 통과해도 완료하지 않고 진행으로 (반려 아님)
    const a = await submitWith(e, e.devId, (id) => e.main('instruct_member', { member_id: e.devId, text: `${id} 안내서에 운영 시간을 넣어 주세요`, urgent: true }));
    const res = await toolOk(e, a.rv.turnId, 'submit_review', PASS(a.t.id));
    expect(res.taskState).toBe('in_progress');
    a.rv.finishOk();
    const cur = e.ctx.store.tasks.require(a.t.id);
    expect([cur.state, cur.review.rejectsTotal, cur.artifact]).toEqual(['in_progress', 0, null]);
    e.tick();
    await waitFor(() => turnsOfKey(e, a.key).length === 2 && liveCount(e, a.key) === 1, '긴급 지시 전달 턴');
    expect(launchesOfKey(e, a.key)[1]!.message).toMatch(URGENT_FIRST);
    expect(launchesOfKey(e, a.key)[1]!.message).toContain('운영 시간을 넣어 주세요');
    e.liveProc(a.key)!.finishOk();
    await waitFor(() => !e.core.turns.hasLiveSession(a.key), '전달 턴 종료');

    // 보통 지시(대조): 검수 중이면 그대로 통과·완료되고 그 지시는 전달되지 못한다 (긴급 지시만의 보장). 개발자는 아직 앞 작업 중이라 QA에게
    const b = await submitWith(e, e.qaId, (id) => e.main('instruct_member', { member_id: e.qaId, text: `${id} 표지도 바꿔 주세요` }));
    const resB = await toolOk(e, b.rv.turnId, 'submit_review', PASS(b.t.id));
    expect(resB.taskState).not.toBe('in_progress');
    b.rv.finishOk();
    await waitFor(() => e.ctx.store.tasks.require(b.t.id).state === 'done', '보통 지시 작업 완료');
    expect(launchesOfKey(e, b.key).some((l) => l.message.includes('표지도 바꿔 주세요'))).toBe(false);
  });

  it('통과 뒤 검수자에게 온 긴급 지시는 병합 판단을 미루고 그 검수 세션에 먼저 전달해 다시 판정하게 한다 — 검수자는 판정 전에 그 지시(urgentInstructions)를 본다', async () => {
    const e = (env = await bootSessions());
    const { task, proc } = await startReview(e, e.qaId, { outputMode: 'repo' });
    const rk = reviewKey(task.id);
    expect((await toolOk(e, proc.turnId, 'submit_review', { task_id: task.id, verdict: 'pass', criteria: [{ criterion: '문서가 있다', pass: true, note: '확인' }], reason: '' })).verdict).toBe('pass');
    const sent = await e.main('instruct_member', { member_id: e.qaId, text: '결제 화면까지 확인한 뒤 판정해 주세요', urgent: true });
    expect(sent.sessionKey).toBe(rk);
    proc.finishOk();
    await waitFor(() => !e.core.turns.hasLiveSession(rk), '검수 턴 종료');
    expect(e.ctx.store.queue.list({ state: 'queued' }).filter((q) => q.kind === 'merge_decision' && q.taskId === task.id)).toEqual([]);
    e.tick();
    await waitFor(() => liveCount(e, rk) === 1, '다시 판정 검수 턴');
    expect(launchesOfKey(e, rk).at(-1)!.message).toMatch(URGENT_FIRST);
    const target = await toolOk(e, e.liveProc(rk)!.turnId, 'get_review_target', { task_id: task.id });
    expect((target.urgentInstructions as { text: string; to: string }[]).map((x) => [x.text, x.to.includes('검수자')])).toEqual([['결제 화면까지 확인한 뒤 판정해 주세요', true]]);
    const r2 = await toolOk(e, e.liveProc(rk)!.turnId, 'submit_review', { task_id: task.id, verdict: 'reject', criteria: [{ criterion: '문서가 있다', pass: false, note: '결제 화면 미확인' }], reason: '긴급 지시대로' });
    expect([r2.verdict, r2.taskState]).toEqual(['reject', 'in_progress']);
  });
});

/** 작업 세션 키 → 작업 ID */
function parseTask(key: string): string {
  return key.slice('task:'.length);
}
