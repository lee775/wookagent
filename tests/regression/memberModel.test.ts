/**
 * 메인 에이전트가 팀원의 AI를 정할 때는 모델도 정한다 (대표 지시 2026-11-18: "ai랑 노력치말고 모델도 정할 수 있게 해줘").
 * - 그 전에는 모델을 비운 결정도 받았다 — 역할 기본값에 모델이 없어서, 메인이 AI 종류·노력치만 정하면 팀원이 'CLI 기본 모델'로 남았다.
 * - 이제: 정한 결과에 모델이 없으면 거부하고 그 AI 종류의 모델 목록을 알려 준다(목록이 빈 AI 종류만 CLI 기본 모델). 이 규칙 전의 팀원은 데이터
 *   폴더를 처음 열 때 한 번, 메인 에이전트에게 모델을 정하라고 요청한다.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAIN_AGENT_ID } from '../../src/shared/domain';
import { MODEL_DECISIONS_KEY, migrateModelDecisions } from '../../src/main/orchestrator/migrations';
import type { OrchEnv } from './orchHarness';
import { bootOrch } from './orchHarness';

let env: OrchEnv | null = null;
const dirs: string[] = [];
afterEach(async () => {
  await env?.close();
  env = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const tryMain = async (e: OrchEnv, tool: string, args: Record<string, unknown>): Promise<{ code: string | null; message: string }> => {
  try {
    await e.main(tool, args);
    return { code: null, message: '' };
  } catch (err) {
    const x = err as { code?: string; message?: string };
    return { code: x.code ?? 'error', message: x.message ?? '' };
  }
};
const ai = (e: OrchEnv, id: string) => e.ctx.store.members.require(id).ai;
/** 메인 에이전트의 그 프로젝트 세션에 대기 중인 글 */
const mainQueue = (e: OrchEnv, projectId = e.projectId): string[] => e.ctx.store.queue.list({ ref2: `main:${projectId}`, state: 'queued' }).map((q) => q.message);
const NO_MODEL = '모델을 정하지 않았습니다';

describe('set_member_ai — 정한 결과에 모델이 없으면 거부한다', () => {
  it('모델을 주지 않은 결정·null은 거부하고 그 AI 종류의 모델 목록을 알려 준다 — 아무것도 바뀌지 않는다', async () => {
    env = await bootOrch();
    const e = env;
    const before = { dev: e.ctx.store.members.require(e.devId), qa: e.ctx.store.members.require(e.qaId) };
    expect(before.dev.ai).toMatchObject({ kind: 'codex', model: null });
    expect(before.qa.ai).toMatchObject({ kind: 'claude', model: null });

    const dev = await tryMain(e, 'set_member_ai', { member_id: e.devId, effort_tier: 'high', reason: '어려운 구현' });
    expect(dev.code).toBe('invalid');
    expect(dev.message).toContain(NO_MODEL);
    expect(dev.message).toContain('codex 모델: gpt-6-sol(');
    const qa = await tryMain(e, 'set_member_ai', { member_id: e.qaId, effort_tier: 'high', reason: '어려운 검수' });
    expect(qa.code).toBe('invalid');
    for (const id of ['fable', 'opus', 'sonnet', 'haiku']) expect(qa.message).toContain(`${id}(`);
    expect((await tryMain(e, 'set_member_ai', { member_id: e.qaId, model: null, reason: '기본 모델로' })).code).toBe('invalid');

    expect(e.ctx.store.members.require(e.devId)).toEqual(before.dev);
    expect(e.ctx.store.members.require(e.qaId)).toEqual(before.qa);
  });

  it('모델과 노력치를 함께 주면 받고 메인의 결정으로 남는다 (그 뒤의 변경은 staffReplace 시험)', async () => {
    env = await bootOrch();
    const e = env;
    expect(await tryMain(e, 'set_member_ai', { member_id: e.qaId, model: 'opus', effort_tier: 'high', reason: '어려운 검수' })).toEqual({ code: null, message: '' });
    expect(ai(e, e.qaId)).toMatchObject({ kind: 'claude', model: 'opus', effortTier: 'high' });
    expect(e.ctx.store.members.require(e.qaId).aiDecision).toMatchObject({ by: MAIN_AGENT_ID, reason: '어려운 검수' });
  });

  it('AI 종류를 바꾸면 그 종류의 모델을 함께 줘야 한다', async () => {
    env = await bootOrch();
    const e = env;
    const bare = await tryMain(e, 'set_member_ai', { member_id: e.qaId, ai_kind: 'codex', effort_tier: 'normal', reason: 'Codex로' });
    expect(bare.code).toBe('invalid');
    expect(bare.message).toContain('codex 모델: gpt-6-sol(');
    expect(ai(e, e.qaId)).toMatchObject({ kind: 'claude', model: null });
    expect(await tryMain(e, 'set_member_ai', { member_id: e.qaId, ai_kind: 'codex', model: 'gpt-6-sol', effort_tier: 'normal', reason: 'Codex로' })).toEqual({ code: null, message: '' });
    expect(ai(e, e.qaId)).toMatchObject({ kind: 'codex', model: 'gpt-6-sol' });
  });

  it('모델 목록이 빈 AI 종류는 고를 것이 없으므로 모델 없이 받는다', async () => {
    env = await bootOrch();
    const e = env;
    const s = e.ctx.settings();
    await e.internal('settings.update', { team: { modelCatalog: { ...s.team.modelCatalog!, claude: [] } } });
    expect(await tryMain(e, 'set_member_ai', { member_id: e.qaId, effort_tier: 'high', reason: '어려운 검수' })).toEqual({ code: null, message: '' });
    expect(ai(e, e.qaId)).toMatchObject({ kind: 'claude', model: null, effortTier: 'high' });
  });

  it('운영자(내부 API)의 설정은 그대로 받는다 — 시험·복구 준비', async () => {
    env = await bootOrch();
    const e = env;
    const m = await e.internal('members.update', e.qaId, { ai: { kind: 'claude', model: null, effortTier: 'low', effortOverride: null } });
    expect(m.ai).toMatchObject({ kind: 'claude', model: null, effortTier: 'low' });
  });
});

describe('add_member·replace_producer — AI를 직접 정하면 모델도 정한다', () => {
  it('AI 인자를 주고 모델을 비우면 거부하고 팀원을 만들지 않는다. 모델을 주면 메인의 결정으로 남는다', async () => {
    env = await bootOrch();
    const e = env;
    const count = () => e.ctx.store.members.list({ project_id: e.projectId, state: 'active' }).length;
    const before = count();
    const bare = await tryMain(e, 'add_member', { project_id: e.projectId, role_id: 'docs', effort_tier: 'low', reason: '문서' });
    expect(bare.code).toBe('invalid');
    expect(bare.message).toContain(NO_MODEL);
    // 역할 기본 AI(Claude)가 아닌 종류로 바꾸면서 모델을 비워도 같다
    expect((await tryMain(e, 'add_member', { project_id: e.projectId, role_id: 'docs', ai_kind: 'codex', reason: '문서' })).code).toBe('invalid');
    expect(count()).toBe(before);

    const m = await e.main('add_member', { project_id: e.projectId, role_id: 'docs', model: 'haiku', effort_tier: 'low', reason: '단순 문서' });
    expect(m).toMatchObject({ model: 'haiku' });
    expect(e.ctx.store.members.require(String(m.memberId))).toMatchObject({ ai: { kind: 'claude', model: 'haiku', effortTier: 'low' }, aiDecision: { by: MAIN_AGENT_ID, reason: '단순 문서' } });
    expect(count()).toBe(before + 1);
  });

  it('AI 인자 없이 추가하면 역할 기본값으로 만들고, 메인에게 가는 결정 요청이 모델을 정하라고 한다', async () => {
    env = await bootOrch();
    const e = env;
    const m = await e.main('add_member', { project_id: e.projectId, role_id: 'docs', reason: '문서' });
    expect(ai(e, String(m.memberId))).toMatchObject({ kind: 'claude', model: null });
    const asked = mainQueue(e).filter((t) => t.includes(`(${m.memberId}, `));
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('지금은 역할 기본값(claude, 모델 정하지 않음, 노력치 low)입니다');
    expect(asked[0]).toContain('모델과 노력치를 함께 정합니다(model, effort_tier 또는 effort) — 빠지면 거부됩니다');
    expect(asked[0]).toContain('한 번 정하면 그 직원의 AI는 바꿀 수 없습니다');
  });

  it('프로듀서 교체도 같다 — 모델을 비운 AI 인자는 거부하고 프로듀서를 바꾸지 않는다', async () => {
    env = await bootOrch();
    const e = env;
    const bare = await tryMain(e, 'replace_producer', { project_id: e.projectId, ai_kind: 'claude', effort_tier: 'high', reason: '프로듀서 교체 (시험)' });
    expect(bare.code).toBe('invalid');
    expect(bare.message).toContain(NO_MODEL);
    expect(e.ctx.store.projects.require(e.projectId).producerId).toBe(e.producerId);
    const v = await e.main('replace_producer', { project_id: e.projectId, ai_kind: 'claude', model: 'opus', effort_tier: 'high', reason: '프로듀서 교체 (시험)' });
    expect(ai(e, String(v.producerId))).toMatchObject({ kind: 'claude', model: 'opus' });
  });
});

describe('이 규칙 전의 팀원 — 처음 열 때 한 번, 메인 에이전트에게 모델을 정하라고 요청한다', () => {
  /** 두 번째 프로젝트를 등록한다 (운영자 내부 API) */
  async function secondProject(e: OrchEnv, name: string): Promise<{ id: string; producerId: string }> {
    const root = mkdtempSync(join(tmpdir(), 'wook-reg-model-'));
    dirs.push(root);
    const p = await e.internal('projects.create', { mode: 'new', path: join(root, 'b'), name, checkCommands: [] });
    return { id: p.id, producerId: p.producerId };
  }

  it('모델이 없는 팀원만 프로젝트마다 한 글로 묶어 요청하고, 활동 기록에 남기고, 다시 하지 않는다', async () => {
    env = await bootOrch();
    const e = env;
    const b = await secondProject(e, '둘째');
    // 이미 모델이 정해진 팀원은 요청에 넣지 않는다
    await e.main('set_member_ai', { member_id: e.qaId, model: 'sonnet', effort_tier: 'normal', reason: '검수' });
    const queued = { a: mainQueue(e).length, b: mainQueue(e, b.id).length };
    e.ctx.store.kv.set(MODEL_DECISIONS_KEY, null);

    migrateModelDecisions(e.core);
    const name = (id: string) => e.ctx.store.members.require(id).name;
    const a = mainQueue(e).filter((t) => t.includes('모델이 정해져 있지 않습니다'));
    expect(a).toHaveLength(1);
    expect(a[0]).toContain(`프로젝트 ${e.projectId}의 팀원 2명은 모델이 정해져 있지 않습니다`);
    expect(a[0]).toContain(`${name(e.producerId)}(${e.producerId}, 프로듀서, claude)`);
    expect(a[0]).toContain(`${name(e.devId)}(${e.devId}, 개발자, codex)`);
    expect(a[0]).not.toContain(`(${e.qaId}, `);
    expect(a[0]).not.toContain(MAIN_AGENT_ID);
    expect(a[0]).toContain('set_member_ai(member_id, model, effort_tier, reason)');
    const other = mainQueue(e, b.id).filter((t) => t.includes('모델이 정해져 있지 않습니다'));
    expect(other).toHaveLength(1);
    expect(other[0]).toContain(`프로젝트 ${b.id}의 팀원 1명은 모델이 정해져 있지 않습니다: ${name(b.producerId)}(${b.producerId}, 프로듀서, claude)`);
    const record = e.ctx.store.activity.search({ text: '데이터 이전 (팀원 모델)', limit: 10 }).map((r) => r.text);
    expect(record).toHaveLength(1);
    expect(record[0]).toContain('모델이 정해지지 않은 팀원 3명');
    expect(e.ctx.store.kv.get(MODEL_DECISIONS_KEY)).toMatchObject({ asked: 3 });

    // 한 번 한 뒤에는 다시 요청하지 않는다
    const after = { a: mainQueue(e).length, b: mainQueue(e, b.id).length };
    migrateModelDecisions(e.core);
    expect({ a: mainQueue(e).length, b: mainQueue(e, b.id).length }).toEqual(after);
    expect(after.a).toBeGreaterThanOrEqual(queued.a);
    expect(e.ctx.store.activity.search({ text: '데이터 이전 (팀원 모델)', limit: 10 })).toHaveLength(1);
  });

  it('모델이 모두 정해져 있으면 아무 요청도 기록도 남기지 않는다', async () => {
    env = await bootOrch();
    const e = env;
    for (const [id, model] of [
      [e.producerId, 'opus'],
      [e.devId, 'gpt-6-sol'],
      [e.qaId, 'sonnet'],
    ] as const) {
      await e.main('set_member_ai', { member_id: id, model, effort_tier: 'normal', reason: '시험 준비' });
    }
    const before = mainQueue(e).length;
    e.ctx.store.kv.set(MODEL_DECISIONS_KEY, null);
    migrateModelDecisions(e.core);
    expect(mainQueue(e)).toHaveLength(before);
    expect(e.ctx.store.activity.search({ text: '데이터 이전 (팀원 모델)', limit: 10 })).toHaveLength(0);
    expect(e.ctx.store.kv.get(MODEL_DECISIONS_KEY)).toMatchObject({ asked: 0 });
  });

  it('새 데이터 폴더는 시작할 때 이미 한 것으로 적힌다', async () => {
    env = await bootOrch();
    expect(env.ctx.store.kv.get(MODEL_DECISIONS_KEY)).toBeTruthy();
    expect(mainQueue(env).filter((t) => t.includes('모델이 정해져 있지 않습니다'))).toEqual([]);
  });
});
