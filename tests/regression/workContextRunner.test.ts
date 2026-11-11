/**
 * workContextRunner (리드 결정 S7-17 F5): get_work_context가 그 턴을 실행하는 쪽(runner)을 말한다. 서버가 띄우는 CLI 보유자의 메인 턴과 팀원(팀 구성의 줄)은 그 CLI의
 * AI 종류다(runner === aiKind). 외부 보유자 쪽(runner 'external', aiKind null)은 tests/server/externalMainStatus.test.ts.
 * 가짜 CLI(orchHarness)만 쓴다 — 메인 모의 실행이 켜져 있고 실제 CLI는 뜨지 않는다
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID } from '@shared/domain';
import type { WorkContext } from '../../src/main/mcp/catalog';
import { bootOrch, waitFor, type OrchEnv } from './orchHarness';

let env: OrchEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

describe('get_work_context의 runner (리드 결정 S7-17 F5)', () => {
  it('CLI 보유자의 메인 프로젝트 대화 턴: you와 팀 구성의 모든 줄에 runner가 있고 그 CLI 종류와 같다', async () => {
    const e = (env = await bootOrch());
    const key = `main:${e.projectId}`;
    e.hold.add(key);
    await e.invoke('command.send', { target: e.projectId, text: '팀 구성을 알려 줘' });
    e.tick();
    await waitFor(() => !!e.liveProc(key, MAIN_AGENT_ID), '메인 프로젝트 대화 턴');
    const proc = e.liveProc(key, MAIN_AGENT_ID)!;
    const r = await e.tool(proc.turnId, 'get_work_context');
    if (!r.ok) throw new Error(`get_work_context 거부: ${r.code}`);
    const wc = r.data as WorkContext;
    const main = e.ctx.store.members.require(MAIN_AGENT_ID);
    expect([wc.you.memberId, wc.you.runner, wc.you.aiKind]).toEqual([MAIN_AGENT_ID, main.ai.kind, main.ai.kind]);
    expect(wc.team.map((m) => m.memberId).sort()).toEqual([e.producerId, e.devId, e.qaId].sort());
    for (const m of wc.team) {
      const kind = e.ctx.store.members.require(m.memberId).ai.kind;
      expect([m.memberId, m.runner, m.aiKind]).toEqual([m.memberId, kind, kind]);
    }
    proc.finishOk('팀은 셋입니다');
    await e.idle();
  });
});
