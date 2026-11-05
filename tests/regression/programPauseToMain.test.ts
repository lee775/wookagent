/**
 * 프로그램이 팀원을 일시정지하면 메인 에이전트에게 재개 업무를 넣는다 (리드 결정 26, 10-30 — flows 재리뷰 medium, 프로브 zz-s1fx2fg-producer-program-pause):
 * - 검수자 재배정 업무를 실은 프로듀서 턴이 하위 프로세스를 남기면(종료 확인 실패, CTL-11) 프로그램이 프로듀서를 일시정지한다. 예전에는 재배정 업무가
 *   정지된 프로듀서 앞에만 남고 메인 에이전트에게는 아무것도 가지 않았다 — 풀 수 있는 쪽(resume_member)이 몰랐다. 대표 알림은 '…정리한 뒤 재개하세요'였지만
 *   대표에게는 팀원 재개가 없다
 * - 이제 main:<P>에 그 팀원·까닭·PID·멈춘 업무를 적은 업무를 넣고, 남은 프로세스가 사라졌는지 확인한 뒤 resume_member로 재개하라고 안내한다. 그 팀원이
 *   재개될 때까지 남는 업무다(메인 턴 3번 뒤 대표 알림, 리드 결정 24와 같게). 재개되면 끝난 업무로 지운다. 시작 때 관리 업무 복원이 빠진 업무를 다시 만든다
 * - 팀원 실행·작업 보류·자동 검사 보류의 종료 확인 실패 글은 대표에게 재개하라고 하지 않는다 — 메인 에이전트가 이어 가고, 대표는 명령창으로 알릴 수 있다
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID, type Task } from '@shared/domain';
import { directiveKey, enqueue, mainKey, reviewKey } from '../../src/main/orchestrator/records';
import { unconfirmedNote } from '../../src/main/orchestrator/turns';
import { bootRestartable, type RestartableEnv } from '../acceptance/stops-helpers';
import { bootOrch, seedDirective, seedInReviewTask, sleep, waitFor, type OrchEnv } from './orchHarness';

let env: OrchEnv | null = null;
let renv: RestartableEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
  await renv?.close();
  renv = null;
});

const live = (e: { ctx: OrchEnv['ctx'] }) => e.ctx.store.queue.list({ state: ['queued', 'running'] });
const pauseItems = (e: { ctx: OrchEnv['ctx'] }, memberId: string) => live(e).filter((q) => q.memberId === MAIN_AGENT_ID && q.pausedMemberId === memberId);
const pauseNotice = (e: OrchEnv, memberId: string) => e.ctx.store.notifications.list().filter((n) => n.key === `pause-stuck:${memberId}`);
async function ticks(e: OrchEnv, n: number) {
  for (let i = 0; i < n; i++) {
    e.tick();
    await sleep(25);
  }
}

/**
 * 메인 에이전트가 검수자인 작업(담당은 개발자 — 프로듀서 정지가 이 작업을 보류하지 않게)의 검수가 멈춰 프로듀서에게 재배정 업무가 가고, 그 프로듀서 턴이
 * 하위 프로세스 1개를 남긴 채 끝나 프로그램이 프로듀서를 일시정지한다. 그 뒤 프로듀서 턴은 "main"을 다시 정한다(재개되면)
 */
async function producerPausedByProgram(e: OrchEnv): Promise<{ t: Task; producerTurnId: string }> {
  await e.internal('members.remove', e.qaId);
  const d = seedDirective(e);
  const t = seedInReviewTask(e, MAIN_AGENT_ID, { outputMode: 'repo', directiveId: d.id });
  let n = 0;
  let producerTurnId = '';
  e.script.set(directiveKey(d.id), (p) => {
    n += 1;
    if (n === 1) {
      producerTurnId = p.turnId;
      p.emit({ kind: 'result', text: '확인 중', data: {} });
      p.exit(0, { remaining: 1 });
      return;
    }
    void e.tool(p.turnId, 'assign_reviewer', { task_id: t.id, reviewer_id: 'main' }).finally(() => p.finishOk());
  });
  e.core.tasks.dispatchReview(e.ctx.store.tasks.require(t.id));
  await waitFor(
    () => {
      e.tick();
      return !!e.ctx.stop().members[e.producerId]?.paused && pauseItems(e, e.producerId).length > 0;
    },
    '프로듀서 일시정지와 메인 에이전트 재개 업무',
    40_000,
  );
  await sleep(50);
  return { t: e.ctx.store.tasks.require(t.id), producerTurnId };
}

describe('프로그램이 팀원을 일시정지하면 메인 에이전트에게 재개 업무를 넣는다 (리드 결정 26)', () => {
  it('재배정 업무를 실은 프로듀서 턴이 프로세스를 남기면: 메인 업무가 팀원·까닭·PID·멈춘 업무를 적고, 대표 알림은 재개하라고 하지 않는다. 메인 턴 3번에도 재개하지 않으면 대표에게 알린다', async () => {
    const e = (env = await bootOrch());
    const key = mainKey(e.projectId);
    e.hold.add(key);
    const { t, producerTurnId } = await producerPausedByProgram(e);
    const producer = e.ctx.store.members.require(e.producerId);
    expect(e.ctx.stop().members[e.producerId]).toMatchObject({ paused: true, by: 'system' });
    const items = pauseItems(e, e.producerId);
    expect(items.map((q) => [q.kind, q.sessionKey, q.priority, q.taskId])).toEqual([['message', key, 'high', null]]);
    const pid = e.ctx.store.turns.get(producerTurnId)!.process.pid;
    // 저장된 글에는 업무 목록이 없다 — 그 팀원 앞에 기다리는 업무는 전달할 때 머리말이 적는다 (리드 결정 37, 아래 첫 전달)
    expect(items[0]!.message).toBe(
      [
        `프로그램이 ${producer.name}(${producer.id}, 프로듀서)을(를) 일시정지했습니다 — ${producer.name} 검수자 배정 ${t.id}의 프로세스 종료를 확인하지 못했습니다.`,
        `- 프로세스: 턴 ${producerTurnId}의 CLI PID ${pid} — 정리 후 남은 프로세스 1개`,
        `남은 프로세스가 모두 사라졌는지 확인한 뒤 resume_member(member_id="${producer.id}", reason="…")로 재개하세요. 직접 확인할 길이 없으면 ask_owner로 대표에게 작업 관리자에서 확인해 달라고 부탁하세요.`,
      ].join('\n'),
    );
    // 대표 알림: 재개하라고 하지 않는다 — 메인 에이전트가 이어 가고, 대표는 명령창으로 알릴 수 있다
    const killed = e.ctx.store.notifications.list().filter((n) => n.title === '프로세스 종료 확인 실패');
    expect(killed.map((n) => n.body)).toEqual([
      `${producer.name} 검수자 배정 ${t.id}: 턴 종료 뒤 하위 프로세스 1개가 남았습니다 (종료 확인 실패). 남은 프로세스가 정리됐는지 확인되면 메인 에이전트가 다시 이어 갑니다. 직접 정리했거나 서둘러야 하면 명령창으로 메인 에이전트에게 알려 주세요`,
    ]);
    // 검수 중 작업에는 처리할 수 있는 쪽(메인 에이전트)의 업무가 있다 — 재배정 업무는 정지된 프로듀서 앞에 그대로
    await ticks(e, 10);
    expect({
      state: e.ctx.store.tasks.require(t.id).state,
      review: live(e).filter((q) => q.sessionKey === reviewKey(t.id) && q.kind === 'review').length,
      assignForPaused: live(e).filter((q) => q.kind === 'reviewer_assign' && q.taskId === t.id && q.memberId === e.producerId).length,
      main: pauseItems(e, e.producerId).length,
    }).toEqual({ state: 'in_review', review: 0, assignForPaused: 1, main: 1 });

    // 메인 턴이 재개하지 않고 끝나면 다시 넣고, 3번째에도 그대로면 대표에게 그 팀원을 알린다
    for (let i = 0; i < 3; i++) {
      await waitFor(
        () => {
          if (!e.liveProc(key, MAIN_AGENT_ID)) e.tick();
          return !!e.liveProc(key, MAIN_AGENT_ID);
        },
        `재개 업무를 실은 메인 턴 ${i + 1}`,
      );
      const p = e.liveProc(key, MAIN_AGENT_ID)!;
      const carried = e.ctx.store.turns.get(p.turnId)!.queueEntryIds.map((id) => e.ctx.store.queue.get(id)!).filter((q) => q.pausedMemberId === e.producerId);
      // 다시 전달은 전달 횟수(deliveries)로 센다 — 비정상 종료 횟수(attempts)는 오르지 않는다 (리드 결정 30). 머리말은 전달할 때 붙인다 (리드 결정 31)
      expect(carried.map((q) => [q.deliveries ?? 0, q.attempts])).toEqual([[i, 0]]);
      const shown = e.launches.find((x) => x.turnId === p.turnId)!.message;
      if (i > 0) expect(shown).toContain(`> (${i + 1}번째 알림 — ${producer.name}(${producer.id})은(는) 아직 일시정지돼 있습니다)`);
      // 첫 전달부터 그 팀원 앞에 지금 기다리는 업무를 적는다 — 판정이 다시 넣은 재배정 업무 (리드 결정 37)
      expect(shown).toContain(`지금 ${producer.name}(${producer.id}) 앞에 기다리는 업무: 검수자 배정 ${t.id} — 재개하기 전까지 처리되지 않습니다`);
      expect(shown).not.toContain('멈춘 업무:');
      p.finishOk('대표에게 확인을 부탁했습니다');
      await waitFor(() => !e.core.turns.liveTurnIds().includes(p.turnId), '메인 턴 마무리');
      await sleep(30);
    }
    expect(pauseItems(e, e.producerId)).toEqual([]);
    const n = pauseNotice(e, e.producerId);
    expect(n.map((x) => [x.title, x.level])).toEqual([['메인 에이전트 처리 지연', 'normal']]);
    expect(n[0]!.body).toBe(
      `${producer.name}(${producer.id})이(가) 프로세스 종료를 확인하지 못해 일시정지된 채 남아 있습니다 — 메인 에이전트에게 재개를 3번 맡겼지만 아직 재개하지 않았습니다. 멈춘 업무: 검수자 배정 ${t.id}. 남은 프로세스를 정리했다면 명령창으로 메인 에이전트에게 ${producer.name}을(를) 재개하라고 말해 주세요.`,
    );
    expect(n[0]!.link).toEqual({ tab: 'projects', projectId: e.projectId, memberId: producer.id });
  });

  it('메인 에이전트가 그 턴에서 재개하면 다시 넣지 않고, 프로듀서가 재배정 업무를 처리해 검수가 다시 돈다', async () => {
    const e = (env = await bootOrch());
    const key = mainKey(e.projectId);
    e.hold.add(key);
    const { t } = await producerPausedByProgram(e);
    await waitFor(
      () => {
        if (!e.liveProc(key, MAIN_AGENT_ID)) e.tick();
        return !!e.liveProc(key, MAIN_AGENT_ID);
      },
      '재개 업무를 실은 메인 턴',
    );
    const p = e.liveProc(key, MAIN_AGENT_ID)!;
    await e.tool(p.turnId, 'resume_member', { member_id: e.producerId, reason: '대표가 남은 프로세스를 정리했다고 확인' });
    p.finishOk();
    await waitFor(() => !e.core.turns.liveTurnIds().includes(p.turnId), '메인 턴 마무리');
    await sleep(30);
    expect(pauseItems(e, e.producerId)).toEqual([]);
    await waitFor(
      () => {
        e.tick();
        return live(e).some((q) => q.sessionKey === reviewKey(t.id) && q.kind === 'review') || e.core.turns.hasLiveSession(reviewKey(t.id));
      },
      '프로듀서가 재배정 업무를 처리해 검수가 다시 등록됨',
    );
    expect(pauseNotice(e, e.producerId)).toEqual([]);
  });

  it('기다리는 재개 업무는 그 팀원이 재개되면 끝난 업무로 지운다 (다시 전달하지 않음)', async () => {
    const e = (env = await bootOrch());
    await e.core.stops.pauseMember(e.producerId, 'graceful', 'system', '프로세스 종료를 확인하지 못함 (서진 계획 D-0001)');
    e.core.turns.handPauseToMain(e.producerId, null);
    const [item] = pauseItems(e, e.producerId);
    expect(item!.message).toContain('일시정지했습니다 — 프로세스 종료를 확인하지 못함 (서진 계획 D-0001).');
    expect(item!.message).toContain('- 프로세스: 알 수 없음 (정지 기록만 남음)');
    // 다시 불러도 하나다
    e.core.turns.handPauseToMain(e.producerId, null);
    expect(pauseItems(e, e.producerId)).toHaveLength(1);
    // 같은 세션의 다른 메시지 업무(팀원 AI 결정 요청처럼 합치기를 쓰는 것)와 합치지 않는다 — 재개되면 지우는 업무에 다른 일이 섞이지 않게
    enqueue(e.ctx, { kind: 'message', memberId: MAIN_AGENT_ID, sessionKey: mainKey(e.projectId), projectId: e.projectId, priority: 'low', dedupeKind: true, message: '팀원 AI를 정하세요' });
    expect(pauseItems(e, e.producerId).map((q) => q.message.includes('팀원 AI를 정하세요'))).toEqual([false]);
    expect(live(e).filter((q) => q.memberId === MAIN_AGENT_ID && q.message === '팀원 AI를 정하세요')).toHaveLength(1);
    e.hold.add(mainKey(e.projectId));
    // 메인의 resume_member는 아직 받지 않은(대기 중인) 이 재개 업무를 먼저 보여 준다(한 번 거부 — 리드 결정 S5-50, alertsToMain이 본다). 여기서는 재개 업무가 기다리는
    // 동안 팀원이 다른 길(운영자 내부 API)로 재개된 경우 — 그 업무는 끝난 일로 지우고 메인에게 전달하지 않는다
    await e.internal('members.resume', e.producerId);
    e.tick();
    await sleep(50);
    expect(e.ctx.store.queue.get(item!.id)!.state).toBe('cancelled');
    const name = e.ctx.store.members.require(e.producerId).name;
    expect(e.ctx.store.activity.search({ text: '끝난 일의', limit: 10 }).map((a) => a.text)).toContain(`끝난 일의 메시지 확인 업무 정리 — ${name}(${e.producerId})이(가) 이미 재개됨 (${mainKey(e.projectId)}, 다시 전달하지 않음)`);
    // 메인 턴은 다른 업무만 싣는다
    expect(e.launches.filter((l) => l.workKey === mainKey(e.projectId)).map((l) => [l.message.includes('팀원 AI를 정하세요'), l.message.includes('일시정지했습니다')])).toEqual([[true, false]]);
  });
});

// 시험 빈틈 (리드 결정 34, tests-integrity 변이 N-member-lost): 재개 업무를 실은 메인 턴이 다시 넣지 않는 끝으로 끝나도 그 팀원을 대표에게 알린다
describe('재개 업무를 실은 메인 턴이 비정상 종료 상한까지 끝나면 그 팀원을 대표에게 알린다 (리드 결정 24·26)', () => {
  it('재개 업무는 자기 비정상 종료 횟수로 상한에 닿아 버리고, 대표 알림이 그 팀원과 멈춘 업무를 적는다', async () => {
    const e = (env = await bootOrch());
    const key = mainKey(e.projectId);
    e.script.set(key, (p) => p.exit(1));
    const { t } = await producerPausedByProgram(e);
    const limit = e.ctx.settings().execution.crashRetryMax;
    await waitFor(
      () => {
        e.tick();
        return pauseNotice(e, e.producerId).length > 0;
      },
      '메인 턴 비정상 종료 상한과 대표 알림',
      40_000,
    );
    await ticks(e, 5);
    const producer = e.ctx.store.members.require(e.producerId);
    expect(e.ctx.store.turns.list().filter((x) => x.memberId === MAIN_AGENT_ID && x.sessionKind === 'main_project').map((x) => x.endReason)).toEqual(Array(limit + 1).fill('crashed'));
    expect(pauseItems(e, e.producerId)).toEqual([]);
    expect(pauseNotice(e, e.producerId).map((n) => n.body)).toEqual([
      `${producer.name}(${producer.id})이(가) 프로세스 종료를 확인하지 못해 일시정지된 채 남아 있습니다 — 메인 에이전트의 턴이 비정상 종료로 반복해서 끝나 이 업무를 처리하지 못했습니다. 멈춘 업무: 검수자 배정 ${t.id}. 남은 프로세스를 정리했다면 명령창으로 메인 에이전트에게 ${producer.name}을(를) 재개하라고 말해 주세요.`,
    ]);
  });
});

describe('시작 때 관리 업무 복원: 프로그램이 건 팀원 정지에 메인 에이전트의 재개 업무가 없으면 만든다 (리드 결정 26)', () => {
  // 시험 빈틈 (리드 결정 34, tests-integrity 변이 N-by-system): 메인 에이전트가 직접 건 팀원 정지에는 재개 업무를 만들지 않는다
  it('메인 에이전트가 직접 일시정지한 팀원에게는 재시작해도 재개 업무를 만들지 않는다 — 프로그램이 건 정지에만 만든다', async () => {
    let e = (renv = await bootRestartable({ holdAll: true }));
    await e.main('pause_member', { member_id: e.devId, mode: 'graceful', reason: '디자인 확정까지 멈춤' });
    await e.core.stops.pauseMember(e.producerId, 'graceful', 'system', '프로세스 종료를 확인하지 못함 (서진 계획 D-0001)');
    expect(e.ctx.stop().members[e.devId]).toMatchObject({ paused: true, by: MAIN_AGENT_ID });
    e.crash();
    e = renv = await e.reboot();
    expect(pauseItems(e, e.devId)).toEqual([]);
    expect(pauseItems(e, e.producerId)).toHaveLength(1);
    expect(e.ctx.store.activity.search({ text: '재개를 메인 에이전트에게 맡김', limit: 10 }).map((a) => a.memberId)).toEqual([e.producerId]);
  });

  it('정지와 업무 넣기 사이에 끊겼거나 1단계 전에 건 정지 — 재시작하면 업무 하나를 만들고, 다시 재시작해도 늘지 않는다. 메인 에이전트 자신의 정지에는 만들지 않는다', async () => {
    let e = (renv = await bootRestartable({ holdAll: true }));
    await e.core.stops.pauseMember(e.producerId, 'graceful', 'system', '프로세스 종료를 확인하지 못함 (서진 계획 D-0001)');
    await e.core.stops.pauseMember(MAIN_AGENT_ID, 'graceful', 'system', '프로세스 종료를 확인하지 못함 (메인 에이전트 명령)');
    expect(pauseItems(e, e.producerId)).toEqual([]);
    e.crash();
    e = renv = await e.reboot();
    expect(pauseItems(e, e.producerId).map((q) => [q.sessionKey, q.state])).toEqual([[mainKey(e.projectId), 'queued']]);
    expect(pauseItems(e, MAIN_AGENT_ID)).toEqual([]);
    e.crash();
    e = renv = await e.reboot();
    expect(pauseItems(e, e.producerId)).toHaveLength(1);
  });
});

// 작업·검수 세션과 자동 검사의 보류 글(메인 업무 없음)은 holdNoticeTruth가 본다 (리드 결정 32)
describe('종료 확인 실패 글: 팀원 실행의 일시정지는 대표에게 재개하라고 하지 않는다 (리드 결정 26)', () => {
  it.each([
    ['남은 2개', 2, null],
    ['확인 불가', -1, '작업 개체 도우미가 답하지 않음'],
  ] as const)('%s', (_label, remaining, cause) => {
    for (const what of ['턴', '자동 검사', '이전 실행'] as const) {
      const note = unconfirmedNote(null, remaining, cause, what, 'member_pause');
      expect(note).not.toContain('재개하세요');
      expect(note).not.toContain('정리한 뒤');
      expect(note).toContain('메인 에이전트가 다시 이어 갑니다. 직접 정리했거나 서둘러야 하면 명령창으로 메인 에이전트에게 알려 주세요');
    }
    // 메인 에이전트 자신의 실행은 그대로 대표의 '정지 해제' (리드 결정 6)
    expect(unconfirmedNote(null, remaining, cause, '턴', 'main_pause')).toContain("확인한 뒤 '정지 해제'를 누르세요");
  });
});
