/**
 * 메인이 바꾼 실행 설정이 메인 자신을 막지 못한다 (리드 결정 15, 10-29 — owner-surface 재리뷰 high N1, 프로브 zz-s1fix-os-n1-exec-lockout N1·N1b).
 * 실행 설정(execution)은 메인 에이전트만 update_settings로 바꾼다. 범위 밖 값(턴 시간 상한 0 등)이 저장되면 감시가 모든 턴을 곧바로 끊거나 CLI가
 * 실행 값 검사에서 시작을 거부해, 메인은 그 값을 되돌릴 턴을 얻지 못하고 데스크톱에서도 되돌릴 길이 없다.
 * - settings.update(메인의 update_settings·운영자 내부 API가 함께 쓰는 처리기)는 범위 밖·형식이 다른 값·무한대를 invalid로 거부하고 아무것도 저장하지 않는다
 * - 시작 때 저장된 범위 밖 값은 기본값으로 되돌린다 (활동 기록 1줄·정보 알림 1개, 멱등)
 * - update_settings 설명에 단위와 범위, '제한 없음'은 0이 아니라는 안내가 있다. Claude 최대 반복 수의 null(제한 없음)은 그대로 저장된다
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID, type Settings } from '@shared/domain';
import type { TurnLaunch } from '../../src/main/agents/types';
import { createClaudeAdapter } from '../../src/main/agents';
import { TOOL_SPECS } from '../../src/main/mcp/catalog';
import { defaultSettings } from '../../src/main/orchestrator/defaults';
import { EXECUTION_LIMITS } from '../../src/main/orchestrator/settingsPolicy';
import { bootRestartable, sleep, waitUntil, type RestartableEnv } from '../acceptance/stops-helpers';
import { bootOrch, type OrchEnv } from './orchHarness';

let env: RestartableEnv | null = null;
let orchEnv: OrchEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
  await orchEnv?.close();
  orchEnv = null;
});

const errOf = (p: Promise<unknown>): Promise<{ code: string; message: string }> =>
  p.then(
    () => ({ code: 'ok', message: '' }),
    (err: { code?: string; message?: string }) => ({ code: err.code ?? 'error', message: err.message ?? '' }),
  );

const stored = (e: { ctx: RestartableEnv['ctx'] }): Settings => e.ctx.store.kv.get<Settings>('settings')!;

describe('실행 설정은 범위 안의 값만 받는다 (리드 결정 15)', () => {
  it('메인이 턴 시간 상한을 0("제한 없음"으로 이해)으로 두려 하면 invalid로 거부되고 아무것도 저장되지 않는다 — 대표 명령의 메인 턴은 끊기지 않고 끝까지 돈다', async () => {
    env = await bootRestartable();
    const e = env;
    const before = structuredClone(stored(e));
    const seq0 = e.ctx.store.activity.search({ limit: 1 })[0]?.seq ?? 0;
    const r = await errOf(e.main('update_settings', { patch: { execution: { turnTimeoutMin: 0 } }, reason: '대표 요청: 턴 시간 제한 없애기' }));
    expect(r.code).toBe('invalid');
    expect(r.message).toContain('턴 시간 상한(turnTimeoutMin) 0 — 5~1440분');
    expect(r.message).toContain("'제한 없음'은 0이 아닙니다");
    expect(stored(e)).toEqual(before);
    expect(e.ctx.settings().execution.turnTimeoutMin).toBe(60);
    expect(e.ctx.store.activity.search({ text: '운영 설정 변경', limit: 20 }).filter((a) => a.seq > seq0)).toEqual([]);

    // 대표가 다시 명령 → 메인 턴이 뜨고, 감시 주기(100ms)를 여러 번 지나도 시간 상한으로 끊기지 않는다
    e.hold.add('main:general');
    await e.invoke('command.send', { target: 'main', text: '턴 시간 상한을 60분으로 되돌려 줘' });
    e.tick();
    await waitUntil(() => e.launchesOf('main:general').length === 1, '메인 턴 시작');
    const turnId = e.launchesOf('main:general')[0]!.turnId;
    await sleep(700);
    expect(e.core.turns.count()).toBe(1);
    e.liveProc('main:general')!.finishOk();
    await waitUntil(() => e.core.turns.count() === 0, '메인 턴 끝');
    expect(e.ctx.store.turns.get(turnId)?.endReason).toBe('completed');
  });

  it('항목마다 범위 밖·형식이 다른 값(문자열 "0" 등)·무한대·정수 아닌 값·모르는 항목을 메인과 운영자 길 모두 거부하고, 한 항목이라도 틀리면 함께 온 값도 저장하지 않는다', async () => {
    env = await bootRestartable();
    const e = env;
    const bad: [string, unknown][] = [
      ['maxConcurrent', 0],
      ['maxConcurrent', 33],
      ['maxConcurrent', 2.5],
      ['maxConcurrent', '5'],
      ['turnTimeoutMin', 0],
      ['turnTimeoutMin', 4.9],
      ['turnTimeoutMin', 1441],
      ['turnTimeoutMin', '0'],
      ['turnTimeoutMin', '60'],
      ['turnTimeoutMin', -1],
      ['turnTimeoutMin', null],
      ['turnTimeoutMin', Number.POSITIVE_INFINITY],
      ['turnTimeoutMin', Number.NaN],
      ['commandMaxMin', 0],
      ['commandMaxMin', 0.5],
      ['commandMaxMin', 1441],
      ['noOutputMin', 0],
      ['noOutputMin', 0.003],
      ['noOutputMin', 1441],
      ['healthCheckMin', 0],
      ['healthCheckMin', 61],
      ['spinNoProgressMin', 4],
      ['spinNoProgressMin', 1441],
      ['claudeMaxTurns', 0],
      ['claudeMaxTurns', 9],
      ['claudeMaxTurns', 10001],
      ['claudeMaxTurns', 50.5],
      ['claudeMaxTurns', '200'],
      ['crashRetryMax', -1],
      ['crashRetryMax', 11],
      ['crashRetryMax', 1.5],
      ['spinSameErrorCount', 1],
      ['spinSameErrorCount', 101],
      ['spinSameErrorCount', 2.5],
      ['spinNoProgressResumes', -1],
      ['spinNoProgressResumes', 21],
      ['spinNoProgressResumes', 0.5],
      ['preventSleep', 'false'],
      ['preventSleep', 'true'],
      ['preventSleep', 0],
      ['preventSleep', null],
      ['turnTimeout', 60],
    ];
    const before = structuredClone(stored(e));
    const outcomes: string[] = [];
    for (const [k, v] of bad) {
      const byMain = await errOf(e.main('update_settings', { patch: { execution: { [k]: v } } }));
      const byOperator = await errOf(e.internal('settings.update', { execution: { [k]: v } } as never));
      outcomes.push(`${k}=${String(v)}: ${byMain.code}/${byOperator.code}`);
    }
    expect(outcomes).toEqual(bad.map(([k, v]) => `${k}=${String(v)}: invalid/invalid`));
    // execution 자리에 객체가 아닌 값 (통째로 기본값이 되던 길)
    for (const v of [null, 5, [1]]) {
      expect((await errOf(e.main('update_settings', { patch: { execution: v } }))).code).toBe('invalid');
    }
    // 한 항목이 틀리면 같은 요청의 다른 값(범위 안)도 저장하지 않는다
    expect((await errOf(e.main('update_settings', { patch: { execution: { maxConcurrent: 4, turnTimeoutMin: 0 }, general: { backup: { keep: 3 } } } }))).code).toBe('invalid');
    expect(stored(e)).toEqual(before);
    // 긴 문자열 값은 거부 글에 옮기지 않는다 (비밀 값이 섞여 들어와도)
    const long = await errOf(e.main('update_settings', { patch: { execution: { noOutputMin: 'sk-ant-api03-not-a-number-0000' } } }));
    expect(long.code).toBe('invalid');
    expect(long.message).not.toContain('sk-ant-api03');
  });

  it('범위의 양 끝 값은 받고, Claude 최대 반복 수의 null(제한 없음)은 그대로 저장되어 재시작 뒤에도 남는다', async () => {
    env = await bootRestartable();
    let e = env;
    const lows = Object.fromEntries(Object.entries(EXECUTION_LIMITS).map(([k, r]) => [k, r.min]));
    const highs = Object.fromEntries(Object.entries(EXECUTION_LIMITS).map(([k, r]) => [k, r.max]));
    await e.main('update_settings', { patch: { execution: { ...lows, preventSleep: false } } });
    expect(e.ctx.settings().execution).toMatchObject({ ...lows, preventSleep: false });
    await e.main('update_settings', { patch: { execution: { ...highs, preventSleep: true } } });
    expect(e.ctx.settings().execution).toMatchObject({ ...highs, preventSleep: true });
    const r = await e.main('update_settings', { patch: { execution: { claudeMaxTurns: null, turnTimeoutMin: 90 } } });
    expect(r).toMatchObject({ execution: { claudeMaxTurns: null, turnTimeoutMin: 90 } });
    expect(stored(e).execution.claudeMaxTurns).toBeNull();
    env = await e.stopGracefully();
    e = env;
    expect(e.ctx.settings().execution).toMatchObject({ claudeMaxTurns: null, turnTimeoutMin: 90, maxConcurrent: 32 });
  });

  it('메인이 Claude 최대 반복 수를 0으로 두려 하면 거부되고, 다음 메인 턴은 그대로 200을 받아 실제 Claude 어댑터의 실행 값 검사를 통과한다 (N1b)', async () => {
    orchEnv = await bootOrch({ mock: false });
    const e = orchEnv;
    expect(e.ctx.store.members.require(MAIN_AGENT_ID).ai.kind).toBe('claude');
    expect((await errOf(e.main('update_settings', { patch: { execution: { claudeMaxTurns: 0 } }, reason: '대표 요청: 반복 제한 없애기' }))).code).toBe('invalid');
    let launch: TurnLaunch | null = null;
    e.prepareHook = (l, who) => {
      if (who.memberId === MAIN_AGENT_ID && launch === null) launch = l;
    };
    e.hold.add('main:general');
    await e.invoke('command.send', { target: 'main', text: '반복 제한을 200으로 되돌려 줘' });
    e.tick();
    await waitUntil(() => launch !== null, '메인 턴 준비');
    const seen = launch as unknown as TurnLaunch;
    expect(seen.maxTurns).toBe(200);
    const real = createClaudeAdapter({
      resolveExecutable: async () => ({ kind: 'claude', path: 'C:/fake/claude.exe', source: 'path', npmPackageRoot: null, note: '' }),
    });
    const prepared = await real.prepare({ ...seen }).then(
      (p) => p.spec.args.join(' '),
      (err: Error) => `${err.name}: ${err.message}`,
    );
    expect(prepared).toContain('--max-turns 200');
    e.liveProc('main:general')!.finishOk();
    await waitUntil(() => e.core.turns.count() === 0, '메인 턴 끝');
  });

  it('시작 때 저장된 범위 밖 실행 값을 기본값으로 되돌린다 — 범위 안 값은 그대로, 활동 기록 1줄과 정보 알림 1개, 메인 턴이 끊기지 않으며, 다시 시작해도 더 하지 않는다', async () => {
    env = await bootRestartable();
    let e = env;
    // 검사가 생기기 전에 저장된 값 (예전 버전의 DB)
    const s = stored(e);
    e.ctx.store.kv.set('settings', {
      ...s,
      execution: { ...s.execution, turnTimeoutMin: 0, noOutputMin: '0', healthCheckMin: 0, claudeMaxTurns: 0, crashRetryMax: -1, spinSameErrorCount: 1.5, preventSleep: 'yes', maxConcurrent: 7, commandMaxMin: 45 },
    });
    env = await e.stopGracefully();
    e = env;
    const d = defaultSettings().execution;
    expect(e.ctx.settings().execution).toEqual({ ...d, maxConcurrent: 7, commandMaxMin: 45 });
    expect(stored(e).execution).toEqual({ ...d, maxConcurrent: 7, commandMaxMin: 45 });
    const rows = () => e.ctx.store.activity.search({ text: '허용 범위 밖의 실행 설정을 기본값으로 되돌림', limit: 10 });
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ actor: 'system', kind: 'settings' });
    expect(rows()[0]!.text).toContain('턴 시간 상한(turnTimeoutMin) 0 → 60');
    expect(rows()[0]!.text).toContain('응답 없음 기준(noOutputMin) 문자열 "0" → 10');
    expect(rows()[0]!.text).toContain('절전 방지(preventSleep) 문자열 "yes" → true');
    const notes = () => e.ctx.store.notifications.list({ ref1: 'execution-reset' });
    expect(notes().map((n) => [n.level, n.title])).toEqual([['info', '실행 설정을 기본값으로 되돌림']]);

    // 메인 턴은 끊기지 않는다
    e.hold.add('main:general');
    await e.invoke('command.send', { target: 'main', text: '현황 알려 줘' });
    e.tick();
    await waitUntil(() => e.launchesOf('main:general').length === 1, '재시작 뒤 메인 턴 시작');
    await sleep(500);
    expect(e.core.turns.count()).toBe(1);
    e.liveProc('main:general')!.finishOk();
    await waitUntil(() => e.core.turns.count() === 0, '메인 턴 끝');

    // 다시 시작: 되돌릴 것이 없다 (멱등)
    env = await e.stopGracefully();
    e = env;
    expect(rows()).toHaveLength(1);
    expect(notes()).toHaveLength(1);
    expect(e.ctx.settings().execution).toEqual({ ...d, maxConcurrent: 7, commandMaxMin: 45 });
  });

  it('update_settings 설명은 실행 값의 단위와 범위를 적고, "제한 없음"은 0이 아니라고 안내한다', () => {
    expect(EXECUTION_LIMITS).toEqual({
      // 하한 2: 관리 업무 자리 (리드 결정 27 — 결정 15의 1에서 올림)
      maxConcurrent: expect.objectContaining({ min: 2, max: 32, integer: true }),
      turnTimeoutMin: expect.objectContaining({ min: 5, max: 1440, unit: '분' }),
      commandMaxMin: expect.objectContaining({ min: 1, max: 1440, unit: '분' }),
      noOutputMin: expect.objectContaining({ min: 1, max: 1440, unit: '분' }),
      healthCheckMin: expect.objectContaining({ min: 1, max: 60, unit: '분' }),
      spinNoProgressMin: expect.objectContaining({ min: 5, max: 1440, unit: '분' }),
      claudeMaxTurns: expect.objectContaining({ min: 10, max: 10000, integer: true, nullable: true }),
      crashRetryMax: expect.objectContaining({ min: 0, max: 10, integer: true }),
      spinSameErrorCount: expect.objectContaining({ min: 2, max: 100, integer: true }),
      spinNoProgressResumes: expect.objectContaining({ min: 0, max: 20, integer: true }),
    });
    const desc = TOOL_SPECS.find((t) => t.name === 'update_settings')!.description;
    for (const k of Object.keys(EXECUTION_LIMITS)) expect(desc).toContain(`${k} `);
    expect(desc).toContain('turnTimeoutMin 5~1440분');
    expect(desc).toContain('healthCheckMin 1~60분');
    expect(desc).toContain('claudeMaxTurns 10~10000번 정수 또는 null(제한 없음)');
    expect(desc).toContain('maxConcurrent 2~32개 정수');
    expect(desc).toContain('preventSleep true·false');
    expect(desc).toContain('문자열 "0"');
    expect(desc).toContain("'제한 없음'은 0이 아닙니다");
  });
});
