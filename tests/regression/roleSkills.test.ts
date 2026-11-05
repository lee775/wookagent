/**
 * 허용 스킬은 scanSkills로 찾은 것 중에서만 고른다 (SERVER_DESIGN 7장, 리드 결정 S5-14):
 * - create_role·update_role에 새로 넣는 이름만 찾은 스킬과 견준다. 이미 저장된 이름은 지금 찾지 못해도 그대로 둔다
 * - scanSkills가 없으면 찾은 스킬이 없으므로 새 이름은 모두 거부된다 — 아무것도 찾지 못한 이름은 받지 않는다
 * - 찾은 스킬 캐시는 대표 화면의 skills.list와 메인 도구가 함께 쓰고, 역할을 쓰면 지운다. 캐시에 없는 새 이름이면 한 번 새로 찾는다(방금 설치한 스킬)
 * - set_skill_mode도 같은 방법으로 이름을 본다 (이미 구분을 정해 둔 이름은 그대로 받는다). 운영자 내부 API도 같은 처리기다
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { DeepPartial } from '@shared/ipc';
import type { Settings } from '@shared/domain';
import { bootOrch, type OrchEnv } from './orchHarness';
import { seedStoredSettings } from './mainOps';

let env: OrchEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const SOUND = { name: '사운드', instructions: '효과음을 만든다', task_types: ['asset'], default_ai: { kind: 'claude', effort_tier: 'normal' }, can_review: false };
const reasonRows = (e: OrchEnv, tool: string) => e.ctx.store.activity.search({ text: `(${tool}) — 사유:` });

describe('허용 스킬 검사 (S5-14)', () => {
  it('create_role: 찾은 스킬에 없는 이름은 invalid이고 찾은 스킬 이름을 알려 준다 — 아무것도 만들지 않는다. 찾은 이름은 된다', async () => {
    const e = (env = await bootOrch());
    const before = e.ctx.store.roles.list().length;
    const err = await e.main('create_role', { ...SOUND, allowed_skills: ['sound-gen', 'nope'] }).catch((x: unknown) => x);
    expect(err).toMatchObject({ code: 'invalid' });
    expect((err as Error).message).toBe('허용 스킬은 찾은 스킬 중에서만 고를 수 있습니다 — 찾은 스킬에 없는 이름입니다: nope. 찾은 스킬: some-skill, sound-gen');
    expect(e.ctx.store.roles.list()).toHaveLength(before);
    expect(reasonRows(e, 'create_role')).toEqual([]);
    const ok = await e.main('create_role', { ...SOUND, allowed_skills: ['sound-gen'] });
    expect(e.ctx.store.roles.require(String(ok.roleId)).allowedSkills).toEqual(['sound-gen']);
    // 운영자 내부 API도 같은 처리기 — 같은 검사
    await expect(
      e.internal('roles.create', { name: '임시', instructions: '', taskTypes: ['docs'], allowedSkills: ['nope'], defaultAi: { kind: 'claude', model: null, effortTier: 'low', effortOverride: null }, canReview: false }),
    ).rejects.toMatchObject({ code: 'invalid' });
    await expect(e.internal('skills.setRoleSkills', 'docs', ['nope'])).rejects.toMatchObject({ code: 'invalid' });
    expect(e.ctx.store.roles.require('docs').allowedSkills).toEqual([]);
  });

  it('update_role: 새로 넣는 이름만 본다 — 이미 저장된 이름은 지금 찾지 못해도 그대로 둔다', async () => {
    const e = (env = await bootOrch());
    // 예전에 넣었지만 지금은 지운 스킬
    e.ctx.store.roles.put({ ...e.ctx.store.roles.require('docs'), allowedSkills: ['old-gone'] });
    await e.main('update_role', { role_id: 'docs', instructions: '짧게' });
    expect(e.ctx.store.roles.require('docs')).toMatchObject({ instructions: '짧게', allowedSkills: ['old-gone'] });
    await e.main('update_role', { role_id: 'docs', allowed_skills: ['old-gone', 'some-skill'] });
    expect(e.ctx.store.roles.require('docs').allowedSkills).toEqual(['old-gone', 'some-skill']);
    await expect(e.main('update_role', { role_id: 'docs', allowed_skills: ['old-gone', 'some-skill', 'nope'] })).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('찾은 스킬에 없는 이름입니다: nope.') });
    expect(e.ctx.store.roles.require('docs').allowedSkills).toEqual(['old-gone', 'some-skill']);
    // 뺀 이름을 다시 넣는 것은 새 이름이다
    await e.main('update_role', { role_id: 'docs', allowed_skills: ['some-skill'] });
    await expect(e.main('update_role', { role_id: 'docs', allowed_skills: ['some-skill', 'old-gone'] })).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining(': old-gone.') });
  });

  it('scanSkills가 없으면 찾은 스킬이 없어 새 이름은 모두 거부된다 — 빈 목록과 저장된 이름은 된다', async () => {
    const e = (env = await bootOrch({ skills: null }));
    await expect(e.main('create_role', { ...SOUND, allowed_skills: ['some-skill'] })).rejects.toMatchObject({
      code: 'invalid',
      message: '허용 스킬은 찾은 스킬 중에서만 고를 수 있습니다 — 찾은 스킬에 없는 이름입니다: some-skill. 지금 찾은 스킬이 하나도 없습니다 (Claude·Codex 스킬 폴더)',
    });
    await expect(e.main('set_skill_mode', { name: 'some-skill', mode: 'manual' })).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('스킬 구분은 찾은 스킬에만 정할 수 있습니다') });
    const { roleId } = await e.main('create_role', SOUND);
    e.ctx.store.roles.put({ ...e.ctx.store.roles.require(String(roleId)), allowedSkills: ['kept'] });
    await e.main('update_role', { role_id: roleId, allowed_skills: ['kept'], instructions: '바꿈' });
    expect(e.ctx.store.roles.require(String(roleId)).allowedSkills).toEqual(['kept']);
    expect(await e.invoke('skills.list')).toEqual([]);
    expect(e.skillScans).toBe(0);
  });

  it('찾은 스킬 캐시는 대표의 skills.list와 메인 도구가 함께 쓰고 역할을 쓰면 지운다 — 허용 역할은 바로 보인다. 방금 설치한 스킬은 한 번 새로 찾아 받는다', async () => {
    const e = (env = await bootOrch());
    const first = await e.invoke('skills.list');
    expect(first.map((s) => [s.name, s.allowedRoles])).toEqual([
      ['some-skill', []],
      ['sound-gen', []],
    ]);
    expect(e.skillScans).toBe(1);
    await e.invoke('skills.list');
    expect(e.skillScans).toBe(1); // 캐시
    // 메인 도구(다른 처리기 묶음)도 같은 캐시로 이름을 본다 — 다시 찾지 않는다
    await e.main('update_role', { role_id: 'docs', allowed_skills: ['some-skill'] });
    expect(e.skillScans).toBe(1);
    // 역할을 썼으니 캐시를 지웠다 — 대표 화면은 다시 찾고, 허용 역할이 바로 보인다
    const after = await e.invoke('skills.list');
    expect(e.skillScans).toBe(2);
    expect(after.find((s) => s.name === 'some-skill')!.allowedRoles).toEqual(['docs']);
    // 방금 설치한 스킬: 캐시에 없으면 한 번 새로 찾는다
    e.skills.push({ name: 'fresh-skill', description: '새로 설치', source: 'claude', path: 'C:/fake/skills/fresh-skill/SKILL.md', mode: 'auto' });
    await e.main('create_role', { ...SOUND, allowed_skills: ['fresh-skill'] });
    expect(e.skillScans).toBe(3);
    expect((await e.invoke('skills.list')).map((s) => s.name)).toEqual(['some-skill', 'sound-gen', 'fresh-skill']);
    // 새 이름이 없으면 찾지 않는다
    const n = e.skillScans;
    await e.main('update_role', { role_id: 'docs', instructions: '그대로', allowed_skills: ['some-skill'] });
    await e.main('create_role', { ...SOUND, name: '음향' });
    expect(e.skillScans).toBe(n);
  });

  it('set_skill_mode: 찾은 스킬이나 이미 구분을 정해 둔 스킬만 받는다', async () => {
    const e = (env = await bootOrch());
    const before = JSON.stringify(e.ctx.settings().skills);
    await expect(e.main('set_skill_mode', { name: 'nope', mode: 'manual' })).rejects.toMatchObject({ code: 'invalid', message: expect.stringMatching(/^스킬 구분은 찾은 스킬에만 정할 수 있습니다 — 찾은 스킬에 없는 이름입니다: nope\. 찾은 스킬: some-skill, sound-gen$/) });
    expect(JSON.stringify(e.ctx.settings().skills)).toBe(before);
    expect(reasonRows(e, 'set_skill_mode')).toEqual([]);
    await e.main('set_skill_mode', { name: 'sound-gen', mode: 'auto' });
    expect(e.ctx.settings().skills.overrides['sound-gen']).toBe('auto');
    // 예전에 구분을 정해 둔 스킬은 지금 찾지 못해도 바꿀 수 있다
    seedStoredSettings(e.core, { skills: { overrides: { 'legacy-skill': 'manual' } } } as DeepPartial<Settings>);
    await e.main('set_skill_mode', { name: 'legacy-skill', mode: 'auto' });
    expect(e.ctx.settings().skills.overrides['legacy-skill']).toBe('auto');
  });
});
