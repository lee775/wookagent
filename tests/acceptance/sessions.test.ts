/**
 * 인수 테스트 — 세션 그룹 (기획서 17장 AC-34·35·36·37·40·41).
 * 근거 절: 5.3(질문→보류(답변 대기)), 5.7(동시 실행·자리 반환·관리 예약), 8장(헛돌기), 9장·CLI-10(메인 에이전트 긴급 지시),
 * 15.4(턴 진행 흐름), CLI-18(턴 종료 판정), CLI-20(세션·팀원 잠금), ERR-03(세션 교체 인계), MEM-10(작업별 새 세션).
 * - orchHarness(가짜 CLI): 턴 경계·정지·자리를 테스트가 정확히 정한다
 * - e2e 하네스(실제 SQLite·git·프로세스 러너·모의 에이전트 프로세스): 실제 프로세스로 같은 흐름을 확인한다
 * 판정 기준은 기획서 문구다. 기획서가 정하지 않은 화면 표시('전달됨' 등)나 설계 문서만의 규칙은 인수 실패로 보지 않는다.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAIN_AGENT_ID } from '@shared/domain';
import { directiveKey, enqueue, mainKey, reviewKey, taskKey } from '../../src/main/orchestrator/records';
import { artifactWorkDir } from '../../src/main/orchestrator/paths';
import { createHarness, sendCommand, type Harness } from '../e2e/harness';
import { notices, seedDirective, seedInReviewTask, type FakeProc } from '../regression/orchHarness';
import {
  bootSessions,
  forgetMockSession,
  isAlive,
  launchesOfKey,
  liveCount,
  makeTask,
  monitorLaunches,
  overlaps,
  scriptTurns,
  sleep,
  slots,
  stepsDone,
  ticks,
  toolOk,
  turnsOfKey,
  waitFor,
  wrapMockRuns,
  type SessEnv,
  type WrapControl,
} from './sessions-helpers';

let env: SessEnv | null = null;
let harness: Harness | null = null;
let wrap: WrapControl | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
  // 붙잡힌 턴은 앱 종료(stopAll)가 프로세스 트리째 끝낸다 — 그 뒤에 감싸기 폴더·남은 손자를 정리
  await harness?.close();
  harness = null;
  wrap?.restore();
  wrap = null;
});

const noProgress = (e: SessEnv, taskId: string) => e.ctx.store.tasks.require(taskId).noProgressResumes;

// ───────────────────────── AC-34 ─────────────────────────

describe('AC-34 턴 종료 후 자동 재개와 헛돌기 (CLI-18, 8장)', () => {
  it('AC-34: 턴이 끝났는데 단계가 남아 있으면 다음 턴이 자동으로 시작된다 — 같은 세션 이어하기, 남은 단계 안내, 테스트가 tick을 부르지 않음', async () => {
    const e = (env = await bootSessions({ autoSchedule: true }));
    const d = seedDirective(e);
    const t = makeTask(e, { directiveId: d.id, assignee: e.devId });
    const key = taskKey(t.id);
    scriptTurns(e, key, [
      async (p) => {
        await toolOk(e, p.turnId, 'set_steps', { steps: ['요구 확인', '구현', '점검'] });
        await toolOk(e, p.turnId, 'complete_step', { step_index: 0, note: '요구 확인 완료' });
        p.finishOk('1단계까지 했습니다');
      },
      async (p) => {
        await toolOk(e, p.turnId, 'complete_step', { step_index: 1, note: '구현 완료' });
        p.finishOk('2단계까지 했습니다');
      },
      () => undefined, // 셋째 턴은 살아 있게 둔다 (여기서 확인을 멈춘다)
    ]);
    await waitFor(() => turnsOfKey(e, key).length === 3, '셋째 턴 자동 시작', 20_000);
    expect(e.scriptErrors).toEqual([]);
    const turns = turnsOfKey(e, key);
    const launches = launchesOfKey(e, key);
    // 같은 업무 세션을 이어서 (CLI 세션 ID 그대로 resume)
    expect(new Set(turns.map((x) => x.sessionId)).size).toBe(1);
    expect(turns.map((x) => x.isResume)).toEqual([false, true, true]);
    const cli = launches[0]!.newSessionId;
    expect(cli).toBeTruthy();
    expect(launches.slice(1).map((l) => l.resume)).toEqual([cli, cli]);
    // 앞 턴이 끝난 뒤에 시작
    expect(turns[1]!.startedAt >= turns[0]!.endedAt!).toBe(true);
    expect(turns[2]!.startedAt >= turns[1]!.endedAt!).toBe(true);
    expect(turns.slice(0, 2).map((x) => x.endReason)).toEqual(['completed', 'completed']);
    // '계속' 메시지가 남은 단계를 알린다
    expect(launches[1]!.message).toContain('계속 진행하세요. 남은 단계 2개');
    expect(launches[2]!.message).toContain('계속 진행하세요. 남은 단계 1개');
    const cur = e.ctx.store.tasks.require(t.id);
    expect(cur.state).toBe('in_progress');
    expect(cur.noProgressResumes).toBe(0);
  });

  it('AC-34: 진척 없는 자동 재개가 3번 이어지면 헛돌기로 처리된다 — 작업 보류(재계획)·프로듀서 재계획 업무, 다음 턴은 띄우지 않는다', async () => {
    const e = (env = await bootSessions({ autoSchedule: true }));
    const d = seedDirective(e);
    e.hold.add(directiveKey(d.id)); // 프로듀서 재계획 턴은 살아 있게 두고 받은 내용을 본다
    const t = makeTask(e, { directiveId: d.id, assignee: e.devId });
    const key = taskKey(t.id);
    const seen: number[] = [];
    scriptTurns(e, key, [
      async (p) => {
        await toolOk(e, p.turnId, 'set_steps', { steps: ['하나', '둘', '셋', '넷'] });
        await toolOk(e, p.turnId, 'complete_step', { step_index: 0, note: '하나 완료' });
        p.finishOk('진척 있음');
      },
      (p) => {
        seen.push(noProgress(e, t.id));
        p.finishOk('아무것도 못 했습니다'); // 단계 완료 없음
      },
    ]);
    await waitFor(() => e.ctx.store.tasks.require(t.id).state === 'on_hold', '헛돌기 보류', 20_000);
    await sleep(600); // 자동 실행 중 — 더 뜨는 턴이 없는지
    expect(e.scriptErrors).toEqual([]);
    const turns = turnsOfKey(e, key);
    // 첫 턴(진척) + 자동 재개 3번(모두 진척 없음) → 넷째 턴 뒤 헛돌기, 다섯째 턴 없음
    expect(turns).toHaveLength(4);
    expect(turns.slice(1).every((x) => x.isResume && x.stepsCompleted === 0)).toBe(true);
    expect(seen).toEqual([0, 1, 2]); // 각 자동 재개가 시작될 때까지 이어진 진척 없는 재개 수
    const held = e.ctx.store.tasks.require(t.id);
    expect(held.hold.reasons.map((r) => r.kind)).toEqual(['replan']);
    expect(held.hold.reasons[0]!.note).toContain('진척 없는 자동 재개 3회');
    expect(held.hold.returnState).toBe('in_progress');
    expect(e.ctx.store.queue.list({ ref2: key, state: 'queued' })).toEqual([]);
    // 프로듀서가 방법 변경·재계획·재배정을 하도록 (8장 헛돌기 조치)
    await waitFor(() => launchesOfKey(e, directiveKey(d.id)).some((l) => l.message.includes('헛돌기')), '프로듀서 재계획 업무');
    const replan = launchesOfKey(e, directiveKey(d.id)).find((l) => l.message.includes('헛돌기'))!;
    expect(replan.memberId).toBe(e.producerId);
    expect(replan.message).toContain(t.id);
    expect(replan.message).toContain('replan_task');
  });

  it('AC-34: 헛돌기는 진척 없는 재개가 "이어질" 때만 — 중간에 단계를 하나라도 마치면 다시 센다', async () => {
    const e = (env = await bootSessions({ autoSchedule: true }));
    const d = seedDirective(e);
    e.hold.add(directiveKey(d.id));
    const t = makeTask(e, { directiveId: d.id, assignee: e.devId });
    const key = taskKey(t.id);
    const seen: number[] = [];
    const none = (p: FakeProc) => {
      seen.push(noProgress(e, t.id));
      p.finishOk('진척 없음');
    };
    scriptTurns(e, key, [
      async (p) => {
        await toolOk(e, p.turnId, 'set_steps', { steps: ['1', '2', '3', '4', '5', '6'] });
        await toolOk(e, p.turnId, 'complete_step', { step_index: 0, note: '1 완료' });
        p.finishOk();
      },
      none,
      none,
      async (p) => {
        seen.push(noProgress(e, t.id));
        await toolOk(e, p.turnId, 'complete_step', { step_index: 1, note: '2 완료' }); // 진척 → 다시 센다
        p.finishOk();
      },
      none,
      none,
      none,
    ]);
    await waitFor(() => e.ctx.store.tasks.require(t.id).state === 'on_hold', '헛돌기 보류', 25_000);
    await sleep(600);
    expect(e.scriptErrors).toEqual([]);
    expect(seen).toEqual([0, 1, 2, 0, 1, 2]);
    // 진척 없는 재개 2번 → 진척 → 진척 없는 재개 3번째 턴 뒤에만 헛돌기 (턴 7개)
    expect(turnsOfKey(e, key)).toHaveLength(7);
    expect(e.ctx.store.tasks.require(t.id).hold.reasons.map((r) => r.note)).toEqual(['진척 없는 자동 재개 3회']);
  });

  it('AC-34 (실제 프로세스): 모의 에이전트 턴이 시간 상한으로 끊겨 단계가 남으면 프로그램이 같은 세션으로 다음 턴을 이어 띄우고 끝까지 간다', async () => {
    const h = (harness = await createHarness({
      team: ['developer'],
      scenarios: { developer: 'slow' },
      speed: 2,
      settings: { execution: { turnTimeoutMin: 0.1 } }, // 6초 — 느린 단계(2.5초)가 다 끝나기 전에 턴을 끊는다
    }));
    const did = await sendCommand(h, '로그인 화면을 만들어 줘');
    await h.waitFor(() => h.core.ctx.store.tasks.list({ ref1: did }).some((t) => t.state === 'in_review' || t.state === 'done'), { timeoutMs: 60_000, label: '검수 도착' });
    const task = h.core.ctx.store.tasks.list({ ref1: did }).find((t) => t.assigneeId === h.members.developer)!;
    const key = taskKey(task.id);
    const turns = h.core.ctx.store.turns.list().filter((x) => h.core.ctx.store.sessions.get(x.sessionId)?.workKey === key);
    expect(turns.length).toBeGreaterThanOrEqual(2);
    // 첫 턴은 단계가 남은 채 끊겼고, 다음 턴은 같은 세션의 이어하기
    expect(turns[0]!.endReason).toBe('timeout');
    expect(turns[0]!.stepsCompleted).toBeLessThan(3);
    expect(new Set(turns.map((x) => x.sessionId)).size).toBe(1);
    expect(turns.slice(1).every((x) => x.isResume)).toBe(true);
    expect(turns[1]!.startedAt >= turns[0]!.endedAt!).toBe(true);
    // 다음 턴에 '계속 진행' 안내가 전달됐다
    const entries = h.core.ctx.store.queue.list({ ref2: key }).filter((q) => q.turnId === turns[1]!.id);
    expect(entries.map((q) => q.kind)).toContain('task_work');
    expect(entries.map((q) => q.message).join('\n')).toMatch(/턴 시간 상한\(0\.1분\)으로 끊겼습니다\. (계속 진행하세요\. 남은 단계|아직 단계 목록이 없습니다)/);
    expect(h.core.ctx.store.steps.list(task.id).every((s) => s.done)).toBe(true);
  }, 90_000);
});

// ───────────────────────── AC-35 ─────────────────────────

describe('AC-35 세션당 프로세스 1개·팀원당 실행 업무 1개 (5.7 팀원별 실행, CLI-20)', () => {
  it('AC-35: 같은 세션은 실행 중이면 다시 띄우지 않는다 — 그 세션에 업무가 쌓이고 tick이 겹쳐도 턴은 하나, 끝난 뒤 한 턴에 묶어 전달', async () => {
    const e = (env = await bootSessions());
    const d = seedDirective(e);
    const t = makeTask(e, { directiveId: d.id, assignee: e.devId });
    const key = taskKey(t.id);
    e.hold.add(key);
    e.tick();
    await waitFor(() => liveCount(e, key) === 1, '첫 턴');
    const first = e.liveProc(key)!;
    // 같은 세션으로 업무가 더 온다: 메인 에이전트 긴급 지시, 프로듀서 메시지, 프로그램의 '계속' 안내
    await e.main('instruct_member', { member_id: e.devId, text: '긴급 지시: 로그 형식 확인', urgent: true });
    enqueue(e.ctx, { kind: 'message', memberId: e.devId, sessionKey: key, projectId: e.projectId, taskId: t.id, directiveId: d.id, message: '프로듀서 메시지: 테스트도 보세요' });
    e.core.tasks.continueWork(t.id, '계속 진행하세요 (추가 안내)');
    for (let i = 0; i < 10; i++) {
      e.tick();
      e.tick(); // 같은 순간에 겹친 tick
      await sleep(15);
    }
    expect(turnsOfKey(e, key)).toHaveLength(1);
    expect(liveCount(e, key)).toBe(1);
    expect(e.ctx.store.queue.list({ ref2: key, state: 'queued' }).map((q) => q.kind).sort()).toEqual(['message', 'message', 'task_work']);

    e.hold.delete(key);
    first.finishOk();
    await waitFor(() => !e.core.turns.hasLiveSession(key), '첫 턴 종료');
    e.hold.add(key);
    e.tick();
    e.tick();
    e.tick(); // 끝난 직후 tick이 연달아 와도 하나만
    await waitFor(() => liveCount(e, key) === 1, '둘째 턴');
    await sleep(50);
    const turns = turnsOfKey(e, key);
    expect(turns).toHaveLength(2);
    expect(turns[1]!.startedAt >= turns[0]!.endedAt!).toBe(true);
    // 쌓인 업무는 한 턴에 묶여 전달됐다 (CLI-19)
    const delivered = e.ctx.store.queue.list({ ref2: key }).filter((q) => q.turnId === turns[1]!.id);
    expect(delivered.map((q) => q.kind).sort()).toEqual(['message', 'message', 'task_work']);
    expect(e.monitor.violations).toEqual([]);
  });

  it('AC-35: 한 팀원은 서로 다른 세션으로 두 업무를 동시에 실행하지 않는다 — QA가 자기 작업 턴 중이면 배정된 검수는 기다렸다가 그 턴이 끝난 뒤 실행, 그 동안 자기 작업은 다시 띄우지 않는다', async () => {
    const e = (env = await bootSessions());
    const d = seedDirective(e);
    const own = makeTask(e, { directiveId: d.id, assignee: e.qaId, type: 'test', title: 'QA 자기 작업' });
    const ownKey = taskKey(own.id);
    scriptTurns(e, ownKey, [
      async (p) => {
        await toolOk(e, p.turnId, 'set_steps', { steps: ['범위', '실행'] });
        await toolOk(e, p.turnId, 'complete_step', { step_index: 0, note: '범위 정리' });
        // 살아 있는 채로 둔다 (테스트가 끝낸다)
      },
      () => undefined,
    ]);
    e.tick();
    await waitFor(() => liveCount(e, ownKey) === 1 && stepsDone(e, own.id) === 1, 'QA 자기 작업 턴');
    // 남의 작업 검수 배정 (관리 업무)
    const rv = seedInReviewTask(e, e.qaId);
    const rvKey = reviewKey(rv.id);
    e.hold.add(rvKey);
    e.core.tasks.dispatchReview(e.ctx.store.tasks.require(rv.id));
    await ticks(e, 8);
    expect(liveCount(e, rvKey)).toBe(0);
    expect(e.ctx.store.queue.list({ ref2: rvKey, state: 'queued' }).map((q) => `${q.kind}:${q.memberId}`)).toEqual([`review:${e.qaId}`]);

    // 자기 작업 턴이 끝난다 (단계가 남아 '계속'이 대기열에 들어감) → 관리 업무(검수)가 먼저, 자기 작업은 기다린다
    e.liveProc(ownKey)!.finishOk('1단계 마침');
    await waitFor(() => !e.core.turns.hasLiveSession(ownKey), '자기 작업 턴 종료');
    await ticks(e, 2);
    await waitFor(() => liveCount(e, rvKey) === 1, '검수 턴 시작');
    expect(e.ctx.store.queue.list({ ref2: ownKey, state: 'queued' }).map((q) => q.kind)).toEqual(['task_work']);
    await ticks(e, 8);
    expect(liveCount(e, ownKey)).toBe(0);
    expect(e.procs.filter((p) => !p.done && p.memberId === e.qaId)).toHaveLength(1);

    // 검수 결과 등록 후 검수 턴이 끝나면 자기 작업을 이어 간다
    const rvProc = e.liveProc(rvKey)!;
    await toolOk(e, rvProc.turnId, 'submit_review', { task_id: rv.id, verdict: 'reject', criteria: [{ criterion: '문서가 있다', pass: false, note: '보완' }], reason: '보완 필요' });
    rvProc.finishOk();
    await waitFor(() => !e.core.turns.hasLiveSession(rvKey), '검수 턴 종료');
    await ticks(e, 2);
    await waitFor(() => liveCount(e, ownKey) === 1, '자기 작업 재개');
    const qaTurns = e.ctx.store.turns.list({ ref1: e.qaId });
    expect(qaTurns.map((x) => x.sessionKind)).toEqual(['task', 'review', 'task']);
    expect(overlaps(qaTurns)).toEqual([]);
    expect(e.monitor.violations).toEqual([]);
  });

  it('AC-35: 프로듀서·메인 에이전트도 한 번에 한 세션만 실행 — 지시 A 관리 턴 중 지시 B 계획·검수는 기다리고, 프로젝트 대화 중 직접 명령은 기다린다', async () => {
    const e = (env = await bootSessions());
    const dA = e.core.directives.register({ projectId: e.projectId, title: '지시 A', text: 'A를 해 줘' }, MAIN_AGENT_ID, null);
    e.hold.add(directiveKey(dA.id));
    e.tick();
    await waitFor(() => liveCount(e, directiveKey(dA.id)) === 1, '지시 A 계획 턴');
    const dB = e.core.directives.register({ projectId: e.projectId, title: '지시 B', text: 'B를 해 줘' }, MAIN_AGENT_ID, null);
    const rv = seedInReviewTask(e, e.producerId);
    e.core.tasks.dispatchReview(e.ctx.store.tasks.require(rv.id));
    const producerKeys = [directiveKey(dA.id), directiveKey(dB.id), reviewKey(rv.id)];
    for (const k of producerKeys) e.hold.add(k);
    // 메인 에이전트: 프로젝트 대화(main:P) + 직접 명령(main:general)
    e.hold.add(mainKey(e.projectId));
    e.hold.add(mainKey(null));
    await e.invoke('command.send', { target: e.projectId, text: '프로젝트 현황을 알려 줘' });
    await e.invoke('command.send', { target: 'main', text: '오늘 일정 정리해 줘' });
    await ticks(e, 8);
    const liveOf = (memberId: string) => e.procs.filter((p) => !p.done && p.memberId === memberId).map((p) => p.workKey);
    expect(liveOf(e.producerId)).toEqual([directiveKey(dA.id)]);
    expect(liveOf(MAIN_AGENT_ID)).toHaveLength(1);
    // 차례로 끝내도 언제나 한 세션만 — 기다리던 다른 세션들이 하나씩 돈다 (작업 없이 끝난 계획 턴은 재촉 항목이 다시 들어온다)
    const ranProducer = new Set<string>();
    const ranMain = new Set<string>();
    for (let round = 0; round < 12 && (ranProducer.size < producerKeys.length || ranMain.size < 2); round++) {
      for (const k of liveOf(e.producerId)) ranProducer.add(k);
      for (const k of liveOf(MAIN_AGENT_ID)) ranMain.add(k);
      expect(liveOf(e.producerId).length).toBeLessThanOrEqual(1);
      expect(liveOf(MAIN_AGENT_ID).length).toBeLessThanOrEqual(1);
      for (const p of e.procs.filter((x) => !x.done && (x.memberId === e.producerId || x.memberId === MAIN_AGENT_ID))) p.finishOk();
      await waitFor(() => !e.core.turns.isMemberRunning(e.producerId) && !e.core.turns.isMemberRunning(MAIN_AGENT_ID), '관리 턴 종료');
      await ticks(e, 4);
    }
    expect([...ranProducer].sort()).toEqual([...producerKeys].sort());
    expect([...ranMain].sort()).toEqual([mainKey(null), mainKey(e.projectId)].sort());
    expect(overlaps(e.ctx.store.turns.list({ ref1: e.producerId }))).toEqual([]);
    expect(overlaps(e.ctx.store.turns.list({ ref1: MAIN_AGENT_ID }))).toEqual([]);
    expect(e.monitor.violations).toEqual([]);
  });

  it('AC-35: 한 팀원에게 배정된 일반 작업은 하나씩만 — 첫 작업이 검수 중이라 실행 중인 턴이 없어도 둘째 작업은 시작하지 않고, 첫 작업이 끝난 뒤에야 새 세션으로 시작한다 (ORG-09, 5.7 일반 작업 활성화)', async () => {
    const e = (env = await bootSessions());
    const d = seedDirective(e);
    const t1 = makeTask(e, { directiveId: d.id, assignee: e.devId, title: '첫 문서', type: 'docs', outputMode: 'artifact' });
    const t2 = makeTask(e, { directiveId: d.id, assignee: e.devId, title: '둘째 작업' });
    const [k1, k2, rk] = [taskKey(t1.id), taskKey(t2.id), reviewKey(t1.id)];
    e.hold.add(k2);
    e.hold.add(rk);
    scriptTurns(e, k1, [
      async (p) => {
        await toolOk(e, p.turnId, 'set_steps', { steps: ['문서 작성'] });
        writeFileSync(join(artifactWorkDir(e.ctx.paths, e.projectId, t1.id), 'a.md'), '# 문서\n', 'utf8');
        await toolOk(e, p.turnId, 'complete_step', { step_index: 0, note: '작성' });
        await toolOk(e, p.turnId, 'submit_for_review', { note: '제출' });
        p.finishOk('제출');
      },
    ]);
    e.tick();
    await waitFor(() => e.ctx.store.tasks.require(t1.id).state === 'in_review', '첫 작업 검수 대기');
    await ticks(e, 8);
    // 개발자는 실행 중인 턴이 없고 자리도 남지만, 첫 작업이 끝나기 전에는 둘째 작업을 활성화하지 않는다
    expect(e.core.turns.isMemberRunning(e.devId)).toBe(false);
    expect(slots(e).general).toBe(0);
    const waiting = e.ctx.store.tasks.require(t2.id);
    expect([waiting.state, waiting.activatedAt]).toEqual(['waiting', null]);
    expect(turnsOfKey(e, k2)).toHaveLength(0);
    // 검수 통과 → 산출물 확정 → 첫 작업 완료 → 둘째 작업 시작
    await waitFor(() => liveCount(e, rk) === 1, '프로듀서 검수 턴');
    const rv = e.liveProc(rk)!;
    await toolOk(e, rv.turnId, 'submit_review', { task_id: t1.id, verdict: 'pass', criteria: [{ criterion: '동작한다', pass: true, note: '확인' }], reason: '' });
    rv.finishOk();
    await waitFor(() => e.ctx.store.tasks.require(t1.id).state === 'done', '첫 작업 완료');
    e.tick();
    await waitFor(() => liveCount(e, k2) === 1, '둘째 작업 첫 턴');
    const [s2] = e.ctx.store.sessions.list({ ref2: k2 });
    expect(s2!.memberId).toBe(e.devId);
    expect(turnsOfKey(e, k2)[0]!.startedAt >= e.ctx.store.tasks.require(t1.id).completedAt!).toBe(true);
    expect(overlaps(e.ctx.store.turns.list({ ref1: e.devId }))).toEqual([]);
    expect(e.monitor.violations).toEqual([]);
  });

  it('AC-35 (실제 프로세스): 모의 팀이 지시를 끝까지 처리하는 동안 같은 팀원·같은 세션의 턴이 한 번도 겹치지 않는다', async () => {
    const h = (harness = await createHarness({ team: ['developer', 'developer', 'qa'] }));
    const mon = monitorLaunches(h.core, 5);
    const did = await sendCommand(h, '회원 가입 화면과 테스트를 만들어 줘');
    await h.waitFor(() => h.core.ctx.store.directives.get(did)?.state === 'awaiting_confirmation', { timeoutMs: 90_000, label: '보고 도착' });
    mon.restore();
    const turns = h.core.ctx.store.turns.list();
    const byMember = new Map<string, typeof turns>();
    const bySession = new Map<string, typeof turns>();
    for (const t of turns) {
      byMember.set(t.memberId, [...(byMember.get(t.memberId) ?? []), t]);
      bySession.set(t.sessionId, [...(bySession.get(t.sessionId) ?? []), t]);
    }
    for (const [m, list] of byMember) expect(overlaps(list), `팀원 ${m}`).toEqual([]);
    for (const [s, list] of bySession) expect(overlaps(list), `세션 ${s}`).toEqual([]);
    expect(mon.violations).toEqual([]);
    // 의미 있는 확인인지: 프로듀서가 여러 세션(지시 관리·검수)을 돌렸고, 동시에 여러 팀원이 실행됐다
    const producerKeys = new Set(turns.filter((t) => t.memberId === h.members.producer).map((t) => h.core.ctx.store.sessions.get(t.sessionId)!.workKey));
    expect(producerKeys.size).toBeGreaterThanOrEqual(2);
    expect(mon.maxTotal).toBeGreaterThanOrEqual(2);
  }, 120_000);
});

// ───────────────────────── AC-36 ─────────────────────────

/** 개발자 작업 턴을 띄워 1단계까지 마친 채 살아 있게 둔다 */
async function devTurnWithStepLeft(e: SessEnv): Promise<{ taskId: string; key: string; directiveId: string }> {
  const d = seedDirective(e);
  const t = makeTask(e, { directiveId: d.id, assignee: e.devId });
  const key = taskKey(t.id);
  scriptTurns(e, key, [
    async (p) => {
      await toolOk(e, p.turnId, 'set_steps', { steps: ['요구 확인', '구현', '점검'] });
      await toolOk(e, p.turnId, 'complete_step', { step_index: 0, note: '요구 확인' });
      // 살아 있다 — 테스트가 끝낸다
    },
    () => undefined,
  ]);
  e.tick();
  await waitFor(() => liveCount(e, key) === 1 && stepsDone(e, t.id) === 1, '개발자 작업 턴');
  return { taskId: t.id, key, directiveId: d.id };
}

const OWNER_FIRST = /^\[욱채 · 작업 · task:T-\d+\] 이번 턴에 전달된 일 \d건\n\n### 1\. 메시지 확인 \(긴급 지시 우선 전달\)\n> 메인 에이전트 긴급 지시/;

describe('AC-36 메인 에이전트 긴급 지시 전달 (CLI-10, 15.4, 9장)', () => {
  it('AC-36: 메인 에이전트 긴급 지시는 실행 중인 턴이 끝난 뒤 같은 업무 세션(같은 CLI 세션 이어하기)에 맨 앞으로 전달된다 — 턴 도중에는 끼어들지 않고, 받은 즉시 저장·공유된다', async () => {
    const e = (env = await bootSessions());
    const { key } = await devTurnWithStepLeft(e);
    const text = '로그인 실패 문구는 한국어로 바꿔 주세요';
    await e.main('instruct_member', { member_id: e.devId, text: text, urgent: true });
    // 즉시 저장 + 프로듀서에게 공유 (CMD-06 — 보낸 쪽이 메인 에이전트라 메인에게는 공유하지 않는다)
    const msgs = e.ctx.store.messages.list({ ref1: e.devId });
    expect(msgs.map((m) => [m.kind, m.sessionKey, m.urgent, m.fromActor])).toEqual([['urgent', key, true, MAIN_AGENT_ID]]);
    expect([...msgs[0]!.sharedWith].sort()).toEqual([e.producerId]);
    expect(e.ctx.store.queue.list({ ref2: key, state: 'queued' }).map((q) => [q.kind, q.urgent, q.priority])).toEqual([['message', true, 'urgent']]);
    // 턴 도중에는 끼어들지 않는다 (세션당 프로세스 1개)
    await ticks(e, 8);
    expect(turnsOfKey(e, key)).toHaveLength(1);
    expect(liveCount(e, key)).toBe(1);

    e.liveProc(key)!.finishOk('1단계 마침');
    await waitFor(() => !e.core.turns.hasLiveSession(key), '첫 턴 종료');
    e.tick();
    await waitFor(() => turnsOfKey(e, key).length === 2 && liveCount(e, key) === 1, '둘째 턴');
    const [t1, t2] = turnsOfKey(e, key);
    expect(t2!.sessionId).toBe(t1!.sessionId);
    expect(t2!.isResume).toBe(true);
    expect(t2!.startedAt >= t1!.endedAt!).toBe(true);
    const [l1, l2] = launchesOfKey(e, key);
    expect(l2!.resume).toBe(l1!.newSessionId);
    // 맨 앞에 긴급 지시 우선 표시로, 그 뒤에 '계속' 안내
    expect(l2!.message).toMatch(OWNER_FIRST);
    expect(l2!.message).toContain(text);
    expect(l2!.message).toMatch(/### 2\. 작업\n> 계속 진행하세요/);
    const wc = await toolOk(e, t2!.id, 'get_work_context');
    const delivered = wc.messages as { from: string; text: string }[];
    expect(delivered[0]!.from).toBe('긴급 지시');
    expect(delivered[0]!.text).toContain(text);
    expect(e.monitor.violations).toEqual([]);
  });

  it('AC-36: CLI가 끝나도 관련 하위 프로세스가 남아 있으면 그 작업 세션에 전달하지 않는다 — 남은 프로세스를 정리하고 재개한 뒤 같은 세션에 전달', async () => {
    const e = (env = await bootSessions());
    const { key, taskId } = await devTurnWithStepLeft(e);
    await e.main('instruct_member', { member_id: e.devId, text: '빌드 경고도 정리해 주세요', urgent: true });
    const p1 = e.liveProc(key)!;
    p1.emit({ kind: 'result', text: '끝', data: {} });
    p1.exit(0, { remaining: 2 }); // 개발 서버 등 2개가 남음
    await waitFor(() => !e.core.turns.hasLiveSession(key), '첫 턴 종료');
    expect(turnsOfKey(e, key)[0]!.process.state).toBe('kill_failed');
    await ticks(e, 8);
    expect(turnsOfKey(e, key)).toHaveLength(1);
    expect(e.ctx.store.tasks.require(taskId).state).toBe('on_hold');
    // 메시지는 잃지 않고 대기 중
    expect(e.ctx.store.queue.list({ ref2: key, state: 'queued' }).filter((q) => q.urgent)).toHaveLength(1);

    await e.main('resume_task', { task_id: taskId }); // 남은 프로세스를 정리한 뒤 메인 에이전트가 재개
    e.tick();
    await waitFor(() => turnsOfKey(e, key).length === 2, '재개 턴');
    const turns = turnsOfKey(e, key);
    expect(turns[1]!.sessionId).toBe(turns[0]!.sessionId);
    expect(launchesOfKey(e, key)[1]!.message).toMatch(OWNER_FIRST);
    expect(launchesOfKey(e, key)[1]!.message).toContain('빌드 경고도 정리해 주세요');
  });

  it('AC-36: 긴급 정지로 보류된 작업에 온 긴급 지시는 저장만 되고 자동 실행하지 않는다 — 정지 중에는 앱 도구가 거부하고, 정지 해제만으로도 실행하지 않으며, 항목별 재개 때 같은 세션에 맨 앞으로 전달', async () => {
    const e = (env = await bootSessions());
    const { key, taskId } = await devTurnWithStepLeft(e);
    await e.invoke('stop.emergency');
    await waitFor(() => !e.core.turns.hasLiveSession(key), '긴급 정지로 턴 종료');
    // 긴급 정지 중에는 메인 에이전트의 앱 도구도 거부된다 (AC-19) — 지시는 정지가 풀린 뒤에 보낸다
    await expect(e.main('instruct_member', { member_id: e.devId, text: '긴급 정지 중 남기는 메시지', urgent: true })).rejects.toMatchObject({ code: 'stopped' });
    await ticks(e, 8);
    expect(turnsOfKey(e, key)).toHaveLength(1);
    await e.invoke('stop.release');
    await ticks(e, 8);
    expect(turnsOfKey(e, key)).toHaveLength(1);
    expect(e.ctx.store.tasks.require(taskId).hold.reasons.map((r) => r.kind)).toEqual(['emergency_stop']);
    // 해제 뒤 긴급 정지 보류가 남은 작업에 온 긴급 지시 — 저장만
    await e.main('instruct_member', { member_id: e.devId, text: '긴급 정지 중 남기는 메시지', urgent: true });
    expect(e.ctx.store.messages.list({ ref1: e.devId }).map((m) => [m.kind, m.sessionKey])).toEqual([['urgent', key]]);
    expect(e.ctx.store.queue.list({ ref2: key, state: 'queued' }).map((q) => q.kind)).toEqual(['message']);
    // 저장된 지시는 팀원 상세(본인·공유받은 프로듀서·보낸 메인 에이전트)에 남는다 — 실행 기록(턴)은 없다
    for (const who of [e.devId, e.producerId, MAIN_AGENT_ID]) {
      const detail = await e.invoke('members.getDetail', who);
      expect(detail.messages.some((m) => m.text.includes('긴급 정지 중 남기는 메시지')), who).toBe(true);
    }
    await ticks(e, 8);
    expect(turnsOfKey(e, key)).toHaveLength(1);
    expect(e.ctx.store.tasks.require(taskId).hold.reasons.map((r) => r.kind)).toEqual(['emergency_stop']);

    await e.main('resume_task', { task_id: taskId });
    e.tick();
    await waitFor(() => turnsOfKey(e, key).length === 2, '재개 턴');
    const turns = turnsOfKey(e, key);
    expect(turns[1]!.sessionId).toBe(turns[0]!.sessionId);
    expect(launchesOfKey(e, key)[1]!.message).toMatch(OWNER_FIRST);
    expect(launchesOfKey(e, key)[1]!.message).toContain('긴급 정지 중 남기는 메시지');
  });

  it('AC-36: 긴급 정지 전에 대기열에 들어간 긴급 지시도 정지 해제만으로는 실행되지 않고, 메인 에이전트가 항목별로 재개할 때 같은 세션 맨 앞으로 전달된다 (10.11 AC-36, 리드 결정 13)', async () => {
    const e = (env = await bootSessions());
    const { key, taskId } = await devTurnWithStepLeft(e);
    // 턴이 도는 중에 보낸 긴급 지시 — 그 턴이 끝난 뒤 전달을 기다린다
    await e.main('instruct_member', { member_id: e.devId, text: '정지 전에 보낸 긴급 지시', urgent: true });
    expect(e.ctx.store.queue.list({ ref2: key, state: 'queued' }).map((q) => [q.kind, q.urgent])).toEqual([['message', true]]);
    await e.invoke('stop.emergency');
    await waitFor(() => !e.core.turns.hasLiveSession(key), '긴급 정지로 턴 종료');
    await e.invoke('stop.release');
    await ticks(e, 8);
    // 해제만으로는 실행하지 않는다 — 지시는 잃지 않고 기다린다
    expect(turnsOfKey(e, key)).toHaveLength(1);
    expect(e.ctx.store.tasks.require(taskId).hold.reasons.map((r) => r.kind)).toEqual(['emergency_stop']);
    expect(e.ctx.store.queue.list({ ref2: key, state: 'queued' }).filter((q) => q.urgent)).toHaveLength(1);

    await e.main('resume_task', { task_id: taskId });
    e.tick();
    await waitFor(() => turnsOfKey(e, key).length === 2, '재개 턴');
    const turns = turnsOfKey(e, key);
    expect(turns[1]!.sessionId).toBe(turns[0]!.sessionId);
    expect(launchesOfKey(e, key)[1]!.message).toMatch(OWNER_FIRST);
    expect(launchesOfKey(e, key)[1]!.message).toContain('정지 전에 보낸 긴급 지시');
  });

  it('AC-36: 일시정지(팀원·프로젝트) 중 긴급 지시는 저장만 되고 자동 실행하지 않는다 — 재개하면 같은 업무 세션에 맨 앞으로 전달', async () => {
    const e = (env = await bootSessions());
    const { key } = await devTurnWithStepLeft(e);
    // 팀원 일시정지
    await e.main('pause_member', { member_id: e.devId, mode: 'immediate' });
    await waitFor(() => !e.core.turns.hasLiveSession(key), '팀원 정지로 턴 종료');
    await e.main('instruct_member', { member_id: e.devId, text: '팀원 정지 중 메시지', urgent: true });
    await ticks(e, 8);
    expect(turnsOfKey(e, key)).toHaveLength(1);
    expect(e.ctx.store.queue.list({ ref2: key, state: 'queued' }).filter((q) => q.urgent)).toHaveLength(1);
    await e.main('resume_member', { member_id: e.devId });
    e.tick();
    await waitFor(() => turnsOfKey(e, key).length === 2 && liveCount(e, key) === 1, '팀원 재개 턴');
    expect(launchesOfKey(e, key)[1]!.message).toMatch(OWNER_FIRST);
    expect(launchesOfKey(e, key)[1]!.message).toContain('팀원 정지 중 메시지');
    // 프로젝트 일시정지
    await e.main('pause_project', { project_id: e.projectId, mode: 'immediate' });
    await waitFor(() => !e.core.turns.hasLiveSession(key), '프로젝트 정지로 턴 종료');
    await e.main('instruct_member', { member_id: e.devId, text: '프로젝트 정지 중 메시지', urgent: true });
    await ticks(e, 8);
    expect(turnsOfKey(e, key)).toHaveLength(2);
    await e.main('resume_project', { project_id: e.projectId });
    e.tick();
    await waitFor(() => turnsOfKey(e, key).length === 3, '프로젝트 재개 턴');
    const turns = turnsOfKey(e, key);
    expect(new Set(turns.map((x) => x.sessionId)).size).toBe(1);
    expect(launchesOfKey(e, key)[2]!.message).toMatch(OWNER_FIRST);
    expect(launchesOfKey(e, key)[2]!.message).toContain('프로젝트 정지 중 메시지');
  });

  it('AC-36: 프로젝트 일시정지 중 프로듀서(지시 관리 세션)에게 보낸 메시지도 저장만 되고, 재개하면 그 지시 세션에 전달된다', async () => {
    const e = (env = await bootSessions());
    const d = seedDirective(e);
    const key = directiveKey(d.id);
    e.hold.add(key);
    await e.main('pause_project', { project_id: e.projectId, mode: 'immediate' });
    await e.main('instruct_member', { member_id: e.producerId, text: '이번 지시는 접근성을 먼저 봐 주세요', urgent: true });
    expect(e.ctx.store.queue.list({ ref2: key, state: 'queued' }).map((q) => [q.kind, q.urgent])).toEqual([['message', true]]);
    await ticks(e, 8);
    expect(turnsOfKey(e, key)).toHaveLength(0);
    await e.main('resume_project', { project_id: e.projectId });
    e.tick();
    await waitFor(() => liveCount(e, key) === 1, '지시 세션 턴');
    expect(launchesOfKey(e, key)[0]!.message).toMatch(/### 1\. 메시지 확인 \(긴급 지시 우선 전달\)\n> 메인 에이전트 긴급 지시[^\n]*접근성을 먼저/);
  });

  it('AC-36: 같은 팀원의 검수(관리 업무)가 먼저 끼어들어도 긴급 지시는 그 업무 세션에만 간다 — 검수 세션에는 섞이지 않고, 메시지 없이 작업 턴이 돌지 않으며, 작업 세션의 다음 턴(같은 CLI 세션) 맨 앞에 전달된다 (5.7 관리 업무 먼저·끼워 처리)', async () => {
    const e = (env = await bootSessions());
    const d = seedDirective(e);
    const own = makeTask(e, { directiveId: d.id, assignee: e.qaId, type: 'test', title: 'QA 자기 작업' });
    const ownKey = taskKey(own.id);
    scriptTurns(e, ownKey, [
      async (p) => {
        await toolOk(e, p.turnId, 'set_steps', { steps: ['범위', '실행'] });
        await toolOk(e, p.turnId, 'complete_step', { step_index: 0, note: '범위' });
      },
      () => undefined,
    ]);
    e.tick();
    await waitFor(() => liveCount(e, ownKey) === 1 && stepsDone(e, own.id) === 1, 'QA 작업 턴');
    const rv = seedInReviewTask(e, e.qaId);
    const rvKey = reviewKey(rv.id);
    e.hold.add(rvKey);
    e.core.tasks.dispatchReview(e.ctx.store.tasks.require(rv.id));
    const text = '지금 작업의 테스트 범위를 결제 화면까지 넓혀 주세요';
    await e.main('instruct_member', { member_id: e.qaId, text: text, urgent: true });
    e.liveProc(ownKey)!.finishOk('1단계 마침');
    await waitFor(() => !e.core.turns.hasLiveSession(ownKey), 'QA 작업 턴 종료');
    // 기존 일반 작업의 턴이 끝난 뒤 타인 작업 검수(관리)를 별도 세션으로 끼워 처리 — 긴급 지시는 그 세션에 섞지 않는다
    e.tick();
    await waitFor(() => liveCount(e, rvKey) === 1, 'QA 검수 턴');
    expect(launchesOfKey(e, rvKey)[0]!.message).not.toContain(text);
    // 긴급 지시는 잃지 않고 그 작업 세션에 우선 전달 표시(urgent)로 기다린다
    expect(e.ctx.store.queue.list({ ref2: ownKey, state: 'queued' }).filter((q) => q.urgent).map((q) => q.message).join('\n')).toContain(text);
    expect(launchesOfKey(e, ownKey)).toHaveLength(1);
    const rvp = e.liveProc(rvKey)!;
    await toolOk(e, rvp.turnId, 'submit_review', { task_id: rv.id, verdict: 'reject', criteria: [{ criterion: '문서가 있다', pass: false, note: '보완' }], reason: '보완 필요' });
    rvp.finishOk();
    await waitFor(() => !e.core.turns.hasLiveSession(rvKey), 'QA 검수 턴 종료');
    e.tick();
    await waitFor(() => liveCount(e, ownKey) === 1, 'QA 작업 세션의 다음 턴');
    const [l1, l2] = launchesOfKey(e, ownKey);
    expect(l2!.resume).toBe(l1!.newSessionId);
    expect(l2!.message).toMatch(OWNER_FIRST);
    expect(l2!.message).toContain(text);
    const qaTurns = e.ctx.store.turns.list({ ref1: e.qaId });
    expect(qaTurns.map((x) => x.sessionKind)).toEqual(['task', 'review', 'task']);
    expect(overlaps(qaTurns)).toEqual([]);
    expect(e.monitor.violations).toEqual([]);
  });

  it('AC-36: "현재 턴 중단 후 전달"을 고르면 프로그램이 지금 턴을 끝내고(종료 확인) 같은 업무 세션 이어하기의 맨 앞에 전달한다 — 비정상 종료로 세지 않고 작업은 진행 상태 그대로', async () => {
    const e = (env = await bootSessions());
    const { key, taskId } = await devTurnWithStepLeft(e);
    const p1 = e.liveProc(key)!;
    const text = '하던 일을 멈추고 오류 문구부터 고쳐 주세요';
    await e.main('instruct_member', { member_id: e.devId, text: text, urgent: 'interrupt' });
    await waitFor(() => p1.done && !e.core.turns.hasLiveSession(key), '현재 턴 종료');
    expect(p1.terminatedByApp).toBe(true);
    const t1 = turnsOfKey(e, key)[0]!;
    expect([t1.endReason, t1.process.state]).toEqual(['user_stop', 'exited']);
    e.tick();
    await waitFor(() => turnsOfKey(e, key).length === 2 && liveCount(e, key) === 1, '전달 턴');
    const [l1, l2] = launchesOfKey(e, key);
    expect(l2!.resume).toBe(l1!.newSessionId);
    expect(l2!.message).toMatch(OWNER_FIRST);
    expect(l2!.message).toContain(text);
    const cur = e.ctx.store.tasks.require(taskId);
    expect([cur.state, cur.crashRetries, cur.hold.reasons.length]).toEqual(['in_progress', 0, 0]);
  });

  it('AC-36: 작업을 제출하는 턴 도중에 보낸 긴급 지시도 그 턴이 끝난 뒤 같은 업무 세션에 전달된다 — 검수로 넘어가 그대로 통과·완료되면서 전달되지 않은 채 정리되면 안 된다', async () => {
    const e = (env = await bootSessions({ autoSchedule: true }));
    const d = seedDirective(e);
    const t = makeTask(e, { directiveId: d.id, assignee: e.devId, title: '사용 안내서', type: 'docs', outputMode: 'artifact' });
    const key = taskKey(t.id);
    const doc = () => join(artifactWorkDir(e.ctx.paths, e.projectId, t.id), 'guide.md');
    const text = '안내서 첫 줄에 고객센터 운영 시간을 꼭 넣어 주세요';
    scriptTurns(e, key, [
      async (p) => {
        await toolOk(e, p.turnId, 'set_steps', { steps: ['안내서 작성'] });
        writeFileSync(doc(), '# 사용 안내\n', 'utf8');
        await toolOk(e, p.turnId, 'complete_step', { step_index: 0, note: '작성' });
        // 살아 있다 — 긴급 지시가 온 뒤 테스트가 제출하고 끝낸다
      },
      async (p) => {
        // 긴급 지시가 전달된 턴: 반영하고 다시 제출
        writeFileSync(doc(), '# 사용 안내\n고객센터 운영 시간: 평일 9-18시\n', 'utf8');
        await toolOk(e, p.turnId, 'submit_for_review', { note: '긴급 지시 반영' });
        p.finishOk('반영했습니다');
      },
    ]);
    scriptTurns(e, reviewKey(t.id), [
      async (p) => {
        await toolOk(e, p.turnId, 'submit_review', { task_id: t.id, verdict: 'pass', criteria: [{ criterion: '동작한다', pass: true, note: '확인' }], reason: '' });
        p.finishOk('통과');
      },
    ]);
    await waitFor(() => liveCount(e, key) === 1 && stepsDone(e, t.id) === 1, '작업 턴 (1단계 완료)', 20_000);
    const p1 = e.liveProc(key)!;
    await e.main('instruct_member', { member_id: e.devId, text: text, urgent: true }); // 작업은 진행 중, 턴도 살아 있다
    await toolOk(e, p1.turnId, 'submit_for_review', { note: '제출' });
    p1.finishOk('제출했습니다');
    await waitFor(() => e.ctx.store.tasks.require(t.id).state === 'done', '작업 완료', 30_000);
    await sleep(300);
    expect(e.scriptErrors).toEqual([]);
    const ownerEntry = e.ctx.store.queue.list({ ref2: key }).find((q) => q.urgent);
    const summary = {
      deliveredToSameSession: launchesOfKey(e, key).some((l) => l.message.includes(text)),
      ownerQueueEntry: ownerEntry?.state ?? null,
      taskTurns: turnsOfKey(e, key).length,
      ownerNotifiedOfDrop: e.ctx.store.notifications.list().some((n) => n.body.includes(text)),
      dropLog: e.ctx.store.activity.search({ taskId: t.id, text: '전달되지 않은 업무' }).map((a) => `${a.level}: ${a.text}`),
    };
    // 실패하면 전체 요약(대기열 항목 상태·알림·정리 기록)이 차이로 보이게 나머지는 받은 값 그대로 비교
    expect(summary).toEqual({ ...summary, deliveredToSameSession: true });
  });

  it('AC-36: 제출 턴 도중 보낸 긴급 지시는 검수에서 반려되면 재작업 첫 턴(같은 CLI 세션) 맨 앞으로 전달된다 — 검수 중에는 작업 폴더에 턴을 띄우지 않는다 (REV-08)', async () => {
    const e = (env = await bootSessions({ autoSchedule: true }));
    const d = seedDirective(e);
    const t = makeTask(e, { directiveId: d.id, assignee: e.devId, title: '사용 안내서', type: 'docs', outputMode: 'artifact' });
    const key = taskKey(t.id);
    const rk = reviewKey(t.id);
    const text = '안내서 첫 줄에 고객센터 운영 시간을 꼭 넣어 주세요';
    scriptTurns(e, key, [
      async (p) => {
        await toolOk(e, p.turnId, 'set_steps', { steps: ['안내서 작성'] });
        writeFileSync(join(artifactWorkDir(e.ctx.paths, e.projectId, t.id), 'guide.md'), '# 사용 안내\n', 'utf8');
        await toolOk(e, p.turnId, 'complete_step', { step_index: 0, note: '작성' });
      },
      () => undefined, // 재작업 턴 — 살아 있게
    ]);
    e.hold.add(rk);
    await waitFor(() => liveCount(e, key) === 1 && stepsDone(e, t.id) === 1, '작업 턴 (1단계 완료)', 20_000);
    const p1 = e.liveProc(key)!;
    await e.main('instruct_member', { member_id: e.devId, text: text, urgent: true });
    await toolOk(e, p1.turnId, 'submit_for_review', { note: '제출' });
    p1.finishOk('제출했습니다');
    await waitFor(() => liveCount(e, rk) === 1, '프로듀서 검수 턴', 20_000);
    expect(e.ctx.store.tasks.require(t.id).state).toBe('in_review');
    expect(turnsOfKey(e, key)).toHaveLength(1); // 검수 중에는 작업 세션 턴 없음
    const rv = e.liveProc(rk)!;
    await toolOk(e, rv.turnId, 'submit_review', { task_id: t.id, verdict: 'reject', criteria: [{ criterion: '동작한다', pass: false, note: '운영 시간 없음' }], reason: '운영 시간을 넣어 주세요' });
    rv.finishOk();
    await waitFor(() => turnsOfKey(e, key).length === 2 && liveCount(e, key) === 1, '재작업 첫 턴', 20_000);
    const [l1, l2] = launchesOfKey(e, key);
    expect(l2!.resume).toBe(l1!.newSessionId);
    expect(l2!.message).toMatch(OWNER_FIRST);
    expect(l2!.message).toContain(text);
  });

  it('AC-36: 프로듀서(관리 세션) 턴이 하위 프로세스를 남긴 채 끝나면(종료 확인 실패) 긴급 지시를 담은 그 지시 세션의 다음 턴을 띄우지 않는다 (CTL-11: 종료를 확인하지 못한 실행에 새 프로세스를 겹쳐 띄우지 않음)', async () => {
    const e = (env = await bootSessions());
    const d = seedDirective(e);
    const key = directiveKey(d.id);
    e.hold.add(key);
    enqueue(e.ctx, { kind: 'message', memberId: e.producerId, sessionKey: key, projectId: e.projectId, directiveId: d.id, message: '진행 상황을 점검하세요' });
    e.tick();
    await waitFor(() => liveCount(e, key) === 1, '프로듀서 턴');
    await e.main('instruct_member', { member_id: e.producerId, text: '배포 전에 접근성 점검을 꼭 넣어 주세요', urgent: true });
    expect(e.ctx.store.queue.list({ ref2: key, state: 'queued' }).map((q) => [q.kind, q.urgent])).toEqual([['message', true]]);
    const p1 = e.liveProc(key)!;
    p1.emit({ kind: 'result', text: '점검했습니다', data: {} });
    p1.exit(0, { remaining: 2 }); // CLI는 끝났지만 정리 뒤에도 하위 프로세스 2개가 남음
    await waitFor(() => !e.core.turns.hasLiveSession(key), '프로듀서 턴 종료');
    expect(turnsOfKey(e, key)[0]!.process.state).toBe('kill_failed');
    await ticks(e, 8);
    const summary = {
      directiveTurns: turnsOfKey(e, key).length,
      producerRunning: e.core.turns.isMemberRunning(e.producerId),
      ownerMessageStillQueued: e.ctx.store.queue.list({ ref2: key, state: 'queued' }).some((q) => q.urgent),
      killFailedNotice: notices(e, '프로세스 종료 확인 실패').length,
    };
    expect(summary).toEqual({ directiveTurns: 1, producerRunning: false, ownerMessageStillQueued: true, killFailedNotice: 1 });
  });

  it.skipIf(process.platform !== 'win32').each(['jobobject', 'taskkill'] as const)(
    'AC-36 (실제 프로세스, %s 러너): 프로듀서 턴과 그 턴이 띄운 하위 프로세스가 모두 끝난 뒤에야 긴급 지시가 같은 지시 세션 이어하기로 전달된다',
    async (runnerMode) => {
      const h = (harness = await createHarness({ team: ['developer'], runnerMode }));
      expect(h.core.ctx.deps.runner.mode).toBe(runnerMode);
      let heldPlan = false;
      const w = (wrap = wrapMockRuns(h, {
        // 첫 지시 관리 턴(계획)만 붙잡는다: 모의 에이전트가 끝나도 release 전까지 CLI 프로세스가 살아 있다
        hold: (l) => {
          if (heldPlan || !l.mock?.workKey.startsWith('directive:')) return false;
          heldPlan = true;
          return true;
        },
        // 지시 관리 턴마다 CLI가 끝나도 남는 손자(개발 서버 흉내)를 띄운다
        grandchild: (l) => !!l.mock?.workKey.startsWith('directive:'),
      }));
      const did = await sendCommand(h, '대시보드 화면을 만들어 줘');
      const dkey = directiveKey(did);
      const recs = () => w.records.filter((r) => r.workKey === dkey);
      await h.waitFor(() => recs().length === 1 && w.exited(recs()[0]!.seq), { label: '계획 턴의 모의 에이전트 종료 (턴은 붙잡힘)' });
      const plan = recs()[0]!;
      const gc = w.grandchildPid(plan.seq)!;
      expect(isAlive(gc)).toBe(true);
      expect(h.core.turns.hasLiveSession(dkey)).toBe(true);

      await h.main('instruct_member', { member_id: h.members.producer, text: '계획에 접근성 점검 작업도 넣어 주세요', urgent: true });
      await sleep(1000);
      expect(recs()).toHaveLength(1); // 실행 중인 턴에 끼어들지 않는다

      w.release(plan.seq); // CLI 종료 → 러너가 남은 손자를 정리해야 턴이 끝난다
      await h.waitFor(() => recs().length >= 2, { label: '긴급 지시 전달 턴', timeoutMs: 30_000 });
      const next = recs()[1]!;
      // 다음 턴을 준비할 때(프로세스를 띄우기 전) 이전 턴의 손자는 이미 없었다
      expect(next.aliveGrandchildrenAtPrepare).not.toContain(gc);
      expect(isAlive(gc)).toBe(false);
      // 같은 업무 세션 이어하기, 긴급 지시 맨 앞
      expect(next.resume).toBe(plan.newSessionId);
      expect(next.message).toMatch(/이번 턴에 전달된 일 \d건\n\n### 1\. 메시지 확인 \(긴급 지시 우선 전달\)\n> 메인 에이전트 긴급 지시[^\n]*접근성 점검/);
      const turns = h.core.ctx.store.turns.list().filter((x) => h.core.ctx.store.sessions.get(x.sessionId)?.workKey === dkey);
      expect(turns[0]!.endReason).toBe('completed');
      expect(turns[0]!.process.state).toBe('exited');
      expect(turns[1]!.sessionId).toBe(turns[0]!.sessionId);
      expect(turns[1]!.isResume).toBe(true);
      expect(turns[1]!.startedAt >= turns[0]!.endedAt!).toBe(true);
    },
    90_000,
  );
});

// ───────────────────────── AC-37 ─────────────────────────

/** 작업 턴에서 프로듀서에게 질문하고(턴은 살아 있음) 질문 ID를 돌려준다 */
async function askProducer(e: SessEnv, key: string, question: string): Promise<{ qid: string; reply: Record<string, unknown>; proc: FakeProc }> {
  const proc = e.liveProc(key)!;
  const reply = await toolOk(e, proc.turnId, 'ask_producer', { question });
  return { qid: String(reply.questionId), reply, proc };
}

/** 프로듀서 지시 세션 턴이 뜨면 그 질문에 답하고 턴을 마친다 */
function producerAnswers(e: SessEnv, directiveId: string, qid: string, answer: string): void {
  scriptTurns(e, directiveKey(directiveId), [
    async (p) => {
      await toolOk(e, p.turnId, 'answer_question', { question_id: qid, answer });
      p.finishOk('답했습니다');
    },
  ]);
}

describe('AC-37 작업 중 질문 → 답변 대기 보류, 자리 반환, 답변 후 재개 조건 (5.3, 5.7 자리 반환, 15.4)', () => {
  it('AC-37: 작업 중 프로듀서에게 질문하면 작업이 답변 대기로 보류되고 실행 자리를 반환한다 — 기다리던 일반 작업이 그 자리로 시작하고, 프로듀서는 관리 자리에서 답하며, 답변은 같은 세션의 다음 턴으로 간다', async () => {
    const e = (env = await bootSessions({ developers: 5 }));
    const d = seedDirective(e);
    const tasks = e.devs.map((m, i) => makeTask(e, { directiveId: d.id, assignee: m, title: `작업 ${i + 1}` }));
    const keys = tasks.map((t) => taskKey(t.id));
    for (const k of keys) e.hold.add(k);
    e.tick();
    await waitFor(() => keys.slice(0, 4).every((k) => liveCount(e, k) === 1), '일반 작업 4개 실행');
    await ticks(e, 3);
    expect(liveCount(e, keys[4]!)).toBe(0); // 일반 상한 4

    const { qid, reply, proc } = await askProducer(e, keys[0]!, '결제 실패 화면은 어떤 문구로 할까요?');
    expect(String(reply.message)).toContain('답변 대기로 보류');
    const held = e.ctx.store.tasks.require(tasks[0]!.id);
    expect(held.state).toBe('on_hold');
    expect(held.hold.reasons.map((r) => [r.kind, r.refId])).toEqual([['answer_wait', qid]]);
    expect(held.hold.returnState).toBe('in_progress');
    const q = e.ctx.store.questions.get(qid)!;
    expect([q.status, q.to, q.taskId, q.sessionKey]).toEqual(['open', 'producer', tasks[0]!.id, keys[0]]);
    expect(e.core.views.memberView(e.ctx.store.members.require(e.devs[0]!)).status).toBe('awaiting_answer');
    expect(e.ctx.store.queue.list({ ref2: directiveKey(d.id), state: 'queued' }).map((x) => [x.kind, x.slotClass, x.questionId])).toEqual([['answer', 'management', qid]]);

    producerAnswers(e, d.id, qid, '"결제를 완료하지 못했습니다"로 해 주세요');
    proc.finishOk('질문하고 턴을 마칩니다'); // 안내대로 턴을 마침
    await waitFor(() => !e.core.turns.hasLiveSession(keys[0]!), '질문한 턴 종료');
    e.tick();
    // 반환된 일반 자리로 다섯째 작업이 시작하고, 프로듀서 답변은 관리 자리에서
    await waitFor(() => liveCount(e, keys[4]!) === 1, '기다리던 작업 시작');
    await waitFor(() => e.ctx.store.questions.get(qid)?.status === 'answered', '프로듀서 답변');
    const fifth = e.monitor.samples.find((s) => s.sessionKey === keys[4]);
    expect(fifth).toMatchObject({ slotClass: 'general', general: 4 });
    const answerTurn = e.monitor.samples.find((s) => s.sessionKey === directiveKey(d.id));
    expect(answerTurn?.slotClass).toBe('management');
    expect(e.monitor.maxTotal).toBeLessThanOrEqual(5);

    // 답변 도착 → 진행으로 복귀, 같은 세션에 답변이 기다린다 (일반 자리가 차 있어 아직 실행 안 함)
    await waitFor(() => !e.core.turns.hasLiveSession(directiveKey(d.id)), '답변 턴 종료');
    expect(e.ctx.store.tasks.require(tasks[0]!.id).state).toBe('in_progress');
    await ticks(e, 4);
    expect(liveCount(e, keys[0]!)).toBe(0);
    // 일반 자리가 하나 비면 그 답변으로 같은 세션을 이어 간다
    e.hold.delete(keys[1]!);
    e.liveProc(keys[1]!)!.finishOk();
    e.hold.add(keys[1]!);
    await waitFor(() => !e.core.turns.hasLiveSession(keys[1]!), '작업 2 턴 종료');
    e.tick();
    await waitFor(() => liveCount(e, keys[0]!) === 1, '질문한 작업 재개');
    const [l1, l2] = launchesOfKey(e, keys[0]!);
    expect(l2!.resume).toBe(l1!.newSessionId);
    expect(l2!.message).toContain(`질문 ${qid}에 대한 답변`);
    expect(l2!.message).toContain('결제를 완료하지 못했습니다');
    expect(e.monitor.violations).toEqual([]);
  });

  it('AC-37: 질문한 뒤 CLI가 턴을 스스로 끝내지 않아도 프로그램이 그 팀원 프로세스를 끝내 실행 자리를 반환한다 (15.4 "해당 작업 보류, 팀원 프로세스 종료")', async () => {
    const e = (env = await bootSessions());
    const d = seedDirective(e);
    const t = makeTask(e, { directiveId: d.id, assignee: e.devId });
    const key = taskKey(t.id);
    e.hold.add(key);
    e.tick();
    await waitFor(() => liveCount(e, key) === 1, '작업 턴');
    const { proc } = await askProducer(e, key, '어느 API를 써야 하나요?');
    expect(e.ctx.store.tasks.require(t.id).state).toBe('on_hold');
    // CLI가 안내("지금 턴을 마치세요")를 따르지 않고 계속 돈다
    await waitFor(() => proc.done && !e.core.turns.hasLiveSession(key), '질문한 팀원의 턴 종료(자리 반환)', 10_000);
    expect(proc.terminatedByApp).toBe(true);
    expect(e.core.turns.running().filter((r) => r.memberId === e.devId)).toEqual([]);
  }, 30_000);

  it('AC-37: 답변이 도착해도 팀원 일시정지가 남아 있으면 자동 재개하지 않는다 — 정지를 풀면 답변과 함께 같은 세션으로 이어 간다', async () => {
    const e = (env = await bootSessions());
    const { key, taskId, directiveId } = await devTurnWithStepLeft(e);
    const { qid, proc } = await askProducer(e, key, '예외는 어떻게 처리할까요?');
    proc.finishOk('질문하고 마칩니다');
    await waitFor(() => !e.core.turns.hasLiveSession(key), '질문한 턴 종료');
    await e.main('pause_member', { member_id: e.devId, mode: 'graceful' });
    expect(e.ctx.store.tasks.require(taskId).hold.reasons.map((r) => r.kind).sort()).toEqual(['answer_wait', 'paused']);
    producerAnswers(e, directiveId, qid, '예외는 모두 로그에 남기세요');
    e.tick();
    await waitFor(() => e.ctx.store.questions.get(qid)?.status === 'answered' && !e.core.turns.hasLiveSession(directiveKey(directiveId)), '답변 도착');
    const held = e.ctx.store.tasks.require(taskId);
    expect(held.state).toBe('on_hold');
    expect(held.hold.reasons.map((r) => r.kind)).toEqual(['paused']);
    await ticks(e, 8);
    expect(turnsOfKey(e, key)).toHaveLength(1);
    expect(e.ctx.store.queue.list({ ref2: key, state: 'queued' }).map((x) => x.message).join('\n')).toContain('예외는 모두 로그에 남기세요');

    await e.main('resume_member', { member_id: e.devId });
    e.tick();
    await waitFor(() => turnsOfKey(e, key).length === 2, '재개 턴');
    const [l1, l2] = launchesOfKey(e, key);
    expect(l2!.resume).toBe(l1!.newSessionId);
    expect(l2!.message).toContain('예외는 모두 로그에 남기세요');
  });

  it('AC-37: 답변이 도착해도 긴급 정지 보류가 남아 있으면 자동 재개하지 않는다 — 전역 해제 뒤 답변이 와도 그대로, 항목별 재개 때 답변과 함께 이어 간다', async () => {
    const e = (env = await bootSessions());
    const { key, taskId, directiveId } = await devTurnWithStepLeft(e);
    const { qid, proc } = await askProducer(e, key, '디자인 시안은 어느 쪽인가요?');
    proc.finishOk('질문하고 마칩니다');
    await waitFor(() => !e.core.turns.hasLiveSession(key), '질문한 턴 종료');
    await e.invoke('stop.emergency');
    expect(e.ctx.store.tasks.require(taskId).hold.reasons.map((r) => r.kind).sort()).toEqual(['answer_wait', 'emergency_stop']);
    producerAnswers(e, directiveId, qid, 'B 시안으로 갑니다');
    await ticks(e, 4);
    expect(e.ctx.store.questions.get(qid)?.status).toBe('open'); // 긴급 정지 중에는 답변 턴도 돌지 않는다
    await e.invoke('stop.release');
    e.tick();
    await waitFor(() => e.ctx.store.questions.get(qid)?.status === 'answered' && !e.core.turns.hasLiveSession(directiveKey(directiveId)), '답변 도착');
    expect(e.ctx.store.tasks.require(taskId).hold.reasons.map((r) => r.kind)).toEqual(['emergency_stop']);
    await ticks(e, 8);
    expect(turnsOfKey(e, key)).toHaveLength(1);

    await e.main('resume_task', { task_id: taskId });
    e.tick();
    await waitFor(() => turnsOfKey(e, key).length === 2, '재개 턴');
    expect(launchesOfKey(e, key)[1]!.message).toContain('B 시안으로 갑니다');
  });

  it('AC-37: 답변이 도착해도 메인 에이전트의 중단(보류)이 남아 있으면 자동 재개하지 않는다 — 메인 에이전트가 재개하면 답변과 함께 이어 간다', async () => {
    const e = (env = await bootSessions());
    const { key, taskId, directiveId } = await devTurnWithStepLeft(e);
    const { qid, proc } = await askProducer(e, key, '캐시 만료 시간은요?');
    proc.finishOk('질문하고 마칩니다');
    await waitFor(() => !e.core.turns.hasLiveSession(key), '질문한 턴 종료');
    await e.main('interrupt_task', { task_id: taskId, then: 'hold' });
    producerAnswers(e, directiveId, qid, '10분으로 하세요');
    e.tick();
    await waitFor(() => e.ctx.store.questions.get(qid)?.status === 'answered' && !e.core.turns.hasLiveSession(directiveKey(directiveId)), '답변 도착');
    expect(e.ctx.store.tasks.require(taskId).hold.reasons.map((r) => r.kind)).toEqual(['interrupted']);
    await ticks(e, 8);
    expect(turnsOfKey(e, key)).toHaveLength(1);
    await e.main('resume_task', { task_id: taskId });
    e.tick();
    await waitFor(() => turnsOfKey(e, key).length === 2, '재개 턴');
    expect(launchesOfKey(e, key)[1]!.message).toContain('10분으로 하세요');
  });

  it('AC-37: 답변 대기 중인 팀원도 배정된 다른 관리 업무(검수)는 실행한다 — 답변 대기는 그 작업만 멈추고 팀원·실행 자리를 붙잡지 않는다 (5.7)', async () => {
    const e = (env = await bootSessions());
    const d = seedDirective(e);
    e.hold.add(directiveKey(d.id)); // 프로듀서 답변 턴은 답하지 않은 채 붙잡아 둔다
    const own = makeTask(e, { directiveId: d.id, assignee: e.qaId, type: 'test', title: 'QA 자기 작업' });
    const ownKey = taskKey(own.id);
    scriptTurns(e, ownKey, [
      async (p) => {
        await toolOk(e, p.turnId, 'set_steps', { steps: ['범위', '실행'] });
        await toolOk(e, p.turnId, 'ask_producer', { question: '결제 시나리오도 테스트 범위인가요?' });
        p.finishOk('질문하고 마칩니다');
      },
    ]);
    e.tick();
    await waitFor(() => e.ctx.store.tasks.require(own.id).state === 'on_hold' && !e.core.turns.hasLiveSession(ownKey), '질문하고 턴 종료');
    const rv = seedInReviewTask(e, e.qaId);
    const rvKey = reviewKey(rv.id);
    e.hold.add(rvKey);
    e.core.tasks.dispatchReview(e.ctx.store.tasks.require(rv.id));
    e.tick();
    await waitFor(() => liveCount(e, rvKey) === 1, 'QA 검수 턴 (답변 대기 중)');
    expect(e.ctx.store.tasks.require(own.id).hold.reasons.map((r) => r.kind)).toEqual(['answer_wait']);
    expect(e.ctx.store.questions.list().find((q) => q.taskId === own.id)?.status).toBe('open');
    expect(liveCount(e, ownKey)).toBe(0);
    expect(e.monitor.violations).toEqual([]);
  });

  it('AC-37: 한 턴에 질문을 두 개 하면 첫 답변이 와도 남은 답변 대기 때문에 재개하지 않고, 두 답변이 모두 와야 두 답을 함께 같은 세션으로 이어 간다', async () => {
    const e = (env = await bootSessions());
    const { key, taskId, directiveId } = await devTurnWithStepLeft(e);
    const proc = e.liveProc(key)!;
    const q1 = String((await toolOk(e, proc.turnId, 'ask_producer', { question: '로그인 실패는 몇 번까지 허용하나요?' })).questionId);
    const q2 = String((await toolOk(e, proc.turnId, 'ask_producer', { question: '잠금 해제는 메일 인증으로 하나요?' })).questionId);
    expect(e.ctx.store.tasks.require(taskId).hold.reasons.map((r) => [r.kind, r.refId])).toEqual([
      ['answer_wait', q1],
      ['answer_wait', q2],
    ]);
    proc.finishOk('질문하고 마칩니다');
    await waitFor(() => !e.core.turns.hasLiveSession(key), '질문한 턴 종료');
    const dkey = directiveKey(directiveId);
    scriptTurns(e, dkey, [
      async (p) => {
        await toolOk(e, p.turnId, 'answer_question', { question_id: q1, answer: '다섯 번까지 허용합니다' });
        p.finishOk('하나 답했습니다');
      },
      async (p) => {
        await toolOk(e, p.turnId, 'answer_question', { question_id: q2, answer: '메일 인증으로 풉니다' });
        p.finishOk('나머지도 답했습니다');
      },
    ]);
    e.tick();
    await waitFor(() => e.ctx.store.questions.get(q1)?.status === 'answered' && !e.core.turns.hasLiveSession(dkey), '첫 답변');
    const held = e.ctx.store.tasks.require(taskId);
    expect(held.state).toBe('on_hold');
    expect(held.hold.reasons.map((r) => [r.kind, r.refId])).toEqual([['answer_wait', q2]]);
    // 프로듀서에게 남은 질문 재촉이 들어가 두 번째 답이 온다. 그 전까지 작업 턴은 없다
    for (let i = 0; i < 8 && e.ctx.store.questions.get(q2)?.status !== 'answered'; i++) {
      expect(turnsOfKey(e, key)).toHaveLength(1);
      e.tick();
      await sleep(40);
    }
    await waitFor(() => e.ctx.store.questions.get(q2)?.status === 'answered' && !e.core.turns.hasLiveSession(dkey), '두 번째 답변');
    expect(e.ctx.store.tasks.require(taskId).state).toBe('in_progress');
    e.tick();
    await waitFor(() => turnsOfKey(e, key).length === 2, '재개 턴');
    const [l1, l2] = launchesOfKey(e, key);
    expect(l2!.resume).toBe(l1!.newSessionId);
    expect(l2!.message).toContain('다섯 번까지 허용합니다');
    expect(l2!.message).toContain('메일 인증으로 풉니다');
  });

  it('AC-37 (실제 프로세스): 모의 개발자가 첫 턴에 질문하고 끝내면 그 일반 자리로 다른 개발자 작업이 먼저 돌고, 답변 뒤 같은 세션으로 이어 끝까지 간다 (상한 2: 일반 1 + 관리 1)', async () => {
    const h = (harness = await createHarness({ team: ['developer', 'developer'], scenarios: { developer: 'answer_wait' }, maxConcurrent: 2 }));
    const mon = monitorLaunches(h.core, 2);
    const did = await sendCommand(h, '알림 설정 화면을 만들어 줘');
    await h.waitFor(() => h.core.ctx.store.directives.get(did)?.state === 'awaiting_confirmation', { timeoutMs: 90_000, label: '보고 도착' });
    mon.restore();
    const store = h.core.ctx.store;
    const asker = store.tasks.list({ ref1: did }).find((t) => t.assigneeId === h.members.developer)!;
    const other = store.tasks.list({ ref1: did }).find((t) => t.assigneeId === h.members.developer2)!;
    const q = store.questions.list().find((x) => x.fromId === h.members.developer)!;
    expect([q.to, q.status, q.answeredBy, q.taskId]).toEqual(['producer', 'answered', h.members.producer, asker.id]);
    const tr = store.transitions.list(asker.id);
    expect(tr.some((x) => x.event === 'hold' && x.reason.includes('answer_wait'))).toBe(true);
    expect(tr.some((x) => x.event === 'release' && x.reason.includes('답변 도착'))).toBe(true);
    const askerTurns = turnsOfKeyH(h, taskKey(asker.id));
    const otherTurns = turnsOfKeyH(h, taskKey(other.id));
    // 질문한 턴이 끝나 자리를 돌려준 뒤 다른 개발자 작업이 시작했고, 그 다음에 질문한 작업이 같은 세션으로 이어졌다
    expect(askerTurns.length).toBeGreaterThanOrEqual(2);
    expect(askerTurns[0]!.stepsCompleted).toBe(0);
    expect(otherTurns[0]!.startedAt >= askerTurns[0]!.endedAt!).toBe(true);
    expect(otherTurns[0]!.startedAt < askerTurns[1]!.startedAt).toBe(true);
    expect(askerTurns[1]!.sessionId).toBe(askerTurns[0]!.sessionId);
    expect(askerTurns[1]!.isResume).toBe(true);
    const resumed = store.queue.list({ ref2: taskKey(asker.id) }).filter((x) => x.turnId === askerTurns[1]!.id);
    expect(resumed.map((x) => x.message).join('\n')).toContain(`질문 ${q.id}에 대한 답변`);
    expect(store.tasks.require(asker.id).state).toBe('done');
    expect(mon.violations).toEqual([]);
  }, 120_000);
});

function turnsOfKeyH(h: Harness, key: string) {
  return h.core.ctx.store.turns.list().filter((t) => h.core.ctx.store.sessions.get(t.sessionId)?.workKey === key);
}

// ───────────────────────── AC-40 ─────────────────────────

const roleLine = (name: string, id: string) => `이름: ${name} (개발자) · 팀원 ID ${id}`;

describe('AC-40 작업 변경·복구로 세션이 바뀌어도 팀원은 그대로, 이전 작업 메시지는 넘기지 않음 (MEM-10, ERR-03, CLI-19)', () => {
  it('AC-40: 작업이 바뀌면 새 세션을 만들지만 팀원 ID·역할·이력은 그대로이고, 이전 작업 세션에 남은 메인·프로듀서 메시지는 새 작업에 전달하지 않는다', async () => {
    const e = (env = await bootSessions());
    const d = seedDirective(e);
    const t1 = makeTask(e, { directiveId: d.id, assignee: e.devId, title: '첫 작업 문서', type: 'docs', outputMode: 'artifact' });
    const t2 = makeTask(e, { directiveId: d.id, assignee: e.devId, title: '둘째 작업' });
    const k1 = taskKey(t1.id);
    const k2 = taskKey(t2.id);
    const rk = reviewKey(t1.id);
    e.hold.add(k2);
    e.hold.add(rk);
    scriptTurns(e, k1, [
      async (p) => {
        await toolOk(e, p.turnId, 'set_steps', { steps: ['문서 작성'] });
        writeFileSync(join(artifactWorkDir(e.ctx.paths, e.projectId, t1.id), 'guide.md'), '# 안내서\n', 'utf8');
        await toolOk(e, p.turnId, 'complete_step', { step_index: 0, note: '작성' });
        await toolOk(e, p.turnId, 'submit_for_review', { note: '제출' });
        p.finishOk('제출했습니다');
      },
    ]);
    const pass = { task_id: t1.id, verdict: 'pass', criteria: [{ criterion: '동작한다', pass: true, note: '확인' }], reason: '' };
    e.tick();
    await waitFor(() => e.ctx.store.tasks.require(t1.id).state === 'in_review', '첫 작업 검수 대기');
    // 첫 작업이 검수 중일 때 그 작업 세션으로 긴급 지시가 온다 (검수 중이라 바로 전달되지 않음, REV-08)
    await e.main('instruct_member', { member_id: e.devId, text: '첫 작업 표지에 날짜를 넣어 주세요', urgent: true });
    e.tick();
    await waitFor(() => liveCount(e, rk) === 1, '프로듀서 검수 턴');
    const rv = e.liveProc(rk)!;
    await toolOk(e, rv.turnId, 'submit_review', pass);
    rv.finishOk();
    // 통과해도 긴급 지시가 남아 있으면 완료하지 않고 진행으로 돌려(반려 아님) 첫 작업 세션의 다음 턴 맨 앞에 전달한다 (AC-36, REV-08).
    // 그 턴은 (같은 대본으로) 다시 제출한다 — 긴급 지시는 첫 작업 세션에서 끝난다
    e.tick();
    await waitFor(() => turnsOfKey(e, k1).length === 2 && e.ctx.store.tasks.require(t1.id).state === 'in_review', '긴급 지시 전달 뒤 다시 제출');
    expect(launchesOfKey(e, k1)[1]!.message).toMatch(OWNER_FIRST);
    expect(launchesOfKey(e, k1)[1]!.message).toContain('날짜를 넣어');
    // 다시 검수하는 동안 프로듀서 메시지가 그 작업 세션으로 온다 — 그대로 통과·완료되면 이것이 이전 작업 세션에 남는다
    e.tick();
    await waitFor(() => liveCount(e, rk) === 1, '프로듀서 재검수 턴');
    const rv2 = e.liveProc(rk)!;
    await toolOk(e, rv2.turnId, 'send_message', { to: e.devId, text: '첫 작업 목차를 줄여 주세요' });
    expect(e.ctx.store.queue.list({ ref2: k1, state: 'queued' }).map((q) => q.kind)).toEqual(['message']);
    await toolOk(e, rv2.turnId, 'submit_review', pass);
    rv2.finishOk();
    await waitFor(() => e.ctx.store.tasks.require(t1.id).state === 'done', '첫 작업 완료');
    // 남은 항목은 (작업 공간 정리 뒤) 정리되고 기록된다 — 새 작업으로 옮기지 않는다
    await waitFor(() => e.ctx.store.queue.list({ ref2: k1, state: 'queued' }).length === 0, '이전 작업 세션 항목 정리');
    expect(e.ctx.store.queue.list({ ref2: k1 }).filter((q) => q.kind === 'message').map((q) => [q.urgent, q.state])).toEqual([
      [true, 'done'],
      [false, 'cancelled'],
    ]);
    expect(e.ctx.store.activity.search({ taskId: t1.id, text: '전달되지 않은 업무' })).toHaveLength(1);

    e.tick();
    await waitFor(() => liveCount(e, k2) === 1, '둘째 작업 첫 턴');
    const [first] = turnsOfKey(e, k1);
    const [second] = turnsOfKey(e, k2);
    expect(second!.sessionId).not.toBe(first!.sessionId);
    expect(second!.isResume).toBe(false);
    expect(second!.memberId).toBe(e.devId);
    const l1 = launchesOfKey(e, k1)[0]!;
    const l2 = launchesOfKey(e, k2)[0]!;
    expect(l2.resume).toBeNull();
    expect(l2.newSessionId).not.toBe(l1.newSessionId);
    expect(l2.message).not.toContain('날짜를 넣어');
    expect(l2.message).not.toContain('목차를 줄여');
    expect(l2.message).not.toContain('이전 세션에서 넘겨받은 내용');
    expect(l2.message).toContain(t2.id);
    const wc = await toolOk(e, second!.id, 'get_work_context');
    expect((wc.task as { id: string }).id).toBe(t2.id);
    expect(JSON.stringify(wc.messages)).not.toMatch(/날짜를 넣어|목차를 줄여/);
    // 팀원 ID·역할은 그대로 (같은 역할 지침), 이전 세션·턴·작업 이력도 남는다
    const dev = e.ctx.store.members.require(e.devId);
    expect(dev.roleId).toBe('developer');
    expect(e.prompts.get(first!.id)).toContain(roleLine(dev.name, dev.id));
    expect(e.prompts.get(second!.id)).toContain(roleLine(dev.name, dev.id));
    const detail = await e.invoke('members.getDetail', e.devId);
    expect(detail.sessions.map((s) => s.workKey).sort()).toEqual([k1, k2].sort());
    expect(detail.history.map((x) => x.taskId)).toContain(t1.id);
    expect(detail.recentTurns.map((x) => x.id)).toContain(first!.id);
  });

  it('AC-40: 복구로 세션을 교체해도(이어하기 실패 → 새 세션) 팀원 ID·역할·작업 상태는 그대로이고, 새 세션이 목표·완료/남은 단계·마지막 커밋·검수 이력을 넘겨받는다', async () => {
    const e = (env = await bootSessions({ autoSchedule: true }));
    const d = seedDirective(e);
    const t = makeTask(e, { directiveId: d.id, assignee: e.devId, title: '결제 화면' });
    const key = taskKey(t.id);
    const rk = reviewKey(t.id);
    e.hold.add(rk);
    scriptTurns(e, key, [
      async (p) => {
        const wt = e.ctx.store.tasks.require(t.id).workspace!.worktreePath;
        await toolOk(e, p.turnId, 'set_steps', { steps: ['화면 구현', '오류 처리'] });
        writeFileSync(join(wt, 'pay.txt'), '결제 화면\n', 'utf8');
        await toolOk(e, p.turnId, 'complete_step', { step_index: 0, note: '화면' });
        writeFileSync(join(wt, 'pay-error.txt'), '오류 처리\n', 'utf8');
        await toolOk(e, p.turnId, 'complete_step', { step_index: 1, note: '오류' });
        await toolOk(e, p.turnId, 'submit_for_review', { note: '제출' });
        p.finishOk('제출');
      },
      (p) => {
        // 이어하기 대상 세션이 CLI에 없다 (실제 Claude "No conversation found")
        p.emit({ kind: 'error', text: 'No conversation found with session ID: gone', data: { errorKind: 'other', resumeFailed: true } });
        p.exit(1);
      },
      () => undefined, // 새 세션 첫 턴 — 살아 있게
    ]);
    await waitFor(() => liveCount(e, rk) === 1, '프로듀서 검수 턴', 20_000);
    const rv = e.liveProc(rk)!;
    await toolOk(e, rv.turnId, 'submit_review', { task_id: t.id, verdict: 'reject', criteria: [{ criterion: '동작한다', pass: false, note: '금액 반올림 오류' }], reason: '금액 반올림을 고쳐 주세요' });
    rv.finishOk();
    await waitFor(() => turnsOfKey(e, key).length === 3 && liveCount(e, key) === 1, '새 세션 첫 턴', 20_000);
    expect(e.scriptErrors).toEqual([]);
    const sessions = e.ctx.store.sessions.list({ ref2: key });
    expect(sessions).toHaveLength(2);
    const [s1, s2] = sessions;
    expect([s1!.memberId, s2!.memberId]).toEqual([e.devId, e.devId]);
    expect(s1!.closedAt).not.toBeNull();
    expect(s1!.replaceReason).toContain('이어하기 실패');
    expect(s2!.closedAt).toBeNull();
    const turns = turnsOfKey(e, key);
    expect(turns.map((x) => x.sessionId)).toEqual([s1!.id, s1!.id, s2!.id]);
    expect(turns[2]!.isResume).toBe(false);
    const launches = launchesOfKey(e, key);
    expect(launches[1]!.resume).toBe(launches[0]!.newSessionId);
    expect(launches[2]!.resume).toBeNull();
    expect(launches[2]!.newSessionId).not.toBe(launches[0]!.newSessionId);
    // 인계 요약 (ERR-03): 목표·완료/남은 단계·마지막 커밋·검수 이력
    const lastCommit = e.ctx.store.steps.list(t.id)[1]!.commitSha!;
    const hand = s2!.handoverSummary ?? '';
    expect(hand).toContain(`작업 ${t.id} "결제 화면"`);
    expect(hand).toContain('목표: 결제 화면의 목표');
    expect(hand).toContain('완료 단계: 화면 구현 / 오류 처리');
    expect(hand).toContain('남은 단계: 없음');
    expect(hand).toContain(`마지막 커밋: ${lastCommit.slice(0, 10)}`);
    expect(hand).toMatch(/검수 이력: 1차 반려\(금액 반올림을 고쳐 주세요/);
    expect(launches[2]!.message).toContain('## 이전 세션에서 넘겨받은 내용');
    expect(launches[2]!.message).toContain('금액 반올림을 고쳐 주세요');
    // 세션 교체는 팀원·작업 상태를 바꾸지 않는다
    const cur = e.ctx.store.tasks.require(t.id);
    expect([cur.state, cur.assigneeId, cur.crashRetries, cur.review.rejectsTotal]).toEqual(['in_progress', e.devId, 0, 1]);
    const dev = e.ctx.store.members.require(e.devId);
    expect(dev.roleId).toBe('developer');
    expect(e.prompts.get(turns[2]!.id)).toContain(roleLine(dev.name, dev.id));
    // 이전 세션과 그 턴 기록은 남는다
    const detail = await e.invoke('members.getDetail', e.devId);
    expect(detail.sessions.map((s) => s.id)).toEqual(expect.arrayContaining([s1!.id, s2!.id]));
    expect(e.ctx.store.turns.list({ ref2: s1!.id })).toHaveLength(2);
  });

  it('AC-40: 세션 교체 인계에는 지난 보류 이력(답변 대기·받은 답변)도 들어간다 (ERR-03 "목표·완료/남은 단계·마지막 커밋·검수·보류 이력")', async () => {
    const e = (env = await bootSessions({ autoSchedule: true }));
    const d = seedDirective(e);
    e.hold.add(directiveKey(d.id)); // 프로듀서 답변 턴은 살아 있게 (답변은 테스트가 넣는다)
    const t = makeTask(e, { directiveId: d.id, assignee: e.devId, title: '배송 조회' });
    const key = taskKey(t.id);
    let qid = '';
    scriptTurns(e, key, [
      async (p) => {
        await toolOk(e, p.turnId, 'set_steps', { steps: ['조회 화면', '택배사 연동', '오류 처리'] });
        await toolOk(e, p.turnId, 'complete_step', { step_index: 0, note: '조회 화면' });
        qid = String((await toolOk(e, p.turnId, 'ask_producer', { question: '택배사 API는 어느 것을 쓰나요?' })).questionId);
        p.finishOk('질문하고 마칩니다');
      },
      async (p) => {
        // 답변을 받은 턴 (이전 세션) — 단계 하나 더 하고 끝
        await toolOk(e, p.turnId, 'complete_step', { step_index: 1, note: '택배사 연동' });
        p.finishOk();
      },
      (p) => {
        p.emit({ kind: 'error', text: 'No conversation found with session ID: gone', data: { errorKind: 'other', resumeFailed: true } });
        p.exit(1);
      },
      () => undefined,
    ]);
    await waitFor(() => qid !== '' && !e.core.turns.hasLiveSession(key), '질문한 턴 종료', 20_000);
    e.core.tasks.answer(qid, '우체국 택배 API를 쓰세요', e.producerId);
    await waitFor(() => turnsOfKey(e, key).length === 4, '새 세션 첫 턴', 20_000);
    expect(e.scriptErrors).toEqual([]);
    const launches = launchesOfKey(e, key);
    expect(launches[1]!.message).toContain('우체국 택배 API'); // 답변은 이전 세션에 전달됐다
    const s2 = e.ctx.store.sessions.list({ ref2: key, state: 'open' })[0]!;
    expect(launches[3]!.resume).toBeNull(); // 새 세션
    // 새 세션은 그 답변을 모른다 — 인계 요약에 지난 보류(답변 대기)와 받은 답변이 있어야 한다
    expect(s2.handoverSummary).toMatch(/보류 이력:[^\n]*(답변 대기|answer_wait)/);
    expect(launches[3]!.message).toContain('우체국 택배 API');
  });

  it('AC-40: 복구로 세션을 교체하면 새 세션이 이전 세션과 교체 사유를 기록해 세션 교체 이력이 이어진다 (MEM-11 "세션 ID, 이전 세션, 교체 사유, 인계 요약을 보관")', async () => {
    const e = (env = await bootSessions({ autoSchedule: true }));
    const d = seedDirective(e);
    const t = makeTask(e, { directiveId: d.id, assignee: e.devId, title: '알림 설정' });
    const key = taskKey(t.id);
    scriptTurns(e, key, [
      async (p) => {
        await toolOk(e, p.turnId, 'set_steps', { steps: ['화면', '저장', '점검'] });
        await toolOk(e, p.turnId, 'complete_step', { step_index: 0, note: '화면' });
        p.finishOk('1단계까지');
      },
      (p) => {
        p.emit({ kind: 'error', text: 'No conversation found with session ID: gone', data: { errorKind: 'other', resumeFailed: true } });
        p.exit(1);
      },
      () => undefined, // 새 세션 첫 턴 — 살아 있게
    ]);
    await waitFor(() => turnsOfKey(e, key).length === 3 && liveCount(e, key) === 1, '새 세션 첫 턴', 20_000);
    expect(e.scriptErrors).toEqual([]);
    const [s1, s2] = e.ctx.store.sessions.list({ ref2: key });
    // 이미 지켜지는 부분: 같은 팀원, 이전 세션은 교체 사유와 함께 닫히고, 새 세션은 인계 요약을 받는다
    expect([s1!.memberId, s2!.memberId]).toEqual([e.devId, e.devId]);
    expect(s1!.closedAt).not.toBeNull();
    expect(s1!.replaceReason).toContain('이어하기 실패');
    expect(s2!.handoverSummary).toContain(`이전 세션 ${s1!.id}`);
    // 새 세션 기록에도 이전 세션·교체 사유가 남아야 한다 (같은 앱의 다른 교체 경로 — 실행 위치·AI 설정 변경 — 는 둘 다 남긴다)
    const detail = await e.invoke('members.getDetail', e.devId);
    const v2 = detail.sessions.find((s) => s.id === s2!.id)!;
    expect({ previousSessionId: s2!.previousSessionId, replaceReason: s2!.replaceReason, viewPrevious: v2.previousSessionId }).toEqual({
      previousSessionId: s1!.id,
      replaceReason: expect.stringContaining('이어하기 실패'),
      viewPrevious: s1!.id,
    });
  });

  it('AC-40 (실제 프로세스): 모의 CLI의 이어하기가 실패하면(CLI 세션 기록 없음) 새 세션으로 교체해 인계하고, 팀원 ID·역할을 유지한 채 작업을 끝낸다', async () => {
    const h = (harness = await createHarness({ team: ['developer'], scenarios: { producer: 'triple_reject' } }));
    const devId = h.members.developer!;
    let forgot = '';
    const w = (wrap = wrapMockRuns(h, {
      before: (l) => {
        if (forgot || !l.mock?.workKey.startsWith('task:') || l.mock.memberId !== devId || !l.resumeCliSessionId) return;
        if (forgetMockSession(l.mock.stateDir, l.resumeCliSessionId) > 0) forgot = l.resumeCliSessionId;
      },
    }));
    const did = await sendCommand(h, '주문 내역 화면을 만들어 줘');
    await h.waitFor(() => h.core.ctx.store.directives.get(did)?.state === 'awaiting_confirmation', { timeoutMs: 90_000, label: '보고 도착' });
    const store = h.core.ctx.store;
    const task = store.tasks.list({ ref1: did }).find((t) => t.assigneeId === devId)!;
    const key = taskKey(task.id);
    expect(forgot).not.toBe('');
    const sessions = store.sessions.list({ ref2: key });
    expect(sessions.length).toBeGreaterThanOrEqual(2);
    const old = sessions.find((s) => s.cliSessionId === forgot)!;
    const fresh = sessions[sessions.indexOf(old) + 1]!;
    expect(old.replaceReason).toContain('이어하기 실패');
    expect(fresh.cliSessionId).not.toBe(forgot);
    expect(sessions.every((s) => s.memberId === devId)).toBe(true);
    // 실패한 턴은 이전 CLI 세션을 이어하려 했고, 다음 턴은 새 CLI 세션으로 시작했다
    const recs = w.records.filter((r) => r.workKey === key);
    const failedAt = recs.findIndex((r) => r.resume === forgot);
    expect(failedAt).toBeGreaterThan(0);
    expect(recs[failedAt + 1]!.resume).toBeNull();
    expect(recs[failedAt + 1]!.message).toContain('이전 세션에서 넘겨받은 내용');
    expect(recs[failedAt + 1]!.systemPrompt).toBe(recs[0]!.systemPrompt); // 같은 팀원·역할 지침
    // 인계에 지난 단계·커밋·검수 이력
    expect(fresh.handoverSummary).toContain('완료 단계: 요구사항과 기존 코드 확인 / 기능 구현 / 자체 점검과 정리');
    expect(fresh.handoverSummary).toMatch(/마지막 커밋: [0-9a-f]{10}/);
    expect(fresh.handoverSummary).toMatch(/검수 이력: 1차 반려/);
    const final = store.tasks.require(task.id);
    expect([final.state, final.assigneeId]).toEqual(['done', devId]);
    expect(store.members.require(devId).roleId).toBe('developer');
  }, 120_000);

  it('AC-40 (실제 프로세스): 수정 회차로 같은 팀원이 새 작업을 맡으면 새 세션(새 CLI 세션)으로 시작하고, 팀원 ID·역할과 이전 작업 세션·턴 기록은 그대로 남는다', async () => {
    const h = (harness = await createHarness({ team: ['developer'] }));
    const devId = h.members.developer!;
    const w = (wrap = wrapMockRuns(h));
    const did = await sendCommand(h, '설정 화면을 만들어 줘');
    await h.waitFor(() => h.core.ctx.store.directives.get(did)?.state === 'awaiting_confirmation', { timeoutMs: 90_000, label: '1회차 보고' });
    const store = h.core.ctx.store;
    const report1 = store.reports.list({ ref1: did })[0]!;
    await h.invoke('reports.requestChanges', report1.id, { overall: '다크 모드도 지원해 주세요', anchored: [] });
    await h.waitFor(() => {
      const d = store.directives.get(did)!;
      return d.round === 2 && d.state === 'awaiting_confirmation';
    }, { timeoutMs: 90_000, label: '2회차 보고' });
    const devTasks = store.tasks.list({ ref1: did }).filter((t) => t.assigneeId === devId);
    expect(devTasks.map((t) => [t.round, t.state])).toEqual([
      [1, 'done'],
      [2, 'done'],
    ]);
    const [k1, k2] = devTasks.map((t) => taskKey(t.id));
    const s1 = store.sessions.list({ ref2: k1 });
    const s2 = store.sessions.list({ ref2: k2 });
    expect(s1).toHaveLength(1);
    expect(s2).toHaveLength(1);
    expect(s2[0]!.id).not.toBe(s1[0]!.id);
    expect(s2[0]!.cliSessionId).not.toBe(s1[0]!.cliSessionId);
    expect(s2[0]!.handoverSummary).toBeNull(); // 다른 업무의 문맥을 넘기지 않는다
    expect([s1[0]!.memberId, s2[0]!.memberId]).toEqual([devId, devId]);
    const firstOfNew = w.records.find((r) => r.workKey === k2)!;
    expect(firstOfNew.resume).toBeNull();
    expect(firstOfNew.message).not.toContain(devTasks[0]!.id);
    // 같은 팀원·역할 지침 (작업 디렉터리 줄만 작업마다 다르다)
    const dev = store.members.require(devId);
    for (const r of w.records.filter((x) => x.workKey === k1 || x.workKey === k2)) expect(r.systemPrompt).toContain(roleLine(dev.name, devId));
    expect(store.turns.list({ ref2: s1[0]!.id }).length).toBeGreaterThanOrEqual(1);
    const detail = await h.invoke('members.getDetail', devId);
    expect(detail.history.map((x) => x.taskId).sort()).toEqual(devTasks.map((t) => t.id).sort());
    expect(detail.sessions.map((s) => s.workKey)).toEqual(expect.arrayContaining([k1, k2]));
    expect(store.members.require(devId).roleId).toBe('developer');
  }, 150_000);
});

// ───────────────────────── AC-41 ─────────────────────────

describe('AC-41 기본 상한 5와 관리 예약 1자리 (5.7 전체 상한·관리용 자리, ORG-07)', () => {
  it('AC-41: 기본 상한 5에서 일반 작업 4개가 실행 중이어도 메인·프로듀서·검수 관리 업무가 5번째 자리에서 하나씩 실행되고, 전체는 5를 넘지 않으며, 일반 작업은 비어 있는 예약 자리를 쓰지 않는다', async () => {
    const e = (env = await bootSessions({ developers: 6 }));
    expect(e.ctx.settings().execution.maxConcurrent).toBe(5);
    const d = seedDirective(e);
    const tasks = e.devs.slice(0, 5).map((m, i) => makeTask(e, { directiveId: d.id, assignee: m, title: `일반 ${i + 1}` }));
    const keys = tasks.map((t) => taskKey(t.id));
    for (const k of keys) e.hold.add(k);
    e.tick();
    await waitFor(() => keys.slice(0, 4).every((k) => liveCount(e, k) === 1), '일반 작업 4개');
    // 관리 업무가 없어도 다섯째 일반 작업은 예약 자리를 쓰지 않는다
    await ticks(e, 6);
    expect(slots(e)).toMatchObject({ total: 4, general: 4, management: 0 });
    expect(e.ctx.store.tasks.require(tasks[4]!.id).state).toBe('waiting');

    // ① 메인 에이전트 명령 처리 (관리)
    const mk = mainKey(e.projectId);
    e.hold.add(mk);
    await e.invoke('command.send', { target: e.projectId, text: '진행 상황을 정리해 줘' });
    e.tick();
    await waitFor(() => liveCount(e, mk) === 1, '메인 에이전트 턴');
    expect(slots(e)).toMatchObject({ total: 5, general: 4, management: 1 });
    // 다른 관리 업무(새 지시 계획)는 전체 5를 넘기지 않게 기다린다
    const d2 = e.core.directives.register({ projectId: e.projectId, title: '새 지시', text: '알림 화면' }, MAIN_AGENT_ID, null);
    const d2key = directiveKey(d2.id);
    scriptTurns(e, d2key, [
      async (p) => {
        await toolOk(e, p.turnId, 'create_task', { directive_id: d2.id, title: '알림 화면', goal: '알림', type: 'development', assignee_id: e.devs[5], acceptance_criteria: ['동작'], output_mode: 'repo' });
        // 살아 있다 — 테스트가 끝낸다
      },
    ]);
    await ticks(e, 6);
    expect(liveCount(e, d2key)).toBe(0);
    expect(slots(e).total).toBe(5);

    // ② 메인 턴이 끝나면 프로듀서 계획(관리)이 5번째 자리로
    e.liveProc(mk)!.finishOk('정리했습니다');
    await waitFor(() => !e.core.turns.hasLiveSession(mk), '메인 턴 종료');
    e.tick();
    await waitFor(() => liveCount(e, d2key) === 1 && e.ctx.store.tasks.list({ ref1: d2.id }).length === 1, '프로듀서 계획 턴');
    expect(slots(e)).toMatchObject({ total: 5, general: 4, management: 1 });
    // 검수 업무(관리)는 자리가 날 때까지 기다린다
    const rv = seedInReviewTask(e, e.qaId);
    const rk = reviewKey(rv.id);
    e.hold.add(rk);
    e.core.tasks.dispatchReview(e.ctx.store.tasks.require(rv.id));
    await ticks(e, 6);
    expect(liveCount(e, rk)).toBe(0);

    // ③ 계획 턴이 끝나면 검수(관리)가 5번째 자리로 — 새로 생긴 일반 작업·다섯째 일반 작업은 그대로 기다린다
    e.liveProc(d2key)!.finishOk('계획했습니다');
    await waitFor(() => !e.core.turns.hasLiveSession(d2key), '계획 턴 종료');
    e.tick();
    await waitFor(() => liveCount(e, rk) === 1, '검수 턴');
    expect(slots(e)).toMatchObject({ total: 5, general: 4, management: 1 });
    const newTask = e.ctx.store.tasks.list({ ref1: d2.id })[0]!;
    expect([e.ctx.store.tasks.require(tasks[4]!.id).state, newTask.state]).toEqual(['waiting', 'waiting']);

    // ④ 관리 업무가 끝나 예약 자리가 비어도 일반 작업은 그 자리를 쓰지 않는다
    const rvp = e.liveProc(rk)!;
    await toolOk(e, rvp.turnId, 'submit_review', { task_id: rv.id, verdict: 'reject', criteria: [{ criterion: '문서가 있다', pass: false, note: '보완' }], reason: '보완' });
    rvp.finishOk();
    await waitFor(() => !e.core.turns.hasLiveSession(rk), '검수 턴 종료');
    await ticks(e, 6);
    expect(slots(e)).toMatchObject({ total: 4, general: 4, management: 0 });

    // ⑤ 일반 작업 하나가 끝나야 기다리던 일반 작업이 시작한다 (일반 4 유지)
    e.hold.delete(keys[0]!);
    e.liveProc(keys[0]!)!.finishOk();
    e.hold.add(keys[0]!);
    await waitFor(() => !e.core.turns.hasLiveSession(keys[0]!), '일반 1 턴 종료');
    e.tick();
    await waitFor(() => liveCount(e, keys[4]!) === 1, '다섯째 일반 작업 시작');
    expect(slots(e).general).toBe(4);

    // 관리 업무 셋 모두 일반 4개가 도는 중에 시작했고, 어떤 순간에도 전체 5·일반 4를 넘지 않았다
    for (const k of [mk, d2key, rk]) expect(e.monitor.samples.find((s) => s.sessionKey === k), k).toMatchObject({ slotClass: 'management', general: 4, total: 5 });
    expect(e.monitor.maxTotal).toBe(5);
    expect(e.monitor.maxGeneral).toBe(4);
    expect(e.monitor.violations).toEqual([]);
  });

  it('AC-41: 메인 에이전트 긴급 지시가 든 일반 작업(우선 전달)도 관리 예약 자리를 쓰지 않는다 — 일반 4개가 도는 동안 기다리고, 그 사이 관리 업무가 5번째 자리를 쓴다', async () => {
    const e = (env = await bootSessions({ developers: 5 }));
    const d = seedDirective(e);
    const [dev1, dev2, dev3, dev4, dev5] = e.devs as [string, string, string, string, string];
    const first = [dev1, dev2, dev3].map((m, i) => makeTask(e, { directiveId: d.id, assignee: m, title: `일반 ${i + 1}` }));
    for (const t of first) e.hold.add(taskKey(t.id));
    e.tick();
    await waitFor(() => first.every((t) => liveCount(e, taskKey(t.id)) === 1), '일반 3개');
    // dev5의 작업: 첫 턴에 1단계를 마치고 살아 있다
    const t5 = makeTask(e, { directiveId: d.id, assignee: dev5, title: '일반 5' });
    const k5 = taskKey(t5.id);
    scriptTurns(e, k5, [
      async (p) => {
        await toolOk(e, p.turnId, 'set_steps', { steps: ['하나', '둘'] });
        await toolOk(e, p.turnId, 'complete_step', { step_index: 0, note: '하나' });
      },
      () => undefined,
    ]);
    e.tick();
    await waitFor(() => liveCount(e, k5) === 1 && stepsDone(e, t5.id) === 1, '일반 5 첫 턴');
    // 우선순위 높은 dev4 작업이 기다리다가, dev5 턴이 끝나 빈 일반 자리를 먼저 받는다
    const t4 = makeTask(e, { directiveId: d.id, assignee: dev4, title: '일반 4', priority: 'high' });
    e.hold.add(taskKey(t4.id));
    e.liveProc(k5)!.finishOk('1단계 마침');
    await waitFor(() => !e.core.turns.hasLiveSession(k5), '일반 5 턴 종료');
    e.tick();
    await waitFor(() => liveCount(e, taskKey(t4.id)) === 1, '일반 4 시작');
    expect(slots(e)).toMatchObject({ total: 4, general: 4, management: 0 });
    // dev5는 진행 중 작업이 쉬는 상태 — 메인 에이전트 긴급 지시(우선 전달)가 와도 일반 상한 4라 예약 자리를 쓰지 않는다
    await e.main('instruct_member', { member_id: dev5, text: '오류 화면 문구를 먼저 정리해 주세요', urgent: true });
    expect(e.ctx.store.queue.list({ ref2: k5, state: 'queued' }).some((q) => q.urgent && q.slotClass === 'general')).toBe(true);
    await ticks(e, 6);
    expect(liveCount(e, k5)).toBe(0);
    expect(slots(e)).toMatchObject({ total: 4, general: 4, management: 0 });
    // 관리 업무는 그 5번째 자리에서 실행된다
    const mk = mainKey(e.projectId);
    e.hold.add(mk);
    await e.invoke('command.send', { target: e.projectId, text: '오늘 진행 상황을 정리해 줘' });
    e.tick();
    await waitFor(() => liveCount(e, mk) === 1, '메인 에이전트 턴');
    expect(slots(e)).toMatchObject({ total: 5, general: 4, management: 1 });
    expect(liveCount(e, k5)).toBe(0);
    // 일반 작업 하나가 끝나면 그 일반 자리로 긴급 지시가 든 dev5 작업이 이어 간다 (같은 세션, 메시지 맨 앞)
    const k1 = taskKey(first[0]!.id);
    e.hold.delete(k1);
    e.liveProc(k1)!.finishOk();
    e.hold.add(k1);
    await waitFor(() => !e.core.turns.hasLiveSession(k1), '일반 1 턴 종료');
    e.tick();
    await waitFor(() => liveCount(e, k5) === 1, '일반 5 재개');
    expect(launchesOfKey(e, k5)[1]!.message).toMatch(OWNER_FIRST);
    expect(e.monitor.maxTotal).toBe(5);
    expect(e.monitor.maxGeneral).toBe(4);
    expect(e.monitor.violations).toEqual([]);
  });

  it('AC-41 (실제 프로세스): 모의 개발자 4명의 턴이 실행 중일 때 메인 에이전트 명령과 프로듀서 검수가 5번째 자리에서 실행되고, 지시가 끝날 때까지 전체 5·일반 4를 넘지 않는다', async () => {
    const h = (harness = await createHarness({ team: ['developer', 'developer', 'developer', 'developer', 'developer', 'developer'] }));
    const devIds = new Set(Object.entries(h.members).filter(([k]) => k.startsWith('developer')).map(([, v]) => v));
    expect(devIds.size).toBe(6);
    const mon = monitorLaunches(h.core, 5);
    let holding = true;
    const w = (wrap = wrapMockRuns(h, { hold: (l) => holding && !!l.mock && l.mock.workKey.startsWith('task:') && devIds.has(l.mock.memberId) }));
    const did = await sendCommand(h, '상품 목록 화면을 만들어 줘');
    const held = () => w.records.filter((r) => r.hold);
    await h.waitFor(() => held().length === 4 && held().every((r) => w.exited(r.seq)), { label: '개발자 작업 4개가 실행 중 (붙잡힘)', timeoutMs: 60_000 });
    await sleep(300);
    const running = () => h.core.turns.running();
    expect(running().filter((r) => r.slotClass === 'general')).toHaveLength(4);
    expect(h.core.ctx.store.tasks.list({ ref1: did, state: 'waiting' })).toHaveLength(2);

    // ① 메인 에이전트 직접 명령(관리)이 5번째 자리에서 실행되고 끝난다
    await h.invoke('command.send', { target: 'main', text: '오늘 할 일을 정리해 줘' });
    await h.waitFor(() => h.core.ctx.store.turns.list().some((t) => t.sessionKind === 'main_general' && t.endedAt), { label: '메인 에이전트 직접 명령 턴' });
    expect(mon.samples.find((s) => s.sessionKey === 'main:general')).toMatchObject({ slotClass: 'management', general: 4, total: 5 });

    // ② 개발자 하나를 놓아 주면 → 기다리던 일반 작업이 그 자리로, 프로듀서 검수(관리)는 5번째 자리로
    //    (제출 처리가 끝나 검수가 등록되는 tick에서 검수(관리 먼저)와 다섯째 작업 활성화가 함께 뜬다)
    w.release(held()[0]!.seq);
    await h.waitFor(() => mon.samples.some((s) => s.sessionKey.startsWith('review:')), { label: '프로듀서 검수 턴', timeoutMs: 30_000 });
    await h.waitFor(() => held().length >= 5, { label: '다섯째 개발자 작업 시작' });
    expect(mon.samples.find((s) => s.sessionKey.startsWith('review:'))?.slotClass).toBe('management');
    expect(mon.samples.some((s) => s.total === 5 && s.general === 4 && s.keys.some((k) => k.startsWith('review:')))).toBe(true);

    holding = false;
    w.releaseAll();
    await h.waitFor(() => h.core.ctx.store.directives.get(did)?.state === 'awaiting_confirmation', { timeoutMs: 120_000, label: '보고 도착' });
    mon.restore();
    expect(h.core.ctx.store.tasks.list({ ref1: did }).every((t) => t.state === 'done')).toBe(true);
    expect(mon.violations).toEqual([]);
    expect(mon.maxTotal).toBe(5);
    expect(mon.maxGeneral).toBe(4);
  }, 150_000);
});
