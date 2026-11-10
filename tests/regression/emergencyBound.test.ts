/**
 * 긴급 정지 종료 확인의 시간 한도 (windows:F9, CTL-03 3초 안 종료 확인·요약).
 * 프로세스를 띄우기 전인 턴(작업 폴더 만들기·검수 사본·어댑터 준비 중)은 정지 요청을 보면 프로세스를 띄우지 않는다.
 * 예전에는 긴급 정지가 그 준비(큰 저장소의 git worktree add 등)가 끝날 때까지 기다려 요약·알림이 수십 초 늦었다.
 * 취소·지시 취소는 지금처럼 그 턴이 대기열 정리까지 마치기를 기다린다 (directiveCancel.test.ts, CONC-04).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { OWNER } from '@shared/domain';
import type { PreparedRun } from '../../src/main/agents/types';
import type { AppToolServer } from '../../src/main/mcp/types';
import { directiveKey } from '../../src/main/orchestrator/records';
import { STOP_CONFIRM_MS } from '../../src/main/orchestrator/turns';
import type { Env } from './helpers';
import { boot, newDirective, sleep, stubAdapter, waitFor } from './helpers';
import { MAIN_AGENT_ID } from '@shared/domain';
import { killFakePids, pidAlive } from '../fixtures/desktop/fakeDesktop';
import { STOP_UNCONFIRMED_KEYS } from '../../src/main/desktop/desktopHelper';
import { bootGui, capture, liveMain, type GuiEnv } from './guiRig';

let env: Env | null = null;
let gui: GuiEnv | null = null;
let release: (() => void) | null = null;
afterEach(async () => {
  release?.();
  release = null;
  if (env) await waitFor(() => env!.core.turns.count() === 0, '턴 정리', 10_000).catch(() => undefined);
  await env?.close();
  env = null;
  if (gui) {
    const pids = gui.fake.pids();
    await gui.close();
    killFakePids(pids);
  }
  gui = null;
});

describe('긴급 정지는 시작 준비 중인 턴을 무한정 기다리지 않는다 (windows:F9)', () => {
  it('어댑터 준비가 끝나지 않은 턴이 있어도 요약은 3초 안팎 — 완료로 표시하고, 그 턴은 프로세스를 띄우지 않고 끝나며 업무는 대기열에 남는다', async () => {
    const gate = new Promise<void>((r) => (release = r));
    let prepared = false;
    const blocking = stubAdapter('claude', async (launch): Promise<PreparedRun> => {
      prepared = true;
      await gate; // 큰 저장소의 작업 폴더 만들기·느린 준비
      return { spec: { command: process.execPath, args: ['-e', ''], cwd: launch.cwd, env: {}, stdinText: null, label: 'stub' }, expectedCliSessionId: null, cleanup: [], display: 'stub' };
    });
    env = await boot({ adapters: { claude: blocking, codex: blocking } });
    const e = env;
    e.core.toolServer = {
      url: 'http://127.0.0.1:9/mcp',
      start: async () => ({ url: 'http://127.0.0.1:9/mcp', port: 9 }),
      stop: async () => undefined,
      issueToken: () => 'tok-emergency',
      revokeToken: () => undefined,
      revokeTurn: () => undefined,
    } satisfies AppToolServer;
    const starts: string[] = [];
    const runner = e.ctx.deps.runner;
    const origStart = runner.start.bind(runner);
    runner.start = (spec) => {
      starts.push(spec.label);
      return origStart(spec);
    };

    const directiveId = newDirective(e);
    const key = directiveKey(directiveId);
    const plan = e.ctx.store.queue.list({ ref2: key, state: 'queued' })[0]!;
    e.core.turns.launch({ sessionKey: key, memberId: e.producer.id, slotClass: 'management', priority: 'high', queuedAt: plan.queuedAt, urgent: false }, [plan.id]);
    await waitFor(() => prepared, '계획 턴 준비');

    const t0 = Date.now();
    const summary = await Promise.race([e.core.stops.emergency(OWNER), sleep(8000).then(() => null)]);
    const took = Date.now() - t0;
    expect(summary, '긴급 정지 요약이 준비 중인 턴을 기다리느라 늦음').not.toBeNull();
    expect(took).toBeLessThan(STOP_CONFIRM_MS + 1500);
    expect(summary!.completed).toBe(true);
    expect(summary!.stoppedTurns).toHaveLength(1);
    expect(summary!.stoppedTurns[0]).toMatchObject({ ok: true, memberId: e.producer.id });
    expect(summary!.stoppedTurns[0]!.detail).toContain('실행 전 정지');
    expect(e.core.turns.count()).toBe(1); // 준비는 아직 끝나지 않았다

    release!();
    await waitFor(() => e.core.turns.count() === 0, '준비 중이던 턴 종료');
    expect(starts).toEqual([]); // 정지 뒤에는 프로세스를 띄우지 않는다
    const turn = e.ctx.store.turns.list().find((t) => t.directiveId === directiveId)!;
    expect(turn).toMatchObject({ endReason: 'user_stop', process: { pid: null } });
    // 전달하지 못한 업무는 잃지 않는다 — 정지가 풀리면 실행된다
    expect(e.ctx.store.queue.get(plan.id)?.state).toBe('queued');
  });
});

describe('긴급 정지는 답하지 않는 화면 도우미를 무한정 기다리지 않는다 (리드 결정 S6-9, CTL-03)', () => {
  it('화면 도우미가 STOP에 답하지 않아도 요약은 3초 안팎 — 답을 0.8초 기다린 뒤 끝내고, 눌린 키를 뗐는지 모르므로 완료로 표시하지 않는다 (가짜 화면 도우미)', async () => {
    const g = (gui = await bootGui({ noAck: ['STOP'] }));
    const turnId = await liveMain(g.e);
    await capture(g.e, turnId);
    const pid = g.fake.pids()[0]!;
    const t0 = Date.now();
    const summary = await Promise.race([g.e.core.stops.emergency(OWNER), sleep(8000).then(() => null)]);
    const took = Date.now() - t0;
    expect(summary, '긴급 정지 요약이 화면 도우미의 답을 기다리느라 늦음').not.toBeNull();
    expect(took).toBeLessThan(STOP_CONFIRM_MS + 1500);
    expect(summary!.completed).toBe(false);
    expect(summary!.failures.map((f) => [f.memberId, f.detail, f.remaining])).toEqual([[MAIN_AGENT_ID, STOP_UNCONFIRMED_KEYS, -1]]);
    // 메인 턴 자체는 끝났고, 도우미도 끝냈다 — 실패는 '뗐는지 모른다'는 것뿐
    expect(summary!.stoppedTurns.map((t) => [t.memberId, t.ok])).toEqual([[MAIN_AGENT_ID, true]]);
    expect(pidAlive(pid)).toBe(false);
    // STOP을 쓴 뒤에 끝냈다 (가짜 도우미가 STOP 줄을 받았다)
    expect(g.fake.received()).toContain('STOP');
  });
});
