/**
 * 해결 못 한 충돌 해결 턴 (GIT-07, CLI-18, 8장 헛돌기, AC-11):
 * - 해결 보고 없이 끝난 해결 턴은 진척 없는 자동 재개로 센다 — 남겨 둔 제출 요청이 있어도 제출 처리로 넘겨 같은 팀원에게 끝없이 다시 넣지 않는다
 * - 3번째면 헛돌기 보류(재계획) + 프로듀서 [replan]: 충돌임을 알리고 프로듀서가 직접 맡는 방법(자기에게 재배정 → 그 작업 폴더에서 해결)을 안내
 * - 프로듀서가 맡은 해결도, 다시 맡긴 해결도 풀리지 않으면 대표에게 긴급 보고
 * - 해결 보고를 한 턴은 세지 않고 제출 처리(최신 main 반영·검사·재검수)로 이어 간다
 * 턴 단위 하네스(orchHarness: 실제 오케스트레이터 + 가짜 CLI). 가짜 CLI 턴은 대본이 없으면 아무것도 하지 않고 정상 종료한다.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Task } from '@shared/domain';
import { git, mergeBy, passedRepoTask, samePath } from '../acceptance/git-helpers';
import { bootOrch, notices, seedDirective, waitFor, type OrchEnv } from './orchHarness';

let env: OrchEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const STUCK = '병합 충돌 해결 실패';

/** t1(개발자)을 먼저 병합하고 같은 파일을 고친 t2(QA 담당)를 병합 요청 → t2에 충돌 */
async function conflictedT2(o: OrchEnv): Promise<Task> {
  const dev = o.ctx.store.members.require(o.devId);
  const qa = o.ctx.store.members.require(o.qaId);
  const d = seedDirective(o);
  const t1 = await passedRepoTask(o.core, { projectId: o.projectId, assignee: dev, files: { 'shared.txt': '개발자 줄\n' }, directiveId: d.id });
  const t2 = await passedRepoTask(o.core, { projectId: o.projectId, assignee: qa, files: { 'shared.txt': 'QA 줄\n' }, directiveId: d.id });
  await mergeBy(o.core, t1.id);
  const r = await mergeBy(o.core, t2.id);
  expect(r.conflict?.files).toEqual(['shared.txt']);
  return r;
}

/**
 * 그 작업이 보류될 때까지 턴을 한 차례씩 돌린다. 턴은 판정보다 먼저 실행 목록에서 빠지므로, 판정이 끝나(다음 해결 업무 등록·제출 처리·보류)
 * 다음 차례를 돌릴 수 있을 때까지 기다린다 — 기다리지 않으면 부하가 클 때 아무 턴도 뜨지 않는 빈 차례가 생긴다
 */
async function runUntilHeld(o: OrchEnv, taskId: string, max = 10): Promise<Task> {
  const nextReady = () => {
    const t = o.ctx.store.tasks.require(taskId);
    if (t.state === 'on_hold' || t.state === 'waiting') return true;
    return !o.core.tasks.isSubmitting(taskId) && o.ctx.store.queue.list({ ref2: `task:${taskId}`, state: 'queued' }).length > 0;
  };
  for (let i = 0; i < max && o.ctx.store.tasks.require(taskId).state !== 'on_hold'; i++) {
    await o.drain(1);
    await waitFor(nextReady, `${taskId} 판정 뒤 다음 차례`, 20_000);
  }
  return o.ctx.store.tasks.require(taskId);
}

const fixTurnsOf = (o: OrchEnv, taskId: string, memberId: string) => o.launches.filter((l) => l.workKey === `task:${taskId}` && l.memberId === memberId);
const replansFor = (o: OrchEnv, taskId: string) => o.ctx.store.queue.list({}).filter((q) => q.kind === 'replan' && q.taskId === taskId && q.memberId === o.producerId);

describe('해결 못 한 충돌 해결 턴 (GIT-07, CLI-18)', () => {
  it('담당 팀원의 해결 턴 3번이 해결 보고 없이 끝나면 헛돌기 보류 + 프로듀서 [replan](충돌 안내) → 프로듀서가 직접 맡으면 그 작업 폴더에서 해결 업무를 받고, 그래도 안 되면 대표에게 긴급 보고', async () => {
    const o = (env = await bootOrch());
    const t2 = await conflictedT2(o);
    const held = await runUntilHeld(o, t2.id);
    expect(fixTurnsOf(o, t2.id, o.qaId)).toHaveLength(3);
    expect(held.state).toBe('on_hold');
    expect(held.hold.reasons.map((r) => [r.kind, r.note])).toEqual([['replan', '병합 충돌 미해결 — 진척 없는 자동 재개 3회']]);
    expect(held.conflict?.files).toEqual(['shared.txt']);
    expect(held.pendingSubmit).not.toBeNull(); // 해결 뒤 이어서 제출 처리하려고 남겨 둔다
    const [replan] = replansFor(o, t2.id);
    expect(replan?.message).toContain('병합 충돌(shared.txt)');
    expect(replan?.message).toContain(`replan_task(task_id="${t2.id}", assignee_id="${o.producerId}")`);
    expect(notices(o, STUCK)).toEqual([]); // 첫 헛돌기는 프로듀서까지

    // 프로듀서가 해결 업무를 직접 맡는다 (자기에게 재배정) → 같은 작업 폴더에서 충돌 해결 업무로 시작
    o.core.tasks.replan(t2.id, { note: '프로듀서가 직접 해결', assigneeId: o.producerId }, o.producerId);
    expect(o.ctx.store.tasks.require(t2.id)).toMatchObject({ state: 'waiting', assigneeId: o.producerId });
    const again = await runUntilHeld(o, t2.id);
    const producerTurns = fixTurnsOf(o, t2.id, o.producerId);
    expect(producerTurns).toHaveLength(3);
    expect(producerTurns[0]!.message).toContain('병합 충돌이 남아 있습니다');
    const firstEntry = o.ctx.store.queue.list({ ref2: `task:${t2.id}` }).find((q) => q.memberId === o.producerId);
    expect(firstEntry?.kind).toBe('conflict_fix');
    const session = o.ctx.store.sessions.list({ ref2: `task:${t2.id}` }).find((s) => s.memberId === o.producerId)!;
    expect(samePath(session.cwd, held.workspace!.worktreePath)).toBe(true); // CLI-03: 프로듀서도 그 작업의 worktree에서
    expect(again.state).toBe('on_hold');
    expect(again.contributors).toContain(o.producerId);
    // 프로듀서가 맡아서도 못 풀었다 → 대표에게 보고 (GIT-07 '그래도 안 되면 대표에게 보고')
    expect(notices(o, STUCK)).toHaveLength(1);
    expect(notices(o, STUCK)[0]).toMatchObject({ level: 'urgent' });
    // 대표는 메인 에이전트에게 명령만 한다 — '대표 판단이 필요합니다'가 아니라 메인 에이전트에게 넘긴 사실과 서두를 때의 명령창 길을 적는다 (리드 결정 40·S5-9)
    expect(notices(o, STUCK)[0]!.body).toBe(
      `${t2.id} ${t2.title} — 충돌 파일 shared.txt을(를) 프로듀서가 맡아서도 해결하지 못했습니다. 메인 에이전트에게 넘겼습니다. 메인 에이전트가 확인하고 이어 갑니다 — 서둘러야 하면 명령창으로 메인 에이전트에게 알려 주세요 (GIT-07)`,
    );
    // 메인 에이전트에게 알림 업무 하나 — resume_task로는 재계획 보류가 풀리지 않는다는 것과 프로듀서·취소의 길 (리드 결정 S5-7·S5-8)
    const alerts = o.ctx.store.queue.list({ ref1: 'M-MAIN' }).filter((q) => q.kind === 'alert');
    expect(alerts.map((q) => q.alertKey)).toEqual([`alert:conflict-stuck:${t2.id}`]);
    expect(alerts[0]!.message).toContain('resume_task로는 재계획 보류가 풀리지 않습니다');
    expect(alerts[0]!.message).toContain(`cancel_task(task_id="${t2.id}", reason="…")`);
  }, 60_000);

  it('프로듀서가 방법만 바꿔 같은 담당에게 다시 맡겼는데도 같은 충돌이 다시 헛돌면 대표에게 긴급 보고한다', async () => {
    const o = (env = await bootOrch());
    const t2 = await conflictedT2(o);
    expect((await runUntilHeld(o, t2.id)).state).toBe('on_hold');
    expect(notices(o, STUCK)).toEqual([]);
    o.core.tasks.replan(t2.id, { note: '충돌 표시를 줄 단위로 합치세요' }, o.producerId);
    const t = await runUntilHeld(o, t2.id);
    expect(t.state).toBe('on_hold');
    expect(fixTurnsOf(o, t2.id, o.qaId)).toHaveLength(6);
    expect(notices(o, STUCK)).toHaveLength(1);
  }, 60_000);

  it('규칙을 어기고 병합을 취소한 뒤 해결을 보고하기를 되풀이해도 끝없이 돌지 않는다 — 받아들인 해결 커밋 없이 끝난 해결 턴은 보고가 있어도 이어서 세고, 다시 생긴 충돌은 같은 충돌로 이어 가 3번째 턴에 헛돌기로 넘어간다', async () => {
    const o = (env = await bootOrch());
    const t2 = await conflictedT2(o);
    const since0 = t2.conflict!.since;
    const wt = t2.workspace!.worktreePath;
    let n = 0;
    o.script.set(`task:${t2.id}`, (p) => {
      const i = n++;
      void (async () => {
        if (i % 2 === 0) git(wt, ['merge', '--abort']); // git을 직접 쓰는 규칙 위반 (CLI-09)
        else await o.tool(p.turnId, 'report_conflict_resolved', { note: '해결했다고 보고' });
        p.finishOk();
      })().catch((e: unknown) => {
        o.errors.push(String(e));
        p.finishOk('대본 오류');
      });
    });
    const t = await runUntilHeld(o, t2.id, 12);
    expect(o.errors).toEqual([]);
    expect(t.state).toBe('on_hold');
    expect(t.hold.reasons.map((r) => r.kind)).toEqual(['replan']);
    // 취소 턴·보고 턴 모두 받아들인 해결 커밋이 없다 → 3번째 턴에 헛돌기 (보고는 해결된 것이 없어 받지 않는다). 다시 생긴 충돌은 같은 충돌이라 since도 그대로
    expect(fixTurnsOf(o, t2.id, o.qaId)).toHaveLength(3);
    expect(t.conflict).toMatchObject({ files: ['shared.txt'], since: since0, unresolvedTurns: 3 });
  }, 60_000);

  it('해결 보고를 한 해결 턴은 진척 없는 재개로 세지 않고, 턴이 끝나면 남겨 둔 제출 요청으로 최신 main 반영·검사·검수로 이어 간다', async () => {
    const o = (env = await bootOrch());
    const t2 = await conflictedT2(o);
    const key = `task:${t2.id}`;
    const wt = t2.workspace!.worktreePath;
    o.script.set(key, (p) => {
      void (async () => {
        writeFileSync(join(wt, 'shared.txt'), '개발자 줄\nQA 줄\n', 'utf8');
        const r = await o.tool(p.turnId, 'report_conflict_resolved', { note: '두 줄 합침' });
        if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
        p.finishOk('해결했습니다');
      })().catch((e: unknown) => {
        o.errors.push(String(e));
        p.finishOk('대본 오류');
      });
    });
    await o.drain(1);
    await waitFor(() => o.ctx.store.tasks.require(t2.id).state !== 'in_progress' && !o.core.tasks.isSubmitting(t2.id), '해결 뒤 제출 처리');
    const t = o.ctx.store.tasks.require(t2.id);
    expect(o.errors).toEqual([]);
    expect(fixTurnsOf(o, t2.id, o.qaId)).toHaveLength(1);
    expect(t.state).toBe('in_review');
    expect(t.conflict).toBeNull();
    expect(t.noProgressResumes).toBe(0);
    expect(t.contributors).toContain(o.qaId);
    expect(t.review.target?.kind).toBe('repo');
  }, 60_000);
});
