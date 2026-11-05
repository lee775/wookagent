/**
 * 대표 요청을 버린 알림은 버림마다 따로다 (리드 결정 36, 10-30 — owner-surface 4차 재리뷰 N1·N1b, flows 프로브 zz-s1fx4fg-crash-notice-overwrite·
 * zz-s1fx4fg-startfail-notice-overwrite):
 * - ctx.notify는 같은 key의 읽지 않은 알림이 있으면 새 알림을 만들지 않고 그 본문을 덮어쓴다(notification 이벤트·OS 알림도 없다). '자동 복구 실패'·
 *   '업무 시작 실패'·'헛돌기' 알림의 key는 세션 하나(crash:<세션>·start-fail:<세션>·spin:<세션>)였다. 그래서 같은 세션에서 뒤에 버린 일이 앞에서 버린
 *   대표 명령·수정 요청의 이름을 지웠고, 두 번째 버림에는 바탕화면 알림도 뜨지 않았다. 그 알림이 대표에게 버린 요청을 알리는 유일한 곳이다(결정 30)
 * - 이제 대표 요청(명령·질문 답변·수정 요청)을 버린 알림의 key는 세션 key 뒤에 그 버림의 첫 대표 요청 항목 ID를 붙인다 — 버림마다 새 알림, notification
 *   이벤트, OS 알림. 대표 요청마다 활동 기록 한 줄도 남는다(알림을 읽은 뒤에도). 앞말(crash:·start-fail:·spin:)은 그대로다(화면이 앞말로 묶는다, 결정 41)
 * - 대표 요청이 없는 버림은 세션 key 그대로다(덮어써도 된다)
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID, type QueueEntry } from '@shared/domain';
import type { ShellServices } from '../../src/main/backend/types';
import { enqueue, mainKey } from '../../src/main/orchestrator/records';
import type { FakeProc, OrchEnv } from './orchHarness';
import { bootOrch, seedDirective, sleep, waitFor } from './orchHarness';

let env: OrchEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const SECTIONS = { summary: '로그인 화면을 만들었습니다', results: '로그인 화면', changedFiles: [], howToVerify: '-', issues: '-', nextSteps: '-' };

/** OS 알림(바탕화면)과 notification 이벤트를 모은다 */
function watchPushes(e: OrchEnv): { toasts: { title: string; body: string }[]; events: { title: string; body: string }[] } {
  const toasts: { title: string; body: string }[] = [];
  const events: { title: string; body: string }[] = [];
  const shell: ShellServices = {
    openExternal: async () => undefined,
    openPath: async () => undefined,
    pickFiles: async () => [],
    showOsNotification: (n) => toasts.push({ title: n.title, body: n.body }),
    focusWindow: () => undefined,
  };
  e.ctx.deps.shell = shell;
  e.ctx.bus.on('notification', (n) => events.push({ title: n.title, body: n.body }));
  return { toasts, events };
}

/** 메인 프로젝트 세션의 다음 턴(띄운 채)과 그 턴이 실은 항목 */
async function nextMainTurn(e: OrchEnv, label: string): Promise<{ p: FakeProc; carried: QueueEntry[] }> {
  const key = mainKey(e.projectId);
  await waitFor(
    () => {
      if (!e.liveProc(key, MAIN_AGENT_ID)) e.tick();
      return !!e.liveProc(key, MAIN_AGENT_ID);
    },
    label,
  );
  const p = e.liveProc(key, MAIN_AGENT_ID)!;
  return { p, carried: e.ctx.store.turns.get(p.turnId)!.queueEntryIds.map((id) => e.ctx.store.queue.get(id)!) };
}
async function ended(e: OrchEnv, p: FakeProc): Promise<void> {
  await waitFor(() => !e.core.turns.liveTurnIds().includes(p.turnId), '메인 턴 마무리');
  await sleep(30);
}
const unread = (e: OrchEnv, title: string) => e.ctx.store.notifications.list({ state: 'unread' }).filter((n) => n.title === title);
const lostRows = (e: OrchEnv) => e.ctx.store.activity.search({ text: '메인 에이전트에게 전하지 못한 대표 요청', limit: 50 }).reverse();
const cmdId = (carried: QueueEntry[], text: string) => carried.find((q) => q.kind === 'main_command' && q.message.includes(text))!.id;

describe('대표 요청을 버린 알림은 같은 세션의 다음 버림에 덮이지 않는다 (리드 결정 36)', () => {
  it('비정상 종료 상한: 명령 A와 B를 차례로 버리면 두 알림이 모두 읽지 않은 채 남고, 바탕화면 알림도 두 번 뜨며, 명령마다 활동 기록이 남는다 (N1)', async () => {
    const e = (env = await bootOrch());
    const key = mainKey(e.projectId);
    e.hold.add(key);
    const pushes = watchPushes(e);
    const project = e.ctx.store.projects.require(e.projectId);
    const A = '결제 모듈을 토스로 바꾸고 테스트 결제까지 확인해 줘';
    const B = '로그인 화면 문구를 존댓말로 고쳐 줘';
    await e.invoke('command.send', { target: e.projectId, text: A });
    const { p: t1, carried: c1 } = await nextMainTurn(e, 'A 첫 턴');
    const aFirst = cmdId(c1, A);
    t1.exit(1);
    await ended(e, t1);
    const { p: t2 } = await nextMainTurn(e, 'A 두 번째 턴');
    await e.invoke('command.send', { target: e.projectId, text: B });
    t2.exit(1);
    await ended(e, t2);
    const { p: t3, carried: c3 } = await nextMainTurn(e, 'A 세 번째 + B 첫 턴');
    const aId = cmdId(c3, A);
    t3.exit(1);
    await ended(e, t3);
    const { p: t4 } = await nextMainTurn(e, 'B 두 번째');
    t4.exit(1);
    await ended(e, t4);
    const { p: t5, carried: c5 } = await nextMainTurn(e, 'B 세 번째');
    const bId = cmdId(c5, B);
    t5.exit(1);
    await ended(e, t5);
    expect(e.ctx.store.queue.list({ ref2: key, state: ['queued', 'running'] })).toEqual([]);
    expect(aId).not.toBe(aFirst); // 다시 넣은 항목은 새 항목이다 — key는 버린 그 항목의 ID
    // 두 알림 모두 읽지 않은 채 남는다 — key는 세션 key 뒤에 버린 대표 명령의 항목 ID
    const n = unread(e, '자동 복구 실패');
    expect(n.map((x) => x.key)).toEqual([`crash:${key}:${aId}`, `crash:${key}:${bId}`]);
    expect(n.map((x) => x.body)).toEqual([
      `명령 처리 — 비정상 종료가 반복됩니다. 메인 에이전트에게 전하지 못한 대표 요청: ${project.name}(${project.id}) 명령 "${A}" — 필요하면 명령창으로 메인 에이전트에게 다시 말해 주세요`,
      `명령 처리 — 비정상 종료가 반복됩니다. 메인 에이전트에게 전하지 못한 대표 요청: ${project.name}(${project.id}) 명령 "${B}" — 필요하면 명령창으로 메인 에이전트에게 다시 말해 주세요`,
    ]);
    expect(n.every((x) => x.level === 'urgent')).toBe(true);
    // 버릴 때마다 새 알림 — notification 이벤트와 바탕화면 알림이 두 번
    expect(pushes.events.filter((x) => x.title === '자동 복구 실패').map((x) => x.body.includes(A) || x.body.includes(B))).toEqual([true, true]);
    expect(pushes.toasts.filter((x) => x.title === '자동 복구 실패').map((x) => (x.body.includes(A) ? 'A' : x.body.includes(B) ? 'B' : '?'))).toEqual(['A', 'B']);
    // 알림을 읽어도 남는 기록 — 대표 명령마다 한 줄 (프로젝트·종류·글 앞부분)
    expect(lostRows(e).map((a) => [a.kind, a.level, a.projectId, a.text])).toEqual([
      ['message', 'warn', e.projectId, `메인 에이전트에게 전하지 못한 대표 요청: ${project.name}(${project.id}) 명령 "${A}" — 비정상 종료가 반복됩니다 (${aId}, 다시 전달하지 않음)`],
      ['message', 'warn', e.projectId, `메인 에이전트에게 전하지 못한 대표 요청: ${project.name}(${project.id}) 명령 "${B}" — 비정상 종료가 반복됩니다 (${bId}, 다시 전달하지 않음)`],
    ]);
  });

  it('먼저 버린 수정 요청의 보고서 ID는 뒤에 버린 명령 알림에 덮이지 않는다 — 보고서는 수정 요청 그대로이고 대표는 그 사실을 안다 (N1b)', async () => {
    const e = (env = await bootOrch());
    const key = mainKey(e.projectId);
    e.hold.add(key);
    const project = e.ctx.store.projects.require(e.projectId);
    const d0 = seedDirective(e, '보고 지시');
    e.ctx.store.directives.put({ ...d0, state: 'reporting' });
    const report = await e.core.reports.submit({ directiveId: d0.id, sections: SECTIONS }, MAIN_AGENT_ID, null);
    await e.invoke('reports.requestChanges', report.id, { overall: '표로 바꿔 주세요', anchored: [] });
    const { p: t1 } = await nextMainTurn(e, '수정 요청 첫 턴');
    t1.exit(1);
    await ended(e, t1);
    const { p: t2 } = await nextMainTurn(e, '수정 요청 두 번째 턴');
    await e.invoke('command.send', { target: e.projectId, text: '배포 체크리스트 정리해 줘' });
    t2.exit(1);
    await ended(e, t2);
    const { p: t3 } = await nextMainTurn(e, '수정 요청 세 번째 + 명령 첫 턴');
    t3.exit(1);
    await ended(e, t3);
    for (let i = 0; i < 2; i++) {
      const { p } = await nextMainTurn(e, `명령 다시 전달 ${i + 1}`);
      p.exit(1);
      await ended(e, p);
    }
    expect(e.ctx.store.queue.list({ ref2: key, state: ['queued', 'running'] })).toEqual([]);
    expect(e.ctx.store.reports.require(report.id).status).toBe('changes_requested');
    const bodies = unread(e, '자동 복구 실패').map((n) => n.body);
    expect(bodies.filter((b) => b.includes(`${project.name}(${project.id}) 보고서 ${report.id} 수정 요청`))).toHaveLength(1);
    expect(bodies.filter((b) => b.includes('명령 "배포 체크리스트 정리해 줘"'))).toHaveLength(1);
    expect(lostRows(e).map((a) => [a.kind, a.directiveId, a.text.split(' — ')[0]])).toEqual([
      ['report', d0.id, `메인 에이전트에게 전하지 못한 대표 요청: ${project.name}(${project.id}) 보고서 ${report.id} 수정 요청`],
      ['message', null, `메인 에이전트에게 전하지 못한 대표 요청: ${project.name}(${project.id}) 명령 "배포 체크리스트 정리해 줘"`],
    ]);
  });

  it('업무 시작 실패 상한: 명령 A와 B를 차례로 버리면 두 알림이 모두 남는다 (flows startfail-notice-overwrite)', async () => {
    const e = (env = await bootOrch());
    const key = mainKey(e.projectId);
    const pushes = watchPushes(e);
    let fails = 0;
    e.prepareHook = (_launch, who) => {
      if (who.sessionKey === key) {
        fails += 1;
        throw new Error('모델 이름을 찾을 수 없습니다 (시험)');
      }
    };
    const failOnce = async (n: number) => {
      await waitFor(
        () => {
          if (fails >= n && e.core.turns.count() === 0) return true;
          if (fails < n && e.core.turns.count() === 0) e.tick();
          return false;
        },
        `시작 실패 ${n}`,
        20_000,
      );
      await sleep(80);
    };
    await e.invoke('command.send', { target: e.projectId, text: 'AAAA 로그인 화면에 비밀번호 찾기를 넣어 줘' });
    await failOnce(1);
    await failOnce(2);
    await e.invoke('command.send', { target: e.projectId, text: 'BBBB 결제 화면 문구를 바꿔 줘' });
    await failOnce(3);
    await failOnce(4);
    await failOnce(5);
    const cmds = e.ctx.store.queue.list().filter((q) => q.kind === 'main_command');
    expect(cmds.map((q) => [q.message.includes('AAAA') ? 'A' : 'B', q.state, q.startFails])).toEqual([
      ['A', 'cancelled', 3],
      ['B', 'cancelled', 3],
    ]);
    const n = unread(e, '업무 시작 실패');
    expect(n.map((x) => x.key)).toEqual([`start-fail:${key}:${cmds[0]!.id}`, `start-fail:${key}:${cmds[1]!.id}`]);
    expect(n.map((x) => [x.body.includes('명령 "AAAA'), x.body.includes('명령 "BBBB')])).toEqual([
      [true, false],
      [false, true],
    ]);
    expect(n[0]!.body.startsWith(`${key}: 모델 이름을 찾을 수 없습니다 (시험) — 3번 시작하지 못해 멈춘 업무: 명령 처리. 메인 에이전트에게 전하지 못한 대표 요청: `)).toBe(true);
    // 한 상한에 알림은 하나다 — 같은 상한의 세션 알림이 따로 생기지 않는다
    expect(pushes.events.filter((x) => x.title === '업무 시작 실패')).toHaveLength(2);
    expect(pushes.toasts.filter((x) => x.title === '업무 시작 실패')).toHaveLength(2);
    expect(lostRows(e).map((a) => a.text.includes('업무 시작이 3번 실패함 (모델 이름을 찾을 수 없습니다 (시험))'))).toEqual([true, true]);
  });

  it('헛돌기로 끝난 메인 턴이 버린 명령도 버림마다 따로 알리고 기록한다', async () => {
    const e = (env = await bootOrch());
    const key = mainKey(e.projectId);
    const pushes = watchPushes(e);
    e.script.set(key, (p) => {
      for (let i = 0; i < 5; i++) p.emit({ kind: 'error', text: '같은 오류', data: {} });
    });
    const spins = () => e.ctx.store.turns.list().filter((x) => x.memberId === MAIN_AGENT_ID && x.endReason === 'spin').length;
    await e.invoke('command.send', { target: e.projectId, text: '회의록 요약해 줘' });
    await waitFor(
      () => {
        e.tick();
        return spins() === 1 && e.core.turns.count() === 0;
      },
      '첫 헛돌기',
      20_000,
    );
    await e.invoke('command.send', { target: e.projectId, text: '스프린트 계획 세워 줘' });
    await waitFor(
      () => {
        e.tick();
        return spins() === 2 && e.core.turns.count() === 0;
      },
      '두 번째 헛돌기',
      20_000,
    );
    await sleep(50);
    const cmds = e.ctx.store.queue.list().filter((q) => q.kind === 'main_command');
    const n = unread(e, '헛돌기');
    expect(n.map((x) => x.key)).toEqual([`spin:${key}:${cmds[0]!.id}`, `spin:${key}:${cmds[1]!.id}`]);
    expect(n.map((x) => [x.body.includes('명령 "회의록 요약해 줘"'), x.body.includes('명령 "스프린트 계획 세워 줘"')])).toEqual([
      [true, false],
      [false, true],
    ]);
    expect(pushes.toasts.filter((x) => x.title === '헛돌기')).toHaveLength(2);
    expect(lostRows(e).map((a) => a.text.endsWith(`— 메인 에이전트의 턴이 같은 오류를 되풀이하는 헛돌기로 끝남 (${a.text.match(/W-\d+/)![0]}, 다시 전달하지 않음)`))).toEqual([true, true]);
  });

  it('대표 요청이 없는 버림은 세션 key 그대로다 — 다음 버림이 그 알림을 고친다', async () => {
    const e = (env = await bootOrch());
    const key = mainKey(e.projectId);
    let fails = 0;
    e.prepareHook = (_launch, who) => {
      if (who.sessionKey === key) {
        fails += 1;
        throw new Error('작업 폴더를 열 수 없습니다 (시험)');
      }
    };
    // 대표 요청이 아닌 메인 업무(보고서 작성 요청)
    const d = seedDirective(e, '보고 지시');
    e.ctx.store.directives.put({ ...d, state: 'reporting' });
    enqueue(e.ctx, { kind: 'main_report', memberId: MAIN_AGENT_ID, sessionKey: key, projectId: e.projectId, directiveId: d.id, priority: 'high', message: `지시 ${d.id}의 보고서를 작성하세요` });
    await waitFor(
      () => {
        if (e.core.turns.count() === 0) e.tick();
        return fails >= 3 && e.core.turns.count() === 0;
      },
      '시작 실패 상한',
      20_000,
    );
    await sleep(50);
    expect(unread(e, '업무 시작 실패').map((n) => n.key)).toEqual([`start-fail:${key}`]);
    expect(lostRows(e)).toEqual([]);
  });
});
