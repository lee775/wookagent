/**
 * 프로그램 되돌리기 작업의 자동 검사가 실패하고 커밋되지 않은 파일을 남겼는데 종료를 확인하지 못해 보류됐을 때, 대표가 확인하고 재개하면
 * (stage-8 리뷰 taskkill8 D1 → S9-C1, stage-8 회귀 — 7.1, AC-12, REV-01).
 * 확인한 경로는 검사 실패를 '검사 뒤 상태'보다 먼저 본다: 되돌린 결과가 검사에 실패하면 일반 재작업이 아니라 되돌리기 보류(재계획) + 프로듀서
 * [replan] + '되돌리기 보류' 알림이다 (revertPipeline.test.ts). stage 8에서 생긴 재개 경로(refuseConfirmedCheckLeftovers)는 그 파일이 남아 있으면
 * 되돌리기 담당에게 '원인도 고친 뒤 다시 submit_for_review' 재작업으로 돌려보내 프로듀서가 조정 범위를 계획하지 않았다.
 * 이제 재개해도 확인한 경로와 같게 되돌리기를 보류하고, 검사가 남긴 파일은 커밋하지 않은 채 프로듀서 안내에 적는다. 보류 사유도 그렇게 말한다.
 * 실제 taskkill 러너·실제 PowerShell(제한 언어 모드로 바꾼 도우미)·실제 git (Windows 전용)
 */
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID } from '@shared/domain';
import type { Task } from '@shared/domain';
import { createJobHelper } from '../../src/main/process/jobHelper';
import { createProcessRunner } from '../../src/main/process/processRunner';
import type { ProcessRunner } from '../../src/main/process/types';
import { reviewKey, taskKey } from '../../src/main/orchestrator/records';
import { deadWorkReason } from '../../src/main/orchestrator/turns';
import { mergeBy, passedRepoTask, settled } from '../acceptance/git-helpers';
import type { Env } from './helpers';
import { boot, commitOnMain, git, notices, queued } from './helpers';

const CONSTRAINED = "$ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage'";

let env: Env | null = null;
let clm: ProcessRunner | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
  clm?.dispose?.();
  clm = null;
});

const kinds = (t: Task) => t.hold.reasons.map((r) => r.kind);
const queuedFor = (e: Env, taskId: string) => queued(e, (q) => q.taskId === taskId || q.sessionKey === taskKey(taskId) || q.sessionKey === reviewKey(taskId));

describe.skipIf(process.platform !== 'win32')('되돌리기 작업: 종료를 확인하지 못한 실패한 검사가 파일을 남겼으면 재개해도 되돌리기 보류 (S9-C1, 7.1, AC-12)', () => {
  it('재개하면 담당 재작업이 아니라 되돌리기 보류(재계획) + 프로듀서 [replan](남은 파일 이름) + 알림 — 그 파일은 커밋하지 않는다', async () => {
    env = await boot({ team: ['developer', 'qa'], runner: true, checkCommands: ['node check.js'] });
    const e = env;
    const dev = e.members[0]!;
    // A를 되돌리면 B(needs-a.txt)가 깨지고, 검사는 실패하면서 보고서 파일을 남긴다
    commitOnMain(
      e,
      'check.js',
      "const fs = require('fs');\nif (fs.existsSync('needs-a.txt') && !fs.existsSync('a.txt')) { fs.writeFileSync('check-report.txt', 'needs-a.txt는 a.txt가 있어야 합니다\\n'); console.error('needs-a.txt는 a.txt가 있어야 합니다'); process.exit(1); }\nconsole.log('검사 통과');\n",
    );
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
    const note = held.hold.reasons.find((r) => r.kind === 'error')!.note;
    expect(note).toContain('검사 뒤 커밋되지 않은 파일(check-report.txt)이 생겼습니다');
    // 보류 사유가 재개 때 할 일을 그대로 말한다 — 실패한 되돌리기는 거부가 아니라 되돌리기 보류
    expect(note).toContain('그 파일을 커밋하지 않고 검사도 다시 돌리지 않은 채 되돌리기를 보류해 프로듀서가 조정 범위를 계획하게 합니다');
    expect(note).not.toContain('담당에게 돌려보냅니다');
    const wt = held.workspace!.worktreePath;
    const headBefore = git(wt, ['rev-parse', 'HEAD']);
    const mainBefore = git(e.projectDir, ['rev-parse', 'HEAD']);

    e.core.tasks.resumeByOwner(held.id, MAIN_AGENT_ID);
    const rt = await settled(e.core, held.id, 60_000);
    const store = e.ctx.store;
    expect({ state: rt.state, holds: kinds(rt), pendingSubmit: rt.pendingSubmit, autoCheck: rt.review.autoCheck.status }).toEqual({
      state: 'on_hold',
      holds: ['replan'],
      pendingSubmit: null,
      autoCheck: 'failed',
    });
    expect(rt.review.autoCheck.detail).toContain('재개 때 확인한 실행의 결과');
    // 프로듀서에게 [replan] 하나 — 남은 파일 이름과 다시 진행·취소 방법. 담당 재작업 안내·제출 거부는 없다
    // 앞선 종료 확인 실패 보류는 메인 에이전트에게 알림 업무로 갔다(alert kill-failed) — 재개로 그 보류가 풀려 끝난 일이라 스케줄러가 전달하지 않고 지운다 (리드 결정 S5-7)
    const alert = queuedFor(e, rt.id).filter((q) => q.kind === 'alert');
    expect(alert.map((q) => [q.alertKey, !!deadWorkReason(e.ctx, q)])).toEqual([[`alert:kill-failed:${rt.id}`, true]]);
    const asks = queuedFor(e, rt.id).filter((q) => q.kind !== 'alert');
    expect(asks.map((q) => `${q.kind}→${(q as unknown as { memberId: string }).memberId}`)).toEqual([`replan→${e.producer.id}`]);
    const msg = (asks[0] as unknown as { message: string }).message;
    expect(msg).toContain('자동 검사에 실패해 보류했습니다');
    expect(msg).toContain('검사 뒤 커밋되지 않은 파일(check-report.txt)은 커밋하지 않고 작업 폴더에 두었습니다');
    expect(msg).toContain(`replan_task(task_id="${rt.id}")`);
    expect(msg).toContain(`cancel_task(task_id="${rt.id}")`);
    expect(notices(e, '되돌리기 보류')).toHaveLength(1);
    expect(store.activity.search({ taskId: rt.id, limit: 500 }).some((a) => a.text.includes('제출 거부'))).toBe(false);
    expect(store.activity.search({ taskId: rt.id, limit: 500 }).some((a) => a.text.includes('되돌리기 결과 자동 검사 실패 — 보류(재계획)') && a.text.includes('check-report.txt'))).toBe(true);
    // 다시 검사하지 않았고(대표 확인 기록) 그 파일을 커밋하지 않았다 — main도 그대로
    const runs = store.execs.list({ ref1: rt.id }).filter((x) => x.kind === 'auto_check');
    expect(runs).toHaveLength(1);
    expect(runs[0]!.result.ownerConfirmedAt).toEqual(expect.any(String));
    expect(git(wt, ['rev-parse', 'HEAD'])).toBe(headBefore);
    expect(git(wt, ['log', '--format=', '--name-only']).split(/\r?\n/).some((l) => l.trim() === 'check-report.txt')).toBe(false);
    expect(git(wt, ['status', '--porcelain'])).toContain('?? check-report.txt');
    expect(git(e.projectDir, ['rev-parse', 'HEAD'])).toBe(mainBefore);
  }, 300_000);
});
