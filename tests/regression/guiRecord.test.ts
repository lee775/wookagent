/**
 * 화면 조작 기록과 캡처 보관 (SERVER_DESIGN 8.3.5 '기록'·'캡처 보관', 리드 결정 S6-7 — 10.6 guiRecord). 가짜 도우미만 쓴다 (S6-15).
 * - 처리기에 닿은 모든 시도가 gui_actions에 한 줄씩 남는다(거부·입력·캡처·뒤 캡처) — 입력 줄은 뒤 캡처를 가리킨다
 * - 턴 끝에 활동 기록 한 줄(kind screen, '화면 조작 n회: 메모장 (캡처 m장, 거부 k회)' — 프로그램 이름만)과 메인 일지 action 한 줄
 * - 앱 도구 서버의 기록(onCall): 성공한 screen_capture·gui_input·screen_info와 처리기에 닿은 거부는 app_tool 줄을 남기지 않는다 — 처리기에 닿지 않은 거부(입력
 *   모양·역할 밖)는 남긴다. 결과는 글 블록 뒤에 이미지 블록
 * - 정리: 24시간(mtime)·최근 500장·1시간 지난 .tmp, 이 폴더의 이름이 맞는 파일만(하위 폴더·다른 파일은 두고). 캡처를 쓸 때마다 돈다. git 제외 줄
 * - PNG 바이트·base64는 DB(도구 중복 캐시 포함)·CLI 이벤트 파일·백업·내보내기에 없다 — Claude가 캡처 파일을 Read로 연 줄의 두 사본도. 이미지 빼기는 모양이
 *   아니라 내용(이미지 서명)으로 한다 (리드 결정 S6-21 C1)
 * - 고침 1차 (S6-21): 도우미가 답한 sha256이 틀리면 캡처를 거부하고 파일을 지운다(J3), 처리기에 닿아 거부된 screen_capture도 app_tool 줄이 없다(E1),
 *   onCall 시험은 프로젝트를 만들어 역할 밖 거부를 실제로 부른다(J4)
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID } from '@shared/domain';
import type { WookTopics } from '@shared/ipc';
import { stripImages } from '@core/imageStrip';
import { createClaudeParser } from '../../src/main/agents/parsers/claudeParser';
import { ScreenStore, SCREEN_KEEP_COUNT } from '../../src/main/desktop/screenStore';
import { GuiRecords } from '../../src/main/desktop/guiRecords';
import { createFakeDesktop, killFakePids } from '../fixtures/desktop/fakeDesktop';
import { addProject, bootApp, callTool, mainToken, scanFiles, tokenFor, type App } from '../acceptance/security-helpers';
import { bootGui, capture, input, liveMain, MAIN_KEY, ok, type GuiEnv } from './guiRig';
import { sleep, waitFor } from './orchHarness';

const open: GuiEnv[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const g of open.splice(0)) await g.close();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** PNG 서명의 base64 머리 ('\x89PNG\r\n\x1a\n' → iVBORw0KGgo) */
const PNG_B64 = 'iVBORw0KGgo';
const PNG_BYTES = '\x89PNG';

const READ_TOOL_ID = 'toolu_01ReadCapture0000000000000';

/**
 * Claude Code가 이미지 파일을 Read로 열 때 내는 두 줄 (assistant의 tool_use, user의 tool_result) — 실제 Claude Code 2.1.x 스트림의 모양이다: 이미지가 그 줄에 두 번
 * 실린다 (message.content[].content[]의 이미지 블록과 tool_use_result.file.base64). 화면 안전 검토가 이 PC의 세션 기록에서 확인한 구조 (리드 결정 S6-21 C1)
 */
function claudeReadImageLines(file: string, b64: string): string[] {
  const base = { parent_tool_use_id: null, session_id: '09103c54-7b9c-4740-8d7d-000000000000' };
  return [
    JSON.stringify({ type: 'assistant', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude', content: [{ type: 'tool_use', id: READ_TOOL_ID, name: 'Read', input: { file_path: file } }] }, ...base, uuid: 'u1' }),
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ tool_use_id: READ_TOOL_ID, type: 'tool_result', content: [{ type: 'image', source: { type: 'base64', data: b64, media_type: 'image/png' } }] }] },
      ...base,
      uuid: 'u2',
      tool_use_result: { type: 'image', file: { base64: b64, type: 'image/png', originalSize: Math.floor((b64.length * 3) / 4), dimensions: { originalWidth: 1280, originalHeight: 720, displayWidth: 1280, displayHeight: 720 } } },
    }),
  ];
}

function dbText(db: { prepare(sql: string): { all(): unknown[] } }): string {
  const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]).map((t) => t.name);
  return tables.map((t) => JSON.stringify(db.prepare(`SELECT * FROM "${t}"`).all())).join('\n');
}

describe('gui_actions 기록과 턴 한 줄 (S6-7)', () => {
  it('모든 시도가 한 줄씩 남고, 턴 끝에 활동 기록·일지 한 줄로 묶인다 — 이미지 바이트는 DB·캐시·이벤트·백업·내보내기에 없다', async () => {
    const g = await bootGui();
    open.push(g);
    const { e } = g;
    const ctx = e.ctx;
    const pushed: WookTopics['cliEvents'][] = [];
    const off = e.orch.backend.onTopic('cliEvents', (c) => pushed.push(c));
    const turnId = await liveMain(e);
    const first = await capture(e, turnId);
    expect(first.r.ok && first.r.images?.length).toBe(1);
    // 거부 셋 (모양·오래된 캡처는 뒤에·비밀 값)
    expect(await input(e, turnId, { action: 'click', x: 1, y: 1 })).toMatchObject({ ok: false, code: 'invalid' });
    expect(await input(e, turnId, { action: 'type', capture_id: first.data.capture_id, text: `키 sk-ant-api03-${'Q'.repeat(40)}` })).toMatchObject({ ok: false, code: 'secret_blocked' });
    // 입력 둘 — 클릭은 then_capture(기본 켬)로 뒤 캡처를 함께
    const click = await e.tool(turnId, 'gui_input', { action: 'click', capture_id: first.data.capture_id, x: 40, y: 30, request_id: 'rq-rec-click' });
    const clicked = ok<{ after: { capture_id: string; image: string } | null; after_note: string | null }>(click);
    expect(clicked.after?.image).toBe('attached');
    expect(click.ok && click.images?.length).toBe(1);
    expect((await input(e, turnId, { action: 'type', capture_id: first.data.capture_id, text: '안녕하세요' })).ok).toBe(true);
    g.clock.advance(31_000);
    expect(await input(e, turnId, { action: 'move', capture_id: first.data.capture_id, x: 1, y: 1 })).toMatchObject({ ok: false, code: 'stale_capture' });

    const rows = ctx.store.guiActions.query({ turnId, asc: true });
    expect(rows.map((r) => [r.action, r.result, r.capture?.cause ?? null])).toEqual([
      ['capture', 'ok', 'capture'],
      ['click', 'invalid', null],
      ['type', 'secret_blocked', null],
      ['click', 'ok', null],
      ['capture', 'ok', 'after_input'],
      ['type', 'ok', null],
      ['move', 'stale_capture', null],
    ]);
    const clickRow = rows[3]!;
    expect([clickRow.id.startsWith('GA-'), clickRow.beforeCaptureId, clickRow.afterCaptureId, clickRow.focus?.app, clickRow.holderLabel]).toEqual([true, first.data.capture_id, clicked.after!.capture_id, 'notepad', 'Claude CLI']);
    expect(rows[0]!.capture).toMatchObject({ id: first.data.capture_id, width: first.data.width, sha256: expect.stringMatching(/^[0-9a-f]{64}$/), image: 'attached' });

    // CLI가 도구 결과(이미지 포함)를 이벤트로 낸다 — 이벤트 파일·화면 푸시에 바이트가 남지 않는다
    const imageB64 = click.ok ? click.images![0]!.data : '';
    const proc = e.liveProc(MAIN_KEY, MAIN_AGENT_ID)!;
    proc.emit({ kind: 'mcp_call', text: 'gui_input', data: {}, raw: { type: 'user', message: { content: [{ type: 'tool_result', content: [{ type: 'text', text: '{}' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageB64 } }] }] } } });
    proc.emit({ kind: 'mcp_call', text: 'screen_capture', data: {}, raw: { type: 'item.completed', item: { type: 'mcp_tool_call', result: { content: [{ type: 'image', data: imageB64, mimeType: 'image/png' }] } } } });
    // Claude가 캡처 파일을 Read로 열 때의 실제 줄 (S6-6의 대체 길) — 같은 이미지가 그 줄에 두 번 온다: 도구 결과의 이미지 블록과 tool_use_result.file.base64.
    // 실제 Claude 파서로 읽어 흘린다 — 도구 결과 이벤트의 raw는 줄 전체다 (리드 결정 S6-21 C1)
    const fileB64 = readFileSync(first.data.file).toString('base64');
    expect(fileB64.startsWith(PNG_B64)).toBe(true);
    const parser = createClaudeParser({ serverName: 'wook' });
    const readEvents = claudeReadImageLines(first.data.file, fileB64).flatMap((l) => parser.pushLine(l));
    expect(JSON.stringify(readEvents).split(PNG_B64).length - 1).toBeGreaterThanOrEqual(2);
    for (const ev of readEvents) proc.emit(ev);
    proc.finishOk('화면 조작 끝');
    await e.idle();
    off();
    // 화면 푸시(cliEvents)에도 바이트가 없다 — 그 줄은 갔다
    const pushedText = JSON.stringify(pushed.filter((p) => p.turnId === turnId));
    expect([pushedText.includes(READ_TOOL_ID), pushedText.includes(PNG_B64), pushedText.includes(fileB64.slice(100, 300))]).toEqual([true, false, false]);

    // 턴 한 줄 — 프로그램 이름만 (창 제목 '제목 없음 - 메모장'은 쓰지 않는다)
    const line = ctx.store.activity.search({ turnId, kinds: ['screen'], level: 'info', limit: 10 });
    expect(line.map((x) => x.text)).toEqual(['화면 조작 2회: 메모장 (캡처 2장, 거부 3회)']);
    expect(ctx.store.journal.query({ turnId, kinds: ['action'] }).map((j) => j.text)).toEqual(['화면 조작 2회: 메모장 (캡처 2장, 거부 3회)']);
    expect(line[0]!.text).not.toContain('제목 없음');

    // 이미지 바이트는 어디에도 — DB(도구 중복 캐시 kv 포함), 이벤트 파일, 백업, 내보내기
    expect(ctx.store.kv.get<{ data: unknown }>(`toolreq:${MAIN_AGENT_ID}:g1:gui_input:rq-rec-click`)?.data).toMatchObject({ after: { capture_id: clicked.after!.capture_id } });
    const db = dbText(ctx.store.db);
    expect([db.includes(PNG_B64), db.includes(imageB64.slice(0, 200)), db.includes(PNG_BYTES)]).toEqual([false, false, false]);
    expect(scanFiles(ctx.paths.events, [PNG_B64, imageB64.slice(100, 300), fileB64.slice(100, 300)])).toEqual([]);
    expect(scanFiles(ctx.paths.events, [READ_TOOL_ID]).length).toBeGreaterThan(0);
    expect(readdirSync(ctx.paths.events, { recursive: true }).some((f) => String(f).endsWith('.jsonl'))).toBe(true);
    const events = readdirSync(ctx.paths.events, { recursive: true })
      .filter((f) => String(f).endsWith('.jsonl'))
      .map((f) => readFileSync(join(ctx.paths.events, String(f)), 'utf8'))
      .join('\n');
    expect(events).toContain('바이트 — 저장하지 않음]');
    const bak = await e.internal('system.backupNow');
    expect(scanFiles(bak.path, [PNG_B64, PNG_BYTES])).toEqual([]);
    const exp = await e.invoke('logs.export', {});
    expect(readFileSync(exp.path, 'utf8')).not.toContain(PNG_B64);
    // 캡처 파일은 화면 폴더에만 있다
    expect(existsSync(join(e.core.desktop.store.dir(), `${first.data.capture_id}.png`))).toBe(true);
  });

  it('중복 request_id는 다시 입력하지 않는다 — 도구 중복 캐시가 지워져도(재시작·7일) 기록으로 막고, 같은 요청에는 이미지가 붙지 않는다 (AC-45)', async () => {
    const g = await bootGui();
    open.push(g);
    const { e } = g;
    const turnId = await liveMain(e);
    const c = await capture(e, turnId);
    const args = { action: 'click', capture_id: c.data.capture_id, x: 5, y: 5, request_id: 'rq-dup-1' };
    const first = await e.tool(turnId, 'gui_input', args);
    expect(first.ok && first.images?.length).toBe(1);
    const again = await e.tool(turnId, 'gui_input', args);
    expect(again).toMatchObject({ ok: true, data: { duplicateRequest: true } });
    expect(again.ok && again.images).toBeUndefined();
    // 캐시를 지워도 (서버 재시작으로 끊긴 요청과 같은 처지)
    e.ctx.store.db.prepare(`DELETE FROM kv WHERE key LIKE 'toolreq:%'`).run();
    const third = await e.tool(turnId, 'gui_input', args);
    expect(third).toMatchObject({ ok: true, data: { duplicateRequest: true, after: null } });
    expect(g.fake.received().filter((l) => / CLICK /.test(` ${l.replace(/^\d+ /, '')}`)).length).toBe(1);
  });
});

describe('캡처 크기·검은 화면·입력 모양 (S6-6)', () => {
  it('4MiB를 넘으면 0.7배로 한 번 다시 찍고(앞 파일은 지움), 그래도 크면 이미지 없이 파일만(too_large) — 모두 검은 캡처는 거부하지 않고 알린다', async () => {
    const big = 4 * 1024 * 1024 + 4096;
    const g = await bootGui({ png: { mode: 'grey', padAboveEdge: { edge: 1000, bytes: big } } });
    open.push(g);
    const { e } = g;
    const turnId = await liveMain(e);
    const retaken = await capture(e, turnId);
    // 1280 → 0.7배 = 896 (1000 아래라 부풀리지 않는다)
    expect([retaken.data.width, retaken.data.image, retaken.r.ok && retaken.r.images?.length]).toEqual([896, 'attached', 1]);
    const files = readdirSync(e.core.desktop.store.dir()).filter((n) => n.startsWith('SC-'));
    expect(files).toEqual([`${retaken.data.capture_id}.png`]);
    const huge = await capture(e, turnId, { max_width: 1568 });
    // 1568 → 1098 — 여전히 1000보다 커 부풀려진다
    expect([huge.data.image, huge.r.ok && huge.r.images]).toEqual(['too_large', undefined]);
    expect(huge.data.note).toContain('너무 커 붙이지 않았습니다');
    expect(existsSync(huge.data.file)).toBe(true);
    expect(e.ctx.store.guiActions.byCapture(huge.data.capture_id)!.capture).toMatchObject({ image: 'too_large', bytes: expect.any(Number) });
  });

  it('도우미가 답한 sha256이 쓴 파일과 다르면 캡처를 거부하고 그 파일을 지운다 — 서버가 파일을 다시 해시한다 (S6-5, S6-21 J3)', async () => {
    const g = await bootGui({ wrongSha256: true });
    open.push(g);
    const { e } = g;
    const turnId = await liveMain(e);
    const bad = await e.tool(turnId, 'screen_capture', {});
    expect(bad).toMatchObject({ ok: false, code: 'error' });
    if (!bad.ok) expect(bad.message).toContain('해시가 도우미의 답과 다릅니다');
    // 도우미는 파일을 썼다 (CAPTURE에 OK로 답했다) — 서버가 지웠다
    expect(g.fake.log().some((x) => x.dir === 'out' && /^\d+ OK \d+ \d+ /.test(x.line))).toBe(true);
    expect(readdirSync(e.core.desktop.store.dir()).filter((n) => n.startsWith('SC-'))).toEqual([]);
    expect(e.ctx.store.guiActions.query({ turnId, asc: true }).map((r) => [r.action, r.result, r.capture])).toEqual([['capture', 'error', null]]);
    // 해시가 맞으면 그대로 받는다 (같은 도우미, 답만 고침)
    g.fake.act({ do: 'set', value: { wrongSha256: false } });
    await sleep(150);
    const good = await capture(e, turnId);
    expect(readdirSync(e.core.desktop.store.dir()).filter((n) => n.startsWith('SC-'))).toEqual([`${good.data.capture_id}.png`]);
  });

  it('모두 검은 캡처는 결과의 note로 알린다', async () => {
    const g = await bootGui({ png: { mode: 'black' } });
    open.push(g);
    const turnId = await liveMain(g.e);
    const c = await capture(g.e, turnId);
    expect([c.data.image, c.data.note]).toEqual(['attached', expect.stringContaining('캡처가 모두 검습니다')]);
  });

  it('type은 코드 포인트 2,000자까지 — 넘으면 invalid(도우미에 가지 않음), 동작에 맞지 않는 인자도 invalid', async () => {
    const g = await bootGui();
    open.push(g);
    const turnId = await liveMain(g.e);
    const c = await capture(g.e, turnId);
    // 이모지는 UTF-16으로 2단위 — 코드 포인트로 센다
    expect((await input(g.e, turnId, { action: 'type', capture_id: c.data.capture_id, text: '😀'.repeat(2000) })).ok).toBe(true);
    expect(await input(g.e, turnId, { action: 'type', capture_id: c.data.capture_id, text: `${'😀'.repeat(2000)}a` })).toMatchObject({ ok: false, code: 'invalid' });
    expect(await input(g.e, turnId, { action: 'click', capture_id: c.data.capture_id, x: 1, y: 1, text: 'x' })).toMatchObject({ ok: false, code: 'invalid' });
    expect(await input(g.e, turnId, { action: 'scroll', capture_id: c.data.capture_id, x: 1, y: 1 })).toMatchObject({ ok: false, code: 'invalid' });
    expect(await input(g.e, turnId, { action: 'key', capture_id: c.data.capture_id, keys: 'ctrl + s' })).toMatchObject({ ok: false, code: 'invalid' });
    expect(g.fake.typed()).toEqual(['😀'.repeat(2000)]);
    const rows = g.e.ctx.store.guiActions.query({ turnId, actions: ['type'], asc: true });
    expect(rows.map((r) => [r.result, r.textLength])).toEqual([
      ['ok', 2000],
      ['invalid', 2001],
    ]);
  });
});

describe('캡처 보관 정리 (24시간·최근 500장 — S6-7)', () => {
  it('이 폴더의 이름이 맞는 파일만: 24시간 지난 캡처·시험 이미지, 500장 넘는 오래된 캡처, 1시간 지난 .tmp를 지우고 나머지(다른 파일·하위 폴더·새 .tmp)는 둔다', () => {
    const work = mkdtempSync(join(tmpdir(), 'wook-test-sweep-'));
    dirs.push(work);
    mkdirSync(join(work, '.git', 'info'), { recursive: true });
    const now = Date.now();
    const store = new ScreenStore(() => work, () => now, () => undefined);
    const dir = store.ensure();
    const at = (name: string, ageMs: number): void => {
      writeFileSync(join(dir, name), 'x');
      const t = new Date(now - ageMs);
      utimesSync(join(dir, name), t, t);
    };
    for (let i = 1; i <= 505; i++) at(`SC-${String(i).padStart(6, '0')}.png`, i <= 3 ? 25 * 3600_000 : 60_000);
    at('check-0123abcd.png', 25 * 3600_000);
    at('check-89abcdef.png', 60_000);
    at('SC-000900.png.tmp', 2 * 3600_000);
    at('SC-000901.png.tmp', 10 * 60_000);
    at('notes.txt', 30 * 24 * 3600_000);
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'SC-000001.png'), 'x');
    utimesSync(join(dir, 'sub', 'SC-000001.png'), new Date(now - 48 * 3600_000), new Date(now - 48 * 3600_000));

    // 3 (24시간) + 1 (시험 이미지 24시간) + 2 (502 → 500) + 1 (.tmp 1시간)
    expect(store.sweep()).toBe(7);
    const left = readdirSync(dir);
    const caps = left.filter((n) => /^SC-\d+\.png$/.test(n)).sort();
    expect([caps.length, caps[0], caps.at(-1)]).toEqual([SCREEN_KEEP_COUNT, 'SC-000006.png', 'SC-000505.png']);
    expect(left.filter((n) => !/^SC-\d+\.png$/.test(n)).sort()).toEqual(['SC-000901.png.tmp', 'check-89abcdef.png', 'notes.txt', 'sub']);
    expect(existsSync(join(dir, 'sub', 'SC-000001.png'))).toBe(true);
    // 메인 작업 폴더가 git 저장소면 screens/는 git에서 뺀다 (한 줄, 두 번 넣지 않음)
    store.ensure();
    expect(readFileSync(join(work, '.git', 'info', 'exclude'), 'utf8').match(/^\/screens\/$/gm)).toHaveLength(1);
  });

  it('캡처를 쓸 때마다 정리한다 — 24시간 지난 캡처는 다음 캡처에서 지워지고, 기록에는 해시만 남는다', async () => {
    const g = await bootGui();
    open.push(g);
    const { e } = g;
    const turnId = await liveMain(e);
    const old = await capture(e, turnId);
    const file = join(e.core.desktop.store.dir(), `${old.data.capture_id}.png`);
    const t = new Date(Date.now() - 25 * 3600_000);
    utimesSync(file, t, t);
    await capture(e, turnId);
    expect(existsSync(file)).toBe(false);
    const row = e.ctx.store.guiActions.byCapture(old.data.capture_id)!;
    expect(row.capture!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(e.core.desktop.store.kept(old.data.capture_id, row.capture!.sha256)).toBe(false);
  });

  it('이미지 빼기: MCP·Claude 이미지 블록과 data: 주소의 바이트를 빼고, 바꿀 것이 없으면 같은 값', () => {
    const b64 = Buffer.alloc(3000, 7).toString('base64');
    const v = { a: [{ type: 'image', data: b64, mimeType: 'image/png' }, { type: 'image', source: { type: 'base64', data: b64 } }], s: `x data:image/png;base64,${b64} y`, n: 1 };
    const out = JSON.stringify(stripImages(v));
    expect(out).not.toContain(b64.slice(0, 40));
    expect(out.match(/\[이미지 3,000바이트 — 저장하지 않음\]/g)).toHaveLength(3);
    const plain = { kind: 'text', text: '그대로', raw: { a: [1, 2] } };
    expect(stripImages(plain)).toBe(plain);
  });

  it('이미지 빼기는 모양이 아니라 내용으로 한다 (S6-21 C1): Claude Read 줄의 두 사본, 이미지 개체의 file.base64·base64·image_url, 어디든 이미지 서명으로 시작하는 긴 base64', () => {
    // 실제 PNG의 머리 (서명 8바이트 + 첫 덩이 IHDR의 길이·이름 — base64로 iVBORw0KGgoAAAANSUhEUg)로 시작하는 바이트 (뒤는 아무 값)
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]), Buffer.alloc(2984, 0x5a)]);
    const b64 = png.toString('base64');
    expect(b64.startsWith(PNG_B64)).toBe(true);
    const mark = b64.slice(60, 160);
    // (1) Claude가 캡처 파일을 Read로 연 줄 — 두 사본 모두
    const line = JSON.parse(claudeReadImageLines('C:/work/screens/SC-000001.png', b64)[1]!) as Record<string, unknown>;
    const stripped = JSON.stringify(stripImages({ kind: 'tool_result', raw: line }));
    expect([stripped.includes(mark), stripped.includes(PNG_B64), stripped.match(/\[이미지 3,000바이트 — 저장하지 않음\]/g)?.length]).toEqual([false, false, 2]);
    // 바이트가 아닌 칸은 그대로다
    expect(stripped).toContain('"originalSize":3000');
    expect(stripped).toContain(READ_TOOL_ID);
    // (2) 이미지 개체의 다른 칸들 — 서명이 없어도(다른 형식의 이미지) type이 image면 뺀다
    const other = Buffer.alloc(900, 3).toString('base64');
    const blocks = {
      a: { type: 'image', base64: other },
      b: { type: 'image', file: { base64: other, type: 'image/bmp' } },
      c: { type: 'image', image_url: other },
      d: { type: 'input_image', image_url: `data:image/bmp;base64,${other}` },
      // 주소는 바이트가 아니다 — 그대로
      e: { type: 'image', image_url: 'https://example.invalid/shot.png' },
      f: { type: 'text', base64: other },
    };
    const outBlocks = stripImages(blocks) as Record<string, Record<string, unknown>>;
    expect(JSON.stringify([outBlocks.a, outBlocks.b, outBlocks.c, outBlocks.d]).includes(other.slice(0, 60))).toBe(false);
    expect(JSON.stringify([outBlocks.a, outBlocks.b, outBlocks.c, outBlocks.d]).match(/\[이미지 900바이트 — 저장하지 않음\]/g)).toHaveLength(4);
    expect([outBlocks.e, outBlocks.f]).toEqual([blocks.e, blocks.f]);
    // (3) 모양을 모르는 곳의 이미지: 서명으로 시작하는 긴 base64는 어디에 있든, 글 안에 박혀 있어도 뺀다 — PNG·JPEG·GIF·WebP
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(596, 0x11)]).toString('base64');
    const gif = Buffer.concat([Buffer.from('GIF89a', 'ascii'), Buffer.alloc(594, 0x22)]).toString('base64');
    const webp = Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.alloc(596, 0x33)]).toString('base64');
    expect([jpeg.startsWith('/9j/'), gif.startsWith('R0lGOD'), webp.startsWith('UklGR')]).toEqual([true, true, true]);
    const unknown = {
      view_image: { result: { bytes: b64 } },
      nested: [[{ deep: { payload: jpeg } }]],
      text: `도구 결과: {"image":"${gif}","ok":true} 끝`,
      escaped: JSON.stringify({ inner: JSON.stringify({ picture: webp }) }),
    };
    const outUnknown = JSON.stringify(stripImages(unknown));
    for (const s of [mark, jpeg.slice(20, 120), gif.slice(20, 120), webp.slice(20, 120)]) expect(outUnknown.includes(s)).toBe(false);
    expect(outUnknown.match(/바이트 — 저장하지 않음\]/g)).toHaveLength(4);
    expect(outUnknown).toContain('도구 결과: {\\"image\\":\\"[이미지 600바이트 — 저장하지 않음]\\",\\"ok\\":true} 끝');
    // JSON을 글로 한 번 더 넣으며 줄바꿈을 \n(역빗금과 n)으로 쓴 글 — 서명 앞 글자가 n이어도 그 앞이 역빗금이면 뺀다
    expect((stripImages({ s: `{"log":"done\\n${gif}"}` }) as { s: string }).s).toBe(`{"log":"done\\n[이미지 600바이트 — 저장하지 않음]"}`);
    // (4) 건드리지 않는 것: 짧은 글, 서명이 가운데에 든 다른 base64, 서명으로 시작하지만 base64가 아닌 글
    const middle = `${Buffer.alloc(300, 9).toString('base64')}${PNG_B64}${Buffer.alloc(300, 9).toString('base64')}`;
    const keep = { short: `${PNG_B64}AAAA`, middle, path: `/9j/${'가나다 '.repeat(100)}`, word: 'UklGR 로 시작하는 보통 글 '.repeat(20) };
    expect(stripImages(keep)).toBe(keep);
  });
});

describe('앱 도구 서버의 화면 도구 기록 — 실제 HTTP (onCall, S6-7)', () => {
  it('성공과 처리기에 닿은 거부는 app_tool 줄이 없고, 입력 모양 거부·역할 밖은 남는다. 결과는 글 블록 뒤에 PNG 이미지 블록', async () => {
    const fake = createFakeDesktop({});
    const app: App = await bootApp({ stopScheduler: true, desktop: { launcher: fake.launcher } });
    const extra: string[] = [];
    try {
      // 시작 때 뜬 화면 확인 턴(모의 보유자)이 끝난 뒤에 — 그 턴이 이 시험의 호출 사이에 끝나면, 이 시험이 무장한 도우미를 턴 끝이 놓으며 서버 줄(release)을
      // 하나 더 남긴다 (리드 결정 S6-20 9)
      await waitFor(() => app.ctx.store.seat.require('main').vision !== 'unknown' && app.core.turns.count() === 0, '화면 확인 턴', 60_000);
      const token = mainToken(app, null);
      const url = app.core.toolServer.url!;
      const raw = async (name: string, args: Record<string, unknown>) => {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
        });
        return ((await res.json()) as { result: { content: { type: string; text?: string; data?: string; mimeType?: string }[]; isError?: boolean } }).result;
      };
      const shot = await raw('screen_capture', {});
      expect(shot.content.map((b) => [b.type, b.mimeType ?? null])).toEqual([
        ['text', null],
        ['image', 'image/png'],
      ]);
      expect(Buffer.from(shot.content[1]!.data!, 'base64').subarray(1, 4).toString('ascii')).toBe('PNG');
      const id = (JSON.parse(shot.content[0]!.text!) as { capture_id: string }).capture_id;
      expect((await callTool(app, token, 'screen_info', {})).ok).toBe(true);
      expect((await callTool(app, token, 'gui_input', { action: 'click', capture_id: id, x: 3, y: 3, request_id: 'rq-oncall-1', then_capture: false })).ok).toBe(true);
      // 처리기에 닿은 거부 (모르는 캡처) — 기록 줄은 있고 app_tool 줄은 없다
      expect((await callTool(app, token, 'gui_input', { action: 'click', capture_id: 'SC-999999', x: 3, y: 3, request_id: 'rq-oncall-2' })).code).toBe('invalid');
      // 입력 모양 거부 (request_id 없음 — 처리기에 닿지 않는다)와 역할 밖 (프로듀서의 토큰 — 화면 도구는 메인만 쓴다)
      expect((await callTool(app, token, 'gui_input', { action: 'click', capture_id: id, x: 3, y: 3 })).code).toBe('invalid');
      const project = await addProject(app, { name: '화면 도구 역할 시험' });
      extra.push(project.root);
      const producer = app.ctx.store.members.require(project.producerId);
      expect(producer.isMain).toBe(false);
      expect((await callTool(app, tokenFor(app, producer.id, `directive:D-0001`), 'screen_capture', {})).code).toBe('forbidden');
      // 처리기에 닿아 거부된 screen_capture (그사이 화면이 잠겼다) — 기록 줄은 있고 app_tool 줄은 없다. 처리기가 받는 것은 가린 사본이라, 닿았다는 표시는 앱 도구
      // 서버가 기록에도 넘기는 원래 인자 개체에 해야 한다 (리드 결정 S6-21 E1)
      fake.act({ do: 'set', value: { lock: 'locked' } });
      await sleep(150);
      expect((await callTool(app, token, 'screen_capture', {})).code).toBe('unavailable');
      fake.act({ do: 'set', value: { lock: null } });
      // 기록(gui_actions)이 대신하는 세 도구만 본다 — 시작 때 뜬 화면 확인 턴(모의 보유자)의 get_screen_check·answer_screen_check는 예전처럼 app_tool 줄을 남긴다
      const rows = app.ctx.store.activity.search({ kinds: ['app_tool'], limit: 100 }).filter((x) => /^(screen_capture|screen_info|gui_input)( |$)/.test(x.text));
      expect(rows.map((x) => x.text).sort()).toEqual(['gui_input 거부', 'screen_capture 거부']);
      // 남은 screen_capture 거부 줄은 프로듀서의 것 하나뿐이다 (메인의 잠김 거부가 아니다)
      expect(rows.filter((x) => x.text === 'screen_capture 거부').map((x) => x.memberId)).toEqual([producer.id]);
      expect(app.ctx.store.guiActions.query({ asc: true }).map((r) => [r.action, r.result])).toEqual([
        ['capture', 'ok'],
        ['click', 'ok'],
        ['click', 'invalid'],
        ['capture', 'unavailable'],
      ]);
      // 기록(onCall)에 이미지가 닿지 않았다 — 활동 기록에도
      expect(dbText(app.ctx.store.db)).not.toContain(PNG_B64);
    } finally {
      await app.close(extra);
      await fake.cleanup();
    }
  });

  it('bootApp의 확인: 화면 도우미를 붙인 실행에 모의 실행이 아닌 메인 턴이 하나라도 있으면 close()가 던진다 — 실제 CLI는 띄우지 않고 그런 턴의 기록만 넣어 본다 (S6-19, S6-21 J4)', async () => {
    const fake = createFakeDesktop({});
    const app: App = await bootApp({ stopScheduler: true, desktop: { launcher: fake.launcher } });
    try {
      await waitFor(() => app.ctx.store.seat.require('main').vision !== 'unknown' && app.core.turns.count() === 0, '화면 확인 턴', 60_000);
      const turns = app.ctx.store.turns.list({ ref1: MAIN_AGENT_ID });
      // 시작 때의 화면 확인 턴은 모의 실행이었다
      expect(turns.length > 0 && turns.every((t) => t.mock)).toBe(true);
      app.ctx.store.turns.insert({ ...turns[0]!, id: `${turns[0]!.id}9` as (typeof turns)[number]['id'], mock: false });
    } catch (e) {
      await app.close().catch(() => undefined);
      await fake.cleanup();
      throw e;
    }
    await expect(app.close()).rejects.toThrow('화면 도우미를 붙인 시험에서 모의 실행이 아닌 메인 턴이 떴습니다');
    await fake.cleanup();
  });

  it('bootApp의 확인은 stop()도 한다: 다시 시작 시험의 앞 실행에 모의 실행이 아닌 메인 턴이 있으면 그 실행의 stop()이 던진다 — 실행마다 따로 센다 (S6-19, S6-23 T1)', async () => {
    const fake = createFakeDesktop({});
    const dataDir = mkdtempSync(join(tmpdir(), 'wook-test-guirec-restart-'));
    dirs.push(dataDir);
    const desktop = { launcher: fake.launcher, timeouts: { READY: 5000 } };
    let app: App = await bootApp({ stopScheduler: true, dataDir, desktop });
    try {
      await waitFor(() => app.ctx.store.seat.require('main').vision !== 'unknown' && app.core.turns.count() === 0, '화면 확인 턴', 60_000);
      const turns = app.ctx.store.turns.list({ ref1: MAIN_AGENT_ID });
      expect(turns.length > 0 && turns.every((t) => t.mock)).toBe(true);
      // 이 실행에 모의 실행이 아닌 메인 턴이 떴던 것처럼 (기록만 — CLI는 띄우지 않는다)
      app.ctx.store.turns.insert({ ...turns[0]!, id: `${turns[0]!.id}9` as (typeof turns)[number]['id'], mock: false });
      // 다시 시작 시험이 하는 대로 stop()만 한다 — 그 stop()이 던진다
      await expect(app.stop()).rejects.toThrow('화면 도우미를 붙인 시험에서 모의 실행이 아닌 메인 턴이 떴습니다');
      killFakePids(fake.pids());
      // 같은 데이터 폴더로 다시 띄운 실행은 메인 턴을 띄우지 않는다(보기 확인은 앞 실행에서 끝났다) — 앞 실행의 턴은 이 실행의 확인에 들지 않는다
      app = await bootApp({ stopScheduler: true, dataDir, desktop });
      expect(app.ctx.store.seat.require('main').vision).not.toBe('unknown');
      await app.stop();
    } finally {
      await app.close().catch(() => undefined);
      killFakePids(fake.pids());
      await fake.cleanup();
    }
  }, 120_000);

  it('bootApp의 확인은 막 뜨는 모의 메인 턴에 던지지 않는다 — 그 턴의 모의 어댑터 준비(prepare)가 끝나기 전에 stop()을 불러도 (S6-25 P1 — 검토 3차 R3-2)', async () => {
    // 지키는 것: 턴 줄은 있고 모의 어댑터가 아직 띄운 수를 세지 않은 틈에 stop()이 '모의 실행이 아닌 메인 턴이 떴습니다'로 거짓으로 던지는 것
    const fake = createFakeDesktop({});
    const app: App = await bootApp({ desktop: { launcher: fake.launcher } });
    try {
      await waitFor(() => app.ctx.store.seat.require('main').vision !== 'unknown' && app.core.turns.count() === 0, '화면 확인 턴', 60_000);
      // 모의 어댑터의 준비를 늦춘 뒤 실패시킨다 — 그 턴은 아무 프로세스도 띄우지 않는다
      const deps = (app.ctx as unknown as { deps: { adapters: { mock: { prepare: (l: unknown) => Promise<unknown> } } } }).deps;
      let entered = false;
      deps.adapters.mock.prepare = async () => {
        entered = true;
        await sleep(1500);
        throw new Error('시험: 준비를 일부러 실패시킴 (프로세스를 띄우지 않는다)');
      };
      await app.invoke('command.send', { target: 'main', text: '현황 알려 줘' } as never);
      await waitFor(() => entered, '메인 턴의 준비', 30_000);
      const turns = app.ctx.store.turns.list({ ref1: MAIN_AGENT_ID });
      // 메인 턴은 모두 모의다 — 하나는 아직 준비 중이라 프로세스가 없다
      expect([turns.length >= 2, turns.every((t) => t.mock), turns.filter((t) => t.process.pid === null && t.process.spawnedAt === null).length]).toEqual([true, true, 1]);
      await expect(app.stop()).resolves.toBeUndefined();
    } finally {
      await app.close().catch(() => undefined);
      killFakePids(fake.pids());
      await fake.cleanup();
    }
  }, 120_000);

  it('bootApp의 확인: 모의 실행으로 적혔지만 모의 어댑터를 거치지 않고 프로세스가 뜬 메인 턴이 있어도 던진다 — 실제 CLI는 띄우지 않고 그런 턴의 기록만 넣어 본다 (S6-25 P1)', async () => {
    // 지키는 것: 기록의 mock 표시만 보면, 모의로 적힌 턴이 다른 어댑터(실제 CLI)로 뜬 것을 놓친다
    const fake = createFakeDesktop({});
    const app: App = await bootApp({ stopScheduler: true, desktop: { launcher: fake.launcher } });
    try {
      await waitFor(() => app.ctx.store.seat.require('main').vision !== 'unknown' && app.core.turns.count() === 0, '화면 확인 턴', 60_000);
      const turns = app.ctx.store.turns.list({ ref1: MAIN_AGENT_ID });
      expect(turns.length > 0 && turns.every((t) => t.mock && t.process.pid !== null)).toBe(true);
      app.ctx.store.turns.insert({ ...turns[0]!, id: `${turns[0]!.id}8` as (typeof turns)[number]['id'], mock: true });
    } catch (e) {
      await app.close().catch(() => undefined);
      await fake.cleanup();
      throw e;
    }
    await expect(app.stop()).rejects.toThrow('화면 도우미를 붙인 시험에서 모의 실행이 아닌 메인 턴이 떴습니다');
    await app.close().catch(() => undefined);
    killFakePids(fake.pids());
    await fake.cleanup();
  }, 120_000);

  it('턴 한 줄의 글 — 프로그램 이름 대신 쓰는 이름, 다섯 곳 넘으면 외 n곳', () => {
    expect(GuiRecords.summaryText({ inputs: 23, captures: 12, refused: 2, refusedBy: {}, apps: ['메모장', '브라우저'], warn: false })).toBe('화면 조작 23회: 메모장, 브라우저 (캡처 12장, 거부 2회)');
    expect(GuiRecords.summaryText({ inputs: 1, captures: 0, refused: 0, refusedBy: {}, apps: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], warn: false })).toBe('화면 조작 1회: a, b, c, d, e 외 2곳 (캡처 0장)');
  });
});
