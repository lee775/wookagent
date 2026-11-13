/**
 * 메인 대화 턴마다 현황 요약 (SERVER_DESIGN 5.1·10.5 digestEveryTurn, 리드 결정 S5-4):
 * - 메인 대화 턴(main:*)의 메시지는 머리줄 바로 다음에 '## 현황 요약 (HH:MM UTC 기준 — 이 턴을 띄울 때 계산)'과 인용 줄을 싣는다 — 첫 턴, 이어하기, 40턴 세션
 *   교체(MEM-09 — 인계 내용보다 앞), 비정상 종료 뒤 다시 전달, 인계 메모 턴 모두. 메인 검수 턴(review:T)과 팀원 턴에는 없다
 * - '메인이 할 일'의 수는 이 턴이 실은 일을 빼고 센다. 지금 대화의 프로젝트 줄이 먼저다. 메인 세션의 get_work_context에도 부를 때 계산한 요약이 든다(검수 세션에는 없다)
 * - 요약 글은 1,500자를 넘지 않는다 — 꼭 1,500자면 줄이지 않고, 1자 넘으면 맨 아래 목록 항목 하나를 빼고 '외 1건'. 줄은 200자 이하이고 수는 빼지 않는다. 항목을
 *   다 빼도 넘치면 아래 프로젝트 줄부터 통째로 빼고 '외 프로젝트 n개'를 남긴다(지금 대화의 프로젝트는 남긴다)
 * - 차례는 정지 → 대표 쪽 → 메인이 할 일 → 프로젝트 → 열린 약속. 같은 기록이면 같은 요약이고, 비밀 값은 가린다. 응답 없음 줄은 없다
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAIN_AGENT_ID, type AiConfig, type Task } from '@shared/domain';
import { mainKey } from '../../src/main/orchestrator/records';
import { fitDigest } from '../../src/main/orchestrator/overview';
import { mainOpsIdentity } from './mainOps';
import { bootOrch, seedDirective, startReview, waitFor, type OrchEnv } from './orchHarness';
import { addDirective, addProject, addTask, hold } from './overviewSeed';

let env: OrchEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const CODEX: AiConfig = { kind: 'codex', model: null, effortTier: 'high', effortOverride: null };
/** 상한은 숫자로 못 박는다 (리드 결정 S5-4 — 요약 1,500자, 줄 200자) */
const DIGEST_MAX_CHARS = 1_500;
const DIGEST_LINE_MAX = 200;
const HEADING = /^## 현황 요약 \(\d\d:\d\d UTC 기준 — 이 턴을 띄울 때 계산\)$/;
/** 모양으로는 알아볼 수 없는 비밀 값 — 기록한 뒤에 등록해, 읽을 때 다시 가리는지 본다 */
const SECRET = 'zebra-orchard-4471-quartz-plum';
const openMain = (e: OrchEnv, key: string) => e.ctx.store.sessions.list({ ref1: MAIN_AGENT_ID, ref2: key, state: 'open' })[0]!;

/** 턴 메시지의 요약 블록 — 머리줄, 빈 줄, 제목, 인용 줄들, 빈 줄 다음의 줄. 요약이 없으면 null */
function digestBlock(message: string): { quoted: string[]; next: string } | null {
  const lines = message.split('\n');
  if (!HEADING.test(lines[2] ?? '')) return null;
  expect(lines[1]).toBe('');
  let i = 3;
  const quoted: string[] = [];
  while (lines[i]?.startsWith('> ')) quoted.push(lines[i++]!.slice(2));
  expect(lines[i]).toBe('');
  return { quoted, next: lines[i + 1] ?? '' };
}

/** 그 프로젝트에 진행 중 지시 하나와 보류 작업 n개 (답변 대기) */
function seedHeld(e: OrchEnv, projectId: string, n: number): Task[] {
  const d = addDirective(e, projectId);
  return Array.from({ length: n }, (_, i) => addTask(e, d, { state: 'on_hold', title: `${projectId} 작업 ${i}`, holds: [hold(e, 'answer_wait', '프로듀서 답을 기다림')] }));
}

describe('메인 대화 턴마다 현황 요약 (digestEveryTurn)', () => {
  it('첫 턴·이어하기·40턴 세션 교체·다시 전달·인계 메모 턴 모두 머리줄 다음에 요약이 든다 — 메인 검수 턴과 팀원 턴에는 없다', async () => {
    const e = (env = await bootOrch());
    e.core.seat.applyOperatorConfig({ holders: null, drainMs: 200, initialHolder: null }, '시험');
    const KEY = 'main:general';
    await e.invoke('command.send', { target: 'main', text: '첫 명령' });
    await e.drain(1);
    await e.invoke('command.send', { target: 'main', text: '두 번째 명령' });
    await e.drain(1);
    // 40턴 세션 교체 (MEM-09)
    e.ctx.store.sessions.put({ ...openMain(e, KEY), turnCount: 40 });
    await e.invoke('command.send', { target: 'main', text: '마흔한 번째 명령' });
    await e.drain(1);
    // 비정상 종료 뒤 다시 전달
    e.script.set(KEY, (p) => p.exit(1));
    await e.invoke('command.send', { target: 'main', text: '끊길 명령' });
    await e.drain(1);
    e.script.delete(KEY);
    await e.drain(1);
    // 프로듀서(팀원) 턴
    e.core.directives.register({ projectId: e.projectId, title: '계획할 지시', text: '계획' }, MAIN_AGENT_ID, null);
    await e.drain(1);
    // 인계 메모 턴 (운영자 교체 — 나가는 보유자의 그 대화 세션)
    e.hold.add(KEY);
    const swap = e.core.seat.assign({ holder: { kind: 'launched', ai: CODEX }, by: 'operator', reason: '운영자 교체' });
    await waitFor(() => !!e.liveProc(KEY, MAIN_AGENT_ID), '인계 메모 턴');
    e.liveProc(KEY, MAIN_AGENT_ID)!.finishOk();
    await swap.done;
    e.hold.clear();
    // 메인 검수 턴
    const review = await startReview(e, MAIN_AGENT_ID);
    e.hold.clear();
    review.proc.finishOk();
    await e.idle();

    const main = e.launches.filter((l) => l.memberId === MAIN_AGENT_ID && l.workKey === KEY);
    expect(main).toHaveLength(6);
    const [first, resume, mem09, cut, again, memo] = main;
    expect([first!.resume, resume!.resume !== null]).toEqual([null, true]);
    expect(mem09!.message).toContain('## 이전 세션에서 넘겨받은 내용');
    expect(again!.message).toContain('(다시 전달)');
    expect(memo!.message).toContain('[메인 자리 인계 메모]');
    for (const l of [first, resume, mem09, cut, again, memo]) {
      const b = digestBlock(l!.message);
      expect(b, l!.turnId).not.toBeNull();
      // 정해진 차례 — 정지, 대표 쪽, 메인이 할 일, 프로젝트, 열린 약속
      expect(b!.quoted[0]).toMatch(/^정지: /);
      expect(b!.quoted[1]).toMatch(/^대표 쪽: /);
      expect(b!.quoted[2]).toMatch(/^메인이 할 일: /);
      expect(b!.quoted[3]).toMatch(new RegExp(`^${e.projectId} 턴 회귀 — `));
      expect(b!.quoted.at(-1)).toMatch(/^열린 약속 \d+건/);
      // 요약 뒤에 인계 내용, 그다음 업무
      expect(b!.next).toMatch(l === mem09 ? /^## 이전 세션에서 넘겨받은 내용$/ : /^### 1\. /);
      expect(b!.quoted.join('\n').length).toBeLessThanOrEqual(DIGEST_MAX_CHARS);
      expect(l!.message).not.toContain('응답 없음');
    }
    // 메인 검수 턴과 팀원 턴에는 없다
    const others = e.launches.filter((l) => l.workKey !== KEY);
    expect(others.map((l) => l.workKey)).toEqual(expect.arrayContaining([`review:${review.task.id}`, expect.stringMatching(/^directive:D-/)]));
    for (const l of others) expect(l.message, l.workKey).not.toContain('## 현황 요약');
    expect(e.errors).toEqual([]);
  });

  it("'메인이 할 일'은 이 턴이 실은 일을 빼고 세고, 지금 대화의 프로젝트 줄이 먼저다 — get_work_context에도 부를 때 계산한 요약이 들고 메인 검수 세션에는 없다", async () => {
    const e = (env = await bootOrch());
    const p2 = (await e.internal('projects.create', { mode: 'new', path: `${e.projectDir}-둘째`, name: '둘째' })).id;
    const key = `main:${p2}`;
    e.hold.add(key);
    await e.invoke('command.send', { target: p2, text: '둘째 프로젝트 명령' });
    await e.invoke('command.send', { target: 'main', text: '직접 명령' });
    e.tick();
    await waitFor(() => !!e.liveProc(key, MAIN_AGENT_ID), '둘째 프로젝트의 메인 턴');
    const turnId = e.liveProc(key, MAIN_AGENT_ID)!.turnId;
    const b = digestBlock(e.launches.find((l) => l.turnId === turnId)!.message)!;
    // 이 턴이 실은 명령 1건은 빼고, 직접 명령 1건만 남은 업무다
    expect(b.quoted[2]).toMatch(/^메인이 할 일: 남은 업무 1건\(명령 처리 1\) · /);
    expect(b.quoted.slice(3, 5).map((x) => x.split(' ')[0])).toEqual([p2, e.projectId]);
    // get_work_context: 지금 기록으로 계산한 같은 요약 (이 턴이 실은 일은 빼고)
    const ctxRes = (await e.tool(turnId, 'get_work_context')) as { ok: true; data: { digest?: string } };
    const carried = new Set(e.ctx.store.queue.list({ ref2: key }).filter((q) => q.turnId === turnId).map((q) => q.id));
    expect(carried.size).toBe(1);
    expect(ctxRes.data.digest).toBe(e.core.overview.digest({ sessionKey: key, excludeEntryIds: carried }));
    expect(ctxRes.data.digest).toContain('남은 업무 1건(명령 처리 1)');
    e.hold.clear();
    e.liveProc(key, MAIN_AGENT_ID)!.finishOk();
    await e.idle();
    await e.drain(1);
    // 메인 검수 세션의 업무 문맥에는 요약이 없다
    const review = await startReview(e, MAIN_AGENT_ID);
    const rc = (await e.tool(review.turnId, 'get_work_context')) as { ok: true; data: Record<string, unknown> };
    expect(rc.ok).toBe(true);
    expect('digest' in rc.data).toBe(false);
    review.proc.finishOk();
  });

  it('1,500자 그대로면 줄이지 않고, 1자 넘으면 맨 아래 목록 항목 하나만 빼고 "외 1건" — 줄은 200자 이하, 같은 기록이면 같은 요약', async () => {
    const e = (env = await bootOrch());
    const projects = [e.ctx.store.projects.require(e.projectId), ...Array.from({ length: 9 }, (_, i) => addProject(e, `p${i}`))];
    const held = new Map(projects.map((p) => [p.id, seedHeld(e, p.id, 5)]));
    const rename = (names: string[]) => projects.forEach((p, i) => e.ctx.store.projects.put({ ...e.ctx.store.projects.require(p.id), name: names[i]! }));
    const digest = () => e.core.overview.digest({ sessionKey: 'main:general' });
    // 이름을 한 글자로 두고 잰 뒤, 꼭 1,500자가 되게 이름을 늘린다 (이름은 한 줄에 40자까지 그대로 실린다)
    rename(projects.map(() => 'p'));
    const base = digest().length;
    const need = DIGEST_MAX_CHARS - base;
    expect(need).toBeGreaterThan(0);
    expect(need).toBeLessThanOrEqual(projects.length * 35);
    const names = projects.map((_, i) => 'p' + 'x'.repeat(Math.floor(need / projects.length) + (i < need % projects.length ? 1 : 0)));
    rename(names);
    const exact = digest();
    expect(exact.length).toBe(DIGEST_MAX_CHARS);
    expect(exact).not.toMatch(/ 외 \d+건|목록 생략/);
    const lines = exact.split('\n');
    expect(lines.every((l) => l.length <= DIGEST_LINE_MAX)).toBe(true);
    for (const p of projects) for (const t of held.get(p.id)!) expect(exact).toContain(`${t.id}(답변 대기)`);
    // 같은 기록이면 같은 요약
    expect(digest()).toBe(exact);

    // 1자 더: 맨 아래 목록 항목(마지막 프로젝트의 마지막 보류 작업) 하나만 빠지고 '외 1건'. 다른 줄은 그대로
    rename(names.map((n, i) => (i === 0 ? `${n}y` : n)));
    const over = digest();
    expect(over.length).toBeLessThanOrEqual(DIGEST_MAX_CHARS);
    const after = over.split('\n');
    expect(after).toHaveLength(lines.length);
    const lastProject = projects.at(-1)!;
    const lastRow = after.findIndex((l) => l.startsWith(`${lastProject.id} `));
    const firstRow = after.findIndex((l) => l.startsWith(`${projects[0]!.id} `));
    expect(after[lastRow]).toBe(lines[lastRow]!.replace(`, ${held.get(lastProject.id)!.at(-1)!.id}(답변 대기)`, ' 외 1건'));
    expect(after[firstRow]).toBe(lines[firstRow]!.replace(names[0]!, `${names[0]}y`));
    expect(after.filter((_, i) => i !== lastRow && i !== firstRow)).toEqual(lines.filter((_, i) => i !== lastRow && i !== firstRow));
    expect(over.match(/ 외 \d+건/g)).toEqual([' 외 1건']);
  });

  it('한 줄이 200자를 넘으면 전체가 1,500자 안이어도 그 줄의 뒤 항목부터 빼고 "외 n건" — 수는 남는다', async () => {
    const e = (env = await bootOrch());
    const held = seedHeld(e, e.projectId, 20);
    const text = e.core.overview.digest({ sessionKey: 'main:general' });
    expect(text.length).toBeLessThan(DIGEST_MAX_CHARS - 500);
    const row = text.split('\n').find((l) => l.startsWith(`${e.projectId} `))!;
    expect(row.length).toBeLessThanOrEqual(DIGEST_LINE_MAX);
    const shown = held.filter((t) => row.includes(`${t.id}(답변 대기)`)).length;
    expect(shown).toBeGreaterThan(5);
    expect(shown).toBeLessThan(20);
    // 앞 항목이 남고 뒤 항목이 빠진다
    expect(held.slice(0, shown).every((t) => row.includes(`${t.id}(`))).toBe(true);
    expect(row).toMatch(new RegExp(`— 진행 중 지시 1건, 작업 보류 20 · 보류 20건: .* 외 ${20 - shown}건$`));
  });

  it('항목을 다 빼도 넘치면 아래 프로젝트 줄부터 통째로 빼고 "외 프로젝트 n개" — 수와 지금 대화의 프로젝트는 남고, 비밀 값은 가린다. 열린 약속은 수와 오래된 3건', async () => {
    const e = (env = await bootOrch());
    const projects = [e.ctx.store.projects.require(e.projectId), ...Array.from({ length: 29 }, (_, i) => addProject(e, `프로젝트 ${String(i).padStart(2, '0')} ${'긴 이름'.repeat(4)}`))];
    for (const p of projects) seedHeld(e, p.id, 6);
    const current = projects[20]!;
    e.ctx.store.projects.put({ ...current, name: `결제 ${SECRET}` });
    e.ctx.redact.addSecret(SECRET, 'api-key');
    for (let i = 0; i < 5; i++) e.core.journal.write(mainOpsIdentity('main:general', `TN-p${i}`), { kind: 'promise', text: `약속 ${i}번: 대표 답을 받으면 프로듀서에게 전한다`, reason: '전하면 닫는다' });
    const text = e.core.overview.digest({ sessionKey: `main:${current.id}` });
    expect(text.length).toBeLessThanOrEqual(DIGEST_MAX_CHARS);
    expect(text).not.toContain(SECRET);
    const lines = text.split('\n');
    expect(lines.every((l) => l.length <= DIGEST_LINE_MAX)).toBe(true);
    expect(lines.slice(0, 3).map((l) => l.split(':')[0])).toEqual(['정지', '대표 쪽', '메인이 할 일']);
    // 지금 대화의 프로젝트가 먼저, 수는 그대로 (목록은 빠졌다)
    expect(lines[3]).toMatch(new RegExp(`^${current.id} 결제 .* — 진행 중 지시 1건, 작업 보류 6 · 보류 6건`));
    const rows = lines.filter((l) => /^P-\d{4} /.test(l));
    expect(rows.every((l) => /— 진행 중 지시 1건, 작업 보류 6 · 보류 6건/.test(l))).toBe(true);
    const gone = projects.length - rows.length;
    expect(gone).toBeGreaterThan(0);
    expect(lines.at(-2)).toBe(`외 프로젝트 ${gone}개 — get_overview로 보세요`);
    // 빠진 것은 아래(ID가 큰) 프로젝트 줄이다
    const shown = rows.map((l) => l.split(' ')[0]!);
    expect(shown.slice(1)).toEqual(projects.filter((p) => p.id !== current.id).map((p) => p.id).slice(0, rows.length - 1));
    // 열린 약속: 수는 남고 목록은 빠졌다 — 남는 일이 줄면 오래된 3건과 '외 2건'
    expect(lines.at(-1)).toBe('열린 약속 5건(목록 생략)');
    const small = (await bootOrch());
    try {
      for (let i = 0; i < 5; i++) small.core.journal.write(mainOpsIdentity('main:general', `TN-q${i}`), { kind: 'promise', text: `약속 ${i}번`, reason: '닫는다' });
      const promises = small.ctx.store.journal.query({ openPromisesOnly: true, asc: true }).map((r) => r.id);
      expect(small.core.overview.digest({ sessionKey: 'main:general' }).split('\n').at(-1)).toBe(
        `열린 약속 5건: ${promises.slice(0, 3).map((id, i) => `${id} "약속 ${i}번 닫는 조건: 닫는다"`).join(', ')} 외 2건`,
      );
    } finally {
      await small.close();
    }
  });

  it('긴급 정지 중이면 정지 줄이 그 때를 말하고, 메인 자리가 응답 없음이어도 요약에는 그 줄이 없다', async () => {
    const e = (env = await bootOrch());
    const seat = e.ctx.store.seat.get('main')!;
    e.ctx.store.seat.put({ ...seat, unresponsiveSince: e.ctx.now(), unresponsiveReason: '사용량 한도로 메인 턴이 3번 연달아 끝났습니다' });
    expect(e.core.overview.digest({ sessionKey: 'main:general' })).not.toMatch(/응답 없음|사용량 한도/);
    await e.invoke('stop.emergency');
    const since = e.ctx.stop().global.since!;
    expect(e.core.overview.digest({ sessionKey: 'main:general' }).split('\n')[0]).toBe(`정지: 긴급 정지 중(${since.slice(11, 16)} UTC부터)`);
  });
});

describe('요약은 진행 중 프로젝트를 모두 센다 (리드 결정 S5-27)', () => {
  /** 프로젝트 줄 수와 '외 프로젝트 n개' */
  const projectLines = (text: string) => ({ shown: text.split('\n').filter((l) => /^P-\d+ /.test(l)), more: Number(/^외 프로젝트 (\d+)개 — get_overview로 보세요$/m.exec(text)?.[1] ?? '0') });

  it('프로젝트가 100개를 넘어도 줄이 있는 수와 "외 프로젝트 n개"를 더하면 진행 중 프로젝트 수다 — get_overview는 제 상한(20건, detail 100건)과 total을 지킨다', async () => {
    const e = (env = await bootOrch());
    for (let i = 0; i < 104; i++) addProject(e, `복제 프로젝트 ${i}`);
    const total = e.ctx.store.projects.list({ state: 'active' }).length;
    expect(total).toBe(105);
    const text = e.core.overview.digest({ sessionKey: 'main:general' });
    expect(text.length).toBeLessThanOrEqual(DIGEST_MAX_CHARS);
    const { shown, more } = projectLines(text);
    expect(more).toBeGreaterThan(0);
    expect(shown.length + more).toBe(total);
    // get_overview(현황)는 그대로 — 목록 상한과 전체 수
    expect([e.core.overview.build().projects.total, e.core.overview.build().projects.items.length]).toEqual([105, 20]);
    expect([e.core.overview.build({ detail: true }).projects.total, e.core.overview.build({ detail: true }).projects.items.length]).toEqual([105, 100]);
  });

  it('100번째 뒤의 프로젝트 대화(main:P)에서도 그 프로젝트 줄이 맨 먼저다 — 다른 프로젝트 줄이 빠져도 남는다', async () => {
    const e = (env = await bootOrch());
    const ids = Array.from({ length: 104 }, (_, i) => addProject(e, `복제 프로젝트 ${i}`).id);
    const last = ids.at(-1)!;
    const text = e.core.overview.digest({ sessionKey: `main:${last}` });
    const { shown, more } = projectLines(text);
    expect(shown[0]!.startsWith(`${last} 복제 프로젝트 103 — `)).toBe(true);
    expect(shown.filter((l) => l.startsWith(`${last} `))).toHaveLength(1);
    expect(shown.length + more).toBe(105);
  });
});

describe('요약의 표시 (리드 결정 S5-3·S5-4 — holdReach 한 판정, 읽지 않음, 일시정지, 긴급 정지 보류, 그 밖의 열린 작업)', () => {
  it('정지 줄은 일시정지된 팀원과 긴급 정지 보류가 남은 작업 수, 대표 쪽은 읽지 않은 보고, 프로젝트 줄은 메인에게 간 보류를 적는다', async () => {
    const e = (env = await bootOrch());
    const ctx = e.ctx;
    const d = seedDirective(e);
    const mk = (title: string) => e.core.tasks.create({ directiveId: d.id, title, goal: title, type: 'development', assigneeId: e.devId, acceptanceCriteria: ['동작한다'], outputMode: 'repo', prerequisiteIds: [] }, e.producerId);
    // 메인에게 알림이 간 보류(되돌리기 처리 실패)와 긴급 정지가 보류할 대기 작업
    const failed = mk('되돌리기 작업');
    mk('긴급 정지로 보류될 작업');
    (e.core.merges as unknown as { revertFailed(id: string, err: unknown): void }).revertFailed(failed.id, new Error('시험 오류'));
    e.hold.add(mainKey(e.projectId));
    e.hold.add(mainKey(null));
    await e.invoke('stop.emergency');
    await e.invoke('stop.release');
    // 메인에게 가지 않는 보류(답변 대기)
    const waiting = addTask(e, d, { state: 'on_hold', title: '답을 기다리는 작업', holds: [hold(e, 'answer_wait', '프로듀서 답을 기다림')] });
    const stop = ctx.stop();
    ctx.saveStop({ ...stop, members: { ...stop.members, [e.qaId]: { paused: true, mode: 'immediate', since: ctx.now(), by: MAIN_AGENT_ID } } });
    const r = await e.main('submit_report', { title: '새 보고', summary: 's', results: 'r', changed_files: [], how_to_verify: '-', issues: '', next_steps: '' });
    const reportId = String((r as { reportId: string }).reportId);
    const lines = e.core.overview.digest({ sessionKey: mainKey(e.projectId) }).split('\n');
    const stopLine = lines.find((l) => l.startsWith('정지: '))!;
    expect(stopLine).toContain(`일시정지된 팀원 1명: ${e.ctx.store.members.require(e.qaId).name}(${e.qaId})`);
    const held = e.core.stops.heldByEmergency();
    expect(held).toBeGreaterThan(0);
    expect(stopLine).toContain(`긴급 정지 보류가 남은 작업 ${held}건`);
    expect(lines.find((l) => l.startsWith('대표 쪽: '))!).toContain(`승인을 기다리는 보고 1건: ${reportId}(읽지 않음)`);
    const projectLine = lines.find((l) => l.startsWith(`${e.projectId} `))!;
    expect(projectLine).toMatch(new RegExp(`${failed.id}\\([^)]*, 메인에게 감\\)`));
    expect(projectLine).toContain(`${waiting.id}(답변 대기)`);
    // 읽은 보고에는 표시가 없다
    await e.invoke('reports.markRead', reportId);
    expect(e.core.overview.digest({ sessionKey: mainKey(e.projectId) })).toContain(`승인을 기다리는 보고 1건: ${reportId} ·`);
  });

  it('프로젝트 줄은 그 밖의 열린 작업(닫힌 지시에 남은 작업 등)을 센다', async () => {
    const e = (env = await bootOrch());
    const d = addDirective(e, e.projectId, { state: 'cancelled' });
    addTask(e, d, { state: 'in_progress' });
    const block = e.core.overview.build({}).projects.items.find((p) => p.id === e.projectId)!;
    expect(block.tasks.otherOpenTasks).toBe(1);
    const line = e.core.overview.digest({ sessionKey: mainKey(e.projectId) }).split('\n').find((l) => l.startsWith(`${e.projectId} `))!;
    expect(line).toContain('그 밖의 열린 작업 1건');
  });
});

// ───────────── 요약은 프로젝트 수에 비례한다 (리드 결정 S5-38) ─────────────

type Rows = Parameters<typeof fitDigest>[0];

/**
 * S5-38 전의 fitDigest 그대로(overview.ts, S5F1) — 항목 하나·줄 하나를 뺄 때마다 모든 줄을 다시 그리고 가렸다. 새 계산이 같은 입력에 같은 글을 내는지 견주는
 * 기준이다(결과는 그대로, 일만 줄었다)
 */
function fitDigestBefore(rows: Rows, redact: (s: string) => string, projectsTotal: number): string {
  const line = (s: string, max: number): string => {
    const t = s.replace(/\s+/g, ' ').trim();
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
  };
  const renderPart = (p: Rows[number]['parts'][number]): string => {
    const shown = p.items.slice(0, p.shown);
    if (!shown.length) return p.items.length ? `${p.text}(목록 생략)` : p.text;
    const omitted = p.total - shown.length;
    return `${p.text}: ${shown.join(', ')}${omitted > 0 ? ` 외 ${omitted}건` : ''}`;
  };
  const renderRow = (r: Rows[number]): string => redact(`${r.lead}${r.parts.map(renderPart).join(' · ')}`);
  const dropOne = (r: Rows[number]): boolean => {
    for (let i = r.parts.length - 1; i >= 0; i--) {
      const p = r.parts[i]!;
      if (p.shown > 0) {
        p.shown -= 1;
        return true;
      }
    }
    return false;
  };
  for (const r of rows) while (renderRow(r).length > DIGEST_LINE_MAX && dropOne(r));
  const render = (): string => {
    const out = rows.filter((r) => !r.dropped).map((r) => line(renderRow(r), DIGEST_LINE_MAX));
    const gone = projectsTotal - rows.filter((r) => r.project && !r.dropped).length;
    if (gone > 0) out.splice(out.length - 1, 0, `외 프로젝트 ${gone}개 — get_overview로 보세요`);
    return out.join('\n');
  };
  while (render().length > DIGEST_MAX_CHARS) {
    const live = rows.filter((r) => !r.dropped);
    if (live.slice().reverse().some((r) => dropOne(r))) continue;
    const last = live.slice().reverse().find((r) => r.project);
    if (!last) break;
    last.dropped = true;
  }
  const text = render();
  return text.length > DIGEST_MAX_CHARS ? `${text.slice(0, DIGEST_MAX_CHARS - 1)}…` : text;
}

/** 시험마다 같은 수열 (mulberry32) */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 요약 줄 모양의 입력 — 고정 줄 셋, 프로젝트 줄 n개, 열린 약속 줄. 항목 일부에 가릴 글('비밀값')을 넣어 가린 뒤 길이가 바뀌게 한다 */
function digestRows(rand: () => number, n: number): Rows {
  const word = (max: number) => {
    const len = 1 + Math.floor(rand() * max);
    const s = Array.from({ length: len }, () => '가나다라마바abcxyz 0123'[Math.floor(rand() * 23)]).join('');
    return rand() < 0.1 ? `${s}비밀값${s}` : s;
  };
  const parts = (k: number) =>
    Array.from({ length: k }, () => {
      const items = Array.from({ length: Math.floor(rand() * (rand() < 0.2 ? 30 : 6)) }, () => `T-${word(12)}`);
      return { text: `${word(10)} ${items.length}건`, items, total: items.length + (rand() < 0.3 ? Math.floor(rand() * 5) : 0), shown: items.length };
    });
  return [
    { lead: '정지: ', parts: parts(1 + Math.floor(rand() * 3)) },
    { lead: '대표 쪽: ', parts: parts(3) },
    { lead: '메인이 할 일: ', parts: parts(4) },
    ...Array.from({ length: n }, (_, i) => ({ lead: `P-${String(i + 1).padStart(4, '0')} ${word(rand() < 0.2 ? 60 : 20)} — `, parts: parts(1 + Math.floor(rand() * 3)), project: true as const })),
    { lead: '', parts: parts(1) },
  ];
}

const redactWords = (s: string): string => s.replace(/비밀값/g, '[가림:비밀]');

describe('요약은 프로젝트 수에 비례한다 (리드 결정 S5-38 — 결과는 그대로, 줄마다 한 번 그린다)', () => {
  it('같은 입력이면 S5-38 전의 계산과 글이 같다 — 프로젝트 줄 0·1·100·101·251·300개와 그 사이, 긴 줄·항목·가린 글·줄이 없는 프로젝트', () => {
    const rand = seeded(5038);
    const sizes = [0, 1, 2, 5, 30, 100, 101, 251, 300, ...Array.from({ length: 40 }, () => Math.floor(rand() * 320))];
    let rowDrops = 0;
    for (const n of sizes) {
      const rows = digestRows(rand, n);
      const total = n + (rand() < 0.3 ? Math.floor(rand() * 4) : 0);
      const before = fitDigestBefore(structuredClone(rows), redactWords, total);
      const now = fitDigest(structuredClone(rows), redactWords, total);
      expect(now, `프로젝트 줄 ${n}개, 진행 중 ${total}개`).toBe(before);
      expect(now.length).toBeLessThanOrEqual(DIGEST_MAX_CHARS);
      if (/^외 프로젝트 \d+개/m.test(now)) rowDrops++;
    }
    // 줄을 통째로 빼는 갈래와 빼지 않는 갈래를 모두 지났다
    expect(rowDrops).toBeGreaterThan(5);
    expect(rowDrops).toBeLessThan(sizes.length);
    // 계산만 하는 시험이다 — 개발 PC에서 약 23초, 공용 CI 러너의 첫 두 실행에서 21.8초와 36.1초. 기본 상한(60초)에 가까워 넉넉히 둔다 (리드 결정 S10-20)
  }, 120_000);

  it('진행 중 프로젝트 1,000개의 요약 하나가 가리는 횟수는 줄 수 × 3 이하이고, 500개일 때의 두 배 남짓이다 (시간이 아니라 가린 횟수를 센다)', async () => {
    const e = (env = await bootOrch());
    const redactCalls = (sessionKey: string): { calls: number; text: string } => {
      const spy = vi.spyOn(e.ctx.redact, 'text');
      try {
        const text = e.core.overview.digest({ sessionKey });
        return { calls: spy.mock.calls.length, text };
      } finally {
        spy.mockRestore();
      }
    };
    for (let i = 0; i < 499; i++) addProject(e, `복제 프로젝트 ${i}`);
    const half = redactCalls('main:general');
    for (let i = 499; i < 999; i++) addProject(e, `복제 프로젝트 ${i}`);
    expect(e.ctx.store.projects.list({ state: 'active' })).toHaveLength(1_000);
    const full = redactCalls('main:general');
    // 요약 줄: 고정 줄 넷(정지·대표 쪽·메인이 할 일·열린 약속) + 프로젝트 1,000줄
    const rows = 4 + 1_000;
    expect(full.calls).toBeLessThanOrEqual(rows * 3);
    expect(full.calls).toBeGreaterThan(rows);
    // 선형: 프로젝트가 두 배면 가리는 횟수도 두 배 남짓(줄 하나 뺄 때마다 모두 다시 그리면 네 배 가까이)
    expect(full.calls).toBeLessThanOrEqual(half.calls * 2.2);
    // 결과는 그대로 — 줄 수와 '외 프로젝트 n개'를 더하면 진행 중 프로젝트 수다
    const shown = full.text.split('\n').filter((l) => /^P-\d+ /.test(l)).length;
    expect(shown + Number(/^외 프로젝트 (\d+)개/m.exec(full.text)?.[1] ?? '0')).toBe(1_000);
  });
});
