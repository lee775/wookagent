/**
 * 재시작 상한의 버림은 같은 시작의 복원이 되살리지 않는다 (리드 결정 44, 10-30 — flows 5차 재리뷰, 프로브 zz-s1fx5fg-restart-limit-rebuilt):
 * - 결정 39는 재시작으로 3번째 끊긴 항목을 재시작 복구 1)에서 버리고 '더는 자동으로 다시 시도하지 않습니다'라고 알린다. 그런데 같은 시작의 뒤 단계가 같은
 *   일을 0부터 다시 만들었다: 관리 업무 복원(보고서 작성·팀원 재개 업무·프로듀서의 질문 답변·최종 결과 요청·병합 판단)과 검수 안전망·재시작 3)(넘김을
 *   버린 작업의 검수). 그래서 앱째 끝내는 턴은 그대로 돌았고, 대표는 3번 재시작마다 거짓 긴급 알림과 '메인 에이전트 처리 지연'을 받았다
 * - 이제 다시 만드는 쪽은 같은 대상의 가장 최근 항목(상태와 상관없이)을 먼저 본다 — 재시작 상한에서 버린 모양(취소, restarts ≥ 3)이면 다시 만들지 않는다.
 *   버림 알림이 그 일의 업무다. 그 뒤 정상 경로로 생긴 항목은 더 최근이라 이것을 푼다. 비정상 종료·시작 실패 상한·헛돌기로 버린 일은 예전처럼 다음 시작에
 *   다시 만든다(재시작이 그 일의 재시도)
 * - 작업 세션도 재시작으로 끊긴 횟수를 센다: 끊긴 일에 restarts+1을 남기고 '이어서 진행'이 그 횟수를 이어 가며, 3번째면 이어서 진행하지 않고 작업 턴의
 *   비정상 종료 상한처럼 보류(오류)·'자동 복구 실패'
 * - 알림이 가리키는 출구는 실제로 있다: 메인이 명령 턴에서 보고서를 내고(submit_report), 팀원을 재개하고(resume_member), 검수를 다시 시작하고
 *   (interrupt_task → resume_task), 보류한 작업을 재개한다(resume_task)
 * - 프로듀서의 재촉(답변·병합 판단)은 대상 ID 없이 들어간다(답변 재촉은 questionId 없이 열린 질문을 모두, 병합 재촉은 taskId 없이 글에 작업 ID를 적는다).
 *   재시작 상한의 버림 판정이 질문·작업 ID로만 보면 버린 재촉을 보지 못해, 같은 시작에서 답변 요청을 0부터 다시 넣거나 그 작업의 둘째 병합 판단이 남아
 *   돌았다. 이제 대기 판정과 버림 판정이 재촉까지 같은 대상으로 본다. 재시작 2)의 병합 대조(되지 않은 병합)도 같은 판정을 거친다 (리드 결정 48, 프로브
 *   zz-s1fx6fg-restart-drop-nudge)
 * - 검수 안전망은 그 작업의 넘김·검수 항목을 합쳐 가장 최근 것을 본다 — 넘김을 버린 뒤 정상 경로로 생긴 검수 항목이 더 최근이면 막지 않는다 (리드 결정 48,
 *   S1F12 알아 둘 것 1, 프로브 zz-s1fix6-ti-review-newest-entry)
 */
import { afterEach, describe, expect, it } from 'vitest';
import { type Question, type QueueEntry } from '@shared/domain';
import { directiveKey, enqueue, mainKey, reviewKey, taskKey } from '../../src/main/orchestrator/records';
import { isRestartLimitDrop, isReviewHandOff, mergeNudgeTasks, restartDropped, RESTART_CUT_LIMIT } from '../../src/main/orchestrator/turns';
import { bootRestartable, seedDirective, seedInReviewTask, sleep, waitUntil, type RestartableEnv } from '../acceptance/stops-helpers';

let renv: RestartableEnv | null = null;
afterEach(async () => {
  await renv?.close();
  renv = null;
});

const TELL = '명령창으로 메인 에이전트에게 알려 주세요. 메인 에이전트가 확인하고 이어 갑니다';
/**
 * 5단계 S5b (리드 결정 S5-8): 재시작 상한에서 버린 팀원 업무(프로듀서 답변·병합 판단 등)와 작업 세션의 재시작 상한 보류는 메인 에이전트에게 알림 업무로 한 번 간다 —
 * 알림은 넘긴 사실로 끝난다. 시작 때 그 일을 다시 만들지 않는 것(리드 결정 44)은 그대로다. 메인 세션의 일은 넘기지 않는다
 */
const HANDED = '메인 에이전트에게 넘겼습니다. 메인 에이전트가 확인하고 이어 갑니다 — 서둘러야 하면 명령창으로 메인 에이전트에게 알려 주세요';
const mainAlerts = (e: RestartableEnv) => e.ctx.store.queue.list({ ref1: 'M-MAIN' }).filter((q) => q.kind === 'alert');
const crashNotices = (e: RestartableEnv) => e.ctx.store.notifications.list().filter((n) => n.title === '자동 복구 실패');

/** 그 세션 키의 턴이 뜰 때까지 (홀드된 가짜 CLI) */
async function live(e: RestartableEnv, key: string, label: string): Promise<void> {
  await waitUntil(
    () => {
      if (!e.liveProc(key)) e.tick();
      return !!e.liveProc(key);
    },
    label,
  );
}

/** 그 세션의 턴이 도는 채로 재시작을 n번 (매번 다시 뜰 때까지) */
async function cutTimes(e0: RestartableEnv, key: string, n: number, label: string): Promise<RestartableEnv> {
  let e = e0;
  for (let i = 1; i <= n; i++) {
    e.crash();
    e = renv = await e.reboot();
    await live(e, key, `${label} (재시작 ${i})`);
  }
  return e;
}

/** 마지막 재시작 — 상한에 닿아 버리는 재시작. 뒤 단계(관리 업무 복원·안전망·재시작 3))와 첫 스케줄링까지 기다린다 */
async function lastCut(e0: RestartableEnv): Promise<RestartableEnv> {
  e0.crash();
  const e = (renv = await e0.reboot());
  await sleep(150);
  e.tick();
  await sleep(100);
  return e;
}

const liveOf = (e: RestartableEnv, pred: (q: QueueEntry) => boolean) => e.ctx.store.queue.list({ state: ['queued', 'running'] }).filter(pred);

describe('재시작 상한의 버림은 같은 시작의 복원이 되살리지 않는다 (리드 결정 44)', () => {
  it('보고서 작성: 세 번째로 끊겨 버리면 관리 업무 복원이 다시 넣지 않는다 — 다음 시작에도. 출구: 메인이 명령 턴에서 submit_report', async () => {
    let e = (renv = await bootRestartable({ holdAll: true }));
    const key = mainKey(e.projectId);
    const d0 = seedDirective(e, '보고 지시');
    e.ctx.store.directives.put({ ...d0, state: 'reporting', finalResult: { round: 1, summary: '요약', outputs: [], changedFiles: [], issues: [], nextSteps: [], submittedAt: e.ctx.now(), by: e.producerId } });
    e.core.directives.queueMainReport(e.ctx.store.directives.require(d0.id));
    await live(e, key, '보고서 턴');
    e = await cutTimes(e, key, 2, '보고서 턴');
    e = await lastCut(e);
    const reports = () => e.ctx.store.queue.list({ ref2: key }).filter((q) => q.kind === 'main_report' && q.directiveId === d0.id);
    expect(reports().map((q) => [q.state, q.restarts ?? 0])).toEqual([['cancelled', 3]]);
    // 출구 문장으로 끝난다 — 버림이 대표 요청도 보류 넘김도 적지 않는다 (리드 결정 45)
    expect(crashNotices(e).map((n) => n.body)).toEqual([
      `보고서 작성 ${d0.id} — 이 업무를 처리하던 중에 프로그램이 3번 다시 시작돼(앱이 갑자기 꺼지거나 PC가 다시 켜지는 등) 더는 자동으로 다시 시도하지 않습니다. 원인이 정리되면 ${TELL}`,
    ]);
    expect(e.launchesOf(key)).toEqual([]);
    // 다음 시작에도 다시 만들지 않는다 (저장된 모양으로 알아본다)
    e.crash();
    e = renv = await e.reboot();
    await sleep(100);
    expect(reports().map((q) => q.state)).toEqual(['cancelled']);
    // 출구: 대표가 명령하면 메인이 명령 턴에서 보고서를 낸다 — 보고서 작성 업무 없이도 받는다
    const r = await e.main('submit_report', { directive_id: d0.id, summary: '결과 요약', results: '결과', how_to_verify: '-', issues: '-', next_steps: '-' });
    expect(r.reportId).toBeTruthy();
    expect(e.ctx.store.directives.require(d0.id).state).toBe('awaiting_confirmation');
  });

  it('멈춘 검수 넘김: 세 번째로 끊겨 버리면 안전망과 재시작 3)이 검수를 다시 등록하지 않는다 — 대표 알림이 업무다. 출구: interrupt_task → resume_task', async () => {
    let e = (renv = await bootRestartable({ holdAll: true }));
    const key = mainKey(e.projectId);
    const d = seedDirective(e);
    const t = seedInReviewTask(e, { directiveId: d.id, assigneeId: e.devId, reviewerId: e.qaId, title: '결제 화면' });
    (e.core.turns as unknown as { handReviewToMain(t: unknown, d: string, p: string | null, c: { producer: string }): void }).handReviewToMain(
      e.ctx.store.tasks.require(t.id),
      d.id,
      e.projectId,
      { producer: '3번의 턴에서 정하지 않았습니다' },
    );
    await live(e, key, '넘김 턴');
    e = await cutTimes(e, key, 2, '넘김 턴');
    e = await lastCut(e);
    expect(liveOf(e, (q) => q.kind === 'review' && q.taskId === t.id)).toEqual([]);
    expect(e.core.tasks.reviewPending(t.id)).toBe(false);
    expect(e.ctx.store.activity.search({ text: '재시작 복구', limit: 50 }).filter((a) => a.text.includes(`${t.id} 검수 중인데`))).toEqual([]);
    expect(e.ctx.store.notifications.list().filter((n) => n.key === `handoff-stuck:${t.id}`).map((n) => n.body)).toEqual([
      `${d.id}: ${t.id} "결제 화면" 검수가 멈춘 채 남아 있습니다 — 메인 에이전트의 턴이 프로그램 재시작으로 3번 끊겨 이 업무를 처리하지 못했습니다. 이 작업을 어떻게 할지 명령창으로 메인 에이전트에게 말해 주세요 (예: "${t.id} 검수를 다시 진행해", "${t.id}는 취소해").`,
    ]);
    // 출구: 메인이 명령 턴에서 검수를 다시 시작한다 — 중단 뒤 재개하면 검수를 다시 등록한다
    await e.main('interrupt_task', { task_id: t.id });
    await e.main('resume_task', { task_id: t.id });
    expect(e.ctx.store.tasks.require(t.id).state).toBe('in_review');
    expect(liveOf(e, (q) => q.kind === 'review' && q.sessionKey === reviewKey(t.id)).map((q) => q.memberId)).toEqual([e.qaId]);
  });

  it('팀원 재개 업무: 세 번째로 끊겨 버리면 관리 업무 복원이 다시 넣지 않는다 — 다른 정지에는 다시 넣는다. 출구: resume_member', async () => {
    let e = (renv = await bootRestartable({ holdAll: true }));
    const key = mainKey(e.projectId);
    await e.core.stops.pauseMember(e.producerId, 'graceful', 'system', '프로세스 종료를 확인하지 못함 (시험)');
    e.core.turns.handPauseToMain(e.producerId, null);
    await live(e, key, '재개 업무 턴');
    e = await cutTimes(e, key, 2, '재개 업무 턴');
    e = await lastCut(e);
    const items = () => e.ctx.store.queue.list({ ref2: key }).filter((q) => q.pausedMemberId === e.producerId);
    expect(items().map((q) => [q.state, q.restarts ?? 0])).toEqual([['cancelled', 3]]);
    expect(e.ctx.store.notifications.list().filter((n) => n.key === `pause-stuck:${e.producerId}`)).toHaveLength(1);
    // 그 정지가 아니라 그 뒤에 건 다른 정지라면 다시 넣는다 (그 정지의 재개 업무가 아직 없다)
    await sleep(5);
    const s = e.ctx.stop();
    e.ctx.saveStop({ ...s, members: { ...s.members, [e.producerId]: { ...s.members[e.producerId]!, since: e.ctx.now() } } });
    e.core.recovery.reconcileManagement();
    expect(items().map((q) => q.state)).toEqual(['cancelled', 'queued']);
    // 출구: 메인이 명령 턴에서 팀원을 재개한다 — 다시 넣은 재개 업무를 아직 받지 않았으면(대기 중) 첫 호출은 한 번 거부하고 그 글을 보여 준다. 다시 부르면 재개한다
    // (리드 결정 S5-50)
    const first = await e.main('resume_member', { member_id: e.producerId }).then(
      () => null,
      (x: Error & { code?: string }) => x,
    );
    expect(first?.code).toBe('conflict');
    expect(first?.message).toContain(`- 알림 ${items()[1]!.id} (일시정지된 팀원의 재개 ${e.producerId})`);
    expect(e.ctx.stop().members[e.producerId]?.paused).toBe(true);
    await e.main('resume_member', { member_id: e.producerId });
    expect(e.ctx.stop().members[e.producerId]).toBeUndefined();
  });

  it('작업 세션: 재시작으로 끊긴 횟수를 이어서 진행이 이어 가고, 세 번째면 이어서 진행하지 않고 보류한다 — 출구: 메인의 resume_task가 0부터 이어 간다', async () => {
    let e = (renv = await bootRestartable({ holdAll: true }));
    const d = seedDirective(e);
    const t = e.core.tasks.create(
      { directiveId: d.id, title: '로그인 화면', goal: '로그인 화면', type: 'development', assigneeId: e.devId, acceptanceCriteria: ['동작한다'], outputMode: 'repo', prerequisiteIds: [] },
      e.producerId,
    );
    const key = taskKey(t.id);
    await waitUntil(
      () => {
        if (!e.liveProc(key)) e.tick();
        return !!e.liveProc(key);
      },
      '작업 턴',
      60_000,
    );
    const work = () => e.ctx.store.queue.list({ ref2: key }).filter((q) => q.kind !== 'message').map((q) => [q.state, q.restarts ?? 0]);
    e = await cutTimes(e, key, 1, '작업 턴');
    expect(work()).toEqual([
      ['done', 1],
      ['running', 1],
    ]);
    e = await cutTimes(e, key, 1, '작업 턴');
    expect(work()).toEqual([
      ['done', 1],
      ['done', 2],
      ['running', 2],
    ]);
    expect(crashNotices(e)).toEqual([]);
    e = await lastCut(e);
    expect(work()).toEqual([
      ['done', 1],
      ['done', 2],
      ['cancelled', 3],
    ]);
    const held = e.ctx.store.tasks.require(t.id);
    expect([held.state, held.hold.returnState, held.hold.reasons.map((r) => [r.kind, r.note])]).toEqual([
      'on_hold',
      'in_progress',
      [['error', '작업하던 중에 프로그램이 3번 다시 시작돼 자동으로 이어 가지 않음']],
    ]);
    expect(e.launchesOf(key)).toEqual([]);
    expect(crashNotices(e).map((n) => [n.key, n.level, n.body])).toEqual([
      [`crash:${t.id}`, 'urgent', `${t.id} 로그인 화면 — 이 작업을 하던 중에 프로그램이 3번 다시 시작돼(앱이 갑자기 꺼지거나 PC가 다시 켜지는 등) 작업을 보류하고 ${HANDED}`],
    ]);
    expect(mainAlerts(e).map((q) => q.alertKey)).toEqual([`alert:crash:${t.id}`]);
    expect(e.ctx.store.activity.search({ text: `재시작 복구: ${t.id} 작업`, limit: 5 }).map((a) => a.text)).toEqual([
      `재시작 복구: ${t.id} 작업 — 작업하던 중에 프로그램이 3번 다시 시작돼 이어서 진행하지 않고 보류함`,
    ]);
    // 대표 할 일에 메인에게 가 있는 보류로 보인다 (alert crash:<작업>, 리드 결정 S5-7)
    expect((await e.invoke('snapshot.get')).ownerTodos.flatMap((x) => (x.kind === 'error' && x.taskId === t.id ? [x.reachesMain] : []))).toEqual([true]);
    // 출구: 메인이 재개하면 정상 경로의 새 일이라 0부터 센다
    await e.main('resume_task', { task_id: t.id });
    expect(e.ctx.store.tasks.require(t.id).state).toBe('in_progress');
    expect(work().at(-1)).toEqual(['queued', 0]);
  });
});

describe('대상 ID 없는 프로듀서 재촉도 재시작 상한에서 버리면 같은 시작에서 다시 만들지 않는다 (리드 결정 48)', () => {
  /** 프로듀서의 재촉 턴이 세 번째 재시작에서 끊길 때까지 — 재촉 턴이 앱째 끝낸다. 재시작 뒤 첫 스케줄링까지 기다린다 */
  async function cutNudgeThrice(e0: RestartableEnv, dk: string, after?: (e: RestartableEnv, i: number) => void): Promise<RestartableEnv> {
    let e = e0;
    e.hold.add(dk);
    await live(e, dk, '재촉 턴');
    for (let i = 1; i <= 2; i++) {
      e.crash();
      e = renv = await e.reboot({ holdAll: true });
      await live(e, dk, `재촉 턴 (재시작 ${i})`);
      after?.(e, i);
    }
    e.crash();
    e = renv = await e.reboot({ holdAll: true });
    await sleep(200);
    e.tick();
    await sleep(150);
    return e;
  }

  it('답변 재촉(questionId 없음)을 세 번째 재시작에서 버리면 관리 업무 복원이 그 질문의 답변 요청을 다시 넣지 않는다 — 다음 시작에도', async () => {
    let e = (renv = await bootRestartable());
    const d = seedDirective(e);
    const t = seedInReviewTask(e, { directiveId: d.id, assigneeId: e.devId, reviewerId: e.qaId });
    const q = e.core.tasks.askProducer(e.ctx.store.tasks.require(t.id), e.ctx.store.members.require(e.devId), '어느 결제 API를 쓰나요?', taskKey(t.id));
    const dk = directiveKey(d.id);
    // 첫 전달: 프로듀서 턴이 답하지 않고 끝난다 → 답변 재촉 (questionId 없음, 전달 1)
    e.tick();
    await waitUntil(() => e.ctx.store.queue.list({ ref2: dk, state: 'queued' }).some((x) => x.kind === 'answer' && (x.deliveries ?? 0) === 1), '답변 재촉');
    const answers = () => e.ctx.store.queue.list({ ref2: dk }).filter((x) => x.kind === 'answer').map((x) => [x.state, x.questionId, x.restarts ?? 0]);
    e = await cutNudgeThrice(e, dk);
    expect(crashNotices(e).map((n) => n.body)).toEqual([
      `질문 응답 ${d.id} — 이 업무를 처리하던 중에 프로그램이 3번 다시 시작돼(앱이 갑자기 꺼지거나 PC가 다시 켜지는 등) 더는 자동으로 다시 시도하지 않습니다. 그 일을 ${HANDED}`,
    ]);
    // 버린 재촉은 메인 에이전트에게 한 번 간다 — 프로듀서에게 다시 지시할 길과 함께 (리드 결정 S5-8)
    const dropped = e.ctx.store.queue.list({ ref2: dk }).filter((x) => x.kind === 'answer').at(-1)!;
    expect(mainAlerts(e).map((x) => [x.alertKey, x.sessionKey])).toEqual([[`alert:restart-dropped:${dropped.id}`, mainKey(e.projectId)]]);
    expect(mainAlerts(e)[0]!.message).toContain('answer_question으로 답하라고');
    // 원래 답변 요청(정상으로 마침)과 버린 재촉뿐이다 — 같은 시작의 관리 업무 복원이 질문 ID로 새 요청을 넣지 않고, 띄운 턴도 없다
    expect(answers()).toEqual([
      ['done', q.id, 0],
      ['cancelled', null, RESTART_CUT_LIMIT],
    ]);
    expect(e.launchesOf(dk)).toEqual([]);
    expect(e.ctx.store.questions.require(q.id).status).toBe('open');
    // 다음 시작에도 다시 만들지 않는다 (저장된 모양으로 알아본다)
    e.crash();
    e = renv = await e.reboot({ holdAll: true });
    await sleep(100);
    expect(answers().map((x) => x[0])).toEqual(['done', 'cancelled']);
    // 시작 때 훑기도 그 알림을 다시 만들지 않는다
    expect(mainAlerts(e).map((x) => x.alertKey)).toEqual([`alert:restart-dropped:${dropped.id}`]);
  });

  it('병합 재촉(taskId 없음)이 기다리는 동안 재시작 3)이 그 작업의 둘째 병합 판단을 만들지 않고, 재촉을 세 번째 재시작에서 버리면 그 작업의 병합 판단은 남지 않는다', async () => {
    let e = (renv = await bootRestartable());
    const d = seedDirective(e);
    const t0 = seedInReviewTask(e, { directiveId: d.id, assigneeId: e.devId, reviewerId: e.qaId });
    const now = e.ctx.now();
    const target = { kind: 'repo' as const, taskCommitSha: 'a'.repeat(40), baseMainSha: 'b'.repeat(40), pinnedAt: now };
    e.ctx.store.tasks.patch(t0.id, { outputMode: 'repo', review: { ...t0.review, target, passed: { reviewId: 'RV-0001', reviewerId: e.qaId, at: now, target } } });
    const dk = directiveKey(d.id);
    e.core.merges.queueMergeDecision(e.ctx.store.tasks.require(t0.id));
    // 첫 전달: 프로듀서 턴이 병합을 요청하지 않고 끝난다 → 병합 재촉 (taskId 없음, 글에 작업 ID, 전달 1)
    e.tick();
    await waitUntil(() => e.ctx.store.queue.list({ ref2: dk, state: 'queued' }).some((x) => x.kind === 'merge_decision' && (x.deliveries ?? 0) === 1), '병합 재촉');
    const nudge = e.ctx.store.queue.list({ ref2: dk, state: 'queued' }).find((x) => x.kind === 'merge_decision')!;
    expect([nudge.taskId, nudge.message]).toEqual([null, `검수를 통과했지만 병합 요청이 없는 작업: ${t0.id}. request_merge를 호출하세요.`]);
    const merges = () => e.ctx.store.queue.list({ ref2: dk }).filter((x) => x.kind === 'merge_decision').map((x) => [x.state, x.taskId, x.restarts ?? 0]);
    const seen: unknown[] = [];
    e = await cutNudgeThrice(e, dk, (cur, i) => seen.push([i, liveOf(cur, (x) => x.sessionKey === dk && x.kind === 'merge_decision').map((x) => x.taskId)]));
    // 재촉이 기다리는 동안 재시작 3)·관리 업무 복원은 같은 작업의 병합 판단(taskId)을 따로 넣지 않는다 — 넣으면 재촉과 한 턴에 실려 재촉을 버린 뒤에도 남아 돈다
    expect(seen).toEqual([
      [1, [null]],
      [2, [null]],
    ]);
    expect(crashNotices(e).map((n) => n.body)).toEqual([
      `병합 판단 ${d.id} — 이 업무를 처리하던 중에 프로그램이 3번 다시 시작돼(앱이 갑자기 꺼지거나 PC가 다시 켜지는 등) 더는 자동으로 다시 시도하지 않습니다. 그 일을 ${HANDED}`,
    ]);
    const droppedNudge = e.ctx.store.queue.list({ ref2: dk }).filter((x) => x.kind === 'merge_decision').at(-1)!;
    expect(mainAlerts(e).map((x) => x.alertKey)).toEqual([`alert:restart-dropped:${droppedNudge.id}`]);
    expect(mainAlerts(e)[0]!.message).toContain('request_merge로 병합하라고');
    expect(merges()).toEqual([
      ['done', t0.id, 0],
      ['cancelled', null, RESTART_CUT_LIMIT],
    ]);
    expect(e.launchesOf(dk)).toEqual([]);
  });
});

describe('다시 만드는 쪽은 같은 대상의 가장 최근 항목을 본다 (리드 결정 44 — 재시작 복구 3)·관리 업무 복원)', () => {
  /** 그 항목을 재시작 상한에서 버린 모양으로 둔다 */
  const cutOut = (e: RestartableEnv, q: QueueEntry) => e.ctx.store.queue.put({ ...e.ctx.store.queue.require(q.id), state: 'cancelled', restarts: RESTART_CUT_LIMIT, doneAt: e.ctx.now() });
  /** 그 항목을 정상으로 마친 모양으로 둔다 (재시작 횟수 그대로 — 버린 것이 아니다) */
  const doneOk = (e: RestartableEnv, q: QueueEntry, restarts = 0) => e.ctx.store.queue.put({ ...e.ctx.store.queue.require(q.id), state: 'done', restarts, doneAt: e.ctx.now() });

  it('질문 답변·최종 결과 요청·병합 판단·보고서 작성: 가장 최근 항목이 재시작 상한의 버림이면 다시 넣지 않고, 정상으로 끝난 항목이 더 최근이면 다시 넣는다', async () => {
    const e = (renv = await bootRestartable({ holdAll: true }));
    e.core.scheduler.stop();
    const d = seedDirective(e);
    const pending = (key: string, kind: string) => liveOf(e, (q) => q.sessionKey === key && q.kind === kind);
    // 질문 답변: 열린 질문의 답변 업무
    const asker = seedInReviewTask(e, { directiveId: d.id, assigneeId: e.devId, reviewerId: e.qaId });
    const question: Question = { id: e.ctx.store.nextId('question'), projectId: e.projectId, directiveId: d.id, taskId: asker.id, fromId: e.devId, to: 'producer', sessionKey: taskKey(asker.id), text: '어느 API를 쓰나요?', status: 'open', answer: null, answeredBy: null, createdAt: e.ctx.now(), answeredAt: null };
    e.ctx.store.questions.insert(question);
    e.core.tasks.queueProducerAnswer(e.ctx.store.questions.require(question.id), e.producerId);
    const answer = pending(directiveKey(d.id), 'answer')[0]!;
    cutOut(e, answer);
    await e.core.recovery.run();
    expect(pending(directiveKey(d.id), 'answer')).toEqual([]);
    // 병합 판단: 통과한 저장소 변경형 작업
    const passed = seedInReviewTask(e, { directiveId: d.id, assigneeId: e.devId, reviewerId: e.qaId });
    e.ctx.store.tasks.patch(passed.id, { outputMode: 'repo', review: { ...passed.review, passed: { reviewId: 'RV-0001', reviewerId: e.qaId, at: e.ctx.now(), target: { kind: 'repo', taskCommitSha: 'abc', baseMainSha: 'def', pinnedAt: e.ctx.now() } } } });
    e.core.merges.queueMergeDecision(e.ctx.store.tasks.require(passed.id));
    const merge = pending(directiveKey(d.id), 'merge_decision')[0]!;
    cutOut(e, merge);
    await e.core.recovery.run();
    expect(pending(directiveKey(d.id), 'merge_decision')).toEqual([]);
    // 정상 경로로 생긴 더 최근 항목(마침)이 있으면 그 판정은 풀리고, 빠진 업무를 다시 넣는다
    doneOk(e, enqueue(e.ctx, { kind: 'answer', memberId: e.producerId, sessionKey: directiveKey(d.id), projectId: e.projectId, directiveId: d.id, taskId: asker.id, questionId: question.id, message: '답변 요청 (시험)' }));
    doneOk(e, enqueue(e.ctx, { kind: 'merge_decision', memberId: e.producerId, sessionKey: directiveKey(d.id), projectId: e.projectId, directiveId: d.id, taskId: passed.id, message: '병합 판단 (시험)' }), 2);
    await e.core.recovery.run();
    expect(pending(directiveKey(d.id), 'answer').map((q) => q.questionId)).toEqual([question.id]);
    expect(pending(directiveKey(d.id), 'merge_decision').map((q) => q.taskId)).toEqual([passed.id]);

    // 최종 결과 요청: 회차 작업이 모두 끝난 지시 — 지난 회차의 버림은 이번 회차를 막지 않는다
    const d2 = seedDirective(e, '최종 결과 지시');
    const done = seedInReviewTask(e, { directiveId: d2.id, assigneeId: e.devId, reviewerId: e.qaId });
    e.ctx.store.tasks.patch(done.id, { state: 'done', completedAt: e.ctx.now() });
    e.core.directives.checkRoundDone(d2.id);
    cutOut(e, pending(directiveKey(d2.id), 'final_result')[0]!);
    await e.core.recovery.run();
    expect(pending(directiveKey(d2.id), 'final_result')).toEqual([]);
    await sleep(5);
    const r2 = e.ctx.store.directives.require(d2.id);
    e.ctx.store.directives.put({ ...r2, round: 2, rounds: [...r2.rounds, { round: 2, requestedAt: e.ctx.now(), text: '2회차', anchored: [], reportId: null }] });
    e.ctx.store.tasks.patch(done.id, { round: 2 });
    await e.core.recovery.run();
    expect(pending(directiveKey(d2.id), 'final_result')).toHaveLength(1);

    // 보고서 작성: 보고 단계 지시
    const d3 = seedDirective(e, '보고 지시');
    e.ctx.store.directives.put({ ...e.ctx.store.directives.require(d3.id), state: 'reporting', finalResult: { round: 1, summary: '요약', outputs: [], changedFiles: [], issues: [], nextSteps: [], submittedAt: e.ctx.now(), by: e.producerId } });
    e.core.directives.queueMainReport(e.ctx.store.directives.require(d3.id));
    const mk = mainKey(e.projectId);
    cutOut(e, pending(mk, 'main_report')[0]!);
    await e.core.recovery.run();
    expect(pending(mk, 'main_report')).toEqual([]);
  });

  it('비정상 종료 상한으로 버린 보고서 작성은 예전처럼 다음 시작에 다시 만든다 — 재시작이 그 일의 재시도다 (지키는 시험)', async () => {
    const e = (renv = await bootRestartable({ holdAll: true }));
    e.core.scheduler.stop();
    const d = seedDirective(e, '보고 지시');
    e.ctx.store.directives.put({ ...d, state: 'reporting', finalResult: { round: 1, summary: '요약', outputs: [], changedFiles: [], issues: [], nextSteps: [], submittedAt: e.ctx.now(), by: e.producerId } });
    e.core.directives.queueMainReport(e.ctx.store.directives.require(d.id));
    const mk = mainKey(e.projectId);
    const q = liveOf(e, (x) => x.sessionKey === mk && x.kind === 'main_report')[0]!;
    // 비정상 종료 상한의 버림은 턴이 마친(done) 채 남는다 — 재시작 상한의 모양이 아니다. 재시작으로 두 번 끊긴 적이 있어도 같다
    doneOk(e, q, 2);
    expect(isRestartLimitDrop(e.ctx.store.queue.require(q.id))).toBe(false);
    await e.core.recovery.run();
    expect(liveOf(e, (x) => x.sessionKey === mk && x.kind === 'main_report')).toHaveLength(1);
  });

  it('검수 안전망은 넘김·검수 항목을 합쳐 가장 최근 것을 본다 — 넘김만 재시작 상한에서 버렸으면 다시 등록하지 않고, 그 뒤 정상 경로의 검수 항목이 더 최근이면 다시 등록한다 (리드 결정 48)', async () => {
    const e = (renv = await bootRestartable({ holdAll: true }));
    e.core.scheduler.stop();
    const d = seedDirective(e);
    const t = seedInReviewTask(e, { directiveId: d.id, assigneeId: e.devId, reviewerId: e.qaId, title: '결제 화면' });
    (e.core.turns as unknown as { handReviewToMain(t: unknown, d: string, p: string | null, c: { producer: string }): void }).handReviewToMain(
      e.ctx.store.tasks.require(t.id),
      d.id,
      e.projectId,
      { producer: '3번의 턴에서 정하지 않았습니다' },
    );
    cutOut(e, e.ctx.store.queue.list({ ref2: mainKey(e.projectId) }).find((q) => isReviewHandOff(q) && q.taskId === t.id)!);
    const reviews = () => liveOf(e, (q) => q.kind === 'review' && q.sessionKey === reviewKey(t.id)).map((q) => q.memberId);
    const rebuilt = () => e.ctx.store.activity.search({ text: '재시작 복구', limit: 50 }).filter((a) => a.text.includes(`${t.id} 검수 중인데`)).map((a) => a.text);
    // (대조) 넘김을 버렸고 검수 항목은 없다 — 안전망과 재시작 3)이 검수를 다시 등록하지 않는다. 버림 알림이 그 일의 업무다
    await e.core.recovery.run();
    expect(reviews()).toEqual([]);
    expect(rebuilt()).toEqual([]);
    // 그 뒤 대표 명령을 받은 메인이 검수를 다시 등록했고(정상 경로), 그 검수 항목은 판정 없이 업무를 남기지 않고 끝났다 — 더 최근이라 막지 않는다
    doneOk(e, enqueue(e.ctx, { kind: 'review', memberId: e.qaId, sessionKey: reviewKey(t.id), projectId: e.projectId, directiveId: d.id, taskId: t.id, message: '검수 (시험)' }));
    expect(e.core.tasks.reviewPending(t.id)).toBe(false);
    await e.core.recovery.run();
    expect(reviews()).toEqual([e.qaId]);
    expect(rebuilt()).toEqual([`재시작 복구: ${t.id} 검수 중인데 대기·실행 중인 검수도, 검수자 재배정이나 메인 에이전트 업무도 없어 검수자 ${e.qaId}에게 검수를 다시 등록`]);
  });

  it('재시작 2)의 병합 대조(시작만 기록되고 반영되지 않은 병합)도 재시작 상한에서 버린 병합 판단을 다시 넣지 않는다 (리드 결정 48)', async () => {
    const e = (renv = await bootRestartable({ holdAll: true }));
    e.core.scheduler.stop();
    const d = seedDirective(e);
    const passed = seedInReviewTask(e, { directiveId: d.id, assigneeId: e.devId, reviewerId: e.qaId });
    e.ctx.store.tasks.patch(passed.id, { outputMode: 'repo', review: { ...passed.review, passed: { reviewId: 'RV-0001', reviewerId: e.qaId, at: e.ctx.now(), target: { kind: 'repo', taskCommitSha: 'abc', baseMainSha: 'def', pinnedAt: e.ctx.now() } } } });
    e.core.merges.queueMergeDecision(e.ctx.store.tasks.require(passed.id));
    cutOut(e, liveOf(e, (q) => q.kind === 'merge_decision' && q.taskId === passed.id)[0]!);
    // 병합을 시작만 기록한 채 끊겼고 기준 브랜치는 그대로다 — 반영되지 않은 병합 (recovered 'not_applied')
    const p = e.ctx.store.projects.require(e.projectId);
    const pre = await e.ctx.deps.git.revParse(p.path, `refs/heads/${p.baseBranch}`);
    expect(pre).toMatch(/^[0-9a-f]{40}$/);
    e.ctx.store.execs.put({ requestId: 'RQ-merge-cut', kind: 'git_merge', projectId: e.projectId, taskId: passed.id, cwd: p.path, command: 'git merge', target: p.baseBranch, state: 'started', startedAt: e.ctx.now(), endedAt: null, result: { preMainSha: pre, taskSha: 'f'.repeat(40) } });
    await e.core.recovery.run();
    expect(e.ctx.store.execs.get('RQ-merge-cut')).toMatchObject({ state: 'failed', result: { recovered: 'not_applied' } });
    expect(liveOf(e, (q) => q.kind === 'merge_decision' && q.taskId === passed.id)).toEqual([]);
  });

  it('mergeNudgeTasks는 병합 재촉 글 머리 뒤의 작업 ID만 읽는다 — 다시 넣기 앞말 등 다른 글의 작업 ID는 읽지 않는다', () => {
    const nudge = (message: string) => ({ kind: 'merge_decision', taskId: null, message }) as QueueEntry;
    expect(mergeNudgeTasks(nudge('검수를 통과했지만 병합 요청이 없는 작업: T-0001, T-0002. request_merge를 호출하세요.'))).toEqual(['T-0001', 'T-0002']);
    // 끊긴 턴의 다시 넣기 앞말(CLI 거부 글 등)의 작업 ID는 빼고, 중복 합치기로 이어 붙은 재촉의 작업 ID는 더한다
    expect(
      mergeNudgeTasks(nudge('CLI 안전 검사가 명령을 거부해 이전 턴이 끝났습니다: rm T-0009/out\n\n(다시 전달) 검수를 통과했지만 병합 요청이 없는 작업: T-0001. request_merge를 호출하세요.\n\n검수를 통과했지만 병합 요청이 없는 작업: T-0001, T-0003. request_merge를 호출하세요.')),
    ).toEqual(['T-0001', 'T-0003']);
    // 병합 판단 요청(queueMergeDecision, taskId 있음)의 글은 재촉이 아니다
    expect(mergeNudgeTasks(nudge('T-0001 "결제"이(가) 독립 검수를 통과했습니다. 병합하려면 request_merge(task_id="T-0001")를 호출하세요.'))).toEqual([]);
  });

  it('restartDropped는 가장 최근 항목만 보고, since 전의 항목은 보지 않는다', () => {
    const at = (id: number, createdAt: string, extra: Partial<QueueEntry> = {}) => ({ id: `W-${String(id).padStart(6, '0')}`, state: 'done', createdAt, ...extra }) as QueueEntry;
    const drop = { state: 'cancelled' as const, restarts: RESTART_CUT_LIMIT };
    expect(restartDropped([])).toBe(false);
    expect(restartDropped([at(1, '2026-10-30T00:00:00Z', drop)])).toBe(true);
    // 번호로 고른다 — 목록 순서와 상관없이
    expect(restartDropped([at(3, '2026-10-30T00:00:02Z'), at(2, '2026-10-30T00:00:01Z', drop)])).toBe(false);
    // 번호가 여섯 자리를 넘어도 숫자로 비교한다 — 글자 순이면 W-999999가 W-1000000보다 뒤다
    expect(restartDropped([at(999999, '2026-10-30T00:00:02Z', drop), at(1000000, '2026-10-30T00:00:03Z')])).toBe(false);
    expect(restartDropped([at(1000000, '2026-10-30T00:00:03Z', drop), at(999999, '2026-10-30T00:00:02Z')])).toBe(true);
    // 취소지만 재시작 횟수가 상한 아래(시작 실패 상한·끝난 일 정리 등)면 재시작 상한의 버림이 아니다
    expect(restartDropped([at(1, '2026-10-30T00:00:00Z', { state: 'cancelled', restarts: 2 })])).toBe(false);
    // since 전의 버림은 다른 대상(지난 회차·앞선 정지)이다
    expect(restartDropped([at(1, '2026-10-30T00:00:00Z', drop)], '2026-10-30T00:00:01Z')).toBe(false);
  });
});
