/**
 * 메인 도구는 삭제된 팀원을 겨누지 않는다 (리드 결정 S5-74 — S5-62 2 '삭제된 팀원은 일시정지하지 않는다'를 도구까지).
 * - pause_member·resume_member·update_member·set_member_ai·remove_member·interrupt_member·instruct_member(보통·긴급)·send_message·assign_reviewer는 삭제된
 *   팀원을 conflict로 거부하고 '삭제된 팀원 <이름>(<ID>)입니다'라고 쓴다. 교체된 프로듀서면 '— 지금 프로듀서는 <이름>(<ID>)입니다'를 더한다
 * - 거부하면 아무것도 바뀌지 않는다 — 정지 기록·대표 알림·사유 기록·대기 업무·팀원 기록 그대로
 * - 조회(get_member_activity)는 삭제된 팀원도 본다 (리드 결정 S5-6)
 * 프로브 server-s5fix6-alerts-flows/zz-s5af7-deleted(D1)에서. 가짜 프로세스만, 실제 키 없음
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Member } from '@shared/domain';
import { MAIN_AGENT_ID } from '@shared/domain';
import type { OrchEnv } from './orchHarness';
import { bootOrch, seedDirective } from './orchHarness';

let env: OrchEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

type Out = { ok: boolean; code: string | null; message: string };
/** 운영자 신원으로 메인 도구를 부른다 — 받으면 ok, 거부면 그 코드와 글 */
const tryMain = (e: OrchEnv, tool: string, args: Record<string, unknown>): Promise<Out> =>
  e.main(tool, args).then(
    () => ({ ok: true, code: null, message: '' }),
    (x: Error & { code?: string }) => ({ ok: false, code: x.code ?? 'error', message: x.message }),
  );

/** 거부한 뒤 바뀐 것이 없는지 볼 상태 — 정지 기록, 대표 알림, 활동 기록 수, 대기·실행 중 업무, 그 팀원 기록 */
function snapshot(e: OrchEnv, memberId: string) {
  return {
    stop: JSON.stringify(e.ctx.stop().members),
    notices: e.ctx.store.notifications.list().length,
    // 가장 최근 활동 기록 번호 — 새 줄(사유 기록·일시정지 등)이 하나도 없어야 한다
    activity: e.ctx.store.activity.search({ limit: 1 })[0]?.seq ?? 0,
    queue: e.ctx.store.queue
      .list({ state: ['queued', 'running'] })
      .map((q) => q.id)
      .join(','),
    member: JSON.stringify(e.ctx.store.members.require(memberId)),
    messages: e.ctx.store.messages.list().length,
  };
}

/** 삭제된 팀원을 겨누는 메인 도구 호출 — 도구 이름과 인자 */
function calls(memberId: string, taskId: string): [string, Record<string, unknown>][] {
  return [
    ['pause_member', { member_id: memberId, mode: 'graceful', reason: '멈춤 (시험)' }],
    ['pause_member', { member_id: memberId, mode: 'immediate', reason: '멈춤 (시험)' }],
    ['resume_member', { member_id: memberId, reason: '재개 (시험)' }],
    ['update_member', { member_id: memberId, name: '새 이름', reason: '이름 바꿈 (시험)' }],
    ['set_member_ai', { member_id: memberId, ai_kind: 'codex', reason: 'AI 바꿈 (시험)' }],
    ['remove_member', { member_id: memberId }],
    ['interrupt_member', { member_id: memberId, then: 'hold', reason: '중단 (시험)' }],
    ['instruct_member', { member_id: memberId, text: '이것부터 해 주세요 (시험)' }],
    ['instruct_member', { member_id: memberId, text: '이것부터 해 주세요 (시험)', urgent: true }],
    ['instruct_member', { member_id: memberId, text: '이것부터 해 주세요 (시험)', urgent: 'interrupt' }],
    ['send_message', { to: memberId, text: '확인 부탁합니다 (시험)' }],
    ['assign_reviewer', { task_id: taskId, reviewer_id: memberId, reason: '검수자 바꿈 (시험)' }],
  ];
}

describe('메인 도구는 삭제된 팀원을 거부한다 — 사실대로 쓰고 아무것도 바꾸지 않는다 (리드 결정 S5-74)', () => {
  it('지운 팀원(remove_member) — "삭제된 팀원 <이름>(<ID>)입니다"', async () => {
    const e = (env = await bootOrch());
    const d = seedDirective(e);
    const t = e.core.tasks.create({ directiveId: d.id, title: '로그인 화면', goal: '로그인 화면', type: 'development', assigneeId: e.devId, acceptanceCriteria: ['동작한다'], outputMode: 'repo' }, e.producerId);
    const qa: Member = e.ctx.store.members.require(e.qaId);
    await e.main('remove_member', { member_id: e.qaId });
    expect(e.ctx.store.members.require(e.qaId).deletedAt).toBeTruthy();
    for (const [tool, args] of calls(e.qaId, t.id)) {
      const before = snapshot(e, e.qaId);
      const r = await tryMain(e, tool, args);
      expect({ tool, ...r }).toEqual({ tool, ok: false, code: 'conflict', message: `삭제된 팀원 ${qa.name}(${qa.id})입니다` });
      expect({ tool, ...snapshot(e, e.qaId) }).toEqual({ tool, ...before });
    }
  });

  it('교체된 프로듀서 — 지금 프로듀서도 적는다. pause_member는 정지 기록도 대표 알림도 남기지 않는다 (프로브 D1)', async () => {
    const e = (env = await bootOrch());
    const d = seedDirective(e);
    const t = e.core.tasks.create({ directiveId: d.id, title: '로그인 화면', goal: '로그인 화면', type: 'development', assigneeId: e.devId, acceptanceCriteria: ['동작한다'], outputMode: 'repo' }, e.producerId);
    const old: Member = e.ctx.store.members.require(e.producerId);
    const v = await e.main('replace_producer', { project_id: e.projectId, reason: '교체 (시험)' });
    const fresh = e.ctx.store.members.require(v.producerId as string);
    expect(e.ctx.store.members.require(old.id).deletedAt).toBeTruthy();
    for (const [tool, args] of calls(old.id, t.id)) {
      const before = snapshot(e, old.id);
      const r = await tryMain(e, tool, args);
      expect({ tool, ...r }).toEqual({ tool, ok: false, code: 'conflict', message: `삭제된 팀원 ${old.name}(${old.id})입니다 — 지금 프로듀서는 ${fresh.name}(${fresh.id})입니다` });
      expect({ tool, ...snapshot(e, old.id) }).toEqual({ tool, ...before });
    }
    // 프로브 D1 — 지운 프로듀서의 정지 기록이 없고, 현황의 일시정지 목록에도 없다
    expect(e.ctx.stop().members[old.id]).toBeUndefined();
    expect(e.core.overview.build({ detail: true }).stop.pausedMembers).toEqual([]);
    expect(e.ctx.store.notifications.list().filter((n) => n.title === '메인 에이전트 조작' && n.body.includes(old.id))).toEqual([]);
  });

  it('살아 있는 팀원은 그대로 받는다 — 조회(get_member_activity)는 삭제된 팀원도 본다 (리드 결정 S5-6)', async () => {
    const e = (env = await bootOrch());
    await e.main('remove_member', { member_id: e.qaId });
    expect(await e.main('get_member_activity', { member_id: e.qaId })).toMatchObject({ member: { memberId: e.qaId } });
    expect(await tryMain(e, 'pause_member', { member_id: e.devId, mode: 'graceful', reason: '멈춤 (시험)' })).toEqual({ ok: true, code: null, message: '' });
    expect(e.ctx.stop().members[e.devId]).toMatchObject({ paused: true, by: MAIN_AGENT_ID });
    expect(await tryMain(e, 'resume_member', { member_id: e.devId, reason: '재개 (시험)' })).toEqual({ ok: true, code: null, message: '' });
    expect(await tryMain(e, 'update_member', { member_id: e.devId, name: '민수', reason: '이름 바꿈 (시험)' })).toEqual({ ok: true, code: null, message: '' });
  });
});
