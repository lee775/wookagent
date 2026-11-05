/**
 * 역할 규칙 (SERVER_DESIGN 7장·10.5 roleRules, 리드 결정 S5-13 — 초안의 ownerRoleLock을 대신한다):
 * - 기본 역할은 지울 수 없고(forbidden), 팀원이 있는 역할은 지울 수 없다(conflict). 프로듀서 역할의 검수 권한은 끌 수 없다(forbidden, REV-02)
 * - 기본 역할도 프로듀서의 검수 권한 말고는 모든 항목(이름·지침·작업 유형·기본 AI·허용 스킬·검수 권한)을 고칠 수 있다. 누가 만들었든 잠금은 없다
 * - 작은 고침: 역할 삭제도 활동 기록에 남고, 이름을 바꿀 때도 다른 역할과 겹치면 conflict이고, 역할까지 지운 지운 팀원의 상세는 '메인 에이전트'가 아니라
 *   지운 역할로 보인다
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Role } from '@shared/domain';
import { MAIN_AGENT_ID, OPERATOR } from '@shared/domain';
import { bootOrch, type OrchEnv } from './orchHarness';

let env: OrchEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const SOUND = { name: '사운드', instructions: '효과음과 배경음을 만든다', task_types: ['asset', 'research'], default_ai: { kind: 'claude', effort_tier: 'normal' }, can_review: false };
const rolesOf = (e: OrchEnv): Role[] => e.ctx.store.roles.list();

describe('역할 규칙 (roleRules)', () => {
  it('기본 역할 삭제는 forbidden — 메인 도구도 운영자 내부 API도, 아무것도 바뀌지 않는다', async () => {
    const e = (env = await bootOrch());
    const before = JSON.stringify(rolesOf(e));
    for (const id of ['producer', 'planner', 'architect', 'developer', 'ui_designer', 'qa', 'docs']) {
      await expect(e.main('delete_role', { role_id: id }), id).rejects.toMatchObject({ code: 'forbidden', message: '기본 역할은 삭제할 수 없습니다' });
    }
    await expect(e.internal('roles.delete', 'docs')).rejects.toMatchObject({ code: 'forbidden' });
    expect(JSON.stringify(rolesOf(e))).toBe(before);
    // 거부된 조작은 사유 기록·알림을 남기지 않는다
    expect(e.ctx.store.activity.search({ text: '(delete_role) — 사유:' })).toEqual([]);
    expect(e.ctx.store.activity.search({ text: '역할 삭제' })).toEqual([]);
  });

  it('프로듀서 역할의 검수 권한 끄기는 forbidden(메인 도구) — 운영자 내부 API는 켠 채로 둔다. 다른 기본 역할의 검수 권한은 끄고 켤 수 있다', async () => {
    const e = (env = await bootOrch());
    const producer = e.ctx.store.roles.require('producer');
    await expect(e.main('update_role', { role_id: 'producer', can_review: false })).rejects.toMatchObject({ code: 'forbidden', message: expect.stringContaining('프로듀서 역할의 검수 권한은 끌 수 없습니다') });
    // 다른 항목을 함께 줘도 하나도 바뀌지 않는다
    await expect(e.main('update_role', { role_id: 'producer', instructions: '바뀐 지침', can_review: false })).rejects.toMatchObject({ code: 'forbidden' });
    expect(e.ctx.store.roles.require('producer')).toEqual(producer);
    // 운영자 내부 API(roles.update)는 같은 처리기 — 프로듀서의 검수 권한은 그대로 켜 둔다
    const v = await e.internal('roles.update', 'producer', {
      name: producer.name,
      instructions: producer.instructions,
      taskTypes: producer.taskTypes,
      allowedSkills: producer.allowedSkills,
      defaultAi: producer.defaultAi,
      canReview: false,
    });
    expect(v.canReview).toBe(true);
    expect(e.ctx.store.roles.require('producer').canReview).toBe(true);
    // QA·설계자의 검수 권한은 끌 수 있고, 다른 역할에 줄 수도 있다
    expect(await e.main('update_role', { role_id: 'qa', can_review: false })).toMatchObject({ roleId: 'qa', canReview: false });
    expect(await e.main('update_role', { role_id: 'docs', can_review: true })).toMatchObject({ roleId: 'docs', canReview: true });
  });

  it('팀원이 있는 역할 삭제는 conflict — 팀원을 지우면 지울 수 있고, 지우기도 활동 기록에 남는다 (S5-13)', async () => {
    const e = (env = await bootOrch());
    const { roleId } = await e.main('create_role', SOUND);
    const m = await e.main('add_member', { project_id: e.projectId, role_id: roleId, reason: '사운드 팀원' });
    await expect(e.main('delete_role', { role_id: roleId })).rejects.toMatchObject({ code: 'conflict', message: '이 역할을 쓰는 팀원이 있습니다' });
    expect(e.ctx.store.roles.get(String(roleId))).not.toBeNull();
    await e.main('remove_member', { member_id: m.memberId });
    expect(await e.main('delete_role', { role_id: roleId, reason: '사운드 일이 끝남' })).toEqual({ deleted: roleId });
    expect(e.ctx.store.roles.get(String(roleId))).toBeNull();
    // 처리기의 기록(만들기·고치기처럼)과 메인의 사유 기록이 따로 남는다
    const rows = e.ctx.store.activity.search({ text: `역할 삭제 ${String(roleId)}` });
    expect(rows.map((r) => [r.actor, r.kind, r.text])).toEqual(
      expect.arrayContaining([
        [MAIN_AGENT_ID, 'settings', `역할 삭제 ${String(roleId)} 사운드`],
        [MAIN_AGENT_ID, 'settings', `메인 에이전트 역할 삭제 ${String(roleId)} 사운드 (delete_role) — 사유: 사운드 일이 끝남`],
      ]),
    );
    expect(rows).toHaveLength(2);
    // 운영자 내부 API로 지워도 같은 기록이 운영자 이름으로 남는다
    const op = await e.internal('roles.create', { name: '임시', instructions: '', taskTypes: ['docs'], allowedSkills: [], defaultAi: { kind: 'claude', model: null, effortTier: 'low', effortOverride: null }, canReview: false });
    await e.internal('roles.delete', op.id);
    expect(e.ctx.store.activity.search({ text: `역할 삭제 ${op.id}` }).map((r) => [r.actor, r.text])).toEqual([[OPERATOR, `역할 삭제 ${op.id} 임시`]]);
  });

  it('기본 역할도 프로듀서의 검수 권한 말고는 모든 항목을 고칠 수 있다 — 지침·이름·작업 유형·기본 AI·허용 스킬·검수 권한', async () => {
    const e = (env = await bootOrch());
    // 기본 역할 지침 수정은 된다 (10.5 roleRules)
    await e.main('update_role', { role_id: 'docs', instructions: '문서는 짧게 쓴다', reason: '대표 명령: 문서를 짧게' });
    expect(e.ctx.store.roles.require('docs').instructions).toBe('문서는 짧게 쓴다');
    await e.main('update_role', {
      role_id: 'docs',
      name: '기술 문서',
      task_types: ['docs', 'research', 'asset'],
      default_ai: { kind: 'codex', effort_tier: 'high' },
      allowed_skills: ['some-skill'],
      can_review: true,
    });
    expect(e.ctx.store.roles.require('docs')).toMatchObject({
      id: 'docs',
      builtin: true,
      name: '기술 문서',
      instructions: '문서는 짧게 쓴다',
      taskTypes: ['docs', 'research', 'asset'],
      defaultAi: { kind: 'codex', model: null, effortTier: 'high', effortOverride: null },
      allowedSkills: ['some-skill'],
      canReview: true,
      createdBy: 'seed',
    });
    // 프로듀서 역할도 검수 권한 말고는 고칠 수 있다
    await e.main('update_role', { role_id: 'producer', instructions: '계획을 짧게 세운다', task_types: ['plan', 'research'] });
    expect(e.ctx.store.roles.require('producer')).toMatchObject({ instructions: '계획을 짧게 세운다', taskTypes: ['plan', 'research'], canReview: true });
    // 대표 우선 잠금은 없다 — 예전에 대표가 만든 역할도 메인이 고친다
    const now = e.ctx.now();
    e.ctx.store.roles.insert({ id: 'role-0050', name: '대표가 만든 역할', instructions: '', taskTypes: ['docs'], allowedSkills: [], defaultAi: { kind: 'claude', model: null, effortTier: 'normal', effortOverride: null }, canReview: false, builtin: false, createdBy: 'owner', createdAt: now, updatedAt: now });
    await e.main('update_role', { role_id: 'role-0050', instructions: '메인이 고침' });
    expect(e.ctx.store.roles.require('role-0050')).toMatchObject({ instructions: '메인이 고침', createdBy: 'owner' });
  });

  it('이름을 바꿀 때도 다른 역할과 겹치면 conflict (만들 때와 같은 규칙, S5-13) — 제 이름 그대로는 된다', async () => {
    const e = (env = await bootOrch());
    const before = e.ctx.store.roles.require('docs');
    await expect(e.main('update_role', { role_id: 'docs', name: '개발자', instructions: '바뀐 지침' })).rejects.toMatchObject({ code: 'conflict', message: '같은 이름의 역할이 있습니다' });
    expect(e.ctx.store.roles.require('docs')).toEqual(before);
    await expect(e.main('create_role', { ...SOUND, name: '개발자' })).rejects.toMatchObject({ code: 'conflict' });
    const { roleId } = await e.main('create_role', SOUND);
    await expect(e.main('update_role', { role_id: 'qa', name: '사운드' })).rejects.toMatchObject({ code: 'conflict' });
    await expect(e.internal('roles.update', 'qa', { ...rolePatch(e.ctx.store.roles.require('qa')), name: '사운드' })).rejects.toMatchObject({ code: 'conflict' });
    expect(await e.main('update_role', { role_id: roleId, name: '사운드', instructions: '배경음도 만든다' })).toMatchObject({ roleId, name: '사운드' });
    expect(await e.main('update_role', { role_id: roleId, name: '음향' })).toMatchObject({ roleId, name: '음향' });
    // 바꾼 뒤에는 옛 이름을 다른 역할이 쓸 수 있다
    expect(await e.main('update_role', { role_id: 'docs', name: '사운드' })).toMatchObject({ roleId: 'docs', name: '사운드' });
  });

  it('역할까지 지운 지운 팀원의 상세는 메인 에이전트 역할이 아니라 지운 역할로 보인다 — 메인 에이전트의 상세는 그대로', async () => {
    const e = (env = await bootOrch());
    const { roleId } = await e.main('create_role', SOUND);
    const m = await e.main('add_member', { project_id: e.projectId, role_id: roleId, reason: '사운드 팀원' });
    await e.main('remove_member', { member_id: m.memberId });
    await e.main('delete_role', { role_id: roleId });
    const role = e.core.views.memberDetail(String(m.memberId)).role;
    expect(role).toMatchObject({ id: roleId, name: `지운 역할 (${String(roleId)})`, builtin: false, canReview: false });
    expect(role.name).not.toContain('메인 에이전트');
    expect(e.core.views.memberDetail(MAIN_AGENT_ID).role).toMatchObject({ id: 'main', name: '메인 에이전트', builtin: true });
  });
});

/** 역할 → roles.update 입력 (그대로) */
function rolePatch(r: Role) {
  return { name: r.name, instructions: r.instructions, taskTypes: r.taskTypes, allowedSkills: r.allowedSkills, defaultAi: r.defaultAi, canReview: r.canReview };
}
