/**
 * 역할을 만든 쪽 Role.createdBy (SERVER_DESIGN 7장, 리드 결정 S5-12) — 기록으로만 둔다(잠금 없음):
 * - 새로 쓰는 값: 기본 역할 'seed', 메인 에이전트(create_role) 'main', 운영자 내부 API 'operator'. list_roles·RoleView에 보인다
 * - 시작 때 옮김(멱등): 5단계 전에 저장된 역할(createdBy 없음)은 기본 역할 → 'seed', 그 밖은 '역할 추가 <id>' 활동 기록의 행위자(M-MAIN → 'main',
 *   운영자 → 'operator', 대표 → 'owner'), 그 기록이 없으면 'owner'(보관 기간보다 오래된 v0.6 전 역할). 다시 시작해도 같고 이전 기록은 한 번만 남는다
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Role } from '@shared/domain';
import { OWNER } from '@shared/domain';
import { bootRestartable, type RestartableEnv } from '../acceptance/stops-helpers';

let env: RestartableEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const SOUND = { name: '사운드', instructions: '효과음을 만든다', task_types: ['asset', 'research'], default_ai: { kind: 'claude', effort_tier: 'normal' }, can_review: false };
const opRole = (name: string) => ({ name, instructions: '', taskTypes: ['docs' as const], allowedSkills: [], defaultAi: { kind: 'claude' as const, model: null, effortTier: 'low' as const, effortOverride: null }, canReview: false });
const creators = (e: RestartableEnv) => Object.fromEntries(e.ctx.store.roles.list().map((r) => [r.id, r.createdBy]));
const migrationRows = (e: RestartableEnv) => e.ctx.store.activity.search({ text: '데이터 이전 (역할 만든 쪽)', limit: 50 });

describe('역할을 만든 쪽 (S5-12)', () => {
  it('새로 쓰는 값: 기본 역할 seed, 메인 에이전트 main, 운영자 operator — list_roles·RoleView에 보이고 이전 기록은 없다', async () => {
    const e = (env = await bootRestartable());
    const main = await e.main('create_role', SOUND);
    expect(main).toMatchObject({ createdBy: 'main' });
    const op = await e.internal('roles.create', opRole('운영자 역할'));
    expect(op.createdBy).toBe('operator');
    expect(creators(e)).toEqual({
      producer: 'seed',
      planner: 'seed',
      architect: 'seed',
      developer: 'seed',
      ui_designer: 'seed',
      qa: 'seed',
      docs: 'seed',
      [String(main.roleId)]: 'main',
      [op.id]: 'operator',
    });
    const listed = (await e.main('list_roles')) as unknown as { roleId: string; createdBy: string | null }[];
    expect(Object.fromEntries(listed.map((r) => [r.roleId, r.createdBy]))).toEqual(creators(e));
    expect(Object.fromEntries((await e.invoke('roles.list')).map((r) => [r.id, r.createdBy]))).toEqual(creators(e));
    expect(e.core.views.snapshot().roles.find((r) => r.id === main.roleId)).toMatchObject({ createdBy: 'main' });
    // 만든 쪽은 고쳐도 그대로 — 기록일 뿐 잠금이 아니다
    await e.main('update_role', { role_id: op.id, instructions: '메인이 고침' });
    expect(e.ctx.store.roles.require(op.id)).toMatchObject({ instructions: '메인이 고침', createdBy: 'operator' });
    expect(migrationRows(e)).toEqual([]);
  });

  it('5단계 전 역할은 시작 때 채운다 — 기본 역할 seed, 활동 기록의 행위자(메인 main·운영자 operator·대표 owner), 기록이 없으면 owner. 다시 시작해도 같다', async () => {
    let e = (env = await bootRestartable());
    const byMain = String((await e.main('create_role', SOUND)).roleId);
    const byOp = (await e.internal('roles.create', opRole('운영자 역할'))).id;
    // 예전 대표가 만든 역할 (대표 화면이 역할을 만들던 때의 기록)
    const now = e.ctx.now();
    const base: Omit<Role, 'id' | 'name'> = { instructions: '', taskTypes: ['docs'], allowedSkills: [], defaultAi: { kind: 'claude', model: null, effortTier: 'normal', effortOverride: null }, canReview: false, builtin: false, createdAt: now, updatedAt: now };
    e.ctx.store.roles.insert({ ...base, id: 'role-0040', name: '대표 역할' });
    e.ctx.activity({ kind: 'settings', actor: OWNER, text: '역할 추가 role-0040 대표 역할' });
    // 기록이 보관 기간보다 오래돼 지워진 역할 — 이름이 비슷한 다른 기록에 끌려가지 않는다
    e.ctx.store.roles.insert({ ...base, id: 'role-0041', name: '옛 역할' });
    e.ctx.activity({ kind: 'settings', actor: 'M-MAIN', text: '역할 추가 role-00410 다른 역할' });
    e.ctx.activity({ kind: 'settings', actor: 'M-MAIN', text: '메인 에이전트 역할 추가 role-0041 흉내 (create_role) — 사유: 글에만 있음' });
    // 5단계 전 DB처럼 만든 쪽을 지운다 (updatedAt은 그대로 두는지 본다)
    const stamp = Object.fromEntries(e.ctx.store.roles.list().map((r) => [r.id, r.updatedAt]));
    for (const r of e.ctx.store.roles.list()) {
      const { createdBy: _dropped, ...rest } = r;
      e.ctx.store.roles.put(rest as Role);
    }
    expect(Object.values(creators(e)).every((v) => v === undefined)).toBe(true);
    expect(e.core.views.roleView(e.ctx.store.roles.require('docs'))).not.toHaveProperty('createdBy');

    e.crash();
    e = env = await e.reboot();
    const want = {
      producer: 'seed',
      planner: 'seed',
      architect: 'seed',
      developer: 'seed',
      ui_designer: 'seed',
      qa: 'seed',
      docs: 'seed',
      [byMain]: 'main',
      [byOp]: 'operator',
      'role-0040': 'owner',
      'role-0041': 'owner',
    };
    expect(creators(e)).toEqual(want);
    expect(Object.fromEntries(e.ctx.store.roles.list().map((r) => [r.id, r.updatedAt]))).toEqual(stamp);
    const rows = migrationRows(e);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text).toContain('11건 채움');
    expect(rows[0]!.text).toContain(`${byMain} main`);

    // 다시 시작해도 같은 결과 — 이전 기록은 늘지 않는다
    e = env = await e.stopGracefully();
    expect(creators(e)).toEqual(want);
    expect(migrationRows(e)).toHaveLength(1);
    // 채운 값은 시작 때 다시 보지 않는다 — 기록이 바뀌어도 그대로
    e.ctx.activity({ kind: 'settings', actor: 'M-MAIN', text: '역할 추가 role-0041 옛 역할' });
    e = env = await e.stopGracefully();
    expect(e.ctx.store.roles.require('role-0041').createdBy).toBe('owner');
  });
});
