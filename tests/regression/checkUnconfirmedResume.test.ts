/**
 * 종료를 확인하지 못한 자동 검사를 대표가 확인하고 재개하면 (stage-6 리뷰 process-shutdown D2 → S7-C2, stage-6 회귀 — CTL-11, REV-01, S6-E5·E6(a)).
 * taskkill 대체 방식은 대개 보안 정책(WDAC·AppLocker) 환경에서 돌고, 그런 곳은 PowerShell도 제한 언어 모드라 작업 개체 도우미를 쓸 수 없다. 그러면
 * 자동 검사가 끝날 때마다 남은 하위 프로세스를 확인하지 못해(-1) 작업을 오류 보류하고 '확인한 뒤 재개하세요'라고 알린다(CTL-11 — 맞다).
 * 예전에는 대표가 확인하고 재개하면 제출 처리가 검사를 처음부터 다시 돌렸고, 그 검사도 확인하지 못해 다시 보류 — 몇 번을 재개해도 검수로 가지 못했다.
 * 이제 그 실행의 결과(종료 코드)를 기록해 두고, 그 보류를 대표가 재개하면 그 재개를 확인으로 보고 다시 돌리지 않고 그 결과로 이어 간다:
 * 통과면 대상 고정·검수, 실패면 보통의 실패 처리. 보류 사유·알림에 그렇게 쓴다. 그 결과는 그 제출 요청·그 버전에만 쓴다
 * 실제 taskkill 러너·실제 PowerShell(제한 언어 모드로 바꾼 도우미)·실제 git (Windows 전용)
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID, OWNER } from '@shared/domain';
import { createJobHelper } from '../../src/main/process/jobHelper';
import { taskKey } from '../../src/main/orchestrator/records';
import { createHarness, type Harness } from '../e2e/harness';
import { mainSettled } from './mainSettle';
import { seedDirective, sleep } from '../acceptance/stops-helpers';

const CONSTRAINED = "$ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage'";

let h: Harness | null = null;
afterEach(async () => {
  await h?.close().catch(() => undefined);
  h = null;
});

/** 도우미를 쓸 수 없는 taskkill 러너로, 단계를 마치고 검수를 요청한 저장소 작업 하나 (wait=false면 제출 처리를 기다리지 않는다) */
async function submitted(checkCommands: string[], wait = true): Promise<{ h: Harness; taskId: string; processing: Promise<void> }> {
  h = await createHarness({ team: ['developer'], runnerMode: 'taskkill', jobHelper: createJobHelper({ log: () => undefined, scriptPrefix: CONSTRAINED }), checkCommands });
  const { core } = h;
  const ctx = core.ctx;
  const d = seedDirective({ ctx, projectId: h.projectId }, '검사 확인 불가');
  const devId = h.members.developer!;
  const t = core.tasks.create(
    { directiveId: d.id, title: '기능', goal: '목표', type: 'development', assigneeId: devId, reviewerId: MAIN_AGENT_ID, acceptanceCriteria: ['동작한다'], outputMode: 'repo' },
    h.members.producer!,
  );
  if (!(await core.tasks.activateForLaunch(t.id))) throw new Error('활성화 실패');
  for (const q of ctx.store.queue.list({ ref2: taskKey(t.id), state: 'queued' })) ctx.store.queue.put({ ...q, state: 'done', doneAt: ctx.now() });
  core.tasks.setSteps(t.id, ['단계 1']);
  const dev = ctx.store.members.require(devId);
  writeFileSync(join(ctx.store.tasks.require(t.id).workspace!.worktreePath, `${t.id}.txt`), `${t.id} 변경\n`, 'utf8');
  await core.tasks.completeStep(t.id, 0, '완료', dev, null);
  core.tasks.requestSubmit(t.id, '제출', dev);
  const processing = core.tasks.processSubmission(t.id);
  if (wait) await processing;
  return { h, taskId: t.id, processing };
}

/** 메인 에이전트 재개(resume_task, 옛 대표 재개) → 제출 처리가 끝날 때까지 */
async function ownerResumes(e: Harness, taskId: string): Promise<void> {
  // 그 보류의 메인 알림 턴이 끝나기를 기다린다 — 이 환경에서는 그 턴도 종료를 확인하지 못해 메인이 일시정지되므로 대표처럼 정지 해제 (리드 결정 6·S5-7)
  await mainSettled(e);
  await e.main('resume_task', { task_id: taskId });
  await e.waitFor(() => !e.core.tasks.isSubmitting(taskId) && e.core.ctx.store.tasks.require(taskId).state !== 'in_progress', { label: '재개 뒤 제출 처리', timeoutMs: 60_000 });
  await sleep(100);
}

const checkRuns = (e: Harness, taskId: string) => e.core.ctx.store.execs.list({ ref1: taskId }).filter((x) => x.kind === 'auto_check');

describe.skipIf(process.platform !== 'win32')('종료를 확인하지 못한 자동 검사: 메인 에이전트가 확인하고 재개하면 그 결과로 제출을 이어 간다 (S7-C2, CTL-11, REV-01)', () => {
  it('통과한 검사(종료 코드 0)는 재개 한 번에 다시 돌리지 않고 검수로 간다 — 보류 사유·알림이 그렇게 말한다 (예전: 재개할 때마다 다시 검사·다시 보류)', async () => {
    const { h: e, taskId } = await submitted(['echo ok']);
    const store = e.core.ctx.store;
    const held = store.tasks.require(taskId);
    expect(held.state).toBe('on_hold');
    const reason = held.hold.reasons.find((r) => r.kind === 'error')!;
    expect(reason.note).toContain('남은 하위 프로세스를 확인하지 못했습니다');
    // 기록한 결과는 그 버전에만 쓴다 — 약속도 '같은 버전이면'으로 하고 버전이 바뀌면 다시 검사한다고 말한다 (S8-C1, CTL-11).
    // 재개는 메인 에이전트 몫이다 — 대표가 확인한다고 말하지 않는다 (리드 결정 21)
    expect(reason.note).toContain('남은 프로세스를 확인하고 재개할지는 메인 에이전트가 정합니다. 재개했을 때 같은 버전이면 검사를 다시 돌리지 않고 이 결과(통과 — 종료 코드 0)로 제출을 이어 갑니다');
    expect(reason.note).not.toContain('대표가 확인');
    expect(reason.note).toContain('버전이 달라지면 다시 검사');
    expect(reason.refId).toBe(checkRuns(e, taskId)[0]!.requestId);
    // 화면은 글이 아니라 종류·범위·실행 기록 ID로 이 보류를 알아본다 (src/renderer/src/lib/taskSignals.ts isUnconfirmedCheckHold, docs/design/
    // permission-ui 9항) — 서버가 내보내는 작업 보기의 보류(error·task·refId)와 작업 상세의 검사 실행(requestId)이 그대로 맞물린다
    const viewHold = e.core.views.taskView(held).hold!.reasons.find((r) => r.kind === 'error')!;
    expect([viewHold.kind, viewHold.scope]).toEqual(['error', 'task']);
    expect(((await e.core.views.taskDetail(taskId)).checkRuns ?? []).map((r) => r.requestId)).toContain(viewHold.refId);
    expect(held.review.autoCheck.status).toBe('not_run');
    expect(held.review.autoCheck.detail).toContain('재개할지는 메인 에이전트가 정합니다');
    expect(held.review.autoCheck.detail).not.toContain('대표가 확인');
    expect(held.pendingSubmit).not.toBeNull();
    const notice = store.notifications.list().find((n) => n.key === `kill-failed:check:${taskId}`)!;
    expect(notice.body).toContain('이 결과(통과 — 종료 코드 0)로 제출을 이어 갑니다');

    await ownerResumes(e, taskId);
    const t = store.tasks.require(taskId);
    expect({ state: t.state, autoCheck: t.review.autoCheck.status, pendingSubmit: t.pendingSubmit, holds: t.hold.reasons.map((r) => r.kind) }).toEqual({
      state: 'in_review',
      autoCheck: 'passed',
      pendingSubmit: null,
      holds: [],
    });
    expect(t.review.target?.kind).toBe('repo');
    expect(t.review.autoCheck.detail).toContain('$ echo ok');
    const runs = checkRuns(e, taskId);
    expect(runs).toHaveLength(1); // 다시 돌리지 않았다
    expect(runs[0]!.result.ownerConfirmedAt).toEqual(expect.any(String));
    expect({ state: runs[0]!.state, remaining: runs[0]!.result.remaining }).toEqual({ state: 'succeeded', remaining: -1 }); // 대표 확인 뒤 판정, 확인 못 한 기록은 남김
    expect(store.activity.search({ taskId, limit: 500 }).some((a) => a.text.includes("자동 검사 'echo ok': 종료를 확인하지 못한 실행을 메인 에이전트가 확인하고 재개함 — 다시 검사하지 않고 그 결과(통과 — 종료 코드 0)로 이어 감"))).toBe(true);
    // 검수자(메인 에이전트 — 적격 팀원이 없을 때의 대체 검수, REV-06 v0.6)에게 넘어갔다 — 메인의 검수 세션에 검수 업무가 간다
    expect(store.queue.list({ ref2: `review:${taskId}` }).some((q) => q.kind === 'review' && q.memberId === MAIN_AGENT_ID)).toBe(true);
  }, 240_000);

  it('실패한 검사(종료 코드 3)는 재개하면 다시 돌리지 않고 보통의 실패 처리로 간다 (제출 요청을 지우고 재작업 안내, 이어진 실패 수 1)', async () => {
    const { h: e, taskId } = await submitted(['exit 3']);
    const store = e.core.ctx.store;
    expect(store.tasks.require(taskId).hold.reasons.find((r) => r.kind === 'error')!.note).toContain('이 결과(실패 — 종료 코드 3)로 제출을 이어 갑니다');
    // 그 보류의 메인 알림 턴이 끝나기를 기다린다 — 이 환경에서는 그 턴도 종료를 확인하지 못해 메인이 일시정지되므로 대표처럼 정지 해제 (리드 결정 6·S5-7)
    await mainSettled(e);
    await e.main('resume_task', { task_id: taskId });
    await e.waitFor(() => !e.core.tasks.isSubmitting(taskId) && store.tasks.require(taskId).pendingSubmit === null, { label: '재개 뒤 실패 처리', timeoutMs: 60_000 });
    const t = store.tasks.require(taskId);
    expect({ state: t.state, autoCheck: t.review.autoCheck.status, streak: t.checkFailStreak }).toEqual({ state: 'in_progress', autoCheck: 'failed', streak: 1 });
    expect(t.review.autoCheck.detail).toContain("'exit 3' 실패 (종료 코드 3, 재개 때 확인한 실행의 결과)");
    // 재작업 안내 (스케줄러가 이미 턴을 띄웠을 수 있어 상태는 가리지 않는다)
    expect(store.queue.list({ ref2: taskKey(taskId) }).some((q) => q.kind === 'task_work' && q.message.includes('자동 검사에 실패했습니다'))).toBe(true);
    expect(checkRuns(e, taskId).map((x) => x.state)).toEqual(['failed']);
  }, 240_000);

  it('명령이 둘이면 재개마다 확인한 실행을 건너뛰고 다음 명령으로 간다 — 두 번 재개하면 검수로 (예전: 첫 명령에서 끝없이 보류)', async () => {
    const { h: e, taskId } = await submitted(['echo one', 'echo two']);
    const store = e.core.ctx.store;
    expect(checkRuns(e, taskId).map((x) => x.command)).toEqual(['echo one']);
    await ownerResumes(e, taskId);
    expect(store.tasks.require(taskId).state).toBe('on_hold');
    expect(checkRuns(e, taskId).map((x) => x.command)).toEqual(['echo one', 'echo two']);
    await ownerResumes(e, taskId);
    const t = store.tasks.require(taskId);
    expect({ state: t.state, autoCheck: t.review.autoCheck.status }).toEqual({ state: 'in_review', autoCheck: 'passed' });
    expect(checkRuns(e, taskId).map((x) => x.command)).toEqual(['echo one', 'echo two']);
  }, 240_000);

  it('기록한 결과는 그 제출 요청에만 쓴다 — 제출 요청이 새로 들어왔으면 같은 버전이어도 다시 검사한다', async () => {
    const { h: e, taskId } = await submitted(['echo ok']);
    const store = e.core.ctx.store;
    const before = store.tasks.require(taskId).pendingSubmit!;
    // 보류 중 새 제출 요청 (같은 버전 — 작업 폴더는 그대로)
    store.tasks.patch(taskId, { pendingSubmit: { requestedAt: new Date(Date.parse(before.requestedAt) + 1000).toISOString(), note: '다시 제출' } });
    await ownerResumes(e, taskId);
    expect(store.tasks.require(taskId).state).toBe('on_hold');
    const runs = checkRuns(e, taskId);
    expect(runs).toHaveLength(2);
    expect(runs[1]!.result.headSha).toBe(runs[0]!.result.headSha);
  }, 240_000);

  it('정지로 끊긴 검사는 결과가 없으므로 재개하면 다시 검사한다 (보류 사유가 결과로 이어 간다고 하지 않는다)', async () => {
    const { h: e, taskId, processing } = await submitted(['ping -n 4 127.0.0.1 >nul'], false);
    const store = e.core.ctx.store;
    await e.waitFor(() => e.core.checks.running.size === 1, { label: '검사 실행', timeoutMs: 60_000 });
    await sleep(300);
    await e.invoke('stop.emergency');
    await processing;
    const held = store.tasks.require(taskId);
    expect(held.state).toBe('on_hold');
    const error = held.hold.reasons.find((r) => r.kind === 'error')!;
    expect(error.note).toContain('남은 하위 프로세스를 확인하지 못했습니다');
    expect(error.note).not.toContain('재개할지는 메인 에이전트가 정합니다');
    expect(error.note).not.toContain('대표가 확인');
    expect(held.review.autoCheck.detail).toBe('정지로 중단 — 재개 때 다시 검사');
    expect(checkRuns(e, taskId).map((x) => [x.result.terminated, x.result.heldSince ?? null])).toEqual([[true, null]]);
    await e.invoke('stop.release');
    await ownerResumes(e, taskId);
    // 다시 검사했다 (이번에는 스스로 끝나 결과가 있으므로 그 결과로 이어 가는 보류)
    const runs = checkRuns(e, taskId);
    expect(runs).toHaveLength(2);
    expect(runs[1]!.result.heldSince).toEqual(expect.any(String));
    expect(store.tasks.require(taskId).hold.reasons.find((r) => r.kind === 'error')!.note).toContain('이 결과(통과 — 종료 코드 0)로 제출을 이어 갑니다');
  }, 240_000);

  it('보류 중 작업 폴더가 바뀌어 다른 버전을 검사하게 되면 기록한 결과를 쓰지 않고 다시 검사한다 (그 결과는 그 버전에만)', async () => {
    const { h: e, taskId } = await submitted(['echo ok']);
    const store = e.core.ctx.store;
    const wt = store.tasks.require(taskId).workspace!.worktreePath;
    // 보류 중 작업 폴더에 커밋이 생겨 새 버전이 된다 (커밋하지 않은 파일이면 재개가 커밋하지 않고 거부한다 — 검사가 쓴 것과 가릴 수 없다, S9-C2)
    writeFileSync(join(wt, 'more.txt'), '보류 중 바뀐 내용\n', 'utf8');
    execFileSync('git', ['-C', wt, 'add', 'more.txt']);
    execFileSync('git', ['-C', wt, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', '보류 중 변경']);
    await ownerResumes(e, taskId);
    expect(store.tasks.require(taskId).state).toBe('on_hold');
    const runs = checkRuns(e, taskId);
    expect(runs).toHaveLength(2);
    expect(runs[1]!.result.headSha).not.toBe(runs[0]!.result.headSha);
    await ownerResumes(e, taskId);
    expect(store.tasks.require(taskId).state).toBe('in_review');
    expect(checkRuns(e, taskId)).toHaveLength(2);
  }, 240_000);
});
