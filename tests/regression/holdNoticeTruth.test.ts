/**
 * 메인 에이전트에게 가는 업무가 없는 보류의 대표 알림은 사실대로 (리드 결정 32, 10-30 — flows-guarantees 3차 재리뷰 [1],
 * tests-integrity 3차 재리뷰 [2]).
 * 결정 26은 종료 확인 실패 글(unconfirmedNote)에서 '재개하세요'를 걷어 내고 '…확인되면 메인 에이전트가 다시 이어 갑니다'라고 썼다. 그런데 메인
 * 에이전트에게 재개 업무가 가는 것은 팀원 일시정지(handPauseToMain)뿐이었다. 작업·검수 세션의 턴과 자동 검사(CTL-11)는 작업만 보류하고 아무에게도
 * 업무를 넣지 않아, 대표는 기다리면 된다고 들었는데 메인은 끝내 몰랐다. 병합 보류·실패 알림 다섯 곳(merges.ts)은 아예 대표에게 '작업을
 * 재개하세요'라고 했다 — 대표에게는 재개가 없다(SERVER_DESIGN 2.4).
 * 이 보류들을 메인 에이전트 업무로 옮기는 것은 5단계 alertsToMain이다(결정 32, SERVER_DESIGN 10.5). 그때까지 글은 이렇게 말한다:
 * '…정리되면 명령창으로 메인 에이전트에게 알려 주세요. 메인 에이전트가 확인하고 이어 갑니다' — 대표에게 재개하라고 하지 않고, 메인 에이전트가
 * 저절로 이어 간다고도 하지 않는다. 결정 26의 팀원 일시정지 글과 메인 에이전트 자신의 '정지 해제' 글은 그대로다(programPauseToMain).
 * 프로브 적응: 리뷰어 프로브 zz-s1fx3fg-task-hold-no-main과 zz-s1fix3-ti-merge-hold-notice는 메인 에이전트 업무(main:<P>)가 생기기를 기대했다.
 * 그 업무는 5단계 몫이라(결정 32), 여기서는 같은 준비로 알림·보류 글이 위 약속을 지키는지 보고, 안내대로 하면(메인 에이전트의 resume_task) 이어 가는지 본다.
 * 5단계 S5b(리드 결정 S5-7·S5-9): 이제 그 업무가 생긴다 — 작업 보류는 메인 에이전트에게 알림 업무(alert kill-failed·merge-dirty:<작업>)로 가고, 규칙도 바뀐다:
 * - 보류 사유 글은 사실만(출구 문장 없이). 대표 알림은 사실 + '작업을 보류하고 메인 에이전트에게 넘겼습니다. 메인 에이전트가 확인하고 이어 갑니다 — 서둘러야 하면
 *   명령창으로 메인 에이전트에게 알려 주세요'. 넘기지 못했을 때만(같은 보류를 이미 받아 마침) 결정 32의 문장. '처리 중'은 쓰지 않는다
 * - 서버 모드의 글에는 '작업 관리자'가 없다 — 원격 대표는 서버 PC를 볼 수 없어 운영자에게 부탁한다 (리드 결정 S4-20)
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { describeEmergency } from '../../src/main/shell/emergency';
import { mainKey, reviewKey, taskKey } from '../../src/main/orchestrator/records';
import { unconfirmedBlock, unconfirmedFacts, unconfirmedNote } from '../../src/main/orchestrator/turns';
import { MAIN_AGENT_ID } from '@shared/domain';
import type { Env } from './helpers';
import { boot, commitOnMain, mergeAndSettle, notices as mergeNotices, passedTask } from './helpers';
import type { OrchEnv } from './orchHarness';
import { bootOrch, seedDirective, seedInReviewTask, waitFor } from './orchHarness';

let env: OrchEnv | null = null;
let menv: Env | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
  await menv?.close();
  menv = null;
});

const TELL_MAIN = '명령창으로 메인 에이전트에게 알려 주세요. 메인 에이전트가 확인하고 이어 갑니다';
/** 메인 에이전트에게 알림 업무를 넣은 뒤의 대표 출구 (리드 결정 S5-9) */
const HANDED = '메인 에이전트에게 넘겼습니다. 메인 에이전트가 확인하고 이어 갑니다 — 서둘러야 하면 명령창으로 메인 에이전트에게 알려 주세요';
const killNotices = (e: OrchEnv) => e.ctx.store.notifications.list().filter((n) => n.title === '프로세스 종료 확인 실패');
/** 그 작업의 메인 알림 업무 (alert:<종류>:<작업>) */
const alertsOf = (e: OrchEnv, taskId: string) => e.ctx.store.queue.list({ ref1: MAIN_AGENT_ID }).filter((q) => q.kind === 'alert' && q.taskId === taskId);

/**
 * 대표에게 재개하라고 하지 않고, 메인 에이전트가 저절로 이어 간다고 하지 않고, '처리 중'이라고 하지 않는다. handed: 메인에게 넘긴 글이면 넘긴 사실(HANDED),
 * 아니면 결정 32의 문장으로 끝난다 (리드 결정 32·S5-9)
 */
function expectTruthful(text: string, handed: boolean): void {
  expect(text).not.toContain('재개하세요');
  expect(text).not.toContain('작업을 재개');
  expect(text).not.toContain('메인 에이전트가 다시 이어 갑니다');
  expect(text).not.toContain('처리 중');
  expect(text).toContain(handed ? HANDED : TELL_MAIN);
  if (handed) expect(text).not.toContain(TELL_MAIN);
}
/** 보류 사유 글은 사실만 — 출구 문장을 담지 않는다 (리드 결정 S5-9) */
function expectFactsOnly(note: string): void {
  expect(note).not.toContain('명령창으로');
  expect(note).not.toContain('넘겼습니다');
  expect(note).not.toContain('재개하세요');
}

describe('종료를 확인하지 못해 작업만 보류한 실행 (CTL-11, 리드 결정 32)', () => {
  it('막는 방법: 작업·검수 세션은 작업 보류, 메인 에이전트의 관리 실행은 메인 일시정지, 다른 팀원의 관리 실행은 팀원 일시정지', () => {
    expect(unconfirmedBlock('M-0003', 'task')).toBe('task_hold');
    expect(unconfirmedBlock('M-0004', 'review')).toBe('task_hold');
    expect(unconfirmedBlock('M-MAIN', 'review')).toBe('task_hold');
    expect(unconfirmedBlock('M-MAIN', 'main_project')).toBe('main_pause');
    expect(unconfirmedBlock('M-MAIN', 'main_general')).toBe('main_pause');
    expect(unconfirmedBlock('M-0002', 'directive')).toBe('member_pause');
  });

  it.each([
    ['남은 2개', 2, null, '남은 프로세스가 정리되면', '남은 프로세스가 정리되면'],
    ['확인 불가', -1, '작업 개체 도우미가 답하지 않음', '작업 관리자 등에서 남은 프로세스가 없는지 확인되면', '남은 프로세스가 없는지 확인되면'],
  ] as const)('알림 글 (%s): 넘겼으면 넘긴 사실, 넘기지 못했으면 정리되면 명령창으로 알려 달라고 — 보류 사유 글은 사실만, 서버 글에는 작업 관리자가 없다', (_label, remaining, cause, check, serverCheck) => {
    for (const what of ['턴', '자동 검사', '이전 실행'] as const) {
      const facts = unconfirmedFacts(null, remaining, cause, what);
      expectFactsOnly(facts);
      const handed = unconfirmedNote(null, remaining, cause, what, 'handed', 'desktop', '작업을 보류하고 ');
      expectTruthful(handed, true);
      expect(handed).toBe(`${facts} 작업을 보류하고 ${HANDED}`);
      const fallback = unconfirmedNote(null, remaining, cause, what, 'task_hold');
      expectTruthful(fallback, false);
      expect(fallback).toContain(`${check} ${TELL_MAIN}`);
      // 서버 모드 (리드 결정 S4-20·S5-9, 변이 s5b-server-taskmgr): 서버 PC는 원격 대표가 볼 수 없다
      for (const exit of ['handed', 'task_hold', 'member_pause', 'main_pause'] as const) {
        const s = unconfirmedNote(null, remaining, cause, what, exit, 'server', exit === 'handed' ? '작업을 보류하고 ' : '');
        expect(s, `${what} ${exit}`).not.toContain('작업 관리자');
      }
      expect(unconfirmedNote(null, remaining, cause, what, 'task_hold', 'server')).toContain(`${serverCheck} ${TELL_MAIN}`);
      expect(unconfirmedNote(null, remaining, cause, what, 'main_pause', 'server')).toContain("서버 PC의 운영자에게 확인을 부탁하세요) '정지 해제'를 누르세요");
    }
  });

  it('(프로브 적응) QA 검수 턴이 하위 프로세스를 남기면 작업 보류 — 보류 글은 사실만, 메인 에이전트에게 알림 업무가 가고 알림이 그렇게 말하며, 메인 에이전트가 재개하면 검수가 다시 돈다', async () => {
    const e = (env = await bootOrch());
    const t = seedInReviewTask(e, e.qaId);
    e.script.set(reviewKey(t.id), (p) => {
      p.emit({ kind: 'result', text: '검토 중', data: {} });
      p.exit(0, { remaining: 1 });
    });
    e.core.tasks.dispatchReview(e.ctx.store.tasks.require(t.id));
    await waitFor(
      () => {
        e.tick();
        return e.ctx.store.tasks.require(t.id).state === 'on_hold';
      },
      '작업 보류',
      30_000,
    );
    await e.idle();
    const task = e.ctx.store.tasks.require(t.id);
    const note = '턴 종료 뒤 하위 프로세스 1개가 남았습니다 (종료 확인 실패).';
    expect(task.hold.reasons.map((r) => [r.kind, r.note])).toEqual([['error', note]]);
    expect(killNotices(e).map((n) => n.body)).toEqual([`${e.ctx.store.members.require(e.qaId).name} 검수 ${t.id}: ${note} 작업을 보류하고 ${HANDED}`]);
    // 메인 에이전트에게 알림 업무 하나 — 키, 프로젝트 대화, 글에 프로세스와 정확한 도구 호출 (리드 결정 S5-7)
    const alerts = alertsOf(e, t.id);
    expect(alerts.map((q) => [q.alertKey, q.sessionKey, q.state !== 'cancelled'])).toEqual([[`alert:kill-failed:${t.id}`, mainKey(e.projectId), true]]);
    expect(alerts[0]!.message).toContain('- 프로세스: 턴 ');
    expect(alerts[0]!.message).toContain('남은 하위 프로세스 1개');
    expect(alerts[0]!.message).toContain(`resume_task(task_id="${t.id}", reason="…")`);
    expect((await e.invoke('snapshot.get')).ownerTodos.flatMap((x) => (x.kind === 'error' && x.taskId === t.id ? [x.reachesMain] : []))).toEqual([true]);
    // 메인 에이전트가 resume_task로 이어 간다 — 검수가 다시 등록되고 알림 업무는 끝난 일로 정리된다
    e.script.delete(reviewKey(t.id));
    e.hold.add(reviewKey(t.id));
    await e.main('resume_task', { task_id: t.id, reason: '대표가 남은 프로세스가 정리됐다고 알림' });
    expect(e.ctx.store.tasks.require(t.id).state).toBe('in_review');
    await waitFor(
      () => {
        e.tick();
        return !!e.liveProc(reviewKey(t.id), e.qaId);
      },
      '다시 도는 검수 턴',
    );
  });

  it('(프로브 적응) 개발 작업 턴이 하위 프로세스를 남기면 작업 보류 — 알림 글이 명령창으로 알려 달라고 한다', async () => {
    const e = (env = await bootOrch());
    const t = seedInReviewTask(e, e.qaId);
    e.ctx.store.tasks.patch(t.id, { state: 'in_progress', review: { ...e.ctx.store.tasks.require(t.id).review, target: null } });
    e.script.set(taskKey(t.id), (p) => {
      p.emit({ kind: 'result', text: '개발 서버 띄움', data: {} });
      p.exit(0, { remaining: 2 });
    });
    e.core.tasks.continueWork(t.id, '이어서 진행');
    await waitFor(
      () => {
        e.tick();
        return e.ctx.store.tasks.require(t.id).state === 'on_hold';
      },
      '작업 보류',
      30_000,
    );
    await e.idle();
    const bodies = killNotices(e).map((n) => n.body);
    expect(bodies).toHaveLength(1);
    expectTruthful(bodies[0]!, true);
    expect(bodies[0]).toContain(`하위 프로세스 2개가 남았습니다 (종료 확인 실패). 작업을 보류하고 ${HANDED}`);
    expectFactsOnly(e.ctx.store.tasks.require(t.id).hold.reasons[0]!.note);
    expect(alertsOf(e, t.id).map((q) => q.alertKey)).toEqual([`alert:kill-failed:${t.id}`]);
  });

  it('(서버 모드) 종료를 확인하지 못한 검수 턴의 알림에 작업 관리자가 없다 — 메인에게 넘긴 사실과 서두를 때의 길만 (리드 결정 S4-20·S5-9)', async () => {
    const e = (env = await bootOrch({ mode: 'server' }));
    const t = seedInReviewTask(e, e.qaId);
    e.script.set(reviewKey(t.id), (p) => {
      p.emit({ kind: 'result', text: '검토 중', data: {} });
      p.exit(0, { remaining: -1 });
    });
    e.core.tasks.dispatchReview(e.ctx.store.tasks.require(t.id));
    await waitFor(
      () => {
        e.tick();
        return e.ctx.store.tasks.require(t.id).state === 'on_hold';
      },
      '작업 보류',
      30_000,
    );
    await e.idle();
    const bodies = killNotices(e).map((n) => n.body);
    expect(bodies).toHaveLength(1);
    expectTruthful(bodies[0]!, true);
    expect(bodies[0]).not.toContain('작업 관리자');
    // 메인에게 가는 글도 서버 PC의 확인은 운영자 몫이라고 쓴다
    expect(alertsOf(e, t.id)[0]!.message).toContain('서버 PC 운영자의 확인을 부탁');
    expect(alertsOf(e, t.id)[0]!.message).not.toContain('작업 관리자');
  });

  it('자동 검사의 종료를 확인하지 못해 보류(-1) — 보류 글과 알림이 명령창으로 알려 달라고 한다', async () => {
    const e = (env = await bootOrch({ checkCommands: ['npm test'] }));
    e.check = (c) => c.exit(0, { remaining: -1 });
    const d = seedDirective(e);
    const t = e.core.tasks.create({ directiveId: d.id, title: '구현', goal: '목표', type: 'development', assigneeId: e.devId, acceptanceCriteria: ['동작'], outputMode: 'repo' }, e.producerId);
    const key = taskKey(t.id);
    e.hold.add(key);
    e.tick();
    await waitFor(() => !!e.liveProc(key), '작업 턴');
    const p = e.liveProc(key)!;
    expect((await e.tool(p.turnId, 'set_steps', { steps: ['구현'] })).ok).toBe(true);
    writeFileSync(join(e.ctx.store.tasks.require(t.id).workspace!.worktreePath, 'feature.txt'), '기능\n', 'utf8');
    expect((await e.tool(p.turnId, 'complete_step', { step_index: 0, note: '완료' })).ok).toBe(true);
    expect((await e.tool(p.turnId, 'submit_for_review', { note: '제출' })).ok).toBe(true);
    p.finishOk();
    await waitFor(() => e.checkProcs.length === 1 && !e.core.tasks.isSubmitting(t.id) && e.core.turns.count() === 0, '제출 처리 끝');
    const task = e.ctx.store.tasks.require(t.id);
    expect(task.state).toBe('on_hold');
    const note = task.hold.reasons[0]!.note;
    expectFactsOnly(note);
    expect(note).toContain(`자동 검사 종료 뒤 남은 하위 프로세스를 확인하지 못했습니다`);
    const n = e.ctx.store.notifications.list().filter((x) => x.key === `kill-failed:check:${t.id}`);
    expect(n).toHaveLength(1);
    expectTruthful(n[0]!.body, true);
    expect(n[0]!.body).toContain(`알 수 없습니다. 작업을 보류하고 ${HANDED}`);
    // 그 보류의 사유(refId — 그 검사 실행)를 가리키는 알림 업무 하나 (같은 작업의 키)
    expect(alertsOf(e, t.id).map((q) => q.alertKey)).toEqual([`alert:kill-failed:${t.id}`]);
  });
});

describe('병합 보류·실패 알림은 대표에게 재개하라고 하지 않는다 (리드 결정 32)', () => {
  // 안내대로 메인 에이전트가 재개하면 병합 판단부터 다시 해 병합하는 길은 mergeRace '병합 보류 해제 경로'가 본다
  it('(프로브 적응) 프로젝트 폴더에 커밋되지 않은 변경이 있어 병합 보류 — 변경을 정리하면 명령창으로 메인 에이전트에게 알려 달라고 한다', async () => {
    menv = await boot();
    const e = menv;
    commitOnMain(e, 'README.md', '원본\n');
    const t = await passedTask(e, { reviewer: 'main' });
    writeFileSync(join(e.projectDir, 'README.md'), '대표가 고치는 중\n', 'utf8');
    const held = await mergeAndSettle(e, t.id);
    expect(held.state).toBe('on_hold');
    const n = mergeNotices(e, '병합 보류');
    expect(n.map((x) => x.body)).toEqual([`회귀 폴더에 커밋되지 않은 변경이 있어 ${t.id} 병합을 보류하고 ${HANDED}. 그 변경을 직접 하고 있다면 정리(커밋·보관)한 뒤 알려 주세요`]);
    expectTruthful(n[0]!.body, true);
    expect(e.core.ctx.store.queue.list({ ref1: MAIN_AGENT_ID }).filter((q) => q.kind === 'alert').map((q) => q.alertKey)).toEqual([`alert:merge-dirty:${t.id}`]);
  });
});

describe('긴급 정지 OS 알림은 대표에게 항목별 재개를 맡기지 않는다 (리드 결정 32)', () => {
  it('보류가 있으면 해제 뒤 메인 에이전트가 항목별로 재개한다고, 없으면 새 실행을 다시 시작할 수 있다고 쓴다', () => {
    const base = { at: '2026-10-30T01:00:00.000Z', completed: true, stoppedTurns: [], heldTasks: [], failures: [] };
    const turn = { turnId: 'U-1', memberId: 'M-1', memberName: '가', taskId: null, ok: true, detail: '' };
    const held = { taskId: 'T-0001', title: '작업', previousState: 'in_progress' as const, projectId: 'P-0001' };
    const withHeld = describeEmergency({ ...base, stoppedTurns: [turn], heldTasks: [held] }).body;
    expect(withHeld).toBe('실행 중이던 1개를 모두 멈췄습니다. 작업 1개를 보류했습니다. [정지 해제]를 누르면 보류된 작업은 메인 에이전트가 확인해 항목별로 재개합니다.');
    const noHeld = describeEmergency({ ...base, stoppedTurns: [turn] }).body;
    expect(noHeld).toBe('실행 중이던 1개를 모두 멈췄습니다. [정지 해제]를 누르면 새 실행을 다시 시작할 수 있습니다.');
    for (const b of [withHeld, noHeld]) expect(b).not.toContain('재개할 수 있습니다');
  });
});
