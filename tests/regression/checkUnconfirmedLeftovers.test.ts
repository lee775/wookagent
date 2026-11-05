/**
 * 종료를 확인하지 못한 자동 검사가 커밋되지 않은 파일을 남겼을 때, 대표가 확인하고 재개하면 (stage-7 리뷰 taskkill7 D1 → S8-C1 — REV-01, CTL-11,
 * 제출 처리의 '자동 검사 뒤 커밋되지 않은 파일' 규칙).
 * 확인한 검사는 끝난 뒤 작업 폴더에 커밋되지 않은 파일(빌드 산출물·보고서·시각 도장)이 있으면 제출을 거부하고 .gitignore를 안내한다. 확인하지 못해
 * 보류한 검사(S7-C2)는 재개하면 그 결과로 이어 가는데, 예전에는 재개한 제출 처리가 먼저 그 파일을 '제출 전 변경 정리'로 커밋했다 — 버전(HEAD)이 바뀌어
 * 기록한 결과를 쓰지 못하고 다시 검사·다시 보류(내용이 매번 바뀌는 파일이면 재개할 때마다 되풀이, 쓰레기 커밋 하나씩), 내용이 같으면 프로그램이
 * 검사 산출물을 커밋한 채 검수로 갔다. 보류 사유는 그래도 '검사를 다시 돌리지 않고 이 결과로 제출을 이어 갑니다'라고 약속했다.
 * 이제 재개 때 작업 폴더에 커밋되지 않은 파일이 있으면 커밋하지 않고 확인한 검사와 같게 거부한다 — 검사가 끝난 직후에 본 파일(leftFiles)만이 아니라
 * 남은 프로세스가 늦게 쓴 파일, 보류 중 바뀐 파일도 (S9-C2: 보류 중에는 턴이 돌지 않아 가릴 수 없다). 작업 폴더 HEAD가 그 검사 때와 같을 때만이다 —
 * 그 뒤 커밋이 생겼으면(재개 때 충돌 해결 등) 커밋해 다시 검사한다 (S10-C1, checkUnconfirmedHeadMoved.test.ts). 보류 사유도 그렇게 말하고, 결과로 이어
 * 가는 것은 파일을 남겼든 아니든 '같은 버전이면'으로만 약속한다 (S9-C3).
 * 실제 taskkill 러너·실제 PowerShell(제한 언어 모드로 바꾼 도우미)·실제 git (Windows 전용). 담당 모의 에이전트는 거부 뒤 안내 턴에서 응답 없음(hang) —
 * 다시 제출하지 않으므로 재개 한 번의 처리만 본다
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

/** 도우미를 쓸 수 없는 taskkill 러너로, 단계를 마치고 검수를 요청한 저장소 작업 하나 — 첫 제출 처리(검사 → 확인 불가 보류)까지 */
async function submitted(checkCommands: string[]): Promise<{ e: Harness; taskId: string; wt: string }> {
  h = await createHarness({
    team: ['developer'],
    runnerMode: 'taskkill',
    jobHelper: createJobHelper({ log: () => undefined, scriptPrefix: CONSTRAINED }),
    checkCommands,
    scenarios: { developer: 'hang' },
  });
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
  const wt = ctx.store.tasks.require(t.id).workspace!.worktreePath;
  writeFileSync(join(wt, `${t.id}.txt`), `${t.id} 변경\n`, 'utf8');
  await core.tasks.completeStep(t.id, 0, '완료', dev, null);
  core.tasks.requestSubmit(t.id, '제출', dev);
  await core.tasks.processSubmission(t.id);
  return { e: h, taskId: t.id, wt };
}

/** 메인 에이전트 재개(resume_task, 옛 대표 재개) → 그 재개의 제출 처리가 끝날 때까지 */
async function ownerResumes(e: Harness, taskId: string): Promise<void> {
  // 그 보류의 메인 알림 턴이 끝나기를 기다린다 — 이 환경에서는 그 턴도 종료를 확인하지 못해 메인이 일시정지되므로 대표처럼 정지 해제 (리드 결정 6·S5-7)
  await mainSettled(e);
  await e.main('resume_task', { task_id: taskId });
  await e.waitFor(
    () => {
      const t = e.core.ctx.store.tasks.require(taskId);
      return !e.core.tasks.isSubmitting(taskId) && (t.state !== 'in_progress' || t.pendingSubmit === null);
    },
    { label: '재개 뒤 제출 처리', timeoutMs: 60_000 },
  );
  await sleep(100);
}

const git = (wt: string, ...args: string[]) => execFileSync('git', ['-C', wt, ...args], { encoding: 'utf8' });
const head = (wt: string) => git(wt, 'rev-parse', 'HEAD').trim();
/** 작업 브랜치에서 그 파일을 커밋에 넣은 적이 있는지 */
const everCommitted = (wt: string, file: string) => git(wt, 'log', '--format=', '--name-only').split(/\r?\n/).some((l) => l.trim() === file);
const checkRuns = (e: Harness, taskId: string) => e.core.ctx.store.execs.list({ ref1: taskId }).filter((x) => x.kind === 'auto_check');

describe.skipIf(process.platform !== 'win32')('종료를 확인하지 못한 자동 검사가 남긴 파일: 재개하면 커밋하지 않고 확인한 검사와 같게 거부한다 (S8-C1, REV-01, CTL-11)', () => {
  it('매번 내용이 바뀌는 파일(시각 도장)을 남긴 통과한 검사 — 재개 한 번에 커밋·재검사 없이 거부, .gitignore 안내 (예전: 재개마다 커밋·재검사·재보류)', async () => {
    const { e, taskId, wt } = await submitted(['echo %TIME%-%RANDOM%> stamp.txt']);
    const store = e.core.ctx.store;
    const held = store.tasks.require(taskId);
    expect(held.state).toBe('on_hold');
    const note = held.hold.reasons.find((r) => r.kind === 'error')!.note;
    // 보류 사유가 재개 때 할 일을 그대로 말한다 (예전: '검사를 다시 돌리지 않고 이 결과(통과…)로 제출을 이어 갑니다' — 지키지 못한 약속).
    // 결과로 이어 가는 것은 같은 버전일 때만이다 — 파일을 치웠어도 main이나 작업 폴더가 바뀌면 다시 검사 (S9-C3, 예전: '검사를 다시 돌리지 않으며' 무조건)
    const refusal = '다만 작업 폴더의 커밋은 그대로인데 커밋되지 않은 파일이 있으면(검사나 검사가 남긴 프로세스가 쓴 파일 등) 그 파일을 커밋하지 않고 검사도 다시 돌리지 않은 채 제출을 거부해 담당에게 돌려보냅니다';
    const sameVersion = '같은 버전이면 검사를 다시 돌리지 않고 이 결과(통과 — 종료 코드 0)로 제출을 이어 갑니다 (그사이 main이나 작업 폴더가 바뀌어 검사할 버전이 달라지면 다시 검사)';
    expect(note).toContain('검사 뒤 커밋되지 않은 파일(stamp.txt)이 생겼습니다');
    expect(note).toContain(refusal);
    expect(note).toContain(sameVersion);
    expect(note).not.toContain('검사를 다시 돌리지 않으며');
    const notice = store.notifications.list().find((n) => n.key === `kill-failed:check:${taskId}`)!.body;
    for (const text of [held.review.autoCheck.detail, notice]) {
      expect(text).toContain(refusal);
      expect(text).toContain(sameVersion);
    }
    expect(checkRuns(e, taskId)[0]!.result.leftFiles).toEqual(['stamp.txt']);
    const before = head(wt);

    await ownerResumes(e, taskId);
    const t = store.tasks.require(taskId);
    expect({ state: t.state, pendingSubmit: t.pendingSubmit, holds: t.hold.reasons.map((r) => r.kind), autoCheck: t.review.autoCheck.status, streak: t.checkFailStreak }).toEqual({
      state: 'in_progress',
      pendingSubmit: null,
      holds: [],
      autoCheck: 'passed',
      streak: 1,
    });
    // 확인한 검사의 거부와 같은 문구 (활동 기록 · 담당 안내)
    expect(store.activity.search({ taskId, limit: 500 }).some((a) => a.text.includes('제출 거부 — 자동 검사 뒤 커밋되지 않은 파일 (stamp.txt)'))).toBe(true);
    expect(
      store.queue.list({ ref2: taskKey(taskId) }).some((q) => q.kind === 'task_work' && q.message.includes('자동 검사 뒤 커밋되지 않은 파일이 생겼습니다(빌드 산출물이면 .gitignore에 추가하세요): stamp.txt')),
    ).toBe(true);
    // 다시 검사하지 않았고(대표 확인 기록), 프로그램이 그 파일을 커밋하지 않았다 — 파일은 작업 폴더에 그대로
    const runs = checkRuns(e, taskId);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.result.ownerConfirmedAt).toEqual(expect.any(String));
    expect(head(wt)).toBe(before);
    expect(everCommitted(wt, 'stamp.txt')).toBe(false);
    expect(git(wt, 'status', '--porcelain')).toContain('?? stamp.txt');
  }, 240_000);

  it('추적 파일을 고치고 실패한 검사 — 재개하면 커밋하지 않고 거부하며 실패도 함께 알린다 (예전: 고친 내용을 커밋하고 다시 검사)', async () => {
    const { e, taskId, wt } = await submitted(['echo appended>> T-0001.txt & exit 3']);
    const store = e.core.ctx.store;
    expect(store.tasks.require(taskId).id).toBe('T-0001');
    expect(store.tasks.require(taskId).hold.reasons.find((r) => r.kind === 'error')!.note).toContain('이 결과(실패 — 종료 코드 3)');
    const before = head(wt);
    await ownerResumes(e, taskId);
    const t = store.tasks.require(taskId);
    expect({ state: t.state, pendingSubmit: t.pendingSubmit, autoCheck: t.review.autoCheck.status }).toEqual({ state: 'in_progress', pendingSubmit: null, autoCheck: 'failed' });
    expect(t.review.autoCheck.detail).toContain('실패 (종료 코드 3, 재개 때 확인한 실행의 결과)');
    const msg = store.queue.list({ ref2: taskKey(taskId) }).find((q) => q.kind === 'task_work' && q.message.includes('자동 검사 뒤 커밋되지 않은 파일이 생겼습니다'))?.message ?? '';
    expect(msg).toContain('T-0001.txt');
    expect(msg).toContain('그 검사는 실패했습니다');
    expect(checkRuns(e, taskId)).toHaveLength(1);
    expect(head(wt)).toBe(before);
    expect(git(wt, 'status', '--porcelain')).toContain(' M T-0001.txt');
  }, 240_000);

  it('재개 전에 그 파일을 치웠으면 같은 버전이므로 다시 검사하지 않고 그 결과(통과)로 검수로 간다', async () => {
    const { e, taskId, wt } = await submitted(['echo built> out.txt']);
    const store = e.core.ctx.store;
    rmSync(join(wt, 'out.txt'));
    expect(existsSync(join(wt, 'out.txt'))).toBe(false);
    await ownerResumes(e, taskId);
    const t = store.tasks.require(taskId);
    expect({ state: t.state, autoCheck: t.review.autoCheck.status }).toEqual({ state: 'in_review', autoCheck: 'passed' });
    expect(checkRuns(e, taskId)).toHaveLength(1);
    expect(everCommitted(wt, 'out.txt')).toBe(false);
  }, 240_000);

  it('그 파일은 치우고 보류 중 다른 파일을 바꿨어도 커밋하지 않고 같게 거부한다 — 보류 중에는 턴이 돌지 않아 검사(나 남은 프로세스)가 쓴 것과 가릴 수 없다 (S9-C2)', async () => {
    const { e, taskId, wt } = await submitted(['echo built> out.txt']);
    const store = e.core.ctx.store;
    const before = head(wt);
    rmSync(join(wt, 'out.txt'));
    writeFileSync(join(wt, 'more.txt'), '보류 중 바뀐 내용\n', 'utf8');
    await ownerResumes(e, taskId);
    const t = store.tasks.require(taskId);
    expect({ state: t.state, pendingSubmit: t.pendingSubmit }).toEqual({ state: 'in_progress', pendingSubmit: null });
    expect(store.activity.search({ taskId, limit: 500 }).some((a) => a.text.includes('제출 거부 — 자동 검사 뒤 커밋되지 않은 파일 (more.txt)'))).toBe(true);
    expect(checkRuns(e, taskId)).toHaveLength(1);
    expect(head(wt)).toBe(before);
    expect(everCommitted(wt, 'more.txt')).toBe(false);
    expect(everCommitted(wt, 'out.txt')).toBe(false);
    expect(git(wt, 'status', '--porcelain')).toContain('?? more.txt');
  }, 240_000);

  it('파일을 남기지 않은 검사는 같은 버전이면 결과로 이어 간다고만 약속한다 — 보류 중 main이 바뀌면 다시 검사한다', async () => {
    const { e, taskId, wt } = await submitted(['echo ok']);
    const store = e.core.ctx.store;
    const note = store.tasks.require(taskId).hold.reasons.find((r) => r.kind === 'error')!.note;
    // 재개는 메인 에이전트 몫이다 — 대표가 확인한다고 말하지 않는다 (리드 결정 21)
    expect(note).toContain('남은 프로세스를 확인하고 재개할지는 메인 에이전트가 정합니다. 재개했을 때 같은 버전이면 검사를 다시 돌리지 않고 이 결과(통과 — 종료 코드 0)로 제출을 이어 갑니다');
    expect(note).not.toContain('대표가 확인');
    expect(note).toContain('그사이 main이나 작업 폴더가 바뀌어 검사할 버전이 달라지면 다시 검사');
    // 보류 중 다른 작업이 main에 병합된 것처럼 main을 움직인다 → 재개 때 최신 main 반영으로 새 버전
    git(e.projectDir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-m', 'main 진행');
    await ownerResumes(e, taskId);
    const runs = checkRuns(e, taskId);
    expect(runs).toHaveLength(2);
    expect(runs[1]!.result.headSha).not.toBe(runs[0]!.result.headSha);
    expect(runs[0]!.result.ownerConfirmedAt).toBeUndefined();
    expect(head(wt)).toBe(runs[1]!.result.headSha);
  }, 240_000);
});

describe.skipIf(process.platform !== 'win32')('검사가 남긴 프로세스가 늦게 쓴 파일, 파일을 치운 뒤 버전이 바뀐 경우 (S9-C2·C3, REV-01, CTL-11)', () => {
  it('검사는 바로 끝나고 남은 프로세스가 2초 뒤에 쓴 파일 — 재개 한 번에 커밋·재검사 없이 거부한다 (예전: 재개마다 커밋·재검사·재보류, S9-C2)', async () => {
    // 확인하지 못한 까닭 그 자체인 남은 프로세스: 검사가 띄우고 떠난 자식이 검사가 끝난 뒤에 작업 폴더에 파일을 쓴다
    const dir = mkdtempSync(join(tmpdir(), 'wook-late-writer-'));
    const script = join(dir, 'delayed.cjs');
    writeFileSync(
      script,
      "const { spawn } = require('child_process');\nif (process.argv[2] === 'child') { setTimeout(() => require('fs').writeFileSync('late.txt', 'late ' + Date.now() + '\\n'), 2000); }\nelse { spawn(process.execPath, [__filename, 'child'], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); console.log('check ok'); }\n",
      'utf8',
    );
    try {
      const { e, taskId, wt } = await submitted([`"${process.execPath}" "${script}"`]);
      const store = e.core.ctx.store;
      const held = store.tasks.require(taskId);
      expect(held.state).toBe('on_hold');
      // 검사가 끝난 직후에는 파일이 없었다 — 보류 사유도 그때 본 대로 파일을 적지 않지만, 재개 때 커밋되지 않은 파일이 있으면 거부한다고 말한다
      expect(checkRuns(e, taskId)[0]!.result.leftFiles).toEqual([]);
      const note = held.hold.reasons.find((r) => r.kind === 'error')!.note;
      expect(note).not.toContain('검사 뒤 커밋되지 않은 파일(');
      expect(note).toContain('다만 작업 폴더의 커밋은 그대로인데 커밋되지 않은 파일이 있으면(검사나 검사가 남긴 프로세스가 쓴 파일 등) 그 파일을 커밋하지 않고 검사도 다시 돌리지 않은 채 제출을 거부해 담당에게 돌려보냅니다');
      const before = head(wt);
      // 대표가 남은 프로세스를 확인하는 사이 그 프로세스가 파일을 쓴다
      await e.waitFor(() => existsSync(join(wt, 'late.txt')), { label: '남은 프로세스가 쓴 파일', timeoutMs: 30_000 });
      await sleep(200);

      await ownerResumes(e, taskId);
      const t = store.tasks.require(taskId);
      expect({ state: t.state, pendingSubmit: t.pendingSubmit, holds: t.hold.reasons.map((r) => r.kind), autoCheck: t.review.autoCheck.status }).toEqual({
        state: 'in_progress',
        pendingSubmit: null,
        holds: [],
        autoCheck: 'passed',
      });
      expect(store.activity.search({ taskId, limit: 500 }).some((a) => a.text.includes('제출 거부 — 자동 검사 뒤 커밋되지 않은 파일 (late.txt)'))).toBe(true);
      expect(
        store.queue.list({ ref2: taskKey(taskId) }).some((q) => q.kind === 'task_work' && q.message.includes('자동 검사 뒤 커밋되지 않은 파일이 생겼습니다(빌드 산출물이면 .gitignore에 추가하세요): late.txt')),
      ).toBe(true);
      const runs = checkRuns(e, taskId);
      expect(runs).toHaveLength(1);
      expect(runs[0]!.result.ownerConfirmedAt).toEqual(expect.any(String));
      expect(head(wt)).toBe(before);
      expect(everCommitted(wt, 'late.txt')).toBe(false);
      expect(git(wt, 'status', '--porcelain')).toContain('?? late.txt');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 240_000);

  it('파일을 남긴 검사도 결과는 같은 버전에만 쓴다 — 그 파일을 치웠는데 보류 중 main이 바뀌었으면 보류 사유대로 다시 검사한다 (S9-C3)', async () => {
    const { e, taskId, wt } = await submitted(['echo built> out.txt']);
    const store = e.core.ctx.store;
    const note = store.tasks.require(taskId).hold.reasons.find((r) => r.kind === 'error')!.note;
    expect(note).toContain('검사 뒤 커밋되지 않은 파일(out.txt)이 생겼습니다');
    expect(note).toContain('같은 버전이면 검사를 다시 돌리지 않고 이 결과(통과 — 종료 코드 0)로 제출을 이어 갑니다 (그사이 main이나 작업 폴더가 바뀌어 검사할 버전이 달라지면 다시 검사)');
    rmSync(join(wt, 'out.txt'));
    git(e.projectDir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-m', 'main 진행');
    await ownerResumes(e, taskId);
    const runs = checkRuns(e, taskId);
    expect(runs).toHaveLength(2);
    expect(runs[1]!.result.headSha).not.toBe(runs[0]!.result.headSha);
    expect(runs[0]!.result.ownerConfirmedAt).toBeUndefined();
    expect(store.activity.search({ taskId, limit: 500 }).some((a) => a.text.includes('제출 거부'))).toBe(false);
    expect(everCommitted(wt, 'out.txt')).toBe(false);
  }, 240_000);
});
