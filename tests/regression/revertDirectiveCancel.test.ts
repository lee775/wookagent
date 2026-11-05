/**
 * 지시 취소 전부터 있던 되돌리기 작업의 프로그램 단계 (S7-B6 — stage-6 revert-cancel 후속 4(a), AC-46, TSK-09, CTL-08, GIT-10).
 * 지시 취소는 취소 선택을 먼저 저장한 뒤 미완료 작업을 하나씩 취소한다. 예전에는 그 사이(취소가 다른 작업의 중간 결과를 보관하는 동안 등) 그 지시의
 * 되돌리기 작업이 프로그램 단계를 이어 가 작업 폴더에 되돌리기 커밋을 만들고 '되돌리기 커밋 … 기록'을 남겼다 — main은 제출·병합 쪽 확인으로 지켜졌지만
 * 작업 폴더와 활동 기록이 사실과 달랐다. 이제 취소 선택이 저장되면 되돌리기 단계(advanceRevert의 확인, 스케줄러의 되돌리기 이어 가기, 재시작 2-4)도
 * 그 지시의 일을 더 진행하지 않는다 — 멈췄다고 활동에 남기고, 지시 취소가 그 작업을 취소한다. 취소 뒤에 요청한 별도 되돌리기는 계속 간다(revertHolds).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID } from '@shared/domain';
import type { Env } from './helpers';
import { boot, waitFor } from './helpers';
import { activeRepoTask, gate, git, mainSha, mergeBy, newDirectiveIn, passedRepoTask } from '../acceptance/git-helpers';

let env: Env | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

describe('지시 취소가 저장된 뒤 그 지시의 되돌리기 단계 (S7-B6, AC-46)', () => {
  it('지시 취소가 다른 작업을 처리하는 동안 풀린 그 지시의 되돌리기는 작업 폴더에 되돌리기 커밋을 만들거나 기록하지 않고 멈췄다고 남긴 뒤 지시 취소가 취소한다 — main은 그대로', async () => {
    env = await boot({ team: ['developer', 'developer'] });
    const e = env;
    const [dev1, dev2] = e.members as [Env['members'][number], Env['members'][number]];
    const pid = e.project.id;
    const did = newDirectiveIn(e.core, pid, '되돌리기 중 지시 취소');
    const A = await passedRepoTask(e.core, { projectId: pid, assignee: dev1, files: { 'a.txt': 'A\n' }, title: 'A 작업', directiveId: did });
    expect((await mergeBy(e.core, A.id)).state).toBe('done');
    const T1 = await activeRepoTask(e.core, { projectId: pid, assignee: dev2, title: '진행 중 작업', directiveId: did });

    // 되돌리기 R의 프로그램 단계를 작업 폴더 만들기에서 붙잡아 둔다 (지시 취소 전에 시작된 단계)
    const wsGate = gate();
    const ensure = e.core.tasks.ensureWorkspace.bind(e.core.tasks);
    let rid = '';
    e.core.tasks.ensureWorkspace = async (t) => {
      if (t.type === 'revert') {
        rid = t.id;
        await wsGate.promise;
      }
      return ensure(t);
    };
    const revert = e.core.merges.requestRevert(A.id, e.producer, 'A 철회');
    await waitFor(() => !!rid, '되돌리기 작업 생성');
    // 지시 취소는 T1의 중간 결과 보관에서 붙잡아 둔다 — 그 사이 되돌리기 단계가 풀린다
    const archiveGate = gate();
    const archive = e.core.tasks.archiveWorkspace.bind(e.core.tasks);
    let archiving = false;
    e.core.tasks.archiveWorkspace = async (t, why) => {
      if (t.id === T1.id) {
        archiving = true;
        await archiveGate.promise;
      }
      return archive(t, why);
    };
    const before = mainSha(e.core, pid);
    const cancelling = e.core.directives.cancel(did, MAIN_AGENT_ID);
    await waitFor(() => archiving, 'T1 취소 처리');
    expect(e.ctx.store.directives.require(did).state).toBe('cancelled');

    wsGate.release();
    expect((await revert).revertTaskId).toBe(rid);
    const r = e.ctx.store.tasks.require(rid);
    // 그 지시의 일은 더 진행하지 않았다: 활성화·되돌리기 커밋·커밋 기록·제출 요청 모두 없음
    expect(r.state).toBe('waiting');
    expect(e.ctx.store.steps.list(rid).filter((s) => s.done)).toEqual([]);
    expect(r.pendingSubmit).toBeNull();
    const wt = r.workspace?.worktreePath;
    if (wt) expect(git(wt, ['log', '--format=%s', 'HEAD']).split(/\r?\n/).filter((l) => l === `[${rid}] ${A.id} 되돌리기`)).toEqual([]);
    const acts = e.ctx.store.activity.search({ text: rid, limit: 50 }).map((a) => a.text);
    expect(acts.some((t) => t.includes(`${rid} 되돌리기 단계 멈춤`) && t.includes(did))).toBe(true);
    expect(acts.filter((t) => t.includes(`${rid} 되돌리기 커밋`))).toEqual([]);

    archiveGate.release();
    await cancelling;
    expect(e.ctx.store.tasks.require(T1.id).state).toBe('cancelled');
    expect(e.ctx.store.tasks.require(rid).state).toBe('cancelled');
    expect(e.ctx.store.tasks.require(A.id).state).toBe('done');
    expect(mainSha(e.core, pid)).toBe(before);
  });
});
