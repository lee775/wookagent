/**
 * desktopHelperCompile (리드 결정 S6-4·S6-13·S6-15): 화면 도우미 C# 소스(resources/desktophelper/DesktopHelper.cs)를 csc로 컴파일만 한다.
 * 이 PC(대표가 쓰는 PC)에서는 그 실행 파일을 띄우지 않는다 — --probe도. csc가 없으면 건너뛴다.
 * 소스 자체도 읽어 약속을 본다: 프로토콜 판이 TS와 같고, DPI 설정이 첫 호출이고, 클립보드·SwitchDesktop·자식 프로세스가 없고, 파일 쓰기는 캡처 하나,
 * 훅 콜백은 주입 표시만 읽는다(키 코드를 읽지 않는다).
 */
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { DESKTOP_HELPER_TOOL, ensureCompiledTool, exeSha256, findCsc, parseToolHashFile, toolPaths } from '../../src/main/process/compiledTool';
import { DESKTOP_PROTOCOL_VERSION } from '../../src/main/desktop/desktopHelper';
import { checkPinned } from '../../src/main/process/pinnedFile';

const source = fileURLToPath(new URL('../../resources/desktophelper/DesktopHelper.cs', import.meta.url));
const text = readFileSync(source, 'utf8');
const hasCsc = process.platform === 'win32' && findCsc().path !== null;
const roots: string[] = [];

afterAll(async () => {
  for (const d of roots) await rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

/** 주석을 뺀 코드 (약속 검사는 코드만 본다) */
const code = text
  .split('\n')
  .map((l) => l.replace(/\/\/.*$/, ''))
  .join('\n');

describe('화면 도우미 소스의 약속', () => {
  it('프로토콜 판이 TS·컴파일 명세와 같다', () => {
    const m = /internal const int ProtocolVersion = (\d+);/.exec(text);
    expect(Number(m?.[1])).toBe(DESKTOP_PROTOCOL_VERSION);
    expect(DESKTOP_HELPER_TOOL.protocolVersion).toBe(DESKTOP_PROTOCOL_VERSION);
    expect(DESKTOP_HELPER_TOOL.references).toEqual(['WPF\\UIAutomationClient.dll', 'WPF\\UIAutomationTypes.dll']);
  });

  it('Main의 첫 호출은 DPI 설정 (실제 픽셀 좌표)', () => {
    const main = /static int Main\(string\[\] args\)\s*\{([\s\S]*?)\n        \}/.exec(code)?.[1] ?? '';
    const first = main.split('\n').map((l) => l.trim()).find(Boolean);
    expect(first).toBe('Native.InitDpi();');
    expect(code).toContain('SetProcessDpiAwarenessContext(new IntPtr(-4))');
  });

  it('클립보드·SwitchDesktop·자식 프로세스를 쓰지 않는다', () => {
    for (const banned of ['Clipboard', 'SwitchDesktop', 'Process.Start', 'CreateProcess', 'ShellExecute', 'WinExec', 'ProcessStartInfo']) {
      expect(code, banned).not.toContain(banned);
    }
  });

  it('파일 쓰기는 화면 폴더의 캡처 한 곳뿐 (.tmp에 쓰고 이름을 바꾼다)', () => {
    expect(code.match(/File\.(WriteAll\w+|Create|AppendAll\w+|Move|Copy|Replace|OpenWrite)\(/g)).toEqual(['File.WriteAllBytes(', 'File.Move(']);
    expect(code).toContain('File.WriteAllBytes(tmp, png);');
    expect(code).toContain('File.Move(tmp, final);');
    expect(code).toContain('string final = Path.Combine(screensDir, id + ".png");');
    expect(code).not.toMatch(/new\s+FileStream|StreamWriter\(\s*(?!Console)/);
  });

  it('훅 콜백은 주입 표시(flags)만 읽는다 — 키 코드(vkCode)를 읽지 않는다', () => {
    expect(code).not.toMatch(/vkCode/i);
    expect(code).toContain('int flags = Marshal.ReadInt32(lParam, 12);');
    expect(code).toContain('int flags = Marshal.ReadInt32(lParam, 8);');
    expect(code.match(/Marshal\.ReadInt32\(lParam/g)).toHaveLength(2);
  });
});

describe.skipIf(!hasCsc)('desktopHelperCompile — 컴파일만 (실행하지 않는다)', () => {
  it('컴파일하고 두 줄 해시를 적는다 — 같은 소스면 해시만으로 재사용, 바뀐 실행 파일은 다시 컴파일', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'wook-test-deskcompile-'));
    roots.push(dataDir);
    const first = await ensureCompiledTool(DESKTOP_HELPER_TOOL, { dataDir, sourcePath: source, probe: false });
    if (!first.ok) throw new Error(first.reason);
    expect(first).toMatchObject({ compiled: true, detail: expect.stringContaining('확인 실행 안 함') });
    const { exePath, hashPath, binDir } = toolPaths(DESKTOP_HELPER_TOOL, dataDir);
    expect(first.exePath).toBe(exePath);
    expect(exeSha256(exePath)).toBe(first.exeSha256);
    expect(parseToolHashFile(readFileSync(hashPath, 'utf8'))).toEqual({ source: first.sourceHash, exe: first.exeSha256 });
    expect(readdirSync(binDir).sort()).toEqual(['WookDesktopHelper.exe', 'WookDesktopHelper.sha256']);
    // PE 실행 파일이다 (MZ) — 띄워 보지는 않는다
    expect(readFileSync(exePath).subarray(0, 2).toString('ascii')).toBe('MZ');
    const again = await ensureCompiledTool(DESKTOP_HELPER_TOOL, { dataDir, sourcePath: source, probe: false });
    expect(again).toMatchObject({ ok: true, compiled: false });
    // 확인(--probe)을 하라고 해도 시험 중에는 띄우지 않는다 — 실행 전에 거부한다
    const probed = await ensureCompiledTool(DESKTOP_HELPER_TOOL, { dataDir, sourcePath: source });
    expect(probed).toMatchObject({ ok: false, reason: expect.stringContaining('시험 중에는 실제 화면 도우미를 띄우지 않습니다') });
  }, 120_000);

  it('같은 실행 파일의 준비 둘이 함께 와도(첫 시작의 사전 점검과 띄우기) 컴파일은 한 번이고, 둘이 돌려준 해시가 모두 놓인 파일과 맞는다 (S6-21 H3)', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'wook-test-deskcompile-race-'));
    roots.push(dataDir);
    const [a, b] = await Promise.all([
      ensureCompiledTool(DESKTOP_HELPER_TOOL, { dataDir, sourcePath: source, probe: false }),
      ensureCompiledTool(DESKTOP_HELPER_TOOL, { dataDir, sourcePath: source, probe: false }),
    ]);
    if (!a.ok) throw new Error(a.reason);
    if (!b.ok) throw new Error(b.reason);
    // 뒤의 준비는 앞이 설치한 파일을 해시로 재사용한다 — 함께 컴파일해 차례로 덮으면 먼저 끝난 쪽의 해시가 덮인 파일의 것이 된다
    expect([a.compiled, b.compiled]).toEqual([true, false]);
    expect([checkPinned(a.pin), checkPinned(b.pin)]).toEqual([{ ok: true }, { ok: true }]);
    expect(b.exeSha256).toBe(a.exeSha256);
  }, 120_000);
});
