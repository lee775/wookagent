/**
 * 질문(ask_producer)으로 끝낸 턴은 진척 없는 재개·판정 없는 검수 턴으로 세지 않는다 (S7-B4, stage-6 회귀 — 15.4, AC-37, 8장 헛돌기).
 * stage 6이 질문 뒤 턴 종료를 고정 3초에서 '출력 없이 8초, 상한 30초'로 바꾸자(S6-C2) 답이 그 창 안에 도착할 수 있게 됐다. 그러면 작업이 진행·검수로
 * 돌아온 뒤에 질문한 턴이 끝나, 작업자 턴은 '진척 없는 자동 재개'로 세 번이면 헛돌기 보류(재계획)가 되고, 검수 턴은 판정 재촉 횟수가 올라 세 번이면
 * 검수자 교체 요청(reviewer_assign)이 나갔다. 답이 턴이 끝난 뒤 오면 세지 않았다 — 같은 일이 답이 온 시점에 따라 다르게 판정됐다.
 * 이제 질문·막힘 보고로 끝내기로 한 턴은 세지 않고, 답이 이미 그 세션에 기다리면 '이어서 진행'·판정 재촉도 넣지 않는다 — 답이 다음 턴을 연다.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { reviewKey, taskKey } from '../../src/main/orchestrator/records';
import { seedDirective, sleep, startReview, waitFor } from './orchHarness';
import { bootSessions, liveCount, makeTask, toolOk, turnsOfKey, type SessEnv } from '../acceptance/sessions-helpers';

let env: SessEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

/** 질문하고 마무리 출력을 이어 가다 스스로 끝내는 턴 — inside면 그 사이(질문 뒤 창 안에) 답이 도착한다 */
async function askAndFinish(e: SessEnv, key: string, n: number, inside: boolean, question: string, answer: string): Promise<void> {
  await waitFor(() => liveCount(e, key) === 1, `턴 ${n}`);
  const p = e.liveProc(key)!;
  if (n === 1 && key.startsWith('task:')) await toolOk(e, p.turnId, 'set_steps', { steps: ['화면', '연동'] });
  const r = await toolOk(e, p.turnId, 'ask_producer', { question });
  const qid = String(r.questionId);
  for (let i = 0; i < 8; i++) {
    await sleep(100);
    p.emit({ kind: 'thinking', text: `마무리 응답 작성 중 ${i}`, data: {} });
    if (inside && i === 2) e.core.tasks.answer(qid, answer, e.producerId);
  }
  p.finishOk('질문을 남겼습니다. 턴을 마칩니다.');
  await waitFor(() => !e.core.turns.hasLiveSession(key), `질문한 턴 ${n} 종료`);
  if (!inside) e.core.tasks.answer(qid, answer, e.producerId);
  await sleep(50);
}

const WHEN = [
  ['답이 질문 뒤 창 안에(턴이 끝나기 전에) 도착', true],
  ['답이 질문한 턴이 끝난 뒤 도착', false],
] as const;

describe('질문으로 끝낸 턴의 판정은 답이 언제 오든 같다 (S7-B4)', () => {
  it.each(WHEN)('작업자 턴: %s — 세 번 이어져도 진척 없는 재개로 세지 않고 헛돌기 보류가 없으며, 답이 다음 턴을 연다', async (_label, inside) => {
    const e = (env = await bootSessions());
    e.ctx.deps.timing!.questionEndGraceMs = 400;
    e.ctx.deps.timing!.questionEndCapMs = 5000;
    const d = seedDirective(e);
    const t = makeTask(e, { directiveId: d.id, assignee: e.devId });
    const key = taskKey(t.id);
    e.hold.add(key);
    e.tick();
    const counts: number[] = [];
    for (let n = 1; n <= 3; n++) {
      await askAndFinish(e, key, n, inside, `질문 ${n}: 어느 결제 API를 쓰나요?`, `답 ${n}: 토스 결제 API`);
      const cur = e.ctx.store.tasks.require(t.id);
      counts.push(cur.noProgressResumes);
      expect(cur.state).toBe('in_progress');
      // 답만 기다린다 — '이어서 진행' 재촉을 덧붙이지 않는다
      const waiting = e.ctx.store.queue.list({ ref2: key, state: 'queued' });
      expect(waiting).toHaveLength(1);
      expect(waiting[0]!.message).toContain(`답 ${n}`);
      expect(waiting[0]!.message).not.toContain('계속 진행하세요');
      e.tick();
    }
    expect(counts).toEqual([0, 0, 0]);
    expect(e.ctx.store.tasks.require(t.id).hold.reasons).toEqual([]);
    expect(e.ctx.store.queue.list().filter((q) => q.kind === 'replan' && q.taskId === t.id)).toEqual([]);
    await waitFor(() => turnsOfKey(e, key).length === 4, '답을 실은 네 번째 턴');
  }, 60_000);

  it.each(WHEN)('검수자 턴: %s — 판정 재촉 횟수를 올리지 않고 검수자 교체 요청(reviewer_assign)도 없으며, 답을 실은 턴의 판정을 받는다', async (_label, inside) => {
    const e = (env = await bootSessions());
    e.ctx.deps.timing!.questionEndGraceMs = 400;
    e.ctx.deps.timing!.questionEndCapMs = 5000;
    const { task } = await startReview(e, e.qaId, { outputMode: 'repo' });
    const rk = reviewKey(task.id);
    // 판정 재촉 횟수는 deliveries로 센다 (리드 결정 30·40)
    const nudged: number[] = [];
    for (let n = 1; n <= 3; n++) {
      await askAndFinish(e, rk, n, inside, `질문 ${n}: 결제 실패 화면도 완료 조건에 들어가나요?`, `답 ${n}: 네, 들어갑니다`);
      const q = e.ctx.store.queue.list({ ref2: rk, state: 'queued' }).filter((x) => x.kind === 'review');
      nudged.push(Math.max(0, ...q.map((x) => x.deliveries ?? 0)));
      expect(q.some((x) => x.message.includes(`답 ${n}`))).toBe(true);
      expect(q.some((x) => x.message.includes('검수 결과가 아직 등록되지 않았습니다'))).toBe(false);
      e.tick();
    }
    expect(e.ctx.store.queue.list().filter((q) => q.kind === 'reviewer_assign' && q.taskId === task.id)).toEqual([]);
    expect(nudged).toEqual([0, 0, 0]);
    await waitFor(() => liveCount(e, rk) === 1, '답을 실은 검수 턴');
    const r = await toolOk(e, e.liveProc(rk)!.turnId, 'submit_review', { task_id: task.id, verdict: 'pass', criteria: [{ criterion: '문서가 있다', pass: true, note: '확인' }], reason: '' });
    expect(r.verdict).toBe('pass');
  }, 60_000);
});
