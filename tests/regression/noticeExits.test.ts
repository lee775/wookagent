/**
 * 메인 에이전트에게 업무가 가지 않는 보류·실패의 대표 알림은 출구를 말한다 (리드 결정 40, 10-30 — S1F8 알아 둘 것 2):
 * - '업무 시작 실패'(검수 턴 시작 실패 보류 포함, 리드 결정 28), 작업의 '자동 복구 실패', '병합 충돌 해결 실패', '복구 확인 필요', '작업 공간 생성 실패',
 *   '검수 제출 처리 실패', '작업 취소 실패'는 사실만 말하고 끝났다 — 대표는 무엇을 할 수 있는지 알 수 없었다. 이 보류들은 5단계 alertsToMain 전까지
 *   메인 에이전트에게 업무를 주지 않으므로, 글 끝에 결정 32의 문장('…명령창으로 메인 에이전트에게 알려 주세요. 메인 에이전트가 확인하고 이어 갑니다')을 둔다
 * - '병합 충돌 해결 실패'의 '대표 판단이 필요합니다'는 메인 에이전트에게 명령만 하는 대표에게 맞는 문장으로 바꿨다 (conflictSpin이 본문을 본다)
 * - 글만 보는 확인(merges.ts의 '…실패'·'…보류' 알림, 위 목록)은 ownerTextsNoResume이 한다
 * - 관리 업무를 버린 비정상 종료 상한의 '자동 복구 실패'와 '헛돌기'도 대표 요청·보류 넘김을 적지 않으면 같은 문장으로 끝난다 (리드 결정 45)
 * - 작업 턴이 CLI 안전 검사 거부(개별 명령 거부)나 바이패스 설정 불일치로 끝나면 작업은 곧바로 오류 보류다 — 이 보류도 메인 업무가 없다. 'CLI 안전 검사
 *   거부'·'바이패스 설정 불일치' 알림은 작업 세션일 때만 보류했다고 말하고 같은 문장으로 끝난다. 개별 명령 거부의 보류 사유는 '바이패스 설정 불일치'가
 *   아니라 'CLI 안전 검사가 명령을 거부함'이다. 작업 세션 밖의 알림은 그대로다 — 설정 문제의 출구는 설치 설정이다 (리드 결정 48, 프로브
 *   zz-s1fix6-os-bh-bypass-task-hold BH·BH-b)
 * 5단계 S5b (리드 결정 S5-7·S5-9): 작업에 건 그 보류들은 이제 메인 에이전트에게 알림 업무로 간다(alert start-fail·crash·cli-refusal·bypass:<작업>). 알림은 보류한 뒤
 * 넘긴 사실과 서두를 때의 길('작업을 보류하고 메인 에이전트에게 넘겼습니다. 메인 에이전트가 확인하고 이어 갑니다 — 서둘러야 하면 명령창으로 메인 에이전트에게 알려
 * 주세요')로 끝난다 — 출구는 그대로 명령창이고, 메인에게 일이 간다는 것이 이제 사실이다. 관리 업무를 버린 상한 알림(메인에게 다시 가지 않음)은 결정 32의 문장 그대로다
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID } from '@shared/domain';
import { directiveKey, enqueue, reviewKey, taskKey } from '../../src/main/orchestrator/records';
import type { OrchEnv } from './orchHarness';
import { bootOrch, notices, seedDirective, seedInReviewTask, sleep, waitFor } from './orchHarness';

let env: OrchEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const TELL = '명령창으로 메인 에이전트에게 알려 주세요. 메인 에이전트가 확인하고 이어 갑니다';
/** 메인 에이전트에게 알림 업무를 넣은 뒤의 출구 (리드 결정 S5-9) */
const HANDED = '메인 에이전트에게 넘겼습니다. 메인 에이전트가 확인하고 이어 갑니다 — 서둘러야 하면 명령창으로 메인 에이전트에게 알려 주세요';
/** 그 작업의 메인 알림 업무의 키 (상태와 상관없이) */
const alertKeys = (e: OrchEnv, taskId: string) => e.ctx.store.queue.list({ ref1: MAIN_AGENT_ID }).filter((q) => q.kind === 'alert' && q.taskId === taskId).map((q) => q.alertKey);

describe('메인 업무가 없는 보류·실패의 대표 알림은 명령창으로 메인 에이전트에게 알리는 길을 적는다 (리드 결정 40)', () => {
  it('검수 턴이 세 번 시작하지 못하면 보류하고 메인 에이전트에게 넘긴다 — 업무 시작 실패 알림이 넘긴 사실과 그 길을 적는다 (리드 결정 28의 보류, S5-9)', async () => {
    const e = (env = await bootOrch());
    const d = seedDirective(e);
    const t = seedInReviewTask(e, e.qaId, { outputMode: 'repo', directiveId: d.id });
    const key = reviewKey(t.id);
    let fails = 0;
    e.prepareHook = (_launch, who) => {
      if (who.sessionKey === key) {
        fails += 1;
        throw new Error('모델 이름을 찾을 수 없습니다 (시험)');
      }
    };
    e.core.tasks.dispatchReview(e.ctx.store.tasks.require(t.id));
    await waitFor(
      () => {
        if (e.core.turns.count() === 0) e.tick();
        return fails >= 3 && e.ctx.store.tasks.require(t.id).state === 'on_hold';
      },
      '검수 턴 시작 실패 3번과 보류',
      20_000,
    );
    await sleep(50);
    expect(e.ctx.store.tasks.require(t.id).hold.reasons.map((r) => [r.kind, r.note])).toEqual([['error', '턴 시작 3회 실패: 모델 이름을 찾을 수 없습니다 (시험)']]);
    // 멈춘 업무를 이름으로 적는다 — 끝 문장이 가리키는 일 (리드 결정 43)
    expect(notices(e, '업무 시작 실패').map((n) => n.body)).toEqual([`${key}: 모델 이름을 찾을 수 없습니다 (시험) — 3번 시작하지 못해 멈춘 업무: 검수 ${t.id}. 작업을 보류하고 ${HANDED}`]);
    expect(alertKeys(e, t.id)).toEqual([`alert:start-fail:${t.id}`]);
  });

  it("작업 턴의 비정상 종료 상한(자동 복구 실패)은 작업을 보류하고 메인 에이전트에게 넘겼다고 말하고 그 길을 적는다 (S5-9)", async () => {
    const e = (env = await bootOrch());
    const d = seedDirective(e);
    const t = e.core.tasks.create({ directiveId: d.id, title: '로그인 화면', goal: '로그인 화면', type: 'development', assigneeId: e.devId, acceptanceCriteria: ['동작한다'], outputMode: 'repo' }, e.producerId);
    e.script.set(taskKey(t.id), (p) => p.exit(1));
    await e.drain(6);
    expect(e.ctx.store.tasks.require(t.id).state).toBe('on_hold');
    const max = e.ctx.settings().execution.crashRetryMax;
    expect(notices(e, '자동 복구 실패').map((n) => [n.key, n.body])).toEqual([
      [`crash:${t.id}`, `${t.id} 로그인 화면 — 비정상 종료 재시작 ${max}회 실패로 작업을 보류하고 ${HANDED}`],
    ]);
    expect(alertKeys(e, t.id)).toEqual([`alert:crash:${t.id}`]);
  });
});

// 리드 결정 45 (owner-surface 5차 재리뷰 NX, S1F11 알아 둘 것 4): 관리 업무를 버린 상한 알림도 대표 요청·보류 넘김을 적지 않으면 출구가 없었다 — 버린 일은
// 아무에게도 다시 가지 않는다(다음 시작의 관리 업무 복원 말고는). 글만 보는 확인은 ownerTextsNoResume이 모든 갈래로 한다
describe('대표 요청 없이 관리 업무를 버린 상한 알림도 명령창 길을 적는다 (리드 결정 45)', () => {
  it("프로듀서의 계획 업무를 비정상 종료 상한에서 버린 '자동 복구 실패'는 결정 32의 문장으로 끝난다", async () => {
    const e = (env = await bootOrch());
    const d = seedDirective(e, '계획 지시');
    e.ctx.store.directives.put({ ...e.ctx.store.directives.require(d.id), state: 'planning' });
    const key = directiveKey(d.id);
    e.script.set(key, (p) => p.exit(1));
    enqueue(e.ctx, { kind: 'plan', memberId: e.producerId, sessionKey: key, projectId: e.projectId, directiveId: d.id, priority: 'high', message: '계획을 세우세요' });
    await waitFor(
      () => {
        e.tick();
        return notices(e, '자동 복구 실패').length > 0;
      },
      '비정상 종료 상한',
      40_000,
    );
    await sleep(50);
    const n = notices(e, '자동 복구 실패');
    expect(n.map((x) => x.key)).toEqual([`crash:${key}`]);
    expect(n[0]!.body).toMatch(new RegExp(` — 비정상 종료가 반복됩니다\\. 원인이 정리되면 ${TELL}$`));
    expect(e.ctx.store.queue.list({ ref2: key, state: ['queued', 'running'] })).toEqual([]);
  });

  it("헛돌기로 끝난 프로듀서 턴의 '헛돌기' 알림도 결정 32의 문장으로 끝난다", async () => {
    const e = (env = await bootOrch());
    const d = seedDirective(e, '계획 지시');
    e.ctx.store.directives.put({ ...e.ctx.store.directives.require(d.id), state: 'planning' });
    const key = directiveKey(d.id);
    e.script.set(key, (p) => {
      for (let i = 0; i < 5; i++) p.emit({ kind: 'error', text: '같은 오류', data: {} });
    });
    enqueue(e.ctx, { kind: 'plan', memberId: e.producerId, sessionKey: key, projectId: e.projectId, directiveId: d.id, priority: 'high', message: '계획을 세우세요' });
    await waitFor(
      () => {
        e.tick();
        return notices(e, '헛돌기').length > 0;
      },
      '헛돌기',
      40_000,
    );
    await sleep(50);
    const n = notices(e, '헛돌기');
    expect(n.map((x) => x.key)).toEqual([`spin:${key}`]);
    expect(n[0]!.body).toMatch(new RegExp(` — 같은 오류가 반복됐습니다\\. 원인이 정리되면 ${TELL}$`));
  });
});

// 리드 결정 48 (owner-surface 6차 재리뷰 BH·BH-b): 작업 턴의 바이패스 불일치 보류는 1단계 전부터 있었고 그때는 대표의 재개가 출구였다. 1단계가 대표의 재개를
// 없앤 뒤로 출구는 메인 에이전트 하나인데, 메인에게 가는 업무가 없고(5단계 alertsToMain) 알림도 작업을 보류했다는 것과 출구를 말하지 않았다
describe("작업 턴의 'CLI 안전 검사 거부'·'바이패스 설정 불일치' 보류도 명령창으로 메인 에이전트에게 알리는 길을 적는다 (리드 결정 48)", () => {
  const REFUSAL = 'rm -rf "$OUT"/* — 안전 검사 거부';
  /** 그 작업에 묶인 메인 에이전트 업무 (상태와 상관없이) — 이 보류는 메인에게 알림 업무 하나로 간다 (리드 결정 S5-7) */
  const mainWork = (e: OrchEnv, taskId: string) => e.ctx.store.queue.list({ ref1: MAIN_AGENT_ID }).filter((q) => q.taskId === taskId).map((q) => [q.kind, q.alertKey]);
  /** 작업 턴이 그 끝(bypass_mismatch)으로 마무리될 때까지 */
  async function endedByBypass(e: OrchEnv, taskId: string, label: string) {
    await waitFor(
      () => {
        e.tick();
        return e.ctx.store.turns.list().some((x) => x.taskId === taskId && x.endReason === 'bypass_mismatch') && e.core.turns.count() === 0;
      },
      label,
      60_000,
    );
    await sleep(50);
  }
  const newTask = (e: OrchEnv, title: string) => {
    const d = seedDirective(e);
    return e.core.tasks.create({ directiveId: d.id, title, goal: title, type: 'development', assigneeId: e.devId, acceptanceCriteria: ['동작한다'], outputMode: 'repo', prerequisiteIds: [] }, e.producerId);
  };

  it("(BH) 작업 턴의 개별 명령 거부: 작업을 보류하고 메인 에이전트에게 넘긴다 — 'CLI 안전 검사 거부' 알림이 보류와 넘긴 사실을 적는다. 보류 사유는 'CLI 안전 검사가 명령을 거부함'", async () => {
    const e = (env = await bootOrch({ mock: false }));
    const t = newTask(e, '로그인 화면');
    e.script.set(taskKey(t.id), (p) => {
      p.emit({ kind: 'session', text: 'init', data: { permissionMode: 'bypassPermissions' } });
      p.emit({ kind: 'error', text: REFUSAL, data: { errorKind: 'permission' } });
    });
    await endedByBypass(e, t.id, '작업 턴이 CLI 안전 검사 거부로 끝남');
    const held = e.ctx.store.tasks.require(t.id);
    expect([held.state, held.hold.reasons.map((r) => [r.kind, r.note])]).toEqual(['on_hold', [['error', `CLI 안전 검사가 명령을 거부함: ${REFUSAL}`]]]);
    // 개별 명령 거부는 설정 문제가 아니다 — AI 종류를 막지 않는다 (windows:F8)
    expect(e.ctx.ai(e.ctx.store.members.require(e.devId).ai.kind).cliProblem).toBeNull();
    expect(notices(e, 'CLI 안전 검사 거부').map((n) => [n.key, n.level, n.body])).toEqual([
      [`bypass-denied:${taskKey(t.id)}`, 'urgent', `작업 ${t.id}: CLI 안전 검사가 명령을 거부해 턴을 끝냈습니다 — ${REFUSAL}. 작업을 보류하고 ${HANDED}`],
    ]);
    // 메인 업무는 알림 하나 — 대표 할 일은 그 보류가 메인에게 가 있다고 보인다 (리드 결정 S5-7)
    expect(mainWork(e, t.id)).toEqual([['alert', `alert:cli-refusal:${t.id}`]]);
    expect((await e.invoke('snapshot.get')).ownerTodos.flatMap((x) => (x.kind === 'error' && x.taskId === t.id ? [[x.message, x.reachesMain]] : []))).toEqual([
      [`${t.id} 로그인 화면: CLI 안전 검사가 명령을 거부함: ${REFUSAL}`, true],
    ]);
  });

  it('(BH-b) 작업 턴의 바이패스 설정 불일치: 작업을 보류하고 메인 에이전트에게 넘긴다 — 운영자가 설정을 고치고 다시 확인해도 작업은 보류로 남고, 알림 업무는 하나 그대로다', async () => {
    const e = (env = await bootOrch({ mock: false }));
    const t = newTask(e, '결제 화면');
    const kind = e.ctx.store.members.require(e.devId).ai.kind;
    e.script.set(taskKey(t.id), (p) => p.emit({ kind: 'session', text: 'init', data: { permissionMode: 'default' } }));
    await endedByBypass(e, t.id, '작업 턴이 바이패스 설정 불일치로 끝남');
    const why = "권한 모드가 'default'입니다 (bypassPermissions 아님)";
    expect(e.ctx.store.tasks.require(t.id).hold.reasons.map((r) => [r.kind, r.note])).toEqual([['error', `바이패스 설정 불일치: ${why}`]]);
    expect(e.ctx.ai(kind).cliProblem).toBe(`바이패스 설정 불일치: ${why}`);
    expect(notices(e, '바이패스 설정 불일치').map((n) => [n.key, n.level, n.body])).toEqual([
      [`ai-problem:${kind}:bypass_mismatch`, 'urgent', `작업 ${t.id}: ${why}. 작업을 보류하고 ${HANDED}`],
    ]);
    expect(mainWork(e, t.id)).toEqual([['alert', `alert:bypass:${t.id}`]]);
    // 운영자가 CLI 설정을 고치고 '다시 확인'하면 AI 종류는 풀리지만 작업은 보류 그대로다 — 메인 에이전트의 resume_task가 푼다
    e.script.delete(taskKey(t.id));
    await e.invoke('system.recheckAi', kind);
    await waitFor(() => !e.ctx.ai(kind).cliProblem, 'CLI 문제 풀림', 10_000);
    for (let i = 0; i < 3; i++) {
      e.tick();
      await sleep(30);
    }
    expect(e.ctx.store.tasks.require(t.id).state).toBe('on_hold');
    expect(mainWork(e, t.id)).toEqual([['alert', `alert:bypass:${t.id}`]]);
  });

  it('작업 세션 밖의 알림은 그대로다 — 보류한 작업이 없고, 설정 문제의 출구는 설치 설정이다 (지키는 시험)', async () => {
    const e = (env = await bootOrch({ mock: false }));
    const d = seedDirective(e);
    const key = directiveKey(d.id);
    e.script.set(key, (p) => {
      p.emit({ kind: 'session', text: 'init', data: { permissionMode: 'bypassPermissions' } });
      p.emit({ kind: 'error', text: REFUSAL, data: { errorKind: 'permission' } });
    });
    enqueue(e.ctx, { kind: 'message', memberId: e.producerId, sessionKey: key, projectId: e.projectId, directiveId: d.id, message: '정리해 줘' });
    await e.drain(1);
    expect(notices(e, 'CLI 안전 검사 거부').map((n) => n.body)).toEqual([`메시지 확인 ${d.id}: CLI 안전 검사가 명령을 거부해 턴을 끝냈습니다 — ${REFUSAL}`]);
    // 설정 문제: 설치 설정으로 가는 링크, 보류 문장 없음. 다시 넣은 앞 업무는 정상으로 끝난다
    e.script.delete(key);
    const d2 = seedDirective(e, '두 번째 지시');
    const key2 = directiveKey(d2.id);
    e.script.set(key2, (p) => p.emit({ kind: 'session', text: 'init', data: { permissionMode: 'default' } }));
    enqueue(e.ctx, { kind: 'message', memberId: e.producerId, sessionKey: key2, projectId: e.projectId, directiveId: d2.id, message: '정리해 줘' });
    await waitFor(
      () => {
        if (e.core.turns.count() === 0) e.tick();
        return notices(e, '바이패스 설정 불일치').length > 0 && e.core.turns.count() === 0;
      },
      '지시 세션의 바이패스 설정 불일치',
      30_000,
    );
    const kind = e.ctx.store.members.require(e.producerId).ai.kind;
    expect(notices(e, '바이패스 설정 불일치').map((n) => [n.key, n.body, n.link])).toEqual([
      [`ai-problem:${kind}:bypass_mismatch`, `메시지 확인 ${d2.id}: 권한 모드가 'default'입니다 (bypassPermissions 아님)`, { tab: 'settings', section: 'account' }],
    ]);
  });
});
