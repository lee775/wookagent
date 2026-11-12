/**
 * 인수 테스트 — git 그룹 (기획서 17장 AC-10·11·12·42·45 / 7장 GIT-02..15, 7.1, 5.6 REV-04·07, 8장, ERR-07·08, CLI-09·18).
 *
 * 세 단계로 확인한다.
 * - 전체 흐름: tests/e2e/harness.ts (실제 SQLite·git·프로세스 러너·앱 도구 서버 + 실제 모의 에이전트 프로세스)
 * - 턴 단위: tests/regression/orchHarness.ts (실제 오케스트레이터 + 가짜 CLI) — 해결 못 한 충돌 턴이 반복될 때
 * - 서비스 경계: tests/regression/helpers.ts의 boot (스케줄러·CLI 없이 실제 git·저장소로 서비스·앱 도구 처리기 호출) —
 *   경합·충돌·되돌리기·재시작(같은 DB로 새 Core + 재시작 복구, git-helpers.ts restartServices) 조건을 정확히 만든다
 * 제품 코드는 바꾸지 않는다. 관찰·경합·종료 강제는 git 서비스 메서드를 감싸서 한다 (git-helpers.ts).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Task } from '@shared/domain';
import { MAIN_AGENT_ID } from '@shared/domain';
import { createAppToolServer } from '../../src/main/mcp/server';
import type { ToolCallLog } from '../../src/main/mcp/types';
import type { Env } from '../regression/helpers';
import { boot, commitOnMain } from '../regression/helpers';
import { bootOrch, seedDirective } from '../regression/orchHarness';
import { createHarness, sendCommand, type Harness } from '../e2e/harness';
import {
  activeRepoTask,
  addProject,
  baseMovedOnlyForward,
  changedFiles,
  driveToDone,
  fileAt,
  gate,
  git,
  gitOk,
  identityOf,
  mainSha,
  maxOverlap,
  mcpCall,
  mergeBy,
  mergeCommitsFor,
  parentsOf,
  passBy,
  passedRepoTask,
  restartServices,
  samePath,
  settled,
  sleep,
  submitRepoTask,
  treeFiles,
  waitUntil,
  watchMainChanges,
  writeFiles,
} from './git-helpers';

let env: Env | null = null;
let extra: (() => void)[] = [];
afterEach(async () => {
  await env?.close();
  env = null;
  for (const f of extra) f();
  extra = [];
});

const repoTasks = (h: Harness, did: string) => h.core.ctx.store.tasks.list({ ref1: did }).filter((t) => t.outputMode === 'repo');
const holdKinds = (t: Task) => t.hold.reasons.map((r) => r.kind);
const gitExecs = (core: Env['core'], taskId: string, kind: string) => core.ctx.store.execs.list({ ref1: taskId }).filter((x) => x.kind === kind);
const reviewsOf = (core: Env['core'], taskId: string) => core.ctx.store.reviews.list({ ref1: taskId });
const PASS = (t: Task) => ({ verdict: 'pass' as const, criteria: t.acceptanceCriteria.map((c) => ({ criterion: c, pass: true, note: '확인' })), reason: '' });
const taskIdOf = (label: string) => /^\[(T-\d+)\]/.exec(label)?.[1] ?? null;

async function waitDirective(h: Harness, did: string, state: string, ms = 90_000): Promise<void> {
  await h.waitFor(() => h.core.ctx.store.directives.get(did)?.state === state, { timeoutMs: ms, label: `지시 ${did} ${state}` });
}

/**
 * 앱이 꺼진 흉내(끝나지 않는 git 단계)로 버린 첫 인스턴스의 저장소. 그 인스턴스의 stop은 진행 중인 프로그램 작업이 끝나기를 기다리다 상한을 넘겨 저장소를 연 채
 * 돌아온다(orchestrator.ts stop의 leftover — 멈춘 단계가 끝나지 않으니 끝내 닫지 않는다). Windows에서는 열린 wook.db 때문에 하네스가 데이터 폴더를 지우지 못해
 * 시험 실행 폴더에 남았다(리드 결정 S9-18이 넘긴 낮은 항목). 다시 띄운 하네스를 닫기 전에 이 저장소를 닫는다 — 멈춘 단계는 이어지지 않으므로 닫힌 저장소를 쓰지 않는다
 */
const abandoned: { close(): void }[] = [];
async function restartAfterCrash(h: Harness): Promise<Harness> {
  abandoned.push(h.core.ctx.store);
  return h.restart();
}
async function closeAfterCrash(h: Harness): Promise<void> {
  for (const store of abandoned.splice(0)) {
    try {
      store.close();
    } catch {
      // 첫 인스턴스가 스스로 닫았다 (멈춘 단계가 없었다)
    }
  }
  await h.close();
}

// ═══════════════════════════════════════ AC-10 ═══════════════════════════════════════

describe('AC-10 팀원별 worktree · main 병합 요청은 그 프로듀서만 · 프로그램이 독립 검수·버전 일치·프로젝트 잠금을 확인해 병합', () => {
  it('정상 앱 작업 흐름: 팀원마다 자기 작업 브랜치·worktree에서 일하고, main은 프로듀서가 요청한 작업별 병합 커밋으로만 바뀐다 — 독립 검수를 통과한 그 버전이, 그 작업의 프로젝트 잠금 안에서, 겹침 없이', async () => {
    const h = await createHarness({ team: ['developer', 'developer', 'qa'] });
    try {
      const repo = h.projectDir;
      const store = h.core.ctx.store;
      const start = git(repo, ['rev-parse', 'refs/heads/main']);
      const events = watchMainChanges(h.core.ctx.deps.git, () => h.core.locks.holder(h.projectId));
      const did = await sendCommand(h, '로그인 화면과 로그인 API를 만들어 줘');
      await waitDirective(h, did, 'awaiting_confirmation');
      const tasks = repoTasks(h, did);
      expect(tasks).toHaveLength(3);
      expect(new Set(tasks.map((t) => t.assigneeId)).size).toBe(3);

      const worktrees = tasks.map((t) => t.workspace!.worktreePath);
      const paths = new Set<string>();
      const branches = new Set<string>();
      for (const t of tasks) {
        expect(t.state).toBe('done');
        // 작업 1건 = 브랜치 1개 + worktree 1개, 이름 task/<작업ID>-짧은이름 (GIT-02)
        expect(t.workspace!.branch.startsWith(`task/${t.id}-`)).toBe(true);
        expect(samePath(t.workspace!.worktreePath, join(h.dataDir, 'worktrees', h.projectId, t.id))).toBe(true);
        expect(samePath(t.workspace!.worktreePath, repo)).toBe(false);
        paths.add(resolve(t.workspace!.worktreePath).toLowerCase());
        branches.add(t.workspace!.branch);
        // 그 작업의 CLI 세션은 담당 팀원으로만, 그 worktree에서만 실행됐다 (CLI-03)
        const sessions = store.sessions.list({ ref2: `task:${t.id}` });
        expect(sessions.length).toBeGreaterThan(0);
        for (const s of sessions) {
          expect(s.memberId).toBe(t.assigneeId);
          expect(samePath(s.cwd, t.workspace!.worktreePath)).toBe(true);
        }
        // 검수 세션은 누구의 worktree도 아닌 검수용 사본에서 (REV-08, CLI-03)
        const reviewSessions = store.sessions.list({ ref2: `review:${t.id}` });
        expect(reviewSessions.length).toBeGreaterThan(0);
        for (const s of reviewSessions) {
          expect(worktrees.some((w) => samePath(w, s.cwd))).toBe(false);
          expect(resolve(s.cwd).toLowerCase().startsWith(resolve(h.dataDir, 'review').toLowerCase())).toBe(true);
        }
        // 단계 커밋은 그 작업 브랜치에 담당 팀원 이름으로 — 시작 시점 main에는 없다 (GIT-03·05)
        const steps = store.steps.list(t.id).filter((s) => s.commitSha);
        expect(steps.length).toBeGreaterThan(0);
        for (const s of steps) {
          const [email, subject] = git(repo, ['log', '-1', '--format=%ae|%s', s.commitSha!]).split('|');
          expect(email).toBe(`${t.assigneeId}@wook.local`);
          expect(subject).toBe(`[${t.id}] ${s.title}`);
          expect(gitOk(repo, ['merge-base', '--is-ancestor', s.commitSha!, t.merge!.taskCommitSha])).toBe(true);
          expect(gitOk(repo, ['merge-base', '--is-ancestor', s.commitSha!, start])).toBe(false);
        }
      }
      expect(paths.size).toBe(3);
      expect(branches.size).toBe(3);

      // main의 첫 부모 이력: 시작 뒤로는 프로그램(욱채)이 만든 작업별 병합 커밋뿐 (팀원이 main에 직접 쓰지 않음, GIT-03·04·14)
      const firstParent = git(repo, ['log', '--first-parent', '--format=%P|%cn|%s', `${start}..refs/heads/main`]).split(/\r?\n/).filter(Boolean);
      expect(firstParent).toHaveLength(3);
      for (const line of firstParent) {
        const [parents, committer, subject] = line.split('|');
        expect(parents!.split(' ')).toHaveLength(2);
        expect(committer).toBe('욱채');
        expect(subject).toMatch(/^\[T-\d+\] 병합: /);
      }

      const producer = h.members.producer!;
      for (const t of tasks) {
        const m = t.merge!;
        const passed = t.review.passed!;
        // 독립 검수: 통과 판정자는 작업자·실질 수정 참여자가 아니다
        expect(passed.reviewerId).not.toBe(t.assigneeId);
        expect(t.contributors).not.toContain(passed.reviewerId);
        // 버전 일치: 병합 대상 = 검수 통과 대상 (작업 커밋·기준 main), 병합 결과 내용 = 검수한 작업 커밋 내용
        expect(passed.target.kind).toBe('repo');
        if (passed.target.kind !== 'repo') continue;
        expect(m.taskCommitSha).toBe(passed.target.taskCommitSha);
        expect(m.preMainSha).toBe(passed.target.baseMainSha);
        expect(parentsOf(repo, m.mergeCommitSha)).toEqual([m.preMainSha, m.taskCommitSha]);
        expect(git(repo, ['rev-parse', `${m.mergeCommitSha}^{tree}`])).toBe(git(repo, ['rev-parse', `${m.taskCommitSha}^{tree}`]));
        const body = git(repo, ['log', '-1', '--format=%B', m.mergeCommitSha]);
        expect(body).toContain(`Wook-Task: ${t.id}`);
        expect(body).toContain(`Wook-Request: ${m.requestId}`);
        // 병합은 프로듀서의 요청으로 (그 요청 ID가 병합 커밋·기록에 남는다)
        const asks = store.activity.search({ taskId: t.id, kinds: ['merge'], limit: 200 }).filter((a) => a.text.includes('병합 요청 접수'));
        expect(asks.length).toBeGreaterThan(0);
        expect(asks.every((a) => a.actor === producer)).toBe(true);
        expect(asks.some((a) => a.requestId === m.requestId)).toBe(true);
        expect(mergeCommitsFor(repo, 'main', t.id)).toBe(1);
      }
      const calls = store.activity.search({ kinds: ['app_tool'], text: 'request_merge', limit: 1000 });
      expect(calls.length).toBeGreaterThanOrEqual(3);
      expect(calls.every((a) => a.memberId === producer)).toBe(true);

      // 프로젝트 잠금: main 이동(병합 커밋 반영)과 프로젝트 폴더 맞춤은 모두 그 작업의 병합 잠금 안이고 서로 겹치지 않는다 (GIT-06·13)
      const merges = events.filter((e) => e.phase === 'in' && e.op === 'merge');
      expect(merges).toHaveLength(3);
      for (const e of merges) expect(e.holder).toBe(`merge:${taskIdOf(e.label)}`);
      for (const e of events.filter((x) => x.phase === 'in' && x.op === 'sync')) expect(e.holder).toMatch(/^merge:T-\d+$/);
      expect(maxOverlap(events, repo)).toBe(1);
    } finally {
      await h.close();
    }
  }, 120_000);

  it('main 병합 요청은 그 프로젝트의 프로듀서만: 담당 팀원·검수 권한 팀원·메인 에이전트·다른 프로젝트 프로듀서의 request_merge·request_revert는 실제 앱 도구 서버에서 거부·기록되고 main은 그대로다', async () => {
    env = await boot({ team: ['developer', 'qa'] });
    const e = env;
    const [dev, qa] = e.members as [Env['members'][number], Env['members'][number]];
    const p2 = await addProject(e.core, '다른 프로젝트');
    extra.push(p2.close);
    const t = await passedRepoTask(e.core, { projectId: e.project.id, assignee: dev, files: { 'feature.txt': '기능\n' } });
    const before = mainSha(e.core, e.project.id);
    const logs: ToolCallLog[] = [];
    const server = createAppToolServer({ handler: e.core.tools.handle, onCall: (c) => logs.push(c) });
    const { url } = await server.start();
    extra.push(() => void server.stop());
    const main = e.ctx.store.members.require(MAIN_AGENT_ID);
    const p2Directive = e.core.directives.register({ projectId: p2.project.id, title: 'P2 지시', text: 'P2' }, MAIN_AGENT_ID, null).id;
    const callers = [
      { who: '담당 팀원', id: identityOf(dev, `task:${t.id}`) },
      { who: '검수 권한 팀원(QA)', id: identityOf(qa, `review:${t.id}`) },
      { who: '메인 에이전트', id: identityOf(main, `main:${e.project.id}`) },
      { who: '다른 프로젝트 프로듀서', id: identityOf(p2.producer, `directive:${p2Directive}`) },
    ];
    for (const c of callers) {
      const r = await mcpCall(url, server.issueToken(c.id), 'request_merge', { task_id: t.id, request_id: `rq-${c.id.memberId}` });
      expect(r, c.who).toMatchObject({ ok: false, code: 'forbidden' });
      const logged = logs.filter((l) => l.tool === 'request_merge' && l.identity?.memberId === c.id.memberId);
      expect(logged, `${c.who} 기록`).toHaveLength(1);
      expect(logged[0]!.result.ok).toBe(false);
    }
    // 역할 표시를 프로듀서로 꾸며도 처리기가 실제 팀원을 다시 확인한다 (CLI-08)
    const forged = await e.core.tools.handle(identityOf(dev, `task:${t.id}`, { isProducer: true }), 'request_merge', { task_id: t.id });
    expect(forged).toMatchObject({ ok: false, code: 'forbidden' });
    expect(mainSha(e.core, e.project.id)).toBe(before);
    expect(gitExecs(e.core, t.id, 'git_merge')).toHaveLength(0);
    expect(e.ctx.store.tasks.require(t.id)).toMatchObject({ state: 'in_review', merge: null });

    // 그 프로젝트 프로듀서의 요청만 접수 → 프로그램이 병합
    const ok = await mcpCall(url, server.issueToken(identityOf(e.producer, `directive:${t.directiveId}`)), 'request_merge', { task_id: t.id, request_id: 'rq-producer' });
    expect(ok).toMatchObject({ ok: true, data: { status: 'queued' } });
    const done = await settled(e.core, t.id);
    expect(done.state).toBe('done');
    expect(done.merge?.requestId).toBe('rq-producer');
    expect(mergeCommitsFor(e.projectDir, 'main', t.id)).toBe(1);
    // 병합 커밋은 프로그램(욱채)이 만든다 (GIT-04: 실제 병합은 프로그램)
    expect(git(e.projectDir, ['log', '-1', '--format=%cn', done.merge!.mergeCommitSha])).toBe('욱채');
    // 되돌리기(결국 main 변경) 요청도 그 프로젝트 프로듀서만
    const afterMerge = mainSha(e.core, e.project.id);
    for (const c of callers) {
      const r = await mcpCall(url, server.issueToken(c.id), 'request_revert', { task_id: t.id, reason: '되돌리기 시도', request_id: `rv-${c.id.memberId}` });
      expect(r, c.who).toMatchObject({ ok: false, code: 'forbidden' });
    }
    expect(e.ctx.store.tasks.list().filter((x) => x.revertOfTaskId === t.id)).toHaveLength(0);
    expect(mainSha(e.core, e.project.id)).toBe(afterMerge);
  });

  it('독립 검수 통과 전에는 프로듀서가 요청해도 병합하지 않는다 — 작업자 본인·배정되지 않은 검수 권한 팀원의 통과 등록도 거부되어 병합 조건이 채워지지 않는다', async () => {
    env = await boot({ team: ['developer', 'qa'] });
    const e = env;
    const [dev, qa] = e.members as [Env['members'][number], Env['members'][number]];
    const t = await submitRepoTask(e.core, { projectId: e.project.id, assignee: dev, files: { 'feature.txt': '기능\n' } });
    expect(t.reviewerId).toBe(e.producer.id);
    const before = mainSha(e.core, e.project.id);
    const producerId = identityOf(e.producer, `directive:${t.directiveId}`);
    expect(await e.core.tools.handle(producerId, 'request_merge', { task_id: t.id })).toMatchObject({ ok: false, code: 'conflict' });
    const verdict = { task_id: t.id, verdict: 'pass', criteria: [{ criterion: '동작한다', pass: true, note: '' }], reason: '' };
    expect(await e.core.tools.handle(identityOf(dev, `review:${t.id}`), 'submit_review', verdict)).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await e.core.tools.handle(identityOf(qa, `review:${t.id}`), 'submit_review', verdict)).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await e.core.tools.handle(producerId, 'request_merge', { task_id: t.id })).toMatchObject({ ok: false, code: 'conflict' });
    expect(mainSha(e.core, e.project.id)).toBe(before);
    expect(gitExecs(e.core, t.id, 'git_merge')).toHaveLength(0);
    // 배정된 독립 검수자의 통과 뒤에만 병합된다
    passBy(e.core, t.id);
    const done = await mergeBy(e.core, t.id);
    expect(done.state).toBe('done');
    expect(mergeCommitsFor(e.projectDir, 'main', t.id)).toBe(1);
  });

  it('검수 통과 뒤 작업 커밋·기준 main이 바뀌거나 작업 폴더에 미반영 변경이 생기면 병합하지 않고(반려로 세지 않음), 최신 기준으로 다시 검사·검수한 버전만 병합한다', async () => {
    env = await boot({ team: ['developer', 'qa'] });
    const e = env;
    const dev = e.members[0]!;
    const pid = e.project.id;
    // (1) 작업 커밋이 바뀜
    const t1 = await passedRepoTask(e.core, { projectId: pid, assignee: dev, files: { 'v1.txt': '처음\n' } });
    const wt1 = t1.workspace!.worktreePath;
    writeFileSync(join(wt1, 'v1.txt'), '검수 뒤 바뀜\n', 'utf8');
    git(wt1, ['-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-qam', '검수 뒤 커밋']);
    const before1 = mainSha(e.core, pid);
    const r1 = await mergeBy(e.core, t1.id);
    expect(r1).toMatchObject({ state: 'in_progress', merge: null });
    expect(r1.review).toMatchObject({ rejectsInRound: 0, rejectsTotal: 0, passed: null });
    expect(mainSha(e.core, pid)).toBe(before1);
    // (2) 작업 폴더에 반영되지 않은 변경
    const t2 = await passedRepoTask(e.core, { projectId: pid, assignee: dev, files: { 'v2.txt': '처음\n' } });
    writeFileSync(join(t2.workspace!.worktreePath, 'v2.txt'), '커밋 안 한 변경\n', 'utf8');
    const r2 = await mergeBy(e.core, t2.id);
    expect(r2).toMatchObject({ state: 'in_progress', merge: null });
    expect(r2.review).toMatchObject({ rejectsInRound: 0, rejectsTotal: 0, passed: null });
    expect(mainSha(e.core, pid)).toBe(before1);
    // (3) 기준 main이 바뀜 → 잠금 밖에서 최신 main 반영·재검사·대상 재고정 → 재검수 → 그 버전만 병합
    const t3 = await passedRepoTask(e.core, { projectId: pid, assignee: dev, files: { 'v3.txt': '처음\n' } });
    const oldTarget = t3.review.passed!.target;
    const moved = commitOnMain(e, 'other.txt', '다른 변경\n');
    const r3 = await mergeBy(e.core, t3.id);
    expect(r3.state).toBe('in_review');
    expect(r3.review.passed).toBeNull();
    expect(r3.review.rejectsInRound).toBe(0);
    expect(r3.review.target?.kind === 'repo' && r3.review.target.baseMainSha).toBe(moved);
    expect(mergeCommitsFor(e.projectDir, 'main', t3.id)).toBe(0);
    expect(mainSha(e.core, pid)).toBe(moved);
    // 예전 통과로는 병합할 수 없다
    expect(() => e.core.merges.requestMerge(t3.id, e.producer, null)).toThrow(/독립 검수를 통과하지 않았습니다/);
    passBy(e.core, t3.id);
    const done = await mergeBy(e.core, t3.id);
    expect(done.state).toBe('done');
    const target = done.review.passed!.target;
    if (target.kind !== 'repo' || oldTarget.kind !== 'repo') throw new Error('repo');
    expect(target.taskCommitSha).not.toBe(oldTarget.taskCommitSha);
    expect(parentsOf(e.projectDir, done.merge!.mergeCommitSha)).toEqual([moved, target.taskCommitSha]);
    expect(reviewsOf(e.core, t3.id).map((r) => r.verdict)).toEqual(['pass', 'pass']);
  });
});

// ═══════════════════════════════════════ AC-11 ═══════════════════════════════════════

describe('AC-11 병합 충돌이 나면 담당 팀원에게 해결이 돌아간다', () => {
  /** 같은 파일을 고친 두 작업 중 t1을 먼저 병합하고 t2를 병합 요청해 충돌을 만든다 */
  async function conflicted(e: Env) {
    const [dev1, dev2] = e.members as [Env['members'][number], Env['members'][number]];
    const t1 = await passedRepoTask(e.core, { projectId: e.project.id, assignee: dev1, files: { 'shared.txt': '개발자1 줄\n' } });
    const t2 = await passedRepoTask(e.core, { projectId: e.project.id, assignee: dev2, files: { 'shared.txt': '개발자2 줄\n' } });
    expect((await mergeBy(e.core, t1.id)).state).toBe('done');
    const before = mainSha(e.core, e.project.id);
    const r = await mergeBy(e.core, t2.id);
    return { dev1, dev2, t1, t2, before, r };
  }

  it('병합할 때 최신 main과 충돌하면 병합하지 않고, 해결 업무는 그 작업의 담당 팀원에게만 그 작업 세션으로 돌아간다 — 충돌은 담당자의 worktree에 남고 반려로 세지 않으며 다른 팀원·프로듀서는 대신 해결 보고를 할 수 없다', async () => {
    env = await boot({ team: ['developer', 'developer'] });
    const e = env;
    const { dev1, dev2, t2, before, r } = await conflicted(e);
    // 병합하지 않고 진행으로 돌아가 충돌을 기록 (반려 아님)
    expect(r.state).toBe('in_progress');
    expect(r.conflict?.files).toEqual(['shared.txt']);
    expect(r.merge).toBeNull();
    expect(r.review).toMatchObject({ rejectsInRound: 0, rejectsTotal: 0, passed: null });
    expect(mainSha(e.core, e.project.id)).toBe(before);
    expect(mergeCommitsFor(e.projectDir, 'main', t2.id)).toBe(0);
    // 해결 업무는 담당 팀원의 그 작업 세션으로만
    const fixes = e.ctx.store.queue.list({ state: 'queued' }).filter((q) => q.kind === 'conflict_fix');
    expect(fixes).toHaveLength(1);
    expect(fixes[0]).toMatchObject({ memberId: dev2.id, sessionKey: `task:${t2.id}`, taskId: t2.id });
    // 충돌은 담당 팀원의 worktree(자기 브랜치)에 충돌 표시와 함께 남아 있다
    const wt2 = r.workspace!.worktreePath;
    expect((await e.ctx.deps.git.status(wt2)).unmerged).toEqual(['shared.txt']);
    expect(readFileSync(join(wt2, 'shared.txt'), 'utf8')).toMatch(/^<{7} /m);
    expect(git(wt2, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(r.workspace!.branch);
    // 다른 팀원·프로듀서는 이 작업의 충돌 해결을 보고할 수 없다
    expect(await e.core.tools.handle(identityOf(dev1, `task:${t2.id}`), 'report_conflict_resolved', { note: '대신 해결' })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await e.core.tools.handle(identityOf(e.producer, `task:${t2.id}`), 'report_conflict_resolved', { note: '대신 해결' })).toMatchObject({ ok: false, code: 'forbidden' });
  });

  it('담당 팀원이 안내대로 충돌 표시만 정리하고(git 명령 없이) report_conflict_resolved를 보내면 받아들여지고, 해결 커밋 뒤 해결자가 아닌 검수자의 재검수를 거쳐 두 변경이 모두 main에 병합된다', async () => {
    env = await boot({ team: ['developer', 'developer'] });
    const e = env;
    const { dev2, t1, t2, r } = await conflicted(e);
    const wt2 = r.workspace!.worktreePath;
    // 안내문(tasks.ts conflict_fix 메시지): "충돌 표시를 정리해 두 변경을 올바르게 합친 뒤 report_conflict_resolved를 호출하세요. git 명령은 쓰지 마세요."
    writeFileSync(join(wt2, 'shared.txt'), '개발자1 줄\n개발자2 줄\n', 'utf8');
    const res = await e.core.tools.handle(identityOf(dev2, `task:${t2.id}`), 'report_conflict_resolved', { note: '두 줄 합침' });
    expect(res, `충돌 표시를 지운 해결 보고가 거부됨: ${JSON.stringify(res)}`).toMatchObject({ ok: true });
    const after = e.ctx.store.tasks.require(t2.id);
    expect(after.conflict).toBeNull();
    expect(after.contributors).toContain(dev2.id);
    expect(git(wt2, ['log', '-1', '--format=%ae|%s'])).toMatch(new RegExp(`^${dev2.id}@wook\\.local\\|\\[${t2.id}\\] 최신 main 반영 충돌 해결`));
    // 다시 검사·검수 → 해결자가 아닌 검수자가 통과 → 병합
    const done = await driveToDone(e.core, t2.id);
    expect(done.review.passed!.reviewerId).not.toBe(dev2.id);
    expect(done.review.rejectsTotal).toBe(0);
    expect(fileAt(e.projectDir, 'refs/heads/main', 'shared.txt')).toBe('개발자1 줄\n개발자2 줄\n');
    expect(mergeCommitsFor(e.projectDir, 'main', t1.id)).toBe(1);
    expect(mergeCommitsFor(e.projectDir, 'main', t2.id)).toBe(1);
  });

  it('정상 앱 흐름(모의 merge_conflict): 같은 파일을 고친 두 개발자 중 뒤 작업의 충돌은 그 담당 팀원이 자기 작업 세션에서 해결하고, 재검수 뒤 두 변경이 모두 main에 남는다', async () => {
    const h = await createHarness({ team: ['developer', 'developer'] });
    try {
      for (const k of ['developer', 'developer2']) await h.internal('members.update', h.members[k]!, { mockScenario: 'merge_conflict' });
      const repo = h.projectDir;
      const store = h.core.ctx.store;
      const did = await sendCommand(h, '회원 정보 화면을 만들어 줘');
      // 해결 보고가 거부되며 같은 충돌 해결 턴이 반복되면 끝나지 않으므로, 완료 또는 거부 반복 중 먼저 오는 쪽까지만 기다린다
      const rejectedReports = () => store.activity.search({ kinds: ['app_tool'], text: 'report_conflict_resolved', limit: 1000 }).filter((a) => a.level === 'warn');
      await h.waitFor(() => store.directives.get(did)?.state === 'awaiting_confirmation' || rejectedReports().length >= 5, { timeoutMs: 90_000, label: '완료 또는 해결 보고 거부 반복' });
      const rejected = rejectedReports();
      expect(
        { directive: store.directives.get(did)?.state, rejectedConflictReports: rejected.length, lastReason: rejected[0]?.result ?? null },
        '담당 팀원의 충돌 해결 보고(report_conflict_resolved)가 받아들여져 지시가 끝나야 한다',
      ).toEqual({ directive: 'awaiting_confirmation', rejectedConflictReports: 0, lastReason: null });
      const tasks = repoTasks(h, did);
      expect(tasks).toHaveLength(2);
      const conflictedTasks = tasks.filter((t) => store.activity.search({ taskId: t.id, kinds: ['git'], limit: 100 }).some((a) => a.text.includes('반영 중 충돌')));
      expect(conflictedTasks.length).toBeGreaterThanOrEqual(1);
      for (const t of conflictedTasks) {
        // 해결 업무는 그 작업 세션으로 담당 팀원에게만
        const fixes = store.queue.list({}).filter((q) => q.kind === 'conflict_fix' && q.taskId === t.id);
        expect(fixes.length).toBeGreaterThan(0);
        for (const q of fixes) expect(q).toMatchObject({ memberId: t.assigneeId, sessionKey: `task:${t.id}` });
        // 해결 보고는 담당 팀원이 그 작업 세션의 턴에서
        const reports = store.activity.search({ kinds: ['app_tool'], text: 'report_conflict_resolved', limit: 100 }).filter((a) => a.level === 'info' && a.turnId && store.turns.get(a.turnId)?.taskId === t.id);
        expect(reports.length).toBeGreaterThan(0);
        for (const a of reports) {
          expect(a.memberId).toBe(t.assigneeId);
          expect(store.sessions.get(store.turns.get(a.turnId!)!.sessionId)?.workKey).toBe(`task:${t.id}`);
        }
        // 해결 커밋은 담당 팀원 이름으로 작업 브랜치에, 해결 뒤 고정한 버전을 해결자가 아닌 검수자가 통과
        const m = t.merge!;
        const own = git(repo, ['log', '--format=%ae|%s', `${m.preMainSha}..${m.taskCommitSha}`]).split(/\r?\n/);
        const fix = own.filter((l) => l.includes(`[${t.id}] 최신 main 반영 충돌 해결`));
        expect(fix.length).toBeGreaterThan(0);
        for (const l of fix) expect(l.startsWith(`${t.assigneeId}@wook.local|`)).toBe(true);
        expect(t.review.passed!.reviewerId).not.toBe(t.assigneeId);
      }
      // 최종 main: 충돌 표시 없이 두 팀원의 변경이 모두 남는다
      const zone = fileAt(repo, 'refs/heads/main', 'conflict-zone.txt') ?? '';
      expect(zone).not.toMatch(/^(<{7}|={7}|>{7})/m);
      for (const t of tasks) expect(zone).toContain(t.assigneeId);
      for (const t of tasks) expect(mergeCommitsFor(repo, 'main', t.id)).toBe(1);
    } finally {
      await h.close();
    }
  }, 120_000);

  it('담당 팀원의 충돌 해결 턴이 해결 보고 없이 끝나기를 되풀이하면, 진척 없는 자동 재개 3회에서 같은 팀원에게 다시 맡기기를 멈추고 프로듀서에게 넘긴다 — 헛돌기 보류(재계획) 또는 해결 업무 이관 (GIT-07, CLI-18)', async () => {
    const o = await bootOrch();
    try {
      const dev = o.ctx.store.members.require(o.devId);
      const qa = o.ctx.store.members.require(o.qaId);
      const d = seedDirective(o);
      const t1 = await passedRepoTask(o.core, { projectId: o.projectId, assignee: dev, files: { 'shared.txt': '개발자 줄\n' }, directiveId: d.id });
      const t2 = await passedRepoTask(o.core, { projectId: o.projectId, assignee: qa, files: { 'shared.txt': 'QA 줄\n' }, directiveId: d.id });
      await mergeBy(o.core, t1.id);
      expect((await mergeBy(o.core, t2.id)).conflict?.files).toEqual(['shared.txt']);
      const key = `task:${t2.id}`;
      // 가짜 CLI 턴은 아무것도 하지 않고 정상 종료한다 (해결 못 함)
      for (let i = 0; i < 8 && o.ctx.store.tasks.require(t2.id).state !== 'on_hold'; i++) {
        await o.drain(1);
        await sleep(80);
      }
      const t = o.ctx.store.tasks.require(t2.id);
      const fixTurns = o.launches.filter((l) => l.workKey === key);
      expect(fixTurns.length).toBeGreaterThan(0);
      expect(fixTurns.every((l) => l.memberId === qa.id)).toBe(true);
      // 프로듀서에게 넘어간 업무: 재계획(헛돌기 보류, 8장) 또는 충돌 해결 업무 자체(GIT-07). 시험 준비 때 검수 턴 없이 통과시켜 남은 'review' 항목은 보지 않는다
      const toProducer = o.ctx.store.queue.list({}).filter((q) => q.taskId === t2.id && q.memberId === o.producerId && (q.kind === 'replan' || q.kind === 'conflict_fix'));
      expect(
        { assigneeFixTurnsAtMost3: fixTurns.length <= 3, producerGotWork: toProducer.length > 0 },
        `담당 팀원 해결 턴 ${fixTurns.length}회, 상태 ${t.state} [${holdKinds(t).join(',')}], noProgressResumes ${t.noProgressResumes}, pendingSubmit ${!!t.pendingSubmit}`,
      ).toEqual({ assigneeFixTurnsAtMost3: true, producerGotWork: true });
    } finally {
      await o.close();
    }
  }, 60_000);
});

// ═══════════════════════════════════════ AC-12 ═══════════════════════════════════════

describe('AC-12 A 뒤에 B가 병합된 상태에서 A를 되돌리면 A의 효과만 취소되고 B는 유지 · 충돌·의존성·검사 실패는 보류 · main을 과거로 옮기지 않음', () => {
  it('A 뒤에 B가 병합된 main에서 A를 되돌리면, 새 되돌리기 작업이 독립 검수·같은 병합 절차를 거쳐 A의 변경(같은 파일 안의 A 줄·A가 지운 파일 포함)만 취소하고 B의 변경은 그대로 두며 main은 앞으로만 움직인다', async () => {
    env = await boot({ team: ['developer', 'qa'] });
    const e = env;
    const [dev, qa] = e.members as [Env['members'][number], Env['members'][number]];
    const pid = e.project.id;
    const text = (ls: string[]) => `${ls.join('\n')}\n`;
    const lines = Array.from({ length: 12 }, (_, i) => `줄 ${i + 1}`);
    commitOnMain(e, 'shared.txt', text(lines));
    commitOnMain(e, 'lib.txt', '공용 라이브러리\n');
    const aLines = [...lines];
    aLines[1] = '줄 2 — A가 고침';
    const A = await passedRepoTask(e.core, { projectId: pid, assignee: dev, files: { 'shared.txt': text(aLines), 'a.txt': 'A 기능\n' }, remove: ['lib.txt'], title: 'A 작업' });
    const Ad = await mergeBy(e.core, A.id);
    expect(Ad.state).toBe('done');
    const bLines = [...aLines];
    bLines[10] = '줄 11 — B가 고침';
    const B = await passedRepoTask(e.core, { projectId: pid, assignee: e.members[0]!, files: { 'shared.txt': text(bLines), 'b.txt': 'B 기능\n' }, title: 'B 작업' });
    const Bd = await mergeBy(e.core, B.id);
    expect(Bd.state).toBe('done');
    const before = mainSha(e.core, pid);

    // 프로듀서가 앱 도구로 되돌리기 요청 (GIT-04·10)
    const res = await e.core.tools.handle(identityOf(e.producer, `directive:${A.directiveId}`), 'request_revert', { task_id: A.id, reason: 'A 기능 철회', request_id: 'rq-revert-a' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toMatchObject({ mode: 'revert_task' });
    const rtId = (res.data as { revertTaskId: string }).revertTaskId;
    const rt = await settled(e.core, rtId);
    expect(rt).toMatchObject({ type: 'revert', revertOfTaskId: A.id, assigneeId: e.producer.id, state: 'in_review', outputMode: 'repo' });
    expect(e.ctx.store.tasks.require(A.id)).toMatchObject({ state: 'done', revertedByTaskId: rtId });
    // 검수 전에는 main이 그대로
    expect(mainSha(e.core, pid)).toBe(before);
    // 독립 검수: 되돌리기 작업의 작업자(프로듀서)는 검수할 수 없고 다른 적격 검수자가 배정된다
    expect(rt.reviewerId).toBe(qa.id);
    expect(() => e.core.tasks.submitReview(rtId, e.producer, PASS(rt), null)).toThrow(/검수 결과 등록 거부/);
    const done = await driveToDone(e.core, rtId);
    expect(done.review.passed!.reviewerId).toBe(qa.id);

    const main = 'refs/heads/main';
    const expected = [...lines];
    expected[10] = '줄 11 — B가 고침';
    expect(fileAt(e.projectDir, main, 'shared.txt')).toBe(text(expected));
    expect(fileAt(e.projectDir, main, 'a.txt')).toBeNull();
    expect(fileAt(e.projectDir, main, 'lib.txt')).toBe('공용 라이브러리\n');
    expect(fileAt(e.projectDir, main, 'b.txt')).toBe('B 기능\n');
    // 되돌리기의 실제 효과는 A가 바꾼 파일뿐
    expect(changedFiles(e.projectDir, done.merge!.preMainSha, done.merge!.mergeCommitSha)).toEqual(['A\tlib.txt', 'D\ta.txt', 'M\tshared.txt']);
    // main을 과거 시점으로 옮기지 않음: 이전 병합이 모두 이력에 남고 브랜치는 앞으로만 움직였다
    const now = mainSha(e.core, pid);
    for (const sha of [before, Ad.merge!.mergeCommitSha, Bd.merge!.mergeCommitSha]) expect(gitOk(e.projectDir, ['merge-base', '--is-ancestor', sha, now])).toBe(true);
    const fwd = baseMovedOnlyForward(e.projectDir, 'main');
    expect(fwd.ok, fwd.detail).toBe(true);
    expect(fwd.moves).toBeGreaterThanOrEqual(5); // reflog에 이동이 실제로 기록돼 있어야 검사가 의미 있다
    // 같은 병합 절차: 작업별 병합 커밋 + 병합 기록
    expect(parentsOf(e.projectDir, done.merge!.mergeCommitSha)).toEqual([done.merge!.preMainSha, done.merge!.taskCommitSha]);
    expect(mergeCommitsFor(e.projectDir, 'main', rtId)).toBe(1);
    // 원래 작업의 완료 이력은 유지되고 되돌리기 작업과 연결된다. B는 손대지 않는다
    expect(e.ctx.store.tasks.require(A.id)).toMatchObject({ state: 'done', revertedByTaskId: rtId, merge: Ad.merge });
    expect(e.ctx.store.tasks.require(B.id)).toMatchObject({ state: 'done', revertedByTaskId: null, merge: Bd.merge });
    // 같은 되돌리기를 다시 요청해도 새 작업·새 커밋을 만들지 않는다
    expect((await e.core.merges.requestRevert(A.id, e.producer, '다시')).revertTaskId).toBe(rtId);
    expect(e.ctx.store.tasks.list().filter((t) => t.revertOfTaskId === A.id)).toHaveLength(1);
  });

  it('충돌: 뒤 작업 B가 A가 만든 줄을 고쳤으면 되돌리기는 자동 완료하지 않고 보류(프로듀서 재계획)되며 main은 그대로다', async () => {
    env = await boot({ team: ['developer', 'qa'] });
    const e = env;
    const dev = e.members[0]!;
    const pid = e.project.id;
    const A = await passedRepoTask(e.core, { projectId: pid, assignee: dev, files: { 'shared.txt': 'A가 만든 줄\n' }, title: 'A 작업' });
    expect((await mergeBy(e.core, A.id)).state).toBe('done');
    const B = await passedRepoTask(e.core, { projectId: pid, assignee: dev, files: { 'shared.txt': 'A가 만든 줄을 B가 고침\nB가 덧붙인 줄\n' }, title: 'B 작업' });
    expect((await mergeBy(e.core, B.id)).state).toBe('done');
    const before = mainSha(e.core, pid);
    const res = await e.core.merges.requestRevert(A.id, e.producer, 'A 철회');
    const rt = await settled(e.core, res.revertTaskId!);
    expect(rt.state).toBe('on_hold');
    expect(holdKinds(rt)).toEqual(['replan']);
    expect(e.ctx.store.queue.list({ state: 'queued' }).filter((q) => q.kind === 'replan' && q.taskId === rt.id && q.memberId === e.producer.id)).toHaveLength(1);
    expect(e.ctx.store.notifications.list().filter((n) => n.title === '되돌리기 보류')).toHaveLength(1);
    // 되돌리기 작업 폴더에 반쯤 된 되돌리기 상태를 남기지 않는다
    expect((await e.ctx.deps.git.status(rt.workspace!.worktreePath)).clean).toBe(true);
    // 보류는 저절로 풀리지 않고 대표의 단순 재개로도 넘어가지 않는다 (프로듀서가 조정 범위를 계획)
    await sleep(300);
    expect(e.ctx.store.tasks.require(rt.id).state).toBe('on_hold');
    expect(() => e.core.tasks.resumeByOwner(rt.id)).toThrow();
    expect(mainSha(e.core, pid)).toBe(before);
    expect(fileAt(e.projectDir, 'refs/heads/main', 'shared.txt')).toBe('A가 만든 줄을 B가 고침\nB가 덧붙인 줄\n');
    expect(mergeCommitsFor(e.projectDir, 'main', rt.id)).toBe(0);
    const fwd = baseMovedOnlyForward(e.projectDir, 'main');
    expect(fwd.ok, fwd.detail).toBe(true);
  });

  it('의존성: 뒤 작업 B가 A를 선행 작업으로 두고 병합됐으면 A 되돌리기는 자동 진행(검수·병합)하지 않고 보류되어 프로듀서가 조정하며 main은 그대로다', async () => {
    env = await boot({ team: ['developer', 'qa'] });
    const e = env;
    const dev = e.members[0]!;
    const pid = e.project.id;
    const A = await passedRepoTask(e.core, { projectId: pid, assignee: dev, files: { 'a.txt': 'A 모듈\n' }, title: 'A 작업' });
    expect((await mergeBy(e.core, A.id)).state).toBe('done');
    const B = await passedRepoTask(e.core, { projectId: pid, assignee: dev, files: { 'b.txt': 'A 모듈을 쓰는 B\n' }, title: 'B 작업', prerequisiteIds: [A.id], directiveId: A.directiveId });
    expect((await mergeBy(e.core, B.id)).state).toBe('done');
    expect(e.ctx.store.tasks.require(B.id).prerequisiteIds).toEqual([A.id]);
    const before = mainSha(e.core, pid);
    const res = await e.core.merges.requestRevert(A.id, e.producer, 'A 철회');
    const rt = await settled(e.core, res.revertTaskId!);
    expect(mainSha(e.core, pid)).toBe(before);
    // 7.1: 뒤의 작업이 되돌릴 변경에 의존하면 보류 — 어떤 작업까지 함께 조정할지 프로듀서가 계획 (GIT-10: 의존성 문제는 자동 완료 안 함)
    const queued = e.ctx.store.queue.list({ state: 'queued' }).filter((q) => q.taskId === rt.id);
    expect(
      { state: rt.state, reviewQueued: queued.some((q) => q.kind === 'review'), producerAsked: queued.some((q) => q.memberId === e.producer.id && q.kind === 'replan') },
      `되돌리기 작업 ${rt.id} 상태 ${rt.state}, 대기 업무 ${queued.map((q) => `${q.kind}→${q.memberId}`).join(', ') || '없음'}`,
    ).toEqual({ state: 'on_hold', reviewQueued: false, producerAsked: true });
  });

  it('검사 실패: 되돌린 결과가 자동 검사에 실패하면 되돌리기 작업은 보류되어 프로듀서가 조정하고 main은 그대로다', async () => {
    env = await boot({ team: ['developer', 'qa'], runner: true, checkCommands: ['node check.js'] });
    const e = env;
    const dev = e.members[0]!;
    const pid = e.project.id;
    commitOnMain(
      e,
      'check.js',
      "const fs = require('fs');\nif (fs.existsSync('needs-a.txt') && !fs.existsSync('a.txt')) { console.error('needs-a.txt는 a.txt가 있어야 합니다'); process.exit(1); }\nconsole.log('검사 통과');\n",
    );
    const A = await passedRepoTask(e.core, { projectId: pid, assignee: dev, files: { 'a.txt': 'A 기능\n' }, title: 'A 작업' });
    expect(A.review.autoCheck.status).toBe('passed');
    expect((await mergeBy(e.core, A.id)).state).toBe('done');
    const B = await passedRepoTask(e.core, { projectId: pid, assignee: dev, files: { 'needs-a.txt': 'B는 a.txt가 필요\n' }, title: 'B 작업' });
    expect(B.review.autoCheck.status).toBe('passed');
    expect((await mergeBy(e.core, B.id)).state).toBe('done');
    const before = mainSha(e.core, pid);
    const res = await e.core.merges.requestRevert(A.id, e.producer, 'A 철회');
    const rt = await settled(e.core, res.revertTaskId!, 60_000);
    // 되돌린 결과는 실제로 검사에 실패했고, main은 그대로다
    expect(rt.review.autoCheck.status).toBe('failed');
    expect(mainSha(e.core, pid)).toBe(before);
    expect(fileAt(e.projectDir, 'refs/heads/main', 'a.txt')).toBe('A 기능\n');
    // 7.1: 검사에 실패하면 보류 — 프로듀서가 조정 범위를 계획
    const queued = e.ctx.store.queue.list({ state: 'queued' }).filter((q) => q.taskId === rt.id);
    const seen = { state: rt.state, holds: holdKinds(rt), nextWork: queued.map((q) => `${q.kind}→${q.memberId === e.producer.id ? '프로듀서' : q.memberId}`) };
    expect(seen.state, `되돌리기 결과가 검사에 실패하면 보류되어야 한다 (7.1 충돌·의존성 행). 실제: ${JSON.stringify(seen)}`).toBe('on_hold');
  }, 90_000);

  it('정상 앱 흐름(모의 revert): 프로듀서가 앱 도구로 먼저 병합된 A를 되돌리면 되돌리기 작업이 독립 검수·같은 병합 절차를 거쳐 A의 파일만 지우고 뒤에 병합된 B는 그대로 남긴다', async () => {
    const h = await createHarness({ team: ['developer', 'architect'], scenarios: { producer: 'revert' } });
    try {
      const repo = h.projectDir;
      const did = await sendCommand(h, '회원 가입 화면을 만들어 줘');
      await waitDirective(h, did, 'awaiting_confirmation');
      const all = h.core.ctx.store.tasks.list({ ref1: did });
      const rt = all.find((t) => t.type === 'revert');
      expect(rt).toBeDefined();
      const A = h.task(rt!.revertOfTaskId!);
      const B = all.find((t) => t.outputMode === 'repo' && t.type !== 'revert' && t.id !== A.id)!;
      expect([A.state, B.state, rt!.state]).toEqual(['done', 'done', 'done']);
      expect(A.revertedByTaskId).toBe(rt!.id);
      // A 작업 뒤에 B가 병합됐고, 되돌리기는 그 뒤에 적용됐다
      expect(gitOk(repo, ['merge-base', '--is-ancestor', A.merge!.mergeCommitSha, B.merge!.mergeCommitSha])).toBe(true);
      expect(gitOk(repo, ['merge-base', '--is-ancestor', B.merge!.mergeCommitSha, rt!.merge!.preMainSha])).toBe(true);
      const files = treeFiles(repo, 'refs/heads/main');
      expect(files.some((f) => f.startsWith(`wook-mock/${A.id}/`))).toBe(false);
      // B의 파일은 B가 병합한 내용 그대로
      const bFiles = treeFiles(repo, B.merge!.mergeCommitSha).filter((f) => f.startsWith(`wook-mock/${B.id}/`));
      expect(bFiles.length).toBeGreaterThan(0);
      for (const f of bFiles) expect(fileAt(repo, 'refs/heads/main', f)).toBe(fileAt(repo, B.merge!.mergeCommitSha, f));
      // 되돌리기의 실제 효과는 A의 파일 삭제뿐
      const changed = changedFiles(repo, rt!.merge!.preMainSha, rt!.merge!.mergeCommitSha);
      expect(changed.length).toBeGreaterThan(0);
      expect(changed.every((l) => l.startsWith('D\t') && l.slice(2).startsWith(`wook-mock/${A.id}/`))).toBe(true);
      // 되돌리기 요청·병합 요청은 프로듀서, 되돌리기 검수는 작업자(프로듀서)가 아닌 설계자
      expect(rt!.assigneeId).toBe(h.members.producer);
      expect(rt!.review.passed!.reviewerId).toBe(h.members.architect);
      const reverts = h.core.ctx.store.activity.search({ kinds: ['app_tool'], text: 'request_revert', limit: 100 });
      expect(reverts.length).toBeGreaterThan(0);
      expect(reverts.every((a) => a.memberId === h.members.producer)).toBe(true);
      expect(mergeCommitsFor(repo, 'main', rt!.id)).toBe(1);
      const fwd = baseMovedOnlyForward(repo, 'main');
      expect(fwd.ok, fwd.detail).toBe(true);
      expect(fwd.moves).toBeGreaterThanOrEqual(3);
    } finally {
      await h.close();
    }
  }, 120_000);

  /** 모의 revert 흐름에서 프로그램의 되돌리기 커밋(revertMerge) 바로 앞·뒤(기록 전)에 앱이 꺼졌다가 다시 켜진다 (GIT-15·ERR-08) */
  async function revertInterrupted(afterCommit: boolean) {
    let h = await createHarness({ team: ['developer', 'architect'], scenarios: { producer: 'revert' } });
    const g = h.core.ctx.deps.git;
    const orig = g.revertMerge.bind(g);
    let rtId: string | null = null;
    g.revertMerge = async (dir, sha, msg, who) => {
      if (!rtId) {
        rtId = taskIdOf(msg);
        if (afterCommit) await orig(dir, sha, msg, who);
        return new Promise<never>(() => undefined); // 앱 종료 (결과 기록 전)
      }
      return orig(dir, sha, msg, who);
    };
    const did = await sendCommand(h, '회원 가입 화면을 만들어 줘');
    await h.waitFor(() => rtId !== null, { timeoutMs: 90_000, label: '되돌리기 커밋 시작' });
    await sleep(300);
    h = await restartAfterCrash(h);
    const id = rtId!;
    await h.waitFor(() => h.core.ctx.store.directives.get(did)?.state === 'awaiting_confirmation' || h.task(id).state === 'on_hold', { timeoutMs: 90_000, label: '되돌리기 마무리 또는 보류' });
    const rt = h.task(id);
    const A = h.task(rt.revertOfTaskId!);
    const B = h.core.ctx.store.tasks.list({ ref1: did }).find((t) => t.outputMode === 'repo' && t.type !== 'revert' && t.id !== A.id)!;
    const files = treeFiles(h.projectDir, 'refs/heads/main');
    const revertCommits = git(h.projectDir, ['log', '--format=%s', 'refs/heads/main']).split(/\r?\n/).filter((l) => l.startsWith(`[${id}] ${A.id} 되돌리기`)).length;
    const revertChanges = rt.merge ? changedFiles(h.projectDir, rt.merge.preMainSha, rt.merge.mergeCommitSha) : [];
    // 재시작 복구가 되돌리기 작업을 어떻게 다뤘는지 (실패 메시지용)
    const store = h.core.ctx.store;
    const revertExec = store.execs.list({ ref1: id }).filter((x) => x.kind === 'git_revert').map((x) => `${x.state}:${String(x.result.recovered ?? '-')}`);
    const sessionWork = store.queue.list({}).filter((q) => q.sessionKey === `task:${id}`).map((q) => `${q.kind}→${q.memberId === h.members.producer ? '프로듀서' : q.memberId}`);
    const note = `git_revert 실행 기록 ${JSON.stringify(revertExec)}, 되돌리기 작업 세션에 들어간 업무 ${JSON.stringify(sessionWork)}, 단계 ${JSON.stringify(store.steps.list(id).map((s) => s.title))}`;
    return { h, rt, A, B, files, revertCommits, revertChanges, note };
  }

  it('되돌리기 커밋 직전에 앱이 꺼졌다 다시 켜져도, 되돌리기 작업이 A의 변경을 실제로 취소하지 않은 채 완료되지는 않는다 (프로그램이 다시 실행하거나 보류)', async () => {
    const r = await revertInterrupted(false);
    try {
      const aLeft = r.files.filter((f) => f.startsWith(`wook-mock/${r.A.id}/`)).length;
      expect(['done', 'on_hold']).toContain(r.rt.state);
      const onlyUndoesA = r.revertChanges.length > 0 && r.revertChanges.every((l) => l.startsWith('D\t') && l.slice(2).startsWith(`wook-mock/${r.A.id}/`));
      expect(
        { revertTask: r.rt.state, aFilesLeftOnMain: aLeft, revertCommitsOnMain: r.revertCommits, revertMergeOnlyUndoesA: r.rt.state === 'done' ? onlyUndoesA : null },
        `되돌리기 작업이 완료됐다면 main에서 A의 파일이 사라지고 되돌리기 커밋이 하나 있어야 한다 (보류라면 main은 그대로). 되돌리기 병합의 변경: ${JSON.stringify(r.revertChanges)}; ${r.note}`,
      ).toEqual(
        r.rt.state === 'done'
          ? { revertTask: 'done', aFilesLeftOnMain: 0, revertCommitsOnMain: 1, revertMergeOnlyUndoesA: true }
          : { revertTask: 'on_hold', aFilesLeftOnMain: aLeft, revertCommitsOnMain: 0, revertMergeOnlyUndoesA: null },
      );
      expect(r.files.some((f) => f.startsWith(`wook-mock/${r.B.id}/`))).toBe(true);
    } finally {
      await closeAfterCrash(r.h);
    }
  }, 150_000);

  it('되돌리기 커밋 직후 기록 전에 앱이 꺼졌다 다시 켜져도 되돌리기는 한 번만 반영되고 A의 변경만 취소되며 B는 유지된다', async () => {
    const r = await revertInterrupted(true);
    try {
      expect(r.rt.state).toBe('done');
      expect(r.revertCommits).toBe(1);
      expect(r.files.some((f) => f.startsWith(`wook-mock/${r.A.id}/`))).toBe(false);
      expect(r.files.some((f) => f.startsWith(`wook-mock/${r.B.id}/`))).toBe(true);
      expect(mergeCommitsFor(r.h.projectDir, 'main', r.rt.id)).toBe(1);
      expect(r.revertChanges.length).toBeGreaterThan(0);
      expect(r.revertChanges.filter((l) => !(l.startsWith('D\t') && l.slice(2).startsWith(`wook-mock/${r.A.id}/`))), `되돌리기 병합에 A 취소 말고 다른 변경이 섞였다; ${r.note}`).toEqual([]);
      const fwd = baseMovedOnlyForward(r.h.projectDir, 'main');
      expect(fwd.ok, fwd.detail).toBe(true);
    } finally {
      await closeAfterCrash(r.h);
    }
  }, 150_000);
});

// ═══════════════════════════════════════ AC-42 ═══════════════════════════════════════

describe('AC-42 같은 프로젝트의 병합·되돌리기 동시 요청은 main 변경 구간이 직렬, 다른 프로젝트는 막지 않음', () => {
  it('P1에 병합 2건·되돌리기 1건, P2에 병합·되돌리기를 앱 도구로 동시에 요청 → P1의 main 변경은 그 작업의 잠금 안에서 한 번에 하나씩 직전 main 위에 쌓이고, P1이 잠금을 쥐고 멈춘 동안 P2의 병합·되돌리기는 끝까지 반영된다', async () => {
    env = await boot({ team: ['developer', 'qa'] });
    const e = env;
    const dev = e.members[0]!;
    const p1 = e.project;
    const p2 = await addProject(e.core, '두 번째 프로젝트', ['developer', 'qa']);
    extra.push(p2.close);
    const p2dev = p2.members[0]!;
    // 되돌릴 작업 (먼저 병합): P1 T0, P2 T4
    const T0 = await passedRepoTask(e.core, { projectId: p1.id, assignee: dev, files: { 't0.txt': 'T0\n' }, title: 'T0' });
    const T0d = await mergeBy(e.core, T0.id);
    expect(T0d.state).toBe('done');
    const T4 = await passedRepoTask(e.core, { projectId: p2.project.id, assignee: p2dev, files: { 't4.txt': 'T4\n' }, title: 'T4' });
    expect((await mergeBy(e.core, T4.id)).state).toBe('done');
    // 같은 기준 main에서 검수를 통과한 P1의 두 작업, P2의 한 작업
    const T1 = await passedRepoTask(e.core, { projectId: p1.id, assignee: dev, files: { 't1.txt': 'T1\n' }, title: 'T1' });
    const T2 = await passedRepoTask(e.core, { projectId: p1.id, assignee: dev, files: { 't2.txt': 'T2\n' }, title: 'T2' });
    const T3 = await passedRepoTask(e.core, { projectId: p2.project.id, assignee: p2dev, files: { 't3.txt': 'T3\n' }, title: 'T3' });
    const pinnedBase = (t: Task) => (t.review.passed!.target.kind === 'repo' ? t.review.passed!.target.baseMainSha : '');
    expect(pinnedBase(T1)).toBe(T0d.merge!.mergeCommitSha);
    expect(pinnedBase(T2)).toBe(T0d.merge!.mergeCommitSha);

    const g1 = gate();
    let gated = false;
    const inP1 = (repo: string) => samePath(repo, p1.path);
    const holderOf = (repo: string) => e.core.locks.holder(inP1(repo) ? p1.id : p2.project.id);
    const events = watchMainChanges(e.ctx.deps.git, holderOf, (repo) => {
      if (gated || !inP1(repo)) return null;
      gated = true;
      return g1.promise;
    });
    const revertLocks: { of: string; holder: string | null }[] = [];
    const git1 = e.ctx.deps.git;
    const origRevert = git1.revertMerge.bind(git1);
    git1.revertMerge = async (dir, sha, msg, who) => {
      const of = /\] (T-\d+) 되돌리기/.exec(msg)?.[1] ?? '?';
      revertLocks.push({ of, holder: e.core.locks.holder(of === T0.id ? p1.id : p2.project.id) });
      return origRevert(dir, sha, msg, who);
    };

    // 동시에 요청 (프로듀서의 앱 도구 호출)
    const who1 = identityOf(e.producer, `directive:${T1.directiveId}`);
    const who2 = identityOf(p2.producer, `directive:${T3.directiveId}`);
    const merges = Promise.all([
      e.core.tools.handle(who1, 'request_merge', { task_id: T1.id, request_id: 'rq-p1-t1' }),
      e.core.tools.handle(who1, 'request_merge', { task_id: T2.id, request_id: 'rq-p1-t2' }),
      e.core.tools.handle(who2, 'request_merge', { task_id: T3.id, request_id: 'rq-p2-t3' }),
    ]);
    const revertP1 = e.core.tools.handle(who1, 'request_revert', { task_id: T0.id, reason: 'T0 철회', request_id: 'rq-p1-rv' });
    const revertP2 = e.core.tools.handle(who2, 'request_revert', { task_id: T4.id, reason: 'T4 철회', request_id: 'rq-p2-rv' });
    for (const r of await merges) expect(r).toMatchObject({ ok: true, data: { status: 'queued' } });

    await waitUntil(() => gated, 'P1 첫 main 변경 진입');
    // P1이 main 변경 구간 안에서 멈춰 있는 동안 P2의 병합과 되돌리기(새 작업 → 검수 → 병합)는 끝까지 반영된다
    expect((await settled(e.core, T3.id)).state).toBe('done');
    const rv2 = await revertP2;
    expect(rv2).toMatchObject({ ok: true, data: { mode: 'revert_task' } });
    const rt4Id = (rv2 as { data: { revertTaskId: string } }).data.revertTaskId;
    expect((await driveToDone(e.core, rt4Id)).state).toBe('done');
    const p1Ins = () => events.filter((x) => x.phase === 'in' && inP1(x.repo));
    const p1Outs = () => events.filter((x) => x.phase === 'out' && inP1(x.repo));
    expect(p1Ins()).toHaveLength(1);
    expect(p1Outs()).toHaveLength(0);
    expect(e.core.locks.holder(p1.id)).toBe(`merge:${T1.id}`);
    expect(fileAt(p2.project.path, 'refs/heads/main', 't3.txt')).toBe('T3\n');
    expect(fileAt(p2.project.path, 'refs/heads/main', 't4.txt')).toBeNull();
    // 같은 프로젝트의 다른 병합·되돌리기는 잠금을 기다린다 (아무것도 반영되지 않음)
    expect(e.core.merges.isPending(T2.id)).toBe(true);
    expect(e.ctx.store.tasks.require(T0.id).revertedByTaskId).toBeNull();
    expect(mainSha(e.core, p1.id)).toBe(T0d.merge!.mergeCommitSha);

    g1.release();
    const rv1 = await revertP1;
    expect(rv1).toMatchObject({ ok: true, data: { mode: 'revert_task' } });
    const rtId = (rv1 as { data: { revertTaskId: string } }).data.revertTaskId;
    const d1 = await driveToDone(e.core, T1.id);
    const d2 = await driveToDone(e.core, T2.id);
    const drt = await driveToDone(e.core, rtId);
    expect([d1.state, d2.state, drt.state]).toEqual(['done', 'done', 'done']);

    // P1의 main 변경 구간(병합 커밋 반영·프로젝트 폴더 맞춤)은 겹치지 않았고, 매번 그 작업의 병합 잠금 안이었다
    expect(maxOverlap(events, p1.path)).toBe(1);
    for (const x of p1Ins()) {
      if (x.op === 'merge') expect(x.holder).toBe(`merge:${taskIdOf(x.label)}`);
      else expect(x.holder).toMatch(/^merge:T-\d+$/);
    }
    expect(revertLocks).toEqual(expect.arrayContaining([{ of: T0.id, holder: `revert:${T0.id}` }, { of: T4.id, holder: `revert:${T4.id}` }]));
    // P2의 main 변경은 P1의 첫 main 변경 구간 안에서 시작·종료됐다 (막히지 않음)
    const firstP1Out = events.findIndex((x) => x.phase === 'out' && inP1(x.repo));
    const p2Events = events.map((x, i) => ({ x, i })).filter(({ x }) => !inP1(x.repo) && x.op === 'merge');
    expect(p2Events.filter(({ x }) => x.phase === 'in')).toHaveLength(2);
    for (const { i } of p2Events) expect(i).toBeLessThan(firstP1Out);
    // 직렬 결과: P1의 병합은 매번 직전 main 위에 쌓였다 (잃어버린 변경 없음), 검수한 그 기준·그 버전으로
    const chain = git(p1.path, ['rev-list', '--first-parent', '--reverse', `${T0d.merge!.mergeCommitSha}..refs/heads/main`]).split(/\r?\n/).filter(Boolean);
    expect(chain).toHaveLength(3);
    let prev = T0d.merge!.mergeCommitSha;
    for (const sha of chain) {
      const t = [d1, d2, drt].find((x) => x.merge!.mergeCommitSha === sha)!;
      expect(t, `main 첫 부모 이력의 ${sha.slice(0, 8)}는 P1 작업의 병합 커밋`).toBeDefined();
      expect(t.merge!.preMainSha).toBe(prev);
      expect(pinnedBase(t)).toBe(prev);
      expect(t.review.rejectsTotal).toBe(0);
      prev = sha;
    }
    // 잠금 뒤에서 기다린 T1·T2 중 나중 것은 바뀐 main으로 다시 검사·검수받은 버전이 병합됐다 (예전 기준의 통과를 쓰지 않음)
    const later = [d1, d2].sort((a, b) => chain.indexOf(a.merge!.mergeCommitSha) - chain.indexOf(b.merge!.mergeCommitSha))[1]!;
    expect(later.merge!.preMainSha).not.toBe(T0d.merge!.mergeCommitSha);
    expect(reviewsOf(e.core, later.id).map((r) => r.verdict)).toEqual(['pass', 'pass']);
    // 결과: P1 main에 T1·T2 유지, T0만 취소 / P2 main에 T3 유지, T4만 취소
    const m1 = 'refs/heads/main';
    expect(fileAt(p1.path, m1, 't1.txt')).toBe('T1\n');
    expect(fileAt(p1.path, m1, 't2.txt')).toBe('T2\n');
    expect(fileAt(p1.path, m1, 't0.txt')).toBeNull();
    expect(fileAt(p2.project.path, m1, 't3.txt')).toBe('T3\n');
    expect(fileAt(p2.project.path, m1, 't4.txt')).toBeNull();
    for (const id of [T1.id, T2.id, drt.id]) expect(mergeCommitsFor(p1.path, 'main', id)).toBe(1);
    for (const repo of [p1.path, p2.project.path]) {
      const fwd = baseMovedOnlyForward(repo, 'main');
      expect(fwd.ok, fwd.detail).toBe(true);
    }
  }, 90_000);
});

// ═══════════════════════════════════════ AC-45 ═══════════════════════════════════════

describe('AC-45 앱 도구 중복 전달·병합 기록 직전 종료 후 재시작에도 커밋·병합·반려 횟수는 한 번만, 실행 여부가 불명확하면 복구 확인 보류', () => {
  it('정상 앱 흐름(모의 duplicate_tool): complete_step·submit_for_review를 같은 요청 ID로 두 번 보내도 단계 커밋·제출·검수·병합은 한 번씩만 반영된다', async () => {
    const h = await createHarness({ team: ['developer', 'qa'], scenarios: { developer: 'duplicate_tool', qa: 'duplicate_tool' } });
    try {
      const repo = h.projectDir;
      const did = await sendCommand(h, '비밀번호 찾기 화면을 만들어 줘');
      await waitDirective(h, did, 'awaiting_confirmation');
      const tasks = repoTasks(h, did);
      expect(tasks).toHaveLength(2);
      const store = h.core.ctx.store;
      for (const t of tasks) {
        const steps = store.steps.list(t.id);
        expect(steps.length).toBeGreaterThan(0);
        // 중복 전달이 실제로 있었다 (단계마다 complete_step 2번, submit_for_review 2번)
        const calls = store.activity.search({ kinds: ['app_tool'], memberId: t.assigneeId, limit: 1000 });
        expect(calls.filter((a) => a.text === 'complete_step').length).toBe(steps.length * 2);
        expect(calls.filter((a) => a.text === 'submit_for_review').length).toBe(2);
        // 단계마다 커밋 1개 (프로그램 실행 기록·git 이력 모두)
        expect(gitExecs(h.core, t.id, 'git_commit')).toHaveLength(steps.length);
        const own = git(repo, ['log', '--format=%s', `${t.merge!.preMainSha}..${t.merge!.taskCommitSha}`]).split(/\r?\n/);
        for (const s of steps) expect(own.filter((l) => l === `[${t.id}] ${s.title}`)).toHaveLength(1);
        // 제출(진행→검수)·검수·병합도 한 번
        expect(store.transitions.list(t.id).filter((x) => x.event === 'submit')).toHaveLength(1);
        expect(reviewsOf(h.core, t.id)).toHaveLength(1);
        expect(t.review.rejectsTotal).toBe(0);
        expect(mergeCommitsFor(repo, 'main', t.id)).toBe(1);
        expect(gitExecs(h.core, t.id, 'git_merge')).toHaveLength(1);
      }
    } finally {
      await h.close();
    }
  }, 120_000);

  it('complete_step·submit_for_review가 같은 요청 ID로 동시에 두 번 오거나(처리 중 재전달) 앱 재시작 뒤 다시 와도 단계 커밋·검수 요청은 한 번만 반영된다', async () => {
    env = await boot({ team: ['developer'] });
    let e = env;
    const dev = e.members[0]!;
    const base0 = mainSha(e.core, e.project.id);
    const t = await activeRepoTask(e.core, { projectId: e.project.id, assignee: dev });
    e.core.tasks.setSteps(t.id, ['단계 1', '단계 2']);
    const wt = t.workspace!.worktreePath;
    const who = identityOf(dev, `task:${t.id}`);
    const call = (core: Env['core'], tool: string, args: Record<string, unknown>) => core.tools.handle(who, tool, args);
    const dup = (r: Awaited<ReturnType<typeof call>>) => r.ok && (r.data as { duplicateRequest?: boolean }).duplicateRequest === true;
    const ownCommits = () => git(wt, ['log', '--format=%s', `${base0}..HEAD`]).split(/\r?\n/).filter(Boolean);

    writeFiles(wt, { 'one.txt': '1\n' });
    const step0 = { step_index: 0, note: '1단계', request_id: 'rq-step-0' };
    const [a, b] = await Promise.all([call(e.core, 'complete_step', step0), call(e.core, 'complete_step', step0)]);
    expect(a.ok && b.ok).toBe(true);
    expect([a, b].filter(dup)).toHaveLength(1);
    // 다른 요청 ID로 같은 단계를 다시 보내도(재시도) 커밋하지 않는다
    expect(await call(e.core, 'complete_step', { ...step0, request_id: 'rq-step-0-retry' })).toMatchObject({ ok: true, data: { already: true } });
    expect(gitExecs(e.core, t.id, 'git_commit')).toHaveLength(1);
    // 앱 재시작 뒤 같은 요청 ID → 저장된 결과
    e = env = await restartServices(e);
    expect(dup(await call(e.core, 'complete_step', step0))).toBe(true);

    writeFiles(wt, { 'two.txt': '2\n' });
    const step1 = { step_index: 1, note: '2단계', request_id: 'rq-step-1' };
    const [c, d] = await Promise.all([call(e.core, 'complete_step', step1), call(e.core, 'complete_step', step1)]);
    expect(c.ok && d.ok).toBe(true);
    const submit = { note: '제출', request_id: 'rq-submit' };
    const [s1, s2] = await Promise.all([call(e.core, 'submit_for_review', submit), call(e.core, 'submit_for_review', submit)]);
    expect(s1.ok && s2.ok).toBe(true);
    expect([s1, s2].filter(dup)).toHaveLength(1);
    const asks = e.ctx.store.activity.search({ taskId: t.id, kinds: ['task'], limit: 200 }).filter((x) => x.text.includes('검수 요청 접수'));
    expect(asks).toHaveLength(1);
    await e.core.tasks.processSubmission(t.id);
    expect(e.ctx.store.tasks.require(t.id).state).toBe('in_review');
    // 처리 뒤에 같은 요청이 또 와도 저장된 결과만 돌려준다
    expect(dup(await call(e.core, 'submit_for_review', submit))).toBe(true);
    expect(dup(await call(e.core, 'complete_step', step1))).toBe(true);
    expect(e.ctx.store.transitions.list(t.id).filter((x) => x.event === 'submit')).toHaveLength(1);
    expect(gitExecs(e.core, t.id, 'git_commit')).toHaveLength(2);
    expect(ownCommits()).toEqual([`[${t.id}] 단계 2`, `[${t.id}] 단계 1`]);
  });

  it('request_merge가 병합 처리 중에 같은 요청 ID로 다시 오거나 다른 요청 ID로 또 와도, 처리 뒤·앱 재시작 뒤에 다시 와도 main 병합 커밋과 병합 실행은 한 번뿐이다', async () => {
    env = await boot({ team: ['developer', 'qa'] });
    let e = env;
    const t = await passedRepoTask(e.core, { projectId: e.project.id, assignee: e.members[0]!, files: { 'once.txt': '한 번\n' } });
    const g = gate();
    let entered = false;
    watchMainChanges(e.ctx.deps.git, () => null, () => {
      if (entered) return null;
      entered = true;
      return g.promise;
    });
    const who = identityOf(e.producer, `directive:${t.directiveId}`);
    const args = { task_id: t.id, request_id: 'rq-merge-dup' };
    const [first, sameAtOnce] = await Promise.all([e.core.tools.handle(who, 'request_merge', args), e.core.tools.handle(who, 'request_merge', args)]);
    expect(first).toMatchObject({ ok: true, data: { status: 'queued' } });
    expect(sameAtOnce).toMatchObject({ ok: true, data: { status: 'queued', duplicateRequest: true } });
    await waitUntil(() => entered, 'main 변경 구간 진입');
    // 병합이 main 변경 구간 안에 있는 동안 다시 온 요청
    expect(await e.core.tools.handle(who, 'request_merge', args)).toMatchObject({ ok: true, data: { duplicateRequest: true } });
    expect(await e.core.tools.handle(who, 'request_merge', { task_id: t.id, request_id: 'rq-merge-other' })).toMatchObject({ ok: true, data: { status: 'in_progress' } });
    g.release();
    const done = await settled(e.core, t.id);
    expect(done.state).toBe('done');
    expect(done.merge!.requestId).toBe('rq-merge-dup');
    expect(await e.core.tools.handle(who, 'request_merge', args)).toMatchObject({ ok: true, data: { duplicateRequest: true } });
    expect(await e.core.tools.handle(who, 'request_merge', { task_id: t.id, request_id: 'rq-merge-late' })).toMatchObject({ ok: true, data: { status: 'merged', mergeCommitSha: done.merge!.mergeCommitSha } });
    // 앱 재시작 뒤
    e = env = await restartServices(e);
    expect(await e.core.tools.handle(who, 'request_merge', args)).toMatchObject({ ok: true, data: { duplicateRequest: true } });
    expect(await e.core.tools.handle(who, 'request_merge', { task_id: t.id, request_id: 'rq-merge-after-restart' })).toMatchObject({ ok: true, data: { status: 'merged' } });
    await sleep(50);
    expect(mergeCommitsFor(e.projectDir, 'main', t.id)).toBe(1);
    expect(gitExecs(e.core, t.id, 'git_merge')).toHaveLength(1);
  });

  it('request_revert를 같은 요청 ID·다른 요청 ID로 동시에 보내거나 재시작 뒤 다시 보내도 되돌리기 작업·되돌리기 커밋은 하나다', async () => {
    env = await boot({ team: ['developer', 'qa'] });
    let e = env;
    const A = await passedRepoTask(e.core, { projectId: e.project.id, assignee: e.members[0]!, files: { 'a.txt': 'A\n' } });
    expect((await mergeBy(e.core, A.id)).state).toBe('done');
    const who = identityOf(e.producer, `directive:${A.directiveId}`);
    const rv = (rid: string) => ({ task_id: A.id, reason: '철회', request_id: rid });
    const rs = await Promise.all([e.core.tools.handle(who, 'request_revert', rv('rq-rv-1')), e.core.tools.handle(who, 'request_revert', rv('rq-rv-1')), e.core.tools.handle(who, 'request_revert', rv('rq-rv-2'))]);
    for (const r of rs) expect(r.ok).toBe(true);
    const ids = rs.map((r) => (r.ok ? (r.data as { revertTaskId: string }).revertTaskId : ''));
    expect(new Set(ids).size).toBe(1);
    await settled(e.core, ids[0]!);
    e = env = await restartServices(e);
    expect(await e.core.tools.handle(who, 'request_revert', rv('rq-rv-1'))).toMatchObject({ ok: true, data: { revertTaskId: ids[0], duplicateRequest: true } });
    expect(await e.core.tools.handle(who, 'request_revert', rv('rq-rv-3'))).toMatchObject({ ok: true, data: { revertTaskId: ids[0] } });
    expect(e.ctx.store.tasks.list().filter((t) => t.revertOfTaskId === A.id)).toHaveLength(1);
    expect(e.ctx.store.execs.list().filter((x) => x.kind === 'git_revert')).toHaveLength(1);
    const rt = e.ctx.store.tasks.require(ids[0]!);
    expect(git(rt.workspace!.worktreePath, ['log', '--format=%s', 'HEAD']).split(/\r?\n/).filter((l) => l.startsWith(`[${rt.id}] ${A.id} 되돌리기`))).toHaveLength(1);
  });

  it('반려(submit_review)가 같은 요청 ID로 동시에 두 번 오거나 앱 재시작 뒤 다시 와도 반려 횟수는 한 번만 늘고, 재작업 뒤 새 버전 검수 중에 옛 요청이 다시 와도 새 버전의 반려로 세지 않는다', async () => {
    env = await boot({ team: ['developer', 'qa'] });
    let e = env;
    const t = await submitRepoTask(e.core, { projectId: e.project.id, assignee: e.members[0]!, files: { 'r.txt': '1\n' } });
    const who = identityOf(e.producer, `review:${t.id}`);
    const reject = (rid: string) => ({ task_id: t.id, verdict: 'reject', criteria: [{ criterion: '동작한다', pass: false, note: '다시' }], reason: '다시 확인', request_id: rid });
    const counts = () => {
      const cur = e.ctx.store.tasks.require(t.id);
      return { state: cur.state, rejectsInRound: cur.review.rejectsInRound, rejectsTotal: cur.review.rejectsTotal, records: reviewsOf(e.core, t.id).length };
    };
    const [a, b] = await Promise.all([e.core.tools.handle(who, 'submit_review', reject('rq-rj-1')), e.core.tools.handle(who, 'submit_review', reject('rq-rj-1'))]);
    expect(a.ok && b.ok).toBe(true);
    expect(counts()).toEqual({ state: 'in_progress', rejectsInRound: 1, rejectsTotal: 1, records: 1 });
    // 앱 재시작 뒤(처리 중 목록이 비고 DB를 다시 열어도) 같은 요청 ID → 저장된 결과
    e = env = await restartServices(e);
    expect(await e.core.tools.handle(who, 'submit_review', reject('rq-rj-1'))).toMatchObject({ ok: true, data: { duplicateRequest: true } });
    // 다른 요청 ID로 다시 보내면(재시도) 이미 진행으로 돌아간 작업이라 거부
    expect(await e.core.tools.handle(who, 'submit_review', reject('rq-rj-retry'))).toMatchObject({ ok: false, code: 'conflict' });
    expect(counts()).toEqual({ state: 'in_progress', rejectsInRound: 1, rejectsTotal: 1, records: 1 });
    // 재작업 → 다시 제출 → 새 버전 검수 중에 옛 반려 요청이 다시 와도 새 버전의 반려로 세지 않는다
    const dev = e.members[0]!;
    writeFileSync(join(e.ctx.store.tasks.require(t.id).workspace!.worktreePath, 'r.txt'), '2\n', 'utf8');
    e.core.tasks.addSteps(t.id, ['반려 반영']);
    await e.core.tasks.completeStep(t.id, 1, '반영', dev, null);
    e.core.tasks.requestSubmit(t.id, '재제출', dev);
    await e.core.tasks.processSubmission(t.id);
    expect(counts()).toEqual({ state: 'in_review', rejectsInRound: 1, rejectsTotal: 1, records: 1 });
    expect(await e.core.tools.handle(who, 'submit_review', reject('rq-rj-1'))).toMatchObject({ ok: true, data: { duplicateRequest: true } });
    expect(counts()).toEqual({ state: 'in_review', rejectsInRound: 1, rejectsTotal: 1, records: 1 });
    // 두 번째 반려를 세 번 전달(동시 둘 + 재시작 뒤 하나)해도 2회 — 3번째 반려(재계획 보류)로 넘어가지 않는다
    await Promise.all([e.core.tools.handle(who, 'submit_review', reject('rq-rj-2')), e.core.tools.handle(who, 'submit_review', reject('rq-rj-2'))]);
    e = env = await restartServices(e);
    expect(await e.core.tools.handle(who, 'submit_review', reject('rq-rj-2'))).toMatchObject({ ok: true, data: { duplicateRequest: true } });
    expect(counts()).toEqual({ state: 'in_progress', rejectsInRound: 2, rejectsTotal: 2, records: 2 });
  });

  it('병합이 main에 반영된 직후 기록 전에 앱이 꺼졌다가 다시 켜지면, 다시 병합하지 않고 기록만 확정해 완료한다 — 커밋·병합·검수·반려 횟수가 늘지 않는다 (정상 앱 흐름)', async () => {
    let h = await createHarness({ team: ['developer', 'qa'] });
    try {
      const g = h.core.ctx.deps.git;
      const orig = g.mergeIntoBase.bind(g);
      let crashed: { taskId: string; mergeSha: string } | null = null;
      g.mergeIntoBase = async (repo, o) => {
        const r = await orig(repo, o);
        if (!crashed && r.ok) {
          crashed = { taskId: taskIdOf(o.message)!, mergeSha: r.mergeSha };
          return new Promise<never>(() => undefined); // main 반영 뒤, 기록 전에 멈춤 (앱 종료 직전)
        }
        return r;
      };
      const did = await sendCommand(h, '알림 설정 화면을 만들어 줘');
      await h.waitFor(() => crashed !== null, { timeoutMs: 90_000, label: '첫 병합 반영' });
      const c = crashed!;
      const repo = h.projectDir;
      await sleep(200);
      expect(h.task(c.taskId)).toMatchObject({ state: 'in_review', merge: null });
      const started = gitExecs(h.core, c.taskId, 'git_merge');
      expect(started.map((x) => x.state)).toEqual(['started']);
      expect(mergeCommitsFor(repo, 'main', c.taskId)).toBe(1);
      const requestId = started[0]!.requestId;
      const pinned = h.task(c.taskId).review.passed!.target;
      if (pinned.kind !== 'repo') throw new Error('저장소 변경형 작업이어야 한다');
      const reviewsBefore = reviewsOf(h.core, c.taskId).length;

      h = await restartAfterCrash(h);
      await h.waitFor(() => h.task(c.taskId).state === 'done', { timeoutMs: 60_000, label: '재시작 뒤 완료' });
      const t = h.task(c.taskId);
      expect(t.merge?.mergeCommitSha).toBe(c.mergeSha);
      const execs = gitExecs(h.core, c.taskId, 'git_merge');
      expect(execs).toHaveLength(1);
      expect(execs[0]).toMatchObject({ requestId, state: 'succeeded' });
      expect(execs[0]!.result.recovered).toBe('already_applied');
      expect(mergeCommitsFor(repo, 'main', c.taskId)).toBe(1);
      // 검수를 다시 하거나 작업 커밋을 다시 만들지 않았다
      expect(reviewsOf(h.core, c.taskId)).toHaveLength(reviewsBefore);
      expect(t.review.rejectsTotal).toBe(0);
      expect(t.merge).toMatchObject({ taskCommitSha: pinned.taskCommitSha, preMainSha: pinned.baseMainSha });
      // 나머지 흐름도 이어져 끝까지 — 모든 작업이 병합 커밋 하나씩, 반려 없음
      await waitDirective(h, did, 'awaiting_confirmation');
      for (const x of repoTasks(h, did)) {
        expect(mergeCommitsFor(repo, 'main', x.id)).toBe(1);
        expect(gitExecs(h.core, x.id, 'git_merge')).toHaveLength(1);
        expect(x.review.rejectsTotal).toBe(0);
      }
      expect(h.core.ctx.store.notifications.list().filter((n) => n.title === '복구 확인 필요')).toHaveLength(0);
      expect(await h.core.ctx.deps.git.hasTrackedChanges(repo)).toBe(false);
    } finally {
      await closeAfterCrash(h);
    }
  }, 150_000);

  it('병합을 기록한 뒤 완료 기록 직전(체크아웃된 프로젝트 폴더를 main에 맞추는 중)에 앱이 꺼졌다가 다시 켜져도, 다시 병합하지 않고 완료하며 프로젝트 폴더가 main과 맞춰져 뒤 작업의 병합도 막히지 않는다 (정상 앱 흐름)', async () => {
    let h = await createHarness({ team: ['developer', 'qa'] });
    try {
      const repo = h.projectDir;
      const g = h.core.ctx.deps.git;
      const orig = g.syncCheckedOutBase.bind(g);
      let crashed: { taskId: string; mergeSha: string } | null = null;
      g.syncCheckedOutBase = async (dir, base, oldSha, newSha) => {
        if (!crashed) {
          crashed = { taskId: taskIdOf(git(dir, ['log', '-1', '--format=%s', newSha]))!, mergeSha: newSha };
          return new Promise<never>(() => undefined); // main 반영·병합 기록 뒤, 완료 기록 전에 앱 종료
        }
        return orig(dir, base, oldSha, newSha);
      };
      const did = await sendCommand(h, '알림 목록 화면을 만들어 줘');
      await h.waitFor(() => crashed !== null, { timeoutMs: 90_000, label: '첫 병합 뒤 프로젝트 폴더 맞춤 시작' });
      const c = crashed!;
      await sleep(200);
      // 병합은 main에 반영·기록됐지만 완료 기록 전이다
      expect(h.task(c.taskId)).toMatchObject({ state: 'in_review', merge: { mergeCommitSha: c.mergeSha } });
      expect(mergeCommitsFor(repo, 'main', c.taskId)).toBe(1);

      h = await restartAfterCrash(h);
      const store = h.core.ctx.store;
      const stuck = () => store.tasks.list({ ref1: did }).find((t) => t.state === 'on_hold');
      await h.waitFor(() => store.directives.get(did)?.state === 'awaiting_confirmation' || !!stuck(), { timeoutMs: 90_000, label: '지시 완료 또는 작업 보류' });
      const tasks = repoTasks(h, did);
      const seen = {
        directive: store.directives.get(did)?.state,
        tasks: tasks.map((t) => `${t.id}:${t.state}${t.hold.reasons.length ? `[${t.hold.reasons.map((r) => `${r.kind}:${r.note}`).join('/')}]` : ''}`),
        projectFolderMatchesMain: !(await h.core.ctx.deps.git.hasTrackedChanges(repo)),
        mergeBlockedNotices: store.notifications.list().filter((n) => n.title === '병합 보류').length,
      };
      // 다시 병합하지 않았다
      expect(h.task(c.taskId)).toMatchObject({ state: 'done', merge: { mergeCommitSha: c.mergeSha } });
      expect(mergeCommitsFor(repo, 'main', c.taskId)).toBe(1);
      expect(gitExecs(h.core, c.taskId, 'git_merge')).toHaveLength(1);
      // 프로젝트 폴더가 main과 맞고 흐름이 끝까지 이어진다
      expect(seen, JSON.stringify(seen)).toMatchObject({ directive: 'awaiting_confirmation', projectFolderMatchesMain: true, mergeBlockedNotices: 0 });
      for (const t of tasks) expect(mergeCommitsFor(repo, 'main', t.id)).toBe(1);
    } finally {
      await closeAfterCrash(h);
    }
  }, 150_000);

  it('병합 실행 여부를 기록만으로 판정할 수 없으면(시작 기록만 있고 그 사이 main이 바뀜) 재시작 때 자동 재실행하지 않고 복구 확인으로 보류한다 — 프로듀서 요청으로도 병합되지 않고 메인 확인 뒤에만 한 번 병합된다', async () => {
    let h = await createHarness({ team: ['developer', 'qa'] });
    try {
      const g = h.core.ctx.deps.git;
      const orig = g.mergeIntoBase.bind(g);
      let stuck: string | null = null;
      g.mergeIntoBase = async (repo, o) => {
        if (!stuck) {
          stuck = taskIdOf(o.message);
          return new Promise<never>(() => undefined); // 시작 기록 뒤 결과를 모른 채 앱 종료
        }
        return orig(repo, o);
      };
      const did = await sendCommand(h, '프로필 사진 업로드를 만들어 줘');
      await h.waitFor(() => stuck !== null, { timeoutMs: 90_000, label: '병합 시작' });
      const taskId = stuck!;
      const repo = h.projectDir;
      await sleep(200);
      expect(gitExecs(h.core, taskId, 'git_merge').map((x) => x.state)).toEqual(['started']);
      // 앱이 꺼진 사이 누군가 main을 바꿨다 → 기록만으로는 병합이 실행됐는지 알 수 없다
      writeFileSync(join(repo, 'outside.txt'), '앱 밖에서 바꾼 내용\n', 'utf8');
      git(repo, ['add', 'outside.txt']);
      git(repo, ['-c', 'user.name=other', '-c', 'user.email=o@o', 'commit', '-qm', '앱 밖 변경']);

      h = await restartAfterCrash(h);
      const held = h.task(taskId);
      expect(held.state).toBe('on_hold');
      expect(holdKinds(held)).toContain('recovery_check');
      const exec = gitExecs(h.core, taskId, 'git_merge')[0]!;
      expect(exec.state).toBe('unknown');
      expect(h.core.ctx.store.notifications.list().filter((n) => n.title === '복구 확인 필요').length).toBeGreaterThan(0);
      expect((await h.invoke('recovery.list')).map((x) => x.requestId)).toContain(exec.requestId);
      // 자동으로 다시 병합하지 않고, 프로듀서가 요청해도 받지 않는다
      const producer = h.core.ctx.store.members.require(h.members.producer!);
      expect(await h.core.tools.handle(identityOf(producer, `directive:${held.directiveId}`), 'request_merge', { task_id: taskId, request_id: 'rq-while-held' })).toMatchObject({ ok: false, code: 'conflict' });
      await sleep(2500);
      expect(h.task(taskId).state).toBe('on_hold');
      expect(mergeCommitsFor(repo, 'main', taskId)).toBe(0);
      expect(gitExecs(h.core, taskId, 'git_merge')).toHaveLength(1);
      // 메인 에이전트가 '다시 실행'을 고르면(resolve_recovery) 최신 기준으로 다시 검사·검수 뒤 한 번만 병합된다
      await h.main('resolve_recovery', { recovery_id: exec.requestId, action: 'retry' });
      await waitDirective(h, did, 'awaiting_confirmation');
      expect(h.task(taskId).state).toBe('done');
      expect(mergeCommitsFor(repo, 'main', taskId)).toBe(1);
      expect(h.task(taskId).review.rejectsTotal).toBe(0);
      expect(fileAt(repo, 'refs/heads/main', 'outside.txt')).toBe('앱 밖에서 바꾼 내용\n');
    } finally {
      await closeAfterCrash(h);
    }
  }, 150_000);

  it('단계 커밋 직후 기록 전에 앱이 꺼졌다가 다시 켜져도 그 단계 커밋은 하나뿐이고 단계는 완료로 확인된다 (정상 앱 흐름)', async () => {
    let h = await createHarness({ team: ['developer'] });
    try {
      const g = h.core.ctx.deps.git;
      const orig = g.commitAll.bind(g);
      let crashed: { dir: string; sha: string; subject: string } | null = null;
      g.commitAll = async (dir, message, identity) => {
        const sha = await orig(dir, message, identity);
        if (!crashed && sha && /^\[T-\d+\] /.test(message)) {
          crashed = { dir, sha, subject: message };
          return new Promise<never>(() => undefined); // 커밋 뒤 기록 전에 멈춤
        }
        return sha;
      };
      const did = await sendCommand(h, '설정 화면을 만들어 줘');
      await h.waitFor(() => crashed !== null, { timeoutMs: 90_000, label: '첫 단계 커밋' });
      const c = crashed!;
      const taskId = taskIdOf(c.subject)!;
      await sleep(200);
      expect(h.core.ctx.store.steps.list(taskId).find((s) => s.done)).toBeUndefined();
      h = await restartAfterCrash(h);
      const step0 = h.core.ctx.store.steps.list(taskId).find((s) => s.idx === 0)!;
      expect(step0).toMatchObject({ done: true, commitSha: c.sha });
      await waitDirective(h, did, 'awaiting_confirmation');
      const t = h.task(taskId);
      expect(t.state).toBe('done');
      const own = git(h.projectDir, ['log', '--format=%s', `${t.merge!.preMainSha}..${t.merge!.taskCommitSha}`]).split(/\r?\n/);
      expect(own.filter((l) => l === c.subject)).toHaveLength(1);
      expect(mergeCommitsFor(h.projectDir, 'main', taskId)).toBe(1);
    } finally {
      await closeAfterCrash(h);
    }
  }, 150_000);
});
