/**
 * CPU 상한 (대표 지시 2026-11-18: "최상단 메인봇은 … 컴퓨터 건드리잖아 이과정에서 cpu95%를 넘는 작업은 못하도록 해줘 넘을거같으면 딜레이하고").
 * - 이 PC의 CPU 사용률이 95% 이상이면 프로그램이 새 일을 얹지 않는다: 스케줄러는 새 팀 턴을 띄우지 않고, host_exec는 명령을 띄우지 않고 기다린다.
 *   높다고 돌려보내지 않는다(같은 날 대표 지시 "돌려보내진 말고 딜레이했다가 나중에 작업") — 내려가면 이어서 한다.
 * - 메인 에이전트의 턴은 그대로 뜬다 — 대표의 명령·정지에 답해야 한다.
 * - 사용률을 모르면(측정기 없음, 처음 몇 초) 미루지 않는다.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID } from '../../src/shared/domain';
import { CPU_LIMIT_PERCENT } from '../../src/main/orchestrator/cpuGuard';
import type { OrchEnv } from './orchHarness';
import { bootOrch, seedDirective } from './orchHarness';
import { hostExec, hostRecords, liveMainTurn, okData, scriptedHost } from './hostExecRig';

let env: OrchEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const records = (e: OrchEnv, text: string): string[] => e.ctx.store.activity.search({ text, limit: 20 }).map((r) => r.text);
const HELD = '새 팀 턴의 시작을 미룹니다';
const RESUMED = '미뤘던 팀 턴을 다시 시작합니다';
/** 개발자에게 작업 하나를 만든다 — 스케줄러가 그 작업 턴을 띄울 차례다 */
function devTask(e: OrchEnv): string {
  const d = seedDirective(e);
  return e.core.tasks.create({ directiveId: d.id, title: '구현', goal: '목표', type: 'development', assigneeId: e.devId, acceptanceCriteria: ['동작'], outputMode: 'repo' }, e.producerId).id;
}
const taskLaunches = (e: OrchEnv, taskId: string) => e.launches.filter((l) => l.workKey === `task:${taskId}`);

describe('스케줄러 — CPU가 상한 이상이면 새 팀 턴을 띄우지 않는다', () => {
  it('미루는 동안 팀원 작업 턴이 뜨지 않고 활동 기록은 한 줄이다. 내려가면 띄우고 풀림을 적는다', async () => {
    const load = { value: 97 as number | null };
    env = await bootOrch({ cpuLoad: () => load.value });
    const e = env;
    const taskId = devTask(e);
    for (let i = 0; i < 3; i++) await e.drain(1);
    expect(taskLaunches(e, taskId)).toHaveLength(0);
    expect(e.launches.filter((l) => l.memberId !== MAIN_AGENT_ID)).toHaveLength(0);
    expect(e.ctx.store.tasks.require(taskId).state).toBe('waiting');
    const held = records(e, HELD);
    expect(held).toHaveLength(1);
    expect(held[0]).toContain(`서버 PC의 CPU 사용률이 97%입니다(상한 ${CPU_LIMIT_PERCENT}%)`);
    expect(records(e, RESUMED)).toHaveLength(0);

    load.value = 60;
    await e.drain(1);
    expect(taskLaunches(e, taskId)).toHaveLength(1);
    const resumed = records(e, RESUMED);
    expect(resumed).toHaveLength(1);
    expect(resumed[0]).toContain('서버 PC의 CPU 사용률이 60%로 내려가');
    expect(records(e, HELD)).toHaveLength(1);
  });

  it('상한은 95%부터다 — 94%면 미루지 않고, 사용률을 모르면(null) 미루지 않는다', async () => {
    const load = { value: 95 as number | null };
    env = await bootOrch({ cpuLoad: () => load.value });
    const e = env;
    const a = devTask(e);
    await e.drain(1);
    expect(taskLaunches(e, a)).toHaveLength(0);
    load.value = 94;
    await e.drain(1);
    expect(taskLaunches(e, a)).toHaveLength(1);

    await env.close();
    env = await bootOrch({ cpuLoad: () => null });
    const b = devTask(env);
    await env.drain(1);
    expect(taskLaunches(env, b)).toHaveLength(1);
    expect(records(env, HELD)).toHaveLength(0);
  });

  it('프로듀서의 관리 턴도 미룬다', async () => {
    const load = { value: 100 as number | null };
    env = await bootOrch({ mock: false, cpuLoad: () => load.value });
    const e = env;
    e.core.directives.register({ projectId: e.projectId, title: '지시', text: '로그인 화면' }, MAIN_AGENT_ID, null);
    await e.drain(1);
    expect(e.launches.filter((l) => l.memberId === e.producerId)).toHaveLength(0);
    load.value = 10;
    await e.drain(1);
    expect(e.launches.filter((l) => l.memberId === e.producerId)).toHaveLength(1);
  });

  it('메인 에이전트의 턴은 CPU가 높아도 뜬다 — 미룬 팀 턴이 없으면 기록도 없다', async () => {
    env = await bootOrch({ cpuLoad: () => 100 });
    const e = env;
    await e.invoke('command.send', { target: 'main', text: '상태 알려줘' });
    await e.drain(1);
    expect(e.launches.filter((l) => l.memberId === MAIN_AGENT_ID)).toHaveLength(1);
    expect(records(e, HELD)).toHaveLength(0);
  });
});

describe('host_exec — CPU가 높으면 돌려보내지 않고, 내려갈 때까지 미뤘다가 실행한다', () => {
  const DELAYED = '메인 에이전트 서버 명령을 미룸';

  it('높은 동안에는 명령을 띄우지 않고 기다린다 — 거부하지 않는다. 내려가면 실행하고 미룬 시간을 돌려준다', async () => {
    const load = { value: 99 as number | null };
    env = await bootOrch({ workspace: true, cpuLoad: () => load.value, cpuPollMs: 20 });
    const e = env;
    const { turnId } = await liveMainTurn(e);
    scriptedHost(e, { code: 0 });
    let settled = false;
    const call = hostExec(e, turnId, { command: 'npm run build' }).finally(() => (settled = true));
    await new Promise((done) => setTimeout(done, 300));
    // 한참 높아도 돌려보내지 않았고 아직 띄우지 않았다 — 실행 기록도 없다
    expect(settled).toBe(false);
    expect(e.hostSpecs).toHaveLength(0);
    expect(hostRecords(e)).toHaveLength(0);
    const noted = records(e, DELAYED);
    expect(noted).toHaveLength(1);
    expect(noted[0]).toContain(`서버 PC의 CPU 사용률이 99%입니다(상한 ${CPU_LIMIT_PERCENT}%). 내려가면 실행합니다`);

    load.value = 40;
    const r = okData(await call);
    expect(r.exit_code).toBe(0);
    expect(r.cpu_delayed_ms).toBeGreaterThanOrEqual(250);
    expect(e.hostSpecs).toHaveLength(1);
    expect(records(e, DELAYED)).toHaveLength(1);
  });

  it('CPU가 상한 아래면 미루지 않는다 — 기록도 cpu_delayed_ms도 없다', async () => {
    env = await bootOrch({ workspace: true, cpuLoad: () => 94, cpuPollMs: 5000 });
    const e = env;
    const { turnId } = await liveMainTurn(e);
    scriptedHost(e, { code: 0 });
    const t0 = Date.now();
    const r = okData(await hostExec(e, turnId, { command: 'echo ok' }));
    expect(r.exit_code).toBe(0);
    expect(r).not.toHaveProperty('cpu_delayed_ms');
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(records(e, DELAYED)).toHaveLength(0);
  });

  it('미루는 사이 긴급 정지가 오면 더 기다리지 않고 정지로 거부한다 — 명령은 돌지 않는다', async () => {
    env = await bootOrch({ workspace: true, cpuLoad: () => 100, cpuPollMs: 20 });
    const e = env;
    const { turnId } = await liveMainTurn(e);
    scriptedHost(e, { code: 0 });
    const call = hostExec(e, turnId, { command: 'npm run build' });
    await new Promise((done) => setTimeout(done, 100));
    await e.invoke('stop.emergency');
    const r = await call;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('stopped');
    expect(e.hostSpecs).toHaveLength(0);
  });
});

describe('get_overview — 메인 에이전트가 지금 CPU를 본다', () => {
  it('cpu 칸에 최근 사용률·상한·미루는지가 있다', async () => {
    const load = { value: 97.4 as number | null };
    env = await bootOrch({ cpuLoad: () => load.value });
    const e = env;
    expect((await e.main('get_overview')).cpu).toEqual({ percent: 97, limit: CPU_LIMIT_PERCENT, holding: true });
    load.value = 12.6;
    expect((await e.main('get_overview')).cpu).toEqual({ percent: 13, limit: CPU_LIMIT_PERCENT, holding: false });
  });

  it('측정기가 없으면 모른다고 하고 미루지 않는다', async () => {
    env = await bootOrch();
    expect((await env.main('get_overview')).cpu).toEqual({ percent: null, limit: CPU_LIMIT_PERCENT, holding: false });
  });
});
