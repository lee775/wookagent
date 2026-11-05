/**
 * 메인 에이전트가 사운드 역할을 만들고 팀원을 더하면 프로듀서가 에셋 작업을 만든다 (SERVER_DESIGN 7장·10.5 mainRoleSound, 리드 결정 S5-15, AC-52).
 * 실제 구성(앱 도구 서버·모의 에이전트 프로세스)으로: create_role 사운드(task_types ['asset','research']) → add_member → 대표 명령 → 모의 메인이 지시 등록 →
 * 모의 프로듀서가 팀 구성의 taskTypes로 사운드 팀원에게 'asset' 작업을 만든다 — 출력 방식을 정하지 않아 서버의 기본값(산출물형)이다. 그 작업은 산출물형으로
 * 끝까지 간다(병합 없음). 메인의 두 조작은 활동 기록과 메인 일지에 남는다 (AC-52 — 수락 시험은 바꾸지 않는다).
 * 출력 방식 기본값은 처리기에서 따로 본다: output_mode를 빼면 asset만 산출물형, 그 밖은 저장소 변경형(예전 기본값), 저장소에 넣을 에셋은 repo 그대로
 */
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { MAIN_AGENT_ID } from '@shared/domain';
import { TOOL_SPECS } from '../../src/main/mcp/catalog';
import { buildSystemPrompt } from '../../src/main/orchestrator/prompts';
import { createHarness, sendCommand, type Harness } from '../e2e/harness';
import { bootOrch, seedDirective, type OrchEnv } from './orchHarness';

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

describe('사운드 역할 → 팀원 → 에셋 작업 (mainRoleSound)', () => {
  it('메인이 만든 사운드 역할의 팀원에게 모의 프로듀서가 에셋 작업을 만들고, 출력 방식을 정하지 않은 에셋은 산출물형으로 끝난다', async () => {
    const e = (h = await createHarness({ team: [] }));
    const role = await e.main('create_role', {
      name: '사운드',
      instructions: '게임 효과음과 배경음을 만든다. 결과물은 산출물 폴더에 둔다.',
      task_types: ['asset', 'research'],
      default_ai: { kind: 'claude', effort_tier: 'normal' },
      can_review: false,
      reason: '대표 명령: 사운드 담당을 둔다',
    });
    const roleId = String(role.roleId);
    expect(role).toMatchObject({ name: '사운드', canReview: false, createdBy: 'main' });
    const added = await e.main('add_member', { project_id: e.projectId, role_id: roleId, reason: '대표 명령: 사운드 팀원 추가' });
    const soundId = String(added.memberId);
    expect(e.core.ctx.store.members.require(soundId)).toMatchObject({ roleId, projectId: e.projectId, isProducer: false });

    const did = await sendCommand(e, '게임 효과음 세트를 만들어 줘');
    await e.waitFor(() => e.core.ctx.store.tasks.list({ ref1: did }).length > 0, { label: '작업 생성' });
    const tasks = e.core.ctx.store.tasks.list({ ref1: did });
    // 프로듀서를 뺀 팀원은 사운드 팀원 하나 — 그 역할의 첫 작업 유형(asset), 출력 방식은 기본값(산출물형)
    expect(tasks.map((t) => [t.assigneeId, t.type, t.outputMode])).toEqual([[soundId, 'asset', 'artifact']]);
    const asset = tasks[0]!;
    expect(asset.title).toMatch(/ — 에셋$/);
    // 사운드 역할은 검수 권한이 없다 — 기본 검수자(프로듀서)
    expect(asset.reviewerId).toBe(e.core.ctx.store.projects.require(e.projectId).producerId);
    // 프로듀서가 받은 팀 구성에 역할의 작업 유형이 있다
    const ctx = await e.core.tools.handle(
      { turnId: 'TN-x', sessionId: 'S-x', sessionKey: `directive:${did}`, sessionKind: 'directive', memberId: asset.reviewerId!, projectId: e.projectId, isMain: false, isProducer: true, canReview: true },
      'get_work_context',
      {},
    );
    if (!ctx.ok) throw new Error(ctx.message);
    const team = (ctx.data as { team: { memberId: string; taskTypes: string[] }[] }).team;
    expect(team.find((m) => m.memberId === soundId)?.taskTypes).toEqual(['asset', 'research']);
    expect(team.find((m) => m.memberId === asset.reviewerId)?.taskTypes).toEqual(['plan']);

    // 산출물형으로 끝까지 — 병합 없이 끝나고 보고가 온다
    await e.waitFor(() => e.core.ctx.store.directives.get(did)?.state === 'awaiting_confirmation', { timeoutMs: 150_000, label: '보고 도착' });
    const done = e.task(asset.id);
    expect(done).toMatchObject({ state: 'done', outputMode: 'artifact', type: 'asset', merge: null });

    // AC-52: 메인의 역할 만들기·팀원 추가가 활동 기록과 메인 일지에 남는다
    const activity = e.core.ctx.store.activity.search({ limit: 500 }).filter((r) => r.actor === MAIN_AGENT_ID);
    expect(activity.some((r) => r.text === `역할 추가 ${roleId} 사운드`)).toBe(true);
    expect(activity.some((r) => r.text === '메인 에이전트 역할 추가 사운드 (create_role) — 사유: 대표 명령: 사운드 담당을 둔다')).toBe(true);
    expect(activity.some((r) => r.memberId === soundId && r.text.includes(soundId))).toBe(true);
    const journal = e.core.ctx.store.journal.query({ author: 'server', asc: true }).filter((r) => r.kind === 'action').map((r) => r.text);
    expect(journal).toEqual(
      expect.arrayContaining([
        '역할 추가 사운드 (create_role) — 사유: 대표 명령: 사운드 담당을 둔다',
        expect.stringMatching(new RegExp(`^팀원 추가 .+\\(${soundId}\\) — 역할 ${roleId}, .+ — 사유: 대표 명령: 사운드 팀원 추가$`)),
      ]),
    );
  }, 200_000);
});

describe('에셋 작업의 출력 방식 기본값 (S5-15)', () => {
  let o: OrchEnv | null = null;
  afterEach(async () => {
    await o?.close();
    o = null;
  });

  it('create_task에서 output_mode를 빼면 asset은 산출물형, 그 밖은 저장소 변경형 — 저장소에 넣을 에셋은 repo를 그대로 받는다. 프로듀서 지침이 에셋과 team[].taskTypes를 말한다', async () => {
    const e = (o = await bootOrch());
    const d = seedDirective(e);
    const producer = e.ctx.store.members.require(e.producerId);
    const who = { turnId: 'TN-p', sessionId: 'S-p', sessionKey: `directive:${d.id}`, sessionKind: 'directive' as const, memberId: producer.id, projectId: e.projectId, isMain: false, isProducer: true, canReview: true };
    const args = (type: string, output?: string) => ({ directive_id: d.id, title: `${type} ${output ?? '기본'}`, goal: '목표', type, assignee_id: e.devId, acceptance_criteria: ['된다'], ...(output ? { output_mode: output } : {}) });
    const mk = async (type: string, output?: string): Promise<string> => {
      const r = await e.core.tools.handle(who, 'create_task', args(type, output));
      if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
      return e.ctx.store.tasks.require(String((r.data as { taskId: string }).taskId)).outputMode;
    };
    expect(await mk('asset')).toBe('artifact');
    expect(await mk('asset', 'repo')).toBe('repo');
    expect(await mk('development')).toBe('repo');
    // 산출물형이 흔한 조사도 기본값은 예전 그대로 저장소 변경형 — 기본 산출물형은 에셋뿐이다
    expect(await mk('research')).toBe('repo');
    expect(await mk('research', 'artifact')).toBe('artifact');
    // 도구 목록의 입력 형식: asset을 받고 output_mode를 빼도 된다 (MCP 경계 — 처리기 앞)
    const spec = TOOL_SPECS.find((t) => t.name === 'create_task')!;
    expect(z.object(spec.input).safeParse({ ...args('asset'), priority: 'normal' }).success).toBe(true);
    expect(z.object(spec.input).safeParse({ ...args('revert') }).success).toBe(false);
    // 프로듀서 지침
    const prompt = buildSystemPrompt({ member: producer, role: e.ctx.store.roles.require('producer'), project: e.ctx.store.projects.require(e.projectId), sessionKind: 'directive', cwd: e.projectDir, manualSkills: [] });
    expect(prompt).toContain('음원·이미지·3D 모델 같은 에셋은 type "asset"으로 만든다. output_mode를 정하지 않으면 산출물형(artifact)이고');
    expect(prompt).toContain('get_work_context의 team[].taskTypes');
  });
});
