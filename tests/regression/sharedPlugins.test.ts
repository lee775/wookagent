/**
 * 앱과 함께 실린 플러그인을 모든 봇이 쓴다 (대표 지시 2026-11-20: "메인에이전트가 생성한 봇들도 내 pc랑 동일한 스킬 명령 에이전트 다 쓸 수 있어야해").
 * - Claude 세션에는 어댑터가 플러그인 폴더를 실어 준다(claudeAdapter의 --plugin-dir) — 규칙은 실려 있다고만 알린다.
 * - Codex에는 한 세션에만 스킬 폴더를 싣는 길이 없다 — 규칙이 폴더의 자리와 읽는 법을 알려 같은 파일을 쓰게 한다. 외부 에이전트(메인 자리)도 같다.
 * - 어느 쪽이든 플러그인의 지침보다 작업 규칙이 먼저라고 적는다. 플러그인이 없는 앱의 규칙은 예전과 한 글자도 다르지 않다.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID } from '../../src/shared/domain';
import { buildSystemPrompt } from '../../src/main/orchestrator/prompts';
import type { OrchEnv } from './orchHarness';
import { bootOrch, seedDirective, waitFor } from './orchHarness';

let env: OrchEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const PLUGIN = 'C:\\wook\\claude-plugins\\team-kit';
const SECTION = '## 함께 쓰는 스킬·명령·에이전트';
const sectionOf = (prompt: string): string => {
  const at = prompt.indexOf(SECTION);
  if (at < 0) return '';
  const rest = prompt.slice(at + SECTION.length);
  const next = rest.indexOf('\n## ');
  return next < 0 ? rest : rest.slice(0, next);
};

describe('팀원 규칙 — 함께 쓰는 스킬·명령·에이전트', () => {
  it('Claude 팀원: 플러그인이 실려 있다고 알린다(폴더를 읽으라고 하지 않는다). Codex 팀원: 폴더의 자리와 읽는 법을 알린다. 둘 다 작업 규칙이 먼저다', async () => {
    env = await bootOrch({ claudePlugins: [PLUGIN] });
    const e = env;
    const dev = e.ctx.store.members.require(e.devId);
    const qa = e.ctx.store.members.require(e.qaId);
    expect([dev.ai.kind, qa.ai.kind]).toEqual(['codex', 'claude']);
    const role = (id: string) => e.ctx.store.roles.require(id);
    const project = e.ctx.store.projects.require(e.projectId);
    const of = (m: typeof dev, loaded: boolean) =>
      sectionOf(buildSystemPrompt({ member: m, role: role(m.roleId), project, sessionKind: 'task', cwd: 'C:\\work', manualSkills: [], plugins: { dirs: [PLUGIN], loaded } }));

    const claude = of(qa, true);
    expect(claude).toContain('플러그인(team-kit)의 스킬·명령·에이전트가 실려 있다');
    expect(claude).not.toContain(PLUGIN);
    expect(claude).not.toContain('SKILL.md');

    const codex = of(dev, false);
    expect(codex).toContain(PLUGIN);
    for (const part of ['skills/<이름>/SKILL.md', 'commands/<이름>.md', 'agents/<이름>.md', "'team-kit:<이름>'", '네가 그 역할로', '폴더 안의 파일은 고치지 않는다']) expect(codex).toContain(part);

    for (const text of [claude, codex]) {
      expect(text).toContain("'(요청할 때만 사용)'이 붙은 것은 지시에 그 이름이 나올 때만 쓴다");
      expect(text).toContain('이 작업 규칙이 먼저다');
      // 팀원에게는 메인의 줄(지시에 이름을 적는다)이 없다
      expect(text).not.toContain('팀원에게 특정 스킬');
    }
  });

  it('실제 턴: 프로그램이 띄우는 Codex 팀원의 작업 턴 규칙에 폴더를 읽는 쪽의 글이 들어간다', async () => {
    env = await bootOrch({ claudePlugins: [PLUGIN] });
    const e = env;
    const seen = new Map<string, string>();
    e.prepareHook = (launch, who) => {
      seen.set(who.memberId, launch.systemPrompt);
    };
    const d = seedDirective(e);
    const task = e.core.tasks.create({ directiveId: d.id, title: '구현', goal: '목표', type: 'development', assigneeId: e.devId, acceptanceCriteria: ['동작'], outputMode: 'repo' }, e.producerId);
    e.hold.add(`task:${task.id}`);
    await waitFor(() => {
      e.tick();
      return seen.has(e.devId);
    }, 'Codex 팀원의 작업 턴 시작');
    expect(e.ctx.store.members.require(e.devId).ai.kind).toBe('codex');
    const text = sectionOf(seen.get(e.devId)!);
    expect(text).toContain(PLUGIN);
    expect(text).toContain('skills/<이름>/SKILL.md');
    expect(text).not.toContain('실려 있다');
  });

  it('메인 자리의 외부 에이전트가 받는 규칙: 폴더를 직접 읽는 쪽의 글과, 팀원에게 이름으로 지시하라는 줄', async () => {
    env = await bootOrch({ claudePlugins: [PLUGIN] });
    const text = sectionOf(env.core.turns.mainRules().rules);
    expect(text).toContain(PLUGIN);
    expect(text).toContain('skills/<이름>/SKILL.md');
    expect(text).toContain('팀원에게 특정 스킬·명령·에이전트를 쓰게 하려면 지시에 그 이름을 적는다 (예: team-kit:<이름>)');
  });

  it('플러그인이 없는 앱: 규칙에 그 절이 없다 — 예전 규칙 그대로', async () => {
    env = await bootOrch();
    const e = env;
    expect(e.core.turns.mainRules().rules).not.toContain(SECTION);
    const main = e.ctx.store.members.require(MAIN_AGENT_ID);
    const base = { member: main, role: null, project: null, sessionKind: 'main_general' as const, cwd: 'C:\\work', manualSkills: [] };
    expect(buildSystemPrompt({ ...base, plugins: { dirs: [], loaded: true } })).toBe(buildSystemPrompt(base));
  });
});
