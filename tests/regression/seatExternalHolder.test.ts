/**
 * 외부 보유자를 메인 자리에 받는 판정 (SERVER_DESIGN 4.3·4.5, 리드 결정 S7-1·S7-4 — 7단계 S7a, 서버 모드):
 * - 쓸 수 있는 외부 보유자 = 운영자가 등록하고 폐기하지 않은 에이전트. 운영자 배정·메인의 hand_off_seat·처음 보유자가 같은 판정이고, 거부 글은 부른 쪽이 한 일과
 *   그 출구(agent add)를 말한다. 거부되면 자리는 그대로다
 * - 이름은 등록 기록에서 온다 — 부른 쪽이 적은 이름은 쓰지 않는다. 이력·활동 기록·인계 꾸러미·대표 알림에 그 이름이 남는다
 * - holders는 external:<ID> 또는 external:*로 받는다. 같은 외부 에이전트에게 다시 배정하면 거부한다
 * - 외부 보유자가 앉아도 서버는 M-MAIN 턴을 띄우지 않는다(runsMain은 서버가 띄우는 보유자뿐 — 일 받기는 S7b). M-MAIN의 AI는 마지막 CLI 그대로다
 * - 앉은(또는 들어올) 에이전트를 폐기해도 자리는 그대로이고, 목록이 seated·incoming·connected를 참으로 보인다
 * - 빈 자리의 처음 보유자(config reload의 드문 갈래)도 같은 판정이다
 * 데스크톱의 거부는 seatHolderLimits(데스크톱 하네스)가 본다
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID } from '@shared/domain';
import type { TokenIdentity } from '../../src/main/mcp/types';
import type { MainSeatRow } from '../../src/main/db/store';
import { bootOrch, notices, waitFor, type OrchEnv } from './orchHarness';
import { mainOpsIdentity } from './mainOps';

let env: OrchEnv | null = null;
afterEach(async () => {
  if (env) {
    // 모의 메인만 돌았다 — 서버가 띄운 메인 턴은 모두 모의 실행이다 (리드 결정 S6-19)
    expect(env.ctx.store.turns.list({ ref1: MAIN_AGENT_ID }).filter((t) => !t.mock)).toEqual([]);
    await env.close();
  }
  env = null;
});

const NOT_REGISTERED = '등록되지 않은 외부 에이전트입니다 — 서버 PC의 운영자가 wook-server agent add로 등록한 뒤 쓸 수 있습니다';
const fingerprint = (e: OrchEnv): string => JSON.stringify({ seat: e.ctx.store.seat.get('main'), history: e.ctx.store.seatHistory.list(), mainAi: e.ctx.store.members.require(MAIN_AGENT_ID).ai });
const errorOf = (fn: () => unknown): { code: string; message: string } => {
  try {
    fn();
  } catch (err) {
    return { code: (err as { code: string }).code, message: (err as Error).message };
  }
  throw new Error('거부되지 않았습니다');
};
const handOff = (e: OrchEnv, generation: number, to: string) => e.core.tools.handle({ ...mainOpsIdentity(), seatGeneration: generation } as TokenIdentity, 'hand_off_seat', { to, reason: '대표 명령' });

describe('외부 보유자 받기 — 운영자 배정 (S7-4)', () => {
  it('등록되지 않은·폐기된 에이전트는 거부하고 자리는 그대로다 — 등록하면 앉고, 이름은 등록 기록에서 온다', async () => {
    const e = (env = await bootOrch({ mode: 'server' }));
    const before = fingerprint(e);
    expect(errorOf(() => e.core.seat.operatorAssign('external:X-0001', false))).toEqual({ code: 'conflict', message: `X-0001에게 메인 자리를 배정할 수 없습니다 — ${NOT_REGISTERED}` });
    e.core.externalAgents.add('지난봇');
    e.core.externalAgents.revoke('X-0001');
    const revokedAt = e.ctx.store.externalAgents.get('X-0001')!.revokedAt!;
    expect(errorOf(() => e.core.seat.operatorAssign('external:X-0001', true))).toEqual({
      code: 'conflict',
      message: `지난봇에게 메인 자리를 배정할 수 없습니다 — 키가 폐기된 외부 에이전트입니다 (${revokedAt} 폐기) — 다시 쓰려면 운영자가 wook-server agent add로 새로 등록합니다`,
    });
    expect(fingerprint(e)).toBe(before);

    e.core.externalAgents.add('그록봇');
    // 부른 쪽이 적은 이름은 쓰지 않는다 — 등록 기록의 이름
    const r = e.core.seat.assign({ holder: { kind: 'external', agentId: 'X-0002', label: '가짜 이름' }, by: 'operator', reason: '운영자 복구 배정 (시험)' });
    expect(r).toMatchObject({ outcome: 'swap', generation: 2 });
    await r.done;
    expect(e.core.seat.view()).toMatchObject({ generation: 2, state: 'active', holder: { kind: 'external', agentId: 'X-0002', label: '그록봇' }, pendingHolder: null, vision: 'unknown' });
    expect(e.core.seat.history().map((h) => [h.generation, h.holder.label, h.changedBy])).toEqual([
      [2, '그록봇', 'operator'],
      [1, 'Claude CLI', 'server'],
    ]);
    const seatRows = e.ctx.store.activity.search({ kinds: ['seat'], limit: 50 }).map((x) => x.text);
    expect(seatRows.some((t) => t.startsWith('메인 자리 교체 끝: Claude CLI → 그록봇 (세대 2'))).toBe(true);
    expect(e.core.seat.handover(2)!.sections[0]!.lines.at(-1)).toBe('새 보유자: 그록봇 (세대 2)');
    expect(notices(e, '메인 에이전트가 바뀌었습니다').map((n) => n.body.split(' (')[0])).toEqual(['이제 그록봇이 메인 에이전트입니다']);
    expect(JSON.stringify(e.ctx.store.seat.get('main')).includes('가짜 이름')).toBe(false);
    // 서버는 외부 보유자의 턴을 띄우지 않는다(일 받기는 에이전트 API — S7b). M-MAIN의 AI는 마지막 CLI 그대로다
    expect([e.core.seat.runsMain(), e.core.seat.launchedAi(), e.ctx.store.members.require(MAIN_AGENT_ID).ai.kind]).toEqual([false, null, 'claude']);
    expect(e.core.externalAgents.list().map((a) => [a.id, a.seat])).toEqual([
      ['X-0001', null],
      ['X-0002', 'seated'],
    ]);

    // 같은 에이전트에게 다시 — 거부(세대를 올리지 않는다). 서버가 띄우는 보유자로는 되돌린다
    expect(errorOf(() => e.core.seat.operatorAssign('external:X-0002', false))).toEqual({ code: 'conflict', message: '메인 자리에는 이미 그록봇(X-0002)가 앉아 있습니다(세대 2)' });
    const back = e.core.seat.operatorAssign('launched:codex', false);
    await back.done;
    expect(e.core.seat.view()).toMatchObject({ generation: 3, state: 'active', holder: { kind: 'launched', label: 'Codex CLI' } });
  });

  it('holders: external:<ID>나 external:*가 있어야 한다 — 없으면 목록 밖으로 거부한다', async () => {
    const e = (env = await bootOrch({ mode: 'server' }));
    e.core.externalAgents.add('하나');
    e.core.externalAgents.add('둘');
    e.core.seat.applyOperatorConfig({ holders: ['launched:claude', 'launched:codex'], drainMs: null, initialHolder: null }, '시험');
    expect(errorOf(() => e.core.seat.operatorAssign('external:X-0001', false))).toEqual({
      code: 'forbidden',
      message: '하나(external:X-0001)은(는) 운영자가 정한 메인 자리 보유자 목록(seat.holders: launched:claude, launched:codex)에 없습니다',
    });
    e.core.seat.applyOperatorConfig({ holders: ['launched:claude', 'external:X-0002'], drainMs: null, initialHolder: null }, '시험');
    expect(errorOf(() => e.core.seat.operatorAssign('external:X-0001', false)).code).toBe('forbidden');
    const ok = e.core.seat.operatorAssign('external:X-0002', true);
    await ok.done;
    expect(e.core.seat.view()).toMatchObject({ generation: 2, holder: { agentId: 'X-0002', label: '둘' } });
  });

  it('앉은 에이전트를 폐기해도 자리는 그대로다 — 목록은 seated·폐기를, 진행 중인 교체의 다음 보유자는 incoming을 보인다', async () => {
    const e = (env = await bootOrch({ mode: 'server' }));
    e.core.externalAgents.add('그록봇');
    e.core.externalAgents.add('다음봇');
    await e.core.seat.operatorAssign('external:X-0001', true).done;
    const seated = JSON.parse(fingerprint(e)) as { seat: MainSeatRow };
    expect(e.core.externalAgents.revoke('X-0001')).toMatchObject({ already: false, seated: true });
    // 자리는 그대로다(보유자·세대·이력) — S7b부터 곧바로 응답 없음 '키가 폐기됨 (운영자)'이 된다 (리드 결정 S7-15 7, hooks.onRevoked)
    const after = JSON.parse(fingerprint(e)) as { seat: MainSeatRow };
    expect({ ...after, seat: { ...after.seat, unresponsiveSince: null, unresponsiveReason: null } }).toEqual(seated);
    expect([after.seat.unresponsiveReason, !!after.seat.unresponsiveSince]).toEqual(['키가 폐기됨 (운영자)', true]);
    expect(e.core.externalAgents.list().map((a) => [a.id, a.seat, !!a.revokedAt])).toEqual([
      ['X-0001', 'seated', true],
      ['X-0002', null, false],
    ]);
    // 메인 턴이 도는 동안의 교체 — 다음 보유자는 incoming (마무리를 기다리는 동안)
    await e.core.seat.operatorAssign('launched:claude', true).done;
    e.core.seat.applyOperatorConfig({ holders: null, drainMs: 60_000, initialHolder: null }, '시험');
    e.hold.add('main:general');
    await e.internal('command.send', { target: 'main', text: '긴 일' });
    e.tick();
    await waitFor(() => !!e.liveProc('main:general', MAIN_AGENT_ID), '메인 턴 시작');
    const swap = e.core.seat.operatorAssign('external:X-0002', false);
    expect(e.core.seat.view()).toMatchObject({ state: 'switching', pendingHolder: { kind: 'external', agentId: 'X-0002', label: '다음봇' } });
    expect(e.core.externalAgents.list().find((a) => a.id === 'X-0002')!.seat).toBe('incoming');
    expect(e.core.externalAgents.revoke('X-0002').seated).toBe(true);
    // 들어올 보유자가 폐기됐어도 교체는 그대로 끝난다 — 나가는 턴(모의 메인)이 끝나면 넘어간다(그 뒤 자리는 응답 없음이 된다 — S7b)
    // 나가는 보유자(서버가 띄운 CLI)의 인계 메모 턴은 붙잡지 않는다 — 곧 끝난다
    e.hold.clear();
    e.liveProc('main:general', MAIN_AGENT_ID)!.finishOk();
    await swap.done;
    // 교체는 끝나고, 폐기된 들어온 보유자의 자리는 곧바로 응답 없음이다 (리드 결정 S7-15 5)
    expect(e.core.seat.view()).toMatchObject({ state: 'active', holder: { agentId: 'X-0002' }, unresponsiveReason: '키가 폐기됨 (운영자)' });
  });

  it('connected는 지금 세대·그 에이전트·끝나지 않은 임대일 때만 참이다 (임대 칸은 S7b가 쓴다)', async () => {
    const e = (env = await bootOrch({ mode: 'server' }));
    e.core.externalAgents.add('그록봇');
    await e.core.seat.operatorAssign('external:X-0001', true).done;
    const put = (lease: MainSeatRow['lease']) => e.ctx.store.seat.put({ ...e.ctx.store.seat.get('main')!, lease });
    const later = new Date(Date.now() + 60_000).toISOString();
    const base = { agentId: 'X-0001', leaseHash: 'h', generation: 2, claimedAt: e.ctx.now(), heartbeatAt: e.ctx.now(), expiresAt: later };
    const connected = () => e.core.externalAgents.list()[0]!.connected;
    put(base);
    expect(connected()).toBe(true);
    for (const lease of [null, { ...base, expiresAt: new Date(Date.now() - 1000).toISOString() }, { ...base, generation: 1 }, { ...base, agentId: 'X-0002' }]) {
      put(lease);
      expect([JSON.stringify(lease), connected()]).toEqual([JSON.stringify(lease), false]);
    }
    put(base);
    e.core.externalAgents.revoke('X-0001');
    expect(connected()).toBe(false);
  });
});

describe('외부 보유자 받기 — 메인의 hand_off_seat (S7-4)', () => {
  it('등록되지 않은·폐기된 에이전트에게는 넘기지 못한다 — 등록한 에이전트에게는 넘기고, 이름은 등록 기록에서 온다', async () => {
    const e = (env = await bootOrch({ mode: 'server' }));
    expect(await handOff(e, 1, 'external:X-0001')).toEqual({ ok: false, code: 'conflict', message: `X-0001에게 메인 자리를 넘길 수 없습니다 — ${NOT_REGISTERED}` });
    e.core.externalAgents.add('지난봇');
    e.core.externalAgents.revoke('X-0001');
    expect(await handOff(e, 1, 'external:X-0001')).toMatchObject({ ok: false, code: 'conflict', message: expect.stringMatching(/^지난봇에게 메인 자리를 넘길 수 없습니다 — 키가 폐기된 외부 에이전트입니다/) });
    expect(e.core.seat.view()).toMatchObject({ generation: 1, holder: { label: 'Claude CLI' } });
    e.core.externalAgents.add('그록봇');
    expect(await handOff(e, 1, 'external:X-0002')).toEqual({ ok: true, data: { generation: 2, to: '그록봇', sameGeneration: false, message: '이 턴을 마치면 넘어갑니다. 남길 말은 journal_write로 적으세요' } });
    await e.core.seat.settled();
    expect(e.core.seat.view()).toMatchObject({ generation: 2, state: 'active', holder: { kind: 'external', agentId: 'X-0002', label: '그록봇' } });
    expect(e.core.seat.history()[0]).toMatchObject({ generation: 2, changedBy: 'main', holder: { label: '그록봇' } });
    expect(e.ctx.store.activity.search({ kinds: ['seat'], limit: 50 }).find((x) => x.text.startsWith('메인 자리 교체 시작'))!.actor).toBe(MAIN_AGENT_ID);
  });
});

describe('외부 보유자 받기 — 빈 자리의 처음 보유자 (config reload의 드문 갈래, S7-4)', () => {
  it('쓸 수 있으면 앉히고 바뀐 것으로 말한다 — 아니면 빈 자리를 그대로 두고 까닭을 남긴다', async () => {
    const e = (env = await bootOrch({ mode: 'server' }));
    const vacate = () => e.ctx.store.seat.put({ ...e.ctx.store.seat.get('main')!, state: 'vacant', holder: null, since: null });
    vacate();
    expect(e.core.seat.applyOperatorConfig({ holders: null, drainMs: null, initialHolder: 'external:X-0001' }, 'server.json')).toEqual([]);
    expect(e.core.seat.view()).toMatchObject({ state: 'vacant', holder: null });
    const warn = e.ctx.store.activity.search({ kinds: ['seat'], level: 'warn', limit: 5 })[0]!;
    expect([warn.actor, warn.text]).toEqual(['system', `메인 자리: 처음 보유자 external:X-0001을(를) 앉힐 수 없습니다 — ${NOT_REGISTERED}`]);
    // 자리를 바꾸는 한 곳(assign)도 처음 보유자 요청을 같은 판정으로 거부한다 — 부르는 쪽이 판정을 빠뜨려도 등록되지 않은 에이전트가 앉지 않는다
    expect(errorOf(() => e.core.seat.assign({ holder: { kind: 'external', agentId: 'X-0001', label: 'X-0001' }, by: 'server', reason: '시험', initial: true }))).toEqual({
      code: 'conflict',
      message: `X-0001을 메인 자리에 앉힐 수 없습니다 — ${NOT_REGISTERED}`,
    });
    expect(e.core.seat.view()).toMatchObject({ state: 'vacant', holder: null });
    e.core.externalAgents.add('그록봇');
    expect(e.core.seat.applyOperatorConfig({ holders: null, drainMs: null, initialHolder: 'external:X-0001' }, 'server.json')).toEqual([
      { item: 'seat.initialHolder', text: '빈 메인 자리에 처음 보유자 그록봇이 앉음' },
    ]);
    expect(e.core.seat.view()).toMatchObject({ generation: 2, state: 'active', holder: { kind: 'external', agentId: 'X-0001', label: '그록봇' } });
    expect(e.core.seat.history()[0]).toMatchObject({ generation: 2, changedBy: 'server', holder: { label: '그록봇' } });
  });
});
