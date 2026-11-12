/**
 * serverHelperCompile (리드 결정 S9-5·S9-7·S9-11): 서버 도우미 C# 소스(resources/serverhelper/ServerHelper.cs)를 csc로 컴파일만 한다. csc가 없으면 건너뛴다.
 * 소스 자체도 읽어 약속을 본다: 프로토콜 판이 TS와 같고, 파이프는 원격 클라이언트 거부·지금 사용자만의 DACL·첫 인스턴스·겹친 입출력·인스턴스 16개로
 * 만들고, 절전 방지는 화면 표시 플래그 없이 시스템 절전만 막으며, 자식 프로세스·파일 쓰기·레지스트리를 쓰지 않는다.
 * 시험 실행이 한 번 컴파일한 것(tests/setup/serverHelper.ts)을 데이터 폴더에 복사하면 csc 없이 재사용한다(빌드한 서버 시험이 그것에 기댄다 — verify)
 */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { ensureCompiledTool, exeSha256, findCsc, parseToolHashFile, toolPaths, toolSourceHash } from '../../src/main/process/compiledTool';
import { checkPinned, pinFile } from '../../src/main/process/pinnedFile';
import { createServerHelperLauncher, SERVER_HELPER_PROTOCOL, SERVER_HELPER_TOOL } from '../../src/server/serverHelper';

const source = fileURLToPath(new URL('../../resources/serverhelper/ServerHelper.cs', import.meta.url));
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

describe('서버 도우미 소스의 약속', () => {
  it('프로토콜 판이 TS·컴파일 명세와 같고, 참조는 csc 기본뿐이다', () => {
    const m = /internal const int ProtocolVersion = (\d+);/.exec(text);
    expect(Number(m?.[1])).toBe(SERVER_HELPER_PROTOCOL);
    expect(SERVER_HELPER_TOOL).toMatchObject({ exeName: 'WookServerHelper.exe', hashName: 'WookServerHelper.sha256', protocolVersion: SERVER_HELPER_PROTOCOL, references: [] });
  });

  it('파이프: 원격 클라이언트 거부·지금 사용자만의 DACL(상속 없음)·첫 인스턴스·겹친 입출력·바이트 모드·인스턴스 16개·64KiB', () => {
    expect(code).toContain('private const uint PIPE_REJECT_REMOTE_CLIENTS = 0x00000008;');
    expect(code).toContain('uint mode = PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS;');
    expect(code).toContain('uint open = PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | (first ? FILE_FLAG_FIRST_PIPE_INSTANCE : 0);');
    expect(code).toContain('"D:P(A;;GA;;;" + sid + ")"');
    expect(code).toContain('internal const int MaxConnections = 16;');
    expect(code).toContain('private const int BufferBytes = 65536;');
    expect(code).toContain('Native.CreateNamedPipeW(pipeName, open, mode, MaxConnections, BufferBytes, BufferBytes, 0, ref security)');
    // 그 이름을 이미 누가 쓰면 FAIL INUSE (첫 인스턴스 표시가 ACCESS_DENIED를 준다)
    expect(code).toMatch(/if \(err == ERROR_ACCESS_DENIED \|\| err == ERROR_PIPE_BUSY\) Out\.Line\("FAIL INUSE"\);/);
  });

  it('절전 방지: ES_CONTINUOUS|ES_SYSTEM_REQUIRED로 막고 ES_CONTINUOUS로 풀며, 화면 표시 플래그(ES_DISPLAY_REQUIRED)는 쓰지 않는다 — 끝날 때 푼다', () => {
    expect(code).toContain('Native.SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)');
    expect(code).toContain('Native.SetThreadExecutionState(ES_CONTINUOUS)');
    expect(code).not.toMatch(/DISPLAY_REQUIRED|AWAYMODE|0x00000002|0x00000040/);
    expect(code.match(/SetThreadExecutionState\(/g)).toHaveLength(4);
  });

  it('자식 프로세스·파일 쓰기·레지스트리·네트워크를 쓰지 않고, 받은 바이트를 기록하지 않는다', () => {
    for (const banned of ['Process.Start', 'ProcessStartInfo', 'CreateProcess', 'ShellExecute', 'WinExec', 'Registry', 'File.', 'FileStream', 'Socket', 'WebClient', 'HttpClient', 'Console.Error.Write(Convert']) {
      expect(code, banned).not.toContain(banned);
    }
    // 표준 오류에는 사용법·내부 오류 종류만
    expect(code.match(/Console\.Error\.WriteLine\(/g)).toHaveLength(2);
  });
});

describe.runIf(process.platform === 'win32')('서버 도우미 이음매 — 준비는 한 번, 띄울 때마다 해시를 견준다', () => {
  it('준비가 고정한 실행 파일이 바뀌면 띄우지 않고 그 까닭을 준다 — 준비 전에는 띄우지 않고, 준비 실패는 그 까닭', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wook-test-srvhelper-pin-'));
    roots.push(dir);
    const exe = join(dir, 'WookServerHelper.exe');
    writeFileSync(exe, 'v1');
    let ensures = 0;
    const launcher = createServerHelperLauncher({
      dataDir: dir,
      appRoot: dir,
      env: { SystemRoot: 'C:\\Windows', WOOK_SECRET_SHOULD_NOT_PASS: 'x' },
      ensure: async () => {
        ensures++;
        return { ok: true, exePath: exe, compiled: false, sourcePath: '', sourceHash: '', exeSha256: '', pin: pinFile(exe), cscPath: null, detail: '', durationMs: 0 };
      },
    });
    expect(launcher.spec('pipe', [])).toEqual({ refuse: '서버 도우미가 준비되지 않았습니다' });
    expect(await launcher.prepare()).toEqual({ ok: true });
    expect(await launcher.prepare()).toEqual({ ok: true });
    expect(ensures).toBe(1);
    expect(launcher.spec('power', [])).toEqual({ file: exe, args: ['power'], env: { SystemRoot: 'C:\\Windows' } });
    writeFileSync(exe, 'v2 — 바꿔 넣은 파일');
    const refused = launcher.spec('pipe', ['--name', 'x']);
    expect(refused).toMatchObject({ refuse: expect.stringMatching(/^서버 도우미 파일\(WookServerHelper\.exe\)이 준비할 때와 다릅니다 — 실행 파일의 해시가 준비할 때와 다릅니다/) });
    const failing = createServerHelperLauncher({ dataDir: dir, appRoot: dir, ensure: async () => ({ ok: false, reason: 'csc 없음', durationMs: 0 }) });
    expect(await failing.prepare()).toEqual({ ok: false, reason: 'csc 없음' });
    expect(failing.spec('pipe', [])).toEqual({ refuse: '서버 도우미가 준비되지 않았습니다' });
  });
});

describe.skipIf(!hasCsc)('serverHelperCompile — 컴파일만', () => {
  it('컴파일하고 두 줄 해시를 적는다 — 같은 소스면 해시만으로 재사용', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'wook-test-srvhelper-compile-'));
    roots.push(dataDir);
    const first = await ensureCompiledTool(SERVER_HELPER_TOOL, { dataDir, sourcePath: source, probe: false });
    if (!first.ok) throw new Error(first.reason);
    expect(first).toMatchObject({ compiled: true, detail: expect.stringContaining('확인 실행 안 함') });
    const { exePath, hashPath, binDir } = toolPaths(SERVER_HELPER_TOOL, dataDir);
    expect(exeSha256(exePath)).toBe(first.exeSha256);
    expect(parseToolHashFile(readFileSync(hashPath, 'utf8'))).toEqual({ source: first.sourceHash, exe: first.exeSha256 });
    expect(readdirSync(binDir).sort()).toEqual(['WookServerHelper.exe', 'WookServerHelper.sha256']);
    expect(readFileSync(exePath).subarray(0, 2).toString('ascii')).toBe('MZ');
    const again = await ensureCompiledTool(SERVER_HELPER_TOOL, { dataDir, sourcePath: source, probe: false });
    expect(again).toMatchObject({ ok: true, compiled: false });
  }, 120_000);

  it('시험 실행이 한 번 컴파일한 것이 있다 — 그 짝을 다른 데이터 폴더에 복사하면 csc 없이(찾지 못하는 csc를 줘도) 재사용한다 (verify)', async () => {
    const from = process.env['WOOK_TEST_SERVER_HELPER_BIN'];
    expect(from, 'tests/setup/serverHelper.ts가 이 실행에 컴파일했어야 한다').toBeTruthy();
    const stored = parseToolHashFile(readFileSync(join(from!, 'WookServerHelper.sha256'), 'utf8'));
    expect(stored?.source).toBe(toolSourceHash(SERVER_HELPER_TOOL, readFileSync(source)));
    const dataDir = mkdtempSync(join(tmpdir(), 'wook-test-srvhelper-seed-'));
    roots.push(dataDir);
    mkdirSync(join(dataDir, 'bin'));
    for (const name of ['WookServerHelper.exe', 'WookServerHelper.sha256']) copyFileSync(join(from!, name), join(dataDir, 'bin', name));
    const reused = await ensureCompiledTool(SERVER_HELPER_TOOL, { dataDir, sourcePath: source, probe: false, cscPath: join(dataDir, '없는 csc.exe') });
    if (!reused.ok) throw new Error(reused.reason);
    expect(reused).toMatchObject({ compiled: false, cscPath: null, exeSha256: stored!.exe });
    expect(checkPinned(reused.pin)).toEqual({ ok: true });
  });
});
