/**
 * 팀원 AI 설정 (19.1): 입력 경계 검사(spec:F1 4번, CONC-01 4번), 모델 목록 검사(spec:F8),
 * 보류된 AI 변경 적용 시점(concurrency:CONC-12), 진행 중 세션의 모델 고정(spec:F9).
 * v0.6 (SERVER_DESIGN 2.7, 10.11 teamAi): 대표 AI 고정과 '메인 에이전트 AI 결정 끄기'(team.mainAgentDecidesAi)를 없앴다 — 끄기 시험(F10)은 지웠고,
 * 대표 경로로 하던 준비는 운영자 내부 API로 한다. 팀원 AI는 늘 메인 에이전트가 정한다
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { TokenIdentity } from '../../src/main/mcp/types';
import { directiveKey } from '../../src/main/orchestrator/records';
import type { OrchEnv } from './orchHarness';
import { bootOrch, seedDirective } from './orchHarness';

let env: OrchEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const mainIdentity = (e: OrchEnv): TokenIdentity => ({
  turnId: 'TN-main-test',
  sessionId: 'S-main-test',
  sessionKey: `main:${e.projectId}`,
  sessionKind: 'main_project',
  memberId: 'M-MAIN',
  projectId: null,
  isMain: true,
  isProducer: false,
  canReview: false,
});

const call = (e: OrchEnv, tool: string, args: Record<string, unknown>) => e.core.tools.handle(mainIdentity(e), tool, args);

describe('메인 에이전트의 모델 선택은 운영 설정 목록 안에서만 (F8, F1)', () => {
  it('목록의 표시 이름("GPT-6 Sol")은 거부하고 id를 알려 준다 — 저장되지 않는다', async () => {
    env = await bootOrch();
    const e = env;
    const before = e.ctx.store.members.require(e.devId).ai;
    const r = await call(e, 'set_member_ai', { member_id: e.devId, model: 'GPT-6 Sol', reason: '구현' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('invalid');
    expect(r.message).toContain('gpt-6-sol');
    expect(e.ctx.store.members.require(e.devId).ai).toEqual(before);
  });

  it('운영 설정 모델 목록에서 뺀 모델·다른 AI 종류의 모델·목록에 없는 이름은 거부', async () => {
    env = await bootOrch();
    const e = env;
    const s = e.ctx.settings();
    await e.internal('settings.update', { team: { modelCatalog: { ...s.team.modelCatalog!, claude: s.team.modelCatalog!.claude.filter((o) => o.id !== 'fable') } } });
    const removed = await call(e, 'set_member_ai', { member_id: e.qaId, model: 'fable', reason: '어려운 검수' });
    expect(removed.ok).toBe(false);
    const wrongKind = await call(e, 'set_member_ai', { member_id: e.qaId, model: 'gpt-6-sol', reason: '실수' }); // QA는 claude
    expect(wrongKind.ok).toBe(false);
    const madeUp = await call(e, 'add_member', { project_id: e.projectId, role_id: 'docs', model: 'claude-9-ultra' });
    expect(madeUp.ok).toBe(false);
    const ok = await call(e, 'add_member', { project_id: e.projectId, role_id: 'docs', model: 'sonnet', reason: '문서' });
    expect(ok.ok).toBe(true);
  });

  it('claude 목록이 비면 CLI 기본 모델(null)만 고를 수 있다', async () => {
    env = await bootOrch();
    const e = env;
    const s = e.ctx.settings();
    await e.internal('settings.update', { team: { modelCatalog: { ...s.team.modelCatalog!, claude: [] } } });
    expect((await call(e, 'set_member_ai', { member_id: e.qaId, model: 'opus', reason: '검수' })).ok).toBe(false);
    const r = await call(e, 'set_member_ai', { member_id: e.qaId, model: null, reason: '기본 모델' });
    expect(r.ok).toBe(true);
    expect(e.ctx.store.members.require(e.qaId).ai.model).toBeNull();
  });

  it('노력치만 바꾸는 호출은 AI 종류·모델을 그대로 둔다 (생략한 항목이 역할 기본값으로 돌아가지 않음)', async () => {
    env = await bootOrch();
    const e = env;
    // 운영자가 개발자를 claude opus로 정해 두었다 (목록 밖 모델이어도 노력치만 바꾸는 호출은 막지 않는다). 대표 고정은 없다
    e.core.team.update(e.devId, { ai: { kind: 'claude', model: 'claude-opus-custom', effortTier: 'normal', effortOverride: null } }, 'operator');
    const r = await call(e, 'set_member_ai', { member_id: e.devId, effort: 'max', reason: '어려운 디버깅' });
    expect(r.ok).toBe(true);
    const ai = e.ctx.store.members.require(e.devId).ai;
    expect(ai).toMatchObject({ kind: 'claude', model: 'claude-opus-custom', effortOverride: 'max' });
  });

  it('운영자 경로(내부 API)는 자유 입력이지만 CLI가 받지 못하는 이름(공백·제어 문자)은 저장 전에 거부한다', async () => {
    env = await bootOrch();
    const e = env;
    const free = await e.internal('members.update', e.qaId, { ai: { kind: 'claude', model: '  claude-sonnet-custom  ', effortTier: 'normal', effortOverride: null } });
    expect(free.ai.model).toBe('claude-sonnet-custom'); // 앞뒤 공백은 뗀다
    await expect(e.internal('members.update', e.qaId, { ai: { kind: 'claude', model: 'Sonnet 4', effortTier: 'normal', effortOverride: null } })).rejects.toMatchObject({ code: 'invalid' });
    await expect(e.internal('settings.update', { team: { effortMapping: { claude: { high: 'ultra', normal: 'medium', low: 'low' } } } })).rejects.toMatchObject({ code: 'invalid' });
    await expect(e.internal('settings.update', { general: { mainAgent: { kind: 'claude', model: 'Opus 4', effortTier: 'high', effortOverride: null } } })).rejects.toMatchObject({ code: 'invalid' });
  });
});

describe('보류된 AI 변경은 다음 업무를 시작할 때 적용된다 (CONC-12)', () => {
  it('활성 작업도 실행 중 턴도 없는 팀원의 보류된 변경은 새 작업의 첫 턴부터 쓴다', async () => {
    env = await bootOrch();
    const e = env;
    const dev = e.ctx.store.members.require(e.devId);
    // 이전 작업이 끝나는 경로(예: 재시작 복구)에서 적용되지 않고 남은 변경
    e.ctx.store.members.put({ ...dev, pendingAi: { kind: 'codex', model: 'gpt-6-sol', effortTier: 'high', effortOverride: null } });
    const d = seedDirective(e);
    const t = e.core.tasks.create({ directiveId: d.id, title: '구현', goal: '목표', type: 'development', assigneeId: e.devId, acceptanceCriteria: ['동작'], outputMode: 'repo' }, e.producerId);
    await e.drain(1);
    const first = e.launches.find((l) => l.workKey === `task:${t.id}`)!;
    expect(first).toMatchObject({ model: 'gpt-6-sol', effort: 'high' });
    expect(e.ctx.store.members.require(e.devId)).toMatchObject({ pendingAi: null, ai: { model: 'gpt-6-sol', effortTier: 'high' } });
  });
});

describe('진행 중 세션은 첫 턴의 모델·노력치를 끝까지 쓴다 (F9, 19.1)', () => {
  it('프로듀서 AI를 바꿔도 진행 중 지시 세션은 이전 값으로 이어 가고, 새 지시는 새 값으로 시작한다', async () => {
    env = await bootOrch({ mock: false });
    const e = env;
    const d1 = e.core.directives.register({ projectId: e.projectId, title: '지시 1', text: '지시 1' }, 'M-MAIN', null);
    await e.drain(1);
    const first = e.launches.filter((l) => l.workKey === directiveKey(d1.id));
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ model: null, effort: 'high', resume: null });
    const cliSession = first[0]!.newSessionId;
    expect(cliSession).toBeTruthy();

    const r = await call(e, 'set_member_ai', { member_id: e.producerId, model: 'haiku', effort: 'low', reason: '가벼운 정리' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toMatchObject({ openSessionsKeepPreviousAi: [directiveKey(d1.id)] });
    expect(e.ctx.store.members.require(e.producerId).ai).toMatchObject({ model: 'haiku', effortOverride: 'low' });

    await e.drain(1); // 계획 재촉 턴 — 같은 CLI 세션을 이전 모델·노력치로 이어 간다
    const second = e.launches.filter((l) => l.workKey === directiveKey(d1.id));
    expect(second).toHaveLength(2);
    expect(second[1]).toMatchObject({ resume: cliSession, model: null, effort: 'high' });

    const d2 = e.core.directives.register({ projectId: e.projectId, title: '지시 2', text: '지시 2' }, 'M-MAIN', null);
    // 팀원당 턴은 하나씩 — 지시 1의 재촉이 먼저 돌 수 있다
    for (let i = 0; i < 4 && !e.launches.some((l) => l.workKey === directiveKey(d2.id)); i++) await e.drain(1);
    expect(e.launches.find((l) => l.workKey === directiveKey(d2.id))).toMatchObject({ resume: null, model: 'haiku', effort: 'low' });
    // 지시 1 세션은 끝까지 이전 값
    expect(e.launches.filter((l) => l.workKey === directiveKey(d1.id)).every((l) => l.model === null && l.effort === 'high')).toBe(true);
  });

  it('메인 에이전트는 운영자가 운영 설정에서 바꾸면 같은 세션의 다음 턴부터 적용된다 (AGT-08)', async () => {
    env = await bootOrch({ mock: false });
    const e = env;
    await e.invoke('command.send', { target: e.projectId, text: '상태 알려줘' });
    await e.drain(1);
    const key = `main:${e.projectId}`;
    const first = e.launches.filter((l) => l.workKey === key);
    expect(first[0]).toMatchObject({ model: null, effort: 'high' });
    await e.internal('settings.update', { general: { mainAgent: { kind: 'claude', model: 'opus', effortTier: 'high', effortOverride: 'max' } } });
    await e.invoke('command.send', { target: e.projectId, text: '다시 알려줘' });
    await e.drain(1);
    const second = e.launches.filter((l) => l.workKey === key);
    expect(second[1]).toMatchObject({ resume: first[0]!.newSessionId, model: 'opus', effort: 'max' });
  });
});
