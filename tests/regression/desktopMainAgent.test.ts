/**
 * 데스크톱에서는 그 PC의 사람(대표이자 운영자)이 메인 AI(처음 보유자, general.mainAgent)를 정한다 (리드 결정 8, 10-29 — owner-surface 리뷰 M3, 프로브 P3).
 * 처음 보유자는 운영자 몫이다(SEC-02·AGT-08·SEAT-03). Codex만 설치된 PC처럼 메인 AI 종류의 CLI가 없으면 메인이 영영 돌지 않으므로, 데스크톱 운영자
 * 로컬 settings.update가 general.mainAgent를 받는다. 원격 대표 길과 메인 에이전트(update_settings·set_member_ai)는 계속 거부한다 — 자리 넘기기는 4단계
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID } from '@shared/domain';
import { ownerRefusal } from '../../src/main/backend/ownerGate';
import { bootRestartable, sleep, waitUntil, type RestartableEnv } from '../acceptance/stops-helpers';

let env: RestartableEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const codeOf = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (err: { code?: string }) => err.code ?? 'error',
  );

describe('데스크톱 운영자가 메인 AI를 정한다 (리드 결정 8)', () => {
  it('메인 AI 종류(claude)의 CLI가 없는 PC에서 데스크톱 settings.update로 메인 AI를 codex로 바꾸면 메인이 돈다 — 원격 길·메인 에이전트는 바꾸지 못한다', async () => {
    env = await bootRestartable({ mock: false });
    const e = env;
    expect(e.ctx.store.members.require(MAIN_AGENT_ID).ai.kind).toBe('claude');
    // Codex만 설치된 PC: claude CLI 없음 (시작 때 CLI 확인이 남기는 값)
    e.ctx.saveAi({ ...e.ctx.ai('claude'), cliInstalled: false, cliProblem: '설치되지 않음' });
    await e.invoke('command.send', { target: 'main', text: '안녕' });
    e.tick();
    await sleep(300);
    expect(e.launches.filter((l) => l.memberId === MAIN_AGENT_ID)).toEqual([]);

    const codex = { kind: 'codex' as const, model: null, effortTier: 'high' as const, effortOverride: null };
    // 원격 대표 길과 메인 에이전트는 바꾸지 못한다
    expect(ownerRefusal('settings.update', [{ general: { mainAgent: codex } }], 'remote')).toBeTruthy();
    expect(await codeOf(e.main('update_settings', { patch: { general: { mainAgent: codex } } }))).toBe('forbidden');
    expect(await codeOf(e.main('set_member_ai', { member_id: MAIN_AGENT_ID, ai_kind: 'codex', effort_tier: 'high' }))).toBe('forbidden');
    expect(e.ctx.store.members.require(MAIN_AGENT_ID).ai.kind).toBe('claude');
    // 데스크톱의 그 PC 사람(대표이자 운영자, SERVER_DESIGN 2.5)
    const s = await e.invoke('settings.update', { general: { mainAgent: codex } });
    expect(s.general.mainAgent).toEqual(codex);
    expect(e.ctx.store.members.require(MAIN_AGENT_ID).ai).toEqual(codex);
    expect(e.ctx.store.activity.search({ text: '운영 설정 변경', limit: 5 }).map((r) => r.actor)).toContain('owner');
    // 쌓인 대표 명령이 codex 메인으로 처리된다
    e.tick();
    await waitUntil(() => e.launches.some((l) => l.memberId === MAIN_AGENT_ID), '메인 턴');
    expect(e.ctx.store.turns.list({ ref1: MAIN_AGENT_ID }).map((t) => t.aiKind)).toEqual(['codex']);
    // 다른 항목이 섞이면 거부 (운영자 몫이 아닌 메인 몫 항목)
    expect(await codeOf(e.invoke('settings.update', { general: { mainAgent: { ...codex, kind: 'claude' }, backup: { keep: 2 } } }))).toBe('forbidden');
    expect(e.ctx.store.members.require(MAIN_AGENT_ID).ai.kind).toBe('codex');
  });
});
