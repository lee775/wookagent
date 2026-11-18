/**
 * 채용할 때 정하는 모델·노력치, 바꿀 수 없는 직원, 퇴직 → 채용 → 인수인계 (대표 지시 2026-11-18):
 * - "클로드 지피티 각 모델별 장점이랑 노력치 중요성 적어두고 메인 에이전트 판단하에 노력치랑 모델 알아서 선택해서 직원으로 채용하도록 해줘"
 * - "한번 정해진 직원은 바꿀 수 없어 대신 퇴직시키고 다른 직원 채용하는쪽으론 가능해 그 중간과정에 인수인계도 필요하다면 하도록 만들어야하고"
 */
import { afterEach, describe, expect, it } from 'vitest';
import { EFFORT_LEVELS, MAIN_AGENT_ID, OPERATOR } from '../../src/shared/domain';
import { DEFAULT_MODEL_CATALOG, OLD_DEFAULT_MODEL_NOTES } from '../../src/main/orchestrator/aiGuide';
import { MODEL_CATALOG_KEY, migrateModelCatalog } from '../../src/main/orchestrator/migrations';
import type { OrchEnv } from './orchHarness';
import { bootOrch, seedDirective, waitFor } from './orchHarness';

let env: OrchEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
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
const member = (e: OrchEnv, id: string) => e.ctx.store.members.require(id);
const live = (e: OrchEnv) => e.ctx.store.members.list({ project_id: e.projectId, state: 'active' });
const records = (e: OrchEnv, text: string): string[] => e.ctx.store.activity.search({ text, limit: 20 }).map((r) => r.text);
const queued = (e: OrchEnv, sessionKey: string): string[] => e.ctx.store.queue.list({ ref2: sessionKey, state: 'queued' }).map((q) => q.message);
/** 개발자에게 작업 하나 (저장소 변경형) */
function devTask(e: OrchEnv, title = '구현'): string {
  const d = seedDirective(e);
  return e.core.tasks.create({ directiveId: d.id, title, goal: '목표', type: 'development', assigneeId: e.devId, acceptanceCriteria: ['동작'], outputMode: 'repo' }, e.producerId).id;
}
/** 그 작업의 담당이 턴을 돌리고 있게 한다 — 가짜 CLI는 끝낼 때까지 산다 */
async function working(e: OrchEnv, taskId: string, memberId: string): Promise<string> {
  const key = `task:${taskId}`;
  e.hold.add(key);
  e.tick();
  await waitFor(() => !!e.liveProc(key, memberId), `${memberId}의 작업 턴 시작`);
  return e.liveProc(key, memberId)!.turnId;
}
const HIRE = { ai_kind: 'codex', model: 'gpt-6.2-sol', effort_tier: 'high', reason: '어려운 구현으로 바뀜' } as const;

describe('채용 안내 — 모델마다의 장점과 노력치', () => {
  it('list_ai_options가 모델마다의 장점(models의 note)과 노력치 안내·고르는 차례(guide)를 준다', async () => {
    env = await bootOrch();
    const o = (await env.main('list_ai_options')) as {
      models: Record<'claude' | 'codex', { id: string; label: string; note: string }[]>;
      guide: { effort: { what: string; why: string[]; levels: { value: string; use: string }[]; howToSet: string }; hiring: string[] };
    };
    expect(o.models.claude.map((m) => m.id)).toEqual(['fable', 'opus', 'sonnet', 'haiku']);
    // 첫 Codex 항목은 모델을 정하지 않은 Codex 직원이 쓰는 모델이다 — 앞 판과 같게 둔다
    expect(o.models.codex.map((m) => m.id)).toEqual(['gpt-6-sol', 'gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-6.1-terra', 'gpt-6-luna']);
    for (const m of [...o.models.claude, ...o.models.codex]) expect(m.note.length, m.id).toBeGreaterThan(15);
    // 노력치: 무엇인지, 왜 중요한지, 값마다 맞는 일 — 두 AI 종류가 받는 값 모두
    expect(o.guide.effort.what).toContain('노력치는');
    expect(o.guide.effort.why.length).toBeGreaterThanOrEqual(3);
    expect(o.guide.effort.levels.map((l) => l.value)).toEqual([...EFFORT_LEVELS.claude]);
    expect([...EFFORT_LEVELS.codex]).toEqual([...EFFORT_LEVELS.claude]);
    for (const l of o.guide.effort.levels) expect(l.use.length, l.value).toBeGreaterThan(5);
    // AI 종류마다의 노력치 안내 — Claude와 Codex(GPT) 둘 다, 목록의 모델 계열을 짚는다
    const byKind = (o.guide.effort as unknown as { byKind: Record<'claude' | 'codex', string[]> }).byKind;
    expect(byKind.claude.join(' ')).toMatch(/Fable.*Sonnet.*Haiku/s);
    expect(byKind.codex.join(' ')).toMatch(/GPT-6\.2 Sol.*GPT-6\.2 Astra.*GPT-6 Luna/s);
    expect(o.guide.hiring.join(' ')).toContain('replace_member');
    expect(o.guide.hiring.join(' ')).toContain('add_member');
  });

  it('앞 판의 모델 목록: 그대로인 설명은 새 설명으로, 새 GPT 모델은 끝에 더한다 — 고친 설명·지운 모델·직접 더한 모델은 그대로, 한 번만', async () => {
    env = await bootOrch();
    const e = env;
    const old = (id: string) => ({ id, ...OLD_DEFAULT_MODEL_NOTES[id]! });
    // 앞 판의 데이터: fable은 지웠고, sonnet의 설명은 고쳤고, 직접 더한 모델이 하나 있다
    await e.internal('settings.update', {
      team: { modelCatalog: { claude: [old('opus'), { id: 'sonnet', label: 'Sonnet', note: '우리 팀 기본' }, old('haiku'), { id: 'claude-custom', label: '직접 더한 모델', note: '' }], codex: [old('gpt-6-sol')] } },
    });
    e.ctx.store.kv.set(MODEL_CATALOG_KEY, null);

    migrateModelCatalog(e.ctx);
    const c = e.ctx.settings().team.modelCatalog!;
    const byId = (id: string) => DEFAULT_MODEL_CATALOG.claude.concat(DEFAULT_MODEL_CATALOG.codex).find((m) => m.id === id)!;
    expect(c.claude).toEqual([byId('opus'), { id: 'sonnet', label: 'Sonnet', note: '우리 팀 기본' }, byId('haiku'), { id: 'claude-custom', label: '직접 더한 모델', note: '' }]);
    expect(c.codex).toEqual([byId('gpt-6-sol'), byId('gpt-6.2-sol'), byId('gpt-6.2-astra'), byId('gpt-6.1-terra'), byId('gpt-6-luna')]);
    const rec = records(e, '데이터 이전 (모델 목록)');
    expect(rec).toHaveLength(1);
    expect(rec[0]).toContain('gpt-6.2-sol 추가');
    expect(rec[0]).toContain('opus 설명');
    expect(rec[0]).not.toContain('fable');
    expect(rec[0]).not.toContain('sonnet');

    // 한 번 한 뒤에는 다시 맞추지 않는다 — 그 뒤에 지운 모델을 되살리지 않는다
    await e.internal('settings.update', { team: { modelCatalog: { ...c, codex: [byId('gpt-6-sol')] } } });
    migrateModelCatalog(e.ctx);
    expect(e.ctx.settings().team.modelCatalog!.codex).toEqual([byId('gpt-6-sol')]);
    expect(records(e, '데이터 이전 (모델 목록)')).toHaveLength(1);
  });

  it('새 데이터 폴더는 새 기본 목록으로 시작하고 이미 맞춘 것으로 적힌다', async () => {
    env = await bootOrch();
    expect(env.ctx.settings().team.modelCatalog).toEqual(DEFAULT_MODEL_CATALOG);
    expect(env.ctx.store.kv.get(MODEL_CATALOG_KEY)).toBeTruthy();
    expect(records(env, '데이터 이전 (모델 목록)')).toHaveLength(0);
  });
});

describe('채용할 때 모델과 노력치를 함께 정한다', () => {
  it('노력치 없이 모델만 준 결정은 거부한다 — add_member와 처음 정하는 set_member_ai', async () => {
    env = await bootOrch();
    const e = env;
    const before = live(e).length;
    const add = await tryMain(e, 'add_member', { project_id: e.projectId, role_id: 'docs', model: 'haiku', reason: '문서' });
    expect(add.code).toBe('invalid');
    expect(add.message).toContain('노력치를 정하지 않았습니다');
    expect(add.message).toContain('guide.effort');
    expect(live(e)).toHaveLength(before);
    const set = await tryMain(e, 'set_member_ai', { member_id: e.qaId, model: 'opus', reason: '검수' });
    expect(set.code).toBe('invalid');
    expect(set.message).toContain('노력치를 정하지 않았습니다');
    expect(member(e, e.qaId).ai).toMatchObject({ model: null });
    // 실제 값(effort)으로 정해도 된다
    expect(await tryMain(e, 'set_member_ai', { member_id: e.qaId, model: 'opus', effort: 'xhigh', reason: '어려운 검수' })).toEqual({ code: null, message: '' });
    expect(member(e, e.qaId).ai).toMatchObject({ model: 'opus', effortOverride: 'xhigh' });
  });
});

describe('한 번 정한 직원의 AI는 바꿀 수 없다', () => {
  it('메인이 정한 직원은 set_member_ai로 바꾸지 못하고 replace_member를 알려 준다 — 모델도 노력치도 종류도', async () => {
    env = await bootOrch();
    const e = env;
    const m = await e.main('add_member', { project_id: e.projectId, role_id: 'docs', model: 'haiku', effort_tier: 'low', reason: '단순 문서' });
    const id = String(m.memberId);
    await e.main('set_member_ai', { member_id: e.qaId, model: 'sonnet', effort_tier: 'normal', reason: '검수' });
    for (const [target, args] of [
      [id, { model: 'opus' }],
      [id, { effort_tier: 'high' }],
      [id, { ai_kind: 'codex', model: 'gpt-6.2-sol', effort_tier: 'normal' }],
      [e.qaId, { effort: 'max' }],
    ] as const) {
      const before = member(e, target);
      const r = await tryMain(e, 'set_member_ai', { member_id: target, ...args, reason: '바꾸기 (시험)' });
      expect(r.code, JSON.stringify(args)).toBe('forbidden');
      expect(r.message).toContain('한 번 정한 직원의 AI는 바꿀 수 없습니다');
      expect(r.message).toContain(`replace_member(member_id="${target}", …)`);
      expect(member(e, target)).toEqual(before);
    }
    expect(e.core.team.aiFixed(member(e, id))).toBe(true);
  });

  it('프로듀서는 replace_producer를 알려 준다. 아직 정하지 않은 직원과 운영자가 정한 직원은 한 번 정할 수 있다', async () => {
    env = await bootOrch();
    const e = env;
    expect(e.core.team.aiFixed(member(e, e.producerId))).toBe(false);
    await e.main('set_member_ai', { member_id: e.producerId, model: 'opus', effort_tier: 'high', reason: '계획' });
    const r = await tryMain(e, 'set_member_ai', { member_id: e.producerId, model: 'sonnet', reason: '바꾸기 (시험)' });
    expect(r.code).toBe('forbidden');
    expect(r.message).toContain(`replace_producer(project_id="${e.projectId}", …)`);
    // 운영자(내부 API)의 설정은 정한 것이 아니다 — 메인이 한 번 정한다. 운영자는 그 뒤에도 바꿀 수 있다(시험·복구 준비)
    e.core.team.update(e.devId, { ai: { kind: 'claude', model: 'opus', effortTier: 'normal', effortOverride: null } }, OPERATOR);
    expect(e.core.team.aiFixed(member(e, e.devId))).toBe(false);
    expect(await tryMain(e, 'set_member_ai', { member_id: e.devId, effort_tier: 'high', reason: '어려운 구현' })).toEqual({ code: null, message: '' });
    expect(e.core.team.aiFixed(member(e, e.devId))).toBe(true);
    const m = await e.internal('members.update', e.devId, { ai: { kind: 'codex', model: 'gpt-6-sol', effortTier: 'low', effortOverride: null } });
    expect(m.ai).toMatchObject({ kind: 'codex', model: 'gpt-6-sol' });
  });

  it('이 규칙 전에 메인이 정했지만 모델이 빈 직원은 모델을 한 번 채울 수 있다 — 그 뒤에는 바꿀 수 없다', async () => {
    env = await bootOrch();
    const e = env;
    e.ctx.store.members.patch(e.qaId, { aiDecision: { by: MAIN_AGENT_ID, reason: '예전 결정', at: e.ctx.now() } });
    expect(e.core.team.aiFixed(member(e, e.qaId))).toBe(false);
    expect(await tryMain(e, 'set_member_ai', { member_id: e.qaId, model: 'sonnet', reason: '모델 정함' })).toEqual({ code: null, message: '' });
    expect((await tryMain(e, 'set_member_ai', { member_id: e.qaId, model: 'opus', reason: '바꾸기 (시험)' })).code).toBe('forbidden');
  });
});

describe('정해진 직원의 턴이 시작하지 못할 때', () => {
  it('설정이 원인일 수 있다는 알림은 set_member_ai가 아니라 교체(replace_member)를 말한다', async () => {
    env = await bootOrch();
    const e = env;
    await e.main('set_member_ai', { member_id: e.devId, model: 'gpt-6.2-astra', effort_tier: 'high', reason: '어려운 구현' });
    const taskId = devTask(e);
    const key = `task:${taskId}`;
    expect(await e.core.tasks.activateForLaunch(taskId)).toBe(true);
    e.hold.add(`main:${e.projectId}`);
    e.prepareHook = (_launch, who) => {
      if (who.sessionKey === key) throw new Error('모델 이름을 찾을 수 없습니다 (시험)');
    };
    await waitFor(
      () => {
        if (e.core.turns.count() === 0) e.tick();
        return e.ctx.store.tasks.require(taskId).state === 'on_hold';
      },
      '시작 실패 보류',
      30_000,
    );
    const alerts = e.ctx.store.queue
      .list({ ref1: MAIN_AGENT_ID })
      .map((q) => q.message)
      .filter((m) => m.includes(taskId) && m.includes('팀원 설정'));
    expect(alerts.length).toBeGreaterThanOrEqual(1);
    expect(alerts[0]).toContain('AI가 이미 정해진 직원이라 설정을 바꿀 수 없습니다');
    expect(alerts[0]).toContain(`replace_member(member_id="${e.devId}", …)로 다른 모델의 직원으로 교체하세요`);
    expect(alerts[0]).not.toContain('set_member_ai(member_id=');
  });
});

describe('직원 교체 — 퇴직 → 채용 → 인수인계 (replace_member)', () => {
  it('하던 일이 없으면 바로 바꾼다: 새 직원은 정한 AI로 같은 역할에 채용되고, 앞 직원은 퇴직한다', async () => {
    env = await bootOrch();
    const e = env;
    const oldName = member(e, e.devId).name;
    const r = await e.main('replace_member', { member_id: e.devId, ...HIRE });
    expect(r).toMatchObject({ status: 'replaced', retiredMemberId: e.devId, retiredName: oldName, model: 'gpt-6.2-sol', effort: 'high', tasks: [] });
    const hired = member(e, String(r.memberId));
    expect(hired).toMatchObject({ roleId: 'developer', projectId: e.projectId, deletedAt: null, ai: { kind: 'codex', model: 'gpt-6.2-sol', effortTier: 'high' }, aiDecision: { by: MAIN_AGENT_ID, reason: HIRE.reason } });
    expect(e.core.team.isPersonName(hired.name)).toBe(true);
    expect(hired.name).not.toBe(oldName);
    expect(member(e, e.devId).deletedAt).toBeTruthy();
    expect(e.core.team.aiFixed(hired)).toBe(true);
    const rec = records(e, '직원 교체:');
    expect(rec).toHaveLength(1);
    expect(rec[0]).toContain(`${oldName}(${e.devId}, codex gpt-6-sol, 노력치 medium) 퇴직 → ${hired.name}(${hired.id}, codex gpt-6.2-sol, 노력치 high) 채용 — 넘긴 작업 없음`);
  });

  it('새 직원의 AI가 빠지면 거부하고 아무것도 바꾸지 않는다. 프로듀서·메인 에이전트는 이 도구로 바꾸지 않는다', async () => {
    env = await bootOrch();
    const e = env;
    const before = live(e).map((m) => m.id);
    const noModel = await tryMain(e, 'replace_member', { member_id: e.devId, effort_tier: 'high', reason: '시험' });
    expect(noModel.code).toBe('invalid');
    const noEffort = await tryMain(e, 'replace_member', { member_id: e.devId, model: 'gpt-6.2-sol', reason: '시험' });
    expect(noEffort.code).toBe('invalid');
    expect(noEffort.message).toContain('노력치를 정하지 않았습니다');
    const wrongKind = await tryMain(e, 'replace_member', { member_id: e.devId, ai_kind: 'claude', model: 'gpt-6.2-sol', effort_tier: 'high', reason: '시험' });
    expect(wrongKind.code).toBe('invalid');
    const producer = await tryMain(e, 'replace_member', { member_id: e.producerId, model: 'opus', effort_tier: 'high', reason: '시험' });
    expect(producer.code).toBe('invalid');
    expect(producer.message).toContain(`replace_producer(project_id="${e.projectId}", …)`);
    expect((await tryMain(e, 'replace_member', { member_id: MAIN_AGENT_ID, model: 'opus', effort_tier: 'high', reason: '시험' })).code).toBe('forbidden');
    expect(live(e).map((m) => m.id)).toEqual(before);
  });

  it('아직 시작하지 않은 작업은 메모를 묻지 않고 새 직원에게 넘긴다 — 넘긴 내역이 작업에 남는다', async () => {
    env = await bootOrch();
    const e = env;
    // 스케줄러가 돌기 전이라 대기 상태다
    const taskId = devTask(e);
    expect(e.ctx.store.tasks.require(taskId).state).toBe('waiting');
    const r = await e.main('replace_member', { member_id: e.devId, ...HIRE });
    expect(r).toMatchObject({ status: 'replaced', tasks: [{ taskId, memo: false }] });
    const hiredId = String(r.memberId);
    expect(e.ctx.store.tasks.require(taskId)).toMatchObject({ assigneeId: hiredId, state: 'waiting' });
    expect(e.core.team.handoversFor(taskId)).toMatchObject([{ fromId: e.devId, toId: hiredId, state: 'waiting', memo: null }]);
    expect(member(e, e.devId).deletedAt).toBeTruthy();
    expect(records(e, '직원 교체:')[0]).toContain(`넘긴 작업 ${taskId}(메모 없음)`);
  });

  it('하고 있는 작업이 있으면 인수인계 메모를 먼저 요청하고 바꾸지 않은 채 한 번 거부한다. 메모가 오면 메인에게 알리고, 같은 인자로 다시 부르면 바꿔서 새 직원의 작업 카드에 메모가 실린다', async () => {
    env = await bootOrch();
    const e = env;
    const taskId = devTask(e);
    const key = `task:${taskId}`;
    const turnId = await working(e, taskId, e.devId);
    const before = live(e).map((m) => m.id);

    // 같은 request_id로 다시 불러도 되게 — 결과가 아니라 한 번 거부한다(성공한 결과는 request_id로 저장된다)
    const args = { member_id: e.devId, ...HIRE, request_id: 'rq-replace-1' };
    const first = await tryMain(e, 'replace_member', args);
    expect(first.code).toBe('conflict');
    expect(first.message).toContain(`인수인계 대기: ${member(e, e.devId).name}(${e.devId})이(가) 하고 있는 작업 ${taskId}의 인수인계 메모를 요청했습니다`);
    expect(first.message).toContain('아직 아무것도 바꾸지 않았습니다');
    expect(first.message).toContain('handover: "skip"');
    // 아무것도 바뀌지 않았다 — 담당·팀·작업 상태
    expect(live(e).map((m) => m.id)).toEqual(before);
    expect(e.ctx.store.tasks.require(taskId)).toMatchObject({ assigneeId: e.devId, state: 'in_progress' });
    // 그 직원의 작업 세션에 인수인계 요청이 한 번 간다
    const asks = () => queued(e, key).filter((t) => t.includes('퇴직 인수인계 요청'));
    expect(asks()).toHaveLength(1);
    expect(asks()[0]).toContain('write_handover(memo)');
    // 메모가 오기 전에 다시 불러도 그대로다 — 요청을 다시 보내지 않는다
    expect((await tryMain(e, 'replace_member', args)).code).toBe('conflict');
    expect(asks()).toHaveLength(1);
    expect(live(e).map((m) => m.id)).toEqual(before);

    // 그 직원이 메모를 남긴다
    const memo = '로그인 폼까지 만들었고 서버 검증은 아직이다. auth.ts의 토큰 갱신은 확인하지 못했다.';
    const w = await e.tool(turnId, 'write_handover', { memo });
    expect(w).toMatchObject({ ok: true, data: { taskId, saved: true } });
    const told = queued(e, `main:${e.projectId}`).filter((t) => t.includes('인수인계 메모를 남겼습니다'));
    expect(told).toHaveLength(1);
    expect(told[0]).toContain(`replace_member(member_id="${e.devId}", …)`);

    // 다시 부르면 채용 → 인수인계 → 퇴직
    const done = await e.main('replace_member', args);
    expect(done).toMatchObject({ status: 'replaced', retiredMemberId: e.devId, tasks: [{ taskId, memo: true }] });
    expect(done).not.toHaveProperty('duplicateRequest');
    const hiredId = String(done.memberId);
    expect(member(e, e.devId).deletedAt).toBeTruthy();
    expect(e.ctx.store.tasks.require(taskId).assigneeId).toBe(hiredId);
    expect(records(e, '직원 교체:')[0]).toContain(`넘긴 작업 ${taskId}(인수인계 메모 있음)`);

    // 새 직원이 그 작업을 시작하면 작업 카드에 앞 담당의 메모가 있다
    // 앞 담당의 턴이 마무리된 뒤의 스케줄러 차례에 새 직원의 턴이 뜬다 (시험은 스케줄러를 손으로 돌린다)
    await waitFor(() => {
      e.tick();
      return !!e.liveProc(key, hiredId);
    }, '새 직원의 작업 턴 시작');
    expect(e.liveProc(key, e.devId)).toBeUndefined();
    const ctx = await e.tool(e.liveProc(key, hiredId)!.turnId, 'get_work_context', {});
    expect(ctx.ok).toBe(true);
    if (!ctx.ok) return;
    const card = (ctx.data as { task: { id: string; handover?: { from: string; fromAi: string; memo: string | null }[] } }).task;
    expect(card.id).toBe(taskId);
    expect(card.handover).toHaveLength(1);
    expect(card.handover![0]).toMatchObject({ fromAi: 'codex gpt-6-sol, 노력치 medium', memo });
    expect(card.handover![0]!.from).toContain(`(${e.devId})`);
  });

  it('handover: "skip"이면 하고 있는 작업이 있어도 메모 없이 바로 바꾼다 — 그 직원이 답할 수 없을 때', async () => {
    env = await bootOrch();
    const e = env;
    const taskId = devTask(e);
    await working(e, taskId, e.devId);
    const r = await e.main('replace_member', { member_id: e.devId, ...HIRE, handover: 'skip' });
    expect(r).toMatchObject({ status: 'replaced', tasks: [{ taskId, memo: false }] });
    expect(e.ctx.store.tasks.require(taskId).assigneeId).toBe(String(r.memberId));
    expect(member(e, e.devId).deletedAt).toBeTruthy();
    expect(queued(e, `task:${taskId}`).filter((t) => t.includes('퇴직 인수인계 요청'))).toHaveLength(0);
  });

  it('인수인계 메모는 그 작업을 맡은 직원이 그 작업의 턴에서만 남긴다', async () => {
    env = await bootOrch();
    const e = env;
    const taskId = devTask(e);
    const turnId = await working(e, taskId, e.devId);
    expect(await e.tool(turnId, 'write_handover', { memo: '   ' })).toMatchObject({ ok: false, code: 'invalid' });
    // 요청받지 않은 메모도 남길 수 있다 — 메인에게 알리지는 않는다
    expect(await e.tool(turnId, 'write_handover', { memo: '미리 적어 둔다' })).toMatchObject({ ok: true });
    expect(queued(e, `main:${e.projectId}`).filter((t) => t.includes('인수인계 메모를 남겼습니다'))).toHaveLength(0);
    // 미리 남긴 메모가 있으면 교체는 묻지 않고 바로 한다
    const r = await e.main('replace_member', { member_id: e.devId, ...HIRE });
    expect(r).toMatchObject({ status: 'replaced', tasks: [{ taskId, memo: true }] });
  });
});
