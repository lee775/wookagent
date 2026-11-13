/**
 * 메인 에이전트가 말로 한 답은 대표에게 알림으로도 간다 (대표 요청 2026-11-13 — turns.ts notifyMainReply).
 * 그 답은 명령창의 대화 기록에만 남아, 대표가 명령창을 펼쳐 보지 않으면 답이 온 줄 몰랐다.
 * - 답마다 알림 하나: 제목 '메인 에이전트의 답'(프로젝트 대화면 프로젝트 이름까지), 본문은 답의 글(줄바꿈을 빈칸으로, 300자를 넘으면 줄임), 보통 알림이라
 *   화면의 알림과 바탕화면 알림이 함께 뜬다. 링크는 그 프로젝트(직접 명령이면 프로젝트 홈)
 * - 읽지 않은 앞 답의 알림을 덮지 않는다 — key에 턴 ID가 있어 두 번째 답도 새 알림으로 뜬다
 * - 답이 없으면(끝 글이 빔) 알림도 없다
 * 가짜 CLI(orchHarness)만 쓴다
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID } from '@shared/domain';
import { mainKey } from '../../src/main/orchestrator/records';
import { MAIN_REPLY_NOTICE_CHARS } from '../../src/main/orchestrator/turns';
import { bootOrch, waitFor, type OrchEnv } from './orchHarness';

let env: OrchEnv | null = null;
afterEach(async () => {
  env?.hold.clear();
  await env?.close();
  env = null;
});

const replyNotices = (e: OrchEnv) =>
  e.ctx.store.notifications
    .list({})
    .filter((n) => n.key?.startsWith('main-reply:'))
    .sort((a, b) => (a.id < b.id ? -1 : 1));

/** 대표가 명령을 보내고, 메인 턴이 뜨면 그 답으로 마친다 — 그 턴의 ID를 돌려준다 */
async function ask(e: OrchEnv, target: string, text: string, answer: string): Promise<string> {
  const key = target === 'main' ? 'main:general' : mainKey(target);
  e.hold.add(key);
  await e.invoke('command.send', { target, text });
  await waitFor(
    () => {
      if (!e.liveProc(key, MAIN_AGENT_ID)) e.tick();
      return !!e.liveProc(key, MAIN_AGENT_ID);
    },
    `메인 턴 (${key})`,
  );
  const turnId = e.launches.filter((l) => l.workKey === key).at(-1)!.turnId;
  e.liveProc(key, MAIN_AGENT_ID)!.finishOk(answer);
  await e.idle();
  return turnId;
}

describe('메인 에이전트의 답은 알림으로도 간다', () => {
  it('직접 명령의 답: 알림 하나 — 제목·본문·링크·key(턴 ID), 바탕화면 알림도 보통 수준으로', async () => {
    const e = (env = await bootOrch());
    const turnId = await ask(e, 'main', '오늘 할 일을 알려 줘', '오늘은 로그인 화면을\n마무리합니다.');
    expect(e.ctx.store.conversation.list({ ref1: 'main' }).filter((m) => m.role === 'main_agent').map((m) => m.text)).toEqual(['오늘은 로그인 화면을\n마무리합니다.']);
    expect(replyNotices(e).map((n) => ({ level: n.level, title: n.title, body: n.body, link: n.link, key: n.key, read: n.readAt }))).toEqual([
      { level: 'normal', title: '메인 에이전트의 답', body: '오늘은 로그인 화면을 마무리합니다.', link: { tab: 'projects' }, key: `main-reply:${turnId}`, read: null },
    ]);
  });

  it('프로젝트 대화의 답: 제목에 프로젝트 이름, 링크는 그 프로젝트 — 읽지 않은 앞 답을 덮지 않고 답마다 새 알림', async () => {
    const e = (env = await bootOrch());
    const name = e.ctx.store.projects.require(e.projectId).name;
    const first = await ask(e, e.projectId, '진행 상황은?', '첫 번째 답');
    const second = await ask(e, e.projectId, '그다음은?', '두 번째 답');
    expect(first).not.toBe(second);
    expect(replyNotices(e).map((n) => [n.title, n.body, n.link, n.key])).toEqual([
      [`메인 에이전트의 답 — ${name}`, '첫 번째 답', { tab: 'projects', projectId: e.projectId }, `main-reply:${first}`],
      [`메인 에이전트의 답 — ${name}`, '두 번째 답', { tab: 'projects', projectId: e.projectId }, `main-reply:${second}`],
    ]);
  });

  it(`긴 답은 ${MAIN_REPLY_NOTICE_CHARS}자에서 줄이고 '…'을 붙인다 — 대화 기록에는 전문이 남는다`, async () => {
    const e = (env = await bootOrch());
    const long = '가'.repeat(MAIN_REPLY_NOTICE_CHARS + 50);
    await ask(e, 'main', '길게 답해 줘', long);
    expect(replyNotices(e).map((n) => n.body)).toEqual([`${'가'.repeat(MAIN_REPLY_NOTICE_CHARS)}…`]);
    expect(e.ctx.store.conversation.list({ ref1: 'main' }).filter((m) => m.role === 'main_agent').map((m) => m.text)).toEqual([long]);
  });

  it('답이 없이 끝난 턴(끝 글이 빔)은 알림도 대화 기록도 남기지 않는다', async () => {
    const e = (env = await bootOrch());
    await ask(e, 'main', '조용히 처리해 줘', '');
    expect(replyNotices(e)).toEqual([]);
    expect(e.ctx.store.conversation.list({ ref1: 'main' }).filter((m) => m.role === 'main_agent')).toEqual([]);
  });
});
