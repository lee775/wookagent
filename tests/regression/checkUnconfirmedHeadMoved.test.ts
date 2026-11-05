/**
 * 종료를 확인하지 못해 보류한 자동 검사의 결과는 그 검사가 본 버전에만 쓴다 — 작업 폴더 HEAD가 그 검사 때와 다르면 재개 때 커밋되지 않은 파일을 검사
 * 산출물로 거부하지 않고, 커밋해 새 버전을 다시 검사한다 (stage-9 리뷰 taskkill9 D1 → S10-C1, stage-9 회귀 — REV-01, REV-07, CTL-11, 7.1·AC-12).
 * stage 9(S9-C2)는 '보류 중에는 턴이 돌지 않는다'고 보고 HEAD를 보지 않았다: 대표 재개 때 최신 main 반영이 충돌하면 같은 제출 요청으로 해결 턴이 돌고
 * 프로그램이 해결을 커밋해 HEAD가 바뀌는데, 그 뒤 팀원이 쓴 파일이 '자동 검사 뒤 커밋되지 않은 파일'로 거부되고 예전 결과(통과)가 그대로 보였으며,
 * 충돌을 해결한 버전은 한 번도 검사하지 않았다. 되돌리기 작업이면 실패한 예전 결과로 '결과(최신 main + 되돌리기)가 자동 검사에 실패해 보류'했다.
 * 실제 taskkill 러너·실제 PowerShell(제한 언어 모드로 바꾼 도우미)·실제 git (Windows 전용) — 검사도 턴도 남은 프로세스를 확인하지 못한다
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID, type Task } from '@shared/domain';
import { createJobHelper } from '../../src/main/process/jobHelper';
import { createProcessRunner } from '../../src/main/process/processRunner';
import type { ProcessRunner } from '../../src/main/process/types';
import { taskKey } from '../../src/main/orchestrator/records';
import { mergeBy, passedRepoTask, settled } from '../acceptance/git-helpers';
import { seedDirective, sleep } from '../acceptance/stops-helpers';
import { createHarness, type Harness } from '../e2e/harness';
import { mainSettled } from './mainSettle';
import { boot, commitOnMain, notices, type Env } from './helpers';

const CONSTRAINED = "$ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage'";

let h: Harness | null = null;
let env: Env | null = null;
let clm: ProcessRunner | null = null;
afterEach(async () => {
  await h?.close().catch(() => undefined);
  h = null;
  await env?.close();
  env = null;
  clm?.dispose?.();
  clm = null;
});

const git = (wt: string, ...args: string[]) => execFileSync('git', ['-C', wt, ...args], { encoding: 'utf8' });
const head = (wt: string) => git(wt, 'rev-parse', 'HEAD').trim();
/** 작업 브랜치에서 그 파일을 커밋에 넣은 적이 있는지 */
const everCommitted = (wt: string, file: string) => git(wt, 'log', '--format=', '--name-only').split(/\r?\n/).some((l) => l.trim() === file);
const kinds = (t: Task) => t.hold.reasons.map((r) => r.kind);

describe.skipIf(process.platform !== 'win32')('확인하지 못한 검사의 결과는 그 버전에만 — 작업 폴더 HEAD가 바뀌었으면 거부하지 않고 다시 검사 (S10-C1, REV-01·07)', () => {
  it('재개 때 최신 main 반영이 충돌해 해결 턴이 돌고 해결이 커밋된 뒤 팀원이 쓴 파일 — 거부하지 않고 커밋해 해결한 버전을 다시 검사한다', async () => {
    h = await createHarness({
      team: ['developer'],
      runnerMode: 'taskkill',
      jobHelper: createJobHelper({ log: () => undefined, scriptPrefix: CONSTRAINED }),
      checkCommands: ['echo ok'],
      scenarios: { developer: 'hang' },
    });
    const e = h;
    const ctx = e.core.ctx;
    const store = ctx.store;
    const d = seedDirective({ ctx, projectId: e.projectId }, '검사 확인 불가');
    const devId = e.members.developer!;
    const t = e.core.tasks.create(
      { directiveId: d.id, title: '기능', goal: '목표', type: 'development', assigneeId: devId, reviewerId: MAIN_AGENT_ID, acceptanceCriteria: ['동작한다'], outputMode: 'repo' },
      e.members.producer!,
    );
    if (!(await e.core.tasks.activateForLaunch(t.id))) throw new Error('활성화 실패');
    for (const q of store.queue.list({ ref2: taskKey(t.id), state: 'queued' })) store.queue.put({ ...q, state: 'done', doneAt: ctx.now() });
    e.core.tasks.setSteps(t.id, ['단계 1']);
    const dev = store.members.require(devId);
    const taskId = t.id;
    const wt = store.tasks.require(taskId).workspace!.worktreePath;
    writeFileSync(join(wt, 'shared.txt'), 'line A\n작업 쪽 변경\nline C\n', 'utf8');
    await e.core.tasks.completeStep(taskId, 0, '완료', dev, null);
    e.core.tasks.requestSubmit(taskId, '제출', dev);
    await e.core.tasks.processSubmission(taskId);
    // 검사는 통과했지만 종료를 확인하지 못해 보류 — 파일은 남기지 않았다
    const held = store.tasks.require(taskId);
    expect(kinds(held)).toEqual(['error']);
    const checkRuns = () => store.execs.list({ ref1: taskId }).filter((x) => x.kind === 'auto_check');
    const run0 = checkRuns()[0]!;
    expect(run0.result.leftFiles).toEqual([]);
    const submitAt = held.pendingSubmit?.requestedAt;

    // 보류 중 같은 파일을 바꾼 변경이 main에 들어온다 → 재개 때 최신 main 반영이 충돌한다. 해결 턴은 보통대로 해결하고 보고한다
    writeFileSync(join(e.projectDir, 'shared.txt'), 'line A\nmain 쪽 변경\nline C\n', 'utf8');
    git(e.projectDir, 'add', 'shared.txt');
    git(e.projectDir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'main: shared.txt');
    await e.internal('members.update', devId, { mockScenario: 'normal' });
    // 그 보류의 메인 알림 턴이 끝나기를 기다린다 — 이 환경에서는 그 턴도 종료를 확인하지 못해 메인이 일시정지되므로 대표처럼 정지 해제 (리드 결정 6·S5-7)
    await mainSettled(e);
    await e.main('resume_task', { task_id: taskId });
    await e.waitFor(() => store.activity.search({ taskId, limit: 500 }).some((a) => a.text.includes('충돌 해결 커밋')), { label: '충돌 해결 커밋', timeoutMs: 90_000 });
    // 같은 제출 요청이고, 프로그램의 해결 커밋으로 HEAD가 바뀌었다
    expect(store.tasks.require(taskId).pendingSubmit?.requestedAt).toBe(submitAt);
    expect(head(wt)).not.toBe(run0.result.headSha);
    // 보고 뒤에도 팀원이 파일을 쓴다 (그 턴이 남긴 프로세스가 써도 같다)
    writeFileSync(join(wt, 'notes.md'), '충돌 해결 메모 — 합친 결과를 확인함\n', 'utf8');
    await e.waitFor(
      () => {
        const x = store.tasks.require(taskId);
        return !e.core.tasks.isSubmitting(taskId) && !e.core.turns.hasLiveSession(taskKey(taskId)) && (x.state === 'on_hold' || x.pendingSubmit === null);
      },
      { label: '충돌 턴 끝', timeoutMs: 90_000 },
    );
    await sleep(300);
    // 해결 턴의 프로세스도 종료를 확인하지 못했다 → 메인 에이전트가 확인하고 다시 재개
    expect(kinds(store.tasks.require(taskId))).toEqual(['error']);
    expect(checkRuns()).toHaveLength(1);
    // 그 보류의 메인 알림 턴이 끝나기를 기다린다 — 이 환경에서는 그 턴도 종료를 확인하지 못해 메인이 일시정지되므로 대표처럼 정지 해제 (리드 결정 6·S5-7)
    await mainSettled(e);
    await e.main('resume_task', { task_id: taskId });
    await e.waitFor(
      () => {
        const y = store.tasks.require(taskId);
        return !e.core.tasks.isSubmitting(taskId) && (y.state !== 'in_progress' || y.pendingSubmit === null);
      },
      { label: '두 번째 재개 뒤 제출 처리', timeoutMs: 90_000 },
    );
    await sleep(300);

    // 거부하지 않았고 예전 결과로 이어 가지도 않았다 — 그 파일을 커밋하고 해결한 버전을 다시 검사했다 (그 검사도 확인하지 못해 다시 보류)
    const acts = store.activity.search({ taskId, limit: 500 }).map((a) => a.text);
    expect(acts.filter((a) => a.includes('제출 거부'))).toEqual([]);
    expect(acts.filter((a) => /(대표|메인 에이전트)가 확인하고 재개함/.test(a))).toEqual([]);
    expect(store.queue.list({ ref2: taskKey(taskId) }).some((q) => q.message.includes('자동 검사 뒤 커밋되지 않은 파일'))).toBe(false);
    expect(everCommitted(wt, 'notes.md')).toBe(true);
    expect(git(wt, 'status', '--porcelain').trim()).toBe('');
    const runs = checkRuns();
    expect(runs).toHaveLength(2);
    expect(runs[0]!.result.ownerConfirmedAt).toBeUndefined();
    expect(runs[1]!.result.headSha).toBe(head(wt));
    expect(runs[1]!.result.headSha).not.toBe(run0.result.headSha);
    const x = store.tasks.require(taskId);
    expect({ state: x.state, holds: x.hold.reasons.map((r) => [r.kind, r.refId]), autoCheck: x.review.autoCheck.status }).toEqual({
      state: 'on_hold',
      holds: [['error', runs[1]!.requestId]],
      autoCheck: 'not_run',
    });
  }, 300_000);

  it('되돌리기 작업: 실패한 검사를 보류한 뒤 작업 폴더에 커밋이 생겼으면 예전 실패로 되돌리기를 보류하지 않고 커밋해 새 버전을 다시 검사한다 (7.1, AC-12)', async () => {
    env = await boot({ team: ['developer', 'qa'], runner: true, checkCommands: ['node check.js'] });
    const e = env;
    const dev = e.members[0]!;
    // A를 되돌리면 B(needs-a.txt)가 깨진다 — 검사는 실패하고 파일은 남기지 않는다
    commitOnMain(e, 'check.js', "const fs = require('fs');\nif (fs.existsSync('needs-a.txt') && !fs.existsSync('a.txt')) { console.error('needs-a.txt는 a.txt가 있어야 합니다'); process.exit(1); }\nconsole.log('검사 통과');\n");
    const A = await passedRepoTask(e.core, { projectId: e.project.id, assignee: dev, files: { 'a.txt': 'A\n' }, title: 'A 작업' });
    expect((await mergeBy(e.core, A.id)).state).toBe('done');
    const B = await passedRepoTask(e.core, { projectId: e.project.id, assignee: dev, files: { 'needs-a.txt': 'B: a.txt 필요\n' }, title: 'B 작업' });
    expect((await mergeBy(e.core, B.id)).state).toBe('done');
    // 여기부터 작업 개체 도우미를 쓸 수 없다 (제한 언어 모드) — 검사마다 남은 하위 프로세스를 확인하지 못한다
    clm = await createProcessRunner({ dataDir: join(e.dataDir, 'clm'), forceMode: 'taskkill', jobHelper: createJobHelper({ log: () => undefined, scriptPrefix: CONSTRAINED }) });
    (e.ctx.deps as unknown as { runner: ProcessRunner }).runner = clm;

    const res = await e.core.merges.requestRevert(A.id, e.producer, 'A 철회');
    const held = await settled(e.core, res.revertTaskId!, 60_000);
    expect(kinds(held)).toEqual(['error']);
    const store = e.ctx.store;
    const checkRuns = () => store.execs.list({ ref1: held.id }).filter((x) => x.kind === 'auto_check');
    const run0 = checkRuns()[0]!;
    expect(run0.result.leftFiles).toEqual([]);
    const wt = held.workspace!.worktreePath;
    // 보류 중 되돌리기 작업 폴더에 커밋이 생기고(충돌 해결 커밋처럼 — 그 사이 버전이 바뀜), 커밋되지 않은 파일도 있다
    writeFileSync(join(wt, 'adjust.txt'), '조정\n', 'utf8');
    git(wt, 'add', 'adjust.txt');
    git(wt, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', '조정');
    writeFileSync(join(wt, 'notes.md'), '메모\n', 'utf8');
    expect(head(wt)).not.toBe(run0.result.headSha);

    e.core.tasks.resumeByOwner(held.id, MAIN_AGENT_ID);
    const rt = await settled(e.core, held.id, 60_000);
    // 예전 실패 결과로 되돌리기 보류(재계획)를 하지 않았다 — 그 파일을 커밋하고 새 버전을 다시 검사했다 (그 검사도 실패, 확인하지 못해 다시 보류)
    expect(notices(e, '되돌리기 보류')).toHaveLength(0);
    expect(store.activity.search({ taskId: rt.id, limit: 500 }).some((a) => a.text.includes('되돌리기 결과 자동 검사 실패') || a.text.includes('대표가 확인하고 재개함'))).toBe(false);
    expect(everCommitted(wt, 'notes.md')).toBe(true);
    const runs = checkRuns();
    expect(runs).toHaveLength(2);
    expect(runs[0]!.result.ownerConfirmedAt).toBeUndefined();
    expect(runs[1]!.result.headSha).toBe(head(wt));
    expect({ state: rt.state, holds: rt.hold.reasons.map((r) => [r.kind, r.refId]) }).toEqual({ state: 'on_hold', holds: [['error', runs[1]!.requestId]] });
  }, 300_000);
});
