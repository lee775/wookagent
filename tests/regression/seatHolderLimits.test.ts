/**
 * 메인 자리를 넘길 수 있는 대상 (SERVER_DESIGN 4.3·10.4 seatHolderLimits, 리드 결정 S4-1·S4-3·S4-12):
 * - 운영자가 정한 보유자 목록(seat.holders) 밖이면 거부한다
 * - 지금 쓸 수 없는 보유자(설치되지 않은 CLI, 버전 확인에 걸린 CLI, 로그인 안 된 CLI)는 거부한다
 * - 외부 에이전트는 7단계 전까지 넘기기·운영자 배정·처음 보유자 어느 길로도 앉히지 않는다 — '외부 에이전트 접속은 7단계에서 붙습니다'
 * - hand_off_seat는 메인만 쓴다. 모르는 대상·목록에 없는 모델은 거부한다. 같은 설정으로 다시 넘기면 거부한다
 * - 메인의 update_settings는 자리 정책(seat.*)을 바꾸지 못한다. 운영자 내부 API로 M-MAIN의 AI를 직접 바꾸는 길도 없다(자리가 바꾸는 곳 하나)
 * 거부되면 자리는 그대로다
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID } from '@shared/domain';
import type { TokenIdentity } from '../../src/main/mcp/types';
import { SEAT_EXTERNAL_LATER, seatConfigProblem } from '../../src/main/orchestrator/seat';
import { bootOrch, type OrchEnv } from './orchHarness';
import { mainOpsIdentity } from './mainOps';

let env: OrchEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const main: TokenIdentity = { ...mainOpsIdentity(), seatGeneration: 1 };
const handOff = (e: OrchEnv, args: Record<string, unknown>) => e.core.tools.handle(main, 'hand_off_seat', { reason: '대표 명령', ...args });
const unchanged = (e: OrchEnv) => {
  expect(e.core.seat.view()).toMatchObject({ generation: 1, state: 'active', holder: { kind: 'launched', label: 'Claude CLI' }, pendingHolder: null });
  expect(e.core.seat.history()).toHaveLength(1);
  expect(e.ctx.store.members.require(MAIN_AGENT_ID).ai.kind).toBe('claude');
};

describe('메인 자리를 넘길 수 있는 대상 (seatHolderLimits)', () => {
  it('보유자 목록 밖, 설치되지 않은·버전이 맞지 않는·로그인 안 된 CLI, 외부 에이전트로는 넘기지 못한다 — 까닭을 말하고 자리는 그대로다', async () => {
    const e = (env = await bootOrch({ mock: false }));
    const codex = e.ctx.ai('codex');

    e.ctx.saveAi({ ...codex, authRequired: true, authRequiredSince: e.ctx.now() });
    expect(await handOff(e, { to: 'codex' })).toEqual({ ok: false, code: 'conflict', message: 'Codex CLI에게 메인 자리를 넘길 수 없습니다 — Codex CLI에 로그인돼 있지 않습니다 (재로그인 필요)' });
    e.ctx.saveAi({ ...codex, cliInstalled: false, cliProblem: '설치되지 않음' });
    expect(await handOff(e, { to: 'codex' })).toEqual({ ok: false, code: 'conflict', message: 'Codex CLI에게 메인 자리를 넘길 수 없습니다 — Codex CLI가 이 PC에 설치되지 않았습니다' });
    e.ctx.saveAi({ ...codex, cliProblem: 'codex 0.1.0은 검증된 버전 범위 밖입니다' });
    expect(await handOff(e, { to: 'launched:codex' })).toEqual({
      ok: false,
      code: 'conflict',
      message: 'Codex CLI에게 메인 자리를 넘길 수 없습니다 — Codex CLI를 지금 쓸 수 없습니다 (codex 0.1.0은 검증된 버전 범위 밖입니다)',
    });
    // 운영자 배정도 같은 대상 판정을 한다 — 거부 글은 운영자가 한 일(데스크톱: 운영 설정의 메인 AI 바꾸기)을 말한다 (리드 결정 S4-15)
    expect(() => e.core.seat.assign({ holder: { kind: 'launched', ai: { kind: 'codex', model: null, effortTier: 'high', effortOverride: null } }, by: 'operator', reason: '복구' })).toThrow(
      '메인 AI를 Codex CLI로 바꿀 수 없습니다 — Codex CLI를 지금 쓸 수 없습니다 (codex 0.1.0은 검증된 버전 범위 밖입니다)',
    );
    e.ctx.saveAi(codex);

    // 운영자가 정한 보유자 목록 밖
    e.core.seat.applyOperatorConfig({ holders: ['launched:claude'], drainMs: null, initialHolder: null }, '시험');
    expect(await handOff(e, { to: 'codex' })).toEqual({
      ok: false,
      code: 'forbidden',
      message: 'Codex CLI(launched:codex)은(는) 운영자가 정한 메인 자리 보유자 목록(seat.holders: launched:claude)에 없습니다',
    });
    e.core.seat.applyOperatorConfig({ holders: ['launched:claude', 'launched:codex', 'external:*'], drainMs: null, initialHolder: null }, '시험');

    // 외부 에이전트 — 넘기기·운영자 배정·처음 보유자 모두 (S4-1)
    expect(await handOff(e, { to: 'external:X-0001' })).toEqual({ ok: false, code: 'forbidden', message: `X-0001에게 메인 자리를 줄 수 없습니다 — ${SEAT_EXTERNAL_LATER}` });
    expect(() => e.core.seat.assign({ holder: { kind: 'external', agentId: 'X-0001', label: '그록봇' }, by: 'operator', reason: '복구' })).toThrow(`그록봇에게 메인 자리를 줄 수 없습니다 — ${SEAT_EXTERNAL_LATER}`);
    expect(seatConfigProblem({ initialHolder: 'external:X-0001', holders: null, drainMs: null }, 'server.json')).toBe(
      `server.json의 seat.initialHolder(external:X-0001) — ${SEAT_EXTERNAL_LATER}. 지금은 launched:claude나 launched:codex를 넣으세요`,
    );

    // 모르는 대상·목록에 없는 모델·같은 설정
    expect(await handOff(e, { to: 'gpt' })).toMatchObject({ ok: false, code: 'invalid' });
    expect(await handOff(e, { to: 'external:*' })).toMatchObject({ ok: false, code: 'invalid' });
    expect(await handOff(e, { to: 'codex', model: 'gpt-0-unknown' })).toMatchObject({ ok: false, code: 'invalid', message: expect.stringContaining('운영 설정 모델 목록에 없습니다') });
    expect(await handOff(e, { to: 'claude', effort: 'ultra' })).toMatchObject({ ok: false, code: 'invalid' });
    expect(await handOff(e, { to: 'claude' })).toEqual({ ok: false, code: 'conflict', message: '메인 자리에는 이미 Claude CLI가 같은 설정으로 앉아 있습니다(세대 1)' });
    expect(await handOff(e, { to: 'codex', reason: '  ' })).toMatchObject({ ok: false, code: 'invalid' });
    unchanged(e);

    // 쓸 수 있는 대상이면 넘어간다 (판정이 모두를 막는 것이 아니다)
    expect(await handOff(e, { to: 'codex' })).toMatchObject({ ok: true, data: { generation: 2 } });
  });

  it('hand_off_seat는 메인만 쓴다 — 메인의 update_settings는 자리 정책(seat.*)을 바꾸지 못하고, 운영자 내부 API로 M-MAIN의 AI를 직접 바꾸는 길도 없다', async () => {
    const e = (env = await bootOrch());
    const producer: TokenIdentity = {
      turnId: 'TN-p',
      sessionId: 'S-p',
      sessionKey: 'directive:D-0000',
      sessionKind: 'directive',
      memberId: e.producerId,
      projectId: e.projectId,
      isMain: false,
      isProducer: true,
      canReview: true,
    };
    expect(await e.core.tools.handle(producer, 'hand_off_seat', { to: 'codex', reason: '넘겨' })).toEqual({ ok: false, code: 'forbidden', message: '메인 에이전트만 쓸 수 있는 도구입니다' });
    const s = await e.core.tools.handle(main, 'update_settings', { patch: { seat: { holders: ['launched:codex'], drainMs: 0 } }, reason: '대표 명령' });
    expect(s).toMatchObject({ ok: false, code: 'forbidden' });
    expect((s as { message: string }).message).toContain('메인 자리 정책(seat.* — 앉을 수 있는 보유자·마무리 기다림)');
    expect(e.core.seat.policy()).toEqual({ holders: ['launched:claude', 'launched:codex', 'external:*'], drainMs: 120_000 });
    await expect(e.internal('members.update', MAIN_AGENT_ID, { ai: { kind: 'codex', model: null, effortTier: 'high', effortOverride: null } })).rejects.toMatchObject({
      code: 'forbidden',
      message: '메인 에이전트의 AI는 메인 자리에서만 바뀝니다 — 운영 설정의 메인 AI(general.mainAgent)나 메인 에이전트의 자리 넘기기(hand_off_seat)로 바꾸세요',
    });
    // 같은 길로 모의 시나리오는 그대로 바꾼다 (AI 말고는 막지 않는다)
    expect((await e.internal('members.update', MAIN_AGENT_ID, { mockScenario: 'hang' })).id).toBe(MAIN_AGENT_ID);
    unchanged(e);
  });

  it('server.json의 seat 값: 보유자 표기·목록·마무리 시간·처음 보유자를 본다 (S4-12)', () => {
    const ok = { initialHolder: null, holders: null, drainMs: null };
    expect(seatConfigProblem(ok, 'server.json')).toBeNull();
    expect(seatConfigProblem({ initialHolder: 'launched:codex', holders: ['launched:claude', 'launched:codex', 'external:X-0001'], drainMs: 0 }, 'server.json')).toBeNull();
    expect(seatConfigProblem({ ...ok, holders: [] }, 'server.json')).toContain('seat.holders가 비었습니다');
    expect(seatConfigProblem({ ...ok, holders: ['launched:gpt'] }, 'server.json')).toContain('seat.holders에 모르는 보유자가 있습니다');
    expect(seatConfigProblem({ ...ok, holders: ['external:*'] }, 'server.json')).toBe(`server.json의 seat.holders에 서버가 띄우는 보유자(launched:claude·launched:codex)가 없습니다 — ${SEAT_EXTERNAL_LATER}`);
    for (const drainMs of [-1, 1.5, 3_600_001]) expect(seatConfigProblem({ ...ok, drainMs }, 'server.json')).toBe('server.json의 seat.drainMs는 0~3600000의 정수(밀리초)여야 합니다');
    expect(seatConfigProblem({ ...ok, initialHolder: 'codex' }, 'server.json')).toBe('server.json의 seat.initialHolder는 launched:claude나 launched:codex여야 합니다');
    expect(seatConfigProblem({ ...ok, initialHolder: 'external:*' }, 'server.json')).toBe('server.json의 seat.initialHolder는 launched:claude나 launched:codex여야 합니다');
    expect(seatConfigProblem({ initialHolder: 'launched:codex', holders: ['launched:claude'], drainMs: null }, 'server.json')).toBe('server.json의 seat.initialHolder(launched:codex)가 seat.holders에 없습니다');
  });
});
