/**
 * 다시 넣기 앞말의 까닭은 한 줄이다 (리드 결정 40, 10-30 — flows 4차 재리뷰 관찰 3):
 * - 끊긴 턴의 업무를 다시 넣을 때 '<까닭>\n\n(다시 전달) <원래 글>'로 넣고, 남는 업무 글(standingBody)과 버린 대표 요청의 이름(ownerRequests)은 그 앞말을
 *   한 줄로 보고 떼어 냈다(REQUEUE_PREFIX). 그런데 CLI 안전 검사 거부의 까닭에는 CLI가 낸 거부 글이 그대로 들어가 여러 줄일 수 있다. 그러면 앞말을
 *   떼지 못해 남는 업무 글에 '(다시 전달)'이 쌓이고, 상한에서 버린 대표 명령의 이름이 명령 글이 아니라 거부 글이 됐다
 * - 이제 다시 넣을 때 까닭의 줄바꿈을 한 칸으로 접는다 — 앞말은 늘 한 줄이라 늘 떼어진다
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID, type QueueEntry } from '@shared/domain';
import { enqueue, mainKey } from '../../src/main/orchestrator/records';
import type { FakeProc, OrchEnv } from './orchHarness';
import { bootOrch, seedDirective, seedInReviewTask, sleep, waitFor } from './orchHarness';

let env: OrchEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

/** CLI 내장 안전 검사가 여러 줄 글로 명령을 거부한다 (바이패스는 확인됨 — 그 명령만의 거부, 작업 세션 밖은 비정상 종료형 끝) */
const REFUSAL = 'rm -rf "$OUT"/*\n안전 검사가 이 명령을 거부했습니다\n  (빈 변수가 루트를 가리킬 수 있음)';
function refuse(p: FakeProc): void {
  p.emit({ kind: 'session', text: 'init', data: { permissionMode: 'bypassPermissions' } });
  p.emit({ kind: 'error', text: REFUSAL, data: { errorKind: 'permission' } });
}
const liveMain = (e: OrchEnv): QueueEntry[] => e.ctx.store.queue.list({ ref2: mainKey(e.projectId), state: ['queued', 'running'] });

describe('다시 넣기 앞말의 까닭은 늘 한 줄이다 (리드 결정 40)', () => {
  it('여러 줄 거부 글로 끊긴 대표 명령: 앞말은 한 줄이고, 상한에서 버리면 알림이 명령 글로 그 명령을 적는다', async () => {
    const e = (env = await bootOrch({ mock: false }));
    const key = mainKey(e.projectId);
    e.script.set(key, refuse);
    const project = e.ctx.store.projects.require(e.projectId);
    await e.invoke('command.send', { target: e.projectId, text: '결제 화면 문구를 고쳐 줘' });
    // 첫 거부 뒤 다시 들어간 명령
    await waitFor(
      () => {
        if (liveMain(e).some((q) => q.state === 'queued' && q.attempts === 1)) return true;
        e.tick();
        return false;
      },
      '첫 거부 뒤 다시 넣음',
      20_000,
    );
    const [again] = liveMain(e);
    const lead = again!.message.split('\n\n(다시 전달) ')[0]!;
    expect(lead).toBe('CLI 안전 검사가 명령을 거부해 이전 턴이 끝났습니다: rm -rf "$OUT"/* 안전 검사가 이 명령을 거부했습니다 (빈 변수가 루트를 가리킬 수 있음). 같은 명령을 되풀이하지 말고 리터럴 경로나 ${VAR:?} 가드를 쓰세요.');
    expect(again!.message.startsWith(`${lead}\n\n(다시 전달) 대표 명령`)).toBe(true);
    // 상한(자동 재시도 2회)까지 — 버린 명령의 이름은 명령 글이다(거부 글이 아니다)
    await waitFor(
      () => {
        e.tick();
        return e.ctx.store.notifications.list().some((n) => n.title === '자동 복구 실패');
      },
      'CLI 안전 검사 거부 상한',
      40_000,
    );
    await sleep(50);
    expect(liveMain(e)).toEqual([]);
    const body = e.ctx.store.notifications.list().find((n) => n.title === '자동 복구 실패')!.body;
    expect(body).toContain(`메인 에이전트에게 전하지 못한 대표 요청: ${project.name}(${project.id}) 명령 "결제 화면 문구를 고쳐 줘" — 필요하면 명령창으로 메인 에이전트에게 다시 말해 주세요`);
    expect(body.split('대표 요청:')[1]).not.toContain('안전 검사');
    expect(e.ctx.store.activity.search({ text: '메인 에이전트에게 전하지 못한 대표 요청', limit: 10 }).map((a) => a.text.split(' — ')[0])).toEqual([
      `메인 에이전트에게 전하지 못한 대표 요청: ${project.name}(${project.id}) 명령 "결제 화면 문구를 고쳐 줘"`,
    ]);
  });

  it('여러 줄 거부 글로 끊긴 멈춘 검수 넘김: 다음 턴이 정상으로 끝나 다시 넣을 때 원래 안내만 저장한다 — (다시 전달)이 쌓이지 않는다', async () => {
    const e = (env = await bootOrch({ mock: false }));
    const key = mainKey(e.projectId);
    let n = 0;
    e.script.set(key, (p) => {
      n += 1;
      if (n === 1) refuse(p);
      else p.finishOk('확인했습니다');
    });
    await e.internal('members.remove', e.qaId);
    const d = seedDirective(e);
    const t = seedInReviewTask(e, MAIN_AGENT_ID, { outputMode: 'repo', directiveId: d.id });
    const original = [`${t.id} "${t.title}" 검수가 멈췄습니다 — 검수 턴이 판정 없이 반복해서 끝납니다. 할 수 있는 일:`, '- 프로듀서에게 다른 검수자를 정하라고 지시하세요.', '- 필요 없으면 cancel_task로 취소하세요.'].join('\n');
    enqueue(e.ctx, { kind: 'message', memberId: MAIN_AGENT_ID, sessionKey: key, projectId: e.projectId, directiveId: d.id, taskId: t.id, priority: 'high', message: original });
    await waitFor(
      () => {
        // 두 번째 턴이 뜬 뒤에는 돌리지 않는다 — 다시 넣은 넘김이 세 번째 턴에 실리기 전에 본다
        if (n < 2) e.tick();
        return n >= 2 && e.core.turns.count() === 0;
      },
      '거부된 턴과 그다음 정상 턴',
      20_000,
    );
    await sleep(50);
    // 두 번째 턴(비정상 종료형 끝으로 다시 넣은 넘김)은 한 줄 앞말 + 원래 안내를 받는다
    const second = e.launches.filter((l) => l.workKey === key)[1]!.message;
    expect(second).toContain(
      `> CLI 안전 검사가 명령을 거부해 이전 턴이 끝났습니다: rm -rf "$OUT"/* 안전 검사가 이 명령을 거부했습니다 (빈 변수가 루트를 가리킬 수 있음). 같은 명령을 되풀이하지 말고 리터럴 경로나 \${VAR:?} 가드를 쓰세요.\n> \n> (다시 전달) ${original.split('\n').join('\n> ')}`,
    );
    // 정상으로 끝난 턴 뒤 다시 넣은 넘김은 원래 안내 그대로다
    const handOff = liveMain(e).filter((q) => q.taskId === t.id);
    expect(handOff.map((q) => [q.deliveries ?? 0, q.attempts, q.message])).toEqual([[1, 0, original]]);
  });
});
