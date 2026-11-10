/**
 * 화면 조작이 막는 키와 창 (SERVER_DESIGN 8.3.5 '막는 동작', 리드 결정 S6-8 — 10.6 guiDeniedTargets). 가짜 도우미만 쓴다.
 * - 막는 키 조합 (core/screenGuard.ts): Win+L(화면 잠금), Ctrl+Alt+Del('보낼 수 없습니다'), Ctrl+Alt+Shift+F12(사람의 멈춤 단축키), 붙여넣기(Ctrl+V·Ctrl+Shift+V·
 *   Shift+Insert·Win+V)는 denied_target이고 KEY 줄이 도우미에 가지 않는다. 대소문자·다른 이름(control·meta·del)으로 써도 같다. 읽지 못하는 조합은 invalid —
 *   도우미에 가지 않는다(막는 조합인지 볼 수 없다)
 * - 막는 창: ARM 때 넘기는 정책에 서버 PID·서버 콘솔 제목('욱채 서버 (pid N)')·'욱채'로 시작하는 제목이 들어 있고, 도우미가 그 창(과 관리자 권한 창)에 대한 클릭·
 *   끌기·키·글자를 거부하면 denied_target이다. screen_info는 그 창을 blocked로 표시한다. 거부마다 경고 활동 기록 한 줄(창 제목 없이)
 * - 바탕 화면·작업 표시줄의 Alt+F4(Windows 종료 창)는 포커스를 아는 도우미가 막는다 — 그 거부가 denied_target이 된다
 * - 서버의 조상 프로세스가 가진 콘솔 창은 도우미(DesktopHelper.cs)가 스스로 막는다 — 이 PC에서는 도우미를 띄우지 않으므로 소스의 약속만 본다 (컴파일은
 *   desktopHelperCompile)
 * - 고침 2차 (리드 결정 S6-23): Win 없는 Ctrl+Alt는 AltGr이라 글자 키(K1), TYPE은 4자마다 포커스를 다시 읽고 다 친 뒤의 포커스를 싣는다(K2) — 도우미 소스의 약속과,
 *   그 상수로 셈한 가장 늦은 TYPE이 서버의 시간 상한 안에 드는지
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { deniedKeyCombo, NON_PRINTABLE_KEYS, parseKeyCombo } from '@core/screenGuard';
import { MAIN_AGENT_ID, type Member } from '@shared/domain';
import { BackendError } from '../../src/main/backend/types';
import type { ScreenInfoResult } from '../../src/main/mcp/catalog';
import { serverWindowTitle } from '../../src/main/desktop/safety';
import { DESKTOP_TIMEOUTS } from '../../src/main/desktop/desktopHelper';
import { GUI_TYPE_MAX } from '../../src/main/desktop/service';
import type { HelperFocus, HelperWindow } from '../../src/main/desktop/types';
import { bootGui, capture, input, inputLines, liveMain, ok, type GuiEnv } from './guiRig';

const open: GuiEnv[] = [];
afterEach(async () => {
  for (const g of open.splice(0)) await g.close();
});

const win = (o: Partial<HelperWindow> & { title: string; pid: number; x: number }): HelperWindow => ({ app: 'app', y: 0, width: 200, height: 300, minimized: false, blocked: false, elevated: false, ...o });
/** 배율 1로 찍히는 화면 (캡처 좌표 = 실제 좌표) */
const SCREEN = [{ x: 0, y: 0, width: 1280, height: 720, dpi: 96, primary: true }];
const NOTEPAD: HelperFocus = { app: 'notepad', title: '제목 없음 - 메모장', pid: 4242, control: 'Edit', password: false, blocked: false, elevated: false };

describe('막는 키 조합 (순수 함수 — core/screenGuard.ts)', () => {
  it('Win+L·Ctrl+Alt+Del·멈춤 단축키·붙여넣기를 규칙마다 가려내고, 다른 조합은 통과한다', () => {
    const rule = (k: string) => deniedKeyCombo(k)?.rule ?? null;
    expect(['win+l', 'WIN+L', 'meta+l', 'super+L', 'win+shift+l'].map(rule)).toEqual(Array(5).fill('화면 잠금'));
    expect(['ctrl+alt+del', 'ctrl+alt+delete', 'Control+Alt+Delete', 'alt+ctrl+del', 'ctrl+alt+shift+del'].map(rule)).toEqual(Array(5).fill('Ctrl+Alt+Del'));
    expect(['ctrl+alt+shift+f12', 'shift+alt+ctrl+F12', 'Control+Alt+Shift+f12'].map(rule)).toEqual(Array(3).fill('멈춤 단축키'));
    expect(['ctrl+v', 'CTRL+V', 'control+v', 'ctrl+shift+v', 'shift+insert', 'shift+ins', 'win+v', 'meta+V'].map(rule)).toEqual(Array(8).fill('붙여넣기'));
    // 통과: 저장·복사·닫기·글자·AltGr 글자(ctrl+alt+v)·다른 F 키·Ctrl+Insert(복사)
    for (const k of ['ctrl+s', 'ctrl+c', 'alt+f4', 'enter', 'tab', 'v', 'shift+v', 'l', 'ctrl+alt+v', 'ctrl+alt+shift+f11', 'ctrl+shift+f12', 'ctrl+insert', 'delete', 'win+d', 'ctrl+l']) {
      expect([k, rule(k)]).toEqual([k, null]);
    }
    // 거부 글은 사실과 대신 할 일을 말한다
    expect(deniedKeyCombo('ctrl+alt+del')?.text).toContain('보낼 수 없습니다');
    expect(deniedKeyCombo('ctrl+v')?.text).toContain('gui_input type');
  });

  it('도우미와 같은 법으로 읽는다 — 수정 키로 끝나거나, 모르는 이름이거나, 빈 낱말이 있으면 읽지 못한다(null)', () => {
    for (const bad of ['', 'ctrl+', '+v', 'ctrl++v', 'ctrl', 'shift', 'ctrl+alt', 'foo+v', 'ctrl+nokey', 'ctrl+v+c', 'ctrl+가', 'a b', 'x'.repeat(61)]) {
      expect([bad, parseKeyCombo(bad)]).toEqual([bad, null]);
    }
    expect(parseKeyCombo('Ctrl+Shift+S')).toMatchObject({ key: 's', char: true });
    expect([...parseKeyCombo('Ctrl+Shift+S')!.mods].sort()).toEqual(['ctrl', 'shift']);
    expect(parseKeyCombo('DEL')).toMatchObject({ key: 'delete', char: false });
    expect(parseKeyCombo('f24')).toMatchObject({ key: 'f24', char: false });
    expect(parseKeyCombo('+')).toBeNull();
  });
});

describe('gui_input — 막는 키 조합은 도우미에 가지 않는다 (denied_target)', () => {
  it('막는 조합은 denied_target, 읽지 못하는 조합은 invalid — 어느 것도 KEY 줄을 보내지 않고, 다른 조합은 보낸다', async () => {
    const g = await bootGui();
    open.push(g);
    const turnId = await liveMain(g.e);
    const c = await capture(g.e, turnId);
    const key = (keys: string) => input(g.e, turnId, { action: 'key', capture_id: c.data.capture_id, keys });
    const denied = ['win+l', 'ctrl+alt+del', 'Control+Alt+Delete', 'ctrl+alt+shift+f12', 'ctrl+v', 'CTRL+SHIFT+V', 'shift+insert', 'win+v'];
    for (const k of denied) expect([k, await key(k)]).toMatchObject([k, { ok: false, code: 'denied_target' }]);
    for (const k of ['ctrl+', 'foo+v', 'ctrl+nokey', 'shift']) expect([k, await key(k)]).toMatchObject([k, { ok: false, code: 'invalid' }]);
    expect(inputLines(g.fake)).toEqual([]);
    // 통과하는 조합은 그대로 간다 — 그 길이 실제로 돈다는 증거
    for (const k of ['ctrl+s', 'enter', 'alt+f4']) expect([k, (await key(k)).ok]).toEqual([k, true]);
    expect(inputLines(g.fake).map((l) => l.split(' ').slice(0, 2).join(' '))).toEqual(['KEY ctrl+s', 'KEY enter', 'KEY alt+f4']);
    // 기록: 거부마다 한 줄(보내지 않음), 막는 조합마다 경고 활동 기록 한 줄
    const rows = g.e.ctx.store.guiActions.query({ turnId, actions: ['key'], asc: true });
    expect(rows.map((r) => [r.result, r.dispatched])).toEqual([...denied.map(() => ['denied_target', false]), ...Array(4).fill(['invalid', false]), ...Array(3).fill(['ok', true])]);
    expect(g.e.ctx.store.activity.search({ turnId, kinds: ['screen'], level: 'warn', limit: 50 })).toHaveLength(denied.length);
  });
});

describe('막는 창 — 서버·욱채 화면·관리자 권한 창 (denied_target)', () => {
  const WINDOWS = [
    win({ title: serverWindowTitle(process.pid), app: 'cmd', pid: 7001, x: 0 }),
    win({ title: '아무 제목', app: 'node', pid: process.pid, x: 250 }),
    win({ title: '욱채 — 대표 화면', app: 'chrome', pid: 7003, x: 500 }),
    win({ title: '관리자: 명령 프롬프트', app: 'cmd', pid: 7004, x: 750, elevated: true }),
    win({ title: '제목 없음 - 메모장', app: 'notepad', pid: 4242, x: 1000 }),
  ];

  it('ARM 때 넘기는 정책에 서버 PID·서버 콘솔 제목·욱채 화면 제목이 들어 있고, 그 창과 관리자 권한 창의 클릭·끌기는 거부된다. screen_info는 blocked로 표시한다', async () => {
    const g = await bootGui({ screens: SCREEN, windows: WINDOWS, focus: NOTEPAD });
    open.push(g);
    const turnId = await liveMain(g.e);
    const c = await capture(g.e, turnId);
    // 도우미가 받은 정책 (ARM <base64>)
    const arm = g.fake.received().find((l) => / ARM /.test(l))!;
    const policy = Buffer.from(arm.split(' ')[2]!, 'base64').toString('utf8').split('\n');
    expect(policy).toEqual(expect.arrayContaining([`pid ${process.pid}`, `title 욱채 서버 (pid ${process.pid})`, 'prefix 욱채']));
    const click = (x: number) => input(g.e, turnId, { action: 'click', capture_id: c.data.capture_id, x, y: 100 });
    const results = [];
    for (const x of [100, 350, 600, 850]) results.push(await click(x));
    expect(results).toMatchObject(Array(4).fill({ ok: false, code: 'denied_target' }));
    expect(results.map((r) => (r.ok ? '' : r.message)).filter((m) => m.includes('관리자 권한'))).toHaveLength(1);
    // 막힌 창으로 끄는 것도 (끝점)
    expect(await input(g.e, turnId, { action: 'drag', capture_id: c.data.capture_id, x: 1100, y: 100, x2: 100, y2: 100 })).toMatchObject({ ok: false, code: 'denied_target' });
    // 메모장은 된다
    expect((await click(1100)).ok).toBe(true);
    // 기록에는 거부가 남고 창 제목은 경고 활동 기록에 없다
    const rows = g.e.ctx.store.guiActions.query({ turnId, actions: ['click', 'drag'], asc: true });
    expect(rows.map((r) => r.result)).toEqual(['denied_target', 'denied_target', 'denied_target', 'denied_target', 'denied_target', 'ok']);
    const warns = g.e.ctx.store.activity.search({ turnId, kinds: ['screen'], level: 'warn', limit: 50 });
    expect(warns).toHaveLength(5);
    expect(warns.some((w) => w.text.includes('대표 화면') || w.text.includes('명령 프롬프트'))).toBe(false);
    // screen_info: 막는 창과 관리자 권한 창은 blocked
    g.clock.advance(1100);
    const info = ok<ScreenInfoResult>(await g.e.tool(turnId, 'screen_info', {}));
    expect(info.windows.map((w) => w.blocked)).toEqual([true, true, true, true, false]);
  });

  it('포커스가 막힌 창이면 키·글자도 거부되고, 바탕 화면·작업 표시줄의 Alt+F4도 거부된다', async () => {
    const g = await bootGui({ screens: SCREEN, windows: WINDOWS, focus: { ...NOTEPAD, title: '욱채 — 대표 화면', app: 'chrome', pid: 7003 } });
    open.push(g);
    const turnId = await liveMain(g.e);
    const c = await capture(g.e, turnId);
    const id = c.data.capture_id;
    expect(await input(g.e, turnId, { action: 'key', capture_id: id, keys: 'enter' })).toMatchObject({ ok: false, code: 'denied_target' });
    expect(await input(g.e, turnId, { action: 'type', capture_id: id, text: '정지 해제' })).toMatchObject({ ok: false, code: 'denied_target' });
    expect(g.fake.typed()).toEqual(['정지 해제']); // 가짜 도우미는 줄을 받고 거부한다 (실제 도우미는 SendInput 전에 거부한다)
    // 바탕 화면이 포커스일 때의 Alt+F4 (Windows 종료 창)
    g.fake.act({ do: 'set', value: { focus: { app: 'explorer', title: 'Program Manager', pid: 900, control: null, password: false, blocked: false, elevated: false, shell: true } as HelperFocus } });
    await new Promise((r) => setTimeout(r, 150));
    const shell = await input(g.e, turnId, { action: 'key', capture_id: id, keys: 'alt+f4' });
    expect(shell).toMatchObject({ ok: false, code: 'denied_target' });
    if (!shell.ok) expect(shell.message).toContain('Alt+F4');
    // 다른 키는 바탕 화면에도 간다
    expect((await input(g.e, turnId, { action: 'key', capture_id: id, keys: 'f5' })).ok).toBe(true);
  });
});

describe('화면 도구는 메인 에이전트만 — 처리기도 신원을 다시 본다 (S6-14, S6-21 J3)', () => {
  it('팀원 신원으로 처리기를 직접 부르면 다섯 도구 모두 forbidden이고, 기록에도 도우미에도 아무것도 남지 않는다', async () => {
    const g = await bootGui();
    open.push(g);
    const { e } = g;
    const turnId = await liveMain(e);
    const c = await capture(e, turnId);
    const main = e.ctx.store.members.require(MAIN_AGENT_ID);
    // 도구 목록·역할 검사(앱 도구 서버, tools.run)를 지나쳤다고 치고 처리기에 닿은 팀원
    const member: Member = { ...main, id: 'M-0099', isMain: false };
    const identity = { ...e.identity(turnId), memberId: member.id, isMain: false };
    const guards = { assertNotStopped: () => undefined, recheck: () => undefined };
    const d = e.core.desktop;
    const click = { action: 'click', capture_id: c.data.capture_id, x: 5, y: 5 };
    const rowsBefore = e.ctx.store.guiActions.query({}).length;
    const linesBefore = g.fake.received().length;
    const calls: [string, () => Promise<unknown>][] = [
      ['screen_capture', () => d.capture(identity, member, {}, guards)],
      ['screen_info', () => d.info(identity, member, {}, guards)],
      ['gui_input', () => d.input(identity, member, click, 'rq-member-1', guards)],
      ['get_screen_check', () => d.getCheck(identity, member)],
      ['answer_screen_check', () => d.answerCheck(identity, member, { code: '0000' })],
    ];
    for (const [tool, call] of calls) {
      const err: unknown = await call().then(
        () => null,
        (x: unknown) => x,
      );
      expect([tool, err instanceof BackendError ? err.code : err]).toEqual([tool, 'forbidden']);
    }
    expect(e.ctx.store.guiActions.query({}).length).toBe(rowsBefore);
    expect(g.fake.received().length).toBe(linesBefore);
    expect(d.reachedHandler(click)).toBe(false);
    // 같은 호출이 메인 신원이면 된다 — 막은 것이 신원이라는 증거
    expect((await d.input(e.identity(turnId), main, { ...click, then_capture: false }, 'rq-member-2', guards)).data).toMatchObject({ action: 'click' });
    expect(inputLines(g.fake)).toHaveLength(1);
  });
});

describe('서버 창을 가려내는 약속 — 서버 쪽과 도우미 소스', () => {
  it('서버는 콘솔 창 제목을 정하고(process.title), 도우미는 조상 프로세스의 콘솔 창을 막는다 — 조상을 구하지 못하면 콘솔 창을 모두 막는다', () => {
    const serve = readFileSync(join(process.cwd(), 'src', 'server', 'serve.ts'), 'utf8');
    expect(serve).toContain('process.title = serverWindowTitle(process.pid);');
    expect(serverWindowTitle(1234)).toBe('욱채 서버 (pid 1234)');
    const cs = csCode();
    // 창 사실을 만들 때마다 조상 프로세스의 창인지 본다 — 창 종류와 상관없이 (S6-21 E3: 콘솔 종류 세 개만 보던 것을 넓혔다)
    expect(cs).toContain('f.Blocked = pol.Blocks(f.Pid, f.Title) || IsAncestorWindow(f);');
    const rule = between(cs, 'private static bool IsAncestorWindow(WinFacts f)', 'private static HashSet<uint> AncestorPids()');
    expect(rule).toContain('return chain.Contains(f.Pid);');
    // 조상을 구하지 못했으면(null) 콘솔 종류의 창을 모두 막는다 — 막는 쪽
    expect(rule).toContain('if (chain == null) return f.Class == "ConsoleWindowClass" || f.Class == "PseudoConsoleWindow" || f.Class == "CASCADIA_HOSTING_WINDOW_CLASS";');
    // 조상의 창을 창 종류로 거르지 않는다 (종류 검사는 조상을 구하지 못했을 때의 그 한 줄뿐)
    expect(rule.match(/f\.Class/g)).toHaveLength(3);
    // 시작할 때 한 번 구한다 (프로세스를 띄우지 않고 Toolhelp 목록만 읽는다), 다시 쓰인 PID에서 멈춘다. Windows 셸(explorer.exe)은 넣지 않는다
    expect(cs).toContain('ancestorPids = AncestorPids();');
    const walk = between(cs, 'private static HashSet<uint> AncestorPids()', 'private static long ProcessStartTime(uint pid)');
    expect(walk).toContain('if (parentStart > 0 && curStart > 0 && parentStart > curStart) break;');
    expect(walk).toContain('bool shell = exeOf.TryGetValue(parent, out exe) && string.Equals(exe, "explorer.exe", StringComparison.OrdinalIgnoreCase);');
    expect(walk).toContain('if (!shell) chain.Add(parent);');
    expect(walk).toContain('return foundParent ? chain : null;');
    // 도우미도 사람의 멈춤 단축키·잠금·SAS를 한 번 더 막는다
    expect(cs).toContain('if (combo.Denied) return "ERR BLOCKED_TARGET key";');
  });

  it('도우미 소스 — 글자 키는 빼는 쪽으로, 메인이 준 조합으로 정하고(S6-21 B2), TYPE은 제어 문자를 거부하며 탭·줄바꿈을 키로 바꾸지 않는다(B1)', () => {
    const cs = csCode();
    const parse = between(cs, 'internal static KeyCombo Parse(string text)', 'internal static Native.INPUT KeyInput(ushort vk, bool up)');
    // 글자 키 판정은 자판 배열이 더하는 수정 키(VkKeyScanW의 Ctrl+Alt — AltGr)보다 먼저 쥔 값으로 한다. Win 없이 Ctrl+Alt를 함께 쓴 조합은 AltGr이라 글자 키다
    // (S6-23 K1 — 예전 'bool askedShortcut = ctrl || alt || win;'은 Ctrl+Alt+Q를 단축키로 보아 암호 칸에 보냈다)
    expect(parse).toContain('bool askedAltGr = ctrl && alt && !win;');
    expect(parse).toContain('bool askedShortcut = (ctrl || alt || win) && !askedAltGr;');
    expect(parse).not.toContain('bool askedShortcut = ctrl || alt || win;');
    expect(parse.indexOf('bool askedAltGr = ctrl && alt && !win;')).toBeLessThan(parse.indexOf('bool askedShortcut = (ctrl || alt || win) && !askedAltGr;'));
    expect(parse.indexOf('bool askedShortcut = (ctrl || alt || win) && !askedAltGr;')).toBeLessThan(parse.indexOf('Native.VkKeyScanW(ch)'));
    expect(parse.match(/askedAltGr/g)).toHaveLength(2);
    expect(parse).toContain('c.Printable = !askedShortcut && !NonPrintable.Contains(named);');
    expect(parse).toContain('c.Printable = !askedShortcut;');
    // 보내는 조합(메인의 수정 키 + 배열이 더한 수정 키)이 Win 없는 Ctrl+Alt면 글자 키다 — 'alt+@'(배열이 Ctrl+Alt를 채워 AltGr+Q가 된다)도 막는다. 막는 쪽으로만
    // 넓힌다(true로만 바꾼다) — 수정 키를 다 모은 뒤, 보내는 수정 키를 정하기 전에
    expect(parse).toContain('if (ctrl && alt && !win && !NonPrintable.Contains(c.Vk)) c.Printable = true;');
    expect(parse.indexOf('c.Printable = true;')).toBeGreaterThan(parse.indexOf('Native.VkKeyScanW(ch)'));
    expect(parse.indexOf('c.Printable = true;')).toBeLessThan(parse.indexOf('if (ctrl) c.Mods.Add(0x11);'));
    // 예전 규칙(글자 하나와 space만 글자 키, 배열이 더한 Ctrl·Alt로 글자 키가 아니게 됨)은 없다
    expect(parse).not.toContain('named == 0x20');
    expect(parse).not.toContain('c.Printable = false');
    expect(parse.match(/c\.Printable = /g)).toHaveLength(3);
    // 이동·기능 키 목록 (가상 키 코드) — core/screenGuard.ts NON_PRINTABLE_KEYS와 같은 키들
    const VK: Record<string, number> = { enter: 0x0d, tab: 0x09, esc: 0x1b, backspace: 0x08, delete: 0x2e, insert: 0x2d, home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22, up: 0x26, down: 0x28, left: 0x25, right: 0x27, printscreen: 0x2c, menu: 0x5d, capslock: 0x14 };
    const listed = /NonPrintable = new HashSet<ushort>\(new ushort\[\] \{([^}]*)\}\);/.exec(cs)?.[1]?.split(',').map((x) => Number(x.trim())) ?? [];
    expect([...listed].sort((a, b) => a - b)).toEqual(Object.values(VK).sort((a, b) => a - b));
    expect([...NON_PRINTABLE_KEYS].filter((k) => !/^f\d+$/.test(k)).sort()).toEqual(Object.keys(VK).sort());
    expect(cs).toContain('NonPrintable.Add((ushort)(0x70 + i - 1));');
    // plus(0xBB)·minus(0xBD)·space(0x20)는 그 목록에 없다 — 글자 키다
    for (const vk of [0xbb, 0xbd, 0x20]) expect(listed).not.toContain(vk);
    // 암호 칸·모르는 포커스 검사는 글자 키일 때 돈다. 막는 조합(Ctrl+Alt+Del 등 — 이제 글자 키로 읽히는 Ctrl+Alt 조합도 있다)은 그보다 먼저 거부한다
    const doKey = between(cs, 'private static string DoKey(string args)', 'private static string DoType(string args)');
    expect(doKey).toMatch(/if \(combo\.Printable\)\s*\{[\s\S]*?if \(u == null\) return "ERR FOCUS_UNKNOWN";\s*if \(u\.Password\) return "ERR PASSWORD_FIELD";/);
    expect(doKey.indexOf('if (combo.Denied) return "ERR BLOCKED_TARGET key";')).toBeGreaterThan(0);
    expect(doKey.indexOf('if (combo.Denied) return "ERR BLOCKED_TARGET key";')).toBeLessThan(doKey.indexOf('if (combo.Printable)'));
    // TYPE: 제어 문자가 든 글은 포커스를 보기 전에 거부하고, 글자는 모두 유니코드 입력으로 보낸다 (Tab 0x09·Enter 0x0D 키로 바꾸지 않는다)
    const doType = between(cs, 'private static string DoType(string args)', 'internal sealed class KeyCombo');
    expect(doType).toContain('if (KeyMap.HasControl(text)) return "ERR BAD_TEXT";');
    expect(doType.indexOf('KeyMap.HasControl(text)')).toBeLessThan(doType.indexOf('InputGate('));
    expect(cs).toContain('if (ch < 0x20 || ch == 0x7F) return true;');
    const textInputs = between(cs, 'internal static List<Native.INPUT> TextInputs(string text)', 'internal static class Mouse');
    expect(textInputs).not.toMatch(/KeyInput\(/);
    expect(textInputs).not.toMatch(/0x0D|0x09|'\\n'|'\\r'|'\\t'/);
    expect(textInputs.match(/UnicodeInput\(ch, (false|true)\)/g)).toHaveLength(2);
  });

  it('도우미 소스 — TYPE은 4자씩 보내고 둘째 묶음부터 보내기 전에 포커스를 다시 읽어 암호 칸·모름이면 멈추며, 다 친 뒤 다시 읽은 포커스를 OK에 싣는다 (S6-23 K2). 서버의 TYPE 시간 상한은 가장 늦은 경우보다 길다', () => {
    const cs = csCode();
    const doType = between(cs, 'private static string DoType(string args)', 'internal sealed class KeyCombo');
    // 묶음: 글자 4개 — 서로게이트 쌍은 한 글자로 세고 나누지 않는다
    expect(doType).toContain('private const int TypeUnitChars = 4;');
    expect(doType).toContain('int end = KeyMap.UnitEnd(text, sent, TypeUnitChars);');
    const unitEnd = between(cs, 'internal static int UnitEnd(string text, int start, int chars)', 'internal static List<Native.INPUT> TextInputs(string text)');
    expect(unitEnd).toContain('for (int c = 0; c < chars && i < text.Length; c++)');
    expect(unitEnd).toContain('bool pair = char.IsHighSurrogate(text[i]) && i + 1 < text.Length && char.IsLowSurrogate(text[i + 1]);');
    expect(unitEnd).toContain('i += pair ? 2 : 1;');
    // 보낸 양(sent)은 UTF-16 단위다 — 누름·뗌 쌍의 자리와 같다
    expect(doType).toContain('Native.INPUT[] chunk = new Native.INPUT[(end - sent) * 2];');
    expect(doType).toContain('inputs.CopyTo(sent * 2, chunk, 0, chunk.Length);');
    // 예전의 32자 묶음(누름·뗌 64개)은 없다
    expect(doType).not.toMatch(/\+= 64|Math\.Min\(64/);
    // 둘째 묶음부터: 최상위 창 → 포커스 다시 읽기(암호 칸·모름이면 멈춤) → 멈춤·사람 입력 → 보내기, 이 순서로 묶음마다
    const loop = between(doType, 'while (sent < text.Length)', 'Thread.Sleep(30);');
    const order = [
      'if (sent > 0)',
      'if (fg == IntPtr.Zero || Native.GetAncestor(fg, 2) != f.Root) return "ERR FOCUS_UNKNOWN sent=" + sent;',
      'UiaFocus now = QueryFocus(TypeRecheckMs);',
      'if (now == null || now.Password) return "ERR FOCUS_UNKNOWN sent=" + sent;',
      'string stop = Aborted(token, human);',
      'if (stop != null) return stop + " sent=" + sent;',
      'if (!Inject(chunk, token)) return (Aborted(token, human) ?? "ERR RELEASED") + " sent=" + sent;',
      'sent = end;',
    ];
    const at = order.map((s) => loop.indexOf(s));
    expect(order.filter((_, i) => at[i]! < 0)).toEqual([]);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    // 다 친 뒤 포커스를 다시 읽어 OK에 싣는다 — 치기 전에 읽은 포커스(u)를 싣지 않는다
    expect(doType).toContain('UiaFocus last = QueryFocus(1500);');
    expect(doType).toContain('return "OK " + FocusJson(ForegroundFacts(), last);');
    expect(doType).not.toContain('FocusJson(ForegroundFacts(), u)');
    expect(doType.match(/return "OK /g)).toHaveLength(1);
    // UI Automation 이벤트 처리기는 쓰지 않는다 — 다시 읽기는 처음 읽기와 같은 QueryFocus다
    expect(cs).not.toMatch(/Automation\.Add|AutomationFocusChangedEventHandler|Automation\.Remove/);
    expect(doType.match(/QueryFocus\(/g)).toHaveLength(3);

    // 시간 상한: 도우미의 상수로 가장 늦은 경우를 셈해 서버의 TYPE 상한(TYPE + 글자당 TYPE_PER_CHAR)과 견준다. Thread.Sleep은 Windows 타이머 때문에 16ms까지
    // 걸린다고 보고, 묶음마다 일꾼 스레드 띄우기·보내기에 10ms, 앞 검사(잠김·배치·창)에 200ms를 더한다. 1.15배 넘게 남아야 한다
    const num = (re: RegExp): number => Number(re.exec(doType)?.[1] ?? Number.NaN);
    const unit = num(/private const int TypeUnitChars = (\d+);/);
    const recheck = num(/private const int TypeRecheckMs = (\d+);/);
    const firstCap = num(/UiaFocus u = QueryFocus\((\d+)\);/);
    const lastCap = num(/UiaFocus last = QueryFocus\((\d+)\);/);
    const nap = num(/if \(sent > 0\)\s*\{\s*Thread\.Sleep\((\d+)\);/);
    const tail = num(/Thread\.Sleep\((\d+)\);\s*UiaFocus last/);
    expect([unit, recheck, firstCap, lastCap, nap, tail]).toEqual([4, 250, 1500, 1500, 5, 30]);
    const worst = (n: number): number => 200 + firstCap + (Math.ceil(n / unit) - 1) * (Math.max(nap, 16) + recheck + 10) + Math.max(tail, 16) + lastCap;
    const limit = (n: number): number => DESKTOP_TIMEOUTS.TYPE + DESKTOP_TIMEOUTS.TYPE_PER_CHAR * n;
    for (const n of [1, 4, 5, 50, 500, GUI_TYPE_MAX]) expect([n, limit(n) >= worst(n) * 1.15]).toEqual([n, true]);
    // 글 상한에서: 가장 늦은 경우 약 141초, 상한 165초
    expect([Math.round(worst(GUI_TYPE_MAX) / 1000), limit(GUI_TYPE_MAX) / 1000]).toEqual([141, 165]);
  });

  it('도우미 소스 — 무장과 해제의 전환은 잠금 하나로 세우고(S6-21 F2), 멈춤 단축키는 ARM마다 다시 걸어 보며 걸지 못한 동안 띠에 단축키 글을 쓰지 않는다(D)', () => {
    const cs = csCode();
    // 해제 셋(RELEASE·STOP·멈춤 단축키)과 끝내기는 같은 시작(BeginDisarm — armLock 안에서 무장을 풀고 도는 명령을 멈춘다)을 거친다
    const begin = between(cs, 'private static long BeginDisarm(string reason)', 'internal static bool TryArm(long before, long seed)');
    expect(begin).toMatch(/lock \(armLock\)\s*\{\s*armed = false;\s*Interlocked\.Exchange\(ref armSeed, -1\);\s*Abort\(reason\);\s*return Interlocked\.Read\(ref abortSeq\);\s*\}/);
    for (const [fn, next, reason] of [
      ['private static void DoStop()', 'private static void DoRelease(string id)', 'STOPPED'],
      ['private static void DoRelease(string id)', 'internal static void OnHotkey()', 'RELEASED'],
      ['internal static void OnHotkey()', 'internal static int ReleaseAll()', 'HUMAN_ACTIVE hotkey'],
      ['private static void Shutdown()', 'private static void RawLine(string text)', 'STOPPED'],
    ] as const) {
      const body = between(cs, fn, next);
      expect([fn, body.includes(`long seq = BeginDisarm("${reason}");`)]).toEqual([fn, true]);
      // 잠금 밖에서 armed를 직접 바꾸지 않는다
      expect([fn, /armed = (true|false)/.test(body)]).toEqual([fn, false]);
    }
    // 무장은 화면 스레드가 훅을 건 같은 단계에서, 같은 잠금 안에서 정한다: ARM을 시작할 때 쥔 abortSeq가 달라졌으면 무장하지 않는다
    const tryArm = between(cs, 'internal static bool TryArm(long before, long seed)', 'internal static bool ConfirmDisarm(long seq)');
    expect(tryArm).toMatch(/lock \(armLock\)\s*\{\s*if \(stopped \|\| Interlocked\.Read\(ref abortSeq\) != before\) return false;[\s\S]*armedSeq = before;\s*armed = true;\s*return true;\s*\}/);
    // armed = true는 그 한 곳뿐이다
    expect(cs.match(/armed = true;/g)).toHaveLength(1);
    const doArm = between(cs, 'private static string DoArm(string args)', 'private static string DoCapture(string args)');
    expect(doArm).toContain('long before = Interlocked.Read(ref abortSeq);');
    expect(doArm.indexOf('long before = Interlocked.Read(ref abortSeq);')).toBeLessThan(doArm.indexOf('Ui.Arm(700, before, seed)'));
    // 무장하지 못했으면 훅·표시를 끄고 오류로 답한다 — 그사이 해제가 지나갔으면 그 까닭으로
    expect(doArm).toMatch(/if \(result == Ui\.ArmOk\)\s*\{\s*return "OK seed="/);
    expect(doArm).toMatch(/long seq = CancelArm\(\);\s*Ui\.Disarm\(300, seq\);\s*if \(stopped\) return "ERR STOPPED";\s*if \(result == Ui\.ArmAborted\)\s*\{\s*lock \(sendLock\) \{ return "ERR " \+ abortReason; \}/);
    const uiArm = between(cs, 'internal static int Arm(int waitMs, long before, long seed)', 'internal static void Disarm(int waitMs, long seq)');
    expect(uiArm.indexOf('SetWindowsHookExW(13')).toBeLessThan(uiArm.indexOf('Helper.TryArm(before, seed)'));
    expect(uiArm.indexOf('Helper.TryArm(before, seed)')).toBeLessThan(uiArm.indexOf('ShowOverlays();'));
    // 늦게 도착한 해제는 그 뒤의 새 무장을 풀지 않는다
    const confirm = between(cs, 'internal static bool ConfirmDisarm(long seq)', 'private static long CancelArm()');
    expect(confirm).toMatch(/lock \(armLock\)\s*\{\s*if \(armed && armedSeq >= seq\) return false;\s*armed = false;\s*return true;\s*\}/);
    expect(between(cs, 'internal static void DisarmHere(long seq)', 'private static void ShowOverlays()')).toMatch(/^[^;]*\{\s*if \(!Helper\.ConfirmDisarm\(seq\)\) return;/);

    // 멈춤 단축키: 시작할 때와 ARM마다 등록해 본다 (이미 걸었으면 그대로)
    const ensure = between(cs, 'private static void EnsureHotkey()', 'internal const int ArmOk = 0;');
    expect(ensure).toContain('if (HotkeyRegistered || pump == null) return;');
    expect(ensure).toContain('HotkeyRegistered = Native.RegisterHotKey(pump.Handle, 1, 0x0001u | 0x0002u | 0x0004u | 0x4000u, 0x7Bu);');
    expect(cs.match(/Native\.RegisterHotKey\(/g)).toHaveLength(1);
    expect(uiArm.trimStart().split('\n').findIndex((l) => l.includes('EnsureHotkey();'))).toBeGreaterThan(0);
    expect(uiArm.indexOf('EnsureHotkey();')).toBeLessThan(uiArm.indexOf('Helper.TryArm(before, seed)'));
    expect(between(cs, 'internal static bool Start()', 'private static bool OnUi(MethodInvoker a, int waitMs)')).toContain('EnsureHotkey();');
    expect(doArm).toContain('" hotkey=" + (Ui.HotkeyRegistered ? "1" : "0")');
    // 띠: 단축키 글은 등록했을 때만 붙인다
    expect(cs).toContain('private const string BandBase = "욱채 메인 에이전트가 화면을 조작 중";');
    expect(cs).toContain('private const string BandHotkey = " · Ctrl+Alt+Shift+F12로 멈춤";');
    expect(cs).toContain('string label = hotkey ? BandBase + BandHotkey : BandBase;');
    expect(cs).toContain('f.SetHotkey(HotkeyRegistered);');
    expect(cs.match(/F12로 멈춤/g)).toHaveLength(1);
  });
});

/** 도우미 소스에서 주석을 뺀 코드 (약속 검사는 코드만 본다) */
function csCode(): string {
  return readFileSync(join(process.cwd(), 'resources', 'desktophelper', 'DesktopHelper.cs'), 'utf8')
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, '').trimEnd())
    .join('\n');
}

/** from부터 to 앞까지 (둘 다 한 번씩 있어야 한다) */
function between(text: string, from: string, to: string): string {
  const a = text.indexOf(from);
  const b = text.indexOf(to, a + from.length);
  if (a < 0 || b < 0) throw new Error(`도우미 소스에서 찾지 못했습니다: ${a < 0 ? from : to}`);
  return text.slice(a, b);
}
