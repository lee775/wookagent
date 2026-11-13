// 욱채 X11 화면 도우미 (SERVER_DESIGN 8.3, 리드 결정 S10-7) — Linux 서버의 화면 도우미. 서버의 Node가 띄우고, Windows 도우미(DesktopHelper.cs)와
// 같은 한 줄 프로토콜 3판을 말한다 (src/main/desktop/types.ts 머리말). 화면을 찍고 입력을 보내는 일은 X 도구를 자식으로 띄워 한다:
// xdotool(입력·포커스) · maim(캡처) · xprop·xwininfo(창) · xrandr(모니터) · xinput(XTEST로 누른 키·버튼) · xprintidle(사람 입력) · xdpyinfo(화면) ·
// xmodmap(글자 칠 키 자리). 멈춤 단축키·조작 중 표시·암호 칸은 곁 도우미 x11Sidecar.py(python3 -I -B -s, python3-xlib, gi/AT-SPI)가 맡는다 — 없으면 그렇다고
// READY에 말한다(sidecar=0, a11y=0).
//
// 환경 (띄우는 쪽 src/main/desktop/x11Launcher.ts가 작게 준다):
//   DISPLAY·XAUTHORITY — 붙을 X 화면. WOOK_DESKTOP_SCREENS·WOOK_DESKTOP_POLICY — 클라이언트가 준다 (Windows 도우미와 같다)
//   WOOK_X11_TOOLS — JSON {도구 이름: [절대 경로, ...앞 인자]} (띄우는 쪽이 /usr/bin 등에서 찾은 것. 시험은 가짜 도구)
//   WOOK_X11_SIDECAR — JSON [python3 절대 경로, '-I', '-B', '-s', 곁 도우미 경로] (없으면 곁 도우미 없음)
//   WOOK_X11_IDENTITY — JSON [python3 절대 경로, '-I', '-B', '-s', 곁 도우미 경로, '--identity'] — 화면의 주인 확인 (SC-1; 없으면 FAIL NO_DESKTOP unverified)
//   WOOK_X11_REQUIRE_XVFB=1 — 시험 중: 그 화면의 X 서버가 Xvfb가 아니면 FAIL NO_DESKTOP notxvfb (리드 결정 S10-7.11)
//   WOOK_X11_REQUIRE_XPID — 시험 중: 그 화면의 X 서버 PID가 시험이 적어 둔 것이 아니면 FAIL NO_DESKTOP notours (리드 결정 S10-13 SC-2)
//   WOOK_X11_TYPE_UNKNOWN=1 — 운영자 설정 screen.typeWithoutA11y: 암호 칸인지 가르지 못해도 type은 친다 (글자 키는 막는다 — 리드 결정 S10-7.6·S10-13 SC-4)
//   WOOK_X11_FORCE_REAL=1 — 시험 이음매: Xvfb도 실제 화면처럼 다룬다 (조작 중 표시를 띄운다)
//   WOOK_X11_PROC_ROOT — 시험 이음매: /proc 자리
//
// 안전 규칙 (Windows 도우미와 같은 차례): 정지·무장·배치 해시·잠김·배치 바뀜 → 그 점의 창(막는 창·높은 권한) → 주입. 사람의 키 입력은 읽지 않는다 —
// 사람 입력은 X 화면보호기의 쉼 시간(xprintidle)으로만 안다(내 주입이 아닌 때에 쉼이 0으로 돌아가면 사람 — 무장한 동안 250ms마다, 그리고 TYPE·DRAG의 걸음
// 사이마다, S10c2 FSD-1). 캡처 파일 말고는 아무 파일도 쓰지 않는다.
// 표준 입력이 닫히면(서버가 끝남) XTEST로 눌린 키·버튼을 떼고 끝난다.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { crc32, deflateSync, inflateSync } from 'node:zlib';

const PROTOCOL = 3;
const env = process.env;
const PROC = env.WOOK_X11_PROC_ROOT || '/proc';
const OWN_PID = process.pid;
// Windows에서 도는 시험(가짜 도구)에는 uid가 없다 — 그때만 WOOK_X11_TEST_UID
const OWN_UID = typeof process.getuid === 'function' ? process.getuid() : Number(env.WOOK_X11_TEST_UID ?? -1);
/** 조상을 찾기 시작할 PID — 가짜 /proc(WOOK_X11_PROC_ROOT)을 쓰는 시험만 WOOK_X11_PROC_SELF로 정한다 */
const SELF_PID = env.WOOK_X11_PROC_ROOT && /^\d+$/.test(env.WOOK_X11_PROC_SELF ?? '') ? Number(env.WOOK_X11_PROC_SELF) : OWN_PID;
const HOST = hostname();
const TYPE_UNKNOWN = env.WOOK_X11_TYPE_UNKNOWN === '1';
/** TYPE이 한 번에 보내는 글자 수 (코드 포인트 — Windows 도우미와 같다, 리드 결정 S6-23 K2) */
const TYPE_UNIT = 4;
/** 둘째 묶음부터 포커스를 다시 읽는 상한 (ms) — Windows 도우미의 TypeRecheckMs와 같다 */
const TYPE_RECHECK_MS = 250;
/** 키 자리를 바꾼 뒤 앱이 새 배열을 읽을 틈 (ms) — 이보다 빨리 치면 앱이 옛 배열로 읽어 글자가 바뀐다 (Xvfb에서 잰 것, S10c 보고서) */
const KEYMAP_SETTLE_MS = 40;
/** 사람 입력을 보는 간격 (ms) — Windows 도우미의 HUMAN 알림 간격과 같다 */
const HUMAN_POLL_MS = 250;
/** 내 주입이 끝난 뒤 이만큼은 쉼 시간이 0이어도 내 입력으로 본다 (ms) */
const OWN_INPUT_GRACE_MS = 120;
/**
 * TYPE·DRAG의 걸음 사이에서 남의 입력을 볼 때의 여유 (ms, FSD-1 — 리드 결정 S10-17). X 도구는 X 연결을 닫기 전에 XSync하므로 내 걸음의 마지막 입력은 그 도구가 끝난
 * 것을 본 때보다 늘 앞이다 — Xvfb에서 150걸음(type·mousemove·key)을 재 보니 1~10ms 앞이었고, 같은 입력을 두 번 잰 범위는 늘 겹쳤다(S10c2 보고). 여유는 X 서버의
 * ms 시계의 내림(두 번 재면 2ms까지)을 넉넉히 덮는다. 크게 잡으면 걸음 사이(실제 도구로 10~20ms)의 사람 입력을 놓친다
 */
const FOREIGN_SLACK_MS = 8;
/**
 * X 도구가 그 화면에 붙지 못했다는 오류 글 (FSD-3) — Xvfb에서 본 것(S10c2): X 서버가 끝났을 때와 다른 프로세스가 그 이름을 잡고 연결을 닫을 때 같다.
 * xdotool "Can't open display" · maim "Failed to open X display" · xprop·xwininfo·xdpyinfo·xmodmap·xset "unable to open display" · xrandr "Can't open display" ·
 * xinput "Unable to connect to X server" · xprintidle "couldn't open display"
 */
const OPEN_FAIL_RE = /can'?t open display|unable to open display|couldn'?t open display|failed to open x display|unable to connect to x server|failed creating new xdo instance/i;
const DRAG_STEPS = 12;
/** 곁 도우미의 첫 줄을 기다리는 상한 (ms) — 서버의 READY 상한(10초) 안 */
const SIDECAR_HELLO_MS = 7000;

// ───────────────────────── 쓰기 ─────────────────────────

let stdoutBroken = false;
function line(text) {
  if (stdoutBroken) return;
  try {
    process.stdout.write(`${text}\n`);
  } catch {
    stdoutBroken = true;
  }
}
/** 시작 실패: 줄을 다 쓴 뒤 끝낸다 (Windows의 파이프는 쓰기가 비동기라 바로 끝내면 줄이 사라진다 — 시험이 Windows에서도 이 도우미를 띄운다) */
function failExit(text, code = 3) {
  try {
    process.stdout.write(`${text}\n`, () => process.exit(code));
  } catch {
    process.exit(code);
  }
}
process.stdout.on('error', () => {
  // 서버가 사라졌다 — 키를 떼고 끝난다
  stdoutBroken = true;
  void shutdown(0);
});

// ───────────────────────── 도구 ─────────────────────────

const TOOL_NAMES = ['xdotool', 'maim', 'xprop', 'xwininfo', 'xrandr', 'xinput', 'xprintidle', 'xdpyinfo', 'xmodmap', 'xset'];

function parseJsonEnv(name) {
  const v = env[name];
  if (!v) return null;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

const tools = (() => {
  const t = parseJsonEnv('WOOK_X11_TOOLS');
  if (!t || typeof t !== 'object') return null;
  const out = {};
  for (const n of TOOL_NAMES) {
    const v = t[n];
    if (!Array.isArray(v) || v.length === 0 || v.some((x) => typeof x !== 'string' || !x)) return null;
    out[n] = v;
  }
  return out;
})();

/** 도구의 환경: 이 도우미의 환경 그대로 (띄우는 쪽이 이미 작게 줬다) 빼기 정책·화면 폴더 */
const toolEnv = (() => {
  const e = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v !== 'string') continue;
    if (k === 'WOOK_DESKTOP_POLICY' || k === 'WOOK_X11_TOOLS' || k === 'WOOK_X11_SIDECAR') continue;
    e[k] = v;
  }
  return e;
})();

const children = new Set();

/**
 * X 도구 하나를 띄워 끝날 때까지. 시간 상한을 넘기면 SIGKILL — code null. 화면의 주인을 확인하지 못한 동안(displayBad)에는 띄우지 않는다 — X 도구는 붙을 때
 * 쿠키를 보낸다 (SC-1). 도구가 그 화면에 붙지 못했거나(오류 글) 답하지 않아 끊었으면 그 화면을 곧바로 '확인하지 않음'으로 둔다 — 다음 도구 전에 주인을 다시 본다
 * (FSD-3, 리드 결정 S10-17): X 서버가 끝난 틈에 다른 프로세스가 그 이름을 잡았으면 쿠키를 보낸 것은 그때 이미 떠 있던 도구들뿐이다
 */
async function run(name, args, o = {}) {
  if (displayBad) return { code: null, out: Buffer.alloc(0), err: 'display not verified', refused: true };
  const r = await spawnCapture(tools[name], args, o);
  if (!r.spawnError && (r.timedOut || OPEN_FAIL_RE.test(r.err))) markDisplayUnverified();
  return r;
}

/** 프로그램 하나 (argv 앞부분 + 인자) — 화면에 붙지 않는 것(주인 확인)도 이것으로 */
function spawnCapture(argv, args, o = {}) {
  const timeoutMs = o.timeoutMs ?? 3000;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(argv[0], [...argv.slice(1), ...args], { env: toolEnv, stdio: [o.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ code: null, out: Buffer.alloc(0), err: String(e && e.message), spawnError: true });
      return;
    }
    children.add(child);
    const out = [];
    let errText = '';
    let done = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // 이미 끝났다
      }
    }, timeoutMs);
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => {
      if (errText.length < 2000) errText += d.toString('utf8');
    });
    child.on('error', (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      children.delete(child);
      resolve({ code: null, out: Buffer.alloc(0), err: String(e && e.message), spawnError: true });
    });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      children.delete(child);
      resolve({ code, out: Buffer.concat(out), err: errText, timedOut: timedOut && code === null });
    });
    if (o.input !== undefined) {
      child.stdin.on('error', () => undefined);
      child.stdin.end(o.input);
    }
  });
}

async function runText(name, args, o) {
  const r = await run(name, args, o);
  return { ...r, text: r.out.toString('utf8') };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 단조 시계 (ms) — 벽시계가 뒤로 가도 사람 입력·주입의 앞뒤가 바뀌지 않게 */
const mono = () => performance.now();

// ───────────────────────── 화면의 주인 확인 (SC-1, 리드 결정 S10-13) ─────────────────────────
// libxcb(X 도구)는 소켓 파일보다 추상 이름 @/tmp/.X11-unix/X<n>을 먼저 쓴다. 그 이름을 다른 프로세스가 쥐면 도구는 그쪽에 붙어 쿠키를 보낸다. 그래서 화면을 쓰기 전과
// 무장할 때마다(그리고 명령마다 1초가 지났으면) 두 소켓의 듣는 쪽을 python(곁 도우미 파일의 --identity, SO_PEERCRED)으로 본다: 추상 이름이 묶여 있고, 그 프로세스가
// 소켓 파일의 X 서버와 같고, 이 사용자의 것이어야 한다. 아니면 X 도구를 하나도 띄우지 않는다 (쿠키가 나가지 않는다). 확인은 연결만 하고 아무것도 보내지 않는다

const identityCmd = (() => {
  const v = parseJsonEnv('WOOK_X11_IDENTITY');
  return Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string' && x) ? v : null;
})();
/** 시험 문(리드 결정 S10-13 SC-2): 시험이 적어 둔 그 Xvfb의 PID — 그 X 서버가 아니면 쓰지 않는다 */
const REQUIRE_XPID = /^\d{1,10}$/.test(env.WOOK_X11_REQUIRE_XPID ?? '') ? Number(env.WOOK_X11_REQUIRE_XPID) : null;

/** DISPLAY → 이 기계의 화면 번호 (':N' · ':N.S' · 'unix:N'). 다른 기계(호스트 이름 — ssh -X 등)면 null */
function localDisplayNumber(d) {
  const m = /^(?:unix)?:(\d{1,5})(?:\.\d{1,3})?$/.exec(d ?? '');
  return m ? Number(m[1]) : null;
}

/** 확인하지 못한 까닭 (있으면 X 도구를 띄우지 않는다) · 마지막으로 확인한 때(단조 ms) · 마지막으로 확인해 본 때(결과와 상관없이) · 그때의 X 서버 PID */
let displayBad = null;
let verifiedAt = Number.NEGATIVE_INFINITY;
let checkedAt = Number.NEGATIVE_INFINITY;
/** X 도구가 마지막으로 그 화면에 붙지 못한 때 (단조 ms) */
let unverifiedAt = Number.NEGATIVE_INFINITY;
let xserverPid = null;

/**
 * X 도구가 그 화면에 붙지 못했다 (FSD-3): 곧바로 '확인하지 않음'으로 둔다 — 그 뒤 도구는 checkDisplay가 주인을 다시 확인할 때까지 뜨지 않는다. 이미 다른 까닭으로
 * 막혀 있으면 그 까닭 그대로
 */
function markDisplayUnverified() {
  if (!displayBad) displayBad = 'nodisplay';
  verifiedAt = Number.NEGATIVE_INFINITY;
  unverifiedAt = mono();
}

/** 한 번 확인: { ok, detail, pid } — 확인 도구가 없거나 답하지 않으면 unverified */
async function identityOnce() {
  const n = localDisplayNumber(env.DISPLAY);
  if (n === null) return { ok: false, detail: env.DISPLAY ? 'remote' : 'nodisplay', pid: null };
  if (!identityCmd) return { ok: false, detail: 'unverified', pid: null };
  const r = await spawnCapture(identityCmd, [String(n)], { timeoutMs: 4000 });
  const lineText = r.out.toString('utf8').trim().split('\n').pop() ?? '';
  try {
    const v = JSON.parse(lineText);
    if (v && v.ok === true && Number.isInteger(v.pid)) return { ok: true, detail: null, pid: v.pid };
    const detail = typeof v?.detail === 'string' && /^[a-z]{1,16}$/.test(v.detail) ? v.detail : 'unverified';
    return { ok: false, detail, pid: null };
  } catch {
    return { ok: false, detail: 'unverified', pid: null };
  }
}

/**
 * 화면의 주인을 maxAgeMs 안에 확인했으면 null, 아니면 지금 확인한다 — 괜찮으면 null, 아니면 그 까닭(그 뒤 X 도구를 띄우지 않는다). X 서버가 다시 떴으면(PID가 바뀜)
 * 옛 서버에 넣었던 키 자리는 사라졌다 — 잊는다
 */
async function checkDisplay(maxAgeMs) {
  if (!displayBad && mono() - verifiedAt <= maxAgeMs) return null;
  const started = mono();
  checkedAt = started;
  const r = await identityOnce();
  let bad = r.ok ? null : r.detail;
  if (!bad && REQUIRE_XPID !== null && r.pid !== REQUIRE_XPID) bad = 'notours';
  if (bad) {
    displayBad = bad;
    return bad;
  }
  // 이 확인이 도는 동안 X 도구가 화면에 붙지 못했다 — 이 '괜찮음'은 그 앞의 것일 수 있다. 다음 확인까지 막아 둔다 (FSD-3)
  if (unverifiedAt >= started) return displayBad ?? 'nodisplay';
  if (xserverPid !== null && r.pid !== xserverPid) {
    mappedChar.clear();
    keycodeUse.clear();
  }
  xserverPid = r.pid;
  displayBad = null;
  verifiedAt = mono();
  return null;
}

// ───────────────────────── 정책 · 조상 ─────────────────────────

/** base64(UTF-8 줄: v1 · pid n · title t · prefix p). 깨졌으면 null (DesktopHelper.cs Policy.Parse와 같다) */
function parsePolicy(b64) {
  const p = { pids: new Set(), titles: [], prefixes: [] };
  if (!b64) return p;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length % 4 !== 0) return null;
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(b64, 'base64'));
  } catch {
    return null;
  }
  for (const raw of text.split('\n')) {
    const l = raw.replace(/\r$/, '');
    const sp = l.indexOf(' ');
    if (sp <= 0) continue;
    const k = l.slice(0, sp);
    const v = l.slice(sp + 1);
    if (k === 'pid' && /^\d{1,10}$/.test(v) && Number(v) > 0) p.pids.add(Number(v));
    else if (k === 'title' && v) p.titles.push(v);
    else if (k === 'prefix' && v) p.prefixes.push(v);
  }
  return p;
}

let policy = { pids: new Set(), titles: [], prefixes: [] };

/** /proc/<pid>/stat → { ppid, start, comm } (모르면 null). comm은 괄호 안 — 공백·괄호가 든 이름도 마지막 ')'까지 */
function procStat(pid) {
  try {
    const s = readFileSync(join(PROC, String(pid), 'stat'), 'utf8');
    const open = s.indexOf('(');
    const close = s.lastIndexOf(')');
    if (open < 0 || close < open) return null;
    const rest = s.slice(close + 2).split(' ');
    // rest[0] = state(3번째), rest[1] = ppid(4번째), rest[19] = starttime(22번째)
    return { comm: s.slice(open + 1, close), ppid: Number(rest[1]), start: Number(rest[19]) };
  } catch {
    return null;
  }
}

/** /proc/<pid>/status의 Uid (실제 uid). 읽지 못하면 null */
function procUid(pid) {
  try {
    const m = /^Uid:\s+(\d+)/m.exec(readFileSync(join(PROC, String(pid), 'status'), 'utf8'));
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

function procComm(pid) {
  try {
    return readFileSync(join(PROC, String(pid), 'comm'), 'utf8').trim();
  } catch {
    return null;
  }
}

/**
 * 이 도우미의 조상 (서버 → 그 부모 → … 12단계). 부모가 자식보다 늦게 시작했으면 다시 쓰인 PID라 거기서 멈춘다. PID 1과 systemd(사용자 관리자 — Windows의
 * explorer.exe처럼 모든 것의 부모)는 넣지 않는다. 구하지 못하면 null — 그때는 터미널 종류의 창을 모두 막는다 (DesktopHelper.cs AncestorPids와 같은 생각)
 */
function ancestorPids() {
  const chain = new Set();
  let cur = SELF_PID;
  let curStat = procStat(cur);
  if (!curStat) return null;
  let found = false;
  for (let depth = 0; depth < 12; depth++) {
    const parent = curStat.ppid;
    if (!Number.isInteger(parent) || parent <= 1 || parent === cur) break;
    const ps = procStat(parent);
    if (!ps) break;
    if (Number.isFinite(ps.start) && Number.isFinite(curStat.start) && ps.start > curStat.start) break;
    found = true;
    if (ps.comm !== 'systemd' && ps.comm !== 'init') chain.add(parent);
    cur = parent;
    curStat = ps;
  }
  return found ? chain : null;
}

let ancestors = null;
/** 곁 도우미의 PID — 그 창(조작 중 표시)은 목록·맞히기에서 뺀다 */
let sidecarPid = -1;

const TERMINAL_CLASSES = /^(xterm|uxterm|gnome-terminal|gnome-terminal-server|konsole|xfce4-terminal|mate-terminal|terminator|tilix|kitty|alacritty|urxvt|rxvt|st|lxterminal|qterminal|foot|wezterm|code|org\.wezfurlong\.wezterm)$/i;

function blocksWindow(f) {
  if (f.pid === OWN_PID || (f.pid !== null && policy.pids.has(f.pid))) return true;
  if (policy.titles.includes(f.title)) return true;
  if (policy.prefixes.some((p) => f.title.startsWith(p))) return true;
  if (ancestors === null) return TERMINAL_CLASSES.test(f.wmClass);
  return f.pid !== null && ancestors.has(f.pid);
}

// ───────────────────────── 화면 · 모니터 ─────────────────────────

let virtualDisplay = false;

/** xrandr --listmonitors → [{x,y,w,h,dpi,primary,name}] (주 모니터 먼저, 그다음 x, y — Windows 도우미와 같은 차례) */
async function monitors() {
  const r = await runText('xrandr', ['--listmonitors'], { timeoutMs: 2500 });
  if (r.code !== 0) throw new Error('xrandr');
  const mons = [];
  for (const l of r.text.split('\n')) {
    const m = /^\s*\d+:\s+\+?(\*?)(\S+)\s+(\d+)\/(\d+)x(\d+)\/(\d+)\+(-?\d+)\+(-?\d+)/.exec(l);
    if (!m) continue;
    const w = Number(m[3]);
    const mmw = Number(m[4]);
    mons.push({ primary: m[1] === '*', name: m[2], w, h: Number(m[5]), x: Number(m[7]), y: Number(m[8]), dpi: mmw > 0 ? Math.round(w / (mmw / 25.4)) : 96 });
  }
  if (mons.length === 0) throw new Error('no monitors');
  if (!mons.some((m) => m.primary)) mons[0].primary = true;
  mons.sort((a, b) => (a.primary !== b.primary ? (a.primary ? -1 : 1) : a.x !== b.x ? a.x - b.x : a.y - b.y));
  return mons;
}

function layoutHash(mons) {
  const text = mons.map((m) => `${m.primary ? 'p' : 's'},${m.x},${m.y},${m.w},${m.h},${m.dpi};`).join('');
  return createHash('sha256').update(text, 'ascii').digest('hex').slice(0, 16);
}

function virtualRect(mons) {
  const x = Math.min(...mons.map((m) => m.x));
  const y = Math.min(...mons.map((m) => m.y));
  const r = Math.max(...mons.map((m) => m.x + m.w));
  const b = Math.max(...mons.map((m) => m.y + m.h));
  return { x, y, w: r - x, h: b - y };
}

/** 잠김: 가상 화면은 늘 아님. 실제 화면은 곁 도우미가 X 화면보호기 상태를 본다 — 곁 도우미가 없으면 모른다(null — 그때는 입력도 받지 않는다) */
async function lockState() {
  if (virtualDisplay || !sidecar.ok) return null;
  const r = await sidecar.call({ op: 'lock' }, 1000);
  return r && r.locked === true ? 'locked' : null;
}

// ───────────────────────── 창 ─────────────────────────

/** xprop -notype 출력 → {이름: 값 글} */
function parseXprop(text) {
  const out = {};
  for (const l of text.split('\n')) {
    // 'NAME = 값' · 'NAME: window id # 0x…'(창 형식) · 'NAME:  not found.' — -notype이라 형식 이름은 없다(있어도 읽는다)
    const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:\([^)]*\))?(?:\s*=\s?(.*)|:\s+(.*))$/.exec(l);
    if (!m) continue;
    if (m[2] === undefined && /^(not found\.|no such atom)/.test((m[3] ?? '').trim())) continue;
    out[m[1]] = m[2] ?? m[3] ?? '';
  }
  return out;
}

/** xprop의 따옴표 글 (\" \\ \n \ooo 풀기). 여러 개면 목록 */
function xpropStrings(v) {
  const out = [];
  if (typeof v !== 'string') return out;
  let i = 0;
  while (i < v.length) {
    const q = v.indexOf('"', i);
    if (q < 0) break;
    let j = q + 1;
    const bytes = [];
    while (j < v.length && v[j] !== '"') {
      if (v[j] === '\\' && j + 1 < v.length) {
        const n = v[j + 1];
        if (/[0-7]/.test(n)) {
          const oct = /^[0-7]{1,3}/.exec(v.slice(j + 1))[0];
          bytes.push(parseInt(oct, 8));
          j += 1 + oct.length;
          continue;
        }
        const map = { n: 10, t: 9, r: 13, '\\': 92, '"': 34 };
        bytes.push(...Buffer.from(map[n] !== undefined ? String.fromCharCode(map[n]) : n, 'utf8'));
        j += 2;
        continue;
      }
      bytes.push(...Buffer.from(v[j], 'utf8'));
      j++;
    }
    out.push(Buffer.from(bytes).toString('utf8'));
    i = j + 1;
  }
  return out;
}

function xpropWindows(v) {
  if (typeof v !== 'string') return [];
  const out = [];
  for (const m of v.matchAll(/0x[0-9a-fA-F]+/g)) {
    const id = parseInt(m[0], 16);
    if (id > 0) out.push(id);
  }
  return out;
}

async function rootProps() {
  const r = await runText('xprop', ['-root', '-notype', '_NET_CLIENT_LIST_STACKING', '_NET_ACTIVE_WINDOW', '_NET_SUPPORTING_WM_CHECK'], { timeoutMs: 2000 });
  if (r.code !== 0) throw new Error('xprop root');
  const p = parseXprop(r.text);
  return {
    stacking: xpropWindows(p._NET_CLIENT_LIST_STACKING),
    active: xpropWindows(p._NET_ACTIVE_WINDOW)[0] ?? null,
    wm: xpropWindows(p._NET_SUPPORTING_WM_CHECK)[0] ?? null,
  };
}

/** 창 하나의 사실 (모르면 null — 사라진 창). 크기는 틀까지 넣은 바깥 크기 (Windows 도우미의 FrameBounds처럼 — 제목 줄의 닫기 단추도 그 창이다) */
async function windowFacts(id) {
  const hex = `0x${id.toString(16)}`;
  const [pr, wr] = await Promise.all([
    runText('xprop', ['-id', hex, '-notype', '_NET_WM_PID', 'WM_CLIENT_MACHINE', '_NET_WM_NAME', 'WM_NAME', 'WM_CLASS', '_NET_WM_STATE', '_NET_FRAME_EXTENTS', '_NET_WM_WINDOW_TYPE', 'WM_TRANSIENT_FOR', 'WM_CLIENT_LEADER'], { timeoutMs: 2000 }),
    runText('xwininfo', ['-id', hex], { timeoutMs: 2000 }),
  ]);
  if (pr.code !== 0 || wr.code !== 0) return null;
  const p = parseXprop(pr.text);
  const num = (re) => {
    const m = re.exec(wr.text);
    return m ? Number(m[1]) : null;
  };
  const x = num(/Absolute upper-left X:\s+(-?\d+)/);
  const y = num(/Absolute upper-left Y:\s+(-?\d+)/);
  const w = num(/\n\s*Width:\s+(\d+)/);
  const h = num(/\n\s*Height:\s+(\d+)/);
  if (x === null || y === null || w === null || h === null) return null;
  const viewable = /Map State:\s+IsViewable/.test(wr.text);
  const ext = (p._NET_FRAME_EXTENTS ?? '').split(',').map((s) => Number(s.trim()));
  const [fl, fr, ft, fb] = ext.length === 4 && ext.every((n) => Number.isInteger(n) && n >= 0 && n < 500) ? ext : [0, 0, 0, 0];
  const pidText = p._NET_WM_PID;
  const pid = pidText !== undefined && /^\d+$/.test(pidText.trim()) ? Number(pidText.trim()) : null;
  const machine = xpropStrings(p.WM_CLIENT_MACHINE)[0] ?? null;
  const title = xpropStrings(p._NET_WM_NAME)[0] ?? xpropStrings(p.WM_NAME)[0] ?? '';
  const cls = xpropStrings(p.WM_CLASS);
  const state = p._NET_WM_STATE ?? '';
  const type = p._NET_WM_WINDOW_TYPE ?? '';
  const local = pid !== null && (machine === null || machine === HOST);
  const uid = local ? procUid(pid) : null;
  const f = {
    id,
    pid,
    title,
    wmClass: cls[0] ?? '',
    app: (local ? procComm(pid) : null) ?? cls[0] ?? '',
    minimized: /_NET_WM_STATE_HIDDEN/.test(state),
    viewable,
    shell: /_NET_WM_WINDOW_TYPE_(DESKTOP|DOCK)/.test(type),
    x: x - fl,
    y: y - ft,
    w: w + fl + fr,
    h: h + ft + fb,
    // 높은 권한으로 본다 (리드 결정 S10-7.8): PID가 없음 · 다른 기계의 창 · 서버와 다른 사용자(root 포함)의 창 · 그 프로세스를 읽지 못함
    elevated: pid === null || (machine !== null && machine !== HOST) || uid === null || uid !== OWN_UID,
    blocked: false,
    overrideRedirect: /Override Redirect State:\s+yes/.test(wr.text),
    /** 주인을 찾을 창 (관리되지 않는 창이 PID를 적지 않았을 때) */
    owner: xpropWindows(p.WM_TRANSIENT_FOR)[0] ?? xpropWindows(p.WM_CLIENT_LEADER)[0] ?? null,
  };
  f.blocked = blocksWindow(f);
  return f;
}

/** 목록에 보이는 창 (z 순서 위가 먼저) — 보이거나 최소화된 것, 제목 있는 것, 이 도우미·곁 도우미의 것이 아닌 것 */
async function listWindows() {
  const root = await rootProps();
  const ids = [...root.stacking].reverse();
  const facts = [];
  // 4개씩 — 도구를 한꺼번에 많이 띄우지 않는다
  for (let i = 0; i < ids.length; i += 4) {
    const part = await Promise.all(ids.slice(i, i + 4).map((id) => windowFacts(id)));
    facts.push(...part);
  }
  return { root, windows: facts.filter((f) => f && (f.viewable || f.minimized) && f.pid !== OWN_PID && f.pid !== sidecarPid) };
}

/** 루트의 자식 창 — 위가 먼저 (xwininfo -root -children의 차례, Xvfb에서 본 것). 이름에 무엇이 들어도 줄 끝의 절대 자리로 읽는다 */
async function rootChildren() {
  const r = await runText('xwininfo', ['-root', '-children'], { timeoutMs: 2500 });
  if (r.code !== 0) throw new Error('xwininfo root');
  const out = [];
  for (const l of r.text.split('\n')) {
    const m = /^\s+(0x[0-9a-fA-F]+)\s.*\s(\d+)x(\d+)[+-]-?\d+[+-]-?\d+\s+\+(-?\d+)\+(-?\d+)\s*$/.exec(l);
    if (!m) continue;
    out.push({ id: parseInt(m[1], 16), w: Number(m[2]), h: Number(m[3]), x: Number(m[4]), y: Number(m[5]) });
  }
  return out;
}

/**
 * 그 점의 맨 위 창 (SC-6, 리드 결정 S10-13): 관리되는 창만이 아니라 보이는 최상위 창 모두에서 — 메뉴·팝업·알림·잠금 화면 같은 관리되지 않는 창(override-redirect)도.
 * 창 관리자의 틀이면 그 안의 관리되는 창이다. 관리되지 않는 창은 그 주인(_NET_WM_PID, 없으면 WM_TRANSIENT_FOR·WM_CLIENT_LEADER의 창)으로 막는 창·높은 권한을
 * 본다 — 주인을 알 수 없으면 { unowned: true } (거부한다). 조작 중 표시(곁 도우미의 창)는 지나간다. 아무 창도 없으면 null (바탕)
 */
async function windowAt(x, y) {
  const kids = (await rootChildren()).filter((k) => x >= k.x && x < k.x + k.w && y >= k.y && y < k.y + k.h);
  if (kids.length === 0) return null;
  const { windows } = await listWindows();
  const managed = new Map(windows.map((f) => [f.id, f]));
  for (const k of kids) {
    const hex = `0x${k.id.toString(16)}`;
    const info = await runText('xwininfo', ['-id', hex], { timeoutMs: 2000 });
    if (info.code !== 0 || !/Map State:\s+IsViewable/.test(info.text)) continue;
    const direct = managed.get(k.id);
    if (direct) return direct.minimized ? null : direct;
    // 창 관리자의 틀: 그 안에 관리되는 창이 있다
    const tree = await runText('xwininfo', ['-id', hex, '-tree'], { timeoutMs: 2000 });
    const inner = [...tree.text.matchAll(/0x[0-9a-fA-F]+/g)].map((m) => parseInt(m[0], 16)).find((id) => id !== k.id && managed.has(id));
    if (inner !== undefined) return managed.get(inner);
    // 관리되지 않는 창
    const f = await windowFacts(k.id);
    if (f && f.pid !== null && (f.pid === sidecarPid || f.pid === OWN_PID)) continue;
    if (f && f.pid !== null) return f;
    if (f && f.owner !== null) {
      const o = managed.get(f.owner) ?? (await windowFacts(f.owner));
      if (o && o.pid !== null) return { ...o, title: f.title || o.title, blocked: o.blocked || blocksWindow({ ...o, title: f.title }) };
    }
    return { unowned: true };
  }
  return null;
}

async function activeFacts() {
  const root = await rootProps();
  if (!root.active) return null;
  const f = await windowFacts(root.active);
  if (!f || f.pid === OWN_PID || f.pid === sidecarPid) return null;
  return f;
}

/** 암호 칸인지 (곁 도우미의 AT-SPI): {control, password: true|false|null} */
async function a11yFocus(f, capMs) {
  if (!f || !sidecar.ok || !sidecar.atspi || f.pid === null) return { control: null, password: null };
  const r = await sidecar.call({ op: 'focus', pid: f.pid, capMs }, capMs + 300);
  if (!r || r.ok !== true) return { control: null, password: null };
  return { control: typeof r.control === 'string' ? r.control : null, password: r.password === true ? true : r.password === false ? false : null };
}

function focusJson(f, a) {
  if (!f) return 'null';
  return JSON.stringify({
    app: f.app,
    title: f.title,
    pid: f.pid,
    control: a ? a.control : null,
    password: a ? a.password : null,
    blocked: f.blocked,
    elevated: f.elevated,
  });
}

// ───────────────────────── PNG ─────────────────────────

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}

/** 8비트 RGB·RGBA, 겹침 없는 PNG → {w, h, rgb} (maim이 만드는 모양) */
function decodePng(png) {
  if (png.length < 8 || png.readUInt32BE(0) !== 0x89504e47) throw new Error('png');
  let off = 8;
  let ihdr = null;
  const idat = [];
  while (off + 8 <= png.length) {
    const len = png.readUInt32BE(off);
    const type = png.toString('ascii', off + 4, off + 8);
    const data = png.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') ihdr = data;
    else if (type === 'IDAT') idat.push(data);
    off += 12 + len;
  }
  if (!ihdr) throw new Error('png');
  const w = ihdr.readUInt32BE(0);
  const h = ihdr.readUInt32BE(4);
  const ct = ihdr[9];
  if (ihdr[8] !== 8 || (ct !== 2 && ct !== 6) || ihdr[12] !== 0) throw new Error('png format');
  const bpp = ct === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const cur = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let i = 0; i < stride; i++) {
      const v = raw[src + i];
      const a = i >= bpp ? cur[dst + i - bpp] : 0;
      const b = y > 0 ? cur[dst - stride + i] : 0;
      const c = i >= bpp && y > 0 ? cur[dst - stride + i - bpp] : 0;
      let p = 0;
      if (filter === 1) p = a;
      else if (filter === 2) p = b;
      else if (filter === 3) p = (a + b) >> 1;
      else if (filter === 4) {
        const q = a + b - c;
        const pa = Math.abs(q - a);
        const pb = Math.abs(q - b);
        const pc = Math.abs(q - c);
        p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[dst + i] = (v + p) & 0xff;
    }
  }
  if (bpp === 3) return { w, h, rgb: cur };
  const rgb = Buffer.alloc(w * h * 3);
  for (let i = 0, j = 0; i < cur.length; i += 4, j += 3) {
    rgb[j] = cur[i];
    rgb[j + 1] = cur[i + 1];
    rgb[j + 2] = cur[i + 2];
  }
  return { w, h, rgb };
}

/** 넓이 평균으로 줄인다 (늘리지 않는다) */
function downscale(img, w2, h2) {
  const { w, h, rgb } = img;
  const out = Buffer.alloc(w2 * h2 * 3);
  const fx = w / w2;
  const fy = h / h2;
  for (let y2 = 0; y2 < h2; y2++) {
    const y0 = Math.floor(y2 * fy);
    const y1 = Math.max(y0 + 1, Math.min(h, Math.floor((y2 + 1) * fy)));
    for (let x2 = 0; x2 < w2; x2++) {
      const x0 = Math.floor(x2 * fx);
      const x1 = Math.max(x0 + 1, Math.min(w, Math.floor((x2 + 1) * fx)));
      let r = 0;
      let g = 0;
      let b = 0;
      for (let y = y0; y < y1; y++) {
        let p = (y * w + x0) * 3;
        for (let x = x0; x < x1; x++, p += 3) {
          r += rgb[p];
          g += rgb[p + 1];
          b += rgb[p + 2];
        }
      }
      const n = (y1 - y0) * (x1 - x0);
      const o = (y2 * w2 + x2) * 3;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
    }
  }
  return { w: w2, h: h2, rgb: out };
}

function encodePng(img) {
  const { w, h, rgb } = img;
  const row = w * 3;
  const raw = Buffer.alloc((row + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (row + 1)] = 0;
    rgb.copy(raw, y * (row + 1) + 1, y * row, y * row + row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(raw, { level: 6 })), pngChunk('IEND', Buffer.alloc(0))]);
}

// ───────────────────────── 곁 도우미 ─────────────────────────

const sidecar = {
  ok: false,
  atspi: false,
  grab: false,
  /**
   * 곁 도우미가 없는 까닭 (FSD-5) — READY sidecarwhy, 그 뒤에 끝났으면 ARM 답의 sidecar=: none(띄울 명령 없음 — python3 없음) · nostart(띄우지 못함) ·
   * exited(답하기 전·뒤에 프로세스가 끝남) · timeout(시간 안에 답하지 않음) · noxlib(python3-xlib 없음) · xconnect(python3-xlib가 화면에 붙지 못함)
   */
  why: null,
  proc: null,
  seq: 0,
  pending: new Map(),
  /** 요청 하나 — 답(객체)이나 시간 상한·끝남이면 null */
  call(req, timeoutMs) {
    if (!this.ok || !this.proc) return Promise.resolve(null);
    const id = ++this.seq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(null);
      }, timeoutMs);
      this.pending.set(id, (v) => {
        clearTimeout(timer);
        resolve(v);
      });
      try {
        this.proc.stdin.write(`${JSON.stringify({ ...req, id })}\n`);
      } catch {
        this.pending.delete(id);
        clearTimeout(timer);
        resolve(null);
      }
    });
  },
};

/**
 * 곁 도우미를 띄우고 첫 줄(hello)을 기다린다 (SIDECAR_HELLO_MS까지 — python·gi를 불러오는 데 바쁜 PC에서는 몇 초 걸린다). 없거나 실패하면 ok false — 사실대로 READY에
 * 말한다. 화면에 붙을 수 있다고 안 바로 뒤에 띄워, 나머지 시작 검사와 함께 기다린다
 */
function startSidecar() {
  const argv = parseJsonEnv('WOOK_X11_SIDECAR');
  if (!Array.isArray(argv) || argv.length < 2 || argv.some((x) => typeof x !== 'string')) {
    sidecar.why = 'none';
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), { env: toolEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      sidecar.why = 'nostart';
      resolve();
      return;
    }
    children.add(child);
    sidecar.proc = child;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      if (!sidecar.ok && !sidecar.why) sidecar.why = 'timeout';
      finish();
    }, SIDECAR_HELLO_MS);
    child.stdin.on('error', () => undefined);
    child.stderr.on('data', () => undefined);
    child.on('error', () => {
      sidecar.ok = false;
      sidecar.why = 'nostart';
      finish();
    });
    child.on('exit', () => {
      children.delete(child);
      const wasOk = sidecar.ok;
      // 프로세스가 끝났다 — python3-xlib가 없다고 답한 것과 다른 까닭이다 (FSD-5: 거부 글이 그 까닭을 말한다). 이미 답한 까닭(noxlib·xconnect)은 그대로
      if (wasOk || !sidecar.why || sidecar.why === 'timeout') sidecar.why = 'exited';
      sidecar.ok = false;
      sidecar.grab = false;
      for (const [, cb] of sidecar.pending) cb(null);
      sidecar.pending.clear();
      finish();
      // 무장한 채 곁 도우미가 죽었다 — 단축키도 표시도 없다. 입력을 멈춘다 (다음 ARM이 hotkey=0을 말한다)
      if (wasOk && armed && !virtualDisplay) beginDisarm('RELEASED');
    });
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on('line', (l) => {
      let msg;
      try {
        msg = JSON.parse(l);
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;
      if (msg.ev === 'hello') {
        sidecar.ok = msg.xlib === true;
        sidecar.atspi = msg.atspi === true;
        sidecar.grab = msg.grab === true;
        // python3-xlib를 불러오지 못함(import)과 화면에 붙지 못함(그 밖)을 가른다 (FSD-5)
        sidecar.why = sidecar.ok ? null : msg.xlibWhy === 'import' ? 'noxlib' : 'xconnect';
        sidecarPid = child.pid ?? -1;
        finish();
        return;
      }
      if (msg.ev === 'hotkey') {
        void onHotkey();
        return;
      }
      if (typeof msg.id === 'number') {
        const cb = sidecar.pending.get(msg.id);
        if (cb) {
          sidecar.pending.delete(msg.id);
          cb(msg);
        }
      }
    });
  });
}

// ───────────────────────── 상태 · 멈춤 ─────────────────────────

let screensDir = '';
let stopped = false;
let armed = false;
let armSeed = -1;
let abortSeq = 0;
let abortReason = 'RELEASED';
let humanSeq = 0;
/** 지금 도구로 주입하는 중인 수 · 마지막 주입이 끝난 때 (사람 입력과 가르기) */
let injecting = 0;
let lastOwnInputEnd = 0;
/** 내가 실제로 입력(XTEST)을 넣은 횟수 — 키 자리 바꾸기(xmodmap)는 세지 않는다 (걸음 사이의 남의 입력 보기, FSD-1) */
let ownInputSeq = 0;
let lastHumanEmitted = 0;
let humanTimer = null;
let humanPolling = false;
/** 이 도우미가 누른 채인 버튼 (DRAG) */
const pressedButtons = new Set();

/** 주입과 놓기를 한 줄로 세운다 — 놓은 뒤에는 옛 명령이 아무것도 보내지 못한다 (DesktopHelper.cs sendLock) */
let sendChain = Promise.resolve();
function withSendLock(fn) {
  const p = sendChain.then(fn, fn);
  sendChain = p.then(
    () => undefined,
    () => undefined,
  );
  return p;
}

/** 쥔 값이 그대로일 때만 그 도구를 띄운다 (놓기·정지 뒤에는 보내지 않는다). 보냈으면 true. 실패하면 던진다 */
function inject(token, name, args, timeoutMs = 3000) {
  return withSendLock(async () => {
    if (stopped || token !== abortSeq) return false;
    injecting++;
    ownInputSeq++;
    try {
      const r = await run(name, args, { timeoutMs });
      if (r.code !== 0) throw new Error(`${name} ${r.code === null ? 'timeout' : `exit ${r.code}`}`);
      return true;
    } finally {
      injecting--;
      lastOwnInputEnd = mono();
    }
  });
}

/** 떼기만 하는 것은 멈춘 뒤에도 보낸다 (DRAG는 늘 버튼을 떼고 끝난다). 도구가 끝까지 갔으면 true */
function injectUp(name, args) {
  return withSendLock(async () => {
    injecting++;
    ownInputSeq++;
    try {
      const r = await run(name, args, { timeoutMs: 2000 });
      return r.code === 0;
    } finally {
      injecting--;
      lastOwnInputEnd = mono();
    }
  });
}

function aborted(token, human) {
  if (stopped) return 'ERR STOPPED';
  if (token !== abortSeq) return `ERR ${abortReason}`;
  if (human !== humanSeq) return 'ERR HUMAN_ACTIVE';
  return null;
}

function beginDisarm(reason) {
  armed = false;
  armSeed = -1;
  abortReason = reason;
  abortSeq++;
  stopHumanPoll();
  return abortSeq;
}

// ───────────────────────── 키 자리 (글자 치기) ─────────────────────────

/** 빈 키 자리 (xmodmap -pke에서 기호가 없는 것) · 내가 기호를 넣은 자리 */
let freeKeycodes = [];
const mappedChar = new Map(); // 기호 이름(U+hex) → 키 자리
const keycodeUse = new Map(); // 키 자리 → 마지막으로 쓴 차례
let useTick = 0;
/** 키 자리 → 그 자리의 첫 기호 이름 (놓기에서 keyup 이름) */
let keysymOf = new Map();

/**
 * 키 배열을 읽는다. 끝나지 못한(SIGKILL) 도우미가 남긴 키 자리 — 기호가 꼭 'U<hex> U<hex>' 두 칸인 자리, premap이 넣는 모양 — 는 비우고 빈 자리로 센다 (SC-8).
 * 보통 자판 배열은 이름 있는 기호를 쓰므로 이 모양이 없다
 */
async function loadKeymap() {
  const r = await runText('xmodmap', ['-pke'], { timeoutMs: 2500 });
  if (r.code !== 0) return;
  const free = [];
  const syms = new Map();
  const leaked = [];
  for (const l of r.text.split('\n')) {
    const m = /^keycode\s+(\d+)\s*=\s*(.*)$/.exec(l);
    if (!m) continue;
    const code = Number(m[1]);
    const cols = m[2].trim().split(/\s+/).filter(Boolean);
    const first = cols[0];
    if (!first) {
      if (code >= 9) free.push(code);
    } else if (code >= 9 && cols.length === 2 && cols[0] === cols[1] && /^U[0-9A-F]{4,6}$/.test(cols[0])) {
      leaked.push(code);
      free.push(code);
    } else syms.set(code, first);
  }
  if (leaked.length > 0) {
    const exprs = [];
    for (const k of leaked) exprs.push('-e', `keycode ${k} =`);
    await run('xmodmap', exprs, { timeoutMs: 2000 });
  }
  freeKeycodes = free;
  keysymOf = syms;
}

const symName = (cp) => `U${cp.toString(16).toUpperCase().padStart(4, '0')}`;

/**
 * 이 묶음의 ASCII 밖 글자마다 빈 키 자리에 그 글자를 넣는다 (xmodmap 한 번) — 앞 묶음에 쓴 자리는 다시 쓰지 않는다. 넣었으면 앱이 새 배열을 읽을 틈을 둔다.
 * 그냥 `xdotool type`은 글자마다 한 자리를 바꿔 가며 쳐서, 앱이 배열을 늦게 읽으면 앞 글자가 뒤 글자로 바뀐다 ('안녕하세요' → '안하세요', Xvfb에서 잰 것)
 */
async function premap(chars) {
  useTick++;
  const need = [];
  for (const ch of chars) {
    const cp = ch.codePointAt(0);
    if (cp <= 0x7e) continue;
    const name = symName(cp);
    if (mappedChar.has(name)) {
      keycodeUse.set(mappedChar.get(name), useTick);
      continue;
    }
    if (!need.includes(name)) need.push(name);
  }
  if (need.length === 0 || freeKeycodes.length === 0) return;
  const exprs = [];
  for (const name of need) {
    // 가장 오래 쓰지 않은 자리 — 이번·바로 앞 묶음에 쓴 자리는 건드리지 않는다 (한 번도 쓰지 않은 자리는 -Infinity: 첫 묶음에도 고를 수 있다)
    const useOf = (k) => keycodeUse.get(k) ?? Number.NEGATIVE_INFINITY;
    const pick = [...freeKeycodes].sort((a, b) => useOf(a) - useOf(b)).find((k) => useOf(k) < useTick - 1);
    if (pick === undefined) break;
    for (const [n, k] of mappedChar) if (k === pick) mappedChar.delete(n);
    mappedChar.set(name, pick);
    keycodeUse.set(pick, useTick);
    exprs.push('-e', `keycode ${pick} = ${name} ${name}`);
  }
  if (exprs.length === 0) return;
  // 키 배열 바꾸기도 내 일로 센다 — 사람 입력 보기(쉼 시간)가 이 사이를 사람으로 읽지 않게
  injecting++;
  try {
    await run('xmodmap', exprs, { timeoutMs: 2000 });
    await sleep(KEYMAP_SETTLE_MS);
  } finally {
    injecting--;
    lastOwnInputEnd = mono();
  }
}

/** 넣었던 키 자리를 비운다 (무장을 풀 때·끝날 때) */
async function restoreKeymap() {
  if (mappedChar.size === 0) return;
  const exprs = [];
  for (const [, k] of mappedChar) exprs.push('-e', `keycode ${k} =`);
  mappedChar.clear();
  keycodeUse.clear();
  await run('xmodmap', exprs, { timeoutMs: 2000 });
}

// ───────────────────────── 놓기 ─────────────────────────

/** XTEST 장치로 눌린 키·버튼 (다른 도구가 누른 것도 — X 서버 하나에 하나다). 사람이 실제 자판으로 누른 키는 보지 않는다 */
async function xtestDown() {
  const [k, p] = await Promise.all([
    runText('xinput', ['query-state', 'Virtual core XTEST keyboard'], { timeoutMs: 1500 }),
    runText('xinput', ['query-state', 'Virtual core XTEST pointer'], { timeoutMs: 1500 }),
  ]);
  const keys = [...k.text.matchAll(/key\[(\d+)\]=down/g)].map((m) => Number(m[1]));
  const buttons = [...p.text.matchAll(/button\[(\d+)\]=down/g)].map((m) => Number(m[1])).filter((b) => b >= 1 && b <= 3);
  return { keys, buttons };
}

/** 이 도우미가 누른 버튼과 XTEST로 눌린 키·버튼을 모두 뗀다. 뗀 수 (한 번의 도구 호출 — 모두 같은 줄에서) */
function releaseAll() {
  return withSendLock(async () => {
    let n = 0;
    // 화면의 주인을 확인하지 못하면 아무 도구도 띄우지 않는다 (쿠키가 나가지 않게 — SC-1). 뗀 것은 없다
    if (await checkDisplay(1000)) {
      pressedButtons.clear();
      return 0;
    }
    try {
      const down = await xtestDown();
      const buttons = new Set([...pressedButtons, ...down.buttons]);
      const args = [];
      for (const b of buttons) args.push('mouseup', String(b));
      // 키 자리 → 지금 그 자리의 기호 이름: 시작 때의 배열, 그리고 내가 넣은 자리(premap — SC-9)
      const mappedName = new Map([...mappedChar].map(([name, code]) => [code, name]));
      const symOf = (code) => mappedName.get(code) ?? keysymOf.get(code) ?? null;
      for (const code of down.keys) {
        const sym = symOf(code);
        if (sym) args.push('keyup', sym);
      }
      if (args.length) {
        injecting++;
        ownInputSeq++;
        try {
          await run('xdotool', args, { timeoutMs: 2000 });
        } finally {
          injecting--;
          lastOwnInputEnd = mono();
        }
      }
      n = buttons.size + down.keys.filter((c) => symOf(c) !== null).length;
    } catch {
      // 뗄 수 없었다 — 센 수만큼만 말한다
    }
    pressedButtons.clear();
    return n;
  });
}

async function onHotkey() {
  const at = Date.now();
  beginDisarm('HUMAN_ACTIVE hotkey');
  await releaseAll();
  await sidecar.call({ op: 'disarm' }, 800);
  line(`HOTKEY ${at}`);
}

// ───────────────────────── 사람 입력 (쉼 시간) ─────────────────────────

/**
 * 마지막 입력 시각 (epoch ms)의 범위: 도구가 쉼 시간을 잰 때는 띄운 때(t0)와 끝난 때(t1) 사이다 — early = t0 − 쉼, late = t1 − 쉼. 같은 입력을 두 번 재도 값이
 * 도구를 띄우는 데 걸린 시간만큼 흔들린다: 새 입력은 그 early가 앞 잰 값의 late보다 뒤일 때만이다
 */
async function lastInput() {
  const t0 = mono();
  const r = await runText('xprintidle', [], { timeoutMs: 1500 });
  const t1 = mono();
  const idle = Number(r.text.trim());
  if (r.code !== 0 || !Number.isFinite(idle)) return null;
  // 비교는 단조 시계로, 알리는 시각만 벽시계로 (벽시계가 뒤로 가도 사람 입력을 숨기지 않게)
  return { early: t0 - idle, late: t1 - idle, wall: Math.round(Date.now() - (mono() - (t0 - idle))) };
}

/** 남의 입력을 알아챘다: 도는 명령은 다음 검사에서 HUMAN_ACTIVE로 멈추고, 아직 알리지 않은 입력이면 HUMAN을 낸다 (사람 입력 보기와 같은 줄) */
function noteForeignInput(m) {
  humanSeq++;
  if (armed && m.early > lastHumanEmitted) {
    lastHumanEmitted = m.late;
    line(`HUMAN ${m.wall}`);
  }
}

/**
 * 명령 안의 남의 입력 (FSD-1, 리드 결정 S10-17). TYPE(4자 묶음)·DRAG(포인터 한 걸음)는 걸음을 잇달아 넣어, 사람 입력 보기(250ms마다 — 주입하는 동안과 내 주입 뒤
 * 120ms는 보지 않는다)가 그 사이를 보지 못한다. 그래서 걸음마다 그 바로 뒤와 다음 걸음 바로 앞에 쉼 시간을 잰다:
 *   - 걸음 바로 뒤(afterStep): 마지막 입력이 그 걸음이 끝난 때(도구가 끝난 것을 본 때)보다 뒤면 남의 것이다 — X 도구는 연결을 닫기 전에 XSync하므로 내 걸음의 마지막
 *     입력은 늘 그 앞이다 (Xvfb에서 잼, FOREIGN_SLACK_MS)
 *   - 다음 걸음 바로 앞(beforeStep): 마지막 입력이 바로 뒤에 잰 것보다 뒤면 남의 것이다 — 그 사이 나는 입력을 넣지 않았다(키 자리 바꾸기 xmodmap·창·포커스 읽기는
 *     쉼 시간을 건드리지 않는다)
 * 두 비교 모두 잰 값의 범위로 한다 — 새 입력은 그 가장 이른 때가 기준의 가장 늦은 때보다 뒤일 때만이다(도구를 띄우는 데 걸린 시간만큼 흔들리는 값을 새 입력으로 보지
 * 않는다 — S10c의 첫 판이 그렇게 잘못 봤다). 시각은 모두 단조 시계다(WSL의 벽시계는 뒤로 간다). 키 내용은 읽지 않는다.
 * 보지 못하는 것: 내 걸음이 도는 동안 시작해 그 걸음의 마지막 입력보다 앞서 끝난 남의 입력 (그 걸음의 입력에 가려진다)
 */
function stepWatch() {
  let base = null;
  return {
    async afterStep() {
      const end = lastOwnInputEnd;
      base = null;
      const seq = ownInputSeq;
      const m = await lastInput();
      // 재는 동안 내가 입력을 넣었으면(놓기의 키 올림 등) 이번 것은 기준으로 쓰지 않는다
      if (!m || seq !== ownInputSeq) return;
      if (m.early > end + FOREIGN_SLACK_MS) {
        noteForeignInput(m);
        return;
      }
      base = { ...m, seq };
    },
    async beforeStep() {
      const b = base;
      // 기준 뒤에 내가 입력을 넣었다(잠금 키 되돌리기 등) — 그 입력과 남의 입력을 가를 수 없어 견주지 않는다
      if (!b || b.seq !== ownInputSeq) return;
      const m = await lastInput();
      if (m && b.seq === ownInputSeq && m.early > b.late + FOREIGN_SLACK_MS) noteForeignInput(m);
    },
  };
}

function startHumanPoll() {
  if (humanTimer) return;
  humanTimer = setInterval(() => {
    if (humanPolling || !armed || stopped) return;
    humanPolling = true;
    void (async () => {
      try {
        if (injecting > 0) return;
        // 화면의 주인을 명령과 같이 1초마다 다시 본다 (FSD-3 — 무장한 동안 쉼 시간을 4번/초 잰다). 쓸 수 없는 동안에는 다시 보기도 1초에 한 번까지 (python을 4번/초 띄우지 않게)
        if (displayBad && mono() - checkedAt < 1000) return;
        if (await checkDisplay(1000)) return;
        const before = lastOwnInputEnd;
        const last = await lastInput();
        // 재는 동안 내가 주입했으면 이번 것은 버린다
        if (last === null || injecting > 0 || lastOwnInputEnd !== before) return;
        if (last.early > lastOwnInputEnd + OWN_INPUT_GRACE_MS && last.early > lastHumanEmitted && armed) {
          lastHumanEmitted = last.late;
          humanSeq++;
          line(`HUMAN ${last.wall}`);
        }
      } finally {
        humanPolling = false;
      }
    })();
  }, HUMAN_POLL_MS);
}

function stopHumanPoll() {
  if (humanTimer) clearInterval(humanTimer);
  humanTimer = null;
}

// ───────────────────────── 명령 ─────────────────────────

async function doScreens() {
  const mons = await monitors();
  return `OK ${JSON.stringify({
    layout: layoutHash(mons),
    screens: mons.map((m, i) => ({ index: i + 1, primary: m.primary, x: m.x, y: m.y, width: m.w, height: m.h, dpi: m.dpi })),
  })}`;
}

async function doWindows() {
  const lk = await lockState();
  if (lk) return `ERR LOCKED ${lk}`;
  const { windows } = await listWindows();
  const shown = windows.filter((f) => f.title.length > 0);
  return `OK ${JSON.stringify({
    windows: shown.slice(0, 200).map((f) => ({ title: f.title, app: f.app, pid: f.pid ?? 0, x: f.x, y: f.y, width: f.w, height: f.h, minimized: f.minimized, blocked: f.blocked, elevated: f.elevated })),
    total: shown.length,
  })}`;
}

async function doFocus() {
  const lk = await lockState();
  if (lk) return `ERR LOCKED ${lk}`;
  const f = await activeFacts();
  if (!f) return 'OK null';
  return `OK ${focusJson(f, await a11yFocus(f, 1500))}`;
}

async function doArm(args) {
  const p = parsePolicy(args);
  if (!p) return 'ERR BAD_ARGS policy';
  // 시작 값: 아무것도 주입하기 전의 마지막 입력 시각. 이미 무장했으면 처음 값
  let seed = armSeed;
  /** 단조 시계의 늦은 값 (이미 무장했으면 앞에서 정한 것 그대로) */
  let seedLate = Number.NEGATIVE_INFINITY;
  if (seed < 0 || !armed) {
    const last = await lastInput();
    if (last === null) return 'ERR INTERNAL idle';
    // 이른 값 — 서버가 내 마지막 입력과 견줄 때 사람 입력으로 잘못 보지 않는 쪽 (무장한 동안의 사람 입력은 HUMAN이 말한다). 서버에는 벽시계로 준다
    seed = last.wall;
    seedLate = last.late;
  }
  policy = p;
  const before = abortSeq;
  let hotkey = false;
  if (sidecar.ok) {
    // 실제 화면이면 조작 중 표시도 띄운다 (가상 화면에는 보는 사람이 없다 — 리드 결정 S10-7.5)
    const r = await sidecar.call({ op: 'arm', indicator: !virtualDisplay }, 1500);
    hotkey = !!r && r.ok === true && r.grab === true && (virtualDisplay || r.indicator === true);
  }
  if (stopped) return 'ERR STOPPED';
  if (abortSeq !== before) {
    await sidecar.call({ op: 'disarm' }, 800);
    return `ERR ${abortReason}`;
  }
  armSeed = seed;
  armed = true;
  // 시작 값보다 앞선 입력은 이미 시작 값이 말했다 — 그 뒤의 쉼 시간 되돌림만 사람 입력이다
  lastHumanEmitted = Math.max(lastHumanEmitted, seedLate);
  startHumanPoll();
  // READY 뒤에 곁 도우미가 끝났으면 그 까닭 (FSD-5 — READY는 sidecar=1이라 서버가 달리 알 길이 없다). 판은 3 그대로, 끝에 붙는 낱말 하나
  const gone = !sidecar.ok && sidecar.why ? ` sidecar=${sidecar.why}` : '';
  return `OK seed=${seed} hotkey=${hotkey ? 1 : 0}${gone}`;
}

async function doCapture(args) {
  const a = args.split(' ');
  if (a.length !== 3) return 'ERR BAD_ARGS';
  if (!/^\d{1,5}$/.test(a[1])) return 'ERR BAD_ARGS maxEdge';
  const maxEdge = Number(a[1]);
  if (maxEdge < 1 || maxEdge > 16384) return 'ERR BAD_ARGS maxEdge';
  const id = a[2];
  if (!/^SC-\d{6,12}$/.test(id)) return 'ERR BAD_ARGS id';
  const lk = await lockState();
  if (lk) return `ERR LOCKED ${lk}`;
  const mons = await monitors();
  const layout = layoutHash(mons);
  let r;
  if (a[0] === 'all') r = virtualRect(mons);
  else {
    if (!/^\d{1,2}$/.test(a[0])) return 'ERR BAD_ARGS screen';
    const idx = Number(a[0]);
    if (idx < 1 || idx > mons.length) return 'ERR BAD_ARGS screen';
    const m = mons[idx - 1];
    r = { x: m.x, y: m.y, w: m.w, h: m.h };
  }
  if (r.w <= 0 || r.h <= 0) return 'ERR INTERNAL empty_screen';
  const final = join(screensDir, `${id}.png`);
  const tmp = `${final}.tmp`;
  if (existsSync(final) || existsSync(tmp)) return 'ERR BAD_ARGS id_exists';
  // 조작 중 표시는 캡처 동안 걷는다 (실제 화면 — 가상 화면에는 없다)
  const hide = armed && !virtualDisplay && sidecar.ok;
  if (hide) await sidecar.call({ op: 'hide' }, 1000);
  let shot;
  try {
    shot = await run('maim', ['-u', '-f', 'png', '-g', `${r.w}x${r.h}+${r.x}+${r.y}`], { timeoutMs: 4000 });
  } finally {
    if (hide && armed) await sidecar.call({ op: 'show' }, 1000);
  }
  if (shot.code !== 0 || shot.out.length < 8) return 'ERR INTERNAL capture';
  const scale = Math.min(1, maxEdge / Math.max(r.w, r.h));
  const w = Math.max(1, Math.round(r.w * scale));
  const h = Math.max(1, Math.round(r.h * scale));
  let png;
  try {
    const img = decodePng(shot.out);
    if (img.w !== r.w || img.h !== r.h) return 'ERR INTERNAL capture_size';
    png = w === r.w && h === r.h ? encodePng(img) : encodePng(downscale(img, w, h));
  } catch {
    return 'ERR INTERNAL capture_decode';
  }
  const hash = createHash('sha256').update(png).digest('hex');
  try {
    writeFileSync(tmp, png, { flag: 'wx' });
    renameSync(tmp, final);
  } catch {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // 지우지 못한 임시 파일은 서버의 캡처 정리가 지운다
    }
    return 'ERR INTERNAL write';
  }
  return `OK ${w} ${h} ${r.x} ${r.y} ${r.w} ${r.h} ${layout} ${hash}`;
}

/** 입력 명령의 공통 앞 검사 (Windows 도우미 InputGate와 같은 차례). 통과하면 { token, human, mons } */
async function inputGate(layout) {
  const token = abortSeq;
  const human = humanSeq;
  if (stopped) return { err: 'ERR STOPPED' };
  if (!armed) return { err: 'ERR RELEASED' };
  if (!/^[0-9a-f]{8,64}$/.test(layout)) return { err: 'ERR BAD_ARGS layout' };
  const lk = await lockState();
  if (lk) return { err: `ERR LOCKED ${lk}` };
  const mons = await monitors();
  if (layout !== layoutHash(mons)) return { err: 'ERR LAYOUT_CHANGED' };
  return { token, human, mons };
}

function inScreen(mons, x, y) {
  return mons.some((m) => x >= m.x && x < m.x + m.w && y >= m.y && y < m.y + m.h);
}

async function pointTarget(x, y) {
  const f = await windowAt(x, y);
  if (!f) return null;
  // 주인을 알 수 없는 관리되지 않는 창(메뉴·팝업·잠금 화면)이 그 자리를 덮었다 — 보내지 않는다 (SC-6)
  if (f.unowned) return 'ERR BLOCKED_TARGET unowned';
  if (f.blocked) return 'ERR BLOCKED_TARGET window';
  if (f.elevated) return 'ERR ELEVATED_TARGET';
  return null;
}

const INT_RE = /^-?\d{1,7}$/;

async function doMove(args) {
  const a = args.split(' ');
  if (a.length !== 3) return 'ERR BAD_ARGS';
  if (!INT_RE.test(a[0]) || !INT_RE.test(a[1])) return 'ERR BAD_ARGS x/y';
  const [x, y] = [Number(a[0]), Number(a[1])];
  const g = await inputGate(a[2]);
  if (g.err) return g.err;
  if (!inScreen(g.mons, x, y)) return 'ERR BAD_ARGS outside';
  const t = await pointTarget(x, y);
  if (t) return t;
  if (!(await inject(g.token, 'xdotool', ['mousemove', String(x), String(y)]))) return aborted(g.token, g.human) ?? 'ERR RELEASED';
  return `OK ${focusJson(await activeFacts(), null)}`;
}

async function doClick(args) {
  const a = args.split(' ');
  if (a.length !== 5) return 'ERR BAD_ARGS';
  if (!INT_RE.test(a[0]) || !INT_RE.test(a[1])) return 'ERR BAD_ARGS x/y';
  const [x, y] = [Number(a[0]), Number(a[1])];
  const button = a[2] === 'left' ? 1 : a[2] === 'right' ? 3 : a[2] === 'middle' ? 2 : -1;
  if (button < 0) return 'ERR BAD_ARGS button';
  if (!/^[1-3]$/.test(a[3])) return 'ERR BAD_ARGS count';
  const count = Number(a[3]);
  const g = await inputGate(a[4]);
  if (g.err) return g.err;
  // 가운데 버튼은 X11에서 고른 글(PRIMARY)을 붙여 넣는다 — 비밀 값 검사를 건너뛴다. 보내지 않는다 (리드 결정 S10-7.8)
  if (button === 2) return 'ERR BLOCKED_TARGET middle';
  if (!inScreen(g.mons, x, y)) return 'ERR BAD_ARGS outside';
  const t = await pointTarget(x, y);
  if (t) return t;
  // 이동 + 누름·뗌×n 이 한 번의 도구 호출이다 — 중간에 끊겨 버튼이 눌린 채 남지 않는다
  if (!(await inject(g.token, 'xdotool', ['mousemove', String(x), String(y), 'click', '--repeat', String(count), '--delay', '60', String(button)]))) {
    return aborted(g.token, g.human) ?? 'ERR RELEASED';
  }
  await sleep(30);
  return `OK ${focusJson(await activeFacts(), null)}`;
}

async function doDrag(args) {
  const a = args.split(' ');
  if (a.length !== 5) return 'ERR BAD_ARGS';
  if (!a.slice(0, 4).every((v) => INT_RE.test(v))) return 'ERR BAD_ARGS x/y';
  const v = a.slice(0, 4).map(Number);
  const g = await inputGate(a[4]);
  if (g.err) return g.err;
  if (!inScreen(g.mons, v[0], v[1]) || !inScreen(g.mons, v[2], v[3])) return 'ERR BAD_ARGS outside';
  let t = await pointTarget(v[0], v[1]);
  if (t) return t;
  t = await pointTarget(v[2], v[3]);
  if (t) return t;
  if (!(await inject(g.token, 'xdotool', ['mousemove', String(v[0]), String(v[1]), 'mousedown', '1']))) return aborted(g.token, g.human) ?? 'ERR RELEASED';
  pressedButtons.add(1);
  let sent = 0;
  let stop = null;
  // 걸음 사이의 남의 입력 (FSD-1) — 누름도 한 걸음이다
  const watch = stepWatch();
  try {
    await watch.afterStep();
    for (let i = 1; i <= DRAG_STEPS; i++) {
      await sleep(15);
      stop = aborted(g.token, g.human);
      if (stop) break;
      const bad = await checkDisplay(1000);
      if (bad) {
        stop = `ERR NO_DESKTOP ${bad}`;
        break;
      }
      await watch.beforeStep();
      stop = aborted(g.token, g.human);
      if (stop) break;
      const x = v[0] + Math.round(((v[2] - v[0]) * i) / DRAG_STEPS);
      const y = v[1] + Math.round(((v[3] - v[1]) * i) / DRAG_STEPS);
      if (!(await inject(g.token, 'xdotool', ['mousemove', String(x), String(y)]))) {
        stop = aborted(g.token, g.human) ?? 'ERR RELEASED';
        break;
      }
      sent = i;
      await watch.afterStep();
    }
  } finally {
    // 늘 버튼을 떼고 끝난다 (멈췄어도)
    await injectUp('xdotool', ['mouseup', '1']);
    pressedButtons.delete(1);
  }
  if (stop) return `${stop} sent=${sent}`;
  return `OK ${focusJson(await activeFacts(), null)}`;
}

async function doScroll(args) {
  const a = args.split(' ');
  if (a.length !== 4) return 'ERR BAD_ARGS';
  if (!a.slice(0, 3).every((v) => INT_RE.test(v))) return 'ERR BAD_ARGS x/y';
  const [x, y, amount] = a.slice(0, 3).map(Number);
  if (amount === 0 || amount < -20 || amount > 20) return 'ERR BAD_ARGS amount';
  const g = await inputGate(a[3]);
  if (g.err) return g.err;
  if (!inScreen(g.mons, x, y)) return 'ERR BAD_ARGS outside';
  const t = await pointTarget(x, y);
  if (t) return t;
  // 양수 = 아래로 (휠 단추 5), 음수 = 위로 (4)
  if (!(await inject(g.token, 'xdotool', ['mousemove', String(x), String(y), 'click', '--repeat', String(Math.abs(amount)), '--delay', '30', amount > 0 ? '5' : '4']))) {
    return aborted(g.token, g.human) ?? 'ERR RELEASED';
  }
  return `OK ${focusJson(await activeFacts(), null)}`;
}

// ── 키 조합 ──
const NAMED = {
  enter: 'Return', return: 'Return', tab: 'Tab', esc: 'Escape', escape: 'Escape', space: 'space', backspace: 'BackSpace', delete: 'Delete', del: 'Delete',
  insert: 'Insert', ins: 'Insert', home: 'Home', end: 'End', pageup: 'Prior', pgup: 'Prior', pagedown: 'Next', pgdn: 'Next', up: 'Up', down: 'Down',
  left: 'Left', right: 'Right', printscreen: 'Print', prtsc: 'Print', menu: 'Menu', apps: 'Menu', capslock: 'Caps_Lock', plus: 'plus', minus: 'minus',
};
for (let i = 1; i <= 24; i++) NAMED[`f${i}`] = `F${i}`;
/** 글자를 찍지 않는 키 (이동·기능 키) — DesktopHelper.cs NonPrintable·core/screenGuard.ts NON_PRINTABLE_KEYS와 같은 목록 */
const NON_PRINTABLE = new Set(['enter', 'return', 'tab', 'esc', 'escape', 'backspace', 'delete', 'del', 'insert', 'ins', 'home', 'end', 'pageup', 'pgup', 'pagedown', 'pgdn', 'up', 'down', 'left', 'right', 'printscreen', 'prtsc', 'menu', 'apps', 'capslock']);
for (let i = 1; i <= 24; i++) NON_PRINTABLE.add(`f${i}`);
const PUNCT = {
  '!': 'exclam', '@': 'at', '#': 'numbersign', $: 'dollar', '%': 'percent', '^': 'asciicircum', '&': 'ampersand', '*': 'asterisk', '(': 'parenleft', ')': 'parenright',
  '-': 'minus', _: 'underscore', '=': 'equal', '+': 'plus', '[': 'bracketleft', ']': 'bracketright', '{': 'braceleft', '}': 'braceright', '\\': 'backslash', '|': 'bar',
  ';': 'semicolon', ':': 'colon', "'": 'apostrophe', '"': 'quotedbl', ',': 'comma', '.': 'period', '<': 'less', '>': 'greater', '/': 'slash', '?': 'question',
  '`': 'grave', '~': 'asciitilde',
};

/** 'ctrl+shift+s' · 'enter' · 'A' → { mods, keysym, key, printable, denied, altF4 } · 모르면 null (DesktopHelper.cs KeyMap.Parse와 같은 판정) */
function parseCombo(text) {
  if (!text || text.length > 60) return null;
  const parts = text.split('+');
  let ctrl = false;
  let alt = false;
  let shift = false;
  let win = false;
  let keysym = null;
  let key = null;
  let printable = false;
  for (let i = 0; i < parts.length; i++) {
    const raw = parts[i];
    if (!raw) return null;
    const p = raw.toLowerCase();
    const last = i === parts.length - 1;
    if (!last || raw.length > 1) {
      if (p === 'ctrl' || p === 'control') {
        if (last) return null;
        ctrl = true;
        continue;
      }
      if (p === 'alt') {
        if (last) return null;
        alt = true;
        continue;
      }
      if (p === 'shift') {
        if (last) return null;
        shift = true;
        continue;
      }
      if (p === 'win' || p === 'meta' || p === 'super') {
        if (last) return null;
        win = true;
        continue;
      }
    }
    if (!last) return null;
    const askedAltGr = ctrl && alt && !win;
    const askedShortcut = (ctrl || alt || win) && !askedAltGr;
    if (raw.length > 1) {
      if (!Object.prototype.hasOwnProperty.call(NAMED, p)) return null;
      keysym = NAMED[p];
      key = p;
      printable = !askedShortcut && !NON_PRINTABLE.has(p);
    } else {
      const c = raw.charCodeAt(0);
      if (c < 0x21 || c > 0x7e) return null;
      keysym = /[A-Za-z0-9]/.test(raw) ? raw : PUNCT[raw];
      if (!keysym) return null;
      key = raw.toLowerCase();
      printable = !askedShortcut;
    }
  }
  if (!keysym) return null;
  const fkey = /^f([1-9]|1[0-2])$/.test(key);
  // 막는 조합: Windows 도우미와 같은 것(Win+L·Ctrl+Alt+Del·멈춤 단축키) + Linux 것 (리드 결정 S10-7.8): super+l·ctrl+alt+l(잠금), ctrl+alt+backspace(X 끝내기),
  // ctrl+alt+F1..F12(가상 터미널 바꾸기 — 멈춤 단축키 Ctrl+Alt+Shift+F12도 든다), ctrl+alt+escape(xkill), ctrl+alt+delete(로그아웃 창)
  const denied =
    (win && key === 'l') ||
    (ctrl && alt && (key === 'delete' || key === 'del' || key === 'l' || key === 'backspace' || key === 'esc' || key === 'escape' || fkey || (shift && key === 'f12')));
  const mods = [];
  if (ctrl) mods.push('ctrl');
  if (alt) mods.push('alt');
  if (shift) mods.push('shift');
  if (win) mods.push('super');
  return { mods, keysym, key, printable, denied, altF4: alt && key === 'f4', xdo: [...mods, keysym].join('+') };
}

/**
 * 잠긴 수정 키 — xset q의 XKB 표시등. 'Caps Lock'은 Lock이 잠김, 'Shift Lock'은 Shift가 잠김(표준 XKB compat의 표시등 — 없으면 잠기지 않은 것으로 본다).
 * Shift_Lock 키는 둘 다 잠그고, 그 뒤 Caps_Lock은 Lock만 푼다 — 'Caps Lock' 표시등만 보면 잠긴 Shift를 놓친다 [Xvfb에서 본 것]. 읽지 못하면 null
 */
async function keyLocks() {
  const r = await runText('xset', ['q'], { timeoutMs: 1500 });
  if (r.code !== 0) return null;
  const caps = /Caps Lock:\s+(on|off)/.exec(r.text);
  if (!caps) return null;
  const shift = /Shift Lock:\s+(on|off)/.exec(r.text);
  return { caps: caps[1] === 'on', shift: !!shift && shift[1] === 'on' };
}

/**
 * 글자·단축키를 보낼 때 Caps Lock(Lock)·Shift Lock(Shift)이 잠겨 있으면 그동안 풀었다가 되돌린다 (SC-3, 리드 결정 S10-13) — 잠긴 채로 치면 대소문자가 뒤집히고
 * ('abc Hello' → 'ABC hELLO'), Shift Lock이면 '1'이 '!'로, ctrl+s가 ctrl+S(다른 이름으로 저장)로 간다 [Xvfb]. Windows의 KEYEVENTF_UNICODE처럼 보낸 그대로 들어가게.
 * 푸는 법 [Xvfb]: 잠긴 Shift는 Shift를 한 번 눌렀다 떼면 풀린다(XKB clearLocks), Lock은 Caps_Lock. Num Lock은 숫자판 키에만 걸린다 — 보내는 글자는 숫자판을 쓰지 않는다
 * (Num Lock을 켠 채 실제 시험이 친다). 되돌리기는 멈춘 뒤에도 보낸다 (사람의 상태를 바꿔 둔 채 두지 않는다). 풀지 못하면 'ERR INTERNAL capslock'
 */
async function withLockOff(token, fn) {
  // 앞 명령의 되돌리기가 아직 돌면 끝난 뒤에 읽는다 (놓기·정지가 되돌리는 동안 다음 명령이 중간 상태를 처음 상태로 읽지 않게). 앞에서 되돌리지 못한 것도 지금 되돌려 본다
  await restoreHeldLocks();
  // 그래도 되돌리지 못했다 — 지금 상태(풀린 채)를 처음 상태로 덮어쓰지 않게 보내지 않는다 (F2-1, 리드 결정 S10-18). 기억은 정지·놓기·끝남이 되돌린다
  if (locksToRestore) return 'ERR INTERNAL capslock';
  const was = await keyLocks();
  if (!was || (!was.caps && !was.shift)) return fn();
  // 푸는 첫 키를 보내기 전에 적어 둔다 — 정지·놓기·끝남이 이 명령보다 먼저 답해도 되돌린다 (FSD-2)
  locksToRestore = was;
  try {
    if (was.shift && !(await inject(token, 'xdotool', ['key', 'shift']))) return null;
    const mid = await keyLocks();
    if (!mid) return 'ERR INTERNAL capslock';
    if (mid.caps && !(await inject(token, 'xdotool', ['key', 'Caps_Lock']))) return null;
    const now = await keyLocks();
    if (!now || now.caps || now.shift) return 'ERR INTERNAL capslock';
    return await fn();
  } finally {
    await restoreHeldLocks();
  }
}

/** withLockOff가 풀어 두고 아직 되돌리지 않은 잠금 (처음 상태) · 도는 되돌리기 */
let locksToRestore = null;
let lockRestoring = null;

/**
 * 풀어 둔 잠금을 처음대로 되돌린다 (FSD-2, 리드 결정 S10-17) — 그 명령이 끝날 때, 그리고 STOP·RELEASE·끝남이 답하기 전에. 한 번만 돈다: 둘이 함께 부르면 둘째는
 * 도는 되돌리기를 기다린다 (Caps_Lock을 두 번 눌러 도로 끄지 않게). STOP OK를 받으면 클라이언트가 이 도우미의 묶음을 SIGKILL로 끝내므로, 그 명령의 finally만
 * 믿으면 사람의 Caps Lock이 꺼진 채 남는다
 */
function restoreHeldLocks() {
  if (lockRestoring) return lockRestoring;
  const was = locksToRestore;
  if (!was) return Promise.resolve();
  lockRestoring = (async () => {
    let applied = false;
    try {
      // 도구가 실패해 화면이 '확인하지 않음'이면 여기서 주인을 다시 본다 — 우리 화면이 아니면 아무것도 누르지 않고 기억을 둔다 (F2-1, 리드 결정 S10-18)
      if (!(await checkDisplay(1000))) applied = await restoreLocks(was);
    } catch {
      applied = false;
    } finally {
      // 되돌렸을 때만 잊는다 — 못 했으면(도구 시간 초과·화면에 붙지 못함·주인 아님) 다음 정지·놓기·끝남·잠금 푸는 명령이 다시 해 본다
      if (applied && locksToRestore === was) locksToRestore = null;
      lockRestoring = null;
    }
  })();
  return lockRestoring;
}

/**
 * 잠금을 처음대로 — 지금 상태와 견주어 다른 것만. 잠긴 Shift는 Shift_Lock 키로(그 키가 Lock에도 걸려 있으면 Lock도 함께 잠근다 [Xvfb]), 남은 Lock 차이는 Caps_Lock으로.
 * 상태를 읽고 필요한 키를 끝까지 보냈으면 true (지금 상태와 견주므로 몇 번 불러도 같은 결과다)
 */
async function restoreLocks(was) {
  let now = await keyLocks();
  if (!now) return false;
  if (was.shift && !now.shift) {
    if (!(await injectUp('xdotool', ['key', 'Shift_Lock']))) return false;
    now = await keyLocks();
    if (!now) return false;
  }
  if (now.caps !== was.caps && !(await injectUp('xdotool', ['key', 'Caps_Lock']))) return false;
  return true;
}

async function doKey(args) {
  const a = args.split(' ');
  if (a.length !== 2) return 'ERR BAD_ARGS';
  const combo = parseCombo(a[0]);
  if (!combo) return 'ERR BAD_ARGS combo';
  const g = await inputGate(a[1]);
  if (g.err) return g.err;
  if (combo.denied) return 'ERR BLOCKED_TARGET key';
  const f = await activeFacts();
  if (f) {
    if (f.blocked) return 'ERR BLOCKED_TARGET window';
    if (f.elevated) return 'ERR ELEVATED_TARGET';
    // 바탕 화면·패널의 Alt+F4는 세션 끝내기 창을 열 수 있다
    if (combo.altF4 && f.shell) return 'ERR BLOCKED_TARGET shell';
  }
  let a11y = null;
  if (combo.printable) {
    if (!f) return 'ERR FOCUS_UNKNOWN';
    a11y = await a11yFocus(f, 1500);
    if (a11y.password === true) return 'ERR PASSWORD_FIELD';
    // 운영자 설정 typeWithoutA11y는 type에만 걸린다 — 가르지 못한 칸의 글자 키는 그대로 막는다 (SC-4, 리드 결정 S10-13)
    if (a11y.password === null) return 'ERR FOCUS_UNKNOWN';
    const again = aborted(g.token, g.human);
    if (again) return again;
  }
  const send = async () => ((await inject(g.token, 'xdotool', ['key', combo.xdo])) ? null : (aborted(g.token, g.human) ?? 'ERR RELEASED'));
  // 잠금은 글자 키만이 아니라 단축키에도 걸린다 — Shift Lock이면 ctrl+s가 ctrl+S(다른 이름으로 저장)가 된다 [Xvfb]. capslock 키 자체는 그대로 보낸다
  const wrap = combo.keysym !== 'Caps_Lock';
  const r = wrap ? await withLockOff(g.token, send) : await send();
  if (r === null && wrap && aborted(g.token, g.human)) return aborted(g.token, g.human);
  if (r) return r;
  return `OK ${focusJson(await activeFacts(), a11y)}`;
}

async function doType(args) {
  const a = args.split(' ');
  if (a.length !== 2) return 'ERR BAD_ARGS';
  let text;
  try {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(a[0]) || a[0].length % 4 !== 0) throw new Error('b64');
    text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(a[0], 'base64'));
  } catch {
    return 'ERR BAD_ARGS text';
  }
  if (!text) return 'ERR BAD_ARGS text';
  // 제어 문자(탭·줄바꿈 등)가 든 글은 치지 않는다 (리드 결정 S6-21 B1)
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(text)) return 'ERR BAD_TEXT';
  const g = await inputGate(a[1]);
  if (g.err) return g.err;
  const f = await activeFacts();
  if (!f) return 'ERR FOCUS_UNKNOWN';
  if (f.blocked) return 'ERR BLOCKED_TARGET window';
  if (f.elevated) return 'ERR ELEVATED_TARGET';
  const first = await a11yFocus(f, 1500);
  if (first.password === true) return 'ERR PASSWORD_FIELD';
  if (first.password === null && !TYPE_UNKNOWN) return 'ERR FOCUS_UNKNOWN';
  const early = aborted(g.token, g.human);
  if (early) return `${early} sent=0`;
  const chars = [...text];
  let sent = 0;
  // 묶음 사이의 남의 입력 (FSD-1) — 사람이 치는 동안 움직이면 다음 묶음 전에 HUMAN_ACTIVE로 멈춘다
  const watch = stepWatch();
  const typed = await withLockOff(g.token, async () => {
  for (let i = 0; i < chars.length; i += TYPE_UNIT) {
    // 화면의 주인을 1초마다 다시 본다 (긴 글)
    const bad = await checkDisplay(1000);
    if (bad) return `ERR NO_DESKTOP ${bad} sent=${sent}`;
    const unit = chars.slice(i, i + TYPE_UNIT);
    if (i > 0) {
      // 앱이 앞 묶음을 처리할 틈 — 그 뒤 최상위 창과 포커스를 다시 읽는다 (Windows 도우미와 같다, 리드 결정 S6-23 K2)
      await sleep(5);
      const root = await rootProps().catch(() => null);
      if (!root || root.active !== f.id) return `ERR FOCUS_UNKNOWN sent=${sent}`;
      const now = await a11yFocus(f, TYPE_RECHECK_MS);
      if (now.password === true || (now.password === null && !TYPE_UNKNOWN)) return `ERR FOCUS_UNKNOWN sent=${sent}`;
      const stop = aborted(g.token, g.human);
      if (stop) return `${stop} sent=${sent}`;
    }
    const chunk = unit.join('');
    await premap(unit);
    await watch.beforeStep();
    const stop = aborted(g.token, g.human);
    if (stop) return `${stop} sent=${sent}`;
    if (!(await inject(g.token, 'xdotool', ['type', '--delay', '12', '--', chunk], 5000))) return `${aborted(g.token, g.human) ?? 'ERR RELEASED'} sent=${sent}`;
    sent += chunk.length;
    // 마지막 묶음 뒤에도 잰다 — 다 친 뒤에 온 사람 입력은 이 명령을 멈추지 않지만 HUMAN을 알린다(내 주입 바로 뒤라 사람 입력 보기가 내 것으로 볼 입력)
    await watch.afterStep();
  }
  return '';
  });
  if (typed === null) return `${aborted(g.token, g.human) ?? 'ERR RELEASED'} sent=${sent}`;
  if (typed === 'ERR INTERNAL capslock') return `${typed} sent=${sent}`;
  if (typed) return typed;
  await sleep(30);
  const last = await a11yFocus(f, 1500);
  // 다 친 바로 뒤의 사람 입력도 알린다 (FSD-1) — 글은 다 갔으니 이 명령은 OK, 다음 명령부터 멈춘다
  await watch.beforeStep();
  return `OK ${focusJson(await activeFacts(), last)}`;
}

async function dispatch(verb, args) {
  switch (verb) {
    case 'SCREENS':
      return doScreens();
    case 'WINDOWS':
      return doWindows();
    case 'FOCUS':
      return doFocus();
    case 'ARM':
      return doArm(args);
    case 'CAPTURE':
      return doCapture(args);
    case 'MOVE':
      return doMove(args);
    case 'CLICK':
      return doClick(args);
    case 'DRAG':
      return doDrag(args);
    case 'SCROLL':
      return doScroll(args);
    case 'KEY':
      return doKey(args);
    case 'TYPE':
      return doType(args);
    default:
      return 'ERR BAD_ARGS verb';
  }
}

// ───────────────────────── 줄 읽기 ─────────────────────────

const queue = [];
let working = false;

async function work() {
  if (working) return;
  working = true;
  try {
    while (queue.length) {
      const { id, rest } = queue.shift();
      const sp = rest.indexOf(' ');
      const verb = sp < 0 ? rest : rest.slice(0, sp);
      const args = sp < 0 ? '' : rest.slice(sp + 1);
      let reply;
      try {
        // 화면의 주인: 무장할 때마다, 그 밖의 명령은 1초가 지났으면 다시 본다 (SC-1). 아니면 도구를 하나도 띄우지 않는다
        const bad = stopped ? null : await checkDisplay(verb === 'ARM' ? 0 : 1000);
        reply = stopped ? 'ERR STOPPED' : bad ? `ERR NO_DESKTOP ${bad}` : await dispatch(verb, args);
      } catch (e) {
        // 사유에는 오류 종류만 (인자·글자를 되풀이하지 않는다)
        reply = `ERR INTERNAL ${e && e.name ? e.name : 'Error'}`;
      }
      line(`${id} ${reply}`);
    }
  } finally {
    working = false;
  }
}

async function doStop() {
  stopped = true;
  beginDisarm('STOPPED');
  const n = await releaseAll();
  // 글자 치기가 잠깐 푼 Caps Lock·Shift Lock을 답하기 전에 되돌린다 — STOP OK를 받은 클라이언트가 이 묶음을 SIGKILL로 끝낸다 (FSD-2)
  await restoreHeldLocks();
  await sidecar.call({ op: 'disarm' }, 500);
  await restoreKeymap().catch(() => undefined);
  line(`STOP OK ${n}`);
}

async function doRelease(id) {
  beginDisarm('RELEASED');
  const n = await releaseAll();
  await restoreHeldLocks();
  await sidecar.call({ op: 'disarm' }, 500);
  await restoreKeymap().catch(() => undefined);
  line(`${id} OK ${n}`);
}

let shuttingDown = false;
async function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  stopped = true;
  beginDisarm('STOPPED');
  const done = (async () => {
    await releaseAll().catch(() => undefined);
    await restoreHeldLocks();
    await restoreKeymap().catch(() => undefined);
  })();
  // 늦어도 2초 안에 끝난다
  await Promise.race([done, sleep(2000)]);
  for (const c of children) {
    try {
      c.kill('SIGKILL');
    } catch {
      // 이미 끝났다
    }
  }
  process.exit(code);
}

process.on('SIGTERM', () => void shutdown(0));
process.on('SIGINT', () => void shutdown(0));
process.on('SIGHUP', () => void shutdown(0));

// ───────────────────────── 시작 ─────────────────────────

/** 그 X 서버가 Xvfb인지 — 그 연결로 읽은 입력 장치 이름(Xvfb keyboard·Xvfb mouse)으로 본다. 다른 X 서버에는 그런 장치가 없다 */
async function isXvfb() {
  const r = await runText('xinput', ['list', '--name-only'], { timeoutMs: 2500 });
  if (r.code !== 0) return false;
  const names = r.text.split('\n').map((s) => s.trim());
  return names.includes('Xvfb keyboard') && names.includes('Xvfb mouse');
}

/** 그 화면에 붙어 본다: 안 되면 nodisplay, Xwayland면 wayland, 아니면 null */
async function displayProblem() {
  if (!env.DISPLAY) return 'nodisplay';
  const r = await runText('xdpyinfo', ['-queryExtensions'], { timeoutMs: 4000 });
  if (r.code !== 0) return 'nodisplay';
  if (/XWAYLAND/i.test(r.text)) return 'wayland';
  const mons = await monitors().catch(() => null);
  if (mons && mons.some((m) => /^XWAYLAND/i.test(m.name))) return 'wayland';
  return null;
}

async function probe() {
  const reply = { __wookDesktop: 'probe', ok: true, version: PROTOCOL, session: 'x11', interactive: true, lock: null, monitors: null, build: 0, wda: true, elevated: OWN_UID === 0, virtual: false };
  if (!tools) return { code: 3, text: JSON.stringify({ ...reply, ok: false, error: 'tools' }) };
  // 화면의 주인을 먼저 본다 — 그 전에는 X 도구를 띄우지 않는다 (SC-1)
  const bad = await checkDisplay(0);
  if (bad) return { code: 0, text: JSON.stringify({ ...reply, lock: 'no_desktop', detail: bad }) };
  const problem = await displayProblem();
  if (problem) return { code: 0, text: JSON.stringify({ ...reply, lock: 'no_desktop', detail: problem }) };
  const mons = await monitors().catch(() => null);
  reply.monitors = mons ? mons.length : null;
  reply.virtual = await isXvfb();
  return { code: 0, text: JSON.stringify(reply) };
}

async function main() {
  if (process.argv[2] === '--probe') {
    const r = await probe();
    failExit(r.text, r.code);
    return;
  }
  if (process.argv.length > 2) {
    process.stderr.write('usage: x11Helper.mjs [--probe]\n');
    process.exit(2);
  }
  if (!tools) {
    failExit('FAIL INIT tools');
    return;
  }
  // 화면의 주인을 먼저 본다 (SC-1): 추상 이름과 소켓 파일을 이 사용자의 같은 X 서버가 쥐고 있어야 한다. 그 전에는 X 도구를 하나도 띄우지 않는다 — 쿠키를 보내지 않는다
  const bad = await checkDisplay(0);
  if (bad) {
    failExit(`FAIL NO_DESKTOP ${bad}`);
    return;
  }
  const problem = await displayProblem();
  if (problem) {
    failExit(`FAIL NO_DESKTOP ${problem}`);
    return;
  }
  // 시험 문의 Xvfb 확인이 곁 도우미보다 먼저다 (SC-11) — 곁 도우미는 붙자마자 멈춤 단축키를 잡는다
  const xvfb = await isXvfb();
  if (env.WOOK_X11_REQUIRE_XVFB === '1' && !xvfb) {
    failExit('FAIL NO_DESKTOP notxvfb');
    return;
  }
  // 곁 도우미는 여기서 띄운다 (python이 뜨는 동안 나머지 검사를 한다). 시작에 실패하면 아래에서 끝내며 함께 끝낸다
  const sidecarStarted = startSidecar();
  virtualDisplay = xvfb && env.WOOK_X11_FORCE_REAL !== '1';
  screensDir = env.WOOK_DESKTOP_SCREENS || '';
  if (!screensDir || !existsSync(screensDir)) {
    failExit('FAIL INIT screens_dir');
    return;
  }
  const p = parsePolicy(env.WOOK_DESKTOP_POLICY || '');
  if (!p) {
    failExit('FAIL INIT policy');
    return;
  }
  policy = p;
  // 창 목록이 없으면 막는 창·높은 권한 창을 가를 수 없다 — EWMH 창 관리자(openbox 등)가 있어야 한다 (막는 쪽)
  const root = await rootProps().catch(() => null);
  if (!root || !root.wm) {
    failExit('FAIL INIT wm');
    return;
  }
  const mons = await monitors().catch(() => null);
  if (!mons) {
    failExit('FAIL INIT screens');
    return;
  }
  ancestors = ancestorPids();
  await loadKeymap();
  await sidecarStarted;
  const lk = await lockState();
  // 곁 도우미가 없으면 그 까닭도 (FSD-5 — 서버의 거부 글이 그 까닭을 말한다)
  const sidecarWhy = sidecar.ok ? '' : ` sidecarwhy=${sidecar.why ?? 'none'}`;
  line(
    `READY ${PROTOCOL} ${mons.length} locked=${lk ? 1 : 0} wda=1 build=0 virtual=${virtualDisplay ? 1 : 0} sidecar=${sidecar.ok ? 1 : 0} a11y=${sidecar.ok && sidecar.atspi ? 1 : 0}${sidecarWhy}`,
  );
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (l) => {
    if (l.length === 0 || l.length > 65536) return;
    if (l === 'STOP') {
      void doStop();
      return;
    }
    const sp = l.indexOf(' ');
    if (sp <= 0) return;
    const id = l.slice(0, sp);
    if (!/^\d{1,9}$/.test(id)) return;
    const rest = l.slice(sp + 1);
    if (rest === 'RELEASE') {
      void doRelease(id);
      return;
    }
    if (stopped) {
      line(`${id} ERR STOPPED`);
      return;
    }
    queue.push({ id, rest });
    void work();
  });
  // 표준 입력이 닫혔다 (서버가 끝남·죽음) — 키를 떼고 끝난다
  rl.on('close', () => void shutdown(0));
}

// 읽은 줄로 기록을 남기지 않는다 — 도우미의 오류 출력에도 인자·글자를 쓰지 않는다
process.on('uncaughtException', (e) => {
  try {
    process.stderr.write(`화면 도우미 내부 오류: ${e && e.name ? e.name : 'Error'}\n`);
  } catch {
    // 쓸 곳이 없다
  }
  void shutdown(70);
});

void main();
