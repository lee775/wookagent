/**
 * 지시 취소와 시작 전 턴 (concurrency:CONC-04 directives.cancel 부분, TSK-09: 예약된 턴도 취소).
 * 프로듀서의 계획 턴이 턴 기록·항목 실행 중 표시를 한 뒤 CLI를 띄우기 전(prepare 대기)에 지시를 취소하면,
 * 정지된 턴이 전달하지 못한 항목을 대기열로 되돌린다. 예전에는 그 항목이 취소된 지시의 대기열에 남았다.
 * 실제 TurnRunner를 쓰고, 어댑터만 prepare를 붙잡아 둔다 (프로세스는 띄우지 않음).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID } from '@shared/domain';
import type { PreparedRun } from '../../src/main/agents/types';
import type { AppToolServer } from '../../src/main/mcp/types';
import { directiveKey } from '../../src/main/orchestrator/records';
import type { Env } from './helpers';
import { boot, newDirective, stubAdapter, waitFor } from './helpers';

let env: Env | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

describe('지시 취소 (CONC-04)', () => {
  it('CLI를 띄우기 전에 멈춘 계획 턴이 되돌린 항목까지 지운다 — 취소된 지시에 대기 항목·새 턴이 없다', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let prepared = false;
    const blocking = stubAdapter('claude', async (launch): Promise<PreparedRun> => {
      prepared = true;
      await gate;
      return {
        spec: { command: process.execPath, args: ['-e', ''], cwd: launch.cwd, env: {}, stdinText: null, label: 'stub' },
        expectedCliSessionId: null,
        cleanup: [],
        display: 'stub',
      };
    });
    env = await boot({ adapters: { claude: blocking, codex: blocking } });
    const e = env;
    const tokens: string[] = [];
    e.core.toolServer = {
      url: 'http://127.0.0.1:9/mcp',
      start: async () => ({ url: 'http://127.0.0.1:9/mcp', port: 9 }),
      stop: async () => undefined,
      issueToken: () => {
        tokens.push(`tok-${tokens.length + 1}`);
        return tokens[tokens.length - 1]!;
      },
      revokeToken: () => undefined,
      revokeTurn: () => undefined,
    } satisfies AppToolServer;

    const directiveId = newDirective(e);
    const key = directiveKey(directiveId);
    const plan = e.ctx.store.queue.list({ ref2: key, state: 'queued' });
    expect(plan.map((q) => q.kind)).toEqual(['plan']);
    e.core.turns.launch({ sessionKey: key, memberId: e.producer.id, slotClass: 'management', priority: 'high', queuedAt: plan[0]!.queuedAt, urgent: false }, [plan[0]!.id]);
    await waitFor(() => prepared, '계획 턴 준비');
    expect(e.ctx.store.queue.get(plan[0]!.id)?.state).toBe('running');

    const cancelled = e.core.directives.cancel(directiveId, MAIN_AGENT_ID);
    await new Promise((r) => setTimeout(r, 50));
    release(); // 턴이 정지 요청을 보고 시작하지 않고 끝남 → 전달 못 한 항목을 대기열로 되돌림
    await cancelled;

    expect(e.ctx.store.directives.require(directiveId).state).toBe('cancelled');
    expect(e.ctx.store.queue.list({ ref2: key, state: 'queued' })).toEqual([]);
    expect(e.core.turns.hasLiveSession(key)).toBe(false);
    expect(e.ctx.store.turns.list().filter((t) => t.directiveId === directiveId)).toHaveLength(1);
  });
});
