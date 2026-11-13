// 가짜 X 도구 (S10c) — X11 화면 도우미(resources/desktophelper/x11Helper.mjs)를 X 서버 없이 시험한다(Windows·WSL). 실제 X에는 붙지 않는다.
//   node fakeX11Tool.mjs <도구 이름> <인자...>     도구: xdotool maim xprop xwininfo xrandr xinput xprintidle xdpyinfo xmodmap xset
// 창: windows(관리되는 창 — 아래 → 위, frameId가 있으면 창 관리자의 틀 안에 든다)와 unmanaged(관리되지 않는 창 — override-redirect, 위가 먼저, 늘 관리되는 창 위).
// capsLock이 켜져 있으면 xdotool이 치는 글자와 글자 키의 대소문자가 뒤집힌다 (실제 X에서 본 것 — SC-3). shiftLock(잠긴 Shift)이면 숫자가 기호로 가고 글자가
// 한 번 더 뒤집힌다. key Shift_Lock은 Shift와 Lock을 함께 잠그고(두 번째에 함께 푼다), key shift는 잠긴 Shift를 푼다 (Xvfb에서 본 것)
// 장면: 환경 WOOK_FAKE_X11 = 장면 JSON 파일 (tests/fixtures/desktop/fakeX11.ts가 쓴다). 입력 도구(xdotool·xmodmap)는 장면을 바꿔 쓴다(포인터·눌린 키·친 글·키 자리·
// 마지막 입력 시각). 받은 인자는 WOOK_FAKE_X11_LOG에 JSON 줄로 남긴다 ({t, tool, args}).
// S10c2: person(도우미의 xdotool이 type·mousemove를 n번 보낸 뒤 계속 움직이는 사람 — xprintidle이 본다, FSD-1) · toolDelayMs(그 도구가 늦게 끝남, FSD-4).
import { appendFileSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { crc32, deflateSync } from 'node:zlib';

const [tool, ...args] = process.argv.slice(2);
const scenePath = process.env.WOOK_FAKE_X11;
const logPath = process.env.WOOK_FAKE_X11_LOG;
const S = JSON.parse(readFileSync(scenePath, 'utf8'));
if (logPath) appendFileSync(logPath, `${JSON.stringify({ t: Date.now(), tool, args })}\n`);
const save = () => {
  const tmp = `${scenePath}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(S));
  renameSync(tmp, scenePath);
};
const hex = (n) => `0x${n.toString(16)}`;
const say = (t) => process.stdout.write(t);
const fail = (msg, code = 1) => {
  process.stderr.write(`${msg}\n`);
  process.exit(code);
};
// 늦게 끝나는 도구 (ms) — 예: xinput을 늦춰 시작의 차례(Xvfb 확인 → 곁 도우미)를 본다 (FSD-4)
const delay = S.toolDelayMs?.[tool];
if (delay) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
if ((S.failTools ?? []).includes(tool)) fail(`${tool}: 가짜 실패`, 1);
if (tool !== 'xdpyinfo' && S.display === 'fail') fail(`${tool}: unable to open display`, 1);

const win = (id) => (S.windows ?? []).find((w) => w.id === id) ?? (S.unmanaged ?? []).find((w) => w.id === id);
const frameOf = (w) => {
  const [l, r, t, b] = w.frame ?? [0, 0, 0, 0];
  return { x: w.x - l, y: w.y - t, w: w.w + l + r, h: w.h + t + b };
};
/** Caps Lock(Lock)·Shift Lock(Shift)이 잠겼을 때 글자 바꾸기 (실제 X처럼 — 둘 다면 글자는 그대로, 숫자는 기호) */
const SHIFTED = { 1: '!', 2: '@', 3: '#', 4: '$', 5: '%', 6: '^', 7: '&', 8: '*', 9: '(', 0: ')' };
const capsFlip = (t) =>
  [...t]
    .map((c) => {
      if (/[a-z]/i.test(c)) return !!S.capsLock !== !!S.shiftLock ? (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()) : c;
      return S.shiftLock && SHIFTED[c] ? SHIFTED[c] : c;
    })
    .join('');
/**
 * 뒤로 가지 않는 '지금' (epoch ms): 장면을 만든 때의 벽시계에 그 뒤 흐른 단조 시계(hrtime — 프로세스가 달라도 같은 시계)를 더한다.
 * 실제 X의 쉼 시간은 서버의 단조 시계라 벽시계가 뒤로 당겨져도(WSL2는 30초마다 0.5초쯤) 줄지 않는다 — 벽시계로 흉내 내면 그 당김이
 * '새 입력'으로 보여 HUMAN이 잘못 났다 (Linux 전체 실행에서 한 번 실패 — 리드 결정 S10-15)
 */
const steadyNow = () => (S.clock ? S.clock.wall + (Number(process.hrtime.bigint() / 1_000_000n) - S.clock.monoMs) : Date.now());
const injected = () => {
  S.lastInputAt = steadyNow();
};
/**
 * 사람 (FSD-1): person = { after: 'type'|'mousemove', n, everyMs, from } — 도우미의 xdotool이 그 명령을 n번 보낸 뒤(그 호출이 끝날 때) 사람이 everyMs마다 입력한다
 * (포인터를 계속 움직이는 사람). 그 마지막 입력 시각(steadyNow 시계) — 아직이면 -Infinity
 */
const personLast = (now) => {
  const p = S.person;
  if (!p || p.from === undefined || p.from === null) return Number.NEGATIVE_INFINITY;
  const k = Math.floor((now - p.from) / p.everyMs);
  return k < 0 ? Number.NEGATIVE_INFINITY : p.from + k * p.everyMs;
};

switch (tool) {
  case 'xdpyinfo': {
    if (S.display === 'fail') fail('xdpyinfo:  unable to open display', 1);
    say(`name of display:    :7\nnumber of extensions:    3\n    MIT-SCREEN-SAVER\n    XInputExtension\n    XTEST\n${S.display === 'xwayland' ? '    XWAYLAND\n' : ''}`);
    break;
  }
  case 'xinput': {
    if (args[0] === 'list') {
      const names = ['Virtual core pointer', 'Virtual core XTEST pointer', 'Virtual core keyboard', 'Virtual core XTEST keyboard'];
      if (S.virtual) names.push('Xvfb mouse', 'Xvfb keyboard');
      else names.push('Logitech USB Receiver', 'AT Translated Set 2 keyboard');
      say(`${names.join('\n')}\n`);
    } else if (args[0] === 'query-state') {
      if (/keyboard/.test(args[1] ?? '')) {
        const down = new Set(S.keysDown ?? []);
        say(`1 class :\nKeyClass\n${[...Array(248).keys()].map((i) => `\tkey[${i + 8}]=${down.has(i + 8) ? 'down' : 'up'}`).join('\n')}\n`);
      } else {
        const down = new Set(S.buttonsDown ?? []);
        say(`2 classes :\nButtonClass\n${[1, 2, 3, 4, 5].map((b) => `\tbutton[${b}]=${down.has(b) ? 'down' : 'up'}`).join('\n')}\nValuatorClass Mode=Relative Proximity=In\n`);
      }
    }
    break;
  }
  case 'xrandr': {
    const mons = S.screens ?? [{ name: 'screen', x: 0, y: 0, w: 1280, h: 800, mmw: 339, mmh: 212 }];
    say(`Monitors: ${mons.length}\n${mons.map((m, i) => ` ${i}: +${m.primary ? '*' : ''}${m.name} ${m.w}/${m.mmw}x${m.h}/${m.mmh}+${m.x}+${m.y}  ${m.name}`).join('\n')}\n`);
    break;
  }
  case 'xprintidle': {
    const now = steadyNow();
    say(`${Math.max(0, now - Math.max(S.lastInputAt ?? now - 600_000, personLast(now)))}\n`);
    break;
  }
  case 'xprop': {
    if (args[0] === '-root') {
      const ids = (S.windows ?? []).map((w) => w.id);
      say(`_NET_CLIENT_LIST_STACKING: window id # ${ids.map(hex).join(', ')}\n`);
      say(S.active ? `_NET_ACTIVE_WINDOW: window id # ${hex(S.active)}\n` : '_NET_ACTIVE_WINDOW: window id # 0x0\n');
      say(S.wm === false ? '_NET_SUPPORTING_WM_CHECK:  not found.\n' : '_NET_SUPPORTING_WM_CHECK: window id # 0x200011\n');
      break;
    }
    const w = win(parseInt(args[1], 16));
    if (!w) fail('X Error: BadWindow', 1);
    const q = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    say(w.pid === undefined || w.pid === null ? '_NET_WM_PID:  not found.\n' : `_NET_WM_PID = ${w.pid}\n`);
    say(w.machine ? `WM_CLIENT_MACHINE = ${q(w.machine)}\n` : 'WM_CLIENT_MACHINE:  not found.\n');
    say(`_NET_WM_NAME = ${q(w.title ?? '')}\n`);
    say(`WM_NAME = ${q(w.title ?? '')}\n`);
    say(`WM_CLASS = ${(w.cls ?? ['app', 'App']).map(q).join(', ')}\n`);
    say(`_NET_WM_STATE = ${w.state ?? ''}\n`);
    say(w.frame ? `_NET_FRAME_EXTENTS = ${w.frame.join(', ')}\n` : '_NET_FRAME_EXTENTS:  not found.\n');
    say(`_NET_WM_WINDOW_TYPE = ${w.type ?? '_NET_WM_WINDOW_TYPE_NORMAL'}\n`);
    say(w.transientFor ? `WM_TRANSIENT_FOR: window id # ${hex(w.transientFor)}\n` : 'WM_TRANSIENT_FOR:  not found.\n');
    say('WM_CLIENT_LEADER:  not found.\n');
    break;
  }
  case 'xset': {
    say(`Keyboard Control:\n  auto repeat:  on    key click percent:  0    LED mask:  00000000\n  XKB indicators:\n    00: Caps Lock:   ${S.capsLock ? 'on ' : 'off'}    01: Num Lock:    ${S.numLock ? 'on ' : 'off'}    02: Scroll Lock: off\n    09: Mail:        off    10: Charging:    off    11: Shift Lock:  ${S.shiftLock ? 'on ' : 'off'}\n`);
    break;
  }
  case 'xwininfo': {
    const line = (id, name, r) => `     ${hex(id)} "${name}": ()  ${r.w}x${r.h}+${r.x}+${r.y}  +${r.x}+${r.y}`;
    if (args[0] === '-root' && args[1] === '-children') {
      // 위가 먼저: 관리되지 않는 창들, 그다음 관리되는 창(또는 그 틀)을 위에서부터
      const rows = [];
      for (const u of S.unmanaged ?? []) rows.push(line(u.id, u.title ?? '', u));
      for (const w of [...(S.windows ?? [])].reverse()) rows.push(w.frameId ? line(w.frameId, '', frameOf(w)) : line(w.id, w.title ?? '', w));
      say(`\nxwininfo: Window id: 0x21f (the root window) (has no name)\n\n  Root window id: 0x21f (the root window) (has no name)\n  Parent window id: 0x0 (none)\n     ${rows.length} children:\n${rows.join('\n')}\n\n`);
      break;
    }
    const id = parseInt(args[1], 16);
    const framed = (S.windows ?? []).find((w) => w.frameId === id);
    if (framed) {
      if (args[2] === '-tree') {
        say(`\nxwininfo: Window id: ${hex(id)} (has no name)\n\n  Root window id: 0x21f (the root window) (has no name)\n  Parent window id: 0x21f (the root window) (has no name)\n     1 child:\n${line(framed.id, framed.title ?? '', framed)}\n`);
      } else {
        const r = frameOf(framed);
        say(`\nxwininfo: Window id: ${hex(id)} (has no name)\n\n  Absolute upper-left X:  ${r.x}\n  Absolute upper-left Y:  ${r.y}\n  Width: ${r.w}\n  Height: ${r.h}\n  Map State: ${framed.mapped === false ? 'IsUnMapped' : 'IsViewable'}\n  Override Redirect State: no\n`);
      }
      break;
    }
    const w = win(id);
    if (!w) fail('xwininfo: error: BadWindow', 1);
    if (args[2] === '-tree') {
      say(`\nxwininfo: Window id: ${hex(w.id)} "${w.title}"\n\n  Root window id: 0x21f (the root window) (has no name)\n  Parent window id: 0x21f (the root window) (has no name)\n     0 children.\n`);
      break;
    }
    const unmanaged = (S.unmanaged ?? []).includes(w);
    say(
      `\nxwininfo: Window id: ${hex(w.id)} "${w.title}"\n\n  Absolute upper-left X:  ${w.x}\n  Absolute upper-left Y:  ${w.y}\n  Relative upper-left X:  1\n  Relative upper-left Y:  20\n  Width: ${w.w}\n  Height: ${w.h}\n  Depth: 24\n  Map State: ${w.mapped === false ? 'IsUnMapped' : 'IsViewable'}\n  Override Redirect State: ${unmanaged ? 'yes' : 'no'}\n`,
    );
    break;
  }
  case 'maim': {
    const g = args[args.indexOf('-g') + 1] ?? '';
    const m = /^(\d+)x(\d+)\+(-?\d+)\+(-?\d+)$/.exec(g);
    if (!m) fail('maim: bad geometry', 1);
    const w = Number(m[1]);
    const h = Number(m[2]);
    const row = 1 + w * 4;
    const raw = Buffer.alloc(row * h, 0x80);
    for (let y = 0; y < h; y++) raw[y * row] = 0;
    const chunk = (type, data) => {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(data.length);
      const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
      const crc = Buffer.alloc(4);
      crc.writeUInt32BE(crc32(td) >>> 0);
      return Buffer.concat([len, td, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8;
    ihdr[9] = 6; // RGBA — maim의 모양
    process.stdout.write(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 1 })), chunk('IEND', Buffer.alloc(0))]));
    break;
  }
  case 'xmodmap': {
    const km = S.keymap ?? { free: [], syms: {} };
    km.mapped ??= {};
    if (args[0] === '-pke') {
      const lines = [];
      for (let k = 8; k <= 255; k++) {
        const sym = km.mapped[k] ?? km.syms[k];
        lines.push(sym ? `keycode ${String(k).padStart(3)} = ${sym} ${sym}` : km.free.includes(k) ? `keycode ${String(k).padStart(3)} =` : `keycode ${String(k).padStart(3)} = Fake${k}`);
      }
      say(`${lines.join('\n')}\n`);
      break;
    }
    for (let i = 0; i < args.length; i++) {
      if (args[i] !== '-e') continue;
      const m = /^keycode (\d+) =\s*(\S*)/.exec(args[i + 1] ?? '');
      if (!m) fail('xmodmap: bad expression', 1);
      if (m[2]) km.mapped[m[1]] = m[2];
      else delete km.mapped[m[1]];
    }
    S.keymap = km;
    save();
    break;
  }
  case 'xdotool': {
    S.typed ??= {};
    S.keysDown ??= [];
    S.buttonsDown ??= [];
    const keycodeOf = (sym) => {
      const km = S.keymap ?? { syms: {} };
      for (const [k, s] of Object.entries(km.syms ?? {})) if (s === sym) return Number(k);
      return null;
    };
    let i = 0;
    while (i < args.length) {
      const c = args[i++];
      if (c === 'mousemove') {
        S.pointer = [Number(args[i]), Number(args[i + 1])];
        i += 2;
        S.moveCalls = (S.moveCalls ?? 0) + 1;
        injected();
      } else if (c === 'click') {
        while (args[i]?.startsWith('--')) i += 2;
        S.clicks = (S.clicks ?? 0) + 1;
        i += 1;
        injected();
        if (S.clickActive !== undefined) S.active = S.clickActive;
      } else if (c === 'mousedown' || c === 'mouseup') {
        const b = Number(args[i++]);
        S.buttonsDown = c === 'mousedown' ? [...new Set([...S.buttonsDown, b])] : S.buttonsDown.filter((x) => x !== b);
        injected();
      } else if (c === 'keydown' || c === 'keyup') {
        const code = keycodeOf(args[i++]);
        if (code !== null) S.keysDown = c === 'keydown' ? [...new Set([...S.keysDown, code])] : S.keysDown.filter((x) => x !== code);
        injected();
      } else if (c === 'key') {
        const k = args[i++];
        if (k === 'Caps_Lock') S.capsLock = !S.capsLock;
        else if (k === 'Num_Lock') S.numLock = !S.numLock;
        else if (k === 'Shift_Lock') S.capsLock = S.shiftLock = !S.shiftLock;
        else if (k === 'shift' || k === 'Shift_L') S.shiftLock = false;
        S.keys = [...(S.keys ?? []), k.length === 1 ? capsFlip(k) : k];
        injected();
      } else if (c === 'type') {
        while (args[i] && args[i] !== '--' && args[i].startsWith('--')) i += 2;
        if (args[i] === '--') i++;
        const text = capsFlip(args[i++] ?? '');
        const target = S.active ?? 0;
        S.typed[target] = (S.typed[target] ?? '') + text;
        S.typeCalls = (S.typeCalls ?? 0) + 1;
        // 앱이 치는 중에 포커스를 옮긴다 (칸을 다 채우면 다음 창으로 — 이 수만큼 친 뒤)
        const move = S.typeMoveFocus;
        if (move && [...S.typed[target]].length >= move.after) {
          S.active = move.to;
          S.typeMoveFocus = null;
        }
        injected();
      } else fail(`xdotool: 모르는 명령 ${c}`, 1);
    }
    // 사람이 이 호출이 끝날 때부터 움직이기 시작한다 (FSD-1)
    const p = S.person;
    if (p && (p.from === undefined || p.from === null) && ((p.after === 'type' ? S.typeCalls : S.moveCalls) ?? 0) >= p.n) p.from = steadyNow();
    save();
    break;
  }
  default:
    fail(`fakeX11Tool: 모르는 도구 ${tool}`, 2);
}
