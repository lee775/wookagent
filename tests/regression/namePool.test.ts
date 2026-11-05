/**
 * 기본 팀원 이름 회귀: 참고했던 다른 앱의 팀 이름(같은 순서)을 그대로 쓰고 있었다 → 대표가 "이러면 베낀 거잖아"라고 한 부분과 같은 문제.
 * 기본 이름 목록과 새 프로젝트의 프로듀서·팀원 이름에 그 이름이 하나도 없어야 한다
 */
import { afterEach, describe, expect, it } from 'vitest';
import { NAME_POOL } from '../../src/main/orchestrator/team';
import type { OrchEnv } from './orchHarness';
import { bootOrch } from './orchHarness';

const REFERENCE_TEAM = ['하루', '도윤', '모아', '리듬', '이야', '체크', '소담'];

let env: OrchEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

describe('기본 팀원 이름', () => {
  it('기본 이름 목록에 참고 앱의 팀 이름이 없고, 이름이 겹치지 않는다', () => {
    expect(NAME_POOL.filter((n) => REFERENCE_TEAM.includes(n))).toEqual([]);
    expect(new Set(NAME_POOL).size).toBe(NAME_POOL.length);
    expect(NAME_POOL.length).toBeGreaterThanOrEqual(13);
  });

  it('새 프로젝트의 프로듀서와 이름 없이 추가한 팀원도 그 이름을 쓰지 않는다', async () => {
    env = await bootOrch();
    const e = env;
    for (const roleId of ['planner', 'architect', 'developer', 'developer', 'ui_designer', 'qa', 'docs']) {
      await e.main('add_member', { project_id: e.projectId, role_id: roleId });
    }
    const names = e.ctx.store.members.list({ project_id: e.projectId }).map((m) => m.name);
    expect(names.length).toBeGreaterThanOrEqual(8);
    expect(names.filter((n) => REFERENCE_TEAM.includes(n))).toEqual([]);
    expect(new Set(names).size).toBe(names.length);
  });
});
