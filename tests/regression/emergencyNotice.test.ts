/**
 * 긴급 정지 알림·요약은 실패한 팀원을 하나도 빠뜨리지 않고, 남은 프로세스를 센 실패와 확인하지 못한 실패를 가른다.
 * - S8-D1 (stage-7 리뷰 guards-shutdown7 D1, stage-7 회귀 — S7-D3 '알림은 사실만', 12장 '대표가 할 일을 알 수 있게', AC-15):
 *   알림 글이 실패를 팀원 '이름'으로 묶었다. 모든 프로젝트의 프로듀서는 '서진'(NAME_POOL[0])이라, A 프로젝트의 서진이 남은 프로세스 2개를 남기고
 *   B 프로젝트의 서진은 확인하지 못했을 때(-1) 알림은 '남은 프로세스가 있습니다: 서진'뿐이었다 — B를 확인하지 못했다는 말이 빠졌다.
 *   이제 팀원 ID로 묶고, 이름이 겹치면 프로젝트 이름(그래도 겹치면 팀원 ID)을 붙여 쓴다: '서진(B 프로젝트)'.
 * - S8-D3 (stage-7 리뷰 guards-shutdown7 D3, 12장): 요약(EmergencySummary.failures)에는 그 구분이 없어 화면이 확인하지 못한 정지에도
 *   '남은 프로세스가 있습니다'라고 썼다. 이제 확인하지 못한 실패는 remaining -1을 둔다. 남은 수를 센 실패는 그 수가 detail에 있고 값을 두지 않는다
 *   (AC-15 수용 테스트가 그 실패 항목을 { memberId, memberName, detail } 그대로 본다 — 이전 버전 요약과 같은 모양).
 * - S9-D2 (stage-8 리뷰 guards-shutdown8 D2, stage-8 회귀): 이름은 단계마다 그 단계의 이름끼리만 견줘, 대표가 C의 프로듀서를 '서진(B 프로젝트)'로
 *   지으면 B의 서진(단계 1 이름)과 같은 이름이 됐다. 이제 고른 이름끼리 다시 견주고, 같은 이름이 남은 팀원은 모두 팀원 ID까지 붙인다.
 * 원래 탐침: probe-archive/stage7-guards-shutdown7-review/tests-regression__zz-gs7r-namecollide.probe.ts,
 *   probe-archive/stage8-guards-shutdown8-review/tests-regression__zz-gs8r-labels.probe.ts
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Directive } from '@shared/domain';
import { OWNER } from '@shared/domain';
import type { ManagedProcess, TerminateResult } from '../../src/main/process/types';
import { describeEmergency } from '../../src/main/shell/emergency';
import { directiveKey, enqueue, taskKey } from '../../src/main/orchestrator/records';
import { bootOrch, waitFor, type FakeProc, type OrchEnv } from './orchHarness';

let e: OrchEnv | null = null;
const dirs: string[] = [];
afterEach(async () => {
  await e?.close().catch(() => undefined);
  e = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

function directiveIn(env: OrchEnv, projectId: string, title: string): Directive {
  const now = env.ctx.now();
  const d: Directive = {
    id: env.ctx.store.nextId('directive'),
    projectId,
    title,
    text: title,
    attachments: [],
    round: 1,
    state: 'in_progress',
    rounds: [{ round: 1, requestedAt: now, text: title, anchored: [], reportId: null }],
    finalResult: null,
    planApprovalRequired: false,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    cancelledAt: null,
  };
  env.ctx.store.directives.insert(d);
  return d;
}

/** 프로세스 종료 결과를 정한다: remaining > 0이면 남은 수를 센 실패, -1이면 확인하지 못한 실패 */
function failTerminate(p: FakeProc, remaining: number): void {
  p.terminate = async () => {
    p.terminatedByApp = true;
    p.exit(null, { terminated: true, remaining });
    return remaining > 0
      ? { ok: false, remaining, detail: `작업 개체로 프로세스 트리를 종료했습니다. 하지만 남은 프로세스가 있습니다 (${remaining}개)`, durationMs: 2800 }
      : { ok: false, remaining: -1, detail: '작업 개체 도우미가 답하지 않아 작업 개체 안을 확인하지 못했습니다', durationMs: 2800 };
  };
}

/** 두 번째 프로젝트(B 프로젝트)를 등록하고 두 프로젝트 프로듀서의 관리 턴을 띄운다 — 두 프로듀서 모두 '서진' */
async function twoProducerTurns(env: OrchEnv): Promise<{ bId: string; bProducer: string; a: FakeProc; b: FakeProc }> {
  const root = mkdtempSync(join(tmpdir(), 'wook-reg-emnotice-'));
  dirs.push(root);
  const b = await env.internal('projects.create', { mode: 'new', path: join(root, 'b'), name: 'B 프로젝트', checkCommands: [] });
  await env.internal('projects.setMock', b.id, { enabled: true, speed: 25, defaultScenario: 'normal' });
  const dA = directiveIn(env, env.projectId, 'A 지시');
  const dB = directiveIn(env, b.id, 'B 지시');
  for (const [d, producer, projectId] of [
    [dA, env.producerId, env.projectId],
    [dB, b.producerId, b.id],
  ] as const) {
    env.hold.add(directiveKey(d.id));
    enqueue(env.ctx, { kind: 'message', memberId: producer, sessionKey: directiveKey(d.id), projectId, directiveId: d.id, message: '진행 상황을 정리해 주세요' });
  }
  env.tick();
  await waitFor(() => !!env.liveProc(directiveKey(dA.id)) && !!env.liveProc(directiveKey(dB.id)), '두 프로젝트의 관리 턴');
  return { bId: b.id, bProducer: b.producerId, a: env.liveProc(directiveKey(dA.id))!, b: env.liveProc(directiveKey(dB.id))! };
}

const failureNotices = (env: OrchEnv): string[] => env.ctx.store.notifications.list().filter((n) => n.title === '긴급 정지 — 종료 실패').map((n) => n.body);

describe('긴급 정지 알림은 팀원 ID로 묶고, 이름이 겹치면 프로젝트 이름을 붙인다 (S8-D1, AC-15, 12장)', () => {
  it('두 프로젝트의 프로듀서 서진 — A는 남은 2개, B는 확인 불가(-1): 알림이 둘을 따로 이름 붙여 말한다', async () => {
    e = await bootOrch();
    const env = e;
    const t = await twoProducerTurns(env);
    expect(env.ctx.store.members.require(env.producerId).name).toBe('서진');
    expect(env.ctx.store.members.require(t.bProducer).name).toBe('서진');
    failTerminate(t.a, 2);
    failTerminate(t.b, -1);
    const summary = await env.core.stops.emergency(OWNER);
    const aName = `서진(${env.ctx.store.projects.require(env.projectId).name})`;
    const bName = '서진(B 프로젝트)';
    expect(summary.completed).toBe(false);
    expect(failureNotices(env)).toEqual([`남은 프로세스가 있습니다: ${aName} / 남은 프로세스를 확인하지 못했습니다: ${bName}`]);
    // 요약도 같은 이름 — 화면의 실패 목록·멈춘 턴과 OS 알림(describeEmergency)이 두 서진을 가른다
    expect(summary.failures.map((f) => [f.memberId, f.memberName])).toEqual([
      [env.producerId, aName],
      [t.bProducer, bName],
    ]);
    expect(summary.stoppedTurns.map((s) => s.memberName).sort()).toEqual([aName, bName].sort());
    expect(describeEmergency(summary).body).toContain(`(${aName}, ${bName})`);
    const act = env.ctx.store.activity.search({ text: '긴급 정지 — 종료 실패 있음' })[0];
    expect(act?.result).toContain(`${aName}: `);
    expect(act?.result).toContain(`${bName}: `);
  });

  it('두 서진 모두 확인하지 못했어도(-1) 한 이름으로 합치지 않는다', async () => {
    e = await bootOrch();
    const env = e;
    const t = await twoProducerTurns(env);
    failTerminate(t.a, -1);
    failTerminate(t.b, -1);
    await env.core.stops.emergency(OWNER);
    expect(failureNotices(env)).toEqual([`남은 프로세스를 확인하지 못했습니다: 서진(${env.ctx.store.projects.require(env.projectId).name}), 서진(B 프로젝트)`]);
  });

  it('같은 프로젝트에서 이름이 같은 두 팀원은 팀원 ID까지 붙인다 — 이름만 겹치지 않는 팀원은 이름 그대로', async () => {
    e = await bootOrch();
    const env = e;
    // 대표가 개발자 이름을 프로듀서와 같게 지었다
    env.ctx.store.members.patch(env.devId, { name: '서진' });
    const d = directiveIn(env, env.projectId, '지시');
    const task = env.core.tasks.create(
      { directiveId: d.id, title: '개발 서버를 띄운 작업', goal: '목표', type: 'development', assigneeId: env.devId, acceptanceCriteria: ['동작한다'], outputMode: 'repo' },
      env.producerId,
    );
    env.hold.add(taskKey(task.id));
    env.hold.add(directiveKey(d.id));
    enqueue(env.ctx, { kind: 'message', memberId: env.producerId, sessionKey: directiveKey(d.id), projectId: env.projectId, directiveId: d.id, message: '진행 상황을 정리해 주세요' });
    env.tick();
    await waitFor(() => !!env.liveProc(taskKey(task.id)) && !!env.liveProc(directiveKey(d.id)), '작업·관리 턴');
    failTerminate(env.liveProc(taskKey(task.id))!, 2);
    failTerminate(env.liveProc(directiveKey(d.id))!, -1);
    const summary = await env.core.stops.emergency(OWNER);
    const p = env.ctx.store.projects.require(env.projectId).name;
    expect(failureNotices(env)).toEqual([`남은 프로세스가 있습니다: 서진(${p}, ${env.devId}) / 남은 프로세스를 확인하지 못했습니다: 서진(${p}, ${env.producerId})`]);
    // 실패하지 않은 메인 에이전트 등은 이름 그대로
    expect(summary.stoppedTurns.filter((s) => s.ok).every((s) => !s.memberName.includes('('))).toBe(true);
  });

  it('고른 이름끼리도 겹치지 않는다 — C의 프로듀서 이름을 서진(B 프로젝트)로 지어도 B의 서진과 같은 이름이 되지 않는다 (S9-D2)', async () => {
    e = await bootOrch();
    const env = e;
    const root = mkdtempSync(join(tmpdir(), 'wook-reg-emnotice-'));
    dirs.push(root);
    const b = await env.internal('projects.create', { mode: 'new', path: join(root, 'b'), name: 'B 프로젝트', checkCommands: [] });
    const c = await env.internal('projects.create', { mode: 'new', path: join(root, 'c'), name: 'C 프로젝트', checkCommands: [] });
    for (const p of [b, c]) await env.internal('projects.setMock', p.id, { enabled: true, speed: 25, defaultScenario: 'normal' });
    await env.main('update_member', { member_id: c.producerId, name: '서진(B 프로젝트)' });
    const turns = [
      [directiveIn(env, env.projectId, 'A 지시'), env.producerId, env.projectId, 2],
      [directiveIn(env, b.id, 'B 지시'), b.producerId, b.id, -1],
      [directiveIn(env, c.id, 'C 지시'), c.producerId, c.id, 2],
    ] as const;
    for (const [d, producer, projectId] of turns) {
      env.hold.add(directiveKey(d.id));
      enqueue(env.ctx, { kind: 'message', memberId: producer, sessionKey: directiveKey(d.id), projectId, directiveId: d.id, message: '진행 상황을 정리해 주세요' });
    }
    env.tick();
    await waitFor(() => turns.every(([d]) => !!env.liveProc(directiveKey(d.id))), '세 프로젝트의 관리 턴');
    for (const [d, , , remaining] of turns) failTerminate(env.liveProc(directiveKey(d.id))!, remaining);
    const summary = await env.core.stops.emergency(OWNER);
    const aName = `서진(${env.ctx.store.projects.require(env.projectId).name})`;
    const bName = `서진(B 프로젝트, ${b.producerId})`;
    const cName = `서진(B 프로젝트)(C 프로젝트, ${c.producerId})`;
    expect(Object.fromEntries(summary.failures.map((f) => [f.memberId, f.memberName]))).toEqual({ [env.producerId]: aName, [b.producerId]: bName, [c.producerId]: cName });
    const [body] = failureNotices(env);
    expect([`남은 프로세스가 있습니다: ${aName}, ${cName}`, `남은 프로세스가 있습니다: ${cName}, ${aName}`].map((left) => `${left} / 남은 프로세스를 확인하지 못했습니다: ${bName}`)).toContain(body);
    // 멈춘 턴의 이름도 팀원마다 다르다
    const byMember = new Map(summary.stoppedTurns.map((s) => [s.memberId, s.memberName]));
    expect(new Set(byMember.values()).size).toBe(byMember.size);
  });
});

describe('긴급 정지 요약의 실패마다 남은 프로세스를 확인하지 못했는지 남긴다 (S8-D3, 12장)', () => {
  it('턴: 남은 수를 센 실패는 remaining 없이(수는 detail), 확인하지 못한 실패는 remaining -1 — 저장된 마지막 요약도 같다', async () => {
    e = await bootOrch();
    const env = e;
    const t = await twoProducerTurns(env);
    failTerminate(t.a, 2);
    failTerminate(t.b, -1);
    const summary = await env.core.stops.emergency(OWNER);
    const counted = summary.failures.find((f) => f.memberId === env.producerId)!;
    const unchecked = summary.failures.find((f) => f.memberId === t.bProducer)!;
    expect(counted).toEqual({ memberId: env.producerId, memberName: counted.memberName, detail: expect.stringContaining('남은 프로세스가 있습니다 (2개)') });
    expect(unchecked).toEqual({ memberId: t.bProducer, memberName: unchecked.memberName, detail: expect.stringContaining('확인하지 못했습니다'), remaining: -1 });
    expect(env.core.stops.lastEmergency()?.failures.map((f) => f.remaining)).toEqual([undefined, -1]);
  });

  it('자동 검사: 확인하지 못한 종료(-1)와 확인되지 않은 종료(0)는 remaining -1, 남은 2개는 값 없음', async () => {
    e = await bootOrch();
    const env = e;
    const d = directiveIn(env, env.projectId, '지시');
    const mk = (title: string) =>
      env.core.tasks.create({ directiveId: d.id, title, goal: '목표', type: 'development', assigneeId: env.devId, acceptanceCriteria: ['동작한다'], outputMode: 'repo' }, env.producerId).id;
    const stuck = (r: TerminateResult): ManagedProcess => ({
      pid: null,
      childPid: Promise.resolve(null),
      exited: new Promise(() => undefined),
      onStdoutLine() {},
      onStderrLine() {},
      terminate: async () => r,
    });
    const ids = [mk('남은 2개'), mk('확인 불가'), mk('확인 안 됨')];
    env.core.checks.running.set(ids[0]!, stuck({ ok: false, remaining: 2, detail: '남은 프로세스 2개', durationMs: 3000 }));
    env.core.checks.running.set(ids[1]!, stuck({ ok: false, remaining: -1, detail: '작업 개체 안을 확인하지 못했습니다', durationMs: 3000 }));
    env.core.checks.running.set(ids[2]!, stuck({ ok: false, remaining: 0, detail: '러너가 종료를 알리지 않았습니다', durationMs: 3000 }));
    const summary = await env.core.stops.emergency(OWNER);
    for (const id of ids) env.core.checks.running.delete(id);
    expect(summary.failures.map((f) => [f.detail.slice(0, `자동 검사 ${ids[0]}`.length), f.remaining])).toEqual([
      [`자동 검사 ${ids[0]}`, undefined],
      [`자동 검사 ${ids[1]}`, -1],
      [`자동 검사 ${ids[2]}`, -1],
    ]);
    // 같은 팀원의 실패 가운데 하나라도 남은 수를 셌으면 알림은 '남은 프로세스가 있습니다'로 그 팀원을 쓴다 (팀원 ID로 한 번)
    expect(failureNotices(env)).toEqual([`남은 프로세스가 있습니다: ${env.ctx.store.members.require(env.devId).name}`]);
  });
});
