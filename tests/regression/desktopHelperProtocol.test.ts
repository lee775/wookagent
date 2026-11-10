/**
 * desktopHelperProtocol (SERVER_DESIGN 10.6, 리드 결정 S6-5·S6-13): 화면 도우미 클라이언트(src/main/desktop/desktopHelper.ts)를 가짜 도우미
 * (tests/fixtures/desktop/fakeDesktopHelper.mjs)로 시험한다 — READY·FAIL·ERR, 버전, 시간 상한, 다시 띄우기 상한(세는 것과 세지 않는 것),
 * 줄 상한, 늦은 번호, 로그에 인자 없음, STOP·RELEASE 순서, 사람 입력·단축키 알림, 서버와 함께 끝남. 실제 도우미는 띄우지 않는다 (S6-15).
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DESKTOP_TIMEOUTS,
  HELPER_IDLE_MS,
  INPUT_UNCONFIRMED_TEXT,
  MAX_HELPER_FAILURES,
  MAX_HELPER_LINE,
  NO_DESKTOP_CACHE_MS,
  NO_DESKTOP_TEXT,
  RELEASE_UNANSWERED_STOP,
  STOP_UNCONFIRMED_EXIT,
  STOP_UNCONFIRMED_KEYS,
  createDesktopHelper,
  decodePolicy,
} from '../../src/main/desktop/desktopHelper';
import type { DesktopHelperClient, DesktopHelperEvent, HelperCapture, HelperLease } from '../../src/main/desktop/types';
import { STOP_CONFIRM_MS } from '../../src/main/orchestrator/turns';
import { FAKE_DESKTOP_HELPER, createFakeDesktop, killFakePids, pidAlive, type FakeDesktop } from '../fixtures/desktop/fakeDesktop';

const fakes: FakeDesktop[] = [];
const clients: DesktopHelperClient[] = [];
const strays: number[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) await c.dispose().catch(() => undefined);
  for (const f of fakes) strays.push(...f.pids());
  killFakePids(strays.splice(0));
  for (const f of fakes.splice(0)) await f.cleanup();
});

function fake(scenario: Parameters<typeof createFakeDesktop>[0] = {}): FakeDesktop {
  const f = createFakeDesktop(scenario);
  fakes.push(f);
  return f;
}

function client(f: FakeDesktop, o: Parameters<FakeDesktop['client']>[0] = {}): DesktopHelperClient {
  const c = f.client(o);
  clients.push(c);
  return c;
}

async function waitFor(cond: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`기다리다 시간 초과: ${label}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

function events(c: DesktopHelperClient): DesktopHelperEvent[] {
  const list: DesktopHelperEvent[] = [];
  c.onEvent((e) => list.push(e));
  return list;
}

async function leaseOf(c: DesktopHelperClient): Promise<HelperLease> {
  const l = await c.acquire();
  if ('kind' in l) throw new Error(`슬롯을 얻지 못함: ${l.text}`);
  return l;
}

let capSeq = 100;

async function armAndCapture(c: DesktopHelperClient): Promise<{ lease: HelperLease; cap: HelperCapture }> {
  const lease = await leaseOf(c);
  const arm = await lease.send({ verb: 'ARM', policy: { pids: [], titles: [], titlePrefixes: [] } });
  expect(arm.ok).toBe(true);
  const cap = await lease.send({ verb: 'CAPTURE', screen: 1, maxEdge: 640, id: `SC-${String(++capSeq).padStart(6, '0')}` });
  if (!cap.ok) throw new Error(`캡처 실패: ${JSON.stringify(cap)}`);
  return { lease, cap: cap.value };
}

describe('desktopHelperProtocol — 가짜 도우미', () => {
  it('정해진 값: 시간 상한 표·다시 띄우기 상한 3·화면 세션 없음 60초·쉼 10분·줄 1MiB (리드 결정 S6-5)', () => {
    expect(DESKTOP_TIMEOUTS).toEqual({
      READY: 10_000,
      SCREENS: 3000,
      WINDOWS: 3000,
      FOCUS: 2000,
      CAPTURE: 5000,
      MOVE: 2000,
      CLICK: 2000,
      SCROLL: 2000,
      KEY: 3500,
      DRAG: 5000,
      TYPE: 5000, // S6F2b: 리드 결정 S6-23 K2 — 4자마다 포커스를 다시 읽는다
      TYPE_PER_CHAR: 80, // S6F2b
      ARM: 1000,
      RELEASE: 1000,
      STOP_ACK: 800,
      STOP_CONFIRM: 2800,
    });
    expect(DESKTOP_TIMEOUTS.STOP_CONFIRM).toBe(STOP_CONFIRM_MS);
    expect([MAX_HELPER_FAILURES, NO_DESKTOP_CACHE_MS, HELPER_IDLE_MS, MAX_HELPER_LINE]).toEqual([3, 60_000, 600_000, 1024 * 1024]);
  });

  it('READY를 읽고, 요청은 (도우미, 번호)로 답을 맞춘다 — 화면 폴더·처음 정책은 환경 변수로 간다', async () => {
    const f = fake({ build: 22631, wda: false, screens: [{ x: -1920, y: 0, width: 1920, height: 1080 }, { x: 0, y: 0, width: 2560, height: 1440, dpi: 144, primary: true }] });
    const c = client(f, { policy: () => ({ pids: [4321], titles: ['욱채 서버 (pid 4321)'], titlePrefixes: ['욱채'] }) });
    const r = await c.ready();
    if (!r.ok) throw new Error(r.text);
    expect(r.info).toMatchObject({ version: 3, screens: 2, locked: false, wda: false, build: 22631 });
    expect(c.state()).toBe('ready');
    const screens = await c.request({ verb: 'SCREENS' });
    if (!screens.ok) throw new Error(JSON.stringify(screens));
    expect(screens.value.screens.map((s) => [s.index, s.primary, s.x, s.width, s.dpi])).toEqual([
      [1, true, 0, 2560, 144],
      [2, false, -1920, 1920, 96],
    ]);
    const windows = await c.request({ verb: 'WINDOWS' });
    expect(windows).toMatchObject({ ok: true, value: { total: 1 } });
    expect(f.received()).toEqual(['1 SCREENS', '2 WINDOWS']);
    // 처음 정책: 가짜 도우미가 받은 WOOK_DESKTOP_POLICY — 그 제목의 창을 막는다
    const blocked = createFakeDesktop({ windows: [{ title: '욱채 서버 (pid 4321)', app: 'node', pid: 4321, x: 0, y: 0, width: 10, height: 10, minimized: false, blocked: false, elevated: false }] });
    fakes.push(blocked);
    const c2 = client(blocked, { policy: () => ({ pids: [], titles: ['욱채 서버 (pid 4321)'], titlePrefixes: [] }) });
    const w2 = await c2.request({ verb: 'WINDOWS' });
    expect(w2).toMatchObject({ ok: true, value: { windows: [{ blocked: true }] } });
  });

  it('FAIL NO_DESKTOP: 세지 않고 60초 동안 띄우지 않는다 — 그 뒤 다시 본다', async () => {
    let now = 1_000_000;
    const f = fake({ start: 'no_desktop' });
    const c = client(f, { now: () => now });
    for (let round = 0; round < MAX_HELPER_FAILURES + 1; round++) {
      const r = await c.ready();
      expect(r).toEqual({ ok: false, kind: 'unavailable', code: 'no_desktop', text: NO_DESKTOP_TEXT });
      // 60초 안에는 띄우지 않는다
      expect(await c.ready()).toMatchObject({ code: 'no_desktop' });
      expect(f.launches()).toBe(round + 1);
      expect(c.problem()).toMatchObject({ code: 'no_desktop', permanent: false });
      now += NO_DESKTOP_CACHE_MS;
    }
    // 세지 않았다 — 화면 세션이 생기면 그대로 띄운다
    f.set({ start: 'ready' });
    expect(await c.ready()).toMatchObject({ ok: true });
    expect(c.problem()).toBeNull();
  });

  it('시작 실패는 센다 (FAIL INIT·다른 버전·준비 전 끝남) — 3번이면 다시 시작할 때까지 띄우지 않는다', async () => {
    const f = fake({ start: 'init_fail' });
    const ev = events(client(f));
    const c = clients[clients.length - 1]!;
    expect(await c.ready()).toMatchObject({ ok: false, code: 'helper_failed', text: expect.stringContaining('화면 도우미를 준비하지 못했습니다 (INIT') });
    f.set({ start: 'bad_version' });
    expect(await c.ready()).toMatchObject({ ok: false, code: 'helper_failed', text: expect.stringContaining('프로토콜 버전이 맞지 않습니다 (2 ≠ 3)') });
    expect(c.problem()?.permanent).toBe(false);
    f.set({ start: 'crash' });
    const third = await c.ready();
    expect(third).toMatchObject({ ok: false, code: 'helper_failed', text: expect.stringContaining('준비 전에 끝났습니다 (종료 코드 9') });
    expect(third.ok ? '' : third.text).toContain('3번 실패해 더 띄우지 않습니다');
    expect(c.problem()).toMatchObject({ code: 'helper_failed', permanent: true });
    // 상한 뒤에는 띄우지 않는다 (가짜가 이제 멀쩡해도)
    f.set({ start: 'ready' });
    expect(await c.acquire()).toMatchObject({ ok: false, code: 'helper_failed' });
    expect(f.launches()).toBe(3);
    expect(ev.filter((e) => e.type === 'problem').at(-1)).toMatchObject({ problem: { permanent: true } });
  });

  it('READY가 상한 안에 오지 않으면 끝내고 센다', async () => {
    const f = fake({ start: 'hang' });
    const c = client(f, { timeouts: { READY: 300 } });
    const t0 = Date.now();
    expect(await c.ready()).toMatchObject({ ok: false, code: 'helper_failed', text: '화면 도우미가 0.3초 안에 준비되지 않았습니다' });
    expect(Date.now() - t0).toBeLessThan(3000);
    await waitFor(() => f.pids().length === 1 && !pidAlive(f.pids()[0]!), '준비되지 않은 도우미가 끝남');
  });

  it('다시 띄우기 상한은 센 수만 본다 — 시작 실패로 센 도우미가 늦게 READY를 보내도 풀리지 않는다 (S6-21 H1)', async () => {
    // 지키는 것: 이미 센 도우미의 늦은 READY가 문제 기록을 지워 상한이 풀리고, 그때마다 도우미를 하나씩 더 띄우는 것
    const f = fake({ readyDelayMs: 450 });
    // 끝내기가 조금 늦게 듣는 도우미 (READY가 끝내기 직전에 이미 파이프에 들어간 경우)
    const c = client(f, { timeouts: { READY: 120 }, kill: (proc) => void setTimeout(() => proc.kill(), 900) });
    const ev = events(c);
    for (let i = 0; i < MAX_HELPER_FAILURES; i++) expect(await c.ready()).toMatchObject({ ok: false, code: 'helper_failed' });
    expect(c.problem()).toMatchObject({ code: 'helper_failed', permanent: true });
    expect(f.launches()).toBe(MAX_HELPER_FAILURES);
    // 센 도우미들이 늦은 READY를 보내고, 그 뒤에 끝난다
    await waitFor(() => f.log().filter((e) => e.dir === 'out' && e.line.startsWith('READY ')).length === MAX_HELPER_FAILURES, '늦은 READY');
    await waitFor(() => f.pids().every((pid) => !pidAlive(pid)), '센 도우미들이 끝남');
    expect(c.problem()).toMatchObject({ code: 'helper_failed', permanent: true, text: expect.stringContaining('3번 실패해 더 띄우지 않습니다') });
    expect(await c.ready()).toMatchObject({ ok: false, code: 'helper_failed', text: expect.stringContaining('3번 실패해 더 띄우지 않습니다') });
    expect(await c.acquire()).toMatchObject({ ok: false, code: 'helper_failed' });
    expect(f.launches()).toBe(MAX_HELPER_FAILURES);
    // 늦은 READY는 준비 알림도 내지 않는다
    expect(ev.filter((e) => e.type === 'ready')).toEqual([]);
  });

  it('ERR 답: 사유·잠김 종류·보낸 양을 읽고, 모르는 사유는 INTERNAL로 받는다', async () => {
    const f = fake({ errors: { CLICK: 'LOCKED disconnected', TYPE: 'HUMAN_ACTIVE sent=12', KEY: 'WEIRD 무언가' }, errorQueue: [{ verb: 'SCROLL', err: 'PASSWORD_FIELD' }] });
    const c = client(f, { redact: (t) => t });
    const { lease, cap } = await armAndCapture(c);
    expect(await lease.send({ verb: 'CLICK', x: 10, y: 10, button: 'left', count: 1, layout: cap.layout })).toEqual({
      ok: false,
      kind: 'err',
      reason: 'LOCKED',
      detail: 'disconnected',
      sent: null,
      lock: 'disconnected',
    });
    expect(await lease.send({ verb: 'TYPE', text: '안녕', layout: cap.layout })).toMatchObject({ reason: 'HUMAN_ACTIVE', sent: 12, detail: null });
    expect(await lease.send({ verb: 'KEY', combo: 'enter', layout: cap.layout })).toMatchObject({ reason: 'INTERNAL', detail: 'WEIRD 무언가' });
    expect(await lease.send({ verb: 'SCROLL', x: 5, y: 5, amount: 3, layout: cap.layout })).toMatchObject({ reason: 'PASSWORD_FIELD' });
    // 한 번 쓴 ERR은 다시 오지 않는다
    expect(await lease.send({ verb: 'SCROLL', x: 5, y: 5, amount: -3, layout: cap.layout })).toMatchObject({ ok: true });
    lease.end();
    // 가리개가 없으면 도우미의 자유 글(경로·비밀이 들 수 있다)은 남기지 않고, 도우미가 정한 짧은 낱말만 남긴다
    const f2 = fake({ errors: { CLICK: 'INTERNAL C:\\Users\\대표\\비밀 sk-ant-api03-ABCDEFGHIJKLMNOP', KEY: 'BLOCKED_TARGET shell', TYPE: 'FOCUS_UNKNOWN 무언가 sent=3' } });
    const bare = client(f2);
    const { lease: l2, cap: c2 } = await armAndCapture(bare);
    expect(await l2.send({ verb: 'CLICK', x: 1, y: 1, button: 'left', count: 1, layout: c2.layout })).toMatchObject({ reason: 'INTERNAL', detail: null });
    expect(await l2.send({ verb: 'KEY', combo: 'alt+f4', layout: c2.layout })).toMatchObject({ reason: 'BLOCKED_TARGET', detail: 'shell' });
    expect(await l2.send({ verb: 'TYPE', text: 'x', layout: c2.layout })).toMatchObject({ reason: 'FOCUS_UNKNOWN', detail: null, sent: 3 });
    l2.end();
  });

  it('잘못된 인자는 쓰지 않는다 (BAD_ARGS) — 경로가 될 캡처 ID·줄바꿈 든 조합', async () => {
    const f = fake();
    const c = client(f);
    expect(await c.request({ verb: 'CAPTURE', screen: 1, maxEdge: 640, id: '..\\..\\x' })).toMatchObject({ ok: false, kind: 'err', reason: 'BAD_ARGS', detail: 'id' });
    expect(await c.request({ verb: 'KEY', combo: 'ctrl+s\n1 STOP', layout: '0123456789abcdef' })).toMatchObject({ reason: 'BAD_ARGS', detail: 'combo' });
    expect(await c.request({ verb: 'CLICK', x: 1.5, y: 2, button: 'left', count: 1, layout: '0123456789abcdef' })).toMatchObject({ reason: 'BAD_ARGS' });
    expect(f.received()).toEqual([]);
  });

  it('입력이 아닌 명령의 시간 초과도 그 도우미를 STOP하고 끝낸다 (센다) — 정지의 결과를 알림으로 내고, 다음 요청은 앞 도우미가 끝난 뒤 새 도우미로 한다 (S6-21 A3)', async () => {
    // 지키는 것: 캡처·창·포커스에서 멈춘 도우미를 남겨 두고 다음 명령을 보내거나, 그 정지의 결과(뗐는지·끝났는지)를 버리는 것
    const f = fake({ hang: ['CAPTURE'] });
    const c = client(f, { timeouts: { CAPTURE: 200 } });
    const ev = events(c);
    expect(await c.ready()).toMatchObject({ ok: true });
    const pid = c.pid!;
    const cap = await c.request({ verb: 'CAPTURE', screen: 1, maxEdge: 320, id: 'SC-000002' });
    expect(cap).toEqual({ ok: false, kind: 'timeout', input: false, text: '화면 도우미가 0.2초 안에 답하지 않아 끝냅니다 — 다시 하면 새 화면 도우미로 합니다' });
    // 정지가 도는 동안 그 도우미는 쥐고 있다 — 떠 있는 도우미(pid)는 없지만 프로세스는 있다
    expect([c.pid, c.hasProcess(), c.stopping() !== null]).toEqual([null, true, true]);
    // 다음 요청은 그 정지를 기다린 뒤 새 도우미로 간다 — 두 도우미가 겹치지 않는다
    f.set({ hang: [] });
    const screens = await c.request({ verb: 'SCREENS' });
    expect(screens).toMatchObject({ ok: true, value: { screens: [{ index: 1 }] } });
    expect(pidAlive(pid)).toBe(false);
    expect(c.pid).not.toBe(pid);
    expect(f.launches()).toBe(2);
    const mine = f.log().filter((e) => e.pid === pid && e.dir === 'in').map((e) => e.line.replace(/^\d+ /, '').split(' ')[0]);
    expect(mine).toEqual(['CAPTURE', 'STOP']);
    // 앞 도우미의 끝남이 새 도우미의 시작보다 먼저다
    const stopped = ev.filter((e) => e.type === 'stopped');
    expect(stopped).toEqual([{ type: 'stopped', own: 'timeout', reason: '화면 도우미가 CAPTURE 명령에 답하지 않아 끝냈습니다', result: expect.objectContaining({ ok: true, exited: true, hadProcess: true }) }]);
    expect(ev.findIndex((e) => e.type === 'stopped')).toBeLessThan(ev.findLastIndex((e) => e.type === 'ready'));
    // 무장한 적이 없는 도우미다 — 뗄 키가 없어 끝남만 확인하면 성공이다. 시간 초과는 다시 띄우기 상한에 센다
    expect(ev.filter((e) => e.type === 'exit')).toEqual([expect.objectContaining({ counted: true })]);
    expect(ev.filter((e) => e.type === 'problem').map((e) => (e.type === 'problem' ? e.problem.text : ''))).toEqual(['화면 도우미가 CAPTURE 명령에 답하지 않아 끝냈습니다']);
  });

  it('늦게 온 답은 버린다 — 그 번호를 기다리는 요청이 없으면 다음 요청과 섞이지 않는다', async () => {
    const f = fake();
    const logs: string[] = [];
    const c = client(f, { log: (_l, m) => logs.push(m) });
    expect(await c.ready()).toMatchObject({ ok: true });
    expect(await c.request({ verb: 'SCREENS' })).toMatchObject({ ok: true });
    // 이미 답한 번호(1)의 답이 한 번 더 온다
    f.act({ do: 'line', value: '1 OK {"layout":"0000000000000000","screens":[]}' });
    await waitFor(() => logs.some((m) => m.includes('늦은 답을 버렸습니다 (명령 번호 1)')), '늦은 답 버림');
    expect(await c.request({ verb: 'SCREENS' })).toMatchObject({ ok: true, value: { screens: [{ index: 1 }] } });
    expect(f.launches()).toBe(1);
  });

  it("입력 명령의 시간 초과: STOP을 먼저 쓰고 끝내고 센다 — '보냈는지 확인하지 못했습니다'", async () => {
    const f = fake({ hang: ['CLICK'] });
    const c = client(f, { timeouts: { CLICK: 200 } });
    const ev = events(c);
    for (let round = 1; round <= MAX_HELPER_FAILURES; round++) {
      const { lease, cap } = await armAndCapture(c);
      const pid = c.pid!;
      const r = await lease.send({ verb: 'CLICK', x: 10, y: 10, button: 'left', count: 1, layout: cap.layout });
      lease.end();
      expect(r).toEqual({ ok: false, kind: 'timeout', input: true, text: INPUT_UNCONFIRMED_TEXT });
      await waitFor(() => !pidAlive(pid), '시간 초과한 도우미가 끝남');
      const mine = f.log().filter((e) => e.pid === pid && e.dir === 'in').map((e) => e.line.replace(/^\d+ /, '').split(' ')[0]);
      expect(mine.slice(-2)).toEqual(['CLICK', 'STOP']);
      if (round < MAX_HELPER_FAILURES) expect(c.problem()).toMatchObject({ permanent: false });
    }
    expect(c.problem()).toMatchObject({ code: 'helper_failed', permanent: true, text: expect.stringContaining('입력 명령(CLICK)에 답하지 않아 끝냈습니다') });
    expect(ev.filter((e) => e.type === 'exit').every((e) => e.type === 'exit' && e.counted)).toBe(true);
  });

  it('뜻밖의 종료는 센다 — 기다리던 요청은 gone, 다음 요청은 새 도우미', async () => {
    const f = fake({ crashOn: 'WINDOWS' });
    const c = client(f, { redact: (t) => t });
    const ev = events(c);
    expect(await c.request({ verb: 'WINDOWS' })).toEqual({ ok: false, kind: 'gone', text: '화면 도우미가 답하기 전에 끝났습니다' });
    await waitFor(() => ev.some((e) => e.type === 'exit'), '끝남 알림');
    expect(ev.find((e) => e.type === 'exit')).toMatchObject({ expected: false, counted: true, detail: expect.stringContaining('종료 코드 1') });
    expect(c.problem()).toMatchObject({ code: 'helper_failed', permanent: false, text: expect.stringContaining('뜻밖에 끝났습니다') });
    f.set({ crashOn: undefined });
    expect(await c.request({ verb: 'WINDOWS' })).toMatchObject({ ok: true });
    expect(f.launches()).toBe(2);
    expect(c.problem()).toBeNull();
  });

  it('우리가 끝낸 것은 세지 않는다 — STOP 네 번, 쉼(10분) 끝내기, dispose 뒤에는 띄우지 않는다', async () => {
    const f = fake();
    const c = client(f, { idleMs: 250 });
    const ev = events(c);
    const pids = new Set<number>();
    for (let i = 0; i < MAX_HELPER_FAILURES + 1; i++) {
      expect(await c.ready()).toMatchObject({ ok: true });
      pids.add(c.pid!);
      expect(await c.stop('긴급 정지')).toMatchObject({ ok: true, acked: true, hadProcess: true });
    }
    expect(pids.size).toBe(MAX_HELPER_FAILURES + 1);
    expect(c.problem()).toBeNull();
    // 쉼: 무장하지 않은 채 쓰지 않으면 끝낸다 (세지 않음)
    expect(await c.ready()).toMatchObject({ ok: true });
    const idlePid = c.pid!;
    await waitFor(() => !pidAlive(idlePid), '쉬는 도우미 끝남');
    expect(ev.filter((e) => e.type === 'exit').every((e) => e.type === 'exit' && e.expected && !e.counted)).toBe(true);
    expect(c.problem()).toBeNull();
    // 무장한 동안에는 쉼으로 끝내지 않는다
    const { lease } = await armAndCapture(c);
    lease.end();
    const armedPid = c.pid!;
    await new Promise((r) => setTimeout(r, 500));
    expect(pidAlive(armedPid)).toBe(true);
    expect(c.armed()).toBe(true);
    await c.dispose();
    expect(await c.ready()).toMatchObject({ ok: false, code: 'helper_failed', text: '서버가 끝나는 중이라 화면 도우미를 띄우지 않습니다' });
  });

  it('1MiB보다 긴 줄을 보내면 끝내고 센다', async () => {
    const f = fake({ longLineAfterReady: MAX_HELPER_LINE + 10 });
    const logs: string[] = [];
    const c = client(f, { log: (_l, m) => logs.push(m) });
    const ev = events(c);
    await c.ready();
    await waitFor(() => ev.some((e) => e.type === 'exit'), '긴 줄 뒤 끝남');
    expect(ev.find((e) => e.type === 'exit')).toMatchObject({ counted: true });
    expect(c.problem()).toMatchObject({ code: 'helper_failed', text: expect.stringContaining('1MiB보다 긴 줄') });
    expect(logs.some((m) => m.includes('xxxxxxxx'))).toBe(false);
  });

  it('모르는 번호의 답·알 수 없는 줄은 버린다 (내용은 로그에 남기지 않는다)', async () => {
    const f = fake();
    const logs: string[] = [];
    const c = client(f, { log: (_l, m) => logs.push(m) });
    await c.ready();
    f.act({ do: 'line', value: '77 OK 비밀이-섞인-늦은-답' });
    f.act({ do: 'line', value: '아무 말 sk-ant-api03-SECRETSECRET' });
    await waitFor(() => logs.some((m) => m.includes('알 수 없는 줄')), '알 수 없는 줄');
    expect(logs.some((m) => m.includes('늦은 답을 버렸습니다 (명령 번호 77)'))).toBe(true);
    expect(logs.join('\n')).not.toMatch(/비밀이|SECRET/);
    expect(await c.request({ verb: 'SCREENS' })).toMatchObject({ ok: true });
  });

  it('로그에는 명령 이름과 길이만 — TYPE 글자·그 base64·오류 출력의 비밀은 남지 않는다 (AC-20)', async () => {
    const secret = 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWX';
    const text = `비밀번호는 ${secret}`;
    const b64 = Buffer.from(text, 'utf8').toString('base64');
    const f = fake({ hang: ['TYPE'], startStderr: `오류 ${secret}` });
    const logs: string[] = [];
    const redact = (t: string): string => t.split(secret).join('[가림:api-key]');
    const c = client(f, { timeouts: { TYPE: 150, TYPE_PER_CHAR: 0 }, log: (_l, m, extra) => logs.push(`${m} ${extra === undefined ? '' : JSON.stringify(extra)}`), redact });
    const ev = events(c);
    const { lease, cap } = await armAndCapture(c);
    const r = await lease.send({ verb: 'TYPE', text, layout: cap.layout });
    lease.end();
    expect(r).toMatchObject({ kind: 'timeout', input: true });
    await waitFor(() => ev.some((e) => e.type === 'exit'), '끝남');
    expect(logs.some((m) => /TYPE 명령\(\d+자\)에 150ms 안에 답하지 않았습니다/.test(m))).toBe(true);
    // 끝남의 사유에는 가린 오류 출력 첫 줄만
    const problems = ev.filter((e) => e.type === 'problem').map((e) => (e.type === 'problem' ? e.problem.text : ''));
    const exits = ev.filter((e) => e.type === 'exit').map((e) => (e.type === 'exit' ? e.detail : ''));
    const all = [...logs, ...problems, ...exits].join('\n');
    expect(all).not.toContain(secret);
    expect(all).not.toContain(b64);
    expect(all).not.toContain('비밀번호는');
    // 뜻밖의 종료: 사유에는 가린 오류 출력 첫 줄만
    const f2 = fake({ crashOn: 'SCREENS', startStderr: `오류 ${secret}\n둘째 줄 ${secret}` });
    const c2 = client(f2, { redact });
    await c2.request({ verb: 'SCREENS' });
    await waitFor(() => c2.problem() !== null, '끝남 2');
    expect(c2.problem()?.text).toContain('종료 코드 1, 오류 [가림:api-key]');
    expect(c2.problem()?.text).not.toContain(secret);
    expect(c2.problem()?.text).not.toContain('둘째 줄');
    // 가리개가 없으면 오류 출력은 사유에 넣지 않는다
    const f3 = fake({ crashOn: 'SCREENS', startStderr: `오류 ${secret}` });
    const c3 = client(f3);
    const ev3 = events(c3);
    await c3.request({ verb: 'SCREENS' });
    await waitFor(() => ev3.some((e) => e.type === 'exit'), '끝남 3');
    expect(JSON.stringify(ev3)).not.toContain(secret);
    expect(JSON.stringify(ev3)).not.toContain('오류');
    expect(c3.problem()?.text).toContain('종료 코드 1');
  });

  it('STOP: 먼저 쓰고, 답을 받으면 끝내고, 끝남을 확인한다 — 도는 입력은 STOPPED, 그 뒤 명령은 새 도우미', async () => {
    const f = fake({ typeChunkMs: 40, heldKeys: 2 });
    const c = client(f);
    const { lease, cap } = await armAndCapture(c);
    const pid = c.pid!;
    const typing = lease.send({ verb: 'TYPE', text: '가'.repeat(600), layout: cap.layout });
    await new Promise((r) => setTimeout(r, 120));
    const t0 = Date.now();
    const stop = await c.stop('긴급 정지');
    expect(stop).toMatchObject({ ok: true, acked: true, released: 2, hadProcess: true });
    expect(stop.durationMs).toBeLessThan(STOP_CONFIRM_MS);
    expect(Date.now() - t0).toBeLessThan(STOP_CONFIRM_MS);
    expect(pidAlive(pid)).toBe(false);
    const typed = await typing;
    expect(typed.ok).toBe(false);
    expect(typed.ok ? null : typed.kind === 'err' ? typed.reason : typed.kind).toMatch(/^(STOPPED|gone)$/);
    lease.end();
    const mine = f.log().filter((e) => e.pid === pid);
    const stopIn = mine.findIndex((e) => e.dir === 'in' && e.line === 'STOP');
    expect(stopIn).toBeGreaterThan(0);
    expect(mine.slice(stopIn).some((e) => e.dir === 'out' && e.line === 'STOP OK 2')).toBe(true);
    // 다시 쓰면 새 도우미 (STOP은 그 도우미에게 끝이다)
    expect(await c.request({ verb: 'SCREENS' })).toMatchObject({ ok: true });
    expect(c.pid).not.toBe(pid);
    expect(c.problem()).toBeNull();
    // 떠 있지 않을 때의 STOP
    await c.stop('교체');
    expect(await c.stop('또')).toEqual({ ok: true, acked: false, exited: true, released: null, hadProcess: false, detail: '화면 도우미가 떠 있지 않습니다', durationMs: 0 });
    expect([c.hasProcess(), c.stopping(), await c.confirmExit()]).toEqual([false, null, true]);
  });

  it('STOP 답이 늦어도 STOP_ACK 안이면 기다려 받는다 (끝내기 전에)', async () => {
    const f = fake({ stopAckDelayMs: 300, heldKeys: 1 });
    const c = client(f);
    await c.ready();
    const stop = await c.stop('긴급 정지');
    expect(stop).toMatchObject({ ok: true, acked: true, released: 1 });
    expect(stop.durationMs).toBeGreaterThanOrEqual(250);
    expect(stop.durationMs).toBeLessThan(DESKTOP_TIMEOUTS.STOP_ACK + 500);
  });

  it("STOP에 답하지 않는 도우미(무장한 적 있음): 0.8초 뒤 끝내고 '키·버튼을 뗐는지 확인하지 못했습니다' (끝남은 확인)", async () => {
    const f = fake({ noAck: ['STOP'] });
    const c = client(f);
    const { lease } = await armAndCapture(c);
    lease.end();
    const pid = c.pid!;
    const stop = await c.stop('긴급 정지');
    expect(stop).toMatchObject({ ok: false, acked: false, exited: true, released: null, detail: STOP_UNCONFIRMED_KEYS });
    expect(stop.durationMs).toBeGreaterThanOrEqual(DESKTOP_TIMEOUTS.STOP_ACK - 50);
    expect(stop.durationMs).toBeLessThan(STOP_CONFIRM_MS);
    expect(pidAlive(pid)).toBe(false);
    expect(f.log().some((e) => e.pid === pid && e.dir === 'in' && e.line === 'STOP')).toBe(true);
  });

  it('한 번도 무장하지 않은 도우미는 뗄 키가 없다 — STOP에 답이 없어도 끝남을 확인하면 그 정지는 성공이다. 준비 전에 멈추면 답을 기다리지 않는다 (S6-21 A3c)', async () => {
    // 지키는 것: 아무것도 주입하지 않은 도우미를 끝냈는데 '키·버튼을 뗐는지 확인하지 못했습니다'라고 하는 것 (긴급 정지가 완료가 아니게 된다)
    const f = fake({ noAck: ['STOP'] });
    const c = client(f);
    await c.ready();
    expect(await c.request({ verb: 'SCREENS' })).toMatchObject({ ok: true });
    const pid = c.pid!;
    const stop = await c.stop('긴급 정지');
    expect(stop).toMatchObject({ ok: true, acked: false, exited: true, released: null, detail: '화면 도우미를 멈췄습니다 (무장한 적이 없어 뗄 키·버튼이 없음)' });
    expect(pidAlive(pid)).toBe(false);
    // ARM 줄을 한 번이라도 썼으면(그 답을 받지 못했어도) 뗄 키가 있을 수 있다
    f.set({ noAck: ['STOP'], hang: ['ARM'] });
    const c2 = client(f, { timeouts: { ARM: 5000 } });
    const lease = await leaseOf(c2);
    void lease.send({ verb: 'ARM', policy: { pids: [], titles: [], titlePrefixes: [] } });
    await waitFor(() => f.received().some((l) => / ARM /.test(l)), 'ARM 줄');
    expect(await c2.stop('긴급 정지')).toMatchObject({ ok: false, acked: false, exited: true, detail: STOP_UNCONFIRMED_KEYS });
    lease.end();
    // 준비 전(READY 전)에 멈춘 도우미: STOP 답을 기다리지 않고 바로 끝내고, 준비를 기다리던 쪽에 곧바로 알린다
    const slow = fake({ readyDelayMs: 3000 });
    const c3 = client(slow);
    const ready = c3.ready();
    await waitFor(() => slow.pids().length === 1, '느린 도우미 시작');
    const t0 = Date.now();
    const early = await c3.stop('긴급 정지');
    expect(early).toMatchObject({ ok: true, acked: false, exited: true });
    expect(Date.now() - t0).toBeLessThan(DESKTOP_TIMEOUTS.STOP_ACK);
    expect(await ready).toMatchObject({ ok: false, code: 'helper_failed', text: '화면 도우미를 멈췄습니다' });
    expect(pidAlive(slow.pids()[0]!)).toBe(false);
    expect(c3.problem()).toBeNull();
  });

  it("끝나지 않는 도우미: '끝났는지 확인하지 못했습니다' — 확인 상한(STOP을 쓴 때부터) 안에 돌아온다", async () => {
    const f = fake({ noAck: ['STOP'] });
    const c = client(f, { kill: () => undefined, timeouts: { STOP_ACK: 150, STOP_CONFIRM: 600 } });
    await c.ready();
    const pid = c.pid!;
    strays.push(pid);
    const t0 = Date.now();
    const stop = await c.stop('긴급 정지');
    expect(stop).toMatchObject({ ok: false, acked: false, exited: false, detail: STOP_UNCONFIRMED_EXIT });
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(pidAlive(pid)).toBe(true);
  });

  it('도는 정지 위에 또 부른 stop은 같은 결과를 받는다 — "떠 있는 도우미가 없다·ok"라고 하지 않는다 (S6-21 A3b)', async () => {
    // 지키는 것: 앞선 STOP이 그 도우미의 끝남을 아직 확인하는 동안 온 두 번째 stop이 곧바로 ok를 돌려주는 것 (두 번째 긴급 정지가 '완료'가 된다)
    const f = fake({ noAck: ['STOP'], ignoreEof: true });
    const c = client(f, { kill: () => undefined, timeouts: { STOP_ACK: 200, STOP_CONFIRM: 900 } });
    const ev = events(c);
    expect((await c.ready()).ok).toBe(true);
    const pid = f.pids()[0]!;
    strays.push(pid);
    const p1 = c.stop('첫 정지');
    await new Promise((r) => setTimeout(r, 50));
    const p2 = c.stop('둘째 정지');
    expect(c.stopping()).not.toBeNull();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(pidAlive(pid)).toBe(true);
    expect(r2).toBe(r1);
    expect(r1).toMatchObject({ ok: false, exited: false, hadProcess: true, detail: STOP_UNCONFIRMED_EXIT });
    // 정지 한 번에 알림 한 번 — 그 정지를 기다리던 쪽보다 먼저
    expect(ev.filter((e) => e.type === 'stopped')).toEqual([{ type: 'stopped', own: null, reason: '첫 정지', result: r1 }]);
    expect(f.received().filter((l) => l === 'STOP')).toHaveLength(1);
  });

  it('끝남을 확인하지 못한 도우미가 있으면 새 도우미를 띄우지 않는다 — confirmExit가 한 번 더 끝내 확인하면 다시 띄운다 (S6-21 A1·A2)', async () => {
    // 지키는 것: 끝나지 않은 도우미가 살아 있는데 다음 요청이 두 번째 도우미를 띄우는 것
    let killable = false;
    const f = fake({ noAck: ['STOP'], ignoreEof: true });
    const c = client(f, { kill: (proc) => void (killable && proc.kill()), timeouts: { STOP_ACK: 100, STOP_CONFIRM: 400 } });
    expect((await c.ready()).ok).toBe(true);
    const pid = f.pids()[0]!;
    strays.push(pid);
    expect(await c.stop('긴급 정지')).toMatchObject({ ok: false, exited: false });
    expect([c.pid, c.hasProcess(), c.stopping()]).toEqual([null, true, null]);
    // 새로 띄우지 않는다 — ready·acquire·request 모두
    for (const r of [await c.ready(), await c.acquire(), await c.request({ verb: 'SCREENS' })]) {
      expect(r).toMatchObject({ ok: false, kind: 'unavailable', code: 'helper_failed', text: expect.stringContaining('끝났는지 확인하지 못해 새 화면 도우미를 띄우지 않습니다') });
    }
    expect(f.launches()).toBe(1);
    // 다시 stop을 불러도 '떠 있지 않다·ok'라고 하지 않는다 — 같은 사실을 곧바로 준다. 새로 STOP을 쓰고 2.8초를 다시 기다리지 않는다(앱 종료가 stopAll·dispose로
    // 잇달아 부른다). 한 번 더 끝내 보는 것은 confirmExit뿐이다 (대표의 정지 해제)
    const t0 = Date.now();
    const again = await c.stop('또 긴급 정지');
    expect(again).toMatchObject({ ok: false, exited: false, hadProcess: true, detail: STOP_UNCONFIRMED_EXIT });
    expect(Date.now() - t0).toBeLessThan(100);
    expect(f.received().filter((l) => l === 'STOP')).toHaveLength(1);
    expect(await c.confirmExit()).toBe(false);
    expect(f.received().filter((l) => l === 'STOP')).toHaveLength(2);
    expect(pidAlive(pid)).toBe(true);
    // 이제 끝내기가 듣는다 — confirmExit가 끝남을 확인하면 새 도우미를 띄울 수 있다
    killable = true;
    expect(await c.confirmExit()).toBe(true);
    expect(pidAlive(pid)).toBe(false);
    expect(c.hasProcess()).toBe(false);
    f.set({ noAck: [], ignoreEof: false });
    expect(await c.request({ verb: 'SCREENS' })).toMatchObject({ ok: true });
    expect(f.launches()).toBe(2);
    // 끝남을 확인하지 못한 도우미가 저절로 끝나도 풀린다
    const f2 = fake({ noAck: ['STOP'], ignoreEof: true });
    const c2 = client(f2, { kill: () => undefined, timeouts: { STOP_ACK: 100, STOP_CONFIRM: 300 } });
    expect((await c2.ready()).ok).toBe(true);
    expect(await c2.stop('긴급 정지')).toMatchObject({ exited: false });
    expect((await c2.ready()).ok).toBe(false);
    killFakePids(f2.pids());
    await waitFor(() => !c2.hasProcess(), '남은 도우미 끝남');
    f2.set({ noAck: [], ignoreEof: false });
    expect((await c2.ready()).ok).toBe(true);
  });

  it('STOP OK가 답을 기다리는 시간보다 늦게 와도 끝나기 전에 왔으면 뗐다는 답이다', async () => {
    const f = fake({ stopAckDelayMs: 300, heldKeys: 2, ignoreEof: true });
    const held: { kill: (() => void) | null } = { kill: null };
    const c = client(f, { kill: (proc) => void (held.kill = () => proc.kill()), timeouts: { STOP_ACK: 100, STOP_CONFIRM: 1500 } });
    const { lease } = await armAndCapture(c);
    lease.end();
    const p = c.stop('긴급 정지');
    // 답(0.3초)은 STOP_ACK(0.1초) 뒤에 온다 — 그 뒤에 끝난다
    await waitFor(() => f.log().some((e) => e.dir === 'out' && e.line === 'STOP OK 2'), '늦은 STOP OK');
    await new Promise((r) => setTimeout(r, 50));
    held.kill!();
    expect(await p).toMatchObject({ ok: true, acked: true, exited: true, released: 2 });
  });

  it('RELEASE: 슬롯 밖에서 바로 — 도는 TYPE는 RELEASED와 보낸 양, 다시 ARM할 때까지 입력은 RELEASED, 도우미는 남는다', async () => {
    const f = fake({ typeChunkMs: 30 });
    const c = client(f);
    const { lease, cap } = await armAndCapture(c);
    const pid = c.pid!;
    const typing = lease.send({ verb: 'TYPE', text: 'a'.repeat(400), layout: cap.layout });
    await new Promise((r) => setTimeout(r, 80));
    expect(c.busy()).toBe(true);
    const rel = await c.release();
    expect(rel).toEqual({ acked: true, released: 0, hadProcess: true, detail: '키·버튼 0개를 뗐습니다' });
    const typed = await typing;
    expect(typed).toMatchObject({ ok: false, kind: 'err', reason: 'RELEASED' });
    expect(typed.ok || typed.kind !== 'err' ? 0 : typed.sent).toBeGreaterThan(0);
    expect(c.armed()).toBe(false);
    expect(await lease.send({ verb: 'CLICK', x: 5, y: 5, button: 'left', count: 1, layout: cap.layout })).toMatchObject({ reason: 'RELEASED' });
    expect(await lease.send({ verb: 'ARM', policy: { pids: [], titles: [], titlePrefixes: [] } })).toMatchObject({ ok: true });
    expect(await lease.send({ verb: 'CLICK', x: 5, y: 5, button: 'left', count: 1, layout: cap.layout })).toMatchObject({ ok: true });
    lease.end();
    expect(c.pid).toBe(pid);
    // RELEASE에 답하지 않으면 acked:false (상한 1초)
    f.act({ do: 'set', value: { noAck: ['RELEASE'] } });
    await new Promise((r) => setTimeout(r, 120));
    const silent = await c.release();
    expect(silent).toMatchObject({ acked: false, released: null, hadProcess: true, detail: '화면 도우미가 1초 안에 RELEASE에 답하지 않았습니다' });
    expect(pidAlive(pid)).toBe(true);
  });

  it('HUMAN·HOTKEY 알림은 epoch ms로 전하고, HOTKEY 뒤에는 무장이 풀린다 — ARM의 seed는 주입 전 값', async () => {
    const seedMs = Date.now() - 12_345;
    const f = fake({ seedMs, humanAfterArmMs: [60], hotkeyAfterArmMs: 200 });
    const c = client(f);
    const ev = events(c);
    const lease = await leaseOf(c);
    const t0 = Date.now();
    expect(await lease.send({ verb: 'ARM', policy: { pids: [], titles: [], titlePrefixes: [] } })).toEqual({ ok: true, value: { seed: seedMs, hotkey: true } });
    expect(c.armed()).toBe(true);
    await waitFor(() => ev.some((e) => e.type === 'hotkey'), 'HOTKEY');
    const human = ev.find((e) => e.type === 'human');
    const hot = ev.find((e) => e.type === 'hotkey');
    expect(human && human.type === 'human' ? human.at : 0).toBeGreaterThanOrEqual(t0);
    expect(hot && hot.type === 'hotkey' ? hot.at : 0).toBeGreaterThanOrEqual(t0);
    expect(c.armed()).toBe(false);
    lease.end();
    // 사람 입력은 도는 TYPE을 다음 단계에서 멈춘다
    const f2 = fake({ typeChunkMs: 40 });
    const c2 = client(f2);
    const { lease: l2, cap } = await armAndCapture(c2);
    const typing = l2.send({ verb: 'TYPE', text: 'b'.repeat(500), layout: cap.layout });
    await new Promise((r) => setTimeout(r, 60));
    f2.act({ do: 'human' });
    expect(await typing).toMatchObject({ ok: false, kind: 'err', reason: 'HUMAN_ACTIVE' });
    l2.end();
  });

  it('한 번에 하나: 동시에 온 요청도 앞 답이 온 뒤에야 다음 줄을 쓴다', async () => {
    const f = fake({ delayMs: { SCREENS: 150 } });
    const c = client(f);
    await c.ready();
    const [a, b, d] = await Promise.all([c.request({ verb: 'SCREENS' }), c.request({ verb: 'FOCUS' }), c.request({ verb: 'WINDOWS' })]);
    expect([a.ok, b.ok, d.ok]).toEqual([true, true, true]);
    const order = f
      .log()
      .filter((e) => e.dir !== 'note')
      .map((e) => `${e.dir}:${e.line.split(' ').slice(0, 2).join(' ')}`);
    expect(order).toEqual(['out:READY 3', 'in:1 SCREENS', 'out:1 OK', 'in:2 FOCUS', 'out:2 OK', 'in:3 WINDOWS', 'out:3 OK']);
    // 슬롯을 쥔 채 두 번 보내면 던진다
    const lease = await leaseOf(c);
    const first = lease.send({ verb: 'SCREENS' });
    expect(() => lease.send({ verb: 'FOCUS' })).toThrow('한 번에 하나');
    await first;
    lease.end();
  });

  it('띄우기 거부(해시가 다름 등)는 곧바로 쓸 수 없음이고 세지 않는다 — 거부가 풀리면 띄운다', async () => {
    const f = fake();
    const c = client(f);
    f.refuse('화면 도우미 파일(WookDesktopHelper.exe)이 준비할 때와 다릅니다 (시험)');
    for (let i = 0; i < MAX_HELPER_FAILURES + 1; i++) {
      expect(await c.acquire()).toEqual({ ok: false, kind: 'unavailable', code: 'helper_failed', text: '화면 도우미 파일(WookDesktopHelper.exe)이 준비할 때와 다릅니다 (시험)' });
    }
    expect(f.launches()).toBe(0);
    expect(c.problem()).toMatchObject({ permanent: false });
    f.refuse(null);
    expect(await c.ready()).toMatchObject({ ok: true });
  });

  it('ARM 정책은 base64 줄로 가고(가짜가 풀어 쓴다), 줄바꿈 든 제목은 한 줄로 바뀐다', async () => {
    const f = fake({ focus: { app: 'node', title: '욱채 서버 (pid 9)', pid: 9, control: null, password: false, blocked: false, elevated: false } });
    const c = client(f);
    const lease = await leaseOf(c);
    await lease.send({ verb: 'ARM', policy: { pids: [9], titles: ['욱채 서버 (pid 9)\n2 STOP'], titlePrefixes: ['욱채'] } });
    const cap = await lease.send({ verb: 'CAPTURE', screen: 1, maxEdge: 320, id: 'SC-000003' });
    if (!cap.ok) throw new Error('캡처');
    expect(await lease.send({ verb: 'KEY', combo: 'enter', layout: cap.value.layout })).toMatchObject({ reason: 'BLOCKED_TARGET', detail: 'window' });
    lease.end();
    const armLine = f.received().find((l) => / ARM /.test(l))!;
    expect(armLine).toMatch(/^\d+ ARM [A-Za-z0-9+/=]+$/);
    expect(decodePolicy(armLine.split(' ')[2]!)).toEqual({ pids: [9], titles: ['욱채 서버 (pid 9) 2 STOP'], titlePrefixes: ['욱채'] });
    // 캡처 파일은 화면 폴더에 (.tmp를 남기지 않고)
    expect(existsSync(`${f.screensDir}/SC-000003.png`)).toBe(true);
    expect(existsSync(`${f.screensDir}/SC-000003.png.tmp`)).toBe(false);
    expect(readFileSync(`${f.screensDir}/SC-000003.png`).subarray(1, 4).toString('ascii')).toBe('PNG');
  });

  it('표시 위의 놓기(countFailure)에 답하지 않는 도우미는 다른 명령의 시간 초과처럼 STOP하고 끝내고 센다 — 세 번이면 상한이다. 보통의 놓기는 세지 않고 도우미를 남긴다 (S6-23 M2)', async () => {
    const f = fake({ noAck: ['RELEASE'] });
    const c = client(f, { timeouts: { RELEASE: 150 } });
    const ev = events(c);
    // 보통의 놓기(턴 끝·gui_input release): 부른 쪽이 STOP으로 잇는다 — 여기서는 세지도 멈추지도 않는다
    expect((await c.ready()).ok).toBe(true);
    const kept = c.pid!;
    expect(await c.release()).toMatchObject({ acked: false, hadProcess: true });
    expect([pidAlive(kept), c.problem(), c.pid]).toEqual([true, null, kept]);
    for (let round = 1; round <= MAX_HELPER_FAILURES; round++) {
      expect((await c.ready()).ok).toBe(true);
      const pid = c.pid!;
      expect(await c.release({ countFailure: true })).toEqual({ acked: false, released: null, hadProcess: true, detail: '화면 도우미가 0.2초 안에 RELEASE에 답하지 않았습니다' });
      // 그 도우미의 정지까지 (상한이 있다 — 멈추지 않았으면 아래 단언이 판정한다)
      await waitFor(() => !pidAlive(pid) && c.stopping() === null, '답하지 않는 도우미를 멈춤', 3000).catch(() => undefined);
      expect([pidAlive(pid), c.stopping()]).toEqual([false, null]);
      expect(f.log().filter((e) => e.pid === pid && e.dir === 'in').map((e) => e.line.replace(/^\d+ /, '')).slice(-2)).toEqual(['RELEASE', 'STOP']);
      if (round < MAX_HELPER_FAILURES) expect(c.problem()).toMatchObject({ code: 'helper_failed', permanent: false, text: RELEASE_UNANSWERED_STOP });
    }
    expect(c.problem()).toMatchObject({ code: 'helper_failed', permanent: true, text: expect.stringContaining(RELEASE_UNANSWERED_STOP) });
    expect(ev.filter((e) => e.type === 'stopped').map((e) => (e.type === 'stopped' ? [e.own, e.reason, e.result.exited] : null))).toEqual(
      Array(MAX_HELPER_FAILURES).fill(['timeout', RELEASE_UNANSWERED_STOP, true]),
    );
    expect(await c.ready()).toMatchObject({ ok: false, code: 'helper_failed' });
    expect(f.launches()).toBe(MAX_HELPER_FAILURES);
  });

  it('가짜 도우미는 앞 도우미에게 일으킨 사건(crash·사람 입력·단축키)을 새 도우미에서 되풀이하지 않는다 — 상태를 바꾸는 set은 뒤에 띄운 도우미에도 시작할 때 든다 (S6-23 M5)', async () => {
    // 지키는 것: 제어 파일의 crash를 새 도우미가 다시 읽어 첫 읽기(40ms)에 끝나는 것 — 그러면 다시 띄운 도우미를 쓰는 시험이 빠르기에 기대 통과한다
    const f = fake();
    const c = client(f);
    const ev = events(c);
    expect((await c.ready()).ok).toBe(true);
    const first = c.pid!;
    f.act({ do: 'set', value: { hotkey: false } });
    f.act({ do: 'human' });
    await waitFor(() => ev.some((e) => e.type === 'human'), '첫 도우미의 사람 입력');
    f.act({ do: 'hotkey' });
    await waitFor(() => ev.some((e) => e.type === 'hotkey'), '첫 도우미의 단축키');
    f.act({ do: 'crash' });
    // 클라이언트가 그 끝남을 알 때까지 (프로세스가 먼저 사라질 수 있다)
    await waitFor(() => !pidAlive(first) && c.pid === null, '첫 도우미 끝남');
    expect((await c.ready()).ok).toBe(true);
    const second = c.pid!;
    expect(second).not.toBe(first);
    // 앞서 쓴 set은 든다 — 이 도우미도 단축키를 걸지 못했다고 답한다
    const lease = await leaseOf(c);
    expect(await lease.send({ verb: 'ARM', policy: { pids: [], titles: [], titlePrefixes: [] } })).toMatchObject({ ok: true, value: { hotkey: false } });
    lease.end();
    await new Promise((r) => setTimeout(r, 300));
    // 앞서 쓴 사건은 하지 않는다 — 끝나지 않았고, 사람 입력·단축키 알림이 다시 오지 않았고, 무장한 채다
    expect([pidAlive(second), ev.filter((e) => e.type === 'human').length, ev.filter((e) => e.type === 'hotkey').length, c.armed()]).toEqual([true, 1, 1, true]);
    expect(f.log().filter((x) => x.pid === second && x.dir === 'note').map((x) => x.line)).toEqual(['start ready', 'set before start']);
    // 이 도우미가 시작한 뒤에 쓴 사건은 한다
    f.act({ do: 'human' });
    await waitFor(() => ev.filter((e) => e.type === 'human').length === 2, '새 도우미의 사람 입력');
  });
});

/**
 * 무장 표시는 도우미가 보낸 줄의 순서를 따른다 (리드 결정 S6-23 M3). 아주 작은 가짜(이 시험이 임시 폴더에 쓰는 Node 스크립트 — 화면·입력과 상관없다)가 ARM 답과
 * 그 뒤의 줄을 한 번의 쓰기로 보낸다
 */
describe('무장 표시와 도우미가 보낸 줄의 순서 (S6-23 M3)', () => {
  const NL = 'String.fromCharCode(10)';
  const TINY_HELPER = [
    "import { createInterface } from 'node:readline';",
    'const order = process.env.TINY_ORDER;',
    `const w = (...lines) => process.stdout.write(lines.join(${NL}) + ${NL});`,
    "w('READY 3 1 locked=0 wda=1 build=19045');",
    'let heldArm = null;',
    'const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });',
    "rl.on('line', (line) => {",
    "  if (line === 'STOP') { w('STOP OK 0'); return; }",
    "  const sp = line.indexOf(' ');",
    '  const id = line.slice(0, sp);',
    '  const rest = line.slice(sp + 1);',
    "  if (rest.startsWith('ARM ')) {",
    "    if (order === 'arm-then-hotkey') w(id + ' OK seed=1 hotkey=1', 'HOTKEY ' + Date.now());",
    "    else if (order === 'arm-then-release' || order === 'release-then-arm') heldArm = id;",
    "    else w(id + ' OK seed=1 hotkey=1');",
    '    return;',
    '  }',
    "  if (rest === 'RELEASE') {",
    "    if (order === 'release-err') { w(id + ' ERR INTERNAL tiny'); return; }",
    "    if (order === 'release-garbage') { w(id + ' OK many'); return; }",
    "    if (heldArm !== null && order === 'arm-then-release') w(heldArm + ' OK seed=1 hotkey=1', id + ' OK 0');",
    "    else if (heldArm !== null && order === 'release-then-arm') w(id + ' OK 0', heldArm + ' OK seed=1 hotkey=1');",
    "    else w(id + ' OK 0');",
    '    heldArm = null;',
    '    return;',
    '  }',
    "  w(id + ' ERR RELEASED');",
    '});',
    "rl.on('close', () => process.exit(0));",
  ].join('\n');
  const POLICY = { pids: [], titles: [], titlePrefixes: [] };
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  function tiny(order: string): { c: DesktopHelperClient; ev: DesktopHelperEvent[] } {
    const dir = mkdtempSync(join(tmpdir(), 'wook-armorder-'));
    dirs.push(dir);
    const screens = join(dir, 'screens');
    mkdirSync(screens);
    const script = join(dir, 'tiny-helper.mjs');
    writeFileSync(script, TINY_HELPER);
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v;
    env.TINY_ORDER = order;
    const c = createDesktopHelper({ launcher: { launch: () => ({ file: process.execPath, args: [script], env }) }, log: () => undefined, screensDir: () => screens });
    clients.push(c);
    return { c, ev: events(c) };
  }

  it('ARM 답 바로 뒤에 HOTKEY가 같은 덩어리로 오면 무장하지 않은 것으로 본다 — 다음 호출이 다시 ARM한다', async () => {
    // 지키는 것: 무장을 ARM 답의 나중 마이크로태스크에서 세우면, 같은 덩어리의 HOTKEY가 푼 무장이 다시 서서 그 턴 내내 ARM 없이 RELEASED를 받는 것
    const { c, ev } = tiny('arm-then-hotkey');
    const lease = await leaseOf(c);
    expect(await lease.send({ verb: 'ARM', policy: POLICY })).toMatchObject({ ok: true });
    lease.end();
    await waitFor(() => ev.some((e) => e.type === 'hotkey'), 'HOTKEY');
    await new Promise((r) => setTimeout(r, 50));
    expect(c.armed()).toBe(false);
  });

  it('입력이 RELEASED로 돌아오면 무장하지 않은 것으로 본다 (ARM에만 답하면 무장한 것)', async () => {
    const { c } = tiny('arm-only');
    const lease = await leaseOf(c);
    expect(await lease.send({ verb: 'ARM', policy: POLICY })).toMatchObject({ ok: true });
    expect(c.armed()).toBe(true);
    expect(await lease.send({ verb: 'MOVE', x: 1, y: 1, layout: 'deadbeefdeadbeef' })).toMatchObject({ ok: false, kind: 'err', reason: 'RELEASED' });
    expect(c.armed()).toBe(false);
    lease.end();
  });

  it.each([
    ['arm-then-release', false],
    ['release-then-arm', true],
  ] as const)('ARM 답과 RELEASE 답이 한 덩어리로 오면 줄 순서대로 정한다 — %s', async (order, armedAfter) => {
    const { c } = tiny(order);
    const lease = await leaseOf(c);
    const arm = lease.send({ verb: 'ARM', policy: POLICY });
    await new Promise((r) => setTimeout(r, 50));
    const rel = await c.release();
    expect([(await arm).ok, rel.acked]).toEqual([true, true]);
    lease.end();
    expect(c.armed()).toBe(armedAfter);
  });

  it.each([
    ['release-err', '화면 도우미가 RELEASE를 하지 못했습니다 (INTERNAL)'],
    ['release-garbage', '화면 도우미의 RELEASE 답을 알아볼 수 없습니다'],
  ] as const)('세는 놓기(countFailure)에 ERR나 알아볼 수 없는 답을 한 도우미도 STOP하고 끝내고 센다 — 보통의 놓기는 세지 않고 남긴다 (S6-24 2, S6-25 N4 2) — %s', async (order, detail) => {
    // 지키는 것: 답하지 않은 것만 세면, 늘 ERR나 엉뚱한 답을 하는 새 도우미를 표시 위의 놓기·무장의 놓기마다 끝없이 다시 띄운다
    const { c, ev } = tiny(order);
    expect((await c.ready()).ok).toBe(true);
    const pid = c.pid!;
    // 보통의 놓기 — 부른 쪽이 STOP으로 잇는다: 여기서는 세지도 멈추지도 않는다
    expect(await c.release()).toEqual({ acked: false, released: null, hadProcess: true, detail });
    expect([pidAlive(pid), c.problem(), c.pid]).toEqual([true, null, pid]);
    // 세는 놓기 — 그 도우미를 멈추고 센다
    expect(await c.release({ countFailure: true })).toEqual({ acked: false, released: null, hadProcess: true, detail });
    await waitFor(() => !pidAlive(pid) && c.stopping() === null, '알아볼 수 없게 답한 도우미를 멈춤', 3000).catch(() => undefined);
    expect([pidAlive(pid), c.pid, c.stopping()]).toEqual([false, null, null]);
    expect(c.problem()).toMatchObject({ code: 'helper_failed', permanent: false, text: RELEASE_UNANSWERED_STOP });
    expect(ev.filter((e) => e.type === 'stopped').map((e) => (e.type === 'stopped' ? [e.own, e.reason, e.result.exited] : null))).toEqual([['timeout', RELEASE_UNANSWERED_STOP, true]]);
  });
});

describe.skipIf(process.platform !== 'win32')('서버와 함께 끝난다 (리드 결정 S6-0: 러너의 작업 개체 밖에서 직접 띄워도)', () => {
  it('서버 프로세스를 강제로 끝내면 도우미도 끝난다 — 표준 입력이 닫혀도 끝나지 않는 가짜로 (Node의 작업 개체가 끝낸다)', async () => {
    const f = fake();
    const clientPath = fileURLToPath(new URL('../../src/main/desktop/desktopHelper.ts', import.meta.url));
    const host = spawn(process.execPath, [fileURLToPath(new URL('../fixtures/desktop/serverHost.mjs', import.meta.url)), clientPath, FAKE_DESKTOP_HELPER, f.screensDir], {
      // ignoreEof: 표준 입력이 닫혀서 끝나는 것이 아니라 작업 개체가 끝내는지 본다
      env: { ...process.env, WOOK_FAKE_DESKTOP: JSON.stringify({ logPath: f.logPath, controlPath: f.controlPath, ignoreEof: true }) },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    let err = '';
    host.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
    host.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')));
    try {
      await waitFor(() => /HELPER \d+|FAIL/.test(out), `서버 흉내의 도우미 시작 (${err.slice(0, 300)})`, 15_000);
      const m = /HELPER (\d+)/.exec(out);
      if (!m) throw new Error(`도우미를 띄우지 못함: ${out} ${err}`);
      const helperPid = Number(m[1]);
      strays.push(helperPid);
      expect(pidAlive(helperPid)).toBe(true);
      // Windows: TerminateProcess — 표준 입력을 닫을 틈 없이 끝난다. 도우미는 Node의 작업 개체가 끝낸다
      host.kill('SIGKILL');
      await waitFor(() => !pidAlive(helperPid), '도우미가 서버와 함께 끝남', 5000);
    } finally {
      host.kill('SIGKILL');
    }
  });
});
