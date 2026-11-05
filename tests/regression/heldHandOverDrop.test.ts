/**
 * 상한이 버린 보류 넘김은 대표 요청처럼 알린다 (리드 결정 43, 10-30 — owner-surface 5차 재리뷰 SR·SR-d, flows 프로브 zz-s1fx5fg-noreviewer-dropped-reaches-main):
 * - 서버가 보류를 메인 에이전트에게 업무로 넘기는 두 가지 — 정지 해제 목록(stop_released, 대표의 정지 해제가 만든다)과 검수자 없음(no_reviewer) — 를 보류
 *   넘김이라 부른다. 남는 업무가 아니라 메인이 한 번 받고 정한다
 * - 예전에는 그 업무를 실은 메인 턴이 비정상 종료 상한·시작 실패 상한·헛돌기·재시작 상한으로 끝나면 넘김을 조용히 버렸다. 작업은 메인 업무 없이 보류로
 *   남는데, 대표는 정지 해제 알림과 홈에서 '메인 에이전트가 확인해 항목별로 재개합니다'를 계속 봤다. 버림 알림은 작업 이름도 명령창 길도 적지 않았다
 * - 이제 버린 보류 넘김(아직 그 보류인 작업이 있는 것)은 대표 요청처럼 그 버림만의 key(세션 key + 항목 ID)로 새 알림·notification 이벤트·OS 알림을 낸다.
 *   알림은 아직 그 보류인 작업을 ID와 제목으로 적고 결정 32의 문장으로 끝난다. 버린 넘김마다 활동 기록 한 줄, 그 항목은 취소로 둔다
 * - '업무 시작 실패' 알림은 멈춘 업무를 이름으로 적는다(결정 43 규칙 3)
 * - 화면 약속 칸 reachesMain(결정 41)은 그 보류 넘김이 아직 메인에게 있을 때만 참이다: 대표 할 일 error는 검수자 없음 보류이고 그 작업의 가장 최근
 *   검수자 없음 업무가 취소되지 않았을 때, emergency_held는 가장 최근 정지 해제 업무가 취소되지 않았을 때. 항목이 없으면 거짓
 * - 정지 해제 목록은 목록의 작업 가운데 아직 긴급 정지 보류인 것이 없으면 끝난 업무다(deadWorkReason) — 전달하지 않고 기록과 함께 지운다
 * - 버린 넘김을 시작 때 다시 만들지 않는다. 긴급 정지 → 정지 해제를 다시 누르면 새 목록이 간다(지키는 시험)
 * 5단계 S5b (리드 결정 S5-8): 비정상 종료·시작 실패·헛돌기로 버린 보류 넘김은 메인에게 한 번 더 넘긴다(alert handover-dropped:<버린 항목>) — 알림은 '메인
 * 에이전트에게 다시 넘긴 보류 작업'과 넘긴 사실(OWNER_HANDED)로 끝나고 reachesMain은 그 알림 업무가 살아 있는 동안 참이다. 그 알림 업무도 상한에서 버리면
 * 결정 43의 알림(결정 32의 문장)이 끝이다 — 다시 넘기지 않아 돌지 않는다. 재시작 상한에서 버린 메인 세션 일은 넘기지 않는다 (리드 결정 44)
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID, type QueueEntry, type Task } from '@shared/domain';
import type { ShellServices } from '../../src/main/backend/types';
import { mainKey, reviewKey } from '../../src/main/orchestrator/records';
import { deadWorkReason } from '../../src/main/orchestrator/turns';
import type { OrchEnv } from './orchHarness';
import { bootOrch, seedDirective, seedInReviewTask, sleep, waitFor } from './orchHarness';
import { bootRestartable, seedDirective as seedDirectiveR, seedInReviewTask as seedInReviewTaskR, waitUntil, type RestartableEnv } from '../acceptance/stops-helpers';

let env: OrchEnv | null = null;
let renv: RestartableEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
  await renv?.close();
  renv = null;
});

const GENERAL = mainKey(null);
const TELL = '어떻게 할지 명령창으로 메인 에이전트에게 알려 주세요. 메인 에이전트가 확인하고 이어 갑니다';
/** 메인에게 한 번 더 넘긴 뒤의 출구 (리드 결정 S5-9) */
const HANDED = '메인 에이전트에게 넘겼습니다. 메인 에이전트가 확인하고 이어 갑니다 — 서둘러야 하면 명령창으로 메인 에이전트에게 알려 주세요';
/** 그 세션의 다시 넘긴 보류 넘김 알림 업무 (alert handover-dropped) */
const reAlerts = (e: { ctx: OrchEnv['ctx'] }, key: string): QueueEntry[] => e.ctx.store.queue.list({ ref2: key }).filter((q) => q.kind === 'alert' && !!q.alertKey?.startsWith('alert:handover-dropped:'));
const againRows = (e: { ctx: OrchEnv['ctx'] }) => e.ctx.store.activity.search({ text: '메인 에이전트에게 다시 넘긴 보류 작업', limit: 20 });

/** OS 알림(바탕화면)과 notification 이벤트를 모은다 */
function watchPushes(e: OrchEnv): { toasts: string[]; events: string[] } {
  const toasts: string[] = [];
  const events: string[] = [];
  const shell: ShellServices = {
    openExternal: async () => undefined,
    openPath: async () => undefined,
    pickFiles: async () => [],
    showOsNotification: (n) => toasts.push(n.title),
    focusWindow: () => undefined,
  };
  e.ctx.deps.shell = shell;
  e.ctx.bus.on('notification', (n) => events.push(n.title));
  return { toasts, events };
}

const released = (e: { ctx: OrchEnv['ctx'] }): QueueEntry[] => e.ctx.store.queue.list({ ref2: GENERAL }).filter((q) => q.kind === 'stop_released');
const liveReleased = (e: { ctx: OrchEnv['ctx'] }): QueueEntry[] => released(e).filter((q) => q.state === 'queued' || q.state === 'running');
const heldTodo = async (e: { invoke: OrchEnv['invoke'] }) => (await e.invoke('snapshot.get')).ownerTodos.filter((x) => x.kind === 'emergency_held');
const lostRows = (e: { ctx: OrchEnv['ctx'] }) => e.ctx.store.activity.search({ text: '메인 에이전트에게 전하지 못한 보류 작업', limit: 20 });

/** 검수 중 작업 둘을 넣고 긴급 정지 — 둘 다 긴급 정지 보류 */
async function emergencyHeld(e: OrchEnv): Promise<[Task, Task]> {
  const d = seedDirective(e);
  const t1 = seedInReviewTask(e, e.qaId, { outputMode: 'repo', directiveId: d.id });
  const t2 = seedInReviewTask(e, e.qaId, { outputMode: 'repo', directiveId: d.id });
  e.ctx.store.tasks.patch(t1.id, { title: '결제 화면' });
  e.ctx.store.tasks.patch(t2.id, { title: '로그인 문구' });
  await e.invoke('stop.emergency');
  for (const t of [t1, t2]) expect(e.ctx.store.tasks.require(t.id).hold.reasons.map((r) => r.kind)).toContain('emergency_stop');
  return [e.ctx.store.tasks.require(t1.id), e.ctx.store.tasks.require(t2.id)];
}

describe('상한이 버린 정지 해제 목록은 아직 긴급 정지 보류인 작업을 적어 알린다 (리드 결정 43)', () => {
  it('비정상 종료 상한 (SR-a): 그 버림만의 key로 새 알림·이벤트·OS 알림, 아직 보류인 작업만 ID와 제목으로 — 메인에게 한 번 더 넘기고 그렇다고 쓰며, 그 알림 업무도 버리면 결정 32의 문장으로 끝나고 더 돌지 않는다. 활동 기록, 항목 취소, reachesMain 참 → 거짓 (S5-8)', async () => {
    const e = (env = await bootOrch());
    const pushes = watchPushes(e);
    const [t1, t2] = await emergencyHeld(e);
    // 메인 턴을 띄운 채 두고, 그사이 메인이 T2를 재개한다 — 목록의 T2는 이제 긴급 정지 보류가 아니다
    e.hold.add(GENERAL);
    await e.invoke('stop.release');
    expect((await heldTodo(e)).map((x) => [x.count, x.reachesMain])).toEqual([[2, true]]);
    await waitFor(
      () => {
        if (!e.liveProc(GENERAL, MAIN_AGENT_ID)) e.tick();
        return !!e.liveProc(GENERAL, MAIN_AGENT_ID);
      },
      '정지 해제 목록을 실은 메인 턴',
    );
    e.hold.add(reviewKey(t2.id)); // 재개된 T2의 검수 턴은 띄운 채 둔다 (이 시험과 상관없음)
    await e.main('resume_task', { task_id: t2.id });
    expect(e.ctx.store.tasks.require(t2.id).hold.reasons.map((r) => r.kind)).not.toContain('emergency_stop');
    // 메인 턴이 결과 없이 세 번 끝난다 (API 장애·깨진 CLI 등)
    e.hold.delete(GENERAL);
    e.script.set(GENERAL, (p) => p.exit(1));
    e.liveProc(GENERAL, MAIN_AGENT_ID)!.exit(1);
    // 버려진 바로 그때를 본다 — 다음 차례를 돌리기 전에 (돌리면 다시 넘긴 알림 업무가 곧바로 뜬다)
    await waitFor(
      () => {
        if (liveReleased(e).length === 0 && reAlerts(e, GENERAL).length > 0 && !e.core.turns.hasLiveSession(GENERAL)) return true;
        e.tick();
        return false;
      },
      '정지 해제 목록이 비정상 종료 상한에서 버려지고 다시 넘긴 알림 업무가 생김',
      40_000,
    );
    // 다시 넘긴 동안 홈의 보류 작업은 메인에게 가 있다
    expect((await heldTodo(e)).map((x) => [x.count, x.reachesMain])).toEqual([[1, true]]);
    await waitFor(
      () => {
        e.tick();
        return reAlerts(e, GENERAL).every((q) => q.state === 'done' || q.state === 'cancelled') && !e.core.turns.hasLiveSession(GENERAL);
      },
      '다시 넘긴 알림 업무도 비정상 종료 상한에서 버려짐',
      40_000,
    );
    await sleep(50);
    for (let i = 0; i < 3; i++) e.tick();
    await sleep(50);
    const last = released(e).at(-1)!;
    expect([last.state, last.attempts]).toEqual(['cancelled', 2]);
    const lastAlert = reAlerts(e, GENERAL).at(-1)!;
    expect([lastAlert.alertKey, lastAlert.state, lastAlert.attempts]).toEqual([`alert:handover-dropped:${last.id}`, 'cancelled', 2]);
    const n = e.ctx.store.notifications.list({ state: 'unread' }).filter((x) => x.title === '자동 복구 실패');
    expect(n.map((x) => [x.key, x.level])).toEqual([
      [`crash:${GENERAL}:${last.id}`, 'urgent'],
      [`crash:${GENERAL}:${lastAlert.id}`, 'urgent'],
    ]);
    expect(n[0]!.body).toBe(`정지 해제 — 비정상 종료가 반복됩니다. 메인 에이전트에게 다시 넘긴 보류 작업: 긴급 정지 해제 목록 — ${t1.id} "결제 화면" — ${HANDED}`);
    expect(n[1]!.body.startsWith(`보류·실패 처리 ${t1.id} — 비정상 종료가 반복됩니다. 메인 에이전트에게 전하지 못한 보류 작업: 전하지 못한 보류 넘김 — 정지 해제 목록(${last.id})을 실은 메인 턴이`)).toBe(true);
    expect(n[1]!.body.endsWith(` — ${TELL}`)).toBe(true);
    expect(pushes.events.filter((x) => x === '자동 복구 실패')).toHaveLength(2);
    expect(pushes.toasts.filter((x) => x === '자동 복구 실패')).toHaveLength(2);
    expect(againRows(e).map((a) => [a.kind, a.level, a.taskId, a.text])).toEqual([
      ['stop', 'warn', t1.id, `메인 에이전트에게 다시 넘긴 보류 작업: 긴급 정지 해제 목록 — ${t1.id} "결제 화면" — 비정상 종료가 반복됩니다 (${last.id})`],
    ]);
    expect(lostRows(e).map((a) => [a.kind, a.level, a.taskId, a.text.endsWith(`비정상 종료가 반복됩니다 (${lastAlert.id}, 다시 전달하지 않음)`)])).toEqual([['task', 'warn', t1.id, true]]);
    // 버린 알림 업무는 다시 넘기지 않는다 — 넘긴 알림은 하나의 키뿐이다(돌지 않음)
    expect([...new Set(reAlerts(e, GENERAL).map((q) => q.alertKey))]).toEqual([`alert:handover-dropped:${last.id}`]);
    expect(e.ctx.store.queue.list({ ref2: GENERAL, state: ['queued', 'running'] })).toEqual([]);
    // 홈의 보류 작업은 이제 메인에게 가 있지 않다고 보인다
    expect((await heldTodo(e)).map((x) => [x.count, x.reachesMain])).toEqual([[1, false]]);
  });

  it('헛돌기 (SR-b): 실은 턴이 한 번 헛돌아 버려도 그 버림만의 key로 알리고 작업을 적는다 — 메인에게 한 번 더 넘기고, 그 알림도 헛돌면 결정 32의 문장으로 끝난다 (S5-8)', async () => {
    const e = (env = await bootOrch());
    const [t1, t2] = await emergencyHeld(e);
    e.script.set(GENERAL, (p) => {
      for (let i = 0; i < 6; i++) p.emit({ kind: 'error', text: `resume_task: ${t1.id}은(는) 바로 재개할 수 있는 보류가 아닙니다`, data: {} } as never);
      setTimeout(() => p.exit(1), 50);
    });
    await e.invoke('stop.release');
    await waitFor(
      () => {
        e.tick();
        return liveReleased(e).length === 0 && reAlerts(e, GENERAL).length > 0 && reAlerts(e, GENERAL).every((q) => q.state === 'done' || q.state === 'cancelled') && e.core.turns.count() === 0;
      },
      '헛돌기로 정지 해제 목록과 다시 넘긴 알림 업무가 버려짐',
      40_000,
    );
    await sleep(50);
    const last = released(e).at(-1)!;
    expect(last.state).toBe('cancelled');
    const lastAlert = reAlerts(e, GENERAL).at(-1)!;
    expect([lastAlert.alertKey, lastAlert.state]).toEqual([`alert:handover-dropped:${last.id}`, 'cancelled']);
    const n = e.ctx.store.notifications.list({ state: 'unread' }).filter((x) => x.title === '헛돌기');
    expect(n.map((x) => x.key)).toEqual([`spin:${GENERAL}:${last.id}`, `spin:${GENERAL}:${lastAlert.id}`]);
    expect(n[0]!.body).toBe(`정지 해제 — 같은 오류가 반복됐습니다. 메인 에이전트에게 다시 넘긴 보류 작업: 긴급 정지 해제 목록 — ${t1.id} "결제 화면", ${t2.id} "로그인 문구" — ${HANDED}`);
    expect(n[1]!.body.startsWith('보류·실패 처리 — 같은 오류가 반복됐습니다. 메인 에이전트에게 전하지 못한 보류 작업: 전하지 못한 보류 넘김 — ')).toBe(true);
    expect(n[1]!.body.endsWith(` — ${TELL}`)).toBe(true);
    expect(againRows(e).map((a) => [a.kind, a.taskId, a.text.endsWith(`메인 에이전트의 턴이 같은 오류를 되풀이하는 헛돌기로 끝남 (${last.id})`)])).toEqual([['stop', null, true]]);
    expect(lostRows(e).map((a) => [a.kind, a.taskId, a.text.endsWith(`메인 에이전트의 턴이 같은 오류를 되풀이하는 헛돌기로 끝남 (${lastAlert.id}, 다시 전달하지 않음)`)])).toEqual([['system', null, true]]);
    expect((await heldTodo(e)).map((x) => x.reachesMain)).toEqual([false]);
  });

  it('시작 실패 상한 (SR-e): 업무 시작 실패 알림이 멈춘 업무와 아직 보류인 작업을 적는다 — 메인에게 한 번 더 넘기고, 그 알림도 시작하지 못하면 결정 32의 문장이 가리키는 일이 보인다 (S5-8)', async () => {
    const e = (env = await bootOrch());
    const [t1, t2] = await emergencyHeld(e);
    e.prepareHook = (_launch, who) => {
      if (who.sessionKey === GENERAL) throw new Error('첨부 이미지 파일이 없습니다 (시험)');
    };
    await e.invoke('stop.release');
    await waitFor(
      () => {
        if (e.core.turns.count() === 0) e.tick();
        return liveReleased(e).length === 0 && reAlerts(e, GENERAL).length > 0 && reAlerts(e, GENERAL).every((q) => q.state === 'cancelled') && e.core.turns.count() === 0;
      },
      '시작 실패 상한으로 정지 해제 목록과 다시 넘긴 알림 업무가 버려짐',
      40_000,
    );
    await sleep(50);
    const last = released(e).at(-1)!;
    expect([last.state, last.startFails]).toEqual(['cancelled', 3]);
    const lastAlert = reAlerts(e, GENERAL).at(-1)!;
    expect([lastAlert.alertKey, lastAlert.state, lastAlert.startFails]).toEqual([`alert:handover-dropped:${last.id}`, 'cancelled', 3]);
    const n = e.ctx.store.notifications.list({ state: 'unread' }).filter((x) => x.title === '업무 시작 실패');
    expect(n.map((x) => x.key)).toEqual([`start-fail:${GENERAL}:${last.id}`, `start-fail:${GENERAL}:${lastAlert.id}`]);
    expect(n[0]!.body).toBe(
      `${GENERAL}: 첨부 이미지 파일이 없습니다 (시험) — 3번 시작하지 못해 멈춘 업무: 정지 해제. 메인 에이전트에게 다시 넘긴 보류 작업: 긴급 정지 해제 목록 — ${t1.id} "결제 화면", ${t2.id} "로그인 문구" — ${HANDED}`,
    );
    expect(n[1]!.body.startsWith(`${GENERAL}: 첨부 이미지 파일이 없습니다 (시험) — 3번 시작하지 못해 멈춘 업무: 보류·실패 처리. 메인 에이전트에게 전하지 못한 보류 작업: 전하지 못한 보류 넘김 — `)).toBe(true);
    expect(n[1]!.body.endsWith(` — ${TELL}`)).toBe(true);
    expect(againRows(e).map((a) => a.text.includes('업무 시작이 3번 실패함 (첨부 이미지 파일이 없습니다 (시험))'))).toEqual([true]);
    expect(lostRows(e).map((a) => a.text.includes('업무 시작이 3번 실패함 (첨부 이미지 파일이 없습니다 (시험))'))).toEqual([true]);
    expect((await heldTodo(e)).map((x) => x.reachesMain)).toEqual([false]);
  });

  it('버리지 않은 정지 해제 목록은 메인이 받아 마쳐도 reachesMain 참이다 — 버린 뒤 긴급 정지 → 정지 해제를 다시 누르면 새 목록이 가고 다시 참이다 (SR-c, 지키는 시험)', async () => {
    const e = (env = await bootOrch());
    const [t1] = await emergencyHeld(e);
    e.script.set(GENERAL, (p) => p.exit(1));
    await e.invoke('stop.release');
    await waitFor(
      () => {
        e.tick();
        return liveReleased(e).length === 0 && e.core.turns.count() === 0;
      },
      '버려짐',
      40_000,
    );
    await sleep(50);
    expect((await heldTodo(e)).map((x) => x.reachesMain)).toEqual([false]);
    e.script.delete(GENERAL);
    await e.invoke('stop.emergency');
    await e.invoke('stop.release');
    const again = liveReleased(e);
    expect(again).toHaveLength(1);
    expect(again[0]!.message).toContain(`- ${t1.id} "결제 화면"`);
    expect((await heldTodo(e)).map((x) => x.reachesMain)).toEqual([true]);
    // 메인이 받아 마친(정상 종료) 목록도 메인에게 간 것이다
    await waitFor(
      () => {
        e.tick();
        return released(e).at(-1)!.state === 'done' && e.core.turns.count() === 0;
      },
      '메인 턴이 목록을 받아 마침',
    );
    expect((await heldTodo(e)).map((x) => x.reachesMain)).toEqual([true]);
  });

  it('재시작 상한: 정지 해제 목록을 실은 메인 턴이 세 번째로 끊기면 같은 알림으로 작업을 적고, 시작 때 다시 만들지 않는다', async () => {
    let e = (renv = await bootRestartable({ holdAll: true }));
    const d = seedDirectiveR(e);
    const t = seedInReviewTaskR(e, { directiveId: d.id, assigneeId: e.devId, reviewerId: e.qaId, title: '결제 화면' });
    await e.invoke('stop.emergency');
    await e.invoke('stop.release');
    const mainLive = async (label: string) =>
      waitUntil(
        () => {
          if (!e.liveProc(GENERAL, MAIN_AGENT_ID)) e.tick();
          return !!e.liveProc(GENERAL, MAIN_AGENT_ID);
        },
        label,
      );
    await mainLive('정지 해제 목록 턴');
    for (let i = 1; i <= 2; i++) {
      e.crash();
      e = renv = await e.reboot();
      await mainLive(`정지 해제 목록 턴 (재시작 ${i})`);
    }
    e.crash();
    e = renv = await e.reboot();
    await sleep(100);
    e.tick();
    await sleep(50);
    const all = released(e);
    expect(all.map((q) => [q.state, q.restarts ?? 0])).toEqual([['cancelled', 3]]);
    const n = e.ctx.store.notifications.list().filter((x) => x.title === '자동 복구 실패');
    expect(n.map((x) => [x.key, x.body])).toEqual([
      [
        `crash:${GENERAL}:${all[0]!.id}`,
        `정지 해제 — 이 업무를 처리하던 중에 프로그램이 3번 다시 시작돼(앱이 갑자기 꺼지거나 PC가 다시 켜지는 등) 더는 자동으로 다시 시도하지 않습니다. 메인 에이전트에게 전하지 못한 보류 작업: 긴급 정지 해제 목록 — ${t.id} "결제 화면" — ${TELL}`,
      ],
    ]);
    expect(lostRows(e).map((a) => a.taskId)).toEqual([t.id]);
    expect((await heldTodo(e)).map((x) => [x.count, x.reachesMain])).toEqual([[1, false]]);
    // 다시 시작해도 다시 만들지 않는다 — 알림과 할 일이 대표의 업무다
    e.crash();
    e = renv = await e.reboot();
    await sleep(100);
    expect(liveReleased(e)).toEqual([]);
  });
});

describe('정지 해제 목록은 목록의 작업이 아직 긴급 정지 보류일 때만 필요하다 (deadWorkReason, 리드 결정 43)', () => {
  it('목록의 작업이 하나라도 긴급 정지 보류면 살아 있고, 모두 풀리면 끝났다 — 스케줄러는 전달하지 않고 기록과 함께 지운다', async () => {
    const e = (env = await bootOrch());
    const [t1, t2] = await emergencyHeld(e);
    e.hold.add(GENERAL);
    await e.invoke('stop.release');
    const q = liveReleased(e)[0]!;
    expect(deadWorkReason(e.ctx, q)).toBeNull();
    // 재개된 작업의 검수 턴은 띄운 채 둔다 (이 시험과 상관없음)
    for (const t of [t1, t2]) e.hold.add(reviewKey(t.id));
    await e.main('resume_task', { task_id: t1.id });
    expect(deadWorkReason(e.ctx, e.ctx.store.queue.require(q.id))).toBeNull();
    await e.main('resume_task', { task_id: t2.id });
    expect(deadWorkReason(e.ctx, e.ctx.store.queue.require(q.id))).toBe('정지 해제 목록의 작업이 모두 긴급 정지 보류에서 풀림');
    e.tick();
    await sleep(50);
    expect(e.ctx.store.queue.require(q.id).state).toBe('cancelled');
    expect(e.launches.filter((l) => l.workKey === GENERAL)).toEqual([]);
    expect(e.ctx.store.activity.search({ text: '끝난 일의 정지 해제 업무 정리', limit: 5 }).map((a) => [a.kind, a.text])).toEqual([
      ['stop', `끝난 일의 정지 해제 업무 정리 — 정지 해제 목록의 작업이 모두 긴급 정지 보류에서 풀림 (${GENERAL}, 다시 전달하지 않음)`],
    ]);
    // 버린 것이 아니라 끝난 것이다 — 버림 알림은 없다
    expect(e.ctx.store.notifications.list().filter((n) => n.title === '자동 복구 실패' || n.title === '헛돌기')).toEqual([]);
  });
});

describe('상한이 버린 검수자 없음 업무 (리드 결정 41·43 — SR-d, flows noreviewer-dropped-reaches-main)', () => {
  it('비정상 종료 상한에서 버리면 그 작업을 적어 알리고 메인에게 한 번 더 넘긴다 — 그 알림 업무도 버리면 대표 할 일 reachesMain은 거짓이 된다. 업무가 아예 없는 검수자 없음 보류도 거짓 (S5-8)', async () => {
    const e = (env = await bootOrch());
    await e.internal('members.remove', e.qaId);
    const key = mainKey(e.projectId);
    const d = seedDirective(e);
    const t = seedInReviewTask(e, MAIN_AGENT_ID, { outputMode: 'repo', directiveId: d.id });
    e.ctx.store.tasks.patch(t.id, { title: '정산 화면', assigneeId: e.producerId, contributors: [e.producerId, MAIN_AGENT_ID] });
    e.hold.add(key);
    e.core.tasks.dispatchReview(e.ctx.store.tasks.require(t.id));
    const todo = async () => (await e.invoke('snapshot.get')).ownerTodos.flatMap((x) => (x.kind === 'error' && x.taskId === t.id ? [x.reachesMain] : []));
    expect(await todo()).toEqual([true]);
    e.hold.delete(key);
    e.script.set(key, (p) => p.exit(1));
    await waitFor(
      () => {
        if (e.ctx.store.notifications.list().some((n) => n.title === '자동 복구 실패') && e.core.turns.count() === 0) return true;
        e.tick();
        return false;
      },
      '메인 턴 비정상 종료 상한',
      40_000,
    );
    // 다시 넘긴 알림 업무가 살아 있는 동안은 메인에게 가 있다
    expect(reAlerts(e, key).map((q) => q.state)).toEqual(['queued']);
    expect(await todo()).toEqual([true]);
    await waitFor(
      () => {
        e.tick();
        return reAlerts(e, key).every((q) => q.state === 'done' || q.state === 'cancelled') && e.core.turns.count() === 0;
      },
      '다시 넘긴 알림 업무의 비정상 종료 상한',
      40_000,
    );
    await sleep(50);
    const items = e.ctx.store.queue.list({ ref2: key }).filter((q) => q.kind === 'no_reviewer' && q.taskId === t.id);
    const last = items.at(-1)!;
    expect(last.state).toBe('cancelled');
    expect(e.ctx.store.tasks.require(t.id).hold.reasons.map((r) => r.refId)).toEqual(['no_reviewer']);
    const lastAlert = reAlerts(e, key).at(-1)!;
    expect([lastAlert.alertKey, lastAlert.state, lastAlert.taskId]).toEqual([`alert:handover-dropped:${last.id}`, 'cancelled', t.id]);
    expect(lastAlert.message).toContain(`resume_task(task_id="${t.id}", reason="…")`);
    const n = e.ctx.store.notifications.list().filter((x) => x.title === '자동 복구 실패');
    expect(n.map((x) => x.key)).toEqual([`crash:${key}:${last.id}`, `crash:${key}:${lastAlert.id}`]);
    expect(n[0]!.body).toBe(`검수자 없음 ${t.id} — 비정상 종료가 반복됩니다. 메인 에이전트에게 다시 넘긴 보류 작업: 검수자 없음 ${t.id} "정산 화면" — ${HANDED}`);
    expect(n[1]!.body.endsWith(` — ${TELL}`)).toBe(true);
    expect(againRows(e).map((a) => [a.kind, a.taskId, a.projectId])).toEqual([['review', t.id, e.projectId]]);
    expect(lostRows(e).map((a) => [a.kind, a.taskId, a.projectId])).toEqual([['task', t.id, e.projectId]]);
    expect(await todo()).toEqual([false]);
    // 업무가 아예 없는 검수자 없음 보류(예전 데이터 등)도 메인에게 가 있지 않다
    const legacy = seedInReviewTask(e, MAIN_AGENT_ID, { outputMode: 'repo', directiveId: d.id });
    e.core.tasks.hold(legacy.id, 'error', 'task', '검수자 없음 — 예전 데이터 (시험)', 'system', 'no_reviewer', 'in_review');
    expect((await e.invoke('snapshot.get')).ownerTodos.flatMap((x) => (x.kind === 'error' && x.taskId === legacy.id ? [x.reachesMain] : []))).toEqual([false]);
  });
});
