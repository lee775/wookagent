/**
 * 턴 전달 회귀 (turns):
 * - CMD-06·AC-17 메인 에이전트 긴급 지시의 프로듀서 공유 사본(옛 대표 직접 메시지 공유, CTL-05 없앰)은 그 자체로 턴을 띄우지 않고, 그 세션에 일이 생기면 그 일 뒤에 함께 간다.
 *   같은 종류 묶기(dedupe)가 공유 사본에 합치지 않고, 화면의 대기 수에 넣지 않으며, 다시 넣을 때(비정상 종료)도 공유 사본으로 남는다
 * - 15.4·AC-37 질문·막힘 보고 뒤 CLI가 턴을 끝내지 않으면 유예(deps.timing.questionEndGraceMs) 뒤 프로그램이 끝낸다 — 정상 종료로 판정
 * - ERR-03·MEM-11 세션 교체 인계 요약: 작업 세션은 지난 보류·해제와 그 세션의 질문·답변, 검수 세션은 그 검수 세션의 질문만
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentSession } from '@shared/domain';
import { MAIN_AGENT_ID } from '@shared/domain';
import { directiveKey, enqueue, mainKey, reviewKey, taskKey } from '../../src/main/orchestrator/records';
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
  const t = e.core.tasks.create({ directiveId: d.id, title: '로그인 화면', goal: '화면', type: 'development', assigneeId: e.devId, acceptanceCriteria: ['동작'], outputMode: 'repo' }, e.producerId);
  e.hold.add(taskKey(t.id));
  e.tick();
  await waitFor(() => !!e.liveProc(taskKey(t.id)), '작업 턴 시작');
  return { t, proc: e.liveProc(taskKey(t.id))! };
}

async function ticks(e: OrchEnv, n: number) {
  for (let i = 0; i < n; i++) {
    e.tick();
    await sleep(20);
  }
}

describe('긴급 지시 공유 사본 (CMD-06, AC-17 — 옛 대표 직접 메시지 공유)', () => {
  it('공유 사본만으로는 프로듀서 턴을 띄우지 않고 대기 수에도 넣지 않는다 — 보낸 메인 에이전트에게는 사본이 가지 않는다 — 그 세션에 일이 생기면 그 일 뒤에 "(긴급 지시 공유)"로 함께 가고, 같은 종류 묶기는 공유 사본에 합치지 않는다', async () => {
    env = await bootOrch();
    const e = env;
    const { t } = await liveTaskTurn(e);
    await e.main('instruct_member', { member_id: e.devId, text: '로그인 버튼은 파란색으로 해 주세요', urgent: true });
    const dk = directiveKey(t.directiveId);
    const mk = mainKey(e.projectId);
    // 메인 에이전트가 보낸 긴급 지시이므로 공유 사본은 프로듀서에게만 간다 (옛 대표 직접 메시지는 메인·프로듀서 둘 다)
    expect(e.ctx.store.queue.list({ state: 'queued' }).map((q) => [q.sessionKey, q.memberId, q.urgent, !!q.ownerShared]).sort()).toEqual(
      [
        [taskKey(t.id), e.devId, true, false],
        [dk, e.producerId, false, true],
      ].sort(),
    );
    await ticks(e, 5);
    expect(e.launches.filter((l) => l.workKey === dk || l.workKey === mk)).toEqual([]);
    for (const id of [MAIN_AGENT_ID, e.producerId]) {
      const v = e.core.views.memberView(e.ctx.store.members.require(id));
      expect({ id, queued: v.queuedCount, waitingSlot: v.statusReasons.includes('실행 자리 대기') }).toEqual({ id, queued: 0, waitingSlot: false });
    }
    // 그 세션에 다른 일(같은 종류 묶기를 쓰는 메시지)이 생긴다 → 공유 사본에 합쳐지지 않고 턴을 띄운다
    enqueue(e.ctx, { kind: 'message', memberId: e.producerId, sessionKey: dk, projectId: e.projectId, directiveId: t.directiveId, message: '진행 상황을 점검하세요', dedupeKind: true });
    expect(e.ctx.store.queue.list({ ref2: dk, state: 'queued' }).map((q) => !!q.ownerShared)).toEqual([true, false]);
    e.hold.add(dk);
    e.tick();
    await waitFor(() => !!e.liveProc(dk), '프로듀서 지시 세션 턴');
    const p = e.liveProc(dk)!;
    const msg = e.launches.find((l) => l.turnId === p.turnId)!.message;
    expect(msg).toMatch(/### 1\. 메시지 확인\n> 진행 상황을 점검하세요\n\n### 2\. 메시지 확인 \(긴급 지시 공유\)\n> \[공유\] 메인 에이전트 → [^\n]*로그인 버튼은 파란색으로 해 주세요/);
    const wc = await e.tool(p.turnId, 'get_work_context', {});
    expect(wc.ok && (wc.data as { messages: { from: string }[] }).messages.map((m) => m.from).sort()).toEqual(['긴급 지시(공유)', '욱채']);
  });

  it('공유 사본을 실은 관리 턴이 비정상 종료되면 다시 넣는 항목도 공유 사본으로 남는다 — 다시 넣은 일이 턴을 띄우고 공유 사본은 함께 간다', async () => {
    env = await bootOrch();
    const e = env;
    const { t } = await liveTaskTurn(e);
    const dk = directiveKey(t.directiveId);
    // 메인 에이전트가 개발자에게 긴급 지시 → 프로듀서 지시 세션에 공유 사본 (그 자체로 턴을 띄우지 않는다)
    await e.main('instruct_member', { member_id: e.devId, text: '이번 작업은 접근성을 먼저 봐 주세요', urgent: true });
    expect(e.ctx.store.queue.list({ ref2: dk, state: 'queued' }).map((q) => !!q.ownerShared)).toEqual([true]);
    // 그 세션에 턴을 띄우는 일이 생긴다
    enqueue(e.ctx, { kind: 'message', memberId: e.producerId, sessionKey: dk, projectId: e.projectId, directiveId: t.directiveId, message: '진행 상황을 점검하세요' });
    let n = 0;
    e.script.set(dk, (p) => (n++ === 0 ? p.exit(1) : p.finishOk('정리했습니다'))); // 첫 턴은 결과 없이 끝남
    // 개발자 작업 턴은 붙잡혀 있다 — 이 세션의 두 턴만 기다린다
    e.tick();
    await waitFor(() => e.launches.filter((l) => l.workKey === dk).length === 1 && !e.core.turns.hasLiveSession(dk), '첫 관리 턴 (비정상 종료)');
    e.tick();
    await waitFor(() => e.launches.filter((l) => l.workKey === dk).length === 2 && !e.core.turns.hasLiveSession(dk), '다시 넣은 관리 턴');
    const launches = e.launches.filter((l) => l.workKey === dk);
    expect(launches).toHaveLength(2);
    for (const l of launches) {
      // 턴을 띄운 일이 먼저, 공유 사본은 그 뒤에 (다시 넣은 턴도 같다)
      const shared = l.message.indexOf('### 2. 메시지 확인 (긴급 지시 공유)');
      expect(l.message.indexOf('### 1. 메시지 확인\n')).toBeGreaterThan(0);
      expect(shared).toBeGreaterThan(l.message.indexOf('### 1. 메시지 확인\n'));
      expect(l.message.slice(shared)).toMatch(/\[공유\] 메인 에이전트 → [^\n]*접근성을 먼저/);
    }
    expect(launches[1]!.message).toContain('(다시 전달) [공유] 메인 에이전트 →');
    expect(e.ctx.store.queue.list({ ref2: dk, state: 'queued' })).toEqual([]);
  });
});

describe('질문·막힘 보고 뒤 턴 종료 (15.4 "팀원 프로세스 종료", AC-37)', () => {
  it('막힘 보고 뒤 CLI가 턴을 끝내지 않으면 유예 뒤 프로그램이 끝낸다 — 정상 종료로 판정해 재시도·헛돌기로 세지 않고, 막힘 보류만 남으며 다시 띄우지 않는다', async () => {
    env = await bootOrch();
    const e = env;
    e.ctx.deps.timing!.questionEndGraceMs = 300;
    const { t, proc } = await liveTaskTurn(e);
    expect((await e.tool(proc.turnId, 'report_blocked', { reason: '외부 API 키가 없습니다' })).ok).toBe(true);
    await waitFor(() => proc.done && !e.core.turns.hasLiveSession(taskKey(t.id)), '프로그램이 턴을 끝냄', 5000);
    const turn = turnsOf(e, taskKey(t.id))[0]!;
    const cur = e.ctx.store.tasks.require(t.id);
    expect({ byApp: proc.terminatedByApp, endReason: turn.endReason, state: cur.state, holds: cur.hold.reasons.map((r) => r.kind), crashRetries: cur.crashRetries }).toEqual({
      byApp: true,
      endReason: 'completed',
      state: 'on_hold',
      holds: ['blocked'],
      crashRetries: 0,
    });
    await ticks(e, 4);
    expect(turnsOf(e, taskKey(t.id))).toHaveLength(1);
  });

  it('질문한 CLI가 스스로 턴을 끝내면 그대로 정상 종료다 — 프로그램이 정지를 요청한 기록이 남지 않는다', async () => {
    env = await bootOrch();
    const e = env;
    e.ctx.deps.timing!.questionEndGraceMs = 300;
    const { t, proc } = await liveTaskTurn(e);
    expect((await e.tool(proc.turnId, 'ask_producer', { question: '어느 API를 쓰나요?' })).ok).toBe(true);
    proc.finishOk('질문하고 마칩니다');
    await waitFor(() => !e.core.turns.hasLiveSession(taskKey(t.id)), '턴 종료');
    await sleep(500); // 유예가 지나도 끝난 턴은 건드리지 않는다
    const turn = turnsOf(e, taskKey(t.id))[0]!;
    expect({ byApp: proc.terminatedByApp, endReason: turn.endReason, stopRequestedAt: turn.process.stopRequestedAt }).toEqual({ byApp: false, endReason: 'completed', stopRequestedAt: null });
  });
});

describe('세션 교체 인계 요약 (ERR-03, MEM-11)', () => {
  it('작업 세션은 지난 보류·해제와 그 세션의 질문·답변을 받고, 검수 세션은 그 검수 세션의 질문만 받는다 — 다른 세션의 질문 글은 섞지 않는다', async () => {
    env = await bootOrch();
    const e = env;
    const { t } = await liveTaskTurn(e);
    const task = () => e.ctx.store.tasks.require(t.id);
    const qWork = e.core.tasks.askProducer(task(), e.ctx.store.members.require(e.devId), '택배사 API는\n어느 것을 쓰나요?', taskKey(t.id));
    e.core.tasks.answer(qWork.id, '우체국 택배 API를 쓰세요', e.producerId);
    const qReview = e.core.tasks.askProducer(task(), e.ctx.store.members.require(e.qaId), '검수 기준에 성능도 넣나요?', reviewKey(t.id));
    e.core.tasks.answer(qReview.id, '성능은 빼세요', e.producerId);
    const prev = { id: 'S-999999', cliSessionId: 'cli-old' } as AgentSession;
    const work = e.core.turns.buildHandover(taskKey(t.id), prev);
    const review = e.core.turns.buildHandover(reviewKey(t.id), prev);
    expect(work).toContain(`보류 이력: 답변 대기 / 보류 해제 → in_progress (답변 도착 ${qWork.id}) / 답변 대기 / 보류 해제 → in_progress (답변 도착 ${qReview.id})`);
    expect(work).toContain(`질문·답변: ${qWork.id} 질문: 택배사 API는 어느 것을 쓰나요? → 답변: 우체국 택배 API를 쓰세요`);
    expect(work).not.toMatch(/검수 기준|성능은 빼세요/);
    expect(review).not.toContain('보류 이력');
    expect(review).toContain(`질문·답변: ${qReview.id} 질문: 검수 기준에 성능도 넣나요? → 답변: 성능은 빼세요`);
    expect(review).not.toMatch(/택배사|우체국/);
  });
});
