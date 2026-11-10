/**
 * 화면 도우미의 정지와 놓기, 사람 우선 (SERVER_DESIGN 8.3.5 '정지'·'사람 우선', 리드 결정 S6-8·S6-9·S6-19 — 10.6 guiStopRelease). 가짜 도우미만 쓴다.
 * - 긴급 정지: STOP을 받고(눌린 키를 뗀다) 끝난 것을 3초 안에 확인한다 — 요약은 완료. STOP에 답하지 않으면 '키·버튼을 뗐는지 확인하지 못했습니다', 끝나지 않으면
 *   '끝났는지 확인하지 못했습니다' 실패 줄(메인 에이전트)이고 요약은 완료가 아니다. 정지 뒤 화면 도구는 모두 stopped
 * - 자리 교체: 1번(교체를 정한 때)과 4번(토큰 폐기)에 STOP. 교체 중에는 화면 도구가 conflict, 이전 세대의 캡처는 seat_changed
 * - 턴 끝: RELEASE(도우미는 남는다). 답이 없으면 STOP하고 끝낸다. 끝남까지 확인하지 못하면 그 턴은 kill_failed, 메인 에이전트가 일시정지된다
 * - 앱 종료: STOP 뒤 끝낸다
 * - 사람 우선: 사람 입력(HUMAN)·무장 때의 시작 값 + 30초 동안 캡처·입력은 human_active (screen_info·release는 된다). 멈춤 한 번에 활동 기록 한 줄.
 *   내 마지막 입력의 답보다 앞선 시작 값은 사람 입력이 아니다
 * - 멈춤 단축키(HOTKEY): 누른 때부터 5분, 다시 누르면 그때부터 5분. kv에 남아 다시 시작해도 이어지고, 정지 해제로도 풀리지 않는다
 * - 안전장치가 붙지 않은 rails(CLOSED_RAILS)는 모든 화면 도구를 거부한다 — 기본 배선은 ScreenSafety다
 */
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID, OWNER, type AiConfig } from '@shared/domain';
import { createFakeDesktop, killFakePids, pidAlive } from '../fixtures/desktop/fakeDesktop';
import { INPUT_UNCONFIRMED_TEXT, MAX_HELPER_FAILURES, RELEASE_UNANSWERED_STOP, STOP_UNCONFIRMED_EXIT, STOP_UNCONFIRMED_KEYS } from '../../src/main/desktop/desktopHelper';
import {
  NO_HELPER_RELEASE_TEXT,
  SCREEN_UNCONFIRMED_KEY,
  UNCONFIRMED_REFUSAL,
  UNCONFIRMED_RETRIED_REFUSAL,
  UNRELEASED_PROBLEM,
  UNRELEASED_REFUSAL,
} from '../../src/main/desktop/lifecycle';
import { HUMAN_PAUSE_MS, LOCAL_STOP_KEY, LOCAL_STOP_MS, NO_HOTKEY_REFUSAL, SCREEN_ARMED_KEY, ScreenSafety } from '../../src/main/desktop/safety';
import { CLOSED_RAILS, RAILS_MISSING_TEXT } from '../../src/main/desktop/service';
import type { DesktopHelperLauncher } from '../../src/main/desktop/types';
import { alertEnded } from '../../src/main/orchestrator/alerts';
import { STOP_CONFIRM_MS } from '../../src/main/orchestrator/turns';
import { assertFakeMain, bootGui, capture, input, inputLines, liveMain, MAIN_KEY, rid, type GuiEnv } from './guiRig';
import { notices, sleep, waitFor } from './orchHarness';

const open: GuiEnv[] = [];
/** 아주 작은 도우미(tinyLauncher)의 임시 폴더 */
const tinyDirs: string[] = [];
afterEach(async () => {
  for (const g of open.splice(0)) {
    const pids = g.fake.pids();
    await g.close();
    killFakePids(pids);
  }
  for (const d of tinyDirs.splice(0)) await rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const CODEX: AiConfig = { kind: 'codex', model: null, effortTier: 'high', effortOverride: null };
const stops = (g: GuiEnv) => g.fake.received().filter((l) => l === 'STOP').length;
const releases = (g: GuiEnv) => g.fake.received().filter((l) => /^\d+ RELEASE$/.test(l)).length;
const captures = (g: GuiEnv) => g.fake.received().filter((l) => / CAPTURE /.test(l)).length;
const view = (g: GuiEnv) => g.e.core.views.snapshot().seat.screen;
const serverRows = (g: GuiEnv) =>
  g.e.ctx.store.guiActions
    .query({ limit: 100, asc: true })
    .filter((r) => r.by === 'server')
    .map((r) => [r.action, r.result, r.detail]);
const click = (g: GuiEnv, turnId: string, captureId: string) => input(g.e, turnId, { action: 'click', capture_id: captureId, x: 300, y: 200 });
const endTurn = async (g: GuiEnv) => {
  g.e.liveProc(MAIN_KEY, MAIN_AGENT_ID)!.finishOk();
  await g.e.idle();
};
const mainPaused = (g: GuiEnv) => !!g.e.ctx.stop().members[MAIN_AGENT_ID]?.paused;
/** 끝남을 확인하지 못한 화면 도우미의 문 (kv desktop:unconfirmed — 리드 결정 S6-21 A1) */
const gateOf = (g: GuiEnv) => g.e.ctx.store.kv.get<{ since: string; cause: string; turnId: string | null; retriedAt?: string | null }>(SCREEN_UNCONFIRMED_KEY);
/** 그 가짜 도우미 프로세스가 받은 명령 이름 (받은 순서) */
const verbsOf = (g: GuiEnv, pid: number) =>
  g.fake
    .log()
    .filter((x) => x.pid === pid && x.dir === 'in')
    .map((x) => x.line.replace(/^\d+ /, '').split(' ')[0]!);
const armReplies = (g: GuiEnv) => g.fake.log().filter((x) => x.dir === 'out' && / OK seed=/.test(x.line)).map((x) => x.line.replace(/^\d+ OK /, ''));
const markOf = (g: GuiEnv) => g.e.ctx.store.kv.get<{ at: string; turnId: string | null }>(SCREEN_ARMED_KEY);
/** 화면 도우미 실패의 대표 알림 (noteProblem — key screen:helper_failed) */
const helperFailedNotices = (g: GuiEnv) => notices(g.e, '화면 조작을 쓸 수 없습니다 — 화면 도우미 실패');
const helperFailedAlerts = (g: GuiEnv) => g.e.ctx.store.queue.list({}).filter((q) => q.alertKey?.startsWith('alert:screen:helper_failed:'));
/** 무장한 도우미를 뜻밖에 끝낸다 — 놓았다는 답이 없어 놓기 표시가 남는다 */
async function crashArmed(g: GuiEnv): Promise<{ turnId: string; mark: { at: string; turnId: string | null } }> {
  const { turnId } = await armed(g);
  g.fake.act({ do: 'crash' });
  await waitFor(() => g.e.core.desktop.peek()!.pid === null, '도우미 끝남');
  const mark = markOf(g)!;
  expect(mark).toMatchObject({ turnId });
  return { turnId, mark };
}
const screenTools = (captureId: string) =>
  [
    ['screen_capture', {}],
    ['screen_info', {}],
    ['gui_input', { action: 'click', capture_id: captureId, x: 10, y: 10, request_id: rid() }],
  ] as const;
/** 끝나지 않는 도우미: STOP에 답하지 않고 표준 입력이 닫혀도 끝나지 않는다 */
const HUNG = { noAck: ['STOP' as const], ignoreEof: true };
/** 끝내기 이음매 — kill.on일 때만 실제로 끝낸다 (끝나지 않는 도우미를 흉내 내다가, 대표의 정지 해제 때 끝내기가 듣게 한다) */
function switchableKill(timeouts: Record<string, number> = {}) {
  const kill = { on: false };
  return { kill, helper: { kill: (p: ChildProcessWithoutNullStreams) => void (kill.on && p.kill()), timeouts: { READY: 5000, STOP_ACK: 150, STOP_CONFIRM: 500, ...timeouts } } };
}

/** 메인 턴을 띄워 캡처하고 한 번 누른다 — 도우미가 무장했다 */
async function armed(g: GuiEnv): Promise<{ turnId: string; captureId: string }> {
  const turnId = await liveMain(g.e);
  const c = await capture(g.e, turnId);
  expect((await click(g, turnId, c.data.capture_id)).ok).toBe(true);
  expect(view(g).operatingSince).not.toBeNull();
  expect(g.e.ctx.store.kv.get(SCREEN_ARMED_KEY)).toMatchObject({ turnId });
  return { turnId, captureId: c.data.capture_id };
}

describe('긴급 정지 — STOP 뒤 끝내고 3초 안에 확인한다 (S6-9)', () => {
  it('도우미가 STOP에 답하고 끝나면 요약은 완료다 — 눌린 키를 뗐고, 그 뒤 화면 도구는 모두 stopped이며 아무것도 보내지 않는다', async () => {
    const g = await bootGui({ heldKeys: 2 });
    open.push(g);
    const { turnId, captureId } = await armed(g);
    const pid = g.fake.pids()[0]!;
    const t0 = Date.now();
    const pending = g.e.core.stops.emergency(OWNER);
    // 정지 값은 종료 확인보다 먼저다 — 같은 순간의 화면 도구는 거부된다
    expect(await click(g, turnId, captureId)).toMatchObject({ ok: false, code: 'stopped' });
    const summary = await pending;
    expect(Date.now() - t0).toBeLessThan(STOP_CONFIRM_MS + 700);
    expect([summary.completed, summary.failures]).toEqual([true, []]);
    // STOP을 받았고 눌린 키 2개를 뗐다고 답했다 — 그 뒤에 끝났다
    const log = g.fake.log().map((e) => `${e.dir} ${e.line}`);
    expect(log).toContain('in STOP');
    expect(log).toContain('out STOP OK 2');
    await waitFor(() => !pidAlive(pid), '도우미 끝남');
    for (const [tool, args] of [
      ['screen_capture', {}],
      ['screen_info', {}],
      ['gui_input', { action: 'click', capture_id: captureId, x: 10, y: 10, request_id: rid() }],
      ['gui_input', { action: 'release', request_id: rid() }],
    ] as const) {
      expect([tool, await g.e.tool(turnId, tool, args)]).toMatchObject([tool, { ok: false, code: 'stopped' }]);
    }
    expect(inputLines(g.fake)).toHaveLength(1);
    expect(g.fake.launches()).toBe(1);
    await g.e.idle();
    // 서버가 한 정지는 기록에 남고, 조작 중 표시와 놓기 표시는 꺼졌다
    expect(serverRows(g)).toEqual([['stop', 'ok', '긴급 정지: 화면 도우미를 멈췄습니다 (키·버튼 2개 뗌)']]);
    expect(view(g).operatingSince).toBeNull();
    expect(g.e.ctx.store.kv.get(SCREEN_ARMED_KEY)).toBeNull();
    expect(g.e.ctx.store.turns.get(turnId)?.process.state).toBe('exited');
    // 정지 해제 뒤에는 새 도우미로 다시 된다
    g.e.core.stops.release(OWNER);
    const next = await liveMain(g.e, '다시 화면을 봐 줘');
    expect((await g.e.tool(next, 'screen_capture', {})).ok).toBe(true);
    expect(g.fake.launches()).toBe(2);
  });

  it('도우미가 STOP에 답하지 않으면 끝냈어도 완료가 아니다 — 실패 줄은 메인 에이전트의 "키·버튼을 뗐는지 확인하지 못했습니다"이고 알림이 그렇게 말한다', async () => {
    const g = await bootGui({ noAck: ['STOP'] });
    open.push(g);
    const { turnId } = await armed(g);
    const pid = g.fake.pids()[0]!;
    const t0 = Date.now();
    const summary = await g.e.core.stops.emergency(OWNER);
    const took = Date.now() - t0;
    // 답을 0.8초 기다린 뒤 끝냈다 — 3초 안
    expect(took).toBeGreaterThanOrEqual(700);
    expect(took).toBeLessThan(STOP_CONFIRM_MS + 700);
    expect(summary.completed).toBe(false);
    expect(summary.failures).toEqual([{ memberId: MAIN_AGENT_ID, memberName: g.e.ctx.store.members.require(MAIN_AGENT_ID).name, detail: STOP_UNCONFIRMED_KEYS, remaining: -1 }]);
    expect(STOP_UNCONFIRMED_KEYS).toBe('화면 도우미: 키·버튼을 뗐는지 확인하지 못했습니다');
    expect(pidAlive(pid)).toBe(false);
    const n = notices(g.e, '긴급 정지 — 종료 실패');
    expect(n).toHaveLength(1);
    // 끝난 도우미에 '남은 프로세스'라고 하지 않는다 — 뗐는지 모른다고, 그리고 그 PC 앞에서 할 일을 말한다
    expect(n[0]!.body).toContain(STOP_UNCONFIRMED_KEYS);
    expect(n[0]!.body).toContain('눌렀다 떼야 합니다');
    expect(n[0]!.body).not.toContain('남은 프로세스');
    expect(notices(g.e, '긴급 정지 완료')).toEqual([]);
    await g.e.idle();
    expect(serverRows(g)).toEqual([['stop', 'error', `긴급 정지: ${STOP_UNCONFIRMED_KEYS}`]]);
    // 프로세스는 끝났다 — 그 턴은 남은 프로세스가 없다. 다만 놓았다는 답이 없어 놓기 표시는 남는다 (다음 시작이 새 도우미로 놓는다)
    expect(g.e.ctx.store.turns.get(turnId)?.process.state).toBe('exited');
    expect(g.e.ctx.store.kv.get(SCREEN_ARMED_KEY)).not.toBeNull();
  });

  it('도우미가 끝나지 않으면 "끝났는지 확인하지 못했습니다" — 완료가 아니고, 그 메인 턴은 kill_failed로 끝난다', async () => {
    const g = await bootGui({ noAck: ['STOP'], ignoreEof: true }, { helper: { kill: () => undefined, timeouts: { READY: 5000, STOP_ACK: 150, STOP_CONFIRM: 500 } } });
    open.push(g);
    const { turnId } = await armed(g);
    const summary = await g.e.core.stops.emergency(OWNER);
    expect(summary.completed).toBe(false);
    expect(summary.failures.map((f) => [f.memberId, f.detail])).toEqual([[MAIN_AGENT_ID, STOP_UNCONFIRMED_EXIT]]);
    expect(STOP_UNCONFIRMED_EXIT).toBe('화면 도우미: 끝났는지 확인하지 못했습니다');
    await g.e.idle();
    const t = g.e.ctx.store.turns.get(turnId)!;
    expect([t.process.state, t.process.killDetail]).toEqual(['kill_failed', STOP_UNCONFIRMED_EXIT]);
  });
});

describe('자리 교체 — 1번과 4번의 STOP, 교체 중 거부 (S6-9)', () => {
  it('교체를 정하면 곧바로 STOP — 나가는 턴이 도는 동안 화면 도구는 conflict다. 그 뒤에 뜬 도우미는 4번에서 멈추고, 이전 세대의 캡처는 seat_changed', async () => {
    const g = await bootGui();
    open.push(g);
    g.e.core.seat.applyOperatorConfig({ holders: null, drainMs: 10_000, initialHolder: null }, '시험');
    const { turnId, captureId } = await armed(g);
    const first = g.fake.pids()[0]!;
    const r = g.e.core.seat.assign({ holder: { kind: 'launched', ai: CODEX }, by: 'operator', reason: '시험 교체' });
    expect(r.outcome).toBe('swap');
    // 1번: 기다리지 않고 STOP — 나가는 턴은 아직 돈다
    await waitFor(() => stops(g) === 1 && !pidAlive(first), '교체 1번의 STOP');
    expect(g.e.liveProc(MAIN_KEY, MAIN_AGENT_ID)).toBeTruthy();
    expect(g.e.core.views.snapshot().seat.state).toBe('switching');
    for (const [tool, args] of [
      ['screen_capture', {}],
      ['screen_info', {}],
      ['gui_input', { action: 'click', capture_id: captureId, x: 10, y: 10, request_id: rid() }],
    ] as const) {
      expect([tool, await g.e.tool(turnId, tool, args)]).toMatchObject([tool, { ok: false, code: 'conflict' }]);
    }
    expect(inputLines(g.fake)).toHaveLength(1);
    expect(g.fake.launches()).toBe(1);
    // 1번 뒤에 도우미가 다시 떠 있다고 하자 (도는 호출이 띄운 것 등) — 4번이 그것도 멈춘다
    expect((await g.e.core.desktop.client()!.ready()).ok).toBe(true);
    const second = g.fake.pids()[1]!;
    expect(pidAlive(second)).toBe(true);
    // 나가는 턴과 인계 메모 턴이 끝나면 교체가 끝난다
    g.e.hold.delete(MAIN_KEY);
    g.e.liveProc(MAIN_KEY, MAIN_AGENT_ID)!.finishOk();
    await r.done;
    await waitFor(() => stops(g) === 2 && !pidAlive(second), '교체 4번의 STOP');
    // 서버의 정지 줄은 끝남을 확인한 뒤에 남는다 — 프로세스가 끝난 것을 클라이언트가 알기까지 잠깐 (상한이 있다 — 아래 단언이 판정한다)
    await waitFor(() => serverRows(g).length === 2, '교체 4번의 정지 줄', 3000).catch(() => undefined);
    expect(g.e.core.views.snapshot().seat).toMatchObject({ generation: 2, state: 'active' });
    expect(serverRows(g).map((x) => [x[0], x[1]])).toEqual([
      ['stop', 'ok'],
      ['stop', 'ok'],
    ]);
    // 새 세대: 새 도우미로 찍고, 이전 세대의 캡처로는 입력하지 못한다
    await g.e.idle();
    const next = await liveMain(g.e, '새 메인: 화면을 봐 줘');
    expect(g.e.identity(next).seatGeneration).toBe(2);
    expect(await click(g, next, captureId)).toMatchObject({ ok: false, code: 'seat_changed' });
    const c2 = await capture(g.e, next);
    expect((await click(g, next, c2.data.capture_id)).ok).toBe(true);
    expect(g.fake.launches()).toBe(3);
    expect(g.e.errors).toEqual([]);
  });
});

describe('턴 끝 — RELEASE, 답이 없으면 STOP하고 끝낸다 (S6-9)', () => {
  it('화면을 쓴 턴이 끝나면 RELEASE를 보낸다 — 도우미는 남고, 조작 중 표시와 놓기 표시가 꺼지고, 서버의 놓기 줄이 남는다. 다음 턴은 같은 도우미로 다시 무장한다', async () => {
    const g = await bootGui({ heldKeys: 1 });
    open.push(g);
    const { turnId } = await armed(g);
    const firstSince = view(g).operatingSince!;
    const pid = g.fake.pids()[0]!;
    await endTurn(g);
    expect([releases(g), stops(g)]).toEqual([1, 0]);
    expect(pidAlive(pid)).toBe(true);
    expect(view(g).operatingSince).toBeNull();
    expect(g.e.ctx.store.kv.get(SCREEN_ARMED_KEY)).toBeNull();
    expect(serverRows(g)).toEqual([['release', 'ok', '턴 끝: 키·버튼 1개를 뗐습니다']]);
    expect(g.e.ctx.store.turns.get(turnId)?.process.state).toBe('exited');
    // 턴 한 줄은 서버의 놓기를 세지 않는다
    expect(g.e.ctx.store.activity.search({ turnId, kinds: ['screen'], limit: 10 }).map((a) => a.text)).toEqual(['화면 조작 1회: 메모장 (캡처 1장)']);
    // 무장하지 않은 도우미에는 놓기를 보내지 않는다 (화면을 쓰지 않은 턴의 끝)
    await liveMain(g.e, '화면 없이 하는 일');
    await endTurn(g);
    expect(releases(g)).toBe(1);
    // 다음 턴: 같은 도우미, 다시 ARM
    g.clock.advance(1000);
    const next = await liveMain(g.e, '이어서');
    await capture(g.e, next);
    expect(g.fake.launches()).toBe(1);
    expect(g.fake.received().filter((l) => / ARM /.test(l))).toHaveLength(2);
    // 다시 무장하면 조작 중 표시와 놓기 표시가 새로 선다 — 앞 턴의 시작 시각이 남아 있지 않고, 놓기 표시는 이 턴의 것이다 (없으면 이 턴에서 끊겼을 때 다시 시작이 놓지 않는다)
    expect(Date.parse(view(g).operatingSince!)).toBeGreaterThan(Date.parse(firstSince));
    expect(g.e.ctx.store.kv.get(SCREEN_ARMED_KEY)).toMatchObject({ turnId: next });
  });

  it('무장한 채 남은 도우미는 화면을 쓰지 않은 메인 턴의 끝에서도 놓는다 — 턴과 턴 사이에 무장한 채 두지 않는다 (메인 턴은 한 번에 하나다)', async () => {
    const g = await bootGui({ heldKeys: 1 });
    open.push(g);
    await armed(g);
    await endTurn(g);
    expect(releases(g)).toBe(1);
    // 어느 턴의 것도 아닌 무장 — 턴이 끝난 뒤에 무장한 호출의 놓기에 답이 없었던 것처럼, 도우미에 ARM만 보낸다
    const h = g.e.core.desktop.peek()!;
    const lease = await h.acquire();
    if ('kind' in lease) throw new Error(lease.text);
    expect((await lease.send({ verb: 'ARM', policy: g.e.core.desktop.policy() })).ok).toBe(true);
    lease.end();
    expect(h.armed()).toBe(true);
    // 화면을 쓰지 않은 턴이 끝난다 — 그 턴의 화면 조작 줄은 없다
    const idleTurn = await liveMain(g.e, '화면 없이 하는 일');
    await endTurn(g);
    expect(g.e.ctx.store.guiActions.query({ turnId: idleTurn, limit: 10 }).filter((r) => r.by !== 'server')).toEqual([]);
    expect([releases(g), stops(g), h.armed()]).toEqual([2, 0, false]);
    expect(serverRows(g).map((x) => [x[0], x[1]])).toEqual([
      ['release', 'ok'],
      ['release', 'ok'],
    ]);
    expect(g.fake.launches()).toBe(1);
  });

  it('RELEASE에 답하지 않으면 STOP하고 끝낸다 — 끝남을 확인했으면 턴은 그대로 끝나고, 다음 턴은 새 도우미를 쓴다', async () => {
    const g = await bootGui({ noAck: ['RELEASE'] }, { helper: { timeouts: { READY: 5000, RELEASE: 200 } } });
    open.push(g);
    const { turnId } = await armed(g);
    const pid = g.fake.pids()[0]!;
    await endTurn(g);
    // RELEASE를 먼저, 답이 없어 STOP
    const order = g.fake.received().filter((l) => l === 'STOP' || /^\d+ RELEASE$/.test(l)).map((l) => l.replace(/^\d+ /, ''));
    expect(order).toEqual(['RELEASE', 'STOP']);
    expect(pidAlive(pid)).toBe(false);
    expect(serverRows(g).map((x) => [x[0], x[1]])).toEqual([
      ['release', 'error'],
      ['stop', 'ok'],
    ]);
    expect(g.e.ctx.store.turns.get(turnId)?.process.state).toBe('exited');
    expect(g.e.ctx.stop().members[MAIN_AGENT_ID]).toBeUndefined();
    expect(view(g).operatingSince).toBeNull();
    const next = await liveMain(g.e, '이어서');
    expect((await g.e.tool(next, 'screen_capture', {})).ok).toBe(true);
    expect(g.fake.launches()).toBe(2);
  });

  it('놓기에도 STOP에도 답하지 않고 끝나지도 않으면 그 턴은 kill_failed로 끝나고 메인 에이전트가 일시정지된다 (출구는 대표의 정지 해제)', async () => {
    const g = await bootGui({ noAck: ['RELEASE', 'STOP'], ignoreEof: true }, { helper: { kill: () => undefined, timeouts: { READY: 5000, RELEASE: 150, STOP_ACK: 100, STOP_CONFIRM: 400 } } });
    open.push(g);
    const { turnId } = await armed(g);
    await endTurn(g);
    const t = g.e.ctx.store.turns.get(turnId)!;
    expect([t.endReason, t.process.state, t.process.killDetail]).toEqual(['completed', 'kill_failed', STOP_UNCONFIRMED_EXIT]);
    await waitFor(() => !!g.e.ctx.stop().members[MAIN_AGENT_ID]?.paused, '메인 일시정지');
    expect(notices(g.e, '프로세스 종료 확인 실패').map((n) => n.level)).toEqual(['urgent']);
    expect(serverRows(g).map((x) => [x[0], x[1]])).toEqual([
      ['release', 'error'],
      ['stop', 'error'],
    ]);
    // 놓았다는 답이 없다 — 놓기 표시는 남는다
    expect(g.e.ctx.store.kv.get(SCREEN_ARMED_KEY)).not.toBeNull();
  });

  it('앱 종료: 떠 있는 도우미에 STOP을 쓰고 끝낸다', async () => {
    const g = await bootGui({ heldKeys: 3 });
    open.push(g);
    await armed(g);
    const pid = g.fake.pids()[0]!;
    await g.e.orch.stop();
    const log = g.fake.log().map((e) => `${e.dir} ${e.line}`);
    expect(log).toContain('in STOP');
    expect(log).toContain('out STOP OK 3');
    await waitFor(() => !pidAlive(pid), '도우미 끝남');
  });
});

describe('사람 우선 — 사람 입력 + 30초 (S6-8)', () => {
  it('사람이 입력하면 캡처와 입력은 human_active이고 아무것도 보내지 않는다. screen_info와 놓기는 된다 — 멈춤 한 번에 활동 기록 한 줄, 30초 뒤 다시 된다', async () => {
    const g = await bootGui();
    open.push(g);
    const turnId = await liveMain(g.e);
    const c = await capture(g.e, turnId);
    expect(view(g).paused).toBeNull();
    g.fake.act({ do: 'human' });
    await waitFor(() => view(g).paused?.by === 'human', '사람 입력 멈춤');
    const shot = await g.e.tool(turnId, 'screen_capture', {});
    expect(shot).toMatchObject({ ok: false, code: 'human_active' });
    if (!shot.ok) expect(shot.message).toContain('사람이 마우스·키보드를 쓰고 있어');
    expect(await click(g, turnId, c.data.capture_id)).toMatchObject({ ok: false, code: 'human_active' });
    expect([captures(g), inputLines(g.fake).length]).toEqual([1, 0]);
    expect((await g.e.tool(turnId, 'screen_info', {})).ok).toBe(true);
    expect((await g.e.tool(turnId, 'gui_input', { action: 'release', request_id: rid() })).ok).toBe(true);
    // 사람이 계속 쓴다 — 같은 멈춤이다 (활동 기록은 한 줄)
    g.fake.act({ do: 'human' });
    await sleep(250);
    const episodes = () => g.e.ctx.store.activity.search({ kinds: ['screen'], limit: 50 }).filter((a) => a.text.startsWith('서버 PC 앞 사람의 입력으로'));
    expect(episodes()).toHaveLength(1);
    const p = view(g).paused!;
    expect(HUMAN_PAUSE_MS).toBe(30_000);
    expect(Date.parse(p.until) - Date.parse(p.since)).toBeGreaterThanOrEqual(30_000);
    // 마지막 입력부터 30초
    g.clock.advance(HUMAN_PAUSE_MS - 2000);
    expect(await g.e.tool(turnId, 'screen_capture', {})).toMatchObject({ ok: false, code: 'human_active' });
    g.clock.advance(2500);
    expect(view(g).paused).toBeNull();
    const c2 = await capture(g.e, turnId);
    expect((await click(g, turnId, c2.data.capture_id)).ok).toBe(true);
    // 다시 사람이 쓰면 새 멈춤이다
    g.fake.act({ do: 'human' });
    await waitFor(() => view(g).paused?.by === 'human', '두 번째 멈춤');
    expect(episodes()).toHaveLength(2);
  });

  it('무장할 때의 시작 값이 30초 안이면(방금 전까지 사람이 썼다) 찍지 않는다 — CAPTURE 줄이 가지 않고, 30초가 차면 찍는다', async () => {
    const g = await bootGui({ seedMs: Date.now() - 5000 });
    open.push(g);
    const turnId = await liveMain(g.e);
    expect(await g.e.tool(turnId, 'screen_capture', {})).toMatchObject({ ok: false, code: 'human_active' });
    expect(captures(g)).toBe(0);
    expect(view(g).paused).toMatchObject({ by: 'human' });
    g.clock.advance(26_000);
    expect((await g.e.tool(turnId, 'screen_capture', {})).ok).toBe(true);
  });

  it('내 마지막 입력의 답보다 앞선 시작 값은 사람 입력이 아니다 (GetLastInputInfo는 주입한 입력도 센다) — 그 뒤의 시작 값은 사람 입력이다', async () => {
    const g = await bootGui();
    open.push(g);
    const turnId = await liveMain(g.e);
    const c = await capture(g.e, turnId);
    const before = Date.now();
    expect((await click(g, turnId, c.data.capture_id)).ok).toBe(true);
    // 도우미가 뜻밖에 끝나고 새 도우미가 뜬다 — 그 무장의 시작 값은 내 입력 때다
    g.fake.set({ seedMs: before });
    killFakePids(g.fake.pids());
    await waitFor(() => g.e.core.desktop.peek()!.pid === null, '도우미 끝남');
    expect((await g.e.tool(turnId, 'screen_capture', {})).ok).toBe(true);
    expect(view(g).paused).toBeNull();
    // 이번에는 내 입력보다 뒤의 시작 값 — 사람이 그 뒤에 썼다
    await sleep(20);
    g.fake.set({ seedMs: Date.now() });
    killFakePids(g.fake.pids());
    await waitFor(() => g.e.core.desktop.peek()!.pid === null, '도우미 끝남');
    expect(await g.e.tool(turnId, 'screen_capture', {})).toMatchObject({ ok: false, code: 'human_active' });
  });
});

describe('멈춤 단축키 — 누른 때부터 5분, kv에 남는다 (S6-8)', () => {
  it('누르면 캡처와 입력이 5분 동안 human_active다. 다시 누르면 그때부터 5분, 정지 해제로도 풀리지 않고, 다시 시작해도 남는다', async () => {
    const g = await bootGui();
    open.push(g);
    const { turnId, captureId } = await armed(g);
    g.fake.act({ do: 'hotkey' });
    await waitFor(() => view(g).paused?.by === 'local', '멈춤 단축키');
    // 기다림 뒤의 단언 — 기다림이 고정 시간이어도 이 줄이 판정한다 (리드 결정 S6-21 J2)
    expect(view(g).paused).toMatchObject({ by: 'local' });
    // 도우미가 멈추며 키를 뗐다 — 놓기 표시도 지운다 (남으면 다음 무장 앞에 쓸데없이 놓고, 다음 시작이 놓으려 한다)
    expect(g.e.ctx.store.kv.get(SCREEN_ARMED_KEY)).toBeNull();
    const first = view(g).paused!;
    expect(LOCAL_STOP_MS).toBe(5 * 60_000);
    expect(Date.parse(first.until) - Date.parse(first.since)).toBe(5 * 60_000);
    // 도우미가 표시·훅을 껐다
    expect(view(g).operatingSince).toBeNull();
    const shot = await g.e.tool(turnId, 'screen_capture', {});
    expect(shot).toMatchObject({ ok: false, code: 'human_active' });
    if (!shot.ok) expect(shot.message).toContain('멈춤 단축키(Ctrl+Alt+Shift+F12)');
    expect(await click(g, turnId, captureId)).toMatchObject({ ok: false, code: 'human_active' });
    expect((await g.e.tool(turnId, 'screen_info', {})).ok).toBe(true);
    expect([captures(g), inputLines(g.fake).length]).toEqual([1, 1]);
    expect(g.e.ctx.store.kv.get(LOCAL_STOP_KEY)).toMatchObject({ since: Date.parse(first.since), until: Date.parse(first.until) });
    expect(g.e.ctx.store.activity.search({ kinds: ['screen'], level: 'warn', limit: 20 }).filter((a) => a.text.includes('멈춤 단축키'))).toHaveLength(1);
    // 1분 뒤 다시 누른다 — 그때부터 5분, 같은 멈춤
    g.clock.advance(60_000);
    g.fake.act({ do: 'hotkey' });
    await waitFor(() => Date.parse(view(g).paused?.until ?? first.until) > Date.parse(first.until), '다시 누름');
    const second = view(g).paused!;
    expect(second.since).toBe(first.since);
    expect(Date.parse(second.until) - Date.parse(first.until)).toBeGreaterThanOrEqual(59_000);
    // 정지 해제(대표)로도 풀리지 않는다 — 풀 수 있는 메서드·도구가 없다
    g.e.core.stops.release(OWNER);
    expect(await g.e.tool(turnId, 'screen_capture', {})).toMatchObject({ ok: false, code: 'human_active' });
    // 다시 시작해도 남는다 (kv에서 읽는다)
    const restarted = new ScreenSafety(g.e.core, g.e.core.desktop);
    expect(restarted.paused('input')).toContain('멈춤 단축키');
    expect(restarted.view().paused).toMatchObject({ by: 'local', until: second.until });
    restarted.dispose();
    // 끝 시각 바로 전까지 — 그리고 지나면 다시 된다
    g.clock.advance(LOCAL_STOP_MS - 2000);
    expect(await g.e.tool(turnId, 'screen_capture', {})).toMatchObject({ ok: false, code: 'human_active' });
    g.clock.advance(2500);
    expect(view(g).paused).toBeNull();
    expect((await g.e.tool(turnId, 'screen_capture', {})).ok).toBe(true);
    expect(g.e.ctx.store.kv.get(LOCAL_STOP_KEY)).toBeNull();
  });
});

describe('안전장치가 붙지 않으면 닫힌다 (S6-19)', () => {
  it('기본 배선은 ScreenSafety이고, 붙지 않은 rails(CLOSED_RAILS)에서는 화면 도구가 모두 unavailable — 도우미를 띄우지도 않는다', async () => {
    const g = await bootGui();
    open.push(g);
    expect(g.e.core.desktop.rails).toBe(g.e.core.desktop.safety);
    expect(g.e.core.desktop.rails).toBeInstanceOf(ScreenSafety);
    const turnId = await liveMain(g.e);
    g.e.core.desktop.rails = CLOSED_RAILS;
    for (const [tool, args] of [
      ['screen_capture', {}],
      ['screen_info', {}],
      ['gui_input', { action: 'key', keys: 'enter', capture_id: 'SC-000001', request_id: rid() }],
      ['gui_input', { action: 'type', text: '안녕', capture_id: 'SC-000001', request_id: rid() }],
    ] as const) {
      const r = await g.e.tool(turnId, tool, args);
      expect([tool, r]).toMatchObject([tool, { ok: false, code: 'unavailable', message: RAILS_MISSING_TEXT }]);
    }
    expect(g.fake.launches()).toBe(0);
    // 닫힌 rails의 모든 검사는 거부다 — 빠진 검사가 통과로 읽히지 않는다
    expect([CLOSED_RAILS.deniedKeys('enter'), CLOSED_RAILS.paused('input'), CLOSED_RAILS.rate('input', g.e.identity(turnId))]).toEqual([RAILS_MISSING_TEXT, RAILS_MISSING_TEXT, RAILS_MISSING_TEXT]);
    g.e.core.desktop.rails = g.e.core.desktop.safety;
    expect((await g.e.tool(turnId, 'screen_capture', {})).ok).toBe(true);
  });
});

describe('끝남을 확인하지 못한 화면 도우미는 문이 된다 — 대표의 정지 해제·서버 시작만 연다 (S6-21 A1·A2·A2b)', () => {
  it('도는 메인 턴이 없을 때의 긴급 정지: 문을 걸고(kv) 메인 에이전트를 곧바로 일시정지한다. 정지 해제가 한 번 더 확인해도 끝나지 않으면 문은 남는다 — 메인은 화면 없이 일하고(그 턴은 접히지 않는다) 화면 도구는 출구를 말하며 stopped, 새 도우미는 띄우지 않는다. 끝내기가 들으면 다음 정지 해제가 문을 연다', async () => {
    const { kill, helper } = switchableKill();
    const g = await bootGui(HUNG, { helper });
    open.push(g);
    const { captureId } = await armed(g);
    // 그 턴은 정상으로 끝난다 (RELEASE에는 답한다) — 도우미는 떠 있고, 도는 메인 턴은 없다
    await endTurn(g);
    const pid = g.fake.pids()[0]!;
    expect([pidAlive(pid), g.e.core.turns.count()]).toEqual([true, 0]);
    const s = await g.e.core.stops.emergency(OWNER);
    expect([s.completed, s.failures.map((f) => f.detail)]).toEqual([false, [STOP_UNCONFIRMED_EXIT]]);
    // 문은 kv에 남고(다시 시작해도 reconcile 전까지 남는다), 도는 메인 턴이 없어 메인 에이전트를 곧바로 일시정지한다
    expect(gateOf(g)).toMatchObject({ cause: '긴급 정지', turnId: null });
    expect(mainPaused(g)).toBe(true);
    expect(g.e.ctx.stop().members[MAIN_AGENT_ID]!.reason).toBe('화면 도우미가 끝났는지 확인하지 못함 (긴급 정지)');
    const urgent = notices(g.e, '화면 도우미 종료 확인 실패');
    expect(urgent.map((n) => [n.level, n.key, n.link])).toEqual([['urgent', 'screen-unconfirmed', { tab: 'seat', panel: 'screen' }]]);
    expect(urgent[0]!.body).toContain("'정지 해제'를 누르면 끝났는지 한 번 더 확인하고");
    // 대표의 자리 화면과 사전 점검: 까닭과 출구
    expect(view(g).unavailable).toMatchObject({ code: 'helper_failed', text: expect.stringContaining("'정지 해제'를 누르면 한 번 더 확인합니다") });
    expect(g.e.core.desktop.prereq()).toMatchObject({ ok: false, state: 'helper_failed', detail: view(g).unavailable!.text });

    // 대표의 정지 해제 — 그 도우미는 여전히 끝나지 않는다. 정지 해제 자체는 된다 (메인은 화면 없이 일한다)
    g.e.core.stops.release(OWNER);
    await g.e.core.desktop.lifecycle.rechecked();
    expect(mainPaused(g)).toBe(false);
    expect(gateOf(g)).toMatchObject({ cause: '긴급 정지', retriedAt: expect.any(String) });
    expect(view(g).unavailable!.text).toContain('서버 PC 운영자에게 서버를 다시 시작해 달라고 부탁하세요');
    expect(g.e.ctx.store.activity.search({ kinds: ['screen'], level: 'error', limit: 20 }).some((a) => a.text.startsWith('정지 해제 때 화면 도우미가 끝났는지 한 번 더 확인했지만 끝나지 않음'))).toBe(true);
    const t2 = await liveMain(g.e, '정지 해제 뒤의 일');
    for (const [tool, args] of screenTools(captureId)) {
      expect([tool, await g.e.tool(t2, tool, args)]).toMatchObject([tool, { ok: false, code: 'stopped', message: UNCONFIRMED_RETRIED_REFUSAL }]);
    }
    expect(UNCONFIRMED_RETRIED_REFUSAL).toContain('서버를 다시 시작해야 화면 조작을 다시 쓸 수 있습니다');
    // 두 번째 도우미를 띄우지 않았고, 앞 도우미는 살아 있다
    expect([g.fake.launches(), pidAlive(pid), inputLines(g.fake).length]).toEqual([1, true, 1]);
    // 문이 걸린 뒤에 시작한 턴에는 접지 않는다 — kill_failed로 끝나거나 메인이 다시 멈추지 않는다
    await endTurn(g);
    expect([g.e.ctx.store.turns.get(t2)!.process.state, mainPaused(g)]).toEqual(['exited', false]);

    // 이제 끝내기가 듣는다 — 다음 정지 해제가 끝남을 확인하고 문을 연다. 새 도우미로 다시 된다
    kill.on = true;
    g.e.core.stops.release(OWNER);
    const t3 = await liveMain(g.e, '다시 화면을 봐 줘');
    // 정지 해제 직후의 화면 도구는 다시 확인이 끝나기를 기다린다 (거부하지 않는다)
    expect((await g.e.tool(t3, 'screen_capture', {})).ok).toBe(true);
    expect([gateOf(g), pidAlive(pid), g.fake.launches()]).toEqual([null, false, 2]);
    expect(view(g).unavailable).toBeNull();
    expect(g.e.ctx.store.activity.search({ kinds: ['screen'], limit: 30 }).some((a) => a.text.startsWith('화면 도우미가 끝난 것을 확인함 — 대표의 정지 해제 때 한 번 더 확인함'))).toBe(true);
    expect(notices(g.e, '화면 도우미 종료 확인 실패')[0]!.readAt).not.toBeNull();
  });

  it('도는 메인 턴이 없을 때의 강제 자리 교체: 1번의 STOP이 끝남을 확인하지 못하면 교체가 멈춘다 — 새 보유자는 턴을 얻지 못하고 메인 에이전트는 곧바로 일시정지된다. 정지 해제가 한 번 더 확인하고 교체를 잇는다 (S6-21 A2b)', async () => {
    const { kill, helper } = switchableKill();
    const g = await bootGui(HUNG, { helper });
    open.push(g);
    g.e.core.seat.applyOperatorConfig({ holders: null, drainMs: 10_000, initialHolder: null }, '시험');
    await armed(g);
    await endTurn(g);
    const pid = g.fake.pids()[0]!;
    // 운영자의 강제 교체 (인계 메모 턴 없음, 도는 메인 턴 없음) — 1번의 STOP에 답이 없고 도우미는 끝나지 않는다
    const r = g.e.core.seat.assign({ holder: { kind: 'launched', ai: CODEX }, by: 'operator', reason: '시험 교체', force: true });
    expect(r.outcome).toBe('swap');
    await r.done;
    // 교체가 멈췄다 (나가는 턴의 종료를 확인하지 못한 교체와 같다) — 새 보유자를 앉히지 않는다
    expect(g.e.ctx.store.seat.require('main')).toMatchObject({ generation: 2, state: 'switching', swap: { stage: 'unconfirmed' } });
    expect(serverRows(g)).toContainEqual(['stop', 'error', `메인 자리 교체: ${STOP_UNCONFIRMED_EXIT}`]);
    expect(gateOf(g)).toMatchObject({ cause: '메인 자리 교체', turnId: null });
    expect(mainPaused(g)).toBe(true);
    const held = notices(g.e, '메인 자리 교체가 멈췄습니다');
    expect(held).toHaveLength(1);
    expect(held[0]!.body).toContain('화면 도우미가 끝났는지 확인하지 못했습니다');
    expect(g.e.ctx.store.activity.search({ kinds: ['seat'], level: 'error', limit: 10 }).some((a) => a.text.includes('화면 도우미가 끝났는지 확인하지 못해'))).toBe(true);
    // 새 보유자에게 턴을 띄우지 않는다
    g.e.hold.add(MAIN_KEY);
    await g.e.invoke('command.send', { target: 'main', text: '새 메인: 화면을 봐 줘' });
    g.e.tick();
    await sleep(200);
    expect(g.e.liveProc(MAIN_KEY, MAIN_AGENT_ID)).toBeUndefined();
    // 다른 배정도 받지 않는다 — 그 글은 화면 도우미의 사실과 출구를 말한다
    expect(() => g.e.core.seat.assign({ holder: { kind: 'launched', ai: CODEX }, by: 'operator', reason: '다시', force: true })).toThrow(/화면 도우미가 끝났는지 확인하지 못함\) — 대표가 '정지 해제'를 누르면/);
    expect([g.fake.launches(), pidAlive(pid)]).toEqual([1, true]);

    // 끝내기가 듣게 된 뒤 대표의 정지 해제 — 끝남을 확인해 문을 열고 교체를 잇는다
    kill.on = true;
    g.e.core.stops.release(OWNER);
    await waitFor(() => g.e.ctx.store.seat.require('main').state === 'active', '교체 이어 감');
    await g.e.core.desktop.lifecycle.rechecked();
    expect([gateOf(g), pidAlive(pid), mainPaused(g), g.e.ctx.store.seat.require('main').generation]).toEqual([null, false, false, 2]);
    g.e.tick();
    await waitFor(() => !!g.e.liveProc(MAIN_KEY, MAIN_AGENT_ID), '새 보유자의 메인 턴');
    const next = g.e.liveProc(MAIN_KEY, MAIN_AGENT_ID)!.turnId;
    expect(g.e.identity(next).seatGeneration).toBe(2);
    expect((await g.e.tool(next, 'screen_capture', {})).ok).toBe(true);
    expect(g.fake.launches()).toBe(2);
  });

  it('입력 명령의 시간 초과: 클라이언트가 스스로 한 STOP이 끝남을 확인하지 못하면 같은 턴의 화면 도구도 stopped이고 새 도우미를 띄우지 않는다 — 서버의 정지 줄·활동 기록이 남고, 그 턴은 kill_failed로 끝나 메인 에이전트가 일시정지된다 (S6-21 A3)', async () => {
    const g = await bootGui(HUNG, { helper: { kill: () => undefined, timeouts: { READY: 5000, CLICK: 300, STOP_ACK: 100, STOP_CONFIRM: 400 } } });
    open.push(g);
    const turnId = await liveMain(g.e);
    const c = await capture(g.e, turnId);
    const pid = g.fake.pids()[0]!;
    g.fake.act({ do: 'set', value: { hang: ['CLICK'] } });
    await sleep(150);
    expect(await click(g, turnId, c.data.capture_id)).toMatchObject({ ok: false, code: 'error', message: INPUT_UNCONFIRMED_TEXT });
    // 그 정지의 결과를 버리지 않는다 — 서버의 정지 줄과 활동 기록(끝났는지 모른다 + 출구)
    const why = '화면 도우미가 입력 명령(CLICK)에 답하지 않아 끝냈습니다';
    // 클라이언트가 스스로 한 정지가 끝날 때까지 (STOP·끝내기·확인 0.4초)
    await waitFor(() => g.e.core.desktop.peek()!.stopping() === null, '클라이언트의 정지');
    expect(serverRows(g)).toEqual([['stop', 'error', `${why}: ${STOP_UNCONFIRMED_EXIT}`]]);
    const told = g.e.ctx.store.activity.search({ kinds: ['screen'], level: 'error', limit: 20 }).map((a) => a.text);
    expect(told).toContain(`서버가 화면 도우미를 멈췄지만(${why}) 끝났는지 확인하지 못했습니다 — 그 화면 도우미가 아직 살아 있을 수 있어 메인 에이전트의 화면 조작을 막았습니다. '정지 해제'를 누르면 끝났는지 한 번 더 확인합니다 — 그래도 끝나지 않으면 서버 PC 운영자에게 서버를 다시 시작해 달라고 부탁하세요`);
    expect(gateOf(g)).toMatchObject({ cause: why, turnId });
    // 같은 턴: 찍지도 누르지도 않는다 — 앞 도우미가 살아 있다
    for (const [tool, args] of screenTools(c.data.capture_id)) {
      expect([tool, await g.e.tool(turnId, tool, args)]).toMatchObject([tool, { ok: false, code: 'stopped', message: UNCONFIRMED_REFUSAL }]);
    }
    expect([g.fake.launches(), pidAlive(pid), inputLines(g.fake).filter((l) => l.startsWith('CLICK ')).length]).toEqual([1, true, 1]);
    // 그 턴에 접는다 — 도는 메인 턴이 있으니 지금 일시정지하지 않고, 턴이 kill_failed로 끝나 메인 에이전트가 일시정지된다
    expect(mainPaused(g)).toBe(false);
    await endTurn(g);
    const t = g.e.ctx.store.turns.get(turnId)!;
    expect([t.process.state, t.process.killDetail]).toEqual(['kill_failed', STOP_UNCONFIRMED_EXIT]);
    // kill_failed 판정 뒤의 메인 일시정지 (상한이 있다 — 아래 단언이 판정한다)
    await waitFor(() => mainPaused(g), '메인 일시정지', 3000).catch(() => undefined);
    expect(mainPaused(g)).toBe(true);
  });

  it('캡처 시간 초과도 그 도우미를 STOP하고 끝낸다 — 서버의 정지 줄과 활동 기록이 남고, 끝남을 확인했으면 문은 없고 다음 캡처는 새 도우미로 한다 (S6-21 A3)', async () => {
    const g = await bootGui({ heldKeys: 1 }, { helper: { timeouts: { READY: 5000, CAPTURE: 300 } } });
    open.push(g);
    const turnId = await liveMain(g.e);
    await capture(g.e, turnId);
    const first = g.fake.pids()[0]!;
    g.fake.act({ do: 'set', value: { hang: ['CAPTURE'] } });
    await sleep(150);
    const r = await g.e.tool(turnId, 'screen_capture', {});
    expect(r).toMatchObject({ ok: false, code: 'error', message: expect.stringContaining('답하지 않아 끝냅니다 — 다시 하면 새 화면 도우미로 합니다') });
    const why = '화면 도우미가 CAPTURE 명령에 답하지 않아 끝냈습니다';
    // 클라이언트가 스스로 한 정지가 끝날 때까지 (상한이 있다 — 멈추지 않았으면 아래 단언이 판정한다)
    await waitFor(() => g.e.core.desktop.peek()!.stopping() === null && !pidAlive(first), '클라이언트의 정지', 3000).catch(() => undefined);
    expect(pidAlive(first)).toBe(false);
    expect(serverRows(g)).toEqual([['stop', 'ok', `${why}: 화면 도우미를 멈췄습니다 (키·버튼 1개 뗌)`]]);
    expect(g.e.ctx.store.activity.search({ kinds: ['screen'], level: 'warn', limit: 20 }).map((a) => a.text)).toContain(`서버가 화면 도우미를 멈춤 — ${why} (키·버튼 1개 뗌)`);
    expect(gateOf(g)).toBeNull();
    // 다음 캡처는 새 도우미 (앞 도우미는 답하지 않던 그 명령과 함께 끝났다). 제어 파일의 set은 새 도우미에도 시작할 때 든다(S6-23 M5) — CAPTURE를 다시 받게 한다
    g.fake.act({ do: 'set', value: { hang: [] } });
    expect((await g.e.tool(turnId, 'screen_capture', {})).ok).toBe(true);
    expect(g.fake.launches()).toBe(2);
    expect(mainPaused(g)).toBe(false);
  });

  it('쉬다 끝낸 도우미(10분 무장 해제 상태)는 STOP OK가 없어도 알릴 것이 없다 — 놓기 뒤라 뗄 키가 없다. 서버의 정지 줄·"뗐는지 확인하지 못했습니다" 기록이 없고 문도 없다 (S6-21 A3)', async () => {
    const g = await bootGui({ noAck: ['STOP'] }, { helper: { idleMs: 300 } });
    open.push(g);
    await armed(g);
    // 턴 끝의 RELEASE에 답한다 — 무장이 풀리고 그 뒤로 쉰다
    await endTurn(g);
    const pid = g.fake.pids()[0]!;
    await waitFor(() => !pidAlive(pid), '쉼 끝내기', 5000);
    await sleep(100);
    expect(stops(g)).toBe(1);
    expect(serverRows(g)).toEqual([['release', 'ok', '턴 끝: 키·버튼 0개를 뗐습니다']]);
    expect(g.e.ctx.store.activity.search({ kinds: ['screen'], limit: 30 }).filter((a) => /뗐는지 확인하지 못|서버가 화면 도우미를 멈/.test(a.text))).toEqual([]);
    expect(gateOf(g)).toBeNull();
  });
});

describe('정지는 한 번에 하나 — 뒤에 온 정지는 도는 정지의 결과를 받는다 (S6-21 A3b·A3c)', () => {
  it.each([0, 250])('끝남을 확인하는 중에 다시 누른 긴급 정지(간격 %ims)도 완료라고 하지 않는다 — STOP은 한 번, 그 메인 턴은 한 번 누른 때처럼 kill_failed, 메인 에이전트 일시정지', async (gapMs) => {
    const g = await bootGui(HUNG, { helper: { kill: () => undefined, timeouts: { READY: 5000, STOP_ACK: 300, STOP_CONFIRM: 1500 } } });
    open.push(g);
    const { turnId } = await armed(g);
    const pid = g.fake.pids()[0]!;
    const p1 = g.e.core.stops.emergency(OWNER);
    if (gapMs) await sleep(gapMs);
    const s2 = await g.e.core.stops.emergency(OWNER);
    // 두 번째 요약이 나온 때 도우미는 살아 있다 — 첫 정지와 같은 결과다
    expect(pidAlive(pid)).toBe(true);
    expect([s2.completed, s2.failures.map((f) => [f.memberId, f.detail])]).toEqual([false, [[MAIN_AGENT_ID, STOP_UNCONFIRMED_EXIT]]]);
    expect(g.e.core.stops.lastEmergency()!.completed).toBe(false);
    const s1 = await p1;
    expect([s1.completed, s1.failures.map((f) => f.detail)]).toEqual([false, [STOP_UNCONFIRMED_EXIT]]);
    expect(notices(g.e, '긴급 정지 완료')).toEqual([]);
    expect(stops(g)).toBe(1);
    // 정지는 하나다 — 서버의 정지 줄도 하나 (뒤의 긴급 정지가 따로 멈추고 따로 적지 않는다)
    expect(serverRows(g)).toEqual([['stop', 'error', `긴급 정지: ${STOP_UNCONFIRMED_EXIT}`]]);
    await g.e.idle();
    const t = g.e.ctx.store.turns.get(turnId)!;
    expect([t.process.state, t.process.killDetail]).toEqual(['kill_failed', STOP_UNCONFIRMED_EXIT]);
    // kill_failed 판정 뒤의 메인 일시정지 (상한이 있다 — 아래 단언이 판정한다)
    await waitFor(() => mainPaused(g), '메인 일시정지', 3000).catch(() => undefined);
    expect(mainPaused(g)).toBe(true);
  });

  it('도우미가 뜨는 중(READY 전)에 온 긴급 정지: 한 번도 무장하지 않은 도우미는 뗄 키가 없다 — 끝남을 확인했으면 요약은 완료, ARM은 가지 않고 기다리던 캡처는 stopped, 쓸 수 없음 알림도 없다 (S6-21 A3c)', async () => {
    const g = await bootGui({ readyDelayMs: 1500 }, { helper: { timeouts: { READY: 5000, STOP_ACK: 300, STOP_CONFIRM: 2000 } } });
    open.push(g);
    const turnId = await liveMain(g.e);
    const pendingShot = g.e.tool(turnId, 'screen_capture', {});
    await waitFor(() => g.fake.pids().length === 1, '도우미 프로세스 시작');
    await sleep(100);
    const pid = g.fake.pids()[0]!;
    const s = await g.e.core.stops.emergency(OWNER);
    expect([s.completed, s.failures]).toEqual([true, []]);
    expect(await pendingShot).toMatchObject({ ok: false, code: 'stopped' });
    expect(g.fake.received().some((l) => / ARM /.test(l))).toBe(false);
    expect(pidAlive(pid)).toBe(false);
    await g.e.idle();
    expect(serverRows(g)).toEqual([['stop', 'ok', '긴급 정지: 화면 도우미를 멈췄습니다 (무장한 적이 없어 뗄 키·버튼이 없음)']]);
    // 우리가 멈춘 것이지 도우미의 실패가 아니다 — 쓸 수 없음 알림·상태가 없다
    expect(g.e.ctx.store.notifications.list().filter((n) => n.key?.startsWith('screen:'))).toEqual([]);
    expect(view(g).unavailable).toBeNull();
  });
});

describe('놓았다는 답을 받지 못한 표시 위에 무장하지 않는다 — 새 도우미로 먼저 놓는다 (S6-21 A4)', () => {
  it('턴 끝의 RELEASE·STOP에 모두 답이 없었으면(끝남은 확인) 다음 무장 앞에 새 도우미로 RELEASE를 보내 답을 받는다 — 그 뒤에야 ARM·캡처·입력, 표시는 새 턴의 것이 된다', async () => {
    const g = await bootGui({ noAck: ['RELEASE', 'STOP'], heldKeys: 2 }, { helper: { timeouts: { READY: 5000, RELEASE: 150, STOP_ACK: 100, STOP_CONFIRM: 1500 } } });
    open.push(g);
    const { turnId } = await armed(g);
    await endTurn(g);
    const first = g.fake.pids()[0]!;
    await waitFor(() => !pidAlive(first), '첫 도우미 끝남');
    expect([g.e.ctx.store.turns.get(turnId)!.process.state, mainPaused(g), gateOf(g)]).toEqual(['exited', false, null]);
    const mark = g.e.ctx.store.kv.get<{ at: string; turnId: string }>(SCREEN_ARMED_KEY)!;
    expect(mark).toMatchObject({ turnId });
    // 새 도우미는 답한다 — 앞 도우미가 누른 채 두었을 수 있는 키 2개를 뗀다
    g.fake.set({ noAck: [], heldKeys: 2 });
    g.clock.advance(1000);
    const next = await liveMain(g.e, '다음 일');
    const c = await capture(g.e, next);
    expect((await click(g, next, c.data.capture_id)).ok).toBe(true);
    const second = g.fake.pids()[1]!;
    expect(verbsOf(g, second).slice(0, 5)).toEqual(['RELEASE', 'ARM', 'CAPTURE', 'FOCUS', 'CLICK']);
    expect(g.e.ctx.store.activity.search({ kinds: ['screen'], level: 'info', limit: 30 }).map((a) => a.text)).toContain(
      `새 화면 도우미로 눌린 키·버튼을 먼저 뗌 (2개) — 앞선 화면 조작(${mark.at}에 시작)이 놓았다는 답을 받지 못하고 끝났습니다`,
    );
    expect(g.e.ctx.store.kv.get(SCREEN_ARMED_KEY)).toMatchObject({ turnId: next });
  });

  it('새 도우미도 그 RELEASE에 답하지 않으면 무장하지 않고 unavailable — 아무것도 찍거나 보내지 않고, 답하지 않는 도우미는 멈춘다. 그 STOP이 뗐다고 답하면 표시가 지워져 다음 캡처는 바로 무장한다', async () => {
    const g = await bootGui({ noAck: ['RELEASE', 'STOP'] }, { helper: { timeouts: { READY: 5000, RELEASE: 150, STOP_ACK: 100, STOP_CONFIRM: 1500 } } });
    open.push(g);
    await armed(g);
    await endTurn(g);
    await waitFor(() => !pidAlive(g.fake.pids()[0]!), '첫 도우미 끝남');
    expect(g.e.ctx.store.kv.get(SCREEN_ARMED_KEY)).not.toBeNull();
    // 새 도우미는 RELEASE에 답하지 않는다 (STOP에는 답한다)
    g.fake.set({ noAck: ['RELEASE'] });
    const next = await liveMain(g.e, '다음 일');
    expect(await g.e.tool(next, 'screen_capture', {})).toMatchObject({ ok: false, code: 'unavailable', message: UNRELEASED_REFUSAL });
    const second = g.fake.pids()[1]!;
    await waitFor(() => !pidAlive(second), '답하지 않는 도우미를 멈춤');
    expect(verbsOf(g, second)).toEqual(['RELEASE', 'STOP']);
    expect(captures(g)).toBe(1);
    // 그 STOP OK는 키를 뗐다는 답이다 — 표시가 지워지고, 다음 캡처는 놓기 없이 무장한다
    expect(g.e.ctx.store.kv.get(SCREEN_ARMED_KEY)).toBeNull();
    g.fake.set({ noAck: [] });
    expect((await g.e.tool(next, 'screen_capture', {})).ok).toBe(true);
    expect(verbsOf(g, g.fake.pids()[2]!).slice(0, 2)).toEqual(['ARM', 'CAPTURE']);
  });

  it('도우미가 조작 중에 뜻밖에 끝나면(놓았는지 모름) 다시 뜬 도우미의 무장 앞에도 RELEASE가 먼저 간다 — 다시 시작하지 않아도', async () => {
    const g = await bootGui();
    open.push(g);
    const { turnId } = await crashArmed(g);
    g.clock.advance(1000);
    const c = await capture(g.e, turnId);
    expect((await click(g, turnId, c.data.capture_id)).ok).toBe(true);
    const second = g.fake.pids()[1]!;
    expect(verbsOf(g, second).slice(0, 3)).toEqual(['RELEASE', 'ARM', 'CAPTURE']);
    // 앞 도우미에게 일으킨 crash를 새 도우미가 되풀이하지 않는다 — 이 시험은 새 도우미가 일을 마치는 빠르기에 기대지 않는다 (S6-23 M5)
    await sleep(200);
    expect([pidAlive(second), g.fake.launches()]).toEqual([true, 2]);
  });

  it('새 도우미가 RELEASE에도 STOP에도 답하지 않고 끝나면(끝남은 확인) 표시는 남는다 — 그다음 도우미의 무장 앞에도 RELEASE가 먼저 간다 (S6-23 T2)', async () => {
    // 지키는 것: 표시 위의 놓기에 답이 없을 때 표시를 지워 버리는 것 — 그러면 다음 ARM이 눌린 채일 수 있는 키 위로 놓기 없이 간다 (S6-21 A4)
    const g = await bootGui({ noAck: ['RELEASE', 'STOP'] }, { helper: { timeouts: { READY: 5000, RELEASE: 150, STOP_ACK: 100, STOP_CONFIRM: 1500 } } });
    open.push(g);
    await armed(g);
    await endTurn(g);
    await waitFor(() => !pidAlive(g.fake.pids()[0]!), '첫 도우미 끝남');
    expect(markOf(g)).not.toBeNull();
    // 둘째 도우미도 RELEASE·STOP 모두 답하지 않는다 (끝내기는 듣는다)
    const next = await liveMain(g.e, '다음 일');
    expect(await g.e.tool(next, 'screen_capture', {})).toMatchObject({ ok: false, code: 'unavailable', message: UNRELEASED_REFUSAL });
    const second = g.fake.pids()[1]!;
    await waitFor(() => !pidAlive(second) && g.e.core.desktop.peek()!.stopping() === null, '답하지 않는 둘째 도우미를 멈춤');
    expect(verbsOf(g, second)).toEqual(['RELEASE', 'STOP']);
    // 아무도 놓았다고 답하지 않았다 — 표시는 남는다
    expect(markOf(g)).not.toBeNull();
    // 셋째 도우미는 답한다 — 그 무장 앞에도 RELEASE가 먼저 간다
    g.fake.set({ noAck: [] });
    expect((await g.e.tool(next, 'screen_capture', {})).ok).toBe(true);
    expect(verbsOf(g, g.fake.pids()[2]!).slice(0, 3)).toEqual(['RELEASE', 'ARM', 'CAPTURE']);
  }, 60_000);

  it('표시 위의 놓기에 답하지 않는 새 도우미는 다시 띄우기 상한에 센다 — 세 번이면 더 띄우지 않고, 그 실패는 대표의 자리 화면·사전 점검·알림과 메인 알림 업무에 남는다 (S6-23 M2)', async () => {
    // 지키는 것: 답하지 않는 새 도우미를 호출마다 띄우고 끝내기를 끝없이 되풀이하면서 대표에게는 '쓸 수 있음'으로 보이는 것
    const g = await bootGui({ noAck: ['RELEASE', 'STOP'] }, { helper: { timeouts: { READY: 5000, RELEASE: 150, STOP_ACK: 100, STOP_CONFIRM: 1500 } } });
    open.push(g);
    await armed(g);
    await endTurn(g);
    await waitFor(() => !pidAlive(g.fake.pids()[0]!), '첫 도우미 끝남');
    expect(markOf(g)).not.toBeNull();
    // 턴 끝의 놓기 무응답은 세지 않았다 (부른 쪽이 STOP으로 이었다)
    expect(g.e.core.desktop.peek()!.problem()).toBeNull();
    const turnId = await liveMain(g.e, '다음 일');
    const before = g.fake.launches();
    const results: string[] = [];
    for (let i = 0; i < MAX_HELPER_FAILURES + 2; i++) {
      const r = await g.e.tool(turnId, 'screen_capture', {});
      results.push(r.ok ? 'ok' : r.message === UNRELEASED_REFUSAL ? 'unreleased' : r.message.includes(`${MAX_HELPER_FAILURES}번 실패해 더 띄우지 않습니다`) ? `${r.code}:capped` : `${r.code}:${r.message}`);
      const last = g.fake.pids().at(-1)!;
      await waitFor(() => !pidAlive(last) && g.e.core.desktop.peek()!.stopping() === null, '답하지 않는 도우미를 멈춤');
    }
    expect(results).toEqual(['unreleased', 'unreleased', 'unreleased', 'unavailable:capped', 'unavailable:capped']);
    expect(g.fake.launches() - before).toBe(MAX_HELPER_FAILURES);
    expect(g.e.core.desktop.peek()!.problem()).toMatchObject({ code: 'helper_failed', permanent: true, text: expect.stringContaining(RELEASE_UNANSWERED_STOP) });
    // 그 세 도우미는 놓기 무응답으로 멈췄다 — 서버의 정지 줄이 그 까닭을 말한다
    expect(serverRows(g).filter((x) => String(x[2]).startsWith(`${RELEASE_UNANSWERED_STOP}:`))).toHaveLength(MAX_HELPER_FAILURES);
    // 대표가 본다: 자리 화면·사전 점검·알림 하나, 메인 알림 업무 하나
    expect(view(g).unavailable).toMatchObject({ code: 'helper_failed', text: expect.stringContaining(UNRELEASED_PROBLEM) });
    expect(g.e.core.desktop.prereq()).toMatchObject({ ok: false, state: 'helper_failed', detail: view(g).unavailable!.text });
    expect(helperFailedNotices(g)).toHaveLength(1);
    expect(helperFailedAlerts(g)).toHaveLength(1);
    // 아무도 놓았다고 답하지 않았다 — 표시는 남는다
    expect(markOf(g)).not.toBeNull();
  }, 60_000);

  it('표시 위의 놓기를 기다리는 사이 긴급 정지가 정해지면 그 캡처는 stopped다 — 놓지 못했다는 unavailable이 아니고 쓸 수 없음 알림도 없다 (S6-23 M4)', async () => {
    const g = await bootGui({}, { helper: { timeouts: { READY: 5000, RELEASE: 3000 } } });
    open.push(g);
    const { turnId } = await crashArmed(g);
    // 새 도우미는 RELEASE에 답하지 않는다 (STOP에는 답한다)
    g.fake.set({ noAck: ['RELEASE'] });
    g.clock.advance(1000);
    const pending = g.e.tool(turnId, 'screen_capture', {});
    await waitFor(() => releases(g) === 1, '새 도우미에 RELEASE');
    await g.e.core.stops.emergency(OWNER);
    expect(await pending).toMatchObject({ ok: false, code: 'stopped' });
    expect(captures(g)).toBe(1);
    expect(helperFailedNotices(g)).toEqual([]);
    expect(helperFailedAlerts(g)).toEqual([]);
  });
});

describe('gui_input release — 떠 있는 도우미가 없어도 놓기 표시가 남았으면 새 도우미로 놓는다 (S6-23 M1)', () => {
  it('무장한 도우미가 뜻밖에 끝난 뒤의 release: 새 도우미를 한 번 띄워 RELEASE하고 뗀 수를 알린다 — 표시가 지워지고 활동 기록이 남으며, 다음 무장 앞에는 다시 놓지 않는다', async () => {
    const g = await bootGui();
    open.push(g);
    const { turnId, mark } = await crashArmed(g);
    // 새 도우미가 떼는 키 하나 (앞 도우미가 누른 채 두었을 수 있다)
    g.fake.set({ heldKeys: 1 });
    const r = await g.e.tool(turnId, 'gui_input', { action: 'release', request_id: rid('m1') });
    const said = '새 화면 도우미를 띄워 눌린 키·버튼 1개를 뗐습니다 (앞선 화면 조작이 놓았다는 답을 받지 못하고 끝났었습니다)';
    expect(r).toMatchObject({ ok: true, data: { action: 'release', message: said } });
    const second = g.fake.pids()[1]!;
    expect([g.fake.launches(), verbsOf(g, second)]).toEqual([2, ['RELEASE']]);
    expect(markOf(g)).toBeNull();
    expect(g.e.ctx.store.activity.search({ kinds: ['screen'], level: 'info', limit: 30 }).map((a) => a.text)).toContain(
      `메인 에이전트의 놓기(gui_input release)로 새 화면 도우미를 띄워 눌린 키·버튼을 뗌 (1개) — 앞선 화면 조작(${mark.at}에 시작)이 놓았다는 답을 받지 못하고 끝났습니다`,
    );
    expect(g.e.ctx.store.guiActions.query({ turnId, actions: ['release'], limit: 5 }).map((x) => [x.result, x.detail])).toEqual([['ok', said]]);
    // 표시가 지워졌다 — 다음 캡처는 놓기 없이 같은 도우미로 무장한다
    g.clock.advance(1000);
    await capture(g.e, turnId);
    expect(verbsOf(g, second).slice(0, 3)).toEqual(['RELEASE', 'ARM', 'CAPTURE']);
    expect(g.fake.launches()).toBe(2);
  });

  it('새 도우미도 그 RELEASE에 답하지 않으면 놓았다는 답을 받지 못했다고 하고 출구를 말한다 (무장 앞의 놓기와 같은 글) — 그 도우미는 멈추고 세며, 표시는 남고, 대표의 화면·사전 점검·알림에 남는다', async () => {
    const g = await bootGui({}, { helper: { timeouts: { READY: 5000, RELEASE: 150, STOP_ACK: 100, STOP_CONFIRM: 1500 } } });
    open.push(g);
    const { turnId } = await crashArmed(g);
    g.fake.set({ noAck: ['RELEASE', 'STOP'] });
    const r = await g.e.tool(turnId, 'gui_input', { action: 'release', request_id: rid('m1b') });
    expect(r).toMatchObject({ ok: false, code: 'unavailable', message: UNRELEASED_REFUSAL });
    expect(UNRELEASED_REFUSAL).toContain('새 화면 도우미로도 놓았다는 답을 받지 못했습니다');
    const second = g.fake.pids()[1]!;
    await waitFor(() => !pidAlive(second) && g.e.core.desktop.peek()!.stopping() === null, '답하지 않는 도우미를 멈춤');
    expect(verbsOf(g, second)).toEqual(['RELEASE', 'STOP']);
    expect(markOf(g)).not.toBeNull();
    expect(g.e.ctx.store.guiActions.query({ turnId, actions: ['release'], limit: 5 }).map((x) => [x.result, x.detail])).toEqual([['unavailable', UNRELEASED_REFUSAL]]);
    // 뜻밖의 종료 하나와 놓기 무응답 하나를 셌다
    expect(g.e.core.desktop.peek()!.problem()).toMatchObject({ code: 'helper_failed', permanent: false, text: RELEASE_UNANSWERED_STOP });
    expect(view(g).unavailable).toMatchObject({ code: 'helper_failed', text: expect.stringContaining(UNRELEASED_PROBLEM) });
    expect(g.e.core.desktop.prereq()).toMatchObject({ ok: false, state: 'helper_failed' });
    expect(helperFailedNotices(g)).toHaveLength(1);
    expect(helperFailedAlerts(g)).toHaveLength(1);
  });

  it('떠 있는 도우미도 놓기 표시도 없으면 그 사실만 말한다 — "뗄 키가 없다"고 하지 않고 도우미를 띄우지 않는다', async () => {
    const g = await bootGui();
    open.push(g);
    const turnId = await liveMain(g.e);
    const r = await g.e.tool(turnId, 'gui_input', { action: 'release', request_id: rid('m1c') });
    expect(r).toMatchObject({ ok: true, data: { action: 'release', message: NO_HELPER_RELEASE_TEXT } });
    expect(NO_HELPER_RELEASE_TEXT).toBe('화면 도우미가 떠 있지 않습니다 — 화면 도우미가 누른 키는 없습니다');
    expect([g.fake.launches(), markOf(g)]).toEqual([0, null]);
  });

  it('새 도우미의 준비(prepare)를 기다리는 사이 긴급 정지가 정해지면 RELEASE를 보내지 않고 그 호출은 stopped다 — 그사이 뜬 도우미는 끝내고 표시는 남는다 (S6-25 N3 — 검토 3차 R3-3)', async () => {
    // 지키는 것: 긴급 정지가 끝난 뒤에 놓기를 하려고 도우미를 띄워 RELEASE를 보내고 ok라고 답하며, 그 도우미를 정지 내내 남기는 것
    const fake = createFakeDesktop();
    let gate: Promise<void> = Promise.resolve();
    let openGate: () => void = () => undefined;
    // 준비(prepare — 실제 앱은 컴파일·해시 확인)를 붙잡는다 (J1 '느린 준비'와 같은 이음매)
    const launcher: DesktopHelperLauncher = { prepare: () => gate, launch: () => fake.launcher.launch() };
    const g = await bootGui({}, { fake, helper: { launcher } });
    open.push(g);
    const { turnId } = await crashArmed(g);
    gate = new Promise((r) => (openGate = r));
    const pending = g.e.tool(turnId, 'gui_input', { action: 'release', request_id: rid('n3') });
    await sleep(150);
    const launchesBefore = g.fake.launches();
    expect(launchesBefore).toBe(1);
    // 떠 있는 도우미가 없다 — 긴급 정지는 멈출 것이 없어 완료다
    expect((await g.e.core.stops.emergency(OWNER)).completed).toBe(true);
    openGate();
    const r = await pending;
    expect(r).toMatchObject({ ok: false, code: 'stopped' });
    // 준비가 끝나 도우미 하나가 떴지만 RELEASE는 가지 않았고, 그 도우미는 끝났다
    expect(g.fake.launches() - launchesBefore).toBe(1);
    const second = g.fake.pids()[1]!;
    await waitFor(() => !pidAlive(second), '정지 뒤에 뜬 도우미를 끝냄', 3000).catch(() => undefined);
    expect([releases(g), pidAlive(second), g.e.core.desktop.peek()!.hasProcess()]).toEqual([0, false, false]);
    expect(serverRows(g)).toContainEqual(['stop', 'ok', '화면 조작을 멈춘 사이에 뜬 화면 도우미를 끝냄: 화면 도우미를 멈췄습니다 (키·버튼 0개 뗌)']);
    // 놓았다는 답이 없다 — 표시는 남아 다음 무장이 먼저 놓는다. 쓸 수 없음으로 남기지 않는다
    expect(markOf(g)).not.toBeNull();
    expect([helperFailedNotices(g), helperFailedAlerts(g)]).toEqual([[], []]);
    expect(g.e.ctx.store.guiActions.query({ turnId, actions: ['release'], limit: 5 }).map((x) => x.result)).toEqual(['stopped']);
    g.e.core.stops.release(OWNER);
    assertFakeMain(g.e);
  });

  it('새 도우미가 READY를 기다리는 사이 긴급 정지가 정해지면 그 호출은 stopped다 — RELEASE는 가지 않고, 놓지 못했다는 unavailable·쓸 수 없음 알림이 아니다 (S6-25 N4 1)', async () => {
    // 지키는 것: gui_input release의 실패 뒤 다시 보기를 빼면 그사이 정해진 정지가 '놓았다는 답을 받지 못했다'(unavailable)로 보이고 쓸 수 없음으로 남는다 (S6-23 M4)
    const g = await bootGui();
    open.push(g);
    const { turnId } = await crashArmed(g);
    // 다음 도우미는 READY를 늦게 보낸다
    g.fake.set({ readyDelayMs: 1500 });
    const pending = g.e.tool(turnId, 'gui_input', { action: 'release', request_id: rid('n4a') });
    await waitFor(() => g.fake.pids().length === 2, '새 도우미가 뜸');
    await g.e.core.stops.emergency(OWNER);
    expect(await pending).toMatchObject({ ok: false, code: 'stopped' });
    expect(releases(g)).toBe(0);
    expect(markOf(g)).not.toBeNull();
    expect([helperFailedNotices(g), helperFailedAlerts(g)]).toEqual([[], []]);
    g.e.core.stops.release(OWNER);
    assertFakeMain(g.e);
  });

  it('표시 위의 gui_input release 두 번이 한꺼번에 오면 놓기는 하나다 — 도우미 하나, RELEASE 하나, 활동 기록 한 줄이고 두 호출 모두 뗀 수를 알린다 (S6-25 N4 3)', async () => {
    // 지키는 것: 도는 표시 위의 놓기를 나눠 쓰지 않으면 두 호출이 저마다 RELEASE를 보내고 활동 기록을 두 줄 남긴다
    const g = await bootGui();
    open.push(g);
    const { turnId, mark } = await crashArmed(g);
    g.fake.set({ heldKeys: 1 });
    const both = await Promise.all([
      g.e.tool(turnId, 'gui_input', { action: 'release', request_id: rid('n4c-1') }),
      g.e.tool(turnId, 'gui_input', { action: 'release', request_id: rid('n4c-2') }),
    ]);
    const said = '새 화면 도우미를 띄워 눌린 키·버튼 1개를 뗐습니다 (앞선 화면 조작이 놓았다는 답을 받지 못하고 끝났었습니다)';
    expect(both).toMatchObject([
      { ok: true, data: { message: said } },
      { ok: true, data: { message: said } },
    ]);
    expect([g.fake.launches(), releases(g), markOf(g)]).toEqual([2, 1, null]);
    const rows = g.e.ctx.store.activity.search({ kinds: ['screen'], level: 'info', limit: 30 }).filter((a) => a.text.startsWith('메인 에이전트의 놓기(gui_input release)로 새 화면 도우미를 띄워'));
    expect(rows.map((a) => a.text)).toEqual([
      `메인 에이전트의 놓기(gui_input release)로 새 화면 도우미를 띄워 눌린 키·버튼을 뗌 (1개) — 앞선 화면 조작(${mark.at}에 시작)이 놓았다는 답을 받지 못하고 끝났습니다`,
    ]);
  });
});

describe('무장한 뒤에는 다른 무엇보다 먼저 다시 본다 — 끝난 턴을 위해 무장한 채 두거나 찍지 않는다 (S6-21 F1)', () => {
  it.each([
    ['사람 입력이 아닌 시작 값', false],
    ['방금 전 사람 입력인 시작 값', true],
  ])('ARM 답을 기다리는 사이 그 턴이 끝나면 ARM 답 뒤에 놓는다 — %s', async (_label, human) => {
    const g = await bootGui({ delayMs: { ARM: 400 }, ...(human ? { seedMs: Date.now() - 2000 } : {}) });
    open.push(g);
    const turnId = await liveMain(g.e);
    const pending = g.e.tool(turnId, 'screen_capture', {});
    await waitFor(() => g.fake.received().some((l) => / ARM /.test(l)), 'ARM 보냄');
    // 그 턴이 끝난다 — ARM 답은 아직이라 턴 끝의 놓기는 무장한 도우미를 보지 못한다
    await endTurn(g);
    expect(releases(g)).toBe(0);
    expect(await pending).toMatchObject({ ok: false, code: 'stopped' });
    const h = g.e.core.desktop.peek()!;
    // 놓기의 답까지 기다린다 (상한이 있다 — 놓지 않으면 아래 단언이 판정한다)
    await waitFor(() => releases(g) === 1 && !h.armed(), 'ARM 답 뒤의 RELEASE', 3000).catch(() => undefined);
    expect(releases(g)).toBe(1);
    expect([h.armed(), view(g).operatingSince, g.e.ctx.store.kv.get(SCREEN_ARMED_KEY)]).toEqual([false, null, null]);
    // 끝난 턴을 위해 찍지 않는다
    expect(captures(g)).toBe(0);
    expect(g.e.ctx.store.guiActions.query({ turnId, limit: 10 }).map((r) => [r.action, r.result])).toEqual([['capture', 'stopped']]);
  });
});

describe('입력 쪽의 다시 보기 — gui_input이 무장하는 호출일 때와 느린 준비를 기다릴 때 (S6-21 J1)', () => {
  it('gui_input이 무장하는 호출이고 ARM의 시작 값이 방금 전 사람 입력이면 입력 줄을 보내지 않는다 — human_active (무장한 뒤의 다시 보기)', async () => {
    const g = await bootGui();
    open.push(g);
    const turnId = await liveMain(g.e);
    const c = await capture(g.e, turnId);
    // 도우미가 뜻밖에 끝난다 — 다음 도우미의 시작 값(마지막 입력)은 지금이다: 사람이 서버 PC를 방금 썼다
    g.fake.set({ seedMs: Date.now() });
    killFakePids(g.fake.pids());
    await waitFor(() => g.e.core.desktop.peek()!.pid === null, '도우미 끝남');
    expect(view(g).paused).toBeNull();
    expect(await click(g, turnId, c.data.capture_id)).toMatchObject({ ok: false, code: 'human_active' });
    expect(inputLines(g.fake)).toEqual([]);
    // 그 입력이 새 도우미를 띄워 무장했다 — 무장하며 안 사람 입력으로 멈췄다
    expect([g.fake.launches(), g.fake.received().filter((l) => / ARM /.test(l)).length]).toEqual([2, 2]);
    expect(view(g).paused).toMatchObject({ by: 'human' });
  });

  it('느린 준비를 기다리던 입력은 그사이 자리 교체가 정해지면 conflict — 입력 줄을 보내지 않는다 (준비 뒤의 다시 보기)', async () => {
    const fake = createFakeDesktop();
    let gate: Promise<void> = Promise.resolve();
    let openGate: () => void = () => undefined;
    // 준비(prepare — 실제 앱은 컴파일)가 끝나지 않게 붙잡는다: 교체 1번의 STOP이 멈출 도우미 프로세스가 아직 없다
    const launcher: DesktopHelperLauncher = { prepare: () => gate, launch: () => fake.launcher.launch() };
    const g = await bootGui({}, { fake, helper: { launcher } });
    open.push(g);
    g.e.core.seat.applyOperatorConfig({ holders: null, drainMs: 10_000, initialHolder: null }, '시험');
    const turnId = await liveMain(g.e);
    const c = await capture(g.e, turnId);
    killFakePids(g.fake.pids());
    await waitFor(() => g.e.core.desktop.peek()!.pid === null, '도우미 끝남');
    gate = new Promise((r) => (openGate = r));
    const pending = click(g, turnId, c.data.capture_id);
    await sleep(150);
    expect(g.fake.launches()).toBe(1);
    // 입력이 준비를 기다리는 사이 교체가 정해진다 (나가는 턴은 아직 돈다)
    const r = g.e.core.seat.assign({ holder: { kind: 'launched', ai: CODEX }, by: 'operator', reason: '시험 교체' });
    expect(r.outcome).toBe('swap');
    openGate();
    expect(await pending).toMatchObject({ ok: false, code: 'conflict' });
    // 준비가 끝나 도우미는 떴지만 입력은 가지 않았다
    expect(g.fake.launches()).toBe(2);
    expect(inputLines(g.fake)).toEqual([]);
    g.e.hold.delete(MAIN_KEY);
    g.e.liveProc(MAIN_KEY, MAIN_AGENT_ID)!.finishOk();
    await r.done;
  });
});

describe('멈춤 단축키를 등록하지 못한 도우미에는 입력을 보내지 않는다 (S6-21 D)', () => {
  it('ARM이 hotkey=0이면 gui_input은 unavailable(출구를 말한다)이고 캡처는 된다 — 도우미마다 활동 기록 한 줄·메인 알림 하나, 자리 화면과 사전 점검에 그 까닭. 다음 ARM이 등록했다고 하면 풀린다', async () => {
    const g = await bootGui({ hotkey: false });
    open.push(g);
    const turnId = await liveMain(g.e);
    const c = await capture(g.e, turnId);
    expect(armReplies(g)).toEqual([expect.stringMatching(/ hotkey=0$/)]);
    for (let i = 0; i < 2; i++) expect(await click(g, turnId, c.data.capture_id)).toMatchObject({ ok: false, code: 'unavailable', message: NO_HOTKEY_REFUSAL });
    expect(NO_HOTKEY_REFUSAL.startsWith('멈춤 단축키를 등록하지 못했습니다 — 같은 단축키를 쓰는 프로그램을 닫거나 서버를 다시 시작하세요')).toBe(true);
    expect(inputLines(g.fake)).toEqual([]);
    // 캡처는 된다
    expect((await g.e.tool(turnId, 'screen_capture', {})).ok).toBe(true);
    const warns = g.e.ctx.store.activity.search({ kinds: ['screen'], level: 'warn', limit: 20 }).filter((a) => a.text.includes('멈춤 단축키(Ctrl+Alt+Shift+F12)를 등록하지 못함'));
    expect(warns).toHaveLength(1);
    const alerts = g.e.ctx.store.queue.list({}).filter((q) => q.alertKey?.startsWith('alert:screen:no_hotkey:'));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.message).toContain('gui_input(release 빼고)은 unavailable로 거부됩니다');
    expect(alertEnded(g.e.ctx, alerts[0]!)).toBeNull();
    expect(view(g).unavailable).toMatchObject({ code: 'helper_failed', text: expect.stringContaining('멈춤 단축키(Ctrl+Alt+Shift+F12)를 등록하지 못해') });
    expect(g.e.core.desktop.prereq()).toMatchObject({ ok: false, detail: view(g).unavailable!.text });
    // 도우미가 다음 ARM에서 단축키를 다시 건다 — 놓고 다시 찍으면 입력이 간다
    g.fake.act({ do: 'set', value: { hotkey: true } });
    await sleep(150);
    expect((await g.e.tool(turnId, 'gui_input', { action: 'release', request_id: rid() })).ok).toBe(true);
    const c2 = await capture(g.e, turnId);
    expect(armReplies(g).at(-1)).toMatch(/ hotkey=1$/);
    expect((await click(g, turnId, c2.data.capture_id)).ok).toBe(true);
    expect(inputLines(g.fake)).toHaveLength(1);
    expect(view(g).unavailable).toBeNull();
    expect(alertEnded(g.e.ctx, alerts[0]!)).not.toBeNull();
    expect(g.e.ctx.store.activity.search({ kinds: ['screen'], limit: 30 }).some((a) => a.text.startsWith('화면 도우미가 멈춤 단축키(Ctrl+Alt+Shift+F12)를 다시 등록함'))).toBe(true);
  });

  it('hotkey=0으로 거부한 gui_input은 무장을 놓는다 — 그 프로그램이 닫히면 같은 턴의 다음 gui_input이 다시 ARM해 단축키를 다시 걸고 입력이 간다 (S6-23 L)', async () => {
    // 지키는 것: 무장한 채 거부해 같은 턴 안에서는 ARM이 다시 가지 않아(도우미는 ARM 때만 다시 걸어 본다) 출구를 따라도 계속 거부되는 것 — 알림 업무의
    // '풀렸는지는 다음 gui_input이 알려 줍니다'가 거짓이 된다
    const g = await bootGui({ hotkey: false });
    open.push(g);
    const turnId = await liveMain(g.e);
    const c = await capture(g.e, turnId);
    expect(await click(g, turnId, c.data.capture_id)).toMatchObject({ ok: false, code: 'unavailable', message: NO_HOTKEY_REFUSAL });
    // 거부하며 놓았다 (답을 받은 뒤 거부한다) — 도우미도 클라이언트도 무장하지 않았다
    expect([releases(g), g.e.core.desktop.peek()!.armed(), markOf(g)]).toEqual([1, false, null]);
    const alert = g.e.ctx.store.queue.list({}).find((q) => q.alertKey?.startsWith('alert:screen:no_hotkey:'))!;
    expect(alert.message).toContain('풀렸는지는 다음 gui_input이 알려 줍니다');
    // 서버 PC 운영자가 그 단축키를 쥔 프로그램을 닫았다
    g.fake.act({ do: 'set', value: { hotkey: true } });
    await sleep(150);
    // 같은 턴, 같은 캡처로 다음 gui_input — 그 호출이 다시 ARM한다
    expect((await click(g, turnId, c.data.capture_id)).ok).toBe(true);
    expect(armReplies(g)).toEqual([expect.stringMatching(/ hotkey=0$/), expect.stringMatching(/ hotkey=1$/)]);
    expect([inputLines(g.fake).length, g.fake.launches()]).toEqual([1, 1]);
    expect(view(g).unavailable).toBeNull();
    expect(alertEnded(g.e.ctx, alert)).not.toBeNull();
  });

  it('같은 도우미가 여러 번 ARM해도(hotkey=0 — 두 턴에 걸쳐, 거부로 놓은 뒤에도) 경고 한 줄·메인 알림 하나다 (S6-21 D, S6-23 T2)', async () => {
    // 지키는 것: '도우미마다 한 번'을 빼면 ARM마다 경고와 새 알림 업무(alert:screen:no_hotkey:<때>)가 쌓이는 것
    const g = await bootGui({ hotkey: false });
    open.push(g);
    const t1 = await liveMain(g.e);
    const c1 = await capture(g.e, t1);
    const pid = g.fake.pids()[0]!;
    // 거부(무장을 놓는다) 뒤의 다음 입력이 다시 ARM한다 — 여전히 hotkey=0
    expect(await click(g, t1, c1.data.capture_id)).toMatchObject({ ok: false, code: 'unavailable' });
    expect(await click(g, t1, c1.data.capture_id)).toMatchObject({ ok: false, code: 'unavailable' });
    await endTurn(g);
    const t2 = await liveMain(g.e, '다음 일');
    await capture(g.e, t2);
    const arms = g.fake.log().filter((x) => x.pid === pid && x.dir === 'out' && / OK seed=.* hotkey=0$/.test(x.line));
    expect([g.fake.pids().length, arms.length]).toEqual([1, 3]);
    const warns = g.e.ctx.store.activity.search({ kinds: ['screen'], level: 'warn', limit: 30 }).filter((a) => a.text.includes('멈춤 단축키(Ctrl+Alt+Shift+F12)를 등록하지 못함'));
    const alerts = g.e.ctx.store.queue.list({}).filter((q) => q.alertKey?.startsWith('alert:screen:no_hotkey:'));
    expect([warns.length, alerts.length]).toEqual([1, 1]);
    expect(inputLines(g.fake)).toEqual([]);
  }, 60_000);

  it('hotkey=0 거부의 놓기에 답하지 않는 도우미는 멈추고 다시 띄우기 상한에 센다 — 같은 턴에 gui_input을 거듭해도 도우미는 세 번까지만 뜨고, 경고·메인 알림은 도우미마다 하나다 (S6-25 N2 — 검토 3차 R3-2)', async () => {
    // 지키는 것: 놓기 무응답을 세지 않으면 호출마다 새 도우미를 띄우고(hotkey=0) 경고 한 줄과 새 메인 알림 업무를 끝없이 쌓으며, 대표 화면에는 아무것도 보이지 않는다
    const g = await bootGui({ hotkey: false, noAck: ['RELEASE'] }, { helper: { timeouts: { READY: 5000, RELEASE: 150, STOP_ACK: 100, STOP_CONFIRM: 1500 } } });
    open.push(g);
    const turnId = await liveMain(g.e);
    const c = await capture(g.e, turnId);
    const results: string[] = [];
    for (let i = 0; i < MAX_HELPER_FAILURES + 2; i++) {
      const r = await click(g, turnId, c.data.capture_id);
      results.push(r.ok ? 'ok' : r.message === NO_HOTKEY_REFUSAL ? 'no_hotkey' : r.message.includes(`${MAX_HELPER_FAILURES}번 실패해 더 띄우지 않습니다`) ? `${r.code}:capped` : `${r.code}:${r.message}`);
      // 거부는 그 도우미의 정지를 기다린 뒤에 온다 — 그래도 끝남까지 (상한이 있다 — 끝나지 않았으면 아래 단언이 판정한다)
      const last = g.fake.pids().at(-1)!;
      await waitFor(() => !pidAlive(last) && g.e.core.desktop.peek()!.stopping() === null, '놓기에 답하지 않는 도우미를 멈춤', 5000).catch(() => undefined);
    }
    expect(results).toEqual(['no_hotkey', 'no_hotkey', 'no_hotkey', 'unavailable:capped', 'unavailable:capped']);
    expect(g.fake.launches()).toBe(MAX_HELPER_FAILURES);
    expect(g.fake.pids().filter((p) => pidAlive(p))).toEqual([]);
    expect(g.e.core.desktop.peek()!.problem()).toMatchObject({ code: 'helper_failed', permanent: true, text: expect.stringContaining(RELEASE_UNANSWERED_STOP) });
    // 세 도우미는 놓기 무응답으로 멈췄다 — 서버의 정지 줄이 그 까닭을 말한다
    expect(serverRows(g).filter((x) => String(x[2]).startsWith(`${RELEASE_UNANSWERED_STOP}:`))).toHaveLength(MAX_HELPER_FAILURES);
    // 경고·메인 알림은 도우미마다 하나 — 띄운 도우미 수로 끝난다
    const warns = g.e.ctx.store.activity.search({ kinds: ['screen'], level: 'warn', limit: 50 }).filter((a) => a.text.includes('멈춤 단축키(Ctrl+Alt+Shift+F12)를 등록하지 못함'));
    const alerts = g.e.ctx.store.queue.list({}).filter((q) => q.alertKey?.startsWith('alert:screen:no_hotkey:'));
    expect([warns.length, alerts.length]).toEqual([MAX_HELPER_FAILURES, MAX_HELPER_FAILURES]);
    // 대표가 본다 (상한 — 서버를 다시 시작해야 한다)
    expect(view(g).unavailable).toMatchObject({ code: 'helper_failed' });
    // 입력은 가지 않았다
    expect(inputLines(g.fake)).toEqual([]);
    assertFakeMain(g.e);
  }, 60_000);
});

describe('사람 우선의 경계 — 답 없이 끝난 입력과 놓기의 키 올림 (S6-21 E2·F3)', () => {
  it('답 없이 끝난 입력(보냈는지 모른다) 뒤 30초는 캡처·입력을 하지 않는다. 그 뒤 새 도우미의 시작 값이 그 입력을 쓴 때와 시간 초과 사이면 사람 입력이다', async () => {
    const g = await bootGui({}, { helper: { timeouts: { READY: 5000, CLICK: 400 } } });
    open.push(g);
    const turnId = await liveMain(g.e);
    const c = await capture(g.e, turnId);
    g.fake.act({ do: 'set', value: { hang: ['CLICK'] } });
    await sleep(150);
    const sentAt = Date.now();
    expect(await click(g, turnId, c.data.capture_id)).toMatchObject({ ok: false, code: 'error' });
    const timedOutAt = Date.now();
    await waitFor(() => !g.e.core.desktop.peek()!.hasProcess(), '시간 초과로 끝낸 도우미');
    // 그 30초는 사람 입력과 가를 수 없다 — 활동 기록 한 줄
    const shot = await g.e.tool(turnId, 'screen_capture', {});
    expect(shot).toMatchObject({ ok: false, code: 'human_active', message: expect.stringContaining('방금 보낸 입력이 들어갔는지 확인하지 못해') });
    expect(view(g).paused).toMatchObject({ by: 'human' });
    expect(g.e.ctx.store.activity.search({ kinds: ['screen'], limit: 30 }).filter((a) => a.text.startsWith('보낸 입력이 들어갔는지 확인하지 못해'))).toHaveLength(1);
    expect(captures(g)).toBe(1);
    // 30초 뒤: 새 도우미의 마지막 입력 시각이 그 입력을 쓴 때와 시간 초과 사이 — 도우미가 답하지 않았으니 그 입력은 사람의 것일 수 있다
    g.fake.set({ hang: [], seedMs: sentAt + Math.floor((timedOutAt - sentAt) / 2) });
    g.clock.advance(HUMAN_PAUSE_MS + 500);
    expect(view(g).paused).toBeNull();
    const shot2 = await g.e.tool(turnId, 'screen_capture', {});
    expect(shot2).toMatchObject({ ok: false, code: 'human_active', message: expect.stringContaining('사람이 마우스·키보드를 쓰고 있어') });
  });

  it('놓기·정지가 실제로 뗀 키의 올림은 앱의 입력이다 — 다음 무장의 시작 값이 그 놓기 때여도 사람 입력 멈춤을 걸지 않는다', async () => {
    // 가짜는 실제 도우미의 GetLastInputInfo처럼 놓기가 뗀 키의 올림을 마지막 입력으로 센다 (seedFromRelease)
    const g = await bootGui({ heldKeys: 2, seedFromRelease: true });
    open.push(g);
    await armed(g);
    // 턴 끝의 RELEASE가 키 2개를 뗀다 — 같은 도우미의 다음 ARM은 그 때를 시작 값으로 답한다
    await endTurn(g);
    expect(serverRows(g)).toEqual([['release', 'ok', '턴 끝: 키·버튼 2개를 뗐습니다']]);
    const next = await liveMain(g.e, '이어서');
    expect((await g.e.tool(next, 'screen_capture', {})).ok).toBe(true);
    const seed = Number(/^seed=(\d+)/.exec(armReplies(g).at(-1)!)![1]);
    expect(Date.now() - seed).toBeLessThan(HUMAN_PAUSE_MS);
    expect(view(g).paused).toBeNull();
    // STOP도 같다: 긴급 정지가 키 2개를 떼고, 새 도우미의 마지막 입력 시각이 그 STOP 때다 (GetLastInputInfo는 서버 PC 전체의 값이다)
    g.fake.act({ do: 'set', value: { heldKeys: 2 } });
    await sleep(150);
    expect((await g.e.core.stops.emergency(OWNER)).completed).toBe(true);
    const ack = g.fake.log().find((x) => x.dir === 'out' && x.line === 'STOP OK 2')!;
    await g.e.idle();
    g.e.core.stops.release(OWNER);
    g.fake.set({ seedFromRelease: false, seedMs: ack.t });
    const third = await liveMain(g.e, '정지 해제 뒤');
    expect((await g.e.tool(third, 'screen_capture', {})).ok).toBe(true);
    expect(armReplies(g).at(-1)).toMatch(new RegExp(`^seed=${ack.t} `));
    expect(view(g).paused).toBeNull();
  });
});

/**
 * 아주 작은 도우미 (이 시험이 임시 폴더에 쓰는 Node 스크립트 — 화면·입력과 상관없다. 검토 3차 R3-1·R3-1b를 옮김). 받은 줄을 기록하고, 가짜 도우미로는 만들 수 없는
 * 한 덩어리의 답을 쓴다. CAPTURE 같은 그 밖의 명령은 ERR INTERNAL (이 시험은 캡처 파일이 필요 없다).
 * - 'hotkey-chunk': 첫 ARM의 답과 HOTKEY를 한 번에 쓴다 — 무장하자마자 사람이 멈춤 단축키를 눌렀다(도우미는 키를 떼고 무장을 풀었다)
 * - 'release-first': 첫 ARM을 붙잡아 두고, 그사이 RELEASE가 오면 RELEASE의 답과 ARM의 답을 그 순서로 한 번에 쓴다 — 도우미는 무장했다 (실제 도우미에서
 *   RELEASE가 읽는 스레드에서 먼저 돌고 실행 스레드가 그 뒤에 무장한 것과 같은 결과)
 */
const TINY_HELPER = `
import { appendFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
const LOG = process.env.TINY_LOG;
const MODE = process.env.TINY_MODE;
const note = (l) => { try { appendFileSync(LOG, JSON.stringify({ pid: process.pid, line: l }) + '\\n'); } catch {} };
note('start');
let arms = 0;
let heldArm = null;
process.stdout.write('READY 3 1 locked=0 wda=1 build=19045\\n');
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  note(line);
  if (line === 'STOP') { process.stdout.write('STOP OK 0\\n'); return; }
  const sp = line.indexOf(' ');
  const id = line.slice(0, sp);
  const verb = line.slice(sp + 1).split(' ')[0];
  if (verb === 'ARM') {
    arms++;
    if (MODE === 'hotkey-chunk' && arms === 1) { process.stdout.write(id + ' OK seed=1 hotkey=1\\nHOTKEY ' + Date.now() + '\\n'); return; }
    if (MODE === 'release-first' && arms === 1 && !existsSync(LOG + '.held')) {
      appendFileSync(LOG + '.held', 'x');
      heldArm = id;
      setTimeout(() => { if (heldArm) { process.stdout.write(heldArm + ' OK seed=1 hotkey=1\\n'); heldArm = null; } }, 1500);
      return;
    }
    process.stdout.write(id + ' OK seed=1 hotkey=1\\n');
    return;
  }
  if (line.endsWith(' RELEASE')) {
    if (heldArm) { process.stdout.write(id + ' OK 0\\n' + heldArm + ' OK seed=1 hotkey=1\\n'); heldArm = null; return; }
    process.stdout.write(id + ' OK 0\\n');
    return;
  }
  if (verb === 'FOCUS') { process.stdout.write(id + ' OK null\\n'); return; }
  process.stdout.write(id + ' ERR INTERNAL tiny\\n');
});
rl.on('close', () => process.exit(0));
`;
const tinyPids: (() => number[])[] = [];
afterEach(() => {
  for (const pids of tinyPids.splice(0)) killFakePids(pids());
});

function tinyLauncher(mode: 'hotkey-chunk' | 'release-first'): { launcher: DesktopHelperLauncher; verbs: (pid?: number) => string[]; pids: () => number[] } {
  const dir = mkdtempSync(join(tmpdir(), 'wook-tinyhelper-'));
  tinyDirs.push(dir);
  const script = join(dir, 'tiny-helper.mjs');
  const log = join(dir, 'in.jsonl');
  writeFileSync(script, TINY_HELPER);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v;
  env.TINY_LOG = log;
  env.TINY_MODE = mode;
  const entries = (): { pid: number; line: string }[] =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as { pid: number; line: string })
      : [];
  const pids = (): number[] => [...new Set(entries().filter((e) => e.line === 'start').map((e) => e.pid))];
  tinyPids.push(pids);
  return {
    launcher: { launch: () => ({ file: process.execPath, args: [script], env }) },
    verbs: (pid) =>
      entries()
        .filter((e) => e.line !== 'start' && (pid === undefined || e.pid === pid))
        .map((e) => e.line.replace(/^\d+ /, '').split(' ')[0]!),
    pids,
  };
}

describe('조작 중 표시와 놓기 표시도 도우미가 보낸 줄의 순서를 따른다 (S6-25 N1 — 검토 3차 R3-1·R3-1b)', () => {
  it('ARM 답과 HOTKEY가 한 덩어리로 오면(무장하자마자 멈춤 단축키) 놓기 표시가 남지 않는다 — 5분 뒤 같은 도우미의 다음 무장 앞에 놓기가 없고 "새 도우미로 먼저 뗌" 기록도 없으며, 조작 중 표시는 그 새 무장의 때다', async () => {
    // 지키는 것: ARM 답을 기다린 쪽이 HOTKEY 뒤에 무장 기록을 다시 세우는 것 — 키를 뗀 도우미에 놓기 표시가 남아 다음 무장이 쓸데없이 놓고 거짓 기록을 남긴다
    const tiny = tinyLauncher('hotkey-chunk');
    const g = await bootGui({}, { helper: { launcher: tiny.launcher } });
    open.push(g);
    const turnId = await liveMain(g.e);
    expect(await g.e.tool(turnId, 'screen_capture', {})).toMatchObject({ ok: false, code: 'human_active' });
    expect(view(g).paused?.by).toBe('local');
    // 도우미는 HOTKEY로 키를 떼고 무장을 풀었다 — 클라이언트도, 놓기 표시도, 조작 중 표시도 (S6-21 J2)
    expect([g.e.core.desktop.peek()!.armed(), markOf(g), view(g).operatingSince]).toEqual([false, null, null]);
    // 멈춤의 5분이 지난 뒤 같은 턴의 다음 캡처 — 같은 도우미가 다시 무장한다
    g.clock.advance(LOCAL_STOP_MS + 1000);
    const rearmedFrom = g.clock.ms();
    // (이 도우미는 CAPTURE를 ERR INTERNAL로 답한다 — 캡처 실패는 훅을 켜 둔다)
    expect((await g.e.tool(turnId, 'screen_capture', {})).ok).toBe(false);
    expect(tiny.pids()).toHaveLength(1);
    expect(tiny.verbs()).toEqual(['ARM', 'ARM', 'CAPTURE']);
    expect(g.e.ctx.store.activity.search({ kinds: ['screen'], level: 'info', limit: 30 }).filter((a) => a.text.startsWith('새 화면 도우미로 눌린 키·버튼을 먼저 뗌'))).toEqual([]);
    // 조작 중 표시는 다시 무장한 때부터다 (첫 무장의 때가 남지 않는다)
    expect(Date.parse(view(g).operatingSince!)).toBeGreaterThanOrEqual(rearmedFrom);
    g.e.hold.delete(MAIN_KEY);
    await endTurn(g);
    assertFakeMain(g.e);
    expect(g.e.specs.every((s) => s.command === 'fake-cli')).toBe(true);
  });

  it('RELEASE의 답 다음 ARM의 답이 한 덩어리로 오면(도우미는 무장했다) 조작 중 표시와 놓기 표시가 남는다 — 그 도우미가 무장한 채 죽으면 다음 도우미에는 ARM보다 RELEASE가 먼저 간다', async () => {
    // 지키는 것: 놓기의 답을 기다린 쪽이 그 뒤의 ARM 답이 세운 무장 기록을 지우는 것 — 무장한 도우미에 표시가 없어, 그 도우미가 키를 누른 채 죽어도 다음 무장이
    // 먼저 놓지 않는다 (S6-21 A4)
    const tiny = tinyLauncher('release-first');
    const g = await bootGui({}, { helper: { launcher: tiny.launcher } });
    open.push(g);
    const turnId = await liveMain(g.e);
    const pending = g.e.tool(turnId, 'screen_capture', {});
    await waitFor(() => tiny.verbs().includes('ARM'), 'ARM 보냄');
    // 같은 턴의 놓기 (슬롯 밖 — 캡처가 슬롯을 쥐고 ARM 답을 기다리는 중)
    expect(await g.e.tool(turnId, 'gui_input', { action: 'release', request_id: rid('n1b') })).toMatchObject({ ok: true });
    await pending;
    const h = g.e.core.desktop.peek()!;
    // 도우미는 무장했다 (ARM 답이 RELEASE 답 뒤) — 클라이언트, 조작 중 표시, 놓기 표시가 모두 그것을 따른다
    expect([h.armed(), view(g).operatingSince !== null, markOf(g)]).toEqual([true, true, expect.objectContaining({ turnId })]);
    // 무장한 그 도우미가 뜻밖에 끝난다 (놓았다는 답 없이)
    const first = tiny.pids()[0]!;
    process.kill(first);
    await waitFor(() => h.pid === null, '도우미 끝남');
    await g.e.tool(turnId, 'screen_capture', {});
    const second = tiny.pids()[1]!;
    expect(tiny.verbs(second).slice(0, 2)).toEqual(['RELEASE', 'ARM']);
    g.e.hold.delete(MAIN_KEY);
    await endTurn(g);
    assertFakeMain(g.e);
    expect(g.e.specs.every((s) => s.command === 'fake-cli')).toBe(true);
  });
});
