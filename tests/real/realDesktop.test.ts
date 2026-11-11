/**
 * 실제 화면 조작 (SERVER_DESIGN 10.6 '실제 화면', 리드 결정 S6-13) — 실제 화면 도우미(WookDesktopHelper.exe)로 이 PC의 화면을 찍고 입력을 보낸다.
 * 기본 테스트에서는 건너뛴다. 사람이 그 PC 앞에서, 다른 일을 하지 않을 때만 돌린다 — 포인터가 움직이고 글자가 쳐진다:
 *
 *   set WOOK_REAL_DESKTOP=1
 *   set WOOK_REAL_DESKTOP_HOST=<이 PC의 이름 — hostname 명령의 출력>
 *   npx vitest run tests/real/realDesktop.test.ts
 *
 * 문은 둘이다: WOOK_REAL_DESKTOP=1만으로는 돌지 않고, WOOK_REAL_DESKTOP_HOST가 이 PC의 이름과 같아야 한다 — 다른 PC에서 쓰던 환경 변수가 남아 있어도 돌지 않게.
 * 같은 문이 실제 도우미를 띄우는 코드(process/compiledTool.ts realDesktopGateOpen)에도 있다. 에이전트는 이 문을 열지 않는다 (리드 결정 S6-15).
 * 이 파일은 불러올 때 아무것도 하지 않는다 — 띄우는 일은 모두 문 안의 beforeAll에서 한다.
 *
 * 보는 것:
 * - 메모장(시험이 임시 파일로 직접 연다) → 캡처 → 그 창을 클릭 → '안녕하세요' 입력 → Ctrl+S → 파일 내용
 * - 놓인 자리: move한 실제 픽셀에 포인터가 있다 (DPI — 좌표는 실제 픽셀)
 * - 조작 중 표시(주황 테두리)가 캡처에 찍히지 않는다 (WDA_EXCLUDEFROMCAPTURE, 빌드 19041+)
 * - Shift가 눌린 채 긴급 정지 → 3초 안에 끝나고 키가 풀려 있다 (GetAsyncKeyState)
 * 사람 입력 감지(훅이 사람과 주입을 가르는지)는 시험으로 흉내 낼 수 없다 — 수동 점검 항목이다 (10.6). 메인 턴은 모의 실행만 뜬다 — 실제 CLI를 띄우지 않는다
 * (화면 도구는 처리기를 직접 부른다, 리드 결정 S6-19).
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID, OPERATOR } from '@shared/domain';
import { buildOrchestratorDeps } from '../../src/main/backend/buildDeps';
import type { GuiInputResult, ScreenCaptureResult, ScreenInfoResult } from '../../src/main/mcp/catalog';
import type { ToolCallResult } from '../../src/main/mcp/types';
import { createOrchestrator, type Orchestrator } from '../../src/main/orchestrator/orchestrator';
import { mainOpsIdentity } from '../regression/mainOps';

const ENABLED =
  process.platform === 'win32' && process.env.WOOK_REAL_DESKTOP === '1' && !!process.env.WOOK_REAL_DESKTOP_HOST && process.env.WOOK_REAL_DESKTOP_HOST === hostname();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const VK_SHIFT = 0x10;

/** user32를 부르는 한 줄 PowerShell — 키 상태·포인터 자리를 읽고, Shift를 누르거나 뗀다 (이 시험의 확인용) */
function user32(body: string): string {
  const script = [
    "$sig = '[DllImport(\"user32.dll\")] public static extern short GetAsyncKeyState(int vk);",
    '[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, System.UIntPtr extra);',
    '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();',
    '[DllImport("user32.dll")] public static extern bool GetCursorPos(out System.Drawing.Point p);\';',
    'Add-Type -MemberDefinition $sig -Name U -Namespace WookReal -ReferencedAssemblies System.Drawing | Out-Null;',
    '[WookReal.U]::SetProcessDPIAware() | Out-Null;',
    body,
  ].join(' ');
  return execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 20_000 }).trim();
}

const shiftDown = (): boolean => user32(`if (([WookReal.U]::GetAsyncKeyState(${VK_SHIFT}) -band 0x8000) -ne 0) { 'down' } else { 'up' }`) === 'down';

/** 8비트 RGB·RGBA PNG를 푼다 (겹침 없음) — 그 픽셀의 [r, g, b] */
function decodePng(png: Buffer): { width: number; height: number; at(x: number, y: number): [number, number, number] } {
  let off = 8;
  let ihdr: Buffer | null = null;
  const idat: Buffer[] = [];
  while (off + 8 <= png.length) {
    const len = png.readUInt32BE(off);
    const type = png.toString('ascii', off + 4, off + 8);
    const data = png.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') ihdr = data;
    else if (type === 'IDAT') idat.push(data);
    off += 12 + len;
  }
  if (!ihdr) throw new Error('PNG에 IHDR이 없습니다');
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const bpp = ihdr[9] === 6 ? 4 : 3;
  if (ihdr[8] !== 8 || (ihdr[9] !== 2 && ihdr[9] !== 6) || ihdr[12] !== 0) throw new Error('이 시험이 풀 수 없는 PNG 형식입니다');
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    for (let i = 0; i < stride; i++) {
      const cur = raw[y * (stride + 1) + 1 + i]!;
      const a = i >= bpp ? out[y * stride + i - bpp]! : 0;
      const b = y > 0 ? out[(y - 1) * stride + i]! : 0;
      const c = i >= bpp && y > 0 ? out[(y - 1) * stride + i - bpp]! : 0;
      let pred = 0;
      if (filter === 1) pred = a;
      else if (filter === 2) pred = b;
      else if (filter === 3) pred = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[y * stride + i] = (cur + pred) & 0xff;
    }
  }
  return { width, height, at: (x, y) => [out[y * stride + x * bpp]!, out[y * stride + x * bpp + 1]!, out[y * stride + x * bpp + 2]!] };
}

describe.skipIf(!ENABLED)('실제 화면 조작 (WOOK_REAL_DESKTOP=1 · WOOK_REAL_DESKTOP_HOST=이 PC 이름)', () => {
  let orch: Orchestrator;
  let dataDir = '';
  let workRoot = '';
  let file = '';
  let notepad: ChildProcess | null = null;

  const call = (tool: string, args: Record<string, unknown> = {}): Promise<ToolCallResult> => orch.core.tools.handle(mainOpsIdentity(), tool, args);
  /** 사람이 방금 그 PC를 썼으면(이 시험을 띄운 손) 30초 멈춤이 걸린다 — 풀릴 때까지 다시 부른다 */
  async function quiet(tool: string, args: Record<string, unknown> = {}): Promise<ToolCallResult> {
    for (let i = 0; i < 20; i++) {
      const r = await call(tool, args);
      if (r.ok || (r.code !== 'human_active' && r.code !== 'rate_limited')) return r;
      if (i === 0 && r.code === 'human_active') process.stdout.write('[실제 화면] 키보드·마우스에서 손을 떼 주세요 — 사람 입력 뒤 30초 동안 화면 조작을 멈춥니다\n');
      await sleep(r.code === 'rate_limited' ? 1100 : 5000);
    }
    return call(tool, args);
  }
  const data = <T>(r: ToolCallResult): T => {
    if (!r.ok) throw new Error(`거부: ${r.code} ${r.message}`);
    return r.data as T;
  };
  let seq = 0;
  const input = async (args: Record<string, unknown>): Promise<GuiInputResult> => {
    await sleep(300);
    return data<GuiInputResult>(await quiet('gui_input', { request_id: `real-desktop-${Date.now()}-${++seq}`, then_capture: false, ...args }));
  };
  const shoot = async (): Promise<ScreenCaptureResult> => {
    await sleep(700);
    return data<ScreenCaptureResult>(await quiet('screen_capture', { max_width: 1568 }));
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'wook-real-desktop-data-'));
    workRoot = mkdtempSync(join(tmpdir(), 'wook-real-desktop-work-'));
    file = join(mkdtempSync(join(tmpdir(), 'wook-real-desktop-file-')), `wook-real-${Date.now()}.txt`);
    writeFileSync(file, '');
    const deps = await buildOrchestratorDeps({
      dataDir,
      appRoot: process.cwd(),
      isPackaged: false,
      nodeExecPath: process.execPath,
      nodeExecEnv: {},
      shell: null,
      memorySecrets: true,
      // 서버 방식의 Windows에서만 실제 화면 도우미를 쓴다 — 화면 도우미를 넘기지 않아 실제 것이 붙는다 (문이 열렸을 때만)
      mode: 'server',
      workspaceRoot: workRoot,
    });
    if (!deps.desktop) throw new Error('실제 화면 도우미가 붙지 않았습니다 — 문(WOOK_REAL_DESKTOP·WOOK_REAL_DESKTOP_HOST)을 확인하세요');
    // 시작 전에 메인 에이전트를 모의 실행으로 — 화면 도우미가 붙으면 시작 때 화면 확인 턴이 뜬다 (실제 CLI를 띄우지 않는다, 리드 결정 S6-19)
    deps.store.kv.set('settings', { developer: { mainAgentMock: true, mockSpeed: 25 } });
    const stub = { installed: true, path: 'stub', version: '9.9.9', loggedIn: true, problem: null, detail: '시험용 고정 CLI 상태' };
    deps.adapters.claude = { ...deps.adapters.claude, detect: async () => stub };
    deps.adapters.codex = { ...deps.adapters.codex, detect: async () => stub };
    orch = await createOrchestrator(deps);
    notepad = spawn('notepad.exe', [file], { detached: true, stdio: 'ignore', windowsHide: false });
    notepad.unref();
    await sleep(2500);
  }, 180_000);

  afterAll(async () => {
    // 눌린 채 남았을 수 있는 Shift를 뗀다 (긴급 정지 시험이 중간에 실패한 경우)
    try {
      user32(`[WookReal.U]::keybd_event(${VK_SHIFT}, 0, 2, [System.UIntPtr]::Zero)`);
    } catch {
      // 확인용 호출이 실패해도 정리는 이어 간다
    }
    try {
      // 이 시험이 띄운 메모장이 아직 끝나지 않았을 때만 그 핸들로 끝낸다 — 끝난 프로세스의 PID 번호로 죽이지 않는다 (리드 결정 S7-20 TI-8)
      if (notepad && notepad.exitCode === null && notepad.signalCode === null) notepad.kill();
    } catch {
      // 이미 끝났다 (새 메모장은 다른 프로세스로 넘어갈 수 있다 — 남으면 손으로 닫는다)
    }
    await orch?.stop().catch(() => undefined);
    for (const d of [dataDir, workRoot, file ? join(file, '..') : '']) if (d) await rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
  }, 60_000);

  it('메모장: 캡처 → 그 창을 클릭 → 안녕하세요 입력 → Ctrl+S → 파일에 그 글이 있다. 놓인 자리는 요청한 실제 픽셀이다', async () => {
    const info = data<ScreenInfoResult>(await quiet('screen_info'));
    const win = info.windows.find((w) => w.title.includes(basename(file)));
    if (!win) throw new Error(`메모장 창을 찾지 못했습니다 (창 ${info.windows_total}개) — 다른 창에 가려졌거나 뜨지 않았습니다`);
    expect(win.blocked).toBe(false);
    const cap = await shoot();
    expect(cap.image === 'attached' || cap.image === 'text_only').toBe(true);
    // 창 가운데 (실제 픽셀) → 이 캡처의 좌표
    const cx = Math.floor((win.x + win.width / 2 - cap.origin.x) / cap.scale);
    const cy = Math.floor((win.y + win.height / 2 - cap.origin.y) / cap.scale);
    const moved = await input({ action: 'move', capture_id: cap.capture_id, x: cx, y: cy });
    // 놓인 자리: 포인터가 그 실제 픽셀에 있다 (DPI — 좌표는 실제 픽셀)
    const [px, py] = user32("$p = New-Object System.Drawing.Point; [WookReal.U]::GetCursorPos([ref]$p) | Out-Null; \"$($p.X),$($p.Y)\"").split(',').map(Number);
    expect([px, py]).toEqual([moved.real!.x, moved.real!.y]);
    await input({ action: 'click', capture_id: cap.capture_id, x: cx, y: cy });
    const typed = await input({ action: 'type', capture_id: cap.capture_id, text: '안녕하세요' });
    expect(typed.focus?.password).toBe(false);
    await input({ action: 'key', capture_id: cap.capture_id, keys: 'ctrl+s' });
    let text = '';
    for (let i = 0; i < 25 && !text.includes('안녕하세요'); i++) {
      await sleep(200);
      const bytes = readFileSync(file);
      text = new TextDecoder('utf-8').decode(bytes);
      if (!text.includes('안녕하세요')) text = new TextDecoder('euc-kr').decode(bytes);
    }
    expect(text).toContain('안녕하세요');
    // 기록에 남았다 — 캡처·이동·클릭·글·키, 글은 그대로 (비밀 값이 아니다)
    const rows = orch.core.ctx.store.guiActions.query({ limit: 20, asc: true }).filter((r) => r.by === 'main' && r.result === 'ok');
    expect(rows.map((r) => r.action)).toEqual(expect.arrayContaining(['capture', 'move', 'click', 'type', 'key']));
    expect(rows.find((r) => r.action === 'type')?.text).toBe('안녕하세요');
  }, 180_000);

  it('조작 중 표시(주황 테두리)는 캡처에 찍히지 않는다 — 빌드 19041부터', async () => {
    const helper = orch.core.desktop.peek();
    const ready = helper?.readyInfo();
    expect(helper?.armed()).toBe(true);
    if (!ready?.wda) {
      process.stdout.write(`[실제 화면] 이 Windows 빌드(${ready?.build ?? '?'})에는 캡처에서 표시를 빼는 기능이 없습니다 — 표시가 캡처에 찍힙니다 (사전 점검이 경고한다). 이 확인은 건너뜁니다\n`);
      return;
    }
    const cap = await shoot();
    const png = decodePng(readFileSync(cap.file));
    const orange = ([r, g, b]: [number, number, number]) => Math.abs(r - 230) < 40 && Math.abs(g - 81) < 40 && b < 60;
    // 테두리 4픽셀 안쪽의 네 변 가운데와 네 모서리
    const samples: [number, number][] = [
      [1, 1],
      [png.width - 2, 1],
      [1, png.height - 2],
      [png.width - 2, png.height - 2],
      [Math.floor(png.width / 2), 1],
      [1, Math.floor(png.height / 2)],
      [png.width - 2, Math.floor(png.height / 2)],
      [Math.floor(png.width / 2), png.height - 2],
    ];
    const hits = samples.filter(([x, y]) => orange(png.at(x, y)));
    expect(hits).toEqual([]);
  }, 120_000);

  it('Shift가 눌린 채 긴급 정지하면 3초 안에 끝나고 키가 풀려 있다 — 요약은 완료', async () => {
    // 도우미가 떠 있고 무장한 상태에서, 눌린 채 남은 수정 키를 흉내 낸다
    await shoot();
    expect(orch.core.desktop.peek()?.armed()).toBe(true);
    user32(`[WookReal.U]::keybd_event(${VK_SHIFT}, 0, 0, [System.UIntPtr]::Zero)`);
    try {
      expect(shiftDown()).toBe(true);
      const t0 = Date.now();
      const summary = await orch.core.stops.emergency(OPERATOR);
      expect(Date.now() - t0).toBeLessThan(3000);
      expect([summary.completed, summary.failures]).toEqual([true, []]);
      expect(shiftDown()).toBe(false);
      expect(orch.core.desktop.peek()?.pid ?? null).toBeNull();
      // 정지 뒤 화면 도구는 거부된다
      expect(await call('screen_capture', {})).toMatchObject({ ok: false, code: 'stopped' });
    } finally {
      user32(`[WookReal.U]::keybd_event(${VK_SHIFT}, 0, 2, [System.UIntPtr]::Zero)`);
    }
  }, 120_000);

  it('이 시험이 띄운 메인 턴은 모두 모의 실행이다 — 실제 CLI는 뜨지 않았다', () => {
    const turns = orch.core.ctx.store.turns.list({ ref1: MAIN_AGENT_ID });
    expect(turns.filter((t) => !t.mock)).toEqual([]);
  });
});
