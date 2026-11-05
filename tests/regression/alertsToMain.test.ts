/**
 * 대표에게만 가던 보류·실패를 메인 에이전트에게 (SERVER_DESIGN 5.3·10.5 alertsToMain, 리드 결정 S5-7·S5-8·S5-9·S5-10·S5-11).
 * 지도 alerts-to-main 2절 표의 줄마다 한 경우(1~28과 2.1절의 추가), 그리고 공통 규칙:
 * - 업무 종류 'alert', 키 'alert:<종류>:<대상>'(QueueEntry.alertKey), 프로젝트 일은 main:<P>, 아니면 main:general
 * - 같은 일은 한 번 — 알림 항목 하나는 보류 하나의 것(리드 결정 S5-25): 지금 보류가 걸린 뒤 넣은 실행 중·대기 항목이 싣고, 앞선 보류의 실행 중 항목은 새 보류를
 *   싣지 못하며, 앞선 보류의 대기 항목은 새 보류의 글로 바뀐다. 지금 보류가 걸린 뒤 같은 키로 이미 넣었으면 넣지 않는다(보류 한 번 규칙). 다음 보류는 새로 알린다.
 *   재촉 상한(계획 지연·프로듀서 처리 지연)은 지연 하나마다 한 번이다(S5-26)
 * - 넣는 곳은 보류를 저장한 뒤 — 대표 알림은 넘긴 뒤에 쓰고 '…메인 에이전트에게 넘겼습니다. 메인 에이전트가 확인하고 이어 갑니다 — 서둘러야 하면 …'. 넘기지 못했으면
 *   결정 32의 문장. 보류 사유 글은 사실만
 * - 한 번 받는 일 — 대상이 풀리면 끝난 일로 전달하지 않고 지운다. 상한에서 버리면 대표에게 알리고(결정 43의 길) 다시 만들지 않는다(돌지 않음)
 * - reachesMain — 그 키의 가장 최근 항목이 살아 있을 때만 참(작업 화면의 보류 사유·대표 할 일 error·merge·recovery_check)
 * - 시작 때 훑기는 알림이 없는 살아 있는 보류·항목에 알림을 만들고, 다시 불러도 같다
 * - 메인에게 갈 그 키의 알림은 그 키의 살아 있는 사유를 모두 싣는다(S5-44): 같은 보류의 대기 항목에 새 사유·새 PID의 줄을 더하고, 밀려 버리는 앞선 항목의
 *   보류가 남았으면 그 글을 더 새 항목에 옮겨 싣는다. resume_task는 풀 사유의 대기 알림을 한 번 거부 글로 먼저 보여 준다(S5-45) — 보인 알림은 부른 메인 턴에
 *   실려 그 턴이 끊기면 다시 전달된다(S5-49). resume_member·resolve_recovery·replace_producer도 같은 한 번 거부다(S5-50). 도는 알림의 같은 보류를 새 줄과 함께
 *   다시 알리면 그 줄은 대기 항목으로 간다(S5-51)
 * - 긴급 정지는 알림이 아니고(정지 해제 목록이 그 일), 알림 업무도 긴급 정지에 막힌다
 * 깊은 흐름은 다른 시험도 본다: holdNoticeTruth(CTL-11·병합 보류), noticeExits(시작 실패·비정상 종료·CLI 거부), conflictSpin, rejudgeOwnerRoute, nudgeCaps,
 * heldHandOverDrop(버린 보류 넘김), restartDropSticks·restartCutBound(재시작 상한), handOffInstructRoute(assign_reviewer)
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAIN_AGENT_ID, type AiConfig, type ExecRecord, type QueueEntry, type Task, type Turn } from '@shared/domain';
import { cancelQueued, directiveKey, enqueue, mainKey, reviewKey, taskKey } from '../../src/main/orchestrator/records';
import { CONFLICT_SPIN_NOTE, deadWorkReason, dropDeadWork } from '../../src/main/orchestrator/turns';
import {
  ALERT_EARLIER_HEAD,
  ALERT_JOINED_HEAD,
  ALERT_MESSAGE_MAX,
  alertKey,
  alertMain,
  alertTaskHold,
  carrySupersededAlert,
  handUnseenAlertsOnResume,
  handUnseenOnMemberRelease,
  memberAlertText,
  parseAlertKey,
  sweepAlerts,
} from '../../src/main/orchestrator/alerts';
import type { TokenIdentity } from '../../src/main/mcp/types';
import { TOOL_SPECS } from '../../src/main/mcp/catalog';
import { z } from 'zod';
import type { OrchEnv } from './orchHarness';
import { bootOrch, notices, seedDirective, seedInReviewTask, sleep, startReview, waitFor } from './orchHarness';
import type { Env } from './helpers';
import { boot, commitOnMain, mergeAndSettle, notices as envNotices, passedTask } from './helpers';
import { bootRestartable, type RestartableEnv } from '../acceptance/stops-helpers';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

let env: OrchEnv | null = null;
let henv: Env | null = null;
let renv: RestartableEnv | null = null;
afterEach(async () => {
  vi.restoreAllMocks();
  await env?.close();
  env = null;
  await henv?.close();
  henv = null;
  await renv?.close();
  renv = null;
});

const HANDED = '메인 에이전트에게 넘겼습니다. 메인 에이전트가 확인하고 이어 갑니다 — 서둘러야 하면 명령창으로 메인 에이전트에게 알려 주세요';
const TELL = '명령창으로 메인 에이전트에게 알려 주세요. 메인 에이전트가 확인하고 이어 갑니다';

type Ctxish = { ctx: OrchEnv['ctx'] };
/** 메인 에이전트의 알림 업무 (상태와 상관없이, 만든 차례) — key를 주면 그 키만 */
const alerts = (e: Ctxish, key?: string): QueueEntry[] => e.ctx.store.queue.list({ ref1: MAIN_AGENT_ID }).filter((q) => q.kind === 'alert' && (!key || q.alertKey === key));
const keys = (e: Ctxish): string[] => alerts(e).map((q) => q.alertKey!);
const live = (e: Ctxish): QueueEntry[] => alerts(e).filter((q) => q.state === 'queued' || q.state === 'running');
/** 작업 화면의 보류 사유마다 reachesMain */
const holdReach = (e: OrchEnv, taskId: string) => e.core.views.taskView(e.ctx.store.tasks.require(taskId)).hold!.reasons.map((r) => [r.kind, r.reachesMain]);
/** 대표 할 일 error(오류·병합 보류)의 reachesMain */
const todoReach = async (e: OrchEnv, taskId: string) => (await e.invoke('snapshot.get')).ownerTodos.flatMap((x) => (x.kind === 'error' && x.taskId === taskId ? [x.reachesMain] : []));
/** 그 알림 업무를 메인이 받아 마친 것으로 둔다 */
const markDone = (e: Ctxish, q: QueueEntry) => e.ctx.store.queue.put({ ...e.ctx.store.queue.require(q.id), state: 'done', doneAt: e.ctx.now() });
const ticks = async (e: OrchEnv, n = 3) => {
  for (let i = 0; i < n; i++) {
    e.tick();
    await sleep(20);
  }
};

/** 진행 전(대기) 작업 하나 */
function waitingTask(e: OrchEnv, title = '로그인 화면'): Task {
  const d = seedDirective(e);
  return e.core.tasks.create({ directiveId: d.id, title, goal: title, type: 'development', assigneeId: e.devId, acceptanceCriteria: ['동작한다'], outputMode: 'repo', prerequisiteIds: [] }, e.producerId);
}

/** 통과한 저장소 변경형 검수 중 작업 */
function passedRepo(e: OrchEnv): Task {
  const t = seedInReviewTask(e, e.qaId, { outputMode: 'repo' });
  const cur = e.ctx.store.tasks.require(t.id);
  e.ctx.store.tasks.patch(t.id, { review: { ...cur.review, passed: { reviewId: 'RV-0001', reviewerId: e.qaId, at: e.ctx.now(), target: cur.review.target! } } });
  return e.ctx.store.tasks.require(t.id);
}

/** 그 알림 업무 하나와 그 모양 — 키, 세션(프로젝트 대화), 첫 줄 '<대상> "<제목>" — …', 정확한 도구 호출 */
function expectAlert(e: OrchEnv, key: string, o: { sessionKey?: string; head?: string; calls?: string[] } = {}): QueueEntry {
  const all = alerts(e, key);
  expect(all, key).toHaveLength(1);
  const q = all[0]!;
  expect([q.kind, q.memberId, q.sessionKey, q.priority]).toEqual(['alert', MAIN_AGENT_ID, o.sessionKey ?? mainKey(e.projectId), 'high']);
  if (o.head) expect(q.message.split('\n')[0]).toContain(o.head);
  for (const c of o.calls ?? []) expect(q.message, c).toContain(c);
  // 작업 보류 알림은 바로 끝난 일이 아니다
  expect(deadWorkReason(e.ctx, q)).toBeNull();
  return q;
}

describe('지도의 줄마다: 대표에게만 가던 보류·실패가 메인 대기열에 한 번 들어간다 (리드 결정 S5-8)', () => {
  it('1. 작업·검수 턴의 종료 확인 실패(CTL-11) — 보류 사유는 사실만, 알림 업무에 PID·남은 수·resume_task, 대표 알림은 넘긴 사실, reachesMain 참', async () => {
    const e = (env = await bootOrch());
    const t = seedInReviewTask(e, e.qaId);
    e.script.set(reviewKey(t.id), (p) => {
      p.emit({ kind: 'result', text: '검토 중', data: {} });
      p.exit(0, { remaining: 2 });
    });
    e.hold.add(mainKey(e.projectId));
    e.core.tasks.dispatchReview(e.ctx.store.tasks.require(t.id));
    await waitFor(
      () => {
        if (!e.liveProc(mainKey(e.projectId), MAIN_AGENT_ID)) e.tick();
        return e.ctx.store.tasks.require(t.id).state === 'on_hold';
      },
      '작업 보류',
      30_000,
    );
    const turn = e.ctx.store.turns.list().find((x) => x.sessionKind === 'review' && x.taskId === t.id)!;
    expect(e.ctx.store.tasks.require(t.id).hold.reasons.map((r) => r.note)).toEqual(['턴 종료 뒤 하위 프로세스 2개가 남았습니다 (종료 확인 실패).']);
    const q = expectAlert(e, alertKey('kill-failed', t.id), {
      head: `${t.id} "검수 대상 작업" — `,
      calls: [`턴 ${turn.id}의 CLI PID ${turn.process.pid}`, '남은 하위 프로세스 2개', `resume_task(task_id="${t.id}", reason="…")`, `cancel_task(task_id="${t.id}", reason="…")`],
    });
    expect(q.taskId).toBe(t.id);
    expect(notices(e, '프로세스 종료 확인 실패').map((n) => n.body)).toEqual([`${e.ctx.store.members.require(e.qaId).name} 검수 ${t.id}: 턴 종료 뒤 하위 프로세스 2개가 남았습니다 (종료 확인 실패). 작업을 보류하고 ${HANDED}`]);
    expect(await todoReach(e, t.id)).toEqual([true]);
    expect(holdReach(e, t.id)).toEqual([['error', true]]);
  });

  it('2. 자동 검사의 종료 확인 실패 — 그 실행 기록을 refId로 둔 보류, 같은 작업의 키, 재개 때 이어 가는 글은 사실 뒤에', async () => {
    const e = (env = await bootOrch());
    const t = waitingTask(e);
    const note = await e.core.turns.blockUnconfirmedRun(
      { label: `${t.id} 자동 검사 'npm test'`, sessionKind: 'task', sessionKey: `check:${t.id}`, memberId: e.devId, projectId: e.projectId, taskId: t.id, turnId: null, refId: 'X-0009' },
      { envProblem: null, remaining: -1, cause: '도우미가 답하지 않음', what: '자동 검사', tail: '재개했을 때 같은 버전이면 이 결과로 이어 갑니다' },
    );
    const held = e.ctx.store.tasks.require(t.id);
    expect(held.hold.reasons.map((r) => [r.kind, r.refId, r.note])).toEqual([
      ['error', 'X-0009', '자동 검사 종료 뒤 남은 하위 프로세스를 확인하지 못했습니다 — 이 실행이 띄운 프로세스(개발 서버 등)가 모두 끝났는지 알 수 없습니다 (도우미가 답하지 않음). — 재개했을 때 같은 버전이면 이 결과로 이어 갑니다'],
    ]);
    expectAlert(e, alertKey('kill-failed', t.id), { calls: ['남은 하위 프로세스를 확인하지 못함', '자동 검사의 보류였다면'] });
    expect(note).toContain(`작업을 보류하고 ${HANDED}`);
    expect(e.ctx.store.notifications.list().filter((n) => n.key === `kill-failed:check:${t.id}`).map((n) => n.body.endsWith(`${HANDED} — 재개했을 때 같은 버전이면 이 결과로 이어 갑니다`))).toEqual([true]);
  });

  it('3. 병합 실패(main 바꾸기 전) — 병합 보류 → alert merge-fail, 대표 할 일 merge의 reachesMain 참. 메인의 resume_task는 아직 받지 않은 그 알림을 먼저 보여 주고(한 번 거부, 받아 마침 — 리드 결정 S5-45) 다시 부르면 재개한다. 보류가 다른 길로 풀리면 그 알림은 끝난 일로 전달하지 않고 지운다', async () => {
    const e = (env = await bootOrch());
    const t = passedRepo(e);
    (e.core.merges as unknown as { mergeFailed(id: string, err: unknown): void }).mergeFailed(t.id, new Error('git 오류 (시험)'));
    expect(e.ctx.store.tasks.require(t.id).hold.reasons.map((r) => [r.kind, r.note])).toEqual([['merge_blocked', '병합 실패: git 오류 (시험)']]);
    const q = expectAlert(e, alertKey('merge-fail', t.id), { calls: [`resume_task(task_id="${t.id}", reason="…")`, '병합 판단부터 다시'] });
    expect(notices(e, '병합 실패').map((n) => n.body)).toEqual([`${t.id}: git 오류 (시험) — 병합을 보류하고 ${HANDED}`]);
    expect(await todoReach(e, t.id)).toEqual([true]);
    e.hold.add(directiveKey(t.directiveId));
    // 메인이 아직 받지 않은 알림 — resume_task가 한 번 거부하고 그 글을 보여 준 뒤 받아 마친 것으로 둔다(취소가 아님). 다시 부르면 재개한다 (리드 결정 S5-45)
    const refused = await e.main('resume_task', { task_id: t.id }).then(
      () => null,
      (x: Error & { code?: string }) => x,
    );
    expect(refused?.code).toBe('conflict');
    expect(refused?.message).toContain(`- 알림 ${q.id} (병합 실패 ${t.id}) — 함께 풀릴 보류: 병합 보류 "병합 실패: git 오류 (시험)"`);
    expect(refused?.message).toContain(`  ${q.message.split('\n')[0]}`);
    expect(e.ctx.store.tasks.require(t.id).state).toBe('on_hold');
    expect(e.ctx.store.queue.require(q.id).state).toBe('done');
    expect(await todoReach(e, t.id)).toEqual([true]);
    expect(await e.main('resume_task', { task_id: t.id })).toMatchObject({ taskId: t.id, released: [{ kind: 'merge_blocked', note: '병합 실패: git 오류 (시험)' }] });
    expect(deadWorkReason(e.ctx, e.ctx.store.queue.require(q.id))).toBe(`${t.id}의 병합 실패 보류가 이미 풀림`);
    // 같은 작업의 병합이 다시 실패한 새 보류 — 이번에는 메인의 resume_task 밖(운영자의 내부 길)에서 풀린다: 아직 대기 중인 그 알림은 끝난 일로 지우고 메인 턴에
    // 싣지 않는다
    await sleep(5);
    e.ctx.store.tasks.patch(t.id, { state: 'in_review' });
    (e.core.merges as unknown as { mergeFailed(id: string, err: unknown): void }).mergeFailed(t.id, new Error('git 오류 2 (시험)'));
    const q2 = alerts(e, alertKey('merge-fail', t.id)).at(-1)!;
    expect([q2.id === q.id, q2.state]).toEqual([false, 'queued']);
    await e.internal('tasks.resume', t.id);
    expect(deadWorkReason(e.ctx, e.ctx.store.queue.require(q2.id))).toBe(`${t.id}의 병합 실패 보류가 이미 풀림`);
    e.tick();
    await sleep(30);
    expect(e.ctx.store.queue.require(q.id).state).toBe('done');
    expect(e.ctx.store.queue.require(q2.id).state).toBe('cancelled');
    expect(e.launches.filter((l) => l.workKey === mainKey(e.projectId))).toEqual([]);
  });

  it('4. 병합 보류(프로젝트 폴더에 커밋되지 않은 변경) — alert merge-dirty, 글이 그 변경은 대표·운영자 몫일 수 있다고 적는다', async () => {
    henv = await boot();
    const e = henv;
    commitOnMain(e, 'README.md', '원본\n');
    const t = await passedTask(e, { reviewer: 'main' });
    writeFileSync(join(e.projectDir, 'README.md'), '대표가 고치는 중\n', 'utf8');
    await mergeAndSettle(e, t.id);
    const all = alerts(e, alertKey('merge-dirty', t.id));
    expect(all).toHaveLength(1);
    expect(all[0]!.message).toContain('대표나 운영자가 직접 고친 것일 수 있습니다');
    expect(envNotices(e, '병합 보류').map((n) => n.body.includes(HANDED))).toEqual([true]);
  });

  it('5. 산출물 폴더 결과 파일 보관 실패 — alert artifact-fail', async () => {
    const e = (env = await bootOrch());
    const t = passedRepo(e);
    vi.spyOn(e.core.tasks, 'archiveDeliverables').mockImplementation(() => {
      throw new Error('EBUSY (시험)');
    });
    expect((e.core.merges as unknown as { archiveDeliverablesOrHold(id: string): boolean }).archiveDeliverablesOrHold(t.id)).toBe(false);
    expectAlert(e, alertKey('artifact-fail', t.id), { calls: ['결과 파일을 다시 보관·확정하고 완료합니다'] });
    expect(notices(e, '산출물 보관 실패').map((n) => n.body)).toEqual([`${t.id}: EBUSY (시험) — 작업을 보류하고 ${HANDED}`]);
  });

  it('6. 산출물 확정 실패 — alert artifact-fail (같은 키)', async () => {
    const e = (env = await bootOrch());
    const t = seedInReviewTask(e, e.qaId);
    vi.spyOn(e.core.merges, 'finalizeArtifact').mockRejectedValue(new Error('EPERM (시험)'));
    e.core.merges.finalizeArtifactOrHold(t.id);
    await waitFor(() => e.ctx.store.tasks.require(t.id).state === 'on_hold', '산출물 확정 실패 보류');
    expectAlert(e, alertKey('artifact-fail', t.id));
    expect(notices(e, '산출물 확정 실패').map((n) => n.body)).toEqual([`${t.id}: EPERM (시험) — 작업을 보류하고 ${HANDED}`]);
  });

  it('7. 되돌리기 처리 실패 — alert revert-fail', async () => {
    const e = (env = await bootOrch());
    const t = waitingTask(e);
    (e.core.merges as unknown as { revertFailed(id: string, err: unknown): void }).revertFailed(t.id, new Error('되돌리기 git 오류 (시험)'));
    expectAlert(e, alertKey('revert-fail', t.id), { calls: ['되돌리기를 이어 갑니다'] });
    expect(notices(e, '되돌리기 실패').map((n) => n.body)).toEqual([`${t.id}: 되돌리기 git 오류 (시험) — 되돌리기를 보류하고 ${HANDED}`]);
  });

  it('7b. 되돌리기 작업 폴더 생성 실패 — 보류한 뒤에만 알린다(끝난 작업이면 알리지 않는다), alert ws-fail', async () => {
    const e = (env = await bootOrch());
    const orig = passedRepo(e);
    e.ctx.store.tasks.patch(orig.id, { state: 'done', merge: { requestId: '-', taskCommitSha: 'a'.repeat(40), preMainSha: 'b'.repeat(40), mergeCommitSha: 'c'.repeat(40), mergedAt: e.ctx.now() } });
    const rt = waitingTask(e, '되돌리기');
    e.ctx.store.tasks.patch(rt.id, { type: 'revert', revertOfTaskId: orig.id });
    vi.spyOn(e.core.tasks, 'ensureWorkspace').mockRejectedValue(new Error('경로가 너무 깁니다 (시험)'));
    await e.core.merges.resumeRevert(rt.id);
    expect(e.ctx.store.tasks.require(rt.id).hold.reasons.map((r) => r.note)).toEqual(['되돌리기 작업 폴더 생성 실패: 경로가 너무 깁니다 (시험)']);
    expectAlert(e, alertKey('ws-fail', rt.id));
    expect(notices(e, '작업 공간 생성 실패').map((n) => [n.key, n.body])).toEqual([[`ws-fail:${rt.id}`, `${rt.id}: 경로가 너무 깁니다 (시험) — 작업을 보류하고 ${HANDED}`]]);
  });

  it.each(['review', 'task'] as const)('8·9. %s 턴 시작 실패 3번 — 보류 → alert start-fail, 글이 팀원 설정(set_member_ai)을 먼저 고치라고 한다', async (which) => {
    const e = (env = await bootOrch());
    const d = seedDirective(e);
    const t = which === 'review' ? seedInReviewTask(e, e.qaId, { outputMode: 'repo', directiveId: d.id }) : waitingTask(e, '작업 턴');
    const key = which === 'review' ? reviewKey(t.id) : taskKey(t.id);
    if (which === 'task') {
      expect(await e.core.tasks.activateForLaunch(t.id)).toBe(true);
    }
    e.hold.add(mainKey(e.projectId));
    e.prepareHook = (_launch, who) => {
      if (who.sessionKey === key) throw new Error('모델 이름을 찾을 수 없습니다 (시험)');
    };
    if (which === 'review') e.core.tasks.dispatchReview(e.ctx.store.tasks.require(t.id));
    await waitFor(
      () => {
        if (e.core.turns.count() === 0) e.tick();
        return e.ctx.store.tasks.require(t.id).state === 'on_hold';
      },
      '시작 실패 보류',
      30_000,
    );
    expect(e.ctx.store.tasks.require(t.id).hold.reasons.map((x) => x.note)).toEqual(['턴 시작 3회 실패: 모델 이름을 찾을 수 없습니다 (시험)']);
    // 출구는 시작하지 못한 팀원을 ID로, 검수자인지 담당인지도 적는다 (리드 결정 S5-28)
    const failing = which === 'review' ? e.qaId : e.devId;
    const who = `${which === 'review' ? '검수자' : '담당 팀원'} ${e.ctx.store.members.require(failing).name}(${failing})의 AI를`;
    expectAlert(e, alertKey('start-fail', t.id), { calls: [`${who} set_member_ai(member_id="${failing}", …)로 고친 뒤 resume_task(task_id="${t.id}", reason="…")`] });
    expect(notices(e, '업무 시작 실패').map((n) => n.body.endsWith(`작업을 보류하고 ${HANDED}`))).toEqual([true]);
  });

  it('10. 다시 판정 실패 — alert rejudge-stuck, 두 길(긴급 지시 뒤 재개·지시 없이 재개)', async () => {
    const e = (env = await bootOrch());
    const t = passedRepo(e);
    e.ctx.store.kv.set(`rejudgewait:${t.id}`, { reviewId: 'RV-0001', reviewerId: e.qaId, since: e.ctx.now() });
    e.core.tasks.holdRejudgeStuck(t.id, '비정상 종료', 3);
    expectAlert(e, alertKey('rejudge-stuck', t.id), { calls: [`instruct_member(member_id="${e.qaId}", text="…", urgent=true)`, '지시 없이'] });
    expect(notices(e, '다시 판정 실패')[0]!.body).toContain(`정하도록 ${HANDED}`);
  });

  it('11. 복구 확인 — 작업이 있으면 보류(recovery_check)와 alert recovery:<요청 ID>, 없으면 보류 없이 main:general로. 글에 recovery_id, 대표 할 일 recovery_check의 reachesMain 참 → resolve_recovery 뒤 끝난 일', async () => {
    const e = (env = await bootOrch());
    const t = waitingTask(e);
    const exec = (requestId: string, taskId: string | null, projectId: string | null): ExecRecord => {
      const x: ExecRecord = { requestId, kind: 'deploy', projectId, taskId, cwd: e.projectDir, command: '배포 스크립트', target: '배포', state: 'unknown', startedAt: e.ctx.now(), endedAt: e.ctx.now(), result: { recovered: '실행 여부를 확인할 수 없음 (시험)' } };
      e.ctx.store.execs.insert(x);
      return x;
    };
    const recovery = e.core.recovery as unknown as { holdForRecovery(x: ExecRecord, note: string): number };
    recovery.holdForRecovery(exec('X-1001', t.id, e.projectId), '외부 실행이 끝났는지 확인할 수 없습니다 (시험)');
    recovery.holdForRecovery(exec('X-1002', null, null), '외부 실행이 끝났는지 확인할 수 없습니다 (시험)');
    expect(e.ctx.store.tasks.require(t.id).hold.reasons.map((r) => [r.kind, r.refId])).toEqual([['recovery_check', 'X-1001']]);
    const a = expectAlert(e, alertKey('recovery', 'X-1001'), { calls: ['resolve_recovery(recovery_id="X-1001"', 'resume_task로는 복구 확인 보류가 풀리지 않습니다'] });
    expectAlert(e, alertKey('recovery', 'X-1002'), { sessionKey: mainKey(null), calls: ['resolve_recovery(recovery_id="X-1002"'] });
    expect(notices(e, '복구 확인 필요').map((n) => n.body.endsWith(HANDED))).toEqual([true, true]);
    const todos = (await e.invoke('snapshot.get')).ownerTodos.flatMap((x) => (x.kind === 'recovery_check' ? [[x.requestId, x.reachesMain]] : []));
    expect(todos.sort()).toEqual([
      ['X-1001', true],
      ['X-1002', true],
    ]);
    expect(holdReach(e, t.id)).toEqual([['recovery_check', true]]);
    // 메인이 아직 받지 않은(대기 중인) 그 알림 — resolve_recovery는 한 번 거부하고 그 글을 보여 준 뒤 다시 부르면 처리한다 (리드 결정 S5-50)
    const refused = await tryMain(e, 'resolve_recovery', { recovery_id: 'X-1001', action: 'retry' });
    expect(refused.refused?.code).toBe('conflict');
    expect(refused.refused!.message).toContain(`- 알림 ${a.id} (복구 확인 X-1001)`);
    expect(e.ctx.store.execs.require('X-1001').state).toBe('unknown');
    await e.main('resolve_recovery', { recovery_id: 'X-1001', action: 'retry' });
    expect(deadWorkReason(e.ctx, e.ctx.store.queue.require(a.id))).toBe('복구 확인 X-1001이(가) 이미 처리됨');
    // 도구 설명은 ID를 대표가 알려 준다고 하지 않는다 — 알림 글과 현황에 있다 (리드 결정 S5-8)
    const spec = TOOL_SPECS.find((x) => x.name === 'resolve_recovery')!;
    expect(spec.description).not.toContain('대표가 명령으로 알려');
    expect(spec.description).toContain('get_overview의 메인이 할 일(main.recovery)');
  });

  it('12. 작업 세션의 재시작 상한 보류 — alert crash', async () => {
    const e = (env = await bootOrch());
    const t = waitingTask(e);
    e.core.turns.restartLimitHold({ id: 'U-9001', memberId: e.devId } as Turn, t);
    expectAlert(e, alertKey('crash', t.id), { head: '재시작 상한' });
    expect(notices(e, '자동 복구 실패').map((n) => n.body.endsWith(`작업을 보류하고 ${HANDED}`))).toEqual([true]);
  });

  it('13. 작업 턴의 비정상 종료 상한 보류 — alert crash, 글이 재개하면 재시작 횟수를 다시 센다고 적는다', async () => {
    const e = (env = await bootOrch());
    const t = waitingTask(e);
    e.script.set(taskKey(t.id), (p) => p.exit(1));
    e.hold.add(mainKey(e.projectId));
    await waitFor(
      () => {
        if (e.core.turns.count() === 0 || !e.liveProc(taskKey(t.id))) e.tick();
        return e.ctx.store.tasks.require(t.id).state === 'on_hold';
      },
      '비정상 종료 상한 보류',
      30_000,
    );
    expectAlert(e, alertKey('crash', t.id), { calls: ['자동 재시작 횟수를 처음부터 다시 셉니다'] });
  });

  it('14. 작업 턴의 CLI 안전 검사 거부 — alert cli-refusal (보류한 뒤 알림)', async () => {
    const e = (env = await bootOrch({ mock: false }));
    const t = waitingTask(e);
    e.script.set(taskKey(t.id), (p) => {
      p.emit({ kind: 'session', text: 'init', data: { permissionMode: 'bypassPermissions' } });
      p.emit({ kind: 'error', text: 'rm -rf "$OUT"/* — 안전 검사 거부', data: { errorKind: 'permission' } });
    });
    await waitFor(
      () => {
        e.tick();
        return e.ctx.store.tasks.require(t.id).state === 'on_hold' && e.core.turns.count() === 0;
      },
      'CLI 안전 검사 거부 보류',
      60_000,
    );
    // 출구는 거부된 명령을 낸 담당 팀원을 ID로 적는다 (리드 결정 S5-28)
    expectAlert(e, alertKey('cli-refusal', t.id), { calls: [`담당 팀원 ${e.ctx.store.members.require(e.devId).name}(${e.devId})에게 instruct_member(member_id="${e.devId}", text="…")로`] });
    expect(notices(e, 'CLI 안전 검사 거부').map((n) => n.body.endsWith(`작업을 보류하고 ${HANDED}`))).toEqual([true]);
  });

  it('15. 작업 공간 생성 실패(일반 작업) — 보류(돌아갈 상태 대기)와 alert ws-fail', async () => {
    const e = (env = await bootOrch());
    const t = waitingTask(e);
    vi.spyOn(e.core.tasks, 'ensureWorkspace').mockRejectedValue(new Error('디스크가 가득 찼습니다 (시험)'));
    expect(await e.core.tasks.activateForLaunch(t.id)).toBe(false);
    expect(e.ctx.store.tasks.require(t.id).hold.returnState).toBe('waiting');
    expectAlert(e, alertKey('ws-fail', t.id), { calls: ['작업 공간을 다시 만들고 시작합니다'] });
    expect(notices(e, '작업 공간 생성 실패').map((n) => n.body)).toEqual([`${t.id}: 디스크가 가득 찼습니다 (시험) — 작업을 보류하고 ${HANDED}`]);
  });

  it('16. 검수 제출 처리 실패 — alert submit-fail', async () => {
    const e = (env = await bootOrch());
    const t = waitingTask(e);
    vi.spyOn(e.core.tasks as unknown as { processSubmissionInner(id: string): Promise<void> }, 'processSubmissionInner').mockRejectedValue(new Error('최신 main 반영 실패 (시험)'));
    await e.core.tasks.processSubmission(t.id);
    expectAlert(e, alertKey('submit-fail', t.id), { calls: ['제출 처리를 다시 합니다'] });
    expect(notices(e, '검수 제출 처리 실패').map((n) => n.body)).toEqual([`${t.id}: 최신 main 반영 실패 (시험) — 작업을 보류하고 ${HANDED}`]);
  });

  it('17. 작업 취소 실패(중간 결과 보관 실패) — 취소 처리 중 보류 그대로 alert cancel-fail, 출구는 cancel_task를 다시(resume_task가 아니다)', async () => {
    const e = (env = await bootOrch());
    const t = waitingTask(e);
    vi.spyOn(e.core.tasks, 'archiveWorkspace').mockRejectedValue(new Error('보관 폴더를 쓸 수 없습니다 (시험)'));
    await expect(e.core.tasks.cancel(t.id, '시험 취소', MAIN_AGENT_ID)).rejects.toThrow('보관 폴더를 쓸 수 없습니다');
    expect(e.ctx.store.tasks.require(t.id).hold.reasons.map((r) => [r.kind, r.refId])).toEqual([['interrupted', 'cancel']]);
    expectAlert(e, alertKey('cancel-fail', t.id), { calls: [`cancel_task(task_id="${t.id}", reason="…")를 다시 부르세요`, 'resume_task는 이 취소 보류를 풀어 작업을 되살리므로'] });
    expect(holdReach(e, t.id)).toEqual([['interrupted', true]]);
  });

  it('18. 프로듀서가 맡아서도 풀지 못한 병합 충돌(GIT-07) — 재계획 보류, alert conflict-stuck(resume_task로는 풀리지 않음)', async () => {
    const e = (env = await bootOrch());
    const t = waitingTask(e);
    e.ctx.store.tasks.patch(t.id, { state: 'in_progress', conflict: { files: ['shared.txt'], since: e.ctx.now(), resolverId: null, spinHolds: 1 } });
    e.core.turns.spinHold(e.ctx.store.tasks.require(t.id), '진척 없는 자동 재개 3회');
    expectAlert(e, alertKey('conflict-stuck', t.id), { calls: ['resume_task로는 재계획 보류가 풀리지 않습니다', 'replace_producer'] });
    expect(notices(e, '병합 충돌 해결 실패').map((n) => n.body.includes(HANDED))).toEqual([true]);
    expect(holdReach(e, t.id)).toEqual([['replan', true]]);
  });

  it('19. 계획 지연(재촉 상한) — alert plan-stuck, 같은 지연에는 한 번: 메인이 받아 마친 뒤 같은 지연이 다시 상한이면 결정 32의 문장 (리드 결정 S5-26 — 회차가 아니라 지연마다, 다른 지연은 아래 S5-26 묶음)', async () => {
    const e = (env = await bootOrch());
    const d = seedDirective(e, '계획 지시');
    e.ctx.store.directives.put({ ...e.ctx.store.directives.require(d.id), state: 'planning' });
    // 그 지연의 마지막 재촉(실은 계획 항목)을 만든 때
    const stall = e.ctx.now();
    e.core.directives.afterPlanTurn(d.id, 2, stall);
    const q = expectAlert(e, alertKey('plan-stuck', d.id), { calls: [`cancel_directive(directive_id="${d.id}", reason="…")`, 'instruct_member'] });
    expect(notices(e, '계획 지연').map((n) => n.body)).toEqual([`${d.id} 계획 지시 — 프로듀서가 작업을 만들지 못했습니다. ${HANDED}`]);
    markDone(e, q);
    e.core.directives.afterPlanTurn(d.id, 2, stall);
    expect(alerts(e, alertKey('plan-stuck', d.id))).toHaveLength(1);
    expect(notices(e, '계획 지연').map((n) => n.body)).toEqual([`${d.id} 계획 지시 — 프로듀서가 작업을 만들지 못했습니다. 어떻게 할지 ${TELL}`]);
  });

  it('20. 보고서 작성 지연은 대표에게만 — 메인이 이미 세 번 받은 일이라 알림 업무를 만들지 않는다', async () => {
    const e = (env = await bootOrch());
    const d = seedDirective(e);
    e.ctx.store.directives.put({ ...e.ctx.store.directives.require(d.id), state: 'reporting' });
    enqueue(e.ctx, { kind: 'main_report', memberId: MAIN_AGENT_ID, sessionKey: mainKey(e.projectId), projectId: e.projectId, directiveId: d.id, priority: 'high', deliveries: 2, message: '보고서를 내세요' });
    await e.drain(2);
    expect(notices(e, '보고서 작성 지연').map((n) => n.body.endsWith(`어떻게 할지 ${TELL}`))).toEqual([true]);
    expect(keys(e)).toEqual([]);
  });

  it('21. 프로듀서 처리 지연(재촉 상한) — alert producer-stuck:<지시>:<종류>', async () => {
    const e = (env = await bootOrch());
    const d = seedDirective(e);
    const t = seedInReviewTask(e, e.qaId, { directiveId: d.id });
    e.core.tasks.askProducer(e.ctx.store.tasks.require(t.id), e.ctx.store.members.require(e.devId), '어느 API를 쓰나요?', taskKey(t.id));
    for (const q of e.ctx.store.queue.list({ ref2: directiveKey(d.id), state: 'queued' })) e.ctx.store.queue.put({ ...q, deliveries: 2 });
    await e.drain(2);
    expectAlert(e, alertKey('producer-stuck', `${d.id}:answer`), { calls: ['answer_question', 'replace_producer'] });
    expect(notices(e, '프로듀서 처리 지연').map((n) => n.body.endsWith(HANDED))).toEqual([true]);
  });

  it('22. 시작 실패로 버린 검수자 없음 — 한 번 더 넘기고(alert handover-dropped), 그 알림도 버리면 대표에게 결정 32로 끝 — 더 돌지 않는다', async () => {
    const e = (env = await bootOrch());
    await e.internal('members.remove', e.qaId);
    const key = mainKey(e.projectId);
    const t = seedInReviewTask(e, MAIN_AGENT_ID, { outputMode: 'repo' });
    e.ctx.store.tasks.patch(t.id, { assigneeId: e.producerId, contributors: [e.producerId, MAIN_AGENT_ID] });
    e.prepareHook = (_launch, who) => {
      if (who.sessionKey === key) throw new Error('메인 모델을 찾을 수 없습니다 (시험)');
    };
    e.core.tasks.dispatchReview(e.ctx.store.tasks.require(t.id));
    await waitFor(
      () => {
        if (e.core.turns.count() === 0) e.tick();
        return alerts(e).length > 0 && alerts(e).every((q) => q.state === 'cancelled') && e.core.turns.count() === 0;
      },
      '넘김과 다시 넘긴 알림이 시작 실패로 버려짐',
      40_000,
    );
    await ticks(e, 5);
    const nr = e.ctx.store.queue.list({ ref2: key }).filter((q) => q.kind === 'no_reviewer').at(-1)!;
    expect(keys(e)).toEqual([alertKey('handover-dropped', nr.id)]);
    const bodies = notices(e, '업무 시작 실패').map((n) => n.body);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toContain(`메인 에이전트에게 다시 넘긴 보류 작업: 검수자 없음 ${t.id}`);
    expect(bodies[1]).toContain('메인 에이전트에게 전하지 못한 보류 작업: 전하지 못한 보류 넘김');
    expect(live(e)).toEqual([]);
    expect(await todoReach(e, t.id)).toEqual([false]);
  });

  it('23. 재시작 상한에서 버린 팀원 업무는 메인에게 한 번(alert restart-dropped), 메인 세션 일은 넘기지 않는다(리드 결정 44의 고리 막기)', async () => {
    const e = (env = await bootOrch());
    const d = seedDirective(e);
    const t = seedInReviewTask(e, e.qaId, { directiveId: d.id });
    e.core.tasks.askProducer(e.ctx.store.tasks.require(t.id), e.ctx.store.members.require(e.devId), '어느 API를 쓰나요?', taskKey(t.id));
    const ans = e.ctx.store.queue.list({ ref2: directiveKey(d.id) }).find((q) => q.kind === 'answer')!;
    const cut = { ...ans, state: 'cancelled' as const, restarts: 3, doneAt: e.ctx.now() };
    e.ctx.store.queue.put(cut);
    e.core.turns.restartLimitReached({ id: 'U-9101', memberId: e.producerId, sessionKind: 'directive', directiveId: d.id, projectId: e.projectId } as Turn, [cut]);
    expectAlert(e, alertKey('restart-dropped', ans.id), { calls: ['answer_question으로 답하라고'] });
    expect(notices(e, '자동 복구 실패').map((n) => n.body.endsWith(`그 일을 ${HANDED}`))).toEqual([true]);
    // 메인 세션 일(대표 명령)을 재시작 상한에서 버리면 알림 업무가 없다
    const cmd = enqueue(e.ctx, { kind: 'main_command', memberId: MAIN_AGENT_ID, sessionKey: mainKey(e.projectId), projectId: e.projectId, message: '대표 명령 (시험):\n로그인 화면을 만들어 줘' });
    const cutCmd = { ...cmd, state: 'cancelled' as const, restarts: 3, doneAt: e.ctx.now() };
    e.ctx.store.queue.put(cutCmd);
    e.core.turns.restartLimitReached({ id: 'U-9102', memberId: MAIN_AGENT_ID, sessionKind: 'main_project', directiveId: null, projectId: null } as Turn, [cutCmd]);
    expect(keys(e)).toEqual([alertKey('restart-dropped', ans.id)]);
  });

  it('24. 재개 업무를 대표에게 넘긴 뒤 일시정지된 팀원에게 새 업무가 오면 스케줄러가 한 번 알린다 (alert member-paused, 리드 결정 35)', async () => {
    const e = (env = await bootOrch());
    await e.core.stops.pauseMember(e.producerId, 'graceful', 'system', '프로세스 종료를 확인하지 못함 (시험)');
    e.core.turns.handPauseToMain(e.producerId, null);
    const item = e.ctx.store.queue.list({ ref1: MAIN_AGENT_ID, state: 'queued' }).find((q) => q.pausedMemberId === e.producerId)!;
    const d = seedDirective(e);
    enqueue(e.ctx, { kind: 'reviewer_assign', memberId: e.producerId, sessionKey: directiveKey(d.id), projectId: e.projectId, directiveId: d.id, message: '검수자를 정하세요' });
    // 재개 업무가 살아 있으면 알리지 않는다
    e.core.turns.alertPausedMembers();
    expect(keys(e)).toEqual([]);
    // 세 번 넘겨도 그대로 → 대표에게 넘김(pause-stuck) → 그 뒤 새 업무
    e.core.turns.giveUpStanding(item);
    expect(e.ctx.store.notifications.list({ ref1: `pause-stuck:${e.producerId}` })).toHaveLength(1);
    e.core.turns.alertPausedMembers();
    expect(keys(e)).toEqual([]); // 넘긴 뒤에 온 업무가 없다
    await sleep(5);
    enqueue(e.ctx, { kind: 'answer', memberId: e.producerId, sessionKey: directiveKey(d.id), projectId: e.projectId, directiveId: d.id, message: '질문에 답하세요' });
    // 스케줄러의 틱이 본다
    e.hold.add(mainKey(e.projectId));
    e.tick();
    const q = expectAlert(e, alertKey('member-paused', e.producerId), { calls: [`resume_member(member_id="${e.producerId}", reason="…")`, '질문 응답'] });
    // 한 번만: 대기 중이면 그것, 받아 마친 뒤에도 같은 넘김에는 다시 넣지 않는다
    e.core.turns.alertPausedMembers();
    markDone(e, q);
    enqueue(e.ctx, { kind: 'plan', memberId: e.producerId, sessionKey: directiveKey(d.id), projectId: e.projectId, directiveId: d.id, message: '계획하세요' });
    e.core.turns.alertPausedMembers();
    expect(keys(e)).toEqual([alertKey('member-paused', e.producerId)]);
    // 재개하면 끝난 일
    await e.main('resume_member', { member_id: e.producerId });
    expect(deadWorkReason(e.ctx, e.ctx.store.queue.require(q.id))).not.toBeNull();
  });

  it('25·legacy. 1단계 전 대표가 건 팀원 정지와 대표가 중단한 작업 — 시작 때 훑기가 한 번 알린다(legacy-pause·legacy-hold), 다시 불러도 같다', async () => {
    const e = (env = await bootOrch());
    const s = e.ctx.stop();
    e.ctx.saveStop({ ...s, members: { ...s.members, [e.devId]: { paused: true, mode: 'graceful', by: 'owner', since: e.ctx.now() } } });
    const t = waitingTask(e);
    e.core.tasks.hold(t.id, 'interrupted', 'task', '대표 중단', 'owner');
    e.core.recovery.reconcileManagement();
    expectAlert(e, alertKey('legacy-pause', e.devId), { calls: [`resume_member(member_id="${e.devId}", reason="…")`] });
    expectAlert(e, alertKey('legacy-hold', t.id), { calls: ['대표는 이제 이 보류를 풀 수 없습니다', `resume_task(task_id="${t.id}", reason="…")`] });
    e.core.recovery.reconcileManagement();
    for (const q of alerts(e)) markDone(e, q);
    e.core.recovery.reconcileManagement();
    expect(keys(e).sort()).toEqual([alertKey('legacy-hold', t.id), alertKey('legacy-pause', e.devId)].sort());
  });

  it('26. 메인이 직접 중단한 검수 작업(돌아갈 상태 검수)이 resume_task 없이 그 턴에서 끝나면 한 번 알린다 (alert interrupted-review, 리드 결정 42)', async () => {
    const e = (env = await bootOrch());
    const key = mainKey(e.projectId);
    const t = seedInReviewTask(e, e.qaId, { outputMode: 'repo' });
    e.hold.add(key);
    (e.core.turns as unknown as { handReviewToMain(t: Task, d: string, p: string | null, c: { producer: string }): void }).handReviewToMain(e.ctx.store.tasks.require(t.id), t.directiveId, e.projectId, { producer: '시험' });
    e.tick();
    await waitFor(() => !!e.liveProc(key, MAIN_AGENT_ID), '넘김을 실은 메인 턴');
    await e.main('interrupt_task', { task_id: t.id, then: 'hold' });
    e.liveProc(key, MAIN_AGENT_ID)!.finishOk();
    await e.idle();
    expectAlert(e, alertKey('interrupted-review', t.id), { calls: [`resume_task(task_id="${t.id}", reason="…")`, 'assign_reviewer'] });
    expect(holdReach(e, t.id)).toEqual([['interrupted', true]]);
  });

  it('27a·27b. 이미 일시정지된 팀원의 종료 확인 실패 — 살아 있는 재개 업무가 있으면 결정 26의 글, 없으면(메인이 건 정지) alert kill-failed:<팀원>과 넘긴 사실', async () => {
    const e = (env = await bootOrch());
    const d = seedDirective(e);
    const run = (label: string) =>
      e.core.turns.blockUnconfirmedRun(
        { label, sessionKind: 'directive', sessionKey: directiveKey(d.id), memberId: e.producerId, projectId: e.projectId, taskId: null, turnId: null },
        { envProblem: null, remaining: 1, cause: null, what: '이전 실행' },
      );
    // 27b: 프로그램이 건 정지 + 살아 있는 재개 업무 → 그 글이 참
    await e.core.stops.pauseMember(e.producerId, 'graceful', 'system', '프로세스 종료를 확인하지 못함 (시험)');
    e.core.turns.handPauseToMain(e.producerId, null);
    expect(await run('첫 실행')).toContain('메인 에이전트가 다시 이어 갑니다');
    expect(keys(e)).toEqual([]);
    // 27a: 메인이 직접 건 정지 — 재개 업무가 없다 → 알림 업무. 먼저 27b의 정지를 푼다 — 그 재개 업무를 메인이 아직 받지 않아(대기 중) 첫 resume_member는 한 번
    // 거부하고 그 글을 보여 준다. 다시 부르면 재개한다 (리드 결정 S5-50)
    expect((await tryMain(e, 'resume_member', { member_id: e.producerId })).refused?.code).toBe('conflict');
    await e.main('resume_member', { member_id: e.producerId });
    await e.main('pause_member', { member_id: e.producerId, mode: 'graceful' });
    const note = await run('둘째 실행');
    expect(note).toContain(`팀원 일시정지는 그대로 두고 ${HANDED}`);
    expect(note).not.toContain('메인 에이전트가 다시 이어 갑니다');
    expectAlert(e, alertKey('kill-failed', e.producerId), { calls: [`resume_member(member_id="${e.producerId}", reason="…")`] });
    expect(e.ctx.stop().members[e.producerId]).toMatchObject({ paused: true, by: MAIN_AGENT_ID });
  });

  it('28. 메인 에이전트도 assign_reviewer를 쓴다 — 사유가 없으면 거부, 프로듀서가 아닌 팀원은 거부 (리드 결정 48·S5-11)', async () => {
    const e = (env = await bootOrch());
    const t = seedInReviewTask(e, MAIN_AGENT_ID, { outputMode: 'repo' });
    await expect(e.main('assign_reviewer', { task_id: t.id, reviewer_id: e.qaId, reason: '' })).rejects.toMatchObject({ code: 'invalid' });
    expect(await e.main('assign_reviewer', { task_id: t.id, reviewer_id: e.qaId, reason: '검수 팀원으로 바꿈' })).toMatchObject({ taskId: t.id, reviewerId: e.qaId });
    expect(e.ctx.store.tasks.require(t.id).reviewerId).toBe(e.qaId);
    const dev: TokenIdentity = { turnId: 'TN-dev', sessionId: 'S-dev', sessionKey: taskKey(t.id), sessionKind: 'task', memberId: e.devId, projectId: e.projectId, isMain: false, isProducer: false, canReview: false };
    expect(await e.core.tools.handle(dev, 'assign_reviewer', { task_id: t.id, reviewer_id: e.qaId })).toMatchObject({ ok: false, code: 'forbidden' });
  });

  it('추가: 전달하지 못한 긴급 지시 — 보낸 메인에게 한 번 알린다 (alert urgent-undelivered:<메시지·항목>)', async () => {
    const e = (env = await bootOrch());
    const t = waitingTask(e);
    // 메인 에이전트의 긴급 지시 항목 (그 작업 세션) — 받을 일이 끝나 전달하지 못하고 대기열에서 빠진다 (records.noteMessagesUndelivered)
    const q = enqueue(e.ctx, { kind: 'message', memberId: e.devId, sessionKey: taskKey(t.id), projectId: e.projectId, taskId: t.id, urgent: true, message: '로그인 문구를 존댓말로 바꿔 주세요' });
    cancelQueued(e.ctx, (x) => x.id === q.id, '받을 작업이 취소됨 (시험)');
    expectAlert(e, alertKey('urgent-undelivered', q.id), { calls: [`instruct_member(member_id="${e.devId}", text="…", urgent=true)`, '로그인 문구를 존댓말로', '받을 작업이 취소됨 (시험)'] });
    expect(notices(e, '긴급 지시 전달 못 함').map((n) => n.body)).toEqual([
      `메인 에이전트가 ${e.ctx.store.members.require(e.devId).name}에게 보낸 긴급 지시("로그인 문구를 존댓말로 바꿔 주세요")를 전달하지 못했습니다 — 받을 작업이 취소됨 (시험). ${HANDED}`,
    ]);
    // 같은 지시를 다시 놓쳐도(같은 항목) 한 번만
    cancelQueued(e.ctx, (x) => x.id === q.id, '다시 (시험)');
    expect(alerts(e)).toHaveLength(1);
  });

  it("추가: '병합 기록 확인 필요'는 메인 업무 없이 대표에게 출구를 적는다 (main에는 이미 반영 — 다음 시작·보류 해제가 마무리)", async () => {
    const e = (env = await bootOrch());
    const t = passedRepo(e);
    e.ctx.store.tasks.patch(t.id, { merge: { requestId: '-', taskCommitSha: 'a'.repeat(40), preMainSha: 'b'.repeat(40), mergeCommitSha: 'c'.repeat(40), mergedAt: e.ctx.now() } });
    (e.core.merges as unknown as { mergeFailed(id: string, err: unknown): void }).mergeFailed(t.id, new Error('마무리 오류 (시험)'));
    expect(notices(e, '병합 기록 확인 필요').map((n) => n.body)).toEqual([
      `${t.id}: main에는 병합됐지만 마무리 중 오류가 났습니다: 마무리 오류 (시험) — 다음 시작 때 기록대로 다시 마무리합니다(다시 병합하지 않음). 서둘러야 하면 명령창으로 메인 에이전트에게 알려 주세요 — 메인 에이전트가 그 작업을 중단한 뒤 다시 이어 가면 바로 마무리합니다`,
    ]);
    expect(keys(e)).toEqual([]);
  });
});

describe('공통 규칙 (리드 결정 S5-7)', () => {
  it('같은 일은 한 번 — 대기 중이면 그 항목이 싣는다, 받아 마친 같은 보류에는 다시 넣지 않고 결정 32의 문장, 다음 보류는 새로 알린다', async () => {
    const e = (env = await bootOrch());
    const t = waitingTask(e);
    const block = () =>
      e.core.turns.blockUnconfirmedRun(
        { label: `${t.id} 시험 실행`, sessionKind: 'task', sessionKey: taskKey(t.id), memberId: e.devId, projectId: e.projectId, taskId: t.id, turnId: null },
        { envProblem: null, remaining: 1, cause: null, what: '턴' },
      );
    expect(await block()).toContain(HANDED);
    expect(await block()).toContain(HANDED); // 같은 보류, 대기 중인 그 항목
    expect(alerts(e)).toHaveLength(1);
    markDone(e, alerts(e)[0]!);
    const again = await block();
    expect(again).toContain(`남은 프로세스가 정리되면 ${TELL}`);
    expect(again).not.toContain(HANDED);
    expect(alerts(e)).toHaveLength(1);
    // 메인이 풀고, 같은 작업에 다음 보류가 걸리면 새로 알린다
    await e.main('resume_task', { task_id: t.id });
    await sleep(5);
    expect(await block()).toContain(HANDED);
    expect(alerts(e).map((q) => [q.alertKey, q.state])).toEqual([
      [alertKey('kill-failed', t.id), 'done'],
      [alertKey('kill-failed', t.id), 'queued'],
    ]);
  });

  it('키는 requestId에 두지 않는다 — alertMain이 키·세션·한 번 규칙을 지키고, 모르는 키는 판단하지 않는다', async () => {
    const e = (env = await bootOrch());
    const since = e.ctx.now();
    const a = alertMain(e.ctx, { kind: 'plan-stuck', target: 'D-9999', projectId: null, message: '시험', since });
    expect([a!.alertKey, a!.requestId, a!.sessionKey]).toEqual(['alert:plan-stuck:D-9999', null, mainKey(null)]);
    expect(alertMain(e.ctx, { kind: 'plan-stuck', target: 'D-9999', projectId: null, message: '다시', since })!.id).toBe(a!.id);
    expect(parseAlertKey('alert:producer-stuck:D-0001:answer')).toEqual({ kind: 'producer-stuck', target: 'D-0001:answer' });
    expect(parseAlertKey('alert:nope:X')).toBeNull();
  });

  it('시작 때 훑기 — 알림이 없는 보류·복구 항목에 알림을 만들고 다시 불러도 같다. 상한에서 버린 알림은 다시 만들지 않는다. 검수자 없음·긴급 정지 보류는 만들지 않는다', async () => {
    const e = (env = await bootOrch());
    const a = waitingTask(e, '가');
    const b = waitingTask(e, '나');
    const c = seedInReviewTask(e, e.qaId);
    // 5단계 전처럼 알림 없이 건 보류 (사유 글로 종류를 고른다)
    e.core.tasks.hold(a.id, 'error', 'task', '턴 시작 3회 실패: 모델 이름 (시험)', 'system');
    e.core.tasks.hold(b.id, 'merge_blocked', 'task', '프로젝트 폴더에 커밋되지 않은 변경이 있어 병합 보류', 'system');
    e.core.tasks.hold(c.id, 'error', 'task', '검수자 없음 (시험)', 'system', 'no_reviewer', 'in_review');
    e.ctx.store.execs.insert({ requestId: 'X-2001', kind: 'deploy', projectId: e.projectId, taskId: null, cwd: e.projectDir, command: '배포', target: '배포', state: 'unknown', startedAt: e.ctx.now(), endedAt: e.ctx.now(), result: {} });
    sweepAlerts(e.ctx);
    expect(keys(e).sort()).toEqual([alertKey('merge-dirty', b.id), alertKey('recovery', 'X-2001'), alertKey('start-fail', a.id)].sort());
    // 5단계 전 보류에는 넣는 곳의 기록이 없다 — 시작 실패의 팀원은 작업에서 고른다(검수로 돌아갈 보류가 아니면 담당 팀원, 리드 결정 S5-28)
    const sa = alerts(e, alertKey('start-fail', a.id))[0]!.message;
    expect(sa.split('\n')[0]).toBe(`${a.id} "가" — 시작 때 확인: 메인 에이전트에게 알리지 않은 채 남은 보류(업무 시작 실패)`);
    expect(sa).toContain(`담당 팀원 ${e.ctx.store.members.require(e.devId).name}(${e.devId})의 AI를 set_member_ai(member_id="${e.devId}", …)로 고친 뒤`);
    sweepAlerts(e.ctx);
    expect(alerts(e)).toHaveLength(3);
    // 버린 알림(취소)은 다시 만들지 않는다 — 그 보류가 걸린 뒤 같은 키로 넣었다
    const qa = alerts(e, alertKey('start-fail', a.id))[0]!;
    e.ctx.store.queue.put({ ...qa, state: 'cancelled', doneAt: e.ctx.now() });
    e.core.recovery.reconcileManagement();
    expect(alerts(e)).toHaveLength(3);
    expect(await todoReach(e, a.id)).toEqual([false]);
    expect(await todoReach(e, c.id)).toEqual([false]);
  });

  it('상한에서 버린 알림 업무는 결정 43의 길로 알리고 다시 넣지 않는다 — reachesMain 거짓, 돌지 않음', async () => {
    const e = (env = await bootOrch());
    const key = mainKey(e.projectId);
    const t = waitingTask(e);
    e.script.set(key, (p) => p.exit(1));
    (e.core.merges as unknown as { revertFailed(id: string, err: unknown): void }).revertFailed(t.id, new Error('시험 오류'));
    expect(await todoReach(e, t.id)).toEqual([true]);
    await waitFor(
      () => {
        e.tick();
        return alerts(e).every((q) => q.state !== 'queued' && q.state !== 'running') && e.core.turns.count() === 0 && notices(e, '자동 복구 실패').length > 0;
      },
      '알림 업무가 비정상 종료 상한에서 버려짐',
      40_000,
    );
    await ticks(e, 5);
    const last = alerts(e).at(-1)!;
    expect([last.state, last.attempts]).toEqual(['cancelled', 2]);
    const n = notices(e, '자동 복구 실패');
    expect(n.map((x) => x.key)).toEqual([`crash:${key}:${last.id}`]);
    expect(n[0]!.body).toContain(`메인 에이전트에게 전하지 못한 보류 작업: 되돌리기 실패 — ${t.id} "로그인 화면" — `);
    expect(n[0]!.body.endsWith(`어떻게 할지 ${TELL}`)).toBe(true);
    expect([...new Set(alerts(e).map((q) => q.alertKey))]).toEqual([alertKey('revert-fail', t.id)]);
    expect(live(e)).toEqual([]);
    expect(await todoReach(e, t.id)).toEqual([false]);
    // 시작 때 훑기도 다시 만들지 않는다
    e.core.recovery.reconcileManagement();
    expect(live(e)).toEqual([]);
  });

  it('한 프로젝트의 알림은 한 메인 턴에 실린다 — 긴급 정지에 막히고 정지 해제 뒤에 전달되며, 긴급 정지 보류는 알림이 아니다 (리드 결정 S5-7·S5-10)', async () => {
    const e = (env = await bootOrch());
    const key = mainKey(e.projectId);
    const a = waitingTask(e, '가');
    const b = waitingTask(e, '나');
    await e.invoke('stop.emergency');
    for (const t of [a, b]) (e.core.merges as unknown as { revertFailed(id: string, err: unknown): void }).revertFailed(t.id, new Error('시험 오류'));
    await ticks(e, 3);
    expect(e.launches.filter((l) => l.workKey === key)).toEqual([]);
    expect(keys(e).sort()).toEqual([alertKey('revert-fail', a.id), alertKey('revert-fail', b.id)].sort());
    e.hold.add(key);
    await e.invoke('stop.release');
    await waitFor(
      () => {
        if (!e.liveProc(key, MAIN_AGENT_ID)) e.tick();
        return !!e.liveProc(key, MAIN_AGENT_ID);
      },
      '알림 둘을 실은 메인 턴',
    );
    const launch = e.launches.filter((l) => l.workKey === key).at(-1)!;
    expect(launch.message.match(/### \d+\. 보류·실패 처리/g)).toHaveLength(2);
    // 업무 종류 안내 (get_work_context instructions — INSTRUCTION.alert)
    const ctxRes = await e.tool(launch.turnId, 'get_work_context');
    if (!ctxRes.ok) throw new Error(`get_work_context 실패: ${ctxRes.message}`);
    expect(String((ctxRes.data as { instructions?: string }).instructions)).toContain('보류·실패 처리: 대표에게만 알림이 가던 보류·실패를 넘겨받았습니다');
    // 긴급 정지 보류는 알림 업무가 아니다 (정지 해제 목록이 그 일)
    expect(alerts(e).some((q) => parseAlertKey(q.alertKey)?.target === 'emergency')).toBe(false);
    e.liveProc(key, MAIN_AGENT_ID)!.finishOk('처리 결과');
    await e.idle();
    // 메인의 답은 대표 대화에 붙는다
    expect(e.ctx.store.conversation.list({ ref1: e.projectId }).some((m) => m.role === 'main_agent' && m.text.includes('처리 결과'))).toBe(true);
  });
});

/** 병합 실패 (merges.mergeFailed — 보류 뒤 알림) */
const mergeFailed = (e: OrchEnv, taskId: string, err: string) => (e.core.merges as unknown as { mergeFailed(id: string, err: unknown): void }).mergeFailed(taskId, new Error(err));
/** 작업 턴의 종료 확인 실패(CTL-11) — 남은 하위 프로세스 remaining개. 대표 알림 글을 돌려준다 */
const blockTask = (e: OrchEnv, t: Task, remaining: number) =>
  e.core.turns.blockUnconfirmedRun(
    { label: `${t.id} 시험 실행`, sessionKind: 'task', sessionKey: taskKey(t.id), memberId: e.devId, projectId: e.projectId, taskId: t.id, turnId: null },
    { envProblem: null, remaining, cause: null, what: '턴' },
  );
/** 그 알림 업무를 실은 메인 턴이 도는 중으로 둔다 */
const markRunning = (e: Ctxish, q: QueueEntry) => e.ctx.store.queue.put({ ...e.ctx.store.queue.require(q.id), state: 'running' });

describe('알림 항목 하나는 보류 하나의 것 (리드 결정 S5-25 — S5-7의 중복 막기를 고침)', () => {
  it('앞선 보류의 알림이 실행 중일 때 같은 작업에 새 보류가 걸리면 새 대기 항목 — 대표 알림은 넘긴 사실, 두 항목을 받아 마친 뒤에도 reachesMain 참', async () => {
    const e = (env = await bootOrch());
    const t = passedRepo(e);
    e.hold.add(directiveKey(t.directiveId));
    const key = alertKey('merge-fail', t.id);
    mergeFailed(e, t.id, 'git 오류 1 (시험)');
    const [q1] = alerts(e, key);
    // q1을 실은 메인 턴이 도는 중 — 그 턴에서 메인이 풀고, 턴이 끝나기 전에 병합이 다시 실패한다(새 보류)
    markRunning(e, q1!);
    await e.main('resume_task', { task_id: t.id, reason: '원인 정리됨' });
    expect(e.ctx.store.tasks.require(t.id).state).not.toBe('on_hold');
    await sleep(5);
    e.ctx.store.tasks.patch(t.id, { state: 'in_review' });
    mergeFailed(e, t.id, 'git 오류 2 (시험)');
    const since = e.ctx.store.tasks.require(t.id).hold.reasons.find((r) => r.kind === 'merge_blocked')!.since;
    expect(notices(e, '병합 실패').map((n) => n.body).at(-1)).toBe(`${t.id}: git 오류 2 (시험) — 병합을 보류하고 ${HANDED}`);
    const all = alerts(e, key);
    expect(all.map((q) => [q.id === q1!.id, q.state])).toEqual([
      [true, 'running'],
      [false, 'queued'],
    ]);
    expect(all[1]!.createdAt >= since).toBe(true);
    expect(all[1]!.message).toContain('병합 실패: git 오류 2 (시험)');
    expect(holdReach(e, t.id)).toEqual([['merge_blocked', true]]);
    // 실행 중이던 턴이 끝나도, 새 항목을 받아 마친 뒤에도 그 보류는 메인에게 가 있다
    markDone(e, q1!);
    expect(await todoReach(e, t.id)).toEqual([true]);
    markDone(e, all[1]!);
    expect(holdReach(e, t.id)).toEqual([['merge_blocked', true]]);
    expect(await todoReach(e, t.id)).toEqual([true]);
  });

  it('끝까지: 알림을 실은 메인 턴에서 재개한 작업의 병합이 다시 실패하고 그 턴이 끝나면 새 보류의 글이 다음 메인 턴에 간다', async () => {
    const e = (env = await bootOrch());
    const t = passedRepo(e);
    const key = mainKey(e.projectId);
    const akey = alertKey('merge-fail', t.id);
    e.hold.add(directiveKey(t.directiveId));
    e.hold.add(key);
    mergeFailed(e, t.id, 'git 오류 1 (시험)');
    e.tick();
    await waitFor(() => !!e.liveProc(key, MAIN_AGENT_ID), '알림을 실은 메인 턴');
    const proc = e.liveProc(key, MAIN_AGENT_ID)!;
    expect(alerts(e, akey).map((q) => q.state)).toEqual(['running']);
    await e.main('resume_task', { task_id: t.id, reason: '원인 정리됨' });
    await sleep(5);
    e.ctx.store.tasks.patch(t.id, { state: 'in_review' });
    mergeFailed(e, t.id, 'git 오류 2 (시험)');
    expect(notices(e, '병합 실패').map((n) => n.body).at(-1)).toContain(`병합을 보류하고 ${HANDED}`);
    e.hold.delete(key);
    proc.finishOk('확인함');
    await waitFor(
      () => {
        e.tick();
        return e.launches.filter((l) => l.workKey === key).length === 2 && alerts(e, akey).every((q) => q.state === 'done');
      },
      '새 보류의 알림을 실은 다음 메인 턴',
    );
    const second = e.launches.filter((l) => l.workKey === key)[1]!;
    expect(second.message).toContain('병합 실패: git 오류 2 (시험)');
    expect(second.message).not.toContain('git 오류 1');
    expect(alerts(e, akey)).toHaveLength(2);
    expect(holdReach(e, t.id)).toEqual([['merge_blocked', true]]);
  });

  it('같은 보류를 그 알림이 실행 중일 때 다시 알리면 그 실행 중 항목이 싣는다 — 대표 알림은 넘긴 사실, 새 항목 없음', async () => {
    const e = (env = await bootOrch());
    const t = waitingTask(e);
    expect(await blockTask(e, t, 1)).toContain(HANDED);
    markRunning(e, alerts(e)[0]!);
    expect(await blockTask(e, t, 1)).toContain(HANDED);
    expect(alerts(e).map((q) => q.state)).toEqual(['running']);
  });

  it('종료 확인 실패: 알림 턴에서 재개한 작업에 새 보류가 걸리면 그 보류의 알림이 따로 있다 — 대표 할 일 reachesMain 참', async () => {
    const e = (env = await bootOrch());
    const t = waitingTask(e);
    expect(await blockTask(e, t, 1)).toContain(HANDED);
    const first = alerts(e)[0]!;
    markRunning(e, first);
    await e.main('resume_task', { task_id: t.id });
    await sleep(5);
    expect(await blockTask(e, t, 2)).toContain(`작업을 보류하고 ${HANDED}`);
    const holdSince = e.ctx.store.tasks.require(t.id).hold.reasons.find((r) => r.kind === 'error')!.since;
    expect(holdSince > first.createdAt).toBe(true);
    markDone(e, first);
    const liveNow = live(e);
    expect(liveNow).toHaveLength(1);
    expect(liveNow[0]!.message).toContain('하위 프로세스 2개');
    expect(await todoReach(e, t.id)).toEqual([true]);
  });

  it('앞선 보류의 알림이 아직 대기 중이면 대표 알림 없이 지우고 새 보류의 글로 넣는다 — 대기 항목은 하나, 받아 마친 뒤에도 reachesMain 참', async () => {
    const e = (env = await bootOrch());
    const t = waitingTask(e);
    const key = alertKey('kill-failed', t.id);
    expect(await blockTask(e, t, 1)).toContain(HANDED);
    const [a1] = alerts(e, key);
    // 메인의 resume_task 밖(운영자의 내부 길)에서 풀렸다 — 앞선 알림은 아직 대기 중(스케줄러가 끝난 일로 지우기 전)에 같은 작업에 새 보류가 걸린다. 메인의
    // resume_task는 대기 중인 그 알림을 먼저 보여 주고 받아 마친 것으로 두므로(리드 결정 S5-45) 이 모양은 그 밖의 길에서 생긴다
    await e.internal('tasks.resume', t.id);
    await sleep(5);
    const before = e.ctx.store.notifications.list().length;
    expect(await blockTask(e, t, 2)).toContain(HANDED);
    const all = alerts(e, key);
    expect(all.map((q) => [q.id === a1!.id, q.state])).toEqual([
      [true, 'cancelled'],
      [false, 'queued'],
    ]);
    expect(all[1]!.message).toContain('하위 프로세스 2개');
    expect(all[1]!.message).not.toContain('하위 프로세스 1개');
    // 앞선 보류는 풀렸다 — 그 글을 함께 싣지 않는다 (리드 결정 S5-37: 아직 남은 보류만 싣는다)
    expect(all[1]!.message).not.toContain(ALERT_EARLIER_HEAD);
    // 지운 것은 상한에서 버린 일이 아니다 — 대표에게 버림 알림이 없고(그 보류의 종료 확인 실패 알림 하나만 고쳐 쓴다), 바꾼 사실은 활동 기록에
    expect(e.ctx.store.notifications.list().length).toBe(before);
    expect(e.ctx.store.notifications.list().filter((n) => /전하지 못한|자동 복구 실패|업무 시작 실패/.test(`${n.title} ${n.body}`))).toEqual([]);
    expect(e.ctx.store.activity.search({ text: `앞선 보류를 실은 대기 항목 ${a1!.id}을(를) 지우고 새 보류로 바꿈`, limit: 5 })).toHaveLength(1);
    expect(holdReach(e, t.id)).toEqual([['error', true]]);
    markDone(e, all[1]!);
    expect(holdReach(e, t.id)).toEqual([['error', true]]);
    expect(await todoReach(e, t.id)).toEqual([true]);
  });

  it('앞선 보류의 알림을 실은 턴이 끊겨도 그 항목은 다시 넣지 않는다 — 새 보류의 대기 항목 하나가 싣는다', async () => {
    const e = (env = await bootOrch());
    const key = mainKey(e.projectId);
    const t = waitingTask(e);
    const akey = alertKey('kill-failed', t.id);
    e.hold.add(key);
    await blockTask(e, t, 1);
    e.tick();
    await waitFor(() => !!e.liveProc(key, MAIN_AGENT_ID), '알림을 실은 메인 턴');
    const proc = e.liveProc(key, MAIN_AGENT_ID)!;
    await e.main('resume_task', { task_id: t.id });
    await sleep(5);
    await blockTask(e, t, 2);
    const [old, fresh] = alerts(e, akey);
    expect([old!.state, fresh!.state]).toEqual(['running', 'queued']);
    expect(deadWorkReason(e.ctx, e.ctx.store.queue.require(old!.id))).toBe(`더 새 보류를 실은 같은 알림 ${fresh!.id}이(가) 있음`);
    expect(deadWorkReason(e.ctx, fresh!)).toBeNull();
    // 그 턴이 비정상 종료 — 다시 넣기가 앞선 보류의 항목을 되살리지 않는다
    e.hold.delete(key);
    proc.exit(1);
    await waitFor(
      () => {
        e.tick();
        return alerts(e, akey).every((q) => q.state !== 'queued' && q.state !== 'running') && e.core.turns.count() === 0;
      },
      '새 보류의 알림을 실은 다음 메인 턴',
    );
    expect(alerts(e, akey).map((q) => q.id)).toEqual([old!.id, fresh!.id]);
    const next = e.launches.filter((l) => l.workKey === key)[1]!;
    expect(next.message.match(/### \d+\. 보류·실패 처리/g)).toHaveLength(1);
    expect(next.message).toContain('하위 프로세스 2개');
    expect(next.message).not.toContain('(다시 전달)');
    // 앞선 보류는 그 턴에서 풀렸다 — 버린 앞선 항목의 글을 옮겨 싣지 않는다 (리드 결정 S5-44 2: 그 보류가 아직 남았을 때만)
    expect(next.message).not.toContain(ALERT_EARLIER_HEAD);
    expect(next.message).not.toContain('하위 프로세스 1개');
  });

  // 리드 결정 S5-59 1 (프로브 server-s5fix4-tests-integrity/probes/new/zz-s5f4ti-running-since): 앞선 보류의 도는 항목은 새 보류를 싣지 않는다(S5-25 규칙 1).
  // 작업 보류(join)는 S5-51의 '새 줄만' 항목이 생겨 위 시험이 이 규칙을 가리지 못한다 — join 없는 알림은 앞선 항목을 돌려받으면 새 보류가 아무에게도 가지 않는다
  for (const join of [false, true]) {
    it(`앞선 보류의 알림이 도는 중에 걸린 새 보류는 제 글로 새 대기 항목 하나 — 도는 항목을 돌려받지 않고, 함께 넘긴 머리줄도 없다 (join: ${join}, 리드 결정 S5-25·S5-59 1)`, async () => {
      const e = (env = await bootOrch());
      const t = waitingTask(e);
      e.core.tasks.hold(t.id, 'error', 'task', '되돌리기 처리 실패 1 (시험)', 'system');
      const since1 = e.ctx.store.tasks.require(t.id).hold.reasons.at(-1)!.since;
      const first = alertMain(e.ctx, { kind: 'revert-fail', target: t.id, projectId: e.projectId, taskId: t.id, message: `${t.id} 되돌리기 실패 1 (시험)\n- 첫 보류의 줄`, since: since1, join })!;
      markRunning(e, first);
      await sleep(5);
      const since2 = e.ctx.now();
      await sleep(5);
      const msg = `${t.id} 되돌리기 실패 2 (시험)\n- 둘째 보류의 줄`;
      const second = alertMain(e.ctx, { kind: 'revert-fail', target: t.id, projectId: e.projectId, taskId: t.id, message: msg, since: since2, join });
      expect(second?.id).not.toBe(first.id);
      expect(second?.state).toBe('queued');
      expect(second?.message).toBe(msg);
      expect(second?.message).not.toContain(ALERT_JOINED_HEAD);
      expect(alerts(e, alertKey('revert-fail', t.id)).map((q) => [q.id, q.state])).toEqual([
        [first.id, 'running'],
        [second!.id, 'queued'],
      ]);
    });
  }
});

/** 자동 검사의 종료 확인 실패(CTL-11) — 그 실행 기록(refId)으로 둔 보류, 남은 하위 프로세스 remaining개. 대표 알림 글을 돌려준다 */
const blockCheck = (e: OrchEnv, t: Task, remaining: number, refId = 'X-0777') =>
  e.core.turns.blockUnconfirmedRun(
    { label: `${t.id} 자동 검사 'npm run dev-check'`, sessionKind: 'task', sessionKey: `check:${t.id}`, memberId: e.devId, projectId: e.projectId, taskId: t.id, turnId: null, refId },
    { envProblem: null, remaining, cause: '검사 서버가 남음 (시험)', what: '자동 검사', tail: null },
  );
/** 앞선 항목의 글을 함께 실은 모양 — 새 글, 머리줄, 두 칸 들여 쓴 앞선 글 */
const splitCarried = (message: string): [string, string | undefined] => {
  const [fresh, carried] = message.split(`\n${ALERT_EARLIER_HEAD}\n`);
  return [fresh!, carried];
};
const indent = (s: string) =>
  s
    .split('\n')
    .map((l) => `  ${l}`)
    .join('\n');

describe('바꿔 넣는 알림은 아직 남은 앞선 보류를 함께 싣는다 (리드 결정 S5-37 — S5-25 규칙 2를 고침)', () => {
  it('한 작업에 자동 검사와 작업 턴의 종료 확인 실패가 같이 남으면 한 번 전달에 두 프로세스 트리 — 대표 알림 둘 다 넘긴 사실, 받아 마친 뒤 두 사유 모두 reachesMain 참', async () => {
    const e = (env = await bootOrch());
    const t = waitingTask(e);
    const mk = mainKey(e.projectId);
    const key = alertKey('kill-failed', t.id);
    // 메인이 아직 그 알림을 받지 않았다(다른 일을 하는 중 등) — 첫 알림이 대기 중일 때 둘째 보류가 걸린다. 메인 턴은 띄운 뒤 붙잡아 둔다
    e.hold.add(mk);
    const n1 = await blockCheck(e, t, 3);
    const [first] = alerts(e, key);
    await sleep(5);
    const n2 = await blockTask(e, t, 1);
    expect(e.ctx.store.tasks.require(t.id).hold.reasons.map((r) => [r.kind, r.refId])).toEqual([
      ['error', 'X-0777'],
      ['error', null],
    ]);
    expect(n1).toContain(`작업을 보류하고 ${HANDED}`);
    expect(n2).toContain(`작업을 보류하고 ${HANDED}`);
    const all = alerts(e, key);
    expect(all.map((q) => [q.id === first!.id, q.state])).toEqual([
      [true, 'cancelled'],
      [false, 'queued'],
    ]);
    // 새 글(작업 턴의 트리)이 먼저, 그 아래 머리줄과 들여 쓴 앞선 글(자동 검사의 트리)
    const [fresh, carried] = splitCarried(all[1]!.message);
    expect(fresh.split('\n')[0]).toBe(`${t.id} "로그인 화면" — ${t.id} 시험 실행의 프로세스 종료를 확인하지 못해 보류됨`);
    expect(fresh).toContain('하위 프로세스 1개');
    expect(fresh).not.toContain('하위 프로세스 3개');
    expect(carried).toBe(indent(first!.message));
    expect(carried).toContain('하위 프로세스 3개');
    expect(carried).toContain(`${t.id} 자동 검사 'npm run dev-check'의 프로세스 종료를 확인하지 못해 보류됨`);
    expect(all[1]!.message.length).toBeLessThanOrEqual(ALERT_MESSAGE_MAX);
    expect(e.ctx.store.activity.search({ text: `아직 남은 앞선 보류를 실은 대기 항목 ${first!.id}을(를) 지우고 그 글을 새 항목에 함께 실음`, limit: 5 })).toHaveLength(1);
    // 메인 턴 하나가 두 트리를 한 업무로 싣는다
    e.tick();
    await waitFor(() => !!e.liveProc(mk, MAIN_AGENT_ID), '알림을 실은 메인 턴');
    const launch = e.launches.filter((l) => l.workKey === mk)[0]!;
    expect(launch.message.match(/### \d+\. 보류·실패 처리/g)).toHaveLength(1);
    expect(launch.message).toContain('하위 프로세스 3개');
    expect(launch.message).toContain('하위 프로세스 1개');
    e.hold.delete(mk);
    e.liveProc(mk, MAIN_AGENT_ID)!.finishOk('확인함');
    await waitFor(() => alerts(e, key).at(-1)!.state === 'done' && e.core.turns.count() === 0, '그 턴이 끝남');
    // 받아 마친 새 항목은 두 보류의 since보다 뒤다 — 두 사유 모두 메인에게 가 있다
    expect(holdReach(e, t.id)).toEqual([
      ['error', true],
      ['error', true],
    ]);
    // 대표 할 일은 오류 사유마다 하나 — 둘 다 메인에게 가 있다
    expect(await todoReach(e, t.id)).toEqual([true, true]);
  });

  it('앞선 항목이 실행 중이면 그 턴이 그 글을 읽는다 — 새 항목은 새 글만 싣고 그 턴이 정상으로 끝나도 그대로다. 그 턴이 끊겨 앞선 항목을 밀려 버리면 그때 한 번 옮겨 싣는다 (리드 결정 S5-44 2가 S5-37을 넓힘)', async () => {
    const e = (env = await bootOrch());
    const t = waitingTask(e);
    const key = alertKey('kill-failed', t.id);
    await blockCheck(e, t, 3);
    markRunning(e, alerts(e, key)[0]!);
    await sleep(5);
    expect(await blockTask(e, t, 1)).toContain(`작업을 보류하고 ${HANDED}`);
    const all = alerts(e, key);
    expect(all.map((q) => q.state)).toEqual(['running', 'queued']);
    expect(all[1]!.message).not.toContain(ALERT_EARLIER_HEAD);
    expect(all[1]!.message).not.toContain('하위 프로세스 3개');
    // 그 턴이 정상으로 끝났다(메인이 앞선 트리를 받았다) — 새 항목은 새 글만 그대로
    markDone(e, all[0]!);
    expect(e.ctx.store.queue.require(all[1]!.id).message).toBe(all[1]!.message);
    // 다른 작업: 앞선 항목을 실은 턴이 끊겨 더 새 항목에 밀려 버린다(끊긴 턴의 다시 넣기·재시작 복구가 쓰는 dropDeadWork) — 그 보류는 아직 남았으니 그 글을 옮겨 싣는다
    const t2 = waitingTask(e, '결제 화면');
    const key2 = alertKey('kill-failed', t2.id);
    await blockCheck(e, t2, 3, 'X-0778');
    const [old] = alerts(e, key2);
    markRunning(e, old!);
    await sleep(5);
    await blockTask(e, t2, 1);
    const fresh = alerts(e, key2)[1]!;
    const why = deadWorkReason(e.ctx, e.ctx.store.queue.require(old!.id))!;
    expect(why).toBe(`더 새 보류를 실은 같은 알림 ${fresh.id}이(가) 있음`);
    dropDeadWork(e.ctx, e.ctx.store.queue.require(old!.id), why);
    const carriedMsg = e.ctx.store.queue.require(fresh.id).message;
    const [head, carried] = splitCarried(carriedMsg);
    expect(head).toBe(fresh.message);
    expect(carried).toBe(indent(old!.message));
    expect(carriedMsg.length).toBeLessThanOrEqual(ALERT_MESSAGE_MAX);
    expect(e.ctx.store.queue.require(fresh.id).createdAt).toBe(fresh.createdAt);
    expect(e.ctx.store.queue.require(old!.id).state).toBe('cancelled');
    expect(e.ctx.store.activity.search({ text: `아직 남은 그 보류의 글은 ${fresh.id}에 함께 실음`, limit: 5 })).toHaveLength(1);
    // 한 번만 — 다시 불러도 더하지 않는다
    expect(carrySupersededAlert(e.ctx, e.ctx.store.queue.require(old!.id))).toBeNull();
    expect(e.ctx.store.queue.require(fresh.id).message).toBe(carriedMsg);
  });

  it('함께 실어도 알림 글은 상한 안이다 — 앞선 글의 뒤를 자른다. 끊긴 턴이 다시 넣으며 붙인 앞말은 떼고 싣는다', async () => {
    const e = (env = await bootOrch());
    const t = waitingTask(e);
    const base = { kind: 'kill-failed' as const, target: t.id, projectId: e.projectId, taskId: t.id };
    const q0 = alertMain(e.ctx, { ...base, message: `앞선 보류 첫 줄\n${'- 프로세스: 아주 긴 줄 '.repeat(400)}\n앞선 보류 끝 줄`, since: e.ctx.now() })!;
    // 끊긴 턴이 다시 넣은 모양 — '<까닭>' + 빈 줄 + '(다시 전달) '
    e.ctx.store.queue.put({ ...e.ctx.store.queue.require(q0.id), message: `메인 턴이 끊겨 다시 넣음 (시험)\n\n(다시 전달) ${q0.message}` });
    await sleep(5);
    const fresh = '새 보류 첫 줄\n- 보류 사유(오류): 새 사유 (시험)';
    const q1 = alertMain(e.ctx, { ...base, message: fresh, since: e.ctx.now(), keepEarlier: true })!;
    expect(q1.id).not.toBe(q0.id);
    expect(q1.message.length).toBeLessThanOrEqual(ALERT_MESSAGE_MAX);
    expect(q1.message.length).toBeGreaterThan(ALERT_MESSAGE_MAX - 10);
    const [head, carried] = splitCarried(q1.message);
    expect(head).toBe(fresh);
    expect(carried!.startsWith('  앞선 보류 첫 줄\n  - 프로세스: 아주 긴 줄')).toBe(true);
    expect(carried).not.toContain('(다시 전달)');
    expect(carried).not.toContain('앞선 보류 끝 줄');
    expect(carried!.endsWith('…')).toBe(true);
    // keepEarlier를 주지 않으면(다른 넣는 곳) 예전처럼 새 글만 (S5-25)
    await sleep(5);
    const q2 = alertMain(e.ctx, { ...base, message: '셋째 보류', since: e.ctx.now() })!;
    expect(q2.message).toBe('셋째 보류');
  });

  it('먼저 걸린 사유의 알림은 나중에 걸린 사유가 있어도 끝난 보류의 대기 항목을 싣지 않는다 — 시작 때 훑기가 사유 차례로 알릴 때', async () => {
    const e = (env = await bootOrch());
    const t = waitingTask(e);
    const key = alertKey('kill-failed', t.id);
    // 앞선(이미 풀린) 보류의 알림이 대기 중에 남았다(앱이 그 항목을 지우기 전에 꺼졌다)
    const stale = alertMain(e.ctx, { kind: 'kill-failed', target: t.id, projectId: e.projectId, taskId: t.id, message: `${t.id} 앞선 보류 (풀림, 시험)`, since: e.ctx.now() })!;
    await sleep(5);
    // 5단계 전에 걸린 두 사유 — 알림 없이 남았다 (자동 검사가 먼저, 작업 턴이 나중)
    e.core.tasks.hold(t.id, 'error', 'task', '자동 검사 종료 뒤 하위 프로세스 3개가 남았습니다 (시험)', 'system', 'X-0901');
    await sleep(5);
    e.core.tasks.hold(t.id, 'error', 'task', '턴 종료 뒤 하위 프로세스 1개가 남았습니다 (시험)', 'system');
    sweepAlerts(e.ctx);
    const all = alerts(e, key);
    expect(all.map((q) => [q.id === stale.id, q.state])).toEqual([
      [true, 'cancelled'],
      [false, 'queued'],
    ]);
    // 끝난 보류의 글은 '아직 남아 있음'으로 실리지 않는다
    expect(all[1]!.message).not.toContain(ALERT_EARLIER_HEAD);
    expect(all[1]!.message).not.toContain('앞선 보류 (풀림');
    expect(all[1]!.message).toContain('자동 검사 종료 뒤 하위 프로세스 3개가 남았습니다');
    sweepAlerts(e.ctx);
    expect(alerts(e, key)).toHaveLength(2);
  });

  it('함께 싣는지는 그 알림 종류의 사유만 본다 — 더 먼저 걸린 다른 종류의 보류(병합 보류)가 있어도 끝난 앞선 종료 확인 실패 글을 "아직 남아 있음"으로 싣지 않는다 (리드 결정 S5-37·S5-46, 프로브 zz-s5f2ti-keep-earlier-kind)', async () => {
    const e = (env = await bootOrch());
    const t = waitingTask(e);
    e.hold.add(mainKey(e.projectId));
    const key = alertKey('kill-failed', t.id);
    await blockTask(e, t, 1);
    const [first] = alerts(e, key);
    expect(first!.state).toBe('queued');
    // 첫 종료 확인 실패 사유는 끝났고, 그보다 먼저 걸린 병합 보류가 작업에 남았다 (만든 상태)
    const cur = e.ctx.store.tasks.require(t.id);
    const older = new Date(Date.parse(cur.hold.reasons[0]!.since) - 60_000).toISOString();
    e.ctx.store.tasks.patch(t.id, { hold: { ...cur.hold, reasons: [{ kind: 'merge_blocked', scope: 'task', refId: null, note: '병합 보류 (시험)', since: older, by: cur.hold.reasons[0]!.by }] } });
    await sleep(5);
    await blockTask(e, t, 2);
    const all = alerts(e, key);
    expect(all.map((q) => q.state)).toEqual(['cancelled', 'queued']);
    expect(all[1]!.message).toContain('하위 프로세스 2개');
    expect(all[1]!.message).not.toContain(ALERT_EARLIER_HEAD);
    expect(all[1]!.message).not.toContain('하위 프로세스 1개');
  });
});

/** 세션 키의 메인 턴이 뜰 때까지 틱을 돌린다 (그 턴은 붙잡혀 있어야 한다 — e.hold) */
const mainTurnUp = (e: OrchEnv, mk: string, label: string) =>
  waitFor(
    () => {
      if (!e.liveProc(mk, MAIN_AGENT_ID)) e.tick();
      return !!e.liveProc(mk, MAIN_AGENT_ID);
    },
    label,
    30_000,
  );
/** 그 키의 알림이 대기·실행 중인 것 없이 끝나고 턴이 모두 끝날 때까지 */
const alertsSettled = (e: OrchEnv, key: string, label: string) =>
  waitFor(
    () => {
      e.tick();
      return alerts(e, key).every((q) => q.state !== 'queued' && q.state !== 'running') && e.core.turns.count() === 0;
    },
    label,
    30_000,
  );
/** 글 안에 그 말이 몇 번 있는지 */
const count = (s: string, w: string) => s.split(w).length - 1;

describe('메인에게 갈 알림 하나가 그 키의 살아 있는 보류를 모두 싣는다 (리드 결정 S5-44 — S5-37을 넓힘)', () => {
  it('첫 알림을 실은 턴이 둘째 보류가 걸린 뒤 비정상 종료하면 다음 전달이 두 트리를 싣는다 — 밀려 버린 앞선 항목의 글을 더 새 항목에 한 번 옮겨 싣고, 두 사유 모두 reachesMain 참', async () => {
    const e = (env = await bootOrch());
    const t = waitingTask(e);
    const mk = mainKey(e.projectId);
    const key = alertKey('kill-failed', t.id);
    e.hold.add(mk);
    await blockCheck(e, t, 3);
    await mainTurnUp(e, mk, '자동 검사의 트리를 실은 메인 턴');
    const proc = e.liveProc(mk, MAIN_AGENT_ID)!;
    await sleep(5);
    expect(await blockTask(e, t, 1)).toContain(`작업을 보류하고 ${HANDED}`);
    const [w1, w2] = alerts(e, key);
    expect([w1!.state, w2!.state]).toEqual(['running', 'queued']);
    expect(w2!.message).not.toContain('하위 프로세스 3개');
    // 첫 트리를 읽던 턴이 아무것도 하지 못하고 끊긴다
    e.hold.delete(mk);
    proc.exit(1);
    await alertsSettled(e, key, '다음 메인 턴');
    expect(alerts(e, key).map((q) => [q.id, q.state])).toEqual([
      [w1!.id, 'cancelled'],
      [w2!.id, 'done'],
    ]);
    const next = e.launches.filter((l) => l.workKey === mk).find((l) => l.message.includes('하위 프로세스 1개'))!;
    expect(next.message.match(/### \d+\. 보류·실패 처리/g)).toHaveLength(1);
    expect(next.message).toContain(ALERT_EARLIER_HEAD);
    expect(next.message).toContain('하위 프로세스 3개');
    const [fresh, carried] = splitCarried(e.ctx.store.queue.require(w2!.id).message);
    expect(fresh).toBe(w2!.message);
    expect(carried).toBe(indent(w1!.message));
    expect(e.ctx.store.activity.search({ text: `아직 남은 그 보류의 글은 ${w2!.id}에 함께 실음`, limit: 5 })).toHaveLength(1);
    expect(holdReach(e, t.id)).toEqual([
      ['error', true],
      ['error', true],
    ]);
  });

  it('그 턴이 긴급 정지로 끝나도(정지로 끊긴 일을 다시 넣음) 정지 해제 뒤의 전달이 두 트리를 싣는다', async () => {
    const e = (env = await bootOrch());
    const t = waitingTask(e);
    const mk = mainKey(e.projectId);
    const key = alertKey('kill-failed', t.id);
    e.hold.add(mk);
    await blockCheck(e, t, 3);
    await mainTurnUp(e, mk, '자동 검사의 트리를 실은 메인 턴');
    await sleep(5);
    await blockTask(e, t, 1);
    await e.invoke('stop.emergency');
    await waitFor(() => e.core.turns.count() === 0, '긴급 정지로 메인 턴 끝남');
    const [w1, w2] = alerts(e, key);
    expect([w1!.state, w2!.state]).toEqual(['cancelled', 'queued']);
    expect(w2!.message).toContain(ALERT_EARLIER_HEAD);
    expect(count(w2!.message, ALERT_EARLIER_HEAD)).toBe(1);
    e.hold.delete(mk);
    await e.invoke('stop.release');
    await alertsSettled(e, key, '정지 해제 뒤 메인 턴');
    const delivered = e.launches
      .filter((l) => l.workKey === mk)
      .slice(1)
      .map((l) => l.message)
      .join('\n');
    expect(delivered).toContain('하위 프로세스 1개');
    expect(delivered).toContain('하위 프로세스 3개');
    const kinds = e.ctx.store.tasks.require(t.id).hold.reasons.map((r) => r.kind);
    expect(holdReach(e, t.id).filter((_, i) => kinds[i] === 'error')).toEqual([
      ['error', true],
      ['error', true],
    ]);
  });

  it('시작 때 훑기가 5단계 전 사유 둘을 알리면 먼저 걸린 사유로 만든 대기 항목에 둘째 사유의 글을 더한다 — 다시 훑어도 같고, 메인 턴 하나에 두 트리', async () => {
    const e = (env = await bootOrch());
    const t = waitingTask(e);
    const mk = mainKey(e.projectId);
    const key = alertKey('kill-failed', t.id);
    e.core.tasks.hold(t.id, 'error', 'task', '자동 검사 종료 뒤 하위 프로세스 3개가 남았습니다 (시험)', 'system', 'X-0901');
    await sleep(5);
    e.core.tasks.hold(t.id, 'error', 'task', '턴 종료 뒤 하위 프로세스 1개가 남았습니다 (시험)', 'system');
    sweepAlerts(e.ctx);
    const [w] = alerts(e, key);
    expect(alerts(e, key)).toHaveLength(1);
    expect(w!.state).toBe('queued');
    const [base, joined] = w!.message.split(`\n${ALERT_JOINED_HEAD}\n`);
    expect(base).toContain('- 보류 사유(오류): 자동 검사 종료 뒤 하위 프로세스 3개가 남았습니다 (시험)');
    expect(base).not.toContain('하위 프로세스 1개');
    // 둘째 사유의 첫 줄과 그 사유 줄만 — 같은 종류의 출구 문장은 되풀이하지 않는다
    expect(joined).toBe(`  ${base!.split('\n')[0]}\n  - 보류 사유(오류): 턴 종료 뒤 하위 프로세스 1개가 남았습니다 (시험)`);
    expect(w!.message.length).toBeLessThanOrEqual(ALERT_MESSAGE_MAX);
    expect(e.ctx.store.activity.search({ text: `대기 중인 같은 알림 ${w!.id}에 그 글을 함께 실음`, limit: 5 })).toHaveLength(1);
    expect(holdReach(e, t.id)).toEqual([
      ['error', true],
      ['error', true],
    ]);
    sweepAlerts(e.ctx);
    expect(alerts(e, key)).toHaveLength(1);
    expect(e.ctx.store.queue.require(w!.id).message).toBe(w!.message);
    e.hold.add(mk);
    await mainTurnUp(e, mk, '두 사유를 실은 메인 턴');
    const launch = e.launches.filter((l) => l.workKey === mk)[0]!;
    expect(launch.message.match(/### \d+\. 보류·실패 처리/g)).toHaveLength(1);
    expect(launch.message).toContain('하위 프로세스 3개');
    expect(launch.message).toContain('하위 프로세스 1개');
  });

  it('같은 보류를 다른 실행(새 프로세스 트리)으로 다시 알리면 대기 중인 그 항목에 새 줄을 더한다 — 만든 때는 그대로, 같은 글이면 더하지 않는다', async () => {
    const e = (env = await bootOrch());
    const t = waitingTask(e);
    const key = alertKey('kill-failed', t.id);
    const block = (label: string, remaining: number) =>
      e.core.turns.blockUnconfirmedRun(
        { label, sessionKind: 'task', sessionKey: taskKey(t.id), memberId: e.devId, projectId: e.projectId, taskId: t.id, turnId: null },
        { envProblem: null, remaining, cause: null, what: '턴' },
      );
    expect(await block(`${t.id} 작업 턴`, 1)).toContain(HANDED);
    const [w] = alerts(e, key);
    expect(await block(`${t.id} 작업 턴`, 1)).toContain(HANDED);
    expect(e.ctx.store.queue.require(w!.id).message).toBe(w!.message);
    expect(await block(`${t.id} 검수 턴`, 2)).toContain(HANDED);
    expect(alerts(e, key)).toHaveLength(1);
    const now = e.ctx.store.queue.require(w!.id);
    expect(now.createdAt).toBe(w!.createdAt);
    const [base, joined] = now.message.split(`\n${ALERT_JOINED_HEAD}\n`);
    expect(base).toBe(w!.message);
    expect(joined).toBe(`  ${t.id} "로그인 화면" — ${t.id} 검수 턴의 프로세스 종료를 확인하지 못해 보류됨\n  - 프로세스: ${t.id} 검수 턴 — 남은 하위 프로세스 2개`);
    await block(`${t.id} 검수 턴`, 2);
    expect(e.ctx.store.queue.require(w!.id).message).toBe(now.message);
  });

  it('더한 글도 4,000자 안이다 — 더한 글의 뒤를 자르고, 머리줄조차 들지 않으면 더하지 않는다. join을 주지 않으면(다른 넣는 곳) 그대로', async () => {
    const e = (env = await bootOrch());
    const t = waitingTask(e);
    const base = { kind: 'kill-failed' as const, target: t.id, projectId: e.projectId, taskId: t.id };
    const since = e.ctx.now();
    const long = `첫 사유 첫 줄\n${'- 프로세스: 아주 긴 줄 '.repeat(240)}`;
    const q0 = alertMain(e.ctx, { ...base, message: long, since })!;
    const q1 = alertMain(e.ctx, { ...base, message: `둘째 사유 첫 줄\n- 보류 사유(오류): ${'둘째 사유 '.repeat(60)}`, since, join: true })!;
    expect(q1.id).toBe(q0.id);
    expect(q1.message.length).toBeLessThanOrEqual(ALERT_MESSAGE_MAX);
    expect(q1.message.length).toBeGreaterThan(ALERT_MESSAGE_MAX - 10);
    expect(q1.message.startsWith(`${long}\n${ALERT_JOINED_HEAD}\n  둘째 사유 첫 줄\n  - 보류 사유(오류): 둘째 사유`)).toBe(true);
    expect(q1.message.endsWith('…')).toBe(true);
    const full = alertMain(e.ctx, { ...base, message: `셋째 사유 첫 줄\n- 셋째 사유 줄`, since, join: true })!;
    expect(full.message).toBe(q1.message);
    expect(alertMain(e.ctx, { ...base, message: `넷째 사유 첫 줄\n- 넷째 사유 줄`, since })!.message).toBe(q1.message);
    // join은 작업 보류의 알림(alertTaskHold)만 준다 — 다른 넣는 곳이 같은 일을 다른 글로 다시 알려도 대기 항목의 글은 그대로
    const p0 = alertMain(e.ctx, { kind: 'plan-stuck', target: 'D-9999', projectId: e.projectId, message: '계획 지연 첫 줄\n- 첫 글', since })!;
    expect(alertMain(e.ctx, { kind: 'plan-stuck', target: 'D-9999', projectId: e.projectId, message: '계획 지연 첫 줄\n- 다른 글', since })!.message).toBe(p0.message);
  });

  it('끊긴 턴이 실었던 함께 실은 항목을 다시 넣으면 두 트리가 한 번씩 — 받아 마친 뒤 두 사유 모두 reachesMain 참 (회귀)', async () => {
    const e = (env = await bootOrch());
    const t = waitingTask(e);
    const mk = mainKey(e.projectId);
    const key = alertKey('kill-failed', t.id);
    e.hold.add(mk);
    await blockCheck(e, t, 3);
    await sleep(5);
    await blockTask(e, t, 1);
    expect(alerts(e, key).map((q) => q.state)).toEqual(['cancelled', 'queued']);
    await mainTurnUp(e, mk, '함께 실은 항목의 메인 턴');
    const proc = e.liveProc(mk, MAIN_AGENT_ID)!;
    e.hold.delete(mk);
    proc.exit(1);
    await alertsSettled(e, key, '다시 전달');
    const second = e.launches.filter((l) => l.workKey === mk)[1]!.message;
    expect(second).toContain('하위 프로세스 3개');
    expect(second).toContain('하위 프로세스 1개');
    expect(second.match(/### \d+\. 보류·실패 처리/g)).toHaveLength(1);
    expect(count(second, ALERT_EARLIER_HEAD)).toBe(1);
    expect(count(second, '(다시 전달)')).toBeLessThanOrEqual(1);
    expect(holdReach(e, t.id)).toEqual([
      ['error', true],
      ['error', true],
    ]);
  });

  it('함께 실은 항목이 도는 중에 PC가 꺼지면 다시 시작한 뒤 한 번 전달에 두 트리 — 시작 때 훑기는 더하지 않는다 (회귀)', async () => {
    let e = (renv = await bootRestartable());
    const oe = e as unknown as OrchEnv;
    const t = waitingTask(oe);
    const mk = mainKey(e.projectId);
    const key = alertKey('kill-failed', t.id);
    e.hold.add(mk);
    await blockCheck(oe, t, 3);
    await sleep(5);
    await blockTask(oe, t, 1);
    e.tick();
    await waitFor(() => !!e.liveProc(mk, MAIN_AGENT_ID), '함께 실은 항목의 메인 턴');
    e.crash();
    e = renv = await e.reboot({ holdAll: true });
    await waitFor(() => e.launchesOf(mk).length >= 1, '다시 시작한 뒤 첫 메인 턴', 20_000);
    await sleep(100);
    const before = alerts(e, key).map((q) => q.message);
    sweepAlerts(e.ctx);
    expect(alerts(e, key).map((q) => q.message)).toEqual(before);
    expect(alerts(e, key).filter((q) => q.state === 'queued' || q.state === 'running')).toHaveLength(1);
    const msg = e.launchesOf(mk)[0]!.message;
    expect(msg).toContain('하위 프로세스 3개');
    expect(msg).toContain('하위 프로세스 1개');
    expect(msg.match(/### \d+\. 보류·실패 처리/g)).toHaveLength(1);
    expect(holdReach(e as unknown as OrchEnv, t.id)).toEqual([
      ['error', true],
      ['error', true],
    ]);
  });

  it('첫 알림이 도는 중에 둘째 보류가 걸리고 PC가 꺼지면 재시작 복구가 밀려 버린 앞선 항목의 글을 더 새 항목에 옮겨 싣는다 — 첫 전달에 두 트리, 앞선 글은 한 번', async () => {
    let e = (renv = await bootRestartable());
    const oe = e as unknown as OrchEnv;
    const t = waitingTask(oe);
    const mk = mainKey(e.projectId);
    const key = alertKey('kill-failed', t.id);
    e.hold.add(mk);
    await blockCheck(oe, t, 3);
    e.tick();
    await waitFor(() => !!e.liveProc(mk, MAIN_AGENT_ID), '자동 검사의 트리를 실은 메인 턴');
    await sleep(5);
    await blockTask(oe, t, 1);
    const [w1, w2] = alerts(e, key);
    expect([w1!.state, w2!.state]).toEqual(['running', 'queued']);
    e.crash();
    e = renv = await e.reboot({ holdAll: true });
    await waitFor(() => e.launchesOf(mk).length >= 1, '다시 시작한 뒤 첫 메인 턴', 20_000);
    expect(alerts(e, key).map((q) => [q.id, q.state])).toEqual([
      [w1!.id, 'cancelled'],
      [w2!.id, 'running'],
    ]);
    const msg = e.launchesOf(mk)[0]!.message;
    expect(msg.match(/### \d+\. 보류·실패 처리/g)).toHaveLength(1);
    expect(msg).toContain('하위 프로세스 1개');
    expect(msg).toContain(ALERT_EARLIER_HEAD);
    expect(count(msg, '하위 프로세스 3개')).toBe(count(w1!.message, '하위 프로세스 3개'));
    expect(e.ctx.store.activity.search({ text: `아직 남은 그 보류의 글은 ${w2!.id}에 함께 실음`, limit: 5 }).map((a) => a.text)).toEqual([
      expect.stringContaining('재시작 복구: 더 새 보류를 실은 같은 알림'),
    ]);
  });

  it('첫 알림이 비정상 종료 상한의 턴에서 도는 중에 둘째 보류가 걸리면 상한에서 버린 앞선 항목의 글도 더 새 항목에 옮겨 싣는다', async () => {
    const e = (env = await bootOrch());
    const t = waitingTask(e);
    const mk = mainKey(e.projectId);
    const key = alertKey('kill-failed', t.id);
    const max = e.ctx.settings().execution.crashRetryMax;
    e.hold.add(mk);
    await blockCheck(e, t, 3);
    // 앞선 알림을 실은 메인 턴이 상한까지 비정상 종료를 거듭한다
    for (let i = 0; i < max; i++) {
      await mainTurnUp(e, mk, `알림을 실은 메인 턴 ${i + 1}`);
      e.liveProc(mk, MAIN_AGENT_ID)!.exit(1);
      await waitFor(() => e.core.turns.count() === 0, `끊긴 턴 ${i + 1}`);
    }
    await mainTurnUp(e, mk, '상한의 메인 턴');
    const proc = e.liveProc(mk, MAIN_AGENT_ID)!;
    const running = alerts(e, key).find((q) => q.state === 'running')!;
    expect(running.attempts).toBe(max);
    await sleep(5);
    await blockTask(e, t, 1);
    const fresh = alerts(e, key).find((q) => q.state === 'queued')!;
    expect(fresh.message).not.toContain('하위 프로세스 3개');
    proc.exit(1);
    await waitFor(() => e.core.turns.count() === 0, '상한에서 끝난 턴');
    const now = e.ctx.store.queue.require(fresh.id).message;
    expect(now).toContain(ALERT_EARLIER_HEAD);
    expect(now).toContain('하위 프로세스 3개');
    expect(now).not.toContain('(다시 전달)');
    expect(now.length).toBeLessThanOrEqual(ALERT_MESSAGE_MAX);
  });

  it('살아 있는 사유 셋(자동 검사 둘 + 작업 턴)도 한 대기 항목에 모든 트리를 4,000자 안으로 싣는다 (회귀)', async () => {
    const e = (env = await bootOrch());
    const t = waitingTask(e);
    const key = alertKey('kill-failed', t.id);
    const long = (n: number) => `검사 서버가 남음 ${'node dev-server --port 5173 --watch '.repeat(n)}`;
    const check = (remaining: number, refId: string) =>
      e.core.turns.blockUnconfirmedRun(
        { label: `${t.id} 자동 검사 'npm run dev-check'`, sessionKind: 'task', sessionKey: `check:${t.id}`, memberId: e.devId, projectId: e.projectId, taskId: t.id, turnId: null, refId },
        { envProblem: null, remaining, cause: long(14), what: '자동 검사', tail: null },
      );
    await check(3, 'X-0777');
    await sleep(5);
    await check(2, 'X-0778');
    await sleep(5);
    await blockTask(e, t, 1);
    const q = alerts(e, key).filter((x) => x.state === 'queued');
    expect(q).toHaveLength(1);
    expect(q[0]!.message.length).toBeLessThanOrEqual(ALERT_MESSAGE_MAX);
    for (const n of [1, 2, 3]) expect(q[0]!.message).toContain(`하위 프로세스 ${n}개`);
    expect(q[0]!.message).toMatch(/- 프로세스: T-\d+ 자동 검사 'npm run dev-check' — 남은 하위 프로세스 3개/);
  });

  it('서버 모드: 함께 실은 글과 대표 알림은 서버 PC 운영자를 적고 작업 관리자를 적지 않는다, 보류 글은 사실만 (회귀)', async () => {
    const e = (env = await bootOrch({ mode: 'server' }));
    const t = waitingTask(e);
    const key = alertKey('kill-failed', t.id);
    const n1 = await blockCheck(e, t, 3);
    await sleep(5);
    const n2 = await blockTask(e, t, 1);
    const q = alerts(e, key).find((x) => x.state === 'queued')!;
    expect(q.message).toContain(ALERT_EARLIER_HEAD);
    expect(q.message).not.toContain('작업 관리자');
    expect(q.message).toContain('서버 PC 운영자');
    expect(`${n1} ${n2}`).not.toContain('작업 관리자');
    const notes = e.ctx.store.tasks
      .require(t.id)
      .hold.reasons.map((r) => r.note)
      .join('\n');
    expect(notes).not.toContain('작업 관리자');
    expect(notes).not.toMatch(/resume_task|메인 에이전트가/);
    expect(notices(e, '프로세스 종료 확인 실패')).toHaveLength(2);
  });

  it('시작 때 훑기가 대기 중인 그 알림의 살아 있는 보류를 다시 알려도(첫 줄만 다름) 그 항목에 더하지 않는다 — 두 번 훑어도 글 그대로 (리드 결정 S5-52.3, 프로브 zz-s5f3ti-alert-kills)', async () => {
    const e = (env = await bootOrch());
    const t = waitingTask(e);
    await blockTask(e, t, 1);
    const [q] = alerts(e, alertKey('kill-failed', t.id));
    expect(q!.state).toBe('queued');
    sweepAlerts(e.ctx);
    sweepAlerts(e.ctx);
    const after = e.ctx.store.queue.require(q!.id).message;
    expect(after.includes(ALERT_JOINED_HEAD), after.slice(q!.message.length)).toBe(false);
    expect(after).toBe(q!.message);
    expect(alerts(e, alertKey('kill-failed', t.id))).toHaveLength(1);
  });

  it('밀려 버리는 앞선 항목을 옮겨 싣는지는 그 알림 종류의 살아 있는 사유만 본다 — 더 먼저 걸린 다른 종류의 보류(병합 보류)가 남아도 자기 보류가 끝난 종료 확인 실패 글은 싣지 않는다 (리드 결정 S5-44 2·S5-52.3)', async () => {
    const e = (env = await bootOrch());
    const t = waitingTask(e);
    const key = alertKey('kill-failed', t.id);
    await blockTask(e, t, 1);
    const [old] = alerts(e, key);
    markRunning(e, old!);
    // 첫 종료 확인 실패 사유는 풀렸고, 더 먼저 걸린 병합 보류가 그 작업에 남아 있다 (keepEarlier 종류 시험과 같은 만든 모양)
    const cur = e.ctx.store.tasks.require(t.id);
    const older = new Date(Date.parse(cur.hold.reasons[0]!.since) - 60_000).toISOString();
    e.ctx.store.tasks.patch(t.id, { hold: { ...cur.hold, reasons: [{ kind: 'merge_blocked', scope: 'task', refId: null, note: '병합 보류 (시험)', since: older, by: cur.hold.reasons[0]!.by }] } });
    await sleep(5);
    await blockTask(e, t, 2);
    const fresh = alerts(e, key).find((q) => q.state === 'queued')!;
    const why = deadWorkReason(e.ctx, e.ctx.store.queue.require(old!.id))!;
    expect(why).toBe(`더 새 보류를 실은 같은 알림 ${fresh.id}이(가) 있음`);
    dropDeadWork(e.ctx, e.ctx.store.queue.require(old!.id), why);
    const msg = e.ctx.store.queue.require(fresh.id).message;
    expect(msg).not.toContain(ALERT_EARLIER_HEAD);
    expect(msg).not.toContain('하위 프로세스 1개');
    expect(msg).toBe(fresh.message);
  });
});

/** resume_task 호출 — 거부되면 그 오류(code·message), 받으면 null과 결과 */
const tryResume = (e: OrchEnv, taskId: string, reason?: string) =>
  e.main('resume_task', { task_id: taskId, ...(reason !== undefined ? { reason } : {}) }).then(
    (data) => ({ refused: null as (Error & { code?: string }) | null, data }),
    (x: Error & { code?: string }) => ({ refused: x, data: null }),
  );
/** 메인 도구 호출(실행 중인 메인 턴 없이 — 운영 신원) — 거부되면 그 오류(code·message), 받으면 null과 결과 */
const tryMain = (e: OrchEnv, tool: string, args: Record<string, unknown>) =>
  e.main(tool, args).then(
    (data) => ({ refused: null as (Error & { code?: string }) | null, data }),
    (x: Error & { code?: string }) => ({ refused: x, data: null }),
  );
/** 실행 중인 그 메인 턴의 신원으로 메인 도구를 부른다(에이전트가 그 턴에서 부른 것) — 거부되면 그 code·message, 받으면 null과 결과 (리드 결정 S5-49) */
const toolIn = async (e: OrchEnv, turnId: string, tool: string, args: Record<string, unknown>) => {
  const r = await e.tool(turnId, tool, { reason: `시험: ${tool}`, ...args });
  return r.ok ? { refused: null as { code: string; message: string } | null, data: (r.data ?? {}) as Record<string, unknown> } : { refused: { code: r.code, message: r.message }, data: null };
};
/** 메인 일지의 서버 기록(action) 글 — 최근 것이 앞 */
const journalActions = (e: OrchEnv) => e.ctx.store.journal.query({ author: 'server', kinds: ['action'], limit: 50 });

describe('resume_task는 메인이 아직 받지 않은 알림을 먼저 보여 준다 (리드 결정 S5-45)', () => {
  it('알림 턴 도중 둘째 보류가 걸리고 메인이 그 턴에서 resume_task를 부르면 한 번 거부 — 둘째 트리를 거부 글로 보여 주고 그 알림은 그 턴에 실림(실행 중, 취소 아님 — 리드 결정 S5-49가 S5-45의 받아 마침을 고침), 다시 부르면 재개, 그 턴이 끝나면 받아 마침, 조용히 버린 알림 없음', async () => {
    const e = (env = await bootOrch());
    const t = waitingTask(e);
    const mk = mainKey(e.projectId);
    const key = alertKey('kill-failed', t.id);
    e.hold.add(mk);
    await blockCheck(e, t, 3);
    await mainTurnUp(e, mk, '자동 검사의 트리를 실은 메인 턴');
    const proc = e.liveProc(mk, MAIN_AGENT_ID)!;
    await sleep(5);
    const n2 = await blockTask(e, t, 1);
    expect(n2).toContain(`작업을 보류하고 ${HANDED}`);
    const [w1, w2] = alerts(e, key);
    // 메인은 보여 받은 트리(자동 검사의 3개)만 확인하고 그 알림의 출구대로 그 턴에서 resume_task를 부른다
    const first = await toolIn(e, proc.turnId, 'resume_task', { task_id: t.id, reason: '자동 검사 프로세스 3개 정리 확인' });
    expect(first.refused?.code).toBe('conflict');
    const msg = first.refused!.message;
    expect(msg.split('\n')[0]).toBe(
      `${t.id}은(는) 재개하지 않았습니다 — 재개하면 함께 풀릴 보류 가운데 아직 받지 않은(대기 중인) 알림이 있습니다. 그 알림을 아래에 옮겨 적고 받은 것으로 해 두었습니다. 알림에 적힌 것을 확인한 뒤 이어 가도 되면 resume_task를 다시 부르세요 — 다음 호출은 재개합니다.`,
    );
    const reasons = e.ctx.store.tasks.require(t.id).hold.reasons;
    expect(msg).toContain(`- 알림 ${w2!.id} (프로세스 종료 확인 실패 ${t.id}) — 함께 풀릴 보류: ${reasons.map((r) => `오류 "${r.note}"`).join(', ')}`);
    expect(msg).toContain(indent(w2!.message));
    expect(msg).toContain('하위 프로세스 1개');
    // 실행 중인 첫 알림은 본 것이다 — 다시 옮기지 않는다
    expect(msg).not.toContain(`알림 ${w1!.id}`);
    expect(e.ctx.store.tasks.require(t.id).state).toBe('on_hold');
    // 보인 알림은 부른 그 턴의 일이 된다 — 실행 중·그 턴 ID·그 턴 기록이 실은 항목 (리드 결정 S5-49). 받아 마친 것으로 두지 않는다
    expect(alerts(e, key).map((q) => [q.id, q.state, q.turnId])).toEqual([
      [w1!.id, 'running', proc.turnId],
      [w2!.id, 'running', proc.turnId],
    ]);
    expect(e.ctx.store.turns.require(proc.turnId).queueEntryIds).toEqual(expect.arrayContaining([w1!.id, w2!.id]));
    expect(e.ctx.store.activity.search({ text: `알림 ${w2!.id}을(를) resume_task 거부 글로 메인 에이전트에게 전달`, limit: 5 }).map((a) => a.text)).toEqual([
      `프로세스 종료 확인 실패 ${t.id} 알림 ${w2!.id}을(를) resume_task 거부 글로 메인 에이전트에게 전달 (${key}, 이 턴 ${proc.turnId}에 실음 — 그 턴이 끊기면 다시 전달 — 다음 resume_task는 재개)`,
    ]);
    expect(holdReach(e, t.id)).toEqual([
      ['error', true],
      ['error', true],
    ]);
    // 그 턴에서 다시 부르면 재개한다 — 실은 알림은 본 것이다. 결과에 푼 사유
    const second = await toolIn(e, proc.turnId, 'resume_task', { task_id: t.id, reason: '두 트리 모두 정리 확인' });
    expect(second.refused).toBeNull();
    expect(second.data).toMatchObject({ taskId: t.id, state: 'waiting' });
    const released = second.data!.released as { kind: string; label: string; note: string }[];
    expect(released.map((r) => [r.kind, r.label])).toEqual([
      ['error', '오류'],
      ['error', '오류'],
    ]);
    expect(released.map((r) => r.note)).toEqual(reasons.map((r) => r.note));
    e.hold.delete(mk);
    proc.finishOk('확인함');
    await alertsSettled(e, key, '대기열 정리');
    // 그 턴이 정상으로 끝나 실은 두 알림 모두 받아 마침
    expect(alerts(e, key).map((q) => q.state)).toEqual(['done', 'done']);
    // 조용히 버린 알림이 없다 — 둘째 대표 알림('메인 에이전트가 확인하고 이어 갑니다')은 참이다
    expect(e.ctx.store.activity.search({ text: '끝난 일의 보류·실패 처리 업무 정리', limit: 20 }).filter((a) => a.text.includes(t.id))).toEqual([]);
    expect(notices(e, '프로세스 종료 확인 실패').map((n) => n.body).at(-1)).toContain(HANDED);
    // 거부 글로 받은 둘째 트리는 메인 턴으로 다시 가지 않는다
    expect(e.launches.filter((l) => l.workKey === mk)[0]!.message).not.toContain('하위 프로세스 1개');
    expect(
      e.launches
        .filter((l) => l.workKey === mk)
        .slice(1)
        .some((l) => l.message.includes('하위 프로세스 1개')),
    ).toBe(false);
  });

  it('함께 실은 대기 항목도 한 번 거부 글로 — 두 사유와 두 트리를 보여 주고 받아 마침, 다시 부르면 재개, 버림 알림 없음 (전달 전에 두 보류를 푸는 경우 — 리드 결정 S5-45 전에는 조용히 지웠다)', async () => {
    const e = (env = await bootOrch());
    const t = waitingTask(e);
    const mk = mainKey(e.projectId);
    const key = alertKey('kill-failed', t.id);
    e.hold.add(mk);
    await blockCheck(e, t, 3);
    await sleep(5);
    await blockTask(e, t, 1);
    const before = e.ctx.store.notifications.list().length;
    const w = alerts(e, key).find((q) => q.state === 'queued')!;
    const first = await tryResume(e, t.id, '정리됨');
    expect(first.refused?.code).toBe('conflict');
    expect(first.refused!.message).toContain(indent(w.message));
    expect(first.refused!.message).toContain('하위 프로세스 3개');
    expect(first.refused!.message).toContain('하위 프로세스 1개');
    // 실행 중인 메인 턴이 없는 호출(운영 신원)이면 보인 알림은 받아 마친 것으로 둔다 — 턴이 없을 때만 (리드 결정 S5-49)
    expect(e.ctx.store.queue.require(w.id).state).toBe('done');
    expect(e.ctx.store.activity.search({ text: `알림 ${w.id}을(를) resume_task 거부 글로`, limit: 5 }).map((a) => a.text.includes(`(${key}, 받은 것으로 둠 — 다음 resume_task는 재개)`))).toEqual([true]);
    expect((await tryResume(e, t.id, '정리됨')).data).toMatchObject({ taskId: t.id, state: 'waiting' });
    e.hold.delete(mk);
    for (let i = 0; i < 5; i++) {
      e.tick();
      await sleep(20);
    }
    await waitFor(() => e.core.turns.count() === 0, '쉼');
    expect(alerts(e, key).map((q) => q.state)).toEqual(['cancelled', 'done']);
    const fresh = e.ctx.store.notifications.list().slice(before);
    expect(fresh.filter((n) => /전하지 못한|버림|다시 오지 않/.test(`${n.title} ${n.body}`))).toEqual([]);
    expect(e.launches.filter((l) => l.workKey === mk)).toEqual([]);
  });

  it('대기 중인 알림이 없으면 예전처럼 바로 재개하고 결과에 푼 사유를 적는다 — 받아 마친 알림만 있어도 같다', async () => {
    const e = (env = await bootOrch());
    const t = waitingTask(e);
    await e.main('interrupt_task', { task_id: t.id, then: 'hold' });
    expect(alerts(e)).toEqual([]);
    expect(await e.main('resume_task', { task_id: t.id })).toEqual({ taskId: t.id, state: 'waiting', released: [{ kind: 'interrupted', label: '중단', note: '메인 에이전트 중단' }] });
    const t2 = waitingTask(e, '결제 화면');
    await blockTask(e, t2, 1);
    markDone(e, alerts(e, alertKey('kill-failed', t2.id))[0]!);
    const note = e.ctx.store.tasks.require(t2.id).hold.reasons[0]!.note;
    expect(await e.main('resume_task', { task_id: t2.id })).toEqual({ taskId: t2.id, state: 'waiting', released: [{ kind: 'error', label: '오류', note }] });
    expect(e.ctx.store.activity.search({ text: 'resume_task 거부 글로', limit: 5 })).toEqual([]);
  });

  it('다른 거부가 먼저다 — 사유 없음·긴급 정지·바로 풀 수 없는 보류면 그 거부 그대로이고 대기 중인 알림은 그대로 둔다', async () => {
    const e = (env = await bootOrch());
    const t = waitingTask(e);
    await blockTask(e, t, 1);
    const [w] = alerts(e, alertKey('kill-failed', t.id));
    const stateOf = (q: QueueEntry) => e.ctx.store.queue.require(q.id).state;
    expect((await tryResume(e, t.id, '')).refused?.code).toBe('invalid');
    expect(stateOf(w!)).toBe('queued');
    await e.invoke('stop.emergency');
    const stopped = await tryResume(e, t.id);
    expect(stopped.refused?.code).toBe('stopped');
    expect(stateOf(w!)).toBe('queued');
    await e.invoke('stop.release');
    // 재계획 보류(병합 충돌을 풀지 못함)는 resume_task가 풀지 않는다 — 그 알림이 대기 중이어도 예전 거부 글이다
    const t2 = waitingTask(e, '정산 화면');
    e.core.tasks.hold(t2.id, 'replan', 'task', `${CONFLICT_SPIN_NOTE} (시험)`, 'system');
    alertTaskHold(e.ctx, 'conflict-stuck', t2.id, { cause: '프로듀서가 맡아서도 병합 충돌을 풀지 못함 (시험)' });
    const [w2] = alerts(e, alertKey('conflict-stuck', t2.id));
    const notResumable = await tryResume(e, t2.id);
    expect(notResumable.refused?.code).toBe('conflict');
    expect(notResumable.refused!.message).toContain('메인 에이전트가 바로 재개할 수 있는 보류가 아닙니다');
    expect(notResumable.refused!.message).not.toContain('아직 받지 않은');
    expect(stateOf(w2!)).toBe('queued');
    // 지시가 취소·종료된 작업 — 풀 사유(오류)의 알림이 대기 중이어도 그 거부가 먼저다
    const t3 = waitingTask(e, '알림 화면');
    await blockTask(e, t3, 1);
    const [w3] = alerts(e, alertKey('kill-failed', t3.id));
    e.ctx.store.directives.patch(t3.directiveId, { state: 'cancelled' });
    const closed = await tryResume(e, t3.id);
    expect(closed.refused?.code).toBe('conflict');
    expect(closed.refused!.message).toBe(`${t3.id}의 지시 ${t3.directiveId}이(가) 취소·종료돼 이 작업은 더 진행하지 않습니다`);
    expect(stateOf(w3!)).toBe('queued');
    expect(e.ctx.store.activity.search({ text: 'resume_task 거부 글로', limit: 5 })).toEqual([]);
  });

  it('풀 사유의 알림만 본다 — 남는 보류(재계획)의 알림이 대기 중이어도 풀 사유의 알림을 받았으면 재개하고 남은 사유를 알린다', async () => {
    const e = (env = await bootOrch());
    const t = waitingTask(e);
    e.core.tasks.hold(t.id, 'replan', 'task', `${CONFLICT_SPIN_NOTE} (시험)`, 'system');
    alertTaskHold(e.ctx, 'conflict-stuck', t.id, { cause: '프로듀서가 맡아서도 병합 충돌을 풀지 못함 (시험)' });
    await blockTask(e, t, 1);
    markDone(e, alerts(e, alertKey('kill-failed', t.id))[0]!);
    const res = await e.main('resume_task', { task_id: t.id });
    expect(res).toMatchObject({ taskId: t.id, state: 'on_hold', released: [{ kind: 'error', label: '오류' }], remainingHolds: [`replan: ${CONFLICT_SPIN_NOTE} (시험)`] });
    expect(alerts(e, alertKey('conflict-stuck', t.id))[0]!.state).toBe('queued');
  });

  it('거부 글과 결과는 가린다 — 보류 메모의 비밀 값이 나가지 않고, 옮긴 알림 글은 4,000자 안으로 자른다', async () => {
    const e = (env = await bootOrch());
    const secret = `fake-${randomBytes(16).toString('hex')}`;
    e.ctx.redact.addSecret(secret, 'api-key');
    const t = waitingTask(e);
    e.core.tasks.hold(t.id, 'error', 'task', `되돌리기 처리 실패: https://x:${secret}@example.invalid/repo (시험)`, 'system');
    const since = e.ctx.store.tasks.require(t.id).hold.reasons[0]!.since;
    alertMain(e.ctx, { kind: 'revert-fail', target: t.id, projectId: e.projectId, taskId: t.id, message: `${t.id} 긴 알림 (시험)\n${'- 줄 '.repeat(2_000)}`, since });
    const first = await tryResume(e, t.id);
    expect(first.refused?.code).toBe('conflict');
    const msg = first.refused!.message;
    expect(msg).not.toContain(secret);
    expect(msg).toContain('[가림:');
    const quoted = msg
      .split('\n')
      .filter((l) => l.startsWith('  '))
      .map((l) => l.slice(2))
      .join('\n');
    expect(quoted.startsWith(`${t.id} 긴 알림 (시험)`)).toBe(true);
    expect(quoted.length).toBeLessThanOrEqual(ALERT_MESSAGE_MAX);
    expect(quoted.endsWith('…')).toBe(true);
    const second = await tryResume(e, t.id);
    expect(second.data).toMatchObject({ taskId: t.id, released: [{ kind: 'error' }] });
    expect(JSON.stringify(second.data)).not.toContain(secret);
    expect(JSON.stringify(second.data)).toContain('[가림:');
  });

  it('한 작업에 두 키의 대기 알림(병합 실패·종료 확인 실패) — 한 번의 거부가 둘 다 보여 주고 둘 다 넘긴다, 다음 resume_task는 재개 (한 번만 거부, 리드 결정 S5-52.3)', async () => {
    const e = (env = await bootOrch());
    const t = passedRepo(e);
    mergeFailed(e, t.id, 'git 오류 (시험)');
    await sleep(5);
    await blockTask(e, e.ctx.store.tasks.require(t.id), 1);
    const queued = alerts(e).filter((q) => q.state === 'queued' && q.taskId === t.id);
    expect(queued.map((q) => q.alertKey).sort()).toEqual([alertKey('kill-failed', t.id), alertKey('merge-fail', t.id)].sort());
    const first = await tryResume(e, t.id, '정리됨');
    expect(first.refused?.code).toBe('conflict');
    for (const q of queued) expect(first.refused!.message).toContain(`- 알림 ${q.id} (`);
    // 실행 중인 메인 턴이 없는 호출이라 둘 다 받아 마침 (리드 결정 S5-49)
    expect(queued.map((q) => e.ctx.store.queue.require(q.id).state)).toEqual(['done', 'done']);
    const second = await tryResume(e, t.id, '정리됨');
    expect(second.refused?.message ?? null).toBeNull();
    expect(second.data).toMatchObject({ taskId: t.id });
  });

  it('결과의 남은 보류(remainingHolds)도 가린다 — 남는 보류 메모의 비밀 값이 도구 결과에 나가지 않는다 (리드 결정 S5-3·S5-52.3)', async () => {
    const e = (env = await bootOrch());
    const secret = `fake-${randomBytes(16).toString('hex')}`;
    e.ctx.redact.addSecret(secret, 'api-key');
    const t = waitingTask(e);
    e.core.tasks.hold(t.id, 'replan', 'task', `${CONFLICT_SPIN_NOTE} — 원격 https://x:${secret}@example.invalid/repo (시험)`, 'system');
    await blockTask(e, t, 1);
    for (const q of alerts(e, alertKey('kill-failed', t.id))) markDone(e, q);
    const res = await e.main('resume_task', { task_id: t.id, reason: '정리됨' });
    expect(res).toMatchObject({ taskId: t.id, state: 'on_hold', released: [{ kind: 'error' }] });
    expect(JSON.stringify(res.remainingHolds)).toContain('[가림:');
    expect(JSON.stringify(res)).not.toContain(secret);
  });

  it('옮겨 적는 알림 글은 거부 글을 만들 때 다시 가린다 — 알림을 넣은 뒤에 알게 된 비밀 값도 거부 글·일지 한 줄에 나가지 않는다 (리드 결정 S5-52.3)', async () => {
    const e = (env = await bootOrch());
    const secret = `fake-${randomBytes(16).toString('hex')}`;
    const t = waitingTask(e);
    e.core.tasks.hold(t.id, 'error', 'task', '되돌리기 처리 실패 (시험)', 'system');
    const since = e.ctx.store.tasks.require(t.id).hold.reasons[0]!.since;
    const q = alertMain(e.ctx, { kind: 'revert-fail', target: t.id, projectId: e.projectId, taskId: t.id, message: `${t.id} 되돌리기 실패 (시험)\n- 메모: 열쇠 이름 ${secret}`, since })!;
    // 넣을 때는 아직 모르는 값이었다
    expect(e.ctx.store.queue.require(q.id).message).toContain(secret);
    e.ctx.redact.addSecret(secret, 'api-key');
    const cur = e.ctx.store.tasks.require(t.id);
    const r = handUnseenAlertsOnResume(e.ctx, cur, cur.hold.reasons, () => ({ kind: 'none' }))!;
    expect(r.text).toContain(`- 알림 ${q.id} (되돌리기 실패 ${t.id})`);
    expect(r.text).toContain('[가림:');
    expect(r.text).not.toContain(secret);
    expect(r.journal).not.toContain(secret);
  });
});

/**
 * 첫 알림 W1(자동 검사, 3개)을 실은 메인 턴 도중 둘째 보류 B(작업 턴, 1개)가 W2를 넣고, 메인이 그 턴에서 resume_task를 부른다 — 한 번 거부, W2는 그 턴에 실림
 * (프로브 server-s5fix3-alerts-flows/zz-s5af4-cut의 준비를 그 턴의 신원으로)
 */
async function refusedInAlertTurn(e: OrchEnv) {
  const t = waitingTask(e);
  const mk = mainKey(e.projectId);
  const key = alertKey('kill-failed', t.id);
  e.hold.add(mk);
  await blockCheck(e, t, 3);
  await mainTurnUp(e, mk, '첫 알림을 실은 메인 턴');
  const proc = e.liveProc(mk, MAIN_AGENT_ID)!;
  await sleep(5);
  await blockTask(e, t, 1);
  const [w1, w2] = alerts(e, key);
  const first = await toolIn(e, proc.turnId, 'resume_task', { task_id: t.id, reason: '자동 검사 프로세스 3개 정리 확인' });
  expect(first.refused?.code).toBe('conflict');
  expect(first.refused!.message).toContain('하위 프로세스 1개');
  expect(alerts(e, key).map((q) => [q.id, q.state, q.turnId])).toEqual([
    [w1!.id, 'running', proc.turnId],
    [w2!.id, 'running', proc.turnId],
  ]);
  return { t, mk, key, proc, w1: w1!, w2: w2!, launchesBefore: e.launches.length };
}
const CODEX: AiConfig = { kind: 'codex', model: null, effortTier: 'high', effortOverride: null };
/** 프로듀서의 관리 실행(지시 세션) — 이미 일시정지된 팀원의 종료 확인 실패(결정 26의 alert kill-failed:<팀원>)를 만든다 */
const producerRun = (e: OrchEnv, directiveId: string, remaining: number) =>
  e.core.turns.blockUnconfirmedRun(
    { label: '프로듀서 관리 턴', sessionKind: 'directive', sessionKey: directiveKey(directiveId), memberId: e.producerId, projectId: e.projectId, taskId: null, turnId: null },
    { envProblem: null, remaining, cause: null, what: '턴' },
  );

describe('거부 글로 보인 알림은 부른 메인 턴의 일 — 그 턴이 끊기면 다시 전달한다 (리드 결정 S5-49 — S5-45의 받아 마침을 고침)', () => {
  it('거부한 호출은 메인 일지에 서버 기록으로 남는다 — 그 턴·세대·작업, 보인 알림과 다음 호출이 할 일', async () => {
    const e = (env = await bootOrch());
    const { t, proc, w2 } = await refusedInAlertTurn(e);
    const [row] = journalActions(e).filter((r) => r.text.startsWith('resume_task 거부'));
    expect(row).toMatchObject({
      text: `resume_task 거부 — ${t.id}: 아직 받지 않은 알림 ${w2.id}(프로세스 종료 확인 실패 ${t.id})을(를) 거부 글로 보여 줌(이 턴 ${proc.turnId}에 실음) — 다음 resume_task는 재개`,
      turnId: proc.turnId,
      generation: 1,
      projectId: e.projectId,
    });
    expect(row!.refs).toEqual(expect.arrayContaining([{ kind: 'task', id: t.id }]));
    // 재개하지 않았으니 재개 기록(운영 조작)은 없다
    expect(journalActions(e).filter((r) => r.text.includes('(resume_task) — 사유:'))).toEqual([]);
    // 거부 글로 넘긴 활동 기록은 메인 에이전트의 줄이다 — 화면이 memberId로 메인 에이전트의 활동을 고른다 (리드 결정 S5-68)
    expect(e.ctx.store.activity.search({ text: `알림 ${w2.id}을(를) resume_task 거부 글로 메인 에이전트에게 전달`, limit: 5 }).map((a) => a.memberId)).toEqual([MAIN_AGENT_ID]);
  });

  it('A. 거부와 다시 부르기 사이에 운영자가 자리를 바꾸면 새 보유자의 다시 전달이 둘째 트리도 싣는다 — 인계 꾸러미에 그 거부, 새 보유자의 resume_task는 본 뒤에 푼다', async () => {
    const e = (env = await bootOrch());
    const { t, mk, key, launchesBefore } = await refusedInAlertTurn(e);
    e.hold.delete(mk);
    // 나가는 보유자의 턴은 '메인 자리 교체'로 멈추고 실었던 일은 새 보유자에게 다시 넣는다
    await e.core.seat.assign({ holder: { kind: 'launched', ai: CODEX }, by: 'operator', reason: '시험 교체', force: true }).done;
    await alertsSettled(e, key, '새 보유자에게 다시 전달');
    expect(e.core.seat.generation()).toBe(2);
    const seen = e.launches
      .slice(launchesBefore)
      .filter((l) => l.memberId === MAIN_AGENT_ID)
      .map((l) => l.message)
      .join('\n');
    expect(seen).toContain('하위 프로세스 3개');
    expect(seen).toContain('하위 프로세스 1개');
    expect(seen).toContain(`resume_task 거부 — ${t.id}`);
    expect(holdReach(e, t.id)).toEqual([
      ['error', true],
      ['error', true],
    ]);
    expect((await tryResume(e, t.id, '두 트리 정리 확인 (새 보유자)')).data).toMatchObject({ taskId: t.id, state: 'waiting' });
  });

  it('B. 거부 직후 그 턴이 비정상 종료하면 다시 전달이 두 트리를 싣는다 — 앞선 알림의 글은 둘째 알림을 다시 넣은 항목에 한 번', async () => {
    const e = (env = await bootOrch());
    const { t, mk, key, proc, w1, w2, launchesBefore } = await refusedInAlertTurn(e);
    e.hold.delete(mk);
    proc.exit(1);
    await alertsSettled(e, key, '다시 전달');
    const after = e.launches.slice(launchesBefore).filter((l) => l.workKey === mk);
    expect(after).toHaveLength(1);
    expect(after[0]!.message.match(/### \d+\. 보류·실패 처리/g)).toHaveLength(1);
    expect(after[0]!.message).toContain('하위 프로세스 1개');
    expect(count(after[0]!.message, '하위 프로세스 3개')).toBe(count(w1.message, '하위 프로세스 3개'));
    const all = alerts(e, key);
    expect(all.map((q) => q.state)).toEqual(['cancelled', 'done', 'done']);
    expect(all[2]!.message).toContain(ALERT_EARLIER_HEAD);
    expect(e.ctx.store.activity.search({ text: `아직 남은 그 보류의 글은 ${all[2]!.id}에 함께 실음`, limit: 5 })).toHaveLength(1);
    expect(all.map((q) => q.id).slice(0, 2)).toEqual([w1.id, w2.id]);
    expect((await tryResume(e, t.id, '두 트리 정리 확인')).data).toMatchObject({ taskId: t.id, state: 'waiting' });
  });

  it('C. 거부 직후 긴급 정지로 그 턴이 끝나도 정지 해제 뒤의 다시 전달이 두 트리를 싣는다', async () => {
    const e = (env = await bootOrch());
    const { mk, key, launchesBefore } = await refusedInAlertTurn(e);
    await e.invoke('stop.emergency');
    await waitFor(() => e.core.turns.count() === 0, '정지');
    e.hold.delete(mk);
    await e.invoke('stop.release');
    await alertsSettled(e, key, '정지 해제 뒤 다시 전달');
    const seen = e.launches
      .slice(launchesBefore)
      .filter((l) => l.workKey === mk)
      .map((l) => l.message)
      .join('\n');
    expect(seen).toContain('하위 프로세스 3개');
    expect(seen).toContain('하위 프로세스 1개');
  });

  it('E. 거부 직후 40번째 턴이 비정상 종료해 다음 턴이 새 세션(MEM-09)을 열어도 두 트리를 싣는다 — 새 세션의 인계 꾸러미에 그 거부', async () => {
    const e = (env = await bootOrch());
    const { t, mk, key, proc, launchesBefore } = await refusedInAlertTurn(e);
    const s = e.ctx.store.sessions.list({ ref1: MAIN_AGENT_ID, ref2: mk, state: 'open' })[0]!;
    e.ctx.store.sessions.put({ ...s, turnCount: 40 });
    e.hold.delete(mk);
    proc.exit(1);
    await alertsSettled(e, key, '새 세션에 다시 전달');
    const s2 = e.ctx.store.sessions.list({ ref1: MAIN_AGENT_ID, ref2: mk }).at(-1)!;
    expect(s2.id).not.toBe(s.id);
    expect(s2.replaceReason).toContain('MEM-09');
    const after = e.launches.slice(launchesBefore).filter((l) => l.workKey === mk);
    expect(after[0]!.resume).toBeNull();
    const seen = after.map((l) => l.message).join('\n');
    expect(seen).toContain('하위 프로세스 3개');
    expect(seen).toContain('하위 프로세스 1개');
    expect(seen).toContain(`resume_task 거부 — ${t.id}`);
  });

  it('PC가 꺼져도(재시작 복구) 그 턴에 실린 둘째 알림을 다시 넣고 앞선 알림의 글을 옮겨 싣는다 — 첫 전달에 두 트리', async () => {
    let e = (renv = await bootRestartable());
    const oe = e as unknown as OrchEnv;
    const t = waitingTask(oe);
    const mk = mainKey(e.projectId);
    const key = alertKey('kill-failed', t.id);
    e.hold.add(mk);
    await blockCheck(oe, t, 3);
    e.tick();
    await waitFor(() => !!e.liveProc(mk, MAIN_AGENT_ID), '첫 알림을 실은 메인 턴');
    const proc = e.liveProc(mk, MAIN_AGENT_ID)!;
    await sleep(5);
    await blockTask(oe, t, 1);
    const [w1, w2] = alerts(e, key);
    const first = await toolIn(oe, proc.turnId, 'resume_task', { task_id: t.id, reason: '자동 검사 프로세스 3개 정리 확인' });
    expect(first.refused?.code).toBe('conflict');
    expect(e.ctx.store.turns.require(proc.turnId).queueEntryIds).toEqual([w2!.id, w1!.id]);
    e.crash();
    e = renv = await e.reboot({ holdAll: true });
    await waitFor(() => e.launchesOf(mk).length >= 1, '다시 시작한 뒤 첫 메인 턴', 20_000);
    expect(alerts(e, key).map((q) => [q.id, q.state])).toEqual([
      [w1!.id, 'cancelled'],
      [w2!.id, 'running'],
    ]);
    const msg = e.launchesOf(mk)[0]!.message;
    expect(msg.match(/### \d+\. 보류·실패 처리/g)).toHaveLength(1);
    expect(msg).toContain('하위 프로세스 1개');
    expect(msg).toContain('하위 프로세스 3개');
    expect(msg).toContain(ALERT_EARLIER_HEAD);
  });

  // 리드 결정 S5-56이 다시 씀: carryShown은 셋을 가린다 — 실음, 메인 턴이 없음(호출자가 받아 마침), 그 메인 턴이 이미 끝남(대기 그대로). 예전 시험의 두 null은 '메인 턴이 없음'이다
  it('메인 턴에만 싣는다 — 팀원 턴·없는 턴의 ID는 메인 턴이 없는 것(호출자가 받아 마침), 끝난 메인 턴의 ID는 그 턴이 이미 끝난 것(대기 그대로). 어느 쪽도 그 항목을 건드리지 않는다 (리드 결정 S5-49·S5-56)', async () => {
    const e = (env = await bootOrch());
    // 끝난 메인 턴 하나 — 직접 명령(main:general)을 실은 턴. 알림보다 먼저 끝낸다(그 턴이 알림을 싣지 않게)
    enqueue(e.ctx, { kind: 'main_command', memberId: MAIN_AGENT_ID, sessionKey: mainKey(null), projectId: null, priority: 'high', message: '대표 명령 (시험):\n상황을 알려 줘' });
    await e.drain();
    const ended = e.launches.find((l) => l.workKey === mainKey(null) && l.memberId === MAIN_AGENT_ID)!.turnId;
    expect(e.ctx.store.turns.require(ended).endedAt).not.toBeNull();
    const { proc } = await startReview(e, e.qaId);
    const t = waitingTask(e);
    await blockTask(e, t, 1);
    const [w] = alerts(e, alertKey('kill-failed', t.id));
    expect(e.core.turns.carryShown(proc.turnId, [w!])).toEqual({ kind: 'none' });
    expect(e.core.turns.carryShown('U-없는-턴', [w!])).toEqual({ kind: 'none' });
    expect(e.core.turns.carryShown(ended, [w!])).toEqual({ kind: 'gone', turnId: ended });
    expect(e.ctx.store.queue.require(w!.id).state).toBe('queued');
    expect(e.ctx.store.queue.require(w!.id).turnId ?? null).toBeNull();
    expect(e.ctx.store.turns.require(proc.turnId).queueEntryIds).not.toContain(w!.id);
    expect(e.ctx.store.turns.require(ended).queueEntryIds).not.toContain(w!.id);
  });

  it('D. 대조: 같은 거부 뒤 그 턴이 정상으로 끝나면 다시 전달할 것이 없다 — 실은 두 알림 모두 받아 마침, 다시 부르면 재개', async () => {
    const e = (env = await bootOrch());
    const { t, mk, key, proc } = await refusedInAlertTurn(e);
    e.hold.delete(mk);
    proc.finishOk('확인함');
    await alertsSettled(e, key, '정리');
    expect(alerts(e, key).map((q) => q.state)).toEqual(['done', 'done']);
    expect(e.launches.filter((l) => l.workKey === mk)).toHaveLength(1);
    expect((await tryResume(e, t.id, '두 트리 정리 확인')).data).toMatchObject({ taskId: t.id, state: 'waiting' });
  });

  it('보인 알림이 둘(두 키)이어도 둘 다 그 턴에 싣는다 — 그 턴의 다시 부르기는 재개하고(한 번만 거부), 그 턴이 정상으로 끝나면 둘 다 받아 마침 (리드 결정 S5-49·S5-59 6, 프로브 zz-s5f4ti-carry-two)', async () => {
    const e = (env = await bootOrch());
    const t = waitingTask(e);
    const mk = mainKey(e.projectId);
    e.hold.add(mk);
    // W1: 자동 검사의 종료 확인 실패 — 그 알림을 실은 메인 턴이 도는 중
    await blockCheck(e, t, 3);
    await mainTurnUp(e, mk, '첫 알림을 실은 메인 턴');
    const proc = e.liveProc(mk, MAIN_AGENT_ID)!;
    await sleep(5);
    // W2: 같은 키의 둘째 보류(작업 턴, 1개), W3: 다른 키(오류 보류의 되돌리기 실패)
    await blockTask(e, t, 1);
    e.core.tasks.hold(t.id, 'error', 'task', '되돌리기 처리 실패 (시험)', 'system');
    const since = e.ctx.store.tasks.require(t.id).hold.reasons.at(-1)!.since;
    alertMain(e.ctx, { kind: 'revert-fail', target: t.id, projectId: e.projectId, taskId: t.id, message: `${t.id} 되돌리기 실패 (시험)`, since });
    const unseen = alerts(e).filter((q) => q.state === 'queued' && q.taskId === t.id);
    expect(unseen.map((q) => q.alertKey).sort()).toEqual([alertKey('kill-failed', t.id), alertKey('revert-fail', t.id)].sort());
    const first = await toolIn(e, proc.turnId, 'resume_task', { task_id: t.id, reason: '자동 검사 프로세스 3개 정리 확인' });
    expect(first.refused?.code).toBe('conflict');
    for (const q of unseen) expect(first.refused!.message).toContain(`- 알림 ${q.id} (`);
    const now = () => unseen.map((q) => [e.ctx.store.queue.require(q.id).state, e.ctx.store.queue.require(q.id).turnId]);
    expect(now()).toEqual([
      ['running', proc.turnId],
      ['running', proc.turnId],
    ]);
    expect(e.ctx.store.turns.require(proc.turnId).queueEntryIds.slice(0, 2).sort()).toEqual(unseen.map((q) => q.id).sort());
    const second = await toolIn(e, proc.turnId, 'resume_task', { task_id: t.id, reason: '세 트리 모두 정리 확인' });
    expect(second.refused).toBeNull();
    expect(second.data).toMatchObject({ taskId: t.id });
    e.hold.delete(mk);
    proc.finishOk('확인함');
    await e.idle();
    expect(now().map(([s]) => s)).toEqual(['done', 'done']);
  });
});

describe('같은 한 번 거부 — resume_member·resolve_recovery·replace_producer도 메인이 아직 받지 않은 알림을 먼저 보여 준다 (리드 결정 S5-50)', () => {
  it('메인이 건 정지 뒤 종료 확인 실패(27a)의 알림이 대기 중이면 resume_member는 한 번 거부 — 그 트리를 보여 주고 다시 부르면 재개, 조용히 버린 알림 없음 (프로브 zz-s5af4-member)', async () => {
    const e = (env = await bootOrch());
    const d = seedDirective(e);
    const key = alertKey('kill-failed', e.producerId);
    const name = e.ctx.store.members.require(e.producerId).name;
    await e.main('pause_member', { member_id: e.producerId, mode: 'graceful' });
    expect(await producerRun(e, d.id, 2)).toContain(`팀원 일시정지는 그대로 두고 ${HANDED}`);
    const [w] = alerts(e, key);
    expect(w!.state).toBe('queued');
    expect(w!.message).toContain('남은 하위 프로세스 2개');
    const first = await tryMain(e, 'resume_member', { member_id: e.producerId, reason: 'AI 바꿈, 다시 시작' });
    expect(first.refused?.code).toBe('conflict');
    const msg = first.refused!.message;
    expect(msg.split('\n')[0]).toBe(
      `${name}(${e.producerId})은(는) 재개하지 않았습니다 — 이 팀원에 관해 아직 받지 않은(대기 중인) 알림이 있습니다. 그 알림을 아래에 옮겨 적고 받은 것으로 해 두었습니다. 알림에 적힌 것(남은 프로세스 등)을 확인한 뒤 이어 가도 되면 resume_member를 다시 부르세요 — 다음 호출은 재개합니다.`,
    );
    expect(msg).toContain(`- 알림 ${w!.id} (프로세스 종료 확인 실패 ${e.producerId})`);
    expect(msg).toContain(indent(w!.message));
    expect(e.ctx.stop().members[e.producerId]?.paused).toBe(true);
    // 실행 중인 메인 턴이 없는 호출 — 받아 마침
    expect(e.ctx.store.queue.require(w!.id).state).toBe('done');
    expect(e.ctx.store.activity.search({ text: `알림 ${w!.id}을(를) resume_member 거부 글로 메인 에이전트에게 전달`, limit: 5 }).map((a) => a.text)).toEqual([
      `프로세스 종료 확인 실패 ${e.producerId} 알림 ${w!.id}을(를) resume_member 거부 글로 메인 에이전트에게 전달 (${key}, 받은 것으로 둠 — 다음 resume_member는 재개)`,
    ]);
    expect(journalActions(e).find((r) => r.text.startsWith('resume_member 거부'))?.text).toBe(
      `resume_member 거부 — ${name}(${e.producerId}): 아직 받지 않은 알림 ${w!.id}(프로세스 종료 확인 실패 ${e.producerId})을(를) 거부 글로 보여 줌(받은 것으로 둠) — 다음 resume_member는 재개`,
    );
    expect((await tryMain(e, 'resume_member', { member_id: e.producerId, reason: '남은 프로세스 확인함' })).data).toEqual({ memberId: e.producerId, paused: false });
    await ticks(e);
    expect(e.ctx.store.activity.search({ text: '끝난 일의 보류·실패 처리 업무 정리', limit: 20 }).filter((a) => a.text.includes(e.producerId))).toEqual([]);
    expect(notices(e, '프로세스 종료 확인 실패').map((n) => n.body).at(-1)).toContain(HANDED);
  });

  it('main:general 턴에서 부른 resume_member가 거부되면 main:P에서 기다리던 알림이 그 턴에 실린다 — 그 턴이 끊기면 main:P로 다시 넣어 전달한다', async () => {
    const e = (env = await bootOrch());
    const d = seedDirective(e);
    const gk = mainKey(null);
    const pk = mainKey(e.projectId);
    const key = alertKey('kill-failed', e.producerId);
    enqueue(e.ctx, { kind: 'main_command', memberId: MAIN_AGENT_ID, sessionKey: gk, projectId: null, priority: 'high', message: '대표 명령 (시험):\n프로듀서를 다시 돌려 줘' });
    e.hold.add(gk);
    await mainTurnUp(e, gk, '직접 명령 턴');
    const proc = e.liveProc(gk, MAIN_AGENT_ID)!;
    await e.main('pause_member', { member_id: e.producerId, mode: 'graceful' });
    await producerRun(e, d.id, 2);
    const [w] = alerts(e, key);
    expect([w!.state, w!.sessionKey]).toEqual(['queued', pk]);
    const first = await toolIn(e, proc.turnId, 'resume_member', { member_id: e.producerId });
    expect(first.refused?.code).toBe('conflict');
    expect(first.refused!.message).toContain(indent(w!.message));
    const carried = e.ctx.store.queue.require(w!.id);
    expect([carried.state, carried.turnId, carried.sessionKey]).toEqual(['running', proc.turnId, pk]);
    expect(e.ctx.store.turns.require(proc.turnId).queueEntryIds[0]).toBe(w!.id);
    // 그 턴이 끊겼다 — 실은 알림은 제 세션(main:P)으로 다시 넣어 다음 턴이 받는다
    e.hold.delete(gk);
    proc.exit(1);
    await waitFor(
      () => {
        e.tick();
        return e.launches.some((l) => l.workKey === pk);
      },
      'main:P에 다시 전달',
      30_000,
    );
    await e.idle();
    expect(e.launches.find((l) => l.workKey === pk)!.message).toContain('남은 하위 프로세스 2개');
    expect(alerts(e, key).map((q) => [q.state, q.sessionKey])).toEqual([
      ['done', pk],
      ['done', pk],
    ]);
    expect((await tryMain(e, 'resume_member', { member_id: e.producerId })).data).toEqual({ memberId: e.producerId, paused: false });
  });

  it('결정 26의 재개 업무, 예전 대표 정지(legacy-pause), 일시정지된 팀원에게 온 업무(member-paused)의 알림도 한 번 거부 글로 — 다시 부르면 재개', async () => {
    const e = (env = await bootOrch());
    // 프로그램이 건 정지와 그 재개 업무 (결정 26 — pausedMemberId)
    await e.core.stops.pauseMember(e.producerId, 'graceful', 'system', '프로세스 종료를 확인하지 못함 (시험)');
    e.core.turns.handPauseToMain(e.producerId, null);
    const item = e.ctx.store.queue.list({ ref1: MAIN_AGENT_ID, state: 'queued' }).find((q) => q.pausedMemberId === e.producerId)!;
    const first = await tryMain(e, 'resume_member', { member_id: e.producerId });
    expect(first.refused?.code).toBe('conflict');
    expect(first.refused!.message).toContain(`- 알림 ${item.id} (일시정지된 팀원의 재개 ${e.producerId})`);
    expect(first.refused!.message).toContain(indent(item.message));
    expect(e.ctx.store.queue.require(item.id).state).toBe('done');
    expect(e.ctx.store.activity.search({ text: `알림 ${item.id}을(를) resume_member 거부 글로`, limit: 5 }).map((a) => a.text.includes(`(재개 업무 ${e.producerId}, 받은 것으로 둠`))).toEqual([true]);
    expect((await tryMain(e, 'resume_member', { member_id: e.producerId })).data).toEqual({ memberId: e.producerId, paused: false });
    // 1단계 전 대표가 건 정지 — 시작 때 훑기가 넣은 알림
    const s = e.ctx.stop();
    e.ctx.saveStop({ ...s, members: { ...s.members, [e.devId]: { paused: true, mode: 'graceful', by: 'owner', since: e.ctx.now() } } });
    sweepAlerts(e.ctx);
    const [lp] = alerts(e, alertKey('legacy-pause', e.devId));
    expect((await tryMain(e, 'resume_member', { member_id: e.devId })).refused?.message).toContain(`- 알림 ${lp!.id} (예전 대표 정지 ${e.devId})`);
    expect((await tryMain(e, 'resume_member', { member_id: e.devId })).data).toEqual({ memberId: e.devId, paused: false });
    // 재개 업무를 대표에게 넘긴 뒤 새 업무가 온 일시정지 팀원 (리드 결정 35)
    await e.main('pause_member', { member_id: e.qaId, mode: 'graceful' });
    const mp = alertMain(e.ctx, { kind: 'member-paused', target: e.qaId, projectId: e.projectId, message: memberAlertText(e.ctx, e.qaId, `${e.qaId} — 일시정지된 채 새 업무가 왔습니다 (시험)`), since: e.ctx.now() })!;
    expect((await tryMain(e, 'resume_member', { member_id: e.qaId })).refused?.message).toContain(`- 알림 ${mp.id} (일시정지된 팀원에게 온 업무 ${e.qaId})`);
    expect((await tryMain(e, 'resume_member', { member_id: e.qaId })).data).toEqual({ memberId: e.qaId, paused: false });
  });

  it('resolve_recovery도 그 복구 확인의 알림이 대기 중이면 한 번 거부 — 다시 부르면 처리한다. 다른 거부(사유 없음·잘못된 action·병합 커밋 없음)가 먼저고, 이미 처리된 확인은 그대로', async () => {
    const e = (env = await bootOrch());
    const exec = (requestId: string, taskId: string, kind: ExecRecord['kind'] = 'deploy'): ExecRecord => {
      const x: ExecRecord = { requestId, kind, projectId: e.projectId, taskId, cwd: e.projectDir, command: '배포 스크립트', target: '배포', state: 'unknown', startedAt: e.ctx.now(), endedAt: e.ctx.now(), result: { recovered: '실행 여부를 확인할 수 없음 (시험)' } };
      e.ctx.store.execs.insert(x);
      return x;
    };
    const recovery = e.core.recovery as unknown as { holdForRecovery(x: ExecRecord, note: string): number };
    const t = waitingTask(e);
    recovery.holdForRecovery(exec('X-2001', t.id), '외부 실행이 끝났는지 확인할 수 없습니다 (시험)');
    const [a] = alerts(e, alertKey('recovery', 'X-2001'));
    const stateOf = (q: QueueEntry) => e.ctx.store.queue.require(q.id).state;
    expect((await tryMain(e, 'resolve_recovery', { recovery_id: 'X-2001', action: 'retry', reason: '' })).refused?.code).toBe('invalid');
    expect((await tryMain(e, 'resolve_recovery', { recovery_id: 'X-2001', action: 'redo' })).refused?.code).toBe('invalid');
    expect(stateOf(a!)).toBe('queued');
    const first = await tryMain(e, 'resolve_recovery', { recovery_id: 'X-2001', action: 'retry' });
    expect(first.refused?.code).toBe('conflict');
    expect(first.refused!.message.split('\n')[0]).toBe(
      '복구 확인 X-2001은(는) 처리하지 않았습니다 — 이 복구 확인의 알림을 아직 받지 않았습니다(대기 중). 그 알림을 아래에 옮겨 적고 받은 것으로 해 두었습니다. 알림에 적힌 것을 확인한 뒤 이어 가도 되면 resolve_recovery를 다시 부르세요 — 다음 호출은 처리합니다.',
    );
    expect(first.refused!.message).toContain(`- 알림 ${a!.id} (복구 확인 X-2001)`);
    expect(first.refused!.message).toContain(indent(a!.message));
    expect(e.ctx.store.execs.require('X-2001').state).toBe('unknown');
    expect(e.ctx.store.tasks.require(t.id).hold.reasons.map((r) => [r.kind, r.refId])).toEqual([['recovery_check', 'X-2001']]);
    expect(stateOf(a!)).toBe('done');
    expect(holdReach(e, t.id)).toEqual([['recovery_check', true]]);
    expect(journalActions(e).find((r) => r.text.startsWith('resolve_recovery 거부'))?.text).toBe(
      `resolve_recovery 거부 — 복구 확인 X-2001: 아직 받지 않은 알림 ${a!.id}(복구 확인 X-2001)을(를) 거부 글로 보여 줌(받은 것으로 둠) — 다음 resolve_recovery는 처리`,
    );
    expect((await tryMain(e, 'resolve_recovery', { recovery_id: 'X-2001', action: 'retry' })).data).toMatchObject({ recoveryId: 'X-2001', action: 'retry' });
    expect(e.ctx.store.execs.require('X-2001').state).not.toBe('unknown');
    expect(e.ctx.store.tasks.require(t.id).hold.reasons.some((r) => r.kind === 'recovery_check')).toBe(false);
    // 병합 기록을 찾지 못하는 '이미 반영됨'(git_merge)은 그 거부가 먼저다 — 알림은 그대로 대기 중
    const t2 = waitingTask(e, '결제 화면');
    recovery.holdForRecovery(exec('X-2002', t2.id, 'git_merge'), '병합이 끝났는지 확인할 수 없습니다 (시험)');
    const [b] = alerts(e, alertKey('recovery', 'X-2002'));
    const applied = await tryMain(e, 'resolve_recovery', { recovery_id: 'X-2002', action: 'applied' });
    expect(applied.refused?.code).toBe('conflict');
    expect(applied.refused!.message).toContain('병합 커밋을 찾지 못했습니다');
    expect(stateOf(b!)).toBe('queued');
    // 이미 처리된 확인은 아무것도 하지 않는다 — 그 알림은 끝난 일이라 거부하지 않는다
    e.ctx.store.execs.put({ ...e.ctx.store.execs.require('X-2002'), state: 'succeeded' });
    expect((await tryMain(e, 'resolve_recovery', { recovery_id: 'X-2002', action: 'retry' })).refused).toBeNull();
    expect(stateOf(b!)).toBe('queued');
    expect(e.ctx.store.activity.search({ text: 'resolve_recovery 거부 글로', limit: 5 })).toHaveLength(1);
  });

  it('replace_producer도 지금 프로듀서에 관한 대기 알림을 한 번 거부 글로 보여 준다 — 그 프로듀서 앞에 멈춘 관리 업무를 새 프로듀서가 바로 이어 받기 때문. 다시 부르면 바꾸고, 끝난 일은 보지 않는다', async () => {
    const e = (env = await bootOrch());
    const old = e.producerId;
    const name = e.ctx.store.members.require(old).name;
    await e.core.stops.pauseMember(old, 'graceful', 'system', '프로세스 종료를 확인하지 못함 (시험)');
    e.core.turns.handPauseToMain(old, null);
    const item = e.ctx.store.queue.list({ ref1: MAIN_AGENT_ID, state: 'queued' }).find((q) => q.pausedMemberId === old)!;
    const first = await tryMain(e, 'replace_producer', { project_id: e.projectId });
    expect(first.refused?.code).toBe('conflict');
    expect(first.refused!.message.split('\n')[0]).toBe(
      `프로듀서 ${name}(${old})을(를) 바꾸지 않았습니다 — 이 프로듀서에 관해 아직 받지 않은(대기 중인) 알림이 있습니다. 바꾸면 이 프로듀서 앞에 멈춘 관리 업무를 새 프로듀서가 바로 이어 받습니다. 그 알림을 아래에 옮겨 적고 받은 것으로 해 두었습니다. 알림에 적힌 것(남은 프로세스 등)을 확인한 뒤 이어 가도 되면 replace_producer를 다시 부르세요 — 다음 호출은 바꿉니다.`,
    );
    expect(first.refused!.message).toContain(`- 알림 ${item.id} (일시정지된 팀원의 재개 ${old})`);
    expect(e.ctx.store.projects.require(e.projectId).producerId).toBe(old);
    expect(e.ctx.store.members.require(old).deletedAt).toBeFalsy();
    expect(e.ctx.store.queue.require(item.id).state).toBe('done');
    const second = await tryMain(e, 'replace_producer', { project_id: e.projectId });
    expect(second.data).toMatchObject({ projectId: e.projectId, previousProducerId: old });
    const np = e.ctx.store.projects.require(e.projectId).producerId;
    expect(np).not.toBe(old);
    // 끝난 일은 보지 않는다 — 새 프로듀서의 종료 확인 실패 알림이 대기 중이어도 그 정지가 이미 풀렸으면 거부하지 않는다
    await e.main('pause_member', { member_id: np, mode: 'graceful' });
    const dead = alertMain(e.ctx, { kind: 'kill-failed', target: np, projectId: e.projectId, message: memberAlertText(e.ctx, np, `${np} — 이전 실행의 종료를 확인하지 못함 (시험)`), since: e.ctx.now() })!;
    await e.internal('members.resume', np);
    expect(deadWorkReason(e.ctx, e.ctx.store.queue.require(dead.id))).not.toBeNull();
    expect((await tryMain(e, 'replace_producer', { project_id: e.projectId })).refused).toBeNull();
  });
});

/**
 * 메인 턴 X(대표 명령, main:P)를 붙잡아 띄우고, X가 뜬 뒤 걸린 git_merge 복구 확인(작업 보류)과 그 대기 알림 W를 만든 다음, X의 신원으로 resolve_recovery(applied)를
 * 부른다 — 그 호출은 git.log에서 기다린다(문을 열 때까지). 프로브 server-s5fix4-alerts-flows/zz-s5af5-recoveryrace의 준비 (리드 결정 S5-56)
 */
async function recoveryInGatedTurn(e: OrchEnv) {
  const mk = mainKey(e.projectId);
  enqueue(e.ctx, { kind: 'main_command', memberId: MAIN_AGENT_ID, sessionKey: mk, projectId: e.projectId, priority: 'high', message: '대표 명령 (시험):\n복구 확인을 정리해 줘' });
  e.hold.add(mk);
  await mainTurnUp(e, mk, '메인 턴 X');
  const proc = e.liveProc(mk, MAIN_AGENT_ID)!;
  const t = waitingTask(e, '결제 화면');
  const x: ExecRecord = {
    requestId: 'X-3001',
    kind: 'git_merge',
    projectId: e.projectId,
    taskId: t.id,
    cwd: e.projectDir,
    command: 'git merge (시험)',
    target: 'main',
    state: 'unknown',
    startedAt: e.ctx.now(),
    endedAt: e.ctx.now(),
    result: { recovered: '병합이 끝났는지 확인할 수 없음 (시험)' },
  };
  e.ctx.store.execs.insert(x);
  (e.core.recovery as unknown as { holdForRecovery(x: ExecRecord, note: string): number }).holdForRecovery(x, '병합이 끝났는지 확인할 수 없습니다 (시험)');
  const [w] = alerts(e, alertKey('recovery', 'X-3001'));
  expect(w!.state).toBe('queued');
  // git.log가 느리다(큰 저장소·느린 디스크) — 문으로 붙잡는다
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let called = false;
  const merged = [{ sha: 'c'.repeat(40), parents: [], subject: `[${t.id}] 병합`, body: `Wook-Task: ${t.id}` }];
  vi.spyOn(e.ctx.deps.git, 'log').mockImplementation(async () => {
    called = true;
    await gate;
    return merged;
  });
  const launchesBefore = e.launches.length;
  const call = e.tool(proc.turnId, 'resolve_recovery', { recovery_id: 'X-3001', action: 'applied', reason: '병합 커밋 확인' });
  await waitFor(() => called, 'resolve_recovery가 git.log를 부름');
  return { t, mk, proc, w: w!, call, release, merged, launchesBefore };
}
/** 그 턴이 이미 끝나 대기 그대로 둔 resolve_recovery 거부의 첫 줄 (리드 결정 S5-56) */
const recoveryGoneHead = (turnId: string) =>
  `복구 확인 X-3001은(는) 처리하지 않았습니다 — 이 복구 확인의 알림을 아직 받지 않았습니다(대기 중). 그 알림을 아래에 옮겨 적었지만 이 호출을 한 메인 턴(${turnId})이 이미 끝나, 받은 것으로 하지 않고 대기 그대로 두었습니다 — 다음 메인 턴이 받습니다. 그 턴에서 알림에 적힌 것을 확인한 뒤 이어 가도 되면 resolve_recovery를 다시 부르세요.`;

describe('부른 메인 턴이 이미 끝난 한 번 거부는 알림을 대기 그대로 둔다 — 다음 메인 턴이 받는다 (리드 결정 S5-56 — S5-49를 고침)', () => {
  it('R. resolve_recovery(applied)가 git.log를 기다리는 사이 긴급 정지로 부른 턴이 끝나면 — 거부하되 알림은 대기 그대로(받아 마치지 않음), 정지 해제 뒤 메인 턴이 그 알림을 받은 다음에야 다시 부른 resolve_recovery가 처리한다 (프로브 zz-s5af5-recoveryrace)', async () => {
    const e = (env = await bootOrch());
    const { t, mk, proc, w, call, release, merged, launchesBefore } = await recoveryInGatedTurn(e);
    await e.invoke('stop.emergency');
    await waitFor(() => e.core.turns.count() === 0, '긴급 정지로 턴 X가 끝남');
    await sleep(20);
    release();
    const r = await call;
    expect(!r.ok && r.code).toBe('conflict');
    expect(!r.ok && r.message.split('\n')[0]).toBe(recoveryGoneHead(proc.turnId));
    expect(!r.ok && r.message).toContain(`- 알림 ${w.id} (복구 확인 X-3001)`);
    expect(!r.ok && r.message).toContain(indent(w.message));
    // 대기 그대로 — 받아 마치지도, 끝난 턴에 싣지도 않았다. 복구 확인도 그대로
    const after = e.ctx.store.queue.require(w.id);
    expect([after.state, after.turnId ?? null]).toEqual(['queued', null]);
    expect(e.ctx.store.turns.require(proc.turnId).queueEntryIds).not.toContain(w.id);
    expect(e.ctx.store.execs.require('X-3001').state).toBe('unknown');
    expect(e.ctx.store.activity.search({ text: `알림 ${w.id}을(를) resolve_recovery 거부 글에 옮겨 적음`, limit: 5 }).map((a) => a.text)).toEqual([
      `복구 확인 X-3001 알림 ${w.id}을(를) resolve_recovery 거부 글에 옮겨 적음 (${alertKey('recovery', 'X-3001')}, 부른 턴 ${proc.turnId}이(가) 이미 끝나 대기 그대로 둠 — 다음 메인 턴이 받음)`,
    ]);
    expect(journalActions(e).find((row) => row.text.startsWith('resolve_recovery 거부'))?.text).toBe(
      `resolve_recovery 거부 — 복구 확인 X-3001: 아직 받지 않은 알림 ${w.id}(복구 확인 X-3001)을(를) 거부 글에 옮겨 적음(부른 턴 ${proc.turnId}이(가) 이미 끝나 대기 그대로 둠 — 다음 메인 턴이 받음)`,
    );
    expect(holdReach(e, t.id).find(([k]) => k === 'recovery_check')).toEqual(['recovery_check', true]);
    // 정지 해제 — 다음 메인 턴이 그 알림을 받는다
    e.hold.delete(mk);
    await e.invoke('stop.release');
    await waitFor(
      () => {
        e.tick();
        return e.core.turns.count() === 0 && e.ctx.store.queue.list({ ref1: MAIN_AGENT_ID, state: ['queued', 'running'] }).length === 0;
      },
      '정지 해제 뒤 메인 정리',
      30_000,
    );
    const got = e.ctx.store.queue.require(w.id);
    expect(got.state).toBe('done');
    const carrier = e.launches.slice(launchesBefore).find((l) => l.turnId === got.turnId);
    expect(carrier?.memberId).toBe(MAIN_AGENT_ID);
    expect(carrier?.message).toContain('복구 확인 X-3001');
    expect(holdReach(e, t.id).find(([k]) => k === 'recovery_check')).toEqual(['recovery_check', true]);
    // 그 알림을 메인 턴이 받은 뒤의 resolve_recovery는 처리한다
    vi.restoreAllMocks();
    vi.spyOn(e.ctx.deps.git, 'log').mockResolvedValue(merged);
    expect((await tryMain(e, 'resolve_recovery', { recovery_id: 'X-3001', action: 'applied' })).data).toMatchObject({ recoveryId: 'X-3001', action: 'applied', state: 'succeeded' });
    expect(e.ctx.store.execs.require('X-3001').state).toBe('succeeded');
  });

  it('S. 같은 기다림 사이 운영자가 자리를 바꿔 부른 턴이 끝나도 같다 — 거부, 알림은 대기 그대로, 새 보유자의 메인 턴이 그 알림을 받은 다음에 resolve_recovery가 처리한다', async () => {
    const e = (env = await bootOrch());
    const { mk, proc, w, call, release, merged, launchesBefore } = await recoveryInGatedTurn(e);
    const swap = e.core.seat.assign({ holder: { kind: 'launched', ai: CODEX }, by: 'operator', reason: '시험 교체', force: true });
    await waitFor(() => e.core.turns.count() === 0, '자리 교체로 턴 X가 끝남');
    release();
    const r = await call;
    await swap.done;
    expect(e.core.seat.generation()).toBe(2);
    expect(!r.ok && r.code).toBe('conflict');
    expect(!r.ok && r.message.split('\n')[0]).toBe(recoveryGoneHead(proc.turnId));
    const after = e.ctx.store.queue.require(w.id);
    expect([after.state, after.turnId ?? null]).toEqual(['queued', null]);
    expect(e.ctx.store.execs.require('X-3001').state).toBe('unknown');
    e.hold.delete(mk);
    await alertsSettled(e, alertKey('recovery', 'X-3001'), '새 보유자의 메인 턴이 받음');
    const got = e.ctx.store.queue.require(w.id);
    expect(got.state).toBe('done');
    const carrier = e.launches.slice(launchesBefore).find((l) => l.turnId === got.turnId)!;
    expect(carrier.memberId).toBe(MAIN_AGENT_ID);
    expect(carrier.message).toContain('복구 확인 X-3001');
    // 그 턴은 새 보유자의 것이다 (세대 2의 토큰). 거부한 호출은 제 턴·세대(1)로 일지에 남는다 — 교체 뒤에 끝난 호출이라 교체 때 만든 인계 꾸러미에는 없다
    expect(e.identity(got.turnId!).seatGeneration).toBe(2);
    expect(journalActions(e).find((row) => row.text.startsWith('resolve_recovery 거부'))).toMatchObject({ turnId: proc.turnId, generation: 1 });
    vi.restoreAllMocks();
    vi.spyOn(e.ctx.deps.git, 'log').mockResolvedValue(merged);
    expect((await tryMain(e, 'resolve_recovery', { recovery_id: 'X-3001', action: 'applied' })).data).toMatchObject({ recoveryId: 'X-3001', state: 'succeeded' });
  });

  it('resume_task·resume_member도 같은 갈래다 — 끝난 메인 턴의 거부는 대기 그대로·참인 글, 메인 턴이 없는 호출만 받아 마침(S5-49 그대로)', async () => {
    const e = (env = await bootOrch());
    const t = waitingTask(e);
    await blockTask(e, t, 1);
    const [w] = alerts(e, alertKey('kill-failed', t.id));
    const cur = e.ctx.store.tasks.require(t.id);
    const gone = handUnseenAlertsOnResume(e.ctx, cur, cur.hold.reasons, () => ({ kind: 'gone', turnId: 'TN-끝난-턴' }))!;
    expect(gone.text.split('\n')[0]).toBe(
      `${t.id}은(는) 재개하지 않았습니다 — 재개하면 함께 풀릴 보류 가운데 아직 받지 않은(대기 중인) 알림이 있습니다. 그 알림을 아래에 옮겨 적었지만 이 호출을 한 메인 턴(TN-끝난-턴)이 이미 끝나, 받은 것으로 하지 않고 대기 그대로 두었습니다 — 다음 메인 턴이 받습니다. 그 턴에서 알림에 적힌 것을 확인한 뒤 이어 가도 되면 resume_task를 다시 부르세요.`,
    );
    expect(gone.text).toContain(`- 알림 ${w!.id} (프로세스 종료 확인 실패 ${t.id})`);
    expect(gone.journal).toBe(
      `resume_task 거부 — ${t.id}: 아직 받지 않은 알림 ${w!.id}(프로세스 종료 확인 실패 ${t.id})을(를) 거부 글에 옮겨 적음(부른 턴 TN-끝난-턴이(가) 이미 끝나 대기 그대로 둠 — 다음 메인 턴이 받음)`,
    );
    expect([e.ctx.store.queue.require(w!.id).state, e.ctx.store.queue.require(w!.id).turnId ?? null]).toEqual(['queued', null]);
    // 거부 글에 옮겨 적은 활동 기록은 메인 에이전트의 줄이다 (리드 결정 S5-68)
    expect(e.ctx.store.activity.search({ text: `알림 ${w!.id}을(를) resume_task 거부 글에 옮겨 적음`, limit: 5 }).map((a) => a.memberId)).toEqual([MAIN_AGENT_ID]);
    // 대기 그대로라 다음 호출도 다시 보여 준다(메인 턴이 없는 호출 — 이번에는 받아 마침)
    const none = await tryResume(e, t.id, '확인함');
    expect(none.refused?.code).toBe('conflict');
    expect(none.refused!.message.split('\n')[0]).toContain('그 알림을 아래에 옮겨 적고 받은 것으로 해 두었습니다');
    expect(e.ctx.store.queue.require(w!.id).state).toBe('done');
    expect(e.ctx.store.activity.search({ text: `알림 ${w!.id}을(를) resume_task 거부 글로 메인 에이전트에게 전달`, limit: 5 }).map((a) => a.memberId)).toEqual([MAIN_AGENT_ID]);
    expect((await tryResume(e, t.id, '확인함')).data).toMatchObject({ taskId: t.id, state: 'waiting' });
    // resume_member — 프로듀서의 종료 확인 실패(27a)
    const d = seedDirective(e);
    await e.main('pause_member', { member_id: e.producerId, mode: 'graceful' });
    await producerRun(e, d.id, 2);
    const [m] = alerts(e, alertKey('kill-failed', e.producerId));
    const memberGone = handUnseenOnMemberRelease(e.ctx, e.producerId, 'resume_member', () => ({ kind: 'gone', turnId: 'TN-끝난-턴' }))!;
    expect(memberGone.text.split('\n')[0]).toContain('이 호출을 한 메인 턴(TN-끝난-턴)이 이미 끝나, 받은 것으로 하지 않고 대기 그대로 두었습니다 — 다음 메인 턴이 받습니다. 그 턴에서 알림에 적힌 것(남은 프로세스 등)을 확인한 뒤 이어 가도 되면 resume_member를 다시 부르세요.');
    expect(memberGone.text.split('\n')[0]).not.toContain('다음 호출은');
    expect(e.ctx.store.queue.require(m!.id).state).toBe('queued');
  });
});

describe('팀원 알림의 출구는 그 팀원에게 참이다 — 프로듀서면 그 프로젝트의 replace_producer, 다른 팀원이면 remove_member (리드 결정 S5-57)', () => {
  /** 알림 글의 끝 줄(출구) */
  const exitLine = (q: { message: string }) => q.message.split('\n').at(-1)!;
  const PRODUCER_EXIT = /replace_producer\(project_id="([^"]+)", reason="…"\)/;

  it('프로듀서의 종료 확인 실패(27a) — 그 프로젝트 ID로 replace_producer를 적고 remove_member로는 지울 수 없다고 적는다. 적힌 호출은 받고, remove_member는 실제로 거부한다 (프로브 zz-s5af5-producerexit)', async () => {
    const e = (env = await bootOrch());
    // 둘째 프로젝트의 프로듀서 — 출구가 그 프로젝트의 ID를 적는지
    const p2 = await e.internal('projects.create', { mode: 'new', path: `${e.projectDir}-둘째`, name: '둘째' });
    const prod = p2.producerId;
    await e.main('pause_member', { member_id: prod, mode: 'graceful' });
    await e.core.turns.blockUnconfirmedRun(
      { label: '프로듀서 관리 턴', sessionKind: 'directive', sessionKey: directiveKey('D-9999'), memberId: prod, projectId: p2.id, taskId: null, turnId: null },
      { envProblem: null, remaining: 2, cause: null, what: '턴' },
    );
    const [w] = alerts(e, alertKey('kill-failed', prod));
    const exit = exitLine(w!);
    expect(exit).toContain(`resume_member(member_id="${prod}", reason="…")`);
    expect(exit).toContain(`replace_producer(project_id="${p2.id}", reason="…")`);
    expect(exit).toContain('프로듀서는 remove_member로 지울 수 없습니다');
    // 리드 결정 S5-70 2가 다른 팀원의 출구를 정확한 호출로 바꿨다 — 프로듀서의 출구에는 그 호출이 없다
    expect(exit).not.toContain('remove_member(member_id=');
    // 적힌 말이 참이다 — remove_member는 프로듀서를 거부하고, 적힌 replace_producer 호출은 받는다(메인이 그 알림을 받은 뒤)
    expect((await tryMain(e, 'remove_member', { member_id: prod })).refused).toMatchObject({ code: 'forbidden', message: '프로듀서는 삭제할 수 없고 교체만 할 수 있습니다 (ORG-04)' });
    markDone(e, w!);
    const pid = PRODUCER_EXIT.exec(exit)![1]!;
    expect((await tryMain(e, 'replace_producer', { project_id: pid })).data).toMatchObject({ projectId: p2.id, previousProducerId: prod });
    expect(e.ctx.store.projects.require(p2.id).producerId).not.toBe(prod);
    expect(e.ctx.store.projects.require(e.projectId).producerId).toBe(e.producerId);
  });

  /** 출구 글의 remove_member 호출 — 그 도구의 인자 모양 그대로인지 보려고 인자를 뽑는다 (리드 결정 S5-70 2) */
  const REMOVE_EXIT = /remove_member\((member_id="[^"]+")\)/;
  const callArgs = (inner: string): Record<string, string> => Object.fromEntries([...inner.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1]!, m[2]!]));

  // 리드 결정 S5-70 2가 다시 씀: 다른 팀원의 출구는 '…remove_member도 됩니다'에서 그 팀원 ID를 넣은 정확한 호출 remove_member(member_id="…")로 — 그 도구는 member_id만 받는다
  it('다른 팀원(예전 대표 정지 legacy-pause)은 그 팀원 ID를 넣은 remove_member 호출 — 그 도구의 인자 모양 그대로이고 적힌 그대로 부르면 받는다. 글을 만들 때의 팀원으로 고른다(같은 함수의 member-paused도 프로듀서면 replace_producer)', async () => {
    const e = (env = await bootOrch());
    const s = e.ctx.stop();
    e.ctx.saveStop({ ...s, members: { ...s.members, [e.qaId]: { paused: true, mode: 'graceful', by: 'owner', since: e.ctx.now() } } });
    sweepAlerts(e.ctx);
    const [lp] = alerts(e, alertKey('legacy-pause', e.qaId));
    const exit = exitLine(lp!);
    expect(exit).toContain(`resume_member(member_id="${e.qaId}", reason="…")`);
    expect(exit).toContain(`더 쓰지 않을 팀원이면 remove_member(member_id="${e.qaId}")로 지워도 됩니다.`);
    expect(exit).not.toContain('replace_producer');
    // 적힌 호출은 그 도구의 인자 모양 그대로다 — 그 도구가 받지 않는 인자(reason 등)도 빠진 인자도 없다
    const args = callArgs(REMOVE_EXIT.exec(exit)![1]!);
    expect(args).toEqual({ member_id: e.qaId });
    expect(z.object(TOOL_SPECS.find((x) => x.name === 'remove_member')!.input).strict().safeParse(args).success).toBe(true);
    markDone(e, lp!);
    expect((await tryMain(e, 'remove_member', args)).refused).toBeNull();
    expect(e.ctx.store.members.require(e.qaId).deletedAt).toBeTruthy();
    // 같은 글 함수(member-paused·legacy-pause·kill-failed:<팀원>이 함께 쓴다) — 이 프로젝트의 프로듀서면 replace_producer, 같은 프로젝트의 다른 팀원이면 remove_member
    expect(PRODUCER_EXIT.exec(exitLine({ message: memberAlertText(e.ctx, e.producerId, `${e.producerId} — 일시정지된 채 새 업무가 왔습니다 (시험)`) }))?.[1]).toBe(e.projectId);
    const dev = exitLine({ message: memberAlertText(e.ctx, e.devId, `${e.devId} — 일시정지된 채 새 업무가 왔습니다 (시험)`) });
    expect(dev).toContain(`더 쓰지 않을 팀원이면 remove_member(member_id="${e.devId}")로 지워도 됩니다.`);
    expect(dev).not.toContain('replace_producer');
  });

  it('맡은 작업이 남은 팀원(예전 대표 정지 legacy-pause)은 그 작업을 재배정하거나 취소한 뒤 remove_member — 적힌 차례대로 하면 모두 받고, 건너뛰면 remove_member가 거부한다 (리드 결정 S5-75, 프로브 zz-s5af7-deleted D2)', async () => {
    const e = (env = await bootOrch());
    const d = seedDirective(e);
    const mk = (title: string) =>
      e.core.tasks.create({ directiveId: d.id, title, goal: title, type: 'development', assigneeId: e.devId, acceptanceCriteria: ['동작한다'], outputMode: 'repo' }, e.producerId);
    const t1 = mk('로그인 화면');
    const t2 = mk('설정 화면');
    const s = e.ctx.stop();
    e.ctx.saveStop({ ...s, members: { ...s.members, [e.devId]: { paused: true, mode: 'graceful', by: 'owner', since: e.ctx.now() } } });
    sweepAlerts(e.ctx);
    const [lp] = alerts(e, alertKey('legacy-pause', e.devId));
    const exit = exitLine(lp!);
    expect(exit).toContain(`더 쓰지 않을 팀원이면 맡은 작업(${t1.id}, ${t2.id})을 재배정하거나 취소한 뒤 remove_member(member_id="${e.devId}")로 지워도 됩니다.`);
    const args = callArgs(REMOVE_EXIT.exec(exit)![1]!);
    expect(args).toEqual({ member_id: e.devId });
    markDone(e, lp!);
    // 앞 조건을 건너뛰면 remove_member가 거부한다 — 그래서 글이 그 조건을 적는다
    expect((await tryMain(e, 'remove_member', args)).refused).toMatchObject({ code: 'conflict', message: `진행 중인 작업이 있습니다 (${t1.id}, ${t2.id}). 먼저 재배정하거나 취소하세요` });
    // 적힌 차례 — 하나는 재배정(프로듀서의 update_task가 부르는 같은 재배정), 하나는 취소(cancel_task). 그 뒤 적힌 그대로의 remove_member를 받는다
    e.core.tasks.update(t1.id, { assigneeId: e.qaId }, e.producerId);
    expect(e.ctx.store.tasks.require(t1.id).assigneeId).toBe(e.qaId);
    expect((await tryMain(e, 'cancel_task', { task_id: t2.id, reason: '더 하지 않음 (시험)' })).refused).toBeNull();
    expect((await tryMain(e, 'remove_member', args)).refused).toBeNull();
    expect(e.ctx.store.members.require(e.devId).deletedAt).toBeTruthy();
    // 앞 조건은 글을 만들 때의 맡은 작업이다 — 그 작업을 재배정받은 팀원의 글은 이제 그 작업을 적는다
    expect(exitLine({ message: memberAlertText(e.ctx, e.qaId, `${e.qaId} — 일시정지된 채 새 업무가 왔습니다 (시험)`) })).toContain(
      `더 쓰지 않을 팀원이면 맡은 작업(${t1.id})을 재배정하거나 취소한 뒤 remove_member(member_id="${e.qaId}")로 지워도 됩니다.`,
    );
  });
});

describe('도는 알림의 같은 보류를 새 줄과 함께 다시 알리면 그 줄은 대기 항목으로 (리드 결정 S5-51 — S5-25 규칙 1에 더함)', () => {
  it('같은 보류를 그 알림이 도는 중에 다른 실행(새 프로세스 트리)으로 다시 알리면 그 줄만 실은 새 대기 항목 — 대표 알림은 넘긴 사실, 다음 다시 알림은 그 항목에 더하고, 새 것이 없으면 도는 항목을 돌려준다', async () => {
    const e = (env = await bootOrch());
    const t = waitingTask(e);
    const mk = mainKey(e.projectId);
    const key = alertKey('kill-failed', t.id);
    const block = (label: string, remaining: number) =>
      e.core.turns.blockUnconfirmedRun(
        { label, sessionKind: 'task', sessionKey: taskKey(t.id), memberId: e.devId, projectId: e.projectId, taskId: t.id, turnId: null },
        { envProblem: null, remaining, cause: null, what: '턴' },
      );
    e.hold.add(mk);
    await block(`${t.id} 작업 턴`, 1);
    await mainTurnUp(e, mk, '첫 알림을 실은 메인 턴');
    const proc = e.liveProc(mk, MAIN_AGENT_ID)!;
    const [w1] = alerts(e, key);
    expect(w1!.state).toBe('running');
    // 같은 글로 다시 — 새 줄이 없으니 도는 항목이 싣는다
    expect(await block(`${t.id} 작업 턴`, 1)).toContain(HANDED);
    expect(alerts(e, key)).toHaveLength(1);
    // 다른 실행(검수 턴, 2개)으로 다시 — 그 턴은 이미 글을 읽었다. 그 줄만 실은 새 대기 항목 (출구 문장·같은 보류 사유 줄은 되풀이하지 않는다)
    expect(await block(`${t.id} 검수 턴`, 2)).toContain(`작업을 보류하고 ${HANDED}`);
    const [, w2] = alerts(e, key);
    expect(w2!.state).toBe('queued');
    expect(w2!.message).toBe(`${t.id} "로그인 화면" — ${t.id} 검수 턴의 프로세스 종료를 확인하지 못해 보류됨\n${ALERT_JOINED_HEAD}\n  - 프로세스: ${t.id} 검수 턴 — 남은 하위 프로세스 2개`);
    expect(e.ctx.store.queue.require(w1!.id).message).toBe(w1!.message);
    expect(e.ctx.store.activity.search({ text: `도는 중인 같은 알림 ${w1!.id}에 없는 줄만 실음`, limit: 5 }).map((a) => a.text)).toEqual([
      `프로세스 종료 확인 실패 ${t.id}을(를) 메인 에이전트에게 넘김 (${key}, ${w2!.id} — 도는 중인 같은 알림 ${w1!.id}에 없는 줄만 실음)`,
    ]);
    // 같은 글로 또 다시 — 이미 간 줄뿐이라 그대로, 새 항목 없음
    expect(await block(`${t.id} 검수 턴`, 2)).toContain(HANDED);
    expect(alerts(e, key)).toHaveLength(2);
    expect(e.ctx.store.queue.require(w2!.id).message).toBe(w2!.message);
    // 셋째 실행 — 새 줄은 대기 중인 그 항목에 더한다(S5-44 1). 도는 항목에 있던 줄(출구·보류 사유)은 되풀이하지 않는다
    await block(`${t.id} 시험 실행`, 3);
    expect(alerts(e, key)).toHaveLength(2);
    const w2b = e.ctx.store.queue.require(w2!.id);
    expect(w2b.createdAt).toBe(w2!.createdAt);
    expect(w2b.message.startsWith(`${w2!.message}\n${ALERT_JOINED_HEAD}\n  ${t.id} "로그인 화면" — `)).toBe(true);
    expect(w2b.message).toContain(`  - 프로세스: ${t.id} 시험 실행 — 남은 하위 프로세스 3개`);
    expect(w2b.message).not.toContain('resume_task(');
    expect(w2b.message).not.toContain('- 보류 사유(');
    expect(holdReach(e, t.id)).toEqual([['error', true]]);
    // 그 턴이 끝나면 다음 메인 턴이 새 줄을 싣는다
    e.hold.delete(mk);
    proc.finishOk('확인함');
    await alertsSettled(e, key, '새 줄 전달');
    const last = e.launches.filter((l) => l.workKey === mk).at(-1)!.message;
    expect(last).toContain('남은 하위 프로세스 2개');
    expect(last).toContain('남은 하위 프로세스 3개');
    expect(alerts(e, key).map((q) => q.state)).toEqual(['done', 'done']);
    expect(holdReach(e, t.id)).toEqual([['error', true]]);
  });

  it('작업 보류가 아닌 알림(join 없음)은 그대로 — 도는 항목이 싣고 새 항목을 만들지 않는다', async () => {
    const e = (env = await bootOrch());
    const since = e.ctx.now();
    const base = { kind: 'plan-stuck' as const, target: 'D-9998', projectId: e.projectId, since };
    const p0 = alertMain(e.ctx, { ...base, message: '계획 지연 첫 줄\n- 첫 글' })!;
    markRunning(e, p0);
    const p1 = alertMain(e.ctx, { ...base, message: '계획 지연 첫 줄\n- 다른 글' })!;
    expect(p1.id).toBe(p0.id);
    expect(alerts(e, alertKey('plan-stuck', 'D-9998'))).toHaveLength(1);
  });
});

/** 프로듀서 턴을 흉내 낸다 — 그 종류의 재촉 항목(전달 2번, 받아 마침)을 실은 턴이 끝났다 (turns.judgeDirective가 판정한다) */
function stalledTurn(e: OrchEnv, directiveId: string, kind: 'merge_decision' | 'answer' | 'plan') {
  const q = enqueue(e.ctx, { kind, memberId: e.producerId, sessionKey: directiveKey(directiveId), projectId: e.projectId, directiveId, priority: 'high', deliveries: 2, message: `재촉 (${kind}, 시험)` });
  e.ctx.store.queue.put({ ...e.ctx.store.queue.require(q.id), state: 'done', doneAt: e.ctx.now() });
  return { directiveId, entryKinds: [kind], entryIds: [q.id], memberId: e.producerId, sessionKey: directiveKey(directiveId) };
}
const judgeDirective = (e: OrchEnv, l: ReturnType<typeof stalledTurn>) => (e.core.turns as unknown as { judgeDirective(l: unknown): void }).judgeDirective(l);
/** 그 지시의 통과한 저장소 변경형 검수 중 작업 */
function passedRepoIn(e: OrchEnv, directiveId: string): Task {
  const t = seedInReviewTask(e, e.qaId, { outputMode: 'repo', directiveId });
  const cur = e.ctx.store.tasks.require(t.id);
  e.ctx.store.tasks.patch(t.id, { review: { ...cur.review, passed: { reviewId: `RV-${t.id}`, reviewerId: e.qaId, at: e.ctx.now(), target: cur.review.target! } } });
  return e.ctx.store.tasks.require(t.id);
}

describe('재촉 상한 알림은 지연 하나마다 한 번 (리드 결정 S5-26 — since는 그 지연의 마지막 재촉)', () => {
  it('프로듀서 처리 지연(병합 판단): 같은 지연이 다시 상한이면 한 번, 같은 회차에 다른 작업에서 다시 멈추면 따로 알린다', async () => {
    const e = (env = await bootOrch());
    const d = seedDirective(e);
    e.hold.add(directiveKey(d.id));
    const key = alertKey('producer-stuck', `${d.id}:merge_decision`);
    const t1 = passedRepoIn(e, d.id);
    const first = stalledTurn(e, d.id, 'merge_decision');
    judgeDirective(e, first);
    expect(alerts(e, key).map((q) => q.state)).toEqual(['queued']);
    expect(alerts(e, key)[0]!.message).toContain(t1.id);
    expect(notices(e, '프로듀서 처리 지연').map((n) => n.body.endsWith(HANDED))).toEqual([true]);
    // 같은 지연(같은 재촉 항목)이 다시 상한 — 메인이 받아 마친 뒤에도 다시 넣지 않고 결정 32의 문장
    markDone(e, alerts(e, key)[0]!);
    judgeDirective(e, first);
    expect(alerts(e, key)).toHaveLength(1);
    expect(notices(e, '프로듀서 처리 지연').map((n) => n.body.endsWith(`어떻게 할지 ${TELL}`))).toEqual([true]);
    // 메인이 처리해 T1은 병합됐다. 같은 회차에 T2가 통과하고 프로듀서가 다시 멈춘다(새 재촉)
    e.ctx.store.tasks.patch(t1.id, { state: 'done', completedAt: e.ctx.now() });
    await sleep(5);
    const t2 = passedRepoIn(e, d.id);
    judgeDirective(e, stalledTurn(e, d.id, 'merge_decision'));
    const all = alerts(e, key);
    expect(all.map((q) => q.state)).toEqual(['done', 'queued']);
    expect(all[1]!.message).toContain(t2.id);
    expect(notices(e, '프로듀서 처리 지연').map((n) => n.body.endsWith(HANDED))).toEqual([true]);
  });

  it('프로듀서 처리 지연(질문 응답): 같은 회차에 둘째 질문에도 답하지 않으면 따로 알린다', async () => {
    const e = (env = await bootOrch());
    const d = seedDirective(e);
    const key = alertKey('producer-stuck', `${d.id}:answer`);
    const ask = (id: string, text: string) =>
      e.ctx.store.questions.insert({ id, projectId: e.projectId, fromId: e.devId, to: 'producer', taskId: null, directiveId: d.id, sessionKey: directiveKey(d.id), text, status: 'open', answer: null, answeredBy: null, createdAt: e.ctx.now(), answeredAt: null });
    ask('Q-9101', '어느 API를 쓰나요?');
    judgeDirective(e, stalledTurn(e, d.id, 'answer'));
    expect(alerts(e, key)).toHaveLength(1);
    markDone(e, alerts(e, key)[0]!);
    e.ctx.store.questions.put({ ...e.ctx.store.questions.require('Q-9101'), status: 'answered', answer: 'REST', answeredBy: e.producerId, answeredAt: e.ctx.now() });
    await sleep(5);
    ask('Q-9102', '로그인은 구글만 받나요?');
    judgeDirective(e, stalledTurn(e, d.id, 'answer'));
    const all = alerts(e, key);
    expect(all.map((q) => q.state)).toEqual(['done', 'queued']);
    expect(all[1]!.message).toContain('Q-9102');
    expect(all[1]!.message).not.toContain('Q-9101');
    expect(notices(e, '프로듀서 처리 지연').map((n) => n.body.endsWith(HANDED))).toEqual([true]);
  });

  it('계획 지연: judgeDirective가 실은 계획 항목의 만든 때를 넘긴다 — 같은 지연은 한 번, 같은 회차에 계획이 다시 멈추면 따로 알린다', async () => {
    const e = (env = await bootOrch());
    const d = seedDirective(e, '계획 지시');
    e.ctx.store.directives.put({ ...e.ctx.store.directives.require(d.id), state: 'planning' });
    const key = alertKey('plan-stuck', d.id);
    const first = stalledTurn(e, d.id, 'plan');
    judgeDirective(e, first);
    expect(alerts(e, key)).toHaveLength(1);
    markDone(e, alerts(e, key)[0]!);
    judgeDirective(e, first);
    expect(alerts(e, key)).toHaveLength(1);
    expect(notices(e, '계획 지연').map((n) => n.body)).toEqual([`${d.id} 계획 지시 — 프로듀서가 작업을 만들지 못했습니다. 어떻게 할지 ${TELL}`]);
    // 메인이 프로듀서에게 다시 맡겼는데 그 계획도 세 번 재촉한 뒤 멈췄다 (새 재촉)
    await sleep(5);
    judgeDirective(e, stalledTurn(e, d.id, 'plan'));
    expect(alerts(e, key).map((q) => q.state)).toEqual(['done', 'queued']);
    expect(notices(e, '계획 지연').map((n) => n.body)).toEqual([`${d.id} 계획 지시 — 프로듀서가 작업을 만들지 못했습니다. ${HANDED}`]);
  });

  // 프로듀서 턴은 세션 키별로 여러 항목을 함께 싣는다 — since는 실은 항목 가운데 그 종류이고 전달 횟수가 가장 큰 것(그 지연의 마지막 재촉)이다 (리드 결정 S5-40.2)
  /** 이 턴이 실은 항목 하나(받아 마침) — 종류와 전달 횟수를 정한다 */
  const carriedEntry = (e: OrchEnv, directiveId: string, kind: 'merge_decision' | 'answer', deliveries: number): QueueEntry => {
    const q = enqueue(e.ctx, { kind, memberId: e.producerId, sessionKey: directiveKey(directiveId), projectId: e.projectId, directiveId, priority: 'high', deliveries, message: `재촉 (${kind}, 시험)` });
    e.ctx.store.queue.put({ ...e.ctx.store.queue.require(q.id), state: 'done', doneAt: e.ctx.now() });
    return e.ctx.store.queue.require(q.id);
  };
  const turnCarrying = (e: OrchEnv, directiveId: string, carried: QueueEntry[]): ReturnType<typeof stalledTurn> => ({
    directiveId,
    entryKinds: carried.map((q) => q.kind as 'merge_decision' | 'answer'),
    entryIds: carried.map((q) => q.id),
    memberId: e.producerId,
    sessionKey: directiveKey(directiveId),
  });

  it('since는 그 종류의 항목에서 — 같은 턴에 실린 더 오래된 다른 종류 항목(답할 질문 없는 답변 재촉)이 병합 판단 지연의 since가 되지 않는다', async () => {
    const e = (env = await bootOrch());
    const d = seedDirective(e);
    e.hold.add(directiveKey(d.id));
    const key = alertKey('producer-stuck', `${d.id}:merge_decision`);
    const oldAnswer = carriedEntry(e, d.id, 'answer', 2);
    await sleep(5);
    const t1 = passedRepoIn(e, d.id);
    judgeDirective(e, turnCarrying(e, d.id, [carriedEntry(e, d.id, 'merge_decision', 2)]));
    expect(alerts(e, key)).toHaveLength(1);
    markDone(e, alerts(e, key)[0]!);
    e.ctx.store.tasks.patch(t1.id, { state: 'done', completedAt: e.ctx.now() });
    await sleep(5);
    // 같은 회차의 둘째 병합 지연 — 오래된 답변 항목과 함께 실렸다
    const t2 = passedRepoIn(e, d.id);
    judgeDirective(e, turnCarrying(e, d.id, [oldAnswer, carriedEntry(e, d.id, 'merge_decision', 2)]));
    const all = alerts(e, key);
    expect(all.map((q) => q.state)).toEqual(['done', 'queued']);
    expect(all[1]!.message).toContain(t2.id);
    expect(notices(e, '프로듀서 처리 지연').map((n) => n.body.endsWith(HANDED))).toEqual([true]);
    expect(alerts(e, alertKey('producer-stuck', `${d.id}:answer`))).toEqual([]);
  });

  it('since는 전달 횟수가 가장 큰 항목에서 — 같은 턴에 실린 더 오래된 같은 종류 항목(전달 0번)이 since가 되지 않는다', async () => {
    const e = (env = await bootOrch());
    const d = seedDirective(e);
    e.hold.add(directiveKey(d.id));
    const key = alertKey('producer-stuck', `${d.id}:merge_decision`);
    const oldMerge = carriedEntry(e, d.id, 'merge_decision', 0);
    await sleep(5);
    const t1 = passedRepoIn(e, d.id);
    judgeDirective(e, turnCarrying(e, d.id, [carriedEntry(e, d.id, 'merge_decision', 2)]));
    expect(alerts(e, key)).toHaveLength(1);
    markDone(e, alerts(e, key)[0]!);
    e.ctx.store.tasks.patch(t1.id, { state: 'done', completedAt: e.ctx.now() });
    await sleep(5);
    passedRepoIn(e, d.id);
    judgeDirective(e, turnCarrying(e, d.id, [oldMerge, carriedEntry(e, d.id, 'merge_decision', 2)]));
    expect(alerts(e, key).map((q) => q.state)).toEqual(['done', 'queued']);
    expect(notices(e, '프로듀서 처리 지연').map((n) => n.body.endsWith(HANDED))).toEqual([true]);
  });
});

const pauseMember = (e: OrchEnv, id: string, by: string, paused = true) => {
  const s = e.ctx.stop();
  e.ctx.saveStop({ ...s, members: { ...s.members, [id]: { paused, mode: 'immediate', since: e.ctx.now(), by } } });
};

describe('알림 업무는 대상이 풀리면 끝난 일 — deadWorkReason의 alert 갈래 (리드 결정 S5-7·S5-28)', () => {
  it('팀원의 종료 확인 실패(kill-failed:<팀원>)는 그 팀원이 재개되면 끝난다', async () => {
    const e = (env = await bootOrch());
    pauseMember(e, e.devId, MAIN_AGENT_ID);
    const a = alertMain(e.ctx, { kind: 'kill-failed', target: e.devId, projectId: e.projectId, message: '시험', since: e.ctx.now() })!;
    expect(deadWorkReason(e.ctx, a)).toBeNull();
    pauseMember(e, e.devId, MAIN_AGENT_ID, false);
    expect(deadWorkReason(e.ctx, a)).toBe(`${e.ctx.store.members.require(e.devId).name}(${e.devId})이(가) 이미 재개됨`);
  });

  it('계획 지연은 지시가 계획 중을 벗어나면 끝난다', async () => {
    const e = (env = await bootOrch());
    const d = seedDirective(e);
    e.ctx.store.directives.put({ ...e.ctx.store.directives.require(d.id), state: 'planning' });
    const a = alertMain(e.ctx, { kind: 'plan-stuck', target: d.id, projectId: e.projectId, directiveId: d.id, message: '시험', since: e.ctx.now() })!;
    expect(deadWorkReason(e.ctx, a)).toBeNull();
    e.ctx.store.directives.put({ ...e.ctx.store.directives.require(d.id), state: 'in_progress' });
    expect(deadWorkReason(e.ctx, a)).toBe(`지시 ${d.id}이(가) 계획 중이 아님`);
  });

  it('프로듀서 처리 지연(질문 응답)은 프로듀서가 답할 질문이 더 없으면 끝난다', async () => {
    const e = (env = await bootOrch());
    const d = seedDirective(e);
    e.ctx.store.questions.insert({ id: 'Q-9001', projectId: e.projectId, fromId: e.devId, to: 'producer', taskId: null, directiveId: d.id, sessionKey: directiveKey(d.id), text: '?', status: 'open', answer: null, answeredBy: null, createdAt: e.ctx.now(), answeredAt: null });
    const a = alertMain(e.ctx, { kind: 'producer-stuck', target: `${d.id}:answer`, projectId: e.projectId, directiveId: d.id, message: '시험', since: e.ctx.now() })!;
    expect(deadWorkReason(e.ctx, a)).toBeNull();
    e.ctx.store.questions.put({ ...e.ctx.store.questions.require('Q-9001'), status: 'answered', answer: '네', answeredBy: e.producerId, answeredAt: e.ctx.now() });
    expect(deadWorkReason(e.ctx, a)).toBe(`지시 ${d.id}에 프로듀서가 답할 질문이 없음`);
  });

  it('다시 넘긴 보류 넘김(handover-dropped)은 버린 그 넘김이 끝난 일이 되면(작업이 끝남) 끝난다', async () => {
    const e = (env = await bootOrch());
    const t = seedInReviewTask(e, e.qaId);
    e.core.tasks.hold(t.id, 'error', 'task', '검수자 없음 (시험)', 'system', 'no_reviewer', 'in_review');
    const orig = enqueue(e.ctx, { kind: 'no_reviewer', memberId: MAIN_AGENT_ID, sessionKey: mainKey(e.projectId), projectId: e.projectId, taskId: t.id, message: '검수자 없음 (시험)' });
    e.ctx.store.queue.put({ ...e.ctx.store.queue.require(orig.id), state: 'cancelled', doneAt: e.ctx.now() });
    const a = alertMain(e.ctx, { kind: 'handover-dropped', target: orig.id, projectId: e.projectId, taskId: t.id, message: '시험', since: e.ctx.now() })!;
    expect(deadWorkReason(e.ctx, a)).toBeNull();
    e.ctx.store.tasks.put({ ...e.ctx.store.tasks.require(t.id), state: 'cancelled' });
    expect(deadWorkReason(e.ctx, e.ctx.store.queue.require(orig.id))).not.toBeNull();
    expect(deadWorkReason(e.ctx, a)).toBe(deadWorkReason(e.ctx, e.ctx.store.queue.require(orig.id)));
  });

  it('재시작 상한에서 버린 팀원 업무(restart-dropped)는 그 일이 더 필요 없으면(답할 질문 없음) 끝난다', async () => {
    const e = (env = await bootOrch());
    const d = seedDirective(e);
    const orig = enqueue(e.ctx, { kind: 'answer', memberId: e.producerId, sessionKey: directiveKey(d.id), projectId: e.projectId, directiveId: d.id, questionId: 'Q-9002', message: '답변 요청 (시험)' });
    e.ctx.store.queue.put({ ...e.ctx.store.queue.require(orig.id), state: 'cancelled', doneAt: e.ctx.now() });
    e.ctx.store.questions.insert({ id: 'Q-9002', projectId: e.projectId, fromId: e.devId, to: 'producer', taskId: null, directiveId: d.id, sessionKey: directiveKey(d.id), text: '?', status: 'open', answer: null, answeredBy: null, createdAt: e.ctx.now(), answeredAt: null });
    const a = alertMain(e.ctx, { kind: 'restart-dropped', target: orig.id, projectId: e.projectId, directiveId: d.id, message: '시험', since: e.ctx.now() })!;
    expect(deadWorkReason(e.ctx, a)).toBeNull();
    e.ctx.store.questions.put({ ...e.ctx.store.questions.require('Q-9002'), status: 'answered', answer: '네', answeredBy: e.producerId, answeredAt: e.ctx.now() });
    expect(deadWorkReason(e.ctx, a)).toBe('답할 질문이 더 없음');
  });

  it('전달하지 못한 긴급 지시(urgent-undelivered)는 그 지시가 그 뒤 전달되면 끝난다', async () => {
    const e = (env = await bootOrch());
    e.ctx.store.messages.insert({ id: 'MSG-9001', requestId: null, fromActor: MAIN_AGENT_ID, toMemberId: e.devId, sessionKey: null, text: '긴급', kind: 'urgent', sharedWith: [], urgent: true, createdAt: e.ctx.now(), deliveredAt: null });
    const a = alertMain(e.ctx, { kind: 'urgent-undelivered', target: 'MSG-9001', projectId: e.projectId, message: '시험', since: e.ctx.now() })!;
    expect(deadWorkReason(e.ctx, a)).toBeNull();
    e.ctx.store.messages.put({ ...e.ctx.store.messages.require('MSG-9001'), deliveredAt: e.ctx.now() });
    expect(deadWorkReason(e.ctx, a)).toBe('긴급 지시 MSG-9001이(가) 그 뒤 전달됨');
  });

  it('예전 대표 정지(legacy-pause)는 그 정지가 더는 대표의 것이 아니면 끝난다', async () => {
    const e = (env = await bootOrch());
    pauseMember(e, e.devId, 'owner');
    const a = alertMain(e.ctx, { kind: 'legacy-pause', target: e.devId, projectId: e.projectId, message: '시험', since: e.ctx.now() })!;
    expect(deadWorkReason(e.ctx, a)).toBeNull();
    pauseMember(e, e.devId, MAIN_AGENT_ID);
    expect(deadWorkReason(e.ctx, a)).toBe(`${e.devId}의 예전 대표 정지가 이미 바뀜`);
  });

  it('시작 때 훑기는 받아 마쳤거나 버린 복구 확인 알림을 다시 만들지 않는다 (since는 그 실행의 시작)', async () => {
    const e = (env = await bootOrch());
    e.ctx.store.execs.insert({ requestId: 'X-9001', kind: 'deploy', projectId: e.projectId, taskId: null, cwd: e.projectDir, command: '배포', target: '배포', state: 'unknown', startedAt: e.ctx.now(), endedAt: e.ctx.now(), result: {} });
    sweepAlerts(e.ctx);
    const rec = () => alerts(e, alertKey('recovery', 'X-9001'));
    expect(rec()).toHaveLength(1);
    e.ctx.store.queue.put({ ...rec()[0]!, state: 'cancelled', doneAt: e.ctx.now() });
    await sleep(5);
    sweepAlerts(e.ctx);
    expect(rec()).toHaveLength(1);
    markDone(e, rec()[0]!);
    sweepAlerts(e.ctx);
    expect(rec()).toHaveLength(1);
  });
});

/** 메인에게 넘긴 멈춘 검수 (turns.isReviewHandOff — 작업에 묶이고 메시지 기록이 없는 메인 message) */
const handOff = (e: OrchEnv, taskId: string) => enqueue(e.ctx, { kind: 'message', memberId: MAIN_AGENT_ID, sessionKey: mainKey(e.projectId), projectId: e.projectId, taskId, message: `${taskId} 검수가 멈췄습니다 (시험)` });

describe('시작 때 훑기의 중단한 검수 작업 — 멈춘 검수 넘김이 그 중단으로 끝났을 때만 (리드 결정 42·S5-28)', () => {
  it('메인이 일부러 건 중단에는 알리지 않는다 — 넘김이 없거나, 그 중단 전에 다른 까닭으로 끝난 넘김, 그 중단 뒤에 만든 넘김이면', async () => {
    const e = (env = await bootOrch());
    const t = seedInReviewTask(e, e.qaId);
    const d2 = seedDirective(e, '둘째 지시');
    const t2 = seedInReviewTask(e, e.qaId, { directiveId: d2.id });
    const key = alertKey('interrupted-review', t.id);
    const key2 = alertKey('interrupted-review', t2.id);
    // t2: 그 중단 전에 다른 까닭으로 받아 마친 넘김(예: 메인이 검수자를 바꿔 마침)
    markDone(e, handOff(e, t2.id));
    await sleep(5);
    await e.main('interrupt_task', { task_id: t.id, reason: '대표 명령: 이 작업 검수는 잠시 멈춰' });
    await e.main('interrupt_task', { task_id: t2.id, reason: '대표 명령: 이 작업 검수도 잠시 멈춰' });
    expect(e.ctx.store.tasks.require(t.id).hold).toMatchObject({ returnState: 'in_review', reasons: [{ kind: 'interrupted', by: MAIN_AGENT_ID }] });
    sweepAlerts(e.ctx);
    expect([alerts(e, key), alerts(e, key2)]).toEqual([[], []]);
    expect(holdReach(e, t.id)).toEqual([['interrupted', false]]);
    // t: 그 중단 뒤에 만든 넘김이 끝나도 그 중단으로 끝난 넘김이 아니다
    await sleep(5);
    markDone(e, handOff(e, t.id));
    sweepAlerts(e.ctx);
    expect(alerts(e, key)).toEqual([]);
  });

  it('그 작업의 멈춘 검수 넘김이 중단 전에 만들어져 끝났으면 한 번 알린다 — 넘김이 아직 대기 중이면 알리지 않는다(턴의 판정이 맡는다)', async () => {
    const e = (env = await bootOrch());
    const t = seedInReviewTask(e, e.qaId);
    const key = alertKey('interrupted-review', t.id);
    const h = handOff(e, t.id);
    await sleep(5);
    await e.main('interrupt_task', { task_id: t.id, reason: '검수를 멈춤' });
    sweepAlerts(e.ctx);
    expect(alerts(e, key)).toEqual([]);
    e.ctx.store.queue.put({ ...e.ctx.store.queue.require(h.id), state: 'cancelled', doneAt: e.ctx.now() });
    sweepAlerts(e.ctx);
    expectAlert(e, key, { head: `${t.id} "검수 대상 작업" — 시작 때 확인: 메인 에이전트에게 알리지 않은 채 남은 보류(중단한 검수 작업)`, calls: ['멈춘 검수 넘김이 끝났습니다', `resume_task(task_id="${t.id}", reason="…")`] });
    expect(holdReach(e, t.id)).toEqual([['interrupted', true]]);
    sweepAlerts(e.ctx);
    expect(alerts(e, key)).toHaveLength(1);
  });

  // 넘김은 작업마다, 넘김 종류만 본다 (리드 결정 S5-40.2) — 같은 프로젝트 세션(main:P)에는 다른 작업의 넘김과 그 작업의 다른 메인 업무도 있다
  it('다른 작업의 끝난 검수 넘김은 이 작업의 중단을 알림으로 만들지 않는다 — 그 넘김의 작업만 알린다', async () => {
    const e = (env = await bootOrch());
    const t = seedInReviewTask(e, e.qaId);
    const d2 = seedDirective(e, '둘째 지시');
    const t2 = seedInReviewTask(e, e.qaId, { directiveId: d2.id });
    // t2만 멈춘 검수 넘김이 있다
    const h2 = handOff(e, t2.id);
    await sleep(5);
    await e.main('interrupt_task', { task_id: t.id, reason: '대표 명령: 이 작업 검수는 잠시 멈춰' });
    await e.main('interrupt_task', { task_id: t2.id, reason: '대표 명령: 이 작업 검수도 잠시 멈춰' });
    await sleep(5);
    // 두 중단 뒤에 t2의 넘김이 끝났다 (결정 42의 경우는 t2뿐)
    markDone(e, h2);
    sweepAlerts(e.ctx);
    expect({ t: alerts(e, alertKey('interrupted-review', t.id)).length, t2: alerts(e, alertKey('interrupted-review', t2.id)).length }).toEqual({ t: 0, t2: 1 });
    expect(holdReach(e, t.id)).toEqual([['interrupted', false]]);
  });

  it('그 작업의 끝난 메인 업무라도 검수 넘김이 아니면(그 작업에 대한 알림 업무) 세지 않는다', async () => {
    const e = (env = await bootOrch());
    const t = seedInReviewTask(e, e.qaId);
    // 그 작업에 대한 메인의 앞선 알림 — 중단 전에 넣었고 중단 뒤에 받아 마쳤다
    const a = enqueue(e.ctx, { kind: 'alert', memberId: MAIN_AGENT_ID, sessionKey: mainKey(e.projectId), projectId: e.projectId, taskId: t.id, alertKey: alertKey('kill-failed', t.id), message: `${t.id} 시험 알림` });
    await sleep(5);
    await e.main('interrupt_task', { task_id: t.id, reason: '대표 명령: 이 작업 검수는 잠시 멈춰' });
    await sleep(5);
    markDone(e, a);
    sweepAlerts(e.ctx);
    expect(alerts(e, alertKey('interrupted-review', t.id))).toEqual([]);
    expect(live(e)).toEqual([]);
  });
});

describe('시작 실패 출구의 팀원 (리드 결정 S5-28)', () => {
  it('검수자가 메인 에이전트 자신이면 set_member_ai로 바꿀 수 없다고 적는다 — 그 도구가 실제로 거부한다 (AGT-08)', async () => {
    const e = (env = await bootOrch());
    const t = seedInReviewTask(e, MAIN_AGENT_ID);
    e.core.tasks.hold(t.id, 'error', 'task', '턴 시작 3회 실패: 검수 사본을 만들 수 없습니다 (시험)', 'system');
    const q = alertTaskHold(e.ctx, 'start-fail', t.id, { cause: '검수 턴이 3번 시작하지 못해 보류됨', member: { id: MAIN_AGENT_ID, review: true } })!;
    expect(q.message).toContain('시작하지 못한 것은 검수자인 메인 에이전트 자신의 검수 턴입니다 — 메인 에이전트의 AI 설정은 운영자 몫이라 set_member_ai로는 바꿀 수 없습니다.');
    expect(q.message).not.toContain('set_member_ai(member_id=');
    await expect(e.main('set_member_ai', { member_id: MAIN_AGENT_ID, model: 'opus', reason: '시험' })).rejects.toMatchObject({ code: 'forbidden' });
  });
});
