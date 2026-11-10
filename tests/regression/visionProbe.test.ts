/**
 * 화면 보기 확인과 MainSeat.vision (SERVER_DESIGN 8.3.4, 리드 결정 S6-10 — 10.6 visionProbe). 가짜 도우미·모의 보유자만 쓴다 (S6-15).
 * - 새 보유자·모델마다 화면 확인 업무(screen_check)가 main:general에 한 번 들어가고, 시험 이미지(숫자 네 자리)는 도구 결과 이미지로 간다
 * - 맞히면 verified, 틀리면 failed (한 확인에 한 번만), 답하지 않고 정상으로 끝나면 failed, 비정상 종료면 다시 넣고 그대로 unknown
 * - 받지 않은 시험 이미지에 답하면 conflict. 세대가 바뀌거나 모델이 바뀌면 unknown으로 되돌리고 다시 확인한다 — 이어받지 않는다. 노력치만 바뀌면 그대로
 * - failed 보유자의 screen_capture는 이미지 대신 글 정보(창은 캡처 좌표)이고 도구 설명에 '볼 수 없다고 확인됨'이 붙는다
 * - 숫자는 메모리에만 — 대기열·활동 기록·일지·파일 이름에 없다. 화면 도우미가 없으면 확인 업무를 넣지 않는다
 * - 끝에서 끝까지: 실제 앱 도구 서버와 모의 보유자(resources/mock-agent) — 보는 보유자는 verified, 보지 못하는 보유자는 failed, 이벤트 파일에 이미지 바이트 없음
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID, type QueueEntry } from '@shared/domain';
import { readScreenCheckDigits, screenCheckImage } from '../../src/main/desktop/testImage';
import { visionModelKey } from '../../src/main/desktop/service';
import { TOOL_SPECS } from '../../src/main/mcp/catalog';
import { createFakeDesktop } from '../fixtures/desktop/fakeDesktop';
import { bootApp, scanFiles, waitFor as accWaitFor } from '../acceptance/security-helpers';
import { bootOrch, waitFor, type OrchEnv } from './orchHarness';
import { bootGui, capture, MAIN_KEY, type GuiEnv } from './guiRig';

const open: GuiEnv[] = [];
afterEach(async () => {
  for (const g of open.splice(0)) await g.close();
});

const checks = (e: OrchEnv): QueueEntry[] => e.ctx.store.queue.list({ ref2: MAIN_KEY }).filter((q) => q.kind === 'screen_check');
const seat = (e: OrchEnv) => e.ctx.store.seat.require('main');

/** 화면 확인 업무를 실은 메인 턴을 띄워 실행 중으로 둔다 */
async function checkTurn(e: OrchEnv): Promise<string> {
  e.hold.add(MAIN_KEY);
  e.tick();
  await waitFor(() => !!e.liveProc(MAIN_KEY, MAIN_AGENT_ID), '화면 확인 턴');
  const turnId = e.liveProc(MAIN_KEY, MAIN_AGENT_ID)!.turnId;
  expect(e.ctx.store.queue.list({ ref2: MAIN_KEY, state: 'running' }).map((q) => q.kind)).toContain('screen_check');
  return turnId;
}

/** 같은 Claude에서 모델만 바꾼다 — 세대 그대로, 화면 보기는 다시 확인 */
async function changeModel(e: OrchEnv, model: string): Promise<void> {
  const h = seat(e).holder!;
  if (h.kind !== 'launched') throw new Error('launched 보유자가 아닙니다');
  await e.core.seat.assign({ holder: { kind: 'launched', ai: { ...h.ai, model } }, by: 'operator', reason: `모델을 ${model}로` }).done;
}

async function endTurn(e: OrchEnv, turnId: string): Promise<void> {
  e.hold.delete(MAIN_KEY);
  e.procs.find((p) => p.turnId === turnId)!.finishOk('끝');
  await e.idle();
}

describe('화면 보기 확인 (S6-10)', () => {
  it('첫 보유자의 확인 업무가 한 번 들어가고, 답하지 않고 정상으로 끝나면 failed — failed 보유자의 캡처는 글 정보만, 도구 설명에 그 사실', async () => {
    const g = await bootGui({ windows: [{ title: '제목 없음 - 메모장', app: 'notepad', pid: 4242, x: 200, y: 100, width: 800, height: 600, minimized: false, blocked: false, elevated: false }] }, { vision: 'keep' });
    open.push(g);
    const { e } = g;
    const s0 = seat(e);
    const first = checks(e);
    expect(first.map((q) => q.requestId)).toEqual([`screen-check:g${s0.generation}:${visionModelKey(s0.holder)}`]);
    // 하네스의 가짜 CLI는 답하지 않고 곧바로 끝낸다 — 아직 띄우지 않았으면 띄운다
    if (seat(e).vision === 'unknown') {
      e.tick();
      await e.idle();
    }
    expect(seat(e)).toMatchObject({ vision: 'failed', visionModel: visionModelKey(s0.holder) });
    expect(e.ctx.store.activity.search({ kinds: ['seat'], text: '화면 보기 확인', limit: 5 }).map((x) => x.text)).toEqual([expect.stringContaining('볼 수 없음(failed)')]);
    expect(e.ctx.store.journal.query({ kinds: ['seat'] }).some((j) => j.text.includes('답하지 않고 턴을 마침'))).toBe(true);
    // 다시 시작해도 같은 확인을 또 넣지 않는다 (요청 ID 한 번)
    e.core.desktop.startupSweep();
    expect(checks(e)).toHaveLength(1);

    e.hold.add(MAIN_KEY);
    await e.invoke('command.send', { target: 'main', text: '화면을 봐 줘' });
    e.tick();
    await waitFor(() => !!e.liveProc(MAIN_KEY, MAIN_AGENT_ID), '메인 턴');
    const turnId = e.liveProc(MAIN_KEY, MAIN_AGENT_ID)!.turnId;
    const shot = await capture(e, turnId);
    expect(shot.r.ok && shot.r.images).toBeUndefined();
    expect(shot.data.image).toBe('text_only');
    expect(shot.data.note).toContain('이 보유자는 화면 이미지를 볼 수 없다고 확인됨');
    // 창은 캡처 좌표 (주 모니터 1920 → 1280, 배율 1.5)
    expect(shot.data.windows).toEqual([{ title: '제목 없음 - 메모장', app: 'notepad', x: 133, y: 66, width: 533, height: 400, minimized: false, blocked: false }]);
    const spec = TOOL_SPECS.find((t) => t.name === 'screen_capture')!;
    expect(e.core.desktop.describe(e.identity(turnId), spec)).toContain('이 보유자는 화면 이미지를 볼 수 없다고 확인됨');
  });

  it('모델이 바뀌면 다시 확인한다 — 이미지의 숫자를 맞히면 verified, 한 번만 답하고, 숫자는 대기열·기록·일지·파일 이름에 없다', async () => {
    const g = await bootGui({}, { vision: 'failed' });
    open.push(g);
    const { e } = g;
    await changeModel(e, 'opus');
    expect(seat(e)).toMatchObject({ vision: 'unknown', visionModel: null });
    const queued = checks(e).filter((q) => q.state === 'queued');
    expect(queued.map((q) => q.requestId)).toEqual([`screen-check:g${seat(e).generation}:${visionModelKey(seat(e).holder)}`]);
    const turnId = await checkTurn(e);
    // 아직 확인하지 않은 보유자의 캡처는 이미지를 붙이고 그 사실을 적는다 — '본다'로 말하지 않는다 (CLI-21)
    const unknownShot = await capture(e, turnId);
    expect([unknownShot.data.image, unknownShot.data.note]).toEqual(['attached', expect.stringContaining('아직 확인하지 않았습니다')]);
    // 받기 전에 답하면 conflict
    expect(await e.tool(turnId, 'answer_screen_check', { code: '1234', request_id: 'rq-early' })).toMatchObject({ ok: false, code: 'conflict' });
    const got = await e.tool(turnId, 'get_screen_check', {});
    if (!got.ok) throw new Error(got.message);
    expect(got.images?.map((i) => i.mimeType)).toEqual(['image/png']);
    const file = (got.data as { file: string }).file;
    expect(file).toMatch(/[\\/]screens[\\/]check-[0-9a-f]{8}\.png$/);
    const code = readScreenCheckDigits(Buffer.from(got.images![0]!.data, 'base64'))!;
    expect(code).toMatch(/^\d{4}$/);
    // 다시 받아도 같은 이미지 (숫자는 확인마다 하나)
    const again = await e.tool(turnId, 'get_screen_check', {});
    expect(again.ok && again.images![0]!.data).toBe(got.images![0]!.data);
    const answer = await e.tool(turnId, 'answer_screen_check', { code: ` ${code.slice(0, 2)}-${code.slice(2)} `, request_id: 'rq-answer' });
    expect(answer).toMatchObject({ ok: true, data: { result: 'verified' } });
    expect(seat(e)).toMatchObject({ vision: 'verified', visionModel: visionModelKey(seat(e).holder) });
    expect(existsSync(file)).toBe(false);
    // 한 확인에 한 번 — 다른 요청 ID로 다시 답하면 conflict (다음 확인은 다음 보유자·모델)
    expect(await e.tool(turnId, 'answer_screen_check', { code, request_id: 'rq-answer-2' })).toMatchObject({ ok: false, code: 'conflict' });
    // 숫자는 서버가 쓴 글에 없다
    const written = [
      ...e.ctx.store.queue.list({ ref2: MAIN_KEY }).map((q) => q.message),
      ...e.ctx.store.activity.search({ limit: 500 }).map((x) => `${x.text} ${x.result ?? ''}`),
      ...e.ctx.store.journal.query({}).map((j) => j.text),
      ...readdirSync(e.core.desktop.store.dir()),
    ].join('\n');
    expect(written.includes(code)).toBe(false);
    await endTurn(e, turnId);
    // 정상으로 끝나도 맞힌 확인은 그대로
    expect(seat(e).vision).toBe('verified');
  });

  it('틀리면 failed — 같은 확인에 다시 답할 수 없다. 노력치만 바꾸면 그대로, 세대가 바뀌면(교체) unknown으로 되돌려 다시 확인한다', async () => {
    const g = await bootGui({}, { vision: 'failed' });
    open.push(g);
    const { e } = g;
    await changeModel(e, 'sonnet');
    const turnId = await checkTurn(e);
    const got = await e.tool(turnId, 'get_screen_check', {});
    const code = readScreenCheckDigits(Buffer.from(got.ok ? got.images![0]!.data : '', 'base64'))!;
    const wrong = code === '0000' ? '1111' : '0000';
    expect(await e.tool(turnId, 'answer_screen_check', { code: wrong, request_id: 'rq-w1' })).toMatchObject({ ok: true, data: { result: 'failed' } });
    expect(await e.tool(turnId, 'answer_screen_check', { code, request_id: 'rq-w2' })).toMatchObject({ ok: false, code: 'conflict' });
    expect(seat(e).vision).toBe('failed');
    await endTurn(e, turnId);

    // 노력치만 — 그대로
    const h = seat(e).holder!;
    if (h.kind !== 'launched') throw new Error('launched');
    await e.core.seat.assign({ holder: { kind: 'launched', ai: { ...h.ai, effortTier: h.ai.effortTier === 'high' ? 'normal' : 'high' } }, by: 'operator', reason: '노력치만' }).done;
    expect(seat(e).vision).toBe('failed');
    const before = checks(e).length;
    expect(checks(e)).toHaveLength(before);

    // 새 세대 — 이어받지 않는다
    await e.core.seat.assign({ holder: { kind: 'launched', ai: { kind: 'codex', model: null, effortTier: 'high', effortOverride: null } }, by: 'operator', reason: 'Codex로', force: true }).done;
    const s = seat(e);
    expect([s.state, s.vision, s.visionModel]).toEqual(['active', 'unknown', null]);
    expect(checks(e).filter((q) => q.state === 'queued').map((q) => q.requestId)).toEqual([`screen-check:g${s.generation}:${visionModelKey(s.holder)}`]);
  });

  it('숫자에 숫자를 더 붙인 답은 failed다 — 네 자리로 시작하거나 끝난다고 맞힌 것이 아니다 (S6-10 "그 숫자가 아니면 failed", S6-21 J3)', async () => {
    const g = await bootGui({}, { vision: 'failed' });
    open.push(g);
    const { e } = g;
    for (const [model, wrap] of [
      ['opus', (code: string) => `${code}7`],
      ['haiku', (code: string) => `0${code}`],
      ['sonnet', (code: string) => `${code} ${code}`],
    ] as const) {
      await changeModel(e, model);
      const turnId = await checkTurn(e);
      const got = await e.tool(turnId, 'get_screen_check', {});
      const code = readScreenCheckDigits(Buffer.from(got.ok ? got.images![0]!.data : '', 'base64'))!;
      expect(code).toMatch(/^\d{4}$/);
      expect([model, await e.tool(turnId, 'answer_screen_check', { code: wrap(code), request_id: `rq-extra-${model}` })]).toMatchObject([model, { ok: true, data: { result: 'failed' } }]);
      expect(seat(e)).toMatchObject({ vision: 'failed', visionModel: visionModelKey(seat(e).holder) });
      await endTurn(e, turnId);
    }
  });

  it('확인 턴이 도는 중에 모델이 바뀌면, 옛 모델로 뜬 그 턴은 새 모델의 확인을 받지도 답하지도 못한다(conflict) — 새 모델은 제 턴이 맞힐 때까지 unknown이다 (S6-21 G)', async () => {
    const g = await bootGui({}, { vision: 'failed' });
    open.push(g);
    const { e } = g;
    await changeModel(e, 'opus');
    const oldTurn = await checkTurn(e);
    const oldKey = visionModelKey(seat(e).holder);
    expect(e.launches.find((l) => l.turnId === oldTurn)?.model).toBe('opus');
    // 턴의 토큰 신원에 띄울 때의 모델 키가 적힌다
    expect(e.identity(oldTurn).modelKey).toBe(oldKey);
    // 옛 모델의 확인을 받아 둔다 (그 숫자를 쥔 채 모델이 바뀐다)
    const gotOld = await e.tool(oldTurn, 'get_screen_check', {});
    const oldCode = readScreenCheckDigits(Buffer.from(gotOld.ok ? gotOld.images![0]!.data : '', 'base64'))!;
    expect(oldCode).toMatch(/^\d{4}$/);

    // 모델이 바뀐다 — 세대는 그대로, 실행 중인 턴은 띄울 때의 모델 그대로다
    await changeModel(e, 'haiku');
    const newKey = visionModelKey(seat(e).holder);
    expect(newKey).not.toBe(oldKey);
    expect(seat(e)).toMatchObject({ vision: 'unknown', visionModel: null });
    // 옛 턴은 새 모델의 시험 이미지를 받지 못하고, 쥐고 있던 숫자로도 답하지 못한다
    const got = await e.tool(oldTurn, 'get_screen_check', {});
    expect(got).toMatchObject({ ok: false, code: 'conflict' });
    if (!got.ok) expect(got.message).toContain('모델이 바뀌었습니다');
    expect(got.ok ? got.images : undefined).toBeUndefined();
    expect(await e.tool(oldTurn, 'answer_screen_check', { code: oldCode, request_id: 'rq-g-old' })).toMatchObject({ ok: false, code: 'conflict' });
    expect(seat(e)).toMatchObject({ vision: 'unknown', visionModel: null });
    // 새 모델의 키를 가진 다른 메인 토큰이 새 확인을 받아 두었어도(메인 턴은 한 번에 하나라 실제로는 드문 경우 — 처리기를 그 신원으로 직접 부른다), 옛 턴은 그 숫자를
    // 알아도 답하지 못한다 — 답도 부른 턴의 모델 키를 본다 (settleVision도 확인의 모델과 견준다)
    const fetchedForNew = await e.core.tools.handle({ ...e.identity(oldTurn), modelKey: newKey }, 'get_screen_check', {});
    const newCode = readScreenCheckDigits(Buffer.from(fetchedForNew.ok ? fetchedForNew.images![0]!.data : '', 'base64'))!;
    expect(newCode).toMatch(/^\d{4}$/);
    expect(await e.tool(oldTurn, 'answer_screen_check', { code: newCode, request_id: 'rq-g-old-2' })).toMatchObject({ ok: false, code: 'conflict' });
    expect(seat(e)).toMatchObject({ vision: 'unknown', visionModel: null });
    // 옛 턴이 답 없이 정상으로 끝나도 새 모델이 failed가 되지 않는다 — 그 턴이 실은 확인 업무는 옛 모델의 것이다. (새 확인 턴이 곧바로 끝나지 않게 잡아 둔 채 끝낸다)
    e.procs.find((p) => p.turnId === oldTurn)!.finishOk('끝');
    await waitFor(() => !!e.ctx.store.turns.get(oldTurn)?.endedAt && e.liveProc(MAIN_KEY, MAIN_AGENT_ID)?.turnId !== oldTurn, '옛 턴 끝');
    expect(seat(e)).toMatchObject({ vision: 'unknown', visionModel: null });

    // 새 모델의 확인은 새 모델로 뜬 턴이 받고 답한다
    const newTurn = await checkTurn(e);
    expect(newTurn).not.toBe(oldTurn);
    expect(e.launches.find((l) => l.turnId === newTurn)?.model).toBe('haiku');
    expect(e.identity(newTurn).modelKey).toBe(newKey);
    const gotNew = await e.tool(newTurn, 'get_screen_check', {});
    const code = readScreenCheckDigits(Buffer.from(gotNew.ok ? gotNew.images![0]!.data : '', 'base64'))!;
    expect(await e.tool(newTurn, 'answer_screen_check', { code, request_id: 'rq-g-new' })).toMatchObject({ ok: true, data: { result: 'verified' } });
    expect(seat(e)).toMatchObject({ vision: 'verified', visionModel: newKey });
    await endTurn(e, newTurn);
  });

  it('확인 턴이 비정상으로 끝나면 다시 넣고 그대로 unknown, 세대가 바뀐 확인 업무는 끝난 업무로 지운다', async () => {
    const g = await bootGui({}, { vision: 'failed' });
    open.push(g);
    const { e } = g;
    await changeModel(e, 'haiku');
    const turnId = await checkTurn(e);
    e.hold.delete(MAIN_KEY);
    e.procs.find((p) => p.turnId === turnId)!.exit(1);
    await e.idle();
    expect(seat(e).vision).toBe('unknown');
    const requeued = checks(e).filter((q) => q.state === 'queued');
    expect(requeued.map((q) => q.attempts)).toEqual([1]);
    // 교체로 세대가 바뀌면 그 확인 업무는 끝난 업무다 — 새 확인이 따로 들어간다
    await e.core.seat.assign({ holder: { kind: 'launched', ai: { kind: 'codex', model: null, effortTier: 'high', effortOverride: null } }, by: 'operator', reason: 'Codex로', force: true }).done;
    e.tick();
    await e.idle();
    const old = e.ctx.store.queue.get(requeued[0]!.id)!;
    expect(old.state).not.toBe('queued');
  });

  it('화면 도우미가 없으면 확인 업무를 넣지 않고, 화면 도구는 unavailable이다', async () => {
    const e = await bootOrch();
    try {
      expect(checks(e)).toEqual([]);
      e.hold.add(MAIN_KEY);
      await e.invoke('command.send', { target: 'main', text: '화면' });
      e.tick();
      await waitFor(() => !!e.liveProc(MAIN_KEY, MAIN_AGENT_ID), '메인 턴');
      const turnId = e.liveProc(MAIN_KEY, MAIN_AGENT_ID)!.turnId;
      for (const tool of ['screen_capture', 'screen_info', 'get_screen_check']) expect(await e.tool(turnId, tool, {}), tool).toMatchObject({ ok: false, code: 'unavailable' });
      expect(await e.tool(turnId, 'gui_input', { action: 'release', request_id: 'rq-x' })).toMatchObject({ ok: false, code: 'unavailable' });
    } finally {
      await e.close();
    }
  });

  it('시험 이미지: 네 자리를 그린 회색 PNG(메타데이터 없음) — 흔들어도 읽힌다', () => {
    for (const [code, jitter] of [
      ['0123', [[-4, -4], [4, 4], [-4, 4], [4, -4]]],
      ['4567', [[0, 0], [0, 0], [0, 0], [0, 0]]],
      ['8901', [[3, -2], [-1, 4], [2, 2], [-4, -3]]],
    ] as [string, [number, number][]][]) {
      const png = screenCheckImage(code, jitter);
      expect(readScreenCheckDigits(png)).toBe(code);
      expect(png.includes(Buffer.from(code, 'ascii'))).toBe(false);
      expect(png.includes(Buffer.from('tEXt', 'ascii'))).toBe(false);
    }
  });
});

describe('화면 보기 확인 — 끝에서 끝까지 (실제 앱 도구 서버와 모의 보유자)', () => {
  for (const [mode, expected] of [
    ['see', 'verified'],
    ['blind', 'failed'],
  ] as const) {
    it(`모의 보유자(${mode})가 시험 이미지를 받아 답하면 ${expected} — 이벤트 파일에 이미지 바이트가 없다`, async () => {
      const prev = process.env.WOOK_MOCK_VISION;
      process.env.WOOK_MOCK_VISION = mode;
      const fake = createFakeDesktop({});
      const app = await bootApp({ desktop: { launcher: fake.launcher } });
      try {
        await accWaitFor(() => app.ctx.store.seat.require('main').vision !== 'unknown', '화면 확인', 60_000);
        await accWaitFor(() => app.core.turns.count() === 0, '턴 종료', 30_000);
        expect(app.ctx.store.seat.require('main').vision).toBe(expected);
        const mainTurns = app.ctx.store.turns.list({ ref1: MAIN_AGENT_ID });
        const t = mainTurns.find((x) => x.queueEntryIds.some((id) => app.ctx.store.queue.get(id)?.kind === 'screen_check'))!;
        expect(t.endReason).toBe('completed');
        // 메인 턴은 모두 모의 보유자로 떴다 — 실제 CLI를 띄우지 않았다
        expect(app.launches.filter((l) => l.memberId === MAIN_AGENT_ID)).toHaveLength(mainTurns.length);
        const events = readdirSync(app.ctx.paths.events, { recursive: true }).filter((f) => String(f).endsWith('.jsonl'));
        const text = events.map((f) => readFileSync(join(app.ctx.paths.events, String(f)), 'utf8')).join('\n');
        expect(text).toContain('get_screen_check');
        expect(text).toContain('바이트 — 저장하지 않음]');
        expect(scanFiles(app.ctx.paths.events, ['iVBORw0KGgo'])).toEqual([]);
      } finally {
        if (prev === undefined) delete process.env.WOOK_MOCK_VISION;
        else process.env.WOOK_MOCK_VISION = prev;
        await app.close();
        await fake.cleanup();
      }
    }, 120_000);
  }
});
