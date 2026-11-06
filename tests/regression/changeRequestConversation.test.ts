/**
 * 보고서 수정 요청이 대화 기록에 보인다 (리드 결정 S8-13, SERVER_DESIGN 10.8 '보고서 수정 요청이 명령으로 들어가고 대화 기록에 보이는지'):
 * - 받아들인 수정 요청은 대화(command.history가 읽는 곳)에 대표 글 하나를 남긴다 — 대상은 보고서의 프로젝트(없으면 'main'), 지시 ID, 첨부 없음,
 *   글은 `보고서 <ID> "<제목>" 수정 요청:` 다음 줄에 요청 내용(전체·부분 코멘트, 가린 글). 글 길이는 다른 대표 글처럼 자른다
 * - 남기지 않는 때: 이미 수정 요청한 보고서(아무것도 하지 않고 끝남), 거부(지시가 끝남·빈 요청)
 * - 같은 요청 ID로 다시 보내면(휴대폰이 답을 못 받아 다시 보냄) 한 번만 남는다 — HTTP 길, 같은 답
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { ConversationMessage, Report } from '@shared/domain';
import { MAIN_AGENT_ID } from '@shared/domain';
import type { OrchEnv } from './orchHarness';
import { bootOrch, seedDirective } from './orchHarness';
import { invokeHttp } from '../server/helpers';
import { ownerServer, type OwnerServer } from '../server/ownerServer';

let env: OrchEnv | null = null;
let server: OwnerServer | null = null;
afterEach(async () => {
  await env?.close();
  await server?.close();
  env = null;
  server = null;
});

const SECTIONS = { summary: '로그인 화면을 만들었습니다', results: '로그인 화면', changedFiles: ['login.txt'], howToVerify: '화면을 엽니다', issues: '', nextSteps: '' };
const OVERALL = '버튼 색을 파란색으로 바꿔 주세요';
const ANCHORED = [{ quote: '결과', comment: '변경 파일을 더 자세히' }];
const KEY = `sk-ant-api03-${'Q7v'.repeat(14)}xZ`;

const ownerMessages = (store: OrchEnv['ctx']['store'], target: string): ConversationMessage[] => store.conversation.list({ ref1: target }).filter((m) => m.role === 'owner');

/** 1회차 보고가 도착해 확인 대기인 지시의 보고서 */
async function awaitingReport(e: OrchEnv, title = '로그인 화면'): Promise<Report> {
  const seeded = seedDirective(e, title);
  e.ctx.store.directives.put({ ...seeded, state: 'reporting' });
  return e.core.reports.submit({ directiveId: seeded.id, sections: SECTIONS }, MAIN_AGENT_ID, null);
}

describe('보고서 수정 요청은 대화 기록에 대표 글로 남는다 (S8-13)', () => {
  it('지시의 보고서: 프로젝트 대화에 대표 글 하나(지시 ID·첨부 없음·보고서 ID와 제목·요청 내용) — command.history로 보이고, 메인 대기열의 수정 요청도 그대로다', async () => {
    const e = (env = await bootOrch());
    const r = await awaitingReport(e);
    const before = ownerMessages(e.ctx.store, e.projectId).length;
    await e.invoke('reports.requestChanges', r.id, { overall: OVERALL, anchored: ANCHORED });
    const added = ownerMessages(e.ctx.store, e.projectId).slice(before);
    expect(added.map(({ target, role, text, attachments, directiveId }) => ({ target, role, text, attachments, directiveId }))).toEqual([
      { target: e.projectId, role: 'owner', text: `보고서 ${r.id} "${r.title}" 수정 요청:\n${OVERALL}\n- "결과" → 변경 파일을 더 자세히`, attachments: [], directiveId: r.directiveId },
    ]);
    const history = await e.invoke('command.history', e.projectId, {});
    expect(history.filter((m) => m.id === added[0]!.id).map((m) => m.text)).toEqual([added[0]!.text]);
    expect(ownerMessages(e.ctx.store, 'main')).toEqual([]);
    expect(e.ctx.store.queue.list({ ref1: MAIN_AGENT_ID }).filter((q) => q.kind === 'change_request' && q.reportId === r.id)).toHaveLength(1);
  });

  it('지시 없는 보고서(직접 명령의 보고)는 메인 대화에 남는다 — 지시 ID 없음. 요청 글의 비밀 값은 가린 채로, 긴 글은 잘라서', async () => {
    const e = (env = await bootOrch());
    const r = await e.core.reports.submit({ directiveId: null, title: '직접 처리한 보고', sections: SECTIONS }, MAIN_AGENT_ID, null);
    expect([r.projectId, r.directiveId]).toEqual([null, null]);
    const long = `${KEY} 이 키는 빼 주세요. ${'가'.repeat(25_000)}`;
    await e.invoke('reports.requestChanges', r.id, { overall: long, anchored: [] });
    const [msg, ...rest] = ownerMessages(e.ctx.store, 'main');
    expect(rest).toEqual([]);
    expect([msg!.target, msg!.directiveId, msg!.attachments]).toEqual(['main', null, []]);
    expect(msg!.text.startsWith(`보고서 ${r.id} "직접 처리한 보고" 수정 요청:\n[가림:`)).toBe(true);
    expect([msg!.text.includes(KEY), msg!.text.includes('이 키는 빼 주세요'), msg!.text.length]).toEqual([false, true, 20_000]);
  });

  it('남기지 않는 때 — 이미 수정 요청한 보고서에 다시(아무것도 하지 않음), 지시가 끝난 보고서(conflict), 빈 요청(invalid)', async () => {
    const e = (env = await bootOrch());
    const r = await awaitingReport(e, '첫 보고');
    await e.invoke('reports.requestChanges', r.id, { overall: OVERALL, anchored: [] });
    const once = ownerMessages(e.ctx.store, e.projectId).length;
    await e.invoke('reports.requestChanges', r.id, { overall: '한 번 더', anchored: [] });
    expect(ownerMessages(e.ctx.store, e.projectId).length).toBe(once);

    const empty = await awaitingReport(e, '빈 요청');
    await expect(e.invoke('reports.requestChanges', empty.id, { overall: '   ', anchored: [] })).rejects.toMatchObject({ code: 'invalid' });
    const ended = await awaitingReport(e, '끝난 지시');
    await e.main('cancel_directive', { directive_id: ended.directiveId, reason: '대표 요청은 새 지시로 처리' });
    await expect(e.invoke('reports.requestChanges', ended.id, { overall: OVERALL, anchored: [] })).rejects.toMatchObject({ code: 'conflict' });
    expect(ownerMessages(e.ctx.store, e.projectId).length).toBe(once);
    expect(ownerMessages(e.ctx.store, e.projectId).filter((m) => m.text.startsWith(`보고서 ${empty.id} `) || m.text.startsWith(`보고서 ${ended.id} `))).toEqual([]);
  });

  it('같은 요청 ID로 다시 보내면(HTTP, 기기 세션) 한 번만 남고 같은 답이다 — 동시에 두 번 보내도', async () => {
    server = await ownerServer();
    const h = server.h;
    const submit = (title: string) => h.core.reports.submit({ directiveId: null, title, sections: SECTIONS }, MAIN_AGENT_ID, null);
    const send = (reportId: string, id: string) => invokeHttp(server!.server.url, server!.token, 'reports.requestChanges', [reportId, { overall: OVERALL, anchored: [] }], { id });
    const mine = (reportId: string) => ownerMessages(h.core.ctx.store, 'main').filter((m) => m.text.startsWith(`보고서 ${reportId} `));

    const r1 = await submit('다시 보낸 수정 요청');
    const first = await send(r1.id, 'phone-cr-1');
    const again = await send(r1.id, 'phone-cr-1');
    expect([first.status, again.status, again.text]).toEqual([200, 200, first.text]);
    expect(mine(r1.id)).toHaveLength(1);

    const r2 = await submit('동시에 보낸 수정 요청');
    const both = await Promise.all([send(r2.id, 'phone-cr-2'), send(r2.id, 'phone-cr-2')]);
    expect([both[0]!.status, both[1]!.status, both[1]!.text]).toEqual([200, 200, both[0]!.text]);
    expect(mine(r2.id)).toHaveLength(1);
  });
});
