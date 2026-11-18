/**
 * 메인 도구가 기다린 뒤에는 상태를 바꾸기 전에 부른 쪽을 다시 본다 (리드 결정 S5-63 — S5F9가 KNOWN_ISSUES에 적은 '세대가 지난 호출' 갈래를 닫는다).
 * - 처리기는 부를 때만 자리 세대(seat_changed)와 정지를 본다. 처리 중의 기다림(프로듀서 교체의 정지 확인, 복구 확인의 git.log, 스킬 찾기, CLI 확인, 프로젝트 등록의
 *   저장소 확인, 서버 명령의 러너 준비) 뒤 처음 상태를 바꾸기 전에 다시 본다: 그 호출을 받은 세대를 자리가 더는 받지 않으면 S4-4의 seat_changed, 아니면 부른 메인 턴이
 *   끝났거나 종료 요청을 받았으면 stopped — 그리고 아무것도 더 바꾸지 않는다
 * - 프로듀서 교체는 이미 그 턴을 멈춘 뒤라 거부 글이 그것을 말하고, 그 프로듀서는 팀원 정지처럼 턴만 멈춘 채 그대로다 — 멈춘 관리 업무는 잃지 않고 현황에 보인다
 * - 운영자·시험 신원(메인 턴 기록·세대가 없음)은 다시 보지 않는다
 * - replace_producer가 멈춘 뒤에 거부하면(다시 보기, 다른 교체가 먼저 끝남, 그사이 모델 목록이 바뀜 등 어느 거부든) 멈춘 일을 남기지 않고 거부 글이 그 결과를 쓴다
 *   (리드 결정 S5-73·S5-80 2). 다시 맡기는 길은 보류 해제와 같다 — 병합 충돌·제출·되돌리기가 남은 작업은 그 갈래로 (리드 결정 S5-82 2)
 * - 멈춘 턴의 마무리가 상한을 넘기면 거부 글은 지금 확실한 것과 끝나면 할 수 있는 일을 모두 쓰고 어느 하나를 약속하지 않는다 (리드 결정 S5-84). 쉬는 프로듀서를
 *   두 호출이 함께 바꾸면 진 쪽은 꼬리 없는 conflict 글 그대로다 (리드 결정 S5-88 2)
 * - 같은 프로듀서를 바꾸는 다른 교체 요청이 아직 진행 중일 때 거부하면 '프로듀서는 그대로'·'같은 프로듀서'라고 하지 않고 그 요청이 진행 중이라는 것만 쓰며, 멈춘
 *   일은 그 요청이 정한다(바꾸면 교체와 함께, 바꾸지 않고 끝나면 같은 프로듀서에게). 이미 통과 판정을 낸 검수의 거부 글은 판정이 넣은 병합 판단을 쓴다. 다른
 *   교체 없이 재배정·검수자 변경이 된 일에는 같은 프로듀서의 셋을 쓰지 않는다 (리드 결정 S5-90 1·2·4)
 * 프로브 server-s5fix5-alerts-flows/zz-s5af6-stalereplace, server-s5fix7-alerts-flows/zz-s5af8-recheckleft, server-s5fix7-tests-integrity/zz-s5f7ti-*,
 * server-s5fix8-alerts-flows/zz-s5af9-unsettled, server-s5fix8-tests-integrity/zz-s5f8ti-idle-replace, server-s5fix9-alerts-flows/zz-s5af10r-flows·zz-s5af10-inflight·
 * zz-s5af10-corners, server-s5fix9-tests-integrity/zz-s5f9ti-reassigned-unsettled에서.
 * 가짜 프로세스만, 실제 키 없음
 */
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAIN_AGENT_ID, type AiConfig, type ExecRecord } from '@shared/domain';
import { TASK_STATE_LABEL } from '@shared/labels';
import type { ToolCallResult } from '../../src/main/mcp/types';
import type { ProcessRunner } from '../../src/main/process/types';
import { alertKey } from '../../src/main/orchestrator/alerts';
import { directiveKey, enqueue, mainKey, reviewKey, taskKey } from '../../src/main/orchestrator/records';
import type { FakeProc, OrchEnv } from './orchHarness';
import { bootOrch, seedDirective, sleep, startReview, waitFor } from './orchHarness';

let env: OrchEnv | null = null;
const dirs: string[] = [];
/** 시험이 붙잡은 문(정지·마무리·기다림) — 단언이 먼저 실패해도 정리 전에 모두 연다(붙잡힌 턴 때문에 정리가 시간을 넘기고 실행 폴더가 남지 않게) */
const gates: (() => void)[] = [];
afterEach(async () => {
  for (const open of gates.splice(0)) open();
  vi.restoreAllMocks();
  env?.hold.clear();
  await env?.close();
  env = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const CODEX: AiConfig = { kind: 'codex', model: null, effortTier: 'high', effortOverride: null };
/** S4-4의 seat_changed 글 (세대 1 → 2) */
const seatChanged = (tool: string) => `메인 자리가 바뀌었습니다 (이 턴은 세대 1, 지금은 세대 2) — 이 요청(${tool})은 처리하지 않았습니다. 지금 턴을 마치세요`;
/** 기다리는 사이 부른 턴이 끝났을 때의 거부 첫머리 */
const turnGone = (tool: string) => `처리하며 기다리는 사이 이 턴이 끝났거나 종료 요청을 받아 ${tool}은(는) 처리하지 않았습니다. 지금 턴을 마치세요`;

/** 그 세션 키의 메인 턴을 띄워 붙잡는다 — 대표 명령 하나를 싣는다 */
async function mainTurnUp(e: OrchEnv, key = mainKey(null)): Promise<FakeProc> {
  e.hold.add(key);
  const pid = key === mainKey(null) ? null : key.slice('main:'.length);
  enqueue(e.ctx, { kind: 'main_command', memberId: MAIN_AGENT_ID, sessionKey: key, projectId: pid, priority: 'high', message: '대표 명령 (시험):\n정리해 줘' });
  await waitFor(
    () => {
      if (!e.liveProc(key, MAIN_AGENT_ID)) e.tick();
      return !!e.liveProc(key, MAIN_AGENT_ID);
    },
    `메인 턴 ${key}`,
    30_000,
  );
  return e.liveProc(key, MAIN_AGENT_ID)!;
}

/** obj[method]를 문으로 붙잡는다 — 부르면 문이 열릴 때까지 기다린 뒤 원래 것을 부른다 */
function gateOn(obj: object, method: string): { called: () => boolean; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  gates.push(() => release());
  let n = 0;
  const target = obj as Record<string, (...a: unknown[]) => unknown>;
  const orig = target[method]!.bind(obj);
  vi.spyOn(target, method).mockImplementation(async (...args: unknown[]) => {
    n++;
    await gate;
    return orig(...args);
  });
  return { called: () => n > 0, release };
}

/** 운영자가 메인 자리를 codex로 강제로 바꾸고 새 세대가 앉을 때까지 기다린다 — 부른 턴은 멈춘다 */
async function forceSwap(e: OrchEnv, turnKey: string): Promise<{ done: Promise<void> }> {
  const swap = e.core.seat.assign({ holder: { kind: 'launched', ai: CODEX }, by: 'operator', reason: '시험 교체', force: true });
  await waitFor(() => !e.liveProc(turnKey, MAIN_AGENT_ID) && e.core.seat.generation() === 2, '자리 교체(세대 2)와 부른 턴의 끝', 30_000);
  return swap;
}

/** 프로듀서의 지시 관리 턴을 띄우고 그 종료 확인을 문으로 붙잡는다 */
async function producerTurnGated(e: OrchEnv): Promise<{ dk: string; proc: FakeProc; stopCalled: () => boolean; stops: () => number; openStop: () => void }> {
  const d = seedDirective(e);
  const dk = directiveKey(d.id);
  e.hold.add(dk);
  enqueue(e.ctx, { kind: 'message', memberId: e.producerId, sessionKey: dk, projectId: e.projectId, directiveId: d.id, message: '진행 상황을 정리해 주세요 (시험)' });
  await waitFor(
    () => {
      if (!e.liveProc(dk, e.producerId)) e.tick();
      return !!e.liveProc(dk, e.producerId);
    },
    '프로듀서 관리 턴',
  );
  const proc = e.liveProc(dk, e.producerId)!;
  let openStop!: () => void;
  const stopGate = new Promise<void>((r) => (openStop = r));
  gates.push(() => openStop());
  let n = 0;
  (proc as unknown as { terminate: () => Promise<unknown> }).terminate = async () => {
    n++;
    proc.terminatedByApp = true;
    await stopGate; // 종료 확인이 걸린다 (graceful kill, 최대 STOP_CONFIRM_MS)
    proc.exit(null, { terminated: true });
    return { ok: true, remaining: 0, detail: '가짜 종료', durationMs: 2500 };
  };
  return { dk, proc, stopCalled: () => n > 0, stops: () => n, openStop };
}

/** 프로듀서 교체가 멈춘 뒤의 그 프로듀서 — 지우지 않았고 프로듀서 그대로, 멈춘 관리 업무는 잃지 않고 현황에 보인다 */
async function producerKept(e: OrchEnv, old: string, dk: string): Promise<void> {
  expect(e.ctx.store.projects.require(e.projectId).producerId).toBe(old);
  expect(e.ctx.store.members.require(old)).toMatchObject({ deletedAt: null, isProducer: true });
  // 팀원 정지(stopMember)처럼 턴만 멈췄다 — 일시정지는 걸지 않는다
  expect(e.ctx.stop().members[old]).toBeUndefined();
  // 멈춘 관리 업무는 그 턴의 판정이 다시 넣어 그 프로듀서가 잇는다(대기 또는 다시 뜬 턴)
  await waitFor(() => e.ctx.store.queue.list({ ref1: old, state: ['queued', 'running'] }).some((q) => q.sessionKey === dk), '멈춘 관리 업무를 다시 넣음');
  const ov = e.core.overview.build({ detail: true });
  const block = ov.projects.items.find((p) => p.id === e.projectId)!;
  expect(block.producer?.memberId).toBe(old);
  const mine = block.members.items.find((m) => m.memberId === old)!;
  expect(mine.isProducer).toBe(true);
  expect(mine.queued + block.running.items.filter((r) => r.memberId === old).length).toBeGreaterThan(0);
  expect(ov.stop.pausedMembers.map((m) => m.memberId)).not.toContain(old);
}

describe('replace_producer — 그 프로듀서의 정지를 기다리는 사이 (리드 결정 S5-63, 프로브 zz-s5af6-stalereplace)', () => {
  it('G. 운영자가 자리를 강제로 바꾸면(세대 1 → 2) 세대 1의 호출은 바꾸지 않는다 — seat_changed(S4-4의 글 + 이미 멈춘 턴), 프로듀서는 그대로이고 그 일은 잃지 않는다', async () => {
    const e = (env = await bootOrch());
    const old = e.producerId;
    const name = e.ctx.store.members.require(old).name;
    const { dk, stopCalled, openStop } = await producerTurnGated(e);
    const mp = await mainTurnUp(e);
    expect(e.identity(mp.turnId).seatGeneration).toBe(1);
    const call = e.tool(mp.turnId, 'replace_producer', { project_id: e.projectId, reason: '프로듀서가 멈춤 (시험)' });
    await waitFor(stopCalled, 'replace_producer가 그 프로듀서의 정지를 기다림');
    const swap = await forceSwap(e, mainKey(null));
    // 교체가 끝난 뒤(세대 2가 앉음)에 정지가 확인된다 — 정지 확인은 최대 몇 초 걸린다
    await swap.done;
    openStop();
    const r = await call;
    const already = `프로듀서 ${name}(${old})의 턴은 이미 멈췄습니다 — 프로듀서는 그대로이고, 멈춘 관리 업무는 다시 대기열에 들어가 그 프로듀서가 잇습니다`;
    expect(r).toEqual({ ok: false, code: 'seat_changed', message: `${seatChanged('replace_producer')} (${already})` });
    // 늦게 안 자리 교체의 기록은 메인 에이전트의 줄이고(리드 결정 S5-77 2), 이미 한 일을 거부 글과 같은 글로 남긴다(리드 결정 S5-73 3)
    const rows = e.ctx.store.activity.search({ text: '이전 세대(1) 메인 토큰의 도구 요청을 거부함: replace_producer (처리하며 기다리는 사이 자리가 바뀜)', limit: 5 });
    expect(rows.map((a) => a.memberId)).toEqual([MAIN_AGENT_ID]);
    expect(rows[0]!.text).toContain(`(${already})`);
    await producerKept(e, old, dk);
  });

  it('부른 메인 턴이 자리 교체 없이 끝나도(비정상 종료) 바꾸지 않는다 — stopped, 프로듀서는 그대로', async () => {
    const e = (env = await bootOrch());
    const old = e.producerId;
    const { dk, stopCalled, openStop } = await producerTurnGated(e);
    const mp = await mainTurnUp(e);
    const call = e.tool(mp.turnId, 'replace_producer', { project_id: e.projectId, reason: '프로듀서가 멈춤 (시험)' });
    await waitFor(stopCalled, 'replace_producer가 그 프로듀서의 정지를 기다림');
    mp.exit(1);
    await waitFor(() => !!e.ctx.store.turns.require(mp.turnId).endedAt, '부른 메인 턴이 끝남');
    openStop();
    const r = await call;
    expect(e.core.seat.generation()).toBe(1);
    expect(!r.ok && r.code).toBe('stopped');
    expect(!r.ok && r.message.startsWith(turnGone('replace_producer'))).toBe(true);
    expect(!r.ok && r.message).toContain('의 턴은 이미 멈췄습니다');
    // 그 기록은 메인 에이전트의 줄이다 — 스튜디오는 memberId로 메인의 활동을 고른다 (리드 결정 S5-77 2)
    expect(e.ctx.store.activity.search({ text: `메인 턴 ${mp.turnId}이(가) 처리하며 기다리는 사이 끝났거나 종료 요청을 받아 replace_producer을(를) 마치지 않음`, limit: 5 }).map((a) => a.memberId)).toEqual([MAIN_AGENT_ID]);
    await producerKept(e, old, dk);
  });

  it('운영자 신원은 다시 보지 않는다 — 같은 기다림 사이 자리가 바뀌어도 교체한다', async () => {
    const e = (env = await bootOrch());
    const old = e.producerId;
    const { stopCalled, openStop } = await producerTurnGated(e);
    const mp = await mainTurnUp(e);
    const call = e.main('replace_producer', { project_id: e.projectId, reason: '운영자 교체 (시험)' });
    await waitFor(stopCalled, 'replace_producer가 그 프로듀서의 정지를 기다림');
    const swap = await forceSwap(e, mainKey(null));
    openStop();
    expect(await call).toMatchObject({ projectId: e.projectId, previousProducerId: old });
    await swap.done;
    expect(e.ctx.store.members.require(old).deletedAt).toBeTruthy();
    expect(mp.turnId).toBeTruthy();
  });

  it('같은 프로듀서를 두 호출이 함께 바꾸면 하나만 바꾼다 — 정지를 기다리는 사이 다른 교체가 먼저 끝났으면 conflict, 남는 프로듀서는 하나. 그 거부도 멈춘 턴과 그 일이 간 곳을 쓴다 (리드 결정 S5-80 2)', async () => {
    const e = (env = await bootOrch());
    const old = e.producerId;
    const oldName = e.ctx.store.members.require(old).name;
    const { dk, stops, openStop } = await producerTurnGated(e);
    const call = (reason: string) =>
      e.main('replace_producer', { project_id: e.projectId, reason }).then(
        (data) => ({ ok: true as const, data, code: null, message: null }),
        (x: Error & { code?: string }) => ({ ok: false as const, data: null, code: x.code ?? 'error', message: x.message }),
      );
    const a = call('교체 A (시험)');
    await waitFor(() => stops() >= 1, '첫 교체가 정지를 기다림');
    const b = call('교체 B (시험)');
    await waitFor(() => stops() >= 2, '둘째 교체도 정지를 기다림');
    openStop();
    const both = await Promise.all([a, b]);
    expect(both.map((r) => r.ok).sort()).toEqual([false, true]);
    const refused = both.find((r) => !r.ok)!;
    const now = e.ctx.store.projects.require(e.projectId).producerId;
    const heir = `${e.ctx.store.members.require(now).name}(${now})`;
    expect(refused.code).toBe('conflict');
    // 거부한 쪽도 그 턴을 멈췄다 — 그 사실과, 멈춘 관리 업무가 간 곳(새 프로듀서)을 쓴다. '프로듀서는 그대로'라고 하지 않는다 (리드 결정 S5-80 2 — 예전 글은 이 꼬리가 없었다)
    expect(refused.message).toBe(
      `프로젝트 ${e.projectId}의 프로듀서가 그사이 이미 바뀌었습니다 (${heir}) — 지금 프로듀서를 확인하세요 ` +
        `(프로듀서 ${oldName}(${old})의 턴은 이미 멈췄습니다 — 프로듀서는 그사이 ${heir}(으)로 바뀌었고, 멈춘 관리 업무는 다시 대기열에 들어가 새 프로듀서 ${heir}이(가) 잇습니다)`,
    );
    const producers = e.ctx.store.members.list({ project_id: e.projectId }).filter((m) => m.isProducer && !m.deletedAt);
    expect(producers.map((m) => m.id)).toEqual([now]);
    expect(e.ctx.store.members.require(old).deletedAt).toBeTruthy();
    // 멈춘 관리 업무는 남지 않았다 — 새 프로듀서 앞에 있다
    const onKey = e.ctx.store.queue.list({ ref2: dk, state: ['queued', 'running'] });
    expect(onKey.length).toBeGreaterThan(0);
    expect([...new Set(onKey.map((q) => q.memberId))]).toEqual([now]);
  });

  it('쉬는 프로듀서를 두 호출이 함께 바꾸면 — 둘 다 멈춘 것이 없고 하나만 바꾸며, 다른 하나는 꼬리 없는 conflict 글 그대로다(멈춘 턴이 없으면 이미 멈췄다고 하지 않는다) (리드 결정 S5-88 2, 프로브 zz-s5f8ti-idle-replace)', async () => {
    const e = (env = await bootOrch());
    const old = e.producerId;
    // 그 프로듀서는 쉰다 — 살아 있는 턴이 없으니 교체는 아무것도 멈추지 않는다
    expect(e.ctx.store.turns.list({ ref1: old }).filter((t) => !t.endedAt)).toEqual([]);
    const stopSpy = vi.spyOn(e.core.turns, 'stopMember');
    const call = (reason: string) =>
      e.main('replace_producer', { project_id: e.projectId, reason }).then(
        () => null,
        (x: Error & { code?: string }) => ({ code: x.code ?? 'error', message: x.message }),
      );
    const both = await Promise.all([call('교체 A (시험)'), call('교체 B (시험)')]);
    // 두 호출 모두 그 프로듀서를 멈추려 했고 둘 다 멈춘 것이 없다
    const stopped = await Promise.all(stopSpy.mock.results.map((r) => r.value as Promise<unknown[]>));
    expect(stopped.map((s) => s.length)).toEqual([0, 0]);
    expect(both.filter((r) => r === null)).toHaveLength(1);
    const refused = both.find((r) => r !== null)!;
    const now = e.ctx.store.projects.require(e.projectId).producerId;
    expect(now).not.toBe(old);
    expect(e.ctx.store.members.list({ project_id: e.projectId }).filter((m) => m.isProducer && !m.deletedAt).map((m) => m.id)).toEqual([now]);
    expect(refused).toEqual({ code: 'conflict', message: `프로젝트 ${e.projectId}의 프로듀서가 그사이 이미 바뀌었습니다 (${e.ctx.store.members.require(now).name}(${now})) — 지금 프로듀서를 확인하세요` });
    expect(refused.message).not.toContain('이미 멈췄습니다');
  });

  for (const kind of ['task', 'review'] as const) {
    it(`두 교체가 함께 프로듀서의 ${kind === 'task' ? '작업' : '검수'} 턴을 멈추고 하나만 바꾸면 — 다른 하나의 거부 글은 그 일이 간 곳(${kind === 'task' ? '재배정' : '새 검수자'})을 쓰고, 멈춘 일은 남지 않는다 (리드 결정 S5-80 2)`, async () => {
      const e = (env = await bootOrch());
      const old = e.producerId;
      const oldName = e.ctx.store.members.require(old).name;
      let taskId: string;
      let key: string;
      let proc: FakeProc;
      if (kind === 'task') ({ taskId, key, proc } = await producerTaskTurnUp(e));
      else {
        const started = await startReview(e, old);
        taskId = started.task.id;
        key = reviewKey(taskId);
        proc = started.proc;
      }
      const since = e.launches.length;
      const g = gateTerminate(proc, { ok: true, remaining: 0, detail: '가짜 종료' });
      const call = (reason: string) =>
        e.main('replace_producer', { project_id: e.projectId, reason }).then(
          (data) => ({ ok: true as const, data, code: null, message: null }),
          (x: Error & { code?: string }) => ({ ok: false as const, data: null, code: x.code ?? 'error', message: x.message }),
        );
      const a = call('교체 A (시험)');
      await waitFor(() => g.count() >= 1, '첫 교체가 정지를 기다림');
      const b = call('교체 B (시험)');
      await waitFor(() => g.count() >= 2, '둘째 교체도 정지를 기다림');
      g.open();
      const both = await Promise.all([a, b]);
      expect(both.map((r) => r.ok).sort()).toEqual([false, true]);
      const refused = both.find((r) => !r.ok)!;
      const now = e.ctx.store.projects.require(e.projectId).producerId;
      const who = (id: string) => `${e.ctx.store.members.require(id).name}(${id})`;
      const t = e.ctx.store.tasks.require(taskId);
      // 실제 상태 — 이긴 교체가 그 일을 넘겼다: 작업은 새 프로듀서에게 재배정, 검수는 다시 고른 검수자에게
      if (kind === 'task') expect(t.assigneeId).toBe(now);
      else expect(t.reviewerId).not.toBe(old);
      const where =
        kind === 'task'
          ? `멈춘 작업 ${taskId}은(는) ${who(t.assigneeId)}에게 재배정됐습니다 (작업 상태: ${TASK_STATE_LABEL[t.state]})`
          : `멈춘 검수(작업 ${taskId})는 검수자 ${who(t.reviewerId!)}에게 넘어갔습니다`;
      expect(refused.code).toBe('conflict');
      expect(refused.message).toBe(
        `프로젝트 ${e.projectId}의 프로듀서가 그사이 이미 바뀌었습니다 (${who(now)}) — 지금 프로듀서를 확인하세요 ` +
          `(프로듀서 ${oldName}(${old})의 턴은 이미 멈췄습니다 — 프로듀서는 그사이 ${who(now)}(으)로 바뀌었고, ${where})`,
      );
      // 이전 프로듀서에게 다시 맡기지 않았고, 그 일은 넘겨받은 쪽의 턴으로 다시 뜬다
      expect(e.ctx.store.activity.search({ text: '프로듀서 교체를 하지 않아', limit: 20 })).toEqual([]);
      expect(e.ctx.store.queue.list({ ref2: key, state: ['queued', 'running'] }).filter((q) => q.memberId === old)).toEqual([]);
      expect(await relaunchedOn(e, key, since)).toEqual([kind === 'task' ? now : t.reviewerId]);
    });
  }

  for (const how of ['catalog', 'store-error'] as const) {
    it(`${how === 'catalog' ? '기다리는 사이 운영 설정의 모델 목록이 바뀌어' : '바꾸는 트랜잭션이 저장 오류로'} 멈춘 뒤에 거부해도 — 멈춘 작업 턴을 같은 프로듀서에게 다시 맡기고, 거부 글이 그 턴을 멈췄다는 사실과 그 결과를 단다 (리드 결정 S5-80 2)`, async () => {
      const e = (env = await bootOrch());
      const old = e.producerId;
      const name = e.ctx.store.members.require(old).name;
      const membersBefore = e.ctx.store.members.list().length;
      const { taskId, key, proc } = await producerTaskTurnUp(e);
      const since = e.launches.length;
      const g = gateTerminate(proc, { ok: true, remaining: 0, detail: '가짜 종료' });
      // 멈추기 전의 검사는 지난다 — 그때 'opus'는 모델 목록에 있다
      const call = e.main('replace_producer', { project_id: e.projectId, reason: '프로듀서 교체 (시험)', ai_kind: 'claude', model: 'opus', effort_tier: 'high' }).then(
        () => null,
        (x: Error & { code?: string }) => ({ code: x.code, message: x.message }),
      );
      await waitFor(g.called, 'replace_producer가 그 프로듀서의 정지를 기다림');
      if (how === 'catalog') {
        await e.internal('settings.update', { team: { modelCatalog: { claude: [{ id: 'sonnet', label: 'Sonnet', note: '' }], codex: [{ id: 'gpt-6-sol', label: 'GPT-6 Sol', note: '' }] } } });
      } else {
        vi.spyOn(e.core.team, 'insertMember').mockImplementation(() => {
          throw new Error('저장소에 쓰지 못함 (시험)');
        });
      }
      g.open();
      const r = await call;
      const already = `프로듀서 ${name}(${old})의 턴은 이미 멈췄습니다 — 프로듀서는 그대로이고, 멈춘 작업 ${taskId}은(는) 다시 대기열에 들어가 그 프로듀서가 잇습니다`;
      expect(r).toEqual(
        how === 'catalog'
          ? { code: 'invalid', message: `claude 모델 "opus"은(는) 운영 설정 모델 목록에 없습니다. list_ai_options의 models.claude id 중에서 고르세요: sonnet (${already})` }
          : { code: 'error', message: `처리 중 오류: 저장소에 쓰지 못함 (시험) (${already})` },
      );
      // 실제 상태 — 바꾸지 않았고 새 팀원도 없다. 그 작업은 진행 중 그대로 같은 프로듀서 앞에 이어서 할 일이 있고 실제로 다시 뜬다
      expect(e.ctx.store.projects.require(e.projectId).producerId).toBe(old);
      expect(e.ctx.store.members.list()).toHaveLength(membersBefore);
      expect(e.ctx.store.tasks.require(taskId)).toMatchObject({ state: 'in_progress', assigneeId: old });
      const work = e.ctx.store.queue.list({ ref2: key, state: ['queued', 'running'] });
      expect(work.map((q) => [q.kind, q.memberId])).toEqual([['task_work', old]]);
      expect(work[0]!.message).toContain('프로그램이 이 작업 턴을 멈췄다가 다시 맡깁니다');
      expect(e.ctx.store.activity.search({ text: `${taskId} 프로듀서 교체를 하지 않아, 그 정지로 멈춘 작업 턴을 ${name}(${old})에게 다시 맡김`, limit: 5 })).toHaveLength(1);
      expect(await relaunchedOn(e, key, since)).toEqual([old]);
    });
  }
});

/**
 * 그 턴의 종료 확인을 문으로 붙잡는다 — 열면 프로세스가 끝나고 result를 돌려준다. exitRemaining: 프로세스가 끝나며 알리는 남은 하위 프로세스 수 — 정지 결과는 확인(ok)인데
 * 그 턴의 마무리가 남은 프로세스를 찾는 경우(kill_failed, CTL-11)
 */
function gateTerminate(proc: FakeProc, result: { ok: boolean; remaining: number; detail: string }, exitRemaining = 0): { called: () => boolean; count: () => number; open: () => void } {
  let open!: () => void;
  const g = new Promise<void>((r) => (open = r));
  gates.push(() => open());
  let n = 0;
  (proc as unknown as { terminate: () => Promise<unknown> }).terminate = async () => {
    n++;
    proc.terminatedByApp = true;
    await g;
    proc.exit(null, { terminated: true, remaining: exitRemaining });
    return { ...result, durationMs: 2500 };
  };
  return { called: () => n > 0, count: () => n, open };
}

/** 그 턴의 마무리(정리·종료 판정)를 문으로 붙잡는다 — 프로듀서 교체가 기다리는 상한(5초)을 넘기게. 돌려준 함수로 연다 */
function holdFinish(e: OrchEnv, proc: FakeProc): () => void {
  let openFinish!: () => void;
  const finishGate = new Promise<void>((res) => (openFinish = res));
  gates.push(() => openFinish());
  const settle = e.core.hostExec.settleTurn.bind(e.core.hostExec);
  vi.spyOn(e.core.hostExec, 'settleTurn').mockImplementation(async (turnId, why) => {
    if (turnId === proc.turnId) await finishGate;
    return settle(turnId, why);
  });
  return openFinish;
}

/** 마무리가 상한을 넘긴, 같은 프로듀서가 맡은 진행 중 작업의 턴 — 지금 확실한 것과 끝나면 프로그램이 할 수 있는 셋. 어느 하나를 약속하지 않는다 (리드 결정 S5-84) */
const unsettledTaskText = (key: string, taskId: string): string =>
  `${key} 턴은 마무리가 아직 끝나지 않았습니다 — 끝나면 프로그램이 셋 중 하나를 합니다: 멈춘 작업 ${taskId}을(를) 같은 프로듀서에게 다시 맡기거나, ` +
  `남은 제출(submit_for_review) 처리나 되돌리기 단계를 이어 가거나, 하위 프로세스가 남았으면 작업 ${taskId}을(를) 보류하고 확인하라는 알림을 메인 에이전트에게 넣습니다 ` +
  '(어느 쪽이 될지는 그 마무리가 끝나야 정해집니다)';

/** 프로듀서가 스스로 맡은 작업의 작업 턴 하나를 띄운다 (프로듀서 역할은 계획 작업을 맡는다 — 작은 프로젝트에서 프로듀서가 직접 맡는 경우) */
async function producerTaskTurnUp(e: OrchEnv): Promise<{ taskId: string; key: string; proc: FakeProc }> {
  const d = seedDirective(e);
  const t = e.core.tasks.create(
    { directiveId: d.id, title: '계획 문서 (프로듀서가 맡음)', goal: '계획을 정리한다', type: 'plan', assigneeId: e.producerId, acceptanceCriteria: ['문서가 있다'], outputMode: 'repo' },
    e.producerId,
  );
  const key = taskKey(t.id);
  e.hold.add(key);
  await waitFor(() => {
    if (!e.liveProc(key, e.producerId)) e.tick();
    return !!e.liveProc(key, e.producerId);
  }, '프로듀서의 작업 턴');
  return { taskId: t.id, key, proc: e.liveProc(key, e.producerId)! };
}

/** 부른 메인 턴을 끊는다 — 자리 교체 없이 비정상 종료, 또는 운영자의 강제 자리 교체(세대 1 → 2) */
async function cutCaller(e: OrchEnv, mp: FakeProc, how: 'crash' | 'seat-swap'): Promise<void> {
  if (how === 'crash') {
    mp.exit(1);
    await waitFor(() => !!e.ctx.store.turns.require(mp.turnId).endedAt, '부른 메인 턴이 끝남');
  } else await (await forceSwap(e, mainKey(null))).done;
}

/** 그 세션의 업무가 막힘 없이 다시 뜨는지 — since(멈춘 턴이 뜬 뒤의 띄운 수) 뒤에 뜬 그 세션의 턴을 띄운 팀원. 거부가 끝나며 곧바로 떴을 수도 있다 */
async function relaunchedOn(e: OrchEnv, key: string, since: number): Promise<string[]> {
  await waitFor(
    () => {
      e.tick();
      return e.launches.slice(since).some((l) => l.workKey === key);
    },
    `${key}이(가) 다시 뜸`,
  );
  return e.launches.slice(since).filter((l) => l.workKey === key).map((l) => l.memberId);
}

describe('거부된 replace_producer는 멈춘 일을 남기지 않고, 거부 글과 그 기록은 실제 결과대로 쓴다 (리드 결정 S5-73, 프로브 zz-s5af7-staletask·zz-s5af7-producerreview)', () => {
  for (const how of ['crash', 'seat-swap'] as const) {
    it(`${how}: 프로듀서의 작업 턴을 멈춘 뒤 다시 보기로 거부하면 — 그 작업을 같은 프로듀서에게 다시 맡기고, 글·기록이 그렇게 말한다`, async () => {
      const e = (env = await bootOrch());
      const old = e.producerId;
      const name = e.ctx.store.members.require(old).name;
      const { taskId, key, proc } = await producerTaskTurnUp(e);
      const since = e.launches.length;
      const g = gateTerminate(proc, { ok: true, remaining: 0, detail: '가짜 종료' });
      const mp = await mainTurnUp(e);
      const call = e.tool(mp.turnId, 'replace_producer', { project_id: e.projectId, reason: '프로듀서가 멈춤 (시험)' });
      await waitFor(g.called, 'replace_producer가 그 프로듀서의 정지를 기다림');
      await cutCaller(e, mp, how);
      g.open();
      const r = await call;
      const already = `프로듀서 ${name}(${old})의 턴은 이미 멈췄습니다 — 프로듀서는 그대로이고, 멈춘 작업 ${taskId}은(는) 다시 대기열에 들어가 그 프로듀서가 잇습니다`;
      expect(r).toEqual(
        how === 'crash' ? { ok: false, code: 'stopped', message: `${turnGone('replace_producer')} (${already})` } : { ok: false, code: 'seat_changed', message: `${seatChanged('replace_producer')} (${already})` },
      );
      // 그 기록도 같은 글 — 메인 에이전트의 줄
      const row = how === 'crash' ? `메인 턴 ${mp.turnId}이(가) 처리하며 기다리는 사이 끝났거나 종료 요청을 받아 replace_producer을(를) 마치지 않음 — ${already}` : `(${already})`;
      expect(e.ctx.store.activity.search({ text: row, limit: 5 }).map((a) => a.memberId)).toEqual([MAIN_AGENT_ID]);
      // 실제 상태 — 바꾸지 않았고, 그 작업은 진행 중 그대로 같은 프로듀서 앞에 이어서 할 일이 있다(보류 없음)
      expect(e.ctx.store.projects.require(e.projectId).producerId).toBe(old);
      const t = e.ctx.store.tasks.require(taskId);
      expect([t.state, t.assigneeId, t.hold.reasons]).toEqual(['in_progress', old, []]);
      const work = e.ctx.store.queue.list({ ref2: key, state: ['queued', 'running'] });
      expect(work.map((q) => [q.kind, q.memberId])).toEqual([['task_work', old]]);
      expect(work[0]!.message).toContain('프로그램이 이 작업 턴을 멈췄다가 다시 맡깁니다');
      expect(e.ctx.store.activity.search({ text: `${taskId} 프로듀서 교체를 하지 않아, 그 정지로 멈춘 작업 턴을 ${name}(${old})에게 다시 맡김`, limit: 5 })).toHaveLength(1);
      // 그 일은 현황에 보이고(대기 또는 다시 뜬 턴), 실제로 같은 프로듀서의 턴으로 다시 뜬다
      const block = e.core.overview.build({ detail: true }).projects.items.find((p) => p.id === e.projectId)!;
      expect(block.members.items.find((m) => m.memberId === old)!.queued + block.running.items.filter((x) => x.memberId === old).length).toBeGreaterThan(0);
      expect(await relaunchedOn(e, key, since)).toEqual([old]);
    });
  }

  it('대조: 프로듀서의 검수 턴은 그 판정이 다시 넣는다 — 글이 그렇게 말하고 그 검수가 같은 프로듀서에게 다시 뜬다', async () => {
    const e = (env = await bootOrch());
    const old = e.producerId;
    const name = e.ctx.store.members.require(old).name;
    const { task, proc } = await startReview(e, old);
    const since = e.launches.length;
    const g = gateTerminate(proc, { ok: true, remaining: 0, detail: '가짜 종료' });
    const mp = await mainTurnUp(e);
    const call = e.tool(mp.turnId, 'replace_producer', { project_id: e.projectId, reason: '프로듀서가 멈춤 (시험)' });
    await waitFor(g.called, 'replace_producer가 그 프로듀서의 정지를 기다림');
    await cutCaller(e, mp, 'crash');
    g.open();
    const r = await call;
    expect(!r.ok && r.message).toBe(`${turnGone('replace_producer')} (프로듀서 ${name}(${old})의 턴은 이미 멈췄습니다 — 프로듀서는 그대로이고, 멈춘 검수(작업 ${task.id})는 다시 대기열에 들어가 그 프로듀서가 잇습니다)`);
    expect(e.ctx.store.queue.list({ ref2: reviewKey(task.id), state: ['queued', 'running'] }).map((q) => [q.kind, q.memberId])).toEqual([['review', old]]);
    expect(await relaunchedOn(e, reviewKey(task.id), since)).toEqual([old]);
  });

  it('이미 통과 판정을 낸 프로듀서의 검수 턴(저장소 변경형)을 멈춘 뒤 거부하면 — 판정이 넣은 그 다음 단계(병합 판단)를 쓰고, 그 병합 판단이 같은 프로듀서 앞에 있다 (리드 결정 S5-90 2, 프로브 zz-s5af10-corners RS)', async () => {
    const e = (env = await bootOrch());
    const old = e.producerId;
    const name = e.ctx.store.members.require(old).name;
    const { task, proc } = await startReview(e, old, { outputMode: 'repo' });
    const rk = reviewKey(task.id);
    const dk = directiveKey(task.directiveId);
    // 병합 판단을 받은 관리 턴이 곧바로 끝나지 않게 — 받은 팀원을 본다
    e.hold.add(dk);
    const v = await e.tool(proc.turnId, 'submit_review', { task_id: task.id, verdict: 'pass', criteria: [{ criterion: '문서가 있다', pass: true, note: '' }], reason: '', request_id: 'rq-pass-s590' });
    expect(v.ok).toBe(true);
    const since = e.launches.length;
    const g = gateTerminate(proc, { ok: true, remaining: 0, detail: '가짜 종료' });
    const mp = await mainTurnUp(e);
    const call = e.tool(mp.turnId, 'replace_producer', { project_id: e.projectId, reason: '프로듀서가 멈춤 (시험)' });
    await waitFor(g.called, 'replace_producer가 그 프로듀서의 정지를 기다림');
    await cutCaller(e, mp, 'crash');
    g.open();
    const r = await call;
    // 마무리가 아직일 때의 글('이미 낸 통과 판정의 다음 단계(병합 판단·산출물 확정)를 이어 가거나')과 같은 결과를 말한다 — '다시 이어 갈 일이 남지 않았습니다'가 아니다
    const already = `프로듀서 ${name}(${old})의 턴은 이미 멈췄습니다 — 프로듀서는 그대로이고, 멈춘 검수(작업 ${task.id})는 이미 통과 판정을 냈고, 그 다음 단계인 병합 판단이 대기열에 들어가 그 프로듀서가 잇습니다`;
    expect(r).toEqual({ ok: false, code: 'stopped', message: `${turnGone('replace_producer')} (${already})` });
    expect(!r.ok && r.message).not.toContain('다시 이어 갈 일이 남지 않았습니다');
    expect(e.ctx.store.activity.search({ text: `메인 턴 ${mp.turnId}이(가) 처리하며 기다리는 사이 끝났거나 종료 요청을 받아 replace_producer을(를) 마치지 않음 — ${already}`, limit: 5 }).map((a) => a.memberId)).toEqual([MAIN_AGENT_ID]);
    // 실제 상태 — 검수 중(통과) 그대로, 검수는 다시 넣지 않았고, 병합 판단은 그 지시의 관리 세션에 같은 프로듀서 몫으로 있으며 실제로 그 프로듀서의 턴으로 뜬다
    expect(e.ctx.store.tasks.require(task.id).state).toBe('in_review');
    expect(e.ctx.store.queue.list({ ref2: rk, state: ['queued', 'running'] }).filter((q) => q.turnId !== proc.turnId)).toEqual([]);
    expect(e.ctx.store.queue.list({ ref2: dk, state: ['queued', 'running'] }).filter((q) => q.kind === 'merge_decision' && q.taskId === task.id).map((q) => q.memberId)).toEqual([old]);
    expect(await relaunchedOn(e, dk, since)).toEqual([old]);
  });

  it('그 작업 턴의 마무리가 상한(5초)을 넘기면 — 끝나면 할 수 있는 셋을 모두 쓰고(약속하지 않음), 마무리가 끝난 뒤 그 작업을 다시 맡긴다 (리드 결정 S5-84)', async () => {
    const e = (env = await bootOrch());
    const old = e.producerId;
    const name = e.ctx.store.members.require(old).name;
    const { taskId, key, proc } = await producerTaskTurnUp(e);
    const g = gateTerminate(proc, { ok: true, remaining: 0, detail: '가짜 종료' });
    // 그 턴의 마무리(정리·판정)를 문으로 붙잡는다
    let openFinish!: () => void;
    const finishGate = new Promise<void>((res) => (openFinish = res));
    gates.push(() => openFinish());
    const settle = e.core.hostExec.settleTurn.bind(e.core.hostExec);
    vi.spyOn(e.core.hostExec, 'settleTurn').mockImplementation(async (turnId, why) => {
      if (turnId === proc.turnId) await finishGate;
      return settle(turnId, why);
    });
    const mp = await mainTurnUp(e);
    const call = e.tool(mp.turnId, 'replace_producer', { project_id: e.projectId, reason: '프로듀서가 멈춤 (시험)' });
    await waitFor(g.called, 'replace_producer가 그 프로듀서의 정지를 기다림');
    await cutCaller(e, mp, 'crash');
    g.open();
    const r = await call;
    expect(!r.ok && r.code).toBe('stopped');
    // 리드 결정 S5-84로 다시 씀 — 예전 글('끝나면 멈춘 일을 같은 프로듀서가 잇습니다')은 제출·되돌리기·남은 프로세스로 끝날 때 거짓이었다. 이제 글 전체를 본다
    expect(!r.ok && r.message).toBe(`${turnGone('replace_producer')} (프로듀서 ${name}(${old})의 턴은 이미 멈췄습니다 — 프로듀서는 그대로이고, ${unsettledTaskText(key, taskId)})`);
    expect(!r.ok && r.message).not.toContain('같은 프로듀서가 잇습니다');
    // 아직은 다시 맡긴 일이 없다(멈춘 턴이 실은 항목만 마무리를 기다린다) — 마무리가 끝나면 맡긴다
    expect(e.ctx.store.queue.list({ ref2: key, state: ['queued', 'running'] }).filter((q) => q.turnId !== proc.turnId)).toEqual([]);
    openFinish();
    // 멈춘 턴이 실었던 항목(마무리가 끝나면 받아 마침)이 아니라 새로 맡긴 일 — 그 프로그램 글로
    await waitFor(
      () => e.ctx.store.queue.list({ ref2: key, state: ['queued', 'running'] }).some((q) => q.kind === 'task_work' && q.memberId === old && q.turnId !== proc.turnId),
      '마무리 뒤 그 작업을 다시 맡김',
    );
    const again = e.ctx.store.queue.list({ ref2: key, state: ['queued', 'running'] }).filter((q) => q.turnId !== proc.turnId);
    expect(again.map((q) => [q.kind, q.memberId])).toEqual([['task_work', old]]);
    expect(again[0]!.message).toContain('프로그램이 이 작업 턴을 멈췄다가 다시 맡깁니다');
    expect(e.ctx.store.tasks.require(taskId)).toMatchObject({ state: 'in_progress', assigneeId: old });
  }, 30_000);

  for (const how of ['crash', 'seat-swap'] as const) {
    it(`${how}: 남은 프로세스와 다시 보기가 겹치면 — 다시 보기 거부가 그 정지의 실제 결과(일시정지와 메인에게 간 재개 업무)를 쓰고 '그 프로듀서가 잇습니다'라고 하지 않는다`, async () => {
      const e = (env = await bootOrch());
      const old = e.producerId;
      const name = e.ctx.store.members.require(old).name;
      const { dk, proc } = await producerTurnGated(e);
      const g = gateTerminate(proc, { ok: false, remaining: 2, detail: '하위 프로세스 2개 남음 (시험)' });
      const mp = await mainTurnUp(e);
      const call = e.tool(mp.turnId, 'replace_producer', { project_id: e.projectId, reason: '프로듀서가 멈춤 (시험)' });
      await waitFor(g.called, 'replace_producer가 그 프로듀서의 정지를 기다림');
      await cutCaller(e, mp, how);
      g.open();
      const r = await call;
      // 실제 상태 — 프로그램이 건 일시정지와 메인에게 간 재개 업무, 바꾸지 않음
      expect(e.ctx.stop().members[old]).toMatchObject({ paused: true, by: 'system' });
      const item = e.ctx.store.queue.list({ ref1: MAIN_AGENT_ID, state: ['queued', 'running'] }).find((q) => q.pausedMemberId === old)!;
      expect(item).toBeTruthy();
      expect(e.ctx.store.projects.require(e.projectId).producerId).toBe(old);
      const already = `프로듀서 ${name}(${old})의 턴은 이미 멈췄습니다 — ${dk} 턴의 하위 프로세스 2개가 남았습니다(종료 확인 실패). 이 프로듀서는 일시정지돼 있고, 남은 프로세스를 확인하라는 업무(${item.id})가 메인 에이전트에게 가 있습니다`;
      expect(r).toEqual(
        how === 'crash' ? { ok: false, code: 'stopped', message: `${turnGone('replace_producer')} (${already})` } : { ok: false, code: 'seat_changed', message: `${seatChanged('replace_producer')} (${already})` },
      );
      expect(!r.ok && r.message).not.toContain('그 프로듀서가 잇습니다');
      const row = how === 'crash' ? `메인 턴 ${mp.turnId}이(가) 처리하며 기다리는 사이 끝났거나 종료 요청을 받아 replace_producer을(를) 마치지 않음 — ${already}` : `(${already})`;
      expect(e.ctx.store.activity.search({ text: row, limit: 5 }).map((a) => a.memberId)).toEqual([MAIN_AGENT_ID]);
      expect(e.ctx.store.activity.search({ text: '그 프로듀서가 잇습니다', limit: 20 })).toEqual([]);
    });
  }

  it('정지와 그 마무리를 기다리는 동안 그 프로듀서의 새 턴은 뜨지 않는다 — 판정이 다시 넣은 관리 업무는 바꾼 뒤 새 프로듀서가 잇고, 지운 팀원의 턴이 남지 않는다 (리드 결정 S5-73 1)', async () => {
    const e = (env = await bootOrch());
    const old = e.producerId;
    const d = seedDirective(e);
    const dk = directiveKey(d.id);
    e.hold.add(dk);
    enqueue(e.ctx, { kind: 'message', memberId: old, sessionKey: dk, projectId: e.projectId, directiveId: d.id, message: '진행 상황을 정리해 주세요 (시험)' });
    await waitFor(
      () => {
        if (!e.liveProc(dk, old)) e.tick();
        return !!e.liveProc(dk, old);
      },
      '프로듀서 관리 턴',
    );
    // 그 프로듀서가 맡은 대기 작업도 하나 — 관리 턴이 도는 동안은 활성화되지 않는다(팀원당 턴 하나). 그 턴이 멈추면 활성화 후보가 된다
    const t = e.core.tasks.create(
      { directiveId: d.id, title: '계획 문서 (프로듀서가 맡음)', goal: '계획을 정리한다', type: 'plan', assigneeId: old, acceptanceCriteria: ['문서가 있다'], outputMode: 'repo' },
      old,
    );
    // 멈춘 턴이 실행 목록에서 빠진 뒤 그 판정이 끝나기 전에 스케줄러 틱이 오는 때(2초 주기, 다른 일의 신호)를 흉내 낸다 — 그 턴의 마무리 끝(판정 뒤)에서 한 번 돌린다
    const pending = e.core.team.applyPendingAiIfIdle.bind(e.core.team);
    let ticked = 0;
    vi.spyOn(e.core.team, 'applyPendingAiIfIdle').mockImplementation((memberId, ignore) => {
      if (memberId === old && !ticked++) e.tick();
      return pending(memberId, ignore);
    });
    const before = e.launches.filter((l) => l.memberId === old).length;
    const v = await e.main('replace_producer', { project_id: e.projectId, reason: '교체 (시험)' });
    expect(ticked).toBeGreaterThan(0);
    const fresh = v.producerId as string;
    // 멈춘 턴의 판정이 그 관리 업무를 다시 넣었고 그 대기 작업도 활성화될 수 있었지만, 기다리는 동안 이전 프로듀서의 턴은 다시 뜨지 않았다(대기 업무·작업 활성화 둘 다)
    // — 지운 팀원의 살아 있는 턴이 없다
    expect(e.launches.filter((l) => l.memberId === old)).toHaveLength(before);
    expect(e.core.turns.isMemberRunning(old)).toBe(false);
    expect(e.ctx.store.members.require(old).deletedAt).toBeTruthy();
    expect(e.ctx.store.tasks.require(t.id).assigneeId).toBe(fresh);
    // 그 일은 새 프로듀서가 잇는다
    await waitFor(
      () => {
        e.tick();
        return e.launches.some((l) => l.memberId === fresh && l.workKey === dk);
      },
      '새 프로듀서가 그 관리 업무를 이음',
    );
    expect(e.core.turns.launchHeld(old)).toBe(false);
  });
});

/** 메인 에이전트의 대기·실행 중 항목 가운데 그 키의 알림 ID */
const mainAlertIds = (e: OrchEnv, key: string): string[] =>
  e.ctx.store.queue
    .list({ ref1: MAIN_AGENT_ID, state: ['queued', 'running'] })
    .filter((q) => q.alertKey === key)
    .map((q) => q.id);

describe('다시 보기 거부의 남은 일과 다시 맡기는 길 — 실제 결과대로 쓰고, 보류 해제와 같은 갈래로 잇는다 (리드 결정 S5-73·S5-82, 프로브 zz-s5af8-recheckleft·zz-s5f7ti-refusal-pending·zz-s5f7ti-requeue)', () => {
  // 검수·작업 턴이 프로세스를 남긴 정지 × 부른 턴이 끊긴 방식 — 모드는 번갈아(끝 문장이 다른 남은 프로세스 거부와 달리 이 글은 모드에 따라 다르지 않다)
  for (const [kind, how, mode] of [
    ['review', 'crash', 'desktop'],
    ['review', 'seat-swap', 'server'],
    ['task', 'crash', 'server'],
    ['task', 'seat-swap', 'desktop'],
  ] as const) {
    it(`${kind} · ${how} · ${mode}: 프로듀서의 ${kind === 'task' ? '작업' : '검수'} 턴 정지가 프로세스를 남기고 다시 보기로도 거부하면 — 그 작업을 보류했고 알림이 메인에게 갔다고 쓰고(일시정지·'그 프로듀서가 잇습니다' 없음), 그 기록도 같은 글의 메인 줄이다`, async () => {
      const e = (env = await bootOrch({ mode }));
      const old = e.producerId;
      const name = e.ctx.store.members.require(old).name;
      let taskId: string;
      let key: string;
      let proc: FakeProc;
      if (kind === 'task') ({ taskId, key, proc } = await producerTaskTurnUp(e));
      else {
        const started = await startReview(e, old);
        taskId = started.task.id;
        key = reviewKey(taskId);
        proc = started.proc;
      }
      const g = gateTerminate(proc, { ok: false, remaining: 2, detail: '하위 프로세스 2개 남음 (시험)' });
      const mp = await mainTurnUp(e);
      const call = e.tool(mp.turnId, 'replace_producer', { project_id: e.projectId, reason: '프로듀서가 멈춤 (시험)' });
      await waitFor(g.called, 'replace_producer가 그 프로듀서의 정지를 기다림');
      await cutCaller(e, mp, how);
      g.open();
      const r = await call;
      // 실제 상태 — 작업 보류(사실만)와 그 작업의 알림 하나. 프로듀서는 일시정지하지 않았고 바꾸지 않았다
      const t = e.ctx.store.tasks.require(taskId);
      expect(t.state).toBe('on_hold');
      const alerts = mainAlertIds(e, alertKey('kill-failed', taskId));
      expect(alerts).toHaveLength(1);
      expect(e.ctx.stop().members[old]).toBeUndefined();
      expect(e.ctx.store.projects.require(e.projectId).producerId).toBe(old);
      const already = `프로듀서 ${name}(${old})의 턴은 이미 멈췄습니다 — ${key} 턴의 하위 프로세스 2개가 남았습니다(종료 확인 실패). 작업 ${taskId}을(를) 보류했고, 남은 프로세스를 확인하라는 알림(${alerts[0]})이 메인 에이전트에게 가 있습니다`;
      expect(r).toEqual(
        how === 'crash' ? { ok: false, code: 'stopped', message: `${turnGone('replace_producer')} (${already})` } : { ok: false, code: 'seat_changed', message: `${seatChanged('replace_producer')} (${already})` },
      );
      const row = how === 'crash' ? `메인 턴 ${mp.turnId}이(가) 처리하며 기다리는 사이 끝났거나 종료 요청을 받아 replace_producer을(를) 마치지 않음 — ${already}` : `(${already})`;
      expect(e.ctx.store.activity.search({ text: row, limit: 5 }).map((a) => a.memberId)).toEqual([MAIN_AGENT_ID]);
      expect(e.ctx.store.activity.search({ text: '그 프로듀서가 잇습니다', limit: 20 })).toEqual([]);
    });
  }

  it('보류된 작업의 턴을 정지가 확인되게 멈춘 뒤 다시 보기로 거부하면 — 그 보류가 풀리면 잇는다고 쓰고(다시 맡기지 않음), 적힌 대로 보류가 풀리면 그 작업이 이어진다 (변이 O14-b-onhold-not-said·O14-r-no-state-check)', async () => {
    const e = (env = await bootOrch());
    const old = e.producerId;
    const name = e.ctx.store.members.require(old).name;
    const { taskId, key, proc } = await producerTaskTurnUp(e);
    // 메인이 그 프로듀서를 단계 마치고 일시정지한다 — 맡은 작업은 보류되고, 작업 턴은 단계를 마칠 때까지 돈다
    await e.main('pause_member', { member_id: old, mode: 'graceful', reason: '멈춤 (시험)' });
    expect(e.ctx.store.tasks.require(taskId).state).toBe('on_hold');
    expect(e.liveProc(key, old)).toBe(proc);
    const g = gateTerminate(proc, { ok: true, remaining: 0, detail: '가짜 종료' });
    const mp = await mainTurnUp(e);
    const call = e.tool(mp.turnId, 'replace_producer', { project_id: e.projectId, reason: '프로듀서가 멈춤 (시험)' });
    await waitFor(g.called, 'replace_producer가 그 프로듀서의 정지를 기다림');
    await cutCaller(e, mp, 'crash');
    g.open();
    const r = await call;
    expect(r).toEqual({ ok: false, code: 'stopped', message: `${turnGone('replace_producer')} (프로듀서 ${name}(${old})의 턴은 이미 멈췄습니다 — 프로듀서는 그대로이고, 작업 ${taskId}은(는) 보류돼 있어 그 보류가 풀리면 이어 갑니다)` });
    // 실제 상태 — 보류 그대로, 다시 맡긴 일도 기록도 없다(보류 위에 일을 넣지 않는다)
    expect(e.ctx.store.tasks.require(taskId).state).toBe('on_hold');
    expect(e.ctx.store.queue.list({ ref2: key, state: ['queued', 'running'] }).filter((q) => q.kind !== 'message')).toEqual([]);
    expect(e.ctx.store.activity.search({ text: '프로듀서 교체를 하지 않아', limit: 20 })).toEqual([]);
    // 적힌 대로 — 그 보류가 풀리면 같은 프로듀서가 그 작업을 잇는다
    await e.main('resume_member', { member_id: old, reason: '다시 (시험)' });
    expect(e.ctx.store.tasks.require(taskId)).toMatchObject({ state: 'in_progress', assigneeId: old });
    expect(e.ctx.store.queue.list({ ref2: key, state: ['queued', 'running'] }).filter((q) => q.kind === 'task_work' && q.memberId === old)).toHaveLength(1);
  });

  // 거부하며 멈춘 작업 턴을 다시 맡길 때 병합 충돌·제출·되돌리기가 남은 작업은 보류 해제와 같은 갈래(afterRelease)로 — 일반 '이어서 진행'(task_work)을 주지 않는다
  for (const pending of ['conflict', 'submit', 'revert'] as const) {
    it(`${pending}: 거부된 교체가 멈춘 작업 턴의 작업에 ${pending === 'conflict' ? '풀지 않은 병합 충돌이' : pending === 'submit' ? '처리하지 않은 제출이' : '프로그램의 되돌리기 단계가'} 남았으면 — 그 갈래로 잇고 일반 task_work는 없다. 글과 기록이 그대로 말한다 (변이 O14-r-no-afterRelease)`, async () => {
      const e = (env = await bootOrch());
      const old = e.producerId;
      const name = e.ctx.store.members.require(old).name;
      const { taskId, key, proc } = await producerTaskTurnUp(e);
      if (pending === 'conflict') e.ctx.store.tasks.patch(taskId, { conflict: { files: ['shared.txt'], since: e.ctx.now(), resolverId: null, spinHolds: 0 } } as never);
      if (pending === 'submit') e.ctx.store.tasks.patch(taskId, { pendingSubmit: { requestedAt: e.ctx.now(), note: '제출 (시험)' } } as never);
      if (pending === 'revert') e.ctx.store.tasks.patch(taskId, { type: 'revert', revertOfTaskId: 'T-9999' } as never);
      // 프로그램 단계(제출 처리·되돌리기)는 부른 것만 본다 — 실제 git 단계는 그 시험들이 본다
      const submitted = vi.spyOn(e.core.tasks, 'processSubmission').mockResolvedValue(undefined);
      const reverted = vi.spyOn(e.core.merges, 'resumeRevert').mockResolvedValue(undefined);
      const g = gateTerminate(proc, { ok: true, remaining: 0, detail: '가짜 종료' });
      const mp = await mainTurnUp(e);
      const call = e.tool(mp.turnId, 'replace_producer', { project_id: e.projectId, reason: '프로듀서가 멈춤 (시험)' });
      await waitFor(g.called, 'replace_producer가 그 프로듀서의 정지를 기다림');
      await cutCaller(e, mp, 'crash');
      // 그 전의 스케줄러 틱(메인 턴을 띄울 때)이 되돌리기 단계를 불렀을 수 있다 — 거부가 부른 것만 센다
      submitted.mockClear();
      reverted.mockClear();
      g.open();
      const r = await call;
      const state =
        pending === 'conflict'
          ? `멈춘 작업 ${taskId}은(는) 다시 대기열에 들어가 그 프로듀서가 잇습니다`
          : pending === 'submit'
            ? `멈춘 작업 ${taskId}은(는) 제출(submit_for_review)이 남아 있어 프로그램이 그 제출 처리를 이어 갑니다`
            : `멈춘 되돌리기 작업 ${taskId}은(는) 프로그램이 되돌리기 단계를 이어 갑니다`;
      expect(r).toEqual({ ok: false, code: 'stopped', message: `${turnGone('replace_producer')} (프로듀서 ${name}(${old})의 턴은 이미 멈췄습니다 — 프로듀서는 그대로이고, ${state})` });
      expect(e.ctx.store.projects.require(e.projectId).producerId).toBe(old);
      const work = e.ctx.store.queue.list({ ref2: key, state: ['queued', 'running'] }).filter((q) => q.kind !== 'message');
      if (pending === 'conflict') {
        // 충돌 안내가 든 conflict_fix 하나
        expect(work.map((q) => [q.kind, q.memberId])).toEqual([['conflict_fix', old]]);
        expect(work[0]!.message).toContain('병합 충돌이 아직 해결되지 않았습니다');
        expect(work[0]!.message).toContain('shared.txt');
      } else expect(work).toEqual([]);
      expect(submitted.mock.calls.map((c) => c[0])).toEqual(pending === 'submit' ? [taskId] : []);
      expect(reverted.mock.calls.map((c) => c[0])).toEqual(pending === 'revert' ? [taskId] : []);
      const row =
        pending === 'conflict'
          ? `${taskId} 프로듀서 교체를 하지 않아, 그 정지로 멈춘 작업 턴을 ${name}(${old})에게 다시 맡김`
          : pending === 'submit'
            ? `${taskId} 프로듀서 교체를 하지 않아, 그 정지로 멈춘 작업의 제출 처리를 프로그램이 이어 감`
            : `${taskId} 프로듀서 교체를 하지 않아, 그 정지로 멈춘 되돌리기 작업의 되돌리기 단계를 프로그램이 이어 감`;
      expect(e.ctx.store.activity.search({ text: '프로듀서 교체를 하지 않아', limit: 20 }).map((a) => a.text)).toEqual([row]);
    });
  }

  it('멈춘 작업 턴을 다시 맡기다 실패해도 거부는 그대로 나간다 — 글은 그때의 실제 상태(다시 이어 갈 일이 없음)를 쓰고, 그 실패는 로그에 남는다', async () => {
    const e = (env = await bootOrch());
    const old = e.producerId;
    const name = e.ctx.store.members.require(old).name;
    const { taskId, key, proc } = await producerTaskTurnUp(e);
    const g = gateTerminate(proc, { ok: true, remaining: 0, detail: '가짜 종료' });
    const mp = await mainTurnUp(e);
    const call = e.tool(mp.turnId, 'replace_producer', { project_id: e.projectId, reason: '프로듀서가 멈춤 (시험)' });
    await waitFor(g.called, 'replace_producer가 그 프로듀서의 정지를 기다림');
    await cutCaller(e, mp, 'crash');
    vi.spyOn(e.core.tasks, 'continueWork').mockImplementation(() => {
      throw new Error('다시 맡기지 못함 (시험)');
    });
    g.open();
    const r = await call;
    expect(r).toEqual({
      ok: false,
      code: 'stopped',
      message: `${turnGone('replace_producer')} (프로듀서 ${name}(${old})의 턴은 이미 멈췄습니다 — 프로듀서는 그대로이고, ${key}에는 다시 이어 갈 일이 남지 않았습니다 (작업 ${taskId}: ${TASK_STATE_LABEL.in_progress}))`,
    });
    expect(e.errors.some((x) => x.startsWith(`프로듀서 교체 거부 뒤 멈춘 작업 다시 맡기기 실패 ${taskId}`))).toBe(true);
    expect(e.ctx.store.activity.search({ text: '프로듀서 교체를 하지 않아', limit: 20 })).toEqual([]);
  });

  it('메인 턴의 replace_producer가 그 프로듀서의 작업 턴을 멈춘 뒤 바꾸면 — 이전 프로듀서에게 다시 맡기지 않고 그렇게 적지도 않는다(다시 맡기기는 거부할 때만) (변이 O14-c-already-eager·O14-r-resume-even-when-replacing)', async () => {
    const e = (env = await bootOrch());
    const old = e.producerId;
    const { taskId, key, proc } = await producerTaskTurnUp(e);
    const g = gateTerminate(proc, { ok: true, remaining: 0, detail: '가짜 종료' });
    const mp = await mainTurnUp(e);
    const call = e.tool(mp.turnId, 'replace_producer', { project_id: e.projectId, reason: '프로듀서 교체 (시험)' });
    await waitFor(g.called, 'replace_producer가 그 프로듀서의 정지를 기다림');
    g.open();
    const r = await call;
    expect(r.ok).toBe(true);
    const fresh = e.ctx.store.projects.require(e.projectId).producerId;
    expect(fresh).not.toBe(old);
    expect(e.ctx.store.tasks.require(taskId).assigneeId).toBe(fresh);
    expect(e.ctx.store.activity.search({ text: '프로듀서 교체를 하지 않아', limit: 20 })).toEqual([]);
    expect(e.ctx.store.queue.list({ ref2: key, state: ['queued', 'running'] }).filter((q) => q.memberId === old)).toEqual([]);
    expect(e.launches.filter((l) => l.memberId === old && l.workKey === key)).toHaveLength(1);
  });
});

describe('마무리가 상한(5초)을 넘긴 멈춘 턴의 거부 글 — 지금 확실한 것만 쓰고 끝나면 할 수 있는 일을 모두 적는다. 마무리가 끝나면 실제로는 그중 하나가 일어난다 (리드 결정 S5-84·S5-87 5, 프로브 zz-s5af9-unsettled)', () => {
  /** 붙잡은 마무리를 열고 그 턴의 흐름(정리·판정)과 그 뒤의 다시 맡기기(resumeStopped)가 끝날 때까지 기다린다 */
  async function finishNow(e: OrchEnv, proc: FakeProc, openFinish: () => void): Promise<void> {
    openFinish();
    await waitFor(() => !!e.ctx.store.turns.require(proc.turnId).endedAt, '멈춘 턴의 마무리가 끝남');
    await e.core.turns.turnFlow(proc.turnId);
    await sleep(50);
  }
  /** 두 교체를 함께 부른다 — 둘 다 그 프로듀서의 정지를 기다리게 한 뒤 연다. 거부한 쪽과 지금 프로듀서 */
  async function twoReplaces(e: OrchEnv, g: { count: () => number; open: () => void }): Promise<{ refused: { code: string; message: string }; now: string }> {
    const call = (reason: string) =>
      e.main('replace_producer', { project_id: e.projectId, reason }).then(
        () => null,
        (x: Error & { code?: string }) => ({ code: x.code ?? 'error', message: x.message }),
      );
    const a = call('교체 A (시험)');
    await waitFor(() => g.count() >= 1, '첫 교체가 정지를 기다림');
    const b = call('교체 B (시험)');
    await waitFor(() => g.count() >= 2, '둘째 교체도 정지를 기다림');
    g.open();
    const both = await Promise.all([a, b]);
    expect(both.filter((r) => r === null)).toHaveLength(1);
    return { refused: both.find((r) => r !== null)!, now: e.ctx.store.projects.require(e.projectId).producerId };
  }

  // 같은 프로듀서가 맡은 진행 중 작업 — 같은 거부 글(셋)이 세 갈래 끝 모두에 참이다. 같은 프로듀서에게 다시 맡기는 끝은 위 '그 작업 턴의 마무리가 상한(5초)을 넘기면' 시험
  for (const outcome of ['submit', 'revert', 'leftover'] as const) {
    const what = outcome === 'submit' ? '제출 처리를 프로그램이 잇는다' : outcome === 'revert' ? '되돌리기 단계를 프로그램이 잇는다' : '남은 프로세스를 찾아 작업을 보류하고 메인에게 알린다';
    it(`작업 턴 · ${outcome}: 같은 거부 글(셋)이 나가고, 마무리가 끝나면 ${what} — 셋 가운데 이것 하나만 일어난다`, async () => {
      const e = (env = await bootOrch());
      const old = e.producerId;
      const name = e.ctx.store.members.require(old).name;
      const { taskId, key, proc } = await producerTaskTurnUp(e);
      if (outcome === 'submit') e.ctx.store.tasks.patch(taskId, { pendingSubmit: { requestedAt: e.ctx.now(), note: '제출 (시험)' } } as never);
      if (outcome === 'revert') e.ctx.store.tasks.patch(taskId, { type: 'revert', revertOfTaskId: 'T-9999' } as never);
      // 프로그램 단계(제출 처리·되돌리기)는 부른 것만 본다 — 실제 git 단계는 그 시험들이 본다
      const submitted = vi.spyOn(e.core.tasks, 'processSubmission').mockResolvedValue(undefined);
      const reverted = vi.spyOn(e.core.merges, 'resumeRevert').mockResolvedValue(undefined);
      // 정지 결과는 확인(ok)이고, 남은 프로세스 갈래는 프로세스가 끝나며 남은 하위 프로세스 2개를 알린다 — 마무리가 그것을 찾는다
      const g = gateTerminate(proc, { ok: true, remaining: 0, detail: '가짜 종료' }, outcome === 'leftover' ? 2 : 0);
      const openFinish = holdFinish(e, proc);
      const mp = await mainTurnUp(e);
      const call = e.tool(mp.turnId, 'replace_producer', { project_id: e.projectId, reason: '프로듀서가 멈춤 (시험)' });
      await waitFor(g.called, 'replace_producer가 그 프로듀서의 정지를 기다림');
      await cutCaller(e, mp, 'crash');
      g.open();
      const r = await call;
      // 세 갈래 모두 같은 글 — 어느 하나를 약속하지 않는다
      const already = `프로듀서 ${name}(${old})의 턴은 이미 멈췄습니다 — 프로듀서는 그대로이고, ${unsettledTaskText(key, taskId)}`;
      expect(r).toEqual({ ok: false, code: 'stopped', message: `${turnGone('replace_producer')} (${already})` });
      // 그 기록도 같은 글 — 메인 에이전트의 줄
      const row = `메인 턴 ${mp.turnId}이(가) 처리하며 기다리는 사이 끝났거나 종료 요청을 받아 replace_producer을(를) 마치지 않음 — ${already}`;
      expect(e.ctx.store.activity.search({ text: row, limit: 5 }).map((a) => a.memberId)).toEqual([MAIN_AGENT_ID]);
      // 지금은 아직 아무것도 정해지지 않았다 — 다시 맡긴 일·보류·알림 없음
      expect(e.ctx.store.tasks.require(taskId)).toMatchObject({ state: 'in_progress', assigneeId: old });
      expect(e.ctx.store.queue.list({ ref2: key, state: ['queued', 'running'] }).filter((q) => q.turnId !== proc.turnId && q.kind !== 'message')).toEqual([]);
      expect(mainAlertIds(e, alertKey('kill-failed', taskId))).toEqual([]);
      // 메인 턴을 띄우는 동안의 스케줄러 틱이 되돌리기 단계를 불렀을 수 있다 — 마무리 뒤에 부른 것만 센다
      submitted.mockClear();
      reverted.mockClear();
      await finishNow(e, proc, openFinish);
      const t = e.ctx.store.tasks.require(taskId);
      // 실제로 일어난 것 — 셋 가운데 하나, 다른 둘은 없다
      expect({
        state: t.state,
        holds: t.hold.reasons.map((x) => x.kind),
        producerWork: e.ctx.store.queue
          .list({ ref2: key, state: ['queued', 'running'] })
          .filter((q) => q.turnId !== proc.turnId && q.kind !== 'message')
          .map((q) => [q.kind, q.memberId]),
        submitted: submitted.mock.calls.map((c) => c[0]),
        reverted: reverted.mock.calls.map((c) => c[0]),
        alerts: mainAlertIds(e, alertKey('kill-failed', taskId)).length,
        rows: e.ctx.store.activity.search({ text: '프로듀서 교체를 하지 않아', limit: 20 }).map((a) => a.text),
      }).toEqual(
        outcome === 'leftover'
          ? { state: 'on_hold', holds: ['error'], producerWork: [], submitted: [], reverted: [], alerts: 1, rows: [] }
          : {
              state: 'in_progress',
              holds: [],
              producerWork: [],
              submitted: outcome === 'submit' ? [taskId] : [],
              reverted: outcome === 'revert' ? [taskId] : [],
              alerts: 0,
              rows: [
                outcome === 'submit'
                  ? `${taskId} 프로듀서 교체를 하지 않아, 그 정지로 멈춘 작업의 제출 처리를 프로그램이 이어 감`
                  : `${taskId} 프로듀서 교체를 하지 않아, 그 정지로 멈춘 되돌리기 작업의 되돌리기 단계를 프로그램이 이어 감`,
              ],
            },
      );
      // 바꾸지 않았고 프로듀서를 일시정지하지도 않았다(작업 세션의 남은 프로세스는 작업 보류로 막는다)
      expect(e.ctx.store.projects.require(e.projectId).producerId).toBe(old);
      expect(e.ctx.stop().members[old]).toBeUndefined();
    }, 40_000);
  }

  it('검수 턴: 마무리가 상한을 넘기면 — 검수의 셋(같은 프로듀서 앞에 다시 넣음·이미 낸 통과 판정의 다음 단계·남은 프로세스로 보류와 알림)을 쓰고, 판정 전인 검수는 마무리 뒤 같은 프로듀서에게 다시 뜬다', async () => {
    const e = (env = await bootOrch());
    const old = e.producerId;
    const name = e.ctx.store.members.require(old).name;
    const { task, proc } = await startReview(e, old);
    const rk = reviewKey(task.id);
    const since = e.launches.length;
    const g = gateTerminate(proc, { ok: true, remaining: 0, detail: '가짜 종료' });
    const openFinish = holdFinish(e, proc);
    const mp = await mainTurnUp(e);
    const call = e.tool(mp.turnId, 'replace_producer', { project_id: e.projectId, reason: '프로듀서가 멈춤 (시험)' });
    await waitFor(g.called, 'replace_producer가 그 프로듀서의 정지를 기다림');
    await cutCaller(e, mp, 'crash');
    g.open();
    const r = await call;
    expect(!r.ok && r.message).toBe(
      `${turnGone('replace_producer')} (프로듀서 ${name}(${old})의 턴은 이미 멈췄습니다 — 프로듀서는 그대로이고, ${rk} 턴은 마무리가 아직 끝나지 않았습니다 — 끝나면 프로그램이 셋 중 하나를 합니다: ` +
        `멈춘 검수(작업 ${task.id})를 같은 프로듀서 앞 대기열에 다시 넣거나, 이미 낸 통과 판정의 다음 단계(병합 판단·산출물 확정)를 이어 가거나, ` +
        `하위 프로세스가 남았으면 작업 ${task.id}을(를) 보류하고 확인하라는 알림을 메인 에이전트에게 넣습니다 (어느 쪽이 될지는 그 마무리가 끝나야 정해집니다))`,
    );
    // 판정 전인 검수 — 마무리 뒤 그 판정이 같은 프로듀서 앞에 다시 넣고, 그 턴으로 다시 뜬다(보류·알림 없음)
    await finishNow(e, proc, openFinish);
    expect(e.ctx.store.queue.list({ ref2: rk, state: ['queued', 'running'] }).map((q) => [q.kind, q.memberId])).toEqual([['review', old]]);
    expect(mainAlertIds(e, alertKey('kill-failed', task.id))).toEqual([]);
    expect(await relaunchedOn(e, rk, since)).toEqual([old]);
  }, 40_000);

  // 관리 턴 — 판정은 남은 프로세스를 막은 뒤에도 관리 업무를 다시 넣는다. 그래서 '셋 중 하나'가 아니라 둘을 함께 쓰고, 실제로 둘 다 일어난다
  for (const how of ['plain', 'paused', 'heir'] as const) {
    const where = how === 'heir' ? '새 프로듀서' : '같은 프로듀서';
    const block = how === 'plain' ? '프로듀서를 일시정지하고 재개 업무' : how === 'paused' ? '일시정지는 그대로 두고 알림' : '삭제된 팀원이라 그 세션의 알림';
    it(`관리 턴 · ${how}: 마무리가 상한을 넘기면 — 멈춘 관리 업무를 ${where} 앞에 다시 넣는 것과 남은 프로세스 갈래(${block})를 함께 쓰고, 마무리가 남은 프로세스를 찾으면 실제로 둘 다 일어난다`, async () => {
      const e = (env = await bootOrch());
      const old = e.producerId;
      const name = e.ctx.store.members.require(old).name;
      const { dk, proc } = await producerTurnGated(e);
      // 정지 결과는 확인(ok) — 프로세스가 끝나며 남은 하위 프로세스 2개를 알린다
      const g = gateTerminate(proc, { ok: true, remaining: 0, detail: '가짜 종료' }, 2);
      const openFinish = holdFinish(e, proc);
      let message: string;
      let now = old;
      if (how === 'heir') {
        const two = await twoReplaces(e, g);
        expect(two.refused.code).toBe('conflict');
        now = two.now;
        message = two.refused.message;
      } else {
        const mp = await mainTurnUp(e);
        const call = e.tool(mp.turnId, 'replace_producer', { project_id: e.projectId, reason: '프로듀서가 멈춤 (시험)' });
        await waitFor(g.called, 'replace_producer가 그 프로듀서의 정지를 기다림');
        // 기다리는 사이 메인이 그 프로듀서를 일시정지한다 — 멈추고 있는 턴은 건드리지 않고 정지 기록만 남는다
        if (how === 'paused') await e.main('pause_member', { member_id: old, mode: 'graceful', reason: '멈춤 (시험)' });
        await cutCaller(e, mp, 'crash');
        g.open();
        const r = await call;
        expect(!r.ok && r.code).toBe('stopped');
        message = r.ok ? '' : r.message;
      }
      const who = (id: string) => `${e.ctx.store.members.require(id).name}(${id})`;
      const text =
        `${dk} 턴은 마무리가 아직 끝나지 않았습니다 — 끝나면 프로그램이 멈춘 관리 업무를 ${how === 'heir' ? `새 프로듀서 ${who(now)}` : '같은 프로듀서'} 앞 대기열에 다시 넣고(그 지시가 아직 열려 있으면), ` +
        `하위 프로세스가 남았으면 ${
          how === 'plain'
            ? '이 프로듀서를 일시정지하고 확인하라는 업무를 메인 에이전트에게 넣습니다'
            : how === 'paused'
              ? '이미 일시정지된 이 프로듀서는 그대로 두고 그 확인을 메인 에이전트에게 맡깁니다'
              : '삭제된 팀원이라 일시정지하지 않고 그 세션의 남은 프로세스를 확인하라는 알림을 메인 에이전트에게 넣습니다'
        }`;
      expect(message).toBe(
        how === 'heir'
          ? `프로젝트 ${e.projectId}의 프로듀서가 그사이 이미 바뀌었습니다 (${who(now)}) — 지금 프로듀서를 확인하세요 (프로듀서 ${name}(${old})의 턴은 이미 멈췄습니다 — 프로듀서는 그사이 ${who(now)}(으)로 바뀌었고, ${text})`
          : `${turnGone('replace_producer')} (프로듀서 ${name}(${old})의 턴은 이미 멈췄습니다 — 프로듀서는 그대로이고, ${text})`,
      );
      expect(message).not.toContain('같은 프로듀서가 잇습니다');
      await finishNow(e, proc, openFinish);
      const main = e.ctx.store.queue.list({ ref1: MAIN_AGENT_ID, state: ['queued', 'running'] });
      // 실제로 일어난 것 — 관리 업무를 다시 넣었고(그 프로듀서 앞), 남은 프로세스는 적힌 대로 막혔다
      expect([...new Set(e.ctx.store.queue.list({ ref2: dk, state: ['queued', 'running'] }).filter((q) => q.turnId !== proc.turnId).map((q) => q.memberId))]).toEqual([now]);
      if (how === 'plain') {
        expect(e.ctx.stop().members[old]).toMatchObject({ paused: true, by: 'system' });
        expect(main.filter((q) => q.pausedMemberId === old)).toHaveLength(1);
      } else if (how === 'paused') {
        expect(e.ctx.stop().members[old]).toMatchObject({ paused: true, by: MAIN_AGENT_ID });
        expect(main.filter((q) => q.pausedMemberId === old)).toEqual([]);
        expect(mainAlertIds(e, alertKey('kill-failed', old))).toHaveLength(1);
      } else {
        expect(e.ctx.stop().members[old]).toBeUndefined();
        expect(mainAlertIds(e, alertKey('kill-failed', dk))).toHaveLength(1);
      }
    }, 40_000);
  }

  // 기다리는 사이 다른 교체가 먼저 바꿨다 — 그 교체가 넘긴 곳(지금 사실)과 남은 프로세스 갈래만. 같은 프로듀서가 잇는다고 하지 않는다 (리드 결정 S5-84·S5-87 5).
  // task-kept: 이긴 교체의 재배정을 그 작업이 받지 않았다(병합 중 등 — 교체는 그 작업 하나 때문에 멈추지 않는다). 작업은 지운 프로듀서에게 남아도 그가 이을 일은 없다
  for (const kind of ['task', 'review', 'task-kept'] as const) {
    it(`두 교체가 함께 프로듀서의 ${kind === 'review' ? '검수' : '작업'} 턴을 멈추고 그 마무리가 상한을 넘기면${kind === 'task-kept' ? '(그 작업은 재배정을 받지 않음)' : ''} — 진 쪽의 거부 글은 지금 사실과 남은 프로세스 갈래만 쓰고, 마무리가 남은 프로세스를 찾으면 실제로 그 작업을 보류하고 메인에게 알린다`, async () => {
      const e = (env = await bootOrch());
      const old = e.producerId;
      const oldName = e.ctx.store.members.require(old).name;
      let taskId: string;
      let key: string;
      let proc: FakeProc;
      if (kind !== 'review') ({ taskId, key, proc } = await producerTaskTurnUp(e));
      else {
        const started = await startReview(e, old);
        taskId = started.task.id;
        key = reviewKey(taskId);
        proc = started.proc;
      }
      if (kind === 'task-kept') {
        vi.spyOn(e.core.tasks, 'reassign').mockImplementation(() => {
          throw new Error('재배정을 받지 않음 (시험)');
        });
      }
      const g = gateTerminate(proc, { ok: true, remaining: 0, detail: '가짜 종료' }, 2);
      const openFinish = holdFinish(e, proc);
      const { refused, now } = await twoReplaces(e, g);
      const who = (id: string) => `${e.ctx.store.members.require(id).name}(${id})`;
      const t = e.ctx.store.tasks.require(taskId);
      // 지금 사실 — 이긴 교체가 그 일을 넘겼다: 작업은 새 프로듀서에게 재배정(대기), 검수는 다시 고른 검수자에게. 재배정을 받지 않은 작업은 진행 그대로
      if (kind === 'task') expect([t.assigneeId, t.state]).toEqual([now, 'waiting']);
      else if (kind === 'review') expect(t.reviewerId && t.reviewerId !== old).toBe(true);
      else expect([t.assigneeId, t.state]).toEqual([old, 'in_progress']);
      const where =
        kind === 'task'
          ? `멈춘 작업 ${taskId}은(는) ${who(now)}에게 재배정됐습니다 (작업 상태: ${TASK_STATE_LABEL.waiting})`
          : kind === 'review'
            ? `멈춘 검수(작업 ${taskId})는 검수자 ${who(t.reviewerId!)}에게 넘어갔습니다`
            : `작업 ${taskId}은(는) 지금 ${TASK_STATE_LABEL.in_progress} 상태입니다`;
      expect(refused.code).toBe('conflict');
      expect(refused.message).toBe(
        `프로젝트 ${e.projectId}의 프로듀서가 그사이 이미 바뀌었습니다 (${who(now)}) — 지금 프로듀서를 확인하세요 ` +
          `(프로듀서 ${oldName}(${old})의 턴은 이미 멈췄습니다 — 프로듀서는 그사이 ${who(now)}(으)로 바뀌었고, ${where} — ${key} 턴의 마무리는 아직 끝나지 않았고, ` +
          `끝나서 하위 프로세스가 남았으면 프로그램이 작업 ${taskId}을(를) 보류하고 확인하라는 알림을 메인 에이전트에게 넣습니다)`,
      );
      expect(refused.message).not.toContain('같은 프로듀서');
      // 적힌 대로 — 마무리가 남은 프로세스를 찾아 그 작업을 보류하고 메인에게 알린다. 지운 프로듀서에게 맡긴 일·기록은 없다
      await finishNow(e, proc, openFinish);
      const after = e.ctx.store.tasks.require(taskId);
      expect([after.state, after.hold.reasons.map((x) => x.kind).includes('error')]).toEqual(['on_hold', true]);
      expect(mainAlertIds(e, alertKey('kill-failed', taskId))).toHaveLength(1);
      expect(e.ctx.store.activity.search({ text: '프로듀서 교체를 하지 않아', limit: 20 })).toEqual([]);
      expect(e.ctx.store.queue.list({ ref2: key, state: ['queued', 'running'] }).filter((q) => q.memberId === old)).toEqual([]);
    }, 40_000);
  }

  it('보류된 작업의 턴: 마무리가 상한을 넘기면 — 보류가 풀리면 잇는다는 지금 사실과 남은 프로세스 갈래(그 보류에 사유를 더함)를 쓰고, 마무리가 남은 프로세스를 찾으면 실제로 그 보류에 사유를 더하고 메인에게 알린다', async () => {
    const e = (env = await bootOrch());
    const old = e.producerId;
    const name = e.ctx.store.members.require(old).name;
    const { taskId, key, proc } = await producerTaskTurnUp(e);
    // 메인이 그 프로듀서를 단계 마치고 일시정지한다 — 맡은 작업은 보류되고, 작업 턴은 단계를 마칠 때까지 돈다
    await e.main('pause_member', { member_id: old, mode: 'graceful', reason: '멈춤 (시험)' });
    const before = e.ctx.store.tasks.require(taskId);
    expect(before.state).toBe('on_hold');
    const g = gateTerminate(proc, { ok: true, remaining: 0, detail: '가짜 종료' }, 2);
    const openFinish = holdFinish(e, proc);
    const mp = await mainTurnUp(e);
    const call = e.tool(mp.turnId, 'replace_producer', { project_id: e.projectId, reason: '프로듀서가 멈춤 (시험)' });
    await waitFor(g.called, 'replace_producer가 그 프로듀서의 정지를 기다림');
    await cutCaller(e, mp, 'crash');
    g.open();
    const r = await call;
    expect(r).toEqual({
      ok: false,
      code: 'stopped',
      message:
        `${turnGone('replace_producer')} (프로듀서 ${name}(${old})의 턴은 이미 멈췄습니다 — 프로듀서는 그대로이고, 작업 ${taskId}은(는) 보류돼 있어 그 보류가 풀리면 이어 갑니다 — ` +
        `${key} 턴의 마무리는 아직 끝나지 않았고, 끝나서 하위 프로세스가 남았으면 프로그램이 그 보류에 남은 프로세스 사유를 더하고 확인하라는 알림을 메인 에이전트에게 넣습니다)`,
    });
    expect(mainAlertIds(e, alertKey('kill-failed', taskId))).toEqual([]);
    await finishNow(e, proc, openFinish);
    // 적힌 대로 — 앞의 보류 사유는 그대로이고 남은 프로세스 사유가 더해졌으며, 메인에게 알림이 갔다. 다시 맡긴 일은 없다
    const after = e.ctx.store.tasks.require(taskId);
    expect(after.state).toBe('on_hold');
    expect(after.hold.reasons.map((x) => x.kind)).toEqual([...before.hold.reasons.map((x) => x.kind), 'error']);
    expect(mainAlertIds(e, alertKey('kill-failed', taskId))).toHaveLength(1);
    expect(e.ctx.store.queue.list({ ref2: key, state: ['queued', 'running'] }).filter((q) => q.turnId !== proc.turnId && q.kind !== 'message')).toEqual([]);
    expect(e.ctx.store.activity.search({ text: '프로듀서 교체를 하지 않아', limit: 20 })).toEqual([]);
  }, 40_000);

  // 기다리는 사이 작업의 상태가 바뀐 경우(중단 뒤 대기로 돌아감·취소 등 다른 처리가 바꾼 것을 저장소에서 흉내 낸다) — 같은 프로듀서가 이을 일은 없다
  for (const state of ['waiting', 'cancelled'] as const) {
    it(`기다리는 사이 작업이 ${TASK_STATE_LABEL[state]} 상태가 되면 — 그 사실을 쓰고 ${state === 'cancelled' ? '끝난 작업에는 보류도 알림도 쓰지 않는다' : '남은 프로세스 갈래를 쓴다'}. 마무리 뒤 실제로도 그렇다`, async () => {
      const e = (env = await bootOrch());
      const old = e.producerId;
      const name = e.ctx.store.members.require(old).name;
      const { taskId, key, proc } = await producerTaskTurnUp(e);
      const g = gateTerminate(proc, { ok: true, remaining: 0, detail: '가짜 종료' }, 2);
      const openFinish = holdFinish(e, proc);
      const mp = await mainTurnUp(e);
      const call = e.tool(mp.turnId, 'replace_producer', { project_id: e.projectId, reason: '프로듀서가 멈춤 (시험)' });
      await waitFor(g.called, 'replace_producer가 그 프로듀서의 정지를 기다림');
      await cutCaller(e, mp, 'crash');
      g.open();
      e.ctx.store.tasks.patch(taskId, { state } as never);
      const r = await call;
      const fact =
        state === 'cancelled'
          ? `작업 ${taskId}은(는) 지금 ${TASK_STATE_LABEL.cancelled} 상태입니다 — ${key} 턴의 마무리는 아직 끝나지 않았습니다`
          : `작업 ${taskId}은(는) 지금 ${TASK_STATE_LABEL.waiting} 상태입니다 — ${key} 턴의 마무리는 아직 끝나지 않았고, 끝나서 하위 프로세스가 남았으면 프로그램이 작업 ${taskId}을(를) 보류하고 확인하라는 알림을 메인 에이전트에게 넣습니다`;
      expect(r).toEqual({ ok: false, code: 'stopped', message: `${turnGone('replace_producer')} (프로듀서 ${name}(${old})의 턴은 이미 멈췄습니다 — 프로듀서는 그대로이고, ${fact})` });
      await finishNow(e, proc, openFinish);
      const after = e.ctx.store.tasks.require(taskId);
      expect({ state: after.state, alerts: mainAlertIds(e, alertKey('kill-failed', taskId)).length }).toEqual(state === 'cancelled' ? { state: 'cancelled', alerts: 0 } : { state: 'on_hold', alerts: 1 });
      expect(e.ctx.store.queue.list({ ref2: key, state: ['queued', 'running'] }).filter((q) => q.turnId !== proc.turnId && q.kind !== 'message')).toEqual([]);
      expect(e.ctx.store.activity.search({ text: '프로듀서 교체를 하지 않아', limit: 20 })).toEqual([]);
    }, 40_000);
  }

  // 다른 교체 없이(이을 사람이 정해지지 않음) 기다리는 사이 작업이 재배정되거나 검수자가 바뀐 경우 — 메인이 함께 부른 reassign_task·change_reviewer를 저장소에서 흉내 낸다.
  // 같은 프로듀서의 셋은 그 프로듀서가 맡은(검수하는) 일일 때만 쓴다 — 담당·검수자를 보지 않으면 남의 일을 같은 프로듀서에게 다시 준다고 약속한다 (리드 결정 S5-90 4,
  // 프로브 zz-s5f9ti-reassigned-unsettled, 변이 own7:O16-t-task-assignee-unchecked·O16-t-review-reviewer-unchecked)
  for (const kind of ['task', 'review'] as const) {
    it(`기다리는 사이 ${kind === 'task' ? '작업이 다른 팀원에게 재배정되면' : '검수가 다른 검수자에게 넘어가면'}(다른 교체 없음) — 그 사실과 남은 프로세스 갈래만 쓰고 같은 프로듀서의 셋을 쓰지 않는다`, async () => {
      const e = (env = await bootOrch());
      const old = e.producerId;
      const name = e.ctx.store.members.require(old).name;
      let taskId: string;
      let key: string;
      let proc: FakeProc;
      if (kind === 'task') ({ taskId, key, proc } = await producerTaskTurnUp(e));
      else {
        const started = await startReview(e, old);
        taskId = started.task.id;
        key = reviewKey(taskId);
        proc = started.proc;
      }
      const g = gateTerminate(proc, { ok: true, remaining: 0, detail: '가짜 종료' }, 2);
      const openFinish = holdFinish(e, proc);
      const mp = await mainTurnUp(e);
      const call = e.tool(mp.turnId, 'replace_producer', { project_id: e.projectId, reason: '프로듀서가 멈춤 (시험)' });
      await waitFor(g.called, 'replace_producer가 그 프로듀서의 정지를 기다림');
      await cutCaller(e, mp, 'crash');
      g.open();
      e.ctx.store.tasks.patch(taskId, (kind === 'task' ? { assigneeId: e.devId } : { reviewerId: e.devId }) as never);
      const r = await call;
      const dev = `${e.ctx.store.members.require(e.devId).name}(${e.devId})`;
      const fact =
        (kind === 'task'
          ? `멈춘 작업 ${taskId}은(는) ${dev}에게 재배정됐습니다 (작업 상태: ${TASK_STATE_LABEL.in_progress})`
          : `멈춘 검수(작업 ${taskId})는 검수자 ${dev}에게 넘어갔습니다`) +
        ` — ${key} 턴의 마무리는 아직 끝나지 않았고, 끝나서 하위 프로세스가 남았으면 프로그램이 작업 ${taskId}을(를) 보류하고 확인하라는 알림을 메인 에이전트에게 넣습니다`;
      expect(r).toEqual({ ok: false, code: 'stopped', message: `${turnGone('replace_producer')} (프로듀서 ${name}(${old})의 턴은 이미 멈췄습니다 — 프로듀서는 그대로이고, ${fact})` });
      expect(!r.ok && r.message).not.toContain('같은 프로듀서');
      // 적힌 대로 — 마무리가 남은 프로세스를 찾아 그 작업을 보류하고 메인에게 알린다. 같은 프로듀서에게 맡긴 일·기록은 없다
      await finishNow(e, proc, openFinish);
      const after = e.ctx.store.tasks.require(taskId);
      expect([after.state, after.hold.reasons.map((x) => x.kind).includes('error')]).toEqual(['on_hold', true]);
      expect(mainAlertIds(e, alertKey('kill-failed', taskId))).toHaveLength(1);
      expect(e.ctx.store.activity.search({ text: '프로듀서 교체를 하지 않아', limit: 20 })).toEqual([]);
      expect(e.ctx.store.queue.list({ ref2: key, state: ['queued', 'running'] }).filter((q) => q.memberId === old && q.turnId !== proc.turnId)).toEqual([]);
    }, 40_000);
  }
});

/**
 * 같은 프로듀서를 바꾸는 다른 교체 요청이 아직 진행 중일 때 거부한 글 (리드 결정 S5-90 1) — 그 요청이 바꿀 수 있으므로 '프로듀서는 그대로'·'같은 프로듀서'라고 하지
 * 않고, 다른 교체 요청이 진행 중이라는 것만 쓴다. 지금 프로듀서와 그 일은 현황(get_overview)으로 확인한다
 */
const inFlightText = (keys: string[], unsettled: string[] = []): string =>
  `이 프로듀서를 바꾸는 다른 교체 요청이 아직 진행 중이라, 멈춘 ${keys.map((k) => `${k} 턴`).join('·')}의 일을 누가 이을지는 그 요청이 끝나야 정해집니다` +
  `${unsettled.length ? ` (${unsettled.map((k) => `${k} 턴`).join('·')}은 마무리도 아직 끝나지 않았습니다)` : ''} — 지금 프로듀서와 그 일은 get_overview로 확인하세요`;

describe('같은 프로듀서를 바꾸는 다른 교체 요청이 기다리는 사이의 거부 — 결과를 말하지 않고, 멈춘 일은 그 요청이 정한다 (리드 결정 S5-90 1, 프로브 zz-s5af10r-flows H1·zz-s5af10-inflight H2)', () => {
  /** 메인 턴의 교체 L과 운영자의 교체 W가 같은 정지를 기다리게 한다 — first가 먼저 부른다. L을 부른 메인 턴은 그 기다림 사이 끝난다(비정상 종료) */
  async function loserAndWinner(e: OrchEnv, g: { count: () => number; open: () => void }, first: 'loser' | 'winner') {
    const mp = await mainTurnUp(e);
    const startLoser = () => e.tool(mp.turnId, 'replace_producer', { project_id: e.projectId, reason: '교체 L (시험)' });
    const startWinner = () =>
      e.main('replace_producer', { project_id: e.projectId, reason: '교체 W (시험)' }).then(
        () => ({ ok: true as const, message: '' }),
        (x: Error & { code?: string }) => ({ ok: false as const, message: `${x.code}: ${x.message}` }),
      );
    let loser: ReturnType<typeof startLoser>;
    let winner: ReturnType<typeof startWinner>;
    if (first === 'loser') {
      loser = startLoser();
      await waitFor(() => g.count() >= 1, 'L이 정지를 기다림');
      winner = startWinner();
    } else {
      winner = startWinner();
      await waitFor(() => g.count() >= 1, 'W가 정지를 기다림');
      loser = startLoser();
    }
    await waitFor(() => g.count() >= 2, '둘째 교체도 정지를 기다림');
    await cutCaller(e, mp, 'crash');
    g.open();
    return { mp, loser, winner };
  }
  const mainRow = (e: OrchEnv, mp: FakeProc, already: string) =>
    e.ctx.store.activity.search({ text: `메인 턴 ${mp.turnId}이(가) 처리하며 기다리는 사이 끝났거나 종료 요청을 받아 replace_producer을(를) 마치지 않음 — ${already}`, limit: 5 }).map((a) => a.memberId);

  for (const first of ['loser', 'winner'] as const) {
    it(`정지가 확인되고 마무리도 끝난 작업 턴 · ${first === 'loser' ? 'L의 기다림이 먼저 끝남' : 'W가 먼저 바꿈'}: L의 글은 ${first === 'loser' ? '다른 교체 요청이 진행 중이라는 것만' : '이을 사람과 그 일이 간 곳'} — 그 일은 W가 바꾼 새 프로듀서가 잇고 이전 프로듀서 몫은 없다`, async () => {
      const e = (env = await bootOrch());
      const old = e.producerId;
      const name = e.ctx.store.members.require(old).name;
      const { taskId, key, proc } = await producerTaskTurnUp(e);
      const since = e.launches.length;
      const g = gateTerminate(proc, { ok: true, remaining: 0, detail: '가짜 종료' });
      const { mp, loser, winner } = await loserAndWinner(e, g, first);
      const [rl, rw] = await Promise.all([loser, winner]);
      const now = e.ctx.store.projects.require(e.projectId).producerId;
      const who = (id: string) => `${e.ctx.store.members.require(id).name}(${id})`;
      const t = e.ctx.store.tasks.require(taskId);
      // 실제로 일어난 것 — W가 바꿨고 그 작업은 새 프로듀서에게 재배정됐다
      expect(rw).toEqual({ ok: true, message: '' });
      expect(now).not.toBe(old);
      expect(t.assigneeId).toBe(now);
      const already =
        first === 'loser'
          ? `프로듀서 ${name}(${old})의 턴은 이미 멈췄습니다 — ${inFlightText([key])}`
          : `프로듀서 ${name}(${old})의 턴은 이미 멈췄습니다 — 프로듀서는 그사이 ${who(now)}(으)로 바뀌었고, 멈춘 작업 ${taskId}은(는) ${who(now)}에게 재배정됐습니다 (작업 상태: ${TASK_STATE_LABEL[t.state]})`;
      expect(rl).toEqual({ ok: false, code: 'stopped', message: `${turnGone('replace_producer')} (${already})` });
      expect(!rl.ok && rl.message).not.toContain('프로듀서는 그대로');
      expect(!rl.ok && rl.message).not.toContain('같은 프로듀서');
      expect(!rl.ok && rl.message).not.toContain('그 프로듀서가 잇습니다');
      // 그 기록도 같은 글 — 메인 에이전트의 줄
      expect(mainRow(e, mp, already)).toEqual([MAIN_AGENT_ID]);
      // L은 이전 프로듀서에게 다시 맡기지 않았다 — 그 일은 W의 교체와 함께 새 프로듀서에게 가고 그 턴으로 다시 뜬다
      expect(e.ctx.store.activity.search({ text: '프로듀서 교체를 하지 않아', limit: 20 })).toEqual([]);
      expect(e.ctx.store.queue.list({ ref2: key, state: ['queued', 'running'] }).filter((q) => q.memberId === old)).toEqual([]);
      expect(await relaunchedOn(e, key, since)).toEqual([now]);
    }, 40_000);
  }

  for (const kind of ['task', 'directive'] as const) {
    it(`정지는 확인됐지만 마무리가 상한을 넘긴 ${kind === 'task' ? '작업' : '관리'} 턴 · L의 기다림이 먼저 끝남: L의 글은 다른 교체 요청이 진행 중이라는 것과 마무리가 아직이라는 것만 — W가 바꾸고, 마무리 뒤 그 일은 새 프로듀서가 잇는다`, async () => {
      const e = (env = await bootOrch());
      const old = e.producerId;
      const name = e.ctx.store.members.require(old).name;
      let key: string;
      let taskId: string | null = null;
      let proc: FakeProc;
      if (kind === 'task') ({ taskId, key, proc } = await producerTaskTurnUp(e));
      else {
        const d = seedDirective(e);
        key = directiveKey(d.id);
        e.hold.add(key);
        enqueue(e.ctx, { kind: 'message', memberId: old, sessionKey: key, projectId: e.projectId, directiveId: d.id, message: '진행 상황을 정리해 주세요 (시험)' });
        await waitFor(() => {
          if (!e.liveProc(key, old)) e.tick();
          return !!e.liveProc(key, old);
        }, '프로듀서 관리 턴');
        proc = e.liveProc(key, old)!;
      }
      const since = e.launches.length;
      const g = gateTerminate(proc, { ok: true, remaining: 0, detail: '가짜 종료' });
      const openFinish = holdFinish(e, proc);
      const { mp, loser, winner } = await loserAndWinner(e, g, 'loser');
      const rl = await loser;
      const already = `프로듀서 ${name}(${old})의 턴은 이미 멈췄습니다 — ${inFlightText([key], [key])}`;
      expect(rl).toEqual({ ok: false, code: 'stopped', message: `${turnGone('replace_producer')} (${already})` });
      expect(!rl.ok && rl.message).not.toContain('프로듀서는 그대로');
      expect(!rl.ok && rl.message).not.toContain('같은 프로듀서');
      expect(mainRow(e, mp, already)).toEqual([MAIN_AGENT_ID]);
      expect(await winner).toEqual({ ok: true, message: '' });
      const now = e.ctx.store.projects.require(e.projectId).producerId;
      expect(now).not.toBe(old);
      // 마무리가 끝나면 — 그 일은 새 프로듀서 몫이고 이전 프로듀서에게 간 일·다시 맡긴 기록은 없다
      openFinish();
      await waitFor(() => !!e.ctx.store.turns.require(proc.turnId).endedAt, '멈춘 턴의 마무리가 끝남');
      await e.core.turns.turnFlow(proc.turnId);
      if (taskId) expect(e.ctx.store.tasks.require(taskId).assigneeId).toBe(now);
      expect(e.ctx.store.queue.list({ ref2: key, state: ['queued', 'running'] }).filter((q) => q.turnId !== proc.turnId && q.memberId === old)).toEqual([]);
      expect(e.ctx.store.activity.search({ text: '프로듀서 교체를 하지 않아', limit: 20 })).toEqual([]);
      expect(await relaunchedOn(e, key, since)).toEqual([now]);
    }, 40_000);
  }

  it('세 교체 — W1이 먼저 바꾸면, W2가 아직 진행 중이어도 L의 글은 이을 사람과 그 일이 간 곳을 쓴다(이미 정해졌다). W2는 conflict, 남는 프로듀서는 하나', async () => {
    const e = (env = await bootOrch());
    const old = e.producerId;
    const name = e.ctx.store.members.require(old).name;
    const { taskId, key, proc } = await producerTaskTurnUp(e);
    const since = e.launches.length;
    const g = gateTerminate(proc, { ok: true, remaining: 0, detail: '가짜 종료' });
    const mp = await mainTurnUp(e);
    const op = (reason: string) =>
      e.main('replace_producer', { project_id: e.projectId, reason }).then(
        () => ({ ok: true as const, code: null }),
        (x: Error & { code?: string }) => ({ ok: false as const, code: x.code ?? 'error' }),
      );
    const w1 = op('교체 W1 (시험)');
    await waitFor(() => g.count() >= 1, 'W1이 정지를 기다림');
    const loser = e.tool(mp.turnId, 'replace_producer', { project_id: e.projectId, reason: '교체 L (시험)' });
    await waitFor(() => g.count() >= 2, 'L이 정지를 기다림');
    const w2 = op('교체 W2 (시험)');
    await waitFor(() => g.count() >= 3, 'W2가 정지를 기다림');
    await cutCaller(e, mp, 'crash');
    g.open();
    const [r1, rl, r2] = await Promise.all([w1, loser, w2]);
    const now = e.ctx.store.projects.require(e.projectId).producerId;
    const who = (id: string) => `${e.ctx.store.members.require(id).name}(${id})`;
    const t = e.ctx.store.tasks.require(taskId);
    expect([r1, r2]).toEqual([
      { ok: true, code: null },
      { ok: false, code: 'conflict' },
    ]);
    expect(e.ctx.store.members.list({ project_id: e.projectId }).filter((m) => m.isProducer && !m.deletedAt).map((m) => m.id)).toEqual([now]);
    expect(t.assigneeId).toBe(now);
    const already = `프로듀서 ${name}(${old})의 턴은 이미 멈췄습니다 — 프로듀서는 그사이 ${who(now)}(으)로 바뀌었고, 멈춘 작업 ${taskId}은(는) ${who(now)}에게 재배정됐습니다 (작업 상태: ${TASK_STATE_LABEL[t.state]})`;
    expect(rl).toEqual({ ok: false, code: 'stopped', message: `${turnGone('replace_producer')} (${already})` });
    expect(e.ctx.store.activity.search({ text: '프로듀서 교체를 하지 않아', limit: 20 })).toEqual([]);
    expect(await relaunchedOn(e, key, since)).toEqual([now]);
  }, 40_000);

  it('L이 거부한 뒤 W가 바꾸지도 거부하지도 못하고 오류로 끝나면 — L이 남겨 둔 멈춘 작업을 그 끝이 같은 프로듀서에게 맡긴다(멈춘 일을 남기지 않음, 리드 결정 S5-73 2)', async () => {
    const e = (env = await bootOrch());
    const old = e.producerId;
    const name = e.ctx.store.members.require(old).name;
    const { taskId, key, proc } = await producerTaskTurnUp(e);
    const since = e.launches.length;
    const g = gateTerminate(proc, { ok: true, remaining: 0, detail: '가짜 종료' });
    // 둘째로 결과를 세는 호출(W)은 센 뒤에 오류로 끝난다 — 거부 길(멈춘 일을 맡김)을 지나지 않는다
    const settle = e.core.turns.settleTurns.bind(e.core.turns);
    let n = 0;
    vi.spyOn(e.core.turns, 'settleTurns').mockImplementation(async (ids, ms) => {
      const mine = ++n;
      const done = await settle(ids, ms);
      if (mine === 2) throw new Error('정지 결과를 세지 못함 (시험)');
      return done;
    });
    const { mp, loser, winner } = await loserAndWinner(e, g, 'loser');
    const [rl, rw] = await Promise.all([loser, winner]);
    const already = `프로듀서 ${name}(${old})의 턴은 이미 멈췄습니다 — ${inFlightText([key])}`;
    expect(rl).toEqual({ ok: false, code: 'stopped', message: `${turnGone('replace_producer')} (${already})` });
    expect(mainRow(e, mp, already)).toEqual([MAIN_AGENT_ID]);
    expect(rw.ok).toBe(false);
    expect(rw.message).toContain('정지 결과를 세지 못함 (시험)');
    // 바뀌지 않았다 — 멈춘 작업은 진행 중 그대로 같은 프로듀서 앞에 이어서 할 일이 하나 있고, 그 기록도 하나다. 실제로 그 프로듀서의 턴으로 다시 뜬다
    expect(e.ctx.store.projects.require(e.projectId).producerId).toBe(old);
    expect(e.ctx.store.tasks.require(taskId)).toMatchObject({ state: 'in_progress', assigneeId: old });
    const work = e.ctx.store.queue.list({ ref2: key, state: ['queued', 'running'] }).filter((q) => q.turnId !== proc.turnId && q.kind !== 'message');
    expect(work.map((q) => [q.kind, q.memberId])).toEqual([['task_work', old]]);
    expect(e.ctx.store.activity.search({ text: `${taskId} 프로듀서 교체를 하지 않아, 그 정지로 멈춘 작업 턴을 ${name}(${old})에게 다시 맡김`, limit: 5 })).toHaveLength(1);
    expect(await relaunchedOn(e, key, since)).toEqual([old]);
  }, 40_000);
});

/** 메인 턴 X(main:P)에서 git_merge 복구 확인을 정하는 resolve_recovery(applied) — 그 알림은 이미 받았고, git.log에서 문으로 기다린다 */
async function recoveryCallGated(e: OrchEnv) {
  const mk = mainKey(e.projectId);
  const proc = await mainTurnUp(e, mk);
  const d = seedDirective(e);
  const t = e.core.tasks.create({ directiveId: d.id, title: '결제 화면', goal: '결제 화면', type: 'development', assigneeId: e.devId, acceptanceCriteria: ['동작한다'], outputMode: 'repo', prerequisiteIds: [] }, e.producerId);
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
  // 그 알림은 메인이 이미 받았다 — 한 번 거부(S5-50·S5-56)가 걸리지 않는 경우
  for (const q of e.ctx.store.queue.list({ ref1: MAIN_AGENT_ID, state: 'queued' }).filter((q) => q.alertKey === alertKey('recovery', 'X-3001'))) {
    e.ctx.store.queue.put({ ...q, state: 'done', doneAt: e.ctx.now() });
  }
  const merged = [{ sha: 'c'.repeat(40), parents: [], subject: `[${t.id}] 병합`, body: `Wook-Task: ${t.id}` }];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  gates.push(() => release());
  let called = false;
  vi.spyOn(e.ctx.deps.git, 'log').mockImplementation(async () => {
    called = true;
    await gate;
    return merged;
  });
  const call = e.tool(proc.turnId, 'resolve_recovery', { recovery_id: 'X-3001', action: 'applied', reason: '병합 커밋 확인' });
  await waitFor(() => called, 'resolve_recovery가 git.log를 부름');
  return { t, mk, proc, call, release, merged };
}

/** 복구 확인을 정하지 않았다 — 실행 기록은 '모름', 작업은 복구 확인 보류 그대로 */
function recoveryUntouched(e: OrchEnv, taskId: string): void {
  expect(e.ctx.store.execs.require('X-3001').state).toBe('unknown');
  const t = e.ctx.store.tasks.require(taskId);
  expect(t.state).toBe('on_hold');
  expect(t.hold.reasons.map((r) => r.kind)).toContain('recovery_check');
}

describe('resolve_recovery — 병합 커밋을 찾는 git.log를 기다리는 사이 (리드 결정 S5-63)', () => {
  it('자리가 바뀌면(세대 1 → 2) 정하지 않는다 — seat_changed, 복구 확인은 그대로이고 그 뒤 새 쪽이 정할 수 있다', async () => {
    const e = (env = await bootOrch());
    const { t, mk, call, release, merged } = await recoveryCallGated(e);
    const swap = await forceSwap(e, mk);
    await swap.done;
    release();
    const r = await call;
    expect(r).toEqual({ ok: false, code: 'seat_changed', message: seatChanged('resolve_recovery') });
    recoveryUntouched(e, t.id);
    vi.restoreAllMocks();
    vi.spyOn(e.ctx.deps.git, 'log').mockResolvedValue(merged);
    expect(await e.main('resolve_recovery', { recovery_id: 'X-3001', action: 'applied' })).toMatchObject({ recoveryId: 'X-3001', state: 'succeeded' });
  });

  it('부른 메인 턴이 자리 교체 없이 끝나도(비정상 종료) 정하지 않는다 — stopped, 복구 확인은 그대로', async () => {
    const e = (env = await bootOrch());
    const { t, proc, call, release } = await recoveryCallGated(e);
    proc.exit(1);
    await waitFor(() => !!e.ctx.store.turns.require(proc.turnId).endedAt, '부른 메인 턴이 끝남');
    release();
    const r = await call;
    expect(!r.ok && r.code).toBe('stopped');
    expect(!r.ok && r.message).toBe(turnGone('resolve_recovery'));
    recoveryUntouched(e, t.id);
  });

  it('긴급 정지로 그 턴이 끝나도 같다 — 정하지 않는다', async () => {
    const e = (env = await bootOrch());
    const { t, call, release } = await recoveryCallGated(e);
    await e.invoke('stop.emergency');
    await waitFor(() => e.core.turns.count() === 0, '긴급 정지로 턴이 끝남');
    release();
    const r = await call;
    expect(!r.ok && r.code).toBe('stopped');
    recoveryUntouched(e, t.id);
  });

  it('부른 메인 턴이 아직 실행 중이어도 즉시 종료 요청을 받았으면 정하지 않는다 — 그 CLI는 곧 끝난다(정지 검사의 "이 턴의 종료 요청"과 같은 판정)', async () => {
    const e = (env = await bootOrch());
    const { t, proc, call, release } = await recoveryCallGated(e);
    // 그 턴의 종료 확인을 문으로 붙잡는다 — 정지 요청은 받았지만 턴은 아직 실행 중
    let openStop!: () => void;
    const stopGate = new Promise<void>((r) => (openStop = r));
    gates.push(() => openStop());
    (proc as unknown as { terminate: () => Promise<unknown> }).terminate = async () => {
      proc.terminatedByApp = true;
      await stopGate;
      proc.exit(null, { terminated: true });
      return { ok: true, remaining: 0, detail: '가짜 종료', durationMs: 1 };
    };
    const stopping = e.core.turns.stopMember(MAIN_AGENT_ID, '시험 정지', true);
    await waitFor(() => e.ctx.store.turns.require(proc.turnId).process.stopMode === 'immediate', '정지 요청');
    expect(e.core.turns.liveTurnIds()).toContain(proc.turnId);
    release();
    const r = await call;
    expect(!r.ok && r.code).toBe('stopped');
    recoveryUntouched(e, t.id);
    openStop();
    await stopping;
  });

  it('부른 메인 턴의 CLI가 끝나 마무리 중이면(아직 실행 중 목록에 있어도) 정하지 않는다', async () => {
    const e = (env = await bootOrch());
    const { t, proc, call, release } = await recoveryCallGated(e);
    // 그 턴의 마무리를 문으로 붙잡는다 — CLI는 끝났고 마무리를 시작했지만 실행 중 목록에서는 아직 빠지지 않았다
    let openFinish!: () => void;
    const finishGate = new Promise<void>((r) => (openFinish = r));
    gates.push(() => openFinish());
    let finishing = false;
    const settle = e.core.hostExec.settleTurn.bind(e.core.hostExec);
    vi.spyOn(e.core.hostExec, 'settleTurn').mockImplementation(async (turnId, why) => {
      if (turnId === proc.turnId) {
        finishing = true;
        await finishGate;
      }
      return settle(turnId, why);
    });
    proc.exit(1);
    await waitFor(() => finishing, '그 턴의 마무리 시작');
    expect(e.core.turns.liveTurnIds()).toContain(proc.turnId);
    release();
    const r = await call;
    expect(!r.ok && r.code).toBe('stopped');
    recoveryUntouched(e, t.id);
    openFinish();
  });
});

describe('그 밖의 기다림 — 처음 상태를 바꾸기 전에 기다리는 메인 도구는 모두 다시 본다 (리드 결정 S5-63)', () => {
  /** 메인 턴에서 부르고, 기다리는 동안 그 턴을 비정상 종료시킨 뒤 문을 연다 */
  async function cutDuringWait(e: OrchEnv, gate: { called: () => boolean; release: () => void }, tool: string, args: Record<string, unknown>): Promise<ToolCallResult> {
    const mp = await mainTurnUp(e);
    const call = e.tool(mp.turnId, tool, { reason: `시험: ${tool}`, ...args });
    await waitFor(gate.called, `${tool}이(가) 기다림`);
    mp.exit(1);
    await waitFor(() => !!e.ctx.store.turns.require(mp.turnId).endedAt, '부른 메인 턴이 끝남');
    gate.release();
    return call;
  }

  it('create_role — 스킬 찾기를 기다린 뒤 역할을 만들지 않는다', async () => {
    const e = (env = await bootOrch());
    const before = e.ctx.store.roles.list().length;
    const gate = gateOn(e.ctx.deps, 'scanSkills');
    const r = await cutDuringWait(e, gate, 'create_role', { name: '사운드', instructions: '효과음을 만든다', task_types: ['asset'], default_ai: { kind: 'claude', effort_tier: 'normal' }, allowed_skills: ['sound-gen'], can_review: false });
    expect(r).toEqual({ ok: false, code: 'stopped', message: turnGone('create_role') });
    expect(e.ctx.store.roles.list()).toHaveLength(before);
  });

  it('update_role — 스킬 찾기를 기다린 뒤 역할을 고치지 않는다', async () => {
    const e = (env = await bootOrch());
    const role = e.ctx.store.roles.require('developer');
    const gate = gateOn(e.ctx.deps, 'scanSkills');
    const r = await cutDuringWait(e, gate, 'update_role', { role_id: 'developer', name: '개발 (바뀜)', allowed_skills: [...role.allowedSkills, 'sound-gen'] });
    expect(r).toEqual({ ok: false, code: 'stopped', message: turnGone('update_role') });
    expect(e.ctx.store.roles.require('developer')).toEqual(role);
  });

  it('set_skill_mode — 스킬 찾기를 기다린 뒤 구분을 바꾸지 않는다', async () => {
    const e = (env = await bootOrch());
    const gate = gateOn(e.ctx.deps, 'scanSkills');
    const r = await cutDuringWait(e, gate, 'set_skill_mode', { name: 'sound-gen', mode: 'auto' });
    expect(r).toEqual({ ok: false, code: 'stopped', message: turnGone('set_skill_mode') });
    expect(e.ctx.settings().skills.overrides).toEqual({});
  });

  it('recheck_ai — CLI 확인을 기다린 뒤 가용성을 적지 않는다', async () => {
    const e = (env = await bootOrch());
    const before = e.ctx.ai('claude');
    const gate = gateOn(e.ctx.deps.adapters.claude, 'detect');
    const r = await cutDuringWait(e, gate, 'recheck_ai', { kind: 'claude' });
    expect(r).toEqual({ ok: false, code: 'stopped', message: turnGone('recheck_ai') });
    expect(e.ctx.ai('claude')).toEqual(before);
  });

  it('create_project(existing) — 저장소 확인을 기다린 뒤 등록하지도 폴더를 건드리지도 않는다', async () => {
    const e = (env = await bootOrch());
    const dir = mkdtempSync(join(tmpdir(), 'wook-test-stale-proj-'));
    dirs.push(dir);
    const before = e.ctx.store.projects.list().length;
    const gate = gateOn(e.ctx.deps.git, 'isRepo');
    const r = await cutDuringWait(e, gate, 'create_project', { name: '늦은 등록', path: dir, mode: 'existing' });
    expect(r).toEqual({ ok: false, code: 'stopped', message: turnGone('create_project') });
    expect(e.ctx.store.projects.list()).toHaveLength(before);
    expect(existsSync(join(dir, '.git'))).toBe(false);
    expect(existsSync(join(dir, 'AGENTS.md'))).toBe(false);
  });

  it('host_exec — 러너 준비를 기다리는 사이 자리가 바뀌면 띄우지 않는다 (seat_changed). 턴만 끝난 경우는 제 글(hostExecStop)', async () => {
    const e = (env = await bootOrch({ workspace: true }));
    const mp = await mainTurnUp(e);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    gates.push(() => release());
    let waiting = false;
    (e.ctx.deps.runner as ProcessRunner).ready = async () => {
      waiting = true;
      await gate;
    };
    const call = e.tool(mp.turnId, 'host_exec', { command: 'npm install', purpose: '설치 (시험)', request_id: 'rq-stale-1' });
    await waitFor(() => waiting, '러너 준비를 기다림');
    const swap = await forceSwap(e, mainKey(null));
    await swap.done;
    release();
    const r = await call;
    expect(r).toEqual({ ok: false, code: 'seat_changed', message: seatChanged('host_exec') });
    expect(e.hostSpecs).toEqual([]);
    expect(e.ctx.store.execs.list({ ref2: 'host_exec' })).toEqual([]);
  });
});
