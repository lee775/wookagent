/**
 * 에이전트의 긴급 정지 되풀이 (SERVER_DESIGN 4.5 '정지'·6.1, 리드 결정 S7-12 1·S7-17 A3 — 검토 agent-security 3, 그 검토의 S2):
 * - 등록·폐기되지 않은 키면 자리에 앉지 않은 에이전트도 `POST stop`을 건다 (S7-12 1). 처음 건 정지는 메인 일지에 그 에이전트를 적는다
 *   ('외부 에이전트 <이름>(<ID>)이 긴급 정지 — …')
 * - 이미 정지 중이면 정지를 다시 돌리지 않고 그 정지의 요약을 돌려준다 — 처음 건 쪽(global.by)은 그대로, 메인 일지·알림은 늘지 않고, 활동 기록은 한 정지에 한 줄만.
 *   예전에는 부를 때마다 정지 전체를 다시 돌려 활동 기록 3줄·일지 1줄씩이 쌓이고 global.by가 마지막 호출자로 바뀌었다
 * - 같은 때 온 두 에이전트의 정지도 한 번만 돈다. 대표가 정지 중에 다시 누르면 예전대로 다시 돈다(앞 정지가 끝내지 못한 실행을 다시 끝낸다)
 * 메인 턴은 모두 모의 실행이다(externalRig close()가 확인한다)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID, OWNER } from '@shared/domain';
import type { EmergencySummary } from '@shared/views';
import { agentCall, bootExternal, until, type ExternalEnv } from './externalRig';

let x: ExternalEnv;
let seated = '';
let other = '';

beforeAll(async () => {
  x = await bootExternal({});
  seated = x.operator.addExternalAgent('그록봇').key;
  other = x.operator.addExternalAgent('감마').key;
  await x.operator.assignSeat('external:X-0001', true);
  await until(() => x.h.core.turns.count() === 0, '시작 일이 끝남');
}, 120_000);

afterAll(async () => {
  await x?.close();
});

const counts = (): { activity: number; stopRows: number; journal: number; notices: number } => {
  const ctx = x.h.core.ctx;
  return {
    activity: ctx.store.activity.search({ limit: 100_000 }).length,
    stopRows: ctx.store.activity.search({ kinds: ['stop'], limit: 100_000 }).length,
    journal: ctx.store.journal.count({ kinds: ['stop'] }),
    notices: ctx.store.notifications.list().length,
  };
};
const stopJournal = (): string[] => x.h.core.ctx.store.journal.query({ kinds: ['stop'], limit: 50 }).map((r) => r.text);
const stopBy = (): string | null => x.h.core.ctx.stop().global.by;
const stopOf = async (key: string): Promise<{ status: number; summary: EmergencySummary }> => {
  const r = await agentCall(x.api, key, '/stop', { body: {} });
  const { ok: _ok, ...summary } = r.json<EmergencySummary & { ok: boolean }>();
  return { status: r.status, summary };
};

describe('externalStopRepeat — 이미 정지 중인 에이전트의 정지는 다시 돌지 않는다 (S7-17 A3)', () => {
  it('앉지 않은 에이전트의 첫 정지는 일지에 그 에이전트를 적고, 되풀이 9번은 정지를 다시 돌리지 않는다 — 요약 그대로, by 그대로, 일지·알림 그대로, 활동 기록은 한 줄', async () => {
    const c0 = counts();
    const first = await stopOf(other);
    expect(first.status).toBe(200);
    expect(stopBy()).toBe('system');
    const c1 = counts();
    // 첫 정지: 요청 한 줄 + 정지의 두 줄(실행·끝), 일지 한 줄, 알림 한 건
    expect([c1.stopRows - c0.stopRows, c1.journal - c0.journal]).toEqual([3, 1]);
    expect(stopJournal()[0]).toBe('외부 에이전트 감마(X-0002)가 긴급 정지 — 턴 0개를 끝내고 작업 0개를 보류함');

    const again: { status: number; summary: EmergencySummary }[] = [];
    for (let i = 0; i < 9; i += 1) again.push(await stopOf(other));
    // 자리에 앉은 에이전트도 정지 중에는 같은 요약을 받고, 처음 건 쪽을 바꾸지 않는다
    again.push(await stopOf(seated));
    expect(again.map((a) => a.status)).toEqual(Array(10).fill(200));
    for (const a of again) expect(a.summary).toEqual(first.summary);
    const c2 = counts();
    expect({ stopRows: c2.stopRows - c1.stopRows, other: c2.activity - c1.activity - (c2.stopRows - c1.stopRows), journal: c2.journal - c1.journal, notices: c2.notices - c1.notices }).toEqual({
      stopRows: 1,
      other: 0,
      journal: 0,
      notices: 0,
    });
    expect(x.h.core.ctx.store.activity.search({ kinds: ['stop'], limit: 1 })[0]!.text).toBe(
      '외부 에이전트가 이미 긴급 정지 중에 다시 정지를 요청함: 감마(X-0002) — 정지를 다시 돌리지 않고 그 요약을 돌려줌 (이 정지 동안의 다음 요청은 적지 않음)',
    );
    expect(stopBy()).toBe('system');

    // 대표가 정지 중에 다시 누르면 예전대로 다시 돈다 — 일지 한 줄('대표가 긴급 정지'), 건 쪽은 대표
    await x.owner$('stop.emergency');
    expect(stopJournal()[0]).toBe('대표가 긴급 정지 — 턴 0개를 끝내고 작업 0개를 보류함');
    expect(counts().journal - c2.journal).toBe(1);
    expect(stopBy()).toBe(OWNER);
    await x.owner$('stop.release');
    expect(x.h.core.ctx.stop().global.active).toBe(false);
  }, 120_000);

  it('정지를 풀면 다시 처음부터 — 같은 때 온 두 에이전트의 정지는 한 번만 돌고 둘 다 같은 요약을 받는다', async () => {
    const c0 = counts();
    const [a, b] = await Promise.all([stopOf(seated), stopOf(other)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(a.summary).toEqual(b.summary);
    const c1 = counts();
    expect(c1.journal - c0.journal).toBe(1);
    // 요청 한 줄 + 정지의 두 줄, 늦게 온 쪽의 한 줄
    expect(c1.stopRows - c0.stopRows).toBe(4);
    expect(stopJournal()[0]).toMatch(/^외부 에이전트 (그록봇\(X-0001\)이|감마\(X-0002\)가) 긴급 정지 — /);
    expect([MAIN_AGENT_ID, 'system']).toContain(stopBy());
    await x.owner$('stop.release');
  }, 120_000);

  it('첫 정지가 아직 도는 동안 온 정지(같은 차례 — 에이전트 API가 부르는 Backend.agents.stop을 잇달아)는 그 정지의 결과를 기다려 받는다 — 정지는 한 번만 돈다', async () => {
    const agents = x.h.orch.backend.agents!;
    const c0 = counts();
    const first = agents.stop('X-0001');
    // 첫 정지는 저장(정지 값)까지 마쳤고 요약은 아직이다 — 그사이 온 정지
    expect(x.h.core.ctx.stop().global.active).toBe(true);
    const second = agents.stop('X-0002');
    const [a, b] = await Promise.all([first, second]);
    expect(b).toEqual(a);
    const c1 = counts();
    // 정지가 두 번 돌았으면 일지가 두 줄이다
    expect(c1.journal - c0.journal).toBe(1);
    expect(stopJournal()[0]).toBe('외부 에이전트 그록봇(X-0001)이 긴급 정지 — 턴 0개를 끝내고 작업 0개를 보류함');
    expect(stopBy()).toBe(MAIN_AGENT_ID);
    await x.owner$('stop.release');
  }, 120_000);
});
