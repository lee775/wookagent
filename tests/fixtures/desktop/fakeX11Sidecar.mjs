// 가짜 X11 곁 도우미 (S10c) — x11Sidecar.py와 같은 JSON 줄을 말한다. 장면(WOOK_FAKE_X11)의 sidecar 칸이 답을 정하고, 받은 요청은 WOOK_FAKE_X11_LOG에 남긴다
// ({tool: 'sidecar', args: [op]}). sidecar 칸: { xlib, grab, atspi, password (true|false|null), control, indicator (기본 true) }. 요청마다 장면을 다시 읽는다.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const scenePath = process.env.WOOK_FAKE_X11;
const logPath = process.env.WOOK_FAKE_X11_LOG;
const side = () => JSON.parse(readFileSync(scenePath, 'utf8')).sidecar ?? {};
const log = (op, extra) => {
  if (logPath) appendFileSync(logPath, `${JSON.stringify({ t: Date.now(), tool: 'sidecar', args: [op], ...(extra ?? {}) })}\n`);
};
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const s0 = side();
log('hello');
// S10c2 (FSD-5): exitBeforeHello — 답하기 전에 프로세스가 끝남(세션 버스 없이 AT-SPI가 프로세스를 끝낸 것 흉내) · exitAfterHelloMs — 답한 뒤 끝남 ·
// xlib false + xlibWhy('import' | 'connect') — python3-xlib가 없음 / 화면에 붙지 못함
if (s0.exitBeforeHello) process.exit(9);
out({ ev: 'hello', xlib: s0.xlib !== false, xlibWhy: s0.xlib === false ? (s0.xlibWhy ?? 'connect') : null, grab: s0.grab !== false, atspi: s0.atspi === true });
if (s0.exitAfterHelloMs !== undefined) setTimeout(() => process.exit(9), s0.exitAfterHelloMs);
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (l) => {
  let req;
  try {
    req = JSON.parse(l);
  } catch {
    return;
  }
  const s = side();
  log(req.op, req.op === 'focus' ? { pid: req.pid } : undefined);
  switch (req.op) {
    case 'arm':
      out({ id: req.id, ok: true, grab: s.grab !== false, indicator: !!req.indicator && s.indicator !== false });
      if (s.hotkeyAfterArmMs !== undefined) setTimeout(() => out({ ev: 'hotkey', at: Date.now() }), s.hotkeyAfterArmMs);
      break;
    case 'focus':
      out({ id: req.id, ok: true, control: s.control ?? null, password: s.password === undefined ? null : s.password });
      break;
    case 'lock':
      out({ id: req.id, ok: true, locked: s.locked === true });
      break;
    default:
      out({ id: req.id, ok: true });
  }
});
rl.on('close', () => {
  log('eof');
  // ignoreEof: 표준 입력이 닫혀도 끝나지 않는 곁 도우미 흉내 — 도우미의 프로세스 묶음 SIGKILL만 끝낸다 (S10-7.9 시험)
  if (side().ignoreEof) return;
  process.exit(0);
});
// 시험의 정리: 장면 폴더가 지워지면 스스로 끝난다 (PID로 죽이지 않는다)
if (s0.ignoreEof) setInterval(() => {
  if (!existsSync(scenePath)) process.exit(0);
}, 100);
