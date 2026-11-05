/**
 * 메인 일지의 서버 기록 (SERVER_DESIGN 6.1 '서버가 자동으로 쓰는 것', 리드 결정 S4-6, S4b):
 * - 받은 명령(command), 메인이 상태를 바꾼 도구 호출(action — 팀과 지시·질문·역할과 설정·정지와 취소·메인 검수 판정·자리 넘기기), 보고 도착·결과 승인·
 *   수정 요청(report), 자리 교체(seat), 긴급 정지와 해제(stop)가 서버 기록으로 남는다. 쓴 쪽은 server이고, 그 턴의 세대와 업무 세션이 붙는다
 * - 같은 request_id로 다시 보낸 도구는 한 줄만, 조회 도구·거부된 호출·팀원(프로듀서)의 도구는 남지 않는다
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID, type AiConfig } from '@shared/domain';
import { bootOrch, startReview, waitFor, type OrchEnv } from './orchHarness';

let env: OrchEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const CODEX: AiConfig = { kind: 'codex', model: null, effortTier: 'high', effortOverride: null };
const rows = (e: OrchEnv) => e.ctx.store.journal.query({ author: 'server', asc: true });
const texts = (e: OrchEnv, kind: string) => rows(e).filter((r) => r.kind === kind).map((r) => r.text);

describe('메인 일지의 서버 기록 (journalSources)', () => {
  it('받은 명령·메인의 도구 호출·보고 도착과 승인·수정 요청·자리 교체·긴급 정지와 해제가 남는다', async () => {
    const e = (env = await bootOrch());
    const P = e.projectId;
    // 처음 보유자가 앉은 것
    expect(texts(e, 'seat')).toEqual([expect.stringMatching(/^메인 자리에 Claude CLI가 앉음 \(세대 1, 서버\) — /)]);
    // 받은 명령
    await e.invoke('command.send', { target: P, text: '로그인 화면을 만들어 줘' });
    await e.invoke('command.send', { target: 'main', text: '오늘 할 일 정리' });
    expect(texts(e, 'command')).toEqual(['대표 명령 (P-0001 턴 회귀): 로그인 화면을 만들어 줘', '대표 명령 (직접 명령): 오늘 할 일 정리']);
    expect(rows(e).find((r) => r.kind === 'command')).toMatchObject({ projectId: P, workKey: `main:${P}`, refs: [{ kind: 'project', id: P }], generation: 1, holder: 'Claude CLI' });

    // 메인의 도구 호출 — 운영 조작이 아닌 것과 운영 조작(mainOp) 모두
    const d = await e.main('register_directive', { project_id: P, title: '로그인', text: '구글 로그인 화면', request_id: 'rq-dir' });
    await e.main('register_directive', { project_id: P, title: '로그인', text: '구글 로그인 화면', request_id: 'rq-dir' }); // 같은 요청 — 한 줄만
    const m = await e.main('add_member', { project_id: P, role_id: 'ui_designer', reason: '디자인이 필요' });
    await e.main('set_member_ai', { member_id: m.memberId, ai_kind: 'codex', effort_tier: 'low', reason: '단순 작업' });
    const q = await e.main('ask_owner', { question: '색은 무엇으로 할까요?' });
    await e.main('pause_member', { member_id: e.qaId, mode: 'graceful', reason: '대표가 잠시 멈추라고 함' });
    await e.main('resume_member', { member_id: e.qaId, reason: '다시 진행' });
    await e.main('create_role', { name: '사운드', instructions: '효과음을 만든다', can_review: false, task_types: ['design'], reason: '사운드 작업' });
    await e.main('update_settings', { patch: { execution: { maxConcurrent: 4 } }, reason: '대표 명령' });
    await e.main('remove_member', { member_id: String(m.memberId) });
    await e.main('cancel_directive', { directive_id: d.directiveId, reason: '대표가 취소' });
    // 남지 않는 것: 조회, 거부된 호출, 운영 조작이 아닌 설정 외 도구(백업 등)
    await e.main('list_projects');
    await expect(e.main('pause_member', { member_id: MAIN_AGENT_ID, reason: 'x' })).rejects.toMatchObject({ code: 'forbidden' });
    await e.main('backup_now', { reason: '시험' });
    const actions = texts(e, 'action');
    expect(actions).toEqual([
      `지시 ${String(d.directiveId)} 등록 (${P}): "로그인" — 구글 로그인 화면`,
      expect.stringMatching(new RegExp(`^팀원 추가 .+\\(${String(m.memberId)}\\) — 역할 ui_designer, (claude|codex) .+, 노력치 .+ — 사유: 디자인이 필요$`)),
      expect.stringMatching(new RegExp(`^.+\\(${String(m.memberId)}\\)의 AI → codex .+, 노력치 low — 사유: 단순 작업$`)),
      `대표에게 질문 ${String(q.questionId)}: 색은 무엇으로 할까요?`,
      expect.stringMatching(/^팀원 M-\d+ .+ 일시정지 \(단계 마치고\) \(pause_member\) — 사유: 대표가 잠시 멈추라고 함$/),
      expect.stringMatching(/^팀원 M-\d+ .+ 재개 \(resume_member\) — 사유: 다시 진행$/),
      '역할 추가 사운드 (create_role) — 사유: 사운드 작업',
      '운영 설정 변경 (execution.maxConcurrent) (update_settings) — 사유: 대표 명령',
      expect.stringMatching(new RegExp(`^팀원 삭제 .+\\(${String(m.memberId)}\\)$`)),
      `지시 ${String(d.directiveId)} 취소 (cancel_directive) — 사유: 대표가 취소`,
    ]);
    const dirRow = rows(e).find((r) => r.kind === 'action')!;
    expect(dirRow).toMatchObject({ projectId: P, workKey: 'main:general', turnId: 'TN-main-ops', refs: [{ kind: 'directive', id: d.directiveId }, { kind: 'project', id: P }] });

    // 메인 검수 판정 — 쌓인 메인 일(명령)을 먼저 비운다 (메인 턴은 한 번에 하나)
    await e.drain(3);
    const { task, turnId } = await startReview(e, MAIN_AGENT_ID);
    expect((await e.tool(turnId, 'get_review_target', { task_id: task.id })).ok).toBe(true);
    const verdict = await e.tool(turnId, 'submit_review', { task_id: task.id, verdict: 'pass', criteria: [{ criterion: '문서가 있다', pass: true, note: '확인' }], reason: '완료 조건을 확인함' });
    expect(verdict.ok).toBe(true);
    expect(texts(e, 'action').at(-1)).toBe(`메인 검수 판정 ${task.id} "검수 대상 작업": 통과 — 완료 조건을 확인함`);

    // 보고 도착·결과 승인·수정 요청
    const r1 = await e.main('submit_report', { title: '첫 보고', summary: '요약입니다', results: '결과', changed_files: [], how_to_verify: '-', issues: '', next_steps: '' });
    const r2 = await e.main('submit_report', { title: '둘째 보고', summary: '요약 둘', results: '결과', changed_files: [], how_to_verify: '-', issues: '', next_steps: '' });
    await e.invoke('reports.approve', String(r1.reportId), '좋습니다');
    await e.invoke('reports.requestChanges', String(r2.reportId), { overall: '숫자를 고쳐 주세요', anchored: [{ quote: '요약 둘', comment: '더 짧게' }] });
    expect(texts(e, 'report')).toEqual([
      `보고서 ${String(r1.reportId)} 도착 (일반): "첫 보고" — 요약입니다`,
      `보고서 ${String(r2.reportId)} 도착 (일반): "둘째 보고" — 요약 둘`,
      `대표가 보고서 ${String(r1.reportId)} "첫 보고"을(를) 결과 승인함 — 코멘트: 좋습니다`,
      `대표가 보고서 ${String(r2.reportId)} "둘째 보고"에 수정 요청을 함: 숫자를 고쳐 주세요 - "요약 둘" → 더 짧게`,
    ]);

    // 긴급 정지와 해제
    await e.invoke('stop.emergency');
    await e.invoke('stop.release');
    expect(texts(e, 'stop')).toEqual([expect.stringMatching(/^대표가 긴급 정지 — 턴 \d+개를 끝내고 작업 \d+개를 보류함/), expect.stringMatching(/^대표가 긴급 정지를 해제함 — 보류된 작업 \d+건은 메인 에이전트가 확인해 항목별로 재개/)]);

    // 자리 교체 — 시작과 끝 (그 세대로)
    await e.core.seat.assign({ holder: { kind: 'launched', ai: CODEX }, by: 'operator', reason: '운영자 교체', force: true }).done;
    const seat = rows(e).filter((r) => r.kind === 'seat');
    expect(seat.map((r) => r.generation)).toEqual([1, 2, 2]);
    expect(seat[1]!.text).toBe('메인 자리 교체 시작: Claude CLI → Codex CLI (세대 1 → 2, 운영자가 바꿈, 강제) — 운영자 교체');
    expect(seat.at(-1)!.text).toBe('메인 자리 교체 끝: Claude CLI → Codex CLI (세대 2, 운영자가 바꿈) — 메인 토큰 0개 폐기, 메인 세션을 닫고 인계 꾸러미를 만듦 — 까닭: 운영자 교체');
    expect(seat.at(-1)!.holder).toBe('Codex CLI');
    // 모두 서버 기록이다 — 에이전트 기록은 없다
    expect(e.ctx.store.journal.count({ author: 'agent' })).toBe(0);
    expect(e.errors).toEqual([]);
  });

  it('메인 턴의 도구 호출에는 그 턴의 세대와 업무 세션이 붙고, 프로듀서의 도구는 남지 않는다', async () => {
    const e = (env = await bootOrch());
    const key = `main:${e.projectId}`;
    e.hold.add(key);
    await e.invoke('command.send', { target: e.projectId, text: '명령' });
    e.tick();
    await waitFor(() => !!e.liveProc(key, MAIN_AGENT_ID), '메인 턴');
    const t = e.liveProc(key, MAIN_AGENT_ID)!.turnId;
    const r = await e.tool(t, 'hand_off_seat', { to: 'codex', reason: '대표 명령', note: '넘깁니다' });
    expect(r.ok).toBe(true);
    // 교체 중이지만 그 턴의 세대(1)로 남는다
    const row = e.ctx.store.journal.query({ author: 'server', kinds: ['action'] })[0]!;
    expect(row).toMatchObject({ generation: 1, holder: 'Claude CLI', workKey: key, turnId: t, projectId: null });
    expect(row.text).toBe('메인 자리를 Codex CLI에게 넘기기로 함 (세대 2부터, 이 턴을 마치면 넘어감) — 사유: 대표 명령 / 남긴 말: 넘깁니다');
    e.liveProc(key, MAIN_AGENT_ID)!.finishOk();
    await e.core.seat.settled();
    // 프로듀서의 도구(작업 만들기)는 메인 일지에 남지 않는다
    const before = e.ctx.store.journal.count({});
    const dir = await e.main('register_directive', { project_id: e.projectId, title: '지시', text: '할 일' });
    const prodIdentity = { turnId: 'TN-prod', sessionId: 'S-prod', sessionKey: `directive:${String(dir.directiveId)}`, sessionKind: 'directive' as const, memberId: e.producerId, projectId: e.projectId, isMain: false, isProducer: true, canReview: true };
    const created = await e.core.tools.handle(prodIdentity, 'create_task', { directive_id: dir.directiveId, title: '작업', goal: '목표', type: 'docs', assignee_id: e.devId, acceptance_criteria: ['된다'] });
    expect(created.ok).toBe(true);
    expect(e.ctx.store.journal.count({}) - before).toBe(1); // register_directive 한 줄뿐
  });
});
