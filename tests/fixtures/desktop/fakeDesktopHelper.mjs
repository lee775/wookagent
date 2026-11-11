// 가짜 화면 도우미 (리드 결정 S6-5·S6-13) — 모든 시험의 기본. 실제 도우미(resources/desktophelper/DesktopHelper.cs)와 같은 프로토콜 3판을
// 말하지만 화면을 찍거나 입력을 보내거나 창을 읽지 않는다. 화면·창·포커스·잠김은 시나리오가 정하고, 캡처는 만든 PNG를 화면 폴더에 쓴다.
//
// 설정: 환경 변수 WOOK_FAKE_DESKTOP = 시나리오 JSON (tests/fixtures/desktop/fakeDesktop.ts FakeDesktopScenario). 클라이언트가 주는
// WOOK_DESKTOP_SCREENS(캡처 폴더)·WOOK_DESKTOP_POLICY(막는 대상, base64)를 쓴다.
// - 받은 줄·보낸 줄·사건을 logPath에 JSONL로 남긴다 ({t, pid, dir: in|out|note, line}).
// - controlPath(JSON {actions:[{n, do, value}]})를 40ms마다 읽어 새 번호의 동작을 한 번씩 한다: human · hotkey · set(시나리오 일부 바꿈) ·
//   crash · line(줄 하나 보냄). 시작하기 전에 쓴 동작은 set만 시작할 때 들고, 사건(human·hotkey·crash·line)은 하지 않는다 (S6F2a, 리드 결정 S6-23 M5).
// - 쓰는 곳은 이 실행의 임시 폴더(os.tmpdir()) 아래뿐이다 — 밖이면 FAIL INIT으로 끝난다 (S6-15).
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, relative, resolve, isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import { crc32, deflateSync } from 'node:zlib';

const PROTOCOL = 3;
const started = Date.now();
const S = JSON.parse(process.env.WOOK_FAKE_DESKTOP || '{}');
const screensDir = process.env.WOOK_DESKTOP_SCREENS || '';
const out = (line) => {
  log('out', line);
  process.stdout.write(`${line}\n`);
};
function log(dir, line) {
  if (!S.logPath) return;
  try {
    appendFileSync(S.logPath, `${JSON.stringify({ t: Date.now(), pid: process.pid, dir, line })}\n`);
  } catch {
    // 시험이 폴더를 지웠다
  }
}
function insideTemp(p) {
  if (!p) return true;
  const rel = relative(resolve(tmpdir()), resolve(p));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

// ───── 장면 ─────
const scene = {
  screens: S.screens ?? [{ x: 0, y: 0, width: 1920, height: 1080, dpi: 96, primary: true }],
  windows: S.windows ?? [
    { title: '제목 없음 - 메모장', app: 'notepad', pid: 4242, x: 100, y: 100, width: 800, height: 600, minimized: false, blocked: false, elevated: false },
  ],
  focus: S.focus === undefined ? { app: 'notepad', title: '제목 없음 - 메모장', pid: 4242, control: 'Edit', password: false, blocked: false, elevated: false } : S.focus,
  lock: S.lock ?? null,
  errors: { ...(S.errors ?? {}) },
  errorQueue: [...(S.errorQueue ?? [])],
  hang: new Set(S.hang ?? []),
  delayMs: { ...(S.delayMs ?? {}) },
  noAck: new Set(S.noAck ?? []),
  heldKeys: S.heldKeys ?? 0,
  // 멈춤 단축키를 걸었는지 (ARM 답의 hotkey=0|1 — 실제 도우미는 ARM마다 다시 걸어 본다, 리드 결정 S6-21 D). 떠 있는 가짜에게 set으로 바꿀 수 있다
  hotkey: S.hotkey !== false,
  // 캡처 답의 sha256을 파일과 다르게 준다 (서버가 파일을 다시 해시해 거부하는지 — 리드 결정 S6-21 J3)
  wrongSha256: S.wrongSha256 === true,
  // S6F2b: TYPE이 글자 chars개 이상을 보내면 포커스를 focus로 옮긴다 — 칸을 다 채우면 다음 칸으로 넘어가는 양식 흉내 (리드 결정 S6-23 K2). 한 번만 (옮긴 뒤 지운다).
  // 떠 있는 가짜에게 set으로 줄 수 있다
  typeFocusAfter: S.typeFocusAfter ?? null,
};
let policy = decodePolicy(process.env.WOOK_DESKTOP_POLICY || '');
let stopped = false;
let armed = false;
let armSeed = -1;
let abortSeq = 0;
let abortReason = 'RELEASED';
let humanSeq = 0;
let dragging = false;

function decodePolicy(b64) {
  const p = { pids: [], titles: [], prefixes: [] };
  if (!b64) return p;
  for (const line of Buffer.from(b64, 'base64').toString('utf8').split('\n')) {
    const sp = line.indexOf(' ');
    if (sp < 0) continue;
    const k = line.slice(0, sp);
    const v = line.slice(sp + 1);
    if (k === 'pid') p.pids.push(Number(v));
    else if (k === 'title') p.titles.push(v);
    else if (k === 'prefix') p.prefixes.push(v);
  }
  return p;
}
function blocks(pid, title) {
  if (pid === process.pid || policy.pids.includes(pid)) return true;
  if (typeof title !== 'string') return false;
  return policy.titles.includes(title) || policy.prefixes.some((p) => title.startsWith(p));
}
function sortedScreens() {
  return [...scene.screens].sort((a, b) => (a.primary !== b.primary ? (a.primary ? -1 : 1) : a.x !== b.x ? a.x - b.x : a.y - b.y));
}
function layoutHash() {
  const text = sortedScreens()
    .map((m) => `${m.primary ? 'p' : 's'},${m.x},${m.y},${m.width},${m.height},${m.dpi ?? 96};`)
    .join('');
  return createHash('sha256').update(text, 'ascii').digest('hex').slice(0, 16);
}
function virtualRect() {
  const s = scene.screens;
  const x = Math.min(...s.map((m) => m.x));
  const y = Math.min(...s.map((m) => m.y));
  const r = Math.max(...s.map((m) => m.x + m.width));
  const b = Math.max(...s.map((m) => m.y + m.height));
  return { x, y, width: r - x, height: b - y };
}
function focusJson() {
  const f = scene.focus;
  if (!f) return 'null';
  // root는 가짜만 아는 창 표시다 — 실제 도우미의 포커스 답에는 없다 (아래 windowOf)
  const shown = { ...f };
  delete shown.root;
  return JSON.stringify({ ...shown, blocked: !!f.blocked || blocks(f.pid, f.title) });
}
// 포커스가 든 최상위 창 — 실제 도우미는 TYPE의 둘째 묶음부터 최상위 창(GetAncestor GA_ROOT)이 처음과 다르면 멈춘다 (DesktopHelper.cs DoType). 가짜는 포커스의
// root(시나리오가 주면 — 같은 창의 다른 칸·제목이 바뀐 같은 창)로, 없으면 pid와 제목으로 창을 가른다 (리드 결정 S6-25 P2)
function windowOf(f) {
  return f.root ?? `${f.pid}:${f.title}`;
}

// ───── PNG ─────
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}
function makePng(w, h, maxEdge) {
  const mode = S.png?.mode ?? 'grey';
  if (mode === 'fixed' && S.png?.base64) return Buffer.from(S.png.base64, 'base64');
  const row = 1 + w * 3;
  const raw = mode === 'noise' ? randomBytes(row * h) : Buffer.alloc(row * h, mode === 'black' ? 0 : 0x80);
  for (let y = 0; y < h; y++) raw[y * row] = 0;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 1 }))];
  // 큰 캡처 흉내: 이 최대 변보다 크게 찍으면 보조 덩어리로 부풀린다 (올바른 PNG 그대로)
  const pad = S.png?.padAboveEdge;
  if (pad && maxEdge > pad.edge) parts.push(chunk('wkPd', Buffer.alloc(pad.bytes)));
  parts.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

// ───── 시작 ─────
if (S.startStderr) process.stderr.write(`${S.startStderr}\n`);
for (const p of [S.logPath, S.controlPath, screensDir]) {
  if (!insideTemp(p)) {
    process.stdout.write('FAIL INIT outside_temp\n');
    process.exit(3);
  }
}
if (!screensDir || !existsSync(screensDir)) {
  process.stdout.write('FAIL INIT screens_dir\n');
  process.exit(3);
}
log('note', `start ${S.start ?? 'ready'}`);
const start = S.start ?? 'ready';
if (start === 'crash') {
  process.exit(9);
}
if (start === 'no_desktop') {
  out('FAIL NO_DESKTOP session0');
  process.exit(3);
}
if (start === 'init_fail') {
  out('FAIL INIT ui');
  process.exit(3);
}
if (start === 'exit_quiet') {
  process.exit(0);
}

let readySent = false;
function sendReady() {
  if (start === 'hang') return;
  if (start === 'bad_version') {
    out(`READY 2 1 locked=0 wda=1 build=19045`);
    return;
  }
  if (start === 'noise') {
    out('Microsoft (R) 어떤 안내 줄');
    out('');
  }
  readySent = true;
  out(`READY ${PROTOCOL} ${scene.screens.length} locked=${scene.lock ? 1 : 0} wda=${S.wda === false ? 0 : 1} build=${S.build ?? 19045}`);
  if (S.longLineAfterReady) process.stdout.write(`${'x'.repeat(S.longLineAfterReady)}\n`);
  if (S.exitAfterReadyMs !== undefined) setTimeout(() => process.exit(7), S.exitAfterReadyMs);
}
setTimeout(sendReady, S.readyDelayMs ?? 0);

// ───── 줄 읽기: STOP·RELEASE는 바로, 나머지는 하나씩 ─────
const queue = [];
let working = false;
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  log('in', line);
  if (line.length === 0 || line.length > 65536) return;
  if (line === 'STOP') {
    onStop();
    return;
  }
  const sp = line.indexOf(' ');
  if (sp <= 0) return;
  const id = line.slice(0, sp);
  if (!/^\d{1,9}$/.test(id)) return;
  const rest = line.slice(sp + 1);
  const verb = rest.split(' ')[0];
  if (S.crashOn === verb) {
    log('note', `crash on ${verb}`);
    process.exit(1);
  }
  if (rest === 'RELEASE') {
    onRelease(id);
    return;
  }
  if (stopped) {
    out(`${id} ERR STOPPED`);
    return;
  }
  queue.push({ id, rest });
  void work();
});
rl.on('close', () => {
  log('note', 'eof');
  if (S.ignoreEof) return;
  process.exit(0);
});
// 표준 입력이 닫혀도 끝나지 않는 가짜: 스스로 살아 있게 한다 (끝내는 것은 작업 개체·kill뿐)
if (S.ignoreEof) setInterval(() => undefined, 1 << 30);

async function work() {
  if (working) return;
  working = true;
  try {
    while (queue.length) {
      const { id, rest } = queue.shift();
      const sp = rest.indexOf(' ');
      const verb = sp < 0 ? rest : rest.slice(0, sp);
      const args = sp < 0 ? '' : rest.slice(sp + 1);
      if (scene.hang.has(verb)) continue; // 답하지 않는다 (다음 명령은 받는다)
      const delay = scene.delayMs[verb];
      if (delay) await sleep(delay);
      let reply;
      try {
        reply = stopped ? 'ERR STOPPED' : await dispatch(verb, args);
      } catch (e) {
        reply = `ERR INTERNAL ${e && e.name ? e.name : 'Error'}`;
      }
      out(`${id} ${reply}`);
    }
  } finally {
    working = false;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function injectedError(verb) {
  const i = scene.errorQueue.findIndex((e) => e.verb === verb);
  if (i >= 0) return `ERR ${scene.errorQueue.splice(i, 1)[0].err}`;
  if (scene.errors[verb]) return `ERR ${scene.errors[verb]}`;
  return null;
}

async function dispatch(verb, args) {
  const injected = injectedError(verb);
  switch (verb) {
    case 'SCREENS':
      if (injected) return injected;
      return `OK ${JSON.stringify({ layout: layoutHash(), screens: sortedScreens().map((m, i) => ({ index: i + 1, primary: !!m.primary, x: m.x, y: m.y, width: m.width, height: m.height, dpi: m.dpi ?? 96 })) })}`;
    case 'WINDOWS': {
      if (scene.lock) return `ERR LOCKED ${scene.lock}`;
      if (injected) return injected;
      const wins = scene.windows.map((w) => ({ ...w, blocked: !!w.blocked || blocks(w.pid, w.title) }));
      return `OK ${JSON.stringify({ windows: wins.slice(0, 200), total: wins.length })}`;
    }
    case 'FOCUS':
      if (scene.lock) return `ERR LOCKED ${scene.lock}`;
      if (injected) return injected;
      return `OK ${focusJson()}`;
    case 'ARM': {
      if (injected) return injected;
      const p = args ? decodePolicy(args) : null;
      if (args && !p) return 'ERR BAD_ARGS policy';
      if (p) policy = p;
      if (armSeed < 0 || !armed) armSeed = S.seedMs ?? started - 60_000;
      // S6F1a: seedFromRelease — 놓기가 실제로 뗀 키의 올림도 '마지막 입력'이다 (실제 도우미의 GetLastInputInfo처럼, 리드 결정 S6-21 F3)
      if (S.seedFromRelease && lastLiftAt > armSeed) armSeed = lastLiftAt;
      const first = !armed;
      armed = true;
      if (first) scheduleArmEvents();
      return `OK seed=${armSeed} hotkey=${scene.hotkey === false ? 0 : 1}`;
    }
    case 'CAPTURE':
      return capture(args, injected);
    case 'MOVE':
    case 'CLICK':
    case 'DRAG':
    case 'SCROLL':
    case 'KEY':
    case 'TYPE':
      return input(verb, args, injected);
    default:
      return 'ERR BAD_ARGS verb';
  }
}

function capture(args, injected) {
  const a = args.split(' ');
  if (a.length !== 3) return 'ERR BAD_ARGS';
  const maxEdge = Number(a[1]);
  const id = a[2];
  if (!/^SC-\d{6,12}$/.test(id)) return 'ERR BAD_ARGS id';
  if (!Number.isInteger(maxEdge) || maxEdge < 1) return 'ERR BAD_ARGS maxEdge';
  if (scene.lock) return `ERR LOCKED ${scene.lock}`;
  if (injected) return injected;
  let r;
  if (a[0] === 'all') r = virtualRect();
  else {
    const idx = Number(a[0]);
    const mons = sortedScreens();
    if (!Number.isInteger(idx) || idx < 1 || idx > mons.length) return 'ERR BAD_ARGS screen';
    r = mons[idx - 1];
  }
  const scale = Math.min(1, maxEdge / Math.max(r.width, r.height));
  const w = Math.max(1, Math.round(r.width * scale));
  const h = Math.max(1, Math.round(r.height * scale));
  const final = join(screensDir, `${id}.png`);
  if (existsSync(final)) return 'ERR BAD_ARGS id_exists';
  const png = makePng(w, h, maxEdge);
  writeFileSync(`${final}.tmp`, png);
  renameSync(`${final}.tmp`, final);
  // wrongSha256: 쓴 파일과 다른 해시를 답한다 (파일은 그대로 둔다 — 지우는 것은 서버의 몫)
  const sha = createHash('sha256').update(png).update(scene.wrongSha256 ? 'wrong' : '').digest('hex');
  return `OK ${w} ${h} ${r.x} ${r.y} ${r.width} ${r.height} ${layoutHash()} ${sha}`;
}

const NAMED = new Set(['enter', 'return', 'tab', 'esc', 'escape', 'space', 'backspace', 'delete', 'del', 'insert', 'ins', 'home', 'end', 'pageup', 'pgup', 'pagedown', 'pgdn', 'up', 'down', 'left', 'right', 'printscreen', 'prtsc', 'menu', 'apps', 'capslock', 'plus', 'minus']);
// 글자를 찍지 않는 키 (이동·기능 키) — 이 목록에 없는 키는 모두 글자 키다 (DesktopHelper.cs KeyMap.NonPrintable·core/screenGuard.ts NON_PRINTABLE_KEYS와 같은 목록,
// 리드 결정 S6-21 B2). 새 이름 키를 더하고 이 목록을 잊으면 글자 키로 다뤄져 암호 칸에서 막힌다 (막는 쪽)
const NON_PRINTABLE = new Set(['enter', 'return', 'tab', 'esc', 'escape', 'backspace', 'delete', 'del', 'insert', 'ins', 'home', 'end', 'pageup', 'pgup', 'pagedown', 'pgdn', 'up', 'down', 'left', 'right', 'printscreen', 'prtsc', 'menu', 'apps', 'capslock']);
for (let i = 1; i <= 24; i++) {
  NAMED.add(`f${i}`);
  NON_PRINTABLE.add(`f${i}`);
}
function parseCombo(text) {
  const parts = text.split('+');
  const mods = new Set();
  let key = null;
  for (let i = 0; i < parts.length; i++) {
    const raw = parts[i];
    const p = raw.toLowerCase();
    const last = i === parts.length - 1;
    if (!raw) return null;
    if (['ctrl', 'control', 'alt', 'shift', 'win', 'meta', 'super'].includes(p) && !last) {
      mods.add(p === 'control' ? 'ctrl' : p === 'meta' || p === 'super' ? 'win' : p);
      continue;
    }
    if (!last) return null;
    if (raw.length > 1 && !NAMED.has(p)) return null;
    // 글자 하나는 무엇이든 받는다. 실제 도우미는 서버 PC의 자판 배열로 칠 수 없는 글자(VkKeyScanW가 -1)를 ERR BAD_ARGS combo로 거부한다(DesktopHelper.cs
    // KeyMap.Parse) — 이 가짜는 그것을 흉내 내지 않는다. 한국어·영어(미국) 자판에는 그런 ASCII 글자가 없다 (검토 2차 tests-integrity 4, 리드 결정 S6-23 T4).
    // 같은 까닭으로(배열을 모른다) 'alt+@'처럼 배열이 Ctrl+Alt를 채우는 조합(AltGr 자판)도 여기서는 단축키지만, 실제 도우미는 보내는 조합으로 한 번 더 보아 글자 키로 막는다
    key = raw.length > 1 ? p : raw;
  }
  if (!key) return null;
  // 글자 키인지는 메인이 준 키로 정한다 (리드 결정 S6-21 B2·S6-23 K1): 그 키가 이동·기능 키가 아니고, 메인이 수정 키를 쓰지 않았거나(Shift만은 글자) Win 없이
  // Ctrl과 Alt를 함께 썼으면(AltGr — AltGr 자판에서 글자를 찍는다) 글자 키다. Ctrl만·Alt만·Win이 든 조합은 단축키다. 실제 도우미가 자판 배열 때문에 더하는
  // Ctrl+Alt(AltGr)는 이 판정에 들지 않는다
  const altGr = mods.has('ctrl') && mods.has('alt') && !mods.has('win');
  const shortcut = (mods.has('ctrl') || mods.has('alt') || mods.has('win')) && !altGr;
  const lower = key.toLowerCase();
  const printable = !shortcut && !NON_PRINTABLE.has(lower);
  const denied = (mods.has('win') && lower === 'l') || (mods.has('ctrl') && mods.has('alt') && (lower === 'delete' || lower === 'del' || (mods.has('shift') && lower === 'f12')));
  return { mods, key, printable, denied, altF4: mods.has('alt') && lower === 'f4' };
}

function windowAt(x, y) {
  return scene.windows.find((w) => !w.minimized && x >= w.x && x < w.x + w.width && y >= w.y && y < w.y + w.height) ?? null;
}
function pointTarget(x, y) {
  const w = windowAt(x, y);
  if (!w) return null;
  if (w.blocked || blocks(w.pid, w.title)) return 'ERR BLOCKED_TARGET window';
  if (w.elevated) return 'ERR ELEVATED_TARGET';
  return null;
}
function inScreen(x, y) {
  const v = virtualRect();
  return x >= v.x && x < v.x + v.width && y >= v.y && y < v.y + v.height;
}
function aborted(token, human) {
  if (stopped) return 'ERR STOPPED';
  if (token !== abortSeq) return `ERR ${abortReason}`;
  if (human !== humanSeq) return 'ERR HUMAN_ACTIVE';
  return null;
}

async function input(verb, args, injected) {
  const a = args.split(' ');
  const layout = a[a.length - 1];
  const token = abortSeq;
  const human = humanSeq;
  if (stopped) return 'ERR STOPPED';
  if (!armed) return 'ERR RELEASED';
  if (!/^[0-9a-f]{8,64}$/.test(layout)) return 'ERR BAD_ARGS layout';
  if (scene.lock) return `ERR LOCKED ${scene.lock}`;
  if (layout !== layoutHash()) return 'ERR LAYOUT_CHANGED';
  if (injected) return injected;
  const ints = (n) => a.slice(0, n).map(Number);
  switch (verb) {
    case 'MOVE':
    case 'CLICK':
    case 'SCROLL': {
      const [x, y] = ints(2);
      if (![x, y].every(Number.isInteger)) return 'ERR BAD_ARGS x/y';
      if (!inScreen(x, y)) return 'ERR BAD_ARGS outside';
      const t = pointTarget(x, y);
      if (t) return t;
      if (verb === 'CLICK' && S.clickFocus !== undefined) scene.focus = S.clickFocus;
      return `OK ${focusJson()}`;
    }
    case 'DRAG': {
      const [x1, y1, x2, y2] = ints(4);
      if (![x1, y1, x2, y2].every(Number.isInteger)) return 'ERR BAD_ARGS x/y';
      if (!inScreen(x1, y1) || !inScreen(x2, y2)) return 'ERR BAD_ARGS outside';
      const t = pointTarget(x1, y1) ?? pointTarget(x2, y2);
      if (t) return t;
      dragging = true;
      try {
        for (let i = 1; i <= 12; i++) {
          if (S.dragStepMs) await sleep(S.dragStepMs);
          const stop = aborted(token, human);
          if (stop) return `${stop} sent=${i - 1}`;
        }
      } finally {
        dragging = false;
      }
      return `OK ${focusJson()}`;
    }
    case 'KEY': {
      const c = parseCombo(a[0] ?? '');
      if (!c) return 'ERR BAD_ARGS combo';
      if (c.denied) return 'ERR BLOCKED_TARGET key';
      const f = scene.focus;
      if (f) {
        if (f.blocked || blocks(f.pid, f.title)) return 'ERR BLOCKED_TARGET window';
        if (f.elevated) return 'ERR ELEVATED_TARGET';
        if (c.altF4 && f.shell) return 'ERR BLOCKED_TARGET shell';
      }
      if (c.printable) {
        if (!f || f.password === null || f.password === undefined) return 'ERR FOCUS_UNKNOWN';
        if (f.password) return 'ERR PASSWORD_FIELD';
      }
      return `OK ${focusJson()}`;
    }
    case 'TYPE': {
      let text;
      try {
        text = Buffer.from(a[0] ?? '', 'base64').toString('utf8');
      } catch {
        return 'ERR BAD_ARGS text';
      }
      if (!text) return 'ERR BAD_ARGS text';
      // 탭·줄바꿈 같은 제어 문자는 치지 않는다 — 탭·Enter는 포커스를 옮기므로 한 번의 TYPE이 포커스 하나만 보게 한다 (리드 결정 S6-21 B1)
      if (/[\x00-\x1f\x7f]/.test(text)) return 'ERR BAD_TEXT';
      const f = scene.focus;
      if (!f) return 'ERR FOCUS_UNKNOWN';
      if (f.blocked || blocks(f.pid, f.title)) return 'ERR BLOCKED_TARGET window';
      if (f.elevated) return 'ERR ELEVATED_TARGET';
      if (f.password === null || f.password === undefined) return 'ERR FOCUS_UNKNOWN';
      if (f.password) return 'ERR PASSWORD_FIELD';
      // S6F2b: 실제 도우미(DoType)처럼 글자 4개씩(코드 포인트 — 서로게이트 쌍은 나누지 않는다) 보내고, 둘째 묶음부터는 보내기 전에 포커스를 다시 본다
      // (리드 결정 S6-23 K2): 다른 최상위 창으로 갔거나(windowOf — 같은 프로그램의 다른 창도, S6-25 P2), 없거나, 암호 칸이거나 모르면 FOCUS_UNKNOWN
      // sent=<보낸 UTF-16 단위>로 멈춘다. 같은 창의 보통 칸이면 그 칸에 이어 친다. 끝난 뒤의 포커스를 OK에 싣는다. sent는 UTF-16 단위다 (실제 도우미와 같다)
      const chars = [...text];
      let sent = 0;
      let count = 0;
      for (let i = 0; i < chars.length; i += 4) {
        if (i > 0) {
          if (S.typeChunkMs) await sleep(S.typeChunkMs);
          const now = scene.focus;
          if (!now || windowOf(now) !== windowOf(f) || now.password !== false) return `ERR FOCUS_UNKNOWN sent=${sent}`;
        }
        const stop = aborted(token, human);
        if (stop) return `${stop} sent=${sent}`;
        const unit = chars.slice(i, i + 4);
        sent += unit.join('').length;
        count += unit.length;
        // 앱이 그 글자를 받고 포커스를 옮긴다 (흉내 — 다음 묶음 전의 다시 보기가 본다)
        const move = scene.typeFocusAfter;
        if (move && count >= move.chars) {
          scene.typeFocusAfter = null;
          scene.focus = move.focus;
          log('note', `type focus moved after ${count}`);
        }
      }
      return `OK ${focusJson()}`;
    }
  }
  return 'ERR BAD_ARGS';
}

// ───── 놓기 · 정지 · 사람 · 단축키 ─────
let lastLiftAt = -1; // S6F1a: 놓기·정지가 키를 실제로 뗀 때 (seedFromRelease)
function released() {
  const n = (dragging ? 1 : 0) + scene.heldKeys;
  scene.heldKeys = 0;
  if (n > 0) lastLiftAt = Date.now(); // S6F1a
  return n;
}
function onRelease(id) {
  armed = false;
  armSeed = -1;
  abortSeq++;
  abortReason = 'RELEASED';
  const n = released();
  if (scene.noAck.has('RELEASE')) return;
  out(`${id} OK ${n}`);
}
function onStop() {
  stopped = true;
  armed = false;
  abortSeq++;
  abortReason = 'STOPPED';
  const n = released();
  if (scene.noAck.has('STOP')) return;
  const ack = () => {
    out(`STOP OK ${n}`);
    if (S.exitOnStop) process.exit(0);
  };
  if (S.stopAckDelayMs) setTimeout(ack, S.stopAckDelayMs);
  else ack();
}
function human() {
  humanSeq++;
  const at = Date.now();
  log('note', 'human');
  out(`HUMAN ${at}`);
}
function hotkey() {
  armed = false;
  armSeed = -1;
  abortSeq++;
  abortReason = 'HUMAN_ACTIVE hotkey';
  released();
  log('note', 'hotkey');
  out(`HOTKEY ${Date.now()}`);
}
function scheduleArmEvents() {
  for (const ms of S.humanAfterArmMs ?? []) setTimeout(human, ms);
  if (S.hotkeyAfterArmMs !== undefined) setTimeout(hotkey, S.hotkeyAfterArmMs);
}

// ───── 제어 파일 ─────
// 동작은 두 갈래다 (S6F2a, 리드 결정 S6-23 M5). 상태를 바꾸는 set은 시나리오의 일부처럼 뒤에 띄운 도우미에도 든다 — 이 프로세스가 시작하기 전에 쓴 set은 시작할 때
// (READY 전에) 순서대로 한 번에 든다. 사건(human · hotkey · crash · line)은 이 프로세스가 시작한 뒤에 쓴 것만 한다 — 앞 도우미에게 일으킨 crash·단축키·사람 입력을
// 새 도우미가 되풀이하지 않는다 (예전에는 새 도우미가 첫 읽기(40ms)에 앞의 crash로 끝났다)
function readActions() {
  try {
    return JSON.parse(readFileSync(S.controlPath, 'utf8')).actions ?? [];
  } catch {
    return null;
  }
}
function applySet(value) {
  if (!value || typeof value !== 'object') return;
  for (const [k, v] of Object.entries(value)) {
    if (k === 'hang') scene.hang = new Set(v);
    else if (k === 'noAck') scene.noAck = new Set(v);
    else if (k === 'errors') scene.errors = { ...v };
    else if (k === 'delayMs') scene.delayMs = { ...v };
    else scene[k] = v;
  }
}
if (S.controlPath) {
  let done = 0;
  for (const act of readActions() ?? []) {
    if (typeof act.n !== 'number') continue;
    done = Math.max(done, act.n);
    if (act.do === 'set') {
      log('note', 'set before start');
      applySet(act.value);
    }
  }
  const poll = setInterval(() => {
    const actions = readActions();
    if (!actions) return;
    for (const act of actions) {
      if (typeof act.n !== 'number' || act.n <= done) continue;
      done = act.n;
      log('note', `act ${act.do}`);
      if (act.do === 'human') human();
      else if (act.do === 'hotkey') hotkey();
      else if (act.do === 'crash') process.exit(5);
      else if (act.do === 'line') out(String(act.value ?? ''));
      else if (act.do === 'set') applySet(act.value);
    }
  }, 40);
  poll.unref();
}

// ───── 그만 파일 ─────
// 시험의 정리는 이 가짜를 PID로 죽이지 않는다 — 끝난 프로세스의 PID 번호는 곧 다른 프로세스에 다시 쓰여, 기록해 둔 번호로 죽이면 남의 프로세스를 죽일 수 있다
// (리드 결정 S7-20 TI-8). 그래서 이 가짜의 폴더(기록 파일이 든 곳)에 quit-<PID> 파일이 생기거나 그 폴더가 지워지면(시험 정리) 스스로 끝난다
if (S.logPath) {
  const home = dirname(S.logPath);
  const quitFile = join(home, `quit-${process.pid}`);
  const quitPoll = setInterval(() => {
    if (!existsSync(quitFile) && existsSync(home)) return;
    log('note', 'quit');
    process.exit(0);
  }, 40);
  quitPoll.unref();
}
void readySent;
