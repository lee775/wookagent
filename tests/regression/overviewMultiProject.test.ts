/**
 * 전체 현황 (SERVER_DESIGN 5.2·10.5 overviewMultiProject, 리드 결정 S5-3) — 프로젝트 3개 기준 기록에서 숫자가 정확하고 상한을 지킨다:
 * - 진행 중 지시는 열린 지시 중 확인 대기를 뺀 것(프로젝트 화면 projectView와 같다), 확인 대기는 따로. 작업 수는 열린 지시의 지금 회차 작업을 여섯 상태별로,
 *   그 밖의 끝나지 않은 작업(이전 회차에 남은 것)은 otherOpenTasks. 닫힌 지시의 작업은 세지 않는다
 * - 대표 승인 대기 보고는 새 보고와 읽은 보고(읽지 않음 표시), 처리하지 않은 수정 요청, 대표에게 온 질문. 메인이 할 일은 세션 키별·종류별 대기열, 메인 검수,
 *   복구 확인(요청 ID), 넘겨받은 보류. 보류는 사유·메모(가림)·때·건 쪽·reachesMain(대표 화면과 같은 판정)
 * - 목록은 20건(detail이면 100건)까지이고 total이 전체다. 제목은 80자, 메모는 200자. project_id는 프로젝트 칸만 거른다. 일지는 열린 약속과 최근 10건(새 것부터,
 *   서버 기록은 사실·에이전트 기록은 주장). 메인 자리가 응답 없음이면 그 시간과 지워지는 때를 싣는다
 * - 인계 꾸러미와 현황이 같은 고르는 함수를 쓴다 — 수정 요청·승인 대기 보고·메인 검수·메인 대기열 키가 같다
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID, type ExecRecord } from '@shared/domain';
import type { HandoverSection } from '@shared/views';
import { directiveKey, enqueue, mainKey } from '../../src/main/orchestrator/records';
import { alertKey, sweepAlerts } from '../../src/main/orchestrator/alerts';
import { NO_REVIEWER_HOLD_REF } from '../../src/main/orchestrator/tasks';
import { mainOpsIdentity } from './mainOps';
import { bootOrch, seedDirective, startReview, type OrchEnv } from './orchHarness';
import { addDirective, addProject, addTask, hold } from './overviewSeed';

let env: OrchEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

/** 모양으로는 알아볼 수 없는 비밀 값 — 기록한 뒤에 등록해, 읽을 때 다시 가리는지 본다 */
const SECRET = 'zebra-orchard-4471-quartz-plum';
const LONG_TITLE = `결제 화면 ${'아주 긴 제목 '.repeat(20)}`;

/** 프로젝트 셋과 대표 쪽·메인이 할 일·일지를 채운다 */
async function seed(e: OrchEnv) {
  const ctx = e.ctx;
  const p1 = e.projectId;
  const p2 = addProject(e, '둘째').id;
  const p3 = addProject(e, '셋째').id;
  // 메인 검수 턴을 먼저 띄워 둔다 — 메인 업무가 쌓인 뒤면 스케줄러가 명령 처리를 먼저 고른다 (메인 턴은 한 번에 하나)
  const review = await startReview(e, MAIN_AGENT_ID);
  // P1: 진행 지시(지금 회차 작업 여섯 상태 하나씩 — 하나는 검수자 없음 보류), 확인 대기 지시(완료 1), 닫힌 지시(완료 1 — 세지 않음),
  //     2회차 지시(지금 회차 대기 1 + 1회차에 남은 진행 1 — 그 밖의 열린 작업)
  const d1 = addDirective(e, p1);
  const t = {
    waiting: addTask(e, d1, { state: 'waiting' }),
    progress: addTask(e, d1, { state: 'in_progress', title: LONG_TITLE }),
    // 메모는 비밀 값이 200자 경계에 걸친다 — 자르기 전에 가려야 앞부분도 남지 않는다
    held: addTask(e, d1, { state: 'on_hold', holds: [hold(e, 'error', `검수자 없음 — ${'가'.repeat(180)} ${SECRET} 뒤의 글`, { refId: NO_REVIEWER_HOLD_REF })], returnState: 'in_review' }),
    review: addTask(e, d1, { state: 'in_review' }),
    done: addTask(e, d1, { state: 'done' }),
    cancelled: addTask(e, d1, { state: 'cancelled' }),
  };
  const d2 = addDirective(e, p1, { state: 'awaiting_confirmation' });
  addTask(e, d2, { state: 'done' });
  const d3 = addDirective(e, p1, { state: 'closed' });
  addTask(e, d3, { state: 'done' });
  const d4 = addDirective(e, p1, { round: 2 });
  addTask(e, d4, { state: 'waiting' });
  const leftover = addTask(e, d4, { state: 'in_progress', round: 1 });
  // 검수자 없음 보류는 메인에게 업무가 있다 (reachesMain 참)
  enqueue(ctx, { kind: 'no_reviewer', memberId: MAIN_AGENT_ID, sessionKey: `main:${p1}`, projectId: p1, taskId: t.held.id, message: `${t.held.id} 검수자 없음` });
  // 메인에게 넘긴 그 밖의 일 — 멈춘 검수 넘김(작업에 묶이고 메시지 기록이 없는 메시지), 일시정지된 팀원의 재개, 대표에게만 가던 보류·실패(alert, 5.3)
  enqueue(ctx, { kind: 'message', memberId: MAIN_AGENT_ID, sessionKey: `main:${p1}`, projectId: p1, taskId: t.review.id, message: `${t.review.id} 검수가 멈췄습니다` });
  enqueue(ctx, { kind: 'message', memberId: MAIN_AGENT_ID, sessionKey: `main:${p1}`, projectId: p1, pausedMemberId: e.qaId, message: `${e.qaId} 일시정지(프로세스 종료 확인 실패)` });
  enqueue(ctx, { kind: 'alert', memberId: MAIN_AGENT_ID, sessionKey: 'main:general', message: '병합 보류를 확인하세요' });
  ctx.redact.addSecret(SECRET, 'api-key');
  // P2: 일시정지, 계획 중 지시 하나(작업 없음), 프로듀서에게 온 질문
  addDirective(e, p2, { state: 'planning' });
  const stop = ctx.stop();
  ctx.saveStop({ ...stop, projects: { ...stop.projects, [p2]: { paused: true, mode: 'immediate', since: ctx.now(), by: MAIN_AGENT_ID } } });
  const now = ctx.now();
  ctx.store.questions.insert({ id: ctx.store.nextId('question'), projectId: p2, fromId: e.devId, to: 'producer', taskId: null, directiveId: null, sessionKey: 'task:T-9999', text: '로그인은 구글만 받나요?', status: 'open', answer: null, answeredBy: null, createdAt: now, answeredAt: null });
  // P3: 답변 대기 보류 25건 (목록 상한)
  const d5 = addDirective(e, p3);
  const many = Array.from({ length: 25 }, (_, i) => addTask(e, d5, { state: 'on_hold', title: `셋째 작업 ${i}`, holds: [hold(e, 'answer_wait', '프로듀서 답을 기다림', { by: e.devId })] }));

  // 대표 쪽: 질문, 보고(새·읽음·승인됨·수정 요청)
  const q = await e.main('ask_owner', { question: '배포는 언제 할까요?' }, );
  const report = async (title: string) => String((await e.main('submit_report', { title, summary: 's', results: 'r', changed_files: [], how_to_verify: '-', issues: '', next_steps: '' })).reportId);
  const rNew = await report('새 보고');
  const rRead = await report('읽은 보고');
  const rApproved = await report('승인한 보고');
  const rChange = await report('고칠 보고');
  await e.invoke('reports.markRead', rRead);
  ctx.store.reports.put({ ...ctx.store.reports.require(rApproved), status: 'approved', decidedAt: ctx.now() });
  await e.invoke('reports.requestChanges', rChange, { overall: '일정을 넣어 주세요', anchored: [] });
  // 메인이 할 일: 명령(직접 명령·P2), 복구 확인
  await e.invoke('command.send', { target: 'main', text: '오늘 할 일 정리' });
  await e.invoke('command.send', { target: p2, text: '둘째 프로젝트 재개 여부' });
  const exec: ExecRecord = { requestId: 'RQ-ovw-0001', kind: 'git_push', projectId: p1, taskId: null, cwd: e.projectDir, command: 'git push', target: 'origin', state: 'unknown', startedAt: ctx.now(), endedAt: null, result: { recovered: '실행 여부 불명확' } };
  ctx.store.execs.insert(exec);
  // 일지: 약속 2, 결정 1 (그 밖의 서버 기록은 위 조작이 남겼다)
  const p = (i: number) => e.core.journal.write(mainOpsIdentity('main:general', `TN-o${i}`), { kind: 'promise', text: `약속 ${i}`, reason: '확인하면 닫는다' });
  p(0);
  p(1);
  e.core.journal.write(mainOpsIdentity('main:general', 'TN-od'), { kind: 'decision', text: '배포는 금요일' });
  // 긴급 알림 하나
  ctx.notify({ level: 'urgent', title: '프로세스 종료 확인 실패', body: '남은 프로세스가 있습니다', key: 'kill-failed:task:T-0001' });
  return { p1, p2, p3, t, leftover, many, review, q: String(q.questionId), rNew, rRead, rApproved, rChange };
}

describe('전체 현황 (overviewMultiProject)', () => {
  it('프로젝트 셋의 지시·작업 수, 보류(가림·reachesMain), 대표 쪽, 메인이 할 일, 알림, 일지가 정확하다', async () => {
    const e = (env = await bootOrch());
    const s = await seed(e);
    const review = s.review;
    const v = e.core.overview.build();
    expect(v.projects.total).toBe(3);
    const [b1, b2, b3] = v.projects.items;
    expect([b1!.id, b2!.id, b3!.id]).toEqual([s.p1, s.p2, s.p3]);

    // 지시: 진행 중(확인 대기 뺌 — 프로젝트 화면과 같다)과 확인 대기. 메인 검수 턴을 띄운 시험 준비(startReview)의 진행 지시 하나가 더 있다
    expect(b1!.directives).toEqual({ active: 3, awaitingConfirmation: 1 });
    expect(b1!.directives.active).toBe(e.core.views.projectView(e.ctx.store.projects.require(s.p1)).activeDirectiveCount);
    // 작업: 열린 지시의 지금 회차 — 닫힌 지시의 완료는 세지 않고, 이전 회차에 남은 진행은 그 밖의 열린 작업. startReview가 넣은 검수 작업(진행 지시 하나 더)도 든다
    expect(b1!.tasks).toEqual({ waiting: 2, in_progress: 1, on_hold: 1, in_review: 2, done: 2, cancelled: 1, otherOpenTasks: 1 });
    expect(b2!.directives).toEqual({ active: 1, awaitingConfirmation: 0 });
    expect(b2!.tasks).toEqual({ waiting: 0, in_progress: 0, on_hold: 0, in_review: 0, done: 0, cancelled: 0, otherOpenTasks: 0 });
    expect(b3!.tasks.on_hold).toBe(25);

    // 보류: 사유·가린 메모(200자)·때·건 쪽·reachesMain
    const h = b1!.holds.items.find((x) => x.taskId === s.t.held.id)!;
    expect(h.reasons).toHaveLength(1);
    expect(h.reasons[0]).toMatchObject({ kind: 'error', label: '오류', by: 'system', reachesMain: true });
    expect(h.reasons[0]!.note.length).toBeLessThanOrEqual(200);
    expect(h.reasons[0]!.note.endsWith('…')).toBe(true);
    expect(JSON.stringify(v)).not.toContain(SECRET.slice(0, 6));
    expect(h.reasons[0]!.note.startsWith(`검수자 없음 — ${'가'.repeat(180)} `)).toBe(true);
    expect(b3!.holds.items[0]!.reasons[0]).toMatchObject({ kind: 'answer_wait', label: '답변 대기', by: e.devId, reachesMain: false });
    // 화면과 같은 판정이다 (대표 할 일 error·작업의 보류 사유)
    const snap = await e.invoke('snapshot.get');
    expect(snap.ownerTodos.flatMap((x) => (x.kind === 'error' && x.taskId === s.t.held.id ? [x.reachesMain] : []))).toEqual([true]);
    expect(snap.tasks.find((x) => x.id === s.t.held.id)!.hold!.reasons.map((r) => r.reachesMain)).toEqual([true]);
    expect(snap.tasks.find((x) => x.id === s.many[0]!.id)!.hold!.reasons.map((r) => r.reachesMain)).toEqual([false]);
    // 복구 확인은 아직 메인에게 넘기는 업무가 없다 — 대표 할 일에 거짓으로 싣는다(모름이 아니다)
    expect(snap.ownerTodos.flatMap((x) => (x.kind === 'recovery_check' ? [[x.requestId, x.reachesMain]] : []))).toEqual([['RQ-ovw-0001', false]]);
    // 일시정지·프로듀서·팀원·프로듀서에게 온 질문
    expect(b2!.paused).toMatchObject({ mode: 'immediate', by: MAIN_AGENT_ID });
    expect(b1!.paused).toBeNull();
    expect(b1!.producer).toMatchObject({ memberId: e.producerId });
    expect(b1!.members.items.map((m) => m.memberId)).toEqual([e.producerId, e.devId, e.qaId]);
    expect(b1!.members.items[0]).toMatchObject({ isProducer: true, roleName: '프로듀서' });
    expect(b2!.producerQuestions).toMatchObject({ total: 1, items: [{ fromId: e.devId, text: '로그인은 구글만 받나요?' }] });
    expect(b1!.producerQuestions.total).toBe(0);
    // 실행 중 턴 — 메인 검수 턴은 그 작업의 프로젝트 칸에 든다
    expect(b1!.running.items.map((r) => [r.memberId, r.taskId, r.turnId])).toEqual([[MAIN_AGENT_ID, review.task.id, review.turnId]]);
    expect(b2!.running.total).toBe(0);

    // 대표 쪽
    expect(v.owner.questions).toMatchObject({ total: 1, items: [{ questionId: s.q, text: '배포는 언제 할까요?' }] });
    expect(v.owner.reportsAwaitingApproval.items.map((r) => [r.reportId, r.unread])).toEqual([
      [s.rNew, true],
      [s.rRead, false],
    ]);
    expect(v.owner.changeRequests).toMatchObject({ total: 1, items: [{ reportId: s.rChange, comments: 1 }] });

    // 메인이 할 일: 키별(종류별 수)·전체 종류별 수·메인 검수·복구 확인·넘겨받은 보류
    const byKey = Object.fromEntries(v.main.queue.items.map((x) => [x.sessionKey, x.kinds]));
    expect(byKey[`main:${s.p1}`]).toEqual({ no_reviewer: 1, message: 2 });
    // 수정 요청은 수정 요청 업무와 대표 선호를 기억에 반영하는 업무를 함께 넣는다
    expect(byKey['main:general']).toEqual({ alert: 1, main_command: 1, change_request: 1, memory_update: 1 });
    expect(byKey[`main:${s.p2}`]).toEqual({ main_command: 1 });
    expect(byKey[`review:${review.task.id}`]).toEqual({ review: 1 });
    expect(v.main.queue.items.find((x) => x.sessionKey === `review:${review.task.id}`)).toMatchObject({ running: true, projectId: s.p1 });
    expect(v.main.byKind).toEqual({ no_reviewer: 1, message: 2, alert: 1, main_command: 2, change_request: 1, memory_update: 1, review: 1 });
    expect(v.main.reviews.items.map((x) => x.taskId)).toEqual([review.task.id]);
    expect(v.main.recovery.items).toEqual([{ requestId: 'RQ-ovw-0001', kind: 'git_push', projectId: s.p1, taskId: null, finding: '실행 여부 불명확', startedAt: expect.any(String) }]);
    expect(v.main.alerts.items.map((x) => [x.kind, x.label, x.taskId, x.memberId])).toEqual([
      ['no_reviewer', `검수자 없음 ${s.t.held.id}`, s.t.held.id, null],
      ['message', `멈춘 검수 ${s.t.review.id}`, s.t.review.id, null],
      ['message', `일시정지된 팀원 재개 ${e.qaId}`, null, e.qaId],
      ['alert', '보류·실패 처리', null, null],
    ]);

    // 알림·일지
    expect(v.notices.unreadUrgent.items.map((n) => n.title)).toEqual(['프로세스 종료 확인 실패']);
    expect(v.journal.openPromises.items.map((r) => [r.text, r.stale, r.needsCheck])).toEqual([
      ['약속 0 닫는 조건: 확인하면 닫는다', false, false],
      ['약속 1 닫는 조건: 확인하면 닫는다', false, false],
    ]);
    const recent = v.journal.recent.items;
    expect(recent).toHaveLength(10);
    expect(v.journal.recent.total).toBe(e.ctx.store.journal.count({ kinds: ['command', 'action', 'report', 'seat', 'stop', 'decision', 'promise', 'note'] }));
    expect(v.journal.recent.total).toBeGreaterThan(10);
    expect(recent[0]).toMatchObject({ kind: 'decision', author: 'agent', trust: 'claim', text: '배포는 금요일' });
    expect(recent.filter((r) => r.author === 'server').every((r) => r.trust === 'fact')).toBe(true);
    expect(recent.map((r) => r.at)).toEqual([...recent.map((r) => r.at)].sort().reverse());
    // 응답 없음이 아니면 시간과 안내가 없다
    expect([v.seat.unresponsiveForMs, v.seat.unresponsiveNote]).toEqual([null, undefined]);
    review.proc.finishOk();
  });

  it('목록은 20건(detail이면 100건)까지이고 total이 전체다 — 제목 80자, project_id는 프로젝트 칸만 거른다. 응답 없음이면 그 시간과 지워지는 때', async () => {
    const e = (env = await bootOrch());
    const s = await seed(e);
    const v = e.core.overview.build();
    const b3 = v.projects.items.find((p) => p.id === s.p3)!;
    expect([b3.holds.total, b3.holds.items.length]).toEqual([25, 20]);
    expect(b3.holds.items.map((x) => x.taskId)).toEqual(s.many.slice(0, 20).map((x) => x.id));
    const detail = e.core.overview.build({ detail: true }).projects.items.find((p) => p.id === s.p3)!;
    expect([detail.holds.total, detail.holds.items.length]).toEqual([25, 25]);
    // 열린 약속은 50건까지 (detail과 상관없이), 오래된 것부터 — 시험 준비의 2건에 53건을 더한다
    for (let i = 0; i < 53; i++) e.core.journal.write(mainOpsIdentity('main:general', `TN-m${i}`), { kind: 'promise', text: `더 한 약속 ${i}`, reason: '확인하면 닫는다' });
    for (const o of [{}, { detail: true }]) {
      const promises = e.core.overview.build(o).journal.openPromises;
      expect([promises.total, promises.items.length, promises.items[0]!.text, promises.items[49]!.text]).toEqual([55, 50, '약속 0 닫는 조건: 확인하면 닫는다', '더 한 약속 47 닫는 조건: 확인하면 닫는다']);
    }
    // 제목 80자 (보류 목록·메인 검수의 제목)
    const d = addDirective(e, s.p2);
    const longHeld = addTask(e, d, { state: 'on_hold', title: LONG_TITLE, holds: [hold(e, 'blocked', '막힘')] });
    const title = e.core.overview.build().projects.items.find((p) => p.id === s.p2)!.holds.items.find((x) => x.taskId === longHeld.id)!.title;
    expect([title.length, title.endsWith('…'), LONG_TITLE.length > 80]).toEqual([80, true, true]);
    // 프로젝트 거르기: 프로젝트 칸만, 나머지는 그대로
    const only = e.core.overview.build({ projectId: s.p2 });
    expect(only.projects.items.map((p) => p.id)).toEqual([s.p2]);
    expect(only.projects.total).toBe(1);
    const strip = (x: typeof v) => ({ ...x, generatedAt: '', projects: null, seat: { ...x.seat, unresponsiveForMs: null } });
    expect(strip(only)).toEqual(strip(e.core.overview.build()));
    // 응답 없음
    const seat = e.ctx.store.seat.get('main')!;
    e.ctx.store.seat.put({ ...seat, unresponsiveSince: new Date(Date.now() - 5 * 60_000).toISOString(), unresponsiveReason: '사용량 한도로 메인 턴이 3번 연달아 끝났습니다' });
    const u = e.core.overview.build().seat;
    expect(u.unresponsiveForMs).toBeGreaterThanOrEqual(5 * 60_000 - 1000);
    expect(u.unresponsiveNote).toBe('이 턴이 정상으로 끝나면 지워집니다');
    expect(u.unresponsiveReason).toBe('사용량 한도로 메인 턴이 3번 연달아 끝났습니다');
  });

  it('긴급 정지 보류는 정지가 풀린 뒤 가장 최근 정지 해제 목록이 메인에게 있을 때만 메인에게 가 있다 — 정지 중이거나 그 목록을 버렸으면 아니다', async () => {
    const e = (env = await bootOrch());
    const d = addDirective(e, e.projectId);
    const t = addTask(e, d, { state: 'on_hold', holds: [hold(e, 'emergency_stop', '긴급 정지로 보류')] });
    const reach = async () => (await e.invoke('snapshot.get')).tasks.find((x) => x.id === t.id)!.hold!.reasons.map((r) => r.reachesMain);
    const inOverview = () => e.core.overview.build().projects.items[0]!.holds.items.find((x) => x.taskId === t.id)!.reasons.map((r) => r.reachesMain);
    // 지난번 정지 해제 목록이 메인에게 있어도 긴급 정지 중이면 아니다 — 이 보류는 아직 메인에게 가지 않았다
    const list = enqueue(e.ctx, { kind: 'stop_released', memberId: MAIN_AGENT_ID, sessionKey: 'main:general', message: `- ${t.id} "현황 작업" — 긴급 정지` });
    const stop = e.ctx.stop();
    e.ctx.saveStop({ ...stop, global: { active: true, since: e.ctx.now(), by: 'owner', releasedAt: null } });
    expect([await reach(), inOverview()]).toEqual([[false], [false]]);
    e.ctx.saveStop({ ...e.ctx.stop(), global: { active: false, since: null, by: null, releasedAt: e.ctx.now() } });
    expect([await reach(), inOverview()]).toEqual([[true], [true]]);
    // 상한에서 버린 목록 — 대표 알림이 그 일이다
    e.ctx.store.queue.put({ ...e.ctx.store.queue.require(list.id), state: 'cancelled' });
    expect([await reach(), inOverview()]).toEqual([[false], [false]]);
  });

  it('인계 꾸러미와 현황은 같은 고르는 함수를 쓴다 — 수정 요청·승인 대기 보고·메인 검수·메인 대기열 키가 같다', async () => {
    const e = (env = await bootOrch());
    const s = await seed(e);
    const review = s.review;
    const v = e.core.overview.build({ detail: true });
    const seat: HandoverSection = { key: 'seat', title: '자리 정보', unverified: false, lines: [], omitted: 0 };
    const facts = e.core.handover.build({ seat, generation: 2, now: e.ctx.now(), memo: null }).find((x) => x.key === 'facts')!.lines;
    const group = (title: string) => {
      const at = facts.findIndex((l) => l.startsWith(`[${title}]`));
      const end = facts.findIndex((l, i) => i > at && l.startsWith('['));
      return facts.slice(at + 1, end < 0 ? undefined : end);
    };
    const ids = (lines: string[], re: RegExp) => lines.map((l) => re.exec(l)?.[1]).filter(Boolean);
    expect(ids(group('처리하지 않은 대표 수정 요청'), /^- (R-\d+) /)).toEqual(v.owner.changeRequests.items.map((x) => x.reportId));
    expect(ids(group('대표 승인을 기다리는 보고'), /^- (R-\d+) /)).toEqual(v.owner.reportsAwaitingApproval.items.map((x) => x.reportId));
    const mine = group('메인이 맡은 일 (키별 대기·실행, 메인 검수)');
    expect(ids(mine, /^- review:(T-\d+) 메인 검수/)).toEqual(v.main.reviews.items.map((x) => x.taskId));
    expect(ids(mine, /^- ((?:main|review):[^:]+): /)).toEqual(v.main.queue.items.map((x) => x.sessionKey));
    expect(v.owner.changeRequests.items.map((x) => x.reportId)).toEqual([s.rChange]);
    review.proc.finishOk();
  });
});

/** 현황·요약(그 프로젝트 대화)·대표 화면 스냅숏이 일시정지로 보이는 팀원 */
async function pausedEverywhere(e: OrchEnv): Promise<{ overview: string[]; digest: string | null; snapshot: string[]; tray: string }> {
  const snap = await e.invoke('snapshot.get');
  return {
    overview: e.core.overview.build({ detail: true }).stop.pausedMembers.map((m) => m.memberId),
    digest: e.core.overview.digest({ sessionKey: mainKey(e.projectId) }).split('\n').find((l) => l.includes('일시정지된 팀원')) ?? null,
    snapshot: snap.stop.pausedMembers.map((m) => m.memberId),
    tray: snap.trayStatus,
  };
}
const NONE_PAUSED = { overview: [], digest: null, snapshot: [], tray: 'normal' };
/** 대표가 알림을 읽은 것으로 둔다 — 읽지 않은 긴급 알림(종료 확인 실패)이 트레이를 오류로 덮지 않게 */
const readAllNotices = (e: OrchEnv) => {
  for (const n of e.ctx.store.notifications.list({ state: 'unread' })) e.ctx.store.notifications.put({ ...n, readAt: e.ctx.now() });
};
/** 메인이 받은 것으로 둔다 — 알림·재개 업무를 받아 그 출구를 따르는 차례 */
const mainReceivedAll = (e: OrchEnv) => {
  for (const q of e.ctx.store.queue.list({ ref1: MAIN_AGENT_ID, state: 'queued' })) e.ctx.store.queue.put({ ...q, state: 'done', doneAt: e.ctx.now() });
};

describe('삭제된 팀원은 일시정지로 보이지 않는다 (리드 결정 S5-64, 프로브 zz-s5af6-phantompause)', () => {
  for (const how of ['main-pause', 'system-pause'] as const) {
    it(`${how}: 일시정지된 프로듀서를 알림의 출구(replace_producer)대로 바꾸면 그 정지 기록을 함께 지운다 — 현황·요약·화면 어디에도 일시정지로 남지 않는다`, async () => {
      const e = (env = await bootOrch());
      const old = e.producerId;
      const name = e.ctx.store.members.require(old).name;
      const d = seedDirective(e);
      if (how === 'main-pause') await e.main('pause_member', { member_id: old, mode: 'graceful', reason: '시험' });
      await e.core.turns.blockUnconfirmedRun(
        { label: '프로듀서 관리 턴', sessionKind: 'directive', sessionKey: directiveKey(d.id), memberId: old, projectId: e.projectId, taskId: null, turnId: null },
        { envProblem: null, remaining: 2, cause: null, what: '턴' },
      );
      const was = e.ctx.stop().members[old]!;
      expect(was.paused).toBe(true);
      expect((await pausedEverywhere(e)).overview).toEqual([old]);
      mainReceivedAll(e);
      await e.main('replace_producer', { project_id: e.projectId, reason: '알림의 출구대로 (시험)' });
      expect(e.ctx.store.members.require(old).deletedAt).toBeTruthy();
      // 지우는 트랜잭션이 정지 기록을 지우고 활동 기록에 남긴다
      expect(e.ctx.stop().members[old]).toBeUndefined();
      const by = how === 'main-pause' ? e.ctx.store.members.require(MAIN_AGENT_ID).name : '욱채';
      expect(e.ctx.store.activity.search({ text: `프로듀서 교체로 ${name}(${old})의 일시정지 기록을 지움`, limit: 5 }).map((a) => [a.text, a.memberId])).toEqual([
        [`프로듀서 교체로 ${name}(${old})의 일시정지 기록을 지움 — ${by}이(가) ${was.since}에 건 정지${was.reason ? ` (${was.reason})` : ''}`, old],
      ]);
      readAllNotices(e);
      expect(await pausedEverywhere(e)).toEqual(NONE_PAUSED);
    });
  }

  it('예전 대표 정지가 남은 팀원을 알림의 출구(remove_member)대로 지우면 그 정지 기록을 함께 지운다', async () => {
    const e = (env = await bootOrch());
    const s = e.ctx.stop();
    e.ctx.saveStop({ ...s, members: { ...s.members, [e.qaId]: { paused: true, mode: 'graceful', by: 'owner', since: e.ctx.now() } } });
    sweepAlerts(e.ctx);
    const [lp] = e.ctx.store.queue.list({ ref1: MAIN_AGENT_ID }).filter((q) => q.alertKey === alertKey('legacy-pause', e.qaId));
    const exit = lp!.message.split('\n').at(-1)!;
    const call = /remove_member\(member_id="([^"]+)"\)/.exec(exit);
    expect(call?.[1]).toBe(e.qaId);
    mainReceivedAll(e);
    await e.main('remove_member', { member_id: call![1]! });
    expect(e.ctx.store.members.require(e.qaId).deletedAt).toBeTruthy();
    expect(e.ctx.stop().members[e.qaId]).toBeUndefined();
    expect(e.ctx.store.activity.search({ text: `팀원 삭제로 ${e.ctx.store.members.require(e.qaId).name}(${e.qaId})의 일시정지 기록을 지움`, limit: 5 })).toHaveLength(1);
    expect(await pausedEverywhere(e)).toEqual(NONE_PAUSED);
  });

  it('그 전의 DB에 남은 삭제된 팀원의 정지 기록도 현황·요약·화면(트레이 포함)은 일시정지로 세지 않는다 — 살아 있는 팀원의 정지는 그대로 보인다', async () => {
    const e = (env = await bootOrch());
    await e.main('remove_member', { member_id: e.qaId });
    // 지우는 트랜잭션이 정지 기록을 지우기 전(5단계 S5F11 전)의 삭제는 기록을 남겼다 — 그 모양을 그대로 둔다
    const s = e.ctx.stop();
    e.ctx.saveStop({ ...s, members: { ...s.members, [e.qaId]: { paused: true, mode: 'graceful', by: 'owner', since: e.ctx.now() } } });
    expect(await pausedEverywhere(e)).toEqual(NONE_PAUSED);
    await e.main('pause_member', { member_id: e.devId, mode: 'graceful', reason: '시험' });
    const now = await pausedEverywhere(e);
    expect([now.overview, now.snapshot, now.tray]).toEqual([[e.devId], [e.devId], 'paused']);
    expect(now.digest).toContain(`(${e.devId})`);
    expect(now.digest).not.toContain(`(${e.qaId})`);
  });
});
