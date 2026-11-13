/**
 * 제품 시계(systemClock — createSteadyWallClock)의 작은 되돌림 막기가 지키는 세 길 (리드 결정 S10-12). 벽시계를 바꿔 넣어 두 기록 사이에서 0.5초 뒤로
 * 옮긴다 (WSL2는 약 30초마다 그만큼 당겨진다, S10t 실측). 같은 흐름을 그냥 벽시계(되돌림을 따라감)로도 돌려 그때는 틀린 결과가 나오는 것까지 본다 — 시험이
 * 그 되돌림을 실제로 겪는다는 증거다.
 * - 재개 업무 (turns.pauseItemEnded `since > createdAt`): 프로그램이 건 정지 뒤에 넣은 재개 업무가 '그 뒤 다른 까닭으로 다시 일시정지됨'으로 조용히 지워졌다
 * - 자리 교체 (seat.unconfirmedOutgoingEnd `endedAt >= requestedAt`): 교체를 청한 뒤 종료를 확인하지 못한 채 끝난 나가는 메인 턴을 놓쳐, 새 보유자가
 *   앉았다 (CTL-11 빈틈)
 * - 멈춤 알림 (alerts `createdAt >= since`): 같은 회차의 새 계획 지연이 이미 알린 지연으로 보여 메인 에이전트에게 가지 않았다
 * 잡는 결함: 제품 시계가 되돌림을 따라감 (작은 되돌림 막기를 뺌)
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID, type AiConfig, type QueueEntry } from '@shared/domain';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSteadyWallClock, systemClock, type Clock } from '@core/time';
import { buildOrchestratorDeps } from '../../src/main/backend/buildDeps';
import { deadWorkReason } from '../../src/main/orchestrator/turns';
import { alertKey } from '../../src/main/orchestrator/alerts';
import { directiveKey, enqueue, mainKey } from '../../src/main/orchestrator/records';
import { bootOrch, seedDirective, waitFor, type OrchEnv } from './orchHarness';
import { hostExec, liveMainTurn, scriptedHost } from './hostExecRig';

let env: OrchEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

/** 시험이 옮길 수 있는 벽시계 위의 두 시계: 제품 시계와 그냥 벽시계 */
function steppedWall(): { step: (ms: number) => void; product: Clock; plain: Clock } {
  let offset = 0;
  const wall = (): number => Date.now() + offset;
  return {
    step: (ms) => void (offset += ms),
    product: createSteadyWallClock(wall),
    plain: { now: () => new Date(wall()), iso: () => new Date(wall()).toISOString(), ms: wall },
  };
}

const CASES = [
  ['제품 시계 (작은 되돌림을 막음)', 'product', true],
  ['그냥 벽시계 (대조 — 되돌림을 따라감)', 'plain', false],
] as const;

describe('제품이 실제로 쓰는 시계 (리뷰 TD-1)', () => {
  it('앱 조립(buildOrchestratorDeps)은 시계를 주지 않으면 systemClock(작은 되돌림을 막는 시계)을 쓴다 — 데스크톱 앱·서버가 그렇게 조립한다', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'wook-test-clockdeps-'));
    try {
      const deps = await buildOrchestratorDeps({
        dataDir,
        appRoot: process.cwd(),
        isPackaged: false,
        nodeExecPath: process.execPath,
        nodeExecEnv: {},
        shell: null,
        memorySecrets: true,
        runnerMode: process.platform === 'win32' ? 'taskkill' : 'pgroup',
        jobHelper: null,
      });
      try {
        expect(deps.clock).toBe(systemClock);
      } finally {
        deps.store.close();
        deps.runner.dispose?.();
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });
});

describe('벽시계가 두 기록 사이에서 0.5초 뒤로 가도 제품의 앞뒤 판정이 맞다 (S10-12)', () => {
  for (const [name, which, right] of CASES) {
    it(`재개 업무: 프로그램이 건 정지 뒤에 넣은 재개 업무는 지워지지 않는다 — ${name}`, async () => {
      const w = steppedWall();
      const e = (env = await bootOrch({ clock: w[which] }));
      await e.core.stops.pauseMember(e.producerId, 'immediate', 'system', '시험: 종료 확인 실패');
      w.step(-500);
      const item = enqueue(e.ctx, { kind: 'message', memberId: MAIN_AGENT_ID, sessionKey: mainKey(e.projectId), projectId: e.projectId, pausedMemberId: e.producerId, priority: 'high', message: '시험: 재개 업무' });
      const dead = deadWorkReason(e.ctx, item);
      if (right) expect(dead).toBeNull();
      else expect(dead).toContain('그 뒤 다른 까닭으로 다시 일시정지됨');
    });

    it(`자리 교체: 교체를 청한 뒤 종료를 확인하지 못하고 끝난 나가는 메인 턴(서버 명령)이 있으면 앉히지 않는다 — ${name}`, async () => {
      const w = steppedWall();
      const e = (env = await bootOrch({ workspace: true, clock: w[which] }));
      const CODEX: AiConfig = { kind: 'codex', model: null, effortTier: 'high', effortOverride: null };
      e.core.seat.applyOperatorConfig({ holders: null, drainMs: 200, initialHolder: null }, '시험');
      e.ctx.deps.timing!.memoTurnMs = 1_000;
      scriptedHost(e, { exitAfterMs: null, onStart: (p) => (p.terminateResult = { ok: false, remaining: -1, detail: '가짜 종료 확인 실패', durationMs: 1 }) });
      const { turnId } = await liveMainTurn(e);
      const pending = hostExec(e, turnId, { command: 'npm run dev' });
      await waitFor(() => e.core.hostExec.count() === 1, '서버 명령 시작');
      const swap = e.core.seat.assign({ holder: { kind: 'launched', ai: CODEX }, by: 'operator', reason: '운영자 교체' });
      w.step(-500); // 교체를 청한 직후 — 나가는 턴은 0.2초 뒤에 끝난다
      await swap.done;
      await pending;
      expect(e.ctx.store.turns.require(turnId).process.state).toBe('kill_failed');
      const stage = e.ctx.store.seat.get('main')!.swap?.stage ?? null;
      if (right) expect([stage, e.core.seat.view().holder?.label]).toEqual(['unconfirmed', 'Claude CLI']);
      else expect([stage, e.core.seat.view().holder?.label]).toEqual([null, 'Codex CLI']);
    });

    it(`멈춤 알림: 같은 회차에 계획이 다시 멈추면 메인 에이전트에게 따로 알린다 — ${name}`, async () => {
      const w = steppedWall();
      const e = (env = await bootOrch({ clock: w[which] }));
      const d = seedDirective(e, '계획 지시');
      e.ctx.store.directives.put({ ...e.ctx.store.directives.require(d.id), state: 'planning' });
      const key = alertKey('plan-stuck', d.id);
      const judge = (l: unknown) => (e.core.turns as unknown as { judgeDirective(l: unknown): void }).judgeDirective(l);
      const stalled = () => {
        const q = enqueue(e.ctx, { kind: 'plan', memberId: e.producerId, sessionKey: directiveKey(d.id), projectId: e.projectId, directiveId: d.id, priority: 'high', deliveries: 2, message: '재촉 (plan, 시험)' });
        e.ctx.store.queue.put({ ...e.ctx.store.queue.require(q.id), state: 'done', doneAt: e.ctx.now() });
        return { directiveId: d.id, entryKinds: ['plan'], entryIds: [q.id], memberId: e.producerId, sessionKey: directiveKey(d.id) };
      };
      const alerts = (): QueueEntry[] => e.ctx.store.queue.list({ ref1: MAIN_AGENT_ID }).filter((q) => q.kind === 'alert' && q.alertKey === key);
      judge(stalled());
      expect(alerts()).toHaveLength(1);
      e.ctx.store.queue.put({ ...alerts()[0]!, state: 'done', doneAt: e.ctx.now() });
      w.step(-500); // 메인이 다시 맡긴 계획이 곧바로 또 멈췄다
      judge(stalled());
      expect(alerts().map((q) => q.state)).toEqual(right ? ['done', 'queued'] : ['done']);
    });
  }
});
