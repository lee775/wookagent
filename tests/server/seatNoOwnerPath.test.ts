/**
 * 대표의 길로는 메인 자리가 바뀌지 않는다 (SERVER_DESIGN 4.3·10.4 seatNoOwnerPath, 리드 결정 S4-2·S4-7·S4-9·S4-11):
 * - 대표 메서드(OWNER_METHODS 41개)를 데스크톱 IPC 길과 서버 HTTP 길로 모두 불러도 자리(세대·상태·보유자·이력·인계 꾸러미)와 M-MAIN의 AI는 그대로다.
 *   '메인을 넘겨' 같은 글을 명령·답변·수정 요청에 넣어도 자리를 바꾸는 것은 메인 에이전트의 판단이다 (스케줄러를 멈춰 메인 턴은 뜨지 않는다)
 * - 자리를 바꾸는 대표 메서드는 없다: seat.*는 보기 셋뿐이고, 바꾸는 이름(seat.assign 등)은 두 길 모두 거부된다
 * - 원격 길의 settings.update는 메인 AI·자리 정책을 거부한다. 자리 정책(seat.*)은 데스크톱 운영자 설정에도 없다
 * - 데스크톱의 메인 AI(general.mainAgent)는 그 PC 운영자의 배정이다 (S4-9) — 자리 이력에 운영자로 남는다. 바꾼 쪽에 대표는 없다
 * - 보기 메서드 넷은 로그인해야 부른다 — 로그인하지 않은 원격 호출자는 예전의 unauthorized 거부를 받는다 (S4-11)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID } from '@shared/domain';
import { IPC_METHODS, OWNER_METHODS, type OwnerMethod } from '@shared/ipc';
import { createHarness, type Harness } from '../e2e/harness';
import { createInvokeCore } from '../../src/main/backend/invokeCore';
import { startServer, type RunningServer } from '../../src/server/server';
import { invokeHttp, memoryLogger, remoteBackendOf } from './helpers';
import { TEST_OWNER_RECORD } from './ownerServer';

let h: Harness;
let server: RunningServer;
let token = '';
const log = memoryLogger();

beforeAll(async () => {
  h = await createHarness({ team: ['developer'] });
  // 대표 명령이 메인 턴을 띄우지 않게 — 자리를 바꿀 수 있는 것이 대표의 호출뿐이게
  h.core.scheduler.stop();
  h.core.ctx.store.kv.set('owner', { ...TEST_OWNER_RECORD, registeredAt: h.core.ctx.now(), lastLoginAt: null });
  server = await startServer({ backend: remoteBackendOf(h), dataDir: h.dataDir, port: 0, allowTestSession: false, logger: log, version: 'test' });
  token = h.core.deviceSessions.issue({ deviceName: '자리 시험' }).token;
}, 120_000);

afterAll(async () => {
  await server?.close();
  await h?.close();
});

/** 자리에 관한 모든 것 — 이것이 바뀌면 자리가 바뀐 것이다 */
const fingerprint = (): string => {
  const ctx = h.core.ctx;
  return JSON.stringify({
    seat: ctx.store.seat.get('main'),
    history: ctx.store.seatHistory.list(),
    packets: ctx.store.seatHandovers.list(),
    mainAi: ctx.store.members.require(MAIN_AGENT_ID).ai,
    mainAgent: ctx.settings().general.mainAgent,
  });
};

const CODEX = { kind: 'codex', model: null, effortTier: 'high', effortOverride: null } as const;
const ASK = 'Codex에게 메인을 넘겨';

/** 대표 메서드마다 부를 인자와 길 — 브라우저를 여는 데스크톱 로그인, 구글에 묻는 원격 기기 코드 로그인 시작은 한 길에서만 */
const CALLS: [OwnerMethod, unknown[], ('ipc' | 'http')[]][] = [
  ['auth.getState', [], ['ipc', 'http']],
  ['auth.login', [], ['http']],
  ['auth.deviceLogin', ['자리 시험'], ['ipc']],
  ['auth.deviceLoginPoll', ['dl_none'], ['ipc', 'http']],
  ['auth.setupOwner', ['ABCD-EFGH', 'owner@example.com'], ['ipc', 'http']],
  ['auth.listDevices', [], ['ipc', 'http']],
  ['auth.revokeDevice', ['ds_none'], ['ipc', 'http']],
  ['snapshot.get', [], ['ipc', 'http']],
  ['members.getDetail', [MAIN_AGENT_ID], ['ipc', 'http']],
  ['members.getEvents', [MAIN_AGENT_ID, { limit: 5 }], ['ipc', 'http']],
  ['command.send', [{ target: 'main', text: ASK }], ['ipc', 'http']],
  ['command.history', ['main', {}], ['ipc', 'http']],
  ['directives.get', ['D-9999'], ['ipc', 'http']],
  ['tasks.get', ['T-9999'], ['ipc', 'http']],
  ['tasks.getDiff', ['T-9999'], ['ipc', 'http']],
  ['questions.answer', ['Q-9999', ASK], ['ipc', 'http']],
  ['reports.list', [{}], ['ipc', 'http']],
  ['reports.get', ['R-9999'], ['ipc', 'http']],
  ['reports.markRead', ['R-9999'], ['ipc', 'http']],
  ['reports.approve', ['R-9999', ASK], ['ipc', 'http']],
  ['reports.requestChanges', ['R-9999', { overall: ASK, anchored: [] }], ['ipc', 'http']],
  ['notifications.list', [{ limit: 5 }], ['ipc', 'http']],
  ['notifications.markRead', ['all'], ['ipc', 'http']],
  ['stop.emergency', [], ['ipc', 'http']],
  ['stop.release', [], ['ipc', 'http']],
  ['seat.get', [], ['ipc', 'http']],
  ['seat.history', [], ['ipc', 'http']],
  ['seat.handover', [1], ['ipc', 'http']],
  ['journal.list', [{ limit: 10 }], ['ipc', 'http']],
  ['recovery.list', [], ['ipc', 'http']],
  ['settings.get', [], ['ipc', 'http']],
  ['roles.list', [], ['ipc', 'http']],
  ['skills.list', [], ['ipc']],
  ['logs.search', [{ limit: 5 }], ['ipc', 'http']],
  ['logs.export', [{ limit: 5 }], ['ipc', 'http']],
  ['system.prereqs', [], ['ipc', 'http']],
  ['system.info', [], ['ipc', 'http']],
  ['system.recheckAi', ['codex'], ['ipc', 'http']],
  ['system.pickFiles', [], ['ipc', 'http']],
  ['system.openPath', [], ['ipc', 'http']],
  // 마지막에 로그아웃 (그 뒤 로그인이 필요한 호출은 거부된다)
  ['auth.logout', [], ['ipc', 'http']],
];

describe('대표의 길로는 메인 자리가 바뀌지 않는다 (seatNoOwnerPath)', () => {
  it('자리를 바꾸는 대표 메서드는 없다 — seat.*는 보기 셋, 일지는 보기 하나', () => {
    expect(IPC_METHODS.filter((m) => m.startsWith('seat.') || m.startsWith('journal.'))).toEqual(['seat.get', 'seat.history', 'seat.handover', 'journal.list']);
    expect(OWNER_METHODS.filter((m) => m.startsWith('seat.') || m.startsWith('journal.'))).toEqual(['seat.get', 'seat.history', 'seat.handover', 'journal.list']);
    // 시험이 대표 메서드를 하나도 빠뜨리지 않는다
    expect([...new Set(CALLS.map(([m]) => m))].sort()).toEqual([...OWNER_METHODS].sort());
  });

  it('보기 메서드 넷은 로그인해야 부른다 — 로그인하지 않은 원격 호출자는 unauthorized (S4-11)', async () => {
    for (const [m, args] of [
      ['seat.get', []],
      ['seat.history', []],
      ['seat.handover', []],
      ['journal.list', [{}]],
    ] as const) {
      const r = await invokeHttp(server.url, null, m, [...args]);
      expect([m, r.status, r.json<{ error: { code: string } }>().error.code]).toEqual([m, 401, 'unauthorized']);
    }
    // 로그인한 대표는 지금 자리와 일지를 본다 — 일지에는 처음 보유자가 앉은 서버 기록 한 줄이 있다 (S4b)
    const seat = await invokeHttp(server.url, token, 'seat.get', []);
    expect(seat.json<{ ok: boolean; value: { generation: number; holder: { label: string } } }>()).toMatchObject({ ok: true, value: { generation: 1, holder: { label: 'Claude CLI' } } });
    expect(await (await invokeHttp(server.url, token, 'journal.list', [{}])).json<{ value: unknown }>().value).toMatchObject({
      entries: [{ author: 'server', kind: 'seat', generation: 1, holderLabel: 'Claude CLI', text: expect.stringContaining('메인 자리에 Claude CLI가 앉음 (세대 1, 서버)') }],
      nextCursor: null,
    });
  });

  it('바꾸는 이름과 원격의 설정 바꾸기는 두 길 모두 거부되고, 자리 정책은 데스크톱 운영자 설정에도 없다', async () => {
    const invokeIpc = createInvokeCore({ backend: h.orch.backend, logger: log, channel: 'IPC' });
    const before = fingerprint();
    const refusedIpc: string[] = [];
    const refusedHttp: string[] = [];
    for (const m of ['seat.assign', 'seat.handOff', 'seat.set', 'seat.release', 'seat.claim', 'journal.write']) {
      if (!(await invokeIpc(m, [{ to: 'codex' }])).ok) refusedIpc.push(m);
      if (!(await invokeHttp(server.url, token, m, [{ to: 'codex' }])).json<{ ok: boolean }>().ok) refusedHttp.push(m);
    }
    expect(refusedIpc).toHaveLength(6);
    expect(refusedHttp).toHaveLength(6);
    for (const patch of [{ general: { mainAgent: CODEX } }, { seat: { holders: ['launched:codex'] } }, { seat: { drainMs: 0 } }]) {
      const r = await invokeHttp(server.url, token, 'settings.update', [patch]);
      expect([r.status, r.json<{ error: { code: string } }>().error.code]).toEqual([403, 'forbidden']);
    }
    const ipcSeat = await invokeIpc('settings.update', [{ seat: { holders: ['launched:codex'] } }]);
    expect(ipcSeat).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    expect(fingerprint()).toBe(before);
    expect(h.core.seat.policy().holders).toEqual(['launched:claude', 'launched:codex', 'external:*']);
  });

  it('대표 메서드 41개를 데스크톱 IPC와 서버 HTTP로 모두 불러도 자리는 그대로다', async () => {
    const invokeIpc = createInvokeCore({ backend: h.orch.backend, logger: log, channel: 'IPC' });
    const before = fingerprint();
    const changed: string[] = [];
    const called: string[] = [];
    for (const [method, args, surfaces] of CALLS) {
      if (method === 'system.openPath') args.push(h.dataDir);
      for (const surface of surfaces) {
        if (surface === 'ipc') await invokeIpc(method, args);
        else await invokeHttp(server.url, token, method, args);
        called.push(`${surface} ${method}`);
        if (fingerprint() !== before) changed.push(`${surface} ${method}`);
      }
    }
    expect(called.length).toBeGreaterThanOrEqual(OWNER_METHODS.length);
    expect(changed).toEqual([]);
    // 명령은 쌓였다 — 메인이 판단할 일로 남았을 뿐 자리를 바꾸지 않았다
    expect(h.core.ctx.store.queue.list({ state: 'queued' }).filter((q) => q.memberId === MAIN_AGENT_ID).length).toBeGreaterThan(0);
  }, 180_000);

  it('데스크톱의 메인 AI 바꾸기는 그 PC 운영자의 배정이다 (S4-9) — 이력에 운영자로 남고, 바꾼 쪽에 대표는 없다', async () => {
    await h.invoke('auth.devLogin');
    const s = await h.invoke('settings.update', { general: { mainAgent: CODEX } });
    expect(s.general.mainAgent).toEqual(CODEX);
    // 강제가 아닌 운영자 교체라 나가는 보유자(모의 Claude 메인)의 인계 메모 턴이 끝난 뒤에 넘어간다 (4.3 3번, S4b)
    expect(h.core.seat.view()).toMatchObject({ generation: 2, state: 'switching', pendingHolder: { label: 'Codex CLI' } });
    await h.core.seat.settled();
    expect(h.core.seat.view()).toMatchObject({ generation: 2, state: 'active', holder: { label: 'Codex CLI' } });
    expect(h.core.ctx.store.members.require(MAIN_AGENT_ID).ai).toEqual(CODEX);
    expect(h.core.seat.history().map((x) => [x.generation, x.changedBy])).toEqual([
      [2, 'operator'],
      [1, 'server'],
    ]);
    expect(h.core.ctx.store.seatHistory.list().some((x) => (x.changedBy as string) === 'owner')).toBe(false);
    // 같은 종류에서 모델·노력치만 바꾸면 세대 그대로
    await h.invoke('settings.update', { general: { mainAgent: { ...CODEX, effortTier: 'low' } } });
    expect(h.core.seat.view()).toMatchObject({ generation: 2, holder: { ai: { kind: 'codex', effortTier: 'low' } } });
  });
});
