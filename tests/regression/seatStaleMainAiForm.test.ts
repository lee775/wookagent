/**
 * 메인의 자리 변경 뒤에 먼저 열어 둔 설정 화면이 그 변경을 되돌리지 않는다 (리드 결정 S4-25, S4-16·S4-9, SERVER_DESIGN 4.3):
 * - general.mainAgent를 쓰는 쪽은 둘이다 — 운영자(settings.update)와 메인(hand_off_seat, 같은 종류의 모델 변경 포함). 그래서 메인 에이전트 AI 칸을 보내는
 *   화면은 그 화면이 불러 둔 값을 둘째 인자 expected.mainAgent로 함께 보낸다
 * - expected.mainAgent(모델은 보낸 값처럼 앞뒤 공백을 지운다)가 저장된 값과 다르면 conflict로 거부하고 그 요청의 어떤 칸도 저장하지 않는다 — 자리에 가기 전에 본다.
 *   글은 지금 메인 AI를 말한다: '메인 AI가 그사이 <지금 메인 AI>로 바뀌었습니다. 아무것도 저장하지 않았습니다 — 바뀐 메인 AI를 확인한 뒤 다시 바꾸세요'
 * - 교체 중에는 저장된 값이 넘어갈 보유자다: 교체 전에 불러 둔 화면은 이 거부를, 교체 뒤에 불러 둔 화면은 예전의 '넘기는 중' 거부를 받는다 — 둘 다 참이다
 * - expected를 보내지 않으면 예전 그대로다. 설치 설정 저장은 general.mainAgent를 보내지 않는다(화면 몫, S4-30) — 그 저장은 자리를 건드리지 않는다
 * - 둘째 인자는 { mainAgent?: AiConfig } 하나만 받는다 (ownerArgs)
 * 탐침 zz-sa2-new S1a·S1b(server-s4fix1-seat-authority)에서 왔다
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID, type AiConfig, type Settings } from '@shared/domain';
import type { DeepPartial } from '@shared/ipc';
import { bootOrch, waitFor, type OrchEnv } from './orchHarness';

let env: OrchEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const KEY = 'main:general';
const STALE_TAIL = '로 바뀌었습니다. 아무것도 저장하지 않았습니다 — 바뀐 메인 AI를 확인한 뒤 다시 바꾸세요';

/**
 * 설치 설정 저장이 보내는 것 (S4-30의 화면 — general.mainAgent를 보내지 않는다). src/renderer/src/lib/installationSettings.ts installationPatch에서
 * general.mainAgent만 뺀 모양이다
 */
function installationPatch(settings: Settings): DeepPartial<Settings> {
  return {
    account: { googleClientId: settings.account.googleClientId, authMode: settings.account.authMode },
    cli: settings.cli,
    policy: settings.policy,
    logs: { retentionDays: settings.logs.retentionDays },
    general: { backup: { enabled: settings.general.backup.enabled }, launchAtLogin: settings.general.launchAtLogin },
  };
}

async function refusal(p: Promise<unknown>): Promise<{ code?: string; message: string } | null> {
  try {
    await p;
    return null;
  } catch (err) {
    return { code: (err as { code?: string }).code, message: (err as Error).message };
  }
}

/** 메인 턴 하나를 붙잡아 두고 그 턴 ID */
async function heldMainTurn(e: OrchEnv, text: string): Promise<string> {
  e.hold.add(KEY);
  await e.invoke('command.send', { target: 'main', text });
  e.tick();
  await waitFor(() => !!e.liveProc(KEY, MAIN_AGENT_ID), '메인 턴 시작');
  return e.liveProc(KEY, MAIN_AGENT_ID)!.turnId;
}

async function finishHeld(e: OrchEnv): Promise<void> {
  e.hold.delete(KEY);
  e.liveProc(KEY, MAIN_AGENT_ID)?.finishOk();
  await waitFor(() => !e.core.turns.hasMemberFlow(MAIN_AGENT_ID), '메인 흐름 끝');
  await e.core.seat.settled();
}

/** 자리와 관련된 것 — 이것이 그대로면 아무것도 바뀌지 않았다 */
const seatPrint = (e: OrchEnv) =>
  JSON.stringify({
    seat: e.core.seat.view(),
    history: e.core.seat.history(),
    settings: e.ctx.settings().general.mainAgent,
    mainAi: e.ctx.store.members.require(MAIN_AGENT_ID).ai,
    retention: e.ctx.settings().logs.retentionDays,
  });

describe('먼저 열어 둔 설정 화면과 메인의 자리 변경 (seatStaleMainAiForm)', () => {
  it('화면을 연 뒤 메인이 Codex에게 넘기면, 그 화면이 불러 둔 값으로 보낸 메인 AI 변경은 아무것도 저장하지 않고 거부된다 — 설치 설정 저장은 자리를 건드리지 않는다 (탐침 S1a)', async () => {
    const e = (env = await bootOrch());
    // 운영자(데스크톱 대표)가 운영 설정 화면을 연다 — 화면은 settings.get으로 받은 값을 들고 있다
    const loaded = await e.invoke('settings.get');
    const t1 = await heldMainTurn(e, 'Codex에게 메인을 넘겨');
    expect(await e.tool(t1, 'hand_off_seat', { to: 'codex', reason: '대표 명령' })).toMatchObject({ ok: true });
    await finishHeld(e);
    expect(e.core.seat.view()).toMatchObject({ generation: 2, state: 'active', holder: { label: 'Codex CLI' } });
    const before = seatPrint(e);
    // 그 화면의 메인 에이전트 AI 칸 — 불러 둔 값(Claude)을 기준으로 노력치만 바꿔 보낸다. 다른 칸도 함께
    const stale = loaded.general.mainAgent;
    const changed: AiConfig = { ...stale, effortTier: 'low' };
    const r = await refusal(e.invoke('settings.update', { general: { mainAgent: changed }, logs: { retentionDays: loaded.logs.retentionDays + 1 } }, { mainAgent: stale }));
    expect(r).toEqual({ code: 'conflict', message: `메인 AI가 그사이 Codex CLI(모델 gpt-6-sol, 노력치 high)${STALE_TAIL}` });
    // 불러 둔 값을 그대로 다시 보내도 같다 — 저장된 값과 다르다
    expect(await refusal(e.invoke('settings.update', { general: { mainAgent: stale } }, { mainAgent: stale }))).toMatchObject({ code: 'conflict' });
    expect(seatPrint(e)).toBe(before);
    expect(e.core.seat.history().map((h) => `${h.generation}:${h.changedBy}:${h.holder.label}`)).toEqual(['2:main:Codex CLI', '1:server:Claude CLI']);
    // 같은 화면의 설치 설정 저장(기록 보관만 바꿈) — general.mainAgent를 보내지 않으므로 자리는 그대로이고 그 칸만 저장된다
    const draft = structuredClone(loaded);
    draft.logs.retentionDays = loaded.logs.retentionDays + 1;
    await e.invoke('settings.update', installationPatch(draft));
    expect(e.ctx.settings().logs.retentionDays).toBe(loaded.logs.retentionDays + 1);
    expect(e.core.seat.view()).toMatchObject({ generation: 2, state: 'active', holder: { label: 'Codex CLI' } });
    expect(e.ctx.settings().general.mainAgent.kind).toBe('codex');
    expect(e.core.seat.history()).toHaveLength(2);
  });

  it('메인이 같은 종류로 모델만 바꾼 뒤(세대 그대로) 먼저 연 화면의 변경은 그 모델을 되돌리지 않는다 — 다시 불러 온 값이면 받는다 (탐침 S1b)', async () => {
    const e = (env = await bootOrch());
    const loaded = await e.invoke('settings.get');
    expect(loaded.general.mainAgent).toMatchObject({ kind: 'claude', model: null });
    const t1 = await heldMainTurn(e, '메인 모델을 opus로');
    expect(await e.tool(t1, 'hand_off_seat', { to: 'claude', model: 'opus', reason: '대표 명령' })).toMatchObject({ ok: true, data: { sameGeneration: true } });
    await finishHeld(e);
    expect(e.core.seat.launchedAi()).toMatchObject({ kind: 'claude', model: 'opus' });
    const before = seatPrint(e);
    const r = await refusal(e.invoke('settings.update', { general: { mainAgent: { ...loaded.general.mainAgent, effortTier: 'low' } } }, { mainAgent: loaded.general.mainAgent }));
    expect(r).toEqual({ code: 'conflict', message: `메인 AI가 그사이 Claude CLI(모델 opus, 노력치 high)${STALE_TAIL}` });
    expect(seatPrint(e)).toBe(before);
    expect(e.core.seat.launchedAi()).toMatchObject({ kind: 'claude', model: 'opus' });
    // 바뀐 값을 다시 불러 온 화면(모델은 보낸 값처럼 공백을 지워 견준다)은 바꿀 수 있다 — 같은 세대에서 다음 턴부터
    const fresh = await e.invoke('settings.get');
    const saved = await e.invoke('settings.update', { general: { mainAgent: { ...fresh.general.mainAgent, effortTier: 'low' } } }, { mainAgent: { ...fresh.general.mainAgent, model: ' opus ' } });
    expect(saved.general.mainAgent).toMatchObject({ kind: 'claude', model: 'opus', effortTier: 'low' });
    expect(e.core.seat.view()).toMatchObject({ generation: 1, state: 'active' });
    expect(e.core.seat.launchedAi()).toMatchObject({ kind: 'claude', model: 'opus', effortTier: 'low' });
  });

  it('교체 중: 교체 전에 불러 둔 화면은 바뀐 메인 AI를, 교체 뒤에 불러 둔 화면은 넘기는 중을 듣는다 — 둘 다 아무것도 저장하지 않는다', async () => {
    const e = (env = await bootOrch());
    e.core.seat.applyOperatorConfig({ holders: null, drainMs: 60_000, initialHolder: null }, '시험');
    const before = await e.invoke('settings.get');
    const claude = before.general.mainAgent;
    const codex: AiConfig = { ...claude, kind: 'codex', model: null, effortOverride: null };
    await heldMainTurn(e, '상태 알려줘');
    // 운영자가 지금 값으로 연 화면에서 Codex로 바꾼다 — 실행 중인 메인 턴을 기다리는 교체
    await e.invoke('settings.update', { general: { mainAgent: codex } }, { mainAgent: claude });
    expect(e.core.seat.view()).toMatchObject({ state: 'switching', holder: { label: 'Claude CLI' }, pendingHolder: { label: 'Codex CLI' } });
    const after = await e.invoke('settings.get');
    const retention = after.logs.retentionDays;
    // 교체 전에 불러 둔 화면 — 저장된 값은 이제 넘어갈 보유자(Codex)다
    expect(await refusal(e.invoke('settings.update', { general: { mainAgent: claude }, logs: { retentionDays: retention + 1 } }, { mainAgent: claude }))).toEqual({
      code: 'conflict',
      message: `메인 AI가 그사이 Codex CLI(모델 gpt-6-sol, 노력치 high)${STALE_TAIL}`,
    });
    // 교체 뒤에 불러 둔 화면 — 예전의 '넘기는 중'
    expect(await refusal(e.invoke('settings.update', { general: { mainAgent: claude }, logs: { retentionDays: retention + 1 } }, { mainAgent: after.general.mainAgent }))).toEqual({
      code: 'conflict',
      message: '메인 자리를 Codex CLI에게 넘기는 중입니다(세대 1 → 2) — 교체가 끝난 뒤에 다시 하세요',
    });
    expect(e.ctx.settings().general.mainAgent).toEqual(codex);
    expect(e.ctx.settings().logs.retentionDays).toBe(retention);
    await finishHeld(e);
    expect(e.core.seat.view()).toMatchObject({ generation: 2, state: 'active', holder: { label: 'Codex CLI' } });
  });

  it('expected를 보내지 않거나 메인 AI 칸이 없으면 예전 그대로다 — 메인 AI 칸이 없는 요청의 expected는 보지 않는다', async () => {
    const e = (env = await bootOrch());
    const loaded = await e.invoke('settings.get');
    const stale: AiConfig = { ...loaded.general.mainAgent, model: 'sonnet' };
    // 메인 AI 칸이 없으면 expected가 달라도 다른 칸을 저장한다
    await e.invoke('settings.update', { logs: { retentionDays: loaded.logs.retentionDays + 2 } }, { mainAgent: stale });
    expect(e.ctx.settings().logs.retentionDays).toBe(loaded.logs.retentionDays + 2);
    // 빈 expected·null은 보내지 않은 것과 같다 — 저장된 값과 견줘 바뀐 것만 자리에 간다
    await e.invoke('settings.update', { general: { mainAgent: { ...loaded.general.mainAgent, effortTier: 'normal' } } }, {});
    expect(e.core.seat.launchedAi()).toMatchObject({ kind: 'claude', effortTier: 'normal' });
    await e.invoke('settings.update', { general: { mainAgent: { ...loaded.general.mainAgent, effortTier: 'low' } } }, null as never);
    expect(e.core.seat.launchedAi()).toMatchObject({ kind: 'claude', effortTier: 'low' });
    expect(e.core.seat.view()).toMatchObject({ generation: 1, state: 'active' });
  });

  it('둘째 인자는 { mainAgent?: AiConfig } 하나만 받는다 — 다른 칸·모양은 처리기에 가기 전에 거부되고 아무것도 저장하지 않는다', async () => {
    const e = (env = await bootOrch());
    const loaded = await e.invoke('settings.get');
    const before = seatPrint(e);
    const patch = { general: { mainAgent: { ...loaded.general.mainAgent, kind: 'codex' as const } }, logs: { retentionDays: loaded.logs.retentionDays + 1 } };
    expect(await refusal(e.invoke('settings.update', patch, { mainAgent: loaded.general.mainAgent, base: 1 } as never))).toEqual({
      code: 'invalid_args',
      message: '요청 형식이 올바르지 않습니다 — settings.update: 2번째 인자 모양이 맞지 않습니다',
    });
    expect(await refusal(e.invoke('settings.update', patch, { mainAgent: { ...loaded.general.mainAgent, kind: 'gpt' } } as never))).toEqual({
      code: 'invalid_args',
      message: '요청 형식이 올바르지 않습니다 — settings.update: 2번째 인자의 mainAgent.kind 모양이 맞지 않습니다',
    });
    expect(await refusal(e.invoke('settings.update', patch, 'claude' as never))).toMatchObject({ code: 'invalid_args' });
    expect(seatPrint(e)).toBe(before);
  });

  /**
   * 메인이 hand_off_seat로 같은 종류에서 노력치만 바꾼다(세대 그대로) — 그 전에 연 화면이 모델을 바꾸며 불러 둔 값(노력치 high, 따로 정한 노력치 없음)을
   * expected로 보내면 거부되고 메인이 바꾼 노력치가 그대로다 (리드 결정 S4-35 1번, 탐침 G1·G1b)
   */
  async function effortOnlyChange(change: { effort_tier: 'low' } | { effort: 'max' }, kept: Pick<AiConfig, 'effortTier' | 'effortOverride'>, shown: string): Promise<void> {
    const e = (env = await bootOrch());
    const loaded = await e.invoke('settings.get');
    expect(loaded.general.mainAgent).toEqual({ kind: 'claude', model: null, effortTier: 'high', effortOverride: null });
    const t1 = await heldMainTurn(e, '메인 노력치를 바꿔');
    expect(await e.tool(t1, 'hand_off_seat', { to: 'claude', ...change, reason: '대표 명령' })).toMatchObject({ ok: true, data: { sameGeneration: true } });
    await finishHeld(e);
    const changed: AiConfig = { kind: 'claude', model: null, ...kept };
    expect(e.core.seat.launchedAi()).toEqual(changed);
    const before = seatPrint(e);
    const r = await refusal(e.invoke('settings.update', { general: { mainAgent: { ...loaded.general.mainAgent, model: 'sonnet' } } }, { mainAgent: loaded.general.mainAgent }));
    expect(r).toEqual({ code: 'conflict', message: `메인 AI가 그사이 Claude CLI(CLI 기본 모델, 노력치 ${shown})${STALE_TAIL}` });
    expect(seatPrint(e)).toBe(before);
    expect([e.core.seat.launchedAi(), e.ctx.settings().general.mainAgent, e.ctx.store.members.require(MAIN_AGENT_ID).ai]).toEqual([changed, changed, changed]);
  }

  it('메인이 같은 종류에서 노력치 단계만 바꾼 뒤(effort_tier) 먼저 연 화면의 변경은 거부된다 — 그 노력치를 되돌리지 않는다 (탐침 G1)', async () => {
    await effortOnlyChange({ effort_tier: 'low' }, { effortTier: 'low', effortOverride: null }, 'low');
  });

  it('메인이 같은 종류에서 노력치를 따로 정한 뒤(effort) 먼저 연 화면의 변경은 거부된다 — 따로 정한 노력치를 되돌리지 않는다 (탐침 G1b)', async () => {
    await effortOnlyChange({ effort: 'max' }, { effortTier: 'high', effortOverride: 'max' }, 'max');
  });
});
