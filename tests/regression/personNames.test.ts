/**
 * 팀원 이름은 사람 이름 (대표 지시 2026-11-16: "각 직원들 이름 전부 지어주도록 해줘 코덱스 개발1 이런식은 너무 별로야").
 * - 메인 에이전트가 팀원에게 '코덱스 개발1'처럼 AI 종류·역할·번호로 만든 이름을 붙였고, 그 이름이 사무실 화면의 머리 위에 그대로 떴다.
 * - 이제: 이름 없이 추가하면 프로그램이 사람 이름을 짓고(다른 프로젝트에서 쓰는 이름도 피한다), 메인 에이전트가 준 이름은 사람 이름일 때만 받는다.
 *   예전 데이터 폴더의 그런 이름은 처음 열 때 한 번 사람 이름으로 바꾼다.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OPERATOR } from '../../src/shared/domain';
import { PERSON_NAMES_KEY, migratePersonNames } from '../../src/main/orchestrator/migrations';
import { NAME_POOL, isPersonName, nameCandidates, pickPersonName } from '../../src/main/orchestrator/names';
import { defaultRoles } from '../../src/main/orchestrator/defaults';
import type { OrchEnv } from './orchHarness';
import { bootOrch } from './orchHarness';

let env: OrchEnv | null = null;
const dirs: string[] = [];
afterEach(async () => {
  await env?.close();
  env = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const ROLE_NAMES = defaultRoles('2026-11-16T00:00:00.000Z').map((r) => r.name);
const LABELS = ['코덱스 개발1', '코덱스개발', '개발자', '검수 담당', '검수자', 'Codex Dev 1', 'claude-reviewer', 'QA', '디자이너', '프로듀서', '팀원3', '서진2', '클로드', '대표', '에이전트', 'A', '가'];

const names = (e: OrchEnv, projectId = e.projectId): string[] => e.ctx.store.members.list({ project_id: projectId, state: 'active' }).map((m) => m.name);
const tryMain = async (e: OrchEnv, tool: string, args: Record<string, unknown>): Promise<{ code: string | null; message: string }> => {
  try {
    await e.main(tool, args);
    return { code: null, message: '' };
  } catch (err) {
    const x = err as { code?: string; message?: string };
    return { code: x.code ?? 'error', message: x.message ?? '' };
  }
};
/** 두 번째 프로젝트를 등록한다 (운영자 내부 API — 대표 흐름의 create_project와 같은 등록) */
async function secondProject(e: OrchEnv, name: string): Promise<{ id: string; producerId: string }> {
  const root = mkdtempSync(join(tmpdir(), 'wook-reg-names-'));
  dirs.push(root);
  const p = await e.internal('projects.create', { mode: 'new', path: join(root, 'b'), name, checkCommands: [] });
  return { id: p.id, producerId: p.producerId };
}

describe('사람 이름 판정 (names.ts)', () => {
  it('프로그램이 짓는 이름은 모두 사람 이름이고 겹치지 않는다', () => {
    const all = nameCandidates();
    expect(new Set(all).size).toBe(all.length);
    expect(all.length).toBeGreaterThanOrEqual(NAME_POOL.length * 10);
    expect(all.filter((n) => !isPersonName(n, ROLE_NAMES))).toEqual([]);
  });

  it('AI 종류·역할·번호로 만든 이름은 사람 이름이 아니다', () => {
    expect(LABELS.filter((n) => isPersonName(n, ROLE_NAMES))).toEqual([]);
    expect(['서진', '윤슬', '김서진', '남궁민수'].filter((n) => !isPersonName(n, ROLE_NAMES))).toEqual([]);
  });

  it('역할 이름과 그 일부도 사람 이름이 아니다 — 메인 에이전트가 만든 역할 포함', () => {
    expect(isPersonName('사운드', [...ROLE_NAMES, '사운드'])).toBe(false);
    expect(isPersonName('번역', [...ROLE_NAMES, '번역 검토'])).toBe(false);
    expect(isPersonName('번역', ROLE_NAMES)).toBe(true);
  });

  it('다른 프로젝트에서 쓰는 이름을 피하고, 다 쓰면 이 프로젝트에 없는 이름을 고른다', () => {
    expect(pickPersonName(new Set(), new Set())).toBe(NAME_POOL[0]);
    expect(pickPersonName(new Set(), new Set([NAME_POOL[0]!]))).toBe(NAME_POOL[1]);
    const everything = new Set(nameCandidates());
    expect(pickPersonName(new Set([NAME_POOL[0]!]), everything)).toBe(NAME_POOL[1]);
    expect(pickPersonName(everything, everything)).toBeNull();
  });
});

describe('팀원 이름 — 추가와 변경', () => {
  it('메인 에이전트가 이름표 같은 이름을 주면 프로그램이 사람 이름을 짓고 결과에 알린다', async () => {
    env = await bootOrch();
    const e = env;
    for (const label of ['코덱스 개발1', '검수 담당', '개발자', 'Codex Dev 2']) {
      const r = (await e.main('add_member', { project_id: e.projectId, role_id: 'developer', name: label })) as { name: string; nameNote?: string };
      expect(e.core.team.isPersonName(r.name), `${label} → ${r.name}`).toBe(true);
      expect(r.nameNote).toContain(`"${label}" 대신 "${r.name}"`);
    }
    const all = names(e);
    expect(all.filter((n) => !e.core.team.isPersonName(n))).toEqual([]);
    expect(new Set(all).size).toBe(all.length);
  });

  it('메인 에이전트가 준 사람 이름은 그대로 쓴다 — 같은 프로젝트에 이미 있으면 프로그램이 짓는다', async () => {
    env = await bootOrch();
    const e = env;
    const first = (await e.main('add_member', { project_id: e.projectId, role_id: 'developer', name: '민수' })) as { name: string; nameNote?: string };
    expect(first.name).toBe('민수');
    expect(first.nameNote).toBeUndefined();
    const second = (await e.main('add_member', { project_id: e.projectId, role_id: 'qa', name: '민수' })) as { name: string; nameNote?: string };
    expect(second.name).not.toBe('민수');
    expect(e.core.team.isPersonName(second.name)).toBe(true);
    expect(second.nameNote).toContain('"민수" 대신');
  });

  it('이름을 주지 않은 팀원과 새 프로젝트의 프로듀서는 다른 프로젝트에서 쓰지 않는 이름을 받는다', async () => {
    env = await bootOrch();
    const e = env;
    for (const roleId of ['developer', 'qa', 'docs']) await e.main('add_member', { project_id: e.projectId, role_id: roleId });
    const b = await secondProject(e, 'B 프로젝트');
    for (const roleId of ['developer', 'qa']) await e.main('add_member', { project_id: b.id, role_id: roleId });
    const a = names(e);
    const bNames = names(e, b.id);
    expect(bNames.length).toBe(3);
    expect(bNames.filter((n) => a.includes(n))).toEqual([]);
    expect([...a, ...bNames].filter((n) => !e.core.team.isPersonName(n))).toEqual([]);
  });

  it('update_member: 사람 이름이 아니거나 같은 프로젝트에 있는 이름으로는 바꾸지 않고, 쓸 수 있는 이름을 알려 준다', async () => {
    env = await bootOrch();
    const e = env;
    const before = e.ctx.store.members.require(e.devId).name;
    const label = await tryMain(e, 'update_member', { member_id: e.devId, name: '코덱스 개발1', reason: '이름 바꿈 (시험)' });
    expect(label.code).toBe('invalid');
    expect(label.message).toContain('"코덱스 개발1"은(는) 사람 이름이 아닙니다');
    expect(label.message).toMatch(/예: [가-힣]{2,4}\)/);
    const producer = e.ctx.store.members.require(e.producerId).name;
    const taken = await tryMain(e, 'update_member', { member_id: e.devId, name: producer, reason: '이름 바꿈 (시험)' });
    expect(taken.code).toBe('conflict');
    expect(taken.message).toContain(`이 프로젝트에 이미 ${producer}(${e.producerId})`);
    expect(e.ctx.store.members.require(e.devId).name).toBe(before);
    expect(await tryMain(e, 'update_member', { member_id: e.devId, name: '민수', reason: '이름 바꿈 (시험)' })).toEqual({ code: null, message: '' });
    expect(e.ctx.store.members.require(e.devId).name).toBe('민수');
  });

  it('운영자(내부 API)가 준 이름은 그대로 둔다 — 시험·복구 준비', async () => {
    env = await bootOrch();
    const e = env;
    const m = e.core.team.add({ projectId: e.projectId, roleId: 'developer', name: '개발자 A' }, OPERATOR);
    expect(m.name).toBe('개발자 A');
    expect(e.core.team.add({ projectId: e.projectId, roleId: 'developer', name: '개발자 A' }, OPERATOR).name).toBe('개발자 A2');
  });
});

describe('예전 데이터의 이름 — 처음 열 때 한 번 사람 이름으로', () => {
  it('이름표 같은 이름만 바꾸고, 활동 기록에 남기고, 다시 하지 않는다', async () => {
    env = await bootOrch();
    const e = env;
    // 이 규칙이 생기기 전의 데이터: 메인 에이전트가 붙인 이름이 그대로 저장돼 있다
    const kept = e.ctx.store.members.require(e.producerId).name;
    e.ctx.store.members.patch(e.devId, { name: '코덱스 개발1' });
    const qa = e.core.team.add({ projectId: e.projectId, roleId: 'qa', name: '클로드 검수1' }, OPERATOR);
    e.ctx.store.kv.set(PERSON_NAMES_KEY, null);

    migratePersonNames(e.core);
    const dev = e.ctx.store.members.require(e.devId).name;
    const qaName = e.ctx.store.members.require(qa.id).name;
    expect(e.core.team.isPersonName(dev)).toBe(true);
    expect(e.core.team.isPersonName(qaName)).toBe(true);
    expect(new Set([kept, dev, qaName]).size).toBe(3);
    expect(e.ctx.store.members.require(e.producerId).name).toBe(kept);
    expect(e.ctx.store.members.require('M-MAIN').name).toBe('메인 에이전트');
    const record = e.ctx.store.activity.search({ text: '팀원 이름을 사람 이름으로 바꿈', limit: 10 }).map((r) => r.text);
    expect(record).toEqual([`팀원 이름을 사람 이름으로 바꿈: 코덱스 개발1(${e.devId}) → ${dev}, 클로드 검수1(${qa.id}) → ${qaName}`]);

    // 한 번 한 뒤에는 운영자가 붙인 이름을 건드리지 않는다
    e.ctx.store.members.patch(e.devId, { name: '개발자 B' });
    migratePersonNames(e.core);
    expect(e.ctx.store.members.require(e.devId).name).toBe('개발자 B');
  });

  it('새 데이터 폴더는 시작할 때 이미 한 것으로 적힌다', async () => {
    env = await bootOrch();
    expect(env.ctx.store.kv.get(PERSON_NAMES_KEY)).toBeTruthy();
  });
});
