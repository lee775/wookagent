/**
 * 실행 경계 회귀 (실제 앱 점검·3단계 후속에서 찾은 것):
 * - 자식 환경: 턴 실행기는 어댑터가 만든 환경(부모 CLI 세션 변수를 뺀 전체 환경)을 그대로 넘긴다.
 *   예전에는 process.env를 다시 섞어 CLAUDE_CODE_CHILD_SESSION 같은 변수가 되살아나고 윈도우에서 Path·PATH가 겹쳤다
 * - 앱 종료: 멈춘 턴의 종료 판정은 done이 풀린 뒤에도 저장소를 쓴다 → 저장소를 닫기 전에 끝까지 기다린다.
 *   예전에는 판정 도중 저장소가 닫혀 '처리되지 않은 거부'가 났다
 */
import { afterEach, describe, expect, it } from 'vitest';
import { directiveKey } from '../../src/main/orchestrator/records';
import type { OrchEnv } from './orchHarness';
import { bootOrch, sleep, waitFor } from './orchHarness';

let env: OrchEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

describe('자식 환경', () => {
  it('어댑터가 만든 환경을 그대로 넘기고 부모 프로세스 환경을 다시 섞지 않는다', async () => {
    const saved = { child: process.env.CLAUDE_CODE_CHILD_SESSION, extra: process.env.WOOK_LEAK_PROBE };
    process.env.CLAUDE_CODE_CHILD_SESSION = 'leak-probe';
    process.env.WOOK_LEAK_PROBE = '1';
    try {
      env = await bootOrch();
      const e = env;
      const d = e.core.directives.register({ projectId: e.projectId, title: '환경 점검', text: '환경 점검' }, 'M-MAIN', null);
      e.hold.add(directiveKey(d.id));
      e.tick();
      await waitFor(() => !!e.liveProc(directiveKey(d.id)), '프로듀서 턴 시작');
      expect(e.specs.length).toBeGreaterThan(0);
      for (const spec of e.specs) {
        // 가짜 어댑터는 빈 환경을 준다 → 러너도 빈 환경을 받아야 한다
        expect(spec.env).toEqual({});
        expect(spec.env.CLAUDE_CODE_CHILD_SESSION).toBeUndefined();
        expect(spec.env.WOOK_LEAK_PROBE).toBeUndefined();
      }
    } finally {
      if (saved.child === undefined) delete process.env.CLAUDE_CODE_CHILD_SESSION;
      else process.env.CLAUDE_CODE_CHILD_SESSION = saved.child;
      if (saved.extra === undefined) delete process.env.WOOK_LEAK_PROBE;
      else process.env.WOOK_LEAK_PROBE = saved.extra;
    }
  });
});

describe('앱 종료', () => {
  it('멈춘 턴의 종료 판정이 끝난 뒤에 저장소를 닫는다', async () => {
    env = await bootOrch();
    const e = env;
    const d = e.core.directives.register({ projectId: e.projectId, title: '종료 점검', text: '종료 점검' }, 'M-MAIN', null);
    e.hold.add(directiveKey(d.id));
    e.tick();
    await waitFor(() => !!e.liveProc(directiveKey(d.id)), '프로듀서 턴 시작');

    // 종료 판정을 느리게: done이 풀린 뒤 판정이 저장소를 쓰는 동안 종료가 저장소를 닫으면 안 된다
    const turns = e.core.turns as unknown as { judge: (...a: unknown[]) => Promise<void> };
    const original = turns.judge.bind(e.core.turns);
    let judged = false;
    let judgeError: unknown = null;
    turns.judge = async (...a: unknown[]) => {
      await sleep(300);
      try {
        await original(...a);
        // 판정 직후에도 저장소를 쓸 수 있어야 한다 (닫혔다면 여기서 던진다)
        e.ctx.store.turns.list();
        judged = true;
      } catch (err) {
        judgeError = err;
        throw err;
      }
    };

    await e.orch.stop();
    expect(judgeError).toBeNull();
    expect(judged).toBe(true);
  });
});
