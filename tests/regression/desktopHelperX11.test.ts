/**
 * X11 화면 도우미 (S10c, 리드 결정 S10-7) — 진짜 도우미 스크립트(resources/desktophelper/x11Helper.mjs)를 가짜 X 도구·가짜 곁 도우미·가짜 /proc으로 띄워
 * 프로토콜 3판의 명령마다 도구 인자와 답을 본다. X 서버에는 붙지 않는다 (Windows·WSL). 실제 X11 동작은 tests/real/realDesktop.linux.test.ts가 Xvfb에서 본다.
 * 함께 보는 것: 클라이언트(desktopHelper.ts)의 READY 끝 낱말·FAIL NO_DESKTOP 사유 글, 자식 환경에서 화면 변수 빼기(agents/common.ts), 스크립트 고정(process/scriptTool.ts).
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { buildChildEnv, buildHostExecEnv } from '../../src/main/agents/common';
import { NO_DESKTOP_TEXT, NO_DESKTOP_TEXTS } from '../../src/main/desktop/desktopHelper';
import type { DesktopHelperClient, DesktopHelperEvent, HelperFailure, HelperResult } from '../../src/main/desktop/types';
import { checkPinned } from '../../src/main/process/pinnedFile';
import { ensurePinnedScript, realX11GateOpen, x11LaunchRefusal, X11_HELPER_SCRIPT } from '../../src/main/process/scriptTool';
import { createX11DesktopLauncher, missingToolsText, resolveX11Tools } from '../../src/main/desktop/x11Launcher';
import { x11ScreenCheck } from '../../src/main/desktop/x11Check';
import { SCREEN_SESSION_TEXT, screenSession } from '../../src/main/desktop/screenSession';
import { parseServerConfig } from '../../src/server/config';
import { gatherLinuxDeploy, linuxScreenItem, type LinuxExec, type LinuxGatherDeps } from '../../src/server/deployCheckLinux';
import { createFakeX11, type FakeX11, type FakeX11Options, type FakeX11Scene } from '../fixtures/desktop/fakeX11';

const live: { fake: FakeX11; client: DesktopHelperClient }[] = [];
afterEach(async () => {
  for (const { fake, client } of live.splice(0)) {
    await client.dispose().catch(() => undefined);
    await fake.cleanup();
  }
});

function boot(patch: Partial<FakeX11Scene> = {}, o: FakeX11Options = {}) {
  const fake = createFakeX11(patch, o);
  const events: DesktopHelperEvent[] = [];
  const client = fake.client();
  client.onEvent((e) => events.push(e));
  live.push({ fake, client });
  return { fake, client, events };
}

const ok = <T>(r: { ok: true; value: T } | HelperFailure): T => {
  if (!r.ok) throw new Error(`실패: ${JSON.stringify(r)}`);
  return r.value;
};
const err = (r: HelperResult<unknown>): string => (r.ok ? 'OK' : r.kind === 'err' ? `${r.reason}${r.detail ? ` ${r.detail}` : ''}${r.sent !== null ? ` sent=${r.sent}` : ''}` : `${r.kind}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const POLICY = { pids: [], titles: [], titlePrefixes: ['욱채'] };

async function armed(c: DesktopHelperClient): Promise<string> {
  const layout = ok(await c.request({ verb: 'SCREENS' })).layout;
  ok(await c.request({ verb: 'ARM', policy: POLICY }));
  return layout;
}

describe('X11 화면 도우미: 시작 (READY·FAIL — S10-7.1·S10-7.7·S10-7.11)', () => {
  it('READY는 판 3 그대로이고 끝에 virtual·sidecar·a11y를 더한다 — 클라이언트는 받아들이고 가상 화면을 안다', async () => {
    // 잡는 결함: 클라이언트가 끝 낱말 때문에 READY를 판 불일치로 거부 · 가상 화면 표시를 잃음
    const { client } = boot({}, { sidecar: true });
    const r = await client.ready();
    expect(r.ok).toBe(true);
    const info = client.readyInfo()!;
    expect(info).toMatchObject({ version: 3, screens: 1, locked: false, wda: true, build: 0, virtual: true });
    expect(info.tokens).toEqual({ virtual: '1', sidecar: '1', a11y: '1' });
  }, 60_000);

  it('곁 도우미가 없으면 sidecar=0 a11y=0(그 까닭 sidecarwhy — FSD-5), Xvfb가 아니면 virtual=0 — 사실대로', async () => {
    const { client } = boot({ virtual: false });
    expect((await client.ready()).ok).toBe(true);
    expect(client.readyInfo()!.tokens).toEqual({ virtual: '0', sidecar: '0', a11y: '0', sidecarwhy: 'none' });
    expect(client.readyInfo()!.virtual).toBe(false);
  }, 60_000);

  it('붙지 못함 → nodisplay, Xwayland → wayland(코드도 wayland — SC-10), 시험 중 Xvfb가 아님 → notxvfb: 사유마다 Linux 글 — 세지 않는다', async () => {
    // 잡는 결함: 사유를 버리고 Windows의 세션 0 글을 보임 · 화면 없음을 다시 띄우기 상한에 셈 · Xwayland를 '조작할 화면 없음'으로 보임
    for (const [patch, o, detail] of [
      [{ display: 'fail' }, {}, 'nodisplay'],
      [{ display: 'xwayland' }, {}, 'wayland'],
      [{ virtual: false }, { requireXvfb: true }, 'notxvfb'],
    ] as const) {
      const { client } = boot(patch as Partial<FakeX11Scene>, o);
      const r = await client.ready();
      const code = detail === 'wayland' ? 'wayland' : 'no_desktop';
      expect(r).toEqual({ ok: false, kind: 'unavailable', code, text: NO_DESKTOP_TEXTS[detail] });
      expect(client.problem()).toMatchObject({ code, permanent: false });
      expect(NO_DESKTOP_TEXTS[detail]).not.toBe(NO_DESKTOP_TEXT);
    }
  }, 90_000);

  it('EWMH 창 관리자가 없으면 FAIL INIT wm — 막는 창을 가를 수 없어 띄우지 않는다(막는 쪽)', async () => {
    const { client } = boot({ wm: false });
    const r = await client.ready();
    expect(r.ok).toBe(false);
    expect(!r.ok && r.kind === 'unavailable' ? r.text : '').toContain('INIT: wm');
  }, 60_000);
});

describe('X11 화면 도우미: 화면·창·포커스', () => {
  it('SCREENS: 배치 해시는 Windows 도우미와 같은 식(p|s,x,y,w,h,dpi;) — 주 모니터 먼저, dpi는 mm에서', async () => {
    // 잡는 결함: 배치 해시 식이 달라 캡처의 좌표가 늘 LAYOUT_CHANGED · 주 모니터가 뒤로
    const { client } = boot({ screens: [{ name: 'B', x: 1280, y: 0, w: 1920, h: 1080, mmw: 508, mmh: 286 }, { name: 'A', x: 0, y: 0, w: 1280, h: 800, mmw: 339, mmh: 212, primary: true }] });
    const s = ok(await client.request({ verb: 'SCREENS' }));
    expect(s.screens).toEqual([
      { index: 1, primary: true, x: 0, y: 0, width: 1280, height: 800, dpi: 96 },
      { index: 2, primary: false, x: 1280, y: 0, width: 1920, height: 1080, dpi: 96 },
    ]);
    expect(s.layout).toBe(createHash('sha256').update('p,0,0,1280,800,96;s,1280,0,1920,1080,96;', 'ascii').digest('hex').slice(0, 16));
  }, 60_000);

  it('WINDOWS: 위 창 먼저, 틀까지 넣은 크기, 최소화, 막는 창(조상 터미널·욱채 제목), 높은 권한(PID 없음·다른 기계·다른 사용자)', async () => {
    // 잡는 결함: 서버를 띄운 터미널을 막지 않음 · root·다른 기계 창을 보통 창으로 봄 · 클라이언트 크기만 써서 제목 줄이 빠짐
    const { client } = boot();
    // 정책(욱채로 시작하는 제목)은 ARM이 준다
    await armed(client);
    const w = ok(await client.request({ verb: 'WINDOWS' }));
    const by = Object.fromEntries(w.windows.map((x) => [x.title, x]));
    expect(w.windows[0]!.title).toBe('메모.txt - Mousepad');
    expect(by['메모.txt - Mousepad']).toMatchObject({ app: 'mousepad', pid: 4242, x: 319, y: 147, width: 642, height: 505, blocked: false, elevated: false, minimized: false });
    expect(by['서버를 띄운 터미널']).toMatchObject({ blocked: true });
    expect(by['욱채 화면']).toMatchObject({ blocked: true });
    expect(by['root 창']).toMatchObject({ elevated: true });
    expect(by['다른 기계의 창']).toMatchObject({ elevated: true });
    expect(by['PID 없는 창']).toMatchObject({ elevated: true });
    expect(by['최소화된 창']).toMatchObject({ minimized: true });
    expect(w.total).toBe(7);
  }, 90_000);

  it('FOCUS: 곁 도우미가 없으면 암호 칸은 모름(null) — 곁 도우미의 AT-SPI가 말하면 그 값', async () => {
    const a = boot();
    expect(ok(await a.client.request({ verb: 'FOCUS' }))).toMatchObject({ title: '메모.txt - Mousepad', pid: 4242, password: null, control: null });
    const b = boot({ sidecar: { atspi: true, password: true, control: 'password text' } }, { sidecar: true });
    expect(ok(await b.client.request({ verb: 'FOCUS' }))).toMatchObject({ password: true, control: 'password text' });
  }, 90_000);
});

describe('X11 화면 도우미: 캡처', () => {
  it('maim으로 그 모니터를 찍고(-u 포인터 빼고), 긴 변이 maxEdge가 되게 줄여 PNG를 .tmp에 쓴 뒤 이름을 바꾼다 — 해시는 그 파일의 것', async () => {
    // 잡는 결함: 줄이지 않음 · 해시가 파일과 다름 · 포인터가 찍힘 · 같은 ID를 덮어씀
    const { fake, client } = boot();
    const layout = await armed(client);
    const c = ok(await client.request({ verb: 'CAPTURE', screen: 1, maxEdge: 640, id: 'SC-000001' }));
    expect(c).toMatchObject({ width: 640, height: 400, originX: 0, originY: 0, realWidth: 1280, realHeight: 800, layout });
    const file = join(fake.screensDir, 'SC-000001.png');
    const png = readFileSync(file);
    expect(createHash('sha256').update(png).digest('hex')).toBe(c.sha256);
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([640, 400]);
    expect(png[25]).toBe(2);
    expect(inflateSync(png.subarray(41, 41 + png.readUInt32BE(33))).length).toBe((640 * 3 + 1) * 400);
    expect(existsSync(`${file}.tmp`)).toBe(false);
    expect(fake.calls().find((x) => x.tool === 'maim')?.args).toEqual(['-u', '-f', 'png', '-g', '1280x800+0+0']);
    expect(err(await client.request({ verb: 'CAPTURE', screen: 1, maxEdge: 640, id: 'SC-000001' }))).toBe('BAD_ARGS id_exists');
    expect(err(await client.request({ verb: 'CAPTURE', screen: 2, maxEdge: 640, id: 'SC-000002' }))).toBe('BAD_ARGS screen');
  }, 90_000);

  it('실제 화면(가상 화면이 아님)에서 무장했으면 조작 중 표시를 찍기 전에 걷고 찍은 뒤 다시 띄운다', async () => {
    // 잡는 결함: 표시가 캡처에 찍힘 (리드 결정 S10-7.5)
    const { fake, client } = boot({ virtual: false }, { sidecar: true });
    await armed(client);
    ok(await client.request({ verb: 'CAPTURE', screen: 1, maxEdge: 320, id: 'SC-000003' }));
    const seq = fake.calls().filter((x) => x.tool === 'sidecar' || x.tool === 'maim').map((x) => (x.tool === 'maim' ? 'maim' : x.args[0]));
    expect(seq).toEqual(expect.arrayContaining(['arm']));
    const i = seq.indexOf('maim');
    expect(seq.slice(i - 1, i + 2)).toEqual(['hide', 'maim', 'show']);
  }, 90_000);
});

describe('X11 화면 도우미: 입력의 차례와 막는 것', () => {
  it('무장 전·배치가 다름·화면 밖은 보내지 않는다 (Windows 도우미와 같은 차례)', async () => {
    const { fake, client } = boot();
    const layout = ok(await client.request({ verb: 'SCREENS' })).layout;
    expect(err(await client.request({ verb: 'MOVE', x: 10, y: 10, layout }))).toBe('RELEASED');
    ok(await client.request({ verb: 'ARM', policy: POLICY }));
    expect(err(await client.request({ verb: 'MOVE', x: 10, y: 10, layout: '0123456789abcdef' }))).toBe('LAYOUT_CHANGED');
    expect(err(await client.request({ verb: 'MOVE', x: 5000, y: 10, layout }))).toBe('BAD_ARGS outside');
    expect(fake.calls().filter((x) => x.tool === 'xdotool')).toEqual([]);
  }, 90_000);

  it('그 점의 맨 위 창을 틀(제목 줄) 포함으로 본다: 메모장 제목 줄은 메모장, 그 밖의 터미널은 막고, root 창은 높은 권한', async () => {
    // 잡는 결함: 틀을 빼고 맞혀 메모장 제목 줄의 클릭이 뒤의 터미널(서버를 띄운 창)로 감 — 또는 그 반대로 막아야 할 터미널을 통과
    const { fake, client } = boot();
    const layout = await armed(client);
    // (330,150): 메모장의 클라이언트(위 167부터) 밖이지만 틀(위 147부터) 안 — 메모장이다
    expect(err(await client.request({ verb: 'CLICK', x: 330, y: 150, button: 'left', count: 2, layout }))).toBe('OK');
    expect(fake.calls().filter((x) => x.tool === 'xdotool').at(-1)?.args).toEqual(['mousemove', '330', '150', 'click', '--repeat', '2', '--delay', '60', '1']);
    expect(err(await client.request({ verb: 'CLICK', x: 150, y: 400, button: 'left', count: 1, layout }))).toBe('BLOCKED_TARGET window');
    expect(err(await client.request({ verb: 'CLICK', x: 1050, y: 150, button: 'left', count: 1, layout }))).toBe('ELEVATED_TARGET');
    expect(err(await client.request({ verb: 'SCROLL', x: 1150, y: 450, amount: 3, layout }))).toBe('ELEVATED_TARGET');
    expect(err(await client.request({ verb: 'SCROLL', x: 640, y: 400, amount: 3, layout }))).toBe('OK');
    expect(fake.calls().filter((x) => x.tool === 'xdotool').at(-1)?.args).toEqual(['mousemove', '640', '400', 'click', '--repeat', '3', '--delay', '30', '5']);
  }, 120_000);

  it('가운데 단추는 보내지 않는다 (X11은 고른 글을 붙여 넣는다 — S10-7.8)', async () => {
    const { fake, client } = boot();
    const layout = await armed(client);
    expect(err(await client.request({ verb: 'CLICK', x: 640, y: 400, button: 'middle', count: 1, layout }))).toBe('BLOCKED_TARGET middle');
    expect(fake.calls().filter((x) => x.tool === 'xdotool')).toEqual([]);
  }, 60_000);

  it('KEY: Linux에서 막는 조합(잠금·X 끝내기·가상 터미널·xkill·로그아웃·멈춤 단축키)은 보내지 않고, 이름은 X 기호로 바꾼다', async () => {
    // 잡는 결함: ctrl+alt+F3로 가상 터미널에 감 · ctrl+alt+backspace로 X가 끝남 · super+l로 잠김
    const { fake, client } = boot({ sidecar: { atspi: true, password: false, control: 'text' } }, { sidecar: true });
    const layout = await armed(client);
    for (const combo of ['super+l', 'win+l', 'ctrl+alt+l', 'ctrl+alt+backspace', 'ctrl+alt+f1', 'ctrl+alt+f12', 'ctrl+alt+shift+f12', 'ctrl+alt+escape', 'ctrl+alt+delete']) {
      expect(err(await client.request({ verb: 'KEY', combo, layout }))).toBe('BLOCKED_TARGET key');
    }
    expect(fake.calls().filter((x) => x.tool === 'xdotool')).toEqual([]);
    for (const [combo, sent] of [
      ['ctrl+s', 'ctrl+s'],
      ['enter', 'Return'],
      ['pagedown', 'Next'],
      ['ctrl+shift+f5', 'ctrl+shift+F5'],
      ['@', 'at'],
      ['A', 'A'],
    ] as const) {
      expect(err(await client.request({ verb: 'KEY', combo, layout }))).toBe('OK');
      expect(fake.calls().filter((x) => x.tool === 'xdotool').at(-1)?.args).toEqual(['key', sent]);
    }
  }, 120_000);

  it('글자 키(KEY a)와 TYPE은 암호 칸인지 모르면 보내지 않는다 — 운영자 설정(typeWithoutA11y)이 켜졌을 때만 친다 (S10-7.6)', async () => {
    // 잡는 결함: AT-SPI가 없는데 글자를 쳐 비밀번호 칸에 들어감
    const a = boot();
    const la = await armed(a.client);
    expect(err(await a.client.request({ verb: 'KEY', combo: 'a', layout: la }))).toBe('FOCUS_UNKNOWN');
    expect(err(await a.client.request({ verb: 'TYPE', text: 'abc', layout: la }))).toBe('FOCUS_UNKNOWN');
    expect(err(await a.client.request({ verb: 'KEY', combo: 'enter', layout: la }))).toBe('OK');
    expect(a.fake.scene().typed).toEqual({});
    const b = boot({}, { typeUnknown: true });
    const lb = await armed(b.client);
    const t = ok(await b.client.request({ verb: 'TYPE', text: 'abc', layout: lb }));
    expect(t?.password).toBeNull();
    expect(b.fake.scene().typed[String(0x400003)]).toBe('abc');
    // 운영자 설정은 type에만 — 가르지 못한 칸의 글자 키는 그대로 막는다 (SC-4, 리드 결정 S10-13)
    expect(err(await b.client.request({ verb: 'KEY', combo: 'h', layout: lb }))).toBe('FOCUS_UNKNOWN');
    expect(err(await b.client.request({ verb: 'KEY', combo: 'shift+a', layout: lb }))).toBe('FOCUS_UNKNOWN');
    expect(b.fake.calls().filter((x) => x.tool === 'xdotool' && x.args[0] === 'key')).toEqual([]);
  }, 120_000);

  it('곁 도우미가 암호 칸이라 하면 PASSWORD_FIELD, 보통 칸이면 친다 — 4자씩, ASCII 밖 글자는 빈 키 자리에 먼저 넣고 친다', async () => {
    // 잡는 결함: 암호 칸에 글자를 침 · 한국어를 xdotool의 임시 자리 하나로 쳐 글자가 바뀜(Xvfb에서 '안녕하세요' → '안하세요')
    const { fake, client } = boot({ sidecar: { atspi: true, password: true } }, { sidecar: true });
    const layout = await armed(client);
    expect(err(await client.request({ verb: 'TYPE', text: '비밀', layout }))).toBe('PASSWORD_FIELD');
    expect(err(await client.request({ verb: 'KEY', combo: 'x', layout }))).toBe('PASSWORD_FIELD');
    fake.set({ sidecar: { atspi: true, password: false, control: 'text' } });
    const t = ok(await client.request({ verb: 'TYPE', text: '안녕하세요 hi', layout }));
    expect(t).toMatchObject({ password: false, control: 'text' });
    expect(fake.scene().typed[String(0x400003)]).toBe('안녕하세요 hi');
    const calls = fake.calls().filter((x) => x.tool === 'xdotool' || (x.tool === 'xmodmap' && x.args[0] === '-e'));
    expect(calls.map((x) => (x.tool === 'xmodmap' ? 'map' : x.args.at(-1)))).toEqual(['map', '안녕하세', 'map', '요 hi']);
    // 첫 묶음의 네 글자는 서로 다른 빈 자리에 — 한 자리를 바꿔 가며 치지 않는다
    const first = calls[0]!.args.filter((a) => a !== '-e');
    expect(first).toEqual(['keycode 93 = UC548 UC548', 'keycode 97 = UB155 UB155', 'keycode 103 = UD558 UD558', 'keycode 120 = UC138 UC138']);
    // 둘째 묶음은 앞 묶음의 자리를 다시 쓰지 않는다
    expect(calls[2]!.args.filter((a) => a !== '-e')).toEqual(['keycode 132 = UC694 UC694']);
  }, 120_000);

  it('치는 중에 앱이 다른 창으로 포커스를 옮기면 다음 묶음 전에 멈춘다 (FOCUS_UNKNOWN sent=보낸 UTF-16 단위)', async () => {
    const { fake, client } = boot({ typeMoveFocus: { after: 4, to: 0x500003 } }, { typeUnknown: true });
    const layout = await armed(client);
    expect(err(await client.request({ verb: 'TYPE', text: 'abcdefgh', layout }))).toBe('FOCUS_UNKNOWN sent=4');
    expect(fake.scene().typed[String(0x400003)]).toBe('abcd');
  }, 90_000);

  it('제어 문자가 든 글은 BAD_TEXT, 깨진 base64·UTF-8은 BAD_ARGS text', async () => {
    const { client } = boot({}, { typeUnknown: true });
    const layout = await armed(client);
    expect(err(await client.request({ verb: 'TYPE', text: 'a\tb', layout }))).toBe('BAD_TEXT');
  }, 60_000);
});

describe('X11 화면 도우미: 놓기·정지·끝남·사람·단축키', () => {
  it('RELEASE는 XTEST로 눌린 키(다른 도구가 누른 것도)와 버튼을 떼고 그 수를 말한다 — 그 뒤 입력은 RELEASED', async () => {
    // 잡는 결함: 다른 X 클라이언트가 누른 Shift가 남음 · 놓은 뒤에도 입력이 감
    const { fake, client } = boot({ keysDown: [50], buttonsDown: [1] });
    const layout = await armed(client);
    const r = await client.release();
    expect(r).toMatchObject({ acked: true, released: 2 });
    expect(fake.calls().filter((x) => x.tool === 'xdotool').at(-1)?.args).toEqual(['mouseup', '1', 'keyup', 'Shift_L']);
    expect(fake.scene()).toMatchObject({ keysDown: [], buttonsDown: [] });
    expect(err(await client.request({ verb: 'MOVE', x: 640, y: 400, layout }))).toBe('RELEASED');
  }, 90_000);

  it('STOP은 떼고 STOP OK로 답한다 — 클라이언트는 그 도우미를 끝내고(POSIX는 묶음째) 키를 뗐다고 확인한다', async () => {
    const { fake, client } = boot({ keysDown: [37] }, { sidecar: true });
    await armed(client);
    const r = await client.stop('시험');
    expect(r).toMatchObject({ ok: true, acked: true, exited: true, released: 1 });
    expect(fake.calls().some((x) => x.tool === 'xdotool' && x.args.join(' ') === 'keyup Control_L')).toBe(true);
  }, 90_000);

  it('표준 입력이 닫히면(서버가 끝남) 눌린 키를 떼고 끝난다', async () => {
    const { fake, client } = boot({ keysDown: [64] });
    await armed(client);
    const pid = client.pid!;
    // 클라이언트 몰래 표준 입력만 닫는다 — 서버가 죽은 것과 같다 (그 도우미는 이 시험이 띄운 것)
    const exited = new Promise<void>((r) => client.onEvent((e) => e.type === 'exit' && r()));
    (client as unknown as { current: { proc: { stdin: { end(): void } } } }).current.proc.stdin.end();
    await exited;
    expect(fake.calls().some((x) => x.tool === 'xdotool' && x.args.join(' ') === 'keyup Alt_L')).toBe(true);
    expect(pid).toBeGreaterThan(0);
  }, 90_000);

  it('ARM의 시작 값은 마지막 입력(쉼 시간)이고, 무장한 동안 도우미의 주입이 아닌 입력이 오면 HUMAN을 알린다 — 키 내용은 읽지 않는다', async () => {
    // 잡는 결함: 사람 입력을 못 봄(30초 멈춤이 걸리지 않음) · 도우미 자신의 주입을 사람으로 봄
    const last = Date.now() - 120_000;
    const { fake, client, events } = boot({ lastInputAt: last });
    ok(await client.request({ verb: 'SCREENS' }));
    const arm = ok(await client.request({ verb: 'ARM', policy: POLICY }));
    expect(Math.abs(arm.seed - last)).toBeLessThan(2000);
    expect(arm.hotkey).toBe(false);
    // 도우미의 주입 (사람 아님)
    const layout = ok(await client.request({ verb: 'SCREENS' })).layout;
    ok(await client.request({ verb: 'MOVE', x: 640, y: 400, layout }));
    await sleep(1500);
    expect(events.filter((e) => e.type === 'human')).toEqual([]);
    // 사람 (도우미 밖의 입력)
    const at = Date.now();
    fake.set({ lastInputAt: at });
    for (let i = 0; i < 100 && !events.some((e) => e.type === 'human'); i++) await sleep(100);
    const human = events.find((e) => e.type === 'human') as { type: 'human'; at: number } | undefined;
    expect(human).toBeTruthy();
    expect(Math.abs(human!.at - at)).toBeLessThan(2000);
    expect(fake.calls().filter((x) => x.tool === 'xinput' && x.args[0] === 'test-xi2')).toEqual([]);
  }, 90_000);

  it('곁 도우미가 멈춤 단축키를 알리면 떼고 무장을 풀고 HOTKEY — 그 뒤 입력은 HUMAN_ACTIVE hotkey', async () => {
    const { fake, client, events } = boot({ sidecar: { grab: true, hotkeyAfterArmMs: 200 } }, { sidecar: true });
    const layout = ok(await client.request({ verb: 'SCREENS' })).layout;
    const arm = ok(await client.request({ verb: 'ARM', policy: POLICY }));
    expect(arm.hotkey).toBe(true);
    for (let i = 0; i < 100 && !events.some((e) => e.type === 'hotkey'); i++) await sleep(100);
    expect(events.some((e) => e.type === 'hotkey')).toBe(true);
    expect(client.armed()).toBe(false);
    expect(err(await client.request({ verb: 'MOVE', x: 640, y: 400, layout }))).toBe('RELEASED');
    expect(fake.calls().some((x) => x.tool === 'sidecar' && x.args[0] === 'disarm')).toBe(true);
  }, 90_000);

  it('실제 화면에서 곁 도우미가 단축키를 잡지 못하거나 표시를 띄우지 못하면 hotkey=0 — 가상 화면은 표시 없이 잡은 그대로', async () => {
    const a = boot({ virtual: false, sidecar: { grab: true, indicator: false } }, { sidecar: true });
    await a.client.ready();
    expect(ok(await a.client.request({ verb: 'ARM', policy: POLICY })).hotkey).toBe(false);
    const b = boot({ virtual: true, sidecar: { grab: true, indicator: false } }, { sidecar: true });
    expect(ok(await b.client.request({ verb: 'ARM', policy: POLICY })).hotkey).toBe(true);
    expect(b.fake.calls().find((x) => x.tool === 'sidecar' && x.args[0] === 'arm')).toBeTruthy();
  }, 90_000);

  it.skipIf(process.platform === 'win32')('POSIX: 정지는 도우미의 프로세스 묶음 전체를 끝낸다 — 곁 도우미도 남지 않는다 (S10-7.9, Linux만: 묶음은 POSIX에만 있다)', async () => {
    // 잡는 결함: 도우미만 끝내고 곁 도우미(단축키를 쥔 프로세스)가 남음 — 표준 입력이 닫혀도 끝나지 않는 곁 도우미로 (EOF로 끝나는 곁 도우미는 묶음 없이도 끝나 가린다)
    const { client } = boot({ sidecar: { grab: true, ignoreEof: true } }, { sidecar: true });
    await client.ready();
    const pid = client.pid!;
    // 그 도우미의 자식(곁 도우미) — /proc의 ppid로 찾는다. 읽기만 한다
    const kids = (): number[] =>
      readdirSync('/proc')
        .filter((d) => /^\d+$/.test(d))
        .filter((d) => {
          try {
            const st = readFileSync(`/proc/${d}/stat`, 'utf8');
            return Number(st.slice(st.lastIndexOf(')') + 2).split(' ')[1]) === pid;
          } catch {
            return false;
          }
        })
        .map(Number);
    const side = kids();
    expect(side.length).toBeGreaterThan(0);
    await client.stop('시험');
    await sleep(300);
    for (const k of side) {
      let alive = true;
      try {
        process.kill(k, 0);
      } catch {
        alive = false;
      }
      expect(alive).toBe(false);
    }
  }, 90_000);
});

describe('X11 띄우는 이음매·문·고정 (S10-7.10·S10-7.11)', () => {
  it('시험 문: WOOK_REAL_DESKTOP=1 · 이 PC 이름 · 그 화면이 모두 맞을 때만 열린다 — 다른 화면 이름이면 닫힌다', () => {
    // 잡는 결함: 다른 화면(사람의 :0)을 가리키는 시험이 문을 연다
    const base = { WOOK_REAL_DESKTOP: '1', WOOK_REAL_DESKTOP_HOST: hostname(), WOOK_REAL_DESKTOP_DISPLAY: ':42', WOOK_REAL_DESKTOP_XPID: '4321' };
    expect(realX11GateOpen(base, ':42')).toBe(true);
    // 시험이 띄운 X 서버의 PID를 적지 않았으면 닫힌다 (SC-2)
    expect(realX11GateOpen({ ...base, WOOK_REAL_DESKTOP_XPID: undefined }, ':42')).toBe(false);
    expect(realX11GateOpen(base, ':0')).toBe(false);
    expect(realX11GateOpen({ ...base, WOOK_REAL_DESKTOP_HOST: 'other' }, ':42')).toBe(false);
    expect(realX11GateOpen({ ...base, WOOK_REAL_DESKTOP: '0' }, ':42')).toBe(false);
    expect(realX11GateOpen({ WOOK_REAL_DESKTOP: '1', WOOK_REAL_DESKTOP_HOST: hostname() }, ':42')).toBe(false);
    expect(x11LaunchRefusal({ VITEST: 'true' }, ':42')).toContain('시험 중에는 실제 X11 화면 도우미를 띄우지 않습니다');
    expect(x11LaunchRefusal({}, ':42')).toBeNull();
  });

  it('시험 중 문이 닫혀 있으면 준비는 아무것도 복사하지 않고 띄우기는 거부한다', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'wook-x11-gate-'));
    try {
      const launcher = createX11DesktopLauncher({ dataDir, appRoot: process.cwd(), nodePath: process.execPath, display: ':42', xauthority: null, typeWithoutA11y: false, log: () => undefined, env: { VITEST: 'true' } });
      await launcher.prepare!();
      const spec = launcher.launch();
      expect('refuse' in spec && spec.refuse).toContain('시험 중에는');
      expect(existsSync(join(dataDir, 'bin'))).toBe(false);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('도우미·곁 도우미를 <dataDir>/bin에 복사해 해시를 고정한다 — 복사본이 바뀌면 띄우지 않고 알린 뒤 한 번 다시 복사한다. 환경은 작게 (토큰·NODE_OPTIONS 없음)', async () => {
    // 잡는 결함: 바뀐 스크립트를 띄움 · 서버의 비밀 환경(토큰)·NODE_OPTIONS가 도우미로 감
    const dataDir = mkdtempSync(join(tmpdir(), 'wook-x11-pin-'));
    try {
      const problems: string[] = [];
      const tools = Object.fromEntries(['xdotool', 'maim', 'xprop', 'xwininfo', 'xrandr', 'xinput', 'xprintidle', 'xdpyinfo', 'xmodmap', 'xset'].map((n) => [n, ['/usr/bin/' + n]]));
      const launcher = createX11DesktopLauncher({
        dataDir,
        appRoot: process.cwd(),
        nodePath: process.execPath,
        display: ':42',
        xauthority: '/tmp/x.auth',
        typeWithoutA11y: true,
        log: () => undefined,
        onProblem: (p) => problems.push(p.text),
        env: { HOME: '/home/w', GITHUB_TOKEN: 'ghp_secret', NODE_OPTIONS: '--require /tmp/evil.js', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus', DISPLAY: ':0' },
        tools,
        sidecarCommand: ['/usr/bin/python3', '-I', '-B', '-s'],
      });
      await launcher.prepare!();
      const spec = launcher.launch();
      if ('refuse' in spec) throw new Error(spec.refuse);
      const helperCopy = join(dataDir, 'bin', 'wook-x11-helper.mjs');
      expect(spec).toMatchObject({ file: process.execPath, args: [helperCopy] });
      expect(readFileSync(helperCopy)).toEqual(readFileSync(join(process.cwd(), 'resources', 'desktophelper', 'x11Helper.mjs')));
      expect(spec.env).toMatchObject({ DISPLAY: ':42', XAUTHORITY: '/tmp/x.auth', HOME: '/home/w', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus', WOOK_X11_TYPE_UNKNOWN: '1' });
      expect(Object.keys(spec.env)).not.toEqual(expect.arrayContaining(['GITHUB_TOKEN']));
      expect(spec.env.NODE_OPTIONS).toBeUndefined();
      expect(JSON.parse(spec.env.WOOK_X11_SIDECAR!)).toEqual(['/usr/bin/python3', '-I', '-B', '-s', join(dataDir, 'bin', 'wook-x11-sidecar.py')]);
      // 화면의 주인 확인은 같은 고정 파일의 --identity (SC-1)
      expect(JSON.parse(spec.env.WOOK_X11_IDENTITY!)).toEqual(['/usr/bin/python3', '-I', '-B', '-s', join(dataDir, 'bin', 'wook-x11-sidecar.py'), '--identity']);
      // 바꿔치기
      writeFileSync(join(dataDir, 'bin', 'wook-x11-sidecar.py'), 'import os; os.system("evil")\n');
      const refused = launcher.launch();
      expect('refuse' in refused && refused.refuse).toContain('준비할 때와 다릅니다');
      expect(problems).toHaveLength(1);
      for (let i = 0; i < 50 && 'refuse' in launcher.launch(); i++) await sleep(50);
      expect('refuse' in launcher.launch()).toBe(false);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('스크립트 고정은 같으면 다시 쓰지 않고, 복사본·해시 파일이 원본과 다르면 다시 쓴다', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'wook-x11-pin2-'));
    try {
      const src = join(process.cwd(), 'resources', 'desktophelper', 'x11Helper.mjs');
      const a = await ensurePinnedScript(X11_HELPER_SCRIPT, { dataDir, sourcePath: src });
      expect(a).toMatchObject({ ok: true, copied: true });
      const b = await ensurePinnedScript(X11_HELPER_SCRIPT, { dataDir, sourcePath: src });
      expect(b).toMatchObject({ ok: true, copied: false });
      writeFileSync(join(dataDir, 'bin', 'wook-x11-helper.mjs'), '// 바뀜\n');
      if (a.ok) expect(checkPinned(a.pin).ok).toBe(false);
      const c = await ensurePinnedScript(X11_HELPER_SCRIPT, { dataDir, sourcePath: src });
      expect(c).toMatchObject({ ok: true, copied: true });
      if (c.ok) expect(checkPinned(c.pin).ok).toBe(true);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('도구는 정해진 시스템 폴더에서만 찾는다 — 빠진 도구는 설치할 꾸러미 이름과 함께 말한다', () => {
    const none = resolveX11Tools([join(tmpdir(), 'wook-no-such-dir')]);
    expect(none.missing).toEqual(['xdotool', 'maim', 'xprop', 'xwininfo', 'xrandr', 'xinput', 'xprintidle', 'xdpyinfo', 'xmodmap', 'xset', 'python3']);
    expect(missingToolsText(['xprop', 'xdotool', 'xwininfo'])).toBe(
      '화면 도우미에 필요한 X 도구가 없습니다: xprop, xdotool, xwininfo — 서버 PC의 운영자가 설치해야 합니다 (sudo apt install x11-utils xdotool)',
    );
  });
});

describe('Linux check의 화면 조작 항목 (S10-7.12 — 순수 함수, deployCheck에 붙이는 것은 S10b의 목록 뒤)', () => {
  const xs = { kind: 'x11' as const, display: ':99', xauthority: '/home/w/.wook-xvfb.auth', source: 'config' as const };
  const base = { enabled: null, session: xs, missingTools: [], python3: true, probe: { ok: true as const, reply: { lock: null, virtual: true } }, dbusSession: true, typeWithoutA11y: false };
  it('Xvfb에 다 갖추면 ok — 화면과 종류를 말한다', () => {
    const r = x11ScreenCheck(base);
    expect(r).toMatchObject({ level: 'ok', fix: null });
    expect(r.text).toContain(':99');
    expect(r.lines.join('\n')).toContain('Xvfb (가상 화면');
  });
  it('도구가 없으면 fail(설치할 꾸러미), Wayland·화면 없음·붙지 못함은 warn, typeWithoutA11y는 경고, 끈 서버는 ok', () => {
    // 잡는 결함: 도구가 없는데 ok · Wayland를 말하지 않음 · typeWithoutA11y를 조용히 둠
    // 도구가 없으면 경고 — 운영자가 screen.enabled true로 켰을 때만 실패 (SC-7)
    expect(x11ScreenCheck({ ...base, missingTools: ['xprintidle'] })).toMatchObject({ level: 'warn', fix: 'sudo apt install xprintidle' });
    expect(x11ScreenCheck({ ...base, enabled: true, missingTools: ['xprintidle'] })).toMatchObject({ level: 'fail' });
    expect(x11ScreenCheck({ ...base, enabled: true, python3: false })).toMatchObject({ level: 'fail', fix: 'sudo apt install python3' });
    expect(x11ScreenCheck({ ...base, session: { kind: 'off', code: 'wayland', text: SCREEN_SESSION_TEXT.wayland } })).toMatchObject({ level: 'warn', text: expect.stringContaining('Wayland') });
    expect(x11ScreenCheck({ ...base, session: { kind: 'off', code: 'no_desktop', text: SCREEN_SESSION_TEXT.no_desktop } }).fix).toContain('"display": ":99"');
    expect(x11ScreenCheck({ ...base, probe: { ok: true, reply: { lock: 'no_desktop', detail: 'nodisplay' } } })).toMatchObject({ level: 'warn', text: expect.stringContaining(NO_DESKTOP_TEXTS.nodisplay) });
    expect(x11ScreenCheck({ ...base, typeWithoutA11y: true })).toMatchObject({ level: 'warn', text: expect.stringContaining('typeWithoutA11y가 켜져 있습니다') });
    expect(x11ScreenCheck({ ...base, dbusSession: false })).toMatchObject({ level: 'warn', text: expect.stringContaining('AT-SPI') });
    expect(x11ScreenCheck({ ...base, probe: { ok: true, reply: { lock: null, virtual: false } }, python3: false })).toMatchObject({ level: 'warn', text: expect.stringContaining('python3') });
    expect(x11ScreenCheck({ ...base, enabled: false, missingTools: ['xdotool'] })).toMatchObject({ level: 'ok' });
  });
});

describe('Linux check의 화면 조작 항목 — deployCheckLinux에 붙인 것 (S10-7.12)', () => {
  const okServer = { adminPipe: null, power: null, secretStore: null, screen: { ok: true, detail: '화면 조작을 쓸 수 있습니다 (모니터 1개)' }, port: 7400 };
  const facts = { enabled: null, session: { kind: 'x11' as const, display: ':99', xauthority: '/a', source: 'config' as const }, missingTools: [] as string[], python3: true, probe: null, dbusSession: true, typeWithoutA11y: false };
  it('서버가 말한 상태가 먼저 — 그 위에 도구·typeWithoutA11y를 본다. 서버가 돌지 않고 문제가 없으면 skip', () => {
    // 잡는 결함: 점검을 돌린 셸의 환경(WAYLAND_DISPLAY 등)으로 돌고 있는 서버의 화면을 틀리게 말함 · 도구가 없는데 서버 상태만 보고 ok
    expect(linuxScreenItem({ server: okServer, screen: facts })).toMatchObject({ id: 'screen', level: 'ok', text: expect.stringContaining('모니터 1개') });
    expect(linuxScreenItem({ server: okServer, screen: { ...facts, session: { kind: 'off', code: 'wayland', text: SCREEN_SESSION_TEXT.wayland } } })).toMatchObject({ level: 'ok' });
    expect(linuxScreenItem({ server: { ...okServer, screen: { ok: false, detail: '화면 없음' } }, screen: facts })).toMatchObject({ level: 'warn', text: expect.stringContaining('화면 없음') });
    expect(linuxScreenItem({ server: okServer, screen: { ...facts, missingTools: ['xdotool'] } })).toMatchObject({ level: 'warn', fix: 'sudo apt install xdotool' });
    expect(linuxScreenItem({ server: okServer, screen: { ...facts, enabled: true, missingTools: ['xdotool'] } })).toMatchObject({ level: 'fail', fix: 'sudo apt install xdotool' });
    expect(linuxScreenItem({ server: okServer, screen: { ...facts, typeWithoutA11y: true } })).toMatchObject({ level: 'warn' });
    expect(linuxScreenItem({ server: null, screen: facts })).toMatchObject({ level: 'skip', fix: null });
    expect(linuxScreenItem({ server: null, screen: { ...facts, session: { kind: 'off', code: 'no_desktop', text: SCREEN_SESSION_TEXT.no_desktop } } })).toMatchObject({ level: 'warn' });
    // 사실을 모으지 않은 부름 (서버의 상태만)
    expect(linuxScreenItem({ server: null })).toMatchObject({ level: 'skip' });
    expect(linuxScreenItem({ server: okServer })).toMatchObject({ level: 'ok' });
  });

  it('모으기: 화면 세션은 서버가 받는 환경(사용자 관리자의 환경)과 server.json으로 정한다 — 점검을 돌린 셸의 화면 변수가 아니다', async () => {
    // 잡는 결함: 운영자의 데스크톱 셸(WAYLAND_DISPLAY)에서 돌린 check가 systemd로 뜬 서버의 화면을 Wayland라고 함
    const exec: LinuxExec = async (file, args) => {
      const key = [file, ...args].join(' ');
      if (key === 'systemctl --user show-environment') return { code: 0, stdout: 'HOME=/home/u\nPATH=/usr/bin\nDBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus\n', timedOut: false, error: null };
      return { code: 1, stdout: '', timedOut: false, error: null };
    };
    const deps: LinuxGatherDeps = {
      exec,
      uid: 1000,
      user: 'u',
      home: '/home/u',
      env: { XDG_RUNTIME_DIR: '/run/user/1000', PATH: '/usr/bin', WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' },
      nodeVersion: '24.13.0',
      nodePath: '/usr/bin/node',
      appRoot: '/app',
      proc: () => null,
      which: () => null,
      exists: () => false,
      readText: () => null,
      statDir: () => null,
      secretsProblem: () => null,
      cli: async () => ({ found: false, path: null, loggedIn: null, detail: '없음' }),
      now: () => new Date('2026-11-12T00:00:00Z'),
      x11: () => ({ missingTools: [], python3: true }),
    };
    const run = (screen: Parameters<typeof gatherLinuxDeploy>[0]['screen']) =>
      gatherLinuxDeploy({ dataDir: '/d', cliPaths: { claudePath: null, codexPath: null }, apiKeys: null, server: null, screen }, deps).then((r) => r.items.find((i) => i.id === 'screen')!);
    // 관리자의 환경에 화면이 없다 → 화면 없음 (셸의 Wayland·:0이 아니라)
    expect(await run(null)).toMatchObject({ level: 'warn', text: expect.stringContaining('화면 없음') });
    // server.json이 화면을 정했다 → 서버가 돌지 않으니 skip, 세션 버스는 관리자의 환경에서 읽었다
    expect(await run({ enabled: null, display: ':99', xauthority: '/home/u/.wook-xvfb.auth' })).toMatchObject({ level: 'skip', text: expect.stringContaining(':99') });
    expect(await run({ enabled: false })).toMatchObject({ level: 'ok', text: expect.stringContaining('꺼 두었습니다') });
  });
});

describe('화면의 주인 확인 (SC-1, 리드 결정 S10-13) — 확인하기 전에는 X 도구를 하나도 띄우지 않는다', () => {
  const xToolCalls = (f: FakeX11) => f.calls().filter((x) => x.tool !== 'identity' && x.tool !== 'sidecar');
  it('추상 이름이 없음·다른 프로세스·다른 사용자·확인 실패면 FAIL NO_DESKTOP 그 사유 — X 도구(쿠키를 보내는 것)는 하나도 뜨지 않는다', async () => {
    // 잡는 결함: -nolisten local 화면의 추상 이름을 가로챈 프로세스에 xdpyinfo·xinput이 붙어 쿠키를 보냄
    for (const detail of ['noabstract', 'foreign', 'otheruser', 'unverified'] as const) {
      const { fake, client } = boot({ identity: { ok: false, detail } }, { sidecar: true });
      expect(await client.ready()).toEqual({ ok: false, kind: 'unavailable', code: 'no_desktop', text: NO_DESKTOP_TEXTS[detail] });
      expect(xToolCalls(fake)).toEqual([]);
      expect(fake.calls().filter((x) => x.tool === 'identity').map((x) => x.args)).toEqual([['7']]);
    }
  }, 120_000);

  it('시험 문의 X 서버 PID가 아니면 notours — 확인만 하고 X 도구는 띄우지 않는다 (SC-2)', async () => {
    const { fake, client } = boot({ identity: { ok: true, pid: 4000 } }, { requireXpid: 5555 });
    expect(await client.ready()).toMatchObject({ ok: false, code: 'no_desktop', text: NO_DESKTOP_TEXTS.notours });
    expect(xToolCalls(fake)).toEqual([]);
  }, 60_000);

  it('명령 사이에 주인이 바뀌면(가로챔) 무장할 때 ERR NO_DESKTOP foreign — 그 뒤 어느 명령·놓기에도 X 도구를 띄우지 않는다', async () => {
    // 잡는 결함: 시작 때만 확인해 그 뒤 가로챈 프로세스에 입력·캡처·쿠키가 감
    const { fake, client } = boot({ keysDown: [50] });
    const layout = await armed(client);
    const before = xToolCalls(fake).length;
    fake.set({ identity: { ok: false, detail: 'foreign' } });
    expect(err(await client.request({ verb: 'ARM', policy: POLICY }))).toBe('NO_DESKTOP foreign');
    expect(err(await client.request({ verb: 'SCREENS' }))).toBe('NO_DESKTOP foreign');
    expect(err(await client.request({ verb: 'MOVE', x: 640, y: 400, layout }))).toBe('NO_DESKTOP foreign');
    expect(await client.release()).toMatchObject({ acked: true, released: 0 });
    expect(xToolCalls(fake).length).toBe(before);
    // X 서버가 다시 떠서 주인이 맞으면 다시 쓴다 (다음 무장에서 확인)
    fake.set({ identity: { ok: true, pid: 4001 } });
    ok(await client.request({ verb: 'ARM', policy: POLICY }));
    expect(err(await client.request({ verb: 'MOVE', x: 640, y: 400, layout }))).toBe('OK');
  }, 120_000);
});

describe('Caps Lock (SC-3) · 관리되지 않는 창 (SC-6) · 남은 키 자리 (SC-8·SC-9)', () => {
  it('Caps Lock이 켜져 있으면 TYPE·글자 KEY 동안 끄고 되돌린다 — 친 글은 그대로, Caps Lock은 다시 켜진 채', async () => {
    // 잡는 결함: 'abc Hello'가 'ABC hELLO'로, KEY 'A'가 'a'로 들어감 (가짜 도구가 실제 X처럼 대소문자를 뒤집는다)
    const { fake, client } = boot({ capsLock: true, sidecar: { atspi: true, password: false, control: 'text' } }, { sidecar: true });
    const layout = await armed(client);
    ok(await client.request({ verb: 'TYPE', text: 'abc Hello', layout }));
    expect(fake.scene().typed[String(0x400003)]).toBe('abc Hello');
    ok(await client.request({ verb: 'KEY', combo: 'A', layout }));
    expect(fake.scene().keys.filter((k) => k.length === 1)).toEqual(['A']);
    expect(fake.scene().capsLock).toBe(true);
    const keys = fake.calls().filter((x) => x.tool === 'xdotool' && x.args[0] === 'key').map((x) => x.args[1]);
    expect(keys).toEqual(['Caps_Lock', 'Caps_Lock', 'Caps_Lock', 'A', 'Caps_Lock']);
    // Caps Lock이 꺼져 있으면 건드리지 않는다
    fake.set({ capsLock: false });
    ok(await client.request({ verb: 'TYPE', text: 'xyz', layout }));
    expect(fake.calls().filter((x) => x.tool === 'xdotool' && x.args[0] === 'key').length).toBe(5);
  }, 120_000);

  it('Shift Lock(Shift와 Lock이 함께 잠김)·잠긴 Shift만 남은 상태도 TYPE·KEY 동안 풀고 처음대로 되돌린다 — Caps Lock 표시등만 보면 놓친다', async () => {
    // 잡는 결함: Caps_Lock만 눌러 'Caps Lock' 표시등은 꺼졌지만 Shift가 잠긴 채 쳐서 '1'이 '!'로, ctrl+s가 ctrl+S로 감 (실제 Xvfb에서 본 것)
    const { fake, client } = boot({ capsLock: true, shiftLock: true, sidecar: { atspi: true, password: false, control: 'text' } }, { sidecar: true });
    const layout = await armed(client);
    ok(await client.request({ verb: 'TYPE', text: 'abc 123 Hello!', layout }));
    expect(fake.scene().typed[String(0x400003)]).toBe('abc 123 Hello!');
    expect(fake.scene()).toMatchObject({ capsLock: true, shiftLock: true });
    const keys = () => fake.calls().filter((x) => x.tool === 'xdotool' && x.args[0] === 'key').map((x) => x.args[1]);
    expect(keys()).toEqual(['shift', 'Caps_Lock', 'Shift_Lock']);
    // 잠긴 Shift만 (Shift_Lock 뒤 Caps_Lock — 'Caps Lock' 표시등은 꺼져 있다)
    fake.set({ capsLock: false, shiftLock: true });
    ok(await client.request({ verb: 'KEY', combo: '1', layout }));
    expect(fake.scene().keys.filter((k) => k.length === 1)).toEqual(['1']);
    expect(fake.scene()).toMatchObject({ capsLock: false, shiftLock: true });
    expect(keys().slice(3)).toEqual(['shift', '1', 'Shift_Lock', 'Caps_Lock']);
  }, 120_000);

  it('메뉴·팝업 같은 관리되지 않는 창이 그 자리를 덮으면 그 주인으로 본다 — 막는 프로세스의 것이면 막고, 주인을 모르면 거부, 보통 앱의 것이면 보낸다', async () => {
    // 잡는 결함: 관리되는 창 목록만 보고 위에 뜬 서버 터미널의 메뉴·root 앱의 메뉴에 클릭이 감
    const me = hostname();
    const { fake, client } = boot({
      unmanaged: [
        { id: 0x900100, pid: 600, machine: me, title: '터미널 메뉴', x: 400, y: 300, w: 100, h: 100 },
        { id: 0x900200, pid: null, title: '', x: 600, y: 300, w: 100, h: 100 },
        { id: 0x900300, pid: null, title: '', x: 800, y: 300, w: 100, h: 100, transientFor: 0x400003 },
        { id: 0x900400, pid: 4343, machine: me, title: 'root 메뉴', x: 400, y: 450, w: 100, h: 100 },
      ],
    });
    const layout = await armed(client);
    expect(err(await client.request({ verb: 'CLICK', x: 450, y: 350, button: 'left', count: 1, layout }))).toBe('BLOCKED_TARGET window');
    expect(err(await client.request({ verb: 'CLICK', x: 650, y: 350, button: 'left', count: 1, layout }))).toBe('BLOCKED_TARGET unowned');
    expect(err(await client.request({ verb: 'CLICK', x: 450, y: 500, button: 'left', count: 1, layout }))).toBe('ELEVATED_TARGET');
    expect(fake.calls().filter((x) => x.tool === 'xdotool')).toEqual([]);
    // 주인(WM_TRANSIENT_FOR)이 메모장이면 보낸다
    expect(err(await client.request({ verb: 'CLICK', x: 850, y: 350, button: 'left', count: 1, layout }))).toBe('OK');
  }, 120_000);

  it('끝나지 못한 도우미가 남긴 키 자리(U<hex> 두 칸)는 시작할 때 비우고 다시 쓴다 · RELEASE는 내가 넣은 자리의 눌린 키도 떼고 센다', async () => {
    // 잡는 결함: SIGKILL로 끝난 도우미의 키 자리가 쌓여 빈 자리가 없어짐 · 넣은 자리에 눌린 키를 떼지 않고 0개라 함
    const { fake, client } = boot({ keymap: { free: [97, 103, 120, 132], syms: { '50': 'Shift_L', '66': 'Caps_Lock' }, mapped: { '93': 'UC548' } }, sidecar: { atspi: true, password: false } }, { sidecar: true });
    const layout = await armed(client);
    expect(fake.calls().find((x) => x.tool === 'xmodmap' && x.args.join(' ') === '-e keycode 93 =')).toBeTruthy();
    ok(await client.request({ verb: 'TYPE', text: '한', layout }));
    const map = fake.calls().filter((x) => x.tool === 'xmodmap' && x.args.join(' ').includes('UD55C'));
    expect(map[0]!.args.join(' ')).toBe('-e keycode 93 = UD55C UD55C');
    fake.set({ keysDown: [93] });
    expect(await client.release()).toMatchObject({ acked: true, released: 1 });
    expect(fake.calls().filter((x) => x.tool === 'xdotool').at(-1)?.args).toEqual(['keyup', 'UD55C']);
  }, 120_000);
});

describe('이 기계의 화면만 (리드 결정 S10-13 노트)', () => {
  it('환경의 DISPLAY가 다른 기계(ssh -X)면 쓰지 않고, server.json screen.display도 이 기계의 이름만 받는다', () => {
    expect(screenSession({ platform: 'linux', env: { DISPLAY: 'localhost:10.0' } })).toEqual({ kind: 'off', code: 'no_desktop', text: SCREEN_SESSION_TEXT.remote });
    expect(screenSession({ platform: 'linux', env: { DISPLAY: 'unix:3.0' } })).toMatchObject({ kind: 'x11', display: 'unix:3.0' });
    expect(() => parseServerConfig({ screen: { display: 'localhost:10.0' } })).toThrow('server.json의 screen.display');
  });

  it('check의 고칠 줄은 쿠키 파일을 절대 경로로 적는다 — 그 조각을 server.json 읽기로 읽으면 받는다 (SC-5·TD-3)', () => {
    // 잡는 결함: "$HOME/.wook-xvfb.auth"를 그대로 붙여 넣으면 서버가 시작을 거부함
    const fix = x11ScreenCheck({ ...{ enabled: null, missingTools: [], python3: true, probe: null, dbusSession: true, typeWithoutA11y: false }, session: { kind: 'off', code: 'no_desktop', text: SCREEN_SESSION_TEXT.no_desktop }, home: '/home/wook' }).fix!;
    const snippet = /"screen": \{[^}]*\}/.exec(fix)![0];
    const parsed = parseServerConfig(JSON.parse(`{${snippet}}`));
    expect(parsed.config.screen).toEqual({ enabled: null, display: ':99', xauthority: '/home/wook/.wook-xvfb.auth' });
    expect(fix).not.toContain('$HOME');
    expect(fix).not.toContain('-nolisten local로');
  });
});

describe('검토 2차의 고침 (S10c2, 리드 결정 S10-17) — 걸음 사이의 사람 · 정지 뒤 잠금 키 · 붙지 못한 도구 · 시험 문 차례 · 곁 도우미의 까닭', () => {
  /** 가짜 도구는 Node 프로세스라 느리다 — 정지의 답(STOP OK)을 넉넉히 기다린다 */
  const SLOW = { READY: 30_000, SCREENS: 20_000, WINDOWS: 30_000, FOCUS: 20_000, CAPTURE: 30_000, MOVE: 30_000, CLICK: 30_000, SCROLL: 30_000, KEY: 30_000, DRAG: 60_000, TYPE: 60_000, ARM: 20_000, RELEASE: 20_000, STOP_ACK: 20_000, STOP_CONFIRM: 30_000 };
  const sentOf = (r: HelperResult<unknown>): number | null => (!r.ok && r.kind === 'err' ? r.sent : null);
  const humans = (events: DesktopHelperEvent[]) => events.filter((e) => e.type === 'human');

  it('FSD-1: 사람이 TYPE 도중에 움직이면(내 묶음 사이에 쉼 시간이 되돌아감) 다음 묶음 전에 HUMAN_ACTIVE로 멈추고 HUMAN을 알린다 — 보낸 글자는 그보다 적다 · 아무도 없으면 끝까지 정확히 친다', async () => {
    // 잡는 결함: 묶음이 잇달아 가서 사람 입력 보기(250ms마다, 주입 중·주입 뒤 120ms는 보지 않음)가 사람을 보지 못하고 TYPE이 OK로 끝남 (검토 2차 R8) ·
    // 거꾸로 도우미 자신의 묶음을 사람으로 봄(도구를 띄우는 시간만큼 흔들리는 쉼 시간 — 아무도 없는 쪽이 잡는다)
    const text = 'abcdefghijklmnopqrstuvwxyz0123456789ABCD'; // 40자 = 묶음 10개
    const quiet = boot({}, { typeUnknown: true });
    const lq = await armed(quiet.client);
    ok(await quiet.client.request({ verb: 'TYPE', text, layout: lq }));
    expect(quiet.fake.scene().typed[String(0x400003)]).toBe(text);
    expect(humans(quiet.events)).toEqual([]);
    // 사람: 둘째 묶음이 끝날 때부터 20ms마다 움직인다
    const busy = boot({ person: { after: 'type', n: 2, everyMs: 20 } }, { typeUnknown: true });
    const lb = await armed(busy.client);
    const r = await busy.client.request({ verb: 'TYPE', text, layout: lb });
    expect(r).toMatchObject({ ok: false, kind: 'err', reason: 'HUMAN_ACTIVE' });
    const sent = sentOf(r)!;
    expect(sent).toBeGreaterThanOrEqual(8);
    expect(sent).toBeLessThan(text.length);
    expect(busy.fake.scene().typed[String(0x400003)]).toBe(text.slice(0, sent));
    expect(humans(busy.events).length).toBeGreaterThan(0);
    // 키 내용은 읽지 않는다 — 쉼 시간만 (xprintidle)
    expect(busy.fake.calls().filter((x) => x.tool === 'xinput' && x.args[0] !== 'query-state' && x.args[0] !== 'list')).toEqual([]);
  }, 180_000);

  it('FSD-1: DRAG 도중 사람이 움직이면 다음 걸음 전에 HUMAN_ACTIVE — 버튼은 늘 뗀다 · 아무도 없으면 12걸음을 다 간다', async () => {
    // 잡는 결함: DRAG의 걸음(15ms 간격) 사이를 사람 입력 보기가 보지 못함 · 멈춘 DRAG가 버튼을 눌린 채 둠
    const quiet = boot();
    const lq = await armed(quiet.client);
    expect(err(await quiet.client.request({ verb: 'DRAG', x1: 500, y1: 300, x2: 700, y2: 500, layout: lq }))).toBe('OK');
    expect(humans(quiet.events)).toEqual([]);
    expect(quiet.fake.scene().pointer).toEqual([700, 500]);
    // 사람: 누름(mousemove+mousedown) 뒤 둘째 걸음이 끝날 때부터
    const busy = boot({ person: { after: 'mousemove', n: 3, everyMs: 20 } });
    const lb = await armed(busy.client);
    const r = await busy.client.request({ verb: 'DRAG', x1: 500, y1: 300, x2: 700, y2: 500, layout: lb });
    expect(r).toMatchObject({ ok: false, kind: 'err', reason: 'HUMAN_ACTIVE' });
    expect(sentOf(r)!).toBeLessThan(12);
    expect(busy.fake.scene().buttonsDown).toEqual([]);
    expect(humans(busy.events).length).toBeGreaterThan(0);
  }, 180_000);

  it('FSD-2: Caps Lock이 켜진 채 TYPE 도중에 정지하면 STOP OK를 내기 전에 Caps Lock을 되돌린다 — 정지가 도우미를 끝내도 켜진 채 남는다', async () => {
    // 잡는 결함: 되돌리기를 TYPE의 finally에만 둬서, STOP OK를 받은 클라이언트가 도우미를 끝내면 사람의 Caps Lock이 꺼진 채 남음 (검토 2차 R4)
    const fake = createFakeX11({ capsLock: true }, { typeUnknown: true });
    const client = fake.client({ timeouts: SLOW });
    live.push({ fake, client });
    const layout = await armed(client);
    const typing = client.request({ verb: 'TYPE', text: 'abcdefgh'.repeat(10), layout });
    // 첫 묶음이 들어간 뒤 (Caps Lock은 그 동안 꺼져 있다)
    for (let i = 0; i < 300 && !fake.scene().typed[String(0x400003)]; i++) await sleep(50);
    expect(fake.scene().capsLock).toBe(false);
    const stop = await client.stop('시험');
    expect(stop).toMatchObject({ ok: true, acked: true, exited: true });
    await typing;
    expect(fake.scene().capsLock).toBe(true);
    expect([...fake.scene().typed[String(0x400003)]!].length).toBeLessThan(80);
  }, 180_000);

  it('F2-1: TYPE 도중 X 도구가 시간을 넘겨 되돌리기가 실패해도 기억을 버리지 않는다 — 다음 STOP이 Caps Lock을 되돌린다 (리드 결정 S10-18)', async () => {
    // 잡는 결함: 되돌리기를 시작할 때 기억을 지워, 그 되돌리기가 도구 실패로 아무것도 못 하면 STOP도 되돌릴 것이 없어 Caps Lock이 꺼진 채 남음 (검토 3차 X4)
    const fake = createFakeX11({ capsLock: true }, { typeUnknown: true });
    const client = fake.client({ timeouts: SLOW });
    live.push({ fake, client });
    const layout = await armed(client);
    const typing = client.request({ verb: 'TYPE', text: 'abcdefgh'.repeat(10), layout });
    for (let i = 0; i < 300 && !fake.scene().typed[String(0x400003)]; i++) await sleep(50);
    expect(fake.scene().capsLock).toBe(false);
    // 그 뒤 xdotool이 답하지 않는다 (다른 X 클라이언트가 서버를 쥔 것처럼) — 다음 묶음과 그 명령의 되돌리기가 시간을 넘긴다
    fake.set({ toolDelayMs: { xdotool: 8000 } });
    const typed = await typing;
    expect(typed.ok).toBe(false);
    expect(fake.scene().capsLock).toBe(false);
    // 도구가 다시 답한다 — STOP이 (주인을 다시 확인한 뒤) 되돌린다
    fake.set({ toolDelayMs: {} });
    expect(await client.stop('시험')).toMatchObject({ ok: true, acked: true, exited: true });
    expect(fake.scene().capsLock).toBe(true);
  }, 180_000);

  it('F2-1: 그때 화면의 주인이 우리가 아니면(foreign) 아무 키도 누르지 않고 기억을 둔다 — 주인이 맞아진 뒤의 RELEASE가 되돌린다', async () => {
    // 잡는 결함: 되돌리기가 주인을 다시 보지 않고 가로챈 화면에 Caps_Lock을 누름 · 또는 거기서 기억을 버림
    const fake = createFakeX11({ capsLock: true }, { typeUnknown: true });
    const client = fake.client({ timeouts: SLOW });
    live.push({ fake, client });
    const layout = await armed(client);
    const typing = client.request({ verb: 'TYPE', text: 'abcdefgh'.repeat(10), layout });
    for (let i = 0; i < 300 && !fake.scene().typed[String(0x400003)]; i++) await sleep(50);
    const mark = fake.calls().length;
    fake.set({ display: 'fail', identity: { ok: false, detail: 'foreign' } });
    expect((await typing).ok).toBe(false);
    expect(await client.release()).toMatchObject({ acked: true, released: 0 });
    // 우리 화면이 아닌 동안 키를 누르지 않았다
    expect(fake.calls().slice(mark).filter((x) => x.tool === 'xdotool' && x.args[0] === 'key')).toEqual([]);
    expect(fake.scene().capsLock).toBe(false);
    // X 서버가 다시 떠 주인이 맞다 — 다음 놓기가 주인을 확인하고 되돌린다
    fake.set({ display: 'ok', identity: { ok: true, pid: 4001 } });
    expect(await client.release()).toMatchObject({ acked: true });
    expect(fake.scene().capsLock).toBe(true);
  }, 180_000);

  it('FSD-2: RELEASE도 답하기 전에 되돌린다 — 그 뒤 다음 TYPE은 처음 상태(켜짐)에서 다시 푼다', async () => {
    const fake = createFakeX11({ capsLock: true }, { typeUnknown: true });
    const client = fake.client({ timeouts: SLOW });
    live.push({ fake, client });
    const layout = await armed(client);
    const typing = client.request({ verb: 'TYPE', text: 'abcdefgh'.repeat(10), layout });
    for (let i = 0; i < 300 && !fake.scene().typed[String(0x400003)]; i++) await sleep(50);
    expect(await client.release()).toMatchObject({ acked: true });
    expect(fake.scene().capsLock).toBe(true);
    expect(err(await typing)).toMatch(/^RELEASED sent=\d+$/);
    expect(fake.scene().capsLock).toBe(true);
  }, 180_000);

  it('FSD-3: 무장한 동안 X 서버가 끝나고 다른 프로세스가 이름을 잡으면 — 화면에 붙지 못한 도구 뒤에는 주인을 다시 보기 전까지 X 도구가 뜨지 않는다 (사람 입력 보기도 1초마다 다시 본다)', async () => {
    // 잡는 결함: 사람 입력 보기가 2초마다만 주인을 다시 봐 그 사이 xprintidle이 250ms마다 가로챈 쪽에 쿠키를 보냄 (검토 2차 R3: 7번)
    const { fake, client } = boot();
    await armed(client);
    // 무장(주인 확인)한 바로 뒤 — 사람 입력 보기의 첫 걸음(250ms 뒤)보다 앞이다
    const mark = fake.calls().length;
    // 가로챔: X 도구는 화면에 붙지 못하고("unable to open display"), 주인 확인은 foreign
    fake.set({ display: 'fail', identity: { ok: false, detail: 'foreign' } });
    await sleep(3000);
    const after = fake.calls().slice(mark);
    const xTools = after.filter((x) => x.tool !== 'identity' && x.tool !== 'sidecar');
    // 확인한 지 1초가 안 됐으면 사람 입력 보기의 xprintidle 하나가 갈 수 있다 — 그 하나가 붙지 못한 뒤에는 주인을 다시 본다
    expect(xTools.length).toBeLessThanOrEqual(1);
    expect(after.filter((x) => x.tool === 'identity').length).toBeGreaterThan(0);
    const layout = '0123456789abcdef';
    expect(err(await client.request({ verb: 'MOVE', x: 10, y: 10, layout }))).toBe('NO_DESKTOP foreign');
    expect(fake.calls().slice(mark).filter((x) => x.tool !== 'identity' && x.tool !== 'sidecar').length).toBe(xTools.length);
  }, 120_000);

  it('FSD-3: 사람 입력 보기는 명령과 같이 1초마다 주인을 다시 본다 — 도구가 실패하지 않아도(가로챈 쪽이 X 서버로 이어 준다 해도) 1초 뒤에는 멈춘다', async () => {
    // 잡는 결함: 사람 입력 보기의 주인 확인 상한이 2초라 그동안 xprintidle이 250ms마다 다른 쪽으로 감 (검토 2차 R3 — 고침: 명령과 같은 1초)
    const { fake, client } = boot();
    await armed(client);
    const mark = fake.calls().length;
    // 주인만 바뀐다 — 도구는 그대로 붙는다
    fake.set({ identity: { ok: false, detail: 'foreign' } });
    await sleep(3000);
    const after = fake.calls().slice(mark);
    // 무장의 확인 뒤 1초 안의 250ms 걸음들뿐 (2초 상한이면 7~8번)
    expect(after.filter((x) => x.tool === 'xprintidle').length).toBeLessThanOrEqual(5);
    expect(after.filter((x) => x.tool === 'identity').length).toBeGreaterThan(0);
    // 주인이 아니라고 안 뒤에는 아무 X 도구도 뜨지 않는다
    const firstId = after.findIndex((x) => x.tool === 'identity');
    expect(after.slice(firstId).filter((x) => x.tool !== 'identity' && x.tool !== 'sidecar')).toEqual([]);
  }, 120_000);

  it('FSD-3: 명령 중에 도구 하나가 화면에 붙지 못하면 그 명령의 남은 도구는 뜨지 않고, 다음 명령은 1초가 안 됐어도 주인부터 다시 본다', async () => {
    // 잡는 결함: 1초 상한 안이라 확인을 건너뛰고 같은 명령·다음 명령의 도구가 가로챈 쪽으로 계속 감
    const { fake, client } = boot();
    const layout = await armed(client);
    fake.set({ display: 'fail' });
    const r = await client.request({ verb: 'WINDOWS' });
    expect(r.ok).toBe(false);
    const mark = fake.calls().length;
    fake.set({ display: 'ok' });
    // 주인은 그대로(같은 X 서버)이니 다시 보고 쓴다 — 그 확인이 첫 도구보다 먼저다
    expect(err(await client.request({ verb: 'MOVE', x: 640, y: 400, layout }))).toBe('OK');
    const next = fake.calls().slice(mark);
    expect(next[0]?.tool).toBe('identity');
  }, 120_000);

  it('FSD-4 (SC-11): 시험 문 아래 그 화면이 Xvfb가 아니면(notxvfb) 곁 도우미를 띄우지 않는다 — 거부될 화면에서 멈춤 단축키를 잡지 않는다', async () => {
    // 잡는 결함: 곁 도우미를 Xvfb 확인보다 먼저 띄워(고침 1차 전의 차례) 거부될 화면에 붙어 Ctrl+Alt+Shift+F12를 잡음. Xvfb 확인(xinput)을 1.5초 늦춰,
    // 그 차례라면 그동안 가짜 곁 도우미가 떠서 기록을 남긴다
    const { fake, client } = boot({ virtual: false, toolDelayMs: { xinput: 1500 } }, { sidecar: true, requireXvfb: true });
    expect(await client.ready()).toEqual({ ok: false, kind: 'unavailable', code: 'no_desktop', text: NO_DESKTOP_TEXTS.notxvfb });
    await sleep(1000);
    expect(fake.calls().some((x) => x.tool === 'xinput' && x.args[0] === 'list')).toBe(true);
    expect(fake.calls().filter((x) => x.tool === 'sidecar')).toEqual([]);
  }, 60_000);

  it('FSD-5: 곁 도우미가 없는 까닭을 READY(sidecarwhy)와 ARM 답(sidecar=)이 말한다 — 답하기 전에 끝남·python3-xlib 없음·화면에 붙지 못함·띄울 명령 없음, 그리고 READY 뒤에 끝남', async () => {
    // 잡는 결함: 세션 버스가 없어 곁 도우미 프로세스가 끝났는데 서버가 'python3-xlib를 설치하라'는 틀린 출구를 말함 (검토 2차 R9)
    for (const [side, o, why] of [
      [{ exitBeforeHello: true }, { sidecar: true }, 'exited'],
      [{ xlib: false, xlibWhy: 'import' }, { sidecar: true }, 'noxlib'],
      [{ xlib: false }, { sidecar: true }, 'xconnect'],
      [{}, {}, 'none'],
    ] as const) {
      const { client } = boot({ virtual: false, sidecar: side }, o);
      expect((await client.ready()).ok).toBe(true);
      expect(client.readyInfo()!.tokens).toMatchObject({ sidecar: '0', sidecarwhy: why });
      expect(ok(await client.request({ verb: 'ARM', policy: POLICY }))).toEqual({ seed: expect.any(Number), hotkey: false, sidecar: why });
    }
    // 곁 도우미가 있으면 그런 낱말이 없다 (Windows 도우미와 같은 ARM 답)
    const fine = boot({ virtual: false }, { sidecar: true });
    expect((await fine.client.ready()).ok).toBe(true);
    expect(fine.client.readyInfo()!.tokens).toEqual({ virtual: '0', sidecar: '1', a11y: '1' });
    expect(ok(await fine.client.request({ verb: 'ARM', policy: POLICY }))).toEqual({ seed: expect.any(Number), hotkey: true });
    // READY 뒤에 끝남: READY는 sidecar=1, 그 뒤 ARM 답이 sidecar=exited
    const late = boot({ virtual: false, sidecar: { exitAfterHelloMs: 200 } }, { sidecar: true });
    expect((await late.client.ready()).ok).toBe(true);
    expect(late.client.readyInfo()!.tokens).toMatchObject({ sidecar: '1' });
    let arm: { hotkey: boolean; sidecar?: string } | null = null;
    for (let i = 0; i < 100; i++) {
      // 곁 도우미가 무장 중에 끝나면 실제 화면의 도우미는 무장을 푼다 — 그때 도는 ARM은 RELEASED다(맞다). 다시 무장한다
      const r = await late.client.request({ verb: 'ARM', policy: POLICY });
      if (r.ok && r.value.sidecar) {
        arm = r.value;
        break;
      }
      expect(r.ok || err(r) === 'RELEASED').toBe(true);
      await sleep(100);
    }
    expect(arm).toMatchObject({ hotkey: false, sidecar: 'exited' });
  }, 240_000);
});

describe('CLI 턴·host_exec의 환경에는 X 화면 변수가 없다 (S10-7.7)', () => {
  it('DISPLAY·XAUTHORITY를 빼고 나머지는 그대로', () => {
    // 잡는 결함: 메인 에이전트가 셸에서 xdotool로 화면을 직접 움직여 안전장치를 건너뜀
    const base = { DISPLAY: ':99', XAUTHORITY: '/home/w/.Xauthority', PATH: '/usr/bin', LANG: 'C.UTF-8' };
    expect(buildChildEnv(base, {}, 'linux')).toEqual({ PATH: '/usr/bin', LANG: 'C.UTF-8' });
    expect(buildHostExecEnv(base, 'linux')).toEqual({ PATH: '/usr/bin', LANG: 'C.UTF-8', CI: '1' });
  });
});

