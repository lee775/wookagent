/**
 * 완료 기준(기획서 17장) 'flow' 묶음: AC-03·04·05·06·07·08·17·21·22·23·27·49.
 *
 * 세 가지 실행 환경을 쓴다.
 * 1) 서비스 경계 (tests/regression/helpers.ts boot): 실제 SQLite·git, 턴 없음 — 프로젝트·팀 구성(AC-03·04·05)
 * 2) 턴 단위 (tests/regression/orchHarness.ts bootOrch): 실제 오케스트레이터 + 가짜 CLI, 테스트가 tick·도구 호출을 직접 — AC-08·17·21·23
 * 3) 끝까지 (./flow-helpers.ts createFlowApp): 실제 프로세스 러너·앱 도구 서버(HTTP)·모의 에이전트 프로세스, 제품 기본 화면 푸시 주기
 *    — AC-06·07·08·21·22·27·49
 * 화면(renderer) 확인은 React 서버 렌더링(스튜디오)과 훅 모사(팀원 상세 실시간 로그)로 한다.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createElement, type FunctionComponent } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Task } from '@shared/domain';
import { MAIN_AGENT_ID } from '@shared/domain';
import { AI_KIND_LABEL, EFFORT_TIER_LABEL } from '@shared/labels';
import type { AppSnapshot, MemberDetail } from '@shared/views';
import type { CliEvent } from '@shared/events';
import type { TokenIdentity } from '../../src/main/mcp/types';
import { createOwnerInvoke } from '../../src/main/backend/ownerGate';
import type { Core } from '../../src/main/orchestrator/core';
import { mainOp } from '../regression/mainOps';
import { directiveKey, mainKey, taskKey } from '../../src/main/orchestrator/records';
import { taskWorktreePath } from '../../src/main/orchestrator/paths';
import { boot, newDirective } from '../regression/helpers';
import { bootOrch, seedDirective, sleep as sleepO, waitFor as waitO, type OrchEnv } from '../regression/orchHarness';
import { createFlowApp, git, installWindowStub, section, sendCommand, sleep, type FlowApp } from './flow-helpers';

const rmrf = (d: string) => {
  try {
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // 윈도우에서 잠긴 파일이 남으면 다음 정리에 맡긴다
  }
};
const norm = (p: string) => resolve(p).toLowerCase();
/** React 서버 렌더링이 글자를 바꾸는 방식 */
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
/** API 처리기는 동기·비동기가 섞여 있다 — 던지는 것도 거부로 받는다 */
const attempt = (fn: () => unknown) => Promise.resolve().then(fn);
/** 측정값 기록 (WOOK_ACC_REPORT=파일 경로일 때만 덧붙인다 — 검증 보고용) */
const measure = (label: string, values: number[]) => {
  const file = process.env.WOOK_ACC_REPORT;
  if (file) writeFileSync(file, `${JSON.stringify({ label, values })}\n`, { flag: 'a', encoding: 'utf8' });
};

/** 대표가 부르는 길 (Backend.invoke와 같은 게이트, SERVER_DESIGN 2.5) — 서비스 경계 환경에서 대표로 로그인해 둔다 */
const ownerInvoke = (core: Core) => {
  core.auth.devLogin();
  const invoke = createOwnerInvoke(core);
  return (method: string, ...args: unknown[]) => (invoke as (m: string, a: unknown[]) => Promise<unknown>)(method, args);
};

const mainIdentity = (projectId: string): TokenIdentity => ({
  turnId: 'TN-990001',
  sessionId: 'S-990001',
  sessionKey: `main:${projectId}`,
  sessionKind: 'main_project',
  memberId: MAIN_AGENT_ID,
  projectId: null,
  isMain: true,
  isProducer: false,
  canReview: false,
});

/**
 * 화면(renderer) 모듈을 불러온다. 경로를 실행 시점 문자열로 넘겨 node 쪽 타입 검사(tsconfig.node.json, jsx 없음)가
 * .tsx를 풀지 않게 한다 — 실행은 vitest가 renderer 설정(react-jsx)으로 변환한다
 */
const loadRenderer = async <T,>(rel: string): Promise<T> => (await import(/* @vite-ignore */ `../../src/renderer/src/${rel}`)) as T;

/** 스튜디오 화면을 실제 컴포넌트로 그린다 (React 서버 렌더링) */
async function renderStudio(snap: AppSnapshot, projectId: string): Promise<string> {
  installWindowStub();
  const { Studio } = await loadRenderer<{ Studio: FunctionComponent<Record<string, unknown>> }>('screens/Studio.tsx');
  const project = snap.projects.find((p) => p.id === projectId)!;
  const noop = () => undefined;
  return renderToStaticMarkup(createElement(Studio, { snapshot: snap, project, back: noop, openMember: noop, openTask: noop, openDirective: noop, openReport: noop }));
}

/** 스튜디오 팀원 디렉터리에서 그 팀원의 카드 HTML */
function memberCard(html: string, name: string): string {
  const grid = html.slice(html.indexOf('class="member-grid"'));
  return grid.split('class="member-card"').find((c) => c.includes(`<strong>${esc(name)}</strong>`)) ?? '';
}

// ───────────────────────── 1. 프로젝트·팀 구성 ─────────────────────────

describe('AC-03 기존 폴더로 프로젝트 만들기', () => {
  it('AC-03 git이 없는 기존 폴더를 연결하면 git이 초기화되고(기존 파일 보존) 프로듀서가 자동 배치된다', async () => {
    const env = await boot();
    const dir = mkdtempSync(join(tmpdir(), 'wook-test-acc-existing-'));
    try {
      mkdirSync(join(dir, 'src'));
      writeFileSync(join(dir, 'README.md'), '# 기존 프로젝트\n대표가 쓰던 폴더\n', 'utf8');
      writeFileSync(join(dir, 'src', 'app.js'), 'console.log("hello");\n', 'utf8');
      expect(existsSync(join(dir, '.git'))).toBe(false);
      const created = await mainOp(env.core, 'create_project', { mode: 'existing', path: dir, name: '기존 폴더 프로젝트' });
      const view = env.core.views.projectView(env.ctx.store.projects.require(String(created.projectId)));

      // git 초기화: 저장소가 생기고, 기준 브랜치가 정해지고, 대표의 기존 파일은 그대로 첫 커밋에 들어간다
      expect(existsSync(join(dir, '.git'))).toBe(true);
      expect(git(dir, ['rev-parse', '--is-inside-work-tree'])).toBe('true');
      expect(view.baseBranch).toBe('main');
      expect(git(dir, ['symbolic-ref', '--short', 'HEAD'])).toBe('main');
      expect(git(dir, ['ls-files']).split('\n')).toEqual(expect.arrayContaining(['README.md', 'src/app.js', 'AGENTS.md', 'CLAUDE.md']));
      expect(git(dir, ['status', '--porcelain'])).toBe('');
      expect(readFileSync(join(dir, 'README.md'), 'utf8')).toBe('# 기존 프로젝트\n대표가 쓰던 폴더\n');
      const init = env.ctx.store.execs.list({ project_id: view.id }).find((x) => x.kind === 'git_init');
      expect(init).toMatchObject({ state: 'succeeded', result: { initialized: true, baseBranch: 'main' } });
      expect(env.ctx.store.activity.search({ projectId: view.id, text: 'git 초기화' })).toHaveLength(1);

      // 프로듀서 자동 배치 — 프로젝트에 정확히 1명
      const producer = env.ctx.store.members.require(view.producerId);
      expect(producer).toMatchObject({ projectId: view.id, roleId: 'producer', isProducer: true, deletedAt: null });
      const team = env.ctx.store.members.list({ project_id: view.id, state: 'active' });
      expect(team.filter((m) => m.isProducer).map((m) => m.id)).toEqual([view.producerId]);
      const snap = env.core.views.snapshot();
      expect(snap.projects.find((p) => p.id === view.id)?.producerId).toBe(view.producerId);
      expect(snap.members.find((m) => m.id === view.producerId)).toMatchObject({ isProducer: true, roleName: '프로듀서', projectId: view.id });
      // 대표 세션으로는 프로젝트를 만들 수 없다 (메서드가 대표 목록에 없다 — forbidden, OWN-05)
      const other = mkdtempSync(join(tmpdir(), 'wook-test-acc-owner-'));
      await expect(ownerInvoke(env.core)('projects.create', { mode: 'existing', path: other, name: '대표가 만든 프로젝트' })).rejects.toMatchObject({ code: 'forbidden' });
      expect(env.ctx.store.projects.list().filter((p) => resolve(p.path).toLowerCase() === resolve(other).toLowerCase())).toEqual([]);
      rmrf(other);
    } finally {
      await env.close();
      rmrf(dir);
    }
  });

  it('AC-03 이미 git인 기존 폴더는 다시 초기화하지 않고 지금 브랜치·이력 그대로 연결하며 프로듀서를 배치한다', async () => {
    const env = await boot();
    const dir = mkdtempSync(join(tmpdir(), 'wook-test-acc-existing-git-'));
    try {
      const g = (args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=owner', '-c', 'user.email=o@o', ...args], { encoding: 'utf8' }).trim();
      g(['init', '-q', '-b', 'develop']);
      writeFileSync(join(dir, 'index.html'), '<h1>기존</h1>\n', 'utf8');
      g(['add', 'index.html']);
      g(['commit', '-q', '-m', '대표의 첫 커밋']);
      const first = g(['rev-parse', 'HEAD']);
      const created = await mainOp(env.core, 'create_project', { mode: 'existing', path: dir, name: '기존 git 프로젝트' });
      const view = env.core.views.projectView(env.ctx.store.projects.require(String(created.projectId)));
      expect(view.baseBranch).toBe('develop');
      expect(env.ctx.store.execs.list({ project_id: view.id }).find((x) => x.kind === 'git_init')?.result.initialized).toBe(false);
      // 이력 보존: 대표의 커밋이 기준 브랜치 이력에 그대로 있다 (아니면 execFileSync가 던진다)
      g(['merge-base', '--is-ancestor', first, 'refs/heads/develop']);
      expect(g(['log', '--format=%s', 'develop'])).toContain('대표의 첫 커밋');
      expect(env.ctx.store.members.require(view.producerId)).toMatchObject({ isProducer: true, projectId: view.id, deletedAt: null });
    } finally {
      await env.close();
      rmrf(dir);
    }
  });
});

describe('AC-04 프로듀서는 삭제할 수 없고 교체만', () => {
  it('AC-04 프로듀서는 메인 에이전트(앱 도구)도 삭제할 수 없고, 다른 경로로 프로듀서 자리를 없애거나 늘릴 수 없다 — 대표 세션에는 그런 메서드가 없다', async () => {
    const env = await boot();
    try {
      const owner = ownerInvoke(env.core);
      const pid = env.project.producerId;
      const devId = env.members[0]!.id;
      // 대표 쪽: 메서드가 대표 목록에 없다 (forbidden, OWN-05)
      await expect(owner('members.remove', pid)).rejects.toMatchObject({ code: 'forbidden' });
      await expect(owner('members.update', pid, { roleId: 'developer' })).rejects.toMatchObject({ code: 'forbidden' });
      await expect(owner('members.add', { projectId: env.project.id, roleId: 'producer' })).rejects.toMatchObject({ code: 'forbidden' });
      await expect(owner('roles.delete', 'producer')).rejects.toMatchObject({ code: 'forbidden' });
      // 메인 쪽: 앱 도구가 거부한다
      const r = await env.core.tools.handle(mainIdentity(env.project.id), 'remove_member', { member_id: pid });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('forbidden');
      expect(env.ctx.store.members.require(pid)).toMatchObject({ deletedAt: null, isProducer: true });
      expect(env.ctx.store.projects.require(env.project.id).producerId).toBe(pid);
      // 역할 바꾸기·두 번째 프로듀서 추가·프로듀서 역할 삭제도 안 된다
      await expect(mainOp(env.core, 'update_member', { member_id: pid, role_id: 'developer' })).rejects.toMatchObject({ code: 'invalid' });
      await expect(mainOp(env.core, 'update_member', { member_id: devId, role_id: 'producer' })).rejects.toMatchObject({ code: 'invalid' });
      await expect(mainOp(env.core, 'add_member', { project_id: env.project.id, role_id: 'producer' })).rejects.toMatchObject({ code: 'invalid' });
      await expect(mainOp(env.core, 'delete_role', { role_id: 'producer' })).rejects.toMatchObject({ code: 'forbidden' });
      // 대조: 일반 팀원은 삭제된다
      await mainOp(env.core, 'remove_member', { member_id: devId });
      expect(env.ctx.store.members.require(devId).deletedAt).not.toBeNull();
      expect(env.ctx.store.members.list({ project_id: env.project.id, state: 'active' }).filter((m) => m.isProducer).map((m) => m.id)).toEqual([pid]);
    } finally {
      await env.close();
    }
  });

  it('AC-04 프로듀서 교체: 새 프로듀서가 자리와 남은 관리 업무를 잇고, 프로젝트의 프로듀서는 늘 1명이다', async () => {
    const env = await boot();
    try {
      const old = env.project.producerId;
      const did = newDirective(env, '교체 전 지시');
      expect(env.ctx.store.queue.list({ state: 'queued' }).filter((q) => q.kind === 'plan' && q.directiveId === did).map((q) => q.memberId)).toEqual([old]);
      const replaced = await mainOp(env.core, 'replace_producer', { project_id: env.project.id, name: '새프로듀서' });
      const fresh = env.core.views.memberView(env.ctx.store.members.require(String(replaced.producerId)));
      expect(fresh).toMatchObject({ isProducer: true, roleId: 'producer', projectId: env.project.id, name: '새프로듀서' });
      expect(env.ctx.store.projects.require(env.project.id).producerId).toBe(fresh.id);
      expect(env.ctx.store.members.require(old)).toMatchObject({ isProducer: false, replacedById: fresh.id });
      expect(env.ctx.store.members.require(old).deletedAt).not.toBeNull();
      expect(env.ctx.store.members.list({ project_id: env.project.id, state: 'active' }).filter((m) => m.isProducer).map((m) => m.id)).toEqual([fresh.id]);
      expect(env.ctx.store.queue.list({ state: 'queued' }).filter((q) => q.kind === 'plan' && q.directiveId === did).map((q) => q.memberId)).toEqual([fresh.id]);
      const snap = env.core.views.snapshot();
      expect(snap.members.filter((m) => m.projectId === env.project.id && m.isProducer).map((m) => m.id)).toEqual([fresh.id]);
      // 새 프로듀서도 삭제는 안 된다
      await expect(mainOp(env.core, 'remove_member', { member_id: fresh.id })).rejects.toMatchObject({ code: 'forbidden' });
    } finally {
      await env.close();
    }
  });
});

describe('AC-05 역할을 골라 팀원 추가', () => {
  const ROLES = ['planner', 'architect', 'developer', 'ui_designer', 'qa', 'docs'];

  it('AC-05 역할을 골라 팀원을 추가하면 역할 기본값(AI 종류·모델·노력치·검수 권한)과 이름이 채워진다', async () => {
    const env = await boot();
    try {
      const mapping = env.ctx.settings().team.effortMapping;
      const names = new Set<string>();
      for (const roleId of ROLES) {
        const role = env.ctx.store.roles.require(roleId);
        const added = await mainOp(env.core, 'add_member', { project_id: env.project.id, role_id: roleId });
        const v = env.core.views.memberView(env.ctx.store.members.require(String(added.memberId)));
        expect(v).toMatchObject({ roleId, roleName: role.name, canReview: role.canReview, projectId: env.project.id, isProducer: false });
        expect(v.ai).toMatchObject({ kind: role.defaultAi.kind, model: role.defaultAi.model, effortTier: role.defaultAi.effortTier, effortOverride: role.defaultAi.effortOverride });
        expect(v.ai.effortValue).toBe(mapping[role.defaultAi.kind][role.defaultAi.effortTier]);
        expect(v.name.trim()).not.toBe('');
        names.add(v.name);
        expect(env.ctx.store.members.require(v.id).ai).toEqual(role.defaultAi);
      }
      expect(names.size).toBe(ROLES.length);
    } finally {
      await env.close();
    }
  });

  it('AC-05 스튜디오 화면의 팀원 카드에 AI 종류·노력치·역할이 표시된다 (실제 화면 컴포넌트 렌더링)', async () => {
    const env = await boot({ team: ['developer', 'qa'] });
    try {
      await mainOp(env.core, 'add_member', { project_id: env.project.id, role_id: 'docs' });
      await mainOp(env.core, 'add_member', { project_id: env.project.id, role_id: 'architect', ai_kind: 'codex', effort_tier: 'low' });
      const snap = env.core.views.snapshot();
      const html = await renderStudio(snap, env.project.id);
      const team = snap.members.filter((m) => m.projectId === env.project.id);
      expect(team.length).toBe(5);
      for (const m of team) {
        const card = memberCard(html, m.name);
        expect(card, `${m.name} 카드`).not.toBe('');
        expect(card).toContain(esc(m.roleName));
        expect(card).toContain(AI_KIND_LABEL[m.ai.kind]);
        expect(card).toContain(EFFORT_TIER_LABEL[m.ai.effortTier]);
        expect(card).toContain(`(${m.ai.effortValue})`);
      }
      // 메인 에이전트가 정한 AI는 그 값으로 보인다 (ROLE-04)
      const arch = team.find((m) => m.roleId === 'architect')!;
      expect(memberCard(html, arch.name)).toContain('Codex');
      expect(memberCard(html, arch.name)).toContain('낮게');
    } finally {
      await env.close();
    }
  });
});

// ───────────────────────── 2. 턴 단위 정밀 시험 ─────────────────────────

describe('AC-08 선행 작업 (턴 단위)', () => {
  let env: OrchEnv | null = null;
  afterAll(async () => {
    await env?.close();
  });

  const startedB = (e: OrchEnv, id: string) => e.launches.some((l) => l.workKey === taskKey(id)) || e.ctx.store.tasks.require(id).state !== 'waiting';
  const ticks = async (e: OrchEnv, n = 3) => {
    for (let i = 0; i < n; i++) {
      e.tick();
      await sleepO(40);
    }
  };

  it('AC-08 선행 작업이 병합 완료되기 전(진행·검수·검수 통과)에는 후속 작업이 시작되지 않는다 — 담당자·자리가 비어 있어도', async () => {
    env = await bootOrch();
    const e = env;
    const d = seedDirective(e, '로그인');
    const A = e.core.tasks.create({ directiveId: d.id, title: '로그인 API', goal: 'API 구현', type: 'development', assigneeId: e.devId, acceptanceCriteria: ['API가 동작한다'], outputMode: 'repo' }, e.producerId);
    const B = e.core.tasks.create(
      { directiveId: d.id, title: '로그인 테스트', goal: '테스트 작성', type: 'test', assigneeId: e.qaId, prerequisiteIds: [A.id], acceptanceCriteria: ['테스트가 통과한다'], outputMode: 'repo' },
      e.producerId,
    );
    e.hold.add(taskKey(A.id));
    e.tick();
    await waitO(() => !!e.liveProc(taskKey(A.id)), 'A 시작');
    await ticks(e);
    expect(e.core.turns.isMemberRunning(e.qaId)).toBe(false); // QA는 놀고 있다
    expect(e.core.turns.count()).toBeLessThan(5); // 자리도 남는다
    expect(startedB(e, B.id), '진행 중').toBe(false);
    expect(e.ctx.store.tasks.require(B.id)).toMatchObject({ state: 'waiting', activatedAt: null, workspace: null });

    // A: 단계 완료 → 제출 → 검수
    const proc = e.liveProc(taskKey(A.id))!;
    expect((await e.tool(proc.turnId, 'set_steps', { steps: ['API 구현'] })).ok).toBe(true);
    writeFileSync(join(e.ctx.store.tasks.require(A.id).workspace!.worktreePath, 'api.txt'), 'api\n', 'utf8');
    expect((await e.tool(proc.turnId, 'complete_step', { step_index: 0, note: '완료' })).ok).toBe(true);
    expect((await e.tool(proc.turnId, 'submit_for_review', { note: '제출' })).ok).toBe(true);
    proc.finishOk();
    await waitO(() => e.ctx.store.tasks.require(A.id).state === 'in_review', 'A 검수');
    await ticks(e);
    expect(startedB(e, B.id), '검수 중').toBe(false);

    // A: 검수 통과(아직 병합 전)
    const producer = e.ctx.store.members.require(e.producerId);
    e.core.tasks.submitReview(A.id, producer, { verdict: 'pass', criteria: [{ criterion: 'API가 동작한다', pass: true, note: '확인' }], reason: '' }, null);
    expect(e.ctx.store.tasks.require(A.id).review.passed).not.toBeNull();
    await ticks(e);
    expect(startedB(e, B.id), '검수 통과·병합 전').toBe(false);

    // A: 병합 → 완료 → 그제야 B 시작
    expect(e.core.merges.requestMerge(A.id, producer, null).status).toBe('queued');
    await waitO(() => e.ctx.store.tasks.require(A.id).state === 'done' && !e.core.merges.isPending(A.id), 'A 완료');
    e.hold.add(taskKey(B.id));
    e.tick();
    await waitO(() => !!e.liveProc(taskKey(B.id)), 'B 시작');
    const b = e.ctx.store.tasks.require(B.id);
    expect(b.state).toBe('in_progress');
    expect(Date.parse(b.activatedAt!)).toBeGreaterThanOrEqual(Date.parse(e.ctx.store.tasks.require(A.id).completedAt!));
  });

  it('AC-08 선행 작업이 취소되면 후속 작업은 시작되지 않고 보류(선행 작업 취소)되어 프로듀서에게 재계획이 간다 (TSK-04)', async () => {
    await env?.close();
    env = await bootOrch();
    const e = env;
    const d = seedDirective(e, '결제');
    const A = e.core.tasks.create({ directiveId: d.id, title: '결제 API', goal: 'API', type: 'development', assigneeId: e.devId, acceptanceCriteria: ['동작'], outputMode: 'repo' }, e.producerId);
    const B = e.core.tasks.create({ directiveId: d.id, title: '결제 테스트', goal: '테스트', type: 'test', assigneeId: e.qaId, prerequisiteIds: [A.id], acceptanceCriteria: ['통과'], outputMode: 'repo' }, e.producerId);
    e.hold.add(taskKey(A.id));
    e.tick();
    await waitO(() => !!e.liveProc(taskKey(A.id)), 'A 시작');
    await e.main('cancel_task', { task_id: A.id });
    await waitO(() => e.ctx.store.tasks.require(A.id).state === 'cancelled', 'A 취소');
    await ticks(e);
    const b = e.ctx.store.tasks.require(B.id);
    expect(b.state).toBe('on_hold');
    expect(b.hold.reasons.map((r) => r.kind)).toContain('prereq_cancelled');
    expect(b.activatedAt).toBeNull();
    expect(e.launches.some((l) => l.workKey === taskKey(B.id))).toBe(false);
    expect(e.ctx.store.queue.list().some((q) => q.kind === 'replan' && q.taskId === B.id && q.memberId === e.producerId)).toBe(true);
  });
});

describe('AC-17 팀원에게 가는 지시의 공유 (턴 단위, v0.6 — 대표 직접 메시지 없음)', () => {
  let env: OrchEnv | null = null;
  afterAll(async () => {
    await env?.close();
  });
  const TEXT = '로그인 버튼은 파란색으로 해 주세요';

  /**
   * 개발자가 작업 턴을 돌고 있다. 대표 세션에서 팀원에게 직접 보내는 길(members.sendMessage)은 없고(알 수 없는 요청), 대표가 명령하면 메인 에이전트가
   * instruct_member로 그 팀원에게 직접 지시한다 (CMD-06 — 같은 내용이 프로듀서에게 공유된다)
   */
  async function setup(): Promise<{ e: OrchEnv; directiveId: string; taskId: string }> {
    await env?.close();
    env = await bootOrch();
    const e = env;
    const d = seedDirective(e, '로그인 화면');
    const t = e.core.tasks.create({ directiveId: d.id, title: '로그인 화면', goal: '화면', type: 'development', assigneeId: e.devId, acceptanceCriteria: ['화면이 있다'], outputMode: 'repo' }, e.producerId);
    e.hold.add(taskKey(t.id));
    e.tick();
    await waitO(() => !!e.liveProc(taskKey(t.id)), '개발자 작업 턴');
    // 대표 세션의 팀원 직접 메시지는 없다(알 수 없는 요청) — 거부 기록도 메시지도 생기지 않는다
    await expect((e.invoke as unknown as (m: string, ...a: unknown[]) => Promise<unknown>)('members.sendMessage', e.devId, TEXT, false)).rejects.toMatchObject({ code: 'not_found' });
    expect(e.ctx.store.activity.search({ text: '대표 권한 밖 요청 거부: members.sendMessage', limit: 5 })).toHaveLength(0);
    expect(e.ctx.store.messages.list()).toEqual([]);
    // 메인 에이전트의 직접 지시
    await e.main('instruct_member', { member_id: e.devId, text: TEXT });
    return { e, directiveId: d.id, taskId: t.id };
  }

  it('AC-17 메인 에이전트가 팀원에게 보낸 직접 지시는 프로듀서에게 공유되고, 팀원 상세(화면)에 \'메인 지시\'로 보인다', async () => {
    const { e } = await setup();
    const msg = e.ctx.store.messages.list().find((m) => m.text.includes(TEXT));
    expect(msg).toMatchObject({ fromActor: MAIN_AGENT_ID, toMemberId: e.devId });
    expect(msg!.sharedWith).toEqual([e.producerId]);
    for (const id of [e.devId, e.producerId]) {
      const detail = await e.invoke('members.getDetail', id);
      const shown = detail.messages.find((m) => m.text.includes(TEXT));
      expect(shown, `${id} 상세`).toBeDefined();
      expect(shown!.from, `${id} 상세`).toContain('메인 에이전트 지시');
    }
  });

  it('AC-17 메인 에이전트의 직접 지시는 프로듀서 에이전트에게도 보인다 — 프로듀서의 다음 턴 메시지·업무 문맥(get_work_context)에 들어간다', async () => {
    const { e, directiveId } = await setup();
    // 프로듀서: 공유받은 지시가 지시 관리 세션의 다음 턴에 간다
    e.hold.add(directiveKey(directiveId));
    e.tick();
    await waitO(() => !!e.liveProc(directiveKey(directiveId), e.producerId), '프로듀서 턴');
    const p = e.liveProc(directiveKey(directiveId), e.producerId)!;
    const pSeen = e.launches.find((l) => l.turnId === p.turnId)!.message + JSON.stringify(await e.tool(p.turnId, 'get_work_context', {}));
    expect(pSeen, '프로듀서 턴 입력(메시지·업무 문맥)에 메인 에이전트의 지시가 없다').toContain('로그인 버튼은 파란색');
  });
});

describe('AC-23 프로젝트 기억 (턴 단위)', () => {
  let env: OrchEnv | null = null;
  const extra: string[] = [];
  afterAll(async () => {
    await env?.close();
    for (const d of extra) rmrf(d);
  });

  it('AC-23 프로젝트를 골라 명령하면 메인 에이전트가 그 프로젝트 세션에서 그 프로젝트 기억을 불러 답하고, 답은 그 프로젝트 대화에 남는다', async () => {
    env = await bootOrch();
    const e = env;
    const root2 = mkdtempSync(join(tmpdir(), 'wook-test-acc-p2-'));
    extra.push(root2);
    const p2 = await e.internal('projects.create', { mode: 'new', path: join(root2, 'p2'), name: '두 번째 프로젝트' });
    e.core.memory.write(e.projectId, '# 턴 회귀 기억\n\n## 대표 선호\n- 버튼은 파란색 (P1 선호)\n');
    e.core.memory.write(p2.id, '# 두 번째 프로젝트 기억\n\n## 대표 선호\n- 버튼은 빨간색 (P2 선호)\n');

    await e.invoke('command.send', { target: e.projectId, text: '다음에 무엇을 하면 좋을까?' });
    const key1 = mainKey(e.projectId);
    expect(e.ctx.store.queue.list({ ref2: key1, state: 'queued' }).map((q) => q.kind)).toContain('main_command');
    e.hold.add(key1);
    e.tick();
    await waitO(() => !!e.liveProc(key1, MAIN_AGENT_ID), '메인 에이전트 턴 (P1)');
    const proc = e.liveProc(key1, MAIN_AGENT_ID)!;
    const launch = e.launches.find((l) => l.turnId === proc.turnId)!;
    // 그 프로젝트 기억을 먼저 불러오라는 안내가 턴 메시지에 들어간다 (MEM-07)
    expect(launch.message).toContain(`read_memory(project_id="${e.projectId}")`);
    const wc = await e.tool(proc.turnId, 'get_work_context', {});
    expect(wc.ok && (wc.data as { project: { id: string } | null }).project?.id).toBe(e.projectId);
    const mem = await e.tool(proc.turnId, 'read_memory', { project_id: e.projectId });
    expect(mem.ok).toBe(true);
    const content = (mem.ok ? (mem.data as { content: string }).content : '') ?? '';
    expect(content).toContain('P1 선호');
    expect(content).not.toContain('P2 선호');
    proc.finishOk('기억에 따라 파란 버튼 기준으로 다음 작업을 제안합니다');
    await e.idle();
    const h1 = await e.invoke('command.history', e.projectId, {});
    expect(h1.some((x) => x.role === 'main_agent' && x.text.includes('파란 버튼'))).toBe(true);
    expect((await e.invoke('command.history', p2.id, {})).some((x) => x.text.includes('파란 버튼'))).toBe(false);

    // 다른 프로젝트를 고르면 다른 세션·그 프로젝트 기억으로
    await e.invoke('command.send', { target: p2.id, text: '이 프로젝트 상태는?' });
    const key2 = mainKey(p2.id);
    e.hold.add(key2);
    e.tick();
    await waitO(() => !!e.liveProc(key2, MAIN_AGENT_ID), '메인 에이전트 턴 (P2)');
    const proc2 = e.liveProc(key2, MAIN_AGENT_ID)!;
    expect(e.launches.find((l) => l.turnId === proc2.turnId)!.message).toContain(`read_memory(project_id="${p2.id}")`);
    const s1 = e.ctx.store.sessions.list({ ref2: key1 });
    const s2 = e.ctx.store.sessions.list({ ref2: key2 });
    expect(s1.length).toBeGreaterThan(0);
    expect(s2.length).toBeGreaterThan(0);
    expect(s1.some((a) => s2.some((b) => b.id === a.id))).toBe(false);
    proc2.finishOk('두 번째 프로젝트 상태를 정리했습니다');
    await e.idle();
  });
});

describe('AC-21 보고서 양식 경계 (턴 단위)', () => {
  let env: OrchEnv | null = null;
  afterAll(async () => {
    await env?.close();
  });

  it('AC-21 메인 에이전트가 요약을 3줄 넘게 써도 문서함에는 양식(요약 3줄 이내)에 맞는 보고서만 남는다', async () => {
    env = await bootOrch();
    const e = env;
    const d = seedDirective(e, '보고 양식');
    e.ctx.store.directives.put({
      ...d,
      state: 'reporting',
      finalResult: { round: 1, summary: '정리', outputs: [], changedFiles: [], issues: [], nextSteps: [], submittedAt: e.ctx.now(), by: e.producerId },
    });
    e.core.directives.queueMainReport(e.ctx.store.directives.require(d.id));
    const key = mainKey(e.projectId);
    e.hold.add(key);
    e.tick();
    await waitO(() => !!e.liveProc(key, MAIN_AGENT_ID), '보고서 작성 턴');
    const proc = e.liveProc(key, MAIN_AGENT_ID)!;
    const summary = ['1. 로그인 화면을 만들었습니다', '2. API를 연결했습니다', '3. 테스트를 추가했습니다', '4. 문서를 정리했습니다', '5. 배포를 준비했습니다'].join('\n');
    const r = await e.tool(proc.turnId, 'submit_report', { directive_id: d.id, title: '보고', summary, results: '결과', changed_files: [], how_to_verify: '화면 확인', issues: '', next_steps: '' });
    proc.finishOk();
    await e.idle();
    if (!r.ok) {
      // 앱이 양식 위반으로 거부해 다시 쓰게 하는 것도 기준 충족이다
      expect(r.code).toBe('invalid');
      expect(e.ctx.store.reports.list({ ref1: d.id })).toHaveLength(0);
      return;
    }
    const rep = e.ctx.store.reports.list({ ref1: d.id })[0]!;
    const lines = section(readFileSync(rep.filePath, 'utf8'), '## 요약')
      .split('\n')
      .filter((l) => l.trim());
    expect(lines.length, `저장된 보고서의 요약이 ${lines.length}줄`).toBeLessThanOrEqual(3);
  });
});

// ───────────────────────── 3. 실제 모의 에이전트 프로세스로 끝까지 ─────────────────────────

describe('전체 흐름: 명령 → 지시 → 계획 → 작업 → 검수 → 병합 → 보고 → 결과 승인 (실제 프로세스)', () => {
  let app: FlowApp;
  let did = '';
  const store = () => app.core.ctx.store;
  const tasksOf = (): Task[] => store().tasks.list({ ref1: did });

  beforeAll(async () => {
    app = await createFlowApp({ team: ['developer', 'qa'], speed: 8 });
    did = await sendCommand(app, '로그인 화면을 만들어 줘');
    await app.waitFor(() => store().directives.get(did)?.state === 'awaiting_confirmation', '1회차 보고 도착', 150_000);
    await sleep(400); // 마지막 화면 푸시
  }, 180_000);
  afterAll(async () => {
    await app?.close();
  });

  it('AC-06 명령을 보내면 지시가 접수 → 계획 → 진행으로 바뀌고, 프로듀서가 만든 작업이 팀원에게 배정되어 그 팀원이 실행한다', () => {
    const tr = store().transitions.list(did).map((t) => `${t.from}>${t.to}`);
    expect(tr.slice(0, 3)).toEqual(['->received', 'received>planning', 'planning>in_progress']);
    const conv = store().conversation.list({ ref1: app.projectId });
    const cmd = conv.find((c) => c.role === 'owner' && c.text.includes('로그인 화면을 만들어 줘'))!;
    expect(cmd).toBeDefined();
    expect(cmd.createdAt <= store().directives.require(did).createdAt).toBe(true);
    // 화면 활동 기록에도 바뀐 순서대로
    const acts = store().activity.search({ kinds: ['directive'], limit: 200 }).filter((a) => a.directiveId === did).reverse().map((a) => a.text);
    const toPlanning = acts.findIndex((t) => t.includes('접수 → 계획'));
    const toProgress = acts.findIndex((t) => t.includes('계획 → 진행'));
    expect(toPlanning).toBeGreaterThanOrEqual(0);
    expect(toProgress).toBeGreaterThan(toPlanning);
    const tasks = tasksOf();
    expect(tasks).toHaveLength(2);
    for (const t of tasks) {
      expect(t.createdBy).toBe(app.members.producer);
      const ran = store().turns.list().filter((x) => x.taskId === t.id && x.sessionKind === 'task');
      expect(ran.length).toBeGreaterThan(0);
      expect(ran.every((x) => x.memberId === t.assigneeId)).toBe(true);
    }
    expect(new Set(tasks.map((t) => t.assigneeId))).toEqual(new Set([app.members.developer, app.members.qa]));
  });

  it('AC-07 팀원이 단계를 끝낼 때마다 진행도(작업·팀원 카드·지시)가 2초 안에 화면 푸시에 반영된다 (제품 기본 푸시 주기)', async () => {
    const tasks = tasksOf();
    const ids = new Set(tasks.map((t) => t.id));
    const stepDone = store()
      .activity.search({ kinds: ['task'], limit: 5000 })
      .filter((a) => a.taskId && ids.has(a.taskId) && /단계 \d+ 완료/.test(a.text));
    const totalSteps = tasks.reduce((n, t) => n + store().steps.list(t.id).length, 0);
    expect(stepDone.length).toBe(totalSteps);
    expect(totalSteps).toBeGreaterThanOrEqual(6);
    const latencies: number[] = [];
    for (const ev of stepDone) {
      const idx = Number(/단계 (\d+) 완료/.exec(ev.text)![1]) - 1;
      const t0 = Date.parse(ev.ts);
      const hit = app.snapshots.find((s) => s.payload.tasks.find((x) => x.id === ev.taskId)?.steps.find((st) => st.idx === idx)?.done);
      expect(hit, `${ev.taskId} 단계 ${idx + 1} 반영 스냅샷`).toBeDefined();
      latencies.push(hit!.at - t0);
      const tv = hit!.payload.tasks.find((x) => x.id === ev.taskId)!;
      const mv = hit!.payload.members.find((m) => m.id === tv.assigneeId)!;
      expect(mv.currentTask?.id).toBe(tv.id);
      expect(mv.currentTask!.progress.done).toBe(tv.progress.done);
      const dv = hit!.payload.directives.find((x) => x.id === did)!;
      const roundTasks = hit!.payload.tasks.filter((x) => x.directiveId === did && x.round === dv.round);
      expect(dv.progress.done).toBe(roundTasks.reduce((n, x) => n + x.progress.done, 0));
      // 전체 현황 홈의 프로젝트 카드 진행도 (진행 중 지시가 이것 하나)
      expect(hit!.payload.projects.find((p) => p.id === app.projectId)!.progress.done).toBe(dv.progress.done);
      // 실제 화면(스튜디오 팀원 카드)에도 그 진행도가 그려진다
      const card = memberCard(await renderStudio(hit!.payload, app.projectId), mv.name);
      expect(card).toContain(`${tv.progress.done}/${tv.progress.total}`);
    }
    measure('AC-07 단계 완료 → 화면 푸시 지연(ms)', latencies);
    expect(Math.max(...latencies), `단계 반영 지연(ms): ${latencies.join(', ')}`).toBeLessThanOrEqual(2000);
  });

  it('AC-08 (실제 흐름) QA 작업은 선행 개발 작업이 완료(병합)된 뒤에야 활성화·실행된다', () => {
    const tasks = tasksOf();
    const dev = tasks.find((t) => t.assigneeId === app.members.developer)!;
    const qa = tasks.find((t) => t.assigneeId === app.members.qa)!;
    expect(qa.prerequisiteIds).toEqual([dev.id]);
    expect(dev.state).toBe('done');
    const devDone = Date.parse(dev.completedAt!);
    expect(Date.parse(qa.activatedAt!)).toBeGreaterThanOrEqual(devDone);
    const qaTurns = store().turns.list().filter((x) => x.taskId === qa.id && x.sessionKind === 'task');
    expect(qaTurns.length).toBeGreaterThan(0);
    expect(Math.min(...qaTurns.map((x) => Date.parse(x.startedAt)))).toBeGreaterThanOrEqual(devDone);
    expect(Math.min(...app.spawns.filter((s) => s.workKey === taskKey(qa.id)).map((s) => s.at))).toBeGreaterThanOrEqual(devDone);
  });

  it('AC-21 지시가 끝나면 양식에 맞는 보고서가 문서함(앱 데이터 보고서 폴더)에 저장되고 일반 알림(OS 알림·알림함·대표 할 일)이 온다', async () => {
    const reports = store().reports.list({ ref1: did });
    expect(reports).toHaveLength(1);
    const r = reports[0]!;
    // RPT-03 파일 이름·위치
    expect(norm(r.filePath).startsWith(norm(join(app.dataDir, 'reports')))).toBe(true);
    expect(r.filePath).toMatch(/[\\/]reports[\\/]흐름 프로젝트[\\/]\d{4}-\d{2}[\\/]\d{4}-\d{2}-\d{2}_D-\d{4}_[^\\/]+_v1\.md$/);
    expect(existsSync(r.filePath)).toBe(true);
    // RPT-02 양식: 요약 → 결과(변경 파일) → 확인 방법 → 이슈·리스크 → 다음 할 일 → 작업 통계
    const md = readFileSync(r.filePath, 'utf8');
    const order = ['## 요약', '## 결과', '### 변경 파일', '## 확인 방법', '## 이슈·리스크', '## 다음 할 일', '## 작업 통계'].map((h) => md.split('\n').findIndex((l) => l.trim() === h));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    for (const row of ['작업 수', '반려 횟수', '소요 시간', '사용량']) expect(md).toContain(`| ${row} |`);
    expect(md).toContain('| 작업 수 | 2개 |');
    const summaryLines = section(md, '## 요약').split('\n').filter((l) => l.trim());
    expect(summaryLines.length).toBeGreaterThan(0);
    expect(summaryLines.length).toBeLessThanOrEqual(3);
    expect(section(md, '## 결과')).toContain('wook-mock/');
    // 문서함 목록·상세
    const list = await app.invoke('reports.list', {});
    expect(list.find((x) => x.id === r.id)).toMatchObject({ directiveId: did, round: 1, status: 'new', projectName: '흐름 프로젝트' });
    const detail = await app.invoke('reports.get', r.id);
    expect(detail.markdown).toBe(md);
    // 알림 (12장 일반): 앱 알림 푸시 + OS 알림 + 알림함 배지 + 대표 할 일
    const n = app.notifications.find((x) => x.payload.title === '보고서 도착');
    expect(n?.payload).toMatchObject({ level: 'normal', read: false, link: { tab: 'documents', reportId: r.id, projectId: app.projectId } });
    expect(n!.at).toBeGreaterThanOrEqual(Date.parse(r.createdAt) - 5);
    expect(app.osNotices.some((x) => x.title === '보고서 도착' && x.level === 'normal' && x.body.includes(r.title))).toBe(true);
    const snap = app.core.views.snapshot();
    expect(snap.notifications.unread).toBeGreaterThan(0);
    expect(snap.ownerTodos.some((t) => t.kind === 'unread_report' && t.reportId === r.id)).toBe(true);
    expect(snap.directives.find((x) => x.id === did)?.latestReportId).toBe(r.id);
  });

  it('AC-27 팀원에게 작업이 배정되면 그 팀원의 CLI가 그 작업 폴더(worktree)에서 실행되고, 실시간 로그와 진행도가 화면에 나온다', async () => {
    for (const t of tasksOf()) {
      const member = store().members.require(t.assigneeId);
      const expected = taskWorktreePath(app.core.ctx.paths, app.projectId, t.id);
      // 실제로 띄운 CLI 프로세스의 실행 위치 = 그 작업의 worktree, 형식 = 그 팀원의 AI 종류
      const spawns = app.spawns.filter((s) => s.workKey === taskKey(t.id));
      expect(spawns.length).toBeGreaterThan(0);
      for (const s of spawns) {
        expect(norm(s.spec.cwd)).toBe(norm(expected));
        expect(s.memberId).toBe(t.assigneeId);
        expect(s.format).toBe(member.ai.kind);
      }
      // 작업 브랜치 (한글 제목이면 짧은 이름 없이 작업 ID만 — core/ids.ts branchSlug)
      expect(t.workspace?.branch).toMatch(new RegExp(`^task/${t.id}(-[a-z0-9-]+)?$`));
      for (const s of store().sessions.list({ ref2: taskKey(t.id) })) expect(norm(s.cwd)).toBe(norm(expected));
      // CLI가 쓴 파일이 그 작업 폴더에서 작업 브랜치 커밋으로 남았다 (프로그램 커밋, GIT-05)
      const step0 = store().steps.list(t.id)[0]!;
      expect(step0.commitSha).toMatch(/^[0-9a-f]{40}$/);
      expect(git(app.projectDir, ['show', '--name-only', '--format=', step0.commitSha!]).split('\n')).toContain(`wook-mock/${t.id}/step-1.md`);

      // 실시간 로그: 그 작업 턴이 아직 일하는 동안(마지막 단계 완료 전) 화면으로 CLI 이벤트가 푸시됐다
      const turn = store()
        .turns.list()
        .filter((x) => x.taskId === t.id && x.sessionKind === 'task')
        .find((x) => x.stepsCompleted > 0)!;
      const stepTimes = store()
        .activity.search({ turnId: turn.id, limit: 500 })
        .filter((a) => /단계 \d+ 완료/.test(a.text))
        .map((a) => Date.parse(a.ts));
      expect(stepTimes.length).toBeGreaterThan(0);
      const lastStep = Math.max(...stepTimes);
      const pushed = app.cliEvents.filter((c) => c.payload.turnId === turn.id && c.payload.memberId === t.assigneeId);
      expect(pushed.length).toBeGreaterThan(0);
      measure(`AC-27 ${t.id} 실시간 로그 푸시 (턴 ${turn.id}): 첫 푸시가 마지막 단계보다 앞선 ms, 푸시 수`, [lastStep - Math.min(...pushed.map((c) => c.at)), pushed.length]);
      expect(pushed.some((c) => c.at < lastStep), '마지막 단계 전에 받은 실시간 로그').toBe(true);
      // 저장된 로그 조회 (팀원 상세의 CLI 기록)
      const page = await app.invoke('members.getEvents', t.assigneeId, { turnId: turn.id, limit: 1000 });
      expect(page.events.length).toBe(turn.eventCount);
      expect(page.events.some((ev) => ev.kind === 'mcp_call' && ev.text.includes('complete_step'))).toBe(true);
      // 화면: 실행 중 스냅샷에 그 팀원의 최근 로그 한 줄과 현재 작업 진행도 → 스튜디오 카드에 그려진다
      const live = app.snapshots.find((s) => {
        const m = s.payload.members.find((x) => x.id === t.assigneeId);
        return m?.currentWork?.turnId === turn.id && !!m.lastLine && m.currentTask?.id === t.id && m.currentTask.progress.done > 0;
      });
      expect(live, `${t.id} 실행 중 화면 스냅샷`).toBeDefined();
      const mv = live!.payload.members.find((x) => x.id === t.assigneeId)!;
      const card = memberCard(await renderStudio(live!.payload, app.projectId), mv.name);
      expect(card).toContain(esc(mv.lastLine!));
      expect(card).toContain(`${mv.currentTask!.progress.done}/${mv.currentTask!.progress.total}`);
    }
  });

  it('AC-49 결과 승인은 이미 반영·확정된 결과를 확인해 지시를 종료한다 — 바이패스 실행 중에도 독립 검수와 결과 승인은 유지되고 승인은 새 실행을 만들지 않는다', async () => {
    const d0 = store().directives.require(did);
    expect(d0.state).toBe('awaiting_confirmation');
    const tasks = tasksOf();
    // 이미 반영·확정: 이번 회차 작업이 모두 완료되고 저장소 변경형은 main에 병합됐다
    expect(tasks.every((t) => t.state === 'done')).toBe(true);
    for (const t of tasks.filter((x) => x.outputMode === 'repo')) {
      expect(t.merge?.mergeCommitSha).toMatch(/^[0-9a-f]{40}$/);
      git(app.projectDir, ['merge-base', '--is-ancestor', t.merge!.mergeCommitSha, 'refs/heads/main']);
    }
    // 독립 검수 유지: 완료 전에 작업자·참여자가 아닌 검수자의 통과 기록이 있다
    for (const t of tasks) {
      const pass = store().reviews.list({ ref1: t.id }).find((r) => r.verdict === 'pass');
      expect(pass, `${t.id} 통과 기록`).toBeDefined();
      expect(pass!.reviewerId).not.toBe(t.assigneeId);
      expect(t.contributors).not.toContain(pass!.reviewerId);
      expect(pass!.createdAt <= t.completedAt!).toBe(true);
    }
    // 바이패스: 모든 CLI 턴이 승인 대기 없이 돌았다 (불일치 없음, Claude 형식은 bypassPermissions 확인)
    const turns = store().turns.list();
    expect(turns.every((t) => t.bypass !== 'mismatch')).toBe(true);
    expect(turns.some((t) => t.bypass === 'verified')).toBe(true);
    // 결과 승인은 자동으로 일어나지 않는다
    await sleep(1500);
    expect(store().directives.require(did).state).toBe('awaiting_confirmation');
    const r = store().reports.list({ ref1: did })[0]!;
    expect(['new', 'read']).toContain(store().reports.require(r.id).status);

    const mainBefore = git(app.projectDir, ['rev-parse', 'refs/heads/main']);
    const taskCount = store().tasks.count();
    const tApprove = Date.now();
    await app.invoke('reports.approve', r.id, '확인했습니다');
    const d = store().directives.require(did);
    expect(d.state).toBe('closed');
    expect(d.closedAt).not.toBeNull();
    expect(store().reports.require(r.id).status).toBe('approved');
    expect(store().transitions.list(did).pop()).toMatchObject({ from: 'awaiting_confirmation', event: 'approve', to: 'closed', actor: 'owner' });
    await sleep(1500);
    // 승인은 실행 허가가 아니다: main·작업이 그대로이고, 승인 뒤 새 턴은 메인 에이전트의 기억 갱신(FBK-05)뿐
    expect(git(app.projectDir, ['rev-parse', 'refs/heads/main'])).toBe(mainBefore);
    expect(store().tasks.count()).toBe(taskCount);
    const after = store().turns.list().filter((t) => Date.parse(t.startedAt) >= tApprove);
    expect(after.every((t) => t.sessionKind === 'main_project')).toBe(true);
    // 선택적 계획 승인(TSK-07)은 2차 — 데이터 자리만 있고 기본 꺼짐
    expect(d.planApprovalRequired).toBe(false);
  });
});

describe('수정 요청 흐름 (실제 프로세스)', () => {
  let app: FlowApp;
  let did = '';
  const store = () => app.core.ctx.store;

  beforeAll(async () => {
    app = await createFlowApp({ team: ['developer', 'qa'], speed: 15 });
    did = await sendCommand(app, '회원가입 화면을 만들어 줘');
    await app.waitFor(() => store().directives.get(did)?.state === 'awaiting_confirmation', '1회차 보고 도착', 150_000);
  }, 180_000);
  afterAll(async () => {
    await app?.close();
  });

  it('AC-22 수정 요청은 메인 에이전트에게 가는 명령이다 — 지시는 확인 대기 그대로이고 메인 대기열에 수정 요청(코멘트 포함)이 생기며, 모의 메인이 revise_directive를 부르면 같은 지시 ID의 회차가 1 증가하고 확인 대기 → 계획으로 바뀐다. 새 작업 ID·새 보고서가 생기고 이전 완료 작업·보고서는 그대로다', async () => {
    const r1 = store().reports.list({ ref1: did })[0]!;
    const round1 = store().tasks.list({ ref1: did });
    const before = round1.map((t) => JSON.stringify({ id: t.id, state: t.state, round: t.round, completedAt: t.completedAt, merge: t.merge, title: t.title }));
    const r1File = readFileSync(r1.filePath, 'utf8');
    expect(round1.every((t) => t.state === 'done' && t.round === 1)).toBe(true);

    await app.invoke('reports.requestChanges', r1.id, { overall: '버튼 색을 파란색으로 바꿔 주세요', anchored: [{ quote: '결과', comment: '변경 파일을 더 자세히' }] });
    // 대표의 수정 요청 뒤: 지시는 확인 대기 그대로, 메인 대기열에 수정 요청(코멘트 포함) — 회차는 메인 에이전트가 연다 (FBK-03 v0.6)
    const d0 = store().directives.require(did);
    expect([d0.round, d0.state]).toEqual([1, 'awaiting_confirmation']);
    expect(store().transitions.list(did).some((x) => x.event === 'request_changes')).toBe(false);
    const cr = store().queue.list({ ref1: MAIN_AGENT_ID }).filter((q) => q.kind === 'change_request' && q.directiveId === did);
    expect(cr.map((q) => q.sessionKey)).toEqual([mainKey(app.projectId)]);
    expect(cr[0]!.message).toContain('버튼 색을 파란색으로 바꿔 주세요');
    expect(cr[0]!.message).toContain('"결과" → 변경 파일을 더 자세히');
    expect(store().queue.list().filter((q) => q.kind === 'plan' && q.directiveId === did && q.createdAt >= cr[0]!.createdAt)).toEqual([]);
    // 모의 메인이 revise_directive로 다음 회차를 연다
    await app.waitFor(() => store().transitions.list(did).some((x) => x.event === 'request_changes'), '메인 에이전트가 다음 회차를 엶', 60_000);
    const d1 = store().directives.require(did);
    expect(d1.id).toBe(did);
    expect(d1.round).toBe(2);
    expect(store().transitions.list(did).find((x) => x.event === 'request_changes')).toMatchObject({ from: 'awaiting_confirmation', event: 'request_changes', to: 'planning', actor: MAIN_AGENT_ID });
    expect(d1.rounds.map((x) => x.round)).toEqual([1, 2]);
    expect(d1.rounds[1]).toMatchObject({ text: '버튼 색을 파란색으로 바꿔 주세요', anchored: [{ quote: '결과', comment: '변경 파일을 더 자세히' }] });

    await app.waitFor(() => {
      const d = store().directives.get(did)!;
      return d.state === 'awaiting_confirmation' && d.round === 2 && !!d.rounds[1]?.reportId;
    }, '2회차 보고 도착', 150_000);
    const d2 = store().directives.require(did);
    // 새 작업 ID (2회차)
    const all = store().tasks.list({ ref1: did });
    const round2 = all.filter((t) => t.round === 2);
    expect(round2.length).toBeGreaterThan(0);
    const oldIds = new Set(round1.map((t) => t.id));
    expect(round2.every((t) => !oldIds.has(t.id) && t.state === 'done' && t.createdBy === app.members.producer)).toBe(true);
    // 새 보고서 (같은 지시, 2회차, _v2 파일)
    const r2 = store().reports.require(d2.rounds[1]!.reportId!);
    expect(r2.id).not.toBe(r1.id);
    expect(r2).toMatchObject({ directiveId: did, round: 2, status: 'new' });
    expect(r2.filePath).toMatch(/_v2\.md$/);
    expect(existsSync(r2.filePath)).toBe(true);
    expect(norm(r2.filePath)).not.toBe(norm(r1.filePath));
    // 이전 회차 보고서·작업은 그대로
    expect(d2.rounds[0]!.reportId).toBe(r1.id);
    expect(store().reports.require(r1.id)).toMatchObject({ round: 1, status: 'changes_requested' });
    expect(readFileSync(r1.filePath, 'utf8')).toBe(r1File);
    const now1 = store()
      .tasks.list({ ref1: did })
      .filter((t) => oldIds.has(t.id))
      .map((t) => JSON.stringify({ id: t.id, state: t.state, round: t.round, completedAt: t.completedAt, merge: t.merge, title: t.title }));
    expect(now1).toEqual(before);
    // 문서함에 두 회차가 모두 있고 서로 비교할 수 있다 (FBK-04)
    const list = await app.invoke('reports.list', {});
    expect(list.filter((x) => x.directiveId === did).map((x) => x.round).sort()).toEqual([1, 2]);
    expect((await app.invoke('reports.get', r2.id)).otherRounds).toEqual([{ id: r1.id, round: 1 }]);
    expect(store().activity.search({ kinds: ['directive'], limit: 200 }).some((a) => a.directiveId === did && a.text.includes('확인 대기 → 계획'))).toBe(true);
  });
});

// ───────────────────────── 4. 화면: 팀원 상세의 실시간 로그 ─────────────────────────

/**
 * 팀원 상세 패널(MemberPanel)을 실제 컴포넌트 함수로 돌린다. DOM 환경(jsdom 등)이 없어서 React의 useState·useEffect만
 * 같은 규칙(렌더마다 같은 순서, 의존값이 바뀐 효과만 렌더 뒤 실행, 상태가 바뀌면 다시 렌더)으로 흉내 낸다.
 * 화면에 그려지는 CLI 기록 줄(cli-event)을 반환된 요소 트리에서 읽는다.
 */
type StateSlot = { kind: 'state'; value: unknown };
type EffectSlot = { kind: 'effect'; deps?: unknown[]; cleanup?: () => void };
class HookHost<P> {
  private slots: (StateSlot | EffectSlot)[] = [];
  private i = 0;
  private queue: (() => void)[] = [];
  private dirty = false;
  tree: unknown = null;
  constructor(private readonly comp: (p: P) => unknown) {}
  useState = (init: unknown) => {
    const i = this.i++;
    if (!this.slots[i]) this.slots[i] = { kind: 'state', value: typeof init === 'function' ? (init as () => unknown)() : init };
    const slot = this.slots[i] as StateSlot;
    const set = (v: unknown) => {
      const next = typeof v === 'function' ? (v as (o: unknown) => unknown)(slot.value) : v;
      if (!Object.is(next, slot.value)) {
        slot.value = next;
        this.dirty = true;
      }
    };
    return [slot.value, set];
  };
  useEffect = (fn: () => void | (() => void), deps?: unknown[]) => {
    const i = this.i++;
    const prev = this.slots[i] as EffectSlot | undefined;
    const changed = !prev || !deps || !prev.deps || deps.length !== prev.deps.length || deps.some((d, k) => !Object.is(d, prev.deps![k]));
    if (!prev) this.slots[i] = { kind: 'effect' };
    const slot = this.slots[i] as EffectSlot;
    if (changed)
      this.queue.push(() => {
        slot.cleanup?.();
        const c = fn();
        slot.cleanup = typeof c === 'function' ? c : undefined;
        slot.deps = deps;
      });
  };
  async render(props: P): Promise<void> {
    for (let n = 0; n < 30; n++) {
      this.dirty = false;
      this.i = 0;
      this.tree = this.comp(props);
      const effects = this.queue.splice(0);
      for (const e of effects) e();
      for (let k = 0; k < 5; k++) await new Promise((r) => setTimeout(r, 0));
      if (!this.dirty && this.queue.length === 0) return;
    }
  }
}

/** 요소 트리에서 className에 cls가 든 요소의 key */
function keysOf(tree: unknown, cls: string): string[] {
  const out: string[] = [];
  const walk = (n: unknown) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== 'object') return;
    const el = n as { key?: string | null; props?: Record<string, unknown> };
    if (!el.props) return;
    if (typeof el.props.className === 'string' && el.props.className.split(' ').includes(cls) && el.key) out.push(el.key);
    for (const v of Object.values(el.props)) if (v && typeof v === 'object') walk(v);
  };
  walk(tree);
  return out;
}

describe('AC-27 팀원 상세 패널의 실시간 로그 (화면 컴포넌트)', () => {
  const MEMBER = 'M-0002';
  const turnView = (id: string, running: boolean) => ({
    id,
    sessionId: 'S-000010',
    startedAt: '2026-10-27T10:00:00.000Z',
    endedAt: running ? null : '2026-10-27T10:05:00.000Z',
    endReason: running ? null : ('completed' as const),
    endDetail: '',
    bypass: 'verified' as const,
    mcp: 'connected' as const,
    eventCount: 2,
    usage: null,
    running,
  });
  const ev = (turnId: string, seq: number, text: string): CliEvent => ({ kind: 'text', text, seq, ts: '2026-10-27T10:00:01.000Z', turnId });

  async function mountPanel(turns: () => ReturnType<typeof turnView>[]) {
    let cli: ((p: { memberId: string; turnId: string; events: CliEvent[] }) => void) | null = null;
    const detail = (): MemberDetail =>
      ({
        member: {
          id: MEMBER,
          projectId: 'P-0001',
          name: '윤슬',
          roleId: 'developer',
          roleName: '개발자',
          isProducer: false,
          isMain: false,
          canReview: false,
          ai: { kind: 'codex', model: null, effortTier: 'normal', effortOverride: null, effortValue: 'medium', modelValue: null, mock: true, mockScenario: 'normal' },
          pendingAiChange: null,
          aiDecision: null,
          status: 'working',
          statusReasons: ['업무 중'],
          currentTask: null,
          currentWork: null,
          queuedCount: 0,
          runSeconds: 0,
          currentSessionId: 'S-000010',
          lastActivityAt: null,
          lastLine: null,
          deleted: false,
        },
        role: { id: 'developer', name: '개발자', instructions: '', taskTypes: [], allowedSkills: [], defaultAi: { kind: 'codex', model: null, effortTier: 'normal', effortOverride: null }, canReview: false, builtin: true },
        sessions: [],
        recentTurns: turns(),
        currentTask: null,
        queuedTasks: [],
        history: [],
        messages: [],
      }) as unknown as MemberDetail;
    (globalThis as unknown as { window: unknown }).window = {
      wook: {
        platform: 'win32',
        invoke: async (method: string, ...args: unknown[]) => {
          if (method === 'members.getDetail') return detail();
          if (method === 'members.getEvents') {
            const tid = (args[1] as { turnId: string }).turnId;
            return { events: [ev(tid, 1, `${tid} 저장된 기록`)], nextCursor: null, turnId: tid };
          }
          if (method === 'tasks.getDiff') return null;
          return null;
        },
        subscribe: (topic: string, cb: (p: unknown) => void) => {
          if (topic === 'cliEvents') cli = cb as typeof cli;
          return () => {
            if (cli === cb) cli = null;
          };
        },
      },
      location: { search: '', hash: '' },
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() {
        return true;
      },
      setTimeout,
      clearTimeout,
    };
    vi.resetModules();
    let host: HookHost<Record<string, unknown>> | null = null;
    vi.doMock('react', async () => {
      const actual = await vi.importActual<typeof import('react')>('react');
      const useState = (init: unknown) => host!.useState(init);
      const useEffect = (fn: () => void | (() => void), deps?: unknown[]) => host!.useEffect(fn, deps);
      return { ...actual, useState, useEffect, default: { ...actual, useState, useEffect } };
    });
    const { MemberPanel } = await loadRenderer<{ MemberPanel: FunctionComponent<Record<string, unknown>> }>('components/MemberPanel.tsx');
    host = new HookHost(MemberPanel as unknown as (p: Record<string, unknown>) => unknown);
    const props = (version: number) => ({ id: MEMBER, snapshot: { version, roles: [] }, close: () => undefined, openTask: () => undefined });
    return {
      host,
      props,
      push: (turnId: string, seq: number, text: string) => cli?.({ memberId: MEMBER, turnId, events: [ev(turnId, seq, text)] }),
      shown: () => keysOf(host!.tree, 'cli-event'),
    };
  }

  afterAll(() => {
    vi.doUnmock('react');
    vi.resetModules();
  });

  it('AC-27 (대조) 패널을 연 뒤 실행 중인 턴의 CLI 이벤트가 오면 바로 화면 목록에 붙는다', async () => {
    const p = await mountPanel(() => [turnView('TN-000001', true)]);
    await p.host.render(p.props(1));
    expect(p.shown()).toEqual(['TN-000001-1']);
    p.push('TN-000001', 2, '단계 1 진행 중');
    await p.host.render(p.props(1));
    expect(p.shown()).toEqual(['TN-000001-1', 'TN-000001-2']);
  });

  it('AC-27 패널을 열어 둔 채 그 팀원에게 새 작업이 배정되어 새 턴이 시작되면, 새 턴의 실시간 로그가 화면에 나온다', async () => {
    let turns = [turnView('TN-000001', false)];
    const p = await mountPanel(() => turns);
    await p.host.render(p.props(1)); // 이전 작업이 끝난 팀원의 상세를 열어 둔 상태
    expect(p.shown()).toEqual(['TN-000001-1']);
    turns = [turnView('TN-000002', true), turnView('TN-000001', false)]; // 새 작업 배정 → 새 턴 시작 → 화면 스냅샷 갱신
    await p.host.render(p.props(2));
    p.push('TN-000002', 1, '새 작업 시작: 단계 목록 작성');
    p.push('TN-000002', 2, 'complete_step 단계 1');
    await p.host.render(p.props(3));
    expect(p.shown(), '새 턴(TN-000002)의 실시간 로그가 목록에 없다').toEqual(expect.arrayContaining(['TN-000002-1', 'TN-000002-2']));
  });
});
