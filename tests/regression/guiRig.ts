/**
 * 화면 조작 시험 도우미 (리드 결정 S6-6·S6-7·S6-10, S6b): 가짜 화면 도우미(tests/fixtures/desktop — 화면을 찍거나 입력을 보내지 않는다)를 붙인 오케스트레이터와
 * 메인 대화 턴 하나. 처리기는 그 턴의 신원으로 부른다(앱 도구 서버 없이). 시계는 실제 시계에 덧붙인 차이 — 30초 유효 시간을 앞당겨 본다
 */
import type { Clock } from '@core/time';
import { MAIN_AGENT_ID } from '@shared/domain';
import { createFakeDesktop, type FakeDesktop, type FakeDesktopScenario } from '../fixtures/desktop/fakeDesktop';
import type { ToolCallResult } from '../../src/main/mcp/types';
import type { ScreenCaptureResult } from '../../src/main/mcp/catalog';
import type { DesktopDeps } from '../../src/main/desktop/service';
import type { ScreenLimits } from '../../src/main/desktop/safety';
import { bootOrch, waitFor, type OrchEnv, type OrchOptions } from './orchHarness';

export const MAIN_KEY = 'main:general';

/** 실제 시계 + 차이 (advance로 앞당긴다) */
export function offsetClock(): Clock & { advance(ms: number): void } {
  let off = 0;
  return {
    now: () => new Date(Date.now() + off),
    iso: () => new Date(Date.now() + off).toISOString(),
    ms: () => Date.now() + off,
    advance(ms: number) {
      off += ms;
    },
  };
}

export interface GuiEnv {
  e: OrchEnv;
  fake: FakeDesktop;
  clock: ReturnType<typeof offsetClock>;
  close(): Promise<void>;
}

/** 횟수 상한을 보지 않는 시험의 넉넉한 상한 (시험 이음매 DesktopDeps.limits) — 상한 자체는 guiRateLimit이 코드 상한 그대로 본다 */
export const LOOSE_LIMITS: ScreenLimits = { inputPerSec: 10_000, inputPerMin: 1_000_000, capturePerSec: 10_000, capturePerTurn: 1_000_000, infoPerSec: 10_000 };

export interface GuiOptions extends OrchOptions {
  vision?: 'verified' | 'failed' | 'unknown' | 'keep';
  /** 'code'면 코드 상한 그대로 (기본은 넉넉한 상한 — 빠르게 이어 부르는 시험이 횟수 상한에 걸리지 않게) */
  limits?: 'code' | Partial<ScreenLimits>;
  /** 화면 도우미 의존성에 더할 것 (시간 상한·끝내기 이음매·사전 점검의 확인 등) */
  helper?: Partial<DesktopDeps>;
  /** 이미 있는 가짜 도우미를 쓴다 (같은 데이터로 다시 띄우는 시험) */
  fake?: FakeDesktop;
}

/**
 * 가짜 도우미를 붙여 띄운다 (시나리오는 다음 띄우기부터). 띄우면 첫 보유자의 화면 확인 업무가 들어가 하네스의 가짜 CLI가 답 없이 끝낼 수 있다 — vision을 주면
 * 그 턴이 끝난 뒤 남은 확인 업무를 지우고 자리의 vision을 그 값으로 둔다 (화면 조작 시험의 출발점을 정한다). 'keep'이면 그대로.
 * 하네스의 메인 턴은 가짜 CLI다(orchHarness의 가짜 어댑터) — 실제 CLI는 뜨지 않는다. 띄운 뒤 그것을 확인한다 (리드 결정 S6-19)
 */
export async function bootGui(scenario: Partial<FakeDesktopScenario> = {}, o: GuiOptions = {}): Promise<GuiEnv> {
  const fake = o.fake ?? createFakeDesktop(scenario);
  const clock = offsetClock();
  const { vision = 'verified', limits, helper, fake: _given, ...rest } = o;
  void _given;
  const e = await bootOrch({
    clock,
    ...rest,
    desktop: { launcher: fake.launcher, timeouts: { READY: 5000 }, ...(limits === 'code' ? {} : { limits: { ...LOOSE_LIMITS, ...(limits ?? {}) } }), ...(helper ?? {}) },
  });
  assertFakeMain(e);
  await e.idle('첫 화면 확인 턴');
  if (vision !== 'keep') {
    const ctx = e.ctx;
    for (const q of ctx.store.queue.list({ ref2: MAIN_KEY, state: 'queued' })) if (q.kind === 'screen_check') ctx.store.queue.put({ ...q, state: 'cancelled', doneAt: ctx.now() });
    const seat = ctx.store.seat.require('main');
    ctx.store.seat.put({ ...seat, vision, visionModel: null, visionAt: null });
  }
  return {
    e,
    fake,
    clock,
    async close() {
      await e.close();
      await fake.cleanup();
    },
  };
}

/**
 * 이 하네스가 띄운 메인 턴은 모두 가짜 CLI다 — 실제 Claude·Codex CLI가 뜨면 사용량이 든다 (리드 결정 S6-19: 백엔드를 띄우는 시험은 메인이 실제 CLI가 아닌 것을
 * 확인한다). orchHarness는 어댑터 셋을 모두 가짜로 넣고 러너도 가짜라, 띄운 프로세스는 FakeProc뿐이다
 */
export function assertFakeMain(e: OrchEnv): void {
  for (const kind of ['claude', 'codex', 'mock'] as const) {
    const a = e.ctx.deps.adapters[kind] as { kind: string; prepare: (...args: never[]) => unknown };
    if (!String(a.prepare).includes('fake-cli')) throw new Error(`화면 조작 시험: ${kind} 어댑터가 가짜가 아닙니다 — 실제 CLI를 띄울 수 있습니다`);
  }
  if (e.ctx.deps.runner.detail !== '회귀 테스트: 가짜 러너') throw new Error('화면 조작 시험: 러너가 가짜가 아닙니다');
}

/** 메인 대화 턴을 띄워 실행 중으로 둔다 */
export async function liveMain(e: OrchEnv, text = '서버 PC 화면을 봐 줘'): Promise<string> {
  e.hold.add(MAIN_KEY);
  await e.invoke('command.send', { target: 'main', text });
  e.tick();
  await waitFor(() => !!e.liveProc(MAIN_KEY, MAIN_AGENT_ID), '메인 턴 시작');
  return e.liveProc(MAIN_KEY, MAIN_AGENT_ID)!.turnId;
}

let rq = 0;
export const rid = (tag = 'gui'): string => `rq-${tag}-${++rq}`;

export function ok<T = Record<string, unknown>>(r: ToolCallResult): T {
  if (!r.ok) throw new Error(`거부: ${r.code} ${r.message}`);
  return r.data as T;
}

export async function capture(e: OrchEnv, turnId: string, args: Record<string, unknown> = {}): Promise<{ r: ToolCallResult; data: ScreenCaptureResult }> {
  const r = await e.tool(turnId, 'screen_capture', args);
  return { r, data: ok<ScreenCaptureResult>(r) };
}

export function input(e: OrchEnv, turnId: string, args: Record<string, unknown>): Promise<ToolCallResult> {
  return e.tool(turnId, 'gui_input', { request_id: rid(), then_capture: false, ...args });
}

/** 가짜 도우미가 받은 입력 명령 (번호 빼고) */
export function inputLines(fake: FakeDesktop): string[] {
  return fake
    .received()
    .map((l) => l.replace(/^\d+ /, ''))
    .filter((l) => /^(MOVE|CLICK|DRAG|SCROLL|KEY|TYPE) /.test(l));
}
