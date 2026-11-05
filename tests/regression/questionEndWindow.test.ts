/**
 * 질문·막힘 보고 뒤 턴 종료 (15.4 "해당 작업 보류, 팀원 프로세스 종료", AC-37, CLI-02 사용량 갱신):
 * - 협조하는 CLI는 도구 결과를 받고 마무리 응답을 만드는 모델 호출을 한 번 더 한 뒤 result 이벤트(그 턴 전체 사용량·비용·마지막 응답)를 내고 스스로
 *   끝난다 — 그 호출은 몇 초를 넘기 흔하다. 프로그램은 정해진 시간이 아니라 출력이 멈춘 시간(questionEndGraceMs)으로 끊고, 계속 출력하며 끝내지
 *   않는 CLI는 상한(questionEndCapMs) 안에 끊는다. 스스로 끝낸 턴은 정지 요청 기록 없이 사용량·마지막 응답이 남는다
 * - result 없이 끝난 Claude 턴은 응답 메시지마다 실린 사용량의 부분 집계를 남긴다 (출력은 하한, 비용 모름)
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { ParsedCliEvent } from '@shared/events';
import { taskKey } from '../../src/main/orchestrator/records';
import { createClaudeParser } from '../../src/main/agents/parsers/claudeParser';
import { seedDirective, sleep, waitFor, type FakeProc } from './orchHarness';
import { bootSessions, liveCount, makeTask, toolOk, turnsOfKey, type SessEnv } from '../acceptance/sessions-helpers';

let env: SessEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

/** 작업 턴을 띄우고 단계 하나를 마친 뒤 프로듀서에게 질문한다 (턴은 살아 있다) */
async function askInLiveTurn(e: SessEnv): Promise<{ taskId: string; key: string; p: FakeProc; askedMs: number }> {
  const d = seedDirective(e);
  const t = makeTask(e, { directiveId: d.id, assignee: e.devId });
  const key = taskKey(t.id);
  e.hold.add(key);
  e.tick();
  await waitFor(() => liveCount(e, key) === 1, '작업 턴');
  const p = e.liveProc(key)!;
  await toolOk(e, p.turnId, 'set_steps', { steps: ['화면', '연동'] });
  await toolOk(e, p.turnId, 'complete_step', { step_index: 0, note: '화면' });
  await toolOk(e, p.turnId, 'ask_producer', { question: '어느 결제 API를 써야 하나요?' });
  return { taskId: t.id, key, p, askedMs: Date.now() };
}

/** 협조하는 CLI의 마무리: 응답·사용량·결과를 내고 스스로 끝낸다 */
function closeCooperatively(p: FakeProc): void {
  p.emit({ kind: 'text', text: '질문을 남겼습니다. 답변을 기다리며 턴을 마칩니다.', data: {} });
  p.emit({ kind: 'usage', text: '사용량', data: { inputTokens: 12000, outputTokens: 420, costUsd: 0.05 } });
  p.finishOk('질문을 남겼습니다. 턴을 마칩니다.');
}

describe('질문 뒤 협조하는 CLI는 끊지 않는다 (AC-37, CLI-02)', () => {
  it('기본 설정: 질문 뒤 마무리 모델 호출로 3.5초 동안 출력이 없다가 스스로 끝내는 CLI는 그대로 정상 종료로 남고 그 턴의 사용량·비용·마지막 응답이 기록된다 — 정지 요청 기록 없음', async () => {
    const e = (env = await bootSessions());
    const { taskId, key, p, askedMs } = await askInLiveTurn(e);
    void (async () => {
      await sleep(3500);
      if (!p.done) closeCooperatively(p);
    })();
    await waitFor(() => !e.core.turns.hasLiveSession(key), '질문한 턴 종료', 15_000);
    const turn = turnsOfKey(e, key)[0]!;
    expect({
      byApp: p.terminatedByApp,
      endReason: turn.endReason,
      stopMode: turn.process.stopMode,
      stopRequestedAt: turn.process.stopRequestedAt,
      usage: turn.usage,
      finalText: turn.finalText,
    }).toEqual({
      byApp: false,
      endReason: 'completed',
      stopMode: null,
      stopRequestedAt: null,
      usage: { inputTokens: 12000, outputTokens: 420, costUsd: 0.05 },
      finalText: '질문을 남겼습니다. 턴을 마칩니다.',
    });
    expect(Date.now() - askedMs).toBeGreaterThanOrEqual(3400);
    expect(e.ctx.store.tasks.require(taskId).hold.reasons.map((r) => r.kind)).toEqual(['answer_wait']);
  }, 30_000);

  it('출력이 이어지는 동안은 기다린다 — 유예(출력 없는 시간)보다 오래 걸려도 추론 진행 줄이 계속 나오면 끊지 않고, 스스로 끝내면 사용량이 남는다', async () => {
    const e = (env = await bootSessions());
    e.ctx.deps.timing!.questionEndGraceMs = 800;
    e.ctx.deps.timing!.questionEndCapMs = 10_000;
    const { key, p, askedMs } = await askInLiveTurn(e);
    void (async () => {
      // 마무리 응답을 만드는 동안 추론 진행 줄이 0.3초마다 나온다 — 모두 합쳐 2.4초 (유예 0.8초의 세 배)
      for (let i = 0; i < 8 && !p.done; i++) {
        await sleep(300);
        p.emit({ kind: 'thinking', text: `추론 중 ${i + 1}`, data: {} });
      }
      if (!p.done) closeCooperatively(p);
    })();
    await waitFor(() => !e.core.turns.hasLiveSession(key), '질문한 턴 종료', 15_000);
    const turn = turnsOfKey(e, key)[0]!;
    expect([p.terminatedByApp, turn.endReason, turn.process.stopRequestedAt, turn.usage?.outputTokens]).toEqual([false, 'completed', null, 420]);
    expect(Date.now() - askedMs).toBeGreaterThanOrEqual(2300);
  }, 30_000);
});

describe('질문 뒤 끝내지 않는 CLI는 상한 안에 끝낸다 (15.4 "팀원 프로세스 종료", AC-37)', () => {
  it('계속 출력하며 턴을 끝내지 않는 CLI는 출력이 이어져도 상한에서 프로그램이 끝낸다 — 정상 종료로 판정하고 작업은 답변 대기 보류 그대로, 실행 자리를 돌려준다', async () => {
    const e = (env = await bootSessions());
    e.ctx.deps.timing!.questionEndGraceMs = 500;
    e.ctx.deps.timing!.questionEndCapMs = 1500;
    const { taskId, key, p, askedMs } = await askInLiveTurn(e);
    void (async () => {
      // 안내("지금 턴을 마치세요")를 따르지 않고 계속 일한다 — 0.2초마다 출력
      for (let i = 0; i < 100 && !p.done; i++) {
        await sleep(200);
        if (!p.done) p.emit({ kind: 'text', text: `계속 작업 ${i + 1}`, data: {} });
      }
    })();
    await waitFor(() => p.done && !e.core.turns.hasLiveSession(key), '프로그램이 턴을 끝냄', 10_000);
    const elapsed = Date.now() - askedMs;
    const turn = turnsOfKey(e, key)[0]!;
    const cur = e.ctx.store.tasks.require(taskId);
    expect({ byApp: p.terminatedByApp, endReason: turn.endReason, state: cur.state, holds: cur.hold.reasons.map((r) => r.kind), crashRetries: cur.crashRetries }).toEqual({
      byApp: true,
      endReason: 'completed',
      state: 'on_hold',
      holds: ['answer_wait'],
      crashRetries: 0,
    });
    // 출력 없는 시간(0.5초)이 아니라 상한(1.5초)에서 끊었다
    expect(elapsed).toBeGreaterThanOrEqual(1400);
    expect(elapsed).toBeLessThan(6000);
    expect(turn.endDetail).toContain('상한');
    expect(e.core.turns.running().filter((r) => r.memberId === e.devId)).toEqual([]);
  }, 30_000);
});

describe('result 없이 끝난 Claude 턴의 사용량 (CLI-02 사용량 갱신, 보고서 작업 통계)', () => {
  const j = (o: unknown) => JSON.stringify(o);
  const parser = () => createClaudeParser({ serverName: 'wook', now: () => new Date('2026-10-27T03:00:00.000Z'), timeZone: 'Asia/Seoul' });
  const assistant = (id: string, usage: Record<string, number>, content: unknown[]) => j({ type: 'assistant', message: { id, role: 'assistant', content, usage }, parent_tool_use_id: null, session_id: 's' });

  it('응답 메시지마다 실린 사용량을 메시지 ID로 한 번씩 더해 finish가 부분 집계를 남긴다 (같은 메시지가 내용 블록마다 와도 한 번) — result가 오면 남기지 않는다', () => {
    const lines = [
      j({ type: 'system', subtype: 'init', session_id: 's', permissionMode: 'bypassPermissions', mcp_servers: [] }),
      assistant('msg_A', { input_tokens: 2, cache_read_input_tokens: 100, cache_creation_input_tokens: 10, output_tokens: 5 }, [{ type: 'thinking', thinking: '' }]),
      assistant('msg_A', { input_tokens: 2, cache_read_input_tokens: 100, cache_creation_input_tokens: 10, output_tokens: 5 }, [{ type: 'tool_use', id: 'tu1', name: 'mcp__wook__ask_producer', input: {} }]),
      j({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: '질문했습니다' }] }, session_id: 's' }),
      assistant('msg_B', { input_tokens: 3, cache_read_input_tokens: 200, output_tokens: 7 }, [{ type: 'text', text: '마무리 중' }]),
    ];
    const cut = parser();
    for (const l of lines) cut.pushLine(l);
    const fin: ParsedCliEvent[] = cut.finish(null);
    // 끝 알림(system)은 마지막 이벤트로 남는다
    expect(fin.map((x) => x.kind)).toEqual(['usage', 'system']);
    expect(fin[0]!.data).toEqual({ inputTokens: 2 + 100 + 10 + 3 + 200, outputTokens: 12, cachedInputTokens: 300 });
    expect(fin[0]!.text).toContain('부분 집계');

    const whole = parser();
    for (const l of [...lines, j({ type: 'result', subtype: 'success', is_error: false, result: '끝', session_id: 's', total_cost_usd: 0.01, usage: { input_tokens: 5, cache_read_input_tokens: 300, cache_creation_input_tokens: 10, output_tokens: 40 } })]) whole.pushLine(l);
    expect(whole.finish(0)).toEqual([]);
  });
});
