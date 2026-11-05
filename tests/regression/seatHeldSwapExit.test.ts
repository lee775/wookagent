/**
 * 멈춘(종료를 확인하지 못한) 교체에는 늘 화면의 출구가 있다 (리드 결정 S4-18·S4-19, SERVER_DESIGN 4.3 2번, CTL-11):
 * - 교체를 멈추는 길(마무리 시간 초과의 정지·운영자 강제·메인 검수 턴·멈춘 턴의 마무리 15초 초과·인계 메모 턴)은 모두 M-MAIN에 종료 확인 실패와 같은 일시정지를
 *   건다(이미 있으면 그대로) — 화면은 메인 일시정지나 긴급 정지 때 '정지 해제'를 보인다(MainPauseNotice: stop.pausedMembers·메인의 status 'paused')
 * - 그 일시정지는 CTL-11의 것과 같다: 건 쪽 system, 단계 마치고(graceful). 먼저 걸린 M-MAIN 일시정지는 그대로 둔다 (S4-29 2번)
 * - 대표의 정지 해제는 그 일시정지만 있어도 그것을 풀고 교체를 잇는다. 그때 나가는 턴의 흐름이 아직 남았으면 잇지 않고, 일시정지도 풀지 않은 채 까닭만
 *   고친다 — '메인 에이전트 다시 시작' 알림을 보내지 않는다. 긴급 정지 중의 정지 해제도 같다(긴급 정지는 풀린다) (리드 결정 S4-27)
 * - '메인 자리 교체가 멈췄습니다' 알림은 두 모드에서 참이다 — 서버는 서버 PC의 프로세스를 말한다. 누르면 자리 보기로 간다. 운영자의 seat assign은 그동안 거부된다.
 *   교체가 끝나면 그 알림은 읽음이 된다 — '메인 에이전트가 바뀌었습니다'가 잇는다 (리드 결정 S4-36)
 * - 교체가 없으면 정지 해제는 다른 M-MAIN 흐름이 돌고 있어도 M-MAIN 일시정지를 푼다 (S4-27 — 남기는 것은 멈춘 교체일 때뿐)
 * 탐침 zz-s4fl-unconfirmed-review-exit(server-s4-flows-lifecycle), zz-s4fx-rehold-notice(server-s4fix1-flows-lifecycle)·zz-sa2-new S3(server-s4fix1-seat-authority),
 * heldSwapHold(server-s4fix1-tests-integrity), fix2Gaps G8(server-s4fix2-tests-integrity)에서 왔다
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID, OWNER, type AiConfig } from '@shared/domain';
import { bootOrch, notices, startReview, waitFor, type OrchEnv } from './orchHarness';

let env: OrchEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const CODEX: AiConfig = { kind: 'codex', model: null, effortTier: 'high', effortOverride: null };
const KEY = 'main:general';
const STALLED = '메인 자리 교체가 멈췄습니다';
const operatorSwap = (e: OrchEnv) => e.core.seat.assign({ holder: { kind: 'launched', ai: CODEX }, by: 'operator', reason: '운영자 교체' });

/** 대표 화면이 '정지 해제'를 보이는 조건 (MainPauseNotice — 메인 일시정지 / 긴급 정지 띠) */
function releaseControl(e: OrchEnv): { mainPaused: boolean; reason: string | null; globalStop: boolean } {
  const snap = e.core.views.snapshot();
  const pause = snap.stop?.pausedMembers.find((p) => p.memberId === MAIN_AGENT_ID) ?? null;
  const main = snap.members.find((m) => m.isMain);
  return { mainPaused: !!pause || main?.status === 'paused', reason: pause?.reason ?? null, globalStop: snap.stop?.global.active ?? false };
}

const operatorRefusal = (e: OrchEnv): string => {
  try {
    e.core.seat.operatorAssign('launched:codex', true);
    return '';
  } catch (err) {
    return (err as Error).message;
  }
};

describe('멈춘 교체의 출구 (seatHeldSwapExit)', () => {
  it('나가는 메인 검수 턴의 종료를 확인하지 못하면 M-MAIN 일시정지로 정지 해제가 보이고, 그 정지 해제 하나가 교체를 잇는다 (zz-s4fl-unconfirmed-review-exit)', async () => {
    const e = (env = await bootOrch());
    e.core.seat.applyOperatorConfig({ holders: null, drainMs: 200, initialHolder: null }, '시험');
    const { proc } = await startReview(e, MAIN_AGENT_ID);
    proc.terminateResult = { ok: false, remaining: -1, detail: '가짜 종료 확인 실패', durationMs: 1 };
    await operatorSwap(e).done;
    expect(e.ctx.store.seat.get('main')!.swap).toMatchObject({ stage: 'unconfirmed' });
    // 검수 턴의 종료 확인 실패는 작업 보류라 메인 일시정지가 없었다 — 교체가 건다
    expect(releaseControl(e)).toEqual({ mainPaused: true, reason: '메인 자리 교체 멈춤 (세대 1 → 2) — 나가는 메인 턴의 종료를 확인하지 못함', globalStop: false });
    // 그 정지는 CTL-11의 것과 같다 — 프로그램이 건(대표가 건 것이 아님) 단계 마치고 정지 (S4-29 2번)
    expect(e.ctx.stop().members[MAIN_AGENT_ID]).toMatchObject({ paused: true, by: 'system', mode: 'graceful' });
    expect(e.core.views.snapshot().stop!.pausedMembers.find((p) => p.memberId === MAIN_AGENT_ID)).toMatchObject({ by: 'system', mode: 'graceful' });
    const [n] = notices(e, STALLED);
    expect(n).toMatchObject({ level: 'urgent', key: 'seat-switch:2', link: { tab: 'seat' } });
    expect(n!.body).toBe(
      "Codex CLI에게 메인 자리를 넘기던 중 이전 메인 턴(Claude CLI)이 끝났는지 확인하지 못했습니다. 두 메인 에이전트가 겹쳐 돌지 않게 새 보유자를 아직 앉히지 않고 메인 에이전트를 일시정지해 두었습니다. 작업 관리자 등에서 남은 프로세스가 모두 사라졌는지 확인한 뒤 '정지 해제'를 누르면 교체를 이어 갑니다",
    );
    // 운영자의 seat assign은 그동안 거부된다 (참인 글) — 따로 둔 운영자 출구는 없다 (KNOWN_ISSUES)
    expect(operatorRefusal(e)).toBe(
      "메인 자리 교체가 멈춰 있습니다(세대 1 → 2, 나가는 메인 턴의 종료를 확인하지 못함) — 남은 프로세스가 모두 사라졌는지 확인한 뒤 대표가 '정지 해제'를 누르면 Codex CLI에게 넘어갑니다",
    );
    // seat status는 멈춤을 보인다
    expect(e.core.seat.operatorStatus().swap).toMatchObject({ stage: 'unconfirmed', from: 1, to: 2 });
    // 화면의 정지 해제 — 그 일시정지 하나뿐이어도(긴급 정지 없음) 그것을 풀고 교체를 잇는다
    expect(e.ctx.stop().global.active).toBe(false);
    expect(Object.keys(e.ctx.stop().members)).toEqual([MAIN_AGENT_ID]);
    await e.invoke('stop.release');
    await e.core.seat.settled();
    expect(releaseControl(e)).toEqual({ mainPaused: false, reason: null, globalStop: false });
    expect(e.core.seat.view()).toMatchObject({ generation: 2, state: 'active', holder: { label: 'Codex CLI' } });
    expect(notices(e, '메인 에이전트 다시 시작')).toHaveLength(1);
    expect(notices(e, '메인 에이전트가 바뀌었습니다')).toMatchObject([{ key: 'seat-change:2', link: { tab: 'seat' } }]);
    // 멈췄다는 알림('정지 해제'를 누르면 이어 갑니다)은 교체가 끝나 더는 참이 아니라 읽음이 되고, 바뀌었다는 알림이 읽지 않은 채 남는다 (리드 결정 S4-36)
    expect(notices(e, STALLED).map((x) => [x.key, !!x.readAt])).toEqual([['seat-switch:2', true]]);
    expect(notices(e, '메인 에이전트가 바뀌었습니다').map((x) => !!x.readAt)).toEqual([false]);
  });

  it('멈춘 턴의 마무리가 15초 안에 끝나지 않아도 같은 출구다 — 정지 해제 때 그 흐름이 아직 남았으면 잇지 않고 일시정지를 풀지 않은 채 둔다', async () => {
    const e = (env = await bootOrch());
    e.core.seat.applyOperatorConfig({ holders: null, drainMs: 200, initialHolder: null }, '시험');
    // 멈추지 않고 넘어가면(첫째 CTL-11 방어가 없으면) 인계 메모 턴이 실행 자리를 기다리다 교체를 마친다 — 그 기다림을 짧게 두어 시간 초과가 아니라 아래 단언이 잡게 한다 (S4-22 9번)
    e.ctx.deps.timing!.memoTurnMs = 1_000;
    e.hold.add(KEY);
    await e.invoke('command.send', { target: 'main', text: '상태 알려줘' });
    e.tick();
    await waitFor(() => !!e.liveProc(KEY, MAIN_AGENT_ID), '메인 턴 시작');
    const p = e.liveProc(KEY, MAIN_AGENT_ID)!;
    // 종료 확인은 되지만(ok) 프로세스가 끝나지 않아 턴 흐름이 남는다
    p.terminate = async () => {
      p.terminatedByApp = true;
      return { ok: true, remaining: 0, detail: '가짜 종료 — 프로세스는 남음', durationMs: 1 };
    };
    await operatorSwap(e).done; // 마무리 0.2초 → 정지 → 마무리 15초를 넘김 → 멈춤
    expect(e.ctx.store.seat.get('main')!.swap).toMatchObject({ stage: 'unconfirmed' });
    expect(e.core.turns.hasMemberFlow(MAIN_AGENT_ID)).toBe(true);
    expect(releaseControl(e)).toMatchObject({ mainPaused: true, reason: '메인 자리 교체 멈춤 (세대 1 → 2) — 나가는 메인 턴의 종료를 확인하지 못함' });
    expect(e.ctx.store.activity.search({ kinds: ['seat'], limit: 20 }).some((r) => r.text.includes('멈춘 턴의 마무리가 끝나지 않았습니다'))).toBe(true);
    const pausedSince = e.ctx.stop().members[MAIN_AGENT_ID]!.since;
    // 흐름이 남은 채 정지 해제 — 두 메인이 겹치지 않게 잇지 않고, 출구가 화면에 남게 일시정지를 풀지 않는다. 까닭만 고친다 (리드 결정 S4-27)
    await e.invoke('stop.release');
    expect(e.ctx.store.seat.get('main')!.swap).toMatchObject({ stage: 'unconfirmed' });
    expect(releaseControl(e)).toMatchObject({ mainPaused: true, reason: '메인 자리 교체 멈춤 (세대 1 → 2) — 정지 해제 때 이전 메인 턴이 아직 끝나지 않음' });
    expect(e.ctx.stop().members[MAIN_AGENT_ID]).toMatchObject({ paused: true, since: pausedSince, by: 'system', mode: 'graceful' });
    // 풀었다 다시 걸지 않았으므로 '메인 에이전트 다시 시작'(쌓인 명령을 이어서 처리합니다)은 나가지 않았다
    expect(notices(e, '메인 에이전트 다시 시작')).toEqual([]);
    expect(e.ctx.store.activity.search({ kinds: ['resume'], limit: 20 }).filter((r) => r.text.startsWith('정지 해제로 메인 에이전트 일시정지를 풂'))).toEqual([]);
    expect(notices(e, STALLED).at(-1)!.body).toBe(
      "정지 해제를 눌렀지만 이전 메인 턴(Claude CLI)이 아직 끝나지 않아 Codex CLI에게 넘기지 않았습니다. 메인 에이전트는 일시정지한 채로 두었습니다. 잠시 뒤 다시 '정지 해제'를 누르세요 — 그때 이전 메인 턴이 끝났으면 교체를 이어 갑니다",
    );
    // 그 턴이 끝난 뒤 다시 누르면 일시정지가 풀리고(참인 '다시 시작' 알림 하나) 교체를 한 번 잇는다
    p.exit(null, { terminated: true });
    await waitFor(() => !e.core.turns.hasMemberFlow(MAIN_AGENT_ID), '흐름 끝');
    await e.invoke('stop.release');
    await e.core.seat.settled();
    expect(e.core.seat.view()).toMatchObject({ generation: 2, state: 'active', holder: { label: 'Codex CLI' } });
    expect(releaseControl(e).mainPaused).toBe(false);
    expect(notices(e, '메인 에이전트 다시 시작').map((n) => n.body)).toEqual([
      '정지 해제로 메인 에이전트의 일시정지(메인 자리 교체 멈춤 (세대 1 → 2) — 정지 해제 때 이전 메인 턴이 아직 끝나지 않음)를 풀었습니다. 쌓인 명령을 이어서 처리합니다',
    ]);
    // 한 번만 이었다 — 한 번 더 눌러도 그대로
    await e.invoke('stop.release');
    await e.core.seat.settled();
    expect(e.core.seat.history().map((h) => h.generation)).toEqual([2, 1]);
    expect(notices(e, '메인 에이전트가 바뀌었습니다')).toHaveLength(1);
    expect(e.ctx.store.activity.search({ kinds: ['seat'], limit: 50 }).filter((r) => r.text.startsWith('메인 자리 교체 끝'))).toHaveLength(1);
    // 다시 쓴 멈춘 교체 알림('잠시 뒤 다시 정지 해제를 누르세요')도 교체가 끝나면 읽음이다 (리드 결정 S4-36)
    expect(notices(e, STALLED).filter((x) => !x.readAt)).toEqual([]);
    expect(notices(e, '메인 에이전트가 바뀌었습니다').map((x) => !!x.readAt)).toEqual([false]);
  }, 60_000);

  it('긴급 정지 중의 정지 해제도 같다 — 긴급 정지는 풀되, 나가는 메인 턴이 남은 멈춘 교체의 일시정지는 풀지 않고 다시 시작 알림도 보내지 않는다 (S4-27)', async () => {
    const e = (env = await bootOrch());
    e.core.seat.applyOperatorConfig({ holders: null, drainMs: 200, initialHolder: null }, '시험');
    e.ctx.deps.timing!.memoTurnMs = 1_000;
    e.hold.add(KEY);
    await e.invoke('command.send', { target: 'main', text: '상태 알려줘' });
    e.tick();
    await waitFor(() => !!e.liveProc(KEY, MAIN_AGENT_ID), '메인 턴 시작');
    const p = e.liveProc(KEY, MAIN_AGENT_ID)!;
    p.terminate = async () => {
      p.terminatedByApp = true;
      return { ok: true, remaining: 0, detail: '가짜 종료 — 프로세스는 남음', durationMs: 1 };
    };
    await operatorSwap(e).done;
    expect(e.ctx.store.seat.get('main')!.swap).toMatchObject({ stage: 'unconfirmed' });
    // 멈춘 동안 대표가 긴급 정지 — 나가는 턴은 그래도 남아 있다
    await e.invoke('stop.emergency');
    expect(e.core.turns.hasMemberFlow(MAIN_AGENT_ID)).toBe(true);
    await e.invoke('stop.release');
    expect(releaseControl(e)).toEqual({ mainPaused: true, reason: '메인 자리 교체 멈춤 (세대 1 → 2) — 정지 해제 때 이전 메인 턴이 아직 끝나지 않음', globalStop: false });
    expect(notices(e, '긴급 정지 해제')).toHaveLength(1);
    expect(notices(e, '메인 에이전트 다시 시작')).toEqual([]);
    expect(e.ctx.store.seat.get('main')!.swap).toMatchObject({ stage: 'unconfirmed' });
    // 흐름이 끝난 뒤의 정지 해제 하나가 잇는다
    p.exit(null, { terminated: true });
    await waitFor(() => !e.core.turns.hasMemberFlow(MAIN_AGENT_ID), '흐름 끝');
    await e.invoke('stop.release');
    await e.core.seat.settled();
    expect(e.core.seat.view()).toMatchObject({ generation: 2, state: 'active', holder: { label: 'Codex CLI' } });
    expect(notices(e, '메인 에이전트 다시 시작')).toHaveLength(1);
    expect(notices(e, '메인 에이전트가 바뀌었습니다')).toHaveLength(1);
  }, 60_000);

  it('교체가 멈추기 전에 걸려 있던 M-MAIN 일시정지는 그대로 둔다 — 까닭·시작 때·건 쪽을 덮어쓰지 않는다 (S4-29 2번)', async () => {
    const e = (env = await bootOrch());
    e.core.seat.applyOperatorConfig({ holders: null, drainMs: 200, initialHolder: null }, '시험');
    const { proc } = await startReview(e, MAIN_AGENT_ID);
    proc.terminateResult = { ok: false, remaining: -1, detail: '가짜 종료 확인 실패', durationMs: 1 };
    // 먼저 걸린 일시정지(turns.blockUnconfirmedRun이 메인 대화 실행에 거는 것과 같은 모양) — pauseMember의 단계 마치고 정지가 검수 턴을 교체 전에 끝내지 않게
    // 정지 기록에 바로 쓴다
    const s = e.ctx.stop();
    s.members[MAIN_AGENT_ID] = { paused: true, mode: 'graceful', since: new Date(Date.now() - 60_000).toISOString(), by: 'system', reason: '먼저 걸린 일시정지 (프로세스 종료를 확인하지 못함)' };
    e.ctx.saveStop(s);
    const before = { ...e.ctx.stop().members[MAIN_AGENT_ID]! };
    await operatorSwap(e).done;
    expect(e.ctx.store.seat.get('main')!.swap).toMatchObject({ stage: 'unconfirmed' });
    expect(e.ctx.stop().members[MAIN_AGENT_ID]).toEqual(before);
  });

  it('교체가 없으면 정지 해제는 다른 M-MAIN 흐름(메인 검수 턴)이 돌고 있어도 CTL-11 M-MAIN 일시정지를 푼다 — 남기는 것은 멈춘 교체일 때뿐이다 (리드 결정 S4-27·S4-35 4번, 탐침 G8)', async () => {
    const e = (env = await bootOrch());
    // 단계 마치고 정지는 흐름을 그 단계까지 두므로, 일시정지가 걸린 채 M-MAIN 흐름이 남는다
    await startReview(e, MAIN_AGENT_ID);
    expect(e.core.turns.hasMemberFlow(MAIN_AGENT_ID)).toBe(true);
    // turns.blockUnconfirmedRun이 메인 대화 실행의 종료 확인 실패에 거는 모양
    const s = e.ctx.stop();
    s.members[MAIN_AGENT_ID] = { paused: true, mode: 'graceful', since: e.ctx.now(), by: 'system', reason: '프로세스 종료를 확인하지 못함 (메인 에이전트 TN-x)' };
    e.ctx.saveStop(s);
    expect(e.ctx.store.seat.get('main')!.swap).toBeNull();
    await e.invoke('stop.release');
    expect(releaseControl(e)).toEqual({ mainPaused: false, reason: null, globalStop: false });
    expect(notices(e, '메인 에이전트 다시 시작').map((n) => n.body)).toEqual([
      '정지 해제로 메인 에이전트의 일시정지(프로세스 종료를 확인하지 못함 (메인 에이전트 TN-x))를 풀었습니다. 쌓인 명령을 이어서 처리합니다',
    ]);
    expect(e.core.seat.view()).toMatchObject({ generation: 1, state: 'active' });
  });

  it('서버: 멈춘 교체 알림은 서버 PC의 프로세스를 말한다 — 원격 대표에게 닿지 않는 작업 관리자를 말하지 않는다', async () => {
    const e = (env = await bootOrch({ mode: 'server' }));
    e.core.seat.applyOperatorConfig({ holders: null, drainMs: 200, initialHolder: null }, '시험');
    const { proc } = await startReview(e, MAIN_AGENT_ID);
    proc.terminateResult = { ok: false, remaining: -1, detail: '가짜 종료 확인 실패', durationMs: 1 };
    await operatorSwap(e).done;
    const [n] = notices(e, STALLED);
    expect(n!.body).toBe(
      "Codex CLI에게 메인 자리를 넘기던 중 이전 메인 턴(Claude CLI)이 끝났는지 확인하지 못했습니다. 두 메인 에이전트가 겹쳐 돌지 않게 새 보유자를 아직 앉히지 않고 메인 에이전트를 일시정지해 두었습니다. 서버 PC에 남은 프로세스가 모두 사라졌는지 확인한 뒤(서버 PC를 직접 볼 수 없으면 서버 PC의 운영자에게 확인을 부탁하세요) '정지 해제'를 누르면 교체를 이어 갑니다",
    );
    expect(n!.body).not.toContain('작업 관리자');
    expect(n!.link).toEqual({ tab: 'seat' });
    expect(releaseControl(e).mainPaused).toBe(true);
    e.core.stops.release(OWNER);
    await e.core.seat.settled();
    expect(e.core.seat.view()).toMatchObject({ generation: 2, state: 'active' });
  });

  it('앱을 다시 시작했을 때 멈춘 교체에 출구가 없으면(이 규칙 전에 멈춘 교체) 건다', async () => {
    const e = (env = await bootOrch());
    e.core.seat.applyOperatorConfig({ holders: null, drainMs: 200, initialHolder: null }, '시험');
    const { proc } = await startReview(e, MAIN_AGENT_ID);
    proc.terminateResult = { ok: false, remaining: -1, detail: '가짜 종료 확인 실패', durationMs: 1 };
    await operatorSwap(e).done;
    // 이 규칙 전의 데이터처럼 M-MAIN 일시정지가 없는 멈춘 교체
    const s = e.ctx.stop();
    delete s.members[MAIN_AGENT_ID];
    e.ctx.saveStop(s);
    expect(releaseControl(e).mainPaused).toBe(false);
    // 시작 때 부르는 길 (orchestrator.ts — 재시작 복구 뒤, 스케줄러 전)
    e.core.seat.resumeAfterRestart();
    expect(releaseControl(e)).toMatchObject({ mainPaused: true, reason: '메인 자리 교체 멈춤 (세대 1 → 2) — 나가는 메인 턴의 종료를 확인하지 못함' });
    expect(e.ctx.store.seat.get('main')!.swap).toMatchObject({ stage: 'unconfirmed' });
  });
});
