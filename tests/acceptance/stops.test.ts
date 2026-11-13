/**
 * 완료 기준 'stops' 묶음 (기획서 17장): AC-13 · AC-14 · AC-15 · AC-16 · AC-29 · AC-44 · AC-46.
 * 판정 기준은 기획서 문장이다 — 8장(오류·멈춤 대응), 9장(중단과 개입, CTL-01..11), 5.3 상태표, ERR-04·06·08, TSK-09.
 *
 * 하네스
 * - e2e (tests/e2e/harness.ts): 실제 저장소·git·프로세스 러너(작업 개체)·앱 도구 서버 + 실제 모의 에이전트 프로세스.
 *   AC-15·29는 모의 에이전트 앞에 CLI 대역을 두어 개발 서버(직접 자식·손자·고아)를 실제로 띄운다 (stops-helpers.createProcRig).
 * - 가짜 CLI 오케스트레이터: orchHarness.bootOrch, 그리고 같은 데이터 폴더로 다시 띄우는 stops-helpers.bootRestartable
 *   (crash = PC 전원 차단: 턴 정리 없이 저장소만 닫음 / stopGracefully = 앱 종료 후 재시작).
 * - 서비스 (regression/helpers.boot): 실제 git으로 병합·되돌리기를 직접 몬다.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { QueueEntry, Turn } from '@shared/domain';
import { MAIN_AGENT_ID, OWNER } from '@shared/domain';
import { isTerminal } from '@core/taskMachine';
import { createHarness, sendCommand, type Harness } from '../e2e/harness';
import { bootOrch, seedDirective as seedOrchDirective, startReview, waitFor } from '../regression/orchHarness';
import { assertFakeMain } from '../regression/guiRig';
import * as reg from '../regression/helpers';
import { createFakeDesktop, killFakePids, pidAlive } from '../fixtures/desktop/fakeDesktop';
import { describeEmergency } from '../../src/main/shell/emergency';
import { enqueue, directiveKey, reviewKey, taskKey } from '../../src/main/orchestrator/records';
import {
  bootRestartable,
  createProcRig,
  holdOf,
  killMarked,
  markedProcesses,
  portHeldBy,
  portOpen,
  seedDirective,
  seedInReviewTask,
  sleep,
  stillRunning,
  waitUntil,
  wrapTurnsWithRig,
} from './stops-helpers';

/**
 * 러너 방식 (리드 결정 S10-5.5): jobobject를 고른 시험은 Windows 밖에서 플랫폼 러너(pgroup)로 돈다(하네스가 바꾼다) — 이름도 그 러너로.
 * taskkill 대체 방식 자체를 보는 시험은 Windows 밖에서 건너뛰고 그 까닭을 이름에 단다. Windows의 시험 이름은 그대로다
 */
const isWin = process.platform === 'win32';
const JOB_RUNNER = isWin ? '작업 개체 러너' : '프로세스 그룹 러너(Windows 밖)';
const WINDOWS_ONLY_TASKKILL = isWin ? '' : ' [Windows 전용: taskkill 대체 방식 자체를 본다 — 이 플랫폼에는 그 방식이 없어 건너뜀]';

// ───────────────────────── 정리 ─────────────────────────

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  // 나중에 만든 것부터 (하네스 → 프로세스 묶음 순서로 닫혀 작업 개체가 먼저 정리한다)
  for (const c of cleanups.splice(0).reverse()) {
    try {
      await c();
    } catch {
      // 정리 실패는 다음 테스트에 영향이 없다
    }
  }
});

/** 닫을 대상을 등록한다. 재시작으로 인스턴스가 바뀌면 box.v를 바꾼다 */
function track<T extends { close(): Promise<unknown> }>(v: T): { v: T } {
  const box = { v };
  cleanups.push(() => box.v.close());
  return box;
}

function rigFor() {
  const rig = createProcRig();
  cleanups.push(() => rig.cleanup());
  return rig;
}

// ───────────────────────── 조회 도우미 ─────────────────────────

type AnyCtx = Harness['core']['ctx'];
const taskTurns = (ctx: AnyCtx, taskId: string): Turn[] => ctx.store.turns.list().filter((t) => t.sessionKind === 'task' && t.taskId === taskId);
const sessionTurns = (ctx: AnyCtx, key: string): Turn[] => ctx.store.turns.list().filter((t) => ctx.store.sessions.get(t.sessionId)?.workKey === key);
const notices = (ctx: AnyCtx, title: string) => ctx.store.notifications.list().filter((n) => n.title === title);
const queuedIn = (ctx: AnyCtx, pred: (q: QueueEntry) => boolean) => ctx.store.queue.list({ state: 'queued' }).filter(pred);
const liveTaskTurns = (h: Harness) => h.core.turns.running().filter((r) => r.sessionKey.startsWith('task:'));
/** 'hang' 시나리오의 CLI가 실제로 시작해 세션을 만들고 첫 줄을 낸 뒤 (그 전에 끊으면 이어할 CLI 세션이 없다) */
const cliSpoke = (h: Harness, memberId: string) => !!h.core.turns.lastLineOf(memberId)?.text.includes('업무를 시작합니다');
const git = (cwd: string, args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

/** 작업 폴더 여러 개를 차례로 만드는(활성화 여러 개) 조건의 상한 — 넷을 차례로 만들면 부하에서 기본 15초에 가까워진다 */
const GIT_HEAVY_WAIT_MS = 60_000;

function devTaskInput(directiveId: string, assigneeId: string, title: string, prerequisiteIds: string[] = []) {
  return { directiveId, title, goal: title, type: 'development' as const, assigneeId, acceptanceCriteria: ['동작한다'], outputMode: 'repo' as const, prerequisiteIds };
}

// ═════════════════════════ AC-13 ═════════════════════════

describe('AC-13 비정상 종료 자동 복구 — 결과 확인 후 같은 작업 재개, 2회 복구 실패 시 오류·긴급 알림, 사용자 정지는 재시작 안 함', () => {
  it('AC-13: 자동 복구가 허용된 작업의 CLI가 비정상 종료하면 결과를 확인한 뒤 같은 세션 이어하기로 같은 작업을 재개해 끝까지 진행한다 (실제 모의 에이전트 crash)', async () => {
    const { v: h } = track(await createHarness({ team: ['developer'], scenarios: { developer: 'crash' } }));
    const did = await sendCommand(h, '로그인 화면을 만들어 줘');
    await h.waitFor(() => h.core.ctx.store.directives.get(did)?.state === 'awaiting_confirmation', { timeoutMs: 150_000, label: '지시 보고' });
    const task = h.tasks().find((t) => t.directiveId === did && t.assigneeId === h.members.developer)!;
    expect(task.state).toBe('done');
    const turns = taskTurns(h.core.ctx, task.id);
    // 첫 턴: 단계 1개를 마친 뒤 결과 이벤트 없이 종료 코드 1
    expect(turns[0]).toMatchObject({ endReason: 'crashed', stepsCompleted: 1 });
    expect(turns.length).toBeGreaterThanOrEqual(2);
    // 같은 작업을 같은 세션 이어하기로 재개
    expect(turns[1]).toMatchObject({ isResume: true, sessionId: turns[0]!.sessionId });
    expect(turns.slice(1).every((t) => t.endReason === 'completed')).toBe(true);
    // 재개 업무에는 상태(마지막 커밋 등)를 확인하고 이어 가라는 안내가 붙는다 (자동 재개 1/2)
    const resumed = h.core.ctx.store.queue.list({ ref2: taskKey(task.id) }).filter((q) => q.message.includes('비정상 종료로 끝났습니다 (자동 재개 1/2)'));
    expect(resumed).toHaveLength(1);
    expect(resumed[0]!.message).toContain('get_work_context');
    expect(resumed[0]!.turnId).toBe(turns[1]!.id);
    // 끊기기 전에 끝낸 단계는 다시 하지 않는다: 첫 단계 커밋이 main 이력에 한 번만
    const steps = h.core.ctx.store.steps.list(task.id);
    expect(steps.every((s) => s.done)).toBe(true);
    const subjects = git(h.projectDir, ['log', '--format=%s', 'main']).split(/\r?\n/);
    expect(subjects.filter((s) => s === `[${task.id}] ${steps[0]!.title}`)).toHaveLength(1);
    expect(notices(h.core.ctx, '자동 복구 실패')).toEqual([]);
  }, 200_000);

  it('AC-13: 자동 복구가 2회 실패하면(비정상 종료 3번) 더 재시작하지 않고 작업을 오류로 보류하며 긴급 알림을 띄우고 팀원을 오류로 표시한다 (실제 모의 에이전트 crash_loop)', async () => {
    const { v: h } = track(await createHarness({ team: ['developer'], scenarios: { developer: 'crash_loop' } }));
    const did = await sendCommand(h, '로그인 화면을 만들어 줘');
    const devTask = () => h.tasks().find((t) => t.directiveId === did && t.assigneeId === h.members.developer);
    await h.waitFor(() => devTask()?.state === 'on_hold', { timeoutMs: 120_000, label: '오류 보류' });
    const task = devTask()!;
    expect(task.hold.reasons.map((r) => r.kind)).toEqual(['error']);
    expect(task.hold.reasons[0]!.note).toContain('자동 복구 2회 실패');
    const turns = taskTurns(h.core.ctx, task.id);
    expect(turns.map((t) => t.endReason)).toEqual(['crashed', 'crashed', 'crashed']);
    expect(turns.slice(1).every((t) => t.isResume && t.sessionId === turns[0]!.sessionId)).toBe(true);
    const urgent = notices(h.core.ctx, '자동 복구 실패');
    expect(urgent).toHaveLength(1);
    expect(urgent[0]).toMatchObject({ level: 'urgent', key: `crash:${task.id}` });
    expect(h.snapshot().members.find((m) => m.id === h.members.developer)?.status).toBe('error');
    // 스케줄러가 더 돌아도(2초 주기 두 번 이상) 다시 띄우지 않는다
    await sleep(4500);
    expect(taskTurns(h.core.ctx, task.id)).toHaveLength(3);
    expect(h.core.turns.isMemberRunning(h.members.developer!)).toBe(false);
  }, 200_000);

  it('AC-13: 사용자 정지(팀원 즉시 일시정지·작업 중단)로 끝난 CLI 프로세스는 비정상 종료로 세지 않고 자동으로 다시 띄우지 않는다 (실제 프로세스)', async () => {
    const { v: h } = track(await createHarness({ team: ['developer', 'developer'], scenarios: { developer: 'hang' } }));
    await h.internal('members.update', h.members.developer2!, { mockScenario: 'hang' });
    const did = await sendCommand(h, '로그인 화면과 회원가입 화면을 만들어 줘');
    const [d1, d2] = [h.members.developer!, h.members.developer2!];
    const taskOf = (m: string) => h.tasks().find((t) => t.directiveId === did && t.assigneeId === m);
    await h.waitFor(() => [d1, d2].every((m) => taskOf(m)?.state === 'in_progress' && h.core.turns.isMemberRunning(m) && cliSpoke(h, m)), { timeoutMs: 90_000, label: '두 작업 턴' });
    const t1 = taskOf(d1)!;
    const t2 = taskOf(d2)!;
    const pids = [t1, t2].map((t) => taskTurns(h.core.ctx, t.id)[0]!.process.pid!);
    const stopAt = Date.now();
    await h.main('pause_member', { member_id: d1, mode: 'immediate' });
    await h.main('interrupt_task', { task_id: t2.id, then: 'hold' });
    await h.waitFor(() => !h.core.turns.isMemberRunning(d1) && !h.core.turns.isMemberRunning(d2), { label: '두 턴 종료' });
    expect(stillRunning(pids, stopAt)).toEqual([]);
    await sleep(4500);
    for (const t of [t1, t2]) {
      const turns = taskTurns(h.core.ctx, t.id);
      expect(turns.map((x) => x.endReason)).toEqual(['user_stop']);
      expect(h.task(t.id).crashRetries).toBe(0);
      expect(h.task(t.id).state).toBe('on_hold');
    }
    expect(holdOf(h.task(t1.id)).reasons).toEqual(['paused/member']);
    expect(holdOf(h.task(t2.id)).reasons).toEqual(['interrupted/task']);
    expect(notices(h.core.ctx, '자동 복구 실패')).toEqual([]);
  }, 150_000);

  it('AC-13: 비정상 종료 뒤 재개는 같은 CLI 세션 이어하기이며 자동 재개 1/2·2/2 안내를 붙이고, 세 번째 비정상 종료에서 멈춰 오류 보류·긴급 알림 (가짜 CLI)', async () => {
    const { v: e } = track(await bootOrch());
    const d = seedOrchDirective(e);
    const t = e.core.tasks.create(devTaskInput(d.id, e.devId, '구현'), e.producerId);
    e.script.set(taskKey(t.id), (p) => p.exit(1)); // 결과 이벤트 없이 종료 코드 1 (앱이 요청하지 않은 종료)
    await e.drain(6);
    const ls = e.launches.filter((l) => l.workKey === taskKey(t.id));
    expect(ls).toHaveLength(3);
    expect(ls[0]!.resume).toBeNull();
    expect(ls[1]!.resume).toBe(ls[0]!.newSessionId);
    expect(ls[2]!.resume).toBe(ls[0]!.newSessionId);
    expect(ls[1]!.message).toContain('비정상 종료로 끝났습니다 (자동 재개 1/2)');
    expect(ls[2]!.message).toContain('비정상 종료로 끝났습니다 (자동 재개 2/2)');
    expect(holdOf(e.ctx.store.tasks.require(t.id))).toEqual({ state: 'on_hold', reasons: ['error/task'], returnState: 'in_progress' });
    expect(notices(e.ctx, '자동 복구 실패').map((n) => n.level)).toEqual(['urgent']);
  });

  it('AC-13: 결과 확인 — 검수 요청을 마친 뒤 끊긴 작업은 다시 돌리지 않고 제출 처리로 이어 가고, 끊기기 전에 보류(답변 대기)된 작업은 재개하지 않는다 (가짜 CLI)', async () => {
    const { v: e } = track(await bootOrch());
    const d = seedOrchDirective(e);
    const a = e.core.tasks.create(devTaskInput(d.id, e.devId, '제출 후 끊김'), e.producerId);
    const b = e.core.tasks.create({ ...devTaskInput(d.id, e.qaId, '질문 후 끊김'), type: 'test' }, e.producerId);
    e.hold.add(taskKey(a.id));
    e.hold.add(taskKey(b.id));
    e.tick();
    await waitFor(() => !!e.liveProc(taskKey(a.id)) && !!e.liveProc(taskKey(b.id)), '두 작업 턴');
    const pa = e.liveProc(taskKey(a.id))!;
    expect((await e.tool(pa.turnId, 'set_steps', { steps: ['구현'] })).ok).toBe(true);
    writeFileSync(join(e.ctx.store.tasks.require(a.id).workspace!.worktreePath, 'feature.txt'), '기능\n', 'utf8');
    expect((await e.tool(pa.turnId, 'complete_step', { step_index: 0, note: '완료' })).ok).toBe(true);
    expect((await e.tool(pa.turnId, 'submit_for_review', { note: '제출' })).ok).toBe(true);
    pa.exit(1);
    const pb = e.liveProc(taskKey(b.id))!;
    expect((await e.tool(pb.turnId, 'ask_producer', { question: '어느 화면부터 확인할까요?' })).ok).toBe(true);
    pb.exit(1);
    await e.idle();
    await waitFor(() => e.ctx.store.tasks.require(a.id).state === 'in_review', '제출 처리로 검수');
    e.hold.clear();
    await e.drain(2);
    expect(taskTurns(e.ctx, a.id).map((x) => x.endReason)).toEqual(['crashed']);
    expect(taskTurns(e.ctx, b.id).map((x) => x.endReason)).toEqual(['crashed']);
    expect(e.launches.filter((l) => l.workKey === taskKey(a.id))).toHaveLength(1);
    expect(e.launches.filter((l) => l.workKey === taskKey(b.id))).toHaveLength(1);
    expect(holdOf(e.ctx.store.tasks.require(b.id))).toEqual({ state: 'on_hold', reasons: ['answer_wait/task'], returnState: 'in_progress' });
    expect(e.ctx.store.tasks.require(b.id).crashRetries).toBe(0);
    expect(queuedIn(e.ctx, (q) => q.sessionKey === taskKey(b.id))).toEqual([]);
  });

  it('AC-13: 관리 업무(프로듀서 지시 세션) CLI의 비정상 종료도 같은 세션 이어하기로 최대 2회 다시 실행하고, 세 번째 비정상 종료에서 멈춰 긴급 알림을 띄운다 (가짜 CLI)', async () => {
    const { v: e } = track(await bootOrch());
    const d = seedOrchDirective(e);
    const key = directiveKey(d.id);
    e.script.set(key, (p) => p.exit(1)); // 결과 이벤트 없이 종료 코드 1 (앱이 요청하지 않은 종료)
    enqueue(e.ctx, { kind: 'message', memberId: e.producerId, sessionKey: key, projectId: e.projectId, directiveId: d.id, message: '진행 상황을 정리해 주세요' });
    await e.drain(6);
    const ls = e.launches.filter((l) => l.workKey === key);
    expect(ls).toHaveLength(3);
    expect(ls[0]!.resume).toBeNull();
    expect(ls.slice(1).map((l) => l.resume)).toEqual([ls[0]!.newSessionId, ls[0]!.newSessionId]);
    expect(ls.slice(1).every((l) => l.message.includes('비정상 종료로 끝났습니다'))).toBe(true);
    expect(sessionTurns(e.ctx, key).map((t) => t.endReason)).toEqual(['crashed', 'crashed', 'crashed']);
    const urgent = notices(e.ctx, '자동 복구 실패');
    expect(urgent.map((n) => n.level)).toEqual(['urgent']);
    expect(urgent[0]!.body).toContain('비정상 종료가 반복됩니다');
    // 더 다시 띄우지 않는다
    await e.drain(2);
    expect(e.launches.filter((l) => l.workKey === key)).toHaveLength(3);
    expect(queuedIn(e.ctx, (q) => q.sessionKey === key)).toEqual([]);
  });
});

// ═════════════════════════ AC-14 ═════════════════════════

describe('AC-14 재시작 시 정지·보류를 먼저 복원하고 재개 가능한 작업만 결과 확인 후 이어감', () => {
  it('AC-14: PC가 꺼졌다 켜지면 범위별 정지(프로젝트·팀원)와 보류를 먼저 복원하고, 재개 가능한 작업만 실행 결과를 확인한 뒤 이어 간다 — 질문·재계획·정지 작업은 그대로', async () => {
    const box = track(await bootRestartable());
    let e = box.v;
    const dev2 = (await e.internal('members.add', { projectId: e.projectId, roleId: 'developer' })).id;
    const docs = (await e.internal('members.add', { projectId: e.projectId, roleId: 'docs' })).id;
    // 두 번째 프로젝트 (프로젝트 범위 정지)
    const p2 = await e.internal('projects.create', { mode: 'new', path: join(e.projectDir, '..', 'proj2'), name: '두 번째 프로젝트', checkCommands: [] });
    await e.internal('projects.setMock', p2.id, { enabled: true, speed: 25, defaultScenario: 'normal' });
    const p2dev = (await e.internal('members.add', { projectId: p2.id, roleId: 'developer' })).id;
    const d = seedDirective(e);
    const d2 = seedDirective({ ctx: e.ctx, projectId: p2.id }, '두 번째 프로젝트 지시');
    const tRun = e.core.tasks.create(devTaskInput(d.id, e.devId, '진행 중 — 재개 대상'), e.producerId);
    const tAsk = e.core.tasks.create({ ...devTaskInput(d.id, e.qaId, '질문 대기'), type: 'test' }, e.producerId);
    const tReplan = e.core.tasks.create(devTaskInput(d.id, dev2, '재계획 대기'), e.producerId);
    const tPaused = e.core.tasks.create({ ...devTaskInput(d.id, docs, '정지된 팀원의 작업'), type: 'docs' }, e.producerId);
    const tP2 = e.core.tasks.create(devTaskInput(d2.id, p2dev, '정지된 프로젝트의 작업'), p2.producerId);
    await e.main('pause_project', { project_id: p2.id, mode: 'graceful' });
    for (const t of [tRun, tAsk, tReplan, tPaused]) e.hold.add(taskKey(t.id));
    e.tick();
    // 한 번의 tick이 작업 4개를 활성화한다. 같은 저장소의 작업 폴더 만들기는 차례로 돌므로(gitService inWorktreeQueue — 동시에 만들면 git이
    // 반쯤 만든 관리 폴더를 읽다 실패해 한 작업이 '작업 공간 생성 실패'로 보류됐다) 넷을 다 만드는 시간을 기다린다 (조건을 기다리는 상한만 늘림)
    await waitUntil(() => [tRun, tAsk, tReplan, tPaused].every((t) => !!e.liveProc(taskKey(t.id))), '작업 턴 4개', GIT_HEAVY_WAIT_MS);
    // 질문 → 답변 대기
    const pAsk = e.liveProc(taskKey(tAsk.id))!;
    expect((await e.tool(pAsk.turnId, 'ask_producer', { question: '어느 API를 쓰나요?' })).ok).toBe(true);
    pAsk.finishOk();
    // 재계획 보류 (헛돌기 판정과 같은 보류)
    e.liveProc(taskKey(tReplan.id))!.finishOk();
    await waitUntil(() => !e.core.turns.hasLiveSession(taskKey(tReplan.id)) && !e.core.turns.hasLiveSession(taskKey(tAsk.id)), '두 턴 종료');
    e.core.tasks.hold(tReplan.id, 'replan', 'task', '헛돌기: 진척 없는 자동 재개 3회', 'system', null, 'in_progress');
    // 팀원 즉시 일시정지 + 그 팀원에게 온 메인 에이전트 긴급 지시 (재시작 뒤에도 실행하면 안 된다)
    await e.main('pause_member', { member_id: docs, mode: 'immediate' });
    await e.main('instruct_member', { member_id: docs, text: '재시작 뒤에 이어서 해 주세요', urgent: true });
    // 진행 중 작업: 단계 커밋은 git에 반영됐는데 결과를 기록하기 전에 전원이 꺼진다
    const pRun = e.liveProc(taskKey(tRun.id))!;
    expect((await e.tool(pRun.turnId, 'set_steps', { steps: ['화면', '테스트'] })).ok).toBe(true);
    writeFileSync(join(e.ctx.store.tasks.require(tRun.id).workspace!.worktreePath, 'screen.txt'), '화면\n', 'utf8');
    const g = e.ctx.deps.git;
    const commitAll = g.commitAll.bind(g);
    let committed = false;
    g.commitAll = async (...a: Parameters<typeof commitAll>) => {
      await commitAll(...a);
      committed = true;
      return new Promise<string>(() => undefined);
    };
    void e.tool(pRun.turnId, 'complete_step', { step_index: 0, note: '화면 완료' });
    await waitUntil(() => committed, '단계 커밋');
    const firstSession = e.launchesOf(taskKey(tRun.id))[0]!.newSessionId;
    const others = [tAsk, tReplan, tPaused, tP2];
    const heldBefore = Object.fromEntries(others.map((t) => [t.id, holdOf(e.ctx.store.tasks.require(t.id))]));
    expect(heldBefore[tAsk.id]!.reasons).toEqual(['answer_wait/task']);
    expect(heldBefore[tReplan.id]!.reasons).toEqual(['replan/task']);
    expect(heldBefore[tPaused.id]!.reasons).toEqual(['paused/member']);
    expect(heldBefore[tP2.id]!.reasons).toEqual(['paused/project']);
    const stopBefore = e.ctx.stop();

    e.crash();
    e = box.v = await e.reboot({ holdAll: true });

    // ① 정지 상태가 먼저 그대로 복원된다
    expect(e.ctx.stop()).toEqual(stopBefore);
    const snap = e.core.views.snapshot();
    expect(snap.members.find((m) => m.id === docs)?.status).toBe('paused');
    expect(snap.projects.find((p) => p.id === p2.id)?.paused).toBe(true);
    // ② 보류도 그대로 (질문·재계획·팀원 정지·프로젝트 정지)
    for (const t of others) expect(holdOf(e.ctx.store.tasks.require(t.id)), t.title).toEqual(heldBefore[t.id]);
    // ③ 결과 확인: 끊긴 턴은 앱 재시작으로 마감, 기록 전에 끊긴 커밋은 git에서 확인해 단계 완료로 기록
    expect(taskTurns(e.ctx, tRun.id)[0]).toMatchObject({ endReason: 'app_restart' });
    const commits = e.ctx.store.execs.list({ ref1: tRun.id, ref2: 'git_commit' });
    expect(commits.map((x) => [x.state, x.result.recovered])).toEqual([['succeeded', 'already_applied']]);
    expect(e.ctx.store.steps.list(tRun.id)[0]).toMatchObject({ done: true, note: '재시작 복구로 확인' });
    // ④ 재개 가능한 작업만 이어 간다 — 시작 직후 첫 스케줄링에서, 결과 확인 안내와 함께 (CLI 세션 연속성은 아래 별도 테스트)
    const runLaunches = e.launchesOf(taskKey(tRun.id));
    expect(runLaunches).toHaveLength(1);
    expect(firstSession).toBeTruthy();
    expect(runLaunches[0]!.message).toContain('앱이 다시 시작되어 이어서 진행합니다');
    expect(runLaunches[0]!.message).toContain('확인된 결과와 미확정 항목을 구분하세요');
    // 나머지는 몇 번을 돌려도 실행하지 않는다 (정지된 팀원에게 온 메시지 포함)
    e.tick();
    e.tick();
    await sleep(50);
    for (const t of others) expect(e.launchesOf(taskKey(t.id)), t.title).toEqual([]);
    expect(e.launches.filter((l) => l.memberId === docs || l.memberId === p2dev)).toEqual([]);
    // 재개·보류 요약 알림 1회
    const summary = notices(e.ctx, '재시작 복구');
    expect(summary).toHaveLength(1);
    expect(summary[0]!.body).toContain('재개 1건');
    expect(summary[0]!.body).toContain('보류 유지 4건');
  }, 120_000);

  it('AC-14: PC가 꺼졌다 켜진 뒤 이어 가는 작업은 끊긴 CLI 세션을 이어하기로 재개하거나, 이어할 수 없으면 새 세션에 인계 요약(목표·완료/남은 단계·마지막 커밋)을 넘긴다 (ERR-03)', async () => {
    const box = track(await bootRestartable());
    let e = box.v;
    const d = seedDirective(e);
    const t = e.core.tasks.create(devTaskInput(d.id, e.devId, '로그인 화면'), e.producerId);
    e.hold.add(taskKey(t.id));
    e.tick();
    await waitUntil(() => !!e.liveProc(taskKey(t.id)), '작업 턴');
    const p = e.liveProc(taskKey(t.id))!;
    expect((await e.tool(p.turnId, 'set_steps', { steps: ['화면', '테스트'] })).ok).toBe(true);
    writeFileSync(join(e.ctx.store.tasks.require(t.id).workspace!.worktreePath, 'screen.txt'), '화면\n', 'utf8');
    expect((await e.tool(p.turnId, 'complete_step', { step_index: 0, note: '화면 완료' })).ok).toBe(true);
    const first = e.launchesOf(taskKey(t.id))[0]!;
    const sessionBefore = e.ctx.store.sessions.list({ ref2: taskKey(t.id) })[0]!;
    expect(sessionBefore.cliSessionId).toBe(first.newSessionId);

    e.crash(); // 턴 도중 전원 차단 (CLI는 첫 단계를 커밋한 채 대화가 남아 있다)
    e = box.v = await e.reboot({ holdAll: true });

    const next = e.launchesOf(taskKey(t.id));
    expect(next).toHaveLength(1);
    const resumed = next[0]!.resume === first.newSessionId;
    const handedOver = next[0]!.message.includes('이전 세션에서 넘겨받은 내용') && next[0]!.message.includes('완료 단계: 화면');
    expect(
      resumed || handedOver,
      `재시작 뒤 턴: 이어하기=${next[0]!.resume ?? '없음'}, 새 CLI 세션=${next[0]!.newSessionId ?? '없음'}, 인계 요약=${handedOver ? '있음' : '없음'}, ` +
        `메시지에 '첫 턴' 표시=${next[0]!.message.includes('이 세션의 첫 턴입니다')}`,
    ).toBe(true);
  });

  it('AC-14: 앱을 다시 시작해도(실제 프로세스) 팀원 일시정지와 그 보류는 복원돼 실행되지 않고, 재개 가능한 작업만 같은 세션으로 이어 가 끝까지 진행된다', async () => {
    const box = track(await createHarness({ team: ['developer', 'docs'], scenarios: { developer: 'hang', docs: 'hang' } }));
    let h = box.v;
    const did = await sendCommand(h, '회원가입 화면과 사용 설명서를 만들어 줘');
    const dev = h.members.developer!;
    const docs = h.members.docs!;
    const taskOf = (m: string) => h.tasks().find((t) => t.directiveId === did && t.assigneeId === m);
    await h.waitFor(() => [dev, docs].every((m) => taskOf(m)?.state === 'in_progress' && h.core.turns.isMemberRunning(m) && cliSpoke(h, m)), { timeoutMs: 90_000, label: '두 작업 턴' });
    await h.main('pause_member', { member_id: docs, mode: 'immediate' });
    await h.waitFor(() => !h.core.turns.isMemberRunning(docs), { label: '문서 턴 종료' });
    const docsTask = taskOf(docs)!;
    const devTask = taskOf(dev)!;
    expect(holdOf(docsTask)).toEqual({ state: 'on_hold', reasons: ['paused/member'], returnState: 'in_progress' });
    const devSession = taskTurns(h.core.ctx, devTask.id)[0]!.sessionId;

    h = box.v = await h.restart();

    expect(h.core.ctx.stop().members[docs]).toMatchObject({ paused: true, mode: 'immediate' });
    expect(holdOf(h.task(docsTask.id))).toEqual({ state: 'on_hold', reasons: ['paused/member'], returnState: 'in_progress' });
    // 재개 가능한 개발 작업은 같은 세션으로 이어 가 병합까지
    await h.waitFor(() => h.task(devTask.id).state === 'done', { timeoutMs: 120_000, label: '개발 작업 완료' });
    const devTurns = taskTurns(h.core.ctx, devTask.id);
    expect(devTurns[0]!.endReason).toBe('user_stop'); // 앱 종료 때 정지
    expect(devTurns[1]).toMatchObject({ isResume: true, sessionId: devSession });
    // 정지된 팀원의 작업은 재시작 뒤 한 번도 실행되지 않았다
    expect(taskTurns(h.core.ctx, docsTask.id)).toHaveLength(1);
    expect(h.task(docsTask.id).state).toBe('on_hold');
    expect(h.core.ctx.store.directives.require(did).state).toBe('in_progress');
    // 명시적 재개 → 저장된 상태(진행)로 돌아가 끝까지
    await h.main('resume_member', { member_id: docs });
    await h.waitFor(() => h.core.ctx.store.directives.get(did)?.state === 'awaiting_confirmation', { timeoutMs: 120_000, label: '지시 보고' });
    expect(h.task(docsTask.id).state).toBe('done');
  }, 300_000);
});

// ═════════════════════════ AC-15 ═════════════════════════

describe('AC-15 긴급 정지 — 새 실행 즉시 차단, 3초 안 모든 CLI·하위 프로세스 종료 확인과 요약, 실패 시 완료 표시 안 함', () => {
  it('AC-15: 실제 CLI(모의 에이전트)와 그 하위 프로세스가 돌 때 긴급 정지하면 확인 창 없이 새 실행을 막고, 3초 안에 모두 끝난 것을 확인해 멈춘 실행·중간 상태 작업을 요약한다', async () => {
    const rig = rigFor();
    const { v: h } = track(await createHarness({ team: ['developer', 'developer', 'qa'], scenarios: { developer: 'hang' }, runnerMode: 'jobobject' }));
    await h.internal('members.update', h.members.developer2!, { mockScenario: 'hang' });
    wrapTurnsWithRig(h, rig);
    const did = await sendCommand(h, '로그인 화면과 회원가입 화면을 만들어 줘');
    await h.waitFor(() => liveTaskTurns(h).length === 2 && rig.records('turn-').filter((r) => r.port).length === 6, { timeoutMs: 90_000, label: '작업 턴 2개 + 개발 서버 6개' });
    // 메인 에이전트 CLI도 실행 중이게: 다음 명령 처리 턴이 응답 없이 멈춘다
    await h.internal('members.update', MAIN_AGENT_ID, { mockScenario: 'hang' });
    await h.invoke('command.send', { target: h.projectId, text: '진행 상황을 알려 줘' });
    await h.waitFor(() => h.core.turns.isMemberRunning(MAIN_AGENT_ID) && cliSpoke(h, MAIN_AGENT_ID), { timeoutMs: 60_000, label: '메인 에이전트 턴' });
    const recs = rig.records('turn-');
    expect(recs).toHaveLength(12);
    const live = h.core.turns.liveTurnIds();
    expect(live).toHaveLength(3);
    const mainTurn = h.core.ctx.store.turns.list().find((t) => t.memberId === MAIN_AGENT_ID && !t.endedAt)!;
    expect(mainTurn.process.pid).toBeTruthy();
    const turnsBefore = h.core.ctx.store.turns.list().length;

    const t0 = performance.now();
    const stopAt = Date.now();
    const pending = h.invoke('stop.emergency');
    // 같은 동기 구간에서 정지 값이 저장돼 스케줄러가 아무것도 띄우지 않는다
    expect(h.core.ctx.stop().global.active).toBe(true);
    h.core.scheduler.tick();
    const summary = await pending;
    const took = performance.now() - t0;
    process.stdout.write(`[AC-15 측정] 긴급 정지 요약까지 ${Math.round(took)}ms — ${summary.stoppedTurns.map((s) => `${s.memberName}: ${s.detail}`).join(' / ')}\n`);

    expect(took, `종료 확인까지 ${Math.round(took)}ms`).toBeLessThan(3000);
    expect(summary.completed).toBe(true);
    expect(summary.failures).toEqual([]);
    expect(summary.stoppedTurns.map((s) => s.turnId).sort()).toEqual([...live].sort());
    expect(summary.stoppedTurns.every((s) => s.ok && s.detail.startsWith('종료 확인'))).toBe(true);
    // 무엇이 중간 상태인지 (CTL-04): 진행 중이던 개발 작업 2개, 대기 중이던 QA 작업
    const tasks = h.tasks().filter((t) => t.directiveId === did);
    expect(summary.heldTasks.map((x) => `${x.taskId}:${x.previousState}`).sort()).toEqual(
      tasks.map((t) => `${t.id}:${t.assigneeId === h.members.qa ? 'waiting' : 'in_progress'}`).sort(),
    );
    for (const t of tasks) expect(h.task(t.id).hold.reasons.map((r) => r.kind)).toEqual(['emergency_stop']);
    // 모든 CLI·하위 프로세스가 끝났다 (PID 번호는 곧 다른 프로세스가 받을 수 있어 생성 시각으로 같은 프로세스인지 본다)
    expect(stillRunning(recs.map((r) => r.pid), stopAt).map((p) => recs.find((r) => r.pid === p)?.file ?? p)).toEqual([]);
    // 개발 서버가 쓰던 포트를 그 개발 서버가 아직 듣지 않는다 — 비워진 번호를 동시에 도는 다른 시험 프로세스가 받은 것은 남은 것이 아니다 (10.11 AC-15 행, 리드 결정 S3-17)
    for (const r of recs.filter((x) => x.port)) expect(await portHeldBy(r.port!, r.pid, stopAt), r.file).toBe(false);
    expect(stillRunning([mainTurn.process.pid!], stopAt), '메인 에이전트 CLI').toEqual([]);
    // 화면·알림: 완료 요약
    expect(h.snapshot().stop.lastEmergency).toEqual(summary);
    expect(notices(h.core.ctx, '긴급 정지 완료').map((n) => n.level)).toEqual(['urgent']);
    expect(describeEmergency(summary).title).toBe('긴급 정지 완료');
    // 그 뒤로도 새 실행이 없다 (스케줄러 2초 주기 두 번 이상)
    await sleep(4500);
    expect(h.core.ctx.store.turns.list()).toHaveLength(turnsBefore);
    expect(h.core.turns.count()).toBe(0);
  }, 180_000);

  it('AC-15: 긴급 정지는 종료 확인을 기다리기 전에 정지 값을 저장해 즉시 막는다 — 같은 순간의 스케줄링·대기 작업 활성화·실행 중 CLI의 앱 도구 요청·메인 에이전트의 재개(resume_task)가 거부된다 (가짜 CLI)', async () => {
    const { v: e } = track(await bootOrch());
    const d = seedOrchDirective(e);
    const running = e.core.tasks.create(devTaskInput(d.id, e.devId, '진행 중'), e.producerId);
    e.hold.add(taskKey(running.id));
    e.tick();
    await waitFor(() => !!e.liveProc(taskKey(running.id)), '작업 턴');
    const waiting = e.core.tasks.create({ ...devTaskInput(d.id, e.qaId, '대기 중'), type: 'test' }, e.producerId);
    const proc = e.liveProc(taskKey(running.id))!;
    const launchesBefore = e.launches.length;

    const pending = e.core.stops.emergency(OWNER);
    expect(e.ctx.stop().global.active).toBe(true);
    e.tick();
    expect(e.launches.length).toBe(launchesBefore);
    expect(e.ctx.store.tasks.require(waiting.id)).toMatchObject({ state: 'on_hold', activatedAt: null });
    expect(await e.tool(proc.turnId, 'set_steps', { steps: ['계속'] })).toMatchObject({ ok: false, code: 'stopped' });
    const summary = await pending;
    expect(summary.completed).toBe(true);
    expect(proc.terminatedByApp).toBe(true);
    await e.idle();
    e.tick();
    await sleep(50);
    expect(e.launches.length).toBe(launchesBefore);
    await expect(e.main('resume_task', { task_id: running.id })).rejects.toThrow(/긴급 정지 중/);
  });

  it('AC-15: 종료를 확인하지 못한 프로세스가 있으면 긴급 정지를 완료로 표시하지 않고, 누가 몇 개를 남겼는지 긴급 알림으로 알리며 그 작업에 새 프로세스를 겹쳐 띄우지 않는다 (가짜 CLI)', async () => {
    const { v: e } = track(await bootOrch());
    const d = seedOrchDirective(e);
    const t = e.core.tasks.create(devTaskInput(d.id, e.devId, '개발 서버를 띄운 작업'), e.producerId);
    e.hold.add(taskKey(t.id));
    e.hold.add(directiveKey(d.id));
    enqueue(e.ctx, { kind: 'message', memberId: e.producerId, sessionKey: directiveKey(d.id), projectId: e.projectId, directiveId: d.id, message: '진행 상황을 정리해 주세요' });
    e.tick();
    await waitFor(() => !!e.liveProc(taskKey(t.id)) && !!e.liveProc(directiveKey(d.id)), '작업·관리 턴');
    const stuck = e.liveProc(taskKey(t.id))!;
    // 러너가 job을 비우지 못하고 남은 프로세스 2개를 보고하는 경우
    stuck.terminate = async () => {
      stuck.terminatedByApp = true;
      stuck.exit(null, { terminated: true, remaining: 2 });
      return { ok: false, remaining: 2, detail: '작업 개체로 프로세스 트리를 종료했습니다. 하지만 남은 프로세스가 있습니다 (2개)', durationMs: 2800 };
    };
    const summary = await e.invoke('stop.emergency');
    const devName = e.ctx.store.members.require(e.devId).name;
    expect(summary.completed).toBe(false);
    expect(summary.failures).toEqual([{ memberId: e.devId, memberName: devName, detail: expect.stringContaining('남은 프로세스가 있습니다 (2개)') }]);
    expect(summary.stoppedTurns.find((s) => s.memberId === e.producerId)?.ok).toBe(true);
    const n = notices(e.ctx, '긴급 정지 — 종료 실패');
    expect(n.map((x) => x.level)).toEqual(['urgent']);
    expect(n[0]!.body).toContain(devName);
    expect(notices(e.ctx, '긴급 정지 완료')).toEqual([]);
    expect(describeEmergency(summary).title).toBe('긴급 정지 — 종료 확인 실패');
    expect(e.core.views.snapshot().stop.lastEmergency?.completed).toBe(false);
    await e.idle();
    expect(taskTurns(e.ctx, t.id)[0]!.process.state).toBe('kill_failed');
    expect(holdOf(e.ctx.store.tasks.require(t.id)).reasons).toEqual(['emergency_stop/global', 'error/task']);
    expect(notices(e.ctx, '프로세스 종료 확인 실패').map((x) => x.level)).toEqual(['urgent']);
  });

  it('AC-15: 메인 에이전트의 화면 도우미도 3초 안에 멈추고 끝낸다 — STOP(눌린 키를 뗀다)에 답하지 않으면 끝냈어도 완료로 표시하지 않고, 뗐는지 확인하지 못했다고 알린다 (가짜 화면 도우미, 리드 결정 S6-9)', async () => {
    // 화면 도우미는 가짜다 — 이 PC의 화면을 찍거나 입력을 보내지 않는다. 메인 턴도 가짜 CLI다 (bootOrch의 가짜 어댑터)
    const fake = createFakeDesktop({ noAck: ['STOP'] });
    cleanups.push(async () => {
      killFakePids(fake.pids());
      await fake.cleanup();
    });
    const { v: e } = track(await bootOrch({ desktop: { launcher: fake.launcher, timeouts: { READY: 5000 } } }));
    // 가짜 도우미를 붙인 실행의 메인 턴은 가짜 CLI여야 한다 — 실제 CLI가 뜨지 않는 것을 확인한다 (리드 결정 S6-19)
    assertFakeMain(e);
    await e.idle('첫 화면 확인 턴');
    e.hold.add('main:general');
    await e.invoke('command.send', { target: 'main', text: '서버 PC 화면을 봐 줘' });
    e.tick();
    await waitFor(() => !!e.liveProc('main:general', MAIN_AGENT_ID), '메인 턴');
    const turnId = e.liveProc('main:general', MAIN_AGENT_ID)!.turnId;
    expect((await e.tool(turnId, 'screen_capture', {})).ok).toBe(true);
    const pid = fake.pids()[0]!;
    const t0 = performance.now();
    const summary = await e.invoke('stop.emergency');
    const took = performance.now() - t0;
    process.stdout.write(`[AC-15 측정] 답하지 않는 화면 도우미가 있을 때 긴급 정지 요약까지 ${Math.round(took)}ms\n`);
    expect(took).toBeLessThan(3000);
    expect(summary.completed).toBe(false);
    expect(summary.failures).toEqual([{ memberId: MAIN_AGENT_ID, memberName: e.ctx.store.members.require(MAIN_AGENT_ID).name, detail: '화면 도우미: 키·버튼을 뗐는지 확인하지 못했습니다', remaining: -1 }]);
    expect(summary.stoppedTurns.find((s) => s.memberId === MAIN_AGENT_ID)?.ok).toBe(true);
    expect(describeEmergency(summary).title).toBe('긴급 정지 — 종료 확인 실패');
    expect(e.core.views.snapshot().stop.lastEmergency?.completed).toBe(false);
    const n = notices(e.ctx, '긴급 정지 — 종료 실패');
    expect(n.map((x) => x.level)).toEqual(['urgent']);
    expect(n[0]!.body).toContain('화면 도우미: 키·버튼을 뗐는지 확인하지 못했습니다');
    expect(notices(e.ctx, '긴급 정지 완료')).toEqual([]);
    // 도우미는 STOP 줄을 받은 뒤 끝났다 — 정지 뒤 화면 도구는 거부된다
    expect(fake.received()).toContain('STOP');
    expect(pidAlive(pid)).toBe(false);
    expect(await e.tool(turnId, 'screen_capture', {})).toMatchObject({ ok: false, code: 'stopped' });
  });

  it('AC-15: 화면 도우미의 정지를 아직 확인하는 동안 다시 누른 긴급 정지도 완료로 표시하지 않는다 — 두 요약 모두 같은 실패 줄이고, STOP은 한 번이며 완료 알림은 없다 (가짜 화면 도우미, 리드 결정 S6-21 A3b)', async () => {
    // 화면 도우미는 가짜다 — 이 PC의 화면을 찍거나 입력을 보내지 않는다. 메인 턴도 가짜 CLI다 (bootOrch의 가짜 어댑터)
    const fake = createFakeDesktop({ noAck: ['STOP'] });
    cleanups.push(async () => {
      killFakePids(fake.pids());
      await fake.cleanup();
    });
    const { v: e } = track(await bootOrch({ desktop: { launcher: fake.launcher, timeouts: { READY: 5000 } } }));
    assertFakeMain(e);
    await e.idle('첫 화면 확인 턴');
    e.hold.add('main:general');
    await e.invoke('command.send', { target: 'main', text: '서버 PC 화면을 봐 줘' });
    e.tick();
    await waitFor(() => !!e.liveProc('main:general', MAIN_AGENT_ID), '메인 턴');
    const turnId = e.liveProc('main:general', MAIN_AGENT_ID)!.turnId;
    expect((await e.tool(turnId, 'screen_capture', {})).ok).toBe(true);
    const t0 = performance.now();
    const first = e.invoke('stop.emergency');
    // 첫 정지는 STOP OK를 0.8초 기다리는 중이다 — 그사이 다시 누른다 (두 기기, 대표와 운영자 등)
    await sleep(200);
    const second = await e.invoke('stop.emergency');
    const s1 = await first;
    const took = performance.now() - t0;
    expect(took).toBeLessThan(3000);
    for (const s of [s1, second]) {
      expect(s.completed).toBe(false);
      expect(s.failures.map((f) => [f.memberId, f.detail])).toEqual([[MAIN_AGENT_ID, '화면 도우미: 키·버튼을 뗐는지 확인하지 못했습니다']]);
    }
    expect(fake.received().filter((l) => l === 'STOP')).toHaveLength(1);
    expect(e.core.views.snapshot().stop.lastEmergency?.completed).toBe(false);
    expect(notices(e.ctx, '긴급 정지 완료')).toEqual([]);
    expect(notices(e.ctx, '긴급 정지 — 종료 실패').length).toBeGreaterThanOrEqual(1);
  });
});

// ═════════════════════════ AC-16 ═════════════════════════

describe('AC-16 대기·진행·검수 중 일시정지가 앱·PC 재시작 후에도 유지되고, 명시적 재개 시 저장된 상태로 복귀', () => {
  it('AC-16: 프로젝트 일시정지로 보류된 대기·진행·검수 작업은 PC가 꺼졌다 켜져도 그대로이고, 프로젝트를 재개하면 다른 보류 사유가 없는 작업만 저장된 상태로 돌아간다', async () => {
    const box = track(await bootRestartable());
    let e = box.v;
    const dev2 = (await e.internal('members.add', { projectId: e.projectId, roleId: 'developer' })).id;
    const dev3 = (await e.internal('members.add', { projectId: e.projectId, roleId: 'developer' })).id;
    const docs = (await e.internal('members.add', { projectId: e.projectId, roleId: 'docs' })).id;
    const d = seedDirective(e);
    const tP = e.core.tasks.create(devTaskInput(d.id, e.devId, '진행 중'), e.producerId);
    const tW = e.core.tasks.create(devTaskInput(d.id, dev2, '대기 중 (선행 작업 대기)', [tP.id]), e.producerId);
    const tX = e.core.tasks.create(devTaskInput(d.id, dev3, '중단 보류 + 일시정지'), e.producerId);
    const tR = seedInReviewTask(e, { directiveId: d.id, assigneeId: docs, reviewerId: e.qaId, title: '검수 중' });
    e.hold.add(taskKey(tP.id));
    e.hold.add(reviewKey(tR.id));
    e.core.tasks.dispatchReview(e.ctx.store.tasks.require(tR.id));
    e.tick();
    await waitUntil(() => !!e.liveProc(taskKey(tP.id)) && !!e.liveProc(reviewKey(tR.id), e.qaId), '진행·검수 턴');
    await waitUntil(() => e.ctx.store.tasks.require(tX.id).state === 'in_progress' && !e.core.turns.hasLiveSession(taskKey(tX.id)), '세 번째 작업 첫 턴 종료');
    await e.main('interrupt_task', { task_id: tX.id, then: 'hold' });
    await e.main('pause_project', { project_id: e.projectId, mode: 'immediate' });
    await waitUntil(() => e.core.turns.count() === 0, '정지된 턴 종료');
    const expected = {
      [tW.id]: { state: 'on_hold', reasons: ['paused/project'], returnState: 'waiting' },
      [tP.id]: { state: 'on_hold', reasons: ['paused/project'], returnState: 'in_progress' },
      [tR.id]: { state: 'on_hold', reasons: ['paused/project'], returnState: 'in_review' },
      [tX.id]: { state: 'on_hold', reasons: ['interrupted/task', 'paused/project'], returnState: 'in_progress' },
    };
    for (const [id, want] of Object.entries(expected)) expect(holdOf(e.ctx.store.tasks.require(id)), id).toEqual(want);
    const sP = e.launchesOf(taskKey(tP.id))[0]!.newSessionId;
    const sR = e.launchesOf(reviewKey(tR.id))[0]!.newSessionId;

    e.crash();
    e = box.v = await e.reboot({ holdAll: true });

    expect(e.ctx.stop().projects[e.projectId]).toMatchObject({ paused: true, mode: 'immediate' });
    for (const [id, want] of Object.entries(expected)) expect(holdOf(e.ctx.store.tasks.require(id)), id).toEqual(want);
    e.tick();
    await sleep(50);
    expect(e.launches).toEqual([]);

    await e.main('resume_project', { project_id: e.projectId });
    expect(holdOf(e.ctx.store.tasks.require(tW.id))).toEqual({ state: 'waiting', reasons: [], returnState: null });
    expect(holdOf(e.ctx.store.tasks.require(tP.id))).toEqual({ state: 'in_progress', reasons: [], returnState: null });
    expect(holdOf(e.ctx.store.tasks.require(tR.id))).toEqual({ state: 'in_review', reasons: [], returnState: null });
    expect(holdOf(e.ctx.store.tasks.require(tX.id))).toEqual({ state: 'on_hold', reasons: ['interrupted/task'], returnState: 'in_progress' });
    expect(e.ctx.store.tasks.require(tR.id).review.target).toEqual(tR.review.target); // 고정된 검수 대상 그대로
    e.tick();
    await waitUntil(() => !!e.liveProc(taskKey(tP.id)) && !!e.liveProc(reviewKey(tR.id), e.qaId), '재개 후 진행·검수 턴');
    expect(e.launchesOf(taskKey(tP.id))[0]).toMatchObject({ resume: sP });
    expect(e.launchesOf(taskKey(tP.id))[0]!.message).toContain('작업이 재개되었습니다');
    expect(e.launchesOf(reviewKey(tR.id))[0]).toMatchObject({ resume: sR, memberId: e.qaId });
    expect(e.launchesOf(taskKey(tW.id))).toEqual([]); // 선행 작업이 끝나지 않아 대기 그대로
    expect(e.launchesOf(taskKey(tX.id))).toEqual([]); // 중단 보류는 그 작업의 재개 전까지
  });

  it('AC-16: 팀원 일시정지로 보류된 검수 중·대기 작업은 앱을 다시 시작해도 그대로이고, 팀원을 재개하면 검수로 돌아가 검수를 다시 넘기고 대기 작업은 대기로 돌아간다', async () => {
    const box = track(await bootRestartable());
    let e = box.v;
    const d = seedDirective(e);
    const tR = seedInReviewTask(e, { directiveId: d.id, assigneeId: e.devId, reviewerId: e.qaId, title: '검수 중' });
    const tW = e.core.tasks.create(devTaskInput(d.id, e.devId, '다음 작업 (대기)'), e.producerId);
    e.core.tasks.dispatchReview(e.ctx.store.tasks.require(tR.id));
    await e.main('pause_member', { member_id: e.devId, mode: 'graceful' });
    const want = {
      [tR.id]: { state: 'on_hold', reasons: ['paused/member'], returnState: 'in_review' },
      [tW.id]: { state: 'on_hold', reasons: ['paused/member'], returnState: 'waiting' },
    };
    for (const [id, w] of Object.entries(want)) expect(holdOf(e.ctx.store.tasks.require(id)), id).toEqual(w);

    e = box.v = await e.stopGracefully({ holdAll: true });

    expect(e.ctx.stop().members[e.devId]).toMatchObject({ paused: true, mode: 'graceful' });
    for (const [id, w] of Object.entries(want)) expect(holdOf(e.ctx.store.tasks.require(id)), id).toEqual(w);
    e.tick();
    await sleep(50);
    expect(e.launches).toEqual([]);

    await e.main('resume_member', { member_id: e.devId });
    expect(holdOf(e.ctx.store.tasks.require(tR.id))).toEqual({ state: 'in_review', reasons: [], returnState: null });
    expect(holdOf(e.ctx.store.tasks.require(tW.id))).toEqual({ state: 'waiting', reasons: [], returnState: null });
    e.tick();
    await waitUntil(() => !!e.liveProc(reviewKey(tR.id), e.qaId), '검수 턴');
    expect(e.launchesOf(taskKey(tW.id))).toEqual([]); // 활성 작업(검수 중)이 끝나기 전에는 다음 작업을 시작하지 않는다
  });

  it('AC-16: 진행 중 일시정지(기본: 단계 마치고) — 작업은 바로 보류(복귀 상태 진행)되고 CLI는 지금 단계를 마친 뒤 끝나며, PC가 꺼졌다 켜져도 그대로이고 재개하면 진행으로 돌아가 같은 CLI 세션으로 이어 간다', async () => {
    const box = track(await bootRestartable());
    let e = box.v;
    const d = seedDirective(e);
    const t = e.core.tasks.create(devTaskInput(d.id, e.devId, '단계 마치고 정지'), e.producerId);
    e.hold.add(taskKey(t.id));
    e.tick();
    await waitUntil(() => !!e.liveProc(taskKey(t.id)), '작업 턴');
    const p = e.liveProc(taskKey(t.id))!;
    expect((await e.tool(p.turnId, 'set_steps', { steps: ['화면', '테스트'] })).ok).toBe(true);

    await e.main('pause_member', { member_id: e.devId, mode: 'graceful' });
    const want = { state: 'on_hold', reasons: ['paused/member'], returnState: 'in_progress' };
    expect(holdOf(e.ctx.store.tasks.require(t.id))).toEqual(want);
    // 지금 단계를 마칠 때까지 CLI를 끊지 않는다 (정지 요청만 기록)
    await sleep(500);
    expect(p.done).toBe(false);
    expect(e.ctx.store.turns.require(p.turnId).process.state).toBe('stop_requested');
    writeFileSync(join(e.ctx.store.tasks.require(t.id).workspace!.worktreePath, 'screen.txt'), '화면\n', 'utf8');
    const step = await e.tool(p.turnId, 'complete_step', { step_index: 0, note: '화면 완료' });
    expect(step.ok).toBe(true);
    expect((step as { data: { message?: string } }).data.message).toContain('이 단계에서 멈춥니다');
    await waitUntil(() => p.done, '단계 완료 뒤 종료');
    expect(p.terminatedByApp).toBe(true);
    await e.idle();
    expect(e.ctx.store.turns.require(p.turnId)).toMatchObject({ endReason: 'user_stop', stepsCompleted: 1 });
    expect(e.ctx.store.steps.list(t.id).map((s) => s.done)).toEqual([true, false]);
    expect(e.ctx.store.tasks.require(t.id).crashRetries).toBe(0);
    const firstSession = e.launchesOf(taskKey(t.id))[0]!.newSessionId;

    e.crash();
    e = box.v = await e.reboot({ holdAll: true });

    expect(e.ctx.stop().members[e.devId]).toMatchObject({ paused: true, mode: 'graceful' });
    expect(holdOf(e.ctx.store.tasks.require(t.id))).toEqual(want);
    e.tick();
    await sleep(50);
    expect(e.launches).toEqual([]);

    await e.main('resume_member', { member_id: e.devId });
    expect(holdOf(e.ctx.store.tasks.require(t.id))).toEqual({ state: 'in_progress', reasons: [], returnState: null });
    e.tick();
    await waitUntil(() => !!e.liveProc(taskKey(t.id)), '재개 후 작업 턴');
    const next = e.launchesOf(taskKey(t.id));
    expect(next).toHaveLength(1);
    expect(next[0]!.resume).toBe(firstSession);
    expect(next[0]!.message).toContain('작업이 재개되었습니다');
  });

  it('AC-16: 검수 중 검수자 일시정지 — 검수 턴을 끝내고 검수 업무는 남겨 두되 실행하지 않으며, 앱을 다시 시작해도 그대로이고 검수자를 재개하면 같은 검수 세션으로 검수를 이어 간다', async () => {
    const box = track(await bootRestartable());
    let e = box.v;
    const d = seedDirective(e);
    const tR = seedInReviewTask(e, { directiveId: d.id, assigneeId: e.devId, reviewerId: e.qaId, title: '검수 중 (검수자 정지)' });
    e.hold.add(reviewKey(tR.id));
    e.core.tasks.dispatchReview(e.ctx.store.tasks.require(tR.id));
    e.tick();
    await waitUntil(() => !!e.liveProc(reviewKey(tR.id), e.qaId), '검수 턴');
    const rp = e.liveProc(reviewKey(tR.id), e.qaId)!;
    const reviewSession = e.launchesOf(reviewKey(tR.id))[0]!.newSessionId;

    await e.main('pause_member', { member_id: e.qaId, mode: 'graceful' });
    await e.idle();
    expect(rp.terminatedByApp).toBe(true); // 검수 턴은 단계가 없어 바로 끝낸다
    expect(e.ctx.store.turns.require(rp.turnId).endReason).toBe('user_stop');
    // 작업은 검수 상태·고정 대상 그대로, 검수 업무는 그 검수자 앞으로 남는다
    expect(holdOf(e.ctx.store.tasks.require(tR.id))).toEqual({ state: 'in_review', reasons: [], returnState: null });
    expect(e.ctx.store.tasks.require(tR.id).review.target).toEqual(tR.review.target);
    expect(queuedIn(e.ctx, (q) => q.sessionKey === reviewKey(tR.id)).map((q) => q.memberId)).toEqual([e.qaId]);

    e = box.v = await e.stopGracefully({ holdAll: true });

    expect(e.ctx.stop().members[e.qaId]).toMatchObject({ paused: true, mode: 'graceful' });
    expect(e.ctx.store.tasks.require(tR.id).state).toBe('in_review');
    e.tick();
    await sleep(50);
    expect(e.launches).toEqual([]);

    await e.main('resume_member', { member_id: e.qaId });
    e.tick();
    await waitUntil(() => !!e.liveProc(reviewKey(tR.id), e.qaId), '재개 후 검수 턴');
    expect(e.launchesOf(reviewKey(tR.id))).toHaveLength(1);
    expect(e.launchesOf(reviewKey(tR.id))[0]).toMatchObject({ memberId: e.qaId, resume: reviewSession });
  });

  it('AC-16: 팀원·프로젝트 일시정지가 겹친 진행 작업은 PC가 꺼졌다 켜져도 두 사유가 모두 남고, 팀원만 재개하면 프로젝트 정지가 남아 실행하지 않으며 프로젝트까지 재개해야 저장된 상태(진행)로 돌아가 같은 세션으로 이어 간다', async () => {
    const box = track(await bootRestartable());
    let e = box.v;
    const d = seedDirective(e);
    const t = e.core.tasks.create(devTaskInput(d.id, e.devId, '겹친 정지'), e.producerId);
    e.hold.add(taskKey(t.id));
    e.tick();
    await waitUntil(() => !!e.liveProc(taskKey(t.id)), '작업 턴');
    await e.main('pause_member', { member_id: e.devId, mode: 'immediate' });
    await e.main('pause_project', { project_id: e.projectId, mode: 'graceful' });
    await e.idle();
    const want = { state: 'on_hold', reasons: ['paused/member', 'paused/project'], returnState: 'in_progress' };
    expect(holdOf(e.ctx.store.tasks.require(t.id))).toEqual(want);
    const firstSession = e.launchesOf(taskKey(t.id))[0]!.newSessionId;

    e.crash();
    e = box.v = await e.reboot({ holdAll: true });

    expect(holdOf(e.ctx.store.tasks.require(t.id))).toEqual(want);
    expect(e.ctx.stop().members[e.devId]?.paused).toBe(true);
    expect(e.ctx.stop().projects[e.projectId]?.paused).toBe(true);
    await e.main('resume_member', { member_id: e.devId });
    expect(holdOf(e.ctx.store.tasks.require(t.id))).toEqual({ state: 'on_hold', reasons: ['paused/project'], returnState: 'in_progress' });
    e.tick();
    await sleep(50);
    expect(e.launches).toEqual([]);

    await e.main('resume_project', { project_id: e.projectId });
    expect(holdOf(e.ctx.store.tasks.require(t.id))).toEqual({ state: 'in_progress', reasons: [], returnState: null });
    e.tick();
    await waitUntil(() => !!e.liveProc(taskKey(t.id)), '재개 후 작업 턴');
    expect(e.launchesOf(taskKey(t.id))[0]!.resume).toBe(firstSession);
  });
});

// ═════════════════════════ AC-29 ═════════════════════════

describe('AC-29 긴급 정지 후 CLI가 띄운 하위 프로세스(개발 서버 등)가 하나도 남지 않는다', () => {
  it(`AC-29: ${JOB_RUNNER} — CLI가 띄운 개발 서버(직접 자식·손자·부모가 먼저 끝난 고아)와 중간 프로세스가 긴급 정지 후 하나도 남지 않고 포트도 닫힌다`, async () => {
    const rig = rigFor();
    const { v: h } = track(await createHarness({ team: ['developer', 'developer'], scenarios: { developer: 'hang' }, runnerMode: 'jobobject' }));
    await h.internal('members.update', h.members.developer2!, { mockScenario: 'hang' });
    wrapTurnsWithRig(h, rig);
    await sendCommand(h, '로그인 화면과 회원가입 화면을 만들어 줘');
    await h.waitFor(() => liveTaskTurns(h).length === 2 && rig.records('turn-').filter((r) => r.port).length === 6, { timeoutMs: 90_000, label: '개발 서버 6개' });
    await sleep(700); // 고아를 만든 중간 프로세스가 먼저 끝날 때까지
    const recs = rig.records('turn-');
    // 정지 전: 작업 개체 러너 2(Windows만 — pgroup은 러너 프로세스가 없다) + CLI 대역 2 + 중간 2 + 개발 서버 6 (명령줄에 표식을 가진 실제 프로세스,
    // 모의 에이전트 자신은 PID로 확인)
    expect(markedProcesses(rig.marker)).toHaveLength(isWin ? 12 : 10);
    for (const r of recs.filter((x) => x.port)) expect(await portOpen(r.port!), r.file).toBe(true);

    const stopAt = Date.now();
    const summary = await h.invoke('stop.emergency');

    expect(summary.completed).toBe(true);
    expect(markedProcesses(rig.marker)).toEqual([]);
    expect(stillRunning(recs.map((r) => r.pid), stopAt).map((p) => recs.find((r) => r.pid === p)?.file ?? p)).toEqual([]);
    for (const r of recs.filter((x) => x.port)) expect(await portOpen(r.port!), r.file).toBe(false);
  }, 180_000);

  it(`AC-29: ${JOB_RUNNER} — 자동 검사(빌드·테스트) 명령이 띄운 개발 서버·고아도 긴급 정지 후 남지 않고, 끊긴 검사는 실패로 치지 않는다`, async () => {
    const rig = rigFor();
    const { v: h } = track(await createHarness({ team: ['developer'], runnerMode: 'jobobject', checkCommands: [rig.checkCommand()] }));
    const did = await sendCommand(h, '로그인 화면을 만들어 줘');
    await h.waitFor(() => rig.records('check-').filter((r) => r.port).length === 2, { timeoutMs: 120_000, label: '자동 검사의 개발 서버 2개' });
    await sleep(700);
    const recs = rig.records('check-');
    expect(recs).toHaveLength(3);
    const task = h.tasks().find((t) => t.directiveId === did)!;
    expect(h.core.checks.running.has(task.id)).toBe(true);

    const stopAt = Date.now();
    const summary = await h.invoke('stop.emergency');

    expect(summary.completed).toBe(true);
    expect(markedProcesses(rig.marker)).toEqual([]);
    expect(stillRunning(recs.map((r) => r.pid), stopAt).map((p) => recs.find((r) => r.pid === p)?.file ?? p)).toEqual([]);
    for (const r of recs.filter((x) => x.port)) expect(await portOpen(r.port!), r.file).toBe(false);
    await h.waitFor(() => !h.core.tasks.isSubmitting(task.id), { label: '제출 처리 멈춤' });
    expect(h.task(task.id).pendingSubmit).not.toBeNull();
    expect(h.task(task.id).review.autoCheck.status).not.toBe('failed');
  }, 180_000);

  it.skipIf(!isWin)(`AC-29: 작업 개체 러너를 쓸 수 없어 taskkill 방식으로 대체된 경우에도 긴급 정지 후 하위 프로세스가 남지 않아야 하고, 남는다면 완료로 표시하지 않아야 한다${WINDOWS_ONLY_TASKKILL}`, async () => {
    const rig = rigFor();
    const { v: h } = track(await createHarness({ team: ['developer'], scenarios: { developer: 'hang' }, runnerMode: 'taskkill' }));
    wrapTurnsWithRig(h, rig);
    await sendCommand(h, '로그인 화면을 만들어 줘');
    await h.waitFor(() => liveTaskTurns(h).length === 1 && rig.records('turn-').filter((r) => r.port).length === 3, { timeoutMs: 90_000, label: '개발 서버 3개' });
    await sleep(700);

    const summary = await h.invoke('stop.emergency');
    await sleep(300);

    const left = markedProcesses(rig.marker);
    expect.soft(left.map((p) => p.cmd), '긴급 정지 후 남은 하위 프로세스').toEqual([]);
    expect.soft(summary.completed && left.length > 0, `남은 프로세스 ${left.length}개가 있는데 긴급 정지 요약이 '완료'`).toBe(false);
  }, 180_000);

  it(`AC-29: ${JOB_RUNNER} — 스스로 끝난 턴이 띄워 둔 개발 서버는 그 턴이 끝날 때 정리되고, 실행 중이던 턴의 개발 서버는 긴급 정지로 정리되어 긴급 정지 뒤 남은 하위 프로세스가 없다`, async () => {
    const rig = rigFor();
    const { v: h } = track(await createHarness({ team: ['developer', 'developer'], runnerMode: 'jobobject' }));
    await h.internal('members.update', h.members.developer2!, { mockScenario: 'hang' });
    wrapTurnsWithRig(h, rig);
    const did = await sendCommand(h, '로그인 화면과 회원가입 화면을 만들어 줘');
    const [d1, d2] = [h.members.developer!, h.members.developer2!];
    const taskOf = (m: string) => h.tasks().find((t) => t.directiveId === did && t.assigneeId === m);
    const tagOf = (taskId: string) => `turn-task_${taskId}-t1-`;
    await h.waitFor(
      () => {
        const [a, b] = [taskOf(d1), taskOf(d2)];
        return !!a && !!b && !!taskTurns(h.core.ctx, a.id)[0]?.endedAt && h.core.turns.isMemberRunning(d2) && rig.records(tagOf(b.id)).filter((r) => r.port).length === 3;
      },
      { timeoutMs: 90_000, label: '개발자 1의 턴은 스스로 끝나고, 개발자 2의 턴은 개발 서버 3개와 함께 실행 중' },
    );
    const [t1, t2] = [taskOf(d1)!, taskOf(d2)!];
    const ended = taskTurns(h.core.ctx, t1.id)[0]!;
    expect(ended.endReason).toBe('completed');
    expect(ended.process.state).toBe('exited'); // 남은 프로세스 없이 정리됨 (kill_failed 아님)
    // 스스로 끝난 턴의 CLI 대역·개발 서버·중간 프로세스는 턴이 끝날 때 작업 개체가 정리했다
    const endedRecs = rig.records(tagOf(t1.id));
    expect(endedRecs.map((r) => r.file.replace(tagOf(t1.id), ''))).toEqual(expect.arrayContaining(['cli.json', 'agent.json']));
    expect(stillRunning(endedRecs.map((r) => r.pid), Date.parse(ended.endedAt!)).map((p) => endedRecs.find((r) => r.pid === p)?.file ?? p)).toEqual([]);
    expect(markedProcesses(tagOf(t1.id))).toEqual([]);
    await sleep(700); // 고아를 만든 중간 프로세스가 먼저 끝날 때까지
    for (const r of rig.records(tagOf(t2.id)).filter((x) => x.port)) expect(await portOpen(r.port!), r.file).toBe(true);

    const stopAt = Date.now();
    const summary = await h.invoke('stop.emergency');

    expect(summary.completed).toBe(true);
    expect(markedProcesses(rig.marker)).toEqual([]);
    const all = rig.records('turn-');
    expect(stillRunning(all.map((r) => r.pid), stopAt).map((p) => all.find((r) => r.pid === p)?.file ?? p)).toEqual([]);
    for (const r of all.filter((x) => x.port)) expect(await portOpen(r.port!), r.file).toBe(false);
  }, 180_000);

  it.skipIf(!isWin)(`AC-29: 작업 개체 러너를 쓸 수 없어 taskkill 방식으로 대체된 경우, 이미 스스로 끝난 턴이 띄워 둔 하위 프로세스(부모가 먼저 끝난 개발 서버)도 긴급 정지 뒤에 남지 않아야 하고, 남는다면 완료로 표시하지 않아야 한다${WINDOWS_ONLY_TASKKILL}`, async () => {
    const rig = rigFor();
    const { v: h } = track(await createHarness({ team: ['developer', 'developer'], runnerMode: 'taskkill' }));
    cleanups.push(() => killMarked(rig.marker)); // 하네스를 닫기 전에 남은 개발 서버부터 끝낸다 (작업 폴더를 붙잡지 않게)
    await h.internal('members.update', h.members.developer2!, { mockScenario: 'hang' });
    wrapTurnsWithRig(h, rig);
    const did = await sendCommand(h, '로그인 화면과 회원가입 화면을 만들어 줘');
    const [d1, d2] = [h.members.developer!, h.members.developer2!];
    const taskOf = (m: string) => h.tasks().find((t) => t.directiveId === did && t.assigneeId === m);
    const tagOf = (taskId: string) => `turn-task_${taskId}-t1-`;
    await h.waitFor(
      () => {
        const [a, b] = [taskOf(d1), taskOf(d2)];
        return (
          !!a &&
          !!b &&
          !!taskTurns(h.core.ctx, a.id)[0]?.endedAt &&
          rig.records(tagOf(a.id)).filter((r) => r.port).length === 3 &&
          h.core.turns.isMemberRunning(d2) &&
          rig.records(tagOf(b.id)).filter((r) => r.port).length === 3
        );
      },
      { timeoutMs: 90_000, label: '개발자 1의 턴은 스스로 끝나고, 개발자 2의 턴은 실행 중 (각각 개발 서버 3개)' },
    );
    await sleep(700);
    const t1 = taskOf(d1)!;
    const ended = taskTurns(h.core.ctx, t1.id)[0]!;

    const summary = await h.invoke('stop.emergency');
    await sleep(300);

    const left = markedProcesses(rig.marker);
    const leftFromEnded = left.filter((p) => p.cmd.includes(tagOf(t1.id)));
    expect.soft(
      leftFromEnded.map((p) => p.cmd),
      `스스로 끝난 턴(${ended.id}, 기록: ${ended.endReason}/${ended.process.state})이 띄워 둔 개발 서버가 긴급 정지 뒤에도 남음`,
    ).toEqual([]);
    expect.soft(left.map((p) => p.cmd), '긴급 정지 후 남은 하위 프로세스').toEqual([]);
    expect.soft(summary.completed && left.length > 0, `남은 프로세스 ${left.length}개가 있는데 긴급 정지 요약이 '완료'`).toBe(false);
  }, 180_000);
});

// ═════════════════════════ AC-44 ═════════════════════════

describe('AC-44 긴급 정지 후 재시작·재로그인·한도 해제·메시지 도착으로 재개되지 않고, 전역 해제 후에도 항목별 재개 전에는 실행 안 함', () => {
  it('AC-44: 긴급 정지 뒤 PC를 다시 켜고, 다시 로그인하고, 메시지·답변이 도착하고, 전역 정지를 풀어도 작업은 실행되지 않으며 항목별로 재개한 작업만 실행된다', async () => {
    const box = track(await bootRestartable());
    let e = box.v;
    const dev2 = (await e.internal('members.add', { projectId: e.projectId, roleId: 'developer' })).id;
    const docs = (await e.internal('members.add', { projectId: e.projectId, roleId: 'docs' })).id;
    const d = seedDirective(e);
    const tP = e.core.tasks.create(devTaskInput(d.id, e.devId, '진행 중'), e.producerId);
    const tA = e.core.tasks.create(devTaskInput(d.id, dev2, '질문한 작업'), e.producerId);
    const tR = seedInReviewTask(e, { directiveId: d.id, assigneeId: docs, reviewerId: e.qaId, title: '검수 중' });
    e.hold.add(taskKey(tP.id));
    e.hold.add(taskKey(tA.id));
    e.hold.add(reviewKey(tR.id));
    e.core.tasks.dispatchReview(e.ctx.store.tasks.require(tR.id));
    e.tick();
    await waitUntil(() => !!e.liveProc(taskKey(tP.id)) && !!e.liveProc(taskKey(tA.id)) && !!e.liveProc(reviewKey(tR.id)), '턴 3개');
    const asked = await e.tool(e.liveProc(taskKey(tA.id))!.turnId, 'ask_producer', { question: '어느 API를 쓰나요?' });
    expect(asked.ok).toBe(true);
    const qid = (asked.ok ? (asked.data as { questionId: string }).questionId : '') as string;
    const summary = await e.invoke('stop.emergency');
    expect(summary.completed).toBe(true);
    await e.idle();
    const sP = e.launchesOf(taskKey(tP.id))[0]!.newSessionId;
    const items = [tP, tA, tR];
    for (const t of items) expect(e.ctx.store.tasks.require(t.id).hold.reasons.map((r) => r.kind)).toContain('emergency_stop');

    // 1) PC 재시작
    e.crash();
    e = box.v = await e.reboot({ holdAll: true });
    expect(e.ctx.stop().global.active).toBe(true);
    expect(e.launches).toEqual([]); // 시작 직후 첫 스케줄링에서도
    // 2) 다시 로그인
    await e.invoke('auth.logout');
    await e.invoke('auth.devLogin');
    // 3) 메시지 도착: 대표 명령 — 대표가 팀원에게 직접 보내는 길은 없고(v0.6), 정지 중에는 메인 에이전트의 긴급 지시도 앱 도구에서 거부된다
    await expect(e.main('instruct_member', { member_id: e.devId, text: '정지 전에 하던 것을 이어 주세요', urgent: true })).rejects.toMatchObject({ code: 'stopped' });
    await e.invoke('command.send', { target: e.projectId, text: '진행 상황을 알려 줘' });
    // 4) 답변 도착: 답변 대기 사유만 풀리고 긴급 정지 보류는 남는다
    e.core.tasks.answer(qid, '기존 API를 쓰세요', e.producerId);
    expect(holdOf(e.ctx.store.tasks.require(tA.id)).reasons).toEqual(['emergency_stop/global']);
    e.tick();
    e.tick();
    await sleep(50);
    expect(e.launches).toEqual([]);
    for (const t of items) expect(e.ctx.store.tasks.require(t.id).state).toBe('on_hold');

    // 5) 전역 정지 해제: 새 실행은 고를 수 있지만 보류된 작업은 실행하지 않는다. 보류 목록은 메인 에이전트에게 업무로 간다 (stop_released, v0.6 CTL-10)
    await e.invoke('stop.release');
    expect(e.core.views.snapshot().stop.heldByEmergency).toBe(3);
    const released = e.ctx.store.queue.list({ ref2: 'main:general' }).filter((q) => q.kind === 'stop_released' && q.memberId === MAIN_AGENT_ID);
    expect(released).toHaveLength(1);
    for (const t of items) expect(released[0]!.message).toContain(t.id);
    e.tick();
    await sleep(50);
    e.tick();
    await sleep(50);
    const workLaunches = () => e.launches.filter((l) => l.workKey.startsWith('task:') || l.workKey.startsWith('review:'));
    expect(workLaunches()).toEqual([]);
    for (const t of items) expect(holdOf(e.ctx.store.tasks.require(t.id)).reasons).toEqual(['emergency_stop/global']);
    // 해제 뒤 메인 에이전트의 긴급 지시가 와도 보류된 작업은 실행하지 않는다 — 저장만 하고 재개 때 먼저 전달
    await e.main('instruct_member', { member_id: e.devId, text: '정지 전에 하던 것을 이어 주세요', urgent: true });
    e.tick();
    await sleep(50);
    expect(workLaunches()).toEqual([]);

    // 6) 메인 에이전트가 resume_task로 항목별 재개한 작업만 — 기다리던 긴급 지시와 함께 같은 세션 이어하기
    await e.main('resume_task', { task_id: tP.id });
    e.tick();
    await waitUntil(() => !!e.liveProc(taskKey(tP.id)), '재개한 작업 턴');
    expect(workLaunches().map((l) => l.workKey)).toEqual([taskKey(tP.id)]);
    expect(workLaunches()[0]!.resume).toBe(sP);
    expect(workLaunches()[0]!.message).toContain('정지 전에 하던 것을 이어 주세요');
    // 나머지도 각각 재개하면 그때 실행 (답변은 재개 때 함께 전달)
    await e.main('resume_task', { task_id: tA.id });
    await e.main('resume_task', { task_id: tR.id });
    e.tick();
    await waitUntil(() => !!e.liveProc(taskKey(tA.id)) && !!e.liveProc(reviewKey(tR.id)), '재개한 두 항목');
    expect(e.launchesOf(taskKey(tA.id))[0]!.message).toContain('기존 API를 쓰세요');
  });

  it('AC-44: 긴급 정지 뒤 사용량 한도가 풀리거나 CLI 재로그인을 확인해도 작업이 재개되지 않고, 정지 해제 후 항목별 재개 때만 실행된다 (실제 어댑터 경로의 AI 가용성 검사, 가짜 CLI)', async () => {
    const { v: e } = track(await bootOrch({ mock: false }));
    const d = seedOrchDirective(e);
    const t = e.core.tasks.create(devTaskInput(d.id, e.devId, '한도에 걸린 작업'), e.producerId);
    const key = taskKey(t.id);
    const kind = e.ctx.store.members.require(e.devId).ai.kind;
    const resetAt = new Date(Date.now() + 1500).toISOString();
    let first = true;
    e.script.set(key, (p) => {
      if (!first) return; // 이후 턴은 끝나지 않게 둔다 (실행됐는지만 본다)
      first = false;
      p.emit({ kind: 'error', text: "You've hit your usage limit.", data: { errorKind: 'usage_limit', resetAt } });
    });
    e.tick();
    await e.idle();
    expect(taskTurns(e.ctx, t.id).map((x) => x.endReason)).toEqual(['usage_limit']);
    expect(e.ctx.ai(kind).usageLimitedUntil).toBe(resetAt);
    expect(queuedIn(e.ctx, (q) => q.sessionKey === key)).toHaveLength(1); // 한도가 풀리면 이어 갈 업무

    await e.invoke('stop.emergency');
    expect(holdOf(e.ctx.store.tasks.require(t.id))).toEqual({ state: 'on_hold', reasons: ['emergency_stop/global'], returnState: 'in_progress' });
    // 한도 해제
    await waitUntil(() => Date.now() > Date.parse(resetAt) + 50, '한도 해제 시각', 5000);
    e.tick();
    await sleep(50);
    // 인증 만료 → 재로그인 확인
    e.ctx.saveAi({ ...e.ctx.ai(kind), authRequired: true, authRequiredSince: e.ctx.now() });
    await e.internal('system.recheckAi', kind);
    expect(e.ctx.ai(kind).authRequired).toBe(false);
    e.tick();
    await sleep(50);
    expect(e.launches.filter((l) => l.workKey === key)).toHaveLength(1);
    // 전역 정지 해제만으로는 실행하지 않는다
    await e.invoke('stop.release');
    e.tick();
    await sleep(50);
    expect(e.launches.filter((l) => l.workKey === key)).toHaveLength(1);
    expect(e.ctx.store.tasks.require(t.id).state).toBe('on_hold');
    // 항목별 재개
    await e.main('resume_task', { task_id: t.id });
    e.tick();
    await waitFor(() => e.launches.filter((l) => l.workKey === key).length === 2, '재개한 작업 턴');
  });

  it('AC-44: 실제 프로세스 — 긴급 정지 뒤 앱을 다시 시작하고 메시지가 와도, 전역 정지를 풀어도 실행되지 않다가 항목별 재개한 작업만 이어서 끝난다', async () => {
    const box = track(await createHarness({ team: ['developer'], scenarios: { developer: 'hang' } }));
    let h = box.v;
    const did = await sendCommand(h, '로그인 화면을 만들어 줘');
    const dev = h.members.developer!;
    const taskOf = () => h.tasks().find((t) => t.directiveId === did && t.assigneeId === dev);
    await h.waitFor(() => taskOf()?.state === 'in_progress' && h.core.turns.isMemberRunning(dev) && cliSpoke(h, dev), { timeoutMs: 90_000, label: '작업 턴' });
    const task = taskOf()!;
    expect((await h.invoke('stop.emergency')).completed).toBe(true);

    h = box.v = await h.restart();
    const turnsAfterRestart = h.core.ctx.store.turns.list().length;
    expect(h.core.ctx.stop().global.active).toBe(true);
    // 정지 중에는 메인 에이전트의 긴급 지시도 거부된다 (앱 도구 정지 검사) — 대표가 팀원에게 직접 보내는 길은 없다 (v0.6)
    await expect(h.main('instruct_member', { member_id: dev, text: '이어서 진행해 주세요', urgent: true })).rejects.toMatchObject({ code: 'stopped' });
    await sleep(4500);
    expect(h.core.ctx.store.turns.list()).toHaveLength(turnsAfterRestart);

    await h.invoke('stop.release');
    // 보류 목록은 메인 에이전트에게 업무로 간다 — 모의 메인은 저절로 재개하지 않는다
    expect(h.core.ctx.store.queue.list({ ref2: 'main:general' }).filter((q) => q.kind === 'stop_released').map((q) => q.message.includes(task.id))).toEqual([true]);
    // 해제 뒤 온 메인 에이전트의 긴급 지시도 그 작업을 실행하지 않는다 (저장만)
    await h.main('instruct_member', { member_id: dev, text: '이어서 진행해 주세요', urgent: true });
    await sleep(4500);
    expect(taskTurns(h.core.ctx, task.id)).toHaveLength(1);
    expect(h.task(task.id).hold.reasons.map((r) => r.kind)).toEqual(['emergency_stop']);

    await h.main('resume_task', { task_id: task.id });
    await h.waitFor(() => h.task(task.id).state === 'done', { timeoutMs: 120_000, label: '재개한 작업 완료' });
    expect(taskTurns(h.core.ctx, task.id)[1]).toMatchObject({ isResume: true });
  }, 300_000);
});

// ═════════════════════════ AC-46 ═════════════════════════

describe('AC-46 검수 중 보류·취소, 대기 중 일시정지, 지시 전체 취소가 상태표대로 — 취소된 지시의 완료 작업·main 변경은 별도 되돌리기 전까지 유지', () => {
  it('AC-46: 검수 중 보류 — 실행 중이던 검수 턴을 끝내고 작업을 보류(복귀 상태 검수)하며, 재개하면 같은 검수 대상으로 검수로 돌아가 검수를 다시 넘긴다 (반려로 세지 않음)', async () => {
    const { v: e } = track(await bootOrch());
    const { task, proc } = await startReview(e, e.qaId);
    await e.main('interrupt_task', { task_id: task.id, then: 'hold' });
    expect(proc.terminatedByApp).toBe(true);
    await e.idle();
    const held = e.ctx.store.tasks.require(task.id);
    expect(holdOf(held)).toEqual({ state: 'on_hold', reasons: ['interrupted/task'], returnState: 'in_review' });
    expect(held.review.target).toEqual(task.review.target);
    e.hold.clear();
    await e.drain(2);
    expect(sessionTurns(e.ctx, reviewKey(task.id))).toHaveLength(1);

    await e.main('resume_task', { task_id: task.id });
    const back = e.ctx.store.tasks.require(task.id);
    expect(holdOf(back)).toEqual({ state: 'in_review', reasons: [], returnState: null });
    expect(back.review).toMatchObject({ target: task.review.target, rejectsInRound: 0, rejectsTotal: 0 });
    e.hold.add(reviewKey(task.id));
    e.tick();
    await waitFor(() => !!e.liveProc(reviewKey(task.id), e.qaId), '검수 다시 시작');
    expect(e.launches.filter((l) => l.workKey === reviewKey(task.id))).toHaveLength(2);
  });

  it('AC-46: 검수 중 취소 — 검수 턴을 끝내고, 중간 결과를 보관한 뒤 취소하고 작업 공간(작업 폴더·브랜치·검수 사본)을 정리한다. main은 바뀌지 않고 취소는 재개하지 않는다', async () => {
    const { v: e } = track(await bootOrch());
    const d = seedOrchDirective(e);
    const t = e.core.tasks.create(devTaskInput(d.id, e.devId, '검수 중 취소될 작업'), e.producerId);
    e.hold.add(taskKey(t.id));
    e.tick();
    await waitFor(() => !!e.liveProc(taskKey(t.id)), '작업 턴');
    const p = e.liveProc(taskKey(t.id))!;
    expect((await e.tool(p.turnId, 'set_steps', { steps: ['구현'] })).ok).toBe(true);
    writeFileSync(join(e.ctx.store.tasks.require(t.id).workspace!.worktreePath, 'feature.txt'), '기능\n', 'utf8');
    expect((await e.tool(p.turnId, 'complete_step', { step_index: 0, note: '완료' })).ok).toBe(true);
    expect((await e.tool(p.turnId, 'submit_for_review', { note: '제출' })).ok).toBe(true);
    p.finishOk();
    await waitFor(() => e.ctx.store.tasks.require(t.id).state === 'in_review', '검수로');
    const inReview = e.ctx.store.tasks.require(t.id);
    const copy = e.core.tasks.reviewCopyOf(inReview)!;
    expect(existsSync(copy)).toBe(true);
    const base = e.ctx.store.projects.require(e.projectId).baseBranch;
    const mainBefore = git(e.projectDir, ['rev-parse', `refs/heads/${base}`]);
    e.hold.add(reviewKey(t.id));
    e.tick();
    await waitFor(() => !!e.liveProc(reviewKey(t.id)), '검수 턴');
    const rp = e.liveProc(reviewKey(t.id))!;

    await e.main('interrupt_task', { task_id: t.id, then: 'cancel' });

    expect(rp.terminatedByApp).toBe(true);
    const c = e.ctx.store.tasks.require(t.id);
    expect(c.state).toBe('cancelled');
    expect(c.hold.reasons).toEqual([]);
    const archived = git(e.projectDir, ['rev-parse', '--verify', `refs/wook/archive/${t.id}-cancel`]);
    expect(git(e.projectDir, ['ls-tree', '-r', '--name-only', archived]).split(/\r?\n/)).toContain('feature.txt');
    expect(existsSync(inReview.workspace!.worktreePath)).toBe(false);
    expect(git(e.projectDir, ['branch', '--list', inReview.workspace!.branch])).toBe('');
    expect(existsSync(copy)).toBe(false);
    expect(git(e.projectDir, ['rev-parse', `refs/heads/${base}`])).toBe(mainBefore);
    expect(queuedIn(e.ctx, (q) => q.taskId === t.id || q.sessionKey === reviewKey(t.id) || q.sessionKey === taskKey(t.id))).toEqual([]);
    e.hold.clear();
    await e.drain(2);
    expect(e.launches.filter((l) => l.workKey === reviewKey(t.id) || l.workKey === taskKey(t.id))).toHaveLength(2);
    await expect(e.main('resume_task', { task_id: t.id })).rejects.toThrow();
  });

  it('AC-46: 대기 중 일시정지 — 대기 작업은 보류(복귀 상태 대기)되어 시작되지 않고, 재개하면 대기로 돌아가 정상적으로 시작된다', async () => {
    const { v: e } = track(await bootOrch());
    const d = seedOrchDirective(e);
    const t = e.core.tasks.create(devTaskInput(d.id, e.devId, '대기 작업'), e.producerId);
    await e.main('pause_member', { member_id: e.devId, mode: 'graceful' });
    expect(holdOf(e.ctx.store.tasks.require(t.id))).toEqual({ state: 'on_hold', reasons: ['paused/member'], returnState: 'waiting' });
    await e.drain(2);
    expect(e.launches.filter((l) => l.workKey === taskKey(t.id))).toEqual([]);
    expect(e.ctx.store.tasks.require(t.id)).toMatchObject({ workspace: null, activatedAt: null });

    await e.main('resume_member', { member_id: e.devId });
    expect(holdOf(e.ctx.store.tasks.require(t.id))).toEqual({ state: 'waiting', reasons: [], returnState: null });
    e.hold.add(taskKey(t.id));
    e.tick();
    await waitFor(() => !!e.liveProc(taskKey(t.id)), '재개 후 시작');
    expect(e.ctx.store.tasks.require(t.id).state).toBe('in_progress');
  });

  it('AC-46: 지시 전체 취소 — 미완료 작업(진행·대기·검수 통과 후 병합 대기)만 취소되고, 완료된 작업과 main 변경은 그대로 남으며 별도 되돌리기를 해야만 main에서 빠진다', async () => {
    const { v: env } = track(await reg.boot({ team: ['developer', 'developer'] }));
    const [m1, m2] = env.members;
    const base = env.project.baseBranch;
    const did = reg.newDirective(env, '취소할 지시');
    const done = await reg.passedTask(env, { directiveId: did, assignee: m1, reviewer: 'main', file: 'feature-a.txt', content: 'A\n', title: '완료될 작업' });
    const merged = await reg.mergeAndSettle(env, done.id);
    expect(merged.state).toBe('done');
    const passedOnly = await reg.passedTask(env, { directiveId: did, assignee: m1, reviewer: 'main', file: 'feature-b.txt', content: 'B\n', title: '병합 대기' });
    const running = await reg.activate(env, reg.newTask(env, { directiveId: did, assignee: m2, title: '진행 중' }).id);
    writeFileSync(join(running.workspace!.worktreePath, 'half.txt'), '중간 결과\n', 'utf8');
    const waiting = reg.newTask(env, { directiveId: did, assignee: m2, title: '대기', prerequisiteIds: [running.id] });
    const mainBefore = reg.mainSha(env);

    await env.core.directives.cancel(did, MAIN_AGENT_ID);

    expect(env.ctx.store.directives.require(did).state).toBe('cancelled');
    expect(env.ctx.store.tasks.require(done.id)).toMatchObject({ state: 'done', merge: merged.merge });
    for (const t of [passedOnly, running, waiting]) expect(env.ctx.store.tasks.require(t.id).state, t.title).toBe('cancelled');
    expect(reg.mainSha(env)).toBe(mainBefore);
    expect(reg.mergeCommitsFor(env, done.id)).toBe(1);
    expect(reg.mergeCommitsFor(env, passedOnly.id)).toBe(0);
    expect(reg.git(env.projectDir, ['show', `refs/heads/${base}:feature-a.txt`])).toBe('A');
    expect(reg.git(env.projectDir, ['rev-parse', '--verify', `refs/wook/archive/${running.id}-cancel`])).toMatch(/^[0-9a-f]{40}$/);
    expect(reg.queued(env, (q) => q.directiveId === did || q.sessionKey === directiveKey(did))).toEqual([]);

    // 별도 되돌리기: 되돌리기 작업 → 자동 검사·검수 → 병합 때에만 main에서 빠진다
    const r = await env.core.merges.requestRevert(done.id, env.producer, '취소된 지시의 변경 되돌리기');
    expect(r.mode).toBe('revert_task');
    const rt = r.revertTaskId!;
    await reg.waitFor(() => env.ctx.store.tasks.require(rt).state === 'in_review', '되돌리기 작업 검수');
    reg.pass(env, rt);
    expect((await reg.mergeAndSettle(env, rt)).state).toBe('done');
    expect(() => reg.git(env.projectDir, ['show', `refs/heads/${base}:feature-a.txt`])).toThrow();
    expect(env.ctx.store.tasks.require(done.id)).toMatchObject({ state: 'done', revertedByTaskId: rt });
  });

  it('AC-46: 확인 대기 중인 지시를 취소해도 완료된 작업·보고서·main 병합은 그대로 남는다 (실제 모의 에이전트)', async () => {
    const { v: h } = track(await createHarness({ team: ['developer', 'qa'] }));
    const did = await sendCommand(h, '로그인 화면을 만들어 줘');
    await h.waitFor(() => h.core.ctx.store.directives.get(did)?.state === 'awaiting_confirmation', { timeoutMs: 180_000, label: '확인 대기' });
    const tasks = h.tasks().filter((t) => t.directiveId === did);
    expect(tasks.length).toBeGreaterThan(0);
    const reports = h.core.ctx.store.reports.list({ ref1: did }).map((r) => r.id);
    expect(reports).toHaveLength(1);
    const mainBefore = git(h.projectDir, ['rev-parse', 'refs/heads/main']);

    await h.main('cancel_directive', { directive_id: did });

    expect(h.core.ctx.store.directives.require(did).state).toBe('cancelled');
    for (const t of tasks) expect(h.task(t.id).state, t.id).toBe('done');
    expect(h.core.ctx.store.reports.list({ ref1: did }).map((r) => r.id)).toEqual(reports);
    expect(git(h.projectDir, ['rev-parse', 'refs/heads/main'])).toBe(mainBefore);
    const merges = git(h.projectDir, ['log', '--merges', '--format=%s', 'refs/heads/main']);
    for (const t of tasks.filter((x) => x.outputMode === 'repo')) expect(merges).toContain(`[${t.id}] 병합`);
  }, 240_000);

  it('AC-46: 실제 흐름에서 지시 전체 취소 — 병합된 작업은 완료로 남고 main 변경도 유지되며, 진행 중이던 작업은 CLI를 끝내고 취소된다 (실제 모의 에이전트)', async () => {
    const { v: h } = track(await createHarness({ team: ['developer', 'developer'] }));
    await h.internal('members.update', h.members.developer2!, { mockScenario: 'hang' });
    const did = await sendCommand(h, '로그인 화면과 회원가입 화면을 만들어 줘');
    const [d1, d2] = [h.members.developer!, h.members.developer2!];
    const taskOf = (m: string) => h.tasks().find((t) => t.directiveId === did && t.assigneeId === m);
    await h.waitFor(() => taskOf(d1)?.state === 'done' && taskOf(d2)?.state === 'in_progress' && h.core.turns.isMemberRunning(d2) && cliSpoke(h, d2), { timeoutMs: 150_000, label: '하나는 병합 완료, 하나는 진행 중' });
    const done = taskOf(d1)!;
    const running = taskOf(d2)!;
    const mainBefore = git(h.projectDir, ['rev-parse', 'refs/heads/main']);
    const runningPid = taskTurns(h.core.ctx, running.id)[0]!.process.pid!;

    const cancelAt = Date.now();
    await h.main('cancel_directive', { directive_id: did });

    expect(h.core.ctx.store.directives.require(did).state).toBe('cancelled');
    expect(h.task(done.id).state).toBe('done');
    expect(git(h.projectDir, ['log', '--merges', '--format=%s', 'refs/heads/main'])).toContain(`[${done.id}] 병합`);
    expect(git(h.projectDir, ['rev-parse', 'refs/heads/main'])).toBe(mainBefore);
    expect(h.task(running.id).state).toBe('cancelled');
    expect(taskTurns(h.core.ctx, running.id).map((t) => t.endReason)).toEqual(['user_stop']);
    expect(stillRunning([runningPid], cancelAt)).toEqual([]);
    // 취소된 지시의 업무는 더 실행되지 않는다 (예약된 턴 취소, TSK-09)
    const directiveTurns = () => h.core.ctx.store.turns.list().filter((t) => t.directiveId === did).length;
    const after = directiveTurns();
    await sleep(4500);
    expect(directiveTurns()).toBe(after);
    expect(queuedIn(h.core.ctx, (q) => q.directiveId === did || q.sessionKey === directiveKey(did) || q.taskId === running.id)).toEqual([]);
  }, 240_000);

  it('AC-46: 검수 통과 후 병합 대기 중 보류 — 보류 중에는 병합되지 않고, 재개하면 통과 기록을 그대로 둔 검수 상태로 돌아가 병합 판단부터 다시 해 병합된다', async () => {
    const { v: env } = track(await reg.boot({ team: ['developer'] }));
    const [m1] = env.members;
    const did = reg.newDirective(env, '병합 대기 보류');
    const t = await reg.passedTask(env, { directiveId: did, assignee: m1!, reviewer: 'main', file: 'feature.txt', content: 'F\n', title: '병합 대기' });
    reg.consumeMergeDecisions(env, t.id);
    const mainBefore = reg.mainSha(env);

    await env.core.tasks.interrupt(t.id, 'hold', MAIN_AGENT_ID);

    expect(holdOf(env.ctx.store.tasks.require(t.id))).toEqual({ state: 'on_hold', reasons: ['interrupted/task'], returnState: 'in_review' });
    expect(() => env.core.merges.requestMerge(t.id, env.producer, null)).toThrow(/검수 상태가 아닙니다/);
    expect(reg.mainSha(env)).toBe(mainBefore);
    env.core.tasks.resumeByOwner(t.id, MAIN_AGENT_ID);
    const back = env.ctx.store.tasks.require(t.id);
    expect(holdOf(back)).toEqual({ state: 'in_review', reasons: [], returnState: null });
    expect(back.review.passed).toEqual(t.review.passed);
    expect(back.review).toMatchObject({ rejectsInRound: 0, rejectsTotal: 0 });
    expect(reg.queued(env, (q) => q.kind === 'merge_decision' && q.taskId === t.id)).toHaveLength(1);
    expect((await reg.mergeAndSettle(env, t.id)).state).toBe('done');
    expect(reg.mergeCommitsFor(env, t.id)).toBe(1);
  });

  it('AC-46: 지시 전체 취소가 진행되는 동안 아직 끝나지 않은 프로듀서 턴이 만든 작업도 취소되어야 한다 — 취소된 지시에 미완료 작업이 남거나 나중에 실행되면 안 된다 (가짜 CLI)', async () => {
    const { v: e } = track(await bootOrch());
    const d = seedOrchDirective(e);
    const running = e.core.tasks.create(devTaskInput(d.id, e.devId, '진행 중'), e.producerId);
    e.hold.add(taskKey(running.id));
    e.hold.add(directiveKey(d.id));
    enqueue(e.ctx, { kind: 'message', memberId: e.producerId, sessionKey: directiveKey(d.id), projectId: e.projectId, directiveId: d.id, message: '작업을 더 나눠 주세요' });
    e.tick();
    await waitFor(() => !!e.liveProc(taskKey(running.id)) && !!e.liveProc(directiveKey(d.id)), '작업 턴·프로듀서 턴');
    const producerTurn = e.liveProc(directiveKey(d.id))!.turnId;

    // 대표가 지시를 취소한다. 취소가 진행 중인 작업을 끝내고 결과를 보관·정리하는 동안, 프로듀서 CLI가 이미 보낸 앱 도구 요청이 도착한다
    const cancelling = e.main('cancel_directive', { directive_id: d.id });
    const created = await e.tool(producerTurn, 'create_task', {
      directive_id: d.id,
      title: '취소 중에 만든 작업',
      goal: '취소 중에 만든 작업',
      type: 'test',
      assignee_id: e.qaId,
      acceptance_criteria: ['동작한다'],
      output_mode: 'repo',
    });
    await cancelling;
    await e.idle();

    expect(e.ctx.store.directives.require(d.id).state).toBe('cancelled');
    expect(e.ctx.store.tasks.require(running.id).state).toBe('cancelled');
    e.hold.clear();
    e.tick();
    await e.idle();
    const open = e.ctx.store.tasks.list({ ref1: d.id }).filter((t) => !isTerminal(t.state));
    const createdNote = created.ok ? `create_task 성공 → ${(created.data as { taskId: string }).taskId}` : `create_task 거부(${created.code})`;
    expect.soft(open.map((t) => `${t.id}:${t.state}`), `취소된 지시 ${d.id}에 남은 미완료 작업 (${createdNote})`).toEqual([]);
    const ranAfter = e.launches.filter((l) => l.workKey.startsWith('task:') && l.workKey !== taskKey(running.id));
    expect.soft(ranAfter.map((l) => l.workKey), `취소된 지시 ${d.id}의 작업에 지시 취소 뒤 CLI 턴이 실행됨`).toEqual([]);
  });

  it('AC-46: 실제 흐름 — 프로듀서가 계획(작업 생성) 중일 때 지시를 취소하면, 그 뒤에 작업이 실행·병합되어 main이 바뀌거나 미완료 작업이 남으면 안 된다 (실제 모의 에이전트)', async () => {
    const { v: h } = track(await createHarness({ team: ['developer', 'developer', 'developer', 'qa'] }));
    const before = new Set(h.core.ctx.store.directives.list().map((d) => d.id));
    await h.invoke('command.send', { target: h.projectId, text: '로그인·회원가입·설정 화면과 테스트를 만들어 줘' });
    let did = '';
    // 프로듀서의 계획 턴이 첫 작업을 만든 직후 (아직 나머지 작업을 만드는 중)
    await h.waitFor(
      () => {
        const d = h.core.ctx.store.directives.list().find((x) => !before.has(x.id));
        if (d) did = d.id;
        return !!d && h.core.ctx.store.tasks.list({ ref1: d.id }).length >= 1;
      },
      { timeoutMs: 60_000, intervalMs: 5, label: '첫 작업 생성' },
    );
    const atCancel = h.core.ctx.store.tasks.list({ ref1: did }).map((t) => `${t.id}:${t.state}`);

    await h.main('cancel_directive', { directive_id: did });

    const mainAtCancel = git(h.projectDir, ['rev-parse', 'refs/heads/main']);
    const afterCancel = h.core.ctx.store.tasks.list({ ref1: did }).map((t) => `${t.id}:${t.state}`);
    const turnsAtCancel = h.core.ctx.store.turns.list().length;
    expect(h.core.ctx.store.directives.require(did).state).toBe('cancelled');
    await sleep(8000); // 스케줄러 2초 주기 여러 번 — 남은 작업이 있으면 실행·검수·병합까지 갈 시간
    const tasks = h.core.ctx.store.tasks.list({ ref1: did });
    const open = tasks.filter((t) => !isTerminal(t.state)).map((t) => `${t.id}:${t.state}(${t.hold.reasons.map((r) => r.kind).join('+')})`);
    const later = h.core.ctx.store.turns
      .list()
      .slice(turnsAtCancel)
      .filter((t) => t.directiveId === did)
      .map((t) => `${t.id}:${t.sessionKind}:${t.taskId ?? '-'}`);
    const merged = git(h.projectDir, ['log', '--merges', '--format=%s', `${mainAtCancel}..refs/heads/main`]);
    const ctxNote = `취소 시점 작업 [${atCancel.join(', ')}] → 취소 직후 [${afterCancel.join(', ')}] → 8초 뒤 [${tasks.map((t) => `${t.id}:${t.state}`).join(', ')}]`;
    expect.soft(later, `지시 취소 뒤 이 지시의 턴이 실행됨 — ${ctxNote}`).toEqual([]);
    expect.soft(merged ? merged.split(/\r?\n/) : [], `지시 취소 뒤 main에 병합됨 — ${ctxNote}`).toEqual([]);
    expect.soft(open, `취소된 지시에 미완료 작업이 남음 — ${ctxNote}`).toEqual([]);
  }, 120_000);
});
