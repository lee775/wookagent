/**
 * 남은 프로세스가 있는 프로듀서는 바꾸지 않고, 삭제된 팀원이 남긴 프로세스도 메인에게 간다 (리드 결정 S5-62 — S5-8을 고침).
 * - replace_producer가 지금 프로듀서의 턴을 멈춘 결과에 종료 확인 실패가 있으면 지우지도 바꾸지도 않고 conflict — 그 세션과 남은 수, 그 프로듀서는 프로그램이
 *   일시정지하고 재개 업무가 메인에게 간다(그래서 대표 알림의 '메인 에이전트가 다시 이어 갑니다'가 참이다). 확인한 뒤 다시 부르면 바꾼다. 운영자 신원과 메인 턴, 데스크톱과 서버
 * - 팀원을 지우는 길이 그 턴의 마무리를 기다리지 않아도 남은 프로세스는 메인에게 간다 — 검수 턴은 그 작업 보류(alert kill-failed:<작업>), 관리 턴은 그 세션의 알림
 *   (alert kill-failed:<세션 키>). 삭제된 팀원은 일시정지하지 않는다
 * - 새로 건 팀원 정지도 그 재개 업무를 넣지 못했으면 member_pause의 글('메인 에이전트가 다시 이어 갑니다')을 쓰지 않는다 — 넘긴 사실이나 결정 32의 문장
 * - 멈추지 않고도 알 수 있는 거부(틀린 AI 인자)는 멈추기 전에 한다 — 프로듀서의 턴은 그대로 돈다 (리드 결정 S5-80 1)
 * - 마무리가 상한을 넘긴 남은 프로세스 거부의 글(작업·검수 세션, 이미 일시정지된 프로듀서의 관리 세션)은 실제 상태대로 (리드 결정 S5-82 1)
 * 프로브 server-s5fix5-alerts-flows/zz-s5af6-replaceleft, server-s5fix7-alerts-flows/zz-s5af8-invalidai, server-s5fix7-tests-integrity/zz-s5f7ti-refusal-pending에서.
 * 가짜 프로세스만, 실제 키 없음
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EFFORT_LEVELS, MAIN_AGENT_ID, type QueueEntry } from '@shared/domain';
import { directiveKey, enqueue, mainKey, reviewKey, taskKey } from '../../src/main/orchestrator/records';
import { deadWorkReason } from '../../src/main/orchestrator/turns';
import { alertKey, parseAlertKey } from '../../src/main/orchestrator/alerts';
import type { FakeProc, OrchEnv } from './orchHarness';
import { bootOrch, notices, seedDirective, sleep, startReview, waitFor } from './orchHarness';

let env: OrchEnv | null = null;
/** 시험이 붙잡은 문(정지·마무리·기다림) — 단언이 먼저 실패해도 정리 전에 모두 연다(붙잡힌 턴 때문에 정리가 시간을 넘기고 실행 폴더가 남지 않게) */
const gates: (() => void)[] = [];
afterEach(async () => {
  for (const open of gates.splice(0)) open();
  vi.restoreAllMocks();
  await env?.close();
  env = null;
});

const HANDED = '메인 에이전트에게 넘겼습니다. 메인 에이전트가 확인하고 이어 갑니다 — 서둘러야 하면 명령창으로 메인 에이전트에게 알려 주세요';
const MEMBER_PAUSE = '메인 에이전트가 다시 이어 갑니다';
const ASK = { desktop: '작업 관리자에서 확인해 달라고', server: '서버 PC 운영자의 확인을 부탁해 달라고' } as const;

/** 메인 에이전트의 살아 있는(대기·실행 중, 끝난 일이 아닌) 항목 */
const liveMain = (e: OrchEnv): QueueEntry[] => e.ctx.store.queue.list({ ref1: MAIN_AGENT_ID, state: ['queued', 'running'] }).filter((q) => !deadWorkReason(e.ctx, q));

type Refused = { code: string; message: string };
/** 운영자 신원으로 메인 도구를 부른다 — 받으면 data, 거부면 refused */
async function tryMain(e: OrchEnv, tool: string, args: Record<string, unknown>): Promise<{ data: Record<string, unknown> | null; refused: Refused | null }> {
  return e.main(tool, args).then(
    (data) => ({ data, refused: null }),
    (x: Error & { code?: string }) => ({ data: null, refused: { code: x.code ?? 'error', message: x.message } }),
  );
}

/** 그 메인 턴의 신원으로 부른다 */
async function toolIn(e: OrchEnv, turnId: string, tool: string, args: Record<string, unknown>): Promise<{ data: Record<string, unknown> | null; refused: Refused | null }> {
  const r = await e.tool(turnId, tool, { reason: `시험: ${tool}`, ...args });
  return r.ok ? { data: r.data as Record<string, unknown>, refused: null } : { data: null, refused: { code: r.code, message: r.message } };
}

/** 프로듀서의 지시 관리 턴 하나를 붙잡아 띄운다 */
async function producerTurnUp(e: OrchEnv): Promise<{ dk: string; proc: FakeProc }> {
  const d = seedDirective(e);
  const dk = directiveKey(d.id);
  e.hold.add(dk);
  enqueue(e.ctx, { kind: 'message', memberId: e.producerId, sessionKey: dk, projectId: e.projectId, directiveId: d.id, message: '진행 상황을 정리해 주세요 (시험)' });
  e.tick();
  await waitFor(() => !!e.liveProc(dk, e.producerId), '프로듀서 관리 턴');
  return { dk, proc: e.liveProc(dk, e.producerId)! };
}

/** 대표 명령을 실은 메인 턴(main:general) 하나를 붙잡아 띄운다 */
async function mainTurnUp(e: OrchEnv): Promise<FakeProc> {
  e.hold.add(mainKey(null));
  enqueue(e.ctx, { kind: 'main_command', memberId: MAIN_AGENT_ID, sessionKey: mainKey(null), projectId: null, priority: 'high', message: '대표 명령 (시험):\n프로듀서를 바꿔 줘' });
  await waitFor(
    () => {
      if (!e.liveProc(mainKey(null), MAIN_AGENT_ID)) e.tick();
      return !!e.liveProc(mainKey(null), MAIN_AGENT_ID);
    },
    '메인 턴',
    30_000,
  );
  return e.liveProc(mainKey(null), MAIN_AGENT_ID)!;
}

describe('남은 프로세스가 있는 프로듀서는 바꾸지 않는다 (리드 결정 S5-62 1, 프로브 zz-s5af6-replaceleft)', () => {
  for (const via of ['operator', 'main-turn'] as const) {
    for (const mode of ['desktop', 'server'] as const) {
      it(`${via} · ${mode}: 그 턴의 정지가 프로세스를 남기면 conflict — 지우지 않고, 프로듀서는 일시정지돼 그 재개 업무가 메인에게 가며 대표 알림이 참이다. 확인한 뒤 다시 부르면 바꾼다`, async () => {
        const e = (env = await bootOrch({ mode }));
        const old = e.producerId;
        const name = e.ctx.store.members.require(old).name;
        const membersBefore = e.ctx.store.members.list().length;
        const { dk, proc } = await producerTurnUp(e);
        proc.terminateResult = { ok: false, remaining: 2, detail: '하위 프로세스 2개 남음 (시험)', durationMs: 1 };
        const mp = via === 'main-turn' ? await mainTurnUp(e) : null;
        const call = (args: Record<string, unknown>) => (mp ? toolIn(e, mp.turnId, 'replace_producer', args) : tryMain(e, 'replace_producer', args));
        const r = await call({ project_id: e.projectId, reason: '프로듀서가 멈춤 (시험)' });
        // 거부 — 그 세션과 남은 수, 지금 상태(일시정지·메인에게 간 재개 업무), 다시 부르는 길. 결과를 돌려줄 때 그 턴의 마무리(일시정지·재개 업무)가 끝나 있다
        expect(r.refused?.code).toBe('conflict');
        const item = liveMain(e).find((q) => q.pausedMemberId === old)!;
        expect(item).toBeTruthy();
        expect([item.sessionKey, item.kind]).toEqual([mainKey(e.projectId), 'message']);
        expect(r.refused!.message).toBe(
          `프로듀서 ${name}(${old})을(를) 바꾸지 않았습니다 — 그 턴을 멈췄지만 ${dk} 턴의 하위 프로세스 2개가 남았습니다(종료 확인 실패). 지금 바꾸면 새 프로듀서가 같은 관리 업무를 그 프로세스 위에서 바로 이어 받습니다. ` +
            `이 프로듀서는 일시정지돼 있고, 남은 프로세스를 확인하라는 업무(${item.id})가 메인 에이전트에게 가 있습니다. 남은 프로세스가 모두 사라졌는지 확인한 뒤 replace_producer를 다시 부르면 바꿉니다(일시정지된 채로 불러도 됩니다). ` +
            `바꾸지 않고 이어 쓰려면 확인한 뒤 resume_member(member_id="${old}", reason="…")로 푸세요. 직접 확인할 길이 없으면 ask_owner로 대표에게 ${mode === 'server' ? '서버 PC 운영자의 확인을 부탁해 달라고 하세요' : '작업 관리자에서 확인해 달라고 부탁하세요'}.`,
        );
        // 지우지도 바꾸지도 않았다 — 새 팀원도 없다
        expect(e.ctx.store.projects.require(e.projectId).producerId).toBe(old);
        expect(e.ctx.store.members.require(old)).toMatchObject({ deletedAt: null, isProducer: true });
        expect(e.ctx.store.members.list()).toHaveLength(membersBefore);
        // 그 프로듀서는 프로그램이 건 정지, 재개 업무의 글은 모드에 맞다
        expect(e.ctx.stop().members[old]).toMatchObject({ paused: true, by: 'system' });
        expect(item.message).toContain(ASK[mode]);
        expect(item.message).not.toContain(ASK[mode === 'server' ? 'desktop' : 'server']);
        // 대표 알림은 참이다 — 살아 있는 재개 업무가 있을 때만 '메인 에이전트가 다시 이어 갑니다'
        const said = notices(e, '프로세스 종료 확인 실패').map((n) => n.body);
        expect(said).toHaveLength(1);
        expect(said[0]).toContain('턴 종료 뒤 하위 프로세스 2개가 남았습니다 (종료 확인 실패).');
        expect(said[0]).toContain(MEMBER_PAUSE);
        // 멈춘 관리 업무는 잃지 않는다 — 그 프로듀서 앞에 다시 대기. 일시정지라 남은 프로세스 위에 새 턴이 뜨지 않는다 (CTL-11)
        expect(e.ctx.store.queue.list({ ref1: old, state: 'queued' }).some((q) => q.sessionKey === dk)).toBe(true);
        const mk = mainKey(e.projectId);
        e.hold.add(mk);
        e.hold.delete(dk);
        const launchesBefore = e.launches.length;
        for (let i = 0; i < 5; i++) {
          e.tick();
          await sleep(30);
        }
        expect(e.launches.slice(launchesBefore).filter((l) => l.workKey === dk)).toEqual([]);
        if (mp) {
          // 메인 턴 안에서 다시 부르면 — 아직 받지 않은 그 재개 업무를 한 번 보여 주고 그 턴에 싣는다(S5-49·S5-50). 그다음 호출이 바꾼다
          const second = await call({ project_id: e.projectId, reason: '남은 프로세스 확인함 (시험)' });
          expect(second.refused?.code).toBe('conflict');
          expect(second.refused!.message).toContain(`- 알림 ${item.id} (일시정지된 팀원의 재개 ${old})`);
          expect(e.ctx.store.queue.require(item.id)).toMatchObject({ state: 'running', turnId: mp.turnId });
        } else {
          // 메인 턴(main:P)이 그 재개 업무를 받는다(실행 중 — 본 것) — 그 사이 다시 부르면 바꾼다
          await waitFor(() => e.ctx.store.queue.require(item.id).state === 'running', '재개 업무를 실은 메인 턴');
        }
        // 지운 프로듀서의 정지 기록도 함께 지운다 (S5-64)
        const third = await call({ project_id: e.projectId, reason: '남은 프로세스 확인함 (시험)' });
        expect(third.refused).toBeNull();
        expect(third.data).toMatchObject({ projectId: e.projectId, previousProducerId: old });
        const fresh = e.ctx.store.projects.require(e.projectId).producerId;
        expect(fresh).not.toBe(old);
        expect(e.ctx.store.members.require(old).deletedAt).toBeTruthy();
        expect(e.ctx.stop().members[old]).toBeUndefined();
        // 멈춘 관리 업무는 새 프로듀서가 잇는다
        expect(e.ctx.store.queue.list({ ref1: fresh, state: ['queued', 'running'] }).some((q) => q.sessionKey === dk) || e.launches.some((l) => l.memberId === fresh && l.workKey === dk)).toBe(true);
      });
    }
  }

  it('정지 결과는 확인됐지만 그 턴의 마무리가 먼저 남은 프로세스를 적었으면(kill_failed) 그것도 남은 프로세스다 — 바꾸지 않고, 일시정지·재개 업무는 그대로 산다', async () => {
    const e = (env = await bootOrch());
    const old = e.producerId;
    const { dk, proc } = await producerTurnUp(e);
    // 프로세스가 끝나며 남은 수를 알리고, 정지 결과는 조금 뒤에 온다 — 그 턴의 마무리는 그 결과를 기다렸다가 교체가 이어지기 전에 kill_failed를 적는다
    // (마무리는 정지 결과를 기다리는 쪽이 하나 더 있을 뿐이라 결과가 오자마자 적고, 교체는 정지 묶음을 거쳐 몇 단계 뒤에 이어진다 — 제품의 차례와 같다)
    (proc as unknown as { terminate: () => Promise<unknown> }).terminate = async () => {
      proc.terminatedByApp = true;
      proc.exit(null, { terminated: true, remaining: 2 });
      await sleep(100);
      return { ok: true, remaining: 0, detail: '종료 확인 (시험)', durationMs: 1 };
    };
    const r = await tryMain(e, 'replace_producer', { project_id: e.projectId, reason: '교체 (시험)' });
    expect(r.refused?.code).toBe('conflict');
    expect(r.refused!.message).toContain(`그 턴을 멈췄지만 ${dk} 턴이 끝나며 하위 프로세스가 남았습니다(정리 후 남은 프로세스 2개)`);
    expect(e.ctx.store.projects.require(e.projectId).producerId).toBe(old);
    expect(e.ctx.store.members.require(old).deletedAt).toBeNull();
    expect(e.ctx.stop().members[old]).toMatchObject({ paused: true, by: 'system' });
    // 재개 업무는 살아 있다 — 지웠다면 끝난 일로 버려져 메인에게 아무것도 가지 않는다
    expect(liveMain(e).filter((q) => q.pausedMemberId === old)).toHaveLength(1);
    expect(notices(e, '프로세스 종료 확인 실패').map((n) => n.body).join('\n')).toContain(MEMBER_PAUSE);
  });

  it('대조: 쉬는 프로듀서를 바꾸면 종료 확인 실패 알림도 메인 업무도 없이 바로 바뀐다', async () => {
    const e = (env = await bootOrch());
    const r = await tryMain(e, 'replace_producer', { project_id: e.projectId, reason: '교체 (시험)' });
    expect(r.data).toMatchObject({ projectId: e.projectId, previousProducerId: e.producerId });
    await sleep(100);
    expect(notices(e, '프로세스 종료 확인 실패')).toHaveLength(0);
    expect(liveMain(e).filter((q) => q.sessionKey === mainKey(e.projectId))).toHaveLength(0);
    expect(e.ctx.store.members.require(e.producerId).deletedAt).toBeTruthy();
  });
});

describe('팀원을 지우는 길이 그 턴의 마무리를 기다리지 않아도 남은 프로세스는 메인에게 간다 — 삭제된 팀원은 일시정지하지 않는다 (리드 결정 S5-62 2)', () => {
  for (const mode of ['desktop', 'server'] as const) {
    it(`${mode}: 검수 턴이 도는 팀원을 remove_member로 지우고 그 턴이 프로세스를 남기면 — 그 작업을 보류하고 알림이 메인에게, 대표 알림은 넘긴 사실, 지운 팀원은 일시정지 안 함`, async () => {
      const e = (env = await bootOrch({ mode }));
      const { task, proc } = await startReview(e, e.qaId);
      proc.terminateResult = { ok: false, remaining: 2, detail: '하위 프로세스 2개 남음 (시험)', durationMs: 1 };
      const r = await tryMain(e, 'remove_member', { member_id: e.qaId });
      expect(r.refused).toBeNull();
      await waitFor(() => e.ctx.store.tasks.require(task.id).state === 'on_hold', '그 작업 보류');
      await sleep(50);
      expect(e.ctx.store.members.require(e.qaId).deletedAt).toBeTruthy();
      expect(e.ctx.stop().members[e.qaId]).toBeUndefined();
      expect(e.ctx.store.tasks.require(task.id).hold.reasons.map((x) => [x.kind, x.note])).toEqual([['error', '턴 종료 뒤 하위 프로세스 2개가 남았습니다 (종료 확인 실패).']]);
      const [w] = liveMain(e).filter((q) => q.alertKey === alertKey('kill-failed', task.id));
      expect(w).toBeTruthy();
      expect(w!.sessionKey).toBe(mainKey(e.projectId));
      expect(w!.message).toContain(`resume_task(task_id="${task.id}", reason="…")`);
      expect(w!.message).toContain(ASK[mode]);
      expect(w!.message).not.toContain(ASK[mode === 'server' ? 'desktop' : 'server']);
      const said = notices(e, '프로세스 종료 확인 실패').map((n) => n.body);
      expect(said).toHaveLength(1);
      expect(said[0]).toContain(`작업을 보류하고 ${HANDED}`);
      // 보류된 작업의 검수는 남은 프로세스 위에서 다시 뜨지 않는다 (CTL-11)
      e.hold.delete(reviewKey(task.id));
      const launchesBefore = e.launches.length;
      for (let i = 0; i < 4; i++) {
        e.tick();
        await sleep(30);
      }
      expect(e.launches.slice(launchesBefore).filter((l) => l.workKey === reviewKey(task.id))).toEqual([]);
    });

    it(`${mode}: 교체한 프로듀서의 턴이 정지는 확인됐다고 했는데 지운 뒤에 끝나며 프로세스를 남기면 — 지운 프로듀서는 일시정지하지 않고 그 세션의 알림이 메인에게, 대표 알림은 넘긴 사실`, async () => {
      const e = (env = await bootOrch({ mode }));
      const old = e.producerId;
      const oldName = e.ctx.store.members.require(old).name;
      const { dk, proc } = await producerTurnUp(e);
      // 정지 결과는 확인됨이지만 프로세스가 끝나며 남은 수를 알린다. 그 턴의 마무리는 교체가 지운 뒤에 남은 프로세스를 본다(마무리를 문으로 붙잡는다)
      (proc as unknown as { terminate: () => Promise<unknown> }).terminate = async () => {
        proc.terminatedByApp = true;
        proc.exit(null, { terminated: true, remaining: 2 });
        return { ok: true, remaining: 0, detail: '종료 확인 (시험)', durationMs: 1 };
      };
      let openFinish!: () => void;
      const finishGate = new Promise<void>((r) => (openFinish = r));
      gates.push(() => openFinish());
      const settle = e.core.hostExec.settleTurn.bind(e.core.hostExec);
      vi.spyOn(e.core.hostExec, 'settleTurn').mockImplementation(async (turnId, why) => {
        if (turnId === proc.turnId) await finishGate;
        return settle(turnId, why);
      });
      e.hold.delete(dk);
      const r = await tryMain(e, 'replace_producer', { project_id: e.projectId, reason: '교체 (시험)' });
      expect(r.refused).toBeNull();
      expect(e.ctx.store.members.require(old).deletedAt).toBeTruthy();
      openFinish();
      const fresh = e.ctx.store.projects.require(e.projectId).producerId;
      const freshName = e.ctx.store.members.require(fresh).name;
      const key = alertKey('kill-failed', dk);
      await waitFor(() => e.ctx.store.queue.list({ ref1: MAIN_AGENT_ID }).some((q) => q.alertKey === key), '그 세션의 알림');
      expect(e.ctx.store.members.require(old).deletedAt).toBeTruthy();
      // 지운 프로듀서는 일시정지하지 않는다 — 정지 기록도, 재개 업무도 없다
      expect(e.ctx.stop().members[old]).toBeUndefined();
      expect(e.ctx.store.queue.list({ ref1: MAIN_AGENT_ID }).filter((q) => q.pausedMemberId === old)).toEqual([]);
      const [w] = e.ctx.store.queue.list({ ref1: MAIN_AGENT_ID }).filter((q) => q.alertKey === key);
      expect([w!.kind, w!.state, w!.sessionKey, w!.priority]).toEqual(['alert', 'queued', mainKey(e.projectId), 'high']);
      expect(parseAlertKey(w!.alertKey)).toEqual({ kind: 'kill-failed', target: dk });
      // 팀원이 지워져도 끝난 일이 아니다 — 저절로 풀리는 대상이 없는 한 번의 일
      expect(deadWorkReason(e.ctx, w!)).toBeNull();
      const lines = w!.message.split('\n');
      expect(lines[0]).toContain(`${dk} — ${oldName} `);
      expect(lines[0]).toContain(`(${old}, 삭제된 팀원)의 프로세스 종료를 확인하지 못했습니다. 삭제된 팀원이라 프로그램이 일시정지하지 않았습니다`);
      expect(w!.message).toContain('남은 하위 프로세스 2개');
      expect(w!.message).toContain(`- 이 세션의 관리 업무는 지금 프로듀서 ${freshName}(${fresh})이(가) 이어 받습니다`);
      expect(w!.message).toContain(`pause_member(member_id="${fresh}", mode="graceful", reason="…")`);
      expect(w!.message).toContain(ASK[mode]);
      expect(w!.message).not.toContain(ASK[mode === 'server' ? 'desktop' : 'server']);
      const said = notices(e, '프로세스 종료 확인 실패').map((n) => n.body);
      expect(said).toHaveLength(1);
      expect(said[0]).toContain(`삭제된 팀원이라 일시정지하지 않고 ${HANDED}`);
      expect(said[0]).not.toContain(MEMBER_PAUSE);
      // 그 알림은 다음 메인 턴이 받는다
      await waitFor(
        () => {
          e.tick();
          return e.ctx.store.queue.require(w!.id).state === 'done';
        },
        '메인 턴이 받음',
        30_000,
      );
      const carrier = e.launches.find((l) => l.turnId === e.ctx.store.queue.require(w!.id).turnId);
      expect(carrier?.memberId).toBe(MAIN_AGENT_ID);
      expect(carrier?.message).toContain(dk);
    });
  }

  it('지운 팀원의 관리 실행을 다시 알려도(재시작 복구 등) 일시정지는 걸지 않는다 — blockUnconfirmedRun을 바로 불러 본다', async () => {
    const e = (env = await bootOrch());
    const old = e.producerId;
    const d = seedDirective(e);
    await e.main('replace_producer', { project_id: e.projectId });
    const note = await e.core.turns.blockUnconfirmedRun(
      { label: `${e.ctx.store.members.require(old).name} 이전 턴 TN-9999`, sessionKind: 'directive', sessionKey: directiveKey(d.id), memberId: old, projectId: e.projectId, taskId: null, turnId: null },
      { envProblem: null, remaining: -1, cause: '종료 확인 실패 (시험)', what: '이전 실행' },
    );
    expect(e.ctx.stop().members[old]).toBeUndefined();
    expect(note).toContain(`삭제된 팀원이라 일시정지하지 않고 ${HANDED}`);
    expect(liveMain(e).filter((q) => q.alertKey === alertKey('kill-failed', directiveKey(d.id)))).toHaveLength(1);
  });
});

describe('새로 건 팀원 정지도 재개 업무를 넣지 못했으면 member_pause의 글을 쓰지 않는다 (리드 결정 26·S5-8·S5-62 2)', () => {
  it('재개 업무를 넣지 못하면(처리 실패) 알림 업무(kill-failed:<팀원>)로 넘기고 넘긴 사실을 쓴다', async () => {
    const e = (env = await bootOrch());
    const d = seedDirective(e);
    vi.spyOn(e.core.turns, 'handPauseToMain').mockImplementation(() => {
      throw new Error('재개 업무를 넣지 못함 (시험)');
    });
    const note = await e.core.turns.blockUnconfirmedRun(
      { label: '프로듀서 관리 턴', sessionKind: 'directive', sessionKey: directiveKey(d.id), memberId: e.producerId, projectId: e.projectId, taskId: null, turnId: null },
      { envProblem: null, remaining: 2, cause: null, what: '턴' },
    );
    expect(e.ctx.stop().members[e.producerId]).toMatchObject({ paused: true, by: 'system' });
    expect(note).toContain(`팀원을 일시정지하고 ${HANDED}`);
    expect(note).not.toContain(MEMBER_PAUSE);
    const [w] = liveMain(e).filter((q) => q.alertKey === alertKey('kill-failed', e.producerId));
    expect(w!.message.split('\n')[0]).toContain('프로그램이 일시정지했지만, 그 재개를 맡길 업무를 넣지 못했습니다');
  });

  it('일시정지도 걸지 못하면(처리 실패) 메인에게 간 것이 없다 — 결정 32의 문장', async () => {
    const e = (env = await bootOrch());
    const d = seedDirective(e);
    vi.spyOn(e.core.stops, 'pauseMember').mockRejectedValue(new Error('정지를 저장하지 못함 (시험)'));
    const note = await e.core.turns.blockUnconfirmedRun(
      { label: '프로듀서 관리 턴', sessionKind: 'directive', sessionKey: directiveKey(d.id), memberId: e.producerId, projectId: e.projectId, taskId: null, turnId: null },
      { envProblem: null, remaining: 2, cause: null, what: '턴' },
    );
    expect(note).not.toContain(MEMBER_PAUSE);
    expect(note).not.toContain('메인 에이전트에게 넘겼습니다');
    expect(note).toContain('남은 프로세스가 정리되면 명령창으로 메인 에이전트에게 알려 주세요. 메인 에이전트가 확인하고 이어 갑니다');
    expect(liveMain(e)).toEqual([]);
  });
});

/** 거부 글 끝의 대표 확인 부탁 (모드별) */
const askTail = (mode: 'desktop' | 'server') => `직접 확인할 길이 없으면 ask_owner로 대표에게 ${mode === 'server' ? '서버 PC 운영자의 확인을 부탁해 달라고 하세요' : '작업 관리자에서 확인해 달라고 부탁하세요'}.`;
/** 관리 세션이 남긴 프로세스의 거부에서 다시 부르는 길과 바꾸지 않고 이어 쓰는 길 (일시정지됐거나 될 때) */
const pausedExits = (old: string) =>
  `남은 프로세스가 모두 사라졌는지 확인한 뒤 replace_producer를 다시 부르면 바꿉니다(일시정지된 채로 불러도 됩니다). 바꾸지 않고 이어 쓰려면 확인한 뒤 resume_member(member_id="${old}", reason="…")로 푸세요.`;

/** 프로듀서가 스스로 맡은 작업의 작업 턴 하나를 붙잡아 띄운다 (프로듀서 역할은 계획 작업을 맡는다 — 작은 프로젝트에서 프로듀서가 직접 맡는 경우) */
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

describe('거부 글은 멈춘 턴의 세션 종류와 실제 결과대로 쓰고, 쓴 그대로가 지금 상태다 (리드 결정 S5-73 3·S5-77 3, 프로브 zz-s5af7-producerreview·zz-s5f6ti-refusal-state)', () => {
  for (const mode of ['desktop', 'server'] as const) {
    it(`${mode}: 프로듀서의 검수 턴이 프로세스를 남기면 — 그 작업을 보류했고 알림이 메인에게 갔다고 쓴다(일시정지·새 프로듀서가 그 위에서 잇는다는 말 없음). 적힌 길(다시 부르기·resume_task)이 받는다`, async () => {
      const e = (env = await bootOrch({ mode }));
      const old = e.producerId;
      const name = e.ctx.store.members.require(old).name;
      const { task, proc } = await startReview(e, old);
      proc.terminateResult = { ok: false, remaining: 2, detail: '하위 프로세스 2개 남음 (시험)', durationMs: 1 };
      const r = await tryMain(e, 'replace_producer', { project_id: e.projectId, reason: '프로듀서가 멈춤 (시험)' });
      expect(r.refused?.code).toBe('conflict');
      // 실제 상태 — 작업 보류(사실만)와 그 작업의 알림 하나. 프로듀서는 일시정지도 재개 업무도 없고 바뀌지 않았다
      const t = e.ctx.store.tasks.require(task.id);
      expect(t.state).toBe('on_hold');
      expect(t.hold.reasons.map((x) => [x.kind, x.note])).toEqual([['error', '턴 종료 뒤 하위 프로세스 2개가 남았습니다 (종료 확인 실패).']]);
      const [w] = liveMain(e).filter((q) => q.alertKey === alertKey('kill-failed', task.id));
      expect(w).toBeTruthy();
      expect(e.ctx.stop().members[old]).toBeUndefined();
      expect(liveMain(e).filter((q) => q.pausedMemberId === old || q.alertKey === alertKey('kill-failed', old))).toEqual([]);
      expect(e.ctx.store.projects.require(e.projectId).producerId).toBe(old);
      // 글 — 그 상태 그대로. 관리 세션이 아니라 '새 프로듀서가 그 프로세스 위에서 잇는다'는 까닭과 resume_member는 없다
      expect(r.refused!.message).toBe(
        `프로듀서 ${name}(${old})을(를) 바꾸지 않았습니다 — 그 턴을 멈췄지만 ${reviewKey(task.id)} 턴의 하위 프로세스 2개가 남았습니다(종료 확인 실패). ` +
          `작업 ${task.id}을(를) 보류했고, 남은 프로세스를 확인하라는 알림(${w!.id})이 메인 에이전트에게 가 있습니다. ` +
          `남은 프로세스가 모두 사라졌는지 확인한 뒤 resume_task(task_id="${task.id}", reason="…")로 그 보류를 푸세요. ` +
          `replace_producer는 다시 부르면 바꿉니다 — 그 작업의 보류는 바꾼 뒤에도 그대로 남아, 남은 프로세스 위에서 새 턴이 뜨지 않습니다. ${askTail(mode)}`,
      );
      expect(r.refused!.message).not.toContain('일시정지');
      expect(r.refused!.message).not.toContain('새 프로듀서가 같은 관리 업무');
      expect(r.refused!.message).not.toContain('resume_member');
      // 적힌 길 1 — 다시 부르면 바꾼다. 바꾼 뒤에도 그 보류가 남아 그 검수는 남은 프로세스 위에서 뜨지 않는다
      const again = await tryMain(e, 'replace_producer', { project_id: e.projectId, reason: '다시 (시험)' });
      expect(again.data).toMatchObject({ projectId: e.projectId, previousProducerId: old });
      e.hold.delete(reviewKey(task.id));
      const launchesBefore = e.launches.length;
      for (let i = 0; i < 4; i++) {
        e.tick();
        await sleep(30);
      }
      expect(e.launches.slice(launchesBefore).filter((l) => l.workKey === reviewKey(task.id))).toEqual([]);
      expect(e.ctx.store.tasks.require(task.id).state).toBe('on_hold');
      // 적힌 길 2 — resume_task가 그 보류를 푼다(아직 받지 않은 알림이면 한 번 보여 준 뒤)
      let resumed = await tryMain(e, 'resume_task', { task_id: task.id, reason: '남은 프로세스 확인함 (시험)' });
      if (resumed.refused) {
        expect(resumed.refused.message).toContain(w!.id);
        resumed = await tryMain(e, 'resume_task', { task_id: task.id, reason: '남은 프로세스 확인함 (시험)' });
      }
      expect(resumed.data).toMatchObject({ taskId: task.id, state: 'in_review' });
    });
  }

  it('프로듀서가 맡은 작업의 작업 턴이 프로세스를 남겨도 같다 — 그 작업 보류와 알림, resume_task', async () => {
    const e = (env = await bootOrch());
    const old = e.producerId;
    const { taskId, key, proc } = await producerTaskTurnUp(e);
    proc.terminateResult = { ok: false, remaining: 1, detail: '하위 프로세스 1개 남음 (시험)', durationMs: 1 };
    const r = await tryMain(e, 'replace_producer', { project_id: e.projectId, reason: '프로듀서가 멈춤 (시험)' });
    expect(r.refused?.code).toBe('conflict');
    const [w] = liveMain(e).filter((q) => q.alertKey === alertKey('kill-failed', taskId));
    expect(w).toBeTruthy();
    expect(e.ctx.store.tasks.require(taskId).state).toBe('on_hold');
    expect(e.ctx.stop().members[old]).toBeUndefined();
    expect(r.refused!.message).toContain(`그 턴을 멈췄지만 ${key} 턴의 하위 프로세스 1개가 남았습니다(종료 확인 실패). 작업 ${taskId}을(를) 보류했고, 남은 프로세스를 확인하라는 알림(${w!.id})이 메인 에이전트에게 가 있습니다.`);
    expect(r.refused!.message).toContain(`resume_task(task_id="${taskId}", reason="…")`);
    expect(r.refused!.message).not.toContain('일시정지');
    expect(r.refused!.message).not.toContain('새 프로듀서가 같은 관리 업무');
  });

  it('그 턴의 마무리가 상한(5초)을 넘겨도 끝나지 않으면 — 아직 일시정지하지 않았다고 앞으로 할 일로 쓴다. 마무리가 끝나면 그대로 된다 (변이 O13-m-refusal-now-claims-paused)', async () => {
    const e = (env = await bootOrch());
    const old = e.producerId;
    const name = e.ctx.store.members.require(old).name;
    const { dk, proc } = await producerTurnUp(e);
    // 종료 확인 실패를 돌려주지만 CLI는 끝나지 않는다 — 그 턴의 마무리(일시정지·재개 업무)가 아직 돌지 않는다
    (proc as unknown as { terminate: () => Promise<unknown> }).terminate = async () => {
      proc.terminatedByApp = true;
      return { ok: false, remaining: 2, detail: '하위 프로세스 2개 남음 (시험)', durationMs: 1 };
    };
    gates.push(() => proc.exit(null, { terminated: true }));
    const r = await tryMain(e, 'replace_producer', { project_id: e.projectId, reason: '프로듀서가 멈춤 (시험)' });
    expect(r.refused?.code).toBe('conflict');
    // 실제 상태 — 아직 일시정지·재개 업무·알림이 없다
    expect(e.ctx.stop().members[old]).toBeUndefined();
    expect(liveMain(e).filter((q) => q.pausedMemberId === old || q.alertKey === alertKey('kill-failed', old))).toEqual([]);
    expect(r.refused!.message).toBe(
      `프로듀서 ${name}(${old})을(를) 바꾸지 않았습니다 — 그 턴을 멈췄지만 ${dk} 턴의 하위 프로세스 2개가 남았습니다(종료 확인 실패). 지금 바꾸면 새 프로듀서가 같은 관리 업무를 그 프로세스 위에서 바로 이어 받습니다. ` +
        `그 턴의 마무리가 끝나면 프로그램이 이 프로듀서를 일시정지하고, 남은 프로세스를 확인하라는 업무를 메인 에이전트에게 넣습니다. ${pausedExits(old)} ${askTail('desktop')}`,
    );
    expect(r.refused!.message).not.toContain('이 프로듀서는 일시정지돼 있');
    // 앞으로 한다고 쓴 일이 그대로 된다 — 마무리가 끝나면 일시정지와 재개 업무
    proc.exit(null, { terminated: true });
    await waitFor(() => !!e.ctx.stop().members[old]?.paused && liveMain(e).some((q) => q.pausedMemberId === old), '마무리가 일시정지하고 재개 업무를 넣음');
    expect(e.ctx.stop().members[old]).toMatchObject({ paused: true, by: 'system' });
  }, 30_000);

  it('일시정지는 됐는데 재개 업무를 넣지 못하면(handPauseToMain이 던짐) — 그 대신 메인에게 간 알림을 알림이라고 쓴다', async () => {
    const e = (env = await bootOrch());
    const old = e.producerId;
    const { dk, proc } = await producerTurnUp(e);
    vi.spyOn(e.core.turns, 'handPauseToMain').mockImplementation(() => {
      throw new Error('재개 업무를 넣지 못함 (시험)');
    });
    proc.terminateResult = { ok: false, remaining: 2, detail: '하위 프로세스 2개 남음 (시험)', durationMs: 1 };
    const r = await tryMain(e, 'replace_producer', { project_id: e.projectId, reason: '프로듀서가 멈춤 (시험)' });
    expect(r.refused?.code).toBe('conflict');
    // 실제 상태 — 프로그램이 건 정지, 재개 업무(pausedMemberId)는 없고 그 팀원의 kill-failed 알림 하나
    expect(e.ctx.stop().members[old]).toMatchObject({ paused: true, by: 'system' });
    expect(liveMain(e).filter((q) => q.pausedMemberId === old)).toEqual([]);
    const [w] = liveMain(e).filter((q) => q.alertKey === alertKey('kill-failed', old));
    expect(w).toBeTruthy();
    expect(r.refused!.message).toContain(`그 턴을 멈췄지만 ${dk} 턴의 하위 프로세스 2개가 남았습니다(종료 확인 실패). 지금 바꾸면 새 프로듀서가 같은 관리 업무를 그 프로세스 위에서 바로 이어 받습니다.`);
    expect(r.refused!.message).toContain(`이 프로듀서는 일시정지돼 있고, 남은 프로세스를 확인하라는 알림(${w!.id})이 메인 에이전트에게 가 있습니다. ${pausedExits(old)}`);
  });

  it('일시정지는 됐는데 메인에게 간 것이 없으면(재개 업무도 알림도 못 넣음) — 간 것이 없다고 쓴다', async () => {
    const e = (env = await bootOrch());
    const old = e.producerId;
    const { dk, proc } = await producerTurnUp(e);
    vi.spyOn(e.core.turns, 'handPauseToMain').mockImplementation(() => {
      throw new Error('재개 업무를 넣지 못함 (시험)');
    });
    // 같은 키의 알림이 이 정지 뒤에 만들어져 이미 끝난 것으로 둔다 — 끝난 알림은 다시 만들지 않으므로(리드 결정 S5-25 3) 알림도 들어가지 않는다
    const done = enqueue(e.ctx, { kind: 'alert', memberId: MAIN_AGENT_ID, sessionKey: mainKey(e.projectId), projectId: e.projectId, priority: 'high', message: '앞선 알림 (시험)', alertKey: alertKey('kill-failed', old) });
    e.ctx.store.queue.put({ ...e.ctx.store.queue.require(done.id), state: 'done', doneAt: e.ctx.now(), createdAt: '9999-01-01T00:00:00.000Z' });
    proc.terminateResult = { ok: false, remaining: 2, detail: '하위 프로세스 2개 남음 (시험)', durationMs: 1 };
    const r = await tryMain(e, 'replace_producer', { project_id: e.projectId, reason: '프로듀서가 멈춤 (시험)' });
    expect(r.refused?.code).toBe('conflict');
    expect(e.ctx.stop().members[old]).toMatchObject({ paused: true, by: 'system' });
    expect(liveMain(e).filter((q) => q.pausedMemberId === old || q.alertKey === alertKey('kill-failed', old))).toEqual([]);
    expect(r.refused!.message).toContain(`그 턴을 멈췄지만 ${dk} 턴의 하위 프로세스 2개가 남았습니다(종료 확인 실패).`);
    expect(r.refused!.message).toContain(`이 프로듀서는 일시정지돼 있지만, 남은 프로세스를 확인하라는 업무는 메인 에이전트에게 가지 않았습니다. ${pausedExits(old)}`);
  });

  it('그 턴의 마무리가 일시정지도 하지 못하면 — 일시정지하지 못했고 간 것도 없다고 쓰고, 풀 정지가 없으니 resume_member를 적지 않는다', async () => {
    const e = (env = await bootOrch());
    const old = e.producerId;
    const { dk, proc } = await producerTurnUp(e);
    vi.spyOn(e.core.stops, 'pauseMember').mockRejectedValue(new Error('정지를 저장하지 못함 (시험)'));
    proc.terminateResult = { ok: false, remaining: 2, detail: '하위 프로세스 2개 남음 (시험)', durationMs: 1 };
    const r = await tryMain(e, 'replace_producer', { project_id: e.projectId, reason: '프로듀서가 멈춤 (시험)' });
    expect(r.refused?.code).toBe('conflict');
    expect(e.ctx.stop().members[old]).toBeUndefined();
    expect(liveMain(e).filter((q) => q.pausedMemberId === old || q.alertKey === alertKey('kill-failed', old))).toEqual([]);
    expect(r.refused!.message).toContain(
      `그 턴을 멈췄지만 ${dk} 턴의 하위 프로세스 2개가 남았습니다(종료 확인 실패). 지금 바꾸면 새 프로듀서가 같은 관리 업무를 그 프로세스 위에서 바로 이어 받습니다. ` +
        `그 턴의 마무리가 이 프로듀서를 일시정지하지 못했고, 메인 에이전트에게 간 업무도 없습니다. 남은 프로세스가 모두 사라졌는지 확인한 뒤 replace_producer를 다시 부르면 바꿉니다. ${askTail('desktop')}`,
    );
    expect(r.refused!.message).not.toContain('resume_member');
  });
});

describe('멈추지 않고도 알 수 있는 거부는 멈추기 전에 한다 — 그 거부는 어느 턴도 건드리지 않는다 (리드 결정 S5-80 1, 프로브 zz-s5af8-invalidai)', () => {
  it('틀린 AI 인자(노력치 값·목록 밖 모델·AI 종류·노력치 단계)는 invalid로 거부하고 프로듀서의 작업 턴은 그대로 돈다 — 메인 도구와 운영자 내부 API 둘 다. 맞는 인자면 그때 멈추고 바꾼다', async () => {
    const e = (env = await bootOrch());
    const old = e.producerId;
    const membersBefore = e.ctx.store.members.list().length;
    const { taskId, key, proc } = await producerTaskTurnUp(e);
    const codexIds = (e.ctx.settings().team.modelCatalog?.codex ?? []).map((o) => o.id).join(', ');
    const claudeEffort = `claude 노력치 값은 ${EFFORT_LEVELS.claude.join('|')} 중 하나여야 합니다`;
    const asRefusal = (p: Promise<unknown>) =>
      p.then(
        () => null,
        (x: Error & { code?: string }) => ({ code: x.code, message: x.message }),
      );
    const cases: [string, () => Promise<unknown>, string][] = [
      ['메인 도구 · 노력치 값', () => e.main('replace_producer', { project_id: e.projectId, reason: '프로듀서가 멈춤 (시험)', ai_kind: 'claude', effort: 'minimal' }), claudeEffort],
      [
        '메인 도구 · 목록 밖 모델',
        () => e.main('replace_producer', { project_id: e.projectId, reason: '프로듀서가 멈춤 (시험)', ai_kind: 'codex', model: 'gpt-not-in-catalog' }),
        `codex 모델 "gpt-not-in-catalog"은(는) 운영 설정 모델 목록에 없습니다. list_ai_options의 models.codex id 중에서 고르세요: ${codexIds}`,
      ],
      ['운영자 내부 API · 노력치 값', () => e.internal('members.replaceProducer', e.projectId, { ai: { kind: 'claude', effortOverride: 'minimal' } }), claudeEffort],
      ['운영자 내부 API · AI 종류', () => e.internal('members.replaceProducer', e.projectId, { ai: { kind: 'gemini' as never } }), 'AI 종류는 claude|codex 중 하나여야 합니다'],
      ['운영자 내부 API · 노력치 단계', () => e.internal('members.replaceProducer', e.projectId, { ai: { effortTier: 'ultra' as never } }), '노력치 단계는 high|normal|low 중 하나여야 합니다'],
    ];
    for (const [label, call, message] of cases) {
      expect(await asRefusal(call()), label).toEqual({ code: 'invalid', message });
      // 어느 턴도 건드리지 않았다 — 그 작업 턴은 그대로 돌고, 새 턴 붙잡기도 남지 않았다. 바꾸지 않았고 새 팀원도 없다
      expect(proc.terminatedByApp, label).toBe(false);
      expect(e.liveProc(key, old), label).toBe(proc);
      expect(e.ctx.store.turns.require(proc.turnId).process.stopMode ?? null, label).toBeNull();
      expect(e.core.turns.launchHeld(old), label).toBe(false);
      expect(e.ctx.store.tasks.require(taskId), label).toMatchObject({ state: 'in_progress', assigneeId: old });
      expect(e.ctx.store.projects.require(e.projectId).producerId, label).toBe(old);
      expect(e.ctx.store.members.list(), label).toHaveLength(membersBefore);
    }
    // 맞는 인자면 그때 그 턴을 멈추고 바꾼다 — 그 작업은 새 프로듀서에게
    const v = await e.main('replace_producer', { project_id: e.projectId, reason: '프로듀서 교체 (시험)', ai_kind: 'claude', model: 'opus', effort: EFFORT_LEVELS.claude[0] });
    expect(v).toMatchObject({ projectId: e.projectId, previousProducerId: old });
    expect(proc.terminatedByApp).toBe(true);
    expect(e.ctx.store.tasks.require(taskId).assigneeId).toBe(v.producerId);
  });
});

describe('마무리가 상한을 넘긴 남은 프로세스 거부의 글도 실제 상태대로 — 앞으로 할 일과 그 뒤의 길 (리드 결정 S5-82 1, 프로브 zz-s5f7ti-refusal-pending)', () => {
  /** 종료 확인 실패를 돌려주지만 CLI는 끝나지 않는다 — 그 턴의 마무리가 아직 돌지 않는다. 시험이 끝나면(또는 실패하면) 끝낸다 */
  function unconfirmedNoExit(proc: FakeProc, remaining: number): void {
    (proc as unknown as { terminate: () => Promise<unknown> }).terminate = async () => {
      proc.terminatedByApp = true;
      return { ok: false, remaining, detail: `하위 프로세스 ${remaining}개 남음 (시험)`, durationMs: 1 };
    };
    gates.push(() => proc.exit(null, { terminated: true }));
  }

  for (const kind of ['task', 'review'] as const) {
    it(`프로듀서의 ${kind === 'task' ? '작업' : '검수'} 턴이 프로세스를 남기고 그 마무리가 상한(5초)을 넘기면 — 마무리가 그 작업을 보류하고 알림을 넣는다고 앞으로 할 일로 쓰고, 다시 부르는 길은 '마무리가 끝난 뒤'. 그대로 된다`, async () => {
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
      const stateBefore = e.ctx.store.tasks.require(taskId).state;
      unconfirmedNoExit(proc, 1);
      const r = await tryMain(e, 'replace_producer', { project_id: e.projectId, reason: '프로듀서가 멈춤 (시험)' });
      expect(r.refused?.code).toBe('conflict');
      // 실제 상태 — 아직 보류하지 않았고 알림도 없다. 일시정지하지 않았고 바꾸지 않았다
      expect(e.ctx.store.tasks.require(taskId).state).toBe(stateBefore);
      expect(liveMain(e).filter((q) => q.alertKey === alertKey('kill-failed', taskId))).toEqual([]);
      expect(e.ctx.stop().members[old]).toBeUndefined();
      expect(e.ctx.store.projects.require(e.projectId).producerId).toBe(old);
      expect(r.refused!.message).toBe(
        `프로듀서 ${name}(${old})을(를) 바꾸지 않았습니다 — 그 턴을 멈췄지만 ${key} 턴의 하위 프로세스 1개가 남았습니다(종료 확인 실패). ` +
          `그 턴의 마무리가 끝나면 프로그램이 작업 ${taskId}을(를) 보류하고, 남은 프로세스를 확인하라는 알림을 메인 에이전트에게 넣습니다. ` +
          `그 뒤 남은 프로세스가 모두 사라졌는지 확인하고 resume_task(task_id="${taskId}", reason="…")로 그 보류를 푸세요. ` +
          `그 턴의 마무리가 끝난 뒤 replace_producer를 다시 부르면 바꿉니다. ${askTail('desktop')}`,
      );
      // 앞으로 한다고 쓴 일이 그대로 된다 — 마무리가 그 작업을 보류하고 그 알림을 넣는다
      proc.exit(null, { terminated: true });
      await waitFor(
        () => e.ctx.store.tasks.require(taskId).state === 'on_hold' && liveMain(e).some((q) => q.alertKey === alertKey('kill-failed', taskId)),
        '마무리가 그 작업을 보류하고 알림을 넣음',
      );
      expect(e.ctx.stop().members[old]).toBeUndefined();
      // 적힌 길 — 마무리가 끝난 뒤 다시 부르면 바꾸고, 그 보류는 그대로 남는다
      const again = await tryMain(e, 'replace_producer', { project_id: e.projectId, reason: '다시 (시험)' });
      expect(again.data).toMatchObject({ projectId: e.projectId, previousProducerId: old });
      expect(e.ctx.store.tasks.require(taskId).state).toBe('on_hold');
    }, 40_000);
  }

  it('이미 일시정지된 프로듀서의 관리 턴이 프로세스를 남기고 마무리가 상한을 넘기면 — 일시정지돼 있고 마무리가 알림을 넣는다고 쓴다(일시정지하겠다고 하지 않는다). 그대로 된다', async () => {
    const e = (env = await bootOrch());
    const old = e.producerId;
    const name = e.ctx.store.members.require(old).name;
    const { dk, proc } = await producerTurnUp(e);
    const s = e.ctx.stop();
    e.ctx.saveStop({ ...s, members: { ...s.members, [old]: { paused: true, mode: 'graceful', by: MAIN_AGENT_ID, since: e.ctx.now() } } });
    unconfirmedNoExit(proc, 2);
    const r = await tryMain(e, 'replace_producer', { project_id: e.projectId, reason: '프로듀서가 멈춤 (시험)' });
    expect(r.refused?.code).toBe('conflict');
    // 실제 상태 — 메인이 건 일시정지 그대로, 메인에게 간 것은 아직 없다
    expect(e.ctx.stop().members[old]).toMatchObject({ paused: true, by: MAIN_AGENT_ID });
    expect(liveMain(e).filter((q) => q.pausedMemberId === old || q.alertKey === alertKey('kill-failed', old))).toEqual([]);
    expect(r.refused!.message).toBe(
      `프로듀서 ${name}(${old})을(를) 바꾸지 않았습니다 — 그 턴을 멈췄지만 ${dk} 턴의 하위 프로세스 2개가 남았습니다(종료 확인 실패). 지금 바꾸면 새 프로듀서가 같은 관리 업무를 그 프로세스 위에서 바로 이어 받습니다. ` +
        `이 프로듀서는 일시정지돼 있고, 그 턴의 마무리가 끝나면 남은 프로세스를 확인하라는 알림을 메인 에이전트에게 넣습니다. ${pausedExits(old)} ${askTail('desktop')}`,
    );
    // 앞으로 한다고 쓴 일이 그대로 된다 — 그 팀원의 알림(kill-failed:<팀원>). 정지는 메인이 건 그대로
    proc.exit(null, { terminated: true });
    await waitFor(() => liveMain(e).some((q) => q.alertKey === alertKey('kill-failed', old)), '마무리가 그 알림을 넣음');
    expect(e.ctx.stop().members[old]).toMatchObject({ paused: true, by: MAIN_AGENT_ID });
  }, 40_000);
});
