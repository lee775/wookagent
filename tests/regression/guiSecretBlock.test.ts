/**
 * 화면 조작으로 비밀 값을 치지 않는다 (SERVER_DESIGN 8.3.5 '비밀 값을 치지 않는다', 리드 결정 S6-6 3단계·S6-8 — 10.6 guiSecretBlock의 비밀 값 갈래).
 * - type할 글에 등록 API 키·턴 토큰·형식 키(sk-ant-…)·기기 세션 토큰(wos_…)이 들면 secret_blocked이고, 가짜 도우미에 TYPE이 하나도 가지 않는다
 * - 기록(gui_actions)에는 값이 없다 — text null과 길이만. 거부 글도 값을 되풀이하지 않는다. 그때마다 경고 활동 기록 한 줄
 * - 키 이름(keys)에 든 비밀 값도 막는다. 깨끗한 글은 그대로 치고 그대로 남는다(가려진 것이 없으니)
 * - 비밀 검사는 캡처 검사(4단계)보다 먼저다 — 오래된 캡처에 비밀 값을 넣어도 stale_capture가 아니라 secret_blocked (S6-6 순서)
 * - 포커스가 암호 칸(PASSWORD_FIELD)이거나 모름(FOCUS_UNKNOWN)이라 도우미가 거부하면 secret_blocked (도우미 쪽 판정의 연결)
 * - 암호 칸 갈래 (S6c): 그때 치려던 글은 기록에 남지 않는다(길이만) — 보낸 줄('sent')은 답을 받기 전까지 글 없이 남고, 거부되면 글과 키 이름을 지운다.
 *   (암호 칸 판정을 돌아가는 붙여넣기 키 Ctrl+V·Shift+Insert·Win+V를 막는 것은 guiDeniedTargets가 본다)
 * - 고침 1차 (리드 결정 S6-21):
 *   B1 — type의 글에 탭·줄바꿈 같은 제어 문자가 들면 invalid이고 TYPE이 가지 않는다 (탭·Enter 뒤 글자가 검사받지 않은 다음 칸에 들어가지 않게). 비밀 값이 함께
 *        들었으면 secret_blocked가 먼저다. 도우미(가짜)도 같은 글을 ERR BAD_TEXT로 거부한다
 *   B2 — 글자 키는 빼는 쪽으로 정한다: 이동·기능 키 밖의 모든 키(space·plus·minus·글자 하나, Shift가 붙어도)는 암호 칸·모르는 포커스에서 secret_blocked.
 *        이름 붙은 키 전체를 두 포커스에 대어 본다
 *   C2 — 친 글은 도우미가 포커스를 판정한 칸에 쳤을 때만 기록에 남는다: 받아들인 답과 판정 뒤의 중단(sent > 0). 그 밖의 거부·실패는 길이만
 * - 고침 2차 (리드 결정 S6-23):
 *   K1 — Win 없는 Ctrl+Alt(+Shift)는 AltGr이라 글자 키다: 이름 붙은 키 전체를 Ctrl+Alt·Ctrl+Alt+Shift로도 두 포커스에 대어 본다. Ctrl+Alt+Del은 그대로 denied_target,
 *        Ctrl만·Alt만·Win이 든 단축키는 그대로 간다 (검토 2차 R2-1을 옮김)
 *   K2 — type은 4자마다 포커스를 다시 본다: 치는 중에 앱이 포커스를 암호 칸·모르는 곳·다른 창으로 옮기면 멈추고(FOCUS_UNKNOWN sent=n) secret_blocked, 다 친 뒤
 *        다시 읽은 포커스가 암호 칸이거나 모르면 OK라도 secret_blocked — 글은 길이만, 보낸 글자 수를 알린다 (검토 2차 R2-4를 옮김)
 */
import { afterEach, describe, expect, it } from 'vitest';
import { controlCharIn, deniedKeyCombo, NAMED_KEY_NAMES, NON_PRINTABLE_KEYS, parseKeyCombo, printableKey } from '@core/screenGuard';
import { createFakeDesktop, type FakeDesktop } from '../fixtures/desktop/fakeDesktop';
import { failureOf, typeFocusMovedText } from '../../src/main/desktop/service';
import { assertFakeMain, bootGui, capture, input, inputLines, liveMain, type GuiEnv } from './guiRig';
import { sleep, waitFor } from './orchHarness';

const open: GuiEnv[] = [];
const fakes: FakeDesktop[] = [];
afterEach(async () => {
  for (const g of open.splice(0)) await g.close();
  for (const f of fakes.splice(0)) await f.cleanup();
});

/** 글자 코드로 만든 제어 문자 (소스에 제어 문자를 그대로 두지 않는다) */
const BELL = String.fromCharCode(7);
const NUL = String.fromCharCode(0);
const UNIT_SEP = String.fromCharCode(0x1f);
const DEL = String.fromCharCode(0x7f);

const K_ANTHROPIC = 'sk-ant-api03-WookGuiTestKey7Qx9Zr2Lm4Pv8Ks1Hn6Tb3Yc5Vd0Fg';
const K_CUSTOM = 'wtk9GuiTestKeyQ7x9Zr2Lm4Pv8Ks1Hn6Tb3';
const K_FORMAT = 'sk-ant-api03-NotRegisteredButFormatKey0123456789abcdefABCDEF';
const WOS = `wos_${'Ab3_-'.repeat(9)}x`;

function dump(g: GuiEnv): string {
  const db = g.e.ctx.store.db;
  const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]).map((t) => t.name);
  return tables.map((t) => JSON.stringify(db.prepare(`SELECT * FROM ${t}`).all())).join('\n');
}

describe('gui_input — 비밀 값이 든 글은 치지 않는다 (secret_blocked)', () => {
  it('등록 API 키·턴 토큰·형식 키·wos_ 토큰이 든 type은 도우미에 가지 않고, 기록·활동 기록·캐시·DB에 값이 없다 — 깨끗한 글은 친다', async () => {
    const g = await bootGui();
    open.push(g);
    const ctx = g.e.ctx;
    // 대표가 등록한 키 (settings.setApiKey가 하는 것과 같이 가리개에 등록)
    ctx.redact.addSecret(K_CUSTOM, 'api-key');
    const turnId = await liveMain(g.e);
    // 턴 토큰은 띄울 때 가리개에 등록된다 (turns.ts) — 하네스의 토큰은 'tok-<턴>'
    const token = `tok-${turnId}`;
    expect(ctx.redact.text(token)).not.toBe(token);
    const c = await capture(g.e, turnId);
    const secrets = { K_ANTHROPIC, K_CUSTOM, K_FORMAT, token, WOS };
    for (const [name, s] of Object.entries(secrets)) {
      const r = await input(g.e, turnId, { action: 'type', capture_id: c.data.capture_id, text: `메모: ${s} 끝`, request_id: `rq-secret-${name}` });
      expect(r, name).toMatchObject({ ok: false, code: 'secret_blocked' });
      if (!r.ok) expect(r.message).not.toContain(s);
    }
    // 키 이름에 든 비밀 값도
    expect(await input(g.e, turnId, { action: 'key', capture_id: c.data.capture_id, keys: K_FORMAT.slice(0, 60) })).toMatchObject({ ok: false, code: 'secret_blocked' });
    // 깨끗한 글은 친다 — 그 경로가 실제로 돈다는 증거
    expect((await input(g.e, turnId, { action: 'type', capture_id: c.data.capture_id, text: '안녕하세요' })).ok).toBe(true);
    expect(g.fake.typed()).toEqual(['안녕하세요']);

    const rows = ctx.store.guiActions.query({ turnId, actions: ['type', 'key'], asc: true });
    expect(rows.map((r) => [r.action, r.result, r.text, r.textLength, r.dispatched])).toEqual([
      ...Object.values(secrets).map((s) => ['type', 'secret_blocked', null, [...`메모: ${s} 끝`].length, false]),
      ['key', 'secret_blocked', null, null, false],
      ['type', 'ok', '안녕하세요', 5, true],
    ]);
    // 비밀 값 거부마다 경고 한 줄 (값 없이)
    expect(ctx.store.activity.search({ turnId, kinds: ['screen'], level: 'warn', limit: 50 })).toHaveLength(6);
    const all = dump(g);
    const leaked = Object.entries(secrets).filter(([, s]) => all.includes(s)).map(([n]) => n);
    expect(leaked).toEqual([]);
    expect(g.fake.received().join('\n')).not.toContain('sk-ant');
  });

  it('비밀 검사는 캡처 검사보다 먼저다 — 30초 지난 캡처에 비밀 값을 넣어도 secret_blocked, 모르는 캡처도 secret_blocked', async () => {
    const g = await bootGui();
    open.push(g);
    const turnId = await liveMain(g.e);
    const c = await capture(g.e, turnId);
    g.clock.advance(60_000);
    expect(await input(g.e, turnId, { action: 'type', capture_id: c.data.capture_id, text: `키 ${K_FORMAT}` })).toMatchObject({ ok: false, code: 'secret_blocked' });
    expect(await input(g.e, turnId, { action: 'type', capture_id: 'SC-999999', text: `키 ${K_FORMAT}` })).toMatchObject({ ok: false, code: 'secret_blocked' });
    expect(await input(g.e, turnId, { action: 'type', capture_id: c.data.capture_id, text: '깨끗한 글' })).toMatchObject({ ok: false, code: 'stale_capture' });
    expect(g.fake.typed()).toEqual([]);
  });

  it('포커스가 암호 칸이거나 어떤 칸인지 모르면 도우미가 거부하고 secret_blocked가 된다 (글자는 치지 않음)', async () => {
    const g = await bootGui({ errorQueue: [{ verb: 'TYPE', err: 'PASSWORD_FIELD' }, { verb: 'TYPE', err: 'FOCUS_UNKNOWN sent=0' }] });
    open.push(g);
    const turnId = await liveMain(g.e);
    const c = await capture(g.e, turnId);
    const pw = await input(g.e, turnId, { action: 'type', capture_id: c.data.capture_id, text: 'hunter2hunter2' });
    const unknown = await input(g.e, turnId, { action: 'type', capture_id: c.data.capture_id, text: 'hunter3hunter3' });
    expect([pw, unknown]).toMatchObject([
      { ok: false, code: 'secret_blocked' },
      { ok: false, code: 'secret_blocked' },
    ]);
    expect(g.e.ctx.store.guiActions.query({ turnId, actions: ['type'], asc: true }).map((r) => r.result)).toEqual(['secret_blocked', 'secret_blocked']);
  });

  it('치기 전에 포커스를 모르는 type(FOCUS_UNKNOWN — sent=0, sent 없음)은 "치지 않았습니다"라고 한다 — 보낸 글자가 그 칸에 들어갔을 수 있다는 글(S6-23 K2)이 아니다 (S6-25 P3 — 검토 3차 R3-4)', async () => {
    // 지키는 것: 보낸 글자가 있을 때만 쓰는 글(typedSome)의 조건을 빼면 아무것도 치지 않은 type에 '0자를 보냈고 일부가 그 칸에 들어갔을 수 있습니다 … 그 칸에는
    // 다시 치지 말고'라는 거짓 글이 간다
    const UNKNOWN = { app: 'chrome', title: '로그인 - Chrome', pid: 5151, control: 'Edit', password: null as boolean | null, blocked: false, elevated: false };
    const NOT_TYPED = '포커스가 어떤 칸인지(암호 칸인지) 확인하지 못해 글자를 치지 않았습니다 — 칸을 클릭한 뒤 다시 캡처해 확인하세요';
    const g = await bootGui({ focus: UNKNOWN, errorQueue: [{ verb: 'TYPE', err: 'FOCUS_UNKNOWN sent=0' }] });
    open.push(g);
    assertFakeMain(g.e);
    const turnId = await liveMain(g.e);
    const c = await capture(g.e, turnId);
    // 첫째는 도우미가 'ERR FOCUS_UNKNOWN sent=0'으로, 둘째는 모르는 포커스라 'ERR FOCUS_UNKNOWN'(sent 없음)으로 답한다
    const a = await input(g.e, turnId, { action: 'type', capture_id: c.data.capture_id, text: 'abcdefgh' });
    const b = await input(g.e, turnId, { action: 'type', capture_id: c.data.capture_id, text: 'ijklmnop' });
    expect(g.fake.log().filter((e) => e.dir === 'out' && / ERR FOCUS_UNKNOWN/.test(e.line)).map((e) => e.line.replace(/^\S+ /, ''))).toEqual(['ERR FOCUS_UNKNOWN sent=0', 'ERR FOCUS_UNKNOWN']);
    expect([a.ok ? 'ok' : [a.code, a.message], b.ok ? 'ok' : [b.code, b.message]]).toEqual([
      ['secret_blocked', NOT_TYPED],
      ['secret_blocked', NOT_TYPED],
    ]);
    expect(NOT_TYPED).not.toContain('보냈고');
    assertFakeMain(g.e);
  });

  it('암호 칸이 포커스면 type과 글자 키는 secret_blocked이고 Enter·Tab·화살표·단축키는 간다 — 치려던 글과 키 이름은 기록에 남지 않는다(길이만). 포커스를 모르면 글자 입력을 막는다 (S6-8)', async () => {
    const PASSWORD = { app: 'chrome', title: '로그인 - 사내 포털', pid: 4300, control: 'Edit', password: true as boolean | null, blocked: false, elevated: false };
    const g = await bootGui({ focus: PASSWORD });
    open.push(g);
    const turnId = await liveMain(g.e);
    const c = await capture(g.e, turnId);
    const id = c.data.capture_id;
    const key = (keys: string) => input(g.e, turnId, { action: 'key', capture_id: id, keys });
    // 가리기 규칙에 걸리지 않는 글(등록되지 않은 비밀번호)도 암호 칸이면 치지 않는다
    const PW = 'correct horse battery staple 9';
    const typed = await input(g.e, turnId, { action: 'type', capture_id: id, text: PW });
    expect(typed).toMatchObject({ ok: false, code: 'secret_blocked' });
    if (!typed.ok) {
      expect(typed.message).toContain('암호 칸');
      expect(typed.message).not.toContain(PW);
    }
    // 글자 키(Shift만 붙은 글자·space 포함)는 막고, 글자가 아닌 키와 단축키는 보낸다
    for (const k of ['a', 'Z', 'shift+a', '7', 'space']) expect([k, await key(k)]).toMatchObject([k, { ok: false, code: 'secret_blocked' }]);
    for (const k of ['enter', 'tab', 'left', 'backspace', 'ctrl+a', 'esc']) expect([k, (await key(k)).ok]).toEqual([k, true]);
    // 포커스가 어떤 칸인지 모른다 (UI Automation이 답하지 않음) — 글자 입력은 막고 Enter는 간다
    g.fake.act({ do: 'set', value: { focus: { ...PASSWORD, password: null } } });
    await new Promise((r) => setTimeout(r, 150));
    const unknown = await input(g.e, turnId, { action: 'type', capture_id: id, text: '모르는 칸에 치는 글' });
    expect(unknown).toMatchObject({ ok: false, code: 'secret_blocked' });
    if (!unknown.ok) expect(unknown.message).toContain('확인하지 못해');
    expect(await key('x')).toMatchObject({ ok: false, code: 'secret_blocked' });
    expect((await key('enter')).ok).toBe(true);
    // 포커스가 아예 없다
    g.fake.act({ do: 'set', value: { focus: null } });
    await new Promise((r) => setTimeout(r, 150));
    expect(await input(g.e, turnId, { action: 'type', capture_id: id, text: '포커스 없이 치는 글' })).toMatchObject({ ok: false, code: 'secret_blocked' });
    // 기록: 암호 칸·모르는 포커스 거부는 글도 키 이름도 없이 길이만 — DB 어디에도 그 글이 없다
    const rows = g.e.ctx.store.guiActions.query({ turnId, results: ['secret_blocked'], asc: true });
    expect(rows.map((r) => [r.action, r.text, r.textLength, r.keys, r.dispatched])).toEqual([
      ['type', null, [...PW].length, null, true],
      ...['a', 'Z', 'shift+a', '7', 'space'].map(() => ['key', null, null, null, true]),
      ['type', null, [...'모르는 칸에 치는 글'].length, null, true],
      ['key', null, null, null, true],
      ['type', null, [...'포커스 없이 치는 글'].length, null, true],
    ]);
    const all = dump(g);
    for (const s of [PW, '모르는 칸에 치는 글', '포커스 없이 치는 글']) expect([s, all.includes(s)]).toEqual([s, false]);
    // 보낸 키는 그대로 남는다
    expect(g.e.ctx.store.guiActions.query({ turnId, actions: ['key'], results: ['ok'], asc: true }).map((r) => r.keys)).toEqual(['enter', 'tab', 'left', 'backspace', 'ctrl+a', 'esc', 'enter']);
    // 거부마다 경고 활동 기록 한 줄 (값 없이)
    const warns = g.e.ctx.store.activity.search({ turnId, kinds: ['screen'], level: 'warn', limit: 50 });
    expect(warns).toHaveLength(9);
    expect(warns.some((w) => w.text.includes(PW) || (w.result ?? '').includes(PW))).toBe(false);
  });

  it('보낸 type 줄은 답을 받기 전에는 글 없이 길이만 둔다 — 답을 받으면 채우고, 서버가 그 사이 끝나도 글은 남지 않는다', async () => {
    const g = await bootGui({ delayMs: { TYPE: 400 } });
    open.push(g);
    const turnId = await liveMain(g.e);
    const c = await capture(g.e, turnId);
    const pending = input(g.e, turnId, { action: 'type', capture_id: c.data.capture_id, text: '보내는 중인 글' });
    await new Promise((r) => setTimeout(r, 150));
    const sent = g.e.ctx.store.guiActions.query({ turnId, actions: ['type'] })[0]!;
    expect([sent.result, sent.text, sent.textLength]).toEqual(['sent', null, 8]);
    expect((await pending).ok).toBe(true);
    const done = g.e.ctx.store.guiActions.get(sent.id)!;
    expect([done.result, done.text, done.textLength]).toEqual(['ok', '보내는 중인 글', 8]);
  });
});

const NOTEPAD = { app: 'notepad', title: '제목 없음 - 메모장', pid: 4242, control: 'Edit', password: false as boolean | null, blocked: false, elevated: false };
const LOGIN_PW = { app: 'chrome', title: '로그인 - 사내 포털', pid: 4300, control: 'Edit', password: true as boolean | null, blocked: false, elevated: false };

describe('gui_input type — 탭·줄바꿈 같은 제어 문자가 든 글은 치지 않는다 (S6-21 B1)', () => {
  it('글에 든 제어 문자를 가려낸다 (순수 함수) — 탭·줄바꿈·그 밖의 C0와 U+007F, 다른 글자는 통과', () => {
    expect(['a\tb', 'a\nb', 'a\rb', 'a\r\nb', `a${BELL}b`, `a${NUL}`, `${UNIT_SEP}z`, `del${DEL}`].map(controlCharIn)).toEqual([
      '탭',
      '줄바꿈',
      '줄바꿈',
      '줄바꿈',
      '제어 문자 U+0007',
      '제어 문자 U+0000',
      '제어 문자 U+001F',
      '제어 문자 U+007F',
    ]);
    for (const ok of ['안녕하세요', 'a b', 'tab 대신 key', '😀 이모지', `줄${String.fromCharCode(0x2028)}구분`, `x${String.fromCharCode(0xa0)}y`, '~!@#$%^&*()_+{}|:"<>?']) {
      expect([ok, controlCharIn(ok)]).toEqual([ok, null]);
    }
  });

  it('"아이디<Tab>비밀번호<Enter>"를 한 번에 치는 type은 invalid — TYPE이 하나도 가지 않고 글은 기록에 남지 않는다. 나눠 보내면 칸마다 포커스를 다시 본다', async () => {
    const g = await bootGui({ focus: NOTEPAD });
    open.push(g);
    const turnId = await liveMain(g.e);
    const c = await capture(g.e, turnId);
    const id = c.data.capture_id;
    const type = (text: string) => input(g.e, turnId, { action: 'type', capture_id: id, text });
    const LOGIN = 'wookadmin\tOwnerPw-2026!x\n';
    const texts = [LOGIN, '첫 줄\n둘째 줄', '윈도우 줄\r\n바꿈', '끝에 탭\t', `벨${BELL}`, `지움${DEL}`];
    for (const t of texts) {
      const r = await type(t);
      expect([JSON.stringify(t), r.ok ? 'ok' : r.code]).toEqual([JSON.stringify(t), 'invalid']);
      // 거부 글은 대신 할 일을 말하고 글을 되풀이하지 않는다
      if (!r.ok) {
        expect(r.message).toContain('key "tab"');
        expect(r.message).toContain('key "enter"');
        expect(r.message).not.toContain('OwnerPw');
      }
    }
    // 비밀 값이 함께 들었으면 secret_blocked가 먼저다 (S6-6 3단계의 순서)
    expect(await type(`키 ${K_FORMAT}\t다음 칸`)).toMatchObject({ ok: false, code: 'secret_blocked' });
    expect(g.fake.typed()).toEqual([]);
    expect(inputLines(g.fake)).toEqual([]);
    const refused = g.e.ctx.store.guiActions.query({ turnId, actions: ['type'], asc: true });
    expect(refused.map((r) => [r.result, r.text, r.textLength, r.dispatched])).toEqual([...texts.map((t) => ['invalid', null, [...t].length, false]), ['secret_blocked', null, expect.any(Number), false]]);
    expect(dump(g)).not.toContain('OwnerPw-2026');

    // 안내대로 나눠 보낸다: 아이디 → Tab(포커스가 암호 칸으로 옮겨 감) → 비밀번호는 그 칸에서 다시 판정받아 막힌다
    expect((await type('wookadmin')).ok).toBe(true);
    expect((await input(g.e, turnId, { action: 'key', capture_id: id, keys: 'tab' })).ok).toBe(true);
    g.fake.act({ do: 'set', value: { focus: LOGIN_PW } });
    await sleep(150);
    expect(await type('OwnerPw-2026!x')).toMatchObject({ ok: false, code: 'secret_blocked' });
    expect((await input(g.e, turnId, { action: 'key', capture_id: id, keys: 'enter' })).ok).toBe(true);
    // 가짜는 줄을 받고 거부한다 (실제 도우미는 SendInput 전에 거부한다)
    expect(g.fake.typed()).toEqual(['wookadmin', 'OwnerPw-2026!x']);
    expect(dump(g)).not.toContain('OwnerPw-2026');
  });

  it('도우미(가짜)도 제어 문자가 든 TYPE을 ERR BAD_TEXT로 거부한다 — 처리기를 거치지 않은 줄도 탭·Enter 키로 바뀌지 않는다', async () => {
    const fake = createFakeDesktop({ focus: NOTEPAD });
    fakes.push(fake);
    const client = fake.client();
    try {
      const lease = await client.acquire();
      if ('kind' in lease) throw new Error(lease.text);
      expect((await lease.send({ verb: 'ARM', policy: { pids: [], titles: [], titlePrefixes: [] } })).ok).toBe(true);
      const screens = await lease.send({ verb: 'SCREENS' });
      if (!screens.ok) throw new Error('SCREENS');
      const layout = screens.value.layout;
      const results = [];
      for (const text of ['id\tpw', 'line\n', 'cr\r', `bell${BELL}`, `del${DEL}`]) results.push(await lease.send({ verb: 'TYPE', text, layout }));
      expect(results).toMatchObject(Array(5).fill({ ok: false, kind: 'err', reason: 'BAD_TEXT' }));
      // 그 거부는 메인에게 invalid와 같은 안내로 간다
      const first = results[0]!;
      if (!first.ok) expect(failureOf(first, true)).toMatchObject({ code: 'invalid', message: expect.stringContaining('key "tab"') });
      expect((await lease.send({ verb: 'TYPE', text: '깨끗한 글', layout })).ok).toBe(true);
      lease.end();
    } finally {
      await client.dispose();
    }
  });
});

describe('gui_input key — 글자 키는 빼는 쪽으로 정한다 (S6-21 B2·S6-23 K1)', () => {
  it('목록: 이동·기능 키만 글자 키가 아니다 — space·plus·minus와 글자 하나는 Shift가 붙어도 글자 키, Ctrl만·Alt만·Win이 붙으면 단축키, Win 없는 Ctrl+Alt(AltGr)는 글자 키', () => {
    const printable = (k: string) => printableKey(parseKeyCombo(k)!);
    for (const k of ['a', 'Z', '7', '-', '=', '_', 'space', 'plus', 'minus', 'shift+a', 'shift+plus', 'shift+minus', 'shift+space', 'shift+1']) expect([k, printable(k)]).toEqual([k, true]);
    for (const k of ['enter', 'return', 'tab', 'esc', 'backspace', 'delete', 'del', 'insert', 'home', 'end', 'pageup', 'pgdn', 'up', 'down', 'left', 'right', 'printscreen', 'menu', 'apps', 'capslock', 'f1', 'f12', 'f24', 'shift+tab', 'shift+f10']) {
      expect([k, printable(k)]).toEqual([k, false]);
    }
    // Ctrl만·Alt만·Win이 든 조합은 단축키다 (고침 1차 전에는 ctrl+alt+v도 여기 있었다 — 리드 결정 S6-23 K1로 바뀜)
    for (const k of ['ctrl+a', 'alt+a', 'win+d', 'ctrl+shift+s', 'ctrl+plus', 'alt+space', 'ctrl+c', 'alt+f4', 'alt+shift+q', 'ctrl+shift+7', 'ctrl+alt+win+q', 'win+ctrl+alt+e', 'ctrl+alt+super+7']) {
      expect([k, printable(k)]).toEqual([k, false]);
    }
    // Win 없는 Ctrl+Alt는 AltGr이다 — AltGr 자판에서 글자를 찍는다(독일어 Ctrl+Alt+Q = '@', E = '€', 7 = '{', minus 자리 = '\\', plus 자리 = '~'). Shift가 붙어도
    for (const k of ['ctrl+alt+q', 'alt+ctrl+q', 'Control+Alt+E', 'ctrl+alt+7', 'ctrl+alt+0', 'ctrl+alt+minus', 'ctrl+alt+plus', 'ctrl+alt+space', 'ctrl+alt+v', 'ctrl+alt+shift+q', 'shift+ctrl+alt+5']) {
      expect([k, printable(k)]).toEqual([k, true]);
    }
    // Ctrl+Alt가 붙어도 이동·기능 키는 글자 키가 아니다
    for (const k of ['ctrl+alt+enter', 'ctrl+alt+tab', 'ctrl+alt+f4', 'ctrl+alt+left', 'ctrl+alt+shift+end', 'ctrl+alt+delete']) expect([k, printable(k)]).toEqual([k, false]);
    // 글자 키가 아닌 이름은 이 목록뿐이다 — 이름 붙은 키에서 이 목록을 빼면 space·plus·minus만 남는다
    const named = new Set(NAMED_KEY_NAMES.map((n) => parseKeyCombo(n)!.key));
    expect([...named].filter((k) => !NON_PRINTABLE_KEYS.has(k)).sort()).toEqual(['minus', 'plus', 'space']);
    expect([...NON_PRINTABLE_KEYS].filter((k) => !named.has(k))).toEqual([]);
  });

  it('이름 붙은 키 전체(와 Shift·Ctrl+Alt·Ctrl+Alt+Shift를 붙인 것)를 암호 칸과 모르는 포커스에 대어 본다 — 글자 키는 secret_blocked, 이동·기능 키는 간다. minus·plus와 AltGr(Ctrl+Alt) 글자도 막힌다', async () => {
    const g = await bootGui({ focus: LOGIN_PW });
    open.push(g);
    const turnId = await liveMain(g.e);
    const c = await capture(g.e, turnId);
    const key = async (keys: string): Promise<string> => {
      const r = await input(g.e, turnId, { action: 'key', capture_id: c.data.capture_id, keys });
      return r.ok ? 'ok' : r.code;
    };
    // 글로 적은 기대값 (목록에서 꺼낸 기대값과 따로 — 아래에서 본다)
    // AltGr(Win 없는 Ctrl+Alt) 글자 — 독일어 자판의 @·€·{·}·\·~ 자리와 그 Shift 꼴, 수정 키의 순서·다른 이름 (리드 결정 S6-23 K1, 검토 2차 R2-1)
    const altGr = ['ctrl+alt+q', 'alt+ctrl+q', 'Control+Alt+e', 'shift+alt+ctrl+e', 'ctrl+alt+7', 'ctrl+alt+0', 'ctrl+alt+minus', 'ctrl+alt+plus', 'ctrl+alt+space', 'ctrl+alt+shift+a', 'ctrl+alt+@'];
    // Ctrl+Alt+이동·기능 키와 지금도 가는 단축키 (Ctrl만·Alt만·Win이 든 조합)
    const shortcuts = ['ctrl+alt+enter', 'ctrl+alt+tab', 'ctrl+alt+f4', 'ctrl+alt+shift+left', 'ctrl+c', 'ctrl+a', 'ctrl+shift+s', 'alt+f4', 'alt+tab', 'alt+q', 'win+d', 'ctrl+alt+win+q', 'win+ctrl+alt+e'];
    // 막는 조합 — Ctrl+Alt+Del은 글자 키 판정보다 먼저 denied_target이다
    const denied = ['ctrl+alt+delete', 'ctrl+alt+del', 'ctrl+alt+shift+delete', 'ctrl+alt+shift+f12'];
    const chars = ['a', 'Q', '5', '-', '=', '_', '@', '7', '0'];
    const combos = [
      ...new Set([
        ...NAMED_KEY_NAMES.flatMap((n) => [n, `shift+${n}`, `ctrl+alt+${n}`, `ctrl+alt+shift+${n}`]),
        ...chars.flatMap((ch) => [ch, `shift+${ch}`, `ctrl+alt+${ch}`, `ctrl+alt+shift+${ch}`]),
        ...altGr,
        ...shortcuts,
        ...denied,
      ]),
    ];
    // 기대값: 붙여넣기(shift+insert)·Ctrl+Alt+Del 등은 처리기가 먼저 막고(denied_target), 글자 키는 도우미가 막고(secret_blocked), 나머지는 간다
    const expected = (k: string): string => (deniedKeyCombo(k) ? 'denied_target' : printableKey(parseKeyCombo(k)!) ? 'secret_blocked' : 'ok');
    for (const [name, focus] of [
      ['암호 칸', LOGIN_PW],
      ['모르는 포커스', { ...LOGIN_PW, password: null }],
    ] as const) {
      g.fake.act({ do: 'set', value: { focus } });
      await sleep(150);
      const got: Record<string, string> = {};
      for (const k of combos) got[k] = await key(k);
      expect({ focus: name, got }).toEqual({ focus: name, got: Object.fromEntries(combos.map((k) => [k, expected(k)])) });
      // 목록에서 꺼낸 기대값과 따로, 글로 적은 기대값 — 검토에서 새던 넷과 그 이웃
      expect([got.minus, got.plus, got['shift+minus'], got['shift+plus'], got.space, got['shift+space'], got['-'], got['=']]).toEqual(Array(8).fill('secret_blocked'));
      expect([got.enter, got.tab, got['shift+tab'], got.left, got.pagedown, got.f5, got.capslock, got.printscreen, got.menu]).toEqual(Array(9).fill('ok'));
      expect([got['shift+insert'], got['shift+ins']]).toEqual(['denied_target', 'denied_target']);
      expect(altGr.map((k) => [k, got[k]])).toEqual(altGr.map((k) => [k, 'secret_blocked']));
      expect(shortcuts.map((k) => [k, got[k]])).toEqual(shortcuts.map((k) => [k, 'ok']));
      expect(denied.map((k) => [k, got[k]])).toEqual(denied.map((k) => [k, 'denied_target']));
    }
    // 암호 칸이 아닌 칸에서는 같은 글자 키가 간다 — 막은 것이 포커스 때문이라는 증거
    g.fake.act({ do: 'set', value: { focus: NOTEPAD } });
    await sleep(150);
    expect([await key('minus'), await key('shift+plus'), await key('space'), await key('ctrl+alt+q')]).toEqual(['ok', 'ok', 'ok', 'ok']);
  });

  it('검토 2차 R2-1: "@"(도우미가 AltGr 자판에서 Ctrl+Alt+Q로 보낸다)와 메인이 준 Ctrl+Alt+<글자>는 같은 입력이다 — 암호 칸·모르는 포커스에는 둘 다 secret_blocked', async () => {
    const at = parseKeyCombo('@')!;
    const ctrlAltQ = parseKeyCombo('ctrl+alt+q')!;
    expect({ at: printableKey(at), ctrlAltQ: printableKey(ctrlAltQ) }).toEqual({ at: true, ctrlAltQ: true });
    const ALTGR = ['ctrl+alt+q', 'ctrl+alt+e', 'ctrl+alt+7', 'ctrl+alt+8', 'ctrl+alt+9', 'ctrl+alt+0', 'ctrl+alt+minus', 'ctrl+alt+plus', 'alt+ctrl+q'];
    for (const [label, focus] of [
      ['암호 칸', LOGIN_PW],
      ['모르는 포커스', { ...LOGIN_PW, password: null }],
    ] as const) {
      const g = await bootGui({ focus });
      open.push(g);
      assertFakeMain(g.e);
      const turnId = await liveMain(g.e);
      const c = await capture(g.e, turnId);
      const results: Record<string, string> = {};
      for (const keys of ['@', ...ALTGR]) {
        const r = await input(g.e, turnId, { action: 'key', capture_id: c.data.capture_id, keys });
        results[keys] = r.ok ? 'ok' : r.code;
      }
      assertFakeMain(g.e);
      expect({ label, results, keyLinesSent: inputLines(g.fake).filter((l) => l.startsWith('KEY ')).length }).toEqual({
        label,
        results: Object.fromEntries(['@', ...ALTGR].map((k) => [k, 'secret_blocked'])),
        // 처리기는 막지 않는다(막는 조합이 아니다) — 도우미가 포커스를 보고 거부한다
        keyLinesSent: 1 + ALTGR.length,
      });
    }
  });
});

describe('gui_input type — 친 글은 도우미가 포커스를 판정한 칸에 쳤을 때만 기록에 남는다 (S6-21 C2)', () => {
  it('보내기 전의 거부와, 포커스를 보기 전의 도우미 거부·답 없음은 글 없이 길이만 — 받아들인 답과 판정 뒤 일부를 친 중단만 글이 남는다', async () => {
    const g = await bootGui(
      { focus: NOTEPAD, errorQueue: [{ verb: 'TYPE', err: 'HUMAN_ACTIVE sent=0' }, { verb: 'TYPE', err: 'HUMAN_ACTIVE sent=32' }, { verb: 'TYPE', err: 'FOCUS_UNKNOWN sent=32' }] },
      { helper: { timeouts: { READY: 5000, TYPE: 300, TYPE_PER_CHAR: 0 } } },
    );
    open.push(g);
    const turnId = await liveMain(g.e);
    const codes: Record<string, string> = {};
    const type = async (name: string, text: string, captureId: string): Promise<void> => {
      const r = await input(g.e, turnId, { action: 'type', capture_id: captureId, text });
      codes[name] = r.ok ? 'ok' : r.code;
    };
    const set = async (value: Record<string, unknown>): Promise<void> => {
      g.fake.act({ do: 'set', value: value as never });
      await sleep(150);
    };
    // (가) 보내기 전의 거부 — 30초 지난 캡처 (도우미에 아무것도 가지 않는다)
    const old = await capture(g.e, turnId);
    g.clock.advance(31_000);
    await type('stale', 'tiger blue stale 2026', old.data.capture_id);
    const c = await capture(g.e, turnId);
    const id = c.data.capture_id;
    // (나) 판정 뒤의 중단: 아무것도 치기 전(sent=0)·일부를 친 뒤(sent=32)·치다가 포커스가 바뀜(FOCUS_UNKNOWN — secret_blocked)
    await type('abort0', 'tiger blue abort zero', id);
    await type('abort32', 'tiger blue abort some', id);
    await type('focusLost', 'tiger blue focus lost', id);
    // (다) 받아들인 답
    await type('ok', 'tiger blue typed', id);
    // (라) 그사이 화면이 잠겼다 — 잠금 화면의 암호 칸에 치려던 글
    await set({ lock: 'locked' });
    await type('locked', 'tiger blue lock 2026', id);
    await set({ lock: null });
    // (마) 관리자 권한 창(자격 증명 창 등)과 막는 창(욱채 화면의 로그인 칸)이 포커스다 — 암호 칸인지 보기 전에 거부된다
    await set({ focus: { ...NOTEPAD, app: 'consent', title: 'Windows 보안', elevated: true, password: true } });
    await type('elevated', 'tiger blue admin 2026', id);
    await set({ focus: { ...NOTEPAD, app: 'chrome', title: '욱채 - Chrome', pid: 6161, password: true } });
    await type('blocked', 'tiger blue owner 2026', id);
    // (바) 도우미가 답하지 않는다 — 무엇을 쳤는지, 포커스가 무엇이었는지 모른다
    await set({ focus: NOTEPAD, hang: ['TYPE'] });
    await type('timeout', 'tiger blue hang 2026', id);

    expect(codes).toEqual({ stale: 'stale_capture', abort0: 'human_active', abort32: 'human_active', focusLost: 'secret_blocked', ok: 'ok', locked: 'unavailable', elevated: 'denied_target', blocked: 'denied_target', timeout: 'error' });
    const rows = g.e.ctx.store.guiActions.query({ turnId, actions: ['type'], asc: true });
    expect(rows.map((r) => [r.result, r.text, r.textLength])).toEqual([
      ['stale_capture', null, 21],
      ['human_active', null, 21],
      ['human_active', 'tiger blue abort some', 21],
      ['secret_blocked', null, 21],
      ['ok', 'tiger blue typed', 16],
      ['unavailable', null, 20],
      ['denied_target', null, 21],
      ['denied_target', null, 21],
      ['error', null, 20],
    ]);
    // 대표가 보는 화면 조작 기록에도 그 둘뿐이다
    const shown = g.e.core.desktop.recent({ limit: 50 }).actions.filter((a) => a.action === 'type' && a.text !== null).map((a) => a.text);
    expect(shown.sort()).toEqual(['tiger blue abort some', 'tiger blue typed']);
    const all = dump(g);
    for (const s of ['stale 2026', 'abort zero', 'focus lost', 'lock 2026', 'admin 2026', 'owner 2026', 'hang 2026']) expect([s, all.includes(s)]).toEqual([s, false]);
    await waitFor(() => g.e.core.desktop.peek()?.pid === null, '시간 초과로 끝낸 도우미');
  });
});

/** 본인 확인 양식: 앞자리 칸(보통 칸)을 다 채우면 양식이 스스로 가려진 뒷자리 칸(암호 칸)으로 포커스를 옮긴다 */
const FRONT = { app: 'chrome', title: '본인 확인 - Chrome', pid: 5151, control: 'Edit', password: false as boolean | null, blocked: false, elevated: false };
const BACK_MASKED = { ...FRONT, password: true as boolean | null };
/** 주민등록번호 13자리 — 앞 6자리를 다 채우면 뒷자리 칸으로 넘어간다 */
const RRN = '9001011234567';

describe('gui_input type — 치는 동안 앱이 포커스를 옮기면 멈춘다 (S6-23 K2)', () => {
  it('글자 4개마다 포커스를 다시 본다: 암호 칸·모르는 포커스·포커스 없음·다른 창으로 옮겨 가면 다음 묶음 전에 멈추고 secret_blocked — 보낸 글자 수를 알리고 글은 길이만', async () => {
    const g = await bootGui({ focus: FRONT });
    open.push(g);
    const turnId = await liveMain(g.e);
    const c = await capture(g.e, turnId);
    const targets = [
      ['암호 칸', BACK_MASKED],
      ['모르는 포커스', { ...FRONT, password: null }],
      ['포커스 없음', null],
      ['다른 창', { ...FRONT, app: 'other', title: '다른 프로그램', pid: 6262 }],
    ] as const;
    const got: [string, string, string][] = [];
    for (const [label, to] of targets) {
      // 앞 6자리를 받으면 양식이 포커스를 옮긴다 — 가짜는 4자씩 보내므로 8자를 보낸 뒤, 셋째 묶음 전에 옮겨 간 칸을 본다
      g.fake.act({ do: 'set', value: { focus: FRONT, typeFocusAfter: { chars: 6, focus: to } } });
      await sleep(150);
      const r = await input(g.e, turnId, { action: 'type', capture_id: c.data.capture_id, text: RRN });
      got.push([label, r.ok ? 'ok' : r.code, r.ok ? '' : r.message]);
    }
    const stopped = typeFocusMovedText(8, 5);
    expect(got).toEqual(targets.map(([label]) => [label, 'secret_blocked', stopped]));
    // 메인에게 가는 글: 옮겨 간 칸에 몇 자가 갔을 수 있는지, 나머지는 치지 않았다는 것, 그 칸에 다시 치지 말라는 것 — 친 글은 되풀이하지 않는다
    expect(stopped).toContain('8자를 보냈고 일부가 그 칸에 들어갔을 수 있습니다');
    expect(stopped).toContain('나머지 5자는 치지 않았습니다');
    expect(stopped).toContain('그 칸에는 다시 치지 말고');
    expect(stopped).not.toContain(RRN);
    // 가짜는 줄을 받았고(실제 도우미는 SendInput을 묶음마다 한다) 넷 다 8자를 보낸 뒤 멈췄다
    expect(g.fake.typed()).toEqual(Array(4).fill(RRN));
    expect(g.fake.log().filter((e) => e.dir === 'out' && / ERR FOCUS_UNKNOWN sent=8$/.test(e.line))).toHaveLength(4);
    // 기록: 글은 없고 길이만, 대표 화면에도 글이 없다. 경고 활동 기록은 '치지 않음'이 아니라 보낸 글자 수를 말한다
    const rows = g.e.ctx.store.guiActions.query({ turnId, actions: ['type'], asc: true });
    expect(rows.map((r) => [r.result, r.text, r.textLength, r.dispatched])).toEqual(Array(4).fill(['secret_blocked', null, 13, true]));
    expect(g.e.core.desktop.recent({ limit: 50 }).actions.filter((a) => a.action === 'type').map((a) => a.text)).toEqual([null, null, null, null]);
    const warns = g.e.ctx.store.activity.search({ turnId, kinds: ['screen'], level: 'warn', limit: 50 }).map((w) => w.text);
    expect(warns).toEqual(Array(4).fill('화면 조작 멈춤 (type, secret_blocked): 치는 동안 포커스가 암호 칸이나 알 수 없는 곳으로 옮겨 감 — 13자 가운데 8자를 보냈고 일부가 그 칸에 들어갔을 수 있음'));
    expect(dump(g)).not.toContain(RRN);
  });

  it('같은 창의 보통 칸으로 옮겨 가면 그 칸에 이어 친다 — ok이고 답의 포커스는 다 친 뒤의 칸, 친 글은 남는다', async () => {
    // 같은 최상위 창(root)이다 — 실제 도우미는 창 핸들을 견주고 제목은 보지 않는다. 그 창의 제목은 페이지가 바꿨다 (S6-25 P2)
    const SAME_WINDOW = { ...FRONT, root: 'hwnd-form' };
    const NEXT = { ...SAME_WINDOW, title: '본인 확인 (뒷자리 보기) - Chrome', control: 'Edit' };
    const g = await bootGui({ focus: SAME_WINDOW, typeFocusAfter: { chars: 6, focus: NEXT } });
    open.push(g);
    const turnId = await liveMain(g.e);
    const c = await capture(g.e, turnId);
    const r = await input(g.e, turnId, { action: 'type', capture_id: c.data.capture_id, text: RRN });
    expect(r.ok ? (r.data as { focus: { title: string; password: boolean | null } }).focus : r.code).toMatchObject({ title: NEXT.title, password: false });
    const row = g.e.ctx.store.guiActions.query({ turnId, actions: ['type'] })[0]!;
    expect([row.result, row.text, row.focus?.title]).toEqual(['ok', RRN, NEXT.title]);
    // 가짜의 창 표시(root)는 답에 싣지 않는다 — 실제 도우미의 포커스 답과 같은 칸만
    expect(g.fake.log().filter((e) => e.dir === 'out' && e.line.includes('"root"'))).toEqual([]);
  });

  it('같은 프로그램(같은 PID)의 다른 최상위 창이 포커스를 가져가면 보통 칸이어도 멈춘다 — FOCUS_UNKNOWN sent=4, secret_blocked (실제 도우미처럼 창을 본다 — S6-25 P2, 검토 3차 R3-1)', async () => {
    // 지키는 것: 가짜가 창을 PID로만 보면 같은 프로그램의 결제·로그인 팝업 창으로 옮겨 가도 이어 쳐서, 실제 도우미에 없는 동작(ok)을 시험이 단언하게 된다
    const MAIN_WIN = { app: 'chrome', title: '주문서 - Chrome', pid: 5151, control: 'Edit', password: false as boolean | null, blocked: false, elevated: false };
    const POPUP_SAME_PID = { ...MAIN_WIN, title: '결제 인증 - Chrome', control: 'Edit' };
    const g = await bootGui({ focus: MAIN_WIN });
    open.push(g);
    assertFakeMain(g.e);
    const turnId = await liveMain(g.e);
    const c = await capture(g.e, turnId);
    g.fake.act({ do: 'set', value: { focus: MAIN_WIN, typeFocusAfter: { chars: 4, focus: POPUP_SAME_PID } } });
    await sleep(150);
    const r = await input(g.e, turnId, { action: 'type', capture_id: c.data.capture_id, text: 'abcdefghij' });
    const lastReply = g.fake
      .log()
      .filter((e) => e.dir === 'out' && /TYPE|FOCUS_UNKNOWN|^\S+ OK \{/.test(e.line))
      .map((e) => e.line.replace(/^\S+ /, ''))
      .at(-1);
    expect({ result: r.ok ? 'ok' : r.code, message: r.ok ? '' : r.message, lastReply }).toEqual({ result: 'secret_blocked', message: typeFocusMovedText(4, 6), lastReply: 'ERR FOCUS_UNKNOWN sent=4' });
    assertFakeMain(g.e);
  });

  it('마지막 묶음 뒤에 옮겨 갔으면 다 친 뒤 다시 읽은 포커스로 본다 — 암호 칸·모르는 포커스·포커스 없음이면 secret_blocked(글은 길이만, 그 포커스는 기록에)', async () => {
    const g = await bootGui({ focus: FRONT });
    open.push(g);
    const turnId = await liveMain(g.e);
    const c = await capture(g.e, turnId);
    const FRONT6 = RRN.slice(0, 6);
    const targets = [BACK_MASKED, { ...FRONT, password: null }, null];
    const codes: string[] = [];
    for (const to of targets) {
      // 6자 = 묶음 둘 — 둘째 묶음을 받은 뒤 옮긴다. 다음 묶음이 없으니 도우미는 다 친 뒤 다시 읽은 포커스를 OK에 싣는다
      g.fake.act({ do: 'set', value: { focus: FRONT, typeFocusAfter: { chars: 6, focus: to } } });
      await sleep(150);
      const r = await input(g.e, turnId, { action: 'type', capture_id: c.data.capture_id, text: FRONT6 });
      codes.push(r.ok ? 'ok' : r.code);
      if (!r.ok) expect(r.message).toBe('글을 치는 동안 포커스가 암호 칸이나 알 수 없는 곳으로 옮겨 갔습니다 — 6자를 보냈고 일부가 그 칸에 들어갔을 수 있습니다. 그 칸에는 다시 치지 마세요');
    }
    expect(codes).toEqual(['secret_blocked', 'secret_blocked', 'secret_blocked']);
    // 가짜는 셋 다 끝까지 쳤다 (OK — 멈춘 것이 없다) — 서버가 답의 포커스를 보고 secret_blocked로 끝냈다
    expect(g.fake.log().some((e) => e.dir === 'out' && /ERR /.test(e.line))).toBe(false);
    const rows = g.e.ctx.store.guiActions.query({ turnId, actions: ['type'], asc: true });
    expect(rows.map((r) => [r.result, r.text, r.textLength, r.focus === null ? 'none' : r.focus.password])).toEqual([
      ['secret_blocked', null, 6, true],
      ['secret_blocked', null, 6, null],
      ['secret_blocked', null, 6, 'none'],
    ]);
    expect(g.e.ctx.store.activity.search({ turnId, kinds: ['screen'], level: 'warn', limit: 50 }).map((w) => w.text)).toEqual(
      Array(3).fill('화면 조작 멈춤 (type, secret_blocked): 치는 동안 포커스가 암호 칸이나 알 수 없는 곳으로 옮겨 감 — 6자 가운데 6자를 보냈고 일부가 그 칸에 들어갔을 수 있음'),
    );
    expect(dump(g)).not.toContain(FRONT6);
    // 같은 글을 보통 칸에 치면 ok — 막은 것이 다 친 뒤의 포커스 때문이라는 증거
    g.fake.act({ do: 'set', value: { focus: FRONT } });
    await sleep(150);
    expect((await input(g.e, turnId, { action: 'type', capture_id: c.data.capture_id, text: FRONT6 })).ok).toBe(true);
  });

  it('검토 2차 R2-4: 치는 중에 앱이 포커스를 가려진 칸으로 옮긴 type은 secret_blocked이고, 친 글은 기록에도 대표 화면에도 남지 않는다 (치는 도중에 포커스를 바꿈)', async () => {
    const g = await bootGui({ focus: FRONT, typeChunkMs: 200 });
    open.push(g);
    const turnId = await liveMain(g.e);
    const c = await capture(g.e, turnId);
    // 70자 — 가짜는 4자 묶음마다 0.2초 쉰다. 첫 묶음 뒤 양식이 포커스를 가려진 칸으로 옮긴다
    const text = '가나다라마바사아자차'.repeat(7);
    const p = input(g.e, turnId, { action: 'type', capture_id: c.data.capture_id, text });
    await sleep(80);
    g.fake.act({ do: 'set', value: { focus: BACK_MASKED } });
    const r = await p;
    const row = g.e.ctx.store.guiActions.query({ turnId, asc: true }).find((x) => x.action === 'type')!;
    const shown = g.e.core.desktop.recent().actions.find((a) => a.id === row.id)!;
    assertFakeMain(g.e);
    expect({ result: r.ok ? 'ok' : r.code, recordedText: row.text, textLength: row.textLength, shownToOwner: shown.text }).toEqual({
      result: 'secret_blocked',
      recordedText: null,
      textLength: 70,
      shownToOwner: null,
    });
    expect(dump(g)).not.toContain(text);
  });
});
